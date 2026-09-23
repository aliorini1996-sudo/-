/**
 * فوترة ZATCA المرحلة الثانية (Z5.6b) — قرار الطباعة والمشاركة لمستندٍ واحد. نقيّ: بلا React ولا قاموس ولا QR.
 *
 * السبب المباشر (نقد الخطة 6، ومراجعة Z5.2): كلّ واجهات المنصّة الثلاث (تطبيق المندوب، لوحة الإدارة، ‏/m) تبني اليوم
 * رمز QR للمرحلة الأولى من **إعدادات الشركة** (`rep/zatca.ts: buildZatcaQr`) وتطبع فوقه «فاتورة ضريبية». لو مرّ صفٌّ
 * من المرحلة الثانية على ذلك المسار لخرجت بيد العميل ورقةٌ برمزٍ من صنعنا لا ختم للهيئة فيه — وأسوأ منها: فاتورة قياسية
 * **لم تعتمدها الهيئة بعد**. فصار للطباعة قرارٌ واحد يسبق كل قالب:
 *
 * | النظام | النوع | مرآة الفاتورة | ما يُطبع |
 * |---|---|---|---|
 * | المرحلة الأولى | — | — | كما اليوم حرفياً: عنوان اليوم ورمز المرحلة الأولى المبنيّ محلياً |
 * | المرحلة الثانية | 02 مبسّطة | signed / report_blocked / reported(_warn) | فاتورة ضريبية مبسطة + **الرمز المختوم من الخادم** |
 * | المرحلة الثانية | 01 قياسية | cleared(_warn) / reported(_warn) | فاتورة ضريبية + **الرمز المعتمد من الهيئة** |
 * | المرحلة الثانية | 01 قياسية | clearance_pending / clearance_blocked / cleared_no_xml | **سند تسليم — ليست فاتورة ضريبية** (قرار المالك D5): بلا رمز وبلا تفصيل ضريبة |
 * | المرحلة الثانية | إشعار دائن/مدين غير معتمد | أيّ حالة غير قابلة للطباعة | لا ورقة — «بانتظار اعتماد الهيئة» |
 * | المرحلة الثانية | أيّ نوع | rejected / withdrawn | لا ورقة — مستند مُبطل |
 *
 * ولا يُبنى رمز المرحلة الأولى إلا حين `qr.source === 'phase1'`، وهي حالٌ لا تصدر عن صفٍّ من المرحلة الثانية أبداً
 * (يحرسه `printGuards.test.ts` على مصدر القوالب نفسها).
 */

import type { ZatcaDocView, ZatcaMirrorStatus } from './docStatus';

export type ZatcaPrintKind =
  /** المرحلة الأولى — سلوك اليوم بلا أيّ تغيير */
  | 'phase1'
  /** مستند ضريبيّ مكتمل: عنوانه الضريبي ورمزه المختوم */
  | 'tax'
  /** قياسية سُلّمت بضاعتها ولم تُعتمد بعد: سند تسليم لا فاتورة (D5) */
  | 'deliveryNote'
  /** لا ورقة: مستند بانتظار حسم الهيئة ولا بديل له */
  | 'pending'
  /** لا ورقة: مستند أُبطل (رفض أو سحب) */
  | 'void';

export type ZatcaQrSource = 'phase1' | 'stamped' | 'none';

export interface ZatcaPrintDecision {
  phase: 1 | 2;
  kind: ZatcaPrintKind;
  /** عنوان المستند بالعربية — تمرّره الواجهة على `tr`. */
  title: string;
  qr: { source: ZatcaQrSource; value: string | null; caption: string | null };
  /** تفصيل الوعاء والضريبة والنِّسب — يُخفى في سند التسليم والمُبطل (ورقةٌ غير ضريبية لا تُظهر ضريبة). */
  showTaxBreakdown: boolean;
  /**
   * ورقةُ **فاتورة قياسية** (01) بما توجبه من سعر وحدةٍ قبل الضريبة؟
   *
   * مصدره الخادم في المرحلة الثانية (`v.subtype`) لا تخمينُ القالب من رقم المشتري الضريبي: الخادم يصنّف 01 أيضاً
   * لمشترٍ `BUSINESS`/`GOVERNMENT` أو لمن له سجلّ تجاريّ بلا رقم ضريبي (`mapInvoice.ts: classifySubtype`). فلولا
   * هذا الحقل لخرجت ورقةٌ عنوانها «فاتورة ضريبية» من الخادم وجسمُها مبسّط من التخمين — مستندٌ يخالف عنوانه.
   */
  standardLayout: boolean;
  /** يُسلَّم للعميل كمستند ضريبيّ نظاميّ؟ */
  printable: boolean;
  /** يُطبع منه شيء أصلاً؟ (المُبطل والمعلَّق: لا). */
  canPrint: boolean;
  /** صندوق تنبيه على الورقة نفسها — null فلا صندوق. */
  notice: string | null;
  /** علامة مائية للبروفة (بيئة محاكاة الهيئة). */
  watermark: string | null;
  /** نصّ زرّ المشاركة/الطباعة في شاشة النتيجة. */
  shareLabel: string;
  /** نصّ التأكيد أعلى شاشة النتيجة. */
  confirmText: string;
}

