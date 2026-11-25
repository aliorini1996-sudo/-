// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — المساعد services/customerNumber.ts فوق معاملة مزيّفة (بلا قاعدة بيانات):
//   • الترقيم يبدأ من ١ لكل شركة، والقدامى بلا رقم يُرقَّمون أوّلاً بترتيب (createdAt, id) ثم الجديد.
//   • لا يُعاد رقم: أعلى رقمٍ ممنوح فوق العدّاد يُحترم، والعدّاد يُحفظ بعد كل منح.
//   • قفل صفّ الشركة FOR NO KEY UPDATE قبل أي استعلامٍ آخر، وكل الاستعلامات $queryRaw (لا $executeRaw).
//   • شركةٌ بلا صفّ (أو بديلٌ مزيّف) ⇒ يُنشأ العميل بلا رقم، وnumber في الجسم يُهمل دائماً.
//   • المسح آمنٌ للتكرار، وفشل شركةٍ لا يوقف البقيّة.
//   • قاعدة نصّ البحث (customerNumberQuery) وأشكال OR الجاهزة.
// وحرّاسٌ ثابتة على المخطط وindex.ts وأعمدة المزامنة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
// لا اتصال بقاعدة: المسح يأخذ db صريحاً في كل اختبار
stub('config/database', { default: {} });

/* eslint-disable @typescript-eslint/no-var-requires */
const cn = require('../services/customerNumber') as typeof import('../services/customerNumber');
/* eslint-enable @typescript-eslint/no-var-requires */

// ═══ العُدّة: قاعدة صغيرة في الذاكرة يفهم بديلها نصوص الاستعلامات الخام ═══

type Row = { id: string; tenantId: string; createdAt: Date; number: number | null; [k: string]: unknown };
type Stmt = { kind: string; sql: string; values: unknown[] };

/**
 * deletedMidLegacy: معرّفاتٌ تحذفها معاملةٌ أخرى بينما ينتظر UPDATE ترقيم القدامى قفلها — في READ COMMITTED تبقى في لقطة
 * ROW_NUMBER (فتأخذ رتبتها) ويتخطّاها UPDATE فلا تُعاد ولا تبقى (DELETE /customers/:id يمسك FOR UPDATE على صفّ العميل).
 */
function world(init: { tenants: Record<string, number>; customers?: Row[]; failLockFor?: string; deletedMidLegacy?: string[] }) {
  const seq = new Map(Object.entries(init.tenants));
  const customers: Row[] = [...(init.customers ?? [])];
  const log: Stmt[] = [];
  let creates = 0;
  const classify = (sql: string): string =>
    /FOR NO KEY UPDATE/.test(sql) ? 'lock'
      : /GREATEST/.test(sql) ? 'base'
        : /^UPDATE "customers"/.test(sql) ? 'legacy'
          : /^UPDATE "tenants"/.test(sql) ? 'persist'
            : /EXISTS/.test(sql) ? 'pending'
              : 'unknown';
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const kind = classify(sql);
      log.push({ kind, sql, values });
      switch (kind) {
        case 'lock': {
          const tid = values[0] as string;
          if (tid === init.failLockFor) throw new Error('lock timeout');
          return seq.has(tid) ? [{ '?column?': 1 }] : [];
        }
        case 'base': {
          const tid = values[0] as string;
          if (!seq.has(tid)) return [];
          const max = customers.filter(c => c.tenantId === tid && c.number != null).reduce((m, c) => Math.max(m, c.number as number), 0);
          return [{ base: Math.max(seq.get(tid) as number, max) }];
        }
        case 'legacy': {
          const [base, tid] = values as [number, string];
          const todo = customers
            .filter(c => c.tenantId === tid && c.number == null)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const gone = new Set(init.deletedMidLegacy ?? []);
          todo.forEach((c, i) => { if (!gone.has(c.id)) c.number = base + i + 1; });
          for (let i = customers.length - 1; i >= 0; i--) if (gone.has(customers[i].id)) customers.splice(i, 1);
          return todo.filter(c => !gone.has(c.id)).map(c => ({ id: c.id, number: c.number }));
        }
        case 'persist': {
          const [n, tid] = values as [number, string];
          if (seq.has(tid)) seq.set(tid, n);
          return seq.has(tid) ? [{ customerSeq: n }] : [];
        }
        case 'pending':
          return [...seq.keys()].filter(t => customers.some(c => c.tenantId === t && c.number == null)).map(tenantId => ({ tenantId }));
        default:
          throw new Error(`استعلامٌ غير متوقّع: ${sql}`);
      }
    },
    $executeRaw: async () => { throw new Error('$executeRaw ممنوع — البدائل المزيّفة لا تعرفه'); },
    customer: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        log.push({ kind: 'create', sql: '', values: [data] });
        creates++;
        const row = { id: `new-${creates}`, createdAt: new Date(Date.UTC(2026, 10, 23, 0, 0, creates)), number: null, ...data } as Row;
        customers.push(row);
        return row;
      },
    },
  };
  const db = {
    $queryRaw: tx.$queryRaw,
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>, opts?: unknown) => { log.push({ kind: 'tx', sql: '', values: [opts] }); return fn(tx); },
  };
  return { tx: tx as never, db: db as never, seq, customers, log, kinds: () => log.map(s => s.kind) };
}

