import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Check, ChevronLeft, ChevronRight, Coins, HandCoins, Package, Pencil, Percent, Plus, Target, Trash2, TrendingUp, Trophy, Wallet, X,
} from 'lucide-react';
import { productApi, repTargetsApi } from '../api/client';
import type { SalesRep } from '../types';
import { useTr } from '../i18n/strings';
import { useLang } from '../i18n/lang';
import { backdropClose } from '../lib/backdropClose';
import { activeLocale, formatCurrency, getActiveCurrency } from '../utils/format';
import { primaryUnitOf, type UnitDef } from '../lib/units';
import { productUnitLabel } from '../lib/adminUnits';
import { choiceById, defaultChoice, unitChoices, type UnitChoice } from '../rep/repUnits';
import { isStaleUnitsError } from '../lib/stockRequest';
import {
  MAX_TARGETS_PER_MONTH, REWARD_KINDS, TARGET_KINDS, TARGET_NOTE_MAX, barPct, cleanDecimal, daysLeftText, draftOf, draftProblem, emptyDraft,
  monthLabel, pctText, readNum, rewardText, shiftMonth, targetAmountText, targetErrorCode, targetErrorMessage, targetKindLabel, targetStateText,
  targetTitle, toTargetInput, type RepRewardKind, type RepTargetInput, type RepTargetKind, type RepTargetView, type RepTargetsData, type TargetDraft,
} from '../lib/repTargets';
import ConfirmDialog from './ConfirmDialog';
import SearchableSelect from './SearchableSelect';

/** الصنف كما يصل من كاش الأصناف المشترك ['products-min'] (GET /products?limit=1000، ومعه الموقوف) */
interface ProductPick {
  id: string; name: string; code?: string; unit: string; status?: string;
  units?: UnitDef[] | null; primaryUnitId?: string | null;
}

const KIND_ICONS: Record<RepTargetKind, typeof Target> = { SALES_AMOUNT: TrendingUp, PRODUCT_QTY: Package, COLLECTION_PCT: HandCoins };
const REWARD_ICONS: Record<RepRewardKind, typeof Target> = { COMMISSION_SALES_PCT: Percent, SALARY_PCT: Wallet, FIXED_AMOUNT: Coins };

/** أرقام الكميات والنسب بلغة العرض وأرقام الشركة — بأربع منازل كأقصى ما يحفظه الخادم للكمية */
const num = (n: number) => Number(n).toLocaleString(activeLocale(), { maximumFractionDigits: 4 });
const money = (n: number) => formatCurrency(n);

/**
 * «هدف الشهر» لمندوبٍ (طلب المالك ٩ نوفمبر ٢٠٢٦) — من أيقونة في عمود الإجراءات بصفحة المناديب. أهداف الشهر بتقدّمها
 * ومكافأتها، وإضافةٌ وتعديلٌ في المكان وحذفٌ بتأكيد. الحساب كلّه في الخادم (/api/rep-targets) بشهر الشركة وتوقيتها:
 * أوّل فتحٍ بلا شهر فيردّ الخادم شهره الحالي، ثم الأسهم تتنقّل من شهر الردّ. ويظهر كل هدفٍ للمندوب في رئيسية تطبيقه.
 */
