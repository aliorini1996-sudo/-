import { useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2, Upload, FileDown, ShieldCheck, ChevronRight, ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { parseExcelFile } from '../../../lib/importData';
import { exportExcel } from '../../../utils/excel';
import LedgerAmount from '../../../components/ledger/LedgerAmount';
import { ledgerSetupApi, type ManualBalanceIssue, type ManualBalanceRowInput } from '../../../api/ledgerSetup';
import { AccountSelect, useAllAccounts } from '../config/parts/configUi';
import {
  cleanManualRows, isBlankRow, MANUAL_BALANCE_MAX_ROWS, manualTotalsMilli, milliText, OPENING_BALANCE_TEMPLATE_COLUMNS, parseOpeningBalanceRecords,
} from './setupLogic';
import { manualIssueLabels, Notice, StepSection, useSetupErrorText } from './setupUi';
import { StepFooter, type StepProps } from './SetupSteps';

/**
 * الخطوة 5 — الأرصدة اليدوية (§5.6): جدول أو استيراد XLSX بقالب (رمز الحساب، مدين، دائن، المورد، تاريخ الاستحقاق)
 * للنقد والبنوك والأصول والموردين والقروض ورأس المال والمستحقات. الأرصدة المشتقة (الذمم والعهدة والأمانات ومخزون
 * المستودع) من الخطوة 4 لا تُدخل هنا، والفرق يذهب مؤقتاً إلى حساب الأرصدة الافتتاحية ويُعاد حسابه عند التفعيل.
 * «تحقق» يستدعي المعاينة بالصفوف دون حفظها ويعرض أسباب الرفض لكل صف.
 */

const PAGE = 50;
const DERIVED_KINDS = new Set(['AR', 'CUSTODY', 'PAYLINK', 'INVENTORY']);

const blank = (): ManualBalanceRowInput => ({ accountCode: '', debit: '', credit: '' });

export default function ManualBalances({ state, canWrite, busy, onSave, onBack }: StepProps) {
  const tr = useTr();
  const errorText = useSetupErrorText();
  const issueLabels = manualIssueLabels(tr);
  const decimals = state.status.currencyDecimals ?? 2;
  const accountsQ = useAllAccounts();
  const accounts = accountsQ.data ?? [];
  const byCode = useMemo(() => new Map(accounts.map(a => [a.code, a])), [accounts]);
  const pickable = useMemo(() => accounts.filter(a => a.type !== 'equity_unaffected' && a.type !== 'off_balance' && !(a.controlKind && DERIVED_KINDS.has(a.controlKind))), [accounts]);

  const [rows, setRows] = useState<ManualBalanceRowInput[]>(() => {
    const saved = state.draft.step5?.rows ?? [];
    return saved.length ? saved.map(r => ({ ...r })) : [blank()];
  });
  const [page, setPage] = useState(0);
  const [issues, setIssues] = useState<Map<number, string> | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const cleaned = useMemo(() => cleanManualRows(rows), [rows]);
  /** فهرس الصف المرسَل ⇒ فهرسه في الجدول (الفارغة لا تُرسل) */
  const sentToRow = useMemo(() => rows.map((r, i) => (isBlankRow(r) ? -1 : i)).filter(i => i >= 0), [rows]);
  const totals = useMemo(() => manualTotalsMilli(cleaned, decimals), [cleaned, decimals]);
  const diff = totals.debit - totals.credit;

  const update = (i: number, patch: Partial<ManualBalanceRowInput>) => {
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setIssues(null);
  };

  const validate = useMutation({
    mutationFn: async () => (await ledgerSetupApi.previewOpening({ step5: { rows: cleaned } })).data.data,
    onSuccess: d => {
      const m = new Map<number, string>();
      for (const is of d.manual.issues as ManualBalanceIssue[]) {
        const rowIdx = sentToRow[is.index];
        if (rowIdx !== undefined && !m.has(rowIdx)) m.set(rowIdx, issueLabels[is.reason] ?? is.reason);
      }
      setIssues(m);
      if (m.size === 0) toast.success(tr('الصفوف صالحة'));
      else {
        toast.error(`${tr('صفوف غير صالحة')}: ${m.size}`);
        const first = Math.min(...m.keys());
        setPage(Math.floor(first / PAGE));
      }
    },
    onError: e => toast.error(errorText(e)),
  });

  const onFile = async (file: File) => {
    setReading(true);
    try {
      const res = parseOpeningBalanceRecords(await parseExcelFile(file));
      if (res.missingColumns.length) { toast.error(tr('أعمدة ناقصة في الملف')); return; }
      if (!res.rows.length) { toast.error(tr('لا صفوف صالحة للاستيراد')); return; }
      if (res.tooMany) toast.error(`${tr('يتجاوز الحد الأقصى للصفوف')}: ${MANUAL_BALANCE_MAX_ROWS}`);
      const existing = rows.filter(r => !isBlankRow(r)).length;
      if (existing > 0 && !window.confirm(tr('استبدال الصفوف الحالية بصفوف الملف؟'))) return;
      setRows(res.rows);
      setFileName(file.name);
      setIssues(null);
      setPage(0);
      toast.success(`${tr('تمت قراءة الملف')}: ${res.rows.length}`);
    } catch {
      toast.error(tr('تعذر قراءة الملف'));
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadTemplate = () => exportExcel([{
    name: tr('الأرصدة الافتتاحية'),
    rows: [
      Object.fromEntries(OPENING_BALANCE_TEMPLATE_COLUMNS.map(c => [c, ({ accountCode: '111001', debit: '25000', credit: '', vendorName: '', dueDate: '' } as Record<string, string>)[c]])),
      Object.fromEntries(OPENING_BALANCE_TEMPLATE_COLUMNS.map(c => [c, ({ accountCode: '211001', debit: '', credit: '12000', vendorName: 'مؤسسة المورد', dueDate: '2026-12-31' } as Record<string, string>)[c]])),
    ],
    colWidths: [14, 14, 14, 30, 14],
  }], 'opening-balances-template');

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const visible = rows.slice(page * PAGE, (page + 1) * PAGE);
  const ro = !canWrite;
  const tooMany = cleaned.length > MANUAL_BALANCE_MAX_ROWS;
  const disabledReason = tooMany ? `${tr('يتجاوز الحد الأقصى للصفوف')}: ${MANUAL_BALANCE_MAX_ROWS}`
    : totals.invalid ? tr('مبلغ غير صالح') : null;

  return (
    <div className="space-y-4">
      <Notice>
        {tr('أدخل هنا النقد والبنوك والأصول ومجمعاتها والموردين والقروض ورأس المال والمستحقات. ذمم العملاء وعهدة المناديب وأمانات الدفع الإلكتروني ومخزون المستودع تُحسب من المستندات في الخطوة السابقة')}
        {' '}{tr('بضاعة السيارات تُدخل هنا يدويا')}.
      </Notice>

      <StepSection title={tr('الأرصدة اليدوية')}
        hint={tr('سطر واحد لكل رصيد: مدين أو دائن. اسم المورد إلزامي لسطور الموردين، وتاريخ الاستحقاق اختياري')}
        actions={(
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs" onClick={() => void downloadTemplate()}><FileDown size={14} />{tr('تنزيل نموذج')}</button>
            <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs disabled:opacity-50" disabled={ro || reading} onClick={() => fileRef.current?.click()}>
              <Upload size={14} />{reading ? tr('جاري القراءة...') : tr('استيراد XLSX')}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
          </div>
        )}>
        {fileName && <p className="text-[11px] text-[#9A8F7E]">{tr('الملف')}: <bdi>{fileName}</bdi></p>}
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm min-w-[52rem]">
            <thead>
              <tr className="text-xs text-[#9A8F7E]">
                <th className="text-start font-medium py-1 px-1 w-8">#</th>
                <th className="text-start font-medium py-1 px-1">{tr('الحساب')}</th>
                <th className="text-start font-medium py-1 px-1 w-32">{tr('مدين')}</th>
                <th className="text-start font-medium py-1 px-1 w-32">{tr('دائن')}</th>
                <th className="text-start font-medium py-1 px-1 w-44">{tr('المورد')}</th>
                <th className="text-start font-medium py-1 px-1 w-36">{tr('تاريخ الاستحقاق')}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {visible.map((r, k) => {
                const i = page * PAGE + k;
                const acc = byCode.get(String(r.accountCode ?? '').trim());
                const isAp = acc?.controlKind === 'AP';
                const issue = issues?.get(i);
                return (
                  <tr key={i} className={`align-top ${issue ? 'bg-red-50/60' : ''}`}>
                    <td className="py-1 px-1 text-[11px] text-[#9A8F7E] tabular-nums pt-3">{i + 1}</td>
                    <td className="py-1 px-1">
                      {accounts.length > 0 ? (
                        <AccountSelect accounts={pickable} value={acc?.id ?? null} disabled={ro} invalid={!!issue}
                          placeholder={r.accountCode ? String(r.accountCode) : tr('اختر حساباً')}
                          onChange={id => update(i, { accountCode: accounts.find(a => a.id === id)?.code ?? '' })} />
                      ) : (
                        <input className={`input tabular-nums ${issue ? '!border-[#C0392B]' : ''}`} dir="ltr" placeholder={tr('رمز الحساب')} value={String(r.accountCode ?? '')} disabled={ro}
                          onChange={e => update(i, { accountCode: e.target.value })} />
                      )}
                      {issue && <p className="text-[11px] text-[#8E2A1F] mt-0.5">{issue}</p>}
                    </td>
                    <td className="py-1 px-1">
                      <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={String(r.debit ?? '')} disabled={ro}
                        onChange={e => update(i, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })} />
                    </td>
                    <td className="py-1 px-1">
                      <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={String(r.credit ?? '')} disabled={ro}
                        onChange={e => update(i, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} />
                    </td>
                    <td className="py-1 px-1">
                      <input className={`input ${isAp && !String(r.vendorName ?? '').trim() && !r.vendorId ? '!border-amber-400' : ''}`} value={String(r.vendorName ?? '')}
                        disabled={ro || (!!acc && !isAp)} placeholder={isAp ? tr('إلزامي') : ''} maxLength={200}
                        onChange={e => update(i, { vendorName: e.target.value })} />
                    </td>
                    <td className="py-1 px-1">
                      <input type="date" className="input" value={r.dueDate ?? ''} disabled={ro || (!!acc && !isAp)}
                        onChange={e => update(i, { dueDate: e.target.value || null })} />
                    </td>
                    <td className="py-1 px-1 pt-2">
                      <button type="button" className="p-1.5 rounded-lg hover:bg-red-50 text-[#9A8F7E] hover:text-[#C0392B] disabled:opacity-40" disabled={ro}
                        aria-label={tr('حذف السطر')} onClick={() => { setRows(rs => { const n = rs.filter((_, j) => j !== i); return n.length ? n : [blank()]; }); setIssues(null); }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5 text-xs disabled:opacity-50" disabled={ro || rows.length >= MANUAL_BALANCE_MAX_ROWS}
            onClick={() => { setRows(rs => [...rs, blank()]); setPage(Math.floor(rows.length / PAGE)); }}>
            <Plus size={14} />{tr('إضافة سطر')}
          </button>
          <span className="flex-1" />
          {pages > 1 && (
            <div className="flex items-center gap-1 text-xs">
              <button type="button" className="p-1 rounded hover:bg-[#F1EBDF] disabled:opacity-40" disabled={page === 0} onClick={() => setPage(p => p - 1)} aria-label={tr('السابق')}><ChevronRight size={14} className="ltr:rotate-180" /></button>
              <bdi className="tabular-nums">{page + 1} / {pages}</bdi>
              <button type="button" className="p-1 rounded hover:bg-[#F1EBDF] disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)} aria-label={tr('التالي')}><ChevronLeft size={14} className="ltr:rotate-180" /></button>
            </div>
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-3 rounded-xl bg-[#FBF7F0] p-3 text-sm">
          <div><p className="text-[11px] text-[#9A8F7E]">{tr('إجمالي المدين')}</p><LedgerAmount value={milliText(totals.debit)} decimals={decimals} className="font-semibold" /></div>
          <div><p className="text-[11px] text-[#9A8F7E]">{tr('إجمالي الدائن')}</p><LedgerAmount value={milliText(totals.credit)} decimals={decimals} className="font-semibold" /></div>
          <div>
            <p className="text-[11px] text-[#9A8F7E]">{tr('الفرق إلى حساب الأرصدة الافتتاحية (مؤقت)')}</p>
            <LedgerAmount value={milliText(diff)} decimals={decimals} className="font-semibold" />
          </div>
        </div>
        <p className="text-[11px] text-[#9A8F7E]">{tr('الفرق النهائي يشمل الأرصدة المشتقة ويُعاد حسابه داخل معاملة التفعيل')}</p>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5 disabled:opacity-50" disabled={validate.isPending || cleaned.length === 0}
            onClick={() => validate.mutate()}>
            <ShieldCheck size={14} />{validate.isPending ? tr('جاري التحقق...') : tr('تحقق من الصفوف')}
          </button>
          {issues && issues.size === 0 && <span className="text-xs text-emerald-700">{tr('الصفوف صالحة')}</span>}
          {issues && issues.size > 0 && <span className="text-xs text-[#8E2A1F]">{tr('صفوف غير صالحة')}: <bdi className="tabular-nums">{issues.size}</bdi></span>}
        </div>
      </StepSection>

      <StepFooter onBack={onBack} onNext={() => onSave({ step5: { rows: cleaned } }, 6)} busy={busy} disabledReason={disabledReason} canWrite={canWrite} />
    </div>
  );
}
