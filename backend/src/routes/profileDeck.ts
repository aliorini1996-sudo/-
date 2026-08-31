import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';

/**
 * شرائح البروفايل — يرفعها مالك المنصّة فتتغيّر صفحة /profile بلا نشر.
 *
 * القراءة عامّة (الصفحة للزوّار) والكتابة لمالك المنصّة وحده. والتخزين في
 * قاعدة البيانات لأن الخدمة بلا قرص دائم — انظر تعليق `ProfileSlide` في
 * المخطّط. وحين يخلو الجدول تعود الصفحة للشرائح المدمَجة في البناء.
 *
 * والتحويل من PDF إلى صور يجري في **متصفّح المالك** لا هنا: الخادم على لينكس
 * بلا بوربوينت ولا poppler، وإضافة تبعية أصلية لأجل رفعةٍ في الشهر ثمنٌ لا
 * يستحقّه. فالمتصفّح يصيّر صفحات الملف ويرسلها صوراً جاهزة.
 */

const router = Router();

/** حدّ الشريحة الواحدة: ٣ ميغابايت خاماً — WebP بدقّة 2400 لا يقاربها */
const MAX_SLIDE_BYTES = 3 * 1024 * 1024;
/** حدّ الملفّ القابل للتنزيل */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_SLIDES = 40;

const b64 = z.string().min(16).max(Math.ceil(MAX_FILE_BYTES * 1.4));

const slideSchema = z.object({
  seq: z.number().int().min(1).max(MAX_SLIDES),
  dataBase64: b64,
  mime: z.enum(['image/webp', 'image/png', 'image/jpeg']).default('image/webp'),
  width: z.number().int().min(64).max(8000),
  height: z.number().int().min(64).max(8000),
  title: z.string().max(300).default(''),
  lines: z.array(z.string().max(1000)).max(60).default([]),
});

const deckSchema = z.object({
  slides: z.array(slideSchema).min(1).max(MAX_SLIDES),
});

const decode = (s: string): Buffer => Buffer.from(s.replace(/^data:[^,]+,/, ''), 'base64');

/**
 * بيان العرض — بلا بايتات، فهو يُطلب مع كل زيارة للصفحة.
 *
 * و`v` بصمة النسخة (لحظة التحديث) تُوضَع في رابط الصورة، فيتجدّد تخزين
 * المتصفّح عند الرفع الجديد وحده ويبقى محفوظاً فيما بينهما.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [slides, file] = await Promise.all([
      prisma.profileSlide.findMany({
        orderBy: { seq: 'asc' },
        select: { seq: true, width: true, height: true, title: true, lines: true, updatedAt: true },
      }),
      prisma.profileFile.findUnique({ where: { id: 'main' }, select: { name: true, updatedAt: true } }),
    ]);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      success: true,
      data: {
        slides: slides.map(s => ({
          seq: s.seq,
          width: s.width,
          height: s.height,
          title: s.title,
          lines: s.lines ? s.lines.split('\n').filter(Boolean) : [],
          v: s.updatedAt.getTime(),
        })),
        file: file ? { name: file.name, v: file.updatedAt.getTime() } : null,
      },
    });
  } catch (err) { next(err); }
});

/** صورة شريحة — تخزين طويل الأجل، فالرابط يحمل بصمة النسخة */
router.get('/slide/:seq', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seq = Number(req.params.seq);
    if (!Number.isInteger(seq) || seq < 1) { res.status(400).end(); return; }
    const row = await prisma.profileSlide.findUnique({ where: { seq } });
    if (!row) { res.status(404).end(); return; }
    const etag = `"s${seq}-${row.updatedAt.getTime()}"`;
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.set({
      'Content-Type': row.mime,
      'Content-Length': String(row.bytes.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
    });
    res.end(row.bytes);
  } catch (err) { next(err); }
});

