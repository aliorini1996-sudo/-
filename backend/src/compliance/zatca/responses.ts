// ============================================================================
// ZATCA المرحلة الثانية (Z3) — قراءة ردود واجهة «فاتورة» وتصنيفها
// ----------------------------------------------------------------------------
// نقيّ تماماً: لا شبكة، لا قاعدة بيانات، لا ساعة. يأخذ (المسار، حالة HTTP، الجسم، عدّادات التصعيد) ويعيد
// نتيجة مصنَّفة يبني عليها Z4 (الربط) وZ5 (الإرسال وجدولة إعادة المحاولة) دون تحليل نصوص.
// • التصعيد (empty400 ثم REJECTED، 413 ثم CONFIG) يُحسب بعدد الردود السابقة من النوع نفسه لا برقم المحاولة الكلّي:
//   مستند تجاوز انقطاعاً (5xx/مهلة/شبكة) يستحقّ إعادة إرسال كاملة عند أول 400 فارغ [S27].
// • سقف الجسم لكل مسار وحالة، وفحص خطّي لشكل JSON قبل JSON.parse (المتزامن الذي لا تقطعه المهلة).
// • 200/202 لا يُقبل بالحالة وحدها: يلزم دليل إيجابي من الجسم (REPORTED/CLEARED أو validationResults.status PASS/WARNING)،
//   وإلا CONFIG unconfirmed-2xx — بوابة وسيطة تردّ 200 {} لا تُغلق مستنداً لم يُبلَّغ عنه (confirmed2xx).
// • design §3 Z3 «Classification» + report_apis-onboarding §3.4 (أشكال الأخطاء) و§5 (مصفوفة الحالات) و§6.
// • تسامح مقصود [D9405]: الهيئة تغيّر أشكال الردود بلا سجلّ تغييرات — errorMessages/erroMessages،
//   errors نصوص أو كائنات، error مفرداً، الشكل المسطّح لفحص CSR، {errorCode,errorCategory,errorMessage}،
//   جسم 401 وجسم 406 النصّي وأشكال 500.
// • qrSellertStatus / qrBuyertStatus بهذا الإملاء الخاطئ في الردود الحقيقية [SWG] — نُبقيه اسماً للحقل.
// • بوابة معادية أو معطوبة: حدّ لحجم الجسم وعدد الرسائل وطولها، ولا رمي أبداً على JSON معيب.
// • detail في CONFIG رموز ثابتة آمنة فقط — لا يُنسخ إليه شيء من جسم الردّ.
// لا zod هنا عمداً: التحقق بمخطّط صارم يرفض الأشكال المتغيّرة، ووحدة zatca كلها بلا تبعيات (مثل Z2).
// ============================================================================

import { inspect } from 'util';
import { MAX_CERT_B64_LENGTH, isCanonicalBase64 } from './cert';

// ─── الأنواع العامة ───

export type InvoiceEndpoint = 'compliance-invoices' | 'reporting' | 'clearance';
export type CsidEndpoint = 'compliance' | 'production-csid' | 'renewal';
/** أسماء المسارات كما تُكتب في ZatcaApiLog.endpoint (design §1.3). */
export type FatooraEndpoint = CsidEndpoint | InvoiceEndpoint;

export const INVOICE_ENDPOINTS: readonly InvoiceEndpoint[] = Object.freeze(['compliance-invoices', 'reporting', 'clearance'] as InvoiceEndpoint[]);
export const CSID_ENDPOINTS: readonly CsidEndpoint[] = Object.freeze(['compliance', 'production-csid', 'renewal'] as CsidEndpoint[]);

export function isInvoiceEndpoint(e: unknown): e is InvoiceEndpoint {
  return typeof e === 'string' && (INVOICE_ENDPOINTS as readonly string[]).includes(e);
}
export function isCsidEndpoint(e: unknown): e is CsidEndpoint {
  return typeof e === 'string' && (CSID_ENDPOINTS as readonly string[]).includes(e);
}

export type MsgType = 'INFO' | 'WARNING' | 'ERROR';

/** رسالة موحَّدة من أي شكل موثَّق. type = الدلو الذي جاءت منه (مصدر الحقيقة للتصنيف)؛ الباقي نصوص محدودة أو null. */
export interface Msg {
  type: MsgType;
  code: string | null;
  category: string | null;
  message: string | null;
  status: string | null;
}

export type RetryReason = 'rate' | 'server' | 'timeout' | 'network' | 'empty400' | 'payload';

/** design §3 Z3 — نتيجة مسارات المستندات (compliance/invoices، reporting، clearance). */
export type Outcome =
  | { kind: 'ACCEPTED'; warnings: Msg[]; clearedXmlB64?: string }        // 200 / 202 بدليل إيجابي في الجسم
  | { kind: 'DUPLICATE'; clearedXmlB64?: string }                        // 409 / 208
  | { kind: 'CLEARANCE_OFF' }                                            // 303 على clearance
  | { kind: 'REJECTED'; errors: Msg[]; warnings: Msg[] }                 // 400 برسائل
  | { kind: 'RETRY'; reason: RetryReason; retryAfterSeconds?: number }
  | { kind: 'AUTH' }                                                     // 401
  | { kind: 'CONFIG'; detail: string };                                  // 406، غير مقروء، غير متوقَّع

/**
 * بيانات CSID كما أعادتها الهيئة. binarySecurityToken وsecret سرّان: JSON.stringify وutil.inspect على
 * الكائن (أو على نتيجة تحويه) يُخفيانهما (toJSON وinspect.custom غير قابلين للتعداد)، والقراءة المباشرة للحقلين
 * تبقى متاحة لـZ4 كي يشفّرهما.
 */
export interface CsidResult {
  /** رقم الطلب نصاً (دقّة كاملة ولو تجاوز 2^53). */
  requestID: string | null;
  /** مُطبَّع: أحرف كبيرة و_ بدل الفراغ والشرطة (ISSUED، NOT_COMPLIANT). */
  dispositionMessage: string | null;
  binarySecurityToken: string;
  secret: string;
  tokenType: string | null;
  errors: Msg[];
}

/** نتيجة مسارات الشهادات: POST /compliance، POST /production/csids، PATCH /production/csids. */
export type CsidOutcome =
  | { kind: 'ISSUED'; csid: CsidResult }
  | { kind: 'NOT_COMPLIANT'; ccsid: CsidResult }                         // PATCH 428 (شهادة امتثال جديدة)
  | { kind: 'REJECTED'; errors: Msg[]; dispositionMessage: string | null }
  | { kind: 'RETRY'; reason: RetryReason; retryAfterSeconds?: number }
  | { kind: 'AUTH' }
  | { kind: 'CONFIG'; detail: string };

// ─── الحدود ───

