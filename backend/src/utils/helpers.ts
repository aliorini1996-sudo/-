import prisma from '../config/database';

export function paginate(page: number, limit: number) {
  const skip = (page - 1) * limit;
  return { skip, take: limit };
}

export function paginationMeta(total: number, page: number, limit: number) {
  return {
    total,
    page,
    limit,
    pages: Math.ceil(total / limit),
  };
}

// يُولّد رقماً تسلسلياً اعتماداً على أعلى رقم موجود فعلاً في قاعدة البيانات
// (يتفادى التصادم بعد إعادة تشغيل الخادم، بخلاف عدّاد الذاكرة)
function prefixFor(kind: 'INV' | 'RCP' | 'RET'): string {
  const now = new Date();
  const yy = now.getFullYear().toString().slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${kind}-${yy}${mm}-`;
}

// الترقيم لكل شركة منفصل — يُفلتر بـ tenantId
async function nextInvoiceLike(tenantId: string, prefix: string): Promise<string> {
  const last = await prisma.invoice.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const lastSeq = last ? parseInt(last.number.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(lastSeq + 1).padStart(6, '0');
}

export async function generateInvoiceNumber(tenantId: string): Promise<string> {
  return nextInvoiceLike(tenantId, prefixFor('INV'));
}

export async function generateReturnNumber(tenantId: string): Promise<string> {
  return nextInvoiceLike(tenantId, prefixFor('RET'));
}

export async function generateReceiptNumber(tenantId: string): Promise<string> {
  const prefix = prefixFor('RCP');
  const last = await prisma.receipt.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const lastSeq = last ? parseInt(last.number.slice(prefix.length), 10) || 0 : 0;
  return prefix + String(lastSeq + 1).padStart(6, '0');
}

export function roundDecimal(value: number, decimals = 2): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}
