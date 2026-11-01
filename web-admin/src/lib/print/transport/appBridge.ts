/**
 * جسر الطباعة إلى تطبيق فيلد سيلز على أندرويد — حين لا يحمل المتصفح Web Serial (Samsung Internet، WebView، Chrome أقدم،
 * Firefox) تُسلَّم المهمة نفسها (بايتات encodeForProfile) للتطبيق برابط intent فيطبعها بالبلوتوث الكلاسيكي.
 *
 *   intent://print?k=<المفتاح>&p=<الحمولة>#Intent;scheme=fieldsaprint;package=net.fieldsa.twa;end
 *
 * بلا رابطٍ بديل أبداً (يغادر الصفحة فتُعاد)، ومع package دائماً: التطبيق الجديد يفتح شاشته، والقديم أو الغائب يفتح Chrome
 * صفحته في Google Play — والصفحة لا تُغادَر ولا تُعاد في أيّ حال. والتسليم يُعرف بإخفاء الصفحة (visibilitychange/pagehide)
 * خلال 3 ثوانٍ؛ وإلا فالمطلوب تحديث التطبيق (DirectPrintError('appUpdate')) — بلا ذكر سببٍ تقنيّ.
 * إلا WebView (وسم «; wv)»): لا سوق يرجع إليه، ورابطٌ لا يتولّاه تطبيقٌ في الإطار الأعلى يضع صفحة خطأ مكان الصفحة —
 * فيُفتح من إطارٍ مخفيّ، وخطؤه (إن كان) لا يُرى.
 *
 * علامة الجسر (fs_print_bridge): يضيف LauncherActivity لرابط الإقلاع fsbridge=<الإصدار>.<المفتاح>، فتحفظها الصفحة وتحذف
 * المعامل فوراً (captureBridgeLaunch في main.tsx). المفتاح يتيح للتطبيق الطباعة بلا لمسة تأكيد؛ وبلا مفتاح (تبويب متصفح)
 * يُحاول الجسر أيضاً ويؤكّد التطبيق بلمسة.
 */
import { DirectPrintError } from '../printErrors';
import type { DirectOutcome, DirectUi } from '../../../rep/printDirect';
import {
  BRIDGE_HOST_PRINT, BRIDGE_HOST_PRINTER, BRIDGE_KEY_RE, BRIDGE_LAUNCH_PARAM, BRIDGE_PACKAGE, BRIDGE_PARAM_KEY, BRIDGE_PARAM_PAYLOAD,
  BRIDGE_SCHEME, HANDOFF_TIMEOUT_MS, LATE_HANDOFF_MS, LAUNCH_GESTURE_MS, MAX_INTENT_URL_CHARS,
} from './bridgeContract';
import { BridgePayloadError, encodeBridgePayload, type BridgeJob } from './bridgePayload';

/** «طابعة» مسار التطبيق: لا منفذ في الصفحة — وقت اللمسة وحده (لصلاحية الإيماءة عند فتح الرابط) */
export interface AppPrinterLink { readonly via: 'fs-app'; readonly tappedAt: number }
export interface BridgeFlag { v: number; k: string; at: number }

type Listen = { addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
export interface AppEnv {
  doc: Listen & { readonly visibilityState: string };
  win: Listen & { location: { href: string } };
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now: () => number;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  /** navigator.userActivation?.isActive — null حيث لا يُعرف */
  activation: () => boolean | null;
  /** WebView وحده: يفتح الرابط من إطارٍ مخفيّ ويعيد مُزيلَه — وغيره من الإطار الأعلى (location.href) */
  frame?: ((url: string) => () => void) | null;
}

const FLAG_KEY = 'fs_print_bridge';

function pageStorage(): AppEnv['storage'] {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** WebView على أندرويد — وسم «; wv)» في الوكيل (يبقى بعد تقليص الوكيل) */
export function isAndroidWebView(ua: string): boolean {
  return /; wv\)/.test(ua);
}

/** إطارٌ مخفيّ يحمل الرابط: WebView يسلّمه لمن يتولّاه، وخطؤه إن لم يتولّه أحدٌ يبقى فيه لا في الصفحة */
function hiddenFrame(url: string): () => void {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.display = 'none';
  document.body.appendChild(f);
  f.src = url;
  return () => f.remove();
}

