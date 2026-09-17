// ============================================================================
// فوترة ZATCA المرحلة الثانية (Z5.1a، D2) — بيانات المشتري في مسارات العملاء (/api/customers)
// ----------------------------------------------------------------------------
// z5_plan §3 Z5.1a + نقد الخطة (5، 21، 22) + قرارا المالك Q2/Q3. اعتماديات مُحقنة (قاعدة، نطاق العملاء) فتختبرها
// tests/customer-buyer-data.test.ts بقاعدة مزيّفة بلا شبكة؛ الربط الإنتاجي في routes/customers.ts.
//
//   • البوابة «تجمع الشركة بيانات الفوترة» = (علم المالك || التفعيل الحيّ) && الدولة SA — zatcaCollectOn (نقد الخطة 5): إطفاء
//     العلم بعد التفعيل لا يُسقط الحقول ولا القائمة. استعلام واحد عبر Tenant.settings، ولا يُقرأ إلا حين يحمل جسم الكتابة حقلاً
//     من حقول المشتري أو الرقم الضريبي/السجل التجاري.
//   • غير الجامعة: كما اليوم حرفياً — مخطّط zod لم يتغيّر فحقول المرحلة الثانية تُسقط كما كانت، ولا تطبيع ولا فحص صيغة، والردّ
//     نفسه بلا مفاتيح جديدة؛ ونقاط القائمة ونقطة المندوب الضيّقة 404.
//   • الجامعة: تطبيع وفحص للمتغيّر وحده (compliance/zatca/buyerData.ts)؛ الخطأ 400 CUSTOMER_ZATCA_INVALID — إلا الرفع المؤجَّل
//     من الصفّ (POST بـclientRef): لا 400 أبداً (كي لا يُرفض العميل فتسقط فواتيره خلفه)، تُسقط حقول المرحلة الثانية الخاطئة
//     ويُعاد warnings. النقص لا يمنع شيئاً قبل التفعيل.
//   • المندوب يُكمل ولا يُخفّض (نقد الخطة 21): نقل عميل من ضريبية (01) إلى مبسطة (02) للإدارة وحدها وبسطر تدقيق؛ ونقطة المندوب
//     الضيّقة PATCH /:id/buyer-data (Q3) لمن يصدر الفواتير — حقول الفوترة وحدها، بلا مسح محفوظ، ولا مال ولا موقع ولا إسناد؛
//     والمندوب بلا صلاحية تعديل العملاء يُكمل الفارغ من حقول Q3 وحدها (نوع العميل والمعرّف والعنوان الوطني والدولة).
//   • القائمة: مرشّحات جديدة تُدمج في مصفوفة AND واحدة مع نطاق العملاء (نقد الخطة 22) — لا مفتاح أعلى يطغى على النطاق.
// ============================================================================

