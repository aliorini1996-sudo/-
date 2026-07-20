import bcrypt from 'bcryptjs';
import prisma from '../../config/database';
import { computeInvoice } from '../../lib/tax';
import { generateInvoiceNumber, withNumberRetry, roundDecimal } from '../../utils/helpers';

// ============================================================================
// خدمة الدفع للمطاعم — تبني فاتورة CASH من طلب مدفوع مباشرةً (لا تمرّ بمسار invoices.ts).
// تعيد استخدام محرّك الضريبة (lib/tax) وترقيم الفاتورة فقط. كل الكتابة ذرّية داخل معاملة
// واحدة: المطالبة الذرّية بالطلب + الفاتورة + الدفعات + تحرير الطاولة معاً أو لا شيء.
// ============================================================================

export interface PaymentInput { method?: string; amount?: number; tendered?: number | null; }

// عميل نقدي وكاشير افتراضي لكل مطعم (يلبّيان FK الفاتورة). upsert يعالج سباق أول دفعتين
// متزامنتين لمطعم جديد (بدل findFirst+create الذي يرمي P2002).
async function ensureRestaurantDefaults(tid: string): Promise<{ customerId: string; salesRepId: string }> {
  const customer = await prisma.customer.upsert({
    where: { tenantId_code: { tenantId: tid, code: 'WALK-IN' } },
    create: { tenantId: tid, code: 'WALK-IN', name: 'عميل نقدي', phone: '' } as any,
    update: {},
    select: { id: true },
  });
  const username = `resto-cashier-${tid}`;
  let rep = await prisma.salesRep.findUnique({ where: { username }, select: { id: true } });
  if (!rep) {
    const passwordHash = await bcrypt.hash(`disabled-${tid}-${Date.now()}`, 10);
    rep = await prisma.salesRep.upsert({
      where: { username },
      create: { tenantId: tid, name: 'الكاشير', phone: '', username, passwordHash } as any,
      update: {},
      select: { id: true },
    });
  }
  return { customerId: customer.id, salesRepId: rep.id };
}

// ينشئ فاتورة CASH من طلب مفتوح ويسجّل دفعاته ويحرّر طاولته — كل ذلك ذرّياً.
export async function checkoutOrder(tid: string, orderId: string, payments: PaymentInput[]): Promise<{ invoiceId: string; number: string; total: number }> {
  const settings = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
  const defaultTaxPct = settings?.defaultVatPct ?? 15;
  const { customerId, salesRepId } = await ensureRestaurantDefaults(tid);

  const out = await withNumberRetry(async () => {
    const number = await generateInvoiceNumber(tid);
    return prisma.$transaction(async tx => {
      // مطالبة ذرّية: من يحوّل الطلب من OPEN(بلا فاتورة) إلى PAID أوّلاً يفوز؛ الثاني يفشل.
      const claim = await tx.order.updateMany({
        where: { id: orderId, tenantId: tid, status: 'OPEN', invoiceId: null },
        data: { status: 'PAID' },
      });
      if (claim.count !== 1) throw Object.assign(new Error('الطلب غير مفتوح أو مدفوع مسبقاً'), { status: 409 });

      const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
      if (!order || order.items.length === 0) throw Object.assign(new Error('الطلب فارغ'), { status: 400 });

      const totals = computeInvoice(
        order.items.map(it => ({ qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct })),
        { defaultTaxPct }
      );
      const service = order.serviceChargeAmt || 0;
      const discount = order.discountAmt || 0;
      const invoiceTotal = roundDecimal(totals.subtotal + totals.totalTax + service - discount, 2);

      const inv = await tx.invoice.create({
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
        where: { id: orderId },
        data: { invoiceId: inv.id, subtotal: totals.subtotal, taxAmt: totals.totalTax, total: invoiceTotal },
      });
      if (payments.length) {
        await tx.orderPayment.createMany({
          data: payments.map(p => ({
            orderId, method: p.method ?? 'CASH', amount: p.amount ?? 0,
            tendered: p.tendered ?? null,
            changeGiven: p.method === 'CASH' && p.tendered != null ? roundDecimal(Math.max(0, p.tendered - (p.amount ?? 0)), 2) : null,
          })),
        });
      }
      if (order.tableId) await tx.restaurantTable.update({ where: { id: order.tableId }, data: { status: 'FREE' } });
      return { id: inv.id, number: inv.number, total: invoiceTotal };
    });
  });

  return { invoiceId: out.id, number: out.number, total: out.total };
}
