import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Tags, Plus, Pencil, Trash2, ArrowUp, ArrowDown, Check, X, ListChecks } from 'lucide-react';
import { priceListApi } from '../../api/client';
import type { PriceList } from '../../types';
import { useTr } from '../../i18n/strings';
import { formatNumber } from '../../utils/format';
import { CASH_ONLY_LABEL, DEFAULT_BASE_PRICE_LABEL, PRICE_LIST_NAME_MAX, priceListInUseMessage, priceListNameProblem, priceListsOf } from '../../lib/priceLists';
import { priceListCountsText } from '../../lib/priceListEditor';
import ConfirmDialog from '../ConfirmDialog';
import PriceListEditor from './PriceListEditor';

/**
 * لوحة «قوائم الأسعار» في صفحة المنتجات — زرّ «قوائم الأسعار» (كانت «أنواع الأسعار» حتى ٥ نوفمبر ٢٠٢٦، وتبويباً في إعدادات
 * الشركة حتى ٢ نوفمبر؛ طلب المالك: رقاقات تبديلٍ بأسماء تختارها الشركة — سعر الجملة، سعر التجزئة…).
 * لكل قائمةٍ «الأسعار والقواعد» (طلب المالك ٥ نوفمبر ٢٠٢٦ على نسق Odoo): جدول أسعار أصنافها الثابتة يُحرَّر في مكانه، وقواعد
 * على صنف أو فئة أو كل الأصناف — سعر ثابت أو خصم/زيادة بنسبة، بحدٍّ أدنى للكمية وفترة صلاحية. ولكل عميلٍ قائمته في ملفه تُسعَّر
 * بها فواتيره، والمندوب يبدّلها على الفاتورة بصلاحية «تبديل قائمة الأسعار». الرقاقة الأولى السعر الافتراضي نفسه (سعر الصنف)
 * باسمٍ يُغيَّر هنا. والكتابة لمن يملك صلاحية الأصناف (الخادم يحكم)، والقائمة التي عليها عملاء لا تُحذف (409 PRICE_LIST_IN_USE)
 * حتى يُنقلوا إلى قائمةٍ أخرى — ولا التي هي قائمةُ مندوبٍ افتراضيّةٌ أو من قوائمه المسموحة (repsCount في الردّ نفسه).
 * كل عمليةٍ تحفظ بنفسها (والمحرّر يحفظ كل سطرٍ عند الخروج منه) — فإغلاق النافذة لا يضيّع شيئاً، إلا نموذج قاعدةٍ لم يُحفظ:
 * يُبلَّغ به الأب (onDirtyChange) فتسأل النافذة قبل الإغلاق.
 * والعدّادات (أصناف القائمة وقواعدها) من GET /price-lists?counts=1 (listWithCounts) بمفتاح ['price-lists', 'counts'] لهذه
 * اللوحة وحدها — بقية الشاشات تقرأ ['price-lists'] بلا عدّادات (قرار D5). وإبطال ['price-lists'] يشمل المفتاحين.
 */
type Err = { response?: { data?: { message?: string; code?: string; customersCount?: number; repsCount?: number } } };

