// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — تركيب الإصدار داخل المعاملة: قفل ⇒ رقم ⇒ لحظة ⇒ تحويل وفحص ⇒ ختم ⇒ فاتورة ⇒ مستند SIGNED ⇒ تقدّم
// ----------------------------------------------------------------------------
// z5_plan §2.2 «Transaction» + نقد الخطة (8، 19، 26، 34، 38):
//   1. lockChainHead (SELECT … FOR UPDATE على الوحدة — أول قفل) ⇒ nextChainSlot (ACTIVE، keyVersion، الرقم الضريبي، سلامة الذيل).
//   2. لحظة الإصدار بعد القفل ولا تسبق الذيل (نقد 19).
//   3. الرقم داخل القفل عبر hooks.allocateNumber(tx) — بمقبض المعاملة نفسه لا باتصال ثانٍ من المجمّع (نقد 8).
//   4. mapInvoiceToUbl بالقيم الحقيقية ⇒ الفحص المسبق وقاعدة تاريخ التوريد من جديد ⇒ مطابقة بصمة المبالغ مع التحضير.
//   5. serializeUnsigned ⇒ stampDocument (تحقّق ذاتي كامل؛ SigningTime = لحظة الإصدار).
//   6. hooks.createInvoice(tx) بأعمدة المرحلة الثانية والمرآة (einvoice* من الختم) — كتابة واحدة لصفّ الفاتورة.
//   7. documents.insertSigned (xmlGz، QR، ICV، PIH، التجزئة، النوع، keyVersion) ⇒ documents.advanceUnitChain (CAS) — فشله تعارض سلسلة.
//   8. hooks.afterDocument(tx) — قيود دفتر العميل **بعد** الختم وإدراج المستند (نقد 38: قفل صفوف العملاء آخراً ولا توقيع تحته).
//   أي رمي في أي خطوة يُلغي المعاملة كلها: لا ICV مستهلك ولا فاتورة ولا مستند. أخطاء Prisma (P2002/P2028) تمرّ خاماً كي تعمل
//   إعادة الترقيم؛ المستدعي يحوّل عبر issuanceHttpError.
//   runIssuance: القفل داخل العملية لكل وحدة (unitMutex) ثم المعاملة بإعادة عند تصادم رقم الفاتورة وحده — تعارض السلسلة لا يُعاد.
// لا شبكة ولا services/gl؛ لا يستدعي الهيئة (الإرسال Z5.3).
// ============================================================================

import { newInvoiceUuid } from './crypto';
import type { InsertedDocument, ZatcaDocumentStore } from './documentStore';
import { ZatcaHttpError } from './errors';
import {
  amountsFingerprintOf, classifyIssuanceUniqueViolation, mapAndCheck, signedInvoiceMirror, snapshotOf, type IssuedInvoiceRecord, type PreparedIssuance,
  type SignedInvoiceMirror,
} from './issue';
import { chainConflictError, issuedAtAfter, nextChainSlot, CLOCK_SKEW_TOLERANCE_MS, type IssuanceChainStore } from './issueChain';
import type { IssuanceSigning } from './issueSigner';
import type { ZatcaSnapshotV1 } from './mapInvoice';
import type { ZatcaIssue } from './model';
import { stampDocument } from './stamp';
import { serializeUnsigned } from './ubl';
import { issuanceUnitMutex, type KeyedAsyncMutex } from './unitMutex';

export interface StampInTxDeps<Tx> {
  chain: IssuanceChainStore<Tx>;
  documents: Pick<ZatcaDocumentStore<Tx>, 'insertSigned' | 'advanceUnitChain'>;
  now?: () => Date;
  newUuid?: () => string;
  clockSkewToleranceMs?: number;
}

