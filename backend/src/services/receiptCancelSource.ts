// ============================================================================
// «ربط الدفاتر» L5 — C11: من أين رُدّ مال السند الملغى؟ (Receipt.cancelRefundFrom / cancelRefundUserId)
// ----------------------------------------------------------------------------
// المشكلة (linked_plan C11): سندٌ نقديّ في عهدة المندوب سُلّم ماله (استلامٌ RepSettlement) ثم أُلغي — عكسُه الآلي مرآةُ أصله
// فيُدين 111003 للمندوب، فتصير عهدته في الدفاتر سالبة بينما المال رُدّ للعميل من الصندوق أو من يد مستخدمٍ استلمه.
// الحلّ: يُسجَّل مصدر الردّ على صفّ السند لحظة الإلغاء، ويقرؤه المُرحِّل (العكس بالـbuilder) وطيّ عهدة المستخدم (D6) وC4b.
//
//   • GET /api/receipts/:id/cancel-options ⇐ cancelRefundOptions: التصنيف للعهدة (CUSTODY|ONLINE|OUTSIDE بقاعدة D4)،
//     و«سُلِّم؟»، والمقترح والخيارات.
//   • PATCH /api/receipts/:id/cancel ⇐ resolveCancelRefund (قبل المعاملة) ثم applyCancelRefundInTx (داخلها قبل عكس القيود).
//
// قاعدة الكتابة (العقد §5.3 والاستثناء (ج) في §0.3): يُكتب الحقلان حين يرسلهما الطلب صراحةً، أو حين الشركة مربوطة (المقترح
// إن غاب الحقل). وإلا لا كتابة ولا قراءة زائدة على السند — الإلغاء حرفياً كما كان. والسند الإلكتروني ONLINE لا يقبل مصدراً
// (عكسه يحسمه رابط الدفع واسترداده)، والمندوب لا يردّ إلا من عهدته.
//
// لا يستورد services/gl: يخدم routes/receipts.ts المحروس بـtests/gl-hooks-static.test.ts. وتصنيف العهدة هنا مرآةٌ صرفة
// لـreceiptCustodyClass/linkedReceiptCustodyClass (services/gl/custody.ts وbuilders/receipt.ts) — اختبار l458-a08 يطابقهما.
// ============================================================================

import type { Prisma } from '@prisma/client';
import { isLinked } from './booksMode';
import { clean } from './accounting';
import { roundHalfUp } from '../lib/money';
import { REP_COLLECTED_CASH_SALE } from './repCashCollection';
import { handoverAllowed, lockCustody, userCustody } from './userCustody';

// ═══ الثوابت ═══

/** مصادر الردّ (العقد §1.1 Receipt.cancelRefundFrom) */
export const CANCEL_REFUND_SOURCES = ['REP_CUSTODY', 'USER_CUSTODY', 'MAIN_CASH', 'BANK', 'METHOD'] as const;
export type CancelRefundFrom = (typeof CANCEL_REFUND_SOURCES)[number];

export const isCancelRefundFrom = (v: unknown): v is CancelRefundFrom =>
  typeof v === 'string' && (CANCEL_REFUND_SOURCES as readonly string[]).includes(v);

/** أسماء المصادر للعرض (الواجهة تترجمها بمفتاح value؛ هذه للمكامل والسجلّ) */
export const CANCEL_REFUND_LABELS: Readonly<Record<CancelRefundFrom, string>> = Object.freeze({
  REP_CUSTODY: 'من عهدة المندوب',
  USER_CUSTODY: 'من عهدة مستخدم الشركة',
  MAIN_CASH: 'من الصندوق الرئيسي',
  BANK: 'من الحساب البنكي',
  METHOD: 'من حساب طريقة الدفع نفسها',
});

export const RECEIPT_CANCEL_REFUND_USER = 'RECEIPT_CANCEL_REFUND_USER';
export const RECEIPT_CANCEL_REFUND_INVALID = 'RECEIPT_CANCEL_REFUND_INVALID';
/** نسبة الردّ إلى عهدة مستخدمٍ آخر بلا صلاحية عهدة التحصيل (403) */
export const RECEIPT_CANCEL_REFUND_USER_FORBIDDEN = 'RECEIPT_CANCEL_REFUND_USER_FORBIDDEN';

