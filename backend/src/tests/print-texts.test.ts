// «نصوص المطبوعات» v1 (services/printTextsCore.ts + services/printTexts.ts + routes/printTexts.ts) — طلب المالك ٣١ أكتوبر
// ٢٠٢٦. البنية الصارمة والأقفال والأطوال والصورة القانونية والقراءة المتسامحة، ثم سلامة القائمة المغلقة (ما يُخفى قائمةٌ مكتوبة
// هنا حرفاً — نصٌّ إلزاميٌّ يصير قابلاً للإخفاء يُفشلها بصوتٍ عالٍ)، ثم المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة، ثم
// حرّاس نصّية على التركيب وعلى بقاء PUT /api/company كما هو.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import {
  PRINT_SECOND_LANGS, PRINT_TEXT_CATALOG, PRINT_TEXT_LOCKS, PRINT_TEXTS_ISSUES, PRINT_TEXTS_LIMITS, PRINT_TEXTS_VERSION,
  canonicalPrintTexts, checkPrintTexts, emptyPrintTexts, isEmptyPrintTexts, isPrintTextsReset, parsePrintTexts, printTextAltEditable,
  printTextEntry, printTextHideable, printTextRewordable, printTextsBytes, storedPrintTexts,
  type PrintTextEdit, type PrintTextsV1,
} from '../services/printTexts';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const chars = (s: string | null) => (s === null ? 0 : Array.from(s).length);

/** تعديلٌ كامل الحقول من جزئه */
const ed = (e: Partial<PrintTextEdit>): PrintTextEdit => ({ text: null, alt: null, hidden: false, ...e });
/** إعدادٌ بتعديلاتٍ بترتيب إدخالها (الصورة القانونية ترتّبها بترتيب القائمة) */
const withEdits = (edits: Record<string, Partial<PrintTextEdit>>, over: Partial<Omit<PrintTextsV1, 'edits'>> = {}): PrintTextsV1 => ({
  ...emptyPrintTexts(), ...over, edits: Object.fromEntries(Object.entries(edits).map(([k, x]) => [k, ed(x)])),
});
/** شركةٌ تطبع بالعربية والإنجليزية: هاتفٌ بصياغتها، وعنوانٌ بلا «ضريبية»، وجوال العميل والخصم ونصّ الرمز مخفية — بترتيب القائمة */
function sample(): PrintTextsV1 {
  return {
    version: 1, secondLang: 'en', companyNameAlt: 'Al Riyada Distribution', companyAddressAlt: 'Riyadh, Al Sulay',
    edits: {
      'h.phone': { text: 'الهاتف', alt: 'Tel', hidden: false },
      'inv.title': { text: 'فاتورة مبيعات', alt: 'Sales invoice', hidden: false },
      'cust.phone': { text: null, alt: null, hidden: true },
      'col.priceIncl': { text: null, alt: 'Unit price incl. VAT', hidden: false },
      'col.discount': { text: null, alt: null, hidden: true },
      'qr.caption': { text: null, alt: null, hidden: true },
      'rcp.title': { text: 'إيصال استلام', alt: null, hidden: false },
    },
  };
}
const check = (s: unknown) => checkPrintTexts(s, true);
const issuesOf = (s: unknown) => { const r = check(s); return r.ok ? [] : r.issues.map((i) => i.message); };
const fullIssues = (s: unknown) => { const r = check(s); return r.ok ? [] : r.issues; };
const byLock = (...locks: string[]) => PRINT_TEXT_CATALOG.filter((x) => locks.includes(x.lock));
/** يلتقط console.warn أثناء fn (القيمة المخزّنة التالفة تُسجَّل ولا تُرمى) */
function captureWarn<T>(fn: () => T): { value: T; warns: unknown[][] } {
  const warns: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warns.push(a); };
  try { return { value: fn(), warns }; } finally { console.warn = orig; }
}

// ═══ النواة: البنية والقواعد ═══

test('الافتراضي: الإعداد الفارغ = null في الأثر، والعيّنة الصالحة تُحفظ بصورتها القانونية كما هي (ثابتة وبترتيب مفاتيح ثابت)', () => {
  assert.equal(PRINT_TEXTS_VERSION, 1);
  assert.deepEqual(emptyPrintTexts(), { version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits: {} });
  assert.notEqual(emptyPrintTexts().edits, emptyPrintTexts().edits, 'نسخة جديدة في كل نداء');
  assert.equal(isEmptyPrintTexts(emptyPrintTexts()), true);
  const r = check(sample());
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.value, sample());
  assert.equal(JSON.stringify(r.value), JSON.stringify(sample()));
  assert.deepEqual(canonicalPrintTexts(r.value), r.value, 'ثابتة');
  assert.deepEqual(parsePrintTexts(sample()), { ok: true, value: sample() });
  for (const lang of PRINT_SECOND_LANGS) assert.ok(check({ ...sample(), secondLang: lang }).ok, lang);
  assert.deepEqual([...PRINT_SECOND_LANGS], ['en', 'fr', 'tr', 'zh']);
});

test('البنية الصارمة: حقلٌ مجهول في الأعلى أو في تعديل ⇒ unknownKey، ومفتاح نصٍّ خارج القائمة ⇒ unknownText بمساره', () => {
  const add = (fn: (s: Record<string, any>) => void) => { const s = clone(sample()) as Record<string, any>; fn(s); return s; };
  for (const s of [
    add((s) => { s.extra = 1; }),
    add((s) => { s.logo = 'data:image/png;base64,AAAA'; }), // لا صور
    add((s) => { s.edits['h.phone'].color = 'red'; }),
    add((s) => { s.edits['cust.phone'].bold = true; }),
  ]) assert.deepEqual(issuesOf(s), [PRINT_TEXTS_ISSUES.unknownKey], JSON.stringify(s).slice(0, 90));
  const ghost = add((s) => { s.edits['h.fax'] = { text: 'فاكس', alt: null, hidden: false }; });
  assert.deepEqual(fullIssues(ghost), [{ path: 'edits.h.fax', message: PRINT_TEXTS_ISSUES.unknownText }]);
  // سطر المنصّة وتنبيه قرار الطباعة ورمز QR نفسه ليست مفاتيح؛ والمفتاح حسّاسٌ لحالة الأحرف وللمسافات
  for (const k of ['foot.platform', 'footer.platform', 'zatca.notice', 'qr.code', 'INV.TITLE', 'inv.title ', 'constructor', 'toString']) {
    assert.deepEqual(issuesOf(withEdits({ [k]: { text: 'نص' } })), [PRINT_TEXTS_ISSUES.unknownText], k);
  }
  // __proto__ (من JSON.parse) لا يبلغ الصورة المحفوظة ولا يلوّث Object.prototype
  const proto = JSON.parse('{"version":1,"secondLang":null,"companyNameAlt":null,"companyAddressAlt":null,"edits":{"__proto__":{"text":"x","alt":null,"hidden":true}}}');
  const p = check(proto);
  if (p.ok) assert.deepEqual(p.value, emptyPrintTexts());
  assert.equal(({} as Record<string, unknown>).hidden, undefined);
  assert.equal(({} as Record<string, unknown>).text, undefined);
});