export interface ZatcaPrintFacts {
  /** مرتجع المرحلة الأولى (`type === 'RETURN'`) — عنوانه اليوم «إشعار دائن مرتجع». */
  isReturn?: boolean;
  /** للمشتري رقم ضريبي ⇒ قياسية في تصنيف المرحلة الأولى. */
  buyerHasTaxNumber?: boolean;
  /** شركة سعودية؟ تصنيف «مبسّطة/ضريبية» مطلبٌ سعوديّ لا يُطبع لغيرها. */
  saudi?: boolean;
}

export const REHEARSAL_WATERMARK = 'نسخة تجريبية — بيئة محاكاة الهيئة، ليست فاتورة ضريبية';
export const DELIVERY_NOTE_TITLE = 'سند تسليم — ليست فاتورة ضريبية';

/** كل نصوص القرار — يحرس اختبار القاموس أنّ لكلّ نصّ ترجماته الأربع. */
export const ZATCA_PRINT_PHRASES: readonly string[] = Object.freeze([
  'إشعار دائن مرتجع', 'فاتورة', 'فاتورة ضريبية مبسطة', 'فاتورة ضريبية', 'إشعار دائن', 'إشعار مدين',
  DELIVERY_NOTE_TITLE, 'مستند ملغى — لا يعتمد للخصم الضريبي', 'مستند بانتظار اعتماد الهيئة',
  'رمز الاستجابة السريعة للفاتورة الضريبية', 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك',
  REHEARSAL_WATERMARK, 'المبلغ المستحق شامل الضرائب',
  'سلمت البضاعة وبانتظار اعتماد الهيئة وتصلك الفاتورة الضريبية المعتمدة بعد الاعتماد',
  'أبطل هذا المستند فلا يعتمد لخصم ضريبة المدخلات',
  'لم تحسم الهيئة هذا المستند بعد فلا يسلم منه مستند ضريبي',
  'اعتمدت الهيئة الفاتورة ولم تصل نسختها المعتمدة راجع الإدارة قبل التسليم',
  'مشاركة / حفظ PDF', 'مشاركة / حفظ سند التسليم', 'تم الإصدار بنجاح',
  'صدر المستند وبانتظار اعتماد الهيئة', 'المستند مبطل لدى الهيئة',
]);

/** عنوان المرحلة الأولى — النصّ نفسه الذي تطبعه القوالب اليوم، حرفاً بحرف. */
export function phase1Title(f: ZatcaPrintFacts): string {
  if (f.isReturn) return 'إشعار دائن مرتجع';
  if (f.saudi === false) return 'فاتورة';
  return f.buyerHasTaxNumber ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة';
}

function phase2Title(v: ZatcaDocView): string {
  if (v.documentKind === 'CREDIT_NOTE') return 'إشعار دائن';
  if (v.documentKind === 'DEBIT_NOTE') return 'إشعار مدين';
  return v.subtype === '02' ? 'فاتورة ضريبية مبسطة' : 'فاتورة ضريبية';
}

/** المُبطلة: لا ورقة ضريبية بحال. */
const VOIDED: readonly ZatcaMirrorStatus[] = Object.freeze(['rejected', 'withdrawn'] as ZatcaMirrorStatus[]);

const PHASE1: Omit<ZatcaPrintDecision, 'title'> = Object.freeze({
  phase: 1,
  kind: 'phase1',
  qr: Object.freeze({ source: 'phase1', value: null, caption: 'رمز الاستجابة السريعة للفاتورة الضريبية' }),
  showTaxBreakdown: true,
  standardLayout: false,
  printable: true,
  canPrint: true,
  notice: null,
  watermark: null,
  shareLabel: 'مشاركة / حفظ PDF',
  confirmText: 'تم الإصدار بنجاح',
} as Omit<ZatcaPrintDecision, 'title'>);

