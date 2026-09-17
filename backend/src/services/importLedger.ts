/**
 * منطق صرف لمسارات الاستيراد (routes/import.ts) — بلا قاعدة بيانات، قابل للاختبار.
 *
 * - تطبيع التاريخ (البند 1): نص YYYY-MM-DD فقط، يُحوَّل إلى أول لحظة من اليوم بتوقيت الشركة (zonedStartOfDay).
 * - الصفوف بلا تاريخ (البند 2ب): undatedDate، وبعد التفعيل رفض UNDATED_ROWS_LEDGER_ACTIVE.
 * - منع التكرار (البند 5): بصمة المحتوى، والرصيد القائم بمعرّفات الدفعات لا بالوصف، وتداخل الكشف مع المستورد.
 * - متانة التراجع (البند 10): تصنيف المحمي، وأخطاء FK، والمتبقّي، وشكل recordIds للمنتجات مع الفئات.
 *
 * - حجز الدفعة (مراجعة 3 و7): دفعة «جارية» تُنشأ قبل أي كتابة وتُحدَّث أثناء الاستيراد، فإعادة الرفع بعد تحديث الصفحة
 *   أو انقطاع الشبكة ترى البصمة والقيود الجارية؛ والرصيد الافتتاحي بلا دفعة يُتخطى بالوصف احتياطاً (مراجعة 4).
 *
 * - المخزون الافتتاحي (البند 9): opening_stock قبل التفعيل فقط، وبطريقة الأرصدة الافتتاحية، وتاريخ بدء محفوظ ≤ اليوم يتطلب إقراراً
 *   (لا يدخل الافتتاح إلا بتاريخ بدء بعد يوم الاستيراد)، بتكلفة صافية من netUnitCost. الحسم النهائي في /setup/commit.
 *
 * لا يستورد services/gl إلا dates.ts وmoney.ts (دوال صرفة)، ومن خارجها warehouseCost.ts (صرف).
 */
import { createHash } from 'node:crypto';
import { DEFAULT_TIMEZONE, addDays, compareLocalDate, isLocalDate, isValidTimeZone, todayLocal, zonedStartOfDay } from './gl/dates';
import { fromMilli, toMilli } from './gl/money';
import { netUnitCost } from './warehouseCost';

// ═══ خطأ HTTP برمز ═══

export class ImportHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ImportHttpError';
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, ImportHttpError.prototype);
  }
}

export function isImportHttpError(e: unknown): e is ImportHttpError {
  return e instanceof ImportHttpError;
}

/** جسم الرد: {success:false, code, message, ...details} */
export function importErrorBody(e: ImportHttpError): Record<string, unknown> {
  return { success: false, ...e.details, code: e.code, message: e.message };
}

// ═══ البند 1: التاريخ ═══

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD حقيقي (31/02 مرفوض) */
export function isImportDate(v: unknown): v is string {
  return typeof v === 'string' && YMD_RE.test(v) && isLocalDate(v);
}

/** أول لحظة من اليوم المحلي بتوقيت الشركة — الدالة نفسها المستعملة في opening.ts (zonedStartOfDay) */
export function localDateToInstant(tz: string, ymd: string): Date {
  if (!isImportDate(ymd)) {
    throw new ImportHttpError(400, 'IMPORT_INVALID_DATE', `تاريخ غير صالح: ${String(ymd)} (المتوقع YYYY-MM-DD)`, { date: ymd });
  }
  return zonedStartOfDay(ymd, tz && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE);
}

export interface ImportGlSettings {
  activatedAt: Date | null;
  timezone: string | null;
  setupDraft?: unknown;
}

/** توقيت الشركة: بعد التفعيل إعدادات الدفاتر؛ قبله مسودة المعالج (الخطوة 1) ثم الإعدادات ثم الرياض */
export function importTimezone(s: ImportGlSettings | null | undefined): string {
  if (!s) return DEFAULT_TIMEZONE;
  if (!s.activatedAt) {
    const d = s.setupDraft as { step1?: { timezone?: unknown } } | null | undefined;
    const tz = d && typeof d === 'object' ? d.step1?.timezone : undefined;
    if (typeof tz === 'string' && isValidTimeZone(tz)) return tz;
  }
  return s.timezone && isValidTimeZone(s.timezone) ? s.timezone : DEFAULT_TIMEZONE;
}

