// إثراء بيانات التواصل من موقع الشركة: زيارة الصفحة الرئيسية وصفحات «اتصل بنا»
// واستخراج البريد/الهاتف منها.
//
// لماذا كل هذا الحرص؟ لأنّ العنوان هنا يأتي من مصدر خارجيّ (نتائج الصيد)، فالطلب
// الصادر من خادمنا يمكن توجيهه نحو شبكتنا الداخلية أو نحو ميتاداتا مزوّد السحابة.
// لذلك كل جلب يمرّ عبر حارس SSRF كامل: فحص المخطّط والمنفذ، حلّ DNS ورفض أي عنوان
// داخليّ، ثمّ إعادة الفحص عند كل قفزة إعادة توجيه (redirect: 'manual').
//
// ملفّ مكتفٍ بذاته عمداً: الحارس جزء من عقد الأمان لهذه الوحدة، وفصله في وحدة عامّة
// يغري باستعماله ناقصاً أو تعديله من خارج سياق الصيد.

import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** ترويسة تعريف صريحة — بعض المواقع تحجب الطلبات مجهولة الهوية. */
const USER_AGENT = 'FieldSalesLeadHunter/1.0 (+https://fieldsa.net)';

/** حدود الجلب: 500KB و8 ثوانٍ — تكفي لصفحة تواصل وتمنع استنزاف الخادم. */
const MAX_BYTES = 500_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 4;

// ─────────────────────────── حارس SSRF ───────────────────────────

/** يحوّل IPv4 نصّياً إلى عدد 32-بت غير موقّع، أو null إن كان غير صالح. */
function ipv4ToInt(ip: string): number | null {
  const parts: number[] = ip.split('.').map((p: string): number => Number(p));
  if (parts.length !== 4) return null;
  if (parts.some((n: number): boolean => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  // الإزاحة في JS تعمل على أعداد موقّعة 32-بت، لذا نُعيدها غير موقّعة بـ>>> 0.
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

/** نطاق محجوز: أساسه (غير موقّع) وقناعه. */
interface V4Block {
  base: number;
  mask: number;
}

/**
 * نطاقات IPv4 الخاصّة/المحجوزة. الأهمّ أمنياً: 127/8 (محليّ)، 10/8 و172.16/12
 * و192.168/16 (شبكات خاصّة)، 169.254/16 (ميتاداتا السحابة: 169.254.169.254)،
 * 0/8، و100.64/10 (CGNAT).
 */
const V4_BLOCKS: readonly V4Block[] = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
    ['255.255.255.255', 32],
  ] as ReadonlyArray<readonly [string, number]>
).map(([ip, bits]: readonly [string, number]): V4Block => {
  const raw: number | null = ipv4ToInt(ip);
  const base: number = raw === null ? 0 : raw;
  const mask: number = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  // خزّن الأساس غير موقّع (>>> 0) ليطابق نتيجة الفحص تماماً.
  // هذا ليس تجميلاً: أي عنوان بايته الأول ≥ 128 (مثل 169.254.x و192.168.x و255.x)
  // ينتج عن (n & mask) عدداً سالباً بلا التحويل، فتفشل المقارنة ويمرّ العنوان الداخليّ.
  return { base: (base & mask) >>> 0, mask };
});

function isPrivateV4(ip: string): boolean {
  const n: number | null = ipv4ToInt(ip);
  if (n === null) return true; // غير صالح ⇒ ارفض احتياطاً
  return V4_BLOCKS.some((b: V4Block): boolean => ((n & b.mask) >>> 0) === b.base);
}

function isPrivateV6(ip: string): boolean {
  const a: string = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::1' || a === '::') return true;
  // fc00::/7 (ULA) تغطّي fc وfd، وfe80::/10 (link-local) تغطّي fe8..feb.
  if (/^fe[89ab]/.test(a) || a.startsWith('fc') || a.startsWith('fd')) return true;
  if (a.startsWith('ff')) return true; // multicast
  // العناوين المربوطة ::ffff:a.b.c.d تلتفّ على فحص IPv4 إن لم تُفكّ.
  const mapped: RegExpMatchArray | null = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  // الصيغة السداسية للعناوين المربوطة (::ffff:7f00:1) تُفكّ أيضاً.
  const mappedHex: RegExpMatchArray | null = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi: number = parseInt(mappedHex[1], 16);
    const lo: number = parseInt(mappedHex[2], 16);
    const n: number = (((hi << 16) >>> 0) + lo) >>> 0;
    return V4_BLOCKS.some((b: V4Block): boolean => ((n & b.mask) >>> 0) === b.base);
  }
  return false;
}

