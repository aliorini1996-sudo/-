/**
 * builder فواتير المبيعات (DESIGN.md §5.5 P1 وP2 وP3 وP4، §2.2، §4.4 سطر العلامة، §5.2 الحمولة).
 *
 * صرف بلا I/O: يأخذ حمولة الحدث الثابتة وسياق البناء ويعيد MoveDraft أو NO_MOVE.
 * - يُستعمل المخزَّن حرفياً (subtotal، discountAmt، taxAmt، total) دون إعادة حساب.
 * - الإيراد والخصم يُوزَّعان على مجموعات (حساب، ضريبة) بأوزان البنود (§2.2).
 * - ضريبة كل نسبة = Σ item.taxAmt، وإن خالف المجموع taxAmt (فاتورة قديمة) يُوزَّع taxAmt بأكبر الباقي.
 * - الفرق المتبقي: ضمن حد التقريب ⇒ 421009، وإلا ⇒ 911001 مع needsAttention (لا رفض).
 * - فاتورة إجماليها صفر ⇒ NO_MOVE(ZERO_VALUE).
 *
 * «ربط الدفاتر» L4 (عقد L4+L5+L8 §4.2) — كله خلف `ctx.settings.linkedPosting === true`، وبدونه المخرج حرفاً كما كان:
 * (أ) آجلة بأقساط ⇒ سطر ذمة لكل قسط بمبلغه واستحقاقه (Σ = total بـdistributeMilli)؛
 * (ب) ساق النقد: الختم cashCollectedByRep مع مندوب ⇒ عهدة المندوب 111003، وغير المختومة بالقاعدة القائمة (OD2)؛
 * (ج) إيراد لكل صنف: مفتاح المجموعة (حساب، سلة ضريبة، productId) وسطر الإيراد يحمل productId وquantity (Σ baseQty)؛
 * (هـ) العكس من المستند: OD17 — سطور TAX/MARKER في فترة إقرار أخرى ⇒ vatAdjustment=true.
 */
import {
  noMove,
  type BuildContext, type BuildResult, type LineDraft, type LocalDate, type MappingKey, type Milli,
  type MoveDraft, type MoveType, type SourceEvent, type TaxRef, type VatCategory,
} from '../types';
import { distributeMilli, formatMilli, fromMilli, toMilli, unitMilli } from '../money';
import { sequencePrefixFor } from '../sequence';
import { applyReversalVatPeriod, reversalVatPeriodOf, type ReversalVatPeriod } from '../vat/period';

// ═══ الحمولة (§5.2) — المبالغ نصوص، وتُقبل الأرقام أيضاً ═══

export type InvoiceKind = 'CASH' | 'CREDIT' | 'RETURN';
export const INVOICE_KINDS: readonly InvoiceKind[] = ['CASH', 'CREDIT', 'RETURN'];

export interface InvoicePayloadItem {
  productId?: string | null;
  /** فئة المنتج لحظة الأثر ⇒ GlProductCategoryAccount.incomeAccountId */
  categoryId?: string | null;
  /**
   * الكمية **بوحدة البند** (`InvoiceItem.qty` كما طُبعت) لا بالأساس — تُضرب في `unitPrice` الذي هو لوحدة البند أيضاً
   * (الوحدات المتعددة: كرتونان × سعر الكرتون). `baseQty` لا يدخل هنا أبداً، وإلا ضُربت الحبّات بسعر الكرتون.
   */
  qty: number;
  /** سعر الوحدة كما خُزّن (شامل الضريبة متى pricesIncludeTax) — لوحدة البند */
  unitPrice: number;
  taxPct: number;
  taxAmt: string | number;
  /** صافي البند بعد كل خصم (شامل ضريبته) */
  lineTotal: string | number;
  /** مفتاح ضريبة صريح (حقول ZATCA لاحقاً: EXPORT، CIT_SALE…) — يتقدّم على الاشتقاق من النسبة */
  taxKey?: string | null;
  /** فئة ZATCA إن وُجدت (§2.2: تُقرأ بلا اعتماد صلب) */
  vatCategory?: VatCategory | null;
  /**
   * «ربط الدفاتر» L4 (للمربوطة، يُكتب حين يحمل قيمة): الكمية بوحدة الأساس = InvoiceItem.baseQty ?? qty × unitFactor —
   * كمية سطر الإيراد لكل صنف ومدخل محرّك التكلفة لاحقاً. لا يدخل الأوزان ولا المبالغ أبداً.
   */
  baseQty?: number | null;
  /** «ربط الدفاتر» L4: اسم الصنف لحظة الاشتقاق (itemName ?? product.name) — وصف سطر الإيراد لكل صنف */
  productName?: string | null;
}

/** «ربط الدفاتر» B2: قسط فاتورة آجلة (InvoiceInstallment) — المبلغ نصّ بمنازل العملة */
export interface InvoicePayloadInstallment {
  seq: number;
  dueDate: LocalDate;
  amount: string;
}

