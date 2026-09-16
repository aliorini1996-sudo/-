import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, X, RefreshCw, Save, RotateCcw, Globe2, Hourglass, Percent, Coins, ShoppingCart, Truck, BookKey, Boxes, BarChart3, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { activeLocale, formatDateTime, formatDayOnly } from '../../../utils/format';
import { ledgerName } from '../../../lib/ledger/format';
import { ledgerConfigReasonLabels, mappingKeyLabels } from '../../../lib/ledger/labels';
import {
  ledgerConfigApi, ledgerKeys, isLedgerAccessError, RECEIPT_METHODS,
  type GlSettings, type GlSettingsInput, type ReceiptMethod, type SeedReport, type TaxPeriodicity,
} from '../../../api/ledgerConfig';
import { ledgerHref } from '../routes';
import { AccountSelect, Field, Toggle, WriteButton, useAllAccounts, useConfigErrorText, useLedgerCan } from './parts/configUi';

/**
 * إعدادات الدفاتر (CFG‑01، §8.4) بأقسامها التسعة. في M2:
 * - «تحميل القالب/إعادة تحميله» يضيف الناقص فقط (TAX‑01)، والدولة والعملة لقطة للقراءة (TAX‑02).
 * - حالة الإعداد المبدئي للقراءة (المعالج والإيقاف المؤقت في M3)، وأسعار العملات في M13 معطّلة بتلميح.
 * - الأساس النقدي معطّل مع شرح التأجيل (TAX‑08)، وضريبة عمولة الدفع الإلكتروني للقراءة (يضبطها مالك المنصة).
 * - بعد التفعيل لا تتغير المنطقة الزمنية ونهاية السنة المالية ووضع المخزون وتاريخ بدء المستمر.
 * الحفظ يرسل الحقول المتغيّرة وحدها إلى `PUT /settings`، ومفاتيح الربط المعروضة هنا إلى `PUT /mappings`.
 */

