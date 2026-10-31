// «الوحدة الرئيسية» §2.5 — حارس وحدة الأساس (services/baseGuard.ts) وحده، بمعاملةٍ مزيّفة تسجّل SQL كما يصل إلى Prisma.
// ما يُحرس: القفل المشترك FOR KEY SHARE بترتيب المعرّف وبمهلة LOT_LOCK_TIMEOUT تُحفظ وتُستعاد (I10)، والمقارنة بـbaseNameKey على
// الطرفين (D20-أ)، وتخطّي المعاملة المزيّفة بلا $queryRaw، وردود 409/503/400، وسجلّ «قيد التحويل» في الذاكرة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_GUARD_TX, ProductUnitsBusyError, ProductUnitsChangedError, anyConverting, assertBasesUnchanged, baseGuardReply, baseNameKey,
  baseUnitRequiredReply, expectedBasesOf, lockBases, markConverting, missingBaseForApi, movedBases, staleClientBase, unmarkConverting,
  type ExpectedBases,
} from '../services/baseGuard';
import { LOT_LOCK_TIMEOUT } from '../services/lotsDb';
import { lotErr } from '../services/lots';
import { UnitInvalidError } from '../services/warehouseStock';

type Call = { op: 'query' | 'exec'; sql: string; values: unknown[] };
const render = (strings: TemplateStringsArray, values: unknown[]) => ({
  sql: strings.reduce((s, part, i) => s + part + (i < values.length ? `$${i + 1}` : ''), '').replace(/\s+/g, ' ').trim(),
  values,
});
/** معاملة مزيّفة: `rows` تجيب كل $queryRaw، و`fail` يرمي عند SQL يطابقه */
function fakeTx(rows: (sql: string, values: unknown[]) => unknown[] = () => [], fail?: (sql: string) => unknown) {
  const calls: Call[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const r = render(strings, values);
      calls.push({ op: 'query', ...r });
      const e = fail?.(r.sql);
      if (e) throw e;
      return rows(r.sql, r.values);
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const r = render(strings, values);
      calls.push({ op: 'exec', ...r });
      return 1;
    },
  };
  return { tx: tx as never, calls };
}
const EXP: ExpectedBases = new Map([
  ['p2', { name: 'عصير', unit: 'علبة' }],
  ['p1', { name: 'ماء', unit: 'قارورة' }],
]);
const lockRows = (units: Record<string, string>) => (sql: string, values: unknown[]) => {
  if (sql.includes("current_setting('lock_timeout')")) return [{ lock_timeout: '7s' }];
  if (sql.includes('FOR KEY SHARE')) return (values[1] as string[]).map((id) => ({ id, unit: units[id], lotTracked: false, lotTrackedSince: null }));
  return [];
};

test('lockBases: حفظ المهلة ثم ضبطها ثم FOR KEY SHARE بترتيب المعرّف ثم استعادة السابقة — والأساس نفسه يمرّ بصفوفه', async () => {
  const { tx, calls } = fakeTx(lockRows({ p1: 'قارورة', p2: 'علبة' }));
  const rows = await lockBases(tx, 't1', EXP);
  assert.deepEqual(rows.map((r) => r.id), ['p1', 'p2']);
  assert.deepEqual(calls.map((c) => c.op), ['query', 'exec', 'query', 'exec']);
  assert.match(calls[0].sql, /current_setting\('lock_timeout'\)/);
  assert.deepEqual([calls[1].sql, calls[1].values], ["SELECT set_config('lock_timeout', $1, true)", [LOT_LOCK_TIMEOUT]]);
  assert.match(calls[2].sql, /^SELECT id, unit, "lotTracked", "lotTrackedSince" FROM products WHERE "tenantId" = \$1 AND id = ANY\(\$2::text\[\]\) ORDER BY id FOR KEY SHARE$/);
  assert.deepEqual(calls[2].values, ['t1', ['p1', 'p2']], 'المعرّفات مرتّبة فلا تتعاكس الأقفال بين كاتبَين');
  assert.deepEqual([calls[3].sql, calls[3].values], ["SELECT set_config('lock_timeout', $1, true)", ['7s']], 'تُستعاد السابقة لا الافتراضية');
});

