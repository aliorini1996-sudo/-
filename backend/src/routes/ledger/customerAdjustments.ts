import { Router, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { AuthRequest } from '../../types';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { clean, currentBalance, lockCustomerRow } from '../../services/accounting';
import { ALLOCATION_ALLOWED_WHERE, ALLOCATION_BLOCKED_MIRRORS } from '../../compliance/zatca/status';
import { bookMode, isLinked, postsFromOperations } from '../../services/booksMode';
import { appendAudit, ledgerActor, type GlActor } from '../../services/gl/audit';
import { POST_TX_OPTIONS } from '../../services/gl/autoPost';
import { compareLocalDate, fromDbDate, isLocalDate, localDate, toDbDate, todayLocal, zonedStartOfDay } from '../../services/gl/dates';
import { formatMilli, fromMilli, toMilli, unitMilli } from '../../services/gl/money';
import { acquirePostLock, postMove } from '../../services/gl/post';
import { reverseMove } from '../../services/gl/reverse';
import { GlNotFoundError, loadBuildContext, type GlDb, type LedgerContext } from '../../services/gl/resolve';
import { arEntryPayload } from '../../services/gl/sync/desired';
import type { ArEntryEventPayload } from '../../services/gl/sync/types';
import { reconcileAfterPost } from '../../services/gl/reconcile/apply';
import { createPrismaReconcileStore } from '../../services/gl/reconcile/store.prisma';
import type { CustomerAdjustmentReconcilePayload, ReconcileEventInput, ReconcileOutcome } from '../../services/gl/reconcile/types';
import {
  CUSTOMER_ADJUSTMENT_KINDS, CUSTOMER_ADJUSTMENT_STATUSES, REFUND_METHODS, WRITEOFF_COUNTERS,
  buildCustomerAdjustmentMove, customerAdjustmentKey, refundCreditTarget, resolveAccountTarget, writeoffCounterAccount,
  type CustomerAdjustmentKind, type CustomerAdjustmentPayload, type RefundMethod,
} from '../../services/gl/builders/customerAdjustment';
import { LedgerError, isNoMove, type LocalDate, type Milli } from '../../services/gl/types';

/**
 * «ربط الدفاتر» L4 — M4: تسويات ذمم العملاء (العقد §4.8، B17، E4.13–E4.15؛ الواجهة: الدفاتر ← العملاء ← «تسويات ذمم العملاء»).
 *
 * - `GET  /customer-adjustments`                 القائمة بفلاتر العميل والحالة وتاريخ المستند (canViewLedger).
 * - `GET  /customer-adjustments/open-items`      فواتير العميل المفتوحة القابلة للشطب ورصيده الدائن القابل للردّ (canViewLedger).
 * - `GET  /customer-adjustments/:id`             مستند واحد بالعرض نفسه (canViewLedger).
 * - `POST /customer-adjustments`                 شطب دين معدوم أو ردّ رصيد دائن (canPostJournals) — 201 بالعرض.
 * - `POST /customer-adjustments/:id/cancel`      إلغاء بسبب إلزامي (canPostJournals).
 *
 * الحارس: الشركة يُرحِّل تشغيلُها قيوده (postsFromOperations: مربوطة أو قديمة مفعّلة)، وإلا 409 LEDGER_BOOKS_NOT_LINKED —
 * الدفاتر اليدوية لا يكتب فيها مسارٌ صفّاً تشغيلياً أبداً.
 *
 * لماذا معاملة واحدة تكتب كل شيء؟ التسوية تمسّ رصيد العميل التشغيلي (AccountEntry وCustomer.balance ومتبقّي الفواتير) والدفاتر
 * (113001) معاً، وأي فرق بينهما يكسر C3/R2. فالترتيب: قفل الترحيل ⇒ أقفال الفواتير (FOR UPDATE بترتيب المعرّف) ⇒ قفل صفّ العميل
 * — ترتيب مسار السندات والفواتير نفسه (الفاتورة ثم العميل) فلا تشابك أقفال — ⇒ صفّ AccountEntry ⇒ متبقّي الفواتير ⇒ القيد
 * (postMove SYSTEM، الإقفال مرفوض لا مُزاح: المستند يحمل تاريخه) ⇒ المستند وتخصيصاته ⇒ حدث AR_ENTRY:<entryId>:POST بحالة DONE
 * (المُطابِق إن قرأ الصفّ لاحقاً تخطّاه) ⇒ المطابقة الجزئية (للمربوطة) ⇒ التدقيق. أي خطأ يُسقط الكل: لا صفّ بلا قيد ولا قيد بلا صفّ.
 *
 * الإلغاء: صفّ AccountEntry العاكس ⇒ ردّ المتبقّي ⇒ عكس القيد (reverseMove SYSTEM بمفتاح AR_ENTRY:<id>:REVERSE، الحدث DONE) ⇒
 * AR_ENTRY:<reverseEntryId>:POST بحالة SKIPPED(NETTED) فلا يرحّله المُطابِق استيراداً ⇒ فكّ المطابقة وزوج العكس REV ⇒ CANCELLED.
 *
 * المطابقة الجزئية (L8، المربوطة وحدها — linkedPosting) بقواعد المُرحِّل نفسها (reconcileAfterPost، مصدر واحد): الشطب
 * CA:<allocationId> بين سطر دائنه وسطور مدين الفاتورة الحيّة بالأقدم استحقاقاً (الأقساط بالترتيب)، والفاتورة التي لم تُرحَّل بعد
 * تلتقطها مطابقة INVOICE:POST لاحقاً (pendingAllocationsForInvoice). والاسترداد FIFO بين سطر مدينه والأرصدة الدائنة المفتوحة للعميل
 * بالأقدم فالأقدم. والإلغاء يفكّ ما يمسّ سطور الأصل ثم يطابقه بعكسه REV.
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const POST = requireLedgerPermission('canPostJournals');

const locals = (res: Response) => res.locals.ledger as LedgerLocals;
const actorOf = (req: AuthRequest, res: Response): GlActor =>
  ledgerActor(locals(res), { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });

/** سقف التخصيصات في الطلب الواحد، وسقف الفواتير المعروضة في open-items */
export const ALLOCATIONS_LIMIT = 200;
export const OPEN_ITEMS_LIMIT = 500;
/** متبقٍّ أقل من هذا يُعدّ مسدَّداً (الحدّ نفسه في توزيع سند القبض) */
const OPEN_REMAINING_EPS = 0.004;

// ═══ الأخطاء ═══

export type AdjustmentInvalidReason =
  | 'AMOUNT_NOT_POSITIVE' | 'PRECISION' | 'DOC_DATE_IN_FUTURE' | 'COUNTER_ACCOUNT_MISSING' | 'REFUND_WITH_ALLOCATIONS';
export type AllocationInvalidReason =
  | 'ALLOCATIONS_REQUIRED' | 'AMOUNT_NOT_POSITIVE' | 'PRECISION' | 'INVOICE_NOT_FOUND' | 'OTHER_CUSTOMER' | 'NOT_CONFIRMED'
  | 'NOT_CREDIT' | 'ZATCA_PENDING' | 'EXCEEDS_REMAINING' | 'SUM_MISMATCH' | 'AUTO_INSUFFICIENT';
export type ExceedsBalanceReason = 'WRITEOFF_EXCEEDS_DEBIT_BALANCE' | 'REFUND_EXCEEDS_CREDIT_BALANCE';

const INVALID_MESSAGES: Readonly<Record<AdjustmentInvalidReason, string>> = {
  AMOUNT_NOT_POSITIVE: 'المبلغ يجب أن يكون أكبر من صفر',
  PRECISION: 'المبلغ بمنازل عشرية أكثر مما تسمح به عملة الدفاتر',
  DOC_DATE_IN_FUTURE: 'تاريخ المستند بعد اليوم',
  COUNTER_ACCOUNT_MISSING: 'الحساب المقابل للتسوية غير موجود في دليل الحسابات',
  REFUND_WITH_ALLOCATIONS: 'ردّ الرصيد الدائن لا يُخصَّص على فواتير',
};

const ALLOCATION_MESSAGES: Readonly<Record<AllocationInvalidReason, string>> = {
  ALLOCATIONS_REQUIRED: 'حدّد الفواتير المشطوبة ومبالغها أو اختر التخصيص التلقائي',
  AMOUNT_NOT_POSITIVE: 'مبلغ التخصيص يجب أن يكون أكبر من صفر',
  PRECISION: 'مبلغ التخصيص بمنازل عشرية أكثر مما تسمح به عملة الدفاتر',
  INVOICE_NOT_FOUND: 'فاتورة في التخصيص غير موجودة',
  OTHER_CUSTOMER: 'فاتورة في التخصيص لعميل آخر',
  NOT_CONFIRMED: 'فاتورة في التخصيص ليست معتمدة',
  NOT_CREDIT: 'الشطب على الفواتير الآجلة وحدها',
  ZATCA_PENDING: 'فاتورة في التخصيص لم تعتمدها هيئة الزكاة والضريبة بعد',
  EXCEEDS_REMAINING: 'مبلغ التخصيص أكبر من المتبقّي على الفاتورة',
  SUM_MISMATCH: 'مجموع التخصيصات لا يساوي مبلغ الشطب',
  AUTO_INSUFFICIENT: 'متبقّي فواتير العميل المفتوحة أقل من مبلغ الشطب',
};

const EXCEEDS_MESSAGES: Readonly<Record<ExceedsBalanceReason, string>> = {
  WRITEOFF_EXCEEDS_DEBIT_BALANCE: 'مبلغ الشطب أكبر من الرصيد المدين للعميل',
  REFUND_EXCEEDS_CREDIT_BALANCE: 'مبلغ الردّ أكبر من الرصيد الدائن للعميل',
};

export const BOOKS_NOT_LINKED_MESSAGE = 'تسويات ذمم العملاء متاحة حين تكون الدفاتر مربوطة بالنظام';
export const BEFORE_CUTOVER_MESSAGE = 'تاريخ المستند قبل بداية الدفاتر المربوطة';
export const ADJUSTMENT_CANCELLED_MESSAGE = 'التسوية ملغاة مسبقاً';

export function adjustmentInvalid(reason: AdjustmentInvalidReason, details: Record<string, unknown> = {}): LedgerHttpError {
  return new LedgerHttpError(422, INVALID_MESSAGES[reason], { reason, ...details }, 'LEDGER_ADJUSTMENT_INVALID');
}

export function allocationInvalid(reason: AllocationInvalidReason, details: Record<string, unknown> = {}): LedgerHttpError {
  return new LedgerHttpError(422, ALLOCATION_MESSAGES[reason], { reason, ...details }, 'LEDGER_ADJUSTMENT_ALLOCATION_INVALID');
}

export function exceedsBalance(reason: ExceedsBalanceReason, details: Record<string, unknown> = {}): LedgerHttpError {
  return new LedgerHttpError(422, EXCEEDS_MESSAGES[reason], { reason, ...details }, 'LEDGER_ADJUSTMENT_EXCEEDS_BALANCE');
}

// ═══ الحارس ═══

/** حقائق الإعدادات التي يقرؤها المسار (قراءة واحدة بلا سياق) */
export interface AdjustmentSettingsFacts {
  setupMethod: string | null;
  activatedAt: Date | null;
  linkedFrom: Date | null;
  cutoverDate: Date | null;
  timezone: string;
  currencyDecimals: number;
}

const SETTINGS_SELECT = {
  setupMethod: true, activatedAt: true, linkedFrom: true, cutoverDate: true, timezone: true, currencyDecimals: true,
} as const;

export type SettingsDb = Pick<GlDb, 'glSettings'>;

/** إعدادات الشركة بشرط postsFromOperations — وإلا 409 LEDGER_BOOKS_NOT_LINKED (اليدوية وغير المفعّلة) */
export async function requirePostingBooks(db: SettingsDb, tenantId: string): Promise<AdjustmentSettingsFacts> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: SETTINGS_SELECT });
  if (!s || !postsFromOperations(s)) {
    throw new LedgerHttpError(409, BOOKS_NOT_LINKED_MESSAGE, { reason: 'BOOKS_NOT_LINKED', mode: bookMode(s) }, 'LEDGER_BOOKS_NOT_LINKED');
  }
  return s;
}

