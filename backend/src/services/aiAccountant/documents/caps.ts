/**
 * «المحاسب الذكي AI» — مستندات المحادثة: السقوف ومفاتيح البيئة وفحص الملف (طلب المالك ١٨ نوفمبر ٢٠٢٦، القرار D8).
 *
 * - الصورة ≤ 400 كيلوبايت بعد الضغط في الجهاز (JPEG/PNG)، وPDF ≤ AI_ACCOUNTANT_DOC_PDF_MB (افتراض ٣ ميغابايت) — سقف
 *   المحاسب الذكي وحده؛ مرفقات القيود اليدوية تبقى بسقوفها (ATTACHMENT_CAPS في routes/ledger/moves.ts).
 * - الحصة مشتركة مع مرفقات الدفاتر وبحسابها نفسه: ٥٠ ميغابايت للشهر (بتوقيت الشركة) و٥٠٠ إجمالاً لكل gl_attachments.
 * - النوع من البايتات وحدها (sniffAttachmentMime): PDF وJPEG وPNG فقط، والمعلَن يجب أن يطابق المكتشَف.
 * - ثلاثة مستندات للرسالة، وغير المرحّل يُجمع بعد AI_ACCOUNTANT_DOC_RETENTION_DAYS (افتراض ٣٠ يوماً).
 * - مفتاح الإطفاء AI_ACCOUNTANT_DOCS مفعّل افتراضياً: '0' أو 'off' وحدهما يطفئان.
 * - «سجّل القيد» دورة محادثة (POST /chat بحرّاسها: AI_ACCOUNTANT_LLM ثم إعداد النموذج — 503 قبل الجسم)، فالمستندات تتبع
 *   المحادثة: مفتاحها مطفأ أو نموذجٌ غير مُعدّ ⇒ لا رفع ولا زرّ (لا مستندٌ يُرفع ويستهلك الحصة ثم لا يُرحَّل أبداً).
 * دوال صرفة بلا قاعدة (مختبَرة مباشرة).
 */
import {
  ATTACHMENT_CAPS, ATTACHMENT_MIME_TYPES, sanitizeFileName, sniffAttachmentMime, type AttachmentMime,
} from '../../../routes/ledger/moves';
import { MAX_QR_DECODE_LENGTH } from '../../../compliance/zatca/qr';
import { toMilli } from '../../gl/money';
import { llmConfig } from '../../../ai-rep/llm';
import { aiChatEnabled, aiWriteEnabled } from '../context';
import type { AcctDocsStatus } from './types';

export { ATTACHMENT_MIME_TYPES, sanitizeFileName, sniffAttachmentMime, type AttachmentMime };

const KB = 1024;
const MB = 1024 * KB;

/** مستندات الرسالة الواحدة */
export const DOCS_PER_MESSAGE = 3;
/**
 * أطول نص QR يُقبل في الترويسة X-Zatca-Qr: سقف الفكّ نفسه في compliance/zatca/qr.ts (٢٠٤٨ — ضعف سقف الهيئة ١٠٠٠ بهامش)،
 * ومرآته في الويب ZATCA_QR_MAX_LENGTH — فما يقرؤه الجهاز ويرسله لا يُرفض هنا قبل أن يُفكّ ويُتحقَّق منه.
 */
export const MAX_QR_HEADER_LENGTH = MAX_QR_DECODE_LENGTH;
/** أقصى ما يُجمع في دورة جمعٍ كسولة واحدة (تحت قفل الحصة) */
export const GC_BATCH = 50;
/** قفل حصّة المرفقات للشركة — نفسه في routes/ledger/moves.ts و«النموذج المطبوع» (نمط printForms) */
export const DOC_ATTACH_LOCK_PREFIX = 'gl-attach:';
/** هامش جسم الطلب الخام فوق سقف الملف (express.raw) */
export const RAW_BODY_MARGIN_BYTES = 64 * KB;

const DEFAULT_PDF_MB = 3;
const MAX_PDF_MB = 10;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_ASSET_THRESHOLD = 2000;

/** AI_ACCOUNTANT_DOCS: مفعّل افتراضياً — '0' أو 'off' (بأي حالة أحرف) وحدهما يطفئان */
export function docsEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AI_ACCOUNTANT_DOCS ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'off';
}

/**
 * المحادثة نفسها تعمل لدى المنصة: مفتاح AI_ACCOUNTANT_LLM غير '0' ونموذجٌ مُعدّ (llmConfig) — حرّاس POST /chat الأولى
 * (AI_ACCOUNTANT_OFF / AI_LLM_NOT_CONFIGURED) التي تسبق دورة «سجّل القيد» أيضاً. قراءة إعدادٍ فقط بلا أي نداء نموذج.
 */
