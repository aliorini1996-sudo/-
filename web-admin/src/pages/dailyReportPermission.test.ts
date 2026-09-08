import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * صلاحية «إعدادات التقرير اليومي» — حرّاس ثابتة على أخطر صلاحيةٍ في الوحدة.
 *
 * من يملكها يجعل نفسه مستقبِل كل التقارير عند كل عقدة ثم يعتمدها بنفسه،
 * فتصير سلسلة الاعتماد توقيعاً ذاتياً بمظهر ثلاث موافقات. فالحارس على الخادم
 * لا الواجهة، والخانة لا تُعرض لشركةٍ لم تفعّل الميزة أصلاً.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('العمود مُعرَّف بافتراض true كنظائره — فلا ينقطع أحد عند النشر', () => {
  const s = read('..', 'backend', 'prisma', 'schema.prisma');
  assert.match(s, /canManageDailyReport\s+Boolean @default\(true\)/,
    'افتراض false يسحب الصلاحية من كل مستخدمي الشركات القائمة دفعةً واحدة');
});

test('مسار التهيئة يحرسه الخادم بالصلاحية الجديدة', () => {
  const s = read('..', 'backend', 'src', 'routes', 'dailyReports.ts');
  assert.match(s, /router\.use\('\/config', requireAdmin, requireAdminPermission\('canManageDailyReport'\)\)/,
    'التهيئة يجب أن تُحرَس بالصلاحية المخصّصة');
  // ولا تبقى مربوطةً بإعدادات الشركة، وإلا صارت الخانة الجديدة زينةً لا أثر لها
  assert.doesNotMatch(s, /router\.use\('\/config', requireAdmin, requireAdminPermission\('canManageCompanySettings'\)\)/,
    'الحارس القديم ما زال قائماً فالخانة الجديدة بلا أثر');
});

test('المفتاح معرَّف في نوع الصلاحيات وإلا لم يُقبل في الحارس', () => {
  const s = read('..', 'backend', 'src', 'middleware', 'auth.ts');
  assert.match(s, /\| 'canManageDailyReport'/, 'المفتاح مفقود من AdminPermission');
});

test('الخانة لا تُعرض إلا لشركةٍ فعّلت الميزة', () => {
  const s = read('src', 'pages', 'CompanyUsersPage.tsx');
  assert.match(s, /dailyReportEnabled === true/, 'العَلَم مطفأ افتراضياً فيلزمه === true');
  assert.doesNotMatch(s, /dailyReportEnabled !== false/, '`!== false` يعرض الخانة لشركة تعذّرت قراءة إعداداتها');
  assert.match(s, /dailyReportOn \? \[\.\.\.permissionItems, dailyReportPermission\] : permissionItems/,
    'القائمة يجب أن تُشتقّ من العَلَم');
});

test('«تحديد الكل» و«إلغاء الكل» يشملان الخانة المعروضة لا القائمة الثابتة', () => {
  const s = read('src', 'pages', 'CompanyUsersPage.tsx');
  // زرٌّ يعمل على permissionItems يترك الصلاحية الجديدة على حالها فيكذب على المالك
  assert.match(s, /shownPermissions\.map\(p => \[p\.key, true\]\)/, '«تحديد الكل» لا يشمل الخانة الجديدة');
  assert.match(s, /shownPermissions\.map\(p => \[p\.key, false\]\)/, '«إلغاء الكل» لا يشمل الخانة الجديدة');
});

test('الخادم يقبل الحقل في الإنشاء والتعديل', () => {
  const s = read('..', 'backend', 'src', 'routes', 'companyUsers.ts');
  assert.match(s, /canManageDailyReport: z\.boolean\(\)\.optional\(\)/, 'المخطّط لا يقبل الحقل');
  assert.match(s, /canManageDailyReport: body\.canManageDailyReport \?\? true/, 'الإنشاء لا يكتب الحقل');
});

test('تبويب الإعداد يُخفى بالصلاحية المخصّصة', () => {
  const s = read('src', 'pages', 'DailyReportsPage.tsx');
  assert.match(s, /user\?\.canManageDailyReport !== false/, 'التبويب ما زال يقرأ صلاحية إعدادات الشركة');
});
