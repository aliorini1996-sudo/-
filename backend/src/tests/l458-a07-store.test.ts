// «ربط الدفاتر» L5 — A7: مخزن الترحيل (عقد L4+L5+L8 §5.6).
// بلا قاعدة: الصيغة المغلقة لنافذة العهدة صرفة (linkedCustodyInputs) وتُقارَن بالطيّ الكامل على ٢٠٠ سيناريو عشوائي محكوم
// بمنازل 0 و2 و3؛ وPrismaPostingTx فوق عميلٍ مزيّف في الذاكرة يحاكي استعلامات Prisma (والـSQL الخام للنافذة بالمحاكاة نفسها):
// C17 (E5.13)، والختم وstampDrivesCustody وD4، وC11 (E5.7)، ونافذة المربوطة ≡ الطيّ الكامل، وعهدة المستخدم (D6)، وحمولة
// المربوطة بدوال A1 نفسها (مصدر واحد) وحمولة غيرها كما كانت حرفاً، وensureLinkedAccounts للمربوطة وحدها.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  custodyC4Gap, custodyC4bGap, custodyComponents, custodyComponentsForRep,
  type CustodyComponents, type CustodyComponentsInput, type CustodyItem, type CustodySettlementItem,
} from '../services/gl/custody';
import { localDate, zonedStartOfDay } from '../services/gl/dates';
import { formatMilli, toMilli, unitMilli } from '../services/gl/money';
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';
import {
  PrismaPostingStore, PrismaPostingTx, cancelRefundOutsideCustody, custodyClassOf, inCustodyWindow, linkedCustodyFactsFromSql,
  linkedCustodyInputs, linkedStoreSettingsOf, loadUserCustodyInputsMany,
  type CustodyWindow, type LinkedCustodySettlementRow, type LinkedInvoiceSqlRow, type LinkedReceiptSqlRow,
} from '../services/gl/sync/postingStore.prisma';
import { custodyInputsBefore } from '../services/gl/sync/poster';
import {
  invoicePostEventPayload, paylinkRefundPayload, receiptPostEventPayload, receiptReverseEventPayload, settlementPayload, userSettlementPayload,
} from '../services/gl/sync/desired';
import { foldUserCustody } from '../services/userCustodyCore';
import type { ReceiptRouting } from '../services/gl/types';
import type { GlDb } from '../services/gl/resolve';
import type { PrismaClient } from '@prisma/client';

