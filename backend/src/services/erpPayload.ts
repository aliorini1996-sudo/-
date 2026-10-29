/**
 * حمولة تكامل ERP — صرفة بلا Prisma ولا شبكة، فيختبرها backend ويبني منها الاختبار الحيّ على Odoo 17
 * (.github/workflows/odoo-connector.yml) الحمولةَ نفسها التي يرسلها الخادم.
 *
 * العقد (integrations/odoo/fieldsales_connector/mapping.py):
 *   POST <الرابط> {source:'field-sales', resource, exportedAt, count, data:[صفوف بأسماء حقول Prisma]}
 * والصفوف كما في القاعدة مع حقول مشتقة صريحة حيث يلزم المستقبِل، وبلا الثقيل الذي لا يلزمه (صور المنتجات
 * ولقطة الفوترة الإلكترونية) — صورةٌ واحدة بـbase64 كانت تكفي لتجاوز سقف ١٢ ميغابايت في Odoo.
 *
 * ═══ الوحدات المتعددة (payloadVersion 3): بند الفاتورة بوحدة الأساس ═══
 * القرار: كمية البند وأسعاره في الحمولة **بوحدة الأساس** (وحدة الصنف `product.unit` وسعرها `basePrice`)، والبند
 * كما طُبع (كرتون بسعر الكرتون) في `lineUnit`. لا العكس (كمية الكرتون مع وحدة قياسٍ له في Odoo)، لثلاثة أسباب:
 *  1. الصنف يصل Odoo بوحدةٍ واحدة (`fs_unit` نصّاً، و`list_price` = سعر الأساس)، والموصل لا يضبط وحدة قياس البند
 *     (product_uom_id) ولا يستطيع بأمان: مطابقة وحدات Odoo بالاسم غير موثوقة بين التنصيبات واللغات، و«كرتون»
 *     ليس وحدةً واحدة (٢٤ لصنف و١٢ لآخر). فكميةٌ بوحدة البند تُقرأ هناك «٢ حبة» لكرتونين — الكميات خطأ بالمعامل.
 *  2. بالأساس يصحّ الموصل المثبَّت **كما هو** بلا ترقية: يقرأ qty وunitPrice/unitPriceNet فيسجّل ٤٨ حبة.
 *  3. ولكل مستقبِلٍ عامّ: `qty` كانت دائماً «بوحدة الصنف» — وهي الأساس الآن، فلا ينقلب معناها بصمت.
 * وسعر الأساس = سعر البند ÷ المعامل **مقرَّباً لأعلى إلى خانتين**: Odoo يقرّب السعر لخانتين، والموصل يشتقّ الخصم
 * من مبلغ البند (lineTotal/netAmount) بالسعر المرسَل — فسعرٌ مقرَّب لأعلى يجعل الخصم المشتقّ موجباً يمتصّ الفرق
 * (والباقي ≤ هللات يسوّيه سطر «فرق تقريب»). ولو أُرسل ٠٫٤١٦٧ لقرّبه Odoo ٠٫٤٢ بعد اشتقاق الخصم فزاد البند ٨ ريالات
 * في ١٠٠ كرتون. والمبالغ (lineTotal وtaxAmt وnetAmount) لا تتغيّر — هي الحقيقة.
 * بندٌ بوحدة الأساس (معامل ١، وكل بندٍ قبل الميزة): حرفياً كما كان، ومعه baseQty وlineUnit.
 * ⚠️ تحويل وحدة أساس صنفٍ (convert-base) يجعل كمياته التاريخية في Odoo بالوحدة القديمة — لا تُعاد كتابة فاتورة مُرحَّلة.
 */
import { netFromInclusive, roundHalfUp } from '../lib/money';
import { resolvePaymentMethod, type PaymentMethodsConfigV1 } from './paymentMethodsCore';
import { baseQtyOf, factorOf } from './units';

