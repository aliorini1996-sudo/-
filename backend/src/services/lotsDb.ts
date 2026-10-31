/**
 * «تتبّع اللوط» — الوصول إلى القاعدة: الطابور داخل العملية، والأقفال داخل المعاملة، وتجميعات SQL، وعروض الأماكن،
 * وحلّ اللوط أو إنشاؤه، وسجل التدقيق.
 *
 * كل دالّة تأخذ `db` أو `tx` معاملاً ولا تستورد إعداد القاعدة، فتُختبر بقاعدة مزيّفة (lots-db.test.ts). القواعد الصرفة
 * في services/lots.ts.
 *
 * ترتيب الأقفال في المنصّة كلها (المواصفة §٣.١) — لا يعكسه مسار:
 *   [داخل العملية] issuanceUnitMutex (المرحلة الثانية) → acquireLotQueue
 *   [القاعدة] … صفوف الفواتير FOR UPDATE → قفل دلو السيارة → صفوف الأصناف FOR KEY SHARE → أقفال lot بترتيب المفتاح
 *   → صفوف العملاء FOR UPDATE.
 */
import { Prisma } from '@prisma/client';
import type { foldStock as FoldStockFn, bucketRemaining as BucketRemainingFn } from '../routes/vanStock';
import { KeyedAsyncMutex } from '../compliance/zatca/unitMutex';
import { companyTimeZone } from './erpPayload';
import { DAMAGED_VAN_SINCE } from './vanDamaged';
import {
  LOT_BLOCK_KINDS, LOT_EPS, LOT_HOLD_MIRRORS, LOT_STATUSES, LotError,
  buildPlaceView, companyDayOf, foldVanLots, foldWarehouseLots, heldUnknownOf, lotDatesProblem, lotErr, normalizeLotNumber, roundLot,
  sortedLockKeys, zeroBuckets,
  type AggInvLot, type AggRelabel, type AggVanLot, type AggWhLot, type BucketQty, type LotBlockKind, type LotEventKind,
  type LotMeta, type LotRaw, type LotSource, type LotStatus, type PlaceLotView, type VanMoveType,
} from './lots';

export type LotTx = Prisma.TransactionClient;
/** عميل القاعدة أو المعاملة — PrismaClient يُسنَد إلى TransactionClient بنيوياً */
export type LotDb = Prisma.TransactionClient;

/**
 * الكمية الأساسية لسطر مستندٍ في SQL — **موضعٌ واحد** (D19، الوحدات أولاً): تعبير الوحدات المتعددة نفسه بلا اسمٍ مستعار
 * (= II_BASE_QTY في ai-rep/baseQty.ts، ومُطلِق fs_set_base_qty في scripts/backfillBaseQty.ts، وbaseQtyOf في units.ts):
 * العمود المخزَّن، والفارغ (صفٌّ لم يملأه الترحيل) من اللقطة بمعاملٍ صفريّ ١. غير مؤهَّل: الاستعلامات التي تستعمله تضمّ
 * جدول بنودٍ واحداً (invoice_items أو van_load_items أو warehouse_entry_items)، ولا عمود qty ولا baseQty ولا unitFactor في
 * رؤوس المستندات ولا في products وtenants. صفوف جداول اللوط بالأساس أصلاً (D22) فلا تمرّ به.
 */
export const BASE_QTY_SQL = Prisma.raw('COALESCE("baseQty", qty * COALESCE(NULLIF("unitFactor", 0), 1))');

/** الحقبة (D25): صفّ اللوط يُحسب إن كان بعد max(بداية حقبة الشركة، بداية حقبة الصنف) — t = tenants وp = products */
const EPOCH_SQL = Prisma.raw(`GREATEST(COALESCE(t."lotTrackingSince", '-infinity'::timestamp), COALESCE(p."lotTrackedSince", '-infinity'::timestamp))`);

const uniq = (xs: Iterable<string | null | undefined>): string[] => [...new Set([...xs].filter((x): x is string => typeof x === 'string' && x.length > 0))];

// ═══ الطابور داخل العملية (D29) ═══

/** انتظارٌ كلّي ≤ ١٠ ثوانٍ (≈ maxWait لمعاملة اللوط)، وسقف ٥٠ منتظراً لكل مفتاح */
export const LOT_QUEUE_WAIT_MS = 10_000;
export const LOT_QUEUE_MAX_WAITERS = 50;
/** مهلة انتظار أقفال القاعدة داخل lockLotProducts */
export const LOT_LOCK_TIMEOUT = '5s';

const queueBusy = (reason: string): LotError => lotErr('LOT_BUSY', {}, { source: 'LOT_QUEUE', reason });

/** يحجز مفتاحاً في المِقفل حتى تُستدعى دالّة التحرير (runExclusive يحرّره في finally حين تنتهي fn) */
function holdKey(mutex: KeyedAsyncMutex, key: string, waitMs: number): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    mutex.runExclusive(key, async () => { resolve(release); await held; }, { waitTimeoutMs: waitMs }).catch(reject);
  });
}

/**
 * طابورٌ داخل العملية فوق KeyedAsyncMutex (unitMutex.ts): مفاتيح 'lot:'+key مرتّبة، FIFO، انتظار كلّي محدود، وسقف منتظرين.
 * يُؤخذ **قبل** طلب اتصال من المجمّع فلا تحجز طلباتٌ منتظرة اتصالاتها (invoicesZatcaDeps.ts:5-6). ليس ضماناً عبر نسخ الخادم:
 * القفل في القاعدة (lockLotProducts) هو الحارس الحقيقي.
 */
export function createLotQueue(opts: { waitMs?: number; maxWaiters?: number } = {}): {
  acquire: (tenantId: string, productIds: Iterable<string>) => Promise<() => void>;
  activeKeys: () => number;
} {
  const waitMs = Math.max(0, Math.trunc(opts.waitMs ?? LOT_QUEUE_WAIT_MS));
  const mutex = new KeyedAsyncMutex({ maxWaiters: opts.maxWaiters ?? LOT_QUEUE_MAX_WAITERS, waitTimeoutMs: waitMs });
  const acquire = async (tenantId: string, productIds: Iterable<string>): Promise<() => void> => {
    const keys = sortedLockKeys(tenantId, productIds);
    const deadline = Date.now() + waitMs;
    const releases: (() => void)[] = [];
    let released = false;
    const releaseAll = () => {
      if (released) return;
      released = true;
      for (let i = releases.length - 1; i >= 0; i--) releases[i]();
    };
    try {
      for (const k of keys) {
        const left = deadline - Date.now();
        if (left <= 0 && mutex.isHeld(`lot:${k.key}`)) throw queueBusy('WAIT_TIMEOUT');
        releases.push(await holdKey(mutex, `lot:${k.key}`, Math.max(0, left)));
      }
    } catch (e) {
      releaseAll();
      const code = (e as { code?: unknown } | null)?.code;
      if (e instanceof LotError) throw e;
      if (code === 'ZATCA_UNIT_BUSY') {
        const reason = (e as { logDetail?: { code?: string } | null }).logDetail?.code ?? 'BUSY';
        throw queueBusy(reason);
      }
      throw e;
    }
    return releaseAll;
  };
  return { acquire, activeKeys: () => mutex.activeKeys };
}