export interface DateResolution {
  /** لحظة كل صف بالترتيب نفسه */
  dates: Date[];
  /** صفوف بلا تاريخ أخذت لحظة الاستيراد (قبل التفعيل فقط) */
  undatedAsToday: number;
}

export interface ResolveDatesOptions {
  timezone: string;
  undatedDate?: string | null;
  /** activatedAt غير فارغ */
  activated: boolean;
  now: Date;
}

/**
 * يتحقق من كل التواريخ قبل أي كتابة (لا يُسقط سطر واحد مجموعة عميل كاملة) ويحوّلها:
 * - تاريخ غير حقيقي ⇒ 400 IMPORT_INVALID_DATE بالصفوف (رقم السطر = الفهرس + 2).
 * - بلا تاريخ: undatedDate إن وُجد؛ وإلا بعد التفعيل ⇒ 400 UNDATED_ROWS_LEDGER_ACTIVE؛ وقبله لحظة الاستيراد.
 */
export function resolveImportDates(rows: readonly { date?: string | null }[], opts: ResolveDatesOptions): DateResolution {
  let undatedInstant: Date | null = null;
  if (opts.undatedDate != null && opts.undatedDate !== '') {
    if (!isImportDate(opts.undatedDate)) {
      throw new ImportHttpError(400, 'IMPORT_INVALID_DATE', `تاريخ الصفوف بلا تاريخ غير صالح: ${opts.undatedDate} (المتوقع YYYY-MM-DD)`, { undatedDate: opts.undatedDate });
    }
    undatedInstant = localDateToInstant(opts.timezone, opts.undatedDate);
  }
  const invalid: { row: number; date: string }[] = [];
  let undated = 0;
  const dates: Date[] = rows.map((r, i) => {
    const d = typeof r.date === 'string' ? r.date.trim() : '';
    if (d) {
      if (!isImportDate(d)) { invalid.push({ row: i + 2, date: d }); return opts.now; }
      return localDateToInstant(opts.timezone, d);
    }
    if (undatedInstant) return undatedInstant;
    undated++;
    return opts.now;
  });
  if (invalid.length) {
    throw new ImportHttpError(400, 'IMPORT_INVALID_DATE', `تواريخ غير صالحة في ${invalid.length} سطر (المتوقع YYYY-MM-DD)`, { rows: invalid.slice(0, 50) });
  }
  if (undated > 0 && opts.activated) {
    throw new ImportHttpError(400, 'UNDATED_ROWS_LEDGER_ACTIVE',
      `الدفاتر مفعّلة: ${undated} سطر بلا تاريخ — حدّد تاريخاً للصفوف بلا تاريخ`, { count: undated });
  }
  return { dates, undatedAsToday: undated };
}

// ═══ البند 5(أ): البصمة ═══

function canonicalValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v === 0) return null;
    return String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === 'string') {
    const s = v.trim().replace(/\s+/g, ' ');
    return s ? s : null;
  }
  if (typeof v === 'boolean') return v ? 'true' : null;
  return JSON.stringify(v);
}

/** صف مطبَّع: مفاتيح مرتبة، نصوص مقصوصة، الفارغ والصفر محذوفان */
export function canonicalImportRow(row: Readonly<Record<string, unknown>>): string {
  const pairs: [string, string][] = [];
  for (const k of Object.keys(row).sort()) {
    const v = canonicalValue(row[k]);
    if (v !== null) pairs.push([k, v]);
  }
  return JSON.stringify(pairs);
}

/** sha256 للصفوف المطبّعة المرتبة (ترتيب الصفوف في الملف لا يغيّرها) */
export function importContentHash(kind: string, rows: readonly Readonly<Record<string, unknown>>[]): string {
  const lines = rows.map(canonicalImportRow).sort();
  return createHash('sha256').update(`${kind}\n${lines.join('\n')}`, 'utf8').digest('hex');
}

/**
 * دفعة سابقة غير متراجَع عنها بالبصمة نفسها ⇒ 409 IMPORT_DUPLICATE_BATCH، إلا مع force.
 * الدفعة الجارية (استيراد لم ينتهِ بعد) تُطابق أيضاً، وتُعلَّم running:true في التفاصيل.
 */
