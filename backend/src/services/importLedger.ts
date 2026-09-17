/**
 * منطق صرف لمسارات الاستيراد (routes/import.ts) — بلا قاعدة بيانات، قابل للاختبار.
 *
 * - تطبيع التاريخ (البند 1): نص YYYY-MM-DD فقط، يُحوَّل بـimportedEntryInstant — المصدر الواحد الذي يقرأ به كشف الحساب.
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
import { DEFAULT_TIMEZONE, addDays, compareLocalDate, isLocalDate, isValidTimeZone, todayLocal } from './gl/dates';
import { importedEntryInstant } from './importTimezoneRebase';
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

/**
 * اللحظة التي يُخزَّن بها تاريخ مستورد — **المصدر الواحد** (`importedEntryInstant`) الذي يقرأ به فلتر كشف الحساب:
 * منطقة مضبوطة ⇒ أول لحظة من يومها (zonedStartOfDay، كما في opening.ts)، و`null` (لا إعدادات دفاتر ولا مسودة)
 * ⇒ منتصف ليل UTC.
 *
 * البند 22 (الإغلاقة): كان الكاتب يفترض DEFAULT_TIMEZONE لشركة بلا إعدادات بينما صار القارئ يقرؤها بـUTC،
 * فتُكتب حركة 1 فبراير عند 2026-01-31T21:00Z وتظهر في كشف يناير. توقيتٌ واحد للطرفين أو لا توقيت لهما.
 */
export function localDateToInstant(tz: string | null, ymd: string): Date {
  if (!isImportDate(ymd)) {
    throw new ImportHttpError(400, 'IMPORT_INVALID_DATE', `تاريخ غير صالح: ${String(ymd)} (المتوقع YYYY-MM-DD)`, { date: ymd });
  }
  return importedEntryInstant(ymd, tz && isValidTimeZone(tz) ? tz : null);
}

export interface ImportGlSettings {
  activatedAt: Date | null;
  timezone: string | null;
  setupDraft?: unknown;
}

/**
 * توقيت الشركة **للعرض وحدود اليوم**: بعد التفعيل إعدادات الدفاتر؛ قبله مسودة المعالج (الخطوة 1) ثم الإعدادات ثم الرياض.
 * البند 22: لا تُستعمل لكتابة لحظة قيد مستورد (الافتراض الرياضي يزيحها عن قراءة الكشف) — تلك `explicitTimezone`.
 */
export function importTimezone(s: ImportGlSettings | null | undefined): string {
  if (!s) return DEFAULT_TIMEZONE;
  if (!s.activatedAt) {
    const d = s.setupDraft as { step1?: { timezone?: unknown } } | null | undefined;
    const tz = d && typeof d === 'object' ? d.step1?.timezone : undefined;
    if (typeof tz === 'string' && isValidTimeZone(tz)) return tz;
  }
  return s.timezone && isValidTimeZone(s.timezone) ? s.timezone : DEFAULT_TIMEZONE;
}

/**
 * البند 22: التوقيت **المضبوط فعلاً** للشركة أو null — بلا افتراض الرياض. وهو توقيت **كتابة القيد المستورد
 * وقراءة كشف الحساب معاً**: شركة لم تفتح معالج الدفاتر (وهو اختياري ومطفأ) حدودُ كشوفها بتوقيت UTC، وافتراض
 * +3 في طرف دون طرف يزيح حركاتها بين الشهور. فتُعاد null ⇒ الطرفان على منتصف ليل UTC (importedEntryInstant).
 */
export function explicitTimezone(s: ImportGlSettings | null | undefined): string | null {
  if (!s) return null;
  if (!s.activatedAt) {
    const d = s.setupDraft as { step1?: { timezone?: unknown } } | null | undefined;
    const tz = d && typeof d === 'object' ? d.step1?.timezone : undefined;
    if (typeof tz === 'string' && isValidTimeZone(tz)) return tz;
  }
  return s.timezone && isValidTimeZone(s.timezone) ? s.timezone : null;
}

export interface DateResolution {
  /** لحظة كل صف بالترتيب نفسه */
  dates: Date[];
  /** صفوف بلا تاريخ أخذت لحظة الاستيراد (قبل التفعيل فقط) */
  undatedAsToday: number;
}

