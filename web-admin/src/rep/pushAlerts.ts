// تنبيهات الحضور على جوال المندوب (Web Push، طلب المالك ٢١ أكتوبر ٢٠٢٦): «قبل بداية الدوام» و«نسيت الانصراف».
//
// المندوب يفعّلها بضغطة من شاشة البصمة (الإذن يُطلب داخل النقرة)، فيُحفظ اشتراك جهازه في الخادم ومعه إزاحة توقيته
// ولغته، والخادم يرسل في موعده (backend/src/services/attendanceAlerts.ts). عامل الخدمة (public/sw.js) يعرض الإشعار.
// آيفون: الإشعارات لتطبيق الويب المضاف إلى الشاشة الرئيسية (iOS 16.4+)، وفي تطبيق فيلد سيلز الأصلي عبر جسره fsPush إلى APNs
// (iosPush.ts، ٤ نوفمبر ٢٠٢٦): الإذن من النقرة نفسها، والرمز يُحفظ بـ/tracking/push/apns، والخادم يرسل إلى Apple.
import repApi from './repApi';
import { FS_CAPS_HEADER, FS_CAPS_VALUE } from '../api/caps';
import { useLang } from '../i18n/lang';
import { PHRASES } from '../i18n/strings';
import { urlB64ToBytes, localPushSubscription, unsubscribeLocalPush, PUSH_OWNER_KEY } from './pushKey';
import { isIosWrapper } from '../lib/print/transport/iosBridge';
import {
  iosPushAvailable, iosPushStatus, iosPushRegister, iosPushClearAll, iosPushStateOf, apnsEndpointOf, IOS_PUSH_APP_RELEASED,
  PUSH_APNS_KEY, type ApnsEnv,
} from './iosPush';

export type PushState = 'unsupported' | 'ios-install' | 'ios-update' | 'denied' | 'off' | 'on';

// ‏iPadOS 13+ يقدّم نفسه «ماك» في User-Agent سفاري — يُعرف باللمس المتعدّد على منصّة MacIntel
export const isIos = () => typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const standalone = () => typeof window !== 'undefined'
  && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

function supported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}


/** العامل جاهزاً للاشتراك — بمهلة: ready لا تُحلّ أبداً حين فشل تسجيله، فيعلق زرّ التفعيل على «جارٍ التسجيل» */
async function readyRegistration(timeoutMs = 10_000): Promise<ServiceWorkerRegistration | null> {
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
  } catch { return null; }
}

const currentRepId = (): string | null => {
  try { return (JSON.parse(localStorage.getItem('rep_user') || 'null') as { id?: string } | null)?.id ?? null; } catch { return null; }
};

/** صاحب تنبيهات هذا الجهاز (المندوب الذي حُفظ له رمزه أو اشتراكه) */
const pushOwner = (): string | null => {
  try { return localStorage.getItem(PUSH_OWNER_KEY); } catch { return null; }
};

/** رمز جلسة المندوب الداخل الآن */
const sessionToken = (): string | null => {
  try { return localStorage.getItem('rep_token'); } catch { return null; }
};

/** الوعد أو المهلة أيّهما أسبق */
const within = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/**
 * جلسة تنبيهات الآيفون: العدّاد يزيد عند كل خروجٍ ودخول (endIosSession). حفظٌ بدأ لجلسةٍ انتهت لا يكتب علامات الجهاز لمن بعدها
 * ولا يُعاد لجلسةٍ جديدة بدل مزامنتها هي، وما كتبه في الخادم يحذفه بجلسة صاحبه — جوالٌ مشترك على شبكةٍ ميدانية بطيئة
 */
let iosEpoch = 0;
/** المزامنة الصامتة الجارية لهذه الجلسة — نداءٌ واحدٌ في الطريق لكل جلسة */
let iosRefreshing: { epoch: number; run: Promise<void> } | null = null;
/** مزامناتُ جلساتٍ انتهت وما زالت في الطريق — مزامنة الجلسة التالية تنتظرها (بسقف) فيُحسم صفّ الخادم لها آخراً */
let iosStale: Promise<void> | null = null;