/** أول يوم تقبله التسويات: بداية الربط (linkedFrom)، وإلا تاريخ البدء للدفاتر القديمة */
export function adjustmentCutover(s: Pick<AdjustmentSettingsFacts, 'linkedFrom' | 'cutoverDate'>): LocalDate | null {
  const d = s.linkedFrom ?? s.cutoverDate;
  return d ? fromDbDate(d) : null;
}

// ═══ المدخلات ═══

const amountInput = z.union([z.number().finite(), z.string().trim().min(1).max(40)]);
const idInput = z.string().trim().min(1).max(64);

export const createAdjustmentSchema = z.object({
  customerId: idInput,
  kind: z.enum(CUSTOMER_ADJUSTMENT_KINDS),
  amount: amountInput,
  docDate: z.string().trim().refine(isLocalDate, 'تاريخ غير صالح YYYY-MM-DD'),
  /** الشطب: BAD_DEBT ⇒ 711005 (الافتراضي)، ALLOWANCE ⇒ 113009 */
  counter: z.enum(WRITEOFF_COUNTERS).nullish(),
  /** الاسترداد: CASH (الافتراضي) | BANK_TRANSFER | CHEQUE */
  method: z.enum(REFUND_METHODS).nullish(),
  allocations: z.array(z.object({ invoiceId: idInput, amount: amountInput }).strict()).max(ALLOCATIONS_LIMIT).nullish(),
  autoAllocate: z.boolean().nullish(),
  reference: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(1000).nullish(),
}).strict();
export type CreateAdjustmentBody = z.infer<typeof createAdjustmentSchema>;

