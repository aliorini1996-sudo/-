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
 * ولا تُصدَّق العلامة طوال اليوم: قتل النظام لعملية التطبيق يُنهي الخدمة بلا رجعة والعلامة باقية (المحاكي، ٤ نوفمبر)، فعند الفتح أو
 * العودة يُسأل الخادم ثانيةً «رُئي يرفع مؤخّراً؟» (nativeRecent، ٥ دقائق) — بحدّ VERIFY_EVERY_MS وبعد VERIFY_GRACE_MS من البدء.
 * ولا ⇒ يُسلَّح البدء كأوّل مرة، بشرط أن تكون رُئيت ترفع بعد آخر تسليم (fs_track_seen): «لا ترفع» بلا ذلك قد تعني أنها لم تبدأ قط
 * (رفض الإفصاح أو الإذن، أو الموقع مطفأ) فيعود الطلب كل ٣ دقائق — والإفصاح على الآيفون نافذةٌ تقطع الشاشة (مراجعة ٥ نوفمبر).
 * فخدمةٌ لم تُرَ: تسليحٌ واحد في اليوم على أندرويد (fs_track_rearm)، ولا شيء على الآيفون، ثم لا سؤال حتى تسليمٍ جديد. وزرٌّ سلّحه
 * التحقّق يُسأل عنه في العودات التالية (بالحدّ نفسه): «ترفع» ⇒ يُزال وتعود العلامة (فجوة رفعٍ عادية لا تُبقي زرّاً طوال اليوم).
 *
 * Chrome لا يفتح intent بلا إيماءةٍ حديثة، والبدء يقع عند الفتح بلا لمسة. فالبدء ينتظر لمسةً مخصّصة يُفتح الرابط داخلها وحدها:
 *   - شركةٌ تستعمل «بصمة الحضور» والمندوب لم يبصم بعد (waitPunch من الخادم): لمسة «تسجيل الحضور» نفسها (قرار المالك ٤ نوفمبر) —
 *     startNativeTrackingOnPunch تفتح الرابط في أوّل اللمسة، والبصمة تُكمل بعد العودة من شاشة التطبيق (فلا تُقرأ قراءتها والصفحة
 *     مخفيّة). وعلى الآيفون كذلك: البدء مع الحضور ليتّفق الجوالان.
 *   - وإلا على أندرويد: زرّ «اضغط لتشغيل تسجيل الموقع» (والآيفون يبدأ فوراً بلا لمسة).
 *   - لمسة الحضور والرمز في الطريق (الإقلاع من تذكير الحضور: زرّ الحضور يظهر قبل الرمز): تنتظر ردّه حتى PUNCH_TOKEN_WAIT_MS ثم
 *     تفتح الرابط داخلها — بعده (أو إيماءةٌ انقضت) فالزرّ.
 * لا تُستعار لمسةٌ أخرى ولا إيماءةٌ قائمة، فلا يتقاسم البدء إيماءة الطباعة أو التحصيل بالبطاقة ولا يسبق رابطيهما. وجهازٌ يرفع الآن
 * (nativeActive) وبدأه هذا الجهاز ولم يوقفه لا يُطلب له بدءٌ ثانٍ — أمّا بعد إيقافه (خروجٌ ثم دخولٌ سريع) فقد يكون «يرفع الآن» آخرَ
 * دفعةٍ من خدمةٍ ماتت، فيُسلَّح البدء كالعادة.
 * واللمسة نفسها تُعدّ تسليماً فيُعلَّم اليوم معها — لا يُرهن بإخفاء الصفحة (شاشة التطبيق قد لا تُخفيها، وإعادة الرابط تعني إفصاحاً
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
/** sessionStorage بجوار يوم البدء: لحظة التسليم (ملّي ثانية) — منها تُعدّ مهلة التحقّق VERIFY_GRACE_MS */
const AT_KEY = 'fs_track_at';
/**
 * sessionStorage = علامة اليوم: ردٌّ قال إن الخدمة ترفع بعد آخر تسليم. بها وحدها يُقرأ «لا ترفع» موتاً (قتلها النظام) فيُعاد التسليح
 * كل مرة؛ وبدونها قد تكون لم تبدأ قط (رفض المندوب الإفصاح أو الإذن، أو الموقع مطفأ) وإعادة الطلب تعيد الرفض نفسه. يمسحها كل تسليم
 */
const SEEN_KEY = 'fs_track_seen';
/** sessionStorage = علامة اليوم: أُنفق التسليح الوحيد في اليوم لخدمةٍ لم تُرَ ترفع (أندرويد) — لا يمسحه التسليم */
const REARM_KEY = 'fs_track_rearm';
/** sessionStorage = علامة اليوم: لا سؤال تحقّقٍ حتى تسليمٍ جديد — خدمةٌ لم تُرَ ترفع ولا تسليح لها. يمسحه كل تسليم */
const QUIET_KEY = 'fs_track_quiet';
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

export type TrackTokenReply =
  | { enabled: false }
  | { enabled: true; token: string; waitPunch: boolean; nativeActive: boolean; nativeRecent: boolean };

/**
 * ردّ /tracking/device-token: { success, data: { enabled:false } | { enabled:true, token, expiresAt, waitPunch?, nativeActive?,
 * nativeRecent? } } — وغيره null. waitPunch: البدء ينتظر لمسة «تسجيل الحضور». nativeActive: الجهاز يرفع الآن (٩٠ث — حكم البدء).
 * nativeRecent: رُئي يرفع خلال ٥ دقائق (سؤال التحقّق وحده: أوسع من أسوأ فجوةٍ عادية لجهازٍ سليم). خادمٌ أقدم بلاها ⇒ false،
 * و«يرفع الآن» يعني «رُئي مؤخّراً» دائماً
 */
export function trackTokenReplyOf(body: unknown): TrackTokenReply | null {
  const d = isObj(body) && isObj(body.data) ? body.data : null;
  if (!d) return null;
  if (d.enabled === false) return { enabled: false };
  if (d.enabled === true && isTrackToken(d.token)) {
    const nativeActive = d.nativeActive === true;
    return { enabled: true, token: d.token, waitPunch: d.waitPunch === true, nativeActive, nativeRecent: nativeActive || d.nativeRecent === true };
  }
  return null;
}

/** أقصى انتظار البصمة لعودة الصفحة من شاشة التطبيق (الإفصاح أول مرة يُقرأ) — بعده تُكمل البصمة على أيّ حال */
export const PUNCH_RETURN_MAX_MS = 60_000;

/**
 * أقصى انتظار لمسة الحضور لرمزٍ في الطريق قبل أن تفتح الرابط داخلها (أندرويد): دون صلاحية إيماءة Chrome (~٥ث) ودون مهلة إيماءة
 * جسر الطباعة (LAUNCH_GESTURE_MS = ٣ث) فتبقى اللمسة حيّة عند الفتح، وتأخيرٌ يحتمله الحضور. بعده يعرض الردّ الزرّ كما كان
 */
export const PUNCH_TOKEN_WAIT_MS = 2_500;

/**
 * التحقّق من بدءٍ معلَّم (اختبار المحاكي، ٤ نوفمبر): النظام يقتل عملية التطبيق فتموت TrackService معها (START_NOT_STICKY عن قصد —
 * أندرويد ١٤ لا يعيد خدمة موقعٍ مقدّمة من الخلفية)، وعلامة اليوم باقية في التبويب فلا يُطلب بدءٌ حتى الغد. فالفتح أو العودة للتطبيق
 * يعيد طلب الرمز، و«مفعّل ولم يُرَ الجهاز يرفع خلال ٥ دقائق» (nativeRecent) ⇒ يُسلَّح البدء كأوّل مرة — إن رُئي يرفع بعد التسليم،
 * وإلا مرّةً في اليوم على أندرويد وحده (requestStart).
 * سؤالٌ واحد لكل صفحة كل VERIFY_EVERY_MS على الأكثر — العودة للتطبيق تتكرّر عشرات المرات في الساعة، وكل سؤالٍ يصدر رمزاً. والحدّ
 * نفسه للسؤال عن زرٍّ سلّحه التحقّق ولم يُلمس.
 */
export const VERIFY_EVERY_MS = 180_000;
/**
 * ولا سؤال قبل VERIFY_GRACE_MS من التسليم: الإفصاح والإذن وأوّل قراءةٍ وأوّل رفعٍ (كل ٣٠ث) تسبق أوّل نقطةٍ يراها الخادم، فسؤالٌ
 * أبكر يرى خدمةً سليمة «لا ترفع» ويُظهر زرّاً لا يلزم
 */
export const VERIFY_GRACE_MS = 120_000;

/** علامة يوم البدء: اليوم ومندوبه — مندوبٌ آخر (أو يومٌ آخر) ⇒ «لم يبدأ» */
function dayMark(day: string, rep: string | null): string {
  return `${day}|${rep ?? ''}`;
}

/**
 * حالة الصفحة في الذاكرة: جيل الإيقاف (بدءٌ قديم لا يكمل بعد إيقاف)، والطلب الجاري، والزرّ المعروض (لعلامة يومٍ ومندوب)،
 * والجلسة التي أوقفها الخروج: بين «توقّف» ومسح الجلسة ثوانٍ (إنهاء الزيارة وإلغاء التنبيهات) تعود فيها الصفحة من شاشة التطبيق —
 * والعودة تبدأ التتبّع (useRepTracking) فيُعاد تشغيله لمن يخرج. فلا بدء على تلك الجلسة؛ ودخولٌ جديد (جلسةٌ أخرى) يفكّ القفل.
 */
/**
 * بدءٌ سلّحه سؤال التحقّق (الخادم لم يرَ الخدمة ترفع): لحظة التسليم السابقة (fs_track_at كما كانت، أو null) لتعود مع العلامة إن
 * رآها سؤالٌ لاحق ترفع — فجوة رفعٍ عادية (انقطاع تغطية، أو تراجعٌ بعد 503) لا تُبقي زرّاً كاذباً طوال اليوم
 */
interface Rearm { at: string | null }
/** بدءٌ مُسلَّحٌ ينتظر لمسته: رمزه ويومه، و«أعد الطلب» إن تبدّل اليوم أو المندوب قبل اللمسة، ومُزيل زرّه إن عُرض */
interface Pending {
  mark: string;
  token: string;
  /** بزرّه (أندرويد) — وبلا زرّ ينتظر لمسة الحضور؛ فإن مضى الحضور وانقضت إيماءته صار زرّاً */
  chip: boolean;
  /** سلّحه التحقّق لا البدء الأوّل: يُسأل عنه ثانيةً في العودات التالية (recheckPending) */
  rearm: Rearm | null;
  restart: () => void;
  cancel: () => void;
}
interface TrackState {
  gen: number;
  /** علامة اليوم التي يُطلب رمزها الآن */
  busy: string | null;
  /** الطلب الجاري ومعالجة ردّه (مع busy): لمسة حضورٍ تسبق الرمز تنتظره لتفتح الرابط داخلها — يستقرّ دائماً ولا يُرفض */
  flight: Promise<void> | null;
  pending: Pending | null;
  halted: { session: string | null } | null;
  /** لمسة حضورٍ وقعت ولا بدء مسلَّحاً (الرمز لم يصل بعد): ردٌّ يقول waitPunch بعدها يعرض الزرّ — الحضور مضى */
  punchTap: string | null;
  /** لحظة آخر سؤال تحقّقٍ أُرسل من هذه الصفحة (VERIFY_EVERY_MS) — في الذاكرة: صفحةٌ جديدة تسأل في أوّل فتح */
  verifiedAt: number | null;
}
const states = new WeakMap<object, TrackState>();
function stateOf(env: NativeTrackEnv): TrackState {
  const k = env.app.win as object;
  let st = states.get(k);
  if (!st) { st = { gen: 0, busy: null, flight: null, pending: null, halted: null, punchTap: null, verifiedAt: null }; states.set(k, st); }
  return st;
}

/** ساعة الصفحة بالملّي ثانية — NaN إن تعذّرت (فلا تحقّق ولا مهلة تُحسب منها) */
function nowMs(env: NativeTrackEnv): number {
  try { return env.now().getTime(); } catch { return NaN; }
}

/**
 * تسليمٌ للتطبيق (أو جهازٌ يرفع بدأه هذا الجهاز): العلامة ولحظتها و«أُرسل بدءٌ». ورؤية الخدمة ترفع تُعدّ من جديد بعد كل تسليم —
 * seen: الردّ نفسه رآها ترفع — ويُرفع «لا سؤال» (QUIET_KEY): تسليمٌ جديد يستحقّ تحقّقه
 */
function markStarted(env: NativeTrackEnv, mark: string, seen = false): void {
  setItem(env.session, DAY_KEY, mark);
  setItem(env.session, AT_KEY, String(nowMs(env)));
  setItem(env.local, SENT_KEY, '1');
  removeItem(env.session, QUIET_KEY);
  if (seen) setItem(env.session, SEEN_KEY, mark);
  else removeItem(env.session, SEEN_KEY);
}

/** at خلال ms قبل now — لحظةٌ فاسدة أو في المستقبل (ساعةٌ رجعت) ليست حديثة */
function recentMs(now: number, at: number, ms: number): boolean {
  return Number.isFinite(at) && now >= at && now - at < ms;
}

/** سؤال تحقّقٍ من هذه الصفحة أحدث من VERIFY_EVERY_MS — أو ساعةٌ متعذّرة (فلا سؤال يُحسب حدّه منها) */
function verifyThrottled(st: TrackState, now: number): boolean {
  if (!Number.isFinite(now)) return true;
  return st.verifiedAt !== null && recentMs(now, st.verifiedAt, VERIFY_EVERY_MS);
}

/**
 * علامة اليوم قائمة: هل يُسأل الخادم الآن إن كانت الخدمة ما زالت ترفع؟ — بدءٌ من هذا الجهاز لم يُوقَف (SENT_KEY؛ بدونه لا خدمة
 * يُتحقَّق منها)، ولم يُكفّ عن السؤال لهذا التسليم (QUIET_KEY: خدمةٌ لم تُرَ ترفع ولا تسليح لها)، ومضى VERIFY_EVERY_MS على آخر
 * سؤالٍ من هذه الصفحة، وVERIFY_GRACE_MS على التسليم. لحظةٌ غائبة أو فاسدة أو في المستقبل لا تمنع السؤال — وإلا علِق يومٌ كاملٌ
 * بلا تحقّق.
 */
function verifyDue(env: NativeTrackEnv, st: TrackState, now: number, mark: string): boolean {
  if (getItem(env.local, SENT_KEY) !== '1' || getItem(env.session, QUIET_KEY) === mark) return false;
  if (verifyThrottled(st, now)) return false;
  const raw = getItem(env.session, AT_KEY);
  return !(raw !== null && /^\d+$/.test(raw) && recentMs(now, Number(raw), VERIFY_GRACE_MS));
}

/** حتى تعود الصفحة ظاهرةً (من شاشة التطبيق) أو تمضي maxMs */
function untilVisible(app: AppEnv, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (app.doc.visibilityState === 'visible') { resolve(); return; }
    let timer: unknown = null;
    const done = () => {
      app.doc.removeEventListener('visibilitychange', onVis);
      if (timer !== null) app.clearTimeout(timer);
      resolve();
    };
    const onVis = () => { if (app.doc.visibilityState === 'visible') done(); };
    app.doc.addEventListener('visibilitychange', onVis);
    timer = app.setTimeout(done, maxMs);
  });
}