/** الملفّ القابل للتنزيل */
router.get('/file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await prisma.profileFile.findUnique({ where: { id: 'main' } });
    if (!row) { res.status(404).end(); return; }
    const etag = `"f-${row.updatedAt.getTime()}"`;
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    // الاسم العربي يُرسَل مرمَّزاً أيضاً (RFC 5987) وإلا سقط أو تحوّلت محارفه
    const dispo = `attachment; filename="profile.pdf"; filename*=UTF-8''` + encodeURIComponent(row.name);
    res.set({
      'Content-Type': row.mime,
      'Content-Length': String(row.bytes.length),
      'Content-Disposition': dispo,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
    });
    res.end(row.bytes);
  } catch (err) { next(err); }
});

/**
 * استبدال العرض كاملاً — لا تعديل شريحة على حدة.
 *
 * العرض وحدةٌ واحدة وترقيمه متّصل. فلو حُدّثت شرائحه واحدةً واحدة لبقيت
 * الصفحة بين الرفعتين تعرض خلطاً من عرضين — نصفها من القديم ونصفها من
 * الجديد — وهو أسوأ من انتظار ثانية.
 */
router.put('/', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = deckSchema.parse(req.body);

    const rows = body.slides.map(s => {
      const bytes = decode(s.dataBase64);
      if (bytes.length === 0) throw new Error(`الشريحة ${s.seq}: بيانات الصورة فارغة`);
      if (bytes.length > MAX_SLIDE_BYTES) throw new Error(`الشريحة ${s.seq}: حجم الصورة يتجاوز الحد`);
      return {
        seq: s.seq, mime: s.mime, bytes, width: s.width, height: s.height,
        title: s.title.trim(),
        lines: s.lines.map(l => l.trim()).filter(Boolean).join('\n'),
      };
    });

    // الترقيم متّصل من ١ — وإلا ظهرت شريحة بلا سابقتها في الصفحة
    const seqs = rows.map(r => r.seq).sort((a, b) => a - b);
    if (!seqs.every((n, i) => n === i + 1)) {
      res.status(400).json({ success: false, message: 'ترقيم الشرائح يجب أن يكون متصلا من ١' });
      return;
    }

    await prisma.$transaction(async tx => {
      await tx.profileSlide.deleteMany({});
      await tx.profileSlide.createMany({ data: rows });
    });

    res.json({ success: true, data: { slides: rows.length } });
  } catch (err) {
    // رسائل الحدود أعلاه صالحة للعرض على المالك؛ وأخطاء زود يتولّاها المعالج العام
    if (err instanceof Error && !(err as { issues?: unknown }).issues) {
      res.status(400).json({ success: false, message: err.message });
      return;
    }
    next(err);
  }
});

/** رفع الملفّ القابل للتنزيل */
router.put('/file', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      dataBase64: b64,
      name: z.string().min(1).max(200).default('بروفايل Field Sales.pdf'),
    }).parse(req.body);

    const bytes = decode(body.dataBase64);
    if (bytes.length === 0) { res.status(400).json({ success: false, message: 'الملف فارغ' }); return; }
    if (bytes.length > MAX_FILE_BYTES) { res.status(400).json({ success: false, message: 'حجم الملف يتجاوز الحد' }); return; }
    // توقيع PDF: لا يُخزَّن ملفٌ يزعم أنه PDF وليس كذلك فيتعذّر فتحه على الزائر
    if (bytes.subarray(0, 4).toString('latin1') !== '%PDF') {
      res.status(400).json({ success: false, message: 'الملف ليس PDF صالحا' });
      return;
    }

    await prisma.profileFile.upsert({
      where: { id: 'main' },
      create: { id: 'main', bytes, name: body.name, mime: 'application/pdf' },
      update: { bytes, name: body.name, mime: 'application/pdf' },
    });
    res.json({ success: true, data: { size: bytes.length } });
  } catch (err) { next(err); }
});

/** إزالة ما رُفع — تعود الصفحة للشرائح المدمَجة في البناء */
router.delete('/', authenticate, requireSuperAdmin, async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await prisma.$transaction([
      prisma.profileSlide.deleteMany({}),
      prisma.profileFile.deleteMany({}),
    ]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
