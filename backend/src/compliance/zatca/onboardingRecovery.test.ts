// اختبارات Z4 — الجولة الثانية من المراجعة: التعافي والتزامن في الربط والتجديد. كل اختبار يحرس نتيجة مؤكَّدة:
//   • التجديد بعد إصدار الهيئة شهادةً لا يعود أبداً إلى ACTIVE على اعتماد ربما أُبطل (حفظ بإعادات، «غير مؤكَّد»، AUTH_FAILED).
//   • علامة «طلب جارٍ» تمنع إرسال OTP مرتين أو طلب شهادة إنتاج ثانية أثناء انتظار الهيئة، والحفظ بعد الإصدار يُعاد.
//   • الإيقاف بعد خطأ في منتصف الفحوص يكتب على أحدث نسخة؛ abortRenewal بلا رمز؛ رفض CSR يبني طلباً جديداً من البيانات الحالية.
//   • إنشاء الوحدة ذرّي، retireUnit، والتجديد/الربط يرفضان وحدة ثانية؛ فحوص التجديد قبل إيقاف الإصدار.
//   • السرّ المخزَّن التالف يقود إلى رمز جديد لا إلى حلقة؛ حلقة المفاتيح تُفحص قبل إرسال الرمز؛ detail بلا OTP؛ لقطة المطالبة القديمة.
// لا شبكة (حارس Z3 أولاً + fetch مزيّف) ولا قاعدة بيانات (مخزن ذاكرة).
import { guardHits } from './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { FatooraFetch } from './api';
import { parseCsr } from './csr';
import { EgsUnitView, GO_LIVE_CONFIRMATION_TEXT, RETIRE_CONFIRMATION_TEXT, checkLiveUnitAllowed, goLive } from './onboarding';
import { SellerSettingsRecord } from './onboardingStore';
import { createKeyring } from './secrets';
import { CsidCertSpec } from './__fixtures__/z4-csidcert';
import { ALL_STEPS } from './__fixtures__/z4-fakezatca';
import {
  Harness, TENANT, ACTOR, abort, activeUnit, assertNoLeaks, create, endpoints, failed, harness, newUnit, ok, onboard, renew, retire, row,
} from './__fixtures__/z4-harness';

// ─────────────────────────────────────────────────────────────────────────────
// أدوات
// ─────────────────────────────────────────────────────────────────────────────

const count = (h: Harness, endpoint: string) => h.zatca.calls.filter(c => c.endpoint === endpoint).length;
const casWrites = (h: Harness) => h.store.received.filter(x => x.op === 'compareAndSetUnit').length;
const progressOf = (h: Harness, id: string) => row(h, id).complianceSteps as { renewal?: { stage: string; uncertain: boolean; origin: string }; inFlight?: { op: string } } | null;
const liveOk = (h: Harness, id: string) => checkLiveUnitAllowed(row(h, id), h.policy).ok;

/** يقلب محرفاً في وسط النصّ المشفّر (يبقى base64url قانونياً) ⇒ DECRYPT_FAILED. */
function corrupt(enc: string): string {
  const parts = enc.split(':');
  const ct = parts[4];
  const i = Math.floor(ct.length / 2);
  parts[4] = `${ct.slice(0, i)}${ct[i] === 'A' ? 'B' : 'A'}${ct.slice(i + 1)}`;
  return parts.join(':');
}

/** بوابة تحبس ردّ الهيئة (بعد أن عالجته) حتى يُطلق: لمحاكاة استدعاء ثانٍ يصل أثناء انتظار الأول. */
function gate(h: Harness, match: (url: string, method: string) => boolean) {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>(r => { release = r; });
  const inside = new Promise<void>(r => { entered = r; });
  let armed = true;
  h.fetchWrap = (inner: FatooraFetch): FatooraFetch => async (url, init) => {
    const res = await inner(url, init);
    if (armed && match(url, init.method)) {
      armed = false;
      entered();
      await released;
    }
    return res;
  };
  return { release, inside };
}

// ─────────────────────────────────────────────────────────────────────────────
// التجديد بعد إصدار شهادة الإنتاج (نتيجة عالية ×3)
// ─────────────────────────────────────────────────────────────────────────────

