import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { defaultContent } from '../landing/defaultContent';
import { POSTS, emptyPost, slugify, type BlogPost } from '../blog/posts';
import { X, Save, Globe, Plus, Trash2, ChevronDown, Image as ImageIcon, RotateCcw, Eraser, ListChecks } from 'lucide-react';
import { cleanContent } from '../lib/siteContentClean';
import { applyCmsFixes, planCmsFixes, CMS_FIX_GROUP_LABEL, type CmsFixResult, type CmsFixStatus } from '../content/cmsFixes';
import toast from 'react-hot-toast';

const DEFAULT_HERO = '/hero-rep-phones.svg';

// أقسام المحرّر: [مسار الحقل، التسمية، نص طويل؟] — والقسم المعلّم blog له محرّر مقالات مخصّص
const SECTIONS: { title: string; fields: [string, string, boolean?][]; blog?: boolean; heroImage?: boolean }[] = [
  { title: 'القسم الرئيسي Hero', fields: [
    ['hero.badge', 'الشارة العلوية'],
    ['hero.titleLine1', 'العنوان السطر الأول'],
    ['hero.titleLine2', 'العنوان السطر الثاني'],
    ['hero.subtitle', 'الوصف', true],
    ['hero.ctaSecondary', 'زر شاهد العرض'],
  ] },
  { title: 'المميزات', fields: [
    ['features.title', 'عنوان القسم'],
    ['features.subtitle', 'وصف القسم', true],
    ['features.items.0.title', 'ميزة ١ العنوان'], ['features.items.0.desc', 'ميزة ١ الوصف', true],
    ['features.items.1.title', 'ميزة ٢ العنوان'], ['features.items.1.desc', 'ميزة ٢ الوصف', true],
    ['features.items.2.title', 'ميزة ٣ العنوان'], ['features.items.2.desc', 'ميزة ٣ الوصف', true],
    ['features.items.3.title', 'ميزة ٤ العنوان'], ['features.items.3.desc', 'ميزة ٤ الوصف', true],
    ['features.items.4.title', 'ميزة ٥ العنوان'], ['features.items.4.desc', 'ميزة ٥ الوصف', true],
    ['features.items.5.title', 'ميزة ٦ العنوان'], ['features.items.5.desc', 'ميزة ٦ الوصف', true],
    ['features.items.6.title', 'ميزة ٧ العنوان'], ['features.items.6.desc', 'ميزة ٧ الوصف', true],
    ['features.items.7.title', 'ميزة ٨ العنوان'], ['features.items.7.desc', 'ميزة ٨ الوصف', true],
    ['features.items.8.title', 'ميزة ٩ العنوان'], ['features.items.8.desc', 'ميزة ٩ الوصف', true],
    ['features.items.9.title', 'ميزة ١٠ العنوان'], ['features.items.9.desc', 'ميزة ١٠ الوصف', true],
    ['features.items.10.title', 'ميزة ١١ العنوان'], ['features.items.10.desc', 'ميزة ١١ الوصف', true],
    ['features.items.11.title', 'ميزة ١٢ العنوان'], ['features.items.11.desc', 'ميزة ١٢ الوصف', true],
  ] },
  { title: 'كيف يعمل', fields: [
    ['how.title', 'عنوان القسم'], ['how.subtitle', 'الوصف', true],
    ['how.steps.0.title', 'خطوة ١'], ['how.steps.0.desc', 'وصف الخطوة ١', true],
    ['how.steps.1.title', 'خطوة ٢'], ['how.steps.1.desc', 'وصف الخطوة ٢', true],
    ['how.steps.2.title', 'خطوة ٣'], ['how.steps.2.desc', 'وصف الخطوة ٣', true],
  ] },
  { title: 'الأدوار', fields: [
    ['roles.title', 'عنوان القسم'],
    ['roles.items.0.title', 'دور ١'], ['roles.items.0.desc', 'وصف ١', true],
    ['roles.items.1.title', 'دور ٢'], ['roles.items.1.desc', 'وصف ٢', true],
    ['roles.items.2.title', 'دور ٣'], ['roles.items.2.desc', 'وصف ٣', true],
  ] },
  { title: 'الأسعار', fields: [
    ['pricing.title', 'عنوان القسم'], ['pricing.subtitle', 'الوصف'],
    ['pricing.plans.0.name', 'باقة ١ الاسم'], ['pricing.plans.0.price', 'السعر الشهري'], ['pricing.plans.0.yearlyPrice', 'السعر السنوي اتركه فارغا ليكون عشرة أشهر'], ['pricing.plans.0.limit', 'الحد'],
    ['pricing.plans.1.name', 'باقة ٢ الاسم'], ['pricing.plans.1.price', 'السعر الشهري'], ['pricing.plans.1.yearlyPrice', 'السعر السنوي اتركه فارغا ليكون عشرة أشهر'], ['pricing.plans.1.limit', 'الحد'],
    ['pricing.plans.2.name', 'باقة ٣ الاسم'], ['pricing.plans.2.price', 'السعر الشهري'], ['pricing.plans.2.yearlyPrice', 'السعر السنوي اتركه فارغا ليكون عشرة أشهر'], ['pricing.plans.2.limit', 'الحد'],
  ] },
  { title: 'تطبيق المندوب روابط المتاجر', fields: [
    ['repApp.appStoreUrl', 'رابط App Store اتركه فارغا ليظهر قريبا'],
    ['repApp.playUrl', 'رابط Google Play الصقه فور موافقة Google (https://play.google.com/store/apps/details?id=net.fieldsa.twa)'],
  ] },
  { title: 'الأسئلة الشائعة', fields: [
    ['faq.title', 'عنوان القسم'],
    ['faq.items.0.q', 'سؤال ١'], ['faq.items.0.a', 'إجابة ١', true],
    ['faq.items.1.q', 'سؤال ٢'], ['faq.items.1.a', 'إجابة ٢', true],
    ['faq.items.2.q', 'سؤال ٣'], ['faq.items.2.a', 'إجابة ٣', true],
    ['faq.items.3.q', 'سؤال ٤'], ['faq.items.3.a', 'إجابة ٤', true],
  ] },
  { title: 'الدعوة النهائية', fields: [
    ['finalCta.title', 'العنوان'], ['finalCta.subtitle', 'الوصف', true], ['finalCta.note', 'الملاحظة السفلية'],
  ] },
  { title: 'بيانات التواصل صفحة تواصل معنا + مربع للتواصل وطلبات الاشتراك بالرئيسية', fields: [
    ['contact.intro', 'مقدمة الصفحة', true],
    ['contact.email', 'البريد الإلكتروني'], ['contact.phone', 'الهاتف يظهر مكتوبا بالمربع'],
    ['contact.whatsapp', 'واتساب'], ['contact.address', 'عنوان مقر الشركة'],
  ] },
  { title: 'روابط التواصل الاجتماعي', fields: [
    ['social.whatsapp', 'واتساب رقم فقط مثال 9665XXXXXXXX'],
    ['social.x', 'منصة X تويتر الرابط'],
    ['social.instagram', 'إنستغرام الرابط'],
    ['social.snapchat', 'سناب شات الرابط'],
    ['social.tiktok', 'تيك توك الرابط'],
    ['social.linkedin', 'لينكدإن الرابط'],
    ['social.youtube', 'يوتيوب الرابط'],
    ['social.facebook', 'فيسبوك الرابط'],
  ] },
  { title: 'الصفحات الفرعية', fields: [
    ['pages.about.title', 'من نحن العنوان'], ['pages.about.body', 'من نحن المحتوى', true],
    ['pages.terms.title', 'الشروط والأحكام العنوان'], ['pages.terms.body', 'الشروط والأحكام المحتوى', true],
    ['pages.serviceAgreement.title', 'اتفاقية الخدمة العنوان'], ['pages.serviceAgreement.body', 'اتفاقية الخدمة المحتوى', true],
    // سياسة الخصوصية تُعرض من الكود دائماً (InfoPage.tsx) لأنها تصف سلوك وسم الإعلانات والقياس
    ['pages.privacy.title', 'الخصوصية العنوان (غير معروض: الصفحة تعرض النسخة المعتمدة في الكود)'], ['pages.privacy.body', 'الخصوصية المحتوى (غير معروض: الصفحة تعرض النسخة المعتمدة في الكود)', true],
  ] },
  { title: 'المدونة المقالات', fields: [], blog: true },
  { title: 'صورة الصفحة الرئيسية', fields: [], heroImage: true },
];

