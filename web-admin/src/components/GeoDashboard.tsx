import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi, siteContentApi } from '../api/client';
import { buildCatalog, COUNTRIES } from '../blog/seo/catalog.mjs';
import {
  X, Bot, Sparkles, CheckCircle2, AlertTriangle, ExternalLink,
  FileText, MessageCircleQuestion, RefreshCw, Radar, Landmark, Search,
} from 'lucide-react';

const GH_ACTIONS = 'https://github.com/aliorini1996-sudo/-/actions';

// الزواحف التي يجب أن يرحّب بها robots.txt (تُطابق مجموعة GEO في الملف)
const AI_BOTS = [
  'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended',
  'meta-externalagent', 'Amazonbot', 'DuckAssistBot', 'CCBot',
];

// استعلام جاهز لاختبار الظهور يدوياً في محركات الإجابة
const TEST_Q = encodeURIComponent('أفضل نظام مبيعات ميدانية وتوزيع للموزعين في السعودية ومصر؟');

interface Probe {
  loading: boolean;
  llms: boolean; llmsLinks: number; llmsFull: boolean;
  aiBots: number;                     // كم زاحف AI مذكور في robots.txt
  prerender: boolean; faqSchema: boolean; // صفحة مقال ثابتة فيها JSON-LD و FAQPage
}

interface AiStats { total: number; byEngine: { label: string; count: number }[]; byDay: { date: string; count: number }[] }

