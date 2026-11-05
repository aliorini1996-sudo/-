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
import { deviceNowMs } from './deviceTrack';

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
  if (!i.replay || i.role !== 'SALES_REP' || i.viaApiKey) return null;
  if (typeof i.bodyInvoiceDate === 'string' && i.bodyInvoiceDate.trim() !== '') return null;
  if (typeof i.clientCreatedAt !== 'string' || i.clientCreatedAt.trim() === '') return null;
  const raw = new Date(i.clientCreatedAt).getTime();
  const now = i.now.getTime();
  if (!Number.isFinite(raw)) return null;
  // ساعة الجهاز منحرفة (أكثر من خمس دقائق عن الخادم وقت الرفع) ⇒ تُصحَّح لحظة الإصدار بالفرق نفسه
  // الصيغتان (deviceNowMs): معترض repApi يرسلها رقماً بالملّي ثانية ويغلب ما يضعه الصندوق، والتطبيق الأصلي قد يرسلها ISO
  const devNow = deviceNowMs(i.deviceNow);
  const skew = devNow != null ? now - devNow : 0;
  const t = Math.abs(skew) > DEVICE_CLOCK_SKEW_TOLERANCE_MS ? raw + skew : raw;
  const at = new Date(t);
  // المرحلة الثانية مفعّلة: المستند الانتقاليّ (لحظته قبل التفعيل) وحده — وإلا ساعة الخادم
  if (i.phase2StartedAt != null) {
    const started = new Date(i.phase2StartedAt).getTime();
    if (!Number.isFinite(started) || t >= started) return null;
  }
  // لا مستقبل: ساعة جهازٍ متقدّمة (ولو بدقائق) ⇒ ساعة الخادم
  if (t > now) return null;
  // ولا أقدم من الحدّ ⇒ ساعة الخادم، ولحظة الجهاز مخزّنةٌ في clientCreatedAt
  if (now - t > OFFLINE_INVOICE_DATE_MAX_AGE_MS) return null;
  return at;
}
