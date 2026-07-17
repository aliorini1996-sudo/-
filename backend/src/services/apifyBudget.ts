/**
 * حارس ميزانية Apify — يضمن ألّا يتجاوز الصيد الرصيد المجاني أبداً.
 *
 * لماذا هذا الملف موجود:
 *  خطة Apify المجانية = 5$ شهرياً بلا بطاقة، وactor خرائط Google (compass/google-maps-extractor)
 *  يكلّف 5$/1000 مكان على الخطة المجانية → 1000 مكان شهرياً بالضبط ثم يُحظر الحساب حتى الشهر التالي.
 *  Apify نفسها لا تسمح بتجاوز الرصيد على الخطة المجانية (لا فوترة overage)، فالمال مؤمَّن بنيوياً.
 *  هذا الحارس طبقة ثانية: يمنع استهلاك الرصيد كلّه في جلسة واحدة، ويُبقي العدّاد مرئياً في اللوحة.
 *
 * الإعداد يُخزَّن في SiteContent (id="apify_budget") — بلا أي تغيير في مخطّط قاعدة البيانات.
 */
import prisma from '../config/database';

export interface ApifyBudget {
  monthlyCap: number;      // سقف الأماكن شهرياً (1000 = كامل الرصيد المجاني)
  used: number;            // المستهلَك هذا الشهر
  month: string;           // "YYYY-MM" — مفتاح التصفير التلقائي
  totalRuns: number;
  totalPlaces: number;     // تراكمي عبر كل الشهور (للإحصاء فقط)
  lastRunAt: string | null;
}

const CONFIG_ID = 'apify_budget';

// 1000 = ما يشتريه رصيد الـ5$ المجاني بالضبط على سعر الخطة المجانية (5$/1000 مكان)
const DEFAULT_BUDGET: ApifyBudget = {
  monthlyCap: 1000,
  used: 0,
  month: '',
  totalRuns: 0,
  totalPlaces: 0,
  lastRunAt: null,
};

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

async function save(b: ApifyBudget): Promise<void> {
  await prisma.siteContent.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, data: JSON.stringify(b) },
    update: { data: JSON.stringify(b) },
  });
}

/** يقرأ الميزانية ويصفّر العدّاد تلقائياً عند دخول شهر جديد (رصيد Apify يتجدّد شهرياً ولا يُرحَّل). */
export async function getApifyBudget(): Promise<ApifyBudget> {
  const row = await prisma.siteContent.findUnique({ where: { id: CONFIG_ID } });
  let b: ApifyBudget = { ...DEFAULT_BUDGET, month: currentMonth() };
  if (row?.data) {
    try {
      b = { ...DEFAULT_BUDGET, ...(JSON.parse(row.data) as Partial<ApifyBudget>) };
    } catch {
      // إعداد تالف — نعود للافتراضي بدل إسقاط البحث
    }
  }

  const now = currentMonth();
  if (b.month !== now) {
    b.month = now;
    b.used = 0;
    await save(b);
  }
  return b;
}

/** كم مكاناً يتبقّى في ميزانية هذا الشهر. */
export async function apifyRemaining(): Promise<number> {
  const b = await getApifyBudget();
  return Math.max(0, b.monthlyCap - b.used);
}

/** يسجّل الاستهلاك الفعلي بعد انتهاء التشغيل (يُحاسَب على الأماكن المُعادة). */
export async function consumeApify(places: number): Promise<void> {
  const b = await getApifyBudget();
  b.used += Math.max(0, places);
  b.totalPlaces += Math.max(0, places);
  b.totalRuns += 1;
  b.lastRunAt = new Date().toISOString();
  await save(b);
}

/** تعديل السقف الشهري من اللوحة (0 = إيقاف Apify فعلياً). */
export async function setApifyCap(monthlyCap: number): Promise<ApifyBudget> {
  const b = await getApifyBudget();
  b.monthlyCap = Math.max(0, Math.min(monthlyCap, 100000));
  await save(b);
  return b;
}

export function apifyReady(): boolean {
  return !!(process.env.APIFY_TOKEN || '').trim();
}
