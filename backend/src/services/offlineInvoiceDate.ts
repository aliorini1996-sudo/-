/**
 * تاريخ فاتورة المندوب المُصدَرة دون اتصال (مراجعة المخزون نوفمبر ٢٠٢٦، البند ١٥ — قرار المالك D11).
 *
 * بيعٌ الساعة ٢٢:٠٠ يوم ٣ رُفع ٠٨:٠٠ يوم ٤ كان يُؤرَّخ بيوم ٤ (لحظة المزامنة) في الفاتورة وحركة السيارة والتقارير وورقة إعادة الطباعة،
 * مع أن العميل استلم يوم ٣ والورقة الأولى مطبوعةٌ بلحظة الجهاز. فإعادة رفع صندوق المندوب تُؤرَّخ بلحظة إصدارها على الجهاز
 * (clientCreatedAt) — بحصرٍ صارم، ولشركات المرحلة الأولى وحدها:
 *
 * • المرحلة الثانية لا تمرّ من هنا أبداً: تاريخ الفاتورة فيها لحظة ختمها على الخادم (phase2InvoiceColumns: invoiceDate = issuedAt)،
 *   وهي IssueDate/IssueTime في الـUBL الموقَّع ووسم QR رقم ٣، وترتيب ICV/PIH ترتيب الختم تحت قفل الوحدة، ومهلة الإبلاغ ٢٤ ساعة
 *   للمبسّطة تُحسب منها (reportDeadlineFor). الجهاز لم يُصدر فاتورةً ضريبية أصلاً (ورقته «محلي-…» ليست فاتورة)، فتأريخ المستند
 *   بلحظته يجعل IssueDate يسبق الختم وقد يقع خارج مهلة الإبلاغ عند ختمه، ويكسر اطّراد التاريخ مع ICV. أمّا شركةٌ فُعّلت مرحلتها الثانية
 *   (zatcaPhase2StartedAt) فلا يصل مسارَها القديمَ إلا مستندٌ انتقاليٌّ مقبولٌ مرحلةً أولى (ACCEPT_PHASE1 أو قرار الإدارة) — بلا UBL
 *   ولا ICV ولا إبلاغ — فلحظة جهازه **قبل التفعيل** تُعتمد (ورقة العميل بها، ولا فاتورةَ مرحلةٍ أولى في دفاتر فترة المرحلة الثانية)؛
 *   ولحظةٌ عند التفعيل أو بعده ⇒ ساعة الخادم كما كان. وفرع المرحلة الثانية لا يقرأ هذا التاريخ أصلاً (يؤرّخ بلحظة الختم).
 * • المرحلة الأولى: لا إبلاغ ولا تخليص ولا سلسلة، ووسم QR الزمني يُبنى عند الطباعة من invoiceDate (RepDocuments: zatcaTimestamp)
 *   — فإعادة طباعة الفاتورة بعد المزامنة كانت تحمل لحظةً غير لحظة الورقة الأولى. ولحظة الجهاز تُصلحه.
 * • الحصر: لا مستقبل — لحظةٌ بعد ساعة الخادم (ولو بدقائق انحراف ساعة الجهاز) ⇒ ساعة الخادم. ولا أقدم من سبعة أيام
 *   (CUTOVER_BACKDATE_LIMIT_MS: أقصى تأريخٍ سابق تقبله قاعدة الانتقال للمستند دون اتصال، وهو نافذة إعادة الرفع في اللوط وسياسة
 *   المرتجع) ⇒ ساعة الخادم. ولحظةٌ تالفة أو غائبة ⇒ ساعة الخادم. وclientCreatedAt يبقى مخزّناً كما هو في كل الأحوال.
 * • تاريخٌ صريح في الجسم (invoiceDate من لوحة الإدارة أو المفتاح) يغلب كما كان، ومفتاح API والإدارة والإصدار الحيّ بلا تغيير.
 * • ساعة جهازٍ متأخّرة (منطقةٌ زمنية خاطئة وساعةٌ معدّلة يدوياً) لا يكشفها حصر المستقبل: الصندوق يرسل لحظة الجهاز **وقت الرفع**
 *   (X-FS-Device-Now)، فإن جاوز الفرق بينها وبين ساعة الخادم خمس دقائق صُحّحت لحظة الإصدار به (المدّة بين الإصدار والرفع
 *   على ساعة الجهاز نفسها صحيحة) ثم يسري الحصر. حزمةٌ أقدم بلا الترويسة ⇒ كما كان.
 */
import { CUTOVER_BACKDATE_LIMIT_MS } from '../compliance/zatca/goLive';
import { deviceNowMs, isoInstantMs } from './deviceTrack';
import { isPriceRuleDay } from './priceRules';
import { localDateIn } from './shelfLife';

