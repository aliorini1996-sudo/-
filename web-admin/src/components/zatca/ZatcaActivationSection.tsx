import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Lock, Rocket, ShieldAlert, Users } from 'lucide-react';
import { zatcaApi } from '../../api/client';
import { formatDateTime } from '../../utils/format';
import type { ZatcaGoLiveReadiness, ZatcaOverview } from '../../types';
import { apiErrorOf } from './zatcaLogic';
import {
  activationButtons, GO_LIVE_CONFIRMATION_TEXT, goLiveCheckRows, goLiveErrorMessage, isGoLiveConfirmed, repUnsyncedReasonLabel,
} from './goLiveLogic';
import { useGoLiveTr } from './goLivePhrases';

/**
 * قسم «تفعيل المرحلة الثانية» (Z5.8) داخل تبويب الفوترة الإلكترونية — يُحمَّل كسولاً ولا يُعرض إلا لشركةٍ فتح لها علم
 * المنصّة الإطلاق (activationVisible في goLiveLogic، يفرضه المستدعي). يعرض قائمة الجاهزية (تُستطلع)، ثمّ «تسليح» يبدأ
 * عدّ مزامنة المناديب ويوقف الإصدار دون اتصال، ثمّ زرّ تفعيلٍ معطَّل حتى تكتمل الشروط ويُكتب «تفعيل» — مع تحذير أنّه لا
 * عودة للمرحلة الأولى بعده. الخادم هو الحارس (POST /zatca/go-live): يعيد التحقق من كل شرط.
 */

const OVERVIEW_KEY = ['zatca', 'overview'] as const;
const READINESS_KEY = ['zatca', 'go-live', 'readiness'] as const;

