// ============================================================================
// ZATCA المرحلة الثانية (Z5.1a) — الفئة الضريبية للصنف في بطاقة المنتج: التطبيع والفحص عند الحفظ
// ----------------------------------------------------------------------------
// z5_plan §3 Z5.1a (routes/products.ts): تُقبل vatCategory وvatExemptionCode وvatExemptionReason لشركة تجمع بيانات الفوترة
// وحدها. القواعد مرآة فحص البنود في preflight.ts (فلا يُحفظ صنف سيرفضه الإصدار):
//   • الفئة ∈ S/Z/E/O. الفارغة مقبولة (null ⇒ S حين النسبة > 0؛ وبنسبة 0% يعدّها تقرير الجاهزية).
//   • S: النسبة 15% أو 5% (BR-KSA-84) وبلا رمز ولا سبب إعفاء (BR-S-10).
//   • Z/E/O: النسبة 0% (BR-x-05)، ورمز من VATEX_CATEGORY لفئته نفسها (BR-KSA-CL-04)، ونصّ سبب (BR-KSA-24).
// مكتفٍ بذاته (validators.ts وحده). لا يستورد services/gl.
// ============================================================================

import { charLength, sanitizeText, TEXT_MAX_CHARS, VATEX_CATEGORY } from './validators';

export const PRODUCT_VAT_FIELDS = ['vatCategory', 'vatExemptionCode', 'vatExemptionReason'] as const;
export type ProductVatField = (typeof PRODUCT_VAT_FIELDS)[number];
export type ProductVatPatch = Partial<Record<ProductVatField, string | null>>;
export const VAT_CATEGORY_CODES = ['S', 'Z', 'E', 'O'] as const;

export interface ProductVatFieldError {
  field: ProductVatField | 'taxPct';
  messageAr: string;
}

const has = (o: unknown, k: string): boolean =>
  !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k) && (o as Record<string, unknown>)[k] !== undefined;

/** هل يحمل الجسم أحد حقول الفئة الضريبية؟ (غيابها ⇒ لا قراءة لبوابة الشركة.) */
export function bodyTouchesProductVat(body: unknown): boolean {
  return PRODUCT_VAT_FIELDS.some(f => has(body, f));
}

/** قصّ، الفئة والرمز بأحرف كبيرة، '' ⇒ null؛ قيمة ليست نصاً ولا null ⇒ خطأ. */
export function normalizeProductVat(body: unknown): { patch: ProductVatPatch; errors: ProductVatFieldError[] } {
  const patch: ProductVatPatch = {};
  const errors: ProductVatFieldError[] = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { patch, errors };
  const b = body as Record<string, unknown>;
  for (const f of PRODUCT_VAT_FIELDS) {
    if (!has(b, f)) continue;
    const v = b[f];
    if (v === null) { patch[f] = null; continue; }
    if (typeof v !== 'string') { errors.push({ field: f, messageAr: 'قيمة غير صالحة' }); continue; }
    let s = v.trim();
    if (f !== 'vatExemptionReason') s = s.toUpperCase();
    patch[f] = s === '' ? null : s;
  }
  return { patch, errors };
}

/** الحالة المدمجة بعد الحفظ (المُرسل فوق المحفوظ، والنسبة الفعلية). */
export interface ProductVatState {
  vatCategory: string | null;
  vatExemptionCode: string | null;
  vatExemptionReason: string | null;
  taxPct: number | null;
}

const pctIs = (p: number | null, target: number) => typeof p === 'number' && Number.isFinite(p) && Math.abs(p - target) < 1e-9;

export function validateProductVat(s: ProductVatState): ProductVatFieldError[] {
  const errors: ProductVatFieldError[] = [];
  const cat = s.vatCategory;
  const code = s.vatExemptionCode;
  const reason = s.vatExemptionReason;
  if (reason !== null) {
    if (sanitizeText(reason) !== reason) errors.push({ field: 'vatExemptionReason', messageAr: 'نصّ سبب الإعفاء يحتوي محارف غير مسموحة' });
    else if (charLength(reason) > TEXT_MAX_CHARS) errors.push({ field: 'vatExemptionReason', messageAr: `نصّ سبب الإعفاء أطول من ${TEXT_MAX_CHARS} حرف` });
  }
  if (cat === null) {
    if (code !== null || reason !== null) errors.push({ field: 'vatCategory', messageAr: 'اختر الفئة الضريبية (صفرية أو معفاة أو خارج النطاق) لرمز الإعفاء' });
    return errors;
  }
  if (!(VAT_CATEGORY_CODES as readonly string[]).includes(cat)) {
    errors.push({ field: 'vatCategory', messageAr: 'الفئة الضريبية غير صالحة (S أو Z أو E أو O)' });
    return errors;
  }
  if (cat === 'S') {
    if (!pctIs(s.taxPct, 15) && !pctIs(s.taxPct, 5)) errors.push({ field: 'taxPct', messageAr: 'نسبة الضريبة للفئة القياسية يجب أن تكون 15% أو 5%' });
    if (code !== null || reason !== null) errors.push({ field: 'vatExemptionCode', messageAr: 'الفئة القياسية لا تحمل رمز إعفاء ولا سببه' });
    return errors;
  }
  if (!pctIs(s.taxPct, 0)) errors.push({ field: 'taxPct', messageAr: 'نسبة الضريبة للفئة الصفرية أو المعفاة أو خارج النطاق يجب أن تكون 0%' });
  if (code === null) errors.push({ field: 'vatExemptionCode', messageAr: 'اختر رمز سبب الإعفاء أو الصفرية' });
  else if (VATEX_CATEGORY[code] !== cat) errors.push({ field: 'vatExemptionCode', messageAr: `رمز الإعفاء ${code} غير صالح للفئة ${cat}` });
  if (reason === null || reason.trim() === '') errors.push({ field: 'vatExemptionReason', messageAr: 'أدخل نصّ سبب الإعفاء أو الصفرية' });
  return errors;
}
