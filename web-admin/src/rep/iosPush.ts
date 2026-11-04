/**
 * تنبيهات الحضور و«أثبت تواجدك» داخل تطبيق فيلد سيلز على الآيفون (APNs، طلب المالك ٤ نوفمبر ٢٠٢٦).
 *
 * صفحة المندوب داخل WKWebView التطبيق لا تملك Web Push (لا PushManager)، فالإشعار يصل التطبيق نفسه من Apple. الصفحة تنادي
 * معالج الرسائل fsPush فيعود وعدٌ بالنتيجة (العقد v1، والمفتاح op كجسر الطباعة fsPrint):
 *
 *   {op:'status'}                    ⇒ {ok:true, v, perm:'granted'|'denied'|'default', token|null, env, error|null}  (بلا سؤال)
 *   {op:'register'}                  ⇒ {ok:true, perm:'granted', token, env} | {ok:false, code:'denied'|'unavailable'|'timeout'|'failed'}
 *   {op:'clear', tag, checkId|null}  ⇒ {ok:true, removed}   (إشعارات هذا الوسم في الدرج — وطلبٌ أحدث بمعرّفٍ آخر لا يُمسّ)
 *   {op:'clear', all:true}           ⇒ {ok:true, removed}   (الدرج كله وطابور الأحداث)
 *   {op:'ready'}                     ⇒ {ok:true, events:[…]} (ما وصل والصفحة لم تستمع بعد — لمسةٌ أقلعت التطبيق)
 *
 * والتطبيق يُخبر الصفحة بحدثٍ fs-ios-push (detail = {v, kind:'receive'|'open'|'token', id, tag, checkId, url, at}) تُقرّ به
 * بـpreventDefault() وإلّا بقي في طابوره لـready. الرفض «forbidden» (أصلٌ غير fieldsa.net) أو «bad_request».
 *
 * نقيٌّ لا يرمي أبداً، ولا وصول للصفحة عند التحميل (pushKey.ts يستورده واختبارات Node تستورد pushKey)، وكل دالة تأخذ نافذةً
 * محقونة للاختبار. لا repApi ولا React ولا ترجمة هنا: الحفظ في الخادم والنصوص في pushAlerts.ts.
 */

/** اسم معالج الرسائل في التطبيق: window.webkit.messageHandlers.fsPush */
export const IOS_PUSH_HANDLER = 'fsPush';
/** علامة التطبيق في الصفحة: window.__fsIosPush = {v, caps} */
export const IOS_PUSH_MARKER = '__fsIosPush';
export const IOS_PUSH_VERSION = 1;
/** حدث التطبيق في الصفحة */
export const IOS_PUSH_EVENT = 'fs-ios-push';
/** مهلة النداءات التي لا تنتظر المندوب (status/clear/ready) — register بلا مهلة: نافذة إذن النظام تنتظره */
export const IOS_PUSH_TIMEOUT_MS = 5000;
/** رمز الجهاز: ست عشريّ صغير الحروف بعدد بايتاتٍ زوجيّ، ٣٢–١٠٠ بايت (Apple: لا تفترض ٣٢) */
export const APNS_TOKEN_RE = /^(?:[0-9a-f]{2}){32,100}$/;
/** عنوان اشتراك هذا الجهاز كما أعاده الخادم آخر مرّة (apns:<البيئة>:<الرمز>) — به يُحذف صفّه عند الخروج */
export const PUSH_APNS_KEY = 'fs_push_apns';
/**
 * يقلبه المالك إلى true بعد صدور إصدار الآيفون الحامل للإشعارات في App Store — فيرى من بقي على 1.1.0 (بلا الجسر) دعوة
 * «حدّث التطبيق» بدل «غير مدعوم».
 */
export const IOS_PUSH_APP_RELEASED = false;

export type ApnsEnv = 'production' | 'sandbox';
export interface IosPushStatus { perm: 'granted' | 'denied' | 'default'; token: string | null; env: ApnsEnv; error: string | null }
export type IosRegister =
  | { ok: true; token: string; env: ApnsEnv }
  | { ok: false; code: 'denied' | 'unavailable' | 'timeout' | 'failed' | 'bad_reply' };
export interface IosPushEvent {
  kind: 'receive' | 'open' | 'token';
  id: string;
  tag: string | null;
  checkId: string | null;
  url: string | null;
  at: number;
}

