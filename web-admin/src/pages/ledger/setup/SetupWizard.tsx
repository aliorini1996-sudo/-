import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Landmark, ListOrdered } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useAuthStore } from '../../../store/authStore';
import { canLedger } from '../../../lib/ledgerPerms';
import { ledgerErrorOf, ledgerKeys, isLedgerAccessError } from '../../../api/ledgerConfig';
import {
  ledgerSetupApi, ledgerSetupKeys,
  type SetupCommitResult, type SetupDraft, type SetupState, type SetupStateBefore,
} from '../../../api/ledgerSetup';
import { ledgerHref } from '../routes';
import { clampStep, prevStep, SETUP_STEPS, setupStepFromSearch, timezoneImportsConflictOf, type SetupStepNo, type TimezoneImportsConflict } from './setupLogic';
import { BackfillStatusCard, DataImportLink, Notice, TimezoneImportsConflictNotice, useCommitResult, useSetupErrorText, useSetupState, WarehouseLink } from './setupUi';
import { Step1Basics, Step2Method, Step3Tree } from './SetupSteps';
import ManualBalances from './ManualBalances';
import { CommitResultPanel, Step6Review } from './SetupReview';

/**
 * معالج «إعداد النظام المحاسبي المتكامل» (§5.6، §8.2 الفهرس) — يظهر في LedgerHome قبل التفعيل لمن يملك
 * canConfigureLedger. ست خطوات، وكل خطوة تُحفظ مسودة في `GlSettings.setupDraft` (POST /setup/draft) مع
 * `currentStep` فيستأنف المستخدم من حيث توقف، والخطوة الأخيرة معاملة التفعيل الواحدة. خمس خطوات: خطوة «الأرصدة
 * المشتقة» أُزيلت بقرار الخبير المحاسبي (٢٧ سبتمبر ٢٠٢٦) — أرقامها الداخلية 1·2·3·5·6 كما في المسودات المخزّنة،
 * والمعروض ترتيبها 1..5.
 * بعد التفعيل تُعرض الأرقام النهائية الملتزمة وتقدم الترحيل التاريخي.
 */