test('البنية الصارمة: نسخة غير 1، ولغة ثانية غير الأربع، وأنواع خاطئة، وحقول ناقصة ⇒ shape', () => {
  const s = (over: Record<string, unknown>) => ({ ...sample(), ...over });
  for (const bad of [
    s({ version: 2 }), s({ version: '1' }), s({ version: 0 }),
    s({ secondLang: 'de' }), s({ secondLang: 'ar' }), s({ secondLang: 'EN' }), s({ secondLang: '' }),
    s({ companyNameAlt: 5 }), s({ edits: [] }), s({ edits: null }),
    s({ edits: { 'h.phone': { text: 'الهاتف', alt: null, hidden: 'true' } } }),
    s({ edits: { 'h.phone': { text: 5, alt: null, hidden: false } } }),
    s({ edits: { 'h.phone': { hidden: true } } }), // text وalt إلزاميان (null للفارغ)
    { version: 1, edits: {} },
  ]) {
    const msgs = issuesOf(bad);
    assert.ok(msgs.length > 0 && msgs.every((m) => m === PRINT_TEXTS_ISSUES.shape), JSON.stringify(bad).slice(0, 120));
  }
  for (const bad of [null, undefined, '{}', [], 42, true]) assert.deepEqual(issuesOf(bad), [PRINT_TEXTS_ISSUES.shape], String(bad));
});

test('الأقفال: الإخفاء يُرفض على zatca وfixed وshape بمسار .hidden، ويُقبل على none وstandard وtitle', () => {
  const locked = byLock('zatca', 'fixed', 'shape');
  assert.ok(locked.length >= 25, `${locked.length}`);
  for (const x of locked) {
    assert.deepEqual(fullIssues(withEdits({ [x.key]: { hidden: true } })), [{ path: `edits.${x.key}.hidden`, message: PRINT_TEXTS_ISSUES.locked }], x.key);
  }
  for (const x of byLock('none', 'standard', 'title')) {
    const r = check(withEdits({ [x.key]: { hidden: true } }));
    assert.ok(r.ok, x.key);
    if (r.ok) assert.deepEqual(r.value.edits, { [x.key]: { text: null, alt: null, hidden: true } }, x.key);
  }
  // الإلزامي يُعاد صياغته (ما ليس fixed ولا يُخفى فقط) — بالعربية وباللغة الثانية
  for (const x of PRINT_TEXT_CATALOG.filter((y) => y.lock !== 'fixed' && !y.hideOnly)) {
    const r = check(withEdits({ [x.key]: { text: 'صياغة الشركة', alt: 'Company wording' } }, { secondLang: 'en' }));
    assert.ok(r.ok, x.key);
  }
  // إخفاءان مقفلان ⇒ مشكلتان بمساريهما
  assert.deepEqual(fullIssues(withEdits({ 'tot.grand': { hidden: true }, 'rcp.number': { hidden: true } })).map((i) => i.path), ['edits.tot.grand.hidden', 'edits.rcp.number.hidden']);
});

test('fixed: العبارة الضريبية لا تُعاد صياغتها بالعربية (fixed بمسار .text) — ونصّها باللغة الثانية يُقبل، والمسافات وحدها لا أثر لها', () => {
  const fixed = byLock('fixed');
  assert.deepEqual(fixed.map((x) => x.key), ['col.priceIncl', 'item.beforeTax', 'note.pricesIncl', 'tot.taxable', 'tot.vat', 'tot.vatIncl']);
  for (const x of fixed) {
    assert.deepEqual(fullIssues(withEdits({ [x.key]: { text: 'صياغة أخرى' } })), [{ path: `edits.${x.key}.text`, message: PRINT_TEXTS_ISSUES.fixed }], x.key);
    const alt = check(withEdits({ [x.key]: { alt: 'VAT wording' } }));
    assert.ok(alt.ok, x.key);
    if (alt.ok) assert.deepEqual(alt.value.edits, { [x.key]: { text: null, alt: 'VAT wording', hidden: false } });
    const blank = check(withEdits({ [x.key]: { text: ' \n\t ' } }));
    assert.ok(blank.ok, x.key);
    if (blank.ok) assert.deepEqual(blank.value.edits, {}, 'تعديلٌ بلا أثر يُحذف');
  }
  // صياغةٌ وإخفاء معاً ⇒ المشكلتان
  assert.deepEqual(issuesOf(withEdits({ 'tot.vat': { text: 'الضريبة', hidden: true } })), [PRINT_TEXTS_ISSUES.locked, PRINT_TEXTS_ISSUES.fixed]);
});

