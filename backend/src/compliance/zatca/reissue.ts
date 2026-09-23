// ============================================================================
// ZATCA المرحلة الثانية (Z5.4) — إعادة إصدار مستند مرفوض بالرقم والتاريخ نفسيهما ومحاولة جديدة (design Z5.9)
// ----------------------------------------------------------------------------
// design §3 Z5.9 «ZATCA 400 on a simplified invoice already handed over» + z5_plan §3 Z5.4:
//   • الورقة عند المشتري فعلاً، فلا إبطال: تُصحَّح سجلّات الهيئة بمستند جديد يحمل **الرقم نفسه وتاريخ المعاملة نفسه**
//     وUUID وICV وPIH جديدة (attemptNo + 1) — لا فاتورة ثانية ولا رقم ثانٍ.
//   • البايتات تُبنى من `einvoiceSnapshot` (البائع والمشتري والبنود والمبالغ كما دخلت الـXML أول مرّة): لا تُعاد قراءة
//     أسعار اليوم ولا بطاقة العميل اليوم، فلا ينحرف المستند الجديد عن الورقة المطبوعة.
//   • مهلة الإبلاغ تبقى من لحظة الإصدار **الأصلية**: الفاتورة تأخّرت فعلاً، وإخفاء ذلك بتجديد المهلة كذبٌ على الإدارة
//     (نقد 15 يريد التصعيد حتى تُقبل محاولة).
//   • السلسلة تتقدّم بالقفل والـCAS نفسيهما (issueChain) — ICV لا يُعاد استعماله أبداً.
// لا شبكة هنا (الإرسال في submit.ts) ولا قاعدة بيانات مباشرة ولا services/gl.
// ============================================================================

import { newInvoiceUuid } from './crypto';
import type { InsertedDocument, ZatcaDocumentStore } from './documentStore';
import { ZatcaHttpError } from './errors';
import { issuanceIssuesError, supplyDateIssues } from './issue';
import { chainConflictError, nextChainSlot, type IssuanceChainStore } from './issueChain';
import type { IssuanceSigning } from './issueSigner';
import type { ZatcaSnapshotV1 } from './mapInvoice';
import type { UblDocument, ZatcaIssue } from './model';
import { preflightIssues } from './preflight';
import { stampDocument } from './stamp';
import { mirrorQrOf, mirrorStatusOf, type InvoiceMirrorStatus, type Subtype } from './status';
import { serializeUnsigned } from './ubl';

/** قيم السلسلة الجديدة تُركَّب فوق اللقطة؛ كل ما عداها من الأصل حرفياً. */
export function documentFromSnapshot(snapshot: ZatcaSnapshotV1, chain: { uuid: string; icv: number; pih: string }): UblDocument {
  const { v, subtype, ...rest } = snapshot as ZatcaSnapshotV1 & { v: 1 };
  void v; void subtype;
  return { ...rest, uuid: chain.uuid, icv: chain.icv, pih: chain.pih } as UblDocument;
}

export interface ReissueMirror {
  einvoiceStatus: InvoiceMirrorStatus;
  einvoiceUuid: string;
  einvoiceHash: string;
  einvoicePih: string;
  einvoiceIcv: number;
  einvoiceQr: string | null;
  einvoiceWarnings: null;
  einvoiceSubmittedAt: null;
}

export interface ReissueHooks<Tx> {
  /** تحديث مرآة الفاتورة إلى المحاولة الجديدة (الصفّ نفسه: لا فاتورة ثانية ولا رقم ثانٍ). */
  remirror(tx: Tx, mirror: ReissueMirror): Promise<void>;
}

export interface ReissueInput<Tx> {
  tenantId: string;
  invoiceId: string;
  /** attemptNo للمحاولة الجديدة (السابق + 1). */
  attemptNo: number;
  subtype: Subtype;
  snapshot: ZatcaSnapshotV1;
  /** لحظة الإصدار الأصلية (منها مهلة الإبلاغ) — التاريخ والوقت في الـXML من اللقطة نفسها. */
  originalIssuedAt: Date;
  signing: IssuanceSigning;
  sellerVat?: string | null;
  qrMaxLength?: number;
  hooks: ReissueHooks<Tx>;
}

