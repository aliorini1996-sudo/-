import { useEffect, useRef, useState } from 'react';
import { X, ScanLine, Check, AlertCircle, ArrowLeft } from 'lucide-react';
import { useTr } from '../i18n/strings';

type ScanResult = { ok: boolean; label: string };

// ماسح باركود لتطبيق المندوب — مسح مستمرّ (يضيف عدة أصناف تباعاً) حتى يغلقه المستخدم.
// يستخدم BarcodeDetector الأصلي (مدعوم على Chrome/أندرويد) مع بديل إدخال يدوي.
// onDetect يُستدعى لكل كود مقروء ويُعيد {ok,label} لعرض تأكيد داخل الماسح.
// onProceed يغلق الماسح وينتقل لمراجعة/إتمام الفاتورة؛ itemCount = عدد الأصناف المُضافة (يظهر حيّاً).
export default function BarcodeScanner({ onDetect, onClose, onProceed, itemCount }: {
  onDetect: (code: string) => ScanResult; onClose: () => void; onProceed: () => void; itemCount: number;
}) {
  const tr = useTr();
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect; // يبقى محدَّثاً دون أن يكون تبعيّة للـeffect (يمنع إعادة تشغيل الكاميرا)

  const [supported] = useState(() => typeof window !== 'undefined' && 'BarcodeDetector' in window);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<ScanResult | null>(null);
  const [manual, setManual] = useState('');

  // منع تكرار نفس الكود المرئي: نتجاهل نفس الكود خلال نافذة تهدئة
  const lastCodeRef = useRef<string>('');
  const lastTimeRef = useRef<number>(0);

  const handleCode = (code: string) => {
    const now = Date.now();
    if (code === lastCodeRef.current && now - lastTimeRef.current < 2000) return; // تهدئة لنفس الكود
    lastCodeRef.current = code;
    lastTimeRef.current = now;
    const r = onDetectRef.current(code);
    setFeedback(r);
    setTimeout(() => setFeedback((f) => (f && f.label === r.label ? null : f)), 1500);
  };

  // تشغيل الكاميرا مرة واحدة عند الفتح (تبعيّة supported فقط — مستقرّة)
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = new (window as any).BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'],
    });

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => { /* تُقاطَع أحياناً — غير مؤثّر */ });
        }
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length > 0 && codes[0].rawValue) handleCode(String(codes[0].rawValue));
          } catch { /* إطار غير قابل للقراءة — تجاهل */ }
          if (!cancelled) raf = requestAnimationFrame(tick); // مسح مستمرّ — لا يتوقّف عند أول التقاط
        };
        raf = requestAnimationFrame(tick);
      } catch {
        setError(tr('تعذّر فتح الكاميرا — تحقّق من إذن الكاميرا'));
      }
    })();

    // تنظيف موثوق: إيقاف الحلقة + إيقاف مسارات الكاميرا + مسح المصدر
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  return (
    <div className="fixed inset-0 bg-black z-[70] flex flex-col" dir="rtl">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center justify-between">
        <span className="font-bold flex items-center gap-2"><ScanLine size={18} /> {tr('مسح الباركود')}</span>
        <button onClick={onClose} className="p-1 flex items-center gap-1 text-sm"><X size={20} /> {tr('إغلاق')}</button>
      </div>

      {supported ? (
        <div className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
          <video ref={videoRef} className="max-h-full max-w-full" muted playsInline />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-64 h-40 border-2 border-[#E15A30] rounded-lg" />
          </div>
          {/* تأكيد آخر مسح (فوق الشريط السفلي) */}
          {feedback && (
            <div className={`absolute bottom-20 left-4 right-4 rounded-xl px-4 py-3 flex items-center gap-2 text-white ${feedback.ok ? 'bg-[#1E7A52]' : 'bg-[#C0392B]'}`}>
              {feedback.ok ? <Check size={18} /> : <AlertCircle size={18} />}
              <span className="font-semibold text-sm truncate">{feedback.label}</span>
            </div>
          )}
          {error && <p className="absolute top-4 left-4 right-4 text-red-300 text-sm text-center bg-black/60 rounded p-2">{error}</p>}
          <p className="absolute top-3 left-0 right-0 text-center text-white/70 text-xs">{tr('وجّه الكاميرا نحو الباركود — يُضاف الصنف تلقائياً')}</p>

          {/* الشريط السفلي: عدّاد الأصناف المُضافة + زر المتابعة لإتمام الفاتورة */}
          <div className="absolute bottom-0 left-0 right-0 bg-[#1F1A13] p-3 flex items-center gap-3">
            <span className="text-white text-sm font-semibold">{itemCount} {tr('صنف مُضاف')}</span>
            <button onClick={onProceed} disabled={itemCount === 0}
              className="mr-auto bg-[#E15A30] text-white rounded-lg px-5 py-2 font-bold disabled:opacity-40 flex items-center gap-1">
              {tr('متابعة')} <ArrowLeft size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-3 text-center">
          <p className="text-gray-300 text-sm">{tr('المسح غير مدعوم على هذا المتصفّح — أدخل الباركود يدوياً')}</p>
          <input autoFocus className="input text-center" dir="ltr" value={manual}
            onChange={(e) => setManual(e.target.value)} placeholder={tr('رقم الباركود')} />
          <button onClick={() => { if (manual.trim()) { handleCode(manual.trim()); setManual(''); } }}
            className="bg-[#E15A30] text-white rounded-lg px-6 py-2 font-semibold">{tr('إضافة')}</button>
          {feedback && (
            <p className={`text-sm font-semibold ${feedback.ok ? 'text-green-400' : 'text-red-400'}`}>{feedback.label}</p>
          )}
        </div>
      )}
    </div>
  );
}
