// ============================================================================
// محرّك الضريبة (backend) — الحساب الموثوق لاعتماد الفاتورة
// يطابق منطق web-admin/src/lib/tax.ts، ويقرأ الخانات العشرية من سجلّ الدول.
// ============================================================================
export interface TaxLineInput {
  qty: number;
  unitPrice: number;
  taxPct?: number;
  discount?: number;
  exempt?: boolean;
}

export interface TaxLineResult {
  net: number; tax: number; gross: number; taxPct: number;
}

export interface TaxTotals {
  subtotal: number; totalDiscount: number; totalTax: number; total: number; lines: TaxLineResult[];
}

export interface TaxOptions {
  defaultTaxPct: number;
  pricesIncludeTax?: boolean;
  decimals?: number; // خانات عملة الدولة (٢ افتراضيًا)
}

function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function computeLine(line: TaxLineInput, opts: TaxOptions): TaxLineResult {
  const dec = opts.decimals ?? 2;
  const pct = line.exempt ? 0 : (line.taxPct ?? opts.defaultTaxPct);
  const base = Math.max(0, line.qty * line.unitPrice - (line.discount || 0));
  let net: number, tax: number;
  if (opts.pricesIncludeTax && pct > 0) {
    net = base / (1 + pct / 100);
    tax = base - net;
  } else {
    net = base;
    tax = base * (pct / 100);
  }
  net = round(net, dec);
  tax = round(tax, dec);
  return { net, tax, gross: round(net + tax, dec), taxPct: pct };
}

export function computeInvoice(lines: TaxLineInput[], opts: TaxOptions): TaxTotals {
  const dec = opts.decimals ?? 2;
  const results = lines.map((l) => computeLine(l, opts));
  const subtotal = round(results.reduce((s, r) => s + r.net, 0), dec);
  const totalTax = round(results.reduce((s, r) => s + r.tax, 0), dec);
  const totalDiscount = round(lines.reduce((s, l) => s + (l.discount || 0), 0), dec);
  const total = round(subtotal + totalTax, dec);
  return { subtotal, totalDiscount, totalTax, total, lines: results };
}
