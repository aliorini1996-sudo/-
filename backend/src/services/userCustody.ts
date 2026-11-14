import type { Prisma } from '@prisma/client';
import { clean } from './accounting';
import { isLinked } from './booksMode';
import { roundHalfUp } from '../lib/money';
import {
  foldUserCustody, userHandoverCapMilli,
  type UserCustodyDeliveredRow, type UserCustodyFold, type UserCustodyInputs, type UserCustodyReceivedRow, type UserCustodyRefundRow,
} from './userCustodyCore';

/**
 * عهدة التحصيل لمستخدم الشركة.
 *
 * التعريف (قرار المالك OD5، «ربط الدفاتر» L5): **النقد والشيكات وحدها**. ما استلمه من المناديب نقداً أو شيكاً
 * (`RepSettlement.receivedByUserId`) ناقص الجزء النقدي ممّا ورّده (`UserSettlement.fromUserId`) ناقص ما رُدّ من عهدته
 * لعميلٍ أُلغي سنده (`Receipt.cancelRefundFrom = USER_CUSTODY`). والمستلَم تحويلاً أو بنقطة بيع لا يدخل العهدة — المال
 * في البنك أصلاً — بل «وعاءً غير نقدي» يمرّ منه التوريد غير النقدي أولاً بلا أثر على النقد. الطيّ نفسه
 * (`services/userCustodyCore.ts → foldUserCustody`) تستعمله الشاشة والدفاتر والفحص C4u معاً.
 *
 * والتوريد **نهائيّ**: المبلغ يخرج من النظام ولا يدخل عهدة المستلِم، فلا سلسلة عهدٍ ولا تدوير.
 *
 * وسبب وجود هذا الملف — لا بقاء الدالة في `routes/companyUsers.ts` — أنّ السقفَ والرصيد يلزمان مسارَين في ملفّين:
 * التوريد هنا، وحذف استلام المندوب في `routes/salesReps.ts`. فنسختان من الحساب تعني انحرافاً صامتاً في المال.
 */

/** هامش الكسور: نصف هللة يُتجاوَز بها السقف كسندات القبض، لا نصف ريال. */
export const CUSTODY_EPS = 0.005;
/** الهامش نفسه بالملّي */
const CUSTODY_EPS_MILLI = 5n;

/**
 * أقلّ ما تحتاجه الدوال — يقبل `prisma` وعميلَ المعاملة والموكَّ في الاختبار. التجميع (groupBy) يحدّد من له تاريخ عهدة
 * أولاً، ثم تُقرأ صفوف هؤلاء وحدهم (findMany) لأن الطيّ زمنيّ لا يُجمَّع (مرور الوعاء يتبع الترتيب).
 */
export type CustodyDb = Pick<Prisma.TransactionClient, 'repSettlement' | 'userSettlement' | 'receipt'>
  // gl_settings اختياري: منه منازل العملة ومنظور الدفاتر للشركة المربوطة (custodyBooksOf) — وغيابه (موكّ) = سلوك اليوم حرفاً
  & Partial<Pick<Prisma.TransactionClient, 'glSettings'>>;

export type Custody = {
  /** المستلَم نقداً وشيكات */
  received: number;
  /** الجزء النقدي من التوريدات + ما رُدّ من العهدة لعملاء — فيتحقّق دائماً outstanding = received − delivered */
  delivered: number;
  outstanding: number;
  /** المستلَم تحويلاً ونقطة بيع (لا يدخل العهدة) */
  nonCashReceived: number;
  /** ما ورّده بطريقة غير نقدية مروراً من المستلَم غير النقدي (بلا أثر على النقد) */
  passThrough: number;
};

export interface CustodyReadOptions {
  /**
   * منازل تقريب كل مستند (نصف-لأعلى) قبل الجمع بالملّي. الغائب: منازل عملة الدفاتر للشركة المربوطة (كمحمّل الدفاتر حرفاً —
   * فالسقف هنا والتقسيم هناك بالمبلغ نفسه)، وإلا 3 (الملّي نفسه: سلوك اليوم لكل شركة غير مربوطة)
   */
  decimals?: number;
  /**
   * منظور الدفاتر (111004) بدل منظور اليد: في الشركة المربوطة وحدها يُوسم استلام المندوب المحذوف outsideCustody كما يسمه محمّل
   * الدفاتر — لحرّاس الحذف التي تحمي التقسيم المخزَّن. الغائب: اليد (ما يحمله المستخدم فعلاً — الشاشة والسقف).
   */
  ledgerView?: boolean;
}

