// ============================================================================
// «تتبّع اللوط» في الفواتير والتقارير (W4) — منطقٌ صرف تستدعيه نافذة الفاتورة وصفحتا الفواتير والتقارير.
// ----------------------------------------------------------------------------
// ١. الورقة من ردّ الخادم: تشغيلات كل بند (items[].lots) تُلحق ببنود المستند، فتطابق الورقةُ السجلَّ لا المعاينة.
// ٢. المرتجع: لوطات البيع على شاشة القابل للإرجاع، والمرتجع الحرّ من الإدارة بتشغيلة صريحة اختيارية للسطر كله (D5).
//    طلب المالك ١٦ نوفمبر ٢٠٢٦: منتقي الحرّ يبدأ بما اشتراه هذا العميل (/lots/customer-history)، والمرتبط يختار من تشغيلات
//    بند البيع نفسه (المرحلة B)؛ و«تلقائي» الافتراضي في الحالين — الخادم ينسبها تقديراً بدل «غير معروف» ما وُجدت تشغيلة.
// ٣. رسالة النقص من تفاصيل الخادم بلغة الواجهة.
// ٤. تقرير «المبيعات حسب التشغيلة» (GET /reports/lot-sales) وتشغيلات بنود تقرير المرتجع.
//
// كل كمية لوط هنا **بوحدة الأساس** (D22)، و`lotId: null` = «غير معروف».
// ============================================================================

import {
  LOT_CERTAINTIES, LOT_EPS, docLotsFrom, lotDay, roundLot, toBaseQty,
  type DocLotLine, type LotBlockKind, type LotCertainty, type LotErrorInfo, type LotRef, type LotStatus,
} from './lots';
import { factorOf } from './units';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─── الورقة من ردّ الخادم ───

/**
 * تشغيلات بنود مستندٍ من بنود الردّ **بالترتيب نفسه** (returnDocItems وinvoiceDocFromDetail يحفظانه). عددٌ مختلف يُبقي
 * البنود كما هي (لا تُنسب تشغيلةٌ لبندٍ غير بندها)، والبند الذي يحمل lots أصلاً لا يُمسّ.
 */
export function withDocLots<T extends { lots?: DocLotLine[] }>(docItems: T[], rawItems: unknown): T[] {
  if (!Array.isArray(rawItems) || rawItems.length !== docItems.length) return docItems;
  return docItems.map((it, i) => {
    if (it.lots !== undefined) return it;
    const lots = docLotsFrom((rawItems[i] as { lots?: unknown } | null | undefined)?.lots);
    return lots ? { ...it, lots } : it;
  });
}

/**
 * تشغيلات أسطر محرّر البيع من بنود ردّ الإصدار: المطابقة بالصنف ومعامل الوحدة (الصنف بوحدتين سطران)، وكل بند ردٍّ يُؤخذ
 * مرّة. سطرٌ لا بند له في الردّ (أو بندٌ بلا صفوف) undefined.
 */
export function saleLineLots(
  lines: readonly { productId: string; unitFactor?: number | null }[],
  rawItems: unknown,
): (DocLotLine[] | undefined)[] {
  const items = Array.isArray(rawItems) ? (rawItems as (Record<string, unknown> | null)[]) : [];
  const used = new Set<number>();
  return lines.map((l) => {
    const f = factorOf({ unitFactor: l.unitFactor });
    const j = items.findIndex((it, k) => !used.has(k) && !!it && String(it.productId ?? '') === l.productId
      && factorOf({ unitFactor: it.unitFactor as number | null | undefined }) === f);
    if (j < 0) return undefined;
    used.add(j);
    return docLotsFrom(items[j]!.lots);
  });
}

// ─── المرتجع ───

/** صفّ تشغيلةٍ لبند بيعٍ على شاشة القابل للإرجاع (withLots=1) — المباع والمُرجَع والمتاح بالأساس */
export interface SaleLotRow {
  lotId: string | null; lotNumber: string | null; expiryDate: string | null;
  sold: number; returned: number; returnable: number; certainty: LotCertainty;
}

