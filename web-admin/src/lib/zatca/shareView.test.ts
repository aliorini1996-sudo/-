// ZATCA المرحلة الثانية (Z5.7) — اختبارات منطق صفحة المشتري العلنية.
//
// ما يُحرَس هنا ثلاثة أشياء يسقط كلٌّ منها صامتاً لو تُرك:
//   ١) **الردّ العدائيّ**: الصفحة يفتحها من لا حساب له، وأيّ جسمٍ ناقص أو مزوّر يجب أن يعطي «غير متاح» لا شاشةً
//      بيضاء ولا حقلاً بـ undefined. كلّ حقلٍ إلزاميّ يُنزع مرّة ويُتحقّق أنّ النتيجة null.
//   ٢) **جمع المبالغ**: سطور العرض يجب أن تُجمع إلى الإجمالي بالضبط — ومنها فرق التقريب الذي تصنعه الأسعار
//      الشاملة للضريبة (٠٫٠١/٠٫٠٢). سطرٌ مبتلع يجعل المشتري يظنّ الفاتورة مغلوطة.
//   ٣) **اكتمال اللغات**: كلّ نصٍّ تعرضه الصفحة له مفتاحٌ في القاموس بلغاته الأربع — وإلا رأى قارئٌ صينيّ عربيةً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBackend } from './copyGuard';
import {
  SHARE_PHRASES, SHARE_TOKEN_RE, isShareToken, parsePublicDoc, shareAmountLines, shareDocTitle, shareLinkOf,
  shareMessageOf, shareStatusNote, shareTranslate, waShareUrl, type PublicDoc,
} from './shareView';

const TOKEN = `${'a'.repeat(32)}.${'B'.repeat(27)}`;

const raw = (over: Record<string, unknown> = {}, doc: Record<string, unknown> = {}): Record<string, unknown> => ({
  seller: { name: 'شركة الاختبار', vatNumber: '300000000000003' },
  buyer: { name: 'عميل' },
  document: {
    kind: 'INVOICE', subtype: '01', number: 'INV-1', uuid: '11111111-2222-3333-4444-555555555555',
    issueDate: '2026-09-20', issueTime: '13:40:00', currency: 'SAR',
    subtotal: 100, discount: 0, tax: 15, total: 115, status: 'cleared', flow: 'CLEARANCE', ...doc,
  },
  qr: 'AQ==', xml: { available: true, variant: 'cleared' },
  ...over,
});

const parsed = (over?: Record<string, unknown>, doc?: Record<string, unknown>): PublicDoc => {
  const v = parsePublicDoc(raw(over, doc));
  assert.ok(v, 'المدخل الصالح يجب أن يُفكّ');
  return v;
};

// ─── الرمز والرابط ───

test('صيغة الرمز: 32 ست‑عشرية ونقطة و27 base64url — وما خالفها يُرفض قبل أي نداء', () => {
  assert.ok(isShareToken(TOKEN));
  assert.ok(SHARE_TOKEN_RE.test(TOKEN));
  for (const bad of [
    '', 'abc', TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.replace('.', '-'),
    `${'A'.repeat(32)}.${'B'.repeat(27)}`, // ست‑عشرية كبيرة: الخادم يبنيها صغيرة
    `${'g'.repeat(32)}.${'B'.repeat(27)}`, // ليست ست‑عشرية
    `${'a'.repeat(32)}.${'+'.repeat(27)}`, // base64 عاديّ لا base64url
    null, undefined, 42, {},
  ]) assert.equal(isShareToken(bad as unknown), false, `قُبل رمزٌ باطل: ${String(bad)}`);
});

test('الرابط مسار /e/ واحد ولا يضاعف الشرطة', () => {
  assert.equal(shareLinkOf('https://fieldsa.net', TOKEN), `https://fieldsa.net/e/${TOKEN}`);
  assert.equal(shareLinkOf('https://fieldsa.net///', TOKEN), `https://fieldsa.net/e/${TOKEN}`);
});

// ─── فكّ الردّ ───

