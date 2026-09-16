/**
 * «مقابل الفاتورة رقم …» — ماذا يطبعه سند القبض عن فواتيره.
 *
 * وحدة نقية بلا React: يقرؤها قالب A4 (`PrintableReceipt`) والطباعة الحرارية
 * (`thermal.ts`) معاً، فلا يقول الورق الحراريّ غير ما يقوله الـPDF.
 *
 * المصدر روابط الخادم (`invoiceItems`) لا توزيع الشاشة: الخادم قد يُكمل
 * التوزيع بالأقدم، والإعادة المتطابقة (clientRef) تُرجع سنداً لم تره الشاشة.
 * الاستثناء الوحيد سندٌ مُلتقَط دون اتصال — لا روابط خادم له بعد، فيُطبع
 * توزيع المندوب نفسه إن وُجد، وإلا يُقال صراحةً إن الفاتورة تُحدَّد عند المزامنة.
 */

export interface ReceiptInvoiceLink {
  number: string;
  /** ما خُصّص لهذه الفاتورة من مبلغ السند */
  amount: number;
}

export type ReceiptLinkView =
  /** مرتبط بفاتورة أو أكثر — و`unallocated` ما فاض عنها رصيداً دائناً للعميل */
  | { kind: 'invoices'; links: ReceiptInvoiceLink[]; unallocated: number }
  /** مؤكَّد من الخادم: لا فاتورة مفتوحة وقت الإصدار — دفعة على الحساب */
  | { kind: 'onAccount' }
  /** مُلتقَط دون اتصال بلا توزيع — الخادم يربطه عند الرفع */
  | { kind: 'pending' }
  /** لا بيانات روابط (مستند بُني بلا ردّ الخادم) — لا يُطبع شيء بدل ادّعاءٍ كاذب */
  | { kind: 'unknown' };

/**
 * روابط السند من ردّ الخادم (`invoiceItems: [{ amount, invoice: { number } }]`).
 * `undefined` = الحقل غائب (لا يُعرف) — يختلف عن `[]` (معروفٌ أنه بلا فاتورة).
 */
export function receiptInvoicesFrom(raw: unknown): ReceiptInvoiceLink[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ReceiptInvoiceLink[] = [];
  // حاجز العملات الثلاثية (أدقّها) — الحكم بخانات العملة الفعلية يقع في receiptLinkView
  const EPS = 0.0005;
  for (const row of raw) {
    const r = (row ?? {}) as { amount?: unknown; invoice?: { number?: unknown } | null };
    const number = r.invoice?.number;
    const amount = Number(r.amount);
    if (typeof number === 'string' && number && Number.isFinite(amount) && amount > EPS) {
      out.push({ number, amount });
    }
  }
  return out;
}

/**
 * @param decimals خانات عملة الشركة (٠/٢/٣) — يُحكم بها على الفائض: مبلغٌ كُتب
 * 100.004 بالريال يُخزَّن كما كُتب ويُوزَّع 100.00، وحاجزٌ ثابت لثلاث خانات كان
 * يطبع «رصيد دائن 0.00» لفائضٍ لا يظهر في العملة أصلاً.
 */
export function receiptLinkView(doc: {
  amount: number;
  invoices?: ReceiptInvoiceLink[];
  offline?: boolean;
}, decimals = 2): ReceiptLinkView {
  const f = Math.pow(10, Math.max(0, Math.min(3, Math.floor(Number(decimals) || 0))));
  const half = 0.5 / f; // نصف أصغر وحدة في العملة
  const links = (doc.invoices ?? []).filter(l => l && l.number && Number(l.amount) > half);
  if (links.length) {
    const linked = links.reduce((s, l) => s + Number(l.amount), 0);
    const rest = (Number(doc.amount) || 0) - linked;
    // التقريب بخانات العملة يمحو غبار العائمة (344.85 − 114.95×3) وكسور ما دون أصغر وحدة
    const unallocated = Math.round(rest * f) / f;
    return { kind: 'invoices', links, unallocated: unallocated > half ? unallocated : 0 };
  }
  if (doc.offline) return { kind: 'pending' };
  if (Array.isArray(doc.invoices)) return { kind: 'onAccount' };
  return { kind: 'unknown' };
}