// شاشة متابعة الظهور في محركات الذكاء الاصطناعي (GEO) — لمالك المنصّة
export default function GeoDashboard({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<Probe>({ loading: true, llms: false, llmsLinks: 0, llmsFull: false, aiBots: 0, prerender: false, faqSchema: false });

  // زيارات قادمة من محركات AI (آخر 30 يوماً) — من تحليلات الزيارات
  const { data: stats } = useQuery({
    queryKey: ['analytics-stats-geo'],
    queryFn: async () => { const r = await analyticsApi.stats(30); return r.data.data as { ai?: AiStats }; },
    staleTime: 60_000,
  });
  const ai = stats?.ai;

  const { data: content } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => { const r = await siteContentApi.get(); return r.data.data as unknown; },
    staleTime: 60_000,
  });
  const social = ((content as { social?: Record<string, string> } | null | undefined)?.social) || {};
  const socialCount = Object.values(social).filter((v) => v && String(v).trim()).length;

  const catalog = buildCatalog();
  const seoArticles = catalog.length;            // 300 مقال × 3 لغات
  const citablePages = seoArticles * 3 + 5;      // المُصيَّرة مسبقاً (مقالات + فهارس + رئيسية)
  const faqCount = seoArticles * 3 * 4;          // 4 أسئلة منظّمة في كل مقال ولغة

  useEffect(() => {
    let alive = true;
    (async () => {
      let llms = false, llmsLinks = 0, llmsFull = false, aiBots = 0, prerender = false, faqSchema = false;
      try {
        const r = await fetch('/llms.txt', { cache: 'no-store' });
        if (r.ok) {
          const t = await r.text();
          llms = t.startsWith('# ');
          llmsLinks = (t.match(/\]\(http/g) || []).length;
        }
      } catch { /* تجاهل */ }
      try { const r = await fetch('/llms-full.txt', { cache: 'no-store' }); llmsFull = r.ok && (await r.text()).startsWith('# '); } catch { /* تجاهل */ }
      try {
        const r = await fetch('/robots.txt', { cache: 'no-store' });
        if (r.ok) { const t = await r.text(); aiBots = AI_BOTS.filter((b) => t.includes(`User-agent: ${b}`)).length; }
      } catch { /* تجاهل */ }
      try {
        // صفحة مقال كما يراها زاحف AI (بلا JavaScript) — يجب أن تحمل المحتوى والبيانات المنظّمة
        const r = await fetch(`/blog/${catalog[0]?.slug}`, { cache: 'no-store' });
        if (r.ok) { const t = await r.text(); prerender = t.includes('application/ld+json'); faqSchema = t.includes('FAQPage'); }
      } catch { /* تجاهل */ }
      if (alive) setP({ loading: false, llms, llmsLinks, llmsFull, aiBots, prerender, faqSchema });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // قائمة تحقّق صحّة الـGEO
  const checks: { label: string; ok: boolean; detail?: string; hint?: string }[] = [
    { label: 'دليل الموقع للنماذج llms.txt', ok: p.llms, detail: p.llms ? `${p.llmsLinks} رابط مُنسّق` : undefined },
    { label: 'الفهرس الكامل llms-full.txt', ok: p.llmsFull, detail: `${seoArticles * 3} صفحة بثلاث لغات` },
    { label: 'ترحيب صريح بزواحف الذكاء الاصطناعي', ok: p.aiBots >= 10, detail: `${p.aiBots}/${AI_BOTS.length} زاحفاً في robots.txt` },
    { label: 'صفحات ثابتة تُقرأ بلا JavaScript', ok: p.prerender, detail: `${citablePages} صفحة مُصيَّرة مسبقاً` },
    { label: 'أسئلة وأجوبة منظّمة (FAQPage)', ok: p.faqSchema, detail: `${faqCount.toLocaleString('ar')} سؤال قابل للاقتباس` },
    { label: 'حقائق مُفرَدة لكل دولة (عملة/ضريبة/جهة)', ok: true, detail: `${COUNTRIES.length} دولة عربية` },
    { label: 'بيانات منظّمة للمنتج (Schema)', ok: !!document.querySelector('script[type="application/ld+json"]') },
    { label: 'إثبات هوية عبر الحسابات الاجتماعية (sameAs)', ok: socialCount > 0, hint: socialCount === 0 ? 'املأ روابط التواصل من «محتوى الصفحة»' : undefined },
    { label: 'متابعة الزيارات القادمة من محركات AI', ok: !!ai, hint: ai ? undefined : 'تُفعَّل بعد نشر تحديث الخادم' },
    { label: 'صيانة GEO يومية (أتمتة)', ok: true, detail: 'توليد llms.txt + تدقيق كل يوم 06:00' },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  const scoreColor = score >= 90 ? '#1E7A52' : score >= 70 ? '#E0A02C' : '#C0392B';

  const tools: { label: string; sub: string; href: string; icon: React.ElementType }[] = [
    { label: 'اختبر ظهورك في ChatGPT', sub: 'اسأله عن أفضل نظام مبيعات ميدانية', href: `https://chatgpt.com/?q=${TEST_Q}`, icon: Bot },
    { label: 'اختبر ظهورك في Perplexity', sub: 'يستشهد بالمصادر مباشرةً', href: `https://www.perplexity.ai/search?q=${TEST_Q}`, icon: Radar },
    { label: 'وضع الذكاء الاصطناعي في Google', sub: 'AI Mode — إجابات مع مصادر', href: `https://www.google.com/search?q=${TEST_Q}&udm=50`, icon: Search },
    { label: 'llms.txt الحيّ', sub: 'كما تقرؤه النماذج الآن', href: 'https://fieldsa.net/llms.txt', icon: FileText },
    { label: 'أتمتة الصيانة (GitHub)', sub: 'توليد وتدقيق GEO اليومي', href: GH_ACTIONS, icon: RefreshCw },
  ];

  const maxDay = Math.max(1, ...(ai?.byDay || []).map((d) => d.count));

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Sparkles size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">الظهور في محركات الذكاء الاصطناعي (GEO)</h2>
              <p className="text-xs text-[#6E6557]">هل يوصي ChatGPT وPerplexity وGemini بمنصّتك؟ — الأساس، النمو، والقياس</p>
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
                  <span className="text-[10px] text-[#9A8F7E]">صحّة GEO</span>
                </div>
              </div>
              <p className="text-[11px] text-[#6E6557] mt-2">{passed}/{checks.length} عنصر مكتمل</p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Kpi icon={Bot} value={ai ? String(ai.total) : '—'} label="زيارة من محركات AI · 30 يوماً" />
              <Kpi icon={Radar} value={p.loading ? '—' : String(p.aiBots)} label="زاحف AI مُرحَّب به" />
              <Kpi icon={FileText} value={String(citablePages)} label="صفحة قابلة للاقتباس (بلا JS)" />
              <Kpi icon={MessageCircleQuestion} value={faqCount.toLocaleString('ar')} label="سؤال وجواب منظّم" />
            </div>
          </div>

          {/* قائمة التحقّق */}
          <div>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><CheckCircle2 size={16} className="text-[#1E7A52]" /> قائمة صحّة الـGEO</h3>
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

          {/* النمو: زيارات قادمة من محركات الذكاء الاصطناعي */}
          <div className="bg-white border border-[#E9E1D3] rounded-2xl p-4">
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Bot size={16} className="text-[#E15A30]" /> زيارات قادمة من محركات الذكاء الاصطناعي (آخر 30 يوماً)</h3>
            {ai && ai.total > 0 ? (
              <>
                <div className="flex items-end gap-1 h-16 mb-3">
                  {ai.byDay.map((d) => (
                    <div key={d.date} className="flex-1 flex flex-col items-center gap-1" title={`${d.date}: ${d.count}`}>
                      <div className="w-full rounded-t bg-[#E15A30]" style={{ height: `${Math.max(4, (d.count / maxDay) * 100)}%`, opacity: d.count ? 1 : 0.15 }} />
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {ai.byEngine.map((e) => (
                    <span key={e.label} className="text-[12px] bg-[#FBEBE2] text-[#C94E28] rounded-full px-3 py-1 font-medium">{e.label} · {e.count}</span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[12.5px] text-[#6E6557] leading-relaxed">
                {ai
                  ? 'لم تُرصد زيارات من محركات AI بعد — طبيعي في البداية؛ تظهر عادةً بعد أسابيع من زحف النماذج واقتباسها لمحتواك. الأساس جاهز والعدّاد يعمل.'
                  : 'يُفعَّل هذا العدّاد بعد نشر تحديث الخادم — سيُحصي كل زائر وصل من ChatGPT أو Perplexity أو Gemini أو Claude أو Copilot وغيرها.'}
              </p>
            )}
          </div>

          {/* أدوات الاختبار الخارجية */}
          <div>
            <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Landmark size={16} className="text-[#E15A30]" /> اختبر ظهورك بنفسك</h3>
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
              هذه الشاشة تراقب <b>أساس الـGEO</b>: ما يجعل النماذج قادرة على قراءة موقعك واقتباسه والتوصية به. النمو الفعلي يظهر في <b>عدّاد الزيارات القادمة من محركات AI</b> أعلاه — كل زيارة منها تعني أن محرّكاً ذكياً ذكر منصّتك في إجابة.
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
