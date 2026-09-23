// اختبارات Z5.2 لتركيب الإصدار داخل المعاملة (issueTx.ts) وفتح مفتاح الوحدة (issueSigner.ts) وتخصيص السلسلة (issueChain.ts) ومحوّل
// Prisma (issueStore.prisma.ts، فحص نصّي): المسار السعيد للمبسّطة والقياسية بترتيب العمليات (القيود بعد المستند — نقد 38)، مطابقة بايتات
// عيّنة Z1 ومسار Z2 المباشر، الذهبي بمفتاح الـSDK وشهادته (يتخطّى عند الغياب)، الإلغاء عند رمي أي خطوة (لا ICV ولا فاتورة ولا مستند)،
// keyVersion والحارس، التصنيف والإعادة لـP2002، ساعة متأخرة، انحراف المبالغ، وقاعدة التوريد داخل القفل. لا قاعدة بيانات ولا شبكة.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { computeInvoiceHash } from './c14n';
import { parseCsidCertificate, parseCsidToken } from './cert';
import { INITIAL_PIH } from './crypto';
import { gunzipXml } from './documentStore';
import { ZatcaHttpError } from './errors';
import { issuanceHttpError, prepareIssuance, classifyIssuanceUniqueViolation, type PreparedIssuance } from './issue';
import { MAX_ICV, issuedAtAfter, nextChainSlot, tailInstant, type ChainHead } from './issueChain';
import { openIssuanceSigning } from './issueSigner';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prismaZatcaDocumentStore } from './documentStore.prisma';
import { prismaIssuanceStore } from './issueStore.prisma';
import { runIssuance, type StampInTxDeps, type StampInTxHooks } from './issueTx';
import { mapInvoiceToUbl } from './mapInvoice';
import { decodeQr } from './qr';
import { createKeyring } from './secrets';
import { SecretsError } from './secrets';
import { StampError, createServerSigner, stampDocument, unstampedForm, verifyStampedXml, type HashSigner } from './stamp';
import { reportDeadlineFor } from './status';
import { riyadhParts, riyadhDateTime } from './time';
import { SIMPLIFIED_INVOICE, chainFor } from './__fixtures__/z1-sources';
import { SDK_SKIP, sdkCertB64, sdkPrivateKeyB64 } from './__fixtures__/z2-sdk';
import { T_ISSUE, createHarness, newUnitKeys, unitRow, type Harness } from './__fixtures__/z5-issuance';
import {
  COMPANY_VAT, CUSTOMERS, PRODUCTS, REQ_SIMPLIFIED_Z1, REQ_STANDARD_Z1, Z1_ISSUED_AT, Z5_TENANT, Z5_UNIT, Z5_VAT, engineOf, sellerSettings,
} from './__fixtures__/z5-sources';

const fixtureXml = (name: string) => fs.readFileSync(path.join(__dirname, '__fixtures__', 'z1', `${name}.xml`), 'utf8').replace(/\r\n/g, '\n');

async function rejectsHttp(p: Promise<unknown>, code: string, extra: { reason?: string; logCode?: string } = {}): Promise<ZatcaHttpError> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  assert.ok(caught !== undefined, `لم يُرمَ ${code}`);
  const http = issuanceHttpError(caught);
  assert.ok(http, `غير مصنَّف: ${String(caught)}`);
  assert.equal(http!.code, code, `${String(caught)}`);
  if (extra.reason !== undefined) assert.equal(http!.reason, extra.reason);
  if (extra.logCode !== undefined) assert.equal(http!.logDetail?.code, extra.logCode);
  return http!;
}

function stateOf(hs: Harness) {
  const u = hs.sim.units.get(Z5_UNIT)!;
  return {
    lastIcv: u.lastIcv, lastInvoiceHash: u.lastInvoiceHash, keyVersion: u.keyVersion,
    documents: [...hs.sim.documents.values()].map(d => d.icv).sort((a, b) => a - b),
    invoices: [...hs.sim.invoices.values()].map(i => i.number).sort(),
    ledger: hs.sim.ledger.length,
    locked: hs.sim.isLocked(Z5_UNIT),
  };
}

function throwingSigner(inner: HashSigner, err: unknown = new StampError('SIGNER', 'KMS down')): HashSigner {
  return { publicKeySpkiDer: inner.publicKeySpkiDer, async signHash() { throw err; } };
}

// ─── فتح المفتاح والشهادة ───

test('openIssuanceSigning: الصفّ العام ثم الاعتماد، مفتاح وشهادة متطابقان ساريان — ولا تخزين مؤقت (كل طلب يفكّ من جديد)', async () => {
  const hs = createHarness();
  const a = await hs.signing();
  const b = await hs.signing();
  assert.equal(a.keyVersion, 1);
  assert.equal(a.environment, 'production');
  assert.equal(a.vatNumber, Z5_VAT);
  assert.deepEqual(Buffer.from(a.signer.publicKeySpkiDer!), Buffer.from(a.cert.spkiDer));
  assert.notEqual(a.signer, b.signer, 'موقِّع جديد لكل طلب');
  assert.equal(hs.units.credentialReads, 2);
  assert.equal(a.cert.certB64, parseCsidToken(hs.keys.token).certB64);
  const json = JSON.stringify(a);
  assert.doesNotMatch(json, /PRIVATE|privateKeyEnc/);
});

