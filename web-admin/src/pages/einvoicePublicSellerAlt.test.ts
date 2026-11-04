// صفحة المشتري العلنية (`/e/:token`) — اسم الشركة وعنوانها باللغة الثانية تحت البائع (قرار المالك ٤ نوفمبر ٢٠٢٦).
// الخادم يرسل نصّين محلولين اختياريين (seller.nameAlt / seller.addressAlt) وحدهما من «نصوص المطبوعات»: يُفكّان هنا بقائمةٍ
// بيضاء ويُرسمان تحت اسم البائع باتجاه نصّهما، وبغيابهما تبقى خانة البائع والمستند المفكوك كما كانا حرفاً بحرف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parsePublicDoc, type PublicDoc } from '../lib/zatca/shareView';
import { SellerField } from './EinvoicePublicPage';

const raw = (seller: Record<string, unknown>) => ({
  seller,
  buyer: { name: 'عميل' },
  document: {
    kind: 'INVOICE', subtype: '02', number: 'INV-1', uuid: 'u-1', issueDate: '2026-09-20', issueTime: '12:30:00',
    currency: 'SAR', subtotal: 100, discount: 0, tax: 15, total: 115, status: 'reported', flow: 'REPORTING',
  },
  qr: 'QR', xml: { available: true, variant: 'signed' },
});

const BASE = { name: 'شركة الاختبار', vatNumber: '300000000000003' };

test('الفكّ: بلا نصّين ثانيين ⇒ البائع بمفتاحيه القديمين وحدهما (لا null جديد)', () => {
  const v = parsePublicDoc(raw(BASE)) as PublicDoc;
  assert.deepEqual(v.seller, BASE);
  for (const empty of [{ nameAlt: '', addressAlt: '   ' }, { nameAlt: null, addressAlt: null }, { nameAlt: 7, addressAlt: {} }]) {
    assert.deepEqual((parsePublicDoc(raw({ ...BASE, ...empty })) as PublicDoc).seller, BASE, JSON.stringify(empty));
  }
});

test('الفكّ: النصّان يُقبلان مقصوصين لحدّيهما، وما عداهما من مفاتيح البائع يُهمل', () => {
  const v = parsePublicDoc(raw({ ...BASE, nameAlt: ' Test Co. ', addressAlt: 'Riyadh', secondLang: 'en', edits: { x: 1 } })) as PublicDoc;
  assert.deepEqual(v.seller, { ...BASE, nameAlt: 'Test Co.', addressAlt: 'Riyadh' });
  const long = parsePublicDoc(raw({ ...BASE, nameAlt: 'N'.repeat(300), addressAlt: 'A'.repeat(300) })) as PublicDoc;
  assert.equal(long.seller.nameAlt?.length, 80);
  assert.equal(long.seller.addressAlt?.length, 160);
  assert.deepEqual((parsePublicDoc(raw({ ...BASE, addressAlt: 'Riyadh' })) as PublicDoc).seller, { ...BASE, addressAlt: 'Riyadh' });
  // الحدّ بالمحارف كحدّ الخادم: ٨٠ محرفاً خارج BMP (١٦٠ وحدة UTF-16) تصل كاملةً بلا شطر محرف
  const astral = '\u{20BB7}'.repeat(80);
  const a = parsePublicDoc(raw({ ...BASE, nameAlt: astral, addressAlt: '\u{1F3EA}'.repeat(200) })) as PublicDoc;
  assert.equal(a.seller.nameAlt, astral);
  assert.equal(Array.from(a.seller.addressAlt as string).length, 160);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(a.seller.addressAlt as string), false, 'محرفٌ مشطور');
});

const render = (seller: PublicDoc['seller']) => renderToStaticMarkup(createElement(SellerField, { label: 'البائع', seller }));

test('الرسم: بلا نصٍّ ثانٍ ⇒ خانة البائع كما كانت حرفاً بحرف', () => {
  // ما كان يرسمه <Field label="البائع" value={seller.name} /> قبل القرار
  const before = '<div class="min-w-0"><p class="text-[11px] text-[#6E6557]">البائع</p>'
    + '<p class="text-sm text-[#1F1A13] break-words ">شركة الاختبار</p></div>';
  assert.equal(render(BASE), before);
  assert.equal(render({ name: null, vatNumber: null }), before.replace('شركة الاختبار', '—'));
});

test('الرسم: الاسم والعنوان باللغة الثانية تحت اسم البائع، باتجاه نصّهما', () => {
  const html = render({ ...BASE, nameAlt: 'Test Trading Co.', addressAlt: 'King Fahd Rd, Riyadh' });
  const iName = html.indexOf('شركة الاختبار');
  const iAlt = html.indexOf('Test Trading Co.');
  const iAddr = html.indexOf('King Fahd Rd, Riyadh');
  assert.ok(iName > 0 && iAlt > iName && iAddr > iAlt, html);
  assert.match(html, /<p class="[^"]*" dir="auto">Test Trading Co\.<\/p>/);
  assert.match(html, /<p class="[^"]*" dir="auto">King Fahd Rd, Riyadh<\/p>/);
  // أحدهما وحده
  const onlyAddr = render({ ...BASE, addressAlt: '北京路 1号' });
  assert.ok(onlyAddr.includes('北京路 1号') && !onlyAddr.includes('undefined'));
  assert.equal((onlyAddr.match(/dir="auto"/g) ?? []).length, 1);
});

test('الصفحة: خانة البائع وحدها تغيّرت — النصّان لا يمرّان بالقاموس ولا يظهران في غيرها', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'EinvoicePublicPage.tsx'), 'utf8');
  assert.ok(page.includes("<SellerField label={tr('البائع')} seller={doc.seller} />"));
  assert.equal(page.includes("<Field label={tr('البائع')}"), false);
  const start = page.indexOf('export function SellerField(');
  const end = page.indexOf('function Field(', start);
  assert.ok(start > 0 && end > start);
  const outside = page.slice(0, start) + page.slice(end);
  assert.equal(/nameAlt|addressAlt/.test(outside), false, 'نصّا اللغة الثانية يُستعملان خارج خانة البائع');
  assert.equal(/tr\(\s*seller\./.test(page), false, 'نصّ الشركة يمرّ بالقاموس');
});
