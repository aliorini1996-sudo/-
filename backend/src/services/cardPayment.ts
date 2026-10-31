import crypto from 'crypto';
import prisma from '../config/database';
import { roundHalfUp } from '../lib/money';
import { generateReceiptNumber, withNumberRetry } from '../utils/helpers';
import { postReceiptEntries, reverseReceiptEntries, clean } from './accounting';
import { publishInvoicesChanged } from './liveEvents';
import { claimReceiptCancel, restoreAllocations } from './docCancel';
import { ALLOCATION_BLOCKED_MIRRORS } from '../compliance/zatca/status';
import { ZATCA_ERROR_CATALOGUE } from '../compliance/zatca/errors';
import { fetchIntent, nearpayConfigured, nearpayEnv, nearpayJwtConfigured, NearpayError, signTerminalJwt, type IntentSnapshot } from './nearpay';

/**
 * «التحصيل بالبطاقة» — العميل يلمس بطاقته بجوال المندوب عبر NearPay (طلب المالك ٢٨ أكتوبر ٢٠٢٦).
 *
 * المسار:
 *  1. المندوب يختار فاتورة ← الخادم يُنشئ CardPayment (معرّفه = intentUUID) ورمز تسليمٍ لمرة واحدة.
 *  2. صفحة المندوب تفتح وحدة الدفع الأصلية (intent://) بالرمز وحده — لا مبلغ في الرابط.
 *  3. الوحدة تستبدل الرمز بتفاصيل العملية (المبلغ بالهللات، المرجع، JWT نقطة البيع) ثم تشغّل purchase().
 *  4. الخادم يسأل NearPay عن النيّة بمفتاحنا — لا ثقة بما يقوله الجوال — فإن وافقت بالمبلغ ونقطة البيع نفسيهما
 *     أصدر سند القبض في معاملة واحدة (طريقة «شبكة» POS) وخصّصه للفاتورة.
 *  5. مجدولٌ يراجع المعلّق كل دقيقة، ويعيد فحص الموافق حديثاً: عكسٌ لدى NearPay يُلغي السند ويعيد الفاتورة.
 *
 * NearPay بنية الدفع بالجوال فقط، والتحصيل عبر بنكٍ محصِّل يربطه المالك بها: البنك يودع المال في حساب تاجر الشركة مباشرة
 * (تصحيح المالك ٣١ أكتوبر ٢٠٢٦) — فلا أمانات ولا عمولة هنا (بخلاف روابط الدفع paylink.ts).
 */

const LAUNCH_TTL_MS = 10 * 60_000; // رمز التسليم صالح عشر دقائق ولمرة واحدة
const PENDING_TTL_MS = 45 * 60_000; // نيّة لم تظهر لدى NearPay بعد ٤٥ دقيقة تُعدّ منتهية
const REVERSAL_WATCH_MS = 30 * 60_000; // الموافق حديثاً يُعاد فحصه كل دقيقة نصف ساعة (العكس يقع خلال ٦٠ ثانية من العملية)
// ثم ببطء: الاسترداد ممكن لدى NearPay في أي وقت (ولو من جوال المندوب) — يُسأل عن الموافق كل ٦ ساعات ثلاثين يوماً
const REFUND_WATCH_MS = 30 * 24 * 3600_000;
const REFUND_RECHECK_MS = 6 * 3600_000;
const DEAD_WINDOW_MS = 72 * 3600_000; // المرفوض/المنتهي محلياً بعد فتح وحدة الدفع يُسأل عنه ثلاثة أيام — دفعة اللحظة الأخيرة
const IN_PROGRESS_MS = 10 * 60_000; // عملية فُتحت وحدتها قبل أقل من عشر دقائق تمنع عملية ثانية على الفاتورة نفسها
const MAX_AMOUNT = 1_000_000;
// حالة النيّة: عكسٌ/إلغاء (يعود المال)، واسترداد، ورفضٌ/فشل — كلٌّ بحكمه في decideCardPayment
const REVERSED_STATUS = /revers|void|cancel/;
const REFUND_STATUS = /refund/;
const DECLINED_STATUS = /declin|reject|fail/;

export const halalasOf = (sar: number): number => Math.round(roundHalfUp(sar, 2) * 100);
const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export class CardPayError extends Error {
  /** paymentId: العملية الجارية أو الموقوفة على الفاتورة — كي تعرض الواجهة نتيجتها بدل رسالةٍ بلا مخرج */
  constructor(message: string, readonly status = 400, readonly code = 'CARD_PAY_INVALID', readonly paymentId?: string) { super(message); }
}

/**
 * بيئة الاختبار لدى NearPay لا مال فيها — فسندٌ منها على خادم الإنتاج يُسقط ديناً حقيقياً ببطاقة اختبار (مراجعة ٣١ أكتوبر ٢٠٢٦).
 * على الإنتاج لا تُستعمل إلا لشركاتٍ مسمّاة في NEARPAY_SANDBOX_TENANTS (معرّفات بفواصل)؛ خارج الإنتاج حرّة للتطوير.
 */
