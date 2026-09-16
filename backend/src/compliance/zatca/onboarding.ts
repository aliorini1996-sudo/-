// ============================================================================
// ZATCA المرحلة الثانية (Z4) — خدمة ربط وحدة EGS: إنشاء، ربط، تجديد، تفعيل، إيقاف
// ----------------------------------------------------------------------------
// design §3 Z4 (آلة الحالات، onboardUnit 1–5، renewUnit 1–6، goLive) + report_apis-onboarding §8/§9.
// تنسيق نقيّ فوق اعتماديات مُحقنة: EgsUnitStore (onboardingStore.ts)، مصنع FatooraClient، حلقة مفاتيح التشفير،
// الساعة، مصنع الموقِّع، والنوم. لا شبكة ولا قاعدة بيانات ولا متغيّرات بيئة هنا (حلقة المفاتيح تُمرَّر جاهزة).
//
// آلة الحالات كما بُنيت (كل انتقال يُحفظ أولاً بـcompare-and-set على الحالة + updatedAt كرمز نسخة):
//   createUnit ─(بيانات البائع صالحة، مفتاح + CSR، لا وحدة مانعة — ذرّياً في المخزن)─► CSR_READY
//   CSR_READY ─POST /compliance ISSUED─► CCSID_ISSUED        (Invalid-OTP/RETRY ⇒ يبقى CSR_READY؛ رفض الطلب نفسه ⇒ ERROR_NEEDS_OTP)
//   CCSID_ISSUED ─(مطالبة)─► CHECKS_RUNNING ─(كل الخطوات PASS/WARNING)─► CHECKS_PASSED
//   CHECKS_RUNNING ─REJECTED أو 401 أو سرّ مخزَّن تالف─► ERROR_NEEDS_OTP ─RETRY/إعداد/بيانات ناقصة─► CCSID_ISSUED (استئناف بلا OTP)
//   CHECKS_PASSED ─POST /production/csids ISSUED + ربط الشهادة─► ACTIVE   (Missing-ComplianceSteps ⇒ CCSID_ISSUED)
//   ERROR_NEEDS_OTP ─(OTP جديد: مفتاح + CSR جديدان من بيانات المنشأة الحالية)─► CSR_READY ─► …
//   ACTIVE|EXPIRED ─renewUnit─► RENEWING ─(200 | 428 → فحوص → POST)─► ACTIVE (تبديل ذرّي، keyVersion+1)
//   RENEWING ─فشل قبل أي طلب قد يُصدر شهادة إنتاج─► الحالة الأصل؛ 401 بشهادة الإنتاج ⇒ AUTH_FAILED (من ACTIVE)
//   RENEWING ─فشل بعد PATCH/POST قد يُصدر─► RENEWING «غير مؤكَّد» (يوقف الإصدار؛ لا عودة إلى اعتماد ربما أُبطل)
//   RENEWING ─شهادة إنتاج صدرت لكنها لا تصلح (فكّ/ربط/صلاحية)─► AUTH_FAILED
//   RENEWING (ميّت أو متوقّف قبل أي إرسال) ─abortRenewal بلا OTP─► الحالة الأصل
//   أي حالة غير جارية ─retireUnit─► REVOKED (نهائية؛ الربط من جديد بوحدة جديدة وسلسلة جديدة)
// • OTP في الذاكرة فقط: لا يُحفظ ولا يُسجَّل ولا يعود في نتيجة. الأسرار تُفكّ لحظة الاستعمال فقط.
// • «جارٍ» = عقد إيجار على updatedAt (leaseMs): CHECKS_RUNNING وRENEWING بحالتيهما، وطلبا الشهادة (POST /compliance،
//   POST /production/csids) بعلامة inFlight في complianceSteps تُكتب مع المطالبة قبل الشبكة. استدعاء آخر يرفض IN_PROGRESS
//   ما دامت آخر كتابة أحدث من المهلة، وبعدها يستولي بـCAS على النسخة (عامل مات). كل خطوة فحص وكل دورة انتظار نبض.
// • بعد أن تُصدر الهيئة شهادة: الحفظ يُعاد بمهل متزايدة (persistRetryDelaysMs) ولا تُهمل الشهادة لخطأ مخزن عابر.
// • التجديد يحفظ مرحلته (renewal في complianceSteps) **قبل** كل طلب قد يُصدر شهادة إنتاج (PATCH، ثم POST في مسار
//   428)، فعامل مات أو كتابة فشلت لا تعيد الوحدة أبداً إلى ACTIVE على اعتماد ربما أبطله التجديد (report §9).
//   egs-key-pending غير مستعمل: الرمز والسرّ الجديدان لا يوجدان إلا في ردّ الهيئة، فحفظ المفتاح وحده لا يستعيدهما بعد
//   انقطاع؛ الأمان يأتي من علامة المرحلة، والمفتاح الجديد يُختم (egs-key) قبل المطالبة ليُكشف عطل حلقة المفاتيح مبكراً.
// • كل دالة مُصدَّرة تعيد نتيجة مصنَّفة { ok } برمز ثابت ورسالة عربية — لا ترمي، ولا تنقل رسالة خطأ داخلي،
//   وكل نصّ فيها (detail مثلاً) يُمسح من OTP والأسرار قبل أن يعود أو يُسجَّل.
// ============================================================================

import crypto from 'crypto';
import { ApiLogEntry, Creds, FatooraClient, FatooraEnv, FatooraInputError, FATOORA_BASE_URLS, decodeCsid } from './api';
import { CsidCert, CsidCertError } from './cert';
import {
  ComplianceSample, ComplianceSampleError, ComplianceStep, buildComplianceSamples, complianceInvoiceSource, complianceSpecsFor,
} from './complianceSamples';
import { INITIAL_PIH } from './crypto';
import { ZatcaInputError } from './model';
import { preflightIssues } from './preflight';
import { CsrError, CsrParams, FUNCTION_MAPS, FunctionMap, assertZatcaCsr, buildCsr, egsCommonName, egsSerialNumber, validateCsrParams } from './csr';
import { CsidBindingIssue, csidBindingIssue } from './csidBinding';
import { SellerSource, mapInvoiceToUbl, mapSellerParty } from './mapInvoice';
import {
  ApiLogRow, EgsUnitPatch, EgsUnitRecord, EgsUnitStatus, EgsUnitStore, NewEgsUnit, SellerSettingsRecord,
} from './onboardingStore';
import { CsidOutcome, CsidResult, Msg, Outcome, RetryReason, SecretMatcher, compileSecrets } from './responses';
import { SecretKeyring, SecretsError, SecretsErrorCode, decryptSecret, decryptSecretBytes, encryptSecret } from './secrets';
import { HashSigner, createServerSigner } from './stamp';
import { IssueLike, sellerIssues } from './validators';

// ─────────────────────────────────────────────────────────────────────────────
// ثوابت
// ─────────────────────────────────────────────────────────────────────────────

export const ONBOARDING_DEFAULTS = Object.freeze({
  /** مدة اعتبار عملية «جارية» منذ آخر كتابة (6 فحوص × 60 ث أقصى + هامش). */
  leaseMs: 10 * 60 * 1000,
  /** design renewUnit خطوة 2: انتظار المستندات الجارية حتى 10 دقائق. */
  inFlightTimeoutMs: 10 * 60 * 1000,
  pollIntervalMs: 5000,
  /** بعد إصدار الهيئة شهادةً: انتظار قبل كل إعادة لحفظها (خطأ مخزن عابر لا يُهمل الشهادة). */
  persistRetryDelaysMs: Object.freeze([250, 1000, 4000]) as readonly number[],
  /** OU الافتراضي لوحدة خادم بلا اسم فرع. UNVERIFIED: لا قيد معروف على نصّ OU غير المحارف والطول. */
  branchName: 'Main Branch',
  /** businessCategory الافتراضي (نصّ حرّ عن القطاع — report §7.2). */
  industry: 'Wholesale Distribution',
});

/** design renewUnit خطوة 2 + Z5.4: مستندات لم تُحسم بعد على الوحدة. */
export const IN_FLIGHT_DOCUMENT_STATUSES: readonly string[] = Object.freeze(['SIGNED', 'SUBMITTING', 'RETRY_WAIT']);

/** design §5.1 خطوة 5: يكتب المدير «تفعيل» للتأكيد. */
export const GO_LIVE_CONFIRMATION_TEXT = 'تفعيل';

/** retireUnit لوحدة تحمل شهادة إنتاج: يكتب المدير «إيقاف» للتأكيد. */
export const RETIRE_CONFIRMATION_TEXT = 'إيقاف';

/** وحدة في هذه الحالات تمنع إنشاء وحدة أخرى للشركة في البيئة نفسها (v1: سلسلة واحدة لكل شركة — design Z5.3). */
export const UNIT_BLOCKING_STATUSES: readonly EgsUnitStatus[] = Object.freeze([
  'CSR_READY', 'CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED', 'ERROR_NEEDS_OTP', 'ACTIVE', 'RENEWING',
] as EgsUnitStatus[]);

/** حالات تحمل شهادة إنتاج صدرت يوماً: إيقافها يحتاج تأكيداً مكتوباً. */
const PRODUCTION_HOLDING_STATUSES: readonly string[] = Object.freeze(['ACTIVE', 'RENEWING', 'EXPIRED', 'AUTH_FAILED']);

const ENVS: readonly FatooraEnv[] = Object.freeze(Object.keys(FATOORA_BASE_URLS) as FatooraEnv[]);
const OTP_RE = /^[0-9]{6}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_LAST_ERROR_CHARS = 500;
const MAX_STEP_MESSAGES = 20;

// ─────────────────────────────────────────────────────────────────────────────
// النتائج والأكواد
// ─────────────────────────────────────────────────────────────────────────────

export type OnboardingCode =
  | 'INVALID_INPUT' | 'TENANT_NOT_FOUND' | 'UNIT_NOT_FOUND' | 'UNIT_EXISTS' | 'OTHER_UNIT_EXISTS' | 'COUNTRY_NOT_SUPPORTED'
  | 'SELLER_DATA_INCOMPLETE' | 'SELLER_VAT_CHANGED' | 'CSR_PARAMS_INVALID' | 'ENV_NOT_ALLOWED' | 'ENV_MISMATCH'
  | 'SECRETS_UNAVAILABLE' | 'STORED_SECRET_INVALID' | 'INVALID_STATE' | 'IN_PROGRESS' | 'CONCURRENT_MODIFICATION'
  | 'OTP_REQUIRED' | 'OTP_INVALID_FORMAT' | 'NEW_OTP_REQUIRED' | 'CSID_REQUEST_REJECTED' | 'CSID_CERT_INVALID'
  | 'CERT_BINDING_MISMATCH' | 'SIGNER_FAILED' | 'SAMPLES_FAILED' | 'COMPLIANCE_CHECK_REJECTED' | 'COMPLIANCE_STEPS_MISSING'
  | 'CCSID_AUTH_FAILED' | 'PRODUCTION_CSID_REJECTED' | 'PRODUCTION_AUTH_FAILED' | 'IN_FLIGHT_TIMEOUT'
  | 'CREDENTIALS_NOT_SAVED' | 'RENEWAL_UNCONFIRMED'
  | 'ZATCA_RETRY' | 'ZATCA_CONFIG' | 'NO_ACTIVE_UNIT' | 'MULTIPLE_ACTIVE_UNITS' | 'CERT_EXPIRED' | 'CURRENCY_NOT_SAR'
  | 'CONFIRMATION_REQUIRED' | 'RETIRE_CONFIRMATION_REQUIRED' | 'STORE_ERROR' | 'INTERNAL';

interface CodeMeta {
  messageAr: string;
  retryable: boolean;
  needsNewOtp: boolean;
}

