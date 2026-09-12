import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { siteContentApi, profileDeckApi } from '../api/client';
import { X, Save, ExternalLink, RotateCcw, Upload, Loader2, CheckCircle2, Plus, Trash2, Image as ImageIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import { PROFILE_FIELDS, PROFILE_DEFAULTS, PROFILE_SECTIONS, showKey, sectionOn, mergeProfile, readPartners, PROFILE_CMS_KEY, PROFILE_PARTNERS_KEY, PROFILE_LANGS, PROFILE_LANG_LABEL, ProfileContent, ProfileLang, ProfilePartner } from '../content/profileContent';
import { backdropClose } from '../lib/backdropClose';

/**
 * يصغّر الشعار قبل تخزينه.
 *
 * الشعار يُخزَّن data URL داخل محتوى الموقع، و**محتوى الموقع يُجلب مع كل زيارة
 * لكل صفحة** — فشعارٌ خام بحجم ٤٠٠ كيلوبايت يُبطئ الموقع كلّه لا صفحة البروفايل
 * وحدها. التصغير إلى ٣٢٠ بكسل يكفي لعرضٍ ارتفاعه ٥٦ بكسل على شاشةٍ مضاعفة
 * الكثافة، ويهبط بالحجم إلى عشرات الكيلوبايتات.
 *
 * وPNG لا JPEG: أكثر الشعارات بخلفيّة شفّافة، وJPEG يملؤها أسوداً.
 */
const MAX_LOGO_PX = 320;
async function shrinkLogo(file: File): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(new Error('تعذر قراءة الملف'));
    r.readAsDataURL(file);
  });
  // SVG لا يُرسم على canvas بثقة عبر المتصفّحات، وهو خفيف أصلاً فيُخزَّن كما هو
  if (file.type === 'image/svg+xml') return raw;

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('تعذر فتح الصورة'));
    im.src = raw;
  });
  const scale = Math.min(1, MAX_LOGO_PX / Math.max(img.naturalWidth, img.naturalHeight));
  if (scale === 1 && raw.length < 60_000) return raw;   // صغيرٌ أصلاً فلا نعيد ترميزه

  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  const ctx = c.getContext('2d');
  if (!ctx) return raw;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

/**
 * محرر صفحة «بروفايل» — لمالك المنصة.
 *
 * يعدّل أي نصّ في الصفحة التعريفية fieldsa.net/profile بأي وقت وباللغتين،
 * والحفظ يدمج مفتاح profile داخل siteContent دون المساس ببقية محتوى الموقع.
 *
 * والأقسام محتواها من عرض البروفايل المعتمد — فالصفحة **صفحة ويب حقيقية**
 * نصّها قابل للتحديد والبحث والترجمة، لا صور شرائح. وزرّ الـPDF في أعلاها
 * يخدم الملفّ الذي يرفعه المالك من «ملف البروفايل» أدناه.
 */
