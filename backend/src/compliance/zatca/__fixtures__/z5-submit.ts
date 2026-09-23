// تجهيز اختبارات الإرسال Z5.3: مخزن مستندات في الذاكرة بمعاملة قابلة للتراجع (لاختبار الانهيار بين الخطوتين)، ووحدة EGS
// اختبارية بمفتاح ورمز PCSID وسرّ مشفَّر، ومنصّة «فاتورة» مزيّفة، وعميل Z3 حقيقي فوقها. لا قاعدة بيانات ولا شبكة ولا ملفات.
import crypto from 'crypto';
import { FatooraClient, type ApiLogEntry, type FatooraEnv } from '../api';
import {
  memoryZatcaDocumentStore, type MemoryDocumentRow, type MemoryInvoiceMirrorRow, type MemoryZatcaDocumentStore,
} from '../documentStore';
import type { IssuanceChainStore } from '../issueChain';
import { openIssuanceSigning, type IssuanceSigning } from '../issueSigner';
import { stampInTx, type StampInTxResult } from '../issueTx';
import { phase2NumberPrefix, prepareIssuance, type IssuanceCustomer, type IssuanceRequest, type PreparedIssuance } from '../issue';
import { memoryEgsUnitStore, type MemoryEgsUnitStore, type MemoryUnitRow } from '../onboardingStore';
import { createKeyring, encryptSecret, type SecretKeyring } from '../secrets';
import { AuthFailureMemory, UnitPauseMemory, type SubmitDeps, type SubmitNotification, type TenantSubmitGate } from '../submit';
import type { SweepDeps } from '../sweep';
import { SubmitSlots } from '../sweep';
import { fakeFatoora, type FakeFatoora, type FakeFatooraOptions } from './z5-fakezatca';
import { newUnitKeys, unitRow, type TestUnitKeys } from './z5-issuance';
import { COMPANY_VAT, CUSTOMERS, PRODUCTS, REQ_SIMPLIFIED_Z1, REQ_STANDARD_Z1, Z5_TENANT, Z5_UNIT, Z5_VAT, engineOf, sellerSettings } from './z5-sources';

export const SUBMIT_T0 = new Date('2026-12-01T09:00:00.000Z');
export const PCSID_SECRET = 'fake-pcsid-secret-not-real-0123456789';
/** عيّنة Z1 القياسية بتاريخ توريد اليوم (تاريخها الأصلي أقدم من سماح VATIR-53 عند ساعة هذه الاختبارات). */
export const REQ_STANDARD_NOW: IssuanceRequest = { ...REQ_STANDARD_Z1, supplyDate: null };

export interface HarnessClock {
  now: () => Date;
  set: (d: Date) => void;
  advance: (ms: number) => void;
}

export interface IssuedForSubmit {
  documentId: string;
  invoiceId: string;
  icv: number;
  uuid: string;
  qr: string;
  invoiceHash: string;
  typeName: string;
  result: StampInTxResult;
}

export interface SubmitHarness {
  tenantId: string;
  unitId: string;
  keyring: SecretKeyring;
  keys: TestUnitKeys;
  units: MemoryEgsUnitStore;
  docs: MemoryZatcaDocumentStore;
  fake: FakeFatoora;
  deps: SweepDeps<unknown>;
  slots: SubmitSlots;
  clock: HarnessClock;
  notifications: SubmitNotification[];
  published: string[];
  gates: Map<string, TenantSubmitGate>;
  /** عدد استعلامات المخزن (للتأكّد من «استعلام واحد حين لا عمل»). */
  queries: { claimBatch: number; gate: number; overdue: number; total: number };
  /** يرمي من المعاملة بعد fn (محاكاة انهيار قبل الالتزام). */
  failNextTransaction: (why?: string) => void;
  /** سلسلة الوحدة (قفل الرأس) وموقّعها — يحتاجهما Z5.4 لإعادة الإصدار داخل معاملة. */
  chain: IssuanceChainStore<unknown>;
  signing: () => Promise<IssuanceSigning>;
  issue: (o?: { standard?: boolean; customer?: IssuanceCustomer; request?: IssuanceRequest; at?: Date }) => Promise<IssuedForSubmit>;
  setUnitStatus: (status: string) => void;
  setKeyVersion: (v: number) => void;
  doc: (id: string) => MemoryDocumentRow;
  invoice: (id: string) => MemoryInvoiceMirrorRow;
}

