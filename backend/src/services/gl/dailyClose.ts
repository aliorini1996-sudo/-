/**
 * الإقفال اليومي — ربط المبيعات والتحصيل ومخزون المستودع بالدفاتر اليدوية (أمر المالك، ٨ أكتوبر ٢٠٢٦).
 *
 * يخصّ الشركات ذات البداية النظيفة (setupMethod = CLEAN) وحدها: الشركات الأخرى مربوطةٌ أصلاً بالمُرحِّل قيداً لكل مستند
 * (sync/**) فلا تُكرَّر. وقرارات المالك (أسئلة ٨ أكتوبر):
 *  - كل ليلة الساعة 11:55 م بتوقيت الشركة قيدٌ واحد ليومه: «المبيعات» برقم واحد **شامل الضريبة**، و«المردودات» برقم واحد،
 *    و«التحصيل» في الصندوق برقم واحد، وذمم العملاء بسطرٍ لكل عميل (صافي حركته — I5).
 *  - ما يصل بعد إقفال يومه (فاتورةٌ دون اتصال رُفعت صباحاً، أو بين 11:55 و12:00) يدخل قيد اليوم التالي: نافذة كل يوم
 *    (إقفال الأمس، إقفال اليوم] بلحظة وصول الصفّ إلى الخادم (createdAt) — اليوم المُقفل لا يُمسّ.
 *  - المخزون: **المستودع وحده** بتكلفته (محرّك التقييم composeWarehouse)، ويُسجَّل كل ليلة فرقه عن رصيد 114001 في
 *    الدفاتر مقابل «التغيّر في المخزون» (513001) — فيبقى رصيد المخزون في الدفاتر = قيمة المستودع آخر اليوم.
 *  - البداية 1 أكتوبر 2026 (أو لحظة تفعيل الدفاتر إن جاءت بعده): قيدٌ افتتاحي بأرصدة العملاء ومخزون المستودع في تلك
 *    اللحظة مقابل «أرصدة افتتاحية» (319002) — وإلا ظهر من سدّد فاتورةً قديمة دائناً.
 *
 * المصدر: دفتر العملاء التشغيلي (AccountEntry) — يحمل الفاتورة والسند والإلغاء والتسوية بلحظة وصولها. وكل ليلة يُطابَق رصيد
 * كل عميل في الدفاتر برصيده في التطبيق حتى الإقفال (كالمخزون): فرقٌ لم تفسّره حركة اليوم — صفوفٌ حُذفت بالتراجع عن استيراد،
 * أو التزامٌ متأخر نادر — يُسجَّل «تسوية فرق رصيد العميل» مقابل الأرصدة الافتتاحية، فرصيد كل عميل في الدفاتر = رصيده في التطبيق. والقيود آلية (origin = AUTO، تحقق النظام) لأن حسابات العملاء والمخزون رئيسية (I4)،
 * ولكل يومٍ مفاتيح مصدر فريدة (DAILY_CLOSE:<نوع>:<التاريخ>) وعلامة إقفال (OpsMarker) في معاملة الترحيل نفسها — فلا
 * يتكرر يوم ولو أُعيد التشغيل. يُشغَّل كل دقيقة، ويُقفل اليوم بعد 11:55 بنافذة الالتزام المتأخر (10 دقائق) كي لا تفوته
 * معاملةٌ بدأت قبل الإقفال والتزمت بعده.
 */
import type { PrismaClient } from '@prisma/client';
import { SYSTEM_ACTOR, type GlTx } from './audit';
import { addDays, fromDbDate, localDate, toDbDate, zonedStartOfDay, DEFAULT_TIMEZONE } from './dates';
import { formatMilli, toMilli } from './money';
import { acquirePostLock, postMove } from './post';
import { loadBuildContext, type LedgerContext } from './resolve';
import { resolveLineAccount } from './validate';
import { LATE_COMMIT_WINDOW_MS } from './sync/types';
import { composeWarehouse, vanKeyOf } from '../warehouseStock';
import type { BuildContext, JournalSystemKey, LineDraft, LocalDate, Milli, MoveDraft } from './types';

/** بداية الربط (أمر المالك): 1 أكتوبر 2026 — أو لحظة تفعيل الدفاتر إن جاءت بعده */
export const DAILY_LINK_START: LocalDate = '2026-10-01';
/** دقائق ما قبل منتصف الليل: الإقفال 11:55 م واليوم الجديد بعده */
export const DAILY_CLOSE_MINUTES_BEFORE_MIDNIGHT = 5;
/** لا يُقفل اليوم قبل مضيّ نافذة الالتزام المتأخر بعد 11:55 — معاملةٌ بدأت قبله تلتزم ثم تُقرأ */
export const DAILY_CLOSE_LAG_MS = LATE_COMMIT_WINDOW_MS;
export const DAILY_SOURCE_TYPE = 'DAILY_CLOSE' as const;
export const DAILY_MARKER_PREFIX = 'gl-daily:';
/** أقصى أيامٍ تُقفل لشركةٍ في الدورة الواحدة (اللحاق بالأيام الماضية على دفعات) */
export const DAILY_CLOSE_MAX_DAYS_PER_TICK = 10;

