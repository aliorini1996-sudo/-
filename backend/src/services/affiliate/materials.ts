/**
 * مكتبة المواد التسويقية للسفراء (V2_SPEC §3 و§6.2 و§11): يرفعها المالك — صورةٌ أو فيديو قصير أو مستند
 * (ملفٌّ ≤ ٨ ميغابايت)، أو رابطٌ (فيديو طويل أو صفحة)، أو نصٌّ جاهز للنسخ — والسفير يقرؤها من البوابة.
 *
 * الخادم هو الحَكَم في الملف: النوع من **البايتات الأولى** لا من بادئة data URL ولا من الاسم (SVG
 * وHTML خارجها — يحملان سكربتاً)، والحجم من البايتات بعد فكّ base64، والاسم يُنظَّف من محارف التحكّم
 * والاتجاه وينتهي بامتداد النوع المفحوص. الملف في جدولٍ منفصل (`AffiliateMaterialBlob`) فالقائمة خفيفة.
 */
import prisma from '../../config/database';
import { logEvent, PlatformActor } from './core';
import { LedgerError } from './ledger';

export const MATERIAL_CATEGORIES = ['image', 'video', 'document', 'text', 'link'] as const;
export type MaterialCategory = typeof MATERIAL_CATEGORIES[number];
export const isMaterialCategory = (c: unknown): c is MaterialCategory => typeof c === 'string' && (MATERIAL_CATEGORIES as readonly string[]).includes(c);

const MB = 1024 * 1024;
/** سقف الملف بعد فكّ base64 (V2_SPEC §6.2) */
export const MATERIAL_MAX_BYTES = 8 * MB;
/** سقوف المكتبة كلّها — قرص القاعدة محدود، والملفات تُخزَّن فيها */
export const MATERIAL_MAX_COUNT = 200;
export const MATERIAL_MAX_TOTAL_BYTES = 200 * MB;
const MIN_BYTES = 32;
const NAME_MAX = 120;

/** الأنواع المقبولة لكلّ فئة ملف وامتداداتها */
const MIME_CATEGORY: Record<string, { category: 'image' | 'video' | 'document'; ext: string }> = {
  'image/jpeg': { category: 'image', ext: 'jpg' },
  'image/png': { category: 'image', ext: 'png' },
  'image/webp': { category: 'image', ext: 'webp' },
  'image/gif': { category: 'image', ext: 'gif' },
  'video/mp4': { category: 'video', ext: 'mp4' },
  'video/quicktime': { category: 'video', ext: 'mov' },
  'video/webm': { category: 'video', ext: 'webm' },
  'application/pdf': { category: 'document', ext: 'pdf' },
};

/** نوع الملف من بايتاته الأولى — JPEG/PNG/WEBP/GIF/PDF، وMP4/MOV بصندوق ftyp، وWEBM بتوقيع EBML */
export function sniffMaterialMime(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.length >= 6 && /^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return 'image/gif';
  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') return head.toString('latin1', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'video/webm';
  return null;
}

/**
 * data URL ⇒ البايتات ونوعها المفحوص، أو سبب الرفض بالعربية. البادئة تُعلن فئةً والبايتات تشهد لها:
 * PDF بادئته image/png يُرفض، والفئة المطلوبة يجب أن تطابق فئة النوع المفحوص.
 */
