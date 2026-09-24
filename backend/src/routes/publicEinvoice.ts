// ============================================================================
// ZATCA المرحلة الثانية (Z5.7) — رابط المشتري: صفحةٌ علنية لمستندٍ واحد، والـXML المعتمد معها.
// ----------------------------------------------------------------------------
// موجّهٌ **مستقلّ** (ملفٌّ جديد كلّه) يُركَّب على `/api/public` — سطرا mount في index.ts وحدهما يُلمسان.
//
// من يفتحه: مشترٍ خارج المنصّة، بلا حساب، من رابطٍ يرسله المندوب. فقواعده تُكتب كما تُكتب لواجهةٍ معادية:
//   • **الرمز هو الإذن كلّه** ولا شيء غيره: 160 بت من HMAC خادميّ (compliance/zatca/publicView.ts). لا معرّف
//     شركة في المسار ولا تعداد ولا بحثٌ باسمٍ أو رقمٍ — رمزٌ واحد يفتح مستنداً واحداً بعينه.
//   • **النهائيّ وحده**: مستندٌ لم تحسمه الهيئة (معلَّق/محجوب) أو أُبطل (مرفوض/مسحوب) ⇒ 404 كأنّه غير موجود.
//     الفرق ليس تجميلاً: مستندٌ معلَّق قد يُرفض بعد ساعة، ومشترٍ خصم به مدخلاته يحمل مخالفةً لا يعلمها.
//   • **404 واحدة لكلّ سبب**: رمزٌ مشوّه، رمزٌ لا يطابق، مستندٌ غير موجود، حالةٌ غير نهائية، شركةٌ غير مفعَّلة —
//     كلّها الردّ نفسه بالنصّ نفسه. ردٌّ يفرّق بينها يبني للمهاجم كاشفَ وجود.
//   • **لا بيانات شركة خارج هذا المستند**: اسم البائع ورقمه الضريبي، اسم المشتري، المبالغ، الحالة، الرمز المختوم.
//     لا معرّفات ولا رسائل الهيئة ولا بنود ولا أيّ صفٍّ آخر لنفس الشركة أو لغيرها.
//   • **محدّد معدّل خاصّ** فوق العامّ، معرَّف هنا لا في middleware/rateLimits.ts (ملفٌّ مشترك — لا هنّة فيه).
//
// وشركةٌ لم تُفعَّل للمرحلة الثانية لا تملك صفّاً في `zatca_documents` أصلاً، فلا استعلام يمسّ مساراتها من هنا.
// ============================================================================

import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../config/database';
import { gunzipXml } from '../compliance/zatca/documentStore';
import { contentDispositionOf, xmlFileNameOf } from '../compliance/zatca/docsPanel';
import {
  isShareableDocument, publicProjection, publicXmlVariant, readShareToken, shareSecretFrom,
} from '../compliance/zatca/publicView';
import { subtypeOfTypeName } from '../compliance/zatca/status';

const router = Router();

/** نصٌّ واحد لكلّ رفض — لا يفرّق بين «لا يوجد» و«ليس نهائياً» و«رمز خاطئ». */
const NOT_FOUND = 'الرابط غير صحيح أو لم يعد متاحاً';

/**
 * حدّ خاصّ للرابط العلنيّ فوق الحدّ العامّ (600/15د لكلّ `/api`): ستّون فتحةً في الربع ساعة تكفي مشترياً يفتح
 * فاتورته ويحدّث الصفحة ويحمّل الـXML، ولا تكفي كشّافاً يجرّب رموزاً — والتخمين أصلاً خارج حدود العمر بـ160 بت.
 */
const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'طلبات كثيرة حاول بعد قليل' },
});

/** السرّ يُقرأ عند كلّ طلب لا عند التحميل: اختبارٌ يضبط البيئة بعد الاستيراد يبقى صادقاً، والكلفة معدومة. */
const secret = (): string | null => shareSecretFrom(process.env.JWT_SECRET);

const deny = (res: Response): void => { res.status(404).json({ success: false, message: NOT_FOUND }); };

/** ترويسات كلّ ردّ هنا: لا تخزين وسيط (مستندٌ خاصّ) ولا فهرسة (رابطٌ يُشارك يداً بيد). */
const publicHeaders = (res: Response): void => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
};

const DOC_SELECT = {
  id: true, tenantId: true, uuid: true, status: true, typeName: true, flow: true, issueDate: true, issueTime: true,
  qr: true, clearedQr: true,
  invoice: {
    select: {
      number: true, documentKind: true, currency: true, subtotal: true, discountAmt: true, taxAmt: true, total: true,
      einvoiceStatus: true, zatcaPhase: true,
      customer: { select: { name: true } },
    },
  },
} as const;

