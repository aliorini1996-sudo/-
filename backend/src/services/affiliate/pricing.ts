/**
 * أسعار الباقات كما تُعرض للسفير في بوابته (تبويب «الباقات والأسعار») — منطقٌ خالص.
 *
 * المصدر **كتالوج الخادم المعتمد** (`QUOTE_PACKAGES` في services/quotes.ts) لا نسخةٌ ثانية:
 * سعرٌ يتغيّر هناك يتغيّر هنا.
 *
 * خصمٌ إقليميّ بقرار المالك (16 سبتمبر 2026): **سفير اليمن** — المُعرَّف بمفتاح جواله
 * ‎+967 المختار عند التسجيل — يرى الأسعار أقلّ بـ٣٣٪، مقرّبةً لأقرب ريال.
 */
import { QUOTE_PACKAGES, QuotePackageId } from '../quotes';

export interface RegionalDiscount {
  /** رمز الدولة ISO */
  region: string;
  /** بادئة الجوال الدولية المخزَّنة (أرقام بلا +) */
  dialPrefix: string;
  pct: number;
}

export const REGIONAL_DISCOUNTS: readonly RegionalDiscount[] = [
  { region: 'YE', dialPrefix: '967', pct: 33 },
];

/** الخصم الإقليميّ لجوال السفير المخزَّن (`967…` لليمن، `9665…` للسعودية) — أو null */
export function regionalDiscountFor(phone: string | null | undefined): RegionalDiscount | null {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (!digits) return null;
  return REGIONAL_DISCOUNTS.find((d) => digits.startsWith(d.dialPrefix)) ?? null;
}

/** سعرٌ بعد الخصم مقرَّباً لأقرب ريال — بالهللات */
export function discountedHalalas(riyals: number, pct: number): number {
  return Math.round((riyals * (100 - pct)) / 100) * 100;
}

export interface AffiliatePackagePrice {
  id: QuotePackageId;
  /** السعر المعلن (قبل الخصم الإقليميّ) — شامل الضريبة، بالهللات */
  listMonthlyHalalas: number;
  listYearlyHalalas: number;
  /** السعر المعروض لهذا السفير — شامل الضريبة، بالهللات */
  monthlyHalalas: number;
  yearlyHalalas: number;
}

export interface AffiliatePricing {
  region: string | null;
  discountPct: number;
  vatInclusive: true;
  packages: AffiliatePackagePrice[];
}

export function affiliatePricing(phone: string | null | undefined): AffiliatePricing {
  const d = regionalDiscountFor(phone);
  const pct = d?.pct ?? 0;
  const packages = (Object.keys(QUOTE_PACKAGES) as QuotePackageId[]).map((id) => {
    const p = QUOTE_PACKAGES[id];
    return {
      id,
      listMonthlyHalalas: p.total * 100,
      listYearlyHalalas: p.yearly * 100,
      monthlyHalalas: pct ? discountedHalalas(p.total, pct) : p.total * 100,
      yearlyHalalas: pct ? discountedHalalas(p.yearly, pct) : p.yearly * 100,
    };
  });
  return { region: d?.region ?? null, discountPct: pct, vatInclusive: true, packages };
}