/**
 * تسليم البدء للتطبيق داخل لمسةٍ حيّة — يُعلَّم اليوم معها (شاشة التطبيق قد لا تُخفي الصفحة، وإعادة الرابط تعني إفصاحاً ثانياً).
 * أندرويد: الرابط يُفتح متزامناً قبل أيّ انتظار، ويُوعد بعودة الصفحة إن أُخفيت. الآيفون: رسالة المعالج.
 */
function deliver(env: NativeTrackEnv, platform: 'android' | 'ios', token: string, mark: string): Promise<void> {
  if (platform === 'ios') {
    const h = env.ios();
    if (!h) return Promise.resolve();
    h.postMessage({ action: 'start', token });
    markStarted(env, mark);
    return Promise.resolve();
  }
  markStarted(env, mark);
  return launchIntent(trackIntentUrl(TRACK_HOST_START, token), env.app)
    .then((r) => (r === 'handed' ? untilVisible(env.app, PUNCH_RETURN_MAX_MS) : undefined))
    .catch(() => undefined);
}

/**
 * يسلّح البدء لينتظر لمسته: زرّ «اضغط لتشغيل تسجيل الموقع» (chip، أندرويد وحده) أو لمسة «تسجيل الحضور»
 * (startNativeTrackingOnPunch). لمسةٌ بعد منتصف الليل أو بعد تبدّل المندوب تطلب رمزاً جديداً (restart) لا تفتح رابطاً قديماً.
 * rearm: سلّحه سؤال التحقّق — فيبقى يُسأل عنه حتى لمسته (recheckPending).
 */
