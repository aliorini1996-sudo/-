/**
 * «المحاسب الذكي AI» — مستندات المحادثة: صفّ AiAccountantDocument ⇐ AcctDocView (ما يصل البطاقة والسياق).
 *
 * صرفٌ بلا قاعدة: الحالة المرحّلة (posted) والمكرّر (duplicateOf) وخيارات الحساب و«مدفوع من» (suggest.ts من دليل الشركة)
 * تُحسب في store.ts (docViewsFor) وتُمرَّر هنا.
 * الأعمدة JSON (facts/checks/suggestion) تُقرأ بحذر: شكلٌ غير متوقَّع (صفٌّ قديم أو مكتوب يدوياً) يسقط إلى null/[] لا يرمي.
 */
import {
  ACCT_ASSET_CLASSES, ACCT_DOC_STATUSES, ACCT_DOC_TREATMENTS, ACCT_DOC_TYPES, ACCT_FACTS_SOURCES, ACCT_PAID_FROM, emptyFacts,
  type AcctAccountOption, type AcctAssetClass, type AcctDocCheck, type AcctDocDuplicate, type AcctDocFacts, type AcctDocPosted,
  type AcctDocStatus, type AcctDocSuggestion, type AcctDocView, type AcctFactsSource, type AcctPayOption, type AcctPaymentHint,
} from './types';

/** صفّ المستند كما يُقرأ من القاعدة (DOC_ROW_SELECT) */
export interface DocRow {
  id: string;
  tenantId: string;
  actorRef: string;
  attachmentId: string;
  sha256: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  manualEntry: boolean;
  factsSource: string | null;
  facts: unknown;
  qrRaw: string | null;
  qrVerified: boolean;
  checks: unknown;
  suggestion: unknown;
  moveId: string | null;
  postId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const DOC_ROW_SELECT = {
  id: true, tenantId: true, actorRef: true, attachmentId: true, sha256: true, fileName: true, mimeType: true, sizeBytes: true,
  status: true, manualEntry: true, factsSource: true, facts: true, qrRaw: true, qrVerified: true, checks: true, suggestion: true,
  moveId: true, postId: true, createdAt: true, updatedAt: true,
} as const;

// ═══ قراءة الأعمدة JSON بحذر ═══

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : null);

/** facts JSON ⇐ AcctDocFacts (الحقول المعروفة وحدها بأنواعها) أو null */
export function parseFacts(v: unknown): AcctDocFacts | null {
  const o = obj(v);
  if (!o) return null;
  const base = emptyFacts();
  const lease = obj(o.lease);
  const lines = Array.isArray(o.lines) ? o.lines : [];
  return {
    ...base,
    docType: oneOf(o.docType, ACCT_DOC_TYPES),
    vendorName: str(o.vendorName),
    vendorVat: str(o.vendorVat),
    buyerName: str(o.buyerName),
    buyerVat: str(o.buyerVat),
    invoiceNo: str(o.invoiceNo),
    issueDate: str(o.issueDate),
    periodFrom: str(o.periodFrom),
    periodTo: str(o.periodTo),
    currency: str(o.currency),
    subtotal: str(o.subtotal),
    vatAmount: str(o.vatAmount),
    total: str(o.total),
    vatRatePct: num(o.vatRatePct),
    months: num(o.months),
    lines: lines.slice(0, 10).flatMap((l) => {
      const x = obj(l);
      return x && typeof x.description === 'string' ? [{ description: x.description, amount: str(x.amount) }] : [];
    }),
    lease: lease ? {
      totalRent: str(lease.totalRent), months: num(lease.months), frequency: str(lease.frequency), start: str(lease.start),
      end: str(lease.end), deposit: str(lease.deposit), residential: typeof lease.residential === 'boolean' ? lease.residential : null,
    } : null,
    paymentHint: oneOf<AcctPaymentHint>(o.paymentHint, ['PAID', 'UNPAID', 'UNKNOWN']) ?? 'UNKNOWN',
    categoryHint: str(o.categoryHint),
    assetClassHint: oneOf<AcctAssetClass>(o.assetClassHint, ACCT_ASSET_CLASSES),
  };
}