function endIosSession(): void {
  iosEpoch++;
  const cur = iosRefreshing;
  iosRefreshing = null;
  if (!cur) return;
  const all: Promise<void> = (iosStale ? Promise.all([iosStale, cur.run]) : cur.run).then(() => { if (iosStale === all) iosStale = null; });
  iosStale = all;
}

/** مواعيد إعادة حذف صفٍّ لم يبلغ حذفُه الخادم (ما دام التطبيق حيّاً) */
const IOS_DROP_RETRY_MS = [15_000, 60_000, 180_000, 600_000];

/**
 * ‏/push/unsubscribe بجلسةٍ بعينها ولو خرجت: رمزها صريحاً بلا معترض repApi — فهو يضع رمز من دخل الآن فيحذف صفّ غيره.
 * true: حذفه الخادم
 */
async function unsubscribeIosAs(session: string, endpoint: string, timeoutMs = 10_000): Promise<boolean> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${repApi.defaults.baseURL ?? '/api'}/tracking/push/unsubscribe`, {
      method: 'POST',
      signal: ctrl?.signal,
      headers: { 'Content-Type': 'application/json', [FS_CAPS_HEADER]: FS_CAPS_VALUE, Authorization: `Bearer ${session}` },
      body: JSON.stringify({ endpoint }),
    });
    return res.ok;
  } catch { return false; } finally { if (timer) clearTimeout(timer); }
}

/** حذفٌ لم يبلغ الخادم يُعاد في الخلفية — ويكفّ إن عاد صاحب الصفّ إلى الجهاز: مزامنة جلسته الجديدة تملكه */
function dropIosRowLater(session: string, repId: string, endpoint: string, attempt = 0): void {
  if (attempt >= IOS_DROP_RETRY_MS.length) return;
  setTimeout(() => {
    if (currentRepId() === repId) return;
    void dropIosRow(session, repId, endpoint, attempt + 1);
  }, IOS_DROP_RETRY_MS[attempt]);
}

/** يحذف صفّ هذا الجهاز لجلسةٍ انتهت (أو يعيد المحاولة لاحقاً) — الآيفون لا اشتراك فيه يُلغى محلياً كالويب: الصفّ وحده يوقف التنبيهات */
async function dropIosRow(session: string, repId: string, endpoint: string, attempt = 0): Promise<void> {
  if (!(await unsubscribeIosAs(session, endpoint))) { dropIosRowLater(session, repId, endpoint, attempt); return; }
  // حُذف: عنوان الجهاز يُنسى ما لم يدخل أحدٌ بعده (مزامنة الداخل تكتبه)
  if (!currentRepId()) { try { if (localStorage.getItem(PUSH_APNS_KEY) === endpoint) localStorage.removeItem(PUSH_APNS_KEY); } catch { /* تخزينٌ محجوب */ } }
}

/** حالة التنبيهات على هذا الجهاز الآن */
export async function pushState(): Promise<PushState> {
  if (iosPushAvailable()) return iosPushStateOf(await iosPushStatus(), pushOwner(), currentRepId());
  if (!supported()) {
    // تطبيق الآيفون بلا جسر الإشعارات (1.1.0): «أضف إلى الشاشة الرئيسية» نصيحةٌ خاطئة داخل التطبيق
    if (typeof navigator !== 'undefined' && typeof document !== 'undefined' && isIosWrapper(navigator.userAgent, document.cookie))
      return IOS_PUSH_APP_RELEASED ? 'ios-update' : 'unsupported';
    return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  return (await localPushSubscription()) ? 'on' : 'off';
}

/** لغة التطبيق الحالية — نصّ التنبيه يُرسل بها */
const lang = () => useLang.getState().lang;
/** ترجمة عبارةٍ خارج المكوّنات (بلا خطّاف) — كـuseTr بلغة اللحظة */
const tr = (ar: string): string => { const l = lang(); return l === 'ar' ? ar : (PHRASES[ar]?.[l] ?? ar); };
/** خطأٌ برسالةٍ للمندوب بشكل ردّ الخادم — شاشة البصمة تعرض response.data.message كما هي */
const userError = (text: string) => Object.assign(new Error(text), { response: { data: { message: text } } });

async function save(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await repApi.post('/tracking/push/subscribe', {
    subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } },
    tzOffsetMin: -new Date().getTimezoneOffset(),
    lang: lang(),
  });
  try { const id = currentRepId(); if (id) localStorage.setItem(PUSH_OWNER_KEY, id); } catch { /* تخزينٌ محجوب */ }
}

/**
 * تطبيق الآيفون: يحفظ رمز الجهاز لهذا المندوب. الخادم يخزّنه دائماً، و«مفعّلة» لا تُكتب إلا والإرسال إلى Apple مهيّأٌ فيه
 * (active) — وإلّا قيل للمندوب «غير متاحة الآن» وبقيت البطاقة «غير مفعّلة». والحفظ الصامت خلفيّ: 401 عابرٌ منه لا يُخرجه.
 * والمندوب وجلسته يُقرآن قبل الطلب: خروجٌ أو دخول غيره في أثنائه لا تُكتب علاماته لمن بعده، وصفّه المتأخّر يُحذف بجلسته هو
 */
async function saveIos(token: string, env: ApnsEnv, background = false): Promise<void> {
  const epoch = iosEpoch;
  const session = sessionToken();
  const repId = currentRepId();
  const { data } = await repApi.post('/tracking/push/apns', {
    token, env,
    tzOffsetMin: -new Date().getTimezoneOffset(),
    lang: lang(),
  }, background ? { background: true, timeout: 15_000 } : undefined)
    // انتهت الجلسة والحفظ في الطريق: لعلّه بلغ الخادم بعد حذف الخروج فأعاد الصفّ لصاحبه
    .finally(() => (epoch !== iosEpoch && session && repId ? dropIosRow(session, repId, apnsEndpointOf(env, token)) : undefined));
  if (epoch !== iosEpoch) return;
  const d = (data as { data?: { endpoint?: unknown; active?: unknown } } | null)?.data;
  try { if (typeof d?.endpoint === 'string') localStorage.setItem(PUSH_APNS_KEY, d.endpoint); } catch { /* تخزينٌ محجوب */ }
  if (d?.active !== true) {
    // الخادم بلا إعداد Apple: لا «مفعّلة» بلا تنبيهات — ولا تبقى من مرّةٍ سابقة
    try { localStorage.removeItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
    throw userError(tr('تنبيهات آيفون غير متاحة الآن حاول لاحقا'));
  }
  try { if (repId) localStorage.setItem(PUSH_OWNER_KEY, repId); } catch { /* تخزينٌ محجوب */ }
}

/** تطبيق الآيفون: الإذن من النقرة (نافذة النظام إن لم يُحسم) ثمّ الرمز ثمّ الحفظ — وأيّ تعذّرٍ آخر خطأٌ عامّ («تعذّر التفعيل») */
async function enableIosPush(): Promise<PushState> {
  const r = await iosPushRegister();
  if (!r.ok) {
    if (r.code === 'denied') return 'denied';
    throw new Error('ios-push ' + r.code);
  }
  await saveIos(r.token, r.env);
  return 'on';
}

/** يفعّل التنبيهات — يُستدعى من نقرة (إذن الإشعارات يُطلب داخلها). يعيد الحالة بعد المحاولة */
export async function enablePush(): Promise<PushState> {
  if (iosPushAvailable()) return enableIosPush();
  if (!supported()) return pushState();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await readyRegistration();
  if (!reg) return 'unsupported';
  const { data } = await repApi.get('/tracking/push/key');
  const key = urlB64ToBytes(data.data.publicKey as string);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // اشتراكٌ قديم بمفتاحٍ آخر لا يصلح لخادمنا — يُجدَّد
    const old = sub.options?.applicationServerKey;
    if (old && new Uint8Array(old as ArrayBuffer).toString() !== key.toString()) { await sub.unsubscribe(); sub = null; }
  }
  const fresh = !sub;
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource });
  try {
    await save(sub);
  } catch (e) {
    // اشتراكٌ أُنشئ الآن ولم يحفظه الخادم: يُلغى فتبقى الحالة «غير مفعّلة» وزرّ التفعيل ظاهراً — لا «مفعّلة» بلا تنبيهات
    if (fresh) await sub.unsubscribe().catch(() => false);
    throw e;
  }
  return 'on';
}

/**
 * أطفأ المندوب إشعارات التطبيق من إعدادات الآيفون: Apple تقبل الإرسال (200) ولا يظهر له شيء، فيُحذف صفّ جهازه لترى الإدارة
 * «لم يصل الإشعار جهازه» — والعلامات تبقى حتى يحذفه الخادم (تُعاد المحاولة في المرّة القادمة)، وإن أذن ثانيةً عاد الحفظ الصامت
 */
async function forgetIosEndpoint(epoch: number): Promise<void> {
  let endpoint: string | null = null;
  try { endpoint = localStorage.getItem(PUSH_APNS_KEY); } catch { /* تخزينٌ محجوب */ }
  if (!endpoint) return;
  await repApi.post('/tracking/push/unsubscribe', { endpoint }, { background: true, timeout: 10_000 });
  if (epoch !== iosEpoch) return;
  try { localStorage.removeItem(PUSH_OWNER_KEY); localStorage.removeItem(PUSH_APNS_KEY); } catch { /* تخزينٌ محجوب */ }
}

/**
 * تطبيق الآيفون: من أذن من قبل يُعاد حفظ رمزه لهذا المندوب بصمت (الرمز يتغيّر، والحساب يتبدّل على الجوال) — نافذة الإذن لا
 * تظهر إلا من نقرة «تفعيل التنبيهات»، ولا شيء بلا جلسة. نداءٌ واحدٌ في الطريق لكل جلسة، ولا يرمي: دون اتصال ففي المرّة القادمة
 */
export function refreshIosPush(): Promise<void> {
  if (!iosPushAvailable()) return Promise.resolve();
  if (iosRefreshing?.epoch === iosEpoch) return iosRefreshing.run;
  const epoch = iosEpoch;
  const run = (async () => {
    if (!sessionToken()) return;
    // مزامنة جلسةٍ سابقة ما زالت في الطريق تُنتظر أوّلاً: وإلّا بلغ حفظها المتأخّر الخادم بعد حفظ هذه فعاد الصفّ لصاحبها
    if (iosStale) await within(iosStale, 30_000);
    if (epoch !== iosEpoch) return;
    const st = await iosPushStatus();
    if (!st) return;
    if (st.perm !== 'granted') { await forgetIosEndpoint(epoch); return; }
    const r = await iosPushRegister();
    // الرمز قد يتأخّر (حتى ٢٠ ثانية): جلسةٌ انتهت في أثنائه لا تُرسل شيئاً
    if (!r.ok || epoch !== iosEpoch) return;
    await saveIos(r.token, r.env, true);
  })().catch(() => { /* دون اتصال أو الخادم غير مهيّأ: في المرّة القادمة */ });
  const entry = { epoch, run };
  iosRefreshing = entry;
  void run.finally(() => { if (iosRefreshing === entry) iosRefreshing = null; });
  return run;
}

/** عند فتح شاشة البصمة: الاشتراك القائم يُعاد إرساله (توقيت الجهاز ولغته قد تغيّرا، أو الحساب تبدّل على الجهاز) */
export async function refreshPush(): Promise<void> {
  if (iosPushAvailable()) return refreshIosPush();
  if (!supported() || Notification.permission !== 'granted') return;
  const sub = await localPushSubscription();
  if (sub) await save(sub).catch(() => { /* دون اتصال: في المرّة القادمة */ });
}

/**
 * عند الدخول: اشتراكٌ على هذا الجهاز لحسابٍ آخر (أو بلا صاحبٍ معروف) يُلغى محلياً — حسابٌ خرج قسراً (رُفض تجديده) لم
 * يُلغِ اشتراكه، فتصل تنبيهات دوامه من بعده جوالَ مندوبٍ آخر ولو من شركةٍ أخرى. الخادم يحذف صفّه عند أول إرسالٍ يُرفض.
 */
export async function forgetForeignPush(repId: string): Promise<void> {
  if (iosPushAvailable()) endIosSession(); // دخولٌ جديد: حفظُ جلسةٍ سابقة ما زال في الطريق لا يُعاد له ولا يكتب علاماته
  let owner: string | null = null;
  try { owner = localStorage.getItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
  if (owner === repId) return;
  if (iosPushAvailable()) { await unsubscribeLocalPush(); return; } // الآيفون: يُمسح درجه، والدخول الجديد ينقل صفّه إليه
  if (await localPushSubscription()) await unsubscribeLocalPush();
}

/**
 * خروج تطبيق الآيفون: لا اشتراك محلياً يُلغى كالويب — التنبيهات لا تتوقّف إلا بحذف صفّ الجهاز من الخادم. فدرج الإشعارات يُمسح
 * محلياً أولاً، ثمّ يُحذف الصفّ بمهلةٍ أطول من الويب، وما لم يبلغ الخادم يُعاد في الخلفية بجلسة الخارج — لا يمنع الخروج
 */
async function dropIosPush(): Promise<void> {
  try {
    // حفظٌ صامتٌ في الطريق (دخولٌ للتوّ) يُنتظر فيبلغ الخادم قبل الحذف؛ وبسقفٍ قصير: لا يعلّق الخروج — وما تأخّر بعده يحذف صفّه بنفسه
    const sync = iosRefreshing?.run;
    if (sync) await within(sync, 3000);
    endIosSession();
    const session = sessionToken();
    const repId = currentRepId();
    let endpoint: string | null = null;
    try { endpoint = localStorage.getItem(PUSH_APNS_KEY); } catch { /* تخزينٌ محجوب */ }
    if (!endpoint) {
      const st = await iosPushStatus(undefined, 2000);
      if (st?.token) endpoint = apnsEndpointOf(st.env, st.token);
    }
    await iosPushClearAll();
    try { localStorage.removeItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
    if (!endpoint) return;
    const ok = await repApi.post('/tracking/push/unsubscribe', { endpoint }, { background: true, timeout: 8000 }).then(() => true, () => false);
    // عنوان الجهاز يبقى حتى يُحذف صفّه (به يُحذف لاحقاً إن أطفأ الإشعارات من الإعدادات)
    if (ok) { try { localStorage.removeItem(PUSH_APNS_KEY); } catch { /* تخزينٌ محجوب */ } }
    else if (session && repId) dropIosRowLater(session, repId, endpoint);
  } catch { /* لا يمنع الخروج */ }
}

/** عند تسجيل الخروج: الجهاز لا يتلقّى تنبيهات حسابٍ خرج منه */
export async function dropPush(): Promise<void> {
  if (iosPushAvailable()) return dropIosPush();
  try {
    const sub = await localPushSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    // محلياً أولاً (لا يحتاج شبكة)، ثمّ إخبار الخادم بمهلةٍ قصيرة: شبكةٌ ميدانية معلّقة لا تعلّق الخروج
    await sub.unsubscribe().catch(() => false);
    try { localStorage.removeItem(PUSH_OWNER_KEY); } catch { /* تخزينٌ محجوب */ }
    await repApi.post('/tracking/push/unsubscribe', { endpoint }, { background: true, timeout: 3000 }).catch(() => {});
  } catch { /* لا يمنع الخروج */ }
}
