// ============================================================================
// ZATCA المرحلة الثانية — مسارات ربط وحدة EGS لمدير الشركة (/api/zatca)
// ----------------------------------------------------------------------------
// design §1.4 + §5.1 + Z4. مصنع موجّه باعتماديات مُحقنة (مخزن، حلقة المفاتيح، عميل «فاتورة»، الساعة، إعداد البيئة،
// المصادقة والصلاحية) — فالاختبارات تشغّله بلا قاعدة بيانات ولا شبكة. الربط الإنتاجي في zatcaDeps.ts.
//
// قواعد الأمان (قرار المالك — تُفرض هنا لا في الواجهة وحدها):
//   1) Tenant.zatcaPhase2Enabled === true وCompanySettings.countryCode === 'SA' لكل مسار، وإلا 403 برمز ثابت.
//   2) مدير الشركة (دور ADMIN) وحده — المشرف (MANAGER) والمحاسب (ACCOUNTANT) 403 COMPANY_ADMIN_ONLY ولو ملكا صلاحية
//      الإعدادات (قرار المالك، design §5.1) — وبصلاحية canManageCompanySettings (تُنزع من المدير أيضاً) وغير مقيّد النطاق
//      (كتكاملات الشركة: بترو آب وERP). الدور والشركة وحياة الحساب والصلاحية تُقرأ من القاعدة لكل طلب (loadAdmin) لا من
//      التوكن: مدير خُفِّض إلى مشرف يُمنع فوراً لا بعد 8 ساعات. جلسة دخول مالك المنصة («الدخول كشركة»، توكن impersonated)
//      تعمل كحساب المدير الذي يحمل التوكن معرّفه بالشروط نفسها من صفّه في القاعدة (قرار المالك 17 سبتمبر 2026) — وكل كتابة
//      بها سطر تدقيق واحد ZATCA_OWNER_IMPERSONATION_WRITE (بلا OTP ولا أسرار ولا جسم ولا قيم)، وactorId في ZatcaApiLog موسوم.
//      والحقول نفسها خارج هذا الموجّه (PUT /api/company: الرقم الضريبي والسجل والدولة) تُحرس بـcompanyZatcaFieldChanges
//      بالشروط نفسها (الدور من القاعدة، غير مقيّد النطاق) وسطر التدقيق نفسه للانتحال.
//   3) البيئات المسموحة من ZATCA_ALLOWED_ENVS (افتراضياً simulation وحدها)، وsandbox لا تُسمح أبداً على NODE_ENV=production.
//      قيمة غير معروفة ⇒ لا بيئة مسموحة (فشل مغلق). تُفحص عند الإنشاء وعند كل ربط أو تجديد لوحدة قائمة.
//   4) التفعيل (go-live) غير متاح قبل بناء إصدار الفواتير (Z5): 409 دائماً.
//   5) ZATCA_SECRETS_KEY مفقود أو تالف ⇒ 503 SECRETS_UNAVAILABLE قبل أي عمل، بلا مفتاح بديل ولا انهيار.
//   6) OTP في جسم طلبَي الربط والتجديد فقط: يُقرأ ثم يُحذف من req.body، لا يُسجَّل ولا يُعاد، ويُمسح من نتيجة المهمّة.
//      الردود تعرض الوحدة عبر toEgsUnitView وحدها (بلا مفتاح ولا أسرار ولا رموز).
//   7) كل معرّف وحدة يُتحقَّق أنه لشركة المستدعي (404 لغيرها — لا كشف).
//   8) قفل داخل العملية لكل وحدة (ربط/تجديد/إلغاء تجديد/إيقاف) + حدّ معدّل لطلبات OTP لكل شركة (ومتابعة الربط بحدّ منفصل).
//   9) الربط والتجديد مهمّة خلفية: POST يردّ 202 بعرض الوحدة، والواجهة تستطلع GET /units/:id حتى الخمول.
// ============================================================================

import { NextFunction, Request, Response, Router } from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import type { FatooraEnv } from '../compliance/zatca/api';
import { ComplianceStep, complianceSpecsFor } from '../compliance/zatca/complianceSamples';
import { CsrError, CsrParams, FunctionMap, validateCsrParams } from '../compliance/zatca/csr';
import { mapSellerParty } from '../compliance/zatca/mapInvoice';
import {
  CsrFieldOverrides, EgsUnitView, EnvironmentPolicy, FatooraClientFactory, ONBOARDING_CODES, ONBOARDING_DEFAULTS, OnboardingCode,
  OnboardingFailure, RETIRE_CONFIRMATION_TEXT, RetireReason, SignerFactory, StepMessage, abortRenewal, createUnit, onboardUnit, renewUnit,
  retireUnit, sellerSourceFromSettings, toEgsUnitView,
} from '../compliance/zatca/onboarding';
import type { EgsUnitRecord, EgsUnitStore, SellerSettingsRecord } from '../compliance/zatca/onboardingStore';
import { compileSecrets } from '../compliance/zatca/responses';
import { SecretKeyring, SecretsError } from '../compliance/zatca/secrets';
import { IssueLike, SELLER_ID_SCHEMES, isAlphanumericId, isBuildingNo, isPostalCode, isSaudiVat, sellerIssues } from '../compliance/zatca/validators';
import { AuthRequest } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// إعداد البيئات
// ─────────────────────────────────────────────────────────────────────────────

export const ZATCA_ENVS: readonly FatooraEnv[] = Object.freeze(['sandbox', 'simulation', 'production'] as FatooraEnv[]);
export const ZATCA_ALLOWED_ENVS_VAR = 'ZATCA_ALLOWED_ENVS';
export const DEFAULT_ALLOWED_ENVS: readonly FatooraEnv[] = Object.freeze(['simulation'] as FatooraEnv[]);

export interface ZatcaEnvConfigIssue {
  code: 'UNKNOWN_ENV' | 'SANDBOX_IN_PRODUCTION';
  value: string;
}

export interface ZatcaEnvConfig {
  /** البيئات التي يُسمح بإنشاء وحداتها وربطها وتجديدها على هذا الخادم (قد تكون فارغة: فشل مغلق). */
  allowedEnvs: FatooraEnv[];
  /** NODE_ENV=production: الخدمة ترفض sandbox أيضاً (EnvironmentPolicy). */
  productionBackend: boolean;
  issues: ZatcaEnvConfigIssue[];
}

/**
 * ZATCA_ALLOWED_ENVS: قائمة مفصولة بفواصل من sandbox|simulation|production (غيابها أو فراغها ⇒ simulation وحدها).
 * قيمة غير معروفة ⇒ لا بيئة مسموحة إطلاقاً (لا نخمّن ما قصده المشغّل). sandbox تُسقط على خادم الإنتاج.
 */
