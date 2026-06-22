import { PrismaClient } from '@prisma/client';

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

export async function postInvoiceEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number, date?: Date
) {
  const lastEntry = await tx.accountEntry.findFirst({
    where: { customerId },
    orderBy: { entryDate: 'desc' },
  });
  const prevBalance = Number(lastEntry?.balance ?? 0);
  const newBalance = prevBalance + total;

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_DEBIT',
      debit: total, credit: 0, balance: newBalance,
      description: `فاتورة مبيعات`,
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: { increment: total }, totalSales: { increment: total } },
  });
}

export async function reverseInvoiceEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number
) {
  const lastEntry = await tx.accountEntry.findFirst({
    where: { customerId },
    orderBy: { entryDate: 'desc' },
  });
  const prevBalance = Number(lastEntry?.balance ?? 0);
  const newBalance = prevBalance - total;

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_CREDIT',
      debit: 0, credit: total, balance: newBalance,
      description: `إلغاء فاتورة مبيعات`,
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: { decrement: total }, totalSales: { decrement: total } },
  });
}

export async function postReceiptEntries(
  tx: Tx, tenantId: string, receiptId: string, customerId: string, amount: number, date?: Date
) {
  const lastEntry = await tx.accountEntry.findFirst({
    where: { customerId },
    orderBy: { entryDate: 'desc' },
  });
  const prevBalance = Number(lastEntry?.balance ?? 0);
  const newBalance = prevBalance - amount;

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, receiptId,
      type: 'RECEIPT_CREDIT',
      debit: 0, credit: amount, balance: newBalance,
      description: `سند قبض - تحصيل`,
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: { decrement: amount }, totalCollected: { increment: amount } },
  });
}

export async function reverseReceiptEntries(
  tx: Tx, tenantId: string, receiptId: string, customerId: string, amount: number
) {
  const lastEntry = await tx.accountEntry.findFirst({
    where: { customerId },
    orderBy: { entryDate: 'desc' },
  });
  const prevBalance = Number(lastEntry?.balance ?? 0);
  const newBalance = prevBalance + amount;

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, receiptId,
      type: 'RECEIPT_DEBIT',
      debit: amount, credit: 0, balance: newBalance,
      description: `إلغاء سند قبض`,
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: { increment: amount }, totalCollected: { decrement: amount } },
  });
}

// فاتورة مرتجع: قيد دائن يُخفّض رصيد العميل ومبيعاته
export async function postReturnEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number, date?: Date
) {
  const lastEntry = await tx.accountEntry.findFirst({
    where: { customerId },
    orderBy: { entryDate: 'desc' },
  });
  const prevBalance = Number(lastEntry?.balance ?? 0);
  const newBalance = prevBalance - total;

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_CREDIT',
      debit: 0, credit: total, balance: newBalance,
      description: `فاتورة مرتجع مبيعات`,
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: { decrement: total }, totalSales: { decrement: total } },
  });
}

// إلغاء فاتورة مرتجع: عكس القيد (قيد مدين يُعيد الرصيد)
export async function reverseReturnEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number
) {
  const lastEntry = await tx.accountEntry.findFirst({
    where: { customerId },
    orderBy: { entryDate: 'desc' },
  });
  const prevBalance = Number(lastEntry?.balance ?? 0);
  const newBalance = prevBalance + total;

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_DEBIT',
      debit: total, credit: 0, balance: newBalance,
      description: `إلغاء فاتورة مرتجع`,
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: { increment: total }, totalSales: { increment: total } },
  });
}
