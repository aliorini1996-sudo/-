import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Info, Pencil, Plus, Trash2 } from 'lucide-react';
import { priceListApi, productApi } from '../../api/client';
import type { PriceListRule } from '../../types';
import { useTr } from '../../i18n/strings';
import { activeLocale } from '../../utils/format';
import { todayLocal } from '../../lib/shelfLife';
import { RULE_FORM_DISCARD_ASK, priceRulesOf, ruleSummaryText, ruleTimingOf } from '../../lib/priceListEditor';
import ConfirmDialog from '../ConfirmDialog';
import PriceRuleForm from './PriceRuleForm';

/**
 * تبويب «القواعد» في محرّر القائمة (طلب المالك ٥ نوفمبر ٢٠٢٦): قواعد القائمة بملخّصٍ بلغة المالك («خصم 10% على فئة العصائر ·
 * من 10 كرتون · 1–30 نوفمبر») ووسم «انتهت/لم تبدأ بعد»، و«إضافة قاعدة» ونموذج التعديل في مكان صفّها، والحذف بتأكيد.
 * بعد كل كتابة: قواعد القائمة وعدّاداتها، وقواعد التسعير في فاتورة الإدارة (['price-list-rules'])، وأصنافها (['products-all']).
 * نموذجٌ فيه ما لم يُحفظ: فتح غيره يسأل أولاً، والأب يُبلَّغ (onDirtyChange) فيسأل قبل الرجوع وتبديل التبويب والإغلاق. والتركيز
 * يعود بعد الحفظ أو الإلغاء إلى الزرّ الذي فتح النموذج («إضافة قاعدة» أو «تعديل» صفّه).
 */
type Err = { response?: { data?: { message?: string } } };
const serverMsg = (e: unknown): string | undefined => (e as Err)?.response?.data?.message;

