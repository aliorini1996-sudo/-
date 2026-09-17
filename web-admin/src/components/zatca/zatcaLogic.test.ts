/**
 * حرّاس منطق تبويب «الفوترة الإلكترونية — المرحلة الثانية (فاتورة)».
 *
 * ما يحرسه:
 *  - رمز التحقق: أرقام لاتينية ستّة فقط (الأرقام العربية تُطبَّع)، ولا يتسرّب من خطأ axios (config.data يحمله).
 *  - صيغ بيانات المنشأة تُفحص حين تُدخل قيمة فقط، ومطابقة لقواعد الخادم (routes/zatca.ts).
 *  - مصفوفة الإجراءات لكل حالة وحدة، والاستطلاع ما دامت عملية جارية فقط (لا استطلاع أبدي لعامل مات).
 *  - كل تسمية عربية في المنطق لها ترجمة بالإنجليزية والفرنسية والتركية والصينية.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PHRASES } from '../../i18n/strings';
import type { ZatcaJobOutcome, ZatcaJobView, ZatcaReadinessIssue, ZatcaUnitPayload, ZatcaUnitView } from '../../types';
import {
  CARD_STATUS_EXTRA_LABELS, CHECKLIST_LABEL, ENV_LABEL, ENV_SHORT_LABEL, OTP_INPUT_MAX_LENGTH, POLL_SLOW_MS, RENEWAL_STAGE_LABEL, RETIRE_REASON_LABEL,
  SELLER_FIELDS, SELLER_FIELD_LABEL, SELLER_ID_SCHEME_LABEL, UNIT_STATUS_LABEL, apiErrorOf, cardControls, cardStatusLabel, certDateLabel, certValidity,
  creatableEnvs, csrFailureFix, csrFieldTarget, csrIssueFor, csrLocationDefaults, csrLocationHint, csrOrgNameHint, defaultRetireReason, draftErrors,
  draftOf, failureOf, isOtpComplete, isVatGroup, liveUnits, mergeSellerDraft, normalizeOtp, overviewView, primaryUnit, problemBanners, problemOf,
  sellerBaselineAfterSave, sellerFieldError, sellerPatch, shouldPoll, shouldRetryUnitFetch, statusLabel, unitActions, unitPollInterval,
} from './zatcaLogic';
import { ZATCA_PHRASES, zatcaTranslate } from './zatcaPhrases';
import { keepLocalEdits } from './settingsMerge';
import { supportedCountries } from '../../i18n/countries';
import {
  COMPANY_SELLER_ERROR_CODES, COMPANY_SELLER_ERROR_PHRASES, COMPANY_SELLER_FIELD_ERROR_PHRASES, ZATCA_TAB_ROLE, companySaveErrorMessage, companySaveNeedsRefetch,
  withoutLockedSellerFields, zatcaCountryChoiceAllowed, zatcaSellerFieldsLocked, zatcaSellerLockHint, zatcaTabVisible,
} from './zatcaAccess';
import ZatcaTabBoundary, { ZatcaTabLoadError } from './ZatcaTabBoundary';
import { QueryClient, QueryObserver, onlineManager } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFormControl } from 'react-hook-form';

/** مدخل القاموس كما يراه التبويب: عبارات التبويب (الحزمة الكسولة) ثم القاموس العامّ. */
const phrase = (ar: string) => ZATCA_PHRASES[ar] ?? PHRASES[ar];

const NOW = new Date('2026-09-17T09:00:00.000Z');

function unit(over: Partial<ZatcaUnitView> = {}): ZatcaUnitView {
  return {
    id: 'u1', tenantId: 't1', environment: 'simulation', status: 'CSR_READY', commonName: 'FS-399999999900003-abcd1234', serialNumber: 's', functionMap: '1100',
    orgName: 'o', orgUnit: 'ou', vatNumber: '399999999900003', locationAddress: 'l', industry: 'i', keyVersion: 1, publicKeyPem: null, complianceRequestId: null,
    complianceProgress: null, certSerial: null, certNotBefore: null, certNotAfter: null, lastIcv: 0, activatedAt: null, revokedAt: null, lastError: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-17T08:59:00.000Z', ...over,
  };
}

function payload(u: Partial<ZatcaUnitView> = {}, extra: Partial<ZatcaUnitPayload> = {}): ZatcaUnitPayload {
  return {
    unit: unit(u), job: null, activity: { busy: false, reason: null },
    checklist: { phase: 'onboarding', items: [], checksPassed: 0, checksTotal: 6, renewal: null }, ...extra,
  };
}

test('OTP: أرقام لاتينية ستّة فقط — العربية تُطبَّع واللصق بمسافات يُقبل', () => {
  assert.equal(normalizeOtp('١٢٣ ٤٥٦'), '123456');
  assert.equal(normalizeOtp('12-34-56-78'), '123456');
  assert.equal(normalizeOtp('۱۲۳abc'), '123');
  assert.equal(isOtpComplete('123456'), true);
  assert.equal(isOtpComplete('12345'), false);
  assert.equal(isOtpComplete('12345a'), false);
});

test('بيانات المنشأة: الصيغ تُفحص حين تُدخل قيمة فقط (مطابقة لقواعد الخادم)', () => {
  assert.equal(sellerFieldError('taxNumber', ''), null);
  assert.equal(sellerFieldError('taxNumber', '399999999900003'), null);
  assert.equal(sellerFieldError('taxNumber', '٣٩٩٩٩٩٩٩٩٩٠٠٠٠٣'), null);
  assert.ok(sellerFieldError('taxNumber', '499999999900003'));
  assert.ok(sellerFieldError('taxNumber', '39999999990000'));
  assert.equal(sellerFieldError('addrBuildingNo', '2322'), null);
  assert.ok(sellerFieldError('addrBuildingNo', '232'));
  assert.equal(sellerFieldError('addrPostalCode', '12345'), null);
  assert.ok(sellerFieldError('addrPostalCode', '1234'));
  assert.equal(sellerFieldError('vatGroupTin', '1234567890'), null);
  assert.ok(sellerFieldError('vatGroupTin', '123456789'));
  assert.equal(sellerFieldError('sellerIdScheme', 'crn'), null);
  assert.ok(sellerFieldError('sellerIdScheme', 'XYZ'));
  assert.ok(sellerFieldError('sellerIdValue', '10 10'));
  assert.equal(sellerFieldError('addrAdditionalNo', 'أي شيء'), null, 'الرقم الإضافي بلا قاعدة صيغة');
  assert.equal(isVatGroup('399999999910003'), true);
  assert.equal(isVatGroup('399999999900003'), false);
  const errs = draftErrors({ ...draftOf(null), taxNumber: '1', addrPostalCode: '9' });
  assert.deepEqual(Object.keys(errs).sort(), ['addrPostalCode', 'taxNumber']);
});

test('sellerPatch: يرسل ما تغيّر فقط، والفراغ إفراغ (null)، والأرقام العربية تُطبَّع', () => {
  const original = { legalName: 'شركة', taxNumber: '399999999900003', addrCity: 'الرياض', commercialReg: null };
  const draft = { ...draftOf(original), legalName: ' شركة ', addrCity: '', addrBuildingNo: '٢٣٢٢', commercialReg: '' };
  assert.deepEqual(sellerPatch(original, draft), { addrCity: null, addrBuildingNo: '2322' });
  assert.deepEqual(sellerPatch(original, draftOf(original)), {});
});

test('الإجراءات لكل حالة: OTP في CSR_READY/ERROR_NEEDS_OTP، متابعة بلا رمز، تجديد، إلغاء تجديد متوقّف، ولا شيء أثناء العمل', () => {
  assert.deepEqual(unitActions(payload({ status: 'CSR_READY' })), { busy: false, needsOtp: true, canResume: false, canRenew: false, canAbort: false, canRetire: true });
  assert.equal(unitActions(payload({ status: 'ERROR_NEEDS_OTP' })).needsOtp, true);
  assert.equal(unitActions(payload({ status: 'CCSID_ISSUED' })).canResume, true);
  assert.equal(unitActions(payload({ status: 'ACTIVE' })).canRenew, true);
  assert.equal(unitActions(payload({ status: 'EXPIRED' })).canRenew, true);
  assert.equal(unitActions(payload({ status: 'AUTH_FAILED' })).canRenew, false);
  assert.equal(unitActions(payload({ status: 'REVOKED' })).canRetire, false);
  const stalled = payload({ status: 'RENEWING', complianceProgress: { v: 1, phase: 'renewal', keyVersion: 1, requestId: null, steps: {}, renewal: { origin: 'ACTIVE', stage: 'waiting', uncertain: false, at: '' } } });
  assert.equal(unitActions(stalled).canAbort, true);
  const unconfirmed = payload({ status: 'RENEWING', complianceProgress: { v: 1, phase: 'renewal', keyVersion: 1, requestId: null, steps: {}, renewal: { origin: 'ACTIVE', stage: 'unconfirmed', uncertain: true, at: '' } } });
  assert.equal(unitActions(unconfirmed).canAbort, false, 'غير المؤكَّد لا يُلغى بلا رمز');
  assert.equal(unitActions(unconfirmed).canRenew, true);
  const busy = payload({ status: 'CSR_READY' }, { job: { id: 'j', kind: 'onboard', state: 'running', startedAt: '', finishedAt: null, outcome: null } });
  assert.deepEqual(unitActions(busy), { busy: true, needsOtp: false, canResume: false, canRenew: false, canAbort: false, canRetire: false });
});

test('الاستطلاع ونتيجة الفشل: busy أو مهمّة جارية فقط؛ الفشل من مهمّة منتهية', () => {
  assert.equal(shouldPoll(payload()), false);
  assert.equal(shouldPoll(payload({}, { activity: { busy: true, reason: 'checks' } })), true);
  assert.equal(shouldPoll(null), false);
  const outcome = { ok: false, code: 'NEW_OTP_REQUIRED', messageAr: 'م', retryable: false, needsNewOtp: true, zatcaMessages: [], detail: null, step: null, field: null, issues: [] };
  assert.equal(failureOf(payload({}, { job: { id: 'j', kind: 'onboard', state: 'finished', startedAt: '', finishedAt: '', outcome } })), outcome);
  assert.equal(failureOf(payload({}, { job: { id: 'j', kind: 'onboard', state: 'running', startedAt: '', finishedAt: null, outcome } })), null);
  assert.equal(failureOf(payload({}, { job: { id: 'j', kind: 'onboard', state: 'finished', startedAt: '', finishedAt: '', outcome: { ...outcome, ok: true } } })), null);
});

