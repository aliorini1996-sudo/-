import { useQuery } from '@tanstack/react-query';
import { PUBLIC_SITE_CONTENT_KEY, fetchPublicSiteContent } from '../content/publicSiteContent';
import { useLang } from '../i18n/lang';
import { effectivePosts, BlogPost } from './posts';

// يجلب مقالات المدوّنة من محتوى الـCMS العام (المفتاح blog) مع العودة للمقالات الافتراضية — مصحَّحاً كما يُصيَّر
// (publicSiteContent.ts)، فنصّ المقال وdateModified بعد الإقلاع هما ما في HTML المُصيَّر.
// واعٍ للّغة: المدوّنة عربي/إنجليزي فقط — الفرنسية (المغرب العربي) تعود للنسخة الإنجليزية الدولية (LTR).
export function useBlog(): { lang: 'ar' | 'en'; posts: BlogPost[]; getPost: (slug: string) => BlogPost | undefined; isLoading: boolean } {
  const lang: 'ar' | 'en' = useLang((s) => s.lang) === 'ar' ? 'ar' : 'en'; // ar → عربي، en/fr → إنجليزي
  const { data, isLoading } = useQuery({
    queryKey: PUBLIC_SITE_CONTENT_KEY,
    queryFn: () => fetchPublicSiteContent(),
  });
  const cmsBlog = (data as { blog?: unknown } | null)?.blog;
  const all = effectivePosts(cmsBlog);
  const posts = lang === 'en' ? all.filter((p) => p.en) : all;
  return { lang, posts, getPost: (slug: string) => all.find((p) => p.slug === slug), isLoading };
}