/** مبلغ مستندٍ واحد بالملّي، مقرَّباً نصف-لأعلى لمنازله (القاعدة: لكل مستند ثم الجمع) */
function docMilli(amount: number | null | undefined, decimals: number): bigint {
  const r = roundHalfUp(Number(amount ?? 0), decimals);
  return BigInt(Math.round(r * 1000));
}

/** ملّي ⇐ رقم للعرض (JSON) */
const milliNumber = (m: bigint): number => clean(Number(m) / 1000);

const emptyInputs = (userId: string): UserCustodyInputs => ({ userId, received: [], delivered: [], refunds: [] });

/**
 * مدخلات الطيّ لمستخدمين (الكل حين `userIds = null`) بلا N+1: تجميعتان تحدّدان من له تاريخ عهدة، ثم ثلاث قراءات
 * لصفوف هؤلاء وحدهم (readUserCustodyOpsRows — المصدر نفسه للدفاتر) وقراءة gl_settings. والسندات المردودة من العهدة لا تُقرأ
 * إلا لمن له تاريخ (لا ردَّ من عهدةٍ لم تُستلم يوماً) — فلا يُمسح جدول السندات لمستخدمٍ لم يستلم شيئاً.
 */
export async function userCustodyInputsMany(
  db: CustodyDb, tid: string, userIds: readonly string[] | null, opts: CustodyReadOptions = {},
): Promise<Map<string, UserCustodyInputs>> {
  const out = new Map<string, UserCustodyInputs>();
  if (userIds && userIds.length === 0) return out;
  const scopeRec = userIds ? { in: [...userIds] } : { not: null };
  const [recUsers, delUsers] = await Promise.all([
    db.repSettlement.groupBy({ by: ['receivedByUserId'], where: { tenantId: tid, receivedByUserId: scopeRec }, _count: { _all: true } }),
    db.userSettlement.groupBy({ by: ['fromUserId'], where: { tenantId: tid, ...(userIds ? { fromUserId: { in: [...userIds] } } : {}) }, _count: { _all: true } }),
  ]);
  const active = new Set<string>();
  for (const g of recUsers) if (g.receivedByUserId) active.add(g.receivedByUserId);
  for (const g of delUsers) if (g.fromUserId) active.add(g.fromUserId);
  if (active.size === 0) return out;
  const ids = [...active];
  const [books, rows] = await Promise.all([custodyBooksOf(db, tid), readUserCustodyOpsRows(db, tid, ids)]);
  return userCustodyInputsFromRows(rows, {
    decimals: opts.decimals ?? (books.linked ? books.decimals : 3),
    ledgerView: opts.ledgerView === true && books.linked,
  });
}

// ═══ المصدر الواحد لصفوف العهدة (D6): الشاشة هنا ومحمّل الدفاتر (postingStore.loadUserCustodyInputsMany) يقرآن الصفوف نفسها ═══
//
// لماذا (مراجعة ١٤ نوفمبر): كان لكلٍّ محمّله — الشاشة تعدّ استلامات المندوب المحذوف والدفاتر تُسقطها مع إبقاء توريد مالها، ومنازل
// التقريب 3 هنا ومنازل العملة هناك، ولحظة الردّ updatedAt هنا وصفّ الإلغاء هناك. فاختلف رقما الشاشتين بمبلغ الاستلام كله، وقيّد
// المُرحِّل توريداً بتقسيمٍ غير الذي أجازه السقف (111004 سالب و111001 مرّتين). الآن: قراءة واحدة، وتحويل واحد، وقرارٌ واحد
// لاستلام المندوب المحذوف — يُقرأ في الطرفين؛ اليد تعدّه نقداً (المال في يد المستخدم فعلاً)، ومنظور الدفاتر يسمه outsideCustody
// (سنداته OUTSIDE في 111001 والمُطابِق لا يرحّل استلامه) فيمرّ توريد ماله بلا قيد.

