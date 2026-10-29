import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, ClipboardList } from 'lucide-react';
import toast from 'react-hot-toast';
import { locationsApi, vanStockApi } from '../api/client';
import { useTr } from '../i18n/strings';
import { formatDateTime, activeLocale } from '../utils/format';
import { shareOrDownloadExcel } from '../utils/excel';
import { localDay } from '../lib/paymentMethods';
import { loadByLabel, loadQty, loadsLogRows, locationFilterOptions, type SalesLocation, type VanLoadRow } from '../lib/locations';
import { factorOf, sumBase } from '../lib/units';

/** بند التحميل كما يردّه /van-stock/loads: الصفّ كاملاً، ومنه لقطة وحدته (unitName/unitFactor/baseQty) — الوحدات المتعددة */
type LogItem = VanLoadRow['items'][number] & { unitName?: string | null; unitFactor?: number | null; baseQty?: number | null };

/**
 * «سجل التحميلات» في مخزون السيارات — ميزة «لوكيشن» (طلب المالك ٢١ أكتوبر ٢٠٢٦: «يظهر الموقع كعمود وتصفية في
 * التحميلات»). لا سجلّ تحميلاتٍ مسطّح في الصفحة قبلها (الملخّص لكل مندوب وحركة مندوبٍ واحد بلا معرّفات)، فهذا جدولٌ
 * مرقَّم على GET /van-stock/loads بنوع LOAD وحده — «فقط الفواتير والتحميلات»: التنزيل والتسوية والإزالة ليست تحميلاً
 * ولا تُختم. والموقع ختم الحركة **وقت التحميل** لا موقع المندوب اليوم.
 * - يظهر حين يفعّل المالك الميزة وحدها (الصفحة تمرّره) — الشركة المطفأة لا ترى في صفحتها جديداً.
 * - الفترة «من–إلى» بأيام الشركة على لحظة التسجيل، اليوم افتراضاً، بلا خانة فارغة (دلالة الخادم: «من» الفارغة = يوم «إلى»).
 * - النطاق من الخادم (scopedRepRecordWhere)، وقائمة المناديب من ملخّص الصفحة المقيَّد أصلاً.
 */
const PAGE = 20;
/** التصدير يمرّ بالصفحات (حدّ الخادم ٢٠٠ للصفحة) حتى هذا السقف — ١٠ آلاف حركة تكفي أيّ فترةٍ معقولة */
const EXPORT_PAGE = 200;
const EXPORT_MAX_PAGES = 50;

const fmtQty = (n: number) => Number((Number.isFinite(n) ? n : 0).toFixed(2)).toLocaleString(activeLocale());

