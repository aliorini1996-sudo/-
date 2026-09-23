/**
 * القالب العام `GENERIC_6D` للدول غير السعودية (DESIGN.md §4.2 «القالب العام»، §4.4، §8.7).
 *
 * نفس هيكل SA_6D (الرموز والأنواع والمفاتيح والدفاتر) مع ثلاثة فروق:
 *  1) أسماء الضريبة عامة («ضريبة المبيعات/القيمة المضافة»).
 *  2) الضرائب تُزرع من `COUNTRY_TAX[cc].defaultVatPct`، بلا مربعات ZATCA (vatBox = null).
 *  3) دول 0٪: حسابات الضريبة تُنشأ مؤرشفة، والضرائب isActive=false، وzeroRatedSalesTaxKey = null.
 * دالة صرفة: الدولة تُمرَّر صراحةً، وسجل الدول بيانات ثابتة بلا I/O.
 */
import type { GlSettingsSnapshot, TaxUse, VatCategory } from '../types';
import { COUNTRY_TAX } from '../../../config/countries';
import {
  SA_6D_ACCOUNT_GROUPS, SA_6D_ACCOUNTS, SA_6D_JOURNALS, VAT_ACCOUNT_CODES, mappingsFromAccounts,
  type AccountTemplate, type ChartTemplate, type TemplateNames,
} from './sa';
import type { TaxGroupKey, TaxGroupTemplate, TaxTemplate } from '../taxes/sa';

const n = (ar: string, en: string, fr: string, tr: string, zh: string): TemplateNames => ({ ar, en, fr, tr, zh });

/** أسماء عامة لحسابات الضريبة (الفرق 1). */
const GENERIC_VAT_ACCOUNT_NAMES: Readonly<Record<string, TemplateNames>> = {
  '116001': n('ضريبة المبيعات/القيمة المضافة: المدخلات', 'Sales Tax/VAT Input', 'Taxe sur les ventes/TVA déductible', 'Satış Vergisi/KDV - İndirilecek', '销售税/增值税进项'),
  '116002': n('ضريبة المبيعات/القيمة المضافة المستردة (صافي الإقرار)', 'Sales Tax/VAT Receivable (Net Return)', 'Crédit de taxe sur les ventes/TVA (solde de la déclaration)', 'İade Alınacak Satış Vergisi/KDV (Beyanname Neti)', '应退销售税/增值税（申报净额）'),
  '212001': n('ضريبة المبيعات/القيمة المضافة: المخرجات', 'Sales Tax/VAT Output', 'Taxe sur les ventes/TVA collectée', 'Satış Vergisi/KDV - Hesaplanan', '销售税/增值税销项'),
  '212002': n('ضريبة المبيعات/القيمة المضافة المستحقة (صافي الإقرار)', 'Sales Tax/VAT Payable (Net Return)', 'Taxe sur les ventes/TVA à payer (solde de la déclaration)', 'Ödenecek Satış Vergisi/KDV (Beyanname Neti)', '应交销售税/增值税（申报净额）'),
  '212003': n('ضريبة المخرجات: احتساب عكسي', 'Output Tax - Reverse Charge', 'Taxe collectée - autoliquidation', 'Hesaplanan Vergi - Sorumlu Sıfatıyla', '销项税－反向征收'),
  '212006': n('تصحيحات ضريبية لفترات سابقة', 'Prior Period Tax Corrections', 'Corrections de taxe des périodes antérieures', 'Önceki Dönem Vergi Düzeltmeleri', '以前期间税款更正'),
};

/**
 * أوصاف عامة لحسابات الضريبة (م‑5 مع الفرق 1): بقية الأوصاف من القالب السعودي كما هي،
 * وهذه وحدها تُستبدل كي لا تذكر «هيئة الزكاة» ولا صيغة الإقرار السعودي.
 */
const GENERIC_VAT_ACCOUNT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  '116001': 'ضريبة المشتريات والمصروفات المدفوعة للموردين، تُخصم من الضريبة المحصَّلة عند إعداد الإقرار الدوري',
  '116002': 'رصيد مستحق للمنشأة حين تفوق ضريبة المشتريات ضريبة المبيعات في إقرار الفترة',
  '212001': 'الضريبة المحصَّلة من العملاء على فواتير البيع، تُورَّد لمصلحة الضرائب في موعد الإقرار',
  '212002': 'المبلغ الواجب سداده لمصلحة الضرائب بعد خصم ضريبة المشتريات من ضريبة المبيعات',
  '212003': 'ضريبة على خدمات مستوردة تحتسبها المنشأة على نفسها وتخصمها في الإقرار ذاته',
  '212006': 'فروق ضريبة عن فترات سابقة تُصحَّح ضمن إقرار الفترة الحالية أو بإفصاح مستقل',
};

