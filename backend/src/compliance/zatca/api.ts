// ============================================================================
// ZATCA المرحلة الثانية (Z3) — عميل واجهة «فاتورة» (FATOORA) بلا تبعيات
// ----------------------------------------------------------------------------
// design §3 Z3 + report_apis-onboarding §3–§5:
// • ستة مسارات على بوابة واحدة (sandbox=developer-portal، simulation، production=core) [SWG servers][FPM p.30–31].
// • كل طلب: Accept-Version: V2 (بدونه 406) وContent-Type: application/json؛ Accept-Language حيث يوثّقه Swagger؛
//   OTP فقط على POST /compliance وPATCH /production/csids؛ Clearance-Status: 0 للإبلاغ و1 للاعتماد.
// • Basic base64(token:secret) والرمز حرفياً كما أعادته الهيئة (يبدأ بـTUlJ…) لا الشهادة المفكوكة [SWG].
// • التحقق من كل مُدخل قبل أي fetch (FatooraInputError بلا قيم)، ومهلة AbortController تغطي الاتصال والجسم معاً،
//   وسقف لحجم الجسم يُفرض أثناء القراءة، وredirect: 'manual' كي تُرى 303 ولا يُرسَل التفويض لمضيف آخر.
// • log يُستدعى مرة واحدة بالضبط لكل محاولة HTTP، بملخّص منقّح؛ فشله أو تعليقه لا يغيّر النتيجة.
// • لا حلقات إعادة محاولة هنا: Z5 يملك الجدولة. العميل يتلقّى رقم المحاولة للسجلّ فقط، وعدّادَي التصعيد
//   (priorEmpty400 / priorPayload413 = ردود سابقة من النوع نفسه لهذا المستند) لتصنيف empty400/413.
// • سقف الجسم يُختار بعد معرفة الحالة (responseBodyCap): 8 MiB فقط حيث قد يرد clearedInvoice.
// لا شيء هنا يُستدعى في وقت التشغيل بعد (لا مسارات ولا جدولة) — Z4/Z5 يوصلانه.
// ============================================================================

import { performance } from 'perf_hooks';
import { CsidCert, isCanonicalBase64, parseCsidToken } from './cert';
import {
  BodyTooLarge, CsidOutcome, CsidResult, EscalationCounts, FatooraEndpoint, InvoiceEndpoint, MAX_CSID_TOKEN_CHARS, MAX_ESCALATION_COUNT, Outcome,
  ParsedBody, RESPONSE_LIMITS, RedactedResponse, RetryReason, classifyCsidParsed, classifyInvoiceParsed, compileSecrets, isCsidEndpoint,
  looksLikeBase64Xml, parseResponseBody, redactResponseForLog, responseBodyCap, responseCredentialStrings, responseNeedsBody,
} from './responses';
import { STAMP_XML_LIMITS } from './xml';

export type FatooraEnv = 'sandbox' | 'simulation' | 'production';

/** [SWG servers]؛ FPM p.30–31. لا عنوان مخصّص عمداً: البيئة وحدها تحدّد المضيف. */
export const FATOORA_BASE_URLS: Readonly<Record<FatooraEnv, string>> = Object.freeze({
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
});

export interface EndpointSpec {
  method: 'POST' | 'PATCH';
  path: string;
  /** onboarding ⇒ مهلة 60 ث؛ submission ⇒ 30 ث (design). */
  timeoutClass: 'onboarding' | 'submission';
  otp: boolean;
  auth: boolean;
  acceptLanguage: boolean;
  clearanceStatus: '0' | '1' | null;
}

/** جدول report §3.1 (ترويسات كل مسار) [SWG]. */
export const FATOORA_ENDPOINT_SPECS: Readonly<Record<FatooraEndpoint, Readonly<EndpointSpec>>> = Object.freeze({
  compliance: Object.freeze({ method: 'POST', path: '/compliance', timeoutClass: 'onboarding', otp: true, auth: false, acceptLanguage: false, clearanceStatus: null }),
  'compliance-invoices': Object.freeze({ method: 'POST', path: '/compliance/invoices', timeoutClass: 'onboarding', otp: false, auth: true, acceptLanguage: true, clearanceStatus: null }),
  'production-csid': Object.freeze({ method: 'POST', path: '/production/csids', timeoutClass: 'onboarding', otp: false, auth: true, acceptLanguage: false, clearanceStatus: null }),
  renewal: Object.freeze({ method: 'PATCH', path: '/production/csids', timeoutClass: 'onboarding', otp: true, auth: true, acceptLanguage: true, clearanceStatus: null }),
  // UNVERIFIED(report §14.4): كيف يستعمل الخادم Clearance-Status؛ نرسل 0 للإبلاغ و1 للاعتماد كما توصي الدراسة
  reporting: Object.freeze({ method: 'POST', path: '/invoices/reporting/single', timeoutClass: 'submission', otp: false, auth: true, acceptLanguage: true, clearanceStatus: '0' }),
  clearance: Object.freeze({ method: 'POST', path: '/invoices/clearance/single', timeoutClass: 'submission', otp: false, auth: true, acceptLanguage: true, clearanceStatus: '1' }),
} as Record<FatooraEndpoint, EndpointSpec>);

