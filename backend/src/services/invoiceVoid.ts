// ============================================================================
// ZATCA المرحلة الثانية (Z5.4) — إبطال الفاتورة (رفض الهيئة أو سحبها قبل وصولها) وعكس قيودها، وسحبٌ إداريّ محروس
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.4» + نقد الخطة (7، 11، 13، 36) وقرار المالك Q1:
//   • `reverseInvoiceInTx` هي **فرع العكس نفسه** الذي يستدعيه إلغاءُ الفاتورة القديم (routes/invoices.ts) حرفاً بحرف في
//     الوضع 'CANCEL' — نسخةٌ واحدة من المنطق، ومسار الإلغاء للمرحلة الأولى لا يتغيّر سلوكه ولا ترتيب ندائه.
//   • الوضع 'ZATCA_VOID' يختلف في النقدية وحدها (Q1): يُعكس شقّ الفاتورة ويبقى المحصَّل رصيداً دائناً للعميل يُسدَّد به
//     البديل — لا يُعكس تحصيل المندوب أبداً.
//   • `voidInvoiceInTx` يُستدعى **داخل معاملة كتابة نتيجة الإرسال** (خطّاف onRejectedInTx): ترتيب القفل
//     zatca_documents ⇒ invoices (FOR UPDATE) ⇒ customers، فلا انهيار يترك فاتورةً مرفوضةً غير مُبطلة (نقد 7).
//   • السحب (نقد 11) لا يمرّ إلا بدليل: لا محاولة قد تكون وصلت الهيئة، والمستند ليس نهائياً ولا قيد الإرسال — ثم
//     يُحسم المستند WITHDRAWN وتُبطل الفاتورة في المعاملة نفسها.
//   • ما بعد الالتزام (روابط الدفع والبثّ) خارج المعاملة دائماً — لا نداء شبكيّ تحت قفل.
// لا يستورد services/gl (حارس tests/gl-hooks-static.test.ts).
// ============================================================================

import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import {
  VOID_NOTIFICATION_TYPES, WITHDRAWABLE_DOCUMENT_STATUSES, WITHDRAW_REFUSAL_MESSAGES, voidDecision, voidNotificationText,
  withdrawDecision, type VoidableInvoiceRow, type VoidRefusal, type VoidReason, type VoidReversalKind,
  type WithdrawDecision, type WithdrawRefusal,
} from '../compliance/zatca/void';
import type { Subtype } from '../compliance/zatca/status';
import { prismaZatcaDocumentStore, type DocumentStoreTx } from '../compliance/zatca/documentStore.prisma';
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';
import { clean, currentBalance, lockCustomerRow, reverseInvoiceEntries, reverseCashInvoiceEntries, reverseReturnEntries } from './accounting';
import { publishInvoicesChanged } from './liveEvents';

/** مقبض المعاملة الذي يحتاجه الإبطال (Prisma.TransactionClient الحقيقي يحقّقه كلّه). */
export type VoidTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'invoice' | 'notification' | 'customer' | 'accountEntry'>;

/** ما تكتبه صفوف الدفتر (نفس توقيع services/accounting). */
type LedgerTx = Parameters<typeof reverseInvoiceEntries>[0];

export type ReverseMode = 'CANCEL' | 'ZATCA_VOID';

/** صفّ الفاتورة كما يقرؤه العكس (مطابق لما يعيده tx.invoice.update في مسار الإلغاء). */
export interface ReversibleInvoice {
  id: string;
  tenantId: string;
  type: string;
  customerId: string;
  total: number;
}

/**
 * Q1: إبطال فاتورة نقدية رفضتها الهيئة — يُعكس شقّ الفاتورة وحده. `totalCollected` لا يُمسّ: المندوب حصّل فعلاً،
 * والمبلغ يبقى رصيداً دائناً للعميل يُسدَّد به البديل.
 */
async function reverseCashInvoiceKeepingCollection(
  tx: LedgerTx, tenantId: string, invoiceId: string, customerId: string, total: number,
): Promise<void> {
  await lockCustomerRow(tx, customerId);
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance - total);
  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_CREDIT',
      debit: 0, credit: clean(total), balance: newBalance,
      // وسمُ الجزئية: المُطابِق يشتقّ منه keepCashLeg (lib/ledgerNotes.ts) — لا تُغيَّر هذه القيمة هنا وحدها
      description: CASH_VOID_KEEP_COLLECTION_NOTE,
    },
  });
  await tx.customer.update({
    where: { id: customerId },
    data: { balance: newBalance, totalSales: { decrement: clean(total) } },
  });
}

