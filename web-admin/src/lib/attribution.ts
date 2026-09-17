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

/**
 * ما قد يضعه وسم Google Ads على نطاقنا (سياسة الخصوصية، القسمان ٧ و١٥).
 *
 * بادئات لا قائمة ثابتة: كانت القائمة أربعة أسماء (`_gcl_au` · `_gcl_aw` · `_gcl_gb` ·
 * `_gcl_dc`)، وGoogle تكتب بالبادئة نفسها أسماء أخرى (`_gcl_gs` · `_gcl_ag` · `_gcl_ls`
 * في التخزين المحلي …) فكانت تبقى بعد «إيقاف القياس» رغم وعد السياسة بحذف ما وضعه الوسم.
 * `FPGCLAW` · `FPGCLGB` · `FPLC`: نظائرها من طرف أول حين يمرّ الوسم عبر خادم وسوم.
 */
const GOOGLE_ADS_PREFIXES = ['_gcl_', '_gac_'];
const GOOGLE_ADS_NAMES = ['_gcl_au', '_gcl_aw', '_gcl_gb', '_gcl_dc', 'FPGCLAW', 'FPGCLGB', 'FPLC'];

/** هل الاسم (كوكي أو مفتاح تخزين) ممّا يضعه وسم Google Ads؟ */
export function isGoogleAdsStorageName(name: string): boolean {
  return GOOGLE_ADS_NAMES.includes(name) || GOOGLE_ADS_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * طلبات القياس الإعلاني: نطاقات وسم Google ومسارات التحويل على www.google.com.
 * ⚠️ القاعدة نفسها في `public/sw.js` (عامل الخدمة لا يستورد وحدات TS) —
 * و`adsTracking.test.ts` يشغّل عامل الخدمة ويفرض أن يتطابق الطرفان.
 */
const AD_MEASUREMENT_HOST = /(^|\.)(googletagmanager\.com|googleadservices\.com|doubleclick\.net|google-analytics\.com)$/i;

export function isAdMeasurementUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (AD_MEASUREMENT_HOST.test(u.hostname)) return true;
    return u.hostname === 'www.google.com' && /^\/(pagead|ccm|rmkt)/.test(u.pathname);
  } catch { return false; }
}

/** النطاق الحالي وكل نطاق أب له (`www.fieldsa.net` ⇒ نفسه ثم `fieldsa.net`) */
function cookieDomains(host: string): string[] {
  const labels = host.split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

/** يحذف مفاتيح Google Ads من مخزن ويب (المفاتيح تُجمع أولاً: الحذف أثناء العدّ يُزيح الفهارس) */
function purgeGoogleAdsKeys(store: Storage | undefined): void {
  if (!store || typeof store.key !== 'function') return;
  const doomed: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && isGoogleAdsStorageName(k)) doomed.push(k);
  }
  doomed.forEach((k) => store.removeItem(k));
}

/**
 * يحذف من Cache Storage طلبات القياس الإعلاني التي خزّنها عامل الخدمة قبل أن يتوقّف
 * عن تخزينها — روابطها تحمل رابط الهبوط وفيه معرّف النقر. `caches` غير متاحة في
 * سياق غير آمن وبعض أوضاع الخصوصية، فكل شيء داخل try/catch.
 */
async function purgeAdMeasurementCaches(): Promise<void> {
  try {
    const cs = (globalThis as { caches?: CacheStorage }).caches;
    if (!cs) return;
    for (const name of await cs.keys()) {
      const cache = await cs.open(name);
      for (const req of await cache.keys()) {
        if (isAdMeasurementUrl(req.url)) await cache.delete(req);
      }
    }
  } catch { /* Cache Storage غير متاحة */ }
}

/**
 * يوقف القياس على هذا المتصفّح (زرّ «إيقاف القياس» في صفحة سياسة الخصوصية).
 *
 * يحذف: معرّفاتنا (`fs_anon` · `fs_sess` · `fs_ft`)، وكل كوكي أو مفتاح تخزين يضعه وسم
 * Google Ads (على المسار `/` وعلى النطاق الحالي ونطاقاته الأب)، وطلبات القياس الإعلاني
 * المخزّنة في Cache Storage. لا يحذف علامة الإيقاف نفسها ولا رمز إحالة السفير (السياسة
 * تستثنيه). والوسم لا يُحمَّل بعدها لأن `adsEnabled()` تقرأ العلَم.
 *
 * يعيد وعداً يكتمل بعد تنظيف Cache Storage (أو مهلة قصيرة) — انتظره قبل إعادة تحميل
 * الصفحة، وإلا قطعت إعادةُ التحميل الحذفَ غير المتزامن.
 */