/** إعداد الدولة للقالب العام — يرمي RangeError لدولة غير معروفة (لا سقوط صامت إلى السعودية). */
export function genericCountry(countryCode: string): { code: string; currency: string; currencyDecimals: number; vatPct: number } {
  const cc = countryCode.trim().toUpperCase();
  const c = COUNTRY_TAX[cc];
  if (!c) throw new RangeError(`دولة غير معروفة للقالب العام: ${countryCode}`);
  return { code: c.code, currency: c.currency, currencyDecimals: c.currencyDecimals, vatPct: c.defaultVatPct };
}

/** مفتاح ضريبة النسبة الأساسية: 14 ⇒ S14_SALE، 7.5 ⇒ S7_5_SALE (على نمط S15_SALE). */
export function standardTaxKey(use: 'SALE' | 'PURCHASE', pct: number): string {
  if (!(Number.isFinite(pct) && pct > 0)) throw new RangeError(`نسبة غير صالحة لضريبة أساسية: ${pct}`);
  return `S${String(pct).replace('.', '_')}_${use === 'SALE' ? 'SALE' : 'PURCH'}`;
}

function pctLabel(pct: number): string {
  return String(pct);
}

export function genericAccounts(vatPct: number): AccountTemplate[] {
  const archiveVat = vatPct === 0;
  return SA_6D_ACCOUNTS.map((a) => {
    const names = GENERIC_VAT_ACCOUNT_NAMES[a.code] ?? a.names;
    const description = GENERIC_VAT_ACCOUNT_DESCRIPTIONS[a.code] ?? a.description;
    const isActive = archiveVat && VAT_ACCOUNT_CODES.includes(a.code) ? false : a.isActive;
    return { ...a, names, description, isActive };
  });
}

function gtax(
  key: string, use: TaxUse, rate: number, cat: VatCategory, accountCode: string | null, groupKey: TaxGroupKey,
  isActive: boolean, names: TemplateNames,
): TaxTemplate {
  return {
    key, use, rate, vatCategory: cat, priceInclude: false, accountCode, rcOutputAccountCode: null, deductible: true,
    vatBox: null, isActive, groupKey, needsZatcaVerification: false, names,
  };
}

/** ضرائب القالب العام من نسبة الدولة (الفرق 2 و3). */
export function genericTaxes(vatPct: number): TaxTemplate[] {
  const active = vatPct > 0;
  const out: TaxTemplate[] = [];
  if (active) {
    const p = pctLabel(vatPct);
    out.push(gtax(standardTaxKey('SALE', vatPct), 'SALE', vatPct, 'S', '212001', 'STANDARD', true,
      n(`ضريبة المبيعات/القيمة المضافة ${p}٪`, `Sales Tax/VAT ${p}%`, `Taxe sur les ventes/TVA ${p} %`, `Satış Vergisi/KDV %${p}`, `销售税/增值税${p}%`)));
  }
  out.push(
    gtax('Z_SALE', 'SALE', 0, 'Z', '212001', 'ZERO_EXEMPT', active, n('مبيعات صفرية', 'Zero-rated Sales', 'Ventes au taux zéro', 'Sıfır Oranlı Satışlar', '零税率销售')),
    gtax('E_SALE', 'SALE', 0, 'E', '212001', 'ZERO_EXEMPT', active, n('مبيعات معفاة', 'Exempt Sales', 'Ventes exonérées', 'İstisna Satışlar', '免税销售')),
    gtax('O_SALE', 'SALE', 0, 'O', null, 'OUT_OF_SCOPE', active, n('خارج نطاق الضريبة', 'Out of Scope Sales', 'Ventes hors champ de la taxe', 'Vergi Kapsamı Dışı Satışlar', '不属于征税范围的销售')),
  );
  if (active) {
    const p = pctLabel(vatPct);
    out.push(gtax(standardTaxKey('PURCHASE', vatPct), 'PURCHASE', vatPct, 'S', '116001', 'STANDARD', true,
      n(`مشتريات ${p}٪`, `Purchases ${p}%`, `Achats ${p} %`, `Alışlar %${p}`, `采购${p}%`)));
  }
  out.push(
    gtax('Z_PURCH', 'PURCHASE', 0, 'Z', '116001', 'ZERO_EXEMPT', active, n('مشتريات صفرية', 'Zero-rated Purchases', 'Achats au taux zéro', 'Sıfır Oranlı Alışlar', '零税率采购')),
    gtax('E_PURCH', 'PURCHASE', 0, 'E', '116001', 'ZERO_EXEMPT', active, n('مشتريات معفاة', 'Exempt Purchases', 'Achats exonérés', 'İstisna Alışlar', '免税采购')),
    gtax('O_PURCH', 'PURCHASE', 0, 'O', null, 'OUT_OF_SCOPE', active, n('مشتريات خارج النطاق', 'Out of Scope Purchases', 'Achats hors champ', 'Kapsam Dışı Alışlar', '不属于征税范围的采购')),
  );
  return out;
}