export const cancelAdjustmentSchema = z.object({ reason: z.string().trim().min(1, 'سبب الإلغاء مطلوب').max(500) }).strict();
export type CancelAdjustmentBody = z.infer<typeof cancelAdjustmentSchema>;

/** جسم الإلغاء: السبب الغائب أو الفارغ ⇒ 422 LEDGER_REVERSAL_REASON_REQUIRED (رمز العكس نفسه، G5)، وغيره من الشكل ⇒ ZodError */
export function cancelBodyOf(raw: unknown): CancelAdjustmentBody {
  const reason = (raw as { reason?: unknown } | null | undefined)?.reason;
  if (typeof reason !== 'string' || !reason.trim()) throw new LedgerError('LEDGER_REVERSAL_REASON_REQUIRED', { field: 'reason' });
  return cancelAdjustmentSchema.parse(raw);
}

/** مبلغ الطلب ⇐ ملّي بدقة الألف — منازل العملة تُفحص بعدها (PRECISION) لا تقريب صامت */
export function amountMilliOf(v: number | string, field: string): Milli {
  try {
    return toMilli(v, 3);
  } catch {
    throw new LedgerHttpError(400, 'مبلغ غير صالح', { reason: 'INVALID_AMOUNT', field });
  }
}

/** مضاعفٌ لأصغر وحدة في العملة؟ */
export const fitsCurrency = (m: Milli, decimals: number): boolean => m % unitMilli(decimals) === 0n;

/**
 * لحظة صفّ AccountEntry لتاريخ المستند: اليوم ⇒ الآن (ترتيب الكشف كبقية مستندات اليوم)، ويومٌ سابق ⇒ بداية يومه بتوقيت الشركة —
 * فالتاريخ المحلي للصفّ (وأثر حدثه) = تاريخ القيد دائماً.
 */
export function entryInstantOf(docDate: LocalDate, timezone: string, now: Date): Date {
  return docDate === todayLocal(now, timezone) ? now : zonedStartOfDay(docDate, timezone);
}

// ═══ التخصيص (صرف) ═══

/** فاتورة مقروءة تحت القفل */
export interface LockedInvoice {
  id: string;
  number: string;
  customerId: string;
  status: string;
  type: string;
  remainingAmt: number;
  einvoiceStatus: string | null;
  invoiceDate: Date;
}

export interface PlannedAllocation {
  id: string;
  invoiceId: string;
  amountMilli: Milli;
}

const isBlockedMirror = (s: string | null): boolean =>
  s !== null && (ALLOCATION_BLOCKED_MIRRORS as readonly string[]).includes(s);

/** متبقّي الفاتورة بالملّي مقرَّباً نصف-لأعلى لمنازل العملة (قاعدة كل مستند) */
export const remainingMilliOf = (inv: Pick<LockedInvoice, 'remainingAmt'>, decimals: number): Milli =>
  toMilli(Number(inv.remainingAmt ?? 0), decimals);

/** سبب عدم صلاحية فاتورة للشطب (null = صالحة) */
export function invoiceProblem(inv: LockedInvoice | undefined, customerId: string): AllocationInvalidReason | null {
  if (!inv) return 'INVOICE_NOT_FOUND';
  if (inv.customerId !== customerId) return 'OTHER_CUSTOMER';
  if (inv.status !== 'CONFIRMED') return 'NOT_CONFIRMED';
  if (inv.type !== 'CREDIT') return 'NOT_CREDIT';
  if (isBlockedMirror(inv.einvoiceStatus)) return 'ZATCA_PENDING';
  return null;
}

/**
 * تخصيصات الشطب: الصريحة (المكرّر بالفاتورة يُجمع) أو التلقائية بالأقدم فالأقدم (تاريخ الفاتورة ثم المعرّف). Σ = المبلغ حرفاً
 * بالملّي، وكل تخصيص ≤ متبقّي فاتورته (مقرَّباً لمنازل العملة). الفواتير مقروءة تحت القفل.
 */
