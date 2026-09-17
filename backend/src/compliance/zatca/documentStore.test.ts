// اختبارات Z5.0 لمخزن المستندات (documentStore.ts): عقد مخزن الذاكرة (الإدراج والقيود الفريدة بشكل P2002، المطالبة بالعقد
// والرمز، المطالبة الجماعية العادلة ومرشّح حالة الوحدة، تسييج النتيجة برمز المطالبة، المرآة لصفوف المرحلة الثانية وحدها، تقدّم
// السلسلة بـCAS)، وضغط البايتات ذهاباً وإياباً وحدوده، والإسقاط بلا بايتات أبداً — وفحص نصّي لمحوّل Prisma دون تنفيذه.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import {
  DocumentBytesError, MAX_DOCUMENT_XML_BYTES, PROJECTION_KEYS, gunzipXml, gzipXml, memoryZatcaDocumentStore, type SignedDocumentInput,
} from './documentStore';
import { toZatcaHttpError } from './errors';
import { transitionForOutcome } from './status';

const T0 = new Date('2026-12-01T09:00:00.000Z');
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Invoice>فاتورة ضريبية مبسطة — ١٢٣</Invoice>\n';

function harness() {
  let now = T0.getTime();
  const store = memoryZatcaDocumentStore({ now: () => new Date(now) });
  const advance = (ms: number) => { now += ms; };
  store.units.set('u1', { id: 'u1', tenantId: 't1', status: 'ACTIVE', environment: 'production', keyVersion: 2, vatNumber: '399999999900003', lastIcv: 0, lastInvoiceHash: null, updatedAt: T0 });
  store.units.set('u2', { id: 'u2', tenantId: 't2', status: 'ACTIVE', environment: 'production', keyVersion: 1, vatNumber: '311111111111113', lastIcv: 0, lastInvoiceHash: null, updatedAt: T0 });
  return { store, advance };
}

let seq = 0;
function doc(over: Partial<SignedDocumentInput> = {}): SignedDocumentInput {
  seq++;
  return {
    tenantId: 't1', egsUnitId: 'u1', invoiceId: `inv-${seq}`, attemptNo: 1, icv: seq, uuid: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    pih: 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==', invoiceHash: `hash-${seq}`, typeCode: '388',
    typeName: '0200000', issueDate: '2026-12-01', issueTime: '12:00:00', xml: XML, qr: `qr-${seq}`, issuedAt: T0, keyVersion: 2, ...over,
  };
}

test('gzip ذهاباً وإياباً: البايتات نفسها حرفياً (عربي وأرقام هندية وBOM داخل النص)، وحدود الفكّ', () => {
  for (const s of [XML, `${String.fromCharCode(0xfeff)}<a/>`, 'x'.repeat(100_000)]) assert.equal(gunzipXml(gzipXml(s)), s);
  assert.ok(gzipXml(XML)[0] === 0x1f && gzipXml(XML)[1] === 0x8b, 'ترويسة gzip');
  assert.throws(() => gzipXml(''), (e: unknown) => e instanceof DocumentBytesError && e.code === 'INPUT');
  assert.throws(() => gunzipXml(Buffer.from('not gzip')), (e: unknown) => e instanceof DocumentBytesError && e.code === 'GZIP_INVALID');
  assert.throws(() => gunzipXml(new Uint8Array()), (e: unknown) => e instanceof DocumentBytesError && e.code === 'INPUT');
  const bomb = zlib.gzipSync(Buffer.alloc(2048, 0x41));
  assert.throws(() => gunzipXml(bomb, 1024), (e: unknown) => e instanceof DocumentBytesError && e.code === 'TOO_LARGE');
  assert.throws(() => gunzipXml(zlib.gzipSync(Buffer.from([0xc3, 0x28]))), (e: unknown) => e instanceof DocumentBytesError && e.code === 'UTF8_INVALID');
  assert.ok(MAX_DOCUMENT_XML_BYTES >= 4 * 1024 * 1024);
});

