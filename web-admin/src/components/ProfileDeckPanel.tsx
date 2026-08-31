import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Upload, Trash2, ExternalLink, Loader2, FileText, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { profileDeckApi } from '../api/client';
import { backdropClose } from '../lib/backdropClose';
import { pdfToSlides, fileToBase64, type RenderedSlide } from '../lib/pdfToSlides';

/**
 * تعديل البروفايل — لمالك المنصّة.
 *
 * المالك يختار ملفّ PDF المصدَّر من بوربوينت، فيُصيّر المتصفّحُ صفحاته صوراً
 * عالية الدقّة ويرفعها مع الملفّ نفسه. تتغيّر صفحة `/profile` فوراً بلا نشر.
 *
 * ولماذا PDF لا PPTX: لا محرّك في المتصفّح يقرأ بوربوينت بأمانة، والـPDF هو
 * ما يصدّره بوربوينت بضغطة ويحفظ التصميم حرفياً — فيصل للزائر ما رآه المالك
 * في ملفّه بلا وسيط يُعيد تفسيره.
 *
 * والتحويل في المتصفّح لا على الخادم: الخادم على لينكس بلا بوربوينت ولا
 * poppler. والتخزين في قاعدة البيانات لا على القرص: الخدمة بلا قرص دائم فأي
 * ملف يُكتب يضيع مع أول إعادة نشر.
 */

const C = { coral: '#E15A30', ink: '#1F1A13', cream: '#FAF7F0', sand: '#E9E1D3', gray: '#6E6557' };

interface Manifest {
  slides: { seq: number; width: number; height: number; title: string; lines: string[]; v: number }[];
  file: { name: string; v: number } | null;
}

