// «أثبت تواجدك» — التحقق العشوائي من التواجد (طلب المالك، ٢٢ أكتوبر ٢٠٢٦؛ الخادم: backend/src/services/presenceChecks.ts).
//
// يصل الطلب بإشعارٍ (public/sw.js يفتحه في النافذة المفتوحة فوراً)، أو بالنبضة حين لا تنبيهات (useHeartbeat)، فتظهر هذه
// النافذة فوق كل شيء — حتى حاجز الموقع — بعدٍّ تنازليّ. الضغط على «أثبت تواجدي» شرط — لا ردٌّ تلقائي: الجوال المتروك لا
// يجيب عن صاحبه — فتُختم لحظة الضغط على الخادم أولاً (بها يُحكم، فثواني قراءة الموقع والشبكة لا تُحسب عليه)، ثمّ قراءة موقعٍ
// طازجة (punchFix.ts) تُرسَل مع الجهاز. ولا «لاحقاً» قبل المحاولة: «إغلاق مؤقت» بعد فشل الإرسال وحده (بلا شبكة لا يُقفل
// التطبيق ربع ساعة)، والنبضة تعيد الطلب ما دام معلّقاً.
//
// والمقيَّد بـ«بصمة الحضور بموقع عميل» لا يُقبل تواجده إلا داخل نطاق أحد عملائه (طلب المالك ٧ نوفمبر ٢٠٢٦): رفض الخادم
// (PRESENCE_AWAY_FROM_CUSTOMER — presenceRefusal.ts) لا يُنهي الطلب — تبقى النافذة بسببه و«أعد المحاولة» بقراءةٍ طازجة حتى المهلة.
//
// تدقيق نطاق ٥٠ متراً (٧ نوفمبر ٢٠٢٦): النافذة المفتوحة تُسخّن GPS (startPunchWarmup) فلا تبدأ القراءة بعد الضغط من GPS بارد،
// والرفض بقراءةٍ تقريبية بالكيلومترات (الموقع الدقيق مطفأ) يقول «فعّل الموقع الدقيق» لا «انتظر». حكم الخادم كما هو.
import { useEffect, useRef, useState } from 'react';
import { MapPin, Check, Clock } from 'lucide-react';
import repApi from './repApi';
import { precisePunchFix, pinAccuracyLevel, startPunchWarmup, type PunchFixReason } from './punchFix';
import { usePageVisible } from './usePageVisible';
import { presenceFailureOf, presenceAwayView, type PresenceAwayView } from './presenceRefusal';
import { getDeviceId, describeDevice } from './deviceId';
import { useTr } from '../i18n/strings';
import { presencePhase, mmss, type PendingPresence } from './presencePhase';
import { startPresenceAlarm, stopPresenceAlarm, silencePresenceAlarm, PRESENCE_UNLOCK_EVENTS } from './presenceAlarm';
import { iosPushAvailable, iosPushClear } from './iosPush';

export type { PendingPresence, PresencePhase } from './presencePhase';

/** away = رُفض لبعده عن عملائه: الطلب مفتوح ويُعاد — كـerror لا كـexpired. soft: رفض «انتظر وأعد» (presenceAwaySoft) */
type Result = { kind: 'ok' | 'late' | 'noFix' | 'expired' | 'error' | 'away'; text: string; soft?: boolean };

/**
 * يُغلق إشعار «أثبت تواجدك» لهذا الطلب العالق في الدرج (وإلّا حلّ التالي محلّه بلا صوت) — والصفحة ظاهرة وحدها: والتطبيق في
 * الخلفية لم يرَ المندوب النافذة، فمسحُ إشعاره يُخفي عنه الطلب. وإشعار طلبٍ أحدث (معرّفٌ آخر) لا يُمسّ
 */
function closePresenceNotifications(checkId: string): void {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  if (iosPushAvailable()) { void iosPushClear('presence', checkId); return; } // تطبيق الآيفون: درج الإشعارات عنده
  try {
    navigator.serviceWorker?.getRegistration()
      .then((reg) => reg?.getNotifications({ tag: 'presence' }))
      .then((ns) => ns?.forEach((n) => { const id = (n.data as { checkId?: string | null } | null)?.checkId; if (!id || id === checkId) n.close(); }))
      .catch(() => { /* لا إشعارات */ });
  } catch { /* متصفّحٌ بلا عامل خدمة */ }
}

