import { useEffect, useRef, useState } from 'react';
import { Eraser } from 'lucide-react';

/**
 * لوحة توقيعٍ يدويّ بالإصبع أو القلم — توقيع المستلم على فاتورة المندوب.
 *
 * - أحداث المؤشّر (Pointer Events) تجمع اللمس والقلم والفأرة، و`touch-action: none`
 *   تمنع تمرير الصفحة أثناء التوقيع.
 * - الناتج PNG **مقصوصٌ على حدود الخطّ** بهامشٍ صغير ومصغَّرٌ إلى ٦٠٠ بكسل عرضاً على
 *   الأكثر: يُطبع متناسقاً آخر الفاتورة ويبقى بعشرات الكيلوبايت (الخادم يرفض فوق ٣٠٠).
 * - عند إعادة التركيب بقيمةٍ محفوظة (الرجوع لقائمة الأصناف ثم العودة) يُعرض التوقيع
 *   نفسه بدل لوحةٍ فارغة توهم بأنّ لا توقيع سيُرسَل.
 */

interface Props {
  value: string | null;
  onChange: (png: string | null) => void;
  height?: number;
  clearLabel: string;
  placeholder: string;
}

const MAX_OUT_W = 600;
const PAD = 10;

export default function SignaturePad({ value, onChange, height = 150, clearLabel, placeholder }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const bounds = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
  const dprRef = useRef(1);
  const [hasInk, setHasInk] = useState(!!value);

  const ctx = () => canvasRef.current?.getContext('2d') ?? null;

  // مقاس اللوحة مرّة عند التركيب بكثافة الشاشة — تغيير المقاس لاحقاً يمسح الرسم فلا نستمع له
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    dprRef.current = dpr;
    const w = c.getBoundingClientRect().width;
    c.width = Math.round(w * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineWidth = 2.4;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = '#111827';
    g.fillStyle = '#111827';
    if (value) {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min((w - PAD * 2) / img.width, (height - PAD * 2) / img.height, 1);
        const dw = img.width * scale;
        const dh = img.height * scale;
        g.drawImage(img, (w - dw) / 2, (height - dh) / 2, dw, dh);
      };
      img.src = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const grow = (p: { x: number; y: number }) => {
    const b = bounds.current;
    bounds.current = b
      ? { minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }
      : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = ctx();
    if (!g) return;
    e.preventDefault();
    // الالتقاط يُبقي الخطّ متّصلاً إن خرج الإصبع عن اللوحة — وفشله (مؤشّرٌ غير نشط) لا يمنع الرسم
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* يُرسم بلا التقاط */ }
    // توقيعٌ جديد فوق صورةٍ محفوظة معروضة: تبدأ الورقة بيضاء
    if (!bounds.current && value) {
      const c = canvasRef.current!;
      g.clearRect(0, 0, c.width, c.height);
    }
    drawing.current = true;
    const p = point(e);
    last.current = p;
    grow(p);
    g.beginPath();
    g.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
    g.fill();
  };

  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = ctx();
    const prev = last.current;
    if (!g || !prev) return;
    const p = point(e);
    const mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
    g.beginPath();
    g.moveTo(prev.x, prev.y);
    g.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
    grow(p);
  };

  /** يقصّ الرسم على حدوده بهامش ويصغّره — ويُرجع null إن لم يُرسم شيء */
  const exportPng = (): string | null => {
    const c = canvasRef.current;
    const b = bounds.current;
    if (!c || !b) return null;
    const dpr = dprRef.current;
    const cssW = c.width / dpr;
    const cssH = c.height / dpr;
    const x0 = Math.max(0, b.minX - PAD);
    const y0 = Math.max(0, b.minY - PAD);
    const x1 = Math.min(cssW, b.maxX + PAD);
    const y1 = Math.min(cssH, b.maxY + PAD);
    const sw = (x1 - x0) * dpr;
    const sh = (y1 - y0) * dpr;
    if (sw < 2 || sh < 2) return null;
    const scale = Math.min(1, MAX_OUT_W / sw);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const o = out.getContext('2d');
    if (!o) return null;
    o.drawImage(c, x0 * dpr, y0 * dpr, sw, sh, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  };

  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* أُفلت أصلاً */ }
    const png = exportPng();
    setHasInk(!!png);
    onChange(png);
  };

  const clear = () => {
    const c = canvasRef.current;
    const g = ctx();
    if (c && g) g.clearRect(0, 0, c.width, c.height);
    bounds.current = null;
    setHasInk(false);
    onChange(null);
  };

  return (
    <div>
      <div className="relative rounded-xl border-2 border-dashed border-gray-300 bg-white overflow-hidden">
        <canvas ref={canvasRef}
          className="block w-full cursor-crosshair"
          style={{ height, touchAction: 'none' }}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
        {!hasInk && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-300 select-none">
            {placeholder}
          </span>
        )}
        {/* خطّ التوقيع */}
        <span className="pointer-events-none absolute left-6 right-6 border-b border-gray-200" style={{ bottom: 28 }} />
      </div>
      {hasInk && (
        <button type="button" onClick={clear} className="mt-1.5 text-xs text-red-500 inline-flex items-center gap-1">
          <Eraser size={12} /> {clearLabel}
        </button>
      )}
    </div>
  );
}
