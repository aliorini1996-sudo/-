// عُدّة اختبارات Z4 المشتركة (onboarding.test.ts وonboardingRecovery.test.ts): مخزن ذاكرة + «فاتورة» مزيّفة + ساعة
// مُحقنة + مساعدات الاستدعاء + ماسح التسريب. لا شبكة (fetch مزيّف دائماً، وملف الاختبار يستورد حارس Z3 أولاً)
// ولا قاعدة بيانات.
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { FatooraClient, FatooraEnv, FatooraFetch } from '../api';
import {
  EgsUnitView, EnvironmentPolicy, FatooraClientFactory, OnboardingCode, OnboardingFailure,
  abortRenewal, createUnit, onboardUnit, renewUnit, retireUnit,
} from '../onboarding';
import { MemoryEgsUnitStore, SellerSettingsRecord, memoryEgsUnitStore } from '../onboardingStore';
import { SECRET_WINDOW_CHARS } from '../responses';
import { SecretKeyring, createKeyring, decryptSecretBytes } from '../secrets';
import { SELLER } from './z1-sources';
import { z3Fixture, z3FixtureNames } from './z3-fixtures';
import { FAKE_TOKEN_TYPE, FakeZatca, FakeZatcaOptions, fakeZatca } from './z4-fakezatca';

export const TENANT = 'tenant-1';
export const ACTOR = 'admin-7';

export function sellerSettings(over: Partial<SellerSettingsRecord> = {}): SellerSettingsRecord {
  return {
    tenantId: TENANT, legalName: SELLER.legalName as string, taxNumber: SELLER.taxNumber as string, commercialReg: SELLER.commercialReg as string,
    sellerIdScheme: null, sellerIdValue: null, addrStreet: SELLER.addrStreet as string, addrBuildingNo: SELLER.addrBuildingNo as string,
    addrAdditionalNo: SELLER.addrAdditionalNo as string, addrDistrict: SELLER.addrDistrict as string, addrCity: SELLER.addrCity as string,
    addrPostalCode: SELLER.addrPostalCode as string, vatGroupTin: null, countryCode: 'SA', currency: 'SAR', currencyOverride: null,
    einvoiceProvider: 'zatca', zatcaPhase2StartedAt: null, ...over,
  };
}

/**
 * حدود OTP في الماسح: لا يلاصقه رقم ولا حرف. ستّ خانات داخل UUID أو hex أو base64 عشوائي (…-a716324bcdef) ليست تسريباً،
 * وحدود الأرقام وحدها كانت تطابقها فيفشل اختبار سليم مصادفةً.
 */
export const otpPattern = (otp: string) => new RegExp(`(?<![0-9A-Za-z])${otp}(?![0-9A-Za-z])`);
const STANDALONE_SIX_DIGITS = /(?<![0-9A-Za-z])[0-9]{6}(?![0-9A-Za-z])/g;

/**
 * أرقام ثابتة في نصوص تصل المخزن أو النتائج (tokenType «oasis-200401» في كل سجلّ CSID، أجسام Z3، بيانات البائع):
 * لا تُسحب رمزاً، وإلا طابقها الماسح وهي ليست تسريباً.
 */
export const RESERVED_OTPS: ReadonlySet<string> = new Set(
  [FAKE_TOKEN_TYPE, JSON.stringify(sellerSettings()), ...z3FixtureNames().map(n => z3Fixture(n).raw ?? '')]
    .flatMap(t => t.match(STANDALONE_SIX_DIGITS) ?? []),
);

/** OTP عشوائي فريد عبر كل العُدد في العملية وخارج المحجوز. draw للاختبار فقط. */
export const usedOtps = new Set<string>();
export function newOtp(draw: () => number = () => crypto.randomInt(100000, 1000000)): string {
  for (;;) {
    const o = String(draw());
    if (!usedOtps.has(o) && !RESERVED_OTPS.has(o)) {
      usedOtps.add(o);
      return o;
    }
  }
}

/** يسجّل رمزاً مُرِّر للخدمة ضمن رموز العُدّة (رموز «خاطئة» تُسحب في الاختبار نفسه تُمسح أيضاً). */
function trackOtp(h: Harness, otp: unknown) {
  if (typeof otp === 'string' && /^[0-9]{6}$/.test(otp)) h.leakOtps.add(otp);
}

