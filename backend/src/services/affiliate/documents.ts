/**
 * مستندات ملف السفير (V2_SPEC §3 و§6.1 و§11): صورة الهوية الوطنية/الإقامة للجميع، والسجل التجاري للشركة.
 *
 * - **النوع من البايتات** لا من البادئة ولا من الاسم (sniffAttachmentMime من services/purchaseAttachments.ts):
 *   JPEG أو PNG أو WebP أو PDF، ≤ ٥ ميغابايت بعد فكّ base64. SVG وHTML وغيرها مرفوضة.
 * - **مشفّرة** AES-256-GCM في جدولٍ منفصل (`AffiliateDocumentBlob.enc` = iv(12) + tag(16) + cipher) بمفتاح
 *   `AFFILIATE_DOC_KEY` (hex ٦٤ أو base64 لـ٣٢ بايتاً) وإلا مشتقّ من سرّ السفير `::doc` — غير مفتاح الآيبان، ومربوطةٌ
 *   بصاحبها (AAD = معرّف السفير): نقل الصفّ إلى سفيرٍ آخر في القاعدة يُفشل فكّه.
 * - **مستندٌ واحدٌ ساري لكل نوع**: الرفع يحذف السابق من النوع نفسه (والبايتات تتبعه بالحذف المتتالي) تحت قفل صفّ السفير.
 * - لا تُعاد البايتات إلا للسفير نفسه (routes/affiliate.ts) أو للمالك/الموظف بصلاحية `affiliates.iban` عبر
 *   `documentDataUrl` مع حدث `document_viewed` يسجّله المستدعي (routes/affiliateAdmin.ts — الوكيل B).
 * - اكتمال الملف (`profileCompletedAt`) يُحدَّث بعد كلّ تغييرٍ يمسّه: المستندات هنا، والنوع (PUT /me) والآيبان
 *   (PUT /payout-profile) في البوابة.
 */
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';
import { affiliateSecret, logEvent } from './core';
import { sniffAttachmentMime } from '../purchaseAttachments';
import { DocKind, ProfileMissing, profileMissing } from './rules';

type Db = Prisma.TransactionClient | typeof prisma;

export const AFFILIATE_DOC_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type AffiliateDocMime = (typeof AFFILIATE_DOC_MIMES)[number];

/** ٥ ميغابايت للملف بعد فكّ base64 — data URL أطول بالثلث (~٦٫٧ ميغابايت) فيبقى تحت حدّ جسم JSON (10mb في index.ts) */
export const AFFILIATE_DOC_MAX_BYTES = 5 * 1024 * 1024;
const MIN_BYTES = 32;
const MAX_DATA_LEN = 'data:application/pdf;base64,'.length + Math.ceil(AFFILIATE_DOC_MAX_BYTES / 3) * 4;
const DATA_URL = /^data:(image\/jpeg|image\/png|image\/webp|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * data URL ⇒ نوعه المفحوص وبايتاته، أو سبب الرفض بالعربية. البادئة تُعلن النوع والبايتات تشهد عليه:
 * PDF بادئته image/png يُرفض، وصورةٌ بادئتها application/pdf تُرفض.
 */
export function parseDocumentDataUrl(raw: unknown): { ok: true; mime: AffiliateDocMime; bytes: Buffer } | { ok: false; reason: string } {
  const data = typeof raw === 'string' ? raw.trim() : '';
  if (!data) return { ok: false, reason: 'الملف فارغ' };
  if (data.length > MAX_DATA_LEN) return { ok: false, reason: 'حجم الملف أكبر من ٥ ميغابايت' };
  const m = DATA_URL.exec(data);
  if (!m) return { ok: false, reason: 'نوع الملف غير مدعوم — المسموح صورة (JPEG أو PNG أو WebP) أو ملف PDF' };
  const b64 = m[2];
  if (b64.length % 4 !== 0) return { ok: false, reason: 'الملف تالف' };
  const declared = m[1] as AffiliateDocMime;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < MIN_BYTES) return { ok: false, reason: 'الملف تالف أو فارغ' };
  if (bytes.length > AFFILIATE_DOC_MAX_BYTES) return { ok: false, reason: 'حجم الملف أكبر من ٥ ميغابايت' };
  if (sniffAttachmentMime(bytes.subarray(0, 16)) !== declared) {
    return { ok: false, reason: 'محتوى الملف لا يطابق نوعه — المسموح صورة (JPEG أو PNG أو WebP) أو ملف PDF' };
  }
  return { ok: true, mime: declared, bytes };
}