test('openIssuanceSigning: الأعطال مصنّفة — أسرار ⇒ SECRETS، رمز/مفتاح/شهادة ⇒ UNIT_CONFIG (تنبيه)، حالة ⇒ سببها، منتهية ⇒ EXPIRED، نسخة ⇒ BUSY', async () => {
  const hs = createHarness();
  const row = hs.units.units.get(Z5_UNIT)!;
  const ref = { id: Z5_UNIT, tenantId: Z5_TENANT, keyVersion: 1, vatNumber: Z5_VAT };
  const open = (over: Partial<Parameters<typeof openIssuanceSigning>[0]> = {}, r = ref) => openIssuanceSigning({ store: hs.units, keyring: hs.keyring, now: T_ISSUE, ...over }, r);
  const expect = async (p: Promise<unknown>, code: string, reason?: string, alert?: boolean) => {
    const e = await rejectsHttp(p, code, { reason });
    if (alert !== undefined) assert.equal(e.alert, alert, `${code}/${reason}`);
  };
  await expect(open({ keyring: () => { throw new SecretsError('KEY_MISSING', 'x'); } }), 'ZATCA_UNIT_UNAVAILABLE', 'SECRETS', true);
  await expect(open({ keyring: createKeyring({ current: crypto.randomBytes(32) }) }), 'ZATCA_UNIT_UNAVAILABLE', 'SECRETS', true);
  await expect(open({}, { ...ref, tenantId: 'other' }), 'ZATCA_UNIT_UNAVAILABLE', 'NO_ACTIVE_UNIT');
  await expect(open({}, { ...ref, id: 'nope' }), 'ZATCA_UNIT_UNAVAILABLE', 'NO_ACTIVE_UNIT');
  await expect(open({}, { ...ref, keyVersion: 2 }), 'ZATCA_UNIT_BUSY');
  await expect(open({}, { ...ref, vatNumber: '300000000000003' }), 'ZATCA_UNIT_UNAVAILABLE', 'SELLER_VAT_CHANGED');
  for (const [status, reason, alert] of [['RENEWING', 'RENEWING', false], ['AUTH_FAILED', 'AUTH_FAILED', true], ['REVOKED', 'NO_ACTIVE_UNIT', false], ['EXPIRED', 'EXPIRED', false]] as const) {
    row.status = status;
    await expect(open(), 'ZATCA_UNIT_UNAVAILABLE', reason, alert);
  }
  row.status = 'ACTIVE';
  await expect(open({ now: new Date('2031-01-01T00:00:00Z') }), 'ZATCA_UNIT_UNAVAILABLE', 'EXPIRED');
  await expect(open({ now: new Date('2025-12-31T23:59:59Z') }), 'ZATCA_UNIT_UNAVAILABLE', 'EXPIRED');
  const token = row.productionToken;
  row.productionToken = null;
  await expect(open(), 'ZATCA_UNIT_UNAVAILABLE', 'UNIT_CONFIG', true);
  row.productionToken = 'not-a-token!!';
  await expect(open(), 'ZATCA_UNIT_UNAVAILABLE', 'UNIT_CONFIG', true);
  // شهادة لمفتاح آخر ⇒ UNIT_CONFIG؛ وإن تغيّرت نسخة المفتاح بين القراءتين ⇒ BUSY (سباق تجديد)
  row.productionToken = newUnitKeys().token;
  await expect(open(), 'ZATCA_UNIT_UNAVAILABLE', 'UNIT_CONFIG', true);
  let reads = 0;
  const racing = { loadUnit: async (id: string) => { const r = await hs.units.loadUnit(id); reads++; return r && reads > 1 ? { ...r, keyVersion: 2 } : r; }, loadUnitCredentials: (id: string) => hs.units.loadUnitCredentials(id) };
  await expect(open({ store: racing }), 'ZATCA_UNIT_BUSY');
  row.productionToken = token;
  const enc = row.privateKeyEnc;
  row.privateKeyEnc = null;
  await expect(open(), 'ZATCA_UNIT_UNAVAILABLE', 'UNIT_CONFIG');
  // مفتاح عام مخزَّن لا يطابق المفتاح المفكوك ⇒ UNIT_CONFIG
  row.privateKeyEnc = enc;
  const pem = row.publicKeyPem;
  row.publicKeyPem = newUnitKeys().publicKeyPem;
  await expect(open(), 'ZATCA_UNIT_UNAVAILABLE', 'UNIT_CONFIG', true);
  row.publicKeyPem = pem;
  assert.equal((await open()).keyVersion, 1);
});

// ─── المسار السعيد ───