export const CANCEL_REFUND_MESSAGES = Object.freeze({
  userRequired: 'الردّ من عهدة مستخدم الشركة يتطلّب اختيار المستخدم',
  userUnknown: 'المستخدم المختار ليس من مستخدمي الشركة',
  userShort: (outstanding: number) => `عهدة المستخدم (${clean(outstanding)}) لا تكفي لردّ مبلغ السند — اختر مصدراً آخر للردّ`,
  invalid: 'مصدر الردّ غير معروف — المتاح: REP_CUSTODY أو USER_CUSTODY أو MAIN_CASH أو BANK أو METHOD',
  userForbidden: 'الردّ من عهدة مستخدمٍ آخر يتطلّب صلاحية عهدة التحصيل بلا تقييد نطاق — اختر المصدر المقترح أو عهدتك أو مصدراً آخر',
});

/** رفضٌ مفهوم (400) — يُرمى قبل المعاملة أو داخلها فيُلغيها كلّها، ويصطاده المسار برمزه */
export class CancelRefundRejected extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'CancelRefundRejected';
  }
}

// ═══ التصنيف للعهدة (صرف) ═══

export type CancelCustodyClass = 'CUSTODY' | 'ONLINE' | 'OUTSIDE';
type RouteTarget = 'CUSTODY' | 'DIRECT';
export type CancelReceiptRouting = Partial<Record<'CASH' | 'BANK_TRANSFER' | 'POS' | 'CHEQUE', RouteTarget>>;

const ROUTABLE_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'] as const;
/** D4: في المربوطة لا يدخل العهدةَ إلا النقد والشيك (التحويل ونقطة البيع إلى حساب طريقتهما، والبطاقة أبداً) */
const LINKED_CUSTODY_METHODS: ReadonlySet<string> = new Set(['CASH', 'CHEQUE']);
/** طرق الاستلام التي تبقى نقداً في اليد (OD5 — مرآة USER_CUSTODY_CASHLIKE_METHODS؛ المجهول = نقد كافتراضي RepSettlement) */
const CASH_LIKE_SETTLEMENT: ReadonlySet<string> = new Set(['CASH', 'CHEQUE']);
const isCashLikeSettlement = (m: string | null | undefined): boolean => !m || CASH_LIKE_SETTLEMENT.has(m) || !(ROUTABLE_METHODS as readonly string[]).includes(m);

/** receiptRouting من عمود JSON (مرآة resolve.ts receiptRoutingOf): مفاتيح الطرق الأربع وقيمتا CUSTODY|DIRECT وحدهما */
export function cancelRoutingFrom(v: unknown): CancelReceiptRouting | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: CancelReceiptRouting = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if ((ROUTABLE_METHODS as readonly string[]).includes(k) && (x === 'CUSTODY' || x === 'DIRECT')) out[k as keyof CancelReceiptRouting] = x;
  }
  return out;
}

/**
 * تصنيف السند كما يصنّفه المُرحِّل (receiptCustodyClass، وفي المربوطة linkedReceiptCustodyClass — D4):
 * ONLINE ⇐ إلكتروني؛ CUSTODY ⇐ بمندوب وطريقته موجّهة للعهدة (والمربوطة: نقد أو شيك وليس بطاقة)؛ وإلا OUTSIDE.
 */
export function cancelCustodyClass(i: {
  paymentMethod: string; salesRepId: string | null | undefined; routing: CancelReceiptRouting | null | undefined; linked: boolean; card?: boolean;
}): CancelCustodyClass {
  if (i.paymentMethod === 'ONLINE') return 'ONLINE';
  const routed = !!i.salesRepId && !!i.routing && i.routing[i.paymentMethod as keyof CancelReceiptRouting] === 'CUSTODY';
  if (!routed) return 'OUTSIDE';
  if (!i.linked) return 'CUSTODY';
  if (i.card) return 'OUTSIDE';
  return LINKED_CUSTODY_METHODS.has(i.paymentMethod) ? 'CUSTODY' : 'OUTSIDE';
}

// ═══ «سُلِّم؟» والمقترح (صرف) ═══

