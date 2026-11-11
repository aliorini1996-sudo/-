import { useEffect, useRef } from 'react';
import { burstWindowMs, cleanScan, createWedgeDetector, WEDGE_DEFAULTS, type WedgeOptions } from './laserScanner';

export type LaserScannerOptions = WedgeOptions & {
  /** أول حرفٍ في دفعةٍ جديدة، قبل أن يصل أي حقل: لحظة حفظ حالةٍ قد تغيّرها حروفها (بنودٌ تُحسب من حقلٍ مركَّز) */
  onBurstStart?: () => void;
  /** دفعةٌ رُفضت متعثّرة (توقّف القارئ وسطها) — بعد إعادة الحقل المركَّز، وقد أُوقف خاتمها ونُبّه بالفشل */
  onBurstAbort?: () => void;
};

/**
 * يستمع لقارئ الباركود الليزر على مستوى النافذة (طور الالتقاط) ما دام `enabled`: دفعةٌ سريعة تنتهي بـEnter ⇒ onScan(code)
 * بلا حقلٍ مركَّز ولا كاميرا (lib/laserScanner.ts).
 *
 * والحقل المركَّز وقت المسح (بحث الأصناف، كمية بند، تاريخ، قائمة select): القارئ كتب فيه قبل أن تُعرف الدفعة باركوداً،
 * فتُعاد قيمته كما كانت قبل أول حرفٍ منها (بالمُعيِّن الأصلي وحدث input، وchange للقائمة — فيقرؤه React كتعديلٍ عادي)،
 * ويُوقف Enter الخاتم قبل أن يصل React فلا يُرسل نموذجاً ولا يختار خياراً، ويُوقف خاتمٌ ثانٍ يليه (CR+LF).
 * والدفعة المتعثّرة تُرفض كلها: يُعاد الحقل ويُوقف خاتمها ونغمة فشل — فيعيد المستخدم المسح ولا يُضاف صنفٌ من ذيلها.
 * ولا يُلتقط شيءٌ ولا يُعاد في: الحقل المخصّص للقارئ (data-laser-field — يعالج نفسه فلا يُحسب مرّتين)، والنصّ الحرّ
 * (textarea)، وما وُسم data-laser-ignore (رقم فاتورةٍ يدوي، سبب) — ما يُكتب أو يُمسح فيها يبقى فيها.
 */
export function useLaserScanner(onScan: (code: string) => void, enabled = true, opts: LaserScannerOptions = {}) {
  const cb = useRef(onScan);
  cb.current = onScan;
  const onStart = useRef(opts.onBurstStart);
  onStart.current = opts.onBurstStart;
  const onAbort = useRef(opts.onBurstAbort);
  onAbort.current = opts.onBurstAbort;
  const maxGap = opts.maxGapMs ?? WEDGE_DEFAULTS.maxGapMs;
  const minLength = opts.minLength ?? WEDGE_DEFAULTS.minLength;
  const idleMinLength = opts.idleMinLength ?? WEDGE_DEFAULTS.idleMinLength;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const det = createWedgeDetector({ maxGapMs: maxGap, minLength, idleMinLength });
    let startEl: Restorable | null = null;
    let startVal = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    const restore = () => {
      if (startEl && startEl.isConnected) setNativeValue(startEl, startVal);
      startEl = null;
    };
    const abort = () => { restore(); scanFeedback(false); onAbort.current?.(); };
    const fire = (raw: string) => {
      restore();
      const code = cleanScan(raw);
      if (code) cb.current(code); else onAbort.current?.();
    };
    const drop = () => { det.reset(); clearTimer(); startEl = null; };
    const settle = (now: number) => {
      const r = det.idle(now);
      if (r.kind === 'scan') fire(r.code);
      else if (r.kind === 'broken') abort();
      else if (det.pending() === 0) startEl = null;
    };
    // السكون يُحسم بعد انقضاء نافذة الدفعة (Enter متأخّرٌ فيها ما زال مقبولاً) — ويُعاد التسليح إن سبق المؤقّتُ موعدَه
    const arm = () => {
      clearTimer();
      if (det.pending() === 0) return;
      timer = setTimeout(() => { timer = undefined; settle(performance.now()); arm(); }, burstWindowMs(maxGap) + 30);
    };

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const near = (sel: string) => !!t && typeof t.closest === 'function' && !!t.closest(sel);
      if (near('[data-laser-field]') || near('[data-laser-ignore]') || t instanceof HTMLTextAreaElement) { drop(); return; }
      if (e.isComposing) return;
      // مؤقّت السكون تأخّر عن موعده: تُحسم الدفعة السابقة قبل هذا المفتاح كما كان سيحسمها
      if (det.pending() > 0) settle(e.timeStamp);
      const r = det.key(e);
      if (r.kind === 'swallow') { e.preventDefault(); e.stopPropagation(); return; }
      if (r.kind === 'scan' || r.kind === 'broken') {
        if (r.kind === 'broken' || r.consume) { e.preventDefault(); e.stopPropagation(); }
        clearTimer();
        if (r.kind === 'scan') fire(r.code); else abort();
        return;
      }
      if (r.kind === 'start') {
        // الحقل المركَّز وقيمته **قبل** الحرف (keydown يسبق إدخاله)
        startEl = isRestorable(t) ? t : null;
        startVal = startEl ? startEl.value : '';
        onStart.current?.();
      } else if (det.pending() === 0) {
        startEl = null;
      }
      arm();
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      clearTimer();
    };
  }, [enabled, maxGap, minLength, idleMinLength]);
}