const defaultQueue = createLotQueue();

/**
 * يُؤخذ في كل مسار لوط (عدا إصدار المرحلة الثانية، المسلسل أصلاً لكل وحدة) قبل withNumberRetry وprisma.$transaction،
 * ويُحرَّر في finally. مفاتيحه أصناف القراءة المسبقة؛ صنفٌ صار متتبَّعاً بين القراءتين يُقفل في القاعدة وحدها.
 * الانشغال ⇒ LotError('LOT_BUSY', 503).
 */
export async function acquireLotQueue(tenantId: string, productIds: Iterable<string>): Promise<() => void> {
  return defaultQueue.acquire(tenantId, productIds);
}

// ═══ الأقفال داخل المعاملة ═══

/**
 * داخل المعاملة: (١) SELECT id, unit, "lotTracked", "lotTrackedSince" … FOR KEY SHARE لكل أصناف العملية (أو الصفوف المقفلة سلفاً)؛
 * (٢) حفظ lock_timeout ثم set_config('lock_timeout','5s',true)؛ (٣) pg_advisory_xact_lock(key) لكل صنف متتبَّع بترتيب المفتاح؛
 * (٤) استعادة lock_timeout السابقة. كلها على tx.$executeRaw/$queryRaw.
 * المجموعة المقروءة تحت القفل هي المرجع (D25): tracked منها لا من القراءة المسبقة. since = بداية حقبة الصنف.
 * units = صنف ← وحدة أساسه تحت القفل (§2.6): يقارنها الكاتب بالأساس الذي حلّ عليه بنوده (baseGuard.assertBasesUnchanged)
 * بلا قفلٍ ثانٍ. والصفوف المقفلة سلفاً بلا `unit` (convert-base والفاتورة) لا تدخلها.
 * لا استعادة عند الفشل: المعاملة الفاشلة مُجهَضة أصلاً، وset_config المحلي يزول بنهايتها.
 */
export async function lockLotProducts(tx: LotTx, tenantId: string, productIds: string[],
  opts?: { lockedRows?: { id: string; lotTracked: boolean; lotTrackedSince: Date | null; unit?: string }[] }): Promise<{ tracked: Set<string>; since: Map<string, Date | null>; units: Map<string, string> }> {
  const ids = uniq(productIds).sort();
  const tracked = new Set<string>();
  const since = new Map<string, Date | null>();
  const units = new Map<string, string>();
  if (!ids.length) return { tracked, since, units };
  const rows = opts?.lockedRows ?? await tx.$queryRaw<{ id: string; unit: string; lotTracked: boolean; lotTrackedSince: Date | null }[]>`
    SELECT id, unit, "lotTracked", "lotTrackedSince" FROM products
    WHERE "tenantId" = ${tenantId} AND id = ANY(${ids}::text[])
    ORDER BY id
    FOR KEY SHARE`;
  const wanted = new Set(ids);
  for (const r of rows) {
    if (!wanted.has(r.id)) continue;
    since.set(r.id, r.lotTrackedSince ?? null);
    if (typeof r.unit === 'string') units.set(r.id, r.unit);
    if (r.lotTracked === true) tracked.add(r.id);
  }
  if (!tracked.size) return { tracked, since, units };
  const prevRows = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
  const prev = prevRows[0]?.lock_timeout ?? '0';
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
  for (const k of sortedLockKeys(tenantId, tracked)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${k.key})`;
  }
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev}, true)`;
  return { tracked, since, units };
}

// ═══ البطاقات ═══

const LOT_META_SELECT = {
  id: true, productId: true, lotNumber: true, productionDate: true, expiryDate: true,
  status: true, blockKind: true, blockedAt: true, createdAt: true,
} as const;

interface LotMetaRow {
  id: string; productId: string; lotNumber: string; productionDate: Date | null; expiryDate: Date | null;
  status: string; blockKind: string | null; blockedAt: Date | null; createdAt: Date;
}

const isoDay = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString().slice(0, 10) : null);
const dayDate = (d: string | null | undefined): Date | null => (d ? new Date(`${d}T00:00:00.000Z`) : null);

/** صفّ product_lots ⇒ LotMeta. حالةٌ غير معروفة تُعامَل موقوفة (فشلٌ مغلق) */
export function lotMetaOf(r: LotMetaRow): LotMeta {
  const status: LotStatus = (LOT_STATUSES as readonly string[]).includes(r.status) ? (r.status as LotStatus) : 'BLOCKED';
  const blockKind: LotBlockKind | null = (LOT_BLOCK_KINDS as readonly string[]).includes(String(r.blockKind)) ? (r.blockKind as LotBlockKind) : null;
  return {
    id: r.id, productId: r.productId, lotNumber: r.lotNumber,
    productionDate: isoDay(r.productionDate), expiryDate: isoDay(r.expiryDate),
    status, blockKind, blockedAt: r.blockedAt ? new Date(r.blockedAt) : null, createdAt: new Date(r.createdAt),
  };
}

/** بطاقات اللوطات — الشركة شرطٌ في الاستعلام (I5)، فلوطٌ من شركة أخرى غائبٌ كأنه غير موجود */
export async function loadLotMetas(db: LotDb, tid: string, q: { productIds?: string[]; lotIds?: string[] }): Promise<Map<string, LotMeta>> {
  const out = new Map<string, LotMeta>();
  const productIds = q.productIds ? uniq(q.productIds) : undefined;
  const lotIds = q.lotIds ? uniq(q.lotIds) : undefined;
  if ((productIds && !productIds.length) || (lotIds && !lotIds.length) || (!productIds && !lotIds)) return out;
  const rows = await db.productLot.findMany({
    where: { tenantId: tid, ...(productIds && { productId: { in: productIds } }), ...(lotIds && { id: { in: lotIds } }) },
    select: LOT_META_SELECT,
  });
  for (const r of rows) out.set(r.id, lotMetaOf(r));
  return out;
}