const TZ = 'Asia/Riyadh';
const REP = 'rep1';
const W: CustodyWindow = { start: zonedStartOfDay('2027-01-01', TZ), snapshotAt: new Date('2027-02-01T10:00:00.000Z') };
const ROUTING = { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY' } as unknown as ReceiptRouting;
const at = (iso: string) => new Date(iso);

// ═══ (أ) الصيغة المغلقة صرفةً: النافذة + الافتتاح ≡ الطيّ الكامل ═══

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rev { at: Date; created: Date; from: string | null }
interface GReceipt { id: string; method: string; amountMilli: bigint; eff: Date; created: Date; rev: Rev | null }
interface GInvoice { id: string; stamped: boolean; amountMilli: bigint; eff: Date; created: Date; rev: Rev | null }
interface GSettlement { id: string; amountMilli: bigint; eff: Date; created: Date; del: Date | null }
interface Scenario { dec: number; cashInvoice: 'MAIN_CASH' | 'CUSTODY'; receipts: GReceipt[]; invoices: GInvoice[]; settlements: GSettlement[] }

const T_FROM = Date.parse('2026-09-01T00:00:00.000Z');
const T_TO = Date.parse('2027-03-31T00:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FROMS = [null, 'REP_CUSTODY', 'MAIN_CASH', 'USER_CUSTODY', 'BANK', 'METHOD'];

function genScenario(seed: number, dec: number): Scenario {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const t = () => new Date(T_FROM + Math.floor(r() * (T_TO - T_FROM)));
  const after = (d: Date, maxMs: number) => new Date(d.getTime() + 1 + Math.floor(r() * maxMs));
  const amt = (maxUnits: number) => BigInt(1 + Math.floor(r() * maxUnits)) * unitMilli(dec);
  const rev = (eff: Date, p: number): Rev | null => {
    if (r() >= p) return null;
    const a = after(eff, 60 * DAY);
    return { at: a, created: after(a, HOUR), from: pick(FROMS) };
  };
  const receipts: GReceipt[] = [];
  const nr = 6 + Math.floor(r() * 12);
  for (let i = 0; i < nr; i++) {
    const eff = t();
    receipts.push({ id: `rc${i}`, method: pick(['CASH', 'CASH', 'CHEQUE', 'BANK_TRANSFER', 'POS', 'ONLINE']), amountMilli: amt(200_000), eff, created: after(eff, 3 * HOUR), rev: rev(eff, 0.3) });
  }
  const invoices: GInvoice[] = [];
  const ni = Math.floor(r() * 8);
  for (let i = 0; i < ni; i++) {
    const eff = t();
    invoices.push({ id: `iv${i}`, stamped: r() < 0.5, amountMilli: amt(150_000), eff, created: after(eff, 3 * HOUR), rev: rev(eff, 0.25) });
  }
  const settlements: GSettlement[] = [];
  const ns = 2 + Math.floor(r() * 7);
  for (let i = 0; i < ns; i++) {
    const eff = t();
    settlements.push({ id: `st${i}`, amountMilli: amt(300_000), eff, created: after(eff, 3 * HOUR), del: r() < 0.2 ? after(eff, 60 * DAY) : null });
  }
  return { dec, cashInvoice: r() < 0.5 ? 'MAIN_CASH' : 'CUSTODY', receipts, invoices, settlements };
}

const routingOf = (s: Scenario) => ({ cashInvoice: s.cashInvoice, receipt: ROUTING, stampDrivesCustody: true });

type Stored = Map<string, { r: bigint; rec: bigint }>;

/** المدخلات الكاملة (كل التاريخ) — كما يطويها المحمّل غير المنوفذ للمربوطة */
function fullInputs(s: Scenario, stored: Stored, opts: { stripRev?: (kind: string, id: string) => boolean; only?: (eff: Date, created: Date) => boolean } = {}): CustodyComponentsInput {
  const keep = opts.only ?? (() => true);
  const strip = opts.stripRev ?? (() => false);
  const out: CustodyComponentsInput = {
    receipts: [], onlineReceipts: [], outsideReceipts: [], cashInvoices: [], settlements: [], shortages: [], custodyExpenses: [],
    routing: routingOf(s),
  };
  for (const x of s.receipts) {
    if (!keep(x.eff, x.created)) continue;
    const cls = custodyClassOf(x.method, REP, ROUTING, true);
    const rev = strip('R', x.id) ? null : x.rev;
    const item: CustodyItem = {
      id: x.id, salesRepId: REP, amountMilli: x.amountMilli, effectAt: x.eff, createdAt: x.created, reversedAt: rev?.at ?? null,
      ...(cls === 'CUSTODY' && rev && cancelRefundOutsideCustody(rev.from) ? { reversalOutsideCustody: true } : {}),
    };
    ((cls === 'CUSTODY' ? out.receipts : cls === 'ONLINE' ? out.onlineReceipts : out.outsideReceipts) as CustodyItem[]).push(item);
  }
  for (const x of s.invoices) {
    if (!keep(x.eff, x.created)) continue;
    const rev = strip('I', x.id) ? null : x.rev;
    (out.cashInvoices as CustodyItem[]).push({
      id: x.id, salesRepId: REP, amountMilli: x.amountMilli, effectAt: x.eff, createdAt: x.created, reversedAt: rev?.at ?? null, ...(x.stamped ? { stamped: true } : {}),
    });
  }
  for (const x of s.settlements) {
    if (!keep(x.eff, x.created)) continue;
    const st = stored.get(x.id);
    (out.settlements as CustodySettlementItem[]).push({
      id: x.id, salesRepId: REP, amountMilli: x.amountMilli, effectAt: x.eff, createdAt: x.created, reversedAt: strip('S', x.id) ? null : x.del,
      nonCustodyClearedMilli: st?.r ?? null, shortageRecoveredMilli: st?.rec ?? null,
    });
  }
  return out;
}

const inWin = (eff: Date, created: Date) => inCustodyWindow(eff, created, W);
const preWin = (eff: Date, created: Date) => !inWin(eff, created);
const delInWin = (d: Date) => inCustodyWindow(d, d, W);

/** المحاكاة الصرفة لاستعلامي SQL (linkedCustodyReceiptsSql/InvoicesSql) بالقاعدة نفسها */
function sqlRows(s: Scenario): { receiptRows: LinkedReceiptSqlRow[]; invoiceRows: LinkedInvoiceSqlRow[] } {
  const dec = s.dec;
  const num = (m: bigint) => Number(m) / 1000;
  const receiptRows: LinkedReceiptSqlRow[] = [];
  const rSums = new Map<string, { method: string; from: string | null; reversed: boolean; total: bigint }>();
  for (const x of s.receipts) {
    const iw = inWin(x.eff, x.created);
    const rw = !!x.rev && inCustodyWindow(x.rev.at, x.rev.created, W);
    if (iw || rw) {
      receiptRows.push({
        kind: 'ROW', id: x.id, method: x.method, refundFrom: x.rev?.from ?? null, amount: num(x.amountMilli), effAt: x.eff, createdAt: x.created,
        revAt: x.rev?.at ?? null, inWin: iw, reversed: !!x.rev, total: null,
      });
      continue;
    }
    const k = `${x.method}|${x.rev?.from ?? ''}|${!!x.rev}`;
    const g = rSums.get(k) ?? { method: x.method, from: x.rev?.from ?? null, reversed: !!x.rev, total: 0n };
    g.total += x.amountMilli;
    rSums.set(k, g);
  }
  for (const g of rSums.values()) {
    receiptRows.push({ kind: 'SUM', id: null, method: g.method, refundFrom: g.from, amount: null, effAt: null, createdAt: null, revAt: null, inWin: null, reversed: g.reversed, total: formatMilli(g.total, dec) });
  }
  const invoiceRows: LinkedInvoiceSqlRow[] = [];
  const iSums = new Map<string, { stamped: boolean; reversed: boolean; total: bigint }>();
  for (const x of s.invoices) {
    const iw = inWin(x.eff, x.created);
    const rw = !!x.rev && inCustodyWindow(x.rev.at, x.rev.created, W);
    if (iw || rw) {
      invoiceRows.push({ kind: 'ROW', id: x.id, stamped: x.stamped, amount: num(x.amountMilli), effAt: x.eff, createdAt: x.created, revAt: x.rev?.at ?? null, inWin: iw, reversed: !!x.rev, total: null });
      continue;
    }
    const k = `${x.stamped}|${!!x.rev}`;
    const g = iSums.get(k) ?? { stamped: x.stamped, reversed: !!x.rev, total: 0n };
    g.total += x.amountMilli;
    iSums.set(k, g);
  }
  for (const g of iSums.values()) {
    invoiceRows.push({ kind: 'SUM', id: null, stamped: g.stamped, amount: null, effAt: null, createdAt: null, revAt: null, inWin: null, reversed: g.reversed, total: formatMilli(g.total, dec) });
  }
  return { receiptRows, invoiceRows };
}

/** حالة الافتتاح كما يشتقّها الاعتماد (L7) عند البدء: عناصر ما قبل النافذة، والمعكوس داخلها نشطٌ فيه */
function derivedOpeningLedger(s: Scenario, stored: Stored): bigint {
  const pw = (rev: Rev | null) => !!rev && inCustodyWindow(rev.at, rev.created, W);
  const inputs = fullInputs(s, stored, {
    only: preWin,
    stripRev: (kind, id) => {
      if (kind === 'R') return pw(s.receipts.find((x) => x.id === id)!.rev);
      if (kind === 'I') return pw(s.invoices.find((x) => x.id === id)!.rev);
      const st = s.settlements.find((x) => x.id === id)!;
      return !!st.del && delInWin(st.del);
    },
  });
  return custodyComponentsForRep(inputs, REP).ledgerCustody;
}

function windowedInputs(s: Scenario, stored: Stored, openingLedgerMilli: bigint): CustodyComponentsInput | null {
  const { receiptRows, invoiceRows } = sqlRows(s);
  const settlements: LinkedCustodySettlementRow[] = [];
  let settledBefore = 0n;
  for (const x of s.settlements) {
    const iw = inWin(x.eff, x.created);
    const st = stored.get(x.id);
    const row: LinkedCustodySettlementRow = {
      id: x.id, salesRepId: REP, amountMilli: x.amountMilli, effectAt: x.eff, createdAt: x.created, reversedAt: x.del, inWindow: iw,
      nonCustodyClearedMilli: st?.r ?? null, shortageRecoveredMilli: st?.rec ?? null,
    };
    if (iw) settlements.push(row);
    else if (x.del && delInWin(x.del)) settlements.push(row);
    else if (!x.del) settledBefore += x.amountMilli;
  }
  return linkedCustodyInputs(linkedCustodyFactsFromSql({
    salesRepId: REP, dec: s.dec, routing: routingOf(s), openingLedgerMilli, settledBeforeMilli: settledBefore,
    receiptRows, invoiceRows, settlements,
  }));
}

const COMPARED: (keyof CustodyComponents)[] = [
  'ledgerCustody', 'onlineUncleared', 'cashSalesOutsideCustody', 'custodyExpenses', 'openShortage', 'shortagesExpensed',
  'nonCustodyCleared', 'shortageRecovered', 'opsOutstanding', 'nonCustodyAllowance', 'cancelRefundOutside',
];

function storedFor(s: Scenario, unposted: string | null): Stored {
  const first = custodyComponentsForRep(fullInputs(s, new Map()), REP);
  const out: Stored = new Map();
  for (const o of first.settlements) if (o.id !== unposted) out.set(o.id, { r: o.nonCustodyClearedMilli, rec: o.recoveredMilli });
  return out;
}

test('الصيغة المغلقة لنافذة العهدة ≡ الطيّ الكامل: ٢٠٠ سيناريو عشوائي محكوم بمنازل 0 و2 و3 (ومعه تقسيم استلامٍ لم يُرحَّل بعد)', () => {
  let withPw = 0;
  let withPb = 0;
  let withUnposted = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const dec = [0, 2, 3][seed % 3];
    const s = genScenario(seed, dec);
    // أحدث استلام داخل النافذة غير محذوف = لم يُرحَّل بعد (بلا تقسيم مخزَّن): تقسيمه يُشتق من المدخلات في الطريقين
    const candidates = s.settlements.filter((x) => inWin(x.eff, x.created) && !x.del).sort((a, b) => b.eff.getTime() - a.eff.getTime());
    const unposted = candidates[0]?.id ?? null;
    if (unposted) withUnposted++;
    const stored = storedFor(s, unposted);
    const full = custodyComponentsForRep(fullInputs(s, stored), REP);
    const windowed = windowedInputs(s, stored, derivedOpeningLedger(s, stored));
    assert.ok(windowed, `seed ${seed}: لا رجوع للتاريخ الكامل وكل استلام قبل النافذة بتقسيم مخزَّن`);
    const w = custodyComponentsForRep(windowed!, REP);
    for (const k of COMPARED) assert.equal(w[k], full[k], `seed ${seed} dec ${dec}: ${String(k)}`);
    if (unposted) {
      const a = full.settlements.find((o) => o.id === unposted)!;
      const b = w.settlements.find((o) => o.id === unposted)!;
      assert.deepEqual([b.coveredMilli, b.recoveredMilli, b.nonCustodyClearedMilli], [a.coveredMilli, a.recoveredMilli, a.nonCustodyClearedMilli], `seed ${seed}: تقسيم ${unposted}`);
    }
    // النافذة صفوفُ ما بعد البدء وما عُكس داخلها وحدها — لا التاريخ كله
    const preIds = new Set(s.receipts.filter((x) => preWin(x.eff, x.created) && !(x.rev && inCustodyWindow(x.rev.at, x.rev.created, W))).map((x) => x.id));
    for (const it of [...windowed!.receipts, ...windowed!.onlineReceipts, ...windowed!.outsideReceipts]) assert.ok(!preIds.has(it.id), `seed ${seed}: ${it.id} قبل النافذة صفّاً`);
    if (s.receipts.some((x) => preWin(x.eff, x.created) && x.rev && inCustodyWindow(x.rev.at, x.rev.created, W))) withPw++;
    if (s.receipts.some((x) => preWin(x.eff, x.created) && x.rev && !inCustodyWindow(x.rev.at, x.rev.created, W))) withPb++;
  }
  // التغطية: السيناريوهات تمرّ بكل فرع (عكسٌ داخل النافذة لما قبلها، وقبلها، واستلام بلا تقسيم مخزَّن)
  assert.ok(withPw > 20 && withPb > 20 && withUnposted > 100, `${withPw}/${withPb}/${withUnposted}`);
});

test('الصيغة المغلقة: وصولٌ متأخر (مؤرّخ قبل البدء وأُنشئ بعد T0) عنصرُ نافذة لا افتتاح — والعهدة تطابق', () => {
  const dec = 2;
  const s: Scenario = {
    dec, cashInvoice: 'MAIN_CASH',
    receipts: [
      { id: 'pre', method: 'CASH', amountMilli: 500_000n, eff: at('2026-12-10T08:00:00Z'), created: at('2026-12-10T08:01:00Z'), rev: null },
      { id: 'late', method: 'CASH', amountMilli: 230_000n, eff: at('2026-12-20T08:00:00Z'), created: at('2027-02-05T08:00:00Z'), rev: null },
      { id: 'in', method: 'CHEQUE', amountMilli: 700_000n, eff: at('2027-01-05T08:00:00Z'), created: at('2027-01-05T08:00:00Z'), rev: null },
    ],
    invoices: [],
    settlements: [{ id: 's1', amountMilli: 1_000_000n, eff: at('2027-02-10T08:00:00Z'), created: at('2027-02-10T08:00:00Z'), del: null }],
  };
  const stored = storedFor(s, null);
  // الاعتماد عند T0 لم يرَ المتأخر: افتتاحه من «pre» وحده
  const opening = custodyComponentsForRep(fullInputs(s, stored, { only: (eff, created) => preWin(eff, created) }), REP).ledgerCustody;
  assert.equal(opening, 500_000n);
  const w = custodyComponentsForRep(windowedInputs(s, stored, opening)!, REP);
  const full = custodyComponentsForRep(fullInputs(s, stored), REP);
  for (const k of COMPARED) assert.equal(w[k], full[k], String(k));
  assert.equal(w.ledgerCustody, 500_000n + 230_000n + 700_000n - 1_000_000n);
});

test('الصيغة المغلقة: استلامٌ قبل النافذة حُذف داخلها بلا تقسيم مخزَّن ⇒ null (يُطوى التاريخ كله)، وبتقسيمٍ مجمَّد ⇒ مطابقة', () => {
  const s: Scenario = {
    dec: 2, cashInvoice: 'MAIN_CASH',
    receipts: [{ id: 'r1', method: 'CASH', amountMilli: 900_000n, eff: at('2026-11-01T08:00:00Z'), created: at('2026-11-01T08:00:00Z'), rev: null }],
    invoices: [],
    settlements: [{ id: 'old', amountMilli: 400_000n, eff: at('2026-12-01T08:00:00Z'), created: at('2026-12-01T08:00:00Z'), del: at('2027-03-01T08:00:00Z') }],
  };
  assert.equal(windowedInputs(s, new Map(), 500_000n), null);
  const stored = storedFor(s, null);
  const w = custodyComponentsForRep(windowedInputs(s, stored, derivedOpeningLedger(s, stored))!, REP);
  const full = custodyComponentsForRep(fullInputs(s, stored), REP);
  for (const k of COMPARED) assert.equal(w[k], full[k], String(k));
  assert.equal(w.ledgerCustody, 900_000n, 'حذف الاستلام أعاد تغطيته');
});

test('D4 في التصنيف: المربوطة تتجاهل CUSTODY للتحويل ونقطة البيع، وغير المربوطة receiptCustodyClass حرفاً', () => {
  assert.equal(custodyClassOf('CASH', REP, ROUTING, true), 'CUSTODY');
  assert.equal(custodyClassOf('CHEQUE', REP, ROUTING, true), 'CUSTODY');
  assert.equal(custodyClassOf('BANK_TRANSFER', REP, ROUTING, true), 'OUTSIDE');
  assert.equal(custodyClassOf('POS', REP, ROUTING, true), 'OUTSIDE');
  assert.equal(custodyClassOf('ONLINE', REP, ROUTING, true), 'ONLINE');
  assert.equal(custodyClassOf('BANK_TRANSFER', REP, ROUTING, false), 'CUSTODY', 'القديمة كما كانت');
  assert.equal(cancelRefundOutsideCustody('MAIN_CASH'), true);
  assert.equal(cancelRefundOutsideCustody('METHOD'), false);
  assert.equal(cancelRefundOutsideCustody(null), false);
});

test('linkedStoreSettingsOf: المربوطة المفعّلة وحدها، والنافذة من بداية يوم linkedFrom بتوقيت الشركة', () => {
  assert.deepEqual(linkedStoreSettingsOf({ setupMethod: 'CLEAN', activatedAt: at('2027-01-15T09:00:00Z') }), { linked: false, window: null });
  assert.deepEqual(linkedStoreSettingsOf({ setupMethod: 'OPENING', activatedAt: at('2027-01-15T09:00:00Z') }), { linked: false, window: null });
  assert.deepEqual(linkedStoreSettingsOf({ setupMethod: 'LINKED', activatedAt: null }), { linked: false, window: null });
  assert.deepEqual(linkedStoreSettingsOf({ setupMethod: 'LINKED', activatedAt: at('2027-02-01T10:00:00Z') }), { linked: true, window: null });
  const s = linkedStoreSettingsOf({
    timezone: TZ, setupMethod: 'LINKED', activatedAt: at('2027-02-01T10:10:00Z'), linkedFrom: at('2027-01-01T00:00:00Z'), linkSnapshotAt: W.snapshotAt,
  });
  assert.deepEqual(s, { linked: true, window: { start: at('2026-12-31T21:00:00.000Z'), snapshotAt: W.snapshotAt } });
});

// ═══ (ب) PrismaPostingTx فوق عميلٍ مزيّف في الذاكرة ═══

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const OPS = ['in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'equals', 'startsWith'];
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' && /^\d{4}-/.test(v) ? Date.parse(v) : v as number);

/** مطابقة where بسيطة: المساواة والمعاملات وOR/AND/NOT ومسار JSON؛ مرشّحات العلاقات تُهمل (تُختبر بمواضعها) */
function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === 'OR') { if (!(v as Row[]).some((w) => matches(row, w))) return false; continue; }
    if (k === 'AND') { if (!(v as Row[]).every((w) => matches(row, w))) return false; continue; }
    if (k === 'NOT') { if ((Array.isArray(v) ? v : [v]).some((w: Row) => matches(row, w))) return false; continue; }
    const val = row[k];
    if (v === null) { if (val != null) return false; continue; }
    if (v instanceof Date) { if (!(val instanceof Date) || val.getTime() !== v.getTime()) return false; continue; }
    if (typeof v === 'object') {
      if ('path' in v) { if ((val as Row | null)?.[(v.path as string[])[0]] !== v.equals) return false; continue; }
      if (!Object.keys(v).some((o) => OPS.includes(o))) continue;
      if ('in' in v && !(v.in as unknown[]).includes(val)) return false;
      if ('notIn' in v && (v.notIn as unknown[]).includes(val)) return false;
      if ('not' in v && (v.not === null ? val == null : val === v.not)) return false;
      if ('equals' in v && val !== v.equals) return false;
      if ('startsWith' in v && !(typeof val === 'string' && val.startsWith(v.startsWith))) return false;
      if ('gt' in v && !(ms(val) > ms(v.gt))) return false;
      if ('gte' in v && !(ms(val) >= ms(v.gte))) return false;
      if ('lt' in v && !(ms(val) < ms(v.lt))) return false;
      if ('lte' in v && !(ms(val) <= ms(v.lte))) return false;
      continue;
    }
    if (val !== v) return false;
  }
  return true;
}

