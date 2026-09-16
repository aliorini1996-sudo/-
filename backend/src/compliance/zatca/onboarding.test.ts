// اختبارات Z4 لخدمة الربط: إنشاء الوحدة، السلسلة كاملة حتى ACTIVE بتسلسل استدعاءات وترويسات مفحوصة، Invalid-OTP، رفض فحص
// امتثال، استئناف RETRY بلا رمز، مسارات فشل شهادة الإنتاج، CAS بين عمليتين متزامنتين، عدم تطابق الشهادة (مفتاح/رقم ضريبي)،
// التجديد (200 و428 وانتظار المستندات الجارية ومهلتها)، التفعيل (الشروط والتكرار)، حارس البيئة — ومسح كل صفّ وسجلّ ونتيجة
// ورسالة بحثاً عن OTP أو سرّ أو مادة مفتاح خاص.
// لا شبكة (حارس Z3 أولاً + fetch مزيّف) ولا قاعدة بيانات (مخزن ذاكرة).
import { guardHits } from './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FatooraEnv } from './api';
import { parseCsidToken } from './cert';
import { assertZatcaCsr } from './csr';
import {
  GO_LIVE_CONFIRMATION_TEXT, ONBOARDING_CODES, OnboardingCode, OnboardingFailure,
  checkLiveUnitAllowed, createUnit, goLive, onboardUnit, openUnitSigningKey,
} from './onboarding';
import { EgsUnitRecord, MemoryEgsUnitStore, SellerSettingsRecord } from './onboardingStore';
import { decryptSecret, decryptSecretBytes } from './secrets';
import { SELLER } from './__fixtures__/z1-sources';
import { CsidCertSpec } from './__fixtures__/z4-csidcert';
import { ALL_STEPS, FakeZatca, FakeZatcaOptions } from './__fixtures__/z4-fakezatca';
import { z3Body } from './__fixtures__/z3-fixtures';
import {
  ACTOR, TENANT, activeUnit, assertNoLeaks, create, endpoints, failed, harness, newOtp, newUnit, ok, onboard, renew, row, usedOtps,
} from './__fixtures__/z4-harness';

// ─────────────────────────────────────────────────────────────────────────────
// createUnit
// ─────────────────────────────────────────────────────────────────────────────

test('createUnit: صفّ CSR_READY مكتمل — CSR بحقول جدول التصميم، مفتاح secp256k1 مشفّر بسياق الوحدة، ولا نصّ صريح يصل المخزن', async () => {
  const h = harness();
  const unitId = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const r = ok(await create(h, { newUnitId: () => unitId }));
  const u = r.unit;
  assert.equal(u.id, unitId);
  assert.equal(u.status, 'CSR_READY');
  assert.equal(u.environment, 'production');
  assert.equal(u.keyVersion, 1);
  assert.equal(u.commonName, `FS-${SELLER.taxNumber}-9f1c2d3e`);
  assert.equal(u.serialNumber, `1-FieldSales|2-EGS1|3-${unitId}`);
  assert.ok(u.serialNumber.length <= 64);
  assert.equal(u.orgName, SELLER.legalName);
  assert.equal(u.orgUnit, 'Main Branch');
  assert.equal(u.vatNumber, SELLER.taxNumber);
  assert.equal(u.functionMap, '1100');
  assert.equal(u.locationAddress, `${SELLER.addrBuildingNo} ${SELLER.addrStreet}, ${SELLER.addrDistrict}, ${SELLER.addrCity}`);
  assert.ok(Array.from(u.locationAddress).length <= 64);
  assert.equal(u.industry, 'Wholesale Distribution');
  assert.deepEqual(u.complianceProgress, { v: 1, phase: 'onboarding', keyVersion: 1, requestId: null, steps: {} });
  assert.ok(!('csrPem' in u) && !('privateKeyEnc' in u), 'العرض بلا CSR ولا مفتاح');

  const stored = row(h, unitId);
  const spki = crypto.createPublicKey(stored.publicKeyPem as string).export({ type: 'spki', format: 'der' });
  const csr = assertZatcaCsr(stored.csrPem as string, {
    params: {
      env: 'production', commonName: u.commonName, serialNumber: u.serialNumber, orgName: u.orgName, orgUnit: u.orgUnit, vatNumber: u.vatNumber,
      functionMap: '1100', locationAddress: u.locationAddress, industry: u.industry,
    },
    subjectPublicKeyInfoDer: spki,
  });
  assert.equal(csr.parsed.fields.templateName, 'ZATCA-Code-Signing');

  // المفتاح: PKCS#8 DER مشفّر بـegs-key ومعرّف الوحدة، ويطابق المفتاح العام؛ سياق آخر لا يفكّه
  const opened = openUnitSigningKey({ unitId, privateKeyEnc: stored.privateKeyEnc as string, publicKeyPem: stored.publicKeyPem, keyring: h.keyring });
  assert.ok(opened.ok);
  assert.equal(opened.key.asymmetricKeyDetails?.namedCurve, 'secp256k1');
  assert.throws(() => decryptSecretBytes(stored.privateKeyEnc as string, { purpose: 'egs-key', ownerId: 'other-unit' }, h.keyring));
  assert.throws(() => decryptSecretBytes(stored.privateKeyEnc as string, { purpose: 'egs-key-pending', ownerId: unitId }, h.keyring));
  const wrong = openUnitSigningKey({ unitId, privateKeyEnc: stored.privateKeyEnc as string, publicKeyPem: crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey.export({ type: 'spki', format: 'pem' }) as string, keyring: h.keyring });
  assert.equal(wrong.ok, false);
  assert.equal((wrong as OnboardingFailure).detail, 'KEY_MISMATCH');

  assert.equal(h.store.credentialReads, 0);
  assert.deepEqual(h.store.apiLogs.map(l => [l.endpoint, l.outcome, l.egsUnitId, l.actorId, l.tenantId]), [['ui:create-unit', 'OK', unitId, ACTOR, TENANT]]);
  assert.equal(h.zatca.calls.length, 0);
  assertNoLeaks(h);
});

test('createUnit: مجموعة ضريبية (OU = TIN)، بيانات بائع ناقصة، دولة/مزوّد، محرف ممنوع، وحدة قائمة، مدخلات معطوبة', async () => {
  // مجموعة ضريبية: الخانة 11 = 1
  const groupVat = '300000000010003';
  const hg = harness({ settings: { taxNumber: groupVat, vatGroupTin: '3000000001' } });
  const g = ok(await create(hg)).unit;
  assert.equal(g.orgUnit, '3000000001');
  const hg2 = harness({ settings: { taxNumber: groupVat, vatGroupTin: null } });
  const g2 = failed(await create(hg2), 'SELLER_DATA_INCOMPLETE');
  assert.ok(g2.issues?.some(i => i.field === 'vatGroupTin'));

  // بيانات ناقصة: كل المخالفات بحقولها، ولا صفّ
  const hi = harness({ settings: { legalName: null, addrBuildingNo: '12', addrPostalCode: null } });
  const inc = failed(await create(hi), 'SELLER_DATA_INCOMPLETE');
  const fields = (inc.issues ?? []).map(i => i.field).sort();
  assert.deepEqual(fields, ['supplier.address.buildingNumber', 'supplier.address.postalZone', 'supplier.registrationName']);
  assert.ok(inc.issues?.every(i => /[؀-ۿ]/.test(i.messageAr)));
  assert.equal(hi.store.units.size, 0);

  failed(await create(harness({ settings: { countryCode: 'AE' } })), 'COUNTRY_NOT_SUPPORTED');
  failed(await create(harness({ settings: { einvoiceProvider: 'eta' } })), 'COUNTRY_NOT_SUPPORTED');

  // محرف ممنوع في O ⇒ رفض يسمّي الحقل (لا حذف صامت)
  const ha = harness({ settings: { legalName: 'Alpha & Sons Trading' } });
  const amp = failed(await create(ha), 'CSR_PARAMS_INVALID');
  assert.equal(amp.field, 'orgName');
  assert.equal(amp.detail, 'FORBIDDEN_CHARACTER');
  assert.match(amp.messageAr, /اسم المنشأة/);
  failed(await create(harness(), { locationAddress: 'x'.repeat(65) }), 'CSR_PARAMS_INVALID');
  failed(await create(harness(), { unitShortId: 'bad id!' }), 'CSR_PARAMS_INVALID');

  // وحدة قيد الربط في البيئة نفسها تمنع أخرى؛ بيئة أخرى مسموحة
  const h = harness();
  const first = ok(await create(h)).unit;
  const dup = failed(await create(h), 'UNIT_EXISTS');
  assert.equal(dup.unit?.id, first.id);
  ok(await create(h, { env: 'simulation' }));

  failed(await create(harness(), { tenantId: '' }), 'INVALID_INPUT');
  failed(await create(harness(), { tenantId: 'no-such-tenant' }), 'TENANT_NOT_FOUND');
  failed(await create(harness(), { env: 'staging' as FatooraEnv }), 'INVALID_INPUT');
  failed(await create(harness(), { newUnitId: () => 'not-a-uuid' }), 'INVALID_INPUT');
  const noStore = await createUnit({ store: null as unknown as MemoryEgsUnitStore, policy: { productionBackend: true }, tenantId: TENANT, env: 'production', actorId: ACTOR, keyring: h.keyring });
  assert.equal((noStore as OnboardingFailure).field, 'store');
});

