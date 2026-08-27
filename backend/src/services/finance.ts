/**
 * المحرّك المالي للمنصّة — يحسب الصورة المالية آلياً من مصادر الحقيقة القائمة.
 *
 * المبدأ الحاكم: **لا رقم يُدخَل يدوياً إن أمكن اشتقاقه — ولا رقم يُشتقّ من
 * حقلٍ لا يقف خلفه مال.**
 *  • الإيراد من `payment_links` الموسومة `paid` (الحقيقة من ميسر بعد مطابقة
 *    المبلغ والعملة).
 *  • MRR من **دفعات الاشتراك المؤكَّدة** لا من حقل `plan`. الفرق ليس تفصيلاً:
 *    `plan` افتراضه "basic" ولا تعرضه واجهة إنشاء الشركة أصلاً، فاشتقاق MRR منه
 *    كان يحوّل كل شركة أُنشئت يدوياً — ولو تجريبية مجانية — إلى ٢٩٩ ر.س شهرياً
 *    إلى الأبد. الرقم الناتج كان يعدّ السجلّات لا الريالات.
 *  • المصروف من `operating_expenses`، والمتكرّر يُحتسب في كل شهر يسري فيه.
 *
 * الضريبة: أسعارنا **شاملة** ضريبة القيمة المضافة (كما في التسعير المعتمد)،
 * فالضريبة تُستخرَج من المبلغ لا تُضاف إليه: القيمة = الإجمالي × النسبة/(100+النسبة).
 * الخلط بين الاستخراج والإضافة أشهر خطأ محاسبي في أنظمة الاشتراكات.
 *
 * الزمن: كل حدود الأشهر **بتوقيت الرياض (UTC+3)** لا UTC، وإلا سقطت مدفوعات
 * الساعات الثلاث الأولى من كل شهر في الشهر السابق فاختلّ الإقرار الضريبي.
 */

import prisma from '../config/database';

/** نسبة ضريبة القيمة المضافة السعودية — مصدر واحد لا يتكرّر في الحسابات */
export const VAT_PCT = Number(process.env.PLATFORM_VAT_PCT || 15);

/**
 * عمولة بوابة الدفع (ميسر) — **نسبة من كل مبلغ محصّل**، لا مصروف شهري ثابت.
 * تسجيلها مصروفاً ثابتاً كان سيتقادم مع كل تغيّر في حجم المبيعات؛ وحسابها هنا
 * يجعلها تتبع الإيراد آلياً: شهرٌ بلا مبيعات = عمولة صفر.
 */
export const GATEWAY_FEE_PCT = Number(process.env.GATEWAY_FEE_PCT || 3);

/** فرق توقيت الرياض عن UTC بالمللي ثانية (لا توقيت صيفي في السعودية) */
const RIYADH_OFFSET_MS = 3 * 3600_000;

/** عمولة البوابة على مبلغ محصّل */
export function gatewayFee(totalSar: number, pct = GATEWAY_FEE_PCT): number {
  return round2((totalSar * pct) / 100);
}

/** يستخرج الضريبة من مبلغ **شامل** لها (لا يضيفها) */
export function vatFromInclusive(totalSar: number, pct = VAT_PCT): number {
  return round2((totalSar * pct) / (100 + pct));
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * حدّا الشهر بتوقيت الرياض، معبَّراً عنهما بلحظتين مطلقتين.
 * أول أغسطس ٠٠:٠٠ بالرياض = ٣١ يوليو ٢١:٠٠ UTC — وهذا ما يجعل دفعةً تمّت
 * الساعة الواحدة فجراً أول الشهر تُحتسب في شهرها الصحيح.
 */
export function monthBounds(year: number, month1to12: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(year, month1to12 - 1, 1) - RIYADH_OFFSET_MS),
    to: new Date(Date.UTC(year, month1to12, 1) - RIYADH_OFFSET_MS),
  };
}

