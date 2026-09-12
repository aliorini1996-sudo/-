import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isCalendarDay } from '../lib/day';

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
  assert.match(s, /router\.use\('\/admin', requireAdmin[,)]/, 'مسارات المراجعة يجب أن تكون خلف requireAdmin');
  assert.match(s, /router\.use\('\/config', requireAdmin[,)]/, 'مسارات التهيئة يجب أن تكون خلف requireAdmin');
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

/* ═══════════════════════════════════════════════════════════════════
 * الإقرار اليوميّ **سجلّ** لا بيانات تشغيل — ثلاثة حرّاس يحفظون ذلك
 * ═══════════════════════════════════════════════════════════════════ */

/** كتلة نموذجٍ واحدة من المخطّط — لا نافذة أحرفٍ ثابتة تنزلق مع أيّ تعليق */
function model(schema: string, name: string): string {
  const i = schema.indexOf(`model ${name} {`);
  assert.ok(i > 0, `النموذج ${name} مفقود من المخطّط`);
  const end = schema.indexOf('\n}', i);
  assert.ok(end > i, `تعذّر تحديد نهاية النموذج ${name}`);
  return schema.slice(i, end);
}

test('حذف المندوب يُفرّغ مرجعه من تقاريره ولا يمحوها — كالفاتورة حرفاً', () => {
  const sch = read('prisma', 'schema.prisma');
  const dr = model(sch, 'DailyReport');
  assert.match(dr, /salesRepId String\?/, 'المرجع يجب أن يكون اختيارياً وإلا محا Cascade تقارير شهور');
  assert.match(dr, /salesRep\s+SalesRep\? @relation\([^)]*onDelete: SetNull\)/, 'العلاقة يجب أن تكون SetNull لا Cascade');
  // وهي سابقة الفاتورة نفسها لا اجتهاداً جديداً
  assert.match(model(sch, 'Invoice'), /onDelete: SetNull/, 'سابقة الفاتورة تغيّرت — راجع هذا القرار كلّه');

  // والقاعدة وحدها لا تكفي: مسار الحذف يقول ما يفعل صراحةً
  const r = read('src', 'routes', 'salesReps.ts');
  const i = r.indexOf('await prisma.$transaction([');
  assert.ok(i > 0, 'معاملة حذف المندوب مفقودة');
  const tx = r.slice(i, r.indexOf('])', i));
  assert.match(tx, /dailyReport\.updateMany\([^)]*salesRepId: null/, 'المعاملة لا تُفرّغ مرجع التقارير');
  // توجيه العقد للمندوب تهيئةٌ لا سجلّ — يُحذف معه
  assert.match(tx, /dailyReportOwnerRep\.deleteMany/, 'توجيهات العقد تبقى يتيمةً بعد حذف المندوب');
});

test('حذف مستخدمٍ يملك عقدة في السلسلة محروسٌ ومنظَّف', () => {
  const s = read('src', 'routes', 'companyUsers.ts');
  const i = s.indexOf("router.delete('/:id'");
  assert.ok(i > 0, 'مسار حذف مستخدم الشركة مفقود');
  const end = s.indexOf('\n});', i);
  assert.ok(end > i, 'تعذّر تحديد نهاية المسار');
  const body = s.slice(i, end);

  // الحارس: آخر صاحبٍ حيّ لمستوى، وآخر صاحبٍ افتراضيّ
  assert.match(body, /dailyReportLevelOwner\.findMany/, 'المسار لا يقرأ عقد المستخدم أصلاً');
  assert.match(body, /isActive: true/, 'الخلَف يجب أن يكون **حيّاً** — المعطَّل لا يفتح صندوقه');
  assert.match(body, /آخر صاحب لمستوى/, 'رسالة آخر صاحبٍ مفقودة');
  assert.match(body, /الصاحب الافتراضي لمستوى/, 'رسالة آخر صاحبٍ افتراضيّ مفقودة');
  // والرفض لا يُطبَّق على شركةٍ أُطفئت عندها الميزة: لا سبيل لها إلى العلاج
  assert.match(body, /dailyReportEnabled === true/, 'الرفض يجب أن يكون مشروطاً بتفعيل الميزة');
  /* والتنظيف في معاملةٍ واحدة مع الحساب.
   *
   * ويُقاس هنا **بالخاصّية لا بالشكل**: أوّل صياغةٍ لهذا الحارس طلبت أن يقع
   * `dailyReportLevelOwner.deleteMany` حرفياً بين قوسَي `$transaction([` و
   * `admin.delete`، فسقط الحارس حين أُخرجت الجملتان إلى متغيّرٍ يُنشَر في
   * المصفوفة — وهي إعادة صياغةٍ لا تغيّر سلوكاً البتّة. الحارس الذي يسقط على
   * ما لا يضرّ يُروَّض بالتعطيل، ثمّ لا يحرس شيئاً. */
  const txStart = body.indexOf('$transaction([');
  assert.ok(txStart > 0, 'الحذف يجب أن يقع داخل معاملة');
  const tx = body.slice(txStart, body.indexOf(']);', txStart));
  assert.match(tx, /prisma\.admin\.delete/, 'الحساب يجب أن يُحذف داخل المعاملة');
  // التنظيف إمّا مُسطَّرٌ في المعاملة أو مُدخَلٌ إليها بالنشر — والمهمّ ألّا يقع خارجها
  assert.ok(/dailyReportLevelOwner\.deleteMany/.test(tx) || /\.\.\.\w+/.test(tx),
    'تنظيف العقد يجب أن يدخل المعاملة نفسها');
  assert.doesNotMatch(body.slice(0, txStart), /await prisma\.dailyReportLevelOwner\.deleteMany/,
    'تنظيف العقد وقع خارج المعاملة — انقطاعُ الطلب بينهما يترك عقدةً باسم محذوف');
});

