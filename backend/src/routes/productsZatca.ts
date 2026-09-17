// ============================================================================
// فوترة ZATCA المرحلة الثانية (Z5.1a) — الفئة الضريبية في مساري إنشاء الصنف وتعديله (/api/products)
// ----------------------------------------------------------------------------
// z5_plan §3 Z5.1a: vatCategory وvatExemptionCode وvatExemptionReason تُقبل لشركة تجمع بيانات الفوترة ((العلم || التفعيل) && SA)
// وحدها. غير الجامعة كما اليوم حرفياً: مخطّط zod لم يتغيّر فتُسقط الحقول، ولا تُقرأ البوابة إلا إن حمل الجسم أحدها.
// الفحص على الحالة المدمجة (المُرسل فوق المحفوظ، والنسبة الفعلية) — compliance/zatca/productVat.ts.
// ============================================================================

import type { PrismaClient } from '@prisma/client';
import { loadBuyerCollect } from './customersZatca';
import {
  ProductVatFieldError, ProductVatPatch, bodyTouchesProductVat, normalizeProductVat, validateProductVat,
} from '../compliance/zatca/productVat';

export const PRODUCT_ZATCA_INVALID_MESSAGE = 'بيانات الفئة الضريبية للصنف غير صحيحة';

export function productZatcaInvalidBody(errors: readonly ProductVatFieldError[]): Record<string, unknown> {
  const list = [...new Set(errors.map(e => e.messageAr))].join('؛ ');
  return { success: false, code: 'PRODUCT_ZATCA_INVALID', message: list ? `${PRODUCT_ZATCA_INVALID_MESSAGE}: ${list}` : PRODUCT_ZATCA_INVALID_MESSAGE, fieldErrors: errors };
}

export type ProductVatGateResult = { ok: true; patch: ProductVatPatch } | { ok: false; status: number; body: Record<string, unknown> };

/** productId = null للإنشاء؛ taxPct = النسبة التي ستُحفظ (undefined/null ⇒ المحفوظة). */
export async function applyProductVatGate(
  db: Pick<PrismaClient, 'tenant' | 'product'>, body: unknown, tid: string, o: { productId: string | null; taxPct: number | null | undefined },
): Promise<ProductVatGateResult> {
  if (!bodyTouchesProductVat(body)) return { ok: true, patch: {} };
  if (!(await loadBuyerCollect(db, tid))) return { ok: true, patch: {} };
  const { patch, errors } = normalizeProductVat(body);
  if (errors.length > 0) return { ok: false, status: 400, body: productZatcaInvalidBody(errors) };
  const stored = o.productId
    ? await db.product.findFirst({ where: { id: o.productId, tenantId: tid }, select: { taxPct: true, vatCategory: true, vatExemptionCode: true, vatExemptionReason: true } })
    : null;
  const pick = (f: keyof ProductVatPatch): string | null => (f in patch ? patch[f] ?? null : stored?.[f] ?? null);
  const invalid = validateProductVat({
    vatCategory: pick('vatCategory'),
    vatExemptionCode: pick('vatExemptionCode'),
    vatExemptionReason: pick('vatExemptionReason'),
    taxPct: typeof o.taxPct === 'number' ? o.taxPct : stored?.taxPct ?? null,
  });
  if (invalid.length > 0) return { ok: false, status: 400, body: productZatcaInvalidBody(invalid) };
  return { ok: true, patch };
}
