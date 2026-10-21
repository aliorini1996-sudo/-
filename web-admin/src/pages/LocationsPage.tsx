import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ChevronDown, ChevronUp, Download, LocateFixed, Lock, MapPin, MapPinned, Pencil, Plus, Search, Trash2, Truck, Users, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { companyApi, locationsApi } from '../api/client';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import ConfirmDialog from '../components/ConfirmDialog';
import { LocationPicker, LocationsMap, type MapPin as Pin } from '../components/locations/LocationMap';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { backdropClose } from '../lib/backdropClose';
import { filterFlat } from '../lib/reportSearch';
import { localDay } from '../lib/paymentMethods';
import {
  LOCATION_NAME_MAX, assignOptions, bucketLabel, errorCode, fmtCoord, hasActivity, locationErrorMessage, locationFilterOptions,
  locationLabel, locationsAccess, locationsPageAllowed, mapsLink, parseLatLng, pointProblem, summaryBuckets, summarySheets,
  type LatLng, type LocBucket, type LocationRep, type LocationsSummaryData, type SalesLocation,
} from '../lib/locations';
import { formatCurrency, activeLocale } from '../utils/format';
import { shareOrDownloadExcel } from '../utils/excel';

/**
 * «لوكيشن» (طلب المالك ٢١ أكتوبر ٢٠٢٦) — ميزةٌ يفعّلها المالك لكل شركة: الشركة تعرّف مواقعها (فرعاً أو مستودعاً أو مدينة،
 * باسمٍ ونقطةٍ على الخريطة)، وتسند كلّ مندوبٍ لموقعٍ واحد، فتُختم كلّ فاتورةٍ وتحميلٍ بموقع مندوبهما **وقت الإصدار** —
 * نقلُ المندوب لاحقاً لا يحرّك مستنداته القديمة (الختم في الخادم: backend/src/services/locations.ts).
 *
 * ثلاثة أقسام بصلاحيات نظائرها على الخادم (lib/locations.ts → locationsAccess):
 *  - **الملخّص** (التقارير): لكل موقعٍ فواتير البيع والمرتجعات عدداً ومبلغاً، والتحميلات عدداً وكمية، في فترة «من–إلى»
 *    (اليوم افتراضاً، بأيام الشركة المحلية كصفحة «طرق الدفع»)، و«بلا موقع» سطرٌ لا يختفي — فمجموع الصفوف إجمالي الشركة.
 *  - **المواقع** (إعدادات الشركة، غير مقيَّد النطاق): إضافةٌ وتعديلٌ بمنتقي نقطةٍ على الخريطة، وأرشفةٌ وحذف.
 *  - **المناديب** (المناديب): موقعٌ واحد لكل مندوب.
 * البوّابات بترتيب «طرق الدفع»: المحاسبة (AccountingOffNotice) ثم عَلَم الشركة (لافتة) ثم الصلاحية — والخادم يفرض الكلّ
 * (٤٠٣)، والنطاق خادميٌّ بالكامل: لا تصفية نطاقٍ هنا.
 */

type Tab = 'summary' | 'locations' | 'reps';

// رفضٌ صريح من الخادم (٤٠٣ عَلَم/محاسبة، ٤٠٠ تاريخ) لا يتغيّر بالإعادة — الإعادة لانقطاع الشبكة و٥xx وحدهما
const retryNetOnly = (n: number, e: unknown) => {
  const status = (e as { response?: { status?: number } } | null)?.response?.status ?? 0;
  return !(status >= 400 && status < 500) && n < 2;
};

const fmtQty = (n: number) => Number((Number.isFinite(n) ? n : 0).toFixed(2)).toLocaleString(activeLocale());
const fmtCount = (n: number) => n.toLocaleString(activeLocale());