export function assertNotDuplicateBatch(
  existing: { id: string; createdAt: Date; status?: string | null; heartbeatAt?: Date | null } | null | undefined, force: boolean, now: Date = new Date(),
): void {
  if (!existing || force) return;
  const running = importBatchState(existing, now) === 'running';
  throw new ImportHttpError(409, 'IMPORT_DUPLICATE_BATCH',
    running ? `هذا الملف قيد الاستيراد الآن في دفعة ${existing.id} — انتظر انتهاءه وراجع سجل الدفعات` : `استُورد هذا الملف مسبقاً في دفعة ${existing.id}`,
    { batchId: existing.id, createdAt: existing.createdAt.toISOString(), ...(running ? { running: true } : {}) });
}

// ═══ مراجعة 3 و7: حجز الدفعة قبل الكتابة ═══

export const IMPORT_BATCH_RUNNING = 'running';
export const IMPORT_BATCH_DONE = 'done';
/** دفعة جارية بلا نبض أقدم من هذا ⇒ انقطعت (إعادة تشغيل الخادم): لا تحجب الاستيراد، وتُتراجع عمّا سُجّل منها */
export const IMPORT_RUNNING_STALE_MS = 10 * 60_000;
/** حفظ المعرّفات والنبض: كل N قيد جديد أو كل T ملّي ثانية */
export const IMPORT_FLUSH_EVERY_ROWS = 50;
export const IMPORT_FLUSH_EVERY_MS = 15_000;

export type ImportBatchState = 'running' | 'interrupted' | 'done';

/** حالة الدفعة: null (دفعات ما قبل الحجز) = منتهية؛ running بلا نبض حديث = منقطعة */
export function importBatchState(b: { status?: string | null; heartbeatAt?: Date | null; createdAt: Date }, now: Date): ImportBatchState {
  if (b.status !== IMPORT_BATCH_RUNNING) return b.status === 'interrupted' ? 'interrupted' : 'done';
  const beat = (b.heartbeatAt ?? b.createdAt).getTime();
  return now.getTime() - beat > IMPORT_RUNNING_STALE_MS ? 'interrupted' : 'running';
}

/** استيراد أرصدة/كشوف جارٍ للشركة ⇒ 409 IMPORT_IN_PROGRESS (واحد في كل مرة، حتى مع force) */
export function assertNoRunningImport(running: { id: string; kind: string; createdAt: Date } | null | undefined): void {
  if (!running) return;
  throw new ImportHttpError(409, 'IMPORT_IN_PROGRESS',
    'استيراد أرصدة أو كشوف حسابات جارٍ الآن لهذه الشركة — انتظر انتهاءه ثم راجع سجل الدفعات قبل الإعادة',
    { batchId: running.id, kind: running.kind, createdAt: running.createdAt.toISOString() });
}

/** التراجع عن دفعة ما زالت تُكتب يترك قيوداً تُكتب بعده ⇒ 409 IMPORT_BATCH_RUNNING */
export function assertBatchRevertible(b: { id: string; status?: string | null; heartbeatAt?: Date | null; createdAt: Date }, now: Date): void {
  if (importBatchState(b, now) !== 'running') return;
  throw new ImportHttpError(409, 'IMPORT_BATCH_RUNNING', 'الدفعة ما زالت قيد الاستيراد — انتظر انتهاءها ثم تراجع عنها', { batchId: b.id });
}

/** هل حان حفظ المعرّفات والنبض */
export function importFlushDue(p: { pending: number; lastFlushAt: number; now: number }): boolean {
  return p.pending >= IMPORT_FLUSH_EVERY_ROWS || p.now - p.lastFlushAt >= IMPORT_FLUSH_EVERY_MS;
}

/** مبلغ مستورد مقرَّب لمنازل العملة قبل التخزين (كالقيد الافتتاحي toMilli لكل صف) */
export function roundImportAmount(v: number | null | undefined, decimals: number): number {
  if (v === null || v === undefined || !Number.isFinite(v)) return 0;
  return fromMilli(toMilli(v, decimals));
}

// ═══ البند 5(ب، ج): المستورد القائم ═══