/** هل هذا العنوان (IPv4 أو IPv6) داخليّ/محجوز؟ */
export function isPrivateIp(ip: string): boolean {
  return net.isIPv6(ip) ? isPrivateV6(ip) : isPrivateV4(ip);
}

/** نتيجة فحص أمنيّ: مسموح، أو ممنوع مع سبب عربيّ صالح للسجلّ. */
export interface SafetyCheck {
  ok: boolean;
  reason?: string;
}

/**
 * يتحقّق أن المضيف عامّ فعلاً: يرفض الأسماء الداخلية، ثمّ يحلّ DNS ويرفض إن كان
 * *أيّ* عنوان مُحلَّل داخلياً (لا يكفي أوّل عنوان — رِبط DNS يعتمد على تعدّد السجلّات).
 */
async function assertPublicHost(hostname: string): Promise<SafetyCheck> {
  if (!hostname) return { ok: false, reason: 'مضيف فارغ' };
  const h: string = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.internal') ||
    h.endsWith('.local') ||
    h.endsWith('.localdomain')
  ) {
    return { ok: false, reason: `مضيف داخلي: ${h}` };
  }
  // عنوان IP مباشر: لا داعي لحلّ DNS.
  if (net.isIP(h) !== 0) {
    return isPrivateIp(h) ? { ok: false, reason: `IP داخلي: ${h}` } : { ok: true };
  }
  try {
    const addrs: Array<{ address: string; family: number }> = await lookup(h, { all: true });
    if (!addrs.length) return { ok: false, reason: `تعذّر حلّ ${h}` };
    for (const { address } of addrs) {
      if (isPrivateIp(address)) {
        return { ok: false, reason: `${h} يُحلّ لعنوان داخلي ${address}` };
      }
    }
    return { ok: true };
  } catch (err: unknown) {
    const code: string =
      (err as NodeJS.ErrnoException | undefined)?.code || (err as Error | undefined)?.message || 'خطأ';
    return { ok: false, reason: `فشل DNS لـ${h}: ${code}` };
  }
}

/**
 * فحص عنوان URL كامل: مخطّط http/https فقط، منفذ 80/443 فقط، ومضيف عامّ.
 * مُصدَّر لأن الاختبارات تتحقّق من الحجب مباشرةً دون شبكة خارجية.
 */
export async function assertSafeUrl(raw: string): Promise<SafetyCheck> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'عنوان غير صالح' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // file: وgopher: وdict: أدوات كلاسيكية لتسريب الملفات عبر SSRF.
    return { ok: false, reason: `مخطط ممنوع: ${u.protocol}` };
  }
  // منافذ غير 80/443 تعني غالباً خدمة داخلية (Redis 6379، Postgres 5432…).
  const port: string = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port !== '80' && port !== '443') {
    return { ok: false, reason: `منفذ ممنوع: ${port}` };
  }
  return assertPublicHost(u.hostname);
}

// ─────────────────────────── جلب آمن ───────────────────────────

interface FetchResult {
  html: string | null;
  blocked: string | null;
}

interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * جلب نصّ آمن ضد SSRF. المفتاح هنا `redirect: 'manual'`: لو تركنا fetch يتبع
 * التحويلات تلقائياً لَكفى للمهاجم أن يردّ 302 نحو 169.254.169.254 بعد أن نجح
 * الفحص الأول. لذلك نفحص كل قفزة على حدة، بحدّ أقصى MAX_REDIRECTS.
 */
