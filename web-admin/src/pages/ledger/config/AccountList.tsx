import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, FolderTree, ChevronDown, Upload, FileDown, AlertTriangle, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { accountTypeLabels, cashFlowTagLabels, chunkIds, joinList, ledgerConfigReasonLabels } from '../../../lib/ledger/labels';
import { exportExcel } from '../../../utils/excel';
import { parseExcelFile } from '../../../lib/importData';
import {
  ledgerConfigApi, ledgerKeys, ledgerErrorOf, isLedgerAccessError,
  type AccountListParams, type AccountType, type GlAccount, type GlAccountTreeNode, type AccountImportResult,
} from '../../../api/ledgerConfig';
import { fetchListExport } from '../../../api/ledgerMoves';
import { LedgerListView, initialLedgerListState, type LedgerColumn, type LedgerListState } from '../../../components/ledger/LedgerListView';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { ledgerHref } from '../routes';
import { ConfigModal, WriteButton, useConfigErrorText, useLedgerCan } from './parts/configUi';
import { ACCOUNT_TYPE_KEYS, IMPORT_MAX_ROWS, parseImportRows, type ImportRowIssue, type ParsedImportRow } from './parts/accountImport';

/**
 * شجرة الحسابات (COA‑01…09): قائمة 80 صفاً بالرمز والاسم والنوع والتسوية، والتجميع حسب النوع،
 * ولوحة بادئات الرموز، والفلاتر والمفضلات (GlSavedFilter)، والاستيراد مع المعاينة، والأرشفة والتصدير XLSX.
 * القراءة canViewLedger، والكتابة canConfigureLedger (أزرارها معطّلة بتلميح دونها).
 */

const SERVER_FILTERS = new Set(['debit', 'credit', 'asset', 'liability', 'equity', 'income', 'expense', 'hasMoves', 'archived', 'custom']);

/** مرآة TYPE_FILTERS في الخادم — لتصدير «الكل» بالفلاتر الحالية. */
const TYPE_FILTERS: Record<string, AccountType[]> = {
  debit: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('asset_') || t.startsWith('expense')),
  credit: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('liability_') || t.startsWith('equity') || t.startsWith('income')),
  asset: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('asset_')),
  liability: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('liability_')),
  equity: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('equity')),
  income: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('income')),
  expense: ACCOUNT_TYPE_KEYS.filter(t => t.startsWith('expense')),
};