/** «ربط الدفاتر» L8: ما يُسقطه المستند من فاتورة أخرى — للمطابقة الجزئية وحدها، لا أثر له على سطور القيد */
export interface InvoiceAppliesTo {
  invoiceId: string;
  /** مرتجع المرحلة الأولى المرتبط: remainingApplied نصّاً؛ الإشعار الدائن: null (بحدّ المفتوح، D8) */
  amount: string | null;
}

export interface InvoicePayload {
  invoiceId: string;
  number?: string | null;
  type: InvoiceKind;
  customerId: string;
  customerName?: string | null;
  salesRepId?: string | null;
  salesRepName?: string | null;
  /** التاريخ المحلي لصف AccountEntry الأساسي (INVOICE_DEBIT، أو INVOICE_CREDIT للمرتجع) */
  entryDate: LocalDate;
  dueDate?: LocalDate | null;
  pricesIncludeTax: boolean;
  subtotal: string | number;
  discountAmt: string | number;
  taxAmt: string | number;
  total: string | number;
  currency: string;
  currencyDecimals: number;
  items: readonly InvoicePayloadItem[];
  /**
   * «إزالة الضريبة»: الفاتورة مختومة بلا ضريبة (Invoice.taxFree — صدرت والشركة غير مسجّلة) ⇒ خارج الإقرار: بنودها الصفرية بلا
   * مفتاح ضريبة ولا سطر علامة (MARKER) ولا «0٪» في الوصف. غائبٌ (كل حمولة قبل الميزة وكل فاتورة بضريبتها) ⇒ المسار كما كان
   */
  taxFree?: boolean;
  // ── «ربط الدفاتر» L4: حقول اختيارية تُكتب للمربوطة وحدها وحين تحمل قيمة (عقد §3.2/§4.2) — الغائب = سلوك اليوم ──
  /** OD2: الفاتورة النقدية مختومة «حصّلها المندوب» (Invoice.cashCollectedByRep) — true وحده يُكتب */
  cashCollectedByRep?: boolean;
  /** B2: أقساط الآجلة (≥1) بالترتيب */
  installments?: readonly InvoicePayloadInstallment[];
  /** D9/B1: dueDate مشتقّ (entryDate + paymentDays) لا مخزَّن — true وحده يُكتب */
  dueDateDerived?: boolean;
  /** L8: المرتجع المرتبط أو الإشعار الدائن ⇒ الفاتورة التي يُسقط منها */
  appliesTo?: InvoiceAppliesTo | null;
}

/**
 * نقطة توصيل COGS (عقد §9، للدفعة اللاحقة بعد L3 — لا تُستدعى الآن): مدخل builders/cogs.ts لحدث INVOICE:<id>:COGS.
 * ⚠️ الفاتورة الصفرية (NO_MOVE(ZERO_VALUE) أدناه) ستُصدر حدث COGS مستقلاً رغم أن لا قيد إيراد لها (B13: البضاعة المجانية
 * والعيّنات تخرج من المخزون بتكلفتها) — فلا يُشترط وجود قيد INVOICE:POST لترحيل تكلفتها.
 */
export interface CogsHookInput {
  invoiceId: string;
  items: readonly { productId: string | null; baseQty: number | null }[];
}

export interface BuildInvoiceOptions {
  /** POST (افتراضي) أو REVERSE (P4: عكس من المستند حين يكون POST مشمولاً بالافتتاح، §5.4) */
  event?: Extract<SourceEvent, 'POST' | 'REVERSE'>;
  /** تاريخ قيد العكس = entryDate لصف العكس في AccountEntry — إلزامي مع REVERSE */
  reverseDate?: LocalDate;
  /**
   * عكسٌ جزئيّ لفاتورة نقدية (REVERSE وحده): يُبنى القيد بلا ساق النقدية فلا تُعكس، والذمة تبقى دائنةً بالإجمالي =
   * رصيد العميل الدائن. مصدره صفوف AccountEntry نفسها (INVOICE_CREDIT بلا RECEIPT_DEBIT) — ZATCA Z5.4 وقرار
   * المالك Q1: المندوب حصّل فعلاً فلا يُنقص من عهدته نقدٌ بيده.
   */
  keepCashLeg?: boolean;
}

// ═══ أدوات داخلية ═══

type AccountTarget = { accountId: string } | { accountKey: MappingKey };

interface TaxBucket {
  key: string;
  pct: number;
  /** ضريبة نشطة محلولة، أو null (نسبة بلا ضريبة: دولة 0٪ أو نسبة غير قالبية) */
  tax: TaxRef | null;
}

interface Group {
  target: AccountTarget;
  targetKey: string;
  bucket: TaxBucket;
  baseWeight: Milli;
  discWeight: Milli;
  netWeight: Milli;
  itemTaxMilli: Milli;
  /** «ربط الدفاتر» (ج): صنف المجموعة (null = بنود بلا صنف أو شركة غير مربوطة)، واسمه، وΣ كميته بالأساس */
  productId: string | null;
  productName: string | null;
  quantity: number;
}

