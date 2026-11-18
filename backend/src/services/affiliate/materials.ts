/**
 * مكتبة المواد التسويقية (V2_SPEC §6 و§11) — **هذا الملف ملك الوكيل B**.
 *
 * أنشأه الوكيل A بالتوقيعين اللذين تقرؤهما البوابة (listMaterials وmaterialFile) بتنفيذٍ مبدئيّ على المخطّط المقفل —
 * وفي الدمج يبقى تنفيذ B الأصلي (مع رفع المالك وحذفه). البايتات في جدولٍ منفصل لا تُقرأ في القائمة.
 */
import prisma from '../../config/database';

export interface MaterialRow {
  id: string;
  title: string;
  category: string;            // image|video|document|text|link
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  url: string | null;
  textBody: string | null;
  createdAt: Date;
}

export async function listMaterials(): Promise<MaterialRow[]> {
  return prisma.affiliateMaterial.findMany({
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }], take: 500,
    select: { id: true, title: true, category: true, fileName: true, mime: true, sizeBytes: true, url: true, textBody: true, createdAt: true },
  });
}

export async function materialFile(id: string): Promise<{ dataUrl: string } | null> {
  const m = await prisma.affiliateMaterial.findUnique({ where: { id }, select: { mime: true, blob: { select: { bytes: true } } } });
  if (!m?.mime || !m.blob) return null;
  return { dataUrl: `data:${m.mime};base64,${Buffer.from(m.blob.bytes).toString('base64')}` };
}