export type ErpResource = 'customers' | 'products' | 'invoices' | 'receipts';
/** ترتيب التبعية: العميل قبل فاتورته وسنده، والمنتج قبل بند فاتورته */
export const ERP_RESOURCES: readonly ErpResource[] = Object.freeze(['customers', 'products', 'invoices', 'receipts'] as ErpResource[]);
/** صفوف كل طلب: دفعات صغيرة تبقى تحت سقف الحجم والمهلة في المستقبِل */
export const ERP_PAGE_SIZE = 200;
/** مهلة الطلب الواحد — مستقبِلٌ معلّق لا يحبس المزامنة إلى الأبد */
export const ERP_REQUEST_TIMEOUT_MS = 120_000;
/** تداخل المؤشر: ما تغيّر قبيل بدء آخر مزامنة نظيفة بدقيقتين يُعاد إرساله (الترحيل upsert فلا تكرار) */
export const ERP_WATERMARK_OVERLAP_MS = 2 * 60_000;
/**
 * المزامنات «الناجحة» قبل هذا الإصدار لا تُعتمد مؤشراً: كانت ترسل آخر ٥٠٠ صفّ فقط وتُسجَّل نجاحاً ولو رفض
 * المستقبِل كل فواتير البيع — فأول مزامنة بعده ترسل كل السجلات.
 */
export const ERP_SYNC_V2_SINCE = new Date('2026-10-10T00:00:00Z');

/** منطقة الشركة الزمنية لتواريخها المحلية — إعدادات الدفاتر إن وُجدت، وإلا بلدها */
export const COUNTRY_TIMEZONE: Readonly<Record<string, string>> = Object.freeze({
  SA: 'Asia/Riyadh', AE: 'Asia/Dubai', KW: 'Asia/Kuwait', QA: 'Asia/Qatar', BH: 'Asia/Bahrain', OM: 'Asia/Muscat',
  YE: 'Asia/Aden', IQ: 'Asia/Baghdad', JO: 'Asia/Amman', SY: 'Asia/Damascus', LB: 'Asia/Beirut', PS: 'Asia/Gaza',
  EG: 'Africa/Cairo', SD: 'Africa/Khartoum', LY: 'Africa/Tripoli', TN: 'Africa/Tunis', DZ: 'Africa/Algiers',
  MA: 'Africa/Casablanca', MR: 'Africa/Nouakchott', TR: 'Europe/Istanbul',
});

export function companyTimeZone(ledgerTimeZone: string | null | undefined, countryCode: string | null | undefined): string {
  if (ledgerTimeZone) return ledgerTimeZone;
  return COUNTRY_TIMEZONE[String(countryCode ?? '').toUpperCase()] ?? 'Asia/Riyadh';
}

/** التاريخ المحلي YYYY-MM-DD للحظةٍ بمنطقة الشركة — اقتطاع UTC يُرجع فواتير ما بعد منتصف الليل يوماً */
export function localDateIn(d: Date | string | null | undefined, timeZone: string): string | null {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
}

type Rec = Record<string, unknown>;

/**
 * المنتج بلا صورته (base64): لا يلزم المستقبِل ويُضخّم الحمولة. ووحداته (`units`: الاسم والمعامل والسعر والرمز)
 * وشرائحه كما في القاعدة — `unit` و`basePrice` لوحدة الأساس، وهما ما تُقاس به كميات بنود الفواتير وأسعارها.
 * وبلا أعمدة «تتبّع اللوط» (لا ربط خارجي للّوط، §٥.٥ R4).
 */
export function productPayloadRow<T extends Rec>(p: T): Omit<T, 'image' | 'lotTracked' | 'lotTrackedSince'> {
  const { image: _image, lotTracked: _lotTracked, lotTrackedSince: _lotTrackedSince, ...rest } = p as T & { image?: unknown; lotTracked?: unknown; lotTrackedSince?: unknown };
  void _image; void _lotTracked; void _lotTrackedSince;
  return rest;
}

export function customerPayloadRow<T extends Rec>(c: T): T {
  return c;
}