export function parseMaterialData(raw: unknown, category: MaterialCategory): { ok: true; mime: string; bytes: Buffer } | { ok: false; reason: string } {
  const data = typeof raw === 'string' ? raw.trim() : '';
  if (!data) return { ok: false, reason: 'الملف فارغ' };
  // أطول نصٍّ ممكن لأكبر ملف — يُرفض ما فوقه قبل أيّ فحصٍ على نصٍّ ضخم
  if (data.length > 64 + Math.ceil(MATERIAL_MAX_BYTES / 3) * 4) return { ok: false, reason: 'حجم الملف أكبر من ٨ ميغابايت' };
  const comma = data.indexOf(',');
  const head = comma > 0 ? data.slice(0, comma) : '';
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64$/i.exec(head);
  if (!m) return { ok: false, reason: 'صيغة الملف غير صالحة' };
  const declared = MIME_CATEGORY[m[1].toLowerCase()];
  if (!declared) return { ok: false, reason: 'نوع الملف غير مدعوم — صورة (JPEG/PNG/WebP/GIF) أو فيديو (MP4/MOV/WebM) أو PDF' };
  const b64 = data.slice(comma + 1);
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { ok: false, reason: 'الملف تالف' };
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length < MIN_BYTES) return { ok: false, reason: 'الملف تالف أو فارغ' };
  if (bytes.length > MATERIAL_MAX_BYTES) return { ok: false, reason: 'حجم الملف أكبر من ٨ ميغابايت' };
  const sniffed = sniffMaterialMime(bytes.subarray(0, 16));
  if (!sniffed || MIME_CATEGORY[sniffed].category !== declared.category) return { ok: false, reason: 'محتوى الملف لا يطابق نوعه' };
  if (MIME_CATEGORY[sniffed].category !== category) return { ok: false, reason: 'نوع الملف لا يطابق الفئة المختارة' };
  return { ok: true, mime: sniffed, bytes };
}

/** اسم الملف للحفظ والعرض: بلا محارف تحكّم واتجاه وفواصل مسار، وبامتداد نوعه المفحوص لا بما كتبه المُرسِل */
export function materialFileName(raw: unknown, mime: string, title: string): string {
  const ext = MIME_CATEGORY[mime]?.ext ?? 'bin';
  const clean = (typeof raw === 'string' ? raw : '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stem = (clean.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || title.trim() || 'material').slice(0, NAME_MAX - ext.length - 1).trim();
  return `${stem}.${ext}`;
}

/** شكل المادّة في البوابة والقائمة (V2_SPEC §6.1) */
export interface MaterialRow {
  id: string; title: string; category: string; fileName: string | null; mime: string | null; sizeBytes: number | null;
  url: string | null; textBody: string | null; createdAt: Date;
}

const ROW_SELECT = { id: true, title: true, category: true, fileName: true, mime: true, sizeBytes: true, url: true, textBody: true, createdAt: true } as const;

/** القائمة بترتيب المالك ثمّ الأحدث — للسفير والمالك */
export async function listMaterials(): Promise<MaterialRow[]> {
  return prisma.affiliateMaterial.findMany({ select: ROW_SELECT, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], take: MATERIAL_MAX_COUNT });
}

/** قائمة المالك: كالبوابة + الترتيب ومن رفعها */
export async function listMaterialsForOwner() {
  return prisma.affiliateMaterial.findMany({
    select: { ...ROW_SELECT, sortOrder: true, createdBy: true }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], take: MATERIAL_MAX_COUNT,
  });
}

/** ملف المادّة بصيغة data URL — `null` لمادّةٍ بلا ملف (رابط أو نصّ) أو غير موجودة */
export async function materialFile(id: string): Promise<{ dataUrl: string } | null> {
  const m = await prisma.affiliateMaterial.findUnique({ where: { id }, select: { mime: true, blob: { select: { bytes: true } } } });
  if (!m?.mime || !m.blob) return null;
  return { dataUrl: `data:${m.mime};base64,${Buffer.from(m.blob.bytes).toString('base64')}` };
}

export interface MaterialInput {
  title: string;
  category: MaterialCategory;
  dataUrl?: string | null;
  fileName?: string | null;
  url?: string | null;
  textBody?: string | null;
  sortOrder?: number | null;
}

