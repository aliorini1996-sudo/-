/**
 * لغة الصفحة في الطلبات الواردة من الموقع العام (البند 16 من خطة GEO العالمية، ٨ نوفمبر ٢٠٢٦).
 *
 * الموقع سيُفتح بلغات جديدة تباعاً. وقائمة مغلقة (ar en fr tr zh) كانت سترفض أول طلب من صفحة
 * بلغة جديدة بـ400، فيضيع العميل. فالمقبول وسمُ لغة BCP-47 قصير صحيح البنية:
 *  - لغة أساسية بحرفين أو ثلاثة: es، pt، fil.
 *  - ثم وسوم فرعية (كتابة أو منطقة أو متغيّر) من ٢ إلى ٨ محارف: pt-BR، zh-Hant، es-419، sr-Latn-RS.
 *  - حالة الأحرف لا تهمّ (RFC 5646 §2.1.1)، فـ«EN» مقبولة كـ«en».
 *  - الحد ٣٥ محرفاً، وهو الحد الأدنى الذي يوصي به RFC 5646 §4.4.1 لتخزين الوسوم.
 *
 * والمرفوض: الشرطة السفلية (pt_BR)، والوسم الفرعي ذو المحرف الواحد (en-x-…)، والفراغات والرموز.
 * فالقيمة المقبولة حروف وأرقام وشرطات فقط، لا تحمل ما يُحقن في قالب بريد HTML.
 */
import { z } from 'zod';

export const PAGE_LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export const PAGE_LANG_MAX = 35;

export const pageLangSchema = z.string().trim().max(PAGE_LANG_MAX).regex(PAGE_LANG_RE);

let arNames: Intl.DisplayNames | null | undefined;
function arabicLanguageNames(): Intl.DisplayNames | null {
  if (arNames === undefined) {
    try { arNames = new Intl.DisplayNames(['ar'], { type: 'language' }); } catch { arNames = null; }
  }
  return arNames;
}

/**
 * اسم اللغة بالعربية مع رمزها لبريد الإدارة: «الإسبانية (es)».
 * لا ينهار مع أي وسم: الوسم الذي لا يعرفه ICU يُعرض كما هو (qqq)، والذي يرفضه (en-12) كذلك.
 */
export function pageLangLabel(tag: string): string {
  try {
    const name = arabicLanguageNames()?.of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) return `${name} (${tag})`;
  } catch { /* وسم يرفضه ICU: يُعرض رمزه وحده */ }
  return tag;
}
