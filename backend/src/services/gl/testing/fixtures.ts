/**
 * سياقات بناء جاهزة من القوالب لاختبارات الـbuilders والتحقق (M1).
 *
 * صرفة وحتمية: المعرّفات مشتقة من الرموز والمفاتيح (acc_111001، tax_S15_SALE، jrn_INV)،
 * فتكتب الاختبارات `accountIdOf('113001')` بدل البحث. كل استدعاء يبني نسخة مستقلة.
 */
import {
  createBuildContext,
  type AccountRef, type BuildContext, type BuildContextInput, type CategoryAccountsRef, type GlSettingsSnapshot,
  type JournalRef, type MappingKey, type TaxRef,
} from '../types';
import { SA_6D_TEMPLATE, type ChartTemplate } from '../coa/sa';
import { SA_DEFAULT_PURCHASE_TAX_KEY, SA_TAXES, type TaxTemplate } from '../taxes/sa';
import { genericSettings, genericTemplate } from '../coa/generic';

export const accountIdOf = (code: string): string => `acc_${code}`;
export const taxIdOf = (key: string): string => `tax_${key}`;
export const journalIdOf = (code: string): string => `jrn_${code}`;

export interface FixtureOverrides {
  /** يُدمج فوق إعدادات القالب (DEFAULT_GL_SETTINGS + ما يشتقه القالب) */
  settings?: Partial<GlSettingsSnapshot>;
  /** تعديل حساب بالرمز (مثل {isActive:false} للأرشفة)؛ null يحذفه من السياق */
  accounts?: Readonly<Record<string, Partial<Omit<AccountRef, 'id' | 'code'>> | null>>;
  /** حسابات إضافية كما هي */
  extraAccounts?: readonly AccountRef[];
  /** إعادة ربط مفتاح إلى **رمز** حساب، أو null لإزالة الربط (MISSING_MAPPING) */
  mappings?: Readonly<Partial<Record<MappingKey, string | null>>>;
  /** تعديل ضريبة بالمفتاح؛ null يحذفها */
  taxes?: Readonly<Record<string, Partial<Omit<TaxRef, 'id' | 'key'>> | null>>;
  extraTaxes?: readonly TaxRef[];
  /** تعديل دفتر بالرمز؛ null يحذفه */
  journals?: Readonly<Record<string, Partial<Omit<JournalRef, 'id' | 'code'>> | null>>;
  extraJournals?: readonly JournalRef[];
  categoryAccounts?: Readonly<Record<string, CategoryAccountsRef>>;
  repAnalytics?: Readonly<Record<string, string>>;
}

function patchRows<R extends { code?: string; key?: string | null }>(
  rows: R[], patches: Readonly<Record<string, Partial<R> | null>> | undefined, idOf: (r: R) => string,
): R[] {
  if (!patches) return rows;
  const out: R[] = [];
  for (const r of rows) {
    const p = patches[idOf(r)];
    if (p === null) continue;
    out.push(p ? { ...r, ...p } : r);
  }
  return out;
}

