/**
 * مربعات إقرار ضريبة القيمة المضافة السعودي الستة عشر ومعانيها (DESIGN.md §7.8، §4.4، §8.7).
 *
 * بيانات صرفة: أي مربع يُخزَّن على السطور (`GlMoveLine.vatBox`)، وأي أعمدته تُحسب
 * (المبلغ = Σ وعاء بلا تعديل، التعديلات = Σ وعاء `vatAdjustment`، الضريبة)، وأيها مجموع
 * أو صافٍ أو تصحيح أو رصيد مرحّل. الحساب نفسه في `vat/returnSA.ts` (M5).
 * ⚠️ المربعات 2 و9 و13 و14 تُحسم من دليل ZATCA قبل إغلاق M5 (§7.8).
 */
import type { Milli, VatBoxSA } from '../types';
import type { TemplateNames } from '../coa/sa';

export type VatReturnBoxSA = VatBoxSA | 'SA_12' | 'SA_13' | 'SA_14' | 'SA_15' | 'SA_16';

export type VatBoxSection = 'SALES' | 'PURCHASES' | 'SUMMARY';

/**
 * LINE: مربع سطور (وعاء + تعديلات + ضريبة) — القيمة المخزّنة على GlMoveLine.vatBox.
 * TOTAL: مجموع مربعات سطور القسم (6، 12).
 * TAX_DUE: إجمالي الضريبة المستحقة للفترة (13).
 * CORRECTION: تصحيحات الفترات السابقة — آلي من المتأخر ومعه إضافة يدوية (14).
 * CARRY_FORWARD: رصيد دائن مرحّل من صافي الإقرار السابق السالب (15).
 * NET: صافي المستحق أو المسترد (16).
 */
export type VatBoxKind = 'LINE' | 'TOTAL' | 'TAX_DUE' | 'CORRECTION' | 'CARRY_FORWARD' | 'NET';

/** طبيعة ضريبة مربع السطور: RATED بالنسبة الأساسية، ZERO صفر بطبيعته (سطور MARKER).
 * SA_2 صفري تبعاً لـCIT_SALE في §4.4 (نسبة 0، فئة Z) — ⚠️ يُحسم من دليل ZATCA قبل M5. */
export type VatBoxTaxNature = 'RATED' | 'ZERO';

/** اتجاه ضريبة المربع من السطور: المبيعات Σ(دائن − مدين)، والمشتريات Σ(مدين − دائن). */
export type VatBoxTaxSign = 'CREDIT_MINUS_DEBIT' | 'DEBIT_MINUS_CREDIT';

export interface VatBoxDef {
  id: VatReturnBoxSA;
  no: number;
  section: VatBoxSection;
  kind: VatBoxKind;
  /** يُكتب على السطور ويقبله `GlTax.vatBox` */
  onLines: boolean;
  /** الأعمدة ذات المعنى: المبلغ (الوعاء)، التعديلات (وعاء vatAdjustment)، الضريبة */
  columns: { amount: boolean; adjustments: boolean; tax: boolean };
  taxNature: VatBoxTaxNature | null;
  taxSign: VatBoxTaxSign | null;
  /** مربعات السطور التي يجمعها (6، 12) */
  sumOf: readonly VatReturnBoxSA[];
  /** وصف الصيغة للمربعات المحسوبة */
  formula: string | null;
  /** 12: الضريبة القابلة للخصم فقط */
  deductibleTaxOnly: boolean;
  /** 14: تقبل إضافة يدوية بسبب مكتوب */
  allowsManualAmount: boolean;
  /** ⚠️ يُتحقق منه في دليل ZATCA قبل M5 */
  needsZatcaVerification: boolean;
  names: TemplateNames;
}

const n = (ar: string, en: string, fr: string, tr: string, zh: string): TemplateNames => ({ ar, en, fr, tr, zh });