export const DEFAULT_ONBOARDING_TIMEOUT_MS = 60000;
export const DEFAULT_SUBMISSION_TIMEOUT_MS = 30000;
export const DEFAULT_LOG_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_CSR_PEM_CHARS = 16384;
/** أكبر invoice base64 = مستند بحدّ مسار الختم (STAMP_XML_LIMITS). */
export const MAX_INVOICE_B64_CHARS = Math.ceil(STAMP_XML_LIMITS.maxBytes / 3) * 4;
export const MAX_ATTEMPT = 10000;

export interface Creds {
  /** binarySecurityToken حرفياً كما أعادته الهيئة. */
  token: string;
  secret: string;
}

export interface InvoiceBody {
  /** base64 لـ32 بايت SHA-256 (44 محرفاً). */
  invoiceHash: string;
  uuid: string;
  /** base64 للبايتات المخزّنة حرفياً (لا إعادة تسلسل بعد التجزئة). */
  invoice: string;
}

/** الحدّ الأدنى من fetch الذي يحتاجه العميل؛ globalThis.fetch في Node يطابقه. */
export interface FatooraFetchInit {
  method: 'POST' | 'PATCH';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  redirect: 'manual';
}

export interface FatooraFetchReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}

export interface FatooraFetchResponse {
  status: number;
  headers?: { get(name: string): string | null } | null;
  body?: { getReader(): FatooraFetchReader } | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type FatooraFetch = (url: string, init: FatooraFetchInit) => Promise<FatooraFetchResponse>;

/** سطر واحد لكل محاولة HTTP — يطابق أعمدة ZatcaApiLog (design §1.3) ولا يحمل سرّاً. */
export interface ApiLogEntry {
  env: FatooraEnv;
  endpoint: FatooraEndpoint;
  method: 'POST' | 'PATCH';
  path: string;
  attempt: number;
  /** null حين لم يصل رد (مهلة، شبكة). */
  httpStatus: number | null;
  outcome: Outcome['kind'] | CsidOutcome['kind'];
  /** سبب RETRY أو detail في CONFIG. */
  reason: string | null;
  durationMs: number;
  responseBytes: number | null;
  uuid: string | null;
  invoiceHash: string | null;
  response: RedactedResponse | null;
  /** اسم الخطأ ورمزه فقط (TypeError(ECONNRESET)) — لا نصّ رسالة. */
  errorText: string | null;
}

export interface FatooraClientOptions {
  env: FatooraEnv;
  log: (entry: ApiLogEntry) => Promise<void>;
  /** افتراضياً globalThis.fetch وقت الاستدعاء؛ الاختبارات تحقن دائماً. */
  fetch?: FatooraFetch;
  /** يطغى على المهلتين. */
  timeoutMs?: number;
  onboardingTimeoutMs?: number;
  submissionTimeoutMs?: number;
  /** يخفض سقوف الجسم فقط (min مع responseBodyCap)؛ لا يرفعها فوق RESPONSE_LIMITS.maxBodyBytes. */
  maxResponseBytes?: number;
  /** رسائل الهيئة بالعربية للمستأجر (design Z5.11)؛ en للتشخيص. */
  acceptLanguage?: 'ar' | 'en';
  /** أقصى انتظار لـlog قبل المتابعة دونه. */
  logTimeoutMs?: number;
  /** ساعة رتيبة بالميلي ثانية (للاختبار). */
  clock?: () => number;
}

export interface CallOptions {
  /** رقم المحاولة الكلّي لهذا الطلب (1 للأولى) — يُسجَّل في ApiLogEntry.attempt فقط ولا يؤثّر في التصنيف. */
  attempt?: number;
  /**
   * كم محاولة سابقة لإرسال البايتات نفسها صُنِّفت RETRY empty400 (افتراضياً 0). ليس رقم المحاولة ولا
   * ZatcaDocument.attempts/attemptNo: مهلة أو 5xx سابقة لا تُحسب. 3 ⇒ هذا الـ400 الفارغ REJECTED.
   */
  priorEmpty400?: number;
  /** كم محاولة سابقة صُنِّفت RETRY payload بسبب 413 (افتراضياً 0). 1 ⇒ هذا الـ413 CONFIG. */
  priorPayload413?: number;
  timeoutMs?: number;
}

export type FatooraInputField =
  | 'otp' | 'csrPem' | 'creds' | 'creds.token' | 'creds.secret' | 'body' | 'body.invoiceHash' | 'body.uuid' | 'body.invoice'
  | 'complianceRequestId' | 'attempt' | 'priorEmpty400' | 'priorPayload413' | 'timeoutMs' | 'options';

/** مُدخل مرفوض قبل أي اتصال. الرسالة تسمّي الحقل ولا تحمل قيمته أبداً. */
export class FatooraInputError extends Error {
  readonly code = 'INPUT' as const;
  readonly field: FatooraInputField;
  constructor(field: FatooraInputField, message: string) {
    super(`FATOORA INPUT ${field}: ${message}`);
    this.name = 'FatooraInputError';
    this.field = field;
  }
}

// ─── التحقق من المُدخلات ───

const OTP_RE = /^[0-9]{6}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CSR_PEM_RE = /^-----BEGIN CERTIFICATE REQUEST-----\r?\n((?:[A-Za-z0-9+/=]{1,76}\r?\n){1,256})-----END CERTIFICATE REQUEST-----(?:\r?\n)?$/;
const COMPLIANCE_REQUEST_ID_RE = /^[1-9][0-9]{0,29}$/;
const SECRET_RE = /^[\x21-\x7e]+$/;

function validateOtp(otp: unknown): string {
  // الرمز ستة أرقام ASCII بالضبط [S4 p.30]؛ نصّ لا عدد (الصفر البادئ يضيع في العدد)
  if (typeof otp !== 'string' || !OTP_RE.test(otp)) throw new FatooraInputError('otp', 'رمز OTP يجب أن يكون ستة أرقام نصّاً');
  return otp;
}

function validateCsrPem(pem: unknown): string {
  if (typeof pem !== 'string' || pem.length > MAX_CSR_PEM_CHARS) throw new FatooraInputError('csrPem', 'CSR يجب أن يكون نصّ PEM محدود الطول');
  const m = CSR_PEM_RE.exec(pem);
  if (!m) throw new FatooraInputError('csrPem', 'CSR ليس PEM من نوع CERTIFICATE REQUEST');
  const b64 = m[1].replace(/\r?\n/g, '');
  if (!isCanonicalBase64(b64)) throw new FatooraInputError('csrPem', 'محتوى CSR ليس base64 قانونياً');
  const der = Buffer.from(b64, 'base64');
  if (der.length < 64 || der[0] !== 0x30) throw new FatooraInputError('csrPem', 'محتوى CSR ليس بنية DER SEQUENCE');
  return pem;
}

function validateCreds(c: unknown): Creds {
  if (!c || typeof c !== 'object') throw new FatooraInputError('creds', 'بيانات الاعتماد مفقودة');
  const { token, secret } = c as Partial<Creds>;
  if (typeof token !== 'string' || token.length > MAX_CSID_TOKEN_CHARS || !isCanonicalBase64(token)) {
    throw new FatooraInputError('creds.token', 'binarySecurityToken يجب أن يكون base64 قانونياً كما أعادته الهيئة');
  }
  if (typeof secret !== 'string' || secret.length > RESPONSE_LIMITS.maxSecretChars || !SECRET_RE.test(secret)) {
    throw new FatooraInputError('creds.secret', 'السرّ يجب أن يكون نصاً مطبوعاً غير فارغ ومحدود الطول');
  }
  return { token, secret };
}

function validateInvoiceBody(b: unknown): InvoiceBody {
  if (!b || typeof b !== 'object') throw new FatooraInputError('body', 'جسم المستند مفقود');
  const { invoiceHash, uuid, invoice } = b as Partial<InvoiceBody>;
  if (typeof invoiceHash !== 'string' || invoiceHash.length !== 44 || !isCanonicalBase64(invoiceHash) || Buffer.from(invoiceHash, 'base64').length !== 32) {
    throw new FatooraInputError('body.invoiceHash', 'invoiceHash يجب أن يكون base64 لـ32 بايت');
  }
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw new FatooraInputError('body.uuid', 'uuid ليس بصيغة 8-4-4-4-12');
  if (!looksLikeBase64Xml(invoice, MAX_INVOICE_B64_CHARS)) {
    throw new FatooraInputError('body.invoice', 'invoice يجب أن يكون base64 قانونياً غير فارغ لمستند XML ضمن حدّ الحجم');
  }
  return { invoiceHash, uuid, invoice };
}

function validateComplianceRequestId(id: unknown): string {
  // يُرسَل نصاً كما في مثال Swagger ("1234567890123")
  if (typeof id !== 'string' || !COMPLIANCE_REQUEST_ID_RE.test(id)) throw new FatooraInputError('complianceRequestId', 'compliance_request_id يجب أن يكون أرقاماً موجبة نصاً');
  return id;
}

function validTimeout(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX_TIMEOUT_MS;
}

// ─── تبادل HTTP ───

type BodyRead =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'timeout' }
  | { kind: 'network'; errorText: string };

