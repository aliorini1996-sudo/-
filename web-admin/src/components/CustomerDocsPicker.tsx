import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, X } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { NO_CAMERA_MSG, cameraCaptureCrashes } from '../lib/appCamera';
import { compressImage } from '../rep/imageCompress';
import { CUSTOMER_DOC_MAX_PER_REQUEST, DOC_COMPRESS, PickedDoc, CustomerDocKind, docKindsFor } from '../lib/customerDocs';

/**
 * «صور الوثائق» في إضافة العميل (طلب المالك ١٣ نوفمبر ٢٠٢٦) — مشتركٌ بين لوحة الشركة (CustomerModal) وتطبيق المندوب (AddCustomer):
 * تصويرٌ بالكاميرا مباشرة أو اختيارٌ من استديو الجهاز، والصورة تُضغط على الجهاز (DOC_COMPRESS) ولكلٍّ نوعها (السجل، الهوية…).
 * تُرسل مع جسم العميل نفسه (docsPayload) فتُحفظ معه ذرّياً — ودون اتصال تبقى معه في صفّ الإرسال.
 */
export default function CustomerDocsPicker({ docs, onChange, taxOff = false, max = CUSTOMER_DOC_MAX_PER_REQUEST, onBusy }: {
  docs: PickedDoc[];
  onChange: (docs: PickedDoc[]) => void;
  /** «إزالة الضريبة»: لا نوع «الشهادة الضريبية» */
  taxOff?: boolean;
  max?: number;
  /** الضغط جارٍ — الحاوية تعطّل «حفظ» به، وإلا حُفظ العميل بلا الصور التي لم تُجهَّز بعد */
  onBusy?: (busy: boolean) => void;
}) {
  const tr = useTr();
  const [msg, setMsg] = useState('');
  const [working, setWorking] = useState(false);
  const kinds = docKindsFor(taxOff);
  // الضغط غير متزامن: القائمة الحيّة من المرجع لا من لقطة الرسم — كل كتابة (إضافة صورة، نوعها، حذفها) تبني على آخر ما كُتب،
  // فلا تُعيد صورةٌ انتهى ضغطها قائمةً قديمة فوق نوعٍ غُيّر أو صورةٍ حُذفت في أثنائه
  const live = useRef(docs);
  live.current = docs;
  const write = (next: PickedDoc[]) => { live.current = next; onChange(next); };
  useEffect(() => { onBusy?.(working); }, [working, onBusy]);
  useEffect(() => () => { onBusy?.(false); }, [onBusy]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار الملف نفسه
    if (files.length === 0) return;
    setMsg(''); setWorking(true);
    try {
      for (const f of files) {
        if (live.current.length >= max) { setMsg(tr('الحد الأقصى {n} صور').replace('{n}', String(max))); break; }
        try {
          const data = await compressImage(f, DOC_COMPRESS);
          if (live.current.length < max) write([...live.current, { kind: 'OTHER', data }]);
        } catch { setMsg(tr('تعذرت قراءة إحدى الصور')); }
      }
    } finally { setWorking(false); }
  };

  const setKind = (i: number, kind: CustomerDocKind) => write(live.current.map((d, idx) => (idx === i ? { ...d, kind } : d)));
  const remove = (i: number) => write(live.current.filter((_, idx) => idx !== i));

  return (
    <div data-customer-docs-picker="">
      {docs.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-2">
          {docs.map((d, i) => (
            <div key={i} className="rounded-xl border border-gray-200 overflow-hidden bg-white">
              <div className="relative aspect-square bg-gray-50">
                <img src={d.data} alt="" className="w-full h-full object-cover" />
                <button type="button" onClick={() => remove(i)} aria-label={tr('حذف')}
                  className="absolute top-1 left-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center">
                  <X size={14} />
                </button>
              </div>
              <select value={d.kind} onChange={(e) => setKind(i, e.target.value as CustomerDocKind)} aria-label={tr('نوع الوثيقة')}
                className="w-full text-[11px] border-t border-gray-200 px-1.5 py-1.5 bg-white outline-none">
                {kinds.map((k) => <option key={k.code} value={k.code}>{tr(k.label)}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      {docs.length < max && (
        <div className="grid grid-cols-2 gap-2">
          {cameraCaptureCrashes() ? (
            // تطبيق «إدارة» 1.0.x على الآيفون بلا إذن كاميرا: فتحها يُغلق التطبيق (lib/appCamera.ts)
            <button type="button" onClick={() => setMsg(tr(NO_CAMERA_MSG))}
              className={`flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-300 py-3 text-xs font-medium text-gray-500 cursor-pointer hover:border-[#E15A30] hover:text-[#E15A30] active:bg-gray-50 ${working ? 'opacity-50 pointer-events-none' : ''}`}>
              <Camera size={16} /> {tr('تصوير')}
            </button>
          ) : (
            <label className={`flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-300 py-3 text-xs font-medium text-gray-500 cursor-pointer hover:border-[#E15A30] hover:text-[#E15A30] active:bg-gray-50 ${working ? 'opacity-50 pointer-events-none' : ''}`}>
              <Camera size={16} /> {tr('تصوير')}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
            </label>
          )}
          <label className={`flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-gray-300 py-3 text-xs font-medium text-gray-500 cursor-pointer hover:border-[#E15A30] hover:text-[#E15A30] active:bg-gray-50 ${working ? 'opacity-50 pointer-events-none' : ''}`}>
            <ImagePlus size={16} /> {tr('من الاستديو')}
            <input type="file" accept="image/*" multiple className="hidden" onChange={onPick} />
          </label>
        </div>
      )}
      <p className="text-[10px] text-gray-400 mt-1.5">
        {working ? tr('جاري تجهيز الصور') : tr('السجل التجاري أو الهوية أو صورة المحل وغيرها — تظهر في استديو العميل')} ({docs.length}/{max})
      </p>
      {msg && <p className="text-[11px] text-red-500 mt-1">{msg}</p>}
    </div>
  );
}
