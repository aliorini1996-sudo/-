import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { formatDateTime } from '../../../utils/format';
import { ledgerErrorOf, ledgerKeys, type BackfillState } from '../../../api/ledgerConfig';
import { ledgerSetupApi, ledgerSetupKeys, type BackfillProgress, type SetupCommitResult, type SetupState } from '../../../api/ledgerSetup';
import { useConfigErrorText, WriteButton } from '../config/parts/configUi';

/**
 * أجزاء معالج الإعداد المشتركة (M3، §5.6، §8.4 القسم 2): نص أخطاء المعالج، وتسميات أسباب صفوف الأرصدة اليدوية،
 * وبطاقة تقدم الترحيل التاريخي بزر «إيقاف مؤقت»/«استئناف» (في LedgerHome وصفحة الإعدادات).
 */

type Tr = (ar: string) => string;

/** أسباب رفض صفوف الأرصدة اليدوية (MANUAL_BALANCE_ISSUES) */
export const manualIssueLabels = (tr: Tr): Record<string, string> => ({
  ACCOUNT_NOT_FOUND: tr('الحساب غير موجود'),
  ACCOUNT_ARCHIVED: tr('الحساب مؤرشف'),
  DERIVED_ACCOUNT: tr('رصيد هذا الحساب يُحسب من المستندات ولا يُدخل يدويا'),
  OPENING_EQUITY: tr('حساب الأرصدة الافتتاحية يأخذ الفرق آليا'),
  EQUITY_UNAFFECTED: tr('أرباح السنة الجارية يحسبها النظام'),
  OFF_BALANCE: tr('لا تُدخل أرصدة افتتاحية لحسابات خارج الميزانية'),
  VAT_REQUIRES_MID_PERIOD: tr('أرصدة ضريبة المخرجات والمدخلات للفترة المفتوحة تُقبل فقط مع تاريخ بدء مؤكد داخل فترة إقرار'),
  VENDOR_REQUIRED: tr('سطر الموردين يتطلب اسم المورد'),
  INVALID_AMOUNT: tr('مبلغ غير صالح'),
  NEGATIVE_AMOUNT: tr('المبلغ لا يكون سالبا'),
  DEBIT_AND_CREDIT: tr('السطر لا يحمل مدينا ودائنا معا'),
  ZERO_AMOUNT: tr('سطر بلا مبلغ'),
  INVALID_DUE_DATE: tr('تاريخ الاستحقاق غير صالح'),
});

/** نص خطأ نقاط المعالج: رموز الإعداد وأسبابه أولاً، ثم نص التهيئة العام. */
export function useSetupErrorText() {
  const tr = useTr();
  const base = useConfigErrorText();
  return (err: unknown, fallback?: string): string => {
    const b = ledgerErrorOf(err);
    if (!b) return fallback ?? tr('تعذر تنفيذ الإجراء');
    const reason = typeof b.reason === 'string' ? b.reason : typeof b.details?.reason === 'string' ? (b.details.reason as string) : undefined;
    const reasons: Record<string, string> = {
      ALREADY_ACTIVATED: tr('النظام المحاسبي المتكامل مفعّل مسبقا لهذه الشركة'),
      CUTOVER_REQUIRED: tr('تاريخ البدء مطلوب'),
      STATUTORY_ACK_REQUIRED: tr('يجب الإقرار بتنبيه السجلات المحاسبية النظامية قبل التفعيل'),
      OPENING_BALANCE_ROWS_INVALID: tr('أرصدة افتتاحية يدوية غير صالحة'),
      BACKFILL_STATE_CONFLICT: tr('لا يمكن تغيير حالة الترحيل التاريخي من حالتها الحالية'),
      CATEGORY_ACCOUNT_TYPE: tr('نوع الحساب لا يوافق حقل الفئة'),
    };
    if (reason && reasons[reason]) return reasons[reason];
    switch (b.code) {
      case 'LEDGER_CUTOVER_IN_FUTURE': return tr('لا يجوز تاريخ بدء بعد اليوم بتوقيت الشركة');
      case 'LEDGER_CUTOVER_MID_VAT_PERIOD': return tr('تاريخ البدء داخل فترة إقرار: أكّد الاختيار وأدخل مبالغ المربعات قبل البدء، أو اختر بداية فترة');
      case 'LEDGER_HISTORY_TOO_LARGE': return tr('الترحيل التاريخي الكامل يتجاوز السقف المسموح، فاختر الأرصدة الافتتاحية');
      case 'ACCOUNTING_SUITE_NOT_ALLOWED': return tr('النظام المحاسبي المتكامل غير مفعل لشركتك');
      default: break;
    }
    if (!b.status) return fallback ?? tr('تعذر الاتصال بالخادم، أعد المحاولة');
    return base(err, fallback);
  };
}