export function zatcaEnvConfig(env: Readonly<Record<string, string | undefined>>): ZatcaEnvConfig {
  const productionBackend = env.NODE_ENV === 'production';
  const raw = typeof env[ZATCA_ALLOWED_ENVS_VAR] === 'string' ? (env[ZATCA_ALLOWED_ENVS_VAR] as string) : '';
  const issues: ZatcaEnvConfigIssue[] = [];
  const tokens = raw.trim() === '' ? [...DEFAULT_ALLOWED_ENVS] : raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const allowed: FatooraEnv[] = [];
  for (const t of tokens) {
    if (!(ZATCA_ENVS as readonly string[]).includes(t)) {
      issues.push({ code: 'UNKNOWN_ENV', value: t.slice(0, 32) });
      continue;
    }
    if (productionBackend && t === 'sandbox') {
      issues.push({ code: 'SANDBOX_IN_PRODUCTION', value: t });
      continue;
    }
    if (!allowed.includes(t as FatooraEnv)) allowed.push(t as FatooraEnv);
  }
  const unknown = issues.some(i => i.code === 'UNKNOWN_ENV');
  return { allowedEnvs: unknown ? [] : allowed, productionBackend, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// الاعتماديات
// ─────────────────────────────────────────────────────────────────────────────

type Middleware = (req: AuthRequest, res: Response, next: NextFunction) => unknown;

/** حقول بيانات البائع التي يكتبها PUT /seller (أعمدة CompanySettings). */
export const SELLER_FIELDS = [
  'legalName', 'taxNumber', 'commercialReg', 'sellerIdScheme', 'sellerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo',
  'addrDistrict', 'addrCity', 'addrPostalCode', 'vatGroupTin',
] as const;
export type SellerField = (typeof SELLER_FIELDS)[number];
export type SellerPatch = Partial<Record<SellerField, string | null>>;

/** صفّ حساب مستخدم اللوحة كما في القاعدة الآن — مصدر قرار الدور والصلاحية (لا حمولة التوكن). */
export interface AdminAccessRecord {
  isActive: boolean;
  role: string;
  tenantId: string | null;
  canManageCompanySettings: boolean | null;
}

export interface ZatcaRouteDeps {
  /** يضبط req.user (الإنتاج: authenticate — التوقيع وحياة الحساب). */
  authenticate: Middleware;
  /**
   * صفّ حساب المستدعي من القاعدة (الإنتاج: prisma.admin.findUnique بالمعرّف: isActive وrole وtenantId وcanManageCompanySettings).
   * يُقرأ بعد رفض دور التوكن غير ADMIN (مسار سريع بلا قراءة)، والقرار من الصفّ: مدير خُفِّض دوره أو نُزعت صلاحيته أو عُطِّل
   * يُمنع فوراً ولو بقي توكنه يقول ADMIN حتى انتهائه.
   */
  loadAdmin: (req: AuthRequest) => Promise<AdminAccessRecord | null>;
  /** مستخدم مقيّد النطاق؟ (الإنتاج: adminScopeEnabled). */
  isScopeRestricted: (req: AuthRequest) => Promise<boolean>;
  /** Tenant.zatcaPhase2Enabled. */
  loadTenantFlag: (tenantId: string) => Promise<boolean>;
  store: EgsUnitStore;
  /** يكتب حقول البائع؛ false إن لم يوجد صفّ إعدادات للشركة. */
  writeSeller: (tenantId: string, patch: SellerPatch) => Promise<boolean>;
  /** حلقة مفاتيح التشفير — ترمي SecretsError عند غياب المفتاح أو تلفه (الإنتاج: keyringFromEnv(process.env)). */
  loadKeyring: () => SecretKeyring;
  clientFactory: FatooraClientFactory;
  now: () => Date;
  config: ZatcaEnvConfig;
  /** حدّ طلبات OTP لكل شركة (افتراضياً 10 كل 15 دقيقة) — يُحتسب فيه كل طلب ربط أو تجديد يحمل حقل otp. */
  otpRateLimit?: { windowMs: number; limit: number };
  /** حدّ «متابعة الربط» بلا رمز لكل شركة (افتراضياً 60 كل 15 دقيقة) — منفصل كي لا تستهلك المتابعة حدّ الرمز. */
  resumeRateLimit?: { windowMs: number; limit: number };
  signerFactory?: SignerFactory;
  sleep?: (ms: number) => Promise<void>;
  leaseMs?: number;
  /** سجلّ تشغيلي آمن (أكواد وأسماء فقط) — افتراضياً console.warn. */
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  /** سطر تدقيق كتابة جلسة دخول مالك المنصة (JSON واحد لكل طلب — ownerImpersonationAuditLine) — افتراضياً console.warn. */
  audit?: (line: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// الأكواد والرسائل
// ─────────────────────────────────────────────────────────────────────────────

export const ZATCA_ROUTE_CODES = Object.freeze({
  FORBIDDEN: 'غير مسموح',
  COMPANY_ADMIN_ONLY: 'ربط الفوترة الإلكترونية متاح لمدير الشركة فقط',
  PERMISSION_DENIED: 'لا تملك صلاحية الوصول لهذا القسم',
  SCOPED_ADMIN: 'حسابك مقيد بنطاق محدد — ربط الفوترة الإلكترونية يحتاج صلاحية غير مقيدة على مستوى الشركة',
  ZATCA_PHASE2_NOT_ALLOWED: 'ربط فوترة المرحلة الثانية (فاتورة) غير مفعّل لاشتراك شركتك — تواصل مع مزوّد الخدمة',
  ZATCA_COUNTRY_NOT_SUPPORTED: 'ربط فوترة المرحلة الثانية متاح للمنشآت السعودية فقط',
  JOB_RUNNING: 'عملية جارية على هذه الوحدة — انتظر حتى تنتهي ثم أعد المحاولة',
  GO_LIVE_UNAVAILABLE: 'غير متاح قبل اكتمال ربط إصدار الفواتير',
  OTP_RATE_LIMITED: 'محاولات كثيرة لإدخال رمز التحقق — انتظر 15 دقيقة ثم أعد المحاولة',
  RESUME_RATE_LIMITED: 'محاولات كثيرة لمتابعة الربط — انتظر قليلاً ثم أعد المحاولة',
  INVALID_JSON: 'صيغة الطلب غير صالحة',
  SELLER_INVALID: 'بيانات المنشأة غير صحيحة — صحّح الحقول المذكورة',
  SELLER_FIELDS_ADMIN_ONLY: 'الرقم الضريبي والسجل التجاري ودولة المنشأة مرتبطة بربط الفوترة الإلكترونية (المرحلة الثانية) — يعدّلها مدير الشركة فقط',
  SELLER_FIELDS_SCOPED: 'حسابك مقيد بنطاق محدد — الرقم الضريبي والسجل التجاري ودولة المنشأة يعدّلها مدير الشركة بصلاحية غير مقيدة',
  SERVER_ERROR: 'خطأ في الخادم',
});
export type ZatcaRouteCode = keyof typeof ZATCA_ROUTE_CODES;

const HTTP_BY_CODE: Partial<Record<OnboardingCode, number>> = {
  INVALID_INPUT: 400, OTP_REQUIRED: 400, OTP_INVALID_FORMAT: 400, RETIRE_CONFIRMATION_REQUIRED: 400, CONFIRMATION_REQUIRED: 400,
  TENANT_NOT_FOUND: 404, UNIT_NOT_FOUND: 404,
  COUNTRY_NOT_SUPPORTED: 403, ENV_NOT_ALLOWED: 403,
  UNIT_EXISTS: 409, OTHER_UNIT_EXISTS: 409, INVALID_STATE: 409, IN_PROGRESS: 409, CONCURRENT_MODIFICATION: 409, RENEWAL_UNCONFIRMED: 409,
  SELLER_DATA_INCOMPLETE: 422, SELLER_VAT_CHANGED: 422, CSR_PARAMS_INVALID: 422, CURRENCY_NOT_SAR: 422,
  SECRETS_UNAVAILABLE: 503, STORE_ERROR: 503,
  INTERNAL: 500,
};

export function httpStatusForCode(code: string): number {
  return HTTP_BY_CODE[code as OnboardingCode] ?? 422;
}

// ─────────────────────────────────────────────────────────────────────────────
// أدوات نقيّة (مُصدَّرة للاختبار)
// ─────────────────────────────────────────────────────────────────────────────

/** مستخدمو لوحة الشركة — ومنهم مدير الشركة (ADMIN) وحده يربط الفوترة؛ غيرهم من اللوحة يُخبَر بالسبب، والباقي «غير مسموح». */
const COMPANY_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];
const ZATCA_ROLE = 'ADMIN';
const UNIT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OTP_RE = /^[0-9]{6}$/;
/** الحالات التي يُستأنف فيها الربط أو يبدأ. */
const ONBOARDABLE = new Set(['CSR_READY', 'ERROR_NEEDS_OTP', 'CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED']);
const OTP_NEEDED = new Set(['CSR_READY', 'ERROR_NEEDS_OTP']);
const RENEWABLE = new Set(['ACTIVE', 'EXPIRED', 'RENEWING']);
/** حالات تحمل شهادة إنتاج صدرت (تحذير «بيانات الشهادة قد تصبح قديمة» عند تعديل البائع). */
const CERT_HOLDING = new Set(['ACTIVE', 'RENEWING', 'EXPIRED']);
const RETIRE_REASONS: readonly RetireReason[] = ['revoked-in-portal', 'abandoned'];
const MAX_STEP_MESSAGES = 20;
const JOB_RETENTION_MS = 6 * 60 * 60 * 1000;
const MAX_RETAINED_JOBS = 500;

/** أرقام عربية-هندية وفارسية ⇒ لاتينية (لوحة مفاتيح الجوال). */
export function latinDigits(s: string): string {
  return s.replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06f0));
}

export interface ChecklistItem {
  key: 'key' | 'csr' | 'ccsid' | 'pcsid' | ComplianceStep;
  kind: 'setup' | 'check';
  status: 'done' | 'warning' | 'running' | 'failed' | 'pending';
  warnings: StepMessage[];
  errors: StepMessage[];
  detail: string | null;
}

export interface UnitChecklist {
  phase: 'onboarding' | 'renewal';
  items: ChecklistItem[];
  checksPassed: number;
  checksTotal: number;
  renewal: { stage: string; uncertain: boolean; origin: string } | null;
}

const CCSID_DONE = new Set(['CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED', 'ACTIVE', 'RENEWING', 'EXPIRED', 'AUTH_FAILED']);
const PCSID_DONE = new Set(['ACTIVE', 'RENEWING', 'EXPIRED', 'AUTH_FAILED']);

function stepsOrder(functionMap: string): ComplianceStep[] {
  try {
    return complianceSpecsFor(functionMap as FunctionMap).map(s => s.step);
  } catch {
    return complianceSpecsFor('1100').map(s => s.step);
  }
}

/**
 * قائمة التقدّم الحيّة (design §5.1 خطوة 4) من عرض الوحدة ونشاطها (unitActivity). «جارية» فقط ما دام العمل حيّاً: مهمّة
 * هنا أو عقد إيجار حديث — علامة inFlight أو حالة CHECKS_RUNNING بعد موت العامل (إعادة نشر أثناء نداء الهيئة) لا تُبقي
 * مؤشّراً يدور يناقض أزرار البطاقة نفسها (خانة الرمز أو «متابعة الربط»).
 */
export function unitChecklist(unit: EgsUnitView, activity: UnitActivity): UnitChecklist {
  const running = activity.reason === 'job';
  const live = activity.busy;
  const p = unit.complianceProgress;
  const phase = p?.phase ?? 'onboarding';
  const steps = p?.steps ?? {};
  const order = stepsOrder(unit.functionMap);
  const ccsidDone = CCSID_DONE.has(unit.status) || (unit.status === 'ERROR_NEEDS_OTP' && !!p?.requestId);
  const items: ChecklistItem[] = [
    { key: 'key', kind: 'setup', status: 'done', warnings: [], errors: [], detail: null },
    { key: 'csr', kind: 'setup', status: 'done', warnings: [], errors: [], detail: null },
    {
      key: 'ccsid', kind: 'setup', warnings: [], errors: [], detail: null,
      status: ccsidDone ? 'done' : (running && unit.status === 'CSR_READY') || (live && p?.inFlight?.op === 'compliance') ? 'running' : unit.status === 'ERROR_NEEDS_OTP' ? 'failed' : 'pending',
    },
  ];
  let passed = 0;
  let firstOpen = true;
  const checksActive = (live && unit.status === 'CHECKS_RUNNING') || (running && (unit.status === 'CCSID_ISSUED' || unit.status === 'RENEWING'));
  for (const step of order) {
    const r = steps[step];
    let status: ChecklistItem['status'];
    if (r && (r.status === 'PASS' || r.status === 'WARNING')) {
      status = r.status === 'PASS' ? 'done' : 'warning';
      passed++;
    } else if (checksActive && firstOpen) {
      // أول خطوة لم تنجح أثناء الفحوص: تُرسل الآن (ولو حملت نتيجة فشل سابقة ستُستبدل)
      status = 'running';
      firstOpen = false;
    } else if (r) {
      status = 'failed';
      firstOpen = false;
    } else if (PCSID_DONE.has(unit.status) && phase === 'onboarding') {
      status = 'done';
      passed++;
    } else {
      status = 'pending';
    }
    items.push({
      key: step, kind: 'check', status,
      warnings: (r?.warnings ?? []).slice(0, MAX_STEP_MESSAGES), errors: (r?.errors ?? []).slice(0, MAX_STEP_MESSAGES), detail: r?.detail ?? null,
    });
  }
  items.push({
    key: 'pcsid', kind: 'setup', warnings: [], errors: [], detail: null,
    status: unit.status === 'ACTIVE' || (PCSID_DONE.has(unit.status) && unit.status !== 'RENEWING')
      ? 'done'
      : (running && unit.status === 'CHECKS_PASSED') || (live && p?.inFlight?.op === 'production-csid') ? 'running' : 'pending',
  });
  return {
    phase, items, checksPassed: passed, checksTotal: order.length,
    renewal: p?.renewal ? { stage: p.renewal.stage, uncertain: p.renewal.uncertain, origin: p.renewal.origin } : null,
  };
}

export interface UnitActivity {
  busy: boolean;
  reason: 'job' | 'checks' | 'renewal' | 'csid-request' | null;
}

/** هل عملية جارية على الوحدة (مهمّة هنا، أو عقد إيجار حديث لعامل آخر)؟ الواجهة تستطلع ما دام busy. */
export function unitActivity(unit: EgsUnitView, jobRunning: boolean, now: Date, leaseMs: number): UnitActivity {
  if (jobRunning) return { busy: true, reason: 'job' };
  const fresh = now.getTime() - new Date(unit.updatedAt).getTime() < leaseMs;
  if (!fresh) return { busy: false, reason: null };
  if (unit.status === 'CHECKS_RUNNING') return { busy: true, reason: 'checks' };
  if (unit.status === 'RENEWING' && unit.complianceProgress?.renewal?.stage !== 'unconfirmed') return { busy: true, reason: 'renewal' };
  if (unit.complianceProgress?.inFlight && (unit.status === 'CSR_READY' || unit.status === 'CHECKS_PASSED')) return { busy: true, reason: 'csid-request' };
  return { busy: false, reason: null };
}

const FIELD_MAP: Record<string, SellerField | 'countryCode'> = {
  'supplier.registrationName': 'legalName', 'supplier.vatNumber': 'taxNumber', 'supplier.otherId.value': 'sellerIdValue',
  'supplier.otherId.scheme': 'sellerIdScheme', 'supplier.address.street': 'addrStreet', 'supplier.address.buildingNumber': 'addrBuildingNo',
  'supplier.address.district': 'addrDistrict', 'supplier.address.city': 'addrCity', 'supplier.address.postalZone': 'addrPostalCode',
  'supplier.address.country': 'countryCode', vatGroupTin: 'vatGroupTin',
};

export type ReadinessIssue = IssueLike & { settingsField: SellerField | 'countryCode' | null };

const isVatGroup = (vat: string | null | undefined) => typeof vat === 'string' && vat.length === 15 && vat[10] === '1';

/** طلب CSR صالح في كل حقوله عدا الحقل المفحوص — فيُرفض الفحص بسبب القيمة المفحوصة وحدها. */
const CSR_PROBE: CsrParams = {
  env: 'simulation', commonName: 'FS-399999999900003-probe', serialNumber: '1-FieldSales|2-EGS1|3-00000000-0000-4000-8000-000000000000',
  orgName: 'Probe', orgUnit: ONBOARDING_DEFAULTS.branchName, vatNumber: '399999999900003', functionMap: '1100', locationAddress: 'Riyadh',
  industry: ONBOARDING_DEFAULTS.industry,
};

export interface CsrTextProblem {
  reason: string;
  /** الشرح بلا اسم حقل CSR التقني (مثل «أطول من 64 محرفاً»). */
  messageAr: string;
}

/**
 * هل تُقبل القيمة في حقل CSR نصّي؟ بقواعد validateCsrParams نفسها (لا نسخة منها): الطول بنقاط يونيكود، المحارف الممنوعة
 * ! @ # $ % & * _ <، محارف التحكّم وعلامات الاتجاه الخفية، الفراغ في الطرفين، و«\» البادئة. null = مقبولة.
 */
export function csrTextProblem(field: 'orgName' | 'locationAddress', value: string): CsrTextProblem | null {
  try {
    validateCsrParams({ ...CSR_PROBE, [field]: value });
    return null;
  } catch (e) {
    if (!(e instanceof CsrError) || e.code !== 'INVALID_PARAM' || e.field !== field) return null;
    const cut = e.detail.indexOf(': ');
    return { reason: e.reason ?? 'FORMAT', messageAr: cut >= 0 ? e.detail.slice(cut + 2) : e.detail };
  }
}

/**
 * عنوان الوحدة في CSR حين لا يُدخل المدير عنواناً مختصراً — مطابق لـdefaultLocation في compliance/zatca/onboarding.ts
 * (الحارس في zatca-routes.test.ts يقارنه بعنوان وحدة تنشئها الخدمة فعلاً).
 */
export function csrDefaultLocation(s: Pick<SellerSettingsRecord, 'addrBuildingNo' | 'addrStreet' | 'addrDistrict' | 'addrCity' | 'addrPostalCode'>): string {
  const t = (v: string | null | undefined) => (v ?? '').trim();
  const full = [[t(s.addrBuildingNo), t(s.addrStreet)].filter(Boolean).join(' '), t(s.addrDistrict), t(s.addrCity)].filter(Boolean).join(', ');
  if (Array.from(full).length <= 64) return full;
  return [t(s.addrBuildingNo), t(s.addrCity), t(s.addrPostalCode)].filter(Boolean).join(' ');
}

const SELLER_FIELD_AR: Record<SellerField, string> = {
  legalName: 'الاسم القانوني', taxNumber: 'الرقم الضريبي', commercialReg: 'السجل التجاري', sellerIdScheme: 'نوع معرّف المنشأة', sellerIdValue: 'رقم المعرّف',
  addrStreet: 'اسم الشارع', addrBuildingNo: 'رقم المبنى', addrAdditionalNo: 'الرقم الإضافي', addrDistrict: 'الحي', addrCity: 'المدينة',
  addrPostalCode: 'الرمز البريدي', vatGroupTin: 'الرقم المميّز لعضو المجموعة الضريبية',
};

const LOCATION_SOURCE_FIELDS: readonly SellerField[] = ['addrStreet', 'addrDistrict', 'addrCity', 'addrBuildingNo', 'addrPostalCode'];

/**
 * قيود طلب الشهادة على بيانات المنشأة (قبل «إنشاء وحدة الربط» لا بعده):
 *   - الاسم القانوني هو اسم المنشأة (O) في CSR ولا بديل له ⇒ خطأ يمنع الإنشاء.
 *   - العنوان المشتقّ (registeredAddress) ⇒ تحذير لا منع: للمدير أن يُدخل «العنوان المختصر في الشهادة» عند الإنشاء.
 */
export function csrReadinessIssues(s: SellerSettingsRecord): ReadinessIssue[] {
  const out: ReadinessIssue[] = [];
  const legal = s.legalName ?? '';
  if (legal.trim() !== '') {
    const p = csrTextProblem('orgName', legal);
    if (p) {
      out.push({
        rule: `CSR-O-${p.reason}`, field: 'legalName', severity: 'error', settingsField: 'legalName',
        messageAr: `الاسم القانوني للمنشأة يُكتب في طلب شهادة الهيئة: ${p.messageAr}`,
      });
    }
  }
  const location = csrDefaultLocation(s);
  if (location !== '') {
    const p = csrTextProblem('locationAddress', location);
    if (p) {
      // الحقل المسبِّب: أول حقل عنوان تُرفض قيمته منفردة، وإلا اسم الشارع (مشكلة في النصّ المركّب)
      const culprit = LOCATION_SOURCE_FIELDS.find(f => {
        const v = (s[f] ?? '').trim();
        return v !== '' && csrTextProblem('locationAddress', v) !== null;
      }) ?? 'addrStreet';
      const own = csrTextProblem('locationAddress', (s[culprit] ?? '').trim());
      out.push({
        rule: `CSR-REGISTERED-ADDRESS-${(own ?? p).reason}`, field: culprit, severity: 'warning', settingsField: culprit,
        messageAr: `العنوان المكتوب في طلب شهادة الهيئة (${SELLER_FIELD_AR[culprit]}): ${(own ?? p).messageAr} — صحّحه أو أدخل «العنوان المختصر في الشهادة» عند إنشاء الوحدة`,
      });
    }
  }
  return out;
}

/** جاهزية بيانات البائع كفحص الخدمة (sellerIssues على الطرف المحوَّل + TIN المجموعة الضريبية) + قيود طلب الشهادة. */
export function sellerReadiness(s: SellerSettingsRecord): ReadinessIssue[] {
  const issues: IssueLike[] = sellerIssues(mapSellerParty(sellerSourceFromSettings(s)));
  if (isVatGroup(s.taxNumber) && !/^[0-9]{10}$/.test(s.vatGroupTin ?? '')) {
    issues.push({
      rule: 'SEC-TABLE-1', field: 'vatGroupTin', severity: 'error',
      messageAr: 'الرقم الضريبي لمجموعة ضريبية (الخانة 11 = 1): أدخل الرقم المميّز للعضو بعشرة أرقام',
    });
  }
  return [...issues.map(i => ({ ...i, settingsField: FIELD_MAP[i.field] ?? null })), ...csrReadinessIssues(s)];
}

export interface SellerFieldError {
  field: SellerField;
  messageAr: string;
}

export interface SellerValidation {
  patch: SellerPatch;
  errors: SellerFieldError[];
}

const MAX_LEN: Record<SellerField, number> = {
  legalName: 1000, taxNumber: 32, commercialReg: 64, sellerIdScheme: 8, sellerIdValue: 64, addrStreet: 200, addrBuildingNo: 16,
  addrAdditionalNo: 16, addrDistrict: 200, addrCity: 200, addrPostalCode: 16, vatGroupTin: 32,
};
const DIGIT_FIELDS: ReadonlySet<SellerField> = new Set<SellerField>(['taxNumber', 'commercialReg', 'sellerIdValue', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'vatGroupTin']);

/** قيمة حقل البائع كما تُحفظ: فراغ الطرفين يُحذف، الأرقام العربية لاتينية في الحقول الرقمية، النوع بأحرف كبيرة، '' ⇒ null. */
export function sellerFieldValue(f: SellerField, v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  let s = v.trim();
  if (DIGIT_FIELDS.has(f)) s = latinDigits(s);
  if (f === 'sellerIdScheme') s = s.toUpperCase();
  return s === '' ? null : s;
}

/** الصيغ تُفحص فقط حين تُدخل قيمة (design §1.4). '' أو null = إفراغ؛ غياب المفتاح = بلا تغيير. */
export function validateSellerBody(body: unknown): SellerValidation {
  const patch: SellerPatch = {};
  const errors: SellerFieldError[] = [];
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b) return { patch, errors: [{ field: 'legalName', messageAr: ZATCA_ROUTE_CODES.SELLER_INVALID }] };
  for (const f of SELLER_FIELDS) {
    if (!(f in b) || b[f] === undefined) continue;
    const v = b[f];
    if (v === null) { patch[f] = null; continue; }
    if (typeof v !== 'string') { errors.push({ field: f, messageAr: 'قيمة غير صالحة' }); continue; }
    const s = sellerFieldValue(f, v);
    if ((s ?? '').length > MAX_LEN[f]) { errors.push({ field: f, messageAr: 'القيمة أطول من المسموح' }); continue; }
    patch[f] = s;
  }
  const has = (f: SellerField) => typeof patch[f] === 'string';
  if (has('taxNumber') && !isSaudiVat(patch.taxNumber)) errors.push({ field: 'taxNumber', messageAr: 'الرقم الضريبي يجب أن يكون 15 رقماً يبدأ وينتهي بالرقم 3' });
  if (has('addrBuildingNo') && !isBuildingNo(patch.addrBuildingNo)) errors.push({ field: 'addrBuildingNo', messageAr: 'رقم المبنى يجب أن يكون 4 أرقام' });
  if (has('addrPostalCode') && !isPostalCode(patch.addrPostalCode)) errors.push({ field: 'addrPostalCode', messageAr: 'الرمز البريدي يجب أن يكون 5 أرقام' });
  if (has('vatGroupTin') && !/^[0-9]{10}$/.test(patch.vatGroupTin as string)) errors.push({ field: 'vatGroupTin', messageAr: 'الرقم المميّز لعضو المجموعة الضريبية يجب أن يكون 10 أرقام' });
  if (has('sellerIdScheme') && !(SELLER_ID_SCHEMES as readonly string[]).includes(patch.sellerIdScheme as string)) {
    errors.push({ field: 'sellerIdScheme', messageAr: `نوع معرّف المنشأة غير مسموح — المسموح: ${SELLER_ID_SCHEMES.join('، ')}` });
  }
  if (has('sellerIdValue') && !isAlphanumericId(patch.sellerIdValue)) errors.push({ field: 'sellerIdValue', messageAr: 'معرّف المنشأة يجب أن يكون أرقاماً أو حروفاً لاتينية بلا مسافات أو رموز' });
  return { patch, errors };
}