type Exchange =
  | { kind: 'no-response'; failure: 'timeout' | 'network'; errorText: string | null }
  | { kind: 'invalid-response'; detail: 'invalid-fetch-response' | 'fetch-unavailable' }
  | { kind: 'response'; status: number; parsed: ParsedBody | null; bodyFailure: 'timeout' | 'network' | null; bytes: number | null; retryAfterSeconds: number | null; errorText: string | null };

const TIMEOUT = Symbol('timeout');

/**
 * اسم الخطأ ورمز السبب فقط — رسائل الأخطاء قد تحمل أي شيء. القيم تُقبل كما هي إن طابقت شكل الأسماء والرموز
 * المعروفة (TypeError، ECONNRESET، UND_ERR_SOCKET) وإلا تُسقط: التنقية بحذف المحارف كانت تُبقي سرّاً بلا حشوه
 * «=» فيفلت من المطابقة الحرفية.
 */
function describeError(e: unknown): string {
  const rawName = e instanceof Error ? e.name : null;
  const name = typeof rawName === 'string' && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(rawName) ? rawName : 'Error';
  const obj = e && typeof e === 'object' ? (e as { code?: unknown; cause?: unknown }) : null;
  const cause = obj && obj.cause && typeof obj.cause === 'object' ? (obj.cause as { code?: unknown }) : null;
  const okCode = (c: unknown): c is string => typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(c);
  const code = okCode(cause?.code) ? cause!.code : okCode(obj?.code) ? obj!.code : null;
  return code ? `${name}(${code})` : name;
}

