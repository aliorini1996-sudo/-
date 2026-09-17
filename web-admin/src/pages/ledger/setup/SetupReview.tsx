import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, ShieldCheck, Users, Wallet, CreditCard, Warehouse, Truck } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { formatDateTime, formatDayOnly } from '../../../utils/format';
import LedgerAmount from '../../../components/ledger/LedgerAmount';
import {
  ledgerSetupApi, ledgerSetupKeys,
  type DerivedOpeningJson, type OpeningMoveJson, type SetupCommitResult,
} from '../../../api/ledgerSetup';
import { ledgerHref } from '../routes';
import { isZeroAmount } from './setupLogic';
import { manualIssueLabels, Notice, StepSection, useSetupErrorText } from './setupUi';
import { StepFooter, usePeriodicityLabels, type StepProps } from './SetupSteps';

/**
 * الخطوتان 4 و6 (§5.6) ونتيجة التفعيل:
 * - 4. الأرصدة المشتقة **معاينة إرشادية** من `/setup/preview-opening`: لا تُخزَّن ولا تُرسل للاعتماد أبداً.
 * - 6. المراجعة والتفعيل: ملخص الاختيارات، والقيد الافتتاحي المتوقع، ومسودات يدوية قبل تاريخ البدء، وتنبيه
 *   السجلات النظامية (§9.5 G6) بإقرار صريح قبل الزر، ثم `/setup/commit` بمعاملة واحدة.
 * - النتيجة: الأرقام النهائية الملتزمة من رد الاعتماد (لا أرقام المعاينة).
 */

const TOP_ROWS = 50;