function arm(
  token: string, env: NativeTrackEnv, st: TrackState, mark: string, gen: number, restart: () => void, chip: boolean, rearm: Rearm | null = null,
): void {
  let remove: (() => void) | null = null;
  const pending: Pending = {
    mark,
    token,
    chip,
    rearm,
    restart,
    cancel: () => {
      if (remove) { const r = remove; remove = null; try { r(); } catch { /* */ } }
      if (st.pending === pending) st.pending = null;
    },
  };
  st.pending = pending;
  if (!chip) return;
  try {
    const r = env.askTap(() => {
      remove = null;
      if (st.gen !== gen || st.pending !== pending) return;
      st.pending = null;
      if (dayMark(deviceDay(env.now()), env.repId()) !== mark) { restart(); return; }
      void deliver(env, 'android', token, mark);
    });
    if (st.pending === pending) remove = r;
  } catch {
    // تعذّر عرض الزرّ: لا انتظار معلّق — العودة التالية للتطبيق تحاول
    if (st.pending === pending) st.pending = null;
  }
}

/**
 * يبدأ التتبّع الخلفي في التطبيق — مرّةً لكل يومٍ ومندوبٍ في التبويب، ثم تحقّقٌ متباعد من أن الخدمة ما زالت ترفع (verifyDue). بلا
 * تطبيق: لا شيء. يطلب الرمز بجلسة المندوب (طلبٌ خلفيّ لا يُخرج عند 401 عابر)؛ الخادم يقول «لا تتبّع» (الشركة أطفأته أو المندوب
 * مستثنى) ⇒ إيقافٌ هادئ. لا يرمي أبداً.
 */
