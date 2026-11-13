/**
 * «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — خطوة «رفع النموذج» في مصمّم النموذج: تختار الشركة صورة
 * نموذجها الفارغ (JPG/PNG/WebP؛ وPDF برسالة حفظه صورة)، فتظهر بأركانٍ أربعة تُسحب إلى أركان الورقة (الافتراضي أركان الصورة:
 * المسح المستوي يطابقها أصلاً)، ثم «تصحيح وقص» يصحّح المنظور ويقصّ إلى مقاس ورق القالب بدقة 150 نقطة ويضغط JPEG
 * (lib/print/formImageCompose.ts) ويرفعه إلى /api/company/print-forms، فيعيد مرجع الصورة { id, v, wPx, hPx } بـonDone.
 *
 * السحب بأحداث المؤشّر (usePointerDrag: فأرة وإصبع وقلم، Esc يُرجع) ومقابض touch-action:none، والأسهم تحرّك الركن المركَّز
 * (Shift أسرع)، ومكبّرٌ صغير يُظهر ما تحت الإصبع أثناء السحب. الصورة دليلٌ على الشاشة وخلفيةٌ اختيارية للطباعة فقط.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, Crop, ImagePlus, Info, Loader2, RotateCcw, X } from 'lucide-react';
import { useTr } from '../../../i18n/strings';
import { usePointerDrag } from '../designer/usePointerDrag';
import {
  FORM_IMAGE_ACCEPT, FORM_UPLOAD_MESSAGES, FormImageError, classifyFormFile, composeFormImage, defaultFormQuad, fitWithin,
  formImageRefOf, formUploadErrorCode, formUploadErrorMessage, loadFormSource, quadAspectMismatch, quadUsable, releaseCanvas, withQuadCorner,
  type FormComposeStage, type FormSource, type Quad,
} from '../../../lib/print/formImageCompose';
import { formRasterPx, formSheetSize, type FormImageRef, type FormPaper } from '../../../lib/print/formModel';

export interface FormUploadStepProps {
  /** ورق القالب (العرض والطول بالمم) — مقاس الصورة المصحّحة */
  paper: FormPaper | null | undefined;
  /** صورة النموذج الحالية إن وُجدت (للتنبيه بأن الجديدة تستبدلها) */
  current?: FormImageRef | null;
  /** بعد الرفع: مرجع الصورة لتضعه في النموذج (withFormProps(form, { image })) — وcreated: صورةٌ جديدة (201) لا القائمة بالبصمة نفسها (200) */
  onDone(ref: FormImageRef, created: boolean): void;
  /** إغلاق الخطوة بلا رفع (اختياري) */
  onCancel?(): void;
  /** صورةٌ اختيرت ولم تُرفع بعد (وأركانٌ ربما وُضعت) — فيؤكّد المصمّم قبل الإغلاق بـEsc أو «إلغاء» */
  onPendingChange?(pending: boolean): void;
  /** الرفع رُدّ بسقف الشركة (409 PRINT_FORM_LIMIT): يحرّر المصمّم صور جلسته غير المستخدمة — true ⇒ يُعاد الرفع مرّةً واحدة */
  onLimit?(): Promise<boolean>;
}

/** أقصى عرضٍ للمعاينة بالبكسل (رسمٌ مصغّر من صورة العمل) */
const PREVIEW_MAX_PX = 1400;
/** المكبّر: قطره بالبكسل وتكبيره نسبةً إلى المعاينة */
const LOUPE_PX = 120;
const LOUPE_GAIN = 3;

const ACCENT = '#E15A30';

/** الأركان بالترتيب المعتمد (أعلى اليسار، أعلى اليمين، أسفل اليمين، أسفل اليسار) — ماديّاً لا حسب اتجاه الواجهة */
const CORNER_KEYS = ['tl', 'tr', 'br', 'bl'] as const;

export interface FormCornerHandlesProps {
  quad: Quad;
  /** فضاء الأركان (أبعاد صورة العمل) */
  w: number;
  h: number;
  disabled?: boolean;
  /** الركن الجاري سحبه (يُبرز) */
  active?: number | null;
  onCornerPointerDown(i: number, e: ReactPointerEvent<HTMLButtonElement>): void;
  onCornerKeyDown(i: number, e: ReactKeyboardEvent<HTMLButtonElement>): void;
}

