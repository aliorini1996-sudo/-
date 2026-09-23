import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { ledgerName } from '../../../lib/ledger/format';
import { accountTypeLabels, cashFlowTagLabels, joinList, mappingKeyLabels } from '../../../lib/ledger/labels';
import {
  ledgerConfigApi, ledgerKeys, isLedgerAccessError,
  type AccountType, type CashFlowTag, type GlAccount, type GlAccountInput,
} from '../../../api/ledgerConfig';
import { LedgerForm, type LedgerFormGearItem } from '../../../components/ledger/LedgerForm';
import { LedgerAmount } from '../../../components/ledger/LedgerAmount';
import { ledgerHref } from '../routes';
import { Field, Toggle, hasArabicLetter, useConfigErrorText, useLedgerCan } from './parts/configUi';
import { ACCOUNT_TYPE_KEYS } from './parts/accountImport';

/**
 * نموذج الحساب (COA‑01…03، CFG‑06): الرمز والاسم (عربي إلزاماً، G7) والوصف والنوع والتسوية وتصنيف التدفق
 * النقدي والعملة والعلامات. رمز حساب القالب أو ذي الحركة مقفل، ونوع الحساب الرئيسي ثابت، والتسوية مخفية للبنك والنقد.
 * م‑5 (مراجعة الخبير): الوصف يُحرَّر هنا ويصل الخادم في POST وPATCH معاً (`routes/ledger/config.ts`)، فما
 * يكتبه المستخدم يعلو وصف القالب ولا يُكتَب فوقه عند إعادة الزرع.
 * الأرشفة لا الحذف (§3.2). القراءة canViewLedger والتعديل canConfigureLedger.
 */

const CASH_FLOW_TAGS: CashFlowTag[] = ['OPERATING', 'INVESTING', 'FINANCING', 'EXCLUDE', 'CASH_EQUIVALENT'];

/** حدّ الوصف — مرآة `z.string().max(2000)` في `routes/ledger/config.ts` (لا يُرفض الحفظ من الخادم). */
const DESCRIPTION_MAX = 2000;

interface FormState {
  code: string; name: string; nameEn: string; description: string; type: AccountType;
  reconcile: boolean; cashFlowTag: CashFlowTag | ''; currencyCode: string; tagIds: string[];
}

const toForm = (a?: GlAccount | null): FormState => ({
  code: a?.code ?? '', name: a?.name ?? '', nameEn: a?.nameEn ?? '', description: a?.description ?? '',
  type: a?.type ?? 'expense', reconcile: a?.reconcile ?? false, cashFlowTag: a?.cashFlowTag ?? '',
  currencyCode: a?.currencyCode ?? '', tagIds: [...(a?.tagIds ?? [])].sort(),
});