const REASON_SEP = '؛ ';

/** كمية البند بالأساس لسطر الإيراد (ج): baseQty إن حمل قيمة، وإلا qty كما طُبعت */
function itemBaseQty(item: InvoicePayloadItem): number {
  const b = item.baseQty;
  if (typeof b === 'number' && Number.isFinite(b)) return b;
  const q = Number(item.qty);
  return Number.isFinite(q) ? q : 0;
}

/** جمع كميات عشرية بلا غبار طفو (0.1 + 0.2) — ستّ منازل تكفي لأي وحدة أساس */
function addQty(a: number, b: number): number {
  return Math.round((a + b) * 1e6) / 1e6;
}

/**
 * (أ) سطور الذمة لآجلة بأقساط: total يُوزَّع بأوزان مبالغ الأقساط (Σ = total حرفاً، وكل حصة بوحدة العملة)،
 * بترتيب seq، واستحقاق كل سطر = استحقاق قسطه. أوزانٌ كلها صفرية ⇒ توزيع متساوٍ (distributeMilli) فلا يضيع مبلغ.
 */
function installmentArShares(
  total: Milli, installments: readonly InvoicePayloadInstallment[], dec: number,
): { seq: number; dueDate: LocalDate; amount: Milli }[] {
  const ordered = [...installments].sort((a, b) => a.seq - b.seq);
  const shares = distributeMilli(total, ordered.map((i) => toMilli(i.amount, dec)), dec);
  return ordered.map((i, k) => ({ seq: i.seq, dueDate: i.dueDate, amount: shares[k] }));
}

function pctText(pct: number): string {
  return `${Number.isInteger(pct) ? pct : pct.toString()}٪`;
}

/** مفتاح الضريبة الآلية لنسبة غير قالبية (§4.4): 5 ⇒ AUTO_SALE_5، 7.5 ⇒ AUTO_SALE_7_5 */
export function autoSaleKey(pct: number): string {
  return `AUTO_SALE_${String(pct).replace('.', '_')}`;
}

function targetKeyOf(t: AccountTarget): string {
  return 'accountId' in t ? `id:${t.accountId}` : `key:${t.accountKey}`;
}

/** حل ضريبة البند (§4.4 «ربط سطور الفواتير القائمة بالضرائب») — النشطة وحدها. */
export function resolveInvoiceItemTax(item: InvoicePayloadItem, ctx: BuildContext): TaxRef | null {
  const pct = Number(item.taxPct) || 0;
  const active = (t: TaxRef | null): TaxRef | null => (t && t.isActive && t.use === 'SALE' && t.rate === pct ? t : null);
  if (item.taxKey) {
    const explicit = active(ctx.taxes.byKey(item.taxKey));
    if (explicit) return explicit;
  }
  if (pct === 0) {
    let key: string | null;
    if (item.vatCategory === 'E') key = 'E_SALE';
    else if (item.vatCategory === 'O') key = 'O_SALE';
    else key = ctx.settings.zeroRatedSalesTaxKey;
    return key ? active(ctx.taxes.byKey(key)) : null;
  }
  return active(ctx.taxes.byUseAndRate('SALE', pct)) ?? active(ctx.taxes.byKey(autoSaleKey(pct)));
}

/** أوزان البند (§2.2) بالملّي: الوعاء قبل الخصم، والخصم، والصافي بعد كل خصم. */
export function invoiceItemWeights(
  item: InvoicePayloadItem, pricesIncludeTax: boolean, decimals: number,
): { baseMilli: Milli; discMilli: Milli; netMilli: Milli } {
  const pct = Number(item.taxPct) || 0;
  const gross = toMilli(Number(item.qty) * Number(item.unitPrice), decimals);
  const baseMilli = pricesIncludeTax && pct > 0 ? toMilli((fromMilli(gross) * 100) / (100 + pct), 3) : gross;
  const netMilli = toMilli(item.lineTotal, decimals) - toMilli(item.taxAmt, decimals);
  return { baseMilli, discMilli: baseMilli - netMilli, netMilli };
}

function pushAmount(lines: LineDraft[], line: Omit<LineDraft, 'debitMilli' | 'creditMilli'>, amount: Milli, side: 'D' | 'C'): void {
  if (amount === 0n) return; // لا سطر 0/0 غير علامة (I1)
  // مبلغ سالب (نادر: توزيع فاتورة قديمة) يُقلب إلى الجانب المقابل (I2)
  const onDebit = (side === 'D') === (amount > 0n);
  const abs = amount < 0n ? -amount : amount;
  lines.push({ ...line, debitMilli: onDebit ? abs : 0n, creditMilli: onDebit ? 0n : abs });
}

// ═══ الـbuilder ═══