export function sandboxBlocked(tenantId: string): boolean {
  if (nearpayEnv() !== 'sandbox' || process.env.NODE_ENV !== 'production') return false;
  const allowed = (process.env.NEARPAY_SANDBOX_TENANTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return !allowed.includes(tenantId);
}
const SANDBOX_MESSAGE = 'خادم الدفع على بيئة اختبار NearPay — التحصيل الحقيقي بالبطاقة غير متاح بعد';

/**
 * زرّ «تحصيل بالبطاقة» في تطبيق المندوب يظهر حين يمكن التحصيل فعلاً (مراجعة المالك ٣١ أكتوبر ٢٠٢٦): مفاتيح NearPay مضبوطة،
 * والبيئة غير محجوبة عن الشركة، وتطبيق المندوب المنشور يحمل وحدة الدفع الأصلية — CARD_PAY_APP_READY=1 يضبطه المالك بعد نشرها.
 * قبلها كان الزرّ يظهر فيعود الجوال إلى «حدّث التطبيق» ولا تحديث في المتجر.
 */
export function cardPayUsable(tenantId: string): boolean {
  return nearpayConfigured() && cardPayLaunchConfigured() && !sandboxBlocked(tenantId) && process.env.CARD_PAY_APP_READY === '1';
}

/**
 * رقم مشروع Google Cloud المربوط بـPlay Integrity — أرقامٌ فقط (Project number لا Project ID)، وغيرها كغيابه.
 * بما تقبله الوحدة نفسها (Long موجب): صفرٌ أو رقمٌ يفيض عن Long كان يمرّ هنا فيُستهلك الرمز ثم ترفضه الوحدة
 */
function gcpProjectNumber(): string | null {
  const v = (process.env.NEARPAY_GCP_PROJECT_NUMBER || '').trim().replace(/^0+/, '');
  return /^[1-9]\d{0,17}$/.test(v) ? v : null;
}

/**
 * ما تحتاجه وحدة الدفع في تطبيق المندوب لتدخل نقطة البيع: مفتاح JWT (مع معرّف العميل) ورقم مشروع Google Cloud. الوحدة لا تنفّذ
 * دخول OTP، فبدون أيٍّ منهما لا تحصيل — والزرّ يُخفى، والإصدار والاستبدال يُرفضان قبل استهلاك الرمز (مراجعة ٣١ أكتوبر ٢٠٢٦:
 * كان الاستبدال يحرق الرمز ثم تفشل الوحدة، فتُحجز الفاتورة عشر دقائق بلا مخرج)
 */
export function cardPayLaunchConfigured(): boolean {
  return nearpayJwtConfigured() && gcpProjectNumber() !== null;
}

// ═══ القرار — دالة صرفة تُختبر بلا قاعدة ولا شبكة ═══

export type CardDecision =
  | { action: 'wait' }
  | { action: 'expire' }
  | { action: 'decline'; detail: string }
  | { action: 'approve' }
  | { action: 'reverse'; detail: string }
  | { action: 'mismatch'; detail: string };

/**
 * ما نفعله بعمليةٍ محلية في ضوء ما تقوله NearPay. القاعدة **تفشل مغلقة** (مراجعة ٢٨ أكتوبر ٢٠٢٦): لا سند إلا لنيّةٍ حالتها
 * «approved» بمعاملةٍ فعّالة واحدة، مبلغُ النيّة فيها بالهللة نفسها (والمأذون إن قُرئ)، ونقطةُ بيعها المسندة نفسها مقروءة،
 * ولم تُعكس ولم تُسترد. حقلٌ غائب أو مختلف = «mismatch» يوقف القيد ويرفع صوتاً — لا يُخمَّن.
 *
 * ومراجعة ٣١ أكتوبر ٢٠٢٦ — الخطأ في الاتجاهين مالٌ ضائع، فما لا يُحسم بدليلٍ يُوقَف للمراجعة لا يُخمَّن:
 *  - الخصم المكرر والإشارة غير المفسَّرة والاسترداد الجزئي تُفحص أولاً — قبل أي إلغاء (كان استرداد أحد خصمين يُلغي سند الآخر،
 *    و«refunded» في الحالة يُلغي السند كله على استردادٍ جزئي).
 *  - العكس والإلغاء في حالة النيّة يحكمان على الإيصال كما كانا؛ أما الرفض والفشل فلا يُسقطان شراءً موافَقاً قائماً في معاملاتها
 *    (كان يُعرض للمندوب «لم يتم» فيحصّل ثانية)، و«استرداد» في الحالة بلا مبلغٍ مقروء لا يُعرف أكاملٌ هو أم جزئي.
 */
export function decideCardPayment(
  row: { status: string; amountHalalas: number; tid: string; createdAt: Date; transactionUuid?: string | null },
  snap: IntentSnapshot | null,
  now: Date,
): CardDecision {
  const age = now.getTime() - row.createdAt.getTime();
  const booked = row.status === 'approved';
  const late = age > PENDING_TTL_MS;
  const hold = (detail: string): CardDecision => ({ action: 'mismatch', detail });
  if (!snap || !snap.found) {
    if (booked) return { action: 'wait' }; // اختفاء نيّةٍ موافَقة لا يمحو سنداً — يُترك لمراجعة بشرية
    return late ? { action: 'expire' } : { action: 'wait' };
  }
  const st = snap.status || '';
  // المعاملة الفعّالة غير المقيَّدة: سندٌ قائم على معاملةٍ لم تعد هي التي بقي مالها
  const otherTx = booked && !!row.transactionUuid && !!snap.transactionUuid && row.transactionUuid !== snap.transactionUuid;

  if (snap.effectiveCount > 1) return hold(`${snap.effectiveCount} عمليات موافَقة على النيّة نفسها — خصم مكرر محتمل`);
  if (snap.anomaly) return hold(snap.anomaly);
  if (snap.refund === 'partial') return hold('استرداد جزئي لدى NearPay — يحتاج معالجة يدوية');
  // دليل المعاملات: عُكس كل شراءٍ موافَق أو استُرد كاملاً — لا مال باقٍ عند التاجر
  if (snap.reversed) {
    const why = snap.refund === 'full' ? 'استُرد المبلغ لدى NearPay' : 'عُكست العملية لدى NearPay';
    return booked ? { action: 'reverse', detail: why } : { action: 'decline', detail: why };
  }
  if (REVERSED_STATUS.test(st)) {
    if (otherTx) return hold(`الحالة لدى NearPay ${st} والمعاملة الباقية غير المقيّدة`);
    const why = `الحالة لدى NearPay ${st}`;
    return booked ? { action: 'reverse', detail: why } : { action: 'decline', detail: snap.statusMessage || why };
  }
  if (REFUND_STATUS.test(st)) {
    if (!booked && !snap.approved) return { action: 'decline', detail: snap.statusMessage || `الحالة لدى NearPay ${st}` };
    return hold(`الحالة لدى NearPay ${st} بلا استرداد كامل مقروء على المعاملة`);
  }
  if (DECLINED_STATUS.test(st)) {
    if (snap.approved) return hold(`الحالة لدى NearPay ${st} وعليها شراء موافَق غير معكوس`);
    return booked ? hold(`الحالة لدى NearPay ${st} والسند مقيّد`) : { action: 'decline', detail: snap.statusMessage || `الحالة لدى NearPay ${st}` };
  }
  if (st === 'approved') {
    if (!snap.approved) {
      return late ? hold('النيّة موافَقة لدى NearPay بلا إيصال موافَق مقروء') : { action: 'wait' };
    }
    if (snap.amountHalalas === null || snap.amountHalalas !== row.amountHalalas) {
      return { action: 'mismatch', detail: `المبلغ لدى NearPay ${snap.amountHalalas ?? 'غير مقروء'} هللة لا ${row.amountHalalas}` };
    }
    if (snap.authorizedHalalas !== null && snap.authorizedHalalas !== row.amountHalalas) {
      return { action: 'mismatch', detail: `المأذون لدى NearPay ${snap.authorizedHalalas} هللة لا ${row.amountHalalas}` };
    }
    if (!snap.tid || snap.tid !== row.tid) {
      return { action: 'mismatch', detail: `نقطة البيع لدى NearPay ${snap.tid ?? 'غير مقروءة'} لا ${row.tid}` };
    }
    if (otherTx) return hold('المعاملة الباقية لدى NearPay غير المعاملة المقيّد سندها');
    return booked ? { action: 'wait' } : { action: 'approve' };
  }
  // إيصالٌ موافَق تحت حالةٍ أخرى أو مجهولة: لا قيد — انتظارٌ ثم صوت
  if (snap.approved) {
    return late && !booked ? hold(`إيصال موافَق والحالة لدى NearPay ${st || 'مجهولة'}`) : { action: 'wait' };
  }
  return late && row.status === 'pending' ? { action: 'expire' } : { action: 'wait' };
}

// ═══ الإنشاء ═══

export interface CreatedCardPayment {
  id: string; amount: number; amountHalalas: number; reference: string; tid: string;
  launchToken: string; launchExpiresAt: Date; launchUri: string;
}

/** رابط فتح وحدة الدفع الأصلية في تطبيق المندوب — رمز التسليم وحده فيه، والرجوع إلى الويب إن لم تكن الوحدة مثبّتة */
export function launchUriFor(token: string): string {
  const fallback = encodeURIComponent('https://fieldsa.net/rep?cardpay=unsupported');
  return `intent://cardpay?t=${encodeURIComponent(token)}#Intent;scheme=fieldsapay;package=net.fieldsa.twa;S.browser_fallback_url=${fallback};end`;
}

/**
 * يُنشئ عملية دفع لفاتورة — بكامل متبقّيها أو جزء منه — على نقطة البيع المسندة للمندوب.
 * يرمي CardPayError برسالة عمل لكل رفض. لا يتصل بـNearPay: الاتصال يبدأ من الجوال.
 */
export async function createCardPayment(params: {
  tenantId: string; invoiceId: string; salesRepId: string; createdById?: string; amount?: number;
}): Promise<CreatedCardPayment> {
  if (!nearpayConfigured() || !cardPayLaunchConfigured()) throw new CardPayError('التحصيل بالبطاقة غير مهيأ على الخادم', 503, 'CARD_PAY_NOT_CONFIGURED');
  if (sandboxBlocked(params.tenantId)) throw new CardPayError(SANDBOX_MESSAGE, 403, 'CARD_PAY_SANDBOX');
  const [invoice, rep, company] = await Promise.all([
    prisma.invoice.findFirst({
      where: { id: params.invoiceId, tenantId: params.tenantId },
      select: { id: true, number: true, status: true, type: true, customerId: true, remainingAmt: true, einvoiceStatus: true },
    }),
    prisma.salesRep.findFirst({ where: { id: params.salesRepId, tenantId: params.tenantId }, select: { id: true, isActive: true, nearpayTid: true } }),
    prisma.companySettings.findUnique({ where: { tenantId: params.tenantId }, select: { currency: true } }),
  ]);
  const tenant = await prisma.tenant.findUnique({ where: { id: params.tenantId }, select: { nearpayMerchantId: true } });
  if (!tenant?.nearpayMerchantId) throw new CardPayError('لم يُربط تاجر الشركة لدى NearPay بعد — تواصل مع مزود الخدمة', 409, 'CARD_PAY_NO_MERCHANT');
  if (!invoice) throw new CardPayError('الفاتورة غير موجودة', 404);
  if (invoice.status !== 'CONFIRMED' || invoice.type === 'RETURN') throw new CardPayError('التحصيل بالبطاقة من فاتورة معتمدة غير مرتجعة فقط');
  if (invoice.einvoiceStatus !== null && (ALLOCATION_BLOCKED_MIRRORS as readonly string[]).includes(invoice.einvoiceStatus)) {
    throw new CardPayError(ZATCA_ERROR_CATALOGUE.ZATCA_ALLOCATION_BLOCKED.messageAr, 409, 'ZATCA_ALLOCATION_BLOCKED');
  }
  if ((company?.currency || 'SAR') !== 'SAR') throw new CardPayError('التحصيل بالبطاقة متاح للشركات بالريال السعودي فقط');
  if (!rep || !rep.isActive) throw new CardPayError('المندوب غير موجود أو موقوف', 404);
  if (!rep.nearpayTid) throw new CardPayError('لا توجد نقطة بيع مسندة لهذا المندوب — تواصل مع الإدارة', 409, 'CARD_PAY_NO_TERMINAL');

  // عمليةٌ فُتحت وحدتها للتو على الفاتورة نفسها: نسأل عنها أولاً — قد تكون دُفعت وتعطّل رجوع الجوال، فإعادة البدء خصمٌ مكرر
  const inFlight = await prisma.cardPayment.findMany({
    where: { tenantId: params.tenantId, invoiceId: invoice.id, status: 'pending', launchedAt: { gt: new Date(Date.now() - IN_PROGRESS_MS) } },
    select: { id: true },
  });
  for (const f of inFlight) {
    const r = await checkCardPayment(f.id).catch(() => null);
    if (!r || r.status === 'pending') {
      throw new CardPayError('عملية دفع بالبطاقة جارية على هذه الفاتورة — انتظر نتيجتها أو حدّث الحالة', 409, 'CARD_PAY_IN_PROGRESS', f.id);
    }
  }
  // عمليةٌ خُصمت لدى NearPay ولم يُقيَّد سندها (اختلافٌ قيد المراجعة): تحصيلٌ جديد خصمٌ ثانٍ من العميل — حتى تحسمها الإدارة
  const held = await prisma.cardPayment.findFirst({ where: { tenantId: params.tenantId, invoiceId: invoice.id, status: 'review' }, select: { id: true } });
  if (held) {
    throw new CardPayError('عملية بطاقة سابقة على هذه الفاتورة خصمت لدى NearPay ولم يسجل سندها — لا تحصل مرة أخرى حتى تراجعها الإدارة', 409, 'CARD_PAY_REVIEW', held.id);
  }
  const fresh = inFlight.length
    ? await prisma.invoice.findUnique({ where: { id: invoice.id }, select: { remainingAmt: true } })
    : invoice;
  const remaining = roundHalfUp(Number(fresh?.remainingAmt ?? 0), 2);
  if (remaining <= 0) throw new CardPayError('الفاتورة مسددة بالكامل');
  const amount = params.amount === undefined ? remaining : roundHalfUp(params.amount, 2);
  if (!(amount > 0)) throw new CardPayError('المبلغ يجب أن يكون أكبر من صفر');
  if (amount > remaining + 0.004) throw new CardPayError(`المبلغ أكبر من متبقي الفاتورة (${remaining})`);
  if (amount > MAX_AMOUNT) throw new CardPayError('المبلغ يتجاوز حد العملية الواحدة');

  const launchToken = crypto.randomBytes(24).toString('base64url');
  const launchExpiresAt = new Date(Date.now() + LAUNCH_TTL_MS);
  const row = await prisma.cardPayment.create({
    data: {
      tenantId: params.tenantId,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      salesRepId: rep.id,
      createdById: params.createdById,
      amount,
      amountHalalas: halalasOf(amount),
      tid: rep.nearpayTid,
      reference: invoice.number,
      launchTokenHash: hashToken(launchToken),
      launchExpiresAt,
    },
  });
  return {
    id: row.id, amount, amountHalalas: row.amountHalalas, reference: row.reference, tid: row.tid,
    launchToken, launchExpiresAt, launchUri: launchUriFor(launchToken),
  };
}

// ═══ التسليم إلى وحدة الدفع الأصلية ═══

export interface LaunchPayload {
  intentId: string; amountHalalas: number; amount: number; reference: string; tid: string;
  environment: 'SANDBOX' | 'PRODUCTION';
  // دائماً: الوحدة لا تنفّذ دخول OTP، والاستبدال يُرفض (503) قبل استهلاك الرمز إن غاب مفتاح JWT أو رقم المشروع
  jwt: string;
  googleCloudProjectNumber: string;
  customerName: string; invoiceNumber: string; companyName: string;
  // الوحدة تعرضه فوق المبلغ: الرمز بلا هوية والمسار عامّ — رمزٌ أصدره حسابٌ آخر يظهر باسم غير اسم المندوب قبل أي خصم
  repName: string;
}

/**
 * يستبدل رمز التسليم بتفاصيل العملية — مرة واحدة وقبل انتهائه، ولعملية معلّقة فقط. الحمولة كلها (ومنها توقيع JWT) تُبنى قبل
 * استهلاك الرمز (مراجعة ٣١ أكتوبر ٢٠٢٦): مفتاحٌ تالف كان يحرق الرمز ويحجز الفاتورة عشر دقائق بلا مخرج.
 */
export async function redeemLaunchToken(token: string): Promise<LaunchPayload> {
  const now = new Date();
  const hash = hashToken(token);
  const row = await prisma.cardPayment.findUnique({
    where: { launchTokenHash: hash },
    include: {
      customer: { select: { name: true } }, tenant: { select: { name: true, cardPayEnabled: true, nearpayMerchantId: true } },
      invoice: { select: { status: true, type: true, remainingAmt: true, einvoiceStatus: true } },
      salesRep: { select: { isActive: true, nearpayTid: true, name: true } },
    },
  });
  const invalid = () => new CardPayError('رمز الدفع غير صالح أو مستخدم أو منتهٍ — ابدأ التحصيل من جديد', 410, 'CARD_PAY_LAUNCH_INVALID');
  if (!row || row.launchedAt || !row.launchExpiresAt || row.launchExpiresAt <= now || row.status !== 'pending') throw invalid();
  // آخر خطوةٍ قبل أن يتحرّك المال: الفاتورة ما زالت قائمة غير محجوبة ومتبقّيها يتّسع للمبلغ، والميزة مفعّلة، ونقطة البيع ما زالت
  // لهذا المندوب القائم ولتاجرٍ مربوط — سحبُها منه أو تغييرُ التاجر بعد الإصدار لا يُبقي رمزه صالحاً
  const inv = row.invoice;
  const stale = !row.tenant.cardPayEnabled ? 'أُطفئ التحصيل بالبطاقة للشركة'
    : !row.tenant.nearpayMerchantId || !row.salesRep?.isActive || row.salesRep.nearpayTid !== row.tid ? 'تغيّر إسناد نقطة البيع — ابدأ التحصيل من جديد'
      : sandboxBlocked(row.tenantId) ? SANDBOX_MESSAGE
        : inv.status !== 'CONFIRMED' || inv.type === 'RETURN' ? 'الفاتورة لم تعد قائمة'
          : inv.einvoiceStatus !== null && (ALLOCATION_BLOCKED_MIRRORS as readonly string[]).includes(inv.einvoiceStatus) ? 'الفاتورة محجوبة لدى الهيئة'
            : roundHalfUp(Number(inv.remainingAmt), 2) + 0.004 < row.amount ? 'تغيّر متبقي الفاتورة — ابدأ التحصيل من جديد'
              : null;
  if (stale) {
    await prisma.cardPayment.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'failed', statusDetail: stale } });
    throw new CardPayError(stale, 409, 'CARD_PAY_STALE');
  }
  // الضبط قبل الاستهلاك: 503 هنا يُبقي الرمز صالحاً (الوحدة تعدّ 5xx قابلاً للإعادة)، والفاتورة لا تُحجز
  const gcp = gcpProjectNumber();
  if (!nearpayJwtConfigured() || !gcp) throw new CardPayError('التحصيل بالبطاقة غير مهيأ على الخادم', 503, 'CARD_PAY_NOT_CONFIGURED');
  const terminalJwt = signTerminalJwt(row.tid);
  const claimed = await prisma.cardPayment.updateMany({
    where: { id: row.id, launchTokenHash: hash, launchedAt: null, launchExpiresAt: { gt: now }, status: 'pending' },
    data: { launchedAt: now },
  });
  if (claimed.count !== 1) throw invalid();
  return {
    intentId: row.id,
    amountHalalas: row.amountHalalas,
    amount: row.amount,
    reference: row.reference,
    tid: row.tid,
    environment: nearpayEnv() === 'production' ? 'PRODUCTION' : 'SANDBOX',
    jwt: terminalJwt,
    googleCloudProjectNumber: gcp,
    customerName: row.customer.name,
    invoiceNumber: row.reference,
    companyName: row.tenant.name,
    repName: row.salesRep?.name ?? '',
  };
}

