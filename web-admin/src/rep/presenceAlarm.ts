// جرس «أثبت تواجدك» داخل التطبيق (طلب المالك، ٤ نوفمبر ٢٠٢٦): صوت منبّه واهتزاز يتكرّران ما دامت نافذة الطلب (PresenceCheck.tsx)
// تنتظر الضغط — حتى «أثبت تواجدي» أو ظهور النتيجة أو انتهاء المهلة، وبسقف ثلاث دقائق من أوّل رنينٍ للطلب.
//
// صرفٌ بلا React، ولا يلمس window/document/navigator عند الاستيراد: كل ما في المتصفح عبر بيئةٍ تُحقن (فيُختبر بـnode:test).
// نغمةٌ مولّدة بـWeb Audio (لا ملفات صوت)، واهتزازٌ بـnavigator.vibrate يُعاد كل دورة. قيود المتصفحات:
//   - الصوت يلزمه تفاعلٌ سابق في الصفحة (سياسة التشغيل التلقائي): installPresenceAlarmUnlock يفتحه بأوّل لمسة — وiOS يشترط أن يبدأ
//     التشغيل داخل اللمسة نفسها مرّةً، ثمّ يُستأنف بلا لمسة. وسياقٌ موقوف لا تُجدول عليه نغمة (وإلّا انطلقت كلها معاً عند استئنافه).
//   - الاهتزاز يلزمه لمسةٌ سابقة والصفحة ظاهرة، ولا وجود له في iOS — كل ذلك صامتٌ بلا خطأ.
//   - والصفحة مخفية لا رنين هنا (الإشعار يرنّ: قناة الإنذار في تطبيق أندرويد)؛ تعود ظاهرةً فيعود ما بقي من السقف.
//   - وظاهرةً يُبقي الشاشة مضيئة ما دام يرنّ (Screen Wake Lock، بلا إذن): الجوال الموضوع والتطبيق مفتوح لا تنطفئ شاشته بمهلتها
//     فيسكت الجرس قبل السقف. حيث لا يوجد أو رُفض: صامتٌ بلا خطأ، والمتصفح يحرّره وحده والصفحة مخفية فيُطلب ثانيةً بظهورها.
//   - صوت الصفحة على مستوى «الوسائط» في أندرويد: وسائطٌ مكتومة ⇒ جرسٌ صامت (قناة الإنذار وحدها على مستوى المنبّه).
// لا شيء هنا يرمي: فشل الصوت لا يوقف الاهتزاز ولا العكس، وأسوأ الحالات نافذةٌ صامتة كما كانت.

/** سقف الرنين لكل طلب من أوّل رنين — لا تعيده إعادة التركيب (StrictMode) ولا إعادة النبضة فتحه بعد «إغلاق مؤقت» */
export const PRESENCE_ALARM_CAP_MS = 180_000;
/** دورة الجرس: رشقة نغماتٍ ثمّ صمتٌ حتى تمام الدورة، والاهتزاز يُعاد معها */
export const PRESENCE_ALARM_CYCLE_MS = 2_000;
/** رشقةٌ بنغمتين متناوبتين في نطاق ١٫٣–١٫٨ كيلوهرتز (أعلى ما تُخرجه سمّاعة الجوال) — at وms بالمللي ثانية من بدء الدورة */
export const PRESENCE_BEEPS: ReadonlyArray<{ at: number; hz: number; ms: number }> = [
  { at: 0, hz: 1760, ms: 120 },
  { at: 180, hz: 1320, ms: 120 },
  { at: 360, hz: 1760, ms: 120 },
  { at: 540, hz: 1320, ms: 120 },
];
/** اهتزازٌ مع الرشقة (١٫٣٥ ث) ثمّ سكونٌ حتى الدورة التالية — طولٌ فرديّ: آخره اهتزازٌ لا وقفةٌ تُسقط */
export const PRESENCE_VIBRATE: readonly number[] = [600, 150, 600];
/** شدّة النغمة: تبدأ أخفّ وتعلو في الدورات الأولى */
export const PRESENCE_GAIN = { from: 0.2, to: 0.35, rampCycles: 3 } as const;

