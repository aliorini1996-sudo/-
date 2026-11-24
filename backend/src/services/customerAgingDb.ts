/**
 * «عمر الدين» — القراءة من القاعدة لتقرير أرصدة العملاء (GET /reports/balances). الحساب كلّه في customerAging.ts (صرف).
 *
 * لكل دفعة عملاء (AGING_ID_CHUNK):
 *  ١) الفواتير المفتوحة — آجلةٌ مؤكَّدة بمتبقٍّ موجب، بالشرط نفسه الذي تُعرض به للتحصيل (routes/invoices.ts open، receipts.ts) بلا
 *     قيد الهيئة: فاتورةٌ تنتظر الاعتماد دينٌ قائمٌ في الرصيد وله عمر. وفاتورة التقسيط بأقساطها (installmentPieces): استحقاق الفاتورة
 *     نفسها آخر قسط، فبدونها لا يتأخّر شيءٌ منها قبل آخر قسط.
 *  ٢) قيود التسوية المدينة (ADJUSTMENT_DEBIT) — لمن رصيده أكبر من فواتيره المفتوحة وحده، وبلا قيدين لا يحملان ديناً جديداً:
 *     الصفّ العاكس لإلغاء شطب ذمة (CustomerAdjustment.reverseEntryId — يردّ ديناً تؤرّخه فواتيره أو قيوده الأصلية؛ وبه كان الدين
 *     القديم المستعاد يظهر بعمر يوم الإلغاء)، وقيد «ردّ رصيد دائن» المُلغى (أبطله قيدٌ دائنٌ عاكس). والقيد المستورد بلا تاريخ (رصيدٌ
 *     افتتاحيّ أو صفّ كشف — أخذ لحظة الاستيراد لا أول يوم) يُعلَّم «بلا تاريخ» — لا عمرَ مخترعاً من يوم الاستيراد (isImportMoment).
 */
import type { PrismaClient } from '@prisma/client';
import { DEBT_EPS, customerAging, dueDayOf, installmentPieces, type CustomerAging, type DatedDebt } from './customerAging';

type Db = Pick<PrismaClient, 'invoice' | 'accountEntry' | 'customerAdjustment'>;

/** معرّفاتٌ في `IN` لكل استعلام — بعيداً عن حدّ معاملات بوستجرس مهما كبرت الشركة */
export const AGING_ID_CHUNK = 1000;

export interface AgingCustomer { id: string; balance: unknown; paymentDays?: unknown }

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** منسّق يوم الشركة 'YYYY-MM-DD' — واحدٌ للتقرير كله (بناؤه لكل فاتورة يكلّف آلاف المرّات)، ومنطقةٌ غير صالحة ⇒ UTC */
function dayFormatter(tz: string): { tz: string; dayOf: (d: Date | null | undefined) => string | null } {
  const make = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  let zone = tz;
  let fmt: Intl.DateTimeFormat;
  try { fmt = make(tz); } catch { zone = 'UTC'; fmt = make(zone); }
  return { tz: zone, dayOf: (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? fmt.format(d) : null) };
}

/** ربع ساعة بالملّي ثانية — كل فروق المناطق الزمنية الحقيقية مضاعفاتٌ له */
const QUARTER_HOUR_MS = 900_000;

/**
 * قيدٌ مستورد (رصيدٌ افتتاحيّ أو صفّ كشف حساب — /import/balances و/import/ledger) **بلا تاريخ**: يأخذ لحظة الاستيراد بالملّي ثانية
 * (resolveImportDates)، والمؤرَّخ صراحةً (أو بتاريخ «الصفوف بلا تاريخ») يُخزَّن بأول لحظةٍ من يومه في منطقةٍ ما (importedEntryInstant:
 * منطقة الكاتب الصريحة أو منتصف ليل UTC، وصفوفٌ قديمة بمنتصف ليل الرياض). فاللحظة على حدّ ربع ساعة ⇒ مؤرَّخ أيّاً كانت المنطقة التي
 * كُتب بها (لا يُشترط منتصف ليل منطقة التقرير نفسها)، وغيرها ⇒ لحظة استيراد. لا يُسأل إلا عن القيود المستوردة: التسويات اليدوية
 * (شاشة التسويات، CustomerAdjustment) تُؤرَّخ بلحظتها دائماً
 */
export function isImportMoment(entryDate: Date): boolean {
  const t = entryDate.getTime();
  return Number.isFinite(t) && t % QUARTER_HOUR_MS !== 0;
}

/**
 * عمر دين كل عميلٍ مدين في القائمة (رصيده أكبر من DEBT_EPS) — `tz` منطقة الشركة، و`now` اللحظة (الاختبارات تثبّتها).
 * العميل غير المدين لا مفتاح له في الخريطة (عمره null عند المنادي).
 */
