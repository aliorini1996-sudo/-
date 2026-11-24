// ============================================================================
// «تتبّع اللوط» — اختيار تشغيلة سطر البيع في نافذة «إنشاء فاتورة جديدة» (طلب المالك ٢ نوفمبر ٢٠٢٦).
// ----------------------------------------------------------------------------
// لكل سطر بيعٍ لصنفٍ متتبَّع ثلاثة أوضاع:
//   - «تلقائي» (الافتراضي، لا lotPick): لا يُرسل شيء ⇒ الخادم يوزّع FEFO من سيارة المندوب كما اليوم حرفياً.
//   - تشغيلةٌ واحدة (ONE): السطر كله منها — كميتها **تتبع كمية السطر ووحدته** (تُحسب عند الإرسال لا تُخزَّن).
//   - تقسيم (SPLIT): صفوفٌ بكميات أساسية يكتبها المستخدم — لا إعادة تحجيمٍ صامتة: تغيّر كمية السطر أو وحدته يُظهر الفرق
//     ويمنع الإصدار حتى يُصحَّح.
// الجسم مرآة parseLotRefsStrict (backend/src/services/lots.ts): items[i].lots = [{lotId, qty}] والمجموع = الكمية الأساسية
// للسطر (qty × معامل الوحدة). المصادر من لقطة سيارة المندوب (GET /van-stock/lot-balances): المسمّاة النشطة غير المنتهية
// وحدها تُختار، والمتاح لكل سطر بعد ما اختارته أسطر الصنف الأخرى (الخادم يجمع الطلب لكل (صنف، تشغيلة) — D26).
// طلب المالك ١٦ نوفمبر ٢٠٢٦ («لا مانع من أن يأخذ من LOT آخر في حال انتهت هذه التشغيلة»): التشغيلة المختارة «تُستعمل أولاً» لا
// «تُستعمل حتماً» — متاحها دون كمية السطر، أو صارت موقوفة أو منتهية، لا يمنع الإصدار؛ الخادم يأخذ ما فيها ويُكمل الباقي بالأقرب
// انتهاءً (explicitShort: 'SPILL') ويعيد تحذير LOT_EXPLICIT_FALLBACK. فالواجهة تنبّه (saleLotFallback) ولا تمنع إلا الشكل.
// كل كمية هنا **بوحدة الأساس** (D22).
// ============================================================================

import {
  LOT_BLOCK_KIND_LABELS, LOT_EPS, LOT_STATUS_LABELS, roundLot, toBaseQty, type LotErrorInfo, type LotRef, type VanLotSnapshotDto,
} from './lots';
import { lotErrorText, type LotErrorCtx } from './invoiceLots';
import {
  draftProblem, draftRefs, explicitFallback, isFourDecimals, newRowId, snapshotSourcesOf, sourceKey,
  type DraftProblem, type LotFallbackPlan, type LotRowDraft, type LotSource,
} from './stockLots';
import { factorOf } from './units';

/** قيمة «تقسيم على أكثر من تشغيلة» في منتقي السطر — لا تطابق معرّف تشغيلة */
export const SALE_LOT_SPLIT = '__split__';

export type SaleLotPick = { mode: 'ONE'; lotId: string } | { mode: 'SPLIT'; rows: LotRowDraft[] };

