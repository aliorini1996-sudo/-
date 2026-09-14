// ============================================================================
// ZATCA المرحلة الثانية (Z1) — مبالغ مستند UBL: الوضع الحصري والوضع الشامل
// ----------------------------------------------------------------------------
// المرجع: design §3 Z1 «Amount algorithm» + [XML §10]. كل مساواة تفحصها الهيئة تُحسب بهللات
// صحيحة (BigInt). والقيم التي **يقرّرها المحرّك** (ما يدفعه العميل) تُؤخذ من المحرّك نفسه لا من
// نموذجٍ له — انظر «قيم المحرّك» أدناه. لا عدد عائم في أي مبلغ آخر.
//
// ═══ الوضع الحصري (لوحة الإدارة و/m) — مطابق حرفياً لـ lib/invoiceCalc.ts ═══
//  1. base_i = r2(qty×price) ؛ خصم البند = r2(base_i×d/100) بصيغة Base+Multiplier.
//  2. BT-131_i = base_i − خصم البند.
//  3. خصم الفاتورة H: هدف واحد r2(ΣBT-131×H/100) يوزَّع بأكبر الباقي؛ ولكل نسبة
//     ضريبية خصم مستند مستقل = مجموع حصص بنودها (BR-32).
//  4. taxable_R = Σ صافي البنود ، tax_R = r2(taxable_R×R/100) ⇒ BR-CO-17 تامّة.
//  5. KSA-11_i = حصة البند من tax_R ، KSA-12_i = BT-131_i + KSA-11_i (BR-KSA-51).
//
// ═══ الوضع الشامل (كل فواتير المندوب) ═══
//  1. G_i = r2(qty×P_i) ، N_i = G_i − r2(G_i×d/100) (من المحرّك)؛ ما يدفعه العميل = ΣN_i.
//  2. لكل نسبة R>0: G_R = ΣN_i ، t0 = r2(G_R×100/(100+R)) ، ونختار T_R من {t0−1,t0,t0+1}
//     الأقرب لـ G_R = T + r2(T×R/100)؛ الفرق residual_R يُحمَّل على PayableRoundingAmount.
//  3. T_R وtax_R يوزَّعان على البنود بنسبة N_i بأكبر الباقي (أعداد صحيحة).
//  4. سعر الوحدة يُحلّ عكسياً: أقصر عشري (2..8 خانات) يحقق r2(qty×Price) = B_i.
//     بلا خصم بند: B_i = BT-131_i. ومع خصم بند: B_i = max(r2(G_i×100/(100+R)), BT-131_i)،
//     وخصمٌ مبلغاً فقط A_i = B_i − BT-131_i (يُحذف إن كان صفراً) ⇒ r2(qty×Price) − A_i = BT-131_i.
//     ⚠️ انحراف موثّق عن نص التصميم (B = r2(BT-131/(1−d))): BT-131 مقرَّب وموزَّع (±هللة)، وتلك
//     الصيغة تضخّم خطأه بعامل 100/(100−d) — 50 هللة للوحدة عند 99% — فيقفز السعر الصافي المكتوب
//     قرب 100% (100.00 عند 99.99% و86.96 عند 100%). الاشتقاق من G_i غير المقرَّب بعد الخصم يُبقي
//     الخطأ نحو هللة أياً كان الخصم ويزيل الانقطاع عند 100%.
//  5. الفئات الصفرية Z/E/O: T=G وtax=0 (رمز الإعفاء يُلحقه mapInvoice).
//  6. BT-115 = BT-112 + BT-114 = ΣN_i (السعر المعلن). UNVERIFIED(U5): قبول BT-114 لهذا الغرض — design §6.2.
//
// ═══ قيم المحرّك: لماذا لا نحاكيه بحساب دقيق ═══
//  lib/money.ts:roundHalfUp يطبّق toPrecision(12) على العدد العائم الثنائي value×100 ثم يقرّب:
//  (أ) لذلك أثر مقصود: سعر مشتقّ بقسمة عائمة (lineTotal÷الكمية) مثل 7972.333333333333 × 7.305
//      قيمته المقصودة 58237.895 فيقرّبها المحرّك إلى .90، والضرب الدقيق لتمثيله العشري يعطي .89.
//  (ب) وحين يكون للناتج الدقيق 13 رقماً معنوياً آخرها 5 (1.0029 × 10023.9655 = 10053.03499995)
//      يقع العائم تحت نقطة القصّ أو فوقها بحسب ضجيجه، فيخالف أيُّ نموذج دقيق المحرّكَ في بعضها
//      (المحرّك 10053.03، والقصّ الدقيق ثم نصف-لأعلى 10053.04).
//  لذا الأساس وخصم البند وهدف خصم الفاتورة وحصصه وضريبة النسبة وحصصها تُحسب في engineLines/
//  engineBucketTax باستدعاء roundHalfUp وdistributeAmount من lib/money على **نفس التعابير العائمة
//  وبنفس الترتيب** في computeInvoiceTotals، ثم تُحوَّل هللاتٍ. واختبار المطابقة الحرفية يحرس أي تعديل
//  لاحق على المحرّك. وكل مساواة تتحقق منها الهيئة حرفياً تبقى دقيقة: السعر يُحلّ عكسياً إن لم يطابق
//  الضربُ الدقيق، وخصم Base×Multiplier يُكتب مبلغاً فقط إن اختلف، وضريبة نسبة يخالف فيها عائمُ المحرّك
//  التقريبَ الدقيق ترمي خطأ بدل مخالفة صامتة — ولا يقع ذلك ما دام (الوعاء بالهللات × النسبة) دون 10^12
//  لنسبة صحيحة (أي ناتج دقيق ≤ 12 رقماً معنوياً، فيستعيده toPrecision(12) حرفياً).
//  الحدّ الأعلى المدعوم 10^12 هللة لأي مبلغ (فوقه يقصّ toPrecision(12) خانات صحيحة).
//
// ═══ برهان |residual_R| ≤ 0.01 (وأنه ≥ 0 بقاعدة الاختيار هنا) لكل 0 < R ≤ 100 ═══
//  لتكن f(T) = T + round(T·R/100) بالهللات (round نصف-لأعلى).
//  (أ) الخطوة: T·R/100 تزيد R/100 ≤ 1 لكل هللة، و floor(x+½+δ)−floor(x+½) ∈ {0,1} لـ 0≤δ≤1،
//      إذن f(T+1) − f(T) ∈ {1, 2}: f صارمة التزايد ولا تقفز فوق أكثر من قيمة واحدة.
//  (ب) الوجود: f(0)=0 ≤ G، فليكن T1 = max{T ≥ 0 : f(T) ≤ G}. من (أ) f(T1+1) ≤ f(T1)+2 وf(T1+1) > G
//      ⇒ G − f(T1) ∈ {0, 1}.
//  (ج) الموضع: أي T يحقق |G − f(T)| ≤ 1 يحقق |G − T(1+ρ)| ≤ 1.5 (ρ=R/100، لأن خطأ round ≤ ½)
//      ⇒ |T − G/(1+ρ)| ≤ 1.5/(1+ρ) < 1.5 ، و|t0 − G/(1+ρ)| ≤ ½ ⇒ |T − t0| < 2 ⇒ T ∈ {t0−1,t0,t0+1}.
//  (د) الاختيار: نأخذ أصغر |residual| وعند التعادل غير السالب — وهذا هو T1 بالضبط (مرشّحان بنفس
//      |residual| لا بد أن يكونا بإشارتين مختلفتين لأن f صارمة التزايد). إذن residual ∈ {0, 0.01}.
//  (هـ) الدورية (R صحيح): round((T+100)R/100) = round(TR/100) + R و t0(G+100+R) = t0(G) + 100،
//      فبواقي G و G+(100+R) متطابقة؛ الفحص الشامل لدورة واحدة يغطي كل G ≥ 0. الاختبار يفحص
//      شاملاً مدى أكبر بكثير من الدورة ويتحقق من الدورية نفسها على عيّنة عشوائية.
//  ⚠️ انحراف موثّق عن نص التصميم («فضّل t0 عند التعادل»): نفضّل البقية غير السالبة لأن
//      BR-KSA-F-04 تطلب مبالغ موجبة؛ يختلف الاختيار عن t0 فقط حين تقفز f هللتين فوق G.
// ============================================================================

