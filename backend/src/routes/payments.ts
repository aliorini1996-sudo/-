import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import prisma from '../config/database';
import { Prisma } from '@prisma/client';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { moyasarConfigured, createInvoice, fetchInvoice, fetchPayment, cancelInvoice, sarToHalalas } from '../services/moyasar';
import { issueForPayment } from '../services/platformInvoice';

// روابط الدفع الالكتروني (ميسر) — يصدرها مالك المنصة بمبلغ يحدده بنفسه.
//
// قواعد المال الحاكمة هنا:
// ١. حالة «مدفوع» لا تاتي الا من جلب الفاتورة من ميسر بالمفتاح السري —
//    لا من جسم webhook ولا من الواجهة ولا من العميل.
// ٢. المطابقة قبل الاعتماد: مبلغ فاتورة ميسر وعملتها يجب ان يطابقا المخزن عندنا.
// ٣. الوسم «مدفوع» والتمديد يقعان في معاملة واحدة — اما كلاهما او لا شيء،
//    ففشل التمديد يعيد الرابط غير مدفوع وتتكفل اعادة المحاولة (webhook/تحديث) به.
// ٤. التمديد نفسه CAS بحلقة اعادة: تسويتان متزامنتان لرابطين لنفس الشركة
//    تتسلسلان فيجمع العميل الشهور كلها لا اخرها.
const router = Router();

// مسار webhook مستقل — يركب في index.ts قبل محدد المعدل العام (كما webhook واتساب):
// ميسر لا يعيد الارسال الا على غير 2xx فلا نضيع اشعاره على 429.
const paymentsWebhookRouter = Router();

const FRONT = (process.env.PUBLIC_SITE_URL || 'https://fieldsa.net').replace(/\/$/, '');

const createSchema = z.object({
  // بدقة الهللة حصرا: 1.005 كانت تتقرب هبوطا او صعودا حسب صدفة التمثيل الثنائي
  amountSar: z.number().min(1).max(1_000_000)
    .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'المبلغ بدقة الهللة خانتان عشريتان'),
  description: z.string().min(3).max(255),
  tenantId: z.string().uuid().nullish(),
  months: z.number().int().min(0).max(36).optional().default(0),
});

/** اضافة اشهر بقص على اخر يوم صالح في الشهر الهدف — ٣١ يناير + شهر = ٢٨/٢٩ فبراير لا ٢ مارس */
export function addMonthsClamped(d: Date, months: number): Date {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + months);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, lastDay));
  return r;
}

/**
 * تمديد اشتراك الشركة داخل معاملة — CAS بحلقة اعادة:
 * نقرا تاريخ الانتهاء ونكتب الجديد بشرط ان القديم لم يتغير؛ ان سبقنا تمديد
 * متزامن اخر (رابط ثان لنفس الشركة) نعيد القراءة فنبني فوقه بدل ان نمحوه.
 */
async function applyExtensionTx(tx: Prisma.TransactionClient, tenantId: string, months: number): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { subscriptionEndsAt: true } });
    if (!t) return; // الشركة حذفت — الدفعة تسجل والتمديد بلا هدف
    const prev = t.subscriptionEndsAt;
    const base = prev && prev.getTime() > Date.now() ? new Date(prev) : new Date();
    const next = addMonthsClamped(base, months);
    const r = await tx.tenant.updateMany({
      where: { id: tenantId, subscriptionEndsAt: prev },
      data: { subscriptionEndsAt: next, isActive: true },
    });
    if (r.count === 1) return;
  }
  throw new Error('تعذر تمديد الاشتراك بعد محاولات متزامنة');
}

type SettleResult = { status: string; paid: boolean };

/**
 * الاعتماد المركزي لنتيجة الدفع: يجلب الفاتورة من ميسر ويطابق المبلغ والعملة
 * ثم يقلب الحالة ويمدد الاشتراك في معاملة واحدة. الانتقال الى paid ذري
 * (updateMany بشرط «ليست مدفوعة») فلا تمديد مزدوج مهما تكررت الاشعارات.
 */