test('فحص مسبق لعيّنات الامتثال قبل استهلاك أي رمز: اسم يتجاوز ميزانية QR للمبسّطة ⇒ SELLER_DATA_INCOMPLETE بلا اتصال (إنشاء، ربط، تجديد)', async () => {
  // 64 نقطة × 3 بايت = 192: يجتاز sellerIssues (≤ 255، تحذير فقط) وحدّ O في CSR، ويتجاوز ميزانية QR المبسّطة (162 بايت)
  const longName = 'ﻻ'.repeat(64);
  const h = harness({ settings: { legalName: longName } });
  const r = failed(await create(h), 'SELLER_DATA_INCOMPLETE');
  assert.equal(r.detail, 'preflight');
  assert.deepEqual(r.issues?.map(i => [i.rule, i.field]), [['QR-LENGTH', 'supplier.registrationName']]);
  assert.equal(h.store.units.size, 0);

  const h2 = harness();
  const u = await newUnit(h2);
  (h2.store.settings.get(TENANT) as SellerSettingsRecord).legalName = longName;
  const r2 = failed(await onboard(h2, u.id, h2.otps[0]), 'SELLER_DATA_INCOMPLETE');
  assert.equal(r2.unit?.status, 'CSR_READY');
  assert.equal(h2.zatca.calls.length, 0, 'الرمز لم يُرسل');

  const h3 = harness();
  const a = await activeUnit(h3);
  (h3.store.settings.get(TENANT) as SellerSettingsRecord).legalName = longName;
  const r3 = failed(await renew(h3, a.id, h3.renewalOtps[0]), 'SELLER_DATA_INCOMPLETE');
  assert.equal(r3.unit?.status, 'ACTIVE');
  assert.equal(h3.zatca.calls.filter(c => c.endpoint === 'renewal').length, 0);
  assertNoLeaks(h2);
  assertNoLeaks(h3);
});

test('حارس البيئة: خادم الإنتاج يرفض وحدات sandbox (إنشاءً وربطاً) ولا يصدر حيّاً إلا بوحدة production', async () => {
  const h = harness({ env: 'sandbox' });
  const refused = failed(await create(h), 'ENV_NOT_ALLOWED');
  assert.equal(refused.detail, 'env:sandbox');
  assert.equal(h.store.units.size, 0);

  // وحدة sandbox أنشأها خادم تطوير ثم وصلت خادم إنتاج: لا اتصال بالهيئة
  const dev = harness({ env: 'sandbox', productionBackend: false });
  const u = ok(await create(dev)).unit;
  const r = failed(await onboard({ ...dev, policy: { productionBackend: true } }, u.id, dev.otps[0]), 'ENV_NOT_ALLOWED');
  assert.equal(r.unit?.status, 'CSR_READY');
  failed(await renew({ ...dev, policy: { productionBackend: true } }, u.id, dev.renewalOtps[0]), 'ENV_NOT_ALLOWED');
  assert.equal(dev.zatca.calls.length, 0);

  // simulation مسموحة للربط على خادم الإنتاج (§5.1) لكنها لا تصدر حيّاً
  ok(await create(harness({ env: 'simulation' })));
  const prod = { productionBackend: true };
  const devPolicy = { productionBackend: false };
  assert.equal((checkLiveUnitAllowed({ environment: 'sandbox', status: 'ACTIVE' }, prod) as OnboardingFailure).code, 'ENV_NOT_ALLOWED');
  assert.equal((checkLiveUnitAllowed({ environment: 'simulation', status: 'ACTIVE' }, prod) as OnboardingFailure).code, 'ENV_NOT_ALLOWED');
  assert.deepEqual(checkLiveUnitAllowed({ environment: 'production', status: 'ACTIVE' }, prod), { ok: true });
  assert.deepEqual(checkLiveUnitAllowed({ environment: 'sandbox', status: 'ACTIVE' }, devPolicy), { ok: true });
  assert.equal((checkLiveUnitAllowed({ environment: 'production', status: 'RENEWING' }, prod) as OnboardingFailure).code, 'INVALID_STATE');
  assert.equal((checkLiveUnitAllowed({ environment: 'moon', status: 'ACTIVE' }, prod) as OnboardingFailure).code, 'INVALID_INPUT');
  assertNoLeaks(dev);
});

// ─────────────────────────────────────────────────────────────────────────────
// onboardUnit — المسار السعيد
// ─────────────────────────────────────────────────────────────────────────────

