/**
 * لقطات التكلفة ونقاط الحفظ («ربط الدفاتر» L3 — العقد scratchpad/l23_contract.md §7): تجميد ناتج محرّك التكلفة الوحيد
 * في gl_cost_snapshots (صفّ لكل أثر حركة) وgl_cost_checkpoints (حالة كل (صنف، موقع) عند مؤشّر).
 *
 * كتابة غير متزامنة بمعاملات قصيرة مستقلة — لا داخل معاملة البيع، ولا كتابة إلا في gl_cost_* (اختبار تجسّس).
 * كل معاملة كتابة: أول عبارة القفل الاستشاري pg_advisory_xact_lock(hashtext('gl-cost:'||tid))، ثم التحقّق أن أحدث لقطة
 * ما زالت ما بنينا عليه (وإلا تشغيلٌ آخر سبقنا ⇒ CONCURRENT ونتوقّف بلا كتابة)، ثم اللقطات (createMany skipDuplicates)،
 * ثم مجموعة الحفظ إن استحقّت: حذف الزائد على ثلاث مجموعات، ثم الصفوف، ثم صفّ الرأس آخراً (فلا تُقرأ مجموعة ناقصة).
 *
 * الاستئناف («الإعادة من نقطة حفظ = الإعادة الكاملة حرفياً»):
 *  نقاط الحفظ كل CHECKPOINT_MIN_MOVES حركة لا كل تشغيل (القاعدة ٠٫١ نواة: مجموعة حفظ قد تبلغ آلاف الصفوف)، فبين آخر نقطة
 *  حفظ C وآخر لقطة L لقطاتٌ ليست في الحالة المحفوظة. تُعاد طيّاً («إعادة الطيّ») **من اللقطات المجمَّدة نفسها لا من
 *  المصادر**: كل لقطة تُطوى حركةً اصطناعية تعيد أثرها على الحالة حرفياً (الخروج بكميته من موقعه — الخروج تحدّده الحالة وحدها؛
 *  والدخول بأجزائه المجمَّدة (مقيَّم، قيمة، غير مقيَّم) عبر مرآة لقطة اصطناعية؛ والتحويل بنوعه وموقعيه). فما يتبدّل في المصادر
 *  بعد الطيّ — حذف المندوب (فاتورته تصير «فاتورة إدارة»)، ختم الصلاحية بعد الإصدار، حذف صفّ — لا يغيّر ما طُوي يومها.
 *  ويُطابَق ناتج كل خطوة باللقطة (الكمية والقيمة والفرق والخارج عن التقييم): فرقٌ ⇒ COST_REFOLD_MISMATCH قبل أي كتابة
 *  (فشلٌ مغلق: نقطة حفظ أو لقطة عُبث بها، أو تغيّرت حسابات المحرّك — لا لقطة جديدة فوق حالة انجرفت).
 *
 * الوصول المتأخر (صفّ مصدرٍ التزمت معاملته بعد أن تجاوزه المؤشّر — أطول من نافذة الالتزام المتأخر): يُكشف بمسح نافذة
 *  LATE_SCAN_LOOKBACK_MS قبل أبعد موضع مكتوب (findLateMoves)، ويُطوى في موضع ظهوره (بعد كل ما طُوي) بـlateArrival=true،
 *  **وتُكتب نقطة حفظ في المعاملة نفسها** — فلا تمرّ إعادة طيٍّ لاحقة بلقطته بترتيبه الطبيعي (مؤشّره المحفوظ قبل موضع طيّه):
 *  كل لقطة بعد آخر نقطة حفظ طُويت بترتيبها الطبيعي، وهذا ما يجعل Σ اللقطات = الحالة دائماً.
 *
 * لا تستدعيه أي شيفرة إنتاجية في هذه الدفعة (D6) — L7 يجدوله للشركات المربوطة.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { fromQtyU, toQtyU } from './math';
import { compareCursors, createCostState, locStateKey, replay, snapshotRefOf, splitLocStateKey } from './stepper';
import { loadMoves, maxCursor, type CostingDb } from './streams';
import type {
  CostCursor, CostState, LocationKey, Move, MoveKind, SnapshotLookup, SnapshotRef, StepOutput, StepperConfig,
} from './types';

/** pg_advisory_xact_lock(hashtext('gl-cost:'||tid)) أول عبارة في كل معاملة */
export const COST_LOCK_PREFIX = 'gl-cost:';
/** مجموعة حفظ جديدة بعد هذا العدد من الحركات المطويّة منذ الأخيرة (وفي آخر التشغيل إن تجاوزه) */
export const CHECKPOINT_MIN_MOVES = 5_000;
export const CHECKPOINT_KEEP_SETS = 3;
/** حركات كل دفعة (= صفوف لقطات كل معاملة كتابة تقريباً) */
export const SNAPSHOT_BATCH = 1_000;
/** نافذة مسح الوصول المتأخر قبل المؤشّر (كشبكة أمان المُطابِق SAFETY_NET_LOOKBACK_MS) */
export const LATE_SCAN_LOOKBACK_MS = 24 * 60 * 60_000;
/**
 * = LATE_COMMIT_WINDOW_MS في services/gl/sync/types.ts — مكرَّرٌ لا مستورد (حارس costing-static: لا شيء من services/gl
 * إلا money/dates/types)، واختبار costing-snapshots يثبت التطابق.
 */
