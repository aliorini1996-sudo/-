import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * التقرير الشامل الصادر — حرّاس على شرط الإصدار وعلى دوام الأرشيف.
 *
 * ما تحرسه ثلاثة أخطاء لا تظهر في الشاشة: حصيلةٌ تصدر ويومُها لم يكتمل بعد
 * فتُقرأ ناقصةً على أنها تامّة · حصيلةٌ تصدر ليومٍ بلا تقارير فتُملأ القائمة
 * بأصفار · وحصيلةٌ يُسقطها فشلٌ عرَضيّ فيتراجع معها اعتمادٌ صحيح.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const routes = () => read('..', 'backend', 'src', 'routes', 'dailyReports.ts');

test('لا تصدر حصيلة ويومُها فيه تقريرٌ لم يُعتمد بعد', () => {
  const s = routes();
  assert.match(s, /status: \{ not: 'APPROVED' \} \}\s*\}\),/, 'شرط الاكتمال يجب أن يعدّ ما لم يُعتمد');
  assert.match(s, /if \(existing \|\| pending > 0 \|\| approved\.length === 0\) return;/,
    'الإصدار يجب أن يتوقّف عند وجود تقريرٍ في الطريق');
});

test('لا تصدر حصيلة ليومٍ بلا تقارير — «صفر» ليس اكتمالاً', () => {
  const s = routes();
  assert.match(s, /approved\.length === 0\) return/, 'يومٌ بلا تقارير يجب ألّا يُصدِر حصيلة');
});

test('الغائبون يُعدّون ويُعرضون — حصيلةٌ تخفيهم تبدو كاملة وهي ناقصة', () => {
  const s = routes();
  assert.match(s, /repCount,/, 'عدد المناديب النشطين يجب أن يُخزَّن');
  assert.match(s, /missingReps: digest\.repCount - digest\.reportCount/, 'الفرق يجب أن يُحسب ويُرسل');
  const ui = read('src', 'pages', 'DailyReportDigests.tsx');
  assert.match(ui, /missingReps > 0/, 'الواجهة لا تعرض الغائبين');
});

test('فشل الإصدار لا يُسقط الاعتماد — خارج المعاملة وبـcatch', () => {
  const s = routes();
  // الاعتماد توقيعٌ وقع وسُجّل؛ تعذّرُ إصدار الحصيلة عرَضٌ لا يجوز أن يتراجع به
  assert.match(s, /if \(tr\.finalApproval\) await issueDigestIfComplete\(tid, report\.reportDate\)\.catch/,
    'الإصدار يجب أن يُستدعى خارج المعاملة وبـcatch');
});

test('الأرشيف يتبع الإسناد الحاليّ لا نسخةً على الحصيلة', () => {
  const s = routes();
  // الإسناد يُقرأ لحظة الطلب: سحبه يُخفي الأرشيف، ومنحه يفتحه بما صدر قبله
  assert.match(s, /dailyReportDigestViewer\.findFirst\(\{\s*where: \{ tenantId: tid, adminId: req\.user!\.id \}/,
    'الإسناد يجب أن يُقرأ لحظة الطلب');
  assert.doesNotMatch(s, /digestViewerId/, 'لا تُنسَخ هوية المستلم على الحصيلة');
});

test('مساران للحصائل خلف صلاحية التقارير — لا فحصٌ من req.user', () => {
  const s = routes();
  // req.user لا يحمل الصلاحيات؛ الوسيط وحده يقرؤها من القاعدة
  assert.match(s, /router\.get\('\/digests', requireAdmin, requireAdminPermission\('canViewReports'\)/, 'قائمة الحصائل بلا صلاحية');
  assert.match(s, /router\.get\('\/digests\/:date', requireAdmin, requireAdminPermission\('canViewReports'\)/, 'محتوى الحصيلة بلا صلاحية');
  assert.doesNotMatch(s, /req\.user\?\.canViewReports/, 'req.user لا يحمل الصلاحيات — الفحص منه لا يعمل');
});

test('تعيين المستلمين خلف صلاحية التهيئة', () => {
  const s = routes();
  const gate = s.indexOf("router.use('/config', requireAdmin, requireAdminPermission('canManageDailyReport'))");
  const route = s.indexOf("router.put('/config/digest-viewers'");
  assert.ok(gate > 0 && route > gate, 'مسار المستلمين يجب أن يقع بعد حارس التهيئة');
});

test('الأرشيف معروض على الويب وعلى الجوال', () => {
  assert.match(read('src', 'pages', 'DailyReportsPage.tsx'), /tab === 'digests' && <DailyReportDigests \/>/, 'تبويب الحصائل مفقود من الويب');
  assert.match(read('src', 'm', 'MDailyReports.tsx'), /tab === 'digests' \? <MDigests \/>/, 'الحصائل مفقودة من الجوال');
});
