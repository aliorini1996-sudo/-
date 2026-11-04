/**
 * التتبّع الخلفيّ في تطبيق فيلد سيلز على الجوال (طلب المالك، ٤ نوفمبر ٢٠٢٦): الصفحة لا تتتبّع في الخلفية (المتصفح يوقف
 * watchPosition حين يُقفل الجوال أو يُغادَر التطبيق)، فتسلّم المهمة للتطبيق نفسه — خدمةٌ أصلية بإشعارٍ ثابت على أندرويد، وتحديثات
 * موقع خلفية بالمؤشّر الأزرق على الآيفون — تُرسل النقاط مباشرةً إلى /api/track-device/ping برمزٍ قصير (20 ساعة) لا بجلسة المندوب.
 *
 *   أندرويد: intent://start?t=<الرمز>#Intent;scheme=fieldsatrack;package=net.fieldsa.twa;end   ·   intent://stop#Intent;…
 *   الآيفون: window.webkit.messageHandlers.fsTrack.postMessage({ action: 'start', token })   ·   { action: 'stop' }
 *
 * كل قيمةٍ هنا نظيرُها حرفياً في android-rep/app/src/main/java/net/fieldsa/twa/track/TrackContract.kt (يحرسه
 * nativeTracking.test.ts)، وفي تطبيق الآيفون FieldSales/TrackBridge.swift. تغيير قيمةٍ دون الأخرى يوقف التتبّع بصمت.
 *
 * علامة القدرة (fs_track_cap): يضيف LauncherActivity لرابط الإقلاع fstrack=1 حين يحمل التطبيق الخدمة (البناء بلا إذن الموقع لا
 * يضيفه)، فتحفظها الصفحة في sessionStorage وتحذف المعامل فوراً (captureTrackLaunch في main.tsx). الآيفون يُعرف بمعالجه وحده.
 *
 * يوم البدء (fs_track_day = «اليوم|المندوب»): مرّةً لكل يومٍ ومندوبٍ في التبويب — يومٌ جديد ⇒ رمزٌ جديد عند العودة للتطبيق،
 * ومندوبٌ آخر على الجهاز نفسه (ولو بعد خروجٍ قسريّ لا يمرّ بالإيقاف) يبدأ برمزه. والتطبيق يوقف نفسه عند الخروج ونهاية اليوم
 * وانتهاء الرمز وردّ الخادم stop (إيقاف الشركة للتتبّع) — فالإيقاف من هنا تأكيدٌ لا شرط.
 *
 * Chrome لا يفتح intent بلا إيماءةٍ حديثة، والبدء يقع عند الفتح بلا لمسة: فيظهر زرّ «اضغط لتشغيل تسجيل الموقع» ويُفتح الرابط داخل
 * لمسته وحدها — لا تُستعار لمسةٌ أخرى ولا إيماءةٌ قائمة، فلا يتقاسم البدء إيماءة الطباعة أو التحصيل بالبطاقة ولا يسبق رابطيهما.
 * ولمسة الزرّ نفسها تُعدّ تسليماً فيُعلَّم اليوم معها — لا يُرهن بإخفاء الصفحة (شاشة التطبيق قد لا تُخفيها، وإعادة الرابط تعني إفصاحاً
 * ثانياً وبدءاً مكرّراً). ومن رابط غريبٍ يحمي التطبيق نفسه: الموافقة مربوطةٌ بهوية الرمز (TrackActivity).
 *
 * لا يستورد repApi (متغيّرات بيئة Vite غائبة في node:test): المستدعي يمرّر دالة الطلب. ولا يرمي أبداً.
 */
import { browserAppEnv, launchIntent, type AppEnv } from '../lib/print/transport/appBridge';
import { BRIDGE_PACKAGE } from '../lib/print/transport/bridgeContract';
import { deviceDay } from './deviceDay';

