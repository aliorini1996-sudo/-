// «ربط الدفاتر» L2 (P1) — أداء المعاينة (العقد §17 P1 البند 5): 20,000 فاتورة + 8,000 سند + 1,000 استلام على القاعدة المزيّفة
// بالوحدات الحقيقية كلها ⇒ ≤ 90 ثانية، والتراجع بسجلّ تراجع (لا نسخ حالة)، وصفر كتابات، ولا قراءة N+1 لعهدة المندوب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIX_DB_NOW, FakeDb, TenantFixture, previewOptionsFor } from './linking-fake-db';

const TID = 't1';
const READY = fs.existsSync(path.join(__dirname, '..', 'services', 'gl', 'linking', 'parity.ts'));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** سنة تشغيل كبيرة: شهر قبل البدء (افتتاح) والباقي في السنة، ومخزون مستودع وسيارات، وفواتير ثلاثة أنواع، وسندات ثلاث طرق، واستلامات مناديب */
function bigTenant(): FakeDb {
  const db = new FakeDb({ now: () => FIX_DB_NOW });
  const f = new TenantFixture(db);
  const rnd = mulberry32(2027);
  f.tenant({ accountingSuiteEnabled: true, warehouseEnabled: true });
  f.company();
  const customers = Array.from({ length: 400 }, (_, i) => f.customer(`عميل ${i}`));
  const reps = Array.from({ length: 20 }, (_, i) => f.rep(`مندوب ${i}`));
  const products = Array.from({ length: 50 }, (_, i) => f.product(`صنف ${i}`));
  const start = new Date('2026-12-01T06:00:00Z').getTime();
  const end = new Date('2027-06-14T18:00:00Z').getTime();
  const when = (i: number, n: number) => new Date(start + Math.floor(((end - start) * i) / n) + Math.floor(rnd() * 60_000));
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  for (let i = 0; i < 200; i++) {
    f.warehouse({ items: [{ productId: pick(products), qty: 100 + Math.floor(rnd() * 400), unitCost: Math.round((2 + rnd() * 20) * 100) / 100 }], at: when(i, 200) });
  }
  for (let i = 0; i < 500; i++) {
    f.vanLoad({ repId: pick(reps), items: [{ productId: pick(products), qty: 10 + Math.floor(rnd() * 50) }], at: when(i, 500) });
  }
  for (let i = 0; i < 20_000; i++) {
    const r = rnd();
    const type = r < 0.6 ? 'CREDIT' : r < 0.9 ? 'CASH' : 'RETURN';
    f.invoice({
      type, customerId: pick(customers), repId: pick(reps), at: when(i, 20_000),
      lines: [{ productId: pick(products), qty: 1 + Math.floor(rnd() * 5), unitPrice: Math.round((5 + rnd() * 50) * 100) / 100 }],
    });
  }
  for (let i = 0; i < 8_000; i++) {
    const r = rnd();
    const method = r < 0.7 ? 'CASH' : r < 0.9 ? 'BANK_TRANSFER' : 'ONLINE';
    f.receipt({
      customerId: pick(customers), repId: method === 'CASH' ? pick(reps) : null, amount: Math.round((10 + rnd() * 200) * 100) / 100,
      method, at: when(i, 8_000), invoiceId: method === 'ONLINE' ? 'inv-perf' : undefined,
    });
  }
  for (let i = 0; i < 1_000; i++) f.settlement({ repId: pick(reps), amount: Math.round((5 + rnd() * 40) * 100) / 100, at: when(i, 1_000) });
  return db;
}

test('أداء: 20,000 فاتورة + 8,000 سند + 1,000 استلام ⇒ ≤ 90 ثانية بلا كتابة', { skip: READY ? false : 'بانتظار parity.ts (P4)', timeout: 600_000 }, async () => {
  const mod = await import('../services/gl/linking/preview');
  const deps = mod.defaultPreviewDeps;
  const db = bigTenant();
  const t0 = Date.now();
  const r = await mod.runPreview(db.client as never, TID, previewOptionsFor(), {}, deps);
  const ms = Date.now() - t0;
  const timings = Object.fromEntries(r.timings.map((x) => [x.phase, x.ms]));
  console.log(`preview ${ms}ms`, timings, 'events', r.eta.eventsToPost, 'moves', r.storage.rows.moves);
  assert.ok(ms <= 90_000, `المعاينة ${ms}ms > 90s`);
  assert.equal(db.writeCount(), 0);
  assert.ok(r.eta.eventsToPost > 20_000);
  assert.equal(r.trialBalanceByMonth.totals.debitMilli, r.trialBalanceByMonth.totals.creditMilli);
  // عهدة المندوب: قراءات تشغيلية مذكَّرة لكل مندوب لا لكل استلام (لا N+1 على قاعدة بـ٠٫١ نواة)
  assert.ok(db.readCount('repSettlement.findMany') < 200, `repSettlement.findMany ×${db.readCount('repSettlement.findMany')}`);
});