import { distributeAmount, roundHalfUp } from '../../lib/money';
import {
  Dec, decFromNumber, decNormalize, divRoundHalfUp, formatDec, formatHalalas, formatUnits, pow10,
} from './decimal';
import { UblDocument, UblLine, VatCategory, VAT_CATEGORIES, ZatcaInputError, ZatcaIssue } from './model';

export interface AmountLineInput {
  qty: number;
  unitPrice: number;   // صافٍ في الوضع الحصري، شامل الضريبة في الوضع الشامل
  discountPct: number;
  vatPct: number;      // مُحلَّلة مسبقاً (item.taxPct ?? companyVat)
  category: VatCategory;
}

export interface AmountInput {
  pricesIncludeTax: boolean;
  invoiceDiscountPct: number;
  lines: AmountLineInput[];
}

export type AmountLineResult = Omit<UblLine, 'id' | 'name' | 'unitCode' | 'vat'>;
export type AmountResult = Pick<UblDocument, 'docAllowances' | 'subtotals' | 'totals'> & { lines: AmountLineResult[] };

/** تتبّع داخلي بالهللات — للاختبارات (مطابقة المحرّك) ولحفظ Z5. */
export interface AmountTrace {
  mode: 'exclusive' | 'inclusive';
  bases: bigint[];          // الحصري: r2(qty×price) · الشامل: G_i
  lineDiscounts: bigint[];  // خصم البند (بعملة الإدخال)
  headShares: bigint[];     // حصة خصم الفاتورة (الشامل: أصفار)
  nets: bigint[];           // الحصري: صافي البند بعد كل خصم · الشامل: N_i (ما يدفعه العميل)
  lineExtensions: bigint[]; // BT-131
  lineTaxes: bigint[];      // KSA-11
  buckets: Array<{ category: VatCategory; percent: string; indexes: number[]; gross: bigint; taxable: bigint; tax: bigint; residual: bigint; t0: bigint }>;
}

