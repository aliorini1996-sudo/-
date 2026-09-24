// ============================================================================
// ZATCA المرحلة الثانية (Z5.7) — رابط المشتري: اشتقاق الرمز، وبوابة «نهائيّ»، والإسقاط العلنيّ. منطقٌ نقيّ.
// ----------------------------------------------------------------------------
// لماذا رابطٌ أصلاً: الفاتورة القياسية (01) لا تُسلَّم للمشتري إلا **بعد اعتماد الهيئة**، والذي يُسلَّم له هو مستند
// الهيئة نفسه (الـXML المعتمد ورمزه المختوم) لا ورقتنا. فبلا مخرجٍ للمشتري يبقى المستند القانونيّ حبيس القاعدة،
// ويُرسل المندوب صورةً من ورقةٍ لا قيمة نظامية لها. هذا الملفّ يفتح المخرج بثلاث قيود:
//
//   ١) **الرمز مشتقّ لا مخزَّن** (بلا عمودٍ في المخطّط): `id` المستند + بصمة HMAC‑SHA256 مقصوصة إلى 160 بت بسرٍّ
//      خادميّ (`JWT_SECRET::zatca-share-v1`). فالتخمين مستحيل عملياً، والمعرّف يُقرأ من الرمز نفسه بلا بحثٍ في
//      جدول رموز. وتبديل السرّ يُبطل كلّ الروابط دفعةً واحدة — وهو سلوكٌ مقصود لا عطل.
//   ٢) **النهائيّ وحده يُشارَك**: `REPORTED | REPORTED_WARN | CLEARED | CLEARED_WARN` — لا معلَّق ولا محجوب ولا
//      مرفوض ولا مسحوب. مستندٌ لم تحسمه الهيئة إن شورك قد يُرفض بعد ساعة، فيكون بيد المشتري «فاتورةٌ ضريبية»
//      يخصم بها مدخلاته وهي باطلة. وتُضمّ إليه بوابة الطباعة نفسها (`isPrintableMirror`) كي لا تتباعد ورقةٌ
//      يمنعها القالب عن رابطٍ يفتحها.
//   ٣) **الإسقاط بقائمة بيضاء**: اسم البائع ورقمه الضريبي، اسم المشتري، التواريخ والمبالغ والعملة، الحالة، الرمز
//      المختوم. لا معرّف شركة ولا معرّف عميل ولا وحدة EGS ولا شهادة ولا رسائل الهيئة ولا بنود. وكلّ نصٍّ يمرّ
//      بـ`scrubPanelText` (اسم الشركة والعميل يكتبهما مستخدم — لا يخرجان خاماً إلى صفحةٍ علنية).
//
// نقيّ: بلا قاعدة بيانات ولا شبكة ولا ساعة (الساعة تُمرَّر). يحرسه tests/gl-hooks-static.test.ts بمسح المجلّد.
// ============================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_CODE_CHARS, scrubPanelText, type XmlVariant } from './docsPanel';
import { isPrintableMirror, mirrorQrOf, subtypeOfTypeName, type DocumentStatus, type Subtype } from './status';

// ─── الرمز ───

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** طول البصمة بالبايت: 160 بت — التخمين الأعمى خارج حدود أيّ محدّد معدّل. */
const MAC_BYTES = 20;
const MAC_CHARS = 27; // base64url بلا حشو لعشرين بايت

/** صيغة الرمز: 32 خانة ست‑عشرية (معرّف المستند بلا شرطات) ثمّ نقطة ثمّ البصمة. */
export const SHARE_TOKEN_RE = new RegExp(`^[0-9a-f]{32}\\.[A-Za-z0-9_-]{${MAC_CHARS}}$`);

/** فصل غرض الاشتقاق: رمز مشاركةٍ مسرّب لا يصلح توكن دخول ولا العكس. */
export const SHARE_SECRET_PURPOSE = '::zatca-share-v1';