test('الردّ الصالح يُفكّ بحقوله كما هي', () => {
  const v = parsed();
  assert.equal(v.seller.vatNumber, '300000000000003');
  assert.equal(v.buyer.name, 'عميل');
  assert.equal(v.document.number, 'INV-1');
  assert.equal(v.document.total, 115);
  assert.equal(v.document.flow, 'CLEARANCE');
  assert.deepEqual(v.xml, { available: true, variant: 'cleared' });
});

test('جسمٌ ليس كائناً أو ينقصه المستند أو معرّفه ⇒ null', () => {
  for (const bad of [null, undefined, 'x', 7, [], {}, { document: null }, { document: 'x' }]) {
    assert.equal(parsePublicDoc(bad as unknown), null);
  }
  assert.equal(parsePublicDoc(raw({}, { uuid: '' })), null, 'بلا معرّف فريد لا يُعرض شيء');
});

test('حالةٌ غير نهائية أو مجهولة ⇒ null — الصفحة لا تعرض ما حجبه الخادم ولو وصل', () => {
  for (const s of ['signed', 'clearance_pending', 'rejected', 'cleared_no_xml', 'REPORTED', '', null, 1]) {
    assert.equal(parsePublicDoc(raw({}, { status: s })), null, `قُبلت حالة: ${String(s)}`);
  }
  for (const s of ['reported', 'reported_warn', 'cleared', 'cleared_warn']) {
    assert.ok(parsePublicDoc(raw({}, { status: s })), `رُفضت حالة نهائية: ${s}`);
  }
});

test('نوعٌ خارج 01/02 ⇒ null، ونوع مستندٍ مجهول يعود فاتورة لا يرمي', () => {
  assert.equal(parsePublicDoc(raw({}, { subtype: '03' })), null);
  assert.equal(parsePublicDoc(raw({}, { subtype: null })), null);
  assert.equal(parsed({}, { kind: 'SOMETHING' }).document.kind, 'INVOICE');
});

test('المبالغ الناقصة تبقى null ولا تُصفَّر، والنصوص الفارغة تصير null', () => {
  const v = parsed({ buyer: { name: '   ' } }, { subtotal: 'x', tax: null, total: NaN, number: '' });
  assert.equal(v.document.subtotal, null);
  assert.equal(v.document.tax, null);
  assert.equal(v.document.total, null);
  assert.equal(v.document.number, null);
  assert.equal(v.buyer.name, null);
});

test('العملة الافتراضية ريال، والتدفّق غير CLEARANCE يصير REPORTING', () => {
  const v = parsed({}, { currency: null, flow: 'x' });
  assert.equal(v.document.currency, 'SAR');
  assert.equal(v.document.flow, 'REPORTING');
});

test('XML: كلّ ما ليس true صراحةً يعني «لا تنزيل»', () => {
  assert.equal(parsed({ xml: { available: 'true', variant: 'cleared' } }).xml.available, false);
  assert.equal(parsed({ xml: {} }).xml.available, false);
  assert.equal(parsed({ xml: { available: true, variant: 'x' } }).xml.variant, 'signed');
});

// ─── العنوان والحالة ───

test('عنوان كلّ نوعٍ وكلّ صنف عبارةٌ كاملة لها مفتاح في القاموس', () => {
  const seen: string[] = [];
  for (const kind of ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE']) {
    for (const subtype of ['01', '02']) {
      const title = shareDocTitle(parsed({}, { kind, subtype }));
      seen.push(title);
      assert.ok(SHARE_PHRASES[title], `عنوان بلا ترجمة: ${title}`);
    }
  }
  assert.equal(new Set(seen).size, 6, 'عنوانان متطابقان لنوعين مختلفين');
  assert.equal(shareDocTitle(parsed({}, { kind: 'CREDIT_NOTE', subtype: '02' })), 'إشعار دائن مبسط');
});

test('لكلّ حالةٍ نهائية نبرة وجملة مترجمتان، والتحفّظ لا يُخفى', () => {
  for (const [status, tone] of [['reported', 'ok'], ['reported_warn', 'warn'], ['cleared', 'ok'], ['cleared_warn', 'warn']] as const) {
    const n = shareStatusNote(parsed({}, { status }));
    assert.equal(n.tone, tone);
    assert.ok(SHARE_PHRASES[n.label], `حالة بلا ترجمة: ${n.label}`);
    assert.ok(SHARE_PHRASES[n.hint], `تفسير بلا ترجمة: ${n.hint}`);
  }
});

