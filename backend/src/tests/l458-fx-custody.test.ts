// «ربط الدفاتر» L5 — إصلاحات مراجعة ١٤ نوفمبر لعهدة مستخدم الشركة (OD5 وD6):
//
// (١) OD5 والتاريخ القديم: سقف التوريد قبل OD5 كان «المستلَم كله − المورَّد كله» وحوار الاستلام CASH افتراضاً، فتاريخٌ حقيقيّ فيه
//     «استلم 1000 تحويلاً ثم ورّدها نقداً». كان الطيّ يجعل التوريد النقدي pass=0 دائماً ⇒ عهدة −1000 دائمة: لا توريد نقدي بعدها،
//     ولا حذف لاستلامه، ولا لحسابه — في كل الشركات. الآن زائد التوريد النقدي عن العهدة النقدية لحظتَه يمرّ من الوعاء.
// (٢) D6 مصدرٌ واحد: الشاشة ومحمّل الدفاتر يقرآن الصفوف نفسها (readUserCustodyOpsRows) ويحوّلانها بالدالة نفسها، ومنازل العملة
//     نفسها في المربوطة، ولحظة الردّ نفسها. وقرارٌ واحد لاستلام المندوب المحذوف: يُقرأ في الطرفين — اليد تعدّه نقداً، والدفاتر
//     تسمه outsideCustody (سنداته OUTSIDE في 111001) فيمرّ توريد ماله بلا قيد: لا 111004 سالب ولا 111001 مرّتين.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  cashExcessPassMilli, foldUserCustody, receivedRemovalKeepsCustodySane, userDeliverySplitBefore, userHandoverCapMilli,
  type UserCustodyInputs, type UserCustodyReceivedRow, type UserCustodyDeliveredRow,
} from '../services/userCustodyCore';
import {
  CUSTODY_EPS, handoverAllowedFor, readUserCustodyOpsRows, userCustody, userCustodyFold, userCustodyInputs, userCustodyInputsFromRows,
  userCustodyMany,
} from '../services/userCustody';
import { loadUserCustodyInputsMany } from '../services/gl/sync/postingStore.prisma';

