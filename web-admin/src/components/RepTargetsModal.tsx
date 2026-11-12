import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Check, ChevronLeft, ChevronRight, Coins, HandCoins, Layers, MapPin, Package, Pencil, Percent, Plus, Target, Trash2, TrendingUp, Trophy, Unlink,
  UserPlus, Wallet, X,
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
  MAX_TARGET_PRODUCTS, MAX_TARGETS_PER_MONTH, REWARD_KINDS, REWARD_MAX, TARGET_KINDS, TARGET_NOTE_MAX, barPct, cleanDecimal, comboDone, daysLeftText,
  draftOf, draftProblem, emptyDraft, groupTargets, monthLabel, pctText, pickerSearchDropped, productPickerOptions, readNum, rewardText, shiftMonth,
  targetAmountText, targetErrorCode, targetErrorMessage, targetKindLabel, targetStateText, targetTitle, targetUnitText, toTargetInput, unitDriftText,
  unitFactorDrifts, unitRefreshFlag, type DraftExtraProduct, type RepRewardKind,
  type RepTargetComboInput, type RepTargetInput, type RepTargetKind, type RepTargetProductView, type RepTargetView, type RepTargetsData, type TargetDraft,
} from '../lib/repTargets';
import ConfirmDialog from './ConfirmDialog';
import SearchableSelect, { type SelectOption } from './SearchableSelect';

/** الصنف كما يصل من كاش الأصناف المشترك ['products-min'] (GET /products?limit=1000، ومعه الموقوف) */
interface ProductPick {
  id: string; name: string; code?: string; unit: string; status?: string;
  units?: UnitDef[] | null; primaryUnitId?: string | null;
}

/** حجم صفحة الأصناف المحمَّلة (الكاش المشترك) — قائمةٌ بلغته ناقصةٌ فيُبحث في الخادم (F12) */
const PRODUCTS_PAGE = 1000;

/** سطر صنفٍ في نموذج هدف الكمية بعد حلّه: الصنف من القائمة المحمَّلة (أو null) ووحدته، واسم لقطة الهدف المعدَّل حين يغيب عنها */
interface ProductLineState { productId: string | null; product: ProductPick | null; choice: UnitChoice | null; snapName: string | null }

const KIND_ICONS: Record<RepTargetKind, typeof Target> = {
  SALES_AMOUNT: TrendingUp, PRODUCT_QTY: Package, COLLECTION_PCT: HandCoins, VISITS_COUNT: MapPin, NEW_CUSTOMERS: UserPlus,
};
const REWARD_ICONS: Record<RepRewardKind, typeof Target> = { COMMISSION_SALES_PCT: Percent, SALARY_PCT: Wallet, FIXED_AMOUNT: Coins };

/** أرقام الكميات والنسب بلغة العرض وأرقام الشركة — بأربع منازل كأقصى ما يحفظه الخادم للكمية */
const num = (n: number) => Number(n).toLocaleString(activeLocale(), { maximumFractionDigits: 4 });
const money = (n: number) => formatCurrency(n);

/** زرّ اختيارٍ في شبكة الأنواع (نوع الهدف ونوع المكافأة) */
const pickClass = (on: boolean) =>
  `flex flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 py-2.5 text-xs font-semibold transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28]' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:border-[#F0B9A5]'}`;

/** وحدة صنفٍ من لقطة الهدف المعدَّل (القائمة لم تصل أو الصنف خارجها) — والخادم يتحقق ثانيةً */
const snapChoice = (s: RepTargetProductView | null): UnitChoice | null =>
  (s ? { id: s.unitId, name: s.unitName ?? '', factor: s.unitFactor || 1, price: null } : null);

/**
 * «هدف الشهر» لمندوبٍ (طلب المالك ٩ نوفمبر ٢٠٢٦) — من أيقونة في عمود الإجراءات بصفحة المناديب. أهداف الشهر بتقدّمها
 * ومكافأتها، وإضافةٌ وتعديلٌ في المكان وحذفٌ بتأكيد. الحساب كلّه في الخادم (/api/rep-targets) بشهر الشركة وتوقيتها:
 * أوّل فتحٍ بلا شهر فيردّ الخادم شهره الحالي، ثم الأسهم تتنقّل من شهر الردّ. ويظهر كل هدفٍ للمندوب في رئيسية تطبيقه.
 * و«دمج الأهداف» (١١ نوفمبر ٢٠٢٦): أهدافٌ مستقلة تُجمع في هدفٍ مدمج بمكافأةٍ واحدة تُستحق بتحقق كلها، ويُفكّ الدمج بزرّ.
 */
