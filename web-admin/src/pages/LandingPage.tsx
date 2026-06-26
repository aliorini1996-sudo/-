import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { LANDING_TEMPLATE } from '../landing/landingTemplate';
import { defaultContent } from '../landing/defaultContent';

// يملأ القالب (HTML) بقيم المحتوى عبر العناصر النائبة {{path.to.value}}
export function applyContent(template: string, content: unknown): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const val = path.split('.').reduce<unknown>(
      (o, k) => (o == null ? o : (o as Record<string, unknown>)[k]),
      content,
    );
    return val == null ? '' : String(val);
  });
}

// صفحة الهبوط التعريفية التسويقية — تصميم Field Sales، محتواها يُدار من لوحة المالك (CMS)
export default function LandingPage() {
  const { data } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const res = await siteContentApi.get(); return res.data.data as unknown; },
    staleTime: 60_000,
  });
  const content = data || defaultContent;
  const html = applyContent(LANDING_TEMPLATE, content);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