export const COST_LATE_COMMIT_WINDOW_MS = 10 * 60_000;
/** productId/location صفّ الرأس */
export const CHECKPOINT_HEAD = '*';

const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 };
const KEY_CHUNK = 1_000;
const CHECKPOINT_CHUNK = 2_000;

export type SnapshotDb = CostingDb & Pick<Prisma.TransactionClient, 'glCostSnapshot' | 'glCostCheckpoint' | '$executeRaw' | '$queryRaw'>;

export interface ComputeSnapshotsOptions {
  currencyDecimals: number;
  /** الحدّ الأعلى لـcreatedAt المصدر (الافتراضي dbNow − LATE_COMMIT_WINDOW_MS) */
  horizon?: Date;
  /** سقف الحركات الجديدة (الطيّ الجديد والمتأخر) في هذا التشغيل — يتوقّف عند حدّ صفّ مصدر ⇒ BUDGET */
  maxMoves?: number;
  clock?: () => number;
  /** لحظة clock() التي لا تبدأ بعدها دفعة جديدة ⇒ BUDGET */
  deadline?: number;
  /** مسح نافذة الوصول المتأخر (الافتراضي true) — للمجدول أن يجريه دورياً كشبكة أمان المُطابِق */
  lateScan?: boolean;
  /** ضبط للاختبار والقياس وحدهما (الإنتاج يترك الثوابت) */
  tuning?: { batchSize?: number; checkpointMinMoves?: number; pageSize?: number };
}

export interface ComputeSnapshotsResult {
  /** الحركات الجديدة والمتأخرة المطويّة والمكتوبة في هذا التشغيل (إعادة الطيّ لا تُحتسب: هي ما كُتب سابقاً) */
  movesFolded: number;
  snapshotsWritten: number;
  checkpointWritten: boolean;
  lateArrivals: number;
  /** آخر موضع مكتوب (كل صفّ مصدر ≤ هذا طُوي وجُمِّد) — null إن لم يُكتب شيء قطّ */
  cursor: CostCursor | null;
  stoppedBy: 'DONE' | 'BUDGET' | 'CONCURRENT';
}

/** صفّ نقطة حفظ كما يُقرأ */
export interface CheckpointRowLike {
  productId: string;
  location: string;
  cursorAt: Date;
  cursorId: string;
  qtyBase: number;
  uncostedQty: number;
  valueMilli: bigint;
  lastAvgValueMilli: bigint | null;
  lastAvgQty: number | null;
  movesFolded: number;
}

/** صفّ لقطة كما يُقرأ (ما يلزم لحلّ الصلات) */
export interface SnapshotRowLike {
  sourceKey: string;
  kind: string;
  productId: string;
  location: string;
  toLocation: string | null;
  baseQty: number;
  uncostedQty: number;
  valueMilli: bigint;
  varianceMilli: bigint;
  memoMilli: bigint;
  effectAt: Date;
}

/** صفّ لقطة مخزَّن بمؤشّره (لإعادة الطيّ والتحقّق) */
interface StoredSnapshot extends SnapshotRowLike {
  srcCreatedAt: Date;
  srcId: string;
  lateArrival: boolean;
}

const SNAPSHOT_SELECT = {
  sourceKey: true, kind: true, productId: true, location: true, toLocation: true, baseQty: true, uncostedQty: true,
  valueMilli: true, varianceMilli: true, memoMilli: true, effectAt: true, srcCreatedAt: true, srcId: true, lateArrival: true,
} as const;

const CHECKPOINT_SELECT = {
  productId: true, location: true, cursorAt: true, cursorId: true, qtyBase: true, uncostedQty: true, valueMilli: true,
  lastAvgValueMilli: true, lastAvgQty: true, movesFolded: true,
} as const;

/** إعادة الطيّ لم تطابق اللقطات المجمَّدة — مصدرٌ حُذف أو عُدّل بعد طيّه (فشلٌ مغلق قبل أي كتابة) */
export class CostRefoldMismatchError extends Error {
  readonly code = 'COST_REFOLD_MISMATCH';
  constructor(readonly tenantId: string, readonly details: string[]) {
    super(`COST_REFOLD_MISMATCH (${tenantId}): ${details.slice(0, 5).join(' | ')}`);
  }
}