const URL_RE = /^https?:\/\/[^\s<>"']{3,}$/i;

/**
 * إضافة مادّة: الصورة والمستند ملفٌّ إلزاماً، والفيديو ملفٌّ قصير أو رابط، والرابط رابطٌ إلزاماً، والنصّ
 * نصٌّ إلزاماً. نصٌّ جاهزٌ مرافق (تعليق المنشور) مسموحٌ مع أيّ فئة. الأخطاء LedgerError 400/409.
 */
export async function createMaterial(input: MaterialInput, by: PlatformActor): Promise<MaterialRow> {
  const title = (input.title ?? '').trim();
  if (title.length < 2 || title.length > 120) throw new LedgerError(400, 'العنوان من ٢ إلى ١٢٠ حرفاً');
  if (!isMaterialCategory(input.category)) throw new LedgerError(400, 'فئةٌ غير معروفة');
  const cat = input.category;
  const url = (input.url ?? '').trim() || null;
  const textBody = (input.textBody ?? '').trim() || null;
  const dataUrl = (input.dataUrl ?? '').trim() || null;
  if (url && (url.length > 500 || !URL_RE.test(url))) throw new LedgerError(400, 'الرابط يبدأ بـ https:// وطوله حتى ٥٠٠ حرف');
  if (textBody && textBody.length > 4000) throw new LedgerError(400, 'النصّ حتى ٤٠٠٠ حرف');
  if (cat === 'text' && !textBody) throw new LedgerError(400, 'اكتب النصّ الجاهز');
  if (cat === 'link' && !url) throw new LedgerError(400, 'أدخل الرابط');
  if ((cat === 'text' || cat === 'link') && dataUrl) throw new LedgerError(400, 'هذه الفئة بلا ملف');
  if (url && cat !== 'link' && cat !== 'video') throw new LedgerError(400, 'الرابط لفئة «رابط» أو «فيديو» فقط');
  if ((cat === 'image' || cat === 'document') && !dataUrl) throw new LedgerError(400, 'أرفق الملف');
  if (cat === 'video' && !dataUrl === !url) throw new LedgerError(400, 'الفيديو ملفٌّ قصير أو رابط — واحدٌ منهما');

  let file: { mime: string; bytes: Buffer; fileName: string } | null = null;
  if (dataUrl) {
    const p = parseMaterialData(dataUrl, cat);
    if (!p.ok) throw new LedgerError(400, p.reason);
    file = { mime: p.mime, bytes: p.bytes, fileName: materialFileName(input.fileName, p.mime, title) };
  }
  const sortOrder = Number.isInteger(input.sortOrder) ? Math.max(0, Math.min(10_000, input.sortOrder as number)) : 0;

  const [count, total] = await Promise.all([
    prisma.affiliateMaterial.count(),
    prisma.affiliateMaterial.aggregate({ _sum: { sizeBytes: true } }),
  ]);
  if (count >= MATERIAL_MAX_COUNT) throw new LedgerError(409, `المكتبة بلغت ${MATERIAL_MAX_COUNT} مادّة — احذف القديم أولاً`, 'materials_quota');
  if (file && (total._sum.sizeBytes ?? 0) + file.bytes.length > MATERIAL_MAX_TOTAL_BYTES) {
    throw new LedgerError(409, 'مساحة المكتبة ممتلئة — احذف ملفاتٍ قديمة أولاً', 'materials_quota');
  }

  const row = await prisma.$transaction(async tx => {
    const m = await tx.affiliateMaterial.create({
      data: {
        title, category: cat, url, textBody, sortOrder, createdBy: by.actorId,
        ...(file ? { fileName: file.fileName, mime: file.mime, sizeBytes: file.bytes.length, blob: { create: { bytes: file.bytes } } } : {}),
      },
      select: ROW_SELECT,
    });
    await logEvent(tx, { entity: 'settings', entityId: m.id, action: 'material_created', actorType: by.actorType, actorId: by.actorId, meta: { title, category: cat, sizeBytes: file?.bytes.length ?? null } });
    return m;
  });
  return row;
}

/** حذفٌ حقيقيّ (الملف معه بالتتابع) */
export async function deleteMaterial(id: string, by: PlatformActor): Promise<void> {
  await prisma.$transaction(async tx => {
    const m = await tx.affiliateMaterial.findUnique({ where: { id }, select: { title: true, category: true } });
    if (!m) throw new LedgerError(404, 'المادّة غير موجودة');
    await tx.affiliateMaterial.delete({ where: { id } });
    await logEvent(tx, { entity: 'settings', entityId: id, action: 'material_deleted', actorType: by.actorType, actorId: by.actorId, meta: { title: m.title, category: m.category } });
  });
}
