/**
 * «هدف الشهر» في تطبيق المندوب — جلب أهدافه من الخادم (GET /rep-targets/mine؛ الشهر الحالي بتوقيت الشركة، يحسبه الخادم).
 * الطلب خلفيّ (`background`): فشله العابر بـ401 لا يُخرج المندوب، فالبطاقة تغيب أو تُعرض محفوظةً موسومةً بزمنها.
 * لا يستورده اختبار: repApi يقرأ import.meta.env (Vite). والقرار «هل نجلب الآن» نقيٌّ في lib/repTargets.ts (targetsFetchDue).
 */
import repApi from './repApi';
import { targetsFetchDue, type RepTargetsData } from '../lib/repTargets';

export async function fetchMyTargets(): Promise<RepTargetsData | null> {
  const res = await repApi.get('/rep-targets/mine', { background: true });
  const data = res.data?.data as RepTargetsData | null | undefined;
  return data && Array.isArray(data.targets) ? data : null;
}

/*
 * آخر جلبٍ ناجح في هذه الجلسة — الرئيسية تُركَّب من جديد مع كل تبديل تبويب، فبلا هذا الحدّ يصير كل نقرٍ على «الرئيسية» طلباً
 * لقاعدة البيانات. `key` مفتاح تحديث الرئيسية (refreshKey): مستندٌ صدر أو مزامنةٌ رفعت ⇒ جلبٌ فوراً مهما قصر الفاصل.
 */
let lastFetch: { at: number; key: number } | null = null;

export function targetsFetchNeeded(refreshKey: number): boolean {
  return targetsFetchDue(lastFetch, refreshKey, Date.now());
}

export function markTargetsFetched(refreshKey: number): void {
  lastFetch = { at: Date.now(), key: refreshKey };
}