/** مبلغٌ بالملّي نصف-لأعلى (لكل مستند ثم المقارنة بالصحيح — لا غبار أعدادٍ عائمة) */
const milliOf = (n: number): bigint => BigInt(Math.round(roundHalfUp(Number(n) || 0, 3) * 1000));

/**
 * C11: سُلِّم مال السند؟ ⇐ للمندوب استلامٌ بعد تاريخ السند (settledAt ≥ receiptDate)، ومعلَّقه التشغيلي (رصيد التحصيل كما
 * تحسبه GET /collection-balance والسند ما زال نشطاً فيه) أقلّ من مبلغ السند — فلا يكفي ما في يده لردّه.
 */
export function receiptHandedOver(i: { laterSettlement: boolean; repOutstanding: number | null; amount: number }): boolean {
  if (!i.laterSettlement || i.repOutstanding == null) return false;
  return milliOf(i.repOutstanding) < milliOf(i.amount);
}

export interface RefundSuggestInput {
  custodyClass: CancelCustodyClass;
  handedOver: boolean;
  /** آخر استلامٍ من المندوب بعد تاريخ السند */
  lastSettlement: { receivedByUserId: string | null; method: string | null } | null;
  /** عهدة آخر مستلِم (نقد وشيكات — OD5) أو null إن لم يكن مستلِماً مستخدماً */
  receiverOutstanding: number | null;
  amount: number;
}

/**
 * المقترح (العقد §5.3): غير مسلَّم ⇒ REP_CUSTODY؛ مسلَّم إلى مستخدمٍ ما زال يحمل في عهدته ما يكفي ⇒ USER_CUSTODY لآخر مستلِم؛
 * وإلا MAIN_CASH. وسندات OUTSIDE ⇒ METHOD، والإلكتروني ⇒ لا مقترح (لا يقبل مصدراً).
 * تدقيقٌ واحد (OD5): آخر استلامٍ كان تحويلاً أو نقطة بيع ⇒ BANK — المال ذهب إلى البنك لا إلى الصندوق ولا إلى يد المستلِم.
 */
export function suggestCancelRefund(i: RefundSuggestInput): { suggested: CancelRefundFrom | null; userId: string | null } {
  if (i.custodyClass === 'ONLINE') return { suggested: null, userId: null };
  if (i.custodyClass === 'OUTSIDE') return { suggested: 'METHOD', userId: null };
  if (!i.handedOver) return { suggested: 'REP_CUSTODY', userId: null };
  const last = i.lastSettlement;
  if (last && !isCashLikeSettlement(last.method)) return { suggested: 'BANK', userId: null };
  if (last?.receivedByUserId && i.receiverOutstanding != null && handoverAllowed(i.receiverOutstanding, i.amount)) {
    return { suggested: 'USER_CUSTODY', userId: last.receivedByUserId };
  }
  return { suggested: 'MAIN_CASH', userId: null };
}

export interface CancelRefundOption {
  value: CancelRefundFrom;
  label: string;
  /** USER_CUSTODY: المستخدم المقترح (آخر مستلِم) وعهدته الحالية */
  userId?: string;
  userName?: string | null;
  userOutstanding?: number;
}

/** خيارات المنتقي بحسب التصنيف — CUSTODY: عهدة المندوب، وعهدة آخر مستلِم إن وُجد، والصندوق، والبنك؛ OUTSIDE: الطريقة والصندوق والبنك */
export function cancelRefundOptionList(
  cls: CancelCustodyClass,
  receiver: { userId: string; name: string | null; outstanding: number } | null,
): CancelRefundOption[] {
  const opt = (value: CancelRefundFrom): CancelRefundOption => ({ value, label: CANCEL_REFUND_LABELS[value] });
  if (cls === 'ONLINE') return [];
  if (cls === 'OUTSIDE') return [opt('METHOD'), opt('MAIN_CASH'), opt('BANK')];
  const out: CancelRefundOption[] = [opt('REP_CUSTODY')];
  if (receiver) out.push({ ...opt('USER_CUSTODY'), userId: receiver.userId, userName: receiver.name, userOutstanding: receiver.outstanding });
  out.push(opt('MAIN_CASH'), opt('BANK'));
  return out;
}