const T0 = Date.parse('2026-09-01T08:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const iso = (min: number) => at(min).toISOString();
const m = (sar: number) => BigInt(Math.round(sar * 1000));
const R = (id: string, sar: number, method: string, min: number, extra: Partial<UserCustodyReceivedRow> = {}): UserCustodyReceivedRow =>
  ({ id, amountMilli: m(sar), method, at: iso(min), createdAt: iso(min), ...extra });
const D = (id: string, sar: number, method: string, min: number): UserCustodyDeliveredRow =>
  ({ id, amountMilli: m(sar), method, at: iso(min), createdAt: iso(min) });
const inputs = (received: UserCustodyReceivedRow[], delivered: UserCustodyDeliveredRow[] = []): UserCustodyInputs =>
  ({ userId: 'U', received, delivered, refunds: [] });

// ═══ (١) OD5 والتاريخ القديم ═══

test('cashExcessPassMilli: ضمن العهدة صفر، وما زاد يمرّ من الوعاء الموجب وحده', () => {
  assert.equal(cashExcessPassMilli(m(300), m(500), m(1000)), 0n, 'ضمن العهدة');
  assert.equal(cashExcessPassMilli(m(1000), 0n, m(1000)), m(1000), 'كله من الوعاء');
  assert.equal(cashExcessPassMilli(m(1000), m(400), m(1000)), m(600));
  assert.equal(cashExcessPassMilli(m(1000), -m(200), m(1000)), m(1000), 'العهدة السالبة لا تزيد المرور عن المبلغ');
  assert.equal(cashExcessPassMilli(m(1000), 0n, m(300)), m(300), 'الوعاء حدٌّ أعلى');
  assert.equal(cashExcessPassMilli(m(1000), 0n, -m(300)), 0n, 'الوعاء السالب لا يُمرّر');
});

test('المراجعة: استلم 1000 تحويلاً ثم ورّدها نقداً (الحوار افتراضاً CASH) ⇒ العهدة صفر لا −1000؛ ثم نقد 500 ⇒ 500 كالشاشة القديمة', () => {
  const x = inputs([R('rb', 1000, 'BANK_TRANSFER', 0)], [D('d', 1000, 'CASH', 5)]);
  let f = foldUserCustody(x);
  assert.deepEqual([f.outstandingMilli, f.nonCashPoolMilli, f.passThroughMilli], [0n, 0n, m(1000)]);
  assert.deepEqual(userDeliverySplitBefore(x, 'd'), { passThroughMilli: m(1000), custodyMilli: 0n });
  x.received.push(R('rc', 500, 'CASH', 10));
  f = foldUserCustody(x);
  // الشاشة القديمة: (1000 + 500) − 1000 = 500 — والجديدة 500 نقداً بلا وعاء متبقٍّ
  assert.deepEqual([f.outstandingMilli, f.nonCashPoolMilli], [m(500), 0n]);
  assert.equal(userHandoverCapMilli(f, 'CASH'), m(500), 'يورِّد ما في يده نقداً');
  assert.equal(handoverAllowedFor(f, 'CASH', 500), true, 'كان CustodyExceeded بسقفٍ سالب');
  // حذف الاستلام النقدي (500) مقبول: كان «احذف توريده أولاً» بلا سبب (العهدة بعده كانت −1000)
  assert.equal(receivedRemovalKeepsCustodySane(x, 'rc', 5n), true);
  assert.ok(foldUserCustody({ ...x, received: x.received.filter((r) => r.id !== 'rc') }).outstandingMilli >= -5n, 'حارس غير المربوطة');
});

test('المراجعة (المسار): userCustody وuserCustodyMany عبر القاعدة المزيّفة — 500 لا −500، والسقف النقدي 500', async () => {
  const db = fakeDb({
    rec: [rec('rb', 1000, 'BANK_TRANSFER', 0), rec('rc', 500, 'CASH', 10)],
    del: [del('d', 1000, 'CASH', 5)],
  });
  assert.deepEqual(await userCustody(db, 't1', 'u1'), { received: 500, delivered: 0, outstanding: 500, nonCashReceived: 1000, passThrough: 1000 });
  assert.equal((await userCustodyMany(db, 't1')).get('u1')!.outstanding, 500);
  assert.equal(handoverAllowedFor(await userCustodyFold(db, 't1', 'u1'), 'CASH', 500), true);
});

/** مولّد حتمي (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('التاريخ القديم بسقفه القديم (300 سيناريو): لا سالب أبداً، والعهدة + الوعاء = «المستلَم − المورَّد» القديم بالضبط', () => {
  const methods = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'POS'];
  for (let s = 1; s <= 300; s++) {
    const r = rng(s);
    const x = inputs([]);
    let receivedAll = 0n;
    let deliveredAll = 0n;
    for (let k = 0, min = 0; k < 30; k++) {
      min += 1 + Math.floor(r() * 3);
      const method = methods[Math.floor(r() * methods.length)];
      if (r() < 0.5) {
        const amt = m(Math.floor(r() * 100_000) / 100);
        x.received.push({ ...R(`r${k}`, 0, method, min), amountMilli: amt });
        receivedAll += amt;
      } else {
        // السقف القديم (قبل OD5): بلا نظرٍ إلى الطريقة
        const cap = receivedAll - deliveredAll;
        if (cap <= 0n) continue;
        const amt = BigInt(Math.floor(r() * Number(cap))) + 1n;
        x.delivered.push({ ...D(`d${k}`, 0, method, min), amountMilli: amt });
        deliveredAll += amt;
      }
      const f = foldUserCustody(x);
      assert.ok(f.outstandingMilli >= 0n, `سيناريو ${s}: عهدة سالبة ${f.outstandingMilli}`);
      assert.ok(f.nonCashPoolMilli >= 0n, `سيناريو ${s}: وعاء سالب ${f.nonCashPoolMilli}`);
      assert.equal(f.outstandingMilli + f.nonCashPoolMilli, receivedAll - deliveredAll, `سيناريو ${s}: العهدة + الوعاء ≠ القديم`);
    }
  }
});

test('الجديد لا يبلغ فرع المرور النقدي: توريدٌ نقدي ضمن سقف OD5 (العهدة وحدها) مروره صفر دائماً', () => {
  const methods = ['CASH', 'CHEQUE', 'BANK_TRANSFER', 'POS'];
  for (let s = 1; s <= 200; s++) {
    const r = rng(1000 + s);
    const x = inputs([]);
    for (let k = 0, min = 0; k < 25; k++) {
      min += 1 + Math.floor(r() * 3);
      const method = methods[Math.floor(r() * methods.length)];
      if (r() < 0.5) { x.received.push(R(`r${k}`, Math.floor(r() * 100_000) / 100, method, min)); continue; }
      const cap = userHandoverCapMilli(foldUserCustody(x), method);
      if (cap <= 0n) continue;
      x.delivered.push({ ...D(`d${k}`, 0, method, min), amountMilli: BigInt(Math.floor(r() * Number(cap))) + 1n });
    }
    const f = foldUserCustody(x);
    for (const d of f.deliveries) {
      const method = x.delivered.find((y) => y.id === d.id)!.method;
      if (method === 'CASH' || method === 'CHEQUE') assert.equal(d.passThroughMilli, 0n, `سيناريو ${s}: ${d.id}`);
    }
  }
});

// ═══ (٢) D6: المصدر الواحد وقرار المندوب المحذوف ومنازل العملة ═══

type Row = Record<string, unknown>;

function whereMatch(r: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const o = v as { in?: unknown[]; not?: unknown };
      if ('in' in o) return (o.in ?? []).includes(r[k]);
      if ('not' in o) return o.not === null ? r[k] !== null && r[k] !== undefined : r[k] !== o.not;
      return true; // مرشّحات لا تحتاجها هذه الصفوف (payload path)
    }
    return r[k] === v;
  });
}

function fakeDb(rows: { rec?: Row[]; del?: Row[]; rct?: Row[]; gl?: Row | null }) {
  const calls: string[] = [];
  const model = (name: string, list: Row[]) => ({
    groupBy: async ({ by, where }: { by: string[]; where: Row }) => {
      calls.push(`${name}.groupBy`);
      const seen = new Map<string, Row>();
      for (const r of list.filter((x) => whereMatch(x, where))) seen.set(by.map((b) => String(r[b])).join('|'), Object.fromEntries(by.map((b) => [b, r[b]])));
      return [...seen.values()];
    },
    findMany: async ({ where }: { where: Row }) => { calls.push(`${name}.findMany`); return list.filter((x) => whereMatch(x, where)); },
  });
  const db = {
    repSettlement: model('repSettlement', rows.rec ?? []),
    userSettlement: model('userSettlement', rows.del ?? []),
    receipt: model('receipt', rows.rct ?? []),
    glSourceEvent: model('glSourceEvent', []),
    ...(rows.gl !== undefined ? { glSettings: { findUnique: async () => { calls.push('glSettings.findUnique'); return rows.gl; } } } : {}),
  };
  return Object.assign(db as unknown as Parameters<typeof userCustody>[0] & Parameters<typeof loadUserCustodyInputsMany>[0], { calls });
}

const rec = (id: string, amount: number, method: string, min: number, user = 'u1', salesRepId: string | null = 'rep-1'): Row =>
  ({ id, tenantId: 't1', receivedByUserId: user, salesRepId, amount, method, settledAt: at(min), createdAt: at(min) });
const del = (id: string, amount: number, method: string, min: number, user = 'u1'): Row =>
  ({ id, tenantId: 't1', fromUserId: user, amount, method, settledAt: at(min), createdAt: at(min) });
const LINKED = { setupMethod: 'LINKED', activatedAt: new Date('2026-01-01T00:00:00Z'), currencyDecimals: 2 };

/** سعد استلم 10,000 من خالد (حُذف خالد قبل الربط: salesRepId فارغ) وورّد 4,000 نقداً — المراجعة */
const saad = (gl: Row | null | undefined) => fakeDb({
  rec: [rec('s1', 10_000, 'CASH', 0, 'saad', null)],
  del: [del('u1', 4_000, 'CASH', 60, 'saad')],
  gl,
});

test('المندوب المحذوف (المراجعة): اليد 6,000 (الشاشة والسقف)، والدفاتر 0 بلا سالب — توريد ماله مرورٌ بلا قيد على 111004 ولا 111001', async () => {
  for (const gl of [LINKED, null, undefined]) {
    const db = saad(gl);
    // اليد: ما يحمله سعد فعلاً — لكل شركة كما كان (rep-delete-keeps-settlements)
    assert.equal((await userCustody(db, 't1', 'saad')).outstanding, 6_000, JSON.stringify(gl));
    assert.equal(handoverAllowedFor(await userCustodyFold(db, 't1', 'saad'), 'CASH', 6_000), true, 'يورّد ما في يده');
  }
  // الدفاتر (المربوطة): استلام المندوب المحذوف موسومٌ خارج 111004 ⇒ التوريد مرورٌ كامل (custody 0 ⇒ NO_MOVE) والعهدة صفر
  const ledger = (await loadUserCustodyInputsMany(saad(LINKED), 't1', 2, ['saad'])).get('saad')!;
  assert.deepEqual(ledger.received.map((r) => [r.id, r.outsideCustody === true]), [['s1', true]]);
  assert.deepEqual(userDeliverySplitBefore(ledger, 'u1'), { passThroughMilli: m(4_000), custodyMilli: 0n });
  const f = foldUserCustody(ledger);
  assert.deepEqual([f.outstandingMilli, f.nonCashPoolMilli], [0n, m(6_000)], 'لا 111004 سالب: C4u = 0 = 111004');
  // وحرّاس الحذف في المربوطة ترى ما تراه الدفاتر (منظور الدفاتر)، وغير المربوطة كاليوم
  assert.deepEqual((await userCustodyInputs(saad(LINKED), 't1', 'saad')).received.map((r) => r.outsideCustody), [true]);
  assert.deepEqual((await userCustodyInputs(saad(null), 't1', 'saad')).received.map((r) => r.outsideCustody), [undefined]);
  // ردّ سندٍ ملغى من عهدته يُرحَّل دائناً على 111004 في المربوطة ⇒ يُقاس بمنظور الدفاتر (0 لا 6,000): لا 111004 سالب بالردّ
  assert.equal((await userCustody(saad(LINKED), 't1', 'saad', { ledgerView: true })).outstanding, 0);
  assert.equal((await userCustody(saad(null), 't1', 'saad', { ledgerView: true })).outstanding, 6_000, 'غير المربوطة كاليوم');
  const cancelSrc = fs.readFileSync(path.join(__dirname, '..', 'services/receiptCancelSource.ts'), 'utf8');
  assert.equal((cancelSrc.match(/userCustody\([^)]*\{ ledgerView: true \}\)/g) ?? []).length, 2, 'الاقتراح والتحقق داخل المعاملة بمنظور الدفاتر');
});

