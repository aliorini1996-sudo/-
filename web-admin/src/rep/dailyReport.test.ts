import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deviceDay } from './deviceDay';

/**
 * حرّاس «تقرير اليوم» في تطبيق المندوب.
 *
 * ثلاثة أخطاء لا تظهر في الشاشة وتحرسها هذه الاختبارات:
 *  • يوم مشتقٌّ بـUTC — منتصف ليل UTC ثلاثةً فجراً بالرياض، فثلاث ساعات من
 *    كل ليلة تُكتب في تقرير اليوم الخطأ.
 *  • بلاطةٌ مفتوحة لكل شركة — العَلَم مطفأ افتراضياً فيلزم `=== true`.
 *  • تقريرٌ يُعدَم في الصندوق الصادر — رمز إطفاء الميزة ليس رفض أعمال.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('يوم التقرير من ساعة الجهاز لا من UTC', () => {
  // ٢٣:٣٠ بتوقيت محلّي يجب أن تبقى يومَها، لا أن تنزلق ليوم UTC التالي
  const late = new Date(2026, 8, 7, 23, 30, 0);
  assert.equal(deviceDay(late), '2026-09-07');
  const early = new Date(2026, 8, 8, 0, 15, 0);
  assert.equal(deviceDay(early), '2026-09-08');
  // والصيغة مصفوفة بأصفار — '2026-9-7' لا يطابق القيد الفريد على الخادم
  assert.match(deviceDay(new Date(2026, 0, 5)), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(deviceDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('البلاطة مُسيَّجة بـ=== true — العَلَم مطفأ افتراضياً', () => {
  const s = read('src', 'rep', 'RepApp.tsx');
  assert.match(s, /dailyReportEnabled \?\?? *=== true|dailyReportEnabled === true/, 'التسييج يجب أن يكون === true');
  assert.doesNotMatch(s, /dailyReportEnabled !== false/, '!== false يفتح البلاطة لكل شركة');
  assert.match(s, /dailyReportOn && quick\(/, 'البلاطة غير مُسيَّجة بالمفتاح');
});

test('إطفاء الميزة يعيد المندوب للرئيسية ولا يتركه بشاشة بلا مخرج', () => {
  const s = read('src', 'rep', 'RepApp.tsx');
  assert.match(s, /!dailyReportOn && screen === 'dailyreport'\) setScreen\('home'\)/, 'المخرج مفقود');
});

test('الصندوق الصادر يعرف النوع الجديد ووجهته', () => {
  const db = read('src', 'rep', 'offlineDb.ts');
  assert.match(db, /'dailyReport'/, 'النوع غير معرّف في OutboxDoc');
  const sync = read('src', 'rep', 'offlineSync.ts');
  assert.match(sync, /'\/daily-reports'/, 'الوجهة مفقودة من endpointOf');
});

test('رمز إطفاء الميزة يوقف الصفّ ولا يُعدم التقرير', () => {
  const s = read('src', 'rep', 'offlineSync.ts');
  const i = s.indexOf('DAILY_REPORT_NOT_ALLOWED');
  assert.ok(i > 0, 'الرمز غير مُعالَج — التقرير سيُعدم كأنه رفض أعمال');
  // يجب أن يقع قبل فرع 4xx العام الذي يضع الحالة rejected
  const rejected = s.indexOf("status: 'rejected'");
  assert.ok(i < rejected, 'المعالجة يجب أن تسبق فرع رفض الأعمال');
  assert.match(s.slice(i, i + 400), /stopped = true/, 'الصفّ يجب أن يتوقّف لا أن يُعدم');
});

test('سلسلة غير مكتملة توقف الصفّ أيضاً — لا محاولة أبدية', () => {
  const s = read('src', 'rep', 'offlineSync.ts');
  assert.match(s, /DAILY_REPORT_NO_LEVELS/, 'رمز السلسلة الناقصة غير مُعالَج');
});

test('مفتاح الرفع يختلف بين الرفع الأول وإعادة الرفع — وإلا علق التقرير أبداً', () => {
  // الصيغة السابقة `report?.round ?? 1` كانت تعطي المفتاح نفسه في الحالتين:
  // لا شيء يُكتب، والمندوب يرى «تمّ»، والتقرير عالقٌ في «أعيد للتصحيح».
  // فالاختبار يحاكي التوليد بدل تثبيت نصّه، ويسأل السؤال الذي يهمّ.
  const key = (round: number | null) => `dr-REP1-2026-09-07-${(round ?? 0) + 1}`;
  assert.equal(key(null), 'dr-REP1-2026-09-07-1', 'الرفع الأول (لا تقرير بعد)');
  assert.notEqual(key(1), key(null), 'إعادة الرفع بعد الجولة الأولى يجب أن تحمل مفتاحاً مختلفاً');
  assert.equal(key(1), 'dr-REP1-2026-09-07-2');
  // والمصدر يجب أن يستعمل الصيغة نفسها
  const s = read('src', 'rep', 'RepDailyReport.tsx');
  assert.match(s, /\(report\?\.round \?\? 0\) \+ 1/, 'المفتاح يجب أن يُبنى على الجولة القادمة');
  assert.doesNotMatch(s, /report\?\.round \?\? 1\}`/, 'الصيغة القديمة تُعلّق كل تقرير مُعاد');
});

test('الخادم لا يبتلع إعادة الرفع بحجّة التكرار — ولا يبتلع قرار الإعادة بحجّة التصحيح', () => {
  const s = read('..', 'backend', 'src', 'routes', 'dailyReports.ts');
  /* حزام أمانٍ ثانٍ يعمل مهما فعلت الواجهة بالمفتاح — **بشرط أن تكون الحمولة
   * كتابةً جديدة**. استثناءُ الحالة RETURNED وحدها كان يفتح الباب للطرف الآخر:
   * إعادة إرسالٍ آليّة من الصندوق الصادر تحمل المفتاح نفسه وزمن كتابته نفسه،
   * فتُعيد رفع الأرقام التي رفضها المشرف للتوّ جولةً جديدة وتمحو قراره وسببه
   * بلا خطوةٍ مضادّة. فالحارس يسأل الآن سؤالين لا سؤالاً: أمُعادٌ هو؟ وأحمولةٌ
   * أحدثُ من آخر رفعةٍ قُبلت؟ (والتصحيح اليدويّ يحمل مفتاحاً جديداً أصلاً). */
  assert.match(s, /const fresh = !!body\.clientCreatedAt && new Date\(body\.clientCreatedAt\) > lastAccepted/,
    'الحمولة الأحدث من آخر رفعةٍ قُبلت هي وحدها «تصحيح»');
  assert.match(s, /existing\.status !== 'RETURNED' \|\| !fresh/,
    'حارس idempotency يجب أن يستثني الصفّ المُعاد **بحمولةٍ جديدة** لا بكل حمولة');
  // وفرع التحديث يكتب مفتاح الجولة الجديدة وإلا تعطّلت الحماية لما بعدها
  assert.match(s, /\.\.\.\(body\.clientRef && \{ clientRef: body\.clientRef \}\)/, 'فرع التحديث يجب أن يحدّث clientRef');
});