/** الرسالة العربية وعلَما الإرشاد الافتراضيان لكل كود (قد تُعدِّل الحالة العلَمين). */
export const ONBOARDING_CODES: Readonly<Record<OnboardingCode, Readonly<CodeMeta>>> = Object.freeze({
  INVALID_INPUT: { messageAr: 'مدخلات غير صالحة لطلب ربط الفوترة الإلكترونية', retryable: false, needsNewOtp: false },
  TENANT_NOT_FOUND: { messageAr: 'إعدادات الشركة غير موجودة', retryable: false, needsNewOtp: false },
  UNIT_NOT_FOUND: { messageAr: 'وحدة الفوترة الإلكترونية غير موجودة', retryable: false, needsNewOtp: false },
  UNIT_EXISTS: { messageAr: 'توجد وحدة فوترة إلكترونية قيد الربط أو مفعّلة في هذه البيئة — أكمل ربطها أو جدّدها بدل إنشاء وحدة جديدة', retryable: false, needsNewOtp: false },
  OTHER_UNIT_EXISTS: { messageAr: 'توجد وحدة فوترة إلكترونية أخرى قيد الربط أو مفعّلة في هذه البيئة — لا تعمل وحدتان معاً؛ أوقف الزائدة أولاً', retryable: false, needsNewOtp: false },
  COUNTRY_NOT_SUPPORTED: { messageAr: 'المرحلة الثانية متاحة للمنشآت السعودية المضبوط مزوّد فوترتها على هيئة الزكاة والضريبة والجمارك فقط', retryable: false, needsNewOtp: false },
  SELLER_DATA_INCOMPLETE: { messageAr: 'بيانات المنشأة للفوترة الإلكترونية ناقصة أو غير صحيحة — أكمل الحقول المذكورة ثم أعد المحاولة', retryable: false, needsNewOtp: false },
  SELLER_VAT_CHANGED: { messageAr: 'الرقم الضريبي في إعدادات الشركة لا يطابق الرقم الذي رُبطت به الوحدة — الرقم الجديد يحتاج وحدة جديدة', retryable: false, needsNewOtp: false },
  CSR_PARAMS_INVALID: { messageAr: 'بيانات طلب الشهادة غير مقبولة — صحّح الحقل المذكور', retryable: false, needsNewOtp: false },
  ENV_NOT_ALLOWED: { messageAr: 'بيئة الربط هذه غير مسموحة على هذا الخادم', retryable: false, needsNewOtp: false },
  ENV_MISMATCH: { messageAr: 'إعداد الاتصال بالهيئة لا يطابق بيئة الوحدة', retryable: false, needsNewOtp: false },
  SECRETS_UNAVAILABLE: { messageAr: 'تعذّر الوصول إلى مفاتيح التشفير على الخادم — تواصل مع دعم المنصّة', retryable: false, needsNewOtp: false },
  STORED_SECRET_INVALID: { messageAr: 'بيانات الوحدة المشفّرة تالفة ولا يمكن فكّها — أدخل رمز تحقق جديداً لتوليد مفتاح وطلب شهادة جديدين', retryable: false, needsNewOtp: true },
  INVALID_STATE: { messageAr: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية لوحدة الفوترة الإلكترونية', retryable: false, needsNewOtp: false },
  IN_PROGRESS: { messageAr: 'عملية أخرى جارية على هذه الوحدة — انتظر قليلاً ثم حدّث الصفحة', retryable: true, needsNewOtp: false },
  CONCURRENT_MODIFICATION: { messageAr: 'تغيّرت حالة الوحدة أثناء التنفيذ بسبب عملية متزامنة — حدّث الصفحة', retryable: true, needsNewOtp: false },
  OTP_REQUIRED: { messageAr: 'أدخل رمز التحقق (OTP) المولَّد من بوابة فاتورة', retryable: false, needsNewOtp: true },
  OTP_INVALID_FORMAT: { messageAr: 'رمز التحقق يجب أن يكون ستة أرقام', retryable: false, needsNewOtp: false },
  NEW_OTP_REQUIRED: { messageAr: 'رمز التحقق غير صحيح أو منتهٍ أو مستعمَل — ولّد رمزاً جديداً من بوابة فاتورة وأدخله خلال ساعة', retryable: false, needsNewOtp: true },
  CSID_REQUEST_REJECTED: { messageAr: 'رفضت الهيئة طلب الشهادة — راجع التفاصيل وصحّح بيانات المنشأة ثم أدخل رمز تحقق جديداً (يُبنى طلب جديد)', retryable: false, needsNewOtp: true },
  CSID_CERT_INVALID: { messageAr: 'الشهادة التي أعادتها الهيئة غير صالحة ولم تُحفظ', retryable: false, needsNewOtp: true },
  CERT_BINDING_MISMATCH: { messageAr: 'الشهادة التي أعادتها الهيئة لا تخصّ هذه الوحدة (المفتاح أو الرقم الضريبي مختلف) ولم تُحفظ', retryable: false, needsNewOtp: true },
  SIGNER_FAILED: { messageAr: 'تعذّر تجهيز مفتاح التوقيع للوحدة', retryable: false, needsNewOtp: false },
  SAMPLES_FAILED: { messageAr: 'تعذّر تجهيز فواتير فحص الامتثال', retryable: false, needsNewOtp: false },
  COMPLIANCE_CHECK_REJECTED: { messageAr: 'رفضت الهيئة إحدى فواتير فحص الامتثال — صحّح الأسباب المذكورة ثم ابدأ الربط برمز تحقق جديد', retryable: false, needsNewOtp: true },
  COMPLIANCE_STEPS_MISSING: { messageAr: 'لم تسجّل الهيئة اكتمال فحوص الامتثال — أعد المحاولة لتُعاد الفحوص دون رمز جديد', retryable: true, needsNewOtp: false },
  CCSID_AUTH_FAILED: { messageAr: 'رفضت الهيئة شهادة الامتثال — ابدأ الربط برمز تحقق جديد', retryable: false, needsNewOtp: true },
  PRODUCTION_CSID_REJECTED: { messageAr: 'رفضت الهيئة إصدار شهادة الإنتاج — ابدأ الربط برمز تحقق جديد', retryable: false, needsNewOtp: true },
  PRODUCTION_AUTH_FAILED: { messageAr: 'رفضت الهيئة شهادة الإنتاج الحالية — تحقّق من حالة الوحدة في بوابة فاتورة؛ قد يلزم ربط وحدة جديدة', retryable: false, needsNewOtp: false },
  IN_FLIGHT_TIMEOUT: { messageAr: 'ما زالت فواتير بانتظار الإرسال للهيئة — أعد محاولة التجديد بعد دقائق', retryable: true, needsNewOtp: false },
  CREDENTIALS_NOT_SAVED: { messageAr: 'أصدرت الهيئة الشهادة لكن تعذّر حفظها على الخادم فلم تُعتمد — أعد المحاولة بعد دقائق، وقد يلزم رمز تحقق جديد', retryable: false, needsNewOtp: true },
  RENEWAL_UNCONFIRMED: { messageAr: 'تعذّر التأكّد من نتيجة التجديد لدى الهيئة فأُوقف إصدار الفواتير على هذه الوحدة احتياطاً — أعد التجديد برمز تحقق؛ وإن رفضت الهيئة الشهادة الحالية فيلزم ربط وحدة جديدة', retryable: false, needsNewOtp: true },
  ZATCA_RETRY: { messageAr: 'تعذّر الاتصال بمنصّة فاتورة مؤقتاً — أعد المحاولة بعد قليل', retryable: true, needsNewOtp: false },
  ZATCA_CONFIG: { messageAr: 'ردّ غير متوقَّع من منصّة فاتورة — سُجّل للمراجعة', retryable: false, needsNewOtp: false },
  NO_ACTIVE_UNIT: { messageAr: 'لا توجد وحدة فوترة إلكترونية مفعّلة في بيئة الإنتاج', retryable: false, needsNewOtp: false },
  MULTIPLE_ACTIVE_UNITS: { messageAr: 'توجد أكثر من وحدة مفعّلة في بيئة الإنتاج — أوقف الزائدة قبل التفعيل', retryable: false, needsNewOtp: false },
  CERT_EXPIRED: { messageAr: 'شهادة الوحدة منتهية الصلاحية — جدّدها أولاً', retryable: false, needsNewOtp: false },
  CURRENCY_NOT_SAR: { messageAr: 'عملة الفوترة يجب أن تكون الريال السعودي (SAR) في المرحلة الثانية', retryable: false, needsNewOtp: false },
  CONFIRMATION_REQUIRED: { messageAr: `أكّد أن كل المناديب زامنوا أجهزتهم واكتب «${GO_LIVE_CONFIRMATION_TEXT}» للمتابعة`, retryable: false, needsNewOtp: false },
  RETIRE_CONFIRMATION_REQUIRED: { messageAr: `اكتب «${RETIRE_CONFIRMATION_TEXT}» لتأكيد إيقاف الوحدة نهائياً — لا تصدر بها فواتير بعد ذلك`, retryable: false, needsNewOtp: false },
  STORE_ERROR: { messageAr: 'تعذّر حفظ بيانات الوحدة — أعد المحاولة', retryable: true, needsNewOtp: false },
  INTERNAL: { messageAr: 'خطأ داخلي غير متوقَّع — سُجّل للمراجعة', retryable: false, needsNewOtp: false },
});

export interface StepMessage {
  type: 'ERROR' | 'WARNING';
  code: string | null;
  message: string | null;
}

export interface OnboardingFailure {
  ok: false;
  code: OnboardingCode;
  messageAr: string;
  /** إعادة المحاولة لاحقاً قد تنجح دون تغيير بيانات أو رمز. */
  retryable: boolean;
  /** يلزم رمز OTP جديد من بوابة فاتورة. */
  needsNewOtp: boolean;
  /** حالة الوحدة بعد العملية (null إن لم تُعرف). */
  unit: EgsUnitView | null;
  /** رمز تقني ثابت آمن بلا قيم (مثل Invalid-OTP، retry:timeout، ccsid:PUBLIC_KEY). */
  detail?: string;
  field?: string;
  step?: ComplianceStep;
  issues?: IssueLike[];
  zatcaMessages?: StepMessage[];
}

export type OnboardingResult<T extends object> = ({ ok: true } & T) | OnboardingFailure;

export interface ComplianceStepRecord {
  status: 'PASS' | 'WARNING' | 'REJECTED' | 'RETRY' | 'AUTH' | 'CONFIG';
  at: string;
  warnings: StepMessage[];
  errors: StepMessage[];
  /** عدّادا التصعيد (EscalationCounts) لهذه الخطوة عبر الاستئنافات. */
  priorEmpty400: number;
  priorPayload413: number;
  detail: string | null;
}

/** طلب شهادة جارٍ: POST /compliance (من CSR_READY) أو POST /production/csids (من CHECKS_PASSED). */
export type InFlightOp = 'compliance' | 'production-csid';

type Origin = 'ACTIVE' | 'EXPIRED';

/**
 * مرحلة التجديد المحفوظة:
 *   waiting          انتظار المستندات الجارية (لم يُرسل شيء)
 *   patch-sent       كُتبت قبل PATCH مباشرة — قد تكون الهيئة أصدرت شهادة إنتاج وأبطلت الحالية
 *   checks           428: شهادة امتثال للمفتاح الجديد، والفحوص جارية (لا شهادة إنتاج جديدة بعد)
 *   production-sent  كُتبت قبل POST /production/csids في مسار 428 — قد تكون صدرت
 *   unconfirmed      توقّف بعد طلب قد يُصدر ولم يُحفظ ناتجه: الإصدار موقوف حتى تجديد مؤكَّد أو إيقاف الوحدة
 *   done | aborted   منتهية (نجاح أو عودة) — لا أثر لها على الاستئناف
 */
export type RenewalStage = 'waiting' | 'patch-sent' | 'checks' | 'production-sent' | 'unconfirmed' | 'done' | 'aborted';
const RENEWAL_STAGES: readonly RenewalStage[] = Object.freeze(['waiting', 'patch-sent', 'checks', 'production-sent', 'unconfirmed', 'done', 'aborted'] as RenewalStage[]);

/**
 * ZatcaEgsUnit.complianceSteps — تقدّم فحوص الامتثال للواجهة (design §5.1 خطوة 4). design كتب مثالاً مسطّحاً
 * {"standard-compliant":"PASS"}؛ الكائن هنا يضيف التحذيرات والنسخة ومعرّف طلب CCSID الذي تخصّه الخطوات، وعلامتَي
 * «طلب جارٍ» و«مرحلة التجديد» (بلا معرّف المحاولة الداخلي في العرض).
 */
export interface ComplianceProgress {
  v: 1;
  phase: 'onboarding' | 'renewal';
  keyVersion: number;
  requestId: string | null;
  steps: Partial<Record<ComplianceStep, ComplianceStepRecord>>;
  inFlight?: { op: InFlightOp; at: string };
  renewal?: { origin: Origin; stage: RenewalStage; uncertain: boolean; at: string };
}

interface StoredInFlight {
  op: InFlightOp;
  attemptId: string;
  at: string;
}

interface StoredRenewal {
  origin: Origin;
  stage: RenewalStage;
  /** محاولة سابقة ربما أصدرت شهادة إنتاج لم تُحفظ: لا عودة إلى الأصل حتى نتيجة قاطعة. */
  uncertain: boolean;
  attemptId: string;
  at: string;
}

interface StoredProgress extends Omit<ComplianceProgress, 'inFlight' | 'renewal'> {
  inFlight?: StoredInFlight;
  renewal?: StoredRenewal;
}

/** عرض الوحدة الآمن للواجهة: بلا مفتاح خاص ولا أسرار ولا رموز ولا CSR. */
export interface EgsUnitView {
  id: string;
  tenantId: string;
  environment: string;
  status: string;
  commonName: string;
  serialNumber: string;
  functionMap: string;
  orgName: string;
  orgUnit: string;
  vatNumber: string;
  locationAddress: string;
  industry: string;
  keyVersion: number;
  publicKeyPem: string | null;
  complianceRequestId: string | null;
  complianceProgress: ComplianceProgress | null;
  certSerial: string | null;
  certNotBefore: Date | null;
  certNotAfter: Date | null;
  lastIcv: number;
  activatedAt: Date | null;
  revokedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// الاعتماديات
// ─────────────────────────────────────────────────────────────────────────────

/** حارس البيئة (design Z4 خطوة 5): خادم الإنتاج لا يستعمل وحدات sandbox، ولا يصدر فواتير حيّة إلا بوحدة production. */
export interface EnvironmentPolicy {
  productionBackend: boolean;
}

/** يبني عميل «فاتورة» بسجلّ تربطه الخدمة بالشركة والوحدة والمنفّذ. الإنتاج: defaultFatooraClientFactory. */
export type FatooraClientFactory = (opts: { env: FatooraEnv; log: (entry: ApiLogEntry) => Promise<void> }) => FatooraClient;

/** يستعمل globalThis.fetch — لا يُستدعى في الاختبارات (حارس الشبكة). */
export const defaultFatooraClientFactory: FatooraClientFactory = ({ env, log }) => new FatooraClient({ env, log });

export type SignerFactory = (privateKey: crypto.KeyObject) => HashSigner | Promise<HashSigner>;

/**
 * حقول CSR التي يختارها المدير (لا تأتي من إعدادات المنشأة). غيابها: OU والقطاع من الوحدة؛ والعنوان من الوحدة في CSR_READY،
 * ومن عنوان المنشأة الحالي عند إعادة البناء (ERROR_NEEDS_OTP) والتجديد (design §5.1 خطوة 9: العنوان القديم يُحدَّث بالتجديد).
 */
export interface CsrFieldOverrides {
  /** registeredAddress ≤ 64. */
  locationAddress?: string;
  industry?: string;
  /** OU لغير المجموعات الضريبية. */
  branchName?: string;
}

interface BaseInput {
  store: EgsUnitStore;
  policy: EnvironmentPolicy;
  /** الساعة (افتراضياً new Date()). */
  now?: () => Date;
}

export interface CreateUnitInput extends BaseInput {
  tenantId: string;
  env: FatooraEnv;
  actorId: string;
  keyring: SecretKeyring;
  /** جزء CN بعد الرقم الضريبي (افتراضياً أول 8 محارف من معرّف الوحدة). */
  unitShortId?: string;
  /** OU لغير المجموعات الضريبية. */
  branchName?: string;
  industry?: string;
  /** registeredAddress ≤ 64 (العنوان المختصر). افتراضياً من عنوان المنشأة. */
  locationAddress?: string;
  /** مولّد معرّف الوحدة (UUID) — للاختبار. */
  newUnitId?: () => string;
}

export interface OnboardUnitInput extends BaseInput {
  unitId: string;
  /** إن مُرِّر: الوحدة يجب أن تخصّ هذه الشركة (المسارات تمرّره دائماً). */
  tenantId?: string;
  /** مطلوب في CSR_READY وERROR_NEEDS_OTP فقط؛ الاستئناف بعد CCSID لا يحتاجه. */
  otp?: string | null;
  actorId: string;
  client: FatooraClientFactory;
  keyring: SecretKeyring;
  signerFactory?: SignerFactory;
  leaseMs?: number;
  csrFields?: CsrFieldOverrides;
  /** للانتظار بين محاولات حفظ شهادة صدرت. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RenewUnitInput extends BaseInput {
  unitId: string;
  tenantId?: string;
  otp: string;
  actorId: string;
  client: FatooraClientFactory;
  keyring: SecretKeyring;
  signerFactory?: SignerFactory;
  sleep?: (ms: number) => Promise<void>;
  inFlightTimeoutMs?: number;
  pollIntervalMs?: number;
  leaseMs?: number;
  csrFields?: CsrFieldOverrides;
}

export interface AbortRenewalInput extends BaseInput {
  unitId: string;
  tenantId?: string;
  actorId: string;
  leaseMs?: number;
}

export type RetireReason = 'revoked-in-portal' | 'abandoned';
const RETIRE_REASONS: readonly RetireReason[] = Object.freeze(['revoked-in-portal', 'abandoned'] as RetireReason[]);

export interface RetireUnitInput extends BaseInput {
  unitId: string;
  tenantId?: string;
  actorId: string;
  reason: RetireReason;
  /** مطلوب «إيقاف» لوحدة تحمل شهادة إنتاج (ACTIVE/RENEWING/EXPIRED/AUTH_FAILED). */
  typedConfirmation?: string;
  leaseMs?: number;
}

export interface GoLiveConfirmations {
  /** المدير يؤكّد أن كل المناديب زامنوا أجهزتهم (D11). */
  repsSynced: boolean;
  /** النصّ المكتوب — يجب أن يكون «تفعيل». */
  typedConfirmation: string;
}

export interface GoLiveInput extends BaseInput {
  tenantId: string;
  actorId: string;
  confirmations: GoLiveConfirmations;
}

// ─────────────────────────────────────────────────────────────────────────────
// أدوات داخلية
// ─────────────────────────────────────────────────────────────────────────────

class StoreFailure extends Error {
  constructor() {
    super('store-failure');
    this.name = 'StoreFailure';
  }
}

class LeakGuardError extends Error {
  constructor() {
    super('leak-guard');
    this.name = 'LeakGuardError';
  }
}

/** كل استدعاء للمخزن يمرّ من هنا: رسالة خطأ المخزن (قد تحمل وسائط الاستعلام) لا تُنقل أبداً. */
async function st<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    throw new StoreFailure();
  }
}

interface Run {
  store: EgsUnitStore;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  tenantId: string;
  unitId: string | null;
  actorId: string | null;
  /** أسرار صريحة عرفتها هذه العملية (OTP، أسرار CSID، قيم Basic) — للمحو والحاجز الأخير. لا تُحفظ. */
  secrets: string[];
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function newRun(store: EgsUnitStore, now: () => Date, tenantId: string, unitId: string | null, actorId: string | null, sleep?: (ms: number) => Promise<void>): Run {
  return { store, now, sleep: sleep ?? realSleep, tenantId, unitId, actorId, secrets: [] };
}

function rememberCsidSecret(run: Run, token: string, secret: string): void {
  run.secrets.push(secret, Buffer.from(`${token}:${secret}`, 'utf8').toString('base64'));
}

function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && !(v instanceof Date) && depth < 10) {
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1);
  }
  return out;
}