function swallow(p: unknown): void {
  if (p && typeof (p as Promise<unknown>).then === 'function') (p as Promise<unknown>).then(undefined, () => undefined);
}

function readHeader(res: FatooraFetchResponse, name: string): string | null {
  try {
    const v = res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

async function readBodyCapped(res: FatooraFetchResponse, cap: number, deadline: Promise<typeof TIMEOUT>): Promise<BodyRead> {
  const declared = readHeader(res, 'content-length');
  const cancelBody = () => {
    try {
      const r = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
      if (r) swallow(r.cancel());
    } catch {
      /* الجسم مقفل أو مستهلك */
    }
  };
  if (declared !== null && /^\s*[0-9]{1,16}\s*$/.test(declared) && Number(declared) > cap) {
    cancelBody();
    return { kind: 'too-large', bytes: Number(declared) };
  }
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = reader.read();
        swallow(next);
        const r = await Promise.race([next, deadline]);
        if (r === TIMEOUT) {
          swallow(reader.cancel());
          return { kind: 'timeout' };
        }
        if (!r || typeof r !== 'object') return { kind: 'network', errorText: 'InvalidChunk' };
        if (r.done) break;
        const chunk = r.value;
        if (!(chunk instanceof Uint8Array)) {
          swallow(reader.cancel());
          return { kind: 'network', errorText: 'InvalidChunk' };
        }
        total += chunk.byteLength;
        if (total > cap) {
          swallow(reader.cancel());
          return { kind: 'too-large', bytes: total };
        }
        chunks.push(chunk);
      }
      return { kind: 'ok', bytes: Buffer.concat(chunks, total) };
    }
    if (typeof res.arrayBuffer === 'function') {
      const p = res.arrayBuffer();
      swallow(p);
      const r = await Promise.race([p, deadline]);
      if (r === TIMEOUT) return { kind: 'timeout' };
      if (!(r instanceof ArrayBuffer)) return { kind: 'network', errorText: 'InvalidBody' };
      if (r.byteLength > cap) return { kind: 'too-large', bytes: r.byteLength };
      return { kind: 'ok', bytes: new Uint8Array(r) };
    }
    return { kind: 'ok', bytes: new Uint8Array(0) };
  } catch (e) {
    return { kind: 'network', errorText: describeError(e) };
  }
}