// ─── العقد المشترك (TrackContract.kt وTrackBridge.swift) ───
/** مخطّط رابط التطبيق ومضيفاه */
export const TRACK_SCHEME = 'fieldsatrack';
export const TRACK_HOST_START = 'start';
export const TRACK_HOST_STOP = 'stop';
/** معامل الرمز في رابط البدء */
export const TRACK_PARAM_TOKEN = 't';
/** معامل تبديل عنوان الرفع — في بناء التطوير وحده على أندرويد؛ الصفحة لا ترسله أبداً */
export const TRACK_PARAM_DEBUG_URL = 'u';
/** معامل الإقلاع الذي يضيفه LauncherActivity: «التطبيق يحمل خدمة التتبّع» */
export const TRACK_LAUNCH_PARAM = 'fstrack';
export const TRACK_LAUNCH_VALUE = '1';
export const TRACK_PACKAGE = BRIDGE_PACKAGE;
/** معالج رسائل تطبيق الآيفون */
export const IOS_TRACK_HANDLER = 'fsTrack';
/** عنوان رفع التطبيقين (مطلق) — للحارس وحده؛ الصفحة لا ترفع إليه */
export const TRACK_PING_URL = 'https://api.fieldsa.net/api/track-device/ping';
/** طلب الرمز بجلسة المندوب (عبر repApi، فالمسار نسبيّ لـ/api) */
export const TRACK_TOKEN_PATH = '/tracking/device-token';
/** أقصى طول للرمز — نظير حدّ TrackActivity */
export const TRACK_TOKEN_MAX_CHARS = 4096;

const CAP_KEY = 'fs_track_cap';
const DAY_KEY = 'fs_track_day';
/** localStorage: أُرسل «ابدأ» من هذا الجهاز ولم يُرسل «توقّف» بعده — بها وحدها يُرسل الإيقاف الهادئ (ifStarted) على أندرويد */
const SENT_KEY = 'fs_track_native';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface FsTrackHandler { postMessage(msg: unknown): unknown }

/** طلب الرمز — repApi.post بلا تغيير (useRepTracking.ts يمرّره) */
export type TrackTokenPost = (url: string, body: Record<string, never>, config: { background: true }) => Promise<{ data?: unknown } | null | undefined>;

export interface NativeTrackEnv {
  /** sessionStorage — علامة القدرة ويوم البدء بعمر التبويب */
  session: Store;
  /** localStorage — «أُرسل بدءٌ ولم يُرسل إيقاف» */
  local: Store;
  /** معالج fsTrack في تطبيق الآيفون إن وُجد */
  ios: () => FsTrackHandler | null;
  /** فتح روابط intent بأسلوب جسر الطباعة نفسه (الإطار الأعلى، أو إطارٌ مخفيّ في WebView) */
  app: AppEnv;
  now: () => Date;
  /** يعرض زرّ «اضغط لتشغيل تسجيل الموقع» ويستدعي f عند لمسه (مرّةً واحدة، والإيماءة حيّة) ويعيد مُزيله */
  askTap: (f: () => void) => () => void;
  /** جلسة المندوب الحالية (rep_token) — إيقاف الخروج يُقفل البدء عليها حتى تتبدّل */
  sessionKey: () => string | null;
  /** معرّف المندوب صاحب الجلسة (rep_user.id) — يوم البدء له وحده، فيتغيّر الرمز بتغيّر المندوب لا بتجديد الجلسة */
  repId: () => string | null;
}

function getItem(s: Store, k: string): string | null {
  try { return s?.getItem(k) ?? null; } catch { return null; }
}
function setItem(s: Store, k: string, v: string): void {
  try { s?.setItem(k, v); } catch { /* تخزينٌ محجوب: يُعاد البدء عند العودة — بلا ضرر */ }
}
function removeItem(s: Store, k: string): void {
  try { s?.removeItem(k); } catch { /* */ }
}

/** معالج fsTrack بدالة postMessage — معالجات تطبيقاتٍ أخرى (messageHandlers عامّة) لا تكفي */
function iosHandlerOf(w: unknown): FsTrackHandler | null {
  try {
    const hs = (w as { webkit?: { messageHandlers?: Obj } } | undefined)?.webkit?.messageHandlers;
    const h = hs ? hs[IOS_TRACK_HANDLER] : undefined;
    return isObj(h) && typeof h.postMessage === 'function' ? (h as unknown as FsTrackHandler) : null;
  } catch { return null; }
}

/** نصّ زرّ البدء بلغة الواجهة (documentElement.lang يضبطه i18n/lang.ts) — العربية افتراضاً */
const START_LABEL: Record<string, string> = {
  ar: 'اضغط لتشغيل تسجيل الموقع',
  en: 'Tap to start location recording',
  fr: 'Touchez pour activer l’enregistrement de la position',
  tr: 'Konum kaydını başlatmak için dokunun',
  zh: '点按开始记录位置',
};
const PIN_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>'
  + '<circle cx="12" cy="10" r="3"/></svg>';
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * زرّ البدء العائم (أندرويد وحده): لمسةٌ مخصّصة يُفتح فيها رابط البدء — فوق أشرطة الإجراءات السفلية وتحت النوافذ (z-50). لمسته
 * لا تصل للصفحة تحته، ويُزال قبل onTap. يعيد مُزيله.
 */
