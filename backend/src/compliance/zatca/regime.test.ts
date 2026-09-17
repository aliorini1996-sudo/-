// اختبارات Z5.0 للنظام الضريبي (regime.ts): المصفوفة الكاملة للقرار النقيّ، و«إطفاء العلم بعد التفعيل يبقى مرحلة ثانية»،
// و«البروفة تُتجاهل بعد التفعيل»، وSELLER_VAT_CHANGED/SELLER_NOT_READY (نقد الخطة 12)، والمحمِّل: المرحلة الأولى بلا أي
// استعلام (عميل مزيّف يرمي عند أي نداء)، وجمع بيانات المشتري بالعلم أو التفعيل (نقد الخطة 5). لا قاعدة بيانات ولا شبكة.
import './__fixtures__/z3-netguard';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SellerSettingsRecord } from './onboardingStore';
import {
  REGIME_UNIT_STATUSES, RegimeDb, RegimeSettings, UnitForIssuance, regimeCandidate, regimeView, rehearsalTenantIds, resolveInvoiceRegime,
  resolveRegimeFrom, sellerNotReady, zatcaCollectOn,
} from './regime';
import { SELLER } from './__fixtures__/z1-sources';

const T = 'tenant-a';
const NOW = new Date('2026-12-01T09:00:00.000Z');
const LIVE_AT = new Date('2026-11-20T06:00:00.000Z');
const VAT = SELLER.taxNumber as string;

function settings(over: Partial<RegimeSettings> = {}): RegimeSettings {
  return { countryCode: 'SA', einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, taxNumber: VAT, ...over };
}

function seller(over: Partial<SellerSettingsRecord> = {}): SellerSettingsRecord {
  return {
    tenantId: T, legalName: SELLER.legalName as string, taxNumber: VAT, commercialReg: SELLER.commercialReg as string, sellerIdScheme: null,
    sellerIdValue: null, addrStreet: SELLER.addrStreet as string, addrBuildingNo: SELLER.addrBuildingNo as string,
    addrAdditionalNo: SELLER.addrAdditionalNo as string, addrDistrict: SELLER.addrDistrict as string, addrCity: SELLER.addrCity as string,
    addrPostalCode: SELLER.addrPostalCode as string, vatGroupTin: null, countryCode: 'SA', currency: 'SAR', currencyOverride: null,
    einvoiceProvider: 'zatca', zatcaPhase2StartedAt: LIVE_AT, ...over,
  };
}

function unit(over: Partial<UnitForIssuance> = {}): UnitForIssuance {
  return {
    id: 'u-prod', tenantId: T, environment: 'production', status: 'ACTIVE', keyVersion: 1, vatNumber: VAT,
    certNotAfter: new Date('2027-11-01T00:00:00.000Z'), lastIcv: 7, lastInvoiceHash: 'h7', ...over,
  };
}

const ENV = {} as Record<string, string | undefined>;
const REHEARSE = { ZATCA_REHEARSAL_TENANT_IDS: ` other , ${T} ,bad id!` };

test('fixture: بيانات البائع المرجعية جاهزة (وإلا صارت كل حالة SELLER_NOT_READY)', () => {
  assert.equal(sellerNotReady(seller()), false);
});

test('المرحلة الأولى: غير مفعّلة وخارج قائمة البروفة ⇒ phase 1 مهما كانت الوحدات والعلم والدولة', () => {
  for (const s of [settings(), settings({ countryCode: 'EG', einvoiceProvider: 'eta' }), settings({ countryCode: null, einvoiceProvider: null }), null]) {
    for (const tenantFlag of [true, false, null, undefined]) {
      assert.deepEqual(resolveRegimeFrom({ tenantId: T, settings: s, tenantFlag, units: [unit()], seller: seller(), env: ENV, now: NOW }), { phase: 1 });
    }
  }
  // وحدة simulation مفعّلة وعلم بلا قائمة البروفة: مرحلة أولى
  assert.deepEqual(resolveRegimeFrom({ tenantId: T, settings: settings(), tenantFlag: true, units: [unit({ environment: 'simulation' })], env: ENV, now: NOW }), { phase: 1 });
});

test('حيّة: وحدة production مفعّلة سارية برقم المنشأة ⇒ phase 2 live بالوحدة — والعلم مطفأ بعد التفعيل يبقى مرحلة ثانية', () => {
  for (const tenantFlag of [true, false, null, undefined]) {
    const r = resolveRegimeFrom({ tenantId: T, settings: settings({ zatcaPhase2StartedAt: LIVE_AT }), tenantFlag, units: [unit()], seller: seller(), env: ENV, now: NOW });
    assert.equal(r.phase, 2, String(tenantFlag));
    assert.ok(r.phase === 2 && 'unit' in r && r.mode === 'live' && r.unit.id === 'u-prod');
  }
});