import { NextFunction, Response, Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { AuthRequest } from '../types';
import { zatcaCollectOn } from '../compliance/zatca/regime';
import { ZATCA_ERROR_CATALOGUE } from '../compliance/zatca/errors';
import {
  BUSINESS_CHANNELS, BUSINESS_ID_SCHEMES, BUYER_BILLING_FIELDS, BUYER_PHASE2_FIELDS, BuyerField, BuyerFieldError, BuyerPatch, BuyerRowLike,
  BuyerStatus, CUSTOMER_FIELD_MAP, bodyTouchesBuyerGate, buyerDowngrade, clearedBuyerFields, customerBuyerStatus, missingBuyerFormFields,
  normalizeBuyerFields, repCompleteOnlyDenied, validateBuyerChanges,
} from '../compliance/zatca/buyerData';

export type BuyerDataDb = Pick<PrismaClient, 'tenant' | 'customer' | 'salesRep' | 'product'>;

export interface CustomerBuyerDataDeps {
  db: BuyerDataDb;
  /** قيد رؤية العملاء للطالب (الإنتاج: services/customerScope.customerScope). */
  customerScope: (req: AuthRequest, tid: string) => Promise<Record<string, unknown>>;
  /** (الإنتاج: services/customerScope.canAccessCustomer — المفتاحان معاً). */
  canAccessCustomer: (req: AuthRequest, tid: string, customerId: string) => Promise<boolean>;
  tenantId: (req: AuthRequest) => string;
  /** سطر تدقيق (JSON) لتخفيض تصنيف عميل بيد الإدارة — افتراضياً console.warn. */
  audit?: (line: string) => void;
}

export const BUYER_DATA_CODES = Object.freeze({
  ZATCA_BUYER_DATA_NOT_ENABLED: 'بيانات الفوترة الإلكترونية للعملاء غير مفعّلة لشركتك',
  CUSTOMER_ZATCA_INVALID: ZATCA_ERROR_CATALOGUE.CUSTOMER_ZATCA_INVALID.messageAr,
  CUSTOMER_BUYER_DATA_FORBIDDEN: 'إكمال بيانات الفوترة للعميل يحتاج صلاحية إصدار الفواتير أو تعديل العملاء',
  CUSTOMER_BUYER_REP_RESTRICTED: 'يمكنك إكمال بيانات الفوترة فقط — مسحها أو تحويل العميل من منشأة إلى فرد للإدارة',
  /** رسالة CUSTOMER_BUYER_REP_RESTRICTED للمندوب بلا صلاحية تعديل العملاء (Q3). */
  CUSTOMER_BUYER_REP_COMPLETE_ONLY: 'يمكنك إكمال بيانات الفوترة الناقصة فقط (نوع العميل والمعرّف والعنوان الوطني) — تعديل المحفوظ واسم المنشأة والرقم الضريبي والسجل التجاري للإدارة',
  CUSTOMER_NOT_FOUND: 'العميل غير موجود',
  FORBIDDEN: 'غير مسموح',
});

export const BUYER_DOWNGRADE_AUDIT_EVENT = 'ZATCA_BUYER_DOWNGRADE';
const COMPANY_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** أعمدة الفوترة التي تُقرأ للفحص والقائمة (~19 عموداً، بلا مال ولا موقع). */
export const BUYER_ROW_SELECT = Object.freeze({
  id: true, code: true, name: true, businessName: true, phone: true, city: true, district: true, channel: true, status: true,
  taxNumber: true, commercialReg: true, buyerType: true, buyerIdScheme: true, buyerIdValue: true, addrStreet: true, addrBuildingNo: true,
  addrAdditionalNo: true, addrPostalCode: true, countryCode: true,
} as const);

type BuyerRow = BuyerRowLike & { id: string; code?: string | null; phone?: string | null; status?: string | null };

// ─── البوابة ───

/** هل تجمع الشركة بيانات الفوترة؟ استعلام واحد (Tenant + settings). */
export async function loadBuyerCollect(db: Pick<PrismaClient, 'tenant'>, tid: string): Promise<boolean> {
  const t = await db.tenant.findUnique({
    where: { id: tid },
    select: { zatcaPhase2Enabled: true, settings: { select: { countryCode: true, zatcaPhase2StartedAt: true } } },
  });
  return zatcaCollectOn({ tenantFlag: t?.zatcaPhase2Enabled, settings: t?.settings ?? null });
}

export function customerZatcaInvalidBody(errors: readonly BuyerFieldError[]): Record<string, unknown> {
  const list = [...new Set(errors.map(e => e.messageAr))].slice(0, 6).join('؛ ');
  return {
    success: false, code: 'CUSTOMER_ZATCA_INVALID',
    message: list ? `${BUYER_DATA_CODES.CUSTOMER_ZATCA_INVALID}: ${list}` : BUYER_DATA_CODES.CUSTOMER_ZATCA_INVALID,
    fieldErrors: errors,
  };
}

const auditId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 128) : null);

