import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, BookOpen, Brain, ChevronDown, ChevronUp, History, Layers, Lightbulb, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react';
import toast from 'react-hot-toast';
import { aiRepApi } from '../api/client';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAiRepTr } from '../i18n/aiRepPhrases';
import { useLang } from '../i18n/lang';
import { activeLocale, formatDate, formatDayOnly, formatNumber } from '../utils/format';
import {
  LESSON_ORIGIN_LABEL, LESSON_REASON_LABEL, OUTLET_TYPE_OPTIONS, VERDICT_LABEL, autoRolledBack, betaAbove, lessonActions, toRate,
  verdictOfCI, verdictOfP, type Verdict,
} from '../rep/aiRepLogic';

/**
 * المندوب الذكي — «ما تعلّمه العقل» (لوحة الإدارة، أسفل الإعدادات).
 * صادقة عمداً: العقل نموذج ثابت لا يُعاد تدريبه، و«التعلّم» ذاكرة إحصائية لهذه الشركة وحدها. لا يُكتب «تحسّن مؤكَّد»
 * إلا حين يستبعد مجال الثقة الصفر (الترتيب lo90 > 0، والنسب P ≥ 0.9)؛ بين 0.7 و0.9 «مؤشّر» فقط، وإلا «لا أثر مؤكَّد بعد».
 * شركة جديدة بلا ليالٍ: كل بطاقة «يحتاج مزيداً من البيانات» ولا شيء يسقط.
 */

type Mode = 'AUTO' | 'REVIEW' | 'OFF';
type Kind = 'POLICY' | 'CALIBRATION';
type LessonAction = 'approve' | 'reject' | 'disable' | 'enable' | 'restore';
interface ArmAgg { planned?: number; visited?: number; pos?: number; conv30?: number; closed?: number }
/** مؤشّرات الليلة (§4.4) — كل حقل اختياري: شركة جديدة أو ليلة جزئية قد لا تحمل بعضها. */
interface RunMetrics {
  policy?: { cDefault?: number; cActive?: number; dC?: number; lo90?: number; hi90?: number; pairs?: number; turns?: number; activeVersion?: number } | null;
  arms?: { LEARNED?: ArmAgg; BASELINE?: ArmAgg; pLearnedBetter?: number | null } | null;
  adherence?: number | null;
  wastedRate?: number | null;
  trial?: {
    E0?: number; E?: number; typicalErrorRawX?: number | null; typicalErrorCalX?: number | null;
    snapshot?: { n?: number; calBetter?: number; rawBetter?: number } | null; buyThrough?: number | null;
  } | null;
  /** guardBad7 عدد ردود (REGEN+TRIM+TEMPLATE) من turns7 — أو نسبة؛ toRate يقبل الشكلين */
  self?: { turns7?: number; guardBad7?: number; flagsPer100_7?: number; up28?: number; down28?: number } | null;
  readiness?: { pairs?: number; pairsNeeded?: number; calCustomers?: number; calNeeded?: number; episodes?: number } | null;
  hints?: { code: string; textAr: string }[] | null;
  /** يُجمَّد مرة واحدة بعد ٢٨ يوماً: guardBad وupRate نِسَب */
  baseline?: { frozenAt?: string; guardBad?: number | null; upRate?: number | null; ppr?: number | null; trialE0?: number | null } | null;
}
interface ModelRow { kind: string; version: number; status: string; trainedAt: string; promotedAt: string | null; reason: string | null; summaryAr: string; metrics: object }
interface EvidenceItem { key?: string; n?: number; reps?: number; topRepShare?: number }
interface HistoryRow { at?: string; from?: string | null; to?: string; by?: string; reason?: string | null }
interface LessonRow {
  id: string; kind: string; origin: string; outletType: string | null; textAr: string; status: string; statusReason: string | null;
  evidence: { items?: EvidenceItem[]; windowDays?: number; computedAt?: string } | null;
  onOff: { on: number; off: number; qOn: number | null; qOff: number | null; up: number; down: number } | null;
  history: HistoryRow[] | null; createdAt: string;
}
interface LearningView {
  mode: Mode; holdoutPct: number; llmConfigured: boolean;
  lastRun: { day: string; status: string; llm: string; finishedAt: string | null } | null;
  runs: { day: string; status: string; llm: string; tokensIn: number; tokensOut: number; steps: Record<string, { ok: boolean; skipped?: string }> }[];
  metrics: RunMetrics | null;
  models: ModelRow[];
  lessons: LessonRow[];
  objections: { typeLabel: string; items: { label: string; share: number }[] }[];
}