// ───────────────────────────── التشفير ─────────────────────────────

function docKey(): Buffer {
  const raw = process.env.AFFILIATE_DOC_KEY;
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (k.length === 32) return k;
  }
  return crypto.createHash('sha256').update(`${affiliateSecret()}::doc`).digest();
}

/** AES-256-GCM: iv(12) + tag(16) + cipher — مربوطٌ بصاحبه (AAD) */
export function encryptDocument(plain: Buffer, affiliateId: string): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', docKey(), iv);
  c.setAAD(Buffer.from(`ax-doc:${affiliateId}`, 'utf8'));
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

/** فكّ التشفير — العبث أو المفتاح الخطأ أو صاحبٌ آخر ⇒ null */
export function decryptDocument(stored: Uint8Array, affiliateId: string): Buffer | null {
  try {
    const buf = Buffer.from(stored);
    if (buf.length < 28) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', docKey(), buf.subarray(0, 12));
    d.setAAD(Buffer.from(`ax-doc:${affiliateId}`, 'utf8'));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  } catch { return null; }
}

// ───────────────────────────── الملف ─────────────────────────────

export interface DocumentMeta { kind: string; mime: string; sizeBytes: number; createdAt: string }

/** قفل صفّ السفير — رفعان أو حذفان متزامنان لا يتركان مستندين ساريين من النوع نفسه، ولا اكتمالاً قديماً */
async function lockAffiliate(tx: Prisma.TransactionClient, affiliateId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM affiliate_users WHERE id = ${affiliateId} FOR UPDATE`;
}

/** مستنداته السارية بلا بايتات: الأحدث لكل نوع */
export async function listDocuments(affiliateId: string, db: Db = prisma): Promise<DocumentMeta[]> {
  const rows = await db.affiliateDocument.findMany({
    where: { affiliateId }, orderBy: { createdAt: 'desc' },
    select: { kind: true, mime: true, sizeBytes: true, createdAt: true },
  });
  const seen = new Set<string>();
  return rows.filter(r => !seen.has(r.kind) && !!seen.add(r.kind))
    .map(r => ({ kind: r.kind, mime: r.mime, sizeBytes: r.sizeBytes, createdAt: r.createdAt.toISOString() }));
}

/** ما ينقص ملفه — النوع والآيبان والهوية (+ السجل للشركة). B يستدعيها في مرشّحي التسوية */
export async function profileStatus(affiliateId: string, db: Db = prisma): Promise<{ complete: boolean; missing: ProfileMissing[] }> {
  const [u, docs] = await Promise.all([
    db.affiliateUser.findUnique({ where: { id: affiliateId }, select: { partnerType: true, ibanEnc: true } }),
    db.affiliateDocument.findMany({ where: { affiliateId }, select: { kind: true } }),
  ]);
  const missing = profileMissing({ partnerType: u?.partnerType, hasIban: !!u?.ibanEnc, docKinds: docs.map(d => d.kind) });
  return { complete: !!u && missing.length === 0, missing };
}

/**
 * يختم `profileCompletedAt` حين يكتمل الملف ويمسحه حين ينقص — ويُعيد الاكتمال. تحت قفل صفّ السفير: تغييران
 * متزامنان (رفع هويةٍ وحذفها) لا يتركان ختماً لا يطابق الحال. يُستدعى داخل معاملةٍ قائمة بتمرير `tx`.
 */
export async function refreshProfileCompletion(affiliateId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  if (!tx) return prisma.$transaction(t => refreshProfileCompletion(affiliateId, t));
  await lockAffiliate(tx, affiliateId);
  const st = await profileStatus(affiliateId, tx);
  const flip = st.complete
    ? await tx.affiliateUser.updateMany({ where: { id: affiliateId, profileCompletedAt: null }, data: { profileCompletedAt: new Date() } })
    : await tx.affiliateUser.updateMany({ where: { id: affiliateId, profileCompletedAt: { not: null } }, data: { profileCompletedAt: null } });
  if (flip.count === 1) {
    await logEvent(tx, {
      entity: 'user', entityId: affiliateId, action: st.complete ? 'profile_completed' : 'profile_incomplete',
      actorType: 'system', meta: { missing: st.missing },
    });
  }
  return st.complete;
}

/** يرفع مستنداً (مفحوصاً بـparseDocumentDataUrl) ويستبدل السابق من نوعه — ويحدّث اكتمال الملف في المعاملة نفسها */
export async function saveDocument(affiliateId: string, kind: DocKind, file: { mime: AffiliateDocMime; bytes: Buffer }): Promise<DocumentMeta> {
  const enc = encryptDocument(file.bytes, affiliateId);
  const sha256 = crypto.createHash('sha256').update(file.bytes).digest('hex');
  const row = await prisma.$transaction(async tx => {
    await lockAffiliate(tx, affiliateId);
    // البايتات تتبع المستند بالحذف المتتالي (onDelete: Cascade)
    const replaced = await tx.affiliateDocument.deleteMany({ where: { affiliateId, kind } });
    const doc = await tx.affiliateDocument.create({
      data: { affiliateId, kind, mime: file.mime, sizeBytes: file.bytes.length, sha256, blob: { create: { enc } } },
      select: { id: true, kind: true, mime: true, sizeBytes: true, createdAt: true },
    });
    await logEvent(tx, {
      entity: 'document', entityId: doc.id, action: replaced.count ? 'replaced' : 'uploaded',
      actorType: 'affiliate', actorId: affiliateId, meta: { kind, mime: file.mime, sizeBytes: file.bytes.length },
    });
    await refreshProfileCompletion(affiliateId, tx);
    return doc;
  }, { timeout: 20_000 });
  return { kind: row.kind, mime: row.mime, sizeBytes: row.sizeBytes, createdAt: row.createdAt.toISOString() };
}

/** حذفٌ حقيقيّ لمستند نوعٍ (والبايتات معه) — false إن لم يوجد */
export async function deleteDocument(affiliateId: string, kind: DocKind): Promise<boolean> {
  return prisma.$transaction(async tx => {
    await lockAffiliate(tx, affiliateId);
    const gone = await tx.affiliateDocument.deleteMany({ where: { affiliateId, kind } });
    if (!gone.count) return false;
    await logEvent(tx, { entity: 'document', entityId: affiliateId, action: 'deleted', actorType: 'affiliate', actorId: affiliateId, meta: { kind } });
    await refreshProfileCompletion(affiliateId, tx);
    return true;
  });
}

/**
 * المستند الساري من نوعه data URL للمعاينة — للسفير نفسه (البوابة) أو للمالك/الموظف بصلاحية `affiliates.iban`
 * (يسجّل المستدعي حدث `document_viewed`). null إن لم يوجد أو تعذّر فكّه.
 */
export async function documentDataUrl(affiliateId: string, kind: DocKind): Promise<string | null> {
  const doc = await prisma.affiliateDocument.findFirst({
    where: { affiliateId, kind }, orderBy: { createdAt: 'desc' },
    select: { id: true, mime: true, blob: { select: { enc: true } } },
  });
  if (!doc?.blob) return null;
  const plain = decryptDocument(doc.blob.enc, affiliateId);
  if (!plain) {
    console.error(`[affiliate] document ${doc.id} could not be decrypted`);
    return null;
  }
  return `data:${doc.mime};base64,${plain.toString('base64')}`;
}
