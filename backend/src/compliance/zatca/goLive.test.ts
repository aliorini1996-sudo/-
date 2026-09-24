// ZATCA المرحلة الثانية (Z5.8) — اختبارات منطق التفعيل النقيّ: علم البيئة، التسليح، قرار الانتقال (D11)، جاهزية المناديب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARM_REFUSAL_CODE, computeGoLiveGate, cutoverDecision, goLiveEnvAllows, goLiveNotReadyMessage, isCutoverStatus,
  parseGoLiveEnv, phase1ArmRefusal, repSyncReadiness, unitActiveForGoLive, type RepSyncRow,
} from './goLive';
import type { UnitForIssuance } from './regime';
import type { SellerSettingsRecord } from './onboardingStore';
import { sellerSettings } from './__fixtures__/z4-harness';

const TEN = 'tenant-1';
const NOW = new Date('2026-12-10T09:00:00.000Z');
const ARMED = new Date('2026-12-01T06:00:00.000Z');
const STARTED = new Date('2026-12-02T06:00:00.000Z');
const CERT_FUTURE = new Date('2027-06-01T00:00:00.000Z');

function seller(over: Partial<SellerSettingsRecord> = {}): SellerSettingsRecord {
  return sellerSettings(over);
}
function unit(over: Partial<UnitForIssuance> = {}): UnitForIssuance {
  const s = seller();
  return {
    id: 'u1', tenantId: TEN, environment: 'production', status: 'ACTIVE', keyVersion: 1,
    vatNumber: s.taxNumber as string, certNotAfter: CERT_FUTURE, lastIcv: 0, lastInvoiceHash: null, ...over,
  };
}

// ─── علم البيئة ZATCA_GO_LIVE ───

test('parseGoLiveEnv: الفراغ والغياب و«off» والقيمة المجهولة ⇒ مغلق', () => {
  for (const v of [undefined, '', '  ', 'off', 'OFF', 'maybe', 'allow', 'on-later']) {
    assert.equal(parseGoLiveEnv({ ZATCA_GO_LIVE: v }).mode, 'off', `القيمة: ${v}`);
  }
});

test('parseGoLiveEnv: on ⇒ الكلّ، allowlist ⇒ المعرّفات المذكورة فقط', () => {
  assert.equal(parseGoLiveEnv({ ZATCA_GO_LIVE: 'on' }).mode, 'on');
  const g = parseGoLiveEnv({ ZATCA_GO_LIVE: 'allowlist:tenant-1, tenant-2 ,bad id' });
  assert.equal(g.mode, 'allowlist');
  assert.deepEqual([...g.tenants].sort(), ['tenant-1', 'tenant-2']);
});

test('goLiveEnvAllows: on يفتح للجميع، allowlist للمذكور وحده، off لا أحد', () => {
  assert.equal(goLiveEnvAllows({ ZATCA_GO_LIVE: 'on' }, TEN), true);
  assert.equal(goLiveEnvAllows({ ZATCA_GO_LIVE: 'allowlist:tenant-1' }, TEN), true);
  assert.equal(goLiveEnvAllows({ ZATCA_GO_LIVE: 'allowlist:other' }, TEN), false);
  assert.equal(goLiveEnvAllows({ ZATCA_GO_LIVE: 'off' }, TEN), false);
  assert.equal(goLiveEnvAllows({}, TEN), false);
});

// ─── رفض المرحلة الأولى بعد التسليح (نقد 4) ───

test('phase1ArmRefusal: غير مُسلَّح (armedAt null) ⇒ لا أثر إطلاقاً', () => {
  assert.equal(phase1ArmRefusal({ armedAt: null, startedAt: null, clientCreatedAt: new Date() }), null);
});

test('phase1ArmRefusal: مُسلَّح ولحظة الجهاز قبل التسليح ⇒ يمرّ (يُقبل مرحلة أولى)', () => {
  const before = new Date(ARMED.getTime() - 60_000);
  assert.equal(phase1ArmRefusal({ armedAt: ARMED, startedAt: null, clientCreatedAt: before }), null);
});

test('phase1ArmRefusal: مُسلَّح ولحظة الجهاز عند/بعد التسليح ⇒ يُرفض 409', () => {
  for (const c of [new Date(ARMED.getTime()), new Date(ARMED.getTime() + 1)]) {
    const r = phase1ArmRefusal({ armedAt: ARMED, startedAt: null, clientCreatedAt: c });
    assert.ok(r, 'متوقَّع رفض');
    assert.equal(r!.status, 409);
    assert.equal(r!.body.code, ARM_REFUSAL_CODE);
    assert.match(r!.body.message, /[؀-ۿ]/);
  }
});

