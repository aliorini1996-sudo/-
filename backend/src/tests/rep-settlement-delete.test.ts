import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس حذف «استلام تحصيل» من سجلّ المندوب.
 *
 * لماذا حرّاسٌ على النصّ لا اختبارُ طلبٍ حيّ: المسار يحتاج قاعدة بيانات وجلسةً
 * حقيقية، والقاعدة ممنوعة هنا. والخطر الذي نحرسه ليس في حسابٍ رياضيّ بل في
 * **غياب سطر**: حارسٌ يُنسى، أو قيدُ شركةٍ يسقط، أو يُقرأ الدور من التوكن.
 * ثلاثتها أخطاءٌ صامتة تمرّ من المراجعة ولا يكشفها إلا فحصٌ يسأل عنها بالاسم.
 */

const ROUTE = path.join(process.cwd(), 'src', 'routes', 'salesReps.ts');
const src = fs.readFileSync(ROUTE, 'utf8');

/** جسم معالِج الحذف وحده — كي لا يمرّ الفحص بحارسٍ يخصّ مساراً مجاوراً */
function deleteHandler(): string {
  const start = src.indexOf("router.delete('/:id/settlements/:settlementId'");
  assert.ok(start > 0, 'مسار حذف استلام التحصيل مفقود من salesReps.ts');
  const rest = src.slice(start);
  const end = rest.indexOf('\nrouter.');
  return end > 0 ? rest.slice(0, end) : rest;
}

test('الحذف محروس بالأدمن الرئيسي — لا مشرف ولا محاسب', () => {
  const h = deleteHandler();
  assert.match(h, /isPrimaryAdmin\(req\)/, 'معالج الحذف لا يستدعي حارس الأدمن الرئيسي');
  assert.match(h, /res\.status\(403\)/, 'لا يردّ 403 على غير الأدمن الرئيسي');
});

test('الدور يُقرأ من القاعدة لا من التوكن — توكنٌ فائتٌ لا يفتح باب الحذف', () => {
  const guard = /async function isPrimaryAdmin\(req: AuthRequest\)[\s\S]*?\n\}/.exec(src);
  assert.ok(guard, 'دالة isPrimaryAdmin غير موجودة');
  const g = guard![0];
  assert.match(g, /prisma\.admin\.findUnique/, 'الحارس لا يقرأ الدور من قاعدة البيانات');
  assert.match(g, /role === 'ADMIN'/, 'الحارس لا يشترط الدور ADMIN');
  assert.match(g, /isActive/, 'الحارس لا يشترط أن يكون الحساب نشطاً');
  assert.match(g, /tenantId === tenantId\(req\)/, 'الحارس لا يطابق شركة المستخدم');
  assert.doesNotMatch(g, /req\.user\?\.role/, 'الحارس يعود إلى دور التوكن — وهو ما نمنعه');
});