/** كل النصوص داخل قيمة (بعمق محدود) — لفحص السطر قبل تسليمه للسجلّ. */
function collectStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && depth < 8) {
    for (const x of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) collectStrings(x, out, depth + 1);
  }
  return out;
}

function retryAfterSeconds(res: FatooraFetchResponse): number | null {
  const v = readHeader(res, 'retry-after');
  if (v === null || !/^\s*[0-9]{1,6}\s*$/.test(v)) return null;
  const n = Number(v);
  return n <= 86400 ? n : null;
}

// ─── العميل ───

interface PreparedCall {
  endpoint: FatooraEndpoint;
  creds: Creds | null;
  otp: string | null;
  payload: Record<string, string>;
  attempt: number;
  counts: EscalationCounts;
  timeoutMs: number;
  uuid: string | null;
  invoiceHash: string | null;
}

type AnyOutcome = Outcome | CsidOutcome;

export class FatooraClient {
  readonly env: FatooraEnv;
  readonly baseUrl: string;
  private readonly fetchImpl: FatooraFetch | undefined;
  private readonly logFn: (entry: ApiLogEntry) => Promise<void>;
  private readonly onboardingTimeoutMs: number;
  private readonly submissionTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly acceptLanguage: 'ar' | 'en';
  private readonly logTimeoutMs: number;
  private readonly clock: () => number;

  constructor(opts: FatooraClientOptions) {
    if (!opts || typeof opts !== 'object') throw new FatooraInputError('options', 'خيارات العميل مفقودة');
    if (!Object.prototype.hasOwnProperty.call(FATOORA_BASE_URLS, opts.env)) throw new FatooraInputError('options', 'env يجب أن يكون sandbox أو simulation أو production');
    if (typeof opts.log !== 'function') throw new FatooraInputError('options', 'log مطلوب (سجلّ لكل محاولة)');
    if (opts.fetch !== undefined && typeof opts.fetch !== 'function') throw new FatooraInputError('options', 'fetch يجب أن يكون دالّة');
    for (const k of ['timeoutMs', 'onboardingTimeoutMs', 'submissionTimeoutMs', 'logTimeoutMs'] as const) {
      if (opts[k] !== undefined && !validTimeout(opts[k])) throw new FatooraInputError('timeoutMs', `${k} يجب أن يكون عدداً صحيحاً بين 1 و${MAX_TIMEOUT_MS}`);
    }
    if (opts.maxResponseBytes !== undefined && !(Number.isSafeInteger(opts.maxResponseBytes) && opts.maxResponseBytes >= 1024 && opts.maxResponseBytes <= RESPONSE_LIMITS.maxBodyBytes)) {
      throw new FatooraInputError('options', 'maxResponseBytes خارج المدى');
    }
    if (opts.acceptLanguage !== undefined && opts.acceptLanguage !== 'ar' && opts.acceptLanguage !== 'en') throw new FatooraInputError('options', 'acceptLanguage يجب أن يكون ar أو en');
    if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new FatooraInputError('options', 'clock يجب أن يكون دالّة');

    this.env = opts.env;
    this.baseUrl = FATOORA_BASE_URLS[opts.env];
    this.fetchImpl = opts.fetch;
    this.logFn = opts.log;
    this.onboardingTimeoutMs = opts.timeoutMs ?? opts.onboardingTimeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS;
    this.submissionTimeoutMs = opts.timeoutMs ?? opts.submissionTimeoutMs ?? DEFAULT_SUBMISSION_TIMEOUT_MS;
    this.maxResponseBytes = opts.maxResponseBytes ?? RESPONSE_LIMITS.maxBodyBytes;
    this.acceptLanguage = opts.acceptLanguage ?? 'ar';
    this.logTimeoutMs = opts.logTimeoutMs ?? DEFAULT_LOG_TIMEOUT_MS;
    this.clock = opts.clock ?? (() => performance.now());
  }

  /** POST /compliance — CSR + OTP ⇒ شهادة امتثال (CCSID) [S1 §4.1]. body.csr = base64 لنصّ PEM كاملاً. */
  async requestComplianceCsid(csrPem: string, otp: string, call?: CallOptions): Promise<CsidOutcome> {
    validateCsrPem(csrPem);
    const o = validateOtp(otp);
    const c = this.callOptions('compliance', call);
    return (await this.run({ endpoint: 'compliance', creds: null, otp: o, payload: { csr: Buffer.from(csrPem, 'utf8').toString('base64') }, uuid: null, invoiceHash: null, ...c })) as CsidOutcome;
  }