export default function PresenceCheckModal({ pending, onClose, onDismiss, onAnswered, onAttempt, lastAway, onAway }: {
  pending: PendingPresence;
  /** آخر رفضٍ للمكان لهذا الطلب — تعود به النافذة بعد «إغلاق مؤقت» (سببه والمهلة و«أعد المحاولة») لا بالسؤال الأول */
  lastAway?: PresenceAwayView | null;
  /** رُفض المكان — يحفظه التطبيق لهذا الطلب */
  onAway?: (v: PresenceAwayView) => void;
  /** بدأ المندوب الردّ (ضغط) — لا تغلقه النبضة وهو يقرأ موقعه أو يرسل، فيرى حكمه */
  onAttempt: () => void;
  /** حُكم الطلب (أُجيب أو فات) — لا تعيد النبضة فتحه، ولا يُغلق قبل أن يقرأ المندوب نتيجته */
  onAnswered: () => void;
  /** انتهى الطلب (أُجيب أو فات) — لا يُعاد فتحه */
  onClose: () => void;
  /** إغلاقٌ مؤقت بعد فشل الإرسال — تعيده النبضة ما دام معلّقاً */
  onDismiss: () => void;
}) {
  const tr = useTr();
  // فرق ساعة الجهاز عن الخادم لحظة الاستلام — العدّ بساعة الخادم
  const skew = useRef(pending.serverNow - Date.now());
  const [now, setNow] = useState(() => Date.now() + skew.current);
  const [stage, setStage] = useState<'idle' | 'locating' | 'sending'>('idle');
  const [result, setResult] = useState<Result | null>(() => (lastAway ? { kind: 'away', ...lastAway } : null));

  useEffect(() => {
    // الإشعار يُغلق حين يرى المندوب النافذة فعلاً: بلمسةٍ منه والنافذة ظاهرة — لا بظهورها وحده. جوالٌ موضوعٌ بشاشةٍ مضيئة لا
    // يراه صاحبه، ومسحُ إشعاره يُسكت إنذار أندرويد (المتكرّر بمستوى المنبّه) فإن انطفأت الشاشة سكت كل شيء (المخفية لا ترنّ).
    // ولا لمس والتطبيق في الخلفية (تُركَّب النافذة فيه بالنبضة أو رسالة العامل): لا يُمسح من الدرج قبل أن يراه
    const seen = () => closePresenceNotifications(pending.id);
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const ev of PRESENCE_UNLOCK_EVENTS) document.addEventListener(ev, seen, opts);
    const id = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => {
      clearInterval(id);
      for (const ev of PRESENCE_UNLOCK_EVENTS) document.removeEventListener(ev, seen, opts);
      closePresenceNotifications(pending.id);
    };
  }, [pending.id]);

  const { phase, leftMs } = presencePhase(pending, now);
  const busy = stage !== 'idle';

  // جرس الطلب (presenceAlarm.ts): صوت منبّه واهتزاز يتكرّران ما دامت تنتظر الضغط — يسكت بالضغط أو النتيجة أو انتهاء المهلة، وبسقف
  // ثلاث دقائق من أوّل رنينٍ لهذا الطلب (إعادة التركيب لا تعيده). والصفحة مخفية لا يرنّ هنا: الإشعار يرنّ (باقٍ حتى يلمس الشاشة)
  const alarmOn = !result && !busy && phase !== 'expired';
  useEffect(() => {
    if (!alarmOn) return;
    startPresenceAlarm(pending.id);
    return () => stopPresenceAlarm(pending.id);
  }, [alarmOn, pending.id]);

  const confirm = async () => {
    if (busy) return;
    // الضغطة تُسكت الجرس فوراً ولا يعود لهذا الطلب ولو فشل الإرسال أو أُغلق مؤقتاً — ومعه إشعاره إن بقي يرنّ
    silencePresenceAlarm(pending.id);
    closePresenceNotifications(pending.id);
    onAttempt();
    setStage('locating');
    // سبب غياب القراءة إن غابت — به يُقال رفض «بلا موقع» على حقيقته (مهلةٌ أو تعذّر، لا «فعّل الموقع» وهو مفعّل)
    let fixReason: PunchFixReason | null = null;
    // دقّة القراءة المرسلة إن كانت تقريبية (pinAccuracyLevel = coarse) — بها يُقال للرفض «فعّل الموقع الدقيق»، والمرسَل نفسه بلا تغيير
    let coarseM: number | null = null;
    try {
      // لحظة الضغط على الخادم قبل القراءة — لا تنتظرها القراءة، ويُنتظر وصولها قبل الردّ (فيُحكم بها). وفي «أعد المحاولة» بعد رفض
      // المكان لمسةٌ جديدة: الخادم مسح لمسة المحاولة المرفوضة، فلا تُحسب له لحظةٌ كان فيها بعيداً — تُحسب لحظة هذه الضغطة وحدها
      const tap = repApi.post(`/tracking/presence/${pending.id}/tap`, {}, { background: true, timeout: 10_000 }).catch(() => null);
      const r = await precisePunchFix();
      fixReason = r.reason;
      const acc = r.fix?.accuracy;
      if (typeof acc === 'number' && pinAccuracyLevel(acc) === 'coarse') coarseM = acc;
      const body = { ...(r.fix ?? {}), deviceId: getDeviceId(), deviceName: await describeDevice() };
      await tap;
      setStage('sending');
      const res = await repApi.post(`/tracking/presence/${pending.id}/respond`, body, { timeout: 25_000 });
      const d = res.data?.data as { status?: string; located?: boolean } | undefined;
      onAnswered();
      if (!d?.located) setResult({ kind: 'noFix', text: tr('سجل ردك بلا موقع فعل الموقع في جوالك') });
      else if (d.status === 'LATE') setResult({ kind: 'late', text: tr('سجل ردك متاخرا') });
      else setResult({ kind: 'ok', text: tr('تم اثبات تواجدك') });
    } catch (e) {
      const f = presenceFailureOf(e);
      // بعيدٌ عن عملائه (المقيَّد بـ«بصمة الحضور بموقع عميل»): الطلب ما زال مفتوحاً على الخادم — لا onAnswered (فلا يُعدّ مُجاباً
      // ولا تُغلقه النبضة: بدأ منه الردّ)، والنافذة تبقى بسببه و«أعد المحاولة» حتى المهلة. والجرس لا يعود: أُسكت بالضغطة الأولى
      if (f.kind === 'away') {
        const v = presenceAwayView(f, tr, fixReason, coarseM);
        onAway?.(v);
        setResult({ kind: 'away', ...v });
      }
      // طلبٌ انتهى، أو ليس له (404)، أو أُطفئت الميزة (403): نهائيٌّ لا يُعاد
      else if (f.kind === 'expired') {
        onAnswered();
        setResult({ kind: 'expired', text: tr('انتهت مهلة التحقق') });
      } else setResult({ kind: 'error', text: tr('تعذر الارسال حاول ثانية') });
    } finally {
      setStage('idle');
    }
  };

  const color = phase === 'onTime' ? '#1E7A52' : '#B7791F';
  const busyText = stage === 'sending' ? tr('جار الارسال') : tr('جار تحديد موقعك');
  // رُفض لبعده عن عملائه: يُعاد ما بقيت المهلة كفشل الإرسال، وبعدها «انتهت مهلة التحقق» (ويُختم «بلا رد» كما اليوم)
  const away = result?.kind === 'away';
  // انتهت المهلة — ومحاولةٌ ما زالت تقرأ أو ترسل لا يُقال لها «انتهت» ولا يُعرض «تم»: لمستها سبقت المهلة فقد يُحكم بها، فتنتظر حكمها
  const ended = phase === 'expired' && !busy;
  const retryable = (result?.kind === 'error' || away) && !ended;
  // تسخين GPS ما دامت النافذة تنتظر ضغطةً أو إعادة: مراقبةٌ بأعلى دقّة لا تُرسل شيئاً (لا ردّ تلقائي) — فحين يضغط تصل قراءةٌ
  // دقيقة في ثوانٍ بدل GPS بارد وأوّل قراءة شبكةٍ خشنة. الردّ يبقى قراءةً طازجة بعد الضغط (precisePunchFix) كما هو، ويتوقّف
  // التسخين بالحكم النهائي أو انتهاء المهلة أو فكّ النافذة («تم» أو «إغلاق مؤقت» أو تبديل الطلب). والتسخين يقف وحده بعد سقفه
  // (PUNCH_WARMUP_MAX_MS) — فيُجدَّد بدخول «متأخر» وبعد كل رفضٍ للمكان: المحاولة التالية تجد GPS دافئاً، والمدّة محدودةٌ بعمر الطلب.
  // والنافذة قد تُفتح والتطبيق في الخلفية (نبضة أو رسالة عامل الخدمة): التسخين للصفحة الظاهرة وحدها، ويُفتح بسقفٍ كامل عند الإظهار
  const visible = usePageVisible();
  const warm = !ended && (!result || retryable);
  useEffect(() => (warm && visible ? startPunchWarmup() : undefined), [warm, visible, phase, result]);
  // العدّ التنازلي: في انتظار الضغط، وبعد رفض المكان — ليعرف كم بقي له ليصل أحد عملائه
  const countdown = (
    <p className="flex items-center justify-center gap-1.5 text-sm font-bold tabular-nums" style={{ color }}>
      <Clock size={16} />
      {phase === 'onTime' ? `${tr('الوقت المتبقي')} ${mmss(leftMs)}` : `${tr('تاخرت ويسجل ردك متاخرا')} · ${mmss(leftMs)}`}
    </p>
  );

  return (
    // فوق حاجز الموقع (z-[1300]) وعارض الصور (z-[1200]): الطلب يُجاب أينما كان المندوب في التطبيق
    <div className="fixed inset-0 z-[1400] bg-black/60 flex items-center justify-center p-5" dir="rtl" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl space-y-4">
        <div className="mx-auto w-14 h-14 rounded-full bg-[#FBEBE2] flex items-center justify-center">
          <MapPin size={28} className="text-[#E15A30]" />
        </div>
        <h2 className="text-xl font-bold text-[#1F1A13]">{tr('اثبت تواجدك')}</h2>

        {result ? (
          <>
            {/* الأحمر للفشل والبُعد الصريح وانتهاء المهلة، والكهرماني لـ«انتظر وأعد» (موقعٌ غير دقيق أو لم تصل قراءة) */}
            <p className={`text-sm font-semibold ${result.kind === 'ok' ? 'text-[#1E7A52]' : result.kind === 'error' || (away && (ended || !result.soft)) ? 'text-[#C0392B]' : 'text-[#B7791F]'}`}>
              {result.kind === 'ok' && <Check size={16} className="inline -mt-0.5 me-1" />}{away && ended ? tr('انتهت مهلة التحقق') : result.text}
            </p>
            {retryable ? (
              <>
                {away && countdown}
                <button onClick={confirm} disabled={busy} className="w-full rounded-2xl bg-[#E15A30] py-3.5 text-white font-bold disabled:opacity-60">
                  {busy ? busyText : away ? tr('أعد المحاولة') : tr('اثبت تواجدي')}
                </button>
                <button onClick={onDismiss} disabled={busy} className="w-full rounded-2xl border border-[#E9E1D3] py-3 font-bold text-[#1F1A13] disabled:opacity-60">
                  {tr('اغلاق مؤقت')}
                </button>
              </>
            ) : (
              <button onClick={onClose} className="w-full rounded-2xl border border-[#E9E1D3] py-3 font-bold text-[#1F1A13]">{tr('تم')}</button>
            )}
          </>
        ) : ended ? (
          <>
            <p className="text-sm text-[#C0392B] font-semibold">{tr('انتهت مهلة التحقق')}</p>
            <button onClick={onClose} className="w-full rounded-2xl border border-[#E9E1D3] py-3 font-bold text-[#1F1A13]">{tr('إغلاق')}</button>
          </>
        ) : (
          <>
            <p className="text-sm text-[#5C5346] leading-relaxed">{tr('طلب تحقق من الادارة اضغط الزر وسيؤخذ موقعك الان')}</p>
            {countdown}
            <button onClick={confirm} disabled={busy} className="w-full rounded-2xl bg-[#E15A30] py-3.5 text-white text-lg font-bold disabled:opacity-60">
              {busy ? busyText : tr('اثبت تواجدي')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