export const RESPONSE_LIMITS = Object.freeze({
  /**
   * أكبر جسم ردّ يُقرأ إطلاقاً، ولا يُسمح به إلا حيث قد يرد clearedInvoice (مسارات المستندات 200/202/208/409):
   * مستند بحدّ الختم (4 MiB XML ≈ 5.6 MiB base64) مع هامش.
   */
  maxBodyBytes: 8 * 1024 * 1024,
  /** 400 على مسارات المستندات: رسائل فقط (مئات الرسائل ≈ مئات الكيلوبايت). */
  maxRejectionBodyBytes: 1024 * 1024,
  /** مسارات الشهادات (الرمز ≤ 11 KB) وكل حالة تُصنَّف بلا جسم (401/406/413/429/5xx/303…). */
  maxSmallBodyBytes: 64 * 1024,
  /** أقصى عمق تعشيش JSON يُحلَّل (ردود الهيئة بعمق ≈ 4). */
  maxJsonDepth: 32,
  /** أقصى عدد رموز بنيوية ({ [ , :) خارج النصوص قبل JSON.parse — clearedInvoice نصّ واحد لا يُعدّ. */
  maxJsonStructuralTokens: 50000,
  maxMessagesPerBucket: 100,
  maxMessageChars: 1000,
  maxCodeChars: 128,
  maxCategoryChars: 128,
  maxStatusChars: 64,
  maxTokenTypeChars: 256,
  maxSecretChars: 512,
});

/** نفس سقف parseCsidToken في cert.ts. */
export const MAX_CSID_TOKEN_CHARS = Math.ceil(MAX_CERT_B64_LENGTH / 3) * 4;

/** design: 400 بلا أي رسالة ⇒ RETRY حتى 3 مرات [D1399]؛ الرابع (بعد ثلاثة 400 فارغة سابقة) ⇒ REJECTED. */
export const EMPTY400_MAX_RETRIES = 3;
/** design: 413 ⇒ RETRY مرة واحدة؛ الثاني (بعد 413 سابق) ⇒ CONFIG. */
export const PAYLOAD413_MAX_RETRIES = 1;
/** رمز الرسالة المُركَّبة محلياً حين يُستنفد RETRY empty400 (ليس رمزاً من الهيئة). */
export const EMPTY400_EXHAUSTED_CODE = 'FS-EMPTY-400';
export const MAX_ESCALATION_COUNT = 10000;

/**
 * مُدخل التصعيد لكل مستند (البايتات نفسها) — **ليس** رقم المحاولة الكلّي ولا ZatcaDocument.attempts ولا attemptNo:
 * المحاولات التي فشلت لسبب آخر (مهلة، شبكة، 429، 5xx) لا تُحسب هنا، وإلا صار أول 400 فارغ بعد انقطاع REJECTED
 * فيُلغى مستند B2B [Z5.9] دون الإعادة التي يوصي بها موظفو الهيئة [S27]. Z5 يزيد كل عدّاد فقط حين يعود RETRY بسببه.
 */
export interface EscalationCounts {
  /** عدد المحاولات السابقة لهذا المستند التي صُنِّفت RETRY empty400. */
  priorEmpty400: number;
  /** عدد المحاولات السابقة لهذا المستند التي صُنِّفت RETRY payload (413). */
  priorPayload413: number;
}

/** أول إرسال (أو مستند لم يرَ 400 فارغاً ولا 413 بعد). */
export const NO_PRIOR_ESCALATIONS: Readonly<EscalationCounts> = Object.freeze({ priorEmpty400: 0, priorPayload413: 0 });

// ─── قراءة الجسم ───

/** علامة يمرّرها العميل حين يتجاوز الجسم السقف (لم يُقرأ كاملاً). */
export class BodyTooLarge {
  constructor(readonly bytes: number) {}
}

export type ParsedBody =
  | { kind: 'empty' }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'json'; value: unknown; text: string | null }
  | { kind: 'text'; text: string };

/**
 * فحص خطّي لشكل JSON قبل JSON.parse. التحليل متزامن لا تقطعه مهلة الطلب، وجسم معادٍ ضمن السقف ([[[…]]] أو
 * [{},{},…]) يبني ملايين الكائنات فيوقف حلقة الأحداث للخادم كله ثوانيَ ويستهلك مئات الميغابايت.
 * يعدّ العمق والرموز البنيوية ({ [ , :) خارج النصوص فقط، ويقفز فوق كل نصّ بـindexOf (clearedInvoice بحجم
 * 5.6 MiB قفزة واحدة). لا يتحقّق من صحّة JSON — JSON.parse يفعل ذلك بعده؛ نصّ غير مغلق يُترك له فيفشل سريعاً.
 */
export function jsonShapeWithinLimits(
  text: string,
  maxDepth: number = RESPONSE_LIMITS.maxJsonDepth,
  maxTokens: number = RESPONSE_LIMITS.maxJsonStructuralTokens,
): boolean {
  let depth = 0;
  let tokens = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      let j = i;
      for (;;) {
        j = text.indexOf('"', j + 1);
        if (j < 0) return true;
        let k = j - 1;
        while (k > i && text.charCodeAt(k) === 0x5c) k--;
        if ((j - 1 - k) % 2 === 0) break; // عدد زوجي من «\» قبل «"» ⇒ نهاية النص
      }
      i = j;
    } else if (c === 0x7b || c === 0x5b) {
      if (++depth > maxDepth || ++tokens > maxTokens) return false;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    } else if (c === 0x2c || c === 0x3a) {
      if (++tokens > maxTokens) return false;
    }
  }
  return true;
}

/**
 * يحوّل جسم الردّ إلى شكل مصنَّف دون رمي أبداً:
 * نصّ أو بايتات UTF-8 (BOM يُحذف) ⇒ json إن أمكن تحليله وإلا text؛ null/undefined/فراغ ⇒ empty؛
 * BodyTooLarge أو ما يتجاوز maxBytes ⇒ too-large؛ أي قيمة أخرى تُعدّ JSON محلَّلاً مسبقاً.
 * JSON يتجاوز حدود الشكل (jsonShapeWithinLimits) لا يُحلَّل ويُعدّ text (⇒ unparseable-body حيث يلزم الجسم).
 */
export function parseResponseBody(body: unknown, maxBytes: number = RESPONSE_LIMITS.maxBodyBytes): ParsedBody {
  try {
    if (body instanceof BodyTooLarge) return { kind: 'too-large', bytes: body.bytes };
    if (body === null || body === undefined) return { kind: 'empty' };
    let text: string;
    if (body instanceof Uint8Array) {
      if (body.byteLength > maxBytes) return { kind: 'too-large', bytes: body.byteLength };
      text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
    } else if (typeof body === 'string') {
      if (body.length > maxBytes || Buffer.byteLength(body, 'utf8') > maxBytes) return { kind: 'too-large', bytes: Buffer.byteLength(body, 'utf8') };
      text = body;
    } else {
      return { kind: 'json', value: body, text: null };
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (text.trim() === '') return { kind: 'empty' };
    if (!jsonShapeWithinLimits(text)) return { kind: 'text', text };
    try {
      return { kind: 'json', value: JSON.parse(text), text };
    } catch {
      return { kind: 'text', text };
    }
  } catch {
    return { kind: 'text', text: '' };
  }
}

// ─── أدوات قراءة آمنة ───

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? (v as Rec) : null;
}