/** صفوف العهدة كما في القاعدة (بلا تحويل) */
export interface UserCustodyOpsRows {
  received: ReadonlyArray<{
    id: string; receivedByUserId: string | null; salesRepId: string | null; amount: number; method: string; settledAt: Date; createdAt: Date;
  }>;
  delivered: ReadonlyArray<{ id: string; fromUserId: string; amount: number; method: string; settledAt: Date; createdAt: Date }>;
  refunds: ReadonlyArray<{
    id: string; cancelRefundUserId: string | null; amount: number; createdAt: Date; updatedAt?: Date | null;
    accountEntries?: ReadonlyArray<{ entryDate: Date }> | null;
  }>;
}

/**
 * ثلاث قراءات لصفوف المستخدمين `userIds` (null = كل من له استلامٌ أو توريد أو ردّ): الاستلامات بمستلِمها **ومعها مندوبها**
 * (الفارغ = مندوب محذوف)، والتوريدات، والسندات الملغاة المردودة من العهدة مع لحظة إلغائها (صفّ عكسها RECEIPT_DEBIT).
 */
export async function readUserCustodyOpsRows(db: CustodyDb, tid: string, userIds: readonly string[] | null): Promise<UserCustodyOpsRows> {
  const ids = userIds ? [...userIds] : null;
  const [received, delivered, refunds] = await Promise.all([
    db.repSettlement.findMany({
      where: { tenantId: tid, receivedByUserId: ids ? { in: ids } : { not: null } },
      select: { id: true, receivedByUserId: true, salesRepId: true, amount: true, method: true, settledAt: true, createdAt: true },
    }),
    db.userSettlement.findMany({
      where: { tenantId: tid, ...(ids ? { fromUserId: { in: ids } } : {}) },
      select: { id: true, fromUserId: true, amount: true, method: true, settledAt: true, createdAt: true },
    }),
    db.receipt.findMany({
      where: { tenantId: tid, status: 'CANCELLED', cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: ids ? { in: ids } : { not: null } },
      select: {
        id: true, cancelRefundUserId: true, amount: true, createdAt: true, updatedAt: true,
        // لحظة الإلغاء من صفّ عكسه (RECEIPT_DEBIT) — استعلامٌ واحد للعلاقة لكل الصفحة
        accountEntries: { where: { type: 'RECEIPT_DEBIT' }, select: { entryDate: true }, orderBy: { entryDate: 'asc' }, take: 1 },
      },
    }),
  ]);
  return { received, delivered, refunds };
}

/** لحظة ردّ السند: صفّ عكسه، وإلا updatedAt (السند الملغى لا يُحدَّث بعده)، وإلا إنشاؤه */
function refundAtOf(r: UserCustodyOpsRows['refunds'][number]): Date {
  return r.accountEntries?.[0]?.entryDate ?? r.updatedAt ?? r.createdAt;
}

/**
 * صفوف ⇐ مدخلات الطيّ (صرف): كل مستند بالملّي مقرَّباً نصف-لأعلى لـ`decimals` (كـtoMilli في الدفاتر حرفاً). ledgerView: استلام
 * المندوب المحذوف (salesRepId فارغ) outsideCustody — يدخل الوعاء لا العهدة.
 */