type Restorable = HTMLInputElement | HTMLSelectElement;

const VALUE_TYPES = new Set(['', 'text', 'search', 'number', 'tel', 'email', 'url', 'password', 'date', 'datetime-local', 'month', 'week', 'time']);
const DATE_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);

/** حقلٌ تغيّر الحروفُ قيمته فتُعاد: نصّيٌّ أو رقمي، والتاريخ والوقت (أرقام القارئ تملأ مقاطعه)، وselect (البحث بالكتابة يختار خياراً) */
function isRestorable(el: HTMLElement | null): el is Restorable {
  if (el instanceof HTMLSelectElement) return !el.disabled && !el.multiple;
  if (el instanceof HTMLInputElement) return VALUE_TYPES.has((el.type || '').toLowerCase()) && !el.readOnly && !el.disabled;
  return false;
}

/** يكتب قيمة حقلٍ يتحكّم به React كما لو غيّرها المستخدم (المُعيِّن الأصلي، ثم input — وchange للقائمة كما يسمعها React) */
function setNativeValue(el: Restorable, value: string) {
  const sel = el instanceof HTMLSelectElement;
  // التاريخ قد تبقى مقاطعه ناقصةً وقيمته '' كالأصل: يُكتب مع ذلك فتُمحى المقاطع
  if (el.value === value && (sel || !DATE_TYPES.has(el.type))) return;
  const proto = sel ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event(sel ? 'change' : 'input', { bubbles: true }));
}

/* ─── تأكيدٌ مسموع وملموس لكل مسح (القارئ بلا شاشة: المندوب يعرف النتيجة دون أن ينظر) ─── */

let audioCtx: AudioContext | null = null;

/** نغمةٌ قصيرة حادّة للنجاح، ونغمتان منخفضتان للفشل، واهتزاز — بلا ملفات صوت، وصامتٌ بصمتٍ حيث لا Web Audio */
export function scanFeedback(ok: boolean) {
  try {
    const g = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const C = g.AudioContext ?? g.webkitAudioContext;
    if (C) {
      audioCtx = audioCtx ?? new C();
      if (audioCtx.state === 'suspended') void audioCtx.resume();
      const tones = ok ? [[1760, 0, 0.08]] : [[300, 0, 0.12], [220, 0.16, 0.14]];
      for (const [freq, at, dur] of tones) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = ok ? 'sine' : 'square';
        osc.frequency.value = freq;
        gain.gain.value = ok ? 0.12 : 0.08;
        osc.connect(gain).connect(audioCtx.destination);
        const t0 = audioCtx.currentTime + at;
        osc.start(t0);
        osc.stop(t0 + dur);
      }
    }
  } catch { /* بلا صوت */ }
  try { navigator.vibrate?.(ok ? 40 : [60, 60, 60]); } catch { /* بلا اهتزاز */ }
}
