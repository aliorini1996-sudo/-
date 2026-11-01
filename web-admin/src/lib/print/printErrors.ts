/**
 * أخطاء الطباعة التي يقرؤها المستخدم — «إعدادات الطباعة» M3 (التصميم §3.3 و§5.2).
 *
 * لماذا ملفٌّ مستقلّ في lib/print لا في rep/thermal.ts: الرفض نفسه («عرض الورق لا يتسع لرمز الفاتورة المعتمد») يقع اليوم
 * في الشريط الحراريّ (rep) وفي رسم البلوتوث المباشر (lib/print/raster.ts) — ومكتبةٌ لا تستورد من شاشات المندوب. فالصنف
 * هنا وthermal.ts يعيد تصديره كما كان (الاختبارات والشاشة تستوردانه من هناك بلا تغيير).
 *
 * الرسائل عربيةٌ تمرّ على tr في الشاشة، ومعها دائماً بديل: نظام الطباعة في الجهاز أو ملف PDF — لا طريق مسدود.
 */

/** طباعةٌ تُرفض بسبب يقرؤه المندوب (عربيٌّ يُترجم): الرمز لا يتسع، أو مستندٌ لا ورقة له — وملف PDF يبقى */
export class PrintRefusedError extends Error {}

/**
 * أسباب تعذّر الطباعة المباشرة بالبلوتوث — لكلٍّ رسالته وبديله. appUpdate وtooLarge لمسار تطبيق فيلد سيلز على أندرويد:
 * لا سبب تقنيّاً يُذكر للمندوب — دعوةٌ واحدة لتحديث التطبيق، أو نظام الطباعة لمستندٍ أكبر من الرابط.
 *
 * تطبيق الآيفون (iosBridge.ts failureForCode): لا سبب تقنيّ للمندوب على iOS — appUpdateIos (App Store)، وbtOff وbtDenied
 * (بلوتوث الجوال وإذن التطبيق)، وpickPrinter (لا طابعة محفوظة)، وinterrupted (قُفلت الشاشة أو غادر التطبيق)، وprinting (مهمةٌ
 * جارية)؛ ومعها busy وdisconnected وtooLarge وfailed. ولا يخرج على الآيفون notChosen (الإقران من الإعدادات) ولا unsupported.
 */
export type DirectPrintFailure = 'unsupported' | 'notChosen' | 'busy' | 'disconnected' | 'security' | 'failed' | 'appUpdate' | 'tooLarge'
  | 'appUpdateIos' | 'btOff' | 'btDenied' | 'pickPrinter' | 'interrupted' | 'printing';

export const DIRECT_PRINT_MESSAGES: Readonly<Record<DirectPrintFailure, string>> = Object.freeze({
  unsupported: 'الطباعة المباشرة تتطلب Chrome 138 أو أحدث',
  notChosen: 'لم تربط طابعة — اقرن الطابعة أولا من إعدادات البلوتوث في الجوال ثم اربطها',
  busy: 'تعذر الاتصال بالطابعة — تأكد أنها مشغلة وقريبة وغير متصلة بجهاز آخر',
  disconnected: 'انقطع الاتصال بالطابعة — أعد تشغيل الطابعة وحاول',
  security: 'منع المتصفح الوصول إلى الطابعة',
  failed: 'تعذرت الطباعة المباشرة',
  appUpdate: 'لتفعيل الطباعة المباشرة حدث تطبيق فيلد سيلز من Google Play',
  tooLarge: 'المستند أكبر من أن يرسل للطابعة مباشرة — اطبعه بنظام الطباعة في الجهاز',
  appUpdateIos: 'لتفعيل الطباعة المباشرة حدث تطبيق فيلد سيلز من App Store',
  btOff: 'البلوتوث مطفأ في الجوال — شغله ثم أعد الطباعة',
  btDenied: 'اسمح لتطبيق فيلد سيلز باستخدام البلوتوث من إعدادات الجوال ثم أعد الطباعة',
  pickPrinter: 'لم تربط طابعة — اضغط ربط الطابعة واختر طابعتك',
  interrupted: 'توقفت الطباعة قبل أن تكتمل — أعد الطباعة',
  printing: 'طباعة جارية — انتظر حتى تنتهي ثم أعد الطباعة',
});

/** بديل كل خطأ مباشر — يُعرض تحت الرسالة مع زرّي نظام الطباعة وPDF */
export const DIRECT_PRINT_FALLBACK = 'اطبع بنظام الطباعة في الجهاز أو شارك ملف PDF';

/** تعذّرٌ في الطريق إلى الطابعة (لا في المستند): الشاشة تعرض رسالته وتعرض البديل */
export class DirectPrintError extends Error {
  readonly kind: DirectPrintFailure;
  constructor(kind: DirectPrintFailure, cause?: unknown) {
    super(DIRECT_PRINT_MESSAGES[kind]);
    this.kind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