/** المقابض الأربعة فوق المعاينة: مواضعها بالنسبة المئوية من صورة العمل (left/top ماديّان) */
export function FormCornerHandles({ quad, w, h, disabled, active, onCornerPointerDown, onCornerKeyDown }: FormCornerHandlesProps) {
  const tr = useTr();
  const label = (i: number): string => (i === 0 ? tr('ركن الورقة أعلى اليسار')
    : i === 1 ? tr('ركن الورقة أعلى اليمين')
      : i === 2 ? tr('ركن الورقة أسفل اليمين') : tr('ركن الورقة أسفل اليسار'));
  return (
    <>
      {quad.map((p, i) => (
        <button type="button" key={CORNER_KEYS[i]} data-form-corner={CORNER_KEYS[i]} disabled={disabled}
          aria-label={`${label(i)} — ${tr('اسحبه إلى ركن الورقة أو حركه بالأسهم')}`}
          title={label(i)}
          onPointerDown={(e) => onCornerPointerDown(i, e)}
          onKeyDown={(e) => onCornerKeyDown(i, e)}
          className="absolute flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1F1A13] disabled:opacity-50"
          style={{
            left: `${w > 0 ? (p.x / w) * 100 : 0}%`, top: `${h > 0 ? (p.y / h) * 100 : 0}%`,
            width: 36, height: 36, marginLeft: -18, marginTop: -18, touchAction: 'none', cursor: disabled ? 'default' : 'move',
            background: 'transparent',
          }}>
          <span aria-hidden="true" className="block rounded-full border-2 bg-white/90 shadow"
            style={{ width: active === i ? 22 : 16, height: active === i ? 22 : 16, borderColor: ACCENT }} />
        </button>
      ))}
    </>
  );
}

/** حدود الأركان على المعاينة وتعتيم ما خارج الورقة — SVG بفضاء صورة العمل يتمدّد مع المعاينة */
export function FormQuadOverlay({ quad, w, h, bad }: { quad: Quad; w: number; h: number; bad?: boolean }) {
  const pts = quad.map((p) => `${p.x},${p.y}`).join(' ');
  const outside = `M0,0H${w}V${h}H0Z M${quad.map((p) => `${p.x},${p.y}`).join(' L')} Z`;
  const stroke = bad ? '#B42318' : ACCENT;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full pointer-events-none">
      <path d={outside} fill="rgba(31,26,19,0.38)" fillRule="evenodd" />
      <polygon points={pts} fill="none" stroke={stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray={bad ? '6 4' : undefined} />
    </svg>
  );
}

