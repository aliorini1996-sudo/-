// اختبارات Z5.2 لتزامن السلسلة (z5_plan §3 Z5.2 «chain-concurrency» + نقد الخطة 8) على محاكي المعاملات z5-locksim.ts:
//   • 50 إصداراً متوازياً بأعطال محقونة (توقيع، إنشاء فاتورة، قيود، تصادم ترقيم مع مستند مرحلة أولى) ⇒ ICV متّصلة 1..n، وكل PIH = تجزئة
//     السابق مُعادة الحساب من xmlGz المحفوظ بـverifyStampedXml، ولا فجوة من محاولة فاشلة، والأرقام متصاعدة، واللحظات غير متناقصة.
//   • مع قفل العملية: معاملة واحدة مفتوحة للوحدة في أي لحظة (لا اتصالات تنتظر FOR UPDATE)؛ بدونه: السلسلة سليمة بقفل الصفّ وحده
//     لكن المعاملات تتكدّس منتظرة (ضغط المجمّع الذي يمنعه القفل).
//   • مهلة انتظار القفل ⇒ P2028 ⇒ ZATCA_UNIT_BUSY؛ انتهاء مهلة الحامل أثناء الختم ⇒ إلغاء كامل والكتابات اللاحقة مرفوضة.
//   • KeyedAsyncMutex: FIFO، حصرية، مهلة وطابور، تحرير عند الرمي، ومفاتيح مستقلة.
// لا قاعدة بيانات ولا شبكة. ⚠️ لا يُثبت سلوك مجمّع Postgres الحقيقي — اختبار Postgres الحقيقي مطلوب قبل التفعيل (نقد 8).
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsidToken } from './cert';
import { INITIAL_PIH } from './crypto';
import { gunzipXml } from './documentStore';
import { ZatcaHttpError } from './errors';
import { issuanceHttpError } from './issue';
import { tailInstant } from './issueChain';
import { StampError, verifyStampedXml, type HashSigner } from './stamp';
import { KeyedAsyncMutex } from './unitMutex';
import { createHarness, type Harness } from './__fixtures__/z5-issuance';
import { Z5_TENANT, Z5_UNIT } from './__fixtures__/z5-sources';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function slowSigner(inner: HashSigner, ms: number): HashSigner {
  return { publicKeySpkiDer: inner.publicKeySpkiDer, async signHash(h) { await sleep(ms); return inner.signHash(h); } };
}

/** السلسلة الملتزَمة كاملة: ICV متّصلة، PIH = تجزئة السابق المعاد حسابها من البايتات، والوحدة عند آخر حلقة. */
function assertContiguousChain(hs: Harness, expectedCount: number) {
  const cert = parseCsidToken(hs.keys.token);
  const docs = [...hs.sim.documents.values()].sort((a, b) => a.icv - b.icv);
  assert.equal(docs.length, expectedCount);
  let prevHash = INITIAL_PIH;
  let prevAt = 0;
  let prevNumber = '';
  const invoicesById = new Map([...hs.sim.invoices.values()].map(i => [i.id, i]));
  docs.forEach((d, i) => {
    assert.equal(d.icv, i + 1, 'ICV متّصلة بلا فجوة');
    assert.equal(d.pih, prevHash, `PIH للحلقة ${d.icv}`);
    const kind = d.typeName.startsWith('01') ? 'standard' : 'simplified';
    const v = verifyStampedXml(gunzipXml(d.xmlGz), cert, kind, { invoiceHash: d.invoiceHash, qr: d.qr });
    assert.equal(v.invoiceHash, d.invoiceHash, 'التجزئة مُعادة الحساب من xmlGz');
    const xml = gunzipXml(d.xmlGz);
    assert.ok(xml.includes(`<cbc:UUID>${d.icv}</cbc:UUID>`), 'ICV داخل الـXML');
    assert.ok(xml.includes(`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${d.pih}</cbc:EmbeddedDocumentBinaryObject>`), 'PIH داخل الـXML');
    const at = tailInstant(d).getTime();
    assert.ok(at >= prevAt, `IssueTime غير متناقص عند ${d.icv}`);
    const inv = invoicesById.get(d.invoiceId)!;
    assert.ok(inv, 'المستند مرتبط بفاتورة ملتزَمة');
    assert.ok(inv.number > prevNumber, `الرقم متصاعد مع ICV (${inv.number})`);
    assert.equal(d.keyVersion, hs.sim.units.get(Z5_UNIT)!.keyVersion);
    prevHash = d.invoiceHash;
    prevAt = at;
    prevNumber = inv.number;
  });
  const unit = hs.sim.units.get(Z5_UNIT)!;
  assert.equal(unit.lastIcv, expectedCount);
  assert.equal(unit.lastInvoiceHash, expectedCount ? prevHash : null);
  assert.equal(new Set(docs.map(d => d.uuid)).size, docs.length, 'UUID فريدة');
  assert.equal(hs.sim.isLocked(Z5_UNIT), false);
}