export default function AccountList() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const canWrite = useLedgerCan('canConfigureLedger');
  const typeLabels = accountTypeLabels(tr);
  const flowLabels = cashFlowTagLabels(tr);
  const [state, setState] = useState<LedgerListState>(() => initialLedgerListState());
  const [prefix, setPrefix] = useState<string | null>(null);
  const [treeOpen, setTreeOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const params: AccountListParams = {
    search: state.search || undefined,
    filter: state.filters.filter(f => SERVER_FILTERS.has(f)).join(',') || undefined,
    prefix: prefix ?? undefined,
    groupBy: state.groupBy[0] === 'type' ? 'type' : undefined,
    offset: state.offset,
    limit: state.limit,
  };
  const q = useQuery({
    queryKey: ledgerKeys.accounts(params),
    queryFn: async () => (await ledgerConfigApi.accounts.list(params)).data,
    placeholderData: prev => prev,
  });
  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const decimals = statusQ.data?.currencyDecimals ?? 2;
  const rows = q.data?.data ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ledger', 'accounts'] });
    qc.invalidateQueries({ queryKey: ledgerKeys.accountTree });
  };

  const reconcile = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) => ledgerConfigApi.accounts.update(id, { reconcile: value }),
    onSuccess: () => invalidate(),
    onError: e => toast.error(errorText(e)),
  });

  const archiveMany = async (ids: string[], archived: boolean) => {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try { await ledgerConfigApi.accounts.archive(id, archived); ok++; } catch (e) {
        const code = rows.find(r => r.id === id)?.code ?? id;
        failed.push(`${code}: ${errorText(e)}`);
      }
    }
    setBusy(false);
    invalidate();
    if (ok) toast.success(archived ? tr('تمت أرشفة الحسابات') : tr('تمت استعادة الحسابات'));
    if (failed.length) toast.error(failed.slice(0, 5).join('\n'), { duration: 8000 });
  };

  /** التصدير عبر POST /lists/accounts/export (تدقيق EXPORT): المحدد بالمعرّفات، والكل بالفلاتر الحالية. */
  const exportAccounts = async (ids?: string[]) => {
    setBusy(true);
    try {
      let exportIds = ids;
      const f = state.filters;
      const needsIds = !ids && (prefix || f.includes('hasMoves') || f.includes('custom'));
      if (needsIds) {
        exportIds = [];
        for (let offset = 0; ; offset += 1000) {
          const page = (await ledgerConfigApi.accounts.list({ ...params, offset, limit: 1000 })).data;
          exportIds.push(...page.data.map(a => a.id));
          if (offset + 1000 >= (page.pagination?.total ?? 0)) break;
        }
      }
      const types = [...new Set(f.flatMap(k => TYPE_FILTERS[k] ?? []))];
      const filters: Record<string, unknown> = exportIds ? {} : {
        ...(state.search ? { search: state.search } : {}),
        ...(types.length ? { type: types.join(',') } : {}),
        isActive: !f.includes('archived'),
      };
      // فلتر بلا نتائج: لا نرسل ids=[] (كان يُفهم «بلا شرط» فيُصدَّر الكل مع المؤرشف)
      if (exportIds && exportIds.length === 0) { toast(tr('لا توجد بيانات للتصدير')); return; }
      // الخادم يقبل 1000 معرّف في الطلب — نقسّم ولا نقتطع صامتين
      const rows = exportIds
        ? (await Promise.all(chunkIds(exportIds).map(chunk => fetchListExport('accounts', { ids: chunk })))).flatMap(r => r.rows)
        : (await fetchListExport('accounts', { filters })).rows;
      const sheetRows = rows.map(r => {
        const a = r as Partial<GlAccount> & { tags?: string[] };
        return {
          [tr('الرمز')]: a.code ?? '',
          [tr('الاسم')]: a.name ?? '',
          [tr('الاسم الإنجليزي')]: a.nameEn ?? '',
          [tr('النوع')]: a.type ? typeLabels[a.type] ?? a.type : '',
          [tr('التسوية')]: a.reconcile ? tr('نعم') : '',
          [tr('التدفق النقدي')]: a.cashFlowTag ? flowLabels[a.cashFlowTag] ?? a.cashFlowTag : '',
          [tr('العملة')]: a.currencyCode ?? '',
          [tr('العلامات')]: (a.tags ?? []).join(', '), // فاصل محايد ثابت في الملف أياً كانت اللغة
          [tr('الحالة')]: a.isActive === false ? tr('مؤرشف') : tr('نشط'),
        };
      });
      await exportExcel([{ name: tr('شجرة الحسابات'), rows: sheetRows, colWidths: [12, 36, 30, 22, 10, 18, 8, 20, 10] }], 'chart-of-accounts');
    } catch (e) {
      toast.error(ledgerErrorOf(e)?.code === 'LEDGER_EXPORT_TOO_LARGE' ? tr('التصدير يتجاوز الحد المسموح') : errorText(e, tr('تعذر التصدير')));
    } finally {
      setBusy(false);
    }
  };

  const columns: LedgerColumn<GlAccount>[] = [
    { key: 'code', label: tr('الرمز'), render: a => <bdi dir="ltr" className="tabular-nums font-medium">{a.code}</bdi>, className: 'w-28' },
    {
      key: 'name', label: tr('الاسم'), render: a => (
        <span className={a.isActive ? '' : 'text-[#9A8F7E] line-through'}>
          {ledgerName(a, lang)}
          {a.description && <span className="block text-[11px] text-[#9A8F7E] truncate max-w-md">{a.description}</span>}
        </span>
      ),
    },
    { key: 'type', label: tr('النوع'), render: a => <span className="text-sm">{typeLabels[a.type]}</span> },
    {
      key: 'reconcile', label: tr('التسوية'), align: 'center', render: a => {
        if (a.type === 'asset_cash') return null; // COA‑02: مخفي للبنك والنقد
        const locked = a.controlKind === 'AR';
        return (
          <span onClick={e => e.stopPropagation()}>
            <input type="checkbox" checked={a.reconcile} aria-label={tr('التسوية')}
              disabled={!canWrite || locked || reconcile.isPending}
              title={!canWrite ? tr('لا تملك صلاحية التعديل') : locked ? tr('التسوية مقفلة لحساب ذمم العملاء الرئيسي') : undefined}
              onChange={e => reconcile.mutate({ id: a.id, value: e.target.checked })} />
          </span>
        );
      },
    },
    { key: 'balance', label: tr('الرصيد'), optional: true, defaultVisible: true, align: 'end', render: a => <LedgerAmount value={a.balance ?? 0} decimals={decimals} /> },
    { key: 'cashFlow', label: tr('التدفق النقدي'), optional: true, render: a => (a.cashFlowTag ? flowLabels[a.cashFlowTag] : '') },
    { key: 'currency', label: tr('العملة'), optional: true, render: a => <bdi dir="ltr">{a.currencyCode ?? ''}</bdi> },
    { key: 'system', label: tr('حساب النظام'), optional: true, render: a => (a.isSystem ? tr('نعم') : '') },
  ];

  const typeOrder = new Map(ACCOUNT_TYPE_KEYS.map((t, i) => [t, i]));
  const groupCounts = new Map((q.data?.groups ?? []).map(g => [g.type, g.count]));
  const displayRows = state.groupBy[0] === 'type' ? [...rows].sort((x, y) => (typeOrder.get(x.type) ?? 0) - (typeOrder.get(y.type) ?? 0) || x.code.localeCompare(y.code)) : rows;

  return (
    <div className={`grid gap-4 ${treeOpen ? 'lg:grid-cols-[15rem_1fr]' : ''}`}>
      {treeOpen && <PrefixTree prefix={prefix} onPick={p => { setPrefix(p); setState(s => ({ ...s, offset: 0 })); }} onClose={() => setTreeOpen(false)} />}
      <div className="min-w-0">
        <LedgerListView<GlAccount>
          title={tr('شجرة الحسابات')}
          screen="accounts"
          columns={columns}
          rows={displayRows}
          total={q.data?.pagination?.total ?? 0}
          loading={q.isLoading}
          fetching={q.isFetching || busy}
          state={state}
          onStateChange={setState}
          filters={[
            { key: 'debit', label: tr('مدين'), group: 'side' },
            { key: 'credit', label: tr('دائن'), group: 'side' },
            { key: 'asset', label: tr('الأصول'), group: 'class' },
            { key: 'liability', label: tr('الالتزامات'), group: 'class' },
            { key: 'equity', label: tr('حقوق الملكية'), group: 'class' },
            { key: 'income', label: tr('الدخل'), group: 'class' },
            { key: 'expense', label: tr('المصروفات'), group: 'class' },
            { key: 'hasMoves', label: tr('حساب بحركة'), group: 'state' },
            { key: 'archived', label: tr('مؤرشف'), group: 'state' },
            { key: 'custom', label: tr('مخصص'), group: 'state' },
          ]}
          groupBys={[{
            key: 'type', label: tr('النوع'),
            value: a => `${typeLabels[a.type]}${groupCounts.has(a.type) ? ` · ${groupCounts.get(a.type)}` : ''}`,
          }]}
          bulkActions={[
            { label: tr('أرشفة المحدد'), perm: 'canConfigureLedger', danger: true, run: ids => archiveMany(ids, true) },
            { label: tr('استعادة المحدد'), perm: 'canConfigureLedger', run: ids => archiveMany(ids, false), disabledReason: ids => (ids.some(id => rows.find(r => r.id === id)?.isActive !== false) ? tr('المحدد يضم حسابات نشطة') : null) },
            { label: tr('تصدير XLSX'), perm: 'canViewLedger', run: ids => exportAccounts(ids) },
          ]}
          gearActions={[
            { label: tr('تصدير الكل XLSX'), perm: 'canViewLedger', run: () => exportAccounts() },
            { label: tr('استيراد الحسابات'), perm: 'canConfigureLedger', run: () => setImportOpen(true) },
          ]}
          recordPath={a => ledgerHref(`config/accounts/${a.id}`)}
          rowClassName={a => (a.isActive ? '' : 'opacity-70')}
          emptyText={tr('لا توجد حسابات')}
          toolbar={
            <div className="flex items-center gap-1.5">
              <WriteButton allowed={canWrite} onClick={() => navigate(ledgerHref('config/accounts/new'))} className="btn-primary !py-1.5 !px-3 text-sm inline-flex items-center gap-1"><Plus size={14} />{tr('جديد')}</WriteButton>
              <WriteButton allowed={canWrite} onClick={() => setImportOpen(true)} className="btn-secondary !py-1.5 !px-3 text-sm inline-flex items-center gap-1"><Upload size={14} />{tr('استيراد')}</WriteButton>
              {!treeOpen && (
                <button type="button" className="btn-secondary !py-1.5 !px-2 text-sm" onClick={() => setTreeOpen(true)} aria-label={tr('شجرة البادئات')} title={tr('شجرة البادئات')}><FolderTree size={15} /></button>
              )}
            </div>
          }
        />
        {q.isError && <p className="card mt-3 text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>}
        {prefix && (
          <p className="mt-2 text-xs text-[#6E6557]">
            {tr('مفلتر بالبادئة')} <bdi dir="ltr" className="font-mono">{prefix}</bdi> · <button type="button" className="underline" onClick={() => setPrefix(null)}>{tr('إزالة')}</button>
          </p>
        )}
      </div>
      {importOpen && <AccountImportDialog onClose={() => setImportOpen(false)} onDone={invalidate} />}
    </div>
  );
}