interface ParamLike { setValueAtTime(v: number, t: number): unknown; linearRampToValueAtTime(v: number, t: number): unknown }
interface NodeLike { connect(dest: unknown): unknown; disconnect(): void }
export interface OscLike extends NodeLike { type: string; frequency: ParamLike; start(when?: number): void; stop(when?: number): void; onended: (() => void) | null }
export interface GainLike extends NodeLike { gain: ParamLike }
export interface BufferSrcLike extends NodeLike { buffer: unknown; start(when?: number): void; onended: (() => void) | null }
/** ما يلزم من AudioContext — lib.dom في TypeScript 5.9 بلا webkitAudioContext ولا audioSession، فالأنواع هنا */
export interface AudioCtxLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<unknown> | void;
  suspend(): Promise<unknown> | void;
  createOscillator(): OscLike;
  createGain(): GainLike;
  createBuffer(channels: number, length: number, rate: number): unknown;
  createBufferSource(): BufferSrcLike;
}

/** ما يلزم من WakeLockSentinel — released يحمله Chrome 87+ (true حين حرّره المتصفح) */
export interface ScreenLockLike { readonly released?: boolean; release(): Promise<unknown> | void }

/** المتصفح كما يراه الجرس — يُحقن في الاختبار */
export interface AlarmEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  visible(): boolean;
  onVisibility(fn: () => void): () => void;
  /** AudioContext أو webkitAudioContext — null بلا Web Audio */
  makeContext(): AudioCtxLike | null;
  /** navigator.vibrate — false إن رُفض (لا لمسة بعد، أو مخفية) */
  vibrate(p: readonly number[] | 0): boolean | void;
  /** navigator.audioSession (Safari 16.4+) — null حيث لا وجود له */
  audioSession(): { type: string } | null;
  /** navigator.wakeLock.request('screen') (Chrome 84+، Safari 16.4+) — null حيث لا وجود له */
  wakeLock(): Promise<ScreenLockLike> | null;
}

export interface PresenceAlarm {
  start(checkId: string): void;
  /** بمعرّفٍ: لا يوقف جرس طلبٍ آخر */
  stop(checkId?: string): void;
  /** ضغط المندوب: يسكت ولا يعود لهذا الطلب */
  silence(checkId: string): void;
  /** من داخل لمسةٍ حقيقية (installPresenceAlarmUnlock) */
  unlock(): void;
  readonly running: boolean;
  readonly unlocked: boolean;
}

const noop = () => { /* لا شيء */ };
const safe = (fn: () => void) => { try { fn(); } catch { /* الجرس لا يرمي أبداً */ } };
/** وعدٌ قد يُرفض أو يبقى معلّقاً أبداً (Chrome يُبقي resume معلّقاً ما لم يُسمح بالصوت) — لا يُنتظر ولا يرمي */
function quietly(p: unknown, then?: () => void): void {
  if (p && typeof (p as Promise<unknown>).then === 'function') (p as Promise<unknown>).then(() => { if (then) safe(then); }, noop);
}

type AudioCtor = new () => AudioCtxLike;
function browserEnv(): AlarmEnv {
  // يُقرأ عند النداء لا عند الإنشاء: الاستيراد لا يلمس المتصفح
  const g = globalThis as unknown as {
    document?: Document;
    navigator?: Navigator & { audioSession?: { type: string } };
    AudioContext?: AudioCtor;
    webkitAudioContext?: AudioCtor;
  };
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
    visible: () => g.document?.visibilityState === 'visible',
    onVisibility: (fn) => {
      const d = g.document;
      if (!d) return noop;
      d.addEventListener('visibilitychange', fn);
      return () => d.removeEventListener('visibilitychange', fn);
    },
    makeContext: () => {
      const C = g.AudioContext ?? g.webkitAudioContext;
      return C ? new C() : null;
    },
    vibrate: (p) => {
      const n = g.navigator;
      return n && typeof n.vibrate === 'function' ? n.vibrate(p === 0 ? 0 : [...p]) : false;
    },
    audioSession: () => {
      const s = g.navigator?.audioSession;
      return s && typeof s === 'object' ? s : null;
    },
    wakeLock: () => {
      const w = (g.navigator as { wakeLock?: { request?: (type: 'screen') => Promise<ScreenLockLike> } } | undefined)?.wakeLock;
      return w && typeof w.request === 'function' ? w.request('screen') : null;
    },
  };
}