export interface ReissueDeps<Tx> {
  chain: IssuanceChainStore<Tx>;
  documents: Pick<ZatcaDocumentStore<Tx>, 'insertSigned' | 'advanceUnitChain'>;
  now?: () => Date;
  newUuid?: () => string;
}

export interface ReissueResult {
  documentId: string;
  attemptNo: number;
  icv: number;
  pih: string;
  uuid: string;
  invoiceHash: string;
  qr: string;
  typeCode: string;
  typeName: string;
  issueDate: string;
  issueTime: string;
  flow: InsertedDocument['flow'];
  reportDeadline: Date | null;
  environment: string;
  mirror: ReissueMirror;
  warnings: ZatcaIssue[];
}

/**
 * يعيد ختم المستند داخل معاملة قائمة: قفل السلسلة ⇒ خانة جديدة ⇒ بناء من اللقطة ⇒ فحص مسبق ⇒ ختم ⇒ إدراج بمحاولة
 * جديدة ⇒ تقدّم السلسلة ⇒ تحديث مرآة الفاتورة. أي رمي يُلغي المعاملة كاملة (لا ICV مستهلك).
 */
export async function reissueInTx<Tx>(tx: Tx, deps: ReissueDeps<Tx>, input: ReissueInput<Tx>): Promise<ReissueResult> {
  const now = deps.now ?? (() => new Date());
  if (!Number.isInteger(input.attemptNo) || input.attemptNo < 2) {
    throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'REISSUE', code: 'ATTEMPT_NO' } });
  }
  const head = await deps.chain.lockChainHead(tx, input.signing.unitId);
  const slot = nextChainSlot(
    head,
    { id: input.signing.unitId, tenantId: input.tenantId, keyVersion: input.signing.keyVersion, vatNumber: input.signing.vatNumber },
    input.sellerVat,
  );
  const uuid = (deps.newUuid ?? newInvoiceUuid)();
  const doc = documentFromSnapshot(input.snapshot, { uuid, icv: slot.icv, pih: slot.pih });
  const stampKind: 'standard' | 'simplified' = input.subtype === '01' ? 'standard' : 'simplified';
  if (doc.typeName.slice(0, 2) !== input.subtype) throw new ZatcaHttpError('ZATCA_STAMP_FAILED', { logDetail: { source: 'REISSUE', code: 'SUBTYPE_DRIFT' } });

  const issues = [...preflightIssues(doc, stampKind, input.qrMaxLength !== undefined ? { qrMaxLength: input.qrMaxLength } : {}), ...supplyDateIssues(doc)];
  const err = issuanceIssuesError(issues);
  if (err) throw err;

  const unsigned = serializeUnsigned(doc);
  const stamped = await stampDocument(
    unsigned, doc, input.signing.signer, input.signing.cert, now(), stampKind,
    input.qrMaxLength !== undefined ? { qrMaxLength: input.qrMaxLength } : {},
  );

  const inserted = await deps.documents.insertSigned(tx, {
    tenantId: input.tenantId, egsUnitId: input.signing.unitId, invoiceId: input.invoiceId, attemptNo: input.attemptNo,
    icv: slot.icv, uuid, pih: slot.pih, invoiceHash: stamped.invoiceHash, typeCode: doc.typeCode, typeName: doc.typeName,
    issueDate: doc.issueDate, issueTime: doc.issueTime, xml: stamped.xml, qr: stamped.qr,
    // المهلة من الإصدار الأصلي لا من الآن: الفاتورة تأخّرت فعلاً وتبقى ظاهرةً متأخّرة حتى تُقبل (نقد 15)
    issuedAt: input.originalIssuedAt, keyVersion: input.signing.keyVersion,
  });
  const advanced = await deps.documents.advanceUnitChain(tx, {
    unitId: input.signing.unitId, icv: slot.icv, invoiceHash: stamped.invoiceHash, at: now(),
  });
  if (!advanced) throw chainConflictError('REISSUE_ADVANCE_CAS');

  const status = mirrorStatusOf('SIGNED', input.subtype);
  if (!status) throw new ZatcaHttpError('ZATCA_INTERNAL', { logDetail: { source: 'REISSUE', code: 'MIRROR' } });
  const mirror: ReissueMirror = {
    einvoiceStatus: status,
    einvoiceUuid: uuid,
    einvoiceHash: stamped.invoiceHash,
    einvoicePih: slot.pih,
    einvoiceIcv: slot.icv,
    einvoiceQr: mirrorQrOf({ subtype: input.subtype, status: 'SIGNED', qr: stamped.qr, clearedQr: null }),
    einvoiceWarnings: null,
    einvoiceSubmittedAt: null,
  };
  await input.hooks.remirror(tx, mirror);

  return {
    documentId: inserted.id, attemptNo: input.attemptNo, icv: slot.icv, pih: slot.pih, uuid, invoiceHash: stamped.invoiceHash,
    qr: stamped.qr, typeCode: doc.typeCode, typeName: doc.typeName, issueDate: doc.issueDate, issueTime: doc.issueTime,
    flow: inserted.flow, reportDeadline: inserted.reportDeadline, environment: input.signing.environment, mirror,
    warnings: issues.filter(i => i.severity !== 'error'),
  };
}