test('مبسّطة: ترتيب العمليات قفل ⇒ رقم ⇒ فاتورة ⇒ مستند ⇒ تقدّم ⇒ قيود؛ SIGNED بتدفّق الإبلاغ ومهلة 24 ساعة، والبايتات المحفوظة تتحقق، والسلسلة تتقدّم', async () => {
  const hs = createHarness();
  const r1 = await hs.issue();
  assert.deepEqual(hs.log, ['lock', 'number', 'invoice', 'insertSigned', 'advance', 'ledger']);
  assert.equal(r1.icv, 1);
  assert.equal(r1.pih, INITIAL_PIH);
  assert.equal(r1.number, 'INV-2612-000001');
  assert.equal(r1.subtype, '02');
  assert.equal(r1.flow, 'REPORTING');
  assert.equal(r1.keyVersion, 1);
  assert.deepEqual(r1.reportDeadline, reportDeadlineFor('REPORTING', r1.issuedAt));
  assert.deepEqual(riyadhParts(r1.issuedAt), { date: r1.issueDate, time: r1.issueTime });
  const doc = [...hs.sim.documents.values()][0];
  assert.equal(doc.status, 'SIGNED');
  assert.equal(doc.keyVersion, 1);
  assert.equal(doc.invoiceId, r1.invoiceId);
  const xml = gunzipXml(doc.xmlGz);
  const cert = parseCsidToken(hs.keys.token);
  const v = verifyStampedXml(xml, cert, 'simplified', { invoiceHash: r1.invoiceHash, qr: r1.qr });
  assert.equal(v.signingTime, riyadhDateTime(r1.issuedAt), 'SigningTime = لحظة الإصدار');
  assert.equal(computeInvoiceHash(xml), r1.invoiceHash);
  assert.ok(decodeQr(r1.qr).certSignatureDer, 'الوسم 9 للمبسّطة');
  const rec = hs.records[0];
  assert.equal(rec.mirror.einvoiceStatus, 'signed');
  assert.equal(rec.mirror.einvoiceQr, r1.qr);
  assert.equal(rec.mirror.einvoiceIcv, 1);
  assert.equal(rec.mirror.einvoiceHash, r1.invoiceHash);
  assert.equal(rec.snapshot.totals.payableRounding, '0.01');
  assert.equal(rec.amounts.total, 41.05);
  assert.deepEqual(stateOf(hs), { lastIcv: 1, lastInvoiceHash: r1.invoiceHash, keyVersion: 1, documents: [1], invoices: ['INV-2612-000001'], ledger: 1, locked: false });

  const r2 = await hs.issue();
  assert.equal(r2.icv, 2);
  assert.equal(r2.pih, r1.invoiceHash);
  assert.equal(r2.number, 'INV-2612-000002');
  assert.ok(r2.issuedAt.getTime() >= r1.issuedAt.getTime());
  assert.notEqual(r2.uuid, r1.uuid);
  const x2 = gunzipXml([...hs.sim.documents.values()].find(d => d.icv === 2)!.xmlGz);
  assert.ok(x2.includes(`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${r1.invoiceHash}</cbc:EmbeddedDocumentBinaryObject>`), 'PIH في الـXML');
});

test('قياسية: تدفّق الاعتماد بلا مهلة، المرآة clearance_pending بلا QR، QR بلا الوسم 9، وتاريخ التوريد السابق مقبول', async () => {
  const hs = createHarness();
  const prepared = hs.prepare({ customer: CUSTOMERS.b2bComplete, request: { ...REQ_STANDARD_Z1, supplyDate: '2026-11-20' } });
  const r = await hs.issue({ prepared });
  assert.equal(r.subtype, '01');
  assert.equal(r.typeName, '0100000');
  assert.equal(r.flow, 'CLEARANCE');
  assert.equal(r.reportDeadline, null);
  assert.equal(hs.records[0].mirror.einvoiceStatus, 'clearance_pending');
  assert.equal(hs.records[0].mirror.einvoiceQr, null);
  assert.equal(decodeQr(r.qr).certSignatureDer, undefined);
  assert.equal(hs.records[0].snapshot.supplyDate, '2026-11-20');
  verifyStampedXml(gunzipXml([...hs.sim.documents.values()][0].xmlGz), parseCsidToken(hs.keys.token), 'standard', { invoiceHash: r.invoiceHash });
});

test('ذهبي (Z1/Z2): الإصدار بنفس الرقم وUUID واللحظة ⇒ إفراغ خانات الختم يعيد بايتات عيّنة Z1 المبسّطة حرفياً، ويطابق ختم Z2 المباشر', async () => {
  const hs = createHarness({ start: Z1_ISSUED_AT, stepMs: 0 });
  const prepared = hs.prepare({ at: Z1_ISSUED_AT });
  const signing = await hs.signing(Z1_ISSUED_AT);
  const r = await hs.issue({
    prepared, signing, deps: { newUuid: () => chainFor(1).uuid }, hooks: { allocateNumber: async () => 'INV-2609-000123' },
  });
  const xml = gunzipXml([...hs.sim.documents.values()][0].xmlGz);
  const fixture = fixtureXml('simplified-invoice');
  assert.equal(unstampedForm(xml), fixture);
  assert.equal(r.invoiceHash, computeInvoiceHash(fixture));
  const direct = await stampDocument(fixture, mapInvoiceToUbl(SIMPLIFIED_INVOICE, chainFor(1)), signing.signer, signing.cert, Z1_ISSUED_AT, 'simplified');
  const vr = verifyStampedXml(xml, signing.cert, 'simplified');
  assert.equal(vr.invoiceHash, direct.invoiceHash);
  assert.equal(vr.signedPropertiesDigest, direct.signedPropertiesDigest);
  assert.equal(vr.certDigest, direct.certDigest);
  assert.equal(vr.signingTime, direct.signingTime);
  const [q1, q2] = [decodeQr(r.qr), decodeQr(direct.qr)];
  assert.deepEqual(q1.tags.filter(t => t[0] !== 7), q2.tags.filter(t => t[0] !== 7));
});

