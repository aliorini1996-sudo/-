import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {
  userCustody, handoverAllowed, removalKeepsCustodySane, CUSTODY_EPS, CustodyExceeded, CustodyBlocked,
  userCustodyMany, userCustodyFold, handoverAllowedFor, handoverCap,
} from '../services/userCustody';

/**
 * عهدة التحصيل لمستخدم الشركة: ما استلمه من المناديب ناقص ما ورّده.
 *
 * الاختبار قسمان: حسابٌ وقواعدُ سقفٍ تُختبر بالقيم، وحرّاسُ نصٍّ ثابتة على
 * مسارات المال. والحرّاس هنا ليست ترفاً: الخلل الذي وقع في المراجعة لم يكن في
 * الحساب بل في **مكان** الفحص (خارج المعاملة) وفي مسارٍ نسي الفحص أصلاً — وذاك
 * ما لا يلتقطه اختبار دالّة.
 */

// ═══ عميل مزيّف بصفوف حقيقية: groupBy (من له تاريخ) ثم findMany (صفوف الطيّ) — ويحصي القراءات ═══

type Row = Record<string, unknown>;
const T0 = new Date('2026-09-01T08:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function whereMatch(r: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as { in?: unknown[]; not?: unknown };
      if ('in' in o) return (o.in ?? []).includes(r[k]);
      if ('not' in o) return r[k] !== o.not;
    }
    return r[k] === v;
  });
}

function fakeCustodyDb(rows: { rec?: Row[]; del?: Row[]; rct?: Row[] }) {
  const calls: string[] = [];
  const model = (name: string, list: Row[]) => ({
    groupBy: async ({ by, where }: { by: string[]; where: Row }) => {
      calls.push(`${name}.groupBy`);
      const seen = new Map<string, Row>();
      for (const r of list.filter((x) => whereMatch(x, where))) {
        const key = by.map((b) => String(r[b])).join('|');
        if (!seen.has(key)) seen.set(key, Object.fromEntries(by.map((b) => [b, r[b]])));
      }
      return [...seen.values()];
    },
    findMany: async ({ where }: { where: Row }) => { calls.push(`${name}.findMany`); return list.filter((x) => whereMatch(x, where)); },
  });
  const db = {
    repSettlement: model('repSettlement', rows.rec ?? []),
    userSettlement: model('userSettlement', rows.del ?? []),
    receipt: model('receipt', rows.rct ?? []),
  };
  return { db: db as unknown as Parameters<typeof userCustody>[0], calls };
}

const rec = (id: string, amount: number, method = 'CASH', min = 0, user = 'u1'): Row =>
  ({ id, tenantId: 't1', receivedByUserId: user, amount, method, settledAt: at(min), createdAt: at(min) });
const del = (id: string, amount: number, method = 'CASH', min = 10, user = 'u1'): Row =>
  ({ id, tenantId: 't1', fromUserId: user, amount, method, settledAt: at(min), createdAt: at(min) });
const refund = (id: string, amount: number, user = 'u1'): Row =>
  ({ id, tenantId: 't1', status: 'CANCELLED', cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: user, amount, updatedAt: at(20), createdAt: at(1) });
const ZERO = { received: 0, delivered: 0, outstanding: 0, nonCashReceived: 0, passThrough: 0 };

test('العهدة = المستلم من المناديب ناقص المورد', async () => {
  const { db } = fakeCustodyDb({ rec: [rec('r1', 6075)], del: [del('d1', 2000)] });
  assert.deepEqual(await userCustody(db, 't1', 'u1'), { ...ZERO, received: 6075, delivered: 2000, outstanding: 4075 });
});

test('لا صفوف: أصفار لا undefined — وتجميعتان فقط بلا قراءة صفوف ولا سندات', async () => {
  const { db, calls } = fakeCustodyDb({});
  assert.deepEqual(await userCustody(db, 't1', 'u1'), ZERO);
  assert.deepEqual(calls.sort(), ['repSettlement.groupBy', 'userSettlement.groupBy']);
});