export interface SubmitHarnessOptions {
  fake?: Partial<Omit<FakeFatooraOptions, 'env' | 'creds' | 'certToken'>>;
  environment?: FatooraEnv;
  live?: boolean;
  start?: Date;
  slots?: SubmitSlots;
  /** خطّاف Z5.4 (إبطال القياسية المرفوضة) داخل المعاملة نفسها. */
  onRejectedInTx?: SubmitDeps<unknown>['onRejectedInTx'];
  env?: NodeJS.ProcessEnv;
}

/** نسخة سطحية من صفوف المخزن (لتراجع المعاملة). */
function snapshot(h: MemoryZatcaDocumentStore): { docs: Map<string, MemoryDocumentRow>; invs: Map<string, MemoryInvoiceMirrorRow> } {
  const docs = new Map<string, MemoryDocumentRow>();
  for (const [k, v] of h.documents) docs.set(k, { ...v });
  const invs = new Map<string, MemoryInvoiceMirrorRow>();
  for (const [k, v] of h.invoices) invs.set(k, { ...v });
  return { docs, invs };
}

function restore(h: MemoryZatcaDocumentStore, s: { docs: Map<string, MemoryDocumentRow>; invs: Map<string, MemoryInvoiceMirrorRow> }): void {
  h.documents.clear();
  for (const [k, v] of s.docs) h.documents.set(k, v);
  h.invoices.clear();
  for (const [k, v] of s.invs) h.invoices.set(k, v);
}