const at = (day: number, id: string, tenantId = 'T1', number: number | null = null): Row =>
  ({ id, tenantId, createdAt: new Date(Date.UTC(2026, 0, day)), number });

// ═══ الإنشاء والحجز ═══

test('أوّل عميل لشركةٍ جديدة رقمه ١، والتالي ٢، والعدّاد يُحفظ بعد كل منح', async () => {
  const w = world({ tenants: { T1: 0 } });
  const a = await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'T1', name: 'أ', phone: '' });
  assert.equal(a.number, 1);
  assert.equal(w.seq.get('T1'), 1);
  const b = await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'T1', name: 'ب', phone: '' });
  assert.equal(b.number, 2);
  assert.equal(w.seq.get('T1'), 2);
});

test('القفل FOR NO KEY UPDATE على صفّ الشركة أوّلاً، ثم الأساس فالقدامى فالعدّاد فالإدراج — وكلها $queryRaw', async () => {
  const w = world({ tenants: { T1: 0 } });
  await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'T1', name: 'أ', phone: '' });
  assert.deepEqual(w.kinds(), ['lock', 'base', 'legacy', 'persist', 'create']);
  const lock = w.log[0];
  assert.match(lock.sql, /^SELECT 1 FROM "tenants" WHERE "id" = \? FOR NO KEY UPDATE$/);
  assert.deepEqual(lock.values, ['T1']);
  // الترقيم والعدّاد بـSQL خام لا يلمس updatedAt (فلا يُعاد دفع العملاء للمزامنة)
  for (const s of w.log.filter(x => x.kind === 'legacy' || x.kind === 'persist')) assert.doesNotMatch(s.sql, /updatedAt/);
  assert.match(w.log[2].sql, /ORDER BY "createdAt", "id"/);
});

test('القدامى بلا رقم يُرقَّمون أوّلاً بترتيب (createdAt, id) ثم الجديد بعدهم', async () => {
  const w = world({
    tenants: { T1: 0, T2: 0 },
    customers: [at(5, 'c-late'), at(1, 'c-b'), at(1, 'c-a'), at(3, 'c-mid'), at(2, 'x-other', 'T2')],
  });
  const created = await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'T1', name: 'جديد', phone: '' });
  const num = (id: string) => w.customers.find(c => c.id === id)?.number;
  assert.deepEqual(['c-a', 'c-b', 'c-mid', 'c-late'].map(num), [1, 2, 3, 4]);
  assert.equal(created.number, 5);
  assert.equal(w.seq.get('T1'), 5);
  // شركةٌ أخرى لا تُمسّ ولا تتأثر أرقامها
  assert.equal(num('x-other'), null);
  assert.equal(w.seq.get('T2'), 0);
});

test('لا يُعاد رقم: أعلى رقمٍ ممنوح فوق العدّاد يُحترم، والعدّاد فوق الأرقام (عميلٌ محذوف) يُحترم كذلك', async () => {
  const w = world({ tenants: { T1: 3, T2: 9 }, customers: [at(1, 'c1', 'T1', 7), at(1, 'd1', 'T2', 2)] });
  const a = await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'T1', name: 'أ', phone: '' });
  assert.equal(a.number, 8, 'MAX(number)=7 فوق العدّاد 3');
  assert.equal(w.seq.get('T1'), 8);
  const b = await cn.createNumberedCustomer(w.tx, 'T2', { tenantId: 'T2', name: 'ب', phone: '' });
  assert.equal(b.number, 10, 'العدّاد 9 (حُذف ما بين ٣ و٩) فوق MAX(number)=2 — فجوةٌ لا إعادة');
});

