import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { ledgerConfigApi, ledgerKeys, isLedgerAccessError, type GlFiscalYear } from '../../../api/ledgerConfig';
import { fiscalYearOf, todayLocal } from '../../../components/ledger/DateRangePicker';
import { ConfigHeader, ConfigModal, Field, WriteButton, useConfigErrorText, useLedgerCan } from './parts/configUi';

/**
 * السنوات المالية (§2.5): سنة أولى قصيرة أو طويلة حتى 24 شهراً، بلا تداخل. الإقفال نفسه في M12
 * (`/fiscal-years` تحت «الإقفال»)؛ هنا الإنشاء والتعديل للسنوات المفتوحة وحدها.
 */

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** مرآة fiscalYearRangeIssue في الخادم للتحقق المبكر. */
function fiscalYearRangeIssue(from: string, to: string): 'INVALID_RANGE' | 'RANGE_TOO_LONG' | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return 'INVALID_RANGE';
  const [y, m, d] = from.split('-').map(Number);
  const limit = new Date(Date.UTC(y, m - 1 + 24, 1));
  const last = new Date(Date.UTC(limit.getUTCFullYear(), limit.getUTCMonth() + 1, 0)).getUTCDate();
  limit.setUTCDate(Math.min(d, last));
  return to >= limit.toISOString().slice(0, 10) ? 'RANGE_TOO_LONG' : null;
}

export default function FiscalYearList() {
  const tr = useTr();
  const canWrite = useLedgerCan('canConfigureLedger');
  const [edit, setEdit] = useState<GlFiscalYear | 'new' | null>(null);
  const q = useQuery({ queryKey: ledgerKeys.fiscalYears, queryFn: async () => (await ledgerConfigApi.fiscalYears.list()).data.data });
  const settingsQ = useQuery({ queryKey: ledgerKeys.settings, queryFn: async () => (await ledgerConfigApi.settings.get()).data.data, enabled: canWrite, retry: false });
  const rows = q.data ?? [];

  const suggestion = (): { name: string; dateFrom: string; dateTo: string } => {
    const s = settingsQ.data;
    const endMonth = s?.fiscalYearEndMonth ?? 12;
    const endDay = s?.fiscalYearEndDay ?? 31;
    const last = rows[rows.length - 1];
    const from = last ? addDays(last.dateTo, 1) : fiscalYearOf(todayLocal(s?.timezone ?? undefined), endMonth, endDay).from;
    const to = fiscalYearOf(from, endMonth, endDay).to;
    return { name: to.slice(0, 4) === from.slice(0, 4) ? from.slice(0, 4) : `${from.slice(0, 4)}/${to.slice(0, 4)}`, dateFrom: from, dateTo: to };
  };

  return (
    <div className="space-y-3">
      <ConfigHeader title={tr('السنوات المالية')} subtitle={tr('الفترات التي تُقفل عليها الأرباح وتُبنى منها التقارير السنوية')}
        actions={<WriteButton allowed={canWrite} onClick={() => setEdit('new')} className="btn-primary inline-flex items-center gap-1.5"><Plus size={15} />{tr('جديد')}</WriteButton>} />
      {q.isError && <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>}
      <div className="table-wrapper overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="text-start">{tr('الاسم')}</th>
              <th className="text-start">{tr('من')}</th>
              <th className="text-start">{tr('إلى')}</th>
              <th className="text-start">{tr('الحالة')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={4} className="text-center text-[#9A8F7E] py-8">{tr('جاري التحميل...')}</td></tr>}
            {!q.isLoading && rows.length === 0 && <tr><td colSpan={4} className="text-center text-[#9A8F7E] py-8">{tr('لا توجد سنوات مالية بعد')}</td></tr>}
            {rows.map(f => {
              const editable = canWrite && f.state !== 'CLOSED';
              return (
                <tr key={f.id} className={editable ? 'cursor-pointer hover:bg-[#FBF7F0]' : ''} onClick={() => editable && setEdit(f)}>
                  <td className="font-medium">{f.name}</td>
                  <td className="tabular-nums">{formatDayOnly(f.dateFrom)}</td>
                  <td className="tabular-nums">{formatDayOnly(f.dateTo)}</td>
                  <td>
                    {f.state === 'CLOSED'
                      ? <span className="badge badge-inactive inline-flex items-center gap-1"><Lock size={11} />{tr('مقفلة')}</span>
                      : <span className="badge badge-active">{tr('مفتوحة')}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {edit && <FiscalYearDialog year={edit === 'new' ? null : edit} initial={edit === 'new' ? suggestion() : null} onClose={() => setEdit(null)} />}
    </div>
  );
}

function FiscalYearDialog({ year, initial, onClose }: { year: GlFiscalYear | null; initial: { name: string; dateFrom: string; dateTo: string } | null; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const [name, setName] = useState(year?.name ?? initial?.name ?? '');
  const [dateFrom, setDateFrom] = useState(year?.dateFrom ?? initial?.dateFrom ?? '');
  const [dateTo, setDateTo] = useState(year?.dateTo ?? initial?.dateTo ?? '');
  const issue = fiscalYearRangeIssue(dateFrom, dateTo);
  const issueText = !name.trim() ? tr('الاسم مطلوب')
    : issue === 'INVALID_RANGE' ? tr('تاريخ البداية بعد تاريخ النهاية')
      : issue === 'RANGE_TOO_LONG' ? tr('السنة المالية لا تتجاوز 24 شهراً') : null;
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), dateFrom, dateTo };
      return year ? ledgerConfigApi.fiscalYears.update(year.id, body) : ledgerConfigApi.fiscalYears.create(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ledgerKeys.fiscalYears }); toast.success(tr('تم الحفظ')); onClose(); },
    onError: e => toast.error(errorText(e)),
  });
  return (
    <ConfigModal title={year ? tr('تعديل السنة المالية') : tr('سنة مالية جديدة')} onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        <WriteButton allowed onClick={() => save.mutate()} busy={save.isPending} reason={issueText}>{tr('حفظ')}</WriteButton>
      </>}>
      <Field label={tr('الاسم')}><input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={100} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('من')}><input type="date" className="input" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></Field>
        <Field label={tr('إلى')}><input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} /></Field>
      </div>
      <p className="text-[11px] text-[#9A8F7E]">{tr('السنة الأولى قد تكون أقصر أو أطول من اثني عشر شهرا بحد 24 شهراً')}</p>
      {issueText && dateFrom && dateTo && <p className="text-xs text-[#C0392B]">{issueText}</p>}
    </ConfigModal>
  );
}