export default function SetupWizard() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const canWrite = canLedger(user, 'canConfigureLedger');
  const errorText = useSetupErrorText();
  const q = useSetupState(canWrite);
  // زرّ «أكمل الإعداد» يقصد خطوة بعينها (`?setupStep=N`): تُقرأ مرة واحدة عند التحميل (تهيئة كسولة،
  // فإعادة الرسم لا تعيد فتحها)، وهي وجهة أولى لا سجن — تصفّح المستخدم بعدها حرّ.
  const { search } = useLocation();
  const [requestedStep] = useState<SetupStepNo | null>(() => setupStepFromSearch(search));
  const [step, setStep] = useState<SetupStepNo | null>(null);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const [result, setResult] = useCommitResult();
  // البند 25: 409 تعارض المنطقة الزمنية — التفاصيل والطلب المرفوض كي يُعاد إرساله بالإقرار
  const [tzConflict, setTzConflict] = useState<{ detail: TimezoneImportsConflict; patch: SetupDraft; next: number } | null>(null);

  const before = q.data && !q.data.activated ? q.data : null;
  useEffect(() => {
    if (before && step === null) setStep(requestedStep ?? clampStep(before.draft.currentStep ?? 1));
  }, [before, step, requestedStep]);

  const save = useMutation({
    mutationFn: async ({ patch, next, rebaseImportDates }: { patch: SetupDraft; next: number; rebaseImportDates?: boolean }) =>
      (await ledgerSetupApi.saveDraft({ ...patch, currentStep: next }, { rebaseImportDates })).data.data,
    onSuccess: (d, { next }) => {
      setLastErrorCode(null);
      setTzConflict(null);
      if (d.rebasedImportEntries !== undefined) {
        toast.success(tr('أُعيد ضبط تواريخ {count} قيداً مستورداً على المنطقة الزمنية الجديدة').replace('{count}', String(d.rebasedImportEntries)));
      }
      qc.setQueryData<SetupState>(ledgerSetupKeys.setup, old => (old && !old.activated
        ? { ...old, draft: d.draft, effective: d.effective, history: d.history ? { ...old.history, ...d.history } : old.history }
        : old));
      qc.invalidateQueries({ queryKey: ledgerSetupKeys.setup, exact: true });
      qc.invalidateQueries({ queryKey: ledgerKeys.status });
      setStep(clampStep(next));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onError: (e, { patch, next }) => {
      setLastErrorCode(ledgerErrorOf(e)?.code ?? null);
      // تعارض المنطقة الزمنية ليس فشلاً نهائياً: يُعرض بتفاصيله وزرِّ إقرار يعيد إرسال الطلب نفسه
      const detail = timezoneImportsConflictOf(ledgerErrorOf(e));
      setTzConflict(detail ? { detail, patch, next } : null);
      toast.error(errorText(e));
    },
  });

  const onCommitted = (r: SetupCommitResult) => {
    setResult(r);
    toast.success(tr('تم تفعيل الدفاتر'));
    qc.invalidateQueries({ queryKey: ledgerKeys.all });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  if (!canWrite) return null;
  if (q.isLoading) return <p className="text-sm text-[#9A8F7E] py-10 text-center">{tr('جاري التحميل...')}</p>;
  if (q.isError) {
    return (
      <div className="card max-w-xl mx-auto text-center py-8 text-sm text-[#8E2A1F]">
        {isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : errorText(q.error, tr('تعذر تحميل البيانات'))}
      </div>
    );
  }

  const decimals = result?.status.currencyDecimals ?? q.data?.status.currencyDecimals ?? 2;

  if (result || q.data?.activated) {
    const status = result?.status ?? q.data!.status;
    const progress = q.data?.activated ? q.data.progress : null;
    return (
      <div className="max-w-5xl mx-auto space-y-4">
        {result && <div className="card"><CommitResultPanel result={result} decimals={decimals} /></div>}
        <div className="card space-y-3">
          <h2 className="text-base font-bold text-[#1F1A13]">{tr('الترحيل التاريخي')}</h2>
          <BackfillStatusCard progress={progress} state={q.data?.activated ? q.data.status.backfillState : status.backfillState} canWrite={canWrite} />
          <Link to={ledgerHref('config/settings')} className="text-xs text-[#E15A30] hover:underline">{tr('الإعدادات')} ←</Link>
        </div>
      </div>
    );
  }

  const state = before as SetupStateBefore;
  const current = step ?? 1;
  const titles: Record<SetupStepNo, string> = {
    1: tr('الأساس'), 2: tr('طريقة البدء'), 3: tr('الشجرة'), 5: tr('الأرصدة اليدوية'), 6: tr('المراجعة والتفعيل'),
  };
  const reached = clampStep(state.draft.currentStep ?? 1);
  const common = {
    state, canWrite, busy: save.isPending, lastErrorCode,
    onSave: (patch: SetupDraft, next: number) => save.mutate({ patch, next }),
    onBack: () => setStep(s => prevStep(s ?? 2)),
  };

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <div className="card">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-2xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0"><Landmark size={20} /></div>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-[#1F1A13]">{tr('إعداد النظام المحاسبي المتكامل')}</h1>
            <p className="text-xs text-[#9A8F7E] mt-0.5 leading-relaxed">{tr('كل خطوة تُحفظ مسودة، ويمكنك العودة لإكمالها لاحقا. لا يُرحَّل شيء قبل التفعيل في الخطوة الأخيرة')}</p>
          </div>
        </div>
        <ol className="mt-4 grid grid-cols-3 sm:grid-cols-5 gap-2" aria-label={tr('خطوات الإعداد')}>
          {SETUP_STEPS.map((n, idx) => {
            const done = n < current;
            const active = n === current;
            const reachable = n <= Math.max(reached, current) && !save.isPending;
            return (
              <li key={n}>
                <button type="button" disabled={!reachable} onClick={() => setStep(n)} aria-current={active ? 'step' : undefined}
                  className={`w-full text-start rounded-xl border px-2.5 py-2 transition-colors ${active ? 'border-[#E15A30] bg-[#FBEBE2]/60' : done ? 'border-[#E8E0D2] bg-white' : 'border-[#F1EBDF] bg-[#FBF7F0]'} ${reachable ? 'hover:border-[#E15A30]' : 'cursor-not-allowed opacity-60'}`}>
                  <span className={`inline-flex w-5 h-5 rounded-full items-center justify-center text-[11px] font-bold ${active ? 'bg-[#E15A30] text-white' : done ? 'bg-emerald-600 text-white' : 'bg-[#E8E0D2] text-[#6E6557]'}`}>
                    {done ? <Check size={12} /> : <bdi className="tabular-nums">{idx + 1}</bdi>}
                  </span>
                  <span className="block text-xs mt-1 text-[#1F1A13] leading-tight">{titles[n]}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <BeforeYouStart key={current === 1 ? 'open' : 'closed'} open={current === 1} />

      <div className="card space-y-3">
        <h2 className="text-base font-bold text-[#1F1A13]"><bdi className="tabular-nums text-[#9A8F7E]">{SETUP_STEPS.indexOf(current) + 1}.</bdi> {titles[current]}</h2>
        {save.isError && lastErrorCode === 'LEDGER_HISTORY_TOO_LARGE' && <Notice tone="error">{errorText(save.error)}</Notice>}
        {tzConflict && (
          <TimezoneImportsConflictNotice detail={tzConflict.detail} busy={save.isPending} canWrite={canWrite}
            onConfirm={() => save.mutate({ patch: tzConflict.patch, next: tzConflict.next, rebaseImportDates: true })} />
        )}
        {current === 1 && <Step1Basics key={`s1:${state.draft.step1?.cutoverDate ?? ''}`} {...common} onBack={undefined} />}
        {current === 2 && <Step2Method {...common} />}
        {current === 3 && <Step3Tree {...common} />}
        {current === 5 && <ManualBalances {...common} />}
        {current === 6 && <Step6Review {...common} onCommitted={onCommitted} />}
      </div>
    </div>
  );
}

/**
 * «قبل أن تبدأ»: الترتيب الموصى به بين صفحة استيراد البيانات والمعالج. بعد إزالة الأرصدة المشتقة لا يدخل القيد
 * الافتتاحي شيءٌ من المستورد آلياً (أرصدة العملاء ولا المخزون): المستورد يخدم التشغيل، والقيد الافتتاحي يُدخله المحاسب.
 */
function BeforeYouStart({ open }: { open: boolean }) {
  const tr = useTr();
  return (
    <details className="card group" open={open}>
      <summary className="flex items-center gap-2 cursor-pointer select-none text-sm font-bold text-[#1F1A13]">
        <ListOrdered size={16} className="text-[#E15A30]" />{tr('قبل أن تبدأ')}
        <span className="text-[11px] font-normal text-[#9A8F7E]">{tr('الترتيب الموصى به لنقل بياناتك')}</span>
      </summary>
      <ol className="list-decimal ps-5 mt-3 space-y-1.5 text-xs text-[#6E6557] leading-relaxed">
        <li>{tr('استورد العملاء ثم المنتجات')} — <DataImportLink>{tr('استيراد البيانات من نظامك السابق')}</DataImportLink></li>
        <li>
          {tr('المخزون وأرصدة العملاء المستوردة تخدم التطبيق (المستودع وكشوف العملاء) ولا تدخل القيد الافتتاحي آليا')}
          {' — '}<DataImportLink>{tr('استيراد البيانات من نظامك السابق')}</DataImportLink>
          {' · '}<WarehouseLink>{tr('وارد المستودع')}</WarehouseLink>
        </li>
        <li>{tr('حدّد تاريخ البدء في الخطوة 1، ولا تفعّل الدفاتر بعد')}</li>
        <li>{tr('في المعالج: اربط فئات المنتجات في الخطوة 3، وأدخل كل الأرصدة الافتتاحية من دفاترك السابقة في الخطوة 4 (ومنها ذمم كل عميل وعهدة كل مندوب ومخزون المستودع)، ثم راجع وفعّل في الخطوة 5')}</li>
      </ol>
    </details>
  );
}
