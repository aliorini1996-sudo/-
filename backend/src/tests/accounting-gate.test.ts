import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس ثابتة على «النظام المحاسبي» — العَلَم الوحيد المعكوس الافتراض.
 *
 * كل أعلام الاشتراك الأخرى مطفأة افتراضياً، فيصحّ فيها `!!tenant?.x` و`=== true`.
 * هذا العَلَم مفعّل افتراضياً عند كل الشركات، فنسخ ذلك النمط عليه **يقلب المعنى**:
 * `!!undefined` تساوي false، أي «مطفأ» بدل «مفعّل» — فتختفي خمس صفحات عن كل
 * شركة صفّها غير مقروء أو ردّها قديم. الاختبارات أدناه تحرس هذا الانقلاب،
 * وتحرس أن يُضاف مسار محاسبيّ جديد يوماً بلا حارس.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('العمود مُعرَّف بافتراض true — وهو الوحيد كذلك بين أعلام الاشتراك', () => {
  const s = read('prisma', 'schema.prisma');
  assert.match(s, /accountingEnabled\s+Boolean\s+@default\(true\)/, 'accountingEnabled يجب أن يكون @default(true)');
  assert.doesNotMatch(s, /accountingEnabled\s+Boolean\s+@default\(false\)/, 'افتراض false يطفئ الوحدة عن كل الشركات القائمة');
});

test('الحارس المشترك يمنع عند false الصريحة وحدها — لا عند تعذّر القراءة', () => {
  const s = read('src', 'middleware', 'auth.ts');
  assert.match(s, /export async function requireAccounting/, 'الحارس المشترك مفقود من auth.ts');
  assert.match(s, /t\?\.accountingEnabled === false/, 'الشرط يجب أن يكون === false');
  assert.doesNotMatch(s, /if \(!t\?\.accountingEnabled\)/, '`!t?.accountingEnabled` يمنع أيضاً حين يتعذّر قراءة الصف');
  // tenantId(req) ترمي للسوبر أدمن فتحوّل 403 إلى 500
  assert.match(s, /const tid = req\.user\?\.tenantId/, 'اقرأ tenantId من الطلب لا عبر tenantId(req)');
});

test('كل راوتر محاسبيّ يركّب الحارس', () => {
  for (const f of ['invoices.ts', 'receipts.ts', 'products.ts', 'vanStock.ts']) {
    const s = read('src', 'routes', f);
    assert.match(s, /router\.use\(requireAccounting\)/, `${f} بلا حارس النظام المحاسبي`);
  }
  // المستودع يفحص العَلَمين في استعلامه القائم بدل حارس ثانٍ
  const w = read('src', 'routes', 'warehouse.ts');
  assert.match(w, /accountingEnabled: true/, 'warehouse.ts لا يقرأ accountingEnabled');
  assert.match(w, /accountingEnabled === false/, 'warehouse.ts لا يمنع عند إطفاء المحاسبي');
});

test('حارس الفواتير قبل حارس الصلاحية — وإلا أفلت منه GET /open', () => {
  const s = read('src', 'routes', 'invoices.ts');
  const guard = s.indexOf('router.use(requireAccounting)');
  const openRoute = s.indexOf("router.get('/open'");
  assert.ok(guard > 0, 'الحارس مفقود');
  assert.ok(openRoute > 0, 'المسار /open غير موجود — راجع هذا الاختبار');
  assert.ok(guard < openRoute, 'الحارس يجب أن يسبق تعريف /open وإلا أفلت منه');
});

test('مسار /company يرسل العَلَم بدلالة `!== false` لا `!!`', () => {
  const s = read('src', 'routes', 'company.ts');
  assert.match(s, /accountingEnabled: true/, 'العمود غائب عن select فلن يصل الواجهة إطلاقاً');
  assert.match(s, /accountingEnabled: tenant\?\.accountingEnabled !== false/, 'الدلالة الصحيحة `!== false`');
  assert.doesNotMatch(s, /accountingEnabled: !!tenant\?\.accountingEnabled/, '`!!` يقسر الغياب إلى مطفأ');
});

test('المفتاح في سكيما التحديث فقط — لا في مسار إنشاء الشركة', () => {
  const s = read('src', 'routes', 'tenants.ts');
  assert.match(s, /accountingEnabled: z\.boolean\(\)\.optional\(\)/, 'بدونها يردّ PUT بـ200 ولا شيء يتغيّر');
  const createBlock = s.slice(s.indexOf('const createTenantSchema'), s.indexOf('const updateTenantSchema'));
  assert.doesNotMatch(createBlock, /accountingEnabled/, 'إدراجه في سكيما الإنشاء يولّد كل شركة جديدة بمحاسبة مطفأة');
  assert.doesNotMatch(s, /accountingEnabled: body\.accountingEnabled \?\? false/, 'نمط `?? false` ينقض @default(true)');
});

