/**
 * «نصوص المطبوعات» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — قراءة العمود CompanySettings.printTexts وحفظه.
 *
 * البنية والقواعد كلها في printTextsCore.ts (منسوخة حرفياً في الواجهة): هنا حدّ الحجم قبل التحليل، والتحليل الصارم للحفظ،
 * والقراءة المتسامحة للعرض. null في العمود = نصوص اليوم حرفياً — والإعداد الذي لا أثر له (isEmptyPrintTexts) يُحفظ null.
 */
import {
  PRINT_TEXTS_ISSUES, PRINT_TEXTS_LIMITS, checkPrintTexts, emptyPrintTexts, isEmptyPrintTexts, printTextsBytes,
  type PrintTextsIssue, type PrintTextsV1,
} from './printTextsCore';

export * from './printTextsCore';

export type PrintTextsParse =
  | { ok: true; value: PrintTextsV1 | null }
  | { ok: false; status: 400 | 413; code: 'PRINT_TEXTS_INVALID' | 'PRINT_TEXTS_TOO_LARGE'; message: string; issues: PrintTextsIssue[] };

/** «استعادة النصوص الافتراضية»: جسم PUT هو JSON null أو { reset: true } وحده ⇒ يُكتب العمود null */
export function isPrintTextsReset(body: unknown): boolean {
  if (body === null) return true;
  if (typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length === 1 && keys[0] === 'reset' && (body as { reset?: unknown }).reset === true;
}

/** جسم PUT /api/company/print-texts ⇒ الصورة القانونية للحفظ (null لإعدادٍ بلا أثر)، أو سبب الرفض برسالة عربية */
export function parsePrintTexts(body: unknown): PrintTextsParse {
  if (printTextsBytes(body ?? null) > PRINT_TEXTS_LIMITS.maxBytes) {
    return { ok: false, status: 413, code: 'PRINT_TEXTS_TOO_LARGE', message: PRINT_TEXTS_ISSUES.tooLarge, issues: [{ path: '', message: PRINT_TEXTS_ISSUES.tooLarge }] };
  }
  const r = checkPrintTexts(body, true);
  if (!r.ok) return { ok: false, status: 400, code: 'PRINT_TEXTS_INVALID', message: r.issues[0]?.message ?? PRINT_TEXTS_ISSUES.shape, issues: r.issues };
  return { ok: true, value: isEmptyPrintTexts(r.value) ? null : r.value };
}

/** القيمة المخزّنة ⇒ ما يُعرض في المحرّر. stored: false = نصوص اليوم (null أو قيمة لا تصلح) */
export function storedPrintTexts(raw: unknown): { texts: PrintTextsV1; stored: boolean } {
  if (raw === null || raw === undefined) return { texts: emptyPrintTexts(), stored: false };
  const r = checkPrintTexts(raw, false);
  if (r.ok) return { texts: r.value, stored: !isEmptyPrintTexts(r.value) };
  console.warn('[print-texts] قيمة مخزّنة غير صالحة — تُقرأ افتراضياً', r.issues.slice(0, 3));
  return { texts: emptyPrintTexts(), stored: false };
}