/** اليوم بتوقيت الرياض بصيغة YYYY-MM-DD */
function riyadhDate(d: Date): string {
  return new Date(d.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** هل يسري هذا المصروف المتكرّر في الشهر المعطى؟ */
export function recurringAppliesTo(startsOn: Date, endsOn: Date | null, from: Date, to: Date): boolean {
  if (startsOn >= to) return false;            // بدأ بعد نهاية الشهر
  if (endsOn && endsOn < from) return false;   // انتهى قبل بداية الشهر
  return true;
}

export interface MonthlyFinance {
  year: number;
  month: number;
  revenueSar: number;          // محصّل فعلاً هذا الشهر (شامل الضريبة)
  revenueNetSar: number;       // بعد استخراج الضريبة
  vatCollectedSar: number;     // ضريبة مخرجات
  gatewayFeeSar: number;       // عمولة بوابة الدفع (٣٪ من المحصّل)
  expensesSar: number;         // مصروفات الشهر نقداً (متكرّرة + لمرّة، شاملة ضريبتها)
  vatPaidSar: number;          // ضريبة مدخلات قابلة للخصم على المصروفات
  vatDueSar: number;           // المستحقّ للهيئة = مخرجات − مدخلات
  profitSar: number;           // صافي = صافي الإيراد − صافي المصروف − العمولة
  marginPct: number;           // هامش الربح
  paidCount: number;           // عدد المدفوعات

  // ——— الدفع الإلكتروني (تحصيل نيابةً عن الشركات) ———
  paylinkCollectedSar: number; // ما حُصّل لحساب الشركات — **ليس إيرادنا**
  paylinkFeeSar: number;       // عمولتنا شاملة الضريبة — إيرادٌ لنا
  paylinkFeeVatSar: number;    // ضريبة عمولتنا (مستخرَجة منها)
  paylinkCount: number;        // عدد الدفعات المحصّلة
}

/** الصورة المالية لشهر واحد — كل رقم مشتقّ لا مُدخَل */
export async function monthlyFinance(year: number, month: number): Promise<MonthlyFinance> {
  const { from, to } = monthBounds(year, month);

  const [paid, collected, fees, oneOff, recurring] = await Promise.all([
    prisma.paymentLink.findMany({
      where: { status: 'paid', paidAt: { gte: from, lt: to } },
      select: { amountHalalas: true },
    }),
    // تحصيل نيابةً عن الشركات — يمرّ بحسابنا ولا يملكه أحدٌ منّا
    prisma.settlementEntry.aggregate({
      where: { kind: 'COLLECTED', createdAt: { gte: from, lt: to } },
      _sum: { amount: true }, _count: true,
    }),
    // عمولتنا على ذلك التحصيل — هذه وحدها إيرادنا
    prisma.settlementEntry.aggregate({
      where: { kind: 'FEE', createdAt: { gte: from, lt: to } },
      _sum: { amount: true, feeNet: true, feeVat: true },
    }),
    prisma.operatingExpense.findMany({
      where: { isRecurring: false, startsOn: { gte: from, lt: to } },
      select: { amountSar: true, vatSar: true },
    }),
    prisma.operatingExpense.findMany({
      where: { isRecurring: true },
      select: { amountSar: true, vatSar: true, startsOn: true, endsOn: true },
    }),
  ]);

  const subsSar = round2(paid.reduce((s, p) => s + p.amountHalalas / 100, 0));

  // ——— الدفع الإلكتروني: تمييز مالنا من مال غيرنا ———
  //
  // ما يُحصَّل لعملاء الشركات يمرّ بحسابنا لكنه **أمانة لا إيراد**. عدّه إيراداً
  // كان سيضخّم الرقم أضعافاً ويضاعف الضريبة على مالٍ لا نملكه. إيرادنا هو
  // العمولة وحدها، وهي مخزَّنة مفكوكة سلفاً (feeNet + feeVat) على قيد FEE،
  // فلا نعيد استخراج الضريبة منها ونخاطر بانحراف هللة عن دفتر الأمانات.
  const paylinkCollectedSar = round2(Number(collected._sum.amount ?? 0));
  const paylinkFeeSar = round2(Math.abs(Number(fees._sum.amount ?? 0)));
  const paylinkFeeVatSar = round2(Number(fees._sum.feeVat ?? 0));
  const paylinkFeeNetSar = round2(Number(fees._sum.feeNet ?? 0));

  const revenueSar = round2(subsSar + paylinkFeeSar);
  const vatCollectedSar = round2(vatFromInclusive(subsSar) + paylinkFeeVatSar);
  const revenueNetSar = round2(round2(subsSar - vatFromInclusive(subsSar)) + paylinkFeeNetSar);

  const rec = recurring.filter((e) => recurringAppliesTo(e.startsOn, e.endsOn, from, to));
  const all = [...oneOff, ...rec];
  const expensesSar = round2(all.reduce((s, e) => s + e.amountSar, 0));
  const vatPaidSar = round2(all.reduce((s, e) => s + (e.vatSar || 0), 0));

  // عمولة البوابة تُحسب على **كل** ما مرّ بها: اشتراكاتنا + التحصيل نيابةً عن
  // الشركات. وهذا هو الفرق الحاسم في الدفع الإلكتروني: ميسر تقتطع نسبتها من
  // الألف المحصَّلة كاملةً لا من عمولتنا البالغة واحداً وأربعين — فحسابها على
  // إيرادنا وحده كان سيُظهر ربحاً وهمياً على خدمة هامشها رقيق أصلاً.
  const gatewayBaseSar = round2(subsSar + paylinkCollectedSar);
  const gatewayFeeSar = gatewayFee(gatewayBaseSar);

  // الربح يقارن **صافياً بصافٍ**: الإيراد استُخرجت ضريبته، فالمصروف تُستبعَد
  // ضريبته القابلة للخصم كذلك — وإلا خُصمت المدخلات مرّتين (داخل المصروف وفي
  // المستحقّ للهيئة) فظهر الربح أقلّ ممّا هو.
  const expensesNetSar = round2(expensesSar - vatPaidSar);
  const profitSar = round2(revenueNetSar - expensesNetSar - gatewayFeeSar);
  return {
    year, month,
    revenueSar, revenueNetSar, vatCollectedSar,
    gatewayFeeSar, expensesSar, vatPaidSar,
    vatDueSar: round2(vatCollectedSar - vatPaidSar),
    profitSar,
    marginPct: revenueNetSar > 0 ? round2((profitSar / revenueNetSar) * 100) : 0,
    paidCount: paid.length,
    paylinkCollectedSar, paylinkFeeSar, paylinkFeeVatSar,
    paylinkCount: collected._count,
  };
}

/**
 * المهلة التي بعدها يُعدّ المصروف المتكرّر متقادماً.
 * مبلغٌ أُدخل مرّة ولم يُراجَع يظلّ يُحتسب بقيمته القديمة إلى الأبد — وهذا أخطر
 * من غيابه لأنه يبدو صحيحاً. شهران يكفيان لالتقاط تغيّر فاتورة استضافة.
 */
export const EXPENSE_STALE_DAYS = Number(process.env.EXPENSE_STALE_DAYS || 60);

export function staleDaysOf(reviewedAt: Date, now = new Date()): number {
  return Math.floor((now.getTime() - reviewedAt.getTime()) / 86400_000);
}

export interface FinanceSnapshot {
  vatPct: number;
  gatewayFeePct: number;
  mrrSar: number;                 // إيراد شهري متكرّر من اشتراكات **مدفوعة**
  arrSar: number;                 // سنويّ
  payingTenants: number;          // شركات لها دفعة اشتراك مؤكَّدة سارية
  unpaidTenants: number;          // شركات فعّالة بلا أي دفعة اشتراك (تجريبية/مجانية)
  totalTenants: number;           // مجموع الشركات الفعّالة
  expiringSoon: number;           // اشتراكات مدفوعة تنتهي خلال ٣٠ يوماً
  mrrBasis: string;               // شرح مصدر MRR بالعربية — كي لا يكون رقماً بلا سند
  monthlyRecurringCostSar: number;
  staleExpenses: number;          // مصروفات متكرّرة لم تُراجَع منذ المهلة
  staleDaysThreshold: number;
  runwayNote: string;
  current: MonthlyFinance;
  months: MonthlyFinance[];       // آخر ٦ أشهر
  byCategory: { category: string; amountSar: number }[];
}

/**
 * آخر دفعة اشتراك مؤكَّدة لكل شركة.
 *
 * هذه هي **الدليل الوحيد المقبول** على إيراد متكرّر: دفعةٌ مرّت ببوابة ميسر،
 * طوبقت عملتُها ومبلغُها، ومدّت الاشتراك (`months > 0`). ما عداها — لافتة باقة،
 * تاريخ انتهاء كتبه المالك يدوياً، شركة فعّالة — لا يثبت وصول ريال واحد.
 */
async function latestSubscriptionPayments(): Promise<Map<string, { amountSar: number; months: number }>> {
  const rows = await prisma.paymentLink.findMany({
    where: { status: 'paid', months: { gt: 0 }, tenantId: { not: null } },
    orderBy: { paidAt: 'desc' },
    select: { tenantId: true, amountHalalas: true, months: true },
  });
  const latest = new Map<string, { amountSar: number; months: number }>();
  for (const r of rows) {
    if (!r.tenantId || latest.has(r.tenantId)) continue;  // الأحدث أولاً بحكم الترتيب
    latest.set(r.tenantId, { amountSar: round2(r.amountHalalas / 100), months: r.months });
  }
  return latest;
}

export async function financeSnapshot(): Promise<FinanceSnapshot> {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;

  const soon = new Date(now.getTime() + 30 * 86400_000);
  const [tenants, expenses, subs] = await Promise.all([
    prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true, subscriptionEndsAt: true },
    }),
    prisma.operatingExpense.findMany({
      where: { isRecurring: true },
      select: { amountSar: true, category: true, startsOn: true, endsOn: true, reviewedAt: true },
    }),
    latestSubscriptionPayments(),
  ]);

  // MRR: الشركة تُحتسب فقط إن دفعت اشتراكاً فعلاً **و** لم ينتهِ اشتراكها بعد.
  // ومساهمتها = المبلغ المدفوع مقسوماً على شهوره، فدفعة سنوية لا تُقرأ إيراد شهر.
  const paying = tenants.filter((t) =>
    subs.has(t.id) && (!t.subscriptionEndsAt || t.subscriptionEndsAt > now));
  const mrrSar = round2(paying.reduce((s, t) => {
    const p = subs.get(t.id)!;
    return s + p.amountSar / p.months;
  }, 0));

  // المتكرّر السّاري الآن: لم ينتهِ **ولم يبدأ بعد في المستقبل**. إغفال البداية
  // كان يجعل مصروفاً مجدولاً بعد ثلاثة أشهر يضخّم تكلفة اليوم وينذر بعجز وهميّ.
  const activeRec = expenses.filter((e) => e.startsOn <= now && (!e.endsOn || e.endsOn > now));
  const monthlyRecurringCostSar = round2(activeRec.reduce((s, e) => s + e.amountSar, 0));

  const byCat = new Map<string, number>();
  for (const e of activeRec) byCat.set(e.category, round2((byCat.get(e.category) || 0) + e.amountSar));

  // آخر ٦ أشهر — يُحسب تسلسلياً كي لا نفتح ست معاملات متوازية على القاعدة
  const months: MonthlyFinance[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(await monthlyFinance(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }

  const netMonthly = round2(mrrSar - vatFromInclusive(mrrSar) - gatewayFee(mrrSar) - monthlyRecurringCostSar);
  return {
    vatPct: VAT_PCT,
    gatewayFeePct: GATEWAY_FEE_PCT,
    mrrSar,
    arrSar: round2(mrrSar * 12),
    payingTenants: paying.length,
    unpaidTenants: tenants.length - paying.length,
    totalTenants: tenants.length,
    expiringSoon: paying.filter((t) => t.subscriptionEndsAt && t.subscriptionEndsAt <= soon).length,
    mrrBasis: paying.length === 0
      ? 'لا اشتراك مدفوع سارٍ — MRR صفر حتى تصل أول دفعة تجديد عبر ميسر'
      : `من ${paying.length} اشتراك مدفوع سارٍ عبر ميسر`,
    monthlyRecurringCostSar,
    staleExpenses: activeRec.filter((e) => staleDaysOf(e.reviewedAt, now) >= EXPENSE_STALE_DAYS).length,
    staleDaysThreshold: EXPENSE_STALE_DAYS,
    runwayNote: mrrSar === 0
      ? `لا إيراد متكرّر بعد — التكاليف الشهرية ${monthlyRecurringCostSar} ر.س مموّلة ذاتياً`
      : netMonthly >= 0
        ? `التشغيل مغطّى: فائض شهري ${netMonthly} ر.س بعد الضريبة والتكاليف`
        : `عجز شهري ${Math.abs(netMonthly)} ر.س — الإيراد المتكرّر لا يغطّي التكاليف`,
    current: months[months.length - 1],
    months,
    byCategory: [...byCat.entries()].map(([category, amountSar]) => ({ category, amountSar }))
      .sort((a, b) => b.amountSar - a.amountSar),
  };
}

export interface RevenueRow {
  id: string;
  clientName: string;      // اسم الشركة الدافعة، أو «غير مرتبط» إن لم تُربَط الدفعة
  description: string;
  amountSar: number;
  vatSar: number;          // ضريبة مستخرَجة من المبلغ (أسعارنا شاملة)
  gatewayFeeSar: number;   // عمولة ميسر ٣٪
  netSar: number;          // ما يصل الحساب فعلاً بعد الضريبة والعمولة
  isRecurring: boolean;    // اشتراك متكرّر (months > 0) أم دفعة لمرّة
  months: number;
  paidAt: string;
}

export interface RevenueList {
  rows: RevenueRow[];
  totalCount: number;      // كل المدفوعات المؤكَّدة، لا المعروض فقط
  totalSar: number;        // مجموع كل المدفوعات — يطابق ما يجمعه المالك يدوياً
  truncated: boolean;      // هل أُخفيت أسطر؟ الصمت هنا كان سيُقرأ «هذا كل شيء»
}

/**
 * قائمة الإيرادات — مدفوعات ميسر المؤكَّدة، أمام كلٍّ اسم عميلها وهل هي متكرّرة.
 *
 * «متكرّر» ليس حقلاً يُدخله أحد بل **يُشتقّ من `months`**: الدفعة التي تمدّد
 * اشتراكاً (months > 0) إيرادٌ متكرّر بطبعه، وما عداها دفعة لمرّة. اشتقاقه
 * يمنع تضارباً بين وسمٍ يدويّ وحقيقة الاشتراك.
 *
 * تُعاد المجاميع من **كل** المدفوعات لا من الصفحة المعروضة، كي يطابق ما يجمعه
 * المالك بعينه ما تقوله البطاقات فوق القائمة.
 */
export async function revenueRows(limit = 100): Promise<RevenueList> {
  const [rows, agg] = await Promise.all([
    prisma.paymentLink.findMany({
      where: { status: 'paid' },
      orderBy: { paidAt: 'desc' },
      take: limit,
      select: { id: true, tenantId: true, description: true, amountHalalas: true, months: true, paidAt: true },
    }),
    prisma.paymentLink.aggregate({
      where: { status: 'paid' },
      _count: { _all: true },
      _sum: { amountHalalas: true },
    }),
  ]);

  // اسم العميل من المستأجر المرتبط — استعلام واحد لكل المعرّفات لا واحد لكل صفّ
  const ids = [...new Set(rows.map((r) => r.tenantId).filter(Boolean) as string[])];
  const names = new Map<string, string>();
  if (ids.length) {
    const ts = await prisma.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    for (const t of ts) names.set(t.id, t.name);
  }

  const totalCount = agg._count._all;
  return {
    totalCount,
    totalSar: round2((agg._sum.amountHalalas || 0) / 100),
    truncated: totalCount > rows.length,
    rows: rows.map((r) => {
      const amountSar = round2(r.amountHalalas / 100);
      const vatSar = vatFromInclusive(amountSar);
      const feeSar = gatewayFee(amountSar);
      return {
        id: r.id,
        clientName: (r.tenantId && names.get(r.tenantId)) || 'غير مرتبط بشركة',
        description: r.description,
        amountSar,
        vatSar,
        gatewayFeeSar: feeSar,
        netSar: round2(amountSar - vatSar - feeSar),
        isRecurring: r.months > 0,
        months: r.months,
        paidAt: r.paidAt ? riyadhDate(r.paidAt) : '',
      };
    }),
  };
}


export interface QuarterFinance {
  year: number;
  quarter: number;             // ١..٤
  months: MonthlyFinance[];
  revenueSar: number;
  vatCollectedSar: number;
  vatPaidSar: number;
  vatDueSar: number;           // ما يُقدَّم للهيئة عن الفترة
  expensesSar: number;
  profitSar: number;
  periodLabel: string;         // «١ يوليو – ٣٠ سبتمبر ٢٠٢٦»
}

const MONTH_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

/**
 * الصورة المالية لربع سنة — الفترة التي تُقدَّم بها الإقرارات فعلاً.
 * اللوحة الشهرية وحدها كانت تترك المالك يجمع ثلاثة أرقام بيده قبل كل إقرار،
 * وجمعُ اليد هو حيث يقع الخطأ.
 */
export async function quarterFinance(year: number, quarter: number): Promise<QuarterFinance> {
  const first = (quarter - 1) * 3 + 1;
  const months: MonthlyFinance[] = [];
  for (let i = 0; i < 3; i++) months.push(await monthlyFinance(year, first + i));

  const sum = (f: (m: MonthlyFinance) => number) => round2(months.reduce((s, m) => s + f(m), 0));
  const vatCollectedSar = sum((m) => m.vatCollectedSar);
  const vatPaidSar = sum((m) => m.vatPaidSar);
  const lastDay = new Date(Date.UTC(year, first + 2, 0)).getUTCDate();
  return {
    year, quarter, months,
    revenueSar: sum((m) => m.revenueSar),
    vatCollectedSar, vatPaidSar,
    vatDueSar: round2(vatCollectedSar - vatPaidSar),
    expensesSar: sum((m) => m.expensesSar),
    profitSar: sum((m) => m.profitSar),
    periodLabel: `١ ${MONTH_AR[first - 1]} – ${lastDay} ${MONTH_AR[first + 1]} ${year}`,
  };
}

export interface SettlementRow {
  tenantId: string;
  name: string;
  balanceSar: number;        // المستحقّ للشركة الآن — ما يجب أن نحوّله لها
  collectedSar: number;      // إجمالي ما حُصّل لها منذ البداية
  feeSar: number;            // إجمالي عمولتنا منها
  paidOutSar: number;        // إجمالي ما ورّدناه لها
  payments: number;
  feePct: number;
  feeFlat: number;
  lastPayoutAt: string | null;
  lastPayoutSar: number | null;
  lastCollectedAt: string | null;
  negative: boolean;         // رصيد سالب = الشركة مدينة لنا (استرداد بعد توريد)
}

export interface SettlementSummary {
  rows: SettlementRow[];
  totalPayableSar: number;   // ما ندين به لكل الشركات مجتمعةً
  totalCollectedSar: number;
  totalFeeSar: number;
  totalPaidOutSar: number;
  negativeCount: number;
  nextPayoutLabel: string;   // موعد التوريد القادم (الخميس)
}

/** الخميس القادم بتوقيت الرياض — يوم التوريد المتّفق عليه */
function nextThursday(now = new Date()): string {
  const r = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const days = (4 - r.getUTCDay() + 7) % 7 || 7;   // 4 = الخميس
  const d = new Date(r.getTime() + days * 86400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * أمانات الشركات — كم ندين لكل شركة وما يجب أن نحوّله لها.
 *
 * **هذا المال ليس لنا.** يمرّ بحسابنا لدى ميسر ونحن أُمناء عليه حتى نورّده،
 * فعرضه داخل «الإدارة المالية» ليس تحسيناً بل شرطُ صدقها: لوحةٌ تعرض رصيدنا
 * دون أن تقول إن جزءاً منه ملك غيرنا تعرض رقماً صحيحاً بمعنى خاطئ.
 *
 * كل رقم هنا **مجموع قيود** لا رصيد مخزَّن — فلا رقم ثانٍ ينحرف عن مصدره.
 */
export async function settlementSummary(): Promise<SettlementSummary> {
  const tenants = await prisma.tenant.findMany({
    where: { paylinkEnabled: true },
    select: { id: true, name: true, paylinkFeePct: true, paylinkFeeFlat: true },
    orderBy: { name: 'asc' },
  });
  if (!tenants.length) {
    return {
      rows: [], totalPayableSar: 0, totalCollectedSar: 0, totalFeeSar: 0,
      totalPaidOutSar: 0, negativeCount: 0, nextPayoutLabel: nextThursday(),
    };
  }

  const ids = tenants.map((t) => t.id);
  // تجميعة واحدة لكل الشركات بدل استعلامين لكل شركة — الحلقة كانت تُنتج
  // ٢×عدد الشركات من الرحلات إلى القاعدة على نقطة يفتحها المالك كثيراً.
  const [grouped, payouts, lastCollected] = await Promise.all([
    prisma.settlementEntry.groupBy({
      by: ['tenantId', 'kind'],
      where: { tenantId: { in: ids } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.payout.findMany({
      where: { tenantId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      select: { tenantId: true, amount: true, createdAt: true },
    }),
    prisma.settlementEntry.findMany({
      where: { tenantId: { in: ids }, kind: 'COLLECTED' },
      orderBy: { createdAt: 'desc' },
      select: { tenantId: true, createdAt: true },
    }),
  ]);

  const byTenant = new Map<string, Record<string, { sum: number; count: number }>>();
  for (const g of grouped) {
    const m = byTenant.get(g.tenantId) ?? {};
    m[g.kind] = { sum: Number(g._sum.amount ?? 0), count: g._count._all };
    byTenant.set(g.tenantId, m);
  }
  const lastPayout = new Map<string, { amount: number; createdAt: Date }>();
  for (const p of payouts) if (!lastPayout.has(p.tenantId)) lastPayout.set(p.tenantId, p);
  const lastColl = new Map<string, Date>();
  for (const c of lastCollected) if (!lastColl.has(c.tenantId)) lastColl.set(c.tenantId, c.createdAt);

  const rows: SettlementRow[] = tenants.map((t) => {
    const m = byTenant.get(t.id) ?? {};
    // الرصيد مجموع كل القيود بإشاراتها — لا يُعاد بناؤه من الأجزاء كي لا
    // يظهر رقمان لنفس الحقيقة فينحرف أحدهما يوماً
    const balanceSar = round2(Object.values(m).reduce((s, v) => s + v.sum, 0));
    const lp = lastPayout.get(t.id);
    const lc = lastColl.get(t.id);
    return {
      tenantId: t.id,
      name: t.name,
      balanceSar,
      collectedSar: round2(m.COLLECTED?.sum ?? 0),
      feeSar: round2(Math.abs(m.FEE?.sum ?? 0)),
      paidOutSar: round2(Math.abs(m.PAYOUT?.sum ?? 0)),
      payments: m.COLLECTED?.count ?? 0,
      feePct: t.paylinkFeePct,
      feeFlat: t.paylinkFeeFlat,
      lastPayoutAt: lp ? riyadhDate(lp.createdAt) : null,
      lastPayoutSar: lp ? round2(lp.amount) : null,
      lastCollectedAt: lc ? riyadhDate(lc) : null,
      negative: balanceSar < -0.005,
    };
  });

  return {
    rows,
    // الموجب وحده هو ما ندين به؛ جمع السالب معه كان سيُخفي دَيناً على شركة
    // خلف فائض شركة أخرى فيظهر إجمالي التوريد أقلّ من الواجب
    totalPayableSar: round2(rows.filter((r) => r.balanceSar > 0).reduce((s, r) => s + r.balanceSar, 0)),
    totalCollectedSar: round2(rows.reduce((s, r) => s + r.collectedSar, 0)),
    totalFeeSar: round2(rows.reduce((s, r) => s + r.feeSar, 0)),
    totalPaidOutSar: round2(rows.reduce((s, r) => s + r.paidOutSar, 0)),
    negativeCount: rows.filter((r) => r.negative).length,
    nextPayoutLabel: nextThursday(),
  };
}
