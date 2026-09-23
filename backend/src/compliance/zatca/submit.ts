// ============================================================================
// ZATCA المرحلة الثانية (Z5.3) — محرّك الإرسال: إبلاغ المبسّطة واعتماد القياسية، وكتابة النتيجة والمرآة والإبطال في معاملة واحدة
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.3» + §2.3 + نقد الخطة (7، 9، 10، 16، 18، 34، 40):
//   • المطالبة أولاً (CAS + عقد إيجار + attempts++)، ثم كل شيء آخر: عاملان لا يرسلان البايتات نفسها معاً، وعاملٌ مات
//     يُستولى على مستنده بعد انتهاء العقد (إعادة الإرسال آمنة: 409/208 نجاح).
//   • **كتابة واحدة ذرّية** (نقد 7): نتيجة المستند + مرآة الفاتورة + خطّاف الإبطال (Z5.4 للقياسية المرفوضة) داخل
//     معاملة واحدة بترتيب القفل: zatca_documents ⇒ invoices ⇒ customers. انهيارٌ بين الخطوتين لم يعد ممكناً.
//   • التسييج (نقد 34) برمز المطالبة attempts مع status='SUBMITTING' — لا مساواة الطابع الزمني leaseUntil: عاملٌ متأخر
//     لا يكتب فوق نتيجة أحدث.
//   • التصريف (نقد 9): الوحدة المسحوبة أو المنتهية أو الموقوفة بالتفويض تُرسل مستنداتها المعلّقة ببيانات اعتمادها
//     المخزَّنة — وإلا فات المبسّطة يومُها وبقيت القياسية معلّقة إلى الأبد. الوحدة قيد التجديد ترسل أيضاً (التجديد ينتظر التصريف).
//   • انحراف نسخة المفتاح (نقد 9/40): بايتات وُقّعت قبل تجديد الشهادة. المبسّطة تُرسَل رغم الانحراف (فوات المهلة مخالفة
//     مؤكّدة، ورفض الهيئة للبايتات القديمة غير مؤكَّد) مع تنبيه؛ والقياسية لا تُرسَل (رفضٌ كاذب يُبطل فاتورة سليمة) بل
//     CONFIG_ERROR بانتظار إعادة الإصدار. يضبطه ZATCA_SUBMIT_STALE_KEY = report (الافتراضي) | never | always.
//   • 401 لا يوقف الشركة من أول مرّة (نقد 18): المستند AUTH_BLOCKED، ولا تُنقل الوحدة إلى AUTH_FAILED إلا بتأكيد
//     (401 آخر على مستند مختلف بعد 60 ثانية على الأقل)، وفي معاملتها المستقلّة.
//   • 429: إيقاف الوحدة في الذاكرة حتى Retry-After (نسخة خادم واحدة — z5_plan §3 Z5.3 «Review focus»).
//   • الحجب مؤقّت لا أبديّ (مراجعة عدائية): 401 أو عطل إعداد قابل للإصلاح على مستند **إبلاغ** يُجدوَل له استرداد
//     (blockedNextAttemptAt: 15د تتضاعف حتى 6 ساعات) فيلتقطه المسح بعد إصلاح العطل — وإلا فاتت مهلة الـ24 ساعة يقيناً
//     بلا محاولةٍ واحدة. الاعتماد يبقى نهائيّ الحجب (إعادة بايتاتٍ قد تُرفض تُبطل فاتورة سليمة) ومخرجه السحب أو الإعادة.
//   • لا نداء ببايتات انقضى عقدها: العقد يُفحص قبل الاستدعاء مباشرةً (طابور الحصص قد يطول)، وإن ضاعت النتيجة
//     بالتسييج بعد نداءٍ فعليّ فإشعار مالك — لا صمت.
//   • لا استدعاء للهيئة داخل معاملة أبداً، ولا سرّ في سجلّ (العميل يُنقّح، والسجلّ يُكتب بمعرّف المستند).
// لا يستورد services/gl ولا config/database (الاعتماديات تُحقن — الإنتاج في services/zatcaSubmit.ts).
// ============================================================================

import type { ApiLogEntry, CallOptions, Creds, FatooraEnv, InvoiceBody } from './api';
import { FATOORA_BASE_URLS } from './api';
import type { ClaimedDocument, DocumentOutcomePatch, InvoiceMirror, ZatcaDocumentStore } from './documentStore';
import { gzipXml } from './documentStore';
import type { EgsUnitStore } from './onboardingStore';
import { extractQrFromXml } from './qr';
import type { Msg, Outcome } from './responses';
import { SecretsError, decryptSecret, type SecretKeyring } from './secrets';
import {
  AUTH_CONFIRM_MIN_GAP_MS, MANUAL_RETRY_FROM, RETRY_AFTER_CAP_MS, authFailureConfirmed, blockedNextAttemptAt, mirrorQrOf,
  mirrorStatusOf, retryDelayMs, subtypeOfTypeName, transitionForOutcome, type DocumentStatus, type Flow, type InvoiceMirrorStatus,
  type OutcomeAlert, type OutcomeWrite, type Subtype,
} from './status';

// ─── الثوابت ───