/** منطقة الشركة ويومها — يُستدعى **قبل** المعاملة (ن٢-٢)، بأسبقية tenantTz نفسها (إعدادات الدفاتر ثم البلد) */
export async function companyDay(db: LotDb, tid: string, at?: Date): Promise<{ tz: string; day: string }> {
  const [gl, company] = await Promise.all([
    db.glSettings.findUnique({ where: { tenantId: tid }, select: { timezone: true } }),
    db.companySettings.findUnique({ where: { tenantId: tid }, select: { countryCode: true } }),
  ]);
  const tz = companyTimeZone(gl?.timezone, company?.countryCode);
  return { tz, day: companyDayOf(at ?? new Date(), tz) };
}

// ═══ تجميعات SQL (§٣.٤) — مجاميع تُغذّى إلى الطيّ الصرف ═══

interface RawVanLot { productId: string; lotId: string | null; vanKey: string; moveType: string; viaWarehouse: boolean; qty: number | null; firstInAt: Date | null }

/**
 * صفوف van_load_item_lots مجمَّعة بـ(صنف، لوط، سيارة، نوع، viaWarehouse) بعد الحقبة، مع أول دخول موجب.
 * `vanKeys` غائب ⇒ كل السيارات (لوطات المستودع)؛ `viaWarehouseOnly` ⇒ LOAD وUNLOAD بـviaWarehouse وحدها (D28).
 */
export async function aggVanLots(db: LotDb, tid: string, q: { productIds: string[]; vanKeys?: string[] | null; viaWarehouseOnly?: boolean; before?: Date | null }): Promise<AggVanLot[]> {
  const pids = uniq(q.productIds);
  const keys = q.vanKeys ? uniq(q.vanKeys) : null;
  if (!pids.length || (keys && !keys.length)) return [];
  const vanCond = keys ? Prisma.sql` AND l."vanKey" = ANY(${keys}::text[])` : Prisma.empty;
  const whCond = q.viaWarehouseOnly ? Prisma.sql` AND l."viaWarehouse" = true AND l."moveType" IN ('LOAD', 'UNLOAD')` : Prisma.empty;
  const beforeCond = q.before ? Prisma.sql` AND l."createdAt" < ${q.before}` : Prisma.empty;
  const rows = await db.$queryRaw<RawVanLot[]>`
    SELECT l."productId", l."lotId", l."vanKey", l."moveType", l."viaWarehouse",
           SUM(l.qty)::float8 AS qty,
           MIN(l."createdAt") FILTER (WHERE l.qty > 0) AS "firstInAt"
    FROM van_load_item_lots l
    JOIN products p ON p.id = l."productId"
    JOIN tenants t ON t.id = l."tenantId"
    WHERE l."tenantId" = ${tid} AND l."productId" = ANY(${pids}::text[])${vanCond}${whCond}${beforeCond}
      AND l."createdAt" >= ${EPOCH_SQL}
    GROUP BY l."productId", l."lotId", l."vanKey", l."moveType", l."viaWarehouse"`;
  return rows.map((r) => ({
    productId: r.productId, lotId: r.lotId ?? null, vanKey: r.vanKey, moveType: r.moveType as VanMoveType,
    viaWarehouse: r.viaWarehouse === true, qty: Number(r.qty) || 0, firstInAt: r.firstInAt ? new Date(r.firstInAt) : null,
  }));
}

/** صفّ فاتورةٍ مجمَّع — من صفوف اللوط (src = LOT) أو من البنود (src = TOT، lotId وfirstAt فارغان) */
interface RawInvRow {
  productId: string; lotId: string | null; vanKey: string | null; type: string; returnToStock: boolean | null; returnExpired: boolean | null;
  damaged: boolean | null; held: boolean | null; qty: number | null; firstAt: Date | null; src: string;
}

/** isDamagedVanReturn (vanDamaged.ts) في SQL */
const damagedSql = (): Prisma.Sql => Prisma.sql`COALESCE(i."returnReason" = 'DAMAGED' AND i."createdAt" >= ${DAMAGED_VAN_SINCE}, false)`;
/** الحجز (D24) = voidDecision (void.ts:65-77): مرتجعٌ في المرحلة الثانية «01» ومرآته فارغة أو ضمن LOT_HOLD_MIRRORS (= VOIDABLE_MIRRORS) */
const heldSql = (): Prisma.Sql => Prisma.sql`COALESCE(i.type = 'RETURN' AND i."zatcaPhase" = 2 AND i."invoiceSubtype" = '01'
             AND (i."einvoiceStatus" IS NULL OR i."einvoiceStatus" = ANY(${[...LOT_HOLD_MIRRORS]}::text[])), false)`;

/** صفوف invoice_item_lots بعد الحقبة لفواتير CONFIRMED، بمفاتيح التوجيه والحجز — `keys` null ⇒ كل السيارات */
function invLotsSql(tid: string, pids: string[], keys: string[] | null, before: Date | null): Prisma.Sql {
  const vanCond = keys ? Prisma.sql` AND il."vanKey" = ANY(${keys}::text[])` : Prisma.empty;
  const beforeCond = before ? Prisma.sql` AND i."invoiceDate" < ${before}` : Prisma.empty;
  return Prisma.sql`
    SELECT il."productId", il."lotId", il."vanKey", i.type, i."returnToStock", it."returnExpired",
           ${damagedSql()} AS damaged,
           ${heldSql()} AS held,
           SUM(il.quantity)::float8 AS qty, MIN(il."createdAt") AS "firstAt", 'LOT'::text AS src
    FROM invoice_item_lots il
    JOIN invoices i ON i.id = il."invoiceId"
    JOIN invoice_items it ON it.id = il."invoiceItemId"
    JOIN products p ON p.id = il."productId"
    JOIN tenants t ON t.id = il."tenantId"
    WHERE il."tenantId" = ${tid} AND i."tenantId" = ${tid} AND i.status = 'CONFIRMED'
      AND il."productId" = ANY(${pids}::text[])${vanCond}${beforeCond}
      AND il."createdAt" >= ${EPOCH_SQL}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`;
}