  /** POST /compliance/invoices — فحص امتثال مستند واحد بشهادة الامتثال [S1 §4.2]. */
  async checkComplianceInvoice(creds: Creds, body: InvoiceBody, call?: CallOptions): Promise<Outcome> {
    return this.submitInvoice('compliance-invoices', creds, body, call);
  }

  /** POST /production/csids — {compliance_request_id} بشهادة الامتثال ⇒ شهادة الإنتاج [S1 §4.3]. */
  async requestProductionCsid(creds: Creds, complianceRequestId: string, call?: CallOptions): Promise<CsidOutcome> {
    const cr = validateCreds(creds);
    const id = validateComplianceRequestId(complianceRequestId);
    const c = this.callOptions('production-csid', call);
    return (await this.run({ endpoint: 'production-csid', creds: cr, otp: null, payload: { compliance_request_id: id }, uuid: null, invoiceHash: null, ...c })) as CsidOutcome;
  }

  /**
   * PATCH /production/csids — تجديد بشهادة الإنتاج الحالية + CSR جديد + OTP تجديد [S1 §4.4].
   * 200 ⇒ ISSUED؛ 428 ⇒ NOT_COMPLIANT مع شهادة امتثال جديدة تُكمَل بها الفحوص ثم POST [S14].
   * UNVERIFIED(U10/report §14.6): هل تصلح شهادة إنتاج منتهية لتفويض هذا الطلب.
   */
  async renewProductionCsid(creds: Creds, csrPem: string, otp: string, call?: CallOptions): Promise<CsidOutcome> {
    const cr = validateCreds(creds);
    validateCsrPem(csrPem);
    const o = validateOtp(otp);
    const c = this.callOptions('renewal', call);
    return (await this.run({ endpoint: 'renewal', creds: cr, otp: o, payload: { csr: Buffer.from(csrPem, 'utf8').toString('base64') }, uuid: null, invoiceHash: null, ...c })) as CsidOutcome;
  }

  /** POST /invoices/reporting/single — مستند مبسّط، Clearance-Status: 0 [S1 §4.5]. */
  async report(creds: Creds, body: InvoiceBody, call?: CallOptions): Promise<Outcome> {
    return this.submitInvoice('reporting', creds, body, call);
  }

  /** POST /invoices/clearance/single — مستند قياسي، Clearance-Status: 1 [S1 §4.6]. */
  async clear(creds: Creds, body: InvoiceBody, call?: CallOptions): Promise<Outcome> {
    return this.submitInvoice('clearance', creds, body, call);
  }

  private async submitInvoice(endpoint: InvoiceEndpoint, creds: Creds, body: InvoiceBody, call?: CallOptions): Promise<Outcome> {
    const cr = validateCreds(creds);
    const b = validateInvoiceBody(body);
    const c = this.callOptions(endpoint, call);
    // ترتيب المفاتيح كما في مثال Swagger
    const payload = { invoiceHash: b.invoiceHash, uuid: b.uuid, invoice: b.invoice };
    return (await this.run({ endpoint, creds: cr, otp: null, payload, uuid: b.uuid, invoiceHash: b.invoiceHash, ...c })) as Outcome;
  }

  private callOptions(endpoint: FatooraEndpoint, call: CallOptions | undefined): { attempt: number; counts: EscalationCounts; timeoutMs: number } {
    if (call !== undefined && (call === null || typeof call !== 'object')) throw new FatooraInputError('attempt', 'خيارات الاستدعاء يجب أن تكون كائناً');
    const attempt = call?.attempt ?? 1;
    if (!(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= MAX_ATTEMPT)) throw new FatooraInputError('attempt', `attempt يجب أن يكون عدداً صحيحاً بين 1 و${MAX_ATTEMPT}`);
    const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_ESCALATION_COUNT;
    const priorEmpty400 = call?.priorEmpty400 ?? 0;
    if (!validCount(priorEmpty400)) throw new FatooraInputError('priorEmpty400', `priorEmpty400 يجب أن يكون عدداً صحيحاً بين 0 و${MAX_ESCALATION_COUNT}`);
    const priorPayload413 = call?.priorPayload413 ?? 0;
    if (!validCount(priorPayload413)) throw new FatooraInputError('priorPayload413', `priorPayload413 يجب أن يكون عدداً صحيحاً بين 0 و${MAX_ESCALATION_COUNT}`);
    const fallback = FATOORA_ENDPOINT_SPECS[endpoint].timeoutClass === 'onboarding' ? this.onboardingTimeoutMs : this.submissionTimeoutMs;
    const timeoutMs = call?.timeoutMs ?? fallback;
    if (!validTimeout(timeoutMs)) throw new FatooraInputError('timeoutMs', `timeoutMs يجب أن يكون عدداً صحيحاً بين 1 و${MAX_TIMEOUT_MS}`);
    return { attempt, counts: { priorEmpty400, priorPayload413 }, timeoutMs };
  }