// ─── المبالغ ───

const sum = (lines: ReturnType<typeof shareAmountLines>): number =>
  Math.round(lines.filter(l => !l.strong && l.label !== 'الوعاء الخاضع للضريبة')
    .reduce((a, l) => a + (l.negative ? -Math.abs(l.value) : l.value), 0) * 100) / 100;

test('السطور تُجمع إلى الإجمالي بالضبط — بلا خصم وبخصم', () => {
  const plain = shareAmountLines(parsed({}, { subtotal: 100, discount: 0, tax: 15, total: 115 }));
  assert.deepEqual(plain.map(l => l.label), ['الإجمالي قبل الضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة']);
  assert.equal(sum(plain), 115);

  const disc = shareAmountLines(parsed({}, { subtotal: 100, discount: 10, tax: 13.5, total: 103.5 }));
  assert.deepEqual(disc.map(l => l.label), [
    'الإجمالي قبل الضريبة', 'الخصم', 'الوعاء الخاضع للضريبة', 'ضريبة القيمة المضافة', 'الإجمالي شامل الضريبة',
  ]);
  assert.equal(disc.find(l => l.label === 'الوعاء الخاضع للضريبة')?.value, 90);
  assert.equal(disc.find(l => l.label === 'الخصم')?.negative, true);
  assert.equal(sum(disc), 103.5);
});

test('فرق التقريب من الأسعار الشاملة يُعرض سطراً باسمه لا يُبتلع', () => {
  // ٢٥٫٨٠ شاملة: الوعاء ٢٢٫٤٣ والضريبة ٣٫٣٦ ⇒ ٢٥٫٧٩، والفرق قرشٌ يظهر
  const l = shareAmountLines(parsed({}, { subtotal: 22.43, discount: 0, tax: 3.36, total: 25.8 }));
  const diff = l.find(x => x.label === 'فرق تقريب');
  assert.ok(diff, 'فرق التقريب مبتلع');
  assert.equal(diff.value, 0.01);
  assert.equal(sum(l), 25.8);
  // وفرقٌ سالب يُعرض سالباً
  const neg = shareAmountLines(parsed({}, { subtotal: 22.43, discount: 0, tax: 3.38, total: 25.8 }));
  assert.equal(neg.find(x => x.label === 'فرق تقريب')?.negative, true);
});

test('مبلغٌ ناقص يُسقط سطره ولا يخترع صفراً ولا فرق تقريب', () => {
  const l = shareAmountLines(parsed({}, { subtotal: null, discount: null, tax: null, total: 115 }));
  assert.deepEqual(l.map(x => x.label), ['الإجمالي شامل الضريبة']);
  assert.equal(shareAmountLines(parsed({}, { discount: 0.004 })).some(x => x.label === 'الخصم'), false);
});

test('كلّ عناوين سطور المبالغ مترجمة', () => {
  for (const l of shareAmountLines(parsed({}, { subtotal: 22.43, discount: 5, tax: 3.36, total: 20.8 }))) {
    assert.ok(SHARE_PHRASES[l.label], `سطر بلا ترجمة: ${l.label}`);
  }
});

// ─── رسالة المشاركة ───

test('رسالة المشاركة تحمل الرقم والرابط، وبلا رقم لا تكتب undefined', () => {
  const m = shareMessageOf({ number: 'INV-9', sellerName: 'شركة' }, 'https://x/e/t');
  assert.match(m, /INV-9/);
  assert.match(m, /شركة/);
  assert.ok(m.endsWith('https://x/e/t'));
  const bare = shareMessageOf({ number: null }, 'https://x/e/t');
  assert.equal(bare.includes('undefined') || bare.includes('null'), false);
});