test('سجلّ تقارير المندوب خلف الدور والصلاحية والنطاق معاً', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const i = s.indexOf("router.get('/rep/:salesRepId'");
  assert.ok(i > 0, 'مسار سجلّ المندوب مفقود');
  const head = s.slice(i, i + 200);
  assert.match(head, /requireAdmin, requireAdminPermission\('canViewReports'\)/, 'المسار ليس تحت `/admin` فيلزمه حارساه صراحةً');
  const end = s.indexOf('\n});', i);
  const body = s.slice(i, end);
  assert.match(body, /canAccessRep/, 'النطاق غير محروس — مستخدمٌ مقيَّد يقرأ سجلّ مندوبٍ خارج نطاقه');
  assert.match(body, /cappedNote/, 'قصّ المدّة يجب أن يُعلَن لا أن يقع صامتاً');
});

/* ═══ اليوم التقويميّ — قاعدة نقيّة تُختبَر سلوكاً لا نصّاً ═══ */

test('نصٌّ بشكل تاريخ ليس تاريخاً — الشهر ١٣ يُردّ ولا يُسقِط الخادم', () => {
  // هذا هو المدخل الذي كان يجعل `new Date(NaN).toISOString()` يرمي RangeError
  // فيصير الردّ ٥٠٠ بدل ٤٠٠
  assert.equal(isCalendarDay('2026-13-01'), false);
  assert.equal(isCalendarDay('2026-00-10'), false);
  assert.equal(isCalendarDay('2026-01-32'), false);
});

test('يومٌ لا وجود له في شهره يُردّ ولا يُقرأ يوماً آخر بصمت', () => {
  // Date.parse تقرأ «2026-02-30» أوّلَ مارس — فيرى المستخدم مدّةً غير التي طلب
  assert.equal(isCalendarDay('2026-02-30'), false);
  assert.equal(isCalendarDay('2025-02-29'), false, '٢٠٢٥ ليست كبيسة');
  assert.equal(isCalendarDay('2024-02-29'), true, '٢٠٢٤ كبيسة');
});

test('الصيغة وحدها لا تكفي ولا تُتجاوَز', () => {
  assert.equal(isCalendarDay(''), false);
  assert.equal(isCalendarDay('2026-1-1'), false, 'بلا تصفير بادئ');
  assert.equal(isCalendarDay('2026-01-01T00:00:00Z'), false, 'يومٌ لا لحظة');
  assert.equal(isCalendarDay('  2026-01-01  '), false);
  assert.equal(isCalendarDay('2026-01-01'), true);
  assert.equal(isCalendarDay('2026-12-31'), true);
});

test('سجلّ المندوب يستعمل القاعدة نفسها ويردّ ٤٠٠ لا يسقط صامتاً لليوم', () => {
  const s = read('src', 'routes', 'dailyReports.ts');
  const i = s.indexOf("router.get('/rep/:salesRepId'");
  const body = s.slice(i, s.indexOf('\n});', i));
  assert.match(body, /isCalendarDay\(qTo\)/, 'المدخل الخاطئ يجب أن يُفحص لا أن يُبتلع');
  assert.match(body, /isCalendarDay\(qFrom\)/, 'الطرف الآخر كذلك');
  assert.match(body, /from > to/, 'المدّة المقلوبة تُسمّى لا تُعيد صفر صفوفٍ بلا سبب');
});

/* ═══ الجداول التي تشير إلى Admin بلا مفتاح أجنبيّ ═══ */

test('لا ثالث للجدولين المُشيرَين إلى Admin بلا FK — وكلاهما يُنظَّف مع الحساب', () => {
  const sch = read('prisma', 'schema.prisma');
  /* القاعدة لا تحرس هذين العمودين، فحذفُ مستخدمٍ يترك صفّاً باسم رجلٍ لا حساب
   * له. والحصر هنا هو الحارس الحقيقيّ: جدولٌ ثالث يُضاف بعمود `adminId` بلا
   * علاقة يُسقِط هذا الاختبار، فيُقرَّر له تنظيفٌ بدل أن يُكتشف بعد شهر. */
  const orphanTables = [...sch.matchAll(/model (\w+) \{([\s\S]*?)\n\}/g)]
    .filter(([, , body]) => /\n\s*adminId\s+String/.test(body) && !/@relation\(fields: \[adminId\]/.test(body))
    .map(([, name]) => name)
    .sort();
  assert.deepEqual(orphanTables, ['DailyReportDigestViewer', 'DailyReportLevelOwner'],
    `جدولٌ جديد يشير إلى Admin بلا مفتاح أجنبيّ: ${orphanTables.join(' · ')} — قرّر تنظيفه في مسار حذف المستخدم`);

  const s = read('src', 'routes', 'companyUsers.ts');
  const i = s.indexOf("router.delete('/:id'");
  const body = s.slice(i, s.indexOf('\n});', i));
  const tx = body.slice(body.indexOf('$transaction(['));
  assert.match(tx, /dailyReportDigestViewer\.deleteMany/, 'مستلمو التقرير الشامل يبقون أشباحاً في قائمة «من يستلم»');
  assert.match(tx, /prisma\.admin\.delete/, 'التنظيف يجب أن يقع في معاملة الحذف نفسها');
});