const certaintyOf = (v: unknown): LotCertainty =>
  ((LOT_CERTAINTIES as readonly string[]).includes(String(v)) ? (v as LotCertainty) : 'UNKNOWN');

/** تشغيلات بنود فاتورة البيع من ردّ /invoices/:id/returnable — بند بيعٍ بلا صفوف (غير متتبَّع، أو بيعٌ قبل التتبّع) غائب */
export function returnableLotsOf(raw: unknown): Map<string, SaleLotRow[]> {
  const out = new Map<string, SaleLotRow[]>();
  const lines = (raw as { lines?: unknown } | null | undefined)?.lines;
  if (!Array.isArray(lines)) return out;
  for (const x of lines) {
    const l = (x ?? {}) as { saleItemId?: unknown; lots?: unknown };
    if (!l.saleItemId || !Array.isArray(l.lots) || !l.lots.length) continue;
    const rows = l.lots.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map((r) => ({
      lotId: typeof r.lotId === 'string' && r.lotId ? r.lotId : null,
      lotNumber: typeof r.lotNumber === 'string' && r.lotNumber ? r.lotNumber : null,
      expiryDate: lotDay(r.expiryDate),
      sold: roundLot(num(r.sold)),
      returned: roundLot(num(r.returned)),
      returnable: roundLot(Math.max(0, num(r.returnable))),
      certainty: certaintyOf(r.certainty),
    }));
    if (rows.length) out.set(String(l.saleItemId), rows);
  }
  return out;
}

/**
 * المرتجع الحرّ من الإدارة (D5): تشغيلةٌ صريحة للسطر كله بكميته الأساسية — والفارغ «تلقائي» فلا يُرسل شيء (الخادم يحدّدها من
 * مبيعات العميل السابقة للصنف ASSUMED، وما فاقها UNKNOWN). سطرٌ بلا كمية لا صفّ له (الخادم يرفض الصفر أصلاً).
 */
export function freeReturnLotRows(line: { qty: number; unitFactor?: number | null }, lotId: string | null | undefined): LotRef[] | undefined {
  if (!lotId) return undefined;
  const qty = toBaseQty({ qty: num(line.qty), unitFactor: line.unitFactor });
  return qty > LOT_EPS ? [{ lotId, qty }] : undefined;
}

/**
 * يُلحق تشغيلات المرتجع الحرّ ببنود جسمه — buildFreeReturnPayload يبني items بترتيب الأسطر نفسه، والصنف شرطٌ ثانٍ فلا
 * تنتقل تشغيلةٌ إلى بند صنفٍ آخر. لا اختيار في أي سطر ⇒ الجسم كما هو حرفياً.
 */
export function withFreeReturnLots<L extends { productId: string; qty: number; unitFactor?: number | null }>(
  payload: Record<string, unknown>,
  lines: readonly L[],
  choiceOf: (line: L) => string | null | undefined,
): Record<string, unknown> {
  const items = payload.items;
  if (!Array.isArray(items) || items.length !== lines.length) return payload;
  let touched = false;
  const next = items.map((it, i) => {
    const line = lines[i];
    const lots = (it as { productId?: unknown })?.productId === line.productId ? freeReturnLotRows(line, choiceOf(line)) : undefined;
    if (!lots) return it;
    touched = true;
    return { ...(it as Record<string, unknown>), lots };
  });
  return touched ? { ...payload, items: next } : payload;
}

// ─── اختيار تشغيلة المرتجع (طلب المالك ١٦ نوفمبر ٢٠٢٦: «مفروض يتم ربطه بـLOT سابق») ───

/** سقف ما يُقرأ من سجلّ العميل — الخادم يردّ ٥٠ على الأكثر */
export const CUSTOMER_LOT_HISTORY_LIMIT = 50;

