// مصدر الحقيقة الأمامي لتحديد العمودية من الـURL — يعمل مع الـsubdomain والبادئة معاً،
// فلا يتوقّف بناء صفحة المطاعم على حسم قرار النطاق (restaurant.fieldsa.net أو /restaurant).
export type Vertical = 'distribution' | 'restaurant';

export function resolveVertical(): Vertical {
  if (typeof window === 'undefined') return 'distribution';
  const host = window.location.hostname;
  const path = window.location.pathname;
  if (host.startsWith('restaurant.') || host.startsWith('resto.')) return 'restaurant';
  if (path === '/restaurant' || path.startsWith('/restaurant/')) return 'restaurant';
  return 'distribution';
}
