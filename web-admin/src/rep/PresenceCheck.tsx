// «أثبت تواجدك» — التحقق العشوائي من التواجد (طلب المالك، ٢٢ أكتوبر ٢٠٢٦؛ الخادم: backend/src/services/presenceChecks.ts).
//
// يصل الطلب بإشعارٍ (public/sw.js يفتحه في النافذة المفتوحة فوراً)، أو بالنبضة حين لا تنبيهات (useHeartbeat)، فتظهر هذه
// النافذة فوق كل شيء — حتى حاجز الموقع — بعدٍّ تنازليّ. الضغط على «أثبت تواجدي» شرط — لا ردٌّ تلقائي: الجوال المتروك لا
// يجيب عن صاحبه — فتُختم لحظة الضغط على الخادم أولاً (بها يُحكم، فثواني قراءة الموقع والشبكة لا تُحسب عليه)، ثمّ قراءة موقعٍ
// طازجة (punchFix.ts) تُرسَل مع الجهاز. ولا «لاحقاً» قبل المحاولة: «إغلاق مؤقت» بعد فشل الإرسال وحده (بلا شبكة لا يُقفل
// التطبيق ربع ساعة)، والنبضة تعيد الطلب ما دام معلّقاً.
import { useEffect, useRef, useState } from 'react';
import { MapPin, Check, Clock } from 'lucide-react';
import repApi from './repApi';
import { precisePunchFix } from './punchFix';
import { getDeviceId, describeDevice } from './deviceId';
import { useTr } from '../i18n/strings';
import { presencePhase, mmss, type PendingPresence } from './presencePhase';

export type { PendingPresence, PresencePhase } from './presencePhase';

type Result = { kind: 'ok' | 'late' | 'noFix' | 'expired' | 'error'; text: string };

/**
 * يُغلق إشعار «أثبت تواجدك» لهذا الطلب العالق في الدرج (وإلّا حلّ التالي محلّه بلا صوت) — والصفحة ظاهرة وحدها: والتطبيق في
 * الخلفية لم يرَ المندوب النافذة، فمسحُ إشعاره يُخفي عنه الطلب. وإشعار طلبٍ أحدث (معرّفٌ آخر) لا يُمسّ
 */
function closePresenceNotifications(checkId: string): void {
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
  try {
    navigator.serviceWorker?.getRegistration()
      .then((reg) => reg?.getNotifications({ tag: 'presence' }))
      .then((ns) => ns?.forEach((n) => { const id = (n.data as { checkId?: string | null } | null)?.checkId; if (!id || id === checkId) n.close(); }))
      .catch(() => { /* لا إشعارات */ });
  } catch { /* متصفّحٌ بلا عامل خدمة */ }
}

export default function PresenceCheckModal({ pending, onClose, onDismiss, onAnswered, onAttempt }: {
  pending: PendingPresence;
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
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    // الإشعار يُغلق حين يرى المندوب النافذة فعلاً — لا والتطبيق في الخلفية (تُركَّب النافذة فيه بالنبضة أو رسالة العامل)،
    // وإلّا مُسح من الدرج قبل أن يراه فلا يعلم بالطلب
    const seen = () => closePresenceNotifications(pending.id);
    seen();
    document.addEventListener('visibilitychange', seen);
    const id = setInterval(() => setNow(Date.now() + skew.current), 1000);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', seen); closePresenceNotifications(pending.id); };
  }, [pending.id]);

  const { phase, leftMs } = presencePhase(pending, now);
  const busy = stage !== 'idle';

  const confirm = async () => {
    if (busy) return;
    onAttempt();
    setStage('locating');
    try {
      // لحظة الضغط على الخادم قبل القراءة — لا تنتظرها القراءة، ويُنتظر وصولها قبل الردّ (فيُحكم بها)
      const tap = repApi.post(`/tracking/presence/${pending.id}/tap`, {}, { background: true, timeout: 10_000 }).catch(() => null);
      const r = await precisePunchFix();
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
      const resp = (e as { response?: { status?: number; data?: { code?: string } } })?.response;
      // طلبٌ انتهى، أو ليس له (404)، أو أُطفئت الميزة (403): نهائيٌّ لا يُعاد
      if (resp?.data?.code === 'PRESENCE_EXPIRED' || resp?.data?.code === 'PRESENCE_CLOSED' || resp?.status === 403 || resp?.status === 404) {
        onAnswered();
        setResult({ kind: 'expired', text: tr('انتهت مهلة التحقق') });
      } else setResult({ kind: 'error', text: tr('تعذر الارسال حاول ثانية') });
    } finally {
      setStage('idle');
    }
  };

  const color = phase === 'onTime' ? '#1E7A52' : '#B7791F';
  const busyText = stage === 'sending' ? tr('جار الارسال') : tr('جار تحديد موقعك');

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
            <p className={`text-sm font-semibold ${result.kind === 'ok' ? 'text-[#1E7A52]' : result.kind === 'error' ? 'text-[#C0392B]' : 'text-[#B7791F]'}`}>
              {result.kind === 'ok' && <Check size={16} className="inline -mt-0.5 me-1" />}{result.text}
            </p>
            {result.kind === 'error' && phase !== 'expired' ? (
              <>
                <button onClick={confirm} disabled={busy} className="w-full rounded-2xl bg-[#E15A30] py-3.5 text-white font-bold disabled:opacity-60">
                  {busy ? busyText : tr('اثبت تواجدي')}
                </button>
                <button onClick={onDismiss} disabled={busy} className="w-full rounded-2xl border border-[#E9E1D3] py-3 font-bold text-[#1F1A13] disabled:opacity-60">
                  {tr('اغلاق مؤقت')}
                </button>
              </>
            ) : (
              <button onClick={onClose} className="w-full rounded-2xl border border-[#E9E1D3] py-3 font-bold text-[#1F1A13]">{tr('تم')}</button>
            )}
          </>
        ) : phase === 'expired' ? (
          <>
            <p className="text-sm text-[#C0392B] font-semibold">{tr('انتهت مهلة التحقق')}</p>
            <button onClick={onClose} className="w-full rounded-2xl border border-[#E9E1D3] py-3 font-bold text-[#1F1A13]">{tr('إغلاق')}</button>
          </>
        ) : (
          <>
            <p className="text-sm text-[#5C5346] leading-relaxed">{tr('طلب تحقق من الادارة اضغط الزر وسيؤخذ موقعك الان')}</p>
            <p className="flex items-center justify-center gap-1.5 text-sm font-bold tabular-nums" style={{ color }}>
              <Clock size={16} />
              {phase === 'onTime' ? `${tr('الوقت المتبقي')} ${mmss(leftMs)}` : `${tr('تاخرت ويسجل ردك متاخرا')} · ${mmss(leftMs)}`}
            </p>
            <button onClick={confirm} disabled={busy} className="w-full rounded-2xl bg-[#E15A30] py-3.5 text-white text-lg font-bold disabled:opacity-60">
              {busy ? busyText : tr('اثبت تواجدي')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
