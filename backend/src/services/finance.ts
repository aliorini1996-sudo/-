/**
 * المحرّك المالي للمنصّة — يحسب الصورة المالية آلياً من مصادر الحقيقة القائمة.
 *
 * المبدأ الحاكم: **لا رقم يُدخَل يدوياً إن أمكن اشتقاقه.**
 *  • الإيراد من `payment_links` الموسومة `paid` (الحقيقة من webhook ميسر).
 *  • MRR من الاشتراكات الفعّالة وباقاتها — لا من تقدير.
 *  • المصروف من `operating_expenses`، والمتكرّر يُحتسب في كل شهر يسري فيه
 *    دون إعادة إدخال — وهذا ما يجعل «الأتمتة الكاملة» ممكنة لا شعاراً.
 *
 * الضريبة: أسعارنا **شاملة** ضريبة القيمة المضافة (كما في التسعير المعتمد)،
 * فالضريبة تُستخرَج من المبلغ لا تُضاف إليه: القيمة = الإجمالي × النسبة/(100+النسبة).
 * الخلط بين الاستخراج والإضافة أشهر خطأ محاسبي في أنظمة الاشتراكات.
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

/** عمولة البوابة على مبلغ محصّل */
export function gatewayFee(totalSar: number, pct = GATEWAY_FEE_PCT): number {
  return round2((totalSar * pct) / 100);
}

/** يستخرج الضريبة من مبلغ **شامل** لها (لا يضيفها) */
export function vatFromInclusive(totalSar: number, pct = VAT_PCT): number {
  return round2((totalSar * pct) / (100 + pct));
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** حدّا الشهر (بداية أول يوم وبداية أول يوم من الشهر التالي) */
function monthBounds(year: number, month1to12: number): { from: Date; to: Date } {
  return {
    from: new Date(Date.UTC(year, month1to12 - 1, 1)),
    to: new Date(Date.UTC(year, month1to12, 1)),
  };
}

/** هل يسري هذا المصروف المتكرّر في الشهر المعطى؟ */
function recurringAppliesTo(startsOn: Date, endsOn: Date | null, from: Date, to: Date): boolean {
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
  expensesSar: number;         // مصروفات الشهر (متكرّرة + لمرّة)
  vatPaidSar: number;          // ضريبة مدخلات على المصروفات
  vatDueSar: number;           // المستحقّ للهيئة = مخرجات − مدخلات
  profitSar: number;           // صافي = صافي الإيراد − المصروفات
  marginPct: number;           // هامش الربح
  paidCount: number;           // عدد المدفوعات
}

/** الصورة المالية لشهر واحد — كل رقم مشتقّ لا مُدخَل */
export async function monthlyFinance(year: number, month: number): Promise<MonthlyFinance> {
  const { from, to } = monthBounds(year, month);

  const [paid, oneOff, recurring] = await Promise.all([
    prisma.paymentLink.findMany({
      where: { status: 'paid', paidAt: { gte: from, lt: to } },
      select: { amountHalalas: true },
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

  const revenueSar = round2(paid.reduce((s, p) => s + p.amountHalalas / 100, 0));
  const vatCollectedSar = vatFromInclusive(revenueSar);
  const revenueNetSar = round2(revenueSar - vatCollectedSar);

  const rec = recurring.filter((e) => recurringAppliesTo(e.startsOn, e.endsOn, from, to));
  const expensesSar = round2([...oneOff, ...rec].reduce((s, e) => s + e.amountSar, 0));
  const vatPaidSar = round2([...oneOff, ...rec].reduce((s, e) => s + (e.vatSar || 0), 0));

  // العمولة تُحسب على المبلغ الكامل المحصّل (البوابة تخصم من الإجمالي لا من الصافي)
  const gatewayFeeSar = gatewayFee(revenueSar);
  const profitSar = round2(revenueNetSar - expensesSar - gatewayFeeSar);
  return {
    year, month,
    revenueSar, revenueNetSar, vatCollectedSar,
    gatewayFeeSar, expensesSar, vatPaidSar,
    vatDueSar: round2(vatCollectedSar - vatPaidSar),
    profitSar,
    marginPct: revenueNetSar > 0 ? round2((profitSar / revenueNetSar) * 100) : 0,
    paidCount: paid.length,
  };
}

export interface FinanceSnapshot {
  vatPct: number;
  gatewayFeePct: number;
  mrrSar: number;                 // إيراد شهري متكرّر من الاشتراكات الفعّالة
  arrSar: number;                 // سنويّ
  activeTenants: number;
  trialTenants: number;
  expiringSoon: number;           // اشتراكات تنتهي خلال ٣٠ يوماً
  monthlyRecurringCostSar: number;
  runwayNote: string;
  current: MonthlyFinance;
  months: MonthlyFinance[];       // آخر ٦ أشهر
  byCategory: { category: string; amountSar: number }[];
}

/** أسعار الباقات — مصدر واحد يطابق التسعير المعتمد على الموقع */
const PLAN_MONTHLY_SAR: Record<string, number> = { basic: 299, pro: 599, trial: 0, enterprise: 0 };

export async function financeSnapshot(): Promise<FinanceSnapshot> {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;

  const soon = new Date(now.getTime() + 30 * 86400_000);
  const [tenants, expenses] = await Promise.all([
    prisma.tenant.findMany({
      where: { isActive: true },
      select: { plan: true, subscriptionEndsAt: true },
    }),
    prisma.operatingExpense.findMany({
      where: { isRecurring: true },
      select: { amountSar: true, category: true, startsOn: true, endsOn: true },
    }),
  ]);

  // MRR: الاشتراك الفعّال غير المنتهي فقط — المنتهي إيرادٌ توقّف لا متكرّر
  const paying = tenants.filter((t) =>
    PLAN_MONTHLY_SAR[t.plan] > 0 && (!t.subscriptionEndsAt || t.subscriptionEndsAt > now));
  const mrrSar = round2(paying.reduce((s, t) => s + (PLAN_MONTHLY_SAR[t.plan] || 0), 0));

  const activeRec = expenses.filter((e) => !e.endsOn || e.endsOn > now);
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
    activeTenants: paying.length,
    trialTenants: tenants.filter((t) => t.plan === 'trial' || !PLAN_MONTHLY_SAR[t.plan]).length,
    expiringSoon: tenants.filter((t) => t.subscriptionEndsAt && t.subscriptionEndsAt > now && t.subscriptionEndsAt <= soon).length,
    monthlyRecurringCostSar,
    runwayNote: netMonthly >= 0
      ? `التشغيل مغطّى: فائض شهري ${netMonthly} ر.س بعد الضريبة والتكاليف`
      : `عجز شهري ${Math.abs(netMonthly)} ر.س — الإيراد المتكرّر لا يغطّي التكاليف`,
    current: months[months.length - 1],
    months,
    byCategory: [...byCat.entries()].map(([category, amountSar]) => ({ category, amountSar }))
      .sort((a, b) => b.amountSar - a.amountSar),
  };
}
