import { useQuery } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import { vanStockApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { useAccountingOn } from './AccountingGate';
import { formatNumber } from '../utils/format';
import { REP_DELETE_VAN, fillVanLeft, vanLeftover } from '../lib/repDeleteVan';

/**
 * تحذير حوار حذف المندوب: كم بقي في سيارته، وأنّ سجلّ تحميلاتها يبقى.
 *
 * تحذيرٌ لا حجب — زرّ الحذف لا ينتظر هذا الطلب (قرار المالك: الحذف يمضي).
 * والطلب خلف حارسَي مسار /van-stock نفسيهما (النظام المحاسبي وصلاحية مخزون
 * السيارة): بلا صلاحية المخزون يُعرض سطر السجلّ وحده بلا رقم لا لافتة خطأ،
 * وبلا النظام المحاسبي لا يُعرض شيء (لا مستودع أصلاً).
 */
export default function RepVanStockNote({ repId, compact = false }: { repId: string; compact?: boolean }) {
  const tr = useTr();
  const user = useAuthStore(s => s.user);
  const { on, ready } = useAccountingOn();
  const allowed = ready && on && user?.canManageVanStock !== false;
  const q = useQuery({
    queryKey: ['rep-delete-van', repId],
    queryFn: async () => vanLeftover((await vanStockApi.current(repId)).data?.data),
    enabled: allowed,
    retry: false,
    staleTime: 0, // رقمٌ يُقرأ قبل حذفٍ لا رجعة فيه — لا من ذاكرةٍ قديمة
  });
  const left = allowed ? q.data : undefined;
  // شركةٌ النظامُ المحاسبي مطفأٌ لها: لا مخزون سيارات ولا مستودع — سطرٌ عنهما يُربك ولا يُخبر
  if (ready && !on) return null;
  return (
    <div className={`mt-3 rounded-xl bg-[#FDF6E7] border border-[#F0E0BC] px-3 py-2 text-start leading-relaxed text-[#9A5B1E] ${compact ? 'text-[11.5px]' : 'text-xs'}`}>
      {allowed && q.isLoading && <p>{tr(REP_DELETE_VAN.checking)}</p>}
      {left && left.products > 0 && (
        <>
          <p className="font-bold flex items-start gap-1.5">
            <Truck size={14} className="flex-shrink-0 mt-0.5" />
            <span>{fillVanLeft(tr(REP_DELETE_VAN.left), left, formatNumber)}</span>
          </p>
          <p className="mt-1">{tr(REP_DELETE_VAN.unloadFirst)}</p>
        </>
      )}
      {left && left.products === 0 && <p>{tr(REP_DELETE_VAN.empty)}</p>}
      <p className={left || (allowed && q.isLoading) ? 'mt-1' : ''}>{tr(REP_DELETE_VAN.history)}</p>
    </div>
  );
}
