/**
 * سياق البناء والإعدادات الافتراضيان لمعاينة «ربط الدفاتر» (L2 — العقد §10.1 وD8/D9).
 *
 * الشركة لم تُفعَّل بعد (D7)، فلا حسابات مزروعة ولا ربط ولا ضرائب في القاعدة: يُبنى السياق من القالب نفسه الذي سيزرعه
 * الاعتماد (resolveTemplate + templateContextInput الصرفة، بمعرّفات acc_<code>/tax_<key>/jrn_<code>)، فوقه إعدادات الربط
 * المحلولة (params.ts) وربط فئات الدخل من المسودة. صرفٌ بلا قاعدة ولا ساعة.
 */
import { linkedAccountRefs } from '../coa/linkedAccounts';
import { toDbDate } from '../dates';
import type { GlSettingsRow, LedgerContext } from '../resolve';
import { resolveTemplate } from '../seed';
import { accountIdOf, taxIdOf, templateContextInput } from '../testing/fixtures';
import {
  createBuildContext,
  type BuildContextInput, type CategoryAccountsRef, type GlSettingsSnapshot, type TaxRef, type TemplateKey,
} from '../types';
import type { LinkBasis, LinkingSettingsRow, PreviewOptions } from './types';

/** صفّ الإعدادات الافتراضي للظلّ: LINKED مفعّل عند T0 وترحيله التاريخي جارٍ */
export type VirtualSettingsRow = GlSettingsRow & {
  setupMethod: 'LINKED';
  activatedAt: Date;
  openingSnapshotAt: Date;
  linkBasis: LinkBasis;
  linkedFrom: Date;
  backfillState: 'RUNNING';
};

export interface VirtualContextInput {
  templateKey: TemplateKey;
  countryCode: string;
  settings: GlSettingsSnapshot;
  categoryIncomeAccounts: readonly { categoryId: string; accountCode: string }[];
}

/**
 * مدخل createBuildContext من القالب: حسابات/ضرائب/دفاتر القالب بمعرّفاتها الحتمية، والإعدادات المعطاة (ومنها
 * defaultPurchaseTaxId بمعرّف القالب)، وربط فئة ⇒ حساب دخل لكل فئة في المسودة رمزُ حسابها موجود في القالب.
 * الرمز غير الموجود يُسقط هنا (البند يُرحَّل على 411001 كما يفعل المُنشئ بلا ربط) ويعدّه unknownCategoryAccounts.
 */
export function virtualContextInput(input: VirtualContextInput): { contextInput: BuildContextInput; unknownCategoryAccounts: string[] } {
  const tpl = resolveTemplate(input.templateKey, input.templateKey === 'GENERIC_6D' ? { countryCode: input.countryCode } : {});
  const codes = new Set(tpl.chart.accounts.filter((a) => a.isActive).map((a) => a.code));
  const categoryAccounts: Record<string, CategoryAccountsRef> = {};
  const unknown: string[] = [];
  for (const c of input.categoryIncomeAccounts) {
    if (!c.categoryId) continue;
    if (!codes.has(c.accountCode)) { unknown.push(c.accountCode); continue; }
    categoryAccounts[c.categoryId] = { incomeAccountId: accountIdOf(c.accountCode), expenseAccountId: null, cogsAccountId: null, inventoryAccountId: null };
  }
  const settings: Partial<GlSettingsSnapshot> = {
    ...input.settings,
    defaultPurchaseTaxId: tpl.defaultPurchaseTaxKey ? taxIdOf(tpl.defaultPurchaseTaxKey) : null,
  };
  // «ربط الدفاتر» (PV): حسابات المربوطة 111004/112007/214002 خارج القالب (D2) — الاعتماد ينشئها (ensureLinkedAccounts) قبل
  // أول بناء، فيراها الظلّ من البداية بمعرّفاتها الحتمية؛ وإلا رُفض كل قيد يشير إليها برمزه (بطاقة، عهدة مستخدم، مستحق للعميل)
  const extraAccounts = input.settings.linkedPosting === true ? linkedAccountRefs(accountIdOf).filter((a) => !codes.has(a.code)) : [];
  const contextInput = templateContextInput(tpl.chart, tpl.taxes, settings, { categoryAccounts, ...(extraAccounts.length ? { extraAccounts } : {}) });
  return { contextInput, unknownCategoryAccounts: [...new Set(unknown)].sort() };
}