/** الأرصدة المشتقة: الذمم لكل عميل، والعهدة لكل مندوب بمكوّناتها، والأمانات، ومخزون المستودع. */
export function OpeningFigures({ opening, decimals, finalNumbers }: { opening: DerivedOpeningJson; decimals: number; finalNumbers?: boolean }) {
  const tr = useTr();
  const [allAr, setAllAr] = useState(false);
  const receivables = [...opening.receivables].filter(r => !isZeroAmount(r.balance));
  const shownAr = allAr ? receivables : receivables.slice(0, TOP_ROWS);
  const tile = (icon: JSX.Element, label: string, value: string, sub?: string) => (
    <div className="rounded-xl border border-[#F1EBDF] p-3">
      <p className="flex items-center gap-1.5 text-[11px] text-[#9A8F7E]"><span className="text-[#E15A30]">{icon}</span>{label}</p>
      <LedgerAmount value={value} decimals={decimals} className="text-base font-bold text-[#1F1A13]" />
      {sub && <p className="text-[11px] text-[#9A8F7E] mt-0.5">{sub}</p>}
    </div>
  );
  return (
    <div className="space-y-4">
      <p className="text-xs text-[#6E6557]">
        {tr('تاريخ البدء')}: <bdi className="tabular-nums">{formatDayOnly(opening.cutoverDate)}</bdi> · {tr('تاريخ القيد الافتتاحي')}: <bdi className="tabular-nums">{formatDayOnly(opening.openingDate)}</bdi>
        {' · '}{finalNumbers ? tr('لقطة التفعيل') : tr('لقطة المعاينة')}: <bdi className="tabular-nums">{formatDateTime(opening.snapshotAt)}</bdi>
      </p>
      <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
        {tile(<Users size={13} />, tr('ذمم العملاء'), opening.receivablesTotal, `${receivables.length} ${tr('عميل')}`)}
        {tile(<Wallet size={13} />, tr('عهدة المناديب'), opening.custodyTotal, `${opening.custody.length} ${tr('مندوب')}`)}
        {tile(<CreditCard size={13} />, tr('أمانات الدفع الإلكتروني'), opening.paylinkHeld)}
        {tile(<Warehouse size={13} />, tr('مخزون المستودع'), opening.warehouse.value,
          opening.warehouse.uncostedProducts > 0 ? `${tr('كمية بلا تكلفة')}: ${opening.warehouse.uncostedQty} (${opening.warehouse.uncostedProducts} ${tr('منتج')})` : undefined)}
      </div>
      {opening.warehouse.uncostedProducts > 0 && (
        <Notice tone="warn">{tr('بعض كميات المستودع بلا تكلفة فلا تدخل قيمتها في القيد الافتتاحي. راجع تكلفة الوارد في المستودع')}</Notice>
      )}
      {!finalNumbers && <Notice><Truck size={12} className="inline me-1" />{tr('بضاعة السيارات لا تُحسب هنا وتُدخل يدويا في الخطوة التالية')}</Notice>}

      <StepSection title={tr('ذمم العملاء')} hint={tr('مجموع حركات حساب كل عميل قبل تاريخ البدء')}>
        {receivables.length === 0 ? <p className="text-sm text-[#9A8F7E]">{tr('لا أرصدة')}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-[#9A8F7E]">
                <th className="text-start font-medium py-1 pe-3">{tr('العميل')}</th>
                <th className="text-start font-medium py-1 pe-3">{tr('الحركات')}</th>
                <th className="text-end font-medium py-1">{tr('الرصيد')}</th>
              </tr></thead>
              <tbody className="divide-y divide-[#F1EBDF]">
                {shownAr.map(r => (
                  <tr key={r.customerId}>
                    <td className="py-1.5 pe-3">{r.customerName ?? '—'}</td>
                    <td className="py-1.5 pe-3 tabular-nums text-[#9A8F7E]">{r.rows}</td>
                    <td className="py-1.5 text-end"><LedgerAmount value={r.balance} decimals={decimals} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {receivables.length > TOP_ROWS && (
              <button type="button" className="text-xs text-[#E15A30] hover:underline mt-2" onClick={() => setAllAr(v => !v)}>
                {allAr ? tr('عرض أقل') : `${tr('عرض الكل')} (${receivables.length})`}
              </button>
            )}
          </div>
        )}
      </StepSection>

      <StepSection title={tr('عهدة المناديب')}
        hint={tr('رصيد العهدة في الدفاتر لكل مندوب، ومعه السندات الإلكترونية غير المصفاة وما صُفّي خارج العهدة والمبيعات النقدية خارجها')}>
        {opening.custody.length === 0 ? <p className="text-sm text-[#9A8F7E]">{tr('لا أرصدة')}</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[44rem]">
              <thead><tr className="text-xs text-[#9A8F7E]">
                <th className="text-start font-medium py-1 pe-3">{tr('المندوب')}</th>
                <th className="text-end font-medium py-1 pe-3">{tr('عهدة الدفاتر')}</th>
                <th className="text-end font-medium py-1 pe-3">{tr('إلكتروني غير مصفّى')}</th>
                <th className="text-end font-medium py-1 pe-3">{tr('مصفّى خارج العهدة')}</th>
                <th className="text-end font-medium py-1 pe-3">{tr('مبيعات نقدية خارج العهدة')}</th>
                <th className="text-end font-medium py-1">{tr('رصيد التحصيل التشغيلي')}</th>
              </tr></thead>
              <tbody className="divide-y divide-[#F1EBDF]">
                {opening.custody.map(c => (
                  <tr key={c.salesRepId}>
                    <td className="py-1.5 pe-3">{c.salesRepName ?? '—'}</td>
                    <td className="py-1.5 pe-3 text-end font-semibold"><LedgerAmount value={c.ledgerCustody} decimals={decimals} /></td>
                    <td className="py-1.5 pe-3 text-end"><LedgerAmount value={c.onlineUncleared} decimals={decimals} /></td>
                    <td className="py-1.5 pe-3 text-end"><LedgerAmount value={c.nonCustodyCleared} decimals={decimals} /></td>
                    <td className="py-1.5 pe-3 text-end"><LedgerAmount value={c.cashSalesOutsideCustody} decimals={decimals} /></td>
                    <td className="py-1.5 text-end"><LedgerAmount value={c.opsOutstanding} decimals={decimals} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </StepSection>
    </div>
  );
}

function MoveSummary({ move, decimals, manualCount }: { move: OpeningMoveJson; decimals: number; manualCount?: number }) {
  const tr = useTr();
  const row = (label: string, value: string) => (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-[#6E6557]">{label}</span><LedgerAmount value={value} decimals={decimals} className="font-semibold" />
    </div>
  );
  return (
    <div className="divide-y divide-[#F1EBDF]">
      {row(tr('إجمالي المدين = إجمالي الدائن'), move.totalDebit)}
      {row(tr('الأرصدة اليدوية: مدين'), move.manualDebit)}
      {row(tr('الأرصدة اليدوية: دائن'), move.manualCredit)}
      {row(tr('الفرق إلى حساب الأرصدة الافتتاحية'), move.equityDiff)}
      <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
        <span className="text-[#6E6557]">{tr('عدد السطور')}</span>
        <bdi className="tabular-nums font-semibold">{move.lineCount}{manualCount != null ? ` (${tr('يدوية')}: ${manualCount})` : ''}</bdi>
      </div>
    </div>
  );
}

// ═══ الخطوة 4 ═══

export function Step4Preview({ state, canWrite, busy, onSave, onBack }: StepProps) {
  const tr = useTr();
  const errorText = useSetupErrorText();
  const decimals = state.status.currencyDecimals ?? 2;
  const q = useQuery({
    queryKey: [...ledgerSetupKeys.setup, 'preview', 'derived'],
    queryFn: async () => (await ledgerSetupApi.previewOpening()).data.data,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return (
    <div className="space-y-4">
      <Notice tone="warn">
        {tr('معاينة إرشادية للقراءة فقط: لا تُخزَّن هذه الأرقام، وتُعاد حسابها داخل معاملة التفعيل بما يصل حتى لحظته')}
      </Notice>
      <div className="flex justify-end">
        <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs" disabled={q.isFetching} onClick={() => void q.refetch()}>
          <RefreshCw size={13} className={q.isFetching ? 'animate-spin' : ''} />{tr('تحديث المعاينة')}
        </button>
      </div>
      {q.isLoading && <p className="text-sm text-[#9A8F7E] py-8 text-center">{tr('جاري حساب الأرصدة...')}</p>}
      {q.isError && <Notice tone="error">{errorText(q.error, tr('تعذر حساب المعاينة'))}</Notice>}
      {q.data && <OpeningFigures opening={q.data.opening} decimals={decimals} />}
      <StepFooter onBack={onBack} onNext={() => onSave({}, 5)} busy={busy} canWrite={canWrite} />
    </div>
  );
}

// ═══ الخطوة 6 ═══

export function Step6Review({ state, canWrite, onBack, onCommitted }: StepProps & { onCommitted: (r: SetupCommitResult) => void }) {
  const tr = useTr();
  const errorText = useSetupErrorText();
  const issueLabels = manualIssueLabels(tr);
  const periodicityLabels = usePeriodicityLabels();
  const decimals = state.status.currencyDecimals ?? 2;
  const [ack, setAck] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const q = useQuery({
    queryKey: [...ledgerSetupKeys.setup, 'preview', 'review'],
    queryFn: async () => (await ledgerSetupApi.previewOpening()).data.data,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const commit = useMutation({
    mutationFn: async () => (await ledgerSetupApi.commit()).data.data,
    onSuccess: r => { setCommitError(null); onCommitted(r); },
    onError: e => setCommitError(errorText(e, tr('تعذر التفعيل'))),
  });

  const d = state.draft;
  const method = d.step2?.method ?? state.effective.method;
  const s1 = d.step1 ?? {};
  const issues = q.data?.manual.issues ?? [];
  const drafts = q.data?.draftsBeforeCutover ?? state.draftsBeforeCutover;
  const blocked = !q.data || issues.length > 0;

  return (
    <div className="space-y-4">
      <StepSection title={tr('ملخص الإعداد')}>
        <dl className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 text-sm">
          {([
            [tr('القالب'), state.effective.templateKey],
            [tr('المنطقة الزمنية'), s1.timezone ?? state.effective.timezone],
            [tr('دورية الإقرار'), periodicityLabels[s1.taxPeriodicity ?? state.effective.taxPeriodicity]],
            [tr('طريقة البدء'), method === 'FULL_HISTORY' ? tr('ترحيل التاريخ الكامل') : tr('أرصدة افتتاحية')],
            [tr('تاريخ البدء'), q.data ? formatDayOnly(q.data.opening.cutoverDate) : s1.cutoverDate ? formatDayOnly(s1.cutoverDate) : '—'],
            [tr('الأرصدة اليدوية'), String(d.step5?.rows.length ?? 0)],
          ] as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex gap-3"><dt className="text-[#9A8F7E] min-w-[8rem]">{k}</dt><dd className="text-[#1F1A13]"><bdi>{v}</bdi></dd></div>
          ))}
        </dl>
        {q.data?.midVatPeriod && <Notice tone="warn">{tr('تاريخ البدء داخل فترة إقرار مؤكد، ومبالغ المربعات قبل البدء تُضاف إلى الإقرار الأول')}</Notice>}
      </StepSection>

      {q.isLoading && <p className="text-sm text-[#9A8F7E] py-6 text-center">{tr('جاري حساب الأرصدة...')}</p>}
      {q.isError && <Notice tone="error">{errorText(q.error, tr('تعذر حساب المعاينة'))}</Notice>}

      {q.data && (
        <StepSection title={tr('القيد الافتتاحي المتوقع')} hint={tr('أرقام إرشادية تُعاد حسابها داخل معاملة التفعيل')}
          actions={(
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs" disabled={q.isFetching} onClick={() => void q.refetch()}>
              <RefreshCw size={13} className={q.isFetching ? 'animate-spin' : ''} />{tr('تحديث المعاينة')}
            </button>
          )}>
          <MoveSummary move={q.data.move} decimals={decimals} manualCount={q.data.manual.lineCount} />
        </StepSection>
      )}

      {issues.length > 0 && (
        <Notice tone="error">
          <p className="font-semibold">{tr('أرصدة افتتاحية يدوية غير صالحة')}: <bdi className="tabular-nums">{issues.length}</bdi></p>
          <ul className="list-disc ps-5 mt-1">
            {issues.slice(0, 10).map(is => (
              <li key={`${is.index}:${is.reason}`}>
                {tr('السطر')} <bdi className="tabular-nums">{is.index + 1}</bdi> · <bdi dir="ltr" className="font-mono">{is.accountCode || '—'}</bdi> — {issueLabels[is.reason] ?? is.reason}
              </li>
            ))}
          </ul>
          <button type="button" className="underline mt-1" onClick={onBack}>{tr('العودة إلى الأرصدة اليدوية')}</button>
        </Notice>
      )}

      {drafts && drafts.count > 0 && (
        <Notice tone="warn">
          <AlertTriangle size={12} className="inline me-1" />
          {tr('مسودات قيود يدوية مؤرخة قبل تاريخ البدء')}: <bdi className="tabular-nums">{drafts.count}</bdi>. {tr('ترحيلها بعد التفعيل يقع قبل تاريخ البدء، فراجعها أو احذفها')}{' '}
          <Link to={drafts.listUrl} className="underline">{tr('عرض المسودات في قيود اليومية')}</Link>
        </Notice>
      )}

      <div className="rounded-xl border-2 border-[#E15A30]/40 bg-[#FBEBE2]/40 p-3 sm:p-4 space-y-3">
        <p className="flex items-start gap-2 text-sm font-semibold text-[#1F1A13]">
          <ShieldCheck size={16} className="text-[#E15A30] shrink-0 mt-0.5" />
          {tr('التفعيل يُنشئ سجلات محاسبية نظامية: بعد أول ترحيل لا تُحذف الدفاتر ولا يُعاد ضبطها، والتصحيح بقيود عكسية أو تسوية')}
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 accent-[#E15A30]" checked={ack} disabled={!canWrite || commit.isPending} onChange={e => setAck(e.target.checked)} />
          <span>{tr('قرأت التنبيه وأوافق على تفعيل الدفاتر')}</span>
        </label>
        {commitError && <Notice tone="error">{commitError}</Notice>}
        {commit.isPending && <p className="text-xs text-[#6E6557]">{tr('جاري التفعيل، قد يستغرق حتى دقيقة. لا تغلق الصفحة')}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary" onClick={onBack} disabled={commit.isPending}>{tr('السابق')}</button>
          <span className="flex-1" />
          <button type="button" className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!canWrite || !ack || blocked || commit.isPending || q.isFetching}
            title={!canWrite ? tr('لا تملك صلاحية التعديل') : blocked ? tr('أصلح الأرصدة اليدوية أولا') : undefined}
            onClick={() => commit.mutate()}>
            <ShieldCheck size={15} />{commit.isPending ? tr('جاري التفعيل...') : tr('تفعيل الدفاتر')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══ نتيجة التفعيل ═══

export function CommitResultPanel({ result, decimals }: { result: SetupCommitResult; decimals: number }) {
  const tr = useTr();
  const seedIssues = result.seed.unresolvedMappings.length + result.seed.conflictingMappings.length + result.seed.conflictingAccountRefs.length;
  return (
    <div className="space-y-4">
      <Notice tone="ok">
        <p className="font-semibold">{tr('تم تفعيل الدفاتر')}</p>
        <p>{tr('الأرقام أدناه نهائية كما التُزمت في معاملة التفعيل، والترحيل الآلي للمستندات بعد تاريخ البدء يعمل الآن في الخلفية')}</p>
      </Notice>
      {result.move.id ? (
        <p className="text-sm">
          {tr('القيد الافتتاحي')}: <Link to={ledgerHref(`entries/${result.move.id}`)} className="text-[#E15A30] hover:underline"><bdi className="font-mono">{result.move.number ?? result.move.id}</bdi></Link>
          {' · '}<bdi className="tabular-nums">{formatDayOnly(result.move.date)}</bdi>
        </p>
      ) : (
        <p className="text-sm text-[#6E6557]">{tr('لا أرصدة افتتاحية، فلم يُنشأ قيد افتتاحي')}</p>
      )}
      <StepSection title={tr('القيد الافتتاحي')}><MoveSummary move={result.move} decimals={decimals} /></StepSection>
      <OpeningFigures opening={result.opening} decimals={decimals} finalNumbers />
      {result.futureDated && (result.futureDated.eventsInserted > 0) && (
        <Notice>{tr('مستندات مؤرخة بعد تاريخ البدء أُدرجت للترحيل')}: <bdi className="tabular-nums">{result.futureDated.eventsInserted}</bdi></Notice>
      )}
      {result.vendorsCreated > 0 && <Notice>{tr('موردون أُنشئوا من الأرصدة اليدوية')}: <bdi className="tabular-nums">{result.vendorsCreated}</bdi></Notice>}
      {seedIssues > 0 && (
        <Notice tone="warn">
          {tr('بعض عناصر القالب لم تُربط وتحتاج مراجعتك')}{' '}
          <Link to={ledgerHref('config/mappings')} className="underline">{tr('ربط الحسابات')}</Link>
        </Notice>
      )}
    </div>
  );
}