test('الإدراج: SIGNED بتدفّق النوع ومهلته، والقيود الفريدة الثلاثة بشكل P2002 ⇒ ZATCA_CHAIN_CONFLICT', async () => {
  const { store } = harness();
  const b2c = await store.insertSigned(null, doc({ icv: 1 }));
  assert.equal(b2c.flow, 'REPORTING');
  assert.equal(b2c.reportDeadline?.toISOString(), '2026-12-02T09:00:00.000Z');
  const b2b = await store.insertSigned(null, doc({ icv: 2, typeName: '0100000' }));
  assert.equal(b2b.flow, 'CLEARANCE');
  assert.equal(b2b.reportDeadline, null);
  const row = store.documents.get(b2c.id)!;
  assert.equal(row.status, 'SIGNED');
  assert.equal(row.attempts, 0);
  assert.equal(row.keyVersion, 2);
  assert.equal(gunzipXml(row.xmlGz), XML);
  const first = doc({ icv: 3 });
  await store.insertSigned(null, first);
  for (const dup of [doc({ icv: 3 }), doc({ icv: 99, uuid: first.uuid }), doc({ icv: 98, invoiceId: first.invoiceId })]) {
    await assert.rejects(store.insertSigned(null, dup), (e: unknown) => toZatcaHttpError(e)?.code === 'ZATCA_CHAIN_CONFLICT');
  }
  // وحدة أخرى بالرقم نفسه مسموحة
  await store.insertSigned(null, doc({ icv: 3, egsUnitId: 'u2', tenantId: 't2' }));
  for (const bad of [{ typeName: '0300000' }, { typeCode: '380' as never }, { icv: 0 }, { attemptNo: 0 }, { keyVersion: 0 }, { qr: '' }, { issuedAt: new Date('x') }]) {
    await assert.rejects(store.insertSigned(null, doc({ icv: 50 + seq, ...bad })), (e: unknown) => e instanceof DocumentBytesError, JSON.stringify(bad));
  }
});

test('تقدّم السلسلة: CAS على ACTIVE وlastIcv = icv−1 فقط؛ قفل الوحدة يعيد أعمدة السلسلة', async () => {
  const { store } = harness();
  assert.deepEqual(await store.lockUnitForIssuance(null, 'u1'), { id: 'u1', tenantId: 't1', status: 'ACTIVE', environment: 'production', keyVersion: 2, vatNumber: '399999999900003', lastIcv: 0, lastInvoiceHash: null });
  assert.equal(await store.lockUnitForIssuance(null, 'nope'), null);
  const at = new Date(T0.getTime() + 5);
  assert.equal(await store.advanceUnitChain(null, { unitId: 'u1', icv: 2, invoiceHash: 'h2', at }), false, 'قفزة');
  assert.equal(await store.advanceUnitChain(null, { unitId: 'u1', icv: 1, invoiceHash: 'h1', at }), true);
  assert.equal(await store.advanceUnitChain(null, { unitId: 'u1', icv: 1, invoiceHash: 'h1b', at }), false, 'تكرار');
  store.units.get('u1')!.status = 'RENEWING';
  assert.equal(await store.advanceUnitChain(null, { unitId: 'u1', icv: 2, invoiceHash: 'h2', at }), false, 'لا كتابة على وحدة RENEWING');
  const u = store.units.get('u1')!;
  assert.equal(u.lastIcv, 1);
  assert.equal(u.lastInvoiceHash, 'h1');
});

