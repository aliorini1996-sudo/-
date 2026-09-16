import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE } from '../api/client';
import { sessionSpace } from '../store/authStore';
import { LIVE_REFETCH, LIVE_MARK_STALE, isFinalRejection, rateLimitWait } from './livePolicy';
import { parseSse } from './sse';

/**
 * التحديث اللحظيّ لعمود «المدفوع» (قرار المالك) — الطرف المستمع لقناة
 * `GET /api/live/stream` (انظر backend/src/services/liveEvents.ts).
 *
 * سندٌ يصدره مندوب أو إداريّ آخر أو دفعةٌ إلكترونية ⇒ الخادم يبثّ «invoices» ⇒
 * هذه الشاشة تعيد قراءة ما يعرض المدفوع والمتبقي، بصلاحياتها هي.
 *
 * قرارات:
 * - `fetch` بترويسة Authorization لا `EventSource` (الأخيرة تفرض التوكن في الرابط).
 * - **إعادة القراءة الفورية للشاشات التي تعرض المدفوع/المتبقي وحدها**؛ الثقيل
 *   (لوحة التحكم، قوائم العملاء) يُوسَم قديماً فيُقرأ عند فتحه لا مع كل سند:
 *   قاعدة البيانات هي العنق الضيّق، والحدث يصل كل شاشة مفتوحة في الشركة.
 * - الأحداث المتلاحقة تُجمع، وبين قراءتين ٣ ثوانٍ على الأقل — مزامنة مندوب ترفع
 *   عشرين سنداً تكلّف جولاتٍ معدودة لا عشرين.
 * - **الالتقاط بعد الانقطاع يقع حين يؤكّد الخادم الاشتراك (`ready`)** لا قبله:
 *   قراءةٌ قبل الاشتراك تترك نافذةً يضيع فيها سندٌ لم يجد مستمعاً.
 * - إخفاء الصفحة لا يُغلق القناة فوراً: تبديلٌ سريع بين التطبيقات لا يستحقّ
 *   اتصالاً جديداً وقراءةً كاملة. تُغلق بعد دقيقةٍ من الاختفاء.
 */

const BACKOFF_START = 2_000;
const BACKOFF_MAX = 60_000;
/** هدوءٌ قصير يجمع الأحداث المتلاحقة قبل القراءة */
const DEBOUNCE_MS = 700;
/** أقلّ فاصلٍ بين جولتي قراءة */
const MIN_GAP_MS = 3_000;
/** مدّة بقاء القناة مفتوحةً بعد اختفاء الصفحة */
const HIDDEN_GRACE_MS = 60_000;

/**
 * يستمع لتغيّرات فواتير الشركة ويحدّث شاشاتها. يُركَّب مرّة في قشرة كل تطبيق
 * (لوحة الويب، تطبيق الإدارة على الجوال).
 */
export function useLiveInvoiceUpdates(enabled: boolean, sessionKey?: string | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof fetch !== 'function' || typeof document === 'undefined') return;

    let stopped = false;
    let gen = 0;                  // جيل الاتصال — الأقدم يخرج بصمت حين يبدأ أحدث
    let ctrl: AbortController | null = null;
    let streamOpen = false;       // قناةٌ جارية لم تُغلق (قد تكون الصفحة مخفيّة)
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRefresh = 0;

    const invalidate = () => {
      lastRefresh = Date.now();
      for (const queryKey of LIVE_REFETCH) void qc.invalidateQueries({ queryKey });
      for (const queryKey of LIVE_MARK_STALE) void qc.invalidateQueries({ queryKey, refetchType: 'none' });
    };

    /** قراءةٌ مجمّعة: أوّل حدثٍ بعد هدوءٍ قصير، والتالية بفاصلٍ لا يقلّ عن MIN_GAP_MS */
    const refresh = () => {
      if (refreshTimer || stopped) return;          // جولةٌ مجدولة ستلتقط هذا الحدث أيضاً
      const wait = Math.max(DEBOUNCE_MS, lastRefresh + MIN_GAP_MS - Date.now());
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (!stopped) invalidate();
      }, wait);
    };

    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

    const run = async (my: number, catchUpFirst: boolean) => {
      let backoff = BACKOFF_START;
      // هل فاتنا ما يلزم التقاطه؟ يُقضى عند `ready` — بعد أن يسجّل الخادم الاشتراك
      let needCatchUp = catchUpFirst;
      while (!stopped && my === gen) {
        const token = localStorage.getItem(sessionSpace().tokenKey);
        if (!token) return;
        const local = new AbortController();
        ctrl = local;
        let wait = backoff;
        try {
          const res = await fetch(`${API_BASE}/live/stream`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
            cache: 'no-store',
            signal: local.signal,
          });
          if (isFinalRejection(res.status)) return;   // انتهاء الجلسة يتولّاه معترض axios
          if (res.status === 429) wait = rateLimitWait(res.headers.get('Retry-After'), backoff);
          if (res.ok && res.body) {
            streamOpen = true;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              const parsed = parseSse(buf);
              buf = parsed.rest;
              for (const ev of parsed.events) {
                if (ev.event === 'ready') {
                  if (needCatchUp) refresh();
                  needCatchUp = false;
                  backoff = BACKOFF_START;
                  wait = backoff;
                } else if (ev.event === 'invoices') {
                  refresh();
                }
              }
            }
          }
        } catch { /* انقطاع شبكة أو إلغاء — يُحسم أدناه */ } finally {
          if (my === gen) streamOpen = false;
        }
        if (stopped || my !== gen || local.signal.aborted) return;
        // محاولةٌ فشلت أو قناةٌ انتهت: ما يقع حتى الاتصال التالي لا يصل حدثه
        needCatchUp = true;
        await sleep(wait);
        backoff = Math.min(backoff * 2, BACKOFF_MAX);
      }
    };

    const start = (catchUp: boolean) => {
      const my = ++gen;
      ctrl?.abort();
      void run(my, catchUp);
    };

    const close = () => {
      gen++;
      streamOpen = false;
      ctrl?.abort();
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = undefined; close(); }, HIDDEN_GRACE_MS);
        return;
      }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = undefined; }
      // عادت الصفحة والقناة ما زالت حيّة: لم يفت شيء، والأحداث وصلت أثناء الاختفاء
      if (streamOpen) return;
      // أُغلقت (طال الاختفاء أو انقطعت): اتصالٌ جديد، والالتقاط بعد تأكيد الاشتراك
      start(true);
    };

    // صفحةٌ تُفتح مخفيّة (تبويبٌ في الخلفية) تنتظر ظهورها
    if (document.visibilityState !== 'hidden') start(false);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      close();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // sessionKey (التوكن): دخولٌ بحسابٍ آخر أو انتحالٌ لشركةٍ أخرى يفتح اتصالاً جديداً بهويّته
  }, [enabled, sessionKey, qc]);
}
