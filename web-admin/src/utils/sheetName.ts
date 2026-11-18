/**
 * اسم ورقة Excel صالح لمكتبة SheetJS (check_ws_name) ولبرنامج Excel نفسه، في موضعٍ واحد يمرّ به كل تصدير (utils/excel buildBlob):
 * - بلا المحارف الممنوعة `: \ / ? * [ ]` — تُستبدل بمسافة وتُطوى المسافات. ترجمةٌ فيها «:» (التركية لـ«الضريبة حسب» = «KDV dağılımı:»)
 *   كانت ترمي «Sheet name cannot contain : \ / ? * [ ]» فيسقط التصدير بلا ملفٍ ولا رسالة؛
 * - لا يبدأ ولا ينتهي بفاصلةٍ عليا، وليس «History» (محجوز)، وغير فارغ (يصير «Sheet»)؛
 * - حتى ٣١ وحدة UTF-16 (حدّ المكتبة بـlength) دون شطر محرفٍ مزدوج؛
 * - فريدٌ في المصنَّف بلا تمييز حالة الأحرف (كما يقارن Excel): المكرَّر يأخذ « (2)» و« (3)»… مقصوصاً أصلُه ليبقى ضمن الحدّ.
 */
export const SHEET_NAME_MAX = 31;

/** يقصّ إلى حدٍّ بوحدات UTF-16 دون أن يترك نصف محرفٍ مزدوج (رمزٌ تعبيري) في آخره */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** تنظيف الحواف: المسافات والفواصل العليا (الممنوعة أولاً وآخراً) */
const tidy = (s: string): string => s.trim().replace(/^'+|'+$/g, '').trim();

/**
 * اسمٌ صالح وفريد للورقة. `taken` يحمل الأسماء المستعملة (بأحرفٍ صغيرة) ويُحدَّث بالاسم المعاد — مرّر المجموعة نفسها لكل أوراق
 * المصنَّف الواحد.
 */
export function sheetNameOf(raw: string, taken: Set<string> = new Set()): string {
  let name = tidy(String(raw ?? '').replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' '));
  name = tidy(cut(name, SHEET_NAME_MAX)) || 'Sheet';
  if (name.toLowerCase() === 'history') name = 'History (1)';
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) {
    const suffix = ` (${i})`;
    out = `${tidy(cut(name, SHEET_NAME_MAX - suffix.length))}${suffix}`;
  }
  taken.add(out.toLowerCase());
  return out;
}