/** حقول PUT /api/company التي يقرؤها ربط الفوترة: هوية البائع في الشهادة، وبوابة الدولة لمسارات /api/zatca. */
export const COMPANY_ZATCA_FIELDS = ['taxNumber', 'commercialReg', 'countryCode'] as const;
export type CompanyZatcaField = (typeof COMPANY_ZATCA_FIELDS)[number];

export interface CompanyZatcaChanges {
  /** الحقول التي تتغيّر فعلاً (بعد التطبيع) — لا يغيّرها إلا مدير الشركة (أو جلسة دخول المالك بحسابه، مع سطر التدقيق). */
  changed: CompanyZatcaField[];
  /** القيم المطبَّعة (كـPUT /api/zatca/seller) للرقم الضريبي والسجل المتغيّرين. */
  write: Partial<Record<'taxNumber' | 'commercialReg', string | null>>;
  /** أُرسلا بلا تغيير فعلي ⇒ لا يُكتبان (تبقى القيمة المحفوظة كما هي). */
  unchanged: Array<'taxNumber' | 'commercialReg'>;
  /** صيغ validateSellerBody للمتغيّر منها — حين تكون المنشأة سعودية بعد الحفظ. */
  errors: SellerFieldError[];
}

/**
 * PUT /api/company لشركة فعّل لها المالك zatcaPhase2Enabled: الرقم الضريبي (المربوطة به الوحدة: تغييره يوقف الربط والتجديد
 * SELLER_VAT_CHANGED) والسجل التجاري والدولة (تغييرها عن SA يغلق كل مسارات /api/zatca). current = المحفوظ (null بلا صفّ)،
 * sent = ما أرسله الطلب (undefined = لم يُرسل؛ countryCode بعد getCountryTax). منشأة غير سعودية قبل الحفظ وبعده ⇒ لا قيد.
 */
