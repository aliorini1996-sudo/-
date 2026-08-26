/**
 * الفاتورة الضريبية التي تُصدرها **المنصّة** لمشتركها.
 *
 * مؤسسةٌ مسجَّلة في ضريبة القيمة المضافة ملزمة بإصدار فاتورة ضريبية عن كل بيع
 * خاضع — واشتراك المنصّة بيعٌ خاضع. كان النظام يُصدر فواتير ZATCA لعملاء
 * الشركات المشتركة ولا يُصدر عن مبيعاته هو ولا واحدة.
 *
 * البائع هنا نحن، والمشتري الشركة المشتركة — عكس بقيّة النظام تماماً، ولذلك
 * جدولٌ منفصل لا امتداد لجدول فواتير الشركات: خلطهما كان سيخلط وعاءين ضريبيين.
 */

import prisma from '../config/database';
import { zatcaQrBase64 } from '../compliance/zatca';
import { vatFromInclusive, round2 } from './finance';

/** بيانات البائع — المؤسسة نفسها، من البيئة كي لا تُدفن في الكود */
export function platformSeller(): { name: string; vatNumber: string; crNumber: string; address: string } {
  return {
    name: process.env.PLATFORM_SELLER_NAME || 'مؤسسة تكامل الميدان للتجارة',
    vatNumber: (process.env.PLATFORM_VAT_NUMBER || '').trim(),
    crNumber: process.env.PLATFORM_CR_NUMBER || '7040371671',
    address: process.env.PLATFORM_ADDRESS || 'الرياض — حي المنار — شارع الإمام أحمد بن حنبل',
  };
}

/** هل نستطيع إصدار فاتورة ضريبية؟ الرقم الضريبي شرطٌ لا يُتجاوَز */
export function invoicingReady(): boolean {
  return /^\d{15}$/.test(platformSeller().vatNumber);
}

/**
 * رقم تسلسلي ظاهر: FS-2026-0001.
 * يُشتقّ من عدّ فواتير السنة داخل معاملة الإنشاء نفسها، فلا رقمان متطابقان —
 * و`@unique` على العمود هو الحارس الأخير إن سبق طلبان بعضهما.
 */
async function nextNumber(year: number): Promise<string> {
  const n = await prisma.platformInvoice.count({
    where: { issuedAt: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) } },
  });
  return `FS-${year}-${String(n + 1).padStart(4, '0')}`;
}

export interface IssueResult {
  ok: boolean;
  reason?: string;
  invoiceId?: string;
  number?: string;
}

/**
 * يُصدر فاتورة ضريبية عن دفعة اشتراك مؤكَّدة — مرّة واحدة لكل دفعة.
 *
 * لا يرمي عند الفشل: الإصدار أثرٌ لاحق للدفع، وإسقاطُ معاملةِ الدفع بسببه كان
 * سيُرجِع الرابط «غير مدفوع» فيُعاد تحصيله. الفشل يُسجَّل ويُعاد لاحقاً.
 */
export async function issueForPayment(paymentLinkId: string): Promise<IssueResult> {
  const seller = platformSeller();
  if (!invoicingReady()) {
    return { ok: false, reason: 'PLATFORM_VAT_NUMBER غير مضبوط (١٥ رقماً) — لا تُصدَر فاتورة بلا رقم ضريبي' };
  }

  const existing = await prisma.platformInvoice.findUnique({ where: { paymentLinkId }, select: { id: true, number: true } });
  if (existing) return { ok: true, invoiceId: existing.id, number: existing.number };

  const link = await prisma.paymentLink.findUnique({
    where: { id: paymentLinkId },
    select: { id: true, status: true, tenantId: true, description: true, amountHalalas: true, paidAt: true },
  });
  if (!link) return { ok: false, reason: 'رابط غير معروف' };
  if (link.status !== 'paid') return { ok: false, reason: `الدفعة ليست مدفوعة (${link.status})` };

  let buyerName = 'عميل غير مرتبط بشركة';
  let buyerVatNo: string | null = null;
  if (link.tenantId) {
    const t = await prisma.tenant.findUnique({
      where: { id: link.tenantId },
      select: { name: true, settings: { select: { taxNumber: true } } },
    });
    if (t) {
      buyerName = t.name;
      buyerVatNo = t.settings?.taxNumber || null;
    }
  }

  const totalSar = round2(link.amountHalalas / 100);
  const vatSar = vatFromInclusive(totalSar);      // أسعارنا شاملة الضريبة
  const netSar = round2(totalSar - vatSar);
  const issuedAt = link.paidAt ?? new Date();

  const qrBase64 = zatcaQrBase64({
    sellerName: seller.name,
    vatNumber: seller.vatNumber,
    timestampIso: issuedAt.toISOString(),
    total: totalSar.toFixed(2),
    vatTotal: vatSar.toFixed(2),
  });

  try {
    const row = await prisma.platformInvoice.create({
      data: {
        number: await nextNumber(issuedAt.getUTCFullYear()),
        paymentLinkId: link.id,
        tenantId: link.tenantId,
        buyerName, buyerVatNo,
        description: link.description,
        totalSar, vatSar, netSar,
        qrBase64, issuedAt,
      },
      select: { id: true, number: true },
    });
    return { ok: true, invoiceId: row.id, number: row.number };
  } catch (e) {
    // تسابق على نفس الدفعة: `@unique` منع الازدواج — أعِد القائمة لا خطأً
    const dup = await prisma.platformInvoice.findUnique({ where: { paymentLinkId }, select: { id: true, number: true } });
    if (dup) return { ok: true, invoiceId: dup.id, number: dup.number };
    return { ok: false, reason: (e as Error).message };
  }
}

/**
 * يعالج كل دفعة مؤكَّدة بلا فاتورة — شبكة أمان تلتقط ما فات عند تعطّل الإصدار
 * اللحظي أو ما دُفع قبل تفعيل الرقم الضريبي.
 */
export async function backfillInvoices(limit = 50): Promise<{ issued: number; skipped: number; reason?: string }> {
  if (!invoicingReady()) return { issued: 0, skipped: 0, reason: 'PLATFORM_VAT_NUMBER غير مضبوط' };
  const done = await prisma.platformInvoice.findMany({ select: { paymentLinkId: true } });
  const has = new Set(done.map((d) => d.paymentLinkId));
  const paid = await prisma.paymentLink.findMany({
    where: { status: 'paid' },
    orderBy: { paidAt: 'asc' },   // بالترتيب الزمني كي يتسلسل الترقيم منطقياً
    select: { id: true },
  });
  let issued = 0, skipped = 0;
  for (const p of paid.filter((x) => !has.has(x.id)).slice(0, limit)) {
    const r = await issueForPayment(p.id);
    if (r.ok) issued++; else skipped++;
  }
  return { issued, skipped };
}
