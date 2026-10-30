import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { lotsApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatNumber } from '../utils/format';
import { localDay } from '../lib/paymentMethods';
import { LOT_STATUS_LABELS, type ProductLotDto, type LotBalancesDto } from '../lib/lots';
import { lotDraftProblem, lotPickChoices, stalePick, type LotDraft, type LotDraftMode, type LotPickChoice } from './mLotsLogic';

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
 * أرصدة تشغيلات الصنف في المستودع (GET /lots/balances) — خيارات واحدة لكل من يقرؤها: منتقي النقص هنا، وتحقّق أسطر الصنف
 * في نموذج الحركة (MWarehouse)، وتفصيل رصيد الصنف. المفتاح والجلب واحد فلا كاشان لرصيدٍ واحد.
 */
export const whLotsQuery = (productId: string) => ({
  queryKey: ['m-wh-lots', productId] as const,
  staleTime: 15_000,
  queryFn: async () => ((await lotsApi.balances({ productId })).data?.data ?? null) as LotBalancesDto | null,
});

/**
 * تشغيلة سطرٍ واحد لصنفٍ متتبَّع (سطرٌ = تشغيلةٌ واحدة): وارد المستودع وتسويته، والتحميل في شركة بلا مستودع (D4).
 *
 * اختيارٌ أصليّ (`<select>`) لا قائمةٌ مرسومة: منتقي الجوال نفسه بإبهامٍ واحد، ويقرأه قارئ الشاشة. والخيارات من
 * lotPickChoices (مرآة الخادم):
 *  - الوارد والتسوية بالزيادة: تشغيلات الصنف القائمة بوسم الموقوفة والمنتهية (الموقوفة تُقبل بتحذير وتبقى معزولة)، أو
 *    «تشغيلة جديدة» برقمٍ وتاريخين، أو «غير مسمى» حيث يجوز (التسوية والتحميل، لا الوارد).
 *  - تحميل السيارة بلا مستودع (LOAD): كذلك، إلا أن الموقوفة والمنتهية يوم الشركة معروضةٌ معطّلة — الخادم يرفضهما (I4).
 *  - النقص: مصادر المستودع بصالحها، أو «غير مسمى»، أو بلا اختيار فيختار الخادم المصدر الوحيد. وما يُمنع على مستوى الصنف
 *    (أكثر من مصدر بلا اختيار، أو فوق الصالح، أو سطران على تشغيلةٍ واحدة — D26) يحسبه النموذج ويمرّره groupProblem.
 * والاختيار الذي خرج من الخيارات (قلب الإشارة، تشغيلةٌ أُوقفت، مصدرٌ نفد) يُصفَّر حين تصل، فلا يُعرض غير ما يُرسل.
 *
 * الجلب لصنف السطر وحده وحين يُرسم — والسطر لا يُرسم إلا لصنفٍ متتبَّع والميزة مفعّلة.
 */
export default function MLotFields({ productId, mode, shelfOn, draft, onChange, day, groupProblem }: {
  productId: string;
  mode: LotDraftMode;
  shelfOn: boolean;
  draft: LotDraft;
  onChange: (d: LotDraft) => void;
  /** يوم الشركة لانتهاء التشغيلات (لقطة السيارة تحمله) — وإلا يوم الجهاز */
  day?: string;
  /** مشكلة السطر على مستوى الصنف (مفتاح قاموس) — النقص من المستودع */
  groupProblem?: string | null;
}) {
  const tr = useTr();
  const out = mode === 'OUT';

  const lotsQ = useProductLots(productId, !out);
  const balQ = useQuery({ ...whLotsQuery(productId), enabled: out });

  const choices = lotPickChoices(mode, { lots: lotsQ.data, view: balQ.data?.warehouse?.[0] ?? null }, day || localDay());
  const ready = out ? balQ.isSuccess : lotsQ.isSuccess;
  const stale = ready && stalePick(draft.pick, choices);
  useEffect(() => {
    if (stale) onChange({ ...draft, pick: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- يُصفَّر مرّةً حين يخرج الاختيار من الخيارات، لا بكل رسم
  }, [stale]);

  // يوم الشركة الممرَّر وحده (لا يوم الجهاز) كما يحكم به النموذج قبل الحفظ — فلا تختلف الرسالة عن المنع
  const problem = lotDraftProblem(draft, mode, { shelfOn, day }) ?? groupProblem ?? null;
  const set = (patch: Partial<LotDraft>) => onChange({ ...draft, ...patch });
  const loading = out ? balQ.isLoading : lotsQ.isLoading;

  const label = (c: LotPickChoice): string => {
    if (c.kind === 'NEW') return `+ ${tr('تشغيلة جديدة')}`;
    const avail = c.usable != null ? `${tr('المتاح')} ${formatNumber(c.usable)}` : '';
    if (c.kind === 'UNNAMED') return [tr('غير مسمى'), avail].filter(Boolean).join(' · ');
    return [c.lotNumber, c.expiryDate, avail, c.blocked ? tr(LOT_STATUS_LABELS.BLOCKED) : '', c.expired ? tr('منتهي الصلاحية') : '']
      .filter(Boolean).join(' · ');
  };

  return (
    <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] p-2.5 space-y-2">
      <label className="block">
        <span className="block text-[10px] font-semibold text-[#6E6557] mb-1">{tr('التشغيلة')}</span>
        <select className="input min-h-[44px]" value={stale ? '' : draft.pick} disabled={loading}
          onChange={e => set({ pick: e.target.value })}>
          <option value="">{out ? tr('تلقائي حين يكون للصنف مصدر واحد') : tr('اختر التشغيلة')}</option>
          {choices.map(c => <option key={c.value} value={c.value} disabled={c.disabled}>{label(c)}</option>)}
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

      {problem && <p className="text-[10px] text-[#C0392B]">{tr(problem)}</p>}
    </div>
  );
}
