/**
 * وضع الدفاتر في الواجهة («ربط الدفاتر» L0، طلب المالك ١٣ نوفمبر ٢٠٢٦) — مرآة `backend/src/services/booksMode.ts`
 * بالمعنى نفسه حرفاً بحرف (bookMode.test.ts يطابق جدول الحقيقة مع الخادم). المصدر الوحيد للحكم «يدوية أم مربوطة» في
 * شاشات الدفاتر والاستيراد: لا تُكتب مقارنة حرفية بـ'CLEAN' أو 'LINKED' في مكانٍ آخر (حارس ثابت في الاختبار نفسه).
 *
 * - MANUAL: دفاتر يدوية مستقلة (setupMethod = 'CLEAN') — لا ترحيل آلي، والتشغيل لا يكتب شيئاً في الدفاتر.
 * - LINKED: دفاتر مربوطة بالنظام (setupMethod = 'LINKED' مع التفعيل) — كل مستند يُرحَّل قيده آلياً منذ linkedFrom.
 * - LEGACY: الطريقتان القديمتان OPENING | FULL_HISTORY المفعّلتان (تُعرضان كما كانتا).
 * - NONE: لم تُفعَّل الدفاتر.
 *
 * صرفة بلا استيراد واجهة برمجة ولا React: يستوردها routes.ts وimportData.ts وتُختبر في node.
 */

export type BookMode = 'NONE' | 'MANUAL' | 'LINKED' | 'LEGACY';

/** أدنى شكل يكفي للحكم: حالة `/ledger/status` أو إعدادات `/ledger/settings` أو حالة المعالج */
export interface BookModeSettings {
  setupMethod?: string | null;
  /** ISO من الخادم (أو Date) — المعتبر وجوده وحده كما في الخادم */
  activatedAt?: string | Date | null;
}

/** طرق الإعداد المعروفة (نصّ في القاعدة) — مرآة SETUP_METHODS في الخادم */
export const SETUP_METHODS = ['CLEAN', 'LINKED', 'OPENING', 'FULL_HISTORY'] as const;
export type SetupMethodValue = (typeof SETUP_METHODS)[number];

/**
 * الوضع من إعدادات الدفاتر. لا تفعيل ⇒ NONE، إلا أن MANUAL يُحكم بطريقة الإعداد وحدها كما في الخادم
 * (كانت الشاشات تقارن setupMethod === 'CLEAN' بلا شرط التفعيل) — فلا يتغيّر سلوك قائم.
 */
export function bookMode(s: BookModeSettings | null | undefined): BookMode {
  if (!s) return 'NONE';
  if (s.setupMethod === 'CLEAN') return 'MANUAL';
  if (!s.activatedAt) return 'NONE';
  if (s.setupMethod === 'LINKED') return 'LINKED';
  if (s.setupMethod === 'OPENING' || s.setupMethod === 'FULL_HISTORY') return 'LEGACY';
  return 'NONE';
}

/** دفاتر يدوية مستقلة (CLEAN) — بديل كل `setupMethod === 'CLEAN'` (بلا شرط التفعيل، كالخادم) */
export function isManualBooks(s: BookModeSettings | null | undefined): boolean {
  return !!s && s.setupMethod === 'CLEAN';
}

/** دفاتر مربوطة مفعّلة — ما يخصّ «المربوطة» في الشاشات يظهر لهذه وحدها */
export function isLinked(s: BookModeSettings | null | undefined): boolean {
  return bookMode(s) === 'LINKED';
}

/** يُرحِّل التشغيلُ قيوده آلياً (مربوطة أو قديمة مفعّلة) */
export function postsFromOperations(s: BookModeSettings | null | undefined): boolean {
  const m = bookMode(s);
  return m === 'LINKED' || m === 'LEGACY';
}

/**
 * طريقة مفردة يدوية؟ — للمواضع التي تحمل الطريقة وحدها بلا التفعيل (مسودة المعالج `effective.method`،
 * `SetupStatus.setupMethod`، سياق الاستيراد). يساوي isManualBooks({ setupMethod }) تماماً.
 */