/** حالات الوحدة التي تُرسل مستنداتها: العاملة والمجدِّدة + التصريف (مسحوبة/منتهية/موقوفة التفويض) — نقد 9. */
export const SUBMIT_UNIT_STATUSES: readonly string[] = Object.freeze(['ACTIVE', 'RENEWING', 'REVOKED', 'EXPIRED', 'AUTH_FAILED']);
/** وحدة في هذه الحالات تُصرَّف فقط (لا إصدار جديد عليها) — يُنبَّه المدير مرّة لكل مستند. */
export const DRAINING_UNIT_STATUSES: readonly string[] = Object.freeze(['REVOKED', 'EXPIRED', 'AUTH_FAILED']);
/** مهلة عقد الإيجار الافتراضية (أطول من مهلة الاستدعاء: مستند قيد الإرسال لا يُستولى عليه وهو حيّ). */
export const DEFAULT_SUBMIT_LEASE_MS = 90_000;
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
/** أقصى عدد رسائل تُخزَّن في مرآة الفاتورة (einvoiceWarnings نصّ). */
export const MAX_MIRROR_MESSAGES = 20;

export type StaleKeyPolicy = 'report' | 'never' | 'always';
export const STALE_KEY_VAR = 'ZATCA_SUBMIT_STALE_KEY';

export function staleKeyPolicy(env: Readonly<Record<string, string | undefined>> = process.env): StaleKeyPolicy {
  const v = (env[STALE_KEY_VAR] ?? '').trim().toLowerCase();
  return v === 'never' || v === 'always' ? v : 'report';
}

// ─── العميل المحقون ───

/** ما يستعمله المحرّك من FatooraClient (Z3) — الاختبارات تحقن العميل نفسه فوق منصّة مزيّفة. */
export interface SubmitClient {
  readonly env: FatooraEnv;
  report(creds: Creds, body: InvoiceBody, call?: CallOptions): Promise<Outcome>;
  clear(creds: Creds, body: InvoiceBody, call?: CallOptions): Promise<Outcome>;
}

export type SubmitClientFactory = (opts: {
  env: FatooraEnv;
  log: (entry: ApiLogEntry) => Promise<void>;
  timeoutMs: number;
}) => SubmitClient;

// ─── بوّابة الشركة ───

export interface TenantSubmitGate {
  /** CompanySettings.zatcaPhase2StartedAt != null — وحدة الإنتاج لا تُرسل قبله أبداً. */
  live: boolean;
  /** CompanySettings.zatcaSubmitPausedAt — مفتاح إيقاف تشغيلي لكل شركة. */
  pausedAt: Date | null;
}

export interface SubmitGateStore {
  loadSubmitGate(tenantId: string): Promise<TenantSubmitGate | null>;
}

export const CLOSED_GATE: Readonly<TenantSubmitGate> = Object.freeze({ live: false, pausedAt: null });

// ─── الإشعارات ───

export type SubmitNotificationKind =
  | 'REJECTED' | 'AUTH_BLOCKED' | 'UNIT_AUTH_FAILED' | 'CONFIG_ERROR' | 'CLEARED_NO_XML' | 'STALE_KEY' | 'DRAINING_UNIT'
  | 'OUTCOME_LOST' | 'OVERDUE';

export interface SubmitNotification {
  kind: SubmitNotificationKind;
  tenantId: string;
  documentId: string | null;
  invoiceId: string | null;
  egsUnitId: string | null;
  /** درجة تنبيه التأخّر (1..3) — للتأخّر وحده. */
  level?: number;
  /** يستدعي انتباه مالك المنصّة أيضاً (عطل لا خطأ بيانات). */
  owner: boolean;
  titleAr: string;
  bodyAr: string;
  data: Record<string, unknown>;
}

export type SubmitNotifier = (n: SubmitNotification) => Promise<void> | void;

// ─── ذاكرة 401 و429 (داخل العملية) ───

/** نقد 18: 401 واحد لا يوقف شركة. يُؤكَّد بـ401 آخر على **مستند مختلف** بعد 60 ثانية على الأقل. */
export class AuthFailureMemory {
  private readonly last = new Map<string, { documentId: string; at: Date }>();

  /** يسجّل 401 ويعيد هل تأكّد العطل (فتُنقل الوحدة إلى AUTH_FAILED). */
  record(unitId: string, documentId: string, at: Date): boolean {
    const prev = this.last.get(unitId);
    const confirmed = authFailureConfirmed(prev, { documentId, at });
    // يُحتفظ بالأقدم ما دام لم يتأكّد: 401 ثانٍ على المستند نفسه لا يمحو الدليل الأول
    if (!prev || confirmed || prev.documentId === documentId) this.last.set(unitId, { documentId, at });
    return confirmed;
  }

  /** نجاحٌ على الوحدة يمحو الشكّ (وكذلك التجديد). */
  clear(unitId: string): void {
    this.last.delete(unitId);
  }

  get size(): number {
    return this.last.size;
  }
}

/** 429 من الهيئة: إيقاف الوحدة في هذه النسخة من الخادم حتى انقضاء Retry-After (بسقف ساعة). */
export class UnitPauseMemory {
  private readonly until = new Map<string, number>();

  pausedUntil(unitId: string, now: Date): Date | null {
    const t = this.until.get(unitId);
    if (t === undefined) return null;
    if (t <= now.getTime()) {
      this.until.delete(unitId);
      return null;
    }
    return new Date(t);
  }