export function buyerDowngradeAuditLine(f: { tenantId: string; customerId: string; actorId: string; role: string; impersonated: boolean; fields: readonly string[]; route: string }): string {
  return JSON.stringify({
    event: BUYER_DOWNGRADE_AUDIT_EVENT,
    tenantId: auditId(f.tenantId),
    customerId: auditId(f.customerId),
    actorId: auditId(f.actorId),
    role: auditId(f.role),
    impersonated: f.impersonated === true,
    fields: f.fields.filter(x => (BUYER_BILLING_FIELDS as readonly string[]).includes(x)),
    route: f.route,
  });
}

const defaultAudit = (line: string) => console.warn(line);

export type BuyerGateResult =
  | { ok: true; warnings: BuyerFieldError[] | null }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * POST/PUT /api/customers: يُستدعى من داخل المعالج بعد تحليل zod (وبعد فحص الوجود للتعديل) وقبل الكتابة. يضيف الحقول المطبَّعة
 * إلى data للشركة الجامعة وحدها. customerId = null للإنشاء. replay = إنشاء بـclientRef (رفع مؤجَّل من الصفّ أو إرسال مباشر
 * يحمل مفتاح التكرار) — لا يُرفض.
 */
export async function applyBuyerGateToWrite(
  deps: CustomerBuyerDataDeps, req: AuthRequest, tid: string, data: Record<string, unknown>, opts: { customerId: string | null; replay: boolean },
): Promise<BuyerGateResult> {
  if (!bodyTouchesBuyerGate(req.body)) return { ok: true, warnings: null };
  if (!(await loadBuyerCollect(deps.db, tid))) return { ok: true, warnings: null };

  const stored = opts.customerId
    ? ((await deps.db.customer.findFirst({ where: { id: opts.customerId, tenantId: tid }, select: BUYER_ROW_SELECT })) as BuyerRow | null)
    : null;
  const { patch, errors: typeErrors } = normalizeBuyerFields(req.body);
  const v = validateBuyerChanges(patch, stored);
  const errors = [...typeErrors, ...v.errors];

  const isRep = req.user?.role === 'SALES_REP';
  if (stored && isRep && buyerDowngrade(stored, patch)) {
    return { ok: false, status: 403, body: { success: false, code: 'CUSTOMER_BUYER_REP_RESTRICTED', message: BUYER_DATA_CODES.CUSTOMER_BUYER_REP_RESTRICTED } };
  }
  let warnings = [...v.warnings];
  if (errors.length > 0) {
    if (!(opts.customerId === null && opts.replay)) return { ok: false, status: 400, body: customerZatcaInvalidBody(errors) };
    // الرفع المؤجَّل: حقول المرحلة الثانية الخاطئة تُسقط (لم تكن تُحفظ قبل Z5.1a أصلاً)، والقديمة (الرقم الضريبي والسجل والنصوص)
    // تُحفظ كما كانت تُحفظ اليوم بلا فحص — والقائمة تُظهرها ناقصة. والتحذير يعود للجهاز
    for (const e of errors) {
      if ((BUYER_PHASE2_FIELDS as readonly string[]).includes(e.field)) delete patch[e.field];
    }
    for (const e of typeErrors) delete patch[e.field];
    warnings = [...errors, ...warnings];
  }
  if (stored && !isRep && buyerDowngrade(stored, patch)) {
    (deps.audit ?? defaultAudit)(buyerDowngradeAuditLine({
      tenantId: tid, customerId: stored.id, actorId: req.user?.id ?? '', role: req.user?.role ?? '', impersonated: req.user?.impersonated === true,
      fields: v.changed.filter(f => f === 'buyerType' || f === 'taxNumber' || f === 'commercialReg'), route: 'PUT /customers/:id',
    }));
  }
  Object.assign(data, patch);
  return { ok: true, warnings: warnings.length > 0 ? warnings : null };
}

