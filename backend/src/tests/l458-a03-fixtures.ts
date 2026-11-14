/**
 * L4 (A3) — مصفوفة فواتير المبيعات المشتركة بين اختبار الـbuilder ومولّد اللقطة الذهبية.
 *
 * الأبعاد (عقد L4+L5+L8 §8 A3): نوع المستند × وضع الضريبة × منازل العملة × pricesIncludeTax، ولكلٍّ ملفّا إعدادات.
 * الحمولة تحمل الحقول الجديدة دائماً (الختم والأقساط والاستحقاق المشتق وappliesTo وbaseQty وproductName): الشركة غير
 * المربوطة يجب أن تتجاهلها فيخرج قيدها **بايتاً بايتاً** كما كان قبل L4 — وهذا ما تثبته اللقطة الذهبية.
 * صرف حتمي: لا ساعة ولا عشوائية.
 */
import { createHash } from 'node:crypto';
import type { InvoiceKind, InvoicePayload } from '../services/gl/builders/invoice';
import type { BuildContext, GlSettingsSnapshot, VatCategory } from '../services/gl/types';
import { formatMilli, toMilli } from '../services/gl/money';
import { genericContext, saContext, type FixtureOverrides } from '../services/gl/testing/fixtures';
import { computeInvoiceTotals } from '../lib/invoiceCalc';

export const DOC_CASES = [
  'CASH_STAMPED', 'CASH_UNSTAMPED', 'CREDIT', 'CREDIT_INSTALLMENTS', 'RETURN_LINKED', 'RETURN_FREE', 'CREDIT_NOTE',
] as const;
export type DocCase = (typeof DOC_CASES)[number];

export const TAX_CASES = ['TAXED', 'TAX_FREE', 'ZERO', 'EXEMPT'] as const;
export type TaxCase = (typeof TAX_CASES)[number];

export const DECIMAL_CASES = [0, 2, 3] as const;

/** ملفّا إعدادات: A الافتراضي (خصم منفصل، مردودات مستقلة، نقد إلى الصندوق)، B عكسها مع حساب فئة */
export const PROFILES = ['A', 'B'] as const;
export type Profile = (typeof PROFILES)[number];

export const ENTRY_DATE = '2026-09-28';
/** فترة ربعية أخرى (OD17: vatAdjustment=true للمربوطة) */
export const REVERSE_DATE_OTHER_PERIOD = '2026-10-03';
/** الفترة نفسها */
export const REVERSE_DATE_SAME_PERIOD = '2026-09-30';

export const CATEGORY_ID = 'cat_juice';
export const CATEGORY_INCOME_CODE = '411002';

interface RawLine {
  productId: string | null;
  productName: string | null;
  categoryId?: string | null;
  qty: number;
  unitPrice: number;
  discountPct: number;
  baseQty: number;
}

/** الأسعار لكل منازل: كرتون (24 حبة) بخصم بند، وصنف ثانٍ، والصنف الأول ثانيةً بالحبة، وبند حرّ بلا صنف */
function rawLines(dec: number, profile: Profile): RawLine[] {
  const prices: Record<number, [number, number, number, number]> = {
    0: [10050, 4575, 420, 2000],
    2: [100.5, 45.75, 4.2, 20],
    3: [10.125, 4.575, 0.42, 2.5],
  };
  const [a, b, c, d] = prices[dec];
  const cat = profile === 'B' ? CATEGORY_ID : null;
  return [
    { productId: 'pA', productName: 'عصير برتقال', categoryId: cat, qty: 3, unitPrice: a, discountPct: 10, baseQty: 72 },
    { productId: 'pB', productName: 'مياه معدنية', qty: 2, unitPrice: b, discountPct: 0, baseQty: 2 },
    { productId: 'pA', productName: 'عصير برتقال', categoryId: cat, qty: 5, unitPrice: c, discountPct: 0, baseQty: 5 },
    { productId: null, productName: 'خدمة توصيل', qty: 1, unitPrice: d, discountPct: 0, baseQty: 1 },
  ];
}

export function contextFor(dec: number, overrides: FixtureOverrides = {}): BuildContext {
  if (dec === 2) return saContext(overrides);
  // منازل 3 (دينار بحريني) و0 (دينار عراقي) بنسبة 15٪ كي تتّحد خانات الضريبة الخاضعة في المصفوفة
  return genericContext(dec === 3 ? 'BH' : 'IQ', overrides, { vatPct: 15 });
}

export function profileSettings(profile: Profile): Partial<GlSettingsSnapshot> {
  return profile === 'A'
    ? { postSalesDiscountSeparately: true, postReturnsToContra: true, cashInvoiceRouting: 'MAIN_CASH' }
    : { postSalesDiscountSeparately: false, postReturnsToContra: false, cashInvoiceRouting: 'CUSTODY' };
}

export function profileOverrides(profile: Profile, extraSettings: Partial<GlSettingsSnapshot> = {}): FixtureOverrides {
  return {
    settings: { ...profileSettings(profile), ...extraSettings },
    ...(profile === 'B'
      ? { categoryAccounts: { [CATEGORY_ID]: { incomeAccountId: `acc_${CATEGORY_INCOME_CODE}`, expenseAccountId: null, cogsAccountId: null, inventoryAccountId: null } } }
      : {}),
  };
}

export interface MatrixCase {
  name: string;
  doc: DocCase;
  tax: TaxCase;
  dec: number;
  inclusive: boolean;
  profile: Profile;
  payload: InvoicePayload;
}