type Key = keyof GlSettingsInput;
const FROZEN_AFTER_ACTIVATION: Key[] = ['timezone', 'fiscalYearEndMonth', 'fiscalYearEndDay', 'inventoryMode', 'perpetualFromDate'];
const PRODUCT_KEYS = ['SALES_REVENUE', 'COGS', 'PURCHASES'] as const;
const DEFERRAL_KEYS = ['DEFERRED_EXPENSE', 'DEFERRED_REVENUE'] as const;
const PERIODICITIES: TaxPeriodicity[] = ['MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'FOUR_MONTHS', 'SEMIANNUAL', 'ANNUAL', 'FISCAL_YEAR'];

function Section({ n, id, icon, title, children, note }: { n: number; id: string; icon: ReactNode; title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section id={id} className="card scroll-mt-20">
      <h2 className="flex items-center gap-2 text-base font-bold text-[#1F1A13] mb-3">
        <span className="w-7 h-7 rounded-lg bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center shrink-0">{icon}</span>
        <span className="text-[#9A8F7E] tabular-nums text-sm">{n}.</span>{title}
      </h2>
      {note && <p className="text-xs text-[#9A8F7E] -mt-1 mb-3 leading-relaxed">{note}</p>}
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function ReadRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="text-[#9A8F7E] min-w-[10rem]">{label}</span>
      <span className="text-[#1F1A13]">{children}</span>
    </div>
  );
}

export default function SettingsPage() {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const qc = useQueryClient();
  const errorText = useConfigErrorText();
  const canWrite = useLedgerCan('canConfigureLedger');
  const keyLabels = mappingKeyLabels(tr);

  const settingsQ = useQuery({ queryKey: ledgerKeys.settings, queryFn: async () => (await ledgerConfigApi.settings.get()).data.data });
  const statusQ = useQuery({ queryKey: ledgerKeys.status, queryFn: async () => (await ledgerConfigApi.status()).data.data });
  const seeded = !!settingsQ.data;
  const journalsQ = useQuery({ queryKey: ledgerKeys.journals, queryFn: async () => (await ledgerConfigApi.journals.list()).data.data, enabled: seeded });
  const taxesQ = useQuery({ queryKey: ledgerKeys.taxes, queryFn: async () => (await ledgerConfigApi.taxes.list()).data.data, enabled: seeded });
  const mappingsQ = useQuery({ queryKey: ledgerKeys.mappings, queryFn: async () => (await ledgerConfigApi.mappings.list()).data.data, enabled: seeded });
  const accountsQ = useAllAccounts(seeded);

  const s = settingsQ.data;
  const [draft, setDraft] = useState<GlSettingsInput>({});
  const [mapDraft, setMapDraft] = useState<Record<string, string>>({});
  useEffect(() => { setDraft({}); }, [s]);
  useEffect(() => { setMapDraft({}); }, [mappingsQ.data]);

  const activated = !!s?.activatedAt;
  const val = <K extends Key>(k: K): GlSettings[K & keyof GlSettings] => (k in draft ? draft[k] : s?.[k as keyof GlSettings]) as GlSettings[K & keyof GlSettings];
  const setVal = <K extends Key>(k: K, v: GlSettingsInput[K]) => setDraft(d => ({ ...d, [k]: v }));
  const frozen = (k: Key) => activated && FROZEN_AFTER_ACTIVATION.includes(k);
  const ro = !canWrite;

  const changedSettings = useMemo(() => {
    if (!s) return {} as GlSettingsInput;
    return Object.fromEntries(Object.entries(draft).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify((s as unknown as Record<string, unknown>)[k] ?? null))) as GlSettingsInput;
  }, [draft, s]);
  const mappingById = useMemo(() => new Map((mappingsQ.data ?? []).map(m => [m.key, m])), [mappingsQ.data]);
  const changedMappings = Object.entries(mapDraft).filter(([k, id]) => (mappingById.get(k)?.accountId ?? null) !== id);
  const dirty = Object.keys(changedSettings).length > 0 || changedMappings.length > 0;

  const issue = val('taxDeadlineRule') === 'DAYS_AFTER' && !(Number(val('taxDeadlineDays')) >= 1) ? tr('عدد أيام موعد الإقرار مطلوب') : null;

  const save = useMutation({
    mutationFn: async () => {
      if (Object.keys(changedSettings).length) {
        const body = { ...changedSettings };
        if (body.taxDeadlineRule === 'END_OF_NEXT_MONTH') delete body.taxDeadlineDays;
        await ledgerConfigApi.settings.update(body);
      }
      if (changedMappings.length) await ledgerConfigApi.mappings.update(changedMappings.map(([key, accountId]) => ({ key, accountId })));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ledgerKeys.settings });
      qc.invalidateQueries({ queryKey: ledgerKeys.status });
      qc.invalidateQueries({ queryKey: ledgerKeys.mappings });
      toast.success(tr('تم حفظ الإعدادات'));
    },
    onError: e => { toast.error(errorText(e)); qc.invalidateQueries({ queryKey: ledgerKeys.settings }); },
  });

  const [seedReport, setSeedReport] = useState<SeedReport | null>(null);
  const loadTemplate = useMutation({
    mutationFn: async () => (await ledgerConfigApi.settings.loadTemplate()).data.data,
    onSuccess: d => {
      qc.invalidateQueries({ queryKey: ledgerKeys.all });
      setSeedReport(d.report);
      const c = d.report.created;
      const total = c.accounts + c.journals + c.taxes + c.mappings + c.tags;
      toast.success(total === 0 ? tr('القالب محمّل بالكامل ولا ناقص') : `${tr('تم تحميل القالب')}: ${c.accounts} ${tr('حساب')} · ${c.journals} ${tr('دفتر')} · ${c.taxes} ${tr('ضريبة')} · ${c.mappings} ${tr('ربط')}`, { duration: 6000 });
    },
    onError: e => toast.error(errorText(e)),
  });

  // ═══ تسميات ═══
  const months = useMemo(() => {
    const f = new Intl.DateTimeFormat(activeLocale(), { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2001, i, 1))));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(activeLocale(), { weekday: 'long', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2023, 0, 1 + i)))); // 2023-01-01 أحد
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const timezones = useMemo(() => {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    try { return sv ? sv('timeZone') : []; } catch { return []; }
  }, []);
  const periodicityLabels: Record<TaxPeriodicity, string> = {
    MONTHLY: tr('شهري'), BIMONTHLY: tr('كل شهرين'), QUARTERLY: tr('ربع سنوي'), FOUR_MONTHS: tr('كل أربعة أشهر'),
    SEMIANNUAL: tr('نصف سنوي'), ANNUAL: tr('سنوي'), FISCAL_YEAR: tr('حسب السنة المالية'),
  };
  const receiptLabels: Record<ReceiptMethod, string> = { CASH: tr('نقدي'), BANK_TRANSFER: tr('تحويل بنكي'), POS: tr('شبكة (نقاط البيع)'), CHEQUE: tr('شيك') };
  const backfillLabels: Record<string, string> = { NONE: tr('لم يبدأ'), RUNNING: tr('جار'), DONE: tr('مكتمل'), PAUSED: tr('موقوف مؤقتا') };
  const setupLabels: Record<string, string> = { OPENING: tr('أرصدة افتتاحية'), FULL_HISTORY: tr('ترحيل التاريخ الكامل') };
  const frozenHint = tr('لا يتغير بعد تفعيل الدفاتر');

  if (settingsQ.isLoading) return <p className="text-sm text-[#9A8F7E] py-10 text-center">{tr('جاري التحميل...')}</p>;
  if (settingsQ.isError) {
    return <div className="card max-w-xl text-sm text-[#8E2A1F]">{isLedgerAccessError(settingsQ.error) ? tr('لا تملك صلاحية الوصول لهذا القسم') : tr('تعذر تحميل البيانات')}</div>;
  }

  const journals = (journalsQ.data ?? []).filter(j => j.isActive || j.id === val('taxClosingJournalId') || j.id === val('deferralJournalId'));
  const taxes = taxesQ.data ?? [];
  const accounts = accountsQ.data ?? [];
  const mapValue = (k: string) => mapDraft[k] ?? mappingById.get(k)?.accountId ?? null;
  const mapPicker = (k: string, hint?: string) => {
    const m = mappingById.get(k);
    return (
      <Field key={k} label={keyLabels[k] ?? k} hint={hint ?? <bdi dir="ltr" className="font-mono">{k}</bdi>}>
        <AccountSelect accounts={accounts} value={mapValue(k)} disabled={ro} types={m?.allowedTypes} controlKind={m?.controlKind ?? null}
          placeholder={tr('غير مربوط')} onChange={id => id && setMapDraft(d => ({ ...d, [k]: id }))} />
      </Field>
    );
  };
  const receiptRouting = (val('receiptRouting') ?? {}) as Partial<Record<ReceiptMethod, 'CUSTODY' | 'DIRECT'>>;

  const nav: [string, string][] = [
    ['fiscal-localization', tr('الأقلمة المالية')], ['initial-setup', tr('الإعداد المبدئي')], ['taxes', tr('الضرائب')],
    ['currencies', tr('العملات')], ['sales', tr('المبيعات والتحصيل')], ['vendors', tr('فواتير الموردين والمدفوعات')],
    ['default-accounts', tr('الحسابات الافتراضية')], ['inventory', tr('تقييم المخزون')], ['reports', tr('التقارير')],
  ];

  return (
    <div className="space-y-4 pb-10">
      <div className="sticky top-0 z-20 -mx-1 px-1 py-2 bg-[#FBF7F0]/95 backdrop-blur flex flex-wrap items-center gap-2" style={{ top: 'env(safe-area-inset-top, 0px)' }}>
        <h1 className="text-lg font-bold text-[#1F1A13] flex-1">{tr('الإعدادات')}</h1>
        {dirty && <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={() => { setDraft({}); setMapDraft({}); }}><RotateCcw size={14} />{tr('إهمال التعديلات')}</button>}
        {seeded && (
          <WriteButton allowed={canWrite} onClick={() => save.mutate()} busy={save.isPending} disabled={!dirty} reason={dirty ? issue : null} className="btn-primary inline-flex items-center gap-1.5">
            <Save size={14} />{tr('حفظ')}
          </WriteButton>
        )}
      </div>

      {seeded && (
        <nav className="flex flex-wrap gap-1.5 text-xs" aria-label={tr('أقسام الإعدادات')}>
          {nav.map(([id, label]) => <a key={id} href={`#${id}`} className="px-2.5 py-1 rounded-full bg-white border border-[#E8E0D2] hover:border-[#E15A30]">{label}</a>)}
        </nav>
      )}

      {/* 1. الأقلمة المالية */}
      <Section n={1} id="fiscal-localization" icon={<Globe2 size={15} />} title={tr('الأقلمة المالية')}
        note={tr('إعادة تحميل القالب تضيف الحسابات والدفاتر والضرائب والربط الناقصة فقط ولا تمس ما عدّلته')}>
        {s ? (
          <>
            <ReadRow label={tr('القالب')}><bdi dir="ltr" className="font-mono">{s.templateKey}</bdi> · {s.templateKey === 'SA_6D' ? tr('القالب السعودي') : tr('القالب العام')}</ReadRow>
            <ReadRow label={tr('الدولة المالية')}><bdi dir="ltr" className="font-mono">{s.countryCode}</bdi> <span className="text-[11px] text-[#9A8F7E]">({tr('لقطة عند الإعداد، للقراءة فقط')})</span></ReadRow>
          </>
        ) : (
          <p className="text-sm text-[#6E6557]">{tr('لم يُحمّل القالب المحاسبي بعد. التحميل ينشئ شجرة الحسابات والدفاتر والضرائب ومفاتيح الربط حسب دولة شركتك')}</p>
        )}
        <WriteButton allowed={canWrite} onClick={() => loadTemplate.mutate()} busy={loadTemplate.isPending} className={`${s ? 'btn-secondary' : 'btn-primary'} inline-flex items-center gap-1.5`}>
          <RefreshCw size={14} className={loadTemplate.isPending ? 'animate-spin' : ''} />{s ? tr('إعادة تحميل القالب') : tr('تحميل القالب')}
        </WriteButton>
        {seedReport && <SeedReportPanel report={seedReport} onClose={() => setSeedReport(null)} />}
      </Section>

      {s && (
        <>
          {/* 2. الإعداد المبدئي */}
          <Section n={2} id="initial-setup" icon={<Hourglass size={15} />} title={tr('الإعداد المبدئي')}>
            <ReadRow label={tr('الحالة')}>{activated ? `${tr('مفعّلة منذ')} ${formatDateTime(s.activatedAt!)}` : tr('بانتظار الإعداد')}</ReadRow>
            {s.setupMethod && <ReadRow label={tr('طريقة البدء')}>{setupLabels[s.setupMethod] ?? s.setupMethod}</ReadRow>}
            {s.cutoverDate && <ReadRow label={tr('تاريخ البدء')}>{formatDayOnly(s.cutoverDate)}</ReadRow>}
            <ReadRow label={tr('الترحيل التاريخي')}>{backfillLabels[s.backfillState] ?? s.backfillState}</ReadRow>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary opacity-50 cursor-not-allowed" disabled title={tr('يتاح مع معالج الإعداد المبدئي')}>{tr('معالج الإعداد')}</button>
              <button type="button" className="btn-secondary opacity-50 cursor-not-allowed" disabled title={tr('يتاح مع معالج الإعداد المبدئي')}>{tr('إيقاف مؤقت')}</button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3 pt-2">
              <Field label={tr('المنطقة الزمنية')} hint={frozen('timezone') ? frozenHint : undefined}>
                {timezones.length ? (
                  <select className="input" dir="ltr" value={val('timezone')} disabled={ro || frozen('timezone')} onChange={e => setVal('timezone', e.target.value)}>
                    {!timezones.includes(val('timezone')) && <option value={val('timezone')}>{val('timezone')}</option>}
                    {timezones.map(z => <option key={z} value={z}>{z}</option>)}
                  </select>
                ) : (
                  <input className="input" dir="ltr" value={val('timezone')} disabled={ro || frozen('timezone')} onChange={e => setVal('timezone', e.target.value)} />
                )}
              </Field>
              <Field label={tr('نهاية السنة المالية: الشهر')} hint={frozen('fiscalYearEndMonth') ? frozenHint : undefined}>
                <select className="input" value={val('fiscalYearEndMonth')} disabled={ro || frozen('fiscalYearEndMonth')}
                  onChange={e => { const m = Number(e.target.value); const max = new Date(Date.UTC(2001, m, 0)).getUTCDate(); setDraft(d => ({ ...d, fiscalYearEndMonth: m, fiscalYearEndDay: Math.min(Number(val('fiscalYearEndDay')), max) })); }}>
                  {months.map((name, i) => <option key={i} value={i + 1}>{name}</option>)}
                </select>
              </Field>
              <Field label={tr('نهاية السنة المالية: اليوم')}>
                <select className="input" value={val('fiscalYearEndDay')} disabled={ro || frozen('fiscalYearEndDay')} onChange={e => setVal('fiscalYearEndDay', Number(e.target.value))}>
                  {Array.from({ length: new Date(Date.UTC(2001, Number(val('fiscalYearEndMonth')), 0)).getUTCDate() }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
                </select>
              </Field>
            </div>
            <Link to={ledgerHref('config/fiscal-years')} className="text-xs text-[#E15A30] hover:underline">{tr('السنوات المالية')} ←</Link>
          </Section>

          {/* 3. الضرائب */}
          <Section n={3} id="taxes" icon={<Percent size={15} />} title={tr('الضرائب')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={tr('دورية الإقرار')}>
                <select className="input" value={val('taxPeriodicity')} disabled={ro} onChange={e => setVal('taxPeriodicity', e.target.value as TaxPeriodicity)}>
                  {PERIODICITIES.map(p => <option key={p} value={p}>{periodicityLabels[p]}</option>)}
                </select>
              </Field>
              <Field label={tr('موعد تقديم الإقرار')}>
                <div className="flex gap-2">
                  <select className="input flex-1" value={val('taxDeadlineRule')} disabled={ro}
                    onChange={e => { const r = e.target.value as 'END_OF_NEXT_MONTH' | 'DAYS_AFTER'; setDraft(d => ({ ...d, taxDeadlineRule: r, taxDeadlineDays: r === 'DAYS_AFTER' ? (val('taxDeadlineDays') ?? 30) : null })); }}>
                    <option value="END_OF_NEXT_MONTH">{tr('آخر الشهر التالي لنهاية الفترة')}</option>
                    <option value="DAYS_AFTER">{tr('عدد أيام بعد نهاية الفترة')}</option>
                  </select>
                  {val('taxDeadlineRule') === 'DAYS_AFTER' && (
                    <input type="number" min={1} max={365} className="input w-24 tabular-nums" dir="ltr" disabled={ro}
                      value={val('taxDeadlineDays') ?? ''} onChange={e => setVal('taxDeadlineDays', e.target.value === '' ? null : Number(e.target.value))} />
                  )}
                </div>
              </Field>
              <Field label={tr('دفتر إقفال الضريبة')}>
                <select className="input" value={val('taxClosingJournalId') ?? ''} disabled={ro} onChange={e => setVal('taxClosingJournalId', e.target.value || null)}>
                  <option value="">{tr('بلا دفتر')}</option>
                  {journals.map(j => <option key={j.id} value={j.id}>{j.code} · {ledgerName(j, lang)}</option>)}
                </select>
              </Field>
              <Field label={tr('ضريبة الشراء الافتراضية')} hint={tr('تُقترح على بنود فواتير الموردين والمصروفات حين لا يحمل المورد ضريبة')}>
                <select className="input" value={val('defaultPurchaseTaxId') ?? ''} disabled={ro} onChange={e => setVal('defaultPurchaseTaxId', e.target.value || null)}>
                  <option value="">{tr('بلا ضريبة')}</option>
                  {taxes.filter(t => t.use === 'PURCHASE' && (t.isActive || t.id === val('defaultPurchaseTaxId'))).map(t => <option key={t.id} value={t.id}>{ledgerName(t, lang)}</option>)}
                </select>
              </Field>
              <Field label={tr('أسعار فواتير الموردين')}>
                <select className="input" value={val('billPricesIncludeTax') ? '1' : '0'} disabled={ro} onChange={e => setVal('billPricesIncludeTax', e.target.value === '1')}>
                  <option value="0">{tr('غير شاملة الضريبة')}</option>
                  <option value="1">{tr('شاملة الضريبة')}</option>
                </select>
              </Field>
              <Field label={tr('طريقة التقريب')} hint={tr('تسري على فواتير الموردين والقيود اليدوية فقط، ومحرك المبيعات لا يتغير')}>
                <select className="input" value={val('taxRoundingMethod')} disabled={ro} onChange={e => setVal('taxRoundingMethod', e.target.value as 'PER_TAX' | 'PER_LINE')}>
                  <option value="PER_TAX">{tr('تقريب إجمالي كل ضريبة')}</option>
                  <option value="PER_LINE">{tr('تقريب كل بند')}</option>
                </select>
              </Field>
              <Field label={tr('ربط النسبة الصفرية')} hint={tr('ضريبة المبيعات التي تُربط بها بنود الفواتير بنسبة صفر')}>
                <select className="input" value={val('zeroRatedSalesTaxKey') ?? ''} disabled={ro} onChange={e => setVal('zeroRatedSalesTaxKey', e.target.value || null)}>
                  <option value="">{tr('بلا ضريبة')}</option>
                  {taxes.filter(t => t.use === 'SALE' && t.rate === 0 && t.key && (t.isActive || t.key === val('zeroRatedSalesTaxKey'))).map(t => <option key={t.id} value={t.key!}>{ledgerName(t, lang)}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Toggle label={tr('خصم الدفع المبكر يخفض ضريبة المدخلات')} checked={!!val('earlyDiscountAdjustsVat')} disabled={ro} onChange={v => setVal('earlyDiscountAdjustsVat', v)} />
              <Toggle label={tr('الضرائب على الأساس النقدي')} checked={false} disabled onChange={() => undefined}
                hint={tr('مؤجّلة: ضريبة القيمة المضافة في المملكة على أساس الاستحقاق، والأساس النقدي استثناء بموافقة')} />
            </div>
            <Link to={ledgerHref('config/taxes')} className="text-xs text-[#E15A30] hover:underline">{tr('الضرائب')} ←</Link>
          </Section>

          {/* 4. العملات */}
          <Section n={4} id="currencies" icon={<Coins size={15} />} title={tr('العملات')}>
            <ReadRow label={tr('عملة الدفاتر')}>
              <bdi dir="ltr" className="font-mono">{s.currency}</bdi> · {s.currencyDecimals} {tr('منازل عشرية')}
              <span className="inline-flex ms-1 align-middle" title={tr('مجمدة عند الإعداد')}><Lock size={11} className="text-[#9A8F7E]" /></span>
            </ReadRow>
            <button type="button" className="btn-secondary opacity-50 cursor-not-allowed" disabled title={tr('أسعار الصرف تصل لاحقا')}>{tr('أسعار الصرف')}</button>
          </Section>

          {/* 5. المبيعات والتحصيل */}
          <Section n={5} id="sales" icon={<ShoppingCart size={15} />} title={tr('المبيعات والتحصيل')}>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Toggle label={tr('ترحيل خصم المبيعات في حساب مستقل')} hint={tr('يُرحَّل الخصم إلى حساب الخصم المسموح به بدل تخفيض الإيراد')}
                checked={!!val('postSalesDiscountSeparately')} disabled={ro} onChange={v => setVal('postSalesDiscountSeparately', v)} />
              <Toggle label={tr('ترحيل المرتجعات في حساب مستقل')} hint={tr('يُرحَّل المرتجع إلى مردودات المبيعات بدل تخفيض الإيراد')}
                checked={!!val('postReturnsToContra')} disabled={ro} onChange={v => setVal('postReturnsToContra', v)} />
            </div>
            <div>
              <span className="label">{tr('مسار كل طريقة قبض')}</span>
              <div className="grid gap-2 sm:grid-cols-2">
                {RECEIPT_METHODS.map(m => (
                  <div key={m} className="flex items-center gap-2">
                    <span className="text-sm min-w-[8rem]">{receiptLabels[m]}</span>
                    <select className="input flex-1" value={receiptRouting[m] ?? 'CUSTODY'} disabled={ro}
                      onChange={e => setVal('receiptRouting', { ...receiptRouting, [m]: e.target.value as 'CUSTODY' | 'DIRECT' })}>
                      <option value="CUSTODY">{tr('عهدة المندوب')}</option>
                      <option value="DIRECT">{tr('الحساب مباشرة')}</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>
            <ReadRow label={tr('ضريبة عمولة الدفع الإلكتروني')}>
              {s.paylinkFeeTaxInvoiceFrom ? `${tr('مستردة من')} ${formatDayOnly(s.paylinkFeeTaxInvoiceFrom)}` : tr('غير مستردة')}
              <span className="block text-[11px] text-[#9A8F7E]">{tr('يضبطه مزود الخدمة عند بدء إصدار الفاتورة الضريبية بالعمولة')}</span>
            </ReadRow>
          </Section>

          {/* 6. فواتير الموردين والمدفوعات */}
          <Section n={6} id="vendors" icon={<Truck size={15} />} title={tr('فواتير الموردين والمدفوعات')}>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Toggle label={tr('التصديق الآلي لفواتير الموردين')} checked={!!val('autoValidateBills')} disabled={ro} onChange={v => setVal('autoValidateBills', v)} />
              <Toggle label={tr('توقّع بنود فاتورة المورد')} hint={tr('يقترح الصنف والحساب والضريبة من فواتير المورد السابقة')}
                checked={!!val('billPredictionEnabled')} disabled={ro} onChange={v => setVal('billPredictionEnabled', v)} />
              <Toggle label={tr('ترحيل خصم بنود المشتريات في حساب مستقل')} checked={!!val('postPurchaseDiscountSeparately')} disabled={ro} onChange={v => setVal('postPurchaseDiscountSeparately', v)} />
              <Toggle label={tr('الدفعات المجمعة')} checked={!!val('batchPaymentsEnabled')} disabled title={tr('يتاح مع وحدة البنك')}
                hint={tr('يتاح مع وحدة البنك')} onChange={() => undefined} />
            </div>
          </Section>

          {/* 7. الحسابات الافتراضية */}
          <Section n={7} id="default-accounts" icon={<BookKey size={15} />} title={tr('الحسابات الافتراضية')}>
            <div className="rounded-xl border border-[#F1EBDF] p-3 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-bold flex-1">{tr('حسابات المنتج الافتراضية')}</h3>
                <span className="text-xs text-[#B8AE9C] cursor-not-allowed" title={tr('يتاح مع معالج الإعداد المبدئي')}>{tr('تخصيص لكل فئة منتجات')}</span>
              </div>
              <p className="text-[11px] text-[#9A8F7E]">{tr('تُستعمل لكل فئة منتجات بلا حسابات مخصصة، ويسري التعديل على الأحداث الجديدة فقط')}</p>
              <div className="grid gap-3 sm:grid-cols-3">{PRODUCT_KEYS.map(k => mapPicker(k))}</div>
            </div>
            <div className="rounded-xl border border-[#F1EBDF] p-3 space-y-3">
              <h3 className="text-sm font-bold">{tr('المؤجلات')}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={tr('دفتر المؤجلات')}>
                  <select className="input" value={val('deferralJournalId') ?? ''} disabled={ro} onChange={e => setVal('deferralJournalId', e.target.value || null)}>
                    <option value="">{tr('بلا دفتر')}</option>
                    {journals.map(j => <option key={j.id} value={j.id}>{j.code} · {ledgerName(j, lang)}</option>)}
                  </select>
                </Field>
                {DEFERRAL_KEYS.map(k => mapPicker(k))}
                <Field label={tr('إنشاء القيود')} hint={tr('الإيرادات المؤجلة تُنشأ يدويا دائما')}>
                  <select className="input" value={val('deferralGenerate')} disabled={ro} onChange={e => setVal('deferralGenerate', e.target.value as 'ON_VALIDATION' | 'MANUAL')}>
                    <option value="ON_VALIDATION">{tr('عند ترحيل الفاتورة')}</option>
                    <option value="MANUAL">{tr('يدويا')}</option>
                  </select>
                </Field>
                <Field label={tr('طريقة الاحتساب')}>
                  <select className="input" value={val('deferralMethod')} disabled={ro} onChange={e => setVal('deferralMethod', e.target.value as 'BY_MONTHS' | 'BY_DAYS')}>
                    <option value="BY_MONTHS">{tr('بالأشهر')}</option>
                    <option value="BY_DAYS">{tr('بالأيام')}</option>
                  </select>
                </Field>
                <ReadRow label={tr('الوتيرة')}>{tr('شهري')}</ReadRow>
              </div>
            </div>
            <Link to={ledgerHref('config/mappings')} className="text-xs text-[#E15A30] hover:underline">{tr('كل مفاتيح الربط')} ←</Link>
          </Section>

          {/* 8. تقييم المخزون */}
          <Section n={8} id="inventory" icon={<Boxes size={15} />} title={tr('تقييم المخزون')}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={tr('طريقة الجرد')} hint={frozen('inventoryMode') ? frozenHint : undefined}>
                <select className="input" value={val('inventoryMode')} disabled={ro || frozen('inventoryMode')}
                  onChange={e => setDraft(d => ({ ...d, inventoryMode: e.target.value as 'PERIODIC' | 'PERPETUAL', ...(e.target.value === 'PERIODIC' ? { perpetualFromDate: null } : {}) }))}>
                  <option value="PERIODIC">{tr('جرد دوري')}</option>
                  <option value="PERPETUAL">{tr('جرد مستمر')}</option>
                </select>
              </Field>
              {val('inventoryMode') === 'PERPETUAL' && (
                <Field label={tr('تاريخ بدء الجرد المستمر')} hint={frozen('perpetualFromDate') ? frozenHint : undefined}>
                  <input type="date" className="input" value={val('perpetualFromDate') ?? ''} disabled={ro || frozen('perpetualFromDate')} onChange={e => setVal('perpetualFromDate', e.target.value || null)} />
                </Field>
              )}
              <ReadRow label={tr('طريقة التكلفة')}>{tr('متوسط متحرك (محرك المستودع)')}</ReadRow>
            </div>
          </Section>

          {/* 9. التقارير */}
          <Section n={9} id="reports" icon={<BarChart3 size={15} />} title={tr('التقارير')}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={tr('بداية الأسبوع')}>
                <select className="input" value={val('weekStartsOn')} disabled={ro} onChange={e => setVal('weekStartsOn', Number(e.target.value))}>
                  {weekdays.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Toggle label={tr('المسحوبات بعد صافي الربح')} hint={tr('تُعرض مسحوبات الملاك في قائمة الدخل بعد صافي الربح')}
                checked={!!val('drawingsAfterNetProfit')} disabled={ro} onChange={v => setVal('drawingsAfterNetProfit', v)} />
              <Toggle label={tr('الإهلاك ضمن المصروفات التشغيلية')} hint={tr('الافتراضي: الإهلاك في المصروفات الأخرى')}
                checked={!!val('depreciationInOperatingExpenses')} disabled={ro} onChange={v => setVal('depreciationInOperatingExpenses', v)} />
            </div>
          </Section>
        </>
      )}
      {statusQ.data?.lastSyncAt && <p className="text-[11px] text-[#9A8F7E] text-center">{tr('آخر مزامنة')}: {formatDateTime(statusQ.data.lastSyncAt)}</p>}
    </div>
  );
}

/** ما لم يُنشأ عند زرع القالب ويحتاج إصلاحاً يدوياً: مفاتيح بلا حساب، ومفاتيح وحسابات ضرائب ودفاتر تخالف نوع حساب قائم. */
function SeedReportPanel({ report, onClose }: { report: SeedReport; onClose: () => void }) {
  const tr = useTr();
  const keyLabels = mappingKeyLabels(tr);
  const reasons = ledgerConfigReasonLabels(tr);
  const unresolved = report.unresolvedMappings ?? [];
  const mappings = report.conflictingMappings ?? [];
  const refs = report.conflictingAccountRefs ?? [];
  if (unresolved.length + mappings.length + refs.length === 0) return null;
  const fieldLabels: Record<string, string> = {
    accountId: tr('حساب الضريبة'),
    rcOutputAccountId: tr('حساب ضريبة المخرجات للاحتساب العكسي'),
    defaultAccountId: tr('الحساب الافتراضي'),
    suspenseAccountId: tr('الحساب المعلّق'),
  };
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2" role="status">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-600" />
        <p className="flex-1 font-semibold">{tr('بعض عناصر القالب لم تُربط وتحتاج مراجعتك')}</p>
        <button type="button" aria-label={tr('إغلاق')} className="p-0.5 rounded hover:bg-amber-100" onClick={onClose}><X size={14} /></button>
      </div>
      {unresolved.length > 0 && (
        <div>
          <p className="text-xs font-semibold">{tr('مفاتيح ربط لم يُعثر على حسابها')}</p>
          <ul className="list-disc ps-5 text-xs">{unresolved.map(k => <li key={k}>{keyLabels[k] ?? k}</li>)}</ul>
        </div>
      )}
      {mappings.length > 0 && (
        <div>
          <p className="text-xs font-semibold">{tr('مفاتيح ربط لم تُنشأ لأن الحساب القائم برمز القالب لا يوافقها')}</p>
          <ul className="list-disc ps-5 text-xs">
            {mappings.map(c => <li key={c.key}>{keyLabels[c.key] ?? c.key} — <bdi dir="ltr" className="font-mono">{c.code}</bdi> · {reasons[c.reason] ?? c.reason}</li>)}
          </ul>
        </div>
      )}
      {refs.length > 0 && (
        <div>
          <p className="text-xs font-semibold">{tr('حسابات ضرائب ودفاتر تُركت فارغة لأن الحساب القائم برمز القالب يخالف نوع حساب القالب')}</p>
          <ul className="list-disc ps-5 text-xs">
            {refs.map(c => (
              <li key={`${c.entity}:${c.ref}:${c.field}`}>
                {c.entity === 'TAX' ? tr('الضريبة') : tr('الدفتر')} <bdi dir="ltr" className="font-mono">{c.ref}</bdi> · {fieldLabels[c.field] ?? c.field} — <bdi dir="ltr" className="font-mono">{c.code}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs">{tr('أصلح الحساب أو الربط ثم أعد تحميل القالب')}</p>
    </div>
  );
}
