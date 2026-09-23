import type { I18nNames } from '../../../../api/ledgerConfig';

/**
 * عرض شجرة البادئات وأوصاف الحسابات (م‑5 وم‑7 من مراجعة الخبير) — منطق صرف بلا React.
 *
 * م‑7: كانت العقد تحت الجذر تظهر أرقاماً عارية («61»، «611»، «62»). الخادم صار يعيد `names`
 * لكل مستوى، فيُعرض الاسم مع الرمز، والارتداد حين لا اسم يكون إلى الرمز وحده نظيفاً:
 * بلا شرطة ولا قوس فارغ ولا مسافة زائدة.
 *
 * م‑5: وصف الحساب نصّ يكتبه المحاسب أو يأتي من القالب، فقد يحوي أسطراً ومسافات مكرّرة.
 * `accountDescriptionText` يطويه سطراً واحداً ليصلح للخلية المقتطعة وللتلميح معاً.
 */

/** ترتيب الارتداد بعد لغة الواجهة: العربية مرجع القالب، ثم بقية اللغات. */
const FALLBACK_LANGS: readonly string[] = ['ar', 'en', 'fr', 'tr', 'zh'];

/**
 * اسم عقدة الشجرة باللغة المعروضة: لغة الواجهة ثم العربية ثم أول لغة فيها نصّ.
 * الفراغ (أو النصّ الفارغ أو المسافات وحدها) يعني «لا اسم» فيرتدّ العارض إلى الرمز وحده.
 */
export function treeNodeName(names: I18nNames | null | undefined, lang: string): string {
  if (!names) return '';
  for (const key of [lang, ...FALLBACK_LANGS]) {
    const v = names[key as keyof I18nNames];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** تسمية العقدة نصّاً واحداً («61 مصروفات التوزيع» أو «61» وحده) — للتلميح ولقارئ الشاشة. */
export function treeNodeLabel(prefix: string, name: string): string {
  const n = name.trim();
  return n ? `${prefix} ${n}` : prefix;
}

/** وصف الحساب معروضاً: الأسطر والمسافات المكرّرة تُطوى مسافةً واحدة، والفراغ يعني «لا وصف». */
export function accountDescriptionText(description: string | null | undefined): string {
  return typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
}