  private headers(spec: EndpointSpec, call: PreparedCall): Record<string, string> {
    const h: Record<string, string> = { 'Accept-Version': 'V2', 'Content-Type': 'application/json' };
    if (spec.acceptLanguage) h['Accept-Language'] = this.acceptLanguage;
    if (spec.otp && call.otp !== null) h.OTP = call.otp;
    if (spec.auth && call.creds) h.Authorization = `Basic ${Buffer.from(`${call.creds.token}:${call.creds.secret}`, 'utf8').toString('base64')}`;
    if (spec.clearanceStatus !== null) h['Clearance-Status'] = spec.clearanceStatus;
    return h;
  }

  private async run(call: PreparedCall): Promise<AnyOutcome> {
    const spec = FATOORA_ENDPOINT_SPECS[call.endpoint];
    const headers = this.headers(spec, call);
    const secrets: Array<string | null> = [
      call.otp,
      call.creds?.token ?? null,
      call.creds?.secret ?? null,
      headers.Authorization ? headers.Authorization.slice('Basic '.length) : null,
    ];
    const started = this.clock();
    let outcome: AnyOutcome;
    let ex: Exchange | null = null;
    try {
      ex = await this.exchange(call.endpoint, `${this.baseUrl}${spec.path}`, { method: spec.method, headers, body: JSON.stringify(call.payload), redirect: 'manual' }, call.timeoutMs);
      outcome = this.outcomeOf(call, ex);
    } catch {
      outcome = { kind: 'CONFIG', detail: 'client-internal-error' };
    }
    const durationMs = Math.max(0, Math.round(this.clock() - started));
    await this.safeLog(this.logEntry(call, spec, ex, outcome, durationMs, secrets));
    return outcome;
  }

  private outcomeOf(call: PreparedCall, ex: Exchange): AnyOutcome {
    if (ex.kind === 'no-response') return { kind: 'RETRY', reason: ex.failure };
    if (ex.kind === 'invalid-response') return { kind: 'CONFIG', detail: ex.detail };
    const classify = (parsed: ParsedBody): AnyOutcome =>
      isCsidEndpoint(call.endpoint)
        ? classifyCsidParsed(call.endpoint, ex.status, parsed, call.counts)
        : classifyInvoiceParsed(call.endpoint as InvoiceEndpoint, ex.status, parsed, call.counts);
    let outcome: AnyOutcome;
    if (ex.bodyFailure !== null) {
      // الجسم لم يُقرأ: الحالات التي لا تعتمد عليه تُصنَّف بالحالة، والباقي يُعاد (الرد ضاع فعلياً)
      outcome = responseNeedsBody(call.endpoint, ex.status) ? { kind: 'RETRY', reason: ex.bodyFailure as RetryReason } : classify({ kind: 'empty' });
    } else {
      outcome = classify(ex.parsed ?? { kind: 'empty' });
    }
    if (outcome.kind === 'RETRY' && ex.retryAfterSeconds !== null && (outcome.reason === 'rate' || outcome.reason === 'server')) {
      outcome = { ...outcome, retryAfterSeconds: ex.retryAfterSeconds };
    }
    return outcome;
  }

