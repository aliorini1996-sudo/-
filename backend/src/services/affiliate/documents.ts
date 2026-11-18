/**
 * مستندات ملف السفير (V2_SPEC §1.7 و§3 و§11) — **ملف الوكيل A**.
 *
 * هذه نسخةٌ مبدئية كتبها الوكيل B بالتوقيعين اللذين يستدعيهما وحدهما (§11: «كلٌّ منهما يُنشئ ملفّه
 * بالتوقيع أعلاه أولاً ولو بتنفيذٍ مبدئي»): `profileStatus` لمرشّحي التسوية و`documentDataUrl` لعرض
 * المالك. **في الدمج يبقى تنفيذ الوكيل A كاملاً** (الرفع والاستبدال والحذف و`refreshProfileCompletion`).
 *
 * التشفير: AES-256-GCM، والصفّ `iv(12) + tag(16) + cipher` كما في المخطّط، والمفتاح `AFFILIATE_DOC_KEY`
 * (hex أو base64 بطول ٣٢ بايتاً) أو مشتقٌّ من سرّ السفير `::doc`.
 */
import crypto from 'crypto';
import prisma from '../../config/database';
import { affiliateSecret } from './core';

export const DOC_KINDS = ['national_id', 'commercial_reg'] as const;
export type DocKind = typeof DOC_KINDS[number];
export const isDocKind = (k: unknown): k is DocKind => typeof k === 'string' && (DOC_KINDS as readonly string[]).includes(k);

function docKey(): Buffer {
  const raw = process.env.AFFILIATE_DOC_KEY;
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (k.length === 32) return k;
  }
  return crypto.createHash('sha256').update(`${affiliateSecret()}::doc`).digest();
}

/** اكتمال الملف: النوع + الآيبان + الهوية (+ السجل التجاري للشركة) — شرط دخول دورة التسوية */
export async function profileStatus(affiliateId: string): Promise<{ complete: boolean; missing: string[] }> {
  const u = await prisma.affiliateUser.findUnique({ where: { id: affiliateId }, select: { partnerType: true, ibanEnc: true } });
  if (!u) return { complete: false, missing: ['partnerType', 'iban', 'national_id'] };
  const kinds = new Set((await prisma.affiliateDocument.findMany({ where: { affiliateId }, select: { kind: true } })).map(d => d.kind));
  const missing: string[] = [];
  if (!u.partnerType) missing.push('partnerType');
  if (!u.ibanEnc) missing.push('iban');
  if (!kinds.has('national_id')) missing.push('national_id');
  if (u.partnerType === 'company' && !kinds.has('commercial_reg')) missing.push('commercial_reg');
  return { complete: missing.length === 0, missing };
}

/** المستند مفكوكاً بصيغة data URL — للسفير نفسه وللمالك/الموظف بصلاحية affiliates.iban (المسار يسجّل الحدث) */
export async function documentDataUrl(affiliateId: string, kind: DocKind): Promise<string | null> {
  const doc = await prisma.affiliateDocument.findFirst({
    where: { affiliateId, kind }, orderBy: { createdAt: 'desc' }, include: { blob: true },
  });
  if (!doc?.blob) return null;
  try {
    const enc = Buffer.from(doc.blob.enc);
    const d = crypto.createDecipheriv('aes-256-gcm', docKey(), enc.subarray(0, 12));
    d.setAuthTag(enc.subarray(12, 28));
    const plain = Buffer.concat([d.update(enc.subarray(28)), d.final()]);
    return `data:${doc.mime};base64,${plain.toString('base64')}`;
  } catch {
    return null;
  }
}