export default function PriceListsPanel({ onDirtyChange }: {
  /** نموذج قاعدةٍ في المحرّر فيه ما لم يُحفظ — النافذة تسأل قبل الإغلاق */
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  const tr = useTr();
  // رسالة الخادم بلغة الواجهة (رسائل «قوائم الأسعار» عباراتٌ في القاموس، وغيرها تُعرض كما هي)
  const errMsg = (e: unknown, fallback: string) => { const m = (e as Err)?.response?.data?.message; return m ? tr(m) : fallback; };
  const qc = useQueryClient();
  const listsQ = useQuery({ queryKey: ['price-lists', 'counts'], queryFn: async () => priceListsOf((await priceListApi.listWithCounts()).data.data) });
  const lists = listsQ.data?.lists ?? [];
  const [newName, setNewName] = useState('');
  const newNameRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  // «الأسعار والقواعد»: القائمة المفتوحة في النافذة نفسها (رجوع ⇒ القوائم) — والعدّادات تتجدّد بإبطال ['price-lists'] بعد كل حفظ
  const [openId, setOpenId] = useState<string | null>(null);
  const openList = openId ? lists.find(l => l.id === openId) ?? null : null;
  const [deleting, setDeleting] = useState<PriceList | null>(null);
  // اسم الرقاقة الأولى: فارغ = «السعر الأساسي» (null في الخادم)
  const [label, setLabel] = useState('');
  const savedLabel = listsQ.data?.basePriceLabel ?? '';
  useEffect(() => { setLabel(savedLabel); }, [savedLabel]);
  const refresh = () => qc.invalidateQueries({ queryKey: ['price-lists'] });

  const create = useMutation({
    mutationFn: (name: string) => priceListApi.create(name),
    onSuccess: () => { setNewName(''); refresh(); toast.success(tr('أضيفت قائمة الأسعار')); },
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
    onSuccess: () => {
      setDeleting(null);
      refresh();
      // أسعار أصنافها وقواعدها تُحذف معها (Cascade) — فاتورة الإدارة تقرأ القواعد والأسعار من مفتاحيها
      qc.invalidateQueries({ queryKey: ['price-list-rules'] });
      qc.invalidateQueries({ queryKey: ['products-all'] });
      toast.success(tr('حذفت قائمة الأسعار'));
    },
    // ٤٠٩ PRICE_LIST_IN_USE: بعدد العملاء والمناديب الذين عليها مترجماً — يُنقلون إلى قائمةٍ أخرى أولاً (وغيرها رسالة الخادم)
    onError: (e) => {
      setDeleting(null);
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

  // محرّر القائمة المفتوحة مكان اللوحة (المفتاح يعيد تهيئته لكل قائمة) — قائمةٌ حُذفت من مكانٍ آخر تعيد اللوحة
  if (openList) return <PriceListEditor key={openList.id} list={openList} onBack={() => setOpenId(null)} onDirtyChange={onDirtyChange} />;

  return (
    <div className="space-y-5">
      <div className="card space-y-4">
        <div>
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Tags size={18} className="text-[#E15A30]" /> {tr('قوائم الأسعار')}</h2>
          <p className="text-sm text-[#6E6557] mt-1 leading-relaxed">
            {tr('سعر الجملة وسعر التجزئة وغيرها بأسماء تختارها: في كل قائمة أسعار أصناف وقواعد خصم أو زيادة بحد أدنى للكمية وفترة صلاحية، ولكل عميل قائمة في ملفه تسعر بها فواتيره والمندوب يبدلها على الفاتورة بصلاحية تبديل قائمة الأسعار')}
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
          <p className="text-xs text-[#9A8F7E]">{tr('هو سعر الصنف نفسه وتسعر به فواتير العميل الذي لا قائمة له والفارغ يعيد الاسم الافتراضي')}</p>
        </div>

        {/* الزرّ فعّالٌ بلا اسم (كإضافة الفريق): يُقال الناقص بدل الصمت */}
        <form className="flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          const problem = priceListNameProblem(newName);
          if (problem) { toast.error(tr(problem)); newNameRef.current?.focus(); return; }
          create.mutate(newName.trim());
        }}>
          <input ref={newNameRef} className="input flex-1 min-w-0" placeholder={tr('مثل سعر الجملة')} value={newName} maxLength={PRICE_LIST_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)} />
          <button type="submit" className="btn-primary shrink-0 disabled:opacity-60" disabled={create.isPending}><Plus size={16} /> {tr('إضافة قائمة أسعار')}</button>
        </form>

        {listsQ.isLoading ? (
          <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
        ) : listsQ.isError ? (
          <p className="text-center text-red-500 text-sm py-6">{tr('تعذر تحميل قوائم الأسعار')}</p>
        ) : lists.length === 0 ? (
          <p className="text-center text-gray-400 text-sm py-6">{tr('لا توجد قوائم أسعار بعد والفواتير تسعر بسعر الصنف وحده')}</p>
        ) : (
          <div className="divide-y divide-[#F1EBDF] border border-[#F1EBDF] rounded-xl">
            {lists.map((l, i) => (
              <div key={l.id} className="p-3.5 flex items-center gap-3 flex-wrap" data-price-list-row="">
                {editing?.id === l.id ? (
                  <form className="flex items-center gap-1.5 flex-1 min-w-0" onSubmit={(e) => { e.preventDefault(); submitRename(); }}>
                    <input autoFocus className="input flex-1 !py-1.5" maxLength={PRICE_LIST_NAME_MAX} value={editing.name}
                      onChange={(e) => setEditing({ id: l.id, name: e.target.value })} />
                    <button type="submit" disabled={rename.isPending} className="p-2 rounded-lg text-[#1E7A52] hover:bg-green-50" title={tr('حفظ')}><Check size={15} /></button>
                    <button type="button" onClick={() => setEditing(null)} className="p-2 rounded-lg text-gray-400 hover:bg-gray-100" title={tr('إلغاء')}><X size={15} /></button>
                  </form>
                ) : (
                  <div className="min-w-0 flex-1 basis-40">
                    {/* «بيع نقدي فقط» (طلب المالك ١٢ نوفمبر ٢٠٢٦): شارةٌ على صفّ القائمة — والمفتاح نفسه في «الأسعار والقواعد» */}
                    <p className="font-semibold text-[#1F1A13] flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{l.name}</span>
                      {l.cashOnly && (
                        <span className="shrink-0 rounded-full bg-green-50 border border-green-200 px-1.5 text-[10px] font-bold text-[#1E7A52]" data-cash-only-badge="">
                          {tr(CASH_ONLY_LABEL)}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-[#6E6557] mt-0.5">{priceListCountsText(l, tr, formatNumber)}</p>
                  </div>
                )}
                {editing?.id !== l.id && (
                  <div className="flex items-center gap-1 shrink-0 flex-wrap">
                    <button type="button" onClick={() => setOpenId(l.id)} className="btn-primary !py-1.5 !px-3 text-xs" data-open-price-list="">
                      <ListChecks size={13} /> {tr('الأسعار والقواعد')}
                    </button>
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending} title={tr('تحريك لأعلى')}
                      className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-30"><ArrowUp size={15} /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === lists.length - 1 || reorder.isPending} title={tr('تحريك لأسفل')}
                      className="p-2 rounded-lg text-[#6E6557] hover:bg-[#FAF7F0] disabled:opacity-30"><ArrowDown size={15} /></button>
                    <button type="button" onClick={() => setEditing({ id: l.id, name: l.name })} className="btn-secondary !py-1.5 !px-3 text-xs"><Pencil size={13} /> {tr('تعديل')}</button>
                    {/* قائمةٌ عليها عملاء لا تُحذف (كالفريق الذي عليه مستندات) — والخادم يردّها 409 لو سبقه عميلٌ أُسند بعد التحميل،
                        أو كانت قائمة مندوبٍ (افتراضيّته أو من المسموح له) فتقول رسالته عددهم */}
                    {(l.customersCount ?? 0) === 0 && (
                      <button type="button" disabled={remove.isPending} title={tr('حذف')} onClick={() => setDeleting(l)}
                        className="p-2 rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-[#9A8F7E]">{tr('قائمة الأسعار التي عليها عملاء أو مناديب لا تحذف حتى تنقلهم إلى قائمة أخرى من ملفاتهم، وأسعار أصنافها وقواعدها تكتب من «الأسعار والقواعد»')}</p>
      </div>

      {deleting && (
        <ConfirmDialog danger title={tr('حذف قائمة الأسعار')} confirmLabel={tr('حذف')} loading={remove.isPending}
          message={`«${deleting.name}» — ${tr('تحذف معها أسعار أصنافها وقواعدها')}`}
          onConfirm={() => remove.mutate(deleting.id)} onClose={() => { if (!remove.isPending) setDeleting(null); }} />
      )}
    </div>
  );
}
