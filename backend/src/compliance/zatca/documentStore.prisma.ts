// ============================================================================
// ZATCA المرحلة الثانية (Z5.0) — محوّل Prisma لمخزن المستندات (يُفحص نوعياً ولا يُنفَّذ في الاختبارات)
// ----------------------------------------------------------------------------
// • القفل والمطالبة بـ$queryRaw: SELECT … FOR UPDATE على صفّ الوحدة (أول قفل في معاملة الإصدار)، وUPDATE ذرّي للمطالبة
//   المفردة، وCTE بـFOR UPDATE OF d SKIP LOCKED للمطالبة الجماعية (عاملان لا يأخذان المستند نفسه).
// • عقود الإيجار بساعة القاعدة NOW() (كعقد gl_settings في postingStore.prisma.ts) — لا انحراف بين نسخ الخادم.
// • الكتابة الخام لا تضبط @updatedAt تلقائياً ⇒ تُكتب صراحةً. تقدّم السلسلة مشروط بـstatus='ACTIVE' وlastIcv=icv−1: لا كتابة
//   على وحدة RENEWING أبداً (عقود الربط والتجديد تعتمد updatedAt).
// • فخّ NULL: لا { col: { not: … } } على عمود قابل للإفراغ؛ الشروط الخام تكتب IS NULL صراحةً.
// • الاستيراد نوعي فقط (import type) — لا يُحمَّل @prisma/client وقت التشغيل من هذا الملف، ولا يُكتب JSON null.
// ============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CLAIM_SCAN_FACTOR, CLAIM_SCAN_MAX, DEFAULT_SUBMIT_UNIT_STATUSES, gunzipXml, gzipXml, validateSignedInput, type ClaimedDocument,
  type DocumentProjection, type LockedUnitRow, type ZatcaDocumentStore,
} from './documentStore';
import type { Flow } from './status';

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | 'zatcaDocument' | 'zatcaApiLog' | 'invoice'>;
export type DocumentStoreTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'zatcaDocument' | 'invoice'>;

const PROJECTION_SELECT = {
  id: true, egsUnitId: true, attemptNo: true, icv: true, uuid: true, pih: true, invoiceHash: true, typeCode: true, typeName: true,
  issueDate: true, issueTime: true, flow: true, qr: true, clearedQr: true, status: true, httpStatus: true, validation: true, attempts: true,
  nextAttemptAt: true, firstSubmitAt: true, finalizedAt: true, reportDeadline: true, keyVersion: true, createdAt: true, updatedAt: true,
  egsUnit: { select: { environment: true } },
} satisfies Prisma.ZatcaDocumentSelect;

interface ClaimedRaw {
  id: string; tenantId: string; egsUnitId: string; invoiceId: string; attemptNo: number; icv: number; uuid: string; invoiceHash: string;
  typeName: string; flow: string; attempts: number; leaseUntil: Date; priorEmpty400: number; priorPayload413: number;
  reportDeadline: Date | null; keyVersion: number | null; createdAt: Date;
}

const claimedOf = (r: ClaimedRaw): ClaimedDocument => ({ ...r, flow: r.flow as Flow });

const leaseInterval = (leaseMs: number): string => `${Math.max(1000, Math.trunc(leaseMs))} milliseconds`;

