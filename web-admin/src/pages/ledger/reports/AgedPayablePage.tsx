import { AgingReportView } from './parts/PartnerReportParts';

/**
 * **أعمار الذمم الدائنة** من الدفاتر («ربط الدفاتر» L8، عقد §6.2 و§6.4، Odoo Aged Payable): البنود المفتوحة على حسابات
 * الموردين (AP) بعد المطابقات الجزئية، والدفعات المقدمة غير المخصّصة سالبة. تمتلئ مع ترحيل فواتير المشتريات ودفعاتها (L6).
 */
export default function AgedPayablePage() {
  return <AgingReportView kind="AP" />;
}