interface FakeDbData {
  settings: Row | null;
  receipts: Row[];
  invoices: Row[];
  invoiceItems: Row[];
  accountEntries: Row[];
  repSettlements: Row[];
  userSettlements: Row[];
  events: Row[];
  links: Row[];
  settlementEntries: Row[];
  cardPayments: Row[];
  admins: Row[];
  glAccounts: Row[];
  openingLedgerMilli: bigint;
}

function emptyData(settings: Row | null): FakeDbData {
  return {
    settings, receipts: [], invoices: [], invoiceItems: [], accountEntries: [], repSettlements: [], userSettlements: [], events: [], links: [],
    settlementEntries: [], cardPayments: [], admins: [], glAccounts: [], openingLedgerMilli: 0n,
  };
}

/** نموذج Prisma مزيّف لجدول: findMany/findFirst/findUnique بمطابقة where وorderBy بسيط */
function model(rows: () => Row[], calls: string[], name: string) {
  const list = (a: Row = {}) => {
    calls.push(`${name}.findMany`);
    let out = rows().filter((r) => matches(r, a.where));
    const ob = a.orderBy ? (Array.isArray(a.orderBy) ? a.orderBy : [a.orderBy]) : [];
    if (ob.length) {
      out = [...out].sort((x, y) => {
        for (const o of ob as Row[]) {
          const [k, dir] = Object.entries(o)[0] as [string, string];
          const d = ms(x[k]) < ms(y[k]) ? -1 : ms(x[k]) > ms(y[k]) ? 1 : 0;
          if (d !== 0) return dir === 'desc' ? -d : d;
        }
        return 0;
      });
    }
    return a.take ? out.slice(0, a.take) : out;
  };
  return {
    findMany: async (a: Row = {}) => list(a),
    findFirst: async (a: Row = {}) => list(a)[0] ?? null,
    findUnique: async (a: Row = {}) => {
      const w = a.where ?? {};
      const key = w.tenantId_sourceKey ?? w;
      return rows().find((r) => matches(r, key)) ?? null;
    },
  };
}

