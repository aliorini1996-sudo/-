import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RotateCcw, Settings2, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi } from '../api/client';
import { useTr } from '../i18n/strings';
import ConfirmDialog from './ConfirmDialog';
import PaymentMethodIcon, { METHOD_ICON_COMPONENTS } from './PaymentMethodIcon';
import {
  DEFAULT_METHOD_ICON, LABEL_MATCHES_TRANSLATED_DEFAULT, MANUAL_BASES, METHOD_ICONS, PAYMENT_METHODS_LIMITS, canAddCustom,
  defaultMethodLabel, draftFromConfig, draftIssues, draftLabelWarnings, draftToInput, draftsEqual, readPaymentMethodsConfig,
  type DraftCustom, type ManualBase, type MethodsDraft, type PaymentMethodsIssue,
} from '../lib/paymentMethodsConfig';

/**
 * «إدارة طرق الدفع» (طلب المالك ٢٥ أكتوبر ٢٠٢٦) — نافذةٌ تُفتح من رأس صفحة «طرق الدفع» لمن يملك صلاحية «إعدادات الشركة»
 * (الخادم يفرضها، ومعها المحاسبة وعَلَم الصفحة — الواجهة تُخفي فقط):
 *  (أ) إعادة تسمية الطرق الأساسية الخمس، (ب) إضافة طرق (STC Pay، تابي…) باسم وأيقونة و«تُعامل مثل» أساسٍ من أربعة،
 *  (ج) تعطيل طريقةٍ لا تستعملها الشركة فتختفي من نماذج السند وتبقى سنداتها القديمة باسمها.
 *
 * لماذا تُقرأ من GET /company/payment-methods لا من كاش ['company']: الحفظ JSON كامل، وكاشٌ عمره دقائق كان سيُعيد إرسال
 * إعدادٍ أقدم من شاشةٍ أخرى — والخادم يرفض حذف طريقة محفوظة أو تبديل أساسها (409) لكنه لا يعرف تسميةً أُلغيت صامتاً.
 *
 * قواعد الشاشة كلها من النواة المنسوخة من الخادم (draftIssues ⇒ checkPaymentMethodsConfig): ما ترفضه هنا يرفضه الخادم
 * حرفاً بحرف، فلا يرى المستخدم «حُفظ» ثم رفضاً. والطريقة المحفوظة لا تُحذف ولا يتغيّر أساسها: سنداتها قُيّدت عليه وتحتاج اسمها.
 */

interface MethodsResponse { data: unknown; stored: boolean; hasCompany: boolean }
type ApiError = { response?: { status?: number; data?: { code?: string; message?: string; issues?: PaymentMethodsIssue[] } } } | null;

let tempSeq = 0;
const newRow = (): DraftCustom => ({ key: null, rowId: `new-${Date.now().toString(36)}-${tempSeq++}`, label: '', base: 'CASH', icon: DEFAULT_METHOD_ICON, active: true });

/** لون الأساس — الطريقة المضافة تأخذ لون ما تُعامل مثله (كما في جداول الصفحة) */
const BASE_TINT: Record<string, string> = {
  CASH: 'text-green-700 bg-green-50', POS: 'text-purple-700 bg-purple-50', BANK_TRANSFER: 'text-[#C94E28] bg-[#FBEBE2]',
  CHEQUE: 'text-orange-700 bg-orange-50', ONLINE: 'text-sky-700 bg-sky-50',
};

function Toggle({ on, disabled, onChange }: { on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const tr = useTr();
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}
      className={`shrink-0 text-xs font-bold rounded-full px-3 py-1.5 border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${on ? 'bg-green-50 text-[#1E7A52] border-green-200 hover:bg-green-100' : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'}`}>
      {on ? tr('مفعلة') : tr('معطلة')}
    </button>
  );
}

