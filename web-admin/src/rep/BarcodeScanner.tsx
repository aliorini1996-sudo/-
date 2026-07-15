import { useEffect, useRef, useState } from 'react';
import { X, ScanLine } from 'lucide-react';
import { useTr } from '../i18n/strings';

// ماسح باركود لتطبيق المندوب — يستخدم BarcodeDetector الأصلي (مدعوم على Chrome أندرويد/تطبيق المندوب).
// عند عدم الدعم يعرض إدخالاً يدوياً بديلاً. onDetect يُستدعى بقيمة الكود المقروء.
export default function BarcodeScanner({ onDetect, onClose }: { onDetect: (code: string) => void; onClose: () => void }) {
  const tr = useTr();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const [supported] = useState(() => typeof window !== 'undefined' && 'BarcodeDetector' in window);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const detector = new (window as any).BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'],
    });

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }

        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes && codes.length > 0 && codes[0].rawValue) { onDetect(String(codes[0].rawValue)); return; }
          } catch { /* إطار غير قابل للقراءة — تجاهل وواصل */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setError(tr('تعذّر فتح الكاميرا — تحقّق من الإذن'));
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [supported, onDetect, tr]);

  return (
    <div className="fixed inset-0 bg-black z-[70] flex flex-col" dir="rtl">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center justify-between">
        <span className="font-bold flex items-center gap-2"><ScanLine size={18} /> {tr('مسح الباركود')}</span>
        <button onClick={onClose} className="p-1"><X size={22} /></button>
      </div>

      {supported ? (
        <div className="flex-1 relative flex items-center justify-center bg-black">
          <video ref={videoRef} className="max-h-full max-w-full" muted playsInline />
          {/* إطار توجيه */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-64 h-40 border-2 border-[#E15A30] rounded-lg" />
          </div>
          {error && <p className="absolute bottom-6 text-red-300 text-sm px-4 text-center">{error}</p>}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-3 text-center">
          <p className="text-gray-300 text-sm">{tr('المسح غير مدعوم على هذا المتصفّح — أدخل الباركود يدوياً')}</p>
          <input autoFocus className="input text-center" dir="ltr" value={manual}
            onChange={(e) => setManual(e.target.value)} placeholder={tr('رقم الباركود')} />
          <button onClick={() => manual.trim() && onDetect(manual.trim())}
            className="bg-[#E15A30] text-white rounded-lg px-6 py-2 font-semibold">{tr('بحث')}</button>
        </div>
      )}
    </div>
  );
}