export const IMPORT_ENTRY_KINDS = ['balances', 'ledger'] as const;
export const ADJUSTMENT_TYPES = ['ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT'] as const;

export interface ImportedEntryIndex {
  balances: Set<string>;
  ledger: Set<string>;
}

/** معرّفات AccountEntry لدفعات balances/ledger غير المتراجَع عنها (المُدخلة مصفوفات) */
export function importedEntryIndex(batches: readonly { kind: string; recordIds: string | null }[]): ImportedEntryIndex {
  const idx: ImportedEntryIndex = { balances: new Set(), ledger: new Set() };
  for (const b of batches) {
    if (b.kind !== 'balances' && b.kind !== 'ledger') continue;
    for (const id of parseBatchRecordIds(b.recordIds).records) idx[b.kind].add(id);
  }
  return idx;
}

export type BalanceSkipReason = 'BALANCE_ALREADY_IMPORTED' | 'LEDGER_ALREADY_IMPORTED';

export const BALANCE_SKIP_MESSAGES: Record<BalanceSkipReason, string> = {
  BALANCE_ALREADY_IMPORTED: 'للعميل رصيد افتتاحي في دفعة استيراد سابقة — تراجع عنها أولاً لتصحيحه',
  LEDGER_ALREADY_IMPORTED: 'للعميل كشف حساب مستورد — الرصيد الافتتاحي يضاعف ذمته؛ تراجع عن الكشف أولاً',
};

/** /balances: صفوف العميل الحالية (معرّفات) ⇒ سبب التخطي أو null. الوصف لا يُعتدّ به. */
export function existingImportReason(customerEntryIds: readonly string[], idx: ImportedEntryIndex): BalanceSkipReason | null {
  let ledger = false;
  for (const id of customerEntryIds) {
    if (idx.balances.has(id)) return 'BALANCE_ALREADY_IMPORTED';
    if (idx.ledger.has(id)) ledger = true;
  }
  return ledger ? 'LEDGER_ALREADY_IMPORTED' : null;
}

/** وصف صف /balances — احتياط للأرصدة بلا دفعة (استيراد انقطع قبل تسجيلها أو سبق نظام الدفعات) */
export const OPENING_BALANCE_DESCRIPTION = 'رصيد افتتاحي';

/**
 * /balances داخل المعاملة بعد FOR UPDATE: سبب الدفعات أولاً (existingImportReason)، ثم احتياط الوصف — صف «رصيد افتتاحي»
 * ليس في دفعة ledger يُعدّ رصيداً مستورداً (التراجع يحذف صفوف دفعته، فلا يحجب إعادة الاستيراد بعده).
 */
export function balanceSkipReason(adj: readonly { id: string; description?: string | null }[], idx: ImportedEntryIndex): BalanceSkipReason | null {
  const reason = existingImportReason(adj.map((e) => e.id), idx);
  if (reason) return reason;
  const legacy = adj.some((e) => e.description === OPENING_BALANCE_DESCRIPTION && !idx.ledger.has(e.id));
  return legacy ? 'BALANCE_ALREADY_IMPORTED' : null;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LedgerOverlap {
  customerId: string;
  customerName: string;
  /** صافي (مدين − دائن) القيود المستوردة القائمة للعميل */
  existingBalance: number;
  /** صافي الكشف الجديد للعميل */
  statementNet: number;
}

/**
 * /ledger: عملاء الكشف الذين لهم قيود مستوردة قائمة (رصيد أو كشف سابق) ⇒ قائمة التداخل.
 * existingEntries: صفوف تسوية العملاء المعنيين؛ ما ليس في دفعة غير متراجَع عنها لا يُعدّ (تسوية يدوية).
 */
export function detectLedgerOverlap(
  statement: ReadonlyMap<string, readonly { debit: number; credit: number }[]>,
  existingEntries: readonly { id: string; customerId: string; debit: number | string; credit: number | string }[],
  idx: ImportedEntryIndex,
  names: ReadonlyMap<string, string>,
): LedgerOverlap[] {
  const existing = new Map<string, number>();
  for (const e of existingEntries) {
    if (!statement.has(e.customerId)) continue;
    if (!idx.balances.has(e.id) && !idx.ledger.has(e.id)) continue;
    existing.set(e.customerId, (existing.get(e.customerId) ?? 0) + Number(e.debit) - Number(e.credit));
  }
  const out: LedgerOverlap[] = [];
  for (const [cid, rows] of statement) {
    if (!existing.has(cid)) continue;
    const net = rows.reduce((s, r) => s + r.debit - r.credit, 0);
    out.push({ customerId: cid, customerName: names.get(cid) ?? '', existingBalance: round2(existing.get(cid)!), statementNet: round2(net) });
  }
  return out;
}

export function assertOverlapConfirmed(overlap: readonly LedgerOverlap[], confirmOverlap: boolean): void {
  if (!overlap.length || confirmOverlap) return;
  throw new ImportHttpError(409, 'IMPORT_OVERLAP_CONFIRM',
    `${overlap.length} عميل لهم أرصدة أو كشوف مستوردة مسبقاً — تأكيد الاستيراد يضيف الكشف فوقها`,
    { warnings: { overlap: overlap.slice(0, 500) } });
}

// ═══ البند 10: متانة التراجع ═══

export interface BatchRecordIds {
  /** معرّفات السجلات (العملاء/المنتجات/القيود/الأسعار) */
  records: string[];
  /** فئات المنتجات المُنشأة في الدفعة (products فقط) */
  categories: string[];
}

const strIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);