/** نسخة يُمحى من كل نصّ فيها ما يطابق سرّاً (التواريخ تبقى كما هي). */
function deepScrub<T>(m: SecretMatcher, v: T, depth = 0): T {
  if (typeof v === 'string') return (m.contains(v) ? m.scrub(v) : v) as unknown as T;
  if (!v || typeof v !== 'object' || v instanceof Date || depth >= 10) return v;
  if (Array.isArray(v)) return v.map(x => deepScrub(m, x, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deepScrub(m, x, depth + 1);
  return out as T;
}

function scrub(run: Run, text: string | null | undefined, max: number): string | null {
  if (typeof text !== 'string') return null;
  const clipped = text.length > max * 2 ? text.slice(0, max * 2) : text;
  const s = compileSecrets(run.secrets).scrub(clipped);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** حاجز أخير قبل أي كتابة: حمولة تحمل سرّاً صريحاً أو OTP لا تصل المخزن أبداً. */
function assertNoSecrets(run: Run, payload: unknown): void {
  if (run.secrets.length === 0) return;
  const m = compileSecrets(run.secrets);
  if (collectStrings(payload).some(s => m.contains(s))) throw new LeakGuardError();
}

/** حاجز على حدود الخدمة: نتيجة تحمل سرّاً (detail من رموز الهيئة مثلاً) تُمسح قبل أن تعود أو تُسجَّل. */
function cleanResult<T>(run: Run, result: T): T {
  if (run.secrets.length === 0) return result;
  const m = compileSecrets(run.secrets);
  if (!collectStrings(result).some(s => m.contains(s))) return result;
  const out = deepScrub(m, result) as T & { detail?: unknown; field?: unknown };
  for (const k of ['detail', 'field'] as const) if (typeof out[k] === 'string' && (out[k] as string).includes('[REDACTED]')) delete out[k];
  return out;
}

function errorName(e: unknown): string {
  const n = e instanceof Error ? e.name : typeof e;
  return typeof n === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(n) ? n : 'Error';
}

function isFailure(x: unknown): x is OnboardingFailure {
  return !!x && typeof x === 'object' && (x as { ok?: unknown }).ok === false;
}

// ─── تقدّم الامتثال وعلاماته ───

const INFLIGHT_OPS: readonly InFlightOp[] = Object.freeze(['compliance', 'production-csid'] as InFlightOp[]);

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function readInFlight(v: unknown): StoredInFlight | undefined {
  if (!isObj(v) || !(INFLIGHT_OPS as readonly unknown[]).includes(v.op) || typeof v.attemptId !== 'string' || typeof v.at !== 'string') return undefined;
  return { op: v.op as InFlightOp, attemptId: v.attemptId, at: v.at };
}

function readRenewal(v: unknown): StoredRenewal | undefined {
  if (!isObj(v) || (v.origin !== 'ACTIVE' && v.origin !== 'EXPIRED') || !(RENEWAL_STAGES as readonly unknown[]).includes(v.stage)) return undefined;
  if (typeof v.uncertain !== 'boolean' || typeof v.attemptId !== 'string' || typeof v.at !== 'string') return undefined;
  return { origin: v.origin, stage: v.stage as RenewalStage, uncertain: v.uncertain, attemptId: v.attemptId, at: v.at };
}

/** قراءة complianceSteps المخزَّن (بالعلامات ومعرّفاتها) — null إن لم يكن كائن تقدّم. */
function readProgress(v: unknown): StoredProgress | null {
  if (!isObj(v)) return null;
  const p = v as Partial<ComplianceProgress> & Record<string, unknown>;
  if (p.v !== 1 || (p.phase !== 'onboarding' && p.phase !== 'renewal') || typeof p.keyVersion !== 'number' || !isObj(p.steps)) return null;
  const out: StoredProgress = { v: 1, phase: p.phase, keyVersion: p.keyVersion, requestId: typeof p.requestId === 'string' ? p.requestId : null, steps: { ...p.steps } };
  const inFlight = readInFlight(p.inFlight);
  if (inFlight) out.inFlight = inFlight;
  const renewal = readRenewal(p.renewal);
  if (renewal) out.renewal = renewal;
  return out;
}

function emptyProgress(phase: ComplianceProgress['phase'], keyVersion: number, requestId: string | null): StoredProgress {
  return { v: 1, phase, keyVersion, requestId, steps: {} };
}

function progressOf(unit: EgsUnitRecord): StoredProgress {
  return readProgress(unit.complianceSteps) ?? emptyProgress('onboarding', unit.keyVersion, unit.complianceRequestId);
}

function withInFlight(p: StoredProgress, marker: StoredInFlight | null): StoredProgress {
  const { inFlight: _drop, ...rest } = p;
  return marker ? { ...rest, inFlight: marker } : rest;
}

function withRenewal(p: StoredProgress, marker: StoredRenewal | null): StoredProgress {
  const { renewal: _drop, ...rest } = p;
  return marker ? { ...rest, renewal: marker } : rest;
}

const asJson = (p: StoredProgress) => p as unknown as Record<string, unknown>;

/** علامة تجديد غير منتهية (done/aborted لا تُحسب). */
function openRenewal(unit: EgsUnitRecord): StoredRenewal | undefined {
  const r = readProgress(unit.complianceSteps)?.renewal;
  return r && r.stage !== 'done' && r.stage !== 'aborted' ? r : undefined;
}

/** هل قد تكون الهيئة أصدرت شهادة إنتاج جديدة (وأبطلت الحالية) دون أن يُحفظ ناتجها؟ */
function renewalMayHaveIssued(m: StoredRenewal | undefined): boolean {
  return !!m && (m.uncertain || m.stage === 'patch-sent' || m.stage === 'production-sent' || m.stage === 'unconfirmed');
}

function fresh(run: Run, unit: EgsUnitRecord, leaseMs: number): boolean {
  return run.now().getTime() - unit.updatedAt.getTime() < leaseMs;
}

/** طلب شهادة من هذا النوع جارٍ لدى عامل آخر (علامة حديثة)؟ */
function inFlightBusy(run: Run, unit: EgsUnitRecord, op: InFlightOp, leaseMs: number): boolean {
  return readProgress(unit.complianceSteps)?.inFlight?.op === op && fresh(run, unit, leaseMs);
}

function viewProgress(p: StoredProgress | null): ComplianceProgress | null {
  if (!p) return null;
  const out: ComplianceProgress = { v: 1, phase: p.phase, keyVersion: p.keyVersion, requestId: p.requestId, steps: { ...p.steps } };
  if (p.inFlight) out.inFlight = { op: p.inFlight.op, at: p.inFlight.at };
  if (p.renewal) out.renewal = { origin: p.renewal.origin, stage: p.renewal.stage, uncertain: p.renewal.uncertain, at: p.renewal.at };
  return out;
}

/** العرض الآمن (قائمة بيضاء من الحقول). */
export function toEgsUnitView(u: EgsUnitRecord): EgsUnitView {
  return {
    id: u.id, tenantId: u.tenantId, environment: u.environment, status: u.status, commonName: u.commonName, serialNumber: u.serialNumber,
    functionMap: u.functionMap, orgName: u.orgName, orgUnit: u.orgUnit, vatNumber: u.vatNumber, locationAddress: u.locationAddress,
    industry: u.industry, keyVersion: u.keyVersion, publicKeyPem: u.publicKeyPem, complianceRequestId: u.complianceRequestId,
    complianceProgress: viewProgress(readProgress(u.complianceSteps)), certSerial: u.certSerial, certNotBefore: u.certNotBefore, certNotAfter: u.certNotAfter,
    lastIcv: u.lastIcv, activatedAt: u.activatedAt, revokedAt: u.revokedAt, lastError: u.lastError, createdAt: u.createdAt, updatedAt: u.updatedAt,
  };
}

type FailExtra = Partial<Omit<OnboardingFailure, 'ok' | 'code' | 'messageAr' | 'unit'>>;

function fail(code: OnboardingCode, extra: FailExtra & { unit?: EgsUnitRecord | null } = {}): OnboardingFailure {
  const meta = ONBOARDING_CODES[code];
  const { unit, ...rest } = extra;
  const out: OnboardingFailure = {
    ok: false, code, messageAr: meta.messageAr, retryable: meta.retryable, needsNewOtp: meta.needsNewOtp, unit: unit ? toEgsUnitView(unit) : null,
  };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

/** أكواد SecretsError الدالّة على بيانات مخزَّنة تالفة (لا تُصلحها إعادة المحاولة ولا تصحيح البيئة). */
const PERMANENT_SECRET_CODES: ReadonlySet<SecretsErrorCode> = new Set<SecretsErrorCode>(['DECRYPT_FAILED', 'FORMAT_INVALID']);

/** SecretsError ⇒ STORED_SECRET_INVALID (نصّ مشفّر تالف: رمز جديد يولّد بديلاً) أو SECRETS_UNAVAILABLE (حلقة مفاتيح/بيئة: يُستأنف). */
function secretsFailure(e: SecretsError, unit: EgsUnitRecord | null): OnboardingFailure {
  return fail(PERMANENT_SECRET_CODES.has(e.code) ? 'STORED_SECRET_INVALID' : 'SECRETS_UNAVAILABLE', { unit, detail: e.code });
}

function unexpected(e: unknown, unit: EgsUnitRecord | null): OnboardingFailure {
  if (e instanceof StoreFailure) return fail('STORE_ERROR', { unit });
  if (e instanceof SecretsError) return secretsFailure(e, unit);
  if (e instanceof LeakGuardError) return fail('INTERNAL', { unit, detail: 'leak-guard' });
  return fail('INTERNAL', { unit, detail: errorName(e) });
}

/** نسخة جديدة أكبر تماماً من السابقة (كتابتان في الملّي ثانية نفسها لا تتطابقان). */
function nextVersion(prev: Date, now: Date): Date {
  return new Date(Math.max(now.getTime(), prev.getTime() + 1));
}

const CREDENTIAL_PATCH_KEYS: ReadonlySet<string> = new Set(['privateKeyEnc', 'complianceToken', 'complianceSecretEnc', 'productionToken', 'productionSecretEnc']);

function applyPatch(u: EgsUnitRecord, patch: EgsUnitPatch, at: Date): EgsUnitRecord {
  const out = { ...u } as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && !CREDENTIAL_PATCH_KEYS.has(k)) out[k] = v;
  out.updatedAt = at;
  return out as unknown as EgsUnitRecord;
}

/**
 * CAS: mode 'version' (الافتراضي) يطابق الحالة وupdatedAt؛ 'status' يطابق الحالة وحدها (مطالبة من حالة ساكنة قد
 * يكتبها Z5 مثل ACTIVE). يعيد الصفّ المحدَّث، أو null إن لم يُطبَّق.
 * في وضع 'status' اللقطة المحمَّلة قبل المطالبة قد تكون قديمة (تجديد كامل وقع بينهما): يُعاد تحميل الصفّ ويُتحقَّق
 * أن نسخته نسختنا، فلا يُبنى على keyVersion أو شهادة قديمين.
 */
async function advance(run: Run, unit: EgsUnitRecord, patch: EgsUnitPatch, mode: 'version' | 'status' = 'version'): Promise<EgsUnitRecord | null> {
  const at = nextVersion(unit.updatedAt, run.now());
  const clean: EgsUnitPatch = { ...patch };
  if (clean.lastError !== undefined && clean.lastError !== null) clean.lastError = scrub(run, clean.lastError, MAX_LAST_ERROR_CHARS);
  assertNoSecrets(run, clean);
  const expect = mode === 'version' ? { status: unit.status, updatedAt: unit.updatedAt } : { status: unit.status };
  const applied = await st(() => run.store.compareAndSetUnit(unit.id, expect, clean, at));
  if (!applied) return null;
  if (mode === 'version') return applyPatch(unit, clean, at);
  const reloaded = await st(() => run.store.loadUnit(unit.id));
  return reloaded && reloaded.updatedAt.getTime() === at.getTime() ? reloaded : null;
}

async function reload(run: Run, unit: EgsUnitRecord): Promise<EgsUnitRecord> {
  try {
    return (await run.store.loadUnit(unit.id)) ?? unit;
  } catch {
    return unit;
  }
}

function lastErrorText(code: OnboardingCode, detail?: string): string {
  return detail ? `${code}:${detail}` : code;
}

/**
 * يوقف المرحلة: يحفظ الحالة التالية (قد تكون الحالية) مع lastError ثم يعيد الفشل. إن خسر CAS فعملية أخرى غيّرت
 * الوحدة ⇒ CONCURRENT_MODIFICATION (detail = الكود الأصلي) مع الحالة الفعلية.
 */
async function park(
  run: Run, unit: EgsUnitRecord, status: EgsUnitStatus, code: OnboardingCode,
  extra: FailExtra & { progress?: StoredProgress } = {},
): Promise<OnboardingFailure> {
  const { progress, ...rest } = extra;
  const patch: EgsUnitPatch = { status, lastError: lastErrorText(code, rest.detail) };
  if (progress) patch.complianceSteps = asJson(progress);
  const next = await advance(run, unit, patch);
  if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit), detail: code });
  return fail(code, { ...rest, unit: next });
}

type PersistVerdict = 'applied' | 'retry' | 'lost';
type PersistResult = { kind: 'saved'; unit: EgsUnitRecord } | { kind: 'lost'; unit: EgsUnitRecord } | { kind: 'failed' };

/**
 * يحفظ ما أصدرته الهيئة (الشهادة تعيش في الذاكرة فقط حتى هذه الكتابة): عند خطأ المخزن أو خسارة CAS يُعاد تحميل الصفّ
 * و judge يقرّر — 'applied' (الكتابة وقعت فعلاً)، 'retry' (الصفّ ما زال مُطالَباً به من هذه المحاولة: علامتها فيه)،
 * 'lost' (استولى غيرنا). يُعاد بمهل persistRetryDelaysMs ثم 'failed'.
 */
async function persistIssued(run: Run, holder: { cur: EgsUnitRecord }, patch: EgsUnitPatch, judge: (row: EgsUnitRecord) => PersistVerdict): Promise<PersistResult> {
  const delays = ONBOARDING_DEFAULTS.persistRetryDelaysMs;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) await run.sleep(delays[attempt - 1]);
    try {
      const next = await advance(run, holder.cur, patch);
      if (next) {
        holder.cur = next;
        return { kind: 'saved', unit: next };
      }
    } catch (e) {
      if (!(e instanceof StoreFailure)) throw e;
    }
    let row: EgsUnitRecord | null;
    try {
      row = await st(() => run.store.loadUnit(holder.cur.id));
    } catch {
      continue;
    }
    if (!row) return { kind: 'lost', unit: holder.cur };
    const verdict = judge(row);
    if (verdict === 'lost') return { kind: 'lost', unit: row };
    holder.cur = row;
    if (verdict === 'applied') return { kind: 'saved', unit: row };
  }
  return { kind: 'failed' };
}

function msgs(run: Run, list: readonly Msg[], type: StepMessage['type']): StepMessage[] {
  return list.slice(0, MAX_STEP_MESSAGES).map(m => ({ type, code: scrub(run, m.code, 128), message: scrub(run, m.message, 300) }));
}

/** رموز رسائل الهيئة كـdetail آمن (أحرف ورموز محدودة فقط، ولا رمز يحمل OTP أو سرّاً). */
function codesDetail(run: Run, list: readonly Msg[]): string | undefined {
  const m = compileSecrets(run.secrets);
  const codes = list.map(x => x.code).filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(c) && !m.contains(c));
  return codes.length ? codes.slice(0, 8).join(',') : undefined;
}

async function writeLog(run: Run, row: Omit<ApiLogRow, 'tenantId' | 'egsUnitId' | 'actorId' | 'at'>): Promise<void> {
  let full: ApiLogRow = { tenantId: run.tenantId, egsUnitId: run.unitId, actorId: run.actorId, at: run.now(), ...row };
  const m = compileSecrets(run.secrets);
  if (collectStrings(full).some(s => m.contains(s))) {
    // يُمحى السرّ من النصوص نفسها فيبقى الدليل (from/to/detail)؛ وإن بقي أثر بعد المحو يُسقط الجسم كاملاً
    full = deepScrub(m, full);
    if (collectStrings(full).some(s => m.contains(s))) {
      full.response = null;
      full.errorText = '[REDACTED]';
    }
  }
  try {
    await run.store.writeApiLog(full);
  } catch {
    /* السجلّ دليل لا يُفشل العملية */
  }
}

function clientFor(run: Run, factory: FatooraClientFactory, env: FatooraEnv): FatooraClient | OnboardingFailure {
  const client = factory({
    env,
    log: async (e: ApiLogEntry) => {
      await writeLog(run, {
        endpoint: e.endpoint, httpStatus: e.httpStatus, outcome: e.outcome, durationMs: e.durationMs, errorText: e.errorText,
        response: {
          env: e.env, method: e.method, path: e.path, attempt: e.attempt, reason: e.reason, responseBytes: e.responseBytes,
          uuid: e.uuid, invoiceHash: e.invoiceHash, body: e.response as unknown as Record<string, unknown> | null,
        },
      });
    },
  });
  if (!client || typeof client !== 'object' || client.env !== env) return fail('ENV_MISMATCH');
  return client;
}

function validEnv(env: unknown): env is FatooraEnv {
  return typeof env === 'string' && (ENVS as readonly string[]).includes(env);
}

function nonEmpty(s: unknown): s is string {
  return typeof s === 'string' && s.trim() !== '' && s.length <= 200;
}

function baseInputIssue(input: Partial<BaseInput> | null | undefined): OnboardingFailure | null {
  if (!input || typeof input !== 'object') return fail('INVALID_INPUT', { field: 'input' });
  const s = input.store as Partial<EgsUnitStore> | undefined;
  if (!s || typeof s.loadUnit !== 'function' || typeof s.compareAndSetUnit !== 'function') return fail('INVALID_INPUT', { field: 'store' });
  if (!input.policy || typeof input.policy.productionBackend !== 'boolean') return fail('INVALID_INPUT', { field: 'policy' });
  if (input.now !== undefined && typeof input.now !== 'function') return fail('INVALID_INPUT', { field: 'now' });
  return null;
}

function csrFieldsIssue(v: unknown): OnboardingFailure | null {
  if (v === undefined) return null;
  if (!isObj(v)) return fail('INVALID_INPUT', { field: 'csrFields' });
  for (const k of ['locationAddress', 'industry', 'branchName'] as const) {
    if (v[k] !== undefined && typeof v[k] !== 'string') return fail('INVALID_INPUT', { field: `csrFields.${k}` });
  }
  return null;
}

function clockOf(input: BaseInput): () => Date {
  const f = input.now ?? (() => new Date());
  return () => {
    const d = f();
    if (!(d instanceof Date) || !Number.isFinite(d.getTime())) throw new Error('invalid clock');
    return d;
  };
}

function positiveMs(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fallback;
}

// ─── البيئة ───

/** إنشاء/ربط/تجديد: خادم الإنتاج يرفض وحدات sandbox (بيانات وهمية للمطوّرين فقط). */
function environmentIssue(env: string, policy: EnvironmentPolicy): OnboardingFailure | null {
  if (!validEnv(env)) return fail('INVALID_INPUT', { field: 'env' });
  if (policy.productionBackend && env === 'sandbox') return fail('ENV_NOT_ALLOWED', { detail: `env:${env}` });
  return null;
}

/**
 * design Z4 خطوة 5 لـZ5: هل تصلح الوحدة لإصدار فواتير حيّة؟ ACTIVE، وعلى خادم الإنتاج بيئة production فقط
 * (sandbox مرفوضة، وsimulation لحزمة Z6 وحدها).
 */
export function checkLiveUnitAllowed(unit: Pick<EgsUnitRecord, 'environment' | 'status'>, policy: EnvironmentPolicy): { ok: true } | OnboardingFailure {
  if (!unit || !policy || typeof policy.productionBackend !== 'boolean') return fail('INVALID_INPUT', { field: 'unit' });
  if (!validEnv(unit.environment)) return fail('INVALID_INPUT', { field: 'environment' });
  if (policy.productionBackend && unit.environment !== 'production') return fail('ENV_NOT_ALLOWED', { detail: `env:${unit.environment}` });
  if (unit.status !== 'ACTIVE') return fail('INVALID_STATE', { detail: `status:${unit.status}` });
  return { ok: true };
}

// ─── بيانات البائع ───

export function sellerSourceFromSettings(s: SellerSettingsRecord): SellerSource {
  return {
    legalName: s.legalName, taxNumber: s.taxNumber, commercialReg: s.commercialReg, sellerIdScheme: s.sellerIdScheme, sellerIdValue: s.sellerIdValue,
    addrStreet: s.addrStreet, addrBuildingNo: s.addrBuildingNo, addrAdditionalNo: s.addrAdditionalNo, addrDistrict: s.addrDistrict,
    addrCity: s.addrCity, addrPostalCode: s.addrPostalCode, countryCode: s.countryCode,
  };
}

/** بصمة بيانات البائع التي يبني منها التجديد CSR وعيّناته (تغيّرها أثناء الانتظار يُبطل ما بُني قبله). */
function sellerFingerprint(s: SellerSettingsRecord): string {
  return JSON.stringify([sellerSourceFromSettings(s), s.vatGroupTin, s.einvoiceProvider]);
}

const isVatGroup = (vat: string) => vat.length === 15 && vat[10] === '1';