const errMsg = (e: unknown): string | undefined => (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const pct = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? '—' : new Intl.NumberFormat(activeLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(x);
const times = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? '—' : `×${new Intl.NumberFormat(activeLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(x)}`;

const TABS = [
  { key: 'ACTIVE', match: (s: string) => s === 'ACTIVE' },
  { key: 'TRIAL', match: (s: string) => s === 'TRIAL' },
  { key: 'PENDING', match: (s: string) => s === 'PENDING' },
  { key: 'OFF', match: (s: string) => s === 'RETIRED' || s === 'DISABLED' },
] as const;
type TabKey = typeof TABS[number]['key'];

export default function AiLearningPanel() {
  const tr = useAiRepTr();
  const lang = useLang(s => s.lang);
  const arrow = lang === 'ar' ? '←' : '→';
  const qc = useQueryClient();
  const { data: v, isLoading, isError, error } = useQuery({
    queryKey: ['ai-rep', 'learning'],
    queryFn: async () => (await aiRepApi.learning()).data.data as LearningView,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['ai-rep', 'learning'] });
  const onErr = (e: unknown) => toast.error(errMsg(e) || tr('تعذّر تنفيذ الإجراء'));

  const lessonAct = useMutation({
    mutationFn: async (a: { id: string; action: LessonAction }) => (await aiRepApi.lessonAction(a.id, a.action)).data,
    onSuccess: () => { toast.success(tr('تم تحديث الدرس')); refresh(); },
    onError: onErr,
  });
  const rollback = useMutation({
    mutationFn: async (a: { kind: Kind; version: number }) => (await aiRepApi.rollbackModel(a.kind, a.version)).data,
    onSuccess: () => { toast.success(tr('تم الرجوع للنسخة')); refresh(); },
    onError: onErr,
  });
  const [confirmReset, setConfirmReset] = useState(false);
  const reset = useMutation({
    mutationFn: async () => (await aiRepApi.resetLearning()).data,
    onSuccess: () => { toast.success(tr('بدأ التعلّم من جديد')); setConfirmReset(false); refresh(); },
    onError: (e: unknown) => { setConfirmReset(false); onErr(e); },
  });
  const [tab, setTab] = useState<TabKey | null>(null);

  const modeText = (m: string) => (m === 'OFF' ? tr('متوقف') : m === 'REVIEW' ? tr('بمراجعتي') : tr('تلقائي'));
  const llmText = (code: string) => {
    switch (code) {
      case 'USED': return tr('تمّت');
      case 'SKIPPED_NO_KEY': return `${tr('تُخطّيت')} (${tr('بلا مفتاح')})`;
      case 'SKIPPED_BUDGET': return `${tr('تُخطّيت')} (${tr('الميزانية')})`;
      case 'SKIPPED_RATE_LIMIT': return `${tr('تُخطّيت')} (${tr('حدّ Groq')})`;
      case 'SKIPPED_QUIET': return `${tr('تُخطّيت')} (${tr('لا جديد')})`;
      case 'SKIPPED_MODE': return `${tr('تُخطّيت')} (${tr('متوقف')})`;
      case 'FAILED': return tr('فشلت');
      default: return tr('لم تُشغَّل');
    }
  };
  const runStatusText = (s: string) => (s === 'DONE' ? tr('تمّت') : s === 'PARTIAL' ? tr('جزئية') : s === 'FAILED' ? tr('فشلت') : tr('جارية'));

  const header = (
    <div>
      <p className="font-bold text-[#1F1A13] mb-1 flex items-center gap-2"><Brain size={18} className="text-[#E15A30]" /> {tr('ما تعلّمه العقل')}</p>
      <p className="text-xs text-[#6E6557] leading-5">{tr('العقل نموذج ثابت (Groq openai/gpt-oss-120b) لا يُعاد تدريبه؛ «التعلّم» هنا ذاكرة إحصائية لشركتك: ترتيب الفرص يُعاير بنتائج زياراتكم، والطلب التجريبي بأول طلبات عملائكم الجدد الفعلية، ودروس قصيرة بلا أرقام تُختبر قبل اعتمادها — داخل شركتك وحدها ولا تُشارك مع أي شركة أخرى')}</p>
    </div>
  );

  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-4">
        {header}
        <div className="flex justify-center py-6"><div className="w-6 h-6 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" /></div>
      </div>
    );
  }
  if (isError || !v) {
    return (
      <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-3">
        {header}
        <p className="text-sm text-red-600">{errMsg(error) || tr('تعذّر تحميل ما تعلّمه العقل')}</p>
      </div>
    );
  }

  const m = v.metrics ?? null;
  const models = v.models ?? [];
  const lessons = v.lessons ?? [];
  const runs = v.runs ?? [];
  const objections = v.objections ?? [];
  const hints = m?.hints ?? [];

  // ١) ترتيب الفرص: الفرق على نفس الزيارات (مجال ٩٠٪) — المقياس الأساسي
  const pol = m?.policy ?? null;
  const pairs = num(m?.readiness?.pairs) ?? num(pol?.pairs) ?? 0;
  const pairsNeeded = num(m?.readiness?.pairsNeeded) ?? 40;
  const polVerdict: Verdict = autoRolledBack(models, 'POLICY') ? 'WORSE'
    : pol ? verdictOfCI(num(pol.dC), num(pol.lo90), num(pol.hi90), num(pol.pairs), pairsNeeded) : 'NEEDS_DATA';
  const armRate = (a?: ArmAgg) => (a?.visited ? (a.pos ?? 0) / a.visited : null);
  const L = m?.arms?.LEARNED, B = m?.arms?.BASELINE;

  // ٢) الطلب التجريبي: الخطأ المعتاد قبل/بعد، والحكم من اللقطات (المعايَر أقرب للفعلي من الخام؟)
  const trial = m?.trial ?? null;
  const snapK = num(trial?.snapshot?.calBetter) ?? 0, snapN = snapK + (num(trial?.snapshot?.rawBetter) ?? 0);
  const calCustomers = num(m?.readiness?.calCustomers) ?? 0;
  const trialVerdict: Verdict = autoRolledBack(models, 'CALIBRATION') ? 'WORSE'
    : !trial ? 'NEEDS_DATA' : snapN ? verdictOfP(betaAbove(snapK, snapN, 0.5), snapN, 10) : 'NONE';

  // ٣) ردود بلا تصحيح (٧ أيام) مقابل الأساس المجمَّد
  const turns7 = num(m?.self?.turns7) ?? 0;
  const badNow = toRate(num(m?.self?.guardBad7), turns7);
  const badBase = num(m?.baseline?.guardBad);
  const guardVerdict: Verdict = badNow == null || badBase == null || !turns7 ? 'NEEDS_DATA'
    : verdictOfP(1 - betaAbove(Math.round(badNow * turns7), turns7, badBase), turns7, 30);

  // ٤) رضا المناديب (👍 من التقييمات، ٢٨ يوماً) مقابل الأساس
  const up = num(m?.self?.up28) ?? 0, down = num(m?.self?.down28) ?? 0, votes = up + down;
  const upBase = num(m?.baseline?.upRate);
  const voteVerdict: Verdict = !votes || upBase == null ? 'NEEDS_DATA' : verdictOfP(betaAbove(up, votes, upBase), votes, 20);

  const tabCount = (k: TabKey) => lessons.filter(l => TABS.find(t => t.key === k)!.match(l.status)).length;
  const curTab: TabKey = tab ?? (tabCount('PENDING') ? 'PENDING' : 'ACTIVE');
  const tabLabel = (k: TabKey) => (k === 'ACTIVE' ? tr('فعّالة') : k === 'TRIAL' ? tr('قيد التجربة') : k === 'PENDING' ? tr('بانتظار مراجعتك') : tr('متقاعدة ومعطّلة'));
  const shown = lessons.filter(l => TABS.find(t => t.key === curTab)!.match(l.status));
  const busy = lessonAct.isPending || rollback.isPending || reset.isPending;
  const llmCode = v.lastRun?.llm ?? (v.llmConfigured ? 'NOT_RUN' : 'SKIPPED_NO_KEY');

  return (
    <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-5">
      {header}

      <div className="flex flex-wrap gap-2 text-[11px]">
        <Chip>{tr('آخر تعلّم')}: {v.lastRun ? (v.lastRun.finishedAt ? formatDate(v.lastRun.finishedAt) : `${formatDayOnly(v.lastRun.day)} · ${runStatusText(v.lastRun.status)}`) : '—'}</Chip>
        <Chip>{tr('المراجعة الذاتية بالعقل')}: {llmText(llmCode)}</Chip>
        <Chip>{tr('طريقة التعلّم')}: {modeText(v.mode)} · {tr('نسبة المجموعة الضابطة')}: {pct((v.holdoutPct ?? 0) / 100)}</Chip>
      </div>
      {!v.lastRun && <p className="text-xs text-[#6E6557]">{tr('لم يبدأ التعلّم بعد — يبدأ ليلاً بعد أول زيارات مسجّلة')}</p>}
      {v.mode === 'OFF' && (
        <p className="text-xs rounded-xl border border-amber-200 bg-amber-50 text-amber-800 p-2.5">{tr('متوقف: المستشار يعمل كما كان قبل التعلّم (الترتيب الافتراضي بلا دروس ولا معايرة)، وتُسجَّل نتائج الزيارات فقط')}</p>
      )}

      {/* البطاقات الأربع: قبل / بعد، n، وحكم لا يدّعي ما لم يثبت */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricCard title={tr('ترتيب الفرص')} caption={tr('على نفس الزيارات')} arrow={arrow}
          beforeLabel={tr('الترتيب الافتراضي')} before={pct(num(pol?.cDefault))} afterLabel={tr('المتعلَّم')} after={pct(num(pol?.cActive))}
          verdict={polVerdict} n={num(pol?.pairs) ?? pairs}>
          {(L?.visited || B?.visited) ? (
            <p className="text-[11px] text-[#6E6557]">
              {tr('تجاوب إيجابي في الميدان')}: {tr('المتعلَّم')} {pct(armRate(L))} (n={L?.visited ?? 0}) · {tr('الضابطة')} {pct(armRate(B))} (n={B?.visited ?? 0})
            </p>
          ) : null}
        </MetricCard>
        <MetricCard title={tr('دقّة الطلب التجريبي')} caption={tr('الخطأ المعتاد في الطلب التجريبي مقارنةً بأول طلب فعلي (الأقل أفضل)')} arrow={arrow}
          beforeLabel={tr('قبل')} before={times(num(trial?.typicalErrorRawX))} afterLabel={tr('بعد')} after={times(num(trial?.typicalErrorCalX))}
          verdict={trialVerdict} n={snapN || calCustomers}>
          <p className="text-[11px] text-[#6E6557]">{tr('عملاء فُحصوا')}: {formatNumber(calCustomers)}</p>
        </MetricCard>
        <MetricCard title={tr('ردود بلا تصحيح')} caption={tr('نسبة ردود العقل التي مرّت بحارس الأرقام دون تصحيح')} arrow={arrow}
          beforeLabel={tr('قبل')} before={pct(badBase == null ? null : 1 - badBase)} afterLabel={tr('بعد')} after={pct(badNow == null ? null : 1 - badNow)}
          verdict={guardVerdict} n={turns7} />
        <MetricCard title={tr('رضا المناديب')} caption={tr('نسبة «مفيد» من تقييمات المناديب')} arrow={arrow}
          beforeLabel={tr('قبل')} before={pct(upBase)} afterLabel={tr('بعد')} after={pct(votes ? up / votes : null)}
          verdict={voteVerdict} n={votes}>
          {votes > 0 && <p className="text-[11px] text-[#6E6557] flex items-center gap-2"><ThumbsUp size={12} /> {up} <ThumbsDown size={12} /> {down}</p>}
        </MetricCard>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-[#6E6557]">
        <span>{tr('التزام المناديب بالخطة')}: <b className="text-[#1F1A13]">{pct(num(m?.adherence))}</b></span>
        <span>{tr('زيارات ضائعة (مغلق)')}: <b className="text-[#1F1A13]">{pct(num(m?.wastedRate))}</b></span>
      </div>
      <div>
        <p className="text-xs text-[#6E6557] mb-1">{tr('يجمع الخبرة')}: {formatNumber(pairs)}/{formatNumber(pairsNeeded)} {tr('زوجاً')}</p>
        <div className="h-2 rounded-full bg-[#F4EEE3] overflow-hidden">
          <div className="h-full bg-[#E15A30] rounded-full" style={{ width: `${Math.min(100, pairsNeeded ? (pairs / pairsNeeded) * 100 : 0)}%` }} />
        </div>
      </div>

      {/* الدروس */}
      <div>
        <p className="font-semibold text-[#1F1A13] mb-2 flex items-center gap-2"><BookOpen size={16} className="text-[#E15A30]" /> {tr('الدروس المستفادة')}</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {TABS.map(t => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className={`rounded-xl border-2 px-3 py-1.5 text-sm ${curTab === t.key ? 'border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] bg-white text-[#44403a]'}`}>
              {tabLabel(t.key)} ({tabCount(t.key)})
            </button>
          ))}
        </div>
        {shown.length ? (
          <div className="space-y-2">
            {shown.map(l => <LessonItem key={l.id} l={l} arrow={arrow} busy={busy} onAction={action => lessonAct.mutate({ id: l.id, action })} />)}
          </div>
        ) : <p className="py-3 text-center text-xs text-[#6E6557]">{tr('لا دروس هنا')}</p>}
      </div>

      {/* أسباب الرفض */}
      <div>
        <p className="font-semibold text-[#1F1A13] mb-2 flex items-center gap-2"><BarChart3 size={16} className="text-[#E15A30]" /> {tr('أسباب الرفض حسب نوع المحل')}</p>
        {objections.length ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {objections.map(o => (
              <div key={o.typeLabel} className="rounded-xl border border-[#E9E1D3] p-3 space-y-1.5">
                <p className="text-sm font-semibold text-[#1F1A13]">{tr(o.typeLabel)}</p>
                {o.items.map(it => (
                  <div key={it.label}>
                    <div className="flex justify-between text-[11px] text-[#44403a]"><span>{tr(it.label)}</span><span>{pct(it.share)}</span></div>
                    <div className="h-1.5 rounded-full bg-[#F4EEE3] overflow-hidden"><div className="h-full bg-[#E15A30]/80 rounded-full" style={{ width: `${Math.max(0, Math.min(100, it.share * 100))}%` }} /></div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-[#6E6557]">{tr('يحتاج مزيداً من البيانات')}</p>}
      </div>

      {!!hints.length && (
        <div>
          <p className="font-semibold text-[#1F1A13] mb-2 flex items-center gap-2"><Lightbulb size={16} className="text-[#E15A30]" /> {tr('اقتراحات لإدارة الشركة')}</p>
          <ul className="space-y-1.5">
            {hints.map(h => <li key={h.code + h.textAr} className="text-sm text-[#44403a] rounded-xl bg-[#FAF7F0] border border-[#E9E1D3] px-3 py-2">{tr(h.textAr)}</li>)}
          </ul>
        </div>
      )}

      {/* نسخ النموذج */}
      <div>
        <p className="font-semibold text-[#1F1A13] mb-2 flex items-center gap-2"><Layers size={16} className="text-[#E15A30]" /> {tr('نسخ النموذج')}</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {(['POLICY', 'CALIBRATION'] as const).map(kind => {
            const rows = models.filter(r => r.kind === kind).sort((a, b) => b.version - a.version);
            return (
              <div key={kind} className="rounded-xl border border-[#E9E1D3] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-[#1F1A13]">{kind === 'POLICY' ? tr('ترتيب الفرص') : tr('دقّة الطلب التجريبي')}</p>
                  {rows.some(r => r.status === 'ACTIVE') && (
                    <button type="button" disabled={busy} onClick={() => rollback.mutate({ kind, version: 0 })} className="btn-secondary px-2 py-1 text-xs">{tr('رجوع للافتراضي')}</button>
                  )}
                </div>
                {rows.length ? rows.map(r => (
                  <div key={r.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#F4EEE3] pt-2 text-xs">
                    <span className="font-semibold text-[#1F1A13]">{tr('نسخة')} {formatNumber(r.version)}</span>
                    <span className="text-[#6E6557]">{formatDate(r.promotedAt ?? r.trainedAt)}</span>
                    <ModelStatus status={r.status} />
                    {r.summaryAr && <span className="basis-full text-[#44403a]">{r.summaryAr}</span>}
                    {(r.status === 'SUPERSEDED' || r.status === 'ROLLED_BACK') && (
                      <button type="button" disabled={busy} onClick={() => rollback.mutate({ kind, version: r.version })}
                        className="inline-flex items-center gap-1 text-[#C94E28] font-semibold disabled:opacity-50"><RotateCcw size={12} /> {tr('رجوع لهذه النسخة')}</button>
                    )}
                  </div>
                )) : <p className="text-xs text-[#6E6557]">{tr('لا نسخ بعد — يبقى الأساس حتى تثبت نسخة متعلَّمة أفضل منه')}</p>}
              </div>
            );
          })}
        </div>
        <div className="flex justify-end mt-3">
          <button type="button" disabled={busy} onClick={() => setConfirmReset(true)}
            className="rounded-xl border border-red-200 text-red-700 px-3 py-1.5 text-sm font-semibold disabled:opacity-50">{tr('إعادة التعلّم من الصفر')}</button>
        </div>
      </div>

      {!!runs.length && (
        <div>
          <p className="font-semibold text-[#1F1A13] mb-2 flex items-center gap-2"><History size={16} className="text-[#E15A30]" /> {tr('سجلّ التعلّم الليلي')}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-right text-[#6E6557] border-b border-[#E9E1D3]">
                <th className="py-2 font-medium">{tr('اليوم')}</th><th className="py-2 font-medium">{tr('الحالة')}</th>
                <th className="py-2 font-medium">{tr('المراجعة الذاتية بالعقل')}</th><th className="py-2 font-medium">{tr('الخطوات')}</th><th className="py-2 font-medium">{tr('رموز العقل')}</th>
              </tr></thead>
              <tbody>
                {runs.slice(0, 14).map(r => {
                  const steps = Object.values(r.steps ?? {});
                  return (
                    <tr key={r.day} className="border-b border-[#F4EEE3]">
                      <td className="py-1.5">{formatDayOnly(r.day)}</td>
                      <td className={`py-1.5 ${r.status === 'FAILED' ? 'text-red-600' : r.status === 'PARTIAL' ? 'text-amber-700' : ''}`}>{runStatusText(r.status)}</td>
                      <td className="py-1.5">{llmText(r.llm)}</td>
                      <td className="py-1.5">{steps.filter(s => s.ok).length}/{steps.length}</td>
                      <td className="py-1.5">{formatNumber((r.tokensIn ?? 0) + (r.tokensOut ?? 0))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {confirmReset && (
        <ConfirmDialog danger title={tr('إعادة التعلّم من الصفر')} message={tr('متأكد؟ سيعود العقل للأساس ويبدأ التعلّم من جديد، وتبقى بيانات الزيارات كما هي')}
          confirmLabel={tr('إعادة التعلّم من الصفر')} loading={reset.isPending} onConfirm={() => reset.mutate()} onClose={() => setConfirmReset(false)} />
      )}
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-[#E9E1D3] bg-[#FAF7F0] px-2.5 py-1 text-[#44403a]">{children}</span>;
}

function VerdictBadge({ v, n }: { v: Verdict; n: number }) {
  const tr = useAiRepTr();
  const tone = v === 'CONFIRMED' ? 'bg-green-50 text-green-700 border-green-200'
    : v === 'HINT' ? 'bg-amber-50 text-amber-700 border-amber-200'
      : v === 'WORSE' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-[#F4EEE3] text-[#6E6557] border-[#E9E1D3]';
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{tr(VERDICT_LABEL[v])}{v === 'NEEDS_DATA' ? '' : ` (n=${n})`}</span>;
}

function MetricCard({ title, caption, arrow, beforeLabel, before, afterLabel, after, verdict, n, children }: {
  title: string; caption: string; arrow: string; beforeLabel: string; before: string; afterLabel: string; after: string; verdict: Verdict; n: number; children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3.5 flex flex-col gap-2">
      <div>
        <p className="text-sm font-semibold text-[#1F1A13]">{title}</p>
        <p className="text-[11px] text-[#8A8178] leading-4">{caption}</p>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div><p className="text-[10px] text-[#6E6557]">{beforeLabel}</p><p className="text-lg font-bold text-[#6E6557]">{before}</p></div>
        <span className="text-[#E15A30] pb-1">{arrow}</span>
        <div className="text-end"><p className="text-[10px] text-[#6E6557]">{afterLabel}</p><p className="text-lg font-bold text-[#1F1A13]">{after}</p></div>
      </div>
      {children}
      <div className="mt-auto"><VerdictBadge v={verdict} n={n} /></div>
    </div>
  );
}

function ModelStatus({ status }: { status: string }) {
  const tr = useAiRepTr();
  const [label, tone] = status === 'ACTIVE' ? [tr('الحالية'), 'bg-green-50 text-green-700']
    : status === 'SUPERSEDED' ? [tr('سابقة'), 'bg-[#F4EEE3] text-[#6E6557]']
      : status === 'ROLLED_BACK' ? [tr('أُرجعت'), 'bg-red-50 text-red-700']
        : status === 'REJECTED' ? [tr('مرفوضة'), 'bg-[#F4EEE3] text-[#8A8178]'] : [tr('مرشّحة'), 'bg-amber-50 text-amber-700'];
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{label}</span>;
}

function LessonItem({ l, arrow, busy, onAction }: { l: LessonRow; arrow: string; busy: boolean; onAction: (a: LessonAction) => void }) {
  const tr = useAiRepTr();
  const [open, setOpen] = useState(false);
  const typeLabel = l.outletType ? OUTLET_TYPE_OPTIONS.find(o => o.code === l.outletType)?.label ?? null : null;
  const statusText = (s: string | null | undefined) => {
    switch (s) {
      case 'ACTIVE': return tr('فعّالة');
      case 'TRIAL': return tr('قيد التجربة');
      case 'PENDING': return tr('بانتظار مراجعتك');
      case 'RETIRED': return tr('متقاعدة');
      case 'DISABLED': return tr('معطّلة');
      case 'REJECTED': return tr('مرفوضة');
      default: return '—';
    }
  };
  const actionText = (a: LessonAction) => (a === 'approve' ? tr('اعتمد') : a === 'reject' ? tr('ارفض') : a === 'disable' ? tr('عطّل') : a === 'enable' ? tr('فعّل') : tr('استعد'));
  // سبب الحالة: رمز معروف بالعربية؛ تعطيل الإدارة برمز غير معروف = «أوقفته الإدارة»
  const reason = (code: string | null | undefined, status?: string) =>
    code && LESSON_REASON_LABEL[code] ? tr(LESSON_REASON_LABEL[code]) : status === 'DISABLED' ? tr('أوقفته الإدارة') : null;
  const items = l.evidence?.items ?? [];
  const history = (l.history ?? []).slice(-6).reverse();
  const st = reason(l.statusReason, l.status);

  return (
    <div className="rounded-xl border border-[#E9E1D3] p-3">
      <p className="text-sm text-[#1F1A13] leading-6" dir="rtl">{l.textAr}</p>
      <div className="flex flex-wrap items-center gap-1.5 mt-2 text-[10px]">
        {typeLabel && <span className="rounded-full bg-[#FBEBE2] text-[#C94E28] px-2 py-0.5">{tr(typeLabel)}</span>}
        {LESSON_ORIGIN_LABEL[l.origin] && <span className="rounded-full bg-[#F4EEE3] text-[#44403a] px-2 py-0.5">{tr(LESSON_ORIGIN_LABEL[l.origin])}</span>}
        {st && <span className="rounded-full bg-[#F4EEE3] text-[#6E6557] px-2 py-0.5">{st}</span>}
        <button type="button" onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-0.5 text-[#C94E28] font-semibold">
          {tr('الدليل')} {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <span className="flex-1" />
        {lessonActions(l.status).map(a => (
          <button key={a} type="button" disabled={busy} onClick={() => onAction(a)}
            className={`rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${a === 'approve' || a === 'enable' || a === 'restore' ? 'border-[#E15A30] text-[#C94E28]' : 'border-[#E9E1D3] text-[#44403a]'}`}>
            {actionText(a)}
          </button>
        ))}
      </div>
      {open && (
        <div className="mt-2 rounded-lg bg-[#FAF7F0] border border-[#E9E1D3] p-2.5 space-y-1 text-[11px] text-[#44403a]">
          {items.map((it, i) => (
            <p key={i}>{tr('حالات')}: <b>{formatNumber(it.n ?? 0)}</b> · {tr('مناديب')}: <b>{formatNumber(it.reps ?? 0)}</b>
              {it.topRepShare != null && <> · {tr('حصة أكبر مندوب')}: <b>{pct(it.topRepShare)}</b></>}</p>
          ))}
          {l.evidence?.windowDays != null && <p>{tr('الفترة')}: {formatNumber(l.evidence.windowDays)} {tr('يوماً')}</p>}
          {l.onOff && (
            <>
              <p>{tr('جودة الردود')}: {tr('مع الدرس')} <b>{pct(l.onOff.qOn)}</b> (n={l.onOff.on}) · {tr('بدونه')} <b>{pct(l.onOff.qOff)}</b> (n={l.onOff.off})</p>
              <p className="flex items-center gap-2"><ThumbsUp size={11} /> {l.onOff.up} <ThumbsDown size={11} /> {l.onOff.down}</p>
            </>
          )}
          {!!history.length && (
            <div className="pt-1">
              <p className="font-semibold">{tr('السجلّ')}</p>
              {history.map((h, i) => (
                <p key={i} className="text-[#6E6557]">
                  {h.at ? formatDate(h.at) : '—'} · {statusText(h.from)} {arrow} {statusText(h.to)} · {h.by === 'SYSTEM' ? tr('النظام') : tr('الإدارة')}{reason(h.reason) ? ` · ${reason(h.reason)}` : ''}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