test('lockBases: أساسٌ تغيّر تحت القفل ⇒ ProductUnitsChangedError باسم الصنف، وانتظارٌ طويل ⇒ ProductUnitsBusyError، وغيرهما كما هو', async () => {
  const moved = fakeTx(lockRows({ p1: 'كرتون', p2: 'علبة' }));
  await assert.rejects(lockBases(moved.tx, 't1', EXP), (e: unknown) => e instanceof ProductUnitsChangedError && e.names.join() === 'ماء');
  for (const raw of [
    Object.assign(new Error('canceling statement due to lock timeout'), { code: 'P2010', meta: { code: '55P03' } }),
    Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    Object.assign(new Error('Transaction already closed'), { code: 'P2028' }),
  ]) {
    const busy = fakeTx(lockRows({}), (sql) => (sql.includes('FOR KEY SHARE') ? raw : null));
    await assert.rejects(lockBases(busy.tx, 't1', EXP), ProductUnitsBusyError, String(raw.message));
  }
  const boom = fakeTx(lockRows({}), (sql) => (sql.includes('FOR KEY SHARE') ? new Error('boom') : null));
  await assert.rejects(lockBases(boom.tx, 't1', EXP), /boom/);
});

test('lockBases: بلا أصناف لا SQL، والمعاملة المزيّفة بلا $queryRaw تُتخطّى، وصفٌّ بلا unit لا يُحكم عليه', async () => {
  const empty = fakeTx();
  assert.deepEqual(await lockBases(empty.tx, 't1', new Map()), []);
  assert.equal(empty.calls.length, 0);
  assert.deepEqual(await lockBases({ product: {} } as never, 't1', EXP), [], 'مزيّف مسارٍ بلا SQL خام');
  const noUnit = fakeTx((sql, v) => (sql.includes('FOR KEY SHARE') ? (v[1] as string[]).map((id) => ({ id, lotTracked: false, lotTrackedSince: null })) : []));
  assert.equal((await lockBases(noUnit.tx, 't1', EXP)).length, 2);
});

test('movedBases وassertBasesUnchanged: المقارنة بـbaseNameKey على الطرفين، والغائب لا يُحكم عليه، وغير المتوقَّع يُتجاهل', () => {
  assert.deepEqual(movedBases(EXP, [{ id: 'p1', unit: ' قارورة ' }, { id: 'p2', unit: 'كرتون' }, { id: 'pX', unit: 'أي' }]), ['عصير']);
  assert.doesNotThrow(() => assertBasesUnchanged(EXP, new Map([['p1', 'قارورة']])), 'p2 غائب عن الخريطة (صفوف مقفلة سلفاً بلا unit)');
  assert.throws(() => assertBasesUnchanged(EXP, new Map([['p1', 'كرتون'], ['p2', 'كيس']])), (e: unknown) => e instanceof ProductUnitsChangedError && e.names.join('|') === 'عصير|ماء');
  const long = 'ق'.repeat(70);
  assert.deepEqual(movedBases(new Map([['p', { name: 'طويل', unit: long }]]), [{ id: 'p', unit: long.slice(0, 64) }]), [], 'اسمٌ أطول من ٦٤ لا يُرى متغيّراً');
});

test('staleClientBase: أول صنفٍ أرسل أساساً غير أساسه الآن، والبند بلا الحقل أو بفراغه مسار اليوم، والاسم الطويل لا يُرى قديماً', () => {
  const lines = [{ productId: 'p1', baseUnitName: 'قارورة' }, { productId: 'p2' }, { productId: 'p2', baseUnitName: '  ' }, { productId: 'p2', baseUnitName: null }];
  assert.equal(staleClientBase(lines, EXP), null);
  assert.equal(staleClientBase([...lines, { productId: 'p1', baseUnitName: 'كرتون' }], EXP), 'ماء');
  assert.equal(staleClientBase([{ productId: 'pX', baseUnitName: 'كرتون' }], EXP), null, 'صنفٌ مجهول يحكمه فحص الصلاحية لا هذا');
  const long = 'ب'.repeat(80);
  // العميل يرسل الاسم كاملاً، والمخطّط يقصّه إلى ٦٤ (z.string().transform(v => v.slice(0, 64)))
  assert.equal(staleClientBase([{ productId: 'p', baseUnitName: long.slice(0, 64) }], new Map([['p', { name: 'طويل', unit: long }]])), null);
  assert.equal(baseNameKey(`  ${long}`), long.slice(0, 64));
});

