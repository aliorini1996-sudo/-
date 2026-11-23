// «هل ما زلت تعمل؟» — تذكير الانصراف عند الخمول (طلب المالك ٢٣ نوفمبر ٢٠٢٦؛ الخادم: services/idlePunchOut.ts، والمنطق
// الصرف في lib/idlePunchOut.ts).
//
// المندوب المقيَّد بالقيد إن بقي حاضراً بلا استخدامٍ للتطبيق ولا موقعٍ يصل من جواله «دقائق الخمول» يصله إشعارٌ، والتذكير المعلّق
// يصل التطبيق المفتوح أيضاً في ردّ النبضة (useHeartbeat ⇒ onHeartbeat، الحقل idlePunchOutReminder) فتظهر هذه النافذة بعدٍّ تنازليّ
// حقيقيّ إلى الانصراف التلقائي: لحظة التذكير + مهلة الرد بساعة الخادم (serverNow في الردّ يصحّح ساعة الجوال — idleRemainingMs).
// فتح التطبيق (النبضة) لا يلغيه (قرار المالك): لا يلغيه إلا «ما زلت أعمل» هنا، أو تنقّلٌ فعلي، أو إصدار مستند — والأخيران تمحو
// الدورة بهما التذكير فتُغلق النافذة من ردّ النبضة التالي (idleAfterBeat). وإلا ينصرف تلقائياً بوقت آخر نشاطٍ سبق التذكير.
// زرّان: «ما زلت أعمل» يسجّل نشاطاً ويمحو التذكير، و«سجّل الانصراف الآن» يفتح شاشة البصمة بانصرافها العادي (موقعه وجهازه وقيوده
// كما هي — لا انصرافٌ من هنا). ولا ردٌّ تلقائي: الجوال المتروك لا يجيب عن صاحبه.
import { useEffect, useState } from 'react';
import { Hourglass } from 'lucide-react';
import repApi from './repApi';
import { useTr } from '../i18n/strings';
import {
  ATTENDANCE_REFRESH_EVENT, IDLE_STILL_WORKING_PATH, fmtCountdown, idleClosedKind, idleRemainingMs, withCount, type IdleReminder,
} from '../lib/idlePunchOut';

/** شاشة البصمة المفتوحة تعيد قراءة حالتها (نوبةٌ أُغلقت تلقائياً تظهر «انصراف تلقائي» لا «حاضر») */
const refreshAttendance = () => { try { window.dispatchEvent(new Event(ATTENDANCE_REFRESH_EVENT)); } catch { /* تجاهل */ } };