// ═══ التوقيت (صرف) ═══

/** لحظة إقفال اليوم: 11:55 م بتوقيت الشركة */
export function dailyCutoff(date: LocalDate, timeZone: string = DEFAULT_TIMEZONE): Date {
  return new Date(zonedStartOfDay(addDays(date, 1), timeZone).getTime() - DAILY_CLOSE_MINUTES_BEFORE_MIDNIGHT * 60_000);
}

/** بداية الربط: بداية 1 أكتوبر بتوقيت الشركة، أو لحظة التفعيل إن جاءت بعده (البداية النظيفة: لا شيء قبل T0) */
export function linkStart(activatedAt: Date, timeZone: string = DEFAULT_TIMEZONE): { instant: Date; date: LocalDate } {
  const oct1 = zonedStartOfDay(DAILY_LINK_START, timeZone);
  const instant = activatedAt.getTime() > oct1.getTime() ? activatedAt : oct1;
  return { instant, date: localDate(instant, timeZone) };
}

/** بداية نافذة يومٍ: لحظة البداية لأول يوم، وإلا إقفال اليوم السابق (النافذة (السابق، الإقفال]) */
export function windowStartOf(date: LocalDate, start: { instant: Date; date: LocalDate }, timeZone: string): { at: Date; inclusive: boolean } {
  if (date === start.date) return { at: start.instant, inclusive: true };
  const prev = dailyCutoff(addDays(date, -1), timeZone);
  // تفعيلٌ بين 11:55 ومنتصف الليل: ما قبله في الافتتاح، فلا تبدأ نافذة الغد قبله (وإلا حُسبت تلك الدقائق مرتين)
  return start.instant.getTime() > prev.getTime() ? { at: start.instant, inclusive: true } : { at: prev, inclusive: false };
}

