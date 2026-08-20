import { useEffect, useRef, useState } from 'react';
import { X, ScanLine, Check, AlertCircle, ArrowLeft, Keyboard, Camera } from 'lucide-react';
import { useTr } from '../i18n/strings';

type ScanResult = { ok: boolean; label: string };

// أنواع الباركود المدعومة (BarcodeDetector يقبل أسماء صغيرة، ZXing يقبل ثوابت BarcodeFormat)
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'];

// كشف القدرات مرّة واحدة (خارج المكوّن — مستقرّ)
const HAS_NATIVE_DETECTOR = typeof window !== 'undefined' && 'BarcodeDetector' in window;
const HAS_CAMERA = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

// ماسح باركود لتطبيق المندوب — مسح مستمرّ (يضيف عدة أصناف تباعاً) حتى يغلقه المستخدم.
// أندرويد/كروم: يستخدم BarcodeDetector الأصلي (أسرع). iOS/سفاري: يستخدم ZXing عبر getUserMedia
// (BarcodeDetector غير مدعوم في WKWebView). وفي كل الأحوال يوجد بديل إدخال يدوي.
// onDetect يُستدعى لكل كود مقروء ويُعيد {ok,label} لعرض تأكيد داخل الماسح.
// onProceed يغلق الماسح وينتقل لمراجعة/إتمام الفاتورة؛ itemCount = عدد الأصناف المُضافة (يظهر حيّاً).
export default function BarcodeScanner({ onDetect, onClose, onProceed, itemCount }: {
  onDetect: (code: string) => ScanResult; onClose: () => void; onProceed: () => void; itemCount: number;
}) {
  const tr = useTr();
  const videoRef = useRef<HTMLVideoElement>(null);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect; // يبقى محدَّثاً دون أن يكون تبعيّة للـeffect (يمنع إعادة تشغيل الكاميرا)

  const canScan = HAS_NATIVE_DETECTOR || HAS_CAMERA;
  const [manualMode, setManualMode] = useState(false); // تبديل المستخدم للإدخال اليدوي
  const [cameraFailed, setCameraFailed] = useState(false); // فشل فتح/تحميل الكاميرا (إذن مرفوض مثلاً)
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

  const showManual = !canScan || manualMode || cameraFailed;

  // تشغيل الكاميرا عند العرض في وضع المسح (لا في الوضع اليدوي)
  useEffect(() => {
    if (!canScan || manualMode) return;
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let zxingControls: { stop: () => void } | null = null;

    (async () => {
      try {
        if (HAS_NATIVE_DETECTOR) {
          // ---- مسار أندرويد/كروم: BarcodeDetector الأصلي ----
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const detector = new (window as any).BarcodeDetector({ formats: NATIVE_FORMATS });
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
        } else {
          // ---- مسار iOS/سفاري: ZXing عبر getUserMedia (تحميل ديناميكي — لا يُثقل حزمة أندرويد) ----
          const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
            import('@zxing/browser'),
            import('@zxing/library'),
          ]);
          if (cancelled || !videoRef.current) return;
          const hints = new Map();
          hints.set(DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.CODE_128,
            BarcodeFormat.CODE_39, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.QR_CODE,
          ]);
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 120 });
          // ZXing يفتح الكاميرا ويربطها بعنصر الفيديو ويفكّ باستمرار عبر callback
          zxingControls = await reader.decodeFromConstraints(
            { video: { facingMode: 'environment' } },
            videoRef.current,
            (result) => { if (result) handleCode(result.getText()); },
          );
          if (cancelled) { zxingControls.stop(); zxingControls = null; }
        }
      } catch {
        if (!cancelled) {
          setError(tr('تعذر فتح الكاميرا تحقق من إذن الكاميرا أو أدخل الباركود يدويا'));
          setCameraFailed(true);
        }
      }
    })();

    // تنظيف موثوق: إيقاف الحلقة/الماسح + إيقاف مسارات الكاميرا + مسح المصدر
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      try { zxingControls?.stop(); } catch { /* تجاهل */ }
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canScan, manualMode]);

  const switchToManual = () => { setManualMode(true); setError(''); };
  const switchToCamera = () => { setManualMode(false); setCameraFailed(false); setError(''); };

  return (
    <div className="fixed inset-0 bg-black z-[70] flex flex-col" dir="rtl">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center justify-between">
        <span className="font-bold flex items-center gap-2"><ScanLine size={18} /> {tr('مسح الباركود')}</span>
        <button onClick={onClose} className="p-1 flex items-center gap-1 text-sm"><X size={20} /> {tr('إغلاق')}</button>
      </div>

      {!showManual ? (
        <div className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
          <video ref={videoRef} className="max-h-full max-w-full" muted playsInline autoPlay />
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
          <p className="absolute top-3 left-0 right-0 text-center text-white/70 text-xs">{tr('وجه الكاميرا نحو الباركود يضاف الصنف تلقائيا')}</p>

          {/* الشريط السفلي: إدخال يدوي + عدّاد الأصناف + زر المتابعة لإتمام الفاتورة */}
          <div className="absolute bottom-0 left-0 right-0 bg-[#1F1A13] p-3 flex items-center gap-3">
            <button onClick={switchToManual} className="text-white/80 text-xs flex items-center gap-1 shrink-0">
              <Keyboard size={16} /> {tr('يدوي')}
            </button>
            <span className="text-white text-sm font-semibold">{itemCount} {tr('صنف مضاف')}</span>
            <button onClick={onProceed} disabled={itemCount === 0}
              className="mr-auto bg-[#E15A30] text-white rounded-lg px-5 py-2 font-bold disabled:opacity-40 flex items-center gap-1">
              {tr('متابعة')} <ArrowLeft size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-3 text-center">
          <p className="text-gray-300 text-sm">
            {cameraFailed ? (error || tr('تعذر فتح الكاميرا أدخل الباركود يدويا'))
              : !canScan ? tr('المسح غير مدعوم على هذا المتصفح أدخل الباركود يدويا')
              : tr('أدخل الباركود يدويا')}
          </p>
          <input autoFocus className="input text-center" dir="ltr" value={manual}
            onChange={(e) => setManual(e.target.value)} placeholder={tr('رقم الباركود')}
            onKeyDown={(e) => { if (e.key === 'Enter' && manual.trim()) { handleCode(manual.trim()); setManual(''); } }} />
          <button onClick={() => { if (manual.trim()) { handleCode(manual.trim()); setManual(''); } }}
            className="bg-[#E15A30] text-white rounded-lg px-6 py-2 font-semibold">{tr('إضافة')}</button>
          {feedback && (
            <p className={`text-sm font-semibold ${feedback.ok ? 'text-green-400' : 'text-red-400'}`}>{feedback.label}</p>
          )}
          {canScan && !cameraFailed && (
            <button onClick={switchToCamera} className="text-white/70 text-xs flex items-center gap-1 mt-2">
              <Camera size={16} /> {tr('العودة للكاميرا')}
            </button>
          )}
          {/* شريط سفلي للمتابعة يبقى متاحاً في الوضع اليدوي */}
          <div className="fixed bottom-0 left-0 right-0 bg-[#1F1A13] p-3 flex items-center gap-3">
            <span className="text-white text-sm font-semibold">{itemCount} {tr('صنف مضاف')}</span>
            <button onClick={onProceed} disabled={itemCount === 0}
              className="mr-auto bg-[#E15A30] text-white rounded-lg px-5 py-2 font-bold disabled:opacity-40 flex items-center gap-1">
              {tr('متابعة')} <ArrowLeft size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