/** سبب الخصم المكتوب في الـXML (كما في عيّنات الـSDK). */
export const DISCOUNT_REASON = 'discount';

/** أقصى مبلغ مدعوم بالهللات (10 مليارات ريال): فوقه يقصّ toPrecision(12) في المحرّك خانات صحيحة. */
export const MAX_SUPPORTED_HALALAS = 10n ** 12n;

/** أقصى خانات سعر الوحدة المحلول. UNVERIFIED(U5): الخانات المسموحة لـ PriceAmount — design §6.2. */
export const PRICE_MAX_SCALE = 8;

// ─────────────────────────────────────────────────────────────────────────────
// لبنات عامة (مصدَّرة للاختبار)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * توزيع مبلغ صحيح على أوزان بأكبر الباقي — المجموع = الهدف بالضبط.
 * الأوزان ≤ 0 تأخذ صفراً. الترتيب: الباقي الأكبر ثم الفهرس الأصغر.
 * (للوضع الشامل وحده؛ توزيعات المحرّك في الحصري تُؤخذ من distributeAmount نفسه.)
 */
export function largestRemainder(total: bigint, weights: bigint[]): bigint[] {
  if (total < 0n) throw new RangeError('largestRemainder: الهدف سالب');
  const out = weights.map(() => 0n);
  let sum = 0n;
  for (const w of weights) if (w > 0n) sum += w;
  if (sum === 0n || total === 0n) return out;
  const rems: bigint[] = weights.map(() => 0n);
  let given = 0n;
  const idx: number[] = [];
  weights.forEach((w, i) => {
    if (w <= 0n) return;
    const p = w * total;
    out[i] = p / sum;
    rems[i] = p % sum;
    given += out[i];
    idx.push(i);
  });
  let left = total - given; // < عدد الأوزان الموجبة
  idx.sort((a, b) => (rems[a] !== rems[b] ? (rems[a] > rems[b] ? -1 : 1) : a - b));
  for (let k = 0; k < idx.length && left > 0n; k++, left--) out[idx[k]] += 1n;
  return out;
}