async function settleFromMoyasar(linkId: string): Promise<SettleResult> {
  const link = await prisma.paymentLink.findUnique({ where: { id: linkId } });
  if (!link || !link.moyasarInvoiceId) throw new Error('رابط غير معروف');
  if (link.status === 'paid') return { status: 'paid', paid: true };
  // الحالات النهائية لدى ميسر لا تعود للحياة — لا داعي لجلب متكرر
  if (link.status !== 'initiated') return { status: link.status, paid: false };

  const inv = await fetchInvoice(link.moyasarInvoiceId);

  if (inv.status !== 'paid') {
    if (inv.status !== link.status) {
      await prisma.paymentLink.update({ where: { id: link.id }, data: { status: inv.status } });
    }
    return { status: inv.status, paid: false };
  }

  // مدفوعة لدى ميسر — طابق العملة والمبلغ قبل اي اثر ماليّ
  if ((inv.currency || 'SAR').toUpperCase() !== 'SAR') {
    console.error(`payment ${link.id}: currency mismatch (moyasar=${inv.currency})`);
    return { status: 'amount_mismatch', paid: false };
  }
  if (inv.amount !== link.amountHalalas) {
    console.error(`payment ${link.id}: amount mismatch (moyasar=${inv.amount}, ours=${link.amountHalalas})`);
    return { status: 'amount_mismatch', paid: false };
  }

  // الوسم والتمديد معا — فشل التمديد يفك الوسم فتتكفل اعادة المحاولة بالاثنين
  await prisma.$transaction(async tx => {
    const won = await tx.paymentLink.updateMany({
      where: { id: link.id, status: { not: 'paid' } },
      data: { status: 'paid', paidAt: new Date() },
    });
    if (won.count === 1 && link.tenantId && link.months > 0) {
      await applyExtensionTx(tx, link.tenantId, link.months);
    }
  });

  // الفاتورة الضريبية للمشترك — **بعد** المعاملة وخارجها عمدا: فشل الاصدار
  // (رقم ضريبي غير مضبوط، عطل عابر) يجب الا يُرجع الرابط «غير مدفوع» فيُعاد
  // تحصيله. ما يفوت هنا تلتقطه `backfillInvoices`.
  const taxInv = await issueForPayment(link.id).catch((e) => ({ ok: false, reason: (e as Error).message }));
  if (!taxInv.ok) console.error(`platform invoice for ${link.id} skipped: ${taxInv.reason}`);

  return { status: 'paid', paid: true };
}

/** حالات ميسر التي تعني «المال لم يعد عندنا» */
const REVERSED = new Set(['refunded', 'voided', 'failed']);

/**
 * عكس دفعة استُردّت أو أُلغيت — بتحقق من ميسر لا بثقة في جسم الاشعار.
 *
 * قبل هذا كان `settleFromMoyasar` يعود فورا ان كانت الحالة `paid`، فالدفعة
 * المستردة تبقى ايرادا في التقارير الى الابد. الردّ هنا يغير الحالة فقط:
 * **لا يقلّص اشتراك العميل تلقائيا** — قطع خدمة عن شركة تعمل قرار المالك لا
 * قرار webhook، وينبهه اليه سجلّ صريح.
 */
async function reversePayment(linkId: string, paymentId: string): Promise<{ reversed: boolean; status: string }> {
  const link = await prisma.paymentLink.findUnique({ where: { id: linkId }, select: { id: true, status: true, amountHalalas: true } });
  if (!link) throw new Error('رابط غير معروف');
  if (link.status !== 'paid') return { reversed: false, status: link.status };

  const pay = await fetchPayment(paymentId);
  if (!REVERSED.has(pay.status)) {
    // ميسر لا تزال تقول «مدفوعة» — لا نعكس بناء على ادعاء الجسم وحده
    console.error(`payment ${linkId}: reversal claimed but Moyasar says ${pay.status} — ignored`);
    return { reversed: false, status: link.status };
  }

  // ردّ جزئي يبقي جزءا من المال عندنا؛ عكسه كليا كان سيمحو ايرادا محصّلا فعلا
  const refunded = pay.refunded ?? pay.amount;
  if (pay.status === 'refunded' && refunded < link.amountHalalas) {
    console.error(`payment ${linkId}: PARTIAL refund ${refunded}/${link.amountHalalas} — owner action required`);
    return { reversed: false, status: link.status };
  }

  await prisma.paymentLink.updateMany({
    where: { id: link.id, status: 'paid' },
    data: { status: pay.status },
  });
  console.error(`payment ${linkId}: reversed to ${pay.status} — subscription NOT shortened, owner decides`);
  return { reversed: true, status: pay.status };
}