/** الأيام التي حان إقفالها ولم تُقفل: من اليوم التالي لآخر مُقفل (أو البداية) ما دام الإقفال + المهلة ≤ الآن */
export function dueDays(now: Date, timeZone: string, startDate: LocalDate, lastClosed: LocalDate | null, max = DAILY_CLOSE_MAX_DAYS_PER_TICK): LocalDate[] {
  const out: LocalDate[] = [];
  let d = lastClosed && lastClosed >= startDate ? addDays(lastClosed, 1) : startDate;
  while (out.length < max && dailyCutoff(d, timeZone).getTime() + DAILY_CLOSE_LAG_MS <= now.getTime()) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

export const dailyMarkerKey = (tenantId: string, date: LocalDate) => `${DAILY_MARKER_PREFIX}${tenantId}:${date}`;

// ═══ بناء القيود (صرف) ═══

export type DailyBucket = 'SALES' | 'RETURNS' | 'CASH' | 'ADJUST';

/** صفّ دفتر العملاء التشغيلي مصنَّفاً — المبالغ ملّي */
export interface DailyArRow {
  customerId: string;
  customerName: string;
  debitMilli: Milli;
  creditMilli: Milli;
  bucket: DailyBucket;
}

/**
 * تصنيف صفّ AccountEntry إلى مقابله في الدفاتر (services/accounting.ts):
 *  - RECEIPT_CREDIT/RECEIPT_DEBIT (سندٌ أو تحصيل فاتورةٍ نقدية، وعكسهما) ⇒ الصندوق
 *  - INVOICE_DEBIT/INVOICE_CREDIT على فاتورة مرتجع (المرتجع وإلغاؤه) ⇒ المردودات
 *  - INVOICE_DEBIT/INVOICE_CREDIT على فاتورة بيع (البيع وإلغاؤه) ⇒ المبيعات
 *  - غير ذلك (تسويات الرصيد واستيراد الأرصدة) ⇒ تسويات أرصدة العملاء
 */
export function dailyBucketOf(type: string, invoiceType: string | null | undefined): DailyBucket {
  if (type === 'RECEIPT_CREDIT' || type === 'RECEIPT_DEBIT') return 'CASH';
  if ((type === 'INVOICE_DEBIT' || type === 'INVOICE_CREDIT') && invoiceType) return invoiceType === 'RETURN' ? 'RETURNS' : 'SALES';
  return 'ADJUST';
}

interface JournalPick { code: string; systemKey?: JournalSystemKey }

/** دفترٌ بمفتاحه في القالب وإلا دفتر العمليات المتنوعة */
export function pickJournal(ctx: BuildContext, systemKey: JournalSystemKey): JournalPick {
  const j = ctx.journals.bySystemKey(systemKey) ?? ctx.journals.bySystemKey('MISC');
  if (!j) return { code: 'MISC', systemKey: 'MISC' };
  return { code: j.code, systemKey: (j.systemKey ?? undefined) as JournalSystemKey | undefined };
}

interface MoveBase {
  date: LocalDate;
  currencyCode: string;
  currencyDecimals: number;
  journal: JournalPick;
}

function line(accountKey: LineDraft['accountKey'], label: string, signedDebit: Milli, extra: Partial<LineDraft> = {}): LineDraft | null {
  if (signedDebit === 0n) return null;
  return {
    accountKey, label,
    debitMilli: signedDebit > 0n ? signedDebit : 0n,
    creditMilli: signedDebit < 0n ? -signedDebit : 0n,
    ...extra,
  };
}

function move(base: MoveBase, kind: 'OPEN' | 'DAY' | 'INV', narration: string, lines: (LineDraft | null)[], ref: string): MoveDraft | null {
  const ls = lines.filter((l): l is LineDraft => !!l);
  if (ls.length < 2) return null;
  return {
    kind: 'MOVE',
    journalCode: base.journal.code,
    ...(base.journal.systemKey ? { journalSystemKey: base.journal.systemKey } : {}),
    moveType: 'ENTRY',
    origin: 'AUTO',
    date: base.date,
    ref,
    narration,
    needsAttention: false,
    sourceType: DAILY_SOURCE_TYPE,
    sourceId: base.date,
    sourceKey: `${DAILY_SOURCE_TYPE}:${kind}:${base.date}`,
    sourceEvent: 'POST',
    currencyCode: base.currencyCode,
    currencyDecimals: base.currencyDecimals,
    lines: ls,
  };
}

/** صافي كل عميل (مدين − دائن) مرتَّباً بالاسم — سطرٌ لكل عميلٍ غير صفري على ذمم العملاء */
function customerLines(nets: Map<string, { name: string; milli: Milli }>, label: string): LineDraft[] {
  return [...nets.entries()]
    .filter(([, v]) => v.milli !== 0n)
    .sort((a, b) => a[1].name.localeCompare(b[1].name, 'ar') || a[0].localeCompare(b[0]))
    .map(([customerId, v]) => line('AR_CONTROL', label, v.milli, { customerId, partnerName: v.name })!)
    .filter(Boolean);
}

/**
 * قيد اليوم: ذمم العملاء بسطرٍ لكل عميل (صافي حركته)، ومقابلها «المبيعات» و«المردودات» و«التحصيل» و«تسويات أرصدة العملاء»
 * كلٌّ برقمٍ واحد. كل صفٍّ يضيف (مدين − دائن) إلى عميله ويقابله في سلّته بالعكس — فالقيد متوازن بالبناء. null بلا حركة.
 */
export function buildDailySalesMove(base: MoveBase, rows: readonly DailyArRow[]): MoveDraft | null {
  const nets = new Map<string, { name: string; milli: Milli }>();
  const buckets: Record<DailyBucket, Milli> = { SALES: 0n, RETURNS: 0n, CASH: 0n, ADJUST: 0n };
  for (const r of rows) {
    const d = r.debitMilli - r.creditMilli;
    if (d === 0n) continue;
    const cur = nets.get(r.customerId) ?? { name: r.customerName, milli: 0n };
    cur.milli += d;
    nets.set(r.customerId, cur);
    buckets[r.bucket] += d;
  }
  return move(base, 'DAY', `إقفال يوم ${base.date}: المبيعات والتحصيل (حتى 11:55 م)`, [
    line('SALES_REVENUE', `إجمالي مبيعات يوم ${base.date} شامل الضريبة`, -buckets.SALES),
    line('SALES_RETURNS', `مردودات مبيعات يوم ${base.date} شاملة الضريبة`, -buckets.RETURNS),
    line('MAIN_CASH', `تحصيل يوم ${base.date}`, -buckets.CASH),
    line('OPENING_EQUITY', `تسويات أرصدة العملاء يوم ${base.date}`, -buckets.ADJUST),
    ...customerLines(nets, `صافي حركة العميل يوم ${base.date}`),
  ], `إقفال ${base.date}`);
}

/**
 * القيد الافتتاحي للربط (أول يوم): رصيد كل عميل في التطبيق لحظة البداية ناقص رصيده في الدفاتر قبلها، وقيمة المستودع ناقص
 * رصيد 114001 قبلها — مقابل «أرصدة افتتاحية» (319002). الفرق لا الكامل: قيدٌ افتتاحي يدوي سابق لا يتكرر.
 */
export function buildLinkOpeningMove(
  base: MoveBase,
  customers: readonly { customerId: string; name: string; opsMilli: Milli; ledgerMilli: Milli }[],
  inventory: { valueMilli: Milli; ledgerMilli: Milli },
): MoveDraft | null {
  const nets = new Map<string, { name: string; milli: Milli }>();
  let total = 0n;
  for (const c of customers) {
    const d = c.opsMilli - c.ledgerMilli;
    if (d === 0n) continue;
    nets.set(c.customerId, { name: c.name, milli: d });
    total += d;
  }
  const inv = inventory.valueMilli - inventory.ledgerMilli;
  return move(base, 'OPEN', `رصيد افتتاحي للربط اليومي في بداية ${base.date}: أرصدة العملاء ومخزون المستودع`, [
    ...customerLines(nets, `رصيد العميل في بداية ${base.date}`),
    line('INVENTORY_WAREHOUSE', `قيمة مخزون المستودع في بداية ${base.date}`, inv),
    line('OPENING_EQUITY', `مقابل الأرصدة الافتتاحية للربط اليومي`, -(total + inv)),
  ], `افتتاح الربط ${base.date}`);
}

/** قيد المخزون آخر اليوم: الفرق بين قيمة المستودع ورصيد 114001 في الدفاتر، مقابل «التغيّر في المخزون» (513001) */
export function buildInventoryCloseMove(base: MoveBase, inventory: { valueMilli: Milli; ledgerMilli: Milli }): MoveDraft | null {
  const d = inventory.valueMilli - inventory.ledgerMilli;
  const value = formatMilli(inventory.valueMilli, base.currencyDecimals);
  return move(base, 'INV', `مخزون المستودع آخر يوم ${base.date}: ${value}`, [
    line('INVENTORY_WAREHOUSE', `قيمة مخزون المستودع آخر يوم ${base.date}: ${value}`, d),
    line('INVENTORY_CHANGE', `التغيّر في مخزون المستودع يوم ${base.date}`, -d),
  ], `مخزون ${base.date}`);
}

// ═══ القراءة والترحيل ═══

type Db = PrismaClient;

/** قيمة المستودع بتكلفته عند لحظةٍ (حركاتٌ وصلت قبلها — أو حتى ضمنها) — المحرّك نفسه الذي يقرأ به الافتتاح */
export async function warehouseValueAt(tx: GlTx, tenantId: string, at: Date, inclusive: boolean, decimals: number): Promise<{ valueMilli: Milli; uncostedQty: number }> {
  const createdAt = inclusive ? { lte: at } : { lt: at };
  const [wh, van] = await Promise.all([
    tx.warehouseEntryItem.findMany({
      where: { entry: { tenantId, createdAt } },
      select: { productId: true, qty: true, unitCost: true, entry: { select: { type: true, createdAt: true } } },
    }),
    tx.vanLoadItem.findMany({
      where: { vanLoad: { tenantId, createdAt } },
      select: { productId: true, qty: true, vanLoad: { select: { type: true, createdAt: true, salesRepId: true, deletedSalesRepId: true } } },
    }),
  ]);
  if (!wh.length && !van.length) return { valueMilli: 0n, uncostedQty: 0 };
  const productIds = [...new Set([...wh.map((i) => i.productId), ...van.map((i) => i.productId)])];
  const rows = composeWarehouse(
    productIds.map((id) => ({ id, name: id, code: id, unit: '' })),
    wh.map((i) => ({ productId: i.productId, qty: i.qty, type: i.entry.type, unitCost: i.unitCost, at: i.entry.createdAt })),
    van.map((i) => ({ productId: i.productId, qty: i.qty, type: i.vanLoad.type, salesRepId: vanKeyOf(i.vanLoad), at: i.vanLoad.createdAt })),
    decimals,
  );
  let valueMilli = 0n;
  let uncostedQty = 0;
  for (const r of rows) {
    if (Number.isFinite(r.stockValue)) valueMilli += toMilli(r.stockValue, decimals);
    if (r.uncostedQty > 1e-9) uncostedQty += r.uncostedQty;
  }
  return { valueMilli, uncostedQty };
}

/** رصيد حسابٍ بمفتاحه في الدفاتر (المرحّل) حتى تاريخٍ — شاملاً أو قبله، ومجمّعاً بالعميل عند الطلب */
async function ledgerBalance(tx: GlTx, tenantId: string, accountId: string, date: LocalDate, inclusive: boolean): Promise<Milli> {
  const agg = await tx.glMoveLine.aggregate({
    where: { tenantId, accountId, posted: true, date: inclusive ? { lte: toDbDate(date) } : { lt: toDbDate(date) } },
    _sum: { debitMilli: true, creditMilli: true },
  });
  return (agg._sum.debitMilli ?? 0n) - (agg._sum.creditMilli ?? 0n);
}

function accountIdOf(ctx: BuildContext, key: LineDraft['accountKey']): string {
  const a = resolveLineAccount({ accountKey: key, label: '', debitMilli: 0n, creditMilli: 0n }, ctx.accounts);
  if (!a) throw new Error(`حساب الربط ${String(key)} غير مربوط في الدفاتر`);
  return a.id;
}

/**
 * فرق كل عميل بعد حركة اليوم: رصيده في التطبيق (كل صفوفه حتى الإقفال) ناقص رصيده في الدفاتر حتى اليوم وافتتاح اليوم (إن كان)
 * وصافي نافذته — صفوف تسويةٍ مقابل الأرصدة الافتتاحية، صفرٌ في الأحوال العادية. تلتقط صفوفاً حُذفت بعد إقفال يومها (التراجع عن
 * استيراد أرصدة) والتزاماً متأخراً نادراً — فرصيد العميل في الدفاتر يطابق التطبيق كل ليلة.
 */
async function customerResiduals(
  tx: GlTx, t: DailyTenant, date: LocalDate, cutoff: Date, decimals: number, arAccount: string,
  dayRows: readonly DailyArRow[], opening: ReadonlyMap<string, Milli>, sim?: SimulatedLedger,
): Promise<DailyArRow[]> {
  const [ops, ledger] = await Promise.all([
    tx.accountEntry.groupBy({ by: ['customerId'], where: { tenantId: t.tenantId, createdAt: { lte: cutoff } }, _sum: { debit: true, credit: true } }),
    tx.glMoveLine.groupBy({ by: ['customerId'], where: { tenantId: t.tenantId, accountId: arAccount, posted: true, date: { lte: toDbDate(date) } }, _sum: { debitMilli: true, creditMilli: true } }),
  ]);
  // البداية: لا يُطابَق ما قبل لحظة البداية إلا عبر الافتتاح — والصفوف قبلها داخلةٌ في ops، وافتتاحها في opening أو في الدفاتر
  const diff = new Map<string, Milli>();
  for (const o of ops) diff.set(o.customerId, toMilli(o._sum.debit ?? 0, decimals) - toMilli(o._sum.credit ?? 0, decimals));
  for (const l of ledger) {
    if (!l.customerId) continue;
    diff.set(l.customerId, (diff.get(l.customerId) ?? 0n) - ((l._sum.debitMilli ?? 0n) - (l._sum.creditMilli ?? 0n)));
  }
  for (const [id, v] of opening) diff.set(id, (diff.get(id) ?? 0n) - v);
  // المعاينة: أثر ما خُطّط للأيام السابقة كأنه رُحّل
  for (const [id, v] of sim?.ar ?? []) diff.set(id, (diff.get(id) ?? 0n) - v);
  for (const r of dayRows) diff.set(r.customerId, (diff.get(r.customerId) ?? 0n) - (r.debitMilli - r.creditMilli));
  const ids = [...diff.entries()].filter(([, v]) => v !== 0n).map(([id]) => id);
  if (!ids.length) return [];
  const names = new Map(dayRows.map((r) => [r.customerId, r.customerName] as const));
  const missing = ids.filter((id) => !names.has(id));
  for (let i = 0; i < missing.length; i += 500) {
    for (const c of await tx.customer.findMany({ where: { tenantId: t.tenantId, id: { in: missing.slice(i, i + 500) } }, select: { id: true, name: true } })) names.set(c.id, c.name);
  }
  return ids.map((id) => {
    const v = diff.get(id)!;
    return { customerId: id, customerName: names.get(id) ?? 'عميل', debitMilli: v > 0n ? v : 0n, creditMilli: v < 0n ? -v : 0n, bucket: 'ADJUST' as const };
  });
}

export interface DailyTenant {
  tenantId: string;
  timeZone: string;
  start: { instant: Date; date: LocalDate };
}

export interface DailyClosePlan {
  date: LocalDate;
  drafts: MoveDraft[];
  inventoryValueMilli: Milli;
  uncostedQty: number;
}

/** يبني قيود يومٍ (الافتتاح أول يوم، ثم اليوم، ثم المخزون) داخل المعاملة — بلا ترحيل. ledgerInvAdjust: أثر ما سبقه في الخطة نفسها */
/** أثر قيودٍ مخطّطة لم تُرحَّل (المعاينة وحدها): صافي ذمم كل عميل وصافي 114001 */
export interface SimulatedLedger { ar: Map<string, Milli>; inv: Milli }

async function planDay(tx: GlTx, t: DailyTenant, date: LocalDate, context: LedgerContext, sim?: SimulatedLedger): Promise<DailyClosePlan> {
  const ctx = context.ctx;
  const decimals = ctx.settings.currencyDecimals;
  const base = (systemKey: JournalSystemKey): MoveBase => ({ date, currencyCode: ctx.settings.currency, currencyDecimals: decimals, journal: pickJournal(ctx, systemKey) });
  const drafts: MoveDraft[] = [];
  const invAccount = accountIdOf(ctx, 'INVENTORY_WAREHOUSE');
  let openingInvMilli = 0n;
  const openingCustomerMilli = new Map<string, Milli>();
  // عملة الشركة تغيّرت بعد تفعيل الدفاتر (دولار/يورو) ⇒ لا يُرحَّل بعملةٍ غير عملة الدفاتر — خطأٌ ظاهر لا ترحيلٌ صامت
  const company = await tx.companySettings.findUnique({ where: { tenantId: t.tenantId }, select: { currency: true } });
  if (company?.currency && company.currency !== ctx.settings.currency) {
    throw new Error(`عملة الشركة ${company.currency} تختلف عن عملة الدفاتر ${ctx.settings.currency} — لا يُرحَّل الإقفال اليومي`);
  }

  // ١) الافتتاح — أول يومٍ وحده
  if (date === t.start.date) {
    const arAccount = accountIdOf(ctx, 'AR_CONTROL');
    const [ops, ledger] = await Promise.all([
      tx.accountEntry.groupBy({ by: ['customerId'], where: { tenantId: t.tenantId, createdAt: { lt: t.start.instant } }, _sum: { debit: true, credit: true } }),
      tx.glMoveLine.groupBy({ by: ['customerId'], where: { tenantId: t.tenantId, accountId: arAccount, posted: true, date: { lt: toDbDate(date) } }, _sum: { debitMilli: true, creditMilli: true } }),
    ]);
    const map = new Map<string, { opsMilli: Milli; ledgerMilli: Milli }>();
    for (const o of ops) map.set(o.customerId, { opsMilli: toMilli(o._sum.debit ?? 0, decimals) - toMilli(o._sum.credit ?? 0, decimals), ledgerMilli: 0n });
    for (const l of ledger) {
      if (!l.customerId) continue;
      const cur = map.get(l.customerId) ?? { opsMilli: 0n, ledgerMilli: 0n };
      cur.ledgerMilli = (l._sum.debitMilli ?? 0n) - (l._sum.creditMilli ?? 0n);
      map.set(l.customerId, cur);
    }
    const ids = [...map.entries()].filter(([, v]) => v.opsMilli !== v.ledgerMilli).map(([id]) => id);
    const names = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const c of await tx.customer.findMany({ where: { tenantId: t.tenantId, id: { in: ids.slice(i, i + 500) } }, select: { id: true, name: true } })) names.set(c.id, c.name);
    }
    const inv = await warehouseValueAt(tx, t.tenantId, t.start.instant, false, decimals);
    const invLedger = await ledgerBalance(tx, t.tenantId, invAccount, date, false);
    const open = buildLinkOpeningMove(base('MISC'),
      ids.map((id) => ({ customerId: id, name: names.get(id) ?? 'عميل', ...map.get(id)! })),
      { valueMilli: inv.valueMilli, ledgerMilli: invLedger });
    if (open) {
      drafts.push(open);
      openingInvMilli = inv.valueMilli - invLedger;
      for (const id of ids) openingCustomerMilli.set(id, map.get(id)!.opsMilli - map.get(id)!.ledgerMilli);
    }
  }

  // ٢) قيد اليوم من دفتر العملاء التشغيلي في نافذته
  const ws = windowStartOf(date, t.start, t.timeZone);
  const cutoff = dailyCutoff(date, t.timeZone);
  const entries = await tx.accountEntry.findMany({
    where: { tenantId: t.tenantId, createdAt: { ...(ws.inclusive ? { gte: ws.at } : { gt: ws.at }), lte: cutoff } },
    select: { customerId: true, type: true, debit: true, credit: true, customer: { select: { name: true } }, invoice: { select: { type: true } } },
  });
  const dayRows: DailyArRow[] = entries.map((e) => ({
    customerId: e.customerId,
    customerName: e.customer?.name ?? 'عميل',
    debitMilli: toMilli(e.debit ?? 0, decimals),
    creditMilli: toMilli(e.credit ?? 0, decimals),
    bucket: dailyBucketOf(e.type, e.invoice?.type ?? null),
  }));
  // مطابقة كل عميل: رصيده في التطبيق حتى الإقفال = رصيده في الدفاتر حتى اليوم + افتتاح اليوم + صافي نافذته — وإلا فالفرق تسوية
  dayRows.push(...await customerResiduals(tx, t, date, cutoff, decimals, accountIdOf(ctx, 'AR_CONTROL'), dayRows, openingCustomerMilli, sim));
  const day = buildDailySalesMove(base('SALES'), dayRows);
  if (day) drafts.push(day);

  // ٣) المخزون آخر اليوم: الفرق عن رصيد الدفاتر حتى اليوم (ومنه افتتاح اليوم إن رُحّل في الخطة نفسها)
  const inv = await warehouseValueAt(tx, t.tenantId, cutoff, true, decimals);
  const invLedger = (await ledgerBalance(tx, t.tenantId, invAccount, date, true)) + openingInvMilli + (sim?.inv ?? 0n);
  const invMove = buildInventoryCloseMove(base('STOCK'), { valueMilli: inv.valueMilli, ledgerMilli: invLedger });
  if (invMove) drafts.push(invMove);

  return { date, drafts, inventoryValueMilli: inv.valueMilli, uncostedQty: inv.uncostedQty };
}