/** أقدم لحظة جهازٍ تُعتمد تاريخاً — سبعة أيام قبل ساعة الخادم */
export const OFFLINE_INVOICE_DATE_MAX_AGE_MS = CUTOVER_BACKDATE_LIMIT_MS;

/** انحرافٌ لساعة الجهاز يُتسامح فيه بلا تصحيح — خمس دقائق */
export const DEVICE_CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;

/** ترويسة لحظة الجهاز وقت الرفع (يرسلها صندوق المندوب مع X-FS-Replay) */
export const DEVICE_NOW_HEADER = 'x-fs-device-now';

/** قيمة ترويسةٍ نصّاً (المكرّرة ⇒ الأولى) */
export const headerText = (v: string | string[] | undefined): string | null =>
  (Array.isArray(v) ? v[0] : v) ?? null;

export interface OfflineDateInput {
  /** إعادة رفعٍ من الصندوق (X-FS-Replay = 1) */
  replay: boolean;
  /** دور صاحب الجلسة — المندوب وحده */
  role: string | null | undefined;
  /** الطلب بمفتاح API (عميلٌ حيّ لا صندوق، وترويسة الإعادة تُمحى له أصلاً) */
  viaApiKey: boolean;
  /** تاريخٌ صريح في الجسم — يغلب */
  bodyInvoiceDate?: string | null;
  /** لحظة الإصدار على الجهاز كما أُرسلت */
  clientCreatedAt?: string | null;
  /** لحظة الجهاز وقت الرفع (X-FS-Device-Now) — لقياس انحراف ساعته */
  deviceNow?: string | null;
  /** لحظة تفعيل المرحلة الثانية — لحظة الجهاز بعدها لا تُعتمد (المستند الانتقاليّ قبلها يُعتمد) */
  phase2StartedAt?: Date | null;
  now: Date;
}

/**
 * لحظة الجهاز تاريخاً للفاتورة، أو null ⇒ يبقى السلوك القائم (ساعة الخادم عند الإنشاء، أو التاريخ الصريح). نقيّة.
 */
export function offlineInvoiceDate(i: OfflineDateInput): Date | null {
  return deviceInstantWithin(i, OFFLINE_INVOICE_DATE_MAX_AGE_MS);
}

/**
 * انحراف ساعة الجهاز عن ساعة الخادم وقت الرفع (X-FS-Device-Now) بالملّي ثانية — يُضاف إلى كل لحظةٍ على ساعة الجهاز إن جاوز خمس دقائق،
 * وإلا (أو بلا ترويسةٍ صالحة) صفر. الصيغتان (deviceNowMs): معترض repApi يرسلها رقماً بالملّي ثانية ويغلب ما يضعه الصندوق، والتطبيق
 * الأصلي قد يرسلها ISO. نقيّة.
 */
export function deviceClockSkewMs(deviceNow: unknown, now: Date): number {
  const devNow = deviceNowMs(deviceNow);
  const skew = devNow != null ? now.getTime() - devNow : 0;
  return Math.abs(skew) > DEVICE_CLOCK_SKEW_TOLERANCE_MS ? skew : 0;
}

/** حصر offlineInvoiceDate بأقدم عمرٍ يُمرَّر: سبعة أيام للتأريخ (OFFLINE_INVOICE_DATE_MAX_AGE_MS) وثلاثون للتسعير (PRICE_REPLAY_MAX_AGE_MS) */
function deviceInstantWithin(i: OfflineDateInput, maxAgeMs: number): Date | null {
  if (!i.replay || i.role !== 'SALES_REP' || i.viaApiKey) return null;
  if (typeof i.bodyInvoiceDate === 'string' && i.bodyInvoiceDate.trim() !== '') return null;
  if (typeof i.clientCreatedAt !== 'string' || i.clientCreatedAt.trim() === '') return null;
  const raw = new Date(i.clientCreatedAt).getTime();
  const now = i.now.getTime();
  if (!Number.isFinite(raw)) return null;
  // ساعة الجهاز منحرفة (أكثر من خمس دقائق عن الخادم وقت الرفع) ⇒ تُصحَّح لحظة الإصدار بالفرق نفسه (deviceClockSkewMs)
  const t = raw + deviceClockSkewMs(i.deviceNow, i.now);
  const at = new Date(t);
  // المرحلة الثانية مفعّلة: المستند الانتقاليّ (لحظته قبل التفعيل) وحده — وإلا ساعة الخادم
  if (i.phase2StartedAt != null) {
    const started = new Date(i.phase2StartedAt).getTime();
    if (!Number.isFinite(started) || t >= started) return null;
  }
  // لا مستقبل: ساعة جهازٍ متقدّمة (ولو بدقائق) ⇒ ساعة الخادم
  if (t > now) return null;
  // ولا أقدم من الحدّ ⇒ ساعة الخادم، ولحظة الجهاز مخزّنةٌ في clientCreatedAt
  if (now - t > maxAgeMs) return null;
  return at;
}

