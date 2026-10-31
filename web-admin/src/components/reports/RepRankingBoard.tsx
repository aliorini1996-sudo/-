/**
 * لوحة «تقييم الأداء» في تقارير أداء المناديب (طلب المالك ١٢ أكتوبر ٢٠٢٦) — ترتيب المناديب حسب معيارٍ يختاره المشرف.
 * الأرقام من الخادم (`GET /reports/rep-ranking`، services/repRanking.ts)؛ هذه للعرض وحده.
 */
import { Trophy, Medal } from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { formatCurrency } from '../../utils/format';
import SearchableSelect from '../SearchableSelect';

export type RankingMetric = 'visits' | 'product' | 'sales' | 'distance' | 'appTime';
export interface RankingRow { repId: string; name: string; value: number; rank: number }
export interface RankingData {
  metric: RankingMetric;
  product: { id: string; name: string; unit: string } | null;
  rows: RankingRow[];
  range: { from: string | null; to: string };
  clampedDays: number | null;
}

export const RANKING_LABELS: Record<RankingMetric, string> = {
  visits: 'عدد الزيارات',
  product: 'كمية صنف معين',
  sales: 'قيمة المبيعات',
  distance: 'المسافة المقطوعة بالكيلو',
  appTime: 'وقت استخدام التطبيق',
};

/** ما يقيسه كل معيار — سطرٌ تحت اللوحة كي لا يُقرأ الرقم بغير معناه */
const RANKING_NOTES: Record<RankingMetric, string> = {
  visits: 'الزيارات المسجلة في المدة بعد دمج سجلات الوقفة الواحدة',
  product: 'صافي الكمية المباعة من الصنف بعد طرح المرتجع',
  sales: 'صافي فواتير البيع المؤكدة بعد طرح المرتجع',
  distance: 'المسافة المرصودة من نقاط الموقع ولا تحسب أوقات إغلاق التطبيق وأقصى مدى ٣١ يوما',
  appTime: 'مجموع وقت فتح التطبيق متصلا',
};

/** القيمة بوحدتها — والدقائق ساعاتٍ ودقائق */
export function formatRankingValue(metric: RankingMetric, v: number, tr: (s: string) => string, unit?: string): string {
  if (metric === 'sales') return formatCurrency(v);
  if (metric === 'appTime') return `${Math.floor(v / 60)} ${tr('س')} ${Math.round(v % 60)} ${tr('د')}`;
  if (metric === 'distance') return `${Number(v.toFixed(1))} ${tr('كم')}`;
  if (metric === 'visits') return `${v} ${tr('زيارة')}`;
  return `${Number(v.toFixed(3))}${unit ? ` ${unit}` : ''}`;
}

const MEDAL = ['text-[#C9A227]', 'text-[#8E9AA6]', 'text-[#B0703C]']; // ذهبي، فضّي، برونزي

export default function RepRankingBoard({
  metric, onMetric, metrics, products, productId, onProduct, data, loading, rows,
}: {
  metric: RankingMetric;
  onMetric: (m: RankingMetric) => void;
  /** المعايير المتاحة (الماليّة تختفي مع المحاسبة المطفأة) */
  metrics: RankingMetric[];
  products: { id: string; name: string }[];
  productId: string;
  onProduct: (id: string) => void;
  data: RankingData | undefined;
  loading: boolean;
  /** الصفوف بعد البحث بالاسم */
  rows: RankingRow[];
}) {
  const tr = useTr();
  const max = Math.max(0, ...rows.map(r => r.value));
  const needsProduct = metric === 'product' && !productId;

  return (
    <div className="space-y-4">
      <div className="card p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">{tr('معيار التقييم')}</label>
          <select className="input w-56" value={metric} onChange={e => onMetric(e.target.value as RankingMetric)}>
            {metrics.map(m => <option key={m} value={m}>{tr(RANKING_LABELS[m])}</option>)}
          </select>
        </div>
        {metric === 'product' && (
          <div className="w-64">
            <label className="label">{tr('الصنف')}</label>
            <SearchableSelect
              placeholder={tr('اختر الصنف')}
              searchPlaceholder={tr('اكتب اسم الصنف')}
              value={productId}
              options={products.map(p => ({ value: p.id, label: p.name }))}
              onChange={v => onProduct(v)}
            />
          </div>
        )}
        <p className="text-[11px] text-[#9A8F7E] flex-1 min-w-[200px] pb-2.5">{tr(RANKING_NOTES[metric])}</p>
      </div>

      {data?.clampedDays && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2">
          {tr('المسافة تحسب لآخر')} {data.clampedDays} {tr('يوما من المدة المختارة')} ({data.range.from} — {data.range.to})
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <Trophy size={17} className="text-[#E15A30]" />
          {tr('ترتيب المناديب حسب')} {tr(RANKING_LABELS[metric])}
          {metric === 'product' && data?.product && <span className="text-[#6E6557] font-semibold">— {data.product.name}</span>}
        </div>
        {needsProduct ? (
          <p className="p-8 text-center text-gray-400 text-sm">{tr('اختر الصنف لعرض الترتيب')}</p>
        ) : loading ? (
          <p className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</p>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-gray-400 text-sm">{tr('لا يوجد مناديب')}</p>
        ) : (
          <div className="divide-y divide-[#F1EBDF]">
            {rows.map(r => (
              <div key={r.repId} className="px-5 py-3 flex items-center gap-3">
                <span className="w-9 shrink-0 flex items-center justify-center">
                  {r.rank <= 3 && r.value > 0
                    ? <Medal size={22} className={MEDAL[r.rank - 1]} aria-label={`${r.rank}`} />
                    : <span className="text-sm font-bold text-[#9A8F7E]">{r.rank}</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-sm text-[#1F1A13] truncate">{r.name}</span>
                    <span className={`text-sm font-bold whitespace-nowrap ${r.value > 0 ? 'text-[#1F1A13]' : 'text-[#9A8F7E]'}`}>
                      {formatRankingValue(metric, r.value, tr, data?.product?.unit)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 rounded-full bg-[#F1EBDF] overflow-hidden">
                    <div className="h-full rounded-full bg-[#E15A30]" style={{ width: `${max > 0 ? Math.max(2, (r.value / max) * 100) : 0}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