test('ذهبي (SDK 3.4.8): وحدة بمفتاح الـSDK وشهادته ⇒ المستند المحفوظ يتحقق بشهادة الهيئة التجريبية، والوسمان 8 و9 منها، ويطابق ختم Z2 المباشر', { skip: SDK_SKIP }, async () => {
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(sdkPrivateKeyB64(), 'base64'), format: 'der', type: 'sec1' });
  const certB64 = sdkCertB64().trim();
  const keys = {
    privateKey, publicKeyPem: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string,
    token: Buffer.from(certB64, 'latin1').toString('base64'), certB64,
  };
  const at = new Date('2026-09-14T07:15:30.000Z');
  const hs = createHarness({ keys, start: at, stepMs: 0 });
  const signing = await hs.signing(at);
  const sdkCert = parseCsidCertificate(certB64);
  assert.equal(signing.cert.certB64, sdkCert.certB64);
  for (const [customer, request, kind] of [
    [CUSTOMERS.individual, REQ_SIMPLIFIED_Z1, 'simplified'], [CUSTOMERS.b2bComplete, { ...REQ_STANDARD_Z1, supplyDate: null }, 'standard'],
  ] as const) {
    const prepared = hs.prepare({ customer, request, at });
    const r = await hs.issue({ prepared, signing });
    const xml = gunzipXml([...hs.sim.documents.values()].find(d => d.icv === r.icv)!.xmlGz);
    const v = verifyStampedXml(xml, sdkCert, kind, { invoiceHash: r.invoiceHash });
    const q = decodeQr(r.qr);
    assert.deepEqual(Buffer.from(q.spkiDer!), Buffer.from(sdkCert.spkiDer));
    if (kind === 'simplified') assert.deepEqual(Buffer.from(q.certSignatureDer!), Buffer.from(sdkCert.certSignatureDer));
    else assert.equal(q.certSignatureDer, undefined);
    const unsigned = unstampedForm(xml);
    const doc = mapInvoiceToUbl({ ...prepared.src, number: r.number }, { icv: r.icv, pih: r.pih, uuid: r.uuid, issuedAt: r.issuedAt });
    const direct = await stampDocument(unsigned, doc, createServerSigner(sdkPrivateKeyB64()), sdkCert, r.issuedAt, kind);
    assert.equal(direct.invoiceHash, v.invoiceHash);
    assert.equal(direct.signedPropertiesDigest, v.signedPropertiesDigest);
    assert.equal(direct.certDigest, v.certDigest);
  }
  assert.equal(hs.sim.units.get(Z5_UNIT)!.lastIcv, 2);
});

// ─── الإلغاء والتعطّل بين الخطوات ───

test('StampError من الموقِّع يُلغي كل شيء: لا ICV ولا فاتورة ولا مستند ولا قيد، والقفل محرَّر، ثم الإصدار التالي يأخذ ICV نفسه', async () => {
  const hs = createHarness();
  const signing = await hs.signing();
  const before = stateOf(hs);
  const http = await rejectsHttp(hs.issue({ signing: { ...signing, signer: throwingSigner(signing.signer) } }), 'ZATCA_UNIT_UNAVAILABLE', { reason: 'UNIT_CONFIG' });
  assert.equal(http.alert, true);
  assert.deepEqual(stateOf(hs), before);
  assert.equal(hs.sim.stats.rollbacks, 1);
  const r = await hs.issue();
  assert.equal(r.icv, 1);
  assert.equal(r.pih, INITIAL_PIH);
  assert.equal(r.number, 'INV-2612-000001');
});

