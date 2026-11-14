import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { ATTACHMENT_KINDS, type AttachmentKind, type PartnerDb } from '../../services/gl/reports/partnerLoad.prisma';

/**
 * «ربط الدفاتر» L8 — مرفقات المستند المصدر من الدفاتر (عقد §6.3): المحاسب يرى صورة السند أو الاستلام أو توقيع الفاتورة
 * أو مرفق حركة المستودع أو وثيقة العميل من سطر القيد أو دفتر الشريك، **بصلاحية canViewLedger وحدها** بلا صلاحية تشغيلية.
 *
 * - `GET /source-attachments?sourceType=&sourceId=` ⇒ `{items:[{kind, id, name, mime, size, createdAt}]}` — بيانات وصفية
 *   فقط (البادئة والطول من القاعدة، لا الصورة)، ومعها مرفقات القيود المرحّلة للمصدر (GlAttachment).
 * - `GET /source-attachments/:kind/:id[?sourceId=]` ⇒ `{data (data URL), mime, name}`.
 *
 * العزل (§9.4): المصدر يُتحقّق من انتمائه للشركة قبل أي قراءة، وكل مرفق يُقرأ من جدول نوعه وحده بشرط الشركة (بعلاقة
 * الأب للجداول التي لا تحمل tenantId)، ومعرّف من جدول آخر أو شركة أخرى ⇒ 404. و`sourceId` إن مُرِّر يجب أن يكون مصدر المرفق.
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const locals = (res: Response) => res.locals.ledger as LedgerLocals;

export const ATTACHMENT_SOURCE_TYPES = [
  'RECEIPT', 'SETTLEMENT', 'USER_SETTLEMENT', 'INVOICE', 'WH_ENTRY', 'CUSTOMER',
  'AR_ENTRY', 'CUSTOMER_ADJUSTMENT', 'PAYLINK_FEE', 'PAYOUT', 'PAYLINK_REFUND', 'VAN_LOAD',
] as const;
export type AttachmentSourceType = (typeof ATTACHMENT_SOURCE_TYPES)[number];

export const ATTACHMENT_NOT_FOUND_MESSAGE = 'المرفق غير موجود';
export const SOURCE_NOT_FOUND_MESSAGE = 'المستند المصدر غير موجود في هذه الشركة';

const KIND_LABELS: Readonly<Record<AttachmentKind, string>> = {
  RECEIPT_PHOTO: 'صورة السند',
  REP_SETTLEMENT_PHOTO: 'صورة الاستلام',
  USER_SETTLEMENT_PHOTO: 'صورة التوريد',
  INVOICE_SIGNATURE: 'توقيع الفاتورة',
  WAREHOUSE_ATTACHMENT: 'مرفق حركة المستودع',
  CUSTOMER_DOCUMENT: 'وثيقة العميل',
  LEDGER_ATTACHMENT: 'مرفق القيد',
};

export interface SourceAttachmentItem {
  kind: AttachmentKind;
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: Date;
}

// ═══ data URL (صرفة) ═══

const EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
};

/** نوع المحتوى من بادئة data URL — غير ذلك ⇒ application/octet-stream */
export function dataUrlMime(head: string | null | undefined): string {
  const m = /^data:([a-z0-9.+/-]+)[;,]/i.exec(head ?? '');
  return m ? m[1].toLowerCase() : 'application/octet-stream';
}

/** حجم البايتات بعد فكّ base64 من الطول الكلي والبادئة وآخر حرفين (الحشو) — بلا نقل المحتوى */
export function dataUrlSize(len: number, head: string | null | undefined, tail: string | null | undefined): number {
  const h = head ?? '';
  const comma = h.indexOf(',');
  if (!h.startsWith('data:') || comma < 0) return len;
  const payload = len - comma - 1;
  if (!/;base64,/i.test(h.slice(0, comma + 1))) return Math.max(0, payload);
  const t = tail ?? '';
  const pad = t.endsWith('==') ? 2 : t.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - pad);
}

export function attachmentName(kind: AttachmentKind, mime: string, index: number, extra?: string | null): string {
  const ext = EXT[mime] ? `.${EXT[mime]}` : '';
  return `${extra ? `${KIND_LABELS[kind]} — ${extra}` : KIND_LABELS[kind]} ${index}${ext}`;
}

