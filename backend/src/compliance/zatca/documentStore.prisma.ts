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
  type DocumentProjection, type LockedUnitRow, type OverdueDocument, type ZatcaDocumentStore,
} from './documentStore';
import { FINAL_DOCUMENT_STATUSES, type Flow } from './status';
import { NOT_RECEIVED_HTTP_STATUSES } from './void';

type Db = Pick<PrismaClient, '$queryRaw' | '$executeRaw' | 'zatcaDocument' | 'zatcaApiLog' | 'invoice'>;
export type DocumentStoreTx = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'zatcaDocument' | 'invoice'>;

const PROJECTION_SELECT = {
  id: true, egsUnitId: true, attemptNo: true, icv: true, uuid: true, pih: true, invoiceHash: true, typeCode: true, typeName: true,
  issueDate: true, issueTime: true, flow: true, qr: true, clearedQr: true, status: true, httpStatus: true, validation: true, attempts: true,
  sentAttempts: true, nextAttemptAt: true, leaseUntil: true, firstSubmitAt: true, finalizedAt: true, reportDeadline: true, keyVersion: true,
  createdAt: true, updatedAt: true,
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
        WHERE id = ${id}
          -- Z5.4 (مراجعة عدائية): فاتورةٌ أُلغيت لا يُرسل مستندها إلى الهيئة أبداً — حزامٌ ثانٍ تحت حارس المسار
          AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = zatca_documents."invoiceId" AND i.status = 'CANCELLED')
          AND (
          (status IN ('SIGNED', 'RETRY_WAIT') AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
            AND (${ignore}::boolean OR "nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW()))
          OR (status IN ('AUTH_BLOCKED', 'CONFIG_ERROR') AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
            AND "nextAttemptAt" IS NOT NULL AND "nextAttemptAt" <= NOW())
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
      // نقد 16: شركة موقوفة تُستبعد هنا لا بعد الاستيلاء. LEFT JOIN عمداً: شركة بلا صفّ إعدادات لا تُحرم من الإرسال
      const skipPaused = opts.excludePausedTenants !== false;
      // FOR UPDATE لا يجتمع مع دوالّ النوافذ في المستوى نفسه: القفل في candidates، والعدل (row_number لكل وحدة) خارجه
      const rows = await prisma.$queryRaw<ClaimedRaw[]>`
        WITH candidates AS (
          SELECT d.id, d."egsUnitId", d.icv, d."reportDeadline", d."createdAt"
          FROM zatca_documents d
          JOIN zatca_egs_units u ON u.id = d."egsUnitId"
          LEFT JOIN company_settings cs ON cs."tenantId" = d."tenantId"
          WHERE u.status = ANY(${statuses}::text[])
            AND (NOT ${skipPaused}::boolean OR cs."zatcaSubmitPausedAt" IS NULL)
            -- Z5.4 (مراجعة عدائية): فاتورةٌ أُلغيت لا يُرسل مستندها أبداً (حزامٌ ثانٍ تحت حارس مسار الإلغاء)
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = d."invoiceId" AND i.status = 'CANCELLED')
            AND (
              (d.status IN ('SIGNED', 'RETRY_WAIT') AND (d."leaseUntil" IS NULL OR d."leaseUntil" < NOW())
                AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW()))
              -- الحجب المؤقّت (Z5.3، مراجعة عدائية): موعدٌ صريح شرطٌ — بلا موعد لا يُستولى عليه أبداً
              OR (d.status IN ('AUTH_BLOCKED', 'CONFIG_ERROR') AND (d."leaseUntil" IS NULL OR d."leaseUntil" < NOW())
                AND d."nextAttemptAt" IS NOT NULL AND d."nextAttemptAt" <= NOW())
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
          einvoiceStatus: mirror.einvoiceStatus, einvoiceWarnings: mirror.einvoiceWarnings,
          ...(mirror.einvoiceQr !== undefined ? { einvoiceQr: mirror.einvoiceQr } : {}),
          ...(mirror.einvoiceSubmittedAt !== undefined ? { einvoiceSubmittedAt: mirror.einvoiceSubmittedAt } : {}),
        },
      });
      return r.count === 1;
    },

    async requeueForRetry(id, fromStatuses, at) {
      if (fromStatuses.length === 0) return false;
      const r = await prisma.zatcaDocument.updateMany({
        where: { id, status: { in: [...fromStatuses] } },
        data: { status: 'RETRY_WAIT', nextAttemptAt: at, leaseUntil: null },
      });
      return r.count === 1;
    },

    async listOverdue(q) {
      const limit = Math.max(0, Math.trunc(q.limit));
      if (limit === 0) return [];
      // reportDeadline قابل للإفراغ: مقارنة lte تُسقط NULL من تلقائها (مستندات الاعتماد بلا مهلة) — لا مرشّح not هنا.
      // status وoverdueAlertLevel غير قابلين للإفراغ فـnotIn/lt عليهما آمنان.
      const rows = await prisma.zatcaDocument.findMany({
        where: {
          reportDeadline: { lte: new Date(q.now.getTime() + Math.max(0, q.withinMs)) },
          status: { notIn: [...FINAL_DOCUMENT_STATUSES] },
          overdueAlertLevel: { lt: Math.trunc(q.maxLevel) },
        },
        orderBy: [{ reportDeadline: 'asc' }, { icv: 'asc' }],
        take: limit,
        select: {
          id: true, tenantId: true, egsUnitId: true, invoiceId: true, status: true, flow: true, typeName: true, icv: true,
          reportDeadline: true, overdueAlertLevel: true,
        },
      });
      const out: OverdueDocument[] = [];
      for (const r of rows) {
        if (!r.reportDeadline) continue;
        out.push({ ...r, flow: r.flow as Flow, reportDeadline: r.reportDeadline });
      }
      return out;
    },

    async bumpOverdueAlertLevel(id, fromLevel, toLevel) {
      if (!(toLevel > fromLevel)) return false;
      const r = await prisma.zatcaDocument.updateMany({
        where: { id, overdueAlertLevel: fromLevel },
        data: { overdueAlertLevel: toLevel },
      });
      return r.count === 1;
    },

    async casDocumentStatus(tx, i) {
      if (i.fromStatuses.length === 0) return false;
      const db = tx ?? prisma;
      // شرط العقد داخل الجملة نفسها (NOW() ساعة القاعدة): مستندٌ يرسله عاملٌ حيّ لا يُسحب من تحته.
      // والتسييج بـattempts (Z5.4، مراجعة عدائية): عاملٌ استولى عليه بين قراءة الإسقاط وهذه الجملة رفع العدّاد فيسقط
      // التحويل — فلا يُسحب مستندٌ أُرسلت بايتاته بعد القرار. القيمة undefined ⇒ بلا تسييج (استعمالات أخرى).
      const fenced = i.attempts ?? null;
      const n = await db.$executeRaw`
        UPDATE zatca_documents SET status = ${i.toStatus}, "leaseUntil" = NULL, "nextAttemptAt" = NULL,
          "finalizedAt" = ${i.at}, "updatedAt" = ${i.at}
        WHERE id = ${i.id} AND status = ANY(${[...i.fromStatuses]}::text[])
          AND (${fenced}::int IS NULL OR attempts = ${fenced}::int)
          AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())`;
      return n === 1;
    },

    async countPossiblyDeliveredAttempts(documentId) {
      // فخّ NULL: notIn وحده يُسقط الصفوف التي حالتها NULL (انقطاع شبكة أو مهلة) — وهي أخطرها، فتُذكر صراحةً
      return prisma.zatcaApiLog.count({
        where: {
          documentId,
          OR: [{ httpStatus: null }, { httpStatus: { notIn: [...NOT_RECEIVED_HTTP_STATUSES] } }],
        },
      });
    },

    async countAttemptLogs(documentId) {
      return prisma.zatcaApiLog.count({ where: { documentId } });
    },

    async markDispatched(id) {
      // جملة واحدة بالمفتاح الأساسي قبل نداء الهيئة مباشرةً: أثرٌ دائم يقول «بايتات غادرت» ولو مات العامل بعدها
      const n = await prisma.$executeRaw`
        UPDATE zatca_documents SET "sentAttempts" = "sentAttempts" + 1, "updatedAt" = NOW() WHERE id = ${id}`;
      return n === 1;
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
