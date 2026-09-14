/**
 * عروض الأسعار — `/api/quotes`.
 *
 * - `POST /` **بلا مصادقة**: يسجّله الرابط الخاص `/q-fs7k2m` لحظة إصدار العرض
 *   (المالك وموظّفو المبيعات بلا حسابات). محدودٌ بالمعدّل، والباقة والمبالغ
 *   والصلاحية من كتالوج الخادم، ومتكرّر الإرسال (`clientRef`) لا يُنشئ عرضاً ثانياً.
 * - `GET /admin` و`DELETE /admin/:id`: لوحة المالك وحده.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { IssuedQuote, Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { quoteLimiter } from '../middleware/rateLimits';
import { QuoteInput, displayNo, quoteInput, resolveOffline, toQuoteRecord } from '../services/quotes';

const router = Router();

const isP2002 = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const hitsField = (e: Prisma.PrismaClientKnownRequestError, field: string) => {
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? '').includes(field);
};

/** رقمٌ مؤقّتٌ تصادف في الثانية نفسها من جوالين — يُميَّز بلاحقةٍ من معرّف الإصدار */
const suffixed = (no: string, clientRef: string) => `${no}-${clientRef.slice(0, 4).toUpperCase()}`;

const out = (q: Pick<IssuedQuote, 'id' | 'seq' | 'quoteNo' | 'issuedAt'>) =>
  ({ id: q.id, quoteNo: displayNo(q), issuedAt: q.issuedAt.toISOString() });

const byRef = (clientRef: string) => prisma.issuedQuote.findUnique({ where: { clientRef } });

/**
 * إعادة إرسالٍ لعرضٍ مسجَّل: وصل الطلب الأول وسُجّل بتسلسلٍ، لكنّ الجوال لم يتلقَّ
 * الردّ فطبع رقماً مؤقّتاً وسلّمه للعميل — فالرقم الذي بيد العميل هو المرجع ويُثبَّت.
 * تصادمُ الرقم يُحلّ بلاحقة، وأيّ خطأٍ آخر يُرفَع فيبقى العرض في طابور الجوال.
 */
async function adoptLocalNo(existing: IssuedQuote, input: QuoteInput): Promise<IssuedQuote> {
  if (existing.quoteNo) return existing;
  const off = resolveOffline(input.localNo, input.issuedAt, new Date());
  if (!off) return existing;
  const data = { quoteNo: off.quoteNo, issuedAt: off.issuedAt, offline: true };
  try {
    return await prisma.issuedQuote.update({ where: { id: existing.id }, data });
  } catch (e) {
    if (!isP2002(e) || !hitsField(e, 'quoteNo')) throw e;
    return prisma.issuedQuote.update({
      where: { id: existing.id }, data: { ...data, quoteNo: suffixed(off.quoteNo, input.clientRef) },
    });
  }
}

router.post('/', quoteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = quoteInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, message: parsed.error.issues[0]?.message || 'بيانات العرض غير صالحة' });
    return;
  }
  const input = parsed.data;
  if (input.dryRun) { res.json({ success: true, data: { dryRun: true } }); return; }

  try {
    const existing = await byRef(input.clientRef);
    if (existing) { res.json({ success: true, data: out(await adoptLocalNo(existing, input)) }); return; }

    const record = toQuoteRecord(input, new Date());
    try {
      const created = await prisma.issuedQuote.create({ data: record });
      res.status(201).json({ success: true, data: out(created) });
      return;
    } catch (e) {
      if (!isP2002(e)) throw e;
      /* أيّ تصادمٍ فريد: **المعرّف أولاً** — طلبان متزامنان للإصدار نفسه (تبويبان يرفعان
       * الطابور، أو مهلةٌ انقطعت والطلب الأول ما زال يُكتب). ترتيب فحص Postgres للفهارس
       * قد يُبلغ عن تصادم الرقم قبل المعرّف، فلا يُعتمَد على الحقل المُبلَغ عنه. */
      const won = await byRef(input.clientRef);
      if (won) { res.json({ success: true, data: out(await adoptLocalNo(won, input)) }); return; }
      if (!record.quoteNo || !hitsField(e, 'quoteNo')) throw e;
    }

    try {
      const created = await prisma.issuedQuote.create({
        data: { ...record, quoteNo: suffixed(record.quoteNo, input.clientRef) },
      });
      res.status(201).json({ success: true, data: out(created) });
    } catch (e) {
      const won = isP2002(e) ? await byRef(input.clientRef) : null;
      if (!won) throw e;
      res.json({ success: true, data: out(won) });
    }
  } catch (err) { next(err); }
});

// ───────────────────────────── لوحة المالك ─────────────────────────────

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
const PAGE = 50;

router.get('/admin', authenticate, requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ success: false, message: 'استعلام غير صالح' }); return; }
  const { q, page } = parsed.data;
  try {
    const seqMatch = q?.match(/^(?:FS-QT-\d{4}-)?0*(\d{1,9})$/i);
    const where: Prisma.IssuedQuoteWhereInput = q
      ? {
          OR: [
            { company: { contains: q, mode: 'insensitive' } },
            { unifiedNo: { contains: q } },
            { presenter: { contains: q, mode: 'insensitive' } },
            { quoteNo: { contains: q, mode: 'insensitive' } },
            // «FS-QT-2026-0007» أو «7» يطابقان التسلسل
            ...(seqMatch ? [{ seq: Number(seqMatch[1]) }] : []),
          ],
        }
      : {};

    const since30 = new Date(Date.now() - 30 * 86_400_000);
    const [rows, total, sums, last30] = await Promise.all([
      prisma.issuedQuote.findMany({ where, orderBy: { issuedAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE }),
      prisma.issuedQuote.count({ where }),
      prisma.issuedQuote.aggregate({ where, _sum: { totalHalalas: true } }),
      prisma.issuedQuote.count({ where: { ...where, issuedAt: { gte: since30 } } }),
    ]);

    res.json({
      success: true,
      data: {
        items: rows.map(r => ({
          id: r.id,
          quoteNo: displayNo(r),
          issuedAt: r.issuedAt.toISOString(),
          offline: r.offline,
          company: r.company,
          unifiedNo: r.unifiedNo,
          packageId: r.packageId,
          packageName: r.packageName,
          packageLimit: r.packageLimit,
          monthlyHalalas: r.monthlyHalalas,
          yearlyHalalas: r.yearlyHalalas,
          cycle: r.cycle,
          totalHalalas: r.totalHalalas,
          netHalalas: r.netHalalas,
          vatHalalas: r.vatHalalas,
          presenter: r.presenter,
          note: r.note,
          validDays: r.validDays,
        })),
        total,
        page,
        pageSize: PAGE,
        totalHalalas: sums._sum.totalHalalas ?? 0,
        last30Days: last30,
      },
    });
  } catch (err) { next(err); }
});

router.delete('/admin/:id', authenticate, requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { count } = await prisma.issuedQuote.deleteMany({ where: { id: String(req.params.id) } });
    if (!count) { res.status(404).json({ success: false, message: 'العرض غير موجود' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
