import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Filter, Layers, Star, Search, Settings, X, Check, Trash2, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTr } from '../../i18n/strings';
import { useDir } from '../../i18n/lang';
import { useAuthStore } from '../../store/authStore';
import { canLedger, type LedgerKey } from '../../lib/ledgerPerms';
import { ledgerMovesApi, ledgerMoveKeys, type SavedFilterDomain } from '../../api/ledgerMoves';

/**
 * قائمة الدفاتر الموحّدة (NAV‑09، §8.3): وسوم البحث القابلة للإزالة (قمع للفلتر، طبقات للتجميع،
 * نجمة للمفضلة)، وقائمة بحث بثلاثة أعمدة (الفلاتر، التجميع، المفضلات `GlSavedFilter`)، وترقيم
 * «1-80 / الإجمالي»، ومبدّل العروض، وأعمدة اختيارية، وتحديد جماعي.
 *
 * **التحديد لا يظهر إلا حين يملك المستخدم إجراءً جماعياً واحداً على الأقل**، وكل إجراء يُخفى دون صلاحيته.
 * القائمة متحكَّم بها: الصفحة تملك `state` وتجلب البيانات به، والمكوّن يعرض ويطلق `onStateChange`.
 */

export const LEDGER_PAGE_SIZE = 80;

export interface LedgerColumn<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** عمود اختياري: يُفعَّل من «الأعمدة الاختيارية» */
  optional?: boolean;
  /** للاختياري: ظاهر افتراضياً */
  defaultVisible?: boolean;
  align?: 'start' | 'end' | 'center';
  className?: string;
}

/** فلتر جاهز (COA‑06، JE‑…): مفتاح مع تسمية، ومجموعته (الفلاتر في مجموعة واحدة OR، وبين المجموعات AND — الخادم يقرّر). */
export interface LedgerFilterDef { key: string; label: string; group?: string }
export interface LedgerGroupByDef<T> { key: string; label: string; value: (row: T) => string }

export interface LedgerAction {
  label: string;
  perm: LedgerKey;
  run: (ids: string[]) => void | Promise<unknown>;
  danger?: boolean;
  /** سبب التعطيل (يُعرض تلميحاً) أو null */
  disabledReason?: (ids: string[]) => string | null;
}

export interface LedgerGearAction {
  label: string;
  perm: LedgerKey;
  run: () => void | Promise<unknown>;
}

export interface LedgerListState {
  search: string;
  filters: string[];
  groupBy: string[];
  offset: number;
  limit: number;
  /** معرّف المفضلة المطبّقة (للوسم) */
  favoriteId?: string | null;
}

export const initialLedgerListState = (over: Partial<LedgerListState> = {}): LedgerListState => ({
  search: '', filters: [], groupBy: [], offset: 0, limit: LEDGER_PAGE_SIZE, favoriteId: null, ...over,
});

/** حالة التنقّل التي تمرّرها القائمة إلى LedgerForm (عدّاد «16 / 80» بالفلاتر نفسها). */
export interface LedgerRecordNavState { ledgerIds: string[]; ledgerListPath: string }

interface Props<T extends { id: string }> {
  title: string;
  /** مفتاح الشاشة لمفضلات GlSavedFilter؛ غيابه يخفي عمود المفضلات */
  screen?: string;
  columns: LedgerColumn<T>[];
  rows: T[];
  total: number;
  loading?: boolean;
  fetching?: boolean;
  state: LedgerListState;
  onStateChange: (s: LedgerListState) => void;
  filters?: LedgerFilterDef[];
  groupBys?: LedgerGroupByDef<T>[];
  bulkActions?: LedgerAction[];
  gearActions?: LedgerGearAction[];
  /** فتح سجل: يُمرَّر ترتيب المعرّفات الحالي */
  recordPath?: (row: T) => string;
  onRowClick?: (row: T, orderedIds: string[]) => void;
  views?: { key: string; label: string }[];
  view?: string;
  onViewChange?: (key: string) => void;
  /** أزرار يسار الشريط (مثل «جديد») */
  toolbar?: ReactNode;
  emptyText?: string;
  /** صف تذييل (إجماليات) */
  footer?: ReactNode;
  rowClassName?: (row: T) => string;
}

