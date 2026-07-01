/**
 * إثراء بيانات العملاء المحتملين — تعبئة البريد/الهاتف الناقص.
 *
 * مصدران:
 *  - website : زيارة موقع الشركة واستخراج البريد/الهاتف المنشور (مجاني، بلا مفتاح).
 *  - hunter  : Hunter.io domain-search (بريد احترافي مُتحقّق) — يتطلّب HUNTER_API_KEY (مجاني 50/شهر بلا بطاقة).
 *
 * امتثال: بيانات تواصل أعمال عامّة منشورة على الموقع الرسمي فقط.
 */

const UA = 'FieldSales-Enrich/1.0 (https://fieldsa.net)';

export interface Contact { email?: string; phone?: string }

// نطاقات/لواحق تُستبعَد من نتائج البريد (ضجيج شائع في صفحات الويب)
const EMAIL_BLOCK = [
  'sentry', 'wixpress', 'example.', 'yourdomain', 'domain.com', 'email.com', 'sentry.io',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '@2x', 'schema.org', 'w3.org',
  'godaddy', 'wix.com', 'squarespace', 'cloudflare', 'gstatic', 'googleapis',
];

// استخراج نطاق الموقع
export function domainOf(website?: string | null): string {
  if (!website) return '';
  try {
    const u = new URL(website.startsWith('http') ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function cleanEmail(e: string): string {
  return e.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
}

function goodEmail(e: string): boolean {
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)) return false;
  return !EMAIL_BLOCK.some((b) => e.includes(b));
}

// استخراج بريد/هاتف من HTML — يفضّل روابط mailto:/tel: ثم البحث النصّي
function extractContacts(html: string, domain: string): Contact {
  const emails = new Set<string>();
  // mailto:
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) emails.add(cleanEmail(m[1]));
  // نصّي
  for (const m of html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) emails.add(cleanEmail(m[0]));
  const valid = [...emails].filter(goodEmail);
  // نُفضّل البريد الذي نطاقه = نطاق الموقع (بريد الشركة نفسه)
  valid.sort((a, b) => Number(b.endsWith('@' + domain)) - Number(a.endsWith('@' + domain)));

  let phone: string | undefined;
  const tel = html.match(/tel:\+?([\d\s().-]{7,}\d)/i);
  if (tel) phone = '+' + tel[1].replace(/[^\d]/g, '');
  else {
    const p = html.match(/\+\d[\d\s().-]{7,}\d/); // رقم دولي بادئ +
    if (p) phone = p[0].replace(/[^\d+]/g, '');
  }
  return { email: valid[0], phone };
}

async function fetchText(url: string, timeoutMs = 8000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html') && !ct.includes('text/plain')) return null;
    return (await r.text()).slice(0, 500_000); // حدّ حجم
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// إثراء من الموقع: الصفحة الرئيسية ثم صفحة تواصل إن لزم
export async function enrichFromWebsite(website: string): Promise<Contact> {
  const domain = domainOf(website);
  if (!domain) return {};
  const base = website.startsWith('http') ? website : `https://${domain}`;
  const found: Contact = {};

  const home = await fetchText(base);
  if (home) Object.assign(found, extractContacts(home, domain));

  if (!found.email || !found.phone) {
    for (const path of ['/contact', '/contact-us', '/about', '/اتصل-بنا', '/تواصل-معنا']) {
      if (found.email && found.phone) break;
      const page = await fetchText(`https://${domain}${path}`, 6000);
      if (!page) continue;
      const c = extractContacts(page, domain);
      found.email = found.email || c.email;
      found.phone = found.phone || c.phone;
    }
  }
  return found;
}

// ----------------------------- Hunter.io ----------------------------- //
export function hunterReady(): boolean {
  return !!(process.env.HUNTER_API_KEY || '').trim();
}

export async function hunterDomainSearch(website: string): Promise<Contact> {
  const key = (process.env.HUNTER_API_KEY || '').trim();
  if (!key) return {};
  const domain = domainOf(website);
  if (!domain) return {};
  try {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=5&api_key=${key}`, {
      headers: { 'User-Agent': UA },
    });
    if (!r.ok) return {};
    const j = (await r.json()) as { data?: { emails?: Array<{ value?: string; confidence?: number }>; phone_number?: string } };
    const emails = (j.data?.emails || []).filter((e) => e.value);
    emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return { email: emails[0]?.value, phone: j.data?.phone_number || undefined };
  } catch {
    return {};
  }
}
