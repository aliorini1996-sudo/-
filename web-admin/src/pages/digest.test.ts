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

test('لا تصدر حصيلة ويومُها فيه تقريرٌ ما زال في السلسلة', () => {
  const s = routes();
  assert.match(s, /status: \{ in: \['SUBMITTED', 'IN_REVIEW'\] \}/, 'شرط الاكتمال يجب أن يعدّ ما هو في الطريق');
  assert.match(s, /if \(inFlight > 0 && !\(existing \|\| force\)\) return 'blocked';/,
    'الإصدار يجب أن يتوقّف عند وجود تقريرٍ في الطريق');
});

/**
 * الوجه الثاني للشرط نفسه — وقد كان يُسقط أياماً كاملة من الأرشيف:
 *
 * • «في الطريق» كانت تعدّ **المُعاد للتصحيح** أيضاً، وتقريرٌ عند مندوبٍ استقال
 *   (أو في إجازة، أو تجاهل الإعادة) لا يعود أبداً ⇒ يومٌ بتسعة عشر تقريراً
 *   موقّعاً لا تصدر حصيلته قطّ، ولا حذف لتقريرٍ يوميّ ولا إصدار يدويّ.
 * • والإصدار كان **مرّةً واحدة**: يتحقّق الشرط عند أوّل اعتمادٍ يسبق ثاني رفعة
 *   (٨:٠٥ صباحاً) فتُخزَّن «١ تقرير · ١٩ لم يرفع» ثم تتجمّد أبداً.
 */
test('الحصيلة تُحدَّث كما تُصدَر، والمُعاد للتصحيح لا يحجب يومه أبداً', () => {
  const s = routes();
  assert.doesNotMatch(s, /status: \{ not: 'APPROVED' \} \}\s*\}\),\s*\n\s*prisma\.dailyReport\.findMany/,
    'المُعاد للتصحيح ليس «في الطريق» — عدُّه حاجزاً يُسقط يوماً كاملاً من الأرشيف');
  assert.match(s, /dailyReportDigest\.update\(\{ where: \{ id: existing\.id \}, data: counts \}\)/,
    'الصفّ علامةٌ لا نسخة: عدّاداته تُحدَّث مع كل اعتمادٍ لذلك اليوم');
  assert.match(s, /router\.post\('\/digests\/:date\/issue', requireAdmin, requireAdminPermission\('canManageDailyReport'\)/,
    'مسار الإصدار اليدويّ — الوعد الذي كان في التعليق وغير مبنيّ');
});

test('لا تصدر حصيلة ليومٍ بلا تقارير — «صفر» ليس اكتمالاً', () => {
  const s = routes();
  assert.match(s, /approved\.length === 0\) return/, 'يومٌ بلا تقارير يجب ألّا يُصدِر حصيلة');
});

test('الغائبون يُعدّون ويُعرضون — حصيلةٌ تخفيهم تبدو كاملة وهي ناقصة', () => {
  const s = routes();
  assert.match(s, /repCount,/, 'عدد المناديب النشطين يجب أن يُخزَّن');
  /* **الطرفان من فضاءٍ واحد**: `reports` مقيَّدةٌ بنطاق القارئ، فطرحُها من
   * عدّادٍ على مستوى الشركة كان يولّد «سبعة عشر غائباً» في يومٍ رفع فيه الجميع؛
   * وعدُّ المناديب **الآن** كان يُلحق تسعة موظّفين جدد بحصيلة مارس. فالمقام
   * لقطةُ يوم الإصدار (تُحدَّث مع كل اعتمادٍ لذلك اليوم) أو عدّ نطاق القارئ. */
  assert.match(s, /missingReps: Math\.max\(0, repCountEff - reports\.length\)/, 'الفرق يجب أن يُحسب من فضاءٍ واحد');
  /* والمتأخّر يُعدّ **بزمن اعتماده** لا بفرق العدّادين: الطرح كان يُعطي صفراً
   * دائماً للقارئ المقيَّد (بسطٌ مقيَّد ناقص مقامٍ غير مقيَّد) فيُدَسّ بصمت. */
  assert.match(s, /lateReports: reports\.filter\(r => r\.approvedAt && r\.approvedAt > digest\.issuedAt\)\.length/,
    'التقارير المتأخّرة يجب أن تُعرض صراحةً');
  const ui = read('src', 'pages', 'DailyReportDigests.tsx');
  assert.match(ui, /missingReps > 0/, 'الواجهة لا تعرض الغائبين');
});

test('فشل الإصدار لا يُسقط الاعتماد — خارج المعاملة وبـcatch', () => {
  const s = routes();
  // الاعتماد توقيعٌ وقع وسُجّل؛ تعذّرُ إصدار الحصيلة عرَضٌ لا يجوز أن يتراجع به
  assert.match(s, /if \(tr\.finalApproval\) await issueOrRefreshDigest\(tid, report\.reportDate\)\.catch/,
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

test('الحصيلة الواحدة تُقرأ رقماً واحداً على الشاشتين', () => {
  // hadData يُبنى على الخادم خصّيصاً لهذا؛ تجاهلُه على الجوال جعل اليوم الواحد
  // يُقرأ «—» على اللوحة و«0» على الجوال لخانةٍ لم تكن موجودة يومَها أصلاً
  const m = read('src', 'm', 'MDailyReports.tsx');
  assert.match(m, /f\.hadData \? num\(d\.totals\[f\.id\] \?\? 0\) : '—'/, 'إجمالي الجوال يطبع صفراً حيث الغياب');
  assert.match(m, /d\.lateReports > 0/, 'لافتة التقرير المتأخّر مفقودة من الجوال');
  assert.match(m, /!f\.isActive && <span className="text-gray-400"> \(\{tr\('مؤرشفة'\)\}\)/, 'وسم الخانة المؤرشَفة مفقود من الجوال');
});
