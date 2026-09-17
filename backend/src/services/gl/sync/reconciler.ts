/**
 * المُطابِق Reconciler (M3، DESIGN.md §5.1، §5.2).
 *
 * يقرأ المصادر بمؤشر مركّب متزايد تماماً (createdAt, id) لكل مصدر، ويستنتج الأحداث المرغوبة (desired.ts)،
 * ويدرجها بـcreateMany({skipDuplicates}). لا يستورد prisma: كل القراءة والكتابة خلف ReconcilerStore
 * (التنفيذ الفعلي sync/reconcilerStore.prisma.ts، والاختبارات بمخزن مزيّف في الذاكرة).
 *
 * 1. التمريرة الدائمة (وحدها تحرّك المؤشر): horizon = dbNow − LATE_COMMIT_WINDOW. صفحات
 *    ("createdAt","id") > المؤشر AND "createdAt" <= horizon ORDER BY "createdAt","id" LIMIT 500، ولكل صفحة في
 *    معاملة واحدة: createMany({skipDuplicates}) ثم ضبط المؤشر على مفتاح آخر صف بـGREATEST (لا يتراجع ولا يتجاوز الأفق).
 *    حتى صفحة ناقصة أو نفاد الميزانية.
 * 2. تمريرة الذيل (لا تحرّك المؤشر): الصفوف في (horizon, now] بالحلقة نفسها، أحداثها بـskipDuplicates.
 * 3. شبكة الأمان: آخر 24 ساعة بالمفتاح نفسه حتى المؤشر، متساوية الأثر (safetyNetScan).
 * 4. المراقبة: صفحة ممتلئة لم تحرّك المؤشر ⇒ stallTicks++ وسجل ERROR منظّم.
 */
import {
  LATE_COMMIT_WINDOW_MS, RECONCILE_PAGE_SIZE, SAFETY_NET_LOOKBACK_MS, compareCompositeKey, maxCompositeKey,
  type CompositeKey, type DesiredEvent, type ReconcileSourceResult, type SyncCursorState,
} from './types';
import {
  RECONCILED_SOURCES, deriveSourceEvents, type DeriveContext, type ReconciledSource, type SourceRow,
} from './desired';

// ═══ واجهة القراءة والكتابة ═══

/** إعدادات المُطابِق للشركة (GlSettings + عملة الشركة) */
export interface ReconcileSettings {
  tenantId: string;
  activatedAt: Date | null;
  timezone: string;
  /** عملة الشركة الحالية للقطة الحمولة (تُقارن بـGlSettings.currency عند الترحيل) */
  currency: string;
  currencyDecimals: number;
}

export interface PageQuery {
  /** المفتاح المركّب الحصري: ("createdAt","id") > (after.at, after.id) */
  after: CompositeKey;
  /** "createdAt" <= upTo */
  upTo: Date;
  limit: number;
}

export interface CommitPageResult {
  /** عدد الأحداث المُدرجة فعلاً (skipDuplicates) */
  inserted: number;
  /** المؤشر بعد GREATEST */
  watermark: CompositeKey;
}

export interface ReconcilerStore {
  /** (SELECT now()) — ساعة القاعدة */
  dbNow(): Promise<Date>;
  loadSettings(tenantId: string): Promise<ReconcileSettings | null>;
  readCursor(tenantId: string, source: ReconciledSource): Promise<SyncCursorState | null>;
  /** صفحة مرتبة بـ(createdAt, id) تصاعدياً */
  readPage(tenantId: string, source: ReconciledSource, q: PageQuery): Promise<SourceRow[]>;
  /** الحقائق بالمفتاح الأساسي لصفوف الصفحة (أنواع الفواتير، السندات والروابط، الأسماء) */
  loadFacts(tenantId: string, source: ReconciledSource, rows: readonly SourceRow[], settings: ReconcileSettings): Promise<DeriveContext>;
  /**
   * معاملة واحدة: createMany({skipDuplicates}) ثم المؤشر = GREATEST(المؤشر، advanceTo) مع lastRunAt وlastCount.
   * التحديث مشروط (لا يتراجع حين تكتب نبضة انتهى عقدها).
   */
  commitPage(tenantId: string, source: ReconciledSource, events: readonly DesiredEvent[], advanceTo: CompositeKey, rowCount: number): Promise<CommitPageResult>;
  /** createMany({skipDuplicates}) بلا مؤشر (الذيل وشبكة الأمان) */
  insertEvents(tenantId: string, events: readonly DesiredEvent[]): Promise<number>;
  /** stallTicks++ ويعيد القيمة الجديدة */
  recordStall(tenantId: string, source: ReconciledSource): Promise<number>;
  /** EXISTS ("createdAt","id") > المؤشر AND "createdAt" <= horizon — لتأخر المؤشر (C15، RPT‑08) */
  hasUnreadRows(tenantId: string, source: ReconciledSource, watermark: CompositeKey, horizon: Date): Promise<boolean>;
}