test('50 إصداراً متوازياً مع قفل العملية وأعطال محقونة: سلسلة متّصلة تُتحقَّق من البايتات، معاملة واحدة مفتوحة في كل لحظة، ولا فجوة', async () => {
  const hs = createHarness({ stepMs: 250 });
  const mutex = new KeyedAsyncMutex({ waitTimeoutMs: 120_000, maxWaiters: 100 });
  const signing = await hs.signing();
  const base = hs.hooks();
  const N = 50;
  const plan = Array.from({ length: N }, (_, i) => (i % 10 === 3 ? 'signer' : i % 10 === 5 ? 'invoice' : i % 10 === 8 ? 'ledger' : i % 13 === 6 ? 'collision' : 'ok'));
  const results = await Promise.allSettled(plan.map(async (kind, i) => {
    let collided = false;
    const prepared = hs.prepare();
    return hs.issue({
      prepared, mutex,
      signing: kind === 'signer' ? { ...signing, signer: { publicKeySpkiDer: signing.signer.publicKeySpkiDer, signHash: async () => { throw new StampError('SIGNER', `kms-${i}`); } } } : signing,
      hooks: {
        async allocateNumber(tx, at) {
          const n = await base.allocateNumber(tx, at);
          if (kind === 'collision' && !collided) { collided = true; hs.sim.commitInvoiceDirect({ tenantId: Z5_TENANT, number: n }); }
          return n;
        },
        async createInvoice(tx, rec) {
          if (kind === 'invoice') throw new Error(`db-${i}`);
          return base.createInvoice(tx, rec);
        },
        async afterDocument(tx, s) {
          await base.afterDocument!(tx, s);
          if (kind === 'ledger') throw new Error(`ledger-${i}`);
        },
      },
    });
  }));
  const ok = results.filter(r => r.status === 'fulfilled');
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const expectedFail = plan.filter(k => k === 'signer' || k === 'invoice' || k === 'ledger').length;
  assert.equal(failed.length, expectedFail);
  assert.equal(ok.length, N - expectedFail);
  for (const f of failed) {
    const http = issuanceHttpError(f.reason);
    if (f.reason instanceof StampError) assert.equal(http?.code, 'ZATCA_UNIT_UNAVAILABLE');
    else assert.equal(http, null, 'خطأ غير فوترة يمضي لمعالج الأخطاء العام');
  }
  assertContiguousChain(hs, ok.length);
  assert.equal(hs.sim.ledger.length, ok.length);
  assert.equal(hs.sim.stats.maxOpenTx, 1, 'قفل العملية: معاملة واحدة مفتوحة للوحدة');
  assert.equal(hs.sim.stats.maxBlockedOnLock, 0, 'لا معاملة تنتظر FOR UPDATE');
  assert.equal(mutex.activeKeys, 0);
  const collisions = plan.filter(k => k === 'collision').length;
  assert.ok(collisions > 0);
  assert.equal(hs.sim.invoices.size, ok.length + collisions, 'فواتير المرحلة الأولى المتصادمة باقية وفواتير الإصدار = الناجح');
  const icvs = (ok as PromiseFulfilledResult<Awaited<ReturnType<Harness['issue']>>>[]).map(r => r.value.icv).sort((a, b) => a - b);
  assert.deepEqual(icvs, Array.from({ length: ok.length }, (_, i) => i + 1));
});

test('بلا قفل العملية: قفل الصفّ وحده يحفظ السلسلة، لكن المعاملات تتكدّس منتظرة FOR UPDATE (الضغط الذي يمنعه القفل — نقد 8)', async () => {
  const hs = createHarness({ stepMs: 100 });
  const signing = await hs.signing();
  const N = 30;
  const results = await Promise.all(Array.from({ length: N }, () => hs.issue({ signing, mutex: null })));
  assertContiguousChain(hs, N);
  assert.deepEqual(results.map(r => r.icv).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1));
  assert.ok(hs.sim.stats.maxOpenTx > 1, `معاملات مفتوحة معاً: ${hs.sim.stats.maxOpenTx}`);
  assert.ok(hs.sim.stats.maxBlockedOnLock > 1, `منتظرو القفل: ${hs.sim.stats.maxBlockedOnLock}`);
});

test('مهلة معاملة المنتظر على القفل ⇒ P2028 ⇒ ZATCA_UNIT_BUSY بلا أثر؛ الحامل يلتزم والتالي يكمل السلسلة', async () => {
  const hs = createHarness();
  const signing = await hs.signing();
  const holder = hs.issue({ signing: { ...signing, signer: slowSigner(signing.signer, 250) }, mutex: null });
  while (!hs.sim.isLocked(Z5_UNIT)) await sleep(2);
  const waiter = hs.issue({ signing, mutex: null, timeoutMs: 60 });
  const http = await (async () => { try { await waiter; } catch (e) { return issuanceHttpError(e); } return null; })();
  assert.equal(http?.code, 'ZATCA_UNIT_BUSY');
  assert.equal(http?.status, 503);
  assert.equal(http?.alert, false);
  const r1 = await holder;
  assert.equal(r1.icv, 1);
  assert.equal(hs.sim.stats.timeouts, 1);
  const r2 = await hs.issue({ signing, mutex: null });
  assert.equal(r2.icv, 2);
  assert.equal(r2.pih, r1.invoiceHash);
  assertContiguousChain(hs, 2);
});