  pause(unitId: string, now: Date, seconds: number | undefined): Date {
    const ms = Math.min(Math.max(1000, Math.trunc((seconds ?? 0) * 1000) || 30_000), RETRY_AFTER_CAP_MS);
    const until = now.getTime() + ms;
    const prev = this.until.get(unitId) ?? 0;
    this.until.set(unitId, Math.max(prev, until));
    return new Date(Math.max(prev, until));
  }

  clear(unitId: string): void {
    this.until.delete(unitId);
  }

  get size(): number {
    return this.until.size;
  }
}

// ─── الاعتماديات ───

/** ما يمرّره المحرّك إلى خطّاف الإبطال (Z5.4) داخل المعاملة نفسها. */
export interface RejectedDocumentInfo {
  tenantId: string;
  invoiceId: string;
  documentId: string;
  egsUnitId: string;
  subtype: Subtype;
  flow: Flow;
  errors: Msg[];
  at: Date;
}

export type SubmitDocumentStore<Tx> =
  Pick<ZatcaDocumentStore<Tx>,
    'claim' | 'applyOutcome' | 'mirrorInvoice' | 'markDispatched' | 'writeApiLog' | 'loadDocumentXml' | 'requeueForRetry'>;

export interface SubmitDeps<Tx = unknown> {
  documents: SubmitDocumentStore<Tx>;
  units: Pick<EgsUnitStore, 'loadUnit' | 'loadUnitCredentials' | 'compareAndSetUnit'>;
  gate: SubmitGateStore;
  keyring: () => SecretKeyring;
  client: SubmitClientFactory;
  /** معاملة واحدة لكتابة النتيجة والمرآة والإبطال (لا يُستدعى داخلها شيء من الشبكة). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  publish?: (tenantId: string) => void;
  notify?: SubmitNotifier;
  /**
   * Z5.4: إبطال الفاتورة القياسية المرفوضة **داخل** معاملة النتيجة نفسها (نقد 7). يُستدعى بعد كتابة حالة المستند
   * REJECTED ومرآة الفاتورة rejected، فلا يشترط المرآة السابقة؛ يقفل صفّ الفاتورة FOR UPDATE ثم صفوف العميل.
   */
  onRejectedInTx?: (tx: Tx, info: RejectedDocumentInfo) => Promise<void>;
  authMemory?: AuthFailureMemory;
  pauses?: UnitPauseMemory;
  now: () => Date;
  env?: NodeJS.ProcessEnv;
}

// ─── النتيجة ───

export type SubmitSkipReason =
  | 'NOT_CLAIMED' | 'PAUSED' | 'TENANT_MISMATCH' | 'RATE_PAUSED' | 'FENCED' | 'LEASE_EXPIRED' | 'DISPATCH_UNMARKED';

/** سبب محلّي (بلا استدعاء للهيئة) لحسم المستند — يُسجَّل في سجلّ الطلبات ويظهر للمشغّل. */
export type LocalFailure =
  | 'UNIT_MISSING' | 'UNIT_NOT_SUBMITTABLE' | 'TENANT_NOT_LIVE' | 'ENV_INVALID' | 'SUBTYPE_INVALID' | 'CREDENTIALS_MISSING'
  | 'SECRETS' | 'BYTES_MISSING' | 'STALE_KEY';

/**
 * أعطال محلّية تزول بإصلاح إعداد أو بتجديد شهادة: مستند **الإبلاغ** يُجدوَل لها استرداداً تلقائياً (bلا نداءِ هيئة
 * إلى أن يُصلح العطل) فلا تفوت مهلة الـ24 ساعة بصمت. وما عداها (بايتات مفقودة، وحدة محذوفة، نوع غير صالح) عطلٌ
 * دائم لا يصلحه تكرارٌ — يبقى نهائياً حتى إعادة يدوية.
 */
export const RECOVERABLE_LOCAL_FAILURES: readonly LocalFailure[] = Object.freeze(
  ['CREDENTIALS_MISSING', 'SECRETS', 'STALE_KEY', 'UNIT_NOT_SUBMITTABLE', 'ENV_INVALID', 'TENANT_NOT_LIVE'] as LocalFailure[],
);

export interface SubmitDone {
  kind: 'done';
  documentId: string;
  invoiceId: string;
  tenantId: string;
  egsUnitId: string;
  subtype: Subtype | null;
  flow: Flow;
  status: DocumentStatus;
  mirror: InvoiceMirrorStatus | null;
  /** نوع نتيجة الهيئة، أو null حين حُسم محلياً. */
  outcome: Outcome['kind'] | null;
  local: LocalFailure | null;
  httpStatus: number | null;
  nextAttemptAt: Date | null;
  alert: OutcomeAlert | null;
  authConfirmed: boolean;
  /** كُتبت النتيجة فعلاً (false = سبقنا عاملٌ آخر: التسييج منع الكتابة). */
  applied: boolean;
}

export type SubmitResult =
  | { kind: 'skipped'; reason: SubmitSkipReason; documentId: string; retryAt?: Date }
  | SubmitDone;

export interface SubmitOptions {
  /** طلب حيّ ينتظر النتيجة (اعتماد B2B في Z5.4): يتجاهل موعد إعادة المحاولة ويأخذ مهلة أقصر. */
  inline?: boolean;
  timeoutMs?: number;
  leaseMs?: number;
  /** محاولة فورية واحدة رغم nextAttemptAt (الإعادة اليدوية والطلب الحيّ). */
  ignoreSchedule?: boolean;
  /** بوّابة الشركة إن حمّلها المستدعي (المسح الدوري يحمّلها مرّة لكل شركة). */
  gate?: TenantSubmitGate;
  /** لحظة العملية (الافتراضي deps.now()). */
  now?: Date;
}

