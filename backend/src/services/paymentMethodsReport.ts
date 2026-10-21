/**
 * صفحة «طرق الدفع» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — جدولٌ لكل طريقة دفع، صفوفه المناديب بما **حصّله** كلٌّ منهم بتلك
 * الطريقة في الفترة: «محمد نقدي / محمد شبكة / محمد تحويل / محمد شيك …» — كلّ تحصيلٍ لمندوبٍ يقع في جدول قناته.
 *
 * قرارات المالك (مسجَّلة هنا لأنها تخالف عمداً أرقام شاشاتٍ أخرى):
 *  ١. **النقدي = سندات القبض النقدية + فواتير البيع النقدي.** الفاتورة النقدية تُحفظ `paidAmt = total` ولا تُنشئ سند قبض
 *     (قيدان فقط: INVOICE_DEBIT + RECEIPT_CREDIT)، فعدُّها بجانب السندات لا يكرّر شيئاً. ولهذا لا يطابق نقديُّ هذه
 *     الصفحة «رصيد التحصيل» (عهدة المندوب: سندات فقط) ولا تقرير التحصيل (سندات فقط) — والصفحة تعرض الشقّين منفصلين.
 *  ٢. **ما حصّله المندوب وحده:** لا خصمَ لما سلّمه للشركة (تسويات العهدة) ولا مقاصّةَ للمرتجعات. والتحصيل بلا مندوب
 *     (سندٌ من اللوحة، أو مندوبٌ حُذف فصار مرجعه فارغاً) **لا يدخل الجداول ولا إجمالياتها** — يُعاد منفصلاً (`noRep`)
 *     لتذكره الواجهة سطراً خارج الجدول، فلا يختفي مالٌ عن الشاشة ولا يُنسب لمندوبٍ لم يحصّله.
 *  ٣. **الساري وحده:** السند ACTIVE والفاتورة CONFIRMED — **إلا** النقدية التي رفضتها الهيئة فأُبطلت (ZATCA_VOID): نقدُها
 *     قبضه المندوب فعلاً وبقي رصيداً دائناً للعميل («لا يُعكس تحصيل المندوب أبداً»، invoiceVoid.ts)، وبديلُها آجلٌ يُسدَّد من
 *     ذلك الرصيد بلا سند — فإسقاطها كان يمحو نقد المندوب من جدوله نهائياً. علامتها قيد INVOICE_CREDIT بوسم
 *     CASH_VOID_KEEP_COLLECTION_NOTE بلا RECEIPT_DEBIT (القاعدة نفسها في gl/sync/desired.ts keepCashLeg). أمّا ما سحبته
 *     الإدارة (CANCEL) فعكسٌ حقيقيّ للتحصيل ويبقى خارجاً.
 *  ٤. **الفترة بأيام الشركة المحلية** (`tenantTz`: الرياض +٣): «اليوم» من منتصف ليل الشركة إلى منتصف ليلها التالي. تقارير
 *     التحصيل القديمة تقرأ 'YYYY-MM-DD' منتصفَ ليل UTC، فقد يختلف مجموع اليوم نفسه بينهما بما وقع بين ٠٠:٠٠ و٠٣:٠٠.
 *  ٥. **الإلكتروني (ميسر)** سندٌ ONLINE منسوبٌ لمن أصدر رابط الدفع — يظهر في جدوله لأنه تحصيلُ ذلك المندوب من عميله.
 *
 * وحدةٌ صافية بلا قاعدة بيانات (الاستعلام في routes/reports.ts) لتُختبر وحدها.
 */
import { addDays, isLocalDate, todayLocal, zonedStartOfDay } from './gl/dates';
import type { Prisma } from '@prisma/client';
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';

/** ترتيب الجداول على الشاشة: الأكثر استعمالاً في الميدان أولاً. قيمٌ خارجها (سجلٌّ قديم) تُلحق بعدها ولا تسقط. */
export const PAYMENT_METHODS = ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

/** سند القبض المحصَّل: الساري وحده — الملغى (CANCELLED) لم يُحصَّل أو رُدّ. */
export const COLLECTED_RECEIPT = { status: 'ACTIVE' } as const;

/**
 * فاتورة البيع النقدي المحصَّلة: نقديةٌ مؤكَّدة. المسودة لم تُصدر والملغاة خرجت.
 * والإشعاران لا يحتاجان شرطاً على documentKind: الدائن يُخزَّن `type: 'RETURN'` والمدين `type: 'CREDIT'`
 * (compliance/zatca/notes.ts) فلا يطابقان `CASH` أصلاً — و`notIn` على عمودٍ فارغٍ في القديم يُسقط كل فاتورةٍ قديمة.
 */