/** يقرأ الشكل القديم (مصفوفة) والجديد {products, categories} */
export function parseBatchRecordIds(recordIds: string | null | undefined): BatchRecordIds {
  if (!recordIds) return { records: [], categories: [] };
  try {
    const v: unknown = JSON.parse(recordIds);
    if (Array.isArray(v)) return { records: strIds(v), categories: [] };
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return { records: strIds(o.products ?? o.records), categories: strIds(o.categories) };
    }
  } catch { /* الشكل غير المتوقع يُتجاهل */ }
  return { records: [], categories: [] };
}

/** products ⇒ {products, categories}؛ البقية مصفوفة كما كانت (opening.ts يقرأ مصفوفات balances/ledger) */
export function serializeBatchRecordIds(kind: string, records: readonly string[], categories: readonly string[] = []): string {
  return kind === 'products' ? JSON.stringify({ products: records, categories }) : JSON.stringify(records);
}

export interface CustomerFootprint { invoices: number; receipts: number; paymentLinks: number; visits: number }
export interface ProductFootprint { invoiceItems: number; vanLoadItems: number; warehouseEntryItems: number }

export function customerBlockReason(f: CustomerFootprint): string | null {
  if (f.invoices > 0) return 'للعميل فواتير';
  if (f.receipts > 0) return 'للعميل سندات قبض';
  if (f.paymentLinks > 0) return 'للعميل روابط دفع';
  if (f.visits > 0) return 'للعميل زيارات ميدانية';
  return null;
}

export function productBlockReason(f: ProductFootprint): string | null {
  if (f.invoiceItems > 0) return 'للصنف بنود فواتير';
  if (f.vanLoadItems > 0) return 'للصنف تحميلات سيارات';
  if (f.warehouseEntryItems > 0) return 'للصنف حركات مستودع';
  return null;
}

/** P2003 (مفتاح أجنبي) وP2014 (علاقة مطلوبة) ⇒ محمي لا عطل */
export function isFkBlockError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'P2003' || code === 'P2014';
}

export const FK_BLOCK_REASON = 'مرتبط بسجلات أخرى';

export const LEDGER_BUSY_MESSAGE = 'جارٍ تفعيل الدفاتر، أعد المحاولة';

/** حجز دفعة أرصدة/كشوف: activatedAt تحت القفل يخالف ما حُسبت به التواريخ ⇒ 409 IMPORT_LEDGER_STATE_CHANGED بلا كتابة */
export const IMPORT_LEDGER_STATE_CHANGED_MESSAGE = 'تغيّرت حالة الدفاتر (فُعّلت) أثناء تجهيز الاستيراد — أعد رفع الملف';

export function assertImportLedgerStateUnchanged(activatedAt: Date | null | undefined, expectActivated: boolean): void {
  if (!!activatedAt === expectActivated) return;
  throw new ImportHttpError(409, 'IMPORT_LEDGER_STATE_CHANGED', IMPORT_LEDGER_STATE_CHANGED_MESSAGE, { activatedAt: activatedAt ? activatedAt.toISOString() : null });
}