/** صفّ GET /lots/customer-history: تشغيلةٌ مسمّاة اشتراها العميل من الصنف في الحقبة الحالية، الأحدث بيعاً أولاً، والكميات أساسية */
export interface CustomerLotHistoryRow {
  lotId: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind: LotBlockKind | null;
  lastSoldAt: string | null; soldBase: number | null; returnedBase: number | null;
}

const finiteOrNull = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * ردّ /lots/customer-history (data) إلى صفوفٍ صالحة **بترتيب الخادم** (الأحدث أولاً): الصفّ بلا معرّف أو رقم أو حالة معروفة يسقط،
 * والمكرّر يبقى أوّله. وما ليس مصفوفةً ⇒ [] — يبقى «تلقائي» وتشغيلات الصنف الأخرى، فلا تسقط النافذة بردٍّ غير متوقّع.
 */
export function customerLotHistoryOf(raw: unknown): CustomerLotHistoryRow[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomerLotHistoryRow[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (out.length >= CUSTOMER_LOT_HISTORY_LIMIT) break;
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const r = x as Record<string, unknown>;
    const status = r.status === 'ACTIVE' || r.status === 'BLOCKED' ? r.status : null;
    if (typeof r.lotId !== 'string' || !r.lotId || typeof r.lotNumber !== 'string' || !r.lotNumber.trim() || !status || seen.has(r.lotId)) continue;
    seen.add(r.lotId);
    out.push({
      lotId: r.lotId, lotNumber: r.lotNumber.trim(), expiryDate: lotDay(r.expiryDate), status,
      blockKind: status === 'BLOCKED' && (r.blockKind === 'HOLD' || r.blockKind === 'RECALL') ? r.blockKind : null,
      lastSoldAt: typeof r.lastSoldAt === 'string' ? r.lastSoldAt : null,
      soldBase: finiteOrNull(r.soldBase), returnedBase: finiteOrNull(r.returnedBase),
    });
  }
  return out;
}

/** خيارٌ في منتقي تشغيلة المرتجع الحرّ: CUSTOMER اشتراها هذا العميل، OTHER من تشغيلات الصنف الأخرى */
export interface FreeReturnLotOption {
  lotId: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind: LotBlockKind | null;
  group: 'CUSTOMER' | 'OTHER'; soldBase: number | null;
}

/**
 * خيارات تشغيلة سطر المرتجع الحرّ في نافذة الإدارة: ما اشتراه **هذا العميل** من الصنف أولاً بترتيب الخادم (الأحدث بيعاً — هو الأرجح
 * أن يعود)، ثم تشغيلات الصنف الأخرى (/lots، بصلاحية مخزون السيارات) مما لم يرد قبلها — كل تشغيلة مرة، ومن صنفٍ آخر لا شيء.
 * «تلقائي» يبقى الافتراضي خارج القائمة: الخادم ينسبها هو (مبيعات العميل، ثم السيارة، ثم الشركة — ASSUMED).
 */
export function freeReturnLotOptions(
  history: readonly CustomerLotHistoryRow[] | null | undefined,
  productLots: readonly { id: string; productId?: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind?: LotBlockKind | null }[] | null | undefined,
  productId: string,
): FreeReturnLotOption[] {
  const out: FreeReturnLotOption[] = [];
  const seen = new Set<string>();
  for (const h of history ?? []) {
    if (seen.has(h.lotId)) continue;
    seen.add(h.lotId);
    out.push({ lotId: h.lotId, lotNumber: h.lotNumber, expiryDate: h.expiryDate, status: h.status, blockKind: h.blockKind, group: 'CUSTOMER', soldBase: h.soldBase });
  }
  for (const l of productLots ?? []) {
    if (!l?.id || seen.has(l.id) || (l.productId && l.productId !== productId)) continue;
    seen.add(l.id);
    out.push({ lotId: l.id, lotNumber: l.lotNumber, expiryDate: lotDay(l.expiryDate), status: l.status, blockKind: l.blockKind ?? null, group: 'OTHER', soldBase: null });
  }
  return out;
}