test('الصفّ المحذوف مقيَّد بالشركة والمندوب معاً — لا يُحذف صفُّ غيرهما بمعرّف منقول', () => {
  const h = deleteHandler();
  const where = /repSettlement\.findFirst\(\{\s*where:\s*\{([^}]*)\}/.exec(h);
  assert.ok(where, 'لا يُقرأ صفّ الاستلام قبل حذفه');
  const w = where![1];
  assert.match(w, /id: req\.params\.settlementId/, 'لا يُقيَّد بمعرّف الاستلام');
  assert.match(w, /tenantId: tid/, 'لا يُقيَّد بالشركة — ثغرة عبور بين الشركات');
  assert.match(w, /salesRepId: rep\.id/, 'لا يُقيَّد بالمندوب');
});

test('الحذف لا يمضي صامتاً — يُقيَّد في الإشعارات بنسخةٍ تسمح بإعادته', () => {
  const h = deleteHandler();
  assert.match(h, /prisma\.\$transaction/, 'الحذف والتقييد ليسا في معاملة واحدة');
  assert.match(h, /REP_SETTLEMENT_DELETED/, 'لا يُسجَّل إشعار بالحذف');
  for (const field of ['amount', 'note', 'createdBy', 'settledAt', 'deletedBy']) {
    assert.match(h, new RegExp(`${field}`), `نسخة الصفّ المحفوظة تُغفل ${field}`);
  }
});

/**
 * الأثر التدقيقيّ يجب أن يُقرأ من **نصّ** الإشعار: لا شاشة في المنتج تعرض حقل
 * `data`، فلو اكتُفي به لصار الوعد بالاستعادة حبراً على ورق. ونصّ يذكر المبلغ
 * وحده لا يكفي لإعادة التسجيل — يلزم تاريخه ومن استلمه أصلاً.
 */
test('نصّ الإشعار وحده يكفي لإعادة تسجيل الاستلام يدوياً', () => {
  const h = deleteHandler();
  const from = h.indexOf('body:');
  const to = h.indexOf('data: JSON.stringify');
  assert.ok(from > 0 && to > from, 'لا نصّ إشعار في المعالج');
  const whole = h.slice(from, to); // نصّ body وحده — قبل نسخة الآلة في data
  assert.match(whole, /clean\(row\.amount\)/, 'النصّ لا يذكر المبلغ');
  assert.match(whole, /\$\{when\}/, 'النصّ لا يذكر تاريخ الاستلام الأصلي');
  assert.match(whole, /row\.createdBy/, 'النصّ لا يذكر من استلم المبلغ أصلاً');
  assert.match(whole, /\$\{actor\}/, 'النصّ لا يذكر من حذف');
});

/** جلسة تصفّح المالك تُنسب لصاحبها — لا تُقيَّد باسم أدمن الشركة المنتحَل */
test('الانتحال موسوم في الأثر التدقيقي', () => {
  const h = deleteHandler();
  assert.match(h, /by\?\.impersonated/, 'جلسة الانتحال تُنسب لأدمن الشركة زوراً');
});

/**
 * الحارس الجديد لا معنى له إن بقي بجواره بابٌ أوسع: حذف المندوب يمحو في
 * معاملته **كل** استلاماته دفعةً واحدة، فيجب أن يقرأ الدور من القاعدة أيضاً.
 */
test('حذف المندوب — الباب الأوسع على السجلّ نفسه — بالحارس نفسه', () => {
  const start = src.indexOf("router.delete('/:id'");
  assert.ok(start > 0, 'مسار حذف المندوب مفقود');
  const h = src.slice(start, start + 2600);
  assert.match(h, /isPrimaryAdmin\(req\)/, 'حذف المندوب ما زال يقرأ الدور من التوكن');
  assert.match(h, /repSettlement\.deleteMany/, 'تغيّر شكل المعاملة — أعد فحص الحارس');
  assert.match(
    h, /notification\.deleteMany\(\{ where: \{ tenantId: tid, salesRepId/,
    'حذف الإشعارات (الأثر التدقيقي) غير مقيَّد بالشركة',
  );
});

/** السجلّ الذي تُرسم عليه أزرار الحذف يجب أن يُقيَّد بنطاق المستخدم كشقيقيه */
test('سجلّ الاستلامات مقيَّد بنطاق المستخدم لا بالشركة وحدها', () => {
  const start = src.indexOf("router.get('/:id/settlements'");
  assert.ok(start > 0, 'مسار سجلّ الاستلامات مفقود');
  const h = src.slice(start, src.indexOf('\nrouter.', start));
  assert.match(h, /adminRepFilter\(req\)/, 'مستخدم مقيَّد النطاق يقرأ سجلّ مندوبٍ خارج نطاقه');
});

test('المندوب يُقرأ بقيد الشركة ونطاق المستخدم قبل أيّ حذف', () => {
  const h = deleteHandler();
  assert.match(h, /salesRep\.findFirst/, 'لا يُتحقَّق من المندوب');
  assert.match(h, /adminRepFilter\(req\)/, 'نطاق المستخدم المقيَّد غير مطبَّق على المندوب');
});

test('الردّ يعيد الرصيد المحسوب من الخادم لا من حسابٍ محلّيّ في الواجهة', () => {
  const h = deleteHandler();
  assert.match(h, /repCollection\(tid, rep\.id\)/, 'لا يُعاد الرصيد بعد الحذف');
});

/**
 * حارس الواجهة: الزرّ يظهر للأدمن الرئيسي وحده. إخفاؤه ليس أمناً — الخادم هو
 * الأمن — لكن ظهوره لمن لا يملكه يعني نقرةً تنتهي بـ403، وهذا عطبٌ في التجربة.
 */
test('زرّ الحذف في اللوحة مشروط بالأدمن الرئيسي', () => {
  const page = fs.readFileSync(
    path.join(process.cwd(), '..', 'web-admin', 'src', 'pages', 'SalesRepsPage.tsx'),
    'utf8',
  );
  const modal = page.slice(page.indexOf('function ReceiveCollectionModal'));
  assert.match(modal, /isMainAdmin = user\?\.role === 'ADMIN'/, 'النافذة لا تحسب الأدمن الرئيسي');
  assert.match(modal, /\{isMainAdmin && \(/, 'زرّ الحذف غير مشروط بالأدمن الرئيسي');
  assert.match(modal, /deleteSettlement\(rep\.id/, 'الزرّ لا ينادي نقطة الحذف');
  assert.match(modal, /ConfirmDialog/, 'الحذف بلا نافذة تأكيد');
});