test('انتهاء مهلة الحامل أثناء التوقيع ⇒ إلغاء كامل وتحرير القفل، وكتاباته المتأخرة مرفوضة (P2028)، والإصدار التالي يأخذ ICV 1', async () => {
  const hs = createHarness();
  const signing = await hs.signing();
  const slow = slowSigner(signing.signer, 200);
  let lateError: unknown = null;
  const base = hs.hooks();
  const p = hs.issue({
    signing: { ...signing, signer: slow }, mutex: null, timeoutMs: 50,
    hooks: { async createInvoice(tx, rec) { try { return await base.createInvoice(tx, rec); } catch (e) { lateError = e; throw e; } } },
  });
  const http = await (async () => { try { await p; } catch (e) { return issuanceHttpError(e); } return null; })();
  assert.equal(http?.code, 'ZATCA_UNIT_BUSY');
  assert.equal(hs.sim.isLocked(Z5_UNIT), false, 'القفل محرَّر فور انتهاء المهلة');
  await sleep(300);
  assert.equal((lateError as { code?: string } | null)?.code, 'P2028', 'الكتابة بعد المهلة رُفضت');
  assert.equal(hs.sim.documents.size + hs.sim.invoices.size + hs.sim.ledger.length, 0);
  assert.equal(hs.sim.units.get(Z5_UNIT)!.lastIcv, 0);
  const r = await hs.issue({ signing, mutex: null });
  assert.equal(r.icv, 1);
  assert.equal(r.pih, INITIAL_PIH);
});

// ─── KeyedAsyncMutex ───

test('KeyedAsyncMutex: حصرية وFIFO لكل مفتاح، ومفاتيح مختلفة متوازية، وتحرير عند الرمي، ولا بقايا بعد الفراغ', async () => {
  const m = new KeyedAsyncMutex({ waitTimeoutMs: 5_000 });
  const events: string[] = [];
  let inside = 0;
  let maxInside = 0;
  const task = (key: string, id: number, ms: number, fail = false) => m.runExclusive(key, async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    events.push(`in:${key}${id}`);
    await sleep(ms);
    events.push(`out:${key}${id}`);
    inside--;
    if (fail) throw new Error(`fail-${id}`);
    return id;
  });
  const a = [task('u1', 1, 20), task('u1', 2, 5, true), task('u1', 3, 5), task('u1', 4, 1)];
  const b = task('u2', 9, 10);
  const settled = await Promise.allSettled([...a, b]);
  assert.equal(settled[1].status, 'rejected');
  assert.deepEqual(settled.filter(s => s.status === 'fulfilled').map(s => (s as PromiseFulfilledResult<number>).value), [1, 3, 4, 9]);
  const u1 = events.filter(e => e.includes('u1'));
  assert.deepEqual(u1, ['in:u11', 'out:u11', 'in:u12', 'out:u12', 'in:u13', 'out:u13', 'in:u14', 'out:u14'], 'FIFO وحصرية لكل مفتاح');
  assert.ok(events.indexOf('in:u29') < events.indexOf('out:u11'), 'المفتاح الآخر لا ينتظر');
  assert.equal(maxInside, 2);
  assert.equal(m.activeKeys, 0);
  assert.equal(m.isHeld('u1'), false);
  await assert.rejects(m.runExclusive('', async () => 1), TypeError);
});

test('KeyedAsyncMutex: مهلة الانتظار ⇒ ZATCA_UNIT_BUSY (WAIT_TIMEOUT) ويبقى الطابور سليماً؛ طابور ممتلئ ⇒ QUEUE_FULL فوراً', async () => {
  const m = new KeyedAsyncMutex({ waitTimeoutMs: 30, maxWaiters: 2 });
  const order: number[] = [];
  const holder = m.runExclusive('u', async () => { await sleep(80); order.push(0); });
  const timedOut = m.runExclusive('u', async () => { order.push(1); });
  const patient = m.runExclusive('u', async () => { order.push(2); }, { waitTimeoutMs: 1_000 });
  const full = m.runExclusive('u', async () => { order.push(3); });
  const fullErr = await full.then(() => null, e => e);
  assert.ok(fullErr instanceof ZatcaHttpError);
  assert.equal(fullErr.code, 'ZATCA_UNIT_BUSY');
  assert.equal(fullErr.logDetail?.code, 'QUEUE_FULL');
  const toErr = await timedOut.then(() => null, e => e);
  assert.ok(toErr instanceof ZatcaHttpError);
  assert.equal(toErr.logDetail?.code, 'WAIT_TIMEOUT');
  assert.equal(toErr.status, 503);
  assert.equal(toErr.messageAr, 'النظام مشغول بإصدار فاتورة أخرى — أعد المحاولة');
  await holder;
  await patient;
  assert.deepEqual(order, [0, 2], 'المنتظر الصبور يأخذ القفل بعد الحامل، والمنتهي لا يُنفَّذ');
  assert.equal(m.activeKeys, 0);
  assert.equal(m.waiting('u'), 0);
});
