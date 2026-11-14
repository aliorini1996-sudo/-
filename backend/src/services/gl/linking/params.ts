/**
 * حلّ خيارات معاينة «ربط الدفاتر» (L2 — العقد scratchpad/l23_contract.md §14.1). صرفٌ بلا قاعدة ولا ساعة:
 * المهمة (jobs.ts) ومسار الـpreflight يقرآن الصفوف ثم يمرّرانها هنا، فتُحلّ الخيارات من مكان واحد ويرى الـpreflight
 * الخفيف والمعاينة الكاملة الإعدادات نفسها حرفياً.
 *
 * ترتيب المصادر كـeffectiveSetup في routes/ledger/setup.ts: المسودة ثم صفّ GlSettings ثم الافتراضي — عدا تاريخ البدء:
 * الربط لا يأخذ cutoverDate من المسودة (طريقة CLEAN تتجاهله أصلاً)، بل `linkedFrom` من الأساس (قرار المالك FY_RESTATED:
 * بداية السنة المالية لليوم المحلي، أو اليوم نفسه لـFROM_ACTIVATION).
 */
import { daysInMonth, fiscalYearStart, isLocalDate, isValidTimeZone, todayLocal } from '../dates';
import { isVatPeriodStart, type ManualBalanceRowInput } from '../opening';
import { resolveTemplate } from '../seed';
import {
  CASH_INVOICE_ROUTINGS, DEFAULT_GL_SETTINGS, TAX_PERIODICITIES,
  type CashInvoiceRouting, type LocalDate, type ReceiptRouting, type TaxPeriodicity, type TemplateKey,
} from '../types';
import {
  LINK_BASES, LINKED_DEFAULT_RECEIPT_ROUTING,
  type LinkBasis, type LinkingDraft, type LinkingSettingsRow, type PreflightEventStats, type PreflightInput, type PreflightMode,
  type PreviewOptions,
} from './types';
import type { CostingSummary } from '../../costing/types';

export interface ResolveParamsInput {
  basis: LinkBasis;
  /** ساعة «اليوم» المحلي (ساعة القاعدة داخل لقطة الـpreflight، وساعة التطبيق في المهمة) */
  dbNow: Date;
  settingsRow: LinkingSettingsRow | null;
  draft: LinkingDraft | null;
  /** CompanySettings: الدولة (حروف كبيرة، SA افتراضياً) والعملة الفعلية (currencyOverride ‖ currency) */
  company: { countryCode: string; currency: string | null };
  tenant: { accountingSuiteEnabled: boolean; accountingEnabled: boolean; warehouseEnabled: boolean };
  env?: NodeJS.ProcessEnv;
}

export type LinkingParamsErrorReason = 'TEMPLATE_UNAVAILABLE' | 'INVALID_FISCAL_YEAR_END' | 'INVALID_BASIS';

/** إعدادات لا تُبنى منها معاينة — يترجمها المسار إلى 422 والمهمة إلى FAILED */
export class LinkingParamsError extends Error {
  constructor(readonly reason: LinkingParamsErrorReason, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LinkingParamsError';
    Object.setPrototypeOf(this, LinkingParamsError.prototype);
  }
}

export const LINKING_PARAMS_ERROR_MESSAGES: Readonly<Record<LinkingParamsErrorReason, string>> = {
  TEMPLATE_UNAVAILABLE: 'لا قالب محاسبي لدولة الشركة — تواصل مع الدعم قبل ربط الدفاتر',
  INVALID_FISCAL_YEAR_END: 'يوم نهاية السنة المالية غير صالح للشهر — صحّحه في الخطوة الأولى من معالج الإعداد',
  INVALID_BASIS: 'أساس الربط غير معروف',
};

export function isLinkBasis(v: unknown): v is LinkBasis {
  return typeof v === 'string' && (LINK_BASES as readonly string[]).includes(v);
}

const RECEIPT_ROUTE_METHODS = ['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE'] as const;

/**
 * receiptRouting المخزَّن (Json) ⇒ ما يصحّ منه وحده بترتيب ثابت للمفاتيح — مرآة receiptRoutingOf في resolve.ts
 * (الخاصّة هناك). غير الكائن ⇒ null (يسقط إلى الافتراضي).
 */
