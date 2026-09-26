/**
 * خرائط Google داخل تطبيق المندوب — تحميل Maps JavaScript API مرّة واحدة **لعرض الخريطة فقط**.
 * البحث عن المحلات يجري في الخادم (بحصة محجوزة)، فمفتاح المتصفّح مقيَّد في Google Cloud بخدمة الخريطة وحدها.
 * مهلة تحميل: شبكة ميدانية متقطعة قد تُحمّل السكربت ولا تستدعي callback أبداً — فلا نعلق إلى الأبد.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type G = any;

export const MAPS_LOAD_TIMEOUT_MS = 15000;
let loading: Promise<G> | null = null;

export function loadGoogleMaps(key: string, timeoutMs = MAPS_LOAD_TIMEOUT_MS): Promise<G> {
  const w = window as unknown as { google?: G; __fsGmapsReady?: () => void };
  if (w.google?.maps?.Map) return Promise.resolve(w.google);
  if (loading) return loading;
  loading = new Promise<G>((resolve, reject) => {
    const s = document.createElement('script');
    const fail = () => {
      clearTimeout(timer);
      loading = null;
      s.remove();
      reject(new Error('maps-load-failed'));
    };
    const timer = setTimeout(fail, timeoutMs);
    w.__fsGmapsReady = () => { clearTimeout(timer); resolve(w.google); };
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&language=ar&region=SA&loading=async&callback=__fsGmapsReady`;
    s.async = true;
    s.onerror = fail;
    document.head.appendChild(s);
  });
  return loading;
}