/**
 * يقسم إجمالياً شاملاً (هللات) على نسبة R>0 إلى وعاء وضريبة وبقية تقريب (انظر البرهان أعلاه).
 * لـ R = 0: الوعاء = الإجمالي.
 */
export function splitInclusive(gross: bigint, rate: Dec): { taxable: bigint; tax: bigint; residual: bigint; t0: bigint } {
  if (gross < 0n) throw new RangeError('splitInclusive: إجمالي سالب');
  if (rate.units < 0n) throw new RangeError('splitInclusive: نسبة سالبة');
  if (rate.units === 0n) return { taxable: gross, tax: 0n, residual: 0n, t0: gross };
  const den = 100n * pow10(rate.scale); // R/100 = units/den
  const t0 = divRoundHalfUp(gross * den, den + rate.units);
  let best: { taxable: bigint; tax: bigint; residual: bigint } | null = null;
  for (const T of [t0, t0 - 1n, t0 + 1n]) {
    if (T < 0n) continue;
    const tax = divRoundHalfUp(T * rate.units, den);
    const residual = gross - T - tax;
    if (best === null) { best = { taxable: T, tax, residual }; continue; }
    const ab = residual < 0n ? -residual : residual;
    const bb = best.residual < 0n ? -best.residual : best.residual;
    if (ab < bb || (ab === bb && residual >= 0n && best.residual < 0n)) best = { taxable: T, tax, residual };
  }
  return { ...best!, t0 };
}

/**
 * أقصر سعر وحدة (2..8 خانات) يحقق r2(qty × price) = target (هللات) بالضبط.
 * الشرط لمقياس ps: (2L−1)·10^(qs+ps) ≤ 200·qu·Pu < (2L+1)·10^(qs+ps).
 * يكفي فحص round(المركز) و round(المركز)−1 (نصف المجال مفتوح من اليمين).
 * للكمية ≤ 10^6 يوجد حلّ دائماً عند 8 خانات؛ وإلا يُعاد الأقرب مع exact=false
 * (يُتوقَّع تحذير BR-KSA-EN16931-11 الذي خفّضته SDK 3.2.1 — design §3 Z1 inclusive 4).
 */
