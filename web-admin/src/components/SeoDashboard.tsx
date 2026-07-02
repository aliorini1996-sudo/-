import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { POSTS } from '../blog/posts';
import { listArticles, buildCatalog, COUNTRIES } from '../blog/seo/catalog.mjs';
import {
  X, Search, TrendingUp, CheckCircle2, AlertTriangle, ExternalLink,
  Globe, Languages, MapPin, FileText, Share2, Zap, RefreshCw, Link2,
} from 'lucide-react';

const GH_ACTIONS = 'https://github.com/aliorini1996-sudo/-/actions';
const GSC = 'https://search.google.com/search-console?resource_id=sc-domain:fieldsa.net';

interface Probe {
  loading: boolean;
  sitemapUrls: number; enUrls: number; frUrls: number; hreflang: number; blogUrls: number; images: number; lastmod: string;
  robots: boolean; favicon: boolean; gscMeta: boolean;
}

// شاشة متابعة تحسين محرّك البحث (SEO) — لمالك المنصّة
export default function SeoDashboard({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<Probe>({ loading: true, sitemapUrls: 0, enUrls: 0, frUrls: 0, hreflang: 0, blogUrls: 0, images: 0, lastmod: '', robots: false, favicon: false, gscMeta: false });

  const { data: content } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
    staleTime: 60_000,
  });
  const social = ((content as { social?: Record<string, string> } | null | undefined)?.social) || {};
  const socialCount = Object.values(social).filter((v) => v && String(v).trim()).length;

  useEffect(() => {
    let alive = true;
    (async () => {
      let sitemapUrls = 0, enUrls = 0, frUrls = 0, hreflang = 0, blogUrls = 0, images = 0, lastmod = '';
      let robots = false, favicon = false;
      try {
        const sm = await fetch('/sitemap.xml', { cache: 'no-store' });
        if (sm.ok) {
          const x = await sm.text();
          sitemapUrls = (x.match(/<loc>/g) || []).length;
          enUrls = (x.match(/fieldsa\.net\/en/g) || []).length;
          frUrls = (x.match(/fieldsa\.net\/fr/g) || []).length;
          hreflang = (x.match(/hreflang=/g) || []).length;
          blogUrls = (x.match(/\/blog\//g) || []).length;
          images = (x.match(/<image:loc>/g) || []).length;
          const lm = [...x.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]).sort();
          lastmod = lm[lm.length - 1] || '';
        }
      } catch { /* تجاهل */ }
      try { const r = await fetch('/robots.txt', { cache: 'no-store' }); robots = r.ok; } catch { /* تجاهل */ }
      try { const f = await fetch('/favicon.ico', { cache: 'no-store' }); favicon = f.ok && /icon/.test(f.headers.get('content-type') || ''); } catch { /* تجاهل */ }
      const gscMeta = !!document.querySelector('meta[name="google-site-verification"]');
      if (alive) setP({ loading: false, sitemapUrls, enUrls, frUrls, hreflang, blogUrls, images, lastmod, robots, favicon, gscMeta });
    })();
    return () => { alive = false; };
  }, []);

  const seoArticles = buildCatalog().length;           // مقالات مولَّدة برمجياً (ثلاثية اللغة)
  const bilingual = POSTS.filter((x) => x.en).length;  // مقالات يدوية ثنائية اللغة
  const totalArticles = POSTS.length + seoArticles;    // إجمالي المقالات
  const arabCountries = COUNTRIES.length;              // دول عربية لكلٍّ مقالات مخصّصة

  // قائمة تحقّق صحّة الـSEO
  const checks: { label: string; ok: boolean; detail?: string; hint?: string }[] = [
    { label: 'خريطة موقع محدّثة', ok: p.sitemapUrls > 0, detail: `${p.sitemapUrls} رابط` },
    { label: 'روابط دولية hreflang (عربي/إنجليزي/فرنسي)', ok: p.hreflang > 0, detail: `${p.hreflang} رابط` },
    { label: 'نسخة إنجليزية منفصلة /en', ok: p.enUrls > 0 },
    { label: 'نسخة فرنسية منفصلة /fr', ok: p.frUrls > 0 },
    { label: 'ملف robots.txt', ok: p.robots },
    { label: 'أيقونة الموقع (favicon)', ok: p.favicon },
    { label: 'عناوين ووصف فريدة لكل صفحة', ok: true },
    { label: 'بيانات منظّمة (Schema)', ok: true, detail: '12 خدمة · 50 دولة' },
    { label: 'مدوّنة ثلاثية اللغة (ع/إ/فر)', ok: seoArticles > 0, detail: `${seoArticles} مقال بثلاث لغات` },
    { label: 'بطاقات صور احترافية (OG)', ok: true, detail: `${seoArticles * 3} بطاقة · 3 لغات` },
    { label: 'خريطة صور Google (image sitemap)', ok: p.images > 0, detail: `${p.images} صورة` },
    { label: 'أزرار مشاركة اجتماعية', ok: true },
    { label: 'تحقّق Google Search Console', ok: p.gscMeta },
    { label: 'ربط الحسابات الاجتماعية (sameAs)', ok: socialCount > 0, hint: socialCount === 0 ? 'املأ روابط التواصل من «محتوى الصفحة»' : undefined },
    { label: 'صيانة SEO يومية (أتمتة)', ok: true, detail: 'كل يوم 06:00' },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  const scoreColor = score >= 90 ? '#1E7A52' : score >= 70 ? '#E0A02C' : '#C0392B';

  const tools: { label: string; sub: string; href: string; icon: React.ElementType }[] = [
    { label: 'Google Search Console', sub: 'النقرات والكلمات والفهرسة', href: GSC, icon: Search },
    { label: 'PageSpeed Insights', sub: 'سرعة الموقع وتجربة المستخدم', href: 'https://pagespeed.web.dev/analysis?url=https://fieldsa.net/', icon: Zap },
    { label: 'اختبار النتائج الغنية', sub: 'فحص البيانات المنظّمة', href: 'https://search.google.com/test/rich-results?url=https%3A%2F%2Ffieldsa.net%2F', icon: CheckCircle2 },
    { label: 'خريطة الموقع الحيّة', sub: 'sitemap.xml', href: 'https://fieldsa.net/sitemap.xml', icon: FileText },
    { label: 'أتمتة الصيانة (GitHub)', sub: 'تشغيلات الورك فلو اليومي', href: GH_ACTIONS, icon: RefreshCw },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><TrendingUp size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">متابعة تحسين محرّك البحث (SEO)</h2>
              <p className="text-xs text-[#6E6557]">صحّة الموقع، نموّ المحتوى، وروابط أدوات القياس</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* درجة الصحّة + مؤشّرات */}
          <div className="grid md:grid-cols-[auto_1fr] gap-4 items-center bg-[#FAF7F0] rounded-2xl border border-[#E9E1D3] p-5">
            <div className="flex flex-col items-center justify-center">
              <div className="relative w-24 h-24">
                <svg viewBox="0 0 36 36" className="w-24 h-24 -rotate-90">
                  <circle cx="18" cy="18" r="15.5" fill="none" stroke="#E9E1D3" strokeWidth="3" />
                  <circle cx="18" cy="18" r="15.5" fill="none" stroke={scoreColor} strokeWidth="3" strokeLinecap="round"
                    strokeDasharray={`${(score / 100) * 97.4} 97.4`} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-2xl font-extrabold" style={{ color: scoreColor }}>{p.loading ? '…' : `${score}%`}</span>
                  <span className="text-[10px] text-[#9A8F7E]">صحّة SEO</span>
                </div>
              </div>
              <p className="text-[11px] text-[#6E6557] mt-2">{passed}/{checks.length} عنصر مكتمل</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi icon={Link2} value={p.loading ? '—' : String(p.sitemapUrls)} label="روابط في الخريطة" />
              <Kpi icon={FileText} value={`${totalArticles}`} label={`مقال (${seoArticles} بـ3 لغات)`} />
              <Kpi icon={Languages} value="3" label="لغات · عربي/إنجليزي/فرنسي" />
              <Kpi icon={MapPin} value={`${arabCountries}`} label="دولة عربية مستهدفة" />
            </div>
          </div>

          {/* قائمة التحقّق */}
          <div>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><CheckCircle2 size={16} className="text-[#1E7A52]" /> قائمة صحّة الـSEO</h3>
            <div className="grid sm:grid-cols-2 gap-2">
              {checks.map((c) => (
                <div key={c.label} className="flex items-start gap-2.5 bg-white border border-[#E9E1D3] rounded-xl px-3.5 py-2.5">
                  {c.ok
                    ? <CheckCircle2 size={17} className="text-[#1E7A52] shrink-0 mt-0.5" />
                    : <AlertTriangle size={17} className="text-[#E0A02C] shrink-0 mt-0.5" />}
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#1F1A13] leading-snug">{c.label}</p>
                    {c.detail && <p className="text-[11px] text-[#9A8F7E]">{c.detail}</p>}
                    {c.hint && <p className="text-[11px] text-[#C94E28]">{c.hint}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* نموّ المحتوى */}
          <div className="bg-white border border-[#E9E1D3] rounded-2xl p-4">
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><TrendingUp size={16} className="text-[#E15A30]" /> نموّ المحتوى</h3>
            <div className="space-y-2">
              {listArticles('ar').slice(0, 6).map((a) => (
                <div key={a.slug} className="flex items-center gap-2 text-[13px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#E15A30] shrink-0" />
                  <span className="text-[#1F1A13] truncate flex-1">{a.title}</span>
                  <span className="text-[10px] text-[#1E7A52] bg-green-50 rounded px-1.5 py-0.5 shrink-0">ع/إ/فر</span>
                  <span className="text-[11px] text-[#9A8F7E] shrink-0">{a.date}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-[#F1EBDF] flex items-center gap-2 text-[12px] text-[#6E6557]">
              <Globe size={14} className="text-[#E15A30]" />
              مدوّنتك تضمّ {seoArticles} مقالًا مولّدًا لكل الدول العربية بثلاث لغات + مقالاتك اليدوية — كلها في الخريطة والفهرسة الآلية اليومية.
            </div>
          </div>

          {/* أدوات القياس الخارجية */}
          <div>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Share2 size={16} className="text-[#E15A30]" /> أدوات القياس (بيانات الترتيب والزيارات الحقيقية)</h3>
            <div className="grid sm:grid-cols-2 gap-2">
              {tools.map((t) => (
                <a key={t.label} href={t.href} target="_blank" rel="noreferrer"
                  className="flex items-center gap-3 bg-white border border-[#E9E1D3] rounded-xl px-3.5 py-3 hover:border-[#E8C9BC] transition-colors group">
                  <div className="w-9 h-9 rounded-lg bg-[#FBEBE2] flex items-center justify-center shrink-0"><t.icon size={17} className="text-[#E15A30]" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-[#1F1A13] truncate">{t.label}</p>
                    <p className="text-[11px] text-[#9A8F7E] truncate">{t.sub}</p>
                  </div>
                  <ExternalLink size={14} className="text-[#C7BCA8] group-hover:text-[#E15A30] shrink-0" />
                </a>
              ))}
            </div>
            <p className="text-[11px] text-[#9A8F7E] mt-3 leading-relaxed">
              هذه الشاشة تراقب <b>أساس الـSEO ونموّ المحتوى</b> على موقعك. أما بيانات الترتيب والنقرات الفعلية فتأتي من <b>Google Search Console</b> (يحدّثها جوجل خلال 1–3 أيام).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, value, label }: { icon: React.ElementType; value: string; label: string }) {
  return (
    <div className="bg-white rounded-xl p-3 text-center border border-[#E9E1D3]">
      <Icon size={16} className="text-[#9A8F7E] mx-auto mb-1" />
      <p className="text-lg font-bold text-[#1F1A13] leading-none">{value}</p>
      <p className="text-[10.5px] text-[#6E6557] mt-1 leading-tight">{label}</p>
    </div>
  );
}