/** انتهاء مهلة المعاملة التفاعلية أو انتظار القفل (قفل gl-post ممسوك باعتماد التفعيل) */
export function isLockBusyError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'P2028') return true;
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && /55P03|lock timeout|Transaction already closed|expired transaction/i.test(msg);
}

export interface RevertBlocked { id: string; name: string; reason: string }

/** المتبقّي = المعرّفات بترتيبها ناقص ما أُزيل أو لم يعد موجوداً */
export function revertOutcome(ids: readonly string[], done: ReadonlySet<string>): { reverted: boolean; remainingIds: string[] } {
  const remainingIds = ids.filter((id) => !done.has(id));
  return { reverted: remainingIds.length === 0, remainingIds };
}

/** فئة الدفعة تُحذف فقط إن لم يبقَ لها منتج ولا صف GlProductCategoryAccount */
export function categoryDeletable(f: { products: number; accountRows: number }): boolean {
  return f.products === 0 && f.accountRows === 0;
}

/** رد التراجع: blocked عدد صفري حين لا محمي (الشكل القائم)، ومصفوفة {id,name,reason} حين فشل جزئي */
export function revertResponse(kind: string, removed: number, blocked: readonly RevertBlocked[], remaining: number, extra: Record<string, unknown> = {}) {
  return { removed, blocked: blocked.length ? blocked : 0, remaining, kind, reverted: remaining === 0, ...extra };
}

// ═══ البند 9: المخزون الافتتاحي (opening_stock) ═══

export const OPENING_STOCK_KIND = 'opening_stock';
/** نوع حركة المستودع: الوارد (RECEIVE) — المسار القائم في opening.ts يقيّمه بـvalueStock */
export const OPENING_STOCK_ENTRY_TYPE = 'RECEIVE';
export const OPENING_STOCK_NOTE = 'مخزون افتتاحي (استيراد)';
/** سقف تكلفة الوحدة كمسار الوارد اليدوي (warehouse.ts: max 1e9) */
export const OPENING_STOCK_MAX_UNIT_COST = 1e9;

export const OPENING_STOCK_LEDGER_ACTIVE_MESSAGE =
  'الدفاتر مفعّلة: المخزون الافتتاحي يدخل القيد الافتتاحي وحده — سجّل الكميات من شاشة المستودع كوارد عادي';
export const OPENING_STOCK_AFTER_CUTOVER_MESSAGE =
  'المخزون المستورد اليوم لا يدخل القيد الافتتاحي إلا إذا كان تاريخ البدء بعد يوم الاستيراد، وتاريخ البدء المحفوظ في المعالج اليوم أو قبله — ' +
  'فيلزم تعديله من الغد فصاعداً إلى تاريخ بعد يوم الاستيراد والاعتماد حينها. للاستيراد على هذا الأساس أعد الإرسال مع الإقرار، أو اعتمد دون المخزون';
export const OPENING_STOCK_FULL_HISTORY_MESSAGE =
  'المخزون الافتتاحي لا يدخل الدفاتر في طريقة ترحيل التاريخ الكامل (حركات المستودع تُرحَّل مع M9). اختر طريقة الأرصدة الافتتاحية أو أدخل المخزون بعد M9';
export const OPENING_STOCK_REVERT_LEDGER_ACTIVE_MESSAGE =
  'الدفاتر مفعّلة: المخزون الافتتاحي دخل القيد الافتتاحي فلا يُتراجع عنه — صحّحه بتسوية مستودع';

function draftStep(setupDraft: unknown, key: 'step1' | 'step2'): Record<string, unknown> | null {
  if (!setupDraft || typeof setupDraft !== 'object' || Array.isArray(setupDraft)) return null;
  const step = (setupDraft as Record<string, unknown>)[key];
  return step && typeof step === 'object' && !Array.isArray(step) ? step as Record<string, unknown> : null;
}

/** تاريخ البدء في مسودة المعالج (step1.cutoverDate) إن صح */
export function draftCutoverDate(setupDraft: unknown): string | null {
  const d = draftStep(setupDraft, 'step1')?.cutoverDate;
  return isLocalDate(d) ? d : null;
}