// ═══ التحقق والقيد ═══

export interface CheckResult {
  id: string; status: string; receiptId: string | null; receiptNumber?: string | null; detail?: string | null;
  amount?: number; reference?: string; // تعرضهما شاشة المندوب حين تغيب العملية المحفوظة على جواله
}

async function view(id: string): Promise<CheckResult> {
  const r = await prisma.cardPayment.findUnique({ where: { id }, select: { id: true, status: true, receiptId: true, statusDetail: true, amount: true, reference: true } });
  if (!r) throw new CardPayError('العملية غير موجودة', 404);
  const receipt = r.receiptId ? await prisma.receipt.findUnique({ where: { id: r.receiptId }, select: { number: true } }) : null;
  return { id: r.id, status: r.status, receiptId: r.receiptId, receiptNumber: receipt?.number ?? null, detail: r.statusDetail, amount: r.amount, reference: r.reference };
}

/**
 * يسأل NearPay عن العملية ويتصرف بالقرار. آمنٌ للتكرار والتزامن: القيد محميّ بتبديلٍ ذرّي pending→approved داخل
 * المعاملة، وclientRef «cardpay:<id>» الفريد يمنع سندين، وtransactionUuid فريد يمنع حجز معاملة NearPay لعمليتين.
 */
export async function checkCardPayment(id: string): Promise<CheckResult> {
  const row = await prisma.cardPayment.findUnique({ where: { id } });
  if (!row) throw new CardPayError('العملية غير موجودة', 404);
  // الميت محلياً قد يكون وُوفق عليه في نافذة السباق — يُسأل عنه ثلاثة أيام من إنشائه (لا من آخر لمسة: الفحص يلمسه)، ثم يُعرض كما هو.
  // و«review» (خُصم لدى NearPay واختلف) يُسأل عنه كذلك: يُقيد إن زال الاختلاف (استُرد الخصم المكرر)، ويُعكس إن عاد المال.
  // و«failed» (فاتورةٌ تغيّرت قبل الدفع، أو أغلقته الإدارة بعد المراجعة) لا يُقيد آلياً أبداً
  if (row.status === 'failed' || (['declined', 'expired', 'reversed', 'review'].includes(row.status) && Date.now() - row.createdAt.getTime() > DEAD_WINDOW_MS)) {
    return view(id);
  }

  // اللمسة قبل السؤال: نيّةٌ يفشل جلبها (5xx أو مهلة) تنتقل إلى آخر طابور المجدول — كانت تبقى أوّله فتوقف الكنس لكل الشركات
  await prisma.cardPayment.update({ where: { id }, data: { lastCheckedAt: new Date(), checks: { increment: 1 } } }).catch(() => { /* شكلي */ });
  const snap = await fetchIntent(row.id);
  const now = new Date();
  const d = decideCardPayment(row, snap, now);

  switch (d.action) {
    case 'wait':
      return view(id);
    case 'expire':
      await prisma.cardPayment.updateMany({ where: { id, status: 'pending' }, data: { status: 'expired', statusDetail: 'لم تُسجَّل العملية لدى NearPay' } });
      return view(id);
    case 'decline':
      await prisma.cardPayment.updateMany({ where: { id, status: { in: ['pending', 'expired'] } }, data: { status: 'declined', statusDetail: d.detail.slice(0, 300) } });
      return view(id);
    case 'mismatch': {
      console.error(`CRITICAL cardpay ${id}: ${d.detail} — booking refused`);
      const detail = d.detail.slice(0, 300);
      // «review» لا «failed» (مراجعة ٣١ أكتوبر ٢٠٢٦): المال قد خُصم لدى NearPay — شاشة المندوب تقول «لا تحصّل ثانية»، والإنشاء
      // يُرفض على الفاتورة حتى تحسمه الإدارة؛ و«failed» يبقى لما لم يتحرّك فيه مال
      const held = await prisma.cardPayment.updateMany({ where: { id, status: { in: ['pending', 'expired', 'declined'] } }, data: { status: 'review', statusDetail: detail } });
      // موافَقٌ قيد سنده (أو موقوفٌ للمراجعة) ثم ظهر سببٌ جديد: لا تُلمس حالته — يُدوَّن السبب ويُشعَر مرةً لكل سببٍ جديد
      const noted = held.count === 1 ? 0
        : (await prisma.cardPayment.updateMany({ where: { id, status: { in: ['approved', 'review'] }, NOT: { statusDetail: detail } }, data: { statusDetail: detail } })).count;
      // إشعارٌ واحد لمن بدّل الحالة أو السبب — لا يتكرر مع كل دورة للمجدول
      if (held.count === 1 || noted === 1) {
        await prisma.notification.create({
          data: { tenantId: row.tenantId, type: 'CARDPAY_MISMATCH', title: 'تحصيل بالبطاقة يحتاج مراجعة', body: `فاتورة ${row.reference}: ${d.detail}` },
        }).catch(() => { /* كمالي */ });
      }
      return view(id);
    }
    case 'reverse':
      await reverseCardPayment(id, d.detail);
      return view(id);
    case 'approve':
      await bookApproved(row.id, snap!);
      return view(id);
  }
}