test('phase1ArmRefusal: طلب حيّ بلا لحظة جهاز (clientCreatedAt null) ⇒ لا رفض', () => {
  assert.equal(phase1ArmRefusal({ armedAt: ARMED, startedAt: null, clientCreatedAt: null }), null);
});

test('phase1ArmRefusal: بعد التفعيل الفعليّ (startedAt) ⇒ لا رفض هنا (يحكمه فرع المرحلة الثانية)', () => {
  const after = new Date(ARMED.getTime() + 3600_000);
  assert.equal(phase1ArmRefusal({ armedAt: ARMED, startedAt: STARTED, clientCreatedAt: after }), null);
});

// ─── قرار الانتقال (D11) ───

test('cutoverDecision: لحظة جهاز قبل التفعيل وضمن ٧٢ ساعة ⇒ قبول مرحلة أولى', () => {
  const now = new Date(STARTED.getTime() + 24 * 3600_000); // بعد يوم من التفعيل
  const c = new Date(STARTED.getTime() - 3600_000); // قبل التفعيل بساعة
  assert.deepEqual(cutoverDecision({ startedAt: STARTED, clientCreatedAt: c, now }), { kind: 'ACCEPT_PHASE1' });
});

test('cutoverDecision: أُنشئ بعد التفعيل ⇒ مراجعة CREATED_AFTER_GOLIVE', () => {
  const c = new Date(STARTED.getTime() + 60_000);
  assert.deepEqual(cutoverDecision({ startedAt: STARTED, clientCreatedAt: c, now: new Date(STARTED.getTime() + 120_000) }),
    { kind: 'REVIEW', reason: 'CREATED_AFTER_GOLIVE' });
});

test('cutoverDecision: تجاوز مهلة ٧٢ ساعة ⇒ مراجعة WINDOW_EXPIRED', () => {
  const c = new Date(STARTED.getTime() - 3600_000);
  const now = new Date(STARTED.getTime() + 73 * 3600_000);
  assert.deepEqual(cutoverDecision({ startedAt: STARTED, clientCreatedAt: c, now }), { kind: 'REVIEW', reason: 'WINDOW_EXPIRED' });
});

test('cutoverDecision: أقدم من الحدّ (٧ أيام) ⇒ مراجعة TOO_OLD', () => {
  const c = new Date(STARTED.getTime() - 8 * 24 * 3600_000);
  const now = new Date(STARTED.getTime() + 3600_000);
  assert.deepEqual(cutoverDecision({ startedAt: STARTED, clientCreatedAt: c, now }), { kind: 'REVIEW', reason: 'TOO_OLD' });
});

test('cutoverDecision: بلا لحظة جهاز ⇒ مراجعة NO_CLIENT_TIME', () => {
  assert.deepEqual(cutoverDecision({ startedAt: STARTED, clientCreatedAt: null, now: NOW }), { kind: 'REVIEW', reason: 'NO_CLIENT_TIME' });
});

// ─── جاهزية مزامنة المناديب ───

function rep(over: Partial<RepSyncRow> = {}): RepSyncRow {
  return {
    id: 'r1', name: 'مندوب', isActive: true, lastSeenAt: new Date(NOW.getTime() - 3600_000),
    outboxPending: 0, outboxTaxPending: 0, outboxReportedAt: new Date(ARMED.getTime() + 60_000), ...over,
  };
}

test('repSyncReadiness: غير مُسلَّح ⇒ غير جاهز مهما كانت الحالة', () => {
  const r = repSyncReadiness([rep()], null, NOW);
  assert.equal(r.ready, false);
});

test('repSyncReadiness: كلّ مندوب نشط أبلغ صندوقاً فارغاً بعد التسليح ⇒ جاهز', () => {
  const r = repSyncReadiness([rep({ id: 'a' }), rep({ id: 'b' })], ARMED, NOW);
  assert.equal(r.ready, true);
  assert.equal(r.total, 2);
  assert.equal(r.synced, 2);
  assert.equal(r.unsynced.length, 0);
});

test('repSyncReadiness: أسباب عدم المزامنة (NO_REPORT/STALE_REPORT/OUTBOX_PENDING)', () => {
  const reps = [
    rep({ id: 'ok' }),
    rep({ id: 'noreport', outboxReportedAt: null }),
    rep({ id: 'stale', outboxReportedAt: new Date(ARMED.getTime() - 60_000) }),
    rep({ id: 'pendingtax', outboxTaxPending: 2 }),
    rep({ id: 'pending', outboxPending: 1 }),
  ];
  const r = repSyncReadiness(reps, ARMED, NOW);
  assert.equal(r.ready, false);
  const byId = Object.fromEntries(r.unsynced.map(u => [u.id, u.reason]));
  assert.equal(byId.noreport, 'NO_REPORT');
  assert.equal(byId.stale, 'STALE_REPORT');
  assert.equal(byId.pendingtax, 'OUTBOX_PENDING');
  assert.equal(byId.pending, 'OUTBOX_PENDING');
  assert.equal('ok' in byId, false);
});