/** لوحة بادئات الرموز (COA‑05): ثلاثة مستويات قابلة للتعمق. */
function PrefixTree({ prefix, onPick, onClose }: { prefix: string | null; onPick: (p: string | null) => void; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const q = useQuery({ queryKey: ledgerKeys.accountTree, queryFn: async () => (await ledgerConfigApi.accounts.tree()).data.data, staleTime: 60_000 });
  const toggle = (p: string) => setExpanded(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  const renderNode = (n: GlAccountTreeNode, depth: number) => {
    const open = expanded.has(n.prefix);
    const name = n.names ? (n.names[lang] ?? n.names.ar ?? '') : '';
    return (
      <li key={n.prefix}>
        <div className={`flex items-center gap-1 rounded-lg ${prefix === n.prefix ? 'bg-[#FBEBE2] text-[#E15A30]' : 'hover:bg-[#FBF7F0]'}`} style={{ paddingInlineStart: `${depth * 0.75}rem` }}>
          {n.children.length > 0
            ? <button type="button" className="p-1" aria-label={n.prefix} aria-expanded={open} onClick={() => toggle(n.prefix)}><ChevronDown size={13} className={open ? '' : '-rotate-90 rtl:rotate-90'} /></button>
            : <span className="w-[21px]" />}
          <button type="button" className="flex-1 flex items-center gap-1.5 text-start text-sm py-1 min-w-0" onClick={() => onPick(prefix === n.prefix ? null : n.prefix)}>
            <bdi dir="ltr" className="font-mono tabular-nums">{n.prefix}</bdi>
            {name && <span className="truncate">{name}</span>}
            <span className="ms-auto pe-2 text-[11px] text-[#9A8F7E] tabular-nums">{n.count}</span>
          </button>
        </div>
        {open && n.children.length > 0 && <ul>{n.children.map(c => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  return (
    <aside className="card !p-2 h-fit lg:sticky lg:top-4">
      <div className="flex items-center gap-2 px-2 py-1">
        <FolderTree size={15} className="text-[#E15A30]" />
        <span className="text-sm font-bold flex-1">{tr('شجرة البادئات')}</span>
        <button type="button" className="text-[11px] text-[#9A8F7E] hover:underline" onClick={onClose}>{tr('إخفاء')}</button>
      </div>
      <button type="button" className={`w-full text-start text-sm px-3 py-1 rounded-lg ${prefix === null ? 'bg-[#FBEBE2] text-[#E15A30]' : 'hover:bg-[#FBF7F0]'}`} onClick={() => onPick(null)}>{tr('الكل')}</button>
      {q.isLoading && <p className="text-xs text-[#9A8F7E] px-3 py-2">{tr('جاري التحميل...')}</p>}
      <ul className="mt-1">{(q.data ?? []).map(n => renderNode(n, 0))}</ul>
    </aside>
  );
}

/** استيراد الحسابات (COA‑07): ملف XLSX أو CSV ← معاينة وتحقق ← معاينة الخادم (dryRun) ← الاستيراد. */
function AccountImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const errorText = useConfigErrorText();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<{ rows: ParsedImportRow[]; missingColumns: string[] } | null>(null);
  const [preview, setPreview] = useState<AccountImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const reasons = ledgerConfigReasonLabels(tr);
  const typeLabelTables = useMemo(() => [accountTypeLabels(tr), accountTypeLabels(s => s)], [tr]);

  const issueLabels: Record<ImportRowIssue, string> = {
    CODE_INVALID: tr('الرمز من 4 إلى 10 أرقام'),
    NAME_REQUIRED: tr('الاسم مطلوب'),
    NAME_NOT_ARABIC: tr('الاسم يجب أن يحوي حرفاً عربياً'),
    TYPE_INVALID: tr('نوع غير معروف'),
    RECONCILE_CASH: tr('لا تُفعَّل التسوية لحسابات البنك والنقد'),
    DUPLICATE_IN_FILE: tr('رمز مكرر في الملف'),
    EQUITY_UNAFFECTED: tr('أرباح السنة الجارية يحسبها النظام'),
  };

  const valid = parsed?.rows.filter(r => r.row).map(r => r.row!) ?? [];
  const invalid = parsed?.rows.filter(r => !r.row) ?? [];

  const onFile = async (file: File) => {
    setBusy(true); setPreview(null);
    try {
      const records = await parseExcelFile(file);
      const res = parseImportRows(records, typeLabelTables);
      setFileName(file.name);
      setParsed(res);
      const ok = res.rows.filter(r => r.row).map(r => r.row!);
      if (ok.length && ok.length <= IMPORT_MAX_ROWS && !res.rows.some(r => r.issues.includes('NAME_NOT_ARABIC'))) {
        setPreview((await ledgerConfigApi.accounts.import(ok, true)).data.data);
      }
    } catch (e) {
      toast.error(errorText(e, tr('تعذر قراءة الملف')));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const run = useMutation({
    mutationFn: () => ledgerConfigApi.accounts.import(valid, false),
    onSuccess: r => {
      const d = r.data.data;
      toast.success(`${tr('تم استيراد الحسابات')}: ${d.created}`);
      onDone(); onClose();
    },
    onError: e => toast.error(errorText(e)),
  });

  const downloadTemplate = () => exportExcel([{
    name: tr('شجرة الحسابات'),
    rows: [
      { [tr('الرمز')]: '611099', [tr('الاسم')]: 'مصروفات متنوعة', [tr('الاسم الإنجليزي')]: 'Miscellaneous Expenses', [tr('النوع')]: 'expense', [tr('التسوية')]: '' },
    ],
    colWidths: [12, 32, 30, 20, 10],
  }], 'accounts-import-template');

  const blockReason = !parsed ? tr('اختر ملفا')
    : parsed.missingColumns.length ? tr('أعمدة ناقصة في الملف')
      : valid.length === 0 ? tr('لا صفوف صالحة للاستيراد')
        : valid.length > IMPORT_MAX_ROWS ? tr('الحد الأقصى 5000 صف في الملف')
          : invalid.some(r => r.issues.includes('NAME_NOT_ARABIC')) ? tr('الاسم يجب أن يحوي حرفاً عربياً')
            : null;

  const columnLabels: Record<string, string> = { code: tr('الرمز'), name: tr('الاسم'), type: tr('النوع') };

  return (
    <ConfigModal wide title={tr('استيراد الحسابات')} onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        <WriteButton allowed onClick={() => run.mutate()} busy={run.isPending || busy} reason={blockReason}>
          {tr('استيراد')}{preview ? ` (${preview.created})` : valid.length ? ` (${valid.length})` : ''}
        </WriteButton>
      </>}>
      <p className="text-sm text-[#6E6557] leading-relaxed">
        {tr('ملف XLSX أو CSV بأعمدة: الرمز، الاسم (عربي)، الاسم الإنجليزي، النوع، التسوية. الحساب الموجود بالرمز يُتخطى ولا يُعدَّل')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) void onFile(f); }} />
        <button type="button" className="btn-primary inline-flex items-center gap-1.5" disabled={busy} onClick={() => fileRef.current?.click()}><Upload size={15} />{tr('اختيار ملف')}</button>
        <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => void downloadTemplate()}><FileDown size={15} />{tr('تنزيل نموذج')}</button>
        {fileName && <span className="text-xs text-[#6E6557] truncate">{fileName}</span>}
        {busy && <span className="text-xs text-[#9A8F7E]">{tr('جاري التحميل...')}</span>}
      </div>

      {parsed && (
        <div className="space-y-2">
          {parsed.missingColumns.length > 0 && (
            <p className="text-sm text-[#C0392B] flex items-center gap-1.5"><AlertTriangle size={14} />{tr('أعمدة ناقصة في الملف')}: {joinList(lang, parsed.missingColumns.map(c => columnLabels[c] ?? c))}</p>
          )}
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="badge badge-active">{tr('صفوف صالحة')}: <span className="tabular-nums">{valid.length}</span></span>
            {invalid.length > 0 && <span className="badge badge-cancelled">{tr('صفوف بها أخطاء')}: <span className="tabular-nums">{invalid.length}</span></span>}
            {preview && <span className="badge badge-confirmed inline-flex items-center gap-1"><CheckCircle2 size={12} />{tr('ستُنشأ')}: <span className="tabular-nums">{preview.created}</span></span>}
            {preview && preview.skipped.length > 0 && <span className="badge badge-inactive">{tr('ستُتخطى')}: <span className="tabular-nums">{preview.skipped.length}</span></span>}
          </div>
          {(invalid.length > 0 || (preview?.skipped.length ?? 0) > 0) && (
            <div className="table-wrapper overflow-x-auto max-h-64">
              <table className="table text-sm">
                <thead><tr><th className="text-start">{tr('السطر')}</th><th className="text-start">{tr('الرمز')}</th><th className="text-start">{tr('الاسم')}</th><th className="text-start">{tr('السبب')}</th></tr></thead>
                <tbody>
                  {invalid.slice(0, 200).map(r => (
                    <tr key={`i${r.line}`}>
                      <td className="tabular-nums">{r.line}</td>
                      <td><bdi dir="ltr">{r.raw.code}</bdi></td>
                      <td>{r.raw.name}</td>
                      <td className="text-[#C0392B]">{joinList(lang, r.issues.map(i => issueLabels[i]))}</td>
                    </tr>
                  ))}
                  {(preview?.skipped ?? []).slice(0, 200).map((s, i) => (
                    <tr key={`s${i}`}>
                      <td>—</td>
                      <td><bdi dir="ltr">{s.code}</bdi></td>
                      <td>{valid.find(v => v.code === s.code)?.name ?? ''}</td>
                      <td className="text-[#6E6557]">{reasons[s.reason] ?? s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </ConfigModal>
  );
}