export function planAllocations(input: {
  requested: readonly { invoiceId: string; amountMilli: Milli }[] | null;
  autoAllocate: boolean;
  amountMilli: Milli;
  decimals: number;
  customerId: string;
  invoices: readonly LockedInvoice[];
  newId?: () => string;
}): PlannedAllocation[] {
  const newId = input.newId ?? (() => crypto.randomUUID());
  const byId = new Map(input.invoices.map((i) => [i.id, i]));
  const out: PlannedAllocation[] = [];
  if (input.requested && input.requested.length > 0) {
    const merged = new Map<string, Milli>();
    for (const r of input.requested) {
      if (r.amountMilli <= 0n) throw allocationInvalid('AMOUNT_NOT_POSITIVE', { invoiceId: r.invoiceId });
      if (!fitsCurrency(r.amountMilli, input.decimals)) throw allocationInvalid('PRECISION', { invoiceId: r.invoiceId });
      merged.set(r.invoiceId, (merged.get(r.invoiceId) ?? 0n) + r.amountMilli);
    }
    let sum = 0n;
    for (const [invoiceId, amountMilli] of merged) {
      const inv = byId.get(invoiceId);
      const problem = invoiceProblem(inv, input.customerId);
      if (problem) throw allocationInvalid(problem, { invoiceId, ...(inv ? { invoiceNumber: inv.number } : {}) });
      const remaining = remainingMilliOf(inv!, input.decimals);
      if (amountMilli > remaining) {
        throw allocationInvalid('EXCEEDS_REMAINING', {
          invoiceId, invoiceNumber: inv!.number, amount: fromMilli(amountMilli), remaining: fromMilli(remaining),
        });
      }
      sum += amountMilli;
      out.push({ id: newId(), invoiceId, amountMilli });
    }
    if (sum !== input.amountMilli) {
      throw allocationInvalid('SUM_MISMATCH', { amount: fromMilli(input.amountMilli), allocated: fromMilli(sum) });
    }
    return out;
  }
  if (!input.autoAllocate) throw allocationInvalid('ALLOCATIONS_REQUIRED');
  const open = input.invoices
    .filter((i) => invoiceProblem(i, input.customerId) === null && remainingMilliOf(i, input.decimals) > 0n)
    .sort((a, b) => (a.invoiceDate.getTime() - b.invoiceDate.getTime()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let left = input.amountMilli;
  for (const inv of open) {
    if (left === 0n) break;
    const take = remainingMilliOf(inv, input.decimals) < left ? remainingMilliOf(inv, input.decimals) : left;
    out.push({ id: newId(), invoiceId: inv.id, amountMilli: take });
    left -= take;
  }
  if (left > 0n) {
    throw allocationInvalid('AUTO_INSUFFICIENT', { amount: fromMilli(input.amountMilli), open: fromMilli(input.amountMilli - left) });
  }
  return out;
}

export type AdjustmentTx = GlDb;

/** فواتير بمعرّفاتها مقفلةً (FOR UPDATE بترتيب المعرّف — ترتيب مسار السندات نفسه) — أيّاً كان عميلها، لتمييز سبب الرفض */
export async function lockInvoicesById(tx: AdjustmentTx, tenantId: string, ids: readonly string[]): Promise<LockedInvoice[]> {
  if (!ids.length) return [];
  return tx.$queryRaw<LockedInvoice[]>`
    SELECT id, number, "customerId", status, type, "remainingAmt", "einvoiceStatus", "invoiceDate"
    FROM invoices
    WHERE "tenantId" = ${tenantId} AND id = ANY(${[...ids]}::text[])
    ORDER BY id
    FOR UPDATE`;
}

/** فواتير العميل الآجلة المفتوحة القابلة للتخصيص (شرط ALLOCATION_ALLOWED_WHERE) مقفلةً بترتيب المعرّف — للتخصيص التلقائي */
export async function lockOpenInvoicesOfCustomer(tx: AdjustmentTx, tenantId: string, customerId: string): Promise<LockedInvoice[]> {
  return tx.$queryRaw<LockedInvoice[]>`
    SELECT id, number, "customerId", status, type, "remainingAmt", "einvoiceStatus", "invoiceDate"
    FROM invoices
    WHERE "tenantId" = ${tenantId} AND "customerId" = ${customerId} AND status = 'CONFIRMED' AND type = 'CREDIT'
      AND "remainingAmt" > ${OPEN_REMAINING_EPS}
      AND ("einvoiceStatus" IS NULL OR "einvoiceStatus" <> ALL(${[...ALLOCATION_BLOCKED_MIRRORS]}::text[]))
    ORDER BY id
    FOR UPDATE`;
}

// ═══ الكتابة (معاملة واحدة) ═══

/** نقاط الحقن للاختبار بمخزن مزيّف — الافتراضي الدوال الحقيقية */
export interface AdjustmentDeps {
  acquirePostLock(tx: AdjustmentTx, tenantId: string): Promise<void>;
  loadBuildContext(tx: AdjustmentTx, tenantId: string): Promise<LedgerContext>;
  lockCustomerRow(tx: AdjustmentTx, customerId: string): Promise<void>;
  currentBalance(tx: AdjustmentTx, customerId: string): Promise<number>;
  lockInvoicesById: typeof lockInvoicesById;
  lockOpenInvoicesOfCustomer: typeof lockOpenInvoicesOfCustomer;
  /** L8: قواعد المطابقة الجزئية نفسها التي يطبّقها المُرحِّل (reconcileAfterPost على مخزن المعاملة) */
  reconcile(tx: AdjustmentTx, tenantId: string, input: ReconcileEventInput): Promise<ReconcileOutcome>;
  postMove: typeof postMove;
  reverseMove: typeof reverseMove;
  appendAudit: typeof appendAudit;
  now(): Date;
  newId(): string;
}

export const DEFAULT_ADJUSTMENT_DEPS: AdjustmentDeps = {
  acquirePostLock,
  loadBuildContext,
  lockCustomerRow: (tx, customerId) => lockCustomerRow(tx as never, customerId),
  currentBalance: (tx, customerId) => currentBalance(tx as never, customerId),
  lockInvoicesById,
  lockOpenInvoicesOfCustomer,
  reconcile: (tx, tenantId, input) => reconcileAfterPost(createPrismaReconcileStore(tx, tenantId), input),
  postMove,
  reverseMove,
  appendAudit,
  now: () => new Date(),
  newId: () => crypto.randomUUID(),
};

/** عرض المستند (العقد §4.8) — أرقام بوحدة العملة، وتواريخ المستند محلية */
export interface CustomerAdjustmentView {
  id: string;
  customerId: string;
  customerName: string | null;
  kind: CustomerAdjustmentKind;
  amount: number;
  counterAccountCode: string;
  method: string | null;
  docDate: LocalDate;
  reference: string | null;
  note: string | null;
  status: string;
  moveId: string | null;
  moveNumber: string | null;
  reverseMoveId: string | null;
  reverseMoveNumber: string | null;
  allocations: { invoiceId: string; invoiceNumber: string | null; amount: number }[];
  createdBy: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
}

const AR_ENTRY_SELECT = { id: true, customerId: true, debit: true, credit: true, description: true, entryDate: true, createdAt: true } as const;

const WRITEOFF_DESCRIPTIONS = { BAD_DEBT: 'شطب دين معدوم', ALLOWANCE: 'شطب على مخصص الديون المشكوك فيها' } as const;
const REFUND_DESCRIPTION = 'ردّ رصيد دائن للعميل';
const CANCEL_PREFIX = 'إلغاء';

/**
 * إنشاء التسوية كاملةً داخل معاملة tx (العقد §4.8 الخطوات 1–9). أي خطأ يُسقط المعاملة كلها.
 */
export async function executeCreateAdjustment(
  tx: AdjustmentTx, req: { tenantId: string; actor: GlActor; body: CreateAdjustmentBody }, deps: AdjustmentDeps = DEFAULT_ADJUSTMENT_DEPS,
): Promise<CustomerAdjustmentView> {
  const { tenantId, actor, body } = req;
  // (1) قفل الترحيل أولاً: المتبقّي والرصيد يُقرآن تحته، والمُرحِّل لا يتداخل مع المستند
  await deps.acquirePostLock(tx, tenantId);
  const s = await requirePostingBooks(tx, tenantId);
  const dec = s.currencyDecimals;
  const tz = s.timezone;
  const now = deps.now();

  // التحقق قبل أي كتابة
  const kind = body.kind;
  const amountMilli = amountMilliOf(body.amount, 'amount');
  if (amountMilli <= 0n) throw adjustmentInvalid('AMOUNT_NOT_POSITIVE');
  if (!fitsCurrency(amountMilli, dec)) throw adjustmentInvalid('PRECISION', { field: 'amount', decimals: dec });
  const docDate = body.docDate.trim();
  const today = todayLocal(now, tz);
  if (compareLocalDate(docDate, today) > 0) throw adjustmentInvalid('DOC_DATE_IN_FUTURE', { docDate, today });
  const cutover = adjustmentCutover(s);
  if (cutover && compareLocalDate(docDate, cutover) < 0) {
    throw new LedgerHttpError(422, BEFORE_CUTOVER_MESSAGE, { reason: 'BEFORE_CUTOVER', docDate, linkedFrom: cutover }, 'LEDGER_ADJUSTMENT_BEFORE_CUTOVER');
  }
  const isWriteoff = kind === 'BAD_DEBT_WRITEOFF';
  if (!isWriteoff && body.allocations && body.allocations.length > 0) throw adjustmentInvalid('REFUND_WITH_ALLOCATIONS');

  const customer = await tx.customer.findFirst({ where: { id: body.customerId, tenantId }, select: { id: true, name: true } });
  if (!customer) throw new GlNotFoundError('Customer', body.customerId);

  const lc = await deps.loadBuildContext(tx, tenantId);
  if (!lc.settings) throw new LedgerError('LEDGER_NOT_SETUP', { reason: 'SETTINGS_MISSING' });
  const ctx = lc.ctx;
  const counter = body.counter ?? 'BAD_DEBT';
  const method: RefundMethod | null = isWriteoff ? null : (body.method ?? 'CASH');
  const counterAccount = isWriteoff ? writeoffCounterAccount(counter, ctx) : resolveAccountTarget(refundCreditTarget(method!, ctx), ctx);
  if (!counterAccount) throw adjustmentInvalid('COUNTER_ACCOUNT_MISSING', isWriteoff ? { counter } : { method });

  // (2) أقفال الفواتير ثم صفّ العميل (ترتيب السندات) والرصيد تحتها
  let allocations: PlannedAllocation[] = [];
  let invoices: LockedInvoice[] = [];
  if (isWriteoff) {
    const requested = (body.allocations ?? []).map((a) => ({ invoiceId: a.invoiceId.trim(), amountMilli: amountMilliOf(a.amount, 'allocations.amount') }));
    invoices = requested.length
      ? await deps.lockInvoicesById(tx, tenantId, [...new Set(requested.map((r) => r.invoiceId))])
      : body.autoAllocate === true ? await deps.lockOpenInvoicesOfCustomer(tx, tenantId, customer.id) : [];
    allocations = planAllocations({
      requested: requested.length ? requested : null, autoAllocate: body.autoAllocate === true, amountMilli, decimals: dec,
      customerId: customer.id, invoices, newId: deps.newId,
    });
  }
  await deps.lockCustomerRow(tx, customer.id);
  const prevBalance = await deps.currentBalance(tx, customer.id);
  const balanceMilli = toMilli(prevBalance, dec);
  if (isWriteoff && amountMilli > balanceMilli) {
    throw exceedsBalance('WRITEOFF_EXCEEDS_DEBIT_BALANCE', { amount: fromMilli(amountMilli), balance: fromMilli(balanceMilli) });
  }
  if (!isWriteoff && amountMilli > -balanceMilli) {
    throw exceedsBalance('REFUND_EXCEEDS_CREDIT_BALANCE', {
      amount: fromMilli(amountMilli), creditBalance: fromMilli(balanceMilli < 0n ? -balanceMilli : 0n),
    });
  }

  // (3) صفّ AccountEntry ورصيد العميل (Σمدين − Σدائن تحت القفل، لا increment)
  const amount = fromMilli(amountMilli);
  const newBalance = clean(prevBalance + (isWriteoff ? -amount : amount));
  const entry = await tx.accountEntry.create({
    data: {
      tenantId, customerId: customer.id,
      type: isWriteoff ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT',
      debit: isWriteoff ? 0 : amount, credit: isWriteoff ? amount : 0, balance: newBalance,
      description: isWriteoff ? WRITEOFF_DESCRIPTIONS[counter] : REFUND_DESCRIPTION,
      entryDate: entryInstantOf(docDate, tz, now),
    },
    select: AR_ENTRY_SELECT,
  });
  await tx.customer.update({ where: { id: customer.id }, data: { balance: newBalance } });

  // (5) متبقّي الفواتير (clean: لا غبار طفو يُبقي المسدَّدة مفتوحة)
  const invById = new Map(invoices.map((i) => [i.id, i]));
  for (const a of allocations) {
    const inv = invById.get(a.invoiceId)!;
    await tx.invoice.update({ where: { id: a.invoiceId }, data: { remainingAmt: clean(Number(inv.remainingAmt) - fromMilli(a.amountMilli)) } });
  }

  // (6) القيد
  const payload: CustomerAdjustmentPayload = {
    adjustmentId: entry.id, kind, customerId: customer.id, customerName: customer.name, amount: formatMilli(amountMilli, dec),
    counterAccountCode: counterAccount.code, method, docDate, reference: body.reference?.trim() || null,
  };
  const built = buildCustomerAdjustmentMove(payload, ctx);
  if (isNoMove(built)) throw adjustmentInvalid('AMOUNT_NOT_POSITIVE');
  const posted = await deps.postMove(tx, built, {
    tenantId, actor, context: lc, validationMode: 'SYSTEM', lockPolicy: 'REJECT',
    auditAction: 'MOVE_POST', auditSummary: `ترحيل قيد ${built.narration}`,
    auditExtra: { customerAdjustmentId: entry.id, adjustmentKind: kind },
  });

  // (4) المستند وتخصيصاته — بعد القيد ليُكتب moveId في الإدراج نفسه (والمعرّف = AccountEntry.id)
  const created = await tx.customerAdjustment.create({
    select: { createdAt: true },
    data: {
      id: entry.id, tenantId, customerId: customer.id, kind, amount, counterAccountCode: counterAccount.code, method,
      docDate: toDbDate(docDate), reference: payload.reference, note: body.note?.trim() || null, status: 'ACTIVE',
      moveId: posted.id, createdBy: actor.actorId,
      ...(allocations.length ? {
        allocations: {
          createMany: { data: allocations.map((a) => ({ id: a.id, tenantId, invoiceId: a.invoiceId, amount: fromMilli(a.amountMilli) })) },
        },
      } : {}),
    },
  });

  // (7) الحدث DONE بمفتاح الصفّ نفسه — المُطابِق إن قرأ الصفّ تخطّاه، والمُرحِّل لا يلتقط DONE. الحمولة arEntryPayload بأصل
  // CUSTOMER_ADJUSTMENT ومعها النوع والتخصيصات: الحدث يصف مطابقته بنفسه (قواعد L8 تقرأ الحمولة نفسها)
  const eventPayload = adjustmentEventPayload(entry, customer.name, dec, {
    adjustmentId: entry.id, kind,
    allocations: allocations.map((a) => ({ id: a.id, invoiceId: a.invoiceId, amount: formatMilli(a.amountMilli, dec) })),
  });
  await tx.glSourceEvent.create({
    data: {
      tenantId, sourceKey: customerAdjustmentKey(entry.id, 'POST'), sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: entry.id, event: 'POST',
      effectAt: entry.entryDate, payload: json(eventPayload), status: 'DONE', moveId: posted.id, processedAt: now,
    },
  });

  // (8) المطابقة الجزئية — المربوطة وحدها (L8، D1): الشطب CA:<allocId> بسطور الفاتورة الحيّة، والاسترداد FIFO بالأرصدة الدائنة
  const matched = ctx.settings.linkedPosting === true
    ? await deps.reconcile(tx, tenantId, {
      sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: entry.id, event: 'POST', moveId: posted.id, reversedMoveId: null,
      payload: eventPayload as CustomerAdjustmentReconcilePayload,
    })
    : null;

  // (9) التدقيق
  const invoiceNumber = new Map(invoices.map((i) => [i.id, i.number]));
  const view: CustomerAdjustmentView = {
    id: entry.id, customerId: customer.id, customerName: customer.name, kind, amount, counterAccountCode: counterAccount.code, method,
    docDate, reference: payload.reference ?? null, note: body.note?.trim() || null, status: 'ACTIVE', moveId: posted.id,
    moveNumber: posted.number, reverseMoveId: null, reverseMoveNumber: null,
    allocations: allocations.map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: invoiceNumber.get(a.invoiceId) ?? null, amount: fromMilli(a.amountMilli) })),
    createdBy: actor.actorId, createdAt: created.createdAt, cancelledAt: null, cancelReason: null,
  };
  await deps.appendAudit(tx, {
    tenantId, actor, action: 'CUSTOMER_ADJUSTMENT', entityType: 'CUSTOMER_ADJUSTMENT', entityId: entry.id,
    summary: `${isWriteoff ? WRITEOFF_DESCRIPTIONS[counter] : REFUND_DESCRIPTION} للعميل ${customer.name} بالقيد ${posted.number}`,
    after: {
      kind, customerId: customer.id, amountMilli, counterAccountCode: counterAccount.code, method, docDate, moveId: posted.id,
      moveNumber: posted.number, allocations: allocations.map((a) => ({ id: a.id, invoiceId: a.invoiceId, amountMilli: a.amountMilli })),
      partialsCreated: matched?.created ?? 0,
    },
  });
  return view;
}