test('repSyncReadiness: مندوب غير نشط أو لم يظهر خلال ١٤ يوماً لا يُحسب', () => {
  const reps = [
    rep({ id: 'inactive', isActive: false, outboxReportedAt: null }),
    rep({ id: 'gone', lastSeenAt: new Date(NOW.getTime() - 20 * 24 * 3600_000), outboxReportedAt: null }),
    rep({ id: 'never', lastSeenAt: null, outboxReportedAt: null }),
    rep({ id: 'active' }),
  ];
  const r = repSyncReadiness(reps, ARMED, NOW);
  assert.equal(r.total, 1, 'المندوب النشط الظاهر وحده يُحسب');
  assert.equal(r.ready, true);
});

test('repSyncReadiness: لا مناديب نشطين ⇒ جاهز (لا أحد يجب مزامنته) حين مُسلَّح', () => {
  assert.equal(repSyncReadiness([], ARMED, NOW).ready, true);
});

// ─── البوابة الكاملة ───

test('unitActiveForGoLive: وحدة إنتاج مفعّلة سارية ورقمها الضريبي = البائع ⇒ true', () => {
  assert.equal(unitActiveForGoLive([unit()], seller(), { productionBackend: true }, NOW), true);
});

test('unitActiveForGoLive: صفر أو أكثر من وحدة، أو شهادة منتهية، أو رقم ضريبي مختلف ⇒ false', () => {
  const pol = { productionBackend: true };
  assert.equal(unitActiveForGoLive([], seller(), pol, NOW), false);
  assert.equal(unitActiveForGoLive([unit({ id: 'a' }), unit({ id: 'b' })], seller(), pol, NOW), false);
  assert.equal(unitActiveForGoLive([unit({ certNotAfter: new Date('2020-01-01') })], seller(), pol, NOW), false);
  assert.equal(unitActiveForGoLive([unit({ vatNumber: '300000000000003' })], seller(), pol, NOW), false);
  assert.equal(unitActiveForGoLive([unit({ status: 'RENEWING' })], seller(), pol, NOW), false);
  // على خادم الإنتاج بيئة simulation مرفوضة
  assert.equal(unitActiveForGoLive([unit({ environment: 'simulation' })], seller(), pol, NOW), false);
});

test('computeGoLiveGate: متاح فقط حين تكتمل كلّ الفحوص (مُسلَّح + وحدة + بائع + SAR + مناديب + علم)', () => {
  const base = {
    settings: seller(), units: [unit()], armedAt: ARMED, reps: [rep()], policy: { productionBackend: true },
    envAllows: true, storeReady: true, now: NOW,
  };
  assert.equal(computeGoLiveGate(base).available, true);
  assert.equal(computeGoLiveGate({ ...base, envAllows: false }).available, false);
  assert.equal(computeGoLiveGate({ ...base, armedAt: null }).available, false);
  assert.equal(computeGoLiveGate({ ...base, units: [] }).available, false);
  assert.equal(computeGoLiveGate({ ...base, settings: seller({ countryCode: 'AE' }) }).available, false);
  assert.equal(computeGoLiveGate({ ...base, settings: seller({ currencyOverride: 'USD' }) }).available, false);
  assert.equal(computeGoLiveGate({ ...base, reps: [rep({ outboxTaxPending: 3 })] }).available, false);
  assert.equal(computeGoLiveGate({ ...base, storeReady: false }).available, false);
});

test('goLiveNotReadyMessage: يسمّي الفحص الناقص بالعربية', () => {
  const gate = computeGoLiveGate({
    settings: seller(), units: [], armedAt: null, reps: [], policy: { productionBackend: true },
    envAllows: false, storeReady: true, now: NOW,
  });
  const msg = goLiveNotReadyMessage(gate);
  assert.match(msg, /[؀-ۿ]/);
  assert.match(msg, /تسليح|بيئة/);
});

test('isCutoverStatus: يقبل الحالات الأربع فقط', () => {
  for (const s of ['PENDING', 'ACCEPTED_PHASE1', 'ACCEPTED_PHASE2', 'REJECTED']) assert.equal(isCutoverStatus(s), true);
  for (const s of ['pending', 'ACCEPTED', '', null, 3]) assert.equal(isCutoverStatus(s), false);
});