function own(o: Rec | null, key: string): unknown {
  return o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** أول مفتاح موجود بقيمة ليست null/undefined. */
function pick(o: Rec | null, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = own(o, k);
    if (v !== null && v !== undefined) return v;
  }
  return undefined;
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]+/g;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** نصّ محدود بلا محارف تحكّم ولا بدائل منفردة؛ الأرقام المنتهية تُحوَّل نصاً؛ غير ذلك أو الفراغ ⇒ null. */
export function cleanText(v: unknown, max: number): string | null {
  let s: string;
  if (typeof v === 'string') s = v;
  else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
  else return null;
  if (s.length > max * 2 + 16) s = s.slice(0, max * 2 + 16);
  s = s.replace(CONTROL_RE, ' ').replace(LONE_SURROGATE_RE, '\ufffd').replace(/ {2,}/g, ' ').trim();
  if (!s) return null;
  if (s.length > max) {
    let cut = Math.max(0, max - 1);
    const c = s.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    s = `${s.slice(0, cut)}…`;
  }
  return s;
}

/** حالة مُطبَّعة: "Not Reported" ⇒ NOT_REPORTED. */
function normToken(v: unknown): string | null {
  const s = cleanText(v, RESPONSE_LIMITS.maxStatusChars);
  return s === null ? null : s.toUpperCase().replace(/[\s-]+/g, '_');
}

// ─── الرسائل ───

export interface MessageSet {
  info: Msg[];
  warnings: Msg[];
  errors: Msg[];
  /** تجاوز أحد الدلاء السقف فأُهمل الباقي. */
  truncated: boolean;
}

function nullMsg(type: MsgType): Msg {
  return { type, code: null, category: null, message: null, status: null };
}

function toMsg(item: unknown, bucket: MsgType): Msg {
  const L = RESPONSE_LIMITS;
  if (typeof item === 'string' || typeof item === 'number') {
    return { type: bucket, code: null, category: null, message: cleanText(item, L.maxMessageChars), status: null };
  }
  const o = asRecord(item);
  if (!o) return nullMsg(bucket);
  const status = own(o, 'status');
  return {
    type: bucket,
    code: cleanText(pick(o, 'code', 'errorCode'), L.maxCodeChars),
    category: cleanText(pick(o, 'category', 'errorCategory'), L.maxCategoryChars),
    message: cleanText(pick(o, 'message', 'errorMessage'), L.maxMessageChars),
    // status الرسالة (PASS/WARNING/ERROR) نصّ فقط؛ الرقم هو حالة HTTP في جسم 401 وليس حالة رسالة
    status: typeof status === 'string' ? cleanText(status, L.maxStatusChars) : null,
  };
}

/** هل تحمل الرسالة أي معلومة؟ (D1399: الهيئة قد تعيد رسائل كل حقولها null). */
export function isMeaningfulMsg(m: Msg): boolean {
  return m.code !== null || m.message !== null || m.category !== null;
}

function meaningful(list: Msg[]): Msg[] {
  return list.filter(isMeaningfulMsg);
}

/**
 * يجمع الرسائل من كل الأشكال الموثَّقة (report §3.4، §4، §6):
 *   validationResults.{infoMessages,warningMessages,errorMessages,erroMessages} — مصفوفة أو كائن مفرد (مثال Swagger المعطوب)
 *   نفس المفاتيح في المستوى الأعلى (warningMessages خارج validationResults في مثال Swagger)
 *   errors / error (نصوص أو كائنات أو مفرد) [D9405]، warnings (صيغة V1 القديمة)
 *   {errorCode,errorCategory,errorMessage} [S22]، والشكل المسطّح {type,message,category,code,status} [S15]
 *   وجسم 500 {code,message} / {category,code,message}، وجسم 303 {message}.
 */
export function extractMessages(json: unknown): MessageSet {
  const set: MessageSet = { info: [], warnings: [], errors: [], truncated: false };
  const o = asRecord(json);
  if (!o) return set;
  const cap = RESPONSE_LIMITS.maxMessagesPerBucket;

  const add = (target: Msg[], v: unknown, bucket: MsgType) => {
    if (v === null || v === undefined) return;
    const items = Array.isArray(v) ? v : [v];
    // لا نمرّ على مصفوفة ضخمة كاملة: السقف + واحد يكفي لمعرفة القصّ
    const n = Math.min(items.length, cap + 1);
    for (let i = 0; i < n; i++) {
      if (target.length >= cap) {
        set.truncated = true;
        return;
      }
      target.push(toMsg(items[i], bucket));
    }
    if (items.length > n) set.truncated = true;
  };

  const vr = asRecord(own(o, 'validationResults'));
  for (const src of vr ? [vr, o] : [o]) {
    add(set.info, own(src, 'infoMessages'), 'INFO');
    add(set.warnings, own(src, 'warningMessages'), 'WARNING');
    add(set.errors, own(src, 'errorMessages'), 'ERROR');
    add(set.errors, own(src, 'erroMessages'), 'ERROR'); // UNVERIFIED(report_libraries §3): الإملاء الخاطئ في OpenAPI المنسوخ
  }
  add(set.errors, own(o, 'errors'), 'ERROR');
  add(set.errors, own(o, 'error'), 'ERROR'); // D9405: error بدل errors
  add(set.warnings, own(o, 'warnings'), 'WARNING'); // V1 القديمة: {invoiceHash,status,warnings,errors}

  if (!vr) {
    const hasErrorTriple = ['errorCode', 'errorCategory', 'errorMessage'].some(k => own(o, k) !== undefined);
    if (hasErrorTriple) {
      add(set.errors, { code: own(o, 'errorCode'), category: own(o, 'errorCategory'), message: own(o, 'errorMessage') }, 'ERROR');
    } else if (own(o, 'message') !== undefined || own(o, 'code') !== undefined) {
      const t = normToken(own(o, 'type'));
      const bucket: MsgType = t === 'INFO' ? 'INFO' : t === 'WARNING' ? 'WARNING' : 'ERROR';
      add(bucket === 'INFO' ? set.info : bucket === 'WARNING' ? set.warnings : set.errors, o, bucket);
    }
  }
  return set;
}

// ─── ردود المستندات ───

export interface InvoiceResponse {
  /** validationResults.status مُطبَّعاً (PASS/WARNING/ERROR). */
  validationStatus: string | null;
  reportingStatus: string | null;
  clearanceStatus: string | null;
  /** النصّ كما ورد إن كان نصاً غير فارغ (يُتحقّق منه بـlooksLikeBase64Xml). */
  clearedInvoice: string | null;
  /** المفتاح موجود بقيمة ليست null ولا "" (نصاً كان أو غيره) — "" يُعامَل كغياب المستند. */
  clearedInvoicePresent: boolean;
  /** بالإملاء الخاطئ كما في الرد الحقيقي [SWG]؛ يُقبل الإملاء الصحيح احتياطاً إن صحّحته الهيئة. */
  qrSellertStatus: string | null;
  qrBuyertStatus: string | null;
  /** status في صيغة V1 القديمة ("Not Reported") حين لا يوجد validationResults. */
  legacyStatus: string | null;
  messages: MessageSet;
}

