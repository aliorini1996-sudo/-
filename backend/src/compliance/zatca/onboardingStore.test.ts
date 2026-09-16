// اختبارات Z4 لمخزن الوحدات: دلالات مخزن الذاكرة (CAS بالحالة والنسخة، القراءة العامة بلا أسرار، الضبط مرة واحدة، المرشّحات،
// عزل النسخ) — وفحص نصّي لمحوّل Prisma دون تنفيذه (لا اتصال بقاعدة البيانات إطلاقاً): CAS بـupdateMany وحالة ونسخة في where،
// قوائم select العامة بلا أعمدة سرّية، لا مرشّح «not» على عمود قابل للإفراغ، وIS NULL لتاريخ التفعيل.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { UNIT_BLOCKING_STATUSES } from './onboarding';
import { EgsUnitRecord, NewEgsUnit, SellerSettingsRecord, memoryEgsUnitStore } from './onboardingStore';

const T0 = new Date('2026-09-16T08:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function settings(tenantId = 't1'): SellerSettingsRecord {
  return {
    tenantId, legalName: 'X', taxNumber: '399999999900003', commercialReg: '1010010000', sellerIdScheme: null, sellerIdValue: null, addrStreet: 's',
    addrBuildingNo: '1234', addrAdditionalNo: null, addrDistrict: 'd', addrCity: 'c', addrPostalCode: '12345', vatGroupTin: null, countryCode: 'SA',
    currency: 'SAR', currencyOverride: null, einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null,
  };
}

function newUnit(id: string, over: Partial<NewEgsUnit> = {}): NewEgsUnit {
  return {
    id, tenantId: 't1', kind: 'SERVER', environment: 'production', commonName: `FS-399999999900003-${id.slice(0, 4)}`, serialNumber: `1-FieldSales|2-EGS1|3-${id}`,
    functionMap: '1100', orgName: 'X', orgUnit: 'Main Branch', vatNumber: '399999999900003', locationAddress: 'RRRD2929', industry: 'Supply',
    status: 'CSR_READY', keyVersion: 1, privateKeyEnc: 'v1:kid:iv:tag:ct', publicKeyPem: 'pub', csrPem: 'csr', complianceSteps: { v: 1 }, ...over,
  };
}

const SECRET_COLUMNS = ['privateKeyEnc', 'complianceToken', 'complianceSecretEnc', 'productionToken', 'productionSecretEnc'];

test('مخزن الذاكرة: إنشاء وقراءة عامة بلا أعمدة سرّية؛ بيانات الاعتماد بقراءة صريحة معدودة؛ القيد الفريد', async () => {
  const s = memoryEgsUnitStore({ settings: [settings()] });
  const r0 = await s.createUnitIfNone(newUnit('u-1'), T0, UNIT_BLOCKING_STATUSES);
  assert.ok(r0.created);
  const created = r0.unit;
  for (const k of SECRET_COLUMNS) assert.ok(!(k in created), `createUnit يعيد ${k}`);
  const loaded = (await s.loadUnit('u-1')) as EgsUnitRecord;
  for (const k of SECRET_COLUMNS) assert.ok(!(k in loaded), `loadUnit يعيد ${k}`);
  assert.equal(loaded.status, 'CSR_READY');
  assert.equal(loaded.updatedAt.getTime(), T0.getTime());
  assert.equal(loaded.lastIcv, 0);
  assert.equal(s.credentialReads, 0);
  const creds = await s.loadUnitCredentials('u-1');
  assert.equal(creds?.privateKeyEnc, 'v1:kid:iv:tag:ct');
  assert.equal(creds?.productionToken, null);
  assert.equal(s.credentialReads, 1);
  assert.equal(await s.loadUnit('nope'), null);
  // عزل: تعديل ما أُعيد لا يمسّ المخزَّن
  loaded.status = 'ACTIVE';
  (loaded.complianceSteps as Record<string, unknown>).v = 9;
  const again = (await s.loadUnit('u-1')) as EgsUnitRecord;
  assert.equal(again.status, 'CSR_READY');
  assert.deepEqual(again.complianceSteps, { v: 1 });
  // القيد الفريد يبقى (بلا حالات مانعة كي يصل الإدراج)
  await assert.rejects(s.createUnitIfNone(newUnit('u-1'), T0, []));
  await assert.rejects(s.createUnitIfNone(newUnit('u-2', { serialNumber: `1-FieldSales|2-EGS1|3-u-1` }), T0, []));
  assert.ok((await s.createUnitIfNone(newUnit('u-3', { environment: 'simulation', serialNumber: `1-FieldSales|2-EGS1|3-u-1` }), T0, [])).created);
});