// ═══ من يرى عهد الآخرين ومن يُنقصها؟ (مراجعة ١٤ نوفمبر) ═══
//
// المسار محروسٌ بـcanManageReceipts وحدها، أما عهدة المستخدم فلا يراها إلا من يدير مستخدمي الشركة بلا تقييد نطاق (guardCustody في
// routes/companyUsers.ts)، ولا تنقص إلا بتوريدٍ يسجّله فوق ذلك صاحب canReceiveUserCollections. فبلا هذا الحارس قرأ مشرفُ فرعٍ مقيّد
// عهدةَ المدير المالي ورصيدَ مندوبٍ خارج نطاقه، ونسب ردّ سندٍ إلى عهدة أي مستخدم فبقي المال في يده ولا يطالبه النظام به.

/** صلاحيات المُلغي على عهد المستخدمين — يحسبها المسار (cancelCustodyAccessFor) ويمرّرها كسولةً فلا قراءة لما لا يلزم */
export interface CancelCustodyAccess {
  /** يرى عهدة أي مستخدم (userOutstanding): من يدير مستخدمي الشركة بلا تقييد نطاق — guardCustody حرفاً */
  viewOthers: boolean;
  /** يُسند الردّ إلى عهدة أي مستخدم: الحارس نفسه + صلاحية استلام العهدة (canReceiveUserCollections) — كتوريدها */
  refundOthers: boolean;
  /** المستخدم الحالي: الردّ من عهدته هو مسموحٌ له دائماً (يُنقص ما في يده وحده)، ورؤيتها كذلك */
  selfId: string | null;
  /** غير مقيّد بنطاق: يرى رصيد التحصيل الفعلي للمندوب (كـcollection-balance لغير المقيّد) */
  unscoped: boolean;
}

/** أقلّ صلاحية — الافتراض حين لا يمرّر المسار شيئاً (آمنٌ افتراضاً) */
export const NO_CUSTODY_ACCESS: Readonly<CancelCustodyAccess> = Object.freeze({ viewOthers: false, refundOthers: false, selfId: null, unscoped: false });

/**
 * صلاحيات المُلغي (صرفٌ فوق صفّ المستخدم): جلسة مالك المنصة كل شيء؛ والمندوب لا شيء (عهدته وحدها: repOnly)؛ والإداري من صفّه —
 * يرى عهد الآخرين بـcanManageCompanyUsers نشطاً وغير مقيّد، ويُسندها بذلك ومعه canReceiveUserCollections (=== false يمنع كـrequireAdminPermission).
 */
export function cancelCustodyAccessFrom(i: {
  userId: string | null | undefined; role: string | null | undefined; impersonated?: boolean; scoped: boolean;
  admin: { isActive?: boolean | null; canManageCompanyUsers?: boolean | null; canReceiveUserCollections?: boolean | null } | null;
}): CancelCustodyAccess {
  if (i.impersonated === true) return { viewOthers: true, refundOthers: true, selfId: null, unscoped: true };
  if (!i.userId || i.role === 'SALES_REP' || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(String(i.role))) return { ...NO_CUSTODY_ACCESS };
  const viewOthers = !i.scoped && i.admin?.isActive === true && i.admin.canManageCompanyUsers === true;
  return { viewOthers, refundOthers: viewOthers && i.admin?.canReceiveUserCollections !== false, selfId: i.userId, unscoped: !i.scoped };
}

/** القراءة: صفّ المستخدم (صلاحياته) ثم الصرف. `scoped` من adminScopeEnabled في المسار (سياق الطلب) */
export async function cancelCustodyAccessFor(
  db: Pick<CancelSourceDb, 'admin'>, user: { id?: string | null; role?: string | null; impersonated?: boolean } | null | undefined, scoped: boolean,
): Promise<CancelCustodyAccess> {
  const base = { userId: user?.id ?? null, role: user?.role ?? null, impersonated: user?.impersonated === true, scoped };
  if (base.impersonated || !base.userId || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(String(base.role))) return cancelCustodyAccessFrom({ ...base, admin: null });
  const admin = await db.admin.findUnique({
    where: { id: base.userId }, select: { isActive: true, canManageCompanyUsers: true, canReceiveUserCollections: true },
  });
  return cancelCustodyAccessFrom({ ...base, admin });
}

