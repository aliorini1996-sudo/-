import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { periodShape, statementFinalBalance, statementZone } from './statementFacts';

/**
 * حرّاس صدق كشف الحساب المطبوع.
 *
 * الورقة تُسلَّم للعميل ويُطالَب بما فيها، فكلّ رقمٍ فيها يجب أن يطابق ما رآه
 * مُصدِرها على الشاشة. وهذه الاختبارات تحرس الخللين اللذين كشفتهما المراجعة
 * العدائية يوم أُضيف الكشف إلى تطبيق الإدارة — وكلاهما كان نائماً منذ كُتب
 * المستند لأنّ كلّ مستدعيه كانوا يطلبونه بلا مدّة.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('شكل المدّة: الطرفان، وكلّ طرفٍ وحده، ولا شيء', () => {
  assert.equal(periodShape('2026-01-01', '2026-01-31'), 'range');
  assert.equal(periodShape('2026-01-01', undefined), 'from', 'طرفٌ واحد مدّةٌ لا «كل الفترات»');
  assert.equal(periodShape(undefined, '2026-01-31'), 'to');
  assert.equal(periodShape(undefined, undefined), 'all');
  assert.equal(periodShape('', ''), 'all', 'الفراغ كالغياب');
});

test('رصيد الكشف يأتي من الخادم قبل كل شيء', () => {
  // مدّةٌ بلا حركات: الخادم يقول ٥٠٠٠ (المرحَّل)، واللقطة المخزَّنة ٩٠٠٠
  assert.equal(statementFinalBalance({ closingBalance: 5000, customerBalance: 9000 }), 5000,
    'ورقة شهرٍ ساكن كانت تطبع رصيد اليوم مطالَباً به عن ذلك الشهر');
  // ويسبق حتى رصيد آخر حركة
  assert.equal(statementFinalBalance({ closingBalance: 5000, lastEntryBalance: 4000 }), 5000);
  // والصفر رقمٌ لا غياب
  assert.equal(statementFinalBalance({ closingBalance: 0, customerBalance: 9000 }), 0);
});

test('والمستدعون القدامى يبقى سلوكهم كما كان', () => {
  // بلا closingBalance: رصيد آخر حركة
  assert.equal(statementFinalBalance({ lastEntryBalance: 4000, customerBalance: 9000 }), 4000);
  // وبلا حركاتٍ أصلاً: اللقطة المخزَّنة — صحيحةٌ حين يكون الكشف بلا مدّة
  assert.equal(statementFinalBalance({ customerBalance: 9000 }), 9000);
  assert.equal(statementFinalBalance({}), 0);
});

test('البند 22: منطقة الكشف — منطقة الشركة إن وصلت وإلّا منطقة الجهاز', () => {
  assert.equal(statementZone('Asia/Riyadh'), 'Asia/Riyadh');
  // `null` ما يعيده الخادم لشركةٍ بلا منطقة مضبوطة: ارتدادٌ صريح لا كسر
  assert.equal(statementZone(null), undefined, 'null منطقةٌ غائبة لا نصّ منطقة');
  assert.equal(statementZone(undefined), undefined, 'خادمٌ أقدم لا يعيد الحقل أصلاً');
  assert.equal(statementZone(''), undefined);
  assert.equal(statementZone('   '), undefined, 'فراغٌ محض ليس منطقة');
  assert.equal(statementZone(' Asia/Riyadh '), 'Asia/Riyadh', 'الفراغ الطرفيّ يُسقط المنطقة على Intl');
});

/* ═══ وصل القرارين بالمستند ═══ */

test('المستند يطبع كل طرفٍ من المدّة ولا يقول «كل الفترات» لمدّةٍ مُصفّاة', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  // القاعدة نفسها لا نسخةٌ منها — وإلّا حرست الاختبارات إحداهما فقط
  assert.match(s, /periodShape\(doc\.fromDate, doc\.toDate\)/, 'المستند لا ينادي قاعدة المدّة');
  assert.match(s, /shape === .from. \? /, 'الطرف الأوّل وحده بلا معالجة');
  assert.match(s, /shape === .to. \? /, 'الطرف الثاني وحده بلا معالجة');
  assert.match(s, /tr\(.كل الفترات.\)/, 'حالة اللامدّة يجب أن تبقى');
});

