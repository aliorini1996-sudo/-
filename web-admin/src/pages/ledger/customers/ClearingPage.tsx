import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Info, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { formatDayOnly } from '../../../utils/format';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { LedgerLoadingToast } from '../../../components/ledger/LedgerListView';
import { todayLocal } from '../../../components/ledger/DateRangePicker';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys } from '../../../api/ledgerConfig';
import { CLEARING_KINDS, ledgerOpsApi, ledgerOpsKeys, type ClearingKind, type ClearingResult } from '../../../api/ledgerOps';
import { clearingKindLabels, clearingReasonLabels } from '../../../lib/ledger/labels';
import {
  clearingDraftCheck, clearingRequestBody, milliWire, opsErrorMessage, selectedResidualMilli, type ClearingDraftInput,
} from '../../../lib/ledger/sync';
import { WriteButton, useLedgerCan } from '../config/parts/configUi';
import { ledgerHref } from '../routes';

/**
 * «العملاء ← تسوية الحسابات الوسيطة» (L5 من «ربط الدفاتر»، العقد §5.2، C3/C5، E5.14).
 *
 * حين يصل مال نقاط البيع أو البطاقة أو الشيكات أو المقبوضات قيد الإيداع إلى البنك: يُختار النوع، وتظهر السطور المدينة المفتوحة
 * على حسابه الوسيط (112004 / 112007 / 112003 / 112001 أو حساب الطريقة في الخريطة)، ثم الإجمالي والعمولة وضريبتها والحساب
 * المستلِم، فمعاينة القيد (مدين البنك بالصافي + العمولة + ضريبتها / دائن الوسيط بالإجمالي — متّزن بالبناء)، ثم الترحيل:
 * قيد يدوي في دفتر البنك ومطابقة جزئية CLR:<moveId> بين السطور المختارة (أو الأقدم فالأقدم) وسطر الدائن، في معاملة واحدة.
 * التحقق في الواجهة مرآة الخادم (clearingDraftCheck) — والخادم يحسم الحسابات والضريبة (422 LEDGER_CLEARING_INVALID).
 */

const emptyDraft = (date: string): ClearingDraftInput => ({ date, bankAccountId: '', gross: '', fee: '', feeVat: '', selected: [] });