// ─── القائمة ───

export type BuyerListBucket = 'incomplete' | 'unclassified' | 'complete' | 'all';
export type BuyerListStatus = 'ACTIVE' | 'INACTIVE' | 'BLOCKED' | 'ALL';

/** مرشّح مسبق في القاعدة: منشأة/حكومية صريحة، أو غير مصنّف له مؤشر (رقم ضريبي، سجل، معرّف منشأة بقيمته، قناة تجارية، اسم منشأة). */
export const BUYER_LIST_PREFILTER = Object.freeze({
  OR: [
    { buyerType: { in: ['BUSINESS', 'GOVERNMENT'] } },
    {
      buyerType: null,
      OR: [
        { taxNumber: { not: null } }, { commercialReg: { not: null } }, { buyerIdScheme: { in: [...BUSINESS_ID_SCHEMES] }, buyerIdValue: { not: null } },
        { channel: { in: [...BUSINESS_CHANNELS] } }, { businessName: { not: null } },
      ],
    },
  ],
});

/** where القائمة: كل شرط عنصر في مصفوفة AND واحدة (النطاق لا يُطغى عليه، والبحث لا يُطغى عليه — نقد الخطة 22). */
export function buyerListWhere(o: { tid: string; scope: Record<string, unknown>; status: BuyerListStatus; search: string; repId: string | null }): Record<string, unknown> {
  const and: Record<string, unknown>[] = [BUYER_LIST_PREFILTER as unknown as Record<string, unknown>];
  if (Object.keys(o.scope).length > 0) and.push(o.scope);
  if (o.status !== 'ALL') and.push({ status: o.status });
  if (o.search) {
    and.push({ OR: [{ name: { contains: o.search } }, { businessName: { contains: o.search } }, { phone: { contains: o.search } }, { code: { contains: o.search } }] });
  }
  if (o.repId) and.push({ assignments: { some: { salesRepId: o.repId } } });
  return { tenantId: o.tid, AND: and };
}

export interface BuyerListSummary {
  effectiveB2b: number;
  complete: number;
  incomplete: number;
  unclassifiedWithSignals: number;
  scanned: number;
  truncated: boolean;
}

export function bucketMatches(bucket: BuyerListBucket, st: BuyerStatus): boolean {
  if (st.bucket === null) return false;
  return bucket === 'all' || st.bucket === bucket;
}

export function buyerRowView(r: BuyerRow, st: BuyerStatus): Record<string, unknown> {
  return {
    ...r,
    classification: st.classification,
    subtypeIfIssuedNow: st.subtypeIfIssuedNow,
    complete: st.complete,
    bucket: st.bucket,
    suggestedType: st.explicitType ? null : st.suggestedType,
    suggestionSource: st.explicitType ? null : st.suggestionSource,
    missingFields: missingBuyerFormFields(st),
    issues: st.issues.map(i => ({ ...i, formField: CUSTOMER_FIELD_MAP[i.field] ?? null })),
  };
}

export interface BuyerListLimits { chunk: number; defaultLimit: number; maxLimit: number; pageScanBudget: number; summaryScanMax: number }
export const BUYER_LIST_LIMITS: Readonly<BuyerListLimits> = Object.freeze({ chunk: 500, defaultLimit: 50, maxLimit: 200, pageScanBudget: 5000, summaryScanMax: 20000 });

export interface BuyerScanResult {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
  summary: BuyerListSummary | null;
}