export interface ErpInvoiceItemInput extends Rec {
  unitPrice: number;
  taxPct: number;
  taxAmt: number;
  lineTotal: number;
  /** الكمية بوحدة البند كما طُبعت، ولقطة وحدته (null/1 = الأساس) */
  qty?: number;
  unitName?: string | null;
  unitFactor?: number | null;
  baseQty?: number | null;
  unitCost?: number | null;
  unitCode?: string | null;
  product?: Rec | null;
}

/** سعرٌ مقرَّب **لأعلى** إلى خانتين — انظر رأس الملف: الخصم المشتقّ في Odoo يمتصّ الزيادة ولا يمتصّ النقص */
export function centsUp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  // عبر الميكرو أولاً: 10 ÷ 24 × 24 لا يصير 10.000000001 فيُرفع هللة كاذبة
  return Math.ceil(Math.round(n * 1e6) / 1e4) / 100;
}

/**
 * بند الفاتورة في الحمولة (payloadVersion 3) — بوحدة الأساس، والمطبوع في `lineUnit` (انظر رأس الملف).
 * بندٌ معامله ١: حرفياً كما في الإصدار الثاني، ومعه baseQty وlineUnit فقط.
 */
export function invoiceItemPayloadRow(it: ErpInvoiceItemInput, incl: boolean): Rec {
  const product = it.product ? productPayloadRow(it.product) : null;
  const netLine = incl ? roundHalfUp(netFromInclusive(it.unitPrice, it.taxPct), 4) : it.unitPrice;
  const netAmount = roundHalfUp(it.lineTotal - it.taxAmt, 3);
  const f = factorOf(it);
  const hasQty = typeof it.qty === 'number' && Number.isFinite(it.qty);
  const base = hasQty ? baseQtyOf({ qty: it.qty, unitFactor: f, baseQty: it.baseQty }) : null;
  const baseUnit = typeof product?.unit === 'string' ? product.unit : null;
  const lineUnit = hasQty
    ? { name: it.unitName ?? baseUnit, factor: f, qty: it.qty, unitPrice: it.unitPrice, unitPriceNet: netLine, unitCode: it.unitCode ?? null }
    : undefined;
  if (f === 1) {
    return { ...it, product, unitPriceNet: netLine, netAmount, ...(hasQty ? { baseQty: base, lineUnit } : {}) };
  }
  return {
    ...it,
    product,
    // الكمية ولقطتها تصف وحدة الأساس معاً — qty × unitFactor = baseQty عند كل قارئ، فلا يُضرب المعامل مرتين
    qty: base, unitName: baseUnit, unitFactor: 1, baseQty: base,
    // رمز الوحدة الضريبي للبند (كرتون) ليس رمز الأساس — يبقى مع البند المطبوع، ورمز الأساس رمز الصنف
    unitCode: typeof product?.unitCode === 'string' ? product.unitCode : null,
    unitPrice: centsUp(it.unitPrice / f),
    unitPriceNet: centsUp((incl ? netFromInclusive(it.unitPrice, it.taxPct) : it.unitPrice) / f),
    // تكلفة الصفّ لوحدة الصفّ ⇒ لوحدة الأساس
    ...(typeof it.unitCost === 'number' ? { unitCost: roundHalfUp(it.unitCost / f, 6) } : {}),
    netAmount,
    lineUnit,
  };
}

export interface ErpInvoiceInput extends Rec {
  invoiceDate: Date | string;
  pricesIncludeTax?: boolean | null;
  total: number;
  taxAmt: number;
  items: ErpInvoiceItemInput[];
  originalInvoice?: { number: string } | null;
}