export function companyZatcaFieldChanges(
  current: { taxNumber: string | null; commercialReg: string | null; countryCode: string | null } | null,
  sent: { taxNumber?: string | null; commercialReg?: string | null; countryCode?: string | null },
): CompanyZatcaChanges {
  const out: CompanyZatcaChanges = { changed: [], write: {}, unchanged: [], errors: [] };
  const countryBefore = current?.countryCode ?? null;
  const countryAfter = sent.countryCode ?? countryBefore;
  if (countryBefore !== 'SA' && countryAfter !== 'SA') return out;
  if (countryAfter !== countryBefore) out.changed.push('countryCode');
  const body: Record<string, unknown> = {};
  for (const f of ['taxNumber', 'commercialReg'] as const) {
    if (sent[f] === undefined) continue;
    const next = sellerFieldValue(f, sent[f]);
    if (next === sellerFieldValue(f, current?.[f] ?? null)) { out.unchanged.push(f); continue; }
    out.changed.push(f);
    out.write[f] = next;
    body[f] = sent[f];
  }
  if (countryAfter === 'SA') out.errors = validateSellerBody(body).errors;
  return out;
}

export interface SellerWarning {
  code: 'CSR_MAY_BE_STALE' | 'SELLER_VAT_CHANGED' | 'VAT_GROUP_TIN_MISSING' | 'VAT_GROUP_TIN_UNUSED';
  messageAr: string;
  unitId?: string;
}