export function isManualMethod(method: string | null | undefined): boolean {
  return isManualBooks({ setupMethod: method });
}

/**
 * طريقة الربط بالنظام (قبل التفعيل أو بعده) — للنصوص والتسميات وحدها. ما يتطلب ربطاً **مفعّلاً** يُحكم بـisLinked.
 */
export function isLinkedMethod(method: string | null | undefined): boolean {
  return method === 'LINKED';
}

/**
 * قاعدة الشاشات: الدفاتر تُعامَل «يدوية مستقلة» (بلا شاشات مستندات التشغيل ولا أحداث الترحيل الآلي) قبل أي تفعيل
 * (كل إعداد جديد يدويّ) أو حين طريقتها CLEAN. المربوطة المفعّلة والتفعيلات السابقة ليست يدوية.
 * أثناء التحميل (لا حالة) يدوية — لا وميض لشاشات التشغيل.
 */
export function isManualLedger(status: BookModeSettings | null | undefined): boolean {
  if (!status) return true;
  return !status.activatedAt || isManualBooks(status);
}

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

/**
 * يوم بدء الربط YYYY-MM-DD من حقل الخادم `linkedFrom` (اختياري: لا يرجعه الخادم اليوم). العمود `@db.Date` قد يصل
 * 'YYYY-MM-DD' أو ISO كاملاً بمنتصف ليل UTC ('2026-01-01T00:00:00.000Z') — يُؤخذ جزء اليوم بلا تحويل منطقة فلا ينزلق
 * يوماً. غير ذلك (غياب، null، نصّ غير تاريخ) ⇒ null.
 */
export function linkedFromDay(s: object | null | undefined): string | null {
  // object لا { linkedFrom?: unknown }: أنواع الحالة والإعدادات في api/* لا تحمل الحقل بعد، فلا تحويل نوع عند كل مستدعٍ
  const v = s ? (s as { linkedFrom?: unknown }).linkedFrom : undefined;
  if (typeof v === 'string') return DAY_PREFIX.exec(v)?.[1] ?? null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

// ═══ الجرد المستمر يتاح مع الربط (L6) ═══

export type InventoryModeValue = 'PERIODIC' | 'PERPETUAL';
const INVENTORY_MODES: readonly InventoryModeValue[] = ['PERIODIC', 'PERPETUAL'];

/** خيار طريقة الجرد كما يرسله الخادم في `GET /ledger/settings` (inventoryModeOptions) */
export interface InventoryModeOption { value: string; available: boolean; reason?: string | null }

/** رمز رفض الخادم لاختيار الجرد المستمر قبل L6 (routes/ledger/config.ts) */
export const INVENTORY_MODE_UNAVAILABLE = 'INVENTORY_MODE_UNAVAILABLE';

/**
 * خيارات «طريقة الجرد» الظاهرة في الإعدادات. الجرد المستمر مخفيّ حتى تصل قيود المخزون وتكلفة البضاعة مع الربط (L6) —
 * الخادم يرفضه بـINVENTORY_MODE_UNAVAILABLE — إلا لشركة قيمتها المحفوظة PERPETUAL أصلاً فلا تنكسر شاشتها (مرآة
 * inventoryModeAvailable في الخادم). قائمة الخادم `inventoryModeOptions` إن وصلت هي الحكم (تتسع وحدها في L6)،
 * والقيمة المحفوظة تبقى ظاهرة دائماً ليعرض الحقل قيمته الحقيقية.
 */
export function inventoryModeChoices(
  saved: string | null | undefined,
  serverOptions?: readonly InventoryModeOption[] | null,
): InventoryModeValue[] {
  const available = (m: InventoryModeValue): boolean => {
    if (m === saved) return true;
    const o = Array.isArray(serverOptions) ? serverOptions.find((x) => x?.value === m) : undefined;
    if (o) return o.available === true;
    return m !== 'PERPETUAL';
  };
  return INVENTORY_MODES.filter(available);
}