export default function VanLoadsLog({ reps }: { reps: { salesRepId: string; repName: string }[] }) {
  const tr = useTr();
  const [from, setFrom] = useState(() => localDay());
  const [to, setTo] = useState(() => localDay());
  const [repId, setRepId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const rangeBad = !!from && !!to && from > to;

  const locationsQ = useQuery({
    queryKey: ['locations'],
    queryFn: async () => (await locationsApi.list()).data.data as SalesLocation[],
  });

  const params = (): Record<string, string | number> => ({
    type: 'LOAD', from, to,
    ...(repId && { salesRepId: repId }),
    ...(locationId && { locationId }),
  });
  const logQ = useQuery({
    queryKey: ['van-loads-log', from, to, repId, locationId, page],
    queryFn: async () => (await vanStockApi.loadsLog({ ...params(), page, limit: PAGE })).data as { data: VanLoadRow[]; pagination: { total: number; pages: number } },
    enabled: !rangeBad,
  });
  const rows = logQ.data?.data ?? [];
  const pages = logQ.data?.pagination.pages ?? 1;
  const reset = () => setPage(1);

  const handleExport = async () => {
    setExporting(true);
    try {
      const all: VanLoadRow[] = [];
      for (let p = 1; p <= EXPORT_MAX_PAGES; p++) {
        const res = (await vanStockApi.loadsLog({ ...params(), page: p, limit: EXPORT_PAGE })).data as { data: VanLoadRow[]; pagination: { pages: number } };
        all.push(...res.data);
        if (p >= res.pagination.pages) break;
      }
      if (!all.length) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
      const out = await shareOrDownloadExcel(
        [{ name: tr('سجل التحميلات'), rows: loadsLogRows(all, tr, formatDateTime, true), colWidths: [20, 18, 18, 26, 10, 12, 12, 24] }],
        `${tr('سجل التحميلات')}-${from === to ? from : `${from}_${to}`}`,
      );
      toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
    } catch { toast.error(tr('تعذر التصدير')); }
    finally { setExporting(false); }
  };

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2 flex-wrap">
        <ClipboardList size={17} className="text-[#E15A30]" /> {tr('سجل التحميلات')}
        {logQ.data && <span className="text-xs font-normal text-[#6E6557]">· {logQ.data.pagination.total.toLocaleString(activeLocale())} {tr('تحميل')}</span>}
        <div className="flex-1" />
        <button className="btn-secondary text-xs py-1.5" onClick={handleExport} disabled={exporting || rangeBad}>
          {exporting ? <span className="w-4 h-4 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin" /> : <Download size={14} />}
          {tr('تصدير Excel')}
        </button>
      </div>

      <div className="px-5 py-3 flex gap-3 flex-wrap items-end border-b border-[#F1EBDF]">
        <div>
          <label className="label text-xs">{tr('من')}</label>
          <input type="date" className="input w-36" value={from} max={to || undefined} onChange={e => { setFrom(e.target.value || to || localDay()); reset(); }} />
        </div>
        <div>
          <label className="label text-xs">{tr('إلى')}</label>
          <input type="date" className="input w-36" value={to} min={from || undefined} onChange={e => { setTo(e.target.value || from || localDay()); reset(); }} />
        </div>
        <div>
          <label className="label text-xs">{tr('المندوب')}</label>
          <select className="input w-44" value={repId} onChange={e => { setRepId(e.target.value); reset(); }}>
            <option value="">{tr('كل المناديب')}</option>
            {reps.map(r => <option key={r.salesRepId} value={r.salesRepId}>{r.repName}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">{tr('الموقع')}</label>
          <select className="input w-44" value={locationId} onChange={e => { setLocationId(e.target.value); reset(); }}>
            {locationFilterOptions(locationsQ.data ?? [], tr).map(o => <option key={o.value || 'all'} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        {rangeBad && <p className="text-xs text-red-600 basis-full">{tr('تاريخ البداية بعد تاريخ النهاية')}</p>}
      </div>

      {rangeBad ? null : logQ.isPending ? (
        <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
      ) : logQ.isError ? (
        <div className="p-8 flex flex-col items-center gap-3 text-gray-500 text-sm">
          <span>{tr('تعذر تحميل السجل')}</span>
          <button onClick={() => logQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="p-8 text-center text-gray-400 text-sm">{tr('لا تحميلات في الفترة')}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                <th className="text-right font-semibold px-5 py-2.5">{tr('التاريخ')}</th>
                <th className="text-right font-semibold px-3 py-2.5">{tr('المندوب')}</th>
                <th className="text-right font-semibold px-3 py-2.5">{tr('الموقع')}</th>
                <th className="text-right font-semibold px-3 py-2.5">{tr('الأصناف')}</th>
                <th className="text-center font-semibold px-3 py-2.5">{tr('الكمية')}</th>
                <th className="text-center font-semibold px-3 py-2.5">{tr('بواسطة')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(l => (
                <tr key={l.id} className="border-t border-[#F1EBDF] align-top">
                  <td className="px-5 py-2.5 text-xs text-[#6E6557] whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                  <td className="px-3 py-2.5 font-semibold text-[#1F1A13] whitespace-nowrap">{l.salesRep?.name ?? '—'}</td>
                  {/* ختم الحركة وقت التحميل — null لمندوبٍ بلا موقع ولما قبل التفعيل */}
                  <td className="px-3 py-2.5 whitespace-nowrap">{l.location?.name ?? <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {/* لقطة وحدة البند (الوحدات المتعددة): «٢ كرتون» تبقى كرتوناً لا «٢ حبة» بعد تحويل الصنف */}
                      {(l.items as LogItem[]).map((it, j) => (
                        <span key={it.id ?? j} className="text-[11px] bg-[#FAF7F0] border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
                          {it.product?.name ?? '—'} <b>{fmtQty(Number(it.qty))}</b> {it.unitName || it.product?.unit || ''}
                        </span>
                      ))}
                    </div>
                    {l.note && <p className="text-[11px] text-[#9A8F7E] mt-1">{l.note}</p>}
                  </td>
                  {/* المجموع بالأساس (كملخّص المواقع في الخادم): كرتونٌ وثلاث حبّات = ٢٧ لا ٤ — وبلا وحداتٍ كما كان */}
                  <td className="text-center px-3 py-2.5 font-bold text-[#1E7A52] tabular-nums"
                    title={(l.items as LogItem[]).some(it => factorOf(it) !== 1) ? tr('مجموع بوحدات الأساس') : undefined}>
                    {fmtQty((l.items as LogItem[]).some(it => factorOf(it) !== 1) ? sumBase(l.items as LogItem[]) : loadQty(l))}
                  </td>
                  <td className="text-center px-3 py-2.5 text-xs text-[#6E6557]">{loadByLabel(l.createdBy, tr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!rangeBad && pages > 1 && (
        <div className="flex items-center justify-end gap-1 px-4 py-3 border-t border-[#F1EBDF]">
          <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            <ChevronRight size={16} />
          </button>
          <span className="text-sm text-gray-600 px-2">{page} / {pages}</span>
          <button className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
            <ChevronLeft size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
