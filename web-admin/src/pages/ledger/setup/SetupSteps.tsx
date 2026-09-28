import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Lock, Sparkles } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { useLang } from '../../../i18n/lang';
import { activeLocale, formatDayOnly } from '../../../utils/format';
import { ledgerName } from '../../../lib/ledger/format';
import { RECEIPT_METHODS, type GlAccount, type ReceiptMethod, type TaxPeriodicity } from '../../../api/ledgerConfig';
import {
  ledgerSetupApi, ledgerSetupKeys,
  type ReceiptRouteTarget, type SetupDraft, type SetupStateBefore,
} from '../../../api/ledgerSetup';
import { ledgerHref } from '../routes';
import { AccountSelect, Field, hasArabicLetter, useAllAccounts } from '../config/parts/configUi';
import {
  compactBoxes, daysInMonth, initialStep1, keepLiveCategoryLinks, needsMidPeriodConfirm,
  PRE_CUTOVER_BOX_NOS, preCutoverBoxKey,
} from './setupLogic';
import { Notice, StepSection } from './setupUi';

/**
 * خطوتا المعالج الأوليان (§5.6): الأساس، والشجرة (الأسماء وفئات المنتجات ومسار كل طريقة قبض). خطوة «طريقة البدء»
 * أُزيلت بقرار الخبير المحاسبي: كل تفعيل بداية نظيفة من يومه، فلا يختار المستخدم طريقة ولا تاريخ بدء.
 * كل خطوة تُحفظ مسودة عبر `onSave(patch, nextStep)` في SetupWizard (POST /setup/draft).
 */

export interface StepProps {
  state: SetupStateBefore;
  canWrite: boolean;
  busy: boolean;
  /** يحفظ القسم ثم ينتقل إلى الخطوة التالية */
  onSave: (patch: SetupDraft, next: number) => void;
  onBack?: () => void;
  /** آخر خطأ حفظ (رمز وتفاصيل) لعرض ما يلزم داخل الخطوة */
  lastErrorCode?: string | null;
}

const PERIODICITIES: TaxPeriodicity[] = ['MONTHLY', 'QUARTERLY', 'BIMONTHLY', 'FOUR_MONTHS', 'SEMIANNUAL', 'ANNUAL', 'FISCAL_YEAR'];

export function StepFooter({ onBack, onNext, busy, disabledReason, nextLabel, canWrite }: {
  onBack?: () => void; onNext: () => void; busy: boolean; disabledReason?: string | null; nextLabel?: string; canWrite: boolean;
}) {
  const tr = useTr();
  const reason = !canWrite ? tr('لا تملك صلاحية التعديل') : disabledReason ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-[#F1EBDF]">
      {onBack && (
        <button type="button" className="btn-secondary inline-flex items-center gap-1.5" onClick={onBack} disabled={busy}>
          <ArrowRight size={14} className="rtl:rotate-0 ltr:rotate-180" />{tr('السابق')}
        </button>
      )}
      <span className="flex-1" />
      {reason && <span className="text-[11px] text-[#9A8F7E]">{reason}</span>}
      <button type="button" className="btn-primary inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
        onClick={onNext} disabled={busy || !!reason}>
        {nextLabel ?? tr('حفظ ومتابعة')}<ArrowLeft size={14} className="rtl:rotate-0 ltr:rotate-180" />
      </button>
    </div>
  );
}

function ReadRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
      <span className="text-[#9A8F7E] min-w-[9rem]">{label}</span>
      <span className="text-[#1F1A13]">{children}</span>
    </div>
  );
}

export function usePeriodicityLabels(): Record<TaxPeriodicity, string> {
  const tr = useTr();
  return {
    MONTHLY: tr('شهري'), BIMONTHLY: tr('كل شهرين'), QUARTERLY: tr('ربع سنوي'), FOUR_MONTHS: tr('كل أربعة أشهر'),
    SEMIANNUAL: tr('نصف سنوي'), ANNUAL: tr('سنوي'), FISCAL_YEAR: tr('حسب السنة المالية'),
  };
}

