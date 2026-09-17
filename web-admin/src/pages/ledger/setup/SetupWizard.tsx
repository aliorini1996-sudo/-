import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Landmark } from 'lucide-react';
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
import { clampStep, type SetupStepNo } from './setupLogic';
import { BackfillStatusCard, Notice, useCommitResult, useSetupErrorText, useSetupState } from './setupUi';
import { Step1Basics, Step2Method, Step3Tree } from './SetupSteps';
import ManualBalances from './ManualBalances';
import { CommitResultPanel, Step4Preview, Step6Review } from './SetupReview';

/**
 * معالج «إعداد النظام المحاسبي المتكامل» (§5.6، §8.2 الفهرس) — يظهر في LedgerHome قبل التفعيل لمن يملك
 * canConfigureLedger. ست خطوات، وكل خطوة تُحفظ مسودة في `GlSettings.setupDraft` (POST /setup/draft) مع
 * `currentStep` فيستأنف المستخدم من حيث توقف. الخطوة 4 معاينة إرشادية، والخطوة 6 معاملة التفعيل الواحدة.
 * بعد التفعيل تُعرض الأرقام النهائية الملتزمة وتقدم الترحيل التاريخي.
 */
export default function SetupWizard() {
  const tr = useTr();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const canWrite = canLedger(user, 'canConfigureLedger');
  const errorText = useSetupErrorText();
  const q = useSetupState(canWrite);
  const [step, setStep] = useState<SetupStepNo | null>(null);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  const [result, setResult] = useCommitResult();

  const before = q.data && !q.data.activated ? q.data : null;
  useEffect(() => {
    if (before && step === null) setStep(clampStep(before.draft.currentStep ?? 1));
  }, [before, step]);

  const save = useMutation({
    mutationFn: async ({ patch, next }: { patch: SetupDraft; next: number }) =>
      (await ledgerSetupApi.saveDraft({ ...patch, currentStep: next })).data.data,
    onSuccess: (d, { next }) => {
      setLastErrorCode(null);
      qc.setQueryData<SetupState>(ledgerSetupKeys.setup, old => (old && !old.activated
        ? { ...old, draft: d.draft, effective: d.effective, history: d.history ? { ...old.history, ...d.history } : old.history }
        : old));
      qc.invalidateQueries({ queryKey: ledgerSetupKeys.setup, exact: true });
      qc.invalidateQueries({ queryKey: ledgerKeys.status });
      setStep(clampStep(next));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onError: e => {
      setLastErrorCode(ledgerErrorOf(e)?.code ?? null);
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
    1: tr('الأساس'), 2: tr('طريقة البدء'), 3: tr('الشجرة'), 4: tr('الأرصدة المشتقة'), 5: tr('الأرصدة اليدوية'), 6: tr('المراجعة والتفعيل'),
  };
  const reached = clampStep(state.draft.currentStep ?? 1);
  const common = {
    state, canWrite, busy: save.isPending, lastErrorCode,
    onSave: (patch: SetupDraft, next: number) => save.mutate({ patch, next }),
    onBack: () => setStep(s => clampStep((s ?? 2) - 1)),
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
        <ol className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-2" aria-label={tr('خطوات الإعداد')}>
          {([1, 2, 3, 4, 5, 6] as SetupStepNo[]).map(n => {
            const done = n < current;
            const active = n === current;
            const reachable = n <= Math.max(reached, current) && !save.isPending;
            return (
              <li key={n}>
                <button type="button" disabled={!reachable} onClick={() => setStep(n)} aria-current={active ? 'step' : undefined}
                  className={`w-full text-start rounded-xl border px-2.5 py-2 transition-colors ${active ? 'border-[#E15A30] bg-[#FBEBE2]/60' : done ? 'border-[#E8E0D2] bg-white' : 'border-[#F1EBDF] bg-[#FBF7F0]'} ${reachable ? 'hover:border-[#E15A30]' : 'cursor-not-allowed opacity-60'}`}>
                  <span className={`inline-flex w-5 h-5 rounded-full items-center justify-center text-[11px] font-bold ${active ? 'bg-[#E15A30] text-white' : done ? 'bg-emerald-600 text-white' : 'bg-[#E8E0D2] text-[#6E6557]'}`}>
                    {done ? <Check size={12} /> : <bdi className="tabular-nums">{n}</bdi>}
                  </span>
                  <span className="block text-xs mt-1 text-[#1F1A13] leading-tight">{titles[n]}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="card space-y-3">
        <h2 className="text-base font-bold text-[#1F1A13]"><bdi className="tabular-nums text-[#9A8F7E]">{current}.</bdi> {titles[current]}</h2>
        {save.isError && lastErrorCode === 'LEDGER_HISTORY_TOO_LARGE' && <Notice tone="error">{errorText(save.error)}</Notice>}
        {current === 1 && <Step1Basics key={`s1:${state.draft.step1?.cutoverDate ?? ''}`} {...common} onBack={undefined} />}
        {current === 2 && <Step2Method {...common} />}
        {current === 3 && <Step3Tree {...common} />}
        {current === 4 && <Step4Preview {...common} />}
        {current === 5 && <ManualBalances {...common} />}
        {current === 6 && <Step6Review {...common} onCommitted={onCommitted} />}
      </div>
    </div>
  );
}