test('تعطّل بين الخطوات (بعد القفل/الرقم/الختم/الفاتورة/المستند/التقدّم/القيود/قبل الالتزام): الحالة كما قبلها تماماً والسلسلة تكمل بلا فجوة', async () => {
  const boom = (step: string) => { throw new Error(`crash@${step}`); };
  const steps = ['lock', 'number', 'stamp', 'invoice', 'insertSigned', 'advance', 'ledger', 'commit'] as const;
  for (const step of steps) {
    const hs = createHarness();
    const first = await hs.issue();
    const before = stateOf(hs);
    const signing = await hs.signing();
    const sim = hs.sim;
    const deps = {
      chain: { async lockChainHead(tx: Parameters<typeof sim.chain.lockChainHead>[0], id: string) { const x = await sim.chain.lockChainHead(tx, id); if (step === 'lock') boom(step); return x; } },
      documents: {
        async insertSigned(tx: Parameters<typeof sim.documentStore.insertSigned>[0], d: Parameters<typeof sim.documentStore.insertSigned>[1]) { const x = await sim.documentStore.insertSigned(tx, d); if (step === 'insertSigned') boom(step); return x; },
        async advanceUnitChain(tx: Parameters<typeof sim.documentStore.advanceUnitChain>[0], a: Parameters<typeof sim.documentStore.advanceUnitChain>[1]) { const x = await sim.documentStore.advanceUnitChain(tx, a); if (step === 'advance') boom(step); return x; },
      },
    };
    const base = hs.hooks();
    const hooks = {
      async allocateNumber(tx: Parameters<typeof base.allocateNumber>[0], at: Date) { const n = await base.allocateNumber(tx, at); if (step === 'number') boom(step); return n; },
      async createInvoice(tx: Parameters<typeof base.createInvoice>[0], rec: Parameters<typeof base.createInvoice>[1]) { const x = await base.createInvoice(tx, rec); if (step === 'invoice') boom(step); return x; },
      async afterDocument(tx: Parameters<typeof base.createInvoice>[0], s: Parameters<NonNullable<typeof base.afterDocument>>[1]) { await base.afterDocument!(tx, s); if (step === 'ledger') boom(step); },
    };
    if (step === 'commit') sim.inject.beforeCommit = () => boom(step);
    await assert.rejects(
      hs.issue({ deps, hooks, signing: step === 'stamp' ? { ...signing, signer: throwingSigner(signing.signer, new Error('crash@stamp')) } : signing }),
      (e: unknown) => {
        const msg = e instanceof StampError ? String((e.cause as Error)?.message ?? e.message) : (e as Error).message;
        assert.match(msg, new RegExp(`crash@${step}`), step);
        return true;
      },
    );
    sim.inject.beforeCommit = undefined;
    assert.deepEqual(stateOf(hs), before, `${step}: الحالة لم تتغيّر`);
    const next = await hs.issue();
    assert.equal(next.icv, 2, step);
    assert.equal(next.pih, first.invoiceHash, step);
    assert.equal(next.number, 'INV-2612-000002', `${step}: لا فجوة ترقيم`);
  }
});

test('التقدّم CAS يفشل (lastIcv تغيّر تحت القفل) ⇒ ZATCA_CHAIN_CONFLICT (ADVANCE_CAS) بتنبيه ولا شيء يُلتزم', async () => {
  const hs = createHarness();
  const before = stateOf(hs);
  const http = await rejectsHttp(hs.issue({ deps: { documents: { insertSigned: (tx, d) => hs.sim.documentStore.insertSigned(tx, d), advanceUnitChain: async () => false } } }), 'ZATCA_CHAIN_CONFLICT', { logCode: 'ADVANCE_CAS' });
  assert.equal(http.alert, true);
  assert.deepEqual(stateOf(hs), before);
});

// ─── الحارس: keyVersion والحالة والرقم الضريبي وسلامة الذيل ───

test('keyVersion (نقد 9/34): المستند يحمل نسخة المفتاح؛ تجديد بين فتح المفتاح والقفل ⇒ ZATCA_UNIT_BUSY بلا ICV؛ RENEWING ⇒ RENEWING؛ تغيّر الرقم الضريبي ⇒ SELLER_VAT_CHANGED', async () => {
  const hs = createHarness({ unitOver: { keyVersion: 3 } });
  const r = await hs.issue();
  assert.equal(r.keyVersion, 3);
  assert.equal([...hs.sim.documents.values()][0].keyVersion, 3);
  const signing = await hs.signing();
  const unit = hs.sim.units.get(Z5_UNIT)!;
  const before = stateOf(hs);
  unit.keyVersion = 4;
  await rejectsHttp(hs.issue({ signing }), 'ZATCA_UNIT_BUSY', { logCode: 'KEY_VERSION' });
  unit.keyVersion = 3;
  unit.status = 'RENEWING';
  await rejectsHttp(hs.issue({ signing }), 'ZATCA_UNIT_UNAVAILABLE', { reason: 'RENEWING' });
  unit.status = 'ACTIVE';
  await rejectsHttp(hs.issue({ signing, sellerVat: '300000000000003' }), 'ZATCA_UNIT_UNAVAILABLE', { reason: 'SELLER_VAT_CHANGED' });
  await rejectsHttp(hs.issue({ signing, sellerVat: null }), 'ZATCA_UNIT_UNAVAILABLE', { reason: 'SELLER_VAT_CHANGED' });
  assert.deepEqual({ ...stateOf(hs), keyVersion: 3 }, before);
  assert.equal((await hs.issue({ signing })).icv, 2);
});

test('سلامة السلسلة: مستند يتيم بـICV المحجوز ⇒ P2002 ⇒ ZATCA_CHAIN_CONFLICT بلا إعادة (معاملة واحدة)؛ ذيل مفقود أو تجزئة مختلفة ⇒ تعارض قبل أي ختم', async () => {
  const hs = createHarness();
  // يتيم: وثيقة icv=1 ملتزمة والوحدة ما زالت lastIcv=0
  const seed = await hs.issue();
  const unit = hs.sim.units.get(Z5_UNIT)!;
  unit.lastIcv = 0;
  unit.lastInvoiceHash = null;
  let txCount = 0;
  const http = await rejectsHttp(hs.issue({ onTransaction: () => { txCount++; } }), 'ZATCA_CHAIN_CONFLICT');
  assert.equal(txCount, 1, 'تعارض السلسلة لا يُعاد');
  assert.equal(http.alert, true);
  assert.equal(hs.sim.documents.size, 1);
  // ذيل مفقود
  unit.lastIcv = 5;
  unit.lastInvoiceHash = seed.invoiceHash;
  await rejectsHttp(hs.issue(), 'ZATCA_CHAIN_CONFLICT', { logCode: 'TAIL_MISSING' });
  // تجزئة الوحدة لا تطابق الذيل
  unit.lastIcv = 1;
  unit.lastInvoiceHash = crypto.createHash('sha256').update('x').digest('base64');
  await rejectsHttp(hs.issue(), 'ZATCA_CHAIN_CONFLICT', { logCode: 'TAIL_MISMATCH' });
  unit.lastInvoiceHash = seed.invoiceHash;
  assert.equal((await hs.issue()).icv, 2);
});