test('CAS: الحالة وحدها أو الحالة + النسخة؛ updatedAt = at؛ undefined لا يغيّر وnull يفرغ؛ الخاسر لا يكتب شيئاً', async () => {
  const s = memoryEgsUnitStore();
  await s.createUnitIfNone(newUnit('u-1'), T0, []);
  assert.equal(await s.compareAndSetUnit('u-1', { status: 'ACTIVE' }, { lastError: 'x' }, at(1)), false, 'حالة مختلفة');
  assert.equal(await s.compareAndSetUnit('u-1', { status: 'CSR_READY', updatedAt: at(5) }, { lastError: 'x' }, at(1)), false, 'نسخة مختلفة');
  assert.equal(await s.compareAndSetUnit('missing', { status: 'CSR_READY' }, {}, at(1)), false);
  assert.equal((await s.loadUnit('u-1'))?.lastError, null);

  assert.equal(await s.compareAndSetUnit('u-1', { status: 'CSR_READY', updatedAt: T0 }, { status: 'CCSID_ISSUED', complianceToken: 'tok', complianceSecretEnc: 'enc', lastError: 'e' }, at(1)), true);
  let u = (await s.loadUnit('u-1')) as EgsUnitRecord;
  assert.equal(u.status, 'CCSID_ISSUED');
  assert.equal(u.updatedAt.getTime(), at(1).getTime());
  assert.equal(u.lastError, 'e');
  assert.equal((await s.loadUnitCredentials('u-1'))?.complianceToken, 'tok');
  // النسخة القديمة لم تعد صالحة
  assert.equal(await s.compareAndSetUnit('u-1', { status: 'CCSID_ISSUED', updatedAt: T0 }, { status: 'CHECKS_RUNNING' }, at(2)), false);
  assert.equal(await s.compareAndSetUnit('u-1', { status: 'CCSID_ISSUED', updatedAt: at(1) }, { lastError: null, complianceSecretEnc: null, orgName: undefined }, at(2)), true);
  u = (await s.loadUnit('u-1')) as EgsUnitRecord;
  assert.equal(u.lastError, null);
  assert.equal(u.orgName, 'X');
  assert.equal((await s.loadUnitCredentials('u-1'))?.complianceSecretEnc, null);

  // متزامنان بالنسخة نفسها: واحد فقط يُطبَّق
  const both = await Promise.all([
    s.compareAndSetUnit('u-1', { status: 'CCSID_ISSUED', updatedAt: at(2) }, { status: 'CHECKS_RUNNING' }, at(3)),
    s.compareAndSetUnit('u-1', { status: 'CCSID_ISSUED', updatedAt: at(2) }, { status: 'ERROR_NEEDS_OTP' }, at(3)),
  ]);
  assert.deepEqual(both.filter(Boolean).length, 1);
  assert.equal((await s.loadUnit('u-1'))?.status, both[0] ? 'CHECKS_RUNNING' : 'ERROR_NEEDS_OTP');
});