export function createPresenceAlarm(over: Partial<AlarmEnv> = {}): PresenceAlarm {
  const env: AlarmEnv = { ...browserEnv(), ...over };
  let ctx: AudioCtxLike | null = null;
  let ctxBroken = false;
  // طلبٌ واحد في كل حين: معرّفه ولحظة أوّل رنينه، وهل أسكته المندوب
  let cur: { id: string; firstAt: number; silenced: boolean } | null = null;
  let running = false;
  let rung = 0; // دورات هذا الرنين — للشدّة المتدرّجة
  let seq = 0;  // رقم الدورة — نغمات استئنافٍ متأخر لا تُعزف لدورةٍ مضت
  let cycleTimer: unknown = null;
  let capTimer: unknown = null;
  let unsubVis: (() => void) | null = null;
  let buzzing = false;
  let live: { osc: OscLike; gain: GainLike }[] = [];
  let savedSession: string | null = null;
  let unlocked = false;
  let blank: unknown = null;
  // قفل الشاشة أثناء الرنين: طلبٌ واحد لكل ظهور (الرفض لا يُعاد كل دورة)، ورقمٌ يُحرِّر فوراً قفلاً وصل بعد الإسكات أو الإخفاء
  let lock: ScreenLockLike | null = null;
  let lockAsked = false;
  let lockGen = 0;

  const audio = (): AudioCtxLike | null => {
    if (ctx || ctxBroken) return ctx;
    try { ctx = env.makeContext(); } catch { ctxBroken = true; ctx = null; }
    return ctx;
  };
  const capLeft = () => (cur ? cur.firstAt + PRESENCE_ALARM_CAP_MS - env.now() : 0);
  const peakFor = (n: number) => {
    const k = Math.max(0, n - 1) / PRESENCE_GAIN.rampCycles;
    return k >= 1 ? PRESENCE_GAIN.to : PRESENCE_GAIN.from + (PRESENCE_GAIN.to - PRESENCE_GAIN.from) * k;
  };

  function clearCycle(): void {
    if (cycleTimer == null) return;
    const h = cycleTimer; cycleTimer = null;
    safe(() => env.clearTimeout(h));
  }

  // iOS: الافتراضي «auto» كالـambient — يُسكته مفتاح الصامت؛ playback يُسمع معه ويوقف موسيقى المندوب، فأثناء الرنين وحده
  function playbackSession(): void {
    safe(() => {
      const s = env.audioSession();
      if (!s || s.type === 'playback') return;
      if (savedSession == null) savedSession = s.type;
      s.type = 'playback';
    });
  }
  function restoreSession(): void {
    if (savedSession == null) return;
    const prev = savedSession; savedSession = null;
    safe(() => { const s = env.audioSession(); if (s) s.type = prev; });
  }

  /** يُبقي الشاشة مضيئة ما دام يرنّ والصفحة ظاهرة — لا يُنتظر ولا يرمي */
  function holdScreen(): void {
    if (lock) {
      if (lock.released !== true) return;
      lock = null; lockAsked = false; // حرّره المتصفح والصفحة ظاهرة: طلبٌ آخر
    }
    if (lockAsked) return;
    lockAsked = true;
    const gen = lockGen;
    let p: Promise<ScreenLockLike> | null = null;
    try { p = env.wakeLock(); } catch { p = null; }
    if (!p || typeof p.then !== 'function') return;
    p.then((s) => safe(() => {
      if (!s) return;
      if (gen === lockGen && running && env.visible()) { lock = s; return; }
      quietly(s.release());
    }), noop);
  }
  function releaseScreen(): void {
    lockGen++;
    lockAsked = false;
    const s = lock; lock = null;
    if (s) safe(() => quietly(s.release()));
  }

  /** يُسكت ما يُسمع الآن — الصفحة اختفت (والجرس قائم) أو انتهى */
  function quiet(): void {
    clearCycle();
    releaseScreen();
    if (buzzing) { buzzing = false; safe(() => { env.vibrate(0); }); }
    const nodes = live; live = [];
    for (const n of nodes) {
      safe(() => { n.osc.onended = null; n.osc.stop(); });
      safe(() => { n.osc.disconnect(); n.gain.disconnect(); });
    }
    restoreSession();
  }

  function tones(c: AudioCtxLike, peak: number): void {
    // على ساعة الصوت لا المؤقّتات: الرشقة متّسقةٌ ولو تأخّر المؤقّت
    const t0 = c.currentTime + 0.03;
    for (const b of PRESENCE_BEEPS) {
      const s = t0 + b.at / 1000;
      const e = s + b.ms / 1000;
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(b.hz, s);
      // غلافٌ قصير (٥ م.ث صعوداً و١٠ هبوطاً): بلا طقطقة
      gain.gain.setValueAtTime(0, s);
      gain.gain.linearRampToValueAtTime(peak, s + 0.005);
      gain.gain.setValueAtTime(peak, e - 0.01);
      gain.gain.linearRampToValueAtTime(0, e);
      osc.connect(gain);
      gain.connect(c.destination);
      const node = { osc, gain };
      osc.onended = () => { live = live.filter((x) => x !== node); safe(() => { osc.disconnect(); gain.disconnect(); }); };
      live.push(node);
      osc.start(s);
      osc.stop(e + 0.01);
    }
  }

  function sound(): void {
    const c = audio();
    if (!c) return;
    // أغلقه النظام: سياقٌ جديد في الدورة التالية
    if (c.state === 'closed') { ctx = null; return; }
    playbackSession();
    if (c.state === 'running') { tones(c, peakFor(rung)); return; }
    // موقوف (لا لمسة بعد، أو أوقفه النظام، أو «interrupted»): استئنافٌ لا يُنتظر — ونغمات هذه الدورة بعده إن بقيت هي الدورة
    // والجرس قائماً والصفحة ظاهرة. لا جدولة على سياقٍ موقوف
    const mine = seq;
    const n = rung;
    quietly(c.resume(), () => { if (running && mine === seq && env.visible() && c.state === 'running') tones(c, peakFor(n)); });
  }

  function runCycle(): void {
    cycleTimer = null;
    if (!running) return;
    // المؤقّتات تتأخّر والصفحة مخفية: السقف بالساعة لا بالمؤقّت وحده
    if (capLeft() <= 0) { halt(); return; }
    if (!env.visible()) return; // يعود به onVisibility
    seq++; rung++;
    safe(holdScreen);
    safe(() => { if (env.vibrate(PRESENCE_VIBRATE) !== false) buzzing = true; });
    safe(sound);
    cycleTimer = env.setTimeout(() => safe(runCycle), PRESENCE_ALARM_CYCLE_MS);
  }

  function onVisibility(): void {
    safe(() => {
      if (!running) return;
      // مخفية: لا رنين هنا ولا اهتزاز — Blink يُبقي Web Audio يعزف في الخلفية، فالإيقاف بأيدينا (والإشعار يرنّ)
      if (!env.visible()) { quiet(); return; }
      if (cycleTimer == null) runCycle();
    });
  }

  function halt(): void {
    const was = running;
    running = false;
    if (capTimer != null) { const h = capTimer; capTimer = null; safe(() => env.clearTimeout(h)); }
    if (unsubVis) { const u = unsubVis; unsubVis = null; safe(u); }
    quiet();
    // توفيرٌ للبطارية — suspend لا close: الإغلاق يُضيع فتح iOS (سياقٌ جديد يلزمه لمسةٌ أخرى)
    if (was && ctx) { const c = ctx; safe(() => quietly(c.suspend())); }
  }

  return {
    start(checkId) {
      safe(() => {
        if (!cur || cur.id !== checkId) {
          if (running) halt();
          cur = { id: checkId, firstAt: env.now(), silenced: false };
        }
        if (cur.silenced || running) return;
        const left = capLeft();
        if (left <= 0) return;
        running = true;
        rung = 0;
        unsubVis = env.onVisibility(onVisibility);
        capTimer = env.setTimeout(() => safe(halt), left);
        runCycle();
      });
    },
    stop(checkId) {
      if (checkId !== undefined && cur && cur.id !== checkId) return;
      safe(halt);
    },
    silence(checkId) {
      safe(() => {
        if (!cur || cur.id !== checkId) cur = { id: checkId, firstAt: env.now(), silenced: true };
        else cur.silenced = true;
        halt();
      });
    },
    unlock() {
      safe(() => {
        if (unlocked) return;
        ctxBroken = false; // لمسةٌ حقيقية: محاولةٌ أخرى لإنشاء السياق
        const c = audio();
        if (!c) return;
        // Chrome يُنشئه «running» داخل اللمسة: مفتوحٌ — ويوقف حتى يرنّ طلب (وإلّا بقي يعمل من أوّل لمسةٍ إلى أوّل طلب)، ما لم يكن
        // يرنّ الآن. والاستئناف بعده بلا لمسة مسموح (تفعيلٌ ثابت في الصفحة)، كما في halt
        if (c.state === 'running') { unlocked = true; if (!running) safe(() => quietly(c.suspend())); return; }
        // داخل اللمسة نفسها وبلا انتظار: استئنافٌ ومخزنٌ صامت بإطارٍ واحد (WebKit يرفع القيد بتشغيلٍ يبدأ في لمسة)، ثمّ إيقافٌ
        // حتى يرنّ طلب — ما لم يكن يرنّ الآن
        safe(() => quietly(c.resume(), () => { unlocked = true; if (!running) quietly(c.suspend()); }));
        safe(() => {
          if (!blank) blank = c.createBuffer(1, 1, 22050);
          const src = c.createBufferSource();
          src.buffer = blank;
          src.connect(c.destination);
          src.onended = () => safe(() => src.disconnect());
          src.start(0);
        });
      });
    },
    get running() { return running; },
    get unlocked() { return unlocked; },
  };
}