export async function startNativeTracking(post: TrackTokenPost, env: NativeTrackEnv | null = browserTrackEnv()): Promise<void> {
  try {
    if (!env) return;
    const platform = nativeTrackPlatform(env);
    if (!platform) return;
    const session = env.sessionKey();
    if (!session) return; // بلا جلسة لا رمز
    const mark = dayMark(deviceDay(env.now()), env.repId());
    const st = stateOf(env);
    const now = nowMs(env);
    // بدأ اليوم: لا طلب — إلا سؤال التحقّق حين يحين (خدمةٌ قتلها النظام لا تُعرف إلا من الخادم)
    const verify = getItem(env.session, DAY_KEY) === mark;
    if (verify && !verifyDue(env, st, now, mark)) return;
    if (st.halted) {
      if (session === st.halted.session) return; // الخروج جارٍ: لا يُعاد التشغيل لمن يخرج
      st.halted = null;
    }
    if (st.busy === mark) return;
    let mode: StartMode = verify ? 'verify' : 'start';
    if (st.pending) {
      if (st.pending.mark === mark) {
        // الزرّ معروضٌ ينتظر لمسة المندوب — إلا ما سلّحه التحقّق: يُسأل عنه ثانيةً بالحدّ نفسه، فإن رُئيت الخدمة ترفع أُزيل
        if (!st.pending.rearm || verifyThrottled(st, now)) return;
        mode = 'recheck';
      } else {
        st.pending.cancel(); // يومٌ مضى أو مندوبٌ آخر: زرّه ورمزه لا يصلحان
      }
    }
    if (mode !== 'start') st.verifiedAt = now;
    st.busy = mark;
    // الطلب ومعالجة ردّه وعدٌ واحد تنتظره لمسة حضورٍ سبقت الرمز (startNativeTrackingOnPunch) — والتحقّق كذلك: خدمةٌ ميتة تُسلَّح
    // في ردّه فتُسلَّم داخل لمسة الحضور إن وقعت أثناءه
    const run = requestStart(post, env, st, platform, mark, st.gen, mode);
    st.flight = run;
    await run;
    if (st.flight === run) st.flight = null;
  } catch { /* التتبّع الخلفي لا يكسر التطبيق */ }
}

