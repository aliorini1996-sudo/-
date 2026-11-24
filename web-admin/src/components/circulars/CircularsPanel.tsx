import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Megaphone, Plus, Search, Eye, Undo2, ArrowRight, CheckCheck, Clock, RefreshCw, Send, AlertTriangle } from 'lucide-react';
import { circularsApi, salesRepApi, companyUserApi } from '../../api/client';
import ConfirmDialog from '../ConfirmDialog';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { formatDate, formatDateTime } from '../../utils/format';
import {
  CIRCULAR_BODY_MAX, CIRCULAR_TITLE_MAX, buildCircularBody, canWithdrawCircular, circularCandidates, circularReadsKey,
  circularViewState, circularsKey, filterPeopleByName, localDayOf, readPct, validateCircularDraft,
  type CircularAudience, type CircularCreateBody, type CircularFormError, type CircularPerson, type CircularReads,
  type CircularRow, type CircularViewState,
} from '../../lib/circulars';

/**
 * لوحة «التعميمات» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — تفتحها صفحة المناديب (audience=REPS) وصفحة مستخدمي الشركة (audience=USERS)
 * في PagePanelModal: قائمة التعميمات بتقدّم قراءتها، ونموذج «تعميم جديد» (الكل أو محددون، وانتهاءٌ اختياري)، وتفاصيل من قرأ ومن
 * لم يقرأ بعد، وسحب التعميم النشط. التعميم لا يُعدَّل بعد نشره (لا مسار تعديل) — يُسحب ويُنشر غيره.
 * onDirtyChange: مسوّدةٌ لم تُنشر ⇒ true، فتسأل النافذة قبل الإغلاق (confirmClose) ولا يضيع نصٌّ طويل بنقرةٍ خارجها.
 */
type Err = { response?: { data?: { message?: string } } };
type View = { kind: 'list' } | { kind: 'new' } | { kind: 'reads'; id: string };

const Spinner = () => (
  <div className="flex items-center justify-center h-32"><div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>
);

/** رسالة الخادم مترجمةً (القاموس يحمل رسائل /api/circulars) — وإلا البديل */
function useErrText() {
  const tr = useTr();
  return (e: unknown, fallback: string) => {
    const m = (e as Err)?.response?.data?.message;
    return m ? tr(m) : fallback;
  };
}