export async function loadCustomerAging(
  db: Db, tid: string, customers: readonly AgingCustomer[], tz: string, now: Date = new Date(),
): Promise<Map<string, CustomerAging | null>> {
  const out = new Map<string, CustomerAging | null>();
  const fmt = dayFormatter(tz);
  const { dayOf } = fmt;
  const today = dayOf(now);
  const debtors = customers.filter((c) => Number(c.balance) > DEBT_EPS);
  if (!today || !debtors.length) return out;

  const byId = new Map(debtors.map((c) => [c.id, c]));
  const open = new Map<string, DatedDebt[]>();
  const push = (m: Map<string, DatedDebt[]>, id: string, ds: DatedDebt[]) => {
    if (!ds.length) return;
    const list = m.get(id) ?? [];
    list.push(...ds);
    m.set(id, list);
  };

  for (const part of chunks(debtors.map((c) => c.id), AGING_ID_CHUNK)) {
    const rows = await db.invoice.findMany({
      where: { tenantId: tid, customerId: { in: part }, status: 'CONFIRMED', type: 'CREDIT', remainingAmt: { gt: DEBT_EPS } },
      select: {
        customerId: true, invoiceDate: true, dueDate: true, remainingAmt: true, total: true,
        installments: { select: { seq: true, dueDate: true, amount: true }, orderBy: { seq: 'asc' } },
      },
    });
    for (const r of rows) {
      const day = dayOf(r.invoiceDate);
      if (!day) continue;
      const paymentDays = byId.get(r.customerId)?.paymentDays;
      const due = dueDayOf(day, dayOf(r.dueDate), paymentDays);
      const inst = (r as { installments?: { seq: number; dueDate: Date; amount: number }[] }).installments ?? [];
      push(open, r.customerId, inst.length
        ? installmentPieces(day, Number(r.total), Number(r.remainingAmt), inst.map((i) => ({ dueDay: dayOf(i.dueDate), amount: Number(i.amount) })), due)
        : [{ day, amount: Number(r.remainingAmt), dueDay: due }]);
    }
  }

  // رصيدٌ أكبر من فواتيره المفتوحة: الفرق ليس على فاتورة — قيود التسوية المدينة تؤرّخه
  const short = debtors.filter((c) => Number(c.balance) - (open.get(c.id) ?? []).reduce((s, d) => s + d.amount, 0) > DEBT_EPS);
  const adjustments = new Map<string, DatedDebt[]>();
  for (const part of chunks(short.map((c) => c.id), AGING_ID_CHUNK)) {
    const rows = await db.accountEntry.findMany({
      where: { tenantId: tid, customerId: { in: part }, type: 'ADJUSTMENT_DEBIT', debit: { gt: DEBT_EPS } },
      select: { id: true, customerId: true, entryDate: true, debit: true, description: true },
    });
    if (!rows.length) continue;
    // التسويات اليدوية لمن له قيود (CustomerAdjustment: معرّفها = معرّف قيدها، وعاكسها reverseEntryId) — كل تسويةٍ مدينة ليست منها
    // قيدٌ مستورد. والمُلغاة: عاكس الشطب الملغى وقيد الردّ الملغى لا يحملان ديناً جديداً
    const manual = await db.customerAdjustment.findMany({
      where: { tenantId: tid, customerId: { in: [...new Set(rows.map((r) => r.customerId))] } },
      select: { id: true, kind: true, status: true, reverseEntryId: true },
    });
    const manualIds = new Set<string>();
    const skip = new Set<string>();
    for (const a of manual) {
      manualIds.add(a.id);
      if (a.reverseEntryId) manualIds.add(a.reverseEntryId);
      if (a.status !== 'CANCELLED') continue;
      if (a.kind === 'BAD_DEBT_WRITEOFF' && a.reverseEntryId) skip.add(a.reverseEntryId);
      if (a.kind === 'CREDIT_REFUND') skip.add(a.id);
    }
    for (const r of rows) {
      if (skip.has(r.id)) continue;
      const day = dayOf(r.entryDate);
      if (!day) continue;
      const undated = !manualIds.has(r.id) && isImportMoment(r.entryDate);
      push(adjustments, r.customerId, [{
        day, amount: Number(r.debit), dueDay: dueDayOf(day, null, byId.get(r.customerId)?.paymentDays), ...(undated && { undated: true }),
      }]);
    }
  }

  for (const c of debtors) {
    out.set(c.id, customerAging({
      balance: Number(c.balance),
      openInvoices: open.get(c.id) ?? [],
      adjustments: adjustments.get(c.id) ?? [],
      today,
    }));
  }
  return out;
}
