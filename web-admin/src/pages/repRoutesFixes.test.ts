import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس على عيوب خط السير التي كشفتها المراجعة العدائية وأُصلحت.
 *
 * ستّ عدساتٍ مستقلّة وجدت العيب الأول وحده: مسارٌ بلا حارس يُسلّم هواتف
 * العملاء وعناوينهم لمن مُنِع من قسم التتبّع كلّه.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const routes = () => read('..', 'backend', 'src', 'routes', 'repRoutes.ts');

test('‏/mine يحمل حارسه بنفسه — فهو قبل حارس الأدمن', () => {
  const s = routes();
  const i = s.indexOf("router.get('/mine'");
  const j = s.indexOf("router.use(requireAdmin", i);
  assert.ok(i > 0 && j > i, 'ترتيب المسارات تغيّر');
  const block = s.slice(i, j);
  // دورُ شركةٍ وصلاحيةُ تتبّع تُقرأ من القاعدة — req.user لا يحملها
  assert.match(block, /canManageTracking: true/, 'الصلاحية لا تُقرأ من القاعدة');
  assert.match(block, /admin\.canManageTracking === false/, 'لا فحص صلاحية التتبّع');
  assert.match(block, /canAccessRep\(req, tid, salesRepId\)/, 'لا فحص نطاق على المندوب المطلوب');
});

test('محطّات عملاء لا يراهم المندوب تُحجب عنه', () => {
  const s = routes();
  // محطّةٌ لعميلٍ غير مُسنَد تُسلّم هاتفه، وهي محطّةٌ يستحيل إنجازها أصلاً
  assert.match(s, /canAccessCustomer\(req, tid, st\.customerId\)/, 'لا فحص عزل عملاء على المحطّات');
  assert.match(s, /stops: visible\.map/, 'الردّ يجب أن يبني من المحطّات المرئيّة');
  assert.match(s, /total: visible\.length/, 'العدّاد يجب أن يتبع المرئيّ وإلا لم يكتمل أبداً');
});

test('مسارات الإدارة تحترم نطاق المستخدم', () => {
  const s = routes();
  assert.match(s, /const repScope = await adminRepFilter\(req\)/, 'القائمة بلا فلتر نطاق');
  // القراءة والكتابة بالمعرّف: خطُّ مندوبٍ لا يراه المستخدم = غير موجود
  const hits = (s.match(/canAccessRep\(req, tid, r\.salesRepId\)/g) || []).length;
  assert.ok(hits >= 2, `GET /:id و DELETE /:id يجب أن يفحصا النطاق (وجدت ${hits})`);
});

test('التعديل يُعطّل الخطّ المُحرَّر بمعرّفه لا بمفاتيحه', () => {
  // تغييرُ التاريخ أو النوع أو المندوب كان يُنشئ خطّاً ثانياً ويترك الأول نشطاً
  const s = routes();
  assert.match(s, /replacesId: z\.string\(\)\.uuid\(\)\.nullish\(\)/, 'المخطّط لا يقبل replacesId');
  assert.match(s, /where: \{ id: body\.replacesId, tenantId: tid \}/, 'الخطّ المُحرَّر لا يُعطَّل بمعرّفه');
  const ui = read('src', 'pages', 'RepRoutesPage.tsx');
  assert.match(ui, /\.\.\.\(id && \{ replacesId: id \}\)/, 'الواجهة لا ترسل replacesId عند التعديل');
});

test('حقول المحرّر تُملأ مرّة واحدة لا داخل queryFn', () => {
  const s = read('src', 'pages', 'RepRoutesPage.tsx');
  // في queryFn: إعادة الجلب تمحو تعديلات غير محفوظة، وإعادة الفتح خلال مدّة
  // الطزاجة تعرض نموذجاً فارغاً لخطٍّ ممتلئ فيُحفظ بلا عملاء
  assert.doesNotMatch(s, /queryKey: \['rep-route', id\]/, 'التحميل ما زال في useQuery');
  assert.match(s, /useEffect\(\(\) => \{\s*\n\s*if \(!id\) return;/, 'التحميل يجب أن يكون في تأثيرٍ يعمل مرّة');
});

test('العملاء الساقطون خارج النطاق يُخبَر بهم المالك', () => {
  const s = read('src', 'pages', 'RepRoutesPage.tsx');
  assert.match(s, /warning/, 'تحذير الخادم يُتجاهل فيظنّ المالك خطّه كاملاً');
});

test('«أنجز اليوم» شرطةٌ لخطٍّ ليس خطَّ اليوم', () => {
  const s = routes();
  assert.match(s, /const isToday = r\.isPermanent \|\| r\.routeDate === day/, 'العدّاد يُحسب لكل خط بلا تمييز');
  assert.match(s, /doneToday: isToday \?/, 'خطٌّ ليوم آخر يجب أن يعطي null');
  const ui = read('src', 'pages', 'RepRoutesPage.tsx');
  assert.match(ui, /r\.doneToday === null/, 'الواجهة لا تعرض الشرطة');
});

test('زرّ التحديث في تطبيق المندوب يحرّك بطاقة خط السير', () => {
  // انحدارٌ من فصل النداء: صار التحديث لا يمسّ البطاقة فتبقى «٠ / ٤»
  const s = read('src', 'rep', 'RepApp.tsx');
  assert.match(s, /const loadRoute = useCallback/, 'لا دالّة تحميل مستقلّة');
  assert.match(s, /await cacheSet\('rep-home-stats', fresh\);\s*\n\s*loadRoute\(\);/, 'التحديث لا ينادي جلب خط السير');
});

test('حذف العميل لا يُمنع بمحطّة في خط سير', () => {
  const s = read('..', 'backend', 'prisma', 'schema.prisma');
  const i = s.indexOf('model RepRouteStop');
  const block = s.slice(i, i + 900);
  // محطّةٌ ليست سجلّاً مالياً، وRestrict كان يمنع حذف العميل أبداً برسالة خام
  assert.match(block, /references: \[id\], onDelete: Cascade/, 'حذف العميل ما زال ممنوعاً بمحطّة');
});