test('حذفٌ متزامن أثناء ترقيم القدامى: الجديد بعد أعلى رقمٍ مُعادٍ لا بعد base+عددهم — فجوةٌ لا تكرار', async () => {
  // base=10 والقدامى A,B,C؛ B يُحذف وUPDATE ينتظره ⇒ A=11 وC=13 (k=2) — الجديد ١٤ لا ١٣ (كان سيكرّر رقم C)
  const w = world({ tenants: { T1: 10 }, customers: [at(1, 'A'), at(2, 'B'), at(3, 'C')], deletedMidLegacy: ['B'] });
  const created = await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'T1', name: 'جديد', phone: '' });
  assert.deepEqual(w.customers.map(c => [c.id, c.number]), [['A', 11], ['C', 13], ['new-1', 14]]);
  assert.equal(created.number, 14);
  assert.equal(w.seq.get('T1'), 14);
  const nums = w.customers.map(c => c.number);
  assert.equal(new Set(nums).size, nums.length, 'لا رقم مكرّر');
  // الكتلة كذلك تبدأ بعد أعلى رقمٍ مُعادٍ
  const w2 = world({ tenants: { T1: 0 }, customers: [at(1, 'A'), at(2, 'B'), at(3, 'C')], deletedMidLegacy: ['A', 'B'] });
  assert.deepEqual(await cn.reserveCustomerNumbers(w2.tx, 'T1', 2), [4, 5]);
  assert.equal(w2.seq.get('T1'), 5);
  // والمسح يحفظ العدّاد على أعلى رقمٍ مُعادٍ (١٣) لا base+عددهم (١٢)
  const w3 = world({ tenants: { T1: 10 }, customers: [at(1, 'A'), at(2, 'B'), at(3, 'C')], deletedMidLegacy: ['B'] });
  assert.equal(await cn.numberUnnumberedCustomers(w3.tx, 'T1'), 2);
  assert.equal(w3.seq.get('T1'), 13);
  // ترقيم القدامى يُعيد الرقم مع المعرّف
  assert.match(w3.log.find(s => s.kind === 'legacy')!.sql, /RETURNING c\."id", c\."number"$/);
});

test('بديلٌ يُعيد المعرّف وحده من ترقيم القدامى (بلا number) ⇒ base+عددهم كما كان', async () => {
  const log: string[] = [];
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (/FOR NO KEY UPDATE/.test(sql)) { log.push('lock'); return [{}]; }
      if (/GREATEST/.test(sql)) { log.push('base'); return [{ base: 4 }]; }
      if (/^UPDATE "customers"/.test(sql)) { log.push('legacy'); return [{ id: 'a' }, { id: 'b' }]; }
      if (/^UPDATE "tenants"/.test(sql)) { log.push(`persist:${values[0]}`); return [{}]; }
      throw new Error(sql);
    },
  };
  assert.deepEqual(await cn.reserveCustomerNumbers(tx as never, 'T1', 1), [7]);
  assert.deepEqual(log, ['lock', 'base', 'legacy', 'persist:7']);
});

test('حجز ٣ يُعيد كتلةً متتالية بعد القدامى، ويحفظ العدّاد على آخرها', async () => {
  const w = world({ tenants: { T1: 4 }, customers: [at(1, 'old')] });
  assert.deepEqual(await cn.reserveCustomerNumbers(w.tx, 'T1', 3), [6, 7, 8]);
  assert.equal(w.customers[0].number, 5);
  assert.equal(w.seq.get('T1'), 8);
});

test('حجز صفر (أو سالب) يرقّم القدامى ويحفظ العدّاد ويُعيد [] — وبلا قدامى لا يكتب شيئاً', async () => {
  const w = world({ tenants: { T1: 0 }, customers: [at(2, 'b'), at(1, 'a')] });
  assert.deepEqual(await cn.reserveCustomerNumbers(w.tx, 'T1', 0), []);
  assert.deepEqual(w.customers.map(c => c.number), [2, 1]);
  assert.equal(w.seq.get('T1'), 2);
  const w2 = world({ tenants: { T1: 6 } });
  assert.deepEqual(await cn.reserveCustomerNumbers(w2.tx, 'T1', -2), []);
  assert.deepEqual(w2.kinds(), ['lock', 'base', 'legacy']);
  assert.equal(w2.seq.get('T1'), 6);
});