test('hideOnly: يُخفى ولا يُكتب له نصٌّ بأيّ لغة (hideOnly بمسار المفتاح) — نصّ الرمز لا يُصاغ فلا يدّعي «اعتماد الهيئة»', () => {
  const only = PRINT_TEXT_CATALOG.filter((x) => x.hideOnly);
  assert.deepEqual(only.map((x) => x.key), ['foot.company', 'inst.note', 'qr.caption']);
  for (const x of only) {
    for (const e of [{ text: 'نص' }, { alt: 'Text' }, { text: 'نص', alt: 'Text' }, { text: 'نص', hidden: true }]) {
      assert.deepEqual(fullIssues(withEdits({ [x.key]: e })), [{ path: `edits.${x.key}`, message: PRINT_TEXTS_ISSUES.hideOnly }], `${x.key} ${JSON.stringify(e)}`);
    }
    const r = check(withEdits({ [x.key]: { hidden: true, text: '   ', alt: '' } }));
    assert.ok(r.ok, x.key);
    if (r.ok) assert.deepEqual(r.value.edits, { [x.key]: { text: null, alt: null, hidden: true } });
  }
});

test('الأطوال: كل نصٍّ بحدّ مدخله max (بالمحارف لا بوحدات UTF-16) — والاسم والعنوان باللغة الثانية 80 و160', () => {
  for (const x of PRINT_TEXT_CATALOG) {
    if (printTextRewordable(x)) {
      assert.deepEqual(issuesOf(withEdits({ [x.key]: { text: 'ق'.repeat(x.max) } })), [], `${x.key}.text = ${x.max}`);
      assert.deepEqual(fullIssues(withEdits({ [x.key]: { text: 'ق'.repeat(x.max + 1) } })), [{ path: `edits.${x.key}.text`, message: PRINT_TEXTS_ISSUES.tooLong }], x.key);
    }
    if (printTextAltEditable(x)) {
      assert.deepEqual(issuesOf(withEdits({ [x.key]: { alt: 'a'.repeat(x.max) } })), [], `${x.key}.alt = ${x.max}`);
      assert.deepEqual(fullIssues(withEdits({ [x.key]: { alt: 'a'.repeat(x.max + 1) } })), [{ path: `edits.${x.key}.alt`, message: PRINT_TEXTS_ISSUES.tooLong }], x.key);
    }
  }
  // 60 رمزاً تعبيرياً (120 وحدة UTF-16) ضمن حدّ 60، والمسافات حول النصّ وداخله المكرّرة لا تُحسب
  assert.ok(check(withEdits({ 'h.phone': { alt: '😀'.repeat(60) } })).ok);
  assert.ok(check(withEdits({ 'h.phone': { text: `   ${'ق'.repeat(30)}      ${'ب'.repeat(29)}   ` } })).ok);
  const top = (over: Partial<PrintTextsV1>) => fullIssues({ ...emptyPrintTexts(), ...over });
  assert.deepEqual(top({ companyNameAlt: 'N'.repeat(PRINT_TEXTS_LIMITS.companyNameAltMax) }), []);
  assert.deepEqual(top({ companyNameAlt: 'N'.repeat(81) }), [{ path: 'companyNameAlt', message: PRINT_TEXTS_ISSUES.companyNameAlt }]);
  assert.deepEqual(top({ companyAddressAlt: 'A'.repeat(PRINT_TEXTS_LIMITS.companyAddressAltMax) }), []);
  assert.deepEqual(top({ companyAddressAlt: 'A'.repeat(161) }), [{ path: 'companyAddressAlt', message: PRINT_TEXTS_ISSUES.companyAddressAlt }]);
  assert.deepEqual([PRINT_TEXTS_LIMITS.companyNameAltMax, PRINT_TEXTS_LIMITS.companyAddressAltMax, PRINT_TEXTS_LIMITS.maxBytes], [80, 160, 32768]);
});

test('الصورة القانونية: سطرٌ واحد بلا محارف تحكّم، والفارغ null، والتعديل بلا أثر يُحذف، والمفاتيح بترتيب القائمة', () => {
  const messy = {
    edits: {
      'rcp.title': { hidden: false, alt: null, text: '  إيصال\n\tاستلام  ' },
      'cust.phone': { text: null, alt: null, hidden: true },
      'h.email': { text: '   ', alt: '', hidden: false }, // لا أثر ⇒ يُحذف
      'inv.rep': { text: 'المندوب\u0007 الميداني', alt: null, hidden: false },
      'h.phone': { text: 'الهاتف', alt: '  Tel ', hidden: false },
    },
    companyAddressAlt: '   ', companyNameAlt: ' Al  Riyada\r\n Co ', secondLang: 'en', version: 1,
  };
  const r = check(messy);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  const expected: PrintTextsV1 = {
    version: 1, secondLang: 'en', companyNameAlt: 'Al Riyada Co', companyAddressAlt: null,
    edits: {
      'h.phone': { text: 'الهاتف', alt: 'Tel', hidden: false },
      'inv.rep': { text: 'المندوب الميداني', alt: null, hidden: false },
      'cust.phone': { text: null, alt: null, hidden: true },
      'rcp.title': { text: 'إيصال استلام', alt: null, hidden: false },
    },
  };
  assert.equal(JSON.stringify(r.value), JSON.stringify(expected), 'القيم وترتيب المفاتيح');
  assert.deepEqual(canonicalPrintTexts(r.value), r.value, 'ثابتة');
  const order = PRINT_TEXT_CATALOG.map((x) => x.key);
  const keys = Object.keys(r.value.edits);
  assert.deepEqual(keys, [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  // canonicalPrintTexts وحدها (بلا القواعد): تحذف المجهول، والعربية عن fixed، وكل نصٍّ عمّا يُخفى فقط
  const c = canonicalPrintTexts(withEdits({
    'h.fax': { text: 'فاكس' }, 'qr.caption': { text: 'x', alt: 'y', hidden: true }, 'tot.vat': { text: 'الضريبة', alt: 'VAT' }, 'foot.company': { text: 'x' },
  }));
  assert.deepEqual(c.edits, { 'tot.vat': { text: null, alt: 'VAT', hidden: false }, 'qr.caption': { text: null, alt: null, hidden: true } });
});

test('القراءة المتسامحة (الجهاز): المجهول يُهمل، والإخفاء المقفل يسقط وحده، والأطول يُقصّ — ونسخة غير 1 تُرفض', () => {
  const raw = clone(sample()) as Record<string, any>;
  raw.futureField = 1;
  raw.companyNameAlt = 'N'.repeat(100);
  raw.companyAddressAlt = 'A'.repeat(200);
  Object.assign(raw.edits, {
    'h.taxNumber': { text: 'الرقم الضريبي للمنشأة', alt: null, hidden: true, futureFlag: true }, // الصياغة تبقى والإخفاء يسقط
    'tot.vat': { text: null, alt: null, hidden: true }, // لا يبقى شيء ⇒ يُحذف
    'col.priceIncl': { text: 'صياغة', alt: 'Unit price incl. VAT', hidden: false }, // العربية الثابتة تسقط
    'inv.number': { text: 'ق'.repeat(100), alt: 'a'.repeat(100), hidden: false }, // يُقصّ لحدّه
    'h.fax': { text: 'فاكس', alt: null, hidden: false }, // أضافه خادمٌ أحدث
  });
  assert.equal(check(raw).ok, false, 'الخادم الصارم يرفضه');
  const r = checkPrintTexts(raw, false);
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.value.edits['h.taxNumber'], { text: 'الرقم الضريبي للمنشأة', alt: null, hidden: false });
  assert.ok(!('tot.vat' in r.value.edits));
  assert.ok(!('h.fax' in r.value.edits));
  assert.deepEqual(r.value.edits['col.priceIncl'], { text: null, alt: 'Unit price incl. VAT', hidden: false });
  const max = printTextEntry('inv.number')!.max;
  assert.deepEqual([chars(r.value.edits['inv.number'].text), chars(r.value.edits['inv.number'].alt)], [max, max]);
  assert.deepEqual([chars(r.value.companyNameAlt), chars(r.value.companyAddressAlt)], [80, 160]);
  assert.ok(!('futureField' in r.value));
  const order = PRINT_TEXT_CATALOG.map((x) => x.key);
  const keys = Object.keys(r.value.edits);
  assert.deepEqual(keys, [...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b)), 'بترتيب القائمة');
  // ما بقي من العيّنة كما هو
  for (const [k, v] of Object.entries(sample().edits)) if (k !== 'col.priceIncl') assert.deepEqual(r.value.edits[k], v, k);
  assert.equal(checkPrintTexts({ ...sample(), version: 2 }, false).ok, false);
  assert.equal(checkPrintTexts(null, false).ok, false);
  assert.deepEqual(storedPrintTexts(raw), { texts: r.value, stored: true });
});