/**
 * المرتجع المرتبط (المرحلة B): تشغيلات بند البيع التي يُختار منها — المسمّاة وحدها وفيها ما يُرجَع. «تلقائي» (الوراثة من صفوف
 * البيع) يبقى الافتراضي؛ والخادم يقبل الصريح من صفوف بند البيع نفسه وحده وضمن المتاح إرجاعه من كلٍّ (وإلا 422).
 */
export function linkedReturnLotChoices(rows: readonly SaleLotRow[] | null | undefined): (SaleLotRow & { lotId: string })[] {
  return (rows ?? []).filter((r): r is SaleLotRow & { lotId: string } => r.lotId !== null && r.returnable > LOT_EPS);
}

/** الكمية الأساسية لسطر مرتجعٍ مرتبط (الكمية × معامل وحدة المرتجع) — ما يقارن به الخادم صفوف التشغيلة */
export function linkedReturnBaseQty(l: { qty: number; retUnitFactor?: number | null }): number {
  return toBaseQty({ qty: num(l.qty), unitFactor: l.retUnitFactor });
}

/**
 * ما يمنع إرسال تشغيلةٍ مختارة لسطر مرتجعٍ مرتبط: ليست من صفوف بند البيع (LOT_NOT_IN_SALE)، أو الكمية فوق ما يُرجَع منها
 * (LOT_OVER_RETURNABLE) — مرآة رفض الخادم 422، فيُقال قبل الإرسال. «تلقائي» أو سطرٌ بلا كمية ⇒ null.
 */
export function linkedReturnLotProblem(
  rows: readonly SaleLotRow[] | null | undefined, lotId: string | null | undefined, baseQty: number,
): 'LOT_NOT_IN_SALE' | 'LOT_OVER_RETURNABLE' | null {
  if (!lotId || !(baseQty > LOT_EPS)) return null;
  const row = (rows ?? []).find((r) => r.lotId === lotId);
  if (!row) return 'LOT_NOT_IN_SALE';
  return roundLot(baseQty) > row.returnable + LOT_EPS ? 'LOT_OVER_RETURNABLE' : null;
}

/**
 * يُلحق التشغيلة المختارة ببنود المرتجع المرتبط (buildLinkedReturnPayload): المطابقة **بمعرّف بند البيع** (invoiceItemId) لا
 * بالموضع، والكمية الأساسية من سطره. بندٌ «تلقائي» أو بلا سطرٍ مطابق كما هو، ولا اختيار ⇒ الجسم نفسه حرفياً.
 */
export function withLinkedReturnLots(
  payload: Record<string, unknown>,
  lines: readonly { saleItemId: string; qty: number; retUnitFactor?: number | null }[],
  choiceOf: (saleItemId: string) => string | null | undefined,
): Record<string, unknown> {
  const items = payload.items;
  if (!Array.isArray(items)) return payload;
  let touched = false;
  const next = items.map((it) => {
    const sid = (it as { invoiceItemId?: unknown })?.invoiceItemId;
    const line = typeof sid === 'string' ? lines.find((l) => l.saleItemId === sid) : undefined;
    const lotId = line ? choiceOf(line.saleItemId) : undefined;
    const qty = line ? linkedReturnBaseQty(line) : 0;
    if (!line || !lotId || qty <= LOT_EPS) return it;
    touched = true;
    return { ...(it as Record<string, unknown>), lots: [{ lotId, qty: roundLot(qty) }] };
  });
  return touched ? { ...payload, items: next } : payload;
}

// ─── رسالة الخطأ ───

export interface LotErrorCtx {
  /** اسم الصنف من معرّفه (قائمة الأصناف المحمّلة) */
  nameOf?: (productId: string) => string | null | undefined;
  /** نصّ كميةٍ أساسية للصنف («٢ كرتون و٣ حبة») */
  qtyText?: (productId: string | null, baseQty: number) => string;
  /** رقم التشغيلة من معرّفها (لقطة السيارة) — حين لا يحمله الخطأ */
  lotNumberOf?: (lotId: string) => string | null | undefined;
}

