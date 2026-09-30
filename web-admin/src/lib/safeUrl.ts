/**
 * رابط آمن للعرض في href — **حارس ضروري لا تجميل** (مراجعة ٣٠ سبتمبر ٢٠٢٦، INT-2).
 *
 * مواقع العملاء المحتملين وروابط خرائطهم تأتي من مصادر عامة (وسوم OpenStreetMap يحرّرها أي أحد، ونتائج البحث)
 * وتُخزَّن خاماً. وضعها في href مباشرةً يسمح بـ`javascript:` ينفّذ في أصل fieldsa.net حين ينقر المالك الرابط، فيقرأ
 * توكن جلسته من localStorage. لذلك لا يُسمح إلا بـhttp/https، وما عداه يُعرض نصاً بلا رابط. (مرآة safeHref في منصّة الصيد.)
 */
export function safeHttpUrl(raw?: string | null): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    // «مخطّط:» لا يتبعه رقم — وإلا فهو نطاقٌ بمنفذ (shop.sa:8443) يُعامل https
    const u = new URL(/^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}