test('شركةٌ بلا صفّ (أو بديلٌ مزيّف يُعيد []) ⇒ لا رقم، ويُنشأ العميل بلا number', async () => {
  const w = world({ tenants: {} });
  assert.deepEqual(await cn.reserveCustomerNumbers(w.tx, 'GHOST', 2), []);
  const c = await cn.createNumberedCustomer(w.tx, 'GHOST', { tenantId: 'GHOST', name: 'أ', phone: '' });
  assert.equal(c.number, null);
  const data = w.log.filter(s => s.kind === 'create').map(s => s.values[0] as Record<string, unknown>);
  assert.equal(data.length, 1);
  assert.ok(!('number' in data[0]), 'لا مفتاح number في بيانات الإنشاء');
  // بديل الاختبارات القائمة: $queryRaw يُعيد [] دائماً
  const created: unknown[] = [];
  const fake = { $queryRaw: async () => [], customer: { create: async (a: { data: unknown }) => { created.push(a.data); return { id: 'x', ...(a.data as object) }; } } };
  await cn.createNumberedCustomer(fake as never, 'T1', { tenantId: 'T1', name: 'ب', phone: '', number: 77 } as never);
  assert.deepEqual(created, [{ tenantId: 'T1', name: 'ب', phone: '' }]);
});

test('number في جسم الإنشاء يُهمل دائماً (يُستبدل برقم الخادم)، وtenantId يُفرض من المعامل', async () => {
  const w = world({ tenants: { T1: 0 } });
  const c = await cn.createNumberedCustomer(w.tx, 'T1', { tenantId: 'EVIL', name: 'أ', phone: '', number: 999 } as never);
  assert.equal(c.number, 1);
  assert.equal(c.tenantId, 'T1');
});

test('الدفعة: حجزٌ واحد لكتلة متتالية ثم إدراجٌ متسلسل بترتيب المُدخَل', async () => {
  const w = world({ tenants: { T1: 10 }, customers: [at(1, 'old')] });
  const rows = await cn.createNumberedCustomers(w.tx, 'T1', [
    { tenantId: 'T1', name: 'أ', phone: '' },
    { tenantId: 'T1', name: 'ب', phone: '', number: 1 } as never,
    { tenantId: 'T1', name: 'ج', phone: '' },
  ]);
  assert.deepEqual(rows.map(r => [r.name, r.number]), [['أ', 12], ['ب', 13], ['ج', 14]]);
  assert.equal(w.customers.find(c => c.id === 'old')?.number, 11);
  assert.equal(w.seq.get('T1'), 14);
  assert.equal(w.kinds().filter(k => k === 'lock').length, 1, 'قفلٌ واحد للدفعة');
  // الدفعة الفارغة لا تلمس القاعدة
  const w2 = world({ tenants: { T1: 0 } });
  assert.deepEqual(await cn.createNumberedCustomers(w2.tx, 'T1', []), []);
  assert.deepEqual(w2.kinds(), []);
});

test('معرّف شركة فارغ أو غير نصّ ⇒ RangeError قبل أي استعلام', async () => {
  const w = world({ tenants: { T1: 0 } });
  await assert.rejects(cn.createNumberedCustomer(w.tx, '', { tenantId: '', name: 'أ', phone: '' }), RangeError);
  await assert.rejects(cn.reserveCustomerNumbers(w.tx, undefined as never, 1), RangeError);
  await assert.rejects(cn.numberUnnumberedCustomers(w.tx, '  '), RangeError);
  assert.deepEqual(w.kinds(), []);
});

test('numberUnnumberedCustomers: يرقّم القدامى ويُعيد عددهم، والثانية ٠ بلا كتابة للعدّاد', async () => {
  const w = world({ tenants: { T1: 2 }, customers: [at(3, 'b'), at(2, 'a'), at(1, 'n', 'T1', 2)] });
  assert.equal(await cn.numberUnnumberedCustomers(w.tx, 'T1'), 2);
  assert.deepEqual(w.customers.map(c => c.number), [4, 3, 2]);
  assert.equal(w.seq.get('T1'), 4);
  const before = w.log.length;
  assert.equal(await cn.numberUnnumberedCustomers(w.tx, 'T1'), 0);
  assert.deepEqual(w.log.slice(before).map(s => s.kind), ['lock', 'base', 'legacy']);
});