/**
 * P1 (آجل) وP2 (نقدي) وP3 (مرتجع)، ومع event=REVERSE عكسها (P4) بقلب الجانبين وسالب الوعاء.
 * يرمي RangeError لحمولة غير صالحة (نوع مجهول، مبلغ غير عددي) — المُرحِّل يجعلها ERROR.
 */
export function buildInvoiceMove(payload: InvoicePayload, ctx: BuildContext, opts: BuildInvoiceOptions = {}): BuildResult {
  const event = opts.event ?? 'POST';
  if (!INVOICE_KINDS.includes(payload.type)) throw new RangeError(`نوع فاتورة غير معروف: ${String(payload.type)}`);
  if (event === 'REVERSE' && !opts.reverseDate) throw new RangeError('reverseDate إلزامي لعكس الفاتورة');

  const dec = payload.currencyDecimals;
  const total = toMilli(payload.total, dec);
  // COGS (عقد §9/B13، بعد L3): الصفرية لا قيد إيراد لها لكنها ستُصدر INVOICE:<id>:COGS مستقلاً (CogsHookInput أعلاه)
  if (total === 0n) return noMove('ZERO_VALUE', `فاتورة ${payload.number ?? payload.invoiceId} إجماليها صفر`);

  const subtotal = toMilli(payload.subtotal, dec);
  const discountAmt = toMilli(payload.discountAmt, dec);
  const taxAmt = toMilli(payload.taxAmt, dec);
  const s = ctx.settings;
  // «ربط الدفاتر» L4: كل سلوك جديد خلف هذا العلَم وحده (D1) — غيابه = المسار القائم حرفاً
  const linked = s.linkedPosting === true;
  const isReturn = payload.type === 'RETURN';
  const separate = s.postSalesDiscountSeparately;
  const ref = payload.number ?? null;
  const refText = ref ?? payload.invoiceId;
  const customerName = payload.customerName?.trim() || 'عميل';
  const repId = payload.salesRepId ?? null;
  const repName = payload.salesRepName?.trim() || 'مندوب';
  const analytic = repId ? ctx.repAnalytic(repId) : null;
  const attention: string[] = [];

  // ── المجموعات (حساب الإيراد، سلة الضريبة) بترتيب أول ظهور ──
  const buckets = new Map<string, TaxBucket>();
  const groups: Group[] = [];
  const groupIndex = new Map<string, Group>();
  const defaultTarget: AccountTarget = { accountKey: isReturn && s.postReturnsToContra ? 'SALES_RETURNS' : 'SALES_REVENUE' };

  const items = payload.items.length > 0 ? payload.items : null;
  if (!items) {
    const bucket: TaxBucket = { key: 'none', pct: 0, tax: null };
    groups.push({ target: defaultTarget, targetKey: targetKeyOf(defaultTarget), bucket,
      baseWeight: 1n, discWeight: 1n, netWeight: 1n, itemTaxMilli: 0n, productId: null, productName: null, quantity: 0 });
  } else {
    for (const item of items) {
      const pct = Number(item.taxPct) || 0;
      // «إزالة الضريبة»: بند صفري في فاتورة مختومة بلا ضريبة ⇒ سلّة 'none' بلا ضريبة (لا مفتاح ولا علامة ولا «0٪»)
      const free = payload.taxFree === true && pct === 0;
      const tax = free ? null : resolveInvoiceItemTax(item, ctx);
      const bKey = tax ? `tax:${tax.id}` : free ? 'none' : `pct:${pct}`;
      let bucket = buckets.get(bKey);
      if (!bucket) {
        bucket = { key: bKey, pct, tax };
        buckets.set(bKey, bucket);
      }
      let target: AccountTarget = defaultTarget;
      if (!(isReturn && s.postReturnsToContra) && item.categoryId) {
        const incomeId = ctx.categoryAccounts(item.categoryId)?.incomeAccountId;
        if (incomeId) target = { accountId: incomeId };
      }
      const tKey = targetKeyOf(target);
      // (ج) المربوطة: الصنف جزءٌ من مفتاح المجموعة (بند بلا صنف ⇒ مجموعة productId=null)؛ غيرها كما كان
      const productId = linked ? (item.productId || null) : null;
      const gKey = linked ? `${tKey}|${bKey}|${productId === null ? '-' : `p:${productId}`}` : `${tKey}|${bKey}`;
      let g = groupIndex.get(gKey);
      if (!g) {
        g = { target, targetKey: tKey, bucket, baseWeight: 0n, discWeight: 0n, netWeight: 0n, itemTaxMilli: 0n,
          productId, productName: null, quantity: 0 };
        groupIndex.set(gKey, g);
        groups.push(g);
      }
      if (productId !== null) {
        g.quantity = addQty(g.quantity, itemBaseQty(item));
        const name = item.productName?.trim();
        if (!g.productName && name) g.productName = name;
      }
      const w = invoiceItemWeights(item, payload.pricesIncludeTax, dec);
      g.baseWeight += w.baseMilli;
      g.discWeight += w.discMilli;
      g.netWeight += w.netMilli;
      g.itemTaxMilli += toMilli(item.taxAmt, dec);
    }
  }

  // ── الإيراد والخصم لكل مجموعة (§2.2) ──
  let revenue: Milli[];
  let discount: Milli[];
  if (separate) {
    revenue = distributeMilli(subtotal, groups.map((g) => g.baseWeight), dec);
    discount = distributeMilli(discountAmt, groups.map((g) => g.discWeight), dec);
  } else {
    revenue = distributeMilli(subtotal - discountAmt, groups.map((g) => g.netWeight), dec);
    discount = groups.map(() => 0n);
  }

  // ── ضريبة كل سلة موجبة ──
  const bucketList = [...buckets.values()];
  const positive = bucketList.filter((b) => b.pct > 0);
  const bucketItemTax = positive.map((b) => groups.filter((g) => g.bucket === b).reduce((a, g) => a + g.itemTaxMilli, 0n));
  let bucketTax: Milli[] = bucketItemTax;
  if (positive.length > 0 && bucketItemTax.reduce((a, v) => a + v, 0n) !== taxAmt) {
    bucketTax = distributeMilli(taxAmt, bucketItemTax, dec); // فاتورة قديمة: توزيع taxAmt بأكبر الباقي
  }

  // جانب المبيعات الطبيعي: الإيراد والضريبة دائنان والذمة والخصم مدينان؛ المرتجع يقلبها
  const revSide: 'D' | 'C' = isReturn ? 'D' : 'C';
  const arSide: 'D' | 'C' = isReturn ? 'C' : 'D';
  const sign = isReturn ? -1n : 1n;
  const lines: LineDraft[] = [];

  // الذمة (113001) — دائماً بالإجمالي، بالعميل والمندوب
  const arLine: Omit<LineDraft, 'debitMilli' | 'creditMilli'> = {
    accountKey: 'AR_CONTROL',
    label: isReturn ? `ذمة مرتجع مبيعات ${refText}` : `ذمة فاتورة مبيعات ${refText}`,
    customerId: payload.customerId, salesRepId: repId, partnerName: customerName,
    dueDate: isReturn ? null : (payload.dueDate ?? payload.entryDate),
  };
  if (linked && payload.type === 'CREDIT' && payload.installments && payload.installments.length > 0) {
    // (أ) B2: سطر لكل قسط بمبلغه واستحقاقه — Σ = total، والمطابقة الجزئية (L8) تُسقط الأقدم استحقاقاً أولاً
    for (const share of installmentArShares(total, payload.installments, dec)) {
      pushAmount(lines, { ...arLine, label: `${arLine.label} — قسط ${share.seq}`, dueDate: share.dueDate }, share.amount, arSide);
    }
  } else {
    pushAmount(lines, arLine, total, arSide);
  }

  // الإيراد والخصم لكل مجموعة
  const bucketNet = new Map<TaxBucket, Milli>();
  const outVatAccount = ctx.accounts.byKey('OUTPUT_VAT');
  const outVatActive = !!outVatAccount && outVatAccount.isActive;
  groups.forEach((g, i) => {
    const tax = g.bucket.tax;
    // نسبة موجبة غير قالبية مع ضريبة مخرجات نشطة ⇒ AUTO_SALE_<pct> على سطور الوعاء أيضاً (§4.4)
    const taxTags: Pick<LineDraft, 'taxId' | 'taxCode' | 'taxRole'> = tax
      ? { taxId: tax.id, taxRole: 'BASE' }
      : g.bucket.pct > 0 && outVatActive ? { taxCode: autoSaleKey(g.bucket.pct), taxRole: 'BASE' } : {};
    const rateText = g.bucket.key === 'none' ? '' : ` — ${pctText(g.bucket.pct)}`;
    // (ج) المربوطة: الصنف في الوصف، وproductId على الإيراد والخصم، وquantity على الإيراد وحده (لا تُعدّ الكمية مرتين
    // في تقرير الأصناف). غير المربوطة: productId=null دائماً فلا مفتاح يُضاف والوصف كما كان حرفاً.
    const productText = g.productId !== null && g.productName ? ` — ${g.productName}` : '';
    const productTag: Pick<LineDraft, 'productId'> | Record<string, never> = g.productId !== null ? { productId: g.productId } : {};
    const quantityTag: Pick<LineDraft, 'quantity'> | Record<string, never> = g.productId !== null ? { quantity: g.quantity } : {};
    pushAmount(lines, {
      ...g.target,
      label: (isReturn ? (s.postReturnsToContra ? 'مردودات مبيعات' : 'عكس إيراد مبيعات مرتجعة') : 'إيراد مبيعات') + ` ${refText}${productText}${rateText}`,
      analyticAccountId: analytic, ...taxTags, ...productTag, ...quantityTag,
    }, revenue[i], revSide);
    pushAmount(lines, {
      accountKey: 'SALES_DISCOUNT',
      label: (isReturn ? 'عكس خصم مبيعات مرتجعة' : 'خصم مسموح به') + ` ${refText}${productText}${rateText}`,
      analyticAccountId: analytic, ...taxTags, ...productTag,
    }, discount[i], arSide);
    // الوعاء = صافي بنود النسبة بعد كل خصم (Σ lineTotal − taxAmt) لا فرق توزيعين منفصلين (بواقيهما تنتقل بين السلال)؛
    // بلا بنود: الوزن وهمي فيبقى subtotal − discountAmt
    bucketNet.set(g.bucket, (bucketNet.get(g.bucket) ?? 0n) + (items ? g.netWeight : revenue[i] - discount[i]));
  });

  // سطور الضريبة (TAX) للسلال الموجبة
  positive.forEach((b, i) => {
    const amount = bucketTax[i];
    const base = (bucketNet.get(b) ?? 0n) * sign;
    const adj = isReturn ? { vatAdjustment: true } : {};
    if (b.tax) {
      pushAmount(lines, {
        ...(b.tax.accountId ? { accountId: b.tax.accountId } : { accountKey: 'OUTPUT_VAT' as const }),
        label: `${b.tax.name} — ${refText}`,
        taxId: b.tax.id, taxRole: 'TAX', taxBaseMilli: base, vatBox: b.tax.vatBox, ...adj,
      }, amount, revSide);
      return;
    }
    if (amount === 0n) return;
    if (outVatActive) {
      // نسبة غير قالبية: AUTO_SALE_<pct> على 212001 بلا مربع، يُنشئها المُرحِّل ويُعلَّم في الفحوصات (§4.4)
      pushAmount(lines, {
        accountKey: 'OUTPUT_VAT',
        label: `ضريبة مبيعات ${pctText(b.pct)} (نسبة غير معرّفة) — ${refText}`,
        taxCode: autoSaleKey(b.pct), taxRole: 'TAX', taxBaseMilli: base, vatBox: null, ...adj,
      }, amount, revSide);
      attention.push(`نسبة ضريبة غير معرّفة ${pctText(b.pct)}`);
    } else {
      // دولة 0٪ أو حساب الضريبة مؤرشف: الضريبة إلى المعلّق 911001 مع تنبيه، لا رفض (§4.2)
      pushAmount(lines, {
        accountKey: 'POSTING_SUSPENSE',
        label: `ضريبة ${pctText(b.pct)} على شركة بلا ضريبة مخرجات — ${refText}`,
      }, amount, revSide);
      attention.push(`ضريبة بنسبة ${pctText(b.pct)} في شركة بلا ضريبة مخرجات نشطة — رُحّلت إلى المعلّق`);
    }
  });

  // سطور العلامة (MARKER) للسلال الصفرية النشطة (§4.4) — O_SALE لا يُصدر علامة
  for (const b of bucketList) {
    if (b.pct !== 0 || !b.tax || b.tax.vatCategory === 'O') continue;
    lines.push({
      ...(b.tax.accountId ? { accountId: b.tax.accountId } : { accountKey: 'OUTPUT_VAT' as const }),
      label: `وعاء ${b.tax.name} — ${refText}`,
      debitMilli: 0n, creditMilli: 0n,
      taxId: b.tax.id, taxRole: 'MARKER', taxBaseMilli: (bucketNet.get(b) ?? 0n) * sign, vatBox: b.tax.vatBox,
      ...(isReturn ? { vatAdjustment: true } : {}),
    });
  }

  // الفرق: total − (subtotal − discountAmt + tax المرحَّلة) — تقريب أو معلّق (§2.2)
  let diff = 0n;
  for (const l of lines) diff += l.debitMilli - l.creditMilli;
  if (diff !== 0n) {
    const count = BigInt(Math.min(5, Math.max(1, payload.items.length)));
    const tolerance = unitMilli(dec) * count;
    const abs = diff < 0n ? -diff : diff;
    const balance: Omit<LineDraft, 'debitMilli' | 'creditMilli'> = abs <= tolerance
      ? { accountKey: 'ROUNDING', label: `فروقات تقريب فاتورة ${refText}` }
      : { accountKey: 'POSTING_SUSPENSE', label: `فرق ترحيل فاتورة ${refText} (فاتورة غير متّزنة)` };
    if (abs > tolerance) attention.push(`فاتورة غير متّزنة بفرق ${formatMilli(diff, dec)}`);
    pushAmount(lines, balance, diff, 'C'); // diff موجب ⇒ دائن، سالب ⇒ مدين
  }

  // P2: النقدية — مدين الصندوق أو العهدة، دائن الذمة بالإجمالي (يطابق صفّي AccountEntry).
  // عكسٌ جزئيّ (keepCashLeg): لا ساق نقدية أصلاً فلا تُعكس — القيد يبقى متّزناً لأنّ الساق مغلقة على نفسها.
  const cashLeg = payload.type === 'CASH' && !(event === 'REVERSE' && opts.keepCashLeg === true);
  if (cashLeg) {
    // (ب) OD2/D5 للمربوطة: الختم مع مندوب يوجّه النقد لعهدته أياً كان الإعداد؛ غير المختومة بالإعداد احتياطاً كما كان
    const stamped = linked && payload.cashCollectedByRep === true && !!repId;
    const toCustody = stamped || (s.cashInvoiceRouting === 'CUSTODY' && !!repId);
    pushAmount(lines, toCustody
      ? { accountKey: 'REP_CUSTODY', label: `تحصيل نقدي لفاتورة ${refText} (عهدة المندوب)`, salesRepId: repId, partnerName: repName }
      : { accountKey: 'MAIN_CASH', label: `تحصيل نقدي لفاتورة ${refText}` }, total, 'D');
    pushAmount(lines, { accountKey: 'AR_CONTROL', label: `تحصيل نقدي لفاتورة مبيعات ${refText}`,
      customerId: payload.customerId, salesRepId: repId, partnerName: customerName }, total, 'C');
  }

  const moveType: MoveType = isReturn ? 'OUT_REFUND' : 'OUT_INVOICE';
  const journalCode = ctx.journals.bySystemKey('SALES')?.code ?? 'INV';
  const kindText = payload.type === 'CASH' ? 'فاتورة مبيعات نقدية' : payload.type === 'CREDIT' ? 'فاتورة مبيعات آجلة' : 'مرتجع مبيعات';

  const draft: MoveDraft = {
    kind: 'MOVE',
    journalCode,
    journalSystemKey: 'SALES',
    sequencePrefix: sequencePrefixFor(journalCode, moveType),
    moveType,
    origin: 'AUTO',
    date: payload.entryDate,
    ref,
    narration: `${kindText} ${refText} — ${customerName}`,
    needsAttention: attention.length > 0,
    attentionReason: attention.length > 0 ? attention.join(REASON_SEP) : null,
    customerId: payload.customerId,
    salesRepId: repId,
    sourceType: 'INVOICE',
    sourceId: payload.invoiceId,
    sourceKey: `INVOICE:${payload.invoiceId}:POST`,
    sourceEvent: 'POST',
    currencyCode: payload.currency,
    currencyDecimals: dec,
    lines,
  };
  if (event !== 'REVERSE') return draft;
  // (هـ) OD17 للمربوطة: الأصل بتاريخ مستنده (entryDate)، والعكس بتاريخه بعد إزاحة الإقفال التي سيطبّقها postMove(SHIFT)
  return linked
    ? invertInvoiceDraft(draft, opts.reverseDate as LocalDate, { ...reversalVatPeriodOf(ctx), originalDate: payload.entryDate })
    : invertInvoiceDraft(draft, opts.reverseDate as LocalDate);
}