/**
 * ما يُطلب الرمز له: بدءٌ أوّل (لا علامة لليوم)، أو سؤال تحقّق (العلامة قائمة: أما زالت الخدمة ترفع؟)، أو سؤالٌ عن زرٍّ سلّحه
 * التحقّق ولم يُلمس (لعلّها ترفع، فيُزال)
 */
type StartMode = 'start' | 'verify' | 'recheck';

/**
 * طلب الرمز ثم تسليمه أو تسليحه — يستقرّ دائماً ولا يرمي. verify: «رُئيت ترفع» ⇒ لا شيء (وتُذكر الرؤية)؛ وإلا إن رُئيت بعد آخر
 * تسليم تُمسح العلامة ويُكمل كبدءٍ أوّل (الزرّ، أو انتظار لمسة الحضور، أو رسالة الآيفون فوراً) — ولم تُرَ قط: مرّةً في اليوم على
 * أندرويد، ثم لا سؤال حتى تسليمٍ جديد. recheck: recheckPending
 */
async function requestStart(
  post: TrackTokenPost, env: NativeTrackEnv, st: TrackState, platform: 'android' | 'ios', mark: string, gen: number, mode: StartMode = 'start',
): Promise<void> {
  try {
    let reply: ReturnType<typeof trackTokenReplyOf> = null;
    try { reply = trackTokenReplyOf((await post(TRACK_TOKEN_PATH, {}, { background: true }))?.data); } catch { reply = null; }
    // أُوقف أثناء الطلب (خروج المندوب): رمزه لا يُسلَّم — والإيقاف حرّر القفل لمن دخل بعده
    if (st.gen !== gen) return;
    st.busy = null;
    if (!reply) {
      // شبكةٌ أو ردٌّ غير متوقَّع: العودة التالية للتطبيق تحاول — والتحقّق الفاشل لا يُحسب سؤالاً فلا ينتظر ٣ دقائق
      if (mode !== 'start') st.verifiedAt = null;
      return;
    }
    if (!reply.enabled) { stopNativeTracking(env, { ifStarted: true }); return; }
    if (mode === 'recheck') { recheckPending(env, st, mark, reply.nativeRecent); return; }
    let rearm: Rearm | null = null;
    if (mode === 'verify') {
      if (getItem(env.session, DAY_KEY) !== mark) return;
      // الخادم رآها ترفع خلال ٥ دقائق (ذاكرته، أو صفّ جهازٍ بعد نشرٍ مسحها) — نافذةٌ أوسع من فجوة رفعٍ عادية: سليمة
      if (reply.nativeRecent) { setItem(env.session, SEEN_KEY, mark); return; }
      if (getItem(env.session, SEEN_KEY) !== mark) {
        // لم تُرَ ترفع منذ التسليم: قتلٌ قبل أوّل سؤال، أو رفضٌ للإفصاح أو الإذن، أو موقعٌ مطفأ — لا يُفرَّق بينها من هنا، وإعادة
        // الطلب تعيد الرفض نفسه كل ٣ دقائق. فأندرويد: تسليحٌ واحد في اليوم (زرٌّ لا يقطع الشاشة). والآيفون لا شيء: إفصاحه نافذةٌ تعود
        // بعد «ليس الآن» (App Review 5.1.1)، والتطبيق الذي ينهيه النظام يفتح صفحته من جديد فتبدأ كأوّل مرة. ثم لا سؤال حتى تسليمٍ جديد
        if (platform === 'ios' || getItem(env.session, REARM_KEY) === mark) { setItem(env.session, QUIET_KEY, mark); return; }
        setItem(env.session, REARM_KEY, mark);
      }
      // قُتلت (أو أوقفت نفسها بلا علمنا) وعلامة اليوم كاذبة ⇒ تُمسح ويُسلَّح البدء كأوّل مرة، وتُحفظ لحظة التسليم لتعود إن رآها
      // سؤالٌ لاحق ترفع. وبدءٌ ثانٍ على خدمةٍ تعمل لا يضرّ: تأخذ رمزه وتستمرّ
      rearm = { at: getItem(env.session, AT_KEY) };
      removeItem(env.session, DAY_KEY);
      removeItem(env.session, AT_KEY);
      removeItem(env.session, SEEN_KEY);
    }
    // جهاز أندرويد يرفع الآن وبدأه هذا الجهاز ولم يوقفه (تبويبٌ سابق، أو إعادة تشغيل التطبيق): لا لمسة ولا بدء ثانٍ. أمّا بعد إيقافٍ من
    // هنا (خروجٌ ثم دخولٌ خلال ٩٠ث) فـnativeActive قد يكون آخر دفعةٍ من خدمةٍ توقفت — تصديقه يعلّم اليوم بلا خدمة حتى آخره، فيُسلَّح
    // البدء كالعادة (وبدءٌ ثانٍ على خدمةٍ تعمل لا يضرّ: تأخذ رمزه وتستمرّ). والآيفون يُرسل بلا لمسة فيتجدّد رمزه
    if (platform === 'android' && reply.nativeActive && getItem(env.local, SENT_KEY) === '1') { markStarted(env, mark, true); return; }
    // ينتظر لمسة الحضور — إلا إن وقعت لمسة الحضور قبل وصول الرمز (الحضور مضى، فالزرّ)
    const waitPunch = reply.waitPunch && st.punchTap !== mark;
    const restart = () => { void startNativeTracking(post, env); };
    if (platform === 'ios' && !waitPunch) { void deliver(env, 'ios', reply.token, mark); return; }
    arm(reply.token, env, st, mark, gen, restart, platform === 'android' && !waitPunch, rearm);
  } catch { /* */ }
}