/** إشارة داخلية: تشغيلٌ آخر كتب بعد قراءتنا — تُلغي المعاملة بلا كتابة */
class ConcurrentRunSignal extends Error {}

function chunks<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function sameCursor(a: CostCursor | null, b: CostCursor | null): boolean {
  if (!a || !b) return a === b;
  return compareCursors(a, b) === 0;
}

// ═══ تحويلات صرفة ═══

/** صفّ لقطة من ناتج خطوة (السبب والحالة بعد الحركة للذاكرة وحدها — لا أعمدة لها) */
export function snapshotRow(tenantId: string, o: StepOutput): Prisma.GlCostSnapshotCreateManyInput {
  return {
    tenantId, sourceKey: o.key, kind: o.kind, refType: o.refType, refId: o.refId, itemId: o.itemId, productId: o.productId,
    location: o.location, toLocation: o.toLocation, baseQty: o.baseQty, uncostedQty: o.uncostedQty,
    valueMilli: o.valueMilli, varianceMilli: o.varianceMilli, memoMilli: o.memoMilli, unitCostE4: o.unitCostE4, method: 'AVCO',
    effectAt: o.effectAt, srcCreatedAt: o.srcCreatedAt, srcId: o.srcId, lateArrival: o.lateArrival,
  };
}

export function snapshotRefFromRow(row: SnapshotRowLike): SnapshotRef {
  return {
    key: row.sourceKey,
    kind: row.kind as MoveKind,
    productId: row.productId,
    location: row.location as LocationKey,
    toLocation: (row.toLocation ?? null) as LocationKey | null,
    baseQty: row.baseQty,
    uncostedQty: row.uncostedQty,
    valueMilli: BigInt(row.valueMilli),
    varianceMilli: BigInt(row.varianceMilli),
    memoMilli: BigInt(row.memoMilli),
    effectAt: row.effectAt,
  };
}

/**
 * صفوف مجموعة حفظ: (صنف، موقع) فيه أي غير صفر (كمية أو قيمة أو آخر متوسّط) بترتيب المفتاح، ثم صفّ الرأس **آخراً**
 * (productId = location = '*' وmovesFolded). الكميات Float بستّ منازل (ذهاب-إياب الميكرو دقيق).
 */
export function checkpointRows(tenantId: string, state: CostState, cursor: CostCursor): Prisma.GlCostCheckpointCreateManyInput[] {
  const rows: Prisma.GlCostCheckpointCreateManyInput[] = [];
  const keys = [...state.locs.keys()].sort();
  for (const k of keys) {
    const s = state.locs.get(k)!;
    if (s.costedQtyU === 0 && s.uncostedQtyU === 0 && s.valueMilli === 0n && s.lastAvg === null) continue;
    const { productId, location } = splitLocStateKey(k);
    rows.push({
      tenantId, productId, location, cursorAt: cursor.createdAt, cursorId: cursor.id,
      qtyBase: fromQtyU(s.costedQtyU + s.uncostedQtyU), uncostedQty: fromQtyU(s.uncostedQtyU), valueMilli: s.valueMilli,
      lastAvgValueMilli: s.lastAvg ? s.lastAvg.valueMilli : null, lastAvgQty: s.lastAvg ? fromQtyU(s.lastAvg.qtyU) : null,
      movesFolded: 0,
    });
  }
  rows.push({
    tenantId, productId: CHECKPOINT_HEAD, location: CHECKPOINT_HEAD, cursorAt: cursor.createdAt, cursorId: cursor.id,
    qtyBase: 0, uncostedQty: 0, valueMilli: 0n, lastAvgValueMilli: null, lastAvgQty: null, movesFolded: state.movesFolded,
  });
  return rows;
}

/** الحالة من صفوف مجموعة حفظ (صفّ الرأس يعطي المؤشّر وmovesFolded) */
export function stateFromCheckpointRows(rows: readonly CheckpointRowLike[]): CostState {
  const st = createCostState();
  const sorted = [...rows].sort((a, b) => (a.productId + '|' + a.location < b.productId + '|' + b.location ? -1 : 1));
  for (const r of sorted) {
    if (r.productId === CHECKPOINT_HEAD && r.location === CHECKPOINT_HEAD) {
      st.movesFolded = r.movesFolded;
      st.cursor = { createdAt: new Date(r.cursorAt.getTime()), id: r.cursorId };
      continue;
    }
    const totalU = toQtyU(r.qtyBase);
    const uqU = toQtyU(r.uncostedQty);
    st.locs.set(locStateKey(r.productId, r.location as LocationKey), {
      costedQtyU: totalU - uqU,
      uncostedQtyU: uqU,
      valueMilli: BigInt(r.valueMilli),
      lastAvg: r.lastAvgValueMilli !== null && r.lastAvgQty !== null
        ? { valueMilli: BigInt(r.lastAvgValueMilli), qtyU: toQtyU(r.lastAvgQty) }
        : null,
    });
  }
  return st;
}

