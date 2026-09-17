import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, RotateCcw, Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { accountTypeLabels, joinList, mappingKeyLabels } from '../../../lib/ledger/labels';
import { ledgerConfigApi, ledgerErrorOf, ledgerKeys, isLedgerAccessError, type GlAccountMapping } from '../../../api/ledgerConfig';
import {
  CATEGORY_ACCOUNT_FIELDS, ledgerSetupApi, ledgerSetupKeys,
  type CategoryAccountField, type CategoryAccountPatch, type CategoryAccountRow,
} from '../../../api/ledgerSetup';
import { AccountSelect, ConfigHeader, WriteButton, useAllAccounts, useConfigErrorText, useLedgerCan } from './parts/configUi';

/**
 * ربط الحسابات (§4.5، §8.2): تبويب «مفاتيح الربط» (M2) — منتقي حساب لكل مفتاح مقيّد بأنواعه المقبولة
 * (`allowedTypes`) وبالحساب الرئيسي حين يتطلبه (`controlKind`)، والحفظ يرسل المفاتيح المتغيّرة وحدها في `PUT /mappings`.
 * تبويب «فئات المنتجات» (M3، CFG‑03) `?tab=categories` بـ`GET/PUT /mappings/categories`.
 */

/** تجميع المفاتيح للعرض (§4.5 بترتيب القالب). */
const MAPPING_KEY_GROUPS: { key: string; keys: string[] }[] = [
  { key: 'sales', keys: ['AR_CONTROL', 'SALES_REVENUE', 'SALES_RETURNS', 'SALES_DISCOUNT', 'DEFERRED_REVENUE', 'BAD_DEBT', 'DOUBTFUL_ALLOWANCE'] },
  { key: 'collection', keys: ['REP_CUSTODY', 'MAIN_CASH', 'PETTY_CASH', 'MAIN_BANK', 'OUTSTANDING_RECEIPTS', 'OUTSTANDING_PAYMENTS', 'CHEQUES_UNDER_COLLECTION', 'POS_CLEARING', 'PAYLINK_CLEARING', 'PAYLINK_FEE_EXPENSE', 'PAYLINK_PAYOUT_ACCOUNT', 'BANK_SUSPENSE', 'BANK_FEES', 'INTERNAL_TRANSFER'] },
  { key: 'vat', keys: ['OUTPUT_VAT', 'INPUT_VAT', 'VAT_PAYABLE', 'VAT_RECEIVABLE', 'VAT_RC_OUTPUT', 'VAT_CORRECTIONS', 'WHT_PAYABLE'] },
  { key: 'purchases', keys: ['AP_CONTROL', 'VENDOR_ADVANCES', 'GRNI', 'PURCHASES', 'PURCHASE_RETURNS', 'EARLY_DISCOUNT_GAIN', 'EARLY_DISCOUNT_LOSS', 'DEFERRED_EXPENSE', 'ACCRUED_EXPENSES', 'FUEL'] },
  { key: 'inventory', keys: ['INVENTORY_WAREHOUSE', 'INVENTORY_VAN', 'COGS', 'INVENTORY_CHANGE', 'INVENTORY_WRITEOFF', 'INVENTORY_ADJUSTMENT'] },
  { key: 'equity', keys: ['OPENING_EQUITY', 'CURRENT_YEAR_EARNINGS', 'RETAINED_EARNINGS', 'DRAWINGS', 'ZAKAT_EXPENSE', 'ZAKAT_PROVISION', 'EOSB_PROVISION'] },
  { key: 'assets', keys: ['ASSET_GAIN', 'ASSET_LOSS', 'LOAN_INTEREST', 'LEASE_LIABILITY', 'ROU_ASSET', 'ROU_ACCUMULATED', 'FX_GAIN', 'FX_LOSS'] },
  { key: 'system', keys: ['ROUNDING', 'POSTING_SUSPENSE'] },
];