export function docsChatReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return aiChatEnabled(env) && llmConfig(env) !== null;
}

/** حكم المنصة وحده (بلا المستخدم): المفتاح + الترحيل غير موقوف + المحادثة تعمل — وإلا DOCS_DISABLED في حارس المسارات */
export function docsPlatformEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return docsEnvEnabled(env) && aiWriteEnabled(env) && docsChatReady(env);
}

/**
 * المستندات متاحة لهذا المستخدم: مفتاح البيئة AI_ACCOUNTANT_DOCS، والترحيل غير موقوف (AI_ACCOUNTANT_WRITE)، والمحادثة تعمل
 * (docsChatReady — «سجّل القيد» دورةٌ فيها)، ومستخدمٌ يرحّل في دفاتر مفعّلة (ctx.canPost = الدفاتر مفعّلة + canPostJournals)
 * — والعَلَم والصلاحيات قبلها في سلسلة الموجّه. الرفع والتصحيح والحذف وزر «سجّل القيد» كلها بهذا الشرط.
 * chatReady: من اجتاز حرّاس المحادثة فعلاً (chat.ts بعد إعداد النموذج المحقون) يمرّره true بدل إعادة قراءة البيئة.
 */
export function docsEnabledFor(ctx: { canPost: boolean }, env: NodeJS.ProcessEnv = process.env, chatReady: boolean = docsChatReady(env)): boolean {
  return docsEnvEnabled(env) && aiWriteEnabled(env) && chatReady && ctx.canPost === true;
}

/** كتلة docs في GET /status */
export function docsStatusOf(ctx: { canPost: boolean }, env: NodeJS.ProcessEnv = process.env): AcctDocsStatus {
  const enabled = docsEnabledFor(ctx, env);
  const caps = docCaps(env);
  return {
    enabled,
    canUpload: enabled,
    caps: { imageBytes: caps.imageBytes, pdfBytes: caps.pdfBytes, perMessage: caps.perMessage },
    assetThreshold: assetThreshold(env),
    retentionDays: docRetentionDays(env),
  };
}

/** سقف PDF بالبايت من AI_ACCOUNTANT_DOC_PDF_MB (موجب؛ بحدّ ١٠ ميغابايت) — وإلا ٣ */
export function docPdfCapBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.AI_ACCOUNTANT_DOC_PDF_MB ?? '').trim());
  const mb = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_PDF_MB) : DEFAULT_PDF_MB;
  return Math.floor(mb * MB);
}

/** أيام بقاء المستند غير المرحّل (١..٣٦٥) من AI_ACCOUNTANT_DOC_RETENTION_DAYS — وإلا ٣٠ */
export function docRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.AI_ACCOUNTANT_DOC_RETENTION_DAYS ?? '').trim());
  return Number.isInteger(n) && n >= 1 && n <= 365 ? n : DEFAULT_RETENTION_DAYS;
}

/** حدّ الرسملة (D3) بوحدة العملة الكبرى من AI_ACCOUNTANT_ASSET_THRESHOLD (عددٌ موجب) — وإلا ٢٠٠٠ */
export function assetThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.AI_ACCOUNTANT_ASSET_THRESHOLD ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n > 0 && n <= 1_000_000_000 ? n : DEFAULT_ASSET_THRESHOLD;
}

/** حدّ الرسملة بالملّي (BigInt كـposting.ts) */
export function assetThresholdMilli(env: NodeJS.ProcessEnv = process.env): bigint {
  return toMilli(String(assetThreshold(env)), 3);
}

export interface DocCaps {
  imageBytes: number;
  pdfBytes: number;
  monthlyBytes: number;
  totalBytes: number;
  perMessage: number;
}

/** السقوف الفعلية: الصورة كسقف الدفاتر، وPDF من البيئة، والحصة الشهرية والكلية مشتركة مع الدفاتر */
export function docCaps(env: NodeJS.ProcessEnv = process.env): DocCaps {
  return {
    imageBytes: ATTACHMENT_CAPS.imageBytes,
    pdfBytes: docPdfCapBytes(env),
    monthlyBytes: ATTACHMENT_CAPS.monthlyBytes,
    totalBytes: ATTACHMENT_CAPS.totalBytes,
    perMessage: DOCS_PER_MESSAGE,
  };
}

/** حدّ express.raw للمسار: أكبر السقفين + الهامش */
export function rawBodyLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const c = docCaps(env);
  return Math.max(c.pdfBytes, c.imageBytes) + RAW_BODY_MARGIN_BYTES;
}