/** معاملة القيد الواحدة: سند قبض بالمبلغ المؤكَّد + تخصيصه بقدر المتبقّي + قيود العميل + تبديل العملية */
async function bookApproved(id: string, snap: IntentSnapshot): Promise<void> {
  const row = await prisma.cardPayment.findUnique({
    where: { id },
    include: { invoice: { select: { number: true, teamId: true, einvoiceStatus: true } } },
  });
  if (!row || row.receiptId) return;
  const collected = roundHalfUp(row.amountHalalas / 100, 2);
  const clientRef = `cardpay:${row.id}`;
  const scheme = snap.cardScheme ? ` ${snap.cardScheme}` : '';
  const pan = snap.maskedPan ? ` ${snap.maskedPan}` : '';

  try {
    await withNumberRetry(async () => {
      const number = await generateReceiptNumber(row.tenantId);
      return prisma.$transaction(async tx => {
        // المطالِب الوحيد: من يبدّل pending/expired/review → approved يقيد السند — تكرار المجدول والجوال لا يقيد مرتين
        const claim = await tx.cardPayment.updateMany({
          where: { id: row.id, status: { in: ['pending', 'expired', 'declined', 'review'] }, receiptId: null },
          data: {
            status: 'approved', approvedAt: new Date(), statusDetail: null,
            transactionUuid: snap.transactionUuid, rrn: snap.rrn, stan: snap.stan, approvalCode: snap.approvalCode,
            cardScheme: snap.cardScheme, maskedPan: snap.maskedPan,
          },
        });
        if (claim.count !== 1) return null;

        const locked = await tx.$queryRaw<{ paidAmt: number; remainingAmt: number; einvoiceStatus: string | null; status: string; type: string }[]>`
          SELECT "paidAmt", "remainingAmt", "einvoiceStatus", status, type FROM invoices WHERE id = ${row.invoiceId} FOR UPDATE`;
        const inv = locked[0] ?? null;
        const remaining = roundHalfUp(Number(inv?.remainingAmt ?? 0), 2);
        // فاتورةٌ أُلغيت أو صارت محجوبة لدى الهيئة بعد الإنشاء: المال قُبض فعلاً — يُقيد السند رصيداً دائناً بلا تخصيص
        const blocked = inv?.einvoiceStatus != null && (ALLOCATION_BLOCKED_MIRRORS as readonly string[]).includes(inv.einvoiceStatus);
        const alloc = blocked || inv?.status !== 'CONFIRMED' || inv?.type === 'RETURN' ? 0 : Math.min(collected, Math.max(0, remaining));

        const rcp = await tx.receipt.create({
          data: {
            tenantId: row.tenantId,
            number,
            clientRef,
            customerId: row.customerId,
            salesRepId: row.salesRepId,
            ...(row.invoice?.teamId && { teamId: row.invoice.teamId }),
            amount: collected,
            paymentMethod: 'POS',
            bankName: 'NearPay',
            notes: `تحصيل بالبطاقة${scheme}${pan} — فاتورة ${row.reference}${snap.rrn ? ` — RRN ${snap.rrn}` : ''}`
              + (alloc < collected ? ' (الفائض رصيد دائن للعميل)' : '')
              + (nearpayEnv() === 'sandbox' ? ' [SANDBOX]' : ''),
          },
        });
        if (alloc > 0) {
          await tx.receiptInvoice.create({ data: { receiptId: rcp.id, invoiceId: row.invoiceId, amount: alloc } });
          await tx.invoice.update({
            where: { id: row.invoiceId },
            data: { paidAmt: clean(Number(inv?.paidAmt ?? 0) + alloc), remainingAmt: clean(remaining - alloc) },
          });
        }
        await postReceiptEntries(tx as never, row.tenantId, rcp.id, row.customerId, collected);
        await tx.cardPayment.update({ where: { id: row.id }, data: { receiptId: rcp.id } });
        await tx.notification.create({
          data: { tenantId: row.tenantId, type: 'CARDPAY_PAID', title: 'تحصيل بالبطاقة', body: `تحصيل ${collected} بالبطاقة لفاتورة ${row.reference} — سند ${number}` },
        }).catch(() => { /* كمالي */ });
        return rcp;
      });
    });
  } catch (e) {
    // transactionUuid أو clientRef مكرّر: معاملة موازية سبقت — لا خطأ
    if ((e as { code?: string })?.code === 'P2002') return;
    throw e;
  }
  publishInvoicesChanged(row.tenantId);
  // متبقٍّ تغيّر يميت روابط الدفع الإلكتروني الحية على الفاتورة (كأي سند) — best-effort
  import('./paylink').then(m => m.expireStaleLinks(row.tenantId, row.invoiceId)).catch(() => { /* best-effort */ });
}

