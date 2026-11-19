import { useState, type ChangeEvent } from 'react';
import { Camera, FileText, ImagePlus, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { NO_CAMERA_HINT, NO_CAMERA_MSG, cameraCaptureCrashes } from '../../../lib/appCamera';

/**
 * صينية «إرفاق مستند» في محادثة «المحاسب الذكي AI» (ويب و/m بـcompact) — تُفتح بزرّ 📎 في خانة الكتابة، بثلاثة أزرار
 * كمنتقي مرفقات المشتريات (PurchaseAttachmentsPicker): «تصوير» بالكاميرا مباشرة، و«من الاستديو» صوراً، و«ملف PDF».
 *
 * الصينية تجمع الملفات وحدها وتسلّمها للمحادثة (`onFiles`) — التجهيز (ضغط الصورة ≤ ٤٠٠ ك.ب وقراءة رمز QR على الجهاز) والرفع
 * هناك. لا شيء يُرسل لمزوّد ذكاء اصطناعي (قرار المالك D4): المستند يبقى في المنصة.
 *
 * تطبيق «إدارة» 1.0.x على الآيفون بلا إذن كاميرا (lib/appCamera.ts): فتحها يُغلق التطبيق، فزرّ «تصوير» يعرض NO_CAMERA_MSG
 * بدل خانة capture، وتحت خانة الاستديو تلميح NO_CAMERA_HINT (قائمة iOS فيها «التقاط صورة» يُغلقه كذلك).
 */
export default function AttachTray({ open, slots, max, disabled = false, onFiles, onClose, compact = false }: {
  open: boolean;
  /** ما بقي من مقاعد الرسالة — صفرٌ يعطّل الأزرار */
  slots: number;
  /** سقف المستندات في الرسالة الواحدة (status.docs.caps.perMessage — ٣) */
  max: number;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  onClose: () => void;
  compact?: boolean;
}) {
  const tr = useTr();
  const [msg, setMsg] = useState('');
  if (!open) return null;

  const off = disabled || slots <= 0;
  const noCamera = cameraCaptureCrashes();

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار الملف نفسه
    if (!files.length) return;
    setMsg(files.length > slots ? tr('{n} مستندات على الأكثر في الرسالة الواحدة').replace('{n}', String(max)) : '');
    onFiles(files.slice(0, Math.max(0, slots)));
  };

  const btn = `flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-[#E9E1D3] bg-white font-medium text-[#6E6557] cursor-pointer hover:border-[#E15A30] hover:text-[#E15A30] active:bg-[#FAF7F0] ${compact ? 'py-2 text-[11px]' : 'py-2.5 text-xs'} ${off ? 'opacity-50 pointer-events-none' : ''}`;

  return (
    <div data-ai-attach-tray="" className={compact ? 'px-3 pt-2' : 'px-4 pt-2'}>
      <div className="rounded-2xl border border-[#E9E1D3] bg-[#FAF7F0] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <p className="flex-1 min-w-0 text-[11px] text-[#6E6557] leading-snug">
            {tr('فاتورة أو إيصال أو عقد — صورة أو PDF. لا يرحل شيء قبل أن تراجعه وتضغط «سجّل القيد»')}
          </p>
          <button type="button" onClick={() => { setMsg(''); onClose(); }} aria-label={tr('إغلاق')} title={tr('إغلاق')}
            className="w-7 h-7 shrink-0 rounded-full text-[#6E6557] hover:bg-[#F1EBDF] flex items-center justify-center">
            <X size={14} />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {noCamera ? (
            // تطبيق «إدارة» 1.0.x على الآيفون بلا إذن كاميرا: فتحها يُغلق التطبيق (lib/appCamera.ts)
            <button type="button" className={btn} onClick={() => setMsg(tr(NO_CAMERA_MSG))} disabled={off}>
              <Camera size={16} /> {tr('تصوير')}
            </button>
          ) : (
            <label className={btn}>
              <Camera size={16} /> {tr('تصوير')}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} disabled={off} />
            </label>
          )}
          <label className={btn}>
            <ImagePlus size={16} /> {tr('من الاستديو')}
            <input type="file" accept="image/*" multiple className="hidden" onChange={onPick} disabled={off} />
          </label>
          <label className={btn}>
            <FileText size={16} /> {tr('ملف PDF')}
            <input type="file" accept="application/pdf" multiple className="hidden" onChange={onPick} disabled={off} />
          </label>
        </div>
        {noCamera && <p className="text-[10px] text-[#8A6A12] mt-1.5">{tr(NO_CAMERA_HINT)}</p>}
        <p className="text-[10px] text-[#9A8F7E] mt-1.5">
          {slots > 0
            ? tr('المتبقي لهذه الرسالة: {n} من {max}').replace('{n}', String(slots)).replace('{max}', String(max))
            : tr('{n} مستندات على الأكثر في الرسالة الواحدة').replace('{n}', String(max))}
        </p>
        {msg && <p role="alert" className="text-[11px] text-[#C0392B] mt-1">{msg}</p>}
      </div>
    </div>
  );
}