test('الدفع الإلكتروني محجوب حين تُطفأ المحاسبة — لأنه يكتب سنداً وقيوداً', () => {
  const s = read('src', 'routes', 'paylink.ts');
  assert.match(s, /accountingEnabled === false/, 'رابط دفع بمحاسبة مطفأة يولّد سنداً لا تراه الشركة');
});

test('صندوق الأوف-لاين لا يعدم مستندات المندوب عند إطفاء الميزة', () => {
  const s = read('..', 'web-admin', 'src', 'rep', 'offlineSync.ts');
  assert.match(s, /ACCOUNTING_NOT_ALLOWED/, 'بدون هذا الاستثناء يصير كل مستند مصفوف `rejected` بلا رجعة');
});

test('الواجهة تخفي الصفحات الخمس بدلالة `!== false`', () => {
  const s = read('..', 'web-admin', 'src', 'layouts', 'MainLayout.tsx');
  assert.match(s, /ACCOUNTING_PAGES/, 'قائمة الصفحات المحاسبية مفقودة');
  assert.match(s, /companyCfg\?\.accountingEnabled !== false/, 'الدلالة الصحيحة `!== false`');
  assert.doesNotMatch(s, /companyCfg\?\.accountingEnabled === true/, '`=== true` يخفي الصفحات عن كل الشركات');
  for (const to of ['/app/products', '/app/van-stock', '/app/warehouse', '/app/invoices', '/app/receipts']) {
    assert.ok(s.includes(`'${to}'`), `الصفحة ${to} غائبة عن قائمة الصفحات المحاسبية`);
  }
});

test('نافذة المالك تقرأ الحالة بـ`!== false` لا `!!` — وإلا أطفأتها ضغطةُ حفظ', () => {
  const s = read('..', 'web-admin', 'src', 'pages', 'PlatformPage.tsx');
  assert.match(s, /useState\(tenant\.accountingEnabled !== false\)/, 'الدلالة الصحيحة `!== false`');
  assert.doesNotMatch(s, /useState\(!!tenant\.accountingEnabled\)/, '`!!` يُظهر الخانة فارغة لشركة مفعّلة');
});

test('الصفحة الرئيسية تخفي كل خانة نقدية عند الإطفاء — لوحةً وجوالاً', () => {
  const desk = read('..', 'web-admin', 'src', 'pages', 'DashboardPage.tsx');
  assert.match(desk, /accountingEnabled !== false/, 'الدلالة الصحيحة `!== false`');
  assert.doesNotMatch(desk, /accountingEnabled === true/, '`=== true` يخفي البطاقات عن كل الشركات');
  // ثلاث لفّات: إحصائيات اليوم · المنحنى وأفضل المناديب · الفواتير وأفضل العملاء
  assert.equal((desk.match(/\{accountingOn && \(/g) || []).length, 3, 'ثلاث كتل نقدية مسيَّجة');

  const mob = read('..', 'web-admin', 'src', 'm', 'MHome.tsx');
  // ستّة أقسام نقدية: اليوم · الشهر · المنحنى · أفضل المناديب · أفضل العملاء · آخر الفواتير
  assert.equal((mob.match(/\{accountingOn && \(<Section/g) || []).length, 6, 'ستّة أقسام نقدية مسيَّجة');
  assert.match(mob, /accountingOn = true/, 'الافتراض مفعّل فلا ينكسر مُستدعٍ لا يمرّره');
});

test('الخادم يصفّر المالي ولا يُسقط مفاتيحه — ثلاثة مستهلكين يقرأونها مباشرةً', () => {
  const s = read('src', 'routes', 'dashboard.ts');
  assert.match(s, /accountingEnabled !== false/, 'الدلالة الصحيحة على الخادم');
  assert.match(s, /salesTotal: 0, invoicesCount: 0, collectionsTotal: 0, receiptsCount: 0/, 'تصفير لا إسقاط');
  assert.match(s, /topReps: accountingOn \? topRepsWithStats : \[\]/, 'أفضل المناديب يفرغ لا يغيب');
  assert.match(s, /data: \[\] \}\); return;/, 'منحنى المبيعات يردّ مصفوفة فارغة عند الإطفاء');
});