export default function FormUploadStep({ paper, current, onDone, onCancel, onPendingChange, onLimit }: FormUploadStepProps) {
  const tr = useTr();
  const drag = usePointerDrag();
  const [src, setSrc] = useState<FormSource | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [stage, setStage] = useState<FormComposeStage | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [fileName, setFileName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const stageBoxRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // صورةٌ مختارة لم تُرفع: تُبلَّغ للمصمّم (ويُرفع العلم عند مغادرة الخطوة)
  const pendingRef = useRef(onPendingChange);
  pendingRef.current = onPendingChange;
  useEffect(() => { pendingRef.current?.(!!src); }, [src]);
  useEffect(() => () => pendingRef.current?.(false), []);

  const busy = stage !== null;
  const sheet = formSheetSize(paper);
  const raster = formRasterPx(paper);
  const usable = !!(src && quad && quadUsable(quad, src.w, src.h));
  const mismatch = !!(src && quad && usable && quadAspectMismatch(quad, paper));
  const preview = useMemo(() => (src ? fitWithin(src.w, src.h, PREVIEW_MAX_PX) : null), [src]);

  // صورة العمل السابقة تُحرَّر عند استبدالها أو إغلاق الخطوة (ذاكرة الجوال)
  useEffect(() => () => releaseCanvas(src?.canvas), [src]);

  // المعاينة: رسمٌ مصغّر من صورة العمل
  useEffect(() => {
    const c = previewRef.current;
    if (!c || !src || !preview) return;
    c.width = preview.w; c.height = preview.h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src.canvas, 0, 0, preview.w, preview.h);
  }, [src, preview]);

  // المكبّر: ما حول الركن المسحوب من صورة العمل نفسها، بتقاطعٍ صريح مع حدودها، وعلامة + في المركز
  useEffect(() => {
    const c = loupeRef.current;
    if (!c || !src || !quad || active === null) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const shownW = stageBoxRef.current?.getBoundingClientRect().width || preview?.w || src.w;
    const region = Math.min(400, Math.max(24, LOUPE_PX / LOUPE_GAIN / (shownW / src.w)));
    const p = quad[active];
    const x0 = p.x - region / 2; const y0 = p.y - region / 2;
    const k = LOUPE_PX / region;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
    const sx = Math.max(0, x0); const sy = Math.max(0, y0);
    const ex = Math.min(src.w, x0 + region); const ey = Math.min(src.h, y0 + region);
    if (ex > sx && ey > sy) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(src.canvas, sx, sy, ex - sx, ey - sy, (sx - x0) * k, (sy - y0) * k, (ex - sx) * k, (ey - sy) * k);
    }
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LOUPE_PX / 2, 0); ctx.lineTo(LOUPE_PX / 2, LOUPE_PX);
    ctx.moveTo(0, LOUPE_PX / 2); ctx.lineTo(LOUPE_PX, LOUPE_PX / 2);
    ctx.stroke();
  }, [src, quad, active, preview]);

  const pick = (): void => { if (!busy) inputRef.current?.click(); };

  const onFile = async (file: File | null | undefined): Promise<void> => {
    if (!file || busy) return;
    setError(null);
    const kind = classifyFormFile(file);
    if (kind !== 'image') { setError(FORM_UPLOAD_MESSAGES[kind]); return; }
    setStage('read');
    try {
      const s = await loadFormSource(file);
      if (!mounted.current) { releaseCanvas(s.canvas); return; }
      setSrc(s);
      setQuad(defaultFormQuad(s.w, s.h));
      setFileName(file.name || '');
      setActive(null);
    } catch (err) {
      if (mounted.current) setError(formUploadErrorMessage(err instanceof FormImageError ? err : new FormImageError('decode')));
    } finally {
      if (mounted.current) setStage(null);
    }
  };

  const resetCorners = (): void => { if (src && !busy) setQuad(defaultFormQuad(src.w, src.h)); };

  const onCornerPointerDown = useCallback((i: number, e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!src || !quad || busy) return;
    const box = stageBoxRef.current?.getBoundingClientRect();
    if (!box || !(box.width > 0) || !(box.height > 0)) return;
    const kx = src.w / box.width; const ky = src.h / box.height;
    const start = quad;
    const p0 = start[i];
    const at = (dx: number, dy: number): Quad => withQuadCorner(start, i, { x: p0.x + dx * kx, y: p0.y + dy * ky }, src.w, src.h);
    setActive(i);
    drag(e, {
      onMove: (dx, dy) => setQuad(at(dx, dy)),
      onCommit: (dx, dy) => { setQuad(at(dx, dy)); setActive(null); },
      onCancel: () => { setQuad(start); setActive(null); },
      onClick: () => setActive(null),
    });
  }, [src, quad, busy, drag]);

  const onCornerKeyDown = useCallback((i: number, e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!src || !quad || busy) return;
    const step = Math.max(1, Math.round(src.w / 600)) * (e.shiftKey ? 10 : 1);
    const d = e.key === 'ArrowLeft' ? [-step, 0] : e.key === 'ArrowRight' ? [step, 0]
      : e.key === 'ArrowUp' ? [0, -step] : e.key === 'ArrowDown' ? [0, step] : null;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const p = quad[i];
    setQuad(withQuadCorner(quad, i, { x: p.x + d[0], y: p.y + d[1] }, src.w, src.h));
  }, [src, quad, busy]);

  const run = async (): Promise<void> => {
    if (!src || !quad || busy || !usable) return;
    setError(null);
    setProgress(null);
    setStage('warp'); // مشغولٌ من النقرة الأولى: نقرةٌ ثانية لا ترفع مرتين
    try {
      const out = await composeFormImage(src, quad, paper, { onStage: (s) => { if (mounted.current) setStage(s); } });
      if (!mounted.current) return;
      setStage('upload');
      // العميل يُحمَّل عند الرفع وحده (استيرادٌ متأخّر كـFormCanvas): الخطوة تُرسم في الاختبار وتصيير الخادم بلا متجر الجلسة
      const { printFormsApi } = await import('../../../api/client');
      const send = () => printFormsApi.upload(out.blob, out.mime, (e) => {
        if (mounted.current && e.total && e.total > 0) setProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      });
      let res: Awaited<ReturnType<typeof send>>;
      try {
        res = await send();
      } catch (err) {
        // سقف الشركة: صور تجارب هذه الجلسة غير المستخدمة تُحذف (المصمّم) ثم يُعاد الرفع مرّة — وإلا فرسالة السقف
        if (formUploadErrorCode(err) !== 'limit' || !onLimit || !mounted.current || !(await onLimit()) || !mounted.current) throw err;
        setProgress(null);
        res = await send();
      }
      const ref = formImageRefOf((res.data as { data?: unknown } | undefined)?.data);
      if (!ref) throw new FormImageError('badResponse');
      if (!mounted.current) return;
      setStage(null);
      setProgress(null);
      onDone(ref, res.status === 201);
    } catch (err) {
      if (!mounted.current) return;
      setStage(null);
      setProgress(null);
      setError(formUploadErrorMessage(err));
    }
  };

  const stageLabel = (s: FormComposeStage): string => (s === 'read' ? tr('جار قراءة الصورة')
    : s === 'warp' ? tr('جار تصحيح الميل وقص الورقة')
      : s === 'encode' ? tr('جار ضغط الصورة') : tr('جار رفع الصورة'));

  const btn = 'inline-flex items-center gap-1 rounded-lg border border-[#E9E1D3] bg-white px-3 py-1.5 text-xs text-[#44403a] disabled:opacity-40';
  // النقطية (paper.reach): لا خلفية تُطبع (layoutFormBgImpact — والقراءة تُطفئها) فالصورة دليلٌ على الشاشة وحدها، لا «خلفية اختيارية»
  const sizeNote = (paper?.reach
    ? tr('يصحح النظام الميل ويقص الورقة إلى مقاس القالب {w} × {h} مم ({px} بكسل) — والصورة دليل للتصميم على الشاشة وحدها')
    : tr('يصحح النظام الميل ويقص الورقة إلى مقاس القالب {w} × {h} مم ({px} بكسل) — والصورة دليل للتصميم على الشاشة وخلفية اختيارية للطباعة'))
    .replace('{w}', String(sheet.widthMm)).replace('{h}', String(sheet.lengthMm)).replace('{px}', `${raster.wPx} × ${raster.hPx}`);

  return (
    <section className="flex flex-col gap-3" data-form-upload-step="" aria-busy={busy}>
      <div>
        <h3 className="text-sm font-bold text-[#1F1A13]">{tr('رفع صورة النموذج الفارغ')}</h3>
        <p className="mt-1 text-[11px] text-[#6E6557] leading-relaxed">
          {tr('صور نموذجك الفارغ (بلا بيانات) أو امسحه ضوئيا واضحا ومستويا، ثم ضع الأركان الأربعة على أركان الورقة')}
        </p>
        <p className="mt-0.5 text-[11px] text-[#9A8F7E] leading-relaxed">{sizeNote}</p>
        {current && (
          <p className="mt-1 text-[11px] text-[#44403a] flex items-center gap-1" data-form-upload-current="">
            <Info className="w-3 h-3 shrink-0" aria-hidden="true" />{tr('للنموذج صورة مرفوعة — الصورة الجديدة تحل محلها')}
          </p>
        )}
      </div>

      <input ref={inputRef} type="file" accept={FORM_IMAGE_ACCEPT} className="hidden" tabIndex={-1} aria-hidden="true"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onFile(f); }} />

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={pick} disabled={busy} className={btn}>
          <ImagePlus className="w-3.5 h-3.5" aria-hidden="true" />{src ? tr('صورة أخرى') : tr('اختيار صورة النموذج')}
        </button>
        {src && (
          <button type="button" onClick={resetCorners} disabled={busy} className={btn}>
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />{tr('إرجاع الأركان')}
          </button>
        )}
        {fileName && <span className="text-[11px] text-[#9A8F7E] truncate max-w-[14rem]" dir="auto">{fileName}</span>}
        <span className="ms-auto flex items-center gap-2">
          {onCancel && (
            <button type="button" onClick={onCancel} disabled={busy} className={btn}>
              <X className="w-3.5 h-3.5" aria-hidden="true" />{tr('إلغاء')}
            </button>
          )}
          <button type="button" onClick={() => { void run(); }} disabled={!src || !usable || busy}
            className="btn-primary !py-1.5 !px-3 text-xs inline-flex items-center gap-1" data-form-upload-apply="">
            <Crop className="w-3.5 h-3.5" aria-hidden="true" />{tr('تصحيح وقص')}
          </button>
        </span>
      </div>

      <div aria-live="polite" className="min-h-[1rem]">
        {busy && stage && (
          <p className="text-[11px] text-[#44403a] flex items-center gap-1" data-form-upload-stage={stage}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
            {stageLabel(stage)}{stage === 'upload' && progress !== null ? ` ${progress}%` : ''}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="text-[11px] text-[#8E2A1F] bg-[#FBEBE2] rounded px-2 py-1 flex items-start gap-1" data-form-upload-error="">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />{tr(error)}
        </p>
      )}

      {src && quad && preview ? (
        <>
          {!usable && (
            <p role="alert" className="text-[11px] text-[#8E2A1F] flex items-center gap-1">
              <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />{tr(FORM_UPLOAD_MESSAGES.quad)}
            </p>
          )}
          {mismatch && (
            <p className="text-[11px] text-[#8A5A00] flex items-center gap-1" role="note">
              <Info className="w-3 h-3 shrink-0" aria-hidden="true" />
              {tr('نسبة الأركان لا تشبه مقاس ورق القالب — تحقق من الأركان أو من مقاس الورق')}
            </p>
          )}
          {/* مساحة العمل: اللمس عليها لا يمرّر الصفحة (السحب من المقابض)، وارتفاعها حتى 60٪ من الشاشة فيبقى حولها ما يُمرَّر */}
          <div className="self-center max-w-full" dir="ltr">
            <div ref={stageBoxRef} className="relative select-none bg-white border border-[#E9E1D3]"
              style={{ width: `min(100%, calc(60vh * ${src.w / src.h}))`, aspectRatio: `${src.w} / ${src.h}`, touchAction: 'none' }}>
              <canvas ref={previewRef} className="block w-full h-full" aria-label={tr('صورة النموذج المختارة')} role="img" />
              <FormQuadOverlay quad={quad} w={src.w} h={src.h} bad={!usable} />
              <FormCornerHandles quad={quad} w={src.w} h={src.h} disabled={busy} active={active}
                onCornerPointerDown={onCornerPointerDown} onCornerKeyDown={onCornerKeyDown} />
              {active !== null && (
                <canvas ref={loupeRef} width={LOUPE_PX} height={LOUPE_PX} aria-hidden="true"
                  className="absolute top-2 rounded-full border-2 bg-white shadow-lg pointer-events-none"
                  style={{ width: LOUPE_PX, height: LOUPE_PX, borderColor: ACCENT, ...(quad[active].x < src.w / 2 ? { right: 8 } : { left: 8 }) }} />
              )}
            </div>
          </div>
          <p className="text-[11px] text-[#9A8F7E] text-center">
            {tr('اسحب كل نقطة إلى ركن الورقة المقابل — والصورة الممسوحة المستوية تطابق أركانها غالبا')}
          </p>
        </>
      ) : (
        !busy && (
          <button type="button" onClick={pick}
            className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#E9E1D3] bg-white px-4 py-10 text-[#6E6557] hover:border-[#E15A30]">
            <ImagePlus className="w-8 h-8" aria-hidden="true" />
            <span className="text-xs font-semibold">{tr('اختيار صورة النموذج')}</span>
            <span className="text-[11px] text-[#9A8F7E]">{tr('JPG أو PNG أو WebP — ملف PDF احفظه صورة أولا')}</span>
          </button>
        )
      )}
    </section>
  );
}