test('المصدر الواحد: مدخلات حارس المربوطة = مدخلات الدفاتر حرفاً (الصفوف والمنازل ولحظة الردّ والوسم) — بلا أحداث دفاتر', async () => {
  const rows = {
    rec: [rec('a', 100.005, 'CASH', 0), rec('b', 300, 'BANK_TRANSFER', 1), rec('c', 50, 'CASH', 2, 'u1', null)],
    del: [del('d1', 200, 'BANK_TRANSFER', 5), del('d2', 120.004, 'CASH', 6)],
    rct: [{
      id: 'rf', tenantId: 't1', status: 'CANCELLED', cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u1', amount: 10,
      createdAt: at(3), updatedAt: at(40), accountEntries: [{ entryDate: at(7) }],
    }],
  };
  const screen = await userCustodyInputs(fakeDb({ ...rows, gl: LINKED }), 't1', 'u1');
  const ledger = (await loadUserCustodyInputsMany(fakeDb({ ...rows, gl: LINKED }), 't1', 2, ['u1'])).get('u1')!;
  const strip = (x: UserCustodyInputs) => ({
    ...x,
    received: [...x.received].sort((p, q) => (p.id < q.id ? -1 : 1)),
    delivered: x.delivered.map(({ storedPassThroughMilli: _s, ...d }) => d).sort((p, q) => (p.id < q.id ? -1 : 1)),
  });
  assert.deepEqual(strip(screen), strip(ledger));
  // منازل العملة (2) لكل مستند في الطرفين: 100.005 ⇒ 100.01، و120.004 ⇒ 120.00
  assert.equal(screen.received.find((r) => r.id === 'a')!.amountMilli, 100_010n);
  assert.equal(screen.delivered.find((d) => d.id === 'd2')!.amountMilli, 120_000n);
  // لحظة الردّ من صفّ الإلغاء (لا updatedAt) في الطرفين
  assert.equal(new Date(screen.refunds[0].at).toISOString(), at(7).toISOString());
  assert.deepEqual(foldUserCustody(screen), foldUserCustody(ledger));
});