/**
 * سؤالٌ عن بدءٍ سلّحه التحقّق ولم يُلمس: «لا ترفع» قد يكون فجوة رفعٍ عادية (انقطاع تغطية، أو تراجع الجهاز بعد 503) لا موتاً. فإن
 * رُئيت ترفع الآن يُزال الزرّ (أو انتظار الحضور) وتعود العلامة ولحظتها — وإلا يبقى ويُسأل في عودةٍ لاحقة. لمسةٌ وقعت أثناء الطلب
 * (سُلِّم) أو يومٌ تبدّل: لا شيء يُزال
 */
function recheckPending(env: NativeTrackEnv, st: TrackState, mark: string, alive: boolean): void {
  const p = st.pending;
  if (!p || p.mark !== mark || !p.rearm || !alive) return;
  const at = p.rearm.at;
  p.cancel();
  setItem(env.session, DAY_KEY, mark);
  setItem(env.session, AT_KEY, at !== null && /^\d+$/.test(at) ? at : String(nowMs(env)));
  setItem(env.session, SEEN_KEY, mark);
}

/**
 * لمسة «تسجيل الحضور» (RepAttendance): تُستدعى متزامنةً في أوّل اللمسة قبل أيّ انتظار. بدءٌ مسلَّح (بانتظار الحضور أو بزرّه) يُسلَّم
 * داخلها — ويُزال زرّه — ويُوعد بعودة الصفحة من شاشة التطبيق (حدّاً PUNCH_RETURN_MAX_MS) لتقرأ البصمة موقعها والصفحة ظاهرة.
 * بلا بدءٍ مسلَّح والرمز في الطريق (الإقلاع من تذكير الحضور، أندرويد): تنتظر ردّه حتى PUNCH_TOKEN_WAIT_MS — فإن سلّح بدءاً والإيماءة
 * حيّة سُلّم داخلها، وإلا عُلّمت اللمسة فيعرض الردّ (أو البدء المسلَّح) الزرّ. والآيفون لا ينتظر: رسالته لا تحتاج إيماءة، فاللمسة
 * المعلَّمة تجعل الردّ يُسلَّم فور وصوله. بلا تطبيق لا شيء. لا يرمي أبداً، والوعد يستقرّ دائماً.
 */