test('تجديد 200 و428: خطأ مخزن عابر على كتابة التبديل ⇒ تُعاد الكتابة وتُحفظ الشهادة الجديدة (لا عودة إلى الاعتماد القديم)', async () => {
  for (const mode of [200, 428] as const) {
    const h = harness({ zatca: { renewalMode: mode } });
    const u = await activeUnit(h);
    let thrown = 0;
    h.store.hooks.beforeCompareAndSet = (_id, _e, patch) => {
      if (patch.status === 'ACTIVE' && patch.keyVersion !== undefined && thrown++ === 0) throw new Error('db blip');
    };
    const r = ok(await renew(h, u.id, h.renewalOtps[0]));
    assert.equal(r.unit.status, 'ACTIVE', `${mode}`);
    assert.equal(r.unit.keyVersion, 2, `${mode}`);
    const stored = row(h, u.id);
    assert.equal(stored.productionToken, h.zatca.current.production?.token, `${mode}: الشهادة الجديدة محفوظة`);
    assert.equal(stored.keyVersion, 2);
    assert.deepEqual(h.sleeps, [250], `${mode}: إعادة واحدة بعد مهلة`);
    assert.equal(progressOf(h, u.id)?.renewal?.stage, 'done');
    assert.equal(guardHits(), 0);
    assertNoLeaks(h);
  }
});

test('تجديد 200 و428: تعذّر حفظ التبديل في كل الإعادات ⇒ RENEWING «غير مؤكَّد» يوقف الإصدار (لا ACTIVE بشهادة أُبطلت)، وتجديد لاحق يحسم بـ401 ⇒ AUTH_FAILED', async () => {
  for (const mode of [200, 428] as const) {
    const h = harness({ zatca: { renewalMode: mode } });
    const u = await activeUnit(h);
    const oldToken = row(h, u.id).productionToken;
    h.store.hooks.beforeCompareAndSet = (_id, _e, patch) => {
      if (patch.status === 'ACTIVE' && patch.keyVersion !== undefined) throw new Error('db down');
    };
    const r = failed(await renew(h, u.id, h.renewalOtps[0]), 'CREDENTIALS_NOT_SAVED');
    assert.equal(r.needsNewOtp, true, `${mode}`);
    assert.equal(r.retryable, false, `${mode}`);
    assert.equal(r.unit?.status, 'RENEWING', `${mode}: ليست ACTIVE`);
    const stored = row(h, u.id);
    assert.equal(stored.status, 'RENEWING');
    assert.equal(stored.keyVersion, 1);
    assert.equal(liveOk(h, u.id), false, `${mode}: الإصدار موقوف`);
    assert.notEqual(h.zatca.current.production?.token, oldToken, `${mode}: الهيئة أبطلت القديمة فعلاً`);
    assert.deepEqual(progressOf(h, u.id)?.renewal && { stage: progressOf(h, u.id)?.renewal?.stage, uncertain: progressOf(h, u.id)?.renewal?.uncertain }, { stage: 'unconfirmed', uncertain: true });
    assert.deepEqual(h.sleeps, [250, 1000, 4000]);
    assert.match(stored.lastError ?? '', /^CREDENTIALS_NOT_SAVED:swap/);

    // لا مخرج بلا رمز يعيد ACTIVE
    failed(await abort(h, u.id), 'RENEWAL_UNCONFIRMED');
    assert.equal(row(h, u.id).status, 'RENEWING');
    // تجديد برمز: PATCH بالشهادة القديمة ⇒ 401 ⇒ AUTH_FAILED (نتيجة قاطعة)
    h.store.hooks.beforeCompareAndSet = undefined;
    const again = failed(await renew(h, u.id, h.renewalOtps[1]), 'PRODUCTION_AUTH_FAILED');
    assert.equal(again.unit?.status, 'AUTH_FAILED');
    assertNoLeaks(h);
  }
});