export function optOut(): Promise<void> {
  try {
    localStorage.setItem(OPTOUT_KEY, '1');
    [ANON_KEY, SESS_KEY, FT_KEY].forEach((k) => localStorage.removeItem(k));
  } catch { /* تجاهل */ }
  try { purgeGoogleAdsKeys(localStorage); } catch { /* تخزين محجوب */ }
  try { purgeGoogleAdsKeys(sessionStorage); } catch { /* تخزين محجوب */ }
  landingUtm = null;
  try {
    const names = new Set(GOOGLE_ADS_NAMES);
    for (const part of String(document.cookie || '').split(';')) {
      const name = part.split('=')[0].trim();
      if (name && isGoogleAdsStorageName(name)) names.add(name);
    }
    // بلا domain = كوكي النطاق الحالي وحده؛ ثم كل نطاق أب (الوسم يكتب على أعلى نطاق ممكن)
    const domains = ['', ...cookieDomains(window.location.hostname)];
    for (const name of names) {
      for (const d of domains) {
        document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? `; domain=.${d}` : ''}`;
      }
    }
  } catch { /* لا DOM */ }
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => { if (timer !== undefined) clearTimeout(timer); resolve(); };
    try { timer = setTimeout(done, 1500); } catch { /* بلا مؤقّت */ }
    purgeAdMeasurementCaches().then(done, done);
  });
}

/** يُلغي إيقافاً صريحاً سابقاً (لا يتجاوز إشارتَي DNT وGPC في المتصفّح) */
export function optIn(): void {
  try { localStorage.removeItem(OPTOUT_KEY); } catch { /* تجاهل */ }
}

/** هل الإيقاف صريح من الزائر نفسه (لا من إشارة المتصفّح)؟ — لعرض زرّ الاستئناف */
export function isExplicitOptOut(): boolean {
  try { return localStorage.getItem(OPTOUT_KEY) === '1'; } catch { return false; }
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

/**
 * أدلة نقرة إعلان جوجل في رابط الهبوط: معرّفات الوسم التلقائي (`gclid` · `gbraid` · `wbraid`)
 * ومعاملا Google Ads (`gad_source` · `gad_campaignid`). الأخيران يصلان حتى حين يغيب
 * `gclid` (يحذفه Safari في التصفّح الخاص، أو يُطفأ الوسم التلقائي) — وبدونهما تُصنَّف النقرة
 * «بحثاً عضوياً». الترتيب أولوية: يُرسل أوّل ما يوجد. الخادم يعرف الأسماء نفسها حرفياً.
 */
const PAID_CLICK_IDS = ['gclid', 'gbraid', 'wbraid', 'gad_source', 'gad_campaignid'] as const;

/** وسوم الحملة من الرابط الحالي (تُرسل خاماً ويُطبّعها الخادم) */
export function readUtm(search = window.location.search): Record<string, string> {
  const q = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content', 'term'] as const) {
    const v = q.get('utm_' + k);
    if (v) out[k] = v.slice(0, 96);
  }
  // نقرة إعلان جوجل بلا وسوم UTM تصل بمُحيل google.com فيصنّفها الخادم «بحثاً عضوياً».
  // نُرسل **نوع** المعرّف وحده لا قيمته: الخادم يحتاج أن يعرف أن الزيارة مدفوعة،
  // ولا حاجة لتخزين معرّف جوجل في قاعدتنا.
  const click = PAID_CLICK_IDS.find((k) => q.get(k));
  if (click) out.clickId = click;
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
    const paidClick = Boolean(utm.clickId); // نقرة إعلان جوجل (قد تصل بلا مُحيل ولا وسوم)
    if (!utm.source && !external && !paidClick) return null; // زيارة مباشرة أولى: لا نثبّت شيئاً

    const ft: FirstTouch = {
      source: utm.source || (paidClick ? 'google' : refHost) || undefined,
      // نقرة مدفوعة لا تُسجَّل «إحالة» من google.com — وإلا نُسب فضل الإعلان للبحث العضوي
      medium: utm.medium || (paidClick ? 'cpc' : external ? 'referral' : undefined),
      landing: window.location.pathname.slice(0, 180),
      at: Date.now(),
    };
    localStorage.setItem(FT_KEY, JSON.stringify(ft));
    return ft;
  } catch { return null; }
}

let landingUtm: Record<string, string> | null = null;

/**
 * وسوم الهبوط تبقى لكل صفحات التحميل الواحد.
 *
 * `document.referrer` لا يتغيّر مع التنقّل الداخلي، أمّا الوسوم فتختفي من الرابط بأول
 * نقرة. فكانت الصفحة الثانية لزائر إعلان (`?gclid=…` بمُحيل google.com) تصل للخادم
 * بمُحيل جوجل وبلا وسوم ⇒ «بحث عضوي». نُبقي وسوم الهبوط مع مُحيلها حتى يتغيّرا معاً.
 */
function landingTags(): Record<string, string> {
  const cur = readUtm();
  if (Object.keys(cur).length) { landingUtm = cur; return cur; }
  return landingUtm || cur;
}

/**
 * الحمولة الكاملة المرفقة بكل تسجيل زيارة.
 * عند الرفض تُرسل العلَم وحده: الإيقاف من الزرّ أو من تخزين محجوب لا يظهر في ترويسات
 * الطلب، والخادم يحتاجه كي لا يشتقّ بصمة IP ولا يرسل العنوان لخدمة تحديد الموقع.
 */
export function attributionPayload(): { optOut?: true; anonId?: string; sessionId?: string; utm?: Record<string, string>; first?: FirstTouch } {
  if (isOptedOut()) return { optOut: true };
  return {
    anonId: anonId() || undefined,
    sessionId: sessionId() || undefined,
    utm: landingTags(),
    first: firstTouch() || undefined,
  };
}