function line(
  no: number, section: 'SALES' | 'PURCHASES', nature: VatBoxTaxNature, names: TemplateNames, verify = false,
): VatBoxDef {
  return {
    id: `SA_${no}` as VatReturnBoxSA,
    no,
    section,
    kind: 'LINE',
    onLines: true,
    columns: { amount: true, adjustments: true, tax: true },
    taxNature: nature,
    taxSign: section === 'SALES' ? 'CREDIT_MINUS_DEBIT' : 'DEBIT_MINUS_CREDIT',
    sumOf: [],
    formula: null,
    deductibleTaxOnly: false,
    allowsManualAmount: false,
    needsZatcaVerification: verify,
    names,
  };
}

function computed(
  no: number, section: VatBoxSection, kind: Exclude<VatBoxKind, 'LINE'>, columns: VatBoxDef['columns'],
  formula: string, names: TemplateNames, extra: Partial<VatBoxDef> = {},
): VatBoxDef {
  return {
    id: `SA_${no}` as VatReturnBoxSA,
    no,
    section,
    kind,
    onLines: false,
    columns,
    taxNature: null,
    taxSign: null,
    sumOf: [],
    formula,
    deductibleTaxOnly: false,
    allowsManualAmount: false,
    needsZatcaVerification: false,
    names,
    ...extra,
  };
}

export const VAT_RETURN_BOXES_SA: readonly VatBoxDef[] = [
  line(1, 'SALES', 'RATED', n('المبيعات الخاضعة للنسبة الأساسية', 'Standard Rated Sales', 'Ventes au taux normal', 'Genel Orana Tabi Satışlar', '标准税率销售')),
  line(2, 'SALES', 'ZERO', n('مبيعات المواطنين (صحة وتعليم خاص)', 'Sales to Citizens (Private Healthcare and Education)', 'Ventes aux citoyens (santé et enseignement privés)', 'Vatandaşlara Satışlar (Özel Sağlık ve Eğitim)', '向公民销售（私立医疗及教育）'), true),
  line(3, 'SALES', 'ZERO', n('المبيعات المحلية الصفرية', 'Zero Rated Domestic Sales', 'Ventes intérieures au taux zéro', 'Sıfır Oranlı Yurt İçi Satışlar', '国内零税率销售')),
  line(4, 'SALES', 'ZERO', n('الصادرات', 'Exports', 'Exportations', 'İhracat', '出口')),
  line(5, 'SALES', 'ZERO', n('المبيعات المعفاة', 'Exempt Sales', 'Ventes exonérées', 'İstisna Satışlar', '免税销售')),
  computed(6, 'SALES', 'TOTAL', { amount: true, adjustments: true, tax: true }, 'Σ SA_1..SA_5',
    n('إجمالي المبيعات', 'Total Sales', 'Total des ventes', 'Toplam Satışlar', '销售合计'),
    { sumOf: ['SA_1', 'SA_2', 'SA_3', 'SA_4', 'SA_5'] }),
  line(7, 'PURCHASES', 'RATED', n('المشتريات الخاضعة للنسبة الأساسية', 'Standard Rated Domestic Purchases', 'Achats au taux normal', 'Genel Orana Tabi Alışlar', '标准税率采购')),
  line(8, 'PURCHASES', 'RATED', n('الاستيراد الخاضع المدفوع للجمارك', 'Imports Subject to VAT Paid at Customs', 'Importations taxables payées en douane', 'Gümrükte KDV Ödenen İthalat', '已在海关缴纳增值税的进口')),
  line(9, 'PURCHASES', 'RATED', n('الاستيراد الخاضع للاحتساب العكسي', 'Imports Subject to VAT under Reverse Charge', 'Importations taxables en autoliquidation', 'Sorumlu Sıfatıyla KDV’ye Tabi İthalat', '适用反向征收的应税进口'), true),
  line(10, 'PURCHASES', 'ZERO', n('المشتريات الصفرية', 'Zero Rated Purchases', 'Achats au taux zéro', 'Sıfır Oranlı Alışlar', '零税率采购')),
  line(11, 'PURCHASES', 'ZERO', n('المشتريات المعفاة', 'Exempt Purchases', 'Achats exonérés', 'İstisna Alışlar', '免税采购')),
  computed(12, 'PURCHASES', 'TOTAL', { amount: true, adjustments: true, tax: true }, 'Σ SA_7..SA_11',
    n('إجمالي المشتريات', 'Total Purchases', 'Total des achats', 'Toplam Alışlar', '采购合计'),
    { sumOf: ['SA_7', 'SA_8', 'SA_9', 'SA_10', 'SA_11'], deductibleTaxOnly: true }),
  computed(13, 'SUMMARY', 'TAX_DUE', { amount: false, adjustments: false, tax: true }, 'tax(SA_6) − tax(SA_12) + RC output',
    n('إجمالي الضريبة المستحقة للفترة', 'Total VAT Due for the Period', 'TVA totale due pour la période', 'Dönem İçin Toplam Ödenecek KDV', '本期应交增值税合计'),
    { needsZatcaVerification: true }),
  computed(14, 'SUMMARY', 'CORRECTION', { amount: true, adjustments: false, tax: false }, 'late lines from FILED periods (output − deductible input) + manual',
    n('تصحيحات الفترة السابقة', 'Corrections from Previous Periods', 'Corrections des périodes précédentes', 'Önceki Dönem Düzeltmeleri', '以前期间更正'),
    { allowsManualAmount: true, needsZatcaVerification: true }),
  computed(15, 'SUMMARY', 'CARRY_FORWARD', { amount: true, adjustments: false, tax: false }, 'previous negative net return',
    n('رصيد دائن مرحّل من فترات سابقة', 'VAT Credit Carried Forward from Previous Periods', 'Crédit de TVA reporté des périodes précédentes', 'Önceki Dönemlerden Devreden KDV', '以前期间结转的留抵税额')),
  computed(16, 'SUMMARY', 'NET', { amount: true, adjustments: false, tax: false }, 'SA_13 + SA_14 − SA_15',
    n('صافي الضريبة المستحقة (أو المستردة)', 'Net VAT Due (or Reclaimed)', 'TVA nette due (ou à récupérer)', 'Net Ödenecek (veya İade Alınacak) KDV', '应交（或应退）增值税净额')),
];