export function createSubmitHarness(opts: SubmitHarnessOptions = {}): SubmitHarness {
  const keyring = createKeyring({ current: crypto.randomBytes(32) });
  const keys = newUnitKeys();
  const environment = opts.environment ?? 'production';
  const row: MemoryUnitRow = unitRow(keyring, keys, {
    environment,
    productionSecretEnc: encryptSecret(PCSID_SECRET, { purpose: 'pcsid-secret', ownerId: Z5_UNIT }, keyring),
  });
  const units = memoryEgsUnitStore({ settings: [sellerSettings()] });
  units.units.set(row.id, row);

  let t = (opts.start ?? SUBMIT_T0).getTime();
  const clock: HarnessClock = {
    now: () => new Date(t),
    set: (d: Date) => { t = d.getTime(); },
    advance: (ms: number) => { t += ms; },
  };

  const docs = memoryZatcaDocumentStore({ now: () => new Date(t) });
  docs.units.set(row.id, {
    id: row.id, tenantId: row.tenantId, status: row.status, environment: row.environment, keyVersion: row.keyVersion,
    vatNumber: row.vatNumber, lastIcv: 0, lastInvoiceHash: null, updatedAt: new Date(t),
  });

  const fake = fakeFatoora({
    env: environment, creds: { token: keys.token, secret: PCSID_SECRET }, certToken: keys.token, ...(opts.fake ?? {}),
  });

  const notifications: SubmitNotification[] = [];
  const published: string[] = [];
  const gates = new Map<string, TenantSubmitGate>([[Z5_TENANT, { live: opts.live !== false, pausedAt: null }]]);
  const queries = { claimBatch: 0, gate: 0, overdue: 0, total: 0 };
  const slots = opts.slots ?? new SubmitSlots({ total: 3 });
  let failTx: string | null = null;

  const chain: IssuanceChainStore<unknown> = {
    async lockChainHead(_tx, unitId) {
      const u = docs.units.get(unitId);
      if (!u) return null;
      const tail = [...docs.documents.values()].find(d => d.egsUnitId === unitId && d.icv === u.lastIcv);
      return {
        unit: {
          id: u.id, tenantId: u.tenantId, status: u.status, environment: u.environment, keyVersion: u.keyVersion,
          vatNumber: u.vatNumber, lastIcv: u.lastIcv, lastInvoiceHash: u.lastInvoiceHash,
        },
        tail: tail ? { icv: tail.icv, invoiceHash: tail.invoiceHash, issueDate: tail.issueDate, issueTime: tail.issueTime } : null,
      };
    },
  };

  const counted = {
    ...docs,
    async claimBatch(o: Parameters<MemoryZatcaDocumentStore['claimBatch']>[0]) {
      queries.claimBatch++; queries.total++;
      return docs.claimBatch(o);
    },
    async listOverdue(q: Parameters<MemoryZatcaDocumentStore['listOverdue']>[0]) {
      queries.overdue++; queries.total++;
      return docs.listOverdue(q);
    },
  } as unknown as SweepDeps<unknown>['documents'];

  const deps: SweepDeps<unknown> = {
    documents: counted,
    units,
    gate: {
      async loadSubmitGate(tenantId: string) {
        queries.gate++; queries.total++;
        return gates.get(tenantId) ?? null;
      },
    },
    keyring: () => keyring,
    client: ({ env, log, timeoutMs }: { env: FatooraEnv; log: (e: ApiLogEntry) => Promise<void>; timeoutMs: number }) =>
      new FatooraClient({ env, log, submissionTimeoutMs: timeoutMs, fetch: fake.fetch, logTimeoutMs: 2000 }),
    transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const snap = snapshot(docs);
      try {
        const out = await fn({ tx: true });
        if (failTx) {
          const why = failTx;
          failTx = null;
          restore(docs, snap);
          throw new Error(`TX_CRASH:${why}`);
        }
        return out;
      } catch (e) {
        restore(docs, snap);
        throw e;
      }
    },
    publish: (tenantId: string) => { published.push(tenantId); },
    authMemory: new AuthFailureMemory(),
    pauses: new UnitPauseMemory(),
    notify: (n: SubmitNotification) => { notifications.push(n); },
    ...(opts.onRejectedInTx ? { onRejectedInTx: opts.onRejectedInTx } : {}),
    slots,
    now: () => new Date(t),
    env: opts.env ?? ({} as NodeJS.ProcessEnv),
  };

  const signing = async (): Promise<IssuanceSigning> => openIssuanceSigning(
    { store: units, keyring, now: new Date(t) },
    { id: row.id, tenantId: row.tenantId, keyVersion: docs.units.get(row.id)!.keyVersion, vatNumber: row.vatNumber },
  );

  const h: SubmitHarness = {
    tenantId: Z5_TENANT,
    unitId: row.id,
    keyring, keys, units, docs, fake, deps, slots, clock, notifications, published, gates, queries,
    failNextTransaction: (why = 'injected') => { failTx = why; },
    chain,
    signing,

    async issue(o = {}) {
      const request = o.request ?? (o.standard ? REQ_STANDARD_NOW : REQ_SIMPLIFIED_Z1);
      const customer = o.customer ?? (o.standard ? CUSTOMERS.b2bComplete : CUSTOMERS.individual);
      const at = o.at ?? new Date(t);
      const prepared: PreparedIssuance = prepareIssuance({
        settings: sellerSettings(), customer, products: PRODUCTS, request, companyVat: COMPANY_VAT, engine: engineOf(request), now: at,
      });
      const sign = await signing();
      let invoiceId = '';
      const result = await stampInTx<unknown>({ tx: true }, { chain, documents: docs, now: () => new Date(t) }, {
        tenantId: Z5_TENANT, prepared, signing: sign, sellerVat: Z5_VAT,
        hooks: {
          async allocateNumber(_tx, issuedAt) { return `${phase2NumberPrefix('INV', issuedAt)}${docs.documents.size + 1}`; },
          async createInvoice(_tx, record) {
            invoiceId = crypto.randomUUID();
            docs.invoices.set(invoiceId, {
              id: invoiceId, tenantId: record.tenantId, zatcaPhase: 2, einvoiceStatus: record.mirror.einvoiceStatus,
              einvoiceQr: record.mirror.einvoiceQr, einvoiceWarnings: null, einvoiceSubmittedAt: null,
            });
            return { id: invoiceId };
          },
        },
      });
      return {
        documentId: result.documentId, invoiceId, icv: result.icv, uuid: result.uuid, qr: result.qr,
        invoiceHash: result.invoiceHash, typeName: result.typeName, result,
      };
    },

    setUnitStatus(status: string) {
      const u = units.units.get(row.id);
      if (u) u.status = status;
      const c = docs.units.get(row.id);
      if (c) c.status = status;
    },

    setKeyVersion(v: number) {
      const u = units.units.get(row.id);
      if (u) u.keyVersion = v;
      const c = docs.units.get(row.id);
      if (c) c.keyVersion = v;
    },

    doc(id: string) {
      const d = docs.documents.get(id);
      if (!d) throw new Error(`no document ${id}`);
      return d;
    },

    invoice(id: string) {
      const i = docs.invoices.get(id);
      if (!i) throw new Error(`no invoice ${id}`);
      return i;
    },
  };
  return h;
}