/** فحص بيانات البائع كفحص Z1 المسبق (sellerIssues على الطرف المحوَّل) + الدولة والمزوّد + TIN المجموعة الضريبية. */
function sellerReadinessIssue(s: SellerSettingsRecord): OnboardingFailure | null {
  if (s.countryCode !== 'SA' || s.einvoiceProvider !== 'zatca') return fail('COUNTRY_NOT_SUPPORTED', { detail: `country:${s.countryCode}` });
  const issues = sellerIssues(mapSellerParty(sellerSourceFromSettings(s))).filter(i => i.severity === 'error');
  const vat = s.taxNumber ?? '';
  if (isVatGroup(vat) && !/^[0-9]{10}$/.test(s.vatGroupTin ?? '')) {
    issues.push({
      rule: 'SEC-TABLE-1', field: 'vatGroupTin', severity: 'error',
      messageAr: 'الرقم الضريبي لمجموعة ضريبية (الخانة 11 = 1): أدخل الرقم المميّز للعضو بعشرة أرقام',
    });
  }
  return issues.length ? fail('SELLER_DATA_INCOMPLETE', { issues }) : null;
}

/**
 * الجولة الأولى من buildComplianceSamples (تحويل + فحص مسبق لكل خطوة) بلا توقيع ولا شهادة — قبل استهلاك أي OTP:
 * تلتقط ما لا تراه sellerIssues وحدها (ميزانية QR لاسم البائع في المبسّطة مثلاً) فلا يُحرق رمز على بيانات ستُرفض.
 */
function samplesPreflightIssue(settings: SellerSettingsRecord, fm: FunctionMap, now: Date): OnboardingFailure | null {
  const seller = sellerSourceFromSettings(settings);
  const issues: IssueLike[] = [];
  const seen = new Set<string>();
  complianceSpecsFor(fm).forEach((spec, i) => {
    let found: IssueLike[];
    try {
      const doc = mapInvoiceToUbl(complianceInvoiceSource(spec, seller), { icv: i + 1, pih: INITIAL_PIH, uuid: crypto.randomUUID(), issuedAt: now });
      found = preflightIssues(doc, spec.subtype === '01' ? 'standard' : 'simplified');
    } catch (e) {
      if (!(e instanceof ZatcaInputError)) throw e;
      found = e.issues;
    }
    for (const x of found) {
      const key = `${x.rule}|${x.field}`;
      if (x.severity === 'error' && !seen.has(key)) {
        seen.add(key);
        issues.push(x);
      }
    }
  });
  return issues.length ? fail('SELLER_DATA_INCOMPLETE', { issues, detail: 'preflight' }) : null;
}

/** بيانات البائع + الفحص المسبق لعيّنات الامتثال. */
function onboardingReadinessIssue(settings: SellerSettingsRecord, fm: FunctionMap, now: Date): OnboardingFailure | null {
  return sellerReadinessIssue(settings) ?? samplesPreflightIssue(settings, fm, now);
}

const codePoints = (s: string) => Array.from(s).length;

/** العنوان للشهادة من عنوان المنشأة: كاملاً إن وسعه 64، وإلا مختصراً (رقم المبنى، المدينة، الرمز البريدي). */
function defaultLocation(s: SellerSettingsRecord): string {
  const t = (v: string | null) => (v ?? '').trim();
  const full = [[t(s.addrBuildingNo), t(s.addrStreet)].filter(Boolean).join(' '), t(s.addrDistrict), t(s.addrCity)].filter(Boolean).join(', ');
  if (codePoints(full) <= 64) return full;
  return [t(s.addrBuildingNo), t(s.addrCity), t(s.addrPostalCode)].filter(Boolean).join(' ');
}

function csrIssue(e: unknown): OnboardingFailure | null {
  if (e instanceof CsrError && e.code === 'INVALID_PARAM') {
    return { ...fail('CSR_PARAMS_INVALID', { field: e.field, detail: e.reason }), messageAr: `${ONBOARDING_CODES.CSR_PARAMS_INVALID.messageAr}: ${e.detail}` };
  }
  return null;
}

// ─── المفاتيح ───

function generateUnitKey(): crypto.KeyObject {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey;
}

/** privateKeyEnc = encryptSecret(PKCS#8 DER، egs-key، معرّف الوحدة): بايتات لا نصّ PEM، ويُصفَّر المخزن الوسيط. */
function sealUnitKey(key: crypto.KeyObject, unitId: string, keyring: SecretKeyring): string {
  const der = key.export({ type: 'pkcs8', format: 'der' }) as Buffer;
  try {
    return encryptSecret(der, { purpose: 'egs-key', ownerId: unitId }, keyring);
  } finally {
    der.fill(0);
  }
}

function spkiOf(key: crypto.KeyObject): Buffer {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }) as Buffer;
}

function publicPemOf(key: crypto.KeyObject): string {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string;
}

function spkiFromPem(pem: string | null): Buffer | null {
  if (typeof pem !== 'string') return null;
  try {
    return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }) as Buffer;
  } catch {
    return null;
  }
}

/**
 * يفكّ مفتاح التوقيع للوحدة في الذاكرة (لـZ5 أيضاً): PKCS#8 DER بـegs-key، secp256k1، ومفتاحه العام = publicKeyPem المخزَّن.
 * لا يرمي: حلقة مفاتيح/بيئة ⇒ SECRETS_UNAVAILABLE (يُستأنف)؛ نصّ مشفّر تالف ⇒ STORED_SECRET_INVALID؛
 * مفتاح لا يطابق أو بصيغة غير متوقَّعة ⇒ INTERNAL (detail KEY_MISMATCH/KEY_FORMAT).
 */
export function openUnitSigningKey(args: { unitId: string; privateKeyEnc: string; publicKeyPem: string | null; keyring: SecretKeyring }):
  { ok: true; key: crypto.KeyObject } | OnboardingFailure {
  try {
    const der = decryptSecretBytes(args.privateKeyEnc, { purpose: 'egs-key', ownerId: args.unitId }, args.keyring);
    let key: crypto.KeyObject;
    try {
      key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    } catch {
      return fail('INTERNAL', { detail: 'KEY_FORMAT' });
    } finally {
      der.fill(0);
    }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') return fail('INTERNAL', { detail: 'KEY_FORMAT' });
    const stored = spkiFromPem(args.publicKeyPem);
    if (!stored || !stored.equals(spkiOf(key))) return fail('INTERNAL', { detail: 'KEY_MISMATCH' });
    return { ok: true, key };
  } catch (e) {
    return unexpected(e, null);
  }
}

// ─── CSR الوحدة ───

interface UnitCsrFields {
  orgName: string;
  orgUnit: string;
  locationAddress: string;
  industry: string;
}

function paramsOf(unit: Pick<EgsUnitRecord, 'environment' | 'commonName' | 'serialNumber' | 'vatNumber' | 'functionMap'>, f: UnitCsrFields): CsrParams {
  return {
    env: unit.environment as FatooraEnv, commonName: unit.commonName, serialNumber: unit.serialNumber, orgName: f.orgName, orgUnit: f.orgUnit,
    vatNumber: unit.vatNumber, functionMap: unit.functionMap as FunctionMap, locationAddress: f.locationAddress, industry: f.industry,
  };
}

/**
 * حقول CSR المتوقَّعة الآن: O من الاسم النظامي الحالي، OU من TIN المجموعة الحالي (أو الفرع)، والعنوان والقطاع من
 * التجاوز أو الوحدة — والعنوان يُعاد اشتقاقه من عنوان المنشأة الحالي حين rederiveLocation (بعد رفض أو في التجديد).
 */
function csrFieldsFor(unit: EgsUnitRecord, settings: SellerSettingsRecord, overrides: CsrFieldOverrides | undefined, rederiveLocation: boolean): UnitCsrFields {
  return {
    orgName: settings.legalName ?? '',
    orgUnit: isVatGroup(unit.vatNumber) ? (settings.vatGroupTin ?? '') : (overrides?.branchName ?? unit.orgUnit),
    locationAddress: overrides?.locationAddress ?? (rederiveLocation ? defaultLocation(settings) : unit.locationAddress),
    industry: overrides?.industry ?? unit.industry,
  };
}

function functionMapOf(unit: EgsUnitRecord): FunctionMap | null {
  return (FUNCTION_MAPS as readonly string[]).includes(unit.functionMap) ? (unit.functionMap as FunctionMap) : null;
}

// ─── أدوات الربط ───

function bindingIssue(cert: CsidCert, spki: Uint8Array, vatNumber: string): CsidBindingIssue | null {
  return csidBindingIssue(cert, { spkiDer: spki, vatNumber });
}

function stepRecordOf(run: Run, outcome: Outcome, prev: ComplianceStepRecord | undefined): ComplianceStepRecord {
  const base: ComplianceStepRecord = {
    status: 'CONFIG', at: run.now().toISOString(), warnings: [], errors: [],
    priorEmpty400: prev?.priorEmpty400 ?? 0, priorPayload413: prev?.priorPayload413 ?? 0, detail: null,
  };
  switch (outcome.kind) {
    case 'ACCEPTED':
      return { ...base, status: outcome.warnings.length ? 'WARNING' : 'PASS', warnings: msgs(run, outcome.warnings, 'WARNING') };
    case 'REJECTED':
      return { ...base, status: 'REJECTED', errors: msgs(run, outcome.errors, 'ERROR'), warnings: msgs(run, outcome.warnings, 'WARNING') };
    case 'RETRY':
      return {
        ...base, status: 'RETRY', detail: `retry:${outcome.reason}`,
        priorEmpty400: base.priorEmpty400 + (outcome.reason === 'empty400' ? 1 : 0),
        priorPayload413: base.priorPayload413 + (outcome.reason === 'payload' ? 1 : 0),
      };
    case 'AUTH':
      return { ...base, status: 'AUTH', detail: 'auth' };
    case 'CONFIG':
      return { ...base, detail: outcome.detail };
    default:
      return { ...base, detail: `unexpected:${outcome.kind}` };
  }
}

const passed = (r: ComplianceStepRecord | undefined) => !!r && (r.status === 'PASS' || r.status === 'WARNING');

function isOtpRejection(errors: readonly Msg[]): boolean {
  return errors.some(m => /OTP/i.test(m.code ?? '') || /\bOTP\b/i.test(m.message ?? ''));
}

function isMissingStepsRejection(errors: readonly Msg[]): boolean {
  return errors.some(m => /Missing-ComplianceSteps/i.test(m.code ?? '') || /compliance steps/i.test(m.message ?? ''));
}

/**
 * ردّ على طلب قد يُصدر شهادة: هل يثبت أن الهيئة لم تُصدر شيئاً؟ 400/401/428 وحالات الرفض قبل المعالجة (429، 413،
 * 400 فارغ، 406) قاطعة؛ المهلة وانقطاع الشبكة و5xx وجسم غير مقروء بعد 200 لا تثبت شيئاً.
 */
function provesNotIssued(outcome: CsidOutcome): boolean {
  switch (outcome.kind) {
    case 'REJECTED':
    case 'AUTH':
    case 'NOT_COMPLIANT':
      return true;
    case 'RETRY':
      return (['rate', 'payload', 'empty400'] as RetryReason[]).includes(outcome.reason);
    case 'CONFIG':
      return outcome.detail === 'version-not-accepted';
    default:
      return false;
  }
}

type ChecksEnd =
  | { kind: 'passed'; progress: StoredProgress }
  | { kind: 'stopped'; progress: StoredProgress; outcome: Outcome; step: ComplianceStep; record: ComplianceStepRecord }
  | { kind: 'lost'; unit: EgsUnitRecord };

/**
 * يرسل عيّنات الامتثال بالترتيب ويحفظ كل خطوة (نبضاً) — يتخطّى ما نجح سابقاً لطلب CCSID نفسه. holder.cur يُحدَّث بعد
 * كل كتابة، فمن يوقف المرحلة بعد خطأ في منتصف الفحوص يكتب على النسخة الصحيحة.
 * UNVERIFIED(U7): فحص الامتثال يقيّم كل مستند منفرداً فلا يلزم تسلسل PIH بين إرسال سابق وعيّنات أُعيد بناؤها.
 */
async function submitSamples(run: Run, holder: { cur: EgsUnitRecord }, client: FatooraClient, creds: Creds, samples: ComplianceSample[], progress: StoredProgress): Promise<ChecksEnd> {
  let prog = progress;
  for (const sample of samples) {
    const prev = prog.steps[sample.step];
    if (passed(prev)) continue;
    const outcome = await client.checkComplianceInvoice(creds, sample.body, { priorEmpty400: prev?.priorEmpty400 ?? 0, priorPayload413: prev?.priorPayload413 ?? 0 });
    const record = stepRecordOf(run, outcome, prev);
    prog = { ...prog, steps: { ...prog.steps, [sample.step]: record } };
    if (outcome.kind !== 'ACCEPTED') return { kind: 'stopped', progress: prog, outcome, step: sample.step, record };
    const next = await advance(run, holder.cur, { complianceSteps: asJson(prog) });
    if (!next) return { kind: 'lost', unit: await reload(run, holder.cur) };
    holder.cur = next;
  }
  return { kind: 'passed', progress: prog };
}

/** ما بعد نتيجة فحص غير مقبولة: الحالة التالية والكود (للربط؛ التجديد يعيد الحالة الأصل). */
function checksStopPlan(run: Run, outcome: Outcome): { next: 'CCSID_ISSUED' | 'ERROR_NEEDS_OTP'; code: OnboardingCode; detail?: string } {
  switch (outcome.kind) {
    case 'REJECTED':
      // DTG p.31: فحص فاشل ⇒ إعادة الربط برمز وCSR جديدين (والمفتاح يُولَّد من جديد)
      return { next: 'ERROR_NEEDS_OTP', code: 'COMPLIANCE_CHECK_REJECTED', detail: codesDetail(run, outcome.errors) };
    case 'RETRY':
      return { next: 'CCSID_ISSUED', code: 'ZATCA_RETRY', detail: `retry:${outcome.reason}` };
    case 'AUTH':
      return { next: 'ERROR_NEEDS_OTP', code: 'CCSID_AUTH_FAILED' };
    case 'CONFIG':
      return { next: 'CCSID_ISSUED', code: 'ZATCA_CONFIG', detail: outcome.detail };
    default:
      return { next: 'CCSID_ISSUED', code: 'ZATCA_CONFIG', detail: `unexpected:${outcome.kind}` };
  }
}

async function makeSigner(factory: SignerFactory, key: crypto.KeyObject): Promise<HashSigner | null> {
  try {
    const s = await factory(key);
    return s && typeof s.signHash === 'function' ? s : null;
  } catch {
    return null;
  }
}

async function buildSamples(run: Run, seller: SellerSource, cert: CsidCert, signer: HashSigner, fm: FunctionMap):
  Promise<ComplianceSample[] | { code: OnboardingCode; detail?: string; issues?: IssueLike[]; step?: ComplianceStep; field?: string }> {
  try {
    return await buildComplianceSamples({ seller, cert, signer, now: run.now(), functionMap: fm });
  } catch (e) {
    if (e instanceof ComplianceSampleError) {
      if (e.code === 'PREFLIGHT') return { code: 'SELLER_DATA_INCOMPLETE', issues: e.issues, detail: 'preflight' };
      return { code: 'SAMPLES_FAILED', detail: `${e.code}${e.stampCode ? `:${e.stampCode}` : ''}`, step: e.steps[0], field: e.field };
    }
    return { code: 'SAMPLES_FAILED', detail: errorName(e) };
  }
}

/** الوحدة تُقرأ وتُتحقَّق ملكيتها (UNIT_NOT_FOUND لشركة أخرى — لا كشف). */
async function loadOwnedUnit(input: { store: EgsUnitStore; unitId: string; tenantId?: string }): Promise<EgsUnitRecord | OnboardingFailure> {
  let unit: EgsUnitRecord | null;
  try {
    unit = await st(() => input.store.loadUnit(input.unitId));
  } catch (e) {
    return unexpected(e, null);
  }
  if (!unit || (input.tenantId !== undefined && unit.tenantId !== input.tenantId)) return fail('UNIT_NOT_FOUND');
  return unit;
}

// ─────────────────────────────────────────────────────────────────────────────
// createUnit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * design Z4: DRAFT ─(بيانات البائع صالحة؛ مفتاح + CSR)─► CSR_READY. يُنشأ الصفّ مكتملاً بكتابة واحدة: معرّف UUID يُولَّد
 * هنا (يدخل في SN وسياق التشفير)، مفتاح secp256k1 مشفّر (egs-key)، مفتاح عام وCSR مفحوص ذاتياً. «لا وحدة مانعة»
 * يُفحص ذرّياً في المخزن (createUnitIfNone): طلبا إنشاء متزامنان يُنتجان وحدة واحدة.
 */
export async function createUnit(input: CreateUnitInput): Promise<OnboardingResult<{ unit: EgsUnitView }>> {
  const bad = baseInputIssue(input);
  if (bad) return bad;
  if (!nonEmpty(input.tenantId)) return fail('INVALID_INPUT', { field: 'tenantId' });
  if (!nonEmpty(input.actorId)) return fail('INVALID_INPUT', { field: 'actorId' });
  if (!input.keyring || typeof input.keyring !== 'object') return fail('INVALID_INPUT', { field: 'keyring' });
  const run = newRun(input.store, clockOf(input), input.tenantId, null, input.actorId);
  const result = cleanResult(run, await createUnitUnsafe(input, run).catch(e => unexpected(e, null)));
  await writeLog(run, {
    endpoint: 'ui:create-unit', httpStatus: null, outcome: result.ok ? 'OK' : result.code, durationMs: null, errorText: null,
    response: { environment: validEnv(input.env) ? input.env : null, ...(result.ok ? { status: result.unit.status } : { detail: result.detail ?? null }) },
  });
  return result;
}