/** محاكاة استعلامي النافذة الخام (نفس قاعدة linkedCustody*Sql) من صفوف الجداول */
function rawWindow(d: FakeDbData, text: string, values: unknown[]): Row[] {
  const s = d.settings!;
  const w: CustodyWindow = { start: zonedStartOfDay(localDate(s.linkedFrom, 'UTC'), s.timezone), snapshotAt: s.linkSnapshotAt };
  const dec = s.currencyDecimals as number;
  const rep = values.find((v) => typeof v === 'string' && v.startsWith('rep')) as string;
  const iwOf = (e: Date, c: Date) => inCustodyWindow(e, c, w);
  if (text.includes('FROM "rep_settlements" s')) {
    const total = d.repSettlements
      .filter((r) => r.salesRepId === rep && r.settledAt.getTime() < w.start.getTime() && r.createdAt.getTime() <= w.snapshotAt.getTime())
      .reduce((t, r) => t + toMilli(r.amount, dec), 0n);
    return [{ total: formatMilli(total, dec) }];
  }
  const isReceipts = text.includes('"receipts" r LEFT JOIN');
  const docs = isReceipts ? d.receipts.filter((r) => r.salesRepId === rep) : d.invoices.filter((i) => i.salesRepId === rep && i.type === 'CASH');
  const rows: Row[] = [];
  const sums = new Map<string, Row>();
  for (const doc of docs) {
    const es = d.accountEntries.filter((e) => (isReceipts ? e.receiptId === doc.id : e.invoiceId === doc.id && !e.receiptId));
    const minAt = (xs: Row[]) => (xs.length ? new Date(Math.min(...xs.map((e) => e.entryDate.getTime()))) : null);
    const maxCr = (xs: Row[]) => (xs.length ? new Date(Math.max(...xs.map((e) => e.createdAt.getTime()))) : null);
    let effAt: Date; let effCreated: Date; let revAt: Date | null; let revCreated: Date | null;
    if (isReceipts) {
      const c = es.filter((e) => e.type === 'RECEIPT_CREDIT');
      const dd = es.filter((e) => e.type === 'RECEIPT_DEBIT');
      effAt = minAt(c) ?? doc.receiptDate; effCreated = maxCr(c) ?? doc.createdAt; revAt = minAt(dd); revCreated = maxCr(dd);
    } else {
      const p = es.filter((e) => e.type === 'INVOICE_DEBIT');
      const cr = es.filter((e) => e.type === 'INVOICE_CREDIT');
      const keep = cr.some((e) => e.description === CASH_VOID_KEEP_COLLECTION_NOTE);
      const rd = es.some((e) => e.type === 'RECEIPT_DEBIT');
      effAt = minAt(p) ?? doc.invoiceDate;
      effCreated = maxCr(es.filter((e) => e.type === 'INVOICE_DEBIT' || e.type === 'RECEIPT_CREDIT')) ?? doc.createdAt;
      revAt = cr.length && !(keep && !rd) ? minAt(cr) : null;
      revCreated = maxCr(es.filter((e) => e.type === 'INVOICE_CREDIT' || e.type === 'RECEIPT_DEBIT'));
    }
    const iw = iwOf(effAt, effCreated);
    const rw = !!revAt && iwOf(revAt, revCreated!);
    const amount = isReceipts ? doc.amount : doc.total;
    if (iw || rw) {
      rows.push(isReceipts
        ? { kind: 'ROW', id: doc.id, method: doc.paymentMethod, refundFrom: doc.cancelRefundFrom ?? null, amount, effAt, createdAt: doc.createdAt, revAt, inWin: iw, reversed: !!revAt, total: null }
        : { kind: 'ROW', id: doc.id, stamped: doc.cashCollectedByRep === true, amount, effAt: doc.invoiceDate, createdAt: doc.createdAt, revAt, inWin: iw, reversed: !!revAt, total: null });
      continue;
    }
    const k = isReceipts ? `${doc.paymentMethod}|${doc.cancelRefundFrom ?? ''}|${!!revAt}` : `${doc.cashCollectedByRep === true}|${!!revAt}`;
    const g = sums.get(k) ?? (isReceipts
      ? { kind: 'SUM', id: null, method: doc.paymentMethod, refundFrom: doc.cancelRefundFrom ?? null, reversed: !!revAt, milli: 0n }
      : { kind: 'SUM', id: null, stamped: doc.cashCollectedByRep === true, reversed: !!revAt, milli: 0n });
    g.milli += toMilli(amount, dec);
    sums.set(k, g);
  }
  for (const g of sums.values()) rows.push({ ...g, total: formatMilli(g.milli as bigint, dec), milli: undefined });
  return rows;
}

function fakeTx(d: FakeDbData, calls: string[] = []): GlDb {
  const created: Row[] = [];
  const tx = {
    glSettings: { findUnique: async () => { calls.push('glSettings.findUnique'); return d.settings; } },
    receipt: model(() => d.receipts, calls, 'receipt'),
    invoice: model(() => d.invoices, calls, 'invoice'),
    invoiceItem: model(() => d.invoiceItems, calls, 'invoiceItem'),
    accountEntry: model(() => d.accountEntries, calls, 'accountEntry'),
    repSettlement: model(() => d.repSettlements, calls, 'repSettlement'),
    userSettlement: model(() => d.userSettlements, calls, 'userSettlement'),
    glSourceEvent: model(() => d.events, calls, 'glSourceEvent'),
    customerPaymentLink: model(() => d.links, calls, 'customerPaymentLink'),
    settlementEntry: model(() => d.settlementEntries, calls, 'settlementEntry'),
    cardPayment: model(() => d.cardPayments, calls, 'cardPayment'),
    admin: model(() => d.admins, calls, 'admin'),
    glAccount: {
      ...model(() => d.glAccounts, calls, 'glAccount'),
      createMany: async (a: Row) => { calls.push('glAccount.createMany'); for (const r of a.data) { d.glAccounts.push({ id: `acc-${r.code}`, ...r }); created.push(r); } return { count: a.data.length }; },
    },
    glMoveLine: {
      aggregate: async () => { calls.push('glMoveLine.aggregate'); return { _sum: { debitMilli: d.openingLedgerMilli > 0n ? d.openingLedgerMilli : 0n, creditMilli: d.openingLedgerMilli < 0n ? -d.openingLedgerMilli : 0n } }; },
      findMany: async () => [],
    },
    $queryRaw: async (q: unknown, ...vals: unknown[]) => {
      const sql = q as { strings?: string[]; values?: unknown[] };
      const text = Array.isArray(q) ? (q as string[]).join('?') : (sql.strings ?? []).join('?');
      const values = Array.isArray(q) ? vals : (sql.values ?? []);
      calls.push('$queryRaw');
      return rawWindow(d, text, values);
    },
    // سياق البناء بعد إنشاء الحسابات: الجداول فارغة تكفي (الاختبار لا يبني قيداً)
    glAccountMapping: { findMany: async () => [] },
    glTax: { findMany: async () => [] },
    glJournal: { findMany: async () => [] },
    glProductCategoryAccount: { findMany: async () => [] },
    glRepAnalyticDefault: { findMany: async () => [] },
    glPaymentMethodMap: { findMany: async () => [] },
  };
  return tx as unknown as GlDb;
}

function settingsRow(over: Row = {}): Row {
  return {
    tenantId: 't1', timezone: TZ, currency: 'SAR', currencyDecimals: 2, receiptRouting: ROUTING, cashInvoiceRouting: 'MAIN_CASH',
    setupMethod: 'OPENING', openingSnapshotAt: at('2026-01-10T09:00:00Z'), activatedAt: at('2026-01-10T09:00:00Z'),
    linkedFrom: null, linkSnapshotAt: null, cutoverDate: null, ...over,
  };
}

const LINKED = (over: Row = {}) => settingsRow({
  setupMethod: 'LINKED', activatedAt: at('2027-02-01T10:10:00Z'), linkedFrom: at('2027-01-01T00:00:00Z'), linkSnapshotAt: W.snapshotAt,
  cutoverDate: at('2027-01-01T00:00:00Z'), openingSnapshotAt: W.snapshotAt, ...over,
});

function addCashInvoice(d: FakeDbData, o: { id: string; total: number; at: Date; stamped?: boolean; void?: 'KEEP' | 'FULL' | 'KEEP+RD'; voidAt?: Date }) {
  d.invoices.push({ id: o.id, tenantId: 't1', salesRepId: REP, type: 'CASH', total: o.total, invoiceDate: o.at, createdAt: o.at, cashCollectedByRep: o.stamped === true });
  d.accountEntries.push(
    { id: `${o.id}-d`, tenantId: 't1', invoiceId: o.id, receiptId: null, type: 'INVOICE_DEBIT', entryDate: o.at, createdAt: o.at, description: 'فاتورة مبيعات نقدية' },
    { id: `${o.id}-c`, tenantId: 't1', invoiceId: o.id, receiptId: null, type: 'RECEIPT_CREDIT', entryDate: o.at, createdAt: o.at, description: 'تحصيل نقدي لفاتورة مبيعات' },
  );
  if (o.void) {
    const v = o.voidAt ?? new Date(o.at.getTime() + DAY);
    d.accountEntries.push({ id: `${o.id}-v`, tenantId: 't1', invoiceId: o.id, receiptId: null, type: 'INVOICE_CREDIT', entryDate: v, createdAt: v, description: o.void === 'FULL' ? 'إلغاء فاتورة مبيعات نقدية' : CASH_VOID_KEEP_COLLECTION_NOTE });
    if (o.void !== 'KEEP') d.accountEntries.push({ id: `${o.id}-rd`, tenantId: 't1', invoiceId: o.id, receiptId: null, type: 'RECEIPT_DEBIT', entryDate: v, createdAt: v, description: 'عكس تحصيل' });
  }
}

function addReceipt(d: FakeDbData, o: { id: string; amount: number; at: Date; method?: string; cancelAt?: Date; refundFrom?: string | null; refundUser?: string | null; createdAt?: Date }) {
  d.receipts.push({
    id: o.id, tenantId: 't1', salesRepId: REP, customerId: 'c1', number: `R-${o.id}`, amount: o.amount, paymentMethod: o.method ?? 'CASH',
    receiptDate: o.at, createdAt: o.createdAt ?? o.at, updatedAt: o.cancelAt ?? o.at, status: o.cancelAt ? 'CANCELLED' : 'ACTIVE',
    cancelRefundFrom: o.refundFrom ?? null, cancelRefundUserId: o.refundUser ?? null,
    customer: { name: 'عميل' }, salesRep: { name: 'مندوب' }, invoiceItems: [], paymentMethodKey: null,
    accountEntries: o.cancelAt ? [{ entryDate: o.cancelAt }] : [],
  });
  d.accountEntries.push({ id: `${o.id}-c`, tenantId: 't1', invoiceId: null, receiptId: o.id, type: 'RECEIPT_CREDIT', entryDate: o.at, createdAt: o.createdAt ?? o.at, description: 'سند قبض - تحصيل' });
  if (o.cancelAt) d.accountEntries.push({ id: `${o.id}-d`, tenantId: 't1', invoiceId: null, receiptId: o.id, type: 'RECEIPT_DEBIT', entryDate: o.cancelAt, createdAt: o.cancelAt, description: 'إلغاء سند قبض' });
}