export interface ResolveDatesOptions {
  /** البند 22: التوقيت المضبوط للشركة (explicitTimezone) — null ⇒ بلا افتراض، كما يقرأ كشف الحساب */
  timezone: string | null;
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

/** رسالة 409 IMPORT_IN_PROGRESS العامة (نوع الدفعة الجارية في details.kind) */
export const IMPORT_IN_PROGRESS_MESSAGE = 'استيراد آخر جارٍ الآن لهذه الشركة، انتظر انتهاءه ثم راجع سجل الدفعات قبل الإعادة';

/** استيراد جارٍ للشركة (قيود، أو النوع نفسه للعملاء/المنتجات/الأسعار) ⇒ 409 IMPORT_IN_PROGRESS (واحد في كل مرة، حتى مع force) */
export function assertNoRunningImport(running: { id: string; kind: string; createdAt: Date } | null | undefined): void {
  if (!running) return;
  throw new ImportHttpError(409, 'IMPORT_IN_PROGRESS', IMPORT_IN_PROGRESS_MESSAGE,
    { batchId: running.id, kind: running.kind, createdAt: running.createdAt.toISOString() });
}

/** أنواع الدفعات الرئيسية المحجوزة قبل الكتابة (البند 20) */
export const IMPORT_MASTER_KINDS = ['customers', 'products', 'prices'] as const;
export type ImportMasterKind = typeof IMPORT_MASTER_KINDS[number];

/**
 * البند 20: فحص حجز دفعة عملاء/منتجات/أسعار تحت قفل النوع. البصمة أولاً (ما لم يُرسل force)، ثم دفعة جارية من النوع نفسه (حتى مع force).
 * running: دفعات status=running غير المتراجَع عنها (النوع والنبض يُرشَّحان هنا).
 */
export function assertMasterBatchReservable(
  kind: string,
  dup: { id: string; createdAt: Date; status?: string | null; heartbeatAt?: Date | null } | null | undefined,
  running: readonly { id: string; kind: string; createdAt: Date; status?: string | null; heartbeatAt?: Date | null }[],
  force: boolean,
  now: Date,
): void {
  assertNotDuplicateBatch(dup, force, now);
  assertNoRunningImport(running.find((b) => b.kind === kind && importBatchState(b, now) === 'running'));
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

export type BalanceSkipReason = 'BALANCE_ALREADY_IMPORTED' | 'LEDGER_ALREADY_IMPORTED' | 'BALANCE_UNBATCHED';

export const BALANCE_SKIP_MESSAGES: Record<BalanceSkipReason, string> = {
  BALANCE_ALREADY_IMPORTED: 'للعميل رصيد افتتاحي في دفعة استيراد سابقة — تراجع عنها أولاً لتصحيحه',
  LEDGER_ALREADY_IMPORTED: 'للعميل كشف حساب مستورد — الرصيد الافتتاحي يضاعف ذمته؛ تراجع عن الكشف أولاً',
  // البند 6: الاحتياط بالوصف لا دفعة له يُتراجع عنها، فلا يُطلب التراجع
  BALANCE_UNBATCHED: 'للعميل رصيد افتتاحي مسجّل خارج أي دفعة استيراد (استيراد قديم أو منقطع)، فلا دفعة يُتراجع عنها؛ صحّحه بتسوية من كشف العميل',
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
  return legacy ? 'BALANCE_UNBATCHED' : null;
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
  /** prices: السعر السابق لكل CustomerPrice قبل أول كتابة في الدفعة (null = أُنشئ جديداً)؛ غيره {} */
  previous: Record<string, number | null>;
  /** prices (البند 7): آخر سعر كتبته الدفعة لكل CustomerPrice؛ الشكل القديم بلا imported ⇒ {} */
  imported: Record<string, number>;
}

const strIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []);

function previousPrices(v: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (!k) continue;
    if (p === null) out[k] = null;
    else if (typeof p === 'number' && Number.isFinite(p)) out[k] = p;
  }
  return out;
}

function importedPrices(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (k && typeof p === 'number' && Number.isFinite(p)) out[k] = p;
  }
  return out;
}

/** يقرأ الشكل القديم (مصفوفة) والجديد {products, categories} و{records, previous, imported} للأسعار */
export function parseBatchRecordIds(recordIds: string | null | undefined): BatchRecordIds {
  if (!recordIds) return { records: [], categories: [], previous: {}, imported: {} };
  try {
    const v: unknown = JSON.parse(recordIds);
    if (Array.isArray(v)) return { records: strIds(v), categories: [], previous: {}, imported: {} };
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return { records: strIds(o.products ?? o.records), categories: strIds(o.categories), previous: previousPrices(o.previous), imported: importedPrices(o.imported) };
    }
  } catch { /* الشكل غير المتوقع يُتجاهل */ }
  return { records: [], categories: [], previous: {}, imported: {} };
}

/**
 * products ⇒ {products, categories}؛ prices ⇒ {records, previous, imported} مقصوراً على records؛
 * البقية مصفوفة كما كانت (opening.ts يقرأ مصفوفات balances/ledger)
 */
export function serializeBatchRecordIds(
  kind: string, records: readonly string[], categories: readonly string[] = [], previous: Readonly<Record<string, number | null>> = {},
  imported: Readonly<Record<string, number>> = {},
): string {
  if (kind === 'products') return JSON.stringify({ products: records, categories });
  if (kind === 'prices') {
    const prev: Record<string, number | null> = {};
    const imp: Record<string, number> = {};
    for (const id of records) {
      if (Object.prototype.hasOwnProperty.call(previous, id)) prev[id] = previous[id];
      if (Object.prototype.hasOwnProperty.call(imported, id)) imp[id] = imported[id];
    }
    return JSON.stringify({ records, previous: prev, imported: imp });
  }
  return JSON.stringify(records);
}

export interface PriceRevertItem {
  id: string;
  /** السعر قبل الدفعة: رقم ⇒ يُستعاد، null ⇒ أُنشئ فيها، undefined ⇒ شكل قديم (حذف) */
  previous: number | null | undefined;
  /** آخر سعر كتبته الدفعة (undefined ⇒ دفعة قديمة بلا فحص تغيّر) */
  imported: number | undefined;
}

/** البندان 20 و7: خطة التراجع عن دفعة أسعار — عنصر لكل معرّف فريد بسابقه ومستورده */
export function pricesRevertPlan(parsed: Pick<BatchRecordIds, 'records' | 'previous'> & { imported?: Record<string, number> }): { items: PriceRevertItem[] } {
  const items: PriceRevertItem[] = [];
  for (const id of new Set(parsed.records)) {
    const p = parsed.previous?.[id];
    const imp = parsed.imported?.[id];
    items.push({
      id,
      previous: p === null ? null : typeof p === 'number' && Number.isFinite(p) ? p : undefined,
      imported: typeof imp === 'number' && Number.isFinite(imp) ? imp : undefined,
    });
  }
  return { items };
}

/** البند 7: سبب منع استعادة سعر تغيّر بعد الاستيراد */
export const PRICE_CHANGED_AFTER_IMPORT = 'تغيّر السعر بعد الاستيراد يدوياً أو بدفعة أحدث فلم يُعد';