export default function PriceListRulesTab({ listId, onDirtyChange }: { listId: string; onDirtyChange?: (dirty: boolean) => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const rulesQ = useQuery({
    queryKey: ['price-list-rules-of', listId],
    queryFn: async () => priceRulesOf((await priceListApi.listRules(listId)).data.data),
  });
  const { data: categories } = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => { const res = await productApi.categories(); return res.data.data as { id: string; name: string }[]; },
  });
  const rules = rulesQ.data ?? [];
  const [editing, setEditing] = useState<PriceListRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<PriceListRule | null>(null);
  const afterWrite = () => {
    qc.invalidateQueries({ queryKey: ['price-list-rules-of', listId] });
    qc.invalidateQueries({ queryKey: ['price-lists'] });
    qc.invalidateQueries({ queryKey: ['price-list-rules'] });
    qc.invalidateQueries({ queryKey: ['products-all'] });
  };
  /** ٤٠٩ «تغيّرت وحدات الصنف» في النموذج: قواعد القائمة من الخادم الآن (بوحدات أصنافها الحالية) — وتُردّ للنموذج */
  const refetchRules = async (): Promise<PriceListRule[]> => {
    await qc.invalidateQueries({ queryKey: ['price-list-rules-of', listId] });
    return qc.getQueryData<PriceListRule[]>(['price-list-rules-of', listId]) ?? [];
  };
  const remove = useMutation({
    mutationFn: (id: string) => priceListApi.removeRule(id),
    onSuccess: () => { setDeleting(null); afterWrite(); toast.success(tr('حذفت القاعدة')); },
    onError: (e) => { setDeleting(null); afterWrite(); toast.error(serverMsg(e) ? tr(serverMsg(e) as string) : tr('تعذر الحذف')); },
  });

  // ─── ما لم يُحفظ في النموذج المفتوح، والتركيز ───
  const formDirty = useRef(false);
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  const formDirtyChange = (d: boolean) => { formDirty.current = d; dirtyCb.current?.(d); };
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const editBtns = useRef(new Map<string, HTMLButtonElement>());
  /** الزرّ الذي فتح النموذج ('new' أو معرّف القاعدة) — يعود إليه التركيز حين يُغلق */
  const returnTo = useRef<string | null>(null);
  const open = (target: PriceListRule | 'new') => {
    if (editing !== null && formDirty.current && !window.confirm(tr(RULE_FORM_DISCARD_ASK))) return;
    returnTo.current = target === 'new' ? 'new' : target.id;
    setEditing(target);
  };
  const close = () => setEditing(null);
  useEffect(() => {
    if (editing !== null || !returnTo.current) return;
    const back = returnTo.current;
    returnTo.current = null;
    (back === 'new' ? addBtnRef.current : editBtns.current.get(back) ?? addBtnRef.current)?.focus();
  }, [editing]);

  const fmtNum = (n: number) => {
    try { return new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 4 }).format(n); } catch { return String(n); }
  };
  const summary = (r: PriceListRule) => ruleSummaryText(r, tr, { fmtNum, locale: activeLocale() });
  const today = todayLocal();
  const form = (rule: PriceListRule | null) => (
    <PriceRuleForm key={rule?.id ?? 'new'} listId={listId} rule={rule} categories={categories ?? []}
      onSaved={() => { close(); afterWrite(); }} onCancel={close} onStale={refetchRules} onDirtyChange={formDirtyChange} />
  );

  return (
    <div className="space-y-3" data-price-list-rules="">
      <div className="flex items-start gap-2 rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-[11px] text-[#6E6557] leading-relaxed">
        <Info size={14} className="shrink-0 mt-0.5 text-[#E15A30]" />
        <span>{tr('القاعدة الأخص تغلب: الصنف ثم الفئة ثم كل الأصناف، ثم الأعلى كمية، ثم العرض المؤقت، وسعر العميل الخاص يغلب القائمة دائما')}</span>
      </div>

      {editing === 'new' ? form(null) : (
        <button ref={addBtnRef} type="button" className="btn-primary !py-1.5 !px-3 text-xs" onClick={() => open('new')} data-add-price-rule="">
          <Plus size={14} /> {tr('إضافة قاعدة')}
        </button>
      )}

      {rulesQ.isLoading ? (
        <p className="p-6 text-center text-sm text-gray-400">{tr('جار التحميل')}</p>
      ) : rulesQ.isError ? (
        <p className="p-6 text-center text-sm text-red-500">{tr('تعذر التحميل')}</p>
      ) : rules.length === 0 ? (
        editing === 'new' ? null : (
          <p className="p-6 text-center text-sm text-gray-400 leading-relaxed">
            {tr('لا قواعد في هذه القائمة بعد: خصم أو زيادة بنسبة على فئة أو على كل الأصناف، أو سعر ثابت من كمية معينة أو لفترة عرض')}
          </p>
        )
      ) : (
        <div className="divide-y divide-[#F1EBDF] border border-[#E9E1D3] rounded-xl bg-white">
          {rules.map(r => (editing !== 'new' && editing?.id === r.id ? (
            <div key={r.id} className="p-2">{form(r)}</div>
          ) : (
            <div key={r.id} className="p-3.5 flex items-start gap-3 flex-wrap" data-price-rule-row="">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-semibold text-[#1F1A13] leading-relaxed break-words">{summary(r)}</p>
                {(() => {
                  const t = ruleTimingOf(r, today);
                  if (t === 'expired') return <span className="badge-inactive mt-1">{tr('منتهية')}</span>;
                  if (t === 'upcoming') return <span className="badge mt-1 bg-[#FAEFD8] text-[#B8860B]">{tr('لم تبدأ بعد')}</span>;
                  return null;
                })()}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" className="btn-secondary !py-1.5 !px-3 text-xs" onClick={() => open(r)}
                  ref={el => { if (el) editBtns.current.set(r.id, el); else editBtns.current.delete(r.id); }}
                  aria-label={`${tr('تعديل')}: ${summary(r)}`}><Pencil size={13} /> {tr('تعديل')}</button>
                <button type="button" className="p-2 rounded-lg text-red-500 hover:bg-red-50" title={tr('حذف')} aria-label={`${tr('حذف')}: ${summary(r)}`}
                  disabled={remove.isPending} onClick={() => setDeleting(r)}><Trash2 size={15} /></button>
              </div>
            </div>
          )))}
        </div>
      )}

      {deleting && (
        <ConfirmDialog danger title={tr('حذف القاعدة')} confirmLabel={tr('حذف')} loading={remove.isPending} message={summary(deleting)}
          onConfirm={() => remove.mutate(deleting.id)} onClose={() => { if (!remove.isPending) setDeleting(null); }} />
      )}
    </div>
  );
}
