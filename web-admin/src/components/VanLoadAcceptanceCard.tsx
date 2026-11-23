import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, PenLine } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { PENDING_LOADS_KEY, PENDING_LOAD_TEXT, pendingErrorText, pendingLoadErrorOf, vanLoadAcceptanceOn } from '../lib/pendingLoads';

/**
 * «اشتراط قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — مفتاحٌ لمدير الشركة غير المقيَّد (الصفحة تُظهره بـ
 * role === 'ADMIN' && !scopeEnabled والمحاسبة مفعّلة، والخادم يحكم: صلاحية إعدادات الشركة، ورفض المقيَّد والمفتاح). يُحفظ فور
 * التبديل بمساره المستقل (companyApi.vanLoadAcceptance → PATCH /api/company/van-load-acceptance) لا مع زرّ الحفظ، ثم يُبطَل
 * ['company']: صفحة مخزون السيارات و/m يقرآن العلم (vanLoadAcceptance) من ردّ /company.
 *
 * مفعّلاً: تحميل الإدارة يُرسل للمندوب فيقبله ويوقّع قبل أن يدخل سيارته. ولا يُطفأ ما دامت تحميلاتٌ بانتظار القبول أو معترضٌ عليها
 * (الخادم 409 VAN_LOAD_ACCEPTANCE_OPEN_LOADS) — فالمفتاح معطّلٌ حينها بعددها وسببه.
 *
 * داخل نموذج الإعدادات العامة (<form>): المفتاح خانة اختيار لا تُرسل النموذج.
 */
export default function VanLoadAcceptanceCard({ company }: { company: unknown }) {
  const tr = useTr();
  const qc = useQueryClient();
  const value = vanLoadAcceptanceOn(company);
  // المفتوحة (PENDING وDISPUTED) — تُقرأ والميزة مفعّلة وحدها: بها يُعرف أن الإيقاف سيُرفض
  const stateQ = useQuery({
    queryKey: ['van-load-acceptance'],
    queryFn: async () => ((await companyApi.vanLoadAcceptance.get()).data?.data ?? null) as { enabled?: boolean; openCount?: number } | null,
    enabled: value,
  });
  const openCount = value ? Number(stateQ.data?.openCount ?? 0) || 0 : 0;
  const save = useMutation({
    mutationFn: (enabled: boolean) => companyApi.vanLoadAcceptance.set(enabled),
    onSuccess: async (_res, on) => {
      await qc.invalidateQueries({ queryKey: ['company'] });
      qc.invalidateQueries({ queryKey: ['van-load-acceptance'] });
      qc.invalidateQueries({ queryKey: [PENDING_LOADS_KEY] });
      toast.success(on ? tr(PENDING_LOAD_TEXT.settingOn) : tr(PENDING_LOAD_TEXT.settingOff));
    },
    onError: (err: unknown) => {
      // تحميلاتٌ مفتوحة ظهرت منذ فُتحت الصفحة (أو الإعداد تغيّر من جهازٍ آخر) ⇒ إعادة القراءة فيتعطّل المفتاح بسببه
      if (pendingLoadErrorOf(err)?.code) {
        qc.invalidateQueries({ queryKey: ['company'] });
        qc.invalidateQueries({ queryKey: ['van-load-acceptance'] });
      }
      toast.error(pendingErrorText(err, tr, 'حدث خطأ في الحفظ'), { duration: 7000 });
    },
  });
  const checked = save.isPending && save.variables !== undefined ? save.variables : value;
  // الإيقاف ممنوعٌ ما دام مفتوحٌ — المفتاح معطّلٌ وتحته السبب (والخادم يرفضه أيضاً)
  const offBlocked = value && openCount > 0;
  return (
    <div className="card" data-van-load-acceptance="">
      <div className="flex items-center gap-3 mb-4 pb-3 border-b border-gray-100">
        <div className="w-11 h-11 bg-[#FBEBE2] rounded-xl flex items-center justify-center">
          <PenLine size={22} className="text-[#E15A30]" />
        </div>
        <p className="font-semibold text-gray-800">{tr(PENDING_LOAD_TEXT.settingTitle)}</p>
      </div>
      <label className={`flex items-center gap-2.5 text-sm text-gray-700 select-none bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-3 py-2.5 ${offBlocked ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}>
        <input type="checkbox" className="w-4 h-4 accent-[#E15A30]" checked={checked} disabled={save.isPending || offBlocked}
          onChange={e => save.mutate(e.target.checked)} />
        {tr(PENDING_LOAD_TEXT.settingTitle)}
      </label>
      <p className="text-[11px] text-[#6E6557] mt-1.5 leading-relaxed">{tr(PENDING_LOAD_TEXT.settingHint)}</p>
      {offBlocked && (
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 px-3 py-2 text-[11px] leading-relaxed flex items-start gap-1.5" role="note">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <span>{tr(PENDING_LOAD_TEXT.settingOpen)} ({openCount.toLocaleString()})</span>
        </div>
      )}
    </div>
  );
}