test('C17 (E5.13): إبطال ZATCA يحتفظ بالنقد لا يُعدّ عكساً للعهدة — 111003 = 115 = ledgerCustody ⇒ C4 = 0؛ والإبطال مع RECEIPT_DEBIT عكسٌ', async () => {
  for (const linked of [false, true]) {
    const d = emptyData(linked ? settingsRow({ setupMethod: 'LINKED', activatedAt: at('2027-02-01T10:00:00Z') }) : settingsRow({ cashInvoiceRouting: 'CUSTODY' }));
    addCashInvoice(d, { id: 'inv-keep', total: 115, at: at('2027-03-01T08:00:00Z'), stamped: true, void: 'KEEP' });
    addCashInvoice(d, { id: 'inv-full', total: 50, at: at('2027-03-02T08:00:00Z'), stamped: true, void: 'FULL' });
    addCashInvoice(d, { id: 'inv-keep-rd', total: 20, at: at('2027-03-03T08:00:00Z'), stamped: true, void: 'KEEP+RD' });
    const inputs = await new PrismaPostingTx(fakeTx(d), 't1').loadCustodyInputs(REP);
    const byId = new Map(inputs.cashInvoices.map((i) => [i.id, i]));
    assert.equal(byId.get('inv-keep')!.reversedAt, null, 'الإبطال المحتفظ بالنقد لا يعكس شقّ التحصيل');
    assert.ok(byId.get('inv-full')!.reversedAt, 'الإلغاء الكامل عكس');
    assert.ok(byId.get('inv-keep-rd')!.reversedAt, 'وسم الإبطال مع RECEIPT_DEBIT عكسٌ (مرآة keepCashLeg)');
    assert.equal(byId.get('inv-keep')!.stamped, true);
    assert.equal(inputs.routing.stampDrivesCustody, linked ? true : undefined, 'الختم يوجّه النقد للمربوطة وحدها');
    const c = custodyComponentsForRep(inputs, REP);
    // الأستاذ: ساق النقد 111003 115 باقية (keepCashLeg)، والملغاتان معكوستان كلياً
    assert.equal(c.ledgerCustody, 115_000n);
    assert.equal(custodyC4Gap(115_000n, c), 0n);
  }
});

test('الختم في القديمة لا يغيّر P7: العتبة والعهدة كما كانت، والشاشة تعدّه (C4b يطابق المعلّق مع النقدية المختومة)', async () => {
  const d = emptyData(settingsRow());
  addCashInvoice(d, { id: 'inv1', total: 300, at: at('2027-03-01T08:00:00Z'), stamped: true });
  addCashInvoice(d, { id: 'inv2', total: 200, at: at('2027-03-01T09:00:00Z') });
  const inputs = await new PrismaPostingTx(fakeTx(d), 't1').loadCustodyInputs(REP);
  const c = custodyComponentsForRep(inputs, REP);
  const legacy = custodyComponentsForRep({ ...inputs, cashInvoices: inputs.cashInvoices.map(({ stamped: _s, ...i }) => i) }, REP);
  assert.equal(c.ledgerCustody, legacy.ledgerCustody);
  assert.equal(c.nonCustodyAllowance, legacy.nonCustodyAllowance, 'عتبة P7 لا تتغيّر بالختم');
  // الشاشة (repCollections + النقدية المختومة) = 300 ⇒ C4b = 0
  assert.equal(custodyC4bGap(c, 300_000n), 0n);
});

test('C11 (E5.7): إلغاء بعد التسليم بردٍّ من الصندوق — الأستاذ 111003 = 0 والمكوّنات تطابق، وC4b = 0 (ops = −500)؛ وللقديمة لا علَم', async () => {
  for (const linked of [true, false]) {
    const d = emptyData(linked ? settingsRow({ setupMethod: 'LINKED', activatedAt: at('2027-02-01T10:00:00Z') }) : settingsRow());
    addReceipt(d, { id: 'r1', amount: 500, at: at('2027-03-01T08:00:00Z'), cancelAt: at('2027-03-05T08:00:00Z'), refundFrom: 'MAIN_CASH' });
    d.repSettlements.push({ id: 's1', tenantId: 't1', salesRepId: REP, amount: 500, method: 'CASH', settledAt: at('2027-03-02T08:00:00Z'), createdAt: at('2027-03-02T08:00:00Z') });
    d.events.push({ tenantId: 't1', sourceKey: 'SETTLEMENT:s1:POST', sourceType: 'SETTLEMENT', sourceId: 's1', event: 'POST', status: 'DONE', effectAt: at('2027-03-02T08:00:00Z'), payload: { salesRepId: REP }, nonCustodyClearedMilli: 0n, shortageRecoveredMilli: 0n });
    const inputs = await new PrismaPostingTx(fakeTx(d), 't1').loadCustodyInputs(REP);
    assert.equal(inputs.receipts[0].reversalOutsideCustody, linked ? true : undefined);
    const c = custodyComponentsForRep(inputs, REP);
    if (linked) {
      assert.equal(c.ledgerCustody, 0n, '111003 يبقى 0 لا −500');
      assert.equal(c.cancelRefundOutside, 500_000n);
      assert.equal(custodyC4bGap(c, -500_000n), 0n);
    } else {
      assert.equal(c.ledgerCustody, -500_000n, 'القديمة: العكس مرآة الأصل كما كان');
    }
  }
});

/** سيناريو مربوط في القاعدة المزيّفة: ما قبل البدء وما بعده، ومعكوس داخل النافذة وقبلها، ومحذوف، واستلامات بتقسيم مخزَّن */
function linkedDb(): FakeDbData {
  const d = emptyData(LINKED());
  // ما قبل البدء
  addReceipt(d, { id: 'p1', amount: 1000, at: at('2026-11-01T08:00:00Z') });
  addReceipt(d, { id: 'p2', amount: 400, at: at('2026-11-05T08:00:00Z'), method: 'BANK_TRANSFER' });
  addReceipt(d, { id: 'p3', amount: 250.5, at: at('2026-11-10T08:00:00Z'), cancelAt: at('2026-11-20T08:00:00Z') }); // Pb
  addReceipt(d, { id: 'p4', amount: 300, at: at('2026-12-01T08:00:00Z'), cancelAt: at('2027-01-10T08:00:00Z') }); // Pw
  addReceipt(d, { id: 'p5', amount: 120, at: at('2026-12-03T08:00:00Z'), cancelAt: at('2026-12-04T08:00:00Z'), refundFrom: 'MAIN_CASH' }); // Pb خارج العهدة
  addReceipt(d, { id: 'p6', amount: 90, at: at('2026-12-05T08:00:00Z'), method: 'ONLINE' });
  addCashInvoice(d, { id: 'pi1', total: 115, at: at('2026-12-06T08:00:00Z'), stamped: true });
  addCashInvoice(d, { id: 'pi2', total: 60, at: at('2026-12-07T08:00:00Z') });
  addCashInvoice(d, { id: 'pi3', total: 75, at: at('2026-12-08T08:00:00Z'), stamped: true, void: 'FULL', voidAt: at('2027-01-03T08:00:00Z') }); // Pw
  d.repSettlements.push({ id: 'ps1', tenantId: 't1', salesRepId: REP, amount: 800, method: 'CASH', settledAt: at('2026-11-15T08:00:00Z'), createdAt: at('2026-11-15T08:00:00Z') });
  // ما بعد البدء
  addReceipt(d, { id: 'w1', amount: 700, at: at('2027-01-05T08:00:00Z'), method: 'CHEQUE' });
  addReceipt(d, { id: 'w2', amount: 500, at: at('2027-01-06T08:00:00Z'), cancelAt: at('2027-01-20T08:00:00Z'), refundFrom: 'USER_CUSTODY', refundUser: 'u1' });
  addReceipt(d, { id: 'late', amount: 33, at: at('2026-12-20T08:00:00Z'), createdAt: at('2027-02-05T08:00:00Z') }); // وصول متأخر
  addCashInvoice(d, { id: 'wi1', total: 230, at: at('2027-01-07T08:00:00Z'), stamped: true });
  d.repSettlements.push({ id: 'ws1', tenantId: 't1', salesRepId: REP, amount: 600, method: 'CASH', settledAt: at('2027-01-08T08:00:00Z'), createdAt: at('2027-01-08T08:00:00Z') });
  // استلامات محذوفة: قبل البدء وحُذف داخل النافذة (تقسيمه مجمَّد)، وقبله حُذف قبله، وداخل النافذة
  const tomb = (id: string, amount: string, settledAt: string, deletedAt: string, stored: bigint | null) => {
    const payload = { settlementId: id, amount, method: 'CASH', salesRepId: REP, settledAt, createdAt: settledAt };
    d.events.push({ tenantId: 't1', sourceKey: `SETTLEMENT:${id}:REVERSE`, sourceType: 'SETTLEMENT', sourceId: id, event: 'REVERSE', status: 'PENDING', effectAt: at(deletedAt), detectedAt: at(deletedAt), payload });
    d.events.push({ tenantId: 't1', sourceKey: `SETTLEMENT:${id}:POST`, sourceType: 'SETTLEMENT', sourceId: id, event: 'POST', status: stored === null ? 'PENDING' : 'SKIPPED', effectAt: at(settledAt), detectedAt: at(settledAt), payload, nonCustodyClearedMilli: stored, shortageRecoveredMilli: stored === null ? null : 0n });
  };
  tomb('pdw', '150.00', '2026-12-10T08:00:00.000Z', '2027-01-15T08:00:00.000Z', 0n);
  tomb('pdp', '80.00', '2026-11-25T08:00:00.000Z', '2026-11-26T08:00:00.000Z', 0n);
  tomb('wdw', '100.00', '2027-01-09T08:00:00.000Z', '2027-01-12T08:00:00.000Z', 0n);
  d.events.push({ tenantId: 't1', sourceKey: 'SETTLEMENT:ps1:POST', sourceType: 'SETTLEMENT', sourceId: 'ps1', event: 'POST', status: 'SKIPPED', effectAt: at('2026-11-15T08:00:00Z'), payload: { salesRepId: REP }, nonCustodyClearedMilli: 0n, shortageRecoveredMilli: 0n });
  d.events.push({ tenantId: 't1', sourceKey: 'SETTLEMENT:ws1:POST', sourceType: 'SETTLEMENT', sourceId: 'ws1', event: 'POST', status: 'DONE', effectAt: at('2027-01-08T08:00:00Z'), payload: { salesRepId: REP }, nonCustodyClearedMilli: 0n, shortageRecoveredMilli: 0n });
  return d;
}