// ─── أدوات ───

const isEnv = (v: string): v is FatooraEnv => Object.prototype.hasOwnProperty.call(FATOORA_BASE_URLS, v);

function messagesJson(msgs: readonly Msg[]): string | null {
  if (msgs.length === 0) return null;
  const out = msgs.slice(0, MAX_MIRROR_MESSAGES).map(m => ({ type: m.type, code: m.code, message: m.message, category: m.category }));
  return JSON.stringify(out);
}

/** ملخّص التحقق المخزَّن على المستند (validation) — من الردّ المنقّح وحده، بلا نصّ خام. */
function validationOf(outcome: Outcome | null, log: ApiLogEntry | null, local: LocalFailure | null, at: Date): Record<string, unknown> {
  const r = log?.response ?? null;
  return {
    at: at.toISOString(),
    outcome: outcome?.kind ?? null,
    local,
    reason: log?.reason ?? null,
    validationStatus: r?.validationStatus ?? null,
    reportingStatus: r?.reportingStatus ?? null,
    clearanceStatus: r?.clearanceStatus ?? null,
    warnings: r?.warnings ?? [],
    errors: r?.errors ?? [],
    truncated: r?.truncated ?? false,
  };
}

/** نصّ base64 لمستند الهيئة المعتمد ⇒ XML، أو null إن لم يكن صالحاً (فيُحسم CLEARED_NO_XML). */
export function decodeClearedXml(b64: string | undefined): string | null {
  if (typeof b64 !== 'string' || b64 === '') return null;
  let xml: string;
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0) return null;
    xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return null;
  }
  return xml.includes('<Invoice') ? xml : null;
}

function localWrite(status: DocumentStatus, alert: OutcomeAlert | null): OutcomeWrite {
  return { status, nextAttemptAt: null, leaseUntil: null, warnings: [], errors: [], alert, authFailure: false };
}

// ─── كتابة النتيجة (المعاملة الواحدة) ───

interface PersistInput<Tx> {
  claimed: ClaimedDocument;
  subtype: Subtype | null;
  write: OutcomeWrite;
  httpStatus: number | null;
  validation: Record<string, unknown>;
  clearedXml: string | null;
  /** رمز QR المختوم كما في البايتات (من XML) — undefined = غير معروف فلا يُكتب عمود المرآة. */
  stampedQr: string | undefined;
  outcome: Outcome | null;
  local: LocalFailure | null;
  now: Date;
}

async function persistOutcome<Tx>(deps: SubmitDeps<Tx>, i: PersistInput<Tx>): Promise<{ applied: boolean; mirror: InvoiceMirrorStatus | null }> {
  const { claimed, write } = i;
  const patch: DocumentOutcomePatch = {
    status: write.status,
    nextAttemptAt: write.nextAttemptAt,
    httpStatus: i.httpStatus,
    validation: i.validation,
  };
  if (write.flow !== undefined) patch.flow = write.flow;
  if (write.finalizedAt !== undefined) patch.finalizedAt = write.finalizedAt;
  if (write.reportDeadline !== undefined) patch.reportDeadline = write.reportDeadline;
  if (write.priorEmpty400 !== undefined) patch.priorEmpty400 = write.priorEmpty400;
  if (write.priorPayload413 !== undefined) patch.priorPayload413 = write.priorPayload413;

  let clearedQr: string | null = null;
  if (i.clearedXml !== null) {
    patch.clearedXmlGz = gzipXml(i.clearedXml);
    clearedQr = extractQrFromXml(i.clearedXml);
    if (clearedQr !== null) patch.clearedQr = clearedQr;
  }

  const subtype = i.subtype;
  const mirrorStatus = subtype ? mirrorStatusOf(write.status, subtype) : null;
  const mirror: InvoiceMirror | null = mirrorStatus === null ? null : {
    einvoiceStatus: mirrorStatus,
    einvoiceWarnings: messagesJson(write.status === 'REJECTED' ? [...write.errors, ...write.warnings] : write.warnings),
    ...(write.finalizedAt !== undefined ? { einvoiceSubmittedAt: write.finalizedAt } : {}),
  };
  // عمود QR لا يُلمس إلا حين نعرف قيمته النهائية: المبسّطة ختمنا، والقياسية المعتمدة رمز الهيئة، والقياسية المُبلَّغة (303) ختمنا
  if (mirror && (i.stampedQr !== undefined || clearedQr !== null) && subtype) {
    mirror.einvoiceQr = mirrorQrOf({ subtype, status: write.status, qr: i.stampedQr ?? '', clearedQr });
  }

  const applied = await deps.transaction(async tx => {
    // ترتيب القفل: zatca_documents ⇒ invoices ⇒ customers (الإبطال)
    const ok = await deps.documents.applyOutcome(tx, { id: claimed.id, attempts: claimed.attempts }, patch);
    if (!ok) return false;
    if (mirror) await deps.documents.mirrorInvoice(tx, claimed.invoiceId, mirror);
    if (write.status === 'REJECTED' && subtype && deps.onRejectedInTx) {
      await deps.onRejectedInTx(tx, {
        tenantId: claimed.tenantId, invoiceId: claimed.invoiceId, documentId: claimed.id, egsUnitId: claimed.egsUnitId,
        subtype, flow: (write.flow ?? claimed.flow), errors: [...write.errors], at: i.now,
      });
    }
    return true;
  });
  return { applied, mirror: applied ? mirrorStatus : null };
}