export interface Harness {
  env: FatooraEnv;
  store: MemoryEgsUnitStore;
  keyring: SecretKeyring;
  clock: { t: number; now: () => Date; advance: (ms: number) => void };
  zatca: FakeZatca;
  policy: EnvironmentPolicy;
  client: FatooraClientFactory;
  otps: string[];
  renewalOtps: string[];
  /**
   * كل OTP يخصّ هذه العُدّة: ما سُحب لها (otps/renewalOtps قد تُستهلك بـshift) وما قبلته «الهيئة» وما مُرِّر عبر onboard/renew.
   * الماسح يبحث عن هذه وحدها (مع ما وصل «الهيئة» في ترويسة otp)، لا عن رموز عُدد اختبارات سابقة في العملية.
   */
  leakOtps: Set<string>;
  results: unknown[];
  /** يلفّ fetch المزيّف (بوابة تحبس ردّاً، أو ردّ يضيع بعد أن عالجته «الهيئة»). */
  fetchWrap: ((inner: FatooraFetch) => FatooraFetch) | null;
  /** كل مهلة نوم طُلبت (انتظار المستندات وإعادات الحفظ). */
  sleeps: number[];
}

export function harness(o: { env?: FatooraEnv; productionBackend?: boolean; zatca?: Partial<FakeZatcaOptions>; settings?: Partial<SellerSettingsRecord> } = {}): Harness {
  const env = o.env ?? 'production';
  const otps = [newOtp(), newOtp(), newOtp()];
  const renewalOtps = [newOtp(), newOtp()];
  const zatca = fakeZatca({ env, otps, renewalOtps, ...o.zatca });
  const clock = {
    t: Date.parse('2026-09-16T08:00:00.000Z'),
    now: () => new Date(clock.t),
    advance: (ms: number) => { clock.t += ms; },
  };
  const h: Harness = {
    env, store: memoryEgsUnitStore({ settings: [sellerSettings(o.settings)] }), keyring: createKeyring({ current: crypto.randomBytes(32) }),
    clock, zatca, policy: { productionBackend: o.productionBackend ?? true }, otps, renewalOtps, results: [], fetchWrap: null, sleeps: [],
    leakOtps: new Set([...otps, ...renewalOtps, ...(zatca.opts.otps ?? []), ...(zatca.opts.renewalOtps ?? [])]),
    client: ({ env: e, log }) => new FatooraClient({ env: e, log, fetch: h.fetchWrap ? h.fetchWrap(zatca.fetch) : zatca.fetch }),
  };
  return h;
}

/** نوم مُحقن يقدّم الساعة ويسجّل المهلة (لا انتظار حقيقي). */
export const fakeSleep = (h: Harness) => async (ms: number) => {
  h.sleeps.push(ms);
  h.clock.advance(ms);
};

export async function create(h: Harness, extra: Partial<Parameters<typeof createUnit>[0]> = {}) {
  const r = await createUnit({ store: h.store, policy: h.policy, now: h.clock.now, tenantId: TENANT, env: h.env, actorId: ACTOR, keyring: h.keyring, ...extra });
  h.results.push(r);
  return r;
}

export async function onboard(h: Harness, unitId: string, otp: string | null, extra: Partial<Parameters<typeof onboardUnit>[0]> = {}) {
  trackOtp(h, otp);
  trackOtp(h, extra.otp);
  const r = await onboardUnit({
    store: h.store, policy: h.policy, now: h.clock.now, unitId, tenantId: TENANT, otp, actorId: ACTOR, client: h.client, keyring: h.keyring,
    sleep: fakeSleep(h), ...extra,
  });
  h.results.push(r);
  return r;
}

export async function renew(h: Harness, unitId: string, otp: string, extra: Partial<Parameters<typeof renewUnit>[0]> = {}) {
  trackOtp(h, otp);
  trackOtp(h, extra.otp);
  const r = await renewUnit({
    store: h.store, policy: h.policy, now: h.clock.now, unitId, tenantId: TENANT, otp, actorId: ACTOR, client: h.client, keyring: h.keyring,
    sleep: fakeSleep(h), ...extra,
  });
  h.results.push(r);
  return r;
}

export async function abort(h: Harness, unitId: string, extra: Partial<Parameters<typeof abortRenewal>[0]> = {}) {
  const r = await abortRenewal({ store: h.store, policy: h.policy, now: h.clock.now, unitId, tenantId: TENANT, actorId: ACTOR, ...extra });
  h.results.push(r);
  return r;
}

export async function retire(h: Harness, unitId: string, extra: Partial<Parameters<typeof retireUnit>[0]> = {}) {
  const r = await retireUnit({ store: h.store, policy: h.policy, now: h.clock.now, unitId, tenantId: TENANT, actorId: ACTOR, reason: 'abandoned', ...extra });
  h.results.push(r);
  return r;
}