  private async exchange(endpoint: FatooraEndpoint, url: string, init: Omit<FatooraFetchInit, 'signal'>, timeoutMs: number): Promise<Exchange> {
    const f = this.fetchImpl ?? ((globalThis as { fetch?: unknown }).fetch as FatooraFetch | undefined);
    if (typeof f !== 'function') return { kind: 'invalid-response', detail: 'fetch-unavailable' };
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // مهلة واحدة للاتصال والجسم معاً؛ لا نعتمد على احترام fetch للإشارة (fetch معطوب قد يتجاهلها)
    const deadline = new Promise<typeof TIMEOUT>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(TIMEOUT);
        try {
          controller.abort();
        } catch {
          /* لا شيء */
        }
      }, timeoutMs);
    });
    try {
      let res: FatooraFetchResponse;
      try {
        const p = Promise.resolve().then(() => f(url, { ...init, signal: controller.signal }));
        swallow(p);
        const r = await Promise.race([p, deadline]);
        if (r === TIMEOUT) return { kind: 'no-response', failure: 'timeout', errorText: 'Timeout' };
        res = r;
      } catch (e) {
        if (timedOut) return { kind: 'no-response', failure: 'timeout', errorText: 'Timeout' };
        return { kind: 'no-response', failure: 'network', errorText: describeError(e) };
      }
      const status = res && typeof res === 'object' ? res.status : undefined;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) {
        return { kind: 'invalid-response', detail: 'invalid-fetch-response' };
      }
      const retryAfter = retryAfterSeconds(res);
      // السقف بحسب المسار والحالة: 8 MiB فقط حيث قد يرد clearedInvoice؛ 5xx/401/429 ومسارات الشهادات 64 KiB.
      // JSON.parse متزامن لا تقطعه المهلة، فالسقف الصغير مع فحص الشكل في parseResponseBody يحدّان كلفته.
      const cap = Math.min(responseBodyCap(endpoint, status), this.maxResponseBytes);
      const body = await readBodyCapped(res, cap, deadline);
      if (body.kind === 'timeout' || body.kind === 'network') {
        return {
          kind: 'response', status, parsed: null, bodyFailure: body.kind, bytes: null, retryAfterSeconds: retryAfter,
          errorText: body.kind === 'timeout' ? 'Timeout' : body.errorText,
        };
      }
      const parsed = body.kind === 'too-large' ? parseResponseBody(new BodyTooLarge(body.bytes)) : parseResponseBody(body.bytes, cap);
      return {
        kind: 'response', status, parsed, bodyFailure: null, retryAfterSeconds: retryAfter, errorText: null,
        bytes: body.kind === 'too-large' ? body.bytes : body.bytes.byteLength,
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private logEntry(call: PreparedCall, spec: EndpointSpec, ex: Exchange | null, outcome: AnyOutcome, durationMs: number, secrets: Array<string | null>): ApiLogEntry {
    let response: RedactedResponse | null = null;
    let errorText: string | null = null;
    let httpStatus: number | null = null;
    let responseBytes: number | null = null;
    const allSecrets = [...secrets];
    if (ex && ex.kind === 'response') {
      httpStatus = ex.status;
      responseBytes = ex.bytes;
      errorText = ex.errorText;
      if (ex.parsed) {
        // الرمز والسرّ الجديدان في رد الشهادات أسرار أيضاً — من JSON ومن النص الخام حين لا يُحلَّل (ذيل زائد بعد JSON)
        allSecrets.push(...responseCredentialStrings(call.endpoint, ex.parsed));
        response = redactResponseForLog(call.endpoint, ex.parsed, allSecrets);
      }
    } else if (ex && ex.kind === 'no-response') {
      errorText = ex.errorText;
    }
    const matcher = compileSecrets(allSecrets);
    const entry: ApiLogEntry = {
      env: this.env,
      endpoint: call.endpoint,
      method: spec.method,
      path: spec.path,
      attempt: call.attempt,
      httpStatus,
      outcome: outcome.kind,
      reason: outcome.kind === 'RETRY' ? outcome.reason : outcome.kind === 'CONFIG' ? outcome.detail : null,
      durationMs,
      responseBytes,
      uuid: call.uuid,
      invoiceHash: call.invoiceHash,
      response,
      errorText: errorText === null ? null : matcher.scrub(errorText),
    };
    // حاجز أخير: إن ظهر أي سرّ أو جزء منه (نافذة 16 بلا حساسية لحالة الأحرف) في أي نصّ من السطر، يُسقط ما قد يحمله.
    // يُفحص كل نصّ منفرداً (لا JSON كاملاً) كي لا يطابق OTP رقمي أرقاماً مثل durationMs.
    try {
      if (collectStrings(entry).some(text => matcher.contains(text))) {
        entry.response = null;
        entry.errorText = '[REDACTED]';
      }
    } catch {
      entry.response = null;
    }
    return entry;
  }

  private async safeLog(entry: ApiLogEntry): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const p = Promise.resolve().then(() => this.logFn(entry));
      swallow(p);
      const cap = new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.logTimeoutMs);
      });
      await Promise.race([p, cap]);
    } catch {
      /* فشل السجلّ لا يغيّر النتيجة */
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// ─── أدوات CSID ───

/** يفكّ شهادة CSID من binarySecurityToken (C-S9) — يرمي CsidCertError (CERT_INVALID) عند الخلل. */
export function decodeCsid(csid: Pick<CsidResult, 'binarySecurityToken'>): CsidCert {
  return parseCsidToken(csid.binarySecurityToken);
}

/** بيانات Basic من نتيجة CSID: الرمز حرفياً كما أُعيد (لا الشهادة المفكوكة) [SWG]. */
export function credsFromCsid(csid: Pick<CsidResult, 'binarySecurityToken' | 'secret'>): Creds {
  return { token: csid.binarySecurityToken, secret: csid.secret };
}