export function useBoxLabels(): Record<number, string> {
  const tr = useTr();
  return {
    1: tr('المبيعات الخاضعة للنسبة الأساسية'),
    2: tr('مبيعات المواطنين (صحة وتعليم خاص)'),
    3: tr('المبيعات المحلية الصفرية'),
    4: tr('الصادرات'),
    5: tr('المبيعات المعفاة'),
    7: tr('المشتريات الخاضعة للنسبة الأساسية'),
    8: tr('الاستيراد الخاضع المدفوع للجمارك'),
    9: tr('الاستيراد الخاضع للاحتساب العكسي'),
    10: tr('المشتريات الصفرية'),
    11: tr('المشتريات المعفاة'),
  };
}

// ═══ الخطوة 1: الأساس ═══

export function Step1Basics({ state, canWrite, busy, onSave, lastErrorCode }: StepProps) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const periodicityLabels = usePeriodicityLabels();
  const boxLabels = useBoxLabels();
  const init = useMemo(() => initialStep1(state.draft, state.effective, state.suggestedCutoverDate), [state.draft, state.effective, state.suggestedCutoverDate]);
  const [v, setV] = useState(init);
  const [boxes, setBoxes] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(init.preCutoverBoxes ?? {}).map(([k, x]) => [k, String(x)])));
  // لا مزامنة مع إعادة جلب الحالة (تركيز النافذة) كي لا تُمحى تعديلات غير محفوظة؛ SetupWizard يعيد التركيب بعد الحفظ

  const months = useMemo(() => {
    const f = new Intl.DateTimeFormat(activeLocale(), { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2001, i, 1))));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekdays = useMemo(() => {
    const f = new Intl.DateTimeFormat(activeLocale(), { weekday: 'long', timeZone: 'UTC' });
    return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2023, 0, 1 + i))));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const timezones = useMemo(() => {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    try { return sv ? sv('timeZone') : []; } catch { return []; }
  }, []);

  const tpl = state.effective.templateKey;
  // البداية النظيفة: تاريخ البدء يوم التفعيل نفسه (الخادم يحسبه بساعته عند الاعتماد) — المعروض «اليوم» بتوقيت الشركة
  const cutoverDate = state.today;
  const mid = needsMidPeriodConfirm(tpl, cutoverDate, v.taxPeriodicity, v.fiscalYearEndMonth, v.fiscalYearEndDay) || lastErrorCode === 'LEDGER_CUTOVER_MID_VAT_PERIOD';
  const packed = compactBoxes(boxes);
  const disabledReason = mid && !v.confirmMidVatPeriod ? tr('أكّد تاريخ البدء داخل فترة الإقرار')
    : mid && !packed ? tr('أدخل مبالغ المربعات قبل البدء')
      : null;

  const save = () => onSave({
    step1: {
      timezone: v.timezone, fiscalYearEndMonth: v.fiscalYearEndMonth, fiscalYearEndDay: v.fiscalYearEndDay, weekStartsOn: v.weekStartsOn,
      taxPeriodicity: v.taxPeriodicity, cutoverDate,
      confirmMidVatPeriod: mid ? v.confirmMidVatPeriod : false,
      preCutoverBoxes: mid ? packed : null,
    },
  }, 3); // خطوة «طريقة البدء» (2) أُزيلت: كل تفعيل بداية نظيفة

  const ro = !canWrite;
  return (
    <div className="space-y-4">
      <StepSection title={tr('الأقلمة المالية')}>
        <ReadRow label={tr('القالب')}><bdi dir="ltr" className="font-mono">{tpl}</bdi> · {tpl === 'SA_6D' ? tr('القالب السعودي') : tr('القالب العام')}</ReadRow>
        <ReadRow label={tr('عملة الدفاتر')}>
          <bdi dir="ltr" className="font-mono">{state.status.currency ?? state.company.currency ?? '—'}</bdi>
          <span className="inline-flex ms-1 align-middle" title={tr('مجمدة عند الإعداد')}><Lock size={11} className="text-[#9A8F7E]" /></span>
        </ReadRow>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={tr('المنطقة الزمنية')}>
            {timezones.length ? (
              <select className="input" dir="ltr" value={v.timezone} disabled={ro} onChange={e => setV(s => ({ ...s, timezone: e.target.value }))}>
                {!timezones.includes(v.timezone) && <option value={v.timezone}>{v.timezone}</option>}
                {timezones.map(z => <option key={z} value={z}>{z}</option>)}
              </select>
            ) : (
              <input className="input" dir="ltr" value={v.timezone} disabled={ro} onChange={e => setV(s => ({ ...s, timezone: e.target.value }))} />
            )}
          </Field>
          <Field label={tr('نهاية السنة المالية: الشهر')}>
            <select className="input" value={v.fiscalYearEndMonth} disabled={ro}
              onChange={e => { const m = Number(e.target.value); setV(s => ({ ...s, fiscalYearEndMonth: m, fiscalYearEndDay: Math.min(s.fiscalYearEndDay, daysInMonth(2001, m)) })); }}>
              {months.map((name, i) => <option key={i} value={i + 1}>{name}</option>)}
            </select>
          </Field>
          <Field label={tr('نهاية السنة المالية: اليوم')}>
            <select className="input" value={v.fiscalYearEndDay} disabled={ro} onChange={e => setV(s => ({ ...s, fiscalYearEndDay: Number(e.target.value) }))}>
              {Array.from({ length: daysInMonth(2001, v.fiscalYearEndMonth) }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
            </select>
          </Field>
          <Field label={tr('بداية الأسبوع')}>
            <select className="input" value={v.weekStartsOn} disabled={ro} onChange={e => setV(s => ({ ...s, weekStartsOn: Number(e.target.value) }))}>
              {weekdays.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </Field>
        </div>
      </StepSection>

      <StepSection title={tr('دورية الإقرار')}
        hint={tr('الشهرية إلزامية لمن تتجاوز توريداته الخاضعة للضريبة 40 مليون ريال سنويا، وغيره ربع سنوي ويجوز له اختيار الشهري')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {PERIODICITIES.filter(p => tpl !== 'SA_6D' || p === 'MONTHLY' || p === 'QUARTERLY' || p === v.taxPeriodicity).map(p => (
            <label key={p} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm cursor-pointer ${v.taxPeriodicity === p ? 'border-[#E15A30] bg-[#FBEBE2]/50' : 'border-[#E8E0D2]'} ${ro ? 'opacity-60 cursor-not-allowed' : ''}`}>
              <input type="radio" name="taxPeriodicity" className="accent-[#E15A30]" checked={v.taxPeriodicity === p} disabled={ro}
                onChange={() => setV(s => ({ ...s, taxPeriodicity: p }))} />
              {periodicityLabels[p]}
              {p === 'QUARTERLY' && <span className="text-[11px] text-[#9A8F7E]">({tr('افتراضي')})</span>}
            </label>
          ))}
        </div>
        {tpl === 'SA_6D' && <p className="text-[11px] text-[#9A8F7E]">{tr('يُتحقق من الحد في دليل هيئة الزكاة والضريبة والجمارك قبل اعتماده')}</p>}
      </StepSection>

      <StepSection title={tr('تاريخ البدء')}>
        <Notice>
          <Sparkles size={12} className="inline me-1" />
          {tr('بداية نظيفة: تبدأ الدفاتر وشجرة الحسابات يوم التفعيل بلا استيراد ولا ترحيل لأي مستند أو حركة أو رصيد سبق التفعيل. ما يُنشأ بعد التفعيل وحده يُرحَّل، والأرصدة الافتتاحية يُدخلها المحاسب في خطوة الأرصدة')}
        </Notice>
        <ReadRow label={tr('تاريخ البدء')}>{tr('يوم التفعيل')} · <bdi className="tabular-nums">{formatDayOnly(cutoverDate)}</bdi> {tr('إن فعّلت اليوم')}</ReadRow>
        {mid && (
          <div className="space-y-3">
            <Notice tone="warn">
              {tr('تاريخ البدء داخل فترة إقرار. أدخل مبالغ المربعات لكل ما سبق لحظة التفعيل في هذه الفترة، ومنها مستندات يوم التفعيل السابقة له، وإلا نقصت مربعات الإقرار الأول. ويلزم إدخال أرصدة ضريبة المخرجات والمدخلات للفترة المفتوحة في خطوة الأرصدة')}
            </Notice>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 accent-[#E15A30]" checked={v.confirmMidVatPeriod} disabled={ro}
                onChange={e => setV(s => ({ ...s, confirmMidVatPeriod: e.target.checked }))} />
              <span>{tr('أؤكد تاريخ البدء داخل فترة الإقرار وسأدخل مبالغ المربعات قبل البدء للإقرار الأول')}</span>
            </label>
            {v.confirmMidVatPeriod && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[32rem]">
                  <thead>
                    <tr className="text-xs text-[#9A8F7E]">
                      <th className="text-start font-medium py-1 pe-2">{tr('المربع')}</th>
                      <th className="text-start font-medium py-1 pe-2 w-36">{tr('المبلغ')}</th>
                      <th className="text-start font-medium py-1 w-36">{tr('الضريبة')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1EBDF]">
                    {PRE_CUTOVER_BOX_NOS.map(no => (
                      <tr key={no}>
                        <td className="py-1.5 pe-2"><bdi className="tabular-nums text-[#9A8F7E]">{no}.</bdi> {boxLabels[no]}</td>
                        {(['amount', 'tax'] as const).map(col => (
                          <td key={col} className="py-1.5 pe-2">
                            <input className="input !py-1 tabular-nums" dir="ltr" inputMode="decimal" disabled={ro}
                              value={boxes[preCutoverBoxKey(no, col)] ?? ''} onChange={e => setBoxes(b => ({ ...b, [preCutoverBoxKey(no, col)]: e.target.value }))} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </StepSection>

      <StepFooter onNext={save} busy={busy} disabledReason={disabledReason} canWrite={canWrite} />
    </div>
  );
}

// ═══ الخطوة 3: الشجرة ═══

export function Step3Tree({ state, canWrite, busy, onSave, onBack }: StepProps) {
  const tr = useTr();
  const lang = useLang(s => s.lang);
  const accountsQ = useAllAccounts();
  const accounts = accountsQ.data ?? [];
  const hasAccounts = accounts.length > 0;
  const catsQ = useQuery({
    queryKey: ledgerSetupKeys.categories,
    queryFn: async () => (await ledgerSetupApi.categories.list()).data.data,
    enabled: hasAccounts,
  });
  const d3 = state.draft.step3 ?? {};
  const byId = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  const byCode = useMemo(() => new Map(accounts.map(a => [a.code, a])), [accounts]);

  // الأسماء: حسابات النقد والبنوك (اسم البنك، الصناديق)
  const cashAccounts = accounts.filter(a => a.type === 'asset_cash' && a.isActive).sort((a, b) => a.code.localeCompare(b.code));
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries((d3.accountNames ?? []).map(r => [r.code, r.name])));
  const [catCodes, setCatCodes] = useState<Record<string, string>>(() => Object.fromEntries((d3.categoryIncomeAccounts ?? []).map(r => [r.categoryId, r.accountCode])));
  const [routing, setRouting] = useState<Partial<Record<ReceiptMethod, ReceiptRouteTarget>>>(() => d3.receiptRouting ?? state.status.receiptRouting ?? {});
  const methodLabels: Record<ReceiptMethod, string> = { CASH: tr('نقدي'), BANK_TRANSFER: tr('تحويل بنكي'), POS: tr('شبكة (نقاط البيع)'), CHEQUE: tr('شيك') };

  // null = القائمة غير محمّلة (catsQ معطّلة قبل زرع الشجرة، أو قيد التحميل، أو فشلت) ⇒ لا تُصفَّى الروابط
  const liveCategoryIds = catsQ.data && !catsQ.isError ? new Set(catsQ.data.categories.map(c => c.categoryId)) : null;
  const staleLinks = liveCategoryIds ? Object.entries(catCodes).filter(([id, code]) => !!code && !liveCategoryIds.has(id)).length : 0;

  const nameIssues = Object.entries(names).filter(([code, n]) => byCode.has(code) && n.trim() !== byCode.get(code)!.name && !hasArabicLetter(n));
  const disabledReason = nameIssues.length ? tr('الاسم يجب أن يحوي حرفاً عربياً والاسم بلغة أخرى مكانه الاسم الإنجليزي') : null;

  const save = () => {
    const accountNames = Object.entries(names)
      .map(([code, name]) => ({ code, name: name.trim() }))
      .filter(r => r.name && byCode.has(r.code) && r.name !== byCode.get(r.code)!.name);
    // البند 26: فئة حُذفت (بتراجع عن دفعة منتجات مثلاً) يبقى معرّفها في المسودة فيُعاد حفظه كل مرة
    // ويُسقطه الخادم عند الاعتماد بلا علم المالك. تُصفّى هنا — **بشرط** توفّر قائمة الفئات.
    const categoryIncomeAccounts = keepLiveCategoryLinks(catCodes, liveCategoryIds);
    onSave({
      step3: {
        accountNames,
        categoryIncomeAccounts,
        receiptRouting: Object.fromEntries(RECEIPT_METHODS.map(m => [m, routing[m] ?? 'CUSTODY'])) as Record<ReceiptMethod, ReceiptRouteTarget>,
        // قرار المالك D3 (ب): الشاشة التشغيلية للتحصيل لا تتغير، فنقد الفواتير النقدية إلى الصندوق الرئيسي دائماً
        cashInvoiceRouting: 'MAIN_CASH',
      },
    }, 5); // خطوة «الأرصدة المشتقة» (4) أُزيلت بقرار الخبير المحاسبي
  };

  const incomeRule = catsQ.data?.fields.find(f => f.field === 'incomeAccountId');
  const fallback = incomeRule?.fallbackAccountId ? byId.get(incomeRule.fallbackAccountId) : null;
  const ro = !canWrite;

  return (
    <div className="space-y-4">
      {!accountsQ.isLoading && !hasAccounts && (
        <Notice>
          {tr('شجرة الحسابات تُزرع من القالب عند التفعيل. لتعديل أسماء الصناديق والبنوك وربط فئات المنتجات الآن، حمّل القالب من الإعدادات ثم عد إلى هذه الخطوة')}{' '}
          <Link to={`${ledgerHref('config/settings')}#fiscal-localization`} className="text-[#E15A30] hover:underline">{tr('الإعدادات')} ←</Link>
        </Notice>
      )}

      {hasAccounts && (
        <StepSection title={tr('أسماء الصناديق والبنوك')} hint={tr('اكتب اسم البنك الفعلي والصناديق كما تُعرف في شركتك. الاسم العربي إلزامي')}>
          <div className="grid gap-2 sm:grid-cols-2">
            {cashAccounts.map(a => {
              const value = names[a.code] ?? a.name;
              const bad = value.trim() !== a.name && !hasArabicLetter(value);
              return (
                <Field key={a.id} label={`${a.code}`} hint={a.name !== ledgerName(a, lang) ? ledgerName(a, lang) : undefined}>
                  <input className={`input ${bad ? '!border-[#C0392B]' : ''}`} value={value} disabled={ro} maxLength={200}
                    onChange={e => setNames(n => ({ ...n, [a.code]: e.target.value }))} />
                </Field>
              );
            })}
          </div>
        </StepSection>
      )}

      {hasAccounts && (
        <StepSection title={tr('ربط فئات المنتجات بحسابات الإيراد')}
          hint={<>{tr('الفئة بلا حساب تُرحَّل مبيعاتها إلى حساب الإيراد الافتراضي')}{fallback ? <>: <bdi className="tabular-nums">{fallback.code}</bdi> {ledgerName(fallback, lang)}</> : null}</>}>
          {staleLinks > 0 && (
            <Notice tone="warn">
              {tr('رابط فئة إلى حساب إيراد تُخطّي لأن الفئة لم تعد موجودة')}: <bdi className="tabular-nums">{staleLinks}</bdi>
            </Notice>
          )}
          {catsQ.isLoading && <p className="text-sm text-[#9A8F7E]">{tr('جاري التحميل...')}</p>}
          {catsQ.isError && <p className="text-sm text-[#8E2A1F]">{tr('تعذر تحميل البيانات')}</p>}
          {catsQ.data && catsQ.data.categories.length === 0 && <p className="text-sm text-[#9A8F7E]">{tr('لا توجد فئات منتجات')}</p>}
          {catsQ.data && catsQ.data.categories.length > 0 && (
            <div className="divide-y divide-[#F1EBDF]">
              {catsQ.data.categories.map(c => {
                const code = catCodes[c.categoryId] ?? (c.incomeAccountId ? byId.get(c.incomeAccountId)?.code : undefined) ?? '';
                const selected: GlAccount | undefined = code ? byCode.get(code) : undefined;
                return (
                  <div key={c.categoryId} className="grid gap-2 py-2 sm:grid-cols-[1fr_minmax(16rem,1.2fr)] items-center">
                    <div className="min-w-0">
                      <p className="text-sm text-[#1F1A13] truncate">{c.categoryName}</p>
                      <p className="text-[11px] text-[#9A8F7E]"><bdi className="tabular-nums">{c.productCount}</bdi> {tr('منتج')}</p>
                    </div>
                    <AccountSelect accounts={accounts} value={selected?.id ?? null} disabled={ro} allowEmpty
                      types={incomeRule?.allowedTypes ?? ['income', 'income_other']} placeholder={tr('الحساب الافتراضي')}
                      onChange={id => setCatCodes(m => ({ ...m, [c.categoryId]: id ? byId.get(id)?.code ?? '' : '' }))} />
                  </div>
                );
              })}
            </div>
          )}
        </StepSection>
      )}

      <StepSection title={tr('مسار كل طريقة قبض')} hint={tr('عهدة المندوب: يبقى المبلغ على المندوب حتى الاستلام. الحساب مباشرة: يُرحَّل إلى حساب الطريقة فور السند')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {RECEIPT_METHODS.map(m => (
            <div key={m} className="flex items-center gap-2">
              <span className="text-sm min-w-[8rem]">{methodLabels[m]}</span>
              <select className="input flex-1" value={routing[m] ?? 'CUSTODY'} disabled={ro}
                onChange={e => setRouting(r => ({ ...r, [m]: e.target.value as ReceiptRouteTarget }))}>
                <option value="CUSTODY">{tr('عهدة المندوب')}</option>
                <option value="DIRECT">{tr('الحساب مباشرة')}</option>
              </select>
            </div>
          ))}
        </div>
        <ReadRow label={tr('نقد الفواتير النقدية')}>
          {tr('الصندوق الرئيسي')}
          <span className="block text-[11px] text-[#9A8F7E]">{tr('شاشة التحصيل التشغيلية لا تعد نقد الفواتير النقدية على المندوب، فيُرحَّل إلى الصندوق الرئيسي')}</span>
        </ReadRow>
      </StepSection>

      <StepFooter onBack={onBack} onNext={save} busy={busy} disabledReason={disabledReason} canWrite={canWrite} />
    </div>
  );
}