/** طريقة الإعداد في مسودة المعالج (step2.method) إن صحت */
export function draftMethod(setupDraft: unknown): 'OPENING' | 'FULL_HISTORY' | null {
  const m = draftStep(setupDraft, 'step2')?.method;
  return m === 'OPENING' || m === 'FULL_HISTORY' ? m : null;
}

/**
 * الاستيراد مسموح ما دام activatedAt فارغاً، متسقاً مع المعالج الذي لا يقبل تاريخ بدء بعد اليوم (assertCutoverNotInFuture):
 * - FULL_HISTORY في المسودة ⇒ 409 OPENING_STOCK_FULL_HISTORY (البداية من أقدم حركة فتقع الحركة بعدها، ولا ترحيل مستودع قبل M9).
 * - تاريخ بدء محفوظ ≤ اليوم (بتوقيت الشركة) ⇒ 409 OPENING_STOCK_AFTER_CUTOVER ما لم يُقَرّ (acknowledgeCutoverChange):
 *   حركة تُنشأ الآن createdAt ≥ بداية اليوم، فلا تدخل الافتتاح إلا بتاريخ بدء بعد اليوم ⇒ اعتماد في يوم لاحق (minCutoverDate).
 *   الإقرار آمن لأن /setup/commit يرفض الاعتماد بحركة مستوردة خارج الافتتاح (LEDGER_OPENING_STOCK_AFTER_CUTOVER).
 * - بلا تاريخ بدء ⇒ مسموح، والحسم في الاعتماد.
 */
export function assertOpeningStockAllowed(i: {
  activatedAt: Date | null | undefined; setupDraft?: unknown; timezone: string; now: Date; acknowledgeCutoverChange?: boolean;
}): void {
  if (i.activatedAt) {
    throw new ImportHttpError(409, 'OPENING_STOCK_LEDGER_ACTIVE', OPENING_STOCK_LEDGER_ACTIVE_MESSAGE, { activatedAt: i.activatedAt.toISOString() });
  }
  if (draftMethod(i.setupDraft) === 'FULL_HISTORY') {
    throw new ImportHttpError(409, 'OPENING_STOCK_FULL_HISTORY', OPENING_STOCK_FULL_HISTORY_MESSAGE, { method: 'FULL_HISTORY' });
  }
  const cutoverDate = draftCutoverDate(i.setupDraft);
  if (!cutoverDate) return;
  const tz = i.timezone && isValidTimeZone(i.timezone) ? i.timezone : DEFAULT_TIMEZONE;
  const today = todayLocal(i.now, tz);
  if (compareLocalDate(cutoverDate, today) <= 0 && i.acknowledgeCutoverChange !== true) {
    throw new ImportHttpError(409, 'OPENING_STOCK_AFTER_CUTOVER', OPENING_STOCK_AFTER_CUTOVER_MESSAGE, {
      cutoverDate, today, timezone: tz, minCutoverDate: addDays(today, 1), field: 'acknowledgeCutoverChange',
    });
  }
}

/** التراجع قبل التفعيل وحده */
export function assertOpeningStockRevertAllowed(activatedAt: Date | null | undefined): void {
  if (!activatedAt) return;
  throw new ImportHttpError(409, 'OPENING_STOCK_REVERT_LEDGER_ACTIVE', OPENING_STOCK_REVERT_LEDGER_ACTIVE_MESSAGE, { activatedAt: activatedAt.toISOString() });
}

/** تطبيع الاسم (كمطابقة العملاء في import.ts): الهمزات والتاء المربوطة والياء والتشكيل */
export function normImportName(s: string): string {
  return s.trim().toLowerCase()
    .replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىي]/g, 'ي').replace(/\s+/g, ' ');
}

export interface OpeningStockProduct { id: string; code: string; barcode?: string | null; name: string; taxPct: number }