/** مسح بالمؤشّر (select محدود، دفعات) — الملخّص يمسح الكل حتى الحدّ، والصفحة تتوقّف عند امتلائها. */
export async function scanBuyerData(
  db: Pick<PrismaClient, 'customer'>, where: Record<string, unknown>,
  o: { bucket: BuyerListBucket; limit: number; cursor: string | null; withSummary: boolean },
  limits: Readonly<BuyerListLimits> = BUYER_LIST_LIMITS,
): Promise<BuyerScanResult> {
  const rows: Record<string, unknown>[] = [];
  const summary: BuyerListSummary | null = o.withSummary
    ? { effectiveB2b: 0, complete: 0, incomplete: 0, unclassifiedWithSignals: 0, scanned: 0, truncated: false } : null;
  let after = o.cursor;
  let scanned = 0;
  let filledAt: string | null = null;
  let lastScanned: string | null = null;
  let exhausted = false;
  const budget = o.withSummary ? limits.summaryScanMax : limits.pageScanBudget;
  scan: for (;;) {
    const batch = (await db.customer.findMany({
      where,
      select: BUYER_ROW_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limits.chunk,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    })) as BuyerRow[];
    for (const r of batch) {
      scanned++;
      lastScanned = r.id;
      const st = customerBuyerStatus(r);
      if (summary) {
        if (st.subtypeIfIssuedNow === '01') summary.effectiveB2b++;
        if (st.bucket === 'complete') summary.complete++;
        else if (st.bucket === 'incomplete') summary.incomplete++;
        else if (st.bucket === 'unclassified') summary.unclassifiedWithSignals++;
      }
      if (filledAt === null && o.limit > 0 && bucketMatches(o.bucket, st)) {
        rows.push(buyerRowView(r, st));
        if (rows.length >= o.limit) filledAt = r.id;
      }
      // الصفحة امتلأت ولا ملخّص ⇒ توقّف؛ أو نفد حدّ المسح
      if ((!summary && filledAt !== null) || scanned >= budget) break scan;
    }
    if (batch.length < limits.chunk) { exhausted = true; break; }
    after = lastScanned;
  }
  if (summary) {
    summary.scanned = scanned;
    summary.truncated = !exhausted;
  }
  const nextCursor = filledAt ?? (exhausted || o.limit === 0 ? null : lastScanned);
  return { rows, nextCursor, summary };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function parseBucket(v: unknown): BuyerListBucket {
  return v === 'unclassified' || v === 'complete' || v === 'all' ? v : 'incomplete';
}
function parseStatus(v: unknown): BuyerListStatus {
  const s = typeof v === 'string' ? v.toUpperCase() : '';
  return s === 'INACTIVE' || s === 'BLOCKED' || s === 'ALL' ? s : 'ACTIVE';
}
function parseLimit(v: unknown, limits: Readonly<BuyerListLimits> = BUYER_LIST_LIMITS): number {
  const n = typeof v === 'string' && /^[0-9]{1,4}$/.test(v) ? Number(v) : limits.defaultLimit;
  return Math.min(Math.max(n, 0), limits.maxLimit);
}

// ─── الموجّه ───

type Handler = (req: AuthRequest, res: Response) => Promise<void>;
const h = (fn: Handler) => (req: AuthRequest, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function send(res: Response, status: number, code: keyof typeof BUYER_DATA_CODES, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, code, message: BUYER_DATA_CODES[code], ...extra });
}

/**
 * GET /zatca-buyer-data، POST /zatca-buyer-data/apply-suggested، PATCH /:id/buyer-data — يُركَّب في routes/customers.ts **قبل**
 * GET /:id (وإلا التقطه كمعرّف عميل)، بعد حارسي الموجّه (authenticate وcanManageCustomers للإدارة).
 */
