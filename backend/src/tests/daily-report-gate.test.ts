import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس ثابتة على تسييج «التقرير اليومي».
 *
 * الميزة **مطفأة افتراضياً**، وهذا يقلب شرط الحارس عن نظيره المحاسبي: ذاك
 * عَلَمٌ مفعّل افتراضياً فيُمنع عند `=== false` وحدها؛ وهذا يجب أن يُمنع عند
 * `!== true`، وإلا فتحَ تعذّرُ قراءة الصفّ الميزةَ لكل شركة. ونسخ النمط
 * الخاطئ هنا لا يُنتج خطأً ظاهراً — يُنتج ميزةً مفتوحةً لمن لم يشترك بها.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('العمود مطفأ افتراضياً — ميزة اشتراك لا تُفتح لأحد بلا قرار المالك', () => {
  const s = read('prisma', 'schema.prisma');
  assert.match(s, /dailyReportEnabled\s+Boolean\s+@default\(false\)/, 'يجب أن يكون @default(false)');
  assert.doesNotMatch(s, /dailyReportEnabled\s+Boolean\s+@default\(true\)/, 'افتراض true يفتح الميزة لكل الشركات');
});

test('الحارس يمنع عند غياب true لا عند false وحدها', () => {
  const s = read('src', 'middleware', 'auth.ts');
  assert.match(s, /export async function requireDailyReport/, 'الحارس مفقود من auth.ts');
  assert.match(s, /dailyReportEnabled !== true/, 'الشرط يجب أن يكون !== true');
  assert.doesNotMatch(s, /dailyReportEnabled === false/, '`=== false` يفتح الميزة حين يتعذّر قراءة الصفّ');
  // tenantId(req) ترمي للسوبر أدمن فتحوّل 403 إلى 500 — تُقرأ من الطلب مباشرةً
  assert.match(s, /export async function requireDailyReport[\s\S]{0,260}req\.user\?\.tenantId/, 'اقرأ tenantId من الطلب لا عبر tenantId(req)');
});

test('الحارس مركّب قبل تعريف أي مسار — فلا يُفلت مسارٌ يُضاف لاحقاً', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const guard = s.indexOf('router.use(requireDailyReport)');
  assert.ok(guard > 0, 'الحارس غير مركّب على الراوتر');
  const firstRoute = Math.min(
    ...['router.get(', 'router.post(', 'router.patch(', 'router.delete(', 'router.put(']
      .map(t => { const i = s.indexOf(t); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }),
  );
  assert.ok(guard < firstRoute, 'الحارس يجب أن يسبق أول مسار');
});

test('مسارات الكتابة الإدارية خلف requireAdmin لا خلف الحارس وحده', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  // requireAdminPermission يمرّر SALES_REP بلا فحص؛ الاعتماد والتهيئة لا يحتملانه
  assert.match(s, /router\.use\('\/admin', requireAdmin\)/, 'مسارات المراجعة يجب أن تكون خلف requireAdmin');
  assert.match(s, /router\.use\('\/config', requireAdmin\)/, 'مسارات التهيئة يجب أن تكون خلف requireAdmin');
});

test('العَلَم في مخطّط تحديث الشركة ولا يُقبل عند إنشائها', () => {
  const s = read('src', 'routes', 'tenants.ts');
  const cStart = s.indexOf('const createTenantSchema');
  const uStart = s.indexOf('const updateTenantSchema');
  assert.ok(cStart >= 0 && uStart > cStart, 'ترتيب المخطّطين تغيّر — راجع هذا الاختبار');
  assert.doesNotMatch(s.slice(cStart, uStart), /dailyReportEnabled/, 'لا يُقبل العَلَم عند إنشاء الشركة');
  assert.match(s.slice(uStart), /dailyReportEnabled: z\.boolean\(\)\.optional\(\)/, 'العَلَم مفقود من مخطّط التحديث');
});

test('/company يُرفق العَلَم بـ=== true لا !== false', () => {
  const s = read('src', 'routes', 'company.ts');
  assert.match(s, /dailyReportEnabled: true/, 'العَلَم مفقود من select');
  assert.match(s, /dailyReportEnabled: tenant\?\.dailyReportEnabled === true/, 'يجب === true (العَلَم مطفأ افتراضياً)');
});