type Draft = Record<string, unknown>;
const getIn = (obj: Draft, path: string): string => {
  const v = path.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
  return v == null ? '' : String(v);
};
const setIn = (obj: Draft, path: string, val: string): Draft => {
  const keys = path.split('.');
  const clone = structuredClone(obj);
  let o = clone as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]] as Record<string, unknown>;
  }
  o[keys[keys.length - 1]] = val;
  return clone;
};

// محرّر مقالات المدوّنة — يضيف/يحرّر/يحذف مقالات تُخزَّن في محتوى الـCMS تحت المفتاح blog
function BlogManager({ draft, setDraft }: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft | null>> }) {
  const [open, setOpen] = useState<number | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  // عند فتح القسم لأول مرّة: ثبّت القائمة الحالية (الافتراضية) في المسودّة لتُحفظ كاملة
  useEffect(() => {
    if (!Array.isArray(draft.blog)) setDraft(d => (d ? { ...d, blog: structuredClone(POSTS) } : d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const list: BlogPost[] = Array.isArray(draft.blog) ? (draft.blog as BlogPost[]) : POSTS;
  const mutate = (fn: (l: BlogPost[]) => BlogPost[]) => setDraft(d => {
    if (!d) return d;
    const cur = Array.isArray(d.blog) ? [...(d.blog as BlogPost[])] : structuredClone(POSTS);
    return { ...d, blog: fn(cur) };
  });
  const update = (i: number, key: keyof BlogPost, val: string | number) =>
    mutate(l => { l[i] = { ...l[i], [key]: val } as BlogPost; return l; });
  const add = () => { mutate(l => { l.unshift(emptyPost()); return l; }); setOpen(0); };
  const remove = (i: number) => { mutate(l => { l.splice(i, 1); return l; }); setOpen(null); setConfirmDel(null); };

  return (
    <div className="space-y-3">
      <div className="bg-[#FBEBE2] border border-[#F1D9CC] rounded-xl p-3 text-xs text-[#8A4B33] leading-relaxed">
        أضف أو حرر مقالات تظهر على <b>fieldsa.net/blog</b> في حقل المحتوى اكتب بصيغة بسيطة 
        سطر يبدأ ب <code className="font-mono">## </code> = عنوان فرعي أسطر تبدأ ب <code className="font-mono">- </code> = قائمة
        <code className="font-mono"> **نص** </code> = عريض <code className="font-mono">[نص](رابط)</code> = رابط أو الصق HTML مباشرة
      </div>
      <button onClick={add} className="btn-primary w-full justify-center py-2.5"><Plus size={16} /> مقال جديد</button>

      {list.map((p, i) => {
        const dup = !!p.slug && list.filter(x => x.slug === p.slug).length > 1;
        return (
          <div key={i} className="border border-[#E9E1D3] rounded-xl overflow-hidden">
            <div className="flex items-center gap-1 p-3 bg-[#FBF8F2]">
              <button onClick={() => setOpen(open === i ? null : i)} className="flex-1 text-right min-w-0">
                <div className="font-semibold text-sm text-[#1F1A13] truncate">{p.title || 'مقال بلا عنوان'}</div>
                <div className="text-[11px] text-[#9A8F7E] truncate">/blog/{p.slug || ''} · {p.date}</div>
              </button>
              <button onClick={() => setOpen(open === i ? null : i)} className="p-1.5 text-[#6E6557]" title="فتح/طي">
                <ChevronDown size={16} className={open === i ? 'rotate-180' : ''} />
              </button>
              {confirmDel === i
                ? <button onClick={() => remove(i)} className="px-2.5 py-1 text-[11px] font-bold text-white bg-red-500 rounded-lg whitespace-nowrap">تأكيد الحذف</button>
                : <button onClick={() => setConfirmDel(i)} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg" title="حذف"><Trash2 size={15} /></button>}
            </div>
            {open === i && (
              <div className="p-4 space-y-3 border-t border-[#F1EBDF]">
                <div><label className="label">العنوان</label>
                  <input className="input" value={p.title} onChange={e => update(i, 'title', e.target.value)} /></div>
                <div>
                  <label className="label">المعرف في الرابط بالإنجليزية بدون مسافات</label>
                  <input className="input" dir="ltr" value={p.slug} placeholder="my-new-article"
                    onChange={e => update(i, 'slug', slugify(e.target.value))} />
                  {dup && <p className="text-[11px] text-red-500 mt-1">⚠ المعرف مكرر اجعله فريدا</p>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="label">التاريخ</label>
                    <input className="input" type="date" value={p.date} onChange={e => update(i, 'date', e.target.value)} /></div>
                  <div><label className="label">دقائق القراءة</label>
                    <input className="input" type="number" min={1} value={p.readMinutes}
                      onChange={e => update(i, 'readMinutes', Number(e.target.value) || 1)} /></div>
                </div>
                <div><label className="label">وصف Meta يظهر في نتائج جوجل نحو ١٥٥ حرفا</label>
                  <textarea className="input" rows={2} value={p.description} onChange={e => update(i, 'description', e.target.value)} /></div>
                <div><label className="label">مقتطف يظهر في فهرس المدونة</label>
                  <textarea className="input" rows={2} value={p.excerpt} onChange={e => update(i, 'excerpt', e.target.value)} /></div>
                <div><label className="label">كلمات مفتاحية مفصولة بفواصل</label>
                  <input className="input" value={p.keywords} onChange={e => update(i, 'keywords', e.target.value)} /></div>
                <div><label className="label">المحتوى</label>
                  <textarea className="input font-mono text-xs leading-relaxed" rows={12}
                    value={p.contentHtml} onChange={e => update(i, 'contentHtml', e.target.value)} /></div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// تغيير صورة الصفحة الرئيسية — رفع صورة (تُصغَّر وتُخزَّن في الـCMS) أو استعادة الافتراضية
function HeroImageField({ draft, setDraft }: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft | null>> }) {
  const [busy, setBusy] = useState(false);
  const current = (typeof draft.heroImage === 'string' && draft.heroImage) ? (draft.heroImage as string) : DEFAULT_HERO;
  const isCustom = current !== DEFAULT_HERO;

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('اختر ملف صورة PNG/JPG/SVG'); return; }
    if (file.size > 6 * 1024 * 1024) { toast.error('الصورة كبيرة جدا الحد 6MB'); return; }
    setBusy(true);
    const reader = new FileReader();
    reader.onerror = () => { setBusy(false); toast.error('تعذرت قراءة الملف'); };
    reader.onload = () => {
      const result = String(reader.result || '');
      if (file.type === 'image/svg+xml') {
        setDraft(d => d && ({ ...d, heroImage: result }));
        setBusy(false); toast.success('تم اختيار الصورة اضغط حفظ لنشرها');
        return;
      }
      const img = new window.Image();
      img.onerror = () => { setBusy(false); toast.error('تعذر قراءة الصورة'); };
      img.onload = () => {
        const maxW = 1200;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { setBusy(false); toast.error('تعذرت معالجة الصورة'); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const alpha = file.type === 'image/png' || file.type === 'image/webp';
        const dataUrl = alpha ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
        setDraft(d => d && ({ ...d, heroImage: dataUrl }));
        setBusy(false); toast.success('تم اختيار الصورة اضغط حفظ لنشرها');
      };
      img.src = result;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-4">
      <div className="bg-[#FBEBE2] border border-[#F1D9CC] rounded-xl p-3 text-xs text-[#8A4B33] leading-relaxed">
        الصورة المعروضة أسفل القسم الأول في الصفحة الرئيسية يفضل <b>PNG بخلفية شفافة</b> بأبعاد عريضة ≈ 1000×740 لتندمج مع الصفحة
      </div>
      <div className="rounded-2xl border border-[#E9E1D3] bg-[#FAF7F0] p-4 flex items-center justify-center min-h-[180px]">
        <img src={current} alt="معاينة صورة الصفحة الرئيسية" className="max-h-64 max-w-full object-contain" />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <label className={`btn-primary justify-center py-2.5 px-4 cursor-pointer ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
          {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ImageIcon size={16} />}
          اختر صورة
          <input type="file" accept="image/*" className="hidden" onChange={onFile} />
        </label>
        {isCustom && (
          <button onClick={() => setDraft(d => d && ({ ...d, heroImage: '' }))} className="btn-secondary flex items-center gap-1.5">
            <RotateCcw size={15} /> استعادة الافتراضية
          </button>
        )}
        <span className="text-xs text-[#9A8F7E]">{isCustom ? 'صورة مخصصة' : 'الصورة الافتراضية'}</span>
      </div>
    </div>
  );
}

// ── تقرير «تصحيحات الظهور» (content/cmsFixes.ts) ─────────────────────────────
const FIX_STATUS_LABEL: Record<CmsFixStatus, string> = {
  applied: 'طُبّق',
  already: 'مطبّق من قبل',
  missing: 'لم يُعثر على النص الحالي',
  ambiguous: 'النص مكرّر في الحقل فلم يُمسّ',
  'no-field': 'الحقل غير موجود',
  'price-mismatch': 'أسعاره لا تطابق الباقات الحالية فلم يُطبّق',
};
const FIX_FIELD_LABEL: Record<string, string> = {
  title: 'العنوان', description: 'وصف Meta', excerpt: 'المقتطف', keywords: 'الكلمات المفتاحية', contentHtml: 'المحتوى',
};
/** مكان البند بلغة المالك: «/blog/x/ · المحتوى» بدل blog[slug=x].contentHtml */
function fixWhere(path: string): string {
  const m = path.match(/^blog\[slug=([^\]]+)\]\.(en\.)?(\w+)$/);
  if (m) return `/${m[2] ? 'en/' : ''}blog/${m[1]}/ · ${FIX_FIELD_LABEL[m[3]] ?? m[3]}`;
  if (path.startsWith('faq.')) return 'الرئيسية · الأسئلة الشائعة';
  if (path.startsWith('features.')) return 'الرئيسية · المميزات';
  return path;
}

function FixReport({ results, onClose }: { results: CmsFixResult[]; onClose: () => void }) {
  const applied = results.filter(r => r.status === 'applied');
  const already = results.filter(r => r.status === 'already');
  const notFound = results.filter(r => r.status !== 'applied' && r.status !== 'already');
  const row = (r: CmsFixResult) => (
    <li key={r.fix.id} className="flex items-start justify-between gap-3 py-1.5 border-b border-[#F1EBDF] last:border-0">
      <span className="min-w-0">
        <span className="block text-[13px] text-[#1F1A13] truncate" dir="ltr">{fixWhere(r.fix.path)}</span>
        <span className="block text-[11px] text-[#9A8F7E]">{CMS_FIX_GROUP_LABEL[r.fix.group]} · {r.fix.id}</span>
      </span>
      <span className="text-[11px] text-[#6E6557] whitespace-nowrap">{FIX_STATUS_LABEL[r.status]}</span>
    </li>
  );
  return (
    <div className="absolute inset-0 z-10 bg-white rounded-2xl flex flex-col" role="dialog" aria-label="تقرير تصحيحات الظهور">
      <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
        <div>
          <h3 className="text-base font-bold text-[#1F1A13]">تقرير تصحيحات الظهور</h3>
          <p className="text-xs text-[#6E6557] mt-0.5">
            طُبّق {applied.length} · مطبّق من قبل {already.length} · لم يُطبّق {notFound.length}
          </p>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" aria-label="إغلاق"><X size={18} /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <div className="bg-[#FBEBE2] border border-[#F1D9CC] rounded-xl p-3 text-xs text-[#8A4B33] leading-relaxed">
          التصحيحات طُبّقت على المسودة فقط ولم يُحفظ شيء. راجع المقالات ثم اضغط «حفظ المحتوى ونشره»، أو «إلغاء» للتراجع.
          البند لا يُطبّق إلا إن وُجد نصه الحالي مرة واحدة بالضبط، فما حرّرته بنفسك لا يُمسّ.
        </div>
        {applied.length > 0 && (
          <section>
            <h4 className="text-sm font-bold text-[#1F1A13] mb-1">ما طُبّق ({applied.length})</h4>
            <ul>{applied.map(row)}</ul>
          </section>
        )}
        {notFound.length > 0 && (
          <section>
            <h4 className="text-sm font-bold text-[#1F1A13] mb-1">ما لم يُعثر عليه أو لم يُطبّق ({notFound.length})</h4>
            <p className="text-[11px] text-[#9A8F7E] mb-1">غالباً حُرّر النص أو حُذف المقال — راجعه يدوياً إن كان ما زال ينفي المرحلة الثانية أو يُسقط باقة.</p>
            <ul>{notFound.map(row)}</ul>
          </section>
        )}
        {already.length > 0 && (
          <section>
            <h4 className="text-sm font-bold text-[#1F1A13] mb-1">مطبّق من قبل ({already.length})</h4>
            <ul>{already.map(row)}</ul>
          </section>
        )}
      </div>
      <div className="p-5 border-t border-[#E9E1D3]">
        <button onClick={onClose} className="btn-primary w-full justify-center py-2.5">حسناً</button>
      </div>
    </div>
  );
}

// محرّر محتوى الصفحة التعريفية والصفحات التابعة (للمالك)
export default function SiteContentEditor({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [active, setActive] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ['site-content-edit'],
    queryFn: async () => { const r = await siteContentApi.get(); return (r.data.data ?? null) as Draft | null; },
  });

  useEffect(() => {
    if (data === undefined) return;
    // إن كان المحتوى المحفوظ قديماً (عدد ميزاته لا يطابق الكود الحالي) نبدأ من المحتوى
    // الافتراضي الحالي الصحيح بدل القديم؛ وإلا نحمّل تحرير المالك. حفظه يجعله محدّثاً ويُعرَض.
    const savedItems = (data as { features?: { items?: unknown[] } } | null)?.features?.items;
    const cmsCurrent = Array.isArray(savedItems) && savedItems.length === defaultContent.features.items.length;
    const base = structuredClone((cmsCurrent ? data : defaultContent) as Draft);
    // احتفظ بمقالات المدوّنة المحفوظة حتى لو عُدنا للمحتوى الافتراضي (كي لا تُفقد عند الحفظ)
    const savedBlog = (data as { blog?: unknown } | null)?.blog;
    if (Array.isArray(savedBlog) && savedBlog.length) base.blog = savedBlog;
    setDraft(base);
  }, [data]);

  // تنظيف كل نصوص المحتوى دفعةً واحدة (إزالة التشكيل وعلامات الترقيم) — يُطبَّق
  // على المسوّدة لا على المحفوظ، فيراجعه المالك ثم يحفظ أو يغلق بلا حفظ.
  const cleanAll = () => {
    if (!draft) return;
    const { value, changed } = cleanContent(draft);
    if (!changed) { toast('النصوص نظيفة أصلاً — لا تشكيل ولا علامات ترقيم'); return; }
    setDraft(value);
    toast.success(`نُظّف ${changed} نصاً — راجعها ثم اضغط حفظ`);
  };

  // «تصحيحات الظهور»: استبدالات حرفية مُعدّة سلفاً (نفي المرحلة الثانية، «المرحلة الأولى»، جمل السعر بلا 399،
  // وعود دون اتصال بلا قيد، «يمنع» حدّ الائتمان) — تُطبَّق على المسوّدة وحدها، والحفظ بزرّ الحفظ نفسه.
  const [fixReport, setFixReport] = useState<CmsFixResult[] | null>(null);
  // عدّاد الزر: البنود التي تنطبق الآن على المسوّدة (تشغيل جافّ بلا نسخ، يتبع كل تعديل)
  const pendingFixes = useMemo(() => (draft ? planCmsFixes(draft).filter(r => r.status === 'applied').length : 0), [draft]);
  const applyFixes = () => {
    if (!draft) return;
    const { value, results, applied } = applyCmsFixes(draft);
    if (applied) setDraft(value);
    setFixReport(results);
  };

  const save = useMutation({
    mutationFn: () => siteContentApi.update(draft),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['site-content'] }); toast.success('تم حفظ محتوى الصفحة'); onClose(); },
    onError: () => toast.error('تعذر الحفظ'),
  });

  const field = ([path, label, area]: [string, string, boolean?]) => (
    <div key={path}>
      <label className="label">{label}</label>
      {area
        ? <textarea className="input" rows={3} value={draft ? getIn(draft, path) : ''} onChange={e => setDraft(d => d && setIn(d, path, e.target.value))} />
        : <input className="input" value={draft ? getIn(draft, path) : ''} onChange={e => setDraft(d => d && setIn(d, path, e.target.value))} />}
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col">
        {fixReport && <FixReport results={fixReport} onClose={() => setFixReport(null)} />}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Globe size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">محتوى الصفحة التعريفية</h2>
              <p className="text-xs text-[#6E6557]">حرر نصوص الصفحة الرئيسية والصفحات التابعة</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {isLoading || !draft ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">جار التحميل</div>
        ) : (
          <div className="flex-1 flex min-h-0">
            {/* تبويبات الأقسام */}
            <div className="w-52 shrink-0 border-l border-[#F1EBDF] overflow-y-auto p-2">
              {SECTIONS.map((s, i) => (
                <button key={i} onClick={() => setActive(i)}
                  className={`w-full text-right px-3 py-2.5 rounded-lg text-sm mb-1 transition-colors ${active === i ? 'bg-[#FBEBE2] text-[#C94E28] font-semibold' : 'text-[#6E6557] hover:bg-gray-50'}`}>
                  {s.title}
                </button>
              ))}
            </div>
            {/* حقول القسم النشط */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3.5">
              <h3 className="font-bold text-[#1F1A13] mb-1">{SECTIONS[active].title}</h3>
              {SECTIONS[active].blog
                ? <BlogManager draft={draft} setDraft={setDraft} />
                : SECTIONS[active].heroImage
                ? <HeroImageField draft={draft} setDraft={setDraft} />
                : SECTIONS[active].fields.map(field)}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={cleanAll} disabled={!draft} title="يزيل التشكيل وعلامات الترقيم من النصوص العادية ويترك الروابط والصور والكلمات المفتاحية كما هي"
            className="px-4 py-2.5 rounded-xl border border-[#E9E1D3] text-[#6E6557] hover:border-[#E8C9BC] hover:text-[#1F1A13] text-sm font-bold flex items-center gap-2 transition-colors">
            <Eraser size={15} /> تنظيف النصوص
          </button>
          <button onClick={applyFixes} disabled={!draft}
            title="يستبدل نصوصاً قديمة محددة في المسودة فقط: نفي المرحلة الثانية، وصيغة المرحلة الأولى، وجمل السعر التي تسقط باقة 399، ووعود العمل دون اتصال بلا قيد الربط، ومنع حد الائتمان. ثم تراجع وتحفظ بنفسك"
            className="px-4 py-2.5 rounded-xl border border-[#E8C9BC] bg-[#FBEBE2] text-[#C94E28] hover:bg-[#F7DCCD] text-sm font-bold flex items-center gap-2 transition-colors">
            <ListChecks size={15} /> تطبيق تصحيحات الظهور ({pendingFixes})
          </button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !draft} className="btn-primary flex-1 justify-center py-2.5">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={16} />}
            حفظ المحتوى ونشره
          </button>
          <button onClick={onClose} className="btn-secondary">إلغاء</button>
        </div>
      </div>
    </div>
  );
}