export default function ClearingPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const canPost = useLedgerCan('canPostJournals');
  const [kind, setKind] = useState<ClearingKind>('POS_SETTLEMENT');
  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const today = todayLocal(statusQ.data?.timezone || 'Asia/Riyadh');
  const [draft, setDraft] = useState<ClearingDraftInput>(() => emptyDraft(today));
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [last, setLast] = useState<ClearingResult | null>(null);

  const q = useQuery({
    queryKey: ledgerOpsKeys.clearingOpen(kind),
    queryFn: async () => (await ledgerOpsApi.clearing.open(kind)).data.data,
    retry: false,
  });
  const d = q.data;
  const decimals = d?.decimals ?? 2;
  const kindLabels = clearingKindLabels(tr);
  const reasonLabels = clearingReasonLabels(tr);

  // تبديل النوع يبدأ مستنداً جديداً (السطور والحساب الوسيط يتغيّران). الحساب المستلِم يُختار صراحةً — صندوقٌ أو بنكٌ خطأً
  // يقيّد المال في غير مكانه — إلا حين لا مرشّح غيره
  useEffect(() => { setDraft(emptyDraft(today)); setRef(''); setNote(''); }, [kind, today]);
  useEffect(() => {
    if (d && !draft.bankAccountId && d.bankAccounts.length === 1) setDraft(s => ({ ...s, bankAccountId: d.bankAccounts[0].id }));
  }, [d, draft.bankAccountId]);

  const check = useMemo(
    () => clearingDraftCheck(draft, { decimals, lines: d?.lines ?? [], openTotal: d?.total ?? 0, balance: d?.balance ?? 0 }),
    [draft, decimals, d],
  );
  const selectedMilli = useMemo(() => selectedResidualMilli(d?.lines ?? [], draft.selected), [d, draft.selected]);
  const set = (p: Partial<ClearingDraftInput>) => setDraft(s => ({ ...s, ...p }));
  const toggle = (lineId: string) => set({ selected: draft.selected.includes(lineId) ? draft.selected.filter(x => x !== lineId) : [...draft.selected, lineId] });
  const allSelected = !!d && d.lines.length > 0 && d.lines.every(l => draft.selected.includes(l.lineId));

  const post = useMutation({
    mutationFn: async () => {
      const body = clearingRequestBody(kind, draft, check, { ref, note });
      if (!body) throw new Error('INVALID_DRAFT');
      return (await ledgerOpsApi.clearing.post(body)).data.data;
    },
    onSuccess: r => {
      setLast(r);
      toast.success(`${tr('رُحّل قيد التسوية')} ${r.moveNumber}`);
      qc.invalidateQueries({ queryKey: ['ledger', 'clearing'] });
      setDraft(emptyDraft(today));
      setRef('');
      setNote('');
    },
    onError: e => toast.error(opsErrorMessage(tr, ledgerErrorOf(e), reasonLabels)),
  });

  const bank = d?.bankAccounts.find(b => b.id === draft.bankAccountId) ?? null;
  const roleLabel = (role: 'BANK' | 'FEE' | 'FEE_VAT' | 'CLEARING'): string => {
    switch (role) {
      case 'BANK': return bank ? `${bank.code} ${bank.name}` : tr('الحساب المستلِم');
      case 'FEE': return tr('عمولة البنك قبل الضريبة');
      case 'FEE_VAT': return tr('ضريبة القيمة المضافة على العمولة');
      default: return d ? `${d.account.code} ${d.account.name}` : tr('الحساب الوسيط');
    }
  };
  const fieldProblems = (field: string) => check.problems.filter(p => p.field === field).map(p => reasonLabels[p.reason] ?? p.reason);
  const fieldError = (field: string) => {
    const msgs = fieldProblems(field);
    return msgs.length ? <span className="block text-[11px] text-[#C0392B] mt-1">{msgs.join(' · ')}</span> : null;
  };
  const amountsTouched = draft.gross.trim() !== '';

  return (
    <div className="space-y-3">
      <LedgerLoadingToast show={q.isFetching || post.isPending} />
      <h1 className="text-lg font-bold text-[#1F1A13]">{tr('تسوية الحسابات الوسيطة')}</h1>
      <p className="text-xs text-[#6E6557] flex items-start gap-1">
        <Info size={13} className="shrink-0 mt-0.5" />
        {tr('حين يصل المال إلى البنك: اختر السطور التي وصل مقابلها، وأدخل الإجمالي والعمولة وضريبتها كما في كشف البنك. يُرحَّل قيد في دفتر البنك وتُطابَق السطور المختارة، وبلا اختيار يُصفّى الأقدم فالأقدم')}
      </p>

      <div className="flex gap-1 border-b border-[#E8E0D2] overflow-x-auto" role="tablist">
        {CLEARING_KINDS.map(k => (
          <button key={k} type="button" role="tab" aria-selected={kind === k}
            className={`px-3 py-1.5 text-sm -mb-px border-b-2 whitespace-nowrap ${kind === k ? 'border-[#E15A30] text-[#E15A30] font-semibold' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'}`}
            onClick={() => { setKind(k); setLast(null); }}>
            {kindLabels[k]}
          </button>
        ))}
      </div>

      {q.isError && <p className="card text-sm text-[#8E2A1F]">{opsErrorMessage(tr, ledgerErrorOf(q.error), reasonLabels)}</p>}
      {q.isLoading && <p className="text-sm text-[#9A8F7E] py-6 text-center">{tr('جاري التحميل...')}</p>}

      {last && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 flex flex-wrap items-center gap-2" role="status">
          <span>{tr('رُحّل قيد التسوية')}</span>
          <Link to={ledgerHref(`entries/${last.moveId}`)} className="font-semibold text-[#E15A30] hover:underline"><bdi>{last.moveNumber}</bdi></Link>
          <span>· {tr('المطابَق')}: <LedgerAmount value={last.matchedTotal} decimals={decimals} /></span>
        </div>
      )}

      {d && (
        <>
          <div className="card grid gap-3 sm:grid-cols-4 text-sm">
            <div>
              <p className="text-xs text-[#9A8F7E]">{tr('الحساب الوسيط')}</p>
              <p className="font-semibold truncate"><bdi className="tabular-nums text-[#6E6557]">{d.account.code}</bdi> {d.account.name}</p>
            </div>
            <div><p className="text-xs text-[#9A8F7E]">{tr('رصيد الحساب')}</p><p className="text-lg font-bold"><LedgerAmount value={d.balance} decimals={decimals} /></p></div>
            <div><p className="text-xs text-[#9A8F7E]">{tr('المفتوح للتسوية')}</p><p className="text-lg font-bold"><LedgerAmount value={d.total} decimals={decimals} /></p></div>
            <div><p className="text-xs text-[#9A8F7E]">{tr('السطور المفتوحة')}</p><p className="text-lg font-bold tabular-nums">{d.count}</p></div>
          </div>
          {d.truncated && (
            <p className="text-xs text-amber-900 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 flex items-start gap-1">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />{tr('تُعرض أقدم السطور المفتوحة وحدها: الإجمالي بلا اختيار يُصفّي الأقدم فالأقدم من كل المفتوح')}
            </p>
          )}

          <div className="card !p-0 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-[#9A8F7E]">
                <tr className="border-b border-[#F1EBDF]">
                  <th className="w-8 px-2 py-2">
                    <input type="checkbox" aria-label={tr('تحديد الكل')} checked={allSelected} disabled={d.lines.length === 0}
                      onChange={() => set({ selected: allSelected ? [] : d.lines.map(l => l.lineId) })} />
                  </th>
                  <th className="text-start px-2 py-2">{tr('التاريخ')}</th>
                  <th className="text-start px-2 py-2">{tr('القيد')}</th>
                  <th className="text-start px-2 py-2">{tr('البيان')}</th>
                  <th className="text-end px-2 py-2">{tr('المبلغ')}</th>
                  <th className="text-end px-2 py-2">{tr('المتبقّي')}</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-[#6E6557]">{tr('لا سطور مفتوحة على الحساب الوسيط لهذا النوع')}</td></tr>}
                {d.lines.map(l => (
                  <tr key={l.lineId} className={`border-b border-[#F1EBDF] ${draft.selected.includes(l.lineId) ? 'bg-[#FBEBE2]/40' : ''}`}>
                    <td className="px-2"><input type="checkbox" aria-label={l.moveNumber ?? l.lineId} checked={draft.selected.includes(l.lineId)} onChange={() => toggle(l.lineId)} /></td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatDayOnly(l.date)}</td>
                    <td className="px-2"><Link to={ledgerHref(`entries/${l.moveId}`)} className="text-[#E15A30] hover:underline"><bdi>{l.moveNumber ?? l.moveId.slice(0, 8)}</bdi></Link></td>
                    <td className="px-2 max-w-[22rem] truncate" title={l.label ?? ''}>{l.label ?? ''}</td>
                    <td className="text-end px-2"><LedgerAmount value={l.amount} decimals={decimals} /></td>
                    <td className="text-end px-2 font-semibold"><LedgerAmount value={l.residual} decimals={decimals} /></td>
                  </tr>
                ))}
              </tbody>
              {draft.selected.length > 0 && (
                <tfoot className="font-semibold border-t border-[#E8E0D2]">
                  <tr>
                    <td />
                    <td className="px-2 py-2" colSpan={4}>{tr('مجموع المختار')} (<bdi className="tabular-nums">{draft.selected.length}</bdi>)</td>
                    <td className="text-end px-2"><LedgerAmount value={milliWire(selectedMilli)} decimals={decimals} /></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div className="card space-y-3">
            <h2 className="text-sm font-bold text-[#1F1A13]">{tr('مستند التسوية')}</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block">
                <span className="label">{tr('التاريخ')}</span>
                <input type="date" dir="ltr" className="input" max={today} value={draft.date} onChange={e => set({ date: e.target.value })} />
                {fieldError('date')}
              </label>
              <label className="block sm:col-span-2">
                <span className="label">{tr('الحساب المستلِم')}</span>
                <select className="input w-full" value={draft.bankAccountId} onChange={e => set({ bankAccountId: e.target.value })}>
                  <option value="">{tr('اختر الحساب المستلِم')}</option>
                  {d.bankAccounts.map(b => <option key={b.id} value={b.id}>{b.code} · {b.name}</option>)}
                </select>
                {amountsTouched && fieldError('bankAccountId')}
              </label>
              <label className="block">
                <span className="label">{tr('الإجمالي')}</span>
                <div className="flex gap-1.5">
                  <input dir="ltr" inputMode="decimal" className="input" value={draft.gross} onChange={e => set({ gross: e.target.value })} />
                  {draft.selected.length > 0 && (
                    <button type="button" className="btn-secondary !py-1 !px-2 text-xs whitespace-nowrap" onClick={() => set({ gross: milliWire(selectedMilli) })}>{tr('= المختار')}</button>
                  )}
                </div>
                {amountsTouched && fieldError('gross')}
              </label>
              <label className="block">
                <span className="label">{tr('عمولة البنك قبل الضريبة')}</span>
                <input dir="ltr" inputMode="decimal" className="input" value={draft.fee} onChange={e => set({ fee: e.target.value })} />
                {fieldError('fee')}
              </label>
              <label className="block">
                <span className="label">{tr('ضريبة العمولة')}</span>
                <input dir="ltr" inputMode="decimal" className="input" value={draft.feeVat} onChange={e => set({ feeVat: e.target.value })} />
                {fieldError('feeVat')}
              </label>
              <label className="block">
                <span className="label">{tr('المرجع')}</span>
                <input className="input" maxLength={200} value={ref} onChange={e => setRef(e.target.value)} />
              </label>
              <label className="block sm:col-span-2">
                <span className="label">{tr('ملاحظة')}</span>
                <input className="input" maxLength={1000} value={note} onChange={e => setNote(e.target.value)} />
              </label>
            </div>
            {amountsTouched && fieldProblems('lines').length > 0 && <p className="text-xs text-[#C0392B]">{fieldProblems('lines').join(' · ')}</p>}

            {check.preview.length > 0 && (
              <div className="overflow-x-auto">
                <p className="text-xs font-semibold text-[#1F1A13] mb-1">{tr('معاينة القيد')}</p>
                <table className="w-full text-xs">
                  <thead className="text-[#9A8F7E]">
                    <tr>
                      <th className="text-start px-2 py-1">{tr('الحساب')}</th>
                      <th className="text-end px-2 py-1">{tr('مدين')}</th>
                      <th className="text-end px-2 py-1">{tr('دائن')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.preview.map(l => (
                      <tr key={l.role} className="border-t border-[#F1EBDF]">
                        <td className="px-2 py-1">{roleLabel(l.role)}</td>
                        <td className="text-end px-2"><LedgerAmount value={milliWire(l.debitMilli)} decimals={decimals} blankZero /></td>
                        <td className="text-end px-2"><LedgerAmount value={milliWire(l.creditMilli)} decimals={decimals} blankZero /></td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="font-semibold border-t border-[#E8E0D2]">
                    <tr>
                      <td className="px-2 py-1">{tr('الإجمالي')}</td>
                      <td className="text-end px-2"><LedgerAmount value={milliWire(check.preview.reduce((s, l) => s + l.debitMilli, 0n))} decimals={decimals} /></td>
                      <td className="text-end px-2"><LedgerAmount value={milliWire(check.preview.reduce((s, l) => s + l.creditMilli, 0n))} decimals={decimals} /></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <div className="flex justify-end">
              <WriteButton allowed={canPost} busy={post.isPending} disabled={check.problems.length > 0}
                reason={check.problems.length > 0 && amountsTouched ? (reasonLabels[check.problems[0].reason] ?? check.problems[0].reason) : null}
                className="btn-primary inline-flex items-center gap-1.5" onClick={() => post.mutate()}>
                <Send size={14} />{tr('ترحيل التسوية')}
              </WriteButton>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
