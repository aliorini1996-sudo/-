import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Lock, LayoutDashboard } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { journalTypeLabels } from '../../../lib/ledger/labels';
import {
  ledgerConfigApi, ledgerKeys, isLedgerAccessError, type GlJournal, type GlJournalInput, type JournalType, type SequenceReset,
} from '../../../api/ledgerConfig';
import {
  AccountSelect, ConfigHeader, ConfigModal, Field, StatusBadge, Toggle, WriteButton, hasArabicLetter,
  useAllAccounts, useConfigErrorText, useLedgerCan,
} from './parts/configUi';

/**
 * دفاتر اليومية (JRN‑01…04، §4.3): الرمز والنوع والحساب الافتراضي والمعلّق ونمط الترقيم والظهور في اللوحة واللون.
 * بعد أول ترحيل يُقفل الرمز ونمط الترقيم (G2)، ودفتر النظام لا يتغير نوعه ولا يُؤرشف.
 */

const TYPES: JournalType[] = ['SALE', 'PURCHASE', 'CASH', 'BANK', 'GENERAL'];
/** لوحة الألوان 0..11 (نمط Odoo) */
const JOURNAL_COLORS = ['#9A8F7E', '#E15A30', '#D4A017', '#2E86AB', '#6C5B7B', '#C0392B', '#3C8D5A', '#1F1A13', '#E67E22', '#8E44AD', '#16A085', '#B03A68'];
const JOURNAL_CODE_RE = /^[A-Z][A-Z0-9]{0,5}$/;

/** معاينة الترقيم (JRN‑02): شهري CODE/YYYY/MM/0001، سنوي CODE/YYYY/00001. */
function numberingPreview(code: string, reset: SequenceReset): string {
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const c = code || 'CODE';
  return reset === 'MONTHLY' ? `${c}/${y}/${m}/0001` : `${c}/${y}/00001`;
}