// ─── أهليّة إعادة الإصدار ───

export type ReissueRefusal = 'NOT_PHASE2' | 'NOT_SIMPLIFIED' | 'NOT_REJECTED' | 'NO_SNAPSHOT' | 'NO_DOCUMENT' | 'NOT_CONFIRMED';

export const REISSUE_REFUSAL_MESSAGES: Readonly<Record<ReissueRefusal, string>> = Object.freeze({
  NOT_PHASE2: 'هذه الفاتورة ليست من الفوترة الإلكترونية للمرحلة الثانية',
  NOT_SIMPLIFIED: 'إعادة الإصدار للفاتورة المبسّطة المرفوضة وحدها — والقياسية المرفوضة تُبطل وتُصدر من جديد',
  NOT_REJECTED: 'إعادة الإصدار للفاتورة التي رفضتها الهيئة وحدها',
  NO_SNAPSHOT: 'لا توجد لقطة للفاتورة لإعادة ختمها — راجع الإدارة',
  NO_DOCUMENT: 'لا يوجد مستند ضريبي لهذه الفاتورة',
  NOT_CONFIRMED: 'الفاتورة غير معتمدة أو أُلغيت',
});

export interface ReissueInvoiceView {
  status: string;
  zatcaPhase: number | null;
  invoiceSubtype: string | null;
  einvoiceStatus: string | null;
  einvoiceSnapshot: unknown;
  issuedAt: Date | null;
}

export type ReissueDecision =
  | { ok: true; snapshot: ZatcaSnapshotV1; issuedAt: Date; attemptNo: number }
  | { ok: false; refusal: ReissueRefusal; messageAr: string };

const refuse = (refusal: ReissueRefusal): ReissueDecision => ({ ok: false, refusal, messageAr: REISSUE_REFUSAL_MESSAGES[refusal] });

/** نقيّ: هل يجوز إعادة إصدار هذه الفاتورة الآن؟ (02 مرفوضة، بلقطة صالحة، ولها مستند سابق). */
export function reissueDecision(input: {
  invoice: ReissueInvoiceView;
  document: { attemptNo: number; status: string } | null;
}): ReissueDecision {
  const { invoice, document } = input;
  if (invoice.zatcaPhase !== 2) return refuse('NOT_PHASE2');
  if (invoice.invoiceSubtype !== '02') return refuse('NOT_SIMPLIFIED');
  if (invoice.status !== 'CONFIRMED') return refuse('NOT_CONFIRMED');
  if (invoice.einvoiceStatus !== 'rejected') return refuse('NOT_REJECTED');
  if (!document) return refuse('NO_DOCUMENT');
  if (document.status !== 'REJECTED') return refuse('NOT_REJECTED');
  const snap = invoice.einvoiceSnapshot;
  if (!snap || typeof snap !== 'object' || (snap as { v?: unknown }).v !== 1) return refuse('NO_SNAPSHOT');
  if (!(invoice.issuedAt instanceof Date) || !Number.isFinite(invoice.issuedAt.getTime())) return refuse('NO_SNAPSHOT');
  return { ok: true, snapshot: snap as ZatcaSnapshotV1, issuedAt: invoice.issuedAt, attemptNo: document.attemptNo + 1 };
}