/** OD17 على العكس من المستند: إعدادات الفترة وتاريخ الأصل (واختيارياً الإقفالات للتاريخ الفعلي) */
export type InvoiceReversalVat = ReversalVatPeriod & { originalDate: LocalDate };

/**
 * P4 من المستند: قلب الجانبين سطراً بسطر، والوعاء سالباً، والتاريخ = تاريخ صف العكس (§5.4).
 * مع `vat` («ربط الدفاتر» OD17): سطور TAX/MARKER ⇒ vatAdjustment = الأصل || فترة إقرار الأصل ≠ فترة العكس. الغائب ⇒ كما كان.
 */
export function invertInvoiceDraft(draft: MoveDraft, date: LocalDate, vat?: InvoiceReversalVat): MoveDraft {
  if (vat) return applyReversalVatPeriod(invertInvoiceDraft(draft, date), vat.originalDate, vat);
  return {
    ...draft,
    date,
    originalDate: null,
    lateArrival: false,
    narration: `عكس ${draft.narration}`,
    sourceKey: draft.sourceId ? `INVOICE:${draft.sourceId}:REVERSE` : draft.sourceKey,
    sourceEvent: 'REVERSE',
    lines: draft.lines.map((l) => ({
      ...l,
      label: `عكس ${l.label}`,
      debitMilli: l.creditMilli,
      creditMilli: l.debitMilli,
      ...(l.taxBaseMilli !== undefined && l.taxBaseMilli !== null ? { taxBaseMilli: -l.taxBaseMilli } : {}),
    })),
  };
}

