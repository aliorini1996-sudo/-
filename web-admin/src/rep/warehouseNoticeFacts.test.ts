import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { noticeRef, adjustTotals, receiveTotalQty, isCosted, uncostedCount } from './warehouseNoticeFacts';

/**
 * حرّاس إشعار الوارد والتسوية في مخزون الشركة — ورقةٌ يوقّعها أمين المستودع.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('مرجع الحركة قصيرٌ ثابتٌ يُقرأ على ورقة', () => {
  assert.equal(noticeRef('3f2a9c1e-77bd-4e21-9a0b-55aa12cd34ef'), '3F2A9C1E');
  assert.equal(noticeRef('3f2a9c1e-77bd-4e21-9a0b-55aa12cd34ef'), noticeRef('3f2a9c1e-77bd-4e21-9a0b-55aa12cd34ef'), 'المرجع نفسه في كل إصدار');
  assert.equal(noticeRef(''), '');
});

test('التسوية تُطبع زيادتها ونقصها منفصلين — لا صافياً يخفي الحركة', () => {
  // +١٠ من صنفٍ و−١٠ من آخر: صافيها صفر، وقد نقلت عشرين
  assert.deepEqual(adjustTotals([{ qty: 10 }, { qty: -10 }]), { added: 10, removed: 10 });
  assert.deepEqual(adjustTotals([{ qty: -3 }, { qty: -2.5 }]), { added: 0, removed: 5.5 });
  assert.deepEqual(adjustTotals([{ qty: 0 }, { qty: NaN }]), { added: 0, removed: 0 }, 'الصفر والتالف لا يُعدّان');
  // الكسور لا تتراكم ضجيجاً عشرياً
  assert.deepEqual(adjustTotals([{ qty: 0.1 }, { qty: 0.2 }]), { added: 0.3, removed: 0 });
});

test('إجمالي كمّيات الوارد', () => {
  assert.equal(receiveTotalQty([{ qty: 10 }, { qty: 5 }, { qty: 15 }]), 30);
  assert.equal(receiveTotalQty([{ qty: 0.1 }, { qty: 0.2 }]), 0.3);
  assert.equal(receiveTotalQty([]), 0);
});

test('سطرٌ بلا سعر خارج القيمة — والصفر ليس سعراً', () => {
  // قاعدة الخادم نفسها (hasAnyCost): السعر المعروف موجبٌ حصراً
  assert.equal(isCosted({ qty: 1, unitCost: 121.74 }), true);
  assert.equal(isCosted({ qty: 1, unitCost: 0 }), false, 'الصفر ادّعاءٌ بأنّ البضاعة مجّانية');
  assert.equal(isCosted({ qty: 1, unitCost: null }), false);
  assert.equal(isCosted({ qty: 1 }), false);
  assert.equal(uncostedCount([{ qty: 1, unitCost: 5 }, { qty: 1, unitCost: null }, { qty: 1, unitCost: 0 }]), 2);
});

test('قاعدة «مسعَّر» تطابق قاعدة الخادم حرفاً', () => {
  /* نسختان من القاعدة (هنا وفي warehouseCost.ts) تتباعدان بصمت. فالخادم إن
   * عدّ الصفر سعراً يوماً، يجب أن يسقط هذا الاختبار قبل أن تقول الورقة شيئاً
   * يخالف ما يحسبه. */
  const srv = read('..', 'backend', 'src', 'services', 'warehouseCost.ts');
  assert.match(srv, /i\.unitCost != null && Number\.isFinite\(i\.unitCost\) && i\.unitCost > 0/,
    'قاعدة hasAnyCost في الخادم تغيّرت — راجع isCosted');
});

/* ═══ الوصل ═══ */

test('الخادم يرسل قيمة كل سطر بالدالّة نفسها التي تجمع الإجمالي', () => {
  const s = read('..', 'backend', 'src', 'routes', 'warehouse.ts');
  const i = s.indexOf("router.get('/entries'");
  const body = s.slice(i, s.indexOf('\n});', i));
  assert.match(body, /lineCost: lineCost\(i\.qty, i\.unitCost\)/, 'قيمة السطر لا تُرسَل — والمتصفّح سيحسبها بقاعدةٍ ثانية');
  assert.match(body, /totalCost: entryTotalCost\(e\.items\)/, 'الإجمالي يجب أن يبقى من الخادم');
});