/** LedgerContext من مدخل جاهز (ويُعاد بناؤه حين يضيف الظلّ ضرائب AUTO_SALE_<pct>) */
export function ledgerContextFromInput(contextInput: BuildContextInput, extraTaxes: readonly TaxRef[] = []): LedgerContext {
  const taxes = [...(contextInput.taxes ?? []), ...extraTaxes];
  const ctx = createBuildContext({ ...contextInput, taxes });
  const accounts = [...contextInput.accounts];
  const journals = [...(contextInput.journals ?? [])];
  return {
    ctx,
    // لم يُزرع شيء في القاعدة بعد؛ الإعدادات الفعّالة في ctx.settings
    settings: null,
    accounts,
    taxes,
    journals,
    accountById: new Map(accounts.map((a) => [a.id, a])),
    taxById: new Map(taxes.map((t) => [t.id, t])),
    journalById: new Map(journals.map((j) => [j.id, j])),
  };
}

/** سياق بناء افتراضي من القالب فوقه إعدادات الربط وربط فئات الدخل من المسودة */
export function virtualLedgerContext(input: VirtualContextInput): LedgerContext {
  return ledgerContextFromInput(virtualContextInput(input).contextInput);
}

/**
 * صفّ GlSettings كما سيكون لحظة الاعتماد: إعدادات الربط من params.ts، وما لا يحدّده الربط (تواريخ الإقفال، خيارات
 * الترحيل، D2) من الصفّ الحقيقي إن وُجد وإلا افتراضات المخطط، ومعرّف ضريبة الشراء من القالب (معرّفات السياق الافتراضي).
 */
export function virtualSettingsRow(opts: PreviewOptions, real: LinkingSettingsRow | null, t0: Date): VirtualSettingsRow {
  const tpl = resolveTemplate(opts.templateKey, opts.templateKey === 'GENERIC_6D' ? { countryCode: opts.countryCode } : {});
  const linkedFrom = toDbDate(opts.linkedFrom);
  return {
    templateKey: opts.templateKey,
    countryCode: opts.countryCode,
    currency: opts.currency,
    currencyDecimals: opts.currencyDecimals,
    timezone: opts.timezone,
    fiscalYearEndMonth: opts.fiscalYearEndMonth,
    fiscalYearEndDay: opts.fiscalYearEndDay,
    weekStartsOn: opts.weekStartsOn,
    cutoverDate: linkedFrom,
    inventoryMode: opts.inventoryMode,
    perpetualFromDate: opts.inventoryMode === 'PERPETUAL' ? linkedFrom : null,
    salesLockDate: real?.salesLockDate ?? null,
    purchaseLockDate: real?.purchaseLockDate ?? null,
    taxLockDate: real?.taxLockDate ?? null,
    hardLockDate: real?.hardLockDate ?? null,
    taxPeriodicity: opts.taxPeriodicity,
    taxDeadlineRule: real?.taxDeadlineRule ?? tpl.settings.taxDeadlineRule ?? 'END_OF_NEXT_MONTH',
    taxDeadlineDays: real?.taxDeadlineDays ?? tpl.settings.taxDeadlineDays ?? null,
    zeroRatedSalesTaxKey: tpl.settings.zeroRatedSalesTaxKey ?? null,
    postSalesDiscountSeparately: real?.postSalesDiscountSeparately ?? true,
    postReturnsToContra: real?.postReturnsToContra ?? true,
    receiptRouting: { ...opts.receiptRouting },
    cashInvoiceRouting: opts.cashInvoiceRouting,
    paylinkFeeTaxInvoiceFrom: real?.paylinkFeeTaxInvoiceFrom ?? null,
    postPurchaseDiscountSeparately: real?.postPurchaseDiscountSeparately ?? false,
    billPricesIncludeTax: real?.billPricesIncludeTax ?? false,
    earlyDiscountAdjustsVat: real?.earlyDiscountAdjustsVat ?? true,
    taxRoundingMethod: real?.taxRoundingMethod ?? 'PER_TAX',
    defaultPurchaseTaxId: tpl.defaultPurchaseTaxKey ? taxIdOf(tpl.defaultPurchaseTaxKey) : null,
    setupMethod: 'LINKED',
    activatedAt: t0,
    openingSnapshotAt: t0,
    linkBasis: opts.basis,
    linkedFrom,
    backfillState: 'RUNNING',
  };
}