export function showStartChip(doc: Pick<Document, 'createElement' | 'body' | 'documentElement'>, onTap: () => void): () => void {
  const lang = String(doc.documentElement?.lang || 'ar').slice(0, 2).toLowerCase();
  const b = doc.createElement('button');
  b.type = 'button';
  b.setAttribute('data-fs-track-start', '');
  b.dir = lang === 'ar' ? 'rtl' : 'ltr';
  b.innerHTML = `${PIN_SVG}<span>${escapeHtml(START_LABEL[lang] ?? START_LABEL.ar)}</span>`;
  b.style.cssText = [
    'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:calc(env(safe-area-inset-bottom, 0px) + 88px)', 'z-index:45',
    'display:inline-flex', 'align-items:center', 'gap:8px', 'max-width:calc(100vw - 32px)', 'padding:10px 18px', 'border:0',
    'border-radius:999px', 'background:#E15A30', 'color:#fff', 'font:inherit', 'font-size:14px', 'font-weight:600', 'line-height:1.3',
    'box-shadow:0 6px 18px rgba(31,26,19,.28)', 'cursor:pointer', '-webkit-tap-highlight-color:transparent',
  ].join(';');
  let gone = false;
  const remove = () => { gone = true; try { b.remove(); } catch { /* */ } };
  b.addEventListener('click', (e) => {
    try { e.stopPropagation(); e.preventDefault(); } catch { /* */ }
    if (gone) return;
    remove();
    onTap();
  });
  doc.body.appendChild(b);
  return remove;
}

/** بيئة الصفحة الحقيقية — تُقرأ عند الاستدعاء لا عند التحميل؛ وخارج المتصفح null */
export function browserTrackEnv(): NativeTrackEnv | null {
  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return null;
    const storage = (get: () => Storage): Store => { try { return get(); } catch { return null; } };
    return {
      session: storage(() => window.sessionStorage),
      local: storage(() => window.localStorage),
      ios: () => iosHandlerOf(window),
      app: browserAppEnv(),
      now: () => new Date(),
      sessionKey: () => { try { return window.localStorage.getItem('rep_token'); } catch { return null; } },
      repId: () => {
        try {
          const id = (JSON.parse(window.localStorage.getItem('rep_user') || 'null') as { id?: unknown } | null)?.id;
          return (typeof id === 'string' && id) || typeof id === 'number' ? String(id) : null;
        } catch { return null; }
      },
      askTap: (f) => showStartChip(document, f),
    };
  } catch { return null; }
}

/** اسم معاملٍ من «اسم=قيمة» كما يفكّه URLSearchParams */
function paramName(part: string): string {
  const eq = part.indexOf('=');
  const name = (eq < 0 ? part : part.slice(0, eq)).split('+').join(' ');
  try { return decodeURIComponent(name); } catch { return name; }
}

/**
 * يُستدعى قبل أوّل رسمٍ لـReact (بعد markAppLaunch وقبل captureBridgeLaunch): fstrack=1 ⇒ علامة القدرة في sessionStorage، ويُحذف
 * المعامل دائماً بـhistory.replaceState — فيبقى history.state وبقية المعاملات (fsbridge وcardpay) بحروفها والمرساة. لا يرمي أبداً
 * ولا يعيد تحميل الصفحة.
 */
export function captureTrackLaunch(env?: {
  location: Pick<Location, 'search' | 'pathname' | 'hash'>;
  history: Pick<History, 'state' | 'replaceState'>;
  storage: Store;
}): void {
  try {
    const e = env ?? (typeof window === 'undefined' ? null : {
      location: window.location, history: window.history, storage: (() => { try { return window.sessionStorage; } catch { return null; } })(),
    });
    if (!e) return;
    const search = e.location.search.startsWith('?') ? e.location.search.slice(1) : e.location.search;
    const parts = search.split('&').filter((s) => s.length > 0);
    if (!parts.some((s) => paramName(s) === TRACK_LAUNCH_PARAM)) return;
    if (new URLSearchParams(search).get(TRACK_LAUNCH_PARAM) === TRACK_LAUNCH_VALUE) setItem(e.storage, CAP_KEY, 'android');
    const q = parts.filter((s) => paramName(s) !== TRACK_LAUNCH_PARAM).join('&');
    e.history.replaceState(e.history.state, '', e.location.pathname + (q ? '?' + q : '') + e.location.hash);
  } catch { /* لا شيء يمنع الإقلاع */ }
}