test('nextChainSlot (نقيّ): ICV = lastIcv+1 وPIH = lastInvoiceHash ?? INITIAL_PIH، وكل خلل في الرأس مرفوض برمز ثابت', () => {
  const H = crypto.createHash('sha256').update('prev').digest('base64');
  const unit = { id: 'u', tenantId: 't', status: 'ACTIVE', environment: 'production', keyVersion: 2, vatNumber: Z5_VAT, lastIcv: 0, lastInvoiceHash: null as string | null };
  const exp = { id: 'u', tenantId: 't', keyVersion: 2, vatNumber: Z5_VAT };
  const head = (u: Partial<typeof unit>, tail: ChainHead['tail'] = null): ChainHead => ({ unit: { ...unit, ...u }, tail });
  const tail = { icv: 41, invoiceHash: H, issueDate: '2026-12-01', issueTime: '12:00:00' };
  assert.deepEqual(nextChainSlot(head({}), exp, Z5_VAT), { unitId: 'u', icv: 1, pih: INITIAL_PIH, tail: null });
  assert.deepEqual(nextChainSlot(head({ lastIcv: 41, lastInvoiceHash: H }, tail), exp), { unitId: 'u', icv: 42, pih: H, tail });
  const code = (h: ChainHead | null, e = exp, vat?: string | null) => {
    try { nextChainSlot(h, e, vat); } catch (x) { const z = x as ZatcaHttpError; return `${z.code}:${z.reason ?? z.logDetail?.code}`; }
    return 'ok';
  };
  assert.equal(code(null), 'ZATCA_UNIT_UNAVAILABLE:NO_ACTIVE_UNIT');
  assert.equal(code(head({ tenantId: 'x' })), 'ZATCA_UNIT_UNAVAILABLE:UNIT_CONFIG');
  assert.equal(code(head({ status: 'RENEWING' })), 'ZATCA_UNIT_UNAVAILABLE:RENEWING');
  assert.equal(code(head({ status: 'AUTH_FAILED' })), 'ZATCA_UNIT_UNAVAILABLE:AUTH_FAILED');
  assert.equal(code(head({ status: 'REVOKED' })), 'ZATCA_UNIT_UNAVAILABLE:NO_ACTIVE_UNIT');
  assert.equal(code(head({ keyVersion: 1 })), 'ZATCA_UNIT_BUSY:KEY_VERSION');
  assert.equal(code(head({ vatNumber: '300000000000003' })), 'ZATCA_UNIT_UNAVAILABLE:SELLER_VAT_CHANGED');
  assert.equal(code(head({}), exp, '300000000000003'), 'ZATCA_UNIT_UNAVAILABLE:SELLER_VAT_CHANGED');
  assert.equal(code(head({}), exp, undefined), 'ok');
  assert.equal(code(head({ lastIcv: -1 })), 'ZATCA_CHAIN_CONFLICT:LAST_ICV_INVALID');
  assert.equal(code(head({ lastIcv: 1.5 })), 'ZATCA_CHAIN_CONFLICT:LAST_ICV_INVALID');
  assert.equal(code(head({ lastIcv: MAX_ICV, lastInvoiceHash: H }, { ...tail, icv: MAX_ICV })), 'ZATCA_CHAIN_CONFLICT:ICV_EXHAUSTED');
  assert.equal(code(head({ lastInvoiceHash: H })), 'ZATCA_CHAIN_CONFLICT:HEAD_ZERO_NOT_EMPTY');
  assert.equal(code(head({ lastIcv: 41, lastInvoiceHash: null }, tail)), 'ZATCA_CHAIN_CONFLICT:LAST_HASH_INVALID');
  assert.equal(code(head({ lastIcv: 41, lastInvoiceHash: INITIAL_PIH }, tail)), 'ZATCA_CHAIN_CONFLICT:LAST_HASH_INVALID');
  assert.equal(code(head({ lastIcv: 41, lastInvoiceHash: H }, null)), 'ZATCA_CHAIN_CONFLICT:TAIL_MISSING');
  assert.equal(code(head({ lastIcv: 41, lastInvoiceHash: H }, { ...tail, icv: 40 })), 'ZATCA_CHAIN_CONFLICT:TAIL_MISMATCH');
  assert.equal(code(head({ lastIcv: 41, lastInvoiceHash: H }, { ...tail, issueTime: '25:00:00' })), 'ZATCA_CHAIN_CONFLICT:TAIL_TIME_INVALID');
  for (const c of ['ZATCA_CHAIN_CONFLICT']) assert.equal(new ZatcaHttpError(c as 'ZATCA_CHAIN_CONFLICT').alert, true);
});

