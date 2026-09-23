// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — فتح مفتاح التوقيع وشهادة الوحدة قبل معاملة الإصدار (لكل طلب، بلا تخزين مؤقت)
// ----------------------------------------------------------------------------
// z5_plan §2.2 «Before the transaction» 1–3 + design Z5.2 «Private key» + نقد الخطة (9):
//   • الترتيب: صفّ الوحدة العام أولاً (keyVersion وpublicKeyPem) ثم بيانات الاعتماد — تجديدٌ يقع بينهما أو بعدهما يظهر داخل القفل
//     فرقاً في keyVersion ⇒ ZATCA_UNIT_BUSY (إعادة بمفتاح جديد)، فلا يُسجَّل مستند بنسخة مفتاح غير التي وقّعته.
//   • openUnitSigningKey (Z4) ⇒ createServerSigner؛ الشهادة parseCsidToken(productionToken) (رمز PCSID للوحدة: production للحيّة
//     وsimulation للبروفة). مفتاح الموقِّع يطابق مفتاح الشهادة، والشهادة سارية الآن.
//   • لا تخزين مؤقت للمفتاح عبر الطلبات، ولا يُسجَّل شيء من المفتاح أو الأسرار؛ الأعطال رموز ثابتة فقط (logDetail).
//   • الأخطاء: حلقة المفاتيح/السرّ ⇒ 503 SECRETS؛ رمز أو مفتاح أو شهادة غير صالحة ⇒ 503 UNIT_CONFIG (تنبيه)؛ حالة غير ACTIVE
//     ⇒ سببها؛ شهادة منتهية ⇒ EXPIRED؛ نسخة مفتاح تغيّرت منذ قرار النظام ⇒ ZATCA_UNIT_BUSY.
// لا قاعدة بيانات مباشرة (المخزن يُحقن) ولا شبكة ولا services/gl.
// ============================================================================

import type { CsidCert } from './cert';
import { parseCsidToken } from './cert';
import { unitUnavailableError, ZatcaHttpError, type UnitUnavailableReason } from './errors';
import { unavailableForStatus } from './issueChain';
import { openUnitSigningKey } from './onboarding';
import type { EgsUnitStore } from './onboardingStore';
import type { SecretKeyring } from './secrets';
import { SecretsError } from './secrets';
import { createServerSigner, type HashSigner } from './stamp';

export interface IssuanceSigning {
  unitId: string;
  tenantId: string;
  environment: string;
  /** نسخة المفتاح التي فُتحت (تُطابَق تحت القفل وتُحفظ على المستند). */
  keyVersion: number;
  vatNumber: string;
  signer: HashSigner;
  cert: CsidCert;
}

export interface OpenIssuanceSigningDeps {
  store: Pick<EgsUnitStore, 'loadUnit' | 'loadUnitCredentials'>;
  /** حلقة المفاتيح أو دالة تُحمّلها (keyringFromEnv يرمي SecretsError حين يغيب المفتاح). */
  keyring: SecretKeyring | (() => SecretKeyring);
  now: Date;
}

/** ما قرّره النظام الضريبي عن الوحدة (regime.ts UnitForIssuance). */
export interface IssuanceUnitRef {
  id: string;
  tenantId: string;
  keyVersion: number;
  vatNumber: string;
}

const unavailable = (reason: UnitUnavailableReason, code: string) => unitUnavailableError(reason, { source: 'SIGNING', code });
const busy = (code: string) => new ZatcaHttpError('ZATCA_UNIT_BUSY', { logDetail: { source: 'SIGNING', code } });

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  return !!a && !!b && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

/**
 * يفتح موقِّع الوحدة وشهادتها لطلب إصدار واحد. يرمي ZatcaHttpError فقط.
 */
export async function openIssuanceSigning(deps: OpenIssuanceSigningDeps, unit: IssuanceUnitRef): Promise<IssuanceSigning> {
  let keyring: SecretKeyring;
  try {
    keyring = typeof deps.keyring === 'function' ? deps.keyring() : deps.keyring;
  } catch (e) {
    if (e instanceof SecretsError) throw unitUnavailableError('SECRETS', { source: 'SecretsError', code: e.code });
    throw unavailable('SECRETS', 'keyring');
  }
  const rec = await deps.store.loadUnit(unit.id);
  if (!rec || rec.tenantId !== unit.tenantId) throw unavailable('NO_ACTIVE_UNIT', 'missing');
  if (rec.status !== 'ACTIVE') throw unavailableForStatus(rec.status, 'SIGNING');
  if (rec.keyVersion !== unit.keyVersion) throw busy('KEY_VERSION');
  if (rec.vatNumber !== unit.vatNumber) throw unavailable('SELLER_VAT_CHANGED', 'vat');

  const creds = await deps.store.loadUnitCredentials(unit.id);
  if (!creds || typeof creds.privateKeyEnc !== 'string' || creds.privateKeyEnc === '') throw unavailable('UNIT_CONFIG', 'key-missing');
  if (typeof creds.productionToken !== 'string' || creds.productionToken === '') throw unavailable('UNIT_CONFIG', 'pcsid-missing');

  const opened = openUnitSigningKey({ unitId: unit.id, privateKeyEnc: creds.privateKeyEnc, publicKeyPem: rec.publicKeyPem, keyring });
  if (!opened.ok) {
    if (opened.code === 'SECRETS_UNAVAILABLE' || opened.code === 'STORED_SECRET_INVALID') throw unavailable('SECRETS', opened.code);
    if (opened.detail === 'KEY_MISMATCH') await raceOrConfig(deps, unit, 'KEY_MISMATCH');
    throw unavailable('UNIT_CONFIG', opened.detail ?? opened.code);
  }

  let signer: HashSigner;
  try {
    signer = createServerSigner(opened.key);
  } catch {
    throw unavailable('UNIT_CONFIG', 'signer');
  }
  let cert: CsidCert;
  try {
    cert = parseCsidToken(creds.productionToken);
  } catch {
    throw unavailable('UNIT_CONFIG', 'cert');
  }
  if (!bytesEqual(signer.publicKeySpkiDer, cert.spkiDer)) {
    await raceOrConfig(deps, unit, 'CERT_KEY_MISMATCH');
    throw unavailable('UNIT_CONFIG', 'CERT_KEY_MISMATCH');
  }
  const t = deps.now.getTime();
  if (!(t >= cert.notBefore.getTime() && t < cert.notAfter.getTime())) throw unavailable('EXPIRED', 'cert-window');
  return { unitId: unit.id, tenantId: unit.tenantId, environment: rec.environment, keyVersion: rec.keyVersion, vatNumber: rec.vatNumber, signer, cert };
}

/** مفتاح لا يطابق: إن تغيّرت نسخة المفتاح منذ القراءة الأولى فهو سباق تجديد (BUSY)، وإلا عطل إعداد يُكمل المستدعي رميه. */
async function raceOrConfig(deps: OpenIssuanceSigningDeps, unit: IssuanceUnitRef, code: string): Promise<void> {
  const again = await deps.store.loadUnit(unit.id);
  if (!again || again.keyVersion !== unit.keyVersion || again.status !== 'ACTIVE') throw busy(code);
}