export function userCustodyInputsFromRows(
  rows: UserCustodyOpsRows, opts: { decimals: number; ledgerView?: boolean; wanted?: (userId: string) => boolean },
): Map<string, UserCustodyInputs> {
  const out = new Map<string, UserCustodyInputs>();
  const ok = (u: string | null | undefined): u is string => typeof u === 'string' && u !== '' && (!opts.wanted || opts.wanted(u));
  const of = (u: string): UserCustodyInputs => {
    let x = out.get(u);
    if (!x) { x = emptyInputs(u); out.set(u, x); }
    return x;
  };
  const dec = opts.decimals;
  for (const r of rows.received) {
    if (!ok(r.receivedByUserId)) continue;
    const row: UserCustodyReceivedRow = {
      id: r.id, amountMilli: docMilli(r.amount, dec), method: r.method, at: r.settledAt, createdAt: r.createdAt,
      // null صريح من القاعدة (المندوب حُذف: SetNull) — لا غيابُ الحقل
      ...(opts.ledgerView && r.salesRepId === null ? { outsideCustody: true } : {}),
    };
    of(r.receivedByUserId).received.push(row);
  }
  for (const d of rows.delivered) {
    if (!ok(d.fromUserId)) continue;
    const row: UserCustodyDeliveredRow = { id: d.id, amountMilli: docMilli(d.amount, dec), method: d.method, at: d.settledAt, createdAt: d.createdAt };
    of(d.fromUserId).delivered.push(row);
  }
  for (const f of rows.refunds) {
    if (!ok(f.cancelRefundUserId)) continue;
    const row: UserCustodyRefundRow = { id: f.id, amountMilli: docMilli(f.amount, dec), at: refundAtOf(f), createdAt: f.createdAt };
    of(f.cancelRefundUserId).refunds.push(row);
  }
  return out;
}

/** منازل الدفاتر الصالحة (0..3) */
const validDecimals = (d: unknown): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 3;

/** الشركة مربوطة؟ ومنازل عملة دفاترها — قراءة gl_settings واحدة حين يقدّمها العميل (الموكّ بلا الجدول = غير مربوطة) */
export async function custodyBooksOf(db: CustodyDb, tid: string): Promise<{ linked: boolean; decimals: number }> {
  if (!db.glSettings) return { linked: false, decimals: 3 };
  const s = await db.glSettings.findUnique({ where: { tenantId: tid }, select: { setupMethod: true, activatedAt: true, currencyDecimals: true } });
  const linked = isLinked(s);
  return { linked, decimals: linked && validDecimals(s?.currencyDecimals) ? s!.currencyDecimals : 3 };
}

/**
 * مدخلات طيّ مستخدم واحد (صفوفه كاملة) — لحرّاس الحذف (حذف استلام المندوب وحذف التوريد). بمنظور الدفاتر في المربوطة: الحارس
 * يحمي تقسيماً يخزّنه المُرحِّل من محمّل الدفاتر، فيرى ما يراه (استلام المندوب المحذوف outsideCustody). وغير المربوطة كاليوم.
 */
export async function userCustodyInputs(db: CustodyDb, tid: string, userId: string, opts: CustodyReadOptions = {}): Promise<UserCustodyInputs> {
  return (await userCustodyInputsMany(db, tid, [userId], { ledgerView: true, ...opts })).get(userId) ?? emptyInputs(userId);
}

/** طيّ اليد (الشاشة والسقف): ما يحمله المستخدم فعلاً */
export async function userCustodyFold(db: CustodyDb, tid: string, userId: string, opts: CustodyReadOptions = {}): Promise<UserCustodyFold> {
  return foldUserCustody((await userCustodyInputsMany(db, tid, [userId], opts)).get(userId) ?? emptyInputs(userId));
}

/** أرقام الشاشة من الطيّ */
export function custodyFromFold(f: UserCustodyFold): Custody {
  return {
    received: milliNumber(f.receivedCashMilli),
    delivered: milliNumber(f.receivedCashMilli - f.outstandingMilli),
    outstanding: milliNumber(f.outstandingMilli),
    nonCashReceived: milliNumber(f.receivedNonCashMilli),
    passThrough: milliNumber(f.passThroughMilli),
  };
}

const ZERO_CUSTODY: Readonly<Custody> = Object.freeze({ received: 0, delivered: 0, outstanding: 0, nonCashReceived: 0, passThrough: 0 });

export async function userCustody(db: CustodyDb, tid: string, userId: string, opts: CustodyReadOptions = {}): Promise<Custody> {
  return custodyFromFold(await userCustodyFold(db, tid, userId, opts));
}

/** عهدة كل المستخدمين (أو المذكورين) بست قراءات على الأكثر (ومعها gl_settings) — لا استعلام لكل مستخدم. الغائب عن الخريطة عهدته صفر */
export async function userCustodyMany(
  db: CustodyDb, tid: string, userIds: readonly string[] | null = null, opts: CustodyReadOptions = {},
): Promise<Map<string, Custody>> {
  const inputs = await userCustodyInputsMany(db, tid, userIds, opts);
  const out = new Map<string, Custody>();
  for (const [u, x] of inputs) out.set(u, custodyFromFold(foldUserCustody(x)));
  return out;
}