export default function JournalList() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const canWrite = useLedgerCan('canConfigureLedger');
  const [edit, setEdit] = useState<GlJournal | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const q = useQuery({ queryKey: ledgerKeys.journals, queryFn: async () => (await ledgerConfigApi.journals.list()).data.data });
  const accountsQ = useAllAccounts();
  const accountById = useMemo(() => new Map((accountsQ.data ?? []).map(a => [a.id, a])), [accountsQ.data]);
  const types = journalTypeLabels(tr);
  const rows = (q.data ?? []).filter(j => showArchived || j.isActive);

  return (
    <div className="space-y-3">
      <ConfigHeader title={tr('دفاتر اليومية')} subtitle={tr('لكل دفتر تسلسل مستقل يُمنح رقمه عند الترحيل')}
        actions={<WriteButton allowed={canWrite} onClick={() => setEdit('new')} className="btn-primary inline-flex items-center gap-1.5"><Plus size={15} />{tr('جديد')}</WriteButton>} />
      <label className="inline-flex items-center gap-1.5 text-xs text-[#6E6557]">
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{tr('إظهار المؤرشف')}
      </label>
      {q.isError && <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>}
      <div className="table-wrapper overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="text-start">{tr('الرمز')}</th>
              <th className="text-start">{tr('الاسم')}</th>
              <th className="text-start">{tr('النوع')}</th>
              <th className="text-start">{tr('الحساب الافتراضي')}</th>
              <th className="text-start">{tr('الترقيم')}</th>
              <th className="text-start">{tr('الحالة')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={6} className="text-center text-[#9A8F7E] py-8">{tr('جاري التحميل...')}</td></tr>}
            {!q.isLoading && rows.length === 0 && <tr><td colSpan={6} className="text-center text-[#9A8F7E] py-8">{tr('لا توجد بيانات')}</td></tr>}
            {rows.map(j => {
              const acc = j.defaultAccountId ? accountById.get(j.defaultAccountId) : null;
              return (
                <tr key={j.id} className={canWrite ? 'cursor-pointer hover:bg-[#FBF7F0]' : ''} onClick={() => canWrite && setEdit(j)}>
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: JOURNAL_COLORS[j.color] ?? JOURNAL_COLORS[0] }} />
                      <bdi dir="ltr" className="font-mono text-sm">{j.code}</bdi>
                      {j.hasPostedMoves && <span title={tr('الرمز ونمط الترقيم مقفلان بعد أول ترحيل')}><Lock size={11} className="text-[#9A8F7E]" /></span>}
                    </span>
                  </td>
                  <td className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {ledgerName(j, lang)}
                      {j.showOnDashboard && <span title={tr('يظهر في لوحة البيانات')}><LayoutDashboard size={12} className="text-[#9A8F7E]" /></span>}
                    </span>
                    {j.isSystem && <span className="block text-[11px] text-[#9A8F7E]">{tr('دفتر النظام')}</span>}
                  </td>
                  <td>{types[j.type]}</td>
                  <td>{acc ? <span><bdi className="tabular-nums text-[#6E6557]">{acc.code}</bdi> {ledgerName(acc, lang)}</span> : <span className="text-[#9A8F7E]">—</span>}</td>
                  <td><bdi dir="ltr" className="font-mono text-xs text-[#6E6557]">{numberingPreview(j.code, j.sequenceReset)}</bdi></td>
                  <td><StatusBadge active={j.isActive} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {edit && <JournalDialog journal={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function JournalDialog({ journal, onClose }: { journal: GlJournal | null; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const accountsQ = useAllAccounts();
  const accounts = accountsQ.data ?? [];
  const types = journalTypeLabels(tr);
  const [f, setF] = useState({
    code: journal?.code ?? '',
    name: journal?.name ?? '',
    nameEn: journal?.nameEn ?? '',
    type: journal?.type ?? ('GENERAL' as JournalType),
    defaultAccountId: journal?.defaultAccountId ?? null as string | null,
    suspenseAccountId: journal?.suspenseAccountId ?? null as string | null,
    useOutstandingAccounts: journal?.useOutstandingAccounts ?? false,
    sequenceReset: journal?.sequenceReset ?? ('YEARLY' as SequenceReset),
    showOnDashboard: journal?.showOnDashboard ?? true,
    color: journal?.color ?? 0,
    bankName: journal?.bankName ?? '',
    iban: '',
    isActive: journal?.isActive ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(s => ({ ...s, [k]: v }));
  const numberingLocked = !!journal?.hasPostedMoves;
  const isBankish = f.type === 'BANK' || f.type === 'CASH';
  const code = f.code.trim().toUpperCase();
  const ibanClean = f.iban.replace(/\s+/g, '').toUpperCase();

  const issue = !JOURNAL_CODE_RE.test(code) ? tr('رمز الدفتر حتى 6 أحرف لاتينية أو أرقام ويبدأ بحرف')
    : !f.name.trim() ? tr('الاسم مطلوب')
      : !hasArabicLetter(f.name) ? tr('الاسم يجب أن يحوي حرفاً عربياً والاسم بلغة أخرى مكانه الاسم الإنجليزي')
        : ibanClean && !/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(ibanClean) ? tr('رقم الآيبان غير صالح')
          : null;

  const save = useMutation({
    mutationFn: () => {
      const body: GlJournalInput = {
        name: f.name.trim(), nameEn: f.nameEn.trim() || null, defaultAccountId: f.defaultAccountId,
        showOnDashboard: f.showOnDashboard, color: f.color,
      };
      if (!journal?.isSystem) body.type = f.type;
      if (!numberingLocked) { body.code = code; body.sequenceReset = f.sequenceReset; }
      if (isBankish) {
        body.suspenseAccountId = f.suspenseAccountId;
        body.bankName = f.type === 'BANK' ? (f.bankName.trim() || null) : null;
        if (f.type === 'BANK') body.useOutstandingAccounts = f.useOutstandingAccounts;
        if (f.type === 'BANK' && ibanClean) body.iban = ibanClean;
      }
      if (journal && !journal.isSystem) body.isActive = f.isActive;
      return journal ? ledgerConfigApi.journals.update(journal.id, body) : ledgerConfigApi.journals.create(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ledgerKeys.journals }); toast.success(tr('تم الحفظ')); onClose(); },
    onError: e => toast.error(errorText(e)),
  });

  return (
    <ConfigModal wide title={journal ? tr('تعديل الدفتر') : tr('دفتر جديد')} onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        <WriteButton allowed onClick={() => save.mutate()} busy={save.isPending} reason={issue}>{tr('حفظ')}</WriteButton>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('الاسم')}><input className="input" value={f.name} onChange={e => set('name', e.target.value)} maxLength={200} /></Field>
        <Field label={tr('الاسم الإنجليزي')}><input className="input" dir="ltr" value={f.nameEn} onChange={e => set('nameEn', e.target.value)} maxLength={200} /></Field>
        <Field label={tr('الرمز')} hint={numberingLocked ? tr('الرمز ونمط الترقيم مقفلان بعد أول ترحيل') : tr('حتى 6 أحرف، ويبدأ به رقم كل قيد')}>
          <input className="input font-mono uppercase" dir="ltr" maxLength={6} value={f.code} disabled={numberingLocked} onChange={e => set('code', e.target.value.toUpperCase())} />
        </Field>
        <Field label={tr('النوع')} hint={journal?.isSystem ? tr('نوع دفتر النظام ثابت') : undefined}>
          <select className="input" value={f.type} disabled={!!journal?.isSystem} onChange={e => set('type', e.target.value as JournalType)}>
            {TYPES.map(t => <option key={t} value={t}>{types[t]}</option>)}
          </select>
        </Field>
        <Field label={tr('نمط الترقيم')} hint={<bdi dir="ltr" className="font-mono">{numberingPreview(code, f.sequenceReset)}</bdi>}>
          <select className="input" value={f.sequenceReset} disabled={numberingLocked} onChange={e => set('sequenceReset', e.target.value as SequenceReset)}>
            <option value="MONTHLY">{tr('شهري')}</option>
            <option value="YEARLY">{tr('سنوي')}</option>
          </select>
        </Field>
        <Field label={tr('الحساب الافتراضي')}>
          <AccountSelect accounts={accounts} value={f.defaultAccountId} onChange={id => set('defaultAccountId', id)} allowEmpty
            types={f.type === 'BANK' || f.type === 'CASH' ? ['asset_cash', 'liability_credit_card'] : undefined} />
        </Field>
        {isBankish && (
          <Field label={tr('الحساب المعلّق')} hint={tr('تُسجل فيه حركات الكشف قبل مطابقتها')}>
            <AccountSelect accounts={accounts} value={f.suspenseAccountId} onChange={id => set('suspenseAccountId', id)} allowEmpty />
          </Field>
        )}
        {f.type === 'BANK' && (
          <>
            <Field label={tr('اسم البنك')}><input className="input" value={f.bankName} onChange={e => set('bankName', e.target.value)} maxLength={120} /></Field>
            <Field label={tr('رقم الآيبان')} hint={journal?.ibanMasked ? <>{tr('المحفوظ')}: <bdi dir="ltr" className="font-mono">{journal.ibanMasked}</bdi> · {tr('يُحفظ مقنعا ولا يُعرض كاملا')}</> : tr('يُحفظ مقنعا ولا يُعرض كاملا')}>
              <input className="input font-mono" dir="ltr" value={f.iban} onChange={e => set('iban', e.target.value)} placeholder="SA00 0000 0000 0000 0000 0000" />
            </Field>
          </>
        )}
      </div>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <Toggle label={tr('يظهر في لوحة البيانات')} checked={f.showOnDashboard} onChange={v => set('showOnDashboard', v)} />
        {f.type === 'BANK' && (
          <Toggle label={tr('استعمال حسابات المقبوضات والمدفوعات قيد التسوية')} hint={tr('لا يُرحَّل على حساب البنك إلا سطر الكشف والمطابقة')}
            checked={f.useOutstandingAccounts} onChange={v => set('useOutstandingAccounts', v)} />
        )}
        {journal && (
          <Toggle label={tr('نشط')} checked={f.isActive} disabled={journal.isSystem} title={journal.isSystem ? tr('لا يُؤرشف دفتر النظام') : undefined} onChange={v => set('isActive', v)} />
        )}
      </div>
      <div>
        <span className="label">{tr('اللون')}</span>
        <div className="flex flex-wrap gap-1.5">
          {JOURNAL_COLORS.map((c, i) => (
            <button key={c} type="button" aria-label={`${tr('اللون')} ${i}`} aria-pressed={f.color === i} onClick={() => set('color', i)}
              className={`w-6 h-6 rounded-full border-2 ${f.color === i ? 'border-[#1F1A13]' : 'border-transparent'}`} style={{ background: c }} />
          ))}
        </div>
      </div>
      {issue && (f.code || f.name) && <p className="text-xs text-[#C0392B]">{issue}</p>}
    </ConfigModal>
  );
}