/** عتبة تحذير المربع 14: |المجموع| > 5,000 ريال «تتطلب إفصاحاً طوعياً» ⚠️ (§7.8) — بالملّي. */
export const SA_CORRECTION_DISCLOSURE_THRESHOLD_MILLI: Milli = 5_000_000n;

const BY_ID = new Map<string, VatBoxDef>(VAT_RETURN_BOXES_SA.map((b) => [b.id, b]));

export function vatBoxDef(id: string): VatBoxDef | null {
  return BY_ID.get(id) ?? null;
}

/** مربعات السطور (1–5، 7–11) — القيم المسموحة في GlTax.vatBox وGlMoveLine.vatBox. */
export const LINE_VAT_BOXES_SA: readonly VatBoxSA[] =
  VAT_RETURN_BOXES_SA.filter((b) => b.onLines).map((b) => b.id as VatBoxSA);
export const SALES_LINE_BOXES_SA: readonly VatBoxSA[] =
  VAT_RETURN_BOXES_SA.filter((b) => b.onLines && b.section === 'SALES').map((b) => b.id as VatBoxSA);
export const PURCHASE_LINE_BOXES_SA: readonly VatBoxSA[] =
  VAT_RETURN_BOXES_SA.filter((b) => b.onLines && b.section === 'PURCHASES').map((b) => b.id as VatBoxSA);

export function isLineVatBoxSA(v: unknown): v is VatBoxSA {
  return typeof v === 'string' && (LINE_VAT_BOXES_SA as readonly string[]).includes(v);
}

/** ضريبة سطر في مربعه بالإشارة الصحيحة: مبيعات دائن − مدين، مشتريات مدين − دائن. null لغير مربعات السطور. */
export function vatBoxLineTaxMilli(box: string, debitMilli: Milli, creditMilli: Milli): Milli | null {
  const def = BY_ID.get(box);
  if (!def || !def.onLines) return null;
  return def.taxSign === 'CREDIT_MINUS_DEBIT' ? creditMilli - debitMilli : debitMilli - creditMilli;
}