/**
 * خطط أيامٍ متتالية بلا ترحيل (للمعاينة والتحقق قبل النشر) — لا قفل ولا كتابة: أثر كل يومٍ مخطّط يُحاكى ترحيله لليوم الذي يليه
 * (ذمم كل عميل و114001)، فتظهر الأرقام كما ستُرحَّل فعلاً.
 */
export async function previewDailyCloseRange(tx: GlTx, t: DailyTenant, dates: readonly LocalDate[]): Promise<DailyClosePlan[]> {
  const context = await loadBuildContext(tx, t.tenantId);
  const sim: SimulatedLedger = { ar: new Map(), inv: 0n };
  const out: DailyClosePlan[] = [];
  for (const date of dates) {
    const plan = await planDay(tx, t, date, context, sim);
    for (const d of plan.drafts) {
      for (const l of d.lines) {
        const v = l.debitMilli - l.creditMilli;
        if (l.accountKey === 'AR_CONTROL' && l.customerId) sim.ar.set(l.customerId, (sim.ar.get(l.customerId) ?? 0n) + v);
        if (l.accountKey === 'INVENTORY_WAREHOUSE') sim.inv += v;
      }
    }
    out.push(plan);
  }
  return out;
}

/**
 * يُقفل يوماً لشركة في معاملة واحدة تحت قفل الترحيل: علامة اليوم موجودة ⇒ لا شيء؛ وإلا يُرحِّل قيوده (آلية) ثم يكتب العلامة.
 * مفتاح المصدر الفريد لكل قيد يمنع التكرار ولو سبقت العلامة. يعيد أرقام القيود المرحّلة أو 'ALREADY'.
 */
