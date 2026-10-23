/**
 * «إعدادات الطباعة» (طلب المالك ٢٣ أكتوبر ٢٠٢٦، التصميم §1.1) — قراءة العمود CompanySettings.printSettings وحفظه.
 *
 * البنية والقواعد كلها في printSettingsCore.ts (منسوخة حرفياً في الواجهة): هنا حدّ الحجم قبل التحليل، والتحليل الصارم
 * للحفظ، والقراءة المتسامحة للعرض. null في العمود = سلوك اليوم حرفياً (legacyPrintSettings) — والقيمة المخزّنة التي لا
 * تصلح (لا يُفترض أن تقع: الحفظ يمرّ من هنا وحده) تُقرأ افتراضياً كما يفعل الجهاز، فلا تُكسر الطباعة بسببها.
 */
import {
  PRINT_ISSUES, PRINT_LIMITS, checkPrintSettings, isLegacyPrintSettings, legacyPrintSettings, printSettingsBytes,
  type PrintIssue, type PrintSettingsV1,
} from './printSettingsCore';

export * from './printSettingsCore';

export type PrintSettingsParse =
  | { ok: true; value: PrintSettingsV1 }
  | { ok: false; status: 400 | 413; code: 'PRINT_SETTINGS_INVALID' | 'PRINT_SETTINGS_TOO_LARGE'; message: string; issues: PrintIssue[] };

/**
 * «استعادة الافتراضي»: جسم PUT هو JSON null أو { reset: true } وحده ⇒ يُكتب العمود null (سلوك اليوم حرفياً) لا نسخةٌ من
 * الافتراضي. (express.json الصارم يرفض null الخام قبل المسار، فالواجهة ترسل { reset: true }؛ null مقبولٌ لمن يصل به.)
 */
export function isPrintSettingsReset(body: unknown): boolean {
  if (body === null) return true;
  if (typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length === 1 && keys[0] === 'reset' && (body as { reset?: unknown }).reset === true;
}

/** جسم PUT /api/company/print-settings ⇒ الصورة القانونية للحفظ، أو سبب الرفض برسالة عربية (أول قاعدة) وقائمة القواعد */
export function parsePrintSettings(body: unknown): PrintSettingsParse {
  // الحجم أولاً — قبل أن يمشي zod على جسم ضخم (والحدّ يحرس صفّ الشركة المقروء مع كل /company)
  if (printSettingsBytes(body ?? null) > PRINT_LIMITS.maxBytes) {
    return { ok: false, status: 413, code: 'PRINT_SETTINGS_TOO_LARGE', message: PRINT_ISSUES.tooLarge, issues: [{ path: '', message: PRINT_ISSUES.tooLarge }] };
  }
  const r = checkPrintSettings(body, true);
  if (!r.ok) return { ok: false, status: 400, code: 'PRINT_SETTINGS_INVALID', message: r.issues[0]?.message ?? PRINT_ISSUES.shape, issues: r.issues };
  return { ok: true, value: r.value };
}

/**
 * القيمة المخزّنة ⇒ ما يُعرض ويُطبع به. stored: false = لا إعداد محفوظ صالح (السلوك الافتراضي) — ومنه كائنٌ يساوي الافتراضي
 * حرفياً (isLegacyPrintSettings): هو null في الأثر، فلا يُعرض «مخصّصاً».
 */
export function storedPrintSettings(raw: unknown): { settings: PrintSettingsV1; stored: boolean } {
  if (raw === null || raw === undefined) return { settings: legacyPrintSettings(), stored: false };
  const r = checkPrintSettings(raw, false);
  if (r.ok) return { settings: r.value, stored: !isLegacyPrintSettings(r.value) };
  console.warn('[print-settings] قيمة مخزّنة غير صالحة — تُقرأ افتراضياً', r.issues.slice(0, 3));
  return { settings: legacyPrintSettings(), stored: false };
}