async function createUnitUnsafe(input: CreateUnitInput, run: Run): Promise<OnboardingResult<{ unit: EgsUnitView }>> {
  const envIssue = environmentIssue(input.env, input.policy);
  if (envIssue) return envIssue;
  const settings = await st(() => input.store.loadSellerSettings(input.tenantId));
  if (!settings) return fail('TENANT_NOT_FOUND');
  const ready = onboardingReadinessIssue(settings, '1100', run.now());
  if (ready) return ready;
  // مسار سريع قبل توليد مفتاح؛ الضمان الفعلي في createUnitIfNone
  const existing = await st(() => input.store.listUnits(input.tenantId, { environment: input.env, statuses: UNIT_BLOCKING_STATUSES }));
  if (existing.length) return fail('UNIT_EXISTS', { unit: existing[0] });

  const unitId = (input.newUnitId ?? crypto.randomUUID)();
  if (typeof unitId !== 'string' || !UUID_RE.test(unitId)) return fail('INVALID_INPUT', { field: 'newUnitId' });
  run.unitId = null; // لا FK قبل الإنشاء
  const vat = settings.taxNumber as string;
  let params: CsrParams;
  try {
    params = validateCsrParams({
      env: input.env,
      commonName: egsCommonName(vat, input.unitShortId ?? unitId.slice(0, 8).toLowerCase()),
      serialNumber: egsSerialNumber(unitId),
      orgName: settings.legalName ?? '',
      orgUnit: isVatGroup(vat) ? (settings.vatGroupTin ?? '') : (input.branchName ?? ONBOARDING_DEFAULTS.branchName),
      vatNumber: vat,
      functionMap: '1100',
      locationAddress: input.locationAddress ?? defaultLocation(settings),
      industry: input.industry ?? ONBOARDING_DEFAULTS.industry,
    });
  } catch (e) {
    const c = csrIssue(e);
    if (c) return c;
    throw e;
  }

  const key = generateUnitKey();
  let csrPem: string;
  try {
    csrPem = buildCsr(params, key);
  } catch (e) {
    const c = csrIssue(e);
    if (c) return c;
    return fail('INTERNAL', { detail: e instanceof CsrError ? `csr:${e.code}` : errorName(e) });
  }
  const privateKeyEnc = sealUnitKey(key, unitId, input.keyring);
  const unit: NewEgsUnit = {
    id: unitId, tenantId: input.tenantId, kind: 'SERVER', environment: params.env, commonName: params.commonName, serialNumber: params.serialNumber,
    functionMap: params.functionMap, orgName: params.orgName, orgUnit: params.orgUnit, vatNumber: params.vatNumber,
    locationAddress: params.locationAddress, industry: params.industry, status: 'CSR_READY', keyVersion: 1,
    privateKeyEnc, publicKeyPem: publicPemOf(key), csrPem,
    complianceSteps: asJson(emptyProgress('onboarding', 1, null)),
  };
  assertNoSecrets(run, unit);
  const at = run.now();
  const created = await st(() => input.store.createUnitIfNone(unit, at, UNIT_BLOCKING_STATUSES));
  if (!created.created) return fail('UNIT_EXISTS', { unit: created.existing });
  run.unitId = created.unit.id;
  return { ok: true, unit: toEgsUnitView(created.unit) };
}

// ─────────────────────────────────────────────────────────────────────────────
// onboardUnit
// ─────────────────────────────────────────────────────────────────────────────

interface OnboardDeps {
  input: OnboardUnitInput;
  keyring: SecretKeyring;
  client: FatooraClientFactory;
  signerFactory: SignerFactory;
  leaseMs: number;
}

/**
 * design Z4 onboardUnit 1–5: يشغّل السلسلة كاملة فوراً من الحالة المحفوظة، ويحفظ كل انتقال قبل الانتقال التالي.
 * • CSR_READY/ERROR_NEEDS_OTP يحتاجان OTP؛ CCSID_ISSUED/CHECKS_RUNNING/CHECKS_PASSED تُستأنف بلا OTP.
 * • UNVERIFIED(U10): هل تبقى CCSID صالحة للاستئناف بعد انقطاع، وهل يلزم إتمام السلسلة داخل ساعة OTP.
 */
export async function onboardUnit(input: OnboardUnitInput): Promise<OnboardingResult<{ unit: EgsUnitView; alreadyActive: boolean }>> {
  const bad = baseInputIssue(input);
  if (bad) return bad;
  if (!nonEmpty(input.unitId)) return fail('INVALID_INPUT', { field: 'unitId' });
  if (!nonEmpty(input.actorId)) return fail('INVALID_INPUT', { field: 'actorId' });
  if (typeof input.client !== 'function') return fail('INVALID_INPUT', { field: 'client' });
  if (!input.keyring || typeof input.keyring !== 'object') return fail('INVALID_INPUT', { field: 'keyring' });
  if (input.signerFactory !== undefined && typeof input.signerFactory !== 'function') return fail('INVALID_INPUT', { field: 'signerFactory' });
  if (input.sleep !== undefined && typeof input.sleep !== 'function') return fail('INVALID_INPUT', { field: 'sleep' });
  const fieldsBad = csrFieldsIssue(input.csrFields);
  if (fieldsBad) return fieldsBad;
  if (input.otp !== undefined && input.otp !== null && typeof input.otp !== 'string') return fail('OTP_INVALID_FORMAT');

  const loaded = await loadOwnedUnit(input);
  if (isFailure(loaded)) return loaded;
  const unit = loaded;
  const run = newRun(input.store, clockOf(input), unit.tenantId, unit.id, input.actorId, input.sleep);
  const otp = typeof input.otp === 'string' ? input.otp : null;
  if (otp !== null) run.secrets.push(otp);
  const fromStatus = unit.status;
  const deps: OnboardDeps = {
    input, keyring: input.keyring, client: input.client, signerFactory: input.signerFactory ?? createServerSigner,
    leaseMs: positiveMs(input.leaseMs, ONBOARDING_DEFAULTS.leaseMs),
  };
  let result: OnboardingResult<{ unit: EgsUnitView; alreadyActive: boolean }>;
  try {
    result = await onboardLoop(run, unit, otp, deps);
  } catch (e) {
    result = unexpected(e, await reload(run, unit));
  }
  result = cleanResult(run, result);
  await writeLog(run, {
    endpoint: 'ui:onboard', httpStatus: null, outcome: result.ok ? 'OK' : result.code, durationMs: null, errorText: null,
    response: { from: fromStatus, to: result.ok ? result.unit.status : result.unit?.status ?? null, detail: result.ok ? null : result.detail ?? null },
  });
  return result;
}

async function onboardLoop(run: Run, start: EgsUnitRecord, otp: string | null, deps: OnboardDeps): Promise<OnboardingResult<{ unit: EgsUnitView; alreadyActive: boolean }>> {
  const envIssue = environmentIssue(start.environment, deps.input.policy);
  if (envIssue) return { ...envIssue, unit: toEgsUnitView(start) };
  let unit = start;
  let otpUsed = false;
  let regenerated = false;
  const needOtp = (): OnboardingFailure | null => {
    if (otpUsed) return fail('NEW_OTP_REQUIRED', { unit });
    if (otp === null || otp === '') return fail('OTP_REQUIRED', { unit });
    if (!OTP_RE.test(otp)) return fail('OTP_INVALID_FORMAT', { unit });
    return null;
  };

  for (let guard = 0; guard < 16; guard++) {
    let r: EgsUnitRecord | OnboardingFailure;
    switch (unit.status) {
      case 'ACTIVE':
        return { ok: true, unit: toEgsUnitView(unit), alreadyActive: guard === 0 };
      case 'ERROR_NEEDS_OTP': {
        const o = needOtp();
        if (o) return o;
        if (regenerated) return fail('INTERNAL', { unit, detail: 'regenerate-loop' });
        regenerated = true;
        // بدء جديد بعد رفض: مفتاح وCSR جديدان من بيانات المنشأة الحالية (والعنوان يُعاد اشتقاقه)
        r = await stageRegenerate(run, unit, deps, null, true);
        break;
      }
      case 'CSR_READY': {
        // عامل آخر أرسل POST /compliance ولم يُحسم بعد: لا يُرسل الرمز مرة ثانية
        if (inFlightBusy(run, unit, 'compliance', deps.leaseMs)) return fail('IN_PROGRESS', { unit });
        const o = needOtp();
        if (o) return o;
        const plan = await csrReadyCheck(run, unit, deps);
        if (isFailure(plan)) return plan;
        if (plan.regenerate) {
          // CSR مخزَّن لم يعد مقبولاً (بيانات عُدّلت، مفتاح تالف، أو تلف): يُعاد بناؤه قبل استهلاك OTP
          if (regenerated) return fail('INTERNAL', { unit, detail: 'csr-self-check' });
          regenerated = true;
          r = await stageRegenerate(run, unit, deps, plan.settings, false);
          break;
        }
        otpUsed = true;
        r = await stageRequestCcsid(run, unit, otp as string, deps, plan.spki);
        break;
      }
      case 'CCSID_ISSUED': {
        const claimed = await advance(run, unit, { status: 'CHECKS_RUNNING', lastError: null });
        if (!claimed) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
        r = await stageChecks(run, claimed, deps);
        break;
      }
      case 'CHECKS_RUNNING': {
        // عامل آخر يعمل ما دامت آخر كتابة داخل المهلة؛ بعدها يُستولى على النسخة (عامل مات)
        if (fresh(run, unit, deps.leaseMs)) return fail('IN_PROGRESS', { unit });
        const claimed = await advance(run, unit, { lastError: null });
        if (!claimed) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
        r = await stageChecks(run, claimed, deps);
        break;
      }
      case 'CHECKS_PASSED':
        if (inFlightBusy(run, unit, 'production-csid', deps.leaseMs)) return fail('IN_PROGRESS', { unit });
        r = await stageProductionCsid(run, unit, deps);
        break;
      default:
        return fail('INVALID_STATE', { unit, detail: `status:${unit.status}` });
    }
    if (isFailure(r)) return r;
    unit = r;
  }
  return fail('INTERNAL', { unit, detail: 'loop-guard' });
}

type CsrReadyPlan = { regenerate: false; spki: Buffer } | { regenerate: true; settings: SellerSettingsRecord };

/**
 * CSR_READY قبل استهلاك الرمز: بيانات البائع كاملة وعيّناتها تجتاز الفحص المسبق، الرقم الضريبي لم يتغيّر (OTP مربوط
 * به)، حلقة المفاتيح تفتح مفتاح الوحدة (وإلا فلا يُرسل رمز سيُختم سرّه بمفتاح لا يُفكّ لاحقاً)، وCSR المخزَّن مطابق
 * لحقول المنشأة الحالية ومفتاحها — وإلا يُعاد بناؤه مجاناً.
 */
async function csrReadyCheck(run: Run, unit: EgsUnitRecord, deps: OnboardDeps): Promise<CsrReadyPlan | OnboardingFailure> {
  const settings = await st(() => run.store.loadSellerSettings(unit.tenantId));
  if (!settings) return fail('TENANT_NOT_FOUND', { unit });
  const fm = functionMapOf(unit);
  if (!fm) return fail('INTERNAL', { unit, detail: 'function-map' });
  const ready = onboardingReadinessIssue(settings, fm, run.now());
  if (ready) return { ...ready, unit: toEgsUnitView(unit) };
  if (settings.taxNumber !== unit.vatNumber) return fail('SELLER_VAT_CHANGED', { unit });
  let expected: CsrParams;
  try {
    expected = validateCsrParams(paramsOf(unit, csrFieldsFor(unit, settings, deps.input.csrFields, false)));
  } catch (e) {
    const c = csrIssue(e);
    if (c) return { ...c, unit: toEgsUnitView(unit) };
    throw e;
  }
  const spki = spkiFromPem(unit.publicKeyPem);
  if (!spki || typeof unit.csrPem !== 'string') return { regenerate: true, settings };
  const creds = await st(() => run.store.loadUnitCredentials(unit.id));
  if (!creds || !creds.privateKeyEnc) return { regenerate: true, settings };
  const opened = openUnitSigningKey({ unitId: unit.id, privateKeyEnc: creds.privateKeyEnc, publicKeyPem: unit.publicKeyPem, keyring: deps.keyring });
  if (!opened.ok) {
    // حلقة مفاتيح/بيئة: يتوقّف بلا إرسال (يُستأنف بعد إصلاح البيئة)؛ مفتاح تالف: مفتاح جديد بلا كلفة رمز
    if (opened.code === 'SECRETS_UNAVAILABLE') return { ...opened, unit: toEgsUnitView(unit) };
    return { regenerate: true, settings };
  }
  try {
    assertZatcaCsr(unit.csrPem, { params: expected, subjectPublicKeyInfoDer: spki });
  } catch {
    return { regenerate: true, settings };
  }
  return { regenerate: false, spki };
}

/**
 * ERROR_NEEDS_OTP (أو CSR_READY بطلب لم يعد مطابقاً) ⇒ CSR_READY بمفتاح وCSR جديدين وحقول امتثال مفرغة.
 * O وOU من إعدادات المنشأة الحالية؛ العنوان والقطاع والفرع من التجاوز، والعنوان من المنشأة حين rederiveLocation.
 */
async function stageRegenerate(run: Run, unit: EgsUnitRecord, deps: OnboardDeps, known: SellerSettingsRecord | null, rederiveLocation: boolean): Promise<EgsUnitRecord | OnboardingFailure> {
  const settings = known ?? await st(() => run.store.loadSellerSettings(unit.tenantId));
  if (!settings) return fail('TENANT_NOT_FOUND', { unit });
  const fm = functionMapOf(unit);
  if (!fm) return fail('INTERNAL', { unit, detail: 'function-map' });
  const ready = onboardingReadinessIssue(settings, fm, run.now());
  if (ready) return { ...ready, unit: toEgsUnitView(unit) };
  if (settings.taxNumber !== unit.vatNumber) return fail('SELLER_VAT_CHANGED', { unit });
  let params: CsrParams;
  try {
    params = validateCsrParams(paramsOf(unit, csrFieldsFor(unit, settings, deps.input.csrFields, rederiveLocation)));
  } catch (e) {
    const c = csrIssue(e);
    if (c) return { ...c, unit: toEgsUnitView(unit) };
    throw e;
  }
  const key = generateUnitKey();
  const csrPem = buildCsr(params, key);
  const next = await advance(run, unit, {
    status: 'CSR_READY', privateKeyEnc: sealUnitKey(key, unit.id, deps.keyring), publicKeyPem: publicPemOf(key), csrPem,
    orgName: params.orgName, orgUnit: params.orgUnit, locationAddress: params.locationAddress, industry: params.industry,
    complianceRequestId: null, complianceToken: null, complianceSecretEnc: null,
    complianceSteps: asJson(emptyProgress('onboarding', unit.keyVersion, null)), lastError: null,
  });
  return next ?? fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
}

/**
 * CSR_READY ─POST /compliance (OTP)─► CCSID_ISSUED. المطالبة تكتب علامة inFlight قبل الشبكة (عقد إيجار)، فاستدعاء
 * ثانٍ أثناء انتظار الهيئة يرى IN_PROGRESS ولا يرسل الرمز مرة أخرى. رفض الطلب نفسه (غير OTP) ⇒ ERROR_NEEDS_OTP
 * فيُبنى مع الرمز التالي طلب جديد من البيانات المصحَّحة؛ Invalid-OTP/RETRY ⇒ يبقى CSR_READY.
 */
async function stageRequestCcsid(run: Run, unit: EgsUnitRecord, otp: string, deps: OnboardDeps, spki: Buffer): Promise<EgsUnitRecord | OnboardingFailure> {
  const attemptId = crypto.randomUUID();
  const claimed = await advance(run, unit, {
    lastError: null, complianceSteps: asJson(withInFlight(progressOf(unit), { op: 'compliance', attemptId, at: run.now().toISOString() })),
  });
  if (!claimed) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
  const h = { cur: claimed };
  const settle = (status: EgsUnitStatus, code: OnboardingCode, extra: FailExtra = {}) =>
    park(run, h.cur, status, code, { ...extra, progress: withInFlight(progressOf(h.cur), null) });

  const client = clientFor(run, deps.client, claimed.environment as FatooraEnv);
  if (isFailure(client)) return settle('CSR_READY', client.code);

  let outcome: CsidOutcome;
  try {
    outcome = await client.requestComplianceCsid(claimed.csrPem as string, otp);
  } catch (e) {
    if (e instanceof FatooraInputError) return settle('CSR_READY', 'ZATCA_CONFIG', { detail: `input:${e.field}` });
    throw e;
  }
  switch (outcome.kind) {
    case 'ISSUED':
      return acceptCcsid(run, h, outcome.csid, spki, deps, attemptId, settle);
    case 'REJECTED':
      if (isOtpRejection(outcome.errors)) {
        return settle('CSR_READY', 'NEW_OTP_REQUIRED', { detail: codesDetail(run, outcome.errors), zatcaMessages: msgs(run, outcome.errors, 'ERROR') });
      }
      // Invalid-CSR أو تسجيل ضريبي: إعادة إرسال الطلب نفسه لن تنجح — الرمز التالي يبني مفتاحاً وCSR من البيانات الحالية
      return settle('ERROR_NEEDS_OTP', 'CSID_REQUEST_REJECTED', { detail: codesDetail(run, outcome.errors), zatcaMessages: msgs(run, outcome.errors, 'ERROR') });
    case 'RETRY':
      // UNVERIFIED(U10): إن كان الرد قد ضاع بعد استهلاك الرمز فيلزم رمز جديد؛ وإلا يصلح الرمز نفسه خلال ساعته
      return settle('CSR_READY', 'ZATCA_RETRY', { detail: `retry:${outcome.reason}` });
    case 'AUTH':
      return settle('CSR_READY', 'ZATCA_CONFIG', { detail: 'auth-on-compliance' });
    case 'NOT_COMPLIANT':
      return settle('CSR_READY', 'ZATCA_CONFIG', { detail: 'not-compliant-on-compliance', needsNewOtp: true });
    default:
      return settle('CSR_READY', 'ZATCA_CONFIG', { detail: outcome.detail });
  }
}