/** ملخّص ما صدر (يصل afterDocument والمستدعي). */
export interface IssuedDocumentSummary {
  invoiceId: string;
  documentId: string;
  number: string;
  icv: number;
  pih: string;
  uuid: string;
  invoiceHash: string;
  qr: string;
  issuedAt: Date;
  issueDate: string;
  issueTime: string;
  subtype: PreparedIssuance['subtype'];
  typeCode: PreparedIssuance['typeCode'];
  typeName: string;
  flow: InsertedDocument['flow'];
  reportDeadline: Date | null;
  keyVersion: number;
  unitId: string;
  environment: string;
}

export interface StampInTxHooks<Tx> {
  /** الرقم التالي داخل القفل وبمقبض المعاملة (issueStore.prisma.ts nextNumberInTx + phase2NumberPrefix). */
  allocateNumber(tx: Tx, issuedAt: Date): Promise<string>;
  /** tx.invoice.create بالبيانات القديمة نفسها + phase2InvoiceColumns(record) وphase2ItemColumns لكل بند. */
  createInvoice(tx: Tx, record: IssuedInvoiceRecord): Promise<{ id: string }>;
  /** قيود دفتر العميل والإشعارات (بعد المستند). */
  afterDocument?(tx: Tx, issued: IssuedDocumentSummary): Promise<void>;
}

export interface StampInTxInput<Tx> {
  tenantId: string;
  prepared: PreparedIssuance;
  signing: IssuanceSigning;
  /** CompanySettings.taxNumber الحالي (undefined ⇒ بلا مقارنة إضافية). */
  sellerVat?: string | null;
  attemptNo?: number;
  hooks: StampInTxHooks<Tx>;
}

export interface StampInTxResult extends IssuedDocumentSummary {
  mirror: SignedInvoiceMirror;
  snapshot: ZatcaSnapshotV1;
  warnings: ZatcaIssue[];
  xmlBytes: number;
}

export async function stampInTx<Tx>(tx: Tx, deps: StampInTxDeps<Tx>, input: StampInTxInput<Tx>): Promise<StampInTxResult> {
  const { prepared, signing } = input;
  const now = deps.now ?? (() => new Date());
  const attemptNo = input.attemptNo ?? 1;

  // 1
  const head = await deps.chain.lockChainHead(tx, signing.unitId);
  const slot = nextChainSlot(head, { id: signing.unitId, tenantId: input.tenantId, keyVersion: signing.keyVersion, vatNumber: signing.vatNumber }, input.sellerVat);
  // 2
  const issuedAt = issuedAtAfter(now(), slot.tail, deps.clockSkewToleranceMs ?? CLOCK_SKEW_TOLERANCE_MS);
  // 3
  const number = await input.hooks.allocateNumber(tx, issuedAt);
  if (typeof number !== 'string' || number.trim() === '') throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'ISSUE', code: 'NUMBER_EMPTY' } });
  // 4
  const uuid = (deps.newUuid ?? newInvoiceUuid)();
  const { doc, warnings } = mapAndCheck({ ...prepared.src, number }, { icv: slot.icv, pih: slot.pih, uuid, issuedAt }, { qrMaxLength: prepared.qrMaxLength });
  if (doc.typeName !== prepared.typeName || doc.typeCode !== prepared.typeCode) {
    throw new ZatcaHttpError('ZATCA_STAMP_FAILED', { logDetail: { source: 'ISSUE', code: 'TYPE_DRIFT' } });
  }
  if (amountsFingerprintOf(doc) !== prepared.amountsFingerprint) {
    throw new ZatcaHttpError('ZATCA_STAMP_FAILED', { logDetail: { source: 'ISSUE', code: 'AMOUNTS_DRIFT' } });
  }
  // 5
  const unsigned = serializeUnsigned(doc);
  const stamped = await stampDocument(unsigned, doc, signing.signer, signing.cert, issuedAt, prepared.stampKind, { qrMaxLength: prepared.qrMaxLength });
  // 6
  const snapshot = snapshotOf(doc);
  const mirror = signedInvoiceMirror({ subtype: prepared.subtype, uuid, invoiceHash: stamped.invoiceHash, pih: slot.pih, icv: slot.icv, qr: stamped.qr });
  const invoice = await input.hooks.createInvoice(tx, {
    tenantId: input.tenantId, number, issuedAt, kind: prepared.kind, subtype: prepared.subtype, typeName: doc.typeName, snapshot,
    amounts: prepared.amounts, items: prepared.items, mirror,
  });
  if (!invoice || typeof invoice.id !== 'string' || invoice.id === '') throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'ISSUE', code: 'INVOICE_ID' } });
  // 7
  const inserted = await deps.documents.insertSigned(tx, {
    tenantId: input.tenantId, egsUnitId: signing.unitId, invoiceId: invoice.id, attemptNo, icv: slot.icv, uuid, pih: slot.pih,
    invoiceHash: stamped.invoiceHash, typeCode: doc.typeCode, typeName: doc.typeName, issueDate: doc.issueDate, issueTime: doc.issueTime,
    xml: stamped.xml, qr: stamped.qr, issuedAt, keyVersion: signing.keyVersion,
  });
  const advanced = await deps.documents.advanceUnitChain(tx, { unitId: signing.unitId, icv: slot.icv, invoiceHash: stamped.invoiceHash, at: issuedAt });
  if (!advanced) throw chainConflictError('ADVANCE_CAS');
  const summary: IssuedDocumentSummary = {
    invoiceId: invoice.id, documentId: inserted.id, number, icv: slot.icv, pih: slot.pih, uuid, invoiceHash: stamped.invoiceHash, qr: stamped.qr,
    issuedAt, issueDate: doc.issueDate, issueTime: doc.issueTime, subtype: prepared.subtype, typeCode: doc.typeCode, typeName: doc.typeName,
    flow: inserted.flow, reportDeadline: inserted.reportDeadline, keyVersion: signing.keyVersion, unitId: signing.unitId, environment: signing.environment,
  };
  // 8
  if (input.hooks.afterDocument) await input.hooks.afterDocument(tx, summary);
  return { ...summary, mirror, snapshot, warnings, xmlBytes: Buffer.byteLength(stamped.xml, 'utf8') };
}

