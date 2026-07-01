import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { useLang } from '../i18n/lang';
import { effectivePosts, BlogPost } from './posts';

// يجلب مقالات المدوّنة من محتوى الـCMS العام (المفتاح blog) مع العودة للمقالات الافتراضية.
// واعٍ للّغة: على /en يعرض فقط المقالات التي لها نسخة إنجليزية (en).
export function useBlog(): { lang: 'ar' | 'en'; posts: BlogPost[]; getPost: (slug: string) => BlogPost | undefined; isLoading: boolean } {
  const lang: 'ar' | 'en' = useLang((s) => s.lang) === 'en' ? 'en' : 'ar'; // المدوّنة عربي/إنجليزي فقط
  const { data, isLoading } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
  });
  const cmsBlog = (data as { blog?: unknown } | null)?.blog;
  const all = effectivePosts(cmsBlog);
  const posts = lang === 'en' ? all.filter((p) => p.en) : all;
  return { lang, posts, getPost: (slug: string) => all.find((p) => p.slug === slug), isLoading };
}