test('listUnits وcountUnitDocuments وsetPhase2StartedAtOnce وسجلّ API', async () => {
  const s = memoryEgsUnitStore({ settings: [settings('t1')] });
  await s.createUnitIfNone(newUnit('a'), at(2), []);
  await s.createUnitIfNone(newUnit('b', { environment: 'simulation' }), at(1), []);
  await s.createUnitIfNone(newUnit('c', { tenantId: 't2' }), at(0), []);
  await s.compareAndSetUnit('a', { status: 'CSR_READY' }, { status: 'ACTIVE' }, at(3));
  assert.deepEqual((await s.listUnits('t1')).map(u => u.id), ['b', 'a'], 'بترتيب الإنشاء');
  assert.deepEqual((await s.listUnits('t1', { environment: 'production' })).map(u => u.id), ['a']);
  assert.deepEqual((await s.listUnits('t1', { statuses: ['CSR_READY'] })).map(u => u.id), ['b']);
  assert.deepEqual((await s.listUnits('t1', { environment: 'production', statuses: ['CSR_READY'] })).map(u => u.id), []);
  for (const u of await s.listUnits('t1')) for (const k of SECRET_COLUMNS) assert.ok(!(k in u));

  s.documents.push({ egsUnitId: 'a', status: 'SIGNED' }, { egsUnitId: 'a', status: 'REPORTED' }, { egsUnitId: 'b', status: 'SIGNED' });
  assert.equal(await s.countUnitDocuments('a', ['SIGNED', 'SUBMITTING', 'RETRY_WAIT']), 1);

  const first = await s.setPhase2StartedAtOnce('t1', at(10));
  assert.deepEqual(first, { applied: true, startedAt: at(10) });
  const second = await s.setPhase2StartedAtOnce('t1', at(20));
  assert.deepEqual(second, { applied: false, startedAt: at(10) });
  assert.deepEqual(await s.setPhase2StartedAtOnce('nope', at(20)), { applied: false, startedAt: null });

  await s.writeApiLog({ tenantId: 't1', egsUnitId: 'a', actorId: 'u', endpoint: 'ui:go-live', httpStatus: null, outcome: 'LIVE', durationMs: null, response: { x: 1 }, errorText: null, at: at(11) });
  assert.equal(s.apiLogs.length, 1);
  assert.equal(s.received.filter(r => r.op === 'writeApiLog').length, 1);
});