test('غير المربوطة كاليوم حرفاً: منازل 3 (الملّي نفسه)، ولا وسم، ولحظة الردّ updatedAt حين لا صفّ عكس', async () => {
  const rows = {
    rec: [rec('a', 100.005, 'CASH', 0), rec('c', 50, 'CASH', 2, 'u1', null)],
    rct: [{ id: 'rf', tenantId: 't1', status: 'CANCELLED', cancelRefundFrom: 'USER_CUSTODY', cancelRefundUserId: 'u1', amount: 10, createdAt: at(3), updatedAt: at(40) }],
  };
  for (const gl of [null, undefined, { setupMethod: 'CLEAN', activatedAt: new Date(), currencyDecimals: 2 }, { ...LINKED, activatedAt: null }]) {
    const x = await userCustodyInputs(fakeDb({ ...rows, gl }), 't1', 'u1');
    assert.equal(x.received.find((r) => r.id === 'a')!.amountMilli, 100_005n, JSON.stringify(gl));
    assert.ok(x.received.every((r) => r.outsideCustody === undefined));
    assert.equal(new Date(x.refunds[0].at).toISOString(), at(40).toISOString());
    assert.equal((await userCustody(fakeDb({ ...rows, gl }), 't1', 'u1')).outstanding, 140.005);
  }
});