test('لحظة الإصدار بعد القفل ولا تسبق الذيل (نقد 19): ساعة متأخرة ≤ دقيقتين ⇒ ثانية الذيل؛ أكثر ⇒ ZATCA_STAMP_FAILED بلا مستند', async () => {
  const tail = { icv: 1, invoiceHash: 'h', issueDate: '2026-12-01', issueTime: '12:00:05' };
  const t = tailInstant(tail);
  assert.equal(t.toISOString(), '2026-12-01T09:00:05.000Z');
  assert.equal(issuedAtAfter(new Date('2026-12-01T09:00:05.900Z'), tail).toISOString(), '2026-12-01T09:00:05.900Z');
  assert.equal(issuedAtAfter(new Date('2026-12-01T09:00:00Z'), tail).toISOString(), '2026-12-01T09:00:05.000Z');
  assert.throws(() => issuedAtAfter(new Date('2026-12-01T08:50:00Z'), tail), (e: unknown) => (e as ZatcaHttpError).logDetail?.code === 'CLOCK_BEHIND');
  assert.equal(issuedAtAfter(new Date('2026-12-01T08:00:00Z'), null).toISOString(), '2026-12-01T08:00:00.000Z');

  const hs = createHarness({ stepMs: 0 });
  const r1 = await hs.issue();
  hs.clock.set(new Date(r1.issuedAt.getTime() - 30_000));
  const r2 = await hs.issue();
  assert.equal(r2.issueTime, r1.issueTime, 'الثانية نفسها');
  assert.equal(r2.issueDate, r1.issueDate);
  hs.clock.set(new Date(r1.issuedAt.getTime() - 10 * 60_000));
  const before = stateOf(hs);
  await rejectsHttp(hs.issue(), 'ZATCA_STAMP_FAILED', { logCode: 'CLOCK_BEHIND' });
  assert.deepEqual(stateOf(hs), before);
});

test('انحراف المبالغ بين التحضير والقفل ⇒ ZATCA_STAMP_FAILED (AMOUNTS_DRIFT)؛ قاعدة التوريد تُعاد تحت القفل (منتصف الليل يقلب الشهر)', async () => {
  const hs = createHarness();
  const prepared = hs.prepare();
  await rejectsHttp(hs.issue({ prepared: { ...prepared, amountsFingerprint: prepared.amountsFingerprint.replace('41.05', '41.06') } }), 'ZATCA_STAMP_FAILED', { logCode: 'AMOUNTS_DRIFT' });
  assert.equal(hs.sim.documents.size, 0);
  // التحضير 23:00 الرياض يوم 15 (التوريد 11-05 مقبول)، والقفل 00:30 يوم 16 (أقدم تاريخ 12-01)
  const hs2 = createHarness({ start: new Date('2026-12-15T21:30:00Z'), stepMs: 0 });
  const std = prepareIssuance({
    settings: sellerSettings(), customer: CUSTOMERS.b2bComplete, products: PRODUCTS, request: { ...REQ_STANDARD_Z1, supplyDate: '2026-11-05' },
    companyVat: COMPANY_VAT, engine: engineOf(REQ_STANDARD_Z1), now: new Date('2026-12-15T20:00:00Z'),
  });
  const e = await rejectsHttp(hs2.issue({ prepared: std }), 'ZATCA_PREFLIGHT');
  assert.equal(e.issues?.[0].rule, 'KSA-VATIR-53');
  assert.equal(hs2.sim.documents.size + hs2.sim.invoices.size, 0);
});

// ─── P2002 والإعادة ───

test('P2002 على الرقم (مستند مرحلة أولى التزم الرقم نفسه) ⇒ runIssuance يعيد المعاملة برقم تالٍ بلا فجوة في ICV؛ الاستنفاد ⇒ ZATCA_UNIT_BUSY', async () => {
  const hs = createHarness();
  await hs.issue();
  let txCount = 0;
  let collided = false;
  const base = hs.hooks();
  const r = await hs.issue({
    onTransaction: () => { txCount++; },
    hooks: {
      async allocateNumber(tx, at) {
        const n = await base.allocateNumber(tx, at);
        if (!collided) { collided = true; hs.sim.commitInvoiceDirect({ tenantId: Z5_TENANT, number: n }); }
        return n;
      },
    },
  });
  assert.equal(txCount, 2);
  assert.equal(r.icv, 2);
  assert.equal(r.number, 'INV-2612-000003');
  assert.deepEqual(stateOf(hs).documents, [1, 2]);

  let attempts = 0;
  const before = stateOf(hs);
  await rejectsHttp(hs.issue({
    onTransaction: () => { attempts++; },
    hooks: { async allocateNumber(tx, at) { const n = await base.allocateNumber(tx, at); hs.sim.commitInvoiceDirect({ tenantId: Z5_TENANT, number: n }); return n; } },
  }), 'ZATCA_UNIT_BUSY', { logCode: 'number' });
  assert.equal(attempts, 3);
  assert.deepEqual(stateOf(hs).documents, before.documents);
  assert.equal(stateOf(hs).lastIcv, 2);
});