test('رابط واتساب يرمّز النصّ وينظّف الرقم', () => {
  const u = waShareUrl('نص فيه & و=', '+966 50 123 4567');
  assert.ok(u.startsWith('https://wa.me/966501234567?text='));
  assert.equal(u.includes(' '), false);
  assert.equal(u.includes('&و'), false);
  assert.ok(waShareUrl('x').startsWith('https://wa.me/?text='));
});

// ─── اللغات ───

test('كلّ مفتاحٍ في القاموس له لغاته الأربع بنصّ غير فارغ', () => {
  for (const [ar, t] of Object.entries(SHARE_PHRASES)) {
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.equal(typeof t[l], 'string', `${ar} تنقصها ${l}`);
      assert.ok(t[l].trim() !== '', `${ar} ترجمتها ${l} فارغة`);
    }
  }
});

test('الترجمة: العربية كما هي، والمفتاح المجهول يعود عربياً لا فارغاً', () => {
  assert.equal(shareTranslate('ar', 'الخصم'), 'الخصم');
  assert.equal(shareTranslate('en', 'الخصم'), 'Discount');
  assert.equal(shareTranslate('zh', 'الخصم'), '折扣');
  assert.equal(shareTranslate('en', 'نصٌّ غير مسجّل'), 'نصٌّ غير مسجّل');
  assert.equal(shareTranslate('xx', 'الخصم'), 'الخصم');
});

// ─── التطابق مع الخادم ───

/**
 * الرمز يبنيه الخادم وتفحصه هذه الواجهة. انحرافُ أحدهما عن الآخر لا يُنتج خطأ تصريف بل **رفضاً صامتاً لكلّ
 * الروابط**: صفحةٌ تقول «الرابط غير صحيح» لرابطٍ صحيح. فالشكل والمسار والحالات النهائية تُثبَّت من المصدر نفسه.
 */
test('شكل الرمز ومساره وحالاته النهائية مطابقة لملف الخادم', () => {
  const src = readBackend('publicView.ts');
  assert.ok(src.includes('const MAC_CHARS = 27;'), 'طول البصمة في الخادم تغيّر — حدّث SHARE_TOKEN_RE');
  assert.ok(src.includes('^[0-9a-f]{32}') && src.includes('[A-Za-z0-9_-]{${MAC_CHARS}}$'), 'صيغة الرمز في الخادم تغيّرت');
  assert.ok(src.includes('/e/${token}'), 'مسار الصفحة في الخادم لم يعد /e/:token');
  for (const st of ['REPORTED', 'REPORTED_WARN', 'CLEARED', 'CLEARED_WARN']) {
    assert.ok(src.includes(`'${st}'`), `حالة ${st} غابت عن بوابة الخادم`);
  }
  // الحالات التي يجب أن تبقى خارج البوابة — وجودها في القائمة البيضاء يعني تسليم مستندٍ قد يُبطل
  const gate = src.slice(src.indexOf('SHAREABLE_DOCUMENT_STATUSES'), src.indexOf('export type ShareableStatus'));
  for (const st of ['SIGNED', 'SUBMITTING', 'RETRY_WAIT', 'REJECTED', 'CLEARED_NO_XML']) {
    assert.equal(gate.includes(`'${st}'`), false, `حالة غير نهائية دخلت بوابة المشاركة: ${st}`);
  }
});

// ─── الرمز لا يخرج مع الصفحة في ترويسة Referer ───

test('الصفحة العلنية تعلن no-referrer قبل أوّل نداء', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'EinvoicePublicPage.tsx'), 'utf8');
  // مسار الصفحة يحمل الرمز كلّه: بلا هذا يُرسَل في Referer مع نداء الـAPI فينتهي في سجلّ الخادم
  assert.ok(page.includes("'referrer'") && page.includes("'no-referrer'"), 'وسم referrer غاب عن الصفحة العلنية');
  const iMeta = page.indexOf("'no-referrer'");
  const iFetch = page.indexOf('await fetch(');
  assert.ok(iMeta > 0 && iFetch > iMeta, 'وسم referrer يجب أن يُركَّب قبل أوّل نداء (ترتيب الـeffects)');
  assert.ok(page.includes("'noindex, nofollow'"), 'وسم noindex غاب عن الصفحة العلنية');
});