/**
 * بنود invoice_items لسيارات بعينها بمرشّحات computeStock (vanStock.ts:174-184) — كل التاريخ (لا حقبة)، والحجز مفتاحٌ إضافي.
 * أعمدتها أعمدة invLotsSql نفسها (لـUNION ALL)؛ والعمود ٢ ثابتٌ فارغ فلا يُجمَّع به.
 */
function invTotalsSql(tid: string, pids: string[], keys: string[], before: Date | null): Prisma.Sql {
  const beforeCond = before ? Prisma.sql` AND i."invoiceDate" < ${before}` : Prisma.empty;
  return Prisma.sql`
    SELECT it."productId", NULL::text AS "lotId", i."salesRepId" AS "vanKey", i.type, i."returnToStock", it."returnExpired",
           ${damagedSql()} AS damaged,
           ${heldSql()} AS held,
           SUM(${BASE_QTY_SQL})::float8 AS qty, NULL::timestamp AS "firstAt", 'TOT'::text AS src
    FROM invoice_items it
    JOIN invoices i ON i.id = it."invoiceId"
    WHERE i."tenantId" = ${tid} AND i."salesRepId" = ANY(${keys}::text[]) AND i.status = 'CONFIRMED'
      AND it."productId" = ANY(${pids}::text[])${beforeCond}
    GROUP BY 1, 3, 4, 5, 6, 7, 8`;
}

const invLotOf = (r: RawInvRow): AggInvLot => ({
  productId: r.productId, lotId: r.lotId ?? null, vanKey: r.vanKey ?? null,
  route: { type: r.type, returnToStock: r.returnToStock ?? null, returnExpired: r.returnExpired ?? null, damaged: r.damaged === true },
  held: r.held === true, qty: Number(r.qty) || 0, firstAt: r.firstAt ? new Date(r.firstAt) : null,
});
const invTotalOf = (r: RawInvRow): AggVanTotalInv => ({
  productId: r.productId, vanKey: r.vanKey ?? '', type: r.type, returnToStock: r.returnToStock ?? null,
  returnExpired: r.returnExpired ?? null, damaged: r.damaged === true, held: r.held === true, qty: Number(r.qty) || 0,
});

/**
 * صفوف invoice_item_lots لفواتير CONFIRMED مجمَّعة بمفاتيح توجيه foldStock (type، returnToStock، returnExpired، damaged)
 * وبالحجز (D24): مرتجعٌ في المرحلة الثانية «01» ومرآته فارغة أو ضمن LOT_HOLD_MIRRORS (= VOIDABLE_MIRRORS، void.ts:65-77).
 * damaged = isDamagedVanReturn (vanDamaged.ts) في SQL. `before` يرشّح بتاريخ الفاتورة كمسار المستودع.
 * ⚠️ مع رصيد الصنف تُقرأ بـaggVanInvoices (عبارةٌ واحدة) لا بهذه ثم aggVanTotals.
 */
export async function aggInvLots(db: LotDb, tid: string, q: { productIds: string[]; vanKeys?: string[] | null; before?: Date | null }): Promise<AggInvLot[]> {
  const pids = uniq(q.productIds);
  const keys = q.vanKeys ? uniq(q.vanKeys) : null;
  if (!pids.length || (keys && !keys.length)) return [];
  const rows = await db.$queryRaw<RawInvRow[]>`${invLotsSql(tid, pids, keys, q.before ?? null)}`;
  return rows.map(invLotOf);
}

/**
 * لوطات الفواتير (بعد الحقبة) وبنودها (رصيد الصنف والمحجوز الكلي، كل التاريخ) لسيارات بعينها في **عبارة SQL واحدة**
 * (UNION ALL)، فيريان لقطةً واحدة تحت READ COMMITTED. السبب: إلغاء البيع وإعادة العودة للمخزون والإبطال وتغيّر المرآة
 * لا تأخذ قفل اللوط (§٣.١)؛ لو قُرئا في عبارتين لثبت أحدها بينهما فحُسب غير المسمّى = رصيد الصنف − Σ الخام من لقطتين (I2).
 * حركات السيارة وصفوف لوطها تُكتب كلها تحت القفل فلا يلزم ضمّها. `totalVanKeys` (المناديب القائمون) ⊆ `vanKeys`.
 */
export async function aggVanInvoices(db: LotDb, tid: string, q: { productIds: string[]; vanKeys: string[]; totalVanKeys: string[]; before?: Date | null }):
  Promise<{ lots: AggInvLot[]; totals: AggVanTotalInv[] }> {
  const pids = uniq(q.productIds);
  const keys = uniq(q.vanKeys);
  const totalKeys = uniq(q.totalVanKeys);
  const before = q.before ?? null;
  const parts: Prisma.Sql[] = [];
  if (pids.length && keys.length) parts.push(invLotsSql(tid, pids, keys, before));
  if (pids.length && totalKeys.length) parts.push(invTotalsSql(tid, pids, totalKeys, before));
  if (!parts.length) return { lots: [], totals: [] };
  const sql = parts.length === 2 ? Prisma.sql`(${parts[0]}) UNION ALL (${parts[1]})` : parts[0];
  const rows = await db.$queryRaw<RawInvRow[]>`${sql}`;
  return { lots: rows.filter((r) => r.src === 'LOT').map(invLotOf), totals: rows.filter((r) => r.src === 'TOT').map(invTotalOf) };
}

interface RawRelabel { productId: string; place: string; vanKey: string | null; bucket: string; fromLotId: string | null; toLotId: string | null; qty: number | null; firstAt: Date | null }