/**
 * عكس قيود فاتورة أُلغيت. الوضع 'CANCEL' = سلوك مسار الإلغاء القديم حرفاً بحرف (مرتجع ⇒ عكس المرتجع، نقدية ⇒ عكس
 * النقدية بشقّيها، وإلا عكس الآجلة). الوضع 'ZATCA_VOID' يغيّر النقدية وحدها (Q1).
 */
export async function reverseInvoiceInTx(tx: LedgerTx, inv: ReversibleInvoice, mode: ReverseMode = 'CANCEL'): Promise<void> {
  const tenantId = inv.tenantId;
  const total = Number(inv.total);
  if (inv.type === 'RETURN') {
    await reverseReturnEntries(tx, tenantId, inv.id, inv.customerId, total);
    return;
  }
  if (inv.type === 'CASH') {
    if (mode === 'ZATCA_VOID') {
      await reverseCashInvoiceKeepingCollection(tx, tenantId, inv.id, inv.customerId, total);
      return;
    }
    await reverseCashInvoiceEntries(tx, tenantId, inv.id, inv.customerId, total);
    return;
  }
  await reverseInvoiceEntries(tx, tenantId, inv.id, inv.customerId, total);
}

// ─── الإبطال داخل معاملة النتيجة ───

interface LockedInvoiceRow extends VoidableInvoiceRow {
  number: string;
  /** Z5.5: إشعارٌ دائن مُبطل يردّ ما أسقطه من متبقّي أصله (F1). */
  documentKind?: string | null;
  originalInvoiceId?: string | null;
}

/** يقفل صفّ الفاتورة (FOR UPDATE) ويقرأ ما يلزم القرار. المعاملات المزيّفة بلا $queryRaw تقرأ بلا قفل. */
async function lockInvoice(tx: VoidTx, invoiceId: string): Promise<LockedInvoiceRow | null> {
  const raw = (tx as { $queryRaw?: unknown }).$queryRaw;
  const r = typeof raw === 'function'
    ? (await tx.$queryRaw<LockedInvoiceRow[]>`
        SELECT id, "tenantId", number, status, type, "zatcaPhase", "invoiceSubtype", "einvoiceStatus", "customerId", total,
               "documentKind", "originalInvoiceId"
        FROM invoices WHERE id = ${invoiceId} FOR UPDATE`)[0] ?? null
    : (await tx.invoice.findUnique({ where: { id: invoiceId } })) as unknown as LockedInvoiceRow | null;
  return r ? { ...r, total: Number(r.total) } : null;
}

/**
 * Z5.5 (F1 ونقد 13): إشعارٌ دائن أُبطل (رفضته الهيئة أو سُحب) يردّ إلى أصله ما أسقطه من متبقّيه — **زيادةً نسبية**
 * مسقوفةً بما على الفاتورة فعلاً (`total - paidAmt`)، فلا يدهس سندَ قبضٍ التُزم بينهما ولا يرفع المتبقّي فوق الدَّين.
 * والنقدية متبقّيها صفر أصلاً فلا يردّ إليها شيء (ما حُصّل بقي رصيداً دائناً — Q1).
 */
async function restoreOriginalRemaining(tx: VoidTx, tenantId: string, originalInvoiceId: string, noteTotal: number): Promise<void> {
  const amount = Math.round(Math.max(0, Number(noteTotal) || 0) * 100) / 100;
  if (amount <= 0) return;
  const raw = (tx as { $executeRaw?: unknown }).$executeRaw;
  if (typeof raw === 'function') {
    await tx.$executeRaw`
      UPDATE invoices
         SET "remainingAmt" = LEAST("total" - "paidAmt", "remainingAmt" + ${amount}), "updatedAt" = NOW()
       WHERE id = ${originalInvoiceId} AND "tenantId" = ${tenantId}`;
    return;
  }
  // معاملة مزيّفة (اختبار) بلا SQL: القراءة ثم الكتابة بالسقف نفسه
  const row = await tx.invoice.findUnique({ where: { id: originalInvoiceId } }) as { total?: number; paidAmt?: number; remainingAmt?: number } | null;
  if (!row) return;
  const owed = Math.max(0, Number(row.total ?? 0) - Number(row.paidAmt ?? 0));
  const next = Math.min(owed, Number(row.remainingAmt ?? 0) + amount);
  await tx.invoice.update({ where: { id: originalInvoiceId }, data: { remainingAmt: Math.round(next * 100) / 100 } });
}

