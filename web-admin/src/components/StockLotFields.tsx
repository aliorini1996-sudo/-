// ============================================================================
// «تتبّع اللوط» في شاشتي المخزون (W2): حقول التشغيلة المشتركة بين مخزون الشركة
// ومخزون السيارات — محرّر صفوف التوزيع (اقتراح FEFO قابل للتعديل والتقسيم،
// ومصدر الإنقاص الصريح D10)، وحقول تشغيلة سطر الوارد والتسوية والتحميل المباشر.
// المنطق الصرف في lib/stockLots.ts، والكميات كلها بوحدة الأساس (D22).
// ============================================================================

import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Layers } from 'lucide-react';
import { lotsApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatDayOnly } from '../utils/format';
import { LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS, normalizeLotNumber, roundLot, type ProductLotDto } from '../lib/lots';
import {
  draftRemaining, entryLotModes, sourceKey, splitDraft, withKnownLotDates,
  type DraftProblem, type EntryLotDraft, type EntryLotKind, type EntryLotMode, type EntryLotProblem, type LotBalancesResponse, type LotRowDraft, type LotSource,
} from '../lib/stockLots';

type Tr = (s: string) => string;
export const fmtLotQty = (n: number) => Number(roundLot(n).toFixed(4)).toLocaleString('en-US');

/** أرصدة التشغيلات لأصنافٍ (GET /lots/balances بحدّ ٥٠ صنفاً للطلب، فتُقسَّم دفعات وتُدمج) — المستودع وكل سيارة */
export async function fetchLotBalances(ids: readonly string[], asOf?: string): Promise<LotBalancesResponse> {
  const out: LotBalancesResponse = { asOf: null, day: new Date().toLocaleDateString('en-CA'), warehouse: [], vans: [] };
  for (let i = 0; i < ids.length; i += 50) {
    const r = (await lotsApi.balances({ productIds: ids.slice(i, i + 50), asOf: asOf || undefined })).data.data as LotBalancesResponse;
    out.day = r.day || out.day;
    out.asOf = r.asOf ?? out.asOf;
    out.warehouse.push(...(r.warehouse ?? []));
    out.vans.push(...(r.vans ?? []));
  }
  return out;
}

/** وصف المصدر في المنتقي: الرقم (أو «غير مسمى»)، والانتهاء، والحالة غير النشطة، والصالح */
export function sourceLabel(s: LotSource, tr: Tr): string {
  const name = s.lotNumber ?? tr('غير مسمى');
  const exp = s.expiryDate ? ` · ${tr('ينتهي')} ${formatDayOnly(s.expiryDate)}` : '';
  const state = s.status === 'BLOCKED'
    ? ` · ${tr(s.blockKind ? LOT_BLOCK_KIND_LABELS[s.blockKind] : LOT_STATUS_LABELS.BLOCKED)}`
    : s.expired ? ` · ${tr('منتهية')}` : '';
  return `${name}${exp}${state} — ${tr('متاح')} ${fmtLotQty(s.usable)}`;
}

export function draftProblemText(p: DraftProblem | null, tr: Tr): string | null {
  if (!p) return null;
  if (p === 'LOT_SOURCE_MISSING') return tr('اختر التشغيلة لكل صف');
  if (p === 'LOT_SOURCE_DUPLICATE') return tr('التشغيلة مكررة في صفين');
  if (p === 'LOT_OVER_SOURCE') return tr('الكمية أكبر من المتاح في التشغيلة');
  return tr('مجموع كميات التشغيلات يجب أن يساوي كمية السطر بوحدة الأساس');
}

export function entryProblemText(p: EntryLotProblem | null, tr: Tr): string | null {
  if (!p) return null;
  if (p === 'LOT_EXPIRY_REQUIRED') return tr('تاريخ انتهاء التشغيلة إلزامي لصنف صلاحيته مفعلة');
  if (p === 'LOT_DATES_INVALID') return tr('تاريخ الإنتاج بعد تاريخ الانتهاء أو تاريخ غير صالح');
  if (p === 'LOT_OVER_SOURCE') return tr('الكمية أكبر من المتاح في التشغيلة');
  return tr('حدد التشغيلة لهذا السطر');
}

