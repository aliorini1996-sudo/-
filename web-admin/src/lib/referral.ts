/**
 * ملتقط رمز الإحالة — برنامج «سفير فيلد سيلز» (docs/affiliate/CONTRACT.md §3).
 *
 * الرابط `https://fieldsa.net/?ref=CODE` (أو أي صفحة عامة). يُكتب الرمز في
 * `localStorage.fs_ref` بصيغة `{code, at, via:'link'}` — **آخر نقرة تكسب** —
 * ويُقرأ في صفحة التسجيل ما دام داخل نافذة الإسناد.
 *
 * نافذة الإسناد يفرضها **الخادم** وحده بلحظة الالتقاط `refAt` المُرسلة مع التسجيل —
 * ولكل سفيرٍ نافذته من الشروط التي قبلها (1..365 يوماً)، فلا تعرفها الواجهة. لذا
 * يحتفظ المتصفّح بالرمز حتى السقف الأعلى (365) ولا يُسقطه قبله.
 *
 * ⚠️ هذا المفتاح **تعاقديّ** لا تحليليّ: عمولة سفيرٍ تتوقّف عليه، فلا يخضع
 *    لإشارة رفض التتبّع (`fs_optout`/DNT) كما تخضع طبقة `attribution.ts`.
 *    لا يحمل بيانات شخصية: رمزٌ ولحظةٌ ومصدرٌ فقط.
 *
 * كل وصولٍ إلى التخزين داخل try/catch: متصفّحٌ يحجب التخزين (أو بيئة node في
 * الاختبار) لا يجوز أن يُسقط الصفحة، ورمزٌ مفقودٌ لا يُفشل تسجيل شركة أبداً.
 */

export const REF_KEY = 'fs_ref';
/** مفتاح الجلسة الذي يمنع عدّ النقرة نفسها مرّتين (تحديث الصفحة، التنقّل) */
export const REF_CLICK_KEY = 'fs_ref_clicked';
/** مدّة احتفاظ المتصفّح بالرمز = أقصى نافذة يستطيع المالك ضبطها */
export const REF_RETENTION_DAYS = 365;

export type RefVia = 'link' | 'typed';
/** `at` لحظة الالتقاط (epoch ms) — تُرسل مع التسجيل `refAt` ليفرض الخادم النافذة */
export interface StoredRef { code: string; via: RefVia; at: number }

/**
 * أبجدية الرمز بلا الأحرف المتشابهة (لا 0/O ولا 1/I/L) — مطابقة لـ
 * `backend/src/services/affiliate/rules.ts` حرفياً.
 */
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const DAY_MS = 86_400_000;

/**
 * يطبّع رمزاً من مدخلٍ حرّ كما يفعل `parseRef` في الخادم: NFKC، ثم حذف
 * المسافات و`-_.`، ثم أحرف كبيرة. ما لا يطابق الصيغة ⇒ `null`.
 * لا تصحيح تخمينيّ (O ⇒ 0): رمزٌ مُصحَّحٌ خطأً يمنح عمولةً لسفيرٍ آخر.
 */
export function normalizeRef(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFKC').replace(/[\s\-_.]/g, '').toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

// ---- تخزين آمن ----
function local(): Storage | null {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}
function session(): Storage | null {
  try { return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null; } catch { return null; }
}

/**
 * احتياطيّ في الذاكرة لحارس «مرّة لكل جلسة» حين يُحجب sessionStorage —
 * بدونه يُعدّ كل تنقّلٍ داخل التطبيق نقرةً جديدة.
 */
const clickedInMemory = new Set<string>();

/** للاختبارات فقط: يفرغ الحارس الداخليّ بين الحالات */
export function __resetReferralMemoryForTests(): void { clickedInMemory.clear(); }

/** أصل الـAPI — نفس تعبير `api/client.ts`، ويُقرأ داخل الدالّة لأن `import.meta.env` لا يوجد في node */
function apiBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const root = env?.VITE_API_URL;
  return root ? `${root.replace(/\/+$/, '')}/api` : '/api';
}

function alreadyCounted(code: string): boolean {
  if (clickedInMemory.has(code)) return true;
  try {
    const raw = session()?.getItem(REF_CLICK_KEY);
    if (!raw) return false;
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.includes(code);
  } catch { return false; }
}