export default function LocationsPage() {
  const tr = useTr();
  const user = useAuthStore(s => s.user);
  const impersonating = useAuthStore(s => s.impersonating);
  const access = locationsAccess(user, !!impersonating);
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();
  // مفتاح ['company'] ودالّته كبقيّة اللوحة (MainLayout وAccountingGate) — كاشٌ واحد لا طلبٌ ثانٍ
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { locationsEnabled?: boolean } | null,
    staleTime: 300_000,
  });
  // مطفأة افتراضياً: لا تُفتح إلا بـtrue صريحة (غيابها من ردٍّ قديم = مطفأة)
  const featureOn = companyQ.data?.locationsEnabled === true;

  const locationsQ = useQuery({
    queryKey: ['locations'],
    queryFn: async () => (await locationsApi.list()).data.data as SalesLocation[],
    enabled: accountingReady && accountingOn && featureOn,
    retry: retryNetOnly,
  });

  const tabs: Tab[] = [...(access.summary ? ['summary' as const] : []), 'locations', ...(access.assign ? ['reps' as const] : [])];
  const [tabState, setTab] = useState<Tab>(access.summary ? 'summary' : 'locations');
  const tab = tabs.includes(tabState) ? tabState : tabs[0];

  // ─── البوّابات ───
  if (!accountingReady || companyQ.isLoading) return null;
  if (!accountingOn) return <AccountingOffNotice />;
  if (!featureOn || errorCode(locationsQ.error) === 'LOCATIONS_NOT_ALLOWED') {
    return (
      <div className="card max-w-xl mx-auto text-center py-10">
        <div className="w-12 h-12 rounded-2xl bg-[#F1EBDF] text-[#9A8F7E] flex items-center justify-center mx-auto mb-3">
          <Lock size={22} />
        </div>
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('صفحة لوكيشن غير مفعلة لشركتك')}</h1>
        <p className="text-sm text-gray-500 mt-1.5">{tr('تواصل مع مزود الخدمة لتفعيلها')}</p>
      </div>
    );
  }
  if (!locationsPageAllowed(user, !!impersonating)) {
    return (
      <div className="card max-w-xl">
        <h1 className="text-lg font-bold text-[#1F1A13]">{tr('غير مسموح')}</h1>
        <p className="text-sm text-gray-500 mt-1">{tr('لا تملك صلاحية الوصول لهذا القسم')}</p>
      </div>
    );
  }

  const locations = locationsQ.data ?? [];
  const TAB_META: Record<Tab, { label: string; icon: React.ElementType }> = {
    summary: { label: tr('الملخص'), icon: Truck },
    locations: { label: tr('المواقع'), icon: MapPinned },
    reps: { label: tr('المناديب'), icon: Users },
  };

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><MapPinned size={24} className="text-[#E15A30]" /> {tr('لوكيشن')}</h1>
          <p className="text-xs text-gray-400 mt-0.5">{tr('مواقع الشركة وإسناد المناديب وإجمالي الفواتير والتحميلات لكل موقع')}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        {tabs.map(t => {
          const M = TAB_META[t];
          return (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border transition-colors ${tab === t ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3] hover:bg-[#FAF7F0]'}`}>
              <M.icon size={15} /> {M.label}
            </button>
          );
        })}
      </div>

      {locationsQ.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : locationsQ.isError ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr('تعذر تحميل المواقع')}</span>
          <button onClick={() => locationsQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : tab === 'summary' ? (
        <SummaryTab />
      ) : tab === 'reps' ? (
        <RepsTab locations={locations} />
      ) : (
        <LocationsTab locations={locations} canManage={access.manage} />
      )}
    </div>
  );
}

// ═══ الملخّص ═══