/** التسميات بعد الحقبة: المستودع و/أو سيارات بعينها — firstAt أقدم تسميةٍ موجبة (دخول اللوط الوجهة، طبقة الإعادة ١) */
export async function aggRelabels(db: LotDb, tid: string, q: { productIds: string[]; warehouse?: boolean; vanKeys?: string[] | null; before?: Date | null }): Promise<AggRelabel[]> {
  const pids = uniq(q.productIds);
  const keys = q.vanKeys ? uniq(q.vanKeys) : [];
  if (!pids.length || (!q.warehouse && !keys.length)) return [];
  const placeCond = q.warehouse && keys.length
    ? Prisma.sql` AND (r.place = 'WAREHOUSE' OR (r.place = 'VAN' AND r."vanKey" = ANY(${keys}::text[])))`
    : q.warehouse
      ? Prisma.sql` AND r.place = 'WAREHOUSE'`
      : Prisma.sql` AND r.place = 'VAN' AND r."vanKey" = ANY(${keys}::text[])`;
  const beforeCond = q.before ? Prisma.sql` AND r."createdAt" < ${q.before}` : Prisma.empty;
  const rows = await db.$queryRaw<RawRelabel[]>`
    SELECT r."productId", r.place, r."vanKey", r.bucket, r."fromLotId", r."toLotId", SUM(r.qty)::float8 AS qty,
           MIN(r."createdAt") FILTER (WHERE r.qty > 0) AS "firstAt"
    FROM lot_relabels r
    JOIN products p ON p.id = r."productId"
    JOIN tenants t ON t.id = r."tenantId"
    WHERE r."tenantId" = ${tid} AND r."productId" = ANY(${pids}::text[])${placeCond}${beforeCond}
      AND r."createdAt" >= ${EPOCH_SQL}
    GROUP BY 1, 2, 3, 4, 5, 6`;
  return rows.map((r) => ({
    productId: r.productId, place: r.place === 'WAREHOUSE' ? 'WAREHOUSE' : 'VAN', vanKey: r.vanKey ?? null,
    bucket: r.bucket === 'EXPIRED' || r.bucket === 'DAMAGED' ? r.bucket : 'SELLABLE',
    fromLotId: r.fromLotId ?? null, toLotId: r.toLotId ?? null, qty: Number(r.qty) || 0, firstAt: r.firstAt ? new Date(r.firstAt) : null,
  }));
}

/** أسطر المستودع المسمّاة بعد الحقبة (بتاريخ الحركة) */
export async function aggWhLots(db: LotDb, tid: string, q: { productIds: string[]; before?: Date | null }): Promise<AggWhLot[]> {
  const pids = uniq(q.productIds);
  if (!pids.length) return [];
  const beforeCond = q.before ? Prisma.sql` AND we."createdAt" < ${q.before}` : Prisma.empty;
  const rows = await db.$queryRaw<{ productId: string; lotId: string | null; qty: number | null }[]>`
    SELECT wi."productId", wi."lotId", SUM(${BASE_QTY_SQL})::float8 AS qty
    FROM warehouse_entry_items wi
    JOIN warehouse_entries we ON we.id = wi."entryId"
    JOIN products p ON p.id = wi."productId"
    JOIN tenants t ON t.id = we."tenantId"
    WHERE we."tenantId" = ${tid} AND wi."productId" = ANY(${pids}::text[]) AND wi."lotId" IS NOT NULL${beforeCond}
      AND we."createdAt" >= ${EPOCH_SQL}
    GROUP BY 1, 2`;
  return rows.map((r) => ({ productId: r.productId, lotId: r.lotId ?? null, qty: Number(r.qty) || 0 }));
}

export interface AggVanTotalLoad { productId: string; vanKey: string; type: string; qty: number }
/** held: بندٌ في مستندٍ محجوز (D24) — للمحجوز الكلي (vanHeldFromAgg)؛ لا يمسّ رصيد الصنف */
export interface AggVanTotalInv { productId: string; vanKey: string; type: string; returnToStock: boolean | null; returnExpired: boolean | null; damaged: boolean; held?: boolean; qty: number }

/** حركات van_load_items لسيارات مناديب قائمين بمرشّحات computeStock (vanStock.ts:174-184) — كل التاريخ (لا حقبة) */
async function aggVanLoadTotals(db: LotDb, tid: string, pids: string[], keys: string[], before: Date | null): Promise<AggVanTotalLoad[]> {
  const loadBefore = before ? Prisma.sql` AND vl."createdAt" < ${before}` : Prisma.empty;
  const loads = await db.$queryRaw<{ productId: string; vanKey: string; type: string; qty: number | null }[]>`
    SELECT vli."productId", vl."salesRepId" AS "vanKey", vl.type, SUM(${BASE_QTY_SQL})::float8 AS qty
    FROM van_load_items vli
    JOIN van_loads vl ON vl.id = vli."vanLoadId"
    WHERE vl."tenantId" = ${tid} AND vl."salesRepId" = ANY(${keys}::text[]) AND vli."productId" = ANY(${pids}::text[])${loadBefore}
    GROUP BY 1, 2, 3`;
  return loads.map((r) => ({ productId: r.productId, vanKey: r.vanKey, type: r.type, qty: Number(r.qty) || 0 }));
}

/**
 * رصيد الصنف لسيارات مناديب قائمين: تجميعان بمرشّحات computeStock نفسها (vanStock.ts:174-184) مقيَّدين بالأصناف،
 * لكل التاريخ (لا حقبة). تُغذّى إلى foldStock نفسها عبر vanTotalsFromAgg — لا مرآة تنحرف. البنود تحمل الحجز (D24).
 * ⚠️ مع لوطات الفواتير تُقرأ البنود بـaggVanInvoices (عبارةٌ واحدة) لا بهذه.
 */
export async function aggVanTotals(db: LotDb, tid: string, q: { vanKeys: string[]; productIds: string[]; before?: Date | null }): Promise<{ loads: AggVanTotalLoad[]; invs: AggVanTotalInv[] }> {
  const pids = uniq(q.productIds);
  const keys = uniq(q.vanKeys);
  if (!pids.length || !keys.length) return { loads: [], invs: [] };
  const before = q.before ?? null;
  const loads = await aggVanLoadTotals(db, tid, pids, keys, before);
  const invs = await db.$queryRaw<RawInvRow[]>`${invTotalsSql(tid, pids, keys, before)}`;
  return { loads, invs: invs.map(invTotalOf) };
}

const AGG_EPOCH = new Date(0);

/**
 * المجاميع ⇒ رصيد الصنف لكل سيارة وصنف عبر foldStock وbucketRemaining **نفسيهما** (صفوفٌ مجمَّعة بمفاتيح التوجيه؛ الطيّ خطّي
 * في الكميات والنافذة from غائبة). EXPIRED وDAMAGED كما في computeStock (vanStock.ts:200-201).
 */
