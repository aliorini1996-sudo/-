import axios from 'axios';
import { FS_CAPS_HEADER, FS_CAPS_VALUE } from '../api/caps';
import { refClear } from './offlineDb';
import { renewToken } from './renew';
import {
  LIVE_FIX_TIMEOUT_MS, emitLiveRefused, isLiveGuardedRequest, isLiveRefusal, isLocalLiveRefusal, liveFixOf, liveRefusalError,
  noteServer, notePing, pingBody, pingVerdictOf, preflightLive, strictRepNow,
  type FreshFixResult, type LiveFix, type PingResult, type PreflightResult,
} from './liveGate';

// نسمح للطلب بوسم نفسه «خلفياً» فلا يُخرج المندوب عند فشل 401 عابر.
// انظر التعليق على المعترِض أدناه للسبب.
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** طلب خلفي تلقائي (نبضة تتبّع/حضور): فشله لا يُنهي جلسة المندوب */
    background?: boolean;
  }
}

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

// عميل API مستقل للمندوب — يستخدم مفتاح token خاص حتى لا يتعارض مع جلسة الأدمن
const repApi = axios.create({
  baseURL: BASE,
  // قدرات الحزمة (ZATCA المرحلة الثانية) — انظر api/caps.ts
  headers: { 'Content-Type': 'application/json', [FS_CAPS_HEADER]: FS_CAPS_VALUE },
});

/** ساعة الجهاز لحظة الإرسال (ms) — بها يصحّح الخادم لحظة قراءة الموقع إلى ساعته (القفل الكامل، liveGate.ts) */
export const DEVICE_NOW_HEADER = 'X-FS-Device-Now';

/** قراءةٌ طازجة الآن — لا مخبّأة (maximumAge: 0): قراءةٌ قبل إطفاء الموقع لا تُثبت شيئاً */
export function freshLiveFix(): Promise<FreshFixResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { resolve({ error: 1 }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ fix: liveFixOf(p) }),
      (e) => resolve({ error: e.code === 1 ? 1 : e.code === 2 ? 2 : 3 }),
      { enableHighAccuracy: true, maximumAge: 0, timeout: LIVE_FIX_TIMEOUT_MS },
    );
  });
}

/** نقطة الحاجز: POST /tracking/ping بقراءةٍ واحدة، وحكم الخادم «حيّ الآن» من ردّها */
export async function sendLivePing(fix: LiveFix): Promise<PingResult> {
  try {
    // background: فشلها العابر بـ401 لا يُخرج المندوب
    const res = await repApi.post('/tracking/ping', pingBody(fix), { background: true });
    return pingVerdictOf(res.data);
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    return status == null ? 'network' : { ok: false, reason: `HTTP_${status}` };
  }
}

let ensuring: Promise<PreflightResult> | null = null;
/**
 * الفحص المسبق للمقيَّد (preflightLive): متصل وقراءةٌ طازجة دقيقة ونقطةٌ يقبلها الخادم حيّةً — طلباتٌ متزامنة تنتظر الفحص نفسه.
 * يُنادى قبل كل طلبٍ يغيّر بياناً، وقبل بدء الزيارة والبصمة لأخذ القراءة الحيّة نفسها.
 */
export function ensureLive(): Promise<PreflightResult> {
  if (ensuring) return ensuring;
  ensuring = preflightLive({
    now: () => Date.now(),
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    freshFix: freshLiveFix,
    sendPing: sendLivePing,
  }).finally(() => { ensuring = null; });
  return ensuring;
}

