import { roundHalfUp } from '../lib/money';

/**
 * توزيع سند القبض على فواتير العميل — الأقدم أولاً (FIFO).
 *
 * لماذا وحدة معزولة: التوزيع صار **إلزامياً** بقرار المالك، والإلزام في
 * الواجهة وحده لا يكفي — سند يصل من الأوف‑لاين أو من تطبيق الإدارة أو من أي
 * مسار آخر بلا توزيع كان سيطفو بلا فواتير، وهو ما تمنعه هذه الدالة على الخادم.
 *
 * القاعدة: يُوزَّع المتبقّي من مبلغ السند على أقدم الفواتير غير المسدَّدة حتى
 * ينفد أحدهما. والفائض عن مديونية العميل يبقى **رصيداً دائناً** له — لا يُبتلع
 * ولا يُجبَر على فاتورة، فمن دفع مقدَّماً له حقّه.
 */

export interface AllocatableInvoice {
  id: string;
  remainingAmt: number;
  /** الأقدم أولاً — يُرتَّب المُدخَل قبل النداء أو يُرتَّب هنا */
  invoiceDate?: Date | string;
}

export interface Allocation { invoiceId: string; amount: number }

/**
 * يكمل التوزيع الناقص من مبلغ السند على الفواتير المتاحة.
 *
 * @param amount مبلغ السند كاملاً
 * @param existing ما وزّعه المستخدم يدوياً (يُحترَم كما هو)
 * @param invoices الفواتير غير المسدَّدة للعميل (تُرتَّب هنا بالأقدم)
 * @returns التوزيع الكامل — اليدويّ مضافاً إليه التكملة الآلية
 */
export function fillAllocationsFifo(
  amount: number,
  existing: Allocation[],
  invoices: AllocatableInvoice[],
): Allocation[] {
  const total = roundHalfUp(Number(amount) || 0, 2);
  if (total <= 0) return [];

  // ما خصّصه المستخدم يُجمَع بالفاتورة (قد تتكرّر) ويبقى كما هو
  const byInvoice = new Map<string, number>();
  for (const a of existing) {
    if (!a?.invoiceId) continue;
    const v = roundHalfUp(Number(a.amount) || 0, 2);
    if (v <= 0) continue;
    byInvoice.set(a.invoiceId, roundHalfUp((byInvoice.get(a.invoiceId) ?? 0) + v, 2));
  }

  const allocated = roundHalfUp([...byInvoice.values()].reduce((s, v) => s + v, 0), 2);
  let left = roundHalfUp(total - allocated, 2);
  if (left <= 0.0005) return toList(byInvoice);

  const sorted = [...invoices].sort((a, b) => {
    const da = a.invoiceDate ? new Date(a.invoiceDate).getTime() : 0;
    const db = b.invoiceDate ? new Date(b.invoiceDate).getTime() : 0;
    return da - db;
  });

  for (const inv of sorted) {
    if (left <= 0.0005) break;
    const already = byInvoice.get(inv.id) ?? 0;
    // المتاح على هذه الفاتورة بعد ما خصّصه المستخدم لها يدوياً
    const room = roundHalfUp(roundHalfUp(Number(inv.remainingAmt) || 0, 2) - already, 2);
    if (room <= 0.0005) continue;
    const take = roundHalfUp(Math.min(room, left), 2);
    byInvoice.set(inv.id, roundHalfUp(already + take, 2));
    left = roundHalfUp(left - take, 2);
  }

  // ما بقي بعد استنفاد الفواتير = رصيد دائن للعميل (لا يُوزَّع قسراً)
  return toList(byInvoice);
}

function toList(m: Map<string, number>): Allocation[] {
  return [...m.entries()]
    .filter(([, v]) => v > 0.0005)
    .map(([invoiceId, amount]) => ({ invoiceId, amount }));
}

/**
 * أقصى ما يمكن توزيعه من سند على فواتير عميل — تستعمله الواجهة لتقول
 * للمستخدم «يلزمك توزيع كذا» بدل مطالبته بتغطية مبلغ لا فواتير له.
 */
export function allocatableCeiling(amount: number, invoices: AllocatableInvoice[]): number {
  const outstanding = roundHalfUp(
    invoices.reduce((s, i) => s + Math.max(0, roundHalfUp(Number(i.remainingAmt) || 0, 2)), 0),
    2,
  );
  return roundHalfUp(Math.min(roundHalfUp(Number(amount) || 0, 2), outstanding), 2);
}