export default function PaymentMethodsManager({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['company-payment-methods'],
    queryFn: async () => (await companyApi.paymentMethods.get()).data as MethodsResponse,
    staleTime: 0,
  });
  const saved = useMemo(() => (q.data ? readPaymentMethodsConfig(q.data.data) : null), [q.data]);
  const baseline = useMemo(() => draftFromConfig(saved), [saved]);
  const [draft, setDraft] = useState<MethodsDraft | null>(null);
  // المسوّدة تُبنى مرّة من أول قراءة — إعادة الجلب في الخلفية لا تمحو ما يكتبه المستخدم
  useEffect(() => { if (q.data && !draft) setDraft(draftFromConfig(saved)); }, [q.data, saved, draft]);

  const [serverIssues, setServerIssues] = useState<PaymentMethodsIssue[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [iconFor, setIconFor] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const localIssues = useMemo(() => (draft ? draftIssues(draft) : []), [draft]);
  // أخطاء الحفظ من الخادم ما دامت المسوّدة كما أُرسلت؛ وأخطاء الشاشة بعد أول محاولة حفظ (لا أحمر قبل أن يكتب المستخدم شيئاً)
  const issues = serverIssues.length ? serverIssues : showErrors ? localIssues : [];
  const issueOf = (prefix: string) => issues.find(i => i.path === prefix || i.path.startsWith(`${prefix}.`))?.message;
  const generalIssue = issues.find(i => i.path === '' || i.path === 'custom' || i.path === 'version')?.message;
  // تحذيرٌ حيّ لا يمنع الحفظ: اسمٌ يطابق بلغة الواجهة الحالية اسماً تعرضه الشاشات لطريقة أساسية أخرى (النواة تحجز العربية وحدها)
  const warnings = useMemo(() => new Set(draft ? draftLabelWarnings(draft, tr) : []), [draft, tr]);

  const edit = (fn: (d: MethodsDraft) => MethodsDraft) => { setDraft(d => (d ? fn(d) : d)); setServerIssues([]); };
  const setBuiltin = (i: number, patch: Partial<MethodsDraft['builtins'][number]>) =>
    edit(d => ({ ...d, builtins: d.builtins.map((b, j) => (j === i ? { ...b, ...patch } : b)) }));
  const setCustom = (i: number, patch: Partial<DraftCustom>) =>
    edit(d => ({ ...d, custom: d.custom.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const afterSave = () => {
    // كل ما يعرض الأسماء أو يبني الاختيارات: الشركة (اللوحة و/m)، والتقريران بأسماء الخادم، وهذه النافذة
    qc.invalidateQueries({ queryKey: ['company'] });
    qc.invalidateQueries({ queryKey: ['company-payment-methods'] });
    qc.invalidateQueries({ queryKey: ['report-payment-methods'] });
    qc.invalidateQueries({ queryKey: ['report-collections'] });
  };
  const onError = async (e: unknown) => {
    const d = (e as ApiError)?.response?.data;
    if (d?.code === 'PAYMENT_METHODS_CONFLICT') {
      // تبويبٌ آخر حفظ قبلنا: نعيد القراءة ونبني المسوّدة منها بدل دمجٍ صامت قد يُسقط طريقةً أو يبدّل أساسها
      toast.error(tr(d.message || 'تعذر الحفظ'));
      const fresh = await q.refetch();
      if (fresh.data) setDraft(draftFromConfig(readPaymentMethodsConfig(fresh.data.data)));
      setServerIssues([]);
      return;
    }
    if (d?.issues?.length) setServerIssues(d.issues);
    toast.error(d?.message ? tr(d.message) : tr('تعذر الحفظ'));
  };
  const save = useMutation({
    mutationFn: (d: MethodsDraft) => companyApi.paymentMethods.put(draftToInput(d)),
    onSuccess: () => { afterSave(); toast.success(tr('تم حفظ طرق الدفع')); onClose(); },
    onError,
  });
  const reset = useMutation({
    mutationFn: () => companyApi.paymentMethods.put(null),
    onSuccess: () => { afterSave(); setConfirmReset(false); toast.success(tr('تمت استعادة الافتراضي')); onClose(); },
    onError: (e) => { setConfirmReset(false); void onError(e); },
  });

  const submit = () => {
    if (!draft) return;
    if (draftsEqual(draft, baseline)) { toast(tr('لا تغييرات للحفظ')); return; }
    if (localIssues.length) { setShowErrors(true); toast.error(tr(localIssues[0].message)); return; }
    save.mutate(draft);
  };

  const busy = save.isPending || reset.isPending;
  const noCompany = q.data?.hasCompany === false;
  // اسم الأساس في «تُعامل مثل»: اسم الشركة الجديد للطريقة الأساسية إن سمّتها في المسوّدة، وإلا الافتراضي مترجماً
  const baseName = (m: ManualBase) => draft?.builtins.find(b => b.method === m)?.label.trim() || defaultMethodLabel(m, tr);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 p-5 border-b">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Settings2 size={18} className="text-[#E15A30]" /> {tr('إدارة طرق الدفع')}</h2>
            <p className="text-xs text-[#6E6557] mt-1 leading-relaxed">{tr('سم طرق الدفع بأسماء شركتك وأضف طرقا جديدة وعطل ما لا تستعمله — الأسماء تظهر في سندات القبض المطبوعة والقوائم والتقارير والتصدير')}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500 shrink-0" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {q.isPending ? (
            <div className="text-center text-gray-400 py-10 text-sm">{tr('جاري التحميل')}</div>
          ) : q.isError || !draft ? (
            <div className="flex flex-col items-center gap-3 py-10 text-gray-500 text-sm">
              <span>{tr('تعذر تحميل طرق الدفع')}</span>
              <button onClick={() => q.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
            </div>
          ) : (
            <>
              {noCompany && (
                <p className="text-xs text-[#B4530A] bg-[#FDF3E7] border border-[#F5D9B0] rounded-xl px-3 py-2">{tr('احفظ بيانات الشركة أولا')}</p>
              )}

              {/* الطرق الأساسية: إعادة التسمية والتعطيل — والإلكتروني يُسمّى ولا يُعطَّل (سنده من روابط الدفع وحدها) */}
              <section>
                <h3 className="text-sm font-bold text-[#1F1A13] mb-2">{tr('الطرق الأساسية')}</h3>
                <div className="rounded-xl border border-[#F1EBDF] divide-y divide-[#F1EBDF]">
                  {draft.builtins.map((b, i) => {
                    const err = issueOf(`builtins.${b.method}`);
                    const fallback = defaultMethodLabel(b.method, tr);
                    return (
                      <div key={b.method} className="p-3">
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${BASE_TINT[b.method] ?? ''}`}>
                            <PaymentMethodIcon base={b.method} size={15} />
                          </span>
                          <div className="flex-1 min-w-[12rem]">
                            <label className="block text-[11px] text-[#9A8F7E] mb-0.5">{tr('الاسم الافتراضي')}: {fallback}</label>
                            <input className="input w-full" value={b.label} placeholder={fallback} maxLength={PAYMENT_METHODS_LIMITS.labelMax}
                              onChange={e => setBuiltin(i, { label: e.target.value })} />
                          </div>
                          <Toggle on={b.active} disabled={b.method === 'ONLINE'} onChange={v => setBuiltin(i, { active: v })} />
                        </div>
                        {b.method === 'ONLINE' && <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr('الدفع الإلكتروني يعمل من روابط الدفع ولا يعطل من هنا')}</p>}
                        {err ? <p className="text-[11px] text-red-600 mt-1.5">{tr(err)}</p>
                          : warnings.has(`builtins.${b.method}.label`) && <p className="text-[11px] text-[#B4530A] mt-1.5">{tr(LABEL_MATCHES_TRANSLATED_DEFAULT)}</p>}
                      </div>
                    );
                  })}
                </div>
              </section>

              {/* الطرق المضافة: اسمٌ وأيقونة و«تُعامل مثل» — والمحفوظة لا تُحذف ولا يتغيّر أساسها */}
              <section>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <h3 className="text-sm font-bold text-[#1F1A13]">{tr('الطرق المضافة')}</h3>
                  <button type="button" className="btn-secondary text-sm" disabled={!canAddCustom(draft)}
                    onClick={() => edit(d => ({ ...d, custom: [...d.custom, newRow()] }))}>
                    <Plus size={15} /> {tr('إضافة طريقة دفع')}
                  </button>
                </div>
                {!canAddCustom(draft) && <p className="text-[11px] text-[#9A8F7E] mb-2">{tr('عدد طرق الدفع المضافة 20 على الأكثر')}</p>}
                {draft.custom.length === 0 ? (
                  <p className="text-xs text-[#9A8F7E] rounded-xl border border-dashed border-[#E9E1D3] px-3 py-4 text-center">{tr('لا طرق مضافة بعد — مثال: STC Pay أو تابي')}</p>
                ) : (
                  <div className="rounded-xl border border-[#F1EBDF] divide-y divide-[#F1EBDF]">
                    {draft.custom.map((c, i) => {
                      const err = issueOf(`custom.${i}`);
                      const savedRow = c.key !== null;
                      const IconBtn = METHOD_ICON_COMPONENTS[c.icon] ?? METHOD_ICON_COMPONENTS[DEFAULT_METHOD_ICON];
                      return (
                        <div key={c.rowId} className={`p-3 ${c.active ? '' : 'bg-gray-50/60'}`}>
                          <div className="flex items-end gap-3 flex-wrap">
                            <div className="relative">
                              <label className="block text-[11px] text-[#9A8F7E] mb-0.5">{tr('الأيقونة')}</label>
                              <button type="button" onClick={() => setIconFor(o => (o === c.rowId ? null : c.rowId))}
                                className={`w-10 h-10 rounded-xl border border-[#E9E1D3] flex items-center justify-center ${BASE_TINT[c.base] ?? ''}`}
                                aria-label={tr('الأيقونة')} aria-expanded={iconFor === c.rowId}>
                                <IconBtn size={17} />
                              </button>
                              {iconFor === c.rowId && (
                                <div className="absolute z-10 top-full mt-1 start-0 bg-white border border-[#E9E1D3] rounded-xl shadow-lg p-2 grid grid-cols-6 gap-1 w-[15.5rem]">
                                  {METHOD_ICONS.map(ic => {
                                    const I = METHOD_ICON_COMPONENTS[ic];
                                    return (
                                      <button key={ic} type="button" onClick={() => { setCustom(i, { icon: ic }); setIconFor(null); }}
                                        className={`w-9 h-9 rounded-lg flex items-center justify-center hover:bg-[#FAF7F0] ${c.icon === ic ? 'bg-[#FBEBE2] text-[#C94E28]' : 'text-[#6E6557]'}`}>
                                        <I size={16} />
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-[10rem]">
                              <label className="block text-[11px] text-[#9A8F7E] mb-0.5">{tr('اسم الطريقة')}</label>
                              <input className="input w-full" value={c.label} placeholder="STC Pay" maxLength={PAYMENT_METHODS_LIMITS.labelMax}
                                onChange={e => setCustom(i, { label: e.target.value })} />
                            </div>
                            <div className="w-40">
                              <label className="block text-[11px] text-[#9A8F7E] mb-0.5">{tr('تعامل مثل')}</label>
                              {/* الأساس ما تُقيَّد عليه سنداتها (الحسابات وعهدة المندوب) — يُختار مرّة ولا يتغيّر بعد الحفظ */}
                              <select className="input w-full" value={c.base} disabled={savedRow}
                                title={savedRow ? tr('لا يتغير ما تعامل مثله طريقة دفع محفوظة لأن سنداتها قيدت عليه. أضف طريقة جديدة بدلا منها') : undefined}
                                onChange={e => setCustom(i, { base: e.target.value as ManualBase })}>
                                {MANUAL_BASES.map(m => <option key={m} value={m}>{baseName(m)}</option>)}
                              </select>
                            </div>
                            <div className="flex items-center gap-2 pb-1">
                              <Toggle on={c.active} onChange={v => setCustom(i, { active: v })} />
                              {!savedRow && (
                                <button type="button" onClick={() => edit(d => ({ ...d, custom: d.custom.filter((_, j) => j !== i) }))}
                                  className="p-2 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50" aria-label={tr('إزالة')} title={tr('إزالة')}>
                                  <Trash2 size={15} />
                                </button>
                              )}
                            </div>
                          </div>
                          {err ? <p className="text-[11px] text-red-600 mt-1.5">{tr(err)}</p>
                            : warnings.has(`custom.${i}.label`) && <p className="text-[11px] text-[#B4530A] mt-1.5">{tr(LABEL_MATCHES_TRANSLATED_DEFAULT)}</p>}
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[11px] text-[#9A8F7E] mt-2 leading-relaxed">
                  {tr('تعامل مثل: ما تقيد عليه سندات الطريقة في الحسابات وعهدة المندوب ولا يتغير بعد الحفظ')}
                  {' · '}
                  {tr('الطريقة المحفوظة لا تحذف بل تعطل لتبقى سنداتها القديمة باسمها')}
                </p>
              </section>

              {generalIssue && <p className="text-xs text-red-600">{tr(generalIssue)}</p>}
            </>
          )}
        </div>

        <div className="flex items-center gap-3 p-5 border-t flex-wrap">
          <button onClick={submit} disabled={busy || !draft || noCompany} className="btn-primary justify-center py-2.5 px-6">
            {save.isPending && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {tr('حفظ')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          <button onClick={() => setConfirmReset(true)} disabled={busy || !draft || noCompany || !q.data?.stored}
            className="ms-auto text-sm text-[#6E6557] hover:text-[#C94E28] inline-flex items-center gap-1.5 disabled:opacity-40">
            <RotateCcw size={14} /> {tr('استعادة الافتراضي')}
          </button>
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title={tr('استعادة الافتراضي')}
          message={tr('تعود الطرق الأساسية بأسمائها الافتراضية مفعلة كلها وتبقى الطرق المضافة معطلة بأسمائها لسنداتها القديمة')}
          confirmLabel={tr('استعادة الافتراضي')} loading={reset.isPending}
          onConfirm={() => reset.mutate()} onClose={() => setConfirmReset(false)} />
      )}
    </div>
  );
}
