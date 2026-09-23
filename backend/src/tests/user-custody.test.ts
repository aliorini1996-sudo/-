import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  userCustody, handoverAllowed, removalKeepsCustodySane, CUSTODY_EPS, CustodyExceeded, CustodyBlocked,
} from '../services/userCustody';

/**
 * عهدة التحصيل لمستخدم الشركة: ما استلمه من المناديب ناقص ما ورّده.
 *
 * الاختبار قسمان: حسابٌ وقواعدُ سقفٍ تُختبر بالقيم، وحرّاسُ نصٍّ ثابتة على
 * مسارات المال. والحرّاس هنا ليست ترفاً: الخلل الذي وقع في المراجعة لم يكن في
 * الحساب بل في **مكان** الفحص (خارج المعاملة) وفي مسارٍ نسي الفحص أصلاً — وذاك
 * ما لا يلتقطه اختبار دالّة.
 */

const agg = (sum: number | null) => ({ aggregate: async () => ({ _sum: { amount: sum } }) });
const db = (received: number | null, delivered: number | null) => ({
  repSettlement: agg(received), userSettlement: agg(delivered),
}) as unknown as Parameters<typeof userCustody>[0];

test('العهدة = المستلم من المناديب ناقص المورد', async () => {
  assert.deepEqual(await userCustody(db(6075, 2000), 't1', 'u1'), { received: 6075, delivered: 2000, outstanding: 4075 });
});

test('لا صفوف: أصفار لا undefined', async () => {
  assert.deepEqual(await userCustody(db(null, null), 't1', 'u1'), { received: 0, delivered: 0, outstanding: 0 });
});

test('كسور العائمة لا تسرب إلى الرصيد', async () => {
  const { outstanding } = await userCustody(db(0.1 + 0.2, 0.3), 't1', 'u1');
  assert.equal(outstanding, 0); // لا 5.5e-17
});

test('سقف التوريد: الكل مقبول والزائد مرفوض', () => {
  assert.equal(handoverAllowed(4075, 4075), true, 'تسليم كامل');
  assert.equal(handoverAllowed(4075, 2000), true, 'تسليم جزئي');
  assert.equal(handoverAllowed(4075, 4075.004), true, 'ضمن هامش الكسور');
  assert.equal(handoverAllowed(4075, 4076), false, 'أكثر من العهدة');
  assert.equal(handoverAllowed(0, 100), false, 'عهدة فارغة');
});

/** الهامش نصف هللة لا نصف ريال: 0.49 كانت تمرّ في النسخة الأولى. */
test('هامش السقف لا يبتلع نصف ريال', () => {
  assert.ok(CUSTODY_EPS < 0.01, `الهامش ${CUSTODY_EPS} أوسع من هللة`);
  assert.equal(handoverAllowed(100, 100.49), false);
});

test('سقف التوريد: الصفر والسالب وغير الرقم مرفوضة', () => {
  for (const bad of [0, -5, NaN, Infinity]) assert.equal(handoverAllowed(4075, bad), false, `قبل ${bad}`);
});

test('حذف استلام المندوب: يمنع إن جعل العهدة سالبة', () => {
  // استلم 5000 وورّد 3000 ⇒ المتبقي 2000
  assert.equal(removalKeepsCustodySane(2000, 2000), true, 'إسقاط استلام لم يورد بعد');
  assert.equal(removalKeepsCustodySane(2000, 3000), false, 'إسقاط استلام ورد جزء منه');
  assert.equal(removalKeepsCustodySane(0, 1), false, 'عهدة مغلقة: كل إسقاط يجعلها سالبة');
});

test('خطأ السقف يحمل الرصيد ويصطاد كرفض عهدة', () => {
  const err = new CustodyExceeded(4075, 9000);
  assert.ok(err instanceof CustodyBlocked, 'يصطاده المسار بشرط واحد');
  assert.match(err.message, /4075/);
});

// ═══════════ حرّاس نصّ على مسارات المال ═══════════

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');

test('حارس ثابت: سقف التوريد يفحص داخل المعاملة بعد القفل', () => {
  const src = read('routes', 'companyUsers.ts');
  const tx = src.slice(src.indexOf("router.post('/:id/settlements'"), src.indexOf("router.get('/:id/settlements'"));
  const lock = tx.indexOf('lockCustody');
  const check = tx.indexOf('handoverAllowed');
  const write = tx.indexOf('userSettlement.create');
  assert.ok(lock > 0 && check > lock && write > check,
    'الترتيب الواجب: قفل ← فحص السقف ← الكتابة. فحصٌ قبل القفل يمرره طلبان متزامنان');
  assert.ok(tx.includes('$transaction'), 'الفحص والكتابة في معاملة واحدة');
});

test('حارس ثابت: حذف مستخدم الشركة يفحص عهدته', () => {
  const src = read('routes', 'companyUsers.ts');
  const del = src.slice(src.indexOf("router.delete('/:id',"));
  const body = del.slice(0, del.indexOf('\nrouter.'));
  assert.ok(/userCustody\(/.test(body) && /CUSTODY_EPS/.test(body),
    'بلا هذا الفحص يختفي نقد استلمه المحذوف من المناديب — الصفوف بلا مفتاح أجنبي');
});

test('حارس ثابت: حذف استلام المندوب يفحص عهدة مستلمه', () => {
  const src = read('routes', 'salesReps.ts');
  const del = src.slice(src.indexOf("router.delete('/:id/settlements/:settlementId'"));
  assert.ok(/removalKeepsCustodySane/.test(del) && /lockCustody/.test(del),
    'إسقاط استلام ورده صاحبه يجعل عهدته سالبة فتمنع كل توريد لاحق');
});

test('حارس ثابت: جلسة انتحال المالك لا تقيد عهدة ولا تستلمها', () => {
  const reps = read('routes', 'salesReps.ts');
  assert.match(reps, /const receivedByUserId = by\?\.impersonated === true \? undefined : by\?\.id;/,
    'توكن الانتحال موقع بمعرف أقدم مدير — لا تقيد العهدة عليه');
  const users = read('routes', 'companyUsers.ts');
  const post = users.slice(users.indexOf("router.post('/:id/settlements'"));
  assert.ok(post.slice(0, post.indexOf('userSettlement.create')).includes('impersonated'),
    'من يقبض النقد يوقعه بحسابه لا بجلسة الدعم الفني');
});

test('حارس ثابت: منح صلاحية استلام التحصيل محصور في مدير الشركة', () => {
  const src = read('routes', 'companyUsers.ts');
  assert.equal((src.match(/blocksCustodyGrant\(/g) || []).length, 3,
    'التعريف + الإنشاء + التعديل: نقصانها يعني بابا يمنح المشرف نفسه صلاحية قبض النقد');
  assert.match(src, /caller\.role !== 'ADMIN'/);
});

test('حارس ثابت: سجل التوريدات لا يحمل الصور', () => {
  const src = read('routes', 'companyUsers.ts');
  const list = src.slice(src.indexOf("router.get('/:id/settlements'"));
  const body = list.slice(0, list.indexOf('\nrouter.'));
  assert.ok(/photos: \{ select: \{ id: true \} \}/.test(body),
    'مئة صف بأربع صور base64 عشرات الميجابايتات في رد لا يعرض إلا عدادا');
  assert.ok(src.includes("router.get('/:id/settlements/:sid/photos'"), 'للصور مسارها عند فتح العارض');
});
