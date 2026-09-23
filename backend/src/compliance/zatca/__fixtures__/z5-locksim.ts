// محاكي معاملات Z5.2 في الذاكرة (z5_plan §2.6): قفل صفّ الوحدة (FOR UPDATE) بطابور FIFO يُحرَّر عند الالتزام أو الإلغاء أو انتهاء
// المهلة، وكتابات مرحلية (staged) تُطبَّق عند الالتزام وحده وتُهمل عند أي رمي، وقيود فريدة بشكل Prisma P2002، ومهلة معاملة بشكل
// P2028 (المقبض يُغلق فتفشل كل عملية بعدها)، وحقن أعطال قبل الالتزام. يطبّق IssuanceChainStore وجزء المعاملة من ZatcaDocumentStore
// (insertSigned، advanceUnitChain) بدلالات المحوّل، وجداول الفواتير والقيود والترقيم داخل المعاملة.
// لا يُثبت سلوك مجمّع اتصالات Postgres الحقيقي (نقد الخطة 8): اختبار Postgres الحقيقي مطلوب قبل التفعيل.
import crypto from 'crypto';
import { gzipXml, validateSignedInput, type InsertedDocument, type SignedDocumentInput, type ZatcaDocumentStore } from '../documentStore';
import type { ChainHead, ChainTail, IssuanceChainStore } from '../issueChain';
import type { DocumentStatus, Flow } from '../status';

export interface SimUnit {
  id: string;
  tenantId: string;
  status: string;
  environment: string;
  keyVersion: number;
  vatNumber: string;
  lastIcv: number;
  lastInvoiceHash: string | null;
  updatedAt: Date;
}

export interface SimDocument {
  id: string;
  tenantId: string;
  egsUnitId: string;
  invoiceId: string;
  attemptNo: number;
  icv: number;
  uuid: string;
  pih: string;
  invoiceHash: string;
  typeCode: string;
  typeName: string;
  issueDate: string;
  issueTime: string;
  flow: Flow;
  xmlGz: Buffer;
  qr: string;
  status: DocumentStatus;
  reportDeadline: Date | null;
  keyVersion: number;
  createdAt: Date;
  /** رقم المعاملة التي أدرجته (للتتبّع). */
  txId: number;
}

export interface SimInvoice {
  id: string;
  tenantId: string;
  number: string;
  clientRef: string | null;
  data: Record<string, unknown>;
  txId: number;
}

export interface SimLedgerEntry {
  tenantId: string;
  invoiceId: string;
  amount: number;
  txId: number;
}

export interface SimTx {
  readonly id: number;
}

interface TxState extends SimTx {
  closed: 'open' | 'committed' | 'rolledback' | 'timeout';
  unitLocks: Set<string>;
  invoices: SimInvoice[];
  documents: SimDocument[];
  unitUpdates: Map<string, Partial<SimUnit>>;
  ledger: SimLedgerEntry[];
  /** يُستدعى عند إغلاق المعاملة (لإيقاظ منتظر قفل تنتهي مهلة معاملته). */
  onClose: Array<() => void>;
}