async function acceptCcsid(
  run: Run, h: { cur: EgsUnitRecord }, csid: CsidResult, spki: Uint8Array, deps: OnboardDeps, attemptId: string,
  settle: (status: EgsUnitStatus, code: OnboardingCode, extra?: FailExtra) => Promise<OnboardingFailure>,
): Promise<EgsUnitRecord | OnboardingFailure> {
  rememberCsidSecret(run, csid.binarySecurityToken, csid.secret);
  if (!csid.requestID) return settle('CSR_READY', 'ZATCA_CONFIG', { detail: 'csid-incomplete:requestID', needsNewOtp: true });
  const requestId = csid.requestID;
  let cert: CsidCert;
  try {
    cert = decodeCsid(csid);
  } catch (e) {
    if (e instanceof CsidCertError) return settle('CSR_READY', 'CSID_CERT_INVALID', { detail: 'ccsid' });
    throw e;
  }
  const issue = bindingIssue(cert, spki, h.cur.vatNumber);
  if (issue) return settle('CSR_READY', 'CERT_BINDING_MISMATCH', { detail: `ccsid:${issue}` });
  let secretEnc: string;
  try {
    secretEnc = encryptSecret(csid.secret, { purpose: 'ccsid-secret', ownerId: h.cur.id }, deps.keyring);
  } catch (e) {
    if (e instanceof SecretsError) return settle('CSR_READY', 'CREDENTIALS_NOT_SAVED', { detail: `ccsid:${e.code}` });
    throw e;
  }
  const saved = await persistIssued(run, h, {
    status: 'CCSID_ISSUED', complianceRequestId: requestId, complianceToken: csid.binarySecurityToken, complianceSecretEnc: secretEnc,
    complianceSteps: asJson(emptyProgress('onboarding', h.cur.keyVersion, requestId)), lastError: null,
  }, row => {
    if (row.status === 'CCSID_ISSUED' && row.complianceRequestId === requestId) return 'applied';
    return row.status === 'CSR_READY' && readProgress(row.complianceSteps)?.inFlight?.attemptId === attemptId ? 'retry' : 'lost';
  });
  if (saved.kind === 'saved') return saved.unit;
  // استولى غيرنا على الوحدة: الشهادة المُصدَرة لهذه المحاولة تُهمل ولا تُكتب فوق عمله
  if (saved.kind === 'lost') return fail('CONCURRENT_MODIFICATION', { unit: saved.unit });
  // تعذّر الحفظ بعد الإعادات: الرمز استُهلك فيلزم رمز جديد
  try {
    return await settle('CSR_READY', 'CREDENTIALS_NOT_SAVED', { detail: 'ccsid' });
  } catch {
    return fail('CREDENTIALS_NOT_SAVED', { unit: await reload(run, h.cur), detail: 'ccsid' });
  }
}

/** يوقف مرحلةً على فشل فكّ سرّ: تالف ⇒ ERROR_NEEDS_OTP (رمز جديد يولّد بديلاً)؛ بيئة ⇒ الحالة القابلة للاستئناف. */
function parkSecrets(run: Run, unit: EgsUnitRecord, e: SecretsError, resumable: EgsUnitStatus): Promise<OnboardingFailure> {
  const f = secretsFailure(e, null);
  return park(run, unit, f.code === 'STORED_SECRET_INVALID' ? 'ERROR_NEEDS_OTP' : resumable, f.code, { detail: f.detail });
}

/** CHECKS_RUNNING (مُطالَب بها) ─► CHECKS_PASSED، أو توقّف مصنَّف. أي خطأ غير متوقَّع يعيد CCSID_ISSUED على أحدث نسخة. */
async function stageChecks(run: Run, claimed: EgsUnitRecord, deps: OnboardDeps): Promise<EgsUnitRecord | OnboardingFailure> {
  const h = { cur: claimed };
  try {
    const cur = h.cur;
    const fm = functionMapOf(cur);
    const creds = await st(() => run.store.loadUnitCredentials(cur.id));
    if (!fm || !creds || !creds.complianceToken || !creds.complianceSecretEnc || !creds.privateKeyEnc || !cur.complianceRequestId) {
      return park(run, cur, 'ERROR_NEEDS_OTP', 'INTERNAL', { detail: 'ccsid-missing', needsNewOtp: true });
    }
    const settings = await st(() => run.store.loadSellerSettings(cur.tenantId));
    if (!settings) return park(run, cur, 'CCSID_ISSUED', 'TENANT_NOT_FOUND');
    const ready = sellerReadinessIssue(settings);
    if (ready) return park(run, cur, 'CCSID_ISSUED', ready.code, { issues: ready.issues, detail: ready.detail });
    if (settings.taxNumber !== cur.vatNumber) return park(run, cur, 'CCSID_ISSUED', 'SELLER_VAT_CHANGED');

    let cert: CsidCert;
    try {
      cert = decodeCsid({ binarySecurityToken: creds.complianceToken });
    } catch (e) {
      if (e instanceof CsidCertError) return park(run, cur, 'ERROR_NEEDS_OTP', 'CSID_CERT_INVALID', { detail: 'ccsid' });
      throw e;
    }
    const spki = spkiFromPem(cur.publicKeyPem);
    if (!spki) return park(run, cur, 'ERROR_NEEDS_OTP', 'INTERNAL', { detail: 'public-key', needsNewOtp: true });
    const issue = bindingIssue(cert, spki, cur.vatNumber);
    if (issue) return park(run, cur, 'ERROR_NEEDS_OTP', 'CERT_BINDING_MISMATCH', { detail: `ccsid:${issue}` });

    let secret: string;
    try {
      secret = decryptSecret(creds.complianceSecretEnc, { purpose: 'ccsid-secret', ownerId: cur.id }, deps.keyring);
    } catch (e) {
      if (e instanceof SecretsError) return parkSecrets(run, cur, e, 'CCSID_ISSUED');
      throw e;
    }
    rememberCsidSecret(run, creds.complianceToken, secret);
    const opened = openUnitSigningKey({ unitId: cur.id, privateKeyEnc: creds.privateKeyEnc, publicKeyPem: cur.publicKeyPem, keyring: deps.keyring });
    if (!opened.ok) {
      // تعذّر الفكّ لسبب بيئي يُستأنف؛ مفتاح تالف أو لا يطابق المفتاح العام ⇒ إعادة الربط بمفتاح جديد
      const next: EgsUnitStatus = opened.code === 'SECRETS_UNAVAILABLE' ? 'CCSID_ISSUED' : 'ERROR_NEEDS_OTP';
      return park(run, cur, next, opened.code, { detail: opened.detail, needsNewOtp: next === 'ERROR_NEEDS_OTP' });
    }
    const signer = await makeSigner(deps.signerFactory, opened.key);
    if (!signer) return park(run, cur, 'CCSID_ISSUED', 'SIGNER_FAILED');

    const samples = await buildSamples(run, sellerSourceFromSettings(settings), cert, signer, fm);
    if (!Array.isArray(samples)) return park(run, cur, 'CCSID_ISSUED', samples.code, { detail: samples.detail, issues: samples.issues, step: samples.step, field: samples.field });

    const client = clientFor(run, deps.client, cur.environment as FatooraEnv);
    if (isFailure(client)) return park(run, cur, 'CCSID_ISSUED', client.code);
    const existing = readProgress(cur.complianceSteps);
    const progress = existing && existing.phase === 'onboarding' && existing.requestId === cur.complianceRequestId
      ? withRenewal(withInFlight(existing, null), null)
      : emptyProgress('onboarding', cur.keyVersion, cur.complianceRequestId);

    const end = await submitSamples(run, h, client, { token: creds.complianceToken, secret }, samples, progress);
    if (end.kind === 'lost') return fail('CONCURRENT_MODIFICATION', { unit: end.unit });
    if (end.kind === 'stopped') {
      const plan = checksStopPlan(run, end.outcome);
      return park(run, h.cur, plan.next, plan.code, {
        detail: plan.detail, step: end.step, progress: end.progress,
        zatcaMessages: [...end.record.errors, ...end.record.warnings],
      });
    }
    const done = await advance(run, h.cur, { status: 'CHECKS_PASSED', complianceSteps: asJson(end.progress), lastError: null });
    return done ?? fail('CONCURRENT_MODIFICATION', { unit: await reload(run, h.cur) });
  } catch (e) {
    // h.cur = آخر نسخة كتبناها (بعد كل نبض)، فالإيقاف لا يخسر CAS على نسخة قديمة ويُبقي الوحدة CHECKS_RUNNING
    if (e instanceof FatooraInputError) return park(run, h.cur, 'CCSID_ISSUED', 'ZATCA_CONFIG', { detail: `input:${e.field}` });
    if (e instanceof SecretsError) {
      try {
        return await parkSecrets(run, h.cur, e, 'CCSID_ISSUED');
      } catch {
        return secretsFailure(e, h.cur);
      }
    }
    const u = unexpected(e, h.cur);
    try {
      return await park(run, h.cur, 'CCSID_ISSUED', u.code, { detail: u.detail });
    } catch {
      return u;
    }
  }
}

/**
 * CHECKS_PASSED ─POST /production/csids─► ACTIVE (بعد ربط الشهادة بالمفتاح والرقم الضريبي). المطالبة تكتب علامة inFlight
 * قبل الشبكة، فاستدعاء ثانٍ أثناء انتظار الهيئة يرى IN_PROGRESS ولا يطلب شهادة إنتاج ثانية.
 */