test('الإشعار المطبوع لا يحسب قيمة سطرٍ ولا إجمالياً بنفسه', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  const i = s.indexOf('export const PrintableWarehouseNotice');
  assert.ok(i > 0, 'قالب الإشعار مفقود');
  const body = s.slice(i, s.indexOf("PrintableWarehouseNotice.displayName", i));
  assert.match(body, /it\.lineCost/, 'قيمة السطر يجب أن تأتي من الخادم');
  assert.match(body, /formatCurrency\(doc\.totalCost\)/, 'الإجمالي يجب أن يأتي من الخادم');
  // وواردٌ بلا أيّ سطرٍ مسعَّر لا يُطبع إجماليه صفراً على ورقةٍ موقَّعة
  assert.match(body, /anyCosted \? formatCurrency\(doc\.totalCost\) : '—'/,
    'وارد بلا أسعار يطبع «قيمة البضاعة ٠٫٠٠» — ادّعاءٌ بأنّها بلا ثمن');
  assert.doesNotMatch(body, /it\.qty \* it\.unitCost|Number\(it\.qty\) \* Number\(it\.unitCost\)/, 'حسابٌ ثانٍ لقيمة السطر في القالب');
  // والسطر بلا سعر «—» لا صفر، والسعر بأربع خانات كما يُخزَّن
  assert.match(body, /costed \? formatCurrency\(Number\(it\.unitCost\), undefined, 4\) : '—'/, 'سعر الوحدة يُطبع مقرَّباً أو صفراً');
  // والتسوية بإشارتها، وزيادتها ونقصها منفصلين
  assert.match(body, /q < 0 \? '−' : '\+'/, 'كمّية التسوية بلا إشارة');
  assert.match(body, /adj\.added/, 'الزيادة مفقودة');
  assert.match(body, /adj\.removed/, 'النقص مفقود');
});

test('الويب: زرّ إشعارٍ لكل حركة في السجلّ', () => {
  const s = read('src', 'pages', 'CompanyWarehousePage.tsx');
  assert.match(s, /onClick=\{\(\) => setNoticeOf\(e\)\}/, 'لا زرّ إشعار في سجلّ الويب');
  assert.match(s, /warehouseNoticeDocFromEntry\(noticeOf,/, 'الإشعار لا يُبنى من الحركة');
});

test('الجوال: زرّ إشعارٍ لكل حركة، وطبقة رجوعٍ تُطفئ شرطها', () => {
  const s = read('src', 'm', 'MWarehouse.tsx');
  assert.match(s, /onNotice=\{\(\) => setNoticeOf\(e\)\}/, 'لا زرّ إشعار في سجلّ الجوال');
  assert.match(s, /useBackClose\(!!noticeOf, \(\) => setNoticeOf\(null\)\)/,
    'الإغلاق يجب أن يُطفئ شرط طبقته — وإلّا خرج التطبيق عند الضغطة التالية');
  assert.match(s, /lazy\(\(\) => import\('\.\/MWarehouseNoticeDoc'\)\)/, 'الإشعار يجب أن يُحمَّل كسولاً');
  /* والطبقة **مرسومة** لا مُعلَنة فقط: أوّل نسخةٍ من هذا الربط ضبطت الحالة
   * وسجّلت طبقة الرجوع واستوردت المكوّن — ولم ترسمه. زرٌّ يضبط حالةً لا تُرى،
   * وكلّ حارسٍ أعلاه يمرّ عليه. */
  assert.match(s, /if \(noticeOf\) \{[\s\S]{0,200}<MWarehouseNoticeDoc entry=\{noticeOf\}/,
    'الزرّ يضبط حالةً لا تُرسم — لا شاشة إشعار');
  const app = read('src', 'm', 'MobileApp.tsx');
  assert.match(app, /<MWarehouse company=\{company\}/, 'ترويسة الإشعار بلا إعدادات الشركة');
});
