import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «اشتراط تفعيل الموقع» (طلب المالك، ٤ أكتوبر ٢٠٢٦): والموقع مطفأ في جوال المندوب المقيَّد لا يقبل التطبيق منه
 * إجراءً ولا زيارةً ولا فتح ملف عميل ولا بصمة حضور. يحجب التطبيقُ شاشته كلها حتى يُفعَّل الموقع.
 *
 * متى يكون «مطفأ»؟ رفض الإذن (1) وحده حكمٌ قاطع: آيفون وكروم يرسلان به إطفاء خدمة الموقع نفسها. أما «تعذّر الموقع»
 * (2) فيصل على آيفون والموقع مفعّل حين لا إشارة الآن (مستودع، قبو، بلا تغطية)، فلا يحجب إلا إذا تكرّر ثلاث مرات
 * متتالية بلا قراءة ناجحة بينها. وانتهاء المهلة (3) لا يحجب أبداً — حجبُ المندوب بإشارةٍ ضعيفة يوقف عمله ظلماً.
 */
export const LOCATION_RECHECK_MS = 60_000;
export const UNAVAILABLE_STREAK_TO_BLOCK = 3;

export type LocationGateStatus = 'checking' | 'on' | 'off';
export interface GateState { status: LocationGateStatus; unavailableStreak: number }
/** نتيجة فحص: قراءة ناجحة، أو رمز GeolocationPositionError (1 رفض، 2 تعذّر، 3 مهلة) */
export type GateOutcome = 'ok' | 1 | 2 | 3;

/** الحالة بعد فحص — صرفة. المحجوب لا يُفتح إلا بقراءةٍ ناجحة، والقائم لا يُحجب بمهلة ولا بتعذّرٍ عابر */
export function reduceGate(s: GateState, outcome: GateOutcome): GateState {
  if (outcome === 'ok') return { status: 'on', unavailableStreak: 0 };
  if (outcome === 1) return { status: 'off', unavailableStreak: 0 };
  const keep: LocationGateStatus = s.status === 'checking' ? 'on' : s.status;
  if (outcome === 2) {
    const streak = s.unavailableStreak + 1;
    return { status: streak >= UNAVAILABLE_STREAK_TO_BLOCK ? 'off' : keep, unavailableStreak: streak };
  }
  return { status: keep, unavailableStreak: s.unavailableStreak };
}

const read = (opts: PositionOptions): Promise<GateOutcome> => new Promise((resolve) => {
  navigator.geolocation.getCurrentPosition(() => resolve('ok'), (e) => resolve(e.code === 1 || e.code === 2 ? e.code : 3), opts);
});

/**
 * فحصٌ واحد: قراءة طازجة بدقّة منخفضة (المخبّأة قد تنجح والموقع مطفأ)، فإن تعذّرت أو انتهت مهلتها فمحاولةٌ ثانية
 * بالـGPS ومهلة أطول تقبل قراءةً عمرها دقيقتان — شبكة الموقع تفشل بلا اتصال والـGPS يعمل.
 */
async function probe(): Promise<GateOutcome> {
  const first = await read({ enableHighAccuracy: false, timeout: 15_000, maximumAge: 0 });
  if (first === 'ok' || first === 1) return first;
  return read({ enableHighAccuracy: true, timeout: 20_000, maximumAge: 120_000 });
}

/**
 * يفحص عند التفعيل، وعند العودة إلى التطبيق، وكل دقيقة وهو ظاهر، وحين يتغيّر الإذن — و`check()` لفحصٍ فوري قبل
 * إجراء، يعيد هل يُسمح بالعمل.
 */
export function useLocationGate(enabled: boolean): { status: LocationGateStatus; check: () => Promise<boolean> } {
  const initial: GateState = { status: enabled ? 'checking' : 'on', unavailableStreak: 0 };
  const [state, setState] = useState<GateState>(initial);
  const ref = useRef<GateState>(initial);
  const apply = (next: GateState) => { ref.current = next; setState(next); };

  const check = useCallback(async (): Promise<boolean> => {
    if (!enabled) { apply({ status: 'on', unavailableStreak: 0 }); return true; }
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { apply({ status: 'off', unavailableStreak: 0 }); return false; }
    const next = reduceGate(ref.current, await probe());
    apply(next);
    return next.status !== 'off';
  }, [enabled]);

  useEffect(() => {
    apply({ status: enabled ? 'checking' : 'on', unavailableStreak: 0 });
    if (!enabled) return;
    let alive = true;
    void check();
    const onVisible = () => { if (!document.hidden) void check(); };
    document.addEventListener('visibilitychange', onVisible);
    const iv = window.setInterval(() => { if (!document.hidden) void check(); }, LOCATION_RECHECK_MS);
    let perm: PermissionStatus | null = null;
    const onPermChange = () => { void check(); };
    navigator.permissions?.query({ name: 'geolocation' as PermissionName })
      .then((p) => { if (!alive) return; perm = p; p.addEventListener('change', onPermChange); })
      .catch(() => { /* متصفحٌ بلا Permissions API: يكفي الفحص الدوري */ });
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(iv);
      perm?.removeEventListener('change', onPermChange);
    };
  }, [enabled, check]);

  return { status: state.status, check };
}