const CSR_RELEVANT: readonly SellerField[] = ['legalName', 'vatGroupTin', 'addrStreet', 'addrBuildingNo', 'addrDistrict', 'addrCity', 'addrPostalCode'];

/** تحذيرات لا تمنع الحفظ: وحدة تحمل شهادة وقد صارت بيانات طلبها قديمة، ورقم المجموعة الضريبية. */
export function sellerWarnings(before: SellerSettingsRecord, after: SellerSettingsRecord, units: readonly Pick<EgsUnitRecord, 'id' | 'status' | 'vatNumber'>[]): SellerWarning[] {
  const out: SellerWarning[] = [];
  const holding = units.filter(u => CERT_HOLDING.has(u.status));
  const changed = CSR_RELEVANT.some(f => (before[f] ?? null) !== (after[f] ?? null));
  for (const u of holding) {
    if ((after.taxNumber ?? null) !== u.vatNumber) {
      out.push({ code: 'SELLER_VAT_CHANGED', messageAr: ONBOARDING_CODES.SELLER_VAT_CHANGED.messageAr, unitId: u.id });
    } else if (changed) {
      out.push({ code: 'CSR_MAY_BE_STALE', messageAr: 'تغيّرت بيانات المنشأة بعد ربط الوحدة — بيانات شهادتها (الاسم أو العنوان) صارت قديمة ويُنصح بتجديد الشهادة', unitId: u.id });
    }
  }
  if (isVatGroup(after.taxNumber) && !after.vatGroupTin) {
    out.push({ code: 'VAT_GROUP_TIN_MISSING', messageAr: 'الرقم الضريبي لمجموعة ضريبية (الخانة 11 = 1): أدخل الرقم المميّز للعضو بعشرة أرقام قبل ربط الوحدة' });
  } else if (!isVatGroup(after.taxNumber) && after.vatGroupTin) {
    out.push({ code: 'VAT_GROUP_TIN_UNUSED', messageAr: 'الرقم المميّز للمجموعة الضريبية لا يُستعمل لأن الرقم الضريبي ليس لمجموعة ضريبية' });
  }
  return out;
}

// ─── المهامّ ───

export interface JobOutcome {
  ok: boolean;
  code: string;
  messageAr: string;
  retryable: boolean;
  needsNewOtp: boolean;
  zatcaMessages: StepMessage[];
  detail: string | null;
  step: string | null;
  field: string | null;
  issues: IssueLike[];
}

export interface JobView {
  id: string;
  kind: 'onboard' | 'renew';
  state: 'running' | 'finished';
  startedAt: Date;
  finishedAt: Date | null;
  outcome: JobOutcome | null;
}

interface JobRecord extends JobView {
  unitId: string;
  tenantId: string;
}

const OK_MESSAGES = {
  onboard: 'اكتمل ربط الوحدة وصدرت شهادة الإنتاج',
  renew: 'اكتمل تجديد شهادة الوحدة',
};

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** يمحو OTP (بحدود أرقام) من كل نصّ في القيمة. */
function scrubDeep<T>(v: T, otp: string | null, depth = 0): T {
  if (!otp) return v;
  const m = compileSecrets([otp]);
  const walk = (x: unknown, d: number): unknown => {
    if (typeof x === 'string') return m.contains(x) ? m.scrub(x) : x;
    if (!x || typeof x !== 'object' || x instanceof Date || d > 8) return x;
    if (Array.isArray(x)) return x.map(y => walk(y, d + 1));
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) out[k] = walk(y, d + 1);
    return out;
  };
  return walk(v, depth) as T;
}

/** نتيجة المهمّة للاستطلاع: كود ورسالة عربية وعلما الإرشاد ورسائل الهيئة منقّحة — بلا وحدة ولا OTP. */
export function jobOutcomeOf(kind: 'onboard' | 'renew', r: { ok: true } | OnboardingFailure, otp: string | null): JobOutcome {
  if (r.ok) {
    return { ok: true, code: 'OK', messageAr: OK_MESSAGES[kind], retryable: false, needsNewOtp: false, zatcaMessages: [], detail: null, step: null, field: null, issues: [] };
  }
  const f = r as OnboardingFailure;
  const outcome: JobOutcome = {
    ok: false,
    code: typeof f.code === 'string' ? f.code : 'INTERNAL',
    messageAr: cleanText(f.messageAr, 600) ?? ONBOARDING_CODES.INTERNAL.messageAr,
    retryable: f.retryable === true,
    needsNewOtp: f.needsNewOtp === true,
    zatcaMessages: (Array.isArray(f.zatcaMessages) ? f.zatcaMessages : []).slice(0, MAX_STEP_MESSAGES).map(m => ({
      type: m?.type === 'WARNING' ? 'WARNING' : 'ERROR', code: cleanText(m?.code, 128), message: cleanText(m?.message, 400),
    })),
    detail: cleanText(f.detail, 200),
    step: cleanText(f.step, 64),
    field: cleanText(f.field, 64),
    issues: (Array.isArray(f.issues) ? f.issues : []).slice(0, 30).map(i => ({
      rule: cleanText(i.rule, 64) ?? '', field: cleanText(i.field, 64) ?? '', messageAr: cleanText(i.messageAr, 400) ?? '', severity: i.severity === 'warning' ? 'warning' : 'error',
    })),
  };
  return scrubDeep(outcome, otp);
}

// ─────────────────────────────────────────────────────────────────────────────
// تدقيق كتابة جلسة دخول مالك المنصة (قرار المالك 17 سبتمبر 2026)
// ─────────────────────────────────────────────────────────────────────────────

export const OWNER_IMPERSONATION_AUDIT_EVENT = 'ZATCA_OWNER_IMPERSONATION_WRITE';

export type OwnerImpersonationAction =
  | 'seller.update' | 'unit.create' | 'unit.onboard' | 'unit.renew' | 'unit.abort-renewal' | 'unit.retire' | 'go-live'
  | 'company.seller-fields' | 'unknown';

export interface OwnerImpersonationAuditFields {
  tenantId: string | null | undefined;
  /** معرّف حساب مدير الشركة الذي يحمله توكن الانتحال (أقدم مدير نشط — POST /api/tenants/:id/impersonate). */
  actorAdminId: string | null | undefined;
  action: OwnerImpersonationAction;
  unitId?: string;
  /** أسماء حقول PUT /api/company المتغيّرة وحدها — لا قيمها. */
  fields?: readonly string[];
}

/**
 * ZatcaApiLog.actorId نصّ حرّ بلا مفتاح أجنبي (schema.prisma، onboardingStore.writeApiLog) — كتابة جلسة دخول المالك تُوسم
 * بالبادئة فلا تُقرأ في السجلّ كأنها من مدير الشركة نفسه.
 */
export const IMPERSONATION_ACTOR_PREFIX = 'owner-impersonation:';

export function zatcaActorId(user: { id: string; impersonated?: boolean }): string {
  return user.impersonated === true ? `${IMPERSONATION_ACTOR_PREFIX}${user.id}` : user.id;
}

const AUDIT_ACTIONS: Record<string, OwnerImpersonationAction> = {
  'PUT /seller': 'seller.update', 'POST /units': 'unit.create', 'POST /go-live': 'go-live',
};
const UNIT_ACTION_RE = /^\/units\/([^/]+)\/(onboard|renew|abort-renewal|retire)\/?$/i;

/** العملية من مسار الطلب داخل الموجّه (req.path، قبل مطابقة المسار) — ومعرّف الوحدة حين يطابق صيغته وحدها. */
export function zatcaWriteAction(method: string, path: string): { action: OwnerImpersonationAction; unitId?: string } {
  const m = method.toUpperCase();
  const p = path.length > 1 ? path.replace(/\/$/, '') : path;
  const fixed = AUDIT_ACTIONS[`${m} ${p.toLowerCase()}`];
  if (fixed) return { action: fixed };
  const u = m === 'POST' ? UNIT_ACTION_RE.exec(p) : null;
  if (u) return { action: `unit.${u[2].toLowerCase()}` as OwnerImpersonationAction, ...(UNIT_ID_RE.test(u[1]) ? { unitId: u[1] } : {}) };
  return { action: 'unknown' };
}

const auditId = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, 128) : null);

/**
 * سطر JSON واحد بمفاتيح ثابتة: event وtenantId وactorAdminId وaction و(unitId) و(fields) وstatus (رمز HTTP المُرسَل، null إن
 * انقطع الاتصال قبل الردّ). لا OTP ولا أسرار ولا جسم الطلب ولا قيم البائع — أسماء الحقول وحدها ومن قائمة ثابتة.
 */
export function ownerImpersonationAuditLine(f: OwnerImpersonationAuditFields, status: number | null): string {
  const fields = f.fields?.filter(x => (COMPANY_ZATCA_FIELDS as readonly string[]).includes(x));
  return JSON.stringify({
    event: OWNER_IMPERSONATION_AUDIT_EVENT,
    tenantId: auditId(f.tenantId),
    actorAdminId: auditId(f.actorAdminId),
    action: f.action,
    ...(typeof f.unitId === 'string' && UNIT_ID_RE.test(f.unitId) ? { unitId: f.unitId } : {}),
    ...(fields ? { fields } : {}),
    status,
  });
}