/**
 * الفاتورة كما في القاعدة مع حقول مشتقة صريحة (payloadVersion 3 — الثالث: البنود بوحدة الأساس، invoiceItemPayloadRow):
 *  - `unitPriceNet`: سعر الوحدة **صافياً قبل الضريبة** — المستقبِل (كأي نظام محاسبي) يحسب الضريبة فوق السعر،
 *    وفواتير تطبيق المندوب تخزّنه شاملاً.
 *  - `netAmount`: صافي البند بعد خصم البند **وحصّته من خصم الفاتورة الكلّي** قبل الضريبة (lineTotal − taxAmt).
 *  - `invoiceDateLocal`: تاريخ الفاتورة بمنطقة الشركة. `originalInvoiceNumber`: مرجع الإشعار.
 * وبلا لقطة الفوترة الإلكترونية ورمز QR (لا يلزمان المستقبِل) وبلا صور منتجات البنود.
 */
export function invoicePayloadRow(inv: ErpInvoiceInput, timeZone: string): Rec {
  const { einvoiceSnapshot: _snap, einvoiceQr: _qr, originalInvoice, items, ...rest } = inv as ErpInvoiceInput & { einvoiceSnapshot?: unknown; einvoiceQr?: unknown };
  void _snap; void _qr;
  const incl = inv.pricesIncludeTax === true;
  return {
    ...rest,
    payloadVersion: 3,
    invoiceDateLocal: localDateIn(inv.invoiceDate, timeZone),
    // الوعاء الخاضع للضريبة — صحيح في الوضعين (الإجمالي ناقص الضريبة)
    taxableBase: roundHalfUp(inv.total - inv.taxAmt, 3),
    originalInvoiceNumber: originalInvoice?.number ?? null,
    items: items.map((it) => invoiceItemPayloadRow(it, incl)),
  };
}

export interface ErpReceiptInput extends Rec {
  receiptDate: Date | string;
  paymentMethod?: string | null;
  paymentMethodKey?: string | null;
  invoiceItems?: { invoiceId: string; amount: number; invoice?: { number: string } | null }[];
}

/**
 * السند مع الفواتير التي دُفع مقابلها (allocations) وتاريخه المحلي — بلا كائنات الفواتير كاملة.
 * «إدارة طرق الدفع»: paymentMethod يبقى الأساس المحاسبي (CASH/POS/…)، ويُضاف اسم الطريقة كما تعرفها الشركة لحظة التصدير:
 * paymentMethodLabel دائماً (اسم الشركة وإلا الافتراضي بالعربية)، وpaymentMethodCompanyLabel اسم الشركة وحده أو null —
 * فيُبقي مستقبِلٌ له وسومه (Odoo) وسمَه حين لم تسمِّ الشركة شيئاً. الإعداد null = الأسماء الافتراضية.
 */
export function receiptPayloadRow(r: ErpReceiptInput, timeZone: string, methods: PaymentMethodsConfigV1 | null = null): Rec {
  const { invoiceItems, ...rest } = r;
  const method = resolvePaymentMethod(methods, r.paymentMethod ?? null, r.paymentMethodKey ?? null);
  return {
    ...rest,
    paymentMethodLabel: method.label,
    paymentMethodCompanyLabel: method.companyLabel,
    // الصيغة القديمة باقية لمستقبِلٍ عام يقرؤها (ERP غير Odoo) — بأرقام الفواتير لا كائناتها كاملة
    invoiceItems: (invoiceItems ?? []).map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, invoice: a.invoice ? { number: a.invoice.number } : null })),
    receiptDateLocal: localDateIn(r.receiptDate, timeZone),
    allocations: (invoiceItems ?? []).map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: a.invoice?.number ?? null, amount: a.amount })),
  };
}

export function erpEnvelope(resource: ErpResource | 'ping', data: readonly unknown[], now = new Date()) {
  return { source: 'field-sales', resource, exportedAt: now.toISOString(), count: data.length, data };
}

// ═══ ردّ المستقبِل ═══

