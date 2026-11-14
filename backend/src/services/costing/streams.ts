/**
 * مصادر محرّك التكلفة («ربط الدفاتر» L3 — العقد scratchpad/l23_contract.md §6): حركات المخزون من الجداول الإلحاقية وحدها.
 *
 * أربعة مصادر بمؤشّر (createdAt, id) لكل منها، تُقرأ بصفحات ثم تُدمج دمجاً k-طريقياً بترتيب المحرّك الوحيد (D2):
 *  - warehouse_entries ببنودها (warehouse_entry_items) بمؤشّر الحركة الأم (createdAt, id)؛
 *  - van_loads ببنودها (van_load_items) بمؤشّر التحميل الأم (createdAt, id)؛
 *  - account_entries: الصف الأساسي للفاتورة (INVOICE_DEBIT/INVOICE_CREDIT بلا سند — POSTING_TYPES_BY_INVOICE في desired.ts)؛
 *  - invoice_restock_logs: تبديلات «الإعادة للمخزون» للمرتجع.
 *
 * لماذا الصفوف الإلحاقية وحدها: الحالة الحيّة (invoice.status، returnToStock) تتبدّل بعد الحدث، فقراءتها تجعل إعادة
 * الطيّ غداً تختلف عن طيّ اليوم. لذلك لا يُقرأ invoice.status أبداً، ولا returnToStock إلا حالةَ بدءٍ للمرتجع (D15).
 *
 * الدمج: لا يُخرَج إلا ما هو **أصغر تماماً** من أصغر «حدّ» بين المصادر التي امتلأت صفحتها (حدّ المصدر = مفتاح آخر صفّ
 * جلبه، فيُحجز حتى تتقدّم الصفحة التالية)، فلا يسبق صفٌّ من مصدرٍ صفّاً لم يُقرأ بعد من مصدرٍ آخر. والنتيجة لا تتعلّق
 * بحجم الصفحة حرفياً (اختبار الأحجام 1 و3 و2000).
 *
 * قاعدة صغيرة جداً (٠٫١ نواة): كل صفحة مصدر بمؤشّر مفتاحي على فهرس (tenantId, createdAt, id) لأعمدة الجدول نفسه — لا
 * ترتيب على حقل علاقة (لا يخدمه فهرس فتصير الصفحات تربيعية) — والبنود والحقائق (الفواتير وبنودها وسجلّات التبديل وصفوف
 * الإلغاء) مجمّعة لكل صفحة بـIN مقسّمة — لا استعلام لكل صفّ.
 *
 * يعمل على PrismaClient أو معاملة أو العميل الحارس في ظلّ المعاينة أو القاعدة المزيّفة (tests/costing-fake-db.ts).
 */
import type { Prisma } from '@prisma/client';
import { toMilli } from '../gl/money';
import { baseQtyOf } from '../units';
import { isDamagedVanReturn } from '../vanDamaged';
import { vanKeyOf } from '../warehouseStock';
import { restockToggleKey, returnCancelKey, returnKey, saleCancelKey, saleOutKey, vanItemKey, whItemKey } from './keys';
import { compareCursors, compareMoves } from './stepper';
import {
  STREAM_WARNINGS, WH_LOCATION, vanLocation,
  type CostCursor, type CostRefType, type LoadMovesOptions, type LoadMovesResult, type LocationKey, type Move,
  type StreamWarning, type StreamWarningCode,
} from './types';

/** المندوبات التشغيلية وحدها — يعمل على PrismaClient أو معاملة أو العميل الحارس في الظلّ أو المزيّف */
export type CostingDb = Pick<Prisma.TransactionClient,
  'warehouseEntry' | 'warehouseEntryItem' | 'vanLoad' | 'vanLoadItem' | 'accountEntry' | 'invoice' | 'invoiceItem' | 'invoiceRestockLog'>;

/**
 * صفوف كل مصدر لكل صفحة قراءة (العقد: الافتراضي 2000) — لمصدرَي البنود: حركاتٌ أمّ ببنودها كاملةً.
 * مع maxMoves (دفعات computeSnapshots) لا تتجاوز الصفحة السقف: كل صفّ مصدر يُنتج حركةً على الأقل عادةً، فقراءة 2000 صفّ من
 * كل مصدر لدفعة 1000 حركة تُعاد مع كل دفعة بلا فائدة.
 */
export const DEFAULT_PAGE_SIZE = 2000;
/** عيّنة كل تحذير (معرّفات للتعمّق) */
export const STREAM_WARNING_SAMPLE = 20;
/** حجم قوائم IN للحقائق — بعيد عن حدّ معاملات Postgres (32767) وخفيف على المخطِّط */
const IN_CHUNK = 1000;

/** أنواع صفّ الفاتورة الأساسية في account_entries (العكس للنقدي يكتب RECEIPT_DEBIT أيضاً — لا يمسّ المخزون) */
const PRIMARY_ENTRY_TYPES = ['INVOICE_DEBIT', 'INVOICE_CREDIT'] as const;

// ═══ مساعدات المؤشّر ═══

/** مقارنة مؤشّرين (= compareCursors في stepper.ts — ترتيب المحرّك الوحيد) */
export const compareCursor = compareCursors;

/** الأكبر من مؤشّرين (null = لا شيء) */
export function maxCursor(a: CostCursor | null | undefined, b: CostCursor | null | undefined): CostCursor | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return compareCursors(a, b) >= 0 ? a : b;
}

function chunks<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ═══ صفوف المصادر كما تُقرأ ═══