export default function CircularsPanel({ audience, onDirtyChange }: {
  audience: CircularAudience;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const errText = useErrText();
  const isReps = audience === 'REPS';
  const [view, setView] = useState<View>({ kind: 'list' });
  const [withdrawing, setWithdrawing] = useState<CircularRow | null>(null);

  const listQ = useQuery({
    queryKey: circularsKey(audience),
    queryFn: async () => (await circularsApi.list(audience)).data.data as CircularRow[],
  });
  const rows = listQ.data ?? [];

  const withdraw = useMutation({
    mutationFn: (id: string) => circularsApi.withdraw(id),
    onSuccess: () => { toast.success(tr('تم سحب التعميم')); setWithdrawing(null); },
    onError: (e) => { toast.error(errText(e, tr('تعذر سحب التعميم'))); setWithdrawing(null); },
    onSettled: () => qc.invalidateQueries({ queryKey: circularsKey(audience) }),
  });

  const openRow = view.kind === 'reads' ? rows.find((r) => r.id === view.id) ?? null : null;
  // التفاصيل لصفٍّ اختفى من القائمة (حُدِّثت) ⇒ عودةٌ للقائمة بدل شاشةٍ فارغة
  useEffect(() => {
    if (view.kind === 'reads' && listQ.isSuccess && !openRow) setView({ kind: 'list' });
  }, [view, listQ.isSuccess, openRow]);

  return (
    <div className="space-y-4">
      {view.kind === 'list' && (
        <>
          <div className="card">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <h2 className="font-bold text-[#1F1A13] flex items-center gap-2">
                  <Megaphone size={18} className="text-[#E15A30]" /> {isReps ? tr('تعميمات المناديب') : tr('تعميمات مستخدمي الشركة')}
                </h2>
                <p className="text-sm text-[#6E6557] mt-1 leading-relaxed">
                  {isReps
                    ? tr('قرار أو إعلان إداري يظهر للمندوب في نافذة صغيرة حين يفتح التطبيق ولا تختفي حتى يضغط تمت القراءة')
                    : tr('قرار أو إعلان إداري يظهر للمستخدم في نافذة صغيرة حين يفتح النظام ولا تختفي حتى يضغط تمت القراءة')}
                </p>
              </div>
              <button type="button" className="btn-primary shrink-0" onClick={() => setView({ kind: 'new' })}>
                <Plus size={16} /> {tr('تعميم جديد')}
              </button>
            </div>
          </div>

          {listQ.isLoading ? (
            <div className="card"><Spinner /></div>
          ) : listQ.isError ? (
            <div className="card text-center py-8" role="alert">
              <p className="text-sm text-[#8E2A1F] flex items-center justify-center gap-2"><AlertTriangle size={16} /> {errText(listQ.error, tr('تعذر جلب التعميمات'))}</p>
              <button type="button" className="btn-secondary mx-auto mt-3" onClick={() => listQ.refetch()}><RefreshCw size={14} /> {tr('إعادة المحاولة')}</button>
            </div>
          ) : rows.length === 0 ? (
            <div className="card text-center py-10">
              <span className="w-12 h-12 rounded-2xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center mx-auto"><Megaphone size={22} /></span>
              <p className="font-semibold text-[#1F1A13] mt-3">{tr('لا توجد تعميمات بعد')}</p>
              <p className="text-xs text-[#9A8F7E] mt-1">{tr('انشر أول تعميم وتابع من قرأه ومن لم يقرأه بعد')}</p>
            </div>
          ) : (
            <div className="card p-0 divide-y divide-[#F1EBDF] overflow-hidden">
              {rows.map((r) => (
                <CircularItem key={r.id} row={r} isReps={isReps}
                  onOpen={() => setView({ kind: 'reads', id: r.id })}
                  onWithdraw={() => setWithdrawing(r)} />
              ))}
            </div>
          )}
        </>
      )}

      {view.kind === 'new' && (
        <CircularForm audience={audience} onDirtyChange={onDirtyChange} onDone={() => setView({ kind: 'list' })} />
      )}

      {view.kind === 'reads' && openRow && (
        <CircularReadsView row={openRow} audience={audience} onBack={() => setView({ kind: 'list' })} onWithdraw={() => setWithdrawing(openRow)} />
      )}

      {withdrawing && (
        <ConfirmDialog
          danger
          title={tr('سحب التعميم')}
          message={`«${withdrawing.title}» — ${tr('يختفي التعميم عمن لم يقرأه بعد ويبقى سجل من قرأه ولا يمكن إعادة نشره')}`}
          confirmLabel={tr('سحب')}
          loading={withdraw.isPending}
          onConfirm={() => withdraw.mutate(withdrawing.id)}
          onClose={() => { if (!withdraw.isPending) setWithdrawing(null); }}
        />
      )}
    </div>
  );
}

function StatusChip({ st }: { st: CircularViewState }) {
  const tr = useTr();
  const cls = st === 'ACTIVE' ? 'bg-[#E4F1EA] text-[#1E7A52]' : st === 'EXPIRED' ? 'bg-amber-50 text-amber-700' : 'bg-[#F1EBDF] text-[#6E6557]';
  const label = st === 'ACTIVE' ? tr('نشط') : st === 'EXPIRED' ? tr('منتهي') : tr('مسحوب');
  return <span className={`inline-flex items-center text-[11px] font-semibold rounded-full px-2 py-0.5 whitespace-nowrap ${cls}`}>{label}</span>;
}

function ReadProgress({ read, target }: { read: number; target: number }) {
  const tr = useTr();
  const pct = readPct(read, target);
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="flex-1 max-w-[14rem] h-1.5 rounded-full bg-[#F1EBDF] overflow-hidden"
        role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={tr('القراءة')}>
        <div className={`h-full rounded-full ${pct >= 100 ? 'bg-[#2F855A]' : 'bg-[#E15A30]'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-[#6E6557] whitespace-nowrap">
        {tr('القراءة')}: <b className="tabular-nums text-[#1F1A13]" dir="ltr">{read}/{target}</b> <span className="tabular-nums">({pct}%)</span>
      </span>
    </div>
  );
}

/** «الكل» أو «N مندوب/مستخدم» */
function useTargetText() {
  const tr = useTr();
  return (row: Pick<CircularRow, 'targetAll' | 'targetCount'>, isReps: boolean) =>
    row.targetAll ? tr('الكل') : `${row.targetCount} ${isReps ? tr('مندوب') : tr('مستخدم')}`;
}

function CircularMeta({ row, isReps }: { row: CircularRow; isReps: boolean }) {
  const tr = useTr();
  const targetText = useTargetText();
  return (
    <p className="text-xs text-[#6E6557] mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
      <span>{formatDateTime(row.createdAt)}</span>
      {/* الاسم يمرّ بالقاموس: ما نشرته جلسة «دخول» المالك أو موظف المنصة يحمل «الدعم الفني» من الخادم (لا اسم مدير الشركة) — واسمُ شخصٍ يعود كما هو */}
      {row.createdByName && <span>· {tr(row.createdByName)}</span>}
      <span>· {tr('المستهدفون')}: {targetText(row, isReps)}</span>
      {row.expiresAt && <span>· {tr('ينتهي في')} {formatDate(row.expiresAt)}</span>}
    </p>
  );
}

function CircularItem({ row, isReps, onOpen, onWithdraw }: { row: CircularRow; isReps: boolean; onOpen: () => void; onWithdraw: () => void }) {
  const tr = useTr();
  const st = circularViewState(row);
  return (
    <div className={`p-3.5 sm:p-4 ${st === 'ACTIVE' ? '' : 'bg-[#FBF8F3]'}`}>
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-[#1F1A13] [overflow-wrap:anywhere]">{row.title}</p>
            <StatusChip st={st} />
          </div>
          <CircularMeta row={row} isReps={isReps} />
          <p className="text-sm text-[#3D372C] mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere] line-clamp-2" dir="auto">{row.body}</p>
          <ReadProgress read={row.readCount} target={row.targetCount} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button type="button" onClick={onOpen} className="btn-secondary !py-1.5 !px-3 text-xs"><Eye size={13} /> {tr('من قرأ')}</button>
          {canWithdrawCircular(row) && (
            <button type="button" onClick={onWithdraw} className="p-2 rounded-lg text-red-500 hover:bg-red-50"
              title={tr('سحب التعميم')} aria-label={tr('سحب التعميم')}><Undo2 size={15} /></button>
          )}
        </div>
      </div>
    </div>
  );
}

// ===== نموذج «تعميم جديد» =====
function CircularForm({ audience, onDone, onDirtyChange }: {
  audience: CircularAudience;
  onDone: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const errText = useErrText();
  const me = useAuthStore((s) => s.user);
  // جلسة «دخول» المالك أو موظف المنصة تنشر باسم «الدعم الفني» فلا يُستثنى صاحب الحساب الذي دخلت به (الخادم كذلك)
  const impersonating = useAuthStore((s) => s.impersonating);
  const isReps = audience === 'REPS';
  const selfId = !isReps && !impersonating ? me?.id ?? null : null;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [targetAll, setTargetAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [expiresOn, setExpiresOn] = useState('');
  const [q, setQ] = useState('');
  const [formError, setFormError] = useState<CircularFormError | null>(null);
  const [pendingBody, setPendingBody] = useState<CircularCreateBody | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const expiresRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  /* المرشّحون من المفاتيح نفسها التي تقرؤها الشاشات الأخرى (لوحة «فرق العمل» وصفحة مستخدمي الشركة) فيُعاد استعمال المخزَّن:
   * المناديب كلهم (صفحة المناديب تجلب ٥٠ ببحثها) ومستخدمو الشركة كما في صفحتهم */
  const repsQ = useQuery({
    queryKey: ['reps-min'],
    queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as CircularPerson[],
    enabled: isReps,
  });
  const usersQ = useQuery({
    queryKey: ['company-users'],
    queryFn: async () => (await companyUserApi.list()).data.data as CircularPerson[],
    enabled: !isReps,
  });
  const peopleQ = isReps ? repsQ : usersQ;
  // الناشر لا يصله تعميمه — فلا يُعرض في تعميم المستخدمين
  const candidates = useMemo(() => circularCandidates(peopleQ.data, selfId), [peopleQ.data, selfId]);
  const shown = useMemo(() => filterPeopleByName(candidates, q), [candidates, q]);
  // المحددون من المرشّحين الحاليين وحدهم (مندوبٌ عُطِّل أثناء الكتابة لا يُرسَل)
  const pickedIds = useMemo(() => candidates.filter((p) => picked.has(p.id)).map((p) => p.id), [candidates, picked]);

  const dirty = !!(title.trim() || body.trim() || picked.size > 0 || expiresOn);
  const dirtyCb = useRef(onDirtyChange);
  dirtyCb.current = onDirtyChange;
  useEffect(() => { dirtyCb.current?.(dirty); }, [dirty]);
  useEffect(() => () => { dirtyCb.current?.(false); }, []);

  const publish = useMutation({
    mutationFn: (b: CircularCreateBody) => circularsApi.create(b),
    onSuccess: () => {
      toast.success(tr('تم نشر التعميم'));
      setPendingBody(null);
      dirtyCb.current?.(false);
      onDone();
    },
    onError: (e) => { setPendingBody(null); toast.error(errText(e, tr('تعذر نشر التعميم'))); },
    onSettled: () => qc.invalidateQueries({ queryKey: circularsKey(audience) }),
  });

  const errorText = (e: CircularFormError): string => {
    switch (e) {
      case 'TITLE_EMPTY': return tr('اكتب عنوان التعميم');
      case 'TITLE_LONG': return tr('عنوان التعميم أطول من 120 حرفا');
      case 'BODY_EMPTY': return tr('اكتب نص التعميم');
      case 'BODY_LONG': return tr('نص التعميم أطول من 4000 حرف');
      case 'NO_TARGETS': return isReps ? tr('اختر مندوبا واحدا على الأقل') : tr('اختر مستخدما واحدا على الأقل');
      case 'EXPIRES_INVALID': return tr('تاريخ انتهاء التعميم غير صحيح');
      case 'EXPIRES_PAST': return tr('تاريخ الانتهاء مضى اختر اليوم أو ما بعده');
    }
  };

  const onPublishClick = () => {
    const draft = { title, body, targetAll, targetIds: pickedIds, expiresOn };
    const err = validateCircularDraft(draft);
    setFormError(err);
    if (err) {
      if (err === 'TITLE_EMPTY' || err === 'TITLE_LONG') titleRef.current?.focus();
      else if (err === 'BODY_EMPTY' || err === 'BODY_LONG') bodyRef.current?.focus();
      else if (err === 'NO_TARGETS') pickerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      else expiresRef.current?.focus();
      return;
    }
    setPendingBody(buildCircularBody(audience, draft));
  };

  const cancel = () => {
    if (dirty && !window.confirm(tr('تجاهل مسودة التعميم؟'))) return;
    onDone();
  };

  const togglePick = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const targetSummary = targetAll
    ? (isReps ? tr('إلى كل المناديب النشطين') : tr('إلى كل مستخدمي الشركة النشطين'))
    : `${tr('عدد المستهدفين')}: ${pickedIds.length} ${isReps ? tr('مندوب') : tr('مستخدم')}`;
  const radioCls = (on: boolean) =>
    `flex items-center gap-2 rounded-xl border px-3 py-2.5 text-sm cursor-pointer transition-colors ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#1F1A13] font-semibold' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:bg-[#FAF7F0]'}`;
  const ids = { title: `circ-title-${audience}`, body: `circ-body-${audience}`, exp: `circ-exp-${audience}` };

  return (
    <div className="space-y-4">
      <button type="button" onClick={cancel} className="text-sm font-semibold text-[#6E6557] hover:text-[#1F1A13] flex items-center gap-1.5">
        <ArrowRight size={16} /> {tr('رجوع إلى التعميمات')}
      </button>

      <div className="card space-y-4">
        <h3 className="font-bold text-[#1F1A13] flex items-center gap-2">
          <Megaphone size={18} className="text-[#E15A30]" /> {isReps ? tr('تعميم جديد للمناديب') : tr('تعميم جديد لمستخدمي الشركة')}
        </h3>

        <div>
          <div className="flex items-center justify-between gap-2">
            <label className="label" htmlFor={ids.title}>{tr('عنوان التعميم')}</label>
            <span className="text-[11px] text-[#9A8F7E] tabular-nums" dir="ltr">{title.length}/{CIRCULAR_TITLE_MAX}</span>
          </div>
          <input id={ids.title} ref={titleRef} className="input" value={title} maxLength={CIRCULAR_TITLE_MAX} dir="auto"
            placeholder={tr('مثل تعديل مواعيد الدوام')}
            onChange={(e) => { setTitle(e.target.value); setFormError(null); }} />
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <label className="label" htmlFor={ids.body}>{tr('نص القرار أو الإعلان')}</label>
            <span className="text-[11px] text-[#9A8F7E] tabular-nums" dir="ltr">{body.length}/{CIRCULAR_BODY_MAX}</span>
          </div>
          <textarea id={ids.body} ref={bodyRef} className="input min-h-[8rem] leading-relaxed whitespace-pre-wrap" rows={6}
            value={body} maxLength={CIRCULAR_BODY_MAX} dir="auto"
            onChange={(e) => { setBody(e.target.value); setFormError(null); }} />
        </div>

        <fieldset>
          <legend className="label">{tr('المستهدفون')}</legend>
          <div className="grid grid-cols-2 gap-2">
            <label className={radioCls(targetAll)}>
              <input type="radio" name={`circ-target-${audience}`} checked={targetAll} className="w-4 h-4 accent-[#E15A30]"
                onChange={() => { setTargetAll(true); setFormError(null); }} />
              <span>{tr('الكل')}</span>
            </label>
            <label className={radioCls(!targetAll)}>
              <input type="radio" name={`circ-target-${audience}`} checked={!targetAll} className="w-4 h-4 accent-[#E15A30]"
                onChange={() => { setTargetAll(false); setFormError(null); }} />
              <span>{tr('محددون')}</span>
            </label>
          </div>
          <p className="text-xs text-[#9A8F7E] mt-1.5">
            {targetAll
              ? (isReps ? tr('يظهر لكل المناديب النشطين') : selfId ? tr('يظهر لكل مستخدمي الشركة النشطين عداك') : tr('يظهر لكل مستخدمي الشركة النشطين'))
              : (isReps ? tr('اختر المناديب الذين يظهر لهم التعميم') : tr('اختر المستخدمين الذين يظهر لهم التعميم'))}
            {targetAll && peopleQ.isSuccess && <span className="tabular-nums"> ({candidates.length})</span>}
          </p>

          {!targetAll && (
            <div ref={pickerRef} className="mt-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[10rem]">
                  <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-gray-400" />
                  <input className="input !ps-8" placeholder={tr('بحث بالاسم')} value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <button type="button" className="text-xs font-semibold text-[#E15A30]"
                  onClick={() => { setPicked((s) => { const n = new Set(s); shown.forEach((x) => n.add(x.id)); return n; }); setFormError(null); }}>
                  {tr('تحديد الظاهر')}
                </button>
                <button type="button" className="text-xs font-semibold text-gray-500"
                  onClick={() => setPicked((s) => { const n = new Set(s); shown.forEach((x) => n.delete(x.id)); return n; })}>
                  {tr('إلغاء الظاهر')}
                </button>
              </div>
              <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF] max-h-64 overflow-y-auto bg-white">
                {peopleQ.isLoading ? (
                  <p className="text-center text-gray-400 text-sm py-6">{tr('جار التحميل')}</p>
                ) : peopleQ.isError ? (
                  <div className="text-center py-5">
                    <p className="text-sm text-[#8E2A1F]">{errText(peopleQ.error, isReps ? tr('تعذر جلب المناديب') : tr('تعذر جلب المستخدمين'))}</p>
                    <button type="button" className="btn-secondary mx-auto mt-2 !py-1.5 text-xs" onClick={() => peopleQ.refetch()}><RefreshCw size={13} /> {tr('إعادة المحاولة')}</button>
                  </div>
                ) : shown.length === 0 ? (
                  <p className="text-center text-gray-400 text-sm py-6">{tr('لا توجد نتائج')}</p>
                ) : shown.map((p) => (
                  <label key={p.id} className="flex items-center gap-2.5 px-3.5 py-2 text-sm cursor-pointer hover:bg-[#FAF7F0]">
                    <input type="checkbox" checked={picked.has(p.id)} className="w-4 h-4 accent-[#E15A30]"
                      onChange={() => { togglePick(p.id); setFormError(null); }} />
                    <span className="flex-1 truncate text-[#1F1A13]">{p.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-[#6E6557]">{tr('المحددون')}: <b className="tabular-nums text-[#1F1A13]">{pickedIds.length}</b></p>
            </div>
          )}
        </fieldset>

        <div>
          <label className="label" htmlFor={ids.exp}>
            {tr('ينتهي في')} <span className="text-[#9A8F7E] font-normal">({tr('اختياري')})</span>
          </label>
          <div className="flex items-center gap-2">
            <input id={ids.exp} ref={expiresRef} type="date" className="input w-full sm:w-52" dir="ltr" min={localDayOf()}
              value={expiresOn} onChange={(e) => { setExpiresOn(e.target.value); setFormError(null); }} />
            {expiresOn && (
              <button type="button" className="text-xs font-semibold text-gray-500 shrink-0" onClick={() => { setExpiresOn(''); setFormError(null); }}>{tr('مسح')}</button>
            )}
          </div>
          <p className="text-xs text-[#9A8F7E] mt-1">{tr('بعد نهاية هذا اليوم لا يظهر التعميم لمن لم يقرأه وبلا تاريخ يبقى حتى يقرأ أو يسحب')}</p>
        </div>

        {(title.trim() || body.trim()) && (
          <div>
            <p className="label">{tr('معاينة')}</p>
            <div className="max-w-sm mx-auto bg-white rounded-2xl shadow-md border border-[#E9E1D3] p-5 text-center">
              <span className="w-11 h-11 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center mx-auto"><Megaphone size={20} /></span>
              <p className="font-bold text-[#1F1A13] mt-2 [overflow-wrap:anywhere]" dir="auto">{title.trim() || '—'}</p>
              <p className="text-sm text-[#3D372C] mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-start leading-relaxed max-h-48 overflow-y-auto" dir="auto">{body.trim()}</p>
              <div className="mt-4 w-full rounded-xl bg-[#E15A30] text-white font-semibold py-2 text-sm flex items-center justify-center gap-1.5" aria-hidden="true">
                <CheckCheck size={16} /> {tr('تمت القراءة')}
              </div>
            </div>
          </div>
        )}

        {formError && (
          <p className="flex items-center gap-2 text-sm rounded-xl px-3 py-2 bg-[#FBE3DF] text-[#8E2A1F]" role="alert">
            <AlertTriangle size={15} className="shrink-0" /> {errorText(formError)}
          </p>
        )}

        <div className="flex gap-2 justify-end flex-wrap pt-1">
          <button type="button" className="btn-secondary" onClick={cancel}>{tr('إلغاء')}</button>
          <button type="button" className="btn-primary disabled:opacity-60" disabled={publish.isPending} onClick={onPublishClick}>
            <Send size={15} /> {tr('نشر التعميم')}
          </button>
        </div>
      </div>

      {pendingBody && (
        <ConfirmDialog
          title={tr('نشر التعميم')}
          message={`${targetSummary} — ${tr('يظهر التعميم في نافذة عند فتح التطبيق حتى يضغط الموظف تمت القراءة ولا يعدل بعد نشره لكن يمكن سحبه')}`}
          confirmLabel={tr('نشر')}
          loading={publish.isPending}
          onConfirm={() => publish.mutate(pendingBody)}
          onClose={() => { if (!publish.isPending) setPendingBody(null); }}
        />
      )}
    </div>
  );
}

// ===== التفاصيل: من قرأ ومتى، ومن لم يقرأ بعد =====
function CircularReadsView({ row, audience, onBack, onWithdraw }: {
  row: CircularRow;
  audience: CircularAudience;
  onBack: () => void;
  onWithdraw: () => void;
}) {
  const tr = useTr();
  const errText = useErrText();
  const isReps = audience === 'REPS';
  const st = circularViewState(row);
  const readsQ = useQuery({
    queryKey: circularReadsKey(audience, row.id),
    queryFn: async () => (await circularsApi.reads(row.id)).data.data as CircularReads,
  });
  const read = readsQ.data?.read ?? [];
  const unread = readsQ.data?.unread ?? [];

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-sm font-semibold text-[#6E6557] hover:text-[#1F1A13] flex items-center gap-1.5">
        <ArrowRight size={16} /> {tr('رجوع إلى التعميمات')}
      </button>

      <div className="card">
        <div className="flex items-start gap-3 flex-wrap justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-[#1F1A13] [overflow-wrap:anywhere]">{row.title}</h3>
              <StatusChip st={st} />
            </div>
            <CircularMeta row={row} isReps={isReps} />
          </div>
          {canWithdrawCircular(row) && (
            <button type="button" onClick={onWithdraw} className="btn-secondary !py-1.5 !px-3 text-xs !text-red-600 shrink-0">
              <Undo2 size={13} /> {tr('سحب التعميم')}
            </button>
          )}
        </div>
        <p className="text-sm text-[#3D372C] mt-3 whitespace-pre-wrap [overflow-wrap:anywhere] leading-relaxed bg-[#FBF8F3] border border-[#F1EBDF] rounded-xl p-3" dir="auto">{row.body}</p>
        <ReadProgress read={row.readCount} target={row.targetCount} />
      </div>

      {readsQ.isLoading ? (
        <div className="card"><Spinner /></div>
      ) : readsQ.isError ? (
        <div className="card text-center py-8" role="alert">
          <p className="text-sm text-[#8E2A1F]">{errText(readsQ.error, tr('تعذر جلب القراءات'))}</p>
          <button type="button" className="btn-secondary mx-auto mt-3" onClick={() => readsQ.refetch()}><RefreshCw size={14} /> {tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="card p-0 overflow-hidden">
              <p className="px-4 py-3 border-b border-[#F1EBDF] font-semibold text-[#1E7A52] flex items-center gap-2">
                <CheckCheck size={16} /> {tr('قرأه')} <span className="tabular-nums">({read.length})</span>
              </p>
              {read.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-6">{tr('لم يقرأه أحد بعد')}</p>
              ) : (
                <ul className="divide-y divide-[#F1EBDF] max-h-80 overflow-y-auto">
                  {read.map((r) => (
                    <li key={r.id} className="px-4 py-2.5 flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-[#1F1A13]">{r.name}</span>
                      <span className="text-xs text-[#9A8F7E] shrink-0">{formatDateTime(r.readAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card p-0 overflow-hidden">
              <p className="px-4 py-3 border-b border-[#F1EBDF] font-semibold text-amber-700 flex items-center gap-2">
                <Clock size={16} /> {tr('لم يقرأه بعد')} <span className="tabular-nums">({unread.length})</span>
              </p>
              {unread.length === 0 ? (
                <p className="text-center text-sm text-gray-400 py-6">{tr('قرأه الجميع')}</p>
              ) : (
                <ul className="divide-y divide-[#F1EBDF] max-h-80 overflow-y-auto">
                  {unread.map((u) => (
                    <li key={u.id} className="px-4 py-2.5 text-sm truncate text-[#1F1A13]">{u.name}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {st !== 'ACTIVE' && unread.length > 0 && (
            <p className="text-xs text-[#9A8F7E]">
              {st === 'WITHDRAWN' ? tr('التعميم مسحوب فلن يظهر لمن لم يقرأه') : tr('انتهى التعميم فلن يظهر لمن لم يقرأه')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