/** عكسٌ لدى NearPay بعد القيد: إلغاء السند وإعادة الفاتورة وعكس قيود العميل — لمن يفوز بالتبديل وحده */
export async function reverseCardPayment(id: string, reason: string): Promise<void> {
  const row = await prisma.cardPayment.findUnique({ where: { id }, include: { invoice: { select: { number: true } } } });
  if (!row) return;
  if (row.status !== 'approved' || !row.receiptId) {
    // الموقوف للمراجعة يُحسم بعودة المال كاملاً — لا سند له يُلغى
    await prisma.cardPayment.updateMany({ where: { id, status: { in: ['pending', 'expired', 'review'] } }, data: { status: 'reversed', statusDetail: reason.slice(0, 300) } });
    return;
  }
  const receipt = await prisma.receipt.findUnique({ where: { id: row.receiptId }, include: { invoiceItems: true } });
  await prisma.$transaction(async tx => {
    const claim = await tx.cardPayment.updateMany({ where: { id, status: 'approved' }, data: { status: 'reversed', statusDetail: reason.slice(0, 300) } });
    if (claim.count !== 1 || !receipt) return;
    const cancelled = await claimReceiptCancel(tx, row.tenantId, receipt.id);
    if (cancelled) {
      await restoreAllocations(tx, row.tenantId, receipt.invoiceItems);
      await reverseReceiptEntries(tx as never, row.tenantId, receipt.id, row.customerId, Number(receipt.amount));
    }
    await tx.notification.create({
      data: {
        tenantId: row.tenantId, type: 'CARDPAY_REVERSED', title: 'عكس تحصيل بالبطاقة',
        body: `عُكس تحصيل ${Number(receipt.amount)} لفاتورة ${row.invoice.number} — ${cancelled ? 'أُلغي' : 'كان ملغى'} سند ${receipt.number} (${reason})`,
      },
    }).catch(() => { /* كمالي */ });
  });
  console.error(`cardpay ${id}: reversed (${reason})`);
  publishInvoicesChanged(row.tenantId);
}

