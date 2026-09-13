// ============================================================================
// مسودّة نموذج الانضمام في sessionStorage — تبقى عبر الرجوع والتقدّم والتنقّل
// إلى الدخول ثم العودة، وتُمسح بعد إرسالٍ ناجح أو بانتهاء الجلسة (إغلاق التبويب).
//
// · كلمة المرور **لا تُحفظ أبداً**.
// · الموافقة على الشروط لا تُحفظ: تُعطى للنصّ المعروض وقت الإرسال، وقد يُنشر
//   إصدارٌ جديد بين الحفظ والعودة.
// · كل وصولٍ إلى التخزين داخل try/catch — التخزين المحجوب لا يُسقط النموذج.
// ============================================================================
import { EMPTY_REGISTER, type RegisterForm } from './validation';

export const REGISTER_DRAFT_KEY = 'ax_register_draft';

/** ما يُحفظ من النموذج: كل شيءٍ عدا كلمة المرور والموافقة على الشروط */
export type RegisterDraft = Omit<RegisterForm, 'password' | 'acceptTerms'>;

function session(): Storage | null {
  try { return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null; } catch { return null; }
}

const TEXT_FIELDS = ['fullName', 'email', 'phone', 'city', 'vatNumber'] as const;
const TEXT_MAX = 200;

/** يستخرج من النموذج ما يجوز حفظه — بلا كلمة المرور ولا الموافقة على الشروط */
export function draftOf(f: RegisterForm): RegisterDraft {
  return {
    fullName: f.fullName, email: f.email, phone: f.phone, city: f.city,
    vatNumber: f.vatNumber, marketingConsent: f.marketingConsent,
  };
}

/** مسودّةٌ بلا أي قيمة مُدخلة لا تستحق الحفظ */
export function isEmptyDraft(d: RegisterDraft): boolean {
  return TEXT_FIELDS.every((k) => !d[k].trim()) && !d.marketingConsent;
}

export function saveRegisterDraft(f: RegisterForm): void {
  const d = draftOf(f);
  try {
    const s = session();
    if (!s) return;
    if (isEmptyDraft(d)) s.removeItem(REGISTER_DRAFT_KEY);
    else s.setItem(REGISTER_DRAFT_KEY, JSON.stringify(d));
  } catch { /* تخزين محجوب — النموذج يعمل بلا مسودّة */ }
}

/**
 * يقرأ المسودّة ويدمجها في نموذجٍ فارغ بأنواعٍ مُتحقَّقة (قيمةٌ تالفة تُهمل حقلها
 * لا النموذج كلّه). كلمة المرور فارغة والموافقة على الشروط غير مؤشَّرة دائماً،
 * وأي حقلٍ قديم في مسودّةٍ سابقة (كإقرارات أو «موثوق») يُتجاهل.
 */
export function loadRegisterDraft(): RegisterForm | null {
  let raw: string | null = null;
  try { raw = session()?.getItem(REGISTER_DRAFT_KEY) ?? null; } catch { return null; }
  if (!raw) return null;
  let obj: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { obj = null; }
  if (!obj) { clearRegisterDraft(); return null; }

  const form: RegisterForm = { ...EMPTY_REGISTER };
  for (const k of TEXT_FIELDS) {
    const v = obj[k];
    if (typeof v === 'string') form[k] = v.slice(0, TEXT_MAX);
  }
  if (typeof obj.marketingConsent === 'boolean') form.marketingConsent = obj.marketingConsent;
  form.password = '';
  form.acceptTerms = false;
  return form;
}

export function clearRegisterDraft(): void {
  try { session()?.removeItem(REGISTER_DRAFT_KEY); } catch { /* تجاهل */ }
}
