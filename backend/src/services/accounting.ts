import { PrismaClient } from '@prisma/client';

type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// يزيل غبار الفاصلة العائمة دون المساس بأيّ عملة (٣ خانات في الدينار والريال العُماني)
export const clean = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * الرصيد الجاري للعميل = **مجموع المدين ناقص مجموع الدائن**.
 *
 * كان يُقرأ من «آخر قيد بالتاريخ» (`orderBy entryDate desc`) — وهو خطأ من وجهين:
 *
 * ١) **التعادل في التاريخ**: الفاتورة النقدية تكتب قيدين بنفس `entryDate` بالضبط —
 *    مدين بالإجمالي (رصيده `prev + total`) ودائن بالإجمالي (رصيده `prev`). ولا فاصل
 *    تعادل، فالقاعدة حرّة في إعادة أيّهما. وإن أعادت المدين، بُني كلّ قيد لاحق على
 *    رصيد **أعلى بمقدار الفاتورة كاملةً**، فينفتح فرقٌ دائم في كشف الحساب.
 *    ولا ينفع `createdAt` فاصلَ تعادل: `now()` في بوستجرس **ثابتة طوال المعاملة**،
 *    فالقيدان يحملان الطابع نفسه إلى الميلي ثانية. ولا `id` — فهو UUID عشوائي.
 *
 * ٢) **القيد بأثر رجعي**: فاتورة تُسجَّل بتاريخ سابق تأخذ أساسها من رصيد **أحدث**
 *    قيد، فتُخزَّن برصيدٍ لا يمتّ لموضعها الزمني بصلة.
 *
 * والمجموع محصَّنٌ من الاثنين معاً: لا يعنيه ترتيبٌ ولا تاريخ. وهو عين ما يفعله
 * مسار التراجع في الاستيراد حين يعيد بناء الأرصدة (`import.ts`)، وعين ما يحفظه
 * `customer.balance` بزياداته — فالمصادر الثلاثة تتّفق أخيراً على تعريف واحد.
 */
export async function currentBalance(tx: Tx, customerId: string) {
  const agg = await tx.accountEntry.aggregate({
    where: { customerId },
    _sum: { debit: true, credit: true },
  });
  return clean(Number(agg._sum.debit ?? 0) - Number(agg._sum.credit ?? 0));
}

/**
 * يشتقّ عمود الرصيد الجاري لكشف الحساب في **ترتيب العرض** انطلاقاً من رصيد مُرحَّل.
 *
 * لا يُعرض `balance` المخزَّن: هو لقطةٌ لحظةَ الكتابة، فقيدٌ بأثر رجعي يحمل رصيد
 * زمنٍ لاحق له، وقيدٌ محذوف يترك من بعده أرصدةً معلّقة — فيخرج عمودٌ لا تُنتج فيه
 * أيّ خطوةٍ الخطوةَ التالية. الاشتقاق يضمن أنّ كل سطر ناتجُ سابقه بالضرورة.
 *
 * دالّة صرفة عمداً: تُختبَر بلا قاعدة بيانات.
 */
export function deriveRunningBalances<T extends { debit: number; credit: number }>(
  entries: T[], openingBalance = 0
): (T & { balance: number })[] {
  let running = clean(openingBalance);
  return entries.map((e) => {
    running = clean(running + Number(e.debit) - Number(e.credit));
    return { ...e, balance: running };
  });
}

export async function postInvoiceEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number, date?: Date
) {
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance + total);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_DEBIT',
      debit: clean(total), credit: 0, balance: newBalance,
      description: 'فاتورة مبيعات آجلة',
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    // ضبط لا تراكم: increment العائم في القاعدة يراكم غبارا يظهر المسدد مدينا
    data: { balance: newBalance, totalSales: { increment: clean(total) } },
  });
}

export async function postCashInvoiceEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number, date?: Date
) {
  const prevBalance = await currentBalance(tx, customerId);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_DEBIT',
      debit: clean(total), credit: 0, balance: clean(prevBalance + total),
      description: 'فاتورة مبيعات نقدية',
      ...(date && { entryDate: date }),
    },
  });

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'RECEIPT_CREDIT',
      debit: 0, credit: clean(total), balance: clean(prevBalance),
      description: 'تحصيل نقدي لفاتورة مبيعات',
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { totalSales: { increment: clean(total) }, totalCollected: { increment: clean(total) } },
  });
}

export async function reverseInvoiceEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number
) {
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance - total);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_CREDIT',
      debit: 0, credit: clean(total), balance: newBalance,
      description: 'إلغاء فاتورة مبيعات آجلة',
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: newBalance, totalSales: { decrement: clean(total) } },
  });
}

export async function reverseCashInvoiceEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number
) {
  const prevBalance = await currentBalance(tx, customerId);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_CREDIT',
      debit: 0, credit: clean(total), balance: clean(prevBalance - total),
      description: 'إلغاء فاتورة مبيعات نقدية',
    },
  });

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'RECEIPT_DEBIT',
      debit: clean(total), credit: 0, balance: clean(prevBalance),
      description: 'عكس تحصيل نقدي لفاتورة مبيعات',
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { totalSales: { decrement: clean(total) }, totalCollected: { decrement: clean(total) } },
  });
}

export async function postReceiptEntries(
  tx: Tx, tenantId: string, receiptId: string, customerId: string, amount: number, date?: Date
) {
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance - amount);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, receiptId,
      type: 'RECEIPT_CREDIT',
      debit: 0, credit: clean(amount), balance: newBalance,
      description: 'سند قبض - تحصيل',
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: newBalance, totalCollected: { increment: clean(amount) } },
  });
}

export async function reverseReceiptEntries(
  tx: Tx, tenantId: string, receiptId: string, customerId: string, amount: number
) {
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance + amount);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, receiptId,
      type: 'RECEIPT_DEBIT',
      debit: clean(amount), credit: 0, balance: newBalance,
      description: 'إلغاء سند قبض',
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: newBalance, totalCollected: { decrement: clean(amount) } },
  });
}

export async function postReturnEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number, date?: Date
) {
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance - total);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_CREDIT',
      debit: 0, credit: clean(total), balance: newBalance,
      description: 'فاتورة مرتجع مبيعات',
      ...(date && { entryDate: date }),
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    data: { balance: newBalance, totalSales: { decrement: clean(total) } },
  });
}

export async function reverseReturnEntries(
  tx: Tx, tenantId: string, invoiceId: string, customerId: string, total: number
) {
  const prevBalance = await currentBalance(tx, customerId);
  const newBalance = clean(prevBalance + total);

  await tx.accountEntry.create({
    data: {
      tenantId, customerId, invoiceId,
      type: 'INVOICE_DEBIT',
      debit: clean(total), credit: 0, balance: newBalance,
      description: 'إلغاء فاتورة مرتجع',
    },
  });

  await tx.customer.update({
    where: { id: customerId },
    // ضبط لا تراكم: increment العائم في القاعدة يراكم غبارا يظهر المسدد مدينا
    data: { balance: newBalance, totalSales: { increment: clean(total) } },
  });
}