/**
 * البند 7: قرار التراجع لسعر واحد بالسعر الحالي (مقفول): الصف غير موجود ⇒ gone؛ تغيّر بعد الاستيراد ⇒ blocked؛
 * سابق رقمي ⇒ استعادته؛ وإلا ⇒ حذف.
 */
export function priceRevertAction(current: number | null, item: PriceRevertItem): 'gone' | 'blocked' | 'delete' | { restore: number } {
  if (current === null || current === undefined) return 'gone';
  if (item.imported !== undefined && Math.abs(Number(current) - item.imported) > 1e-9) return 'blocked';
  if (typeof item.previous === 'number') return { restore: item.previous };
  return 'delete';
}

/** قرار صف واحد في حلقة التراجع: 'already' = سبق التراجع عنه (لا كتابة)، والبقية كما في priceRevertAction */
export type PriceRevertOutcome = 'gone' | 'already' | 'blocked' | 'delete' | { restore: number };

/**
 * البند I: القرار **الذي تنفّذه حلقة التراجع نفسها** (routes/import.ts) — دالّة واحدة تُختبر بدل إعادة بنائها في الاختبار.
 * التراجع متعادٍ: سعر حالي = السابق يعني أن تراجعاً انقطع في منتصفه أعاده فعلاً، فيُعدّ منجزاً ('already')
 * لا ممنوعاً أبداً بحجّة «تغيّر بعد الاستيراد». والمنع الحقيقي (≠ المستورد و≠ السابق) كما هو.
 */
export function priceRevertOutcome(current: number | null, item: PriceRevertItem): PriceRevertOutcome {
  const action = priceRevertAction(current, item);
  if (action !== 'blocked') return action;
  // action === 'blocked' ⇒ current رقم (priceRevertAction تُعيد 'gone' للفارغ)
  return typeof item.previous === 'number' && Math.abs(Number(current) - item.previous) <= 1e-9 ? 'already' : 'blocked';
}

/** حصيلة شريحة واحدة من التراجع عن دفعة أسعار (ما التُزم في معاملتها) */
export interface PriceRevertChunkDelta {
  /** معرّفات أُنجزت فعلاً: استُعيدت أو حُذفت أو لم تعد موجودة (الممنوع ليس منها فيبقى في الدفعة) */
  done: readonly string[];
  blocked: readonly RevertBlocked[];
  restored: number;
  deleted: number;
}

export interface PricesRevertTotals {
  done: Set<string>;
  blocked: RevertBlocked[];
  restored: number;
  deleted: number;
}

export function newPricesRevertTotals(): PricesRevertTotals {
  return { done: new Set<string>(), blocked: [], restored: 0, deleted: 0 };
}

export const PRICES_REVERT_CHUNK = 500;

/**
 * البند 7 (متابعة): قائد شرائح التراجع عن دفعة أسعار.
 *
 * كل شريحة تلتزم في معاملتها، فتقدّمها يجب أن يُثبَّت **داخلها** (`remainingAfter` تعطي المتبقّي فيكتبه المستدعي مع
 * previous/imported). قبل ذلك كان التثبيت بعد الحلقة كلها: فشل شريحة متأخرة يترك الدفعة بمعرّفاتها الأصلية، فتصير
 * إعادة المحاولة تقارن السعر المستعاد بـimported القديم وتُبلّغ المالك زوراً «تغيّر السعر بعد الاستيراد».
 *
 * الدلتا لا تُضم إلى `totals.done` إلا بعد نجاح معاملتها (كما يفصل ImportBatchProgress بين write وcommit)،
 * وما التُزم يبقى في `totals` حين يُرمى الخطأ فلا يضيع.
 */
export async function runPricesRevertChunks(
  ids: readonly string[],
  items: readonly PriceRevertItem[],
  totals: PricesRevertTotals,
  runChunk: (part: readonly PriceRevertItem[], remainingAfter: (delta: readonly string[]) => string[]) => Promise<PriceRevertChunkDelta>,
  chunkSize: number = PRICES_REVERT_CHUNK,
): Promise<void> {
  for (let i = 0; i < items.length; i += chunkSize) {
    const part = items.slice(i, i + chunkSize);
    const remainingAfter = (delta: readonly string[]): string[] => {
      const d = new Set(delta);
      return ids.filter((id) => !totals.done.has(id) && !d.has(id));
    };
    const out = await runChunk(part, remainingAfter);
    for (const id of out.done) totals.done.add(id);
    totals.blocked.push(...out.blocked);
    totals.restored += out.restored;
    totals.deleted += out.deleted;
  }
}

export interface CustomerFootprint {
  invoices: number; receipts: number; paymentLinks: number; visits: number;
  /** البند 17: قيود العميل في دفعات balances/ledger غير متراجع عنها */
  importedEntries?: number;
  /** قيود كشف الحساب الأخرى */
  otherEntries?: number;
  /** أسعار خاصة */
  prices?: number;
  /** محطات خطوط سير المناديب */
  routeStops?: number;
  /** البند 17: إسناد العميل لمندوب (CustomerAssignment) — Cascade يمحوه بصمت مع العميل */
  assignments?: number;
  /**
   * البند 17 (الإغلاقة): نطاقات مستخدمي الشركة على العميل (AdminCustomerScope، Cascade).
   * **ليست سبب منع**: النطاق أثر صلاحيات لا بيانات عمل — يُحذف صراحةً ويُعدّ في `removedScopes` بالرد.
   * الحقل هنا للعرض والتوثيق وحدهما، و`customerBlockReason` تتجاهله قصداً.
   */
  scopes?: number;
}
export interface ProductFootprint { invoiceItems: number; vanLoadItems: number; warehouseEntryItems: number }

