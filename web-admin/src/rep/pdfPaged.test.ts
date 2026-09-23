import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PDF_PAGE_HEIGHT_PX, PDF_PAGE_WIDTH_PX, PDF_ROW_HEIGHT_PX,
  defaultRowHeight, escapeHtml, levelPaddingPx, pageFooterText, paginateRows, pdfBodyHeight, pdfCaptureScale,
  type PagedPdfRow,
} from './pdfPaged';

/**
 * حرّاس التقطيع والترقيم (DESIGN.md §7.1 البند 6).
 *
 * ما تحرسه: **لا يُكسر صفٌّ بين صفحتين أبداً** (الكسر السابق في `elementToPdfBlob` كان يقصّ
 * الصورة بارتفاع الصفحة فيقع القصّ في منتصف السطر)، و«صفحة n من N» صحيحٌ على كل صفحة،
 * وصفّ «رصيد مُرحَّل» يتكرر أعلى الصفحات التالية للحساب نفسه ولا يُعاد فوق نفسه.
 */

const row = (text: string, extra: Partial<PagedPdfRow> = {}): PagedPdfRow => ({ cells: [text], ...extra });
const many = (n: number, prefix = 'س'): PagedPdfRow[] =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i + 1}`));

test('صفحة A4 بعرض ثابت 794px ونسبتها نسبة A4', () => {
  assert.equal(PDF_PAGE_WIDTH_PX, 794);
  const ratio = PDF_PAGE_WIDTH_PX / PDF_PAGE_HEIGHT_PX;
  // نسبة A4 = 210/297؛ الفارق دون نصف بالمئة فلا تشويه في الالتقاط
  assert.ok(Math.abs(ratio - 210 / 297) < 0.005, `النسبة ${ratio}`);
});

test('ارتفاع الجسم يترك مكاناً للترويسة المتكررة ويقلّ كلما طالت', () => {
  assert.ok(pdfBodyHeight(0) < PDF_PAGE_HEIGHT_PX);
  assert.ok(pdfBodyHeight(4) < pdfBodyHeight(0));
  assert.ok(pdfBodyHeight(0) > PDF_ROW_HEIGHT_PX * 10, 'صفحة تسع عشرات الصفوف');
});

test('لا صفحات لمدخل فارغ', () => {
  assert.deepEqual(paginateRows([]), []);
});

test('الصفوف القليلة صفحة واحدة، و«صفحة 1 من 1»', () => {
  const pages = paginateRows(many(5));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].index, 1);
  assert.equal(pages[0].total, 1);
  assert.equal(pageFooterText(pages[0].index, pages[0].total), 'صفحة 1 من 1');
});

test('كل صفّ يقع في صفحة واحدة بتمامه ولا يتكرر ولا يسقط', () => {
  const rows = many(437);
  const pages = paginateRows(rows, { bodyHeight: 300, rowHeight: 22 });
  const flat = pages.flatMap((p) => p.rows);
  assert.equal(flat.length, rows.length, 'لا صفّ ضائع ولا مكرَّر');
  assert.deepEqual(flat.map((r) => r.cells[0]), rows.map((r) => r.cells[0]), 'الترتيب محفوظ');
  assert.ok(pages.length > 1, 'تعدّدت الصفحات فعلاً');
});

test('مجموع ارتفاع صفوف أي صفحة لا يتجاوز ارتفاع الجسم', () => {
  const bodyHeight = 300;
  const pages = paginateRows(many(120), { bodyHeight, rowHeight: 22 });
  for (const p of pages) {
    const h = p.rows.reduce((s, r) => s + defaultRowHeight(r, { rowHeight: 22 }), 0);
    assert.ok(h <= bodyHeight, `صفحة ${p.index} بارتفاع ${h} تجاوزت ${bodyHeight}`);
  }
});

test('الترقيم متسلسل والإجمالي واحدٌ على كل الصفحات', () => {
  const pages = paginateRows(many(77), { bodyHeight: 220, rowHeight: 22 });
  pages.forEach((p, i) => {
    assert.equal(p.index, i + 1);
    assert.equal(p.total, pages.length);
  });
  const last = pages[pages.length - 1];
  assert.equal(pageFooterText(last.index, last.total), `صفحة ${pages.length} من ${pages.length}`);
});

test('صفّ أطول من الصفحة يأخذ صفحته كاملاً بلا قصّ ولا حلقة لا نهائية', () => {
  const rows: PagedPdfRow[] = [row('قبل'), row('عملاق', { head: true }), row('بعد')];
  const pages = paginateRows(rows, { bodyHeight: 20, rowHeight: 22, headRowHeight: 900 });
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => p.rows.length), [1, 1, 1]);
  assert.equal(pages[1].rows[0].cells[0], 'عملاق');
});

test('صفّ «رصيد مُرحَّل» يتكرر أعلى صفحات الحساب التالية ولا يُعاد فوق نفسه', () => {
  const rows: PagedPdfRow[] = [row('مُرحَّل ١', { carry: true }), ...many(40, 'ب')];
  const pages = paginateRows(rows, { bodyHeight: 220, rowHeight: 22 });
  assert.ok(pages.length > 2, 'تعدّدت الصفحات');
  assert.equal(pages[0].carry, null, 'الصفحة التي تحمل الصفّ الأصلي لا تكرّره');
  for (const p of pages.slice(1)) {
    assert.ok(p.carry, `الصفحة ${p.index} بلا رصيد مُرحَّل`);
    assert.equal(p.carry?.cells[0], 'مُرحَّل ١');
  }
});

test('المُرحَّل يتبدّل مع الحساب التالي ولا يبقى مُرحَّل الحساب السابق', () => {
  const rows: PagedPdfRow[] = [
    row('مُرحَّل أ', { carry: true }), ...many(20, 'أ'),
    row('مُرحَّل ب', { carry: true }), ...many(20, 'ب'),
  ];
  const pages = paginateRows(rows, { bodyHeight: 220, rowHeight: 22 });
  const pageOf = (text: string) => pages.findIndex((p) => p.rows.some((r) => r.cells[0] === text));
  const bIdx = pageOf('ب20');
  assert.ok(bIdx >= 0);
  const carryOfLast = pages[bIdx].carry;
  // آخر صفحة تحمل سطور «ب» يجب أن تُرحّل رصيد «ب» لا رصيد «أ»
  if (carryOfLast) assert.equal(carryOfLast.cells[0], 'مُرحَّل ب');
});

test('ارتفاع المُرحَّل محجوز: صفحةٌ تكرّره تحمل صفوفاً أقلّ من صفحة بلا تكرار', () => {
  const plain = paginateRows(many(60), { bodyHeight: 220, rowHeight: 22 });
  const withCarry = paginateRows([row('مُرحَّل', { carry: true }), ...many(60)], { bodyHeight: 220, rowHeight: 22 });
  const second = withCarry[1];
  assert.ok(second.carry, 'الصفحة الثانية تكرّر المُرحَّل');
  assert.ok(second.rows.length < plain[1].rows.length, 'حُجز ارتفاع الصفّ المكرَّر');
});

test('مقياس الالتقاط 2 على سطح المكتب و1.5 على اللمس', () => {
  assert.equal(pdfCaptureScale(0), 2);
  assert.equal(pdfCaptureScale(1), 1.5);
  assert.equal(pdfCaptureScale(5), 1.5);
});

test('نصّ التذييل يمرّ على المترجم', () => {
  const tr = (ar: string) => ({ صفحة: 'Page', من: 'of' } as Record<string, string>)[ar] ?? ar;
  assert.equal(pageFooterText(3, 9, tr), 'Page 3 of 9');
});

test('الهروب يمنع حقن HTML من بيان قيد', () => {
  assert.equal(escapeHtml('<b>&"x"'), '&lt;b&gt;&amp;&quot;x&quot;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('إزاحة الشجرة تنمو بالعمق وتتوقّف عند سقف', () => {
  assert.equal(levelPaddingPx(0), 0);
  assert.ok(levelPaddingPx(2) > levelPaddingPx(1));
  assert.equal(levelPaddingPx(20), levelPaddingPx(8), 'سقفٌ فلا تُدفع الأعمدة خارج الصفحة');
  assert.equal(levelPaddingPx(undefined), 0);
  assert.equal(levelPaddingPx(-3), 0);
});
