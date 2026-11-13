import { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, FileText, X } from 'lucide-react';
import { useTr } from '../i18n/strings';
import { NO_CAMERA_MSG, cameraCaptureCrashes } from '../lib/appCamera';
import { compressImage } from '../rep/imageCompress';
import {
  PURCHASE_ATT_COMPRESS, PURCHASE_ATT_MAX_PER_ENTRY, PURCHASE_ATT_MAX_PER_REQUEST, addProblem, checkAttachment, humanSize, isPdf, normalizePdfDataUrl,
  pdfFileProblem, pickedFileKind, problemText, safeImageSrc, slotsLeft, totalBytes, ATT_PROBLEM_KEYS, type PickedAttachment,
} from '../lib/purchaseAttachments';

/** يقرأ الملف data URL كما هو (PDF لا يُضغط) */
function readDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('read'));
    r.readAsDataURL(f);
  });
}

let seq = 0;
const nextKey = () => `pa-${Date.now().toString(36)}-${++seq}`;

/**
 * «إرفاق فاتورة المشتريات» (طلب المالك ١٣ نوفمبر ٢٠٢٦) — نافذة «استلام / تسوية» ونافذة مرفقات الحركة: تصويرٌ بالكاميرا مباشرة،
 * أو صورةٌ من استديو الجهاز (تُضغط على الجهاز JPEG)، أو ملف PDF كما هو بسقفه. كل مختارٍ شريحةٌ تُحذف (مصغّرةٌ للصورة وأيقونةٌ للـPDF،
 * والاسم والحجم). السقوف مرآة الخادم (lib/purchaseAttachments) والخادم هو الحَكَم.
 */