export async function closeDay(db: Db, t: DailyTenant, date: LocalDate, now = new Date()): Promise<string[] | 'ALREADY'> {
  return db.$transaction(async (tx) => {
    await acquirePostLock(tx, t.tenantId);
    const key = dailyMarkerKey(t.tenantId, date);
    if (await tx.opsMarker.findUnique({ where: { key }, select: { key: true } })) return 'ALREADY' as const;
    const context = await loadBuildContext(tx, t.tenantId);
    const plan = await planDay(tx, t, date, context);
    const numbers: string[] = [];
    for (const d of plan.drafts) {
      const p = await postMove(tx, d, { tenantId: t.tenantId, actor: SYSTEM_ACTOR, context, now });
      numbers.push(p.number);
    }
    await tx.opsMarker.create({
      data: { key, value: JSON.stringify({ moves: numbers, inventory: plan.inventoryValueMilli.toString(), uncostedQty: plan.uncostedQty }) },
    });
    return numbers;
  }, { maxWait: 10_000, timeout: 120_000 });
}

/** الشركات المعنيّة: دفاتر مفعّلة ببدايةٍ نظيفة والميزة مفعّلة */
export async function dailyCloseTenants(db: Db): Promise<DailyTenant[]> {
  const rows = await db.glSettings.findMany({
    where: { activatedAt: { not: null }, setupMethod: 'CLEAN', tenant: { accountingSuiteEnabled: true, accountingEnabled: true } },
    select: { tenantId: true, timezone: true, activatedAt: true },
  });
  return rows.map((r) => {
    const timeZone = r.timezone || DEFAULT_TIMEZONE;
    return { tenantId: r.tenantId, timeZone, start: linkStart(r.activatedAt!, timeZone) };
  });
}