test('isEmptyPrintTexts: ما لا أثر له فارغ — ونصوص اللغة الثانية بلا لغةٍ ثانية لا أثر لها؛ واللغة أو صياغةٌ أو إخفاءٌ ليس فارغاً', () => {
  for (const s of [
    emptyPrintTexts(),
    withEdits({ 'h.phone': { text: '  ', alt: '' } }),
    withEdits({ 'h.fax': { text: 'فاكس' } }), // مجهول يُحذف
    withEdits({ 'qr.caption': { text: 'x' } }), // يُخفى فقط: النصّ يسقط
    withEdits({ 'tot.vat': { text: 'الضريبة' } }), // fixed: العربية تسقط
    { ...emptyPrintTexts(), companyNameAlt: '   ', companyAddressAlt: '\n' },
    // إطفاء «بلغتين» بعد كتابة الاسم والعنوان ونصوص alt: لا يُطبع شيءٌ منها فلا يُخزَّن (ولا «العربية أولاً» بلا سبب)
    { ...emptyPrintTexts(), companyNameAlt: 'Al Riyada' },
    { ...emptyPrintTexts(), companyAddressAlt: 'Riyadh' },
    withEdits({ 'h.phone': { alt: 'Tel' } }),
  ]) assert.equal(isEmptyPrintTexts(s), true, JSON.stringify(s));
  for (const s of [
    { ...emptyPrintTexts(), secondLang: 'en' as const },
    { ...emptyPrintTexts(), secondLang: 'en' as const, companyNameAlt: 'Al Riyada' },
    withEdits({ 'cust.phone': { hidden: true } }),
    withEdits({ 'inv.title': { text: 'فاتورة' } }),
  ]) assert.equal(isEmptyPrintTexts(s), false, JSON.stringify(s));
});

test('محارف الاتجاه والمحارف الخفيّة تُحذف: لا تسميةٌ مقفلة تختفي، ولا RLO يقلب الرقم المطبوع بعدها', () => {
  const r = checkPrintTexts(withEdits({
    'inv.number': { text: 'رقم الفاتورة‮' },
    'h.taxNumber': { text: '​' },
    'cust.name': { text: '⁦العميل⁩', alt: '‏Client‎' },
    'cust.phone': { text: 'جوال‌العميل' }, // ZWNJ حرفٌ حقيقي يبقى
  }), true);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.edits['inv.number'], { text: 'رقم الفاتورة', alt: null, hidden: false });
  assert.equal(r.value.edits['h.taxNumber'], undefined, 'تسميةٌ من محارف خفيّة وحدها تعود للافتراضي');
  assert.deepEqual(r.value.edits['cust.name'], { text: 'العميل', alt: 'Client', hidden: false });
  assert.equal(r.value.edits['cust.phone'].text, 'جوال‌العميل');
});

