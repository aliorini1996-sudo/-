import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, AlertTriangle, ArrowRight, Users, CheckCircle2 } from 'lucide-react';
import { dailyReportApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatDate } from '../utils/format';

/**
 * أرشيف التقارير الشاملة الصادرة — **دائم لا صندوق وارد**.
 *
 * ما صدر يبقى في قائمة من أُسند إليه ولا يختفي بفعلٍ عليه. والإسناد يُقرأ
 * لحظة الطلب لا يُنسَخ على الحصيلة: سحبُه يُخفي الأرشيف كلّه، ومنحُه يفتحه
 * كاملاً بما صدر قبل المنح — فالقائمة تتبع الصلاحية الحاليّة لا تاريخها.
 */

interface Digest {
  id: string; reportDate: string; issuedAt: string;
  reportCount: number; repCount: number; soloApprovedCount: number;
}

export default function DailyReportDigests() {
  const tr = useTr();
  const [openDate, setOpenDate] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['dr-digests'],
    queryFn: async () => (await dailyReportApi.digests()).data.data as { assigned: boolean; digests: Digest[] },
  });

  if (openDate) return <DigestView date={openDate} onBack={() => setOpenDate(null)} />;
  if (q.isLoading) return <div className="card p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>;

  if (!q.data?.assigned) {
    return (
      <div className="card p-8 text-center">
        <Archive size={28} className="mx-auto text-gray-300" />
        <p className="text-sm text-[#6E6557] mt-2">{tr('التقرير الشامل غير مسند لك')}</p>
        <p className="text-xs text-gray-400 mt-1">{tr('يحدد المستلمين مدير الشركة من إعدادات التقرير اليومي')}</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden p-0">
      {!q.data.digests.length ? (
        <div className="p-8 text-center">
          <Archive size={28} className="mx-auto text-gray-300" />
          <p className="text-sm text-[#6E6557] mt-2">{tr('لم تصدر حصيلة بعد')}</p>
          <p className="text-xs text-gray-400 mt-1">{tr('تصدر حصيلة اليوم حين يعتمد آخر تقرير رفع فيه')}</p>
        </div>
      ) : (
        <div className="divide-y divide-[#F5F0E6]">
          {q.data.digests.map(d => (
            <button
              key={d.id} onClick={() => setOpenDate(d.reportDate)}
              className="w-full text-right px-5 py-3.5 hover:bg-[#FAF7F0] flex items-center gap-3"
            >
              <CheckCircle2 size={18} className="text-[#22C55E] shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-[#1F1A13] text-sm">{d.reportDate}</p>
                <p className="text-xs text-[#6E6557] mt-0.5">
                  {d.reportCount} {tr('تقرير')}
                  {d.repCount > d.reportCount && (
                    <span className="text-amber-700"> · {d.repCount - d.reportCount} {tr('مندوب لم يرفع')}</span>
                  )}
                  {d.soloApprovedCount > 0 && (
                    <span className="text-amber-700"> · {d.soloApprovedCount} {tr('اعتمده شخص واحد')}</span>
                  )}
                </p>
              </div>
              <ArrowRight size={15} className="text-gray-300 shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DigestView({ date, onBack }: { date: string; onBack: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['dr-digest', date],
    queryFn: async () => (await dailyReportApi.digest(date)).data.data,
  });

  if (q.isLoading) return <div className="card p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>;

  const d = q.data as {
    digest: Digest;
    fields: { id: string; label: string; kind: string; isActive: boolean }[];
    rows: { salesRepId: string; salesRepName: string; soloApproved: boolean; values: Record<string, number | string | null> }[];
    totals: Record<string, number>;
    missingReps: number;
  };
  const num = (v: unknown): string =>
    typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : v === null || v === undefined ? '—' : String(v);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="btn-secondary text-xs">{tr('رجوع')}</button>
        <div>
          <p className="font-bold text-[#1F1A13]">{tr('حصيلة')} {d.digest.reportDate}</p>
          <p className="text-xs text-[#6E6557]">{tr('صدرت')} {formatDate(d.digest.issuedAt)}</p>
        </div>
      </div>

      {(d.missingReps > 0 || d.digest.soloApprovedCount > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-1">
          {d.missingReps > 0 && (
            <p className="text-xs text-amber-800 flex items-start gap-1.5">
              <Users size={13} className="mt-0.5 shrink-0" />
              {/* حصيلةٌ تخفي الغائبين تبدو كاملةً وهي ناقصة */}
              {d.missingReps} {tr('مندوب لم يرفع تقريره هذا اليوم فلا تشملهم الإجماليات')}
            </p>
          )}
          {d.digest.soloApprovedCount > 0 && (
            <p className="text-xs text-amber-800 flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              {d.digest.soloApprovedCount} {tr('تقرير وقعه شخص واحد في كل مستوياته')}
            </p>
          )}
        </div>
      )}

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                <th className="text-right font-semibold px-5 py-2.5">{tr('المندوب')}</th>
                {d.fields.map(f => (
                  <th key={f.id} className="text-center font-semibold px-3 py-2.5">
                    {f.label}{!f.isActive && <span className="text-gray-400"> ({tr('مؤرشفة')})</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map(r => (
                <tr key={r.salesRepId} className="border-t border-[#F5F0E6]">
                  <td className="px-5 py-3 font-semibold text-[#1F1A13]">
                    {r.salesRepName}
                    {r.soloApproved && <AlertTriangle size={12} className="inline mr-1 text-amber-600" />}
                  </td>
                  {d.fields.map(f => (
                    <td key={f.id} className="px-3 py-3 text-center">{num(r.values[f.id])}</td>
                  ))}
                </tr>
              ))}
              <tr className="border-t-2 border-[#E9E1D3] bg-[#FAF7F0] font-bold">
                <td className="px-5 py-3">{tr('الإجمالي')}</td>
                {d.fields.map(f => (
                  <td key={f.id} className="px-3 py-3 text-center">
                    {f.kind === 'TEXT' ? '—' : num(d.totals[f.id] ?? 0)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
