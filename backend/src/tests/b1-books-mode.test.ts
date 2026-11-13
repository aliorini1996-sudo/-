// «ربط الدفاتر» L0 (وكيل B1) — وضع الدفاتر داخل المحرّك: جدول الحقيقة، وLINKED كـOPENING تماماً في التصنيف والترحيل
// (لا تُعامَل يدويةً أبداً)، ولا مقارنة حرفية بـ'CLEAN' في services/gl وroutes/ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bookMode, isLinked, isManualBooks, postsFromOperations, SETUP_METHODS, tenantBookMode, tenantBooksLinked,
} from '../services/gl/mode';
import { accountIdOf } from '../services/gl/testing/fixtures';
import { invoicePayloadFromRows } from '../services/gl/builders/invoice';
import { cutoverMethodOf, initialWatermarkAt, setupMethodOf } from '../services/gl/sync/classify';
import { invoiceKey } from '../services/gl/sync/keys';
import { createSyncBudget, cutoverContextOf, runPoster } from '../services/gl/sync/poster';
import type { PosterSettings } from '../services/gl/sync/postingStore';
import type { DesiredEvent, SourceEventPayload } from '../services/gl/sync/types';
import { FakePostingStore } from './gl-fake-posting-store';

const at = (iso: string) => new Date(iso);
const ACT = at('2027-01-15T09:00:00.000Z');

// ═══ جدول الحقيقة ═══

test('جدول الحقيقة: bookMode / isManualBooks / isLinked / postsFromOperations لكل طريقة × التفعيل', () => {
  type Row = [setupMethod: string | null | undefined, activated: boolean, mode: string, manual: boolean, linked: boolean, posts: boolean];
  const rows: Row[] = [
    // اليدوية تُحكم بالطريقة وحدها (كما كان tick.ts وtombstone.ts يقارنان بلا شرط التفعيل)
    ['CLEAN', true, 'MANUAL', true, false, false],
    ['CLEAN', false, 'MANUAL', true, false, false],
    ['LINKED', true, 'LINKED', false, true, true],
    ['LINKED', false, 'NONE', false, false, false],
    ['OPENING', true, 'LEGACY', false, false, true],
    ['OPENING', false, 'NONE', false, false, false],
    ['FULL_HISTORY', true, 'LEGACY', false, false, true],
    ['FULL_HISTORY', false, 'NONE', false, false, false],
    [null, true, 'NONE', false, false, false],
    [undefined, true, 'NONE', false, false, false],
    ['clean', true, 'NONE', false, false, false], // حساسة لحالة الأحرف: لا تساهل يجعل غير اليدوية يدوية
    ['BOGUS', true, 'NONE', false, false, false],
  ];
  for (const [setupMethod, activated, mode, manual, linked, posts] of rows) {
    const s = { setupMethod, activatedAt: activated ? ACT : null };
    const label = `${String(setupMethod)}/${activated ? 'مفعّلة' : 'غير مفعّلة'}`;
    assert.equal(bookMode(s), mode, `bookMode ${label}`);
    assert.equal(isManualBooks(s), manual, `isManualBooks ${label}`);
    assert.equal(isLinked(s), linked, `isLinked ${label}`);
    assert.equal(postsFromOperations(s), posts, `postsFromOperations ${label}`);
    // لا طريقة يدوية ومربوطة معاً، ولا يدوية تُرحِّل من التشغيل
    assert.ok(!(manual && (linked || posts)), label);
  }
  for (const s of [null, undefined]) {
    assert.equal(bookMode(s), 'NONE');
    assert.equal(isManualBooks(s), false);
    assert.equal(isLinked(s), false);
    assert.equal(postsFromOperations(s), false);
  }
  assert.deepEqual([...SETUP_METHODS].sort(), ['CLEAN', 'FULL_HISTORY', 'LINKED', 'OPENING']);
});

test('tenantBookMode / tenantBooksLinked: قراءة واحدة لـgl_settings بـ{setupMethod, activatedAt}', async () => {
  const calls: unknown[] = [];
  const db = (row: { setupMethod: string | null; activatedAt: Date | null } | null) => ({
    glSettings: { findUnique: async (args: unknown) => { calls.push(args); return row; } },
  });
  assert.equal(await tenantBookMode(db({ setupMethod: 'LINKED', activatedAt: ACT }), 't1'), 'LINKED');
  assert.equal(await tenantBooksLinked(db({ setupMethod: 'LINKED', activatedAt: ACT }), 't1'), true);
  assert.equal(await tenantBooksLinked(db({ setupMethod: 'CLEAN', activatedAt: ACT }), 't1'), false);
  assert.equal(await tenantBooksLinked(db(null), 't1'), false);
  assert.deepEqual(calls[0], { where: { tenantId: 't1' }, select: { setupMethod: true, activatedAt: true } });
});

