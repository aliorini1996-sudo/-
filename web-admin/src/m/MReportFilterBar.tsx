import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { customerApi } from '../api/client';
import { formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray } from './shape';
import {
  FILTER_LABELS, NO_TEAM, matchesSearch, type FilterKey, type FilterPick, type ReportFilters, type SortId, type SortOption,
} from './mReportFilters';

/**
 * لبنات مصافي التقارير في /m (طلب المالك ١٣ نوفمبر ٢٠٢٦): شريط الشرائح، وورقة الاختيار، وأداتا البحث والترتيب.
 * القرار كلّه في mReportFilters.ts (أيّ مصفاة لأيّ تقرير، وما يُرسل للخادم) — هنا الرسم وحده.
 */

/** مندوبٌ كما يردّه /sales-reps — `locationId` موقعه الحالي («لوكيشن») لتصفية مديونيات المناديب بالموقع على الجهاز */
export interface RepLite { id: string; name: string; phone?: string | null; isActive?: boolean; locationId?: string | null }
/** فريقٌ أو موقعٌ: المؤرشف يبقى قابلاً للاختيار موسوماً (مستنداته القديمة تحمل وسمه) */
export interface NamedLite { id: string; name: string; isActive?: boolean }
interface CustLite { id: string; name: string; businessName?: string | null; phone?: string | null; code?: string | null }

// ═══════════════ شريط الشرائح ═══════════════

/**
 * صفٌّ واحد يُمرَّر أفقياً: شريحةٌ لكل مصفاةٍ تنطبق على التقرير — فارغةً «المندوب ▾» تفتح الاختيار، ومختارةً «المندوب: أحمد ✕»
 * تُزال بضغطة. ومصافٍ مختارة لا يقرؤها هذا التقرير تُذكر بسطرٍ تحتها لا تختفي بصمت.
 */
export function FilterBar({ keys, filters, ignored, onOpen, onClear, onClearAll }: {
  keys: FilterKey[]; filters: ReportFilters; ignored: FilterKey[];
  onOpen: (k: FilterKey) => void; onClear: (k: FilterKey) => void; onClearAll: () => void;
}) {
  const tr = useTr();
  if (keys.length === 0 && ignored.length === 0) return null;
  const active = keys.filter(k => !!filters[k]).length;
  return (
    <div className="flex-shrink-0 bg-white border-b border-[#F1EBDF] px-3 py-2 space-y-1">
      {keys.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto overscroll-x-contain">
          <SlidersHorizontal size={14} className="text-[#9A8F7E] flex-shrink-0" aria-hidden />
          {keys.map(k => {
            const v = filters[k];
            return v ? (
              <span key={k} className="flex-shrink-0 flex items-center rounded-lg border border-[#E15A30] bg-[#FBEBE2] text-[#C94E28] text-[11px] font-semibold">
                <button type="button" onClick={() => onOpen(k)} className="ps-3 pe-1 min-h-[36px] whitespace-nowrap max-w-[11rem] truncate">
                  {tr(FILTER_LABELS[k])}: {v.name}
                </button>
                <button type="button" onClick={() => onClear(k)} aria-label={`${tr('إزالة')} ${tr(FILTER_LABELS[k])}`}
                  className="w-8 min-h-[36px] flex items-center justify-center">
                  <X size={13} />
                </button>
              </span>
            ) : (
              <button key={k} type="button" onClick={() => onOpen(k)}
                className="flex-shrink-0 flex items-center gap-1 px-3 min-h-[36px] rounded-lg border border-[#E9E1D3] bg-white text-[#6E6557] text-[11px] font-semibold whitespace-nowrap">
                {tr(FILTER_LABELS[k])}<ChevronDown size={12} className="text-[#B3A996]" />
              </button>
            );
          })}
          {active > 1 && (
            <button type="button" onClick={onClearAll}
              className="flex-shrink-0 px-3 min-h-[36px] rounded-lg text-[11px] font-semibold whitespace-nowrap text-[#9A8F7E]">
              {tr('مسح الفلاتر')}
            </button>
          )}
        </div>
      )}
      {ignored.length > 0 && (
        <p className="text-[10.5px] text-[#9A8F7E] px-0.5">
          {tr('لا ينطبق على هذا التقرير')}: {ignored.map(k => tr(FILTER_LABELS[k])).join('، ')}
        </p>
      )}
    </div>
  );
}