export function solvePrice(qty: Dec, target: bigint, maxScale = PRICE_MAX_SCALE): { text: string; exact: boolean } {
  if (target < 0n) throw new RangeError('solvePrice: هدف سالب');
  if (qty.units < 0n) throw new RangeError('solvePrice: كمية سالبة');
  if (qty.units === 0n) return { text: '0.00', exact: target === 0n };
  const two = 2n * target;
  for (let ps = 2; ps <= maxScale; ps++) {
    const den = pow10(qty.scale + ps);
    const center = divRoundHalfUp(target * den, 100n * qty.units);
    for (const cand of [center, center - 1n]) {
      if (cand < 0n) continue;
      const v = 200n * qty.units * cand;
      if ((two - 1n) * den <= v && v < (two + 1n) * den) return { text: formatUnits(cand, ps), exact: true };
    }
  }
  const den = pow10(qty.scale + maxScale);
  return { text: formatUnits(divRoundHalfUp(target * den, 100n * qty.units), maxScale), exact: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// التحقق من المُدخلات
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedLine { q: Dec; p: Dec; d: Dec; r: Dec; category: VatCategory }

const HUNDRED: Dec = { units: 100n, scale: 0 };

function inRange(x: Dec, min: Dec, max: Dec | null): boolean {
  const s = Math.max(x.scale, min.scale, max ? max.scale : 0);
  const v = x.units * pow10(s - x.scale);
  if (v < min.units * pow10(s - min.scale)) return false;
  return !(max && v > max.units * pow10(s - max.scale));
}

function parseInput(input: AmountInput): { lines: ParsedLine[]; head: Dec } {
  const issues: ZatcaIssue[] = [];
  const zero: Dec = { units: 0n, scale: 0 };
  const num = (v: unknown, field: string, label: string, max: Dec | null): Dec | null => {
    try {
      const d = decFromNumber(v as number);
      if (inRange(d, zero, max)) return d;
    } catch { /* يُسجَّل أدناه */ }
    issues.push({ rule: 'INPUT', field, messageAr: `${label} غير صالحة (${String(v)})`, severity: 'error' });
    return null;
  };
  const lines: ParsedLine[] = [];
  (input.lines ?? []).forEach((l, i) => {
    const n = i + 1;
    const q = num(l.qty, `items[${i}].qty`, `الكمية في البند ${n}`, null);
    const p = num(l.unitPrice, `items[${i}].unitPrice`, `سعر الوحدة في البند ${n}`, null);
    const d = num(l.discountPct ?? 0, `items[${i}].discountPct`, `نسبة خصم البند ${n}`, HUNDRED);
    const r = num(l.vatPct, `items[${i}].taxPct`, `نسبة ضريبة البند ${n}`, HUNDRED);
    if (!VAT_CATEGORIES.includes(l.category)) {
      issues.push({ rule: 'BR-KSA-18', field: `items[${i}].vatCategory`, messageAr: `فئة الضريبة في البند ${n} غير صالحة (المسموح S أو Z أو E أو O)`, severity: 'error' });
    }
    if (q && p && d && r) lines.push({ q, p, d, r: decNormalize(r), category: l.category });
  });
  const head = num(input.invoiceDiscountPct ?? 0, 'discountPct', 'نسبة خصم الفاتورة', HUNDRED);
  if (issues.length) throw new ZatcaInputError('AMOUNT_INPUT', issues);
  return { lines, head: head! };
}

function bucketize(lines: ParsedLine[]) {
  const map = new Map<string, { category: VatCategory; rate: Dec; percent: string; indexes: number[] }>();
  lines.forEach((l, i) => {
    const percent = formatDec(l.r, 2); // 15 و15.00 نسبة واحدة [XML §8.4]
    const key = `${l.category}|${percent}`;
    let b = map.get(key);
    if (!b) { b = { category: l.category, rate: l.r, percent, indexes: [] }; map.set(key, b); }
    b.indexes.push(i);
  });
  return [...map.values()]; // ترتيب أول ظهور
}

/** r2(a×b) دقيق. */
const exactProduct = (a: Dec, b: Dec) => divRoundHalfUp(a.units * b.units * 100n, pow10(a.scale + b.scale));
/** r2(مبلغ×نسبة/100) دقيق — المبلغ بالهللات. */
const exactPct = (amount: bigint, pct: Dec) => divRoundHalfUp(amount * pct.units, 100n * pow10(pct.scale));
const sumOf = (xs: bigint[]) => xs.reduce((s, v) => s + v, 0n);

const unsupported = (field: string) => new ZatcaInputError('AMOUNT_INPUT', [{
  rule: 'INPUT', field, messageAr: 'مبلغ الفاتورة يتجاوز الحدّ المدعوم (10 مليارات ريال)', severity: 'error',
}]);

/** لا يمكن مطابقة المحرّك والهيئة معاً — نرفض قبل أي ICV بدل مخالفة صامتة. */
const engineConflict = (rule: string, messageAr: string) => new ZatcaInputError('ENGINE_ROUNDING_CONFLICT', [{
  rule, field: 'items', messageAr, severity: 'error',
}]);

function assertSupported(values: bigint[], field: string) {
  if (values.some(v => v >= MAX_SUPPORTED_HALALAS)) throw unsupported(field);
}

// ─────────────────────────────────────────────────────────────────────────────
// قيم المحرّك — computeInvoiceTotals بنفس التعابير العائمة ونفس دوال lib/money (decimals = 2)
// ─────────────────────────────────────────────────────────────────────────────

/** ناتج roundHalfUp/distributeAmount (مضاعف هللة عائم) → هللات صحيحة. */
function halalasOf(x: number, field: string): bigint {
  const h = Math.round(x * 100);
  if (!Number.isSafeInteger(h)) throw unsupported(field);
  return BigInt(h);
}

interface EngineLines {
  bases: bigint[];         // r2(qty×price)
  lineDiscounts: bigint[]; // r2(base×d/100)
  afterDisc: bigint[];     // base − خصم البند
  headTarget: bigint;      // r2(Σ afterDisc × H/100)
  headShares: bigint[];    // distributeAmount(headTarget, afterDisc)
  nets: bigint[];          // afterDisc − حصة خصم الفاتورة
  netsF: number[];         // nets كما يحملها المحرّك عائمةً — مُدخل تعبير ضريبة النسبة
}

/** المرحلتان 1–2 من computeInvoiceTotals حرفياً ثم بالهللات، مع التحقق من الثوابت التي يُبنى عليها المستند. */
function engineLines(lines: AmountLineInput[], invoiceDiscountPct: number): EngineLines {
  const r2 = (v: number) => roundHalfUp(v, 2);
  const basesF = lines.map(l => r2(l.qty * l.unitPrice));
  const bases = basesF.map(v => halalasOf(v, 'items'));
  assertSupported([...bases, sumOf(bases)], 'items');
  const lineDiscF = lines.map((l, i) => r2((basesF[i] * (l.discountPct ?? 0)) / 100));
  const afterDiscF = basesF.map((b, i) => r2(b - lineDiscF[i]));
  const afterDiscSum = afterDiscF.reduce((s, v) => s + v, 0);
  const headTargetF = r2((afterDiscSum * invoiceDiscountPct) / 100);
  const headSharesF = distributeAmount(headTargetF, afterDiscF, 2);
  const netsF = afterDiscF.map((v, i) => r2(v - headSharesF[i]));

  const e: EngineLines = {
    bases,
    lineDiscounts: lineDiscF.map(v => halalasOf(v, 'items')),
    afterDisc: afterDiscF.map(v => halalasOf(v, 'items')),
    headTarget: halalasOf(headTargetF, 'discountPct'),
    headShares: headSharesF.map(v => halalasOf(v, 'discountPct')),
    nets: netsF.map(v => halalasOf(v, 'items')),
    netsF,
  };
  // دون الحدّ المدعوم تتحقق هذه دائماً (كل قيمة ≤ 12 رقماً معنوياً فيستعيدها toPrecision(12))؛
  // وعليها تقوم BR-KSA-EN16931-11 وBR-CO-11/13 — فأي خرق يُرفض بدل مستند غير متّسق.
  const ok = sumOf(e.headShares) === e.headTarget && bases.every((b, i) =>
    e.lineDiscounts[i] >= 0n && e.afterDisc[i] === b - e.lineDiscounts[i]
    && e.headShares[i] >= 0n && e.nets[i] === e.afterDisc[i] - e.headShares[i] && e.nets[i] >= 0n);
  if (!ok) throw engineConflict('BR-KSA-EN16931-11', 'تعذّر حساب صافي البنود بدقة متوافقة — راجع الدعم الفني');
  return e;
}

/** المرحلة 3 من computeInvoiceTotals لنسبة واحدة حرفياً: ضريبتها وحصص بنودها بالهللات. */
function engineBucketTax(netsF: number[], idxs: number[], pct: number): { tax: bigint; shares: bigint[] } {
  if (pct <= 0) return { tax: 0n, shares: idxs.map(() => 0n) };
  const bucketBase = idxs.reduce((s, i) => s + netsF[i], 0);
  const bucketTax = roundHalfUp((bucketBase * pct) / 100, 2);
  const shares = distributeAmount(bucketTax, idxs.map(i => netsF[i]), 2);
  return { tax: halalasOf(bucketTax, 'items'), shares: shares.map(v => halalasOf(v, 'items')) };
}

// ─────────────────────────────────────────────────────────────────────────────
// الحساب
// ─────────────────────────────────────────────────────────────────────────────

export function computeUblAmountsDetailed(input: AmountInput): { result: AmountResult; trace: AmountTrace } {
  const { lines, head } = parseInput(input);
  return input.pricesIncludeTax ? inclusive(input, lines, head) : exclusive(input, lines);
}

export function computeUblAmounts(input: AmountInput): AmountResult {
  return computeUblAmountsDetailed(input).result;
}

function exclusive(input: AmountInput, lines: ParsedLine[]): { result: AmountResult; trace: AmountTrace } {
  const eng = engineLines(input.lines ?? [], input.invoiceDiscountPct ?? 0);
  const { bases, lineDiscounts, afterDisc, headTarget, headShares, nets } = eng;

  const lineTaxes = lines.map(() => 0n);
  const buckets = bucketize(lines).map(b => {
    const taxable = sumOf(b.indexes.map(i => nets[i]));
    // نسبة الفئة كعدد كما يستعملها المحرّك مفتاحاً (15 و15.00 عدد واحد)
    const { tax, shares } = engineBucketTax(eng.netsF, b.indexes, input.lines[b.indexes[0]].vatPct);
    if (tax !== exactPct(taxable, b.rate) || sumOf(shares) !== tax) {
      // BR-CO-17 تُفحص بالتقريب الدقيق؛ عائم المحرّك خالفه هنا فلا يمكن مطابقة الاثنين
      throw engineConflict('BR-CO-17', `تعذّر حساب ضريبة النسبة ${b.percent}% بدقة متوافقة — راجع الدعم الفني`);
    }
    b.indexes.forEach((i, k) => { lineTaxes[i] = shares[k]; });
    const allowance = sumOf(b.indexes.map(i => headShares[i]));
    return { ...b, gross: sumOf(b.indexes.map(i => afterDisc[i])), taxable, tax, residual: 0n, t0: taxable, allowance };
  });

  const resultLines: AmountLineResult[] = lines.map((l, i) => {
    const p = decNormalize(l.p);
    // السعر كما أُدخل إن حقق BR-KSA-EN16931-11 بالضرب الدقيق وبخانات مقبولة؛ وإلا يُحلّ عكسياً للأساس
    const priceAmount = p.scale <= PRICE_MAX_SCALE && exactProduct(l.q, p) === bases[i] ? formatDec(p, 2) : solvePrice(l.q, bases[i]).text;
    const line: AmountLineResult = {
      quantity: formatDec(l.q, 6),
      priceAmount,
      lineExtension: formatHalalas(afterDisc[i]),
      taxAmount: formatHalalas(lineTaxes[i]),
      roundingAmount: formatHalalas(afterDisc[i] + lineTaxes[i]),
    };
    if (lineDiscounts[i] > 0n) {
      const d = decNormalize(l.d);
      // BR-KSA-DEC-01: النسبة بخانتين كحدّ أقصى، وBR-KSA-EN16931-03 بالضرب الدقيق؛ غير ذلك يُكتب الخصم مبلغاً فقط
      line.allowance = d.scale <= 2 && exactPct(bases[i], d) === lineDiscounts[i]
        ? { amount: formatHalalas(lineDiscounts[i]), reason: DISCOUNT_REASON, baseAmount: formatHalalas(bases[i]), multiplier: formatDec(d, 2) }
        : { amount: formatHalalas(lineDiscounts[i]), reason: DISCOUNT_REASON };
    }
    return line;
  });

  const lineExtension = sumOf(afterDisc);
  const taxTotal = sumOf(buckets.map(b => b.tax));
  const taxExclusive = lineExtension - headTarget;
  const result: AmountResult = {
    docAllowances: buckets.filter(b => b.allowance > 0n).map(b => ({
      amount: formatHalalas(b.allowance), category: b.category, percent: b.percent, reason: DISCOUNT_REASON,
    })),
    subtotals: buckets.map(b => ({ taxable: formatHalalas(b.taxable), tax: formatHalalas(b.tax), category: b.category, percent: b.percent })),
    totals: {
      lineExtension: formatHalalas(lineExtension),
      taxExclusive: formatHalalas(taxExclusive),
      taxInclusive: formatHalalas(taxExclusive + taxTotal),
      allowanceTotal: formatHalalas(headTarget),
      prepaid: formatHalalas(0n),
      payable: formatHalalas(taxExclusive + taxTotal),
      taxTotal: formatHalalas(taxTotal),
    },
    lines: resultLines,
  };
  const trace: AmountTrace = {
    mode: 'exclusive', bases, lineDiscounts, headShares, nets, lineExtensions: afterDisc, lineTaxes,
    buckets: buckets.map(({ category, percent, indexes, gross, taxable, tax, residual, t0 }) => ({ category, percent, indexes, gross, taxable, tax, residual, t0 })),
  };
  return { result, trace };
}

function inclusive(input: AmountInput, lines: ParsedLine[], head: Dec): { result: AmountResult; trace: AmountTrace } {
  if (head.units !== 0n) {
    throw new ZatcaInputError('INCLUSIVE_HEAD_DISCOUNT', [{
      rule: 'ZATCA_INCLUSIVE_HEAD_DISCOUNT', field: 'discountPct',
      messageAr: 'خصم الفاتورة الكلّي غير مسموح على أسعار شاملة الضريبة في المرحلة الثانية — استعمل خصم البند', severity: 'error',
    }]);
  }
  // G_i وخصم البند وN_i = G_i − خصمه كما يحسبها المحرّك (خصم الفاتورة صفر ⇒ nets = afterDisc)
  const { bases, lineDiscounts, nets } = engineLines(input.lines ?? [], 0);
  const lineExtensions = lines.map(() => 0n);
  const lineTaxes = lines.map(() => 0n);

  const buckets = bucketize(lines).map(b => {
    const bucketNets = b.indexes.map(i => nets[i]);
    const gross = sumOf(bucketNets);
    const split = splitInclusive(gross, b.rate);
    const netShares = largestRemainder(split.taxable, bucketNets);
    const taxShares = largestRemainder(split.tax, bucketNets);
    b.indexes.forEach((i, k) => { lineExtensions[i] = netShares[k]; lineTaxes[i] = taxShares[k]; });
    return { ...b, gross, ...split };
  });
  const rateOf = new Map<number, Dec>();
  buckets.forEach(b => b.indexes.forEach(i => rateOf.set(i, b.rate)));

  const resultLines: AmountLineResult[] = lines.map((l, i) => {
    const net = lineExtensions[i];
    let base = net;
    if (lineDiscounts[i] > 0n) {
      // الخطوة 4: B = max(r2(G_i × 100/(100+R)), BT-131) — من الإجمالي قبل الخصم لا من BT-131 المقرَّب
      const r = rateOf.get(i)!;
      const den = 100n * pow10(r.scale);
      const grossNet = divRoundHalfUp(bases[i] * den, den + r.units);
      if (grossNet > net) base = grossNet;
    }
    const allowanceAmt = base - net;
    const line: AmountLineResult = {
      quantity: formatDec(l.q, 6),
      priceAmount: solvePrice(l.q, base).text,
      lineExtension: formatHalalas(net),
      taxAmount: formatHalalas(lineTaxes[i]),
      roundingAmount: formatHalalas(net + lineTaxes[i]),
    };
    // مبلغ فقط (بلا Base/Multiplier) فلا تنطبق BR-KSA-EN16931-03
    if (allowanceAmt > 0n) line.allowance = { amount: formatHalalas(allowanceAmt), reason: DISCOUNT_REASON };
    return line;
  });

  const lineExtension = sumOf(lineExtensions);
  const taxTotal = sumOf(buckets.map(b => b.tax));
  const rounding = sumOf(buckets.map(b => b.residual));
  const taxInclusive = lineExtension + taxTotal;
  const totals: AmountResult['totals'] = {
    lineExtension: formatHalalas(lineExtension),
    taxExclusive: formatHalalas(lineExtension),
    taxInclusive: formatHalalas(taxInclusive),
    allowanceTotal: formatHalalas(0n),
    prepaid: formatHalalas(0n),
    payable: formatHalalas(taxInclusive + rounding),
    taxTotal: formatHalalas(taxTotal),
  };
  if (rounding !== 0n) totals.payableRounding = formatHalalas(rounding);
  const result: AmountResult = {
    docAllowances: [],
    subtotals: buckets.map(b => ({ taxable: formatHalalas(b.taxable), tax: formatHalalas(b.tax), category: b.category, percent: b.percent })),
    totals,
    lines: resultLines,
  };
  const trace: AmountTrace = {
    mode: 'inclusive', bases, lineDiscounts, headShares: lines.map(() => 0n), nets, lineExtensions, lineTaxes,
    buckets: buckets.map(({ category, percent, indexes, gross, taxable, tax, residual, t0 }) => ({ category, percent, indexes, gross, taxable, tax, residual, t0 })),
  };
  return { result, trace };
}