test('parsePrintTexts: بلا أثر ⇒ value null (يُكتب NULL)، والصالح بصورته، وفوق 32 كيلوبايت 413 قبل التحليل، والمرفوض 400 برسالة أوّل مشكلة', () => {
  assert.deepEqual(parsePrintTexts(emptyPrintTexts()), { ok: true, value: null });
  assert.deepEqual(parsePrintTexts(withEdits({ 'h.phone': { text: ' ', alt: '' } }, { companyNameAlt: '  ' })), { ok: true, value: null });
  assert.deepEqual(parsePrintTexts(withEdits({ 'tot.vat': { text: '   ' } })), { ok: true, value: null });
  const v = parsePrintTexts({ ...sample(), companyNameAlt: '  Al Riyada Distribution ' });
  assert.deepEqual(v, { ok: true, value: sample() });

  const big = { ...sample(), pad: 'x'.repeat(PRINT_TEXTS_LIMITS.maxBytes) };
  const r = parsePrintTexts(big);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual([r.status, r.code, r.message], [413, 'PRINT_TEXTS_TOO_LARGE', PRINT_TEXTS_ISSUES.tooLarge], 'الحجم قبل البنية (pad حقل مجهول)');
    assert.deepEqual(r.issues, [{ path: '', message: PRINT_TEXTS_ISSUES.tooLarge }]);
  }
  const bad = parsePrintTexts(withEdits({ 'h.taxNumber': { hidden: true } }));
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.deepEqual([bad.status, bad.code, bad.message], [400, 'PRINT_TEXTS_INVALID', PRINT_TEXTS_ISSUES.locked]);
    assert.deepEqual(bad.issues, [{ path: 'edits.h.taxNumber.hidden', message: PRINT_TEXTS_ISSUES.locked }]);
  }
  const two = parsePrintTexts(withEdits({ 'h.fax': { text: 'x' }, 'tot.vat': { hidden: true } }));
  assert.ok(!two.ok && two.message === PRINT_TEXTS_ISSUES.unknownText && two.issues.length === 2);
  const shape = parsePrintTexts({ ...sample(), version: 3 });
  assert.ok(!shape.ok && shape.status === 400 && shape.code === 'PRINT_TEXTS_INVALID' && shape.message === PRINT_TEXTS_ISSUES.shape);
  // البايتات: UTF-8 بين علامتي تنصيص
  assert.deepEqual([printTextsBytes('a'), printTextsBytes('ق'), printTextsBytes('中'), printTextsBytes('😀')], [3, 4, 5, 6]);
});

test('الحجم: كل تسمية بأطول نصٍّ عربيّ ونصٍّ لاتينيّ بحدّها، والاسم والعنوان بحدّيهما، تبقى تحت حدّ الحجم — ولو كانت اللغة الثانية صينية (ثلاثة بايتات للمحرف)', () => {
  const edits: Record<string, PrintTextEdit> = {};
  for (const x of PRINT_TEXT_CATALOG) {
    edits[x.key] = { text: printTextRewordable(x) ? 'ق'.repeat(x.max) : null, alt: printTextAltEditable(x) ? 'a'.repeat(x.max) : null, hidden: false };
  }
  const full: PrintTextsV1 = { version: 1, secondLang: 'en', companyNameAlt: 'N'.repeat(80), companyAddressAlt: 'A'.repeat(160), edits };
  const bytes = printTextsBytes(full);
  assert.ok(bytes <= PRINT_TEXTS_LIMITS.maxBytes, `${bytes} بايت — مدخلٌ جديد في القائمة يحتاج حدّاً أعلى`);
  const r = parsePrintTexts(full);
  assert.ok(r.ok && r.value !== null, JSON.stringify(r).slice(0, 200));
  const zhEdits: Record<string, PrintTextEdit> = {};
  for (const [k, v] of Object.entries(edits)) zhEdits[k] = { ...v, alt: v.alt === null ? null : '中'.repeat(v.alt.length) };
  const zh: PrintTextsV1 = { ...full, secondLang: 'zh', companyNameAlt: '中'.repeat(80), companyAddressAlt: '中'.repeat(160), edits: zhEdits };
  assert.ok(printTextsBytes(zh) <= PRINT_TEXTS_LIMITS.maxBytes, `${printTextsBytes(zh)} بايت بالصينية`);
  assert.ok(parsePrintTexts(zh).ok);
});

test('«استعادة النصوص الافتراضية»: جسم الإعادة null أو { reset: true } وحده', () => {
  for (const b of [null, { reset: true }]) assert.equal(isPrintTextsReset(b), true, JSON.stringify(b));
  for (const b of [undefined, {}, { reset: false }, { reset: 'true' }, { reset: 1 }, { reset: true, version: 1 }, [], ['reset'], 'reset', 0, emptyPrintTexts(), sample()]) {
    assert.equal(isPrintTextsReset(b), false, JSON.stringify(b));
  }
});

test('storedPrintTexts: null ⇒ نصوص اليوم غير محفوظة، والصالح كما هو، وما لا أثر له غير محفوظ، والتالف يُقرأ افتراضياً ويُسجَّل', () => {
  assert.deepEqual(storedPrintTexts(null), { texts: emptyPrintTexts(), stored: false });
  assert.deepEqual(storedPrintTexts(undefined), { texts: emptyPrintTexts(), stored: false });
  assert.deepEqual(storedPrintTexts(sample()), { texts: sample(), stored: true });
  assert.deepEqual(storedPrintTexts(withEdits({ 'h.phone': { text: '  ' } })), { texts: emptyPrintTexts(), stored: false });
  for (const bad of ['garbage', 42, [], { ...sample(), version: 9 }, { ...sample(), edits: { 'h.phone': { text: 1, alt: null, hidden: false } } }]) {
    const { value, warns } = captureWarn(() => storedPrintTexts(bad));
    assert.deepEqual(value, { texts: emptyPrintTexts(), stored: false }, JSON.stringify(bad));
    assert.equal(warns.length, 1, 'تحذيرٌ واحد في السجلّ');
  }
  const { warns } = captureWarn(() => storedPrintTexts(null));
  assert.equal(warns.length, 0, 'null ليس عطباً');
});

// ═══ سلامة القائمة المغلقة ═══

/**
 * ما يقبل الإخفاء حرفاً — نصٌّ إلزاميٌّ (رقم البائع الضريبي، رقم الفاتورة وتاريخها، الضريبة والإجمالي…) يُضاف هنا بتعديلٍ في
 * القائمة يُفشل هذا الاختبار، فلا يصير قابلاً للإخفاء بصمت. الإضافة الصحيحة لنصٍّ غير إلزاميّ تُضاف هنا عمداً.
 */