async function stageProductionCsid(run: Run, unit: EgsUnitRecord, deps: OnboardDeps): Promise<EgsUnitRecord | OnboardingFailure> {
  // سلسلة واحدة لكل شركة وبيئة: لا تُفعَّل وحدة ووحدة أخرى مفعّلة أو قيد التجديد
  const others = (await st(() => run.store.listUnits(unit.tenantId, { environment: unit.environment, statuses: ['ACTIVE', 'RENEWING'] }))).filter(u => u.id !== unit.id);
  if (others.length) return fail('OTHER_UNIT_EXISTS', { unit, detail: `other:${others[0].status}` });
  const creds = await st(() => run.store.loadUnitCredentials(unit.id));
  if (!creds || !creds.complianceToken || !creds.complianceSecretEnc || !unit.complianceRequestId) {
    return park(run, unit, 'ERROR_NEEDS_OTP', 'INTERNAL', { detail: 'ccsid-missing', needsNewOtp: true });
  }
  const requestId = unit.complianceRequestId;
  const spki = spkiFromPem(unit.publicKeyPem);
  if (!spki) return park(run, unit, 'ERROR_NEEDS_OTP', 'INTERNAL', { detail: 'public-key', needsNewOtp: true });
  let secret: string;
  try {
    secret = decryptSecret(creds.complianceSecretEnc, { purpose: 'ccsid-secret', ownerId: unit.id }, deps.keyring);
  } catch (e) {
    if (e instanceof SecretsError) return parkSecrets(run, unit, e, 'CHECKS_PASSED');
    throw e;
  }
  rememberCsidSecret(run, creds.complianceToken, secret);
  const client = clientFor(run, deps.client, unit.environment as FatooraEnv);
  if (isFailure(client)) return park(run, unit, 'CHECKS_PASSED', client.code);

  const attemptId = crypto.randomUUID();
  const claimed = await advance(run, unit, {
    lastError: null, complianceSteps: asJson(withInFlight(progressOf(unit), { op: 'production-csid', attemptId, at: run.now().toISOString() })),
  });
  if (!claimed) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
  const h = { cur: claimed };
  const settle = (status: EgsUnitStatus, code: OnboardingCode, extra: FailExtra & { progress?: StoredProgress } = {}) =>
    park(run, h.cur, status, code, { ...extra, progress: extra.progress ?? withInFlight(progressOf(h.cur), null) });

  let outcome: CsidOutcome;
  try {
    outcome = await client.requestProductionCsid({ token: creds.complianceToken, secret }, requestId);
  } catch (e) {
    if (e instanceof FatooraInputError) return settle('CHECKS_PASSED', 'ZATCA_CONFIG', { detail: `input:${e.field}` });
    throw e;
  }
  switch (outcome.kind) {
    case 'ISSUED': {
      const csid = outcome.csid;
      rememberCsidSecret(run, csid.binarySecurityToken, csid.secret);
      let cert: CsidCert;
      try {
        cert = decodeCsid(csid);
      } catch (e) {
        if (e instanceof CsidCertError) return settle('CHECKS_PASSED', 'CSID_CERT_INVALID', { detail: 'pcsid', retryable: true, needsNewOtp: false });
        throw e;
      }
      const issue = bindingIssue(cert, spki, h.cur.vatNumber);
      if (issue) return settle('ERROR_NEEDS_OTP', 'CERT_BINDING_MISMATCH', { detail: `pcsid:${issue}` });
      if (cert.notAfter.getTime() <= run.now().getTime()) {
        return settle('CHECKS_PASSED', 'CSID_CERT_INVALID', { detail: 'pcsid-expired', needsNewOtp: false });
      }
      const notSaved: FailExtra = { detail: 'pcsid', retryable: true, needsNewOtp: false };
      let secretEnc: string;
      try {
        secretEnc = encryptSecret(csid.secret, { purpose: 'pcsid-secret', ownerId: h.cur.id }, deps.keyring);
      } catch (e) {
        if (e instanceof SecretsError) return settle('CHECKS_PASSED', 'CREDENTIALS_NOT_SAVED', { ...notSaved, detail: `pcsid:${e.code}` });
        throw e;
      }
      const serial = cert.serialDecimal;
      const saved = await persistIssued(run, h, {
        status: 'ACTIVE', productionToken: csid.binarySecurityToken, productionSecretEnc: secretEnc,
        certSerial: serial, certNotBefore: cert.notBefore, certNotAfter: cert.notAfter, activatedAt: run.now(), lastError: null,
        // سرّ الامتثال لم يعد لازماً بعد التفعيل: لا يُبقى مخزَّناً
        complianceSecretEnc: null, complianceSteps: asJson(withInFlight(progressOf(h.cur), null)),
      }, row => {
        if (row.status === 'ACTIVE' && row.certSerial === serial) return 'applied';
        return row.status === 'CHECKS_PASSED' && readProgress(row.complianceSteps)?.inFlight?.attemptId === attemptId ? 'retry' : 'lost';
      });
      if (saved.kind === 'saved') return saved.unit;
      if (saved.kind === 'lost') return fail('CONCURRENT_MODIFICATION', { unit: saved.unit });
      try {
        return await settle('CHECKS_PASSED', 'CREDENTIALS_NOT_SAVED', notSaved);
      } catch {
        return fail('CREDENTIALS_NOT_SAVED', { ...notSaved, unit: await reload(run, h.cur) });
      }
    }
    case 'REJECTED':
      if (isMissingStepsRejection(outcome.errors)) {
        return settle('CCSID_ISSUED', 'COMPLIANCE_STEPS_MISSING', {
          detail: codesDetail(run, outcome.errors), zatcaMessages: msgs(run, outcome.errors, 'ERROR'),
          progress: emptyProgress('onboarding', h.cur.keyVersion, requestId),
        });
      }
      return settle('ERROR_NEEDS_OTP', 'PRODUCTION_CSID_REJECTED', { detail: codesDetail(run, outcome.errors), zatcaMessages: msgs(run, outcome.errors, 'ERROR') });
    case 'RETRY':
      return settle('CHECKS_PASSED', 'ZATCA_RETRY', { detail: `retry:${outcome.reason}` });
    case 'AUTH':
      return settle('ERROR_NEEDS_OTP', 'CCSID_AUTH_FAILED');
    case 'NOT_COMPLIANT':
      return settle('CHECKS_PASSED', 'ZATCA_CONFIG', { detail: 'not-compliant-on-production' });
    default:
      return settle('CHECKS_PASSED', 'ZATCA_CONFIG', { detail: outcome.detail });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// renewUnit
// ─────────────────────────────────────────────────────────────────────────────

type RenewResult = OnboardingResult<{ unit: EgsUnitView; path: 'ISSUED' | 'NOT_COMPLIANT' }>;

/** ما تجهّزه فحوص ما قبل المطالبة (لا شبكة ولا كتابة): المفتاح الجديد مختوماً وCSR والاعتماد الحالي مفكوكاً. */
interface RenewPlan {
  settings: SellerSettingsRecord;
  fingerprint: string;
  fm: FunctionMap;
  creds: Creds;
  params: CsrParams;
  newKey: crypto.KeyObject;
  newSpki: Buffer;
  sealedKey: string;
  publicKeyPem: string;
  csrPem: string;
}

interface RenewState {
  cur: EgsUnitRecord;
  origin: Origin;
  attemptId: string;
  /** محاولة سابقة ربما أصدرت (علامة غير مؤكَّدة ورثناها): لا عودة إلى الأصل حتى نتيجة قاطعة. */
  uncertain: boolean;
  /** هذه المحاولة أرسلت طلباً قد يُصدر شهادة إنتاج ولم تُثبت الهيئة العكس. */
  mayHaveIssued: boolean;
  /** كتبت هذه المحاولة علامة renewal (فالعودة تختمها aborted). */
  markerWritten: boolean;
  /** أُرسل PATCH برمز التجديد: كل توقّف بعده يحتاج رمزاً جديداً. */
  otpSent: boolean;
}

/**
 * design Z4 renewUnit 1–6 [SWG PATCH؛ D524]. الحالة الأصل ACTIVE (أو EXPIRED — UNVERIFIED(U10) هل تصلح شهادة منتهية
 * لتفويض PATCH؛ 401 عندها يُبقي EXPIRED ويطلب وحدة جديدة).
 * • الفحوص التي لا تحتاج شبكة (بيانات البائع، الرقم الضريبي، وحدة أخرى، الاعتماد، حلقة المفاتيح، CSR) تسبق RENEWING
 *   فلا يُوقف الإصدار ولا يُنتظر 10 دقائق لطلب سيُرفض محلياً.
 * • مرحلة التجديد تُحفظ قبل كل طلب قد يُصدر شهادة إنتاج؛ بعده لا عودة إلى ACTIVE على الاعتماد القديم (report §9:
 *   التجديد يُبطل الشهادة الحالية) — الشهادة الصادرة تُحفظ بإعادات، وإلا تبقى الوحدة RENEWING «غير مؤكَّدة».
 * • RENEWING ميّتة (بعد المهلة) أو غير مؤكَّدة تُستولى بتجديد جديد برمز؛ وabortRenewal يعيد الميّتة قبل أي إرسال بلا رمز.
 */
export async function renewUnit(input: RenewUnitInput): Promise<RenewResult> {
  const bad = baseInputIssue(input);
  if (bad) return bad;
  if (!nonEmpty(input.unitId)) return fail('INVALID_INPUT', { field: 'unitId' });
  if (!nonEmpty(input.actorId)) return fail('INVALID_INPUT', { field: 'actorId' });
  if (typeof input.client !== 'function') return fail('INVALID_INPUT', { field: 'client' });
  if (!input.keyring || typeof input.keyring !== 'object') return fail('INVALID_INPUT', { field: 'keyring' });
  if (input.signerFactory !== undefined && typeof input.signerFactory !== 'function') return fail('INVALID_INPUT', { field: 'signerFactory' });
  if (input.sleep !== undefined && typeof input.sleep !== 'function') return fail('INVALID_INPUT', { field: 'sleep' });
  const fieldsBad = csrFieldsIssue(input.csrFields);
  if (fieldsBad) return fieldsBad;

  const loaded = await loadOwnedUnit(input);
  if (isFailure(loaded)) return loaded;
  const unit = loaded;
  const run = newRun(input.store, clockOf(input), unit.tenantId, unit.id, input.actorId, input.sleep);
  if (typeof input.otp === 'string') run.secrets.push(input.otp);
  const fromStatus = unit.status;
  let result: RenewResult;
  try {
    result = await renewUnsafe(run, unit, input);
  } catch (e) {
    result = unexpected(e, await reload(run, unit));
  }
  result = cleanResult(run, result);
  await writeLog(run, {
    endpoint: 'ui:renew', httpStatus: null, outcome: result.ok ? 'OK' : result.code, durationMs: null, errorText: null,
    response: { from: fromStatus, to: result.ok ? result.unit.status : result.unit?.status ?? null, detail: result.ok ? result.path : result.detail ?? null },
  });
  return result;
}

function originByExpiry(unit: EgsUnitRecord, now: Date): Origin {
  return unit.certNotAfter && unit.certNotAfter.getTime() <= now.getTime() ? 'EXPIRED' : 'ACTIVE';
}

function renewalMarker(run: Run, state: RenewState, stage: RenewalStage): StoredRenewal {
  return { origin: state.origin, stage, uncertain: state.uncertain || stage === 'unconfirmed', attemptId: state.attemptId, at: run.now().toISOString() };
}

async function renewUnsafe(run: Run, unit: EgsUnitRecord, input: RenewUnitInput): Promise<RenewResult> {
  const envIssue = environmentIssue(unit.environment, input.policy);
  if (envIssue) return { ...envIssue, unit: toEgsUnitView(unit) };
  if (typeof input.otp !== 'string' || input.otp === '') return fail('OTP_REQUIRED', { unit });
  if (!OTP_RE.test(input.otp)) return fail('OTP_INVALID_FORMAT', { unit });
  const leaseMs = positiveMs(input.leaseMs, ONBOARDING_DEFAULTS.leaseMs);

  let origin: Origin;
  let uncertain = false;
  if (unit.status === 'ACTIVE' || unit.status === 'EXPIRED') {
    origin = unit.status;
  } else if (unit.status === 'RENEWING') {
    const m = openRenewal(unit);
    // «غير مؤكَّدة» متوقّفة لا جارية؛ غيرها جارية ما دامت آخر كتابة داخل المهلة
    if (m?.stage !== 'unconfirmed' && fresh(run, unit, leaseMs)) return fail('IN_PROGRESS', { unit });
    origin = m?.origin ?? originByExpiry(unit, run.now());
    uncertain = renewalMayHaveIssued(m);
  } else {
    return fail('INVALID_STATE', { unit, detail: `status:${unit.status}` });
  }

  const plan = await renewalPlan(run, unit, input);
  if (isFailure(plan)) return plan.unit ? plan : { ...plan, unit: toEgsUnitView(unit) };

  // 1) RENEWING يوقف الإصدار الجديد على الوحدة
  const state: RenewState = { cur: unit, origin, attemptId: crypto.randomUUID(), uncertain, mayHaveIssued: uncertain, markerWritten: false, otpSent: false };
  let claimed: EgsUnitRecord | null;
  if (unit.status === 'RENEWING') {
    claimed = await advance(run, unit, { lastError: null, complianceSteps: asJson(withRenewal(progressOf(unit), renewalMarker(run, state, 'waiting'))) });
    state.markerWritten = true;
  } else {
    // CAS على الحالة وحدها: Z5 يحدّث صفّ الوحدة المفعّلة مع كل فاتورة (lastIcv) فلا نسخة ثابتة لنطابقها
    claimed = await advance(run, unit, { status: 'RENEWING', lastError: null }, 'status');
  }
  if (!claimed) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
  state.cur = claimed;
  if (claimed.keyVersion !== unit.keyVersion) {
    // اكتمل تجديد آخر بين القراءة والمطالبة: الاعتماد المفكوك قديم — لا يُرسل الرمز ولا تُبطل الشهادة الجديدة
    return parkRenewal(run, state, 'CONCURRENT_MODIFICATION', { detail: 'renewed-meanwhile' });
  }

  try {
    return await renewClaimed(run, state, plan, input);
  } catch (e) {
    const u = unexpected(e, state.cur);
    try {
      return await parkRenewal(run, state, u.code, { detail: u.detail, ...(state.otpSent ? { needsNewOtp: true, retryable: false } : {}) });
    } catch {
      return { ...u, unit: toEgsUnitView(await reload(run, state.cur)) };
    }
  }
}

/** فحوص التجديد وتجهيزه قبل إيقاف الإصدار (لا شبكة ولا كتابة). */
async function renewalPlan(run: Run, unit: EgsUnitRecord, input: RenewUnitInput): Promise<RenewPlan | OnboardingFailure> {
  const settings = await st(() => run.store.loadSellerSettings(unit.tenantId));
  if (!settings) return fail('TENANT_NOT_FOUND', { unit });
  const fm = functionMapOf(unit);
  if (!fm) return fail('INTERNAL', { unit, detail: 'function-map' });
  // قبل PATCH (يستهلك رمز التجديد): بيانات البائع وعيّنات الامتثال (مسار 428) تجتاز الفحص المسبق
  const ready = onboardingReadinessIssue(settings, fm, run.now());
  if (ready) return { ...ready, unit: toEgsUnitView(unit) };
  if (settings.taxNumber !== unit.vatNumber) return fail('SELLER_VAT_CHANGED', { unit });
  // وحدة أخرى قيد الربط أو مفعّلة (مثلاً بديل رُبط بعد انتهاء هذه): تجديدها يُنتج سلسلتين حيّتين
  const others = (await st(() => run.store.listUnits(unit.tenantId, { environment: unit.environment, statuses: UNIT_BLOCKING_STATUSES }))).filter(u => u.id !== unit.id);
  if (others.length) return fail('OTHER_UNIT_EXISTS', { unit, detail: `other:${others[0].status}` });
  const stored = await st(() => run.store.loadUnitCredentials(unit.id));
  if (!stored || !stored.productionToken || !stored.productionSecretEnc) return fail('INTERNAL', { unit, detail: 'pcsid-missing' });
  let secret: string;
  try {
    secret = decryptSecret(stored.productionSecretEnc, { purpose: 'pcsid-secret', ownerId: unit.id }, input.keyring);
  } catch (e) {
    // التجديد يحتاج الاعتماد الحالي: تعذّر فكّه (بيئةً أو تلفاً) لا يصلحه رمز جديد
    if (e instanceof SecretsError) return fail('SECRETS_UNAVAILABLE', { unit, detail: e.code });
    throw e;
  }
  rememberCsidSecret(run, stored.productionToken, secret);

  // 3) زوج مفاتيح جديد [RES Annex 1 p.12] وCSR بحقول المنشأة الحالية (العنوان يُحدَّث — design §5.1 خطوة 9)
  let params: CsrParams;
  try {
    params = validateCsrParams(paramsOf(unit, csrFieldsFor(unit, settings, input.csrFields, true)));
  } catch (e) {
    const c = csrIssue(e);
    if (c) return { ...c, unit: toEgsUnitView(unit) };
    throw e;
  }
  const newKey = generateUnitKey();
  let sealedKey: string;
  try {
    sealedKey = sealUnitKey(newKey, unit.id, input.keyring);
  } catch (e) {
    if (e instanceof SecretsError) return fail('SECRETS_UNAVAILABLE', { unit, detail: e.code });
    throw e;
  }
  return {
    settings, fingerprint: sellerFingerprint(settings), fm, creds: { token: stored.productionToken, secret }, params, newKey,
    newSpki: spkiOf(newKey), sealedKey, publicKeyPem: publicPemOf(newKey), csrPem: buildCsr(params, newKey),
  };
}

/** يكتب مرحلة التجديد (CAS بالنسخة) قبل الخطوة التي تليها. */
async function writeRenewalStage(run: Run, state: RenewState, stage: RenewalStage, base?: StoredProgress): Promise<boolean> {
  const next = await advance(run, state.cur, { complianceSteps: asJson(withRenewal(base ?? progressOf(state.cur), renewalMarker(run, state, stage))) });
  if (!next) return false;
  state.cur = next;
  state.markerWritten = true;
  return true;
}

/**
 * يوقف التجديد: إن لم يُرسل طلب قد يُصدر (أو أثبتت الهيئة عدم الإصدار) ⇒ الحالة الأصل؛ وإلا ⇒ يبقى RENEWING بعلامة
 * «غير مؤكَّدة» (الإصدار موقوف، وتجديد برمز هو المخرج) — لا ACTIVE على اعتماد ربما أُبطل.
 */
async function parkRenewal(run: Run, state: RenewState, code: OnboardingCode, extra: FailExtra & { progress?: StoredProgress } = {}): Promise<OnboardingFailure> {
  const { progress, ...rest } = extra;
  const base = progress ?? progressOf(state.cur);
  const lastError = lastErrorText(code, rest.detail);
  if (state.mayHaveIssued) {
    const next = await advance(run, state.cur, { lastError, complianceSteps: asJson(withRenewal(base, renewalMarker(run, state, 'unconfirmed'))) });
    if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur), detail: code });
    state.cur = next;
    return fail(code, { ...rest, retryable: false, needsNewOtp: true, unit: next });
  }
  const patch: EgsUnitPatch = { status: state.origin, lastError };
  if (state.markerWritten || progress) patch.complianceSteps = asJson(state.markerWritten ? withRenewal(base, renewalMarker(run, state, 'aborted')) : base);
  const next = await advance(run, state.cur, patch);
  if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur), detail: code });
  state.cur = next;
  return fail(code, { ...rest, unit: next });
}

/** شهادة إنتاج جديدة صدرت (والحالية أُبطلت على الأرجح) لكنها لا تصلح: الوحدة لا تُصدر بعد الآن ⇒ AUTH_FAILED. */
async function parkRenewalDead(run: Run, state: RenewState, code: OnboardingCode, extra: FailExtra & { progress?: StoredProgress } = {}): Promise<OnboardingFailure> {
  const { progress, ...rest } = extra;
  const next = await advance(run, state.cur, {
    status: 'AUTH_FAILED', lastError: lastErrorText(code, rest.detail),
    complianceSteps: asJson(withRenewal(progress ?? progressOf(state.cur), renewalMarker(run, state, 'aborted'))),
  });
  if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur), detail: code });
  state.cur = next;
  return fail(code, { ...rest, unit: next });
}

async function renewClaimed(run: Run, state: RenewState, plan: RenewPlan, input: RenewUnitInput): Promise<RenewResult> {
  // 2) انتظار المستندات الجارية (SIGNED/SUBMITTING/RETRY_WAIT) بساعة ونوم مُحقنين، مع نبض على النسخة
  const timeoutMs = positiveMs(input.inFlightTimeoutMs, ONBOARDING_DEFAULTS.inFlightTimeoutMs);
  const pollMs = Math.max(1, positiveMs(input.pollIntervalMs, ONBOARDING_DEFAULTS.pollIntervalMs));
  const started = run.now().getTime();
  for (;;) {
    const n = await st(() => run.store.countUnitDocuments(state.cur.id, IN_FLIGHT_DOCUMENT_STATUSES));
    if (n === 0) break;
    const elapsed = run.now().getTime() - started;
    if (elapsed >= timeoutMs) return parkRenewal(run, state, 'IN_FLIGHT_TIMEOUT', { detail: `in-flight:${n}` });
    await run.sleep(Math.min(pollMs, timeoutMs - elapsed));
    if (!(await writeRenewalStage(run, state, 'waiting'))) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur) });
  }

  // إعادة فحص رخيصة بعد الانتظار: CSR والعيّنات بُنيت من بيانات ما قبل المطالبة
  const settings = await st(() => run.store.loadSellerSettings(state.cur.tenantId));
  if (!settings) return parkRenewal(run, state, 'TENANT_NOT_FOUND');
  if (sellerFingerprint(settings) !== plan.fingerprint) return parkRenewal(run, state, 'CONCURRENT_MODIFICATION', { detail: 'seller-data-changed' });
  const client = clientFor(run, input.client, state.cur.environment as FatooraEnv);
  if (isFailure(client)) return parkRenewal(run, state, client.code);

  // 3) قبل PATCH تُحفظ «patch-sent»: من هنا قد تُصدر الهيئة شهادة وتُبطل الحالية
  if (!(await writeRenewalStage(run, state, 'patch-sent'))) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur) });
  state.mayHaveIssued = true;
  state.otpSent = true;
  let outcome: CsidOutcome;
  try {
    outcome = await client.renewProductionCsid(plan.creds, plan.csrPem, input.otp);
  } catch (e) {
    if (e instanceof FatooraInputError) {
      state.mayHaveIssued = state.uncertain; // رُفض قبل الإرسال
      return parkRenewal(run, state, 'ZATCA_CONFIG', { detail: `input:${e.field}` });
    }
    throw e;
  }
  if (provesNotIssued(outcome)) state.mayHaveIssued = state.uncertain;

  switch (outcome.kind) {
    case 'ISSUED':
      return swapRenewed(run, state, plan, input, outcome.csid, 'ISSUED', null);
    case 'REJECTED':
      return parkRenewal(run, state, isOtpRejection(outcome.errors) ? 'NEW_OTP_REQUIRED' : 'CSID_REQUEST_REJECTED', {
        detail: codesDetail(run, outcome.errors), zatcaMessages: msgs(run, outcome.errors, 'ERROR'),
      });
    case 'RETRY':
      return state.mayHaveIssued
        ? parkRenewal(run, state, 'RENEWAL_UNCONFIRMED', { detail: `retry:${outcome.reason}` })
        : parkRenewal(run, state, 'ZATCA_RETRY', { detail: `retry:${outcome.reason}` });
    case 'AUTH': {
      // 401 بشهادة الإنتاج الحالية: من ACTIVE ⇒ AUTH_FAILED (design)؛ من EXPIRED تبقى EXPIRED (U10: المنتهية لا تفوّض)
      const next: EgsUnitStatus = state.origin === 'ACTIVE' ? 'AUTH_FAILED' : 'EXPIRED';
      const parked = await advance(run, state.cur, {
        status: next, lastError: lastErrorText('PRODUCTION_AUTH_FAILED', `from:${state.origin}`),
        complianceSteps: asJson(withRenewal(progressOf(state.cur), renewalMarker(run, state, 'aborted'))),
      });
      if (!parked) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur), detail: 'PRODUCTION_AUTH_FAILED' });
      state.cur = parked;
      return fail('PRODUCTION_AUTH_FAILED', { unit: parked, detail: `from:${state.origin}` });
    }
    case 'CONFIG':
      return state.mayHaveIssued
        ? parkRenewal(run, state, 'RENEWAL_UNCONFIRMED', { detail: outcome.detail })
        : parkRenewal(run, state, 'ZATCA_CONFIG', { detail: outcome.detail });
    case 'NOT_COMPLIANT':
      break;
  }

  // 4) 428: فحوص الامتثال بشهادة الامتثال الجديدة ثم POST /production/csids [S14]. الرمز استُهلك: كل فشل يلزمه رمز جديد.
  // UNVERIFIED: هل يُبطل 428 الشهادة الحالية أم إصدار شهادة الإنتاج بعده — يُعامل كالثاني (العودة إلى الأصل قبل POST).
  const ccsid = outcome.ccsid;
  rememberCsidSecret(run, ccsid.binarySecurityToken, ccsid.secret);
  const needNew: FailExtra = { needsNewOtp: true, retryable: false };
  if (!ccsid.requestID) return parkRenewal(run, state, 'ZATCA_CONFIG', { detail: 'csid-incomplete:requestID', ...needNew });
  const renewalRequestId = ccsid.requestID;
  let ccert: CsidCert;
  try {
    ccert = decodeCsid(ccsid);
  } catch (e) {
    if (e instanceof CsidCertError) return parkRenewal(run, state, 'CSID_CERT_INVALID', { detail: 'ccsid' });
    throw e;
  }
  const cIssue = bindingIssue(ccert, plan.newSpki, state.cur.vatNumber);
  if (cIssue) return parkRenewal(run, state, 'CERT_BINDING_MISMATCH', { detail: `ccsid:${cIssue}` });
  const checksProgress = withRenewal(emptyProgress('renewal', state.cur.keyVersion + 1, renewalRequestId), renewalMarker(run, state, 'checks'));
  const noted = await advance(run, state.cur, {
    complianceRequestId: renewalRequestId, complianceToken: ccsid.binarySecurityToken, complianceSecretEnc: null,
    complianceSteps: asJson(checksProgress),
  });
  if (!noted) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur) });
  state.cur = noted;
  state.markerWritten = true;

  const signer = await makeSigner(input.signerFactory ?? createServerSigner, plan.newKey);
  if (!signer) return parkRenewal(run, state, 'SIGNER_FAILED', needNew);
  const samples = await buildSamples(run, sellerSourceFromSettings(settings), ccert, signer, plan.fm);
  if (!Array.isArray(samples)) return parkRenewal(run, state, samples.code, { detail: samples.detail, issues: samples.issues, step: samples.step, field: samples.field, ...needNew });
  const ccsidCreds: Creds = { token: ccsid.binarySecurityToken, secret: ccsid.secret };
  // state هو الحامل: كل نبض يحدّث state.cur فيُوقَف التجديد بعد خطأ على أحدث نسخة
  const end = await submitSamples(run, state, client, ccsidCreds, samples, checksProgress);
  if (end.kind === 'lost') return fail('CONCURRENT_MODIFICATION', { unit: end.unit });
  if (end.kind === 'stopped') {
    const stop = checksStopPlan(run, end.outcome);
    return parkRenewal(run, state, stop.code, { detail: stop.detail, step: end.step, progress: end.progress, zatcaMessages: [...end.record.errors, ...end.record.warnings], ...needNew });
  }

  // قبل POST تُحفظ «production-sent»
  if (!(await writeRenewalStage(run, state, 'production-sent', end.progress))) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, state.cur) });
  state.mayHaveIssued = true;
  const doneProgress = progressOf(state.cur);
  let prod: CsidOutcome;
  try {
    prod = await client.requestProductionCsid(ccsidCreds, renewalRequestId);
  } catch (e) {
    if (e instanceof FatooraInputError) {
      state.mayHaveIssued = state.uncertain;
      return parkRenewal(run, state, 'ZATCA_CONFIG', { detail: `input:${e.field}`, ...needNew });
    }
    throw e;
  }
  if (provesNotIssued(prod)) state.mayHaveIssued = state.uncertain;
  switch (prod.kind) {
    case 'ISSUED':
      return swapRenewed(run, state, plan, input, prod.csid, 'NOT_COMPLIANT', doneProgress);
    case 'REJECTED':
      return parkRenewal(run, state, 'PRODUCTION_CSID_REJECTED', { detail: codesDetail(run, prod.errors), zatcaMessages: msgs(run, prod.errors, 'ERROR') });
    case 'RETRY':
      return state.mayHaveIssued
        ? parkRenewal(run, state, 'RENEWAL_UNCONFIRMED', { detail: `retry:${prod.reason}` })
        : parkRenewal(run, state, 'ZATCA_RETRY', { detail: `retry:${prod.reason}`, ...needNew });
    case 'AUTH':
      return parkRenewal(run, state, 'CCSID_AUTH_FAILED');
    case 'NOT_COMPLIANT':
      return parkRenewal(run, state, 'ZATCA_CONFIG', { detail: 'not-compliant-on-production', ...needNew });
    default:
      return state.mayHaveIssued
        ? parkRenewal(run, state, 'RENEWAL_UNCONFIRMED', { detail: prod.detail })
        : parkRenewal(run, state, 'ZATCA_CONFIG', { detail: prod.detail, ...needNew });
  }
}