/**
 * نصّ خطأ اللوط بلغة الواجهة من رمزه وتفاصيله: النقص بالمطلوب والمتاح، ورفض إلغاء المرتجع أو إطفاء عودته بالتشغيلة التي
 * بيعت منها بضاعته، والانشغال. وما سواها رسالة الخادم كما هي (عربية بقيمها)، وإلا «خطأ».
 */
export function lotErrorText(info: LotErrorInfo, tr: (ar: string) => string, ctx: LotErrorCtx = {}): string {
  const d = info.detail ?? {};
  const pid = typeof d.productId === 'string' ? d.productId : null;
  const qty = (n: number) => (ctx.qtyText ? ctx.qtyText(pid, n) : String(roundLot(n)));
  if (info.code === 'LOT_STOCK_INSUFFICIENT') {
    if (d.mode === 'CANCEL' || d.mode === 'RESTOCK_OFF') {
      const what = d.mode === 'CANCEL' ? tr('لا يلغى المرتجع لأن بضاعته بيعت من') : tr('لا تطفأ عودة المرتجع للمخزون لأن بضاعته بيعت من');
      const from = d.lotId ? `${tr('التشغيلة')} ${typeof d.lotNumber === 'string' ? d.lotNumber : ''}`.trim() : tr('غير مسمى');
      return `${what}: ${from}`;
    }
    const name = pid ? ctx.nameOf?.(pid) : null;
    // تشغيلةٌ صريحة (بيع الإدارة بتشغيلة مختارة، lots.ts allocateOutLines): المطلوب منها على كل الأسطر ومتاحها هي لا السيارة —
    // «المتاح في السيارة» كان يُظهر متاح التشغيلة وحدها والسيارة فيها أكثر (مراجعة D2)
    if (typeof d.lotId === 'string') {
      const num = (typeof d.lotNumber === 'string' && d.lotNumber) || ctx.lotNumberOf?.(d.lotId) || '';
      const lotParts = [`${tr('الكمية أكبر من المتاح في التشغيلة')}${num ? ` ${num}` : ''}${name ? ` «${name}»` : ''}`];
      const w = Number(d.wanted);
      const u = Number(d.usable);
      if (Number.isFinite(w)) lotParts.push(`${tr('الكمية')} ${qty(w)}`);
      if (Number.isFinite(u)) lotParts.push(`${tr('المتاح فيها')} ${qty(Math.max(0, u))}`);
      return lotParts.join(' · ');
    }
    const parts = [`${tr('الكمية أكبر من المتاح في تشغيلات سيارة المندوب')}${name ? ` «${name}»` : ''}`];
    const wanted = Number(d.wanted);
    const avail = Number(d.available ?? d.usable);
    if (Number.isFinite(wanted)) parts.push(`${tr('الكمية')} ${qty(wanted)}`);
    if (Number.isFinite(avail)) parts.push(`${tr('المتاح في السيارة')} ${qty(Math.max(0, avail))}`);
    return parts.join(' · ');
  }
  if (info.code === 'LOT_BUSY') return tr('التشغيلة مشغولة بعملية أخرى أعد المحاولة بعد لحظات');
  // رفض تشغيلة المرتجع المرتبط (طلب المالك ١٦ نوفمبر ٢٠٢٦، المرحلة B): LOT_QTY_INVALID وسببه في detail.reason — بلغة الواجهة لا
  // رسالة الخادم العربية. يبلغه مرتجعٌ آخر سبق فأنقص المتاح إرجاعه بعد ما فحصته النافذة
  if (info.code === 'LOT_QTY_INVALID' && d.reason === 'LOT_OVER_RETURNABLE') return tr('الكمية أكبر من المتاح إرجاعه من هذه التشغيلة');
  if (info.code === 'LOT_QTY_INVALID' && d.reason === 'LOT_NOT_IN_SALE') return tr('التشغيلة المختارة ليست من تشغيلات بند فاتورة البيع');
  return info.message || tr('خطأ');
}

