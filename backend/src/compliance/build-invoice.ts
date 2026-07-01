// ============================================================================
// منسّق بناء الفاتورة الممتثلة (Orchestrator) — يربط الأساس من طرف إلى طرف
// ----------------------------------------------------------------------------
// يأخذ دولة الشركة + البنود، فيحسب الإجماليات بضريبة الدولة وخاناتها،
// ثم يبني حمولة الامتثال عبر محوّل الدولة (ZATCA/ETA/…).
// نقيّ وبلا مساس بقاعدة البيانات — يُستدعى لاحقًا من مسار الفواتير بعد إضافة
// حقل الدولة إلى CompanySettings (يتطلّب إذن قاعدة البيانات).
// ============================================================================
import { getCountryTax } from '../config/countries';
import { computeInvoice, TaxLineInput, TaxTotals } from '../lib/tax';
import { getComplianceProvider, ComplianceResult, ComplianceSeller } from './provider';

export interface BuildInvoiceInput {
  countryCode?: string | null;   // دولة الشركة (من CompanySettings مستقبلًا)
  seller: ComplianceSeller;      // اسم الشركة ورقمها الضريبي
  lines: TaxLineInput[];
  pricesIncludeTax?: boolean;
  issuedAt?: Date;
  invoiceNumber?: string;
  buyerTaxNumber?: string;
}

export interface BuiltInvoice {
  country: string;
  currency: string;
  totals: TaxTotals;
  compliance: ComplianceResult;
}

// يبني فاتورة ممتثلة كاملة حسب دولة الشركة
export async function buildCompliantInvoice(input: BuildInvoiceInput): Promise<BuiltInvoice> {
  const country = getCountryTax(input.countryCode);
  const totals = computeInvoice(input.lines, {
    defaultTaxPct: country.defaultVatPct,
    pricesIncludeTax: input.pricesIncludeTax,
    decimals: country.currencyDecimals,
  });

  const provider = getComplianceProvider(country.provider);
  const compliance = await provider.build({
    seller: input.seller,
    issuedAt: input.issuedAt ?? new Date(),
    total: totals.total,
    vatTotal: totals.totalTax,
    currency: country.currency,
    invoiceNumber: input.invoiceNumber,
    buyerTaxNumber: input.buyerTaxNumber,
  });

  return { country: country.code, currency: country.currency, totals, compliance };
}