test('تجديد: شهادة إنتاج جديدة صدرت لكنها لا تصلح (رقم ضريبي آخر، منتهية، ليست شهادة) ⇒ AUTH_FAILED لا ACTIVE', async () => {
  const variants: Array<{ name: string; mutate?: (s: CsidCertSpec) => CsidCertSpec; raw?: true; code: 'CERT_BINDING_MISMATCH' | 'CSID_CERT_INVALID'; detail: string }> = [
    { name: 'رقم آخر', mutate: s => ({ ...s, vatNumbers: ['399999999800003'] }), code: 'CERT_BINDING_MISMATCH', detail: 'pcsid:VAT' },
    { name: 'منتهية', mutate: s => ({ ...s, notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2026-09-01T00:00:00Z') }), code: 'CSID_CERT_INVALID', detail: 'pcsid-expired' },
    { name: 'ليست شهادة', raw: true, code: 'CSID_CERT_INVALID', detail: 'pcsid' },
  ];
  for (const v of variants) {
    let renewing = false;
    const h = harness({
      zatca: {
        certSpec: (kind, spec) => (kind === 'pcsid' && renewing && v.mutate ? v.mutate(spec) : spec),
        onRenewal: () => (renewing && v.raw
          ? { status: 200, body: { requestID: 99, dispositionMessage: 'ISSUED', binarySecurityToken: Buffer.from('QUJDRA==').toString('base64'), secret: 'c2VjcmV0LXNlY3JldC1zZWNyZXQ=' } }
          : undefined),
      },
    });
    const u = await activeUnit(h);
    renewing = true;
    const r = failed(await renew(h, u.id, h.renewalOtps[0]), v.code);
    assert.equal(r.detail, v.detail, v.name);
    assert.equal(r.unit?.status, 'AUTH_FAILED', v.name);
    assert.equal(row(h, u.id).status, 'AUTH_FAILED', v.name);
    assert.equal(row(h, u.id).keyVersion, 1, v.name);
    assert.equal(liveOk(h, u.id), false, v.name);
    assertNoLeaks(h);
  }
});

test('تجديد: PATCH بلا نتيجة قاطعة (انقطاع بعد المعالجة، 503) ⇒ RENEWING غير مؤكَّد بعلامة patch-sent محفوظة قبل الإرسال؛ 429 قاطع ⇒ ACTIVE', async () => {
  // «الهيئة» عالجت PATCH (أصدرت وأبطلت) ثم ضاع الرد
  const h = harness();
  const u = await activeUnit(h);
  const atPatch: Array<{ status: string; stage?: string }> = [];
  h.fetchWrap = (inner: FatooraFetch): FatooraFetch => async (url, init) => {
    if (init.method === 'PATCH') {
      atPatch.push({ status: row(h, u.id).status, stage: progressOf(h, u.id)?.renewal?.stage });
      await inner(url, init);
      throw new TypeError('fetch failed');
    }
    return inner(url, init);
  };
  const lost = failed(await renew(h, u.id, h.renewalOtps[0]), 'RENEWAL_UNCONFIRMED');
  assert.deepEqual(atPatch, [{ status: 'RENEWING', stage: 'patch-sent' }], 'المرحلة محفوظة قبل الإرسال');
  assert.equal(lost.detail, 'retry:network');
  assert.equal(lost.needsNewOtp, true);
  assert.equal(lost.unit?.status, 'RENEWING');
  assert.equal(liveOk(h, u.id), false);
  h.fetchWrap = null;
  // الشهادة القديمة أُبطلت فعلاً: التجديد التالي يحسم بـ401
  failed(await renew(h, u.id, h.renewalOtps[1]), 'PRODUCTION_AUTH_FAILED');
  assert.equal(row(h, u.id).status, 'AUTH_FAILED');
  assertNoLeaks(h);

  // 503 (لم تُعالَج فعلاً): غير مؤكَّد، ثم تجديد برمز جديد ينجح على الاعتماد القديم
  const h2 = harness({ zatca: { onRenewal: (_c, n) => (n === 1 ? { status: 503, raw: '' } : undefined) } });
  const u2 = await activeUnit(h2);
  const s503 = failed(await renew(h2, u2.id, h2.renewalOtps[0]), 'RENEWAL_UNCONFIRMED');
  assert.equal(s503.unit?.status, 'RENEWING');
  const done = ok(await renew(h2, u2.id, h2.renewalOtps[1]));
  assert.equal(done.unit.status, 'ACTIVE');
  assert.equal(done.unit.keyVersion, 2);
  assertNoLeaks(h2);

  // 429 يثبت أن الطلب لم يُعالَج: عودة ACTIVE قابلة للإعادة
  const h3 = harness({ zatca: { onRenewal: () => ({ status: 429, raw: '' }) } });
  const u3 = await activeUnit(h3);
  const rate = failed(await renew(h3, u3.id, h3.renewalOtps[0]), 'ZATCA_RETRY');
  assert.equal(rate.unit?.status, 'ACTIVE');
  assert.equal(rate.retryable, true);
  assert.equal(liveOk(h3, u3.id), true);
  assertNoLeaks(h3);
});

// ─────────────────────────────────────────────────────────────────────────────
// طلبات الشهادة الجارية (نتيجة متوسطة ×2 + عالية)
// ─────────────────────────────────────────────────────────────────────────────

test('POST /compliance جارٍ: استدعاء ثانٍ بالرمز نفسه أثناء انتظار الهيئة ⇒ IN_PROGRESS بلا إرسال، والأول يكمل حتى ACTIVE', async () => {
  const h = harness();
  const u = await newUnit(h);
  const otp = h.otps[0];
  const g = gate(h, url => url.endsWith('/compliance'));
  const first = onboard(h, u.id, otp);
  await g.inside;
  const second = failed(await onboard(h, u.id, otp), 'IN_PROGRESS');
  assert.equal(second.unit?.status, 'CSR_READY');
  assert.equal(second.unit?.complianceProgress?.inFlight?.op, 'compliance');
  assert.equal(count(h, 'compliance'), 1, 'الرمز لم يُرسل مرة ثانية');
  g.release();
  const a = ok(await first);
  assert.equal(a.unit.status, 'ACTIVE');
  assert.equal(h.zatca.issued.filter(i => i.kind === 'ccsid').length, 1);
  assert.equal(a.unit.complianceProgress?.inFlight, undefined, 'العلامة مُزالة بعد الحسم');
  assertNoLeaks(h);
});

test('POST /production/csids جارٍ: استدعاء ثانٍ ⇒ IN_PROGRESS، وشهادة إنتاج واحدة فقط تصدر', async () => {
  const h = harness();
  const u = await newUnit(h);
  const g = gate(h, url => url.endsWith('/production/csids'));
  const first = onboard(h, u.id, h.otps[0]);
  await g.inside;
  const second = failed(await onboard(h, u.id, null), 'IN_PROGRESS');
  assert.equal(second.unit?.status, 'CHECKS_PASSED');
  g.release();
  ok(await first);
  assert.equal(count(h, 'production-csid'), 1);
  assert.equal(h.zatca.issued.filter(i => i.kind === 'pcsid').length, 1);
  assert.equal(row(h, u.id).status, 'ACTIVE');
  assertNoLeaks(h);
});

test('ربط: خطأ مخزن عابر بعد إصدار CCSID أو PCSID ⇒ الحفظ يُعاد (شهادة واحدة لكل نوع، رمز واحد)؛ وكتابة وقعت ثم رمت ⇒ تُكتشف ولا تُطلب شهادة ثانية', async () => {
  const h = harness();
  const u = await newUnit(h);
  const thrown = new Set<string>();
  h.store.hooks.beforeCompareAndSet = (_id, _e, patch) => {
    if ((patch.status === 'CCSID_ISSUED' || patch.status === 'ACTIVE') && !thrown.has(patch.status)) {
      thrown.add(patch.status);
      throw new Error('db blip');
    }
  };
  const r = ok(await onboard(h, u.id, h.otps[0]));
  assert.equal(r.unit.status, 'ACTIVE');
  assert.equal(count(h, 'compliance'), 1);
  assert.equal(count(h, 'production-csid'), 1);
  assert.deepEqual(h.zatca.issued.map(i => i.kind), ['ccsid', 'pcsid']);
  assert.equal(h.zatca.otps.size, 2, 'رمز واحد استُهلك');
  assert.deepEqual(h.sleeps, [250, 250]);
  assertNoLeaks(h);

  // الكتابة طُبّقت ثم رمى المخزن (مهلة بعد الالتزام): إعادة التحميل تكشفها ⇒ نجاح بلا طلب آخر
  const h2 = harness();
  const u2 = await newUnit(h2);
  const orig = h2.store.compareAndSetUnit.bind(h2.store);
  let once = true;
  h2.store.compareAndSetUnit = async (id, expect, patch, at) => {
    const applied = await orig(id, expect, patch, at);
    if (patch.status === 'ACTIVE' && once) {
      once = false;
      throw new Error('timeout after commit');
    }
    return applied;
  };
  const r2 = ok(await onboard(h2, u2.id, h2.otps[0]));
  assert.equal(r2.unit.status, 'ACTIVE');
  assert.equal(count(h2, 'production-csid'), 1);
  assert.equal(row(h2, u2.id).productionToken, h2.zatca.current.production?.token);
  assertNoLeaks(h2);
});

test('علامة طلب جارٍ من عامل مات: IN_PROGRESS داخل المهلة، وبعدها يُستولى ويكمل', async () => {
  const h = harness();
  const u = await newUnit(h);
  const r0 = row(h, u.id);
  r0.complianceSteps = { ...(r0.complianceSteps as Record<string, unknown>), inFlight: { op: 'compliance', attemptId: 'dead-worker', at: h.clock.now().toISOString() } };
  r0.updatedAt = h.clock.now();
  failed(await onboard(h, u.id, h.otps[0]), 'IN_PROGRESS');
  assert.equal(h.zatca.calls.length, 0);
  h.clock.advance(10 * 60 * 1000);
  assert.equal(ok(await onboard(h, u.id, h.otps[0])).unit.status, 'ACTIVE');
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// الإيقاف بعد خطأ في منتصف الفحوص (نتيجة متوسطة)
// ─────────────────────────────────────────────────────────────────────────────

test('خطأ مخزن في نبض فحص امتثال ⇒ الإيقاف على أحدث نسخة (STORE_ERROR لا CONCURRENT_MODIFICATION، لا CHECKS_RUNNING عالقة) ثم استئناف فوري', async () => {
  const h = harness();
  const u = await newUnit(h);
  let beats = 0;
  h.store.hooks.beforeCompareAndSet = (_id, expect, patch) => {
    if (expect.status === 'CHECKS_RUNNING' && patch.status === undefined && patch.complianceSteps !== undefined && ++beats === 3) throw new Error('db blip');
  };
  const r = failed(await onboard(h, u.id, h.otps[0]), 'STORE_ERROR');
  assert.equal(r.unit?.status, 'CCSID_ISSUED');
  assert.equal(row(h, u.id).status, 'CCSID_ISSUED');
  assert.equal(row(h, u.id).lastError, 'STORE_ERROR');
  const resumed = ok(await onboard(h, u.id, null));
  assert.equal(resumed.unit.status, 'ACTIVE');
  assertNoLeaks(h);

  // تجديد 428: خطأ في النبض الثاني ⇒ عودة ACTIVE (لا RENEWING عالقة) ويلزم رمز جديد
  const h2 = harness({ zatca: { renewalMode: 428 } });
  const u2 = await activeUnit(h2);
  h2.store.hooks.beforeCompareAndSet = (_id, expect, patch) => {
    const steps = (patch.complianceSteps as { steps?: object } | undefined)?.steps;
    if (expect.status === 'RENEWING' && patch.status === undefined && steps && Object.keys(steps).length === 2) throw new Error('db blip');
  };
  const rr = failed(await renew(h2, u2.id, h2.renewalOtps[0]), 'STORE_ERROR');
  assert.equal(rr.unit?.status, 'ACTIVE');
  assert.equal(rr.needsNewOtp, true);
  assert.equal(row(h2, u2.id).status, 'ACTIVE');
  assert.equal(row(h2, u2.id).keyVersion, 1);
  assert.equal(liveOk(h2, u2.id), true);
  assertNoLeaks(h2);
});

// ─────────────────────────────────────────────────────────────────────────────
// abortRenewal (نتيجة متوسطة ×2)
// ─────────────────────────────────────────────────────────────────────────────

test('abortRenewal بلا OTP: RENEWING ميّتة قبل أي إرسال ⇒ الحالة الأصل؛ حيّة ⇒ IN_PROGRESS؛ بعد PATCH محتمل ⇒ غير مؤكَّد ولا عودة، والتجديد برمز يحسم', async () => {
  const h = harness();
  const u = await activeUnit(h);
  const r0 = row(h, u.id);
  r0.status = 'RENEWING';
  r0.updatedAt = h.clock.now();
  failed(await abort(h, u.id), 'IN_PROGRESS');
  failed(await renew(h, u.id, ''), 'OTP_REQUIRED');
  h.clock.advance(10 * 60 * 1000);
  const back = ok(await abort(h, u.id));
  assert.equal(back.unit.status, 'ACTIVE');
  assert.equal(liveOk(h, u.id), true, 'الإصدار عاد');
  assert.equal(h.zatca.calls.filter(c => c.endpoint === 'renewal').length, 0);
  failed(await abort(h, u.id), 'INVALID_STATE');

  // مات بعد تسجيل patch-sent: لا عودة إلى ACTIVE
  const r1 = row(h, u.id);
  r1.status = 'RENEWING';
  r1.complianceSteps = { ...(r1.complianceSteps as Record<string, unknown>), renewal: { origin: 'ACTIVE', stage: 'patch-sent', uncertain: false, attemptId: 'dead', at: h.clock.now().toISOString() } };
  r1.updatedAt = new Date(h.clock.now().getTime() - 11 * 60 * 1000);
  const unconfirmed = failed(await abort(h, u.id), 'RENEWAL_UNCONFIRMED');
  assert.equal(unconfirmed.detail, 'stale:patch-sent');
  assert.equal(unconfirmed.unit?.status, 'RENEWING');
  assert.equal(unconfirmed.unit?.complianceProgress?.renewal?.stage, 'unconfirmed');
  // متوقّفة لا جارية: لا انتظار مهلة
  assert.equal(failed(await abort(h, u.id), 'RENEWAL_UNCONFIRMED').detail, 'unconfirmed');
  const settled = ok(await renew(h, u.id, h.renewalOtps[0]));
  assert.equal(settled.unit.status, 'ACTIVE');
  assert.equal(settled.unit.keyVersion, 2);

  // الأصل EXPIRED محفوظ في العلامة
  const h2 = harness();
  const u2 = await activeUnit(h2);
  const r2 = row(h2, u2.id);
  r2.status = 'RENEWING';
  r2.complianceSteps = { ...(r2.complianceSteps as Record<string, unknown>), renewal: { origin: 'EXPIRED', stage: 'waiting', uncertain: false, attemptId: 'dead', at: h2.clock.now().toISOString() } };
  r2.updatedAt = new Date(h2.clock.now().getTime() - 11 * 60 * 1000);
  assert.equal(ok(await abort(h2, u2.id)).unit.status, 'EXPIRED');
  assertNoLeaks(h);
  assertNoLeaks(h2);
});

// ─────────────────────────────────────────────────────────────────────────────
// رفض CSR وحقول CSR من البيانات الحالية (نتيجة متوسطة)
// ─────────────────────────────────────────────────────────────────────────────

test('Invalid-CSR ⇒ ERROR_NEEDS_OTP؛ بعد تصحيح بيانات المنشأة يبني الرمز التالي طلباً جديداً منها؛ وCSR_READY يُعاد بناؤه قبل الرمز إن تغيّر الاسم', async () => {
  let complianceCalls = 0;
  const h = harness({ zatca: { onCompliance: () => (++complianceCalls === 1 ? { status: 400, body: { errors: [{ code: 'Invalid-CSR', message: 'invalid csr' }] } } : undefined) } });
  const u = await newUnit(h);
  const rej = failed(await onboard(h, u.id, h.otps[0]), 'CSID_REQUEST_REJECTED');
  assert.equal(rej.unit?.status, 'ERROR_NEEDS_OTP');
  assert.equal(rej.needsNewOtp, true);
  const firstCsr = Buffer.from(String(h.zatca.calls[0].body?.csr), 'base64').toString('utf8');

  const s = h.store.settings.get(TENANT) as SellerSettingsRecord;
  s.legalName = 'Beta Trading Company';
  s.addrCity = 'Jeddah';
  const done = ok(await onboard(h, u.id, h.otps[1]));
  assert.equal(done.unit.status, 'ACTIVE');
  const sent = h.zatca.calls.filter(c => c.endpoint === 'compliance').map(c => Buffer.from(String(c.body?.csr), 'base64').toString('utf8'));
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1], firstCsr, 'لا يُعاد إرسال الطلب المرفوض');
  const fields = parseCsr(sent[1]).fields;
  assert.equal(fields.orgName, 'Beta Trading Company');
  assert.match(fields.locationAddress ?? '', /Jeddah/, 'العنوان من المنشأة الحالية');
  assert.equal(row(h, u.id).orgName, 'Beta Trading Company');
  assert.match(row(h, u.id).locationAddress, /Jeddah/);
  assertNoLeaks(h);

  // CSR_READY: الاسم تغيّر قبل أي إرسال ⇒ طلب جديد بلا كلفة رمز
  const h2 = harness();
  const u2 = await newUnit(h2);
  (h2.store.settings.get(TENANT) as SellerSettingsRecord).legalName = 'Gamma Supplies';
  ok(await onboard(h2, u2.id, h2.otps[0]));
  assert.equal(count(h2, 'compliance'), 1);
  assert.equal(parseCsr(Buffer.from(String(h2.zatca.calls[0].body?.csr), 'base64').toString('utf8')).fields.orgName, 'Gamma Supplies');
  assertNoLeaks(h2);

  // التجديد: العنوان يُحدَّث (تجاوز صريح هنا) ويُحفظ مع التبديل
  const h3 = harness();
  const u3 = await activeUnit(h3);
  const location = 'Bldg 7788, Jeddah 21577';
  ok(await renew(h3, u3.id, h3.renewalOtps[0], { csrFields: { locationAddress: location } }));
  const patchCsr = Buffer.from(String(h3.zatca.calls.find(c => c.endpoint === 'renewal')?.body?.csr), 'base64').toString('utf8');
  assert.equal(parseCsr(patchCsr).fields.locationAddress, location);
  assert.equal(row(h3, u3.id).locationAddress, location);
  assertNoLeaks(h3);
});

// ─────────────────────────────────────────────────────────────────────────────
// وحدة واحدة لكل شركة وبيئة + retireUnit (نتيجتان منخفضتان)
// ─────────────────────────────────────────────────────────────────────────────

test('createUnit متزامنان ⇒ وحدة واحدة؛ retireUnit يتيح وحدة جديدة؛ تجديد وحدة منتهية أو تفعيل ثانية مع وحدة أخرى ⇒ OTHER_UNIT_EXISTS', async () => {
  const h = harness();
  const both = await Promise.all([create(h), create(h)]);
  assert.deepEqual(both.map(r => r.ok).sort(), [false, true]);
  failed(both.find(r => !r.ok) as { ok: boolean }, 'UNIT_EXISTS');
  assert.equal(h.store.units.size, 1);

  // التخلّي عن وحدة لم تكتمل يفتح الطريق لوحدة جديدة
  const pending = (both.find(r => r.ok) as { unit: EgsUnitView }).unit;
  failed(await retire(h, pending.id, { reason: 'bogus' as never }), 'INVALID_INPUT');
  const gone = ok(await retire(h, pending.id));
  assert.equal(gone.unit.status, 'REVOKED');
  assert.equal(gone.alreadyRetired, false);
  assert.equal(row(h, pending.id).revokedAt?.getTime(), h.clock.now().getTime());
  assert.equal(ok(await retire(h, pending.id)).alreadyRetired, true);
  failed(await onboard(h, pending.id, h.otps[0]), 'INVALID_STATE');
  const a = ok(await onboard(h, ok(await create(h)).unit.id, h.otps[0])).unit;
  assert.equal(a.status, 'ACTIVE');

  // وحدة منتهية + بديل قيد الربط: تجديد المنتهية مرفوض قبل أي كتابة
  row(h, a.id).status = 'EXPIRED';
  const b = ok(await create(h)).unit;
  const writes = casWrites(h);
  const refused = failed(await renew(h, a.id, h.renewalOtps[0]), 'OTHER_UNIT_EXISTS');
  assert.equal(refused.unit?.status, 'EXPIRED');
  assert.equal(casWrites(h), writes);
  assert.equal(count(h, 'renewal'), 0);

  // وحدة أخرى مفعّلة (سباق/إرث): الثانية لا تطلب شهادة إنتاج
  row(h, a.id).status = 'ACTIVE';
  const productionBefore = count(h, 'production-csid');
  const second = failed(await onboard(h, b.id, h.otps[1]), 'OTHER_UNIT_EXISTS');
  assert.equal(second.unit?.status, 'CHECKS_PASSED');
  assert.equal(count(h, 'production-csid'), productionBefore);

  // إيقاف وحدة تحمل شهادة إنتاج يحتاج «إيقاف»، ثم تكمل الثانية ويُفعَّل
  failed(await retire(h, a.id, { reason: 'revoked-in-portal' }), 'RETIRE_CONFIRMATION_REQUIRED');
  const revoked = ok(await retire(h, a.id, { reason: 'revoked-in-portal', typedConfirmation: ` ${RETIRE_CONFIRMATION_TEXT} ` }));
  assert.equal(revoked.unit.status, 'REVOKED');
  assert.equal(liveOk(h, a.id), false);
  assert.equal(ok(await onboard(h, b.id, null)).unit.status, 'ACTIVE');
  const live = ok(await goLive({ store: h.store, policy: h.policy, now: h.clock.now, tenantId: TENANT, actorId: ACTOR, confirmations: { repsSynced: true, typedConfirmation: GO_LIVE_CONFIRMATION_TEXT } }));
  assert.equal(live.unitId, b.id);
  assert.ok(h.store.apiLogs.some(l => l.endpoint === 'ui:retire-unit' && l.outcome === 'OK'));
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// فحوص التجديد قبل إيقاف الإصدار (نتيجة منخفضة)
// ─────────────────────────────────────────────────────────────────────────────

test('تجديد مع مستندات جارية وبيانات لا تصلح ⇒ الرفض فوراً بلا RENEWING ولا انتظار', async () => {
  const h = harness();
  const u = await activeUnit(h);
  h.store.documents.push({ egsUnitId: u.id, status: 'SIGNED' });
  const writes = casWrites(h);
  const s = h.store.settings.get(TENANT) as SellerSettingsRecord;
  s.taxNumber = '399999999800003';
  failed(await renew(h, u.id, h.renewalOtps[0]), 'SELLER_VAT_CHANGED');
  s.taxNumber = row(h, u.id).vatNumber;
  s.legalName = 'Alpha & Sons';
  failed(await renew(h, u.id, h.renewalOtps[0]), 'CSR_PARAMS_INVALID');
  assert.deepEqual(h.sleeps, [], 'لا انتظار للمستندات');
  assert.equal(casWrites(h), writes, 'لا RENEWING');
  assert.equal(row(h, u.id).status, 'ACTIVE');
  assert.equal(count(h, 'renewal'), 0);
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// الأسرار المخزَّنة (نتيجتان)
// ─────────────────────────────────────────────────────────────────────────────

test('سرّ مخزَّن تالف (مفتاح الوحدة في CCSID_ISSUED، سرّ الامتثال في CHECKS_PASSED) ⇒ STORED_SECRET_INVALID وERROR_NEEDS_OTP، ورمز جديد يكمل', async () => {
  const h = harness({ zatca: { onCheck: (_c, n) => (n === 4 ? { status: 503, raw: '' } : undefined) } });
  const u = await newUnit(h);
  failed(await onboard(h, u.id, h.otps[0]), 'ZATCA_RETRY');
  assert.equal(row(h, u.id).status, 'CCSID_ISSUED');
  row(h, u.id).privateKeyEnc = corrupt(row(h, u.id).privateKeyEnc as string);
  const bad = failed(await onboard(h, u.id, null), 'STORED_SECRET_INVALID');
  assert.equal(bad.detail, 'DECRYPT_FAILED');
  assert.equal(bad.unit?.status, 'ERROR_NEEDS_OTP');
  assert.equal(bad.needsNewOtp, true);
  assert.equal(ok(await onboard(h, u.id, h.otps[1])).unit.status, 'ACTIVE');
  assertNoLeaks(h);

  const h2 = harness({ zatca: { onProduction: (_c, n) => (n === 1 ? { status: 503, raw: '' } : undefined) } });
  const u2 = await newUnit(h2);
  failed(await onboard(h2, u2.id, h2.otps[0]), 'ZATCA_RETRY');
  assert.equal(row(h2, u2.id).status, 'CHECKS_PASSED');
  row(h2, u2.id).complianceSecretEnc = corrupt(row(h2, u2.id).complianceSecretEnc as string);
  const bad2 = failed(await onboard(h2, u2.id, null), 'STORED_SECRET_INVALID');
  assert.equal(bad2.unit?.status, 'ERROR_NEEDS_OTP');
  assert.equal(ok(await onboard(h2, u2.id, h2.otps[1])).unit.status, 'ACTIVE');
  assertNoLeaks(h2);
});

test('حلقة مفاتيح لا تفتح مفتاح الوحدة ⇒ SECRETS_UNAVAILABLE قبل إرسال الرمز (لا يُستهلك)، ثم الحلقة الصحيحة تكمل', async () => {
  const h = harness();
  const u = await newUnit(h);
  const otp = h.otps[0];
  const wrong = failed(await onboard(h, u.id, otp, { keyring: createKeyring({ current: crypto.randomBytes(32) }) }), 'SECRETS_UNAVAILABLE');
  assert.equal(wrong.detail, 'UNKNOWN_KEY_ID');
  assert.equal(wrong.unit?.status, 'CSR_READY');
  assert.equal(h.zatca.calls.length, 0);
  assert.ok(h.zatca.otps.has(otp), 'الرمز لم يُستهلك');
  assert.equal(ok(await onboard(h, u.id, otp)).unit.status, 'ACTIVE');
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// detail من رموز الهيئة (نتيجة منخفضة)
// ─────────────────────────────────────────────────────────────────────────────

test('رمز خطأ من الهيئة يحمل OTP ⇒ لا يظهر في detail ولا في النتيجة، وسجلّ ui:onboard يبقى دليلاً كاملاً', async () => {
  let otp = '';
  const h = harness({ zatca: { onCompliance: () => ({ status: 400, body: { errors: [{ code: `Invalid-OTP:${otp}`, message: `OTP ${otp} is not valid` }] } }) } });
  const u = await newUnit(h);
  otp = h.otps[0];
  const r = failed(await onboard(h, u.id, otp), 'NEW_OTP_REQUIRED');
  assert.ok(!JSON.stringify(r).includes(otp), 'OTP في النتيجة');
  assert.ok(r.detail === undefined || !r.detail.includes(otp));
  const log = h.store.apiLogs.find(l => l.endpoint === 'ui:onboard');
  assert.ok(log && log.response !== null, 'السجلّ لم يُسقط');
  assert.deepEqual({ from: (log.response as { from: string }).from, to: (log.response as { to: string }).to }, { from: 'CSR_READY', to: 'CSR_READY' });
  assertNoLeaks(h);
});

// ─────────────────────────────────────────────────────────────────────────────
// لقطة المطالبة القديمة (نتيجة منخفضة)
// ─────────────────────────────────────────────────────────────────────────────

test('تجديد اكتمل بين قراءة الوحدة ومطالبتها ⇒ الثاني يُرفض CONCURRENT_MODIFICATION بلا PATCH (لا keyVersion مكرّر ولا إبطال للشهادة الجديدة)', async () => {
  const h = harness();
  const u = await activeUnit(h);
  const [otpA, otpB] = h.renewalOtps;
  let ranB = false;
  let resultB: Awaited<ReturnType<typeof renew>> | null = null;
  h.store.hooks.beforeCompareAndSet = async (_id, expect, patch) => {
    if (!ranB && expect.status === 'ACTIVE' && patch.status === 'RENEWING') {
      ranB = true;
      resultB = await renew(h, u.id, otpB);
    }
  };
  const a = failed(await renew(h, u.id, otpA), 'CONCURRENT_MODIFICATION');
  assert.equal(a.detail, 'renewed-meanwhile');
  const b = ok(resultB as unknown as Awaited<ReturnType<typeof renew>>);
  assert.equal(b.unit.keyVersion, 2);
  const stored = row(h, u.id);
  assert.equal(stored.status, 'ACTIVE');
  assert.equal(stored.keyVersion, 2);
  assert.equal(stored.productionToken, h.zatca.current.production?.token);
  assert.equal(count(h, 'renewal'), 1);
  assert.ok(h.zatca.renewalOtps.has(otpA), 'رمز الثاني لم يُستهلك');
  assert.equal(liveOk(h, u.id), true);
  assert.deepEqual(endpoints(h).filter(e => e === 'compliance-invoices').length, ALL_STEPS.length);
  assertNoLeaks(h);
});