export function parseInvoiceResponse(json: unknown): InvoiceResponse | null {
  const o = asRecord(json);
  if (!o) return null;
  const vr = asRecord(own(o, 'validationResults'));
  const cleared = own(o, 'clearedInvoice');
  const legacy = own(o, 'status');
  return {
    validationStatus: normToken(own(vr, 'status')),
    reportingStatus: normToken(own(o, 'reportingStatus')),
    clearanceStatus: normToken(own(o, 'clearanceStatus')),
    clearedInvoice: typeof cleared === 'string' && cleared !== '' ? cleared : null,
    clearedInvoicePresent: cleared !== null && cleared !== undefined && cleared !== '',
    qrSellertStatus: cleanText(pick(o, 'qrSellertStatus', 'qrSellerStatus'), RESPONSE_LIMITS.maxStatusChars),
    qrBuyertStatus: cleanText(pick(o, 'qrBuyertStatus', 'qrBuyerStatus'), RESPONSE_LIMITS.maxStatusChars),
    legacyStatus: !vr && typeof legacy === 'string' ? normToken(legacy) : null,
    messages: extractMessages(o),
  };
}

/**
 * base64 قانوني لمستند XML: طول محدود، base64 قانوني بسطر واحد، وأول بايت بعد BOM/فراغات هو «<».
 * يُستعمل لـclearedInvoice في الرد ولجسم الطلب invoice في العميل.
 */
export function looksLikeBase64Xml(s: unknown, maxChars: number = RESPONSE_LIMITS.maxBodyBytes): s is string {
  if (typeof s !== 'string' || s.length < 4 || s.length > maxChars) return false;
  if (!isCanonicalBase64(s)) return false;
  const head = Buffer.from(s.slice(0, 64), 'base64');
  let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return head[i] === 0x3c;
}

// ─── ردود الشهادات ───

export interface CsidResponse {
  requestID: string | null;
  dispositionMessage: string | null;
  /** النصّان كما وردا حرفياً (بلا تنظيف — اسم المستخدم في Basic يجب أن يطابق حرفياً [SWG]). */
  binarySecurityToken: string | null;
  secret: string | null;
  tokenType: string | null;
  messages: MessageSet;
}

const REQUEST_ID_RE = /^[1-9][0-9]{0,29}$/;

function readRequestId(v: unknown, rawText: string | null): string | null {
  if (typeof v === 'string') return REQUEST_ID_RE.test(v) ? v : null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null;
  if (Number.isSafeInteger(v)) return String(v);
  // عدد يتجاوز 2^53 فقد دقّته في JSON.parse: نسترجع الأرقام من النص إن طابقت القيمة المحلَّلة
  if (rawText) {
    const m = /"requestI[Dd]"\s*:\s*([1-9][0-9]{0,29})\s*[,}]/.exec(rawText);
    if (m && Number(m[1]) === v) return m[1];
  }
  return null;
}

export function parseCsidResponse(json: unknown, rawText: string | null = null): CsidResponse | null {
  const o = asRecord(json);
  if (!o) return null;
  const token = own(o, 'binarySecurityToken');
  const secret = own(o, 'secret');
  return {
    requestID: readRequestId(pick(o, 'requestID', 'requestId'), rawText),
    dispositionMessage: normToken(own(o, 'dispositionMessage')),
    binarySecurityToken: typeof token === 'string' ? token : null,
    secret: typeof secret === 'string' ? secret : null,
    tokenType: cleanText(own(o, 'tokenType'), RESPONSE_LIMITS.maxTokenTypeChars),
    messages: extractMessages(o),
  };
}

const SECRET_RE = /^[\x21-\x7e]+$/;

/** اسم أول حقل ناقص أو معيب في بيانات CSID، أو null إن اكتملت. لا يعيد القيم أبداً. */
export function csidFieldIssue(p: CsidResponse, requireRequestId: boolean): 'binarySecurityToken' | 'secret' | 'requestID' | null {
  const t = p.binarySecurityToken;
  if (t === null || t.length > MAX_CSID_TOKEN_CHARS || !isCanonicalBase64(t)) return 'binarySecurityToken';
  const s = p.secret;
  if (s === null || s.length > RESPONSE_LIMITS.maxSecretChars || !SECRET_RE.test(s)) return 'secret';
  if (requireRequestId && p.requestID === null) return 'requestID';
  return null;
}

const REDACTED = '[REDACTED]';

function sealCsid(p: CsidResponse, errors: Msg[]): CsidResult {
  const r: CsidResult = {
    requestID: p.requestID,
    dispositionMessage: p.dispositionMessage,
    binarySecurityToken: p.binarySecurityToken as string,
    secret: p.secret as string,
    tokenType: p.tokenType,
    errors,
  };
  const view = () => ({ ...r, binarySecurityToken: REDACTED, secret: REDACTED });
  Object.defineProperty(r, 'toJSON', { value: view, enumerable: false });
  Object.defineProperty(r, inspect.custom, { value: () => view(), enumerable: false });
  return r;
}

// ─── التصنيف ───

const config = (detail: string): { kind: 'CONFIG'; detail: string } => ({ kind: 'CONFIG', detail });
const retry = (reason: RetryReason): { kind: 'RETRY'; reason: RetryReason } => ({ kind: 'RETRY', reason });

function validCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_ESCALATION_COUNT;
}
function validCounts(c: unknown): c is EscalationCounts {
  if (c === null || typeof c !== 'object') return false;
  const o = c as Partial<EscalationCounts>;
  return validCount(o.priorEmpty400) && validCount(o.priorPayload413);
}
function validStatus(s: unknown): s is number {
  return typeof s === 'number' && Number.isInteger(s) && s >= 100 && s <= 599;
}

const INVOICE_BODY_STATUSES: ReadonlySet<number> = new Set([200, 202, 208, 400, 409]);
/** حالات مسارات المستندات التي قد تحمل clearedInvoice. */
const INVOICE_DOCUMENT_STATUSES: ReadonlySet<number> = new Set([200, 202, 208, 409]);
const CSID_BODY_STATUSES: ReadonlySet<number> = new Set([200, 400]);

/**
 * سقف جسم الرد لهذا المسار وهذه الحالة: 8 MiB فقط حيث قد يرد clearedInvoice، و1 MiB لرفض المستندات، و64 KiB
 * لكل ما عداهما (الشهادات، والحالات المصنَّفة بلا جسم) — كي لا يُقرأ ويُحلَّل جسم ضخم لا حاجة إليه.
 */
