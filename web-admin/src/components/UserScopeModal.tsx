import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, Truck, X, Search, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyUserApi, customerApi, salesRepApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { backdropClose } from '../lib/backdropClose';

/**
 * نطاق مستخدم الشركة — تحديد العملاء والمناديب الذين يراهم.
 *
 * نظير «إسناد العملاء» للمناديب، لكن على مستوى الإدارة وبقائمتين مستقلّتين
 * (قرار المالك). يتّبع النمط نفسه:
 *  - **الحفظ بالفروقات** لا بالاستبدال الكامل: الواجهة تعرض صفحة واحدة من
 *    العملاء، والاستبدال يمحو ما لم يظهر فيها.
 *  - **البحث على الخادم** لا محلياً: يصل لأي عميل مهما كبرت القائمة.
 *  - لا يُحفظ شيء قبل نجاح تحميل الأساس، وإلا ظُنّ المستخدم بلا نطاق
 *    فأُرسلت إزالات خاطئة.
 */

const PICKER_LIMIT = 100;

interface Pick { id: string; name: string; businessName?: string | null; phone?: string | null; code?: string | null }

export default function UserScopeModal({ userId, userName, onClose }: {
  userId: string; userName: string; onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'customers' | 'reps'>('customers');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // فروقات مستقلّة لكل قائمة
  const [addC, setAddC] = useState<Set<string>>(new Set());
  const [remC, setRemC] = useState<Set<string>>(new Set());
  const [addR, setAddR] = useState<Set<string>>(new Set());
  const [remR, setRemR] = useState<Set<string>>(new Set());

  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  useEffect(() => { setQ(''); setDq(''); }, [tab]);

  const scopeQ = useQuery({
    queryKey: ['user-scope', userId],
    queryFn: async () => (await companyUserApi.scope(userId)).data.data as {
      scopeEnabled: boolean; customerIds: string[]; salesRepIds: string[];
    },
    staleTime: 0, refetchOnMount: 'always',
  });
  useEffect(() => { if (scopeQ.data && enabled === null) setEnabled(scopeQ.data.scopeEnabled); }, [scopeQ.data, enabled]);

  const custQ = useQuery({
    queryKey: ['customers', 'scope-picker', dq],
    queryFn: async () => (await customerApi.list({ search: dq, limit: PICKER_LIMIT })).data.data as Pick[],
    enabled: tab === 'customers',
  });
  const repsQ = useQuery({
    queryKey: ['reps', 'scope-picker', dq],
    queryFn: async () => (await salesRepApi.list({ search: dq, limit: 500 })).data.data as Pick[],
    enabled: tab === 'reps',
  });

  const baseC = new Set(scopeQ.data?.customerIds ?? []);
  const baseR = new Set(scopeQ.data?.salesRepIds ?? []);
  const isOn = (id: string, base: Set<string>, add: Set<string>, rem: Set<string>) =>
    (base.has(id) && !rem.has(id)) || add.has(id);
  const countOf = (base: Set<string>, add: Set<string>, rem: Set<string>) =>
    base.size - [...rem].filter(i => base.has(i)).length + [...add].filter(i => !base.has(i)).length;

  const toggle = (
    id: string, base: Set<string>, add: Set<string>, rem: Set<string>,
    setAdd: (f: (s: Set<string>) => Set<string>) => void, setRem: (f: (s: Set<string>) => Set<string>) => void,
  ) => {
    if (isOn(id, base, add, rem)) {
      if (base.has(id)) setRem(s => new Set(s).add(id));
      else setAdd(s => { const n = new Set(s); n.delete(id); return n; });
    } else {
      if (rem.has(id)) setRem(s => { const n = new Set(s); n.delete(id); return n; });
      else setAdd(s => new Set(s).add(id));
    }
  };

  const save = useMutation({
    mutationFn: () => {
      // نُرسل القائمة النهائية المحسوبة من الأساس + الفروقات
      const finalC = [...new Set([...[...baseC].filter(i => !remC.has(i)), ...addC])];
      const finalR = [...new Set([...[...baseR].filter(i => !remR.has(i)), ...addR])];
      return companyUserApi.setScope(userId, {
        customerIds: finalC, salesRepIds: finalR, scopeEnabled: enabled ?? false,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-scope', userId] });
      qc.invalidateQueries({ queryKey: ['company-users'] });
      toast.success(tr('حفظ نطاق المستخدم'));
      onClose();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });

  const list = tab === 'customers' ? (custQ.data || []) : (repsQ.data || []);
  const loading = tab === 'customers' ? custQ.isLoading : repsQ.isLoading;
  const nC = countOf(baseC, addC, remC);
  const nR = countOf(baseR, addR, remR);

  return (
    <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[88vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2">
            <ShieldCheck size={18} className="text-[#E15A30]" /> {tr('نطاق المستخدم')} — {userName}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-3 overflow-y-auto">
          {/* المفتاح: مُطفأ ⇒ رؤية كاملة (السلوك الافتراضي لكل المستخدمين) */}
          <label className="flex items-start gap-2.5 p-3 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={enabled ?? false}
              onChange={e => setEnabled(e.target.checked)} />
            <span className="text-sm">
              <b className="text-[#1F1A13]">{tr('تقييد نطاق هذا المستخدم')}</b>
              <span className="block text-[11px] text-[#6E6557] mt-0.5">
                {enabled
                  ? tr('مفعل لا يرى إلا العملاء والمناديب المحددين أدناه ولا يستطيع إسناد غيرهم')
                  : tr('مطفأ يرى كل عملاء الشركة ومناديبها السلوك الافتراضي')}
              </span>
            </span>
          </label>

          {enabled && (
            <>
              <div className="flex rounded-xl overflow-hidden border border-[#E9E1D3] text-sm font-semibold">
                <button onClick={() => setTab('customers')}
                  className={`flex-1 py-2 flex items-center justify-center gap-1.5 ${tab === 'customers' ? 'bg-[#E15A30] text-white' : 'bg-white text-[#6E6557]'}`}>
                  <Users size={14} /> {tr('العملاء')} ({nC})
                </button>
                <button onClick={() => setTab('reps')}
                  className={`flex-1 py-2 flex items-center justify-center gap-1.5 ${tab === 'reps' ? 'bg-[#E15A30] text-white' : 'bg-white text-[#6E6557]'}`}>
                  <Truck size={14} /> {tr('المناديب')} ({nR})
                </button>
              </div>

              <div className="relative">
                <Search size={15} className="absolute top-2.5 start-3 text-gray-400" />
                <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9"
                  placeholder={tab === 'customers' ? tr('ابحث عن عميل') : tr('ابحث عن مندوب')} />
              </div>

              {scopeQ.isLoading ? (
                <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
              ) : (
                <div className="border border-[#F1EBDF] rounded-xl divide-y divide-[#F1EBDF] max-h-64 overflow-y-auto">
                  {loading ? (
                    <p className="text-center text-gray-400 text-xs py-6">{tr('جار البحث')}</p>
                  ) : list.length === 0 ? (
                    <p className="text-center text-gray-400 text-xs py-6">{tr('لا نتائج')}</p>
                  ) : list.map(item => {
                    const on = tab === 'customers'
                      ? isOn(item.id, baseC, addC, remC)
                      : isOn(item.id, baseR, addR, remR);
                    return (
                      <button key={item.id} type="button"
                        onClick={() => tab === 'customers'
                          ? toggle(item.id, baseC, addC, remC, setAddC, setRemC)
                          : toggle(item.id, baseR, addR, remR, setAddR, setRemR)}
                        className="w-full text-right px-3 py-2.5 flex items-center gap-2.5 hover:bg-[#FAF7F0]">
                        <input type="checkbox" readOnly checked={on} className="pointer-events-none" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-[#1F1A13] truncate">{item.name}</span>
                          <span className="block text-[11px] text-[#9A8F7E] truncate">
                            {[item.code, item.businessName, item.phone].filter(Boolean).join(' · ') || '—'}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-[11px] text-[#9A8F7E]">
                {tr('البحث يشمل كل السجلات لا المعروضة فقط والحفظ يطبق التغييرات دون المساس بما لم تلمسه')}
              </p>
            </>
          )}
        </div>

        <div className="flex gap-3 p-4 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={save.isPending || scopeQ.isLoading}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">{tr('حفظ')}</button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