export default function ProfileEditorPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [lang, setLang] = useState<ProfileLang>('ar');
  const [draft, setDraft] = useState<ProfileContent | null>(null);

  /**
   * ملفّ البروفايل القابل للتنزيل — زرّ PDF في أعلى الصفحة يخدمه.
   *
   * يُرفع من هنا لا من لوحةٍ ثانية: البروفايل شيءٌ واحد في ذهن المالك، ولوحتان
   * لشيءٍ واحد تُربكان أكثر ممّا تفيدان.
   */
  const { data: deck } = useQuery({
    queryKey: ['profile-deck'],
    queryFn: async () => (await profileDeckApi.get()).data.data as { file: { name: string; v: number } | null },
    staleTime: 0,
  });

  const upload = useMutation({
    mutationFn: async (f: File) => {
      const b64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => { const s = String(r.result || ''); resolve(s.slice(s.indexOf(',') + 1)); };
        r.onerror = () => reject(new Error('تعذر قراءة الملف'));
        r.readAsDataURL(f);
      });
      await profileDeckApi.putFile(b64, 'بروفايل Field Sales.pdf');
    },
    onSuccess: () => {
      toast.success('حُدث ملف التنزيل — زر PDF يخدمه الان');
      qc.invalidateQueries({ queryKey: ['profile-deck'] });
    },
    onError: (e: unknown) =>
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذر رفع الملف'),
  });

  const { data: cms, isLoading } = useQuery({
    queryKey: ['site-content'],
    queryFn: async () => (await siteContentApi.get()).data.data as Record<string, unknown> | null,
    staleTime: 0,
  });

  // المسودة تبدا من (الافتراضي + تعديلات CMS) عند اول تحميل
  const content = draft ?? mergeProfile((cms?.[PROFILE_CMS_KEY] as Partial<ProfileContent>) || null);

  /** الشركاء مسودّة مستقلّة لأنهم خارج خريطة اللغات (يُرفعون مرّة لكل اللغات) */
  const [partnersDraft, setPartnersDraft] = useState<ProfilePartner[] | null>(null);
  const partners = partnersDraft ?? readPartners(cms);
  const setPartners = (next: ProfilePartner[]) => setPartnersDraft(next);
  const editPartner = (i: number, patch: Partial<ProfilePartner>) =>
    setPartners(partners.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const setField = (key: string, value: string) => {
    setDraft({ ...content, [lang]: { ...content[lang], [key]: value } });
  };

  /**
   * إظهار القسم شأن واحد للغتين فيُكتب في العربية أياً كانت اللغة المعروضة —
   * ولو خُزّن لكل لغة لرأى قارئ الإنجليزية قسماً أخفاه المالك.
   */
  const setShow = (key: string, visible: boolean) => {
    setDraft({ ...content, ar: { ...content.ar, [showKey(key)]: visible ? '1' : '0' } });
  };

  const save = useMutation({
    mutationFn: async () => {
      // ندمج فوق احدث نسخة من CMS كي لا نمسح اقسام الموقع الاخرى
      const latest = (await siteContentApi.get()).data.data as Record<string, unknown> | null;
      return siteContentApi.update({
        ...(latest || {}),
        [PROFILE_CMS_KEY]: content,
        // الصفوف الفارغة تماماً تُسقط عند الحفظ فلا تظهر بطاقة بيضاء في الصفحة
        [PROFILE_PARTNERS_KEY]: partners.filter(p => p.name.trim() || p.logo),
      });
    },
    onSuccess: () => {
      toast.success('حفظ الصفحة تعرض النص الجديد فورا');
      qc.invalidateQueries({ queryKey: ['site-content'] });
      setDraft(null);
      setPartnersDraft(null);
    },
    onError: () => toast.error('تعذر الحفظ حاول مجددا'),
  });

  const resetLang = () => {
    // الإظهار اختيار تحريريّ لا نصّ — لا يُمحى مع استرجاع النصوص
    const kept = Object.fromEntries(
      PROFILE_SECTIONS.map(s => [showKey(s.key), content.ar[showKey(s.key)]]).filter(([, v]) => v !== undefined),
    ) as Record<string, string>;
    setDraft({ ...content, [lang]: { ...PROFILE_DEFAULTS[lang], ...(lang === 'ar' ? kept : {}) } });
    toast('أعيدت نصوص هذه اللغة للافتراضي احفظ لتثبيتها', { icon: '↩️' });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* الترويسة */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <div>
            <h2 className="text-lg font-bold text-[#1F1A13]">محتوى البروفايل</h2>
            <p className="text-xs text-[#6E6557]">كل نص في صفحة fieldsa net/profile عدل واحفظ ويظهر فورا</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/profile" target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-bold text-[#E15A30] hover:underline px-2">
              فتح الصفحة <ExternalLink size={13} />
            </a>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {/* مبدل اللغة + استرجاع */}
        <div className="px-5 pt-4 flex items-center justify-between">
          <div className="inline-flex bg-[#F3EDE3] rounded-xl p-0.5">
            {PROFILE_LANGS.map(l => (
              <button key={l} onClick={() => setLang(l)} lang={l}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap ${lang === l ? 'bg-white text-[#E15A30] shadow-sm' : 'text-[#6E6557]'}`}>
                {PROFILE_LANG_LABEL[l]}
              </button>
            ))}
          </div>
          <button onClick={resetLang} className="inline-flex items-center gap-1.5 text-xs text-[#6E6557] hover:text-[#C0392B]">
            <RotateCcw size={13} /> استرجاع الافتراضي لهذه اللغة
          </button>
        </div>

        {/* الحقول */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {isLoading ? (
            <p className="text-center text-gray-400 py-10">جار التحميل</p>
          ) : <>
            {/* الأقسام الظاهرة — الإخفاء يزيل القسم من الصفحة ومن ملف الـPDF معاً */}
            <div className="rounded-xl border border-[#E9E1D3] bg-[#FBF8F2] p-4">
              <p className="text-[13px] font-bold text-[#1F1A13]">الاقسام الظاهرة</p>
              <p className="text-[11px] text-[#9A8F7E] mt-0.5 mb-3">ازل علامة اي قسم ليختفي من الصفحة ومن ملف PDF — الغلاف والخاتمة دائمان</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PROFILE_SECTIONS.map(s => {
                  const visible = sectionOn(content, s.key);
                  return (
                    <label key={s.key} className="flex items-center gap-2 text-[12.5px] cursor-pointer select-none rounded-lg px-2 py-1.5 hover:bg-white">
                      <input type="checkbox" checked={visible} onChange={e => setShow(s.key, e.target.checked)}
                        className="w-4 h-4 accent-[#E15A30]" />
                      <span className={visible ? 'text-[#1F1A13]' : 'text-[#B7AD9D] line-through'}>{s.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            {PROFILE_FIELDS.map(f => (
            <div key={f.key}>
              <label className="block text-[13px] font-bold text-[#1F1A13] mb-1">
                {f.label}
                {f.hint && <span className="font-normal text-[11px] text-[#9A8F7E] mr-2">({f.hint})</span>}
              </label>
              {f.multiline ? (
                <textarea dir={lang === 'ar' ? 'rtl' : 'ltr'} rows={Math.min(6, Math.max(2, (content[lang][f.key] || '').split('\n').length + 1))}
                  className="input w-full text-sm leading-relaxed" value={content[lang][f.key] || ''}
                  onChange={e => setField(f.key, e.target.value)} />
              ) : (
                <input dir={lang === 'ar' ? 'rtl' : 'ltr'} className="input w-full text-sm"
                  value={content[lang][f.key] || ''} onChange={e => setField(f.key, e.target.value)} />
              )}
            </div>
            ))}

            {/* ═══ شركاء النجاح ═══
                خارج حلقة الحقول لأنهم ليسوا نصّاً لكل لغة: الاسم علامة تجارية
                والشعار صورة — يُرفعان مرّة ويظهران في اللغات الخمس. */}
            <div className="rounded-xl border border-[#E9E1D3] bg-[#FBF8F2] p-4">
              <div className="flex items-center justify-between gap-3 mb-1">
                <p className="text-[13px] font-bold text-[#1F1A13]">شركاء النجاح</p>
                <button type="button" onClick={() => setPartners([...partners, { name: '', logo: '' }])}
                  className="inline-flex items-center gap-1 text-xs font-bold text-[#E15A30] hover:underline">
                  <Plus size={14} /> اضف شريكا
                </button>
              </div>
              <p className="text-[11px] text-[#9A8F7E] mb-3">
                الاسم والشعار يظهران في اللغات الخمس — ارفعهما مرة واحدة. اخف القسم من «الاقسام الظاهرة» اعلاه.
              </p>

              {partners.length === 0 ? (
                <p className="text-[12px] text-[#B7AD9D] py-3 text-center">لا شركاء بعد — اضغط «اضف شريكا»</p>
              ) : (
                <div className="space-y-2">
                  {partners.map((p, i) => (
                    <div key={i} className="flex items-center gap-2.5 bg-white rounded-lg border border-[#E9E1D3] p-2">
                      {/* معاينة الشعار: المالك يرى ما سيراه الزائر لا اسم ملف */}
                      <div className="w-16 h-12 shrink-0 rounded-md bg-[#FAF7F0] border border-[#EFE8DC] flex items-center justify-center overflow-hidden">
                        {p.logo
                          ? <img src={p.logo} alt="" className="max-w-full max-h-full object-contain" />
                          : <ImageIcon size={16} className="text-[#C9BFB0]" />}
                      </div>
                      <input dir="rtl" className="input flex-1 text-sm" placeholder="اسم الشريك"
                        value={p.name} onChange={e => editPartner(i, { name: e.target.value })} />
                      <label className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold cursor-pointer text-[#E15A30] px-1.5">
                        <input type="file" accept="image/*" className="hidden"
                          onChange={async e => {
                            const f = e.target.files?.[0];
                            e.currentTarget.value = '';
                            if (!f) return;
                            try {
                              editPartner(i, { logo: await shrinkLogo(f) });
                            } catch {
                              toast.error('تعذر قراءة الصورة جرب صيغة اخرى');
                            }
                          }} />
                        <Upload size={13} /> {p.logo ? 'تغيير' : 'شعار'}
                      </label>
                      <button type="button" onClick={() => setPartners(partners.filter((_, j) => j !== i))}
                        className="shrink-0 p-1.5 rounded-md text-[#B7AD9D] hover:text-red-600 hover:bg-red-50"
                        title="حذف الشريك"><Trash2 size={15} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>}
        </div>

        {/* ملفّ التنزيل */}
        <div className="px-4 py-3 border-t border-[#E9E1D3] bg-[#FAF7F0]">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs">
              {deck?.file
                ? <CheckCircle2 size={14} className="text-green-600" />
                : <Upload size={14} className="text-[#9A8F7E]" />}
              <span className="text-[#6E6557]">
                {deck?.file ? 'زر PDF يخدم الملف المرفوع' : 'زر PDF يخدم الملف المدمج — ارفع نسختك'}
              </span>
            </div>
            <label className="inline-flex items-center gap-1.5 text-xs font-bold cursor-pointer text-[#E15A30]">
              <input type="file" accept="application/pdf,.pdf" className="hidden" disabled={upload.isPending}
                onChange={e => {
                  const f = e.target.files?.[0];
                  e.currentTarget.value = '';
                  if (!f) return;
                  if (!/\.pdf$/i.test(f.name)) { toast.error('اختر ملف PDF'); return; }
                  if (f.size > 25 * 1024 * 1024) { toast.error('الملف أكبر من ٢٥ ميغابايت'); return; }
                  upload.mutate(f);
                }} />
              {upload.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              {upload.isPending ? 'يرفع' : 'رفع ملف PDF للتنزيل'}
            </label>
          </div>
        </div>

        {/* الحفظ */}
        <div className="p-4 border-t border-[#E9E1D3] flex items-center justify-between">
          <p className="text-[11px] text-[#9A8F7E]">{draft ? 'تعديلات غير محفوظة' : 'لا تعديلات معلقة'}</p>
          <button onClick={() => save.mutate()} disabled={save.isPending || !draft}
            className="inline-flex items-center gap-2 bg-[#E15A30] text-white font-bold text-sm px-5 py-2.5 rounded-xl disabled:opacity-50 hover:bg-[#C94E28]">
            <Save size={15} /> {save.isPending ? 'يحفظ' : 'حفظ التعديلات'}
          </button>
        </div>
      </div>
    </div>
  );
}
