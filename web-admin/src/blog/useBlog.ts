import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { effectivePosts, BlogPost } from './posts';

// يجلب مقالات المدوّنة من محتوى الـCMS العام (المفتاح blog) مع العودة للمقالات الافتراضية.
// يُستخدم في صفحتَي المدوّنة العامّتين (لا يتطلّب تسجيل دخول — القراءة عامة).
export function useBlog(): { posts: BlogPost[]; getPost: (slug: string) => BlogPost | undefined; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
  });
  const cmsBlog = (data as { blog?: unknown } | null)?.blog;
  const posts = effectivePosts(cmsBlog);
  return { posts, getPost: (slug: string) => posts.find(p => p.slug === slug), isLoading };
}