// ─── تقرير «المبيعات حسب التشغيلة» ───

export interface LotReportUnit { name: string; factor: number }

/** سطر (صنف، تشغيلة) — مرآة LotSalesRow في backend/src/routes/reports.ts. الكميات بالأساس، وlotId null «غير معروف» */
export interface LotSalesRowDto {
  productId: string; productName: string; productCode: string | null; unit: string; units: LotReportUnit[];
  lotId: string | null; lotNumber: string | null; productionDate: string | null; expiryDate: string | null;
  status: LotStatus | null; blockKind: LotBlockKind | null;
  sold: number; returned: number; net: number;
  customers: number; invoices: number; returnInvoices: number;
  soldByCertainty: Record<LotCertainty, number>;
}
export type LotSalesProductDto = Omit<LotSalesRowDto, 'lotId' | 'lotNumber' | 'productionDate' | 'expiryDate' | 'status' | 'blockKind'> & { lots: number };
export interface LotSalesReportDto {
  rows: LotSalesRowDto[];
  products: LotSalesProductDto[];
  summary: { lots: number; products: number; customers: number; invoices: number; returnInvoices: number };
  range: { from: string | null; to: string | null; timezone: string };
  rangeApplied: boolean; defaultDays: number | null; scoped: boolean; truncated: boolean; maxInvoices?: number;
}

/** صنفٌ في العرض بتشغيلاته (بترتيب الخادم: FEFO و«غير معروف» آخراً) ومجموعه */
export interface LotSalesGroup { product: LotSalesProductDto | null; productId: string; rows: LotSalesRowDto[] }

/**
 * تجميع أسطر التقرير بالصنف للعرض — ترتيب الخادم محفوظ (الصنف بالاسم ثم تشغيلاته)، والمجموع من products بمعرّفه. الجمع
 * داخل الصنف وحده: أساس صنفٍ لا يُجمع إلى أساس آخر.
 */
export function groupLotSales(rows: readonly LotSalesRowDto[], products: readonly LotSalesProductDto[]): LotSalesGroup[] {
  const byId = new Map(products.map((p) => [p.productId, p]));
  const out: LotSalesGroup[] = [];
  const at = new Map<string, LotSalesGroup>();
  for (const r of rows) {
    let g = at.get(r.productId);
    if (!g) {
      g = { product: byId.get(r.productId) ?? null, productId: r.productId, rows: [] };
      at.set(r.productId, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

/** ما بيع بيقينٍ غير مؤكَّد (مفترض أو غير معروف) — للتنبيه بجانب المباع؛ أصفارٌ لا تُذكر */
export function uncertainSold(r: Pick<LotSalesRowDto, 'soldByCertainty'>): { assumed: number; unknown: number } {
  const assumed = roundLot(num(r.soldByCertainty?.ASSUMED));
  const unknown = roundLot(num(r.soldByCertainty?.UNKNOWN));
  return { assumed: assumed > LOT_EPS ? assumed : 0, unknown: unknown > LOT_EPS ? unknown : 0 };
}

/**
 * تشغيلات بند مستندٍ نصّاً واحداً (خلية Excel أو سطرٌ في جدول): «A12 ×5 (2026-12-01)، غير معروف ×2». الكمية أساسية
 * مطلقة، وfmt منسّق الكمية (بوحدة الأساس إن شاء المستدعي). لا تشغيلات ⇒ نصٌّ فارغ.
 */
export function docLotsText(lots: readonly DocLotLine[] | undefined, unknownLabel: string, fmt: (n: number) => string): string {
  if (!lots?.length) return '';
  return lots.map((l) => `${l.lotNumber ?? unknownLabel} ×${fmt(l.qty)}${l.expiryDate ? ` (${l.expiryDate})` : ''}`).join('، ');
}
