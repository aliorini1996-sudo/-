// ============================================================================
// ZATCA المرحلة الثانية (Z5.0) — مخزن المستندات الموقَّعة: الواجهة ومخزن الذاكرة وضغط البايتات
// ----------------------------------------------------------------------------
// z5_plan §2.2–§2.3 + §3 Z5.0 + نقد الخطة (7، 9، 16، 34):
//   • البايتات المُرسلة تُحفظ gzip بلا فقد (xmlGz) والمعتمدة من الهيئة (clearedXmlGz)؛ الإسقاط loadProjection لا يحملهما أبداً.
//   • كتابة النتيجة مسيَّجة برمز المطالبة (attempts) مع status='SUBMITTING' — عامل متأخر لا يكتب فوق نتيجة أحدث.
//   • كل عملية تشترك في معاملة الإصدار أو الإبطال تأخذ tx صراحةً (قفل الوحدة، الإدراج، تقدّم السلسلة، النتيجة، المرآة) —
//     فيُكتب الرفض وحالة الفاتورة والإبطال في معاملة واحدة (Z5.4).
//   • المطالبة الجماعية عادلة بين الوحدات (حدّ لكل وحدة بترتيب ICV)، الأقرب مهلةً أولاً، وتستبعد وحدات حالتها خارج
//     المسموح (افتراضياً ACTIVE وRENEWING: التجديد ينتظر تصريف الجاري).
//   • المرآة لا تمسّ إلا صفوف zatcaPhase = 2 (لا تغيّر فاتورة مرحلة أولى أبداً).
//   • keyVersion للمستند = نسخة مفتاح الوحدة التي وُقِّع بها (إعادة بعد تجديد تُكشف — نقد الخطة 9).
// المحوّل الحقيقي في documentStore.prisma.ts (يُفحص نوعياً ولا يُنفَّذ في الاختبارات). لا يستورد services/gl.
// ============================================================================

import crypto from 'crypto';
import zlib from 'zlib';
import { isClaimable, reportDeadlineFor, subtypeOfTypeName, type DocumentStatus, type Flow, type InvoiceMirrorStatus } from './status';

// ─── الضغط ───

/** أكبر XML يُفكّ (المختوم ≤ 4 MiB، والمعتمد من الهيئة قد يزيد قليلاً) — حارس قنبلة الضغط. */
export const MAX_DOCUMENT_XML_BYTES = 16 * 1024 * 1024;

export class DocumentBytesError extends Error {
  readonly code: 'GZIP_INVALID' | 'TOO_LARGE' | 'UTF8_INVALID' | 'INPUT';
  constructor(code: DocumentBytesError['code'], message: string) {
    super(`ZATCA_DOCUMENT_BYTES ${code}: ${message}`);
    this.name = 'DocumentBytesError';
    this.code = code;
  }
}

/** البايتات UTF-8 للنصّ كما هو، مضغوطة gzip (بلا تطبيع ولا BOM). */
export function gzipXml(xml: string): Buffer {
  if (typeof xml !== 'string' || xml === '') throw new DocumentBytesError('INPUT', 'XML فارغ أو ليس نصاً');
  const bytes = Buffer.from(xml, 'utf8');
  if (bytes.length > MAX_DOCUMENT_XML_BYTES) throw new DocumentBytesError('TOO_LARGE', `${bytes.length} بايت`);
  return zlib.gzipSync(bytes);
}

/** يفكّ gzip بحدّ أقصى للناتج ويرفض UTF-8 غير صالح (لا استبدال صامت يغيّر البايتات الموقَّعة). */
export function gunzipXml(gz: Uint8Array, maxBytes: number = MAX_DOCUMENT_XML_BYTES): string {
  if (!(gz instanceof Uint8Array) || gz.length === 0) throw new DocumentBytesError('INPUT', 'بايتات فارغة');
  let out: Buffer;
  try {
    out = zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') throw new DocumentBytesError('TOO_LARGE', `أكبر من ${maxBytes} بايت`);
    throw new DocumentBytesError('GZIP_INVALID', 'ليست gzip صالحة');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(out);
  } catch {
    throw new DocumentBytesError('UTF8_INVALID', 'UTF-8 غير صالح');
  }
}