/**
 * اشتقاق الحمولة الدنيا من صفوف الفاتورة (للمُطابِق M3) — المبالغ نصوص بمنازل العملة.
 * حقول «ربط الدفاتر» L4 (الختم والأقساط والاستحقاق المشتق وappliesTo، وفي البنود baseQty وproductName) اختيارية: تُكتب
 * حين تحمل قيمة وحدها، والمُستدعي (desired.ts، A1) يقرّر أنها للمربوطة. فبلا تمريرها الحمولة حرفاً كما كانت.
 */
export function invoicePayloadFromRows(input: {
  invoice: {
    id: string; number?: string | null; type: string; customerId: string; salesRepId?: string | null;
    pricesIncludeTax?: boolean | null; subtotal: number; discountAmt: number; taxAmt: number; total: number;
    /** «إزالة الضريبة»: Invoice.taxFree — يدخل الحمولة حين يكون true وحده، فحمولة الفاتورة بضريبتها حرفاً كما كانت */
    taxFree?: boolean | null;
    /** «ربط الدفاتر» OD2: Invoice.cashCollectedByRep — true وحده يُكتب (ويُقبل أيضاً في المستوى الأعلى) */
    cashCollectedByRep?: boolean | null;
  };
  items: readonly {
    productId?: string | null; categoryId?: string | null; qty: number; unitPrice: number;
    taxPct: number; taxAmt: number; lineTotal: number; vatCategory?: VatCategory | null;
    /** «ربط الدفاتر»: InvoiceItem.baseQty ?? qty × unitFactor — يُكتب حين يكون رقماً منتهياً */
    baseQty?: number | null;
    /** «ربط الدفاتر»: itemName ?? product.name — يُكتب حين لا يكون فارغاً */
    productName?: string | null;
  }[];
  customerName?: string | null;
  salesRepName?: string | null;
  entryDate: LocalDate;
  dueDate?: LocalDate | null;
  currency: string;
  currencyDecimals: number;
  // ── «ربط الدفاتر» L4 (للمربوطة، يمرّرها A1) ──
  cashCollectedByRep?: boolean | null;
  /** المبلغ رقماً (InvoiceInstallment.amount) أو نصاً؛ يُكتب نصاً بمنازل العملة، والقائمة مرتّبة بـseq (≥1 وإلا لا مفتاح) */
  installments?: readonly { seq: number; dueDate: LocalDate; amount: number | string }[] | null;
  dueDateDerived?: boolean | null;
  /** amount رقماً أو نصاً (remainingApplied)، أو null للإشعار الدائن */
  appliesTo?: { invoiceId: string; amount: number | string | null } | null;
}): InvoicePayload {
  const dec = input.currencyDecimals;
  const str = (v: number): string => formatMilli(toMilli(Number(v), dec), dec);
  // نصٌّ أو رقم ⇒ نصّ بمنازل العملة (التحليل الحرفي للنصوص بالقاعدة نفسها: نصف-لأعلى)
  const text = (v: number | string): string => (typeof v === 'string' ? formatMilli(toMilli(v, dec), dec) : str(v));
  const inv = input.invoice;
  if (!INVOICE_KINDS.includes(inv.type as InvoiceKind)) throw new RangeError(`نوع فاتورة غير معروف: ${inv.type}`);
  const stamped = inv.cashCollectedByRep === true || input.cashCollectedByRep === true;
  const installments = input.installments && input.installments.length > 0
    ? [...input.installments].sort((a, b) => a.seq - b.seq).map((i) => ({ seq: i.seq, dueDate: i.dueDate, amount: text(i.amount) }))
    : null;
  const appliesTo = input.appliesTo && input.appliesTo.invoiceId
    ? { invoiceId: input.appliesTo.invoiceId, amount: input.appliesTo.amount === null ? null : text(input.appliesTo.amount) }
    : null;
  return {
    invoiceId: inv.id,
    number: inv.number ?? null,
    type: inv.type as InvoiceKind,
    customerId: inv.customerId,
    customerName: input.customerName ?? null,
    salesRepId: inv.salesRepId ?? null,
    salesRepName: input.salesRepName ?? null,
    entryDate: input.entryDate,
    dueDate: input.dueDate ?? null,
    pricesIncludeTax: !!inv.pricesIncludeTax,
    subtotal: str(inv.subtotal),
    discountAmt: str(inv.discountAmt),
    taxAmt: str(inv.taxAmt),
    total: str(inv.total),
    currency: input.currency,
    currencyDecimals: dec,
    ...(inv.taxFree === true ? { taxFree: true } : {}),
    ...(stamped ? { cashCollectedByRep: true } : {}),
    ...(installments ? { installments } : {}),
    ...(input.dueDateDerived === true ? { dueDateDerived: true } : {}),
    ...(appliesTo ? { appliesTo } : {}),
    items: input.items.map((it) => {
      const productName = typeof it.productName === 'string' ? it.productName.trim() : '';
      return {
        productId: it.productId ?? null,
        categoryId: it.categoryId ?? null,
        qty: Number(it.qty),
        unitPrice: Number(it.unitPrice),
        taxPct: Number(it.taxPct),
        taxAmt: str(it.taxAmt),
        lineTotal: str(it.lineTotal),
        ...(it.vatCategory ? { vatCategory: it.vatCategory } : {}),
        ...(typeof it.baseQty === 'number' && Number.isFinite(it.baseQty) ? { baseQty: it.baseQty } : {}),
        ...(productName ? { productName } : {}),
      };
    }),
  };
}
