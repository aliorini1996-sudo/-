// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — مصدر العرض والمطابقة في الواجهة (lib/customerNumber.ts) والمنتقي المشترك:
//   • customerNumberQuery بقاعدة الخادم نفسها حرفاً بحرف (backend/src/services/customerNumber.ts) — والحالات نفسها في اختباره.
//   • المطابقة دقيقة: «1» لا يطابق 12، والجوال «05…» ليس رقم عميل.
//   • العرض بأرقام لاتينية '#12 · الاسم' (String لا formatNumber)، و'—' في الجدول حتى يُرقَّم القديم.
//   • الكود الآلي (cuid) لا يُعرض والمخصّص يبقى.
//   • SearchableSelect: num بادئةٌ تُطابَق بالضبط لا بالاحتواء، وkeywords بالاحتواء، وصاحب الرقم أوّلاً؛ والأصناف كما كانت.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CUSTOMER_NUMBER_MAX, customerNumberQuery, matchesCustomerNumber, formatCustomerNumber, customerNumberCell,
  formatCustomerLabel, isAutoCustomerCode, visibleCustomerCode,
} from './customerNumber';
import SearchableSelect, { filterSelectOptions, exactNumberFirst, type SelectOption } from '../components/SearchableSelect';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

// ═══ نصّ البحث ═══

test('customerNumberQuery: يُقصّ وتُنزع # وتُوحَّد الأرقام، بلا صفرٍ بادئ ولا تجاوزٍ لـint4، وغير النصّ null', () => {
  const cases: Array<[unknown, number | null]> = [
    ['12', 12], [' #12 ', 12], ['# ١٢', 12], ['۱۲', 12], ['＃7', 7], ['#  ٣٤٥', 345], ['2147483647', 2147483647],
    ['05', null], ['0', null], ['12a', null], ['99999999999', null], ['2147483648', null], [12, null], ['', null],
    ['#', null], ['##12', null], ['1 2', null], ['-3', null], ['+3', null], ['1.5', null], ['12#', null], [null, null], [undefined, null],
    ['٠٥٠١٢٣', null], ['سمارة', null],
    // بعد # وحده: الأصفار البادئة حشوٌ لرقم عميل (كالخادم) — وبلا # تبقى بادئة جوال
    ['#007', 7], ['#٠١٢', 12], ['# 012', 12], ['#0', null], ['#000', null], ['012', null], ['007', null],
  ];
  for (const [q, want] of cases) assert.equal(customerNumberQuery(q), want, JSON.stringify(q));
  assert.equal(CUSTOMER_NUMBER_MAX, 2147483647);
});

test('القاعدة نفسها في الخادم: الدالّة متطابقة نصّاً (عدا اسم المعامل) مع backend/src/services/customerNumber.ts', () => {
  const be = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'services', 'customerNumber.ts'), 'utf8').replace(/\r\n/g, '\n');
  const web = read('lib', 'customerNumber.ts');
  const body = (src: string) => {
    const at = src.indexOf('export function customerNumberQuery(');
    return src.slice(src.indexOf('{', at), src.indexOf('\n}\n', at)).replace(/\braw\b/g, 'q');
  };
  assert.equal(body(web), body(be));
  assert.match(be, /CUSTOMER_NUMBER_MAX = 2147483647;/);
});

test('matchesCustomerNumber: مطابقةٌ دقيقة لا احتواء، والعميل بلا رقم لا يطابق شيئاً', () => {
  assert.equal(matchesCustomerNumber('12', 12), true);
  assert.equal(matchesCustomerNumber('#١٢', 12), true);
  assert.equal(matchesCustomerNumber('1', 12), false);
  assert.equal(matchesCustomerNumber('120', 12), false);
  assert.equal(matchesCustomerNumber('012', 12), false);
  assert.equal(matchesCustomerNumber('12', null), false);
  assert.equal(matchesCustomerNumber('12', undefined), false);
  assert.equal(matchesCustomerNumber('', 12), false);
});