export default function RepTargetsModal({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const qc = useQueryClient();
  // null = «الشهر الحالي» كما يعرفه الخادم بتوقيت الشركة (لا ساعة المتصفّح)
  const [month, setMonth] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // معرّف الهدف المعدَّل، أو 'new'
  const [deleting, setDeleting] = useState<RepTargetView | null>(null);
  const [merging, setMerging] = useState(false); // لوحة «دمج أهداف» مفتوحة

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
    queryFn: async () => (await productApi.list({ limit: PRODUCTS_PAGE })).data.data as ProductPick[],
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

  const goMonth = (m: string | null) => { setEditing(null); setMerging(false); setMonth(m); };

  const save = useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: RepTargetInput }) => (id ? repTargetsApi.update(id, body) : repTargetsApi.create(rep.id, body)),
    onSuccess: async () => {
      toast.success(tr('تم حفظ الهدف'));
      setEditing(null);
      await qc.invalidateQueries({ queryKey: ['rep-targets', rep.id] });
    },
    onError: (e: unknown) => {
      toast.error(targetErrorMessage(e, tr, tr('تعذر الحفظ')));
      // وحدات الصنف تغيّرت منذ حُمّلت القائمة ⇒ تُجلب من جديد (ونتائج البحث معها) فيرى النموذج أساسه الحالي ووحداته
      if (isStaleUnitsError(e)) {
        void qc.invalidateQueries({ queryKey: ['products-min'] });
        void qc.invalidateQueries({ queryKey: ['rep-target-product-search'] });
      }
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
  // «دمج أهداف»: مكافأةٌ واحدة تُنسخ على الأعضاء — وفكّه يعيد كل عضوٍ مستقلاً بها
  const combine = useMutation({
    mutationFn: (body: RepTargetComboInput) => repTargetsApi.combine(body),
    onSuccess: async () => {
      toast.success(tr('تم دمج الأهداف'));
      setMerging(false);
      await qc.invalidateQueries({ queryKey: ['rep-targets', rep.id] });
    },
    onError: (e: unknown) => {
      toast.error(targetErrorMessage(e, tr, tr('تعذر دمج الأهداف')));
      // هدفٌ حُذف أو دُمج أو نُقل من مكانٍ آخر ⇒ تُعاد القائمة فتُرى حاله الآن
      const code = targetErrorCode(e);
      if (code === 'TARGET_NOT_FOUND' || code === 'TARGET_IN_COMBO' || code === 'TARGET_COMBO_INVALID') void q.refetch();
    },
  });
  const split = useMutation({
    mutationFn: (comboId: string) => repTargetsApi.uncombine(comboId),
    onSuccess: async () => {
      toast.success(tr('تم فصل الأهداف'));
      await qc.invalidateQueries({ queryKey: ['rep-targets', rep.id] });
    },
    onError: (e: unknown) => {
      toast.error(targetErrorMessage(e, tr, tr('تعذر فصل الأهداف')));
      if (targetErrorCode(e) === 'TARGET_NOT_FOUND') void q.refetch();
    },
  });

  /* هدفٌ يُعدَّل اختفى من القائمة (حذفه مستخدمٌ آخر فأعاد الجلبُ القائمةَ بدونه) ⇒ يُغلق نموذجه — وإلّا بقي `editing` على معرّفٍ
     غائب: لا نموذج، وأزرار البطاقات معطّلة، و«إضافة هدف» مخفيّة حتى تُغلق النافذة */
  useEffect(() => {
    if (editing && editing !== 'new' && data && !q.isPlaceholderData && !data.targets.some(t => t.id === editing)) setEditing(null);
  }, [data, editing, q.isPlaceholderData]);

  const targets = data?.targets ?? [];
  // المستقل والمدمج بترتيب الإنشاء (المدمج في موضع أول أعضائه)
  const groups = groupTargets(targets);
  // الأهداف المستقلة (خارج أي هدفٍ مدمج) — وحدها تُدمج
  const standalone = groups.flatMap(g => (g.kind === 'single' && !g.target.comboId ? [g.target] : []));
  const canMerge = standalone.length >= 2;
  const busy = editing !== null || merging;

  // لوحة الدمج مفتوحة وقلّت المستقلة عن اثنين (حُذفت أو دُمجت من مكانٍ آخر) ⇒ تُغلق
  useEffect(() => {
    if (merging && data && !q.isPlaceholderData && !canMerge) setMerging(false);
  }, [merging, data, canMerge, q.isPlaceholderData]);

  // نموذج الإضافة ولوحة الدمج في آخر القائمة — يُمرَّر إليهما حين يُفتحان
  const newFormRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing === 'new') newFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [editing]);
  const mergeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (merging) mergeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [merging]);

  const doneCount = targets.filter(t => t.progress.done).length;
  const atLimit = targets.length >= MAX_TARGETS_PER_MONTH;
  const future = !!data && !data.isCurrent && data.daysLeft > 0;
  const monthNote = !data ? '' : data.isCurrent ? daysLeftText(data.daysLeft, lang, tr, num) : future ? tr('لم يبدأ الشهر بعد') : tr('انتهى الشهر');
  const products = prodQ.data ?? [];

  /** هدفٌ في القائمة: نموذج تعديله في مكانه أو بطاقته (المدمجة بلا سطر مكافأة — مكافأة المدمج واحدةٌ تحت أعضائه) */
  const renderTarget = (t: RepTargetView, inCombo: boolean) => (editing === t.id ? (
    <TargetForm key={t.id} initial={draftOf(t)} original={t} inCombo={inCombo} products={products} productsLoading={prodQ.isLoading}
      productsError={productsError} onRetryProducts={retryProducts} saving={save.isPending} onCancel={() => setEditing(null)} onSave={body => save.mutate({ id: t.id, body })} />
  ) : (
    <TargetCard key={t.id} t={t} compact={inCombo} busy={busy}
      onEdit={() => setEditing(t.id)} onDelete={() => setDeleting(t)} />
  ));

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
              {/* R1: أرقام المشرف والمقيَّد بنطاقه (scoped) والمندوب يرى عمله كله — فلا يُحكم على «تحقق» أو مكافأةٍ دون علم */}
              {data.scoped && (
                <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">
                  {tr('الأرقام ضمن نطاقك وقد تختلف عما يراه المندوب')}
                </p>
              )}

              {targets.length === 0 && editing !== 'new' && (
                <div className="text-center py-8 px-4 border-2 border-dashed border-[#E9E1D3] rounded-2xl">
                  <div className="w-12 h-12 bg-[#FBEBE2] rounded-2xl flex items-center justify-center mx-auto mb-3"><Target size={22} className="text-[#E15A30]" /></div>
                  <p className="text-sm font-semibold text-[#1F1A13]">{tr('لا أهداف لهذا الشهر بعد')}</p>
                  <p className="text-xs text-[#6E6557] mt-1 leading-relaxed">{tr('أضف هدفا بمبلغ مبيعات أو كمية صنف أو نسبة تحصيل ويظهر للمندوب في صفحته الرئيسية')}</p>
                </div>
              )}

              {groups.map(g => (g.kind === 'single' ? renderTarget(g.target, false) : (
                <ComboGroup key={g.comboId} members={g.members} busy={busy} splitting={split.isPending && split.variables === g.comboId}
                  onSplit={() => split.mutate(g.comboId)}>
                  {g.members.map(m => renderTarget(m, true))}
                </ComboGroup>
              )))}

              {editing === 'new' && shownMonth && (
                <div ref={newFormRef}>
                  <TargetForm initial={emptyDraft(shownMonth)} original={null} products={products} productsLoading={prodQ.isLoading}
                    productsError={productsError} onRetryProducts={retryProducts} saving={save.isPending} onCancel={() => setEditing(null)} onSave={body => save.mutate({ id: null, body })} />
                </div>
              )}

              {merging && (
                <div ref={mergeRef}>
                  <ComboForm targets={standalone} saving={combine.isPending} onCancel={() => setMerging(false)} onSave={body => combine.mutate(body)} />
                </div>
              )}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-3 p-5 border-t border-[#E9E1D3]">
          {data && !busy && (
            atLimit
              ? <p className="flex-1 text-xs text-[#9A8F7E]">{tr('وصلت للحد الأعلى من الأهداف لهذا الشهر (20)')}</p>
              : (
                <button type="button" onClick={() => setEditing('new')} disabled={switching} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
                  <Plus size={16} /> {tr('إضافة هدف')}
                </button>
              )
          )}
          {data && !busy && canMerge && (
            <button type="button" onClick={() => setMerging(true)} disabled={switching} className="btn-secondary py-2.5 disabled:opacity-60">
              <Layers size={16} className="text-[#E15A30]" /> {tr('دمج أهداف')}
            </button>
          )}
          {(busy || !data) && <span className="flex-1" />}
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

/**
 * هدفٌ بتقدّمه: العنوان والشريط والمُنجَز من الهدف والنسبة، وسطر المكافأة والملاحظة. و`compact` عضوٌ في هدفٍ مدمج: بطاقةٌ أصغر
 * بلا سطر مكافأة (مكافأة المدمج واحدةٌ تحت أعضائه)، وتعديله وحذفه كالمستقل.
 */
function TargetCard({ t, busy, compact, onEdit, onDelete }: { t: RepTargetView; busy: boolean; compact?: boolean; onEdit: () => void; onDelete: () => void }) {
  const tr = useTr();
  const p = t.progress;
  const stateText = targetStateText(p);
  const KindIcon = KIND_ICONS[t.kind] ?? Target;
  return (
    <div className={`border ${compact ? 'rounded-xl p-3' : 'rounded-2xl p-4'} ${p.done ? 'border-[#BFE0CD] bg-[#F6FBF8]' : 'border-[#E9E1D3] bg-white'}`}>
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
            <bdi className={`text-sm font-extrabold ${p.done ? 'text-[#1E7A52]' : 'text-[#E15A30]'}`}>{pctText(p.pct, activeLocale(), p.done)}</bdi>
          </div>
          <div className="mt-1.5 h-2.5 rounded-full bg-[#F1EBDF] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barPct(p.pct, p.done)}>
            <div className={`h-full rounded-full transition-all ${p.done ? 'bg-[#2F855A]' : 'bg-[#E15A30]'}`} style={{ width: `${barPct(p.pct, p.done)}%` }} />
          </div>
          {t.kind === 'COLLECTION_PCT' && p.base != null && (
            <p className="text-[11px] text-[#6E6557] mt-1.5">{tr('الديون المفتوحة بداية الشهر')}: <bdi className="font-semibold">{formatCurrency(p.base)}</bdi></p>
          )}
        </div>
      )}

      {!compact && (
        <p className={`mt-2.5 text-xs flex items-center gap-1.5 ${t.reward.earned ? 'text-[#1E7A52] font-semibold' : 'text-[#6E6557]'}`}>
          <Trophy size={14} className={t.reward.earned ? 'text-[#2F855A]' : 'text-[#E15A30]'} />
          <span>{rewardText(t, tr, money, num)}</span>
        </p>
      )}
      {t.note && <p className="mt-2 text-[11px] text-[#6E6557] bg-[#FAF7F0] rounded-lg px-3 py-2 leading-relaxed whitespace-pre-line break-words">{t.note}</p>}
    </div>
  );
}