export const defaultAuditEmit = (line: string): void => {
  console.warn(line);
};

/** يُصدر سطر التدقيق مرة واحدة عند انتهاء الردّ (نجاحاً أو رفضاً أو خطأً) أو انقطاع الاتصال — ولا يُسقط الطلب إن فشل. */
export function auditOwnerImpersonationWrite(res: Response, f: OwnerImpersonationAuditFields, emit: (line: string) => void = defaultAuditEmit): void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    try {
      emit(ownerImpersonationAuditLine(f, res.headersSent ? res.statusCode : null));
    } catch {
      /* السجلّ لا يُسقط الطلب */
    }
  };
  res.once('finish', fire);
  res.once('close', fire);
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ─────────────────────────────────────────────────────────────────────────────
// الموجّه
// ─────────────────────────────────────────────────────────────────────────────

interface Ctx {
  tenantId: string;
  actorId: string;
  settings: SellerSettingsRecord;
}

export type ZatcaRouter = Router & {
  /** ينتظر انتهاء كل مهامّ الخلفية الجارية (للاختبارات والإيقاف). */
  idle(): Promise<void>;
};

function sendError(res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, code, message, ...extra });
}

function sendRouteError(res: Response, status: number, code: ZatcaRouteCode, extra: Record<string, unknown> = {}): void {
  sendError(res, status, code, ZATCA_ROUTE_CODES[code], extra);
}

function sendServiceError(res: Response, code: OnboardingCode, extra: Record<string, unknown> = {}): void {
  const meta = ONBOARDING_CODES[code];
  sendError(res, httpStatusForCode(code), code, meta.messageAr, { retryable: meta.retryable, needsNewOtp: meta.needsNewOtp, ...extra });
}

/** فشل الخدمة كما هو (كود، رسالة، علمان، الوحدة الآمنة، وتفاصيل آمنة) — بلا أي نصّ من الطلب. */
function sendFailure(res: Response, f: OnboardingFailure): void {
  sendError(res, httpStatusForCode(f.code), f.code, f.messageAr, {
    retryable: f.retryable, needsNewOtp: f.needsNewOtp, unit: f.unit ?? null,
    ...(f.issues ? { issues: f.issues } : {}), ...(f.field ? { field: f.field } : {}), ...(f.detail ? { detail: f.detail } : {}),
  });
}

const ctxOf = (res: Response): Ctx => res.locals.zatca as Ctx;

/** هل يحمل الطلب حقل otp بقيمة (أي قيمة غير فارغة — الصيغة الخاطئة محاولةُ رمز أيضاً)؟ يُقرأ قبل takeOtp الذي يحذفه. */
function carriesOtp(req: Request): boolean {
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : null;
  if (!b || !Object.prototype.hasOwnProperty.call(b, 'otp')) return false;
  return b.otp !== undefined && b.otp !== null && b.otp !== '';
}

const LOCKED = Symbol('locked');

/** وسيط مُحقن قد يكون متزامناً أو غير متزامن: أي رمي يصل next(err) (ثم zatcaErrorGuard) لا عمليةً معلّقة. */
function callMiddleware(mw: Middleware, req: Request, res: Response, next: NextFunction): void {
  try {
    Promise.resolve(mw(req as AuthRequest, res, next)).catch(next);
  } catch (e) {
    next(e);
  }
}

/** معالج غير متزامن: أي خطأ غير متوقَّع ⇒ 500 عامّ، ولا تُسجَّل رسالته (قد تحمل وسائط أو جسماً). */
function h(log: NonNullable<ZatcaRouteDeps['log']>, fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return (req: Request, res: Response): void => {
    fn(req as AuthRequest, res).catch((e: unknown) => {
      log('zatca.route.error', { name: e instanceof Error ? e.name.slice(0, 40) : typeof e, path: req.route?.path ?? null });
      if (!res.headersSent) sendRouteError(res, 500, 'SERVER_ERROR');
    });
  };
}