interface MetaRow { id: string; head: string | null; len: number | null; tail: string | null; createdAt: Date }

const metaItems = (kind: AttachmentKind, rows: readonly MetaRow[], extraOf?: (r: MetaRow) => string | null): SourceAttachmentItem[] =>
  rows.filter((r) => r.len !== null && r.len > 0).map((r, i) => {
    const mime = dataUrlMime(r.head);
    return { kind, id: r.id, name: attachmentName(kind, mime, i + 1, extraOf?.(r) ?? null), mime, size: dataUrlSize(Number(r.len), r.head, r.tail), createdAt: r.createdAt };
  });

// ═══ القراءة ═══

/** المصدر للشركة؟ (قبل أي قراءة لمرفقاته) — المصادر بلا جدول مرفقات تكفيها قيودها */
async function sourceExists(db: PartnerDb, tenantId: string, sourceType: AttachmentSourceType, id: string): Promise<boolean> {
  const where = { id, tenantId };
  switch (sourceType) {
    case 'RECEIPT': return !!(await db.receipt.findFirst({ where, select: { id: true } }));
    case 'SETTLEMENT': return !!(await db.repSettlement.findFirst({ where, select: { id: true } }));
    case 'USER_SETTLEMENT': return !!(await db.userSettlement.findFirst({ where, select: { id: true } }));
    case 'INVOICE': return !!(await db.invoice.findFirst({ where, select: { id: true } }));
    case 'WH_ENTRY': return !!(await db.warehouseEntry.findFirst({ where, select: { id: true } }));
    case 'CUSTOMER': return !!(await db.customer.findFirst({ where, select: { id: true } }));
    default:
      // مصدر بلا جدول مرفقات (AR_ENTRY وغيره): يكفي أن له قيداً في دفاتر الشركة
      return !!(await db.glMove.findFirst({ where: { tenantId, sourceType, sourceId: id }, select: { id: true } }));
  }
}