// ─── الإشعارات الجاهزة ───

const NOTE_TEXT: Readonly<Record<Exclude<SubmitNotificationKind, 'OVERDUE'>, { title: string; body: string; owner: boolean }>> = Object.freeze({
  REJECTED: { title: 'رفضت الهيئة مستنداً ضريبياً', body: 'رفضت هيئة الزكاة والضريبة والجمارك مستنداً ضريبياً — راجع تفاصيل الفاتورة وصحّح البيانات ثم أعد الإصدار', owner: false },
  AUTH_BLOCKED: { title: 'تعذّر تفويض الإرسال للهيئة', body: 'رفضت الهيئة بيانات اعتماد وحدة الفوترة الإلكترونية لهذا المستند — إن تكرّر فيلزم تجديد الشهادة', owner: false },
  UNIT_AUTH_FAILED: { title: 'توقّف إرسال الفواتير الضريبية', body: 'تكرّر رفض بيانات اعتماد وحدة الفوترة الإلكترونية — أوقفنا الإرسال ويلزم تجديد الشهادة برمز ERAD', owner: true },
  CONFIG_ERROR: { title: 'تعذّر إرسال مستند ضريبي', body: 'تعذّر إرسال مستند ضريبي إلى الهيئة لعطل في إعداد الفوترة الإلكترونية — أُبلغت الإدارة', owner: true },
  CLEARED_NO_XML: { title: 'اعتماد بلا نسخة معتمدة', body: 'اعتمدت الهيئة فاتورة ولم تُعد نسختها المعتمدة — لا يمكن طباعتها حتى تُسترجع', owner: true },
  STALE_KEY: { title: 'مستند موقَّع بشهادة سابقة', body: 'مستند ضريبي وُقِّع قبل تجديد شهادة الفوترة — يلزم إعادة إصداره ليُعتمد', owner: false },
  DRAINING_UNIT: { title: 'إرسال متأخّر من وحدة متوقّفة', body: 'أُرسل مستند ضريبي من وحدة فوترة متوقّفة (منتهية أو مسحوبة) لتصريف ما تبقّى — راجع ربط الفوترة الإلكترونية', owner: true },
  OUTCOME_LOST: { title: 'ردّ الهيئة لم يُسجَّل', body: 'أُرسل مستند ضريبي إلى الهيئة ولم تُكتب نتيجته (سبقنا إليه إرسالٌ آخر) — راجع حالة الفاتورة قبل التسليم', owner: true },
});

async function fire<Tx>(deps: SubmitDeps<Tx>, n: SubmitNotification): Promise<void> {
  if (!deps.notify) return;
  try {
    await deps.notify(n);
  } catch { /* الإشعار لا يغيّر النتيجة */ }
}

function noteOf(kind: Exclude<SubmitNotificationKind, 'OVERDUE'>, claimed: ClaimedDocument, data: Record<string, unknown> = {}): SubmitNotification {
  const t = NOTE_TEXT[kind];
  return {
    kind, tenantId: claimed.tenantId, documentId: claimed.id, invoiceId: claimed.invoiceId, egsUnitId: claimed.egsUnitId,
    owner: t.owner, titleAr: t.title, bodyAr: t.body, data: { icv: claimed.icv, uuid: claimed.uuid, ...data },
  };
}

// ─── الحسم المحلّي (بلا استدعاء) ───

async function finishLocal<Tx>(
  deps: SubmitDeps<Tx>, claimed: ClaimedDocument, subtype: Subtype | null, local: LocalFailure, now: Date,
  opts: {
    status?: DocumentStatus; alert?: OutcomeAlert | null; notify?: Exclude<SubmitNotificationKind, 'OVERDUE'>;
    data?: Record<string, unknown>;
    /** يرفع الإشعار إلى مالك المنصّة أيضاً (عطلٌ لا مخرج تلقائيّ له) — لا يُخفّضه أبداً. */
    owner?: boolean;
  } = {},
): Promise<SubmitDone> {
  const status = opts.status ?? 'CONFIG_ERROR';
  const alert = opts.alert === undefined ? 'CONFIG' : opts.alert;
  const write = localWrite(status, alert);
  // استرداد تلقائيّ للعطل القابل للإصلاح على مستند إبلاغ (مهلة الـ24 ساعة لا تنتظر إعادةً يدوية)
  if (status === 'CONFIG_ERROR' && RECOVERABLE_LOCAL_FAILURES.includes(local)) {
    write.nextAttemptAt = blockedNextAttemptAt(claimed.flow, claimed.attempts, now);
  }
  const { applied, mirror } = await persistOutcome(deps, {
    claimed, subtype, write, httpStatus: null, validation: validationOf(null, null, local, now), clearedXml: null,
    stampedQr: undefined, outcome: null, local, now,
  });
  if (applied) {
    const note = noteOf(opts.notify ?? 'CONFIG_ERROR', claimed, { local, ...(opts.data ?? {}) });
    await fire(deps, opts.owner === true ? { ...note, owner: true } : note);
    deps.publish?.(claimed.tenantId);
  }
  return {
    kind: 'done', documentId: claimed.id, invoiceId: claimed.invoiceId, tenantId: claimed.tenantId, egsUnitId: claimed.egsUnitId,
    subtype, flow: claimed.flow, status, mirror, outcome: null, local, httpStatus: null, nextAttemptAt: write.nextAttemptAt,
    alert, authConfirmed: false, applied,
  };
}