test('المستند يطبع الرصيد المرحَّل صفّاً أوّل حين تكون للكشف بداية', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(s, /openingBalance\?: number;/, 'المستند لا يحمل الرصيد المرحَّل أصلاً');
  assert.match(s, /doc\.fromDate && doc\.openingBalance !== undefined/,
    'صفّ الترحيل مفقود — عمود الرصيد يبدأ من رقمٍ لا تُنتجه أيّ حركة في الورقة');
  assert.match(s, /tr\('رصيد مرحل من قبل الفترة'\)/, 'الصفّ بلا بيانه');
});

test('والرصيد الختاميّ يفضّل حساب الخادم على اللقطة المخزَّنة', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(s, /const finalBalance = statementFinalBalance\(\{/,
    'المستند لا ينادي قاعدة الرصيد فيسقط إلى customer.balance لمدّةٍ بلا حركات');
  assert.match(s, /closingBalance: range\?\.closingBalance/, 'حساب الخادم لا يصل القاعدة');
});

test('شاشة الكشف تمرّر طرفَي الرصيد لا المدّة وحدها', () => {
  const s = read('src', 'm', 'MCustomerStatement.tsx');
  const i = s.indexOf('range={{');
  assert.ok(i > 0, 'الشاشة لا تمرّر المدّة للمستند');
  const block = s.slice(i, s.indexOf('}}', i));
  assert.match(block, /openingBalance: q\.data\.openingBalance/, 'الرصيد المرحَّل لا يصل الورقة');
  assert.match(block, /closingBalance: q\.data\.closingBalance/, 'رصيد الفترة لا يصل الورقة');
});

test('أصناف الفاتورة لا تتكرّر على قيد التحصيل النقديّ', () => {
  /* الفاتورة النقدية تُولّد قيدين بنفس `invoiceId` (بيع وتحصيل)، فعرض أصنافها
   * على الاثنين يُظهر البضاعة مرّتين في كشفٍ واحد. والمستند يطبّق هذه القاعدة
   * منذ كُتب (اقرأ `statementDocFromData`)، والشاشة كانت تخالفه. */
  const s = read('src', 'm', 'MCustomerStatement.tsx');
  assert.match(s, /e\.type === 'RECEIPT_CREDIT' \? \[\] :/, 'الشاشة تعرض أصناف التحصيل فتكرّر البضاعة');
  const doc = read('src', 'rep', 'statementFacts.ts');
  assert.ok(doc.length > 0);
});

/**
 * البند 22 في الورقة المطبوعة: الكشف يُرشَّح على الخادم بأيام الشركة، فلا يجوز أن تُطبع
 * لحظاتُ حركاته بأيام جهاز مُصدِره. وحدّا المدّة يومان خالصان لا لحظتان.
 */
test('المستند يطبع لحظات الحركات بمنطقة الشركة وحدّي المدّة بأجزائهما', () => {
  const s = read('src', 'rep', 'RepDocuments.tsx');
  assert.match(s, /timezone\?: string \| null;/, 'المستند لا يحمل منطقة الشركة أصلاً');
  assert.match(s, /const tz = statementZone\(doc\.timezone\);/, 'المستند لا ينادي قاعدة المنطقة');
  assert.match(s, /formatDate\(e\.date, tz\)/, 'تاريخ الحركة يُطبع بمنطقة الجهاز لا بمنطقة الشركة');
  assert.doesNotMatch(s, /formatDate\(e\.date\)/);
  // حدّا المدّة وصفّ الترحيل: `YYYY-MM-DD` يُقرأ بأجزائه — منطقةٌ غرب غرينتش كانت تطبع يوم الجار
  assert.doesNotMatch(s, /formatDate\(doc\.fromDate/, 'حدّ المدّة لحظةٌ تُزيحها المنطقة');
  assert.doesNotMatch(s, /formatDate\(doc\.toDate/);
  assert.equal((s.match(/formatDayOnly\(doc\.fromDate/g) || []).length, 3,
    'حدّ البداية يظهر ثلاثاً: مدّةٌ بطرفين، وطرفٌ وحده، وصفّ الرصيد المرحَّل');
  // والمنطقة تصل المستند من الشاشة كما وصلت من الخادم
  assert.match(s, /timezone: range\?\.timezone \?\? null/, 'منطقة الخادم لا تصل الورقة');
});