// انشاء رابط دفع — المالك فقط
router.post('/', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!moyasarConfigured()) {
      res.status(503).json({ success: false, message: 'بوابة الدفع غير مهيأة بعد اضف مفتاح ميسر في بيئة الخادم' });
      return;
    }
    const body = createSchema.parse(req.body);
    if (body.tenantId) {
      const t = await prisma.tenant.findUnique({ where: { id: body.tenantId }, select: { id: true } });
      if (!t) { res.status(404).json({ success: false, message: 'الشركة غير موجودة' }); return; }
    }
    if (body.months > 0 && !body.tenantId) {
      res.status(400).json({ success: false, message: 'التمديد التلقائي يتطلب ربط الرابط بشركة' });
      return;
    }

    // نسجل الصف اولا لنحصل على معرفنا ثم ننشئ فاتورة ميسر مربوطة به
    const row = await prisma.paymentLink.create({
      data: {
        tenantId: body.tenantId ?? null,
        description: body.description,
        amountHalalas: sarToHalalas(body.amountSar),
        months: body.months,
      },
    });

    let inv;
    try {
      inv = await createInvoice({
        amountHalalas: row.amountHalalas,
        description: body.description,
        successUrl: `${FRONT}/payment/success?ref=${row.id}`,
        backUrl: `${FRONT}/payment/success?ref=${row.id}`,
        metadata: { ref: row.id, ...(body.tenantId ? { tenantId: body.tenantId } : {}) },
      });
    } catch (e) {
      // فشل قبل تاكد الانشاء لدى ميسر — نحذف صفنا؛ وان كانت الفاتورة انشئت
      // رغم فشل الشبكة فسيكشفها webhook بمرجع مجهول ويسجلها بصوت عال (ادناه)
      await prisma.paymentLink.delete({ where: { id: row.id } }).catch(() => { /* تنظيف best-effort */ });
      throw e;
    }

    try {
      const updated = await prisma.paymentLink.update({
        where: { id: row.id },
        data: { moyasarInvoiceId: inv.id, url: inv.url, status: inv.status || 'initiated' },
      });
      res.json({ success: true, data: updated });
    } catch (e) {
      // فاتورة حية لدى ميسر وصف لم يكتمل ربطه — لا نحذف الصف (للمطابقة)
      // ونحاول الغاء الفاتورة كي لا تدفع يتيمة
      console.error(`CRITICAL payment ${row.id}: moyasar invoice ${inv.id} created but not persisted`);
      cancelInvoice(inv.id).catch(() => { /* الغاء best-effort */ });
      throw e;
    }
  } catch (err) { next(err); }
});

// سرد الروابط مع اسماء الشركات — المالك فقط
router.get('/', authenticate, requireSuperAdmin, async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const rows = await prisma.paymentLink.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    const tids = [...new Set(rows.map(r => r.tenantId).filter((v): v is string => !!v))];
    const tenants = tids.length
      ? await prisma.tenant.findMany({ where: { id: { in: tids } }, select: { id: true, name: true } })
      : [];
    const nameBy = new Map(tenants.map(t => [t.id, t.name]));
    res.json({ success: true, data: rows.map(r => ({ ...r, tenantName: r.tenantId ? (nameBy.get(r.tenantId) || '—') : null })) });
  } catch (err) { next(err); }
});

// تحديث حالة رابط يدويا — المالك فقط (يغني عن webhook عند الحاجة)
router.post('/:id/refresh', authenticate, requireSuperAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!moyasarConfigured()) { res.status(503).json({ success: false, message: 'بوابة الدفع غير مهيأة' }); return; }
    const out = await settleFromMoyasar(req.params.id);
    res.json({ success: true, data: out });
  } catch (err) { next(err); }
});

