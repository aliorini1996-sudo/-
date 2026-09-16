import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { taxUseLabels, vatCategoryLabels } from '../../../lib/ledger/labels';
import {
  ledgerConfigApi, ledgerKeys, isLedgerAccessError, type GlTax, type GlTaxInput, type TaxUse, type VatCategory,
} from '../../../api/ledgerConfig';
import {
  AccountSelect, ConfigHeader, ConfigModal, Field, StatusBadge, Toggle, WriteButton, hasArabicLetter,
  useAllAccounts, useConfigErrorText, useLedgerCan,
} from './parts/configUi';

/**
 * الضرائب (TAX‑01، TAX‑11، §4.4): قائمة بالاستخدام والنسبة والفئة ومربع الإقرار والحساب.
 * ضريبة القالب والضريبة المستعملة لا تتغير نسبتها ولا طبيعتها (الخادم يرد SYSTEM_TAX/TAX_IN_USE) — البديل ضريبة جديدة.
 */

const USES: TaxUse[] = ['SALE', 'PURCHASE', 'NONE'];
const CATEGORIES: VatCategory[] = ['S', 'Z', 'E', 'O'];
const VAT_BOXES = ['SA_1', 'SA_2', 'SA_3', 'SA_4', 'SA_5', 'SA_6', 'SA_7', 'SA_8', 'SA_9', 'SA_10', 'SA_11'] as const;

/** مرآة taxShapeIssue في الخادم. */
function taxShapeIssue(t: { use: string; rate: number; vatCategory: string; deductible: boolean; rcOutputAccountId: string | null }): string | null {
  if (t.vatCategory === 'S' ? !(t.rate > 0) : t.rate !== 0) return 'RATE_CATEGORY_MISMATCH';
  if (!t.deductible && t.use !== 'PURCHASE') return 'NON_DEDUCTIBLE_NOT_PURCHASE';
  if (t.rcOutputAccountId && t.use !== 'PURCHASE') return 'REVERSE_CHARGE_NOT_PURCHASE';
  return null;
}