/** آخر يومٍ مُقفل لشركة (من علاماتها) */
export async function lastClosedDay(db: Db, tenantId: string): Promise<LocalDate | null> {
  const prefix = `${DAILY_MARKER_PREFIX}${tenantId}:`;
  const m = await db.opsMarker.findFirst({ where: { key: { startsWith: prefix } }, orderBy: { key: 'desc' }, select: { key: true } });
  return m ? m.key.slice(prefix.length) : null;
}

const failedUntil = new Map<string, number>();

export const dailyErrorKey = (tenantId: string) => `gl-daily-error:${tenantId}`;

/**
 * تعذّر إقفال يوم (حسابٌ مؤرشف أو غير مربوط، عملةٌ تغيّرت، مهلة…): الأيام بعده تنتظره بالترتيب، فلا يمرّ صامتاً — علامة خطأ
 * وإشعارٌ للشركة مرةً لكل (يوم، سبب)، وتُمحى العلامة عند أول إقفالٍ ناجح.
 */
async function reportDailyCloseError(db: Db, tenantId: string, date: LocalDate, message: string, now: Date): Promise<void> {
  const key = dailyErrorKey(tenantId);
  const value = JSON.stringify({ date, message: message.slice(0, 500) });
  const prev = await db.opsMarker.findUnique({ where: { key }, select: { value: true } });
  if (prev?.value === value) return;
  await db.opsMarker.upsert({ where: { key }, create: { key, value }, update: { value } });
  await db.notification.create({
    data: {
      tenantId, type: 'LEDGER_DAILY_CLOSE_ERROR', title: 'تعذّر الإقفال اليومي للدفاتر',
      body: `لم يُرحَّل إقفال يوم ${date} (المبيعات والتحصيل والمخزون)، والأيام بعده تنتظره حتى يُعالج السبب: ${message.slice(0, 300)}`,
      data: JSON.stringify({ date, message: message.slice(0, 500), at: now.toISOString() }),
    },
  });
}

