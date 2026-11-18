// ============================================================================
// «تتبّع اللوط» — تشغيلة المرتجع الحرّ في تطبيق المندوب (طلب المالك ١٦ نوفمبر ٢٠٢٦ «عالجها»، الشكوى ١: «المرتجع يدخل كـLOT
// جديد غير مسمى»). منطقٌ صرف بلا IndexedDB ولا شبكة ولا React.
// ----------------------------------------------------------------------------
// - الافتراض «تلقائي»: لا حقل lots في البند فيقرّر الخادم التشغيلة كما قبل الميزة حرفاً (مشتريات العميل ثم ما يخمّنه).
// - اختيارٌ اختياري لسطر المرتجع الحرّ وحده (لا بند فاتورة بيع: ذاك يرث تشغيلات بيعه، ولا يقبل الخادم غيرها):
//   • متصلاً: ما اشتراه هذا العميل من الصنف (GET /lots/customer-history) أولاً بترتيب الخادم (الأحدث أولاً) — هو الأرجح أن يعود؛
//   • ثم تشغيلات الصنف في لقطة سيارة المندوب ('vanlots')، وهي وحدها دون اتصال (أو لعميلٍ أُنشئ دون اتصال بلا معرّف خادمي).
// - المختار يُرسل items[i].lots = [{lotId, qty: الكمية الأساسية}] — صفٌّ واحد يساوي كمية السطر، كما يقبله parseLotRefsStrict.
//   والحمولة نفسها يحفظها الصندوق الأوف‑لاين ويرفعها: الخادم يقبلها حيّاً بصرامة (CONFIRMED)، وفي الإعادة تلميحاً — المخالف
//   يُتجاهل بتحذير ويكمل الخادم بقاعدته، ولا يُرفض المستند (الورقة سُلّمت).
// - كمية خارج شبكة الأربع خانات لا تُرفق بتشغيلة: الخادم يحكم على الكمية نفسها، ولا نكون نحن سبب الرفض.
// ============================================================================

import {
  LOT_EPS, lotDay, roundLot, toBaseQty,
  type DocLotLine, type LotBlockKind, type LotRef, type LotStatus, type VanLotSnapshotDto,
} from '../lib/lots';

/** مسار سجلّ تشغيلات العميل للصنف (معاملا customerId وproductId) — المندوب لعملائه وحدهم، والشركة كلها مقيّدة بمستأجرها */
export const CUSTOMER_LOT_HISTORY_PATH = '/lots/customer-history';
/** سقف ما يُقرأ من الردّ — الخادم يردّ ٥٠ على الأكثر، والزائد لا يُعرض في قائمةٍ على شاشة جوّال */
export const CUSTOMER_LOT_HISTORY_MAX = 50;

/** صفّ سجلّ العميل كما يردّه الخادم: الأحدث بيعاً أولاً، والكميات أساسية */
export interface CustomerLotRow {
  lotId: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind: LotBlockKind | null;
  lastSoldAt: string | null; soldBase: number | null; returnedBase: number | null;
}

/** ما يُحفظ على سطر السلّة (retLot) — الرقم والانتهاء للورقة دون اتصال، فلا تتوقّف على قائمةٍ تغيّرت بعد الاختيار */
export interface ReturnLotPick { lotId: string; lotNumber: string; expiryDate: string | null }

/** خيارٌ في منتقي السطر: CUSTOMER من سجلّ العميل، VAN من لقطة السيارة، PICKED اختيارٌ سابق لم يعد في القائمتين (يبقى ظاهراً) */
export interface ReturnLotOption extends ReturnLotPick { source: 'CUSTOMER' | 'VAN' | 'PICKED'; status: LotStatus; blockKind: LotBlockKind | null }

const finiteOrNull = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const okId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 128;
const statusOf = (x: unknown): LotStatus | null => (x === 'ACTIVE' || x === 'BLOCKED' ? x : null);
const blockKindOf = (x: unknown): LotBlockKind | null => (x === 'HOLD' || x === 'RECALL' ? x : null);