/** أين تعمل الصفحة: تطبيق الآيفون (معالجه — قاطعٌ فيُقدَّم)، أو تطبيق أندرويد (علامة القدرة)، أو لا تطبيق */
export function nativeTrackPlatform(env: Pick<NativeTrackEnv, 'session' | 'ios'> | null = browserTrackEnv()): 'android' | 'ios' | null {
  try {
    if (!env) return null;
    if (env.ios()) return 'ios';
    return getItem(env.session, CAP_KEY) === 'android' ? 'android' : null;
  } catch { return null; }
}

/** رمزٌ بشكل JWT: ثلاثة أجزاء base64url وطولٌ محدود — والتطبيق يتحقّق ثانيةً */
export function isTrackToken(t: unknown): t is string {
  return typeof t === 'string' && t.length <= TRACK_TOKEN_MAX_CHARS && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t);
}

/** رابط intent للتطبيق — بلا رابطٍ بديل أبداً، ومع package دائماً (كجسر الطباعة) */
export function trackIntentUrl(host: typeof TRACK_HOST_START | typeof TRACK_HOST_STOP, token?: string): string {
  const q = token !== undefined ? `?${TRACK_PARAM_TOKEN}=${encodeURIComponent(token)}` : '';
  return `intent://${host}${q}#Intent;scheme=${TRACK_SCHEME};package=${TRACK_PACKAGE};end`;
}

/** ردّ /tracking/device-token: { success, data: { enabled:false } | { enabled:true, token, expiresAt } } — وغيره null */
export function trackTokenReplyOf(body: unknown): { enabled: false } | { enabled: true; token: string } | null {
  const d = isObj(body) && isObj(body.data) ? body.data : null;
  if (!d) return null;
  if (d.enabled === false) return { enabled: false };
  if (d.enabled === true && isTrackToken(d.token)) return { enabled: true, token: d.token };
  return null;
}

/** علامة يوم البدء: اليوم ومندوبه — مندوبٌ آخر (أو يومٌ آخر) ⇒ «لم يبدأ» */
function dayMark(day: string, rep: string | null): string {
  return `${day}|${rep ?? ''}`;
}

/**
 * حالة الصفحة في الذاكرة: جيل الإيقاف (بدءٌ قديم لا يكمل بعد إيقاف)، والطلب الجاري، والزرّ المعروض (لعلامة يومٍ ومندوب)،
 * والجلسة التي أوقفها الخروج: بين «توقّف» ومسح الجلسة ثوانٍ (إنهاء الزيارة وإلغاء التنبيهات) تعود فيها الصفحة من شاشة التطبيق —
 * والعودة تبدأ التتبّع (useRepTracking) فيُعاد تشغيله لمن يخرج. فلا بدء على تلك الجلسة؛ ودخولٌ جديد (جلسةٌ أخرى) يفكّ القفل.
 */
interface TrackState {
  gen: number;
  busy: string | null;
  pending: { mark: string; cancel: () => void } | null;
  halted: { session: string | null } | null;
}
const states = new WeakMap<object, TrackState>();
function stateOf(env: NativeTrackEnv): TrackState {
  const k = env.app.win as object;
  let st = states.get(k);
  if (!st) { st = { gen: 0, busy: null, pending: null, halted: null }; states.set(k, st); }
  return st;
}

function markStarted(env: NativeTrackEnv, mark: string): void {
  setItem(env.session, DAY_KEY, mark);
  setItem(env.local, SENT_KEY, '1');
}

/**
 * أندرويد: زرّ البدء ينتظر لمسة المندوب، ورابط البدء يُفتح داخلها — ويُعلَّم اليوم معها (الشاشة الشفّافة لا تُخفي الصفحة فلا يُنتظر
 * إخفاؤها). لمسةٌ بعد منتصف الليل أو بعد تبدّل المندوب تطلب رمزاً جديداً (restart) لا تفتح رابطاً قديماً.
 */
function androidStart(token: string, env: NativeTrackEnv, st: TrackState, mark: string, gen: number, restart: () => void): void {
  let remove: (() => void) | null = null;
  const pending = {
    mark,
    cancel: () => {
      if (remove) { const r = remove; remove = null; try { r(); } catch { /* */ } }
      if (st.pending === pending) st.pending = null;
    },
  };
  st.pending = pending;
  try {
    const r = env.askTap(() => {
      remove = null;
      if (st.gen !== gen || st.pending !== pending) return;
      st.pending = null;
      if (dayMark(deviceDay(env.now()), env.repId()) !== mark) { restart(); return; }
      markStarted(env, mark);
      void launchIntent(trackIntentUrl(TRACK_HOST_START, token), env.app);
    });
    if (st.pending === pending) remove = r;
  } catch {
    // تعذّر عرض الزرّ: لا انتظار معلّق — العودة التالية للتطبيق تحاول
    if (st.pending === pending) st.pending = null;
  }
}