/** ما يراه المُلغي من الخيارات: عهدة آخر مستلِم لمن يرى عهد الآخرين أو لصاحبها، ورصيد المندوب لغير المقيّد — والقرار نفسه لا يتغيّر */
export function maskCancelOptions(view: CancelRefundOptionsView, access: CancelCustodyAccess): CancelRefundOptionsView {
  const options = view.options.flatMap((o): CancelRefundOption[] => {
    if (o.value !== 'USER_CUSTODY') return [o];
    const own = !!o.userId && o.userId === access.selfId;
    // الإسناد إلى غيره: لصاحب الصلاحية، أو مقترح الخادم نفسه (المال عند آخر مستلِم وعهدته تكفي — ما يكتبه المقترح بلا جسم أصلاً)
    const assignable = own || access.refundOthers || (view.suggested === 'USER_CUSTODY' && view.suggestedUserId === o.userId);
    if (!assignable) return [];
    if (own || access.viewOthers) return [o];
    const { userOutstanding: _hidden, ...rest } = o;
    void _hidden;
    return [rest];
  });
  return { ...view, repOutstanding: access.unscoped ? view.repOutstanding : null, options };
}

// ═══ القراءة ═══

/** أدنى ما تقرؤه الخيارات — prisma ومقبض المعاملة والمزيّف في الاختبار */
export type CancelSourceDb = Pick<Prisma.TransactionClient,
  'glSettings' | 'receipt' | 'invoice' | 'repSettlement' | 'userSettlement' | 'cardPayment' | 'admin'>;

/** صفّ gl_settings الذي يحتاجه الحكم والتصنيف — قراءةٌ واحدة */
export interface CancelGlRow { setupMethod: string | null; activatedAt: Date | null; receiptRouting: unknown }

export async function loadCancelGl(db: Pick<CancelSourceDb, 'glSettings'>, tenantId: string): Promise<CancelGlRow | null> {
  return db.glSettings.findUnique({
    where: { tenantId }, select: { setupMethod: true, activatedAt: true, receiptRouting: true },
  }) as Promise<CancelGlRow | null>;
}

/** السند كما تحتاجه الخيارات (صفّ GET/PATCH المحمَّل أصلاً) */
export interface CancelReceiptRow {
  id: string;
  amount: number | Prisma.Decimal | { toString(): string };
  paymentMethod: string;
  salesRepId: string | null;
  receiptDate: Date;
}

export interface CancelRefundOptionsView {
  linked: boolean;
  custodyClass: CancelCustodyClass;
  handedOver: boolean;
  suggested: CancelRefundFrom | null;
  /** USER_CUSTODY المقترح: آخر مستلِم */
  suggestedUserId: string | null;
  /** معلَّق المندوب التشغيلي (رصيد التحصيل) حين حُسب، وإلا null */
  repOutstanding: number | null;
  options: CancelRefundOption[];
}

/**
 * خيارات ردّ مال السند عند إلغائه (C11). القراءات: gl_settings (ما لم تُمرَّر)، ثم للتصنيف CUSTODY وحده: بطاقة السند (المربوطة)،
 * وآخر استلامٍ بعد تاريخه، وإن وُجد فرصيد التحصيل بثلاث تجميعات كـcollection-balance (بلا نطاق مستخدم: الرصيد الفعلي للمندوب)،
 * وإن سُلِّم إلى مستخدم فعهدته واسمه. لا قراءة لكل سند ولا لكل مستخدم.
 * opts.repOnly (جلسة المندوب): المندوب لا يردّ إلا من عهدته — لا قراءة لعهد الآخرين ولا لرصيده.
 * opts.access (المسار): ما يُعرض للمُلغي يُقنَّع بصلاحياته (maskCancelOptions) — تُقرأ كسولةً حين يكون للمندوب استلامٌ بعد السند
 * وحده. غيابه (المقترح الداخلي في resolveCancelRefund) = الحساب كاملاً، فالقرار لا يتغيّر بمن يُلغي.
 */