export function responseBodyCap(endpoint: FatooraEndpoint, status: number): number {
  if (isInvoiceEndpoint(endpoint)) {
    if (INVOICE_DOCUMENT_STATUSES.has(status)) return RESPONSE_LIMITS.maxBodyBytes;
    if (status === 400) return RESPONSE_LIMITS.maxRejectionBodyBytes;
  }
  return RESPONSE_LIMITS.maxSmallBodyBytes;
}

/**
 * هل يحتاج تصنيف هذه الحالة إلى الجسم؟ إن لم يحتج (401/406/413/429/5xx/303 وأي حالة غير متوقَّعة)
 * فالتصنيف بالحالة وحدها — فيبقى صحيحاً ولو تعذّرت قراءة الجسم أو تجاوز السقف.
 */
export function responseNeedsBody(endpoint: FatooraEndpoint, status: number): boolean {
  if (isInvoiceEndpoint(endpoint)) return INVOICE_BODY_STATUSES.has(status);
  if (isCsidEndpoint(endpoint)) return CSID_BODY_STATUSES.has(status) || (status === 428 && endpoint === 'renewal');
  return false;
}

/** الحالات المشتركة التي لا تعتمد على الجسم (design + report §5 + staff D991/S11). */
function statusOnly(status: number, counts: EscalationCounts): { kind: 'AUTH' } | { kind: 'CONFIG'; detail: string } | { kind: 'RETRY'; reason: RetryReason } | null {
  switch (status) {
    case 401:
      return { kind: 'AUTH' };
    case 406:
      return config('version-not-accepted');
    case 413:
      // عدد ردود 413 السابقة لهذا المستند — لا رقم المحاولة (مهلة سابقة لا تُسقط الإعادة الوحيدة المسموح بها)
      return counts.priorPayload413 < PAYLOAD413_MAX_RETRIES ? retry('payload') : config('payload-too-large');
    case 429:
      return retry('rate');
    case 500:
    case 503:
    case 504:
      return retry('server');
    case 502:
      // UNVERIFIED: 502 غير مذكورة في [D991]؛ خطأ بوابة عابر بطبيعته فيُعامَل كـ5xx بدل إيقاف الوحدة بـCONFIG
      return retry('server');
    default:
      return null;
  }
}

function emptyBodyDetail(parsed: ParsedBody): string {
  return parsed.kind === 'empty' ? 'empty-body' : 'unparseable-body';
}

function contradiction2xx(endpoint: InvoiceEndpoint, inv: InvoiceResponse, errors: Msg[]): string | null {
  if (inv.validationStatus === 'ERROR') return 'validation-error';
  if (errors.length > 0) return 'error-messages';
  if (inv.legacyStatus && /^(NOT_|ERROR|REJECTED)/.test(inv.legacyStatus)) return 'legacy-status';
  const rs = inv.reportingStatus;
  const cs = inv.clearanceStatus;
  if (endpoint === 'reporting' && rs === 'NOT_REPORTED') return 'reporting-status';
  if (endpoint === 'clearance' && cs === 'NOT_CLEARED') return 'clearance-status';
  if (endpoint === 'compliance-invoices') {
    if (rs === 'NOT_REPORTED' && cs !== 'CLEARED') return 'reporting-status';
    if (cs === 'NOT_CLEARED' && rs !== 'REPORTED') return 'clearance-status';
  }
  return null;
}

const VALIDATION_OK: ReadonlySet<string> = new Set(['PASS', 'WARNING']);

/**
 * دليل إيجابي على القبول في جسم 200/202 (report_libraries §9: لا تعتمد على حالة HTTP وحدها). بلا هذا الدليل
 * يصير 200 {} أو {"status":"OK"} من بوابة وسيطة «مقبولاً» فلا يُعاد الإبلاغ عن مستند مبسّط ولا يُنبَّه المالك.
 * يُستدعى بعد contradiction2xx (فلا حالة سلبية هنا). الأشكال الرسمية [SWG] تحمل الحقلين معاً (report §4.2/§4.5/§4.6):
 * • reporting: reportingStatus = REPORTED، أو غيابه مع validationResults.status = PASS/WARNING، أو status القديم REPORTED (V1).
 * • clearance: clearanceStatus = CLEARED، أو غيابه مع PASS/WARNING (والمستند المعتمد شرط مستقلّ قبله).
 * • compliance-invoices: PASS/WARNING **و**(REPORTED أو CLEARED) — مستند مبسّط أو قياسي.
 * حالة غير معروفة (PENDING مثلاً) ليست دليلاً.
 */
function confirmed2xx(endpoint: InvoiceEndpoint, inv: InvoiceResponse): boolean {
  const validationOk = inv.validationStatus !== null && VALIDATION_OK.has(inv.validationStatus);
  const reported = inv.reportingStatus === 'REPORTED';
  const cleared = inv.clearanceStatus === 'CLEARED';
  switch (endpoint) {
    case 'reporting':
      return reported || (inv.reportingStatus === null && (validationOk || inv.legacyStatus === 'REPORTED'));
    case 'clearance':
      return cleared || (inv.clearanceStatus === null && (validationOk || inv.legacyStatus === 'CLEARED'));
    case 'compliance-invoices':
      return validationOk && (reported || cleared);
    default:
      return false;
  }
}

/** empty400Count = عدد ردود 400 الفارغة لهذه البايتات بما فيها هذا الرد. */
function exhaustedEmpty400(empty400Count: number): Msg {
  return {
    type: 'ERROR',
    code: EMPTY400_EXHAUSTED_CODE,
    category: 'CLIENT',
    message: `رفضت الهيئة المستند (HTTP 400) دون ذكر أي سبب ${empty400Count} مرات لإرسال البايتات نفسها`,
    status: 'ERROR',
  };
}

/**
 * design §3 Z3 — جدول التصنيف لمسارات المستندات. counts = عدّادات التصعيد لهذا المستند (EscalationCounts)،
 * وتحكم فقط تصعيد empty400 (0–2 سابقة ⇒ RETRY، 3 ⇒ REJECTED) و413 (0 سابق ⇒ RETRY، 1 ⇒ CONFIG). لا يرمي أبداً.
 */
export function classifyInvoiceResponse(endpoint: InvoiceEndpoint, status: number, body: unknown, counts: EscalationCounts): Outcome {
  return classifyInvoiceParsed(endpoint, status, parseResponseBody(body, responseBodyCap(endpoint, status)), counts);
}

export function classifyInvoiceParsed(endpoint: InvoiceEndpoint, status: number, parsed: ParsedBody, counts: EscalationCounts): Outcome {
  try {
    return classifyInvoiceUnsafe(endpoint, status, parsed, counts);
  } catch {
    return config('classifier-internal-error');
  }
}