function SummaryTab() {
  const tr = useTr();
  const [from, setFrom] = useState(() => localDay());
  const [to, setTo] = useState(() => localDay());
  const rangeBad = !!from && !!to && from > to;
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const q = useQuery({
    queryKey: ['locations-summary', from, to],
    queryFn: async () => (await locationsApi.summary({ from, to })).data.data as LocationsSummaryData,
    enabled: !rangeBad,
    retry: retryNetOnly,
  });
  const data = q.data;
  const range = data ? (data.range.from === data.range.to ? data.range.from : `${data.range.from} — ${data.range.to}`) : '';
  const buckets = useMemo(() => (data ? summaryBuckets(data) : []), [data]);
  const pins: Pin[] = useMemo(() => buckets
    .filter(b => b.locationId && b.lat != null && b.lng != null)
    .map(b => ({
      id: b.locationId!, name: bucketLabel(b, tr), lat: b.lat!, lng: b.lng!, muted: !hasActivity(b),
      lines: [
        `${tr('المبيعات')}: ${formatCurrency(b.sales.amount)} (${fmtCount(b.sales.count)})`,
        `${tr('المرتجعات')}: ${formatCurrency(b.returns.amount)} (${fmtCount(b.returns.count)})`,
        `${tr('صافي المبيعات')}: ${formatCurrency(b.net)}`,
        `${tr('التحميلات')}: ${fmtCount(b.loads.count)} · ${tr('الكمية')} ${fmtQty(b.loads.qty)}`,
      ],
    })), [buckets, tr]);

  const keyOf = (b: LocBucket) => b.locationId ?? 'none';
  const toggle = (k: string) => setOpen(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const handleExport = async () => {
    if (!data) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    // اسم الملف بالفترة المعروضة (من الخادم: أيام الشركة) لا بيوم التصدير
    const out = await shareOrDownloadExcel(summarySheets(data, tr), `${tr('لوكيشن')}-${range.replace(' — ', '_')}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">{tr('من')}</label>
            {/* لا خانة فارغة: الخادم يقرأ «من» الفارغة يومَ «إلى» وحده — فتُملأ بالطرف الآخر أو باليوم، والأرقام تطابق ما تراه */}
            <input type="date" className="input w-36" value={from} max={to || undefined} onChange={e => setFrom(e.target.value || to || localDay())} />
          </div>
          <div>
            <label className="label">{tr('إلى')}</label>
            <input type="date" className="input w-36" value={to} min={from || undefined} onChange={e => setTo(e.target.value || from || localDay())} />
          </div>
          <div className="flex-1" />
          <button className="btn-secondary" onClick={handleExport} disabled={!data}><Download size={16} /> {tr('تصدير Excel')}</button>
        </div>
        {/* الفترة التي حُسبت بها الأرقام فعلاً (من ردّ الخادم) — لا يُقرأ يومٌ واحد مجموعاً لفترة */}
        {range && <p className="text-xs text-[#6E6557] mt-2">{tr('الفترة')}: <bdi dir="ltr">{range}</bdi></p>}
        {rangeBad && <p className="text-xs text-red-600 mt-2">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}
      </div>

      {rangeBad ? null : q.isPending ? (
        <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
      ) : q.isError || !data ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
          <span>{tr('تعذر تحميل التقرير')}</span>
          <button onClick={() => q.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : (
        <>
          {/* بطاقات إجمالي الفترة (كل المواقع ومعها «بلا موقع») */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('المبيعات')}</p>
              <p className="text-xl font-bold text-green-600 tabular-nums">{formatCurrency(data.totals.sales.amount)}</p>
              <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{fmtCount(data.totals.sales.count)} {tr('فاتورة')}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('المرتجعات')}</p>
              <p className="text-xl font-bold text-[#C94E28] tabular-nums">{formatCurrency(data.totals.returns.amount)}</p>
              <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{fmtCount(data.totals.returns.count)} {tr('مرتجع')}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('صافي المبيعات')}</p>
              <p className="text-xl font-bold text-[#1F1A13] tabular-nums">{formatCurrency(data.totals.net)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('التحميلات')}</p>
              <p className="text-xl font-bold text-[#1E7A52] tabular-nums">{fmtCount(data.totals.loads.count)}</p>
              <p className="text-[11px] text-gray-400 mt-0.5 tabular-nums">{tr('الكمية')} {fmtQty(data.totals.loads.qty)}</p>
            </div>
          </div>

          {pins.length > 0 && <LocationsMap pins={pins} height={300} />}

          <div className="card p-0">
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('الموقع')}</th>
                    <th>{tr('عدد فواتير البيع')}</th>
                    <th>{tr('مبلغ المبيعات')}</th>
                    <th>{tr('عدد المرتجعات')}</th>
                    <th>{tr('مبلغ المرتجعات')}</th>
                    <th>{tr('صافي المبيعات')}</th>
                    <th>{tr('عدد التحميلات')}</th>
                    <th>{tr('كمية التحميل')}</th>
                  </tr>
                </thead>
                <tbody>
                  {buckets.map(b => {
                    const k = keyOf(b);
                    const active = hasActivity(b);
                    const expandable = b.loads.products.length > 0;
                    const isOpen = open.has(k);
                    const dim = active ? '' : 'text-gray-300';
                    return [
                      <tr key={k} className={b.locationId ? '' : 'bg-[#FAF7F0]/70'}>
                        <td className={`font-medium ${b.locationId ? 'text-gray-800' : 'text-[#6E6557]'}`}>
                          <span className="inline-flex items-center gap-1.5">
                            <MapPin size={13} className={b.locationId ? 'text-[#E15A30]' : 'text-[#9A8F7E]'} />
                            {bucketLabel(b, tr)}
                          </span>
                          {expandable && (
                            <button type="button" onClick={() => toggle(k)}
                              className="ms-2 text-[11px] font-semibold text-[#E15A30] inline-flex items-center gap-0.5">
                              {tr('الأصناف')} {isOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                          )}
                        </td>
                        <td className={`tabular-nums ${dim}`}>{fmtCount(b.sales.count)}</td>
                        <td className={`tabular-nums ${active ? 'font-semibold text-green-700' : dim}`}>{formatCurrency(b.sales.amount)}</td>
                        <td className={`tabular-nums ${dim}`}>{fmtCount(b.returns.count)}</td>
                        <td className={`tabular-nums ${active && b.returns.count ? 'text-[#C94E28]' : dim}`}>{formatCurrency(b.returns.amount)}</td>
                        <td className={`tabular-nums ${active ? 'font-bold text-[#1F1A13]' : dim}`}>{formatCurrency(b.net)}</td>
                        <td className={`tabular-nums ${dim}`}>{fmtCount(b.loads.count)}</td>
                        <td className={`tabular-nums ${active && b.loads.count ? 'text-[#1E7A52] font-semibold' : dim}`}>{fmtQty(b.loads.qty)}</td>
                      </tr>,
                      isOpen && expandable ? (
                        <tr key={`${k}-products`} className="bg-[#FAF7F0]/50">
                          <td colSpan={8}>
                            <div className="flex flex-wrap gap-1.5">
                              {b.loads.products.map(p => (
                                <span key={p.productId} className="text-[11px] bg-white border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
                                  {p.name || '—'} <b>{fmtQty(p.qty)}</b> {p.unit ?? ''}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-bold border-t-2 border-[#E9E1D3] bg-[#FAF7F0]">
                    <td className="text-[#1F1A13]">{tr('الإجمالي')}</td>
                    <td className="tabular-nums">{fmtCount(data.totals.sales.count)}</td>
                    <td className="tabular-nums text-green-700">{formatCurrency(data.totals.sales.amount)}</td>
                    <td className="tabular-nums">{fmtCount(data.totals.returns.count)}</td>
                    <td className="tabular-nums text-[#C94E28]">{formatCurrency(data.totals.returns.amount)}</td>
                    <td className="tabular-nums text-[#1F1A13]">{formatCurrency(data.totals.net)}</td>
                    <td className="tabular-nums">{fmtCount(data.totals.loads.count)}</td>
                    <td className="tabular-nums text-[#1E7A52]">{fmtQty(data.totals.loads.qty)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {/* معنى الأرقام: الختم وقت الإصدار، والتحميل بالكمية (لا كلفة مخزّنة لكل تحميل — لا رقمَ مختلَق) */}
            <div className="px-5 py-2.5 border-t border-[#F1EBDF] text-[11px] text-[#9A8F7E] space-y-0.5">
              <p>{tr('كل فاتورة وتحميل محسوب على موقع مندوبه وقت الإصدار — نقل المندوب لا يغير مستنداته القديمة')}</p>
              <p>{tr('الفواتير المعتمدة بتاريخ الفاتورة، والتحميلات بلحظة تسجيلها وبالكمية')}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══ المواقع ═══

function LocationsTab({ locations, canManage }: { locations: SalesLocation[]; canManage: boolean }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<SalesLocation | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SalesLocation | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['locations'] });
    qc.invalidateQueries({ queryKey: ['locations-summary'] });
  };
  const archive = useMutation({
    mutationFn: (v: { id: string; isActive: boolean }) => locationsApi.update(v.id, { isActive: v.isActive }),
    onSuccess: (_d, v) => { toast.success(v.isActive ? tr('تمت استعادة الموقع') : tr('تمت أرشفة الموقع')); refresh(); },
    onError: (e: unknown) => toast.error(locationErrorMessage(e, tr, tr('تعذر الحفظ'))),
  });
  const remove = useMutation({
    mutationFn: (id: string) => locationsApi.remove(id),
    onSuccess: () => { toast.success(tr('تم حذف الموقع')); refresh(); setDeleting(null); },
    onError: (e: unknown) => { toast.error(locationErrorMessage(e, tr, tr('تعذر الحذف'))); setDeleting(null); },
  });

  const pins: Pin[] = locations
    .filter(l => l.lat != null && l.lng != null)
    .map(l => ({
      id: l.id, name: locationLabel(l, tr), lat: l.lat!, lng: l.lng!, muted: !l.isActive,
      lines: [`${tr('المناديب')}: ${fmtCount(l.repsCount ?? 0)}`],
    }));

  return (
    <div className="space-y-4">
      <div className="card p-0">
        <div className="px-5 py-3 border-b border-[#F1EBDF] flex items-center gap-3 flex-wrap">
          <b className="text-[#1F1A13] text-sm">{tr('مواقع الشركة')}</b>
          <span className="text-[#9A8F7E]">•</span>
          <span className="text-sm text-[#6E6557]">{fmtCount(locations.length)}</span>
          <div className="flex-1" />
          {canManage && (
            <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={16} /> {tr('إضافة موقع')}</button>
          )}
        </div>
        {!canManage && (
          <p className="px-5 pt-2.5 text-[11px] text-[#9A8F7E]">{tr('تعريف المواقع وتعديلها لمن يملك صلاحية إعدادات الشركة غير المقيدة')}</p>
        )}
        {locations.length === 0 ? (
          <div className="text-center text-gray-400 text-sm py-10">
            {tr('لا مواقع بعد — أضف فرعا أو مستودعا أو مدينة بنقطتها على الخريطة')}
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr('اسم الموقع')}</th>
                  <th>{tr('الموقع على الخريطة')}</th>
                  <th>{tr('المناديب')}</th>
                  <th>{tr('الحالة')}</th>
                  {canManage && <th>{tr('إجراءات')}</th>}
                </tr>
              </thead>
              <tbody>
                {locations.map(l => (
                  <tr key={l.id}>
                    <td className={`font-medium ${l.isActive ? 'text-gray-800' : 'text-gray-400'}`}>
                      <span className="inline-flex items-center gap-1.5"><MapPin size={13} className={l.isActive ? 'text-[#E15A30]' : 'text-[#9A8F7E]'} /> {l.name}</span>
                    </td>
                    <td className="text-xs">
                      {l.lat != null && l.lng != null ? (
                        <a href={mapsLink(l.lat, l.lng)} target="_blank" rel="noreferrer" className="text-[#E15A30] hover:underline font-mono" dir="ltr">
                          {fmtCoord(l.lat)}, {fmtCoord(l.lng)}
                        </a>
                      ) : <span className="text-gray-300">{tr('بلا نقطة')}</span>}
                    </td>
                    <td className="tabular-nums">{fmtCount(l.repsCount ?? 0)}</td>
                    <td>
                      {l.isActive
                        ? <span className="badge-confirmed">{tr('نشط')}</span>
                        : <span className="badge-inactive">{tr('مؤرشف')}</span>}
                    </td>
                    {canManage && (
                      <td>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => setEditing(l)} className="p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]" title={tr('تعديل')}><Pencil size={14} /></button>
                          <button onClick={() => archive.mutate({ id: l.id, isActive: !l.isActive })} disabled={archive.isPending}
                            className="p-1.5 hover:bg-[#F1EBDF] rounded text-[#6E6557] disabled:opacity-50" title={l.isActive ? tr('أرشفة') : tr('استعادة')}>
                            {l.isActive ? <Archive size={14} /> : <ArchiveRestore size={14} />}
                          </button>
                          <button onClick={() => setDeleting(l)} className="p-1.5 hover:bg-red-50 rounded text-red-500" title={tr('حذف')}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pins.length > 0 && <LocationsMap pins={pins} height={320} />}

      {editing && <LocationModal loc={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
      {deleting && (
        <ConfirmDialog
          title={tr('حذف الموقع')}
          message={`${deleting.name} — ${tr('يحذف الموقع نهائيا إن لم يكن عليه مناديب ولا فواتير ولا تحميلات، وإلا فأرشفه ليبقى في التقارير')}`}
          confirmLabel={tr('حذف')}
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** نافذة الموقع: الاسم (إلزاميّ) ونقطةٌ على الخريطة (اختيارية — نقرٌ أو سحبٌ أو لصقٌ أو «موقعي الحالي») */
function LocationModal({ loc, onClose, onSaved }: { loc: SalesLocation | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTr();
  const [name, setName] = useState(loc?.name ?? '');
  const [point, setPoint] = useState<LatLng | null>(loc && loc.lat != null && loc.lng != null ? { lat: loc.lat, lng: loc.lng } : null);
  const [paste, setPaste] = useState('');
  const [locating, setLocating] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), lat: point?.lat ?? null, lng: point?.lng ?? null };
      return loc ? locationsApi.update(loc.id, body) : locationsApi.create(body);
    },
    onSuccess: () => { toast.success(loc ? tr('تم تحديث الموقع') : tr('تمت إضافة الموقع')); onSaved(); },
    onError: (e: unknown) => toast.error(locationErrorMessage(e, tr, tr('تعذر الحفظ'))),
  });

  const applyPaste = () => {
    const p = parseLatLng(paste);
    if (!p) { toast.error(tr('لم نجد إحداثيات في النص — الصق رابطا فيه الإحداثيات أو انقر على الخريطة')); return; }
    setPoint(p);
    setPaste('');
  };
  const locateMe = () => {
    if (!navigator.geolocation) { toast.error(tr('تعذر تحديد موقعك الحالي')); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      pos => { setPoint({ lat: Math.round(pos.coords.latitude * 1e6) / 1e6, lng: Math.round(pos.coords.longitude * 1e6) / 1e6 }); setLocating(false); },
      () => { toast.error(tr('تعذر تحديد موقعك الحالي')); setLocating(false); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };

  const problem = point ? pointProblem(point.lat, point.lng) : null;
  const valid = name.trim().length > 0 && !problem;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><MapPinned size={20} className="text-[#E15A30]" /> {loc ? tr('تعديل الموقع') : tr('إضافة موقع')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="label">{tr('اسم الموقع')} *</label>
            <input className="input" value={name} maxLength={LOCATION_NAME_MAX} autoFocus
              placeholder={tr('مثل فرع الرياض أو مستودع جدة أو الدمام')} onChange={e => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <label className="label mb-0">{tr('الموقع على الخريطة')}</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={locateMe} disabled={locating} className="btn-secondary text-xs py-1.5">
                  <LocateFixed size={14} /> {locating ? tr('جار تحديد موقعك') : tr('موقعي الحالي')}
                </button>
                {point && (
                  <button type="button" onClick={() => setPoint(null)} className="btn-secondary text-xs py-1.5"><X size={14} /> {tr('مسح النقطة')}</button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-[#9A8F7E]">{tr('انقر على الخريطة لتحديد الموقع أو اسحب الدبوس لتدقيقه — النقطة اختيارية')}</p>
            <LocationPicker value={point} onChange={setPoint} height={320} />
            <div className="flex gap-2">
              <input className="input flex-1 text-sm" dir="auto" value={paste} onChange={e => setPaste(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); applyPaste(); } }}
                placeholder={tr('أو الصق إحداثيات أو رابط خرائط Google')} />
              <button type="button" onClick={applyPaste} disabled={!paste.trim()} className="btn-secondary">{tr('تحديد')}</button>
            </div>
            <p className="text-xs text-[#6E6557]">
              {point
                ? <><MapPin size={12} className="inline text-[#E15A30]" /> <bdi dir="ltr" className="font-mono">{fmtCoord(point.lat)}, {fmtCoord(point.lng)}</bdi></>
                : tr('لم تحدد نقطة بعد')}
            </p>
            {problem && <p className="text-xs text-red-600">{tr(problem)}</p>}
          </div>
        </div>
        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button className="btn-primary flex-1 justify-center" onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {save.isPending ? tr('جار الحفظ') : tr('حفظ')}
          </button>
          <button className="btn-secondary" onClick={onClose}>{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

// ═══ المناديب ═══

function RepsTab({ locations }: { locations: SalesLocation[] }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [locFilter, setLocFilter] = useState('');
  const repsQ = useQuery({
    queryKey: ['locations-reps'],
    queryFn: async () => (await locationsApi.reps()).data.data as LocationRep[],
    retry: retryNetOnly,
  });

  // تحديثٌ متفائل: الخانة تتبع الاختيار فوراً، ويُرجَع الصفّ إن رفضه الخادم (موقعٌ أُرشف للتوّ مثلاً)
  const assign = useMutation({
    mutationFn: (v: { id: string; locationId: string | null }) => locationsApi.assignRep(v.id, v.locationId),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['locations-reps'] });
      const prev = qc.getQueryData<LocationRep[]>(['locations-reps']);
      qc.setQueryData<LocationRep[]>(['locations-reps'], old => (old ?? []).map(r => (r.id === v.id ? { ...r, locationId: v.locationId } : r)));
      return { prev };
    },
    onError: (e: unknown, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['locations-reps'], ctx.prev);
      toast.error(locationErrorMessage(e, tr, tr('تعذر الحفظ')));
    },
    onSuccess: () => toast.success(tr('تم حفظ موقع المندوب')),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['locations-reps'] });
      qc.invalidateQueries({ queryKey: ['locations'] }); // عدد مناديب كل موقع
    },
  });

  const reps = useMemo(() => {
    const byLoc = (repsQ.data ?? []).filter(r => !locFilter || (locFilter === 'none' ? !r.locationId : r.locationId === locFilter));
    return filterFlat(byLoc, search, r => [r.name]);
  }, [repsQ.data, locFilter, search]);
  const filterOpts = locationFilterOptions(locations, tr);

  return (
    <div className="card p-0">
      <div className="px-5 py-3 border-b border-[#F1EBDF] flex items-end gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className="label">{tr('بحث')}</label>
          <div className="relative">
            <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-gray-400 pointer-events-none" />
            <input className="input ps-9 w-full" value={search} onChange={e => setSearch(e.target.value)} placeholder={tr('اسم المندوب')} />
          </div>
        </div>
        <div>
          <label className="label">{tr('الموقع')}</label>
          <select className="input w-48" value={locFilter} onChange={e => setLocFilter(e.target.value)}>
            {filterOpts.map(o => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <p className="px-5 pt-2.5 text-[11px] text-[#9A8F7E]">{tr('كل مندوب في موقع واحد. النقل يسري على ما يصدره بعده — الفواتير والتحميلات القديمة تبقى على موقعها وقت الإصدار')}</p>

      {repsQ.isPending ? (
        <div className="text-center text-gray-400 text-sm py-8">{tr('جاري التحميل')}</div>
      ) : repsQ.isError ? (
        <div className="flex flex-col items-center gap-3 py-8 text-gray-500">
          <span>{tr('تعذر تحميل المناديب')}</span>
          <button onClick={() => repsQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : reps.length === 0 ? (
        <div className="text-center text-gray-400 text-sm py-8">{search || locFilter ? tr('لا نتائج مطابقة للبحث') : tr('لا مناديب في نطاقك')}</div>
      ) : (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>{tr('المندوب')}</th>
                <th>{tr('الموقع')}</th>
              </tr>
            </thead>
            <tbody>
              {reps.map(r => (
                <tr key={r.id}>
                  <td className={`font-medium ${r.isActive ? 'text-gray-800' : 'text-gray-400'}`}>
                    {r.name}{!r.isActive && <span className="text-[10px] text-red-500 ms-2">{tr('موقوف')}</span>}
                  </td>
                  <td>
                    <select className="input w-56" value={r.locationId ?? ''} disabled={assign.isPending && assign.variables?.id === r.id}
                      onChange={e => assign.mutate({ id: r.id, locationId: e.target.value || null })}>
                      {assignOptions(locations, r.locationId, tr).map(o => (
                        <option key={o.value || 'none'} value={o.value} disabled={o.disabled}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
