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

/** أسباب تعذّر الطباعة المباشرة بالبلوتوث — لكلٍّ رسالته وبديله */
export type DirectPrintFailure = 'unsupported' | 'notChosen' | 'busy' | 'disconnected' | 'security' | 'failed';

export const DIRECT_PRINT_MESSAGES: Readonly<Record<DirectPrintFailure, string>> = Object.freeze({
  unsupported: 'الطباعة المباشرة تتطلب Chrome 138 أو أحدث',
  notChosen: 'لم تربط طابعة — اقرن الطابعة أولا من إعدادات البلوتوث في الجوال ثم اربطها',
  busy: 'تعذر الاتصال بالطابعة — تأكد أنها مشغلة وقريبة وغير متصلة بجهاز آخر',
  disconnected: 'انقطع الاتصال بالطابعة — أعد تشغيل الطابعة وحاول',
  security: 'منع المتصفح الوصول إلى الطابعة',
  failed: 'تعذرت الطباعة المباشرة',
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