export function prismaZatcaDocumentStore(prisma: Db): ZatcaDocumentStore<DocumentStoreTx> {
  return {
    async lockUnitForIssuance(tx, unitId) {
      const rows = await tx.$queryRaw<LockedUnitRow[]>`
        SELECT id, "tenantId", status, environment, "keyVersion", "vatNumber", "lastIcv", "lastInvoiceHash"
        FROM zatca_egs_units WHERE id = ${unitId} FOR UPDATE`;
      return rows[0] ?? null;
    },

    async advanceUnitChain(tx, a) {
      const n = await tx.$executeRaw`
        UPDATE zatca_egs_units SET "lastIcv" = ${a.icv}, "lastInvoiceHash" = ${a.invoiceHash}, "updatedAt" = ${a.at}
        WHERE id = ${a.unitId} AND status = 'ACTIVE' AND "lastIcv" = ${a.icv - 1}`;
      return n === 1;
    },

    async insertSigned(tx, doc) {
      const { flow, reportDeadline } = validateSignedInput(doc);
      const row = await tx.zatcaDocument.create({
        data: {
          tenantId: doc.tenantId, egsUnitId: doc.egsUnitId, invoiceId: doc.invoiceId, attemptNo: doc.attemptNo, icv: doc.icv, uuid: doc.uuid,
          pih: doc.pih, invoiceHash: doc.invoiceHash, typeCode: doc.typeCode, typeName: doc.typeName, issueDate: doc.issueDate,
          issueTime: doc.issueTime, flow, xmlGz: gzipXml(doc.xml), qr: doc.qr, status: 'SIGNED', reportDeadline, keyVersion: doc.keyVersion,
        },
        select: { id: true },
      });
      return { id: row.id, flow, reportDeadline };
    },

    async claim(id, opts) {
      const ignore = opts.ignoreSchedule === true;
      const rows = await prisma.$queryRaw<ClaimedRaw[]>`
        UPDATE zatca_documents SET status = 'SUBMITTING', "leaseUntil" = NOW() + ${leaseInterval(opts.leaseMs)}::interval,
          attempts = attempts + 1, "firstSubmitAt" = COALESCE("firstSubmitAt", NOW()), "updatedAt" = NOW()
        WHERE id = ${id} AND (
          (status IN ('SIGNED', 'RETRY_WAIT') AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
            AND (${ignore}::boolean OR "nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
          OR (status = 'SUBMITTING' AND "leaseUntil" IS NOT NULL AND "leaseUntil" < NOW()))
        RETURNING id, "tenantId", "egsUnitId", "invoiceId", "attemptNo", icv, uuid, "invoiceHash", "typeName", flow, attempts, "leaseUntil",
          "priorEmpty400", "priorPayload413", "reportDeadline", "keyVersion", "createdAt"`;
      return rows[0] ? claimedOf(rows[0]) : null;
    },

    async claimBatch(opts) {
      const limit = Math.max(0, Math.trunc(opts.limit));
      const perUnit = Math.max(0, Math.trunc(opts.perUnit));
      if (limit === 0 || perUnit === 0) return [];
      const scan = Math.min(CLAIM_SCAN_MAX, limit * CLAIM_SCAN_FACTOR);
      const statuses = [...(opts.unitStatuses ?? DEFAULT_SUBMIT_UNIT_STATUSES)];
      // FOR UPDATE لا يجتمع مع دوالّ النوافذ في المستوى نفسه: القفل في candidates، والعدل (row_number لكل وحدة) خارجه
      const rows = await prisma.$queryRaw<ClaimedRaw[]>`
        WITH candidates AS (
          SELECT d.id, d."egsUnitId", d.icv, d."reportDeadline", d."createdAt"
          FROM zatca_documents d
          JOIN zatca_egs_units u ON u.id = d."egsUnitId"
          WHERE u.status = ANY(${statuses}::text[])
            AND (
              (d.status IN ('SIGNED', 'RETRY_WAIT') AND (d."leaseUntil" IS NULL OR d."leaseUntil" < NOW())
                AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW()))
              OR (d.status = 'SUBMITTING' AND d."leaseUntil" IS NOT NULL AND d."leaseUntil" < NOW()))
          ORDER BY d."reportDeadline" ASC NULLS LAST, d."egsUnitId", d.icv
          LIMIT ${scan}
          FOR UPDATE OF d SKIP LOCKED
        ), ranked AS (
          SELECT id, "egsUnitId", icv, "reportDeadline", "createdAt",
            row_number() OVER (PARTITION BY "egsUnitId" ORDER BY icv) AS rn
          FROM candidates
        ), picked AS (
          SELECT id FROM ranked WHERE rn <= ${perUnit}
          ORDER BY "reportDeadline" ASC NULLS LAST, "createdAt" ASC, "egsUnitId", icv
          LIMIT ${limit}
        )
        UPDATE zatca_documents z SET status = 'SUBMITTING', "leaseUntil" = NOW() + ${leaseInterval(opts.leaseMs)}::interval,
          attempts = z.attempts + 1, "firstSubmitAt" = COALESCE(z."firstSubmitAt", NOW()), "updatedAt" = NOW()
        FROM picked WHERE z.id = picked.id
        RETURNING z.id, z."tenantId", z."egsUnitId", z."invoiceId", z."attemptNo", z.icv, z.uuid, z."invoiceHash", z."typeName", z.flow,
          z.attempts, z."leaseUntil", z."priorEmpty400", z."priorPayload413", z."reportDeadline", z."keyVersion", z."createdAt"`;
      return rows.map(claimedOf);
    },

    async applyOutcome(tx, fence, patch) {
      const db = tx ?? prisma;
      const data: Prisma.ZatcaDocumentUpdateManyMutationInput = { status: patch.status, nextAttemptAt: patch.nextAttemptAt, leaseUntil: null };
      if (patch.flow !== undefined) data.flow = patch.flow;
      if (patch.finalizedAt !== undefined) data.finalizedAt = patch.finalizedAt;
      if (patch.reportDeadline !== undefined) data.reportDeadline = patch.reportDeadline;
      if (patch.priorEmpty400 !== undefined) data.priorEmpty400 = patch.priorEmpty400;
      if (patch.priorPayload413 !== undefined) data.priorPayload413 = patch.priorPayload413;
      if (patch.httpStatus !== undefined) data.httpStatus = patch.httpStatus;
      if (patch.validation !== undefined) data.validation = patch.validation as Prisma.InputJsonObject;
      if (patch.clearedXmlGz !== undefined) data.clearedXmlGz = patch.clearedXmlGz;
      if (patch.clearedQr !== undefined) data.clearedQr = patch.clearedQr;
      const r = await db.zatcaDocument.updateMany({ where: { id: fence.id, status: 'SUBMITTING', attempts: fence.attempts }, data });
      return r.count === 1;
    },

    async mirrorInvoice(tx, invoiceId, mirror) {
      const db = tx ?? prisma;
      const r = await db.invoice.updateMany({
        where: { id: invoiceId, zatcaPhase: 2 },
        data: {
          einvoiceStatus: mirror.einvoiceStatus, einvoiceQr: mirror.einvoiceQr, einvoiceWarnings: mirror.einvoiceWarnings,
          ...(mirror.einvoiceSubmittedAt !== undefined ? { einvoiceSubmittedAt: mirror.einvoiceSubmittedAt } : {}),
        },
      });
      return r.count === 1;
    },

    async writeApiLog(row) {
      await prisma.zatcaApiLog.create({
        data: {
          tenantId: row.tenantId, egsUnitId: row.egsUnitId, documentId: row.documentId, actorId: row.actorId, endpoint: row.endpoint,
          httpStatus: row.httpStatus, outcome: row.outcome, durationMs: row.durationMs,
          response: row.response === null ? undefined : (row.response as Prisma.InputJsonObject),
          errorText: row.errorText, createdAt: row.at,
        },
      });
    },

    async loadProjection(tenantId, invoiceId) {
      const r = await prisma.zatcaDocument.findFirst({ where: { tenantId, invoiceId }, orderBy: { attemptNo: 'desc' }, select: PROJECTION_SELECT });
      if (!r) return null;
      const { egsUnit, ...rest } = r;
      const out: DocumentProjection = { ...rest, environment: egsUnit.environment };
      return out;
    },

    async loadDocumentXml(id) {
      const r = await prisma.zatcaDocument.findUnique({ where: { id }, select: { xmlGz: true, clearedXmlGz: true } });
      if (!r) return null;
      return { xml: gunzipXml(r.xmlGz), clearedXml: r.clearedXmlGz ? gunzipXml(r.clearedXmlGz) : null };
    },
  };
}