test('المطالبة المفردة: عقد + attempts+1 + firstSubmitAt مرة؛ لا مطالبة مزدوجة؛ الاستيلاء بعد انتهاء العقد', async () => {
  const { store, advance } = harness();
  const { id } = await store.insertSigned(null, doc({ icv: 1 }));
  const c1 = await store.claim(id, { leaseMs: 90_000 });
  assert.ok(c1);
  assert.equal(c1.attempts, 1);
  assert.equal(c1.leaseUntil.toISOString(), '2026-12-01T09:01:30.000Z');
  assert.equal(await store.claim(id, { leaseMs: 90_000 }), null, 'عقد حيّ');
  assert.equal(await store.claim(id, { leaseMs: 90_000, ignoreSchedule: true }), null, 'لا تجاوز للعقد');
  advance(90_001);
  const c2 = await store.claim(id, { leaseMs: 90_000 });
  assert.equal(c2?.attempts, 2);
  assert.equal(store.documents.get(id)!.firstSubmitAt?.toISOString(), T0.toISOString(), 'أول إرسال لا يتغيّر');
  // النتيجة القديمة (رمز المحاولة الأولى) لا تكتب فوق المطالبة الأحدث
  const stale = transitionForOutcome({ kind: 'REJECTED', errors: [], warnings: [] }, { flow: 'REPORTING', attempts: 1, priorEmpty400: 0, priorPayload413: 0, issuedAt: T0, reportDeadline: null, now: T0 });
  assert.equal(await store.applyOutcome(null, { id, attempts: 1 }, { ...stale }), false);
  assert.equal(store.documents.get(id)!.status, 'SUBMITTING');
  const fresh = transitionForOutcome({ kind: 'RETRY', reason: 'empty400' }, { flow: 'REPORTING', attempts: 2, priorEmpty400: 0, priorPayload413: 0, issuedAt: T0, reportDeadline: null, now: T0 });
  assert.equal(await store.applyOutcome(null, { id, attempts: 2 }, { status: fresh.status, nextAttemptAt: fresh.nextAttemptAt, priorEmpty400: fresh.priorEmpty400, httpStatus: 400 }), true);
  const row = store.documents.get(id)!;
  assert.equal(row.status, 'RETRY_WAIT');
  assert.equal(row.leaseUntil, null);
  assert.equal(row.priorEmpty400, 1);
  assert.equal(row.httpStatus, 400);
  assert.equal(await store.applyOutcome(null, { id, attempts: 2 }, { status: 'REPORTED', nextAttemptAt: null }), false, 'مرة واحدة: لم يعد SUBMITTING');
  // موعد لاحق: لا مطالبة إلا بتجاهل الجدولة (محاولة فورية واحدة)
  assert.equal(await store.claim(id, { leaseMs: 90_000 }), null);
  assert.equal((await store.claim(id, { leaseMs: 90_000, ignoreSchedule: true }))?.attempts, 3);
  assert.equal(await store.claim('missing', { leaseMs: 1 }), null);
});

