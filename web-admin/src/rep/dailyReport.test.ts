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

test('مفتاح idempotency يحمل الجولة — إعادة الرفع ليست تكراراً', () => {
  const s = read('src', 'rep', 'RepDailyReport.tsx');
  // بلا الجولة يعود clientRef نفسه بعد الإعادة، فيردّ الخادم التقرير القديم
  // idempotent ولا يصل التصحيح أبداً.
  assert.match(s, /const clientRef = `dr-\$\{currentRepId\(\)\}-\$\{today\}-\$\{report\?\.round \?\? 1\}`/, 'مفتاح idempotency يجب أن يحمل الجولة');
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