type Obj = Record<string, unknown>;
type Handler = { postMessage(msg: unknown): unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** وسمٌ أو معرّف طلب: كما يتحقّق منه التطبيق */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ERROR_RE = /^apns_[A-Za-z0-9_-]{1,32}$/;
const KINDS: ReadonlyArray<IosPushEvent['kind']> = ['receive', 'open', 'token'];
const isEnv = (v: unknown): v is ApnsEnv => v === 'production' || v === 'sandbox';

function pageWindow(): unknown {
  return typeof window === 'undefined' ? undefined : window;
}

/** معالج fsPush إن وُجد بدالة postMessage — معالجات تطبيقاتٍ أخرى (messageHandlers عامّة) لا تكفي */
function handlerOf(w: unknown): Handler | null {
  try {
    const hs = (w as { webkit?: { messageHandlers?: Obj } } | undefined)?.webkit?.messageHandlers;
    const h = isObj(hs) ? hs[IOS_PUSH_HANDLER] : undefined;
    return isObj(h) && typeof h.postMessage === 'function' ? (h as unknown as Handler) : null;
  } catch { return null; }
}

/** علامة التطبيق: v عددٌ صحيح ≥ 1 وإلا لا علامة */
function markerOk(w: unknown): boolean {
  try {
    const m = isObj(w) ? w[IOS_PUSH_MARKER] : undefined;
    if (!isObj(m)) return false;
    const v = m.v;
    return typeof v === 'number' && Number.isInteger(v) && v >= IOS_PUSH_VERSION;
  } catch { return false; }
}

/** جسر الإشعارات موجود: المعالج بدالة postMessage والعلامة صالحة — سفاري وتطبيق 1.1.0 وأندرويد والويب: لا */
export function iosPushAvailable(w: unknown = pageWindow()): boolean {
  return handlerOf(w) !== null && markerOk(w);
}

/** نداءٌ على المعالج نفسه (this) — WebKit يرفض postMessage المفصولة. بلا معالج ⇒ وعدٌ مرفوض */
function post(w: unknown, msg: Obj): Promise<unknown> {
  const h = handlerOf(w);
  if (!h) return Promise.reject(new Error('fsPush handler'));
  try {
    return Promise.resolve(h.postMessage(msg));
  } catch (e) { return Promise.reject(e); }
}

/** النداء بمهلة: الرفض والمهلة ⇒ undefined (لا يرمي أبداً) */
async function postWithin(w: unknown, msg: Obj, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      post(w, msg),
      new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), timeoutMs); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** حالة التنبيهات في التطبيق بلا سؤال المندوب — null حين لا جسر أو رفضٌ أو مهلة أو ردٌّ خارج العقد */
export async function iosPushStatus(w: unknown = pageWindow(), timeoutMs: number = IOS_PUSH_TIMEOUT_MS): Promise<IosPushStatus | null> {
  try {
    if (!iosPushAvailable(w)) return null;
    const r = await postWithin(w, { op: 'status' }, timeoutMs);
    if (!isObj(r) || r.ok !== true) return null;
    const { perm, env, token, error } = r;
    if (perm !== 'granted' && perm !== 'denied' && perm !== 'default') return null;
    if (!isEnv(env)) return null;
    return {
      perm,
      token: typeof token === 'string' && APNS_TOKEN_RE.test(token) ? token : null,
      env,
      error: typeof error === 'string' && ERROR_RE.test(error) ? error : null,
    };
  } catch { return null; }
}

/**
 * يطلب الإذن (إن لم يُحسم بعد) ورمز الجهاز — من نقرة المندوب، أو بصمتاً لمن أذن من قبل. بلا مهلةٍ من الصفحة: نافذة الإذن
 * تنتظر المندوب، والتطبيق يضمن ردّاً واحداً دائماً (مهلته ٢٠ ثانية بعد الإذن)
 */
export async function iosPushRegister(w: unknown = pageWindow()): Promise<IosRegister> {
  let r: unknown;
  try {
    r = await post(w, { op: 'register' });
  } catch {
    return { ok: false, code: 'failed' };
  }
  if (isObj(r) && r.ok === true) {
    const { token, env } = r;
    if (typeof token === 'string' && APNS_TOKEN_RE.test(token) && isEnv(env)) return { ok: true, token, env };
    return { ok: false, code: 'bad_reply' };
  }
  const code = isObj(r) ? r.code : undefined;
  if (code === 'denied' || code === 'unavailable' || code === 'timeout') return { ok: false, code };
  return { ok: false, code: 'failed' };
}

/** يمسح من درج التطبيق إشعارات هذا الوسم (ولهذا الطلب وحده إن أُعطي معرّفه) — بمهلة، ولا يرمي */
export async function iosPushClear(tag: string, checkId: string | null, w: unknown = pageWindow(), timeoutMs: number = IOS_PUSH_TIMEOUT_MS): Promise<void> {
  try {
    if (!handlerOf(w)) return;
    // ما يرفضه التطبيق (bad_request) لا يُرسل أصلاً: والمعرّف غير الصالح لا يصير null فيمسح طلباً أحدث
    if (typeof tag !== 'string' || !KEY_RE.test(tag)) return;
    if (checkId !== null && (typeof checkId !== 'string' || !KEY_RE.test(checkId))) return;
    await postWithin(w, { op: 'clear', tag, checkId }, timeoutMs);
  } catch { /* لا درج */ }
}