export interface VoidInvoiceInput {
  tenantId: string;
  invoiceId: string;
  subtype: Subtype;
  reason: VoidReason;
  documentId: string | null;
  /** رسائل الهيئة (للإشعار) — نصوص منقّحة فقط. */
  errors?: readonly { code: string | null; message: string | null }[];
  at: Date;
  /** يُكتب على الفاتورة حين لم تكتبه مرآةُ المستند قبل الخطّاف (السحب). */
  mirror?: string;
}

export interface VoidOutcome {
  voided: boolean;
  refusal: VoidRefusal | null;
  number: string | null;
  reversal: VoidReversalKind | null;
}

/**
 * إبطال فاتورة قياسية داخل معاملة قائمة: قفل صفّها ⇒ قرار ⇒ CANCELLED (ومرآة السحب) ⇒ عكس القيود ⇒ إشعار الإدارة.
 * لا يرمي على الرفض (يعيد سببه): المستند مرفوض عند الهيئة على كلّ حال، ونتيجته لا تُلغى لأجل صفّ فاتورة غير متوقَّع.
 */
export async function voidInvoiceInTx(tx: VoidTx, input: VoidInvoiceInput): Promise<VoidOutcome> {
  const row = await lockInvoice(tx, input.invoiceId);
  const decision = voidDecision(row, { tenantId: input.tenantId, subtype: input.subtype });
  if (!decision.ok) return { voided: false, refusal: decision.refusal, number: row?.number ?? null, reversal: null };
  const inv = row as LockedInvoiceRow;

  await tx.invoice.update({
    where: { id: inv.id },
    data: { status: 'CANCELLED', ...(input.mirror !== undefined ? { einvoiceStatus: input.mirror } : {}) },
  });
  /* Z5.5: إشعارٌ دائن سقط ⇒ متبقّي أصله يعود كما كان (وإلّا سقط الدَّين بإشعارٍ لم تقبله الهيئة أصلاً).
   * وموضعه **قبل** عكس القيود عمداً (مراجعة «تراجع/امتثال»): ترتيب الأقفال في المنصّة كلّها invoices ⇒ customers
   * (سند القبض، رابط الدفع، الإلغاء اليدويّ، ومعاملة إصدار الإشعار نفسها)، وعكسُ القيود يقفل صفّ العميل أوّلاً —
   * فلو تأخّر ردُّ المتبقّي عنه لانقلب الترتيب على الصفّين نفسيهما وتشابكت الأقفال (40P01) مع إشعارٍ يُصدَر على
   * الأصل في اللحظة نفسها، فتُجهض معاملةُ كتابة نتيجة الهيئة. والأثر الحسابيّ واحد: المعاملة واحدة. */
  if (inv.documentKind === 'CREDIT_NOTE' && typeof inv.originalInvoiceId === 'string' && inv.originalInvoiceId !== '') {
    await restoreOriginalRemaining(tx, input.tenantId, inv.originalInvoiceId, inv.total);
  }
  /* الوضع من سبب الإبطال (مراجعة عدائية): Q1 قرارُ **رفض الهيئة** وحده (البضاعة سُلّمت والمال حُصّل والبديل قادم)،
   * أمّا السحب الإداريّ فمخرجُ فاتورةٍ لم تصل الهيئة أصلاً — غالبها رفضُ العميل للبضاعة وردُّ النقد له، فيُعكس
   * التحصيل كاملاً كما يفعل الإلغاء اليدويّ اليوم. وإلّا بقيت في الدفاتر مديونيةٌ وهمية لعميلٍ استردّ ماله. */
  const mode: ReverseMode = input.reason === 'WITHDRAWN' ? 'CANCEL' : 'ZATCA_VOID';
  await reverseInvoiceInTx(tx as unknown as LedgerTx, inv, mode);

  const text = voidNotificationText(input.reason, inv.number, {
    reversal: mode === 'ZATCA_VOID' ? decision.reversal : null, total: inv.total, documentKind: inv.documentKind ?? null,
  });
  await tx.notification.create({
    data: {
      tenantId: input.tenantId,
      type: VOID_NOTIFICATION_TYPES[input.reason],
      title: text.title,
      body: text.body,
      customerId: inv.customerId,
      data: JSON.stringify({
        invoiceId: inv.id, documentId: input.documentId, number: inv.number, reason: input.reason,
        errors: (input.errors ?? []).slice(0, 6).map(e => ({ code: e.code, message: e.message })),
      }),
    },
  });
  return { voided: true, refusal: null, number: inv.number, reversal: decision.reversal };
}