test('حيّة محجوبة: كل سبب بترتيبه', () => {
  const live = settings({ zatcaPhase2StartedAt: LIVE_AT });
  const blocked = (units: UnitForIssuance[], over: Partial<{ s: RegimeSettings; seller: SellerSettingsRecord | null }> = {}) => {
    const r = resolveRegimeFrom({ tenantId: T, settings: over.s ?? live, units, seller: over.seller === undefined ? seller() : over.seller, env: ENV, now: NOW });
    assert.equal(r.phase, 2);
    return r.phase === 2 && 'blocked' in r ? r.blocked : `unit:${(r as { unit: UnitForIssuance }).unit.id}`;
  };
  assert.equal(blocked([]), 'NO_ACTIVE_UNIT');
  assert.equal(blocked([unit({ status: 'REVOKED' }), unit({ id: 'u2', status: 'CSR_READY' })]), 'NO_ACTIVE_UNIT');
  assert.equal(blocked([unit({ status: 'RENEWING' })]), 'RENEWING');
  assert.equal(blocked([unit({ status: 'AUTH_FAILED' })]), 'AUTH_FAILED');
  assert.equal(blocked([unit({ status: 'EXPIRED' })]), 'EXPIRED');
  assert.equal(blocked([unit({ status: 'AUTH_FAILED' }), unit({ id: 'u2', status: 'RENEWING' })]), 'RENEWING', 'التجديد أولى من عطل قديم');
  // لا يكتب أحد EXPIRED: يُشتقّ من certNotAfter (الحدّ نفسه منتهٍ)
  assert.equal(blocked([unit({ certNotAfter: NOW })]), 'EXPIRED');
  assert.equal(blocked([unit({ certNotAfter: new Date(NOW.getTime() - 1) })]), 'EXPIRED');
  assert.equal(blocked([unit({ certNotAfter: null })]), 'EXPIRED');
  assert.equal(blocked([unit({ certNotAfter: new Date(NOW.getTime() + 1) })]), 'unit:u-prod');
  assert.equal(blocked([unit(), unit({ id: 'u2' })]), 'MULTIPLE_ACTIVE_UNITS');
  // وحدة مفعّلة لبيئة أخرى أو لشركة أخرى لا تُحسب
  assert.equal(blocked([unit({ environment: 'simulation' })]), 'NO_ACTIVE_UNIT');
  assert.equal(blocked([unit({ tenantId: 'other' })]), 'NO_ACTIVE_UNIT');
  // نقد الخطة 12: رقم المنشأة تغيّر بعد الربط
  assert.equal(blocked([unit()], { s: settings({ zatcaPhase2StartedAt: LIVE_AT, taxNumber: '311111111111113' }) }), 'SELLER_VAT_CHANGED');
  assert.equal(blocked([unit()], { s: settings({ zatcaPhase2StartedAt: LIVE_AT, taxNumber: null }) }), 'SELLER_VAT_CHANGED');
  // بيانات البائع لا تصلح
  assert.equal(blocked([unit()], { seller: seller({ addrBuildingNo: null }) }), 'SELLER_NOT_READY');
  assert.equal(blocked([unit()], { seller: seller({ taxNumber: '399999999910003', vatGroupTin: null }) }), 'SELLER_NOT_READY', 'مجموعة ضريبية بلا TIN العضو');
  assert.equal(blocked([unit()], { s: settings({ zatcaPhase2StartedAt: LIVE_AT, countryCode: 'EG' }) }), 'SELLER_NOT_READY');
  assert.equal(blocked([unit()], { s: settings({ zatcaPhase2StartedAt: LIVE_AT, einvoiceProvider: 'none' }) }), 'SELLER_NOT_READY');
  // بلا بيانات بائع ممرَّرة: لا فحص جاهزية (المحمِّل يمرّرها دائماً)
  assert.equal(blocked([unit()], { seller: null }), 'unit:u-prod');
});