export function receiptRoutingFrom(v: unknown): ReceiptRouting | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: ReceiptRouting = {};
  for (const m of RECEIPT_ROUTE_METHODS) {
    const x = src[m];
    if (x === 'CUSTODY' || x === 'DIRECT') out[m] = x;
  }
  return out;
}

function cashInvoiceRoutingFrom(v: unknown): CashInvoiceRouting | null {
  return typeof v === 'string' && (CASH_INVOICE_ROUTINGS as readonly string[]).includes(v) ? (v as CashInvoiceRouting) : null;
}

function taxPeriodicityFrom(v: unknown): TaxPeriodicity | null {
  return typeof v === 'string' && (TAX_PERIODICITIES as readonly string[]).includes(v) ? (v as TaxPeriodicity) : null;
}

const intIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

/** القالب كـeffectiveSetup: صفّ الإعدادات يحكم إن وُجد، وإلا الدولة (SA ⇒ SA_6D، غيرها ⇒ GENERIC_6D) */
export function templateKeyOf(settingsRow: Pick<LinkingSettingsRow, 'templateKey'> | null, countryCode: string): TemplateKey {
  if (settingsRow) return settingsRow.templateKey === 'GENERIC_6D' ? 'GENERIC_6D' : 'SA_6D';
  return countryCode === 'SA' ? 'SA_6D' : 'GENERIC_6D';
}

/**
 * الخيارات الكاملة لـrunPreview (§14.1). يرمي LinkingParamsError لقالب لا يُحلّ أو نهاية سنة مالية مستحيلة —
 * الظلّ يبني سياقه من القالب نفسه (virtualContext.ts) فيُرفض الطلب هنا بدل فشل INTERNAL في منتصف المهمة.
 */
export function resolvePreviewOptions(i: ResolveParamsInput): PreviewOptions {
  if (!isLinkBasis(i.basis)) {
    throw new LinkingParamsError('INVALID_BASIS', LINKING_PARAMS_ERROR_MESSAGES.INVALID_BASIS, { basis: i.basis });
  }
  const s = i.settingsRow;
  const d1 = i.draft?.step1 ?? {};
  const d3 = i.draft?.step3 ?? {};
  const companyCountry = (i.company.countryCode || 'SA').toUpperCase();
  const templateKey = templateKeyOf(s, companyCountry);
  const countryCode = s?.countryCode || companyCountry;

  let tpl;
  try {
    tpl = resolveTemplate(templateKey, templateKey === 'GENERIC_6D' ? { countryCode } : {});
  } catch (e) {
    if (e instanceof RangeError) {
      throw new LinkingParamsError('TEMPLATE_UNAVAILABLE', LINKING_PARAMS_ERROR_MESSAGES.TEMPLATE_UNAVAILABLE, { templateKey, countryCode });
    }
    throw e;
  }

  const tzCandidate = d1.timezone ?? s?.timezone ?? DEFAULT_GL_SETTINGS.timezone;
  const timezone = tzCandidate && isValidTimeZone(tzCandidate) ? tzCandidate : DEFAULT_GL_SETTINGS.timezone;
  const fiscalYearEndMonth = intIn(d1.fiscalYearEndMonth, 1, 12) ?? intIn(s?.fiscalYearEndMonth, 1, 12) ?? 12;
  const fiscalYearEndDay = intIn(d1.fiscalYearEndDay, 1, 31) ?? intIn(s?.fiscalYearEndDay, 1, 31) ?? 31;
  // كـassertFiscalYearEnd في setup.ts: 31 فبراير لا تُحسب منه سنة مالية (2001 سنة بسيطة: 29 فبراير مرفوض أيضاً)
  if (fiscalYearEndDay > daysInMonth(2001, fiscalYearEndMonth)) {
    throw new LinkingParamsError('INVALID_FISCAL_YEAR_END', LINKING_PARAMS_ERROR_MESSAGES.INVALID_FISCAL_YEAR_END, { fiscalYearEndMonth, fiscalYearEndDay });
  }
  const weekStartsOn = intIn(d1.weekStartsOn, 0, 6) ?? intIn(s?.weekStartsOn, 0, 6) ?? 0;
  const taxPeriodicity = taxPeriodicityFrom(d1.taxPeriodicity) ?? taxPeriodicityFrom(s?.taxPeriodicity) ?? 'QUARTERLY';

  const today = todayLocal(i.dbNow, timezone);
  const linkedFrom: LocalDate = i.basis === 'FY_RESTATED' ? fiscalYearStart(today, fiscalYearEndMonth, fiscalYearEndDay) : today;

  // عملة الدفاتر: لقطة الصفّ إن زُرع (مجمّدة)، وإلا ما سيزرعه القالب
  const currency = s?.currency || tpl.settings.currency;
  const currencyDecimals = s && Number.isInteger(s.currencyDecimals) ? s.currencyDecimals : tpl.settings.currencyDecimals;

  // OD4: المسودة ثم الصفّ ثم افتراضي الربط (النقد والشيك مع مندوب ⇒ عهدة، والبقية مباشرة)
  const receiptRouting: ReceiptRouting = {
    ...(d3.receiptRouting ?? receiptRoutingFrom(s?.receiptRouting) ?? LINKED_DEFAULT_RECEIPT_ROUTING),
  };
  // OD2: الختم على الفاتورة يقود في L4؛ هذا احتياط الصفوف غير المختومة
  const cashInvoiceRouting = cashInvoiceRoutingFrom(d3.cashInvoiceRouting) ?? cashInvoiceRoutingFrom(s?.cashInvoiceRouting) ?? 'MAIN_CASH';

  const midVatPeriod = !isVatPeriodStart(linkedFrom, taxPeriodicity, fiscalYearEndMonth, fiscalYearEndDay) && d1.confirmMidVatPeriod === true;
  const env = i.env ?? process.env;

  return {
    basis: i.basis,
    linkedFrom,
    templateKey,
    countryCode,
    timezone,
    fiscalYearEndMonth,
    fiscalYearEndDay,
    weekStartsOn,
    taxPeriodicity,
    currency,
    currencyDecimals,
    receiptRouting,
    cashInvoiceRouting,
    // OD7: الجرد المستمر لمن له مخزون الشركة، وإلا الدوري (بلا سطور مخزون افتتاحية)
    inventoryMode: i.tenant.warehouseEnabled ? 'PERPETUAL' : 'PERIODIC',
    categoryIncomeAccounts: (d3.categoryIncomeAccounts ?? [])
      .filter((c) => c && typeof c.categoryId === 'string' && typeof c.accountCode === 'string')
      .map((c) => ({ categoryId: c.categoryId, accountCode: c.accountCode })),
    manualRows: manualRowsOf(i.draft),
    midVatPeriod,
    settingsRow: s,
    draft: i.draft,
    suiteEnabled: i.tenant.accountingSuiteEnabled === true && i.tenant.accountingEnabled !== false,
    workerEnabled: env.LEDGER_WORKER_ENABLED !== '0',
  };
}