test('userCustodyInputsFromRows صرفاً: wanted يرشّح، والوسم بـnull صريح وحده (لا غياب الحقل)', () => {
  const rows = {
    received: [
      { id: 'x', receivedByUserId: 'u1', salesRepId: null, amount: 1, method: 'CASH', settledAt: at(0), createdAt: at(0) },
      { id: 'y', receivedByUserId: 'u2', salesRepId: 'r', amount: 2, method: 'CASH', settledAt: at(0), createdAt: at(0) },
    ],
    delivered: [], refunds: [],
  };
  const all = userCustodyInputsFromRows(rows, { decimals: 2, ledgerView: true });
  assert.deepEqual([...all.keys()].sort(), ['u1', 'u2']);
  assert.equal(all.get('u1')!.received[0].outsideCustody, true);
  assert.equal(all.get('u2')!.received[0].outsideCustody, undefined);
  const only = userCustodyInputsFromRows(rows, { decimals: 2, ledgerView: true, wanted: (u) => u === 'u2' });
  assert.deepEqual([...only.keys()], ['u2']);
  const noRepField = userCustodyInputsFromRows({ ...rows, received: [{ ...rows.received[1], salesRepId: undefined as unknown as null }] }, { decimals: 2, ledgerView: true });
  assert.equal(noRepField.get('u2')!.received[0].outsideCustody, undefined);
});

test('حارس نصّي: محمّل الدفاتر يبني على المصدر الواحد (لا قراءة صفوف خاصة به)، والشاشة لا تستورد services/gl', () => {
  const SRC = path.join(__dirname, '..');
  const store = fs.readFileSync(path.join(SRC, 'services/gl/sync/postingStore.prisma.ts'), 'utf8');
  const body = store.slice(store.indexOf('export async function loadUserCustodyInputsMany('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fn, /readUserCustodyOpsRows\(db, tenantId, userIds\)/);
  assert.match(fn, /userCustodyInputsFromRows\(ops, \{ decimals, ledgerView: true, wanted \}\)/);
  assert.doesNotMatch(fn, /\.(repSettlement|userSettlement|receipt)\.findMany\(/, 'لا محمّلٌ ثانٍ للصفوف التشغيلية');
  const svc = fs.readFileSync(path.join(SRC, 'services/userCustody.ts'), 'utf8');
  assert.doesNotMatch(svc, /from\s+['"][^'"]*\/gl[/'"]/);
  assert.equal(CUSTODY_EPS, 0.005);
});