// ═══ الميزانية ═══

export interface ReconcileBudget {
  /** ساعة أحادية الاتجاه بالمللي ثانية (الافتراضي Date.now) */
  clock?: () => number;
  /** لحظة التوقف على الساعة نفسها */
  deadline?: number;
  /** حد الصفحات لكل تمريرة (اختبارات، والترحيل التاريخي بإيقاع محدد) */
  maxPages?: number;
}

export interface ReconcileOptions extends ReconcileBudget {
  pageSize?: number;
  /** تشغيل تمريرة الذيل (الافتراضي true) */
  tail?: boolean;
  /** سجل منظّم (الافتراضي console.error بـJSON) */
  log?: (entry: ReconcileLogEntry) => void;
  /** إعدادات محمّلة مسبقاً (تُقرأ من المخزن إن غابت) */
  settings?: ReconcileSettings | null;
  /** ساعة القاعدة محمّلة مسبقاً للنبضة */
  dbNow?: Date;
}

export interface ReconcileLogEntry {
  level: 'ERROR' | 'WARN';
  event: 'GL_SYNC_CURSOR_STALLED';
  tenantId: string;
  source: ReconciledSource;
  watermark: { at: string; id: string };
  pageSize: number;
  stallTicks: number;
}

const defaultLog = (e: ReconcileLogEntry): void => {
  console.error(JSON.stringify(e));
};

function budgetLeft(b: ReconcileBudget, pages: number): boolean {
  if (b.maxPages !== undefined && pages >= b.maxPages) return false;
  if (b.deadline !== undefined && (b.clock ?? Date.now)() >= b.deadline) return false;
  return true;
}

/** الأفق الآمن: dbNow − LATE_COMMIT_WINDOW (§5.2 البند 2) */
export function reconcileHorizon(dbNow: Date): Date {
  return new Date(dbNow.getTime() - LATE_COMMIT_WINDOW_MS);
}

export function cursorKey(c: Pick<SyncCursorState, 'watermarkAt' | 'watermarkId'>): CompositeKey {
  return { at: c.watermarkAt, id: c.watermarkId };
}

function lastKey(rows: readonly SourceRow[]): CompositeKey {
  const r = rows[rows.length - 1];
  return { at: r.createdAt, id: r.id };
}

// ═══ المصدر الواحد ═══

/**
 * نبضة مُطابِق لمصدر واحد. null إن لم تُفعَّل الشركة أو لم يُنشأ مؤشر المصدر (التفعيل §5.6 ينشئه).
 */
export async function reconcileSource(
  store: ReconcilerStore, tenantId: string, source: ReconciledSource, opts: ReconcileOptions = {},
): Promise<ReconcileSourceResult | null> {
  const settings = opts.settings !== undefined ? opts.settings : await store.loadSettings(tenantId);
  if (!settings || !settings.activatedAt) return null;
  const cursor = await store.readCursor(tenantId, source);
  if (!cursor) return null;

  const pageSize = opts.pageSize ?? RECONCILE_PAGE_SIZE;
  const log = opts.log ?? defaultLog;
  const now = opts.dbNow ?? await store.dbNow();
  const horizon = reconcileHorizon(now);
  const before = cursorKey(cursor);
  let watermark = before;

  const result: ReconcileSourceResult = {
    source, pages: 0, rowsRead: 0, eventsInserted: 0, tailRowsRead: 0, tailEventsInserted: 0,
    watermarkBefore: before, watermarkAfter: before, stalled: false, budgetExhausted: false,
  };

  // ── 1. التمريرة الدائمة ──
  let full = true;
  while (full) {
    if (!budgetLeft(opts, result.pages)) { result.budgetExhausted = true; break; }
    const rows = await store.readPage(tenantId, source, { after: watermark, upTo: horizon, limit: pageSize });
    result.pages++;
    full = rows.length >= pageSize;
    if (rows.length === 0) break;
    result.rowsRead += rows.length;
    const ctx = await store.loadFacts(tenantId, source, rows, settings);
    const events = deriveSourceEvents(source, rows, ctx);
    // لا يتجاوز الأفق: الاستعلام يقيّد createdAt <= horizon، وهذا دفاع إضافي
    const target = lastKey(rows);
    if (target.at.getTime() > horizon.getTime()) throw new RangeError(`صف بعد الأفق في صفحة ${source}`);
    const committed = await store.commitPage(tenantId, source, events, target, rows.length);
    result.eventsInserted += committed.inserted;
    const advanced = compareCompositeKey(committed.watermark, watermark) > 0;
    watermark = maxCompositeKey(watermark, committed.watermark);
    if (full && !advanced) {
      result.stalled = true;
      const stallTicks = await store.recordStall(tenantId, source);
      log({
        level: 'ERROR', event: 'GL_SYNC_CURSOR_STALLED', tenantId, source,
        watermark: { at: watermark.at.toISOString(), id: watermark.id }, pageSize, stallTicks,
      });
      break;
    }
  }
  result.watermarkAfter = watermark;

  // ── 2. تمريرة الذيل (لا تحرّك المؤشر) ──
  if (opts.tail !== false && !result.budgetExhausted && !result.stalled) {
    let after = maxCompositeKey(watermark, { at: horizon, id: '' });
    let tailPages = 0;
    for (;;) {
      if (!budgetLeft(opts, result.pages + tailPages)) { result.budgetExhausted = true; break; }
      const rows = await store.readPage(tenantId, source, { after, upTo: now, limit: pageSize });
      tailPages++;
      if (rows.length === 0) break;
      result.tailRowsRead += rows.length;
      const ctx = await store.loadFacts(tenantId, source, rows, settings);
      result.tailEventsInserted += await store.insertEvents(tenantId, deriveSourceEvents(source, rows, ctx));
      if (rows.length < pageSize) break;
      after = lastKey(rows); // في الذاكرة لهذه النبضة فقط
    }
  }
  return result;
}