/**
 * قرار الطباعة. `v === null` (المرحلة الأولى) ⇒ سلوك اليوم بلا استثناء واحد — وهو الفرع الذي يمرّ به كلّ من لم يُفعَّل.
 */
export function zatcaPrintDecision(facts: ZatcaPrintFacts, v: ZatcaDocView | null | undefined): ZatcaPrintDecision {
  if (!v) {
    return {
      ...PHASE1,
      qr: { ...PHASE1.qr },
      title: phase1Title(facts),
      // المرحلة الأولى: التصنيف من رقم المشتري الضريبي كما اليوم حرفاً بحرف
      standardLayout: !!facts.buyerHasTaxNumber,
    };
  }

  const watermark = v.mode === 'rehearsal' ? REHEARSAL_WATERMARK : null;
  // تصنيف الورقة من الخادم وحده في المرحلة الثانية — لا من رقم المشتري الضريبي
  const base = { phase: 2 as const, watermark, standardLayout: v.subtype === '01' };

  if (v.mirror !== null && VOIDED.includes(v.mirror)) {
    return {
      ...base,
      kind: 'void',
      title: 'مستند ملغى — لا يعتمد للخصم الضريبي',
      qr: { source: 'none', value: null, caption: null },
      showTaxBreakdown: false,
      printable: false,
      canPrint: false,
      notice: 'أبطل هذا المستند فلا يعتمد لخصم ضريبة المدخلات',
      shareLabel: 'مشاركة / حفظ PDF',
      confirmText: 'المستند مبطل لدى الهيئة',
    };
  }

  if (v.printable) {
    return {
      ...base,
      kind: 'tax',
      title: phase2Title(v),
      /* الرمز من الخادم وحده: للمبسّطة ختمنا وللقياسية رمز الهيئة بعد الاعتماد (status.ts: mirrorQrOf).
       * والتعليق تابعٌ للمرآة لا للنوع: القياسية بعد إيقاف الاعتماد (٣٠٣) تُبلَّغ ورمزها **ختمنا** لا رمز
       * اعتمدته الهيئة — فكتابة «معتمد من الهيئة» عليها ادّعاءُ اعتمادٍ لم يقع. */
      qr: {
        source: v.qr ? 'stamped' : 'none',
        value: v.qr,
        caption: v.mirror === 'cleared' || v.mirror === 'cleared_warn'
          ? 'رمز الفاتورة المعتمد من هيئة الزكاة والضريبة والجمارك'
          : 'رمز الاستجابة السريعة للفاتورة الضريبية',
      },
      showTaxBreakdown: true,
      printable: true,
      canPrint: true,
      notice: null,
      shareLabel: 'مشاركة / حفظ PDF',
      confirmText: 'تم الإصدار بنجاح',
    };
  }

  // قياسية لم تُعتمد بعد والبضاعة خرجت: سند تسليم (D5). الإشعارات لا سند تسليم لها — لا بضاعة تُسلَّم بها.
  const isInvoice = v.documentKind === null || v.documentKind === 'INVOICE';
  if (v.subtype === '01' && isInvoice) {
    return {
      ...base,
      kind: 'deliveryNote',
      title: DELIVERY_NOTE_TITLE,
      qr: { source: 'none', value: null, caption: null },
      showTaxBreakdown: false,
      printable: false,
      canPrint: true,
      notice: v.mirror === 'cleared_no_xml'
        ? 'اعتمدت الهيئة الفاتورة ولم تصل نسختها المعتمدة راجع الإدارة قبل التسليم'
        : 'سلمت البضاعة وبانتظار اعتماد الهيئة وتصلك الفاتورة الضريبية المعتمدة بعد الاعتماد',
      shareLabel: 'مشاركة / حفظ سند التسليم',
      confirmText: 'صدر المستند وبانتظار اعتماد الهيئة',
    };
  }

  return {
    ...base,
    kind: 'pending',
    title: 'مستند بانتظار اعتماد الهيئة',
    qr: { source: 'none', value: null, caption: null },
    showTaxBreakdown: false,
    printable: false,
    canPrint: false,
    notice: 'لم تحسم الهيئة هذا المستند بعد فلا يسلم منه مستند ضريبي',
    shareLabel: 'مشاركة / حفظ PDF',
    confirmText: 'صدر المستند وبانتظار اعتماد الهيئة',
  };
}
