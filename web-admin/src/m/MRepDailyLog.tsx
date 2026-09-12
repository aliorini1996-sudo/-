import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, CheckCircle2, Clock, RotateCcw, AlertTriangle } from 'lucide-react';
import { dailyReportApi } from '../api/client';
import { SalesRep } from '../types';
import { formatCurrency, formatDate, formatTime, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { MCard, MScreen, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectObject } from './shape';

/**
 * سجلّ التقارير اليومية لمندوبٍ واحد — نظير النافذة في لوحة الويب.
 *
 * لماذا بطاقاتٌ لا جدول: جدول الويب يحمل عموداً لكل خانةٍ عرّفتها الشركة،
 * وشركةٌ بعشر خانات تعطي جدولاً بأربعة عشر عموداً — لا يُقرأ على ٣٦٠px مهما
 * انزلق أفقياً. فالبطاقة تقلب الاتجاه: يومٌ واحد في الشاشة، وخاناته تحته
 * صفّين صفّين.
 *
 * والحالة أوّل ما يُقرأ لا آخره: من يفتح هذا السجلّ يسأل «هل رفع؟ وهل
 * اعتُمد؟» قبل أن يسأل عن الأرقام.
 */

interface DrField { id: string; label: string; kind: string }
interface DrRow {
  id: string; reportDate: string; status: string; round: number; note: string | null;
  submittedAt: string | null; approvedAt: string | null; soloApproved: boolean;
  currentLevelName: string | null; values: Record<string, number | string | null>;
}
interface DrHistory {
  rep: { id: string; name: string };
  fields: DrField[];
  rows: DrRow[];
  meta: { from: string; to: string; capped: boolean; cappedNote: string | null; approved: number; pending: number; returned: number };
}

const STATUS: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  APPROVED: { label: 'معتمد', cls: 'text-[#2F855A] bg-[#EAF6F0]', icon: CheckCircle2 },
  PENDING: { label: 'قيد المراجعة', cls: 'text-[#B7791F] bg-[#FDF6E7]', icon: Clock },
  RETURNED: { label: 'معاد للتصحيح', cls: 'text-[#C0392B] bg-[#FDF2F0]', icon: RotateCcw },
};

