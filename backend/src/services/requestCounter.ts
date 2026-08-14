import prisma from '../config/database';

// «اليوم» بتوقيت الرياض (UTC+3 ثابتة) — لمحاذاة العدّ مع بقيّة مقاييس المالك.
const RIYADH_OFFSET_MS = 3 * 3600000;
export function riyadhDay(now: number = Date.now()): string {
  return new Date(now + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

const RETENTION_DAYS = 60;

// مخزنٌ في الذاكرة: مفتاح `kind|userId|tenantId|day` → عدد متراكم منذ آخر إفراغ.
// dsd-backend نسخة واحدة، فمخزنٌ واحد يكفي؛ الإفراغ الدوريّ يجمع الدلتا في القاعدة.
const buffer = new Map<string, number>();

/** زيادة عدّاد الطلبات لمستخدم — عمليّة ذاكرة O(1) بلا I/O (تُستدعى في المسار الساخن). */
export function bumpRequest(kind: 'rep' | 'admin', userId: string, tenantId: string): void {
  const key = `${kind}|${userId}|${tenantId}|${riyadhDay()}`;
  buffer.set(key, (buffer.get(key) || 0) + 1);
}

/**
 * إفراغ المتراكم إلى القاعدة (upsert بزيادة). نلتقط ثم نُفرّغ المخزن ذرّياً كي لا
 * نفقد عدّاتٍ وصلت أثناء الكتابة؛ وإن فشلت كتابةٌ نُعيد دلتاها للمخزن.
 *
 * الدلالة at-least-once عمداً: لو أُثبِتت الزيادة في القاعدة (COMMIT) ثم رُفض وعد
 * العميل (انقطاع/مهلة بعد الـCOMMIT)، تُعاد الدلتا وتُكتب ثانيةً ⇒ عدٌّ زائد نادر.
 * مقبولٌ لمقياس استهلاكٍ تقريبيّ (لا فوترة)؛ الإحكام الكامل يحتاج سجلّ إفراغ فريداً.
 */
export async function flushRequestCounts(): Promise<void> {
  if (buffer.size === 0) return;
  const entries = [...buffer.entries()];
  buffer.clear();
  for (const [key, delta] of entries) {
    if (delta <= 0) continue;
    const [kind, userId, tenantId, day] = key.split('|');
    try {
      await prisma.requestStat.upsert({
        where: { kind_userId_day: { kind, userId, day } },
        create: { kind, userId, tenantId, day, count: delta },
        update: { count: { increment: delta } },
      });
    } catch {
      buffer.set(key, (buffer.get(key) || 0) + delta); // أعِد الدلتا كي لا تضيع
    }
  }
}

/** تقليم إحصاءات الطلبات الأقدم من مدّة الاحتفاظ. */
export async function pruneRequestStats(): Promise<void> {
  const cutoff = riyadhDay(Date.now() - RETENTION_DAYS * 86400000);
  await prisma.requestStat.deleteMany({ where: { day: { lt: cutoff } } });
}
