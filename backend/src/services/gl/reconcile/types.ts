/**
 * «ربط الدفاتر» L8 — المطابقة الجزئية الآلية بين سطور الذمم (عقد §3.7، §6.1، D7).
 *
 * المطابقة **مشتقّة** من المستندات لا يدوية: تُكتب داخل معاملة الترحيل نفسها بعد كل قيد ذمة (المُرحِّل A6، ومسار M4،
 * ومسار التسوية الموجّهة)، وتُفكّ عند العكس كما يحذف Odoo ‏`account.partial.reconcile`. الصفّ متساوي الأثر بمصدره
 * `@@unique([tenantId, sourceRef, debitLineId, creditLineId])`، والمتبقّي لكل سطر = مبلغه − Σ مطابقاته من الجهتين.
 *
 * هذا الملف أنواع صرفة بلا prisma: المخزن الحقيقي في `store.prisma.ts`، والمزيّف في `tests/gl-fake-posting-store.ts`.
 */
import type { LocalDate, Milli, SourceEvent, SourceType } from '../types';
import type { SourceEventPayload } from '../sync/types';

/** نوع الحساب الرقابي الذي تُطابَق سطوره: ذمم العملاء AR وذمم الموردين AP (العهد لا تُطابَق) */
export type ReconcileKind = 'AR' | 'AP';
export type ReconcileSide = 'DEBIT' | 'CREDIT';

/** سطر ذمة مرحَّل بمتبقّيه — `residualMilli` = المبلغ − Σ المطابقات التي تمسّه (مدينةً أو دائنة) */
export interface OpenControlLine {
  lineId: string;
  moveId: string;
  accountId: string;
  kind: ReconcileKind;
  /** العميل (AR) أو المورّد (AP) — لا يُطابَق سطران من شريكين مختلفين أبداً */
  partnerId: string;
  side: ReconcileSide;
  /** مبلغ السطر موجباً (المدين أو الدائن) */
  amountMilli: bigint;
  residualMilli: bigint;
  date: LocalDate;
  dueDate: LocalDate | null;
  seq: number;
}

/** صفّ GlPartialReconcile جديد — المبلغ موجب دائماً */
export interface PartialInsert {
  debitLineId: string;
  creditLineId: string;
  debitMoveId: string;
  creditMoveId: string;
  amountMilli: bigint;
  sourceRef: string;
}

/** صفّ مطابقة قائم كما يقرؤه الفكّ */
export interface PartialRow {
  id: string;
  debitLineId: string;
  creditLineId: string;
  amountMilli: bigint;
  sourceRef: string | null;
}

/** تخصيص مرحَّل لم يُطابَق كاملاً بعد (سند RI أو شطب CA) — `amountMilli` = الباقي منه بعد مطابقاته القائمة */
export interface PendingAllocation {
  sourceRef: string;
  /** القيد الحيّ للسند أو الشطب (صاحب سطر الدائن) */
  creditMoveId: string;
  amountMilli: bigint;
}