test('نافذة العهدة في PrismaPostingTx: صفوف النافذة ومجاميع ما قبلها (SQL) + قيد OPENING ≡ طيّ التاريخ كله — وبلا استعلام صفوف التاريخ', async () => {
  const d = linkedDb();
  // الطيّ الكامل: المسار نفسه بلا نافذة (مربوطة قبل linkedFrom)، ثم افتتاح الاعتماد = الحالة عند البدء (المعكوس داخلها نشط)
  const fullTx = new PrismaPostingTx(fakeTx({ ...d, settings: LINKED({ linkedFrom: null, cutoverDate: null }) }), 't1');
  const full = await fullTx.loadCustodyInputs(REP);
  const pre = (i: CustodyItem) => !inCustodyWindow(i.effectAt as Date, (i.createdAt ?? i.effectAt) as Date, W);
  const strip = (i: CustodyItem) => (i.reversedAt != null && inCustodyWindow(i.reversedAt as Date, i.reversedAt as Date, W) ? { ...i, reversedAt: null, reversalOutsideCustody: undefined } : i);
  const openingInputs: CustodyComponentsInput = {
    ...full,
    receipts: full.receipts.filter(pre).map(strip), onlineReceipts: full.onlineReceipts.filter(pre).map(strip),
    outsideReceipts: full.outsideReceipts.filter(pre).map(strip), cashInvoices: full.cashInvoices.filter(pre).map(strip),
    settlements: full.settlements.filter(pre).map((st) => strip(st) as CustodySettlementItem),
  };
  d.openingLedgerMilli = custodyComponentsForRep(openingInputs, REP).ledgerCustody;
  const calls: string[] = [];
  const w = await new PrismaPostingTx(fakeTx(d, calls), 't1').loadCustodyInputs(REP);
  assert.ok(calls.includes('$queryRaw'), 'مسار النافذة');
  assert.ok(!calls.includes('receipt.findMany') && !calls.includes('invoice.findMany'), 'لا تُقرأ صفوف التاريخ كله');
  const a = custodyComponentsForRep(full, REP);
  const b = custodyComponentsForRep(w, REP);
  for (const k of COMPARED) assert.equal(b[k], a[k], String(k));
  // العناصر صفوفاً: ما بعد البدء + المعكوس داخلها لما قبلها + المتأخر — لا p1/p2/p6/pi1/pi2
  const ids = new Set([...w.receipts, ...w.onlineReceipts, ...w.outsideReceipts, ...w.cashInvoices, ...w.settlements].map((i) => i.id));
  assert.deepEqual([...ids].sort(), ['late', 'p4', 'pdw', 'pi3', 'w1', 'w2', 'wdw', 'wi1', 'ws1'].sort());
  assert.ok(w.opening?.[REP], 'حالة افتتاحية للمندوب');
  assert.equal(w.opening![REP].cancelRefundOutsideMilli, 120_000n, 'p5 رُدّ من الصندوق قبل البدء');
  // تقسيم استلامٍ جديد في النافذة يُشتق في الطريقين بالنتيجة نفسها (مدخلات builder P7)
  const p = { settledAt: '2027-03-01T08:00:00.000Z', createdAt: '2027-03-01T08:00:00.000Z' };
  const add = (x: CustodyComponentsInput): CustodyComponentsInput => ({ ...x, settlements: [...x.settlements, { id: 'new', salesRepId: REP, amountMilli: 1_500_000n, effectAt: p.settledAt, createdAt: p.createdAt }] });
  const sa = custodyComponentsForRep(custodyInputsBefore(add(full), 'new', p), REP);
  const sb = custodyComponentsForRep(custodyInputsBefore(add(w), 'new', p), REP);
  assert.deepEqual([sb.ledgerCustody, sb.nonCustodyCleared, sb.nonCustodyAllowance, sb.openShortage], [sa.ledgerCustody, sa.nonCustodyCleared, sa.nonCustodyAllowance, sa.openShortage]);
});

test('نافذة العهدة: استلامٌ قبل البدء حُذف داخل النافذة بلا تقسيم مجمَّد ⇒ يُطوى التاريخ كله (لا تخمين للتغطية)', async () => {
  const d = linkedDb();
  const ev = d.events.find((e) => e.sourceKey === 'SETTLEMENT:pdw:POST')!;
  ev.nonCustodyClearedMilli = null;
  ev.status = 'PENDING';
  const calls: string[] = [];
  await new PrismaPostingTx(fakeTx(d, calls), 't1').loadCustodyInputs(REP);
  assert.ok(calls.includes('$queryRaw') && calls.includes('receipt.findMany'), 'جُرّبت النافذة ثم طُوي التاريخ كله');
});

// ═══ عهدة المستخدم (D6) ═══

function userDb(): FakeDbData {
  const d = emptyData(LINKED());
  d.repSettlements.push(
    { id: 'rs1', tenantId: 't1', salesRepId: REP, receivedByUserId: 'u1', amount: 800, method: 'CASH', settledAt: at('2027-01-10T08:00:00Z'), createdAt: at('2027-01-10T08:00:00Z') },
    { id: 'rs2', tenantId: 't1', salesRepId: REP, receivedByUserId: 'u1', amount: 300, method: 'BANK_TRANSFER', settledAt: at('2027-01-11T08:00:00Z'), createdAt: at('2027-01-11T08:00:00Z') },
    { id: 'rs3', tenantId: 't1', salesRepId: null, receivedByUserId: 'u2', amount: 50, method: 'CASH', settledAt: at('2027-01-12T08:00:00Z'), createdAt: at('2027-01-12T08:00:00Z') },
  );
  // استلام محذوف بيد u1 (حمولة المربوطة تحمل المستلِم)
  d.events.push({ tenantId: 't1', sourceKey: 'SETTLEMENT:rsx:REVERSE', sourceType: 'SETTLEMENT', sourceId: 'rsx', event: 'REVERSE', status: 'DONE', effectAt: at('2027-01-20T08:00:00Z'), payload: { settlementId: 'rsx', amount: '200.00', method: 'CASH', salesRepId: REP, settledAt: '2027-01-13T08:00:00.000Z', createdAt: '2027-01-13T08:00:00.000Z', receivedByUserId: 'u1' } });
  d.userSettlements.push(
    { id: 'us1', tenantId: 't1', fromUserId: 'u1', amount: 300, method: 'BANK_TRANSFER', settledAt: at('2027-01-15T08:00:00Z'), createdAt: at('2027-01-15T08:00:00Z') },
    { id: 'us2', tenantId: 't1', fromUserId: 'u1', amount: 500, method: 'CASH', settledAt: at('2027-01-16T08:00:00Z'), createdAt: at('2027-01-16T08:00:00Z') },
  );
  d.events.push(
    { tenantId: 't1', sourceKey: 'USER_SETTLEMENT:us1:POST', sourceType: 'USER_SETTLEMENT', sourceId: 'us1', event: 'POST', status: 'SKIPPED', effectAt: at('2027-01-15T08:00:00Z'), payload: { fromUserId: 'u1' }, nonCustodyClearedMilli: 300_000n },
    // توريد محذوف: POST مرحَّل بتقسيمه وREVERSE بلحظة الحذف
    { tenantId: 't1', sourceKey: 'USER_SETTLEMENT:usx:POST', sourceType: 'USER_SETTLEMENT', sourceId: 'usx', event: 'POST', status: 'DONE', effectAt: at('2027-01-17T08:00:00Z'), payload: { fromUserId: 'u1', amount: '100.00', method: 'CASH', settledAt: '2027-01-17T08:00:00.000Z', createdAt: '2027-01-17T08:00:00.000Z' }, nonCustodyClearedMilli: 0n },
    { tenantId: 't1', sourceKey: 'USER_SETTLEMENT:usx:REVERSE', sourceType: 'USER_SETTLEMENT', sourceId: 'usx', event: 'REVERSE', status: 'PENDING', effectAt: at('2027-01-18T08:00:00Z'), payload: { fromUserId: 'u1', amount: '100.00', method: 'CASH', settledAt: '2027-01-17T08:00:00.000Z', createdAt: '2027-01-17T08:00:00.000Z' } },
  );
  addReceipt(d, { id: 'rcx', amount: 40, at: at('2027-01-05T08:00:00Z'), cancelAt: at('2027-01-21T08:00:00Z'), refundFrom: 'USER_CUSTODY', refundUser: 'u1' });
  return d;
}

