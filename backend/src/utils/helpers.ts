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
// (يتفادى التصادم بعد إعادة تشغيل الخادم، بخلاف عدّاد الذاكرة).
//
// ⚠️ البادئة تُشتقّ من **تاريخ المستند** لا من وقت الرفع: فاتورة أُنشئت أوف-لاين في يوليو
// وطُبع QR لها ثم رُفعت في أغسطس يجب أن تأخذ تسلسل يوليو (INV-YYMM بشهر البيع) — وإلا
// انكسر تسلسل الفترة القانوني (ZATCA/ETA يشترطان تسلسلاً متّصلاً لكل فترة). الافتراضي «الآن».
function prefixFor(kind: 'INV' | 'RCP' | 'RET', date: Date = new Date()): string {
  const yy = date.getFullYear().toString().slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
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

export async function generateInvoiceNumber(tenantId: string, date?: Date): Promise<string> {
  return nextInvoiceLike(tenantId, prefixFor('INV', date));
}

export async function generateReturnNumber(tenantId: string, date?: Date): Promise<string> {
  return nextInvoiceLike(tenantId, prefixFor('RET', date));
}

export async function generateReceiptNumber(tenantId: string, date?: Date): Promise<string> {
  const prefix = prefixFor('RCP', date);
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

// يعيد تنفيذ إنشاء مستند مرقّم عند تصادم الرقم الفريد (P2002 على tenantId+number).
// تحت التزامن قد يولّد طلبان نفس الرقم قبل أول إدراج؛ unique يحمي من التكرار،
// وهنا نعيد توليد الرقم ونحاول مجدداً بدل إفشال الطلب.
export async function withNumberRetry<T>(create: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await create();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      const target = String((err as { meta?: { target?: unknown } })?.meta?.target ?? '');
      if (code === 'P2002' && target.includes('number')) { lastErr = err; continue; }
      throw err;
    }
  }
  throw lastErr;
}
