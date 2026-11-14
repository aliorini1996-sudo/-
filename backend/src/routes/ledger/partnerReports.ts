import crypto from 'node:crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import prisma from '../../config/database';
import { requireLedgerPermission } from '../../middleware/auth';
import { ledgerExportLimiter } from '../../middleware/rateLimits';
import { LedgerLocals } from './context';
import { LedgerHttpError, ledgerHandler } from './errors';
import { appendAudit, canonicalJson, ledgerActor } from '../../services/gl/audit';
import { fiscalYearStart, isLocalDate, todayLocal } from '../../services/gl/dates';
import { makePeriod } from '../../services/gl/reports/period';
import {
  PARTNER_TYPES, buildPartnerLedger, normalizePartnerPage, normalizePartnerPageSize, serializePartnerLedger,
  type PartnerType,
} from '../../services/gl/reports/partnerLedger';
import { AGING_BASES, buildAging, parseAgingBuckets, serializeAging, type AgingBasis } from '../../services/gl/reports/aging';
import { buildLateArrivals, serializeLateArrivals } from '../../services/gl/reports/lateArrivals';
import { buildProductLedger, serializeProductLedger } from '../../services/gl/reports/productLedger';
import {
  PARTNER_SEARCH_TYPES, loadAgingItems, loadLateArrivalMoves, loadPartnerLedger, loadPartnerNames,
  loadPartnerReportSettings, loadProductLedgerLines, searchPartners,
  type PartnerDb, type PartnerReportSettings,
} from '../../services/gl/reports/partnerLoad.prisma';
import {
  REPORT_EXPORT_CAPS, assertExportUnderCap, buildReportWarnings, countReportWarningFacts,
  type ExportFormat, type ReportWarning,
} from './reports';

/**
 * «ربط الدفاتر» L8 — تقارير الشركاء من الدفاتر (عقد §6.2): دفتر أستاذ الشريك، وأعمار الذمم المدينة والدائنة، والمستندات
 * التي وصلت متأخرة، وتقرير الأصناف، ومنتقي الشريك. كلها قراءة بـcanViewLedger، ومُركَّبة **قبل** `reportsRouter` فتخدم
 * مفاتيحها قبل أن يبلغها «التقرير يُتاح مع مرحلته».
 *
 * لكل مفتاح `GET /reports/<key>` و`POST /reports/<key>/export {format:'xlsx'|'pdf', …}` بنمط التصدير القائم: البيانات كاملة
 * بلا ترقيم، وسقوف `REPORT_EXPORT_CAPS` (فوقها 422 `LEDGER_EXPORT_TOO_LARGE`)، وصفّ تدقيق `EXPORT`. الخادم لا يبني ملفاً.
 *
 * **المبالغ أرقام بوحدة العملة** (عقد L4/L5/L8 القاعدة 5)، والحساب كله ملّي BigInt في الوحدات الصرفة؛ لا BigInt في الردّ.
 * لا مزامنة تلقائية: تنبيه RPT‑08 بعدّين رخيصين كالقوائم.
 */
const router = Router();
const VIEW = requireLedgerPermission('canViewLedger');
const locals = (res: Response) => res.locals.ledger as LedgerLocals;

export const PARTNER_REPORT_KEYS = ['partner-ledger', 'aged-receivable', 'aged-payable', 'late-arrivals', 'product-ledger'] as const;
export type PartnerReportKey = (typeof PARTNER_REPORT_KEYS)[number];

export const RECONCILE_NOT_ACTIVE_MESSAGE =
  'المطابقة الآلية بين الفواتير والسندات تعمل في الدفاتر المربوطة وحدها: البنود غير المطابَقة تظهر مفتوحة بتواريخها';
export const PARTNER_NOT_FOUND_MESSAGE = 'الشريك غير موجود في هذه الشركة';

// ═══ الاستعلام (zod) ═══

const boolish = z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]);
const intish = z.union([z.number(), z.string().regex(/^\d{1,6}$/)]);
const dateish = z.string().refine(isLocalDate, { message: 'تاريخ غير صالح' });
const idish = z.string().trim().min(1).max(64);
const formatShape = { format: z.enum(['xlsx', 'pdf']) };

export const partnerLedgerQuerySchema = z.object({
  partnerType: z.enum(PARTNER_TYPES),
  partnerId: idish,
  from: dateish.optional(),
  to: dateish.optional(),
  includeReconciled: boolish.optional(),
  page: intish.optional(),
  pageSize: intish.optional(),
});
export const agingQuerySchema = z.object({
  asOf: dateish.optional(),
  basis: z.enum(AGING_BASES).optional(),
  buckets: z.string().max(40).optional(),
  partnerId: idish.optional(),
});
export const rangeQuerySchema = z.object({ from: dateish.optional(), to: dateish.optional() });
export const productLedgerQuerySchema = z.object({
  from: dateish.optional(),
  to: dateish.optional(),
  productId: idish.optional(),
  customerId: idish.optional(),
  salesRepId: idish.optional(),
});
export const partnerSearchQuerySchema = z.object({ type: z.enum(PARTNER_SEARCH_TYPES), q: z.string().max(100).optional() });