export async function cancelRefundOptions(
  db: CancelSourceDb, tenantId: string, receipt: CancelReceiptRow,
  opts: { gl?: CancelGlRow | null; repOnly?: boolean; access?: () => Promise<CancelCustodyAccess> } = {},
): Promise<CancelRefundOptionsView> {
  const gl = opts.gl !== undefined ? opts.gl : await loadCancelGl(db, tenantId);
  const linked = isLinked(gl);
  const routing = cancelRoutingFrom(gl?.receiptRouting);
  const amount = Number(receipt.amount);
  let custodyClass = cancelCustodyClass({ paymentMethod: receipt.paymentMethod, salesRepId: receipt.salesRepId, routing, linked });
  // D4: البطاقة لا تدخل العهدة أبداً — تُقرأ لسندٍ مرشّحٍ للعهدة في المربوطة وحده (CardPayment.receiptId فريد)
  if (linked && custodyClass === 'CUSTODY') {
    const card = await db.cardPayment.findFirst({ where: { tenantId, receiptId: receipt.id }, select: { id: true } });
    if (card) custodyClass = 'OUTSIDE';
  }
  const base = { linked, custodyClass, handedOver: false, suggestedUserId: null as string | null, repOutstanding: null as number | null };
  if (opts.repOnly) {
    const suggested: CancelRefundFrom | null = custodyClass === 'ONLINE' ? null : 'REP_CUSTODY';
    return { ...base, suggested, options: suggested ? [{ value: 'REP_CUSTODY', label: CANCEL_REFUND_LABELS.REP_CUSTODY }] : [] };
  }
  if (custodyClass !== 'CUSTODY' || !receipt.salesRepId) {
    const s = suggestCancelRefund({ custodyClass, handedOver: false, lastSettlement: null, receiverOutstanding: null, amount });
    return { ...base, suggested: s.suggested, options: cancelRefundOptionList(custodyClass, null) };
  }
  const repId = receipt.salesRepId;
  const last = await db.repSettlement.findFirst({
    where: { tenantId, salesRepId: repId, settledAt: { gte: receipt.receiptDate } },
    orderBy: [{ settledAt: 'desc' }, { createdAt: 'desc' }],
    select: { receivedByUserId: true, method: true },
  });
  let repOutstanding: number | null = null;
  if (last) {
    // رصيد التحصيل كما تحسبه GET /collection-balance حرفاً (السندات النشطة + النقدية المحسوبة تحصيلاً − الاستلامات)
    const [collected, cashSales, settled] = await Promise.all([
      db.receipt.aggregate({ where: { tenantId, salesRepId: repId, status: 'ACTIVE' }, _sum: { amount: true } }),
      db.invoice.aggregate({ where: { tenantId, salesRepId: repId, AND: [REP_COLLECTED_CASH_SALE] }, _sum: { paidAmt: true } }),
      db.repSettlement.aggregate({ where: { tenantId, salesRepId: repId }, _sum: { amount: true } }),
    ]);
    repOutstanding = clean(Number(collected._sum.amount ?? 0) + Number(cashSales._sum.paidAmt ?? 0) - Number(settled._sum.amount ?? 0));
  }
  const handedOver = receiptHandedOver({ laterSettlement: !!last, repOutstanding, amount });
  let receiver: { userId: string; name: string | null; outstanding: number } | null = null;
  if (handedOver && last?.receivedByUserId) {
    const [admin, custody] = await Promise.all([
      db.admin.findFirst({ where: { id: last.receivedByUserId, tenantId }, select: { name: true } }),
      // منظور الدفاتر في المربوطة: الردّ يُرحَّل دائناً على 111004، فمال مندوبٍ محذوف (في 111001 أصلاً) لا يُردّ منها (D6)
      userCustody(db, tenantId, last.receivedByUserId, { ledgerView: true }),
    ]);
    // مستلِمٌ لم يعد من مستخدمي الشركة (حُذف) لا يُقترح ولا يُعرض
    if (admin) receiver = { userId: last.receivedByUserId, name: admin.name ?? null, outstanding: custody.outstanding };
  }
  const s = suggestCancelRefund({
    custodyClass, handedOver,
    lastSettlement: last ? { receivedByUserId: receiver ? receiver.userId : null, method: last.method ?? null } : null,
    receiverOutstanding: receiver ? receiver.outstanding : null, amount,
  });
  const view: CancelRefundOptionsView = {
    ...base, handedOver, repOutstanding, suggested: s.suggested, suggestedUserId: s.userId,
    options: cancelRefundOptionList(custodyClass, receiver),
  };
  // رصيد المندوب وعهدة المستلِم لا يُعرضان إلا لمن يحقّ له (لا استلام بعد السند ⇒ لا شيء منهما أصلاً، فلا قراءة)
  return opts.access && last ? maskCancelOptions(view, await opts.access()) : view;
}

