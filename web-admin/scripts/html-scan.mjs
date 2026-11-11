/**
 * أدوات قراءة HTML المُصيَّر (بلا محلّل DOM) — مشتركة بين حارس الطبقة متعددة اللغات (verify-i18n.mjs) وفحوص dist
 * لصفحات الدول (country-i18n.mjs: countryPageDistProblems) واختباراتها، فيُختبر الفحص بالأدوات نفسها التي يعمل بها
 * الحارس على dist.
 */

export const decode = (s) => String(s ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export const attrsOf = (tag) => {
  const out = {};
  for (const m of String(tag).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? '');
  return out;
};
export const headOf = (html) => {
  const i = html.search(/<\/head>/i);
  return i >= 0 ? html.slice(0, i) : html;
};
export const tagsOf = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'gi'))].map((m) => attrsOf(m[0]));
export const metaContent = (head, key, val) => (tagsOf(head, 'meta').find((a) => a[key] === val) || {}).content ?? null;
export const titleOf = (head) => decode(((head.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());
export const canonicalOf = (head) => (tagsOf(head, 'link').find((a) => (a.rel || '').toLowerCase() === 'canonical') || {}).href ?? null;
export const alternatesOf = (head) => tagsOf(head, 'link')
  .filter((a) => (a.rel || '').toLowerCase() === 'alternate' && a.hreflang)
  .map((a) => ({ hreflang: a.hreflang, href: a.href }));
export const htmlAttrs = (html) => attrsOf((html.match(/<html\b[^>]*>/i) || [''])[0]);
/** محتوى <main> داخل حاوية الطبقة (القالب قد يحمل غيرها) */
export const mainOf = (html) => {
  const at = html.indexOf('data-i18n-page=');
  const from = at >= 0 ? at : 0;
  const m = html.slice(from).match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return m ? m[1] : '';
};
export const removeElements = (html, re) => html.replace(re, ' ');
export const stripTags = (h) => decode(String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
/**
 * نصوص العناصر الكتلية سطراً سطراً (فقرة، عنوان، خلية، بند…) — لقواعد الجملة: لا تلتصق فقرة بأخرى فتصير «جملة» واحدة.
 */
export const blockTexts = (h) => decode(String(h)
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<\/(?:p|h[1-6]|li|td|th|tr|section|div|nav|ul|ol|table|summary|details|dt|dd|blockquote)\s*>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
export const ldBlocks = (html) => [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
export const RE_LANGS_NAV = /<nav\b[^>]*data-i18n-langs[^>]*>[\s\S]*?<\/nav>/gi;
export const RE_COUNTRIES = /<table\b[^>]*data-i18n-countries[^>]*>[\s\S]*?<\/table>/gi;
export const RE_LINKS = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