/**
 * ردّ GET /lots/customer-history (data) إلى صفوفٍ صالحة بترتيبه: مصفوفةٌ مباشرة (أو { lots: [...] } احتياطاً)، والصفّ بلا معرّف
 * أو رقم أو حالة معروفة يُسقط، والمعرّف المكرّر يبقى أوّله (الأحدث). وما ليس ردّاً مفهوماً ⇒ [] (يبقى «تلقائي» وتشغيلات السيارة).
 */
export function customerLotHistoryOf(raw: unknown): CustomerLotRow[] {
  const list = Array.isArray(raw) ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { lots?: unknown }).lots) ? (raw as { lots: unknown[] }).lots : [];
  const out: CustomerLotRow[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    if (out.length >= CUSTOMER_LOT_HISTORY_MAX) break;
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
    const r = x as Record<string, unknown>;
    const status = statusOf(r.status);
    if (!okId(r.lotId) || typeof r.lotNumber !== 'string' || !r.lotNumber.trim() || !status || seen.has(r.lotId)) continue;
    seen.add(r.lotId);
    out.push({
      lotId: r.lotId, lotNumber: r.lotNumber.trim(), expiryDate: lotDay(r.expiryDate), status,
      blockKind: status === 'BLOCKED' ? blockKindOf(r.blockKind) : null,
      lastSoldAt: typeof r.lastSoldAt === 'string' ? r.lastSoldAt : null,
      soldBase: finiteOrNull(r.soldBase), returnedBase: finiteOrNull(r.returnedBase),
    });
  }
  return out;
}

/**
 * خيارات منتقي تشغيلة سطر المرتجع الحرّ: ما اشتراه العميل أولاً بترتيب الخادم، ثم تشغيلات الصنف في لقطة السيارة بترتيبها (FEFO)
 * مما لم يرد قبلها — كل تشغيلة مرة. والاختيار القائم (picked) إن غاب عنهما يُضاف آخراً: لا يختفي اختيار المندوب صامتاً فيظهر
 * «تلقائي» والحمولة تحمل تشغيلة. بلا سجلّ ولا لقطة ولا اختيار ⇒ [] (لا منتقي: «تلقائي» وحده).
 */
export function returnLotOptions(history: readonly CustomerLotRow[] | null | undefined, snap: VanLotSnapshotDto | null | undefined,
  productId: string, picked?: ReturnLotPick | null): ReturnLotOption[] {
  const out: ReturnLotOption[] = [];
  const seen = new Set<string>();
  for (const h of history ?? []) {
    if (seen.has(h.lotId)) continue;
    seen.add(h.lotId);
    out.push({ lotId: h.lotId, lotNumber: h.lotNumber, expiryDate: h.expiryDate, status: h.status, blockKind: h.blockKind, source: 'CUSTOMER' });
  }
  for (const l of snap?.products.find((p) => p.productId === productId)?.lots ?? []) {
    if (!okId(l.lotId) || seen.has(l.lotId)) continue;
    seen.add(l.lotId);
    out.push({
      lotId: l.lotId, lotNumber: l.lotNumber, expiryDate: lotDay(l.expiryDate), status: l.status,
      blockKind: l.status === 'BLOCKED' ? l.blockKind ?? null : null, source: 'VAN',
    });
  }
  if (picked && okId(picked.lotId) && !seen.has(picked.lotId)) {
    out.push({ lotId: picked.lotId, lotNumber: picked.lotNumber, expiryDate: lotDay(picked.expiryDate), status: 'ACTIVE', blockKind: null, source: 'PICKED' });
  }
  return out;
}

/** ما يُحفظ على السطر من خيارٍ — بلا مصدره ولا حالته (تتغيّر؛ والخادم يحكم بحالها لحظة الإصدار) */
export function returnLotPickOf(o: Pick<ReturnLotOption, 'lotId' | 'lotNumber' | 'expiryDate'>): ReturnLotPick {
  return { lotId: o.lotId, lotNumber: o.lotNumber, expiryDate: lotDay(o.expiryDate) };
}