test('كسور العائمة لا تسرب إلى الرصيد', async () => {
  const { db } = fakeCustodyDb({ rec: [rec('r1', 0.1), rec('r2', 0.2)], del: [del('d1', 0.3)] });
  const { outstanding } = await userCustody(db, 't1', 'u1');
  assert.equal(outstanding, 0); // لا 5.5e-17
});

// ═══ OD5: العهدة نقد وشيكات وحدها ═══

test('OD5: التحويل ونقطة البيع لا يدخلان العهدة، والتوريد غير النقدي يمرّ منهما أولاً، والشيك عهدة', async () => {
  const { db } = fakeCustodyDb({
    rec: [rec('c', 500), rec('q', 200, 'CHEQUE', 1), rec('b', 300, 'BANK_TRANSFER', 2), rec('p', 100, 'POS', 3)],
    del: [del('d1', 350, 'BANK_TRANSFER', 10)],
  });
  // الوعاء 400 (300+100) ⇒ التوريد 350 مرور كله؛ العهدة النقدية 700 كما هي
  assert.deepEqual(await userCustody(db, 't1', 'u1'),
    { received: 700, delivered: 0, outstanding: 700, nonCashReceived: 400, passThrough: 350 });
  const fold = await userCustodyFold(db, 't1', 'u1');
  assert.equal(fold.nonCashPoolMilli, 50_000n);
  // السقف: نقداً 700، وتحويلاً 700 + 50 الباقية في الوعاء
  assert.equal(handoverCap(fold, 'CASH'), 700);
  assert.equal(handoverCap(fold, 'CHEQUE'), 700);
  assert.equal(handoverCap(fold, 'BANK_TRANSFER'), 750);
  assert.equal(handoverAllowedFor(fold, 'CASH', 700), true);
  assert.equal(handoverAllowedFor(fold, 'CASH', 700.004), true, 'ضمن هامش الكسور');
  assert.equal(handoverAllowedFor(fold, 'CASH', 701), false);
  assert.equal(handoverAllowedFor(fold, 'BANK_TRANSFER', 750), true);
  assert.equal(handoverAllowedFor(fold, 'POS', 750.01), false);
  for (const bad of [0, -5, NaN, Infinity]) assert.equal(handoverAllowedFor(fold, 'CASH', bad), false, `قبل ${bad}`);
});

test('OD5: توريدٌ غير نقدي أكبر من الوعاء ⇒ الزائد نقدٌ أُودع البنك (ينقص العهدة)، والتاريخ القديم بلا سالب', async () => {
  // استلم تحويلاً 300 ثم نقداً 500، وورّد تحويلاً 500: 300 مرور + 200 من النقد
  const { db } = fakeCustodyDb({ rec: [rec('b', 300, 'BANK_TRANSFER', 0), rec('c', 500, 'CASH', 1)], del: [del('d', 500, 'BANK_TRANSFER', 5)] });
  assert.deepEqual(await userCustody(db, 't1', 'u1'),
    { received: 500, delivered: 200, outstanding: 300, nonCashReceived: 300, passThrough: 300 });
});

test('C11: ما رُدّ من عهدة المستخدم لعميلٍ أُلغي سنده ينقص العهدة، ويُعدّ في «ما خرج»', async () => {
  const { db } = fakeCustodyDb({ rec: [rec('c', 800)], rct: [refund('rc1', 500), refund('rc2', 100, 'u2')] });
  const c = await userCustody(db, 't1', 'u1');
  assert.deepEqual(c, { ...ZERO, received: 800, delivered: 500, outstanding: 300 });
  assert.equal(c.outstanding, c.received - c.delivered, 'outstanding = received − delivered دائماً');
});

