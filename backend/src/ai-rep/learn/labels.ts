/** حلقة التعلّم — تسميات عربية ثابتة بلا أرقام (بلا استيرادات: تستعملها الأدوات والدروس دون اعتماد دائري). */
import type { ObjectionCode } from './types';

export const OBJECTION_LABEL_AR: Record<ObjectionCode, string> = {
  PRICE: 'السعر مرتفع',
  HAS_SUPPLIER: 'عنده مورّد',
  NO_SHELF_SPACE: 'لا مساحة على الرف',
  NEEDS_CREDIT: 'يريد آجل',
  SLOW_MOVING: 'الصنف لا يمشي عنده',
  DECISION_MAKER_ABSENT: 'صاحب القرار غير موجود',
  WANTS_SAMPLE: 'يريد تجربة أو كمية أقل',
  UNKNOWN_BRAND: 'لا يعرف العلامة',
  TIMING: 'وقت غير مناسب',
  OTHER: 'غير ذلك',
};

/** فترات اليوم بلا أرقام عمداً (تدخل نصوص الدروس). */
export const HOUR_BAND_LABEL_AR = ['الصباح', 'الظهيرة', 'بعد الظهر', 'المساء', 'الليل'];