/** حمولة حدث الصفّ: arEntryPayload (مصدر واحد مع المُطابِق) بأصل CUSTOMER_ADJUSTMENT، ومعها حقول المستند حين تُمرَّر */
export function adjustmentEventPayload(
  entry: { id: string; customerId: string; debit: number; credit: number; description: string; entryDate: Date; createdAt: Date },
  customerName: string | null, decimals: number,
  doc?: { adjustmentId: string; kind?: CustomerAdjustmentKind; allocations?: CustomerAdjustmentReconcilePayload['allocations'] },
): ArEntryEventPayload & Partial<CustomerAdjustmentReconcilePayload> {
  return {
    ...arEntryPayload(entry, customerName, decimals), origin: 'CUSTOMER_ADJUSTMENT',
    ...(doc ? { adjustmentId: doc.adjustmentId } : {}),
    ...(doc?.kind ? { kind: doc.kind } : {}),
    ...(doc?.allocations && doc.allocations.length ? { allocations: doc.allocations } : {}),
  };
}

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/**
 * إلغاء التسوية داخل معاملة tx (العقد §4.8: الصفّ العاكس، ردّ المتبقّي، عكس القيد، SKIPPED(NETTED)، فكّ المطابقة، CANCELLED).
 */
export async function executeCancelAdjustment(
  tx: AdjustmentTx, req: { tenantId: string; actor: GlActor; id: string; body: CancelAdjustmentBody }, deps: AdjustmentDeps = DEFAULT_ADJUSTMENT_DEPS,
): Promise<CustomerAdjustmentView> {
  const { tenantId, actor, id } = req;
  const reason = req.body.reason.trim();
  await deps.acquirePostLock(tx, tenantId);
  const s = await requirePostingBooks(tx, tenantId);
  const dec = s.currencyDecimals;
  const now = deps.now();

  const adj = await tx.customerAdjustment.findFirst({
    where: { id, tenantId },
    include: { allocations: { select: { id: true, invoiceId: true, amount: true } } },
  });
  if (!adj) throw new GlNotFoundError('CustomerAdjustment', id);
  // قفل الترحيل يسلسل إلغاءين متزامنين: الثاني يرى الحالة بعد التزام الأول
  if (adj.status !== 'ACTIVE') {
    throw new LedgerHttpError(409, ADJUSTMENT_CANCELLED_MESSAGE, { reason: 'ALREADY_CANCELLED', cancelledAt: adj.cancelledAt }, 'LEDGER_ADJUSTMENT_CANCELLED');
  }
  if (!adj.moveId) throw new LedgerError('LEDGER_SYNC_PENDING', { reason: 'ADJUSTMENT_WITHOUT_MOVE', adjustmentId: id });
  const isWriteoff = adj.kind === 'BAD_DEBT_WRITEOFF';
  const customer = await tx.customer.findFirst({ where: { id: adj.customerId, tenantId }, select: { id: true, name: true } });
  if (!customer) throw new GlNotFoundError('Customer', adj.customerId);

  // أقفال الفواتير (بترتيب المعرّف) ثم صفّ العميل
  const invoiceIds = [...new Set(adj.allocations.map((a) => a.invoiceId))];
  const invoices = await deps.lockInvoicesById(tx, tenantId, invoiceIds);
  await deps.lockCustomerRow(tx, customer.id);
  const prevBalance = await deps.currentBalance(tx, customer.id);

  // (1) الصفّ العاكس بلحظة الإلغاء
  const amount = Number(adj.amount);
  const newBalance = clean(prevBalance + (isWriteoff ? amount : -amount));
  const reverseEntry = await tx.accountEntry.create({
    data: {
      tenantId, customerId: customer.id,
      type: isWriteoff ? 'ADJUSTMENT_DEBIT' : 'ADJUSTMENT_CREDIT',
      debit: isWriteoff ? amount : 0, credit: isWriteoff ? 0 : amount, balance: newBalance,
      description: `${CANCEL_PREFIX} ${isWriteoff ? 'شطب ذمة' : REFUND_DESCRIPTION}`,
      entryDate: now,
    },
    select: AR_ENTRY_SELECT,
  });
  await tx.customer.update({ where: { id: customer.id }, data: { balance: newBalance } });

  // (2) ردّ المتبقّي بعينه — للفواتير المعتمدة وحدها (فاتورة أُلغيت بعد الشطب عكست ذمتها كاملةً بإلغائها)
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const restoreBy = new Map<string, number>();
  for (const a of adj.allocations) restoreBy.set(a.invoiceId, clean((restoreBy.get(a.invoiceId) ?? 0) + Number(a.amount)));
  for (const [invoiceId, add] of restoreBy) {
    const inv = invById.get(invoiceId);
    if (!inv || inv.status !== 'CONFIRMED') continue;
    await tx.invoice.update({ where: { id: invoiceId }, data: { remainingAmt: clean(Number(inv.remainingAmt) + add) } });
  }

  // (3) عكس القيد بمفتاح AR_ENTRY:<id>:REVERSE (SYSTEM: المستند مالك القيد، والتاريخ اليوم مُزاحاً عن الإقفال)
  const rev = await deps.reverseMove(tx, {
    tenantId, moveId: adj.moveId, actor, reason: `إلغاء تسوية ذمة العميل: ${reason}`, mode: 'SYSTEM',
    sourceKey: customerAdjustmentKey(id, 'REVERSE'), sourceEvent: 'REVERSE', auditAction: 'MOVE_REVERSE', now,
  });
  const reversalId = rev.reversal.id;

  // (3–4) حدث العكس DONE، وصفّ العكس التشغيلي SKIPPED(NETTED): العكس مرحّل بقيد REVERSE فلا يرحّله المُطابِق استيراداً
  // حمولة العكس = حمولة الأصل (اصطلاح الـtombstone: المفتاحان بالحمولة نفسها)؛ والصفّ الأصلي لا يُحذف في المربوطة، فغيابه دفاعٌ
  // يُبنى من المستند نفسه
  const originalEntry = await tx.accountEntry.findFirst({ where: { id, tenantId }, select: AR_ENTRY_SELECT });
  const originalPayload = adjustmentEventPayload(originalEntry ?? {
    id, customerId: customer.id, debit: isWriteoff ? 0 : amount, credit: isWriteoff ? amount : 0,
    description: isWriteoff ? 'شطب ذمة' : REFUND_DESCRIPTION, entryDate: adj.createdAt, createdAt: adj.createdAt,
  }, customer.name, dec, { adjustmentId: id, kind: adj.kind as CustomerAdjustmentKind });
  await tx.glSourceEvent.createMany({
    data: [
      {
        tenantId, sourceKey: customerAdjustmentKey(id, 'REVERSE'), sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: id, event: 'REVERSE',
        effectAt: reverseEntry.entryDate, payload: json(originalPayload), status: 'DONE', moveId: reversalId, processedAt: now,
      },
      {
        // بلا kind: صفٌّ تشغيلي صافٍ مع العكس، لا مستند يُطابَق
        tenantId, sourceKey: customerAdjustmentKey(reverseEntry.id, 'POST'), sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: reverseEntry.id,
        event: 'POST', effectAt: reverseEntry.entryDate, payload: json(adjustmentEventPayload(reverseEntry, customer.name, dec, { adjustmentId: id })),
        status: 'SKIPPED', skipReason: 'NETTED', processedAt: now,
      },
    ],
  });

  // (5) فكّ المطابقة: كل ما يمسّ سطور ذمة الأصل يُحذف فتتحرّر الأطراف المقابلة (الفاتورة تعود مفتوحة، أو الرصيد الدائن)، ثم
  // الأصل مقابل عكسه REV — المربوطة وحدها (isLinked(الإعدادات) شرط linkedPosting نفسه في لقطة السياق)
  if (isLinked(s) && !rev.alreadyReversed) {
    await deps.reconcile(tx, tenantId, {
      sourceType: 'CUSTOMER_ADJUSTMENT', sourceId: id, event: 'REVERSE', moveId: reversalId, reversedMoveId: adj.moveId,
      payload: originalPayload as CustomerAdjustmentReconcilePayload,
    });
  }

  // (6) الحالة
  await tx.customerAdjustment.update({
    where: { id },
    data: {
      status: 'CANCELLED', reverseMoveId: reversalId, reverseEntryId: reverseEntry.id, cancelledAt: now, cancelledBy: actor.actorId,
      cancelReason: reason,
    },
  });

  const moveNumbers = await tx.glMove.findMany({ where: { tenantId, id: { in: [adj.moveId, reversalId] } }, select: { id: true, number: true } });
  const numberOf = new Map(moveNumbers.map((m) => [m.id, m.number]));
  await deps.appendAudit(tx, {
    tenantId, actor, action: 'CUSTOMER_ADJUSTMENT', entityType: 'CUSTOMER_ADJUSTMENT', entityId: id,
    summary: `إلغاء ${isWriteoff ? 'شطب ذمة' : REFUND_DESCRIPTION} للعميل ${customer.name}: ${reason}`,
    before: { status: 'ACTIVE', moveId: adj.moveId },
    after: { status: 'CANCELLED', reverseMoveId: reversalId, reverseEntryId: reverseEntry.id, cancelReason: reason },
  });
  return {
    id, customerId: customer.id, customerName: customer.name, kind: adj.kind as CustomerAdjustmentKind, amount,
    counterAccountCode: adj.counterAccountCode, method: adj.method, docDate: fromDbDate(adj.docDate), reference: adj.reference,
    note: adj.note, status: 'CANCELLED', moveId: adj.moveId, moveNumber: numberOf.get(adj.moveId) ?? null, reverseMoveId: reversalId,
    reverseMoveNumber: rev.reversal.number ?? numberOf.get(reversalId) ?? null,
    allocations: adj.allocations.map((a) => ({
      invoiceId: a.invoiceId, invoiceNumber: invById.get(a.invoiceId)?.number ?? null, amount: Number(a.amount),
    })),
    createdBy: adj.createdBy, createdAt: adj.createdAt, cancelledAt: now, cancelReason: reason,
  };
}