test('userCustodyMany: كل المستخدمين بخمس قراءات على الأكثر (لا N+1)، ولا سندات حين لا تاريخ لأحد', async () => {
  const many = fakeCustodyDb({
    rec: Array.from({ length: 30 }, (_, i) => rec(`r${i}`, 100, i % 3 === 0 ? 'BANK_TRANSFER' : 'CASH', i, `u${i % 10}`)),
    del: Array.from({ length: 10 }, (_, i) => del(`d${i}`, 50, i % 2 ? 'BANK_TRANSFER' : 'CASH', 100 + i, `u${i}`)),
    rct: [refund('x', 10, 'u3')],
  });
  const m = await userCustodyMany(many.db, 't1');
  assert.equal(m.size, 10);
  assert.ok(many.calls.length <= 5, `${many.calls.length} قراءة`);
  for (const [u, c] of m) {
    const single = await userCustody(fakeCustodyDb({
      rec: Array.from({ length: 30 }, (_, i) => rec(`r${i}`, 100, i % 3 === 0 ? 'BANK_TRANSFER' : 'CASH', i, `u${i % 10}`)),
      del: Array.from({ length: 10 }, (_, i) => del(`d${i}`, 50, i % 2 ? 'BANK_TRANSFER' : 'CASH', 100 + i, `u${i}`)),
      rct: [refund('x', 10, 'u3')],
    }).db, 't1', u);
    assert.deepEqual(c, single, `المستخدم ${u}: المجمّع = المفرد`);
  }
  const none = fakeCustodyDb({ rct: [refund('x', 10, 'u3')] });
  assert.equal((await userCustodyMany(none.db, 't1')).size, 0);
  assert.ok(!none.calls.some((c) => c.startsWith('receipt.')), 'مسح السندات لمن لا تاريخ له');
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

test('حارس ثابت: القفل الاستشاري بـ$executeRaw لا $queryRaw — في العهدة وفي الخادم كله', () => {
  // الدالة تُرجع void، و$queryRaw يقرأ العمود فيفشل «Failed to deserialize column of type 'void'» — فسقط كل استلام عهدة
  // بخطأ خادم (بلاغ المالك، ٢٩ سبتمبر ٢٠٢٦). المعاملات الوهمية في الاختبارات لا تلتقطه، فالحارس نصّي.
  const custody = read('services', 'userCustody.ts');
  assert.match(custody, /await tx\.\$executeRaw`SELECT pg_advisory_xact_lock\(hashtext\(\$\{`custody:\$\{tid\}:\$\{userId\}`\}::text\)\)`;/);
  const bad: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue;
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\$queryRaw(Unsafe)?\s*[`(<][^\n]*pg_advisory(_xact)?_lock\s*\(/.test(line)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
  };
  walk(path.join(process.cwd(), 'src'));
  assert.deepEqual(bad, [], 'pg_advisory_*lock بـ$queryRaw يسقط بخطأ void');
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
  // «ربط الدفاتر» OD5: الحارس بالطيّ (receivedRemovalKeepsCustodySane) — العهدة النقدية لا تُقارن باستلامٍ غير نقدي
  assert.ok(/[rR]emovalKeepsCustodySane/.test(del) && /lockCustody/.test(del),
    'إسقاط استلام ورده صاحبه يجعل عهدته سالبة فتمنع كل توريد لاحق');
});

test('حارس ثابت: جلسة انتحال المالك تستلم التحصيل والعهدة دون أن تُقيَّد على حساب توكنها', () => {
  const reps = read('routes', 'salesReps.ts');
  assert.match(reps, /const receivedByUserId = by\?\.impersonated === true \? undefined : by\?\.id;/,
    'توكن الانتحال موقع بمعرف مدير في الشركة — لا تقيد العهدة عليه');
  // أمر المالك ٢٩ سبتمبر ٢٠٢٦ «صلاحية تعديل كل شيء بلا استثناء»: الجلسة تستلم عهدة المستخدم، والمستلم «مالك المنصة» لا حساب التوكن
  const users = read('routes', 'companyUsers.ts');
  const post = users.slice(users.indexOf("router.post('/:id/settlements'"));
  const body = post.slice(0, post.indexOf('\nrouter.'));
  assert.ok(!body.includes('جلسة الدعم الفني'), 'رفض الاستلام من جلسة المالك عاد');
  assert.match(body, /by\?\.impersonated === true\s*\? \{ receivedBy: 'مالك المنصة \(الدعم الفني\)' \}/,
    'الاستلام من الجلسة يُنسب إلى حساب مدير لم يقبض شيئاً');
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