export function createCustomerBuyerDataRouter(deps: CustomerBuyerDataDeps): Router {
  const router = Router();
  const audit = deps.audit ?? defaultAudit;

  router.get('/zatca-buyer-data', h(async (req, res) => {
    const tid = deps.tenantId(req);
    if (!(await loadBuyerCollect(deps.db, tid))) { send(res, 404, 'ZATCA_BUYER_DATA_NOT_ENABLED'); return; }
    const isCompany = COMPANY_ROLES.includes(req.user?.role ?? '');
    const cursorRaw = str(req.query.cursor, 64);
    const cursor = ID_RE.test(cursorRaw) ? cursorRaw : null;
    const repRaw = str(req.query.repId, 64);
    const where = buyerListWhere({
      tid,
      scope: await deps.customerScope(req, tid),
      status: parseStatus(req.query.status),
      search: str(req.query.search, 100),
      repId: isCompany && ID_RE.test(repRaw) ? repRaw : null,
    });
    const r = await scanBuyerData(deps.db, where, {
      bucket: parseBucket(req.query.bucket), limit: parseLimit(req.query.limit), cursor, withSummary: cursor === null && req.query.summary !== '0',
    });
    res.json({ success: true, data: r.rows, nextCursor: r.nextCursor, ...(r.summary ? { summary: r.summary } : {}) });
  }));

  // «اعتماد التصنيف المقترح» (Q2): فعل صريح من الإدارة — منشأة لمن لم يُصنَّف وله مؤشر، ولا يمسّ من صُنِّف
  router.post('/zatca-buyer-data/apply-suggested', h(async (req, res) => {
    if (!COMPANY_ROLES.includes(req.user?.role ?? '')) { send(res, 403, 'FORBIDDEN'); return; }
    const tid = deps.tenantId(req);
    if (!(await loadBuyerCollect(deps.db, tid))) { send(res, 404, 'ZATCA_BUYER_DATA_NOT_ENABLED'); return; }
    const raw = (req.body as { ids?: unknown } | null)?.ids;
    const ids = Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, 200) : [];
    if (ids.length === 0) { res.json({ success: true, data: { updated: 0, skipped: 0 } }); return; }
    const scope = await deps.customerScope(req, tid);
    const and: Record<string, unknown>[] = [{ id: { in: ids } }, { buyerType: null }];
    if (Object.keys(scope).length > 0) and.push(scope);
    const rows = (await deps.db.customer.findMany({ where: { tenantId: tid, AND: and }, select: BUYER_ROW_SELECT })) as BuyerRow[];
    const targets = rows.filter(r => {
      const st = customerBuyerStatus(r);
      return st.explicitType === null && st.suggestedType === 'BUSINESS';
    }).map(r => r.id);
    let updated = 0;
    if (targets.length > 0) {
      updated = (await deps.db.customer.updateMany({ where: { tenantId: tid, id: { in: targets }, buyerType: null }, data: { buyerType: 'BUSINESS' } })).count;
    }
    res.json({ success: true, data: { updated, skipped: ids.length - updated } });
  }));

  // Q3: نقطة الفوترة الضيّقة — حقول الفوترة وحدها (لا مال ولا موقع ولا إسناد ولا حالة)
  router.patch('/:id/buyer-data', h(async (req, res) => {
    const tid = deps.tenantId(req);
    const id = typeof req.params.id === 'string' ? req.params.id : '';
    if (!(await loadBuyerCollect(deps.db, tid))) { send(res, 404, 'ZATCA_BUYER_DATA_NOT_ENABLED'); return; }
    const isRep = req.user?.role === 'SALES_REP';
    let repCanEdit = false;
    if (isRep) {
      const rep = await deps.db.salesRep.findUnique({ where: { id: req.user!.id }, select: { canCreateInvoice: true, canEditCustomer: true } });
      if (!(rep?.canCreateInvoice === true || rep?.canEditCustomer === true)) { send(res, 403, 'CUSTOMER_BUYER_DATA_FORBIDDEN'); return; }
      repCanEdit = rep?.canEditCustomer === true;
    }
    if (!ID_RE.test(id) || !(await deps.canAccessCustomer(req, tid, id))) { send(res, 404, 'CUSTOMER_NOT_FOUND'); return; }
    const stored = (await deps.db.customer.findFirst({ where: { id, tenantId: tid }, select: BUYER_ROW_SELECT })) as BuyerRow | null;
    if (!stored) { send(res, 404, 'CUSTOMER_NOT_FOUND'); return; }

    const { patch, errors: typeErrors } = normalizeBuyerFields(req.body);
    if (isRep) {
      // Q3: صلاحية تعديل العملاء ⇒ حقول الفوترة كلها بلا مسح؛ وبدونها (من يصدر الفواتير وحده) ⇒ إكمال الفارغ من حقول Q3 وحدها
      const restricted = repCanEdit ? clearedBuyerFields(stored, patch) : repCompleteOnlyDenied(stored, patch);
      if (restricted.length > 0 || buyerDowngrade(stored, patch)) {
        send(res, 403, 'CUSTOMER_BUYER_REP_RESTRICTED', {
          fields: restricted, ...(!repCanEdit && restricted.length > 0 ? { message: BUYER_DATA_CODES.CUSTOMER_BUYER_REP_COMPLETE_ONLY } : {}),
        });
        return;
      }
    }
    const v = validateBuyerChanges(patch, stored);
    const errors = [...typeErrors, ...v.errors];
    if (errors.length > 0) { res.status(400).json(customerZatcaInvalidBody(errors)); return; }

    let row: BuyerRow = stored;
    if (v.changed.length > 0) {
      const write: BuyerPatch = {};
      for (const f of v.changed) write[f as BuyerField] = patch[f as BuyerField] ?? null;
      row = (await deps.db.customer.update({ where: { id }, data: write, select: BUYER_ROW_SELECT })) as BuyerRow;
      if (!isRep && buyerDowngrade(stored, patch)) {
        audit(buyerDowngradeAuditLine({
          tenantId: tid, customerId: id, actorId: req.user?.id ?? '', role: req.user?.role ?? '', impersonated: req.user?.impersonated === true,
          fields: v.changed.filter(f => f === 'buyerType' || f === 'taxNumber' || f === 'commercialReg'), route: 'PATCH /customers/:id/buyer-data',
        }));
      }
    }
    res.json({ success: true, data: buyerRowView(row, customerBuyerStatus(row)), changed: v.changed, warnings: v.warnings });
  }));

  return router;
}