// ═══ القراءة: العرض ═══

type AdjustmentRow = Prisma.CustomerAdjustmentGetPayload<{ include: { allocations: { select: { invoiceId: true; amount: true } } } }>;

/** صفوف ⇐ عروض بثلاث قراءات مجمّعة (العملاء والفواتير والقيود) — لا قراءة لكل صفّ */
export async function adjustmentViews(
  db: Pick<GlDb, 'customer' | 'invoice' | 'glMove'>, tenantId: string, rows: readonly AdjustmentRow[],
): Promise<CustomerAdjustmentView[]> {
  if (!rows.length) return [];
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const invoiceIds = [...new Set(rows.flatMap((r) => r.allocations.map((a) => a.invoiceId)))];
  const moveIds = [...new Set(rows.flatMap((r) => [r.moveId, r.reverseMoveId]).filter((m): m is string => !!m))];
  const [customers, invoices, moves] = await Promise.all([
    db.customer.findMany({ where: { tenantId, id: { in: customerIds } }, select: { id: true, name: true } }),
    invoiceIds.length ? db.invoice.findMany({ where: { tenantId, id: { in: invoiceIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
    moveIds.length ? db.glMove.findMany({ where: { tenantId, id: { in: moveIds } }, select: { id: true, number: true } }) : Promise.resolve([]),
  ]);
  const nameOf = new Map(customers.map((c) => [c.id, c.name]));
  const numberOfInvoice = new Map(invoices.map((i) => [i.id, i.number]));
  const numberOfMove = new Map(moves.map((m) => [m.id, m.number]));
  return rows.map((r) => ({
    id: r.id, customerId: r.customerId, customerName: nameOf.get(r.customerId) ?? null, kind: r.kind as CustomerAdjustmentKind,
    amount: Number(r.amount), counterAccountCode: r.counterAccountCode, method: r.method, docDate: fromDbDate(r.docDate),
    reference: r.reference, note: r.note, status: r.status, moveId: r.moveId, moveNumber: r.moveId ? numberOfMove.get(r.moveId) ?? null : null,
    reverseMoveId: r.reverseMoveId, reverseMoveNumber: r.reverseMoveId ? numberOfMove.get(r.reverseMoveId) ?? null : null,
    allocations: r.allocations.map((a) => ({ invoiceId: a.invoiceId, invoiceNumber: numberOfInvoice.get(a.invoiceId) ?? null, amount: Number(a.amount) })),
    createdBy: r.createdBy, createdAt: r.createdAt, cancelledAt: r.cancelledAt, cancelReason: r.cancelReason,
  }));
}

type Q = Record<string, unknown>;
const str = (v: unknown): string | undefined => {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t ? t.slice(0, 200) : undefined;
};

/** فلاتر القائمة (صرفة): العميل والحالة ونطاق تاريخ المستند (محلي شامل الطرفين) والصفحة (من 1) */
export function listWhereOf(tenantId: string, q: Q): { where: Prisma.CustomerAdjustmentWhereInput; skip: number; take: number; page: number } {
  const where: Prisma.CustomerAdjustmentWhereInput = { tenantId };
  const customerId = str(q.customerId);
  if (customerId) where.customerId = customerId;
  const status = str(q.status);
  if (status) {
    if (!(CUSTOMER_ADJUSTMENT_STATUSES as readonly string[]).includes(status)) {
      throw new LedgerHttpError(400, 'حالة غير معروفة', { reason: 'INVALID_STATUS', allowed: CUSTOMER_ADJUSTMENT_STATUSES });
    }
    where.status = status;
  }
  const kind = str(q.kind);
  if (kind && (CUSTOMER_ADJUSTMENT_KINDS as readonly string[]).includes(kind)) where.kind = kind;
  const range: Prisma.DateTimeFilter = {};
  for (const [f, op] of [['from', 'gte'], ['to', 'lte']] as const) {
    const v = str(q[f]);
    if (!v) continue;
    if (!isLocalDate(v)) throw new LedgerHttpError(400, 'تاريخ غير صالح', { reason: 'INVALID_DATE', field: f });
    range[op] = toDbDate(v);
  }
  if (range.gte || range.lte) where.docDate = range;
  const pageN = Number(str(q.page));
  const limitN = Number(str(q.limit));
  const take = Number.isFinite(limitN) && limitN > 0 ? Math.min(Math.floor(limitN), 200) : 50;
  const page = Number.isFinite(pageN) && pageN >= 1 ? Math.min(Math.floor(pageN), 100_000) : 1;
  return { where, skip: (page - 1) * take, take, page };
}

const ADJ_INCLUDE = { allocations: { select: { invoiceId: true, amount: true } } } as const;

// ═══ المسارات ═══

router.get('/customer-adjustments', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  await requirePostingBooks(prisma, tenantId);
  const { where, skip, take, page } = listWhereOf(tenantId, req.query as Q);
  const [rows, total] = await Promise.all([
    prisma.customerAdjustment.findMany({
      where, include: ADJ_INCLUDE, orderBy: [{ docDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }], skip, take,
    }),
    prisma.customerAdjustment.count({ where }),
  ]);
  res.json({ success: true, data: { items: await adjustmentViews(prisma, tenantId, rows), total, page, limit: take } });
}));

router.get('/customer-adjustments/open-items', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const s = await requirePostingBooks(prisma, tenantId);
  const customerId = str((req.query as Q).customerId);
  if (!customerId) throw new LedgerHttpError(400, 'العميل مطلوب', { reason: 'CUSTOMER_REQUIRED', field: 'customerId' });
  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId }, select: { id: true, name: true } });
  if (!customer) throw new GlNotFoundError('Customer', customerId);
  const dec = s.currencyDecimals;
  const [rows, balance] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        tenantId, customerId, status: 'CONFIRMED', type: 'CREDIT', remainingAmt: { gt: OPEN_REMAINING_EPS }, ...ALLOCATION_ALLOWED_WHERE,
      },
      orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], take: OPEN_ITEMS_LIMIT + 1,
      select: { id: true, number: true, invoiceDate: true, dueDate: true, total: true, remainingAmt: true },
    }),
    currentBalance(prisma as never, customerId),
  ]);
  // المبالغ مقرَّبة لكل مستند نصف-لأعلى بمنازل العملة (ما يقبله التخصيص بالضبط)
  const r = (v: number) => fromMilli(toMilli(Number(v ?? 0), dec));
  const balanceMilli = toMilli(balance, dec);
  res.json({
    success: true,
    data: {
      customerId, customerName: customer.name, currencyDecimals: dec,
      invoices: rows.slice(0, OPEN_ITEMS_LIMIT).map((i) => ({
        invoiceId: i.id, number: i.number, invoiceDate: localDate(i.invoiceDate, s.timezone),
        dueDate: i.dueDate ? localDate(i.dueDate, s.timezone) : null, total: r(i.total), remaining: r(i.remainingAmt),
      })),
      truncated: rows.length > OPEN_ITEMS_LIMIT,
      balance: fromMilli(balanceMilli),
      debitBalance: fromMilli(balanceMilli > 0n ? balanceMilli : 0n),
      creditBalance: fromMilli(balanceMilli < 0n ? -balanceMilli : 0n),
      linkedFrom: adjustmentCutover(s),
    },
  });
}));

router.get('/customer-adjustments/:id', VIEW, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  await requirePostingBooks(prisma, tenantId);
  const row = await prisma.customerAdjustment.findFirst({ where: { id: req.params.id, tenantId }, include: ADJ_INCLUDE });
  if (!row) throw new GlNotFoundError('CustomerAdjustment', req.params.id);
  const [view] = await adjustmentViews(prisma, tenantId, [row]);
  res.json({ success: true, data: view });
}));

router.post('/customer-adjustments', POST, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const body = createAdjustmentSchema.parse(req.body ?? {});
  const actor = actorOf(req, res);
  const data = await prisma.$transaction((tx) => executeCreateAdjustment(tx, { tenantId, actor, body }), POST_TX_OPTIONS);
  res.status(201).json({ success: true, data });
}));

router.post('/customer-adjustments/:id/cancel', POST, ledgerHandler(async (req, res) => {
  const { tenantId } = locals(res);
  const body = cancelBodyOf(req.body);
  const actor = actorOf(req, res);
  const data = await prisma.$transaction(
    (tx) => executeCancelAdjustment(tx, { tenantId, actor, id: req.params.id, body }), POST_TX_OPTIONS,
  );
  res.json({ success: true, data });
}));

export default router;
