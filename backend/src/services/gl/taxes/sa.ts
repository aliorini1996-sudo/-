/**
 * الضرائب المزروعة للقالب السعودي `SA_6D` (DESIGN.md §4.4، §8.7).
 *
 * الحساب بالرمز لا بالمعرّف (يُحلّ عند الزرع). الضرائب الصفرية تحمل حساب سطر العلامة
 * (212001 للمبيعات، 116001 للمشتريات). O_SALE وO_PURCH بلا حساب ولا مربع ولا علامة.
 * NONDED15 بلا حساب: ضريبتها تُضاف للتكلفة (`deductible=false`).
 * ⚠️ CIT_SALE (SA_2) وRC15 (SA_9) يُتحقق منهما في دليل ZATCA قبل M5.
 */
import type { TaxUse, VatBoxSA, VatCategory } from '../types';
import type { TemplateNames } from '../coa/sa';

export const SA_TAX_GROUP_KEYS = ['STANDARD', 'ZERO_EXEMPT', 'OUT_OF_SCOPE'] as const;
export type TaxGroupKey = (typeof SA_TAX_GROUP_KEYS)[number];

export interface TaxGroupTemplate {
  key: TaxGroupKey;
  seq: number;
  names: TemplateNames;
}

export interface TaxTemplate {
  /** GlTax.key */
  key: string;
  use: TaxUse;
  rate: number;
  vatCategory: VatCategory;
  priceInclude: boolean;
  /** رمز حساب الضريبة أو العلامة؛ null ⇒ بلا حساب */
  accountCode: string | null;
  /** RC15: حساب مخرجات الاحتساب العكسي */
  rcOutputAccountCode: string | null;
  deductible: boolean;
  vatBox: VatBoxSA | null;
  isActive: boolean;
  /** GlTaxGroup (M5) — للعرض فقط */
  groupKey: TaxGroupKey;
  /** ⚠️ يُتحقق منه في دليل ZATCA قبل M5 */
  needsZatcaVerification: boolean;
  names: TemplateNames;
}

const n = (ar: string, en: string, fr: string, tr: string, zh: string): TemplateNames => ({ ar, en, fr, tr, zh });

export const SA_TAX_GROUPS: readonly TaxGroupTemplate[] = [
  { key: 'STANDARD', seq: 1, names: n('ضريبة القيمة المضافة 15٪', 'VAT 15%', 'TVA 15 %', 'KDV %15', '增值税15%') },
  { key: 'ZERO_EXEMPT', seq: 2, names: n('صفرية ومعفاة', 'Zero-rated and Exempt', 'Taux zéro et exonérées', 'Sıfır Oranlı ve İstisna', '零税率及免税') },
  { key: 'OUT_OF_SCOPE', seq: 3, names: n('خارج النطاق', 'Out of Scope', 'Hors champ', 'Kapsam Dışı', '不属于征税范围') },
];

interface TaxOpts {
  rc?: string;
  deductible?: boolean;
  verify?: boolean;
}

function tax(
  key: string, use: TaxUse, rate: number, cat: VatCategory, accountCode: string | null, vatBox: VatBoxSA | null,
  groupKey: TaxGroupKey, names: TemplateNames, o: TaxOpts = {},
): TaxTemplate {
  return {
    key,
    use,
    rate,
    vatCategory: cat,
    priceInclude: false,
    accountCode,
    rcOutputAccountCode: o.rc ?? null,
    deductible: o.deductible ?? true,
    vatBox,
    isActive: true,
    groupKey,
    needsZatcaVerification: o.verify ?? false,
    names,
  };
}

