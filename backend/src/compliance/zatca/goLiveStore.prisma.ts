// ============================================================================
// ZATCA المرحلة الثانية (Z5.8) — محوّل Prisma لمخزن التفعيل (يُفحص نوعياً؛ لا يتّصل بشيء عند الإنشاء)
// ----------------------------------------------------------------------------
// الاستيراد نوعيّ (import type) فلا يُحمَّل @prisma/client وقت التشغيل من هذا الملف، ولا يُكتب JSON null (بلا Prisma.JsonNull).
// كلّ دالّة استعلامٌ واحد (recordCutover اثنان عند وجود clientRef: فحصٌ ثم إدراج).
// ============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import type { CutoverRecordInput, CutoverStatus, RepSyncRow } from './goLive';
import { isCutoverStatus } from './goLive';
import type { CutoverResolvePatch, CutoverReviewRow, GoLiveStore } from './goLiveStore';

type PrismaLike = Pick<PrismaClient, 'companySettings' | 'salesRep' | 'zatcaCutoverReview'>;

type CutoverDbRow = {
  id: string;
  tenantId: string;
  clientRef: string | null;
  clientCreatedAt: Date | null;
  reason: string;
  status: string;
  payload: Prisma.JsonValue;
  salesRepId: string | null;
  customerId: string | null;
  amount: number | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  resultInvoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRow(r: CutoverDbRow): CutoverReviewRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    clientRef: r.clientRef,
    clientCreatedAt: r.clientCreatedAt,
    reason: r.reason,
    status: (isCutoverStatus(r.status) ? r.status : 'PENDING') as CutoverStatus,
    payload: r.payload as unknown,
    salesRepId: r.salesRepId,
    customerId: r.customerId,
    amount: r.amount,
    note: r.note,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    resultInvoiceId: r.resultInvoiceId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function prismaGoLiveStore(prisma: PrismaLike): GoLiveStore {
  return {
    async loadArmedAt(tenantId) {
      const s = await prisma.companySettings.findUnique({ where: { tenantId }, select: { zatcaGoLiveArmedAt: true } });
      return s?.zatcaGoLiveArmedAt ?? null;
    },
    async setArmedAtOnce(tenantId, at) {
      const r = await prisma.companySettings.updateMany({ where: { tenantId, zatcaGoLiveArmedAt: null }, data: { zatcaGoLiveArmedAt: at } });
      if (r.count === 1) return { applied: true, armedAt: at };
      const s = await prisma.companySettings.findUnique({ where: { tenantId }, select: { zatcaGoLiveArmedAt: true } });
      return { applied: false, armedAt: s?.zatcaGoLiveArmedAt ?? null };
    },
    async clearArmedAt(tenantId) {
      // CAS ذرّيّ: يُنزع التسليح فقط حين كان مُسلَّحاً ولم تُفعَّل الشركة حيّاً بعد (zatcaPhase2StartedAt NULL). حيّةٌ ⇒ count 0.
      const r = await prisma.companySettings.updateMany({
        where: { tenantId, zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: { not: null } },
        data: { zatcaGoLiveArmedAt: null },
      });
      return { applied: r.count === 1, armedAt: null };
    },
    async loadRepSync(tenantId) {
      const reps = await prisma.salesRep.findMany({
        where: { tenantId },
        select: { id: true, name: true, isActive: true, lastSeenAt: true, outboxPending: true, outboxTaxPending: true, outboxReportedAt: true },
      });
      return reps.map((r): RepSyncRow => ({
        id: r.id, name: r.name, isActive: r.isActive, lastSeenAt: r.lastSeenAt,
        outboxPending: r.outboxPending, outboxTaxPending: r.outboxTaxPending, outboxReportedAt: r.outboxReportedAt,
      }));
    },
    async recordCutover(input: CutoverRecordInput) {
      if (input.clientRef) {
        const existing = await prisma.zatcaCutoverReview.findFirst({ where: { tenantId: input.tenantId, clientRef: input.clientRef } });
        if (existing) return { created: false, row: toRow(existing as CutoverDbRow) };
      }
      const created = await prisma.zatcaCutoverReview.create({
        data: {
          tenantId: input.tenantId,
          clientRef: input.clientRef,
          clientCreatedAt: input.clientCreatedAt,
          reason: input.reason,
          status: 'PENDING',
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          salesRepId: input.salesRepId ?? null,
          customerId: input.customerId ?? null,
          amount: input.amount ?? null,
        },
      });
      return { created: true, row: toRow(created as CutoverDbRow) };
    },
    async listCutover(tenantId, filter = {}) {
      const rows = await prisma.zatcaCutoverReview.findMany({
        where: { tenantId, ...(filter.status ? { status: filter.status } : {}) },
        orderBy: { createdAt: 'desc' },
        ...(typeof filter.limit === 'number' ? { take: filter.limit } : {}),
      });
      return rows.map(r => toRow(r as CutoverDbRow));
    },
    async getCutover(tenantId, id) {
      const r = await prisma.zatcaCutoverReview.findFirst({ where: { tenantId, id } });
      return r ? toRow(r as CutoverDbRow) : null;
    },
    async findCutoverByClientRef(tenantId, clientRef) {
      const r = await prisma.zatcaCutoverReview.findFirst({ where: { tenantId, clientRef } });
      return r ? toRow(r as CutoverDbRow) : null;
    },
    async resolveCutover(tenantId, id, patch: CutoverResolvePatch) {
      // CAS من PENDING: updateMany لا يرمي إن لم يطابق (سبق حسمه أو غير موجود)
      const upd = await prisma.zatcaCutoverReview.updateMany({
        where: { tenantId, id, status: 'PENDING' },
        data: {
          status: patch.status,
          reviewedBy: patch.reviewedBy,
          reviewedAt: patch.reviewedAt,
          ...(patch.note !== undefined ? { note: patch.note } : {}),
          ...(patch.resultInvoiceId !== undefined ? { resultInvoiceId: patch.resultInvoiceId } : {}),
        },
      });
      const r = await prisma.zatcaCutoverReview.findFirst({ where: { tenantId, id } });
      if (!r) return null;
      return { applied: upd.count === 1, row: toRow(r as CutoverDbRow) };
    },
  };
}
