import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { siteContentApi } from '../api/client';
import { X, Save, ExternalLink, RotateCcw } from 'lucide-react';
import toast from 'react-hot-toast';
import { PROFILE_FIELDS, PROFILE_DEFAULTS, mergeProfile, ProfileContent, ProfileLang } from '../content/profileContent';
import { backdropClose } from '../lib/backdropClose';

/**
 * محرر صفحة «بروفايل» — لمالك المنصة.
 * يعدل اي نص في الصفحة التعريفية fieldsa.net/profile بأي وقت وباللغتين.
 * الحفظ يدمج مفتاح profile داخل siteContent دون المساس ببقية محتوى الموقع.
 */
export default function ProfileEditorPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [lang, setLang] = useState<ProfileLang>('ar');
  const [draft, setDraft] = useState<ProfileContent | null>(null);

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
    setDraft({ ...content, [lang]: { ...PROFILE_DEFAULTS[lang] } });
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
          ) : PROFILE_FIELDS.map(f => (
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