/** عهدة مستخدم من نتيجة userCustodyMany (صفر لمن لا تاريخ له) */
export const custodyIn = (m: ReadonlyMap<string, Custody>, userId: string): Custody => m.get(userId) ?? { ...ZERO_CUSTODY };

/**
 * قفلٌ استشاريّ لمدى المعاملة على (الشركة، المستخدم).
 *
 * بلا هذا القفل تُقرأ العهدة قبل المعاملة فيمرّ طلبان متزامنان بمبلغ العهدة
 * كاملاً كلٌّ منهما، فتُسجَّل توريداتٌ تتجاوز ما في يد الرجل وتصير عهدته سالبة.
 * ولا صفّ «عهدة» في القاعدة يُقفل بـ`FOR UPDATE` — فالرصيد مجموعُ صفوفٍ في
 * جدولين — فالقفل الاستشاريّ هو وسيلة التسلسل الوحيدة هنا.
 *
 * `$executeRaw` لا `$queryRaw`: الدالة تُرجع `void`، و`$queryRaw` يحاول قراءة العمود فيفشل
 * («Failed to deserialize column of type 'void'») — فكان كل استلام عهدة وكل حذف استلام مندوب في
 * عهدة مستخدم يسقط بخطأ خادم (بلاغ المالك، ٢٩ سبتمبر ٢٠٢٦). كأقفال الدفاتر والاستيراد تماماً.
 */
export async function lockCustody(
  tx: { $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  tid: string, userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`custody:${tid}:${userId}`}::text))`;
}

/**
 * رفضٌ ماليّ يُرفع **داخل** المعاملة ليُلغيها كاملةً (وهذا سببُ كونه خطأً لا
 * قيمةَ إرجاع)، ويصطاده المسار فيردّ 400 برسالته كما هي.
 */
export class CustodyBlocked extends Error {
  constructor(message: string) { super(message); this.name = 'CustodyBlocked'; }
}

/** خطأ السقف: توريدٌ أكبر ممّا في العهدة. */
export class CustodyExceeded extends CustodyBlocked {
  constructor(public readonly outstanding: number, public readonly amount: number) {
    super(`المبلغ يتجاوز عهدة المستخدم (${clean(outstanding)})`);
    this.name = 'CustodyExceeded';
  }
}

/** هل يُقبل توريد `amount` من عهدةٍ متبقّيها `outstanding`؟ */
export function handoverAllowed(outstanding: number, amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && amount <= outstanding + CUSTODY_EPS;
}

/**
 * سقف التوريد بطريقته (OD5): النقد والشيك من العهدة النقدية وحدها، والتحويل ونقطة البيع من العهدة + المستلَم غير
 * النقدي الذي لم يمرّ بعد (يمرّ منه أولاً). بالرقم للعرض.
 */
export function handoverCap(fold: UserCustodyFold, method: string): number {
  return milliNumber(userHandoverCapMilli(fold, method));
}

/** هل يُقبل توريد `amount` بطريقة `method` على طيّ العهدة الحالي؟ (الهامش نفسه: نصف هللة) */
export function handoverAllowedFor(fold: UserCustodyFold, method: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  return docMilli(amount, 3) <= userHandoverCapMilli(fold, method) + CUSTODY_EPS_MILLI;
}

/**
 * هل يبقى رصيدٌ موجب بعد إسقاط استلامٍ بمبلغ `amount` من عهدة رصيدها الحالي
 * `outstanding`؟ يستخدمه حذف استلام المندوب: إسقاط استلامٍ ورّده صاحبه يجعل
 * «ورّده» أكبر من «استلمه»، فتظهر عهدة سالبة تمنع كلّ توريدٍ لاحق (السقف
 * سالب) وتخفي نفسها عن الشاشة، ولا يصلحها إلا تدخّلٌ في القاعدة.
 */
export function removalKeepsCustodySane(outstanding: number, amount: number): boolean {
  return clean(outstanding - amount) >= -CUSTODY_EPS;
}