function CheckIcon({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle2 size={16} className="text-[#1E7A52] shrink-0" />
    : <CircleDashed size={16} className="text-[#B5AB9A] shrink-0" />;
}

export default function ZatcaActivationSection({ ov }: { ov: ZatcaOverview }) {
  const tr = useGoLiveTr();
  const qc = useQueryClient();
  const initial = ov.goLiveReadiness ?? null;
  const [typed, setTyped] = useState('');
  const [repsAck, setRepsAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: READINESS_KEY,
    queryFn: async () => (await zatcaApi.goLiveReadiness()).data.data as ZatcaGoLiveReadiness,
    initialData: initial ?? undefined,
    refetchOnWindowFocus: false,
    // مُسلَّح ولم يكتمل بعد ⇒ استطلاع كل 15 ث لالتقاط مزامنة المناديب؛ وإلا لا استطلاع
    refetchInterval: query => {
      const r = query.state.data as ZatcaGoLiveReadiness | undefined;
      return r && r.armed && !r.available ? 15_000 : false;
    },
  });

  const r = q.data ?? initial;
  if (!r) return null; // لا يصل عملياً (المستدعي يفرض activationVisible) — حارس نوعٍ

  const rows = goLiveCheckRows(r);
  const btn = activationButtons(r, typed, repsAck, busy);
  const unsynced = r.reps?.unsynced ?? [];

  const arm = async () => {
    setBusy(true);
    try {
      const res = await zatcaApi.armGoLive();
      const data = res.data?.data as { applied?: boolean; readiness?: ZatcaGoLiveReadiness } | undefined;
      if (data?.readiness) qc.setQueryData(READINESS_KEY, data.readiness);
      await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      toast.success(tr(data?.applied === false ? 'التفعيل مُسلَّح مسبقا' : 'بدأ تسليح التفعيل — بانتظار مزامنة المناديب'));
    } catch (err) {
      const e = apiErrorOf(err);
      toast.error(goLiveErrorMessage(e.code, e.message));
    } finally {
      setBusy(false);
    }
  };

  // نقد 2/4: نزع التسليح — تعافٍ في التطبيق من تسليحٍ خاطئ (يعيد الإصدار دون اتصال) ما لم تكن الشركة قد فُعّلت حيّاً (409)
  const disarm = async () => {
    setBusy(true);
    try {
      const res = await zatcaApi.disarmGoLive();
      const data = res.data?.data as { readiness?: ZatcaGoLiveReadiness } | undefined;
      if (data?.readiness) qc.setQueryData(READINESS_KEY, data.readiness);
      await qc.invalidateQueries({ queryKey: OVERVIEW_KEY });
      toast.success(tr('أُلغي التسليح — عاد إصدار الفواتير دون اتصال'));
    } catch (err) {
      const e = apiErrorOf(err);
      toast.error(goLiveErrorMessage(e.code, e.message));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!isGoLiveConfirmed(typed) || !repsAck) return;
    setBusy(true);
    try {
      await zatcaApi.goLive({ typedConfirmation: typed.trim(), repsSynced: repsAck });
      setTyped('');
      setRepsAck(false);
      toast.success(tr('فُعّلت المرحلة الثانية — كل فاتورة توقّع وترسل للهيئة الآن'));
      await Promise.all([
        qc.invalidateQueries({ queryKey: OVERVIEW_KEY }),
        qc.invalidateQueries({ queryKey: ['company'] }),
      ]);
    } catch (err) {
      const e = apiErrorOf(err);
      // 409 GO_LIVE_NOT_READY يحمل الجاهزية المحدَّثة — حدّثها في مكانها كي يرى المدير ما نقص
      const fresh = (err as { response?: { data?: { readiness?: ZatcaGoLiveReadiness } } } | null)?.response?.data?.readiness;
      if (fresh) qc.setQueryData(READINESS_KEY, fresh);
      toast.error(goLiveErrorMessage(e.code, e.message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* قائمة الجاهزية */}
      <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] px-4 py-3">
        <p className="text-sm font-semibold text-[#1F1A13] flex items-center gap-2">
          <ShieldAlert size={16} className="text-[#C94E28]" /> {tr('قائمة الجاهزية للتفعيل')}
          {q.isFetching && <Loader2 size={13} className="animate-spin text-[#B5AB9A]" />}
        </p>
        <p className="text-[11px] text-[#6E6557] mt-0.5">{tr('كل ما يلزم قبل تفعيل المرحلة الثانية — يتحدّث تلقائيا')}</p>
        <ul className="mt-2 space-y-1.5">
          {rows.map(row => (
            <li key={row.key} className="flex items-start gap-2 text-[13px] text-[#44403a] leading-relaxed">
              <span className="mt-0.5"><CheckIcon ok={row.ok} /></span>
              <span className={row.ok ? '' : 'text-[#6E6557]'}>{tr(row.label)}</span>
            </li>
          ))}
        </ul>
        {/* المناديب غير المزامنين (بعد التسليح) */}
        {!r.checks?.repsSynced && (
          <div className="mt-3 rounded-lg border border-[#F0DDA6] bg-[#FDF3D8] px-3 py-2">
            <p className="text-xs font-semibold text-[#6B4B00] flex items-center gap-1.5">
              <Users size={14} /> {tr('مناديب لم يزامنوا أجهزتهم بعد')}
              {r.reps ? <span dir="ltr">({r.reps.synced}/{r.reps.total})</span> : null}
            </p>
            {unsynced.length > 0 ? (
              <ul className="mt-1.5 space-y-1">
                {unsynced.map(u => (
                  <li key={u.id} className="text-[11px] text-[#6B4B00] leading-relaxed">
                    • <b>{u.name || u.id}</b> — {tr(repUnsyncedReasonLabel(u.reason))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-[#6B4B00] mt-1">{tr('يفتح المندوب التطبيق ويزامن حتى يفرغ صندوقه بعد التسليح ثم يظهر هنا مزامنا')}</p>
            )}
          </div>
        )}
      </div>

      {/* التسليح */}
      {!btn.armed ? (
        <div className="rounded-xl border border-[#E8C9BC] bg-[#FFFBF8] px-4 py-3 space-y-2">
          <p className="text-sm font-semibold text-[#1F1A13] flex items-center gap-2"><Lock size={15} className="text-[#C94E28]" /> {tr('تسليح التفعيل')}</p>
          <p className="text-[13px] text-[#6E6557] leading-relaxed">
            {tr('التسليح يوقف إصدار الفواتير دون اتصال على أجهزة المناديب ويبدأ عدّ المزامنة — تصدر الفواتير أونلاين فقط بعده')}
          </p>
          <button type="button" className="btn-secondary" disabled={!btn.canArm} onClick={arm}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />} {tr('ابدأ التسليح')}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] px-4 py-3">
          <p className="text-sm font-semibold text-[#1E7A52] flex items-center gap-2"><CheckCircle2 size={15} /> {tr('التفعيل مُسلَّح')}</p>
          {r.armedAt && <p className="text-[11px] text-[#6E6557] mt-0.5">{tr('مُسلَّح منذ')} {formatDateTime(r.armedAt)}</p>}
          {!r.available && <p className="text-[12px] text-[#6B4B00] mt-1">{tr('بانتظار أن يزامن كل مندوب نشط جهازه بعد التسليح')}</p>}
          <div className="mt-2 pt-2 border-t border-[#E9E1D3]">
            <p className="text-[11px] text-[#6E6557] leading-relaxed mb-1.5">{tr('يعيد نزع التسليح إصدار الفواتير دون اتصال — استخدمه إن سُلّح بالخطأ أو لتأجيل التفعيل')}</p>
            <button type="button" className="text-[12px] text-[#8E2A1F] underline underline-offset-2 disabled:opacity-50" disabled={busy} onClick={disarm}>
              {busy ? <Loader2 size={13} className="inline animate-spin" /> : null} {tr('نزع التسليح')}
            </button>
          </div>
        </div>
      )}

      {/* التفعيل — لا عودة */}
      <div className="rounded-xl border border-[#F2C4BC] bg-[#FDF1EE] px-4 py-3 space-y-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle size={18} className="text-[#C0392B] mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-[#8E2A1F]">{tr('بعد التفعيل لا عودة إلى المرحلة الأولى')}</p>
            <p className="text-[13px] text-[#8E2A1F] mt-0.5 leading-relaxed">
              {tr('من لحظة التفعيل توقّع كل فاتورة وترسل إلى الهيئة، ولا يمكن إصدار فاتورة دون اتصال، ولا إلغاء فاتورة (يستخدم الإشعار الدائن بدلا منها)')}
            </p>
          </div>
        </div>

        <label className="flex items-start gap-2 text-[13px] text-[#44403a] cursor-pointer select-none">
          <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#E15A30]" checked={repsAck} onChange={e => setRepsAck(e.target.checked)} />
          {tr('أقر أن كل المناديب النشطين زامنوا أجهزتهم بعد التسليح')}
        </label>

        <div className="max-w-xs">
          <label className="label" htmlFor="zatca-golive-confirm">{tr('اكتب كلمة التأكيد')} «{GO_LIVE_CONFIRMATION_TEXT}»</label>
          <input id="zatca-golive-confirm" className="input" value={typed} onChange={e => setTyped(e.target.value)}
            placeholder={GO_LIVE_CONFIRMATION_TEXT} autoComplete="off" />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" className="btn-danger" disabled={!btn.canGoLive} onClick={activate}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />} {tr('فعّل المرحلة الثانية')}
          </button>
          <span className="text-[11px] text-[#6E6557]">
            {r.available ? tr('كل الشروط مكتملة — يمكنك التفعيل الآن') : tr('أكمل الشروط أعلاه قبل التفعيل')}
          </span>
        </div>
      </div>
    </div>
  );
}