// ─── الأنواع ───

export type DocumentTypeCode = '388' | '381' | '383';

/** المستند الموقَّع كما يُدرج داخل معاملة الإصدار (الحالة SIGNED دائماً). */
export interface SignedDocumentInput {
  tenantId: string;
  egsUnitId: string;
  invoiceId: string;
  attemptNo: number;
  icv: number;
  uuid: string;
  pih: string;
  invoiceHash: string;
  typeCode: DocumentTypeCode;
  typeName: string;
  issueDate: string;
  issueTime: string;
  /** البايتات المختومة كما ستُرسل (تُضغط هنا). */
  xml: string;
  qr: string;
  /** لحظة الإصدار (الخادم) — منها مهلة الإبلاغ للمبسّطة. */
  issuedAt: Date;
  keyVersion: number;
}

export interface InsertedDocument {
  id: string;
  flow: Flow;
  reportDeadline: Date | null;
}

/** صفّ الوحدة تحت القفل (SELECT … FOR UPDATE) — أعمدة السلسلة والحالة فقط. */
export interface LockedUnitRow {
  id: string;
  tenantId: string;
  status: string;
  environment: string;
  keyVersion: number;
  vatNumber: string;
  lastIcv: number;
  lastInvoiceHash: string | null;
}

export interface ChainAdvance {
  unitId: string;
  /** ICV المستند الجديد (= lastIcv + 1 تحت القفل). */
  icv: number;
  invoiceHash: string;
  at: Date;
}

export interface ClaimOptions {
  leaseMs: number;
  /** محاولة فورية واحدة (إعادة يدوية أو إعادة إرسال الطلب) تتجاهل موعد nextAttemptAt — لا عقداً حيّاً. */
  ignoreSchedule?: boolean;
}

export interface ClaimBatchOptions {
  limit: number;
  /** حدّ المستندات لكل وحدة في الدفعة (بترتيب ICV). */
  perUnit: number;
  leaseMs: number;
  /** حالات الوحدة المسموح إرسال مستنداتها. الافتراضي ACTIVE وRENEWING. */
  unitStatuses?: readonly string[];
}

export const DEFAULT_SUBMIT_UNIT_STATUSES: readonly string[] = Object.freeze(['ACTIVE', 'RENEWING']);
/** سقف الفحص قبل الترتيب العادل (يحدّ الصفوف المقفلة في الاستعلام الواحد). */
export const CLAIM_SCAN_FACTOR = 10;
export const CLAIM_SCAN_MAX = 500;

export interface ClaimedDocument {
  id: string;
  tenantId: string;
  egsUnitId: string;
  invoiceId: string;
  attemptNo: number;
  icv: number;
  uuid: string;
  invoiceHash: string;
  typeName: string;
  flow: Flow;
  /** رمز المطالبة: كل كتابة نتيجة مشروطة به. */
  attempts: number;
  leaseUntil: Date;
  priorEmpty400: number;
  priorPayload413: number;
  reportDeadline: Date | null;
  keyVersion: number | null;
  createdAt: Date;
}

export interface OutcomeFence {
  id: string;
  attempts: number;
}

/** ما تكتبه نتيجة الإرسال (status.ts transitionForOutcome + ما التقطه المستدعي من سجل الطلب). */
export interface DocumentOutcomePatch {
  status: DocumentStatus;
  flow?: Flow;
  nextAttemptAt: Date | null;
  finalizedAt?: Date;
  reportDeadline?: Date;
  priorEmpty400?: number;
  priorPayload413?: number;
  httpStatus?: number | null;
  /** validationResults منقّحة (كائن JSON). undefined = بلا تغيير. */
  validation?: Record<string, unknown>;
  clearedXmlGz?: Buffer;
  clearedQr?: string;
}

export interface InvoiceMirror {
  einvoiceStatus: InvoiceMirrorStatus;
  einvoiceQr: string | null;
  /** تحذيرات الهيئة JSON نصاً (العمود نصّي). */
  einvoiceWarnings: string | null;
  einvoiceSubmittedAt?: Date;
}