function p2002(modelName: string, target: string[]): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target.join(',')})`), { code: 'P2002', meta: { modelName, target } });
}

function p2028(): Error {
  return Object.assign(new Error('Transaction API error: Transaction already closed: the transaction was rolled back (timeout).'), {
    code: 'P2028', meta: { error: 'Transaction already closed' },
  });
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

export interface LockSimOptions {
  units: SimUnit[];
  now?: () => Date;
  /** يُنتظر بعد كل عملية (تداخل الطلبات). الافتراضي setImmediate واحد. */
  opDelay?: () => Promise<void>;
}

export interface LockSimStats {
  openTx: number;
  maxOpenTx: number;
  commits: number;
  rollbacks: number;
  timeouts: number;
  maxLockWaiters: number;
  /** معاملات فتحت (أو تنتظر) بينما قفل الوحدة محجوز لغيرها — «اتصالات» منتظرة على FOR UPDATE. */
  maxBlockedOnLock: number;
}

export function createLockSim(opts: LockSimOptions) {
  const units = new Map<string, SimUnit>(opts.units.map(u => [u.id, { ...u, updatedAt: new Date(u.updatedAt.getTime()) }]));
  const documents = new Map<string, SimDocument>();
  const invoices = new Map<string, SimInvoice>();
  const ledger: SimLedgerEntry[] = [];
  const now = opts.now ?? (() => new Date());
  const delay = opts.opDelay ?? tick;
  const stats: LockSimStats = { openTx: 0, maxOpenTx: 0, commits: 0, rollbacks: 0, timeouts: 0, maxLockWaiters: 0, maxBlockedOnLock: 0 };
  const inject: { beforeCommit?: (tx: SimTx) => void | Promise<void> } = {};
  let txSeq = 0;
  let blocked = 0;

  // ─── قفل الصفّ ───
  const holders = new Map<string, TxState>();
  const waiters = new Map<string, Array<{ tx: TxState; resolve: () => void; reject: (e: unknown) => void }>>();

  function releaseLocks(tx: TxState): void {
    for (const unitId of tx.unitLocks) {
      if (holders.get(unitId) !== tx) continue;
      holders.delete(unitId);
      const q = waiters.get(unitId) ?? [];
      while (q.length) {
        const w = q.shift()!;
        if (w.tx.closed !== 'open') continue;
        holders.set(unitId, w.tx);
        w.tx.unitLocks.add(unitId);
        w.resolve();
        break;
      }
      if (!q.length) waiters.delete(unitId);
    }
    tx.unitLocks.clear();
  }

  async function lockRow(tx: TxState, unitId: string): Promise<void> {
    ensureOpen(tx);
    const h = holders.get(unitId);
    if (!h) {
      holders.set(unitId, tx);
      tx.unitLocks.add(unitId);
      return;
    }
    if (h === tx) return;
    const q = waiters.get(unitId) ?? [];
    waiters.set(unitId, q);
    blocked++;
    stats.maxBlockedOnLock = Math.max(stats.maxBlockedOnLock, blocked);
    try {
      await new Promise<void>((resolve, reject) => {
        q.push({ tx, resolve, reject });
        stats.maxLockWaiters = Math.max(stats.maxLockWaiters, q.length);
        tx.onClose.push(() => {
          const i = q.findIndex(w => w.tx === tx);
          if (i >= 0) { q.splice(i, 1); reject(p2028()); }
        });
      });
    } finally {
      blocked--;
    }
    ensureOpen(tx);
  }

  function ensureOpen(tx: TxState): void {
    if (tx.closed !== 'open') throw p2028();
  }

  async function op(tx: SimTx): Promise<TxState> {
    const t = tx as TxState;
    ensureOpen(t);
    await delay();
    ensureOpen(t);
    return t;
  }

  // ─── المشاهدة (READ COMMITTED + كتابات المعاملة نفسها) ───
  function unitView(tx: TxState, unitId: string): SimUnit | null {
    const u = units.get(unitId);
    if (!u) return null;
    return { ...u, ...(tx.unitUpdates.get(unitId) ?? {}) };
  }

  function checkDocumentUniques(doc: SimDocument, pool: Iterable<SimDocument>): void {
    for (const r of pool) {
      if (r === doc) continue;
      if (r.egsUnitId === doc.egsUnitId && r.icv === doc.icv) throw p2002('ZatcaDocument', ['egsUnitId', 'icv']);
      if (r.uuid === doc.uuid) throw p2002('ZatcaDocument', ['uuid']);
      if (r.invoiceId === doc.invoiceId && r.attemptNo === doc.attemptNo) throw p2002('ZatcaDocument', ['invoiceId', 'attemptNo']);
    }
  }

  function checkInvoiceUniques(inv: SimInvoice, pool: Iterable<SimInvoice>): void {
    for (const r of pool) {
      if (r === inv) continue;
      if (r.tenantId === inv.tenantId && r.number === inv.number) throw p2002('Invoice', ['tenantId', 'number']);
      if (inv.clientRef !== null && r.tenantId === inv.tenantId && r.clientRef === inv.clientRef) throw p2002('Invoice', ['tenantId', 'clientRef']);
    }
  }

  function commit(tx: TxState): void {
    // إعادة فحص القيود مقابل الملتزَم (معاملة أخرى التزمت القيمة نفسها أثناءنا ⇒ P2002 عند الالتزام كما في Postgres)
    for (const inv of tx.invoices) checkInvoiceUniques(inv, invoices.values());
    for (const d of tx.documents) checkDocumentUniques(d, documents.values());
    for (const inv of tx.invoices) invoices.set(inv.id, inv);
    for (const d of tx.documents) documents.set(d.id, d);
    for (const [id, patch] of tx.unitUpdates) {
      const u = units.get(id);
      if (u) Object.assign(u, patch);
    }
    ledger.push(...tx.ledger);
  }

  function close(tx: TxState, how: TxState['closed']): void {
    if (tx.closed !== 'open') return;
    tx.closed = how;
    stats.openTx--;
    releaseLocks(tx);
    for (const f of tx.onClose.splice(0)) f();
  }

  async function transaction<T>(fn: (tx: SimTx) => Promise<T>, o: { timeoutMs?: number } = {}): Promise<T> {
    const tx: TxState = {
      id: ++txSeq, closed: 'open', unitLocks: new Set(), invoices: [], documents: [], unitUpdates: new Map(), ledger: [], onClose: [],
    };
    stats.openTx++;
    stats.maxOpenTx = Math.max(stats.maxOpenTx, stats.openTx);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      if (o.timeoutMs === undefined) return;
      timer = setTimeout(() => {
        if (tx.closed !== 'open') return;
        stats.timeouts++;
        close(tx, 'timeout');
        reject(p2028());
      }, o.timeoutMs);
    });
    const run = (async () => {
      const out = await fn(tx);
      ensureOpen(tx);
      if (inject.beforeCommit) await inject.beforeCommit(tx);
      ensureOpen(tx);
      commit(tx);
      stats.commits++;
      close(tx, 'committed');
      return out;
    })();
    try {
      return await Promise.race([run, timeout]);
    } catch (e) {
      if (tx.closed === 'open') {
        stats.rollbacks++;
        close(tx, 'rolledback');
      }
      run.catch(() => undefined);
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const chain: IssuanceChainStore<SimTx> = {
    async lockChainHead(tx, unitId): Promise<ChainHead | null> {
      const t = await op(tx);
      if (!units.has(unitId)) return null;
      await lockRow(t, unitId);
      await delay();
      ensureOpen(t);
      const u = unitView(t, unitId)!;
      const unit = { id: u.id, tenantId: u.tenantId, status: u.status, environment: u.environment, keyVersion: u.keyVersion, vatNumber: u.vatNumber, lastIcv: u.lastIcv, lastInvoiceHash: u.lastInvoiceHash };
      if (!(u.lastIcv > 0)) return { unit, tail: null };
      // جملة ثانية بلقطة جديدة: الملتزَم + كتابات المعاملة
      const d = [...documents.values(), ...t.documents].find(x => x.egsUnitId === unitId && x.icv === u.lastIcv);
      const tail: ChainTail | null = d ? { icv: d.icv, invoiceHash: d.invoiceHash, issueDate: d.issueDate, issueTime: d.issueTime } : null;
      return { unit, tail };
    },
  };

  const docs: Pick<ZatcaDocumentStore<SimTx>, 'insertSigned' | 'advanceUnitChain'> = {
    async insertSigned(tx, doc: SignedDocumentInput): Promise<InsertedDocument> {
      const t = await op(tx);
      const { flow, reportDeadline } = validateSignedInput(doc);
      const row: SimDocument = {
        id: crypto.randomUUID(), tenantId: doc.tenantId, egsUnitId: doc.egsUnitId, invoiceId: doc.invoiceId, attemptNo: doc.attemptNo, icv: doc.icv,
        uuid: doc.uuid, pih: doc.pih, invoiceHash: doc.invoiceHash, typeCode: doc.typeCode, typeName: doc.typeName, issueDate: doc.issueDate,
        issueTime: doc.issueTime, flow, xmlGz: gzipXml(doc.xml), qr: doc.qr, status: 'SIGNED', reportDeadline, keyVersion: doc.keyVersion,
        createdAt: now(), txId: t.id,
      };
      if (!units.has(doc.egsUnitId)) throw Object.assign(new Error('Foreign key constraint failed: egsUnitId'), { code: 'P2003' });
      if (![...invoices.values(), ...t.invoices].some(i => i.id === doc.invoiceId)) {
        throw Object.assign(new Error('Foreign key constraint failed: invoiceId'), { code: 'P2003' });
      }
      checkDocumentUniques(row, [...documents.values(), ...t.documents]);
      t.documents.push(row);
      return { id: row.id, flow, reportDeadline };
    },
    async advanceUnitChain(tx, a) {
      const t = await op(tx);
      const u = unitView(t, a.unitId);
      if (!u || u.status !== 'ACTIVE' || u.lastIcv !== a.icv - 1) return false;
      t.unitUpdates.set(a.unitId, { ...(t.unitUpdates.get(a.unitId) ?? {}), lastIcv: a.icv, lastInvoiceHash: a.invoiceHash, updatedAt: new Date(a.at.getTime()) });
      return true;
    },
  };

  async function createInvoice(tx: SimTx, row: { tenantId: string; number: string; clientRef?: string | null; data?: Record<string, unknown> }): Promise<{ id: string }> {
    const t = await op(tx);
    const inv: SimInvoice = { id: crypto.randomUUID(), tenantId: row.tenantId, number: row.number, clientRef: row.clientRef ?? null, data: row.data ?? {}, txId: t.id };
    checkInvoiceUniques(inv, [...invoices.values(), ...t.invoices]);
    t.invoices.push(inv);
    return { id: inv.id };
  }

  async function nextNumber(tx: SimTx, tenantId: string, prefix: string): Promise<string> {
    const t = await op(tx);
    const last = [...invoices.values(), ...t.invoices]
      .filter(i => i.tenantId === tenantId && i.number.startsWith(prefix))
      .map(i => i.number)
      .sort()
      .pop();
    const lastSeq = last ? parseInt(last.slice(prefix.length), 10) || 0 : 0;
    return prefix + String(lastSeq + 1).padStart(6, '0');
  }

  async function postLedger(tx: SimTx, entry: Omit<SimLedgerEntry, 'txId'>): Promise<void> {
    const t = await op(tx);
    t.ledger.push({ ...entry, txId: t.id });
  }

  /** كتابة ملتزَمة مباشرة (خارج أي معاملة) — لمحاكاة مسار آخر (مرحلة أولى) أو بيانات فاسدة. */
  function commitInvoiceDirect(row: { tenantId: string; number: string; clientRef?: string | null }): SimInvoice {
    const inv: SimInvoice = { id: crypto.randomUUID(), tenantId: row.tenantId, number: row.number, clientRef: row.clientRef ?? null, data: {}, txId: 0 };
    checkInvoiceUniques(inv, invoices.values());
    invoices.set(inv.id, inv);
    return inv;
  }

  return {
    units, documents, invoices, ledger, stats, inject, chain, documentStore: docs, transaction, createInvoice, nextNumber, postLedger, commitInvoiceDirect,
    isLocked: (unitId: string) => holders.has(unitId),
  };
}

export type LockSim = ReturnType<typeof createLockSim>;