test('محوّل Prisma (فحص نصّي بلا تنفيذ): CAS ذرّي بالحالة والنسخة، select عامّ بلا أسرار، لا «not» على عمود قابل للإفراغ', () => {
  const src = fs.readFileSync(path.join(__dirname, 'onboardingStore.ts'), 'utf8');
  const adapter = src.slice(src.indexOf('export function prismaEgsUnitStore'), src.indexOf('// ─── مخزن الذاكرة'));
  assert.ok(adapter.length > 500);
  assert.match(adapter, /zatcaEgsUnit\.updateMany\(\{\s*where: \{ id: unitId, status: expect\.status, \.\.\.\(expect\.updatedAt !== undefined \? \{ updatedAt: expect\.updatedAt \} : \{\}\) \}/);
  assert.match(adapter, /return r\.count === 1;/);
  assert.match(adapter, /companySettings\.updateMany\(\{ where: \{ tenantId, zatcaPhase2StartedAt: null \}/);
  assert.match(adapter, /zatcaDocument\.count\(\{ where: \{ egsUnitId: unitId, status: \{ in: \[\.\.\.statuses\] \} \} \}\)/);
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  assert.ok(!/\bnot\s*:/.test(code), 'لا مرشّح not في الكود (التعليق يشرح الفخّ فقط)');
  assert.ok(!/\b(delete|deleteMany|upsert)\b|\$(queryRaw|executeRaw)/.test(adapter), 'لا حذف ولا استعلام خام');
  // المعاملة الوحيدة: createUnitIfNone بعزل Serializable (فحص + إدراج ذرّيان) وإعادة محدودة على P2034 فقط
  assert.equal(adapter.match(/\$transaction\(/g)?.length, 1, 'معاملة واحدة فقط');
  const createBody = adapter.slice(adapter.indexOf('async createUnitIfNone('), adapter.indexOf('async loadUnit('));
  assert.match(createBody, /prisma\.\$transaction\(async tx => \{/);
  assert.match(createBody, /tx\.zatcaEgsUnit\.findFirst\(\{\s*where: \{ tenantId: unit\.tenantId, environment: unit\.environment, status: \{ in: \[\.\.\.blockingStatuses\] \} \}/);
  assert.match(createBody, /if \(existing\) return \{ created: false as const, existing \};/);
  assert.match(createBody, /\{ isolationLevel: 'Serializable' \}/);
  assert.match(createBody, /code === 'P2034' && attempt < CREATE_SERIALIZATION_ATTEMPTS/);
  assert.match(src, /'certNotBefore', 'certNotAfter', 'activatedAt', 'revokedAt', 'lastError',/);
  // select العام وإسقاط الأسرار
  const pub = src.slice(src.indexOf('const UNIT_PUBLIC_SELECT'), src.indexOf('satisfies Prisma.ZatcaEgsUnitSelect'));
  for (const k of SECRET_COLUMNS) assert.ok(!pub.includes(`${k}:`), `UNIT_PUBLIC_SELECT يختار ${k}`);
  for (const m of ['loadUnit', 'listUnits', 'createUnitIfNone']) {
    const i = adapter.indexOf(`async ${m}(`);
    const body = adapter.slice(i, adapter.indexOf('\n    },', i));
    assert.match(body, /select: UNIT_PUBLIC_SELECT/, m);
  }
  const credsBody = adapter.slice(adapter.indexOf('async loadUnitCredentials('), adapter.indexOf('async listUnits('));
  assert.match(credsBody, /select: UNIT_CREDENTIALS_SELECT/);
});

test('createUnitIfNone: الفحص والإدراج ذرّيان — طلبان متزامنان ⇒ وحدة واحدة؛ الحالات غير المانعة والبيئة الأخرى والشركة الأخرى لا تمنع', async () => {
  const s = memoryEgsUnitStore({ settings: [settings()] });
  const both = await Promise.all([
    s.createUnitIfNone(newUnit('u-a'), at(1), UNIT_BLOCKING_STATUSES),
    s.createUnitIfNone(newUnit('u-b'), at(1), UNIT_BLOCKING_STATUSES),
  ]);
  assert.deepEqual(both.map(r => r.created).sort(), [false, true]);
  const loser = both.find(r => !r.created);
  const winner = both.find(r => r.created);
  assert.ok(loser && !loser.created && winner && winner.created);
  assert.equal(loser.existing.id, winner.unit.id);
  assert.equal(s.units.size, 1);
  for (const k of SECRET_COLUMNS) assert.ok(!(k in loser.existing), `existing يعيد ${k}`);

  // وحدة موقوفة (REVOKED) لا تمنع؛ بيئة أخرى أو شركة أخرى لا تمنع
  await s.compareAndSetUnit(winner.unit.id, { status: 'CSR_READY' }, { status: 'REVOKED' }, at(2));
  assert.ok((await s.createUnitIfNone(newUnit('u-c'), at(3), UNIT_BLOCKING_STATUSES)).created);
  assert.ok((await s.createUnitIfNone(newUnit('u-d', { environment: 'simulation' }), at(3), UNIT_BLOCKING_STATUSES)).created);
  assert.ok((await s.createUnitIfNone(newUnit('u-e', { tenantId: 't2' }), at(3), UNIT_BLOCKING_STATUSES)).created);
  const blocked = await s.createUnitIfNone(newUnit('u-f'), at(4), UNIT_BLOCKING_STATUSES);
  assert.equal(blocked.created, false);
  assert.equal(!blocked.created && blocked.existing.id, 'u-c');

  // revokedAt يُكتب ويُقرأ في الصفّ العام
  assert.equal(await s.compareAndSetUnit('u-c', { status: 'CSR_READY' }, { status: 'REVOKED', revokedAt: at(5) }, at(5)), true);
  assert.equal((await s.loadUnit('u-c'))?.revokedAt?.getTime(), at(5).getTime());
});