export default function IdlePunchOutModal({ reminder, onStillWorking, onPunchOut, onSettled }: {
  reminder: IdleReminder;
  /** أُرسل «ما زلت أعمل» وقبله الخادم — تُغلق النافذة ولا يُعاد فتح هذا التذكير */
  onStillWorking: () => void;
  /** «سجّل الانصراف الآن» (أو نوبةٌ أُغلقت قبل الردّ) — تُغلق النافذة وتُفتح شاشة البصمة */
  onPunchOut: () => void;
  /** النافذة تعرض نتيجة ردٍّ مرفوض (انصرافٌ تلقائي سبق، أو لا نوبة) — فلا يُغلقها ردّ نبضةٍ بلا تذكير قبل أن يقرأها */
  onSettled?: () => void;
}) {
  const tr = useTr();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // النوبة أُغلقت قبل الردّ: 'auto' سبقه الانصراف التلقائي، و'closed' انصرف من جهازٍ آخر — لا «ما زلت أعمل»، حضورٌ جديد إن كان يعمل
  const [closed, setClosed] = useState<'auto' | 'closed' | null>(null);
  // العدّ التنازليّ: ساعة الجوال كل ثانية، والباقي بساعة الخادم (فرق الساعتين من ردّ النبضة)
  const [phoneNow, setPhoneNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setPhoneNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (closed) onSettled?.(); }, [closed, onSettled]);
  const remaining = idleRemainingMs(reminder, phoneNow);

  const stillWorking = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    try {
      await repApi.post(IDLE_STILL_WORKING_PATH, {});
      onStillWorking();
    } catch (e) {
      const resp = (e as { response?: { status?: number; data?: { code?: string; message?: string; autoCheckedOut?: boolean } } })?.response;
      const kind = idleClosedKind(resp?.status, resp?.data);
      if (kind) { setClosed(kind); refreshAttendance(); }
      else setErr(resp?.data?.message || tr('تعذر الإرسال تحقق من اتصالك ثم أعد المحاولة'));
    } finally {
      setBusy(false);
    }
  };

  return (
    // تحت «أثبت تواجدك» (z-[1400]) وفوق حاجز الموقع (z-[1300]): السؤال يُجاب أينما كان المندوب في التطبيق
    <div className="fixed inset-0 z-[1350] bg-black/60 flex items-center justify-center p-5" dir="rtl" role="dialog" aria-modal="true" data-idle-punch-out="">
      <div className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl space-y-4">
        <div className="mx-auto w-14 h-14 rounded-full bg-[#FBEBE2] flex items-center justify-center">
          <Hourglass size={28} className="text-[#E15A30]" />
        </div>
        {closed ? (
          <>
            <h2 className="text-xl font-bold text-[#1F1A13]">{closed === 'auto' ? tr('انصراف تلقائي') : tr('لا نوبة مفتوحة')}</h2>
            <p className="text-sm text-[#5C5346] leading-relaxed">
              {closed === 'auto'
                ? tr('سجل انصرافك تلقائيا بوقت آخر نشاط لك قبل التذكير وان كنت تعمل سجل حضورا جديدا')
                : tr('سجل انصرافك من قبل وان كنت تعمل سجل حضورا جديدا')}
            </p>
            <button onClick={onPunchOut} className="w-full rounded-2xl bg-[#E15A30] py-3.5 text-white font-bold">{tr('فتح شاشة البصمة')}</button>
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold text-[#1F1A13]">{tr('هل ما زلت تعمل؟')}</h2>
            <p className="text-sm text-[#5C5346] leading-relaxed">
              {withCount(tr('بلا استخدام للتطبيق ولا موقع يصل من جوالك منذ {n} دقيقة'), reminder.idleMinutes)}
            </p>
            {/* العدّ الحقيقيّ إلى الانصراف التلقائي (التذكير + مهلة الرد بساعة الخادم) — وبعد انقضائه تُجريه الدورة خلال لحظات */}
            <div className="rounded-2xl bg-[#FBEBE2] px-4 py-3" data-idle-countdown="">
              {remaining > 0 ? (
                <>
                  <p className="text-xs font-semibold text-[#8A4B2F]">{tr('الوقت المتبقي قبل الانصراف التلقائي')}</p>
                  <p className="text-3xl font-bold tabular-nums text-[#E15A30]" dir="ltr" role="timer">{fmtCountdown(remaining)}</p>
                </>
              ) : (
                <p className="text-sm font-bold text-[#C0392B]">{tr('انتهت المهلة ويسجل انصرافك تلقائيا خلال لحظات')}</p>
              )}
            </div>
            <p className="text-xs text-[#5C5346] leading-relaxed">{tr('لا يلغي الانصراف التلقائي إلا ما زلت أعمل أو تنقل فعلي أو إصدار مستند')}</p>
            <p className="text-xs font-semibold text-[#B7791F]">{tr('ان انتهى عملك سجل بصمة الانصراف الآن')}</p>
            {err && <p className="text-xs text-[#C0392B]">{err}</p>}
            <button onClick={stillWorking} disabled={busy} className="w-full rounded-2xl bg-[#E15A30] py-3.5 text-white text-lg font-bold disabled:opacity-60">
              {busy ? tr('جارٍ التسجيل…') : tr('ما زلت أعمل')}
            </button>
            <button onClick={onPunchOut} disabled={busy} className="w-full rounded-2xl border border-[#C0392B] py-3 font-bold text-[#C0392B] disabled:opacity-60">
              {tr('سجل الانصراف الآن')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