export default function RepTargetsModal({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const qc = useQueryClient();
  // null = «الشهر الحالي» كما يعرفه الخادم بتوقيت الشركة (لا ساعة المتصفّح)
  const [month, setMonth] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // معرّف الهدف المعدَّل، أو 'new'
  const [deleting, setDeleting] = useState<RepTargetView | null>(null);

  const q = useQuery({
    queryKey: ['rep-targets', rep.id, month],
    queryFn: async () => (await repTargetsApi.forRep(rep.id, month ?? undefined)).data.data as RepTargetsData,
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const shownMonth = month ?? data?.month ?? null;
  const switching = q.isFetching && q.isPlaceholderData;

  // الأصناف لنموذج «كمية صنف» — تُطلب حين يُفتح النموذج وحده (الكاش المشترك مع شاشات الإدارة)
  const prodQ = useQuery({
    queryKey: ['products-min'],
    queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductPick[],
    enabled: editing !== null,
    staleTime: 60_000,
  });

  /* قائمة الأصناف تُقرأ بصلاحية إدارة الأصناف (GET /products) لا صلاحية المناديب — فتعذّرها يُقال تحت المنتقي بسببه، لا قائمةٌ
     فارغة بلا تفسير. والـ403 بلا «إعادة المحاولة»: الصلاحية لا تأتي بالإلحاح */
  const prodStatus = (prodQ.error as { response?: { status?: number } } | null)?.response?.status;
  const productsError = !prodQ.isError ? null
    : prodStatus === 403 ? tr('اختيار الصنف يحتاج صلاحية إدارة الأصناف')
      : targetErrorMessage(prodQ.error, tr, tr('تعذر تحميل الأصناف'));
  const retryProducts = prodQ.isError && prodStatus !== 403 ? () => { void prodQ.refetch(); } : null;

  const goMonth = (m: string | null) => { setEditing(null); setMonth(m); };

  const save = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: RepTargetInput }) => (id ? repTargetsApi.update(id, body) : repTargetsApi.create(rep.id, body)),
    onSuccess: async () => {
      toast.success(tr('تم حفظ الهدف'));
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['rep-targets', rep.id] });
    },
    onError: (e: unknown) => {
      toast.error(targetErrorMessage(e, tr, tr('تعذر الحفظ')));
      // وحدات الصنف تغيّرت منذ حُمّلت القائمة ⇒ تُجلب من جديد فيرى النموذج أساسه الحالي ووحداته
      if (isStaleUnitsError(e)) void qc.invalidateQueries({ queryKey: ['products-min'] });
      // الهدف حُذف من مكانٍ آخر ⇒ تُعاد القائمة فيُغلق نموذجه (الأثر أدناه)
      if (targetErrorCode(e) === 'TARGET_NOT_FOUND') void q.refetch();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => repTargetsApi.remove(id),
    onSuccess: async () => {
      toast.success(tr('تم حذف الهدف'));
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['rep-targets', rep.id] });
    },
    onError: (e: unknown) => {
      toast.error(targetErrorMessage(e, tr, tr('تعذر الحذف')));
      if (targetErrorCode(e) === 'TARGET_NOT_FOUND') { setDeleting(null); void q.refetch(); }
    },
  });

  /* هدفٌ يُعدَّل اختفى من القائمة (حذفه مستخدمٌ آخر فأعاد الجلبُ القائمةَ بدونه) ⇒ يُغلق نموذجه — وإلّا بقي `editing` على معرّفٍ
     غائب: لا نموذج، وأزرار البطاقات معطّلة، و«إضافة هدف» مخفيّة حتى تُغلق النافذة */
  useEffect(() => {
    if (editing && editing !== 'new' && data && !q.isPlaceholderData && !data.targets.some(t => t.id === editing)) setEditing(null);
  }, [data, editing, q.isPlaceholderData]);

  // نموذج الإضافة في آخر القائمة — يُمرَّر إليه حين يُفتح
  const newFormRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing === 'new') newFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [editing]);

  const targets = data?.targets ?? [];
  const doneCount = targets.filter(t => t.progress.done).length;
  const atLimit = targets.length >= MAX_TARGETS_PER_MONTH;
  const future = !!data && !data.isCurrent && data.daysLeft > 0;
  const monthNote = !data ? '' : data.isCurrent ? daysLeftText(data.daysLeft, lang, tr, num) : future ? tr('لم يبدأ الشهر بعد') : tr('انتهى الشهر');
  const products = prodQ.data ?? [];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* الرأس */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center shrink-0"><Target size={20} className="text-[#E15A30]" /></div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-[#1F1A13]">{tr('هدف الشهر')}</h2>
              <p className="text-xs text-[#6E6557] truncate">{rep.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label={tr('إغلاق')}><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* الشهر: السهم الأيمن للسابق والأيسر للتالي (النافذة من اليمين لليسار) */}
          <div className="flex items-center justify-between gap-2 bg-[#FAF7F0] border border-[#F1EBDF] rounded-xl px-2 py-2">
            <button type="button" onClick={() => shownMonth && goMonth(shiftMonth(shownMonth, -1))} disabled={!shownMonth}
              className="p-2 rounded-lg hover:bg-white text-[#6E6557] disabled:opacity-40" title={tr('الشهر السابق')} aria-label={tr('الشهر السابق')}>
              <ChevronRight size={18} />
            </button>
            <div className="text-center min-w-0">
              <p className="text-sm font-bold text-[#1F1A13]">{shownMonth ? monthLabel(shownMonth, activeLocale()) : '—'}</p>
              {monthNote && <p className="text-[11px] text-[#9A8F7E] mt-0.5">{monthNote}</p>}
              {month !== null && data && !data.isCurrent && (
                <button type="button" onClick={() => goMonth(null)} className="text-[11px] font-semibold text-[#E15A30] hover:underline mt-0.5">{tr('الشهر الحالي')}</button>
              )}
            </div>
            <button type="button" onClick={() => shownMonth && goMonth(shiftMonth(shownMonth, 1))} disabled={!shownMonth}
              className="p-2 rounded-lg hover:bg-white text-[#6E6557] disabled:opacity-40" title={tr('الشهر التالي')} aria-label={tr('الشهر التالي')}>
              <ChevronLeft size={18} />
            </button>
          </div>

          {q.isLoading ? (
            <div className="py-10 flex flex-col items-center gap-2 text-sm text-gray-400">
              <span className="w-6 h-6 border-2 border-[#F1EBDF] border-t-[#E15A30] rounded-full animate-spin" />
              {tr('جاري التحميل')}
            </div>
          ) : q.isError && !data ? (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-3 flex items-center justify-between gap-3">
              <span>{targetErrorMessage(q.error, tr, tr('تعذر تحميل الأهداف'))}</span>
              <button type="button" onClick={() => q.refetch()} className="shrink-0 font-semibold underline">{tr('إعادة المحاولة')}</button>
            </div>
          ) : data ? (
            <div className={`space-y-4 transition-opacity ${switching ? 'opacity-50 pointer-events-none' : ''}`}>
              {/* ملخّص الشهر */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-[#F1EBDF] p-3">
                  <p className="text-[11px] text-[#6E6557]">{tr('صافي مبيعات الشهر')}</p>
                  <p className="text-base font-bold text-[#1F1A13] mt-0.5"><bdi>{formatCurrency(data.monthNetSales)}</bdi></p>
                </div>
                <div className="rounded-xl border border-[#F1EBDF] p-3">
                  <p className="text-[11px] text-[#6E6557]">{tr('الأهداف المحققة')}</p>
                  <p className={`text-base font-bold mt-0.5 ${targets.length > 0 && doneCount === targets.length ? 'text-[#1E7A52]' : 'text-[#1F1A13]'}`}>
                    {num(doneCount)} <span className="text-sm text-[#9A8F7E]">/ {num(targets.length)}</span>
                  </p>
                </div>
              </div>

              {targets.length === 0 && editing !== 'new' && (
                <div className="text-center py-8 px-4 border-2 border-dashed border-[#E9E1D3] rounded-2xl">
                  <div className="w-12 h-12 bg-[#FBEBE2] rounded-2xl flex items-center justify-center mx-auto mb-3"><Target size={22} className="text-[#E15A30]" /></div>
                  <p className="text-sm font-semibold text-[#1F1A13]">{tr('لا أهداف لهذا الشهر بعد')}</p>
                  <p className="text-xs text-[#6E6557] mt-1 leading-relaxed">{tr('أضف هدفا بمبلغ مبيعات أو كمية صنف أو نسبة تحصيل ويظهر للمندوب في صفحته الرئيسية')}</p>
                </div>
              )}

              {targets.map(t => (editing === t.id ? (
                <TargetForm key={t.id} initial={draftOf(t)} original={t} products={products} productsLoading={prodQ.isLoading}
                  productsError={productsError} onRetryProducts={retryProducts} saving={save.isPending} onCancel={() => setEditing(null)} onSave={body => save.mutate({ id: t.id, body })} />
              ) : (
                <TargetCard key={t.id} t={t} busy={editing !== null}
                  onEdit={() => setEditing(t.id)} onDelete={() => setDeleting(t)} />
              )))}

              {editing === 'new' && shownMonth && (
                <div ref={newFormRef}>
                  <TargetForm initial={emptyDraft(shownMonth)} original={null} products={products} productsLoading={prodQ.isLoading}
                    productsError={productsError} onRetryProducts={retryProducts} saving={save.isPending} onCancel={() => setEditing(null)} onSave={body => save.mutate({ id: null, body })} />
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 p-5 border-t border-[#E9E1D3]">
          {data && editing === null && (
            atLimit
              ? <p className="flex-1 text-xs text-[#9A8F7E]">{tr('وصلت للحد الأعلى من الأهداف لهذا الشهر (20)')}</p>
              : (
                <button type="button" onClick={() => setEditing('new')} disabled={switching} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
                  <Plus size={16} /> {tr('إضافة هدف')}
                </button>
              )
          )}
          {(editing !== null || !data) && <span className="flex-1" />}
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إغلاق')}</button>
        </div>
      </div>

      {deleting && (
        <ConfirmDialog
          danger
          title={tr('حذف الهدف')}
          message={`«${targetTitle(deleting, tr, num)}» — ${tr('سيحذف هذا الهدف ولن يظهر للمندوب بعد الآن')}`}
          confirmLabel={tr('حذف')}
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** هدفٌ بتقدّمه: العنوان والشريط والمُنجَز من الهدف والنسبة، وسطر المكافأة والملاحظة */
function TargetCard({ t, busy, onEdit, onDelete }: { t: RepTargetView; busy: boolean; onEdit: () => void; onDelete: () => void }) {
  const tr = useTr();
  const p = t.progress;
  const stateText = targetStateText(p);
  const KindIcon = KIND_ICONS[t.kind] ?? Target;
  return (
    <div className={`rounded-2xl border p-4 ${p.done ? 'border-[#BFE0CD] bg-[#F6FBF8]' : 'border-[#E9E1D3] bg-white'}`}>
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${p.done ? 'bg-[#E4F1EA]' : 'bg-[#FBEBE2]'}`}>
          <KindIcon size={17} className={p.done ? 'text-[#1E7A52]' : 'text-[#E15A30]'} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-[#1F1A13] leading-snug break-words">{targetTitle(t, tr, num)}</p>
          <p className="text-[11px] text-[#9A8F7E] mt-0.5">{tr(targetKindLabel(t.kind))}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {p.done && (
            <span className="badge-active gap-1 whitespace-nowrap"><Check size={12} /> {tr('تحقق الهدف')}</span>
          )}
          <button type="button" onClick={onEdit} disabled={busy} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30] disabled:opacity-40"
            title={tr('تعديل الهدف')} aria-label={tr('تعديل الهدف')}><Pencil size={14} /></button>
          <button type="button" onClick={onDelete} disabled={busy} className="p-1.5 hover:bg-red-50 rounded text-red-600 disabled:opacity-40"
            title={tr('حذف الهدف')} aria-label={tr('حذف الهدف')}><Trash2 size={14} /></button>
        </div>
      </div>

      {stateText ? (
        <p className="mt-3 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">{tr(stateText)}</p>
      ) : (
        <div className="mt-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm text-[#1F1A13]">
              <bdi className="font-bold">{targetAmountText(t, p.achieved, money, num)}</bdi>
              <span className="text-[#9A8F7E]"> / <bdi>{targetAmountText(t, p.goal, money, num)}</bdi></span>
            </p>
            <bdi className={`text-sm font-extrabold ${p.done ? 'text-[#1E7A52]' : 'text-[#E15A30]'}`}>{pctText(p.pct, activeLocale())}</bdi>
          </div>
          <div className="mt-1.5 h-2.5 rounded-full bg-[#F1EBDF] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(barPct(p.pct))}>
            <div className={`h-full rounded-full transition-all ${p.done ? 'bg-[#2F855A]' : 'bg-[#E15A30]'}`} style={{ width: `${barPct(p.pct)}%` }} />
          </div>
          {t.kind === 'COLLECTION_PCT' && p.base != null && (
            <p className="text-[11px] text-[#6E6557] mt-1.5">{tr('الديون المفتوحة بداية الشهر')}: <bdi className="font-semibold">{formatCurrency(p.base)}</bdi></p>
          )}
        </div>
      )}

      <p className={`mt-2.5 text-xs flex items-center gap-1.5 ${t.reward.earned ? 'text-[#1E7A52] font-semibold' : 'text-[#6E6557]'}`}>
        <Trophy size={14} className={t.reward.earned ? 'text-[#2F855A]' : 'text-[#E15A30]'} />
        <span>{rewardText(t, tr, money, num)}</span>
      </p>
      {t.note && <p className="mt-2 text-[11px] text-[#6E6557] bg-[#FAF7F0] rounded-lg px-3 py-2 leading-relaxed whitespace-pre-line break-words">{t.note}</p>}
    </div>
  );
}

/** خانة رقمٍ عشريّ تقبل الأرقام العربية والفاصلة، ووحدتها (العملة أو %) بجانبها */
function NumField({ value, onChange, suffix, ariaLabel, autoFocus }: { value: string; onChange: (v: string) => void; suffix?: string; ariaLabel: string; autoFocus?: boolean }) {
  return (
    <div className="relative">
      <input type="text" inputMode="decimal" dir="ltr" autoFocus={autoFocus} aria-label={ariaLabel}
        className={`input text-left ${suffix ? 'pr-16' : ''}`} value={value}
        onChange={e => { const c = cleanDecimal(e.target.value); if (c !== null) onChange(c); }} />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#9A8F7E] pointer-events-none">{suffix}</span>}
    </div>
  );
}

/**
 * نموذج الهدف في مكانه (إضافة أو تعديل): النوع ثلاثة أزرار، ثم قيمته (مبلغ · صنف وكمية بوحدة · نسبة)، ثم المكافأة ثلاثة أزرار
 * وقيمتها، ثم ملاحظة للمندوب. التحقق بحدود الخادم نفسها قبل الإرسال (`draftProblem`)، والكمية تُرسل بوحدتها كما كُتبت.
 */
function TargetForm({ initial, original, products, productsLoading, productsError, onRetryProducts, saving, onCancel, onSave }: {
  initial: TargetDraft; original: RepTargetView | null; products: ProductPick[]; productsLoading: boolean;
  /** تعذّر تحميل الأصناف (بلا صلاحية الأصناف أو انقطاع) — يُقال تحت المنتقي */
  productsError: string | null; onRetryProducts: (() => void) | null; saving: boolean;
  onCancel: () => void; onSave: (body: RepTargetInput) => void;
}) {
  const tr = useTr();
  const [d, setD] = useState<TargetDraft>(initial);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<TargetDraft>) => setD(prev => ({ ...prev, ...patch }));
  const currency = getActiveCurrency();

  const product = products.find(p => p.id === d.productId) ?? null;
  const choices = product ? unitChoices(product) : [];
  const prim = product ? primaryUnitOf(product) : null;
  /* وحدة الهدف: من الصنف المحمَّل، وإلّا (القائمة لم تصل أو الصنف خارجها) لقطة الهدف المعدَّل نفسه — والخادم يتحقق ثانيةً.
     ووحدةٌ أُوقفت بعد إنشاء الهدف لا تُستبدل صامتةً بغيرها: «١٠ كرتون» ليست «١٠ حبة» */
  const choice: UnitChoice | null = product
    ? choiceById(product, d.unitId)
    : original && d.productId && d.productId === original.productId
      ? { id: original.unitId, name: original.unitName ?? '', factor: original.unitFactor || 1, price: null }
      : null;

  const options = useMemo(() => products.map(p => ({
    value: p.id,
    label: p.name,
    hint: [p.code, productUnitLabel(p, num), p.status === 'INACTIVE' ? tr('موقوف') : ''].filter(Boolean).join(' · '),
  })), [products, tr]);

  const problem = draftProblem(d) ?? (d.kind === 'PRODUCT_QTY' && d.productId && !choice ? 'وحدة الصنف غير صحيحة' : null);
  const submit = () => {
    setTried(true);
    if (problem) return;
    // أساس الصنف كما في القائمة المحمَّلة: حُوِّل منذئذٍ ⇒ يرفض الخادم بدل أن يقرأ «١٠٠ كرتون» مئة حبّة
    onSave(toTargetInput(d, choice, product?.unit ?? null));
  };

  const pickProduct = (id: string) => {
    const p = products.find(x => x.id === id);
    set({ productId: id, unitId: p ? defaultChoice(p).id : null });
  };

  const v = readNum(d.targetValue);
  const preview = !problem ? {
    title: targetTitle({ kind: d.kind, targetValue: Number(v), productName: product?.name ?? original?.productName ?? null, unitName: choice?.name ?? null }, tr, num),
    goal: d.kind === 'COLLECTION_PCT' ? null : targetAmountText({ kind: d.kind, unitName: choice?.name ?? null }, Number(v), money, num),
    reward: rewardText({ rewardKind: d.rewardKind, rewardValue: Number(readNum(d.rewardValue)), reward: { kind: d.rewardKind, value: 0, amount: d.rewardKind === 'FIXED_AMOUNT' ? Number(readNum(d.rewardValue)) : null, earned: false } }, tr, money, num),
  } : null;

  return (
    <div className="rounded-2xl border-2 border-[#E15A30]/40 bg-[#FFFCF8] p-4 space-y-4">
      <p className="text-sm font-bold text-[#1F1A13]">{original ? tr('تعديل الهدف') : tr('إضافة هدف')}</p>

      {/* نوع الهدف */}
      <div>
        <p className="label">{tr('نوع الهدف')}</p>
        <div className="grid grid-cols-3 gap-2">
          {TARGET_KINDS.map(k => {
            const Icon = KIND_ICONS[k.kind];
            const on = d.kind === k.kind;
            return (
              <button key={k.kind} type="button" aria-pressed={on}
                onClick={() => set({ kind: k.kind, targetValue: on ? d.targetValue : '' })}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 py-2.5 text-xs font-semibold transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:border-[#F0B9A5]'}`}>
                <Icon size={18} />
                <span className="leading-tight text-center">{tr(k.label)}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* قيمة الهدف بشكل نوعه */}
      {d.kind === 'SALES_AMOUNT' && (
        <div>
          <p className="label">{tr('مبلغ الهدف')}</p>
          <NumField value={d.targetValue} onChange={x => set({ targetValue: x })} suffix={currency} ariaLabel={tr('مبلغ الهدف')} />
          <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('صافي مبيعات المندوب في الشهر بعد خصم المرتجع')}</p>
        </div>
      )}
      {d.kind === 'PRODUCT_QTY' && (
        <div className="space-y-3">
          <div>
            <p className="label">{tr('الصنف')}</p>
            <SearchableSelect options={options} value={d.productId ?? ''} onChange={pickProduct} loading={productsLoading}
              placeholder={tr('اختر الصنف')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
            {!product && original?.productName && d.productId === original.productId && !productsLoading && (
              <p className="text-[11px] text-[#9A8F7E] mt-1">{original.productName}</p>
            )}
            {productsError && (
              <p className="text-[11px] text-red-600 mt-1 flex items-center gap-2">
                <span>{productsError}</span>
                {onRetryProducts && (
                  <button type="button" onClick={onRetryProducts} className="shrink-0 font-semibold underline">{tr('إعادة المحاولة')}</button>
                )}
              </p>
            )}
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <div>
              <p className="label">{tr('الكمية المستهدفة')}</p>
              <NumField value={d.targetValue} onChange={x => set({ targetValue: x })} ariaLabel={tr('الكمية المستهدفة')} />
            </div>
            <div className="min-w-[8rem]">
              <p className="label">{tr('الوحدة')}</p>
              {product && (choices.length > 1 || !choice) ? (
                <select className="input" value={choice ? (choice.id ?? '') : '__none'} aria-label={tr('الوحدة')}
                  onChange={e => set({ unitId: e.target.value || null })}>
                  {!choice && <option value="__none" disabled>{tr('اختر الوحدة')}</option>}
                  {choices.map(ch => (
                    <option key={ch.id ?? 'base'} value={ch.id ?? ''}>
                      {ch.name}{ch.factor > 1 ? ` (${num(ch.factor)})` : ''}{prim && ch.id === prim.id ? ` · ${tr('رئيسية')}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="input bg-[#FAF7F0] text-[#6E6557] truncate">{choice?.name || product?.unit || '—'}</p>
              )}
            </div>
          </div>
          <p className="text-[11px] text-[#9A8F7E]">{tr('صافي ما يبيعه المندوب من الصنف في الشهر بعد خصم المرتجع بالوحدة المختارة')}</p>
        </div>
      )}
      {d.kind === 'COLLECTION_PCT' && (
        <div>
          <p className="label">{tr('نسبة التحصيل')}</p>
          <NumField value={d.targetValue} onChange={x => set({ targetValue: x })} suffix="%" ariaLabel={tr('نسبة التحصيل')} />
          <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{tr('من ديون مبيعات المندوب الآجلة المفتوحة في بداية الشهر ويحتسب ما يحصل منها خلال الشهر')}</p>
        </div>
      )}

      {/* المكافأة */}
      <div>
        <p className="label">{tr('المكافأة')}</p>
        <div className="grid grid-cols-3 gap-2">
          {REWARD_KINDS.map(k => {
            const Icon = REWARD_ICONS[k.kind];
            const on = d.rewardKind === k.kind;
            return (
              <button key={k.kind} type="button" aria-pressed={on}
                onClick={() => set({ rewardKind: k.kind, rewardValue: on ? d.rewardValue : '' })}
                className={`flex flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 py-2.5 text-xs font-semibold transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:border-[#F0B9A5]'}`}>
                <Icon size={18} />
                <span className="leading-tight text-center">{tr(k.label)}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-2.5">
          {d.rewardKind === 'COMMISSION_SALES_PCT' && (
            <>
              <NumField value={d.rewardValue} onChange={x => set({ rewardValue: x })} suffix="%" ariaLabel={tr('نسبة العمولة')} />
              <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('من صافي مبيعات المندوب في الشهر كله وتستحق عند تحقق الهدف')}</p>
            </>
          )}
          {d.rewardKind === 'SALARY_PCT' && (
            <>
              <NumField value={d.rewardValue} onChange={x => set({ rewardValue: x })} suffix="%" ariaLabel={tr('نسبة من الراتب')} />
              <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('تظهر للمندوب نسبة فقط ولا يحفظ الراتب في النظام')}</p>
            </>
          )}
          {d.rewardKind === 'FIXED_AMOUNT' && (
            <>
              <NumField value={d.rewardValue} onChange={x => set({ rewardValue: x })} suffix={currency} ariaLabel={tr('مبلغ المكافأة')} />
              <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('تستحق عند تحقق الهدف')}</p>
            </>
          )}
        </div>
      </div>

      {/* ملاحظة للمندوب */}
      <div>
        <p className="label">{tr('ملاحظة للمندوب')} <span className="text-[#9A8F7E] font-normal">({tr('اختياري')})</span></p>
        <textarea className="input resize-none" rows={2} maxLength={TARGET_NOTE_MAX} value={d.note}
          onChange={e => set({ note: e.target.value })} aria-label={tr('ملاحظة للمندوب')} />
      </div>

      {/* معاينة ما يراه المندوب */}
      {preview && (
        <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2.5 text-xs">
          <p className="text-[#9A8F7E] mb-1">{tr('يظهر للمندوب')}</p>
          <p className="font-bold text-[#1F1A13]">{preview.title}{preview.goal && <> · <bdi>{preview.goal}</bdi></>}</p>
          <p className="text-[#6E6557] mt-0.5 flex items-center gap-1.5"><Trophy size={13} className="text-[#E15A30]" /> {preview.reward}</p>
        </div>
      )}

      {tried && problem && (
        <p className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-xl px-3 py-2">{tr(problem)}</p>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={saving} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
          {saving && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
          {tr('حفظ')}
        </button>
        <button type="button" onClick={onCancel} disabled={saving} className="btn-secondary">{tr('إلغاء')}</button>
      </div>
    </div>
  );
}