// ═══ الإلغاء: القرار ثم الكتابة ═══

export interface CancelRefundWrite { cancelRefundFrom: CancelRefundFrom; cancelRefundUserId: string | null }

export type CancelRefundDecision =
  | { kind: 'NONE' }
  | { kind: 'WRITE'; write: CancelRefundWrite }
  | { kind: 'SUGGEST' };

/** قراءة الحقلين من جسم الطلب (اختياري — الطلب بلا جسم كاليوم) */
function bodyRefund(body: unknown): { from: unknown; userId: unknown } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.refundFrom === undefined || b.refundFrom === null || b.refundFrom === '') return null;
  return { from: b.refundFrom, userId: b.refundFromUserId };
}

/**
 * قرار الكتابة (صرف — العقد §5.3):
 *  - السند الإلكتروني ONLINE ⇒ لا كتابة (الحقل يُتجاهل).
 *  - المندوب ⇒ REP_CUSTODY دائماً، يُكتب حين يأتي الحقل أو الشركة مربوطة.
 *  - الحقل صريح ⇒ يُتحقَّق منه ويُكتب (لكل شركة — الاستثناء (ج))؛ USER_CUSTODY بلا مستخدم ⇒ 400 RECEIPT_CANCEL_REFUND_USER.
 *  - مربوطة بلا حقل ⇒ SUGGEST (يُكتب المقترح). وإلا ⇒ لا كتابة: الإلغاء حرفياً كما كان.
 */
export function cancelRefundDecision(i: { body: unknown; role: string | null | undefined; paymentMethod: string; linked: boolean }): CancelRefundDecision {
  if (i.paymentMethod === 'ONLINE') return { kind: 'NONE' };
  const b = bodyRefund(i.body);
  if (i.role === 'SALES_REP') {
    return b || i.linked ? { kind: 'WRITE', write: { cancelRefundFrom: 'REP_CUSTODY', cancelRefundUserId: null } } : { kind: 'NONE' };
  }
  if (b) {
    if (!isCancelRefundFrom(b.from)) throw new CancelRefundRejected(RECEIPT_CANCEL_REFUND_INVALID, CANCEL_REFUND_MESSAGES.invalid);
    if (b.from === 'USER_CUSTODY') {
      const uid = typeof b.userId === 'string' ? b.userId.trim() : '';
      if (!uid) throw new CancelRefundRejected(RECEIPT_CANCEL_REFUND_USER, CANCEL_REFUND_MESSAGES.userRequired);
      return { kind: 'WRITE', write: { cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: uid } };
    }
    return { kind: 'WRITE', write: { cancelRefundFrom: b.from, cancelRefundUserId: null } };
  }
  return i.linked ? { kind: 'SUGGEST' } : { kind: 'NONE' };
}

/**
 * قبل معاملة الإلغاء: ما يُكتب على السند، أو null (لا كتابة — الإلغاء كما كان). يرمي CancelRefundRejected (400، و403 للإسناد بلا صلاحية).
 * القراءات: gl_settings مرّة (لغير الإلكتروني)، والمستخدم حين USER_CUSTODY، وخيارات المقترح للمربوطة بلا حقل.
 * USER_CUSTODY صريحاً لمستخدمٍ غير المُلغي: لصاحب صلاحية العهدة (req.access → refundOthers)، وإلا لمقترح الخادم نفسه وحده (آخر
 * مستلِم تكفي عهدته — ما يكتبه المقترح بلا جسمٍ أصلاً). req.access غائب ⇒ أقلّ صلاحية (آمنٌ افتراضاً).
 */