export function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, `متوقَّع نجاح: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

export function failed(r: { ok: boolean }, code: OnboardingCode): OnboardingFailure {
  assert.equal(r.ok, false, `متوقَّع فشل ${code}: ${JSON.stringify(r)}`);
  const f = r as OnboardingFailure;
  assert.equal(f.code, code, `الكود: ${JSON.stringify(f)}`);
  assert.equal(typeof f.messageAr, 'string');
  assert.match(f.messageAr, /[؀-ۿ]/, 'رسالة عربية');
  return f;
}

export function row(h: Harness, unitId: string) {
  const r = h.store.units.get(unitId);
  assert.ok(r, 'الوحدة موجودة');
  return r;
}

export async function newUnit(h: Harness): Promise<EgsUnitView> {
  return ok(await create(h)).unit;
}

export async function activeUnit(h: Harness): Promise<EgsUnitView> {
  const u = await newUnit(h);
  const r = ok(await onboard(h, u.id, h.otps.shift() as string));
  assert.equal(r.unit.status, 'ACTIVE');
  return r.unit;
}

export const endpoints = (h: Harness) => h.zatca.calls.map(c => c.endpoint);

/**
 * يمسح كل ما خرج من الخدمة أو وصل المخزن: صفوف الوحدات (بما فيها المشفّرة)، سجلّات API، كل حمولة استلمها المخزن، والنتائج.
 * لا OTP يخصّ هذه العُدّة أو وصل «هيئتها» (بحدود otpPattern)، ولا سرّ CSID ولا قيمة Basic (كاملاً أو نافذة 16 بلا حساسية
 * لحالة الأحرف)، ولا مادة مفتاح خاص (DER base64/hex، d، سطر PEM الأول) لأي مفتاح وحدة ظهر يوماً، ولا وسم «PRIVATE KEY».
 */
export function assertNoLeaks(h: Harness, extra: unknown[] = []) {
  const texts = [
    JSON.stringify([...h.store.units.values()]), JSON.stringify(h.store.apiLogs), JSON.stringify(h.store.received), JSON.stringify(h.results),
    JSON.stringify(extra),
  ];
  const all = texts.join('\n');
  const lower = all.toLowerCase();
  const otps = new Set(h.leakOtps);
  for (const c of h.zatca.calls) if (typeof c.headers.otp === 'string' && /^[0-9]+$/.test(c.headers.otp)) otps.add(c.headers.otp);
  assert.ok(otps.size > 0, 'لا رموز للمسح');
  for (const otp of otps) assert.doesNotMatch(all, otpPattern(otp), 'OTP ظاهر');
  const secrets: string[] = [];
  for (const i of h.zatca.issued) secrets.push(i.secret, Buffer.from(`${i.token}:${i.secret}`, 'utf8').toString('base64'));
  for (const s of secrets) {
    assert.ok(!all.includes(s), 'سرّ CSID ظاهر');
    const ls = s.toLowerCase();
    for (let i = 0; i + SECRET_WINDOW_CHARS <= ls.length; i += 4) assert.ok(!lower.includes(ls.slice(i, i + SECRET_WINDOW_CHARS)), 'جزء من سرّ ظاهر');
  }
  // كل مفتاح خاص مشفّر مرّ بالمخزن (وحدات حالية، ومفاتيح استُبدلت بالتجديد أو إعادة التوليد)
  const blobs = new Map<string, string>();
  for (const r of h.store.units.values()) if (r.privateKeyEnc) blobs.set(r.privateKeyEnc, r.id);
  for (const rec of h.store.received) {
    const p = rec.payload as { unitId?: string; id?: string; privateKeyEnc?: string; patch?: { privateKeyEnc?: string } };
    if ((rec.op === 'createUnitIfNone' || rec.op === 'createUnit') && p.privateKeyEnc) blobs.set(p.privateKeyEnc, p.id as string);
    if (rec.op === 'compareAndSetUnit' && p.patch?.privateKeyEnc) blobs.set(p.patch.privateKeyEnc, p.unitId as string);
  }
  assert.ok(blobs.size > 0 || h.store.units.size === 0);
  const marker = ['PRIVATE', 'KEY'].join(' ');
  assert.ok(!all.includes(marker), 'وسم مفتاح خاص ظاهر');
  for (const [blob, owner] of blobs) {
    let der: Buffer;
    try {
      der = decryptSecretBytes(blob, { purpose: 'egs-key', ownerId: owner }, h.keyring);
    } catch {
      continue; // نصّ أُتلف عمداً في اختبار (لا مادة مفتاح فيه)
    }
    const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const d = key.export({ format: 'jwk' }).d as string;
    const pem = key.export({ type: 'pkcs8', format: 'pem' }) as string;
    const sec1 = key.export({ type: 'sec1', format: 'pem' }) as string;
    const materials = [der.toString('base64'), der.toString('hex'), d, Buffer.from(d, 'base64url').toString('hex'), Buffer.from(d, 'base64url').toString('base64'), pem.split('\n')[1], sec1.split('\n')[1]];
    for (const m of materials) assert.ok(!all.includes(m), 'مادة مفتاح خاص ظاهرة');
    assert.ok(!all.includes(d.slice(0, 20)), 'بادئة d ظاهرة');
  }
}
