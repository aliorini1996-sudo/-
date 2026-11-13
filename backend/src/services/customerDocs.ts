import type { AuthRequest } from '../types';
import { actorOf, isOwnerSession } from '../middleware/auth';

/**
 * «استديو العميل» (طلب المالك ١٣ نوفمبر ٢٠٢٦): وثائق العميل وصوره — السجل التجاري والهوية والشهادة الضريبية وصورة المحل…
 * تُرفع مع إضافة العميل (لوحة الشركة وتطبيق المندوب — ودون اتصال مع العميل نفسه في صفّ الإرسال) ومن الاستديو. الصورة تصل data URL
 * مضغوطة على الجهاز (rep/imageCompress.ts) وتُفحص هنا بالبايتات لا بما تدّعيه البادئة.
 *
 * والقاعدة «بلا قيود على العميل» (أمر المالك ٩ نوفمبر): إنشاء العميل لا يُرفض لوثيقة — ما لا يصلح منها يُسقط ويعود تحذيراً.
 * الرفع من الاستديو وحده يردّ 400 حين لا تصلح صورة (المستخدم أمام الشاشة يعيد الاختيار).
 */

/** أنواع الوثيقة — المرآة في web-admin/src/lib/customerDocs.ts (اختبار التطابق: customer-docs.test.ts) */
export const CUSTOMER_DOC_KINDS = ['CR', 'VAT', 'ID', 'SHOP', 'CONTRACT', 'OTHER'] as const;
export type CustomerDocKind = (typeof CUSTOMER_DOC_KINDS)[number];

/** أقصى عدد صور في الطلب الواحد — ستّ صور بسقفها تبقى تحت حدّ جسم JSON (10mb في index.ts) */
export const CUSTOMER_DOC_MAX_PER_REQUEST = 6;
/** أقصى عدد وثائق للعميل الواحد */
export const CUSTOMER_DOC_MAX_PER_CUSTOMER = 60;
/** أقصى طول لنصّ data URL الواحد (~1.1MB بايتاً) — الضغط على الجهاز (1600 بكسل، JPEG) يقع تحته بكثير */
export const CUSTOMER_DOC_MAX_DATA_LEN = 1_500_000;

export interface CustomerDocInput { kind: CustomerDocKind; data: string; sizeBytes: number }

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** صيغة الصورة من بايتاتها الأولى — لا من البادئة التي يكتبها المُرسِل */
export function sniffImageMime(head: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** نوعٌ مجهول أو غائب ⇒ OTHER (لا يُرفض) */
export function normalizeDocKind(v: unknown): CustomerDocKind {
  const k = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (CUSTOMER_DOC_KINDS as readonly string[]).includes(k) ? (k as CustomerDocKind) : 'OTHER';
}

/** وثيقةٌ واحدة صالحة أو null: نصّ data URL لصورة JPEG/PNG/WebP تحت السقف، وبايتاتها تطابق البادئة */
export function parseCustomerDoc(raw: unknown): CustomerDocInput | null {
  const o = (raw && typeof raw === 'object' ? raw : { data: raw }) as { kind?: unknown; data?: unknown };
  const data = typeof o.data === 'string' ? o.data.trim() : '';
  if (!data || data.length > CUSTOMER_DOC_MAX_DATA_LEN) return null;
  const m = DATA_URL.exec(data);
  if (!m) return null;
  const b64 = m[2];
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (bytes < 32) return null;
  if (sniffImageMime(Buffer.from(b64.slice(0, 24), 'base64')) !== m[1]) return null;
  return { kind: normalizeDocKind(o.kind), data, sizeBytes: bytes };
}

/**
 * قائمة الوثائق من جسم الطلب: الصالح منها حتى سقف الطلب، وعدد ما أُسقط (غير صالح أو زائد). الغائب ⇒ لا شيء ولا إسقاط
 */
export function parseCustomerDocs(raw: unknown): { docs: CustomerDocInput[]; dropped: number } {
  if (raw == null) return { docs: [], dropped: 0 };
  const list = Array.isArray(raw) ? raw : [raw];
  const docs: CustomerDocInput[] = [];
  let dropped = 0;
  for (const item of list) {
    const d = docs.length < CUSTOMER_DOC_MAX_PER_REQUEST ? parseCustomerDoc(item) : null;
    if (d) docs.push(d); else dropped++;
  }
  return { docs, dropped };
}

/** تحذير الإنشاء حين أُسقطت وثائق — العميل نفسه حُفظ */
export function droppedDocsWarning(dropped: number): object | null {
  return dropped > 0
    ? { code: 'CUSTOMER_DOCS_DROPPED', dropped, message: `لم تُحفظ ${dropped} من صور الوثائق لأنها ليست صوراً صالحة أو تجاوزت الحد (${CUSTOMER_DOC_MAX_PER_REQUEST} صور بحجم معقول)` }
    : null;
}

/**
 * من رفع الوثيقة: المندوب أو مستخدم الشركة أو مفتاح الربط البرمجي — باسمه وقت الرفع. وجلسة «دخول» المالك أو موظف المنصة (توكنها
 * يحمل هوية مدير الشركة) ومفتاحٌ أصدره الدعم تُنسب لـ«الدعم الفني» بمعرّف OWNER:… — كسجلّ النشاط (actorOf) لا باسم مدير الشركة
 */
export function docUploader(req: AuthRequest): { uploadedByKind: 'ADMIN' | 'REP' | 'API'; uploadedById: string | null; uploadedByName: string | null } {
  const u = req.user;
  const kind = u?.apiKeyId ? 'API' : u?.role === 'SALES_REP' ? 'REP' : 'ADMIN';
  const support = isOwnerSession(req) || u?.ownerIssuedKey === true;
  const name = support ? 'الدعم الفني' : u?.name ? String(u.name).slice(0, 120) : null;
  return { uploadedByKind: kind, uploadedById: u ? actorOf(req) : null, uploadedByName: name };
}

/** مفتاح دفعة وثائق العميل الجديد: مع إنشائه مباشرةً ومن صفّ المندوب دون اتصال — فالمرسَل مرّتين يُعرف ولا يُكرَّر */
export const docsBatchRef = (customerClientRef: string) => `${customerClientRef}:docs`;

/** صفوف الإنشاء (المتداخل في customer.create، أو customerDocument.create) */
export function docCreateRows(tid: string, docs: CustomerDocInput[], req: AuthRequest, clientRef?: string | null) {
  const by = docUploader(req);
  return docs.map((d) => ({ tenantId: tid, kind: d.kind, data: d.data, sizeBytes: d.sizeBytes, ...by, clientRef: clientRef ?? null }));
}

/** data URL صورة يجوز إعادته للمتصفح (صور الزيارات والسندات القديمة نصٌّ حرّ لم يُفحص عند حفظه — لا يُعاد رابطاً ولا نصّاً آخر) */
export const isServableImage = (s: unknown): s is string => typeof s === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/]/.test(s);
