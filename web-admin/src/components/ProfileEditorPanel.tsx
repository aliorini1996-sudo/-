import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { siteContentApi, profileDeckApi } from '../api/client';
import { X, Save, ExternalLink, RotateCcw, Upload, Loader2, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { PROFILE_FIELDS, PROFILE_DEFAULTS, PROFILE_SECTIONS, showKey, sectionOn, mergeProfile, ProfileContent, ProfileLang } from '../content/profileContent';
import { backdropClose } from '../lib/backdropClose';

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
  const content = draft ?? mergeProfile((cms?.profile as Partial<ProfileContent>) || null);

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
      return siteContentApi.update({ ...(latest || {}), profile: content });
    },
    onSuccess: () => {
      toast.success('حفظ الصفحة تعرض النص الجديد فورا');
      qc.invalidateQueries({ queryKey: ['site-content'] });
      setDraft(null);
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
            {(['ar', 'en'] as ProfileLang[]).map(l => (
              <button key={l} onClick={() => setLang(l)}
                className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-colors ${lang === l ? 'bg-white text-[#E15A30] shadow-sm' : 'text-[#6E6557]'}`}>
                {l === 'ar' ? 'النص العربي' : 'English'}
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
