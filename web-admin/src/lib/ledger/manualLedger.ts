import { useQuery } from '@tanstack/react-query';
import { ledgerConfigApi, ledgerKeys } from '../../api/ledgerConfig';
import { isManualLedger } from './bookMode';

export { isManualLedger };

/**
 * الدفاتر اليدوية المستقلة (أمر المالك، ٢٨ سبتمبر ٢٠٢٦): «اجعل الدفاتر مفصولة بشكل كامل عن المبيعات والمخزون وكل شيء، وكل شيء فيها
 * يدوي». الدفاتر اليدوية (MANUAL) لا يدخلها شيءٌ من التشغيل آلياً، قديماً ولا جديداً — فلا شاشات لمستندات التشغيل
 * ولا مزامنة ولا ترحيل تاريخي. قبل التفعيل تُعامَل كذلك (كل إعداد جديد يدويّ). التفعيلات السابقة (OPENING/FULL_HISTORY)
 * والمربوطة بالنظام (LINKED، «ربط الدفاتر») ليست يدوية: شاشاتها كاملة. الحكم من lib/ledger/bookMode.ts وحده.
 */
/** من ذاكرة استعلام الحالة نفسها (`ledgerKeys.status`) — بلا طلب زائد. أثناء التحميل: يدوية (لا وميض لشاشات التشغيل) */
export function useManualLedger(): boolean {
  const q = useQuery({
    queryKey: ledgerKeys.status,
    queryFn: async () => (await ledgerConfigApi.status()).data.data,
    staleTime: 60_000,
  });
  return isManualLedger(q.data as { activatedAt?: string | null; setupMethod?: string | null } | undefined);
}
