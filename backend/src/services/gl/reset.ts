/**
 * إعادة ضبط الدفاتر (M3، DESIGN.md §5.7، §9.5 G6 (هـ)، §10.3 D8).
 *
 * - GL_RESET_ORDER: كل نماذج gl الحالية بالترتيب الصريح (الأبناء قبل الآباء). العلاقات الداخلية NoAction تُفحص في
 *   نهاية كل عبارة، فالترتيب الخاطئ يفشل بـP2003. GlMove بعبارة واحدة (المرجع الذاتي reversedMoveId).
 *   كل نموذج جديد يُضاف هنا مع مرحلته (M4+ …)، وحارس gl-reset-order يفشل إن نُسي.
 * - GL_RESET_KEEP = ['GlAuditLog'] حرفياً (G5 وG6): لا يُحذف، وتستمر سلسلته ويُكتب فيه LEDGER_RESET.
 * - المعاملة (مسار POST /api/tenants/:id/ledger-reset): **أول عبارة** acquirePostLock (pg_advisory_xact_lock(hashtext('gl-post:'||tid)))،
 *   ثم ledgerResetBlockReasons ⇒ 409 LEDGER_RESET_BLOCKED {reasons}، ثم deleteLedgerRows بالترتيب، ثم تدقيق LEDGER_RESET.
 */
import type { LocalDate } from './types';

export const GL_RESET_ORDER = [
  // القيود وتوابعها
  'GlMoveSource',
  'GlMoveNote',
  'GlMoveLine', // → GlAccount (NoAction)
  'GlPartialReconcile',
  'GlMove', // عبارة واحدة: reversedMoveId ذاتي؛ → GlJournal (NoAction)
  'GlSequence', // → GlJournal
  // M6 (عند وصول نماذجها): GlPaymentAllocation، GlVendorBillLine، GlPaymentBatchLine، ثم GlVendorBill، GlPaymentBatch، ثم GlPayment، GlExpense
  'GlVendor',
  // ما يشير إلى الحسابات
  'GlAccountMapping', // → GlAccount (NoAction)
  'GlAccountTagLink', // → GlAccount، GlAccountTag
  'GlAccountTag',
  'GlProductCategoryAccount',
  'GlRepAnalyticDefault',
  'GlAccount',
  'GlJournal',
  'GlTax',
  'GlFiscalYear',
  // المرفقات والفلاتر
  'GlAttachmentBlob', // → GlAttachment
  'GlAttachment',
  'GlSavedFilter',
  // المزامنة والأرصدة
  'GlSourceEvent',
  'GlSyncCursor',
  'GlPeriodBalance',
  // أخيراً
  'GlSettings',
] as const;

export type GlResetModel = (typeof GL_RESET_ORDER)[number];

export const GL_RESET_KEEP = ['GlAuditLog'] as const;

/** اسم مفوَّض Prisma للنموذج: GlMoveSource ⇒ glMoveSource */
export function resetDelegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** مفوَّض deleteMany بأدنى شكل (يطابق Prisma.TransactionClient والمخزن المزيّف) */
export interface ResetDelegate {
  deleteMany(args: { where: { tenantId: string } }): Promise<{ count: number }>;
}
export type ResetTx = { [K in GlResetModel as Uncapitalize<K>]: ResetDelegate };

/**
 * يحذف صفوف gl للشركة بالترتيب — داخل معاملة بدأت بقفل gl-post (المُستدعي يأخذه أولاً).
 * يعيد العدد لكل نموذج (لتدقيق LEDGER_RESET). لا يمسّ GlAuditLog.
 */
export async function deleteLedgerRows(tx: ResetTx, tenantId: string): Promise<Record<GlResetModel, number>> {
  const counts = {} as Record<GlResetModel, number>;
  for (const model of GL_RESET_ORDER) {
    const delegate = (tx as unknown as Record<string, ResetDelegate>)[resetDelegateName(model)];
    const r = await delegate.deleteMany({ where: { tenantId } });
    counts[model] = r.count;
  }
  return counts;
}

// ═══ شروط السماح (§5.7) ═══

export const LEDGER_RESET_BLOCK_REASONS = ['POSTED_MOVES', 'FILED_RETURN', 'SECURED_MOVES', 'HARD_LOCK', 'CUSTOMER_ADJUSTMENTS'] as const;
export type LedgerResetBlockReason = (typeof LEDGER_RESET_BLOCK_REASONS)[number];

export interface LedgerResetFacts {
  /** glMove.count({tenantId, state:'POSTED'}) */
  postedMoves: number;
  /** إقرارات FILED (M5؛ 0 قبلها) */
  filedReturns: number;
  /** قيود مؤمَّنة secureHash/secureSeq (M12؛ 0 قبلها) */
  securedMoves: number;
  hardLockDate: LocalDate | Date | null;
  /** GlMoveSource بـsourceType='CUSTOMER_ADJUSTMENT' (M4؛ 0 قبلها) */
  customerAdjustmentSources: number;
}

/** [] ⇒ مسموح؛ وإلا 409 LEDGER_RESET_BLOCKED {reasons} بالترتيب الثابت أعلاه */
export function ledgerResetBlockReasons(f: LedgerResetFacts): LedgerResetBlockReason[] {
  const out: LedgerResetBlockReason[] = [];
  if (f.postedMoves > 0) out.push('POSTED_MOVES');
  if (f.filedReturns > 0) out.push('FILED_RETURN');
  if (f.securedMoves > 0) out.push('SECURED_MOVES');
  if (f.hardLockDate !== null && f.hardLockDate !== undefined) out.push('HARD_LOCK');
  if (f.customerAdjustmentSources > 0) out.push('CUSTOMER_ADJUSTMENTS');
  return out;
}

/** يطابق الخادمُ confirmName مع tenant.name حرفياً (لا تشذيب ولا حالة أحرف) */
export function resetConfirmNameMatches(confirmName: unknown, tenantName: string): boolean {
  return typeof confirmName === 'string' && confirmName === tenantName;
}