// ═══ المسح ═══

test('المسح: معاملةٌ قصيرة لكل شركة بمهلتها، آمنٌ للتكرار', async () => {
  const w = world({ tenants: { T1: 0, T2: 5, T3: 0 }, customers: [at(2, 'a2'), at(1, 'a1'), at(1, 'b1', 'T2'), at(1, 'c1', 'T3', 1)] });
  assert.deepEqual(await cn.sweepCustomerNumbers(w.db), { tenants: 2, numbered: 3 });
  assert.deepEqual(w.customers.map(c => c.number), [2, 1, 6, 1]);
  assert.deepEqual([w.seq.get('T1'), w.seq.get('T2'), w.seq.get('T3')], [2, 6, 0]);
  const txs = w.log.filter(s => s.kind === 'tx');
  assert.equal(txs.length, 2, 'الشركة المرقَّمة كلها لا تُفتح لها معاملة');
  assert.deepEqual(txs[0].values[0], { maxWait: 10_000, timeout: 60_000 });
  assert.match(w.log[0].sql, /LIMIT 500/);
  assert.deepEqual(await cn.sweepCustomerNumbers(w.db), { tenants: 0, numbered: 0 });
});

test('المسح: فشل شركةٍ يُسجَّل ولا يوقف البقيّة', async () => {
  const w = world({ tenants: { T1: 0, BAD: 0, T3: 0 }, customers: [at(1, 'a', 'T1'), at(1, 'x', 'BAD'), at(1, 'c', 'T3')], failLockFor: 'BAD' });
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    assert.deepEqual(await cn.sweepCustomerNumbers(w.db), { tenants: 2, numbered: 2 });
  } finally { console.error = orig; }
  assert.deepEqual(w.customers.map(c => c.number), [1, null, 1]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], '[customer-number] sweep tenant');
  assert.equal(errors[0][1], 'BAD');
});

test('حلقة المسح: تُطفأ بـCUSTOMER_NUMBER_SWEEP_ENABLED=false، وإلا ٢٠ ثانية ثم كل ١٠ دقائق بمؤقّتين لا يُبقيان العملية', () => {
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  const prev = process.env.CUSTOMER_NUMBER_SWEEP_ENABLED;
  const seen: Array<[string, number]> = [];
  let unrefs = 0;
  const timer = () => ({ unref: () => { unrefs++; } });
  (global as { setTimeout: unknown }).setTimeout = (_f: unknown, ms: number) => { seen.push(['timeout', ms]); return timer(); };
  (global as { setInterval: unknown }).setInterval = (_f: unknown, ms: number) => { seen.push(['interval', ms]); return timer(); };
  try {
    process.env.CUSTOMER_NUMBER_SWEEP_ENABLED = ' FALSE ';
    cn.startCustomerNumberSweep();
    assert.deepEqual(seen, []);
    delete process.env.CUSTOMER_NUMBER_SWEEP_ENABLED;
    cn.startCustomerNumberSweep();
    assert.deepEqual(seen, [['timeout', 20_000], ['interval', 600_000]]);
    assert.equal(unrefs, 2);
  } finally {
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
    if (prev === undefined) delete process.env.CUSTOMER_NUMBER_SWEEP_ENABLED; else process.env.CUSTOMER_NUMBER_SWEEP_ENABLED = prev;
  }
});

// ═══ نصّ البحث ═══