// ═══ التحويل والتصنيف ═══

test('setupMethodOf: الطرق المعروفة تمرّ كما هي ومنها LINKED، وغيرها null (بديل سلاسل التحويل في المخزنين)', () => {
  for (const m of ['CLEAN', 'LINKED', 'OPENING', 'FULL_HISTORY']) assert.equal(setupMethodOf(m), m);
  for (const m of [null, undefined, '', 'clean', 'Linked', 'BOGUS']) assert.equal(setupMethodOf(m), null, String(m));
});

test('cutoverMethodOf: اليدوية وحدها CLEAN؛ LINKED وOPENING وغير المعروف OPENING؛ FULL_HISTORY كما هي', () => {
  assert.equal(cutoverMethodOf('CLEAN'), 'CLEAN');
  assert.equal(cutoverMethodOf('LINKED'), 'OPENING');
  assert.equal(cutoverMethodOf('OPENING'), 'OPENING');
  assert.equal(cutoverMethodOf('FULL_HISTORY'), 'FULL_HISTORY');
  assert.equal(cutoverMethodOf(null), 'OPENING');
  assert.equal(cutoverMethodOf('BOGUS'), 'OPENING');
});

test('cutoverContextOf: LINKED = OPENING حرفياً (cutover = cutoverDate، بلا cleanStart، والمؤشر الابتدائي نفسه)، وCLEAN وحدها نظيفة', () => {
  const base = { cutoverDate: '2027-01-01', openingSnapshotAt: ACT, timezone: 'Asia/Riyadh' };
  const linked = cutoverContextOf({ ...base, setupMethod: 'LINKED' });
  const opening = cutoverContextOf({ ...base, setupMethod: 'OPENING' });
  assert.deepEqual(linked, opening);
  assert.equal(linked.cleanStart, false);
  assert.equal(linked.cutoverDate, '2027-01-01');
  assert.equal(cutoverContextOf({ ...base, setupMethod: 'CLEAN' }).cleanStart, true);
  assert.equal(cutoverContextOf({ ...base, setupMethod: null }).cleanStart, false);
  // initialWatermarkAt يقبل LINKED ويعامله كالطريقة (أ): بداية اليوم السابق للبدء (لا epoch كالتاريخ الكامل)
  const wm = initialWatermarkAt({ method: 'LINKED', cutoverDate: '2027-01-01', openingSnapshotAt: ACT, timezone: 'Asia/Riyadh' });
  assert.deepEqual(wm, initialWatermarkAt({ method: 'OPENING', cutoverDate: '2027-01-01', openingSnapshotAt: ACT, timezone: 'Asia/Riyadh' }));
  assert.ok(wm.getTime() > 0);
});

// ═══ الترحيل: LINKED يرحّل كـOPENING تماماً، والفرق عن CLEAN ظاهر ═══

function invoiceEvent(id: string, entryDate: string, createdAt: string, total = 115): DesiredEvent {
  const net = +(total / 1.15).toFixed(2);
  const tax = +(total - net).toFixed(2);
  const payload = invoicePayloadFromRows({
    invoice: { id, number: `INV-${id}`, type: 'CREDIT', customerId: 'c1', salesRepId: null, pricesIncludeTax: false, subtotal: net, discountAmt: 0, taxAmt: tax, total },
    items: [{ qty: 1, unitPrice: net, taxPct: 15, taxAmt: tax, lineTotal: total }],
    customerName: 'عميل أول', entryDate, currency: 'SAR', currencyDecimals: 2,
  });
  return {
    sourceKey: invoiceKey(id, 'POST'), sourceType: 'INVOICE', sourceId: id, event: 'POST', effectAt: at(`${entryDate}T08:00:00.000Z`),
    payload: { ...payload, sourceCreatedAt: createdAt } as SourceEventPayload,
  };
}

/** ثلاث فواتير حول البدء (2027-01-01) ولحظة T0 (2027-01-15 09:00): مشمولة بالافتتاح، ومؤرخة بعد البدء قبل T0، ووصول متأخر */
const EVENTS = (): DesiredEvent[] => [
  invoiceEvent('pre', '2026-12-20', '2026-12-20T08:00:00.000Z', 230), // قبل البدء وقبل T0 ⇒ مشمولة بالافتتاح
  invoiceEvent('mid', '2027-01-10', '2027-01-10T08:00:00.000Z', 115), // بعد البدء وقبل T0 ⇒ OPENING يرحّلها، CLEAN يتخطّاها
  invoiceEvent('late', '2026-12-28', '2027-02-01T08:00:00.000Z', 57.5), // قبل البدء وأُنشئت بعد T0 ⇒ وصول متأخر بتاريخ البدء
];