export interface DocCapViolation {
  reason: 'FILE_TOO_LARGE' | 'MONTHLY_QUOTA' | 'TOTAL_QUOTA' | 'EMPTY_FILE';
  capBytes: number;
  sizeBytes: number;
  usedBytes?: number;
}

/**
 * سقف الملف وحده (قبل المعاملة): فارغ ⇒ EMPTY_FILE، وفوق سقف نوعه ⇒ FILE_TOO_LARGE. أخت attachmentCapViolation في
 * moves.ts (تلك مقيّدة بسقف PDF الدفاتر ١ ميغابايت) بسقوف المحاسب الذكي.
 */
export function docFileCapViolation(mimeType: AttachmentMime, sizeBytes: number, caps: DocCaps = docCaps()): DocCapViolation | null {
  if (sizeBytes <= 0) return { reason: 'EMPTY_FILE', capBytes: 0, sizeBytes };
  const fileCap = mimeType === 'application/pdf' ? caps.pdfBytes : caps.imageBytes;
  if (sizeBytes > fileCap) return { reason: 'FILE_TOO_LARGE', capBytes: fileCap, sizeBytes };
  return null;
}

/** الملف ثم الحصة الشهرية ثم الكلية — حساب moves.ts نفسه (المستعمل + الملف > السقف ⇒ رفض) */
export function docCapViolation(input: {
  mimeType: AttachmentMime; sizeBytes: number; monthUsedBytes: number; totalUsedBytes: number;
}, caps: DocCaps = docCaps()): DocCapViolation | null {
  const file = docFileCapViolation(input.mimeType, input.sizeBytes, caps);
  if (file) return file;
  if (input.monthUsedBytes + input.sizeBytes > caps.monthlyBytes) {
    return { reason: 'MONTHLY_QUOTA', capBytes: caps.monthlyBytes, sizeBytes: input.sizeBytes, usedBytes: input.monthUsedBytes };
  }
  if (input.totalUsedBytes + input.sizeBytes > caps.totalBytes) {
    return { reason: 'TOTAL_QUOTA', capBytes: caps.totalBytes, sizeBytes: input.sizeBytes, usedBytes: input.totalUsedBytes };
  }
  return null;
}

/**
 * النوع المعلَن والمكتشَف: المعلَن أحد الثلاثة والمكتشَف من البايتات يطابقه — وإلا null (415 ATTACHMENT_TYPE_NOT_ALLOWED).
 * المعلَن من Content-Type بلا معاملاته وبأحرف صغيرة.
 */
export function sniffDocMime(bytes: Uint8Array, declaredContentType: string | null | undefined): { mime: AttachmentMime | null; declared: string; detected: AttachmentMime | null } {
  const declared = String(declaredContentType ?? '').split(';')[0].trim().toLowerCase();
  const detected = sniffAttachmentMime(bytes);
  const ok = (ATTACHMENT_MIME_TYPES as readonly string[]).includes(declared) && !!detected && detected === declared;
  return { mime: ok ? detected : null, declared, detected };
}

/** اسم الملف من ترويسة X-File-Name المرمّزة URI (المعطوبة تبقى كما هي) ثم التنظيف (sanitizeFileName) */
export function docFileNameOf(header: unknown, mime: AttachmentMime): string {
  let name: unknown = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : '';
  try { name = decodeURIComponent(String(name ?? '')); } catch { /* يبقى كما هو */ }
  // eslint-disable-next-line no-control-regex
  const clean = sanitizeFileName(String(name ?? '').replace(/[‎‏‪-‮⁦-⁩]/g, ''), mime);
  return clean;
}

/**
 * ترويسة X-Zatca-Qr: غائبة/فارغة ⇒ null؛ base64 (بحروفه وحشوه) بطول ≤ MAX_QR_HEADER_LENGTH ⇒ النص؛ غير ذلك ⇒ 'INVALID'
 * (لا يُرفض الرفع: المستند يبدأ إدخالاً يدوياً بتنبيه QR_INVALID). ما وصل مرمَّز URL (%2B…) يُفكّ، وفواصل الأسطر التي
 * يضيفها بعض القرّاء تُزال — والتحقق القانوني والفكّ في compliance/zatca/qr.ts (عبر documents/qr.ts).
 */
export function qrHeaderOf(header: unknown): string | null | 'INVALID' {
  const raw = typeof header === 'string' ? header : Array.isArray(header) ? String(header[0] ?? '') : '';
  let s = raw.trim();
  if (!s) return null;
  if (s.length > MAX_QR_HEADER_LENGTH * 3) return 'INVALID';
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try { s = decodeURIComponent(s); } catch { return 'INVALID'; }
  }
  s = s.replace(/[\r\n\t ]+/g, '');
  if (!s || s.length > MAX_QR_HEADER_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return 'INVALID';
  return s;
}
