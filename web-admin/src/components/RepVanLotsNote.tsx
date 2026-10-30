import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import { companyApi, lotsApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { useAccountingOn } from './AccountingGate';
import { formatNumber } from '../utils/format';
import { lotFlagsOf } from '../lib/lots';
import { REP_DELETE_LOTS, fillVanLots, vanLotsLeft } from '../lib/lotTrackingUi';

/**
 * تحذير حوار حذف المندوب حين «تتبّع اللوط» مفعّل (§٤.١٩): تشغيلاتٌ مسمّاة في سيارته تبقى في «سيارة محذوفة» تُنزَّل لاحقاً من
 * شاشة التتبّع (D30). تحذيرٌ لا حجب — الحذف يمضي دائماً (قرار المالك)، وزرّه لا ينتظر هذا الطلب.
 *
 * الميزة مطفأة أو النظام المحاسبي أو صلاحية مخزون السيارات غائبة ⇒ لا طلب ولا عنصر (§١٠.١). والسيارة بلا تشغيلات ⇒ لا شيء:
 * سطر RepVanStockNote بجواره يقول ما بقي فيها.
 */
export default function RepVanLotsNote({ repId, compact = false }: { repId: string; compact?: boolean }) {
  const tr = useTr();
  const user = useAuthStore(s => s.user);
  const { on, ready } = useAccountingOn();
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { lotTrackingEnabled?: boolean } | null,
    enabled: ready && on,
  });
  const allowed = ready && on && lotFlagsOf(companyQ.data).on && user?.canManageVanStock !== false;
  const q = useQuery({
    queryKey: ['rep-delete-van-lots', repId],
    queryFn: async () => vanLotsLeft((await lotsApi.vanLotBalances(repId)).data?.data),
    enabled: allowed,
    retry: false,
    staleTime: 0, // رقمٌ يُقرأ قبل حذفٍ لا رجعة فيه — لا من ذاكرةٍ قديمة
  });
  const left = allowed ? q.data : undefined;
  if (!left || left.lots === 0) return null;
  return (
    <div className={`mt-2 rounded-xl bg-[#FDF6E7] border border-[#F0E0BC] px-3 py-2 text-start leading-relaxed text-[#9A5B1E] ${compact ? 'text-[11.5px]' : 'text-xs'}`} data-rep-delete-lots="">
      <p className="font-bold flex items-start gap-1.5">
        <Layers size={14} className="flex-shrink-0 mt-0.5" />
        <span>{fillVanLots(tr(REP_DELETE_LOTS), left, formatNumber)}</span>
      </p>
    </div>
  );
}