// ═══ قراءات ═══

async function readDbNow(db: Pick<SnapshotDb, '$queryRaw'>): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return new Date(rows[0].now);
}

/** أحدث لقطة بترتيب المحرّك (فهرس tenantId, srcCreatedAt, srcId) */
async function latestSnapshotCursor(db: Pick<SnapshotDb, 'glCostSnapshot'>, tenantId: string): Promise<CostCursor | null> {
  const r = await db.glCostSnapshot.findFirst({
    where: { tenantId }, orderBy: [{ srcCreatedAt: 'desc' }, { srcId: 'desc' }], select: { srcCreatedAt: true, srcId: true },
  });
  return r ? { createdAt: r.srcCreatedAt, id: r.srcId } : null;
}

/** لقطات مخزَّنة بالمفتاح (فهرس التفرّد tenantId, sourceKey) — بقوائم مقسّمة */
async function fetchStored(db: Pick<SnapshotDb, 'glCostSnapshot'>, tenantId: string, keys: readonly string[]): Promise<Map<string, StoredSnapshot>> {
  const out = new Map<string, StoredSnapshot>();
  for (const part of chunks([...new Set(keys)].sort(), KEY_CHUNK)) {
    const rows = await db.glCostSnapshot.findMany({ where: { tenantId, sourceKey: { in: part } }, select: SNAPSHOT_SELECT });
    for (const r of rows) out.set(r.sourceKey, r);
  }
  return out;
}

/** أيّ هذه المفاتيح مجمَّد؟ (المفتاح وحده — مسح نافذة المتأخر يسأل عن كل حركات يوم، وأغلبها موجود) */
async function existingKeys(db: Pick<SnapshotDb, 'glCostSnapshot'>, tenantId: string, keys: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(keys)].sort(), KEY_CHUNK)) {
    const rows = await db.glCostSnapshot.findMany({ where: { tenantId, sourceKey: { in: part } }, select: { sourceKey: true } });
    for (const r of rows) out.add(r.sourceKey);
  }
  return out;
}

export async function loadLatestCheckpoint(db: SnapshotDb, tenantId: string): Promise<{ state: CostState; cursor: CostCursor } | null> {
  const head = await db.glCostCheckpoint.findFirst({
    where: { tenantId, productId: CHECKPOINT_HEAD, location: CHECKPOINT_HEAD },
    orderBy: [{ cursorAt: 'desc' }, { cursorId: 'desc' }],
    select: { cursorAt: true, cursorId: true },
  });
  if (!head) return null;
  const rows = await db.glCostCheckpoint.findMany({
    where: { tenantId, cursorAt: head.cursorAt, cursorId: head.cursorId }, select: CHECKPOINT_SELECT,
  });
  return { state: stateFromCheckpointRows(rows), cursor: { createdAt: head.cursorAt, id: head.cursorId } };
}

/**
 * صفوف مصدر (createdAt, id) ≤ المؤشّر بلا لقطة خلال LATE_SCAN_LOOKBACK_MS قبله — تُطوى في موضع ظهورها بـlateArrival=true.
 * الاشتقاق بـloadMoves نفسها (حركةٌ متأخرة تُشتقّ كما كانت ستُشتقّ في موضعها)، والوجود بالمفتاح لا بالمؤشّر: صفٌّ أساسي
 * مكرَّر أحدث مفتاحُه موجود فليس متأخراً.
 */
export async function findLateMoves(db: SnapshotDb, tenantId: string, cursor: CostCursor, opts: { currencyDecimals: number; pageSize?: number }): Promise<Move[]> {
  const from = new Date(cursor.createdAt.getTime() - LATE_SCAN_LOOKBACK_MS);
  const r = await loadMoves(db, tenantId, {
    afterCursor: { createdAt: from, id: '' }, until: cursor.createdAt, currencyDecimals: opts.currencyDecimals, pageSize: opts.pageSize,
  });
  const cands = r.moves.filter((m) => compareCursors(m.cursor, cursor) <= 0);
  if (cands.length === 0) return [];
  const existing = await existingKeys(db, tenantId, cands.map((m) => m.key));
  return cands.filter((m) => !existing.has(m.key)).map((m) => ({ ...m, lateArrival: true }));
}