export async function resolveCancelRefund(
  db: CancelSourceDb, tenantId: string, receipt: CancelReceiptRow,
  req: { body: unknown; role: string | null | undefined; access?: () => Promise<CancelCustodyAccess> },
): Promise<CancelRefundWrite | null> {
  if (receipt.paymentMethod === 'ONLINE') return null;
  const gl = await loadCancelGl(db, tenantId);
  const decision = cancelRefundDecision({ body: req.body, role: req.role, paymentMethod: receipt.paymentMethod, linked: isLinked(gl) });
  if (decision.kind === 'NONE') return null;
  if (decision.kind === 'SUGGEST') {
    // المقترح USER_CUSTODY مستلِمٌ من مستخدمي الشركة أصلاً (cancelRefundOptions تتحقّق منه) — لا قراءة ثانية
    const o = await cancelRefundOptions(db, tenantId, receipt, { gl });
    if (!o.suggested) return null;
    return { cancelRefundFrom: o.suggested, cancelRefundUserId: o.suggested === 'USER_CUSTODY' ? o.suggestedUserId : null };
  }
  const write = decision.write;
  if (write.cancelRefundFrom === 'USER_CUSTODY') {
    const uid = write.cancelRefundUserId;
    // الصلاحية قبل وجود المستخدم: لا يُستكشف مستخدمو الشركة برسالتين مختلفتين
    if (uid) await assertMayRefundFromUser(db, tenantId, receipt, gl, uid, req.access);
    const user = uid ? await db.admin.findFirst({ where: { id: uid, tenantId }, select: { id: true } }) : null;
    if (!user) throw new CancelRefundRejected(RECEIPT_CANCEL_REFUND_USER, uid ? CANCEL_REFUND_MESSAGES.userUnknown : CANCEL_REFUND_MESSAGES.userRequired);
  }
  return write;
}

/** ردٌّ من عهدة `uid`: عهدته هو، أو صلاحية الإسناد، أو مقترح الخادم نفسه — وإلا 403 RECEIPT_CANCEL_REFUND_USER_FORBIDDEN */
async function assertMayRefundFromUser(
  db: CancelSourceDb, tenantId: string, receipt: CancelReceiptRow, gl: CancelGlRow | null, uid: string,
  access: (() => Promise<CancelCustodyAccess>) | undefined,
): Promise<void> {
  const a = access ? await access() : NO_CUSTODY_ACCESS;
  if (uid === a.selfId || a.refundOthers) return;
  const o = await cancelRefundOptions(db, tenantId, receipt, { gl });
  if (o.suggested === 'USER_CUSTODY' && o.suggestedUserId === uid) return;
  throw new CancelRefundRejected(RECEIPT_CANCEL_REFUND_USER_FORBIDDEN, CANCEL_REFUND_MESSAGES.userForbidden, 403);
}

/** مقبض معاملة الإلغاء الذي تحتاجه الكتابة (قفل العهدة + طيّها + تحديث السند) */
export type CancelRefundTx = Pick<Prisma.TransactionClient, 'receipt' | 'repSettlement' | 'userSettlement' | '$executeRaw'>;

/**
 * داخل معاملة الإلغاء بعد المطالبة بالسند (claimReceiptCancel) وقبل عكس قيوده: USER_CUSTODY ⇒ قفل عهدة المستخدم (القفل نفسه
 * الذي يأخذه توريده) ثم التحقق أنّ عهدته تكفي — قبل كتابة الحقل فلا يُعدّ ردُّ هذا السند من عهدته مرّتين — ثم كتابة الحقلين.
 * عهدةٌ لا تكفي ⇒ CancelRefundRejected يُلغي المعاملة كلّها (لا إلغاء ولا قيد).
 */
export async function applyCancelRefundInTx(
  tx: CancelRefundTx, tenantId: string, receipt: { id: string; amount: CancelReceiptRow['amount'] }, write: CancelRefundWrite,
): Promise<void> {
  if (write.cancelRefundFrom === 'USER_CUSTODY' && write.cancelRefundUserId) {
    await lockCustody(tx, tenantId, write.cancelRefundUserId);
    const c = await userCustody(tx, tenantId, write.cancelRefundUserId, { ledgerView: true });
    if (!handoverAllowed(c.outstanding, Number(receipt.amount))) {
      throw new CancelRefundRejected(RECEIPT_CANCEL_REFUND_USER, CANCEL_REFUND_MESSAGES.userShort(c.outstanding));
    }
  }
  await tx.receipt.update({
    where: { id: receipt.id },
    data: { cancelRefundFrom: write.cancelRefundFrom, cancelRefundUserId: write.cancelRefundUserId },
  });
}
