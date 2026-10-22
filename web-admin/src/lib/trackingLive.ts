// قراءة قائمة المناديب لخريطة التتبّع (علاج «تأخّر الموقع»، ٢٢ أكتوبر ٢٠٢٦) — الويب (pages/TrackingPage.tsx) وتطبيق الإدارة
// (m/MTracking.tsx).
//
// الخريطة تُقرأ عند كل حدث «locations» (كل ١٠ث على الأكثر) فوق استطلاعها. عدّاد زيارات اليوم أثقل ما في المسار (زيارات
// اليوم كلها حتى ٢٠٠٠٠ صف)، وتغيّره لا يحتاج ثوانٍ: القراءة الكاملة كل دقيقة، وبينها قراءةٌ خفيفة للمواقع وحدها يُكمَل
// عدّادها من القراءة السابقة.

/** كل كم تُقرأ القائمة كاملةً بعدّاد الزيارات */
export const FULL_LIVE_EVERY_MS = 60_000;

const lastFull = new Map<string, number>();

/**
 * `key` يفصل الشاشات (لكلٍّ ذاكرتها)، و`prev` آخر ما عُرض. خادمٌ أقدم يتجاهل lite فيعيد العدّاد — فيؤخذ كما جاء.
 */
export async function readLiveReps<T extends { id: string; visitsToday?: number }>(
  key: string,
  prev: readonly T[] | undefined,
  get: (lite: boolean) => Promise<T[]>,
  now = Date.now(),
): Promise<T[]> {
  const last = lastFull.get(key);
  const lite = !!prev && last !== undefined && now - last < FULL_LIVE_EVERY_MS;
  const rows = await get(lite);
  if (!lite) { lastFull.set(key, now); return rows; }
  const visits = new Map(prev!.map((r) => [r.id, r.visitsToday]));
  return rows.map((r) => (typeof r.visitsToday === 'number' ? r : { ...r, visitsToday: visits.get(r.id) ?? 0 }));
}

/** للاختبار وحده */
export const _resetLiveReads = (): void => { lastFull.clear(); };