test('صلاحية الشهادة ولافتات المشكلات', () => {
  assert.deepEqual(certValidity(unit(), NOW), { state: 'none', daysLeft: null });
  assert.equal(certValidity(unit({ certNotAfter: '2027-09-17T09:00:00.000Z' }), NOW).state, 'valid');
  assert.equal(certValidity(unit({ certNotAfter: '2026-10-01T09:00:00.000Z' }), NOW).state, 'expiring');
  assert.equal(certValidity(unit({ certNotAfter: '2026-09-01T09:00:00.000Z' }), NOW).state, 'expired');
  assert.equal(problemOf(unit({ status: 'AUTH_FAILED' }), NOW), 'AUTH_FAILED');
  assert.equal(problemOf(unit({ status: 'REVOKED' }), NOW), null, 'وحدة تُركت قبل التفعيل لا تُنذر');
  assert.equal(problemOf(unit({ status: 'REVOKED', environment: 'production', activatedAt: '2026-01-01T00:00:00.000Z' }), NOW), 'REVOKED_ACTIVE');
  assert.equal(problemOf(unit({ status: 'ACTIVE', certNotAfter: '2026-09-20T00:00:00.000Z' }), NOW), 'EXPIRING');
  assert.equal(problemOf(unit({ status: 'EXPIRED' }), NOW), 'EXPIRED');
  const oldRevoked = payload({ id: 'old', status: 'REVOKED', environment: 'production', activatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' });
  const replacement = payload({ id: 'new', status: 'ACTIVE', environment: 'production', certNotAfter: '2028-01-01T00:00:00.000Z', createdAt: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual(problemBanners([oldRevoked, replacement], NOW), [], 'وحدة موقوفة استُبدلت لا تُنذر');
  assert.equal(problemBanners([oldRevoked], NOW)[0].kind, 'REVOKED_ACTIVE');
});

test('الوحدة الرئيسية والبيئات المتاحة للإنشاء', () => {
  const sim = payload({ id: 'sim', environment: 'simulation', status: 'ACTIVE' });
  const prod = payload({ id: 'prod', environment: 'production', status: 'CSR_READY' });
  const prodActive = payload({ id: 'prod2', environment: 'production', status: 'ACTIVE' });
  assert.equal(primaryUnit([sim, prod])?.unit.id, 'sim', 'المربوطة قبل الجارية');
  assert.equal(primaryUnit([sim, prodActive])?.unit.id, 'prod2', 'الإنتاج قبل المحاكاة');
  assert.equal(primaryUnit([]), null);
  assert.deepEqual(creatableEnvs(['simulation', 'production'], [sim]), ['production']);
  assert.deepEqual(creatableEnvs(['simulation'], [payload({ status: 'REVOKED' })]), ['simulation']);
});

test('apiErrorOf يقرأ ردّ الخادم وحده — لا config.data (جسم الطلب بالرمز)', () => {
  const err = {
    config: { data: JSON.stringify({ otp: '482913' }) },
    response: { status: 400, data: { code: 'OTP_INVALID_FORMAT', message: 'رمز التحقق يجب أن يكون ستة أرقام', needsNewOtp: false, fieldErrors: [{ field: 'taxNumber', messageAr: 'م' }, { bad: 1 }] } },
  };
  const e = apiErrorOf(err);
  assert.equal(e.status, 400);
  assert.equal(e.code, 'OTP_INVALID_FORMAT');
  assert.equal(e.fieldErrors.length, 1);
  assert.ok(!JSON.stringify(e).includes('482913'));
  assert.deepEqual(apiErrorOf(new Error('network')), { status: null, code: null, message: null, needsNewOtp: false, retryable: false, field: null, fieldErrors: [], issues: [] });
  assert.equal(apiErrorOf({ response: { status: 422, data: { code: 'CSR_PARAMS_INVALID', field: 'orgName' } } }).field, 'orgName');
});

test('التسميات: كل حالة وبيئة وخطوة لها تسمية عربية ولكل تسمية ترجمة كاملة بأربع لغات', () => {
  for (const s of ['DRAFT', 'CSR_READY', 'CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED', 'ERROR_NEEDS_OTP', 'ACTIVE', 'RENEWING', 'AUTH_FAILED', 'EXPIRED', 'REVOKED']) {
    assert.ok(UNIT_STATUS_LABEL[s as keyof typeof UNIT_STATUS_LABEL], `الحالة ${s} بلا تسمية`);
  }
  assert.equal(statusLabel('SOMETHING').label, 'حالة غير معروفة');
  assert.equal(ENV_LABEL.simulation, 'بيئة المحاكاة — للاختبار، لا تُنتج فواتير حقيقية');
  const labels = [
    ...Object.values(UNIT_STATUS_LABEL).map(x => x.label), 'حالة غير معروفة', ...Object.values(ENV_LABEL), ...Object.values(ENV_SHORT_LABEL),
    ...Object.values(CHECKLIST_LABEL), ...Object.values(RENEWAL_STAGE_LABEL), ...Object.values(RETIRE_REASON_LABEL),
    ...SELLER_FIELDS.map(f => SELLER_FIELD_LABEL[f]), ...Object.values(SELLER_ID_SCHEME_LABEL),
  ];
  for (const l of labels) {
    const t = phrase(l);
    assert.ok(t, `التسمية «${l}» بلا مدخل في القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${l}» بلا ترجمة ${lang}`);
  }
});

// ─── مراجعة Z4: مسارات الاستئناف، الاستطلاع عند الخطأ، لصق الرمز، البيئة، قيود طلب الشهادة، رأس الحالة الحيّ ───

const finished = (outcome: ZatcaJobOutcome): ZatcaJobView => ({ id: 'j', kind: 'onboard', state: 'finished', startedAt: '', finishedAt: '', outcome });
const outcomeOf = (code: string, over: { retryable?: boolean; needsNewOtp?: boolean } = {}): ZatcaJobOutcome =>
  ({ ok: false, code, messageAr: 'م', retryable: over.retryable ?? false, needsNewOtp: over.needsNewOtp ?? false, zatcaMessages: [], detail: null, step: null, field: null, issues: [] });

test('بطاقة الوحدة: فشل غير قابل لإعادة المحاولة وبلا رمز جديد في حالة قابلة للاستئناف يُبقي «متابعة الربط» (لا طريق مسدود 6 ساعات)', () => {
  for (const code of ['ZATCA_CONFIG', 'SIGNER_FAILED', 'SAMPLES_FAILED', 'SELLER_DATA_INCOMPLETE', 'SELLER_VAT_CHANGED', 'SECRETS_UNAVAILABLE', 'OTHER_UNIT_EXISTS']) {
    for (const status of ['CCSID_ISSUED', 'CHECKS_PASSED'] as const) {
      const c = cardControls(payload({ status }, { job: finished(outcomeOf(code)) }), ['simulation']);
      assert.equal(c.showResume, true, `${code} في ${status} أخفى المتابعة`);
      assert.equal(c.showRetry, false);
      assert.equal(c.newOtpAction, null);
    }
  }
  const retryable = cardControls(payload({ status: 'CHECKS_PASSED' }, { job: finished(outcomeOf('ZATCA_RETRY', { retryable: true })) }), ['simulation']);
  assert.deepEqual([retryable.showRetry, retryable.showResume], [true, false], 'القابل لإعادة المحاولة: زرّ واحد لا زرّان');
  const clean = cardControls(payload({ status: 'CCSID_ISSUED' }), ['simulation']);
  assert.deepEqual([clean.showResume, clean.showRetry], [true, false]);
  const busy = cardControls(payload({ status: 'CHECKS_PASSED' }, { activity: { busy: true, reason: 'checks' } }), ['simulation']);
  assert.deepEqual([busy.showResume, busy.showRetry, busy.showOtpForm, busy.showRenew], [false, false, false, false]);
});

test('«أدخل رمزاً جديداً» لا يظهر زرّاً بلا أثر: خانة الرمز أو التجديد، وAUTH_FAILED بعد رفض شهادة التجديد ⇒ «أوقف الوحدة واربط وحدة جديدة»', () => {
  const needs = (status: string) => payload({ status: status as ZatcaUnitView['status'] }, { job: finished(outcomeOf('CSID_CERT_INVALID', { needsNewOtp: true })) });
  assert.equal(cardControls(needs('CSR_READY'), ['simulation']).newOtpAction, 'focus-otp');
  assert.equal(cardControls(needs('ERROR_NEEDS_OTP'), ['simulation']).newOtpAction, 'focus-otp');
  assert.equal(cardControls(needs('ACTIVE'), ['simulation']).newOtpAction, 'open-renew');
  assert.equal(cardControls(needs('AUTH_FAILED'), ['simulation']).newOtpAction, 'open-retire');
  assert.equal(cardControls(needs('AUTH_FAILED'), []).newOtpAction, 'open-retire', 'الإيقاف لا يكلّم الهيئة فلا يتقيّد بالبيئة');
  assert.equal(cardControls(needs('REVOKED'), ['simulation']).newOtpAction, null);
  assert.equal(cardControls(needs('CSR_READY'), []).newOtpAction, null, 'بيئة غير مسموحة: لا دعوة لرمز سيرفضه الخادم');
});

test('بيئة الوحدة خارج ZATCA_ALLOWED_ENVS: لا خانة رمز ولا متابعة ولا تجديد (الخادم 403 ENV_NOT_ALLOWED)، والإيقاف وإلغاء التجديد باقيان', () => {
  const pending = cardControls(payload({ status: 'CSR_READY', environment: 'production' }), ['simulation']);
  assert.deepEqual([pending.envAllowed, pending.showOtpForm, pending.canRetire], [false, false, true]);
  assert.equal(cardControls(payload({ status: 'CHECKS_PASSED', environment: 'production' }), ['simulation']).showResume, false);
  const active = cardControls(payload({ status: 'ACTIVE', environment: 'production' }), ['simulation']);
  assert.deepEqual([active.showRenew, active.canRetire], [false, true]);
  const stalled = payload({ status: 'RENEWING', environment: 'production', complianceProgress: { v: 1, phase: 'renewal', keyVersion: 1, requestId: null, steps: {}, renewal: { origin: 'ACTIVE', stage: 'waiting', uncertain: false, at: '' } } });
  assert.equal(cardControls(stalled, []).canAbort, true);
  const ok = cardControls(payload({ status: 'CSR_READY' }), ['simulation']);
  assert.deepEqual([ok.envAllowed, ok.showOtpForm], [true, true]);
});

test('الاستطلاع: خطأ ⇒ توقّف (لا 2 ث إلى الأبد على 403/404/429)، أبطأ بعد الدقيقة الأولى أو لعامل آخر، وإعادة الجلب للشبكة و5xx وحدها', () => {
  const now = Date.parse('2026-09-17T09:00:00.000Z');
  const running = (startedAt: string) => payload({}, { job: { id: 'j', kind: 'renew', state: 'running', startedAt, finishedAt: null, outcome: null }, activity: { busy: true, reason: 'job' } });
  assert.equal(unitPollInterval({ status: 'error', data: running('2026-09-17T08:59:50.000Z') }, 2000, now), false, 'البيانات «المشغولة» المخزّنة لا تُبقي الاستطلاع بعد الخطأ');
  assert.equal(unitPollInterval({ status: 'success', data: running('2026-09-17T08:59:50.000Z') }, 2000, now), 2000);
  assert.equal(unitPollInterval({ status: 'success', data: running('2026-09-17T08:55:00.000Z') }, 2000, now), POLL_SLOW_MS);
  assert.equal(unitPollInterval({ status: 'success', data: payload({}, { activity: { busy: true, reason: 'renewal' } }) }, 2000, now), POLL_SLOW_MS);
  assert.equal(unitPollInterval({ status: 'success', data: payload() }, 2000, now), false);
  assert.equal(unitPollInterval({ status: 'success', data: undefined }, 2000, now), false);
  assert.equal(unitPollInterval({ status: 'success', data: running('2026-09-17T08:59:50.000Z') }, 0, now), 2000, 'ثابت الخادم المفقود ⇒ ثانيتان');
  for (const status of [400, 401, 403, 404, 409, 429]) {
    assert.equal(shouldRetryUnitFetch(0, { response: { status, data: {} } }), false, `${status} أُعيد`);
  }
  assert.equal(shouldRetryUnitFetch(0, { response: { status: 503, data: {} } }), true);
  assert.equal(shouldRetryUnitFetch(1, new Error('Network Error')), true);
  assert.equal(shouldRetryUnitFetch(2, new Error('Network Error')), false, 'إعادتان فقط');
});

test('لصق رمز التحقق بمسافات أو شرطات أو فراغ بادئ لا يُقصّ قبل التطبيع (maxLength ليس 6)', () => {
  assert.ok(OTP_INPUT_MAX_LENGTH >= 16);
  for (const pasted of ['123 456', ' 123456', '12-34-56', '١٢٣ ٤٥٦ ', '  12 34 56  ']) {
    assert.equal(normalizeOtp(pasted.slice(0, OTP_INPUT_MAX_LENGTH)), '123456', `«${pasted}»`);
  }
  const tab = fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(tab, /maxLength=\{6\}/, 'خانة الرمز تقصّ اللصق إلى 6 محارف');
  assert.match(tab, /autoComplete="one-time-code" maxLength=\{OTP_INPUT_MAX_LENGTH\}/);
});

test('قيود طلب الشهادة على الاسم القانوني (مطابقة للخادم): أكثر من 64 محرفاً، ! @ # $ % & * _ <، محارف خفية — تنبيه بلا منع حفظ', () => {
  assert.equal(csrOrgNameHint(''), null);
  assert.equal(csrOrgNameHint('شركة التوزيع الميداني التجريبية المحدودة'), null);
  assert.equal(csrOrgNameHint('ش'.repeat(64)), null);
  const long = csrOrgNameHint('شركة المؤسسة الوطنية الحديثة للتجارة والتوزيع والمقاولات والخدمات اللوجستية المحدودة');
  const amp = csrOrgNameHint('ABC Trading & Contracting Co.');
  const hidden = csrOrgNameHint('شركة‏الاختبار');
  for (const h of [long, amp, hidden]) {
    assert.ok(h);
    const t = phrase(h as string);
    assert.ok(t, `«${h}» بلا مدخل في القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]));
  }
  assert.notEqual(long, amp);
  assert.equal(sellerFieldError('legalName', 'ش'.repeat(80)), null, 'الاسم الطويل لا يمنع الحفظ (الخادم يقبله)');
  const issues = [
    { rule: 'BR-KSA-40', field: 'x', settingsField: 'legalName', messageAr: 'م', severity: 'error' as const },
    { rule: 'CSR-O-TOO_LONG', field: 'legalName', settingsField: 'legalName', messageAr: 'طويل', severity: 'error' as const },
  ];
  assert.equal(csrIssueFor(issues, 'legalName')?.rule, 'CSR-O-TOO_LONG');
  assert.equal(csrIssueFor(issues, 'addrStreet'), null);
  const ctx = { vatGroup: false, locationOverride: false };
  assert.deepEqual(csrFieldTarget('orgName', ctx), { inputId: 'zatca-legalName', advanced: false });
  // بلا مسألة جاهزية تسمّي الحقل: خانة «العنوان المختصر في الشهادة» (تُصلح الرفض دون تعديل العنوان الوطني) لا الشارع
  assert.deepEqual(csrFieldTarget('locationAddress', ctx), { inputId: 'zatca-location', advanced: true });
  assert.deepEqual(csrFieldTarget('locationAddress', { ...ctx, locationOverride: true }), { inputId: 'zatca-location', advanced: true });
  assert.deepEqual(csrFieldTarget('orgUnit', { ...ctx, vatGroup: true }), { inputId: 'zatca-vatGroupTin', advanced: false });
  assert.equal(csrFieldTarget(null, ctx), null);
  const tab = fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');
  for (const needle of ['id={`zatca-${f}`}', 'id="zatca-branch"', 'id="zatca-location"', 'id="zatca-industry"']) assert.ok(tab.includes(needle), `لا حقل ${needle}`);
});

test('رأس الحالة يقرأ نسخة الاستطلاع الحيّة لا لقطة النظرة العامّة', () => {
  const snap = payload({ id: 'a', status: 'CSR_READY', updatedAt: '2026-09-17T08:00:00.000Z' });
  const polled = payload({ id: 'a', status: 'CHECKS_RUNNING', updatedAt: '2026-09-17T08:01:00.000Z' });
  assert.equal(liveUnits([snap], [polled])[0].unit.status, 'CHECKS_RUNNING');
  const newerOverview = payload({ id: 'a', status: 'ACTIVE', updatedAt: '2026-09-17T08:05:00.000Z' });
  assert.equal(liveUnits([newerOverview], [polled])[0].unit.status, 'ACTIVE', 'نظرة عامّة أحدث تغلب نسخة مخزّنة أقدم');
  assert.equal(liveUnits([snap], [undefined])[0], snap);
  assert.equal(liveUnits([snap], [payload({ id: 'b', status: 'ACTIVE', updatedAt: '2026-09-17T09:00:00.000Z' })])[0], snap, 'معرّف مختلف لا يُخلط');
  const tab = fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');
  assert.match(tab, /<StatusHeader ov=\{ov\} units=\{units\} readOnly=\{readOnly\} \/>/);
  assert.doesNotMatch(tab, /primaryUnit\(ov\.units/, 'رأس الحالة يقرأ لقطة النظرة العامّة');
});

test('كل نصّ tr(\'…\') في التبويب له مدخل في القاموس بأربع لغات', () => {
  const tab = fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');
  const literals = [...tab.matchAll(/\btr\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(literals.length > 100, `${literals.length}`);
  for (const l of literals) {
    const t = phrase(l);
    assert.ok(t, `«${l}» بلا مدخل في القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${l}» بلا ترجمة ${lang}`);
  }
});

test('توصيل البطاقة: العرض من cardControls والاستطلاع من unitPollInterval/shouldRetryUnitFetch، وخطأ الاستطلاع ظاهر بتحديث يدوي', () => {
  const tab = fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');
  assert.match(tab, /const actions = cardControls\(p, ov\.allowedEnvs, readOnly\)/);
  assert.doesNotMatch(tab, /actions\.canResume && !failure/, 'المتابعة مخفية عند أي نتيجة فشل');
  for (const wire of ['{actions.showResume && (', '{actions.showOtpForm && (', '{actions.showRenew && (', 'const onRetry = actions.showRetry', 'retry: shouldRetryUnitFetch', 'refetchInterval: query => unitPollInterval(', "tr('تعذر تحديث حالة الوحدة')", "tr('بيئة هذه الوحدة غير مسموحة على الخادم حاليا')", "tr('أوقف الوحدة واربط وحدة جديدة')"]) {
    assert.ok(tab.includes(wire), `غير موصول: ${wire}`);
  }
  assert.doesNotMatch(tab, /shouldPoll\(query\.state\.data/, 'استطلاع يتجاهل حالة الخطأ');
});

// ─── مراجعة Z4 الثالثة ───

const readTab = () => fs.readFileSync(fileURLToPath(new URL('./ZatcaPhase2Tab.tsx', import.meta.url)), 'utf8');
const readPage = () => fs.readFileSync(fileURLToPath(new URL('../../pages/CompanySettingsPage.tsx', import.meta.url)), 'utf8');
const addressIssue: ZatcaReadinessIssue = {
  rule: 'CSR-REGISTERED-ADDRESS-FORBIDDEN_CHARACTER', field: 'addrStreet', settingsField: 'addrStreet', severity: 'warning', messageAr: 'م',
};
const csrOutcome = (field: string): ZatcaJobOutcome => ({ ...outcomeOf('CSR_PARAMS_INVALID'), field });

test('العنوان المختصر في الشهادة: يُفتح بعنوان الوحدة حين يرفض الطلبُ عنوانَ المنشأة، ويُرسل مع الرمز بعد رفض ومع التجديد', () => {
  // قيود الطلب على العنوان (مطابقة للخادم): 64 نقطة يونيكود، ! @ # $ % & * _ <، محارف خفية، و«\» البادئة
  assert.equal(csrLocationHint(''), null);
  assert.equal(csrLocationHint('Olaya Riyadh 12345'), null);
  assert.equal(csrLocationHint('ش'.repeat(64)), null);
  const hints = [csrLocationHint('ش'.repeat(65)), csrLocationHint('King Fahd Road #12'), csrLocationHint('الرياض‏العليا'), csrLocationHint('\\Riyadh')];
  for (const h of hints) {
    assert.ok(h);
    const t = phrase(h as string);
    assert.ok(t, `«${h}» بلا مدخل في القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]));
  }

  // عنوان المنشأة مقبول ⇒ الحقل مطويّ فارغ (يُكتب العنوان المحدَّث — design §5.1 خطوة 9)
  assert.deepEqual(csrLocationDefaults(unit({ locationAddress: 'Olaya Riyadh' }), []), { open: false, value: '' });
  // مرفوض ⇒ مفتوح بعنوان الوحدة الحالي (المختصر الذي أُنشئت به)، إلا إن كان هو نفسه مرفوضاً
  assert.deepEqual(csrLocationDefaults(unit({ locationAddress: 'Olaya Riyadh' }), [addressIssue]), { open: true, value: 'Olaya Riyadh' });
  assert.deepEqual(csrLocationDefaults(unit({ locationAddress: '12 King Fahd Road #12, Riyadh' }), [addressIssue]), { open: true, value: '' });

  // الخانة في نموذج الرمز بعد رفض وحده (CSR_READY يستعمل عنوان الوحدة المخزَّن)، وزرّ «صحح الحقل المشار إليه» لرفض العنوان
  const afterReject = cardControls(payload({ status: 'ERROR_NEEDS_OTP' }, { job: finished(csrOutcome('locationAddress')) }), ['simulation']);
  assert.deepEqual([afterReject.showOtpForm, afterReject.showOtpLocation, afterReject.csrFix], [true, true, { kind: 'unit-location' }]);
  assert.equal(cardControls(payload({ status: 'CSR_READY' }), ['simulation']).showOtpLocation, false);
  const renewRefused = cardControls(payload({ status: 'ACTIVE' }, { job: finished(csrOutcome('locationAddress')) }), ['simulation']);
  assert.deepEqual([renewRefused.showRenew, renewRefused.csrFix], [true, { kind: 'unit-location' }], 'رفض عنوان التجديد: لا لوحة خطأ بلا زرّ');
  assert.equal(cardControls(payload({ status: 'ACTIVE' }, { job: finished(csrOutcome('locationAddress')) }), []).csrFix, null, 'لا خانة ظاهرة في بيئة غير مسموحة');
  assert.deepEqual(csrFailureFix(csrOutcome('orgName'), { vatGroup: false }), { kind: 'seller-field', inputId: 'zatca-legalName' });
  assert.deepEqual(csrFailureFix(csrOutcome('orgUnit'), { vatGroup: true }), { kind: 'seller-field', inputId: 'zatca-vatGroupTin' });
  assert.equal(csrFailureFix(outcomeOf('ZATCA_CONFIG'), { vatGroup: false }), null);

  const tab = readTab();
  for (const wire of [
    'csrLocationDefaults(u, ov.sellerIssues)',
    "zatcaApi.onboard(id, withOtp ? { otp: value, ...(actions.showOtpLocation && csrFields ? { csrFields } : {}) } : {})",
    'zatcaApi.renew(id, { otp: value, ...(csrFields ? { csrFields } : {}) })',
    "{actions.showOtpLocation && locationField(`zatca-otp-location-${id}`)}",
    'locationField(`zatca-renew-location-${id}`)',
    '(actions.showOtpLocation && locBlocked)', '|| locBlocked}', 'onFix={onFix}',
  ]) assert.ok(tab.includes(wire), `غير موصول: ${wire}`);
  const client = fs.readFileSync(fileURLToPath(new URL('../../api/client.ts', import.meta.url)), 'utf8');
  assert.match(client, /renew: \(id: string, data: \{ otp: string; csrFields\?: \{ locationAddress\?: string \} \}\)/);
});

test('وحدة موقوفة: لا «توقّف إصدار الفواتير» لمحاكاة أو تخلٍّ بعد الانتقال إلى الإنتاج، والسبب الافتراضي «تخلٍّ» لغير الإنتاج', () => {
  const simRetired = payload({ id: 'sim', environment: 'simulation', status: 'REVOKED', activatedAt: '2026-09-02T00:00:00.000Z', lastError: 'RETIRED:revoked-in-portal', createdAt: '2026-09-01T00:00:00.000Z' });
  const prodActive = payload({ id: 'prod', environment: 'production', status: 'ACTIVE', certNotAfter: '2027-09-01T00:00:00.000Z', createdAt: '2026-09-10T00:00:00.000Z' });
  assert.deepEqual(problemBanners([simRetired, prodActive], NOW), [], 'المسار المعتاد: محاكاة ثم إنتاج');
  assert.deepEqual(problemBanners([simRetired], NOW), []);
  const prodAbandoned = payload({ id: 'p1', environment: 'production', status: 'REVOKED', activatedAt: '2026-09-02T00:00:00.000Z', lastError: 'RETIRED:abandoned' });
  assert.deepEqual(problemBanners([prodAbandoned], NOW), []);
  const prodRevoked = payload({ id: 'p2', environment: 'production', status: 'REVOKED', activatedAt: '2026-09-02T00:00:00.000Z', lastError: 'RETIRED:revoked-in-portal' });
  assert.equal(problemBanners([prodRevoked], NOW)[0]?.kind, 'REVOKED_ACTIVE', 'إبطال وحدة إنتاج بلا بديل ما زال يُنذر');

  assert.equal(defaultRetireReason({ environment: 'simulation', status: 'ACTIVE' }), 'abandoned');
  assert.equal(defaultRetireReason({ environment: 'production', status: 'ACTIVE' }), 'revoked-in-portal');
  assert.equal(defaultRetireReason({ environment: 'production', status: 'CSR_READY' }), 'abandoned');
  assert.match(readTab(), /useState<RetireReason>\(defaultRetireReason\(u\)\)/);
});

test('الشهادة المنتهية «انتهت في» لا «صالحة حتى»، والحالة المتوقفة (عامل مات) لا تُقرأ «جارية»', () => {
  assert.equal(certDateLabel('none'), null);
  assert.equal(certDateLabel('valid'), 'صالحة حتى');
  assert.equal(certDateLabel('expiring'), 'صالحة حتى');
  assert.equal(certDateLabel(certValidity(unit({ certNotAfter: '2026-09-01T09:00:00.000Z' }), NOW).state), 'انتهت في');
  const tab = readTab();
  assert.doesNotMatch(tab, /tr\('صالحة حتى'\)/, 'نصّ ثابت يتجاهل انتهاء الشهادة');
  assert.equal((tab.match(/tr\(certLabel\)/g) ?? []).length, 2, 'رأس الحالة وبطاقة الوحدة');

  const stalled = payload({ status: 'CHECKS_RUNNING' });
  assert.equal(cardStatusLabel(stalled).label, 'توقفت فحوص الامتثال قبل اكتمالها');
  assert.equal(cardStatusLabel(payload({ status: 'CHECKS_RUNNING' }, { activity: { busy: true, reason: 'checks' } })).label, UNIT_STATUS_LABEL.CHECKS_RUNNING.label);
  const renewal = (stage: string, busy: boolean) => payload(
    { status: 'RENEWING', complianceProgress: { v: 1, phase: 'renewal', keyVersion: 1, requestId: null, steps: {}, renewal: { origin: 'ACTIVE', stage, uncertain: stage === 'unconfirmed', at: '' } } },
    { activity: { busy, reason: busy ? 'renewal' : null } },
  );
  assert.equal(cardStatusLabel(renewal('waiting', true)).label, UNIT_STATUS_LABEL.RENEWING.label);
  assert.equal(cardStatusLabel(renewal('patch-sent', false)).label, 'توقف تجديد الشهادة قبل اكتماله');
  assert.equal(cardStatusLabel(renewal('unconfirmed', false)).tone, 'danger');
  assert.equal(cardStatusLabel(payload({ status: 'ACTIVE' })).label, UNIT_STATUS_LABEL.ACTIVE.label);
  for (const l of [...CARD_STATUS_EXTRA_LABELS, 'انتهت في', 'صالحة حتى']) {
    const t = phrase(l);
    assert.ok(t, `«${l}» بلا مدخل في القاموس`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${l}» بلا ترجمة ${lang}`);
  }
  assert.match(tab, /const st = cardStatusLabel\(p\)/);
  assert.match(tab, /const st = primary \? cardStatusLabel\(primary\) : null/);
});

test('جلسة انتحال المالك: لا خانة رمز ولا متابعة ولا تجديد ولا إيقاف ولا حفظ ولا إنشاء (الخادم 403) — والقراءة كاملة', () => {
  const needs = payload({ status: 'ERROR_NEEDS_OTP' }, { job: finished(outcomeOf('COMPLIANCE_CHECK_REJECTED', { needsNewOtp: true })) });
  for (const p of [needs, payload({ status: 'CHECKS_PASSED' }, { job: finished(outcomeOf('ZATCA_RETRY', { retryable: true })) }), payload({ status: 'ACTIVE' }),
    payload({ status: 'AUTH_FAILED' }, { job: finished(outcomeOf('CSID_CERT_INVALID', { needsNewOtp: true })) })]) {
    const c = cardControls(p, ['simulation'], true);
    assert.deepEqual(
      [c.showOtpForm, c.showResume, c.showRetry, c.showRenew, c.canAbort, c.canRetire, c.newOtpAction, c.showOtpLocation, c.csrFix],
      [false, false, false, false, false, false, null, false, null], p.unit.status,
    );
    assert.equal(c.envAllowed, true);
  }
  assert.equal(cardControls(needs, ['simulation']).showOtpForm, true, 'مدير الشركة نفسه يرى النموذج');
  const tab = readTab();
  for (const wire of [
    'const readOnly = !!useAuthStore(s => s.impersonating)', '{!readOnly && <CreateUnit', '{!readOnly && (', 'readOnly={readOnly} />',
    "tr('جلسة اطلاع من مالك المنصة — للاطلاع فقط')",
  ]) assert.ok(tab.includes(wire), `غير موصول: ${wire}`);
});

test('إعدادات الشركة: التبويب كسول ومُبقى عليه، وتحديث «company» لا يمحو تعديلات غير محفوظة، والجاهزية تُجلب بعد حفظ الإعدادات العامة', () => {
  // دمج التحديث: ما عدّله المدير يبقى، وما لم يعدّله يأخذ قيمة الخادم الجديدة
  const applied = { logo: 'old-logo', primaryColor: '#111111', numerals: 'arabic' };
  const next = { logo: 'old-logo', primaryColor: '#222222', numerals: 'arabic' };
  const local = { logo: 'new-unsaved-logo', primaryColor: '#111111', numerals: 'arabic' };
  assert.deepEqual(keepLocalEdits(applied, next, local), { logo: 'new-unsaved-logo', primaryColor: '#222222', numerals: 'arabic' });
  assert.deepEqual(keepLocalEdits(null, next, local), next, 'أول تحميل: الخادم كاملاً');
  const einvApplied = { enabled: true, clientSecret: '' };
  assert.equal(keepLocalEdits(einvApplied, { enabled: true, clientSecret: '' }, { enabled: true, clientSecret: 's3cret-typed' }).clientSecret, 's3cret-typed', 'سرّ كُتب ولم يُحفظ يبقى');

  const page = readPage();
  assert.doesNotMatch(page, /^import ZatcaPhase2Tab/m, 'استيراد ثابت يُدخل التبويب في حزمة الصفحة لكل الشركات');
  assert.match(page, /const loadZatcaPhase2Tab = \(\) => import\('\.\.\/components\/zatca\/ZatcaPhase2Tab'\);/);
  assert.match(page, /const ZatcaPhase2Tab = useMemo\(\(\) => lazy\(loadZatcaPhase2Tab\), \[zatcaAttempt\]\);/);
  for (const wire of [
    '<div hidden={!showZatca}>', '<div hidden={showZatca}>', 'zatcaTabOn && zatcaMounted && (', 'reset(keepLocalEdits(applied?.form ?? null, nextForm, { ...nextForm, ...getValues() }));',
    'keepLocalEdits(applied?.state ?? null, nextState,', 'keepLocalEdits(applied?.einv ?? null, nextEinv, einv)', "qc.invalidateQueries({ queryKey: ['zatca', 'overview'] })",
    'if (applied?.data === data) return;',
  ]) assert.ok(page.includes(wire), `غير موصول: ${wire}`);
  assert.doesNotMatch(page, /\{!showZatca && \(<>/, 'النموذج العام يُزال عند فتح التبويب');
  assert.doesNotMatch(page, /\{showZatca && <ZatcaPhase2Tab \/>\}/, 'التبويب يُزال عند العودة فتضيع مسودة بيانات المنشأة');
  assert.match(readTab(), /staleTime: 0,/);
});

test('التبويب لمدير الشركة وحده (قرار المالك، مطابق لحارس الخادم 403 COMPANY_ADMIN_ONLY): علم المالك + السعودية + دور ADMIN، والمشرف والمحاسب لا يرونه', () => {
  const on = { zatcaPhase2Enabled: true, countryCode: 'SA' };
  assert.equal(ZATCA_TAB_ROLE, 'ADMIN');
  assert.equal(zatcaTabVisible(on, 'ADMIN'), true);
  for (const role of ['MANAGER', 'ACCOUNTANT', 'SALES_REP', 'SUPER_ADMIN', 'admin', '', null, undefined]) {
    assert.equal(zatcaTabVisible(on, role), false, `الدور ${String(role)} يرى التبويب`);
  }
  for (const company of [null, undefined, {}, { countryCode: 'SA' }, { zatcaPhase2Enabled: false, countryCode: 'SA' }, { zatcaPhase2Enabled: null, countryCode: 'SA' },
    { zatcaPhase2Enabled: 'true' as unknown as boolean, countryCode: 'SA' }, { zatcaPhase2Enabled: true, countryCode: 'AE' }, { zatcaPhase2Enabled: true }]) {
    assert.equal(zatcaTabVisible(company, 'ADMIN'), false, `المدير يرى التبويب بلا العلم أو خارج السعودية: ${JSON.stringify(company)}`);
  }
  // المدير المقيّد النطاق: الخادم يردّه 403 SCOPED_ADMIN ⇒ لا تبويب ينتهي ببطاقة خطأ
  assert.equal(zatcaTabVisible(on, 'ADMIN', true), false, 'مدير مقيّد النطاق يرى التبويب');
  assert.equal(zatcaTabVisible(on, 'ADMIN', false), true);
  assert.equal(zatcaTabVisible(on, 'ADMIN', null), true);

  const page = readPage();
  for (const wire of [
    "import { companySaveErrorMessage, companySaveNeedsRefetch, withoutLockedSellerFields, zatcaCountryChoiceAllowed, zatcaSellerFieldsLocked, zatcaSellerLockHint, zatcaTabVisible } from '../components/zatca/zatcaAccess';",
    'const role = useAuthStore(s => s.user?.role);', 'const scopeEnabled = useAuthStore(s => s.user?.scopeEnabled === true);', 'const zatcaTabOn = zatcaTabVisible(data, role, scopeEnabled);',
  ]) assert.ok(page.includes(wire), `غير موصول: ${wire}`);
  assert.doesNotMatch(page, /zatcaPhase2Enabled === true && data\?\.countryCode === 'SA'/, 'شرط التبويب القديم بلا الدور');
  // التبويب نفسه (النص والمحتوى) محكوم بـzatcaTabOn وحده — لا مسار يعرضه لغير المدير
  assert.equal(page.match(/\{zatcaTabOn && \(/g)?.length, 1, 'شريط التبويبين');
  const mount = page.indexOf('{zatcaTabOn && zatcaMounted && (');
  assert.equal(page.match(/\{zatcaTabOn && zatcaMounted && \(/g)?.length, 1);
  assert.equal(page.match(/<ZatcaPhase2Tab \/>/g)?.length, 1);
  assert.ok(mount > 0 && page.indexOf('<ZatcaPhase2Tab />') > mount && page.indexOf('<ZatcaPhase2Tab />') < page.indexOf('<div hidden={showZatca}>'), 'محتوى التبويب خارج شرط zatcaTabOn');
  assert.match(page, /const showZatca = zatcaTabOn && tab === 'zatca';/);
  // صغير بلا استيراد: لا يجرّ منطق التبويب إلى حزمة صفحة الإعدادات
  const access = fs.readFileSync(fileURLToPath(new URL('./zatcaAccess.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(access, /^import /m);
  assert.doesNotMatch(page, /from '\.\.\/components\/zatca\/zatcaLogic'/);
});

test('عبارات التبويب خارج حزمة الدخول: في zatcaPhrases.ts وحدها، كاملة بأربع لغات، بلا تكرار مع القاموس العامّ', () => {
  const keys = Object.keys(ZATCA_PHRASES);
  assert.ok(keys.length > 150, `${keys.length}`);
  for (const k of keys) {
    assert.ok(!(k in PHRASES), `«${k}» مكرّر في i18n/strings.ts (حزمة الدخول)`);
    const t = ZATCA_PHRASES[k];
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${k}» بلا ترجمة ${lang}`);
  }
  // ما يُعرض خارج التبويب باقٍ في القاموس العامّ
  for (const k of ['الإعدادات العامة', 'الفوترة الإلكترونية — المرحلة الثانية (فاتورة)', 'ربط فوترة المرحلة الثانية (فاتورة)']) assert.ok(PHRASES[k], k);
  assert.equal(zatcaTranslate('en', 'رمز التحقق OTP'), ZATCA_PHRASES['رمز التحقق OTP'].en);
  assert.equal(zatcaTranslate('en', 'الإعدادات العامة'), PHRASES['الإعدادات العامة'].en, 'يرجع للقاموس العامّ');
  assert.equal(zatcaTranslate('ar', 'رمز التحقق OTP'), 'رمز التحقق OTP');
  assert.equal(zatcaTranslate('fr', 'نصّ بلا ترجمة'), 'نصّ بلا ترجمة');
  const tab = readTab();
  assert.match(tab, /import \{ useZatcaTr as useTr \} from '\.\/zatcaPhrases';/);
  assert.doesNotMatch(tab, /from '\.\.\/\.\.\/i18n\/strings'/);
});

// ─── مراجعة Z4 الثالثة (الجولة الثالثة من الإصلاحات) ───

type GeneralForm = { name: string; taxNumber: string; commercialReg: string };
const GENERAL_FIELDS = ['name', 'taxNumber', 'commercialReg'] as const;

/**
 * نموذج «الإعدادات العامة» كما تشغّله الصفحة، على RHF الحقيقي (createFormControl) بلا DOM:
 * server = تأثير وصول ['company']، type = كتابة المستخدم (onChange)، save = الإرسال ونجاحه، payload = ما يرسله الحفظ.
 * legacy = المسار السابق (reset مع keepDirtyValues) للمقارنة.
 */
function generalSettingsForm(mode: 'page' | 'legacy') {
  const { reset, getValues, register, handleSubmit } = createFormControl<GeneralForm>({});
  const render = () => GENERAL_FIELDS.map(f => register(f));
  let applied: GeneralForm | null = null;
  render();
  return {
    server(next: GeneralForm) {
      if (mode === 'legacy') reset(next, applied ? { keepDirtyValues: true } : undefined);
      else reset(keepLocalEdits(applied, next, { ...next, ...getValues() }));
      applied = next;
      render();
    },
    async type(f: (typeof GENERAL_FIELDS)[number], value: string) {
      await register(f).onChange({ target: { name: f, value }, type: 'change' });
    },
    async save(): Promise<GeneralForm> {
      let sent: GeneralForm | null = null;
      await handleSubmit(v => { sent = { ...v }; })();
      // onSuccess: ما أُرسل صار خطّ الأساس (الصفحة: appliedRef.current.form = sent.form)
      if (mode === 'page' && applied && sent) applied = sent;
      return sent as unknown as GeneralForm;
    },
    values: () => getValues(),
  };
}

test('الإعدادات العامة (RHF الحقيقي): حفظ الرقم الضريبي ثم تصحيحه من تبويب الفوترة ⇒ التحديث يأخذ قيمة الخادم والحفظ التالي (شعار) لا يعيد القديمة — keepDirtyValues كان يعيدها', async () => {
  const T0 = { name: 'Co', taxNumber: '300000000000003', commercialReg: '1010' };
  for (const mode of ['page', 'legacy'] as const) {
    const f = generalSettingsForm(mode);
    f.server(T0);
    await f.type('taxNumber', '311111111111113');
    assert.equal((await f.save()).taxNumber, '311111111111113');
    f.server({ ...T0, taxNumber: '311111111111113' }); // إعادة الجلب بعد الحفظ
    f.server({ ...T0, taxNumber: '322222222222223', commercialReg: '2020' }); // «حفظ بيانات المنشأة» من تبويب الفوترة
    const next = await f.save(); // حفظ عاديّ لاحق (الشعار مثلاً) يرسل كل قيم النموذج
    if (mode === 'page') {
      assert.equal(f.values().taxNumber, '322222222222223', 'النموذج العام بقي على الرقم الضريبي القديم');
      assert.equal(next.taxNumber, '322222222222223', 'الحفظ التالي أعاد الرقم الضريبي القديم فوق تصحيح تبويب الفوترة');
      assert.equal(next.commercialReg, '2020');
    } else {
      assert.equal(next.taxNumber, '311111111111113', 'ضبط: المسار السابق يعيد القديمة (إن تغيّر سلوك RHF فراجع الحارس)');
    }
  }

  // تعديل غير محفوظ يبقى أمام تحديث الخادم، وحقل لم يُعدَّل يأخذ الجديد؛ وما كُتب أثناء الحفظ يبقى بعده
  const f = generalSettingsForm('page');
  f.server(T0);
  await f.type('name', 'Co unsaved');
  f.server({ ...T0, taxNumber: '399999999900003' });
  assert.deepEqual(f.values(), { name: 'Co unsaved', taxNumber: '399999999900003', commercialReg: '1010' });
  await f.type('taxNumber', '٣١١١١١١١١١١١١١٣');
  await f.save();
  await f.type('commercialReg', '3030'); // أثناء الحفظ
  f.server({ ...T0, name: 'Co unsaved', taxNumber: '311111111111113' }); // الخادم طبّع الأرقام
  assert.deepEqual(f.values(), { name: 'Co unsaved', taxNumber: '311111111111113', commercialReg: '3030' });

  const page = readPage();
  assert.doesNotMatch(page, /keepDirtyValues\s*:/, 'keepDirtyValues يُبقي dirtyFields بعد الحفظ فيرفض كل قيمة لاحقة من الخادم');
  for (const wire of [
    'reset(keepLocalEdits(applied?.form ?? null, nextForm, { ...nextForm, ...getValues() }));',
    'appliedRef.current = { data, form: nextForm, state: nextState, einv: nextEinv };',
    "if (appliedRef.current) appliedRef.current = { ...appliedRef.current, form: sent.form, state: sent.state, einv: { ...sent.einv, clientSecret: '' } };",
    'onSuccess: (_res, sent) => {',
    'form: values, state: { logo, primaryColor, headerStyle, countryCode, currencyOverride, numerals }, einv, sellerLocked,',
  ]) assert.ok(page.includes(wire), `غير موصول: ${wire}`);
  // الإرسال من اللقطة لا من حالة الصفحة وقت الإرسال الفعلي، بلا الحقول المقفلة وقت الإرسال
  assert.match(page, /mutationFn: \(\{ form: values, state: st, einv: e, sellerLocked: locked \}: SaveSnapshot\) => companyApi\.update\(withoutLockedSellerFields\(\{\s*\.\.\.values, \.\.\.st,[\s\S]*?\}, locked\)\),/);
});

test('بطاقة بيانات المنشأة: دمج حقلاً بحقل — حفظ الرقم الضريبي من «الإعدادات العامة» أثناء تعديل غير محفوظ للاسم يصل المسودة ولا يعيده «حفظ بيانات المنشأة» قديماً', () => {
  const s0 = { ...draftOf(null), legalName: 'شركة أ', taxNumber: '300000000000003', commercialReg: '1010', addrCity: 'الرياض' };
  // المدير يكتب الاسم في تبويب الفوترة دون حفظ
  let draft = { ...draftOf(s0), legalName: 'شركة أ المحدودة' };
  // ثم يصحّح الرقم الضريبي والسجل من «الإعدادات العامة» ⇒ تتحدّث النظرة العامّة
  const s1 = { ...s0, taxNumber: '311111111111113', commercialReg: '2020' };
  draft = mergeSellerDraft(s0, s1, draft);
  assert.equal(draft.taxNumber, '311111111111113');
  assert.equal(draft.commercialReg, '2020');
  assert.equal(draft.legalName, 'شركة أ المحدودة', 'تعديل غير محفوظ ضاع');
  assert.deepEqual(sellerPatch(s1, draft), { legalName: 'شركة أ المحدودة' }, '«حفظ بيانات المنشأة» يعيد الرقم الضريبي أو السجل القديم');

  // قيمة مطابقة بعد التنظيف (مسافات أو أرقام عربية) ليست تعديلاً
  assert.equal(mergeSellerDraft(s0, s1, { ...draftOf(s0), taxNumber: ' ٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣ ' }).taxNumber, '311111111111113');
  // حقل عدّله المدير فعلاً يبقى ولو تغيّر في الخادم
  assert.equal(mergeSellerDraft(s0, s1, { ...draftOf(s0), taxNumber: '399999999900003' }).taxNumber, '399999999900003');
  assert.deepEqual(mergeSellerDraft(null, s1, draftOf(s0)), draftOf(s1), 'بلا خطّ أساس: الخادم كاملاً');

  // بعد حفظ ناجح: خطّ الأساس = ما أُرسل ⇒ القيمة المطبَّعة من الخادم تحلّ محلّ المكتوب بأرقام عربية
  const typed = { ...draftOf(s1), addrBuildingNo: '١٢٣٤' };
  const patch = sellerPatch(s1, typed);
  assert.deepEqual(patch, { addrBuildingNo: '1234' });
  const s2 = { ...s1, addrBuildingNo: '1234' };
  assert.equal(mergeSellerDraft(sellerBaselineAfterSave(s1, patch), s2, typed).addrBuildingNo, '1234');
  assert.deepEqual(sellerPatch(s2, mergeSellerDraft(sellerBaselineAfterSave(s1, patch), s2, typed)), {});

  const tab = readTab();
  assert.doesNotMatch(tab, /touched/, 'علم «لُمس» واحد يحجب تحديث كل الحقول');
  for (const wire of [
    'const baselineRef = useRef<Partial<ZatcaSellerData>>(ov.seller);',
    'setDraft(d => mergeSellerDraft(baseline, ov.seller, d));',
    'if (baselineRef.current === ov.seller) baselineRef.current = sellerBaselineAfterSave(ov.seller, patch);',
  ]) assert.ok(tab.includes(wire), `غير موصول: ${wire}`);
});

test('رفض CSR_PARAMS_INVALID للعنوان المشتقّ عند الإنشاء: التركيز على الحقل الذي سمّاه الخادم (الحي لا الشارع) مع فتح «العنوان المختصر في الشهادة»', () => {
  const ctx = { vatGroup: false, locationOverride: false };
  const district: ZatcaReadinessIssue = { rule: 'CSR-REGISTERED-ADDRESS-FORBIDDEN_CHARACTER', field: 'addrDistrict', settingsField: 'addrDistrict', severity: 'warning', messageAr: 'م' };
  assert.deepEqual(csrFieldTarget('locationAddress', { ...ctx, issues: [district] }), { inputId: 'zatca-addrDistrict', advanced: true });
  assert.deepEqual(csrFieldTarget('locationAddress', { ...ctx, issues: [{ ...district, settingsField: 'addrCity' }] }), { inputId: 'zatca-addrCity', advanced: true });
  assert.deepEqual(csrFieldTarget('locationAddress', { ...ctx, issues: [addressIssue] }), { inputId: 'zatca-addrStreet', advanced: true });
  // مسألة أخرى (الاسم) أو حقل خارج العنوان لا تُختار
  const other: ZatcaReadinessIssue = { rule: 'CSR-O-TOO_LONG', field: 'legalName', settingsField: 'legalName', severity: 'error', messageAr: 'م' };
  assert.deepEqual(csrFieldTarget('locationAddress', { ...ctx, issues: [other] }), { inputId: 'zatca-location', advanced: true });
  assert.deepEqual(csrFieldTarget('locationAddress', { ...ctx, locationOverride: true, issues: [district] }), { inputId: 'zatca-location', advanced: true }, 'العنوان المختصر نفسه رُفض');
  const tab = readTab();
  for (const f of ['addrStreet', 'addrDistrict', 'addrCity', 'addrBuildingNo', 'addrPostalCode']) assert.ok(tab.includes(`'${f}'`), f);
  assert.ok(tab.includes('const fresh = qc.getQueryData<ZatcaOverview>(OVERVIEW_KEY) ?? ov;'));
  assert.ok(tab.includes("locationOverride: extra.locationAddress.trim() !== '', issues: fresh.sellerIssues })"));
});

test('تبويب الفوترة الكسول داخل حاجز أخطاء: فشل تحميل الحزمة أو خطأ داخله يعرض لافتة بإعادة المحاولة (مكوّن كسول جديد) لا صفحة بيضاء تُسقط النموذج العام', () => {
  assert.deepEqual(ZatcaTabBoundary.getDerivedStateFromError(), { failed: true });
  let retried = 0;
  const b = new ZatcaTabBoundary({ children: createElement('span', null, 'child'), onRetry: () => { retried++; } });
  assert.equal(renderToStaticMarkup(createElement('div', null, b.render())), '<div><span>child</span></div>');
  b.state = { failed: true };
  const html = renderToStaticMarkup(createElement('div', null, b.render()));
  assert.match(html, /role="alert"/);
  assert.ok(html.includes('تعذر تحميل تبويب الفوترة الإلكترونية'));
  assert.ok(html.includes('إعادة المحاولة') && html.includes('تحديث الصفحة'));
  assert.ok(!html.includes('child'), 'التبويب المعطوب ما زال يُرسم');
  (b as unknown as { setState: (s: unknown) => void }).setState = s => { b.state = s as typeof b.state; };
  b.retry();
  assert.equal(retried, 1);
  assert.deepEqual(b.state, { failed: false });
  const alone = renderToStaticMarkup(createElement(ZatcaTabLoadError, { onRetry: () => {} }));
  for (const l of ['تعذر تحميل تبويب الفوترة الإلكترونية', 'ربما نشر تحديث جديد للمنصة أو انقطع الاتصال — تعديلات الإعدادات العامة غير المحفوظة باقية في تبويبها', 'تحديث الصفحة', 'تحديث الصفحة يمحو ما لم يحفظ — احفظ الإعدادات العامة أولا', 'إعادة المحاولة']) {
    assert.ok(alone.includes(l), l);
    const t = PHRASES[l];
    assert.ok(t, `«${l}» ليست في القاموس العامّ (الحاجز في حزمة الصفحة لا التبويب)`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${l}» بلا ترجمة ${lang}`);
  }

  const page = readPage();
  const boundary = page.indexOf('<ZatcaTabBoundary onRetry={() => setZatcaAttempt(n => n + 1)}>');
  const suspense = page.indexOf('<Suspense fallback=');
  const tabEl = page.indexOf('<ZatcaPhase2Tab />');
  const close = page.indexOf('</ZatcaTabBoundary>');
  assert.ok(boundary > 0 && boundary < suspense && suspense < tabEl && tabEl < close, 'التبويب الكسول خارج حاجز الأخطاء');
  assert.ok(close < page.indexOf('<div hidden={showZatca}>'), 'الحاجز يلفّ النموذج العام أيضاً فيُسقطه');
  assert.ok(page.includes("import ZatcaTabBoundary from '../components/zatca/ZatcaTabBoundary';"));
  // الحاجز في حزمة الصفحة: بلا منطق التبويب ولا عباراته
  const src = fs.readFileSync(fileURLToPath(new URL('./ZatcaTabBoundary.tsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /from '\.\/(zatcaLogic|zatcaPhrases|ZatcaPhase2Tab)'/);
  assert.match(src, /import \{ useTr \} from '\.\.\/\.\.\/i18n\/strings';/);
  assert.doesNotMatch(src, /console\.\w+\([^)]*error\.message/, 'تسجيل رسالة خطأ التبويب');
});

test('الإعدادات العامة لشركة بعلم المالك: الرقم الضريبي والسجل والدولة للاطلاع لغير المدير ولجلسة الانتحال، ورسالة رفض الخادم تُعرض', () => {
  const on = { zatcaPhase2Enabled: true, countryCode: 'SA' };
  assert.equal(zatcaSellerFieldsLocked(on, 'ADMIN', false), false);
  for (const role of ['MANAGER', 'ACCOUNTANT', undefined]) assert.equal(zatcaSellerFieldsLocked(on, role, false), true, String(role));
  assert.equal(zatcaSellerFieldsLocked(on, 'ADMIN', true), true, 'انتحال المالك');
  for (const c of [{ zatcaPhase2Enabled: false, countryCode: 'SA' }, { zatcaPhase2Enabled: false, countryCode: 'AE' }, null]) {
    assert.equal(zatcaSellerFieldsLocked(c, 'MANAGER', true), false, JSON.stringify(c));
    assert.equal(zatcaSellerFieldsLocked(c, 'ADMIN', false, true), false, `مقيّد بلا العلم: ${JSON.stringify(c)}`);
  }
  // بعلم المالك وبلا دولة محفوظة (الصفحة تعرض السعودية وترسلها فيردّها الخادم) ⇒ مقفل أيضاً
  for (const c of [{ zatcaPhase2Enabled: true, countryCode: null }, { zatcaPhase2Enabled: true, countryCode: '' }, { zatcaPhase2Enabled: true }]) {
    for (const role of ['MANAGER', 'ACCOUNTANT']) assert.equal(zatcaSellerFieldsLocked(c, role, false), true, `${role} ${JSON.stringify(c)}`);
    assert.equal(zatcaSellerFieldsLocked(c, 'ADMIN', true), true, `انتحال ${JSON.stringify(c)}`);
    assert.equal(zatcaSellerFieldsLocked(c, 'ADMIN', false, true), true, `مقيّد ${JSON.stringify(c)}`);
    assert.equal(zatcaSellerFieldsLocked(c, 'ADMIN', false, false), false, `المدير ${JSON.stringify(c)}`);
  }
  // بعلم المالك ودولة محفوظة غير السعودية: الخادم لا يحرس الحقول (companyZatcaFieldChanges) ⇒ غير مقفلة لأحد
  for (const code of ['AE', 'EG']) {
    const c = { zatcaPhase2Enabled: true, countryCode: code };
    for (const [role, imp, scoped] of [['MANAGER', false, false], ['ACCOUNTANT', false, false], ['ADMIN', true, false], ['ADMIN', false, true], ['ADMIN', false, false]] as const) {
      assert.equal(zatcaSellerFieldsLocked(c, role, imp, scoped), false, `${role} انتحال=${imp} مقيّد=${scoped} ${code}`);
    }
  }
  // المدير المقيّد النطاق (الخادم يردّه 403 SELLER_FIELDS_SCOPED)
  assert.equal(zatcaSellerFieldsLocked(on, 'ADMIN', false, true), true, 'مدير مقيّد النطاق');
  assert.equal(zatcaSellerFieldsLocked(on, 'ADMIN', false, false), false);
  // سبب القفل تحت الحقول بترتيب حارس الخادم (الانتحال ثم الدور ثم النطاق) — عبارات القاموس العامّ نفسها لرموز الرفض
  assert.equal(zatcaSellerLockHint('ADMIN', true, false), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_READ_ONLY);
  assert.equal(zatcaSellerLockHint('ADMIN', true, true), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_READ_ONLY);
  assert.equal(zatcaSellerLockHint('MANAGER', true, false), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_READ_ONLY);
  assert.equal(zatcaSellerLockHint('ADMIN', false, true), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_SCOPED);
  for (const role of ['MANAGER', 'ACCOUNTANT', undefined]) {
    assert.equal(zatcaSellerLockHint(role, false, false), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_ADMIN_ONLY, String(role));
    assert.equal(zatcaSellerLockHint(role, false, true), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_ADMIN_ONLY, `${String(role)} مقيّد: الدور أولاً`);
  }
  const err = (data: unknown) => ({ response: { status: 403, data } });
  // عبارات القاموس العامّ (تُترجم بـtr) لا نصّ الخادم العربي
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_FIELDS_ADMIN_ONLY', message: 'للمدير' })), 'الرقم الضريبي والسجل التجاري والدولة مرتبطة بربط الفوترة الإلكترونية — يعدلها مدير الشركة');
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_FIELDS_READ_ONLY', message: 'انتحال' })), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_READ_ONLY);
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_FIELDS_SCOPED', message: 'نطاق' })), COMPANY_SELLER_ERROR_PHRASES.SELLER_FIELDS_SCOPED);
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_INVALID', message: 'عامّة', fieldErrors: [{ field: 'taxNumber', messageAr: 'الرقم الضريبي يجب…' }] })), COMPANY_SELLER_FIELD_ERROR_PHRASES.taxNumber);
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_INVALID', fieldErrors: [{ field: 'commercialReg', messageAr: 'القيمة أطول من المسموح' }] })), COMPANY_SELLER_FIELD_ERROR_PHRASES.commercialReg);
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_INVALID', fieldErrors: [{ field: 'legalName', messageAr: 'x' }] })), COMPANY_SELLER_ERROR_PHRASES.SELLER_INVALID);
  assert.equal(companySaveErrorMessage(err({ code: 'SELLER_INVALID' })), COMPANY_SELLER_ERROR_PHRASES.SELLER_INVALID);
  assert.equal(companySaveErrorMessage(err({ message: 'بيانات غير صحيحة name' })), null, 'غير رموز الحارس: الرسالة العامة كما كانت');
  assert.equal(companySaveErrorMessage(err({ code: 'toString' })), null, 'مفتاح من نموذج الكائن ليس رمز حارس');
  assert.equal(companySaveErrorMessage(new Error('network')), null);
  assert.deepEqual([...COMPANY_SELLER_ERROR_CODES].sort(), ['SELLER_FIELDS_ADMIN_ONLY', 'SELLER_FIELDS_READ_ONLY', 'SELLER_FIELDS_SCOPED', 'SELLER_INVALID']);
  // كل عبارة يعيدها الحارس في القاموس العامّ (حزمة الصفحة لا التبويب الكسول) بأربع لغات — مفاتيح ديناميكية لا يلتقطها حارس tr('…')
  for (const k of [...Object.values(COMPANY_SELLER_ERROR_PHRASES), ...Object.values(COMPANY_SELLER_FIELD_ERROR_PHRASES)]) {
    const t = PHRASES[k];
    assert.ok(t, `«${k}» ليست في القاموس العامّ`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(t[lang] && !/[؀-ۿ]/.test(t[lang]), `«${k}» بلا ترجمة ${lang}`);
    assert.ok(!(k in ZATCA_PHRASES), `«${k}» مكرّر في عبارات التبويب`);
  }
  // رفض الصلاحية يعيد جلب ['company']، وخطأ الصيغة لا (الحقل بيد المستخدم)
  for (const code of ['SELLER_FIELDS_ADMIN_ONLY', 'SELLER_FIELDS_READ_ONLY', 'SELLER_FIELDS_SCOPED']) assert.equal(companySaveNeedsRefetch(err({ code })), true, code);
  assert.equal(companySaveNeedsRefetch(err({ code: 'SELLER_INVALID' })), false);
  assert.equal(companySaveNeedsRefetch(err({ message: 'x' })), false);
  assert.equal(companySaveNeedsRefetch(new Error('network')), false);

  const page = readPage();
  for (const wire of [
    'const sellerLocked = zatcaSellerFieldsLocked(data, role, impersonating, scopeEnabled);',
    '<select className="input" value={countryCode} disabled={sellerLocked}',
    "readOnly={sellerLocked} {...register('taxNumber')}",
    "readOnly={sellerLocked} {...register('commercialReg')}",
    '{tr(zatcaSellerLockHint(role, impersonating, scopeEnabled))}</p>',
    "if (companySaveNeedsRefetch(err)) qc.invalidateQueries({ queryKey: ['company'] });",
    "toast.error(sellerError ? tr(sellerError) : tr('حدث خطأ في الحفظ'));",
  ]) assert.ok(page.includes(wire), `غير موصول: ${wire}`);
  assert.doesNotMatch(page, /toast\.error\(companySaveErrorMessage\(err\) \?\?/, 'نصّ الخادم العربي يُعرض بلا ترجمة');
  assert.ok(!page.includes("tr('الرقم الضريبي والسجل التجاري والدولة مرتبطة بربط الفوترة الإلكترونية — يعدلها مدير الشركة')"), 'تلميح «يعدلها مدير الشركة» ثابت للمقيّد والانتحال');
});

test('شركة غير سعودية بعلم المالك: المشرف والمحاسب وانتحال المالك والمدير المقيّد يعدّلون الرقم الضريبي والسجل والدولة كما يقبل الخادم — بلا خيار السعودية (يردّه الخادم فتتكرّر 403)', () => {
  const callers = [['MANAGER', false, false], ['ACCOUNTANT', false, false], ['ADMIN', true, false], ['ADMIN', false, true]] as const;
  const codes = supportedCountries().map(c => c.code);
  assert.ok(codes.includes('SA') && codes.length > 5, 'ضبط: قائمة الدول');
  for (const [role, imp, scoped] of callers) {
    const label = `${role} انتحال=${imp} مقيّد=${scoped}`;
    const company = { zatcaPhase2Enabled: true, countryCode: 'AE' };
    const locked = zatcaSellerFieldsLocked(company, role, imp, scoped);
    assert.equal(locked, false, label);
    const allowed = codes.filter(code => zatcaCountryChoiceAllowed(code, company, role, imp, scoped));
    assert.deepEqual(allowed, codes.filter(code => code !== 'SA'), `${label}: كل الدول إلا السعودية`);
    // الحفظ يرسل الحقول الثلاثة كما كُتبت (الخادم يقبلها: لا سعودية قبل الحفظ ولا بعده)
    const body = withoutLockedSellerFields({ name: 'Co', taxNumber: '311111111111113', commercialReg: '1010', countryCode: 'EG', logo: 'data:new' }, locked);
    assert.deepEqual(Object.keys(body).sort(), ['commercialReg', 'countryCode', 'logo', 'name', 'taxNumber'], `${label}: ${JSON.stringify(body)}`);
    // السعودية المحفوظة أو بلا دولة محفوظة: مقفلة، وخيار السعودية معروض (القائمة معطّلة على قيمتها)
    for (const c of [{ zatcaPhase2Enabled: true, countryCode: 'SA' }, { zatcaPhase2Enabled: true, countryCode: null }, { zatcaPhase2Enabled: true }]) {
      assert.equal(zatcaSellerFieldsLocked(c, role, imp, scoped), true, `${label} ${JSON.stringify(c)}`);
      assert.equal(zatcaCountryChoiceAllowed('SA', c, role, imp, scoped), true, `${label} ${JSON.stringify(c)}`);
      assert.deepEqual(withoutLockedSellerFields({ name: 'Co', taxNumber: 'x', commercialReg: 'y', countryCode: 'SA' }, true), { name: 'Co' });
    }
  }
  // مدير الشركة غير المقيّد خارج الانتحال، وكل الشركات بلا العلم: كل الدول ولا قفل — كما كان
  for (const c of [{ zatcaPhase2Enabled: true, countryCode: 'AE' }, { zatcaPhase2Enabled: true, countryCode: 'SA' }, { zatcaPhase2Enabled: true }]) {
    assert.deepEqual(codes.filter(code => zatcaCountryChoiceAllowed(code, c, 'ADMIN', false, false)), codes, JSON.stringify(c));
  }
  for (const c of [{ zatcaPhase2Enabled: false, countryCode: 'AE' }, { zatcaPhase2Enabled: false, countryCode: 'SA' }, { zatcaPhase2Enabled: false }, null, undefined]) {
    for (const [role, imp, scoped] of callers) {
      assert.equal(zatcaSellerFieldsLocked(c, role, imp, scoped), false, `${role} ${JSON.stringify(c)}`);
      assert.deepEqual(codes.filter(code => zatcaCountryChoiceAllowed(code, c, role, imp, scoped)), codes, `${role} ${JSON.stringify(c)}`);
    }
  }
  // موصول في الصفحة: القائمة تُرشَّح بالخيار المسموح، ومعطّلة حين القفل
  const page = readPage();
  assert.ok(page.includes('{supportedCountries().filter(c => zatcaCountryChoiceAllowed(c.code, data, role, impersonating, scopeEnabled)).map(c => ('), 'قائمة الدول غير مرشّحة');
  assert.equal(page.match(/supportedCountries\(\)/g)?.length, 1, 'قائمة دول ثانية بلا ترشيح');
});

test('الحقول المقفلة لا تُرسل في حفظ «الإعدادات العامة»: قيمة قديمة في الصفحة لا تُرفض 403 على حقل لا يعدّله المستخدم — وغير المقفل يرسل كل شيء كما كان', () => {
  const body = {
    name: 'Co', taxNumber: '300000000000003', commercialReg: '1010', phone: '0501', logo: 'data:x', primaryColor: '#000', headerStyle: 'banner',
    countryCode: 'SA', currencyOverride: '', numerals: 'arabic', einvoiceEnabled: false, einvoiceClientSecret: 's',
  };
  const locked = withoutLockedSellerFields(body, true);
  assert.deepEqual(Object.keys(locked).sort(), Object.keys(body).filter(k => !['taxNumber', 'commercialReg', 'countryCode'].includes(k)).sort());
  assert.equal(locked.currencyOverride, '', 'تجاوز العملة يُرسل كما كان (العملة من الدولة المحفوظة عند الخادم)');
  assert.equal(body.taxNumber, '300000000000003', 'لا يعدّل الجسم الأصلي');
  assert.equal(withoutLockedSellerFields(body, false), body, 'غير المقفل (ومنه كل الشركات بلا العلم): الجسم نفسه');
});

test('تبويب الفوترة: فشل إعادة جلب النظرة العامّة والبيانات مخزّنة (react-query الحقيقي: isError مع data) لافتة فوق الجسم لا بطاقة تُزيله بمسوّداته', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let fail = false;
  const httpError = (status: number) => Object.assign(new Error('x'), { response: { status, data: { message: 'تعذر' } } });
  const observer = new QueryObserver(client, {
    queryKey: ['zatca', 'overview'],
    queryFn: async () => { if (fail) throw httpError(502); return { units: [] }; },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.deepEqual(overviewView(observer.getCurrentResult()), { view: 'ready', refreshFailed: false });
    fail = true;
    await observer.refetch();
    const r = observer.getCurrentResult();
    assert.equal(r.isError, true, 'ضبط: react-query يضع isError عند فشل إعادة الجلب');
    assert.ok(r.data, 'ضبط: البيانات المخزّنة باقية');
    assert.deepEqual(overviewView(r), { view: 'ready', refreshFailed: true }, 'فشل التحديث يُزيل جسم التبويب');
    fail = false;
    await observer.refetch();
    assert.deepEqual(overviewView(observer.getCurrentResult()), { view: 'ready', refreshFailed: false }, 'نجاح إعادة المحاولة يُخفي اللافتة');
  } finally {
    unsubscribe();
    client.clear();
  }
  // التحميل الأول: جارٍ ثم فشل بلا بيانات ⇒ بطاقة الخطأ الكاملة كما كانت
  assert.deepEqual(overviewView({ isError: false, data: undefined }), { view: 'loading', refreshFailed: false });
  assert.deepEqual(overviewView({ isError: true, data: undefined }), { view: 'error', refreshFailed: false });
  // الجلب الأول بلا اتصال (react-query الحقيقي: pending + paused، isLoading وisError خطأ) ⇒ تحميل لا بطاقة «تعذر التحميل»
  const offlineClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  onlineManager.setOnline(false);
  const paused = new QueryObserver(offlineClient, { queryKey: ['zatca', 'overview'], queryFn: async () => ({ units: [] }), retry: shouldRetryUnitFetch });
  const unsubscribePaused = paused.subscribe(() => {});
  try {
    const r = paused.getCurrentResult();
    assert.equal(r.fetchStatus, 'paused', 'ضبط: الجلب موقوف بلا اتصال');
    assert.equal(r.isLoading, false, 'ضبط: isLoading خطأ للموقوف');
    assert.equal(r.isError, false);
    assert.deepEqual(overviewView(r), { view: 'loading', refreshFailed: false }, 'الموقوف بلا اتصال يعرض بطاقة الخطأ');
  } finally {
    unsubscribePaused();
    onlineManager.setOnline(true);
    offlineClient.clear();
  }
  // إعادة الجلب: الشبكة و5xx فقط
  assert.equal(shouldRetryUnitFetch(0, httpError(502)), true);
  assert.equal(shouldRetryUnitFetch(0, httpError(429)), false);

  const tab = readTab();
  assert.doesNotMatch(tab, /if \(q\.isError \|\| !q\.data\)/, 'isError وحده (ومنه فشل إعادة الجلب) يعرض بطاقة الخطأ بدل الجسم');
  for (const wire of [
    'const shown = overviewView(q);', "if (shown.view === 'error' || !q.data) {",
    'refreshError={shown.refreshFailed ? { message: apiErrorOf(q.error).message, refreshing: q.isFetching, retry: () => { void q.refetch(); } } : null} />',
    '{refreshError && <OverviewRefreshError {...refreshError} />}',
    "tr('تعذر تحديث بيانات ربط الفوترة الإلكترونية — المعروض آخر ما حمل وتعديلاتك غير المحفوظة باقية')",
  ]) assert.ok(tab.includes(wire), `غير موصول: ${wire}`);
  // استعلام النظرة العامّة: إعادتان للشبكة/5xx لا retry: false
  const overviewQuery = tab.slice(tab.indexOf('queryKey: OVERVIEW_KEY,'), tab.indexOf('const shown = overviewView(q);'));
  assert.match(overviewQuery, /retry: shouldRetryUnitFetch,/);
  // الجسم يُرسم في الموضع نفسه في الحالتين (لافتة شرطية قبله داخله) — لا إعادة تركيب تمحو المسوّدات
  assert.equal(tab.match(/<ZatcaPhase2Body /g)?.length, 1);
});