export default function MRepDailyLog({ rep, onClose }: { rep: SalesRep; onClose: () => void }) {
  const tr = useTr();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const rangeOn = !!(from || to);

  const q = useQuery({
    queryKey: ['m-rep-daily-log', rep.id, from, to],
    queryFn: async () => expectObject<DrHistory>(
      (await dailyReportApi.repHistory(rep.id, { from: from || undefined, to: to || undefined })).data?.data,
      tr('سجل التقارير اليومية')),
  });

  const fields = q.data?.fields ?? [];
  const rows = q.data?.rows ?? [];
  const meta = q.data?.meta;

  /* العرض بنوع الخانة: المبلغ بعملة الشركة، والعدد بفواصله، والنصّ كما كُتب.
   * و«لا قيمة» شرطةٌ لا صفر — الصفر إقرارٌ بأن اليوم كان صفراً. */
  const show = (f: DrField, v: number | string | null | undefined) => {
    if (v === null || v === undefined || v === '') return '—';
    if (f.kind === 'TEXT' || typeof v !== 'number') return String(v);
    return f.kind === 'MONEY' ? formatCurrency(v) : formatNumber(v);
  };

  return (
    <MScreen header={<MHeader title={tr('سجل التقارير اليومية')} subtitle={rep.name} onBack={onClose} />}>
      <div className="bg-[#FAF7F0] min-h-full p-3 space-y-3">
        {/* التصفية بالتاريخ — المدى يدخل مفتاح الاستعلام فيُعاد الجلب من الخادم */}
        <MCard className="p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('من تاريخ')}</label>
              <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}
                className="w-full rounded-xl border border-[#E9E1D3] px-2.5 py-2 text-xs bg-white" />
            </div>
            <div>
              <label className="text-[11px] text-[#9A8F7E] block mb-1">{tr('إلى تاريخ')}</label>
              <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}
                className="w-full rounded-xl border border-[#E9E1D3] px-2.5 py-2 text-xs bg-white" />
            </div>
          </div>
          {rangeOn && (
            <button type="button" onClick={() => { setFrom(''); setTo(''); }}
              className="text-[11px] font-semibold text-[#C94E28]">{tr('إلغاء التصفية')}</button>
          )}
        </MCard>

        {meta && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <Count label={tr('معتمد')} n={meta.approved} cls="text-[#2F855A] bg-[#EAF6F0]" />
            <Count label={tr('قيد المراجعة')} n={meta.pending} cls="text-[#B7791F] bg-[#FDF6E7]" />
            <Count label={tr('معاد للتصحيح')} n={meta.returned} cls="text-[#C0392B] bg-[#FDF2F0]" />
          </div>
        )}

        {meta?.cappedNote && (
          <p className="flex items-start gap-1.5 text-[11px] text-[#B7791F] bg-[#FDF6E7] rounded-xl px-3 py-2">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />{meta.cappedNote}
          </p>
        )}

        {q.isLoading ? <MSpinner />
          : q.isError ? <MError onRetry={() => q.refetch()} text={tr('تعذر تحميل سجل التقارير')} />
          : rows.length === 0 ? (
            <div className="py-10">
              <MEmpty icon={ClipboardList} text={rangeOn ? tr('لا تقارير في هذا المدى') : tr('لا تقارير بعد')} />
            </div>
          ) : rows.map(r => {
            const st = STATUS[r.status] ?? { label: r.status, cls: 'text-[#6E6557] bg-[#F1EBDF]', icon: ClipboardList };
            const Icon = st.icon;
            return (
              <MCard key={r.id} className="p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold text-sm text-[#1F1A13]">
                    {formatDate(r.reportDate)}
                    {r.round > 1 && <span className="text-[10px] text-[#9A8F7E] mr-1">({tr('محاولة')} {r.round})</span>}
                  </span>
                  <span className={`flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>
                    <Icon size={12} />{tr(st.label)}
                  </span>
                </div>

                <div className="text-[11px] text-[#9A8F7E] leading-relaxed">
                  {r.submittedAt && <div>{tr('رفع في')}: {formatDate(r.submittedAt)} {formatTime(r.submittedAt)}</div>}
                  {r.approvedAt && <div>{tr('اعتمد في')}: {formatDate(r.approvedAt)} {formatTime(r.approvedAt)}</div>}
                  {/* عند أيّ مستوىً يقف الآن — وهو سبب تأخّره */}
                  {r.currentLevelName && <div>{tr('عند')}: {r.currentLevelName}</div>}
                  {/* «اعتمده شخص واحد» يُعلَن هنا كما يُعلَن في الحصيلة */}
                  {r.soloApproved && <div className="text-[#B7791F]">{tr('اعتمده شخص واحد')}</div>}
                </div>

                {fields.length > 0 && (
                  <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-[#F1EBDF]">
                    {fields.map(f => (
                      <div key={f.id} className="min-w-0">
                        <p className="text-[10px] text-[#9A8F7E] truncate">{f.label}</p>
                        <p className="text-xs font-semibold text-[#1F1A13] truncate">{show(f, r.values[f.id])}</p>
                      </div>
                    ))}
                  </div>
                )}

                {r.note && <p className="text-[11px] text-[#6E6557] pt-1 border-t border-[#F1EBDF]">{r.note}</p>}
              </MCard>
            );
          })}

        <div className="h-2" />
      </div>
    </MScreen>
  );
}

function Count({ label, n, cls }: { label: string; n: number; cls: string }) {
  return (
    <div className={`rounded-xl py-2 ${cls}`}>
      <p className="text-base font-extrabold leading-none">{n}</p>
      <p className="text-[10px] mt-1 opacity-80">{label}</p>
    </div>
  );
}