type LoadedDoc = {
  id: string; tenantId: string; uuid: string; status: string; typeName: string; flow: string;
  issueDate: string; issueTime: string; qr: string; clearedQr: string | null;
  invoice: {
    number: string; documentKind: string | null; currency: string | null; subtotal: number; discountAmt: number;
    taxAmt: number; total: number; einvoiceStatus: string | null; zatcaPhase: number | null;
    customer: { name: string } | null;
  } | null;
};

/**
 * المستند من الرمز، أو null لأيّ سببٍ كان. استعلامان بحدّ أقصى ولا بايتات: صفّ المستند بفاتورته، ثمّ إعدادات
 * الشركة (اسم البائع ورقمه الضريبي، وعلم التفعيل). لا شيء يُقرأ قبل أن يمرّ الرمز ولا بعد أن تسقط البوابة.
 */
async function loadShared(token: unknown): Promise<{ doc: LoadedDoc; seller: { name: string | null; legalName: string | null; taxNumber: string | null } } | null> {
  const id = readShareToken(token, secret());
  if (id === null) return null;

  const doc = await prisma.zatcaDocument.findUnique({ where: { id }, select: DOC_SELECT }) as unknown as LoadedDoc | null;
  if (!doc || !doc.invoice) return null;

  const gate = isShareableDocument({
    status: doc.status,
    mirror: doc.invoice.einvoiceStatus,
    subtype: subtypeOfTypeName(doc.typeName),
    phase: doc.invoice.zatcaPhase,
  });
  if (!gate) return null;

  const settings = await prisma.companySettings.findUnique({
    where: { tenantId: doc.tenantId },
    select: { name: true, legalName: true, taxNumber: true, zatcaPhase2StartedAt: true },
  });
  // التفعيل قائمٌ الآن لا وقت الإصدار: شركةٌ أُطفئت مرحلتها الثانية لا يبقى لها رابطٌ علنيّ مفتوح
  if (!settings?.zatcaPhase2StartedAt) return null;

  return { doc, seller: { name: settings.name, legalName: settings.legalName, taxNumber: settings.taxNumber } };
}

// ─── 1) عرض المستند ───

/** `GET /api/public/einvoice/:token` — إسقاطٌ صغير بقائمة بيضاء (compliance/zatca/publicView.ts). */
router.get('/einvoice/:token', shareLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    publicHeaders(res);
    const found = await loadShared(req.params.token);
    if (!found) { deny(res); return; }
    const { doc, seller } = found;
    const inv = doc.invoice!;

    const view = publicProjection({
      doc: {
        uuid: doc.uuid, status: doc.status, typeName: doc.typeName, flow: doc.flow,
        qr: doc.qr, clearedQr: doc.clearedQr,
        // `xmlGz` عمودٌ إلزاميّ في المخطّط (بايتات الإرسال)، و`clearedXmlGz` تُكتب للمعتمدة وحدها —
        // فالتوفّر يُعرف من الحالة بلا قراءة بايتةٍ واحدة
        hasXml: true,
        hasClearedXml: publicXmlVariant(doc.status) === 'cleared',
      },
      invoice: {
        number: inv.number, documentKind: inv.documentKind, currency: inv.currency,
        subtotal: inv.subtotal, discountAmt: inv.discountAmt, taxAmt: inv.taxAmt, total: inv.total,
      },
      seller,
      buyer: { name: inv.customer?.name ?? null },
      issueDate: doc.issueDate,
      issueTime: doc.issueTime,
    });
    if (!view) { deny(res); return; }

    res.json({ success: true, data: view });
  } catch (e) { next(e); }
});

// ─── 2) تنزيل المستند القانونيّ ───

/**
 * `GET /api/public/einvoice/:token/xml` — نسخةٌ واحدة لا خيار فيها: المعتمدة للقياسية المعتمدة، والموقَّعة لما
 * عداها. لا وسيط `variant` هنا عمداً — المشتري يأخذ المستند القانونيّ لا نسخةً يختارها.
 */
router.get('/einvoice/:token/xml', shareLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    publicHeaders(res);
    const found = await loadShared(req.params.token);
    if (!found) { deny(res); return; }
    const { doc } = found;

    const variant = publicXmlVariant(doc.status);
    const row = await prisma.zatcaDocument.findUnique({
      where: { id: doc.id },
      select: variant === 'cleared' ? { clearedXmlGz: true } : { xmlGz: true },
    }) as { clearedXmlGz?: Uint8Array | null; xmlGz?: Uint8Array | null } | null;
    const gz = (variant === 'cleared' ? row?.clearedXmlGz : row?.xmlGz) ?? null;
    if (!gz || gz.length === 0) { deny(res); return; }

    let xml: string;
    try {
      xml = gunzipXml(gz);
    } catch {
      res.status(500).json({ success: false, message: 'تعذّر فكّ ضغط المستند المخزّن' });
      return;
    }
    const fileName = xmlFileNameOf({ number: doc.invoice?.number ?? null, attemptNo: null, variant });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', contentDispositionOf(fileName));
    res.send(xml);
  } catch (e) { next(e); }
});

export default router;
