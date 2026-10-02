/**
 * المندوب الذكي — عدّادات الاستهلاك اليومي لكل مندوب (ضابط كلفة Google والنموذج اللغوي).
 *
 * **الحجز ذرّي قبل العمل المكلف:** «اقرأ ثم نفّذ ثم زِد» يسقط أمام الطلبات المتزامنة (مئة طلب تقرأ الصفر معاً
 * فتمرّ كلها). فالحجز تحديثٌ شرطيّ واحد في القاعدة: يزيد العدّاد فقط إن كان دون الحدّ، وcount=1 إذنٌ بالعمل.
 * الرموز والحارس تُضاف بعد الرد — في كل مسار صُرف فيه النموذج، ومنه الفشل والقالب.
 */
import prisma from '../config/database';

export type CounterField = 'searches' | 'estimates' | 'chatTurns' | 'outcomes';
export type UsageField = CounterField | 'tokensIn' | 'tokensOut' | 'guardRegen' | 'guardFallback';

/** يوم الاستهلاك بتوقيت الرياض (YYYY-MM-DD). */
export function usageDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

const key = (tid: string, repId: string, day: string) => ({ tenantId_salesRepId_day: { tenantId: tid, salesRepId: repId, day } });

/**
 * حجز ذرّي لوحدة (أو أكثر): يوم الحجز = مسموح وقد احتُسب (يُمرَّر لـrefundUsage)؛ null = بلغ الحدّ ولم يُحتسب شيء.
 * (n ≤ 0 ⇒ يوم اليوم بلا حجز.)
 */
export async function reserveUsage(tid: string, repId: string, field: CounterField, limit: number, n = 1): Promise<string | null> {
  const day = usageDay();
  if (n <= 0) return day;
  if (limit < n) return null;
  await prisma.aiUsageDaily.createMany({ data: [{ tenantId: tid, salesRepId: repId, day }], skipDuplicates: true });
  const r = await prisma.aiUsageDaily.updateMany({
    where: { tenantId: tid, salesRepId: repId, day, [field]: { lte: limit - n } } as never,
    data: { [field]: { increment: n } } as never,
  });
  return r.count === 1 ? day : null;
}

/**
 * ردّ حجزٍ لم يُصرف (فشل Google قبل أي كلفة، أو تعذّر النموذج). لا ينزل تحت الصفر. day = يوم الحجز نفسه
 * (ردٌّ بعد منتصف الليل لا يُنقص عدّاد اليوم الجديد).
 */
export async function refundUsage(tid: string, repId: string, field: CounterField, n = 1, day = usageDay()): Promise<void> {
  await prisma.aiUsageDaily.updateMany({
    where: { tenantId: tid, salesRepId: repId, day, [field]: { gte: n } } as never,
    data: { [field]: { decrement: n } } as never,
  });
}

/** إضافة عدّادات بلا حدّ (الرموز، الحارس، النتائج). */
export async function addUsage(tid: string, repId: string, inc: Partial<Record<UsageField, number>>): Promise<void> {
  const clean = Object.fromEntries(Object.entries(inc).filter(([, v]) => (v ?? 0) > 0).map(([k, v]) => [k, Math.round(v as number)]));
  if (!Object.keys(clean).length) return;
  const day = usageDay();
  await prisma.aiUsageDaily.upsert({
    where: key(tid, repId, day),
    create: { tenantId: tid, salesRepId: repId, day, ...clean },
    update: Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, { increment: v }])),
  });
}

export async function usageToday(tid: string, repId: string) {
  return prisma.aiUsageDaily.findUnique({ where: key(tid, repId, usageDay()) });
}