/** مدخلات لحظة الجهاز للتسعير: مدخلات offlineInvoiceDate بلا التاريخ الصريح ولا المرحلة الثانية */
export type DevicePriceInput = Omit<OfflineDateInput, 'bodyInvoiceDate' | 'phase2StartedAt'>;

/**
 * أقدم لحظة جهازٍ يُسعَّر بها مستند الصندوق — ثلاثون يوماً (CONTRACT2 D1). مستندٌ محجوزٌ «بانتظار الإدارة» (عجز السيارة أو اللوط أو
 * مراجعة الانتقال) يُعاد رفعه كل عشر دقائق حتى تفصل الإدارة، وقد يتجاوز أسبوعاً: بحدّ التأريخ (سبعة أيام) كان يُسعَّر بيوم المزامنة
 * فيُرفض عرضٌ سرى لحظة البيع ويُعدم المستند. للتسعير وحده — حدّ التأريخ (OFFLINE_INVOICE_DATE_MAX_AGE_MS) كما هو
 */
export const PRICE_REPLAY_MAX_AGE_MS = 30 * 86_400_000;

/**
 * «قوائم الأسعار» (طلب المالك ٥ نوفمبر ٢٠٢٦): لحظة إصدار مستند الصندوق على الجهاز — يومُ تسعير قواعد القائمة ذات الفترة في حارس
 * سعر المندوب (routes/invoices.ts)، ولحظةٌ تُسقَط بها قواعدُ كُتبت بعدها لم يعرفها الجهاز (CONTRACT2 D3)، فعرضٌ سرى لحظة البيع وانتهى
 * قبل المزامنة لا يُعدم مستنداً سُلّمت بضاعته.
 * حصر offlineInvoiceDate نفسه (إعادة رفع المندوب وحده لا الإدارة ولا مفتاح API، مصحَّحةً بانحراف ساعته عبر X-FS-Device-Now، لا
 * مستقبل — وإلا null فساعة الخادم) إلا العمر: ثلاثون يوماً (PRICE_REPLAY_MAX_AGE_MS) لا سبعة، و**بلا استثناءي التأريخ**: التاريخ
 * الصريح في الجسم يختاره المرسل فلا يحكم السعر أبداً، والمرحلة الثانية تؤرّخ المستند بلحظة ختمه لكنّ البيع وقع لحظة الجهاز. نقيّة.
 */
export function devicePriceInstant(i: DevicePriceInput): Date | null {
  return deviceInstantWithin({ ...i, bodyInvoiceDate: null, phase2StartedAt: null }, PRICE_REPLAY_MAX_AGE_MS);
}

/**
 * نافذة يوم تسعير الجهاز حول لحظة التسعير — ساعتان قبلها وساعتان بعدها (التحقّق بعد CONTRACT2 D1، الافتراض الآمن للمالك): «ضمن يومٍ من
 * يوم الخادم» كان يفتح لمندوبٍ بلا «تغيير السعر» عرضَ الأمس المنتهي أو عرضَ الغد ظهراً بمجرّد تغيير تاريخ جواله يوماً
 */
export const PRICING_DAY_WINDOW_MS = 2 * 3_600_000;

/**
 * «قوائم الأسعار» (CONTRACT2 D1): يوم تسعير الجهاز كما أرسله (body.pricingDay — يوم الشركة الذي سعّر به البنود) يُقبل يوماً مرشّحاً ثانياً
 * إن كان يوماً صحيحاً 'YYYY-MM-DD' يساوي يوم الشركة قبل لحظة التسعير بساعتين أو بعدها بساعتين (`instant`: لحظة الجهاز في إعادة الرفع،
 * وإلا ساعة الخادم؛ `tz` منطقة الشركة)؛ وإلا null ⇒ يُهمل بصمت. فلا أثر له إلا قرب منتصف ليل الشركة — سلّةٌ سُعّرت ٢٣:٥٠ وأُصدرت ٠٠:١٠،
 * أو جهازٌ تخالف ساعته أو منطقته بدقائق — ولا تُرفض بذلك فاتورة؛ وفي سائر اليوم يوما النافذة يوم الخادم نفسه فلا يفتح تاريخ الجوال عرضاً.
 * نقيّة.
 */