test('المطالبة الجماعية: عادلة بحدّ لكل وحدة بترتيب ICV، الأقرب مهلةً أولاً، وتستبعد وحدات خارج الحالات المسموحة', async () => {
  const { store } = harness();
  store.units.set('u3', { id: 'u3', tenantId: 't3', status: 'AUTH_FAILED', environment: 'production', keyVersion: 1, vatNumber: 'v', lastIcv: 0, lastInvoiceHash: null, updatedAt: T0 });
  store.units.set('u4', { id: 'u4', tenantId: 't4', status: 'RENEWING', environment: 'production', keyVersion: 1, vatNumber: 'v', lastIcv: 0, lastInvoiceHash: null, updatedAt: T0 });
  // وحدة كثيفة (u1: عشر مستندات قديمة) ووحدة خفيفة (u2: واحد بمهلة أقرب)
  for (let i = 1; i <= 10; i++) await store.insertSigned(null, doc({ icv: i, issuedAt: new Date(T0.getTime() + 60_000) }));
  const light = await store.insertSigned(null, doc({ egsUnitId: 'u2', tenantId: 't2', icv: 1, issuedAt: T0 }));
  const auth = await store.insertSigned(null, doc({ egsUnitId: 'u3', tenantId: 't3', icv: 1 }));
  const renewing = await store.insertSigned(null, doc({ egsUnitId: 'u4', tenantId: 't4', icv: 1, typeName: '0100000' }));
  const batch = await store.claimBatch({ limit: 5, perUnit: 3, leaseMs: 90_000 });
  assert.equal(batch[0].id, light.id, 'الأقرب مهلةً أولاً');
  assert.deepEqual(batch.filter(b => b.egsUnitId === 'u1').map(b => b.icv), [1, 2, 3], 'حدّ الوحدة بترتيب ICV');
  assert.ok(!batch.some(b => b.id === auth.id), 'وحدة AUTH_FAILED مستبعدة افتراضياً');
  assert.ok(batch.some(b => b.id === renewing.id), 'RENEWING تُصرَّف (التجديد ينتظرها)');
  assert.equal(batch.length, 5);
  for (const b of batch) assert.equal(store.documents.get(b.id)!.status, 'SUBMITTING');
  // عامل ثانٍ لا يأخذ ما أُخذ
  const second = await store.claimBatch({ limit: 50, perUnit: 50, leaseMs: 90_000 });
  assert.ok(second.every(b => !batch.some(x => x.id === b.id)));
  assert.deepEqual(second.map(b => b.icv), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual((await store.claimBatch({ limit: 5, perUnit: 5, leaseMs: 1, unitStatuses: ['AUTH_FAILED'] })).map(b => b.id), [auth.id]);
  assert.deepEqual(await store.claimBatch({ limit: 0, perUnit: 5, leaseMs: 1 }), []);
});

test('المرآة لصفوف zatcaPhase = 2 وحدها — فاتورة مرحلة أولى أو غائبة لا تُمسّ', async () => {
  const { store } = harness();
  store.invoices.set('p1', { id: 'p1', tenantId: 't1', zatcaPhase: null, einvoiceStatus: 'generated', einvoiceQr: null, einvoiceWarnings: null, einvoiceSubmittedAt: null });
  store.invoices.set('p2', { id: 'p2', tenantId: 't1', zatcaPhase: 2, einvoiceStatus: 'signed', einvoiceQr: 'q', einvoiceWarnings: null, einvoiceSubmittedAt: null });
  const m = { einvoiceStatus: 'reported' as const, einvoiceQr: 'q', einvoiceWarnings: '[]' };
  assert.equal(await store.mirrorInvoice(null, 'p1', m), false);
  assert.equal(store.invoices.get('p1')!.einvoiceStatus, 'generated');
  assert.equal(await store.mirrorInvoice(null, 'missing', m), false);
  assert.equal(await store.mirrorInvoice(null, 'p2', m), true);
  assert.equal(store.invoices.get('p2')!.einvoiceStatus, 'reported');
});

test('الإسقاط: آخر محاولة للفاتورة ضمن الشركة، بمفاتيح ثابتة وبلا أي بايتات XML؛ القراءة الخام وحدها تفكّها', async () => {
  const { store } = harness();
  const first = await store.insertSigned(null, doc({ icv: 1, invoiceId: 'inv-x' }));
  const second = await store.insertSigned(null, doc({ icv: 2, invoiceId: 'inv-x', attemptNo: 2 }));
  const c = await store.claim(second.id, { leaseMs: 1000 });
  await store.applyOutcome(null, { id: second.id, attempts: c!.attempts }, {
    status: 'CLEARED', nextAttemptAt: null, clearedXmlGz: gzipXml('<cleared/>'), clearedQr: 'cq', validation: { status: 'PASS' }, finalizedAt: T0,
  });
  const p = await store.loadProjection('t1', 'inv-x');
  assert.ok(p);
  assert.equal(p.id, second.id);
  assert.equal(p.attemptNo, 2);
  assert.equal(p.environment, 'production');
  assert.deepEqual(Object.keys(p).sort(), [...PROJECTION_KEYS].sort());
  const walk = (v: unknown): void => {
    assert.ok(!(v instanceof Uint8Array), 'بايتات في الإسقاط');
    if (v && typeof v === 'object' && !(v instanceof Date)) for (const [k, x] of Object.entries(v)) { assert.ok(!/xml/i.test(k), k); walk(x); }
  };
  walk(p);
  assert.doesNotMatch(JSON.stringify(p), /H4sI|<Invoice|<cleared/, 'نصّ XML أو gzip base64 في الإسقاط');
  assert.equal(await store.loadProjection('t2', 'inv-x'), null, 'شركة أخرى');
  assert.equal(await store.loadProjection('t1', 'none'), null);
  assert.deepEqual(await store.loadDocumentXml(second.id), { xml: XML, clearedXml: '<cleared/>' });
  assert.deepEqual(await store.loadDocumentXml(first.id), { xml: XML, clearedXml: null });
  assert.equal(await store.loadDocumentXml('none'), null);
});

test('سجل API للمستند: documentId مكتوب، ونسخة معزولة', async () => {
  const { store } = harness();
  const row = { tenantId: 't1', egsUnitId: 'u1', documentId: 'd1', actorId: null, endpoint: 'reporting', httpStatus: 200, outcome: 'ACCEPTED', durationMs: 12, response: { a: 1 }, errorText: null, at: T0 };
  await store.writeApiLog(row);
  row.response.a = 2;
  assert.equal(store.apiLogs[0].documentId, 'd1');
  assert.deepEqual(store.apiLogs[0].response, { a: 1 });
});

// ─── محوّل Prisma (نصّياً) ───

const adapter = fs.readFileSync(path.join(__dirname, 'documentStore.prisma.ts'), 'utf8').replace(/\r\n/g, '\n');
const body = (name: string) => {
  const i = adapter.indexOf(`async ${name}(`);
  assert.ok(i > 0, name);
  const j = adapter.indexOf('\n    async ', i + 10);
  return adapter.slice(i, j > 0 ? j : undefined);
};

test('المحوّل: الإسقاط بلا xmlGz/clearedXmlGz؛ القفل FOR UPDATE؛ الجماعية FOR UPDATE OF d SKIP LOCKED بعدل لكل وحدة؛ عقود بـNOW()', () => {
  const proj = adapter.slice(adapter.indexOf('const PROJECTION_SELECT'), adapter.indexOf('} satisfies Prisma.ZatcaDocumentSelect'));
  assert.doesNotMatch(proj, /xmlGz|clearedXmlGz/);
  for (const k of PROJECTION_KEYS) if (k !== 'environment') assert.match(proj, new RegExp(`\\b${k}: true`), k);
  assert.match(proj, /egsUnit: \{ select: \{ environment: true \} \}/);
  assert.match(body('lockUnitForIssuance'), /FROM zatca_egs_units WHERE id = \$\{unitId\} FOR UPDATE`/);
  assert.doesNotMatch(body('lockUnitForIssuance'), /privateKeyEnc|productionToken|SecretEnc/);
  const adv = body('advanceUnitChain');
  assert.match(adv, /WHERE id = \$\{a\.unitId\} AND status = 'ACTIVE' AND "lastIcv" = \$\{a\.icv - 1\}/);
  assert.match(adv, /"updatedAt" = \$\{a\.at\}/);
  const batch = body('claimBatch');
  assert.match(batch, /FOR UPDATE OF d SKIP LOCKED/);
  assert.match(batch, /row_number\(\) OVER \(PARTITION BY "egsUnitId" ORDER BY icv\)/);
  assert.match(batch, /u\.status = ANY\(\$\{statuses\}::text\[\]\)/);
  assert.match(batch, /ORDER BY d\."reportDeadline" ASC NULLS LAST/);
  for (const n of ['claim', 'claimBatch']) {
    assert.match(body(n), /"leaseUntil" = NOW\(\) \+/, n);
    assert.match(body(n), /attempts = (z\.)?attempts \+ 1/, n);
    assert.match(body(n), /"updatedAt" = NOW\(\)/, n);
  }
});

test('المحوّل: النتيجة مسيَّجة برمز المطالبة، والمرآة لـzatcaPhase: 2 وحدها، والسجل بمعرّف المستند، ولا مرشّح not ولا JSON null', () => {
  assert.match(body('applyOutcome'), /where: \{ id: fence\.id, status: 'SUBMITTING', attempts: fence\.attempts \}/);
  assert.doesNotMatch(body('applyOutcome'), /leaseUntil: \{|leaseUntil: fence/);
  assert.match(body('mirrorInvoice'), /where: \{ id: invoiceId, zatcaPhase: 2 \}/);
  assert.match(body('writeApiLog'), /documentId: row\.documentId/);
  assert.match(body('loadProjection'), /where: \{ tenantId, invoiceId \}, orderBy: \{ attemptNo: 'desc' \}/);
  const code = adapter.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\{\s*not\s*:/);
  assert.doesNotMatch(adapter, /JsonNull|DbNull/);
  assert.match(adapter, /^import type \{ Prisma, PrismaClient \} from '@prisma\/client';$/m);
});