export function backfillStateLabels(tr: Tr): Record<BackfillState, string> {
  return { NONE: tr('لم يبدأ'), RUNNING: tr('جار'), DONE: tr('مكتمل'), PAUSED: tr('موقوف مؤقتا') };
}

export const syncSourceLabels = (tr: Tr): Record<string, string> => ({
  ACCOUNT_ENTRY: tr('حركات حسابات العملاء'),
  REP_SETTLEMENT: tr('استلامات عهدة المناديب'),
  SETTLEMENT_ENTRY: tr('أمانات الدفع الإلكتروني'),
  WAREHOUSE_ENTRY: tr('حركات المستودع'),
  VAN_LOAD: tr('تحميل السيارات'),
  RETURN_RESTOCK: tr('المرتجعات إلى المخزون'),
});

/** حالة الإعداد بعد التفعيل من GET /setup (canConfigureLedger) — تحدّث كل 30 ثانية أثناء الترحيل. */
export function useSetupState(enabled = true) {
  return useQuery({
    queryKey: ledgerSetupKeys.setup,
    queryFn: async () => (await ledgerSetupApi.get()).data.data as SetupState,
    enabled,
    refetchInterval: q => {
      const d = q.state.data as SetupState | undefined;
      return d?.activated && (d.status.backfillState === 'RUNNING' || d.status.backfillState === 'PAUSED') ? 30_000 : false;
    },
  });
}

/** نتيجة التفعيل الأخيرة (الأرقام النهائية الملتزمة) — تبقى بعد انتقال الفهرس إلى حالة «مفعّلة» حتى تُغلق. */
export function useCommitResult(): [SetupCommitResult | null, (r: SetupCommitResult | null) => void] {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ledgerSetupKeys.commitResult,
    queryFn: () => null as SetupCommitResult | null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return [q.data ?? null, r => qc.setQueryData(ledgerSetupKeys.commitResult, r)];
}

function lagText(tr: Tr, ms: number): string {
  if (ms <= 0) return tr('محدّث');
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} ${tr('دقيقة')}`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ${tr('ساعة')}`;
  return `${Math.round(h / 24)} ${tr('يوم')}`;
}

/**
 * تقدم الترحيل التاريخي (§5.6 «التقدم»، §8.4 القسم 2): الحالة، والمصادر ومؤشراتها وتأخرها، والأحداث المعلّقة وETA،
 * وزر «إيقاف مؤقت» (RUNNING ⇒ PAUSED) أو «استئناف» (PAUSED ⇒ RUNNING) بصلاحية canConfigureLedger.
 */