export function customerBlockReason(f: CustomerFootprint): string | null {
  if (f.invoices > 0) return 'للعميل فواتير';
  if (f.receipts > 0) return 'للعميل سندات قبض';
  if (f.paymentLinks > 0) return 'للعميل روابط دفع';
  if (f.visits > 0) return 'للعميل زيارات ميدانية';
  if ((f.importedEntries ?? 0) > 0) return 'للعميل رصيد أو كشف مستورد، تراجع عنه أولاً';
  if ((f.otherEntries ?? 0) > 0) return 'للعميل قيود في كشف الحساب';
  if ((f.prices ?? 0) > 0) return 'للعميل أسعار خاصة، تراجع عن دفعة الأسعار أو احذفها أولاً';
  if ((f.routeStops ?? 0) > 0) return 'للعميل محطات في خطوط سير المناديب';
  if ((f.assignments ?? 0) > 0) return 'العميل مُسنَد لمندوب، أزل الإسناد أولاً';
  // f.scopes (نطاقات مستخدمي الشركة) لا تمنع: أثر صلاحيات يُحذف ويُعدّ في removedScopes
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

/** البند 25: منطقة الدفاتر الزمنية تحت القفل تخالف ما حُسبت به التواريخ */
export const IMPORT_LEDGER_TIMEZONE_CHANGED_MESSAGE = 'تغيّرت المنطقة الزمنية للدفاتر أثناء تجهيز الاستيراد، أعد رفع الملف';

/**
 * حجز دفعة أرصدة/كشوف تحت القفل: التفعيل أولاً، ثم (البند 25) المنطقة الزمنية الفعلية ≠ منطقة حساب التواريخ ⇒
 * 409 IMPORT_LEDGER_STATE_CHANGED بتفاصيل {activatedAt, timezone, expectedTimezone}.
 */
export function assertImportLedgerStateUnchanged(s: {
  // البند 22: المنطقة هنا هي المضبوطة فعلاً (explicitTimezone) — null منطقة صالحة للمقارنة لا «غير ممرَّرة»
  activatedAt: Date | null | undefined; expectActivated: boolean; timezone?: string | null; expectTimezone?: string | null;
}): void {
  const activatedAt = s.activatedAt ? s.activatedAt.toISOString() : null;
  const tz = s.expectTimezone !== undefined ? { timezone: s.timezone ?? null, expectedTimezone: s.expectTimezone } : {};
  if (!!s.activatedAt !== s.expectActivated) {
    throw new ImportHttpError(409, 'IMPORT_LEDGER_STATE_CHANGED', IMPORT_LEDGER_STATE_CHANGED_MESSAGE, { activatedAt, ...tz });
  }
  if (s.expectTimezone !== undefined && s.timezone !== s.expectTimezone) {
    throw new ImportHttpError(409, 'IMPORT_LEDGER_STATE_CHANGED', IMPORT_LEDGER_TIMEZONE_CHANGED_MESSAGE, { activatedAt, ...tz });
  }
}

/** البند 19(ج): دفعة أرصدة/كشوف أخرى جارية (غير المتراجع عنها بنبض حديث) ⇒ 409 IMPORT_IN_PROGRESS */
export function otherRunningEntryImport(
  running: readonly { id: string; kind: string; createdAt: Date; status?: string | null; heartbeatAt?: Date | null }[], batchId: string, now: Date,
): void {
  assertNoRunningImport(running.find((b) =>
    b.id !== batchId && (IMPORT_ENTRY_KINDS as readonly string[]).includes(b.kind) && importBatchState(b, now) === 'running'));
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

/** فئة الدفعة تُحذف فقط إن لم يبقَ لها منتج ولا صف GlProductCategoryAccount، ولا ربط في مسودة معالج الدفاتر (البند 26) */
export function categoryDeletable(f: { products: number; accountRows: number; draftLinked?: boolean }): boolean {
  return f.products === 0 && f.accountRows === 0 && f.draftLinked !== true;
}

/** البند 26: معرّفات الفئات المربوطة بحساب إيراد في مسودة المعالج (setupDraft.step3.categoryIncomeAccounts) */
export function draftCategoryLinkIds(setupDraft: unknown): Set<string> {
  const out = new Set<string>();
  if (!setupDraft || typeof setupDraft !== 'object' || Array.isArray(setupDraft)) return out;
  const step3 = (setupDraft as Record<string, unknown>).step3;
  if (!step3 || typeof step3 !== 'object' || Array.isArray(step3)) return out;
  const links = (step3 as Record<string, unknown>).categoryIncomeAccounts;
  if (!Array.isArray(links)) return out;
  for (const l of links) {
    const id = l && typeof l === 'object' ? (l as Record<string, unknown>).categoryId : undefined;
    if (typeof id === 'string' && id) out.add(id);
  }
  return out;
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

export interface OpeningStockProduct {
  id: string; code: string; barcode?: string | null; name: string; taxPct: number;
  /** البند 24: ACTIVE | INACTIVE */
  status?: string | null;
  /** البند 24: مؤرشف */
  deletedAt?: Date | null;
}

export type OpeningStockMatchError = { error: 'NOT_FOUND' | 'INACTIVE' | 'AMBIGUOUS' };
export type OpeningStockMatch = OpeningStockProduct | OpeningStockMatchError;

const isInactiveProduct = (p: OpeningStockProduct) => p.deletedAt != null || p.status === 'INACTIVE';

/**
 * البند 24: مطابقة الصنف بالأصناف النشطة وحدها — الكود (فريد لكل شركة) ثم الباركود ثم الاسم المطبَّع.
 * الكود يطابق موقوفاً/مؤرشفاً ⇒ INACTIVE؛ باركود أو اسم مشترك بين نشطين ⇒ AMBIGUOUS (ما لم تطابق خطوة لاحقة)؛
 * لا نشط ويطابق موقوفاً بالباركود أو الاسم ⇒ INACTIVE؛ وإلا NOT_FOUND.
 */
export function openingStockProductMatcher(products: readonly OpeningStockProduct[]) {
  const activeCode = new Map<string, OpeningStockProduct>();
  const inactiveCode = new Set<string>();
  const activeBarcode = new Map<string, OpeningStockProduct[]>();
  const inactiveBarcode = new Set<string>();
  const activeName = new Map<string, OpeningStockProduct[]>();
  const inactiveName = new Set<string>();
  const push = (m: Map<string, OpeningStockProduct[]>, k: string, p: OpeningStockProduct) => { const l = m.get(k); if (l) l.push(p); else m.set(k, [p]); };
  for (const p of products) {
    const off = isInactiveProduct(p);
    const code = p.code?.trim(); const barcode = p.barcode?.trim(); const name = p.name?.trim() ? normImportName(p.name) : '';
    if (code) { if (off) inactiveCode.add(code); else activeCode.set(code, p); }
    if (barcode) { if (off) inactiveBarcode.add(barcode); else push(activeBarcode, barcode, p); }
    if (name) { if (off) inactiveName.add(name); else push(activeName, name, p); }
  }
  return (r: OpeningStockRowInput): OpeningStockMatch => {
    const code = r.productCode?.trim(); const barcode = r.barcode?.trim(); const name = r.productName?.trim() ? normImportName(r.productName) : '';
    if (code) {
      const a = activeCode.get(code);
      if (a) return a;
      if (inactiveCode.has(code)) return { error: 'INACTIVE' };
    }
    let ambiguous = false; let inactive = false;
    for (const [key, active, off] of [[barcode, activeBarcode, inactiveBarcode], [name, activeName, inactiveName]] as const) {
      if (!key) continue;
      const list = active.get(key);
      if (list && list.length === 1) return list[0];
      if (list && list.length > 1) ambiguous = true;
      else if (off.has(key)) inactive = true;
    }
    if (ambiguous) return { error: 'AMBIGUOUS' };
    if (inactive) return { error: 'INACTIVE' };
    return { error: 'NOT_FOUND' };
  };
}

/** مطابقة متوافقة: المنتج النشط أو null (الموقوف والمؤرشف والملتبس لا يطابق) */
export function openingStockProductFinder(products: readonly OpeningStockProduct[]) {
  const match = openingStockProductMatcher(products);
  return (r: OpeningStockRowInput): OpeningStockProduct | null => {
    const m = match(r);
    return 'error' in m ? null : m;
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
  findProduct: (r: OpeningStockRowInput) => OpeningStockProduct | OpeningStockMatchError | null,
  pricesIncludeTax: boolean,
): { lines: OpeningStockLine[]; errors: ImportRowError[] } {
  const lines: OpeningStockLine[] = [];
  const errors: ImportRowError[] = [];
  rows.forEach((r, i) => {
    const row = i + 2;
    // البند L: معرّف الصنف في كل خطأ صف (value) وعموده (field) — بلا كود الصنف يقف المالك أمام «صف 137: مشترك بين
    // أكثر من صنف» في ملف 5000 صف. الكود ⇒ الباركود ⇒ الاسم، وصفٌّ بلا أيٍّ منها يبقى بلا value وبلا field.
    const ident = r.productCode?.trim() || r.barcode?.trim() || r.productName?.trim() || undefined;
    const identField = ident === undefined ? undefined
      : r.productCode?.trim() ? 'productCode' : r.barcode?.trim() ? 'barcode' : 'productName';
    const p = findProduct(r);
    if (!p || 'error' in p) {
      const code = !p || p.error === 'NOT_FOUND' ? 'PRODUCT_NOT_FOUND' : p.error === 'INACTIVE' ? 'PRODUCT_INACTIVE' : 'PRODUCT_AMBIGUOUS';
      errors.push(importRowError(row, code, ident, identField));
      return;
    }
    const qty = r.qty;
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) { errors.push(importRowError(row, 'STOCK_QTY_INVALID', ident, identField)); return; }
    const cost = r.unitCost;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || cost > OPENING_STOCK_MAX_UNIT_COST) {
      errors.push(importRowError(row, 'STOCK_COST_INVALID', ident, identField));
      return;
    }
    const net = netUnitCost(cost, p.taxPct ?? 0, pricesIncludeTax);
    if (!(net > 0)) { errors.push(importRowError(row, 'STOCK_NET_COST_ZERO', ident, identField)); return; }
    lines.push({ row, productId: p.id, qty, unitCost: net });
  });
  return { lines, errors };
}

/** البند 16: بصمة الملف وحده — خيار «التكلفة شاملة الضريبة» لا يغيّرها (إعادة الرفع بالخيار الآخر تكرار) */
export function openingStockContentHash(rows: readonly OpeningStockRowInput[]): string {
  return importContentHash(OPENING_STOCK_KIND, rows as readonly Readonly<Record<string, unknown>>[]);
}

/** دفعة جرد افتتاحي سابقة غير متراجع عنها: المعرّف للسجلّ، وcreatedAt هو ما يُعرض للمالك تاريخاً */
export interface OpeningStockPriorBatch { id: string; createdAt: Date }

/** الدفعة السابقة كما يمرّرها المسار: الكائن (يُنسَّق هنا) أو تاريخها YYYY-MM-DD جاهزاً */
export type OpeningStockPriorBatchRef = OpeningStockPriorBatch | string;

/** البند K: تاريخ الدفعة السابقة للعرض — والمعرّف (UUID) لا يُعرض للمالك أبداً فلا value بدله */
function priorBatchDate(ref: OpeningStockPriorBatchRef, timezone?: string | null): string | undefined {
  if (typeof ref === 'string') return isImportDate(ref) ? ref : undefined;
  return importBatchDateLabel(ref.createdAt, timezone);
}

/**
 * البند K: تاريخ الدفعة كما يراه المالك — YYYY-MM-DD بتوقيت الشركة (التوقيت نفسه المستعمل في بقية الاستيراد،
 * zonedStartOfDay/todayLocal)، لا معرّف UUID لا يدلّه على الدفعة التي يتراجع عنها. تاريخ غير صالح ⇒ undefined (بلا value).
 */
export function importBatchDateLabel(createdAt: unknown, timezone?: string | null): string | undefined {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return undefined;
  const tz = typeof timezone === 'string' && isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  return todayLocal(createdAt, tz);
}

export interface OpeningStockMovementState {
  /**
   * أصناف لها حركة سابقة خارج دفعات الجرد الافتتاحي (بند مستودع أو تحميل/تفريغ سيارة).
   * تُبنى بـgroupBy في القاعدة (صفّ لكل صنف) لا بقراءة كل بنود المستودع إلى الذاكرة داخل معاملة تمسك قفل gl-post.
   */
  movedProductIds: ReadonlySet<string>;
  /** الصنف ⇒ دفعة opening_stock غير متراجع عنها فيها بنده (بتاريخ إنشائها، فالمالك يُدَلّ على الدفعة التي يتراجع عنها) */
  openingBatchOf: ReadonlyMap<string, OpeningStockPriorBatchRef>;
  /** توقيت الشركة لعرض تاريخ الدفعة السابقة — كبقية الاستيراد (الافتراضي DEFAULT_TIMEZONE) */
  timezone?: string | null;
}

/**
 * البندان 15 و16: بنود الجرد الافتتاحي لأصناف لها حركات سابقة تُرفض صفاً صفاً — بند في دفعة opening_stock غير متراجع عنها ⇒
 * OPENING_STOCK_ALREADY_IMPORTED (البند K: value = تاريخ الدفعة السابقة YYYY-MM-DD لا معرّفها)، وأي بند مستودع آخر
 * أو تحميل/تفريغ سيارة ⇒ PRODUCT_HAS_STOCK_MOVEMENTS.
 */
export function openingStockMovementConflicts(
  lines: readonly OpeningStockLine[], state: OpeningStockMovementState,
): { lines: OpeningStockLine[]; errors: ImportRowError[] } {
  const accepted: OpeningStockLine[] = [];
  const errors: ImportRowError[] = [];
  const moved = state.movedProductIds;
  for (const l of lines) {
    const b = state.openingBatchOf.get(l.productId);
    if (b) { errors.push(importRowError(l.row, 'OPENING_STOCK_ALREADY_IMPORTED', priorBatchDate(b, state.timezone))); continue; }
    if (moved.has(l.productId)) { errors.push(importRowError(l.row, 'PRODUCT_HAS_STOCK_MOVEMENTS')); continue; }
    accepted.push(l);
  }
  return { lines: accepted, errors };
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

// ═══ الدفعة 1 (البنود 1 و3 و4 و8 و10 و14 و20): أخطاء الصفوف والفحوص الصرفة ═══

export type ImportRowErrorCode =
  | 'CUSTOMER_NOT_FOUND' | 'CUSTOMER_AMBIGUOUS' | 'CUSTOMER_CODE_NOT_FOUND' | 'CUSTOMER_CODE_UNREGISTERED' | 'PRODUCT_NOT_FOUND' | 'ZERO_PRICE' | 'TAX_PCT_FRACTION' | 'ROW_CONFLICT' | 'ROW_WRITE_FAILED'
  // الدفعة 2: المخزون الافتتاحي (البنود 15 و16 و24) والمنتجات (البند 30)
  | 'PRODUCT_INACTIVE' | 'PRODUCT_AMBIGUOUS' | 'OPENING_STOCK_ALREADY_IMPORTED' | 'PRODUCT_HAS_STOCK_MOVEMENTS'
  | 'STOCK_QTY_INVALID' | 'STOCK_COST_INVALID' | 'STOCK_NET_COST_ZERO' | 'PRODUCT_CODE_ARCHIVED' | 'PRODUCT_DUPLICATE_IN_FILE';

/** خطأ صف في ردود الاستيراد: row = موضع الصف المرسل + 2، وvalue القيمة التي أوقعت الخطأ، وfield عمودها */
export interface ImportRowError { row: number; message: string; code?: string; value?: string; field?: string }

export const IMPORT_ROW_MESSAGES: Record<Exclude<ImportRowErrorCode, 'ROW_WRITE_FAILED'>, string> = {
  CUSTOMER_NOT_FOUND: 'العميل غير موجود استورد العملاء أولا',
  CUSTOMER_AMBIGUOUS: 'مطابقة ملتبسة: أكثر من عميل بهذا الجوال أو الاسم، أضف كود العميل',
  CUSTOMER_CODE_NOT_FOUND: 'كود العميل غير مسجّل، ويوجد عميل بالاسم أو الجوال نفسه بلا كود: أضف الكود في بطاقة العميل أو احذف عمود الكود من الملف ليُطابَق بالجوال والاسم',
  CUSTOMER_CODE_UNREGISTERED: 'كود العميل غير مسجّل، ولدى الشركة عملاء بلا كود: استورد ملف العملاء بعمود الكود مع الاسم أو الجوال ليُربط الكود بعملائه، أو أضف عمود الاسم أو الجوال إلى هذا الملف',
  PRODUCT_NOT_FOUND: 'الصنف غير موجود استورد المنتجات أولا',
  ZERO_PRICE: 'السعر الخاص صفر، أكّد في المعاينة أنه مقصود',
  TAX_PCT_FRACTION: 'نسبة الضريبة أقل من 1٪، اكتبها نسبة مئوية (15 لا 0.15)',
  ROW_CONFLICT: 'سجل بالمعرّف نفسه أُنشئ في الوقت نفسه، أعد الاستيراد لتخطيه',
  PRODUCT_INACTIVE: 'الصنف موقوف أو مؤرشف، فعّله أو استخدم صنفاً آخر',
  PRODUCT_AMBIGUOUS: 'الباركود أو الاسم مشترك بين أكثر من صنف، استخدم الكود',
  OPENING_STOCK_ALREADY_IMPORTED: 'للصنف مخزون افتتاحي في دفعة استيراد سابقة، تراجع عنها أولاً لتصحيحه',
  PRODUCT_HAS_STOCK_MOVEMENTS: 'للصنف حركات مستودع أو تحميل سيارات سابقة، فلا يُضاف جرده الافتتاحي فوق رصيد محسوب منها. صحّح رصيده بتسوية من شاشة المستودع',
  STOCK_QTY_INVALID: 'الكمية يجب أن تكون أكبر من صفر',
  STOCK_COST_INVALID: 'تكلفة الوحدة يجب أن تكون أكبر من صفر',
  STOCK_NET_COST_ZERO: 'تكلفة الوحدة الصافية صفرية بعد التقريب',
  PRODUCT_CODE_ARCHIVED: 'الكود مستخدم بصنف مؤرشف، استخدم كوداً مختلفاً',
  PRODUCT_DUPLICATE_IN_FILE: 'كود الصنف مكرر في الملف ببيانات مختلفة، أضف عمود الكود أو صحّح التكرار',
};

export function importRowError(
  row: number, code: Exclude<ImportRowErrorCode, 'ROW_WRITE_FAILED'>, value?: string, field?: string,
): ImportRowError {
  return {
    row, code, message: IMPORT_ROW_MESSAGES[code],
    ...(value !== undefined ? { value } : {}), ...(field !== undefined ? { field } : {}),
  };
}

/** فشل كتابة الصف: P2002 ⇒ ROW_CONFLICT، وإلا ROW_WRITE_FAILED بالرسالة الخام مقصوصة */
export function importWriteFailure(row: number, e: unknown): ImportRowError {
  if ((e as { code?: unknown } | null)?.code === 'P2002') return importRowError(row, 'ROW_CONFLICT');
  return { row, code: 'ROW_WRITE_FAILED', message: (e as Error | null)?.message?.slice(0, 140) || 'خطأ غير معروف' };
}

/** البند 1: السعر الخاص الصفري بلا إقرار صريح (allowZeroPrice) */
export function priceRowIssue(price: number, allowZero: boolean): 'ZERO_PRICE' | null {
  return price === 0 && allowZero !== true ? 'ZERO_PRICE' : null;
}

/** البند 14: نسبة ضريبة غير صفرية أقل من 1 (خلية Excel منسّقة ٪ ⇒ 0.15) */
export function taxPctIssue(taxPct: number | null | undefined): 'TAX_PCT_FRACTION' | null {
  return typeof taxPct === 'number' && taxPct > 0 && taxPct < 1 ? 'TAX_PCT_FRACTION' : null;
}

// ═══ البند 30: تخطيط صفوف /products ═══

export interface ProductImportRowInput {
  code: string; name: string; unit?: string | null; basePrice?: number | null; taxPct?: number | null; barcode?: string | null; category?: string | null;
}
export type ProductSkipReason = 'CODE_EXISTS' | 'DUPLICATE_IN_FILE';
export interface ProductSkippedRow { row: number; reason: ProductSkipReason; code?: string }

/**
 * توقيع الصف لمقارنة التكرار داخل الملف — بالقيم كما تُكتب في القاعدة تماماً (routes/import.ts: `taxPct: r.taxPct ?? defaultVat`).
 * البند 30: بلا defaultVat يصير صفّان بالكود نفسه، أحدهما بخانة ضريبة فارغة والآخر مكتوب فيه defaultVat، «مختلفَين»
 * ⇒ خطأ صف PRODUCT_DUPLICATE_IN_FILE كاذب بدل تخطٍّ صامت للمكرر.
 */
function productRowSignature(r: ProductImportRowInput, defaultVat: number | null): string {
  return JSON.stringify([normImportName(r.name), r.unit || 'حبة', r.basePrice ?? 0, r.taxPct ?? defaultVat ?? null, r.barcode || '', normImportName(r.category || '')]);
}

/**
 * البند 30: صفوف المنتجات ⇒ ما يُنشأ، والمتخطى برقم الصف وسببه، وأخطاء الصفوف. الكود المؤرشف ⇒ PRODUCT_CODE_ARCHIVED؛
 * القائم غير المؤرشف ⇒ CODE_EXISTS؛ المكرر في الملف مطابقاً لأول صف منشأ ⇒ DUPLICATE_IN_FILE، ومختلفاً ⇒ PRODUCT_DUPLICATE_IN_FILE؛
 * ثم نسبة الضريبة الكسرية.
 * defaultVat = ضريبة الشركة الافتراضية التي تُكتب للصف بلا خانة ضريبة (companySettings.defaultVatPct).
 */
export function planProductImportRows<R extends ProductImportRowInput>(
  rows: readonly R[], existing: readonly { code: string; deletedAt?: Date | null }[], defaultVat: number | null,
): { creates: { row: number; r: R }[]; skippedRows: ProductSkippedRow[]; errors: ImportRowError[] } {
  const archived = new Set<string>();
  const live = new Set<string>();
  for (const e of existing) (e.deletedAt ? archived : live).add(e.code);
  const seen = new Map<string, string>();
  const creates: { row: number; r: R }[] = [];
  const skippedRows: ProductSkippedRow[] = [];
  const errors: ImportRowError[] = [];
  rows.forEach((r, i) => {
    const row = i + 2;
    if (live.has(r.code)) { skippedRows.push({ row, reason: 'CODE_EXISTS', code: r.code }); return; }
    if (archived.has(r.code)) { errors.push(importRowError(row, 'PRODUCT_CODE_ARCHIVED', r.code)); return; }
    const sig = productRowSignature(r, defaultVat);
    const first = seen.get(r.code);
    if (first !== undefined) {
      if (first === sig) skippedRows.push({ row, reason: 'DUPLICATE_IN_FILE', code: r.code });
      else errors.push(importRowError(row, 'PRODUCT_DUPLICATE_IN_FILE', r.code));
      return;
    }
    // البند 14: خلية ضريبة منسّقة ٪ في Excel ⇒ 0.15
    const taxIssue = taxPctIssue(r.taxPct);
    if (taxIssue) { errors.push(importRowError(row, taxIssue)); return; }
    seen.set(r.code, sig);
    creates.push({ row, r });
  });
  return { creates, skippedRows, errors };
}

/** نتيجة مطابقة العميل (services/importMatch.ts) */
export type CustomerMatch = { id: string } | { error: 'NOT_FOUND' } | { error: 'AMBIGUOUS'; value: string } | { error: 'CODE_NOT_FOUND'; value: string }
  /** الصف بالكود وحده (بلا اسم ولا جوال) والكود غير مسجّل، والشركة فيها عملاء بكود تلقائي */
  | { error: 'CODE_UNREGISTERED'; value: string };
export interface CustomerMatchRow { customerCode?: string | null; phone?: string | null; customerName?: string | null }
export type CustomerMatcher = (row: CustomerMatchRow) => CustomerMatch;

/** مطابقة فاشلة ⇒ خطأ الصف؛ الناجحة ⇒ null */
export function customerMatchError(row: number, m: CustomerMatch): ImportRowError | null {
  if ('id' in m) return null;
  if (m.error === 'AMBIGUOUS') return importRowError(row, 'CUSTOMER_AMBIGUOUS', m.value);
  // كود النظام السابق غير مسجّل لعميل موجود بالجوال أو الاسم بكود تلقائي: لا «استورد العملاء أولا» (إعادة الاستيراد تكرّرهم)
  if (m.error === 'CODE_NOT_FOUND') return importRowError(row, 'CUSTOMER_CODE_NOT_FOUND', m.value);
  if (m.error === 'CODE_UNREGISTERED') return importRowError(row, 'CUSTOMER_CODE_UNREGISTERED', m.value);
  return importRowError(row, 'CUSTOMER_NOT_FOUND');
}

// ═══ البند 10: دمج صفوف العميل الواحد في /balances ═══

export interface ResolvedBalanceRow { row: number; customerId: string; customerName: string; amount: number; date: Date }
export interface MergedBalanceItem { customerId: string; customerName: string; rows: number[]; amount: number; date: Date }

/**
 * صفوف العميل الواحد ⇒ قيد واحد: المبلغ = roundImportAmount(مجموع المبالغ المقرّبة)، والتاريخ = أحدثها.
 * items بترتيب أول ظهور للعميل (الصفرية بعد الدمج مستبعدة ومعدودة في zero)، وmerged للعملاء متعددي الصفوف.
 */
export function mergeBalanceRows(rows: readonly ResolvedBalanceRow[], decimals: number): {
  items: MergedBalanceItem[]; merged: { customerName: string; rows: number[]; total: number }[]; zero: number;
} {
  const by = new Map<string, { customerName: string; rows: number[]; milli: number; date: Date }>();
  for (const r of rows) {
    const milli = Math.round(roundImportAmount(r.amount, decimals) * 1000);
    const g = by.get(r.customerId);
    if (!g) { by.set(r.customerId, { customerName: r.customerName, rows: [r.row], milli, date: r.date }); continue; }
    g.rows.push(r.row);
    g.milli += milli;
    if (r.date.getTime() > g.date.getTime()) g.date = r.date;
  }
  const items: MergedBalanceItem[] = [];
  const merged: { customerName: string; rows: number[]; total: number }[] = [];
  let zero = 0;
  for (const [customerId, g] of by) {
    const amount = roundImportAmount(g.milli / 1000, decimals);
    if (g.rows.length > 1) merged.push({ customerName: g.customerName, rows: g.rows, total: amount });
    if (!amount) { zero++; continue; }
    items.push({ customerId, customerName: g.customerName, rows: g.rows, amount, date: g.date });
  }
  return { items, merged, zero };
}

// ═══ البند 8: تجميع صفوف /ledger ═══

export interface LedgerRowInput extends CustomerMatchRow { description?: string | null; debit?: number | null; credit?: number | null }
export interface LedgerGroupEntry { row: number; date: Date; description?: string; debit: number; credit: number }

/**
 * صفوف الكشف ⇒ مجموعات لكل عميل (مقرَّبة لمنازل العملة). غير المطابَق ⇒ CUSTOMER_NOT_FOUND والملتبس ⇒ CUSTOMER_AMBIGUOUS لكل صف،
 * والصف الذي مدينه ودائنه صفر بعد التقريب لا يُكتب ويُعدّ في zero.
 */
export function groupLedgerRows(
  rows: readonly LedgerRowInput[], matcher: CustomerMatcher, dates: readonly Date[], decimals: number,
): { groups: Map<string, LedgerGroupEntry[]>; errors: ImportRowError[]; zero: number } {
  const groups = new Map<string, LedgerGroupEntry[]>();
  const errors: ImportRowError[] = [];
  let zero = 0;
  rows.forEach((r, i) => {
    const m = matcher(r);
    if (!('id' in m)) { errors.push(customerMatchError(i + 2, m)!); return; }
    const debit = roundImportAmount(r.debit, decimals); const credit = roundImportAmount(r.credit, decimals);
    if (!debit && !credit) { zero++; return; }
    if (!groups.has(m.id)) groups.set(m.id, []);
    groups.get(m.id)!.push({ row: i + 2, date: dates[i], description: r.description ?? undefined, debit, credit });
  });
  return { groups, errors, zero };
}