test('P2002 على clientRef (رفع مكرّر أثناء استرداد ردّ ضائع) ⇒ بلا إعادة، والتصنيف clientRef والتحويل null (المسار يعيد الفاتورة القائمة)', async () => {
  const hs = createHarness();
  hs.sim.commitInvoiceDirect({ tenantId: Z5_TENANT, number: 'INV-OLD-1', clientRef: '11111111-1111-4111-8111-111111111111' });
  let txCount = 0;
  let caught: unknown;
  try {
    await hs.issue({
      onTransaction: () => { txCount++; },
      hooks: { createInvoice: (tx, rec) => hs.sim.createInvoice(tx, { tenantId: rec.tenantId, number: rec.number, clientRef: '11111111-1111-4111-8111-111111111111' }) },
    });
  } catch (e) { caught = e; }
  assert.equal(txCount, 1);
  assert.equal(classifyIssuanceUniqueViolation(caught), 'clientRef');
  assert.equal(issuanceHttpError(caught), null);
  assert.equal(hs.sim.documents.size, 0);
  assert.equal(hs.sim.units.get(Z5_UNIT)!.lastIcv, 0);
});

test('خطافات المسار غير الصالحة ⇒ ZATCA_INTERNAL بلا التزام (رقم فارغ، معرّف فاتورة مفقود)', async () => {
  const hs = createHarness();
  await rejectsHttp(hs.issue({ hooks: { allocateNumber: async () => '  ' } }), 'ZATCA_INTERNAL', { logCode: 'NUMBER_EMPTY' });
  await rejectsHttp(hs.issue({ hooks: { createInvoice: async () => ({ id: '' }) } }), 'ZATCA_INTERNAL', { logCode: 'INVOICE_ID' });
  assert.equal(hs.sim.documents.size + hs.sim.invoices.size, 0);
});

// ─── محوّل Prisma (نصّي) ───

test('المحوّل: FOR UPDATE على zatca_egs_units وحدها بلا JOIN، والذيل جملة ثانية بالقيد الفريد، والترقيم بمقبض المعاملة، والاستيراد نوعي', () => {
  const src = fs.readFileSync(path.join(__dirname, 'issueStore.prisma.ts'), 'utf8').replace(/\r\n/g, '\n');
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const lock = /tx\.\$queryRaw<LockedUnitRow\[\]>`([^`]*)`/.exec(code);
  assert.ok(lock, 'جملة القفل');
  assert.match(lock![1], /FROM zatca_egs_units WHERE id = \$\{unitId\} FOR UPDATE\s*$/);
  assert.doesNotMatch(lock![1], /JOIN|zatca_documents|SKIP LOCKED|NOWAIT/i);
  assert.ok(code.indexOf('tx.zatcaDocument.findUnique') > code.indexOf('FOR UPDATE'), 'الذيل بعد القفل');
  assert.match(code, /egsUnitId_icv: \{ egsUnitId: unitId, icv: unit\.lastIcv \}/);
  assert.match(code, /tx\.invoice\.findFirst\(/);
  assert.doesNotMatch(code, /\bprisma\.|config\/database|\$executeRaw|\.update\(|\.create\(/);
  assert.match(code, /^import type \{ Prisma \} from '@prisma\/client';$/m);
  assert.doesNotMatch(code, /\bnot\s*:/);
  // لا مفاتيح في القراءات: جملة القفل لا تختار privateKeyEnc ولا الرموز
  assert.doesNotMatch(lock![1], /privateKeyEnc|Token|SecretEnc/);
});

test('unitRow ومفاتيح الاختبار: المفتاح مخزَّن مشفّراً فقط (لا PEM صريح في الصفّ)', () => {
  const keys = newUnitKeys();
  const row = unitRow(createKeyring({ current: crypto.randomBytes(32) }), keys);
  assert.doesNotMatch(JSON.stringify(row), /BEGIN (EC )?PRIVATE KEY/);
  assert.equal(typeof row.privateKeyEnc, 'string');
  const prepared: PreparedIssuance = prepareIssuance({
    settings: sellerSettings(), customer: CUSTOMERS.individual, products: PRODUCTS, request: REQ_SIMPLIFIED_Z1, companyVat: COMPANY_VAT,
    engine: engineOf(REQ_SIMPLIFIED_Z1), now: T_ISSUE,
  });
  assert.doesNotMatch(JSON.stringify(prepared), /BEGIN|privateKey/);
  void runIssuance;
});

test('الأنواع: محوّلا Prisma (السلسلة والترقيم + المستندات) يتركّبان في StampInTxDeps<TransactionClient> وخطافات بمقبض المعاملة نفسه', () => {
  // فحص نوعي (tsc) لما سيوصله المسار في Z5.2 — لا يُستدعى (لا قاعدة بيانات)
  function wiring(prisma: PrismaClient): { deps: StampInTxDeps<Prisma.TransactionClient>; hooks: Pick<StampInTxHooks<Prisma.TransactionClient>, 'allocateNumber'> } {
    const issuance = prismaIssuanceStore();
    return {
      deps: { chain: issuance, documents: prismaZatcaDocumentStore(prisma) },
      hooks: { allocateNumber: (tx, issuedAt) => issuance.nextNumberInTx(tx, Z5_TENANT, `INV-${riyadhParts(issuedAt).date.slice(2, 4)}${riyadhParts(issuedAt).date.slice(5, 7)}-`) },
    };
  }
  assert.equal(typeof wiring, 'function');
});