export function vanTotalsFromAgg(loads: AggVanTotalLoad[], invs: AggVanTotalInv[],
  fns: { foldStock: typeof FoldStockFn; bucketRemaining: typeof BucketRemainingFn }): Map<string /*vanKey*/, Map<string /*productId*/, BucketQty>> {
  const keys = uniq([...loads.map((l) => l.vanKey), ...invs.map((r) => r.vanKey)]);
  const out = new Map<string, Map<string, BucketQty>>();
  for (const key of keys) {
    const loadRows = loads.filter((l) => l.vanKey === key)
      .map((l) => ({ productId: l.productId, qty: l.qty, vanLoad: { type: l.type, createdAt: AGG_EPOCH } }));
    const invRows = invs.filter((r) => r.vanKey === key).map((r) => ({
      productId: r.productId, qty: r.qty, returnExpired: r.returnExpired,
      invoice: {
        type: r.type, returnToStock: r.returnToStock, invoiceDate: AGG_EPOCH,
        returnReason: r.damaged ? 'DAMAGED' : null, createdAt: r.damaged ? DAMAGED_VAN_SINCE : null,
      },
    }));
    const { bal } = fns.foldStock(loadRows, invRows);
    const m = new Map<string, BucketQty>();
    for (const [pid, b] of bal) {
      m.set(pid, { SELLABLE: fns.bucketRemaining(b), EXPIRED: roundLot(b.expiredIn - b.expiredOut), DAMAGED: roundLot(b.damagedIn - b.damagedOut) });
    }
    out.set(key, m);
  }
  return out;
}

/**
 * المحجوز الكلي (D24) لكل سيارة وصنف ودلو: بنود المستندات المحجوزة وحدها عبر foldStock **نفسها** — كل التاريخ بلا حقبة،
 * كرصيد الصنف. المحجوز غير المسمّى = هذا − Σ محجوز اللوطات المسمّاة (heldUnknownOf).
 */
export function vanHeldFromAgg(invs: AggVanTotalInv[],
  fns: { foldStock: typeof FoldStockFn; bucketRemaining: typeof BucketRemainingFn }): Map<string /*vanKey*/, Map<string /*productId*/, BucketQty>> {
  return vanTotalsFromAgg([], invs.filter((r) => r.held === true), fns);
}

/** صفوف رصيد المستودع المجمَّعة بنوع الحركة: WH لأسطر المستودع، وVAN لحركات السيارات */
export interface WhTotalAgg { productId: string; source: 'WH' | 'VAN'; type: string; qty: number }

/**
 * رصيد المستودع لكل صنف من المجاميع = received + adjusted + returnedFromVans − loadedToVans (composeWarehouse،
 * warehouseStock.ts:92-114): RECEIVE وارد وغيره تسوية؛ LOAD خارج وUNLOAD عائد؛ تسوية السيارة لا تمسّه.
 */
export function warehouseOnHandAgg(rows: WhTotalAgg[]): Map<string, number> {
  const acc = new Map<string, { received: number; adjusted: number; loadedToVans: number; returnedFromVans: number }>();
  const ensure = (pid: string) => {
    let m = acc.get(pid);
    if (!m) { m = { received: 0, adjusted: 0, loadedToVans: 0, returnedFromVans: 0 }; acc.set(pid, m); }
    return m;
  };
  for (const r of rows) {
    if (r.source === 'WH') {
      if (r.type === 'RECEIVE') ensure(r.productId).received += r.qty;
      else ensure(r.productId).adjusted += r.qty;
    } else if (r.type === 'LOAD') ensure(r.productId).loadedToVans += r.qty;
    else if (r.type === 'UNLOAD') ensure(r.productId).returnedFromVans += r.qty;
  }
  const out = new Map<string, number>();
  for (const [pid, m] of acc) out.set(pid, roundLot(m.received + m.adjusted + m.returnedFromVans - m.loadedToVans));
  return out;
}

/** مجاميع رصيد المستودع (كل التاريخ، كل السيارات ومنها المحذوفة — كـloadWarehouseInputs) */
export async function aggWarehouseTotals(db: LotDb, tid: string, q: { productIds: string[]; before?: Date | null }): Promise<WhTotalAgg[]> {
  const pids = uniq(q.productIds);
  if (!pids.length) return [];
  const whBefore = q.before ? Prisma.sql` AND we."createdAt" < ${q.before}` : Prisma.empty;
  const vanBefore = q.before ? Prisma.sql` AND vl."createdAt" < ${q.before}` : Prisma.empty;
  const wh = await db.$queryRaw<{ productId: string; type: string; qty: number | null }[]>`
    SELECT wi."productId", we.type, SUM(${BASE_QTY_SQL})::float8 AS qty
    FROM warehouse_entry_items wi
    JOIN warehouse_entries we ON we.id = wi."entryId"
    WHERE we."tenantId" = ${tid} AND wi."productId" = ANY(${pids}::text[])${whBefore}
    GROUP BY 1, 2`;
  const van = await db.$queryRaw<{ productId: string; type: string; qty: number | null }[]>`
    SELECT vli."productId", vl.type, SUM(${BASE_QTY_SQL})::float8 AS qty
    FROM van_load_items vli
    JOIN van_loads vl ON vl.id = vli."vanLoadId"
    WHERE vl."tenantId" = ${tid} AND vli."productId" = ANY(${pids}::text[]) AND vl.type IN ('LOAD', 'UNLOAD')${vanBefore}
    GROUP BY 1, 2`;
  return [
    ...wh.map((r) => ({ productId: r.productId, source: 'WH' as const, type: r.type, qty: Number(r.qty) || 0 })),
    ...van.map((r) => ({ productId: r.productId, source: 'VAN' as const, type: r.type, qty: Number(r.qty) || 0 })),
  ];
}

// ═══ عروض الأماكن ═══

export interface PlaceViewsQuery { warehouse?: boolean; vanKeys?: string[]; productIds: string[]; before?: Date; withTotals: boolean }
export interface PlaceViewsResult {
  /** صنف ⇒ عرض المستودع (فارغة حين لا يُطلب المستودع) */
  warehouse: Map<string, PlaceLotView>;
  /** سيارة ⇒ صنف ⇒ عرض — لكل سيارة مطلوبة عرضٌ لكل صنف مطلوب ولو بلا صفوف لوط */
  vans: Map<string, Map<string, PlaceLotView>>;
  metas: Map<string, LotMeta>;
  /** سيارات بلا مندوبٍ قائم (محذوف): رصيد صنفها مجهول فعرضها approximate */
  deletedVans: Set<string>;
}