repApi.interceptors.request.use(async config => {
  const token = localStorage.getItem('rep_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers[DEVICE_NOW_HEADER] = String(Date.now());
  // «اشتراط تفعيل الموقع» — قفل صفحة العميل: طلبٌ يغيّر بياناً على عميل (فاتورة/سند/زيارة/عميل/رابط دفع) من المقيَّد لا يُرسل إلا
  // وهو حيّ على الخريطة الآن. يُرسل نقطةً طازجة قبله فيمرّ حارس الخادم يقيناً؛ وإن لم يكن حيّاً لا يُرسل أصلاً. وما سواه يمرّ
  if (token && strictRepNow() && isLiveGuardedRequest(config.method, config.url)) {
    const r = await ensureLive();
    if (!r.ok) throw liveRefusalError(r.reason, config);
  }
  return config;
});

// عند انتهاء الجلسة (401) — نمسح بيانات المندوب ونعيده لشاشة الدخول.
//
// طبقتا حماية ضدّ الإخراج الكاذب (شكوى المناديب: خروج متكرّر يقطع التتبّع):
//
// (١) **النبضات الخلفية** (تتبّع/حضور) لا تُخرج المندوب إطلاقاً — تنطلق كل
//     دقيقة، فأي 401 عابر منها كان يقطع الجلسة بلا سبب حقيقي.
//
// (٢) **حتى الطلب الأمامي لا يُخرج إلا إذا انتهى التوكن فعلاً.** الخادم خلف
//     Cloudflare، ورُصد في سجلّاته 401 متفرّق ثم تتالٍ: فشل واحد كان يمسح
//     التوكن، فتُعاد الطلبات بلا توكن فتفشل كلّها ⇒ إخراج مؤكَّد من هيكوب
//     لحظي. الآن نفكّ التوكن محلياً: إن كان صالحاً غير منتهٍ فالـ401 عابر
//     ⇒ **نُبقي الجلسة ونترك النداء يفشل ويُعاد** لاحقاً؛ ولا نُخرج إلا إذا
//     انتهى التوكن أو غاب (جلسة انتهت فعلاً). هذا يكسر التتالي من جذره.
//
// (ويُستثنى طلب تسجيل الدخول نفسه ليُظهر رسالة الخطأ بدل إعادة التحميل.)
repApi.interceptors.response.use(
  r => { noteServer(true); return r; },
  async err => {
    // قفل صفحة العميل: طلبٌ رُدّ قبل إرساله يمضي كما هو — لم يلمس الخادم فلا يقول شيئاً عن الاتصال
    if (isLocalLiveRefusal(err)) return Promise.reject(err);
    const cfg = err.config as (typeof err.config & { _renewTried?: boolean }) | undefined;
    // «متصل» = آخر ذهابٍ وإياب نجح: ردٌّ بأي حالة نجاح، ولا ردّ (انقطاع/مهلة) فشل
    if (err.response) noteServer(true);
    else if (!axios.isCancel(err)) {
      noteServer(false);
      // المقيَّد: انقطاعٌ في طلبٍ على عميل لا يصير صفّاً دون اتصال في أي شاشة — يُردّ ردَّ القفل «لا اتصال» (يحمل response)
      if (strictRepNow() && isLiveGuardedRequest(cfg?.method, cfg?.url)) return Promise.reject(liveRefusalError('OFFLINE', cfg));
    }
    // الخادم ردّ القفل: الحاجز يظهر بسببه حتى تُقبل نقطةٌ جديدة، والتطبيق يجدّد قيود المندوب (قيدٌ فُعّل للتوّ)
    if (isLiveRefusal(err)) {
      notePing({ at: Date.now(), ok: false, reason: err.response?.data?.reason });
      emitLiveRefused();
    }
    const isLogin = (cfg?.url as string | undefined)?.includes('/auth/login');
    const isRenew = (cfg?.url as string | undefined)?.includes('/auth/renew');
    const isBackground = cfg?.background === true;

    if (err.response?.status !== 401 || isLogin || isRenew) return Promise.reject(err);
    if (!cfg || cfg._renewTried) return Promise.reject(err);
    cfg._renewTried = true; // لا حلقة: محاولة تجديد واحدة لكل طلب

    // (٣) الطبقة الثالثة: **الإنقاذ بالتجديد، والخادمُ هو من يقرّر**.
    //
    // كنّا نسأل أوّلاً «هل انتهى التوكن؟» بقراءة `exp` محلياً، ثم نُخرج. لكن
    // ذلك الحكم يقوم على **ساعة جهاز المندوب**، وهي تنحرف: ساعةٌ متأخّرة تجعل
    // توكناً منتهياً يبدو صالحاً ⇒ لا تجديد ولا إخراج، فيعلق التطبيق يردّ 401
    // بلا نهاية ولا رسالة — «جلسة زومبي» أسوأ من الإخراج.
    //
    // فلا نحكم محلياً أصلاً: **كل 401 يستحقّ محاولة تجديد واحدة**، والخادم
    // وحده يفصل. توكنٌ صالح يُجدَّد بلا ضرر، ومنتهٍ ضمن النافذة يُنقَذ،
    // والمرفوض وحده يُخرج.
    const fresh = await renewToken();

    if (fresh === null) {
      // رفضٌ نهائيّ (انتهت نافذة السماح أو عُطِّل الحساب) ⇒ إخراج.
      // والطلب الخلفيّ لا يُخرج أبداً — يبقى الحكم للطلب الأمامي.
      if (!isBackground) {
        // نمسح البيانات المرجعية أيضاً كي لا يرثها من يدخل بعده على الجهاز نفسه
        void refClear();
        localStorage.removeItem('rep_token');
        localStorage.removeItem('rep_user');
        if (window.location.pathname.startsWith('/rep')) window.location.href = '/rep';
      }
      return Promise.reject(err);
    }

    // نجح التجديد (أو تعذّرت الشبكة فأعاد الحاليّ): نعيد الطلب بالتوكن الراهن
    cfg.headers = { ...(cfg.headers || {}), Authorization: `Bearer ${fresh}` };
    return repApi.request(cfg);
  }
);

export default repApi;