export const SA_TAXES: readonly TaxTemplate[] = [
  tax('S15_SALE', 'SALE', 15, 'S', '212001', 'SA_1', 'STANDARD', n('ضريبة مبيعات 15٪', 'Sales VAT 15%', 'TVA sur ventes 15 %', 'Satış KDV %15', '销售增值税15%')),
  tax('CIT_SALE', 'SALE', 0, 'Z', '212001', 'SA_2', 'ZERO_EXEMPT', n('مبيعات للمواطنين (صحة وتعليم خاص)', 'Sales to Citizens (Private Healthcare and Education)', 'Ventes aux citoyens (santé et enseignement privés)', 'Vatandaşlara Satışlar (Özel Sağlık ve Eğitim)', '向公民销售（私立医疗及教育）'), { verify: true }),
  tax('Z_SALE', 'SALE', 0, 'Z', '212001', 'SA_3', 'ZERO_EXEMPT', n('مبيعات محلية صفرية', 'Zero-rated Domestic Sales', 'Ventes intérieures au taux zéro', 'Sıfır Oranlı Yurt İçi Satışlar', '国内零税率销售')),
  tax('EXPORT', 'SALE', 0, 'Z', '212001', 'SA_4', 'ZERO_EXEMPT', n('صادرات', 'Exports', 'Exportations', 'İhracat', '出口')),
  tax('E_SALE', 'SALE', 0, 'E', '212001', 'SA_5', 'ZERO_EXEMPT', n('مبيعات معفاة', 'Exempt Sales', 'Ventes exonérées', 'İstisna Satışlar', '免税销售')),
  tax('O_SALE', 'SALE', 0, 'O', null, null, 'OUT_OF_SCOPE', n('خارج نطاق الضريبة', 'Out of Scope Sales', 'Ventes hors champ de la TVA', 'KDV Kapsamı Dışı Satışlar', '不属于征税范围的销售')),
  tax('S15_PURCH', 'PURCHASE', 15, 'S', '116001', 'SA_7', 'STANDARD', n('مشتريات 15٪', 'Purchases 15%', 'Achats 15 %', 'Alışlar %15', '采购15%')),
  tax('IMP_CUSTOMS', 'PURCHASE', 15, 'S', '116001', 'SA_8', 'STANDARD', n('استيراد 15٪ مدفوع للجمارك', 'Imports 15% Paid at Customs', 'Importations 15 % payées en douane', 'Gümrükte Ödenen İthalat %15', '进口15%（海关缴纳）')),
  tax('RC15', 'PURCHASE', 15, 'S', '116001', 'SA_9', 'STANDARD', n('استيراد خدمات بالاحتساب العكسي 15٪', 'Imported Services 15% Reverse Charge', 'Services importés 15 % en autoliquidation', 'Sorumlu Sıfatıyla İthal Hizmetler %15', '进口服务15%（反向征收）'), { rc: '212003', verify: true }),
  tax('Z_PURCH', 'PURCHASE', 0, 'Z', '116001', 'SA_10', 'ZERO_EXEMPT', n('مشتريات صفرية', 'Zero-rated Purchases', 'Achats au taux zéro', 'Sıfır Oranlı Alışlar', '零税率采购')),
  tax('E_PURCH', 'PURCHASE', 0, 'E', '116001', 'SA_11', 'ZERO_EXEMPT', n('مشتريات معفاة', 'Exempt Purchases', 'Achats exonérés', 'İstisna Alışlar', '免税采购')),
  tax('O_PURCH', 'PURCHASE', 0, 'O', null, null, 'OUT_OF_SCOPE', n('مشتريات خارج النطاق', 'Out of Scope Purchases', 'Achats hors champ', 'Kapsam Dışı Alışlar', '不属于征税范围的采购')),
  tax('NONDED15', 'PURCHASE', 15, 'S', null, null, 'STANDARD', n('مشتريات 15٪ غير قابلة للخصم', 'Non-deductible Purchases 15%', 'Achats 15 % non déductibles', 'İndirilemeyen Alışlar %15', '不可抵扣采购15%'), { deductible: false }),
];

/** افتراضي `zeroRatedSalesTaxKey` و`defaultPurchaseTaxId` (بمفتاحه) في القالب السعودي (§3.2). */
export const SA_ZERO_RATED_SALES_TAX_KEY = 'Z_SALE';
export const SA_DEFAULT_PURCHASE_TAX_KEY = 'S15_PURCH';

export function saTaxByKey(key: string): TaxTemplate | null {
  return SA_TAXES.find((t) => t.key === key) ?? null;
}