/**
 * صفوف التوزيع على التشغيلات: مصدرٌ وكمية أساسية لكل صف، وتقسيمٌ على تشغيلة أخرى، وما بقي بلا توزيع. المصدر الغائب عن
 * القائمة (نفد بعد الاقتراح) يبقى ظاهراً موسوماً فلا يتبدّل بصمت.
 */
export function LotRowsEditor({ rows, onChange, sources, lineBaseQty, baseUnit, problem }: {
  rows: LotRowDraft[]; onChange: (rows: LotRowDraft[]) => void; sources: LotSource[]; lineBaseQty: number;
  baseUnit?: string; problem?: DraftProblem | null;
}) {
  const tr = useTr();
  const left = draftRemaining(rows, lineBaseQty);
  const known = new Set(sources.map((s) => sourceKey(s.lotId)));
  const patch = (key: string, p: Partial<LotRowDraft>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-1.5">
          <select className="input py-1 text-xs flex-1 min-w-0" value={r.source} aria-label={tr('التشغيلة')}
            onChange={(e) => patch(r.key, { source: e.target.value })}>
            <option value="">{tr('اختر التشغيلة')}</option>
            {sources.map((s) => <option key={sourceKey(s.lotId)} value={sourceKey(s.lotId)}>{sourceLabel(s, tr)}</option>)}
            {r.source && !known.has(r.source) && <option value={r.source}>{tr('تشغيلة لم تعد متاحة')}</option>}
          </select>
          <input type="number" step="any" min="0" inputMode="decimal" className="input w-20 py-1 text-center text-xs" value={r.qty}
            aria-label={tr('الكمية بوحدة الأساس')} onChange={(e) => patch(r.key, { qty: e.target.value })} />
          <button type="button" onClick={() => onChange(rows.filter((x) => x.key !== r.key))} title={tr('حذف')}
            className="p-1 text-red-400 hover:text-red-600"><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <button type="button" onClick={() => onChange(splitDraft(rows, lineBaseQty, sources))}
          disabled={rows.length >= sources.length && rows.every((r) => known.has(r.source))}
          className="text-[11px] font-semibold text-[#E15A30] inline-flex items-center gap-1 disabled:opacity-40">
          <Plus size={12} /> {rows.length ? tr('تقسيم على تشغيلة أخرى') : tr('حدد التشغيلة')}
        </button>
        <span className={`text-[10px] ${Math.abs(left) > 1e-6 ? 'text-amber-700 font-semibold' : 'text-[#9A8F7E]'}`}>
          {tr('المتبقي بلا توزيع')}: {fmtLotQty(left)}{baseUnit ? ` ${baseUnit}` : ''}
        </span>
      </div>
      {problem && <p className="text-[10px] text-red-600">{draftProblemText(problem, tr)}</p>}
    </div>
  );
}

const MODE_LABELS: Record<EntryLotMode, string> = {
  NEW: 'رقم التشغيلة', EXISTING: 'تشغيلة قائمة', UNKNOWN: 'غير مسمى', AUTO: 'تلقائي',
};

/**
 * تشغيلة سطرٍ واحد (§٤.٤، وD4 للتحميل بلا مستودع): رقمٌ وتاريخان (يُحلّ القائم برقمه أو يُنشأ)، أو تشغيلة قائمة، أو «غير مسمّى»
 * صراحةً، أو «تلقائي» للنقص من مصدرٍ وحيد. والنقص يختار من مصادر المكان (`sources`) لا من بطاقات الصنف، و«التلقائي» يُوصف
 * بمصادره الباقية بعد صريح أسطر صنفه (`autoSources`، autoDecreaseSources) إن مُرِّرت.
 */