test('عهدة المستخدم (D6): الحيّ والمحذوف من المستلَم والتوريد، والتقسيم المخزَّن، والاسترداد — الطيّ = 800 + 200 − 500 − 40 − 0 (مرور 300)', async () => {
  const d = userDb();
  const tx = new PrismaPostingTx(fakeTx(d), 't1');
  const x = await tx.loadUserCustodyInputs('u1');
  assert.deepEqual(x.received.map((r) => [r.id, r.amountMilli, r.reversedAt ? 'R' : '-']).sort(), [['rs1', 800_000n, '-'], ['rs2', 300_000n, '-'], ['rsx', 200_000n, 'R']]);
  assert.deepEqual(x.delivered.map((r) => [r.id, r.amountMilli, r.storedPassThroughMilli ?? null, r.reversedAt ? 'R' : '-']).sort(), [['us1', 300_000n, 300_000n, '-'], ['us2', 500_000n, null, '-'], ['usx', 100_000n, 0n, 'R']]);
  assert.deepEqual(x.refunds.map((r) => [r.id, r.amountMilli, r.at]), [['rcx', 40_000n, at('2027-01-21T08:00:00Z')]], 'لحظة الردّ من صفّ الإلغاء');
  const f = foldUserCustody(x);
  // المستلَم نقداً 800 (rsx محذوف)، المورَّد نقداً 500 (usx محذوف، us1 مرور كامل)، والاسترداد 40
  assert.equal(f.outstandingMilli, 800_000n - 500_000n - 40_000n);
  assert.equal(f.passThroughMilli, 300_000n);
  // المجمّع: كل المستخدمين بخمس قراءات
  const calls: string[] = [];
  const many = await loadUserCustodyInputsMany(fakeTx(d, calls), 't1', 2, null);
  // استلامٌ من مندوب محذوف (salesRepId فارغ) لا يرحّله المُطابِق (SETTLEMENT_HAS_REP) فلا يدخل 111004 — لكنه يُقرأ (المصدر الواحد مع
  // الشاشة، مراجعة ١٤ نوفمبر) موسوماً outsideCustody: يدخل الوعاء لا العهدة، فتوريد ماله يمرّ بلا قيد ولا سالب على 111004
  assert.deepEqual([...many.keys()].sort(), ['u1', 'u2']);
  assert.deepEqual(many.get('u2')!.received.map((r) => [r.id, r.amountMilli, r.outsideCustody]), [['rs3', 50_000n, true]]);
  const u2 = foldUserCustody(many.get('u2')!);
  assert.deepEqual([u2.outstandingMilli, u2.nonCashPoolMilli], [0n, 50_000n], 'مال المندوب المحذوف خارج 111004');
  assert.ok(many.get('u1')!.received.every((r) => r.outsideCustody === undefined), 'استلام مندوبٍ قائم بحكم طريقته');
  assert.equal(calls.length, 5, 'خمس قراءات بلا N+1');
});

test('listUserFeedEvents وgetReceiptReverse', async () => {
  const d = userDb();
  d.events.push(
    { tenantId: 't1', sourceKey: 'SETTLEMENT:rs1:POST', sourceType: 'SETTLEMENT', sourceId: 'rs1', event: 'POST', status: 'PENDING', effectAt: at('2027-01-10T08:00:00Z'), payload: { receivedByUserId: 'u1' } },
    { tenantId: 't1', sourceKey: 'SETTLEMENT:rs9:POST', sourceType: 'SETTLEMENT', sourceId: 'rs9', event: 'POST', status: 'DONE', effectAt: at('2027-01-10T08:00:00Z'), payload: { receivedByUserId: 'u1' } },
    { tenantId: 't1', sourceKey: 'RECEIPT:rcx:REVERSE', sourceType: 'RECEIPT', sourceId: 'rcx', event: 'REVERSE', status: 'DONE', effectAt: at('2027-01-21T08:00:00Z'), payload: { refundEntryId: 'se9', cancelRefundFrom: 'USER_CUSTODY' } },
  );
  const tx = new PrismaPostingTx(fakeTx(d), 't1');
  assert.deepEqual(await tx.listUserFeedEvents('u1', at('2027-01-31T00:00:00Z')), [{ status: 'PENDING', effectAt: at('2027-01-10T08:00:00Z') }]);
  assert.deepEqual(await tx.listUserFeedEvents('u1', at('2027-01-09T00:00:00Z')), []);
  assert.deepEqual(await tx.getReceiptReverse('rcx'), { status: 'DONE', refundEntryId: 'se9', cancelRefundFrom: 'USER_CUSTODY' });
  assert.equal(await tx.getReceiptReverse('none'), null);
});

test('ensureLinkedAccounts: للمربوطة وحدها (ينشئ 111004/112007/214002 مرة ويعيد السياق)، ولغيرها لا كتابة ولا قراءة حسابات', async () => {
  for (const s of [settingsRow({ setupMethod: 'CLEAN' }), settingsRow()]) {
    const calls: string[] = [];
    const r = await new PrismaPostingTx(fakeTx(emptyData(s), calls), 't1').ensureLinkedAccounts();
    assert.deepEqual(r, { created: [], context: null });
    assert.ok(!calls.some((c) => c.startsWith('glAccount')), `${s.setupMethod}: لا مساس بشجرة الحسابات`);
  }
  const d = emptyData(LINKED());
  const calls: string[] = [];
  const r1 = await new PrismaPostingTx(fakeTx(d, calls), 't1').ensureLinkedAccounts();
  assert.deepEqual([...r1.created].sort(), ['111004', '112007', '214002']);
  assert.ok(r1.context, 'السياق أُعيد تحميله بعد الإنشاء');
  const r2 = await new PrismaPostingTx(fakeTx(d), 't1').ensureLinkedAccounts();
  assert.deepEqual(r2, { created: [], context: null }, 'متساوي الأثر');
});

// ═══ حمولة المربوطة بدوال A1 (مصدر واحد) وحمولة غيرها كما كانت ═══

function payloadDb(settings: Row): FakeDbData {
  const d = emptyData(settings);
  d.invoices.push({
    id: 'inv1', tenantId: 't1', number: 'INV-1001', type: 'CREDIT', customerId: 'c1', salesRepId: REP, pricesIncludeTax: false,
    subtotal: 1000, discountAmt: 0, taxAmt: 150, total: 1150, dueDate: null, taxFree: false, invoiceDate: at('2026-11-14T08:00:00Z'),
    cashCollectedByRep: false, remainingApplied: null, documentKind: null, originalInvoiceId: null,
    customer: { name: 'عميل C', paymentDays: 30 }, salesRep: { name: 'R' },
    items: [{ id: 'it1', productId: 'P', qty: 10, unitPrice: 100, taxPct: 15, taxAmt: 150, lineTotal: 1000, vatCategory: 'S', baseQty: 240, unitFactor: 24, itemName: 'كرتون P', returnOfItemId: null, product: { categoryId: null, name: 'P' } }],
    installments: [{ seq: 1, dueDate: at('2026-12-14T08:00:00Z'), amount: 575 }, { seq: 2, dueDate: at('2027-01-13T08:00:00Z'), amount: 575 }],
  });
  d.accountEntries.push({ id: 'e1', tenantId: 't1', customerId: 'c1', invoiceId: 'inv1', receiptId: null, type: 'INVOICE_DEBIT', entryDate: at('2026-11-14T08:00:00Z'), createdAt: at('2026-11-14T08:00:05Z'), description: 'x' });
  addReceipt(d, { id: 'rc1', amount: 600, at: at('2026-11-20T08:00:00Z'), cancelAt: at('2026-11-25T08:00:00Z'), refundFrom: 'MAIN_CASH' });
  d.receipts[0].invoiceItems = [{ id: 'ri1', invoiceId: 'inv1', amount: 600 }];
  d.repSettlements.push({ id: 'st1', tenantId: 't1', salesRepId: REP, receivedByUserId: 'u1', amount: 800, method: 'CASH', note: null, settledAt: at('2026-11-21T08:00:00Z'), createdAt: at('2026-11-21T08:00:01Z'), salesRep: { name: 'R' } });
  d.userSettlements.push({ id: 'us1', tenantId: 't1', fromUserId: 'u1', amount: 800, method: 'CHEQUE', note: 'ن', receivedBy: 'مدير', receivedByUserId: 'u9', settledAt: at('2026-11-22T08:00:00Z'), createdAt: at('2026-11-22T08:00:01Z') });
  d.admins.push({ id: 'u1', tenantId: 't1', name: 'مستخدم U' });
  d.links.push({ id: 'lk1', tenantId: 't1', receiptId: 'rc9', customerId: 'c1', customer: { name: 'عميل C' } });
  d.settlementEntries.push({ id: 'se1', tenantId: 't1', kind: 'REFUND', amount: -1000, feeNet: null, feeVat: null, linkId: 'lk1', payoutId: null, note: null, createdAt: at('2026-11-23T08:00:00Z') });
  return d;
}