export const COLLECTED_CASH_SALE: Prisma.InvoiceWhereInput = {
  type: 'CASH',
  OR: [
    { status: 'CONFIRMED' },
    // أبطلتها الهيئة واحتُفظ بتحصيلها (القرار ٣) — وصفُّ RECEIPT_DEBIT يعني أنّ التحصيل عُكس فعلاً فلا تُعدّ
    {
      status: 'CANCELLED',
      AND: [
        { accountEntries: { some: { type: 'INVOICE_CREDIT', description: CASH_VOID_KEEP_COLLECTION_NOTE } } },
        { accountEntries: { none: { type: 'RECEIPT_DEBIT' } } },
      ],
    },
  ],
};

export type RangeResult =
  | { ok: true; from: string; to: string; gte: Date; lt: Date }
  | { ok: false; message: string };

/**
 * مدى الصفحة بأيام الشركة: [منتصف ليل «من»، منتصف ليل اليوم التالي لـ«إلى») بتوقيتها — كـinstantRange في الدفاتر.
 * الغائب: «إلى» ⇒ اليوم (أو «من» إن كانت بعد اليوم)، و«من» ⇒ «إلى» (يومٌ واحد). فالافتراض بلا معاملات: اليوم.
 * تاريخٌ مكتوبٌ بغير صيغة YYYY-MM-DD أو غير موجود في التقويم يُرفض صراحةً — لا يُسقَط إلى «كل الفترات» صامتاً.
 */
export function paymentMethodsRange(rawFrom: unknown, rawTo: unknown, tz: string, now: Date = new Date()): RangeResult {
  const given = (v: unknown) => typeof v === 'string' && v !== '';
  if ((given(rawFrom) && !isLocalDate(rawFrom)) || (given(rawTo) && !isLocalDate(rawTo))) {
    return { ok: false, message: 'تاريخ غير صالح' };
  }
  const today = todayLocal(now, tz);
  const fromIn = isLocalDate(rawFrom) ? rawFrom : null;
  const toIn = isLocalDate(rawTo) ? rawTo : null;
  const to = toIn ?? (fromIn && fromIn > today ? fromIn : today);
  const from = fromIn ?? to;
  if (from > to) return { ok: false, message: 'تاريخ البداية بعد تاريخ النهاية' };
  return { ok: true, from, to, gte: zonedStartOfDay(from, tz), lt: zonedStartOfDay(addDays(to, 1), tz) };
}

/** صفّ تجميع السندات من القاعدة (groupBy مندوب × طريقة). */
export interface ReceiptGroupRow { salesRepId: string | null; paymentMethod: string; amount: number; count: number }
/** صفّ تجميع فواتير البيع النقدي (groupBy مندوب). */
export interface CashSaleGroupRow { salesRepId: string | null; amount: number; count: number }
export interface RepInfo { name: string; isActive: boolean }

/** مبلغٌ وعدد، مع شقّيه في النقدي: من السندات ومن فواتير البيع النقدي (صفرٌ في غيره). */
export interface Collected {
  amount: number; count: number;
  receiptsAmount: number; receiptsCount: number;
  invoicesAmount: number; invoicesCount: number;
}
export interface MethodRepRow extends Collected { salesRepId: string; repName: string; repActive: boolean }
export interface MethodBlock {
  method: string;
  rows: MethodRepRow[];
  /** إجمالي الجدول = مجموع صفوف المناديب وحدها */
  total: Collected;
  /** تحصيلٌ بهذه الطريقة بلا مندوب — خارج الجدول وإجماليه (القرار ٢) */
  noRep: { amount: number; count: number };
}
export interface PaymentMethodsReport {
  methods: MethodBlock[];
  /** مجموع الجداول كلها (المناديب وحدهم) */
  total: { amount: number; count: number };
  noRep: { amount: number; count: number };
  /** عدد المناديب الذين حصّلوا شيئاً في الفترة بأيّ طريقة */
  repsCount: number;
}

/** المبالغ بثلاث منازل (عملات الدينار) كبقيّة التقارير؛ والجمع على المقرَّب كي يساوي إجماليُّ الجدول مجموعَ صفوفه المعروضة. */
const round3 = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 1000) / 1000;
const zero = (): Collected => ({ amount: 0, count: 0, receiptsAmount: 0, receiptsCount: 0, invoicesAmount: 0, invoicesCount: 0 });