/** checks JSON ⇐ AcctDocCheck[] (بلا المعطوب) */
export function parseChecks(v: unknown): AcctDocCheck[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c) => {
    const o = obj(c);
    if (!o || typeof o.code !== 'string' || (o.severity !== 'block' && o.severity !== 'warn')) return [];
    const out: AcctDocCheck = { code: o.code as AcctDocCheck['code'], severity: o.severity };
    if (typeof o.field === 'string') out.field = o.field as AcctDocCheck['field'];
    const d = obj(o.details);
    if (d) out.details = Object.fromEntries(Object.entries(d).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
    return [out];
  });
}

/** suggestion JSON ⇐ AcctDocSuggestion أو null */
export function parseSuggestion(v: unknown): AcctDocSuggestion | null {
  const o = obj(v);
  if (!o) return null;
  const treatment = oneOf(o.treatment, ACCT_DOC_TREATMENTS);
  const accountCode = str(o.accountCode);
  const vatMode = oneOf(o.vatMode, ['DEDUCTIBLE', 'NON_DEDUCTIBLE', 'NONE'] as const);
  if (!treatment || !accountCode || !vatMode) return null;
  const out: AcctDocSuggestion = {
    treatment, accountCode, accountName: str(o.accountName) ?? '', vatMode,
    months: num(o.months), paidFrom: oneOf(o.paidFrom, ACCT_PAID_FROM),
  };
  // المدفوع مقدماً: حساب المدفوع مقدماً المشتق ومصروف الإطفاء (اختياريان — صفٌّ أقدم بلا هما يبقى صالحاً)
  if (treatment === 'PREPAID') {
    const prepaidCode = str(o.prepaidCode);
    const amortizationCode = str(o.amortizationCode);
    if (prepaidCode) { out.prepaidCode = prepaidCode; out.prepaidName = str(o.prepaidName) ?? ''; }
    if (amortizationCode) { out.amortizationCode = amortizationCode; out.amortizationName = str(o.amortizationName) ?? ''; }
  }
  return out;
}

// ═══ العرض ═══

export interface ToViewOpts {
  /** 'D1'… في المحادثة؛ '' خارجها */
  ref?: string;
  posted?: AcctDocPosted | null;
  duplicateOf?: AcctDocDuplicate | null;
  accountOptions?: AcctAccountOption[];
  payOptions?: AcctPayOption[];
  /** ملف المستند مفقود (تصفير الدفاتر حذف gl_attachments) ⇒ فحص FILE_GONE مانع */
  fileGone?: boolean;
  /** فحوصٌ محدّثة بدل المخزَّنة (فحوص التاريخ النسبية بيوم الشركة الحالي — docViewsFor) وحالتها المشتقة */
  checks?: AcctDocCheck[];
  status?: AcctDocStatus;
}

const isoOf = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

/** صفّ المستند ⇐ AcctDocView */
export function toView(doc: DocRow, opts: ToViewOpts = {}): AcctDocView {
  const checks = opts.checks ? [...opts.checks] : parseChecks(doc.checks);
  if (opts.fileGone && !checks.some((c) => c.code === 'FILE_GONE')) checks.unshift({ code: 'FILE_GONE', severity: 'block' });
  const status = opts.status ?? (oneOf(doc.status, ACCT_DOC_STATUSES) ?? 'NEEDS_REVIEW') as AcctDocStatus;
  return {
    id: doc.id,
    ref: opts.ref ?? '',
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    createdAt: isoOf(doc.createdAt),
    status: opts.fileGone ? 'FAILED' : status,
    manualEntry: doc.manualEntry === true,
    factsSource: oneOf<AcctFactsSource>(doc.factsSource, ACCT_FACTS_SOURCES),
    facts: parseFacts(doc.facts),
    checks,
    qrVerified: doc.qrVerified === true,
    suggestion: parseSuggestion(doc.suggestion),
    accountOptions: opts.accountOptions ?? [],
    payOptions: opts.payOptions ?? [],
    posted: opts.posted ?? null,
    duplicateOf: opts.duplicateOf ?? null,
  };
}