/** مرفقات مصدر واحد (بيانات وصفية) — بلا قراءة المحتوى */
export async function listSourceAttachments(
  db: PartnerDb, tenantId: string, sourceType: AttachmentSourceType, sourceId: string,
): Promise<SourceAttachmentItem[] | null> {
  if (!(await sourceExists(db, tenantId, sourceType, sourceId))) return null;
  const items: SourceAttachmentItem[] = [];
  switch (sourceType) {
    case 'RECEIPT':
      items.push(...metaItems('RECEIPT_PHOTO', await db.$queryRaw<MetaRow[]>`
        SELECT p."id", substr(p."data", 1, 64) AS "head", length(p."data")::int AS "len", right(p."data", 2) AS "tail", p."createdAt"
        FROM "receipt_photos" p JOIN "receipts" r ON r."id" = p."receiptId"
        WHERE p."receiptId" = ${sourceId} AND r."tenantId" = ${tenantId}
        ORDER BY p."createdAt" ASC, p."id" ASC`));
      break;
    case 'SETTLEMENT':
      items.push(...metaItems('REP_SETTLEMENT_PHOTO', await db.$queryRaw<MetaRow[]>`
        SELECT p."id", substr(p."data", 1, 64) AS "head", length(p."data")::int AS "len", right(p."data", 2) AS "tail", p."createdAt"
        FROM "rep_settlement_photos" p JOIN "rep_settlements" s ON s."id" = p."settlementId"
        WHERE p."settlementId" = ${sourceId} AND s."tenantId" = ${tenantId}
        ORDER BY p."createdAt" ASC, p."id" ASC`));
      break;
    case 'USER_SETTLEMENT':
      items.push(...metaItems('USER_SETTLEMENT_PHOTO', await db.$queryRaw<MetaRow[]>`
        SELECT p."id", substr(p."data", 1, 64) AS "head", length(p."data")::int AS "len", right(p."data", 2) AS "tail", p."createdAt"
        FROM "user_settlement_photos" p JOIN "user_settlements" s ON s."id" = p."settlementId"
        WHERE p."settlementId" = ${sourceId} AND s."tenantId" = ${tenantId}
        ORDER BY p."createdAt" ASC, p."id" ASC`));
      break;
    case 'INVOICE': {
      const rows = await db.$queryRaw<{ invoiceId: string; head: string | null; len: number | null; tail: string | null;
        repHead: string | null; repLen: number | null; repTail: string | null; createdAt: Date }[]>`
        SELECT s."invoiceId", substr(s."image", 1, 64) AS "head", length(s."image")::int AS "len", right(s."image", 2) AS "tail",
               substr(s."repImage", 1, 64) AS "repHead", length(s."repImage")::int AS "repLen", right(s."repImage", 2) AS "repTail",
               s."createdAt"
        FROM "invoice_signatures" s
        WHERE s."invoiceId" = ${sourceId} AND s."tenantId" = ${tenantId}`;
      for (const r of rows) {
        items.push(...metaItems('INVOICE_SIGNATURE', [
          { id: `${r.invoiceId}:customer`, head: r.head, len: r.len, tail: r.tail, createdAt: r.createdAt },
        ], () => 'المستلم'));
        items.push(...metaItems('INVOICE_SIGNATURE', [
          { id: `${r.invoiceId}:rep`, head: r.repHead, len: r.repLen, tail: r.repTail, createdAt: r.createdAt },
        ], () => 'المندوب'));
      }
      break;
    }
    case 'WH_ENTRY': {
      const rows = await db.warehouseEntryAttachment.findMany({
        where: { tenantId, entryId: sourceId }, select: { id: true, name: true, mime: true, size: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const r of rows) items.push({ kind: 'WAREHOUSE_ATTACHMENT', id: r.id, name: r.name, mime: r.mime, size: r.size, createdAt: r.createdAt });
      break;
    }
    case 'CUSTOMER': {
      const rows = await db.$queryRaw<{ id: string; head: string | null; size: number; kind: string; createdAt: Date }[]>`
        SELECT d."id", substr(d."data", 1, 64) AS "head", d."sizeBytes" AS "size", d."kind", d."createdAt"
        FROM "customer_documents" d
        WHERE d."tenantId" = ${tenantId} AND d."customerId" = ${sourceId}
        ORDER BY d."createdAt" ASC, d."id" ASC`;
      rows.forEach((r, i) => {
        const mime = dataUrlMime(r.head);
        items.push({ kind: 'CUSTOMER_DOCUMENT', id: r.id, name: attachmentName('CUSTOMER_DOCUMENT', mime, i + 1, r.kind), mime, size: Number(r.size), createdAt: r.createdAt });
      });
      break;
    }
    default:
      break;
  }
  // مرفقات القيود المرحّلة للمصدر نفسه (GlAttachment) — العميل ليس مصدر قيد
  if (sourceType !== 'CUSTOMER') {
    const moves = await db.glMove.findMany({ where: { tenantId, sourceType, sourceId }, select: { id: true } });
    if (moves.length > 0) {
      const rows = await db.glAttachment.findMany({
        where: { tenantId, entityType: 'MOVE', entityId: { in: moves.map((m) => m.id) } },
        select: { id: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      for (const r of rows) items.push({ kind: 'LEDGER_ATTACHMENT', id: r.id, name: r.fileName, mime: r.mimeType, size: r.sizeBytes, createdAt: r.createdAt });
    }
  }
  return items;
}

export interface AttachmentContent { data: string; mime: string; name: string }

const fromDataUrl = (kind: AttachmentKind, data: string, extra?: string | null): AttachmentContent => {
  const mime = dataUrlMime(data.slice(0, 64));
  return { data, mime, name: attachmentName(kind, mime, 1, extra ?? null) };
};

/**
 * محتوى مرفق واحد من جدول نوعه بشرط الشركة، و`sourceId` (إن مُرِّر) يجب أن يكون مصدره — وإلا null (404).
 */
export async function readSourceAttachment(
  db: PartnerDb, tenantId: string, kind: AttachmentKind, id: string, sourceId: string | null,
): Promise<AttachmentContent | null> {
  const owns = (parentId: string) => sourceId === null || sourceId === parentId;
  switch (kind) {
    case 'RECEIPT_PHOTO': {
      const r = await db.receiptPhoto.findFirst({ where: { id, receipt: { tenantId } }, select: { data: true, receiptId: true } });
      return r && owns(r.receiptId) ? fromDataUrl(kind, r.data) : null;
    }
    case 'REP_SETTLEMENT_PHOTO': {
      const r = await db.repSettlementPhoto.findFirst({ where: { id, settlement: { tenantId } }, select: { data: true, settlementId: true } });
      return r && owns(r.settlementId) ? fromDataUrl(kind, r.data) : null;
    }
    case 'USER_SETTLEMENT_PHOTO': {
      const r = await db.userSettlementPhoto.findFirst({ where: { id, settlement: { tenantId } }, select: { data: true, settlementId: true } });
      return r && owns(r.settlementId) ? fromDataUrl(kind, r.data) : null;
    }
    case 'INVOICE_SIGNATURE': {
      const m = /^(.+):(customer|rep)$/.exec(id);
      if (!m) return null;
      const [, invoiceId, which] = m;
      if (!owns(invoiceId)) return null;
      const r = await db.invoiceSignature.findFirst({ where: { invoiceId, tenantId }, select: { image: true, repImage: true } });
      const data = which === 'rep' ? r?.repImage : r?.image;
      return data ? fromDataUrl(kind, data, which === 'rep' ? 'المندوب' : 'المستلم') : null;
    }
    case 'WAREHOUSE_ATTACHMENT': {
      const r = await db.warehouseEntryAttachment.findFirst({ where: { id, tenantId }, select: { data: true, mime: true, name: true, entryId: true } });
      return r && owns(r.entryId) ? { data: r.data, mime: r.mime, name: r.name } : null;
    }
    case 'CUSTOMER_DOCUMENT': {
      const r = await db.customerDocument.findFirst({ where: { id, tenantId }, select: { data: true, kind: true, customerId: true } });
      return r && owns(r.customerId) ? fromDataUrl(kind, r.data, r.kind) : null;
    }
    case 'LEDGER_ATTACHMENT': {
      const r = await db.glAttachment.findFirst({
        where: { id, tenantId, entityType: 'MOVE' },
        select: { fileName: true, mimeType: true, entityId: true, blob: { select: { bytes: true } } },
      });
      if (!r?.blob) return null;
      if (sourceId !== null && sourceId !== r.entityId) {
        const mv = await db.glMove.findFirst({ where: { id: r.entityId, tenantId }, select: { sourceId: true } });
        if (mv?.sourceId !== sourceId) return null;
      }
      return { data: `data:${r.mimeType};base64,${Buffer.from(r.blob.bytes).toString('base64')}`, mime: r.mimeType, name: r.fileName };
    }
  }
}

// ═══ النقاط ═══

const idish = z.string().trim().min(1).max(128);
export const sourceAttachmentsQuerySchema = z.object({
  sourceType: z.enum(ATTACHMENT_SOURCE_TYPES),
  sourceId: idish.optional(),
  /** مرادف sourceId لنوع CUSTOMER */
  customerId: idish.optional(),
});

router.get('/source-attachments', VIEW, ledgerHandler(async (req, res) => {
  const q = sourceAttachmentsQuerySchema.parse(req.query ?? {});
  const sourceId = q.sourceId ?? (q.sourceType === 'CUSTOMER' ? q.customerId : undefined);
  if (!sourceId) throw new LedgerHttpError(400, 'المستند المصدر مطلوب', { reason: 'SOURCE_ID_REQUIRED' });
  const items = await listSourceAttachments(prisma, locals(res).tenantId, q.sourceType, sourceId);
  if (!items) throw new LedgerHttpError(404, SOURCE_NOT_FOUND_MESSAGE, { reason: 'SOURCE_NOT_FOUND', sourceType: q.sourceType, sourceId });
  res.json({ success: true, data: { sourceType: q.sourceType, sourceId, items } });
}));

router.get('/source-attachments/:kind/:id', VIEW, ledgerHandler(async (req, res) => {
  const kind = String(req.params.kind);
  if (!(ATTACHMENT_KINDS as readonly string[]).includes(kind)) {
    throw new LedgerHttpError(400, 'نوع مرفق غير معروف', { reason: 'INVALID_KIND', allowed: ATTACHMENT_KINDS });
  }
  const id = idish.parse(String(req.params.id));
  const rawSource = typeof req.query.sourceId === 'string' && req.query.sourceId.trim() !== '' ? req.query.sourceId.trim().slice(0, 128) : null;
  const content = await readSourceAttachment(prisma, locals(res).tenantId, kind as AttachmentKind, id, rawSource);
  if (!content) throw new LedgerHttpError(404, ATTACHMENT_NOT_FOUND_MESSAGE, { reason: 'ATTACHMENT_NOT_FOUND', kind, id });
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ success: true, data: content });
}));

export default router;
