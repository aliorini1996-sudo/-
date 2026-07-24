import bcrypt from 'bcryptjs';
import prisma from '../../config/database';
import { computeInvoice } from '../../lib/tax';
import { generateInvoiceNumber, withNumberRetry, roundDecimal } from '../../utils/helpers';
import { getComplianceProvider } from '../../compliance/provider';

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
export interface CheckoutResult {
  invoiceId: string; number: string; total: number; subtotal: number; taxAmt: number;
  qr?: string; einvoiceStatus?: string; issuedAt: string;
}

export async function checkoutOrder(tid: string, orderId: string, payments: PaymentInput[]): Promise<CheckoutResult> {
  const settings = await prisma.companySettings.findUnique({
    where: { tenantId: tid },
    select: { defaultVatPct: true, name: true, taxNumber: true, einvoiceProvider: true, currency: true },
  });
  const defaultTaxPct = settings?.defaultVatPct ?? 15;
  const { customerId, salesRepId } = await ensureRestaurantDefaults(tid);
  const cashTotal = roundDecimal(payments.filter(p => p.method === 'CASH').reduce((s, p) => s + (p.amount ?? 0), 0), 2);

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
      // الوردية المفتوحة (إن وُجدت) — تُربط بها الفاتورة ويُسجَّل نقدها لتسوية الدرج
      const shift = await tx.posShift.findFirst({ where: { tenantId: tid, status: 'OPEN' }, select: { id: true } });

      // الوصفات (M6) — لحساب التكلفة الفعلية وخصم المخزون تلقائياً
      const menuIds = [...new Set(order.items.map(i => i.menuItemId).filter((x): x is string => !!x))];
      const recipes = menuIds.length
        ? await tx.recipeItem.findMany({
            where: { tenantId: tid, menuItemId: { in: menuIds } },
            include: { ingredient: { select: { id: true, avgCost: true } } },
          })
        : [];
      const byMenu = new Map<string, { ingredientId: string; qty: number; avgCost: number }[]>();
      for (const r of recipes) {
        const arr = byMenu.get(r.menuItemId) ?? [];
        arr.push({ ingredientId: r.ingredientId, qty: r.qty, avgCost: Number(r.ingredient.avgCost) });
        byMenu.set(r.menuItemId, arr);
      }
      // تكلفة الوحدة من الوصفة (تُفضَّل على costPrice المُجمّد عند وجود وصفة)
      const recipeCost = (menuItemId?: string | null): number | null => {
        const rs = menuItemId ? byMenu.get(menuItemId) : undefined;
        if (!rs || rs.length === 0) return null;
        return roundDecimal(rs.reduce((s, r) => s + r.qty * r.avgCost, 0), 4);
      };

      const totals = computeInvoice(
        order.items.map(it => ({ qty: it.qty, unitPrice: it.unitPrice, taxPct: it.taxPct })),
        { defaultTaxPct }
      );
      const service = order.serviceChargeAmt || 0;
      const discount = order.discountAmt || 0;
      const invoiceTotal = roundDecimal(totals.subtotal + totals.totalTax + service - discount, 2);
      const issuedAt = new Date();

      // الفوترة الإلكترونية المعتمدة — يُبنى رمز QR حسب مزوّد دولة المطعم (ZATCA للسعودية فعلياً).
      // نقيّ (لا يمسّ القاعدة) وآمن الفشل: تعذّر البناء لا يُفشل الفاتورة.
      let einvoiceProvider = settings?.einvoiceProvider ?? 'none';
      let einvoiceStatus: string | undefined;
      let einvoiceQr: string | undefined;
      try {
        const r = await getComplianceProvider(settings?.einvoiceProvider).build({
          seller: { name: settings?.name || 'مطعم', taxNumber: settings?.taxNumber || '' },
          issuedAt, total: invoiceTotal, vatTotal: totals.totalTax,
          currency: settings?.currency || 'SAR', invoiceNumber: number,
        });
        einvoiceProvider = r.provider; einvoiceStatus = r.status; einvoiceQr = r.qr;
      } catch { /* تجاهل — الفاتورة تصدر بلا حمولة إن تعذّر البناء */ }

      const inv = await tx.invoice.create({
        data: {
          tenantId: tid, number, customerId, salesRepId,
          type: 'CASH', status: 'CONFIRMED', orderType: order.channel,
          serviceChargeAmt: service, tipAmt: order.tipAmt || 0,
          subtotal: totals.subtotal, discountAmt: discount, taxAmt: totals.totalTax,
          total: invoiceTotal, paidAmt: invoiceTotal, remainingAmt: 0,
          invoiceDate: issuedAt,
          shiftId: shift?.id ?? undefined,
          einvoiceProvider, einvoiceStatus, einvoiceQr,
          einvoiceSubmittedAt: einvoiceQr ? issuedAt : undefined,
          items: {
            create: order.items.map((it, i) => ({
              menuItemId: it.menuItemId, orderItemId: it.id,
              // تكلفة الوصفة تُستخدم فقط إن كانت موجبة فعلاً (مكوّنات بتكلفة 0 ⇒ ارجع للتكلفة المجمّدة)
              unitCost: (() => { const rc = recipeCost(it.menuItemId); return rc && rc > 0 ? rc : it.unitCost; })(),
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
      // الطلب المدفوع فوراً (كاونتر/سفري) يُرسل للمطبخ تلقائياً إن لم يُرسل مسبقاً
      await tx.orderItem.updateMany({
        where: { orderId, kotStatus: 'PENDING' },
        data: { kotStatus: 'FIRED', firedAt: issuedAt },
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
      if (shift && cashTotal > 0) {
        await tx.cashMovement.create({ data: { tenantId: tid, shiftId: shift.id, type: 'SALE', amount: cashTotal } });
      }

      // خصم مكوّنات الوصفات من المخزون تلقائياً + تسجيل حركة استهلاك لكل مكوّن (M6)
      const consumption = new Map<string, number>();
      for (const it of order.items) {
        const rs = it.menuItemId ? byMenu.get(it.menuItemId) : undefined;
        if (!rs) continue;
        for (const r of rs) consumption.set(r.ingredientId, (consumption.get(r.ingredientId) ?? 0) + r.qty * it.qty);
      }
      const consumed: { ingredientId: string; q: number }[] = [];
      for (const [ingredientId, raw] of consumption) {
        const q = roundDecimal(raw, 4);
        if (q > 0) consumed.push({ ingredientId, q });
      }
      if (consumed.length) {
        // خصم ذرّي لكل مكوّن + إدراج الحركات دفعةً واحدة (تقليل جُمل المعاملة وخطر المهلة)
        for (const c of consumed) {
          await tx.ingredient.update({ where: { id: c.ingredientId }, data: { stockQty: { decrement: c.q } } });
        }
        await tx.ingredientMovement.createMany({
          data: consumed.map(c => ({ tenantId: tid, ingredientId: c.ingredientId, type: 'SALE_OUT', qty: -c.q, orderId: order.id })),
        });
      }
      return { id: inv.id, number: inv.number, total: invoiceTotal, subtotal: totals.subtotal, taxAmt: totals.totalTax, qr: einvoiceQr, einvoiceStatus, issuedAt: issuedAt.toISOString() };
    });
  });

  return { invoiceId: out.id, number: out.number, total: out.total, subtotal: out.subtotal, taxAmt: out.taxAmt, qr: out.qr, einvoiceStatus: out.einvoiceStatus, issuedAt: out.issuedAt };
}