const asBool = (v: boolean | string | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : v === true || v === 'true' || v === '1';
const asInt = (v: number | string | undefined): number | undefined => (v === undefined ? undefined : Math.trunc(Number(v)));

/** الفترة الافتراضية: من بداية السنة المالية لتاريخ النهاية حتى اليوم بتوقيت الشركة. `to` قبل `from` ⇒ 400. صرفة. */
export function resolvePartnerRange(
  q: { from?: string; to?: string }, s: Pick<PartnerReportSettings, 'fiscalYearEndMonth' | 'fiscalYearEndDay'>, today: string,
): { from: string; to: string } {
  const to = q.to ?? today;
  const from = q.from ?? fiscalYearStart(to, s.fiscalYearEndMonth, s.fiscalYearEndDay);
  if (to < from) throw new LedgerHttpError(400, 'تاريخ النهاية يسبق تاريخ البداية', { reason: 'INVALID_RANGE', from, to });
  return { from, to };
}

// ═══ البناء (مشترك بين العرض والتصدير) ═══

interface Built {
  data: Record<string, unknown>;
  /** عدد السطور الذي تُقاس عليه سقوف التصدير */
  lineCount: number;
  from: string | null;
  to: string;
}

async function rpt08(db: PartnerDb, tenantId: string, s: PartnerReportSettings, from: string, to: string): Promise<ReportWarning[]> {
  const facts = await countReportWarningFacts(db, tenantId, makePeriod(from, to, { endMonth: s.fiscalYearEndMonth, endDay: s.fiscalYearEndDay }), s.timezone, { filtered: false });
  return buildReportWarnings(facts);
}

const reconcileWarning = (s: PartnerReportSettings): ReportWarning[] =>
  s.linked ? [] : [{ code: 'RECONCILE_NOT_ACTIVE', message: RECONCILE_NOT_ACTIVE_MESSAGE }];

const settingsJson = (s: PartnerReportSettings) => ({ currency: s.currency, currencyDecimals: s.currencyDecimals, timezone: s.timezone, linked: s.linked });

async function buildPartnerLedgerReport(tenantId: string, raw: unknown, forExport: boolean): Promise<Built> {
  const q = partnerLedgerQuerySchema.parse(raw ?? {});
  const s = await loadPartnerReportSettings(prisma, tenantId);
  const { from, to } = resolvePartnerRange(q, s, todayLocal(new Date(), s.timezone));
  const includeReconciled = asBool(q.includeReconciled, true);
  const loaded = await loadPartnerLedger(prisma, tenantId, s, {
    type: q.partnerType as PartnerType, partnerId: q.partnerId, from, to, includeReconciled,
    page: normalizePartnerPage(asInt(q.page)), pageSize: forExport ? null : normalizePartnerPageSize(asInt(q.pageSize)),
  });
  if (!loaded.found) throw new LedgerHttpError(404, PARTNER_NOT_FOUND_MESSAGE, { reason: 'PARTNER_NOT_FOUND', partnerType: q.partnerType, partnerId: q.partnerId });
  const isAr = q.partnerType === 'customer' || q.partnerType === 'vendor';
  const warnings = [...await rpt08(prisma, tenantId, s, from, to), ...(isAr ? reconcileWarning(s) : [])];
  return {
    data: { reportKey: 'partner-ledger', settings: settingsJson(s), ...serializePartnerLedger(loaded.ledger, loaded.extras), warnings },
    // صفّا الافتتاح والختام مع السطور
    lineCount: loaded.ledger.lineCount + 2,
    from,
    to,
  };
}

async function buildAgingReport(tenantId: string, raw: unknown, kind: 'AR' | 'AP'): Promise<Built> {
  const q = agingQuerySchema.parse(raw ?? {});
  const buckets = parseAgingBuckets(q.buckets);
  if (!buckets) {
    throw new LedgerHttpError(400, 'أعمدة الأعمار أربعة أعداد صحيحة موجبة متزايدة مثل 30,60,90,120', { reason: 'INVALID_BUCKETS', buckets: q.buckets ?? null });
  }
  const s = await loadPartnerReportSettings(prisma, tenantId);
  const asOf = q.asOf ?? todayLocal(new Date(), s.timezone);
  const basis = (q.basis ?? 'due') as AgingBasis;
  const items = await loadAgingItems(prisma, tenantId, { kind, asOf, partnerId: q.partnerId ?? null });
  const type: PartnerType = kind === 'AR' ? 'customer' : 'vendor';
  const names = await loadPartnerNames(prisma, tenantId, type, items.map((i) => i.partnerId));
  const report = buildAging({ kind, asOf, basis, buckets, items, names, detail: !!q.partnerId });
  const fyStart = fiscalYearStart(asOf, s.fiscalYearEndMonth, s.fiscalYearEndDay);
  const warnings = [...await rpt08(prisma, tenantId, s, fyStart, asOf), ...reconcileWarning(s)];
  return {
    data: {
      reportKey: kind === 'AR' ? 'aged-receivable' : 'aged-payable', settings: settingsJson(s),
      partnerId: q.partnerId ?? null, ...serializeAging(report), warnings,
    },
    lineCount: report.rows.length + (report.detail?.length ?? 0) + 1,
    from: null,
    to: asOf,
  };
}

async function buildLateArrivalsReport(tenantId: string, raw: unknown): Promise<Built> {
  const q = rangeQuerySchema.parse(raw ?? {});
  const s = await loadPartnerReportSettings(prisma, tenantId);
  const { from, to } = resolvePartnerRange(q, s, todayLocal(new Date(), s.timezone));
  const moves = await loadLateArrivalMoves(prisma, tenantId, from, to);
  const built = buildLateArrivals(moves, { cutoverDate: s.cutoverDate });
  return {
    data: { reportKey: 'late-arrivals', settings: settingsJson(s), from, to, cutoverDate: s.cutoverDate, ...serializeLateArrivals(built), warnings: [] },
    lineCount: built.count + 1,
    from,
    to,
  };
}

async function buildProductLedgerReport(tenantId: string, raw: unknown): Promise<Built> {
  const q = productLedgerQuerySchema.parse(raw ?? {});
  const s = await loadPartnerReportSettings(prisma, tenantId);
  const { from, to } = resolvePartnerRange(q, s, todayLocal(new Date(), s.timezone));
  const loaded = await loadProductLedgerLines(prisma, tenantId, {
    from, to, productId: q.productId ?? null, customerId: q.customerId ?? null, salesRepId: q.salesRepId ?? null,
  });
  const report = buildProductLedger(loaded);
  // الإيراد لكل صنف يُرحَّل للدفاتر المربوطة وحدها (L4 ج)؛ غيرها بلا سطور أصناف
  const warnings: ReportWarning[] = [
    ...await rpt08(prisma, tenantId, s, from, to),
    ...(s.linked ? [] : [{ code: 'PRODUCT_LINES_LINKED_ONLY', message: 'الإيراد لكل صنف يُرحَّل في الدفاتر المربوطة وحدها' }]),
  ];
  return {
    data: {
      reportKey: 'product-ledger', settings: settingsJson(s), from, to,
      filters: { productId: q.productId ?? null, customerId: q.customerId ?? null, salesRepId: q.salesRepId ?? null },
      ...serializeProductLedger(report), warnings,
    },
    lineCount: report.rows.length + 1,
    from,
    to,
  };
}

export const PARTNER_REPORT_BUILDERS: Readonly<Record<PartnerReportKey, (tenantId: string, raw: unknown, forExport: boolean) => Promise<Built>>> = {
  'partner-ledger': buildPartnerLedgerReport,
  'aged-receivable': (t, raw) => buildAgingReport(t, raw, 'AR'),
  'aged-payable': (t, raw) => buildAgingReport(t, raw, 'AP'),
  'late-arrivals': (t, raw) => buildLateArrivalsReport(t, raw),
  'product-ledger': (t, raw) => buildProductLedgerReport(t, raw),
};

/** بصمة الخيارات في صفّ التدقيق (كتصدير القوائم) */
export function partnerReportOptionsHash(key: string, body: Record<string, unknown>): string {
  const { format: _format, ...rest } = body;
  return crypto.createHash('sha256').update(canonicalJson({ key, ...rest })).digest('hex').slice(0, 16);
}

// ═══ النقاط ═══

for (const key of PARTNER_REPORT_KEYS) {
  router.get(`/reports/${key}`, VIEW, ledgerHandler(async (req, res) => {
    const built = await PARTNER_REPORT_BUILDERS[key](locals(res).tenantId, req.query, false);
    res.json({ success: true, data: built.data });
  }));

  router.post(`/reports/${key}/export`, VIEW, ledgerExportLimiter, ledgerHandler(async (req, res) => {
    const l = locals(res);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { format } = z.object(formatShape).parse(body);
    const built = await PARTNER_REPORT_BUILDERS[key](l.tenantId, body, true);
    assertExportUnderCap(format as ExportFormat, built.lineCount);
    const actor = ledgerActor(l, { actorName: req.user?.name ?? null, requestIp: req.ip ?? null });
    await prisma.$transaction((tx) => appendAudit(tx, {
      tenantId: l.tenantId,
      actor,
      action: 'EXPORT',
      entityType: 'REPORT',
      entityId: key,
      summary: `تصدير تقرير ${key} بصيغة ${format} (${built.lineCount} سطر)`,
      after: {
        reportKey: key, format, from: built.from, to: built.to, optionsHash: partnerReportOptionsHash(key, body),
        lineCount: built.lineCount, impersonated: l.impersonated === true,
      },
    }));
    res.json({ success: true, data: { ...built.data, format, cap: REPORT_EXPORT_CAPS[format as ExportFormat], paginated: false, lineCount: built.lineCount } });
  }));
}

router.get('/partners/search', VIEW, ledgerHandler(async (req, res) => {
  const q = partnerSearchQuerySchema.parse(req.query ?? {});
  const items = await searchPartners(prisma, locals(res).tenantId, q.type, q.q ?? '');
  res.json({ success: true, data: { type: q.type, items } });
}));

export default router;
export { buildPartnerLedger };