/**
 * يبني جداول الصفحة من تجميعات القاعدة.
 * - السند يقع في جدول طريقته؛ وفاتورة البيع النقدي في جدول النقدي بشقّها (invoicesAmount/invoicesCount).
 * - بلا مندوب ⇒ `noRep` لطريقته لا صفّ.
 * - الطرق الخمس حاضرةٌ دائماً بترتيبها (جدولٌ فارغ يقول «لا تحصيل بهذه الطريقة» بدل أن يختفي)، وما سواها يُلحق إن وُجد.
 * - الصفوف بالمبلغ تنازلياً ثم العدد ثم الاسم.
 */
export function buildPaymentMethodsReport(
  receipts: ReceiptGroupRow[],
  cashSales: CashSaleGroupRow[],
  reps: Map<string, RepInfo>,
): PaymentMethodsReport {
  const byMethod = new Map<string, { rows: Map<string, Collected>; noRep: { amount: number; count: number } }>();
  const methodOf = (m: string) => {
    let b = byMethod.get(m);
    if (!b) { b = { rows: new Map(), noRep: { amount: 0, count: 0 } }; byMethod.set(m, b); }
    return b;
  };
  for (const m of PAYMENT_METHODS) methodOf(m);

  const add = (method: string, repId: string | null, amount: number, count: number, part: 'receipts' | 'invoices') => {
    const b = methodOf(method);
    const a = Number.isFinite(amount) ? amount : 0;
    const c = Number.isFinite(count) ? count : 0;
    if (!repId) { b.noRep.amount += a; b.noRep.count += c; return; }
    const row = b.rows.get(repId) ?? zero();
    row.amount += a; row.count += c;
    if (part === 'receipts') { row.receiptsAmount += a; row.receiptsCount += c; } else { row.invoicesAmount += a; row.invoicesCount += c; }
    b.rows.set(repId, row);
  };
  for (const r of receipts) add(r.paymentMethod || 'CASH', r.salesRepId, Number(r.amount), Number(r.count), 'receipts');
  for (const r of cashSales) add('CASH', r.salesRepId, Number(r.amount), Number(r.count), 'invoices');

  const known = new Set<string>(PAYMENT_METHODS);
  const order = [...PAYMENT_METHODS, ...[...byMethod.keys()].filter((m) => !known.has(m)).sort()];
  const activeReps = new Set<string>();
  const methods: MethodBlock[] = order.map((method) => {
    const b = byMethod.get(method)!;
    const rows: MethodRepRow[] = [...b.rows.entries()]
      .map(([salesRepId, c]) => ({
        salesRepId,
        repName: reps.get(salesRepId)?.name ?? '',
        repActive: reps.get(salesRepId)?.isActive !== false,
        amount: round3(c.amount), count: c.count,
        receiptsAmount: round3(c.receiptsAmount), receiptsCount: c.receiptsCount,
        invoicesAmount: round3(c.invoicesAmount), invoicesCount: c.invoicesCount,
      }))
      .filter((r) => r.count > 0 || r.amount !== 0)
      .sort((x, y) => y.amount - x.amount || y.count - x.count || x.repName.localeCompare(y.repName, 'ar'));
    const total = zero();
    for (const r of rows) {
      activeReps.add(r.salesRepId);
      total.amount += r.amount; total.count += r.count;
      total.receiptsAmount += r.receiptsAmount; total.receiptsCount += r.receiptsCount;
      total.invoicesAmount += r.invoicesAmount; total.invoicesCount += r.invoicesCount;
    }
    total.amount = round3(total.amount); total.receiptsAmount = round3(total.receiptsAmount); total.invoicesAmount = round3(total.invoicesAmount);
    return { method, rows, total, noRep: { amount: round3(b.noRep.amount), count: b.noRep.count } };
  });

  return {
    methods,
    total: {
      amount: round3(methods.reduce((s, m) => s + m.total.amount, 0)),
      count: methods.reduce((s, m) => s + m.total.count, 0),
    },
    noRep: {
      amount: round3(methods.reduce((s, m) => s + m.noRep.amount, 0)),
      count: methods.reduce((s, m) => s + m.noRep.count, 0),
    },
    repsCount: activeReps.size,
  };
}