const HIDEABLE = [
  // مشترك
  'h.phone', 'h.email', 'foot.thanks', 'foot.company',
  // الفاتورة: العنوانان (المرحلة الأولى وحدها) والتسميات غير الإلزامية
  'inv.title', 'inv.returnTitle', 'inv.infoHeading', 'inv.returnInfoHeading', 'inv.type', 'inv.rep',
  'cust.heading', 'cust.name', 'cust.business', 'cust.commercialReg', 'cust.phone', 'cust.address',
  'col.discount', 'col.tax',
  'tot.subtotal', 'tot.discount', 'tot.paid', 'tot.remaining',
  'inst.note', 'qr.caption', 'sig.recipient', 'sig.rep',
  // سند القبض (ليس فاتورة ضريبية)
  'rcp.title', 'rcp.time', 'rcp.rep', 'rcp.forInvoice', 'rcp.forInvoices', 'rcp.invoiceNo', 'rcp.credit', 'rcp.customerHeading',
  'rcp.business', 'rcp.commercialReg', 'rcp.taxNumber', 'rcp.phone', 'rcp.address', 'rcp.method', 'rcp.notes', 'rcp.sigPayer', 'rcp.sigCollector',
];
/** ما يُخفى من المبسّطة ويبقى على القياسية (B2B) مهما حُفظ */
const STANDARD_ONLY = ['cust.name', 'cust.business', 'cust.commercialReg', 'cust.address', 'col.discount', 'col.tax', 'tot.discount'];

test('القائمة: مفاتيح فريدة بصيغة group.name، وكل حدٍّ موجب صحيح يتّسع لنصّه الافتراضي، وأقفالٌ ومستنداتٌ معروفة، ومجمّدة', () => {
  const keys = PRINT_TEXT_CATALOG.map((x) => x.key);
  assert.equal(new Set(keys).size, keys.length, 'مفتاح مكرّر');
  assert.ok(keys.length >= 70, `${keys.length}`);
  for (const x of PRINT_TEXT_CATALOG) {
    assert.match(x.key, /^[a-z]+\.[A-Za-z]+$/, x.key);
    assert.ok(Number.isInteger(x.max) && x.max > 0, `${x.key}.max`);
    assert.ok(x.ar.trim().length > 0 && chars(x.ar) <= x.max, `${x.key}: الافتراضي أطول من حدّه`);
    assert.ok((PRINT_TEXT_LOCKS as readonly string[]).includes(x.lock), `${x.key}.lock`);
    assert.ok(['invoice', 'receipt', 'shared'].includes(x.doc), `${x.key}.doc`);
    assert.ok(Object.isFrozen(x), `${x.key} غير مجمّد`);
    assert.equal(printTextEntry(x.key), x);
    // ما يُخفى فقط يقبل الإخفاء (وإلا صار مدخلاً لا يُعدَّل أصلاً)
    if (x.hideOnly) assert.ok(printTextHideable(x), x.key);
  }
  assert.ok(Object.isFrozen(PRINT_TEXT_CATALOG));
  assert.equal(printTextEntry('h.fax'), undefined);
  assert.equal(printTextEntry('__proto__'), undefined);
  assert.equal(printTextEntry('constructor'), undefined);
  // سطر المنصّة ثابتٌ بقرار المالك: ليس في القائمة
  assert.ok(!PRINT_TEXT_CATALOG.some((x) => /Field Sales|صدرت عبر|منصة/.test(x.ar)), 'سطر «صدرت عبر منصة Field Sales» لا يُعدَّل');
  // العنوانان وحدهما بقفل title
  assert.deepEqual(byLock('title').map((x) => x.key), ['inv.title', 'inv.returnTitle']);
});

test('القائمة: ما يقبل الإخفاء يساوي القائمة المكتوبة حرفاً — والإلزامي (zatca وfixed وshape) لا يُخفى', () => {
  const hideable = PRINT_TEXT_CATALOG.filter((x) => printTextHideable(x)).map((x) => x.key);
  assert.deepEqual([...hideable].sort(), [...HIDEABLE].sort());
  assert.deepEqual(byLock('standard').map((x) => x.key).sort(), [...STANDARD_ONLY].sort());
  for (const x of byLock('zatca', 'fixed', 'shape')) assert.equal(printTextHideable(x), false, x.key);
  // بيانات البائع والمستند والضريبة والإجمالي بالاسم — لا تُخفى
  for (const k of [
    'h.taxNumber', 'h.address', 'h.commercialReg', 'inv.number', 'inv.returnNumber', 'inv.date', 'inv.time', 'inv.deliveryDate',
    'cust.taxNumber', 'col.item', 'col.qty', 'col.price', 'col.priceIncl', 'col.total', 'tot.taxable', 'tot.vat', 'tot.vatIncl',
    'tot.grand', 'tot.returnGrand', 'rcp.number', 'rcp.date', 'rcp.amount', 'rcp.from',
    // الإشعار الدائن: مرجع الفاتورة الأصلية (BT-25) وسببه (KSA-10)
    'inv.originalRef', 'inv.noteReason',
  ]) {
    const x = printTextEntry(k);
    assert.ok(x, k);
    assert.equal(printTextHideable(x!), false, `${k} صار قابلاً للإخفاء`);
  }
  assert.deepEqual(['h.taxNumber', 'h.address', 'h.commercialReg', 'inv.number', 'inv.date', 'tot.grand', 'inv.originalRef', 'inv.noteReason'].map((k) => printTextEntry(k)!.lock), Array(8).fill('zatca'));
  // مضافان آخر قسم الفاتورة (المفتاح ثابت للأبد والإضافة آمنة) — في مجموعة بيانات المستند
  assert.deepEqual(['inv.originalRef', 'inv.noteReason'].map((k) => [printTextEntry(k)!.doc, printTextEntry(k)!.group, printTextEntry(k)!.ar]),
    [['invoice', 'info', 'الفاتورة الأصلية'], ['invoice', 'info', 'سبب الإرجاع']]);
  assert.equal(printTextEntry('tot.vat')!.lock, 'fixed');
});

test('القائمة: إعادة الصياغة لكل ما ليس fixed ولا يُخفى فقط، واللغة الثانية لكل ما ليس يُخفى فقط', () => {
  for (const x of PRINT_TEXT_CATALOG) {
    assert.equal(printTextRewordable(x), x.lock !== 'fixed' && !x.hideOnly, x.key);
    assert.equal(printTextAltEditable(x), !x.hideOnly, x.key);
  }
  for (const m of Object.values(PRINT_TEXTS_ISSUES)) assert.match(m, /^[؀-ۿ]/, `رسالة غير عربية: ${m}`);
});