export function createZatcaRouter(deps: ZatcaRouteDeps): ZatcaRouter {
  const router = Router() as ZatcaRouter;
  const log = deps.log ?? ((event, fields) => console.warn(event, JSON.stringify(fields)));
  const audit = deps.audit ?? defaultAuditEmit;
  const leaseMs = deps.leaseMs ?? ONBOARDING_DEFAULTS.leaseMs;
  const policy: EnvironmentPolicy = { productionBackend: deps.config.productionBackend };
  const allowedEnvs = [...deps.config.allowedEnvs];
  const envAllowed = (env: string) => (allowedEnvs as string[]).includes(env);

  if (deps.config.issues.length) {
    log('zatca.config.allowed-envs', { issues: deps.config.issues.map(i => `${i.code}:${i.value}`).join(','), allowed: allowedEnvs.join(',') });
  }

  // ─── السجلّات داخل العملية ───
  const locks = new Set<string>();
  const jobs = new Map<string, JobRecord>(); // آخر مهمّة لكل وحدة
  const running = new Set<Promise<void>>();

  const pruneJobs = () => {
    const cutoff = deps.now().getTime() - JOB_RETENTION_MS;
    for (const [id, j] of jobs) if (j.state === 'finished' && j.finishedAt && j.finishedAt.getTime() < cutoff) jobs.delete(id);
    if (jobs.size > MAX_RETAINED_JOBS) {
      const finished = [...jobs.values()].filter(j => j.state === 'finished').sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
      for (const j of finished.slice(0, jobs.size - MAX_RETAINED_JOBS)) jobs.delete(j.unitId);
    }
  };

  const jobView = (j: JobRecord | undefined, tenantId: string): JobView | null =>
    j && j.tenantId === tenantId ? { id: j.id, kind: j.kind, state: j.state, startedAt: j.startedAt, finishedAt: j.finishedAt, outcome: j.outcome } : null;

  const unitPayload = (u: EgsUnitView, tenantId: string) => {
    const job = jobView(jobs.get(u.id), tenantId);
    const activity = unitActivity(u, job?.state === 'running', deps.now(), leaseMs);
    return { unit: u, job, activity, checklist: unitChecklist(u, activity) };
  };

  const withLock = async <T>(key: string, fn: () => Promise<T>): Promise<T | typeof LOCKED> => {
    if (locks.has(key)) return LOCKED;
    locks.add(key);
    try {
      return await fn();
    } finally {
      locks.delete(key);
    }
  };

  const keyringOr503 = (res: Response): SecretKeyring | null => {
    try {
      return deps.loadKeyring();
    } catch (e) {
      log('zatca.secrets.unavailable', { code: e instanceof SecretsError ? e.code : 'UNKNOWN' });
      sendServiceError(res, 'SECRETS_UNAVAILABLE');
      return null;
    }
  };

  const loadOwned = async (res: Response, rawId: unknown): Promise<EgsUnitRecord | null> => {
    const { tenantId } = ctxOf(res);
    const id = typeof rawId === 'string' ? rawId : '';
    const unit = UNIT_ID_RE.test(id) ? await deps.store.loadUnit(id) : null;
    if (!unit || unit.tenantId !== tenantId) {
      sendServiceError(res, 'UNIT_NOT_FOUND');
      return null;
    }
    return unit;
  };

  // حدّان منفصلان على مساري الربط والتجديد: طلب يحمل حقل otp (ولو بصيغة خاطئة) يُحتسب في حدّ الرمز وحده، و«متابعة الربط»
  // أو «إعادة المحاولة» بلا رمز في حدّ المتابعة الأسخى برسالته — فلا تحجب إعادةُ المحاولة بعد خطأ مؤقت إدخالَ الرمز ولا العكس.
  const otpLimit = deps.otpRateLimit ?? { windowMs: 15 * 60 * 1000, limit: 10 };
  const resumeLimit = deps.resumeRateLimit ?? { windowMs: 15 * 60 * 1000, limit: 60 };
  const otpLimiter = rateLimit({
    windowMs: otpLimit.windowMs,
    limit: otpLimit.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: Request) => !carriesOtp(req),
    keyGenerator: (req: Request) => `zatca-otp:tenant:${(req as AuthRequest).user?.tenantId ?? 'none'}`,
    handler: (_req: Request, res: Response) => sendRouteError(res, 429, 'OTP_RATE_LIMITED'),
  });
  const resumeLimiter = rateLimit({
    windowMs: resumeLimit.windowMs,
    limit: resumeLimit.limit,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: Request) => carriesOtp(req),
    keyGenerator: (req: Request) => `zatca-resume:tenant:${(req as AuthRequest).user?.tenantId ?? 'none'}`,
    handler: (_req: Request, res: Response) => sendRouteError(res, 429, 'RESUME_RATE_LIMITED'),
  });

  // ─── سلسلة الحراسة (قبل أي مسار) ───

  router.use((req, res, next) => { callMiddleware(deps.authenticate, req, res, next); });
  // جلسة دخول مالك المنصة: كل طلب كتابة (مقبولاً أو مرفوضاً في أي حارس لاحق أو فاشلاً) سطر تدقيق واحد عند انتهاء ردّه
  router.use((req, res, next) => {
    const u = (req as AuthRequest).user;
    if (u?.impersonated === true && !READ_METHODS.has(req.method)) {
      auditOwnerImpersonationWrite(res, { tenantId: u.tenantId, actorAdminId: u.id, ...zatcaWriteAction(req.method, req.path) }, audit);
    }
    next();
  });
  router.use((req, res, next) => {
    const u = (req as AuthRequest).user;
    if (!u || !COMPANY_ROLES.includes(u.role) || typeof u.tenantId !== 'string' || u.tenantId === '') {
      sendRouteError(res, 403, 'FORBIDDEN');
      return;
    }
    // مسار سريع قبل قراءة الحساب: توكن مشرف أو محاسب لا يصل إلى أي مسار ولو ملك canManageCompanySettings
    if (u.role !== ZATCA_ROLE) { sendRouteError(res, 403, 'COMPANY_ADMIN_ONLY'); return; }
    next();
  });
  router.use((req: Request, res: Response, next: NextFunction) => {
    (async () => {
      const r = req as AuthRequest;
      // الدور والصلاحية من القاعدة لا من التوكن (يعيش حتى 8 ساعات): مديرٌ خُفِّض إلى مشرف أو محاسب، أو نُزعت صلاحية إعداداته،
      // أو عُطِّل حسابه أو نُقل — يُمنع من الإيقاف النهائي والربط برمز فوراً لا عند انتهاء توكنه
      const admin = await deps.loadAdmin(r);
      if (!admin || admin.isActive !== true) { sendRouteError(res, 403, 'PERMISSION_DENIED'); return; }
      if (admin.tenantId !== r.user!.tenantId) { sendRouteError(res, 403, 'FORBIDDEN'); return; }
      if (admin.role !== ZATCA_ROLE) { sendRouteError(res, 403, 'COMPANY_ADMIN_ONLY'); return; }
      if (admin.canManageCompanySettings === false) { sendRouteError(res, 403, 'PERMISSION_DENIED'); return; }
      if (await deps.isScopeRestricted(r)) { sendRouteError(res, 403, 'SCOPED_ADMIN'); return; }
      const tenantId = r.user!.tenantId as string;
      if ((await deps.loadTenantFlag(tenantId)) !== true) { sendRouteError(res, 403, 'ZATCA_PHASE2_NOT_ALLOWED'); return; }
      const settings = await deps.store.loadSellerSettings(tenantId);
      if (!settings || settings.countryCode !== 'SA') { sendRouteError(res, 403, 'ZATCA_COUNTRY_NOT_SUPPORTED'); return; }
      // جلسة دخول مالك المنصة تكتب كالمدير الذي يمثّله توكنها (الشروط أعلاه من صفّه) — وactorId في ZatcaApiLog موسوم
      res.locals.zatca = { tenantId, actorId: zatcaActorId(r.user!), settings } satisfies Ctx;
      next();
    })().catch((e: unknown) => {
      log('zatca.gate.error', { name: e instanceof Error ? e.name.slice(0, 40) : typeof e });
      if (!res.headersSent) sendRouteError(res, 500, 'SERVER_ERROR');
    });
  });

  // ─── القراءة ───

  router.get('/overview', h(log, async (_req, res) => {
    pruneJobs();
    const { tenantId, settings } = ctxOf(res);
    const units = await deps.store.listUnits(tenantId);
    let secretsReady = true;
    try { deps.loadKeyring(); } catch { secretsReady = false; }
    res.json({
      success: true,
      data: {
        gate: { zatcaPhase2Enabled: true, countryCode: settings.countryCode },
        regime: settings.zatcaPhase2StartedAt ? 'PHASE2' : 'PHASE1',
        phase2StartedAt: settings.zatcaPhase2StartedAt,
        goLiveAvailable: false,
        goLiveUnavailableMessage: ZATCA_ROUTE_CODES.GO_LIVE_UNAVAILABLE,
        allowedEnvs,
        envConfigIssues: deps.config.issues.map(i => i.code),
        productionBackend: deps.config.productionBackend,
        secretsReady,
        seller: Object.fromEntries(SELLER_FIELDS.map(f => [f, settings[f] ?? null])),
        sellerIssues: sellerReadiness(settings),
        // عنوان الوحدة الذي يُكتب في طلب الشهادة حين لا يُدخل المدير «العنوان المختصر» (الإنشاء، وإعادة البناء بعد رفض، والتجديد)
        csrDefaultLocation: csrDefaultLocation(settings),
        currency: { currency: settings.currency, currencyOverride: settings.currencyOverride, isSar: settings.currency === 'SAR' && (settings.currencyOverride === null || settings.currencyOverride === 'SAR') },
        units: units.map(u => unitPayload(toEgsUnitView(u), tenantId)),
        constants: { retireConfirmationText: RETIRE_CONFIRMATION_TEXT, otpLength: 6, otpValidityMinutes: 60, pollIntervalMs: 2000 },
      },
    });
  }));

  router.get('/units/:id', h(log, async (req, res) => {
    const unit = await loadOwned(res, req.params.id);
    if (!unit) return;
    res.json({ success: true, data: unitPayload(toEgsUnitView(unit), ctxOf(res).tenantId) });
  }));

  // ─── بيانات البائع ───

  router.put('/seller', h(log, async (req, res) => {
    const { tenantId, settings: before } = ctxOf(res);
    const v = validateSellerBody(req.body);
    if (v.errors.length) { sendRouteError(res, 400, 'SELLER_INVALID', { fieldErrors: v.errors }); return; }
    if (Object.keys(v.patch).length > 0) {
      const written = await deps.writeSeller(tenantId, v.patch);
      if (!written) { sendServiceError(res, 'TENANT_NOT_FOUND'); return; }
    }
    const after = (await deps.store.loadSellerSettings(tenantId)) ?? { ...before, ...v.patch };
    const units = await deps.store.listUnits(tenantId);
    res.json({
      success: true,
      data: {
        seller: Object.fromEntries(SELLER_FIELDS.map(f => [f, after[f] ?? null])),
        sellerIssues: sellerReadiness(after),
        warnings: sellerWarnings(before, after, units),
      },
    });
  }));

  // ─── الوحدات ───

  router.post('/units', h(log, async (req, res) => {
    const { tenantId, actorId } = ctxOf(res);
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const env = b.environment;
    if (typeof env !== 'string' || !(ZATCA_ENVS as readonly string[]).includes(env)) { sendServiceError(res, 'INVALID_INPUT', { field: 'environment' }); return; }
    if (!envAllowed(env)) { sendServiceError(res, 'ENV_NOT_ALLOWED', { allowedEnvs }); return; }
    const extras: Record<'locationAddress' | 'industry' | 'branchName', string | undefined> = { locationAddress: undefined, industry: undefined, branchName: undefined };
    for (const k of ['locationAddress', 'industry', 'branchName'] as const) {
      const x = b[k];
      if (x === undefined || x === null || x === '') continue;
      if (typeof x !== 'string' || x.length > 200) { sendServiceError(res, 'INVALID_INPUT', { field: k }); return; }
      extras[k] = x.trim() || undefined;
    }
    const keyring = keyringOr503(res);
    if (!keyring) return;
    const result = await withLock(`create:${tenantId}:${env}`, () => createUnit({
      store: deps.store, policy, now: deps.now, tenantId, env: env as FatooraEnv, actorId, keyring,
      ...(extras.locationAddress ? { locationAddress: extras.locationAddress } : {}),
      ...(extras.industry ? { industry: extras.industry } : {}),
      ...(extras.branchName ? { branchName: extras.branchName } : {}),
    }));
    if (result === LOCKED) { sendRouteError(res, 409, 'JOB_RUNNING'); return; }
    if (!result.ok) { sendFailure(res, result); return; }
    res.status(201).json({ success: true, data: unitPayload(result.unit, tenantId) });
  }));

  const readCsrFields = (b: Record<string, unknown>): CsrFieldOverrides | null | 'invalid' => {
    const c = b.csrFields;
    if (c === undefined || c === null) return null;
    if (typeof c !== 'object' || Array.isArray(c)) return 'invalid';
    const out: CsrFieldOverrides = {};
    for (const k of ['locationAddress', 'industry', 'branchName'] as const) {
      const x = (c as Record<string, unknown>)[k];
      if (x === undefined || x === null || x === '') continue;
      if (typeof x !== 'string' || x.length > 200) return 'invalid';
      const t = x.trim();
      if (t) out[k] = t;
    }
    return Object.keys(out).length ? out : null;
  };

  /** يُقرأ OTP ويُحذف من الجسم فوراً — لا يبقى في الطلب لأي وسيط لاحق أو معالج أخطاء. */
  const takeOtp = (req: AuthRequest): { otp: string | null; invalid: boolean } => {
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : null;
    if (!b || !('otp' in b)) return { otp: null, invalid: false };
    const raw = b.otp;
    delete b.otp;
    if (raw === undefined || raw === null || raw === '') return { otp: null, invalid: false };
    if (typeof raw !== 'string') return { otp: null, invalid: true };
    const otp = latinDigits(raw.trim());
    return OTP_RE.test(otp) ? { otp, invalid: false } : { otp: null, invalid: true };
  };

  const startJob = (kind: 'onboard' | 'renew', unit: EgsUnitRecord, ctx: Ctx, otp: string | null, keyring: SecretKeyring, csrFields: CsrFieldOverrides | null): JobRecord | null => {
    const lockKey = `unit:${unit.id}`;
    if (locks.has(lockKey)) return null;
    locks.add(lockKey);
    pruneJobs();
    const job: JobRecord = {
      id: crypto.randomUUID(), kind, unitId: unit.id, tenantId: ctx.tenantId, state: 'running', startedAt: deps.now(), finishedAt: null, outcome: null,
    };
    jobs.set(unit.id, job);
    const common = {
      store: deps.store, policy, now: deps.now, unitId: unit.id, tenantId: ctx.tenantId, actorId: ctx.actorId, client: deps.clientFactory, keyring,
      ...(deps.signerFactory ? { signerFactory: deps.signerFactory } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
      ...(csrFields ? { csrFields } : {}),
    };
    const p = (async () => {
      let outcome: JobOutcome;
      try {
        const r = kind === 'onboard'
          ? await onboardUnit({ ...common, otp })
          : await renewUnit({ ...common, otp: otp as string });
        outcome = jobOutcomeOf(kind, r, otp);
      } catch (e) {
        log('zatca.job.error', { kind, name: e instanceof Error ? e.name.slice(0, 40) : typeof e });
        outcome = jobOutcomeOf(kind, { ok: false, code: 'INTERNAL', messageAr: ONBOARDING_CODES.INTERNAL.messageAr, retryable: false, needsNewOtp: false, unit: null }, otp);
      }
      job.outcome = outcome;
      job.finishedAt = deps.now();
      job.state = 'finished';
      locks.delete(lockKey);
    })();
    running.add(p);
    void p.finally(() => running.delete(p));
    return job;
  };

  router.post('/units/:id/onboard', otpLimiter, resumeLimiter, h(log, async (req, res) => {
    const { otp, invalid } = takeOtp(req);
    const ctx = ctxOf(res);
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    if (invalid) { sendServiceError(res, 'OTP_INVALID_FORMAT'); return; }
    const csrFields = readCsrFields(b);
    if (csrFields === 'invalid') { sendServiceError(res, 'INVALID_INPUT', { field: 'csrFields' }); return; }
    const unit = await loadOwned(res, req.params.id);
    if (!unit) return;
    if (!envAllowed(unit.environment)) { sendServiceError(res, 'ENV_NOT_ALLOWED', { allowedEnvs, unit: toEgsUnitView(unit) }); return; }
    if (locks.has(`unit:${unit.id}`)) { sendRouteError(res, 409, 'JOB_RUNNING', { unit: toEgsUnitView(unit) }); return; }
    if (!ONBOARDABLE.has(unit.status)) { sendServiceError(res, 'INVALID_STATE', { unit: toEgsUnitView(unit), detail: `status:${unit.status}` }); return; }
    // عامل آخر (عملية أخرى أو نسخة خادم) يعمل على الوحدة داخل مهلة الإيجار: لا مهمّة تفشل فوراً ولا رمز يُحرق
    if (unitActivity(toEgsUnitView(unit), false, deps.now(), leaseMs).busy) { sendServiceError(res, 'IN_PROGRESS', { unit: toEgsUnitView(unit) }); return; }
    const needOtp = OTP_NEEDED.has(unit.status);
    if (needOtp && !otp) { sendServiceError(res, 'OTP_REQUIRED', { unit: toEgsUnitView(unit) }); return; }
    const keyring = keyringOr503(res);
    if (!keyring) return;
    const job = startJob('onboard', unit, ctx, needOtp ? otp : null, keyring, csrFields);
    if (!job) { sendRouteError(res, 409, 'JOB_RUNNING', { unit: toEgsUnitView(unit) }); return; }
    res.status(202).json({ success: true, data: unitPayload(toEgsUnitView(unit), ctx.tenantId) });
  }));

  router.post('/units/:id/renew', otpLimiter, resumeLimiter, h(log, async (req, res) => {
    const { otp, invalid } = takeOtp(req);
    const ctx = ctxOf(res);
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    if (invalid) { sendServiceError(res, 'OTP_INVALID_FORMAT'); return; }
    if (!otp) { sendServiceError(res, 'OTP_REQUIRED'); return; }
    const csrFields = readCsrFields(b);
    if (csrFields === 'invalid') { sendServiceError(res, 'INVALID_INPUT', { field: 'csrFields' }); return; }
    const unit = await loadOwned(res, req.params.id);
    if (!unit) return;
    if (!envAllowed(unit.environment)) { sendServiceError(res, 'ENV_NOT_ALLOWED', { allowedEnvs, unit: toEgsUnitView(unit) }); return; }
    if (locks.has(`unit:${unit.id}`)) { sendRouteError(res, 409, 'JOB_RUNNING', { unit: toEgsUnitView(unit) }); return; }
    if (!RENEWABLE.has(unit.status)) { sendServiceError(res, 'INVALID_STATE', { unit: toEgsUnitView(unit), detail: `status:${unit.status}` }); return; }
    if (unitActivity(toEgsUnitView(unit), false, deps.now(), leaseMs).busy) { sendServiceError(res, 'IN_PROGRESS', { unit: toEgsUnitView(unit) }); return; }
    const keyring = keyringOr503(res);
    if (!keyring) return;
    const job = startJob('renew', unit, ctx, otp, keyring, csrFields);
    if (!job) { sendRouteError(res, 409, 'JOB_RUNNING', { unit: toEgsUnitView(unit) }); return; }
    res.status(202).json({ success: true, data: unitPayload(toEgsUnitView(unit), ctx.tenantId) });
  }));

  router.post('/units/:id/abort-renewal', h(log, async (req, res) => {
    const ctx = ctxOf(res);
    const unit = await loadOwned(res, req.params.id);
    if (!unit) return;
    const result = await withLock(`unit:${unit.id}`, () => abortRenewal({
      store: deps.store, policy, now: deps.now, unitId: unit.id, tenantId: ctx.tenantId, actorId: ctx.actorId,
      ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
    }));
    if (result === LOCKED) { sendRouteError(res, 409, 'JOB_RUNNING', { unit: toEgsUnitView(unit) }); return; }
    if (!result.ok) { sendFailure(res, result); return; }
    res.json({ success: true, data: unitPayload(result.unit, ctx.tenantId) });
  }));

  router.post('/units/:id/retire', h(log, async (req, res) => {
    const ctx = ctxOf(res);
    const b = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
    const reason = b.reason;
    if (typeof reason !== 'string' || !(RETIRE_REASONS as readonly string[]).includes(reason)) { sendServiceError(res, 'INVALID_INPUT', { field: 'reason' }); return; }
    const confirmation = typeof b.confirmation === 'string' ? b.confirmation.trim() : '';
    if (confirmation !== RETIRE_CONFIRMATION_TEXT) { sendServiceError(res, 'RETIRE_CONFIRMATION_REQUIRED'); return; }
    const unit = await loadOwned(res, req.params.id);
    if (!unit) return;
    const result = await withLock(`unit:${unit.id}`, () => retireUnit({
      store: deps.store, policy, now: deps.now, unitId: unit.id, tenantId: ctx.tenantId, actorId: ctx.actorId, reason: reason as RetireReason,
      typedConfirmation: confirmation, ...(deps.leaseMs !== undefined ? { leaseMs: deps.leaseMs } : {}),
    }));
    if (result === LOCKED) { sendRouteError(res, 409, 'JOB_RUNNING', { unit: toEgsUnitView(unit) }); return; }
    if (!result.ok) { sendFailure(res, result); return; }
    res.json({ success: true, data: { ...unitPayload(result.unit, ctx.tenantId), alreadyRetired: result.alreadyRetired } });
  }));

  // ─── التفعيل: غير متاح قبل Z5 ───

  router.post('/go-live', (_req, res) => {
    sendRouteError(res, 409, 'GO_LIVE_UNAVAILABLE');
  });

  router.idle = async () => {
    while (running.size) await Promise.allSettled([...running]);
  };

  return router;
}

/**
 * يُركَّب على مستوى التطبيق بعد الموجّه (app.use('/api/zatca', router, zatcaErrorGuard)): خطأ تحليل الجسم (JSON تالف
 * قد تحمل رسالته مقطعاً من الجسم نفسه — أي OTP) يُردّ 400 دون أن يصل معالج الأخطاء العامّ الذي يطبع err.message.
 */
export function zatcaErrorGuard(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 500;
  if (e && typeof e.type === 'string' && status >= 400 && status < 500) {
    sendRouteError(res, status, 'INVALID_JSON');
    return;
  }
  console.warn('zatca.unhandled', err instanceof Error ? err.name.slice(0, 40) : typeof err);
  sendRouteError(res, 500, 'SERVER_ERROR');
}