/** السرّ المشتقّ من سرّ الخادم؛ بلا سرّ ⇒ null ⇒ الميزة كلّها مغلقة (لا رابط يُصدَر ولا رابط يُقبل). */
export function shareSecretFrom(base: string | null | undefined): string | null {
  return typeof base === 'string' && base.length >= 8 ? `${base}${SHARE_SECRET_PURPOSE}` : null;
}

const macOf = (documentId: string, secret: string): string =>
  createHmac('sha256', secret).update(documentId, 'utf8').digest().subarray(0, MAC_BYTES).toString('base64url');

/** رمز المشاركة لمستندٍ بعينه — ثابتٌ لنفس المستند ونفس السرّ (فلا يتكاثر رابطٌ لكلّ فتحة شاشة). */
export function makeShareToken(documentId: string, secret: string | null): string | null {
  if (!secret || typeof documentId !== 'string' || !UUID_RE.test(documentId)) return null;
  const id = documentId.toLowerCase();
  return `${id.replace(/-/g, '')}.${macOf(id, secret)}`;
}

/** معرّف المستند من رمزٍ صحيح التوقيع، أو null. المقارنة بزمنٍ ثابت، والصيغة تُفحص قبل أيّ عمل. */
export function readShareToken(token: unknown, secret: string | null): string | null {
  if (!secret || typeof token !== 'string' || !SHARE_TOKEN_RE.test(token)) return null;
  const [flat, mac] = token.split('.');
  const id = `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20)}`;
  const expected = Buffer.from(macOf(id, secret), 'utf8');
  const given = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length) return null;
  return timingSafeEqual(expected, given) ? id : null;
}

/** رابط المشتري الكامل — صفحة عامة واحدة في الواجهة (`/e/:token`). */
export function shareUrlOf(siteBase: string, token: string): string {
  return `${String(siteBase).replace(/\/+$/, '')}/e/${token}`;
}

// ─── بوابة «نهائيّ» ───

/**
 * الحالات التي تُشارَك وحدها. `CLEARED_NO_XML` خارجها عمداً: الهيئة اعتمدت ولم تصل نسختها، فلا مستند قانونيّ
 * يُسلَّم (هي في دلو «تحتاج تدخّلاً» في شاشة المتابعة). و`REJECTED`/`WITHDRAWN` مُبطلتان.
 */
export const SHAREABLE_DOCUMENT_STATUSES: readonly DocumentStatus[] = Object.freeze(
  ['REPORTED', 'REPORTED_WARN', 'CLEARED', 'CLEARED_WARN'] as DocumentStatus[],
);

export type ShareableStatus = 'reported' | 'reported_warn' | 'cleared' | 'cleared_warn';

export interface ShareGateInput {
  /** حالة المستند في `zatca_documents`. */
  status: string | null | undefined;
  /** مرآة الفاتورة (`Invoice.einvoiceStatus`) — بوابة الطباعة نفسها. */
  mirror: string | null | undefined;
  /** نوع المستند المشتقّ من `typeName`. */
  subtype: Subtype | null;
  /** صفّ المرحلة الثانية وحده (`Invoice.zatcaPhase`). */
  phase: number | null | undefined;
}

/** يُشارَك؟ أربعة شروطٍ مجتمعة — أيّ نقصٍ يعني 404 عند الرابط العلنيّ. */
export function isShareableDocument(v: ShareGateInput): boolean {
  if (v.phase !== 2 || v.subtype === null) return false;
  if (typeof v.status !== 'string' || !(SHAREABLE_DOCUMENT_STATUSES as readonly string[]).includes(v.status)) return false;
  return isPrintableMirror(v.mirror, v.subtype);
}

/** النسخة القانونية: المعتمدة للقياسية المعتمدة، والموقَّعة لما عداها (المبسّطة المبلَّغة، والقياسية بعد إيقاف الاعتماد). */
export function publicXmlVariant(status: string): XmlVariant {
  return status === 'CLEARED' || status === 'CLEARED_WARN' ? 'cleared' : 'signed';
}