test('loadSourceData للمربوطة = دوال A1 حرفاً (الأقساط والاستحقاق والبنود، والتخصيصات ومصدر الردّ، والمستلِم، والتوريد، والاسترداد)', async () => {
  const d = payloadDb(LINKED());
  const tx = new PrismaPostingTx(fakeTx(d), 't1');
  const ctx = { timezone: TZ, currency: 'SAR', currencyDecimals: 2, linked: true };

  const inv = await tx.loadSourceData('INVOICE', 'inv1', 'POST');
  assert.equal(inv.kind, 'FOUND');
  const facts = { ...d.invoices[0], customerName: 'عميل C', salesRepName: 'R', customerPaymentDays: 30, saleInvoiceId: null,
    items: [{ productId: 'P', categoryId: null, qty: 10, unitPrice: 100, taxPct: 15, taxAmt: 150, lineTotal: 1000, vatCategory: 'S', baseQty: 240, unitFactor: 24, productName: 'كرتون P' }],
    installments: d.invoices[0].installments };
  assert.deepEqual((inv as { payload: unknown }).payload, invoicePostEventPayload(facts as never, '2026-11-14', ctx, '2026-11-14T08:00:05.000Z'));
  const ip = (inv as { payload: Record<string, unknown> }).payload;
  assert.equal((ip.installments as unknown[]).length, 2, 'الأقساط في الحمولة');

  const rp = await tx.loadSourceData('RECEIPT', 'rc1', 'POST');
  const rf = { id: 'rc1', number: 'R-rc1', customerId: 'c1', salesRepId: REP, paymentMethod: 'CASH', amount: 600, customerName: 'عميل', salesRepName: 'مندوب', paylinkId: null, refund: null, paymentMethodKey: null, cardPaymentId: null, allocations: [{ id: 'ri1', invoiceId: 'inv1', amount: 600 }], cancelRefundFrom: 'MAIN_CASH', cancelRefundUserId: null, cancelRefundUserName: null };
  assert.deepEqual((rp as { payload: unknown }).payload, receiptPostEventPayload(rf, '2026-11-20', ctx, '2026-11-20T08:00:00.000Z'));
  const rr = await tx.loadSourceData('RECEIPT', 'rc1', 'REVERSE');
  assert.deepEqual((rr as { payload: unknown }).payload, receiptReverseEventPayload(rf, '2026-11-25', ctx, '2026-11-25T08:00:00.000Z'));
  assert.equal(((rr as { payload: Record<string, unknown> }).payload).cancelRefundFrom, 'MAIN_CASH');

  const sp = await tx.loadSourceData('SETTLEMENT', 'st1', 'POST');
  assert.deepEqual((sp as { payload: unknown }).payload, settlementPayload({ ...d.repSettlements[0], note: null }, 'R', 2, { linked: true, receivedByName: 'مستخدم U' }));

  const up = await tx.loadSourceData('USER_SETTLEMENT', 'us1', 'POST');
  assert.deepEqual((up as { payload: unknown }).payload, userSettlementPayload(d.userSettlements[0] as never, 'مستخدم U', 2));

  const pr = await tx.loadSourceData('PAYLINK_REFUND', 'se1', 'POST');
  assert.deepEqual((pr as { payload: unknown }).payload, paylinkRefundPayload(d.settlementEntries[0] as never, { receiptId: 'rc9', customerId: 'c1', customerName: 'عميل C' }, 2));
});

test('loadSourceData لغير المربوطة كما كان حرفاً (لا حقول L4/L5، والمصدران الجديدان MISSING)', async () => {
  const d = payloadDb(settingsRow());
  const tx = new PrismaPostingTx(fakeTx(d), 't1');
  const sp = await tx.loadSourceData('SETTLEMENT', 'st1', 'POST');
  assert.deepEqual((sp as { payload: unknown }).payload, {
    settlementId: 'st1', amount: '800.00', method: 'CASH', salesRepId: REP, settledAt: '2026-11-21T08:00:00.000Z', createdAt: '2026-11-21T08:00:01.000Z', note: null, salesRepName: 'R',
  });
  const rr = await tx.loadSourceData('RECEIPT', 'rc1', 'REVERSE');
  assert.deepEqual((rr as { payload: unknown }).payload, {
    receiptId: 'rc1', entryDate: '2026-11-25', paymentMethod: 'CASH', paylinkId: null, refundEntryId: null, refundedAmount: null, sourceCreatedAt: '2026-11-25T08:00:00.000Z',
  });
  const inv = await tx.loadSourceData('INVOICE', 'inv1', 'POST');
  const ip = (inv as { payload: Record<string, unknown> }).payload;
  for (const k of ['installments', 'cashCollectedByRep', 'dueDateDerived', 'appliesTo']) assert.ok(!(k in ip), `بلا ${k}`);
  assert.ok(!('baseQty' in (ip.items as Record<string, unknown>[])[0]));
  assert.deepEqual(await tx.loadSourceData('USER_SETTLEMENT', 'us1', 'POST'), { kind: 'MISSING' });
  assert.deepEqual(await tx.loadSourceData('PAYLINK_REFUND', 'se1', 'POST'), { kind: 'MISSING' });
});

test('عكس فاتورة نقدية مختومة أُبطلت محتفظةً بالنقد (E4.11): حمولة المربوطة تحمل keepCashLeg كالمُطابِق', async () => {
  const d = emptyData(LINKED());
  addCashInvoice(d, { id: 'ci', total: 115, at: at('2027-01-10T08:00:00Z'), stamped: true, void: 'KEEP' });
  Object.assign(d.invoices[0], { number: 'INV-1002', customerId: 'c1', pricesIncludeTax: false, subtotal: 100, discountAmt: 0, taxAmt: 15, dueDate: null, taxFree: false, customer: { name: 'C', paymentDays: 0 }, salesRep: { name: 'R' }, items: [], installments: [], remainingApplied: null, documentKind: null, originalInvoiceId: null });
  const rev = await new PrismaPostingTx(fakeTx(d), 't1').loadSourceData('INVOICE', 'ci', 'REVERSE');
  assert.deepEqual((rev as { payload: unknown }).payload, { invoiceId: 'ci', type: 'CASH', entryDate: '2027-01-11', sourceCreatedAt: '2027-01-11T08:00:00.000Z', keepCashLeg: true });
});

test('resolveOrigin لتوريد المستخدم من حمولة الـtombstone ووجود صفّه', async () => {
  const d = emptyData(LINKED());
  d.userSettlements.push({ id: 'us1', tenantId: 't1', fromUserId: 'u1' });
  const tx = new PrismaPostingTx(fakeTx(d), 't1');
  const payload = { settledAt: '2027-01-15T08:00:00.000Z', createdAt: '2027-01-15T08:00:01.000Z' };
  const o1 = await tx.resolveOrigin({ sourceType: 'USER_SETTLEMENT', sourceId: 'us1', event: 'REVERSE', payload: payload as never });
  assert.deepEqual(o1, { originEffectAt: payload.settledAt, originCreatedAt: payload.createdAt, sourceExists: true });
  const o2 = await tx.resolveOrigin({ sourceType: 'USER_SETTLEMENT', sourceId: 'gone', event: 'REVERSE', payload: payload as never });
  assert.equal(o2?.sourceExists, false);
});

test('hasUnreadRepSettlements: EXISTS بعد المؤشر حتى الأفق للمندوب القائم وحده', async () => {
  const rows: Row[] = [
    { id: 'a', tenantId: 't1', salesRepId: REP, createdAt: at('2027-01-10T08:00:00Z') },
    { id: 'b', tenantId: 't1', salesRepId: null, createdAt: at('2027-01-11T08:00:00Z') },
  ];
  const db = { repSettlement: model(() => rows, [], 'repSettlement') } as unknown as PrismaClient;
  const store = new PrismaPostingStore(db);
  assert.equal(await store.hasUnreadRepSettlements('t1', { at: at('2027-01-09T00:00:00Z'), id: '' }, at('2027-02-01T00:00:00Z')), true);
  assert.equal(await store.hasUnreadRepSettlements('t1', { at: at('2027-01-10T08:00:00Z'), id: 'a' }, at('2027-02-01T00:00:00Z')), false, 'b بلا مندوب لا يُعدّ');
  assert.equal(await store.hasUnreadRepSettlements('t1', { at: at('2027-01-09T00:00:00Z'), id: '' }, at('2027-01-10T00:00:00Z')), false, 'بعد الأفق');
});

test('custodyComponents: النافذة مع افتتاحٍ مغلق تحفظ معادلة C4b (ops − المكوّنات = 0) لسيناريوهات الطيّ العشوائي', () => {
  for (let seed = 300; seed < 340; seed++) {
    const s = genScenario(seed, 2);
    const stored = storedFor(s, null);
    const w = windowedInputs(s, stored, derivedOpeningLedger(s, stored))!;
    const c = custodyComponents(w)[REP];
    const full = custodyComponents(fullInputs(s, stored))[REP];
    assert.equal(custodyC4bGap(c, full.opsOutstanding), custodyC4bGap(full, full.opsOutstanding), `seed ${seed}`);
  }
});