// ═══ العرض ═══

test('العرض: «#12» بأرقام لاتينية بلا فواصل آلاف، و«—» في الجدول حتى يُرقَّم، والتسمية «#12 · الاسم»', () => {
  assert.equal(formatCustomerNumber(12), '#12');
  assert.equal(formatCustomerNumber(1234567), '#1234567');
  for (const bad of [null, undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(formatCustomerNumber(bad as number), '', String(bad));
    assert.equal(customerNumberCell(bad as number), '—', String(bad));
  }
  assert.equal(customerNumberCell(7), '#7');
  assert.equal(formatCustomerLabel({ name: 'مؤسسة سمارة', number: 12 }), '#12 · مؤسسة سمارة');
  assert.equal(formatCustomerLabel({ name: 'مؤسسة سمارة', number: null }), 'مؤسسة سمارة');
  assert.equal(formatCustomerLabel({ name: 'مؤسسة سمارة' }), 'مؤسسة سمارة');
  // الفاصل U+00B7 بين مسافتين
  assert.equal(formatCustomerLabel({ name: 'x', number: 3 }).charCodeAt(3), 0x00b7);
  // لا formatNumber ولا toLocaleString (الرقم مُعرِّف لا كمّية)
  assert.doesNotMatch(read('lib', 'customerNumber.ts'), /formatNumber\(|toLocaleString\(|^import /m);
});

test('الكود الآلي (cuid) أو الفارغ لا يُعرض، والكود المخصّص يبقى كما هو', () => {
  for (const auto of ['', '  ', null, undefined, 'cmhx3k9q20001ab12cd34ef56', 'clq0a1b2c3d4e5f6g7h8i9j0k']) {
    assert.equal(isAutoCustomerCode(auto), true, String(auto));
    assert.equal(visibleCustomerCode(auto), '', String(auto));
  }
  for (const custom of ['C-100', 'CUST001', '12', 'cust-1', 'c123', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
    assert.equal(isAutoCustomerCode(custom), false, custom);
    assert.equal(visibleCustomerCode(custom), custom);
  }
  assert.equal(visibleCustomerCode('  C-7 '), 'C-7');
});

// ═══ المنتقي المشترك SearchableSelect ═══

const customers: SelectOption[] = [
  { value: 'a', label: 'بقالة النور', hint: '0551200000', num: 3 },
  { value: 'b', label: 'مؤسسة سمارة', hint: '0500000012', num: 12 },
  { value: 'c', label: 'تموينات 12 الحي', num: 7, keywords: ['C-500', null, 'شركة الواحة التجارية'] },
  { value: 'd', label: 'محل قديم', num: null },
  { value: 'e', label: 'سوق الريان', num: 120 },
];
const values = (opts: SelectOption[]) => opts.map(o => o.value);

test('filterSelectOptions: الرقم بالضبط أوّلاً ثم من طابق اسمه أو جواله بالاحتواء — لا «1» يطابق 12 ولا 120', () => {
  assert.deepEqual(values(filterSelectOptions(customers, '12')), ['b', 'a', 'c']);
  assert.deepEqual(values(filterSelectOptions(customers, '#١٢')), ['b']);
  assert.deepEqual(values(filterSelectOptions(customers, '120')), ['e', 'a']);
  assert.deepEqual(values(filterSelectOptions(customers, '7')), ['c']);
  assert.deepEqual(values(filterSelectOptions(customers, '#3')), ['a']);
  // «05» بادئة جوال لا رقم: احتواءٌ في الجوال وحده
  assert.deepEqual(values(filterSelectOptions(customers, '05')), ['a', 'b']);
  // keywords بالاحتواء (بلا اعتبار لحالة الأحرف)، والفارغة منها لا تُسقط
  assert.deepEqual(values(filterSelectOptions(customers, 'c-5')), ['c']);
  assert.deepEqual(values(filterSelectOptions(customers, 'الواحة')), ['c']);
  // بلا نصّ: الكل بترتيبه
  assert.deepEqual(values(filterSelectOptions(customers, '')), ['a', 'b', 'c', 'd', 'e']);
});

test('filterSelectOptions: خيارات بلا num (الأصناف) كما كانت حرفاً — احتواء الاسم أو النص الثانوي بلا قصّ ولا ترتيب', () => {
  const products: SelectOption[] = [
    { value: 'p1', label: 'Water 12', hint: '12.00 ر.س' },
    { value: 'p2', label: 'Juice', hint: '5.50 ر.س' },
    { value: 'p3', label: 'Milk 1L', hint: 'رصيد 12' },
  ];
  const old = (opts: SelectOption[], q: string) => opts.filter(o =>
    o.label.toLowerCase().includes(q.toLowerCase()) ||
    (o.hint || '').toLowerCase().includes(q.toLowerCase()));
  for (const q of ['', '12', 'water', 'JUICE', ' 12', '1', 'xyz', '#12', 'ر.س']) {
    assert.deepEqual(filterSelectOptions(products, q), old(products, q), JSON.stringify(q));
  }
});

test('exactNumberFirst: يقدّم صاحب الرقم بلا تصفية (نتائج الخادم)، وبلا مطابقةٍ يُعيد القائمة نفسها', () => {
  assert.deepEqual(values(exactNumberFirst(customers, '120')), ['e', 'a', 'b', 'c', 'd']);
  assert.equal(exactNumberFirst(customers, 'سمارة'), customers);
  assert.equal(exactNumberFirst(customers, '999'), customers);
});

test('SearchableSelect مصيَّراً: الخيار المختار يُعرض «#12 · الاسم» والرقم في عنصرٍ ltr بأرقامٍ جدولية، وبلا رقم كما كان', () => {
  const render = (value: string, options = customers) =>
    renderToStaticMarkup(h(SearchableSelect, { options, value, onChange: () => {} }));
  const withNum = render('b');
  assert.ok(withNum.includes('<span dir="ltr" class="tabular-nums text-gray-500">#12</span><span class="text-gray-500"> · </span>مؤسسة سمارة'), withNum);
  const noNum = render('d');
  assert.ok(noNum.includes('>محل قديم</span>') && !noNum.includes('tabular-nums') && !noNum.includes(' · '), noNum);
  assert.ok(render('').includes('>اختر</span>'));
  const dark = renderToStaticMarkup(h(SearchableSelect, { options: customers, value: 'a', onChange: () => {}, dark: true }));
  assert.ok(dark.includes('<span dir="ltr" class="tabular-nums text-[#9A8F7E]">#3</span>'), dark);
});

test('SearchableSelect: التوصيل في المصدر — التصفية والصفوف والزر وEnter، وسطر الإغلاق المثبّت في repTargetsAudit كما هو', () => {
  const s = read('components', 'SearchableSelect.tsx');
  assert.ok(s.includes("setOpen(false); setQ(''); } };"));
  assert.ok(s.includes('const filtered = onSearchChange ? exactNumberFirst(options, q) : filterSelectOptions(options, q);'));
  assert.ok(s.includes('{selected ? <><NumPrefix num={selected.num} dark={dark} />{selected.label}</> : placeholder}'));
  assert.ok(s.includes('<NumPrefix num={o.num} dark={dark} />\n                  <span className="font-medium">{o.label}</span>'));
  assert.ok(s.includes("if (e.key === 'Enter' && enterPick)"));
  // الرقم لا يدخل أي نصٍّ يُطابَق بالاحتواء
  const fn = s.slice(s.indexOf('export function filterSelectOptions('), s.indexOf('export function exactNumberFirst('));
  assert.doesNotMatch(fn, /String\(o\.num\)|`#\$\{|formatCustomer/);
});