async function fetchTextSafe(startUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const timeoutMs: number = opts.timeoutMs ?? TIMEOUT_MS;
  const maxBytes: number = opts.maxBytes ?? MAX_BYTES;
  const maxRedirects: number = opts.maxRedirects ?? MAX_REDIRECTS;

  let url: string = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check: SafetyCheck = await assertSafeUrl(url);
    if (!check.ok) return { html: null, blocked: check.reason ?? 'محجوب' };

    const ctrl: AbortController = new AbortController();
    const timer: NodeJS.Timeout = setTimeout((): void => ctrl.abort(), timeoutMs);
    try {
      const res: Response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain' },
        redirect: 'manual',
        signal: ctrl.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const loc: string | null = res.headers.get('location');
        if (!loc) return { html: null, blocked: 'إعادة توجيه بلا وجهة' };
        url = new URL(loc, url).toString(); // نسبيّ أو مطلق — والفحص يعيد نفسه أعلاه
        continue;
      }
      if (!res.ok) return { html: null, blocked: `HTTP ${res.status}` };

      const ct: string = res.headers.get('content-type') || '';
      if (!ct.includes('text/html') && !ct.includes('text/plain')) {
        return { html: null, blocked: `نوع غير مدعوم: ${ct.split(';')[0]}` };
      }
      const buf: ArrayBuffer = await res.arrayBuffer();
      // نقصّ البايتات قبل فكّ الترميز حتى لا نُنشئ نصّاً ضخماً في الذاكرة أصلاً.
      const text: string = Buffer.from(buf.slice(0, maxBytes)).toString('utf8');
      return { html: text, blocked: null };
    } catch (err: unknown) {
      const e = err as (Error & { code?: string }) | undefined;
      const reason: string = e?.name === 'AbortError' ? 'مهلة' : e?.code || e?.message || 'فشل الجلب';
      return { html: null, blocked: reason };
    } finally {
      clearTimeout(timer);
    }
  }
  return { html: null, blocked: 'تجاوز حدّ إعادة التوجيه' };
}

// ─────────────────────────── استخراج التواصل ───────────────────────────

/** عناوين تظهر في قوالب المواقع والمكتبات لا في بيانات الشركة الحقيقية. */
const EMAIL_BLOCK: readonly string[] = [
  'sentry',
  'wixpress',
  'example.',
  'yourdomain',
  'domain.com',
  'email.com',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '@2x',
  'schema.org',
  'w3.org',
  'godaddy',
  'wix.com',
  'squarespace',
  'cloudflare',
  'gstatic',
  'googleapis',
  'jquery',
];

/**
 * نمط بريد **خطّي غير غامض**: لا تداخل بين مجموعات التكرار، فلا يوجد تراجع أُسّي.
 * (النمط الغامض كان يجعل صفحة معادية بمليون حرف تُعلّق العملية — ReDoS.)
 */
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const EMAIL_FULL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

function cleanEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
}

function goodEmail(email: string): boolean {
  if (!EMAIL_FULL_RE.test(email)) return false;
  return !EMAIL_BLOCK.some((bad: string): boolean => email.includes(bad));
}

interface Contacts {
  email?: string;
  phone?: string;
}

function extractContacts(html: string, domain: string): Contacts {
  const emails = new Set<string>();
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) emails.add(cleanEmail(m[1]));
  for (const m of html.matchAll(EMAIL_RE)) emails.add(cleanEmail(m[0]));

  // بريد على نطاق الشركة نفسه أوثق من بريد جيميل مذكور عرضاً في الصفحة.
  const valid: string[] = Array.from(emails).filter(goodEmail);
  valid.sort(
    (a: string, b: string): number =>
      Number(b.endsWith('@' + domain)) - Number(a.endsWith('@' + domain)),
  );

  let phone: string | undefined;
  const tel: RegExpMatchArray | null = html.match(/tel:\+?([\d\s().-]{7,}\d)/i);
  if (tel) {
    phone = '+' + tel[1].replace(/[^\d]/g, '');
  } else {
    const plain: RegExpMatchArray | null = html.match(/\+\d[\d\s().-]{7,}\d/);
    if (plain) phone = plain[0].replace(/[^\d+]/g, '');
  }

  return { email: valid[0], phone };
}