// الجرس المشترك للتطبيق — يُنشأ عند أوّل نداء لا عند الاستيراد
let shared: PresenceAlarm | null = null;
const appAlarm = (): PresenceAlarm => {
  if (!shared) shared = createPresenceAlarm();
  return shared;
};
export const startPresenceAlarm = (checkId: string): void => appAlarm().start(checkId);
export const stopPresenceAlarm = (checkId?: string): void => appAlarm().stop(checkId);
export const silencePresenceAlarm = (checkId: string): void => appAlarm().silence(checkId);

/** أحداث «تفعيل المستخدم» في HTML — لا pointerdown ولا touchstart: لا تُحتسب لمسةً في WebKit */
export const PRESENCE_UNLOCK_EVENTS = ['pointerup', 'touchend', 'click', 'keydown'] as const;

/**
 * يفتح صوت الجرس بأوّل لمسةٍ في التطبيق (قبل أن يصل طلب) — ويُزال حين يُرى السياق يعمل. يعيد مُزيلاً (useEffect).
 * RepApp يركّبه للمقيَّد بالتحقق وحده: غيره لا يُنشأ له سياق صوت أصلاً
 */
export function installPresenceAlarmUnlock(target?: EventTarget | null, alarm?: PresenceAlarm): () => void {
  let t: EventTarget | null = null;
  try { t = target !== undefined ? target : typeof document !== 'undefined' ? document : null; } catch { t = null; }
  if (!t) return noop;
  const el = t;
  const a = alarm ?? appAlarm();
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  let off = false;
  const remove = () => {
    if (off) return;
    off = true;
    for (const e of PRESENCE_UNLOCK_EVENTS) safe(() => el.removeEventListener(e, on, opts));
  };
  const on = () => {
    if (a.unlocked) { remove(); return; }
    a.unlock();
    if (a.unlocked) remove();
  };
  for (const e of PRESENCE_UNLOCK_EVENTS) safe(() => el.addEventListener(e, on, opts));
  return remove;
}