// ═══ الكتابة ═══

async function writeCheckpoint(tx: Pick<SnapshotDb, 'glCostCheckpoint'>, tenantId: string, state: CostState, cursor: CostCursor): Promise<void> {
  const heads = await tx.glCostCheckpoint.findMany({
    where: { tenantId, productId: CHECKPOINT_HEAD, location: CHECKPOINT_HEAD },
    orderBy: [{ cursorAt: 'desc' }, { cursorId: 'desc' }],
    select: { cursorAt: true, cursorId: true },
  });
  const same = heads.filter((h) => sameCursor({ createdAt: h.cursorAt, id: h.cursorId }, cursor));
  const others = heads.filter((h) => !sameCursor({ createdAt: h.cursorAt, id: h.cursorId }, cursor));
  // المجموعة بالمؤشّر نفسه تُستبدل (طيٌّ متأخر عند المؤشّر نفسه غيّر حالتها)، والأقدم من آخر ثلاث تُحذف — قبل الكتابة
  // فيبقى الرأس الجديد آخر ما يُكتب في المعاملة
  for (const h of [...same, ...others.slice(CHECKPOINT_KEEP_SETS - 1)]) {
    await tx.glCostCheckpoint.deleteMany({ where: { tenantId, cursorAt: h.cursorAt, cursorId: h.cursorId } });
  }
  const rows = checkpointRows(tenantId, state, cursor);
  const head = rows.pop()!;
  for (const part of chunks(rows, CHECKPOINT_CHUNK)) await tx.glCostCheckpoint.createMany({ data: part });
  await tx.glCostCheckpoint.createMany({ data: [head] });
}

interface BatchWrite {
  outputs: readonly StepOutput[];
  expectedLatest: CostCursor | null;
  checkpoint: { state: CostState; cursor: CostCursor } | null;
}