export default function AccountForm() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const canWrite = useLedgerCan('canConfigureLedger');
  const typeLabels = accountTypeLabels(tr);
  const flowLabels = cashFlowTagLabels(tr);
  const keyLabels = mappingKeyLabels(tr);

  const q = useQuery({
    queryKey: ledgerKeys.account(id),
    queryFn: async () => (await ledgerConfigApi.accounts.get(id)).data.data,
    enabled: !isNew,
  });
  // GET /tags بصلاحية canConfigureLedger (ملحق أ): للقارئ وحده تُعرض العلامات بعددها دون أسمائها
  const tagsQ = useQuery({ queryKey: ledgerKeys.tags, queryFn: async () => (await ledgerConfigApi.tags.list()).data.data, enabled: canWrite });
  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data, staleTime: 60_000 });
  const decimals = statusQ.data?.currencyDecimals ?? 2;
  const account = isNew ? null : q.data ?? null;

  const [form, setForm] = useState<FormState>(() => toForm(null));
  const base = useMemo(() => toForm(account), [account]);
  useEffect(() => { setForm(base); }, [base]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(s => ({ ...s, [k]: v }));
  const dirty = JSON.stringify(form) !== JSON.stringify(base);

  const readOnly = !canWrite;
  const codeLocked = !!account && (!!account.templateRef || !!account.hasMoves);
  const typeLocked = !!account && (!!account.controlKind || (account.isSystem && !!account.hasMoves));
  const reconcileLocked = account?.controlKind === 'AR';

  const issue = !/^\d{4,10}$/.test(form.code.trim()) ? tr('الرمز من 4 إلى 10 أرقام')
    : !form.name.trim() ? tr('الاسم مطلوب')
      : !hasArabicLetter(form.name) ? tr('الاسم يجب أن يحوي حرفاً عربياً والاسم بلغة أخرى مكانه الاسم الإنجليزي')
        : form.currencyCode && !/^[A-Z]{3}$/.test(form.currencyCode) ? tr('رمز العملة ثلاثة أحرف لاتينية')
          : null;

  const save = useMutation({
    mutationFn: async () => {
      const body: GlAccountInput = {
        code: form.code.trim(), name: form.name.trim(), nameEn: form.nameEn.trim() || null,
        description: form.description.trim() || null, type: form.type,
        reconcile: form.type === 'asset_cash' ? false : form.reconcile,
        cashFlowTag: form.cashFlowTag || null, currencyCode: form.currencyCode || null,
        ...(canWrite && tagsQ.isSuccess ? { tagIds: form.tagIds } : {}),
      };
      if (isNew) return (await ledgerConfigApi.accounts.create(body)).data.data;
      const patch: Partial<GlAccountInput> = { ...body };
      if (codeLocked || body.code === account?.code) delete patch.code;
      if (typeLocked || body.type === account?.type) delete patch.type;
      if (reconcileLocked) delete patch.reconcile;
      return (await ledgerConfigApi.accounts.update(id, patch)).data.data;
    },
    onSuccess: saved => {
      qc.invalidateQueries({ queryKey: ['ledger', 'accounts'] });
      qc.invalidateQueries({ queryKey: ledgerKeys.accountTree });
      qc.invalidateQueries({ queryKey: ledgerKeys.account(saved.id) });
      toast.success(tr('تم الحفظ'));
      if (isNew) navigate(ledgerHref(`config/accounts/${saved.id}`), { replace: true });
    },
    onError: e => toast.error(errorText(e)),
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) => ledgerConfigApi.accounts.archive(id, archived),
    onSuccess: (_r, archived) => {
      qc.invalidateQueries({ queryKey: ['ledger', 'accounts'] });
      qc.invalidateQueries({ queryKey: ledgerKeys.account(id) });
      toast.success(archived ? tr('تمت أرشفة الحساب') : tr('تمت استعادة الحساب'));
    },
    onError: e => toast.error(errorText(e)),
  });

  const gearItems: LedgerFormGearItem[] = account ? [
    account.isActive
      ? { label: tr('أرشفة'), perm: 'canConfigureLedger', danger: true, run: () => archive.mutate(true), confirm: tr('أرشفة هذا الحساب؟ لا يظهر في المنتقيات ويبقى في التقارير') }
      : { label: tr('استعادة'), perm: 'canConfigureLedger', run: () => archive.mutate(false) },
  ] : [];

  if (!isNew && q.isError) {
    return <div className="card max-w-xl text-sm text-[#8E2A1F]">{isLedgerAccessError(q.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('السجل غير موجود')}</div>;
  }

  const lockIcon = (title: string) => <span title={title} className="inline-flex ms-1 align-middle"><Lock size={11} className="text-[#9A8F7E]" /></span>;

  return (
    <LedgerForm
      breadcrumb={[{ label: tr('شجرة الحسابات'), to: ledgerHref('config/accounts') }, { label: isNew ? tr('جديد') : account ? `${account.code} ${ledgerName(account, lang)}` : '…' }]}
      recordPath={rid => ledgerHref(`config/accounts/${rid}`)}
      loading={!isNew && q.isLoading}
      dirty={dirty && !readOnly}
      saving={save.isPending}
      canSave={!readOnly && !issue}
      onSave={readOnly ? undefined : () => save.mutate()}
      onDiscard={() => (isNew ? navigate(ledgerHref('config/accounts')) : setForm(base))}
      gearItems={gearItems}
      audit={account ? { entityType: 'ACCOUNT', entityId: account.id } : undefined}
      banner={account && !account.isActive
        ? <div className="px-4 py-2 text-sm bg-[#F1EBDF] text-[#6E6557] border-b border-[#E8E0D2]">{tr('هذا الحساب مؤرشف')}</div>
        : undefined}
      headerActions={dirty && issue && !readOnly ? <span className="text-xs text-[#C0392B]">{issue}</span> : undefined}
    >
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-[10rem_1fr]">
          <Field label={tr('الرمز')} hint={codeLocked ? tr('لا يتغير رمز حساب من القالب أو له حركة') : undefined}>
            <input className="input font-mono tabular-nums text-lg" dir="ltr" inputMode="numeric" maxLength={10} value={form.code} disabled={codeLocked}
              onChange={e => set('code', e.target.value.replace(/[^\d]/g, ''))} placeholder="611099" />
          </Field>
          <Field label={tr('اسم الحساب')}>
            <input className="input text-lg font-semibold" value={form.name} maxLength={200} onChange={e => set('name', e.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label={tr('الاسم الإنجليزي')}>
            <input className="input" dir="ltr" value={form.nameEn} maxLength={200} onChange={e => set('nameEn', e.target.value)} />
          </Field>
          <Field label={tr('النوع')} hint={typeLocked ? (account?.controlKind ? tr('لا يتغير نوع حساب رئيسي') : tr('لا يتغير نوع حساب النظام بعد أول حركة')) : undefined}>
            <select className="input" value={form.type} disabled={typeLocked} onChange={e => set('type', e.target.value as AccountType)}>
              {ACCOUNT_TYPE_KEYS.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
            </select>
          </Field>
          <Field label={tr('التدفق النقدي')}>
            <select className="input" value={form.cashFlowTag} onChange={e => set('cashFlowTag', e.target.value as CashFlowTag | '')}>
              <option value="">{tr('تلقائي حسب النوع')}</option>
              {CASH_FLOW_TAGS.map(t => <option key={t} value={t}>{flowLabels[t]}</option>)}
            </select>
          </Field>
          <Field label={tr('عملة الحساب')} hint={tr('اتركها فارغة لعملة الدفاتر')}>
            <input className="input font-mono uppercase" dir="ltr" maxLength={3} value={form.currencyCode} onChange={e => set('currencyCode', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
          </Field>
        </div>

        {form.type !== 'asset_cash' && (
          <Toggle label={tr('يسمح بالتسوية')} hint={reconcileLocked ? tr('التسوية مقفلة لحساب ذمم العملاء الرئيسي') : tr('مطابقة الحركات المدينة بالدائنة على هذا الحساب')}
            checked={form.reconcile} disabled={readOnly || reconcileLocked} onChange={v => set('reconcile', v)} />
        )}

        {/* م‑5: وصف الحساب — متى يُستعمل ومثال عليه. يظهر عموداً في شجرة الحسابات وسطراً ثانياً في منتقي الحساب. */}
        <Field
          label={tr('الوصف')}
          hint={<>
            {tr('سطر يشرح متى يُستعمل هذا الحساب — يظهر في شجرة الحسابات وفي منتقي الحساب داخل القيد')}
            <span className="block mt-0.5 tabular-nums" aria-live="polite">
              <bdi dir="ltr">{form.description.length}/{DESCRIPTION_MAX}</bdi>
              {form.description.length >= DESCRIPTION_MAX && <span className="text-[#C0392B] ms-1">{tr('بلغت الحد الأقصى للوصف')}</span>}
            </span>
          </>}>
          <textarea className="input min-h-[4rem]" maxLength={DESCRIPTION_MAX} value={form.description}
            placeholder={tr('مثال: بنزين وسولار وزيوت سيارات التوزيع')}
            onChange={e => set('description', e.target.value)} />
        </Field>

        <div>
          <span className="label">{tr('العلامات')}</span>
          {canWrite ? (
            <div className="flex flex-wrap gap-1.5">
              {(tagsQ.data ?? []).length === 0 && <span className="text-xs text-[#9A8F7E]">{tr('لا توجد علامات')}</span>}
              {(tagsQ.data ?? []).map(t => {
                const on = form.tagIds.includes(t.id);
                return (
                  <button key={t.id} type="button" aria-pressed={on}
                    onClick={() => set('tagIds', on ? form.tagIds.filter(x => x !== t.id) : [...form.tagIds, t.id].sort())}
                    className={`px-2.5 py-1 rounded-full text-xs border ${on ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white border-[#E8E0D2] hover:bg-[#FBF7F0]'}`}>
                    {lang === 'ar' ? t.name : t.nameEn ?? t.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <span className="text-sm text-[#6E6557] tabular-nums">{(account?.tagIds ?? []).length}</span>
          )}
        </div>
      </fieldset>

      {account && (
        <dl className="grid gap-3 sm:grid-cols-3 text-sm border-t border-[#F1EBDF] pt-4">
          <div>
            <dt className="text-[11px] text-[#9A8F7E]">{tr('الرصيد المرحّل')}</dt>
            <dd className="text-base font-semibold"><LedgerAmount value={account.balance ?? 0} decimals={decimals} /></dd>
          </div>
          <div>
            <dt className="text-[11px] text-[#9A8F7E]">{tr('المصدر')}</dt>
            <dd>{account.templateRef ? <>{tr('من القالب')}{lockIcon(tr('لا يتغير رمز حساب من القالب أو له حركة'))}</> : tr('مخصص')}{account.isSystem ? ` · ${tr('حساب النظام')}` : ''}</dd>
          </div>
          <div>
            <dt className="text-[11px] text-[#9A8F7E]">{tr('مفاتيح الربط')}</dt>
            <dd>{account.mappingKeys?.length ? joinList(lang, account.mappingKeys.map(k => keyLabels[k] ?? k)) : '—'}</dd>
          </div>
        </dl>
      )}
    </LedgerForm>
  );
}