/*
 * مصدرا البنود يُقرآن **بالأب**: صفحة حركات (warehouse_entries / van_loads) بمؤشّر مفتاحي على أعمدتها نفسها — فهرس
 * (tenantId, createdAt, id) — ثم بنودها بـentryId/vanLoadId IN (...). الترتيب على حقل علاقةٍ (entry.createdAt) يولّد في
 * Prisma 5.22 ربطاً يسارياً بالأب وترتيباً على عمود الطرف القابل للفراغ لا يخدمه فهرس، فتفرز كل صفحةٍ كلَّ ما بقي من بنود
 * الشركة (تربيعي على تاريخها كله — المعاينة تقرؤه كاملاً)، ويمسح المخطّط بنود كل الشركات. والأب كاملاً بلا شطر (كـdataHash.ts).
 */
const WH_PARENT_SELECT = { id: true, createdAt: true, type: true, zeroRunId: true, reason: true } as const;
const WH_ITEM_SELECT = { id: true, entryId: true, productId: true, qty: true, unitFactor: true, baseQty: true, unitCost: true } as const;
const VAN_PARENT_SELECT = { id: true, createdAt: true, type: true, zeroRunId: true, reason: true, salesRepId: true, deletedSalesRepId: true } as const;
const VAN_ITEM_SELECT = { id: true, vanLoadId: true, productId: true, qty: true, unitFactor: true, baseQty: true } as const;

const AE_SELECT = { id: true, invoiceId: true, type: true, entryDate: true, createdAt: true } as const;
const LOG_SELECT = { id: true, invoiceId: true, previous: true, returnToStock: true, createdAt: true } as const;

interface WhParent { id: string; createdAt: Date; type: string; zeroRunId: string | null; reason: string | null }
interface WhItemRow { id: string; productId: string; qty: number; unitFactor: number | null; baseQty: number | null; unitCost: number | null }
interface VanParent extends WhParent { salesRepId: string | null; deletedSalesRepId: string | null }
interface VanItemRow { id: string; productId: string; qty: number; unitFactor: number | null; baseQty: number | null }
interface AeRow { id: string; invoiceId: string | null; type: string; entryDate: Date; createdAt: Date }
interface LogRow { id: string; invoiceId: string; previous: boolean; returnToStock: boolean; createdAt: Date }

interface InvFacts {
  id: string;
  type: string;
  documentKind: string | null;
  salesRepId: string | null;
  returnToStock: boolean;
  returnReason: string | null;
  createdAt: Date;
  items: ItemFacts[];
}
interface ItemFacts {
  id: string;
  productId: string | null;
  qty: number;
  unitFactor: number | null;
  baseQty: number | null;
  returnOfItemId: string | null;
  creditedItemId: string | null;
  returnExpired: boolean | null;
}

/*
 * الصلات (MoveLinks) تحمل mirrorOf **صريحاً دائماً** (null حين لا صلة قيمة) — شكلٌ واحد ثابت لكل حركة مرتجع وتبديل
 * يقارنه الاختبار حرفياً.
 */
type SrcName = 'WH' | 'VAN' | 'AE' | 'LOG';
/** فاصل التعادل بين مصدرين بالمفتاح نفسه (لا يقع عملياً: المعرّفات UUID) — ترتيب ثابت للحتمية */
const SRC_RANK: Record<SrcName, number> = { WH: 0, VAN: 1, AE: 2, LOG: 3 };

/**
 * صفّ مصدر كامل — وحدة الإخراج والمؤشّر. لمصدرَي البنود: الأب، وبنوده كلها **تُحمَّل قبيل إخراجه** (null = لم تُحمَّل):
 * الدمج يحتاج المفتاح وحده، ودفعات computeSnapshots (maxMoves) تقرأ صفحة آباء لكل دفعة فلا تُحمَّل بنود ما لن يخرج فيها.
 */
type Unit =
  | { src: 'WH'; key: CostCursor; parent: WhParent; items: WhItemRow[] | null }
  | { src: 'VAN'; key: CostCursor; parent: VanParent; items: VanItemRow[] | null }
  | { src: 'AE'; key: CostCursor; row: AeRow }
  | { src: 'LOG'; key: CostCursor; row: LogRow };

/**
 * مصدر بصفحات: كل وحدةٍ صفٌّ واحد مجلوب كامل، والأخيرة محجوزة في tail ما دامت الصفحة ممتلئة —
 * frontier = مفتاح آخر صفّ جُلب: كل صفٍّ لم يُجلب بعد مفتاحه ≥ frontier (صفوف بلحظةٍ واحدة تُرتَّب بمعرّفها).
 */
class PagedSource {
  ready: Unit[] = [];
  tail: Unit | null = null;
  exhausted = false;
  private after: CostCursor | null;

  constructor(
    readonly name: SrcName,
    private readonly pageSize: number,
    initial: CostCursor | null,
    private readonly fetchPage: (after: CostCursor | null, take: number) => Promise<Unit[]>,
  ) {
    this.after = initial;
  }

  get frontier(): CostCursor | null {
    return this.exhausted || !this.tail ? null : this.tail.key;
  }

  async fill(): Promise<void> {
    if (this.exhausted) return;
    const fetched = await this.fetchPage(this.after, this.pageSize);
    if (fetched.length < this.pageSize) this.exhausted = true;
    if (fetched.length > 0) this.after = fetched[fetched.length - 1].key;
    for (const u of fetched) {
      if (this.tail) this.ready.push(this.tail);
      this.tail = u;
    }
    if (this.exhausted && this.tail) {
      this.ready.push(this.tail);
      this.tail = null;
    }
  }
}

// ═══ الحقائق (مجمّعة لكل صفحة) ═══

class Facts {
  readonly invoices = new Map<string, InvFacts>();
  private readonly logs = new Map<string, LogRow[]>();
  private readonly cancels = new Map<string, CostCursor | null>();