export function EntryLotFields({ productId, kind, value, onChange, expiryRequired, sources, autoSources, problem }: {
  productId: string; kind: EntryLotKind; value: EntryLotDraft; onChange: (d: EntryLotDraft) => void;
  expiryRequired: boolean; sources?: LotSource[]; autoSources?: LotSource[]; problem?: EntryLotProblem | null;
}) {
  const tr = useTr();
  const modes = entryLotModes(kind);
  const mode = modes.includes(value.mode) ? value.mode : modes[0];
  const d = mode === value.mode ? value : { ...value, mode };
  // بطاقات الصنف للرقم المقترح وللقائمة — لا تُجلب للنقص (مصادره من المكان)
  const lotsQ = useQuery({
    queryKey: ['lots-of-product', productId],
    queryFn: async () => (await lotsApi.list({ productId, limit: 200 })).data.data as ProductLotDto[],
    enabled: kind !== 'DECREASE' && (mode === 'NEW' || mode === 'EXISTING'),
    staleTime: 60_000,
  });
  const known = lotsQ.data ?? [];
  const listId = `lot-numbers-${productId}`;
  const named = (sources ?? []).filter((s) => s.lotId !== null);
  const auto = autoSources ?? sources;
  return (
    <div className="mt-1.5 rounded-lg border border-[#F1EBDF] bg-[#FAF7F0] px-2 py-1.5 space-y-1.5">
      <div className="flex items-center gap-1 flex-wrap">
        <Layers size={12} className="text-[#E15A30]" />
        {modes.map((m) => (
          <button key={m} type="button" onClick={() => onChange({ ...d, mode: m })}
            className={`text-[10px] font-semibold rounded-md px-2 py-0.5 border ${mode === m ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`}>
            {tr(MODE_LABELS[m])}
          </button>
        ))}
      </div>
      {mode === 'NEW' && (
        <div className="grid grid-cols-3 gap-1.5">
          <input className="input py-1 text-xs" list={listId} maxLength={64} placeholder={tr('رقم التشغيلة')} aria-label={tr('رقم التشغيلة')}
            value={d.lotNumber} onChange={(e) => onChange({ ...d, lotNumber: e.target.value })}
            onBlur={() => onChange(withKnownLotDates(d, known))} />
          <datalist id={listId}>{known.map((l) => <option key={l.id} value={l.lotNumber} />)}</datalist>
          <input type="date" className="input py-1 text-xs" title={tr('تاريخ الإنتاج')} aria-label={tr('تاريخ الإنتاج')}
            value={d.productionDate} onChange={(e) => onChange({ ...d, productionDate: e.target.value })} />
          <input type="date" className={`input py-1 text-xs ${expiryRequired && !d.expiryDate ? 'border-amber-300' : ''}`}
            title={expiryRequired ? tr('تاريخ الانتهاء إلزامي') : tr('تاريخ الانتهاء')} aria-label={tr('تاريخ الانتهاء')}
            value={d.expiryDate} onChange={(e) => onChange({ ...d, expiryDate: e.target.value })} />
          {normalizeLotNumber(d.lotNumber) && known.some((l) => l.lotNumber === normalizeLotNumber(d.lotNumber)) && (
            <p className="col-span-3 text-[10px] text-[#6E6557]">{tr('تشغيلة مسجلة تضاف الكمية إليها')}</p>
          )}
        </div>
      )}
      {mode === 'EXISTING' && (
        <select className="input py-1 text-xs w-full" value={d.lotId} aria-label={tr('تشغيلة قائمة')}
          onChange={(e) => onChange({ ...d, lotId: e.target.value })}>
          <option value="">{tr('اختر التشغيلة')}</option>
          {kind === 'DECREASE'
            ? named.map((s) => <option key={s.lotId!} value={s.lotId!}>{sourceLabel(s, tr)}</option>)
            : known.map((l) => (
              <option key={l.id} value={l.id}>
                {l.lotNumber}{l.expiryDate ? ` · ${tr('ينتهي')} ${formatDayOnly(l.expiryDate)}` : ''}{l.status === 'BLOCKED' ? ` · ${tr(LOT_STATUS_LABELS.BLOCKED)}` : ''}
              </option>
            ))}
        </select>
      )}
      {mode === 'UNKNOWN' && <p className="text-[10px] text-[#6E6557]">{tr('تسجل الكمية رصيدا غير مسمى يمكن تسميته لاحقا')}</p>}
      {mode === 'AUTO' && (
        <p className="text-[10px] text-[#6E6557]">
          {(auto?.length ?? 0) > 1 ? tr('للصنف أكثر من تشغيلة حدد ما ينقص منه')
            : auto?.length === 1 ? `${tr('ينقص من المصدر الوحيد')}: ${sourceLabel(auto[0], tr)}` : tr('ينقص من المصدر الوحيد')}
        </p>
      )}
      {problem && <p className="text-[10px] text-red-600">{entryProblemText(problem, tr)}</p>}
    </div>
  );
}
