import { useQuery } from '@tanstack/react-query';
import { lotsApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatNumber } from '../utils/format';
import {
  LOT_EPS, lotDay, roundLot, LOT_STATUS_LABELS, type ProductLotDto, type LotBalancesDto,
} from '../lib/lots';
import { lotDraftProblem, type LotDraft, type LotDraftMode } from './mLots';

/** بطاقات تشغيلات الصنف (≤ ١٠٠، الأقرب انتهاءً أولاً) — مفتاحٌ واحد لكل من يحتاج أرقامها: المنتقي هنا ومعاينة FEFO */
export function useProductLots(productId: string, enabled = true) {
  return useQuery({
    queryKey: ['m-lot-opts', productId],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const d = (await lotsApi.list({ productId, limit: 100 })).data?.data;
      return Array.isArray(d) ? (d as ProductLotDto[]) : [];
    },
  });
}

/**
 * تشغيلة سطرٍ واحد لصنفٍ متتبَّع (سطرٌ = تشغيلةٌ واحدة): وارد المستودع وتسويته، والتحميل في شركة بلا مستودع (D4).
 *
 * اختيارٌ أصليّ (`<select>`) لا قائمةٌ مرسومة: منتقي الجوال نفسه بإبهامٍ واحد، ويقرأه قارئ الشاشة.
 *  - الزيادة: تشغيلات الصنف القائمة (الموقوفة تُقبل وتبقى معزولة)، أو «تشغيلة جديدة» برقمٍ وتاريخين، أو «غير مسمى»
 *    حيث يجوز (التسوية والتحميل، لا الوارد).
 *  - النقص: مصادر المستودع بصالحها، أو «غير مسمى»، أو بلا اختيار فيختار الخادم المصدر الوحيد ويرفض حين تتعدّد.
 *
 * الجلب لصنف السطر وحده وحين يُرسم — والسطر لا يُرسم إلا لصنفٍ متتبَّع والميزة مفعّلة.
 */
export default function MLotFields({ productId, mode, shelfOn, draft, onChange }: {
  productId: string;
  mode: LotDraftMode;
  shelfOn: boolean;
  draft: LotDraft;
  onChange: (d: LotDraft) => void;
}) {
  const tr = useTr();
  const out = mode === 'OUT';

  const lotsQ = useProductLots(productId, !out);
  const balQ = useQuery({
    queryKey: ['m-wh-lots', productId],
    enabled: out,
    staleTime: 15_000,
    queryFn: async () => ((await lotsApi.balances({ productId })).data?.data ?? null) as LotBalancesDto | null,
  });

  const view = balQ.data?.warehouse?.[0] ?? null;
  const sources = out
    ? (view?.lots ?? []).filter(l => l.usable.SELLABLE > LOT_EPS)
    : [];
  const unknownUsable = roundLot(view?.unknownUsable?.SELLABLE ?? 0);
  const problem = lotDraftProblem(draft, mode, { shelfOn });
  const set = (patch: Partial<LotDraft>) => onChange({ ...draft, ...patch });
  const loading = out ? balQ.isLoading : lotsQ.isLoading;

  return (
    <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-2.5 space-y-2">
      <label className="block">
        <span className="block text-[10px] font-semibold text-[#6E6557] mb-1">{tr('التشغيلة')}</span>
        <select className="input min-h-[44px]" value={draft.pick} disabled={loading}
          onChange={e => set({ pick: e.target.value })}>
          <option value="">{out ? tr('تلقائي حين يكون للصنف مصدر واحد') : tr('اختر التشغيلة')}</option>
          {out
            ? sources.map(l => (
              <option key={l.lotId} value={l.lotId}>
                {[l.meta.lotNumber, lotDay(l.meta.expiryDate), `${tr('المتاح')} ${formatNumber(l.usable.SELLABLE)}`,
                  l.meta.status === 'BLOCKED' ? tr(LOT_STATUS_LABELS.BLOCKED) : ''].filter(Boolean).join(' · ')}
              </option>
            ))
            : (lotsQ.data ?? []).map(l => (
              <option key={l.id} value={l.id}>
                {[l.lotNumber, lotDay(l.expiryDate), l.status === 'BLOCKED' ? tr(LOT_STATUS_LABELS.BLOCKED) : ''].filter(Boolean).join(' · ')}
              </option>
            ))}
          {!out && <option value="NEW">+ {tr('تشغيلة جديدة')}</option>}
          {mode !== 'IN_STRICT' && (!out || unknownUsable > LOT_EPS) && (
            <option value="UNNAMED">
              {tr('غير مسمى')}{out ? ` · ${tr('المتاح')} ${formatNumber(unknownUsable)}` : ''}
            </option>
          )}
        </select>
      </label>

      {draft.pick === 'NEW' && (
        <div className="space-y-2">
          <input className="input min-h-[44px]" dir="ltr" value={draft.lotNumber} maxLength={64}
            placeholder={tr('رقم التشغيلة')} aria-label={tr('رقم التشغيلة')}
            onChange={e => set({ lotNumber: e.target.value })} />
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0">
              <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('تاريخ الإنتاج')}</span>
              <input type="date" dir="ltr" className="input min-h-[44px]" value={draft.productionDate}
                onChange={e => set({ productionDate: e.target.value })} />
            </label>
            <label className="min-w-0">
              <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('تاريخ الانتهاء')}{shelfOn ? ' *' : ''}</span>
              <input type="date" dir="ltr" className="input min-h-[44px]" value={draft.expiryDate}
                onChange={e => set({ expiryDate: e.target.value })} />
            </label>
          </div>
        </div>
      )}

      {/* النقص بلا اختيار: يُقال ما سيحدث قبل الحفظ لا بعده */}
      {out && draft.pick === '' && sources.length + (unknownUsable > LOT_EPS ? 1 : 0) > 1 && (
        <p className="text-[10px] text-[#B7791F]">{tr('للصنف أكثر من مصدر في المستودع فاختر التشغيلة')}</p>
      )}
      {problem && <p className="text-[10px] text-[#C0392B]">{tr(problem)}</p>}
    </div>
  );
}