/** تأجيل مستند مُستولى عليه بلا استدعاء (إيقاف 429 للوحدة، أو تعذّر وسم الإرسال): RETRY_WAIT حتى الموعد، والبايتات كما هي. */
async function deferClaimed<Tx>(
  deps: SubmitDeps<Tx>, claimed: ClaimedDocument, until: Date, now: Date, reason: SubmitSkipReason = 'RATE_PAUSED',
): Promise<SubmitResult> {
  const write: OutcomeWrite = { ...localWrite('RETRY_WAIT', null), nextAttemptAt: until };
  await persistOutcome(deps, {
    claimed, subtype: subtypeOfTypeName(claimed.typeName), write, httpStatus: null,
    validation: validationOf(null, null, null, now), clearedXml: null, stampedQr: undefined, outcome: null, local: null, now,
  });
  return { kind: 'skipped', reason, documentId: claimed.id, retryAt: until };
}

// ─── المسار الرئيس ───

/**
 * يستولي على المستند ثم يرسله. يعيد skipped حين لا يُستولى عليه (غير مستحقّ، أو مقفل لعاملٍ آخر، أو الشركة موقوفة).
 * لا يرمي إلا خطأً غير متوقَّع من المخزن؛ كل نتائج الهيئة تُحسم إلى حالة.
 */
export async function submitDocument<Tx>(
  deps: SubmitDeps<Tx>, ref: { documentId: string; tenantId: string }, opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const now = opts.now ?? deps.now();
  const gate = opts.gate ?? (await deps.gate.loadSubmitGate(ref.tenantId)) ?? CLOSED_GATE;
  if (gate.pausedAt) return { kind: 'skipped', reason: 'PAUSED', documentId: ref.documentId };
  const claimed = await deps.documents.claim(ref.documentId, {
    leaseMs: opts.leaseMs ?? DEFAULT_SUBMIT_LEASE_MS,
    ...(opts.ignoreSchedule || opts.inline ? { ignoreSchedule: true } : {}),
  });
  if (!claimed) return { kind: 'skipped', reason: 'NOT_CLAIMED', documentId: ref.documentId };
  if (claimed.tenantId !== ref.tenantId) return { kind: 'skipped', reason: 'TENANT_MISMATCH', documentId: ref.documentId };
  return submitClaimedDocument(deps, claimed, { ...opts, gate, now });
}