/** يمسح درج التطبيق كله وطابور أحداثه — الخروج ودخول حسابٍ آخر. بمهلة، ولا يرمي */
export async function iosPushClearAll(w: unknown = pageWindow(), timeoutMs: number = IOS_PUSH_TIMEOUT_MS): Promise<void> {
  try {
    if (!handlerOf(w)) return;
    await postWithin(w, { op: 'clear', all: true }, timeoutMs);
  } catch { /* لا درج */ }
}

/** رابط الإشعار داخل التطبيق وحده (/rep أو /rep/… أو /rep?…) — وما سواه (مضيفٌ آخر، «//مضيف») ⇒ ‎/rep */
function safeRepUrl(u: unknown): string | null {
  if (u === null || u === undefined) return null;
  if (typeof u !== 'string' || u.length > 2048) return '/rep';
  if (!/^\/rep(?:[/?]|$)/.test(u) || u.includes('//') || u.includes('\\')) return '/rep';
  return u;
}

/** يتحقّق من detail حدثٍ من التطبيق (أو عنصرٍ من ready) وينسخ مفاتيح العقد وحدها — وإلا null */
function eventOf(d: unknown): IosPushEvent | null {
  try {
    if (!isObj(d) || d.v !== IOS_PUSH_VERSION) return null;
    const kind = d.kind;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
    const id = d.id;
    if (typeof id !== 'string' || id.length < 1 || id.length > 128) return null;
    const at = d.at;
    if (typeof at !== 'number' || !Number.isFinite(at)) return null;
    if (kind === 'token') return { kind: 'token', id, tag: null, checkId: null, url: null, at };
    const tag = d.tag ?? null;
    if (tag !== null && (typeof tag !== 'string' || !KEY_RE.test(tag))) return null;
    const checkId = typeof d.checkId === 'string' && KEY_RE.test(d.checkId) ? d.checkId : null;
    return { kind: kind as IosPushEvent['kind'], id, tag, checkId, url: safeRepUrl(d.url), at };
  } catch { return null; }
}

/** حدث fs-ios-push من التطبيق ⇒ حدثٌ صالح أو null */
export function iosPushEventDetail(e: Event): IosPushEvent | null {
  try {
    return eventOf((e as CustomEvent<unknown>)?.detail);
  } catch { return null; }
}

/** ما وصل والصفحة لم تستمع بعد (يُنادى بعد تسجيل المستمع) — الصالح وحده، و[] عند أي تعذّر */
export async function iosPushReady(w: unknown = pageWindow(), timeoutMs: number = IOS_PUSH_TIMEOUT_MS): Promise<IosPushEvent[]> {
  try {
    if (!iosPushAvailable(w)) return [];
    const r = await postWithin(w, { op: 'ready' }, timeoutMs);
    if (!isObj(r) || r.ok !== true || !Array.isArray(r.events)) return [];
    const out: IosPushEvent[] = [];
    for (const d of r.events) {
      const ev = eventOf(d);
      if (ev) out.push(ev);
      if (out.length >= 10) break;
    }
    return out;
  } catch { return []; }
}

/**
 * الشاشة التي يفتحها الحدث — كعامل الخدمة: وصول «أثبت تواجدك» والتطبيق ظاهر يفتح الطلب، ولمس الإشعار يفتح شاشة رابطه
 * (screen=presence|attendance)، وتغيّر الرمز لا شاشة له
 */
export function iosPushScreen(ev: IosPushEvent): 'presence' | 'attendance' | null {
  try {
    if (ev.kind === 'receive') return ev.tag === 'presence' ? 'presence' : null;
    if (ev.kind !== 'open' || !ev.url) return null;
    const s = new URL(ev.url, 'https://fieldsa.net').searchParams.get('screen');
    return s === 'presence' || s === 'attendance' ? s : null;
  } catch { return null; }
}

/** حالة البطاقة في شاشة البصمة: «مفعّلة» = أذن الآيفون وحُفظ الرمز لهذا المندوب نفسه (لا لمن قبله على الجوال) */
export function iosPushStateOf(st: IosPushStatus | null, owner: string | null, repId: string | null): 'unsupported' | 'denied' | 'off' | 'on' {
  if (!st) return 'unsupported';
  if (st.perm === 'denied') return 'denied';
  if (st.perm === 'granted' && owner && owner === repId) return 'on';
  return 'off';
}

/** عنوان اشتراك الجهاز في الخادم */
export function apnsEndpointOf(env: ApnsEnv, token: string): string {
  return `apns:${env}:${token}`;
}
