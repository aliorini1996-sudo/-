// تفاصيل «التحقق العشوائي من التواجد» لمندوبٍ في يوم (تقرير ساعات العمل): متى أُرسل، وحكمه، وبعد كم ردّ، وموقعه ومسافة أقرب
// عملائه، وجهازه — وإن لم يصل الإشعار جهازه (لا تنبيهات مفعّلة) يُقال ذلك، فلا يُحمَّل «بلا ردّ» ما لم يعلم به.
import { X, MapPin } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { activeLocale } from '../../utils/format';
import { mapsUrl } from '../../lib/workPeriods';
import { presenceStatusText, type PresenceRow } from '../../lib/presenceReport';

const TONE: Record<PresenceRow['status'], string> = {
  PASSED: 'bg-green-50 text-green-700',
  LATE: 'bg-amber-100 text-amber-800',
  MISSED: 'bg-red-50 text-red-700',
  SENT: 'bg-blue-50 text-blue-700',
  SKIPPED: 'bg-gray-100 text-gray-500',
};

export default function PresenceDayModal({ repName, date, rows, onClose }: { repName: string; date: string; rows: PresenceRow[]; onClose: () => void }) {
  const tr = useTr();
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(activeLocale(), { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[#E9E1D3]">
          <div>
            <h2 className="text-lg font-bold text-[#1F1A13]">{tr('التحقق من التواجد')}</h2>
            <p className="text-xs text-[#9A8F7E] mt-1">{repName} · <span dir="ltr">{date}</span></p>
          </div>
          <button onClick={onClose} aria-label={tr('إغلاق')} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto divide-y divide-[#F1EBDF]">
          {rows.map((r) => {
            const url = mapsUrl(r.lat, r.lng);
            return (
              <div key={r.id} className="py-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold tabular-nums text-[#1F1A13]">{clock(r.sentAt ?? r.dueAt)}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${TONE[r.status]}`}>{presenceStatusText(r, tr)}</span>
                  {r.delaySec != null && <span className="text-xs text-[#6E6557]">{tr('رد بعد')} {r.delaySec < 60 ? `${r.delaySec} ${tr('ث')}` : `${Math.round(r.delaySec / 60)} ${tr('د')}`}</span>}
                  {/* يُحكم بلحظة الضغط؛ ووصول الموقع بعدها بأكثر من نصف دقيقة يُذكر — ليرى المدير ما بين الضغط والموقع */}
                  {(() => {
                    const lag = r.respondedAt && r.sentAt && r.delaySec != null
                      ? Math.round((Date.parse(r.respondedAt) - Date.parse(r.sentAt)) / 1000) - r.delaySec : 0;
                    return lag > 30 ? <span className="text-xs text-amber-800">{tr('وصل الموقع بعد الضغط بـ')} {lag} {tr('ث')}</span> : null;
                  })()}
                  {r.otherDevice && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{tr('من جهاز غير المربوط')}</span>}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#6E6557]">
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[#2E6FB0] hover:underline">
                      <MapPin size={12} /> {tr('موقعه عند الرد')}{r.accuracy != null && <span dir="ltr"> ±{Math.round(r.accuracy)}m</span>}
                    </a>
                  ) : (r.status === 'PASSED' || r.status === 'LATE') && <span className="text-amber-800">{tr('رد بلا موقع')}</span>}
                  {r.distanceM != null && <span>{tr('اقرب عملائه')} {r.distanceM} {tr('م')}</span>}
                  {r.device && <span dir="auto">{r.device}</span>}
                  {r.pushSent === 0 && r.status !== 'SKIPPED' && <span className="text-amber-800">{tr('لم يصل الاشعار جهازه التنبيهات غير مفعلة')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
