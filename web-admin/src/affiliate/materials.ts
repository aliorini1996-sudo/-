// ============================================================================
// ما تعرضه بطاقة «المادة التسويقية» في البوابة — نقيٌّ بلا React، فيُختبر في node.
//
// يُقرَّر من **بيانات المادّة** لا من فئتها وحدها (createMaterial في الخادم):
//   · الفيديو ملفٌّ قصير **أو** رابط — فالرابط يُفتح ويُنسخ للرابط والفيديو معاً، وأزرار الملف
//     (تنزيل/مشاركة) لمادّةٍ لها ملفٌّ فعلاً (mime/fileName/sizeBytes)؛ وإلا ردّ GET /materials/:id/file
//     بـ404 «الملف غير موجود» وما ظهر الرابط أبداً.
//   · النصّ الجاهز (تعليق المنشور) مسموحٌ مع أيّ فئة — يُعرض ويُنسخ أينما وُجد، وهو المحتوى
//     الأساسيّ لفئة «نصّ».
// ============================================================================
import { safeHttpUrl } from './format';
import type { MaterialRow } from './types';

export interface MaterialParts {
  /** للمادّة ملفٌّ مرفوع ⇒ «تنزيل» و«مشاركة» */
  file: boolean;
  /** رابط http(s) آمن ⇒ «فتح الرابط» و«نسخ» — أو null */
  url: string | null;
  /** النصّ الجاهز أو التعليق المرافق ⇒ يُعرض مع «نسخ النصّ» — أو null */
  text: string | null;
  /** النصّ هو المحتوى الأساسيّ (فئة «نصّ») ⇒ زرّ نسخه هو الزرّ الرئيسيّ */
  textIsMain: boolean;
}

export function materialParts(
  m: Pick<MaterialRow, 'category' | 'fileName' | 'mime' | 'sizeBytes' | 'url' | 'textBody'>,
): MaterialParts {
  const file = !!(m.mime || m.fileName || (typeof m.sizeBytes === 'number' && m.sizeBytes > 0));
  const text = typeof m.textBody === 'string' && m.textBody.trim() ? m.textBody : null;
  return { file, url: safeHttpUrl(m.url), text, textIsMain: m.category === 'text' };
}