export interface ErpChunkResult {
  ok: boolean;
  httpStatus: number;
  created: number;
  updated: number;
  /** وصلت كما هي (فاتورة مُرحَّلة في Odoo لم تتغيّر) — ليست خطأ */
  unchanged: number;
  errors: number;
  errorDetails: { id: string | null; error: string }[];
  message: string;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * يقرأ ردّ المستقبِل: غير 2xx أو {ok:false} ⇒ فشل؛ و2xx بجسم Odoo ⇒ أعداد المنشأ والمحدَّث والأخطاء وتفاصيلها
 * (كانت المزامنة تُسجَّل «نجحت» ولو رفض Odoo صفوفاً)؛ و2xx بغير JSON (ERP عام) ⇒ نجاح بلا تفاصيل.
 */
export function parseErpResponse(httpStatus: number, text: string): ErpChunkResult {
  const base = { httpStatus, created: 0, updated: 0, unchanged: 0, errors: 0, errorDetails: [] as { id: string | null; error: string }[] };
  if (httpStatus < 200 || httpStatus >= 300) {
    let detail = text;
    try { const j = JSON.parse(text); if (j && typeof j.error === 'string') detail = j.error; } catch { /* نصّ خام */ }
    return { ...base, ok: false, message: `فشل ERP ${httpStatus}${detail ? ` - ${detail.slice(0, 300)}` : ''}` };
  }
  let body: Rec | null = null;
  try { body = JSON.parse(text) as Rec; } catch { body = null; }
  if (!body || typeof body !== 'object') return { ...base, ok: true, message: 'تمت المزامنة' };
  if (body.ok === false) return { ...base, ok: false, message: `رفض ERP: ${String(body.error ?? 'خطأ غير معروف').slice(0, 300)}` };
  const details = Array.isArray(body.error_details)
    ? (body.error_details as Rec[]).map((e) => ({ id: e?.id == null ? null : String(e.id), error: String(e?.error ?? '') }))
    : [];
  return {
    ...base, ok: true,
    created: num(body.created), updated: num(body.updated), unchanged: num(body.unchanged), errors: num(body.errors), errorDetails: details,
    message: 'تمت المزامنة',
  };
}

export interface ErpRunTotals { sent: number; created: number; updated: number; unchanged?: number; errors: number; errorDetails: { id: string | null; error: string }[]; failed: string | null }

/** حالة التشغيل ورسالته: فشل نقلٍ ⇒ FAILED؛ أخطاء صفوف ⇒ PARTIAL (لا يُقدَّم المؤشر)؛ وإلا SUCCESS */
export function summarizeErpRun(t: ErpRunTotals): { status: 'SUCCESS' | 'PARTIAL' | 'FAILED'; message: string } {
  const counts = `أُرسل ${t.sent}، أُنشئ ${t.created}، حُدّث ${t.updated}${t.unchanged ? `، بلا تغيير ${t.unchanged}` : ''}`;
  const firstErrors = t.errorDetails.slice(0, 5).map((e) => `${e.id ? e.id.slice(0, 8) : '—'}: ${e.error}`).join(' | ');
  if (t.failed) return { status: 'FAILED', message: `${t.failed}${t.sent ? ` (${counts} قبل الفشل)` : ''}`.slice(0, 1000) };
  if (t.errors > 0) return { status: 'PARTIAL', message: `${counts}، وتعذّر ${t.errors}: ${firstErrors}`.slice(0, 1000) };
  return { status: 'SUCCESS', message: t.sent ? `تمت المزامنة: ${counts}` : 'لا جديد منذ آخر مزامنة' };
}

/** الرابط: https وحده (المفتاح يُرسل في الترويسة)، وبلا اسم مستخدم/كلمة مرور فيه */
export function erpUrlProblem(raw: string | null | undefined): string | null {
  if (!raw) return 'رابط ERP مطلوب';
  let u: URL;
  try { u = new URL(raw); } catch { return 'رابط ERP غير صالح'; }
  if (u.protocol !== 'https:') return 'رابط ERP يجب أن يبدأ بـ https:// — المفتاح يُرسل مع كل طلب';
  if (u.username || u.password) return 'لا تضع اسم المستخدم أو كلمة المرور داخل الرابط — استعمل حقول المصادقة';
  if (u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local') || u.hostname.endsWith('.internal')) {
    return 'رابط ERP يشير إلى شبكة داخلية — غير مسموح';
  }
  return null;
}