function markCounted(code: string): void {
  clickedInMemory.add(code);
  try {
    const s = session();
    if (!s) return;
    let list: unknown = [];
    try { list = JSON.parse(s.getItem(REF_CLICK_KEY) || '[]'); } catch { list = []; }
    const arr = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    if (!arr.includes(code)) arr.push(code);
    s.setItem(REF_CLICK_KEY, JSON.stringify(arr.slice(-20)));
  } catch { /* تخزين محجوب — يكفي حارس الذاكرة */ }
}

/** يرسل نقرةً لعدّاد السفير — بلا انتظار ولا أثر لأي فشل */
function sendClick(code: string): void {
  try {
    const f = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof f !== 'function') return;
    const url = `${apiBase()}/affiliate/click`;
    const p = f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      // keepalive للأصل نفسه فقط: طلب JSON عابر للأصل (api.fieldsa.net) يستلزم preflight،
      // وبعض إصدارات المتصفّحات ترفض preflight مع keepalive فتضيع النقرة صامتة.
      // والصفحة تبقى مفتوحة بعد الالتقاط أصلاً فلا حاجة له هناك.
      keepalive: url.startsWith('/'),
    });
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => { /* تجاهل */ });
  } catch { /* تجاهل */ }
}

/**
 * قراءة نقيّة لرمزٍ صالح من `?ref=` — بلا تخزين ولا شبكة.
 * تحتاجها صفحة التسجيل حين تُفتح مباشرةً بـ`/signup?ref=`: قيمتها الأولى تُحسب
 * أثناء الرسم، قبل أن يكتب تأثير الالتقاط في App.tsx الرمزَ في التخزين.
 */
export function refFromSearch(search?: string): string | null {
  let q = search;
  if (q === undefined) {
    try { q = (globalThis as { location?: Location }).location?.search ?? ''; } catch { q = ''; }
  }
  try { return normalizeRef(new URLSearchParams(q || '').get('ref')); } catch { return null; }
}

/**
 * يلتقط `?ref=` من سلسلة الاستعلام. رمزٌ غير صالح يُهمَل بصمت ولا يمسّ رمزاً
 * محفوظاً سابقاً. رمزٌ صالح يُكتب فوق القديم (آخر نقرة تكسب)، وتُرسل نقرةٌ
 * واحدة لكل رمز في الجلسة. يُعيد الرمز المُلتقَط أو `null`.
 */
export function captureRefFromUrl(search?: string): string | null {
  const code = refFromSearch(search);
  if (!code) return null;

  try {
    local()?.setItem(REF_KEY, JSON.stringify({ code, at: Date.now(), via: 'link' }));
  } catch { /* تخزين محجوب — النقرة تُعدّ رغم ذلك */ }

  if (!alreadyCounted(code)) {
    markCounted(code);
    sendClick(code);
  }
  return code;
}

/**
 * الرمز المحفوظ إن كان صالحاً وداخل النافذة، وإلا `null` — والتالف أو المنتهي
 * يُحذف فوراً حتى لا يُقرأ مرّةً أخرى.
 */
export function readRef(windowDays: number = REF_RETENTION_DAYS): StoredRef | null {
  let raw: string | null = null;
  try { raw = local()?.getItem(REF_KEY) ?? null; } catch { return null; }
  if (!raw) return null;

  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const obj = parsed && typeof parsed === 'object' ? parsed as { code?: unknown; at?: unknown; via?: unknown } : null;
  const code = obj ? normalizeRef(obj.code) : null;
  const at = obj && typeof obj.at === 'number' && Number.isFinite(obj.at) ? obj.at : NaN;
  const now = Date.now();
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : REF_RETENTION_DAYS;

  const valid = !!code && code === obj?.code
    && Number.isFinite(at)
    && at <= now + DAY_MS            // لحظةٌ في المستقبل = قيمة مزوّرة أو ساعة عابثة
    && isRefWithinWindow(at, days, now);
  if (!valid) { clearRef(); return null; }

  return { code: code!, via: obj!.via === 'typed' ? 'typed' : 'link', at };
}

/** هل لحظة الالتقاط `at` داخل نافذة `windowDays` يوماً من `now`؟ (نافذة غير صالحة ⇒ تُقبل: الخادم يحكم) */
export function isRefWithinWindow(at: number, windowDays: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(at)) return false;
  if (!Number.isFinite(windowDays) || windowDays <= 0) return true;
  return now - at <= windowDays * DAY_MS;
}

/** يحذف الرمز المحفوظ (بعد تسجيلٍ ناجح، أو حين يزيله الزائر) */
export function clearRef(): void {
  try { local()?.removeItem(REF_KEY); } catch { /* تجاهل */ }
}