function classifyInvoiceUnsafe(endpoint: InvoiceEndpoint, status: number, parsed: ParsedBody, counts: EscalationCounts): Outcome {
  if (!isInvoiceEndpoint(endpoint)) return config('unknown-endpoint');
  if (!validCounts(counts)) return config('invalid-counts');
  if (!validStatus(status)) return config('invalid-status');

  const early = statusOnly(status, counts);
  if (early) return early;
  if (status === 303) {
    // clearance: «Clearance is deactiviated» [SWG] ⇒ يُرسَل المستند للإبلاغ. على reporting تعني 303 العكس
    // (مستند قياسي أُرسل للإبلاغ والاعتماد مفعَّل [S5 p.74]) — فلا تُصنَّف CLEARANCE_OFF هناك.
    return endpoint === 'clearance' ? { kind: 'CLEARANCE_OFF' } : config('unexpected-status:303');
  }
  if (!INVOICE_BODY_STATUSES.has(status)) return config(`unexpected-status:${status}`);
  if (parsed.kind === 'too-large') return config('body-too-large');

  const inv = parsed.kind === 'json' ? parseInvoiceResponse(parsed.value) : null;
  // clearedInvoice يُتحقّق منه حيث يُستهلك فقط؛ "" = غائب (parseInvoiceResponse)
  const clearedValid = inv !== null && inv.clearedInvoicePresent && looksLikeBase64Xml(inv.clearedInvoice);
  const clearedInvalid = inv !== null && inv.clearedInvoicePresent && !clearedValid;
  const cleared = clearedValid ? (inv!.clearedInvoice as string) : undefined;

  if (status === 409 || status === 208) {
    // 409 على reporting = «Invoice Hash Previously Submitted» [D3932]؛ 208 على clearance مع المستند المعتمد [SWG].
    // UNVERIFIED(U8): الإنتاج قد يعيد 409 للاعتماد، وقد يأتي التكرار بلا clearedInvoice [ZKIT] — الحالة وحدها تكفي.
    // المستند المعتمد متوقَّع على الاعتماد فقط: هناك يوقف المعطوبُ منه الوحدة؛ على غيره يُهمل الحقل ويبقى DUPLICATE.
    if (clearedInvalid && endpoint === 'clearance') return config('cleared-invoice-invalid');
    return cleared ? { kind: 'DUPLICATE', clearedXmlB64: cleared } : { kind: 'DUPLICATE' };
  }

  if (!inv) return config(emptyBodyDetail(parsed));
  const errors = meaningful(inv.messages.errors);
  const warnings = meaningful(inv.messages.warnings);

  if (status === 200 || status === 202) {
    if (clearedInvalid) return config('cleared-invoice-invalid');
    // حالة HTTP ناجحة لكن الجسم يقول غير ذلك ⇒ لا نعدّه مقبولاً (report_libraries §9: لا تعتمد على الحالة وحدها)
    const c = contradiction2xx(endpoint, inv, errors);
    if (c) return config(`contradictory-2xx:${c}`);
    if (endpoint === 'clearance' && !cleared) return config('cleared-invoice-missing');
    // ولا يكفي غياب التناقض: يلزم دليل إيجابي، وإلا CONFIG (يُنبَّه المالك ولا يُغلق المستند)
    if (!confirmed2xx(endpoint, inv)) return config('unconfirmed-2xx');
    return cleared ? { kind: 'ACCEPTED', warnings, clearedXmlB64: cleared } : { kind: 'ACCEPTED', warnings };
  }

  // 400: clearedInvoice لا يُقرأ هنا إطلاقاً. الرفض يحتاج خطأً واحداً على الأقل [S4 p.71]؛ التحذيرات وحدها لا تفسّر رفضاً
  if (errors.length > 0) return { kind: 'REJECTED', errors, warnings };
  if (counts.priorEmpty400 < EMPTY400_MAX_RETRIES) return retry('empty400');
  return { kind: 'REJECTED', errors: [exhaustedEmpty400(counts.priorEmpty400 + 1)], warnings };
}

/**
 * مسارات الشهادات: 200 ISSUED؛ PATCH 428 ⇒ NOT_COMPLIANT مع شهادة الامتثال الجديدة [S1][S14]؛
 * 400 (Invalid-OTP، أخطاء CSR، NOT_COMPLIANT، Missing-ComplianceSteps…) ⇒ REJECTED برسائلها؛
 * والحالات المشتركة كما في المستندات. لا يرمي أبداً.
 */
export function classifyCsidResponse(endpoint: CsidEndpoint, status: number, body: unknown, counts: EscalationCounts): CsidOutcome {
  return classifyCsidParsed(endpoint, status, parseResponseBody(body, responseBodyCap(endpoint, status)), counts);
}

export function classifyCsidParsed(endpoint: CsidEndpoint, status: number, parsed: ParsedBody, counts: EscalationCounts): CsidOutcome {
  try {
    return classifyCsidUnsafe(endpoint, status, parsed, counts);
  } catch {
    return config('classifier-internal-error');
  }
}

function classifyCsidUnsafe(endpoint: CsidEndpoint, status: number, parsed: ParsedBody, counts: EscalationCounts): CsidOutcome {
  if (!isCsidEndpoint(endpoint)) return config('unknown-endpoint');
  if (!validCounts(counts)) return config('invalid-counts');
  if (!validStatus(status)) return config('invalid-status');

  const early = statusOnly(status, counts);
  if (early) return early;
  if (!responseNeedsBody(endpoint, status)) return config(`unexpected-status:${status}`);
  if (parsed.kind === 'too-large') return config('body-too-large');

  const p = parsed.kind === 'json' ? parseCsidResponse(parsed.value, parsed.text) : null;
  if (!p) return config(emptyBodyDetail(parsed));
  const errors = meaningful(p.messages.errors);
  const disp = p.dispositionMessage;

  // 400 على الشهادات لا يُعاد إرساله: رمز OTP يُستهلك، وZ4 يطلب رمزاً جديداً [DTG p.31]
  if (status === 400) return { kind: 'REJECTED', errors, dispositionMessage: disp };

  // شهادة الامتثال الجديدة من التجديد تحتاج requestID لطلب شهادة الإنتاج بعد الفحوص [S14]
  if (status === 428 || (endpoint === 'renewal' && disp === 'NOT_COMPLIANT')) {
    const issue = csidFieldIssue(p, true);
    if (issue) {
      // UNVERIFIED(report_libraries §3، zatca-kit): NOT_COMPLIANT قد يصل مع 200؛ بلا بيانات كاملة هو رفض
      return status === 428 ? config(`csid-incomplete:${issue}`) : { kind: 'REJECTED', errors, dispositionMessage: disp };
    }
    return { kind: 'NOT_COMPLIANT', ccsid: sealCsid(p, errors) };
  }

  if (disp !== null && disp !== 'ISSUED') return { kind: 'REJECTED', errors, dispositionMessage: disp };
  const issue = csidFieldIssue(p, endpoint === 'compliance');
  if (issue) return config(`csid-incomplete:${issue}`);
  return { kind: 'ISSUED', csid: sealCsid(p, errors) };
}

// ─── ملخّص السجلّ (ZatcaApiLog.response) ───

export const LOG_LIMITS = Object.freeze({
  maxInfoMessages: 10,
  maxMessagesPerBucket: 50,
  maxMessageChars: 300,
  maxTextChars: 200,
});