export default function TaxList() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const canWrite = useLedgerCan('canConfigureLedger');
  const [use, setUse] = useState<TaxUse | ''>('');
  const [showArchived, setShowArchived] = useState(false);
  const [edit, setEdit] = useState<GlTax | 'new' | null>(null);
  const q = useQuery({ queryKey: ledgerKeys.taxes, queryFn: async () => (await ledgerConfigApi.taxes.list()).data.data });
  const accountsQ = useAllAccounts();
  const accountById = useMemo(() => new Map((accountsQ.data ?? []).map(a => [a.id, a])), [accountsQ.data]);
  const uses = taxUseLabels(tr);
  const cats = vatCategoryLabels(tr);

  const rows = (q.data ?? []).filter(t => (!use || t.use === use) && (showArchived || t.isActive));

  return (
    <div className="space-y-3">
      <ConfigHeader title={tr('الضرائب')} subtitle={tr('نسب ضريبة القيمة المضافة وحساباتها ومربعات الإقرار')}
        actions={<WriteButton allowed={canWrite} onClick={() => setEdit('new')} className="btn-primary inline-flex items-center gap-1.5"><Plus size={15} />{tr('جديد')}</WriteButton>} />
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-[#E8E0D2] overflow-hidden text-xs">
          {([['', tr('الكل')], ...USES.map(u => [u, uses[u]])] as [TaxUse | '', string][]).map(([k, label]) => (
            <button key={k || 'all'} type="button" onClick={() => setUse(k)}
              className={`px-3 py-1.5 ${use === k ? 'bg-[#1F1A13] text-white' : 'bg-white hover:bg-[#FBF7F0]'}`}>{label}</button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-[#6E6557]">
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />{tr('إظهار المؤرشف')}
        </label>
      </div>
      {q.isError && <p className="card text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</p>}
      <div className="table-wrapper overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th className="text-start">{tr('الاسم')}</th>
              <th className="text-start">{tr('الاستخدام')}</th>
              <th className="text-end">{tr('النسبة')}</th>
              <th className="text-start">{tr('الفئة')}</th>
              <th className="text-start">{tr('الحساب')}</th>
              <th className="text-start">{tr('مربع الإقرار')}</th>
              <th className="text-start">{tr('الحالة')}</th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && <tr><td colSpan={7} className="text-center text-[#9A8F7E] py-8">{tr('جاري التحميل...')}</td></tr>}
            {!q.isLoading && rows.length === 0 && <tr><td colSpan={7} className="text-center text-[#9A8F7E] py-8">{tr('لا توجد بيانات')}</td></tr>}
            {rows.map(t => {
              const acc = t.accountId ? accountById.get(t.accountId) : null;
              return (
                <tr key={t.id} className={canWrite ? 'cursor-pointer hover:bg-[#FBF7F0]' : ''} onClick={() => canWrite && setEdit(t)}>
                  <td className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {ledgerName(t, lang)}
                      {t.isSystem && <span title={tr('ضريبة من القالب')}><Lock size={12} className="text-[#9A8F7E]" /></span>}
                    </span>
                    {!t.deductible && <span className="block text-[11px] text-[#9A8F7E]">{tr('غير قابلة للخصم')}</span>}
                    {t.priceInclude && <span className="block text-[11px] text-[#9A8F7E]">{tr('السعر شامل الضريبة')}</span>}
                  </td>
                  <td>{uses[t.use]}</td>
                  <td className="text-end tabular-nums"><bdi dir="ltr">{t.rate}%</bdi></td>
                  <td>{cats[t.vatCategory]}</td>
                  <td>{acc ? <span><bdi className="tabular-nums text-[#6E6557]">{acc.code}</bdi> {ledgerName(acc, lang)}</span> : <span className="text-[#9A8F7E]">—</span>}</td>
                  <td>{t.vatBox ? <bdi dir="ltr" className="tabular-nums">{t.vatBox.replace('SA_', '')}</bdi> : <span className="text-[#9A8F7E]">—</span>}</td>
                  <td><StatusBadge active={t.isActive} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {edit && <TaxDialog tax={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function TaxDialog({ tax, onClose }: { tax: GlTax | null; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const accountsQ = useAllAccounts();
  const accounts = accountsQ.data ?? [];
  const uses = taxUseLabels(tr);
  const cats = vatCategoryLabels(tr);
  const [f, setF] = useState({
    name: tax?.name ?? '',
    nameEn: tax?.nameEn ?? '',
    use: tax?.use ?? ('SALE' as TaxUse),
    rate: String(tax?.rate ?? 15),
    vatCategory: tax?.vatCategory ?? ('S' as VatCategory),
    priceInclude: tax?.priceInclude ?? false,
    accountId: tax?.accountId ?? null as string | null,
    rcOutputAccountId: tax?.rcOutputAccountId ?? null as string | null,
    deductible: tax?.deductible ?? true,
    vatBox: tax?.vatBox ?? '',
    isActive: tax?.isActive ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(s => ({ ...s, [k]: v }));
  // ضريبة القالب: النسبة والطبيعة مقفلة (الخادم يرد SYSTEM_TAX)
  const computeLocked = !!tax?.isSystem;
  const rate = Number(f.rate.replace(',', '.'));
  const shape = taxShapeIssue({ use: f.use, rate, vatCategory: f.vatCategory, deductible: f.deductible, rcOutputAccountId: f.use === 'PURCHASE' ? f.rcOutputAccountId : null });
  const issue = !f.name.trim() ? tr('الاسم مطلوب')
    : !hasArabicLetter(f.name) ? tr('الاسم يجب أن يحوي حرفاً عربياً والاسم بلغة أخرى مكانه الاسم الإنجليزي')
      : !Number.isFinite(rate) || rate < 0 || rate > 100 ? tr('النسبة بين 0 و100')
        : shape === 'RATE_CATEGORY_MISMATCH' ? tr('النسبة لا توافق فئة الضريبة: الأساسية بنسبة موجبة وغيرها صفرية')
          : null;

  const save = useMutation({
    mutationFn: () => {
      const body: GlTaxInput = {
        name: f.name.trim(), nameEn: f.nameEn.trim() || null, accountId: f.accountId,
        rcOutputAccountId: f.use === 'PURCHASE' ? f.rcOutputAccountId : null,
        vatBox: f.vatBox || null, isActive: f.isActive,
      };
      if (!computeLocked) Object.assign(body, { use: f.use, rate, vatCategory: f.vatCategory, priceInclude: f.priceInclude, deductible: f.use === 'PURCHASE' ? f.deductible : true });
      return tax ? ledgerConfigApi.taxes.update(tax.id, body) : ledgerConfigApi.taxes.create(body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ledgerKeys.taxes }); toast.success(tr('تم الحفظ')); onClose(); },
    onError: e => toast.error(errorText(e)),
  });

  const lockHint = computeLocked ? tr('ضريبة من القالب: لا تتغير نسبتها ولا طبيعتها، وأنشئ ضريبة جديدة عند الحاجة') : undefined;

  return (
    <ConfigModal wide title={tax ? tr('تعديل الضريبة') : tr('ضريبة جديدة')} onClose={onClose}
      footer={<>
        <button type="button" className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        <WriteButton allowed onClick={() => save.mutate()} busy={save.isPending} reason={issue}>{tr('حفظ')}</WriteButton>
      </>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr('الاسم')}><input className="input" value={f.name} onChange={e => set('name', e.target.value)} maxLength={200} /></Field>
        <Field label={tr('الاسم الإنجليزي')}><input className="input" dir="ltr" value={f.nameEn} onChange={e => set('nameEn', e.target.value)} maxLength={200} /></Field>
        <Field label={tr('الاستخدام')} hint={lockHint}>
          <select className="input" value={f.use} disabled={computeLocked} onChange={e => set('use', e.target.value as TaxUse)}>
            {USES.map(u => <option key={u} value={u}>{uses[u]}</option>)}
          </select>
        </Field>
        <Field label={tr('النسبة')}>
          <input className="input tabular-nums" dir="ltr" inputMode="decimal" value={f.rate} disabled={computeLocked} onChange={e => set('rate', e.target.value)} />
        </Field>
        <Field label={tr('الفئة')}>
          <select className="input" value={f.vatCategory} disabled={computeLocked}
            onChange={e => { const c = e.target.value as VatCategory; setF(s => ({ ...s, vatCategory: c, rate: c === 'S' ? (Number(s.rate) > 0 ? s.rate : '15') : '0' })); }}>
            {CATEGORIES.map(c => <option key={c} value={c}>{cats[c]}</option>)}
          </select>
        </Field>
        <Field label={tr('مربع الإقرار')}>
          <select className="input" value={f.vatBox} onChange={e => set('vatBox', e.target.value)}>
            <option value="">{tr('بلا مربع')}</option>
            {VAT_BOXES.map(b => <option key={b} value={b}>{tr('المربع')} {b.replace('SA_', '')}</option>)}
          </select>
        </Field>
        <Field label={tr('حساب الضريبة')} className="sm:col-span-2">
          <AccountSelect accounts={accounts} value={f.accountId} onChange={id => set('accountId', id)} allowEmpty />
        </Field>
        {f.use === 'PURCHASE' && (
          <Field label={tr('حساب ضريبة المخرجات للاحتساب العكسي')} className="sm:col-span-2" hint={tr('للخدمات المستوردة: تُسجل ضريبة المدخلات والمخرجات معا')}>
            <AccountSelect accounts={accounts} value={f.rcOutputAccountId} onChange={id => set('rcOutputAccountId', id)} allowEmpty />
          </Field>
        )}
      </div>
      <div className="grid gap-x-6 sm:grid-cols-2">
        <Toggle label={tr('السعر شامل الضريبة')} checked={f.priceInclude} disabled={computeLocked} onChange={v => set('priceInclude', v)} />
        {f.use === 'PURCHASE' && (
          <Toggle label={tr('قابلة للخصم')} hint={tr('غير القابلة للخصم تُضاف إلى التكلفة')} checked={f.deductible} disabled={computeLocked} onChange={v => set('deductible', v)} />
        )}
        {tax && <Toggle label={tr('نشط')} checked={f.isActive} onChange={v => set('isActive', v)} />}
      </div>
      {issue && f.name && <p className="text-xs text-[#C0392B]">{issue}</p>}
    </ConfigModal>
  );
}