/** مدخلات تركيب العروض: المجاميع كما تنتجها التجميعات، ورصيد الصنف والمحجوز الكلي من foldStock، والبطاقات */
export interface PlaceViewsParts {
  productIds: string[]; vanKeys: string[]; warehouse: boolean; withTotals: boolean;
  vanLots: AggVanLot[]; invLots: AggInvLot[]; whVanLots: AggVanLot[]; whLots: AggWhLot[]; rels: AggRelabel[];
  /** سيارة ⇒ صنف ⇒ رصيد الصنف (vanTotalsFromAgg)، وللمحجوز الكلي (vanHeldFromAgg) — للمناديب القائمين وحدهم */
  vanTotals: ReadonlyMap<string, ReadonlyMap<string, BucketQty>>; heldTotals: ReadonlyMap<string, ReadonlyMap<string, BucketQty>>;
  whTotals: ReadonlyMap<string, number>; metas: Map<string, LotMeta>; deletedVans: ReadonlySet<string>;
}

/**
 * تركيب العروض من المجاميع (صرف، يستعمله placeViews ونموذج J1 معاً): المستودع بـfoldWarehouseLots، وكل سيارة بـfoldVanLots،
 * والمحجوز غير المسمّى = المحجوز الكلي − Σ المحجوز المسمّى (heldUnknownOf، D24). سيارةٌ محذوفة أو بلا مجاميع ⇒ total null.
 */
export function assemblePlaceViews(p: PlaceViewsParts): PlaceViewsResult {
  const res: PlaceViewsResult = { warehouse: new Map(), vans: new Map(), metas: p.metas, deletedVans: new Set(p.deletedVans) };
  if (p.warehouse) {
    const wf = foldWarehouseLots(p.whLots, p.whVanLots, p.rels);
    for (const pid of p.productIds) {
      const named = new Map<string, LotRaw>();
      for (const [lotId, v] of wf.get(pid) ?? []) named.set(lotId, { raw: { SELLABLE: v, EXPIRED: 0, DAMAGED: 0 }, held: zeroBuckets() });
      const total: BucketQty | null = p.withTotals ? { SELLABLE: p.whTotals.get(pid) ?? 0, EXPIRED: 0, DAMAGED: 0 } : null;
      res.warehouse.set(pid, buildPlaceView({ productId: pid, place: 'WAREHOUSE', vanKey: null, total, named, heldUnknown: zeroBuckets(), metas: p.metas }));
    }
  }
  for (const key of p.vanKeys) {
    const vf = foldVanLots(p.vanLots, p.invLots, p.rels, key);
    const live = p.withTotals && !p.deletedVans.has(key);
    const m = new Map<string, PlaceLotView>();
    for (const pid of p.productIds) {
      const named = vf.named.get(pid) ?? new Map<string, LotRaw>();
      const total = live ? (p.vanTotals.get(key)?.get(pid) ?? zeroBuckets()) : null;
      const heldUnknown = live ? heldUnknownOf(p.heldTotals.get(key)?.get(pid) ?? zeroBuckets(), named) : (vf.heldUnknown.get(pid) ?? zeroBuckets());
      m.set(pid, buildPlaceView({ productId: pid, place: 'VAN', vanKey: key, total, named, heldUnknown, metas: p.metas, firstInAt: vf.firstInAt.get(pid) }));
    }
    res.vans.set(key, m);
  }
  return res;
}

/**
 * عروض أصنافٍ في المستودع و/أو سيارات: الخام من تجميعات SQL بعد الحقبة، ورصيد الصنف (withTotals) من foldStock وwarehouseOnHandAgg،
 * والمحجوز الكلي من foldStock على بنود المستندات المحجوزة. withTotals = false ⇒ total null (غير المسمّى غير محسوب).
 * `before` ⇒ «المخزون في تاريخ» (§٤.٢٠). لوطات الفواتير وبنودها في عبارةٍ واحدة (aggVanInvoices): لقطةٌ واحدة.
 * foldStock تُستورد ديناميكياً من routes/vanStock: debit-note-consumers-static.test.ts يقرأ نصّها في ذلك الملف.
 */
export async function placeViews(db: LotDb, tid: string, q: PlaceViewsQuery): Promise<PlaceViewsResult> {
  const pids = uniq(q.productIds);
  const keys = uniq(q.vanKeys ?? []);
  if (!pids.length || (!q.warehouse && !keys.length)) return { warehouse: new Map(), vans: new Map(), metas: new Map(), deletedVans: new Set() };
  const before = q.before ?? null;

  const deletedVans = new Set<string>();
  let liveKeys: string[] = [];
  if (q.withTotals && keys.length) {
    const live = new Set((await db.salesRep.findMany({ where: { tenantId: tid, id: { in: keys } }, select: { id: true } })).map((r) => r.id));
    liveKeys = keys.filter((k) => live.has(k));
    for (const k of keys) if (!live.has(k)) deletedVans.add(k);
  }
  const vanLots = keys.length ? await aggVanLots(db, tid, { productIds: pids, vanKeys: keys, before }) : [];
  const inv = keys.length ? await aggVanInvoices(db, tid, { productIds: pids, vanKeys: keys, totalVanKeys: liveKeys, before }) : { lots: [], totals: [] };
  const whVanLots = q.warehouse ? await aggVanLots(db, tid, { productIds: pids, viaWarehouseOnly: true, before }) : [];
  const whLots = q.warehouse ? await aggWhLots(db, tid, { productIds: pids, before }) : [];
  const rels = await aggRelabels(db, tid, { productIds: pids, warehouse: !!q.warehouse, vanKeys: keys, before });

  let vanTotals = new Map<string, Map<string, BucketQty>>();
  let heldTotals = new Map<string, Map<string, BucketQty>>();
  if (liveKeys.length) {
    const loads = await aggVanLoadTotals(db, tid, pids, liveKeys, before);
    const fns = await import('../routes/vanStock');
    const fold = { foldStock: fns.foldStock, bucketRemaining: fns.bucketRemaining };
    vanTotals = vanTotalsFromAgg(loads, inv.totals, fold);
    heldTotals = vanHeldFromAgg(inv.totals, fold);
  }
  const whTotals = q.withTotals && q.warehouse ? warehouseOnHandAgg(await aggWarehouseTotals(db, tid, { productIds: pids, before })) : new Map<string, number>();

  const lotIds = uniq([
    ...vanLots.map((r) => r.lotId), ...inv.lots.map((r) => r.lotId), ...whVanLots.map((r) => r.lotId), ...whLots.map((r) => r.lotId),
    ...rels.map((r) => r.fromLotId), ...rels.map((r) => r.toLotId),
  ]);
  const metas = lotIds.length ? await loadLotMetas(db, tid, { lotIds }) : new Map<string, LotMeta>();
  return assemblePlaceViews({
    productIds: pids, vanKeys: keys, warehouse: !!q.warehouse, withTotals: q.withTotals,
    vanLots, invLots: inv.lots, whVanLots, whLots, rels, vanTotals, heldTotals, whTotals, metas, deletedVans,
  });
}