export function devicePricingDay(sent: unknown, instant: Date, tz: string): string | null {
  if (!isPriceRuleDay(sent)) return null;
  const at = instant.getTime();
  if (!Number.isFinite(at)) return null;
  return sent === localDateIn(new Date(at - PRICING_DAY_WINDOW_MS), tz) || sent === localDateIn(new Date(at + PRICING_DAY_WINDOW_MS), tz)
    ? sent : null;
}

/** مدخلات لحظة معرفة الجهاز بقواعد القائمة (priceRulesKnownAt) */
export interface RulesKnownInput {
  /** لحظة إصدار المستند على الجهاز (devicePriceInstant) — لإعادة رفع المندوب وحدها */
  priceInstant: Date;
  /** body.pricesSeenAt: لحظة جلب الجهاز كاش أسعار القوائم وقواعدها، ISO على ساعته — كما أُرسلت */
  pricesSeenAt: unknown;
  /** لحظة الجهاز وقت الرفع (X-FS-Device-Now) — تُصحَّح بها كلحظة الإصدار */
  deviceNow?: string | null;
  now: Date;
}

/**
 * «قوائم الأسعار» (التحقّق L2.2 بعد CONTRACT2 D3): حدّ ما عرفه الجهاز من قواعد القائمة — لحظة إصداره، أو لحظة جلبه كاش الأسعار
 * (body.pricesSeenAt) إن سبقتها: جهازٌ منقطعٌ منذ ٠٨:٠٠ لم يرَ قاعدةً كُتبت ١٠:٠٠ ولو باع ١١:٠٠، فلا يُرفض بها مستندٌ سُلّمت بضاعته.
 * اللحظة بصيغة ISO كاملة بمنطقتها (isoInstantMs) على ساعة الجهاز، فتُصحَّح بانحرافها كلحظة الإصدار (deviceClockSkewMs)، وتُقبل إن
 * لم تكن بعد لحظة الإصدار ولا أقدم منها بأكثر من ثلاثين يوماً (PRICE_REPLAY_MAX_AGE_MS) ⇒ min(لحظة الإصدار، هي). وغير ذلك (غائبةٌ أو
 * تالفة أو بغير نوعها أو خارج الحدّ) ⇒ لحظة الإصدار كما كان — تُهمل بصمت، لا 400. يستدعيه المستدعي لإعادة رفعٍ بلحظة جهازٍ وحدها
 * (الحيّ لا يقرؤها). نقيّة.
 */
export function priceRulesKnownAt(i: RulesKnownInput): Date {
  const raw = isoInstantMs(i.pricesSeenAt);
  if (raw == null) return i.priceInstant;
  const seen = raw + deviceClockSkewMs(i.deviceNow, i.now);
  const at = i.priceInstant.getTime();
  // ولا أقدم من ثلاثين يوماً قبل ساعة الخادم أيضاً — فلا تبلغ إعادةُ رفعٍ مصطنعة قواعدَ كُتبت قبل ستين يوماً
  const floor = Math.max(at, i.now.getTime()) - PRICE_REPLAY_MAX_AGE_MS;
  return seen <= at && seen >= floor ? new Date(seen) : i.priceInstant;
}

/**
 * لحظة الجهاز **بلا تصحيح** ساعته (clientCreatedAt كما أُرسلت) لإعادة رفع المندوب — يوم تسعيره (body.pricingDay) حُسب بساعته هو، فجوالٌ
 * تنحرف ساعته أكثر من ساعتين قرب منتصف الليل يُقارن يومه بها أيضاً. لا تُوسّع شيئاً: إعادة الرفع تختار لحظتها أصلاً. وتُقبل إن لم تبعد
 * عن لحظة التسعير المصحَّحة أكثر من يوم؛ وإلا null. نقيّة.
 */
export function rawDeviceMoment(clientCreatedAt: unknown, priceInstant: Date | null): Date | null {
  if (!priceInstant || typeof clientCreatedAt !== 'string') return null;
  const raw = Date.parse(clientCreatedAt);
  if (!Number.isFinite(raw) || Math.abs(raw - priceInstant.getTime()) > 86_400_000) return null;
  return new Date(raw);
}

/**
 * «قوائم الأسعار» (CONTRACT2 D3): الصفوف كما عرفها الجهاز لحظة إصدار مستنده — ما كُتب (updatedAt) عند اللحظة أو قبلها؛ وما كُتب
 * بعدها لم يصله فيُسقَط. وصفٌّ بلا لحظةٍ صالحة يبقى (لا يُفترض جديداً). نقيّة.
 */
export function rowsKnownAt<T extends { updatedAt?: string | number | Date | null }>(rows: readonly T[], instant: Date): T[] {
  const at = instant.getTime();
  return rows.filter((r) => {
    const v = r.updatedAt;
    const t = v == null ? NaN : v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
    return !(t > at);
  });
}