export default function PurchaseAttachmentsPicker({ items, onChange, existing = 0, max = PURCHASE_ATT_MAX_PER_REQUEST, onBusy, disabled = false }: {
  items: PickedAttachment[];
  onChange: (items: PickedAttachment[]) => void;
  /** المحفوظ للحركة من قبل (الإضافة اللاحقة) — يُحسب في سقف الحركة */
  existing?: number;
  max?: number;
  /** التجهيز جارٍ — الحاوية تعطّل «حفظ» به، وإلا حُفظت الحركة بلا ما لم يُجهَّز بعد */
  onBusy?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const tr = useTr();
  const [msg, setMsg] = useState('');
  const [working, setWorking] = useState(false);
  // التجهيز غير متزامن: القائمة الحيّة من المرجع لا من لقطة الرسم — فلا يُعيد ملفٌّ انتهى ضغطه قائمةً قديمة فوق شريحةٍ حُذفت في أثنائه
  const live = useRef(items);
  live.current = items;
  const write = (next: PickedAttachment[]) => { live.current = next; onChange(next); };
  useEffect(() => { onBusy?.(working); }, [working, onBusy]);
  useEffect(() => () => { onBusy?.(false); }, [onBusy]);

  const left = slotsLeft(items.length, existing, max);
  // سقف هذه الدفعة: سقف الطلب، أو ما بقي للحركة إن كان أقلّ
  const cap = Math.max(0, Math.min(max, PURCHASE_ATT_MAX_PER_ENTRY - existing));

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار الملف نفسه
    if (files.length === 0) return;
    setMsg(''); setWorking(true);
    try {
      for (const f of files) {
        const kind = pickedFileKind(f);
        if (!kind) { setMsg(tr(ATT_PROBLEM_KEYS.TYPE)); continue; }
        // السقف قبل القراءة: لا يُضغط ملفٌ لن يُضاف
        const full = addProblem(live.current, { mime: kind === 'pdf' ? 'application/pdf' : 'image/jpeg', size: 0 }, { existing, maxPerRequest: max });
        if (full && (full.code === 'TOO_MANY' || full.code === 'ENTRY_FULL')) { setMsg(problemText(full, tr)); break; }
        let data: string | null;
        if (kind === 'pdf') {
          const big = pdfFileProblem(f.size);
          if (big) { setMsg(problemText(big, tr)); continue; }
          try { data = normalizePdfDataUrl(await readDataUrl(f)); } catch { data = null; }
          if (!data) { setMsg(tr(ATT_PROBLEM_KEYS.CORRUPT)); continue; }
        } else {
          try { data = await compressImage(f, PURCHASE_ATT_COMPRESS); } catch { setMsg(tr('تعذرت قراءة إحدى الصور')); continue; }
        }
        const c = checkAttachment({ name: f.name, data }, existing + live.current.length + 1, nextKey());
        if (!c.ok) { setMsg(problemText(c.problem, tr)); continue; }
        const p = addProblem(live.current, c.att, { existing, maxPerRequest: max });
        if (p) { setMsg(problemText(p, tr)); if (p.code === 'TOO_MANY' || p.code === 'ENTRY_FULL') break; continue; }
        write([...live.current, c.att]);
      }
    } finally { setWorking(false); }
  };

  const remove = (key: string) => { setMsg(''); write(live.current.filter((a) => a.key !== key)); };

  const btn = `flex items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-[#E9E1D3] py-2.5 text-xs font-medium text-[#6E6557] cursor-pointer hover:border-[#E15A30] hover:text-[#E15A30] active:bg-[#FAF7F0] ${working || disabled ? 'opacity-50 pointer-events-none' : ''}`;

  return (
    <div data-purchase-attachments-picker="">
      {items.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {items.map((a) => {
            const src = safeImageSrc(a.data);
            return (
              <div key={a.key} className="flex items-center gap-2 rounded-xl border border-[#E9E1D3] bg-white p-1.5 pe-2">
                <div className="w-10 h-10 flex-shrink-0 rounded-lg overflow-hidden bg-[#FAF7F0] flex items-center justify-center">
                  {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : <FileText size={20} className={isPdf(a) ? 'text-[#C0392B]' : 'text-[#9A8F7E]'} />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-[#1F1A13] truncate"><bdi>{a.name}</bdi></p>
                  <p className="text-[10px] text-[#9A8F7E]" dir="ltr">{(a.mime.split('/')[1] ?? '').toUpperCase()} · {humanSize(a.size)}</p>
                </div>
                <button type="button" onClick={() => remove(a.key)} disabled={disabled} aria-label={tr('حذف')} title={tr('حذف')}
                  className="w-7 h-7 rounded-full text-[#6E6557] hover:bg-red-50 hover:text-red-600 flex items-center justify-center disabled:opacity-50">
                  <X size={15} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {left > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {cameraCaptureCrashes() ? (
            // تطبيق «إدارة» 1.0.x على الآيفون بلا إذن كاميرا: فتحها يُغلق التطبيق (lib/appCamera.ts)
            <button type="button" className={btn} onClick={() => setMsg(tr(NO_CAMERA_MSG))} disabled={working || disabled}>
              <Camera size={16} /> {tr('تصوير')}
            </button>
          ) : (
            <label className={btn}>
              <Camera size={16} /> {tr('تصوير')}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} disabled={working || disabled} />
            </label>
          )}
          <label className={btn}>
            <ImagePlus size={16} /> {tr('من الاستديو')}
            <input type="file" accept="image/*" multiple className="hidden" onChange={onPick} disabled={working || disabled} />
          </label>
          <label className={btn}>
            <FileText size={16} /> {tr('ملف PDF')}
            <input type="file" accept="application/pdf" multiple className="hidden" onChange={onPick} disabled={working || disabled} />
          </label>
        </div>
      )}
      <p className="text-[10px] text-[#9A8F7E] mt-1.5">
        {working ? tr('جاري تجهيز الصور') : tr('صورة الفاتورة أو ملف PDF')} ({items.length}/{cap})
        {items.length > 0 && <span dir="ltr"> · {humanSize(totalBytes(items))}</span>}
      </p>
      {msg && <p className="text-[11px] text-red-500 mt-1">{msg}</p>}
    </div>
  );
}