test('الوحدة خلف صلاحية لا خلف requireAdmin وحده', () => {
  const s = read('..', 'backend', 'src', 'routes', 'dailyReports.ts');
  assert.match(s, /router\.use\('\/admin', requireAdmin, requireAdminPermission\('canViewReports'\)\)/, 'المراجعة بلا صلاحية');
  // صارت لها صلاحيةٌ مخصّصة يمنحها المالك من صفحة مستخدمي الشركة
  assert.match(s, /router\.use\('\/config', requireAdmin, requireAdminPermission\('canManageDailyReport'\)\)/, 'التهيئة بلا صلاحية');
  assert.match(s, /router\.get\('\/team', requireAdmin, requireAdminPermission\('canViewReports'\)/, 'التقرير الشامل بلا صلاحية');
});

test('انقطاع الشبكة وحده يذهب للصندوق الصادر — لا رفض الخادم', () => {
  const s = read('src', 'rep', 'RepDailyReport.tsx');
  const i = s.indexOf('outboxAdd(');
  assert.ok(i > 0, 'الحفظ في الصندوق الصادر مفقود');
  // الشرط `!status` = لا استجابة أصلاً؛ رفضُ الخادم (4xx) يُعرض للمندوب ولا يُصفّ
  assert.match(s.slice(Math.max(0, i - 300), i), /if \(!status\)/, 'الصفّ يجب أن يكون على انقطاع الشبكة وحده');
});

test('سبب الإعادة يظهر للمندوب فوق النموذج', () => {
  const s = read('src', 'rep', 'RepDailyReport.tsx');
  assert.match(s, /returnReason/, 'سبب الإعادة غير معروض');
  assert.match(s, /status === 'RETURNED' && returnReason/, 'يجب عرضه عند حالة الإعادة');
});

test('التقرير المرفوع أو المعتمد مقفول في الشاشة لا في الخادم وحده', () => {
  const s = read('src', 'rep', 'RepDailyReport.tsx');
  assert.match(s, /const locked = report && \(report\.status === 'SUBMITTED'/, 'القفل مفقود');
  assert.match(s, /disabled=\{!!locked\}/, 'الحقول يجب أن تُقفل');
});

test('صفحة اللوحة مُسيَّجة بالمفتاح في التنقّل', () => {
  const s = read('src', 'layouts', 'MainLayout.tsx');
  assert.match(s, /item\.to !== '\/app\/daily-reports' \|\| companyCfg\?\.dailyReportEnabled === true/, 'التبويب غير مُسيَّج');
});
