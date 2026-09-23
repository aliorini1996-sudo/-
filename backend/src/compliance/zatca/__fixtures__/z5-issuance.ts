// تجهيز اختبارات إصدار Z5.2: وحدة EGS اختبارية بمفتاح secp256k1 مشفّر بحلقة مفاتيح اختبارية وشهادة PCSID مبنيّة داخل الاختبار
// (z4-csidcert.ts)، ومخزن وحدات في الذاكرة، ومحاكي المعاملات (z5-locksim.ts)، وخطافات المسار (ترقيم داخل القفل، إنشاء الفاتورة،
// قيد الدفتر) مع سجلّ ترتيب العمليات. لا قاعدة بيانات ولا شبكة ولا ملفات.
import crypto from 'crypto';
import { encryptSecret, createKeyring, type SecretKeyring } from '../secrets';
import { memoryEgsUnitStore, type MemoryEgsUnitStore, type MemoryUnitRow } from '../onboardingStore';
import { phase2NumberPrefix, prepareIssuance, type IssuanceCustomer, type IssuanceRequest, type PreparedIssuance, type IssuedInvoiceRecord } from '../issue';
import { openIssuanceSigning, type IssuanceSigning } from '../issueSigner';
import { runIssuance, stampInTx, type StampInTxDeps, type StampInTxHooks, type StampInTxResult } from '../issueTx';
import type { KeyedAsyncMutex } from '../unitMutex';
import { buildCsidCert } from './z4-csidcert';
import { createLockSim, type LockSim, type SimTx, type SimUnit } from './z5-locksim';
import { COMPANY_VAT, CUSTOMERS, PRODUCTS, REQ_SIMPLIFIED_Z1, Z5_TENANT, Z5_UNIT, Z5_VAT, engineOf, sellerSettings } from './z5-sources';

export const CERT_NOT_BEFORE = new Date('2026-01-01T00:00:00Z');
export const CERT_NOT_AFTER = new Date('2031-01-01T00:00:00Z');
export const T_ISSUE = new Date('2026-12-01T09:00:00.000Z');

export interface TestUnitKeys {
  privateKey: crypto.KeyObject;
  publicKeyPem: string;
  token: string;
  certB64: string;
}

export function newUnitKeys(opts: { vatNumbers?: string[]; notBefore?: Date; notAfter?: Date; subjectKey?: crypto.KeyObject } = {}): TestUnitKeys {
  const privateKey = opts.subjectKey ?? crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;
  const cert = buildCsidCert({
    subjectKey: privateKey, vatNumbers: opts.vatNumbers ?? [Z5_VAT], notBefore: opts.notBefore ?? CERT_NOT_BEFORE, notAfter: opts.notAfter ?? CERT_NOT_AFTER,
  });
  return {
    privateKey, publicKeyPem: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) as string, token: cert.token, certB64: cert.certB64,
  };
}

export function testKeyring(): SecretKeyring {
  return createKeyring({ current: crypto.randomBytes(32) });
}

/** صفّ وحدة ACTIVE في مخزن الذاكرة: المفتاح PKCS#8 مشفّر بـegs-key لمعرّف الوحدة، ورمز PCSID. */
export function unitRow(keyring: SecretKeyring, keys: TestUnitKeys, over: Partial<MemoryUnitRow> = {}): MemoryUnitRow {
  const id = over.id ?? Z5_UNIT;
  const der = keys.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  const at = new Date('2026-10-01T00:00:00Z');
  return {
    id, tenantId: Z5_TENANT, kind: 'SERVER', environment: 'production', commonName: 'EGS-Z5', serialNumber: '1-FS|2-Z5|3-00000000-0000-4000-8000-000000000001',
    functionMap: '1100', orgName: 'org', orgUnit: 'Riyadh', vatNumber: Z5_VAT, locationAddress: 'Riyadh', industry: 'Wholesale', status: 'ACTIVE',
    keyVersion: 1, publicKeyPem: keys.publicKeyPem, csrPem: null, complianceRequestId: null, complianceSteps: null, certSerial: null,
    certNotBefore: CERT_NOT_BEFORE, certNotAfter: CERT_NOT_AFTER, lastIcv: 0, lastInvoiceHash: null, activatedAt: at, revokedAt: null, lastError: null,
    createdAt: at, updatedAt: at, privateKeyEnc: encryptSecret(der, { purpose: 'egs-key', ownerId: id }, keyring), complianceToken: null,
    complianceSecretEnc: null, productionToken: keys.token, productionSecretEnc: null, ...over,
  };
}

export function simUnitOf(row: Pick<MemoryUnitRow, 'id' | 'tenantId' | 'status' | 'environment' | 'keyVersion' | 'vatNumber' | 'lastIcv' | 'lastInvoiceHash' | 'updatedAt'>): SimUnit {
  return {
    id: row.id, tenantId: row.tenantId, status: row.status, environment: row.environment, keyVersion: row.keyVersion, vatNumber: row.vatNumber,
    lastIcv: row.lastIcv, lastInvoiceHash: row.lastInvoiceHash, updatedAt: row.updatedAt,
  };
}

