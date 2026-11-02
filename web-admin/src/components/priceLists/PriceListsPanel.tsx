import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Tags, Plus, Pencil, Trash2, ArrowUp, ArrowDown, Check, X } from 'lucide-react';
import { priceListApi } from '../../api/client';
import type { PriceList } from '../../types';
import { useTr } from '../../i18n/strings';
import { DEFAULT_BASE_PRICE_LABEL, PRICE_LIST_NAME_MAX, priceListInUseMessage, priceListNameProblem, priceListsOf } from '../../lib/priceLists';

/**
 * لوحة «أنواع الأسعار» في صفحة المنتجات — زرّ «أنواع الأسعار» (كانت تبويباً في إعدادات الشركة حتى ٢ نوفمبر ٢٠٢٦؛ طلب المالك: رقاقات تبديلٍ بأسماء تختارها الشركة — سعر الجملة، سعر التجزئة…).
 * لكل نوعٍ سعرٌ في بطاقة الصنف (بالوحدة الرئيسية)، ولكل عميلٍ نوعه في ملفه تُسعَّر به فواتيره، والمندوب يبدّله على الفاتورة
 * بصلاحية «تبديل نوع السعر». الرقاقة الأولى السعر الافتراضي نفسه (سعر الصنف) باسمٍ يُغيَّر هنا. والكتابة لمن يملك صلاحية الأصناف
 * (الخادم يحكم)، والنوع الذي عليه عملاء لا يُحذف (409 PRICE_LIST_IN_USE) حتى يُنقلوا إلى نوعٍ آخر — ولا الذي هو نوعُ مندوبٍ
 * افتراضيٌّ أو من أنواعه المسموحة (repsCount في الردّ نفسه).
 */
type Err = { response?: { data?: { message?: string; code?: string; customersCount?: number; repsCount?: number } } };
const errMsg = (e: unknown, fallback: string) => (e as Err)?.response?.data?.message || fallback;

