import { AgingReportView } from './parts/PartnerReportParts';

/**
 * **أعمار الذمم المدينة** من الدفاتر («ربط الدفاتر» L8، عقد §6.2 و§6.4، Odoo Aged Receivable): البنود المفتوحة على حسابات
 * الذمم (AR) بعد المطابقات الجزئية، بأعمدة الأيام حسب الاستحقاق أو تاريخ المستند، والأرصدة الدائنة غير المخصّصة سالبة.
 * في الدفاتر المربوطة يساوي عمود كل عميل متبقّي فواتيره التشغيلي (D8 للإشعار الدائن).
 */
export default function AgedReceivablePage() {
  return <AgingReportView kind="AR" />;
}