/** نبضة المُطابِق لكل مصادر M3 بالترتيب، بميزانية مشتركة */
export async function reconcileTenant(store: ReconcilerStore, tenantId: string, opts: ReconcileOptions = {}): Promise<ReconcileSourceResult[]> {
  const settings = opts.settings !== undefined ? opts.settings : await store.loadSettings(tenantId);
  if (!settings || !settings.activatedAt) return [];
  const dbNow = opts.dbNow ?? await store.dbNow();
  const out: ReconcileSourceResult[] = [];
  for (const source of RECONCILED_SOURCES) {
    if (opts.deadline !== undefined && (opts.clock ?? Date.now)() >= opts.deadline) break;
    const r = await reconcileSource(store, tenantId, source, { ...opts, settings, dbNow });
    if (r) out.push(r);
  }
  return out;
}

// ═══ شبكة الأمان (§5.2 البند 4) ═══

export interface SafetyNetResult {
  source: ReconciledSource;
  rowsRead: number;
  eventsInserted: number;
  budgetExhausted: boolean;
}

/**
 * مسح آخر 24 ساعة بالمفتاح المركّب حتى المؤشر الحالي (صفوف التزمت بعد أكثر من LATE_COMMIT_WINDOW)،
 * متساوي الأثر عبر @@unique([tenantId, sourceKey]). لا يحرّك المؤشر.
 */
export async function safetyNetScan(
  store: ReconcilerStore, tenantId: string, source: ReconciledSource, opts: ReconcileOptions & { lookbackMs?: number } = {},
): Promise<SafetyNetResult | null> {
  const settings = opts.settings !== undefined ? opts.settings : await store.loadSettings(tenantId);
  if (!settings || !settings.activatedAt) return null;
  const cursor = await store.readCursor(tenantId, source);
  if (!cursor) return null;
  const pageSize = opts.pageSize ?? RECONCILE_PAGE_SIZE;
  const now = opts.dbNow ?? await store.dbNow();
  const upTo = new Date(Math.min(cursor.watermarkAt.getTime(), reconcileHorizon(now).getTime()));
  let after: CompositeKey = { at: new Date(now.getTime() - (opts.lookbackMs ?? SAFETY_NET_LOOKBACK_MS)), id: '' };
  const result: SafetyNetResult = { source, rowsRead: 0, eventsInserted: 0, budgetExhausted: false };
  if (after.at.getTime() > upTo.getTime()) return result;
  let pages = 0;
  for (;;) {
    if (!budgetLeft(opts, pages)) { result.budgetExhausted = true; break; }
    const rows = await store.readPage(tenantId, source, { after, upTo, limit: pageSize });
    pages++;
    if (rows.length === 0) break;
    result.rowsRead += rows.length;
    const ctx = await store.loadFacts(tenantId, source, rows, settings);
    result.eventsInserted += await store.insertEvents(tenantId, deriveSourceEvents(source, rows, ctx));
    if (rows.length < pageSize) break;
    after = lastKey(rows);
  }
  return result;
}

/** تأخر المؤشر بالمللي ثانية (§5.2 البند 5): dbNow − watermarkAt إن وُجدت صفوف غير مقروءة حتى الأفق، وإلا 0 */
export async function cursorLagMs(store: ReconcilerStore, tenantId: string, source: ReconciledSource, dbNow?: Date): Promise<number | null> {
  const cursor = await store.readCursor(tenantId, source);
  if (!cursor) return null;
  const now = dbNow ?? await store.dbNow();
  const unread = await store.hasUnreadRows(tenantId, source, cursorKey(cursor), reconcileHorizon(now));
  return unread ? Math.max(0, now.getTime() - cursor.watermarkAt.getTime()) : 0;
}
