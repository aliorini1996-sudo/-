/**
 * وضع الدفاتر لكل شركة — المصدر الوحيد للحكم «يدوية أم مربوطة» («ربط الدفاتر» L0، طلب المالك ١٣ نوفمبر ٢٠٢٦).
 *
 * - MANUAL: دفاتر يدوية مستقلة (setupMethod = 'CLEAN') — لا ترحيل آلي، والتشغيل لا يكتب شيئاً في الدفاتر.
 * - LINKED: دفاتر مربوطة بالنظام كله (setupMethod = 'LINKED') — كل مستند يُرحَّل قيده آلياً، ومنذ بداية السنة المالية.
 * - LEGACY: الطريقتان القديمتان OPENING | FULL_HISTORY (لا تُفعَّلان اليوم؛ تُعامَلان كمربوطة في الترحيل).
 * - NONE: لم تُفعَّل الدفاتر لهذه الشركة.
 *
 * خارج services/gl عمداً: المسارات التشغيلية (invoices.ts وreceipts.ts وغيرها) ممنوعة من استيراد services/gl
 * (الحارس gl-hooks-static)، لكنها تحتاج حارس «لا حذف لمستند مرحَّل» في الشركة المربوطة (قرار المالك OD1).
 * services/gl/mode.ts يعيد تصدير هذه الدوال — لا تُكتب مقارنة حرفية بـ'CLEAN' أو 'LINKED' في مكانٍ آخر.
 */

export type BookMode = 'NONE' | 'MANUAL' | 'LINKED' | 'LEGACY';

/** أدنى شكل لإعدادات الدفاتر يكفي للحكم */
export interface BookModeSettings {
  setupMethod?: string | null;
  activatedAt?: Date | null;
}

/** طرق الإعداد المعروفة (نصّ في القاعدة) */
export const SETUP_METHODS = ['CLEAN', 'LINKED', 'OPENING', 'FULL_HISTORY'] as const;
export type SetupMethodValue = (typeof SETUP_METHODS)[number];

/**
 * الوضع من إعدادات الدفاتر. لا تفعيل (activatedAt فارغ) ⇒ NONE، إلا أن MANUAL يُحكم بطريقة الإعداد وحدها كما كان
 * (tick.ts وtombstone.ts كانا يقارنان setupMethod === 'CLEAN' بلا شرط التفعيل) — فلا يتغيّر سلوك قائم.
 */
export function bookMode(s: BookModeSettings | null | undefined): BookMode {
  if (!s) return 'NONE';
  if (s.setupMethod === 'CLEAN') return 'MANUAL';
  if (!s.activatedAt) return 'NONE';
  if (s.setupMethod === 'LINKED') return 'LINKED';
  if (s.setupMethod === 'OPENING' || s.setupMethod === 'FULL_HISTORY') return 'LEGACY';
  return 'NONE';
}

/** دفاتر يدوية مستقلة (CLEAN) — بديل كل `setupMethod === 'CLEAN'` */
export function isManualBooks(s: BookModeSettings | null | undefined): boolean {
  return !!s && s.setupMethod === 'CLEAN';
}

/** دفاتر مربوطة مفعّلة — حرّاس «لا حذف للمرحَّل» وقفل العملة/الدولة تعمل لهذه وحدها */
export function isLinked(s: BookModeSettings | null | undefined): boolean {
  return bookMode(s) === 'LINKED';
}

/** يُرحِّل التشغيلُ قيوده آلياً (مربوطة أو قديمة مفعّلة) */
export function postsFromOperations(s: BookModeSettings | null | undefined): boolean {
  const m = bookMode(s);
  return m === 'LINKED' || m === 'LEGACY';
}

/** أدنى شكل للعميل: PrismaClient وPrisma.TransactionClient والمزيّف في الاختبارات */
export interface BookModeDb {
  glSettings: {
    findUnique(args: { where: { tenantId: string }; select: { setupMethod: true; activatedAt: true } }):
      Promise<{ setupMethod: string | null; activatedAt: Date | null } | null>;
  };
}

/** وضع دفاتر الشركة بقراءة واحدة لـgl_settings */
export async function tenantBookMode(db: BookModeDb, tenantId: string): Promise<BookMode> {
  const s = await db.glSettings.findUnique({ where: { tenantId }, select: { setupMethod: true, activatedAt: true } });
  return bookMode(s);
}

/** الشركة ذات دفاتر مربوطة مفعّلة؟ */
export async function tenantBooksLinked(db: BookModeDb, tenantId: string): Promise<boolean> {
  return (await tenantBookMode(db, tenantId)) === 'LINKED';
}

/** رسالة الرفض الموحّدة لحذف مستندٍ مرحَّل في الشركة المربوطة (409 BOOKS_LINKED_NO_DELETE) */
export const LINKED_NO_DELETE_CODE = 'BOOKS_LINKED_NO_DELETE';
export const LINKED_NO_DELETE_MESSAGE = 'دفاتر هذه الشركة مربوطة بالنظام: المستند المرحَّل لا يُحذف — ألغِه أو اعمل له إشعاراً دائناً/مرتجعاً بدلاً من الحذف';