  constructor(private readonly db: CostingDb, private readonly tenantId: string) {}

  /** الفواتير وبنودها (مخبّأة: صفّ الفاتورة وبنودها ثابتة الأثر هنا — ما يتبدّل منها لا يُقرأ) */
  async ensureInvoices(ids: readonly string[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.invoices.has(id)).sort();
    for (const part of chunks(missing, IN_CHUNK)) {
      const invs = await this.db.invoice.findMany({
        where: { tenantId: this.tenantId, id: { in: part } },
        select: { id: true, type: true, documentKind: true, salesRepId: true, returnToStock: true, returnReason: true, createdAt: true },
      });
      const found = invs.map((i) => i.id);
      const items = found.length === 0 ? [] : await this.db.invoiceItem.findMany({
        where: { invoiceId: { in: found } },
        select: {
          id: true, invoiceId: true, productId: true, qty: true, unitFactor: true, baseQty: true,
          returnOfItemId: true, creditedItemId: true, returnExpired: true,
        },
        orderBy: [{ invoiceId: 'asc' }, { id: 'asc' }],
      });
      const byInv = new Map<string, ItemFacts[]>();
      for (const it of items) {
        const list = byInv.get(it.invoiceId) ?? [];
        list.push({
          id: it.id, productId: it.productId, qty: it.qty, unitFactor: it.unitFactor, baseQty: it.baseQty,
          returnOfItemId: it.returnOfItemId, creditedItemId: it.creditedItemId, returnExpired: it.returnExpired,
        });
        byInv.set(it.invoiceId, list);
      }
      for (const i of invs) {
        const its = (byInv.get(i.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        this.invoices.set(i.id, {
          id: i.id, type: i.type, documentKind: i.documentKind, salesRepId: i.salesRepId,
          returnToStock: i.returnToStock, returnReason: i.returnReason, createdAt: i.createdAt, items: its,
        });
      }
    }
  }

  /**
   * كل سجلّات التبديل للمرتجعات (بلا مؤشّر ولا حدّ — العقد §6.2): الحالة الابتدائية (D15) وسلسلة التبديل حتمية منها.
   * تُقرأ **بعد** صفّ الفاتورة دائماً: تبديلٌ يلتزم بين القراءتين يظهر سجلُّه بـprevious = القيمة القديمة نفسها التي قُرئت.
   */
  async refreshLogs(invoiceIds: readonly string[]): Promise<void> {
    const ids = [...new Set(invoiceIds)].sort();
    for (const part of chunks(ids, IN_CHUNK)) {
      const rows = await this.db.invoiceRestockLog.findMany({
        where: { tenantId: this.tenantId, invoiceId: { in: part } },
        select: LOG_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const by = new Map<string, LogRow[]>(part.map((id) => [id, []]));
      for (const r of rows) by.get(r.invoiceId)?.push(r);
      for (const [id, list] of by) this.logs.set(id, list.sort((a, b) => compareCursors(keyOfLog(a), keyOfLog(b))));
    }
  }

  /**
   * أقدم صفّ إلغاء (INVOICE_DEBIT) لكل مرتجع حتى upTo — لحكم «تبديل بعد الإلغاء». الحدّ الأدنى createdAt الفاتورة
   * (الإلغاء بعدها حتماً) يقصر المسح على فهرس (tenantId, createdAt, id) — account_entries بلا فهرس invoiceId.
   */
  async refreshCancels(invs: readonly InvFacts[], upTo: Date): Promise<void> {
    const list = [...invs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const part of chunks(list, IN_CHUNK)) {
      const from = new Date(Math.min(...part.map((i) => i.createdAt.getTime())));
      const rows = await this.db.accountEntry.findMany({
        where: {
          tenantId: this.tenantId, invoiceId: { in: part.map((i) => i.id) }, receiptId: null, type: 'INVOICE_DEBIT',
          createdAt: { gte: from, lte: upTo },
        },
        select: { id: true, invoiceId: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const i of part) this.cancels.set(i.id, null);
      for (const r of rows) {
        if (!r.invoiceId) continue;
        const k = { createdAt: r.createdAt, id: r.id };
        const cur = this.cancels.get(r.invoiceId);
        if (!cur || compareCursors(k, cur) < 0) this.cancels.set(r.invoiceId, k);
      }
    }
  }

  logsOf(invoiceId: string): LogRow[] {
    return this.logs.get(invoiceId) ?? [];
  }

  cancelOf(invoiceId: string): CostCursor | null {
    return this.cancels.get(invoiceId) ?? null;
  }
}

function keyOfLog(l: { createdAt: Date; id: string }): CostCursor {
  return { createdAt: l.createdAt, id: l.id };
}

/** بنود حركةٍ أمّ محمَّلة قبيل إخراجها (loadMoves) — وإلا خطأ برمجي (فشل مغلق، لا حركةٌ بلا بنود صامتة) */
function loadedItems<T>(items: T[] | null, parentId: string): T[] {
  if (!items) throw new Error(`COSTING_INTERNAL: بنود الحركة ${parentId} لم تُحمَّل قبل إخراجها`);
  return items;
}

// ═══ حالة المرتجع (العقد §6.2) ═══

interface RestockStep { logId: string; key: CostCursor; to: boolean }
interface RestockTimeline {
  /** الحالة الابتدائية (D15): previous لأول سجلّ، وإلا returnToStock الحالي */
  initial: boolean;
  /** التبديلات الفعلية قبل الإلغاء بترتيبها (السجلّ الذي لا يغيّر الحالة لا يُحتسب — حمايةٌ من سلسلة غير متّسقة) */
  steps: RestockStep[];
  /** سجلّات تبديلٍ حقيقي بعد الإلغاء ⇒ TOGGLE_AFTER_CANCEL */
  afterCancel: Set<string>;
  /** الحالة بعد آخر تبديل فعلي (= لحظة الإلغاء إن مُرِّر) */
  final: boolean;
}

function restockTimeline(inv: InvFacts, logs: readonly LogRow[], cancel: CostCursor | null): RestockTimeline {
  const initial = logs.length > 0 ? logs[0].previous : inv.returnToStock;
  let state = initial;
  const steps: RestockStep[] = [];
  const afterCancel = new Set<string>();
  for (const l of logs) {
    const k = keyOfLog(l);
    if (cancel && compareCursors(cancel, k) <= 0) {
      if (l.previous !== l.returnToStock) afterCancel.add(l.id);
      continue;
    }
    if (l.returnToStock === state) continue;
    state = l.returnToStock;
    steps.push({ logId: l.id, key: k, to: state });
  }
  return { initial, steps, afterCancel, final: state };
}

/** «مكتوب عليه» لا يعود أبداً: منتهٍ (أسبق، كمسار اللوط invEffect) ثم تالف بعد DAMAGED_VAN_SINCE */
function permanentWriteOff(inv: InvFacts, it: ItemFacts): 'EXPIRED' | 'DAMAGED' | null {
  if (it.returnExpired === true) return 'EXPIRED';
  if (isDamagedVanReturn(inv)) return 'DAMAGED';
  return null;
}

/**
 * تبديلات البند التي يشتقّها المصدر حركاتٍ (من خطوات الخطّ الزمني): كلها للبند العادي؛ وللمكتوب عليه أولها وحده إن كان
 * إلى «لا يعود» — المكتوب عليه لا يعود أبداً، لكن ختم «منتهي» يقع بعد الإصدار وخارج معاملته (وقد يتأخّر حتى إعادة رفع
 * الجهاز) فقد يكون RET قد طُوي عائداً قبله: هذه الحركة يقرّرها المحرّك بلقطة RET المجمَّدة (عائدٌ ⇒ تُخرج البضاعة، ومشطوبٌ
 * يومها ⇒ لا أثر)، ولا تُشتقّ بعدها حركة للبند فلا يتكرّر الخروج. الإلغاء يستعمل القائمة نفسها لمرجع آخر أثر.
 */
function emittedSteps(steps: readonly RestockStep[], perm: string | null): readonly RestockStep[] {
  if (!perm) return steps;
  return steps.length > 0 && !steps[0].to ? steps.slice(0, 1) : [];
}

/** مفتاح الأثر المشتقّ للبند قبل الخطوة رقم n من emittedSteps (n = الطول ⇒ آخر أثر): التبديل السابق وإلا RET */
function priorEffectKey(steps: readonly RestockStep[], n: number, itemId: string): string {
  return n > 0 ? restockToggleKey(steps[n - 1].logId, itemId) : returnKey(itemId);
}

/** دور الصف الأساسي في مستنده (POSTING_TYPES_BY_INVOICE في desired.ts) — null لنوع فاتورة غير معروف */
function invoiceRole(invType: string, rowType: string): 'POST' | 'REVERSE' | null {
  if (invType === 'CASH' || invType === 'CREDIT') return rowType === 'INVOICE_DEBIT' ? 'POST' : rowType === 'INVOICE_CREDIT' ? 'REVERSE' : null;
  if (invType === 'RETURN') return rowType === 'INVOICE_CREDIT' ? 'POST' : rowType === 'INVOICE_DEBIT' ? 'REVERSE' : null;
  return null;
}

// ═══ الاشتقاق ═══

class Deriver {
  private readonly warnCounts = new Map<StreamWarningCode, { count: number; sample: string[] }>();
  /** (الفاتورة، الدور) الذي أُخرج صفّه الأساسي — الأحدث مكرَّر */
  private readonly seenPrimary = new Set<string>();
  readonly sourceRows: Record<CostRefType, number> = { WH_ENTRY: 0, VAN_LOAD: 0, INVOICE: 0, RESTOCK_LOG: 0 };

  constructor(private readonly facts: Facts, private readonly decimals: number) {}

  warn(code: StreamWarningCode, id: string): void {
    const w = this.warnCounts.get(code) ?? { count: 0, sample: [] };
    w.count += 1;
    if (w.sample.length < STREAM_WARNING_SAMPLE) w.sample.push(id);
    this.warnCounts.set(code, w);
  }

  warnings(): StreamWarning[] {
    return STREAM_WARNINGS.filter((c) => this.warnCounts.has(c)).map((code) => {
      const w = this.warnCounts.get(code)!;
      return { code, count: w.count, sample: [...w.sample] };
    });
  }

  emit(u: Unit, out: Move[]): void {
    switch (u.src) {
      case 'WH': {
        const items = loadedItems(u.items, u.parent.id);
        this.sourceRows.WH_ENTRY += items.length;
        return this.emitWarehouse(u, items, out);
      }
      case 'VAN': {
        const items = loadedItems(u.items, u.parent.id);
        this.sourceRows.VAN_LOAD += items.length;
        return this.emitVan(u, items, out);
      }
      case 'AE': this.sourceRows.INVOICE += 1; return this.emitAccountEntry(u, out);
      case 'LOG': this.sourceRows.RESTOCK_LOG += 1; return this.emitRestockLog(u, out);
    }
  }

  private emitWarehouse(u: Extract<Unit, { src: 'WH' }>, items: readonly WhItemRow[], out: Move[]): void {
    const p = u.parent;
    for (const it of items) {
      const q = baseQtyOf(it);
      const base = {
        key: whItemKey(it.id), effectAt: p.createdAt, cursor: u.key, productId: it.productId, location: WH_LOCATION,
        refType: 'WH_ENTRY' as const, refId: p.id, itemId: it.id,
      };
      if (p.type === 'RECEIVE') {
        if (q > 0) {
          // قيمة السطر بوحدته (كـlineCost): الكمية × تكلفة الوحدة الصافية، مقرّبة لمنازل العملة مرة واحدة — ثابتة لأي وحدة
          const inValueMilli = it.unitCost != null && it.unitCost > 0 ? toMilli(it.qty * it.unitCost, this.decimals) : null;
          out.push({ ...base, kind: 'RECEIVE', baseQty: q, inValueMilli });
        } else if (q < 0) {
          this.warn('NEGATIVE_RECEIVE', it.id);
          out.push({ ...base, kind: 'WH_ADJUST', baseQty: q, reason: p.reason ?? null });
        }
      } else if (p.type === 'RETURN') {
        if (q !== 0) out.push({ ...base, kind: 'VENDOR_RETURN', baseQty: -Math.abs(q) });
      } else if (q !== 0) {
        // ADJUST (وأي نوعٍ قديم: composeWarehouse يعامل كل ما ليس RECEIVE تسويةً بإشارة كميتها — فتطابق كميةُ المستودع شاشته)
        out.push({ ...base, kind: p.zeroRunId ? 'ZERO_RUN' : 'WH_ADJUST', baseQty: q, reason: p.reason ?? null });
      }
    }
  }

  private emitVan(u: Extract<Unit, { src: 'VAN' }>, items: readonly VanItemRow[], out: Move[]): void {
    const p = u.parent;
    // حركةٌ بلا بنود لا أثر لها ولا تحذير (القراءة بالأب تراها، وكانت القراءة بالبنود لا تراها أصلاً)
    if (items.length === 0) return;
    // مفتاح السيارة: المندوب أو معرّفه المحفوظ بعد حذفه (vanKeyOf) — فلا تختلط سيارتا مندوبَين محذوفَين ولا تنتقل الحمولة بالحذف
    const van = vanLocation(vanKeyOf(p));
    const known = p.type === 'LOAD' || p.type === 'UNLOAD' || p.type === 'ADJUST' || p.type === 'DAMAGED_OUT' || p.type === 'EXPIRED_OUT';
    if (!known) {
      this.warn('UNKNOWN_VAN_TYPE', p.id);
      return;
    }
    for (const it of items) {
      const q = baseQtyOf(it);
      const base = {
        key: vanItemKey(it.id), effectAt: p.createdAt, cursor: u.key, productId: it.productId,
        refType: 'VAN_LOAD' as const, refId: p.id, itemId: it.id,
      };
      if (p.type === 'DAMAGED_OUT' || p.type === 'EXPIRED_OUT') {
        if (p.zeroRunId) {
          // إزالةٌ كتبها «تصفير المخزون»: معناها كبقية التصفير «رصيد السيارة صفر» ⇒ ZERO_RUN (هدفٌ مطلق، بلا أثر عادةً: التالف
          // والمنتهي مشطوبان يوم المرتجع فليسا في حالة التكلفة، وسطر المتاح يستنزفها). ويُستنزف ما بقي لصنفها حين لا سطر متاح
          // له — كمرتجعٍ طُوي عائداً قبل ختم «منتهي» المتأخر، فلا تبقى بضاعته في 114002 بعد التصفير
          out.push({ ...base, kind: 'ZERO_RUN', location: van, baseQty: -Math.abs(q), reason: p.type });
          continue;
        }
        // قيمته شُطبت يوم المرتجع (OD15) — مذكِّرة بلا كمية
        out.push({ ...base, kind: 'DAMAGE_OUT', location: van, baseQty: 0, reason: p.type });
        continue;
      }
      if (q === 0) continue;
      if (p.type === 'ADJUST') {
        out.push({ ...base, kind: p.zeroRunId ? 'ZERO_RUN' : 'VAN_ADJUST', location: van, baseQty: q, reason: p.reason ?? null });
        continue;
      }
      // سطر LOAD سالب = تنزيل، وسطر UNLOAD سالب = تحميل (E2): الاتجاه بإشارة الحركة الفعلية لا باسم المستند
      const toVan = (p.type === 'LOAD') === (q > 0);
      out.push(toVan
        ? { ...base, kind: 'VAN_LOAD', location: WH_LOCATION, toLocation: van, baseQty: -Math.abs(q) }
        : { ...base, kind: 'VAN_UNLOAD', location: van, toLocation: WH_LOCATION, baseQty: -Math.abs(q) });
    }
  }

  /** كمية بند الفاتورة بالأساس، أو null مع تحذيره (بلا صنف، أو كمية غير موجبة) */
  private itemQty(it: ItemFacts): number | null {
    if (!it.productId) {
      this.warn('ITEM_WITHOUT_PRODUCT', it.id);
      return null;
    }
    const q = baseQtyOf(it);
    if (!(q > 0)) {
      this.warn('NON_POSITIVE_SALE_QTY', it.id);
      return null;
    }
    return q;
  }

  private emitAccountEntry(u: Extract<Unit, { src: 'AE' }>, out: Move[]): void {
    const row = u.row;
    const inv = row.invoiceId ? this.facts.invoices.get(row.invoiceId) : undefined;
    if (!inv) {
      this.warn('UNKNOWN_INVOICE_TYPE', row.id);
      return;
    }
    // الإشعار المدين بنودُه بلا أصناف (D14) — لا أثر مخزني
    if (inv.documentKind === 'DEBIT_NOTE') return;
    const role = invoiceRole(inv.type, row.type);
    if (!role) {
      this.warn('UNKNOWN_INVOICE_TYPE', row.id);
      return;
    }
    const dup = `${inv.id}|${role}`;
    if (this.seenPrimary.has(dup)) {
      this.warn('DUPLICATE_PRIMARY_ROW', row.id);
      return;
    }
    this.seenPrimary.add(dup);

    // فاتورة بلا مندوب (فاتورة الإدارة، أو مندوب حُذف فصار null — D14) ⇒ المستودع (OD8)
    const loc: LocationKey = inv.salesRepId ? vanLocation(inv.salesRepId) : WH_LOCATION;
    const base = { effectAt: row.entryDate, cursor: u.key, refType: 'INVOICE' as const, refId: inv.id, location: loc };

    if (inv.type === 'RETURN') {
      if (role === 'POST') this.emitReturnPost(inv, base, out);
      else this.emitReturnCancel(inv, base, u.key, out);
      return;
    }
    for (const it of inv.items) {
      const q = this.itemQty(it);
      if (q === null) continue;
      if (role === 'POST') {
        out.push({ ...base, key: saleOutKey(it.id), kind: inv.salesRepId ? 'VAN_SALE' : 'WAREHOUSE_SALE', productId: it.productId!, itemId: it.id, baseQty: -q });
      } else {
        // الإلغاء (ومنه إبطال ZATCA بإبقاء التحصيل): دخلٌ بمرآة البيع إلى موقعه نفسه
        const sale = saleOutKey(it.id);
        out.push({ ...base, key: saleCancelKey(it.id), kind: 'SALE_CANCEL', productId: it.productId!, itemId: it.id, baseQty: q, links: { mirrorOf: sale, locationOf: sale } });
      }
    }
  }

  private emitReturnPost(inv: InvFacts, base: MoveBase, out: Move[]): void {
    const tl = restockTimeline(inv, this.facts.logsOf(inv.id), null);
    for (const it of inv.items) {
      const q = this.itemQty(it);
      if (q === null) continue;
      const sale = it.returnOfItemId ?? it.creditedItemId ?? null;
      const mirrorOf = sale ? saleOutKey(sale) : null;
      const perm = permanentWriteOff(inv, it);
      if (perm || !tl.initial) {
        out.push({
          ...base, key: returnKey(it.id), kind: 'RETURN_WRITE_OFF', productId: it.productId!, itemId: it.id,
          baseQty: 0, memoQty: q, links: { mirrorOf }, reason: perm ?? 'NOT_RESTOCKED',
        });
      } else {
        out.push({
          ...base, key: returnKey(it.id), kind: inv.salesRepId ? 'VAN_RETURN_RESTOCK' : 'WAREHOUSE_RETURN_RESTOCK',
          productId: it.productId!, itemId: it.id, baseQty: q, links: { mirrorOf },
        });
      }
    }
  }

  private emitReturnCancel(inv: InvFacts, base: MoveBase, cancelKey: CostCursor, out: Move[]): void {
    // الحالة لحظة الإلغاء: آخر تبديلٍ فعلي قبل صفّه، وإلا الابتدائية
    const tl = restockTimeline(inv, this.facts.logsOf(inv.id), cancelKey);
    for (const it of inv.items) {
      const q = this.itemQty(it);
      if (q === null) continue;
      const perm = permanentWriteOff(inv, it);
      const steps = emittedSteps(tl.steps, perm);
      // الصلتان معاً دائماً: الموقع من RET، وmemoOf = آخر أثرٍ مشتقٍّ للبند (RET أو آخر تبديل) — **المحرّك يقرّر بلقطته
      // المجمَّدة** (دخلٌ ⇒ خروج، شطبٌ ⇒ عكس مذكِّرته)، لا بحالة البند الآن: ختم «منتهي» بعد طيّ المرتجع عائداً يجعل الحالة
      // الحالية «مشطوباً» والبضاعة في الموقع. والكمية تخمين المصدر (−q عائد، 0 مشطوب) للبديل حين يغيب المرجع.
      out.push({
        ...base, key: returnCancelKey(it.id), kind: 'RETURN_CANCEL', productId: it.productId!, itemId: it.id,
        baseQty: !perm && tl.final ? -q : 0,
        links: { mirrorOf: null, locationOf: returnKey(it.id), memoOf: priorEffectKey(steps, steps.length, it.id) },
      });
    }
  }

  private emitRestockLog(u: Extract<Unit, { src: 'LOG' }>, out: Move[]): void {
    const log = u.row;
    const inv = this.facts.invoices.get(log.invoiceId);
    if (!inv || inv.type !== 'RETURN' || inv.documentKind === 'DEBIT_NOTE') {
      if (log.previous !== log.returnToStock) this.warn('UNKNOWN_INVOICE_TYPE', log.id);
      return;
    }
    const tl = restockTimeline(inv, this.facts.logsOf(inv.id), this.facts.cancelOf(inv.id));
    if (tl.afterCancel.has(log.id)) {
      this.warn('TOGGLE_AFTER_CANCEL', log.id);
      return;
    }
    const idx = tl.steps.findIndex((s) => s.logId === log.id);
    if (idx < 0) return; // سجلٌّ لا يغيّر الحالة
    const step = tl.steps[idx];
    const loc: LocationKey = inv.salesRepId ? vanLocation(inv.salesRepId) : WH_LOCATION;
    for (const it of inv.items) {
      const q = this.itemQty(it);
      if (q === null) continue;
      const perm = permanentWriteOff(inv, it);
      // المكتوب عليه: أول تبديلٍ إلى «لا يعود» وحده (emittedSteps) — يُخرج البضاعة إن طُوي RET عائداً قبل الختم
      if (perm && (idx > 0 || step.to)) continue;
      const sale = it.returnOfItemId ?? it.creditedItemId ?? null;
      const base = {
        key: restockToggleKey(log.id, it.id), kind: 'RESTOCK_TOGGLE' as const, effectAt: log.createdAt, cursor: u.key,
        productId: it.productId!, location: loc, refType: 'RESTOCK_LOG' as const, refId: log.id, itemId: it.id,
        ...(perm ? { reason: perm } : {}),
      };
      // memoOf = الأثر المشتقّ السابق للبند: المحرّك لا يُدخل بضاعةً عائدة ولا يُخرج مشطوبة (التبديل يوافق السلسلة المجمَّدة)
      const memoOf = priorEffectKey(tl.steps, idx, it.id);
      out.push(step.to
        ? { ...base, baseQty: q, links: { mirrorOf: sale ? saleOutKey(sale) : null, locationOf: returnKey(it.id), memoOf } }
        : { ...base, baseQty: -q, links: { mirrorOf: null, locationOf: returnKey(it.id), memoOf } });
    }
  }
}

type MoveBase = { effectAt: Date; cursor: CostCursor; refType: 'INVOICE'; refId: string; location: LocationKey };

// ═══ القراءة بصفحات ═══

/**
 * صفوف بمؤشّر (createdAt, id) حصري وحدّ until شامل — فهرس (tenantId, createdAt, id) على أعمدة الجدول نفسه (لا علاقة):
 * الحدّ الأدنى createdAt ≥ المؤشّر يبدأ المسح من موضعه في الفهرس، والـOR يُسقط صفوف اللحظة نفسها حتى معرّفه.
 */
function rowWindow(until: Date, after: CostCursor | null) {
  if (!after) return { createdAt: { lte: until } };
  return {
    createdAt: { gte: after.createdAt, lte: until },
    OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }],
  };
}

const ROW_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * بنود صفحة آباء بالمفتاح الأجنبي (IN مقسّمة، بترتيب (الأب، المعرّف)) مجمّعةً لكل أب — بنود كل أبٍ مرتّبة بمعرّفها.
 * بلا tenantId: الآباء مقروءة بشركتها، والبند لا يُرى إلا عبرها.
 */
async function itemsByParent<T>(
  parentIds: readonly string[], fetch: (ids: string[]) => Promise<T[]>, parentOf: (r: T) => string,
): Promise<Map<string, T[]>> {
  const by = new Map<string, T[]>(parentIds.map((id) => [id, []]));
  for (const part of chunks(parentIds, IN_CHUNK)) {
    for (const r of await fetch(part)) by.get(parentOf(r))?.push(r);
  }
  return by;
}

/**
 * حركات المخزون بعد afterCursor حتى until (شاملاً لـcreatedAt)، مرتّبة بـcompareMoves.
 * cursor الناتج = آخر صفّ مصدر أُخرج بأمان (كل صفّ ≤ هذا قُرئ من كل المصادر) — يُمرَّر afterCursor للدفعة التالية.
 * maxMoves: يتوقّف عند حدّ صفّ مصدر كامل (لا يُشطر صفّ بين دفعتين) بعد بلوغ السقف.
 */
export async function loadMoves(db: CostingDb, tenantId: string, opts: LoadMovesOptions): Promise<LoadMovesResult> {
  const maxMoves = opts.maxMoves ?? Number.POSITIVE_INFINITY;
  if (!(maxMoves > 0)) throw new RangeError(`maxMoves غير صالح: ${maxMoves}`);
  const pageSize = opts.pageSize ?? Math.min(DEFAULT_PAGE_SIZE, Math.ceil(maxMoves));
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError(`pageSize غير صالح: ${pageSize}`);
  const until = opts.until;
  const after0 = opts.afterCursor ?? null;
  const facts = new Facts(db, tenantId);
  const deriver = new Deriver(facts, opts.currencyDecimals);
  // تحقّق مبكر من المنازل (toMilli يرمي لغير 0..3) — قبل أي قراءة
  toMilli(0, opts.currencyDecimals);

  const wh = new PagedSource('WH', pageSize, after0, async (after, take) => {
    const parents: WhParent[] = await db.warehouseEntry.findMany({
      where: { tenantId, ...rowWindow(until, after) }, orderBy: ROW_ORDER, take, select: WH_PARENT_SELECT,
    });
    return parents.map((p): Unit => ({ src: 'WH', key: { createdAt: p.createdAt, id: p.id }, parent: p, items: null }));
  });

  const van = new PagedSource('VAN', pageSize, after0, async (after, take) => {
    const parents: VanParent[] = await db.vanLoad.findMany({
      where: { tenantId, ...rowWindow(until, after) }, orderBy: ROW_ORDER, take, select: VAN_PARENT_SELECT,
    });
    return parents.map((p): Unit => ({ src: 'VAN', key: { createdAt: p.createdAt, id: p.id }, parent: p, items: null }));
  });

  /**
   * بنود الآباء التي ستخرج: من units[from] فصاعداً حتى limit أبٍ غير محمَّل لكل مصدر، بـIN واحدة مقسّمة لكل مصدر.
   * ⚠️ warehouse_entry_items بلا فهرس entryId في المخطط (productId وlotId وحدهما): IN تمسح الجدول مرةً لكل تحميل (لا لكل
   * صفحة بنود كما كان) — والفهرس قرار المعماري. وvan_load_items مفهرسة بـvanLoadId.
   */
  const loadItems = async (units: readonly Unit[], from: number, limit: number): Promise<void> => {
    const whs: Extract<Unit, { src: 'WH' }>[] = [];
    const vans: Extract<Unit, { src: 'VAN' }>[] = [];
    for (let k = from; k < units.length && (whs.length < limit || vans.length < limit); k++) {
      const u = units[k];
      if (u.src === 'WH' && u.items === null && whs.length < limit) whs.push(u);
      else if (u.src === 'VAN' && u.items === null && vans.length < limit) vans.push(u);
    }
    if (whs.length > 0) {
      const by = await itemsByParent<WhItemRow & { entryId: string }>(whs.map((u) => u.parent.id), (ids) => db.warehouseEntryItem.findMany({
        where: { entryId: { in: ids } }, orderBy: [{ entryId: 'asc' }, { id: 'asc' }], select: WH_ITEM_SELECT,
      }), (r) => r.entryId);
      for (const u of whs) u.items = by.get(u.parent.id) ?? [];
    }
    if (vans.length > 0) {
      const by = await itemsByParent<VanItemRow & { vanLoadId: string }>(vans.map((u) => u.parent.id), (ids) => db.vanLoadItem.findMany({
        where: { vanLoadId: { in: ids } }, orderBy: [{ vanLoadId: 'asc' }, { id: 'asc' }], select: VAN_ITEM_SELECT,
      }), (r) => r.vanLoadId);
      for (const u of vans) u.items = by.get(u.parent.id) ?? [];
    }
  };

  const ae = new PagedSource('AE', pageSize, after0, async (after, take) => {
    const rows: AeRow[] = await db.accountEntry.findMany({
      where: {
        tenantId, invoiceId: { not: null }, receiptId: null, type: { in: [...PRIMARY_ENTRY_TYPES] },
        ...rowWindow(until, after),
      },
      orderBy: ROW_ORDER, take, select: AE_SELECT,
    });
    if (rows.length > 0) {
      const ids = rows.map((r) => r.invoiceId).filter((x): x is string => !!x);
      await facts.ensureInvoices(ids);
      const returns = [...new Set(ids)].filter((id) => facts.invoices.get(id)?.type === 'RETURN');
      if (returns.length > 0) await facts.refreshLogs(returns);
    }
    return rows.map((r): Unit => ({ src: 'AE', key: { createdAt: r.createdAt, id: r.id }, row: r }));
  });

  const log = new PagedSource('LOG', pageSize, after0, async (after, take) => {
    const rows: LogRow[] = await db.invoiceRestockLog.findMany({
      where: { tenantId, ...rowWindow(until, after) },
      orderBy: ROW_ORDER, take, select: LOG_SELECT,
    });
    if (rows.length > 0) {
      const ids = [...new Set(rows.map((r) => r.invoiceId))];
      await facts.ensureInvoices(ids);
      const returns = ids.map((id) => facts.invoices.get(id)).filter((i): i is InvFacts => i?.type === 'RETURN');
      if (returns.length > 0) {
        await facts.refreshLogs(returns.map((i) => i.id));
        const upTo = new Date(Math.max(...rows.map((r) => r.createdAt.getTime())));
        await facts.refreshCancels(returns, upTo);
      }
    }
    return rows.map((r): Unit => ({ src: 'LOG', key: keyOfLog(r), row: r }));
  });

  const sources = [wh, van, ae, log];
  // تسلسلياً: عميل المعاينة/المعاملة اتصالٌ واحد، والتوازي لا يكسب شيئاً عليه
  for (const s of sources) await s.fill();

  const moves: Move[] = [];
  let cursor: CostCursor | null = null;
  let stopKey: CostCursor | null = null;
  let truncated = false;

  for (;;) {
    const active = sources.filter((s) => !s.exhausted);
    let bound: CostCursor | null = null;
    for (const s of active) {
      const f = s.frontier;
      if (f && (!bound || compareCursors(f, bound) < 0)) bound = f;
    }
    const safe: Unit[] = [];
    for (const s of sources) {
      let n = 0;
      while (n < s.ready.length && (!bound || compareCursors(s.ready[n].key, bound) < 0)) n++;
      if (n > 0) safe.push(...s.ready.splice(0, n));
    }
    safe.sort((a, b) => compareCursors(a.key, b.key) || SRC_RANK[a.src] - SRC_RANK[b.src]);

    let i = 0;
    for (; i < safe.length; i++) {
      const u = safe[i];
      if (stopKey && compareCursors(u.key, stopKey) !== 0) break;
      // بنود الآباء قبيل إخراجها: بلا سقف ⇒ كل ما في الدفعة الآمنة مرةً واحدة؛ وبسقفٍ ⇒ ما يكفي ما بقي منه وحده (كل أبٍ
      // ببنوده حركةٌ على الأقل عادةً)، فلا تُقرأ بنود صفحة آباء كاملة لدفعة لن تُخرج منها إلا بعضها
      if ((u.src === 'WH' || u.src === 'VAN') && u.items === null) {
        await loadItems(safe, i, Number.isFinite(maxMoves) ? Math.max(1, Math.ceil(maxMoves) - moves.length) : Number.POSITIVE_INFINITY);
      }
      deriver.emit(u, moves);
      cursor = u.key;
      if (!stopKey && moves.length >= maxMoves) stopKey = u.key;
    }
    if (stopKey) {
      truncated = i < safe.length || sources.some((s) => s.ready.length > 0 || s.tail !== null || !s.exhausted);
      break;
    }
    if (!bound) break;
    // المصادر التي حدّها هو الحدّ الأدنى تتقدّم صفحة (وحدها: البقية ما زالت أمامها)
    for (const s of active) {
      const f = s.frontier;
      if (f && compareCursors(f, bound) === 0) await s.fill();
    }
  }

  moves.sort(compareMoves);
  return { moves, cursor, truncated, sourceRows: { ...deriver.sourceRows }, warnings: deriver.warnings() };
}