test('customerNumberQuery: يُقصّ وتُنزع # وتُوحَّد الأرقام، بلا صفرٍ بادئ (إلا حشواً بعد #) ولا تجاوزٍ لـint4، وغير النصّ null', () => {
  const cases: Array<[unknown, number | null]> = [
    ['12', 12], [' #12 ', 12], ['# ١٢', 12], ['۱۲', 12], ['＃7', 7], ['#  ٣٤٥', 345], ['2147483647', 2147483647],
    ['05', null], ['0', null], ['12a', null], ['99999999999', null], ['2147483648', null], [12, null], ['', null],
    ['#', null], ['##12', null], ['1 2', null], ['-3', null], ['+3', null], ['1.5', null], ['12#', null], [null, null], [undefined, null],
    // بعد # الأصفار البادئة حشوٌ يُنزع (#007 = 7)، والصفر وحده ليس رقماً؛ وبلا # يبقى «007» و«٠١٢» بادئة جوال لا رقم عميل
    ['#007', 7], ['# ٠١٢', 12], ['＃۰۰۷', 7], ['#00000000000012', 12], ['#0', null], ['#000', null], ['#0x1', null], ['#02147483648', null],
    ['007', null], ['٠١٢', null], ['00', null],
  ];
  for (const [q, want] of cases) assert.equal(cn.customerNumberQuery(q), want, JSON.stringify(q));
  assert.equal(cn.CUSTOMER_NUMBER_MAX, 2147483647);
});

test('أشكال OR الجاهزة: [] أو شرطٌ واحد على العميل نفسه أو على علاقته', () => {
  assert.deepEqual(cn.customerNumberOr('#١٢'), [{ number: 12 }]);
  assert.deepEqual(cn.customerNumberOr('0501234567'), []);
  assert.deepEqual(cn.customerNumberOr(undefined), []);
  // شرط العلاقة مقيّدٌ بالشركة دائماً (فهرس (tenantId, number) لا مسحٌ لعملاء كل الشركات)
  assert.deepEqual(cn.customerRelNumberOr(' 7 ', 'T1'), [{ customer: { tenantId: 'T1', number: 7 } }]);
  assert.deepEqual(cn.customerRelNumberOr('سمارة', 'T1'), []);
  // يُنشر في مصفوفة OR قائمة دون مسّ شروطها
  const search = '12';
  const or = [{ phone: { contains: search } }, { name: { contains: search, mode: 'insensitive' } }, ...cn.customerNumberOr(search)];
  assert.deepEqual(or.map(c => Object.keys(c)[0]), ['phone', 'name', 'number']);
});

// ═══ حرّاسٌ ثابتة ═══

const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

test('المخطط: number Int? بعد code بفهرسٍ عاديّ لا فريد، وcustomerSeq بقيمة ٠ خارج زوج aiRepEnabled/aiAccountantEnabled', () => {
  const schema = read('..', 'prisma', 'schema.prisma');
  const cust = schema.slice(schema.indexOf('model Customer {'), schema.indexOf('\n}', schema.indexOf('model Customer {')));
  const fields = cust.split('\n').filter(l => /^\s+\w+\s+\w/.test(l) && !l.trim().startsWith('//')).map(l => l.trim().split(/\s+/)[0]);
  assert.equal(fields[fields.indexOf('code') + 1], 'number');
  assert.match(cust, /\n\s+number\s+Int\?\n/);
  assert.match(cust, /@@index\(\[tenantId, number\]\)/);
  assert.doesNotMatch(cust, /@@unique\(\[tenantId, number\]\)|number\s+Int\?\s+@unique/);
  const tenant = schema.slice(schema.indexOf('model Tenant {'), schema.indexOf('\n}', schema.indexOf('model Tenant {')));
  assert.match(tenant, /\n\s+customerSeq\s+Int\s+@default\(0\)\n/);
  assert.match(tenant, /aiRepEnabled[^\n]*\n\s+aiAccountantEnabled/);
});

test('الخادم يبدأ المسح مع المجدوِلات بعد startPresenceChecks، والمزامنة تُصدر number', () => {
  const idx = read('index.ts');
  assert.match(idx, /import \{ startCustomerNumberSweep \} from '\.\/services\/customerNumber';/);
  const listen = idx.slice(idx.indexOf('server.listen(PORT'));
  assert.ok(listen.indexOf('startCustomerNumberSweep();') > listen.indexOf('startPresenceChecks();'));
  assert.ok(listen.indexOf('startPresenceChecks();') > 0);
  const sync = read('services', 'apiSync.ts');
  const cols = sync.slice(sync.indexOf('const CUSTOMER_COLS'), sync.indexOf('];', sync.indexOf('const CUSTOMER_COLS')));
  assert.match(cols, /'number'/);
  // المساعد بلا $executeRaw (البدائل المزيّفة لا تعرفه) ولا Prisma update يلمس updatedAt
  const svc = read('services', 'customerNumber.ts');
  assert.doesNotMatch(svc, /\.\$executeRaw|\.customer\.update/);
});