/** بيئة الصفحة الحقيقية — تُقرأ عند الاستدعاء لا عند التحميل */
export function browserAppEnv(): AppEnv {
  return {
    doc: document,
    win: window,
    storage: pageStorage(),
    now: () => Date.now(),
    setTimeout: (f, ms) => window.setTimeout(f, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    activation: () => {
      const a = (navigator as { userActivation?: { isActive?: unknown } }).userActivation;
      return typeof a?.isActive === 'boolean' ? a.isActive : null;
    },
    frame: isAndroidWebView(navigator.userAgent) ? hiddenFrame : null,
  };
}

export function readBridgeFlag(storage: AppEnv['storage'] = pageStorage()): BridgeFlag | null {
  try {
    const raw = storage?.getItem(FLAG_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw) as Partial<BridgeFlag> | null;
    if (!f || typeof f !== 'object') return null;
    if (typeof f.v !== 'number' || !Number.isInteger(f.v) || f.v < 1) return null;
    if (typeof f.k !== 'string' || !BRIDGE_KEY_RE.test(f.k)) return null;
    if (typeof f.at !== 'number' || !Number.isFinite(f.at)) return null;
    return { v: f.v, k: f.k, at: f.at };
  } catch { return null; }
}

export function writeBridgeFlag(f: BridgeFlag, storage: AppEnv['storage'] = pageStorage()): void {
  try { storage?.setItem(FLAG_KEY, JSON.stringify({ v: f.v, k: f.k, at: f.at })); } catch { /* تخزينٌ محجوب: يُؤكَّد بلمسة */ }
}

export function clearBridgeFlag(storage: AppEnv['storage'] = pageStorage()): void {
  try { storage?.removeItem(FLAG_KEY); } catch { /* */ }
}

/** اسم معاملٍ من «اسم=قيمة» كما يفكّه URLSearchParams */
function paramName(part: string): string {
  const eq = part.indexOf('=');
  const name = (eq < 0 ? part : part.slice(0, eq)).split('+').join(' ');
  try { return decodeURIComponent(name); } catch { return name; }
}

/**
 * يُستدعى قبل أوّل رسمٍ لـReact: يحفظ علامة الجسر من fsbridge إن صحّت، ويحذف المعامل دائماً بـhistory.replaceState —
 * فيبقى history.state وبقية المعاملات (ومنها cardpay) بحروفها والمرساة. لا يرمي أبداً ولا يعيد تحميل الصفحة.
 */
export function captureBridgeLaunch(env?: {
  location: Pick<Location, 'search' | 'pathname' | 'hash'>;
  history: Pick<History, 'state' | 'replaceState'>;
  storage: AppEnv['storage'];
  now?: () => number;
}): void {
  try {
    const e = env ?? (typeof window === 'undefined' ? null : { location: window.location, history: window.history, storage: pageStorage() });
    if (!e) return;
    const search = e.location.search.startsWith('?') ? e.location.search.slice(1) : e.location.search;
    const parts = search.split('&').filter((s) => s.length > 0);
    if (!parts.some((s) => paramName(s) === BRIDGE_LAUNCH_PARAM)) return;
    const value = new URLSearchParams(search).get(BRIDGE_LAUNCH_PARAM) ?? '';
    const m = /^(\d{1,3})\.([A-Za-z0-9_-]{22})$/.exec(value);
    if (m && Number(m[1]) >= 1) writeBridgeFlag({ v: Number(m[1]), k: m[2], at: (e.now ?? Date.now)() }, e.storage);
    const q = parts.filter((s) => paramName(s) !== BRIDGE_LAUNCH_PARAM).join('&');
    e.history.replaceState(e.history.state, '', e.location.pathname + (q ? '?' + q : '') + e.location.hash);
  } catch { /* لا شيء يمنع الإقلاع */ }
}

const intentTail = `#Intent;scheme=${BRIDGE_SCHEME};package=${BRIDGE_PACKAGE};end`;

/** رابط طباعة مهمة — القيمتان base64url فلا ترميز نسبة أبداً؛ وبلا مفتاحٍ صالح يُحذف k كلّه */
export function printIntentUrl(payload: string, key: string | null): string {
  const k = key && BRIDGE_KEY_RE.test(key) ? `${BRIDGE_PARAM_KEY}=${key}&` : '';
  return `intent://${BRIDGE_HOST_PRINT}?${k}${BRIDGE_PARAM_PAYLOAD}=${payload}${intentTail}`;
}

/** رابط اختيار الطابعة أو تغييرها في التطبيق */
export function pickerIntentUrl(): string {
  return `intent://${BRIDGE_HOST_PRINTER}${intentTail}`;
}

export function appPrinterLink(now: number = Date.now()): AppPrinterLink {
  return { via: 'fs-app', tappedAt: now };
}

/**
 * يفتح الرابط من الإطار الأعلى (أو من إطار WebView المخفيّ) بعد تعليق المستمعين: إخفاء الصفحة خلال timeoutMs ⇒ 'handed'، وإلا
 * 'failed' — ثم يبقى يستمع حتى lateMs من الفتح: إخفاءٌ متأخّر ⇒ onLate مرّةً واحدة. blur لا يُعتدّ به (نافذةٌ من المتصفح تُفقد
 * التركيز أيضاً). والإطار المخفيّ يُزال حين تنتهي المراقبة.
 */
export function launchIntent(url: string, env: AppEnv, opts: { timeoutMs?: number; lateMs?: number; onLate?: () => void } = {}): Promise<'handed' | 'failed'> {
  const timeoutMs = opts.timeoutMs ?? HANDOFF_TIMEOUT_MS;
  const lateMs = opts.lateMs ?? LATE_HANDOFF_MS;
  return new Promise((resolve) => {
    let state: 'wait' | 'failed' | 'over' = 'wait';
    let timer: unknown = null;
    let lateTimer: unknown = null;
    let unframe: (() => void) | null = null;
    const over = () => state === 'over';
    const finish = () => {
      state = 'over';
      env.doc.removeEventListener('visibilitychange', onVisibility);
      env.win.removeEventListener('pagehide', onHidden);
      if (timer !== null) env.clearTimeout(timer);
      if (lateTimer !== null) env.clearTimeout(lateTimer);
      if (unframe) { const u = unframe; unframe = null; try { u(); } catch { /* */ } }
    };
    const onHidden = () => {
      if (state === 'wait') { finish(); resolve('handed'); }
      else if (state === 'failed') { finish(); opts.onLate?.(); }
    };
    const onVisibility = () => { if (env.doc.visibilityState === 'hidden') onHidden(); };
    env.doc.addEventListener('visibilitychange', onVisibility);
    env.win.addEventListener('pagehide', onHidden);
    timer = env.setTimeout(() => {
      timer = null;
      if (state !== 'wait') return;
      state = 'failed';
      resolve('failed');
      lateTimer = env.setTimeout(() => { lateTimer = null; if (state === 'failed') finish(); }, Math.max(0, lateMs - timeoutMs));
    }, timeoutMs);
    try {
      if (env.frame) {
        const remove = env.frame(url);
        // سُلّم أثناء الفتح نفسه ⇒ انتهت المراقبة قبل أن يُعرف المُزيل
        if (over()) remove(); else unframe = remove;
      } else {
        env.win.location.href = url;
      }
    } catch { /* المهلة تحكم */ }
  });
}

/** من ينتظر تسليماً متأخّراً — الواجهة تستبدل دعوة التحديث بحصيلته */
const lateWatchers = new Set<(outcome: 'done' | 'handed') => void>();

/**
 * فُتح التطبيق بعد المهلة (وقد عُرضت دعوة التحديث): 'done' بمفتاح الثقة، و'handed' بدونه — فلا تبقى «حدّث التطبيق» بعد طباعةٍ
 * تمّت. يعيد إلغاء الاشتراك.
 */
export function onLateHandoff(f: (outcome: 'done' | 'handed') => void): () => void {
  lateWatchers.add(f);
  return () => { lateWatchers.delete(f); };
}

/** التسليم ونتيجته: المفتاح موجود ⇒ طبع التطبيق بصمت ('done')؛ بلا مفتاح ⇒ 'handed' (تلميح التحديث الهادئ) */
async function handOff(url: string, env: AppEnv, ui: Pick<DirectUi, 'onHandoff'> | null, flag: BridgeFlag | null): Promise<DirectOutcome> {
  ui?.onHandoff?.();
  const onLate = () => {
    if (flag) writeBridgeFlag(flag, env.storage);
    for (const f of [...lateWatchers]) { try { f(flag ? 'done' : 'handed'); } catch { /* */ } }
  };
  const r = await launchIntent(url, env, { onLate });
  if (r === 'handed') return flag ? 'done' : 'handed';
  clearBridgeFlag(env.storage);
  throw new DirectPrintError('appUpdate');
}

/** يرسل المهمة إلى التطبيق — الترميز أوّلاً (الكبير يُرفض قبل أيّ فتح)، ثم لمسةٌ ثانية إن انقضت صلاحية الإيماءة */
export async function sendViaApp(link: AppPrinterLink, job: BridgeJob, ui: DirectUi, env: AppEnv = browserAppEnv()): Promise<DirectOutcome> {
  let payload: string;
  try {
    payload = await encodeBridgePayload(job);
  } catch (e) {
    throw new DirectPrintError(e instanceof BridgePayloadError && e.code === 'TOO_LARGE' ? 'tooLarge' : 'failed', e);
  }
  const flag = readBridgeFlag(env.storage);
  const url = printIntentUrl(payload, flag?.k ?? null);
  if (url.length > MAX_INTENT_URL_CHARS) throw new DirectPrintError('tooLarge');
  if (ui.signal?.aborted) return 'cancelled';
  const act = env.activation();
  const live = typeof act === 'boolean' ? act : env.now() - link.tappedAt <= LAUNCH_GESTURE_MS;
  if (!live && ui.requestTap) {
    try { await ui.requestTap(); } catch { return 'cancelled'; }
  }
  return handOff(url, env, ui, flag);
}

/** «ربط الطابعة» في التطبيق — شاشة اختيار الطابعة المقترنة */
export async function openAppPicker(env: AppEnv = browserAppEnv()): Promise<'handed'> {
  await handOff(pickerIntentUrl(), env, null, readBridgeFlag(env.storage));
  return 'handed';
}