function kindOf(doc: DocCase): InvoiceKind {
  if (doc === 'CASH_STAMPED' || doc === 'CASH_UNSTAMPED') return 'CASH';
  if (doc === 'CREDIT' || doc === 'CREDIT_INSTALLMENTS') return 'CREDIT';
  return 'RETURN';
}

/** حمولة فاتورة المصفوفة — المبالغ من محرّك التسعير الحقيقي (computeInvoiceTotals) بخصم رأس 5٪ */
export function matrixPayload(doc: DocCase, tax: TaxCase, dec: number, inclusive: boolean, profile: Profile = 'A'): InvoicePayload {
  const type = kindOf(doc);
  const lines = rawLines(dec, profile);
  // B6: مرتجع مرتبط في وضع «إزالة الضريبة» يحتفظ بنسبة بند البيع (15٪) والختم taxFree باقٍ
  const b6 = tax === 'TAX_FREE' && doc === 'RETURN_LINKED';
  const pct = tax === 'TAXED' || b6 ? 15 : 0;
  const vatCategory: VatCategory | null = tax === 'EXEMPT' ? 'E' : null;
  const calc = computeInvoiceTotals(
    lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: pct })),
    { companyVat: 15, decimals: dec, invoiceDiscountPct: 5, pricesIncludeTax: inclusive },
  );
  const text = (v: number): string => formatMilli(toMilli(v, dec), dec);
  const totalMilli = toMilli(calc.total, dec);
  const number = type === 'RETURN' ? (doc === 'CREDIT_NOTE' ? 'CN-0001' : 'RET-0001') : 'INV-0001';

  const payload: InvoicePayload = {
    invoiceId: `inv_${doc}`,
    number,
    type,
    customerId: 'cust1',
    customerName: 'مؤسسة النور',
    salesRepId: 'rep1',
    salesRepName: 'خالد',
    entryDate: ENTRY_DATE,
    dueDate: type === 'CREDIT' ? '2026-10-28' : null,
    pricesIncludeTax: inclusive,
    subtotal: text(calc.subtotal),
    discountAmt: text(calc.discountAmt),
    taxAmt: text(calc.taxAmt),
    total: text(calc.total),
    currency: dec === 2 ? 'SAR' : dec === 3 ? 'BHD' : 'IQD',
    currencyDecimals: dec,
    ...(tax === 'TAX_FREE' ? { taxFree: true } : {}),
    ...(doc === 'CASH_STAMPED' ? { cashCollectedByRep: true } : {}),
    ...(doc === 'CREDIT' ? { dueDateDerived: true } : {}),
    ...(doc === 'CREDIT_INSTALLMENTS' ? { installments: installmentsOf(totalMilli, dec) } : {}),
    ...(doc === 'RETURN_LINKED' ? { appliesTo: { invoiceId: 'sale1', amount: text(calc.total) } } : {}),
    ...(doc === 'CREDIT_NOTE' ? { appliesTo: { invoiceId: 'orig1', amount: null } } : {}),
    items: calc.items.map((it, i) => ({
      productId: lines[i].productId,
      categoryId: lines[i].categoryId ?? null,
      qty: it.qty,
      unitPrice: it.unitPrice,
      taxPct: it.taxPct,
      taxAmt: text(it.taxAmt),
      lineTotal: text(it.lineTotal),
      ...(vatCategory ? { vatCategory } : {}),
      baseQty: lines[i].baseQty,
      ...(lines[i].productName ? { productName: lines[i].productName } : {}),
    })),
  };
  return payload;
}

/** ثلاثة أقساط (40٪، 30٪، الباقي) — بترتيب غير مرتّب عمداً كي يثبت الاختبار أنّ الـbuilder يرتّب بـseq */
export function installmentsOf(totalMilli: bigint, dec: number): { seq: number; dueDate: string; amount: string }[] {
  const unit = 10n ** BigInt(3 - dec);
  const part = (pct: bigint) => ((totalMilli * pct) / 100n / unit) * unit;
  const a1 = part(40n);
  const a2 = part(30n);
  const a3 = totalMilli - a1 - a2;
  return [
    { seq: 2, dueDate: '2026-11-28', amount: formatMilli(a2, dec) },
    { seq: 1, dueDate: '2026-10-28', amount: formatMilli(a1, dec) },
    { seq: 3, dueDate: '2026-12-28', amount: formatMilli(a3, dec) },
  ];
}

export function matrixCases(): MatrixCase[] {
  const out: MatrixCase[] = [];
  for (const profile of PROFILES) {
    for (const doc of DOC_CASES) {
      for (const tax of TAX_CASES) {
        for (const dec of DECIMAL_CASES) {
          for (const inclusive of [false, true]) {
            out.push({
              name: `${profile}/${doc}/${tax}/d${dec}/${inclusive ? 'incl' : 'excl'}`,
              doc, tax, dec, inclusive, profile,
              payload: matrixPayload(doc, tax, dec, inclusive, profile),
            });
          }
        }
      }
    }
  }
  return out;
}

/** تسلسل قانوني للقيد (BigInt ⇒ «123n») بترتيب المفاتيح كما أنشأها الـbuilder — للمقارنة «بايتاً» */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x.toString()}n` : x));
}

export function digest(v: unknown): string {
  return createHash('sha256').update(canonical(v)).digest('hex').slice(0, 12);
}

/** متغيّرات البناء التي تُلتقط لكل خانة: POST، وREVERSE لفترة أخرى، وREVERSE بلا ساق النقد للنقدية */
export const GOLDEN_VARIANTS = ['POST', 'REVERSE', 'REVERSE_KEEP_CASH'] as const;
export type GoldenVariant = (typeof GOLDEN_VARIANTS)[number];