test('onboardUnit: CSR_READY ⇒ ACTIVE بتسلسل الاستدعاءات والترويسات الموثَّقة، وشهادة إنتاج مقروءة من الشهادة نفسها، وكل انتقال محفوظ أولاً', async () => {
  const validity = { notBefore: new Date('2026-03-01T10:20:30Z'), notAfter: new Date('2031-02-27T23:58:57Z') };
  const h = harness({ zatca: { validity } });
  const u = await newUnit(h);
  const otp = h.otps[0];
  const r = ok(await onboard(h, u.id, otp));
  assert.equal(r.alreadyActive, false);
  assert.equal(r.unit.status, 'ACTIVE');

  // التسلسل الدقيق: /compliance ثم ستة فحوص بترتيب الخطوات ثم /production/csids
  assert.deepEqual(endpoints(h), ['compliance', ...ALL_STEPS.map(() => 'compliance-invoices'), 'production-csid']);
  assert.deepEqual(h.zatca.calls.filter(c => c.endpoint === 'compliance-invoices').map(c => c.step), ALL_STEPS);
  assert.deepEqual(h.zatca.violations, [], 'ترويسات كل استدعاء مطابقة');
  const [ccsid, pcsid] = h.zatca.issued;
  assert.equal(ccsid.kind, 'ccsid');
  assert.equal(pcsid.kind, 'pcsid');
  assert.equal(h.zatca.calls[0].headers.otp, otp);
  for (const c of h.zatca.calls.slice(1)) assert.equal(c.authToken, ccsid.token, 'Basic بشهادة الامتثال للفحوص والإنتاج');
  assert.ok(h.zatca.calls.filter(c => c.endpoint === 'compliance-invoices').every(c => c.verified === true), 'كل عيّنة مختومة بمفتاح الوحدة وشهادة CCSID');
  assert.equal(h.zatca.calls[7].body?.compliance_request_id, String(ccsid.requestID));
  // CSR المُرسل = المخزَّن حرفياً
  assert.equal(Buffer.from(String(h.zatca.calls[0].body?.csr), 'base64').toString('utf8'), row(h, u.id).csrPem);

  // الشهادة: الرقم التسلسلي والصلاحية من الشهادة الصادرة (قيم الاختبار غير قياسية عمداً)
  const stored = row(h, u.id);
  assert.equal(stored.certSerial, pcsid.serial.toString(10));
  assert.equal(stored.certNotBefore?.toISOString(), validity.notBefore.toISOString());
  assert.equal(stored.certNotAfter?.toISOString(), validity.notAfter.toISOString());
  assert.equal(r.unit.certNotAfter?.toISOString(), validity.notAfter.toISOString());
  assert.equal(stored.activatedAt?.toISOString(), h.clock.now().toISOString());
  assert.equal(stored.productionToken, pcsid.token);
  assert.equal(decryptSecret(stored.productionSecretEnc as string, { purpose: 'pcsid-secret', ownerId: u.id }, h.keyring), pcsid.secret);
  assert.throws(() => decryptSecret(stored.productionSecretEnc as string, { purpose: 'ccsid-secret', ownerId: u.id }, h.keyring));
  assert.equal(stored.complianceToken, ccsid.token);
  assert.equal(stored.complianceRequestId, String(ccsid.requestID));
  assert.equal(stored.complianceSecretEnc, null, 'سرّ الامتثال لا يُبقى بعد التفعيل');
  assert.equal(stored.lastError, null);
  assert.equal(parseCsidToken(stored.productionToken as string).serialDecimal, stored.certSerial);
  const progress = r.unit.complianceProgress;
  assert.equal(progress?.requestId, String(ccsid.requestID));
  assert.deepEqual(ALL_STEPS.map(s => progress?.steps[s]?.status), ALL_STEPS.map(() => 'PASS'));

  // كل انتقال CAS بالحالة والنسخة، بالترتيب
  const cas = h.store.received.filter(x => x.op === 'compareAndSetUnit').map(x => x.payload as { expect: { status: string; updatedAt?: Date }; patch: { status?: string } });
  assert.deepEqual(cas.map(c => [c.expect.status, c.patch.status ?? '-']), [
    ['CSR_READY', '-'], ['CSR_READY', 'CCSID_ISSUED'], ['CCSID_ISSUED', 'CHECKS_RUNNING'],
    ...ALL_STEPS.map(() => ['CHECKS_RUNNING', '-']), ['CHECKS_RUNNING', 'CHECKS_PASSED'], ['CHECKS_PASSED', '-'], ['CHECKS_PASSED', 'ACTIVE'],
  ]);
  assert.ok(cas.every(c => c.expect.updatedAt instanceof Date), 'كل CAS برمز نسخة');

  // سجلّ API لكل محاولة + إجراء الواجهة، مربوط بالشركة والوحدة والمنفّذ
  assert.deepEqual(h.store.apiLogs.map(l => [l.endpoint, l.outcome]), [
    ['ui:create-unit', 'OK'], ['compliance', 'ISSUED'], ...ALL_STEPS.map(() => ['compliance-invoices', 'ACCEPTED']), ['production-csid', 'ISSUED'], ['ui:onboard', 'OK'],
  ]);
  assert.ok(h.store.apiLogs.every(l => l.tenantId === TENANT && l.egsUnitId === u.id && l.actorId === ACTOR));
  const complianceLog = h.store.apiLogs[1];
  assert.equal(complianceLog.httpStatus, 200);
  assert.equal((complianceLog.response as { path: string }).path, '/compliance');
  assert.deepEqual(h.store.apiLogs[h.store.apiLogs.length - 1].response, { from: 'CSR_READY', to: 'ACTIVE', detail: null });

  // تكرار الاستدعاء على وحدة مفعّلة: نجاح بلا أي اتصال ولا كتابة
  const writesBefore = h.store.received.filter(x => x.op === 'compareAndSetUnit').length;
  const again = ok(await onboard(h, u.id, null));
  assert.equal(again.alreadyActive, true);
  assert.equal(h.zatca.calls.length, 8);
  assert.equal(h.store.received.filter(x => x.op === 'compareAndSetUnit').length, writesBefore);
  assert.equal(guardHits(), 0);
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// OTP
// ─────────────────────────────────────────────────────────────────────────────

test('OTP: غائب أو بصيغة خاطئة ⇒ بلا اتصال؛ Invalid-OTP ⇒ يبقى CSR_READY بـNEW_OTP_REQUIRED؛ رمز صحيح بعدها يكمل حتى ACTIVE', async () => {
  const h = harness();
  const u = await newUnit(h);
  const missing = failed(await onboard(h, u.id, null), 'OTP_REQUIRED');
  assert.equal(missing.needsNewOtp, true);
  assert.equal(missing.unit?.status, 'CSR_READY');
  failed(await onboard(h, u.id, '12a456'), 'OTP_INVALID_FORMAT');
  failed(await onboard(h, u.id, '1234567'), 'OTP_INVALID_FORMAT');
  assert.equal(h.zatca.calls.length, 0);

  const wrongOtp = newOtp();
  const bad = failed(await onboard(h, u.id, wrongOtp), 'NEW_OTP_REQUIRED');
  assert.equal(bad.needsNewOtp, true);
  assert.equal(bad.retryable, false);
  assert.equal(bad.unit?.status, 'CSR_READY');
  assert.equal(bad.detail, 'Invalid-OTP');
  assert.deepEqual(bad.zatcaMessages?.map(m => m.code), ['Invalid-OTP']);
  const stored = row(h, u.id);
  assert.equal(stored.status, 'CSR_READY');
  assert.equal(stored.lastError, 'NEW_OTP_REQUIRED:Invalid-OTP');
  assert.equal(stored.complianceToken, null);
  assert.equal(stored.complianceSecretEnc, null);
  assert.deepEqual(endpoints(h), ['compliance']);
  const logged = h.store.apiLogs.find(l => l.endpoint === 'compliance');
  assert.equal(logged?.outcome, 'REJECTED');
  assert.equal(logged?.httpStatus, 400);

  // المفتاح نفسه يبقى (لا إعادة توليد لرمز خاطئ)
  const keyBefore = stored.privateKeyEnc;
  ok(await onboard(h, u.id, h.otps[0]));
  assert.equal(row(h, u.id).privateKeyEnc, keyBefore);
  assert.equal(row(h, u.id).status, 'ACTIVE');
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// رفض فحص امتثال
// ─────────────────────────────────────────────────────────────────────────────

test('فحص امتثال مرفوض (400) ⇒ ERROR_NEEDS_OTP بالخطوة ورسائلها، بلا شهادة إنتاج؛ رمز جديد يولّد مفتاحاً وCSR جديدين ويكمل', async () => {
  const h = harness({ zatca: { onCheck: (_c, n) => (n === 3 ? { status: 400, body: z3Body('compliance-invoices-400') } : undefined) } });
  const u = await newUnit(h);
  const r = failed(await onboard(h, u.id, h.otps[0]), 'COMPLIANCE_CHECK_REJECTED');
  assert.equal(r.needsNewOtp, true);
  assert.equal(r.step, 'standard-debit-note-compliant');
  assert.equal(r.detail, 'BR-KSA-37,BR-KSA-09');
  assert.deepEqual(r.zatcaMessages?.map(m => [m.type, m.code]), [['ERROR', 'BR-KSA-37'], ['ERROR', 'BR-KSA-09']]);
  assert.equal(r.unit?.status, 'ERROR_NEEDS_OTP');
  const steps = r.unit?.complianceProgress?.steps ?? {};
  assert.equal(steps['standard-compliant']?.status, 'PASS');
  assert.equal(steps['standard-credit-note-compliant']?.status, 'PASS');
  assert.equal(steps['standard-debit-note-compliant']?.status, 'REJECTED');
  assert.deepEqual(steps['standard-debit-note-compliant']?.errors.map(e => e.code), ['BR-KSA-37', 'BR-KSA-09']);
  assert.equal(steps['simplified-compliant'], undefined, 'توقّف عند أول رفض');
  assert.ok(!endpoints(h).includes('production-csid'));
  const before = row(h, u.id);
  assert.equal(before.productionToken, null);
  assert.match(before.lastError ?? '', /^COMPLIANCE_CHECK_REJECTED:BR-KSA-37/);

  // بلا رمز: لا شيء؛ برمز جديد: مفتاح وCSR جديدان ثم السلسلة كاملة
  failed(await onboard(h, u.id, null), 'OTP_REQUIRED');
  const oldKey = before.privateKeyEnc;
  const oldPub = before.publicKeyPem;
  const oldCsr = before.csrPem;
  const done = ok(await onboard(h, u.id, h.otps[1]));
  assert.equal(done.unit.status, 'ACTIVE');
  const after = row(h, u.id);
  assert.notEqual(after.privateKeyEnc, oldKey);
  assert.notEqual(after.publicKeyPem, oldPub);
  assert.notEqual(after.csrPem, oldCsr);
  assert.equal(after.serialNumber, u.serialNumber, 'الوحدة نفسها بمعرّفها');
  const newCcsid = h.zatca.issued.filter(i => i.kind === 'ccsid')[1];
  assert.ok(crypto.createPublicKey(after.publicKeyPem as string).equals(newCcsid.publicKey), 'CCSID الثانية لمفتاح الوحدة الجديد');
  assert.deepEqual(endpoints(h).slice(4), ['compliance', ...ALL_STEPS.map(() => 'compliance-invoices'), 'production-csid']);
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// RETRY والاستئناف
// ─────────────────────────────────────────────────────────────────────────────

test('RETRY أثناء الفحوص ⇒ CCSID_ISSUED قابلة للاستئناف؛ الاستئناف بلا OTP يرسل الخطوات المتبقية فقط ثم يفعّل', async () => {
  const h = harness({ zatca: { onCheck: (_c, n) => (n === 4 ? { status: 503, raw: '' } : undefined) } });
  const u = await newUnit(h);
  const r = failed(await onboard(h, u.id, h.otps[0]), 'ZATCA_RETRY');
  assert.equal(r.retryable, true);
  assert.equal(r.needsNewOtp, false);
  assert.equal(r.detail, 'retry:server');
  assert.equal(r.step, 'simplified-compliant');
  assert.equal(r.unit?.status, 'CCSID_ISSUED');
  assert.deepEqual(ALL_STEPS.map(s => r.unit?.complianceProgress?.steps[s]?.status ?? null), ['PASS', 'PASS', 'PASS', 'RETRY', null, null]);
  assert.equal(h.zatca.calls.length, 5);

  const resumed = ok(await onboard(h, u.id, null));
  assert.equal(resumed.unit.status, 'ACTIVE');
  assert.deepEqual(endpoints(h).slice(5), ['compliance-invoices', 'compliance-invoices', 'compliance-invoices', 'production-csid']);
  assert.deepEqual(h.zatca.calls.slice(5, 8).map(c => c.step), ['simplified-compliant', 'simplified-credit-note-compliant', 'simplified-debit-note-compliant']);
  assert.equal(h.zatca.calls.filter(c => c.endpoint === 'compliance').length, 1, 'لا OTP ولا /compliance جديد');
  assert.equal(h.zatca.otps.size, 2, 'رمز واحد فقط استُهلك');
  assertNoLeaks(h);
});

test('RETRY: انقطاع شبكة على /compliance يبقي CSR_READY؛ 400 فارغ متكرّر في فحص يُحسب عبر الاستئنافات حتى الرفض', async () => {
  let network = true;
  const h = harness({ zatca: { onCompliance: () => (network ? { network: true } : undefined) } });
  const u = await newUnit(h);
  const r = failed(await onboard(h, u.id, h.otps[0]), 'ZATCA_RETRY');
  assert.equal(r.detail, 'retry:network');
  assert.equal(r.unit?.status, 'CSR_READY');
  assert.equal(row(h, u.id).complianceToken, null);
  network = false;

  // 400 بلا رسائل على الخطوة الأولى دائماً: RETRY empty400 ثلاث مرات ثم REJECTED (EscalationCounts محفوظة في الخطوة)
  h.zatca.opts.onCheck = () => ({ status: 400, body: z3Body('reporting-400-null-messages') });
  const codes: string[] = [];
  let last = failed(await onboard(h, u.id, h.otps[0]), 'ZATCA_RETRY');
  codes.push(last.code);
  for (let i = 0; i < 2; i++) {
    last = failed(await onboard(h, u.id, null), 'ZATCA_RETRY');
    codes.push(last.code);
    assert.equal(last.unit?.complianceProgress?.steps['standard-compliant']?.priorEmpty400, i + 2);
  }
  const rejected = failed(await onboard(h, u.id, null), 'COMPLIANCE_CHECK_REJECTED');
  assert.equal(rejected.detail, 'FS-EMPTY-400');
  assert.equal(rejected.unit?.status, 'ERROR_NEEDS_OTP');
  assert.deepEqual(codes, ['ZATCA_RETRY', 'ZATCA_RETRY', 'ZATCA_RETRY']);
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// شهادة الإنتاج
// ─────────────────────────────────────────────────────────────────────────────

test('POST /production/csids: كل مسار فشل بحالته وكوده وعلَميه، ولا شهادة إنتاج مخزَّنة', async () => {
  const cases: Array<{ name: string; reply: FakeZatcaOptions['onProduction']; code: OnboardingCode; status: string; retryable: boolean; needsNewOtp: boolean; detail?: string }> = [
    { name: 'Missing-ComplianceSteps', reply: () => ({ status: 400, body: z3Body('production-csid-400-missing-steps') }), code: 'COMPLIANCE_STEPS_MISSING', status: 'CCSID_ISSUED', retryable: true, needsNewOtp: false, detail: 'Missing-ComplianceSteps' },
    { name: 'Invalid-ComplianceRequestId', reply: () => ({ status: 400, body: { errors: [{ code: 'Invalid-ComplianceRequestId', message: 'invalid' }] } }), code: 'PRODUCTION_CSID_REJECTED', status: 'ERROR_NEEDS_OTP', retryable: false, needsNewOtp: true, detail: 'Invalid-ComplianceRequestId' },
    { name: '503', reply: () => ({ status: 503, raw: '' }), code: 'ZATCA_RETRY', status: 'CHECKS_PASSED', retryable: true, needsNewOtp: false, detail: 'retry:server' },
    { name: '401', reply: () => ({ status: 401, body: {} }), code: 'CCSID_AUTH_FAILED', status: 'ERROR_NEEDS_OTP', retryable: false, needsNewOtp: true },
    { name: '406', reply: () => ({ status: 406, raw: 'Not Acceptable' }), code: 'ZATCA_CONFIG', status: 'CHECKS_PASSED', retryable: false, needsNewOtp: false, detail: 'version-not-accepted' },
    { name: 'رمز ليس شهادة', reply: () => ({ status: 200, body: { requestID: 99, dispositionMessage: 'ISSUED', binarySecurityToken: Buffer.from('QUJDRA==').toString('base64'), secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' } }), code: 'CSID_CERT_INVALID', status: 'CHECKS_PASSED', retryable: true, needsNewOtp: false, detail: 'pcsid' },
  ];
  for (const c of cases) {
    const h = harness({ zatca: { onProduction: c.reply } });
    const u = await newUnit(h);
    const r = failed(await onboard(h, u.id, h.otps[0]), c.code);
    assert.equal(r.unit?.status, c.status, c.name);
    assert.equal(r.retryable, c.retryable, `${c.name} retryable`);
    assert.equal(r.needsNewOtp, c.needsNewOtp, `${c.name} needsNewOtp`);
    if (c.detail) assert.equal(r.detail, c.detail, c.name);
    const stored = row(h, u.id);
    assert.equal(stored.status, c.status);
    assert.equal(stored.productionToken, null, c.name);
    assert.equal(stored.productionSecretEnc, null, c.name);
    assert.equal(stored.certSerial, null, c.name);
    assert.equal(stored.activatedAt, null, c.name);
    assert.ok(stored.lastError?.startsWith(c.code), c.name);
    if (c.code === 'COMPLIANCE_STEPS_MISSING') assert.deepEqual(r.unit?.complianceProgress?.steps, {}, 'تُعاد الفحوص كلها');
    assertNoLeaks(h);
  }

  // استئناف بعد 503: استدعاء إنتاج واحد فقط ثم ACTIVE؛ وبعد Missing-ComplianceSteps: الفحوص الست ثم الإنتاج
  const h = harness({ zatca: { onProduction: (_c, n) => (n === 1 ? { status: 503, raw: '' } : undefined) } });
  const u = await newUnit(h);
  failed(await onboard(h, u.id, h.otps[0]), 'ZATCA_RETRY');
  ok(await onboard(h, u.id, null));
  assert.deepEqual(endpoints(h).slice(8), ['production-csid']);

  const h2 = harness({ zatca: { onProduction: (_c, n) => (n === 1 ? { status: 400, body: z3Body('production-csid-400-missing-steps') } : undefined) } });
  const u2 = await newUnit(h2);
  failed(await onboard(h2, u2.id, h2.otps[0]), 'COMPLIANCE_STEPS_MISSING');
  ok(await onboard(h2, u2.id, null));
  assert.deepEqual(endpoints(h2).slice(8), [...ALL_STEPS.map(() => 'compliance-invoices'), 'production-csid']);
  assertNoLeaks(h2);
});

// ─────────────────────────────────────────────────────────────────────────────
// ربط الشهادة بالوحدة
// ─────────────────────────────────────────────────────────────────────────────

test('شهادة لا تخصّ الوحدة (مفتاح آخر، رقم ضريبي آخر، بلا UID، UID مزدوج) ⇒ CERT_BINDING_MISMATCH ولا تُحفظ', async () => {
  const otherKey = () => crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).publicKey;
  const variants: Array<{ name: string; kind: 'ccsid' | 'pcsid'; mutate: (spec: CsidCertSpec) => CsidCertSpec; detail: string; status: string }> = [
    { name: 'CCSID بمفتاح آخر', kind: 'ccsid', mutate: s => ({ ...s, subjectKey: otherKey() }), detail: 'ccsid:PUBLIC_KEY', status: 'CSR_READY' },
    { name: 'CCSID برقم آخر', kind: 'ccsid', mutate: s => ({ ...s, vatNumbers: ['399999999800003'] }), detail: 'ccsid:VAT', status: 'CSR_READY' },
    { name: 'CCSID بلا SAN', kind: 'ccsid', mutate: s => ({ ...s, vatNumbers: null }), detail: 'ccsid:VAT_MISSING', status: 'CSR_READY' },
    { name: 'CCSID بـUID مزدوج', kind: 'ccsid', mutate: s => ({ ...s, vatNumbers: [SELLER.taxNumber as string, '399999999800003'] }), detail: 'ccsid:VAT', status: 'CSR_READY' },
    { name: 'PCSID بمفتاح آخر', kind: 'pcsid', mutate: s => ({ ...s, subjectKey: otherKey() }), detail: 'pcsid:PUBLIC_KEY', status: 'ERROR_NEEDS_OTP' },
    { name: 'PCSID برقم آخر', kind: 'pcsid', mutate: s => ({ ...s, vatNumbers: ['399999999800003'] }), detail: 'pcsid:VAT', status: 'ERROR_NEEDS_OTP' },
  ];
  for (const v of variants) {
    const h = harness({ zatca: { certSpec: (kind, spec) => (kind === v.kind ? v.mutate(spec) : spec) } });
    const u = await newUnit(h);
    const r = failed(await onboard(h, u.id, h.otps[0]), 'CERT_BINDING_MISMATCH');
    assert.equal(r.detail, v.detail, v.name);
    assert.equal(r.unit?.status, v.status, v.name);
    assert.equal(r.needsNewOtp, true, v.name);
    const stored = row(h, u.id);
    assert.equal(stored.productionToken, null, v.name);
    assert.equal(stored.productionSecretEnc, null, v.name);
    if (v.kind === 'ccsid') {
      assert.equal(stored.complianceToken, null, v.name);
      assert.equal(stored.complianceSecretEnc, null, v.name);
      assert.deepEqual(endpoints(h), ['compliance'], `${v.name}: لا فحوص بشهادة غريبة`);
    }
    assertNoLeaks(h);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// التزامن
// ─────────────────────────────────────────────────────────────────────────────

test('CAS: عمليتا ربط متزامنتان بالرمز نفسه ⇒ واحدة فقط تتقدّم (استدعاء /compliance واحد) والأخرى CONCURRENT_MODIFICATION', async () => {
  const h = harness();
  const u = await newUnit(h);
  const otp = h.otps[0];
  const [a, b] = await Promise.all([onboard(h, u.id, otp), onboard(h, u.id, otp)]);
  const winners = [a, b].filter(x => x.ok);
  const losers = [a, b].filter(x => !x.ok) as OnboardingFailure[];
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'CONCURRENT_MODIFICATION');
  assert.equal(losers[0].retryable, true);
  assert.equal(h.zatca.calls.filter(c => c.endpoint === 'compliance').length, 1);
  assert.equal(row(h, u.id).status, 'ACTIVE');
  assertNoLeaks(h);
});

test('CAS: عامل آخر يغيّر الوحدة بين الرد وحفظه ⇒ CONCURRENT_MODIFICATION ولا تُحفظ الشهادة المُصدَرة للخاسر', async () => {
  const h = harness();
  const u = await newUnit(h);
  h.store.hooks.beforeCompareAndSet = (unitId, _expect, patch) => {
    if (patch.status === 'CCSID_ISSUED') {
      const r = h.store.units.get(unitId);
      if (r) {
        // كتابة عامل آخر استولى (بعد المهلة) بعلامة طلب خاصة به — لا مجرّد نسخة أحدث بعلامتنا
        r.updatedAt = new Date(r.updatedAt.getTime() + 5);
        r.complianceSteps = { ...(r.complianceSteps as Record<string, unknown>), inFlight: { op: 'compliance', attemptId: 'other-worker', at: h.clock.now().toISOString() } };
      }
    }
  };
  const r = failed(await onboard(h, u.id, h.otps[0]), 'CONCURRENT_MODIFICATION');
  assert.equal(r.unit?.status, 'CSR_READY');
  const stored = row(h, u.id);
  assert.equal(stored.complianceToken, null);
  assert.equal(stored.complianceSecretEnc, null);
  assert.equal(stored.complianceRequestId, null);
  assert.equal(h.zatca.issued.length, 1, 'صدرت فعلاً لكنها أُهملت');
  assertNoLeaks(h);
});

test('CHECKS_RUNNING: عامل حيّ ⇒ IN_PROGRESS بلا اتصال؛ بعد انقضاء المهلة يُستولى ويُستأنف بلا OTP', async () => {
  const h = harness({ zatca: { onCheck: (_c, n) => (n === 2 ? { status: 503, raw: '' } : undefined) } });
  const u = await newUnit(h);
  failed(await onboard(h, u.id, h.otps[0]), 'ZATCA_RETRY');
  // محاكاة عامل مات أثناء الفحوص: الحالة CHECKS_RUNNING بآخر كتابة الآن
  const r0 = row(h, u.id);
  r0.status = 'CHECKS_RUNNING';
  r0.updatedAt = h.clock.now();
  const calls = h.zatca.calls.length;
  const busy = failed(await onboard(h, u.id, null), 'IN_PROGRESS');
  assert.equal(busy.retryable, true);
  assert.equal(h.zatca.calls.length, calls);
  h.clock.advance(9 * 60 * 1000);
  failed(await onboard(h, u.id, null), 'IN_PROGRESS');
  h.clock.advance(60 * 1000);
  const done = ok(await onboard(h, u.id, null));
  assert.equal(done.unit.status, 'ACTIVE');
  assert.deepEqual(h.zatca.calls.slice(calls).map(c => c.step ?? c.endpoint), [...ALL_STEPS.slice(1), 'production-csid']);
  assertNoLeaks(h);
});

test('أخطاء المخزن: رسالة الخطأ (ولو حملت OTP أو سرّاً) لا تُنقل — STORE_ERROR/CREDENTIALS_NOT_SAVED بكود ثابت', async () => {
  const h = harness();
  const u = await newUnit(h);
  const otp = h.otps[0];
  // المطالبة نفسها تفشل: لا إرسال للرمز، STORE_ERROR قابل للإعادة
  h.store.hooks.beforeCompareAndSet = (_id, _e, patch) => {
    if (patch.status === undefined) throw new Error(`db exploded with otp=${otp}`);
  };
  const claimFail = failed(await onboard(h, u.id, otp), 'STORE_ERROR');
  assert.equal(claimFail.retryable, true);
  assert.doesNotMatch(JSON.stringify(claimFail), /exploded/);
  assert.equal(h.zatca.calls.length, 0);
  // حفظ الشهادة الصادرة يفشل في كل الإعادات: CREDENTIALS_NOT_SAVED (الرمز استُهلك ⇒ رمز جديد)
  h.store.hooks.beforeCompareAndSet = (_id, _e, patch) => {
    if (patch.status === 'CCSID_ISSUED') throw new Error(`db exploded with otp=${otp} and ${h.zatca.issued[0]?.secret}`);
  };
  const r = failed(await onboard(h, u.id, otp), 'CREDENTIALS_NOT_SAVED');
  assert.equal(r.needsNewOtp, true);
  assert.equal(r.unit?.status, 'CSR_READY');
  assert.doesNotMatch(JSON.stringify(r), /exploded/);
  assertNoLeaks(h);
  // وحدة من شركة أخرى لا تُكشف
  failed(await onboardUnit({ store: h.store, policy: h.policy, unitId: u.id, tenantId: 'tenant-2', otp, actorId: ACTOR, client: h.client, keyring: h.keyring }), 'UNIT_NOT_FOUND');
});

// ─────────────────────────────────────────────────────────────────────────────
// renewUnit
// ─────────────────────────────────────────────────────────────────────────────

test('renewUnit 200: انتظار المستندات الجارية ثم مفتاح جديد وPATCH بشهادة الإنتاج الحالية وتبديل ذرّي (keyVersion+1)', async () => {
  const h = harness();
  const u = await activeUnit(h);
  const before = { ...row(h, u.id) };
  const oldProd = h.zatca.current.production;
  row(h, u.id).lastIcv = 41;
  h.store.documents.push({ egsUnitId: u.id, status: 'SIGNED' }, { egsUnitId: u.id, status: 'RETRY_WAIT' }, { egsUnitId: u.id, status: 'REPORTED' }, { egsUnitId: 'other', status: 'SIGNED' });
  const sleeps: number[] = [];
  const statusesDuringWait: string[] = [];
  const r = ok(await renew(h, u.id, h.renewalOtps[0], {
    pollIntervalMs: 2000,
    sleep: async ms => {
      sleeps.push(ms);
      statusesDuringWait.push(row(h, u.id).status);
      h.clock.advance(ms);
      const i = h.store.documents.findIndex(d => d.egsUnitId === u.id && d.status !== 'REPORTED');
      h.store.documents.splice(i, 1);
    },
  }));
  assert.equal(r.path, 'ISSUED');
  assert.deepEqual(sleeps, [2000, 2000]);
  assert.deepEqual(statusesDuringWait, ['RENEWING', 'RENEWING'], 'الإصدار موقوف أثناء الانتظار');
  const renewal = h.zatca.calls.filter(c => c.endpoint === 'renewal');
  assert.equal(renewal.length, 1);
  assert.equal(renewal[0].headers.otp, h.renewalOtps[0]);
  assert.equal(renewal[0].authToken, oldProd?.token, 'PATCH بشهادة الإنتاج الحالية');
  assert.deepEqual(h.zatca.violations, []);

  const after = row(h, u.id);
  const newProd = h.zatca.current.production;
  assert.ok(newProd && newProd !== oldProd);
  assert.equal(after.status, 'ACTIVE');
  assert.equal(after.keyVersion, before.keyVersion + 1);
  assert.notEqual(after.privateKeyEnc, before.privateKeyEnc);
  assert.notEqual(after.publicKeyPem, before.publicKeyPem);
  assert.notEqual(after.csrPem, before.csrPem);
  assert.ok(crypto.createPublicKey(after.publicKeyPem as string).equals(newProd.publicKey), 'الشهادة الجديدة لمفتاح الوحدة الجديد');
  assert.equal(Buffer.from(String(renewal[0].body?.csr), 'base64').toString('utf8'), after.csrPem);
  assert.equal(after.productionToken, newProd.token);
  assert.equal(decryptSecret(after.productionSecretEnc as string, { purpose: 'pcsid-secret', ownerId: u.id }, h.keyring), newProd.secret);
  assert.equal(after.certSerial, newProd.serial.toString(10));
  assert.equal(after.lastIcv, 41, 'السلسلة تستمرّ على الوحدة');
  assert.equal(after.activatedAt?.getTime(), before.activatedAt?.getTime());
  const opened = openUnitSigningKey({ unitId: u.id, privateKeyEnc: after.privateKeyEnc as string, publicKeyPem: after.publicKeyPem, keyring: h.keyring });
  assert.ok(opened.ok);
  // التبديل كتابة CAS واحدة تحمل المفتاح والشهادة والسرّ معاً
  const swap = h.store.received.filter(x => x.op === 'compareAndSetUnit').map(x => x.payload as { expect: { status: string }; patch: Record<string, unknown> }).filter(p => p.patch.status === 'ACTIVE').pop();
  assert.equal(swap?.expect.status, 'RENEWING');
  assert.ok(swap && ['privateKeyEnc', 'publicKeyPem', 'csrPem', 'productionToken', 'productionSecretEnc', 'certSerial', 'certNotBefore', 'certNotAfter', 'keyVersion'].every(k => k in swap.patch));
  assert.deepEqual(h.store.apiLogs.slice(-2).map(l => [l.endpoint, l.outcome]), [['renewal', 'ISSUED'], ['ui:renew', 'OK']]);
  assertNoLeaks(h);
});

test('renewUnit 428: شهادة امتثال جديدة ⇒ ستة فحوص بها وبالمفتاح الجديد ⇒ POST /production/csids ⇒ تبديل ذرّي', async () => {
  const h = harness({ zatca: { renewalMode: 428 } });
  const u = await activeUnit(h);
  const before = { ...row(h, u.id) };
  const r = ok(await renew(h, u.id, h.renewalOtps[0]));
  assert.equal(r.path, 'NOT_COMPLIANT');
  const tail = h.zatca.calls.slice(8);
  assert.deepEqual(tail.map(c => c.endpoint), ['renewal', ...ALL_STEPS.map(() => 'compliance-invoices'), 'production-csid']);
  const renewalCcsid = h.zatca.issued.filter(i => i.kind === 'ccsid')[1];
  assert.ok(tail.slice(1).every(c => c.authToken === renewalCcsid.token), 'الفحوص والإنتاج بشهادة الامتثال الجديدة');
  assert.ok(tail.slice(1, 7).every(c => c.verified === true), 'العيّنات مختومة بالمفتاح الجديد');
  assert.deepEqual(tail.slice(1, 7).map(c => c.step), ALL_STEPS);
  assert.deepEqual(h.zatca.violations, []);
  const after = row(h, u.id);
  const newProd = h.zatca.current.production;
  assert.equal(after.status, 'ACTIVE');
  assert.equal(after.keyVersion, 2);
  assert.notEqual(after.privateKeyEnc, before.privateKeyEnc);
  assert.ok(newProd && crypto.createPublicKey(after.publicKeyPem as string).equals(newProd.publicKey));
  assert.equal(after.productionToken, newProd?.token);
  assert.equal(after.complianceRequestId, String(renewalCcsid.requestID));
  assert.equal(after.complianceSecretEnc, null, 'سرّ امتثال التجديد لا يُخزَّن');
  assert.equal(r.unit.complianceProgress?.phase, 'renewal');
  assert.equal(r.unit.complianceProgress?.keyVersion, 2);
  assert.deepEqual(ALL_STEPS.map(s => r.unit.complianceProgress?.steps[s]?.status), ALL_STEPS.map(() => 'PASS'));
  assertNoLeaks(h);
});

test('renewUnit: مهلة المستندات الجارية ⇒ IN_FLIGHT_TIMEOUT والعودة إلى ACTIVE بلا PATCH؛ نبض على النسخة أثناء الانتظار', async () => {
  const h = harness();
  const u = await activeUnit(h);
  const before = { ...row(h, u.id) };
  h.store.documents.push({ egsUnitId: u.id, status: 'SUBMITTING' });
  const sleeps: number[] = [];
  const r = failed(await renew(h, u.id, h.renewalOtps[0], {
    inFlightTimeoutMs: 25000, pollIntervalMs: 10000,
    sleep: async ms => { sleeps.push(ms); h.clock.advance(ms); },
  }), 'IN_FLIGHT_TIMEOUT');
  assert.equal(r.retryable, true);
  assert.equal(r.needsNewOtp, false);
  assert.equal(r.detail, 'in-flight:1');
  assert.deepEqual(sleeps, [10000, 10000, 5000]);
  assert.equal(r.unit?.status, 'ACTIVE');
  const after = row(h, u.id);
  assert.equal(after.privateKeyEnc, before.privateKeyEnc);
  assert.equal(after.productionToken, before.productionToken);
  assert.equal(after.keyVersion, 1);
  assert.equal(h.zatca.calls.filter(c => c.endpoint === 'renewal').length, 0);
  const renewWrites = h.store.received.filter(x => x.op === 'compareAndSetUnit').map(x => x.payload as { expect: { status: string }; patch: Record<string, unknown> }).slice(-5);
  assert.deepEqual(renewWrites.map(w => [w.expect.status, (w.patch.status as string | undefined) ?? '-']), [
    ['ACTIVE', 'RENEWING'], ['RENEWING', '-'], ['RENEWING', '-'], ['RENEWING', '-'], ['RENEWING', 'ACTIVE'],
  ]);
  assert.equal(h.zatca.renewalOtps.size, 2, 'رمز التجديد لم يُرسَل');
  assertNoLeaks(h);
});

test('renewUnit: Invalid-OTP يعيد ACTIVE بالاعتماد القديم؛ 401 ⇒ AUTH_FAILED؛ RENEWING حيّة ⇒ IN_PROGRESS ثم استيلاء؛ حالة خاطئة ⇒ INVALID_STATE', async () => {
  const h = harness();
  const u = await activeUnit(h);
  const before = { ...row(h, u.id) };
  const bad = failed(await renew(h, u.id, newOtp()), 'NEW_OTP_REQUIRED');
  assert.equal(bad.unit?.status, 'ACTIVE');
  const kept = row(h, u.id);
  assert.equal(kept.privateKeyEnc, before.privateKeyEnc);
  assert.equal(kept.productionSecretEnc, before.productionSecretEnc);
  assert.equal(kept.keyVersion, 1);
  failed(await renew(h, u.id, 'abc'), 'OTP_INVALID_FORMAT');

  // RENEWING بآخر كتابة الآن (عامل حيّ) ثم بعد المهلة: استيلاء يكمل التجديد
  const r = row(h, u.id);
  r.status = 'RENEWING';
  r.updatedAt = h.clock.now();
  failed(await renew(h, u.id, h.renewalOtps[0]), 'IN_PROGRESS');
  h.clock.advance(10 * 60 * 1000);
  const took = ok(await renew(h, u.id, h.renewalOtps[0]));
  assert.equal(took.unit.keyVersion, 2);

  // 401 على PATCH: الشهادة الحالية مرفوضة ⇒ AUTH_FAILED
  const h401 = harness({ zatca: { onRenewal: () => ({ status: 401, body: {} }) } });
  const u401 = await activeUnit(h401);
  const auth = failed(await renew(h401, u401.id, h401.renewalOtps[0]), 'PRODUCTION_AUTH_FAILED');
  assert.equal(auth.unit?.status, 'AUTH_FAILED');
  failed(await renew(h401, u401.id, h401.renewalOtps[0]), 'INVALID_STATE');

  // 428 ثم رفض فحص: عودة ACTIVE ويلزم رمز جديد (التجديد لا يُستأنف)
  const hr = harness({ zatca: { renewalMode: 428, onCheck: (_c, n) => (n === 8 ? { status: 400, body: z3Body('compliance-invoices-400') } : undefined) } });
  const ur = await activeUnit(hr);
  const rej = failed(await renew(hr, ur.id, hr.renewalOtps[0]), 'COMPLIANCE_CHECK_REJECTED');
  assert.equal(rej.unit?.status, 'ACTIVE');
  assert.equal(rej.needsNewOtp, true);
  assert.equal(rej.step, 'standard-credit-note-compliant');
  assert.equal(row(hr, ur.id).keyVersion, 1);

  const hc = harness();
  const uc = await newUnit(hc);
  failed(await renew(hc, uc.id, hc.renewalOtps[0]), 'INVALID_STATE');
  assertNoLeaks(h);
  assertNoLeaks(h401);
  assertNoLeaks(hr);
});

// ─────────────────────────────────────────────────────────────────────────────
// goLive
// ─────────────────────────────────────────────────────────────────────────────

test('goLive: الشروط (وحدة production مفعّلة واحدة، صلاحية، بيانات، SAR، تأكيد) ثم ضبط مرة واحدة وتكرار بلا كتابة', async () => {
  const h = harness();
  const confirm = { repsSynced: true, typedConfirmation: GO_LIVE_CONFIRMATION_TEXT };
  const live = (over: Partial<Parameters<typeof goLive>[0]> = {}) =>
    goLive({ store: h.store, policy: h.policy, now: h.clock.now, tenantId: TENANT, actorId: ACTOR, confirmations: confirm, ...over });

  failed(await live(), 'NO_ACTIVE_UNIT');
  const pending = await newUnit(h);
  failed(await live(), 'NO_ACTIVE_UNIT');
  ok(await onboard(h, pending.id, h.otps[0]));

  failed(await live({ confirmations: { repsSynced: false, typedConfirmation: GO_LIVE_CONFIRMATION_TEXT } }), 'CONFIRMATION_REQUIRED');
  failed(await live({ confirmations: { repsSynced: true, typedConfirmation: 'نعم' } }), 'CONFIRMATION_REQUIRED');
  failed(await live({ confirmations: undefined as unknown as { repsSynced: boolean; typedConfirmation: string } }), 'CONFIRMATION_REQUIRED');

  const s = h.store.settings.get(TENANT) as SellerSettingsRecord;
  s.currencyOverride = 'USD';
  failed(await live(), 'CURRENCY_NOT_SAR');
  s.currencyOverride = null;
  s.addrPostalCode = null;
  assert.ok((failed(await live(), 'SELLER_DATA_INCOMPLETE').issues ?? []).some(i => i.field === 'supplier.address.postalZone'));
  s.addrPostalCode = SELLER.addrPostalCode as string;
  s.taxNumber = '399999999800003';
  failed(await live(), 'SELLER_VAT_CHANGED');
  s.taxNumber = SELLER.taxNumber as string;

  const realNow = h.clock.t;
  h.clock.t = (row(h, pending.id).certNotAfter as Date).getTime() + 1;
  failed(await live(), 'CERT_EXPIRED');
  h.clock.t = realNow;

  // وحدتان مفعّلتان ⇒ رفض (سلسلة واحدة لكل شركة)
  const clone: EgsUnitRecord & Record<string, unknown> = { ...row(h, pending.id), id: crypto.randomUUID(), serialNumber: 'x' };
  h.store.units.set(clone.id, clone as never);
  failed(await live(), 'MULTIPLE_ACTIVE_UNITS');
  h.store.units.delete(clone.id);

  assert.equal(s.zatcaPhase2StartedAt, null, 'لا شيء ضُبط أثناء الرفض');
  const first = ok(await live());
  assert.equal(first.alreadyLive, false);
  assert.equal(first.unitId, pending.id);
  assert.equal(first.startedAt.toISOString(), h.clock.now().toISOString());
  assert.equal(h.store.settings.get(TENANT)?.zatcaPhase2StartedAt?.toISOString(), first.startedAt.toISOString());

  const sets = () => h.store.received.filter(x => x.op === 'setPhase2StartedAtOnce').length;
  assert.equal(sets(), 1);
  h.clock.advance(3600 * 1000);
  const second = ok(await live({ confirmations: { repsSynced: false, typedConfirmation: '' } }));
  assert.equal(second.alreadyLive, true);
  assert.equal(second.startedAt.toISOString(), first.startedAt.toISOString());
  assert.equal(sets(), 1, 'التكرار لا يكتب');

  // تفعيلان متزامنان على شركة لم تُفعَّل: ضبط واحد، وكلاهما نجاح بالتاريخ نفسه
  const h2 = harness();
  const u2 = await activeUnit(h2);
  const both = await Promise.all([0, 1].map(() => goLive({ store: h2.store, policy: h2.policy, now: h2.clock.now, tenantId: TENANT, actorId: ACTOR, confirmations: confirm })));
  const vals = both.map(x => ok(x));
  assert.equal(vals.filter(v => !v.alreadyLive).length, 1);
  assert.equal(vals[0].startedAt.getTime(), vals[1].startedAt.getTime());
  assert.equal(vals.find(v => !v.alreadyLive)?.unitId, u2.id);

  const logs = h.store.apiLogs.filter(l => l.endpoint === 'ui:go-live').map(l => l.outcome);
  assert.deepEqual(logs, [
    'NO_ACTIVE_UNIT', 'NO_ACTIVE_UNIT', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED', 'CONFIRMATION_REQUIRED', 'CURRENCY_NOT_SAR',
    'SELLER_DATA_INCOMPLETE', 'SELLER_VAT_CHANGED', 'CERT_EXPIRED', 'MULTIPLE_ACTIVE_UNITS', 'LIVE', 'ALREADY_LIVE',
  ]);
  assert.ok(h.store.apiLogs.filter(l => l.endpoint === 'ui:go-live').every(l => l.actorId === ACTOR && l.tenantId === TENANT));
  assertNoLeaks(h);
});

test('goLive: خادم الإنتاج لا يفعّل بوحدة غير production؛ وحدة production على خادم تطوير مسموحة', async () => {
  // وحدة production مفعّلة وُضعت بيئتها simulation يدوياً لمحاكاة خطأ تشغيل: listUnits يصفّي production فلا وحدة
  const h = harness();
  const u = await activeUnit(h);
  row(h, u.id).environment = 'simulation';
  failed(await goLive({ store: h.store, policy: h.policy, now: h.clock.now, tenantId: TENANT, actorId: ACTOR, confirmations: { repsSynced: true, typedConfirmation: GO_LIVE_CONFIRMATION_TEXT } }), 'NO_ACTIVE_UNIT');
  row(h, u.id).environment = 'production';
  const dev = await goLive({ store: h.store, policy: { productionBackend: false }, now: h.clock.now, tenantId: TENANT, actorId: ACTOR, confirmations: { repsSynced: true, typedConfirmation: ` ${GO_LIVE_CONFIRMATION_TEXT} ` } });
  assert.equal(ok(dev).alreadyLive, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// عامّ
// ─────────────────────────────────────────────────────────────────────────────

test('الماسح نفسه يلتقط كل نوع تسريب مزروع (OTP، سرّ كامل أو جزء بحالة أحرف أخرى، Basic، مادة مفتاح، الوسم)', async () => {
  const h = harness();
  const u = await activeUnit(h);
  assertNoLeaks(h);
  const pcsid = h.zatca.current.production as NonNullable<FakeZatca['current']['production']>;
  const der = decryptSecretBytes(row(h, u.id).privateKeyEnc as string, { purpose: 'egs-key', ownerId: u.id }, h.keyring);
  const d = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' }).d as string;
  const plants: unknown[] = [
    { note: `otp=${[...usedOtps][0]}` },
    { secret: pcsid.secret },
    { part: `xx${pcsid.secret.slice(10, 30).toUpperCase()}yy` },
    { basic: Buffer.from(`${pcsid.token}:${pcsid.secret}`, 'utf8').toString('base64') },
    { key: der.toString('base64') },
    { d },
    { marker: `-----BEGIN ${['PRIVATE', 'KEY'].join(' ')}-----` },
  ];
  for (const p of plants) assert.throws(() => assertNoLeaks(h, [p]), JSON.stringify(Object.keys(p as object)));
});

test('كل كود له رسالة عربية وعلَمان منطقيان؛ الأكواد التي تطلب رمزاً جديداً لا تُعدّ قابلة لإعادة المحاولة', () => {
  for (const [code, meta] of Object.entries(ONBOARDING_CODES)) {
    assert.match(meta.messageAr, /[؀-ۿ]/, code);
    assert.equal(typeof meta.retryable, 'boolean');
    assert.ok(!(meta.retryable && meta.needsNewOtp), `${code}: لا يجتمع العلَمان`);
  }
});

test('نظافة المصدر: لا process.env ولا fetch مباشر ولا DATABASE_URL ولا نصّ مفتاح خاص؛ Prisma مستورد نوعاً فقط', () => {
  const dir = __dirname;
  for (const f of ['onboarding.ts', 'onboardingStore.ts', 'csidBinding.ts']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!src.includes('process.env'), `${f}: process.env`);
    assert.ok(!/\bfetch\(/.test(src), `${f}: fetch`);
    assert.ok(!src.includes('DATABASE_URL'), `${f}: DATABASE_URL`);
    assert.ok(!src.includes(['BEGIN', 'PRIVATE', 'KEY'].join(' ')) && !src.includes(['BEGIN EC', 'PRIVATE', 'KEY'].join(' ')), `${f}: نصّ مفتاح`);
    assert.ok(!/\$(queryRaw|executeRaw|connect)/.test(src), `${f}: استعلام خام أو اتصال`);
    assert.ok(!/console\.(log|error|warn|info)/.test(src), `${f}: طباعة`);
  }
  const store = fs.readFileSync(path.join(dir, 'onboardingStore.ts'), 'utf8');
  assert.match(store, /^import type \{ Prisma, PrismaClient \} from '@prisma\/client';$/m);
  assert.ok(!/^import \{[^}]*\} from '@prisma\/client'/m.test(store), 'لا استيراد قيمة من @prisma/client');
  const onboarding = fs.readFileSync(path.join(dir, 'onboarding.ts'), 'utf8');
  assert.ok(!onboarding.includes('@prisma/client'), 'الخدمة لا تعرف Prisma');
});