export default function MappingsPage() {
  const tr = useTr();
  const [params, setParams] = useSearchParams();
  const tab: 'keys' | 'categories' = params.get('tab') === 'categories' ? 'categories' : 'keys';
  const setTab = (t: 'keys' | 'categories') => setParams(p => { const n = new URLSearchParams(p); if (t === 'keys') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  const tabCls = (on: boolean) => `px-3 py-2 text-sm -mb-px border-b-2 ${on ? 'border-[#E15A30] text-[#1F1A13] font-semibold' : 'border-transparent text-[#6E6557] hover:text-[#1F1A13]'}`;
  return (
    <div className="space-y-3">
      <ConfigHeader title={tr('ربط الحسابات')} subtitle={tr('الحسابات التي يرحّل إليها النظام قيوده الآلية')} />
      <div className="flex gap-1 border-b border-[#E8E0D2]" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'keys'} className={tabCls(tab === 'keys')} onClick={() => setTab('keys')}>{tr('مفاتيح الربط')}</button>
        <button type="button" role="tab" aria-selected={tab === 'categories'} className={tabCls(tab === 'categories')} onClick={() => setTab('categories')}>{tr('فئات المنتجات')}</button>
      </div>
      {tab === 'keys' ? <MappingKeysTab /> : <CategoryAccountsTab />}
    </div>
  );
}

/**
 * تبويب «فئات المنتجات» (CFG‑03، §3.8، §8.2): صف لكل ProductCategory بمنتقيات GlProductCategoryAccount
 * (الدخل والنفقات والتكلفة والمخزون). الحقل الفارغ = مفتاح الربط الافتراضي، والحقول الأربعة فارغة تحذف الصف.
 * التعديل يسري على الأحداث المُلتقطة بعد الحفظ فقط ولا يعيد ترحيل ما سبق. الحفظ يرسل الفئات المتغيّرة وحدها.
 */
function CategoryAccountsTab() {
  const tr = useTr();
  const qc = useQueryClient();
  const lang = useLang(s => s.lang);
  const errorText = useConfigErrorText();
  const canWrite = useLedgerCan('canConfigureLedger');
  const keyLabels = mappingKeyLabels(tr);
  const [draft, setDraft] = useState<Record<string, Partial<Record<CategoryAccountField, string | null>>>>({});
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ledgerSetupKeys.categories, queryFn: async () => (await ledgerSetupApi.categories.list()).data.data });
  const accountsQ = useAllAccounts();
  const accounts = accountsQ.data ?? [];
  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  useEffect(() => setDraft({}), [q.data]);

  const fieldLabels: Record<CategoryAccountField, string> = {
    incomeAccountId: tr('حساب الدخل'),
    expenseAccountId: tr('حساب النفقات'),
    cogsAccountId: tr('حساب تكلفة المبيعات'),
    inventoryAccountId: tr('حساب المخزون'),
  };
  const rules = new Map((q.data?.fields ?? []).map(f => [f.field, f]));
  const rows = q.data?.categories ?? [];
  const valueOf = (c: CategoryAccountRow, f: CategoryAccountField) => (draft[c.categoryId] && f in draft[c.categoryId] ? draft[c.categoryId][f] ?? null : c[f]);
  const changed = rows
    .map(c => {
      const patch: CategoryAccountPatch = { categoryId: c.categoryId };
      let any = false;
      for (const f of CATEGORY_ACCOUNT_FIELDS) {
        const d = draft[c.categoryId];
        if (d && f in d && (d[f] ?? null) !== c[f]) { patch[f] = d[f] ?? null; any = true; }
      }
      return any ? patch : null;
    })
    .filter((x): x is CategoryAccountPatch => !!x);

  const save = useMutation({
    mutationFn: async () => (await ledgerSetupApi.categories.update(changed)).data.data,
    onSuccess: d => {
      qc.setQueryData(ledgerSetupKeys.categories, d);
      toast.success(tr('تم الحفظ'));
    },
    onError: e => {
      const b = ledgerErrorOf(e);
      const field = typeof b?.field === 'string' ? fieldLabels[b.field as CategoryAccountField] : null;
      const cat = typeof b?.categoryId === 'string' ? rows.find(r => r.categoryId === b.categoryId)?.categoryName : null;
      const text = b?.reason === 'CATEGORY_ACCOUNT_TYPE' ? tr('نوع الحساب لا يوافق حقل الفئة') : errorText(e);
      toast.error([cat, field, text].filter(Boolean).join(' · '));
    },
  });

  const s = search.trim().toLowerCase();
  const visible = rows.filter(c => !s || c.categoryName.toLowerCase().includes(s));

  if (q.isError) return <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-[#9A8F7E] leading-relaxed">{tr('الفئة بلا حساب مخصص تستعمل حسابات المنتج الافتراضية. التعديل يسري على المستندات الجديدة فقط ولا يعيد ترحيل ما سبق')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[14rem] max-w-md">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
          <input className="input ps-8" placeholder={tr('بحث')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <span className="flex-1" />
        {changed.length > 0 && (
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => setDraft({})}><RotateCcw size={14} />{tr('إهمال التعديلات')}</button>
        )}
        <WriteButton allowed={canWrite} onClick={() => save.mutate()} busy={save.isPending} disabled={changed.length === 0} className="btn-primary inline-flex items-center gap-1.5">
          <Save size={14} />{tr('حفظ')}{changed.length > 0 && <span className="tabular-nums">({changed.length})</span>}
        </WriteButton>
      </div>
      {q.isLoading && <p className="text-sm text-[#9A8F7E] py-6 text-center">{tr('جاري التحميل...')}</p>}
      {q.data && rows.length === 0 && <p className="card text-sm text-[#9A8F7E] text-center py-6">{tr('لا توجد فئات منتجات')}</p>}
      {q.data && rows.length > 0 && (
        <div className="card !p-0 overflow-visible">
          <div className="hidden lg:grid grid-cols-[minmax(10rem,1fr)_repeat(4,minmax(12rem,1fr))] gap-2 px-4 py-2 text-[11px] text-[#9A8F7E] border-b border-[#F1EBDF] bg-[#FBF7F0] rounded-t-2xl">
            <span>{tr('الفئة')}</span>
            {CATEGORY_ACCOUNT_FIELDS.map(f => <span key={f}>{fieldLabels[f]}</span>)}
          </div>
          <div className="divide-y divide-[#F1EBDF]">
            {visible.map(c => {
              const dirty = changed.some(x => x.categoryId === c.categoryId);
              return (
                <div key={c.categoryId} className={`grid gap-2 px-4 py-2.5 lg:grid-cols-[minmax(10rem,1fr)_repeat(4,minmax(12rem,1fr))] items-center ${dirty ? 'bg-[#FBEBE2]/40' : ''}`}>
                  <div className="min-w-0">
                    <p className="text-sm text-[#1F1A13] truncate">{c.categoryName}</p>
                    <p className="text-[11px] text-[#9A8F7E]">
                      <bdi className="tabular-nums">{c.productCount}</bdi> {tr('منتج')}{c.customized ? ` · ${tr('مخصصة')}` : ''}
                    </p>
                  </div>
                  {CATEGORY_ACCOUNT_FIELDS.map(f => {
                    const rule = rules.get(f);
                    const fb = rule?.fallbackAccountId ? byId.get(rule.fallbackAccountId) : null;
                    const placeholder = fb ? `${tr('الافتراضي')}: ${fb.code} ${ledgerName(fb, lang)}` : `${tr('الافتراضي')}: ${rule ? keyLabels[rule.fallbackKey] ?? rule.fallbackKey : ''}`;
                    return (
                      <div key={f} className="min-w-0">
                        <span className="lg:hidden text-[11px] text-[#9A8F7E]">{fieldLabels[f]}</span>
                        <AccountSelect accounts={accounts} value={valueOf(c, f)} disabled={!canWrite} allowEmpty
                          types={rule?.allowedTypes} controlKind={rule?.controlKind ?? null} placeholder={placeholder}
                          onChange={id => setDraft(d => ({ ...d, [c.categoryId]: { ...(d[c.categoryId] ?? {}), [f]: id } }))} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MappingKeysTab() {
  const tr = useTr();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const canWrite = useLedgerCan('canConfigureLedger');
  const labels = mappingKeyLabels(tr);
  const lang = useLang(s => s.lang);
  const typeLabels = accountTypeLabels(tr);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ledgerKeys.mappings, queryFn: async () => (await ledgerConfigApi.mappings.list()).data.data });
  const accountsQ = useAllAccounts();
  const accounts = accountsQ.data ?? [];
  const byKey = useMemo(() => new Map((q.data ?? []).map(m => [m.key, m])), [q.data]);
  useEffect(() => setDraft({}), [q.data]);

  const groupLabels: Record<string, string> = {
    sales: tr('المبيعات والذمم'),
    collection: tr('النقد والبنوك والتحصيل'),
    vat: tr('الضرائب'),
    purchases: tr('المشتريات والمصروفات'),
    inventory: tr('المخزون والتكلفة'),
    equity: tr('حقوق الملكية والمخصصات'),
    assets: tr('الأصول والتمويل والعملات'),
    system: tr('حسابات النظام'),
  };

  const changed = Object.entries(draft).filter(([k, id]) => (byKey.get(k)?.accountId ?? null) !== id);
  const save = useMutation({
    mutationFn: () => ledgerConfigApi.mappings.update(changed.map(([key, accountId]) => ({ key, accountId }))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ledgerKeys.mappings });
      qc.invalidateQueries({ queryKey: ['ledger', 'account'] });
      toast.success(tr('تم الحفظ'));
    },
    onError: e => {
      const key = (e as { response?: { data?: { key?: string } } })?.response?.data?.key;
      toast.error(key ? `${labels[key] ?? key}: ${errorText(e)}` : errorText(e));
    },
  });

  const s = search.trim().toLowerCase();
  const matches = (m: GlAccountMapping) => !s || m.key.toLowerCase().includes(s) || (labels[m.key] ?? '').toLowerCase().includes(s);
  const grouped = MAPPING_KEY_GROUPS.map(g => ({ ...g, rows: g.keys.map(k => byKey.get(k)).filter((m): m is GlAccountMapping => !!m && matches(m)) }));
  const known = new Set(MAPPING_KEY_GROUPS.flatMap(g => g.keys));
  const others = (q.data ?? []).filter(m => !known.has(m.key) && matches(m));
  if (others.length) grouped.push({ key: 'other', keys: [], rows: others });

  if (q.isError) return <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[14rem] max-w-md">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
          <input className="input ps-8" placeholder={tr('بحث')} value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <span className="flex-1" />
        {changed.length > 0 && (
          <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => setDraft({})}><RotateCcw size={14} />{tr('إهمال التعديلات')}</button>
        )}
        <WriteButton allowed={canWrite} onClick={() => save.mutate()} busy={save.isPending} disabled={changed.length === 0} className="btn-primary inline-flex items-center gap-1.5">
          <Save size={14} />{tr('حفظ')}{changed.length > 0 && <span className="tabular-nums">({changed.length})</span>}
        </WriteButton>
      </div>
      {q.isLoading && <p className="text-sm text-[#9A8F7E] py-6 text-center">{tr('جاري التحميل...')}</p>}
      {grouped.filter(g => g.rows.length > 0).map(g => (
        <section key={g.key} className="card !p-0 overflow-visible">
          <h2 className="px-4 py-2 text-sm font-bold text-[#1F1A13] border-b border-[#F1EBDF] bg-[#FBF7F0] rounded-t-2xl">{groupLabels[g.key] ?? tr('أخرى')}</h2>
          <div className="divide-y divide-[#F1EBDF]">
            {g.rows.map(m => {
              const value = draft[m.key] ?? m.accountId;
              const dirty = draft[m.key] !== undefined && draft[m.key] !== m.accountId;
              return (
                <div key={m.key} className={`grid gap-2 px-4 py-2.5 sm:grid-cols-[1fr_minmax(16rem,1.2fr)] items-center ${dirty ? 'bg-[#FBEBE2]/40' : ''}`}>
                  <div className="min-w-0">
                    <p className="text-sm text-[#1F1A13]">{labels[m.key] ?? m.key}</p>
                    <p className="text-[11px] text-[#9A8F7E] truncate">
                      <bdi dir="ltr" className="font-mono">{m.key}</bdi>
                      {m.allowedTypes?.length ? ` · ${joinList(lang, m.allowedTypes.map(t => typeLabels[t]))}` : ''}
                      {m.controlKind ? ` · ${tr('حساب رئيسي')}` : ''}
                    </p>
                  </div>
                  <AccountSelect accounts={accounts} value={value} disabled={!canWrite}
                    types={m.allowedTypes} controlKind={m.controlKind ?? null} invalid={!value}
                    placeholder={tr('غير مربوط')}
                    onChange={id => id && setDraft(d => ({ ...d, [m.key]: id }))} />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
