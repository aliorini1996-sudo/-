// «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦): باركود الصنف (عمود «الباركود») وملاحظات الفاتورة (حقل «الملاحظات»)
// على ورقة الإصدار في تطبيق المندوب ونافذة الفاتورة في لوحة الإدارة — حين توجد قيمةٌ وحدها، فالشكل كما كان لكل مستندٍ بلاها (الحرّاس
// الذهبية لا تتغيّر). حرّاسٌ مصدرية: الملفّان يستوردان العميل والخادم فلا يُحمّلان في node، والمساعدان يُفحصان بنصّهما وسلوكهما.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

/** ترجمة مقتطفٍ من TS إلى JS (كـcardPayDevice.test.ts) */
const js = (tsSrc: string): string => ts.transpileModule(tsSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** دالّةٌ من المصدر بجسمها حتى أوّل «}» في بداية سطر — مترجمةً إلى JS */
function fnFrom(src: string, head: string): string {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  const end = src.indexOf('\n}\n', at);
  return js(src.slice(at, end + 2));
}

test('المندوب: باركود الصنف من صفّ الكتالوج في بنود الورقة، وملاحظات الفاتورة من ردّ الخادم — حين توجد وحدها', () => {
  const rep = read('./RepApp.tsx');
  const items = rep.slice(rep.indexOf('const printItems = lines.map((l, i) => ({'), rep.indexOf('const txtOr = (v: unknown'));
  assert.ok(items.includes('...docItemBarcode(products.find(x => x.id === l.productId)?.barcode),'), 'الباركود في بنود الإصدار (والأوف‑لاين والمرتجع منها)');
  assert.ok(items.includes('...docItemCode(products.find(x => x.id === l.productId)?.code ?? l.code),'), 'رمز الصنف كما كان');
  assert.equal((rep.match(/\.\.\.docNotes\((row|inv)\.notes\),/g) || []).length, 2, 'الملاحظات في ورقتي الإصدار المتصل (المعلّق وسند التسليم)');
  // السلوك: لا مفتاح بلا قيمة
  const code = `${fnFrom(rep, 'function docItemBarcode(')}\n${fnFrom(rep, 'function docNotes(')}\nreturn { docItemBarcode, docNotes };`;
  const { docItemBarcode, docNotes } = new Function(code)() as {
    docItemBarcode: (b: unknown) => { barcode?: string }; docNotes: (n: unknown) => { notes?: string };
  };
  assert.deepEqual(docItemBarcode(' 6281000001001 '), { barcode: '6281000001001' });
  assert.deepEqual(docItemBarcode(6281000001001), { barcode: '6281000001001' });
  for (const none of [undefined, null, '', '   ', Number.NaN, {}]) assert.deepEqual(docItemBarcode(none), {}, String(none));
  assert.deepEqual(docNotes(' سلّم للمستودع '), { notes: 'سلّم للمستودع' });
  for (const none of [undefined, null, '', '  ', 5]) assert.deepEqual(docNotes(none), {}, String(none));
});

test('تاريخ الاستحقاق (آخر قسطٍ من ردّ الخادم) على ورقة الإصدار كإعادة الفتح — وخطة الدفع في نافذة اللوحة («تقسيط» لا «آجل»)', () => {
  const rep = read('./RepApp.tsx');
  assert.equal((rep.match(/\.\.\.docDueDate\((row|inv)\.dueDate\),/g) || []).length, 2, 'ورقتا الإصدار المتصل (سند التسليم والمعتمدة)');
  const fromRep = new Function(`${fnFrom(rep, 'function docDueDate(')}\nreturn docDueDate;`)() as (d: unknown) => { dueDate?: string };
  assert.deepEqual(fromRep('2026-12-07T00:00:00.000Z'), { dueDate: '2026-12-07T00:00:00.000Z' });
  for (const none of [undefined, null, '', '  ', 'not a date', 5]) assert.deepEqual(fromRep(none), {}, String(none));
  const m = read('../components/forms/InvoiceModal.tsx');
  assert.equal((m.match(/\.\.\.docDueDate\(inv\.dueDate\),/g) || []).length, 2, 'ورقتا البيع والمرتجع');
  assert.equal((m.match(/paymentPlan: inv\.paymentPlan \?\? null,/g) || []).length, 1, 'خطة الدفع في ورقة البيع');
  const helpers = m.slice(m.indexOf('const docText = (v: unknown)'), m.indexOf('\n}\n', m.indexOf('function docDueDate(')) + 3);
  const fromModal = new Function(`${js(helpers)}\nreturn docDueDate;`)() as (d: unknown) => { dueDate?: string };
  assert.deepEqual(fromModal(' 2026-12-07 '), { dueDate: '2026-12-07' });
  for (const none of [undefined, null, '', 'x']) assert.deepEqual(fromModal(none), {}, String(none));
});

test('لوحة الإدارة: باركود الصنف في بنود البيع والمرتجع، والملاحظات من ردّ الخادم وإلا ممّا أُرسل — حين توجد وحدها', () => {
  const m = read('../components/forms/InvoiceModal.tsx');
  assert.ok(m.includes('}).map((it, i) => ({ ...it, ...docBarcode(rowProduct(i)?.barcode) })),'), 'المرتجع');
  assert.ok(m.includes('return { ...it, ...docGridFields(row, pid, (products || []).find(p => p.id === pid)?.code) };'), 'رمز الصنف في المرتجع كما كان');
  assert.ok(m.includes('...docBarcode((products || []).find(p => p.id === l.productId)?.barcode),'), 'البيع');
  assert.equal((m.match(/\.\.\.docNotes\(inv\.notes, notes\),/g) || []).length, 2, 'الملاحظات في ورقتي البيع والمرتجع');
  const helpers = m.slice(m.indexOf('const docText = (v: unknown)'), m.indexOf('\n}\n', m.indexOf('function docNotes(')) + 3);
  const code = `${js(helpers)}\nreturn { docBarcode, docNotes };`;
  const { docBarcode, docNotes } = new Function(code)() as {
    docBarcode: (b: unknown) => { barcode?: string }; docNotes: (saved: unknown, sent: unknown) => { notes?: string };
  };
  assert.deepEqual(docBarcode('  123 '), { barcode: '123' });
  assert.deepEqual(docBarcode(undefined), {});
  assert.deepEqual(docBarcode(''), {});
  assert.deepEqual(docNotes('من الخادم', 'مرسلة'), { notes: 'من الخادم' });
  assert.deepEqual(docNotes(null, ' مرسلة '), { notes: 'مرسلة' });
  assert.deepEqual(docNotes(null, ''), {});
  assert.deepEqual(docNotes(undefined, undefined), {});
});