test('missingBaseForApi (D19): مفتاح API وصنفٌ محوَّل وبندٌ بلا الأساس ⇒ اسمه؛ وغير المحوَّل أو الجلسة أو البند الحامل ⇒ null', () => {
  const prods = new Map([['p1', { name: 'ماء', baseConvertedAt: new Date('2026-10-30') }], ['p2', { name: 'عصير', baseConvertedAt: null }]]);
  assert.equal(missingBaseForApi(true, [{ productId: 'p2' }, { productId: 'p1' }], prods), 'ماء');
  assert.equal(missingBaseForApi(true, [{ productId: 'p1', baseUnitName: ' ' }], prods), 'ماء', 'الفراغ غيابٌ');
  assert.equal(missingBaseForApi(true, [{ productId: 'p1', baseUnitName: 'قارورة' }, { productId: 'p2' }], prods), null);
  assert.equal(missingBaseForApi(false, [{ productId: 'p1' }], prods), null, 'اللوحة وتطبيق المندوب لا يتأثّران');
  const r = baseUnitRequiredReply('ماء');
  assert.deepEqual([r.status, r.body.code, r.body.success], [400, 'BASE_UNIT_REQUIRED', false]);
  assert.match(r.body.message, /«ماء»/);
  assert.doesNotMatch(r.body.message, /الأساس/, 'D21: لا «الأساس» في نصٍّ جديد');
});

test('baseGuardReply: التبدّل 409 حيّاً و503 لإعادة الرفع، والانتظار 503 PRODUCT_UNITS_BUSY، وأخطاء التطبيق وLotError ليست له', () => {
  const ch = new ProductUnitsChangedError(['ماء', 'عصير']);
  assert.deepEqual(baseGuardReply(ch, false), { status: 409, body: { success: false, code: 'PRODUCT_UNITS_CHANGED', message: 'تغيّرت وحدات «ماء، عصير» أثناء الحفظ — حدّث الأصناف ثم أعد المحاولة' } });
  assert.equal(baseGuardReply(ch, true)?.status, 503, 'إعادة الرفع لا تُعدم بـ4xx: الصندوق يعيد');
  for (const e of [
    new ProductUnitsBusyError(),
    Object.assign(new Error('x'), { code: 'P2010', meta: { code: '55P03' } }),
    Object.assign(new Error('x'), { code: '40P01' }),
    Object.assign(new Error('Transaction API error: Transaction already closed'), { code: 'P2028' }),
    new Error('canceling statement due to lock timeout'),
  ]) assert.deepEqual([baseGuardReply(e, false)?.status, baseGuardReply(e, false)?.body.code], [503, 'PRODUCT_UNITS_BUSY'], String(e.message));
  assert.equal(baseGuardReply(lotErr('LOT_BUSY'), false), null, 'LOT_BUSY يبقى لمعالجه في مسارات اللوط');
  assert.equal(baseGuardReply(new UnitInvalidError('تغيّرت وحدات «lock timeout» — حدّث'), false), null, 'اسم صنفٍ يطابق النمط لا يقلب 400 إلى 503');
  assert.equal(baseGuardReply(Object.assign(new Error('deadlock detected X'), { status: 400 }), false), null);
  assert.equal(baseGuardReply(new Error('boom'), false), null);
  assert.equal(baseGuardReply(null, false), null);
});

test('expectedBasesOf وBASE_GUARD_TX: الأساس من القراءة المسبقة، والمهلة لا تسبقها مهلة Prisma الافتراضية (I10)', () => {
  const e = expectedBasesOf([{ id: 'p1', name: 'ماء', unit: 'قارورة', extra: 1 } as { id: string; name: string; unit: string }]);
  assert.deepEqual([...e], [['p1', { name: 'ماء', unit: 'قارورة' }]]);
  assert.deepEqual(BASE_GUARD_TX, { maxWait: 10_000, timeout: 20_000 });
  assert.ok(BASE_GUARD_TX.timeout > 5_000 && BASE_GUARD_TX.maxWait > 5_000);
});

test('سجلّ «قيد التحويل»: عدّادٌ لكل شركة وصنف — تحويلان متداخلان لا يمحو أحدهما الآخر، وشركةٌ أخرى لا تتأثّر', () => {
  assert.equal(anyConverting('t1', ['p1']), false);
  markConverting('t1', 'p1');
  markConverting('t1', 'p1');
  assert.equal(anyConverting('t1', ['p9', 'p1']), true);
  assert.equal(anyConverting('t2', ['p1']), false, 'العزل بين الشركات');
  assert.equal(anyConverting('t1', []), false);
  unmarkConverting('t1', 'p1');
  assert.equal(anyConverting('t1', new Set(['p1'])), true, 'ما زال تحويلٌ قائماً');
  unmarkConverting('t1', 'p1');
  assert.equal(anyConverting('t1', ['p1']), false);
  unmarkConverting('t1', 'p1');
  assert.equal(anyConverting('t1', ['p1']), false, 'نزعٌ زائد لا يترك سالباً');
  markConverting('t1', 'p1');
  assert.equal(anyConverting('t1', ['p1']), true);
  unmarkConverting('t1', 'p1');
});