/**
 * هدفٌ مدمج: أعضاؤه كلٌّ بتقدّمه (بطاقةٌ مدمجة أو نموذج تعديله في مكانه)، ثم مكافأةٌ واحدة — منسوخةٌ على الأعضاء فتُقرأ من
 * أولهم، وتُستحق حين تتحقق كلها (comboDone). و«فصل الأهداف» يعيد كل عضوٍ مستقلاً بالمكافأة نفسها.
 */
function ComboGroup({ members, busy, splitting, onSplit, children }: {
  members: RepTargetView[]; busy: boolean; splitting: boolean; onSplit: () => void; children: ReactNode;
}) {
  const tr = useTr();
  const done = comboDone(members);
  const doneMembers = members.filter(m => m.progress.done).length;
  const first = members[0];
  return (
    <div className={`rounded-2xl border-2 p-3 space-y-2.5 ${done ? 'border-[#BFE0CD] bg-[#F6FBF8]' : 'border-[#F0B9A5] bg-[#FFFCF8]'}`}>
      <div className="flex items-start gap-3 px-1 pt-0.5">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${done ? 'bg-[#E4F1EA]' : 'bg-[#FBEBE2]'}`}>
          <Layers size={17} className={done ? 'text-[#1E7A52]' : 'text-[#E15A30]'} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-[#1F1A13] leading-snug">{tr('هدف مدمج')}</p>
          <p className="text-[11px] text-[#9A8F7E] mt-0.5">{tr('يتحقق بتحقق كل الأهداف')}</p>
        </div>
        {done ? (
          <span className="badge-active gap-1 whitespace-nowrap shrink-0"><Check size={12} /> {tr('تحقق الهدف')}</span>
        ) : (
          <p className="text-sm font-extrabold text-[#E15A30] shrink-0">
            {num(doneMembers)} <span className="text-xs font-bold text-[#9A8F7E]">/ {num(members.length)}</span>
          </p>
        )}
      </div>

      <div className="space-y-2">{children}</div>

      <div className="flex items-center justify-between gap-3 px-1">
        <p className={`text-xs flex items-center gap-1.5 min-w-0 ${done ? 'text-[#1E7A52] font-semibold' : 'text-[#6E6557]'}`}>
          <Trophy size={14} className={`shrink-0 ${done ? 'text-[#2F855A]' : 'text-[#E15A30]'}`} />
          <span>{rewardText(first, tr, money, num)}</span>
        </p>
        <button type="button" onClick={onSplit} disabled={busy || splitting}
          className="shrink-0 flex items-center gap-1 text-xs font-semibold text-[#E15A30] hover:bg-[#FBEBE2] rounded-lg px-2 py-1.5 disabled:opacity-40">
          {splitting ? <span className="w-3 h-3 border-2 border-[#E15A30]/30 border-t-[#E15A30] rounded-full animate-spin" /> : <Unlink size={13} />}
          {tr('فصل الأهداف')}
        </button>
      </div>
    </div>
  );
}

/** خانة رقمٍ عشريّ تقبل الأرقام العربية والفاصلة، ووحدتها (العملة أو % أو وحدة الصنف) بجانبها — و`integer` للعدّ بلا كسور */
function NumField({ value, onChange, suffix, ariaLabel, autoFocus, integer }: {
  value: string; onChange: (v: string) => void; suffix?: string; ariaLabel: string; autoFocus?: boolean; integer?: boolean;
}) {
  return (
    <div className="relative">
      <input type="text" inputMode={integer ? 'numeric' : 'decimal'} dir="ltr" autoFocus={autoFocus} aria-label={ariaLabel}
        className={`input text-left ${suffix ? 'pr-16' : ''}`} value={value}
        onChange={e => { const c = cleanDecimal(e.target.value); if (c !== null && !(integer && c.includes('.'))) onChange(c); }} />
      {suffix && <span className="absolute right-3 top-1/2 -translate-y-1/2 max-w-[3.25rem] truncate text-xs font-semibold text-[#9A8F7E] pointer-events-none">{suffix}</span>}
    </div>
  );
}

/** المكافأة: نوعها ثلاثة أزرار ثم قيمتها بوحدتها وشرحها — لنموذج الهدف ونموذج الدمج. و`note` سطرٌ إضافي تحتها */
function RewardFields({ kind, value, onChange, note }: {
  kind: RepRewardKind; value: string; onChange: (kind: RepRewardKind, value: string) => void; note?: string;
}) {
  const tr = useTr();
  const currency = getActiveCurrency();
  return (
    <div>
      <p className="label">{tr('المكافأة')}</p>
      <div className="grid grid-cols-3 gap-2">
        {REWARD_KINDS.map(k => {
          const Icon = REWARD_ICONS[k.kind];
          const on = kind === k.kind;
          return (
            <button key={k.kind} type="button" aria-pressed={on} onClick={() => onChange(k.kind, on ? value : '')} className={pickClass(on)}>
              <Icon size={18} />
              <span className="leading-tight text-center">{tr(k.label)}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-2.5">
        {kind === 'COMMISSION_SALES_PCT' && (
          <>
            <NumField value={value} onChange={x => onChange(kind, x)} suffix="%" ariaLabel={tr('نسبة العمولة')} />
            <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('من صافي مبيعات المندوب في الشهر كله وتستحق عند تحقق الهدف')}</p>
          </>
        )}
        {kind === 'SALARY_PCT' && (
          <>
            <NumField value={value} onChange={x => onChange(kind, x)} suffix="%" ariaLabel={tr('نسبة من الراتب')} />
            <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('تظهر للمندوب نسبة فقط ولا يحفظ الراتب في النظام')}</p>
          </>
        )}
        {kind === 'FIXED_AMOUNT' && (
          <>
            <NumField value={value} onChange={x => onChange(kind, x)} suffix={currency} ariaLabel={tr('مبلغ المكافأة')} />
            <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('تستحق عند تحقق الهدف')}</p>
          </>
        )}
        {note && <p className="text-[11px] text-[#6E6557] mt-1.5 leading-relaxed">{note}</p>}
      </div>
    </div>
  );
}

/** خيار الصنف في المنتقي: الاسم، ثم الكود والوحدة و«موقوف» */
const productOption = (p: ProductPick, tr: (s: string) => string): SelectOption => ({
  value: p.id,
  label: p.name,
  hint: [p.code, productUnitLabel(p, num), p.status === 'INACTIVE' ? tr('موقوف') : ''].filter(Boolean).join(' · '),
});

/**
 * سطر صنفٍ في هدف الكمية: المنتقي ووحدة الصنف بجانبه (وزرّ إزالةٍ للإضافي). الوحدة من الصنف المحمَّل (unitChoices)، وبلا صنفٍ
 * محمَّل لقطة الهدف المعدَّل نصّاً — ووحدةٌ أُوقفت بعد إنشاء الهدف لا تُستبدل صامتةً: «اختر الوحدة» حتى يختارها المستخدم.
 * و`searchable` قائمةٌ محمَّلة ناقصة (F12): ما يُكتب يُبحث به في الخادم (لكل سطرٍ بحثه)، والصنف المختار منه يُردّ بصفّه.
 */
function ProductLine({ line, loaded, taken, searchable, loading, first, onPick, onUnit, onRemove }: {
  line: ProductLineState; loaded: SelectOption[]; taken: ReadonlySet<string>; searchable: boolean; loading: boolean; first: boolean;
  onPick: (id: string, row?: ProductPick) => void; onUnit: (unitId: string | null) => void; onRemove?: () => void;
}) {
  const tr = useTr();
  const { product, choice } = line;
  const choices = product ? unitChoices(product) : [];
  const prim = product ? primaryUnitOf(product) : null;

  // بحث الخادم بمهلة ٣٠٠ms كمنتقي قوائم الأسعار — وحتى يصل ردّه تُصفّى القائمة المحمَّلة محلياً
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const v = typed.trim();
    if (v === q) return;
    const t = setTimeout(() => setQ(v), 300);
    return () => clearTimeout(t);
  }, [typed, q]);
  // R7: إغلاق المنتقي بنقرةٍ خارجه يفرّغ حقل بحثه ولا يُبلغنا — فيُصفَّر البحث هنا معه، وإلا صفّى القائمة عند إعادة فتحها بنصٍّ خفيّ.
  // طور الالتقاط: يُقرأ المنتقي مفتوحاً قبل معالج إغلاقه (فقاعةٌ على document يُرسم بعدها مغلقاً قبل أن يصلنا دورنا)
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (typed === '') return;
    const h = (e: MouseEvent) => { if (pickerSearchDropped(pickerRef.current, e.target)) { setTyped(''); setQ(''); } };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, [typed]);
  const searchQ = useQuery({
    queryKey: ['rep-target-product-search', q],
    queryFn: async () => (await productApi.list({ search: q, limit: 50 })).data.data as ProductPick[],
    enabled: searchable && q !== '',
    staleTime: 60_000,
  });
  const live = searchable && q !== '' && q === typed.trim() && Array.isArray(searchQ.data) ? searchQ.data : null;
  // صنف السطر نفسه في المنتقي ولو خارج القائمة: المحمَّل أو المختار من البحث، وإلّا اسم لقطة الهدف المعدَّل
  const current: SelectOption | null = product ? productOption(product, tr)
    : line.productId && line.snapName ? { value: line.productId, label: line.snapName } : null;
  const options = productPickerOptions(loaded, searchable ? typed : '', live ? live.map(p => productOption(p, tr)) : null, taken, current);
  const waiting = searchable && typed.trim() !== '' && !live && !searchQ.isError;
  const pick = (id: string) => {
    setTyped(''); setQ('');
    onPick(id, live?.find(p => p.id === id));
  };
  return (
    <div>
      <div className={`grid gap-2 items-end ${onRemove ? 'grid-cols-[minmax(0,1fr)_7.5rem_auto]' : 'grid-cols-[minmax(0,1fr)_7.5rem]'}`}>
        <div className="min-w-0">
          {first && <p className="label">{tr('الصنف')}</p>}
          <div ref={pickerRef}>
            <SearchableSelect options={options} value={line.productId ?? ''} onChange={pick} loading={loading || (waiting && options.length === 0)}
              onSearchChange={searchable ? setTyped : undefined} placeholder={tr('اختر الصنف')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
          </div>
        </div>
        <div className="min-w-0">
          {first && <p className="label">{tr('الوحدة')}</p>}
          {product && (choices.length > 1 || !choice) ? (
            <select className="input" value={choice ? (choice.id ?? '') : '__none'} aria-label={tr('الوحدة')}
              onChange={e => onUnit(e.target.value || null)}>
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
        {onRemove && (
          <button type="button" onClick={onRemove} className="p-2.5 hover:bg-red-50 rounded-xl text-red-600"
            title={tr('حذف الصنف')} aria-label={tr('حذف الصنف')}><Trash2 size={15} /></button>
        )}
      </div>
    </div>
  );
}

/**
 * نموذج الهدف في مكانه (إضافة أو تعديل): النوع خمسة أزرار، ثم قيمته (مبلغ · أصنافٌ بوحداتها وكميةٌ واحدة · نسبة · عدد)، ثم
 * المكافأة وقيمتها، ثم ملاحظة للمندوب. التحقق بحدود الخادم نفسها قبل الإرسال (`draftProblem`)، والكمية تُرسل بوحدتها كما كُتبت.
 * و`inCombo` عضوٌ في هدفٍ مدمج: مكافأته مشتركة — يُقال ذلك تحتها (الخادم ينسخها على الأعضاء كلهم).
 */
function TargetForm({ initial, original, inCombo, products, productsLoading, productsError, onRetryProducts, saving, onCancel, onSave }: {
  initial: TargetDraft; original: RepTargetView | null; inCombo?: boolean; products: ProductPick[]; productsLoading: boolean;
  /** تعذّر تحميل الأصناف (بلا صلاحية الأصناف أو انقطاع) — يُقال تحت المنتقي */
  productsError: string | null; onRetryProducts: (() => void) | null; saving: boolean;
  onCancel: () => void; onSave: (body: RepTargetInput) => void;
}) {
  const tr = useTr();
  const [d, setD] = useState<TargetDraft>(initial);
  const [tried, setTried] = useState(false);
  // F4: «اعتمد حجم الوحدة الحالي» — بلا هذا القرار الصريح يبقى الهدف بالحجم المحفوظ
  const [refreshUnits, setRefreshUnits] = useState(false);
  // أصنافٌ اختيرت من بحث الخادم خارج القائمة المحمَّلة (F12) — بها تُحلّ وحدتها وأساسها كالمحمَّلة
  const [found, setFound] = useState<Record<string, ProductPick>>({});
  const set = (patch: Partial<TargetDraft>) => setD(prev => ({ ...prev, ...patch }));
  const setExtra = (i: number, patch: Partial<DraftExtraProduct>) =>
    setD(prev => ({ ...prev, extraProducts: prev.extraProducts.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));
  const currency = getActiveCurrency();

  /* لقطات الهدف المعدَّل (الصنف الأول ثم الإضافية) — خادمٌ أقدم بلا `products` ⇒ الصنف الواحد. تُقرأ منها وحدة صنفٍ لم تصل
     قائمته أو خرج منها، والخادم يتحقق ثانيةً */
  const snaps = useMemo<RepTargetProductView[]>(() => (!original ? []
    : original.products?.length ? original.products
      : [{ productId: original.productId, productName: original.productName, unitId: original.unitId, unitName: original.unitName, unitFactor: original.unitFactor }]),
  [original]);
  const snapOf = (id: string | null) => (id ? snaps.find(s => s.productId === id) ?? null : null);

  const productOf = (id: string | null): ProductPick | null => (id ? products.find(p => p.id === id) ?? found[id] ?? null : null);
  const product = productOf(d.productId);
  const mainSnap = product ? null : snapOf(d.productId);
  /* وحدة الهدف: من الصنف المحمَّل، وإلّا (القائمة لم تصل أو الصنف خارجها) لقطة الهدف المعدَّل نفسه — والخادم يتحقق ثانيةً.
     ووحدةٌ أُوقفت بعد إنشاء الهدف لا تُستبدل صامتةً بغيرها: «١٠ كرتون» ليست «١٠ حبة» */
  const choice: UnitChoice | null = product ? choiceById(product, d.unitId) : snapChoice(mainSnap);
  // الأصناف الإضافية بالمنطق نفسه، كلٌّ بوحدته
  const extraLines: ProductLineState[] = d.extraProducts.map(e => {
    const p = productOf(e.productId);
    const snap = p ? null : snapOf(e.productId);
    return { productId: e.productId, product: p, choice: p ? choiceById(p, e.unitId) : snapChoice(snap), snapName: snap?.productName ?? null };
  });
  const lines: ProductLineState[] = [{ productId: d.productId, product, choice, snapName: mainSnap?.productName ?? null }, ...extraLines];

  const options = useMemo(() => products.map(p => productOption(p, tr)), [products, tr]);
  // القائمة المحمَّلة بلغت حجم صفحتها ⇒ قد تنقصها أصناف: البحث في الخادم (F12)
  const searchable = products.length >= PRODUCTS_PAGE;
  // منتقي كل سطرٍ بلا الأصناف المختارة في الأسطر الأخرى (الصنف لا يتكرر في الهدف)
  const takenFor = (idx: number): ReadonlySet<string> => new Set(lines.flatMap((l, i) => (i !== idx && l.productId ? [l.productId] : [])));

  const productKind = d.kind === 'PRODUCT_QTY';
  // صنفٌ بلا وحدةٍ قابلة للحلّ (أي سطر) يُرفض كالأول
  const unitMissing = productKind && lines.some(l => l.productId && !l.choice);
  const problem = draftProblem(d) ?? (unitMissing ? 'وحدة الصنف غير صحيحة' : null);
  // F4: أسطرٌ بقي صنفها ووحدتها وتغيّر حجم وحدتها بعد إنشاء الهدف — تنبيهٌ صريح، والخادم يُبقي المحفوظ ما لم يُعتمد الحالي
  const drifts = productKind ? unitFactorDrifts(snaps, [{ productId: d.productId, unitId: d.unitId }, ...d.extraProducts]) : [];
  const submit = () => {
    setTried(true);
    if (problem) return;
    // أساس كل صنفٍ كما في القائمة المحمَّلة: حُوِّل منذئذٍ ⇒ يرفض الخادم بدل أن يقرأ «١٠٠ كرتون» مئة حبّة
    const extras = productKind
      ? extraLines.flatMap(l => (l.productId ? [{ productId: l.productId, unit: l.choice, baseUnitName: l.product?.unit ?? null }] : []))
      : [];
    onSave({ ...toTargetInput(d, choice, product?.unit ?? null, extras), ...unitRefreshFlag(drifts, refreshUnits) });
  };

  // صفّ نتيجة البحث يُحفظ لصنفٍ خارج القائمة المحمَّلة (والأحدث يحلّ محلّ الأقدم: وحداتٌ تغيّرت منذ اختياره)
  const remember = (id: string, row?: ProductPick): ProductPick | null => {
    if (row && !products.some(x => x.id === id)) setFound(prev => ({ ...prev, [id]: row }));
    return products.find(x => x.id === id) ?? row ?? found[id] ?? null;
  };
  // الصنف نفسه ثانيةً (لقطته في المنتقي أو نتيجة بحثٍ أحدث) لا يبدّل وحدته
  const pickProduct = (id: string, row?: ProductPick) => {
    const p = remember(id, row);
    if (id === d.productId) return;
    set({ productId: id, unitId: p ? defaultChoice(p).id : null });
  };
  const pickExtra = (i: number, id: string, row?: ProductPick) => {
    const p = remember(id, row);
    if (id === d.extraProducts[i]?.productId) return;
    setExtra(i, { productId: id, unitId: p ? defaultChoice(p).id : null });
  };
  const addExtra = () => setD(prev => ({ ...prev, extraProducts: [...prev.extraProducts, { productId: null, unitId: null }] }));
  const removeExtra = (i: number) => setD(prev => ({ ...prev, extraProducts: prev.extraProducts.filter((_, j) => j !== i) }));

  // أصناف الهدف للعنوان والوحدة المشتركة («١٢ كرتون»؛ وحداتٌ مختلفة ⇒ رقمٌ بلا وحدة) — كما يعرضها المندوب
  const lineViews = productKind ? lines.map(l => ({ productName: l.product?.name ?? l.snapName, unitName: l.choice?.name ?? null })) : null;
  const qtyUnit = lineViews ? targetUnitText({ unitName: choice?.name ?? null, products: lineViews }) : '';

  const v = readNum(d.targetValue);
  const preview = !problem ? {
    title: targetTitle({ kind: d.kind, targetValue: Number(v), productName: lineViews?.[0]?.productName ?? null, unitName: choice?.name ?? null, products: lineViews }, tr, num),
    goal: d.kind === 'COLLECTION_PCT' ? null : targetAmountText({ kind: d.kind, unitName: choice?.name ?? null, products: lineViews }, Number(v), money, num),
    reward: rewardText({ rewardKind: d.rewardKind, rewardValue: Number(readNum(d.rewardValue)), reward: { kind: d.rewardKind, value: 0, amount: d.rewardKind === 'FIXED_AMOUNT' ? Number(readNum(d.rewardValue)) : null, earned: false } }, tr, money, num),
  } : null;

  return (
    <div className="rounded-2xl border-2 border-[#E15A30]/40 bg-[#FFFCF8] p-4 space-y-4">
      <p className="text-sm font-bold text-[#1F1A13]">{original ? tr('تعديل الهدف') : tr('إضافة هدف')}</p>

      {/* نوع الهدف — خمسة: ثلاثة في الصف على الشاشة الضيقة وخمسة على العريضة */}
      <div>
        <p className="label">{tr('نوع الهدف')}</p>
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
          {TARGET_KINDS.map(k => {
            const Icon = KIND_ICONS[k.kind];
            const on = d.kind === k.kind;
            return (
              <button key={k.kind} type="button" aria-pressed={on}
                onClick={() => set({ kind: k.kind, targetValue: on ? d.targetValue : '' })} className={pickClass(on)}>
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
          {/* الأصناف: الأول ثم الإضافية، لكلٍّ وحدته — والكمية واحدةٌ مجموعها */}
          <div className="space-y-2">
            <ProductLine line={lines[0]} loaded={options} taken={takenFor(0)} searchable={searchable} loading={productsLoading} first
              onPick={pickProduct} onUnit={unitId => set({ unitId })} />
            {extraLines.map((line, i) => (
              <ProductLine key={line.productId ?? `row-${i}`} line={line} loaded={options} taken={takenFor(i + 1)} searchable={searchable}
                loading={productsLoading} first={false}
                onPick={(id, row) => pickExtra(i, id, row)} onUnit={unitId => setExtra(i, { unitId })} onRemove={() => removeExtra(i)} />
            ))}
            {productsError && (
              <p className="text-[11px] text-red-600 flex items-center gap-2">
                <span>{productsError}</span>
                {onRetryProducts && (
                  <button type="button" onClick={onRetryProducts} className="shrink-0 font-semibold underline">{tr('إعادة المحاولة')}</button>
                )}
              </p>
            )}
            {lines.length < MAX_TARGET_PRODUCTS && (
              <button type="button" onClick={addExtra}
                className="flex items-center gap-1 text-xs font-semibold text-[#E15A30] hover:bg-[#FBEBE2] rounded-lg px-2 py-1.5">
                <Plus size={14} /> {tr('إضافة صنف آخر')}
              </button>
            )}
          </div>
          {drifts.length > 0 && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-900 px-3 py-2.5 text-xs space-y-1.5">
              <p className="font-semibold">{tr('تغير حجم الوحدة بعد إنشاء الهدف')}</p>
              {drifts.map(x => <p key={x.productId}>{unitDriftText(x, tr, num, productOf(x.productId)?.unit)}</p>)}
              <p className="text-amber-800">{tr('يبقى الهدف بالحجم القديم ما لم تعتمد الحجم الحالي')}</p>
              <label className="flex items-center gap-2 font-semibold cursor-pointer pt-0.5">
                <input type="checkbox" className="w-4 h-4 shrink-0 accent-[#E15A30]" checked={refreshUnits} onChange={e => setRefreshUnits(e.target.checked)} />
                {tr('اعتمد حجم الوحدة الحالي')}
              </label>
            </div>
          )}
          <div>
            <p className="label">{tr('الكمية المستهدفة')}</p>
            <NumField value={d.targetValue} onChange={x => set({ targetValue: x })} suffix={qtyUnit || undefined} ariaLabel={tr('الكمية المستهدفة')} />
            <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">
              {extraLines.length
                ? tr('مجموع صافي ما يبيعه المندوب من الأصناف المختارة في الشهر بعد خصم المرتجع كل صنف بوحدته')
                : tr('صافي ما يبيعه المندوب من الصنف في الشهر بعد خصم المرتجع بالوحدة المختارة')}
            </p>
          </div>
        </div>
      )}
      {d.kind === 'COLLECTION_PCT' && (
        <div>
          <p className="label">{tr('نسبة التحصيل')}</p>
          <NumField value={d.targetValue} onChange={x => set({ targetValue: x })} suffix="%" ariaLabel={tr('نسبة التحصيل')} />
          <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{tr('من ديون مبيعات المندوب الآجلة المفتوحة في بداية الشهر ويحتسب ما يحصل منها خلال الشهر')}</p>
        </div>
      )}
      {d.kind === 'VISITS_COUNT' && (
        <div>
          <p className="label">{tr('عدد الزيارات')}</p>
          <NumField integer value={d.targetValue} onChange={x => set({ targetValue: x })} ariaLabel={tr('عدد الزيارات')} />
          <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{tr('عدد زيارات المندوب للعملاء خلال الشهر وتحسب الزيارة المؤقتة وملاحظتها زيارة واحدة')}</p>
        </div>
      )}
      {d.kind === 'NEW_CUSTOMERS' && (
        <div>
          <p className="label">{tr('عدد العملاء')}</p>
          <NumField integer value={d.targetValue} onChange={x => set({ targetValue: x })} ariaLabel={tr('عدد العملاء')} />
          <p className="text-[11px] text-[#9A8F7E] mt-1 leading-relaxed">{tr('عملاء يضيفهم المندوب خلال الشهر ولهم فاتورة بيع مؤكدة حتى نهايته')}</p>
        </div>
      )}

      {/* المكافأة — عضو الهدف المدمج يعدّلها للأعضاء كلهم */}
      <RewardFields kind={d.rewardKind} value={d.rewardValue} onChange={(rewardKind, rewardValue) => set({ rewardKind, rewardValue })}
        note={inCombo ? tr('المكافأة مشتركة بين الأهداف المدمجة وتعديلها يسري عليها كلها') : undefined} />

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

/**
 * «دمج أهداف» في مكانه: أهداف الشهر المستقلة بخانات اختيار (اثنان فأكثر)، ثم مكافأةٌ واحدة للهدف المدمج تحلّ محلّ مكافآت
 * أعضائه وتُستحق بتحققهم كلهم. حدود المكافأة حدود نموذج الهدف نفسها (REWARD_MAX) وعباراتها، والخادم الحَكَم.
 */
function ComboForm({ targets, saving, onCancel, onSave }: {
  targets: RepTargetView[]; saving: boolean; onCancel: () => void; onSave: (body: RepTargetComboInput) => void;
}) {
  const tr = useTr();
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [rewardKind, setRewardKind] = useState<RepRewardKind>('COMMISSION_SALES_PCT');
  const [rewardValue, setRewardValue] = useState('');
  const [tried, setTried] = useState(false);

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // المختارة بترتيب القائمة — وما اختفى منها (حُذف أو دُمج من مكانٍ آخر) لا يُرسل
  const ids = targets.filter(t => picked.has(t.id)).map(t => t.id);
  const r = readNum(rewardValue);
  const rewardOk = r !== null && !Number.isNaN(r) && r > 0 && r <= REWARD_MAX[rewardKind];
  const problem = ids.length < 2 ? tr('اختر هدفين أو أكثر للدمج')
    : rewardOk ? null
      : rewardKind === 'COMMISSION_SALES_PCT' ? tr('نسبة العمولة أكبر من صفر وحتى 100')
        : rewardKind === 'SALARY_PCT' ? tr('نسبة الراتب أكبر من صفر وحتى 1000')
          : r === null || Number.isNaN(r) || r <= 0 ? tr('مبلغ المكافأة رقم أكبر من صفر') : tr('مبلغ المكافأة كبير جدا');

  const submit = () => {
    setTried(true);
    if (problem) return;
    onSave({ targetIds: ids, rewardKind, rewardValue: Number(r) });
  };

  return (
    <div className="rounded-2xl border-2 border-[#E15A30]/40 bg-[#FFFCF8] p-4 space-y-4">
      <div>
        <p className="text-sm font-bold text-[#1F1A13] flex items-center gap-2"><Layers size={16} className="text-[#E15A30]" /> {tr('دمج أهداف')}</p>
        <p className="text-[11px] text-[#9A8F7E] mt-0.5">{tr('يتحقق بتحقق كل الأهداف')}</p>
      </div>

      {/* الأهداف المستقلة */}
      <div>
        <p className="label">{tr('اختر هدفين أو أكثر للدمج')}</p>
        <div className="space-y-2">
          {targets.map(t => {
            const on = picked.has(t.id);
            const KindIcon = KIND_ICONS[t.kind] ?? Target;
            return (
              <label key={t.id} className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2]' : 'border-[#E9E1D3] bg-white hover:border-[#F0B9A5]'}`}>
                <input type="checkbox" className="w-4 h-4 shrink-0 accent-[#E15A30]" checked={on} onChange={() => toggle(t.id)} />
                <KindIcon size={16} className="shrink-0 text-[#E15A30]" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-[#1F1A13] leading-snug break-words">{targetTitle(t, tr, num)}</span>
                  <span className="block text-[11px] text-[#9A8F7E] mt-0.5">
                    {tr(targetKindLabel(t.kind))}
                    {t.kind !== 'COLLECTION_PCT' && <> · <bdi>{targetAmountText(t, t.targetValue, money, num)}</bdi></>}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>

      <RewardFields kind={rewardKind} value={rewardValue} onChange={(k, x) => { setRewardKind(k); setRewardValue(x); }}
        note={tr('مكافأة الهدف المدمج تحل محل مكافآت الأهداف المختارة وتستحق عند تحققها كلها')} />

      {tried && problem && (
        <p className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-xl px-3 py-2">{problem}</p>
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