test('نظافة النواة: الملف يبدأ برأس «// ====» ولا يستورد إلا zod (تُنسخ حرفياً للواجهة)', () => {
  const core = read('services', 'printTextsCore.ts');
  assert.ok(core.startsWith('// ===='));
  const imports = [...core.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['zod']);
  assert.doesNotMatch(core, /\brequire\(|\bimport\(|process\.env/);
  // والخدمة لا تستورد غير النواة
  const svc = read('services', 'printTexts.ts');
  assert.deepEqual([...svc.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]), ['./printTextsCore']);
});

// ═══ المعالجات الحقيقية فوق Prisma مزيّف ═══

type Row = Record<string, any>;
const T = 'T1';
const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
let st: { admin: Row | null; settings: Row | null };
let writes: Row[] = [];
let reads: Row[] = [];
function reset(): void {
  writes = [];
  reads = [];
  st = { admin: { isActive: true, canManageCompanySettings: true }, settings: { tenantId: T, name: 'شركة', printTexts: null } };
}
reset();
const db: Row = {
  admin: { async findUnique() { return st.admin; } },
  companySettings: {
    async findUnique(a: Row) {
      reads.push(a);
      if (!st.settings || a.where.tenantId !== st.settings.tenantId) return null;
      return { printTexts: st.settings.printTexts };
    },
    async updateMany(a: Row) {
      writes.push(a);
      if (!st.settings || a.where.tenantId !== st.settings.tenantId) return { count: 0 };
      // Prisma.DbNull = NULL في العمود (كما تكتبه قاعدة البيانات)
      Object.assign(st.settings, a.data, a.data.printTexts === Prisma.DbNull ? { printTexts: null } : {});
      return { count: 1 };
    },
    async upsert() { throw new Error('لا upsert'); },
    async create() { throw new Error('لا create'); },
  },
};
stub('config/database', { default: db });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('../routes/printTexts') as typeof import('../routes/printTexts')).default;

/** يشغّل مكدّس المسار كلّه (حرّاسه ثم معالجه) — المصادقة قبله في routes/company.ts */
async function call(method: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as unknown as { stack: Row[] }).stack.find((l) => l.route?.path === '/' && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} / مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', tenantId: T }, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}
const rep = { id: 'R1', role: 'SALES_REP', tenantId: T };
const manager = { id: 'M1', role: 'MANAGER', tenantId: T };

test('القراءة تشغيلاً: لكل مسجّل (والمندوب يطبع بها)، null ⇒ نصوص اليوم، والمحفوظ كما هو، والتالف ⇒ الافتراضي، وبلا صفّ hasCompany:false', async () => {
  reset();
  const none = await call('get', { user: rep });
  assert.equal(none.status, 200);
  assert.deepEqual(none.body, { success: true, data: emptyPrintTexts(), stored: false, hasCompany: true });
  assert.deepEqual(reads[0], { where: { tenantId: T }, select: { printTexts: true } }, 'العمود وحده من صفّ الشركة');
  st.settings!.printTexts = sample();
  assert.deepEqual((await call('get', { user: rep })).body, { success: true, data: sample(), stored: true, hasCompany: true });
  // مفتاحٌ أضافه خادمٌ أحدث يُهمل ولا يُسقط الإعداد
  st.settings!.printTexts = { ...sample(), futureField: true };
  assert.deepEqual((await call('get', {})).body.data, sample());
  // التالف يُقرأ افتراضياً (والتحذير في السجلّ مختبرٌ في storedPrintTexts أعلاه — يُكتم هنا)
  st.settings!.printTexts = { ...sample(), version: 9 };
  const orig = console.warn;
  console.warn = () => {};
  try {
    const b = await call('get', {});
    assert.deepEqual([b.body.data, b.body.stored], [emptyPrintTexts(), false]);
  } finally { console.warn = orig; }
  st.settings = null;
  assert.deepEqual((await call('get', {})).body, { success: true, data: emptyPrintTexts(), stored: false, hasCompany: false });
});

test('الحفظ تشغيلاً: المندوب والمستخدم بلا صلاحية إعدادات الشركة ⇒ 403 بلا كتابة، والمخوَّل يكتب الصورة القانونية كتابةً واحدة', async () => {
  reset();
  assert.equal((await call('put', { user: rep, body: sample() })).status, 403);
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await call('put', { user: manager, body: sample() })).status, 403);
  assert.equal(writes.length, 0, 'لا كتابة عند الرفض');
  st.admin = { isActive: true, canManageCompanySettings: true };
  const body = clone(sample());
  body.edits['h.phone'].text = '  الهاتف  ';
  body.companyNameAlt = ' Al Riyada   Distribution ';
  const ok = await call('put', { user: manager, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, { success: true, data: sample(), stored: true, hasCompany: true });
  assert.deepEqual(writes, [{ where: { tenantId: T }, data: { printTexts: sample() } }]);
  assert.deepEqual((await call('get', { user: rep })).body.data, sample());
  // جلسة دخول المالك تمرّ كالمدير الذي تمثّله
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await call('put', { user: { id: 'ADM', role: 'ADMIN', tenantId: T, impersonated: true }, body: sample() })).status, 200);
});

test('الحفظ تشغيلاً: إعدادٌ بلا أثر يُكتب NULL (لا كائناً) والردّ غير مخصّص — والمرفوض 400 والكبير 413 بلا كتابة', async () => {
  reset();
  st.settings!.printTexts = sample();
  const blank = await call('put', { body: withEdits({ 'h.phone': { text: '   ' } }, { companyNameAlt: ' ' }) });
  assert.deepEqual([blank.status, blank.body], [200, { success: true, data: emptyPrintTexts(), stored: false, hasCompany: true }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].data.printTexts, Prisma.DbNull, 'NULL حرفياً');
  assert.equal(st.settings!.printTexts, null);

  reset();
  const locked = await call('put', { body: withEdits({ 'tot.grand': { hidden: true } }) });
  assert.deepEqual([locked.status, locked.body.success, locked.body.code, locked.body.message], [400, false, 'PRINT_TEXTS_INVALID', PRINT_TEXTS_ISSUES.locked]);
  assert.deepEqual(locked.body.issues, [{ path: 'edits.tot.grand.hidden', message: PRINT_TEXTS_ISSUES.locked }]);
  assert.equal((await call('put', { body: withEdits({ 'tot.vat': { text: 'الضريبة' } }) })).body.message, PRINT_TEXTS_ISSUES.fixed);
  assert.equal((await call('put', { body: { ...sample(), extra: 1 } })).body.message, PRINT_TEXTS_ISSUES.unknownKey);
  const big = await call('put', { body: { ...sample(), pad: 'x'.repeat(PRINT_TEXTS_LIMITS.maxBytes + 1000) } });
  assert.deepEqual([big.status, big.body.code], [413, 'PRINT_TEXTS_TOO_LARGE']);
  assert.equal(writes.length, 0);
  assert.equal(st.settings!.printTexts, null);
});

