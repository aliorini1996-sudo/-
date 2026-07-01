// ============================================================================
// محرّك ضريبة مرن (Tax Engine) — أساس التدويل (المرحلة 0)
// ----------------------------------------------------------------------------
// يحسب الضريبة لكل بند بنسبة قابلة للتخصيص (لكل دولة/فئة منتج)، ويدعم:
//   • السعر شامل الضريبة أو غير شامل (inclusive / exclusive)
//   • الإعفاء (نسبة 0)
//   • التقريب حسب الخانات العشرية لعملة الدولة (٢ أو ٣)
// نقيّ وقابل للاختبار — يُطبَّق لاحقًا في backend لاعتماد الفاتورة رسميًا.
// ============================================================================
import { currencyDecimals } from '../i18n/countries';

export interface TaxLineInput {
  qty: number;
  unitPrice: number;   // سعر الوحدة
  taxPct?: number;     // نسبة ضريبة البند (تُورَث من افتراضي الدولة إن غابت)
  discount?: number;   // خصم على مستوى البند (بقيمة العملة)
  exempt?: boolean;    // إعفاء صريح من الضريبة
}

export interface TaxLineResult {
  net: number;         // الصافي قبل الضريبة (بعد الخصم)
  tax: number;         // مبلغ الضريبة
  gross: number;       // الإجمالي شامل الضريبة
  taxPct: number;
}

export interface TaxTotals {
  subtotal: number;    // مجموع الصافي قبل الضريبة
  totalDiscount: number;
  totalTax: number;
  total: number;       // الإجمالي النهائي شامل الضريبة
  lines: TaxLineResult[];
}

export interface TaxOptions {
  defaultTaxPct: number;         // نسبة الدولة الافتراضية
  pricesIncludeTax?: boolean;    // هل الأسعار المدخلة شاملة الضريبة؟
  currency?: string;             // لتحديد خانات التقريب (افتراضي SAR)
}

// تقريب مصرفيّ إلى عدد خانات محدّد (يتجنّب أخطاء الفاصلة العائمة)
function round(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * f) / f;
}

// يحسب ضريبة بند واحد
export function computeLine(line: TaxLineInput, opts: TaxOptions): TaxLineResult {
  const dec = currencyDecimals(opts.currency || 'SAR');
  const pct = line.exempt ? 0 : (line.taxPct ?? opts.defaultTaxPct);
  const rawBase = line.qty * line.unitPrice - (line.discount || 0);
  const base = Math.max(0, rawBase);

  let net: number, tax: number;
  if (opts.pricesIncludeTax && pct > 0) {
    // السعر شامل الضريبة: نستخرج الصافي والضريبة منه
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

// يحسب إجماليات الفاتورة كاملة
export function computeInvoice(lines: TaxLineInput[], opts: TaxOptions): TaxTotals {
  const dec = currencyDecimals(opts.currency || 'SAR');
  const results = lines.map((l) => computeLine(l, opts));
  const subtotal = round(results.reduce((s, r) => s + r.net, 0), dec);
  const totalTax = round(results.reduce((s, r) => s + r.tax, 0), dec);
  const totalDiscount = round(lines.reduce((s, l) => s + (l.discount || 0), 0), dec);
  const total = round(subtotal + totalTax, dec);
  return { subtotal, totalDiscount, totalTax, total, lines: results };
}