/**
 * 5) تبديل المفتاح والشهادة والسرّ في كتابة CAS واحدة (ذرّية)؛ السلسلة (lastIcv/lastInvoiceHash) تستمرّ على الوحدة.
 * UNVERIFIED(U7): هل تُستأنف السلسلة بعد التجديد أم تبدأ من جديد — يُحسم في Z6.
 * بعد الإصدار لا عودة إلى الأصل: شهادة لا تصلح ⇒ AUTH_FAILED؛ حفظ متعذّر بعد الإعادات ⇒ RENEWING غير مؤكَّدة.
 */
async function swapRenewed(
  run: Run, state: RenewState, plan: RenewPlan, input: RenewUnitInput, csid: CsidResult, path: 'ISSUED' | 'NOT_COMPLIANT', progress: StoredProgress | null,
): Promise<RenewResult> {
  rememberCsidSecret(run, csid.binarySecurityToken, csid.secret);
  let cert: CsidCert;
  try {
    cert = decodeCsid(csid);
  } catch (e) {
    if (e instanceof CsidCertError) return parkRenewalDead(run, state, 'CSID_CERT_INVALID', { detail: 'pcsid' });
    throw e;
  }
  const issue = bindingIssue(cert, plan.newSpki, state.cur.vatNumber);
  if (issue) return parkRenewalDead(run, state, 'CERT_BINDING_MISMATCH', { detail: `pcsid:${issue}` });
  if (cert.notAfter.getTime() <= run.now().getTime()) return parkRenewalDead(run, state, 'CSID_CERT_INVALID', { detail: 'pcsid-expired' });
  let secretEnc: string;
  try {
    secretEnc = encryptSecret(csid.secret, { purpose: 'pcsid-secret', ownerId: state.cur.id }, input.keyring);
  } catch (e) {
    if (e instanceof SecretsError) return parkRenewal(run, state, 'CREDENTIALS_NOT_SAVED', { detail: `pcsid:${e.code}` });
    throw e;
  }
  const serial = cert.serialDecimal;
  const attemptId = state.attemptId;
  const saved = await persistIssued(run, state, {
    status: 'ACTIVE', keyVersion: state.cur.keyVersion + 1, privateKeyEnc: plan.sealedKey,
    publicKeyPem: plan.publicKeyPem, csrPem: plan.csrPem, orgName: plan.params.orgName, orgUnit: plan.params.orgUnit,
    locationAddress: plan.params.locationAddress, industry: plan.params.industry,
    productionToken: csid.binarySecurityToken, productionSecretEnc: secretEnc,
    certSerial: serial, certNotBefore: cert.notBefore, certNotAfter: cert.notAfter, lastError: null, complianceSecretEnc: null,
    complianceSteps: asJson(withRenewal(progress ?? progressOf(state.cur), renewalMarker(run, state, 'done'))),
  }, row => {
    const m = readProgress(row.complianceSteps)?.renewal;
    if (row.status === 'ACTIVE' && row.certSerial === serial && m?.attemptId === attemptId) return 'applied';
    return row.status === 'RENEWING' && m?.attemptId === attemptId ? 'retry' : 'lost';
  });
  if (saved.kind === 'saved') return { ok: true, unit: toEgsUnitView(saved.unit), path };
  // استولى غيرنا (عامل تجاوز المهلة): لا يُكتب فوقه
  if (saved.kind === 'lost') return fail('CREDENTIALS_NOT_SAVED', { unit: saved.unit, detail: 'swap-lost' });
  try {
    return await parkRenewal(run, state, 'CREDENTIALS_NOT_SAVED', { detail: 'swap' });
  } catch {
    return fail('CREDENTIALS_NOT_SAVED', { unit: await reload(run, state.cur), detail: 'swap' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// abortRenewal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * مخرج بلا OTP لتجديد مات (انقطاع، نشر، كتابة فشلت) أو توقّف: RENEWING بعد المهلة ولم يُرسل فيه طلب قد يُصدر
 * (waiting/checks أو بلا علامة) ⇒ الحالة الأصل ويعود الإصدار. إن كان قد يكون أصدر ⇒ لا عودة: تُختم «غير مؤكَّدة»
 * ويُعاد RENEWAL_UNCONFIRMED (المخرج تجديد برمز: نجاح أو 401 ⇒ AUTH_FAILED، أو retireUnit).
 */
export async function abortRenewal(input: AbortRenewalInput): Promise<OnboardingResult<{ unit: EgsUnitView }>> {
  const bad = baseInputIssue(input);
  if (bad) return bad;
  if (!nonEmpty(input.unitId)) return fail('INVALID_INPUT', { field: 'unitId' });
  if (!nonEmpty(input.actorId)) return fail('INVALID_INPUT', { field: 'actorId' });
  const loaded = await loadOwnedUnit(input);
  if (isFailure(loaded)) return loaded;
  const unit = loaded;
  const run = newRun(input.store, clockOf(input), unit.tenantId, unit.id, input.actorId);
  let result: OnboardingResult<{ unit: EgsUnitView }>;
  try {
    result = await abortRenewalUnsafe(run, unit, positiveMs(input.leaseMs, ONBOARDING_DEFAULTS.leaseMs));
  } catch (e) {
    result = unexpected(e, await reload(run, unit));
  }
  await writeLog(run, {
    endpoint: 'ui:abort-renewal', httpStatus: null, outcome: result.ok ? 'OK' : result.code, durationMs: null, errorText: null,
    response: { from: unit.status, to: result.ok ? result.unit.status : result.unit?.status ?? null, detail: result.ok ? null : result.detail ?? null },
  });
  return result;
}

async function abortRenewalUnsafe(run: Run, unit: EgsUnitRecord, leaseMs: number): Promise<OnboardingResult<{ unit: EgsUnitView }>> {
  if (unit.status !== 'RENEWING') return fail('INVALID_STATE', { unit, detail: `status:${unit.status}` });
  const m = openRenewal(unit);
  if (m?.stage !== 'unconfirmed' && fresh(run, unit, leaseMs)) return fail('IN_PROGRESS', { unit });
  const prog = progressOf(unit);
  if (renewalMayHaveIssued(m)) {
    const marker = m as StoredRenewal;
    if (marker.stage === 'unconfirmed') return fail('RENEWAL_UNCONFIRMED', { unit, detail: 'unconfirmed' });
    const next = await advance(run, unit, {
      lastError: lastErrorText('RENEWAL_UNCONFIRMED', `stale:${marker.stage}`),
      complianceSteps: asJson(withRenewal(prog, { ...marker, stage: 'unconfirmed', uncertain: true, at: run.now().toISOString() })),
    });
    if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
    return fail('RENEWAL_UNCONFIRMED', { unit: next, detail: `stale:${marker.stage}` });
  }
  const origin = m?.origin ?? originByExpiry(unit, run.now());
  const patch: EgsUnitPatch = { status: origin, lastError: null };
  if (m) patch.complianceSteps = asJson(withRenewal(prog, { ...m, stage: 'aborted', at: run.now().toISOString() }));
  const next = await advance(run, unit, patch);
  if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
  return { ok: true, unit: toEgsUnitView(next) };
}

// ─────────────────────────────────────────────────────────────────────────────
// retireUnit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * design Z4: any ─(المدير يسجّل «أُبطلت في البوابة»)─► REVOKED (نهائية). يُستعمل أيضاً للتخلّي عن وحدة لم تكتمل
 * (abandoned) أو وحدة زائدة، فيُتاح إنشاء وحدة جديدة دون تعديل قاعدة البيانات. وحدة تحمل شهادة إنتاج تحتاج «إيقاف».
 * العملية الجارية (فحوص/تجديد/طلب شهادة داخل المهلة) ⇒ IN_PROGRESS. سرّ الامتثال يُمحى؛ اعتماد الإنتاج يبقى للتدقيق.
 */
export async function retireUnit(input: RetireUnitInput): Promise<OnboardingResult<{ unit: EgsUnitView; alreadyRetired: boolean }>> {
  const bad = baseInputIssue(input);
  if (bad) return bad;
  if (!nonEmpty(input.unitId)) return fail('INVALID_INPUT', { field: 'unitId' });
  if (!nonEmpty(input.actorId)) return fail('INVALID_INPUT', { field: 'actorId' });
  if (!(RETIRE_REASONS as readonly unknown[]).includes(input.reason)) return fail('INVALID_INPUT', { field: 'reason' });
  if (input.typedConfirmation !== undefined && typeof input.typedConfirmation !== 'string') return fail('INVALID_INPUT', { field: 'typedConfirmation' });
  const loaded = await loadOwnedUnit(input);
  if (isFailure(loaded)) return loaded;
  const unit = loaded;
  const run = newRun(input.store, clockOf(input), unit.tenantId, unit.id, input.actorId);
  let result: OnboardingResult<{ unit: EgsUnitView; alreadyRetired: boolean }>;
  try {
    result = await retireUnsafe(run, unit, input, positiveMs(input.leaseMs, ONBOARDING_DEFAULTS.leaseMs));
  } catch (e) {
    result = unexpected(e, await reload(run, unit));
  }
  await writeLog(run, {
    endpoint: 'ui:retire-unit', httpStatus: null, outcome: result.ok ? (result.alreadyRetired ? 'ALREADY_RETIRED' : 'OK') : result.code, durationMs: null,
    errorText: null, response: { from: unit.status, reason: input.reason, detail: result.ok ? null : result.detail ?? null },
  });
  return result;
}

async function retireUnsafe(run: Run, unit: EgsUnitRecord, input: RetireUnitInput, leaseMs: number): Promise<OnboardingResult<{ unit: EgsUnitView; alreadyRetired: boolean }>> {
  if (unit.status === 'REVOKED') return { ok: true, unit: toEgsUnitView(unit), alreadyRetired: true };
  const busy =
    (unit.status === 'CHECKS_RUNNING' && fresh(run, unit, leaseMs))
    || (unit.status === 'RENEWING' && openRenewal(unit)?.stage !== 'unconfirmed' && fresh(run, unit, leaseMs))
    || (unit.status === 'CSR_READY' && inFlightBusy(run, unit, 'compliance', leaseMs))
    || (unit.status === 'CHECKS_PASSED' && inFlightBusy(run, unit, 'production-csid', leaseMs));
  if (busy) return fail('IN_PROGRESS', { unit });
  if (PRODUCTION_HOLDING_STATUSES.includes(unit.status) && input.typedConfirmation?.trim() !== RETIRE_CONFIRMATION_TEXT) {
    return fail('RETIRE_CONFIRMATION_REQUIRED', { unit });
  }
  const now = run.now();
  // ACTIVE يكتبها Z5 مع كل فاتورة ⇒ CAS على الحالة وحدها؛ غيرها بالنسخة
  const next = await advance(run, unit, { status: 'REVOKED', revokedAt: now, lastError: `RETIRED:${input.reason}`, complianceSecretEnc: null }, unit.status === 'ACTIVE' ? 'status' : 'version');
  if (!next) return fail('CONCURRENT_MODIFICATION', { unit: await reload(run, unit) });
  return { ok: true, unit: toEgsUnitView(next), alreadyRetired: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// goLive
// ─────────────────────────────────────────────────────────────────────────────

/**
 * design Z4 goLive (D11) + §5.1 خطوة 5: وحدة production واحدة مفعّلة غير منتهية ورقمها = رقم المنشأة، بيانات بائع كاملة،
 * عملة SAR، وتأكيد المدير (مزامنة المناديب + «تفعيل»). يضبط zatcaPhase2StartedAt مرة واحدة (CAS على NULL)؛
 * الاستدعاء بعد التفعيل يعيد النجاح نفسه دون كتابة (idempotent). يُسجَّل ui:go-live.
 * «وحدة مفعّلة واحدة» تحرسها المصادر لا قفل هنا: createUnitIfNone ذرّي، والربط والتجديد يرفضان وحدة ثانية.
 */
export async function goLive(input: GoLiveInput): Promise<OnboardingResult<{ startedAt: Date; alreadyLive: boolean; unitId: string | null }>> {
  const bad = baseInputIssue(input);
  if (bad) return bad;
  if (!nonEmpty(input.tenantId)) return fail('INVALID_INPUT', { field: 'tenantId' });
  if (!nonEmpty(input.actorId)) return fail('INVALID_INPUT', { field: 'actorId' });
  const run = newRun(input.store, clockOf(input), input.tenantId, null, input.actorId);
  let result: OnboardingResult<{ startedAt: Date; alreadyLive: boolean; unitId: string | null }>;
  try {
    result = await goLiveUnsafe(run, input);
  } catch (e) {
    result = unexpected(e, null);
  }
  await writeLog(run, {
    endpoint: 'ui:go-live', httpStatus: null, outcome: result.ok ? (result.alreadyLive ? 'ALREADY_LIVE' : 'LIVE') : result.code, durationMs: null,
    errorText: null, response: result.ok ? { startedAt: result.startedAt.toISOString(), unitId: result.unitId } : { detail: result.detail ?? null },
  });
  return result;
}

async function goLiveUnsafe(run: Run, input: GoLiveInput): Promise<OnboardingResult<{ startedAt: Date; alreadyLive: boolean; unitId: string | null }>> {
  const settings = await st(() => input.store.loadSellerSettings(input.tenantId));
  if (!settings) return fail('TENANT_NOT_FOUND');
  if (settings.zatcaPhase2StartedAt) return { ok: true, startedAt: settings.zatcaPhase2StartedAt, alreadyLive: true, unitId: null };

  const ready = sellerReadinessIssue(settings);
  if (ready) return ready;
  const currencyOk = settings.currency === 'SAR' && (settings.currencyOverride === null || settings.currencyOverride === 'SAR');
  if (!currencyOk) return fail('CURRENCY_NOT_SAR', { detail: `currency:${settings.currencyOverride ?? settings.currency}` });

  const units = await st(() => input.store.listUnits(input.tenantId, { environment: 'production', statuses: ['ACTIVE'] }));
  if (units.length === 0) return fail('NO_ACTIVE_UNIT');
  if (units.length > 1) return fail('MULTIPLE_ACTIVE_UNITS', { detail: `count:${units.length}` });
  const unit = units[0];
  run.unitId = unit.id;
  const live = checkLiveUnitAllowed(unit, input.policy);
  if (!live.ok) return { ...live, unit: toEgsUnitView(unit) };
  if (!unit.certNotAfter || unit.certNotAfter.getTime() <= run.now().getTime()) return fail('CERT_EXPIRED', { unit });
  if (settings.taxNumber !== unit.vatNumber) return fail('SELLER_VAT_CHANGED', { unit });

  const c = input.confirmations;
  if (!c || typeof c !== 'object' || c.repsSynced !== true || typeof c.typedConfirmation !== 'string' || c.typedConfirmation.trim() !== GO_LIVE_CONFIRMATION_TEXT) {
    return fail('CONFIRMATION_REQUIRED', { unit });
  }
  const at = run.now();
  const set = await st(() => input.store.setPhase2StartedAtOnce(input.tenantId, at));
  if (!set.startedAt) return fail('TENANT_NOT_FOUND');
  return { ok: true, startedAt: set.startedAt, alreadyLive: !set.applied, unitId: unit.id };
}