export function BackfillStatusCard({ progress, state, canWrite, compact }: {
  progress: BackfillProgress | null;
  state: BackfillState;
  canWrite: boolean;
  compact?: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const errorText = useSetupErrorText();
  const labels = backfillStateLabels(tr);
  const sources = syncSourceLabels(tr);
  const toggle = useMutation({
    mutationFn: async (action: 'PAUSE' | 'RESUME') => (await ledgerSetupApi.backfill(action)).data.data,
    onSuccess: d => {
      toast.success(d.backfillState === 'PAUSED' ? tr('أُوقف الترحيل التاريخي مؤقتا') : tr('استُؤنف الترحيل التاريخي'));
      qc.invalidateQueries({ queryKey: ledgerSetupKeys.setup });
      qc.invalidateQueries({ queryKey: ledgerKeys.status });
      qc.invalidateQueries({ queryKey: ledgerKeys.settings });
    },
    onError: e => { toast.error(errorText(e)); qc.invalidateQueries({ queryKey: ledgerSetupKeys.setup }); },
  });

  const tone = state === 'DONE' ? 'bg-emerald-50 text-emerald-700' : state === 'PAUSED' ? 'bg-amber-50 text-amber-800' : state === 'RUNNING' ? 'bg-[#FBEBE2] text-[#B8431F]' : 'bg-[#F1EBDF] text-[#6E6557]';
  const icon = state === 'DONE' ? <CheckCircle2 size={14} /> : state === 'RUNNING' ? <Loader2 size={14} className="animate-spin" /> : state === 'PAUSED' ? <Pause size={14} /> : null;
  const total = progress ? progress.doneEvents + progress.openEvents : 0;
  const pct = progress && total > 0 ? Math.min(100, Math.round((progress.doneEvents / total) * 100)) : state === 'DONE' ? 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${tone}`}>{icon}{labels[state] ?? state}</span>
        {progress && progress.etaMinutes != null && state !== 'DONE' && (
          <span className="text-xs text-[#6E6557]">{tr('الوقت المتبقي التقريبي')}: <bdi className="tabular-nums">{progress.etaMinutes}</bdi> {tr('دقيقة')}</span>
        )}
        <span className="flex-1" />
        {state === 'RUNNING' && (
          <WriteButton allowed={canWrite} busy={toggle.isPending} onClick={() => toggle.mutate('PAUSE')} className="btn-secondary inline-flex items-center gap-1.5">
            <Pause size={14} />{tr('إيقاف مؤقت')}
          </WriteButton>
        )}
        {state === 'PAUSED' && (
          <WriteButton allowed={canWrite} busy={toggle.isPending} onClick={() => toggle.mutate('RESUME')} className="btn-primary inline-flex items-center gap-1.5">
            <Play size={14} />{tr('استئناف')}
          </WriteButton>
        )}
      </div>
      {progress && (
        <>
          <div className="h-2 rounded-full bg-[#F1EBDF] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={tr('تقدم الترحيل التاريخي')}>
            <div className={`h-full rounded-full transition-all ${state === 'PAUSED' ? 'bg-amber-400' : 'bg-[#E15A30]'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6E6557]">
            <span>{tr('أحداث مكتملة')}: <bdi className="tabular-nums">{progress.doneEvents}</bdi></span>
            <span>{tr('أحداث بانتظار الترحيل')}: <bdi className="tabular-nums">{progress.pendingEvents}</bdi></span>
            {progress.openEvents > progress.pendingEvents && (
              <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={12} />{tr('أحداث تحتاج مراجعة')}: <bdi className="tabular-nums">{progress.openEvents - progress.pendingEvents}</bdi></span>
            )}
          </div>
          {!compact && progress.sources.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[#9A8F7E] text-start">
                    <th className="text-start font-medium py-1 pe-3">{tr('المصدر')}</th>
                    <th className="text-start font-medium py-1 pe-3">{tr('آخر مؤشر')}</th>
                    <th className="text-start font-medium py-1 pe-3">{tr('آخر تشغيل')}</th>
                    <th className="text-start font-medium py-1">{tr('التأخر')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F1EBDF]">
                  {progress.sources.map(s => (
                    <tr key={s.source}>
                      <td className="py-1.5 pe-3">{sources[s.source] ?? s.source}</td>
                      <td className="py-1.5 pe-3 tabular-nums">{formatDateTime(s.watermarkAt)}</td>
                      <td className="py-1.5 pe-3 tabular-nums">{s.lastRunAt ? formatDateTime(s.lastRunAt) : '—'}</td>
                      <td className={`py-1.5 ${s.caughtUp ? 'text-emerald-700' : s.stallTicks > 0 ? 'text-amber-700' : ''}`}>
                        {s.caughtUp ? tr('محدّث') : lagText(tr, s.lagMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {state === 'PAUSED' && <p className="text-[11px] text-[#9A8F7E]">{tr('أثناء الإيقاف المؤقت لا تُقرأ مستندات جديدة للترحيل، والمستندات التشغيلية تعمل كالمعتاد')}</p>}
    </div>
  );
}

/** عنوان قسم داخل خطوة */
export function StepSection({ title, hint, children, actions }: { title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-[#F1EBDF] p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-[#1F1A13]">{title}</h3>
          {hint && <p className="text-[11px] text-[#9A8F7E] mt-0.5 leading-relaxed">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  const cls = {
    info: 'border-[#E8E0D2] bg-[#FBF7F0] text-[#6E6557]',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-red-200 bg-red-50 text-[#8E2A1F]',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[tone];
  return <div className={`rounded-xl border px-3 py-2 text-xs leading-relaxed ${cls}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}
