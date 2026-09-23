import { clean } from './accounting';

/**
 * عهدة التحصيل لمستخدم الشركة.
 *
 * التعريف: ما استلمه من المناديب (`RepSettlement.receivedByUserId`) ناقص ما
 * ورّده (`UserSettlement.fromUserId`). والتوريد **نهائيّ**: المبلغ يخرج من
 * النظام ولا يدخل عهدة المستلِم، فلا سلسلة عهدٍ ولا تدوير.
 *
 * وسبب وجود هذا الملف — لا بقاء الدالة في `routes/companyUsers.ts` — أنّ
 * السقفَ والرصيد يلزمان مسارَين في ملفّين: التوريد هنا، وحذف استلام المندوب في
 * `routes/salesReps.ts`. فنسختان من الحساب تعني انحرافاً صامتاً في المال.
 */

/** هامش الكسور: نصف هللة يُتجاوَز بها السقف كسندات القبض، لا نصف ريال. */
export const CUSTODY_EPS = 0.005;

// `_sum` اختياريّ في أنواع Prisma (يغيب حين لا صفوف) — والتوقيع يطابقه كي يقبل
// العميلَ وعميلَ المعاملة بلا تحويل.
type Agg = { aggregate(args: unknown): Promise<{ _sum?: { amount?: number | null } | null }> };
/** أقلّ ما تحتاجه الدالة — يقبل `prisma` وعميلَ المعاملة والموكَّ في الاختبار. */
export type CustodyDb = { repSettlement: Agg; userSettlement: Agg };

export type Custody = { received: number; delivered: number; outstanding: number };

export async function userCustody(db: CustodyDb, tid: string, userId: string): Promise<Custody> {
  const [received, delivered] = await Promise.all([
    db.repSettlement.aggregate({ where: { tenantId: tid, receivedByUserId: userId }, _sum: { amount: true } }),
    db.userSettlement.aggregate({ where: { tenantId: tid, fromUserId: userId }, _sum: { amount: true } }),
  ]);
  const r = received._sum?.amount ?? 0;
  const d = delivered._sum?.amount ?? 0;
  return { received: clean(r), delivered: clean(d), outstanding: clean(r - d) };
}

/**
 * قفلٌ استشاريّ لمدى المعاملة على (الشركة، المستخدم).
 *
 * بلا هذا القفل تُقرأ العهدة قبل المعاملة فيمرّ طلبان متزامنان بمبلغ العهدة
 * كاملاً كلٌّ منهما، فتُسجَّل توريداتٌ تتجاوز ما في يد الرجل وتصير عهدته سالبة.
 * ولا صفّ «عهدة» في القاعدة يُقفل بـ`FOR UPDATE` — فالرصيد مجموعُ صفوفٍ في
 * جدولين — فالقفل الاستشاريّ هو وسيلة التسلسل الوحيدة هنا.
 */
export async function lockCustody(
  tx: { $queryRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> },
  tid: string, userId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`custody:${tid}:${userId}`}))`;
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
 * هل يبقى رصيدٌ موجب بعد إسقاط استلامٍ بمبلغ `amount` من عهدة رصيدها الحالي
 * `outstanding`؟ يستخدمه حذف استلام المندوب: إسقاط استلامٍ ورّده صاحبه يجعل
 * «ورّده» أكبر من «استلمه»، فتظهر عهدة سالبة تمنع كلّ توريدٍ لاحق (السقف
 * سالب) وتخفي نفسها عن الشاشة، ولا يصلحها إلا تدخّلٌ في القاعدة.
 */
export function removalKeepsCustodySane(outstanding: number, amount: number): boolean {
  return clean(outstanding - amount) >= -CUSTODY_EPS;
}
