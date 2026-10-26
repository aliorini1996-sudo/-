import { siteContentApi } from '../api/client';

/**
 * محتوى الموقع العام كما يُنشر — نقطة الجلب الوحيدة لصفحات الزائر (الرئيسية والأسعار والمدوّنة والتواصل
 * والصفحات القانونية وتطبيق المندوب والبروفايل).
 *
 * لماذا: HTML المُصيَّر وllms.txt يُبنيان من CMS مصحَّحاً بقائمة src/content/cmsFixes.ts (scripts/cms-content.mjs)
 * ما دام المالك لم يطبّق «تصحيحات الظهور» من المحرّر. لو رسم React بعد الإقلاع النص الخام لرأى جوجل (بعد JS)
 * نفياً قديماً للمرحلة الثانية يخالف ما قرأه في HTML. فالقائمة نفسها تُطبَّق هنا (publicCmsContent) على نسخة.
 *
 * ⚠️ المحرّران (SiteContentEditor وProfileEditorPanel) لا يستعملان هذا الملف: يقرآن CMS الخام بمفتاحيهما
 * ('site-content-edit' و'site-content')، والمالك يطبّق الزر ويحفظ بنفسه — لو قرآ المصحَّح لحُفظ دون مراجعته.
 * المفتاح هنا تحت البادئة 'site-content' فيُبطله حفظ أيٍّ من المحرّرين (invalidateQueries بالبادئة).
 * (cmsFixes.test.ts يحرس الفصل في الاتجاهين.)
 */
export const PUBLIC_SITE_CONTENT_KEY = ['site-content', 'public'] as const;

/**
 * يجلب CMS ويطبّق القائمة. وحدة القائمة (~٦٥ ك.ب نصاً) تُحمَّل بـimport() بالتوازي مع الطلب نفسه فلا تُثقل
 * الحزمة الأولى ولا تؤخّر العرض. إن تعذّر تحميلها أو تطبيقها يُعرض الخام — أفضل من صفحة بلا محتوى.
 */
export async function fetchPublicSiteContent<T = unknown>(): Promise<T> {
  const [res, mod] = await Promise.all([
    siteContentApi.get(),
    import('./cmsFixes').catch(() => null),
  ]);
  const data = (res.data?.data ?? null) as T;
  if (!mod || !data || typeof data !== 'object') return data;
  try {
    return mod.publicCmsContent(data).value;
  } catch {
    return data;
  }
}