export interface ReconcileStore {
  /** سطور الذمة (حسابات controlKind = kind، ولها شريك) في القيد بمتبقّيها، بترتيب seq */
  controlLinesOfMove(moveId: string, kind: ReconcileKind): Promise<OpenControlLine[]>;
  /** القيد الحيّ لمفتاح POST الأساس (`INVOICE:<id>:POST`) أو آخر REPOST منه — null إن لم يُرحَّل أو عُكس */
  liveMoveIdOf(baseKey: string): Promise<string | null>;
  /** سندات/شطب مرحّلة لها تخصيص على الفاتورة لم يُطابَق كاملاً (لفاتورة رُحّلت بعد سندها) */
  pendingAllocationsForInvoice(invoiceId: string): Promise<PendingAllocation[]>;
  /** المطابقات التي يقع أحد طرفيها في أحد القيود */
  partialsOfMoves(moveIds: string[]): Promise<PartialRow[]>;
  /** إدراج متساوي الأثر (createMany skipDuplicates) — يعيد عدد المُدرَج فعلاً */
  insertPartials(rows: readonly PartialInsert[]): Promise<number>;
  deletePartials(ids: readonly string[]): Promise<number>;
  /**
   * اختياري (FIFO لـM4 والتسوية الموجّهة): السطور المفتوحة لشريك على جانب واحد بالأقدم أولاً.
   * غيابه (المخزن المزيّف القديم) ⇒ لا مطابقة FIFO، ولا خطأ.
   */
  openLinesOfPartner?(kind: ReconcileKind, partnerId: string, side: ReconcileSide): Promise<OpenControlLine[]>;
  /** اختياري (دفعة واحدة بدل استعلام لكل تخصيص): القيود الحيّة لعدة مفاتيح POST — غيابه ⇒ liveMoveIdOf لكلٍّ */
  liveMoveIdsOf?(baseKeys: readonly string[]): Promise<Map<string, string>>;
  /** اختياري: سطور الذمة لعدة قيود دفعةً واحدة (moveId ⇒ سطوره) — غيابه ⇒ controlLinesOfMove لكلٍّ */
  controlLinesOfMoves?(moveIds: readonly string[], kind: ReconcileKind): Promise<Map<string, OpenControlLine[]>>;
  /**
   * اختياري (L8): مرتجعات وإشعارات دائنة مرحّلة حيّة appliesTo لها هذه الفاتورة (من لقطة حمولة INVOICE:POST المرحَّل)،
   * لفاتورة بيعٍ رُحّلت بعدها (فشلٌ عابر أو HELD ثم أُصلح، أو إعادة ترحيل فكّت مطابقاتها). غيابه ⇒ لا التقاط (كما كان).
   */
  pendingReturnsForInvoice?(invoiceId: string): Promise<PendingReturn[]>;
  /**
   * اختياري (L8، الافتتاح): من مفاتيح POST الأساس، ما حدثُه SKIPPED(OPENING) — مستندٌ ذمته داخل سطر افتتاح العميل في قيد
   * OPENING فلا قيد حيّ له أبداً. غيابه (أو غياب openingLinesOfPartner) ⇒ لا مطابقة مع الافتتاح (كما كان).
   */
  openingKeysOf?(baseKeys: readonly string[]): Promise<Set<string>>;
  /** اختياري (L8، الافتتاح): سطور ذمة الشريك المفتوحة في قيود OPENING المرحّلة، الأقدم فالأقدم */
  openingLinesOfPartner?(kind: ReconcileKind, partnerId: string): Promise<OpenControlLine[]>;
}

/**
 * مرتجع (RET:<id>، بحدّ ما أسقطه من متبقّي بيعه) أو إشعار دائن (CN:<id>، بحدّ المفتوح D8) مرحَّل لم يُطابَق على فاتورة
 * بيعه — `amountMilli` = الباقي منه بعد مطابقاته القائمة، وnull للإشعار الدائن (بحدّ المفتوح من الجهتين).
 */
export interface PendingReturn {
  sourceRef: string;
  /** القيد الحيّ للمرتجع أو الإشعار (صاحب سطر الدائن) */
  creditMoveId: string;
  amountMilli: bigint | null;
}

export interface ReconcileEventInput {
  sourceType: SourceType;
  sourceId: string;
  event: SourceEvent;
  /** القيد المرحَّل الآن (للعكس: قيد العكس نفسه) */
  moveId: string;
  /** للعكس: القيد الأصلي المعكوس — null حين لا أصل حيّاً (عكسٌ من المستند لأصلٍ في الافتتاح) */
  reversedMoveId?: string | null;
  payload: SourceEventPayload | CustomerAdjustmentReconcilePayload | null;
}

export interface ReconcileOutcome {
  created: number;
  removed: number;
}