/** إرسال مستند **مُستولى عليه** (المسح الدوري يستولي دفعةً واحدة). */
export async function submitClaimedDocument<Tx>(
  deps: SubmitDeps<Tx>, claimed: ClaimedDocument, opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const now = opts.now ?? deps.now();
  const subtype = subtypeOfTypeName(claimed.typeName);
  const gate = opts.gate ?? (await deps.gate.loadSubmitGate(claimed.tenantId)) ?? CLOSED_GATE;

  // إيقاف الشركة بعد الاستيلاء (المسح يستبعدها في الاستعلام؛ هذا للطلب الحيّ والإعادة اليدوية)
  if (gate.pausedAt) return deferClaimed(deps, claimed, new Date(now.getTime() + retryDelayMs(claimed.attempts)), now);

  if (!subtype) return finishLocal(deps, claimed, null, 'SUBTYPE_INVALID', now);

  const unit = await deps.units.loadUnit(claimed.egsUnitId);
  if (!unit || unit.tenantId !== claimed.tenantId) return finishLocal(deps, claimed, subtype, 'UNIT_MISSING', now);
  if (!SUBMIT_UNIT_STATUSES.includes(unit.status)) return finishLocal(deps, claimed, subtype, 'UNIT_NOT_SUBMITTABLE', now, { data: { unitStatus: unit.status } });
  if (!isEnv(unit.environment)) return finishLocal(deps, claimed, subtype, 'ENV_INVALID', now, { data: { environment: unit.environment } });
  // وحدة إنتاج لشركة غير مفعّلة: لا تُرسل أبداً (فشل مغلق — البروفة تعمل على simulation وحدها)
  if (unit.environment === 'production' && !gate.live) return finishLocal(deps, claimed, subtype, 'TENANT_NOT_LIVE', now);

  // 429 لهذه الوحدة: لا استدعاء حتى انقضاء المهلة
  const paused = deps.pauses?.pausedUntil(claimed.egsUnitId, now) ?? null;
  if (paused) return deferClaimed(deps, claimed, paused, now);

  // نقد 9/40: بايتات وُقّعت بنسخة مفتاح غير الحالية (تجديد وقع بينهما)
  const policy = staleKeyPolicy(deps.env ?? process.env);
  const staleKey = claimed.keyVersion !== null && claimed.keyVersion !== unit.keyVersion;
  if (staleKey && (policy === 'never' || (policy === 'report' && claimed.flow === 'CLEARANCE'))) {
    return finishLocal(deps, claimed, subtype, 'STALE_KEY', now, {
      notify: 'STALE_KEY', data: { documentKeyVersion: claimed.keyVersion, unitKeyVersion: unit.keyVersion },
      /* مستند **اعتماد** بشهادة سابقة عالقٌ بلا موعد استرداد (blockedNextAttemptAt للاعتماد null): مخرجه السحب أو
       * الإعادة اليدوية وكلاهما بيد إنسان — فلا يمرّ صامتاً (مراجعة عدائية ٢). */
      owner: claimed.flow === 'CLEARANCE',
    });
  }

  const creds = await deps.units.loadUnitCredentials(claimed.egsUnitId);
  if (!creds || typeof creds.productionToken !== 'string' || creds.productionToken === ''
    || typeof creds.productionSecretEnc !== 'string' || creds.productionSecretEnc === '') {
    return finishLocal(deps, claimed, subtype, 'CREDENTIALS_MISSING', now);
  }
  let secret: string;
  try {
    secret = decryptSecret(creds.productionSecretEnc, { purpose: 'pcsid-secret', ownerId: claimed.egsUnitId }, deps.keyring());
  } catch (e) {
    return finishLocal(deps, claimed, subtype, 'SECRETS', now, { data: { code: e instanceof SecretsError ? e.code : 'UNKNOWN' } });
  }

  const bytes = await deps.documents.loadDocumentXml(claimed.id);
  if (!bytes || typeof bytes.xml !== 'string' || bytes.xml === '') return finishLocal(deps, claimed, subtype, 'BYTES_MISSING', now);
  const stampedQr = extractQrFromXml(bytes.xml) ?? undefined;

  /* انقضى عقد الإيجار قبل أن يبدأ الاستدعاء (انتظارٌ طويل في طابور الحصص، أو مسحٌ بطيء): لا تنادِ الهيئة ببايتات
   * صار غيرُك يملك حقّ إرسالها — المستند قابل للاستيلاء الآن، فإرسالُنا يزدوج مع إرساله، والسحب قد يكون أبطل فاتورته
   * بينما نحن نرسلها. يبقى SUBMITTING بعقد منقضٍ فيلتقطه المسح التالي بأمان. */
  if (claimed.leaseUntil instanceof Date && claimed.leaseUntil.getTime() <= deps.now().getTime()) {
    return { kind: 'skipped', reason: 'LEASE_EXPIRED', documentId: claimed.id };
  }

  if (staleKey) await fire(deps, noteOf('STALE_KEY', claimed, { documentKeyVersion: claimed.keyVersion, unitKeyVersion: unit.keyVersion, sent: true }));
  if (DRAINING_UNIT_STATUSES.includes(unit.status)) await fire(deps, noteOf('DRAINING_UNIT', claimed, { unitStatus: unit.status }));

  // ─── الاستدعاء (خارج أي معاملة) ───
  const captured: { entry: ApiLogEntry | null } = { entry: null };
  const timeoutMs = Math.max(1000, Math.trunc(opts.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS));
  const client = deps.client({
    env: unit.environment,
    timeoutMs,
    log: async (entry: ApiLogEntry) => {
      captured.entry = entry;
      try {
        await deps.documents.writeApiLog({
          tenantId: claimed.tenantId, egsUnitId: claimed.egsUnitId, documentId: claimed.id, actorId: null, endpoint: entry.endpoint,
          httpStatus: entry.httpStatus, outcome: entry.outcome, durationMs: entry.durationMs,
          response: {
            env: entry.env, method: entry.method, path: entry.path, attempt: entry.attempt, reason: entry.reason,
            responseBytes: entry.responseBytes, uuid: entry.uuid, invoiceHash: entry.invoiceHash,
            body: entry.response as unknown as Record<string, unknown> | null,
          },
          errorText: entry.errorText, at: deps.now(),
        });
      } catch { /* السجلّ دليل لا يُفشل الإرسال */ }
    },
  });

  /* وسم الإرسال قبل النداء مباشرةً (مراجعة عدائية ٢): `attempts` يرفعه الاستيلاء ولو لم تغادر بايتة، فلا يصلح دليلاً
   * على أنّ الهيئة ربّما استلمت. وإن تعذّر الوسم فلا نداء: نداءٌ بلا أثرٍ دائم يجعل السحب يظنّ أنّ شيئاً لم يُرسل وقد
   * أُرسل — يُؤجَّل المستند بتراجعه ويلتقطه المسح. */
  let marked = false;
  try {
    marked = await deps.documents.markDispatched(claimed.id);
  } catch { marked = false; }
  if (!marked) return deferClaimed(deps, claimed, new Date(now.getTime() + retryDelayMs(claimed.attempts)), now, 'DISPATCH_UNMARKED');

  const body: InvoiceBody = { invoiceHash: claimed.invoiceHash, uuid: claimed.uuid, invoice: Buffer.from(bytes.xml, 'utf8').toString('base64') };
  const call: CallOptions = {
    attempt: Math.max(1, Math.min(claimed.attempts, 10000)), priorEmpty400: claimed.priorEmpty400,
    priorPayload413: claimed.priorPayload413, timeoutMs,
  };
  const creds2: Creds = { token: creds.productionToken, secret };
  const outcome: Outcome = claimed.flow === 'CLEARANCE' ? await client.clear(creds2, body, call) : await client.report(creds2, body, call);
  const at = deps.now();

  // ─── التصنيف ⇒ الحالة ───
  let write = transitionForOutcome(outcome, {
    flow: claimed.flow, attempts: claimed.attempts, priorEmpty400: claimed.priorEmpty400, priorPayload413: claimed.priorPayload413,
    // createdAt = لحظة إدراج المستند داخل معاملة الإصدار (= issuedAt عملياً): منها مهلة 24 ساعة حين يُوقف الاعتماد (303)
    issuedAt: claimed.createdAt, reportDeadline: claimed.reportDeadline, now: at,
  });

  // اعتماد بلا مستند معتمد صالح ⇒ CLEARED_NO_XML (لا يُعلَن اعتماد بلا نسخته)
  let clearedXml: string | null = null;
  if (write.status === 'CLEARED' || write.status === 'CLEARED_WARN') {
    clearedXml = decodeClearedXml((outcome as { clearedXmlB64?: string }).clearedXmlB64);
    if (clearedXml === null) write = { ...write, status: 'CLEARED_NO_XML', alert: 'CLEARED_NO_XML' };
  }

  if (outcome.kind === 'RETRY' && outcome.reason === 'rate') deps.pauses?.pause(claimed.egsUnitId, at, outcome.retryAfterSeconds);
  if (outcome.kind === 'ACCEPTED' || outcome.kind === 'DUPLICATE') deps.authMemory?.clear(claimed.egsUnitId);

  const httpStatus = captured.entry?.httpStatus ?? null;
  const { applied, mirror } = await persistOutcome(deps, {
    claimed, subtype, write, httpStatus, validation: validationOf(outcome, captured.entry, null, at), clearedXml, stampedQr, outcome,
    local: null, now: at,
  });

  // ─── ما بعد الكتابة: التفويض والإشعارات والبثّ ───
  let authConfirmed = false;
  if (applied && write.authFailure) {
    authConfirmed = deps.authMemory?.record(claimed.egsUnitId, claimed.id, at) ?? false;
    if (authConfirmed) {
      // معاملة مستقلّة (F19): حالة الوحدة لا تُكتب داخل معاملة نتيجة المستند
      const moved = await deps.units.compareAndSetUnit(claimed.egsUnitId, { status: 'ACTIVE' }, { status: 'AUTH_FAILED', lastError: 'ZATCA 401' }, at);
      await fire(deps, { ...noteOf('UNIT_AUTH_FAILED', claimed, { moved }), owner: true });
    } else {
      await fire(deps, noteOf('AUTH_BLOCKED', claimed));
    }
  }
  if (applied && !write.authFailure) {
    if (write.alert === 'REJECTED') await fire(deps, noteOf('REJECTED', claimed, { errors: write.errors.map(e => e.message).filter(Boolean).slice(0, 5) }));
    else if (write.alert === 'CONFIG') await fire(deps, noteOf('CONFIG_ERROR', claimed, { detail: outcome.kind === 'CONFIG' ? outcome.detail : null }));
    else if (write.alert === 'CLEARED_NO_XML') await fire(deps, noteOf('CLEARED_NO_XML', claimed));
  }
  if (applied) deps.publish?.(claimed.tenantId);
  /* نودينا الهيئة فعلاً ثم مُنعت كتابة النتيجة بالتسييج: نتيجةٌ حقيقية ضاعت (عاملٌ آخر استولى على المستند بعد
   * انقضاء عقدنا). لا تمرّ صامتةً — المالك يُنبَّه ليراجع حالة الفاتورة قبل أن تُسلَّم أو تُسحب. */
  if (!applied) await fire(deps, { ...noteOf('OUTCOME_LOST', claimed, { outcome: outcome.kind, httpStatus }), owner: true });

  return {
    kind: 'done', documentId: claimed.id, invoiceId: claimed.invoiceId, tenantId: claimed.tenantId, egsUnitId: claimed.egsUnitId,
    subtype, flow: write.flow ?? claimed.flow, status: write.status, mirror, outcome: outcome.kind, local: null, httpStatus,
    nextAttemptAt: write.nextAttemptAt, alert: write.alert, authConfirmed, applied,
  };
}

// ─── الإعادة اليدوية (مدير الشركة — يوصلها Z5.6c) ───

export const MANUAL_RETRY_LEASE_MS = 30_000;

/**
 * إعادة إرسال فورية بالبايتات نفسها من RETRY_WAIT أو AUTH_BLOCKED أو CONFIG_ERROR (status.ts MANUAL_RETRY_FROM):
 * تُعيد المستند إلى الطابور الآن ثم تستولي عليه. لا تلمس SUBMITTING (عاملٌ حيّ) ولا الحالات النهائية، ولا تتخطّى إيقاف
 * الشركة ولا إيقاف 429.
 */
export async function retryDocumentNow<Tx>(
  deps: SubmitDeps<Tx>, ref: { documentId: string; tenantId: string }, opts: SubmitOptions = {},
): Promise<SubmitResult> {
  const now = opts.now ?? deps.now();
  await deps.documents.requeueForRetry(ref.documentId, MANUAL_RETRY_FROM, now);
  return submitDocument(deps, ref, { ...opts, now, ignoreSchedule: true, leaseMs: opts.leaseMs ?? MANUAL_RETRY_LEASE_MS });
}

export { AUTH_CONFIRM_MIN_GAP_MS };