// ─────────────────────────── robots.txt ───────────────────────────

/** تخزين مؤقّت لكل نطاق: robots.txt واحد يخدم كل مسارات النطاق في الجولة. */
const robotsCache = new Map<string, string[]>();

function parseRobots(txt: string): string[] {
  const disallow: string[] = [];
  let applies = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line: string = rawLine.split('#')[0].trim();
    if (!line) continue;
    const idx: number = line.indexOf(':');
    if (idx === -1) continue;
    const key: string = line.slice(0, idx).trim().toLowerCase();
    const val: string = line.slice(idx + 1).trim();
    if (key === 'user-agent') applies = val === '*';
    else if (applies && key === 'disallow' && val) disallow.push(val);
  }
  return disallow;
}

function checkRobots(disallow: readonly string[], path: string): boolean {
  return !disallow.some((rule: string): boolean => path.startsWith(rule));
}

async function allowedByRobots(domain: string, path: string): Promise<boolean> {
  const cached: string[] | undefined = robotsCache.get(domain);
  if (cached) return checkRobots(cached, path);
  const { html } = await fetchTextSafe(`https://${domain}/robots.txt`, {
    timeoutMs: 5_000,
    maxBytes: 20_000,
  });
  const rules: string[] = parseRobots(html || '');
  robotsCache.set(domain, rules);
  return checkRobots(rules, path);
}

// ─────────────────────────── الواجهة ───────────────────────────

/** يستخرج النطاق (بلا www) من عنوان موقع قد يأتي بلا مخطّط. */
function domainOf(website: string): string {
  if (!website) return '';
  const raw: string = String(website).trim();
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./, '').split('/')[0].toLowerCase();
  }
}

/** مسارات التواصل الشائعة عربياً وإنجليزياً — نتوقّف فور اكتمال البريد والهاتف. */
const CONTACT_PATHS: readonly string[] = [
  '/',
  '/contact',
  '/contact-us',
  '/about',
  '/اتصل-بنا',
  '/تواصل-معنا',
];

/**
 * يزور موقع الشركة ويعيد ما وجده من بريد/هاتف. لا يرمي أبداً: الإثراء مساعِد،
 * وفشل موقع واحد يجب ألّا يُسقط جولة صيد كاملة — الحقول ترجع فارغة فحسب.
 */
export async function enrichFromWebsite(
  website: string,
  opts: { respectRobots?: boolean } = {},
): Promise<{ email?: string; phone?: string }> {
  const respectRobots: boolean = opts.respectRobots ?? true;

  const domain: string = domainOf(website);
  if (!domain) return {};

  // فحص مبكر للمضيف: لا فائدة من المرور على ستة مسارات لعنوان داخليّ.
  const pub: SafetyCheck = await assertPublicHost(domain);
  if (!pub.ok) return {};

  const found: { email?: string; phone?: string } = {};
  for (const path of CONTACT_PATHS) {
    if (found.email && found.phone) break;
    if (respectRobots && path !== '/') {
      // تعذّر قراءة robots ⇒ نعتبره سماحاً (السلوك المعتاد للزواحف).
      const allowed: boolean = await allowedByRobots(domain, path).catch((): boolean => true);
      if (!allowed) continue;
    }
    const encodedPath: string = path
      .split('/')
      .map((seg: string): string => encodeURIComponent(seg))
      .join('/');
    const { html } = await fetchTextSafe(`https://${domain}${encodedPath}`);
    if (!html) continue;
    const contacts: Contacts = extractContacts(html, domain);
    if (!found.email && contacts.email) found.email = contacts.email;
    if (!found.phone && contacts.phone) found.phone = contacts.phone;
  }
  return found;
}