test('الراوتر مسجَّل على مسار واحد معلوم', () => {
  const s = read('src', 'index.ts');
  assert.match(s, /app\.use\('\/api\/daily-reports', dailyReportsRouter\)/, 'الراوتر غير مسجَّل');
});

test('الرفع يرفض سلسلةً غير مكتملة برمز صريح لا يُعاد معه المحاولة أبداً', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  assert.match(s, /DAILY_REPORT_NO_LEVELS/, 'الرمز مفقود — الصندوق الصادر سيعيد المحاولة أبداً');
  assert.match(s, /DAILY_REPORT_EXISTS/, 'رمز تكرار اليوم مفقود');
});

test('سبب الإعادة إلزاميّ — لا إعادة صامتة', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const i = s.indexOf("'/admin/:id/return'");
  assert.ok(i > 0, 'مسار الإعادة مفقود');
  assert.match(s.slice(i, i + 400), /reason: z\.string\(\)\.min\(3/, 'السبب يجب أن يكون إلزامياً');
});

test('التقرير المُعتمَد مقفول: لا تعليق ولا إدخال ولا اعتماد ثانٍ', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const locks = s.match(/status === 'APPROVED'[\s\S]{0,120}409/g) || [];
  assert.ok(locks.length >= 3, `القفل ناقص — وُجد ${locks.length} من ٣ مواضع`);
});

test('الخانة ذات القيم تُؤرشَف ولا تُحذف', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const i = s.indexOf("router.delete('/config/fields/:id'");
  assert.ok(i > 0, 'مسار الحذف مفقود');
  assert.match(s.slice(i, i + 700), /dailyReportValue\.count/, 'الحذف يجب أن يفحص القيم أولاً');
  assert.match(s.slice(i, i + 700), /أرشِفها بدل حذفها/, 'الرسالة يجب أن توجّه للأرشفة');
  // والقاعدة نفسها تحرس: Restrict لا Cascade على علاقة القيمة بالخانة
  const sch = read('prisma', 'schema.prisma');
  const vi = sch.indexOf('model DailyReportValue');
  assert.doesNotMatch(sch.slice(vi, vi + 1400).match(/field\s+DailyReportField @relation[^\n]*/)?.[0] || '', /onDelete: Cascade/);
});

test('كل كتابةٍ على التهيئة تترك أثراً', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  // كل معالج تهيئةٍ يكتب سطراً في السجلّ — وإلا مرّ تغييرٌ بلا أثر.
  // والاستثناء الوحيد `/config/preview`: فعلٌ بصيغة POST لأنه يستقبل جسماً،
  // لكنه محاكٍ لا يكتب صفّاً واحداً. استثناؤه يُسمّى هنا ولا يُترك للتساهل،
  // فأيّ مسار تهيئةٍ جديد يسقط في العدّ ما لم يترك أثراً.
  const READ_ONLY = ["router.post('/config/preview'"];
  const writes = (s.match(/router\.(post|patch|delete|put)\('\/config[^']*'/g) || [])
    .filter(m => !READ_ONLY.some(r => m.startsWith(r)));
  const logs = (s.match(/await logConfig\(/g) || []).length;
  assert.ok(logs >= writes.length, `${writes.length} مسار كتابة مقابل ${logs} سطر أثر — مسارٌ بلا أثر: ${writes.join(' · ')}`);
});

test('مالكٌ افتراضيٌّ واحد لكل مستوى — وإلا صار المستقبِل غير محدَّد', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  assert.match(s, /مالكٌ افتراضيٌّ واحد لكل مستوى/, 'الحارس مفقود من مسار الملّاك');
});

test('التقرير الشامل يُعلن ما قصّه وما قيّده — لا قصّ صامت', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const i = s.indexOf("router.get('/team'");
  assert.ok(i > 0, 'مسار التقرير الشامل مفقود');
  const block = s.slice(i, i + 3000);
  assert.match(block, /cappedNote/, 'قصّ المدّة يجب أن يُعلَن في الاستجابة');
  assert.match(block, /scopedNote/, 'تقييد النطاق يجب أن يُعلَن');
  assert.match(block, /soloApproved/, 'وسم «اعتمده شخص واحد» مفقود من التقرير الشامل');
});