// ═══ حلّ اللوط أو إنشاؤه، وسجل التدقيق ═══

export interface LotEventActor { type: 'ADMIN' | 'OWNER' | 'STAFF' | 'API_KEY' | 'SYSTEM'; id: string | null; name: string | null }
export interface LotEventInput {
  tenantId: string; lotId: string | null; productId: string; kind: LotEventKind;
  before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; reason?: string | null; actor: LotEventActor;
}

/** سجل تدقيق اللوط (المادة ٥٢، D27) — داخل معاملة العملية نفسها */
export async function recordLotEvent(tx: LotTx, ev: LotEventInput): Promise<void> {
  await tx.lotEvent.create({
    data: {
      tenantId: ev.tenantId, lotId: ev.lotId ?? null, productId: ev.productId, kind: ev.kind,
      ...(ev.before != null && { before: ev.before as Prisma.InputJsonValue }),
      ...(ev.after != null && { after: ev.after as Prisma.InputJsonValue }),
      reason: ev.reason ?? null, actorType: ev.actor.type, actorId: ev.actor.id ?? null, actorName: ev.actor.name ?? null,
    },
  });
}

/** مرجع اللوط في الطلب: لوطٌ قائم بمعرّفه، أو رقمٌ (وتواريخ) لحلّه أو إنشائه */
export interface LotRefInput { lotId?: string | null; lotNumber?: string | null; productionDate?: string | null; expiryDate?: string | null }
export interface LotCreateMeta { source: LotSource; sourceEntryId?: string | null; createdBy?: string | null; note?: string | null; actor: LotEventActor }

/**
 * يحلّ مرجع اللوط أو ينشئه داخل معاملةٍ تمسك قفل الصنف (I5، I6):
 * - بالمعرّف: من الشركة (وإلا LOT_NOT_FOUND) ومن الصنف (وإلا LOT_PRODUCT_MISMATCH).
 * - بالرقم المطبَّع: القائم يُستعمل، وتاريخٌ مُرسَل يخالف المسجَّل ⇒ LOT_DATES_MISMATCH؛ والجديد يُنشأ بتواريخ صالحة والانتهاء
 *   إلزامي مع الصلاحية، ويُكتب LotEvent CREATE. الإدراج ON CONFLICT DO NOTHING ثم القراءة: سباقٌ نادر على الرقم لا يُجهض المعاملة.
 * لوطٌ موقوف يُعاد كما هو: الواردُ إليه مقبول بتحذير LOT_INTO_BLOCKED عند المستدعي.
 */
export async function resolveOrCreateLot(tx: LotTx, tid: string, product: { id: string; name: string; shelfLifeOn: boolean },
  ref: LotRefInput, meta: LotCreateMeta): Promise<{ meta: LotMeta; created: boolean }> {
  if (ref.lotId) {
    const row = await tx.productLot.findFirst({ where: { id: ref.lotId, tenantId: tid }, select: LOT_META_SELECT });
    if (!row) throw lotErr('LOT_NOT_FOUND', {}, { lotId: ref.lotId });
    if (row.productId !== product.id) throw lotErr('LOT_PRODUCT_MISMATCH', { lot: row.lotNumber, name: product.name }, { lotId: row.id, productId: product.id });
    return { meta: lotMetaOf(row), created: false };
  }
  const lotNumber = normalizeLotNumber(ref.lotNumber);
  if (!lotNumber) throw lotErr('LOT_REQUIRED', { name: product.name }, { productId: product.id });
  const production = ref.productionDate || null;
  const expiry = ref.expiryDate || null;
  // صيغة التواريخ تُفحص للقائم والجديد معاً؛ وإلزام الانتهاء للجديد وحده
  const formatProblem = lotDatesProblem(production, expiry, { expiryRequired: false });
  if (formatProblem) throw lotErr(formatProblem, {}, { productId: product.id, lotNumber });
  const where = { tenantId_productId_lotNumber: { tenantId: tid, productId: product.id, lotNumber } };
  const sameDates = (m: LotMeta) => (production == null || production === m.productionDate) && (expiry == null || expiry === m.expiryDate);

  const existing = await tx.productLot.findUnique({ where, select: LOT_META_SELECT });
  if (existing) {
    const m = lotMetaOf(existing);
    if (!sameDates(m)) throw lotErr('LOT_DATES_MISMATCH', { lot: lotNumber }, { lotId: m.id, productionDate: m.productionDate, expiryDate: m.expiryDate });
    return { meta: m, created: false };
  }
  const problem = lotDatesProblem(production, expiry, { expiryRequired: product.shelfLifeOn });
  if (problem) throw lotErr(problem, {}, { productId: product.id, lotNumber });
  const ins = await tx.productLot.createMany({
    data: [{
      tenantId: tid, productId: product.id, lotNumber, productionDate: dayDate(production), expiryDate: dayDate(expiry),
      source: meta.source, sourceEntryId: meta.sourceEntryId ?? null, createdBy: meta.createdBy ?? null, note: meta.note ?? null,
    }],
    skipDuplicates: true,
  });
  const row = await tx.productLot.findUnique({ where, select: LOT_META_SELECT });
  if (!row) throw new Error('LOT_CREATE_LOST');
  const m = lotMetaOf(row);
  if (ins.count === 0) {
    // سبقنا إليه مُدرِجٌ آخر: يُعامَل كالقائم
    if (!sameDates(m)) throw lotErr('LOT_DATES_MISMATCH', { lot: lotNumber }, { lotId: m.id, productionDate: m.productionDate, expiryDate: m.expiryDate });
    return { meta: m, created: false };
  }
  await recordLotEvent(tx, {
    tenantId: tid, lotId: m.id, productId: product.id, kind: 'CREATE',
    after: { lotNumber, productionDate: m.productionDate, expiryDate: m.expiryDate, source: meta.source, sourceEntryId: meta.sourceEntryId ?? null },
    actor: meta.actor,
  });
  return { meta: m, created: true };
}

/** هل في العرض صالحٌ سالب (I1/I2 مكسور تاريخياً)؟ — لـ/lots/health والشارة */
export function viewHasDeficit(view: PlaceLotView): boolean {
  return view.deficits.some((d) => d.qty < -LOT_EPS);
}