/** صفوف الخطوة 5 كما يقبلها validateManualBalanceRows (نسخ سطحية: لا يُعدَّل كائن المسودة) */
function manualRowsOf(draft: LinkingDraft | null): ManualBalanceRowInput[] {
  const rows = draft?.step5?.rows ?? [];
  return rows.filter((r) => r && typeof r === 'object').map((r) => ({ ...r, accountCode: String(r.accountCode ?? '').trim() }));
}

/** مدخل runPreflight من الخيارات المحلولة نفسها — LIGHT لمسار GET /linking/preflight، وFULL يمرّ costing/eventStats */
export function preflightInputFromOptions(
  o: PreviewOptions, mode: PreflightMode, now: Date,
  full: { costing?: CostingSummary | null; eventStats?: PreflightEventStats | null } = {},
): PreflightInput {
  if (!isLocalDate(o.linkedFrom)) throw new RangeError(`linkedFrom غير صالح: ${String(o.linkedFrom)}`);
  return {
    mode,
    basis: o.basis,
    linkedFrom: o.linkedFrom,
    timezone: o.timezone,
    templateKey: o.templateKey,
    currency: o.currency,
    currencyDecimals: o.currencyDecimals,
    receiptRouting: o.receiptRouting,
    cashInvoiceRouting: o.cashInvoiceRouting,
    settingsRow: o.settingsRow,
    draft: o.draft,
    suiteEnabled: o.suiteEnabled,
    workerEnabled: o.workerEnabled,
    now,
    inventoryMode: o.inventoryMode,
    ...(mode === 'FULL' ? { costing: full.costing ?? null, eventStats: full.eventStats ?? null } : {}),
  };
}