// ─── التشغيل: قفل العملية + إعادة الترقيم ───

export const NUMBER_COLLISION_ATTEMPTS = 3;

export interface RunIssuanceOptions<T> {
  unitId: string;
  /** يفتح المعاملة ويستدعي stampInTx (prisma.$transaction(fn, {maxWait, timeout}) في المسار). */
  transaction: () => Promise<T>;
  /** null ⇒ بلا قفل داخل العملية (للاختبار وحده). الافتراضي issuanceUnitMutex. */
  mutex?: KeyedAsyncMutex | null;
  waitTimeoutMs?: number;
  numberAttempts?: number;
}

/**
 * قفل الوحدة في العملية ثم المعاملة؛ P2002 على رقم الفاتورة (تصادم مع مستند مرحلة أولى) ⇒ إعادة المعاملة كاملة (ما دام القفل
 * محجوزاً)؛ أي خطأ آخر — ومنه تعارض السلسلة وP2002 على clientRef — يُرمى فوراً بلا إعادة.
 */
export async function runIssuance<T>(o: RunIssuanceOptions<T>): Promise<T> {
  const attempts = Math.max(1, Math.trunc(o.numberAttempts ?? NUMBER_COLLISION_ATTEMPTS));
  const body = async (): Promise<T> => {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await o.transaction();
      } catch (e) {
        if (classifyIssuanceUniqueViolation(e) === 'number') { last = e; continue; }
        throw e;
      }
    }
    throw last;
  };
  const mutex = o.mutex === undefined ? issuanceUnitMutex : o.mutex;
  return mutex ? mutex.runExclusive(o.unitId, body, o.waitTimeoutMs !== undefined ? { waitTimeoutMs: o.waitTimeoutMs } : {}) : body();
}
