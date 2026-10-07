import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LIVE_KEEPALIVE_MS, LIVE_TICK_MS, PING_REUSE_MS, fixUsable, liveDecision, liveFixOf, liveSnapshot, noteFix, noteGeoError,
  notePing, noteServer, resetLive, subscribeLive, updateLive, type LiveBlock, type LiveDecision,
} from './liveGate';
import { ensureLive, freshLiveFix, sendLivePing } from './repApi';
import type { GeoFix } from './visitLocation';

/**
 * حاجز «اشتراط تفعيل الموقع» — قفل صفحة العميل (أمر المالك، ٧ أكتوبر ٢٠٢٦؛ الشروط والحكم في liveGate.ts): صفحة أي عميل محجوبةٌ
 * عن المندوب المقيَّد ما لم يكن الموقع مفعّلاً ومحدَّداً بدقّة وهو متصل وظاهرٌ على الخريطة — وبقية التطبيق متاحة. والحكم يجري من
 * الدخول فيكون جاهزاً حين يفتح عميلاً. «جارٍ الفحص» يحجب أيضاً، والمهلة
 * تحجب، ولا قراءة مخبّأة: لحظة القراءة نفسها تُقاس.
 *
 * يراقب الموقع بـwatchPosition، ويرسل نقطةً كل ٣٠ث وهو ظاهر (ويجدّد القراءة إن سكنت المراقبة على جهازٍ ثابت)، وعند العودة
 * إلى التطبيق وعودة الاتصال وتغيّر الإذن، و`check()` لفحصٍ فوري (فتح شاشة/إجراء، «أعد المحاولة») يعيد هل يُسمح بالعمل.
 */
export function useLocationGate(enabled: boolean): { ok: boolean; block: LiveBlock | null; check: () => Promise<boolean> } {
  // الحكم حالةٌ لا تتغيّر إلا بتغيّره — فلا يُعاد رسم التطبيق كله كل ٥ث بلا داعٍ
  const [decision, setDecision] = useState<LiveDecision>({ ok: false, block: 'locating' });
  const recompute = useCallback(() => {
    const d = liveDecision(liveSnapshot(), Date.now());
    setDecision((prev) => (prev.ok === d.ok && (prev as { block?: LiveBlock }).block === (d as { block?: LiveBlock }).block ? prev : d));
  }, []);
  const busy = useRef<Promise<void> | null>(null);
  const watchRef = useRef<number | null>(null);

  const startWatch = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
    // بلا مهلة: المهلة في المراقبة تُطلق خطأً كلما سكن جهازٌ ثابت؛ والنقطة الدورية تقيس القراءة بنفسها
    watchRef.current = navigator.geolocation.watchPosition(
      (p) => noteFix(liveFixOf(p)),
      (e) => noteGeoError(e.code),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }, []);

  /** نقطة الحاجز: قراءةٌ ≤ ٣٠ث (وإلا طازجة الآن)، ثم نقطةٌ للخادم وحكمه — إلا إن قبل نقطةً قبل أقلّ من ١٥ث (force يتخطّاه) */
  const keepAlive = useCallback(async (force: boolean): Promise<void> => {
    updateLive({ online: typeof navigator === 'undefined' || navigator.onLine !== false, geoSupported: typeof navigator !== 'undefined' && !!navigator.geolocation });
    const s = liveSnapshot();
    if (!s.geoSupported) return;
    // رفض الإذن أو تعذّر الموقع يُميت المراقبة على بعض الأجهزة: تُستأنف مع كل محاولة
    if (s.geoError !== 0) startWatch();
    let fix = s.fix;
    if (!fixUsable(fix, Date.now(), LIVE_KEEPALIVE_MS)) {
      const r = await freshLiveFix();
      if ('error' in r) { noteGeoError(r.error); return; }
      noteFix(r.fix);
      fix = r.fix;
    }
    if (!fixUsable(fix, Date.now(), LIVE_KEEPALIVE_MS) || liveSnapshot().online === false) return;
    const last = liveSnapshot().ping;
    if (!force && last?.ok && Date.now() - last.at <= PING_REUSE_MS) return;
    const r = await sendLivePing(fix);
    if (r === 'network') { noteServer(false); return; }
    noteServer(true);
    notePing({ at: Date.now(), ok: r.ok, reason: r.reason, fixAt: fix.at });
  }, [startWatch]);

  const run = useCallback(async (force: boolean): Promise<boolean> => {
    if (!enabled) return true;
    if (!busy.current) busy.current = keepAlive(force).finally(() => { busy.current = null; });
    await busy.current;
    recompute();
    return liveDecision(liveSnapshot(), Date.now()).ok;
  }, [enabled, keepAlive, recompute]);

  // فتح شاشة أو إجراء و«أعد المحاولة»: نقطةٌ جديدة ما لم يقبل الخادم واحدةً قبل أقلّ من ١٥ث (لا نقطة لكل نقرة)
  const check = useCallback(() => run(false), [run]);

  useEffect(() => {
    // مطفأ (خرج المندوب أو رُفع القيد): يعود الحكم «محجوباً» فلا يرث مقيَّدٌ يدخل بعده «حيّاً» من سابقه ولو لإطار
    if (!enabled) { setDecision({ ok: false, block: 'locating' }); return; }
    let alive = true;
    resetLive({ online: typeof navigator === 'undefined' || navigator.onLine !== false });
    const unsubscribe = subscribeLive(recompute);
    recompute();
    startWatch();
    void run(true);
    const onVisible = () => { if (!document.hidden) void run(false); };
    const onOnline = () => { updateLive({ online: true }); void run(true); };
    const onOffline = () => updateLive({ online: false });
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // القراءة تشيخ دون حدث: يُعاد الحكم كل ٥ث، والنقطة كل ٣٠ث وهو ظاهر
    const tick = window.setInterval(recompute, LIVE_TICK_MS);
    const keep = window.setInterval(() => { if (!document.hidden) void run(true); }, LIVE_KEEPALIVE_MS);
    let perm: PermissionStatus | null = null;
    const onPermChange = () => { if (perm) updateLive({ permission: perm.state }); void run(true); };
    navigator.permissions?.query({ name: 'geolocation' as PermissionName })
      .then((p) => { if (!alive) return; perm = p; updateLive({ permission: p.state }); p.addEventListener('change', onPermChange); })
      .catch(() => { /* متصفحٌ بلا Permissions API: تكفي المراقبة والنقطة الدورية */ });
    return () => {
      alive = false;
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(tick);
      window.clearInterval(keep);
      perm?.removeEventListener('change', onPermChange);
      if (watchRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    };
  }, [enabled, run, startWatch, recompute]);

  if (!enabled) return { ok: true, block: null, check };
  return { ok: decision.ok, block: decision.ok ? null : decision.block, check };
}

/**
 * القراءة الحيّة للمقيَّد — بعد الفحص المسبق نفسه (طازجة ≤ ١٠ث، دقيقة، وقبلها الخادم حيّةً): لبدء الزيارة وحفظ الملاحظة
 * والبصمة. null = ليس حيّاً الآن (والحاجز يظهر بسببه).
 */
export async function strictLiveFix(): Promise<GeoFix | null> {
  const r = await ensureLive();
  if (!r.ok) return null;
  return {
    lat: r.fix.lat, lng: r.fix.lng,
    ...(r.fix.accuracy != null ? { accuracy: Math.round(r.fix.accuracy) } : {}),
    at: new Date(r.fix.at).toISOString(),
  };
}