// ═══════════════ ورقة الاختيار ═══════════════

const SHEET_TITLE: Record<FilterKey, string> = { rep: 'اختر المندوب', customer: 'اختر العميل', team: 'اختر الفريق', location: 'اختر الموقع' };
const ALL_LABEL: Record<FilterKey, string> = { rep: 'كل المناديب', customer: 'كل العملاء', team: 'كل الفرق', location: 'كل المواقع' };

interface Item { id: string; name: string; sub?: string }

/**
 * ورقة سفلية للاختيار (نمط MLots/MProducts: الخلفية زرٌّ حقيقي). المناديب والفرق والمواقع قوائم قصيرة تُبحث على الجهاز؛
 * والعملاء يُبحثون **على الخادم** (customerApi.list بـsearch) فيصل البحث لأيّ عميل مهما طالت القائمة.
 */
export function PickerSheet({ kind, value, reps, teams, locations, onPick, onClose }: {
  kind: FilterKey; value: FilterPick | null;
  reps: { data?: RepLite[]; status: 'pending' | 'error' | 'success'; refetch: () => void };
  teams: NamedLite[]; locations: NamedLite[];
  onPick: (p: FilterPick | null) => void; onClose: () => void;
}) {
  const tr = useTr();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const custQ = useQuery({
    queryKey: ['m-report-pick-customers', dq],
    queryFn: async () => expectArray<CustLite>((await customerApi.list({ search: dq, limit: 40 })).data?.data, 'العملاء'),
    enabled: kind === 'customer',
  });

  const archived = (n: NamedLite) => (n.isActive === false ? ` (${tr('مؤرشف')})` : '');
  const items: Item[] = useMemo(() => {
    if (kind === 'customer') {
      return (custQ.data ?? []).map(c => ({ id: c.id, name: c.name, sub: [c.businessName, c.code, c.phone].filter(Boolean).join(' · ') }));
    }
    if (kind === 'rep') {
      // النشطون أولاً — الموقوف يبقى قابلاً للاختيار (فواتيره القديمة في المدى) موسوماً
      const list = [...(reps.data ?? [])].sort((a, b) => Number(b.isActive !== false) - Number(a.isActive !== false));
      return list.filter(r => matchesSearch(q, [r.name, r.phone]))
        .map(r => ({ id: r.id, name: r.name, sub: r.isActive === false ? tr('غير نشط') : undefined }));
    }
    const src = kind === 'team' ? teams : locations;
    const named = src.filter(n => matchesSearch(q, [n.name])).map(n => ({ id: n.id, name: `${n.name}${archived(n)}` }));
    // «بلا فريق»: المستندات بلا وسم فريق والمناديب بلا عضوية — الخادم يفهمها (reportTeamOf)
    return kind === 'team' && matchesSearch(q, [tr('بلا فريق')]) ? [{ id: NO_TEAM, name: tr('بلا فريق') }, ...named] : named;
  }, [kind, custQ.data, reps.data, teams, locations, q, tr]); // eslint-disable-line react-hooks/exhaustive-deps

  // البحث يظهر حيث يلزم: العملاء والمناديب دائماً، والفرق والمواقع حين تطول القائمة
  const searchable = kind === 'customer' || kind === 'rep' || (kind === 'team' ? teams.length : locations.length) > 8;
  const status = kind === 'customer' ? custQ.status : kind === 'rep' ? reps.status : 'success';
  const retry = kind === 'customer' ? () => { void custQ.refetch(); } : reps.refetch;

  return (
    <div className="absolute inset-0 z-30 flex items-end">
      <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="absolute inset-0 bg-black/40" />
      <div className="relative w-full bg-white rounded-t-2xl border-t border-[#E9E1D3] p-4 space-y-3 max-h-[85%] flex flex-col"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <div className="flex items-center gap-2 flex-shrink-0">
          <p className="flex-1 text-sm font-bold text-[#1F1A13]">{tr(SHEET_TITLE[kind])}</p>
          <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="w-9 h-9 -m-1 flex items-center justify-center text-[#9A8F7E]">
            <X size={18} />
          </button>
        </div>
        {searchable && (
          <div className="relative flex-shrink-0">
            <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
            <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9"
              placeholder={tr(kind === 'customer' ? 'ابحث عن عميل' : kind === 'rep' ? 'ابحث عن مندوب' : 'بحث')} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-[#F1EBDF] divide-y divide-[#F1EBDF]">
          <Choice label={tr(ALL_LABEL[kind])} selected={!value} muted onClick={() => onPick(null)} />
          {status === 'pending' ? <div className="h-40"><MSpinner /></div>
            : status === 'error' ? <div className="h-48"><MError onRetry={retry} /></div>
            : items.length === 0 ? <div className="h-32"><MEmpty text={tr('لا نتائج')} /></div>
            : items.map(it => (
              <Choice key={it.id} label={it.name} sub={it.sub} selected={value?.id === it.id}
                onClick={() => onPick({ id: it.id, name: it.name })} />
            ))}
        </div>
      </div>
    </div>
  );
}

function Choice({ label, sub, selected, muted, onClick }: {
  label: string; sub?: string; selected: boolean; muted?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`w-full text-start px-3 py-2.5 min-h-[52px] flex items-center gap-2 ${selected ? 'bg-[#FBEBE2]' : 'active:bg-[#FAF7F0]'}`}>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm truncate ${muted ? 'text-[#6E6557] font-medium' : 'text-[#1F1A13] font-semibold'}`}>{label}</span>
        {sub && <span className="block text-[11px] text-[#9A8F7E] truncate">{sub}</span>}
      </span>
      {selected && <Check size={16} className="text-[#E15A30] flex-shrink-0" />}
    </button>
  );
}

// ═══════════════ البحث والترتيب داخل النتائج ═══════════════

/**
 * بحثٌ بالاسم (والرمز للصنف) وترتيبٌ للقائمة المعروضة — على الجهاز: التقرير وصل كاملاً. البطاقات فوقها تبقى مجاميع التقرير
 * كلّه بمصافيه؛ البحث أداة إيجادٍ في القائمة لا مصفاةٌ ثانية، فيُذكر عدد ما يُرى من الكل.
 */
export function ListTools({ q, onQ, sort, onSort, options, shown, total }: {
  q: string; onQ: (v: string) => void; sort: SortId; onSort: (s: SortId) => void;
  options: ReadonlyArray<SortOption>; shown: number; total: number;
}) {
  const tr = useTr();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => onQ(e.target.value)} placeholder={tr('بحث')} aria-label={tr('بحث')}
            className="input ps-8 pe-8 min-h-[40px] text-xs" />
          {q && (
            <button type="button" onClick={() => onQ('')} aria-label={tr('مسح')}
              className="absolute top-1/2 -translate-y-1/2 end-1 w-8 h-8 flex items-center justify-center text-[#9A8F7E]">
              <X size={14} />
            </button>
          )}
        </div>
        {options.length > 1 && (
          <select value={sort} onChange={e => onSort(e.target.value as SortId)} aria-label={tr('الترتيب')}
            className="input !w-auto max-w-[45%] min-h-[40px] text-xs flex-shrink-0">
            {options.map(o => <option key={o.id} value={o.id}>{tr(o.label)}</option>)}
          </select>
        )}
      </div>
      {q.trim() && (
        <p className="text-[11px] text-[#9A8F7E] px-1">{tr('النتائج')}: {formatNumber(shown)} / {formatNumber(total)}</p>
      )}
    </div>
  );
}