// ─── الجاهزية (GET /api/zatca/readiness — إعلامية) ───

export interface BuyerReadiness {
  customers: BuyerListSummary;
  products: { zeroVatUncategorized: number };
  reps: { active: number; withTaxOutbox: number; withoutBundle: number; onOlderBundle: number; latestBundle: string | null };
}

export async function buyerDataReadiness(db: BuyerDataDb, tid: string): Promise<BuyerReadiness> {
  const scan = await scanBuyerData(db, buyerListWhere({ tid, scope: {}, status: 'ACTIVE', search: '', repId: null }), {
    bucket: 'all', limit: 0, cursor: null, withSummary: true,
  });
  const zeroVatUncategorized = await db.product.count({ where: { tenantId: tid, deletedAt: null, taxPct: 0, vatCategory: null } });
  const reps = await db.salesRep.findMany({ where: { tenantId: tid, isActive: true }, select: { clientBundle: true, outboxTaxPending: true } });
  // معرّف الحزمة يبدأ بطابع زمني (vite.config.ts) فالأحدث أكبرها ترتيباً
  const bundles = reps.map(r => r.clientBundle).filter((b): b is string => typeof b === 'string' && b !== '');
  const latestBundle = bundles.length ? bundles.reduce((a, b) => (b > a ? b : a)) : null;
  return {
    customers: scan.summary!,
    products: { zeroVatUncategorized },
    reps: {
      active: reps.length,
      withTaxOutbox: reps.filter(r => (r.outboxTaxPending ?? 0) > 0).length,
      withoutBundle: reps.filter(r => !r.clientBundle).length,
      onOlderBundle: latestBundle ? reps.filter(r => !!r.clientBundle && r.clientBundle < latestBundle).length : 0,
      latestBundle,
    },
  };
}