async function postAll(setupMethod: PosterSettings['setupMethod']) {
  const s = new FakePostingStore({
    now: () => at('2027-03-01T10:00:00.000Z').getTime(),
    settings: { setupMethod, cutoverDate: '2027-01-01', openingSnapshotAt: ACT, activatedAt: ACT },
  });
  s.seedEvents(EVENTS());
  const r = await runPoster(s, s.settings, createSyncBudget({ timeMs: 60_000, events: 100 }), { log: () => undefined });
  const moves = s.moves().map((m) => ({ src: m.sourceId, date: m.date, late: m.lateArrival, originalDate: m.originalDate, lines: m.lines.map((l) => [l.accountId, l.debitMilli, l.creditMilli, l.customerId]) }))
    .sort((a, b) => String(a.src).localeCompare(String(b.src)));
  const statuses = Object.fromEntries(['pre', 'mid', 'late'].map((id) => {
    const e = s.event(invoiceKey(id, 'POST'))!;
    return [id, `${e.status}${e.skipReason ? `(${e.skipReason})` : ''}`];
  }));
  return { r, moves, statuses, ar: s.balance(accountIdOf('113001'), 'c1') };
}

test('LINKED يرحّل بالضبط ما يرحّله OPENING (القيود والتواريخ والوصول المتأخر والحالات) — ولا يتصرّف كـCLEAN', async () => {
  const opening = await postAll('OPENING');
  const linked = await postAll('LINKED');
  const clean = await postAll('CLEAN');
  assert.deepEqual(linked.moves, opening.moves);
  assert.deepEqual(linked.statuses, opening.statuses);
  assert.equal(linked.ar, opening.ar);
  // OPENING/LINKED: المشمولة بالافتتاح تُتخطّى، والمؤرخة بعد البدء تُرحَّل بتاريخها، والمتأخرة بتاريخ البدء مع أصلها
  assert.deepEqual(linked.statuses, { pre: 'SKIPPED(OPENING)', mid: 'DONE', late: 'DONE' });
  assert.deepEqual(linked.moves.map((m) => [m.src, m.date, m.late, m.originalDate]), [
    ['late', '2027-01-01', true, '2026-12-28'],
    ['mid', '2027-01-10', false, null],
  ]);
  assert.equal(linked.ar, 172_500n, '115 + 57.5 على ذمة العميل');
  // البداية النظيفة تتخطّى ما أُنشئ قبل T0 ولو كان بعد البدء — فـLINKED ليست CLEAN
  assert.equal(clean.statuses.mid, 'SKIPPED(OPENING)');
  assert.notDeepEqual(linked.moves, clean.moves);
});

// ═══ لا مقارنة حرفية بـ'CLEAN' ═══

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('حارس ثابت: لا مقارنة حرفية بـCLEAN ولا LINKED في services/gl وroutes/ledger (عدا mode.ts) — isManualBooks/isLinked/bookMode', () => {
  const root = path.join(__dirname, '..');
  const files = [...walk(path.join(root, 'services', 'gl')), ...walk(path.join(root, 'routes', 'ledger'))]
    .filter((f) => path.basename(f) !== 'mode.ts');
  const hits: string[] = [];
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    s.split('\n').forEach((l, i) => {
      if (/[!=]==?\s*'(CLEAN|LINKED)'|'(CLEAN|LINKED)'\s*[!=]==?/.test(l)) hits.push(`${path.relative(root, f)}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
  // دوال التحويل القديمة استُبدلت بـsetupMethodOf (لا سلاسل تُسقط LINKED إلى null)
  const ps = fs.readFileSync(path.join(root, 'services', 'gl', 'sync', 'postingStore.prisma.ts'), 'utf8');
  const cs = fs.readFileSync(path.join(root, 'services', 'gl', 'checks', 'store.prisma.ts'), 'utf8');
  assert.match(ps, /setupMethod: setupMethodOf\(row\.setupMethod\),/);
  assert.match(cs, /setupMethod: setupMethodOf\(s\.setupMethod\),/);
  // التفعيل القسري بالبداية النظيفة باقٍ حتى L7 (مسار تفعيل LINKED)
  const setup = fs.readFileSync(path.join(root, 'routes', 'ledger', 'setup.ts'), 'utf8');
  assert.match(setup.slice(setup.indexOf('function effectiveSetup('), setup.indexOf('function assertFiscalYearEnd(')), /method: 'CLEAN',/);
});