/** ما يلزم من سطر المحرّر — الكمية بوحدة السطر ومعاملها، واختيار التشغيلة (غائب = تلقائي) */
export interface SaleLotLine {
  productId: string;
  qty: number;
  unitFactor?: number | null;
  lotPick?: SaleLotPick | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** الكمية الأساسية للسطر (qty × معامل وحدته) — ما يقارن به الخادم مجموع الصفوف */
export function saleLineBaseQty(l: Pick<SaleLotLine, 'qty' | 'unitFactor'>): number {
  return toBaseQty({ qty: num(l.qty), unitFactor: l.unitFactor });
}

/**
 * صفوف التشغيلة الصريحة للسطر كما تُرسل — null = «تلقائي» (لا مفتاح lots في البند). الواحدة بكمية السطر الأساسية الآن،
 * والتقسيم بصفوفه كما كُتبت (draftRefs). سطرٌ بلا كمية لا صفوف له (الخادم يرفض الصفر أصلاً).
 */
export function saleLotRefs(l: SaleLotLine): LotRef[] | null {
  const p = l.lotPick;
  if (!p) return null;
  if (p.mode === 'ONE') {
    const base = saleLineBaseQty(l);
    return p.lotId && base > LOT_EPS ? [{ lotId: p.lotId, qty: roundLot(base) }] : null;
  }
  const refs = draftRefs(p.rows);
  return refs.length ? refs : null;
}

/**
 * يُلحق تشغيلات الأسطر ببنود جسم البيع (بالترتيب نفسه، والصنف شرطٌ ثانٍ فلا تنتقل تشغيلةٌ إلى بند صنفٍ آخر). سطرٌ «تلقائي»
 * أو صنفٌ غير متتبَّع ⇒ بنده **هو نفسه** بلا مفتاح؛ ولا اختيار في أي سطر ⇒ المصفوفة نفسها — جسم اليوم حرفاً.
 */
export function withSaleLots<T extends Record<string, unknown>>(
  items: T[],
  lines: readonly SaleLotLine[],
  tracked: (productId: string) => boolean,
): (T | (T & { lots: LotRef[] }))[] {
  if (items.length !== lines.length) return items;
  let touched = false;
  const next = items.map((it, i) => {
    const line = lines[i];
    if (it.productId !== line.productId || !tracked(line.productId)) return it;
    const lots = saleLotRefs(line);
    if (!lots) return it;
    touched = true;
    return { ...it, lots };
  });
  return touched ? next : items;
}

/** ما اختارته **أسطر الصنف الأخرى** صراحةً من كل تشغيلة (بالأساس) — «تلقائي» لا يُحسب (الخادم يوزّعه مما بقي) */
export function pickedByOtherLines(lines: readonly SaleLotLine[], idx: number): Map<string, number> {
  const out = new Map<string, number>();
  const pid = lines[idx]?.productId;
  lines.forEach((l, j) => {
    if (j === idx || l.productId !== pid) return;
    for (const r of saleLotRefs(l) ?? []) {
      if (r.lotId === null) continue;
      out.set(r.lotId, roundLot((out.get(r.lotId) ?? 0) + r.qty));
    }
  });
  return out;
}

/** تشغيلةٌ تُختار للبيع: نشطة، لم تنتهِ يوم اللقطة */
export const saleLotEligible = (s: LotSource): boolean => s.lotId !== null && s.status === 'ACTIVE' && !s.expired;
/** تشغيلةٌ يُفتح خيارها في المنتقي: صالحةٌ للبيع **وبقي فيها شيء** بعد أسطر الصنف الأخرى (مراجعة D5: «متاح 0» لا يُختار) */
export const saleLotPickable = (s: LotSource): boolean => saleLotEligible(s) && s.usable > LOT_EPS;

/**
 * مصادر السطر من لقطة السيارة: التشغيلات **المسمّاة** (غير المسمّى خارج الاختيار — يبقى للتلقائي) والمتاح لكلٍّ بعد ما
 * اختارته أسطر الصنف الأخرى (لا يقلّ عن صفر). `all` للعرض (الموقوفة والمنتهية معطّلة)، و`eligible` ما يُختار ويُفحص به.
 * بلا لقطة ⇒ null (لا فحص متاحٍ في الواجهة؛ الخادم يحكم).
 */
export function saleLotSources(
  snap: VanLotSnapshotDto | null | undefined,
  lines: readonly SaleLotLine[],
  idx: number,
): { all: LotSource[]; eligible: LotSource[] } | null {
  const line = lines[idx];
  if (!snap || !line) return null;
  const others = pickedByOtherLines(lines, idx);
  const all = snapshotSourcesOf(snap, line.productId)
    .filter((s) => s.lotId !== null)
    .map((s) => ({ ...s, usable: Math.max(0, roundLot(s.usable - (others.get(s.lotId!) ?? 0))) }));
  return { all, eligible: all.filter(saleLotEligible) };
}

/**
 * مشكلة السطر: مشكلات المسوّدة (draftProblem) ورمزان للبيع —
 *  - LOT_BASE_DECIMALS: الكمية الأساسية للسطر أدقّ من أربع خانات (الخادم يردّ كل سطرٍ متتبَّع بها LOT_QTY_INVALID) — لا «المجموع».
 *  - LOT_NOT_SELLABLE: باقٍ في النوع لنصّه وحده — لم يعد يُنتج (طلب المالك ١٦ نوفمبر ٢٠٢٦: الموقوفة والمنتهية تُكمَل من غيرها).
 */
export type SaleLotProblem = DraftProblem | 'LOT_NOT_SELLABLE' | 'LOT_BASE_DECIMALS';
const DRAFT_PROBLEMS: readonly string[] = ['LOT_SOURCE_MISSING', 'LOT_SOURCE_DUPLICATE', 'LOT_OVER_SOURCE', 'LOT_QTY_INVALID'];
/** مشكلةٌ يفهمها محرّر الصفوف المشترك (LotRowsEditor) — رمزا البيع يُعرضان بنصّهما خارجه */
export const asDraftProblem = (p: SaleLotProblem | null | undefined): DraftProblem | null =>
  (p && DRAFT_PROBLEMS.includes(p) ? (p as DraftProblem) : null);

/**
 * ما **يمنع** إصدار السطر (null = يُرسل): الشكل وحده — كمية السطر الأساسية بأربع خانات (LOT_BASE_DECIMALS)، ثم draftProblem
 * بلا مصادر: مصدرٌ لكل صف بلا تكرار، وأربع خانات، والمجموع = الكمية الأساسية للسطر (LOT_QTY_INVALID). أما تشغيلةٌ متاحها دون
 * صفّها أو صارت موقوفة أو منتهية فلم تعد مشكلة (طلب المالك ١٦ نوفمبر ٢٠٢٦): الخادم يُكمل الباقي من غيرها — saleLotFallback ينبّه.
 * «تلقائي» أو سطرٌ واحدٌ بلا كمية ⇒ null.
 */
export function saleLotProblem(l: SaleLotLine): SaleLotProblem | null {
  const p = l.lotPick;
  if (!p) return null;
  const base = saleLineBaseQty(l);
  if (p.mode === 'ONE' && base <= LOT_EPS) return null;
  if (base > LOT_EPS && !isFourDecimals(base)) return 'LOT_BASE_DECIMALS';
  if (p.mode === 'ONE') {
    return draftProblem([{ key: 'one', source: p.lotId ? sourceKey(p.lotId) : '', qty: String(base) }], base, null);
  }
  return draftProblem(p.rows, base, null);
}

/** مشكلات كل الأسطر بترتيبها (null لسطرٍ سليم أو «تلقائي» أو غير متتبَّع) — لحجب الإصدار برسالة السطر الأول */
export function saleLotProblems(
  lines: readonly SaleLotLine[],
  _snap: VanLotSnapshotDto | null | undefined,
  tracked: (productId: string) => boolean,
): (SaleLotProblem | null)[] {
  return lines.map((l) => (l.lotPick && tracked(l.productId) ? saleLotProblem(l) : null));
}

/**
 * تنبيه «يُكمَل من غيرها» لسطرٍ اختار تشغيلته (طلب المالك ١٦ نوفمبر ٢٠٢٦): ما تعطيه التشغيلات المختارة وسبب نقص كلٍّ منها
 * (نفدت SHORT، منتهية EXPIRED، موقوفة BLOCKED) والباقي ومعاينة إكماله بالأقرب انتهاءً من تشغيلات السيارة الأخرى ثم غير المسمّى
 * (allowUnknown اللقطة) — بعد ما اختارته أسطر الصنف الأخرى. `short` = الصنف كله لا يكفي (الخادم يردّ 409 كالتلقائي).
 * null = «تلقائي»، أو بلا لقطة، أو مشكلة شكلٍ تمنع أصلاً، أو تكفي المختارة.
 */
export function saleLotFallback(
  lines: readonly SaleLotLine[],
  snap: VanLotSnapshotDto | null | undefined,
  idx: number,
): LotFallbackPlan | null {
  const l = lines[idx];
  if (!l?.lotPick || !snap || saleLotProblem(l)) return null;
  const s = saleLotSources(snap, lines, idx);
  if (!s) return null;
  const unnamed = snapshotSourcesOf(snap, l.productId).filter((x) => x.lotId === null);
  return explicitFallback(saleLotRefs(l), [...s.all, ...unnamed], { allowUnknown: snap.allowUnknown === true, unitFactor: l.unitFactor });
}

/**
 * تقسيمٌ مبدئي حين يختار المستخدم «تقسيم»: يبدأ بالتشغيلة المختارة إن كانت، ثم المصادر بترتيبها (FEFO) حتى تكتمل الكمية.
 * وسطرٌ بوحدةٍ أكبر (`unitFactor` > 1) يأخذ **كراتين كاملة** من كل تشغيلة أولاً ثم الباقي — مرآة takeOrdered في الخادم (D22)
 * فلا يقترح التقسيم كرتوناً مشقوقاً كان «تلقائي» سيبقيه سليماً (مراجعة D1). صفٌّ واحد لكل تشغيلة.
 */
export function initialSplitRows(
  base: number, eligible: readonly LotSource[], fromLotId?: string | null, unitFactor?: number | null,
): LotRowDraft[] {
  const order = [
    ...eligible.filter((s) => s.lotId === fromLotId),
    ...eligible.filter((s) => s.lotId !== fromLotId),
  ];
  const taken = new Map<LotSource, number>();
  let left = roundLot(Math.max(0, base));
  const availOf = (s: LotSource) => roundLot(s.usable - (taken.get(s) ?? 0));
  const take = (s: LotSource, q: number) => { taken.set(s, roundLot((taken.get(s) ?? 0) + q)); left = roundLot(left - q); };
  const F = factorOf({ unitFactor });
  if (F > 1) {
    for (const s of order) {
      if (left <= LOT_EPS) break;
      const k = Math.floor((Math.min(availOf(s), left) + LOT_EPS) / F);
      if (k > 0) take(s, Math.abs(k * F - left) <= LOT_EPS ? left : roundLot(k * F));
    }
  }
  for (const s of order) {
    if (left <= LOT_EPS) break;
    const q = roundLot(Math.min(left, availOf(s)));
    if (q <= LOT_EPS) continue;
    take(s, q);
  }
  const rows: LotRowDraft[] = [];
  for (const s of order) {
    const q = taken.get(s);
    if (q && q > LOT_EPS) rows.push({ key: newRowId('s'), source: sourceKey(s.lotId), qty: String(q) });
  }
  if (!rows.length) rows.push({ key: newRowId('s'), source: '', qty: String(roundLot(Math.max(0, base))) });
  return rows;
}

/**
 * ما يعرضه منتقي السطر: القائمة حين وصلت اللقطة (`ready`)؛ وقبلها أو بتعذّرها «تلقائي» نصّاً — إلا سطراً اختيرت تشغيلته قبل
 * ذلك (عودةٌ من المرتجع بعد أن سقطت اللقطة من الذاكرة، أو تعذّر إعادة جلبها): اختياره قائمٌ ويُرسل (والخادم يحكم)، فيُقال ذلك
 * ويُعاد إلى «تلقائي» بزرّ — لا «تلقائي» على الشاشة وفي الجسم lots (مراجعة ٢ نوفمبر ٢٠٢٦).
 */
export function saleLotView(ready: boolean, pick: SaleLotPick | null | undefined): 'SELECT' | 'AUTO_ONLY' | 'PICK_KEPT' {
  if (ready) return 'SELECT';
  return pick ? 'PICK_KEPT' : 'AUTO_ONLY';
}

/** يمحو اختيارات التشغيلة (تغيّر المندوب: تشغيلات سيارةٍ أخرى لا معنى لها) — المصفوفة نفسها إن لم يكن فيها اختيار */
export function clearSaleLotPicks<L extends SaleLotLine>(lines: L[]): { lines: L[]; cleared: number } {
  const cleared = lines.filter((l) => !!l.lotPick).length;
  if (!cleared) return { lines, cleared: 0 };
  return { lines: lines.map((l) => (l.lotPick ? { ...l, lotPick: undefined } : l)), cleared };
}

/**
 * أسطر المحرّر التي يخصّها خطأ لوطٍ من الخادم: `line` (فهرس البند — الصرامة لكل سطر)، أو `lines` (أسطر الصنف — من التوزيع)
 * مضيَّقةً إلى ما اختار `lotId` المذكور إن وُجد، وإلا أسطر `productId`. الفهرس = موضع البند في الجسم = موضع السطر.
 */
export function lotErrorLineIdx(info: LotErrorInfo | null | undefined, lines: readonly SaleLotLine[]): number[] {
  const d = info?.detail ?? {};
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < lines.length;
  if (ok(d.line)) return [d.line];
  let idx: number[] = Array.isArray(d.lines) ? (d.lines as unknown[]).filter(ok) : [];
  if (!idx.length && typeof d.productId === 'string') {
    idx = lines.map((l, i) => (l.productId === d.productId ? i : -1)).filter((i) => i >= 0);
  }
  if (typeof d.lotId === 'string') {
    const lotId = d.lotId;
    const narrowed = idx.filter((i) => (saleLotRefs(lines[i]) ?? []).some((r) => r.lotId === lotId));
    if (narrowed.length) return narrowed;
  }
  // نقص الصنف بلا تشغيلة (insufficient) يخصّ **كل** أسطر الصنف: باقي السطر الصريح يُكمَل مع «تلقائي» من المتاح نفسه (طلب المالك
  // ١٦ نوفمبر ٢٠٢٦، SPILL) — لم يعد الصريح مخدوماً كاملاً قبلها فيُستثنى (كان مراجعة D8)
  return idx;
}

/**
 * نصّ خطأ لوطٍ من الخادم لبيعٍ بتشغيلةٍ صريحة، بلغة الواجهة (مراجعة D4): الموقوفة والمنتهية وغير الموجودة ومن صنفٍ آخر، وكمية
 * السطر (أربع خانات أو المجموع) — رسالة الخادم عربيةٌ ثابتة فلا تُعرض كما هي. رقم التشغيلة من التفاصيل أو من `lotNumberOf`
 * (لقطة السيارة: LOT_BLOCKED لا يحمله). وما سواها lotErrorText المشترك (والنقص فيه بالتشغيلة ومتاحها، D2).
 */
export function saleLotErrorText(
  info: LotErrorInfo, tr: (ar: string) => string, ctx: LotErrorCtx = {},
): string {
  const d = info.detail ?? {};
  const lotId = typeof d.lotId === 'string' ? d.lotId : null;
  const num = (typeof d.lotNumber === 'string' && d.lotNumber) || (lotId ? ctx.lotNumberOf?.(lotId) : null) || '';
  const withNum = (s: string) => (num ? `${s}: ${num}` : s);
  if (info.code === 'LOT_BLOCKED') {
    const kind = d.blockKind === 'HOLD' || d.blockKind === 'RECALL' ? LOT_BLOCK_KIND_LABELS[d.blockKind] : LOT_STATUS_LABELS.BLOCKED;
    return `${withNum(tr('التشغيلة موقوفة لا تباع'))} · ${tr(kind)}`;
  }
  if (info.code === 'LOT_EXPIRED') return withNum(tr('التشغيلة منتهية لا تباع'));
  if (info.code === 'LOT_NOT_FOUND' || info.code === 'LOT_PRODUCT_MISMATCH') return withNum(tr('التشغيلة غير موجودة لهذا الصنف'));
  if (info.code === 'LOT_QTY_INVALID' && d.decimals != null) return tr('كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بوحدة الأساس');
  if (info.code === 'LOT_QTY_INVALID' && (d.line != null || d.sum != null)) return tr('مجموع كميات التشغيلات يجب أن يساوي كمية السطر بوحدة الأساس');
  return lotErrorText(info, tr, ctx);
}

/**
 * كمية أساسية نصّاً بوحدة السطر حين تنقسم عليها تماماً («3 كرتون»)، وإلا بوحدة الأساس («25 حبة») — للمتاح في المنتقي.
 * `fmt` منسّق الرقم.
 */
export function lotQtyInLineUnit(
  base: number,
  line: { unitFactor?: number | null; unit?: string | null },
  baseUnit: string | null | undefined,
  fmt: (n: number) => string = (n) => String(Number(roundLot(n).toFixed(4))),
): string {
  const f = factorOf({ unitFactor: line.unitFactor });
  const b = roundLot(Math.max(0, num(base)));
  const inLine = b / f;
  if (f > 1 && Math.abs(inLine - Math.round(inLine)) <= 1e-9 && line.unit) return `${fmt(Math.round(inLine))} ${line.unit}`;
  return baseUnit ? `${fmt(b)} ${baseUnit}` : fmt(b);
}