// ─── الإسقاط العلنيّ ───

export type PublicDocumentKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';

export interface PublicDocView {
  seller: { name: string | null; vatNumber: string | null };
  buyer: { name: string | null };
  document: {
    kind: PublicDocumentKind;
    subtype: Subtype;
    number: string | null;
    uuid: string;
    /** التاريخ والوقت كما خُتما في المستند (توقيت الرياض) لا كما تراهما ساعة القارئ. */
    issueDate: string | null;
    issueTime: string | null;
    currency: string;
    subtotal: number | null;
    discount: number | null;
    tax: number | null;
    total: number | null;
    status: ShareableStatus;
    flow: 'CLEARANCE' | 'REPORTING';
  };
  /** الرمز المختوم: المعتمد من الهيئة للقياسية المعتمدة، وختمُنا للمبسّطة — قاعدة `mirrorQrOf` نفسها. */
  qr: string | null;
  xml: { available: boolean; variant: XmlVariant };
}

export interface PublicProjectionInput {
  doc: {
    uuid: string;
    status: string;
    typeName: string | null;
    flow: string | null;
    qr: string | null;
    clearedQr: string | null;
    hasXml: boolean;
    hasClearedXml: boolean;
  };
  invoice: {
    number?: string | null;
    documentKind?: string | null;
    currency?: string | null;
    subtotal?: number | null;
    discountAmt?: number | null;
    taxAmt?: number | null;
    total?: number | null;
  };
  seller: { name?: string | null; legalName?: string | null; taxNumber?: string | null };
  buyer: { name?: string | null };
  /** التاريخ والوقت المختومان على المستند. */
  issueDate: string | null;
  issueTime: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}:\d{2}$/;

const money = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;

const kindOf = (v: unknown): PublicDocumentKind =>
  v === 'CREDIT_NOTE' || v === 'DEBIT_NOTE' ? v : 'INVOICE';

/**
 * الإسقاط. يفترض أنّ البوابة مرّت (`isShareableDocument`) — المستدعي يردّ 404 قبل الوصول إلى هنا، فلا فرع
 * «غير مشارَك» هنا يسرّب شيئاً بالخطأ.
 */
export function publicProjection(input: PublicProjectionInput): PublicDocView | null {
  const subtype = subtypeOfTypeName(input.doc.typeName);
  if (subtype === null) return null;
  const status = input.doc.status.toLowerCase() as ShareableStatus;
  const variant = publicXmlVariant(input.doc.status);
  const qr = mirrorQrOf({
    subtype,
    status: input.doc.status as DocumentStatus,
    qr: input.doc.qr ?? '',
    clearedQr: input.doc.clearedQr ?? null,
  });
  return {
    seller: {
      name: scrubPanelText(input.seller.legalName, 120) ?? scrubPanelText(input.seller.name, 120),
      vatNumber: scrubPanelText(input.seller.taxNumber, MAX_CODE_CHARS),
    },
    buyer: { name: scrubPanelText(input.buyer.name, 120) },
    document: {
      kind: kindOf(input.invoice.documentKind),
      subtype,
      number: scrubPanelText(input.invoice.number, 60),
      uuid: input.doc.uuid,
      issueDate: typeof input.issueDate === 'string' && DATE_RE.test(input.issueDate) ? input.issueDate : null,
      issueTime: typeof input.issueTime === 'string' && TIME_RE.test(input.issueTime) ? input.issueTime : null,
      currency: scrubPanelText(input.invoice.currency, 8) ?? 'SAR',
      subtotal: money(input.invoice.subtotal),
      discount: money(input.invoice.discountAmt),
      tax: money(input.invoice.taxAmt),
      total: money(input.invoice.total),
      status,
      flow: input.doc.flow === 'CLEARANCE' ? 'CLEARANCE' : 'REPORTING',
    },
    qr: qr === '' ? null : qr,
    xml: { available: variant === 'cleared' ? input.doc.hasClearedXml : input.doc.hasXml, variant },
  };
}