// ═══ المجدول ═══

const RECONCILE_INTERVAL_MS = 60_000;
let reconciling = false;

/**
 * دفعةٌ من العمليات — كل واحدة بمعزل، وعطل NearPay العام يوقف الدفعة لا العملية: حدٌّ أو انقطاع، أو مفتاحٌ مرفوض (401/403 —
 * مفتاحٌ دُوِّر أو حظر Cloudflare، لا يخصّ صفاً فلا معنى لسبعين طلباً مرفوضاً كل دقيقة)
 */
async function sweep(ids: { id: string }[], label: string): Promise<void> {
  for (const r of ids) {
    try {
      await checkCardPayment(r.id);
    } catch (e) {
      console.error(`cardpay ${label} ${r.id}:`, (e as Error).message);
      if (e instanceof NearpayError && (e.status === 429 || e.status === 401 || e.status === 403 || e.status >= 500)) return;
    }
  }
}

export async function reconcileCardPayments(): Promise<void> {
  if (reconciling) return; // دورةٌ لم تنته (NearPay بطيء) — لا تراكب
  reconciling = true;
  try {
    const now = Date.now();
    // ١) المعلّق والموافق حديثاً — كل دقيقة
    await sweep(await prisma.cardPayment.findMany({
      where: {
        OR: [
          { status: 'pending', launchedAt: { not: null } }, // فُتحت وحدة الدفع — النتيجة لدى NearPay
          { status: 'pending', createdAt: { lt: new Date(now - PENDING_TTL_MS) } }, // لم تُفتح قط — تنتهي
          { status: 'approved', approvedAt: { gt: new Date(now - REVERSAL_WATCH_MS) } }, // نافذة العكس
        ],
      },
      orderBy: { updatedAt: 'asc' }, take: 40, select: { id: true },
    }), 'reconcile');
    // ٢) الميت محلياً بعد فتح وحدته، والموقوف للمراجعة — دفعة اللحظة الأخيرة لا تضيع (ثلاثة أيام من الإنشاء): كل ٥ دقائق في
    // الساعتين الأوليين ثم كل ساعة (رفض البطاقة معتاد — لا ٨٥٠ طلباً لكل رفض)
    await sweep(await prisma.cardPayment.findMany({
      where: {
        status: { in: ['declined', 'expired', 'review'] }, launchedAt: { not: null }, receiptId: null,
        createdAt: { gt: new Date(now - DEAD_WINDOW_MS) },
        OR: [
          { createdAt: { gt: new Date(now - 2 * 3600_000) }, lastCheckedAt: { lt: new Date(now - 5 * 60_000) } },
          { lastCheckedAt: { lt: new Date(now - 3600_000) } },
        ],
      },
      orderBy: { lastCheckedAt: 'asc' }, take: 15, select: { id: true },
    }), 'dead-sweep');
    // ٣) الموافق في الثلاثين يوماً — كل ست ساعات: استردادٌ لاحق يُلغي السند (كاملاً) أو يُنبّه (جزئياً)
    await sweep(await prisma.cardPayment.findMany({
      where: {
        status: 'approved', approvedAt: { gt: new Date(now - REFUND_WATCH_MS), lt: new Date(now - REVERSAL_WATCH_MS) },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(now - REFUND_RECHECK_MS) } }],
      },
      orderBy: { lastCheckedAt: 'asc' }, take: 15, select: { id: true },
    }), 'refund-watch');
  } catch (e) {
    console.error('cardpay scheduler error:', (e as Error).message);
  } finally {
    reconciling = false;
  }
}

export function startCardPayScheduler(): void {
  if (!nearpayConfigured()) return;
  setInterval(() => { void reconcileCardPayments(); }, RECONCILE_INTERVAL_MS);
  console.log(`💳 Card-pay (NearPay ${nearpayEnv()}) scheduler started (every 60s)`);
}