/** صفّ ZatcaApiLog بمعرّف المستند (onboardingStore.writeApiLog يكتبه null دائماً). */
export interface DocumentApiLogRow {
  tenantId: string;
  egsUnitId: string | null;
  documentId: string;
  actorId: string | null;
  endpoint: string;
  httpStatus: number | null;
  outcome: string;
  durationMs: number | null;
  response: Record<string, unknown> | null;
  errorText: string | null;
  at: Date;
}

/** ما تعرضه الواجهات عن مستند الفاتورة (آخر محاولة) — بلا أي بايتات XML. */
export interface DocumentProjection {
  id: string;
  egsUnitId: string;
  environment: string;
  attemptNo: number;
  icv: number;
  uuid: string;
  pih: string;
  invoiceHash: string;
  typeCode: string;
  typeName: string;
  issueDate: string;
  issueTime: string;
  flow: string;
  qr: string;
  clearedQr: string | null;
  status: string;
  httpStatus: number | null;
  validation: unknown;
  attempts: number;
  nextAttemptAt: Date | null;
  firstSubmitAt: Date | null;
  finalizedAt: Date | null;
  reportDeadline: Date | null;
  keyVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PROJECTION_KEYS: readonly (keyof DocumentProjection)[] = Object.freeze([
  'id', 'egsUnitId', 'environment', 'attemptNo', 'icv', 'uuid', 'pih', 'invoiceHash', 'typeCode', 'typeName', 'issueDate', 'issueTime',
  'flow', 'qr', 'clearedQr', 'status', 'httpStatus', 'validation', 'attempts', 'nextAttemptAt', 'firstSubmitAt', 'finalizedAt',
  'reportDeadline', 'keyVersion', 'createdAt', 'updatedAt',
] as (keyof DocumentProjection)[]);

/**
 * Tx = مقبض معاملة المحوّل (Prisma.TransactionClient)؛ null حيث يُسمح بالكتابة خارج معاملة. مخزن الذاكرة يتجاهله.
 */
export interface ZatcaDocumentStore<Tx = unknown> {
  /** SELECT … FOR UPDATE على صفّ الوحدة (أول قفل في معاملة الإصدار). null = غير موجودة. */
  lockUnitForIssuance(tx: Tx, unitId: string): Promise<LockedUnitRow | null>;
  /** CAS تحت القفل: lastIcv = icv−1 والحالة ACTIVE ⇒ lastIcv/lastInvoiceHash/updatedAt؛ يعيد هل طُبِّق (صفّ واحد). */
  advanceUnitChain(tx: Tx, a: ChainAdvance): Promise<boolean>;
  insertSigned(tx: Tx, doc: SignedDocumentInput): Promise<InsertedDocument>;
  claim(id: string, opts: ClaimOptions): Promise<ClaimedDocument | null>;
  claimBatch(opts: ClaimBatchOptions): Promise<ClaimedDocument[]>;
  applyOutcome(tx: Tx | null, fence: OutcomeFence, patch: DocumentOutcomePatch): Promise<boolean>;
  mirrorInvoice(tx: Tx | null, invoiceId: string, mirror: InvoiceMirror): Promise<boolean>;
  writeApiLog(row: DocumentApiLogRow): Promise<void>;
  loadProjection(tenantId: string, invoiceId: string): Promise<DocumentProjection | null>;
  /** البايتات (للإرسال وتنزيل XML) — القراءة الوحيدة التي تلمس xmlGz/clearedXmlGz. */
  loadDocumentXml(id: string): Promise<{ xml: string; clearedXml: string | null } | null>;
}

/** فحص مدخل الإدراج (مشترك بين المحوّلين): النوع يطابق التدفّق، والقيم الأساسية سليمة. */
export function validateSignedInput(doc: SignedDocumentInput): { flow: Flow; reportDeadline: Date | null } {
  const subtype = subtypeOfTypeName(doc.typeName);
  if (!subtype) throw new DocumentBytesError('INPUT', 'typeName غير صالح');
  if (!['388', '381', '383'].includes(doc.typeCode)) throw new DocumentBytesError('INPUT', 'typeCode غير صالح');
  if (!Number.isInteger(doc.icv) || doc.icv < 1) throw new DocumentBytesError('INPUT', 'icv غير صالح');
  if (!Number.isInteger(doc.attemptNo) || doc.attemptNo < 1) throw new DocumentBytesError('INPUT', 'attemptNo غير صالح');
  if (!Number.isInteger(doc.keyVersion) || doc.keyVersion < 1) throw new DocumentBytesError('INPUT', 'keyVersion غير صالح');
  if (!(doc.issuedAt instanceof Date) || !Number.isFinite(doc.issuedAt.getTime())) throw new DocumentBytesError('INPUT', 'issuedAt غير صالح');
  for (const k of ['tenantId', 'egsUnitId', 'invoiceId', 'uuid', 'pih', 'invoiceHash', 'issueDate', 'issueTime', 'qr'] as const) {
    if (typeof doc[k] !== 'string' || doc[k] === '') throw new DocumentBytesError('INPUT', `${k} مفقود`);
  }
  const flow: Flow = subtype === '01' ? 'CLEARANCE' : 'REPORTING';
  return { flow, reportDeadline: reportDeadlineFor(flow, doc.issuedAt) };
}

// ─── مخزن الذاكرة (للاختبارات) ───

export interface MemoryDocumentRow {
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
  clearedXmlGz: Buffer | null;
  clearedQr: string | null;
  status: DocumentStatus;
  httpStatus: number | null;
  validation: unknown;
  attempts: number;
  priorEmpty400: number;
  priorPayload413: number;
  nextAttemptAt: Date | null;
  leaseUntil: Date | null;
  firstSubmitAt: Date | null;
  finalizedAt: Date | null;
  reportDeadline: Date | null;
  keyVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryUnitChainRow {
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

export interface MemoryInvoiceMirrorRow {
  id: string;
  tenantId: string;
  zatcaPhase: number | null;
  einvoiceStatus: string | null;
  einvoiceQr: string | null;
  einvoiceWarnings: string | null;
  einvoiceSubmittedAt: Date | null;
}

export interface MemoryZatcaDocumentStore extends ZatcaDocumentStore<unknown> {
  readonly documents: Map<string, MemoryDocumentRow>;
  readonly units: Map<string, MemoryUnitChainRow>;
  readonly invoices: Map<string, MemoryInvoiceMirrorRow>;
  readonly apiLogs: DocumentApiLogRow[];
  /** ساعة المخزن (بديل NOW() في المحوّل). */
  now: () => Date;
}

/** خطأ بشكل Prisma P2002 (المفاتيح الفريدة لجدول zatca_documents). */
function uniqueViolation(target: string[]): Error {
  return Object.assign(new Error(`Unique constraint failed on the fields: (${target.join(',')})`), {
    code: 'P2002', meta: { modelName: 'ZatcaDocument', target },
  });
}

function toClaimed(r: MemoryDocumentRow): ClaimedDocument {
  return {
    id: r.id, tenantId: r.tenantId, egsUnitId: r.egsUnitId, invoiceId: r.invoiceId, attemptNo: r.attemptNo, icv: r.icv, uuid: r.uuid,
    invoiceHash: r.invoiceHash, typeName: r.typeName, flow: r.flow, attempts: r.attempts, leaseUntil: new Date((r.leaseUntil as Date).getTime()),
    priorEmpty400: r.priorEmpty400, priorPayload413: r.priorPayload413, reportDeadline: r.reportDeadline ? new Date(r.reportDeadline.getTime()) : null,
    keyVersion: r.keyVersion, createdAt: new Date(r.createdAt.getTime()),
  };
}

const copyDate = (d: Date | null): Date | null => (d ? new Date(d.getTime()) : null);

export function memoryZatcaDocumentStore(opts: { now?: () => Date } = {}): MemoryZatcaDocumentStore {
  const documents = new Map<string, MemoryDocumentRow>();
  const units = new Map<string, MemoryUnitChainRow>();
  const invoices = new Map<string, MemoryInvoiceMirrorRow>();
  const apiLogs: DocumentApiLogRow[] = [];

  const claimRow = (r: MemoryDocumentRow, now: Date, leaseMs: number): ClaimedDocument => {
    r.status = 'SUBMITTING';
    r.leaseUntil = new Date(now.getTime() + leaseMs);
    r.attempts += 1;
    r.firstSubmitAt = r.firstSubmitAt ?? new Date(now.getTime());
    r.updatedAt = new Date(now.getTime());
    return toClaimed(r);
  };

  const store: MemoryZatcaDocumentStore = {
    documents, units, invoices, apiLogs,
    now: opts.now ?? (() => new Date()),

    async lockUnitForIssuance(_tx, unitId) {
      const u = units.get(unitId);
      return u ? { id: u.id, tenantId: u.tenantId, status: u.status, environment: u.environment, keyVersion: u.keyVersion, vatNumber: u.vatNumber, lastIcv: u.lastIcv, lastInvoiceHash: u.lastInvoiceHash } : null;
    },

    async advanceUnitChain(_tx, a) {
      const u = units.get(a.unitId);
      if (!u || u.status !== 'ACTIVE' || u.lastIcv !== a.icv - 1) return false;
      u.lastIcv = a.icv;
      u.lastInvoiceHash = a.invoiceHash;
      u.updatedAt = new Date(a.at.getTime());
      return true;
    },

    async insertSigned(_tx, doc) {
      const { flow, reportDeadline } = validateSignedInput(doc);
      const xmlGz = gzipXml(doc.xml);
      for (const r of documents.values()) {
        if (r.egsUnitId === doc.egsUnitId && r.icv === doc.icv) throw uniqueViolation(['egsUnitId', 'icv']);
        if (r.uuid === doc.uuid) throw uniqueViolation(['uuid']);
        if (r.invoiceId === doc.invoiceId && r.attemptNo === doc.attemptNo) throw uniqueViolation(['invoiceId', 'attemptNo']);
      }
      const now = store.now();
      const id = crypto.randomUUID();
      documents.set(id, {
        id, tenantId: doc.tenantId, egsUnitId: doc.egsUnitId, invoiceId: doc.invoiceId, attemptNo: doc.attemptNo, icv: doc.icv, uuid: doc.uuid,
        pih: doc.pih, invoiceHash: doc.invoiceHash, typeCode: doc.typeCode, typeName: doc.typeName, issueDate: doc.issueDate,
        issueTime: doc.issueTime, flow, xmlGz, qr: doc.qr, clearedXmlGz: null, clearedQr: null, status: 'SIGNED', httpStatus: null,
        validation: null, attempts: 0, priorEmpty400: 0, priorPayload413: 0, nextAttemptAt: null, leaseUntil: null, firstSubmitAt: null,
        finalizedAt: null, reportDeadline, keyVersion: doc.keyVersion, createdAt: new Date(now.getTime()), updatedAt: new Date(now.getTime()),
      });
      return { id, flow, reportDeadline: copyDate(reportDeadline) };
    },

    async claim(id, o) {
      const now = store.now();
      const r = documents.get(id);
      if (!r || !isClaimable(r, now, { ignoreSchedule: o.ignoreSchedule === true })) return null;
      return claimRow(r, now, o.leaseMs);
    },

    async claimBatch(o) {
      const now = store.now();
      const allowed = o.unitStatuses ?? DEFAULT_SUBMIT_UNIT_STATUSES;
      const limit = Math.max(0, Math.trunc(o.limit));
      const perUnit = Math.max(0, Math.trunc(o.perUnit));
      if (limit === 0 || perUnit === 0) return [];
      const candidates = [...documents.values()]
        .filter(r => isClaimable(r, now) && allowed.includes(units.get(r.egsUnitId)?.status ?? ''));
      const byUnit = new Map<string, MemoryDocumentRow[]>();
      for (const r of candidates) byUnit.set(r.egsUnitId, [...(byUnit.get(r.egsUnitId) ?? []), r]);
      const fair: MemoryDocumentRow[] = [];
      for (const list of byUnit.values()) fair.push(...list.sort((a, b) => a.icv - b.icv).slice(0, perUnit));
      fair.sort((a, b) => {
        const da = a.reportDeadline?.getTime() ?? Number.POSITIVE_INFINITY;
        const db = b.reportDeadline?.getTime() ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
        if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt.getTime() - b.createdAt.getTime();
        if (a.egsUnitId !== b.egsUnitId) return a.egsUnitId < b.egsUnitId ? -1 : 1;
        return a.icv - b.icv;
      });
      return fair.slice(0, limit).map(r => claimRow(r, now, o.leaseMs));
    },

    async applyOutcome(_tx, fence, patch) {
      const r = documents.get(fence.id);
      if (!r || r.status !== 'SUBMITTING' || r.attempts !== fence.attempts) return false;
      r.status = patch.status;
      if (patch.flow !== undefined) r.flow = patch.flow;
      r.nextAttemptAt = copyDate(patch.nextAttemptAt);
      r.leaseUntil = null;
      if (patch.finalizedAt !== undefined) r.finalizedAt = copyDate(patch.finalizedAt);
      if (patch.reportDeadline !== undefined) r.reportDeadline = copyDate(patch.reportDeadline);
      if (patch.priorEmpty400 !== undefined) r.priorEmpty400 = patch.priorEmpty400;
      if (patch.priorPayload413 !== undefined) r.priorPayload413 = patch.priorPayload413;
      if (patch.httpStatus !== undefined) r.httpStatus = patch.httpStatus;
      if (patch.validation !== undefined) r.validation = JSON.parse(JSON.stringify(patch.validation));
      if (patch.clearedXmlGz !== undefined) r.clearedXmlGz = Buffer.from(patch.clearedXmlGz);
      if (patch.clearedQr !== undefined) r.clearedQr = patch.clearedQr;
      r.updatedAt = store.now();
      return true;
    },

    async mirrorInvoice(_tx, invoiceId, mirror) {
      const inv = invoices.get(invoiceId);
      if (!inv || inv.zatcaPhase !== 2) return false;
      inv.einvoiceStatus = mirror.einvoiceStatus;
      inv.einvoiceQr = mirror.einvoiceQr;
      inv.einvoiceWarnings = mirror.einvoiceWarnings;
      if (mirror.einvoiceSubmittedAt !== undefined) inv.einvoiceSubmittedAt = copyDate(mirror.einvoiceSubmittedAt);
      return true;
    },

    async writeApiLog(row) {
      apiLogs.push({ ...row, response: row.response === null ? null : (JSON.parse(JSON.stringify(row.response)) as Record<string, unknown>), at: new Date(row.at.getTime()) });
    },

    async loadProjection(tenantId, invoiceId) {
      const rows = [...documents.values()].filter(r => r.tenantId === tenantId && r.invoiceId === invoiceId).sort((a, b) => b.attemptNo - a.attemptNo);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, egsUnitId: r.egsUnitId, environment: units.get(r.egsUnitId)?.environment ?? '', attemptNo: r.attemptNo, icv: r.icv, uuid: r.uuid,
        pih: r.pih, invoiceHash: r.invoiceHash, typeCode: r.typeCode, typeName: r.typeName, issueDate: r.issueDate, issueTime: r.issueTime,
        flow: r.flow, qr: r.qr, clearedQr: r.clearedQr, status: r.status, httpStatus: r.httpStatus,
        validation: r.validation === null ? null : JSON.parse(JSON.stringify(r.validation)), attempts: r.attempts,
        nextAttemptAt: copyDate(r.nextAttemptAt), firstSubmitAt: copyDate(r.firstSubmitAt), finalizedAt: copyDate(r.finalizedAt),
        reportDeadline: copyDate(r.reportDeadline), keyVersion: r.keyVersion, createdAt: new Date(r.createdAt.getTime()), updatedAt: new Date(r.updatedAt.getTime()),
      };
    },

    async loadDocumentXml(id) {
      const r = documents.get(id);
      if (!r) return null;
      return { xml: gunzipXml(r.xmlGz), clearedXml: r.clearedXmlGz ? gunzipXml(r.clearedXmlGz) : null };
    },
  };
  return store;
}