export default function PriceListsPanel() {
  const tr = useTr();
  const qc = useQueryClient();
  const listsQ = useQuery({ queryKey: ['price-lists'], queryFn: async () => priceListsOf((await priceListApi.list()).data.data) });
  const lists = listsQ.data?.lists ?? [];
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  // اسم الرقاقة الأولى: فارغ = «السعر الأساسي» (null في الخادم)
  const [label, setLabel] = useState('');
  const savedLabel = listsQ.data?.basePriceLabel ?? '';
  useEffect(() => { setLabel(savedLabel); }, [savedLabel]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['price-lists'] });

  const create = useMutation({
    mutationFn: (name: string) => priceListApi.create(name),
    onSuccess: () => { setNewName(''); refresh(); toast.success(tr('أضيف نوع السعر')); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => priceListApi.update(v.id, { name: v.name }),
    onSuccess: () => { setEditing(null); refresh(); toast.success(tr('تم الحفظ')); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });
  // الترتيب: الصفوف بترتيبها الجديد وتُكتب sortOrder لما تغيّر وحده — والقائمة تُحدَّث ولو فشل أحدها في الوسط
  const reorder = useMutation({
    mutationFn: async (next: PriceList[]) => {
      for (const [i, l] of next.entries()) if (l.sortOrder !== i) await priceListApi.update(l.id, { sortOrder: i });
    },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
    onSettled: () => refresh(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => priceListApi.remove(id),
    onSuccess: () => { refresh(); toast.success(tr('تم حذف نوع السعر')); },
    // ٤٠٩ PRICE_LIST_IN_USE: بعدد العملاء والمناديب الذين عليه مترجماً — يُنقلون إلى نوعٍ آخر أولاً (وغيرها رسالة الخادم)
    onError: (e) => {
      refresh();
      toast.error(priceListInUseMessage((e as Err)?.response?.data, tr) ?? errMsg(e, tr('تعذر الحذف')), { duration: 7000 });
    },
  });
  const saveLabel = useMutation({
    mutationFn: (v: string | null) => priceListApi.setBaseLabel(v),
    onSuccess: () => { refresh(); toast.success(tr('تم الحفظ')); },
    onError: (e) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= lists.length || reorder.isPending) return;
    const next = [...lists];
    [next[i], next[j]] = [next[j], next[i]];
    reorder.mutate(next);
  };
  const submitLabel = () => {
    const v = label.trim();
    if (v && priceListNameProblem(v)) { toast.error(tr(priceListNameProblem(v)!)); return; }
    saveLabel.mutate(v || null);
  };
  const submitRename = () => {
    if (!editing) return;
    const problem = priceListNameProblem(editing.name);
    if (problem) { toast.error(tr(problem)); return; }
    rename.mutate({ id: editing.id, name: editing.name.trim() });
  };

  return (
    <div className="space-y-5">
      <div className="card space-y-4">
        <div>
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Tags size={18} className="text-[#E15A30]" /> {tr('أنواع الأسعار')}</h2>
          <p className="text-sm text-[#6E6557] mt-1 leading-relaxed">
            {tr('سعر الجملة وسعر التجزئة وغيرها بأسماء تختارها: لكل صنف سعر في كل نوع من بطاقته ولكل عميل نوع سعر في ملفه تسعر به فواتيره والمندوب يبدله على الفاتورة بصلاحية تبديل نوع السعر')}
          </p>
        </div>

        {/* الرقاقة الأولى: السعر الافتراضي للصنف — الاسم وحده يتغيّر */}
        <div className="rounded-xl border border-[#F1EBDF] bg-[#FAF7F0] p-3.5 space-y-2">
          <label className="label mb-0">{tr('اسم السعر الافتراضي')}</label>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); submitLabel(); }}>
            <input className="input flex-1" maxLength={PRICE_LIST_NAME_MAX} value={label} placeholder={tr(DEFAULT_BASE_PRICE_LABEL)}
              onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="btn-secondary shrink-0 disabled:opacity-60" disabled={saveLabel.isPending || label.trim() === savedLabel}>
              {tr('حفظ')}
            </button>
          </form>
          <p className="text-xs text-[#9A8F7E]">{tr('هو سعر الصنف نفسه وتسعر به فواتير العميل الذي لا نوع له والفارغ يعيد الاسم الافتراضي')}</p>
        </div>

        {/* الزرّ فعّالٌ بلا اسم (كإضافة الفريق): يُقال الناقص بدل الصمت */}
        <form className="flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          const problem = priceListNameProblem(newName);
          if (problem) { toast.error(tr(problem)); newNameRef.current?.focus(); return; }
          create.mutate(newName.trim());
        }}>
          <input ref={newNameRef} className="input flex-1" placeholder={tr('مثل سعر الجملة')} value={newName} maxLength={PRICE_LIST_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" className="btn-primary shrink-0 disabled:opacity-60" disabled={create.isPending}><Plus size={16} /> {tr('إضافة نوع سعر')}</button>
        </form>

        {listsQ.isLoading ? (
          <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
        ) : listsQ.isError ? (
          <p className="text-center text-red-500 text-sm py-6">{tr('تعذر تحميل أنواع الأسعار')}</p>
        ) : lists.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-6">{tr('لا توجد أنواع أسعار بعد والفواتير تسعر بسعر الصنف وحده')}</p>
        ) : (
          <div className="divide-y divide-[#F1EBDF] border border-[#F1EBDF] rounded-xl">
            {lists.map((l, i) => (
              <div key={l.id} className="p-3.5 flex items-center gap-3 flex-wrap">
                {editing?.id === l.id ? (
                  <form className="flex items-center gap-1.5 flex-1 min-w-0" onSubmit={(e) => { e.preventDefault(); submitRename(); }}>
                    <input autoFocus className="input flex-1 !py-1.5" maxLength={PRICE_LIST_NAME_MAX} value={editing.name}
                      onChange={(e) => setEditing({ id: l.id, name: e.target.value })} />
                    <button type="submit" disabled={rename.isPending} className="p-2 rounded-lg text-[#1E7A52] hover:bg-green-50" title={tr('حفظ')}><Check size={15} /></button>
                    <button type="button" onClick={() => setEditing(null)} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100" title={tr('إلغاء')}><X size={15} /></button>
                  </form>
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-[#1F1A13] truncate">{l.name}</p>
                    <p className="text-xs text-[#6E6557] mt-0.5">{l.customersCount ?? 0} {tr('عميل')}</p>
                  </div>
                )}
                {editing?.id !== l.id && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending} title={tr('تحريك لأعلى')}
                      className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-30"><ArrowUp size={15} /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === lists.length - 1 || reorder.isPending} title={tr('تحريك لأسفل')}
                      className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-30"><ArrowDown size={15} /></button>
                    <button type="button" onClick={() => setEditing({ id: l.id, name: l.name })} className="btn-secondary !py-1.5 !px-3 text-xs"><Pencil size={13} /> {tr('تعديل')}</button>
                    {/* نوعٌ عليه عملاء لا يُحذف (كالفريق الذي عليه مستندات) — والخادم يردّه 409 لو سبقه عميلٌ أُسند بعد التحميل،
                        أو كان نوع مندوبٍ (افتراضيّه أو من المسموح له) فتقول رسالته عددهم */}
                    {(l.customersCount ?? 0) === 0 && (
                      <button type="button" disabled={remove.isPending} title={tr('حذف')}
                        onClick={() => { if (window.confirm(`${tr('حذف نوع السعر')} «${l.name}»؟`)) remove.mutate(l.id); }}
                        className="p-2 rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-[#9A8F7E]">{tr('نوع السعر الذي عليه عملاء أو مناديب لا يحذف حتى تنقلهم إلى نوع آخر من ملفاتهم وسعر الصنف في النوع يكتب من بطاقة الصنف')}</p>
      </div>
    </div>
  );
}