export function LedgerLoadingToast({ show }: { show: boolean }) {
  const tr = useTr();
  if (!show) return null;
  return (
    <div className="fixed bottom-4 inset-x-0 flex justify-center pointer-events-none z-50" role="status" aria-live="polite">
      <span className="px-4 py-1.5 rounded-full bg-[#1F1A13] text-white text-xs shadow-lg">{tr('جاري التحميل...')}</span>
    </div>
  );
}

export function LedgerListView<T extends { id: string }>(props: Props<T>) {
  const {
    title, screen, columns, rows, total, loading, fetching, state, onStateChange, filters = [], groupBys = [],
    bulkActions = [], gearActions = [], recordPath, onRowClick, views, view, onViewChange, toolbar, emptyText, footer, rowClassName,
  } = props;
  const tr = useTr();
  const dir = useDir();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [panelOpen, setPanelOpen] = useState(false);
  const [gearOpen, setGearOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [searchText, setSearchText] = useState(state.search);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleOptional, setVisibleOptional] = useState<Set<string>>(
    () => new Set(columns.filter(c => c.optional && c.defaultVisible).map(c => c.key)),
  );
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSearchText(state.search), [state.search]);
  // تغيّر الصفحة أو الفلاتر يُسقط التحديد (لا يُطبَّق إجراء على صفوف لم تعد ظاهرة)
  useEffect(() => setSelected(new Set()), [state.offset, state.search, state.filters.join('|'), state.groupBy.join('|')]);

  useEffect(() => {
    if (!panelOpen && !gearOpen) return;
    const h = (e: MouseEvent) => { if (panelRef.current && !panelRef.current.contains(e.target as Node)) { setPanelOpen(false); setGearOpen(false); setColsOpen(false); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [panelOpen, gearOpen]);

  const allowedBulk = bulkActions.filter(a => canLedger(user, a.perm));
  const allowedGear = gearActions.filter(a => canLedger(user, a.perm));
  const selectable = allowedBulk.length > 0;
  const shownColumns = columns.filter(c => !c.optional || visibleOptional.has(c.key));
  const optionalColumns = columns.filter(c => c.optional);
  const ids = useMemo(() => rows.map(r => r.id), [rows]);

  // ═══ المفضلات ═══
  const favQ = useQuery({
    queryKey: ledgerMoveKeys.savedFilters(screen ?? ''),
    queryFn: async () => (await ledgerMovesApi.savedFilters.list(screen!)).data.data,
    enabled: !!screen,
    staleTime: 60_000,
  });
  const saveFav = useMutation({
    mutationFn: (name: string) => ledgerMovesApi.savedFilters.create({
      screen: screen!, name,
      domainJson: { search: state.search, filters: Object.fromEntries(state.filters.map(f => [f, true])), groupBy: state.groupBy, columns: [...visibleOptional] },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ledgerMoveKeys.savedFilters(screen ?? '') }); toast.success(tr('تم حفظ البحث في المفضلة')); },
    onError: () => toast.error(tr('تعذر حفظ المفضلة')),
  });
  const delFav = useMutation({
    mutationFn: (id: string) => ledgerMovesApi.savedFilters.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ledgerMoveKeys.savedFilters(screen ?? '') }),
  });
  const applyFav = (id: string, d: SavedFilterDomain) => {
    onStateChange({
      ...state, offset: 0, favoriteId: id, search: d.search ?? '',
      filters: Object.entries(d.filters ?? {}).filter(([, v]) => v === true).map(([k]) => k),
      groupBy: d.groupBy ?? [],
    });
    if (d.columns) setVisibleOptional(new Set(d.columns));
    setPanelOpen(false);
  };
  const favorite = favQ.data?.find(f => f.id === state.favoriteId);

  const set = (patch: Partial<LedgerListState>) => onStateChange({ ...state, offset: 0, favoriteId: null, ...patch });
  const toggleIn = (arr: string[], k: string) => (arr.includes(k) ? arr.filter(x => x !== k) : [...arr, k]);

  // ═══ الترقيم ═══
  const from = total === 0 ? 0 : state.offset + 1;
  const to = Math.min(state.offset + state.limit, total);
  const prev = () => onStateChange({ ...state, offset: state.offset - state.limit < 0 ? Math.max(0, Math.floor((total - 1) / state.limit) * state.limit) : state.offset - state.limit });
  const next = () => onStateChange({ ...state, offset: state.offset + state.limit >= total ? 0 : state.offset + state.limit });

  const open = (row: T) => {
    if (onRowClick) return onRowClick(row, ids);
    if (recordPath) {
      const nav: LedgerRecordNavState = { ledgerIds: ids, ledgerListPath: window.location.pathname + window.location.search };
      navigate(recordPath(row), { state: nav });
    }
  };

  // ═══ التجميع (على الصفحة الحالية) ═══
  const grouped = useMemo(() => {
    const g = groupBys.find(x => x.key === state.groupBy[0]);
    if (!g) return null;
    const map = new Map<string, T[]>();
    for (const r of rows) { const k = g.value(r) || '—'; map.set(k, [...(map.get(k) ?? []), r]); }
    return [...map.entries()];
  }, [rows, groupBys, state.groupBy]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const allChecked = selectable && rows.length > 0 && rows.every(r => selected.has(r.id));
  const selIds = [...selected];

  const facets: { key: string; icon: ReactNode; label: string; clear: () => void }[] = [];
  const activeFilters = filters.filter(f => state.filters.includes(f.key));
  if (activeFilters.length) facets.push({ key: 'f', icon: <Filter size={12} />, label: activeFilters.map(f => f.label).join(` ${tr('أو')} `), clear: () => set({ filters: [] }) });
  const activeGroups = state.groupBy.map(k => groupBys.find(g => g.key === k)?.label).filter(Boolean) as string[];
  if (activeGroups.length) facets.push({ key: 'g', icon: <Layers size={12} />, label: activeGroups.join(' > '), clear: () => set({ groupBy: [] }) });
  if (favorite) facets.push({ key: 's', icon: <Star size={12} />, label: favorite.name, clear: () => set({ search: '', filters: [], groupBy: [] }) });

  const renderRow = (row: T) => (
    <tr key={row.id} className={`hover:bg-[#FBF7F0] cursor-pointer ${selected.has(row.id) ? 'bg-[#FBEBE2]/50' : ''} ${rowClassName?.(row) ?? ''}`} onClick={() => open(row)}>
      {selectable && (
        <td className="w-8" onClick={e => e.stopPropagation()}>
          <input type="checkbox" checked={selected.has(row.id)} aria-label={tr('تحديد')}
            onChange={() => setSelected(s => { const n = new Set(s); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })} />
        </td>
      )}
      {shownColumns.map(c => (
        <td key={c.key} className={`${c.align === 'end' ? 'text-end' : c.align === 'center' ? 'text-center' : 'text-start'} ${c.className ?? ''}`}>{c.render(row)}</td>
      ))}
      {optionalColumns.length > 0 && <td className="w-8" />}
    </tr>
  );

  return (
    <div className="space-y-3" dir={dir}>
      <LedgerLoadingToast show={!!fetching || !!loading} />
      {/* الشريط: العنوان والأزرار ← البحث ← الترقيم والعروض */}
      <div ref={panelRef} className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-lg font-bold text-[#1F1A13] truncate">{title}</h1>
          {toolbar}
          {allowedGear.length > 0 && (
            <div className="relative">
              <button type="button" className="p-2 rounded-lg hover:bg-[#F1EBDF] text-[#6E6557]" aria-label={tr('الإجراءات')} onClick={() => { setGearOpen(o => !o); setPanelOpen(false); }}>
                <Settings size={16} />
              </button>
              {gearOpen && (
                <div className="absolute z-30 mt-1 start-0 w-60 bg-white rounded-xl shadow-xl border border-[#E8E0D2] py-1">
                  {allowedGear.map(a => (
                    <button key={a.label} type="button" className="w-full text-start px-3 py-2 text-sm hover:bg-[#FBF7F0]" onClick={() => { setGearOpen(false); void a.run(); }}>{a.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="relative flex-1 min-w-[16rem]">
          <div className="flex items-center flex-wrap gap-1 border border-[#E8E0D2] rounded-xl bg-white px-2 py-1 focus-within:border-[#E15A30]">
            <Search size={15} className="text-[#9A8F7E] shrink-0" />
            {facets.map(f => (
              <span key={f.key} className="inline-flex items-center gap-1 rounded-md bg-[#F1EBDF] text-[#1F1A13] text-xs px-1.5 py-0.5">
                <span className="text-[#E15A30]">{f.icon}</span>{f.label}
                <button type="button" aria-label={tr('إزالة')} onClick={f.clear} className="hover:text-[#C0392B]"><X size={12} /></button>
              </span>
            ))}
            <input
              className="flex-1 min-w-[6rem] bg-transparent outline-none text-sm py-1"
              placeholder={tr('بحث')}
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') set({ search: searchText.trim() });
                if (e.key === 'Backspace' && searchText === '' && facets.length) facets[facets.length - 1].clear();
              }}
            />
            {(filters.length > 0 || groupBys.length > 0 || screen) && (
              <button type="button" aria-label={tr('خيارات البحث')} className="p-1 rounded hover:bg-[#F1EBDF]" onClick={() => { setPanelOpen(o => !o); setGearOpen(false); }}>
                <ChevronDown size={15} />
              </button>
            )}
          </div>
          {panelOpen && (
            <div className="absolute z-30 mt-1 inset-x-0 bg-white rounded-xl shadow-xl border border-[#E8E0D2] p-3 grid gap-4 sm:grid-cols-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-bold text-[#E15A30] mb-2"><Filter size={13} />{tr('الفلاتر')}</p>
                {filters.map((f, i) => (
                  <div key={f.key}>
                    {i > 0 && filters[i - 1].group !== f.group && <hr className="my-1 border-[#F1EBDF]" />}
                    <button type="button" className="w-full flex items-center gap-2 text-start text-sm px-2 py-1 rounded hover:bg-[#FBF7F0]" onClick={() => set({ filters: toggleIn(state.filters, f.key) })}>
                      <span className="w-4">{state.filters.includes(f.key) && <Check size={14} className="text-[#E15A30]" />}</span>{f.label}
                    </button>
                  </div>
                ))}
              </div>
              <div>
                <p className="flex items-center gap-1.5 text-xs font-bold text-[#E15A30] mb-2"><Layers size={13} />{tr('التجميع حسب')}</p>
                {groupBys.map(g => (
                  <button key={g.key} type="button" className="w-full flex items-center gap-2 text-start text-sm px-2 py-1 rounded hover:bg-[#FBF7F0]" onClick={() => set({ groupBy: state.groupBy[0] === g.key ? [] : [g.key] })}>
                    <span className="w-4">{state.groupBy.includes(g.key) && <Check size={14} className="text-[#E15A30]" />}</span>{g.label}
                  </button>
                ))}
              </div>
              {screen && (
                <div>
                  <p className="flex items-center gap-1.5 text-xs font-bold text-[#E15A30] mb-2"><Star size={13} />{tr('المفضلات')}</p>
                  {(favQ.data ?? []).map(f => (
                    <div key={f.id} className="flex items-center gap-1 group">
                      <button type="button" className="flex-1 flex items-center gap-2 text-start text-sm px-2 py-1 rounded hover:bg-[#FBF7F0]" onClick={() => applyFav(f.id, f.domainJson)}>
                        <span className="w-4">{state.favoriteId === f.id && <Check size={14} className="text-[#E15A30]" />}</span>{f.name}
                      </button>
                      {f.userId === user?.id && (
                        <button type="button" aria-label={tr('حذف')} className="p-1 opacity-0 group-hover:opacity-100 text-[#9A8F7E] hover:text-[#C0392B]" onClick={() => delFav.mutate(f.id)}><Trash2 size={13} /></button>
                      )}
                    </div>
                  ))}
                  <SaveFavorite onSave={name => saveFav.mutate(name)} busy={saveFav.isPending} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-sm text-[#6E6557]">
          <span className="tabular-nums whitespace-nowrap">{from}-{to} / {total}</span>
          <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF] disabled:opacity-40" disabled={total <= state.limit} onClick={prev} aria-label={tr('السابق')}>
            {dir === 'rtl' ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          </button>
          <button type="button" className="p-1.5 rounded-lg hover:bg-[#F1EBDF] disabled:opacity-40" disabled={total <= state.limit} onClick={next} aria-label={tr('التالي')}>
            {dir === 'rtl' ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
          {views && views.length > 1 && (
            <div className="flex rounded-lg border border-[#E8E0D2] overflow-hidden">
              {views.map(v => (
                <button key={v.key} type="button" onClick={() => onViewChange?.(v.key)}
                  className={`px-2.5 py-1 text-xs ${view === v.key ? 'bg-[#1F1A13] text-white' : 'bg-white hover:bg-[#FBF7F0]'}`}>{v.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* شريط الإجراءات الجماعية */}
      {selectable && selIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[#FBEBE2] px-3 py-2 text-sm">
          <span className="font-semibold text-[#1F1A13]">{tr('المحدد')}: <span className="tabular-nums">{selIds.length}</span></span>
          <button type="button" className="text-xs underline text-[#6E6557]" onClick={() => setSelected(new Set())}>{tr('إلغاء التحديد')}</button>
          <span className="flex-1" />
          {allowedBulk.map(a => {
            const reason = a.disabledReason?.(selIds) ?? null;
            return (
              <button key={a.label} type="button" disabled={!!reason} title={reason ?? undefined}
                className={`${a.danger ? 'btn-danger' : 'btn-secondary'} !py-1 !px-3 text-xs disabled:opacity-50`}
                onClick={() => { void Promise.resolve(a.run(selIds)).then(() => setSelected(new Set())); }}>
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="table-wrapper overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              {selectable && (
                <th className="w-8">
                  <input type="checkbox" checked={allChecked} aria-label={tr('تحديد الكل')}
                    onChange={() => setSelected(allChecked ? new Set() : new Set(ids))} />
                </th>
              )}
              {shownColumns.map(c => (
                <th key={c.key} className={c.align === 'end' ? 'text-end' : c.align === 'center' ? 'text-center' : 'text-start'}>{c.label}</th>
              ))}
              {optionalColumns.length > 0 && (
                <th className="w-8 relative">
                  <button type="button" aria-label={tr('الأعمدة الاختيارية')} className="p-1 rounded hover:bg-[#F1EBDF]" onClick={() => setColsOpen(o => !o)}>
                    <Settings size={13} />
                  </button>
                  {colsOpen && (
                    <div className="absolute z-30 end-0 mt-1 w-52 bg-white rounded-xl shadow-xl border border-[#E8E0D2] py-1 font-normal">
                      {optionalColumns.map(c => (
                        <label key={c.key} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-[#FBF7F0] cursor-pointer">
                          <input type="checkbox" checked={visibleOptional.has(c.key)}
                            onChange={() => setVisibleOptional(s => { const n = new Set(s); if (n.has(c.key)) n.delete(c.key); else n.add(c.key); return n; })} />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  )}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && (
              <tr><td colSpan={shownColumns.length + (selectable ? 1 : 0) + (optionalColumns.length ? 1 : 0)} className="text-center text-[#9A8F7E] py-10">{emptyText ?? tr('لا توجد بيانات')}</td></tr>
            )}
            {grouped
              ? grouped.map(([label, groupRows]) => (
                <GroupBlock key={label} label={label} count={groupRows.length} span={shownColumns.length + (selectable ? 1 : 0) + (optionalColumns.length ? 1 : 0)}
                  collapsed={collapsed.has(label)} onToggle={() => setCollapsed(s => { const n = new Set(s); if (n.has(label)) n.delete(label); else n.add(label); return n; })}>
                  {groupRows.map(renderRow)}
                </GroupBlock>
              ))
              : rows.map(renderRow)}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}

function GroupBlock({ label, count, span, collapsed, onToggle, children }: { label: string; count: number; span: number; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <>
      <tr className="bg-[#F7F2EA] cursor-pointer" onClick={onToggle}>
        <td colSpan={span} className="font-semibold text-[#1F1A13]">
          <span className="inline-flex items-center gap-1.5">
            <ChevronDown size={14} className={collapsed ? '-rotate-90 rtl:rotate-90' : ''} />
            {label} <span className="text-[#9A8F7E] font-normal tabular-nums">({count})</span>
          </span>
        </td>
      </tr>
      {!collapsed && children}
    </>
  );
}

function SaveFavorite({ onSave, busy }: { onSave: (name: string) => void; busy: boolean }) {
  const tr = useTr();
  const [name, setName] = useState('');
  return (
    <form className="mt-2 flex gap-1" onSubmit={e => { e.preventDefault(); if (name.trim()) { onSave(name.trim()); setName(''); } }}>
      <input className="input !py-1 text-sm flex-1" placeholder={tr('حفظ البحث مفضلة')} value={name} onChange={e => setName(e.target.value)} />
      <button type="submit" disabled={busy || !name.trim()} className="btn-primary !py-1 !px-2 text-xs disabled:opacity-50">{tr('حفظ')}</button>
    </form>
  );
}

export default LedgerListView;