/**
 * يبدأ التتبّع الخلفي في التطبيق — مرّةً لكل يومٍ ومندوبٍ في التبويب. بلا تطبيق: لا شيء. يطلب الرمز بجلسة المندوب (طلبٌ خلفيّ لا
 * يُخرج عند 401 عابر)؛ الخادم يقول «لا تتبّع» (الشركة أطفأته أو المندوب مستثنى) ⇒ إيقافٌ هادئ. لا يرمي أبداً.
 */
export async function startNativeTracking(post: TrackTokenPost, env: NativeTrackEnv | null = browserTrackEnv()): Promise<void> {
  try {
    if (!env) return;
    const platform = nativeTrackPlatform(env);
    if (!platform) return;
    const session = env.sessionKey();
    if (!session) return; // بلا جلسة لا رمز
    const mark = dayMark(deviceDay(env.now()), env.repId());
    if (getItem(env.session, DAY_KEY) === mark) return;
    const st = stateOf(env);
    if (st.halted) {
      if (session === st.halted.session) return; // الخروج جارٍ: لا يُعاد التشغيل لمن يخرج
      st.halted = null;
    }
    if (st.busy === mark) return;
    if (st.pending) {
      if (st.pending.mark === mark) return; // الزرّ معروضٌ ينتظر لمسة المندوب
      st.pending.cancel(); // يومٌ مضى أو مندوبٌ آخر: زرّه ورمزه لا يصلحان
    }
    st.busy = mark;
    const gen = st.gen;
    let reply: ReturnType<typeof trackTokenReplyOf> = null;
    try { reply = trackTokenReplyOf((await post(TRACK_TOKEN_PATH, {}, { background: true }))?.data); } catch { reply = null; }
    // أُوقف أثناء الطلب (خروج المندوب): رمزه لا يُسلَّم — والإيقاف حرّر القفل لمن دخل بعده
    if (st.gen !== gen) return;
    st.busy = null;
    if (!reply) return; // شبكةٌ أو ردٌّ غير متوقَّع: العودة التالية للتطبيق تحاول
    if (!reply.enabled) { stopNativeTracking(env, { ifStarted: true }); return; }
    if (platform === 'ios') {
      const h = env.ios();
      if (!h) return;
      h.postMessage({ action: 'start', token: reply.token });
      markStarted(env, mark);
      return;
    }
    androidStart(reply.token, env, st, mark, gen, () => { void startNativeTracking(post, env); });
  } catch { /* التتبّع الخلفي لا يكسر التطبيق */ }
}

/**
 * يوقف التتبّع الخلفي في التطبيق ويمسح يوم البدء — حيث يوجد تطبيقٌ وحده. ifStarted (حكم «لا تتبّع» بلا لمسة): على أندرويد لا يُفتح
 * الرابط إلا إن أرسل هذا الجهاز «ابدأ» بعد آخر إيقاف — فلا تومض شاشة التطبيق عند كل فتحٍ لشركةٍ لا تتتبّع (والتطبيق يوقف نفسه بردّ
 * الخادم stop على أيّ حال). والخروج يوقف دائماً، ويُقفل البدء على جلسته حتى دخولٍ جديد. لا يرمي أبداً.
 */
export function stopNativeTracking(env: NativeTrackEnv | null = browserTrackEnv(), opts: { ifStarted?: boolean } = {}): void {
  try {
    if (!env) return;
    const platform = nativeTrackPlatform(env);
    if (!platform) return;
    const st = stateOf(env);
    st.gen += 1;
    st.busy = null;
    st.pending?.cancel();
    st.pending = null;
    if (!opts.ifStarted) st.halted = { session: env.sessionKey() };
    removeItem(env.session, DAY_KEY);
    const sent = getItem(env.local, SENT_KEY) === '1';
    removeItem(env.local, SENT_KEY);
    if (platform === 'ios') {
      env.ios()?.postMessage({ action: 'stop' });
      return;
    }
    if (opts.ifStarted && !sent) return;
    void launchIntent(trackIntentUrl(TRACK_HOST_STOP), env.app);
  } catch { /* */ }
}