export type OpLog = string[];

export interface Harness {
  keyring: SecretKeyring;
  keys: TestUnitKeys;
  units: MemoryEgsUnitStore;
  sim: LockSim;
  log: OpLog;
  records: IssuedInvoiceRecord[];
  clock: { now: () => Date; set: (d: Date) => void; advance: (ms: number) => void };
  signing: (at?: Date) => Promise<IssuanceSigning>;
  prepare: (o?: { customer?: IssuanceCustomer; request?: IssuanceRequest; at?: Date; settingsOver?: Parameters<typeof sellerSettings>[0] }) => PreparedIssuance;
  deps: (over?: Partial<StampInTxDeps<SimTx>>) => StampInTxDeps<SimTx>;
  hooks: (over?: Partial<StampInTxHooks<SimTx>>) => StampInTxHooks<SimTx>;
  /** إصدار كامل: قفل العملية (اختياري) + معاملة المحاكي + stampInTx. */
  issue: (o?: {
    prepared?: PreparedIssuance; signing?: IssuanceSigning; hooks?: Partial<StampInTxHooks<SimTx>>; deps?: Partial<StampInTxDeps<SimTx>>;
    mutex?: KeyedAsyncMutex | null; timeoutMs?: number; sellerVat?: string | null; onTransaction?: () => void;
  }) => Promise<StampInTxResult>;
}

export function createHarness(opts: { unitOver?: Partial<MemoryUnitRow>; keys?: TestUnitKeys; start?: Date; stepMs?: number } = {}): Harness {
  const keyring = testKeyring();
  const keys = opts.keys ?? newUnitKeys();
  const units = memoryEgsUnitStore({ settings: [sellerSettings()] });
  const row = unitRow(keyring, keys, opts.unitOver);
  units.units.set(row.id, row);
  let t = (opts.start ?? T_ISSUE).getTime();
  const step = opts.stepMs ?? 1000;
  const clock = {
    now: () => { const d = new Date(t); t += step; return d; },
    set: (d: Date) => { t = d.getTime(); },
    advance: (ms: number) => { t += ms; },
  };
  const sim = createLockSim({ units: [simUnitOf(row)], now: () => new Date(t) });
  const log: OpLog = [];
  const records: IssuedInvoiceRecord[] = [];

  const h: Harness = {
    keyring, keys, units, sim, log, records, clock,
    signing: (at?: Date) => openIssuanceSigning({ store: units, keyring, now: at ?? new Date(t) }, { id: row.id, tenantId: row.tenantId, keyVersion: sim.units.get(row.id)!.keyVersion, vatNumber: row.vatNumber }),
    prepare: (o = {}) => {
      const request = o.request ?? REQ_SIMPLIFIED_Z1;
      return prepareIssuance({
        settings: sellerSettings(o.settingsOver), customer: o.customer ?? CUSTOMERS.individual, products: PRODUCTS, request, companyVat: COMPANY_VAT,
        engine: engineOf(request), now: o.at ?? new Date(t),
      });
    },
    deps: (over = {}) => ({
      chain: {
        async lockChainHead(tx, unitId) {
          const r = await sim.chain.lockChainHead(tx, unitId);
          log.push('lock');
          return r;
        },
      },
      documents: {
        async insertSigned(tx, doc) { const r = await sim.documentStore.insertSigned(tx, doc); log.push('insertSigned'); return r; },
        async advanceUnitChain(tx, a) { const r = await sim.documentStore.advanceUnitChain(tx, a); log.push('advance'); return r; },
      },
      now: clock.now,
      ...over,
    }),
    hooks: (over = {}) => ({
      async allocateNumber(tx, issuedAt) {
        const n = await sim.nextNumber(tx, Z5_TENANT, phase2NumberPrefix('INV', issuedAt));
        log.push('number');
        return n;
      },
      async createInvoice(tx, record) {
        const r = await sim.createInvoice(tx, { tenantId: record.tenantId, number: record.number, data: { record } });
        records.push(record);
        log.push('invoice');
        return r;
      },
      async afterDocument(tx, issued) {
        await sim.postLedger(tx, { tenantId: Z5_TENANT, invoiceId: issued.invoiceId, amount: 1 });
        log.push('ledger');
      },
      ...over,
    }),
    issue: async (o = {}) => {
      const prepared = o.prepared ?? h.prepare();
      const signing = o.signing ?? await h.signing();
      const deps = h.deps(o.deps);
      const hooks = h.hooks(o.hooks);
      return runIssuance({
        unitId: signing.unitId,
        mutex: o.mutex === undefined ? null : o.mutex,
        transaction: () => {
          o.onTransaction?.();
          return sim.transaction(tx => stampInTx(tx, deps, { tenantId: Z5_TENANT, prepared, signing, sellerVat: o.sellerVat === undefined ? Z5_VAT : o.sellerVat, hooks }), { timeoutMs: o.timeoutMs });
        },
      });
    },
  };
  return h;
}