export interface LogMsg {
  type: MsgType;
  code: string | null;
  category: string | null;
  message: string | null;
}

/** ملخّص مُنقّح لجسم الرد: لا رمز ولا سرّ ولا مستند — أعداد وأعلام ورسائل منقّحة فقط. */
export interface RedactedResponse {
  body: 'json' | 'text' | 'empty' | 'too-large';
  info: LogMsg[];
  warnings: LogMsg[];
  errors: LogMsg[];
  truncated: boolean;
  validationStatus?: string | null;
  reportingStatus?: string | null;
  clearanceStatus?: string | null;
  qrSellertStatus?: string | null;
  qrBuyertStatus?: string | null;
  /** طول clearedInvoice بالمحارف فقط (لا المستند). */
  clearedInvoiceChars?: number | null;
  requestID?: string | null;
  dispositionMessage?: string | null;
  tokenType?: string | null;
  hasBinarySecurityToken?: boolean;
  hasSecret?: boolean;
  /** مقتطف منقّح من جسم غير JSON (صفحة بوابة، نصّ 406) — على مسارات المستندات فقط؛ مسارات الشهادات null دائماً. */
  text?: string | null;
}

/** أي تسلسل base64 طويل (رمز، سرّ مقصوص، مستند) لا مكان له في سجلّ. */
const LONG_B64_RE = /[A-Za-z0-9+/]{64,}={0,2}/g;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=_-]{4,}/gi;

const SECRET_MIN_CHARS = 6;
/**
 * أقصر جزء من سرّ طويل يُعدّ تسريباً أينما وقع. القصّ (cleanText) والتطبيع (normToken يكبّر الأحرف) يسبقان
 * المحو، فالمطابقة الحرفية للسرّ كاملاً كانت تُفلت 36 من 44 محرفاً — لذا نطابق كل نافذة من 16 محرفاً بلا حساسية لحالة الأحرف.
 */
export const SECRET_WINDOW_CHARS = 16;
/** أقصر بادئة سرّ تُمحى حين ينتهي بها نصّ (أثر قصّ وقع داخل السرّ وأبقى أقلّ من نافذة). */
export const SECRET_TAIL_MIN_CHARS = 8;
const SECRET_GRAM_CHARS = SECRET_WINDOW_CHARS / 2;

/** طيّ يحفظ الطول: A-Z ⇒ a-z و«_» ⇒ «-» (normToken يبدّل الشرطة). لا toLowerCase العام لأنه قد يغيّر الطول. */
function foldCase(s: string): string {
  return s.replace(/[A-Z_]/g, ch => (ch === '_' ? '-' : String.fromCharCode(ch.charCodeAt(0) + 32)));
}

export interface SecretMatcher {
  /** هل يحمل النص سرّاً أو جزءاً منه (نافذة ≥ 16، أو بادئة ≥ 8 في آخره، أو السرّ القصير كاملاً)؟ */
  contains(text: string): boolean;
  /** يستبدل تلك المواضع، وقيم Basic، وتسلسلات base64 الطويلة بـ[REDACTED]. */
  scrub(text: string): string;
}

/**
 * يُعدّ الأسرار مرة واحدة لسطر سجلّ:
 * • رقمي أقصر من 16 (OTP): مطابقة تامة بحدود أرقام فقط، كي لا يُعدّ «123456» داخل requestID «1234567890123» تسريباً.
 * • أقصر من 16: مطابقة تامة بلا حساسية لحالة الأحرف (ومعه صيغته بلا حشو «=»).
 * • 16 فأكثر (السرّ، الرمز، قيمة Basic): كل نافذة من 16 محرفاً، بمسح بخطوة 8 على مقاطع من 8 ثم تحقّق حولها.
 * • وفي آخر النص (قبل «…» إن وُجدت): بادئة من السرّ بطول 8–15 أثرُ قصّ.
 */
export function compileSecrets(secrets: readonly (string | null | undefined)[]): SecretMatcher {
  const numeric: string[] = [];
  const exact = new Set<string>();
  const windows = new Set<string>();
  const grams = new Set<string>();
  const tails = new Set<string>();
  let maxTail = 0;
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < SECRET_MIN_CHARS) continue;
    if (/^[0-9]+$/.test(s) && s.length < SECRET_WINDOW_CHARS) {
      numeric.push(s);
      continue;
    }
    const f = foldCase(s);
    if (f.length < SECRET_WINDOW_CHARS) {
      exact.add(f);
      const bare = f.replace(/=+$/, '');
      if (bare.length >= SECRET_MIN_CHARS) exact.add(bare);
    } else {
      for (let i = 0; i + SECRET_WINDOW_CHARS <= f.length; i++) windows.add(f.slice(i, i + SECRET_WINDOW_CHARS));
      for (let i = 0; i + SECRET_GRAM_CHARS <= f.length; i++) grams.add(f.slice(i, i + SECRET_GRAM_CHARS));
    }
    for (let L = SECRET_TAIL_MIN_CHARS; L < Math.min(f.length, SECRET_WINDOW_CHARS); L++) {
      tails.add(f.slice(0, L));
      if (L > maxTail) maxTail = L;
    }
  }

  const ranges = (text: string): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    if (typeof text !== 'string' || text.length === 0) return out;
    const f = foldCase(text);
    const W = SECRET_WINDOW_CHARS;
    const G = SECRET_GRAM_CHARS;
    if (windows.size > 0) {
      // كل نافذة عند i تحوي المقطع المحاذي عند q = ceil(i/8)·8 ≤ i+7، فيكفي فحص i ∈ [q-7, q] حين يطابق مقطع q
      let next = 0;
      for (let q = 0; q + G <= f.length; q += G) {
        if (!grams.has(f.slice(q, q + G))) continue;
        for (let i = Math.max(next, q - G + 1); i <= q && i + W <= f.length; i++) {
          if (windows.has(f.slice(i, i + W))) out.push([i, i + W]);
          next = i + 1;
        }
      }
    }
    for (const e of exact) {
      for (let j = f.indexOf(e); j >= 0; j = f.indexOf(e, j + 1)) out.push([j, j + e.length]);
    }
    for (const d of numeric) {
      for (let j = text.indexOf(d); j >= 0; j = text.indexOf(d, j + 1)) {
        const before = j > 0 ? text.charCodeAt(j - 1) : NaN;
        const after = text.charCodeAt(j + d.length);
        if (!(before >= 0x30 && before <= 0x39) && !(after >= 0x30 && after <= 0x39)) out.push([j, j + d.length]);
      }
    }
    if (maxTail > 0) {
      const end = f.endsWith('…') ? f.length - 1 : f.length;
      for (let L = Math.min(maxTail, end); L >= SECRET_TAIL_MIN_CHARS; L--) {
        if (tails.has(f.slice(end - L, end))) {
          out.push([end - L, end]);
          break;
        }
      }
    }
    return out;
  };

  const replaceRanges = (text: string, rs: Array<[number, number]>): string => {
    if (rs.length === 0) return text;
    rs.sort((a, b) => a[0] - b[0]);
    let out = '';
    let pos = 0;
    let [s, e] = rs[0];
    for (let k = 1; k <= rs.length; k++) {
      if (k < rs.length && rs[k][0] <= e) {
        if (rs[k][1] > e) e = rs[k][1];
        continue;
      }
      out += text.slice(pos, s) + REDACTED;
      pos = e;
      if (k < rs.length) [s, e] = rs[k];
    }
    return out + text.slice(pos);
  };

  return {
    contains: text => ranges(text).length > 0,
    scrub: text => replaceRanges(text, ranges(text)).replace(BASIC_RE, `Basic ${REDACTED}`).replace(LONG_B64_RE, REDACTED),
  };
}