export function startNativeTrackingOnPunch(env: NativeTrackEnv | null = browserTrackEnv()): Promise<void> {
  try {
    if (!env) return Promise.resolve();
    const platform = nativeTrackPlatform(env);
    if (!platform) return Promise.resolve();
    const st = stateOf(env);
    const mark = dayMark(deviceDay(env.now()), env.repId());
    const p = st.pending;
    if (p) return deliverPending(env, platform, p, mark);
    const flight = st.busy === mark ? st.flight : null;
    if (platform === 'android' && flight) return punchAfterFlight(env, st, flight, mark, st.gen);
    st.punchTap = mark;
    return Promise.resolve();
  } catch { return Promise.resolve(); }
}

/** البدء المسلَّح داخل لمسة الحضور (ويُزال زرّه) — أو رمزٌ جديد إن تبدّل اليوم أو المندوب قبلها */
function deliverPending(env: NativeTrackEnv, platform: 'android' | 'ios', p: Pending, mark: string): Promise<void> {
  p.cancel();
  if (p.mark !== mark) { p.restart(); return Promise.resolve(); }
  return deliver(env, platform, p.token, mark);
}

/** حتى يستقرّ الوعد أو تمضي ms (مؤقّت الصفحة) — يستقرّ دائماً */
function settledWithin(app: AppEnv, p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let over = false;
    let timer: unknown = null;
    const done = () => {
      if (over) return;
      over = true;
      if (timer !== null) { try { app.clearTimeout(timer); } catch { /* */ } }
      resolve();
    };
    // بلا مؤقّت لا انتظار: طلبٌ معلّق لا يُعلّق البصمة
    try { timer = app.setTimeout(done, ms); } catch { done(); }
    p.then(done, done);
  });
}