test('البروفة: القائمة + العلم + SA + zatca ⇒ rehearsal بوحدة simulation؛ ناقص شرط ⇒ مرحلة أولى؛ بلا وحدة ⇒ محجوبة', () => {
  assert.deepEqual([...rehearsalTenantIds(REHEARSE)].sort(), ['other', T].sort(), 'المعرّف غير الصالح يُهمل');
  assert.equal(rehearsalTenantIds({}).size, 0);
  const sim = unit({ id: 'u-sim', environment: 'simulation' });
  const r = resolveRegimeFrom({ tenantId: T, settings: settings(), tenantFlag: true, units: [unit(), sim], seller: seller({ zatcaPhase2StartedAt: null }), env: REHEARSE, now: NOW });
  assert.ok(r.phase === 2 && r.mode === 'rehearsal' && 'unit' in r && r.unit.id === 'u-sim', JSON.stringify(r));
  for (const [tenantFlag, s] of [[false, settings()], [null, settings()], [true, settings({ countryCode: 'AE' })], [true, settings({ einvoiceProvider: 'none' })]] as const) {
    assert.deepEqual(resolveRegimeFrom({ tenantId: T, settings: s, tenantFlag, units: [sim], env: REHEARSE, now: NOW }), { phase: 1 });
  }
  const none = resolveRegimeFrom({ tenantId: T, settings: settings(), tenantFlag: true, units: [unit()], env: REHEARSE, now: NOW });
  assert.deepEqual(none, { phase: 2, mode: 'rehearsal', blocked: 'NO_ACTIVE_UNIT' }, 'وحدة production لا تصلح للبروفة');
  // شركة أخرى في القائمة لا تفتح لغيرها
  assert.deepEqual(resolveRegimeFrom({ tenantId: 'tenant-z', settings: settings(), tenantFlag: true, units: [sim], env: REHEARSE, now: NOW }), { phase: 1 });
});

test('البروفة تُتجاهل تماماً بعد التفعيل الحيّ (production وحدها)', () => {
  const sim = unit({ id: 'u-sim', environment: 'simulation' });
  const r = resolveRegimeFrom({ tenantId: T, settings: settings({ zatcaPhase2StartedAt: LIVE_AT }), tenantFlag: true, units: [sim], seller: seller(), env: REHEARSE, now: NOW });
  assert.deepEqual(r, { phase: 2, mode: 'live', blocked: 'NO_ACTIVE_UNIT' });
  const ok = resolveRegimeFrom({ tenantId: T, settings: settings({ zatcaPhase2StartedAt: LIVE_AT }), tenantFlag: false, units: [sim, unit()], seller: seller(), env: REHEARSE, now: NOW });
  assert.ok(ok.phase === 2 && ok.mode === 'live' && 'unit' in ok && ok.unit.id === 'u-prod');
  assert.equal(regimeCandidate({ tenantId: T, settings: settings({ zatcaPhase2StartedAt: LIVE_AT }), env: REHEARSE }), 'live');
});

test('regimeView: بلا معرّف وحدة ولا رقم ضريبي', () => {
  assert.deepEqual(regimeView({ phase: 1 }), { phase: 1 });
  assert.deepEqual(regimeView({ phase: 2, mode: 'live', unit: unit() }), { phase: 2, mode: 'live', blocked: null });
  assert.deepEqual(regimeView({ phase: 2, mode: 'rehearsal', blocked: 'RENEWING' }), { phase: 2, mode: 'rehearsal', blocked: 'RENEWING' });
});

test('zatcaCollectOn: (العلم || التفعيل) && SA — العلم المطفأ بعد التفعيل لا يُسقط الجمع', () => {
  const cases: Array<[boolean | null | undefined, { countryCode: string | null; zatcaPhase2StartedAt: Date | null } | null, boolean]> = [
    [true, { countryCode: 'SA', zatcaPhase2StartedAt: null }, true],
    [false, { countryCode: 'SA', zatcaPhase2StartedAt: LIVE_AT }, true],
    [null, { countryCode: 'SA', zatcaPhase2StartedAt: LIVE_AT }, true],
    [false, { countryCode: 'SA', zatcaPhase2StartedAt: null }, false],
    [undefined, { countryCode: 'SA', zatcaPhase2StartedAt: null }, false],
    [true, { countryCode: 'AE', zatcaPhase2StartedAt: null }, false],
    [true, { countryCode: null, zatcaPhase2StartedAt: null }, false],
    [true, null, false],
    ['true' as unknown as boolean, { countryCode: 'SA', zatcaPhase2StartedAt: null }, false],
  ];
  for (const [tenantFlag, s, want] of cases) assert.equal(zatcaCollectOn({ tenantFlag, settings: s }), want, JSON.stringify([tenantFlag, s]));
});

// ─── المحمِّل ───

interface Calls { units: unknown[]; tenant: unknown[]; settings: unknown[] }

