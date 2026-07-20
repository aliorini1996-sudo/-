import bcrypt from 'bcryptjs';
import prisma from '../../config/database';
import { computeInvoice } from '../../lib/tax';
import { generateInvoiceNumber, withNumberRetry, roundDecimal } from '../../utils/helpers';

// ============================================================================
// خدمة الدفع للمطاعم — تبني فاتورة CASH من طلب مدفوع مباشرةً (لا تمرّ بمسار invoices.ts
// الذي يتحقّق من productId كـProduct نشط ويمسّ مخزون السيارة). تعيد استخدام محرّك الضريبة
// (lib/tax) وترقيم الفاتورة (generateInvoiceNumber/withNumberRetry) فقط.
// ============================================================================

// عميل نقدي وكاشير افتراضي لكل مطعم — يلبّيان قيدَي FK الإلزاميين على الفاتورة
// (customerId + salesRepId) دون تعديل مخطّط جدول الفواتير المشترك. الكاشير = SalesRep (القرار).
async function ensureRestaurantDefaults(tid: string): Promise<{ customerId: string; salesRepId: string }> {
  let customer = await prisma.customer.findFirst({ where: { tenantId: tid, code: 'WALK-IN' }, select: { id: true } });
  if (!customer) {
    customer = await prisma.customer.create({
      data: { tenantId: tid, code: 'WALK-IN', name: 'عميل نقدي', phone: '' } as any,
      select: { id: true },
    });
  }
  const username = `resto-cashier-${tid}`;
  let rep = await prisma.salesRep.findUnique({ where: { username }, select: { id: true } });
  if (!rep) {
    const passwordHash = await bcrypt.hash(`disabled-${tid}-${Date.now()}`, 10);
    rep = await prisma.salesRep.create({
      data: { tenantId: tid, name: 'الكاشير', phone: '', username, passwordHash } as any,
      select: { id: true },
    });
  }
  return { customerId: customer.id, salesRepId: rep.id };
}

// ينشئ فاتورة CASH من طلب مفتوح (يُستدعى بعد تسجيل الدفع)، ويربط الطلب بها ويحرّر طاولته.
export async function checkoutOrder(tid: string, orderId: string): Promise<{ invoiceId: string; number: string; total: number }> {
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId: tid }, include: { items: true } });
  if (!order) throw Object.assign(new Error('الطلب غير موجود'), { status: 404 });
  if (order.status !== 'OPEN') throw Object.assign(new Error('الطلب غير مفتوح'), { status: 400 });
  if (order.items.length === 0) throw Object.assign(new Error('الطلب فارغ'), { status: 400 });
  if (order.invoiceId) throw Object.assign(new Error('للطلب فاتورة مسبقاً'), { status: 409 });

  const settings = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
  const defaultTaxPct = settings?.defaultVatPct ?? 15;
  const { customerId, salesRepId } = await ensureRestaurantDefaults(tid);

  // الضريبة على الصافي (unitPrice شامل الإضافات، تُضاف الضريبة فوقه) — نفس منطق فواتير التوزيع
  const totals = computeInvoice(
    order.items.map(it => ({ qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct })),
    { defaultTaxPct }
  );
  const service = order.serviceChargeAmt || 0;
  const discount = order.discountAmt || 0;
  // الإكرامية (tipAmt) لا تدخل قيمة الفاتورة الضريبية (ليست إيراداً)
  const invoiceTotal = roundDecimal(totals.subtotal + totals.totalTax + service - discount, 2);

  const inv = await withNumberRetry(async () => {
    const number = await generateInvoiceNumber(tid);
    return prisma.$transaction(async tx => {
      const created = await tx.invoice.create({
        data: {
          tenantId: tid, number, customerId, salesRepId,
          type: 'CASH', status: 'CONFIRMED', orderType: order.channel,
          serviceChargeAmt: service, tipAmt: order.tipAmt || 0,
          subtotal: totals.subtotal, discountAmt: discount, taxAmt: totals.totalTax,
          total: invoiceTotal, paidAmt: invoiceTotal, remainingAmt: 0,
          items: {
            create: order.items.map((it, i) => ({
              menuItemId: it.menuItemId, orderItemId: it.id, unitCost: it.unitCost,
              qty: it.qty, unitPrice: it.unitPrice,
              taxPct: totals.lines[i].taxPct, taxAmt: totals.lines[i].tax, lineTotal: totals.lines[i].gross,
            })),
          },
        } as any,
      });
      await tx.order.update({
        where: { id: order.id },
        data: { invoiceId: created.id, status: 'PAID', subtotal: totals.subtotal, taxAmt: totals.totalTax, total: invoiceTotal },
      });
      if (order.tableId) await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'FREE' } });
      return created;
    });
  });

  return { invoiceId: inv.id, number: inv.number, total: invoiceTotal };
}