/**
 * لمسة حضورٍ سبقت الرمز (أندرويد): ردٌّ سلّح بدءاً خلال PUNCH_TOKEN_WAIT_MS والإيماءة حيّة (أو لا يُعرف حالها) ⇒ يُفتح الرابط داخل
 * اللمسة ويُنتظر عودة الصفحة كالعادة. انقضت الإيماءة ⇒ البدء المنتظِر للحضور يصير زرّاً (الحضور مضى). لم يصل الردّ ⇒ تُعلَّم اللمسة
 * فيعرض الردّ الزرّ. وإيقافٌ أثناء الانتظار (خروج) يُسقطها كلها.
 */
function punchAfterFlight(env: NativeTrackEnv, st: TrackState, flight: Promise<void>, mark: string, gen: number): Promise<void> {
  return settledWithin(env.app, flight, PUNCH_TOKEN_WAIT_MS).then(() => {
    try {
      if (st.gen !== gen) return undefined;
      const p = st.pending;
      if (!p) { st.punchTap = mark; return undefined; }
      const now = dayMark(deviceDay(env.now()), env.repId());
      // الإيماءة تُفحص هنا وحدها: لمسة الحضور نفسها بعد انتظارٍ قصير — لا إيماءةٌ أخرى تُستعار
      if (p.mark !== now || env.app.activation() !== false) return deliverPending(env, 'android', p, now);
      if (!p.chip) { p.cancel(); arm(p.token, env, st, p.mark, gen, p.restart, true, p.rearm); }
    } catch { /* */ }
    return undefined;
  }).catch(() => undefined);
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
    st.flight = null;
    st.pending?.cancel();
    st.pending = null;
    // بدءٌ لاحق (دخولٌ جديد، أو تفعيلٌ بعد «لا تتبّع») يُتحقَّق منه بمهلته هو، لا بموعد سؤالٍ عن خدمةٍ أُوقفت
    st.verifiedAt = null;
    if (!opts.ifStarted) st.halted = { session: env.sessionKey() };
    // ورؤية الخدمة وتسليح اليوم و«لا سؤال» كذلك: بدءٌ بعد الإيقاف (دخولٌ جديد) تسليمٌ أوّل بحسابه هو
    for (const k of [DAY_KEY, AT_KEY, SEEN_KEY, REARM_KEY, QUIET_KEY]) removeItem(env.session, k);
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