// ─── ما بعد الالتزام ───

/** روابط الدفع تموت والفواتير تُبثّ — خارج المعاملة دائماً وbest-effort (فشلها لا يُبطل إبطالاً التُزم). */
export function afterVoidCommit(tenantId: string, invoiceId: string): void {
  void import('./paylink')
    .then(m => m.expireStaleLinks(tenantId, invoiceId))
    .catch(e => console.error('[zatca:void] expire links failed:', (e as Error).message));
  publishInvoicesChanged(tenantId);
}

// ─── السحب الإداريّ (نقد 11) ───

const refuseWithdraw = (refusal: WithdrawRefusal): WithdrawDecision =>
  ({ ok: false, refusal, messageAr: WITHDRAW_REFUSAL_MESSAGES[refusal] });

export interface WithdrawResult {
  ok: boolean;
  decision: WithdrawDecision;
  outcome: VoidOutcome | null;
}

const INVOICE_WITHDRAW_SELECT = {
  id: true, tenantId: true, number: true, status: true, zatcaPhase: true, invoiceSubtype: true, einvoiceStatus: true,
} satisfies Prisma.InvoiceSelect;

/**
 * يسحب فاتورة قياسية عالقة «بانتظار الاعتماد» متى ثبت أنّ الهيئة لم تستلمها: يحسم المستند WITHDRAWN ويُبطل الفاتورة
 * في معاملة واحدة. يعيد القرار للمستدعي (المسار يحوّله إلى 409 برسالته العربية).
 */
export async function withdrawPhase2Invoice(input: { tenantId: string; invoiceId: string; now?: Date }): Promise<WithdrawResult> {
  const now = input.now ?? new Date();
  const documents = prismaZatcaDocumentStore(prisma);
  const invoice = await prisma.invoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.tenantId },
    select: INVOICE_WITHDRAW_SELECT,
  });
  if (!invoice) return { ok: false, decision: refuseWithdraw('NOT_PHASE2'), outcome: null };
  const projection = await documents.loadProjection(input.tenantId, input.invoiceId);
  const delivered = projection ? await documents.countPossiblyDeliveredAttempts(projection.id) : 0;
  // كل محاولة **غادرت** خلّفت سجلّاً؟ الفارق عن sentAttempts هو المحاولات المجهولة المصير (موت العملية بعد الإرسال)
  const logged = projection ? await documents.countAttemptLogs(projection.id) : 0;
  const decision = withdrawDecision({
    invoice,
    document: projection
      ? {
        status: projection.status, flow: projection.flow, sentAttempts: projection.sentAttempts,
        firstSubmitAt: projection.firstSubmitAt, leaseUntil: projection.leaseUntil,
      }
      : null,
    possiblyDeliveredAttempts: delivered,
    loggedAttempts: logged,
    now,
  });
  if (!decision.ok) return { ok: false, decision, outcome: null };
  const documentId = (projection as { id: string }).id;
  const fencedAttempts = (projection as { attempts: number }).attempts;

  const outcome = await prisma.$transaction(async tx => {
    // ترتيب القفل: المستند أولاً (شرط العقد + تسييج attempts يمنعان سحبه من تحت عاملٍ يرسله) ثم الفاتورة ثم العميل
    const moved = await documents.casDocumentStatus(tx as unknown as DocumentStoreTx, {
      id: documentId, fromStatuses: WITHDRAWABLE_DOCUMENT_STATUSES, toStatus: 'WITHDRAWN', at: now, attempts: fencedAttempts,
    });
    if (!moved) return null;
    return voidInvoiceInTx(tx as unknown as VoidTx, {
      tenantId: input.tenantId, invoiceId: input.invoiceId, subtype: '01', reason: 'WITHDRAWN',
      documentId, at: now, mirror: 'withdrawn',
    });
  });

  // لم يُحسم المستند: عاملٌ استولى عليه بين القرار والمعاملة (عقد حيّ) — لا سحب الآن
  if (!outcome) return { ok: false, decision: refuseWithdraw('IN_FLIGHT'), outcome: null };
  // حُسم المستند ولم تُبطل الفاتورة: تغيّر صفّها بين القراءة والقفل — سببٌ مفهوم للمستخدم لا نجاحٌ كاذب
  if (!outcome.voided) return { ok: false, decision: refuseWithdraw('STATE_CHANGED'), outcome };
  afterVoidCommit(input.tenantId, input.invoiceId);
  return { ok: true, decision, outcome };
}