export default function ProfileDeckPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<{ page: number; total: number } | null>(null);
  const [pending, setPending] = useState<RenderedSlide[] | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['profile-deck'],
    queryFn: async () => (await profileDeckApi.get()).data.data as Manifest,
    staleTime: 0,
  });

  const uploaded = (data?.slides?.length ?? 0) > 0;

  /** الرفع خطوتان: الشرائح ثم الملفّ — كلٌّ منهما طلبٌ مستقلّ فلا يضخم الجسم */
  const publish = useMutation({
    mutationFn: async () => {
      if (!pending || !pendingFile) throw new Error('اختر الملف أولا');
      setBusy('يرفع الشرائح');
      await profileDeckApi.putDeck(pending);
      setBusy('يرفع الملف للتنزيل');
      const b64 = await fileToBase64(pendingFile);
      await profileDeckApi.putFile(b64, `بروفايل Field Sales.pdf`);
    },
    onSuccess: () => {
      toast.success('نُشر البروفايل — صفحة profile محدثة الآن');
      setPending(null); setPendingFile(null); setBusy('');
      qc.invalidateQueries({ queryKey: ['profile-deck'] });
    },
    onError: (e: unknown) => {
      setBusy('');
      toast.error((e as { response?: { data?: { message?: string } }; message?: string })
        ?.response?.data?.message || (e as Error)?.message || 'تعذر الرفع');
    },
  });

  /**
   * رفع الملفّ القابل للتنزيل وحده — بلا تحويل صفحاته صوراً.
   *
   * شبكة أمان: تصيير pdf.js يعتمد على إطارات الرسم وقد يتعثّر على متصفّح أو
   * جهاز بعينه. فلا يبقى المالك عاجزاً عن تحديث ما يُنزّله الزائر لأجل عيبٍ في
   * التحويل — يرفع الملفّ ويبقى العرض المعروض على حاله حتى يُحلّ الأمر.
   */
  const fileOnly = useMutation({
    mutationFn: async (f: File) => {
      setBusy('يرفع الملف للتنزيل');
      const b64 = await fileToBase64(f);
      await profileDeckApi.putFile(b64, 'بروفايل Field Sales.pdf');
    },
    onSuccess: () => {
      toast.success('حُدث ملف التنزيل — الشرائح المعروضة على حالها');
      setBusy('');
      qc.invalidateQueries({ queryKey: ['profile-deck'] });
    },
    onError: (e: unknown) => {
      setBusy('');
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذر رفع الملف');
    },
  });

  const clear = useMutation({
    mutationFn: () => profileDeckApi.clear(),
    onSuccess: () => {
      toast.success('أُزيل المرفوع — عادت الصفحة للنسخة المدمجة');
      qc.invalidateQueries({ queryKey: ['profile-deck'] });
    },
    onError: () => toast.error('تعذر الإزالة'),
  });

  const pick = async (f: File | null) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name)) { toast.error('اختر ملف PDF'); return; }
    if (f.size > 25 * 1024 * 1024) { toast.error('الملف أكبر من ٢٥ ميغابايت'); return; }
    setPending(null);
    setPendingFile(f);          // يُحفَظ أوّلاً: زرّ «الملف وحده» يعمل ولو فشل التحويل
    setBusy('يصير صفحات الملف صورا');
    setProgress({ page: 0, total: 0 });
    try {
      const slides = await pdfToSlides(f, p => setProgress(p));
      if (!slides.length) throw new Error('الملف بلا صفحات');
      setPending(slides);
      toast.success(`جُهزت ${slides.length} شريحة — راجعها ثم انشر`);
    } catch (e) {
      toast.error((e as Error)?.message || 'تعذر تحويل الملف');
    } finally {
      setBusy(''); setProgress(null);
    }
  };

  const working = busy !== '' || publish.isPending;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: C.sand }}>
          <div>
            <h2 className="text-lg font-bold" style={{ color: C.ink }}>تعديل البروفايل</h2>
            <p className="text-xs" style={{ color: C.gray }}>
              اختر ملف PDF المصدر من بوربوينت — يحول لصور ويظهر في صفحة profile بلا نشر
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/profile" target="_blank" rel="noreferrer"
              className="text-xs font-bold flex items-center gap-1" style={{ color: C.coral }}>
              فتح الصفحة <ExternalLink size={13} />
            </a>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* الحالة الآن */}
          <div className="rounded-xl px-4 py-3 flex items-center gap-2 text-sm"
            style={{ background: uploaded ? '#EAF7F0' : '#FAF7F0', border: `1px solid ${uploaded ? '#BFE5D2' : C.sand}` }}>
            {isLoading ? <Loader2 size={15} className="animate-spin" /> : uploaded
              ? <CheckCircle2 size={15} className="text-green-600" />
              : <FileText size={15} style={{ color: C.gray }} />}
            <span style={{ color: C.ink }}>
              {isLoading ? 'يقرأ الحالة' : uploaded
                ? `الصفحة تعرض ${data!.slides.length} شريحة مرفوعة${data!.file ? ' ومعها ملف للتنزيل' : ' (بلا ملف للتنزيل)'}`
                : 'الصفحة تعرض النسخة المدمجة في البناء — لم يرفع شيء بعد'}
            </span>
          </div>

          {/* اختيار الملف */}
          <label className="block rounded-2xl border-2 border-dashed cursor-pointer p-6 text-center transition-colors hover:bg-[#FAF7F0]"
            style={{ borderColor: C.sand }}>
            <input type="file" accept="application/pdf,.pdf" className="hidden"
              disabled={working}
              onChange={e => { void pick(e.target.files?.[0] ?? null); e.currentTarget.value = ''; }} />
            <Upload size={22} className="mx-auto mb-2" style={{ color: C.coral }} />
            <p className="font-bold text-sm" style={{ color: C.ink }}>اختر ملف البروفايل PDF</p>
            <p className="text-[11px] mt-1" style={{ color: C.gray }}>
              من بوربوينت: ملف ← تصدير ← إنشاء PDF · حتى ٢٥ ميغابايت
            </p>
          </label>

          {/* التقدّم */}
          {busy && (
            <div className="rounded-xl px-4 py-3 text-sm flex items-center gap-2"
              style={{ background: '#FDF3E7', border: '1px solid #F5D9B0', color: '#8A5A12' }}>
              <Loader2 size={15} className="animate-spin" />
              <span>{busy}{progress && progress.total ? ` — ${progress.page} من ${progress.total}` : ''}</span>
            </div>
          )}

          {/* معاينة ما جُهّز قبل النشر */}
          {pending && (
            <div>
              <p className="text-sm font-bold mb-2" style={{ color: C.ink }}>
                معاينة {pending.length} شريحة — تُنشر عند الضغط أدناه
              </p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-64 overflow-y-auto p-1">
                {pending.map(s => (
                  <figure key={s.seq} className="m-0 rounded-lg overflow-hidden border" style={{ borderColor: C.sand }}>
                    <img src={`data:${s.mime};base64,${s.dataBase64}`} alt={`شريحة ${s.seq}`}
                      className="block w-full" style={{ aspectRatio: `${s.width} / ${s.height}`, objectFit: 'cover' }} />
                    <figcaption className="text-[10px] px-1 py-0.5 truncate" style={{ color: C.gray }}>
                      {s.seq}. {s.title}
                    </figcaption>
                  </figure>
                ))}
              </div>
              <p className="text-[11px] mt-2" style={{ color: C.gray }}>
                نص كل شريحة يُقرأ من الملف تلقائيا ويُرفع معها — يخدم محركات البحث وقارئات الشاشة ولا يظهر للزائر
              </p>
            </div>
          )}

          {/* الشرائح المنشورة الآن */}
          {!pending && uploaded && (
            <div>
              <p className="text-sm font-bold mb-2" style={{ color: C.ink }}>المنشور الآن</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-56 overflow-y-auto p-1">
                {data!.slides.map(s => (
                  <figure key={s.seq} className="m-0 rounded-lg overflow-hidden border" style={{ borderColor: C.sand }}>
                    <img src={`/api/profile-deck/slide/${s.seq}?v=${s.v}`} alt={`شريحة ${s.seq}`}
                      loading="lazy" className="block w-full" style={{ aspectRatio: '16 / 9', objectFit: 'cover' }} />
                    <figcaption className="text-[10px] px-1 py-0.5 truncate" style={{ color: C.gray }}>
                      {s.seq}. {s.title || '—'}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-3 p-5 border-t" style={{ borderColor: C.sand }}>
          <button onClick={() => publish.mutate()} disabled={!pending || working}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {publish.isPending ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
            نشر على صفحة البروفايل
          </button>
          {pendingFile && (
            <button onClick={() => fileOnly.mutate(pendingFile)} disabled={working || fileOnly.isPending}
              className="px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-1.5 disabled:opacity-60"
              style={{ background: '#F3EDE3', color: C.ink }}
              title="يرفع ملف التنزيل وحده بلا تغيير الشرائح المعروضة">
              <FileText size={15} />
              الملف للتنزيل وحده
            </button>
          )}
          {uploaded && (
            <button onClick={() => clear.mutate()} disabled={working || clear.isPending}
              className="px-4 py-2.5 rounded-xl font-semibold text-sm flex items-center gap-1.5 disabled:opacity-60"
              style={{ background: '#FBE3DF', color: '#C0392B' }}>
              <Trash2 size={15} />
              إزالة المرفوع
            </button>
          )}
          <button onClick={onClose} className="btn-secondary">إغلاق</button>
        </div>
      </div>
    </div>
  );
}