/** يحوّل قالباً وضرائبه إلى مدخل createBuildContext (بلا دمج الإعدادات). */
export function templateContextInput(
  chart: ChartTemplate, taxes: readonly TaxTemplate[], settings: Partial<GlSettingsSnapshot>,
  overrides: FixtureOverrides = {},
): BuildContextInput {
  let accounts: AccountRef[] = chart.accounts.map((a) => ({
    id: accountIdOf(a.code),
    code: a.code,
    name: a.names.ar,
    type: a.type,
    isActive: a.isActive,
    reconcile: a.reconcile,
    controlKind: a.controlKind,
  }));
  accounts = patchRows(accounts, overrides.accounts as Record<string, Partial<AccountRef> | null> | undefined, (r) => r.code);
  accounts.push(...(overrides.extraAccounts ?? []));
  const present = new Set(accounts.map((a) => a.id));

  const mappings: Partial<Record<MappingKey, string>> = {};
  for (const [k, code] of Object.entries(chart.mappings) as [MappingKey, string][]) {
    if (present.has(accountIdOf(code))) mappings[k] = accountIdOf(code);
  }
  for (const [k, code] of Object.entries(overrides.mappings ?? {}) as [MappingKey, string | null][]) {
    if (code === null) delete mappings[k];
    else mappings[k] = accountIdOf(code);
  }

  let taxRows: TaxRef[] = taxes.map((t) => ({
    id: taxIdOf(t.key),
    key: t.key,
    name: t.names.ar,
    use: t.use,
    rate: t.rate,
    vatCategory: t.vatCategory,
    priceInclude: t.priceInclude,
    accountId: t.accountCode ? accountIdOf(t.accountCode) : null,
    rcOutputAccountId: t.rcOutputAccountCode ? accountIdOf(t.rcOutputAccountCode) : null,
    deductible: t.deductible,
    vatBox: t.vatBox,
    isActive: t.isActive,
  }));
  taxRows = patchRows(taxRows, overrides.taxes as Record<string, Partial<TaxRef> | null> | undefined, (r) => r.key ?? '');
  taxRows.push(...(overrides.extraTaxes ?? []));

  let journals: JournalRef[] = chart.journals.map((j) => ({
    id: journalIdOf(j.code),
    code: j.code,
    name: j.names.ar,
    type: j.type,
    systemKey: j.systemKey,
    defaultAccountId: j.defaultAccountCode ? accountIdOf(j.defaultAccountCode) : null,
    suspenseAccountId: j.suspenseAccountCode ? accountIdOf(j.suspenseAccountCode) : null,
    useOutstandingAccounts: j.useOutstandingAccounts,
    sequenceReset: j.sequenceReset,
    isActive: true,
  }));
  journals = patchRows(journals, overrides.journals as Record<string, Partial<JournalRef> | null> | undefined, (r) => r.code);
  journals.push(...(overrides.extraJournals ?? []));

  return {
    settings: { ...settings, ...(overrides.settings ?? {}) },
    accounts,
    mappings,
    taxes: taxRows,
    journals,
    categoryAccounts: overrides.categoryAccounts,
    repAnalytics: overrides.repAnalytics,
  };
}

/**
 * سياق شركة سعودية بالقالب SA_6D كاملاً: 137 حساباً وكل مفاتيح الربط والدفاتر الستة عشر والضرائب الثلاث عشرة.
 * الإعدادات = DEFAULT_GL_SETTINGS + defaultPurchaseTaxId = tax_S15_PURCH + overrides.settings.
 */
export function saContext(overrides: FixtureOverrides = {}): BuildContext {
  return createBuildContext(
    templateContextInput(SA_6D_TEMPLATE, SA_TAXES, { defaultPurchaseTaxId: taxIdOf(SA_DEFAULT_PURCHASE_TAX_KEY) }, overrides),
  );
}

/**
 * سياق شركة بالقالب العام GENERIC_6D لدولة (مثل 'KW' بنسبة 0٪: حسابات الضريبة مؤرشفة والضرائب غير نشطة
 * وzeroRatedSalesTaxKey = null؛ أو 'EG' بضريبة S14_SALE/S14_PURCH). `vatPct` يتجاوز نسبة سجل الدول.
 */
export function genericContext(
  countryCode: string, overrides: FixtureOverrides = {}, opts: { vatPct?: number } = {},
): BuildContext {
  const tpl = genericTemplate(countryCode, opts);
  const settings: Partial<GlSettingsSnapshot> = {
    ...genericSettings(countryCode, opts),
    defaultPurchaseTaxId: tpl.defaultPurchaseTaxKey ? taxIdOf(tpl.defaultPurchaseTaxKey) : null,
  };
  return createBuildContext(templateContextInput(tpl, tpl.taxes, settings, overrides));
}