/** السطر نفسه باختيارٍ جديد — null يعيده «تلقائي» بحذف المفتاح (فلا يبقى في الجسم ولا في مفتاح المحاولة أثرٌ له) */
export function withReturnPick<T extends { retLot?: ReturnLotPick | null }>(line: T, pick: ReturnLotPick | null): T {
  if (pick) return { ...line, retLot: pick };
  if (!('retLot' in line)) return line;
  const rest = { ...line };
  delete rest.retLot;
  return rest;
}

/** يُعرض منتقي التشغيلة لهذا السطر؟ — مرتجعٌ والميزة مفعّلة، وسطرٌ حرّ (لا بند فاتورة بيع)، وصنفه متتبَّع */
export function returnLotLine(on: boolean, isReturn: boolean, line: { productId?: unknown; saleItemId?: unknown }, tracked: ReadonlySet<string> | null | undefined): boolean {
  return on && isReturn && !line.saleItemId && typeof line.productId === 'string' && !!tracked?.has(line.productId);
}

/**
 * صفوف lots لبند المرتجع الحرّ في الحمولة: [{lotId, qty: الكمية الأساسية}] — أو undefined («تلقائي»: لا حقل والجسم كما كان)
 * حين لا اختيار، أو بند فاتورة بيع، أو كمية غير موجبة، أو كمية أساسية خارج شبكة الأربع خانات (الخادم يحكم عليها وحدها).
 */
export function returnLineLots(pick: ReturnLotPick | null | undefined, line: { qty?: unknown; unitFactor?: unknown; saleItemId?: unknown }): LotRef[] | undefined {
  if (!pick || !okId(pick.lotId) || line.saleItemId) return undefined;
  const base = toBaseQty({ qty: Number(line.qty) || 0, unitFactor: line.unitFactor as number | null | undefined });
  if (!Number.isFinite(base) || !(base > LOT_EPS)) return undefined;
  const q = roundLot(base);
  if (Math.abs(q - base) > LOT_EPS) return undefined;
  return [{ lotId: pick.lotId, qty: q }];
}

/** تشغيلة السطر على الورقة دون اتصال (تُطبع بشرط lotOnInvoice) — من الحمولة نفسها، فما لم يُرسَل لا يُطبع */
export function returnPickDocLots(pick: ReturnLotPick | null | undefined, lots: readonly LotRef[] | null | undefined): DocLotLine[] | undefined {
  if (!pick || !lots || lots.length !== 1 || lots[0].lotId !== pick.lotId) return undefined;
  return [{ lotNumber: pick.lotNumber, qty: roundLot(lots[0].qty), expiryDate: lotDay(pick.expiryDate) }];
}

/**
 * سطر المستند الذي رفض الخادم تشغيلته في الإصدار الحيّ (ردّ LotError: رمزٌ يبدأ بـLOT_ و detail.line فهرس البند) — بنود الحمولة
 * بترتيب أسطر السلّة نفسه، فيعود ذلك السطر «تلقائي». وردٌّ بلا فهرسٍ صالح (خادمٌ أقدم) ومعه detail.lotId: أول سطرٍ اختار
 * المندوب له تلك التشغيلة (`picks` معرّفات اختيار الأسطر بترتيبها) — فلا يعلق المندوب على اختيارٍ يرفضه الخادم. غير ذلك null.
 */
export function lotRejectLine(data: unknown, count: number, picks?: readonly (string | null | undefined)[] | null): number | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { code?: unknown; detail?: { line?: unknown; lotId?: unknown } | null };
  if (typeof d.code !== 'string' || !d.code.startsWith('LOT_')) return null;
  const detail = d.detail && typeof d.detail === 'object' ? d.detail : null;
  const line = detail?.line;
  if (typeof line === 'number' && Number.isInteger(line) && line >= 0 && line < count) return line;
  const lotId = detail?.lotId;
  if (!okId(lotId) || !picks) return null;
  const j = picks.findIndex((p, i) => i < count && p === lotId);
  return j >= 0 ? j : null;
}