test('الحفظ تشغيلاً: بلا صفّ إعدادات ⇒ 409 COMPANY_SETTINGS_MISSING بلا إنشاء', async () => {
  reset();
  st.settings = null;
  const r = await call('put', { body: sample() });
  assert.deepEqual([r.status, r.body.success, r.body.code, r.body.message], [409, false, 'COMPANY_SETTINGS_MISSING', 'احفظ بيانات الشركة أولا']);
  // المحاولة updateMany وحدها (المزيّف يرمي على upsert/create)
  assert.deepEqual(writes.map((w) => w.where), [{ tenantId: T }]);
});

test('«استعادة النصوص الافتراضية» تشغيلاً: { reset: true } أو null ⇒ العمود NULL، بحرّاس الحفظ نفسها', async () => {
  reset();
  st.settings!.printTexts = sample();
  const r = await call('put', { body: { reset: true } });
  assert.deepEqual([r.status, r.body], [200, { success: true, data: emptyPrintTexts(), stored: false, hasCompany: true }]);
  assert.equal(writes[0].data.printTexts, Prisma.DbNull);
  assert.equal(st.settings!.printTexts, null);
  assert.deepEqual((await call('get', { user: rep })).body, { success: true, data: emptyPrintTexts(), stored: false, hasCompany: true });
  st.settings!.printTexts = sample();
  assert.equal((await call('put', { body: null })).status, 200);
  assert.equal(st.settings!.printTexts, null);
  // الحرّاس نفسها: المندوب 403 بلا كتابة، وبلا صفّ 409
  writes = [];
  st.settings!.printTexts = sample();
  assert.equal((await call('put', { user: rep, body: { reset: true } })).status, 403);
  st.admin = { isActive: true, canManageCompanySettings: false };
  assert.equal((await call('put', { user: manager, body: { reset: true } })).status, 403);
  assert.equal(writes.length, 0);
  assert.deepEqual(st.settings!.printTexts, sample());
  st.admin = { isActive: true, canManageCompanySettings: true };
  st.settings = null;
  assert.deepEqual((await call('put', { body: { reset: true } })).body.code, 'COMPANY_SETTINGS_MISSING');
  // ما ليس إعادةً صريحة يمرّ بالتحليل الصارم
  reset();
  assert.equal((await call('put', { body: { reset: false } })).status, 400);
  assert.equal((await call('put', { body: { reset: true, extra: 1 } })).status, 400);
  assert.equal(writes.length, 0);
});

// ═══ حرّاس نصّية ═══

test('حارس نصّي: الحفظ بصلاحية إعدادات الشركة، والقراءة بلا حارس إضافي، والكتابة updateMany وحدها وNULL للإعادة', () => {
  const r = read('routes', 'printTexts.ts');
  assert.ok(r.includes("router.put('/', requireAdmin, requireAdminPermission('canManageCompanySettings'), async"));
  assert.ok(r.includes("router.get('/', async"), 'القراءة لكل مسجّل — المندوب يطبع بها');
  assert.doesNotMatch(r, /router\.use\(/, 'لا حارس عامّ يمنع المندوب من القراءة');
  assert.ok(r.includes('prisma.companySettings.updateMany({\n      where: { tenantId: tid },'), 'كتابة على صفّ الشركة وحده');
  assert.doesNotMatch(r, /companySettings\.(upsert|create)\(/, 'لا upsert يخترع صفّاً');
  assert.ok(r.includes('value === null ? Prisma.DbNull'), 'الإعادة وما لا أثر له NULL في العمود');
  assert.ok(/if \(r\.count === 0\) \{\s*res\.status\(409\)\.json\(\{ success: false, code: 'COMPANY_SETTINGS_MISSING'/.test(r));
  const c = read('routes', 'company.ts');
  assert.equal(c.split("import printTextsRouter from './printTexts';").length - 1, 1, 'استيرادٌ بسطرٍ واحد');
  const auth = c.indexOf('router.use(authenticate);');
  const mount = c.indexOf("router.use('/print-texts', printTextsRouter);");
  assert.ok(auth > 0 && mount > auth, 'المسار بعد المصادقة');
  assert.ok(mount < c.indexOf("router.get('/'"), 'قبل مسارات الشركة');
});

test('حارس نصّي: PUT /api/company وcompanySchema لم يُمسّا — والعمود إضافي اختياري في CompanySettings', () => {
  const c = read('routes', 'company.ts');
  const start = c.indexOf('const companySchema = z.object({');
  assert.ok(start > 0);
  const schemaBlock = c.slice(start, c.indexOf('});', start));
  assert.doesNotMatch(schemaBlock, /print/i, 'نصوص المطبوعات ليست حقلاً في PUT /api/company');
  const put = c.slice(c.indexOf("router.put('/'"), c.indexOf('export default router'));
  assert.doesNotMatch(put, /printTexts/);
  assert.equal(put.split('prisma.companySettings.findUnique(').length - 1, 2, 'قراءتا قفل ZATCA كما هما');
  const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  const i = schema.indexOf('model CompanySettings {');
  const block = schema.slice(i, schema.indexOf('\n}', i));
  assert.match(block, /\n\s*printTexts\s+Json\?\s*\n/, 'printTexts Json? بلا افتراضي (null = نصوص اليوم)');
  assert.equal(schema.split(/\n\s*printTexts\s+Json\?/).length - 1, 1, 'في CompanySettings وحده');
});
