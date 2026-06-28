import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { defaultContent } from '../landing/defaultContent';
import { X, Save, Globe } from 'lucide-react';
import toast from 'react-hot-toast';

// أقسام المحرّر: [مسار الحقل، التسمية، نص طويل؟]
const SECTIONS: { title: string; fields: [string, string, boolean?][] }[] = [
  { title: 'القسم الرئيسي (Hero)', fields: [
    ['hero.badge', 'الشارة العلوية'],
    ['hero.titleLine1', 'العنوان — السطر الأول'],
    ['hero.titleLine2', 'العنوان — السطر الثاني'],
    ['hero.subtitle', 'الوصف', true],
    ['hero.ctaSecondary', 'زر «شاهد العرض»'],
  ] },
  { title: 'المميزات', fields: [
    ['features.title', 'عنوان القسم'],
    ['features.subtitle', 'وصف القسم', true],
    ['features.items.0.title', 'ميزة ١ — العنوان'], ['features.items.0.desc', 'ميزة ١ — الوصف', true],
    ['features.items.1.title', 'ميزة ٢ — العنوان'], ['features.items.1.desc', 'ميزة ٢ — الوصف', true],
    ['features.items.2.title', 'ميزة ٣ — العنوان'], ['features.items.2.desc', 'ميزة ٣ — الوصف', true],
    ['features.items.3.title', 'ميزة ٤ — العنوان'], ['features.items.3.desc', 'ميزة ٤ — الوصف', true],
    ['features.items.4.title', 'ميزة ٥ — العنوان'], ['features.items.4.desc', 'ميزة ٥ — الوصف', true],
    ['features.items.5.title', 'ميزة ٦ — العنوان'], ['features.items.5.desc', 'ميزة ٦ — الوصف', true],
    ['features.items.6.title', 'ميزة ٧ — العنوان'], ['features.items.6.desc', 'ميزة ٧ — الوصف', true],
    ['features.items.7.title', 'ميزة ٨ — العنوان'], ['features.items.7.desc', 'ميزة ٨ — الوصف', true],
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
    ['pricing.plans.0.name', 'باقة ١ — الاسم'], ['pricing.plans.0.price', 'السعر'], ['pricing.plans.0.limit', 'الحد'],
    ['pricing.plans.1.name', 'باقة ٢ — الاسم'], ['pricing.plans.1.price', 'السعر'], ['pricing.plans.1.limit', 'الحد'],
    ['pricing.plans.2.name', 'باقة ٣ — الاسم'], ['pricing.plans.2.price', 'السعر'], ['pricing.plans.2.limit', 'الحد'],
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
  { title: 'بيانات التواصل (صفحة تواصل معنا)', fields: [
    ['contact.intro', 'مقدمة الصفحة', true],
    ['contact.email', 'البريد الإلكتروني'], ['contact.phone', 'الهاتف'],
    ['contact.whatsapp', 'واتساب'], ['contact.address', 'العنوان'],
  ] },
  { title: 'روابط التواصل الاجتماعي', fields: [
    ['social.whatsapp', 'واتساب (رقم فقط، مثال: 9665XXXXXXXX)'],
    ['social.x', 'منصّة X (تويتر) — الرابط'],
    ['social.instagram', 'إنستغرام — الرابط'],
    ['social.snapchat', 'سناب شات — الرابط'],
    ['social.tiktok', 'تيك توك — الرابط'],
    ['social.linkedin', 'لينكدإن — الرابط'],
    ['social.youtube', 'يوتيوب — الرابط'],
    ['social.facebook', 'فيسبوك — الرابط'],
  ] },
  { title: 'الصفحات الفرعية', fields: [
    ['pages.about.title', 'من نحن — العنوان'], ['pages.about.body', 'من نحن — المحتوى', true],
    ['pages.terms.title', 'الشروط والأحكام — العنوان'], ['pages.terms.body', 'الشروط والأحكام — المحتوى', true],
    ['pages.serviceAgreement.title', 'اتفاقية الخدمة — العنوان'], ['pages.serviceAgreement.body', 'اتفاقية الخدمة — المحتوى', true],
    ['pages.privacy.title', 'الخصوصية — العنوان'], ['pages.privacy.body', 'الخصوصية — المحتوى', true],
  ] },
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
    if (data !== undefined) setDraft(structuredClone((data || defaultContent) as Draft));
  }, [data]);

  const save = useMutation({
    mutationFn: () => siteContentApi.update(draft),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['site-content'] }); toast.success('تم حفظ محتوى الصفحة'); onClose(); },
    onError: () => toast.error('تعذّر الحفظ'),
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
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><Globe size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">محتوى الصفحة التعريفية</h2>
              <p className="text-xs text-[#6E6557]">حرّر نصوص الصفحة الرئيسية والصفحات التابعة</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        {isLoading || !draft ? (
          <div className="flex-1 flex items-center justify-center text-gray-400">جارٍ التحميل…</div>
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
              {SECTIONS[active].fields.map(field)}
            </div>
          </div>
        )}

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
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