/** هل يظهر السرّ (أو جزء منه) في النص؟ — compileSecrets لسرّ واحد. */
export function containsSecret(text: string, s: string | null | undefined): boolean {
  return compileSecrets([s]).contains(text);
}

/** يستبدل الأسرار المعطاة وأجزاءها، وقيم Basic، وتسلسلات base64 الطويلة — compileSecrets. */
export function scrubSecrets(text: string, secrets: readonly (string | null | undefined)[]): string {
  return compileSecrets(secrets).scrub(text);
}

const CREDENTIAL_FIELD_RE = /"(?:secret|binarySecurityToken)"\s*:\s*"((?:[^"\\]|\\.){1,16384})"/gi;

/**
 * الرمز والسرّ اللذان أصدرتهما الهيئة في هذا الرد (مسارات الشهادات فقط): من JSON المحلَّل، ومن النص الخام بتعبير
 * منتظم حتى حين لا يُحلَّل الجسم (رد 200 بذيل زائد) أو يتكرّر المفتاح. الرمز استُهلك معه OTP فالسرّ حيّ: يُمحى من كل نصّ يصل السجلّ.
 */
export function responseCredentialStrings(endpoint: FatooraEndpoint, parsed: ParsedBody): string[] {
  if (!isCsidEndpoint(endpoint)) return [];
  const out: string[] = [];
  try {
    if (parsed.kind === 'json') {
      const p = parseCsidResponse(parsed.value, null);
      if (p?.binarySecurityToken) out.push(p.binarySecurityToken);
      if (p?.secret) out.push(p.secret);
    }
    const raw = parsed.kind === 'json' || parsed.kind === 'text' ? parsed.text : null;
    if (raw) {
      const re = new RegExp(CREDENTIAL_FIELD_RE.source, 'gi');
      let m: RegExpExecArray | null;
      for (let n = 0; n < 16 && (m = re.exec(raw)) !== null; n++) {
        out.push(m[1]);
        try {
          const unescaped: unknown = JSON.parse(`"${m[1]}"`);
          if (typeof unescaped === 'string' && unescaped !== m[1]) out.push(unescaped);
        } catch {
          /* تهريب معيب: النص الخام وحده يكفي */
        }
      }
    }
  } catch {
    /* لا رمي */
  }
  return out;
}

function logText(v: string | null, max: number, m: SecretMatcher): string | null {
  if (v === null) return null;
  // قصّ مبكر بهامش واسع، ثم محو، ثم تنظيف وقصّ، ثم محو ثانٍ لما قد يُبقيه القصّ من طرف سرّ
  const head = v.length > max * 2 + 1024 ? v.slice(0, max * 2 + 1024) : v;
  const once = cleanText(m.scrub(head), max);
  if (once === null) return null;
  const twice = m.scrub(once);
  return twice === once ? once : cleanText(twice, max);
}

function logMsgs(list: Msg[], cap: number, m: SecretMatcher): LogMsg[] {
  return list.slice(0, cap).map(x => ({
    type: x.type,
    code: logText(x.code, RESPONSE_LIMITS.maxCodeChars, m),
    category: logText(x.category, RESPONSE_LIMITS.maxCategoryChars, m),
    message: logText(x.message, LOG_LIMITS.maxMessageChars, m),
  }));
}

export function redactResponseForLog(endpoint: FatooraEndpoint, parsed: ParsedBody, secrets: readonly (string | null | undefined)[]): RedactedResponse {
  try {
    const csid = isCsidEndpoint(endpoint);
    const m = compileSecrets([...secrets, ...responseCredentialStrings(endpoint, parsed)]);
    const base = (set: MessageSet | null): RedactedResponse => ({
      body: parsed.kind,
      info: set ? logMsgs(set.info, LOG_LIMITS.maxInfoMessages, m) : [],
      warnings: set ? logMsgs(set.warnings, LOG_LIMITS.maxMessagesPerBucket, m) : [],
      errors: set ? logMsgs(set.errors, LOG_LIMITS.maxMessagesPerBucket, m) : [],
      truncated: set
        ? set.truncated || set.info.length > LOG_LIMITS.maxInfoMessages || set.warnings.length > LOG_LIMITS.maxMessagesPerBucket || set.errors.length > LOG_LIMITS.maxMessagesPerBucket
        : false,
    });
    // مسارات الشهادات: لا مقتطف نصّي أبداً — رد غير مقروء قد يحمل بيانات اعتماد صدرت فعلاً (body + responseBytes يكفيان)
    if (parsed.kind === 'text') return { ...base(null), text: csid ? null : logText(parsed.text, LOG_LIMITS.maxTextChars, m) };
    if (parsed.kind !== 'json') return base(null);

    if (!csid) {
      const inv = parseInvoiceResponse(parsed.value);
      if (!inv) return { ...base(null), text: '[non-object JSON]' };
      return {
        ...base(inv.messages),
        validationStatus: logText(inv.validationStatus, RESPONSE_LIMITS.maxStatusChars, m),
        reportingStatus: logText(inv.reportingStatus, RESPONSE_LIMITS.maxStatusChars, m),
        clearanceStatus: logText(inv.clearanceStatus, RESPONSE_LIMITS.maxStatusChars, m),
        qrSellertStatus: logText(inv.qrSellertStatus, RESPONSE_LIMITS.maxStatusChars, m),
        qrBuyertStatus: logText(inv.qrBuyertStatus, RESPONSE_LIMITS.maxStatusChars, m),
        clearedInvoiceChars: inv.clearedInvoice === null ? null : inv.clearedInvoice.length,
      };
    }
    const p = parseCsidResponse(parsed.value, parsed.text);
    if (!p) return { ...base(null), text: '[non-object JSON]' };
    return {
      ...base(p.messages),
      requestID: p.requestID,
      dispositionMessage: logText(p.dispositionMessage, RESPONSE_LIMITS.maxStatusChars, m),
      tokenType: logText(p.tokenType, RESPONSE_LIMITS.maxTokenTypeChars, m),
      hasBinarySecurityToken: p.binarySecurityToken !== null,
      hasSecret: p.secret !== null,
    };
  } catch {
    return { body: parsed.kind, info: [], warnings: [], errors: [], truncated: false, text: '[redaction failed]' };
  }
}