/** مطابقة الصنف: الكود (فريد لكل شركة) ثم الباركود ثم الاسم المطبَّع — باركود أو اسم مشترك بين صنفين لا يطابق */
export function openingStockProductFinder(products: readonly OpeningStockProduct[]) {
  const byCode = new Map<string, OpeningStockProduct>();
  const byBarcode = new Map<string, OpeningStockProduct | null>();
  const byName = new Map<string, OpeningStockProduct | null>();
  const put = (m: Map<string, OpeningStockProduct | null>, k: string, p: OpeningStockProduct) => { m.set(k, m.has(k) ? null : p); };
  for (const p of products) {
    if (p.code && p.code.trim()) byCode.set(p.code.trim(), p);
    if (p.barcode && p.barcode.trim()) put(byBarcode, p.barcode.trim(), p);
    if (p.name && p.name.trim()) put(byName, normImportName(p.name), p);
  }
  return (r: OpeningStockRowInput): OpeningStockProduct | null => {
    const code = r.productCode?.trim(); const barcode = r.barcode?.trim(); const name = r.productName?.trim();
    return (code && byCode.get(code)) || (barcode && byBarcode.get(barcode)) || (name && byName.get(normImportName(name))) || null;
  };
}

export interface OpeningStockRowInput {
  productCode?: string | null;
  barcode?: string | null;
  productName?: string | null;
  qty?: number | null;
  unitCost?: number | null;
}

export interface OpeningStockLine { row: number; productId: string; qty: number; unitCost: number }

/**
 * الصفوف ⇒ بنود الحركة (تكلفة صافية بـnetUnitCost كمسار الوارد اليدوي) وأخطاء الصفوف (رقم السطر = الفهرس + 2).
 * لا يُسقط صف خاطئ الطلب: صنف غير موجود، كمية ≤ 0، تكلفة ≤ 0، أو صافيها صفري بعد التقريب.
 */
export function resolveOpeningStockRows(
  rows: readonly OpeningStockRowInput[],
  findProduct: (r: OpeningStockRowInput) => OpeningStockProduct | null,
  pricesIncludeTax: boolean,
): { lines: OpeningStockLine[]; errors: { row: number; message: string }[] } {
  const lines: OpeningStockLine[] = [];
  const errors: { row: number; message: string }[] = [];
  rows.forEach((r, i) => {
    const row = i + 2;
    const p = findProduct(r);
    if (!p) { errors.push({ row, message: 'الصنف غير موجود استورد المنتجات أولا' }); return; }
    const qty = r.qty;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) { errors.push({ row, message: 'الكمية يجب أن تكون أكبر من صفر' }); return; }
    const cost = r.unitCost;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || cost > OPENING_STOCK_MAX_UNIT_COST) {
      errors.push({ row, message: 'تكلفة الوحدة يجب أن تكون أكبر من صفر' });
      return;
    }
    const net = netUnitCost(cost, p.taxPct ?? 0, pricesIncludeTax);
    if (!(net > 0)) { errors.push({ row, message: 'تكلفة الوحدة الصافية صفرية بعد التقريب' }); return; }
    lines.push({ row, productId: p.id, qty, unitCost: net });
  });
  return { lines, errors };
}

/** بصمة الملف مع خيار «التكلفة شاملة الضريبة» (الملف نفسه بالخيار الآخر ليس تكراراً) */
export function openingStockContentHash(rows: readonly OpeningStockRowInput[], pricesIncludeTax: boolean): string {
  return importContentHash(`${OPENING_STOCK_KIND}:${pricesIncludeTax ? 'inclusive' : 'net'}`, rows as readonly Readonly<Record<string, unknown>>[]);
}

/** آثار استهلاك أصناف الحركة بعد إنشائها */
export interface OpeningStockFootprint {
  /** بنود تحميل سيارات (LOAD) لأصناف الحركة منذ إنشائها */
  vanLoads: number;
  /** بنود فواتير لأصناف الحركة منذ إنشائها */
  invoiceItems: number;
  /** تسويات مستودع بالنقص لأصناف الحركة منذ إنشائها */
  warehouseOut: number;
}

export function openingStockRevertBlockReason(f: OpeningStockFootprint): string | null {
  if (f.vanLoads > 0) return 'حُمّل من أصناف المخزون الافتتاحي إلى السيارات';
  if (f.invoiceItems > 0) return 'بيعت أصناف المخزون الافتتاحي في فواتير';
  if (f.warehouseOut > 0) return 'سُوّي مخزون الأصناف بالنقص بعد الاستيراد';
  return null;
}