/** دورة: لكل شركةٍ معنيّة تُقفل الأيام التي حان إقفالها بالترتيب؛ والخطأ يوقف شركته ربع ساعة (لا يتخطّى يوماً) */
export async function runDailyCloseTick(db: Db, now = new Date()): Promise<{ closed: { tenantId: string; date: LocalDate; moves: string[] }[]; errors: { tenantId: string; date: LocalDate; message: string }[] }> {
  const out = { closed: [] as { tenantId: string; date: LocalDate; moves: string[] }[], errors: [] as { tenantId: string; date: LocalDate; message: string }[] };
  for (const t of await dailyCloseTenants(db)) {
    if ((failedUntil.get(t.tenantId) ?? 0) > now.getTime()) continue;
    const last = await lastClosedDay(db, t.tenantId);
    for (const date of dueDays(now, t.timeZone, t.start.date, last)) {
      try {
        const r = await closeDay(db, t, date, now);
        if (r !== 'ALREADY') out.closed.push({ tenantId: t.tenantId, date, moves: r });
        await db.opsMarker.deleteMany({ where: { key: dailyErrorKey(t.tenantId) } });
      } catch (e) {
        failedUntil.set(t.tenantId, now.getTime() + 15 * 60_000);
        const message = (e as { code?: string; message?: string })?.code ?? (e as Error)?.message ?? String(e);
        out.errors.push({ tenantId: t.tenantId, date, message });
        await reportDailyCloseError(db, t.tenantId, date, message, now).catch(() => undefined);
        break;
      }
    }
  }
  return out;
}

let started = false;
let running = false;

/** كل دقيقة (وأول دورة بعد دقيقة ونصف من الإقلاع). LEDGER_DAILY_CLOSE=0 للإطفاء (وLEDGER_WORKER_ENABLED=0 العام كذلك) */
export function startLedgerDailyCloseScheduler(): void {
  if (started || process.env.LEDGER_DAILY_CLOSE === '0' || process.env.LEDGER_WORKER_ENABLED === '0') return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { default: prisma } = await import('../../config/database');
      const r = await runDailyCloseTick(prisma as unknown as Db);
      for (const c of r.closed) console.log(`📒 ledger daily close ${c.tenantId} ${c.date}: ${c.moves.join(', ') || '—'}`);
      for (const e of r.errors) console.error(`ledger daily close error ${e.tenantId} ${e.date}:`, e.message);
    } catch (e) {
      console.error('ledger daily close tick error:', (e as Error)?.message);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void tick(); }, 90_000);
  setInterval(() => { void tick(); }, 60_000);
}

/** تاريخٌ محليّ لصفّ قاعدة (للعرض) */
export const dbLocalDate = (d: Date) => fromDbDate(d);