function fakeDb(opts: { throwAll?: boolean; units?: UnitForIssuance[]; flag?: boolean; seller?: SellerSettingsRecord | null } = {}): { db: RegimeDb; calls: Calls } {
  const calls: Calls = { units: [], tenant: [], settings: [] };
  const boom = () => { throw new Error('استعلام غير متوقَّع في المرحلة الأولى'); };
  const db = {
    zatcaEgsUnit: { findMany: async (a: unknown) => { if (opts.throwAll) boom(); calls.units.push(a); return opts.units ?? []; } },
    tenant: { findUnique: async (a: unknown) => { if (opts.throwAll) boom(); calls.tenant.push(a); return { zatcaPhase2Enabled: opts.flag === true }; } },
    companySettings: { findUnique: async (a: unknown) => { if (opts.throwAll) boom(); calls.settings.push(a); return opts.seller === undefined ? seller() : opts.seller; } },
  } as unknown as RegimeDb;
  return { db, calls };
}

test('المحمِّل: المرحلة الأولى بلا أي استعلام (عميل يرمي عند أي نداء)', async () => {
  const { db } = fakeDb({ throwAll: true });
  for (const s of [settings(), settings({ countryCode: 'EG', einvoiceProvider: 'eta' }), null]) {
    assert.deepEqual(await resolveInvoiceRegime(db, T, s, { env: ENV, now: NOW }), { phase: 1 });
    assert.deepEqual(await resolveInvoiceRegime(db, T, s, { env: { ZATCA_REHEARSAL_TENANT_IDS: 'someone-else' }, now: NOW }), { phase: 1 });
  }
});

test('المحمِّل: الحيّة تقرأ وحدات production بالحالات الأربع + البائع، ولا تقرأ العلم', async () => {
  const { db, calls } = fakeDb({ units: [unit()] });
  const r = await resolveInvoiceRegime(db, T, settings({ zatcaPhase2StartedAt: LIVE_AT }), { env: REHEARSE, now: NOW });
  assert.ok(r.phase === 2 && 'unit' in r && r.mode === 'live');
  assert.equal(calls.tenant.length, 0);
  assert.equal(calls.units.length, 1);
  assert.deepEqual((calls.units[0] as { where: unknown }).where, { tenantId: T, environment: 'production', status: { in: [...REGIME_UNIT_STATUSES] } });
  const sel = (calls.units[0] as { select: Record<string, unknown> }).select;
  for (const secret of ['privateKeyEnc', 'productionToken', 'productionSecretEnc', 'complianceToken', 'complianceSecretEnc']) assert.equal(sel[secret], undefined, secret);
  assert.equal(calls.settings.length, 1);
  // بائع ممرَّر: لا قراءة له
  const second = fakeDb({ units: [unit()] });
  await resolveInvoiceRegime(second.db, T, settings({ zatcaPhase2StartedAt: LIVE_AT }), { env: ENV, now: NOW, seller: seller() });
  assert.equal(second.calls.settings.length, 0);
});

test('المحمِّل: مرشّح البروفة يقرأ العلم أولاً — مطفأ ⇒ مرحلة أولى بلا قراءة وحدات؛ مفعّل ⇒ وحدات simulation', async () => {
  const off = fakeDb({ flag: false, units: [unit({ environment: 'simulation' })] });
  assert.deepEqual(await resolveInvoiceRegime(off.db, T, settings(), { env: REHEARSE, now: NOW }), { phase: 1 });
  assert.equal(off.calls.tenant.length, 1);
  assert.equal(off.calls.units.length, 0);
  const on = fakeDb({ flag: true, units: [unit({ id: 'u-sim', environment: 'simulation' })], seller: seller({ zatcaPhase2StartedAt: null }) });
  const r = await resolveInvoiceRegime(on.db, T, settings(), { env: REHEARSE, now: NOW });
  assert.ok(r.phase === 2 && r.mode === 'rehearsal' && 'unit' in r && r.unit.id === 'u-sim', JSON.stringify(r));
  assert.equal((on.calls.units[0] as { where: { environment: string } }).where.environment, 'simulation');
  // الدولة غير SA في الإعدادات: لا قراءة وحدات
  const eg = fakeDb({ flag: true });
  assert.deepEqual(await resolveInvoiceRegime(eg.db, T, settings({ countryCode: 'EG', einvoiceProvider: 'eta' }), { env: REHEARSE, now: NOW }), { phase: 1 });
  assert.equal(eg.calls.units.length, 0);
});