async function writeBatch(
  db: { $transaction: PrismaClient['$transaction'] }, tenantId: string, w: BatchWrite,
): Promise<{ written: number } | 'CONCURRENT'> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COST_LOCK_PREFIX + tenantId}::text))`;
      const cur = await latestSnapshotCursor(tx, tenantId);
      if (!sameCursor(cur, w.expectedLatest)) throw new ConcurrentRunSignal();
      let written = 0;
      for (const part of chunks(w.outputs, SNAPSHOT_BATCH)) {
        const r = await tx.glCostSnapshot.createMany({ data: part.map((o) => snapshotRow(tenantId, o)), skipDuplicates: true });
        written += r.count;
      }
      if (w.checkpoint) await writeCheckpoint(tx, tenantId, w.checkpoint.state, w.checkpoint.cursor);
      return { written };
    }, TX_OPTIONS);
  } catch (e) {
    if (e instanceof ConcurrentRunSignal) return 'CONCURRENT';
    throw e;
  }
}

// ═══ إعادة الطيّ من اللقطات ═══

const REFOLD_PAGE = 2_000;
/** مفتاح لقطة اصطناعية تحمل أجزاء دخلٍ مجمَّد (لا يصطدم بمفاتيح COST:) */
const SYNTH_PREFIX = 'REFOLD:';

/**
 * حركة اصطناعية تعيد أثر لقطة مجمَّدة على الحالة حرفياً:
 * - كمية صفرية (مذكِّرة، أو لا شيء): DAMAGE_OUT — لا أثر، وmovesFolded يتقدّم كما تقدّم يومها؛
 * - تحويل: بنوعه وموقعيه وكميته (الخروج من المصدر تحدّده الحالة، والهدف يمتصّ أجزاءه)؛
 * - خروج: تسويةٌ سالبة بكميته من موقعه (كل خروج في المحرّك takeOut واحد تحدّده الحالة والموقع وحدهما)؛
 * - دخول: SALE_CANCEL بمرآة لقطة اصطناعية بكميته نفسها {−q، الخارج عن التقييم uq، −G} — المرآة بالكمية الكاملة تعيد
 *   الأجزاء (q − uq، G، uq) بلا تقريب، وG = Δ + الفرق (الدخول: variance = G − Δ).
 */
function frozenMove(s: StoredSnapshot): { move: Move; ref: SnapshotRef | null } {
  const kind = s.kind as MoveKind;
  const location = s.location as LocationKey;
  const base = {
    key: s.sourceKey, effectAt: s.effectAt, cursor: { createdAt: s.srcCreatedAt, id: s.srcId }, productId: s.productId,
    location, refType: 'WH_ENTRY' as const, refId: s.srcId, itemId: s.sourceKey,
  };
  const qU = toQtyU(s.baseQty);
  if (qU === 0) return { move: { ...base, kind: 'DAMAGE_OUT', baseQty: 0 }, ref: null };
  if (kind === 'VAN_LOAD' || kind === 'VAN_UNLOAD') {
    return { move: { ...base, kind, toLocation: (s.toLocation ?? null) as LocationKey | null, baseQty: s.baseQty }, ref: null };
  }
  if (qU < 0) return { move: { ...base, kind: 'WH_ADJUST', baseQty: s.baseQty }, ref: null };
  const synth = SYNTH_PREFIX + s.sourceKey;
  const g = BigInt(s.valueMilli) + BigInt(s.varianceMilli);
  const ref: SnapshotRef = {
    key: synth, kind: 'WAREHOUSE_SALE', productId: s.productId, location, toLocation: null,
    baseQty: -s.baseQty, uncostedQty: s.uncostedQty, valueMilli: -g, varianceMilli: 0n, memoMilli: 0n, effectAt: s.effectAt,
  };
  return { move: { ...base, kind: 'SALE_CANCEL', baseQty: s.baseQty, links: { mirrorOf: synth } }, ref };
}

/** ناتج الخطوة الاصطناعية يطابق أثر اللقطة على الحالة؟ (المذكِّرة والنوع لا يمسّان الحالة فلا يُقارنان) */
function frozenMismatch(o: StepOutput, s: StoredSnapshot): string | null {
  const diffs: string[] = [];
  if (o.location !== s.location) diffs.push(`location ${o.location}≠${s.location}`);
  if ((o.toLocation ?? null) !== (s.toLocation ?? null)) diffs.push(`toLocation ${o.toLocation}≠${s.toLocation}`);
  if (toQtyU(o.baseQty) !== toQtyU(s.baseQty)) diffs.push(`baseQty ${o.baseQty}≠${s.baseQty}`);
  if (toQtyU(o.uncostedQty) !== toQtyU(s.uncostedQty)) diffs.push(`uncostedQty ${o.uncostedQty}≠${s.uncostedQty}`);
  if (o.valueMilli !== BigInt(s.valueMilli)) diffs.push(`valueMilli ${o.valueMilli}≠${s.valueMilli}`);
  if (o.varianceMilli !== BigInt(s.varianceMilli)) diffs.push(`varianceMilli ${o.varianceMilli}≠${s.varianceMilli}`);
  return diffs.length ? `${s.sourceKey}: ${diffs.join(', ')}` : null;
}

/** لقطات (after, upTo] بترتيب المحرّك، بصفحات على فهرس (tenantId, srcCreatedAt, srcId) */
async function* storedBetween(
  db: Pick<SnapshotDb, 'glCostSnapshot'>, tenantId: string, after: CostCursor | null, upTo: CostCursor,
): AsyncGenerator<StoredSnapshot[]> {
  // المؤشّر الداخلي ثلاثي (srcCreatedAt, srcId, sourceKey): صفّ مصدرٍ واحد قد يحمل لقطات أكثر من الصفحة
  let cur: { at: Date; id: string; key: string | null } | null = after ? { at: after.createdAt, id: after.id, key: null } : null;
  const upToWhere: Prisma.GlCostSnapshotWhereInput = {
    OR: [{ srcCreatedAt: { lt: upTo.createdAt } }, { srcCreatedAt: upTo.createdAt, srcId: { lte: upTo.id } }],
  };
  for (;;) {
    const AND: Prisma.GlCostSnapshotWhereInput[] = [upToWhere];
    if (cur) {
      const OR: Prisma.GlCostSnapshotWhereInput[] = [
        { srcCreatedAt: { gt: cur.at } },
        { srcCreatedAt: cur.at, srcId: { gt: cur.id } },
      ];
      if (cur.key !== null) OR.push({ srcCreatedAt: cur.at, srcId: cur.id, sourceKey: { gt: cur.key } });
      AND.push({ OR });
    }
    const rows: StoredSnapshot[] = await db.glCostSnapshot.findMany({
      where: { tenantId, srcCreatedAt: cur ? { gte: cur.at, lte: upTo.createdAt } : { lte: upTo.createdAt }, AND },
      orderBy: [{ srcCreatedAt: 'asc' }, { srcId: 'asc' }, { sourceKey: 'asc' }],
      take: REFOLD_PAGE,
      select: SNAPSHOT_SELECT,
    });
    if (rows.length > 0) yield rows;
    if (rows.length < REFOLD_PAGE) return;
    const last = rows[rows.length - 1];
    cur = { at: last.srcCreatedAt, id: last.srcId, key: last.sourceKey };
  }
}

/** مفاتيح صلات الحركة: خصائص كائن الصلات **الذاتية** النصّية وحدها (لا الموروثة من النموذج الأولي) */
function linkKeysOf(m: Move): string[] {
  const l = m.links;
  if (!l) return [];
  const out: string[] = [];
  for (const f of ['mirrorOf', 'locationOf', 'memoOf'] as const) {
    if (!Object.prototype.hasOwnProperty.call(l, f)) continue;
    const v: unknown = l[f];
    if (typeof v === 'string' && v !== '') out.push(v);
  }
  return out;
}

// ═══ التشغيل ═══

/**
 * يطوي حركات الشركة الجديدة منذ آخر لقطة ويجمّدها: نقطة الحفظ الأحدث (أو حالة فارغة) ⇒ إعادة طيّ اللقطات بعدها حتى آخر
 * لقطة (تحقّقاً) ⇒ المتأخر ⇒ الجديد بدفعات SNAPSHOT_BATCH حتى horizon، بمعاملة قصيرة لكل دفعة.
 */
export async function computeSnapshots(
  db: { $transaction: PrismaClient['$transaction'] } & SnapshotDb, tenantId: string, opts: ComputeSnapshotsOptions,
): Promise<ComputeSnapshotsResult> {
  const cfg: StepperConfig = { currencyDecimals: opts.currencyDecimals };
  const decimals = opts.currencyDecimals;
  const batchSize = opts.tuning?.batchSize ?? SNAPSHOT_BATCH;
  const checkpointEvery = opts.tuning?.checkpointMinMoves ?? CHECKPOINT_MIN_MOVES;
  const pageSize = opts.tuning?.pageSize;
  const clock = opts.clock ?? (() => Date.now());
  const budget = opts.maxMoves ?? Number.POSITIVE_INFINITY;
  if (!(batchSize >= 1) || !(checkpointEvery >= 1)) throw new RangeError('ضبط غير صالح');
  const horizon = opts.horizon ?? new Date((await readDbNow(db)).getTime() - COST_LATE_COMMIT_WINDOW_MS);

  // ذاكرة الصلات: لقطات مخزَّنة مقروءة + نواتج هذا التشغيل؛ والمفاتيح التي سُئل عنها فغابت
  const stored = new Map<string, StoredSnapshot>();
  const absent = new Set<string>();
  const refs = new Map<string, SnapshotRef>();
  const foldedKeys = new Set<string>();
  const lookup: SnapshotLookup = { get: (k) => refs.get(k) };

  // ١. حالة البدء: آخر نقطة حفظ C، ثم إعادة طيّ اللقطات المجمَّدة في (C, L]
  const cp = await loadLatestCheckpoint(db, tenantId);
  let state: CostState = cp ? cp.state : createCostState();
  const cpCursor = cp ? cp.cursor : null;
  const latest = await latestSnapshotCursor(db, tenantId);
  let sinceCheckpoint = 0;
  if (latest && (!cpCursor || compareCursors(latest, cpCursor) > 0)) {
    const mismatches: string[] = [];
    for await (const page of storedBetween(db, tenantId, cpCursor, latest)) {
      const synth = new Map<string, SnapshotRef>();
      const moves: Move[] = [];
      for (const s of page) {
        const f = frozenMove(s);
        moves.push(f.move);
        if (f.ref) synth.set(f.ref.key, f.ref);
        stored.set(s.sourceKey, s);
        refs.set(s.sourceKey, snapshotRefFromRow(s));
      }
      const rr = replay(moves, cfg, { state, lookup: { get: (k) => synth.get(k) } });
      state = rr.state;
      for (const o of rr.outputs) {
        const miss = frozenMismatch(o, stored.get(o.key)!);
        if (miss && mismatches.length < 20) mismatches.push(miss);
      }
      sinceCheckpoint += rr.outputs.length;
    }
    if (mismatches.length > 0) throw new CostRefoldMismatchError(tenantId, mismatches);
  }

  // ٢. المتأخر: صفوف ≤ أبعد موضع مكتوب بلا لقطة (نافذة LATE_SCAN_LOOKBACK_MS)
  const persisted = maxCursor(cpCursor, latest);
  let pendingLate: Move[] = opts.lateScan !== false && persisted
    ? await findLateMoves(db, tenantId, persisted, { currencyDecimals: decimals, pageSize })
    : [];
  const lateKeys = new Set(pendingLate.map((m) => m.key));

  const ensureKnown = async (moves: readonly Move[], ownKeys: boolean): Promise<void> => {
    const want = new Set<string>();
    for (const m of moves) {
      if (ownKeys && !stored.has(m.key) && !absent.has(m.key)) want.add(m.key);
      for (const k of linkKeysOf(m)) if (!refs.has(k) && !stored.has(k) && !absent.has(k)) want.add(k);
    }
    if (want.size === 0) return;
    const got = await fetchStored(db, tenantId, [...want]);
    for (const k of want) {
      const row = got.get(k);
      if (row) {
        stored.set(k, row);
        if (!refs.has(k)) refs.set(k, snapshotRefFromRow(row));
      } else absent.add(k);
    }
  };

  let expectedLatest = latest;
  let readCursor = persisted;
  let committed: CostCursor | null = persisted;
  let checkpointAt = cpCursor;
  let folded = 0;
  let written = 0;
  let lateArrivals = 0;
  let checkpointWritten = false;
  let stoppedBy: ComputeSnapshotsResult['stoppedBy'] = 'DONE';
  let exhausted = false;

  /** يطوي المتأخر المعلّق والجديد ويكتبهما (ومجموعة حفظ إن استحقّت أو طُوي متأخر) — false ⇒ CONCURRENT */
  const foldAndWrite = async (fresh: Move[], position: CostCursor): Promise<boolean> => {
    const lateNow = pendingLate;
    const toFold = [...lateNow, ...fresh];
    if (toFold.length === 0) return true;
    await ensureKnown(lateNow, false);
    const rr = replay(toFold, cfg, { state, lookup });
    const due = lateNow.length > 0 || sinceCheckpoint + rr.outputs.length >= checkpointEvery;
    let maxOut: CostCursor | null = null;
    for (const o of rr.outputs) maxOut = maxCursor(maxOut, { createdAt: o.srcCreatedAt, id: o.srcId });
    const res = await writeBatch(db, tenantId, {
      outputs: rr.outputs, expectedLatest, checkpoint: due ? { state: rr.state, cursor: position } : null,
    });
    if (res === 'CONCURRENT') return false;
    state = rr.state;
    written += res.written;
    folded += rr.outputs.length;
    lateArrivals += lateNow.length;
    for (const o of rr.outputs) {
      refs.set(o.key, snapshotRefOf(o));
      foldedKeys.add(o.key);
    }
    pendingLate = [];
    expectedLatest = maxCursor(expectedLatest, maxOut);
    committed = maxCursor(committed, position);
    if (due) {
      checkpointWritten = true;
      checkpointAt = position;
      sinceCheckpoint = 0;
    } else sinceCheckpoint += rr.outputs.length;
    return true;
  };

  // ٣. الجديد بعد أبعد موضع مكتوب، بدفعات
  for (;;) {
    if (opts.deadline !== undefined && clock() >= opts.deadline) { stoppedBy = 'BUDGET'; break; }
    const remaining = budget - folded;
    if (remaining <= 0) { stoppedBy = 'BUDGET'; break; }
    const r = await loadMoves(db, tenantId, {
      until: horizon, afterCursor: readCursor, currencyDecimals: decimals, maxMoves: Math.min(batchSize, remaining), pageSize,
    });
    const position = maxCursor(readCursor, r.cursor);
    // مفتاحٌ مكتوبٌ قبلاً (صفٌّ أساسي مكرَّر في تشغيل لاحق) أو معلّقٌ متأخراً أو مطويٌّ في هذا التشغيل لا يُطوى ثانيةً
    const candidates = r.moves.filter((m) => !lateKeys.has(m.key) && !foldedKeys.has(m.key));
    await ensureKnown(candidates, true);
    const fresh = candidates.filter((m) => !stored.has(m.key));
    if (fresh.length > 0 && position) {
      if (!(await foldAndWrite(fresh, position))) { stoppedBy = 'CONCURRENT'; break; }
    } else if (position) {
      committed = maxCursor(committed, position);
    }
    readCursor = position;
    if (!r.truncated) { exhausted = true; break; }
  }

  if (exhausted && pendingLate.length > 0) {
    const position = maxCursor(readCursor, persisted);
    if (position && !(await foldAndWrite([], position))) stoppedBy = 'CONCURRENT';
  }

  // في آخر التشغيل: مجموعة حفظ إن تجاوزت الحركاتُ منذ الأخيرة الحدَّ ولم تُكتب عند الموضع نفسه (إعادة طيٍّ طويلة بلا جديد)
  if (stoppedBy !== 'CONCURRENT' && sinceCheckpoint >= checkpointEvery && pendingLate.length === 0) {
    const position = maxCursor(readCursor, persisted);
    if (position && !sameCursor(position, checkpointAt)) {
      const res = await writeBatch(db, tenantId, { outputs: [], expectedLatest, checkpoint: { state, cursor: position } });
      if (res === 'CONCURRENT') stoppedBy = 'CONCURRENT';
      else {
        checkpointWritten = true;
        committed = maxCursor(committed, position);
      }
    }
  }

  return { movesFolded: folded, snapshotsWritten: written, checkpointWritten, lateArrivals, cursor: committed, stoppedBy };
}