/**
 * حمولة المطابقة لتسوية ذمم العميل (M4، مسار A9): الشطب يُطابِق تخصيصاته CA:<allocId> بسطور الفواتير، والاسترداد يُطابِق
 * سطر مدينه بالأرصدة الدائنة المفتوحة للعميل FIFO:<lineId>. يمرّرها المسار مع sourceType 'CUSTOMER_ADJUSTMENT'
 * (أو 'AR_ENTRY' بـorigin 'CUSTOMER_ADJUSTMENT').
 */
export interface CustomerAdjustmentReconcilePayload {
  origin?: 'CUSTOMER_ADJUSTMENT';
  adjustmentId?: string;
  kind: 'BAD_DEBT_WRITEOFF' | 'CREDIT_REFUND';
  customerId?: string | null;
  /** للشطب: تخصيصاته (CustomerAdjustmentAllocation) والمبلغ نصّ بمنازل العملة */
  allocations?: readonly { id: string; invoiceId: string; amount: string }[];
}

// ═══ مراجع المصدر (sourceRef) — صيغة واحدة يقرؤها الفكّ والتقارير ═══

export const SOURCE_REF_KINDS = ['CASH', 'RI', 'CA', 'RET', 'CN', 'REV', 'FIFO', 'SPA', 'CLR'] as const;
export type SourceRefKind = (typeof SOURCE_REF_KINDS)[number];

/** ساقا الذمة في الفاتورة النقدية (القيد نفسه) */
export const cashRef = (moveId: string): string => `CASH:${moveId}`;
/** تخصيص سند على فاتورة (ReceiptInvoice.id) */
export const receiptAllocationRef = (receiptInvoiceId: string): string => `RI:${receiptInvoiceId}`;
/** تخصيص شطب على فاتورة (CustomerAdjustmentAllocation.id) */
export const adjustmentAllocationRef = (allocationId: string): string => `CA:${allocationId}`;
/** مرتجع المرحلة الأولى المرتبط (معرّف فاتورة المرتجع) */
export const returnRef = (returnInvoiceId: string): string => `RET:${returnInvoiceId}`;
/** إشعار دائن (المرحلة الثانية) — بحدّ المفتوح (D8) */
export const creditNoteRef = (creditNoteId: string): string => `CN:${creditNoteId}`;
/** سطر أصلي مع سطر عكسه */
export const reversalRef = (reversalMoveId: string): string => `REV:${reversalMoveId}`;
/** الأقدم فالأقدم لسطرٍ واحد (استرداد الرصيد الدائن M4) */
export const fifoRef = (lineId: string): string => `FIFO:${lineId}`;
/** تخصيص دفعة مورد على فاتورته (L6) */
export const supplierAllocationRef = (allocationId: string): string => `SPA:${allocationId}`;

/** نوع المرجع من نصّه — null لمطابقة يدوية أو شكل مجهول */
export function sourceRefKind(ref: string | null | undefined): SourceRefKind | null {
  if (!ref) return null;
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  const k = ref.slice(0, i);
  return (SOURCE_REF_KINDS as readonly string[]).includes(k) ? (k as SourceRefKind) : null;
}

/** مصادر يُطابَق قيدها بعد ترحيله (تعريف واحد مع المُرحِّل) */
export const RECONCILE_SOURCE_TYPES: readonly SourceType[] = [
  'INVOICE', 'RECEIPT', 'AR_ENTRY', 'PAYLINK_REFUND', 'CUSTOMER_ADJUSTMENT',
];

/** للمخزن: مبلغ سطر الذمة الموجب وجانبه من مدينه ودائنه — null لسطر صفري */
export function controlLineSide(debitMilli: Milli, creditMilli: Milli): { side: ReconcileSide; amountMilli: Milli } | null {
  if (debitMilli > 0n) return { side: 'DEBIT', amountMilli: debitMilli };
  if (creditMilli > 0n) return { side: 'CREDIT', amountMilli: creditMilli };
  return null;
}