/** مجموعات الضرائب في القالب العام: «ضريبة المبيعات/القيمة المضافة» بلا نسبة سعودية مثبتة. */
export function genericTaxGroups(vatPct: number): TaxGroupTemplate[] {
  const p = pctLabel(vatPct);
  return [
    { key: 'STANDARD', seq: 1, names: n(`ضريبة المبيعات/القيمة المضافة ${p}٪`, `Sales Tax/VAT ${p}%`, `Taxe sur les ventes/TVA ${p} %`, `Satış Vergisi/KDV %${p}`, `销售税/增值税${p}%`) },
    { key: 'ZERO_EXEMPT', seq: 2, names: n('صفرية ومعفاة', 'Zero-rated and Exempt', 'Taux zéro et exonérées', 'Sıfır Oranlı ve İstisna', '零税率及免税') },
    { key: 'OUT_OF_SCOPE', seq: 3, names: n('خارج النطاق', 'Out of Scope', 'Hors champ', 'Kapsam Dışı', '不属于征税范围') },
  ];
}

export interface GenericTemplate extends ChartTemplate {
  countryCode: string;
  vatPct: number;
  taxes: readonly TaxTemplate[];
  taxGroups: readonly TaxGroupTemplate[];
  /** null لدول 0٪ */
  zeroRatedSalesTaxKey: string | null;
  defaultPurchaseTaxKey: string | null;
}

/**
 * يبني القالب العام لدولة. `opts.vatPct` يتجاوز نسبة السجل (للاختبار أو دولة مستقبلية).
 */
export function genericTemplate(countryCode: string, opts: { vatPct?: number } = {}): GenericTemplate {
  const c = genericCountry(countryCode);
  const vatPct = opts.vatPct ?? c.vatPct;
  if (!(Number.isFinite(vatPct) && vatPct >= 0 && vatPct < 100)) throw new RangeError(`نسبة ضريبة غير صالحة: ${vatPct}`);
  const accounts = genericAccounts(vatPct);
  return {
    key: 'GENERIC_6D',
    countryCode: c.code,
    vatPct,
    groups: SA_6D_ACCOUNT_GROUPS,
    accounts,
    journals: SA_6D_JOURNALS,
    mappings: mappingsFromAccounts(accounts),
    taxes: genericTaxes(vatPct),
    taxGroups: genericTaxGroups(vatPct),
    zeroRatedSalesTaxKey: vatPct > 0 ? 'Z_SALE' : null,
    defaultPurchaseTaxKey: vatPct > 0 ? standardTaxKey('PURCHASE', vatPct) : null,
  };
}

/**
 * موعد الإقرار الافتراضي للقالب العام (DAYS_AFTER، §6.6). عدد الأيام لم يحدده التصميم:
 * 30 قيمة ابتدائية يعرضها المعالج للتعديل.
 */
export const GENERIC_DEFAULT_TAX_DEADLINE_DAYS = 30;

/** إعدادات GlSettings المشتقة من القالب العام (دون المعرّفات — defaultPurchaseTaxId يُحلّ عند الزرع). */
export function genericSettings(countryCode: string, opts: { vatPct?: number } = {}): Partial<GlSettingsSnapshot> {
  const c = genericCountry(countryCode);
  const vatPct = opts.vatPct ?? c.vatPct;
  return {
    templateKey: 'GENERIC_6D',
    countryCode: c.code,
    currency: c.currency,
    currencyDecimals: c.currencyDecimals,
    taxDeadlineRule: 'DAYS_AFTER',
    taxDeadlineDays: GENERIC_DEFAULT_TAX_DEADLINE_DAYS,
    zeroRatedSalesTaxKey: vatPct > 0 ? 'Z_SALE' : null,
  };
}
