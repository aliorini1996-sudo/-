/**
 * إسناد الزائر — طرف أول بالكامل، بلا أي طرف ثالث ولا بصمة جهاز.
 *
 * ثلاث قيم فقط تُخزَّن محلياً:
 *  - `fs_anon`  هوية مجهولة ثابتة (١٨٠ يوماً) — لربط زيارات الشخص نفسه دون معرفته.
 *  - `fs_sess`  جلسة (٣٠ دقيقة خمول).
 *  - `fs_ft`    أول لمسة — **تُكتب مرّة واحدة ولا تُدهس أبداً**، فهي التي تنسب
 *               الفضل للقناة التي جلبت الزائر أوّلاً لا للتي أعادته.
 *
 * ممنوع هنا: أي بيانات شخصية · canvas/WebGL/قائمة خطوط · قراءة أي شيء من داخل
 * حسابات العملاء. واحترام إشارة الرفض (DNT / Sec-GPC) شرط لا خيار.
 */

const ANON_KEY = 'fs_anon';
const SESS_KEY = 'fs_sess';
const FT_KEY = 'fs_ft';
const OPTOUT_KEY = 'fs_optout';
const SESSION_MS = 30 * 60 * 1000;

export interface FirstTouch { source?: string; medium?: string; landing?: string; at?: number }

/** هل رفض الزائر التتبّع (إشارة متصفّح أو اختياره الصريح)؟ */
export function isOptedOut(): boolean {
  try {
    if (localStorage.getItem(OPTOUT_KEY) === '1') return true;
    const n = navigator as Navigator & { doNotTrack?: string; globalPrivacyControl?: boolean };
    if (n.globalPrivacyControl === true) return true;
    if (n.doNotTrack === '1' || (window as unknown as { doNotTrack?: string }).doNotTrack === '1') return true;
  } catch { /* تخزين محجوب ⇒ لا تتبّع */ return true; }
  return false;
}

/** يوقف التتبّع نهائياً على هذا المتصفّح (يُستدعى من رابط «إيقاف التتبّع») */
export function optOut(): void {
  try {
    localStorage.setItem(OPTOUT_KEY, '1');
    [ANON_KEY, SESS_KEY, FT_KEY].forEach((k) => localStorage.removeItem(k));
  } catch { /* تجاهل */ }
}

const rand = (): string => {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  } catch { /* بديل */ }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
};

function readJson<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
}

/** هوية مجهولة ثابتة — تُنشأ مرّة */
export function anonId(): string | null {
  if (isOptedOut()) return null;
  try {
    let v = localStorage.getItem(ANON_KEY);
    if (!v) { v = 'a_' + rand(); localStorage.setItem(ANON_KEY, v); }
    return v;
  } catch { return null; }
}

/** جلسة تنتهي بـ٣٠ دقيقة خمول */
export function sessionId(): string | null {
  if (isOptedOut()) return null;
  try {
    const cur = readJson<{ id: string; at: number }>(SESS_KEY);
    const now = Date.now();
    if (cur && now - cur.at < SESSION_MS) {
      localStorage.setItem(SESS_KEY, JSON.stringify({ id: cur.id, at: now }));
      return cur.id;
    }
    const id = 's_' + rand();
    localStorage.setItem(SESS_KEY, JSON.stringify({ id, at: now }));
    return id;
  } catch { return null; }
}

/** وسوم الحملة من الرابط الحالي (تُرسل خاماً ويُطبّعها الخادم) */
export function readUtm(search = window.location.search): Record<string, string> {
  const q = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content', 'term'] as const) {
    const v = q.get('utm_' + k);
    if (v) out[k] = v.slice(0, 96);
  }
  return out;
}

/**
 * أول لمسة: تُثبَّت عند أول زيارة تحمل وسوماً أو مُحيلاً خارجياً، ثم **لا تُدهس**.
 * لولا ذلك لنُسب كل عميل إلى آخر قناة لمسها (غالباً «مباشر») وضاع فضل القناة الجالبة.
 */
export function firstTouch(): FirstTouch | null {
  if (isOptedOut()) return null;
  try {
    const existing = readJson<FirstTouch>(FT_KEY);
    if (existing) return existing;

    const utm = readUtm();
    let refHost = '';
    try { refHost = document.referrer ? new URL(document.referrer).hostname : ''; } catch { /* تجاهل */ }
    const external = refHost && !/(^|\.)fieldsa\.net$/.test(refHost);
    if (!utm.source && !external) return null; // زيارة مباشرة أولى: لا نثبّت شيئاً

    const ft: FirstTouch = {
      source: utm.source || refHost || undefined,
      medium: utm.medium || (external ? 'referral' : undefined),
      landing: window.location.pathname.slice(0, 180),
      at: Date.now(),
    };
    localStorage.setItem(FT_KEY, JSON.stringify(ft));
    return ft;
  } catch { return null; }
}

/** الحمولة الكاملة المرفقة بكل تسجيل زيارة */
export function attributionPayload() {
  if (isOptedOut()) return {};
  return {
    anonId: anonId() || undefined,
    sessionId: sessionId() || undefined,
    utm: readUtm(),
    first: firstTouch() || undefined,
  };
}
