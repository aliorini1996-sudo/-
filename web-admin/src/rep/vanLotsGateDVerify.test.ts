// «تتبّع اللوط» — البوابة D (تحقّقٌ عدائي): خاصيّة الخطة دون اتصال على سلالٍ عشوائية (البند 7)، والجار المنسيّ للبند 9
// (التحميل من «مخزون سيارتي» يطلب جلباً لاحقاً كالمزامنة والإصدار).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './vanLots';
import type { OutboxDoc } from './offlineDb';
import { LOT_EPS, roundLot, type VanLotSnapshotDto } from '../lib/lots';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const TODAY = '2026-11-10';
const ME = 'rep-1';

// مولّدٌ حتمي (mulberry32) — الحالات نفسها في كل تشغيل
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('7 (خاصيّة): الخطة المقبولة لا تتجاوز باقي أي تشغيلة بعد المعلّق، ولا تمنع سلّةً يسعها المتاح — ولو كان المعلّق لا تسعه اللقطة', () => {
  const r = rng(20261110);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  let accepted = 0, overflowCases = 0;
  for (let n = 0; n < 3000; n++) {
    const ids = ['A', 'B', 'C'].slice(0, int(1, 3));
    const lots = ids.map((id, i) => ({
      lotId: id, lotNumber: id, expiryDate: `2027-0${i + 1}-01`, status: 'ACTIVE' as const, blockKind: null, usable: int(0, 30),
    }));
    const unknownUsable = r() < 0.4 ? int(0, 10) : 0;
    const allowUnknown = r() < 0.5;
    const snap: VanLotSnapshotDto = {
      serverTime: '2026-11-10T08:00:01.000Z', day: TODAY, tracked: ['P'], allowUnknown,
      products: [{
        productId: 'P', available: 0, availableNamed: 0, unknownUsable, quarantined: 0, held: 0, expiredUnsold: 0, expiredReturned: 0, damaged: 0, lots,
      }],
    };
    // معلّقٌ بتلميحٍ قد لا تسعه اللقطة (فاتورةٌ مصفوفة/موسومة)، أو بلا تلميح
    const outbox: OutboxDoc[] = [];
    if (r() < 0.8) {
      const lotId = ids[int(0, ids.length - 1)];
      const q = int(1, 25);
      const pool = lots.find((l) => l.lotId === lotId)!.usable;
      if (q > pool) overflowCases++;
      outbox.push({
        clientRef: `d${n}`, repId: ME, kind: 'invoice', status: 'queued', clientCreatedAt: '2026-11-10T07:00:00.000Z', reviewCode: 'LOT_REPLAY_HELD',
        payload: { type: 'CASH', items: [{ productId: 'P', qty: q, ...(r() < 0.8 ? { lots: [{ lotId, qty: q }] } : {}) }] },
      });
    }
    const pending = V.pendingOut(outbox, [], Date.parse('2026-11-10T08:00:00.000Z'), ME);
    const lines = Array.from({ length: int(1, 3) }, () => {
      const F = [1, 1, 6, 12][int(0, 3)];
      return { productId: 'P', qty: F > 1 ? int(1, 3) : int(1, 15), unitFactor: F, tracked: true };
    });
    const view = V.localLotView(snap, 'P', TODAY, pending);
    const total = V.cartBaseOf(lines, 'P');
    const plan = V.offlineLotPlan(snap, lines, TODAY, pending);
    if (total <= view.available + LOT_EPS) {
      assert.equal(plan.ok, true, `#${n}: سلّةٌ يسعها المتاح (${total} ≤ ${view.available}) مُنعت: ${JSON.stringify(plan)}`);
    } else {
      assert.equal(plan.ok, false, `#${n}`);
      continue;
    }
    if (!plan.ok) continue;
    accepted++;
    const left = new Map(view.lots.filter((x) => x.sellable).map((x) => [x.lot.lotId as string | null, x.left]));
    left.set(null, allowUnknown ? view.unknownLeft : 0);
    const sums = new Map<string | null, number>();
    plan.hints.forEach((h, i) => {
      const rows = h ?? [];
      const base = lines[i].qty * lines[i].unitFactor;
      assert.ok(Math.abs(rows.reduce((s, x) => s + x.qty, 0) - base) <= LOT_EPS, `#${n}: مجموع تلميح السطر ${i} ≠ كميته`);
      for (const x of rows) sums.set(x.lotId, roundLot((sums.get(x.lotId) ?? 0) + x.qty));
    });
    for (const [k, q] of sums) {
      assert.ok(q <= (left.get(k) ?? 0) + LOT_EPS,
        `#${n}: ${k ?? '∅'} = ${q} فوق باقيه ${left.get(k) ?? 0} — يرفض الخادم التلميح فتفترق الورقة عن السجل (${JSON.stringify(plan.hints)})`);
    }
  }
  assert.ok(accepted > 500 && overflowCases > 300, `تغطية: مقبولة ${accepted}، معلّقٌ لا تسعه اللقطة ${overflowCases}`);
});

test('9 (جار): تحميلٌ سجّله المندوب من «مخزون سيارتي» يطلب جلب اللقطة لاحقاً (fresh) لا يُدمج في جلب فتح الشاشة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  const fn = app.slice(app.indexOf('function RepVanStock('), app.indexOf('const reloadProducts = async ()'));
  assert.match(fn, /const loadStock = useCallback\(async \(afterLoad = false\) => \{/);
  assert.match(fn, /if \(lotsRef\.current\?\.on\) void lotsRef\.current\.refresh\(0, afterLoad\);/, 'الميزة مطفأة: لا جلب كما كان');
  assert.match(fn, /useEffect\(\(\) => \{ loadStock\(\); \}, \[loadStock\]\);/, 'فتح الشاشة: طلبٌ عادي يشارك الجاري');
  const post = app.indexOf("await repApi.post('/van-stock/loads'");
  assert.ok(post > 0);
  assert.match(app.slice(post, post + 300), /setView\('list'\); loadStock\(true\);/);
});