/** مقارنة توكن ثابتة الزمن — مسار مال فلا نمنح قناة زمنية ولو نظرية */
function tokenMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Webhook من ميسر — يتحقق بالرمز المشترك ثم يعتمد عبر الجلب من ميسر (لا ثقة بالجسم).
// نتائج الاعمال (مرجع مجهول/عدم تطابق) ترد 200 كي لا يكرر ميسر بلا جدوى؛
// الاعطال التقنية العابرة ترد 500 عمدا ليعيد ميسر الارسال فلا يضيع اشعار دفع حقيقي.
paymentsWebhookRouter.post('/', async (req: Request, res: Response) => {
  const expected = process.env.MOYASAR_WEBHOOK_TOKEN;
  const got = (req.body?.secret_token as string) || '';
  if (!expected || !tokenMatches(got, expected)) { res.status(401).json({ success: false }); return; }

  const type = (req.body?.type as string) || '';
  const data = req.body?.data ?? {};

  // الردّ/الالغاء يصل بكائن **دفعة** لا فاتورة، وقد لا يحمل الـmetadata التي
  // وضعناها على الفاتورة — فنستدلّ على رابطنا بمعرّف الفاتورة الفريد عندنا.
  if (type === 'payment_refunded' || type === 'payment_voided' || type === 'payment_failed') {
    const invId = (data.invoice_id as string) || '';
    const payId = (data.id as string) || '';
    const byRef = (data.metadata?.ref as string) || '';
    const target = byRef
      ? await prisma.paymentLink.findUnique({ where: { id: byRef }, select: { id: true } }).catch(() => null)
      : invId
        ? await prisma.paymentLink.findUnique({ where: { moyasarInvoiceId: invId }, select: { id: true } }).catch(() => null)
        : null;
    if (!target || !payId) { res.json({ success: true }); return; }
    try {
      await reversePayment(target.id, payId);
      res.json({ success: true });
    } catch (e) {
      console.error('payments webhook reverse error:', (e as Error).message);
      res.status(500).json({ success: false });
    }
    return;
  }

  const ref = (data.metadata?.ref as string) || '';
  if (!ref) { res.json({ success: true }); return; }

  const link = await prisma.paymentLink.findUnique({ where: { id: ref }, select: { id: true } }).catch(() => null);
  if (!link) {
    // مرجع مجهول: قد تكون فاتورة يتيمة من فشل انشاء قديم — صوت عال للمطابقة اليدوية
    console.error(`payments webhook: UNKNOWN ref ${ref} — check Moyasar dashboard for orphan invoice`);
    res.json({ success: true });
    return;
  }
  try {
    await settleFromMoyasar(ref);
    res.json({ success: true });
  } catch (e) {
    console.error('payments webhook settle error:', (e as Error).message);
    res.status(500).json({ success: false }); // ميسر سيعيد الارسال
  }
});

// خنق مزامنة public-status: الرابط الواحد لا يسال ميسر اكثر من مرة كل ٦ ثوان
// (يمنع تحويل نقطة عامة الى مضخة طلبات نحو حساب ميسر)
const lastSyncAt = new Map<string, number>();

// حالة عامة لصفحة نجاح الدفع — بالمعرف غير القابل للتخمين، بلا مصادقة
router.get('/public-status/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const select = { id: true, status: true, description: true, amountHalalas: true, paidAt: true, moyasarInvoiceId: true } as const;
    let link = await prisma.paymentLink.findUnique({ where: { id: req.params.id }, select });
    if (!link) { res.status(404).json({ success: false, message: 'رابط غير معروف' }); return; }

    const last = lastSyncAt.get(link.id) || 0;
    if (link.status === 'initiated' && link.moyasarInvoiceId && moyasarConfigured() && Date.now() - last > 6000) {
      lastSyncAt.set(link.id, Date.now());
      await settleFromMoyasar(link.id).catch(() => { /* العرض يتحمل التاخر */ });
      link = await prisma.paymentLink.findUnique({ where: { id: req.params.id }, select });
    }
    const { moyasarInvoiceId: _hide, ...pub } = link!;
    res.json({ success: true, data: pub });
  } catch (err) { next(err); }
});

export default router;
export { paymentsWebhookRouter };
