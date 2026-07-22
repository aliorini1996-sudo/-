import { useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportApi } from '../api/client';
import { formatCurrency } from '../utils/format';
import { useTr } from '../i18n/strings';
import { channelLabel } from '../lib/channels';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Download, TrendingUp, Users, UserCheck, MapPin } from 'lucide-react';
import { shareOrDownloadExcel, num } from '../utils/excel';
import toast from 'react-hot-toast';

type Tab = 'sales' | 'collections' | 'balances' | 'performance';

interface WorkHoursRow { id: string; name: string; totalMinutes: number; hours: number; minutes: number; sessions: number; firstSeen: string | null; lastSeen: string | null }
interface VisitLoc { customerName: string; createdAt: string; lat: number; lng: number; mapsUrl: string }
interface PerfRow {
  id: string; name: string; invoicesCount: number; salesTotal: number; collectionsTotal: number; collectionRate: number; avgInvoice: number;
  workMinutes: number; workHours: number; workMins: number; visitsCount: number; visits: VisitLoc[];
}

export default function ReportsPage() {
  const tr = useTr();
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState('rep');
  // نوع تقرير المناديب: أداء | ساعات العمل
  const [perfType, setPerfType] = useState<'performance' | 'hours'>('performance');

  const methodLabel = (m: string) => m === 'CASH' ? tr('نقدي') : m === 'BANK_TRANSFER' ? tr('تحويل بنكي') : m === 'POS' ? tr('شبكة') : tr('شيك');

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'sales', label: tr('تقارير المبيعات'), icon: TrendingUp },
    { id: 'collections', label: tr('تقارير التحصيل'), icon: Download },
    { id: 'balances', label: tr('أرصدة العملاء'), icon: Users },
    { id: 'performance', label: tr('أداء المناديب'), icon: UserCheck },
  ];

  const { data: salesData, isLoading: salesLoading } = useQuery({
    queryKey: ['report-sales', from, to, groupBy],
    queryFn: async () => {
      const res = await reportApi.sales({ from, to, groupBy });
      return res.data.data;
    },
    enabled: tab === 'sales',
  });

  const { data: collectData } = useQuery({
    queryKey: ['report-collections', from, to],
    queryFn: async () => {
      const res = await reportApi.collections({ from, to });
      return res.data.data as { receipts: unknown[]; summary: { total: number; count: number; byMethod: Record<string, number> } };
    },
    enabled: tab === 'collections',
  });

  const { data: balancesData } = useQuery({
    queryKey: ['report-balances'],
    queryFn: async () => {
      const res = await reportApi.balances({ type: 'overdue' });
      return res.data.data as { id: string; name: string; phone: string; balance: number; creditLimit: number }[];
    },
    enabled: tab === 'balances',
  });

  const [expandedPerf, setExpandedPerf] = useState<string | null>(null); // صفّ مواقع الزيارات المفتوح
  const { data: perfData } = useQuery({
    queryKey: ['report-performance', from, to],
    queryFn: async () => {
      const res = await reportApi.repPerformance({ from, to });
      return res.data.data as PerfRow[];
    },
    enabled: tab === 'performance' && perfType === 'performance',
  });

  const { data: hoursData, isLoading: hoursLoading } = useQuery({
    queryKey: ['report-work-hours', from, to],
    queryFn: async () => {
      const res = await reportApi.workHours({ from, to });
      return res.data.data as WorkHoursRow[];
    },
    enabled: tab === 'performance' && perfType === 'hours',
  });

  // صيغة عرض المدة: «Xس Yد»
  const fmtDuration = (h: number, m: number) => `${h} ${tr('س')} ${m} ${tr('د')}`;
  const fmtDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString('ar', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  const groupLabel = () => groupBy === 'rep' ? tr('المندوب') : groupBy === 'customer' ? tr('العميل')
    : groupBy === 'channel' ? tr('القناة') : groupBy === 'region' ? tr('المنطقة') : tr('الصنف');
  // اسم العرض: أكواد القنوات تُترجَم؛ البقية كما هي
  const displayName = (name: string) => groupBy === 'channel' ? (name === 'UNSET' ? tr('غير محدّد') : tr(channelLabel(name))) : name;

  // تصدير/مشاركة بيانات التبويب النشط إلى Excel
  const handleExport = async () => {
    let sheets: { name: string; rows: Record<string, unknown>[]; colWidths?: number[] }[] | null = null;
    let fname = tr('تقرير');
    if (tab === 'performance' && perfType === 'hours' && hoursData?.length) {
      sheets = [{ name: tr('ساعات العمل'), rows: hoursData.map(r => ({
        [tr('المندوب')]: r.name, [tr('ساعات العمل')]: fmtDuration(r.hours, r.minutes),
        [tr('إجمالي الدقائق')]: r.totalMinutes, [tr('عدد الجلسات')]: r.sessions,
        [tr('أول ظهور')]: fmtDateTime(r.firstSeen), [tr('آخر ظهور')]: fmtDateTime(r.lastSeen),
      })), colWidths: [22, 14, 14, 12, 18, 18] }];
      fname = tr('ساعات العمل');
    } else if (tab === 'performance' && perfData?.length) {
      sheets = [{ name: tr('أداء المناديب'), rows: perfData.map(r => ({
        [tr('المندوب')]: r.name, [tr('عدد الفواتير')]: r.invoicesCount, [tr('إجمالي المبيعات')]: num(r.salesTotal),
        [tr('التحصيل')]: num(r.collectionsTotal), [tr('نسبة التحصيل %')]: r.collectionRate, [tr('متوسط الفاتورة')]: num(r.avgInvoice),
        [tr('ساعات العمل')]: fmtDuration(r.workHours, r.workMins), [tr('عدد الزيارات')]: r.visitsCount,
        [tr('روابط مواقع الزيارات')]: r.visits.map(v => v.mapsUrl).join('\n'),
      })), colWidths: [22, 12, 16, 14, 14, 16, 14, 12, 55] }];
      // ورقة مواقع الزيارات (روابط خرائط Google)
      const locRows = perfData.flatMap(r => r.visits.map(v => ({
        [tr('المندوب')]: r.name, [tr('العميل')]: v.customerName, [tr('الوقت')]: fmtDateTime(v.createdAt), [tr('رابط الموقع')]: v.mapsUrl,
      })));
      if (locRows.length) sheets.push({ name: tr('مواقع الزيارات'), rows: locRows, colWidths: [22, 22, 18, 40] });
      fname = tr('أداء المناديب');
    } else if (tab === 'sales' && Array.isArray(salesData) && salesData.length) {
      sheets = [{ name: tr('المبيعات'), rows: (salesData as { name: string; total: number; count?: number; qty?: number }[]).map(r => ({
        [tr('الاسم')]: r.name, [tr('العدد/الكمية')]: r.count ?? r.qty ?? '', [tr('الإجمالي')]: num(r.total),
      })), colWidths: [28, 14, 16] }];
      fname = tr('تقارير المبيعات');
    } else if (tab === 'balances' && balancesData?.length) {
      sheets = [{ name: tr('أرصدة العملاء'), rows: balancesData.map(c => ({
        [tr('العميل')]: c.name, [tr('الجوال')]: c.phone, [tr('الرصيد')]: num(c.balance), [tr('الحد الائتماني')]: num(c.creditLimit),
      })), colWidths: [24, 16, 14, 16] }];
      fname = tr('أرصدة العملاء');
    } else if (tab === 'collections' && collectData) {
      sheets = [{ name: tr('التحصيل'), rows: [
        { [tr('البند')]: tr('إجمالي التحصيل'), [tr('القيمة')]: num(collectData.summary.total) },
        { [tr('البند')]: tr('عدد السندات'), [tr('القيمة')]: collectData.summary.count },
        ...Object.entries(collectData.summary.byMethod).map(([m, v]) => ({ [tr('البند')]: methodLabel(m), [tr('القيمة')]: num(v) })),
      ], colWidths: [20, 16] }];
      fname = tr('تقارير التحصيل');
    }
    if (!sheets) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    const out = await shareOrDownloadExcel(sheets, `${fname}-${new Date().toISOString().slice(0, 10)}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };

  // تصدير تقرير مندوب واحد بشكل مستقل (اسم الملف باسم المندوب)
  const day = () => new Date().toISOString().slice(0, 10);
  const safeName = (s: string) => s.replace(/[\\/?*[\]:]/g, '·').slice(0, 60);
  const exportRepPerf = async (r: PerfRow) => {
    const rows = [{
      [tr('المندوب')]: r.name, [tr('عدد الفواتير')]: r.invoicesCount, [tr('إجمالي المبيعات')]: num(r.salesTotal),
      [tr('التحصيل')]: num(r.collectionsTotal), [tr('نسبة التحصيل %')]: r.collectionRate, [tr('متوسط الفاتورة')]: num(r.avgInvoice),
      [tr('ساعات العمل')]: fmtDuration(r.workHours, r.workMins), [tr('عدد الزيارات')]: r.visitsCount,
      [tr('روابط مواقع الزيارات')]: r.visits.map(v => v.mapsUrl).join('\n'),
    }];
    const sheets = [{ name: tr('أداء المندوب'), rows, colWidths: [22, 12, 16, 14, 14, 16, 14, 12, 55] }];
    if (r.visits.length) sheets.push({
      name: tr('مواقع الزيارات'),
      rows: r.visits.map(v => ({ [tr('العميل')]: v.customerName, [tr('الوقت')]: fmtDateTime(v.createdAt), [tr('رابط الموقع')]: v.mapsUrl })),
      colWidths: [22, 18, 40],
    });
    const out = await shareOrDownloadExcel(sheets, `${tr('أداء')}-${safeName(r.name)}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepHours = async (r: WorkHoursRow) => {
    const rows = [{
      [tr('المندوب')]: r.name, [tr('ساعات العمل')]: fmtDuration(r.hours, r.minutes),
      [tr('إجمالي الدقائق')]: r.totalMinutes, [tr('عدد الجلسات')]: r.sessions,
      [tr('أول ظهور')]: fmtDateTime(r.firstSeen), [tr('آخر ظهور')]: fmtDateTime(r.lastSeen),
    }];
    const out = await shareOrDownloadExcel([{ name: tr('ساعات العمل'), rows, colWidths: [22, 14, 14, 12, 18, 18] }], `${tr('ساعات العمل')}-${safeName(r.name)}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('التقارير')}</h1>
        <button className="btn-secondary" onClick={handleExport}><Download size={16} /> {tr('تصدير Excel')}</button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-white rounded-xl p-1 border border-gray-100 w-fit">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-[#E15A30] text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">{tr('من')}</label>
            <input type="date" className="input w-36" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">{tr('إلى')}</label>
            <input type="date" className="input w-36" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          {tab === 'sales' && (
            <div>
              <label className="label">{tr('تجميع حسب')}</label>
              <select className="input w-36" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                <option value="rep">{tr('المندوب')}</option>
                <option value="customer">{tr('العميل')}</option>
                <option value="product">{tr('الصنف')}</option>
                <option value="channel">{tr('القناة')}</option>
                <option value="region">{tr('المنطقة')}</option>
              </select>
            </div>
          )}
          {tab === 'performance' && (
            <div>
              <label className="label">{tr('نوع التقرير')}</label>
              <select className="input w-44" value={perfType} onChange={e => setPerfType(e.target.value as 'performance' | 'hours')}>
                <option value="performance">{tr('أداء المندوب')}</option>
                <option value="hours">{tr('ساعات العمل')}</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Sales Report */}
      {tab === 'sales' && (
        <div className="space-y-4">
          {salesLoading ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل...')}</div>
          ) : Array.isArray(salesData) && salesData.length > 0 ? (
            <>
              <div className="card">
                <h3 className="font-semibold text-gray-700 mb-4">{tr('مبيعات حسب')} {groupLabel()}</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={(salesData as { name: string; total: number; count?: number }[]).slice(0, 10).map(r => ({ ...r, name: displayName(r.name) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    <Bar dataKey="total" fill="#3b82f6" radius={[4, 4, 0, 0]} name={tr('المبيعات')} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card p-0">
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{groupLabel()}</th>
                        <th>{groupBy === 'product' ? tr('الكمية') : tr('عدد الفواتير')}</th>
                        <th>{tr('إجمالي المبيعات')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(salesData as { name: string; total: number; count?: number; qty?: number; code?: string }[]).map((row, i) => (
                        <tr key={i}>
                          <td className="font-medium text-gray-800">{displayName(row.name)}</td>
                          <td className="text-gray-600">{row.count ?? row.qty ?? '-'}</td>
                          <td className="font-semibold text-[#E15A30]">{formatCurrency(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="card text-center text-gray-400 py-12">{tr('لا توجد بيانات')}</div>
          )}
        </div>
      )}

      {/* Collections Report */}
      {tab === 'collections' && collectData && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('إجمالي التحصيل')}</p>
              <p className="text-xl font-bold text-green-600">{formatCurrency(collectData.summary.total)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('عدد السندات')}</p>
              <p className="text-xl font-bold text-gray-700">{collectData.summary.count}</p>
            </div>
            {Object.entries(collectData.summary.byMethod).map(([m, v]) => (
              <div key={m} className="card text-center">
                <p className="text-xs text-gray-500">{m === 'CASH' ? tr('نقدي') : m === 'BANK_TRANSFER' ? tr('تحويل') : m === 'POS' ? tr('شبكة') : tr('شيك')}</p>
                <p className="text-lg font-bold text-gray-700">{formatCurrency(v)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Balances Report */}
      {tab === 'balances' && balancesData && (
        <div className="card p-0">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr><th>{tr('العميل')}</th><th>{tr('الجوال')}</th><th>{tr('الرصيد')}</th><th>{tr('الحد الائتماني')}</th><th>{tr('نسبة الاستخدام')}</th></tr>
              </thead>
              <tbody>
                {balancesData.map(c => (
                  <tr key={c.id}>
                    <td className="font-medium text-gray-800">{c.name}</td>
                    <td className="font-mono text-sm text-gray-500">{c.phone}</td>
                    <td className={`font-semibold ${Number(c.balance) > Number(c.creditLimit) ? 'text-red-600' : 'text-orange-600'}`}>
                      {formatCurrency(c.balance)}
                    </td>
                    <td className="text-gray-500">{formatCurrency(c.creditLimit)}</td>
                    <td>
                      {Number(c.creditLimit) > 0 && (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${Number(c.balance) > Number(c.creditLimit) ? 'bg-red-500' : 'bg-[#E15A30]'}`}
                              style={{ width: `${Math.min(100, (Number(c.balance) / Number(c.creditLimit)) * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 w-10">
                            {Math.round((Number(c.balance) / Number(c.creditLimit)) * 100)}%
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Performance Report */}
      {tab === 'performance' && perfType === 'performance' && perfData && (
        <div className="space-y-4">
          <div className="card p-0">
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('المندوب')}</th><th>{tr('عدد الفواتير')}</th><th>{tr('إجمالي المبيعات')}</th>
                    <th>{tr('التحصيل')}</th><th>{tr('نسبة التحصيل')}</th><th>{tr('متوسط الفاتورة')}</th>
                    <th>{tr('ساعات العمل')}</th><th>{tr('عدد الزيارات')}</th><th>{tr('تصدير')}</th>
                  </tr>
                </thead>
                <tbody>
                  {perfData.map(r => (
                    <Fragment key={r.id}>
                    <tr>
                      <td className="font-medium text-gray-800">{r.name}</td>
                      <td className="text-gray-600">{r.invoicesCount}</td>
                      <td className="font-semibold text-[#E15A30]">{formatCurrency(r.salesTotal)}</td>
                      <td className="text-green-600">{formatCurrency(r.collectionsTotal)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5 w-16">
                            <div className="h-1.5 rounded-full bg-green-500" style={{ width: `${r.collectionRate}%` }} />
                          </div>
                          <span className="text-xs text-gray-600 w-10">{r.collectionRate}%</span>
                        </div>
                      </td>
                      <td className="text-gray-500">{formatCurrency(r.avgInvoice)}</td>
                      <td className="font-semibold text-[#1E7A52]">{fmtDuration(r.workHours, r.workMins)}</td>
                      <td>
                        {r.visits.length > 0 ? (
                          <button onClick={() => setExpandedPerf(p => p === r.id ? null : r.id)}
                            className="inline-flex items-center gap-1 text-[#2563EB] font-semibold hover:underline"
                            title={tr('عرض مواقع الزيارات')}>
                            <MapPin size={13} /> {r.visitsCount} {expandedPerf === r.id ? '▲' : '▾'}
                          </button>
                        ) : <span className="text-gray-500">{r.visitsCount}</span>}
                      </td>
                      <td>
                        <button onClick={() => exportRepPerf(r)} title={`${tr('تصدير تقرير')} ${r.name}`}
                          className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Download size={15} /></button>
                      </td>
                    </tr>
                    {expandedPerf === r.id && r.visits.length > 0 && (
                      <tr>
                        <td colSpan={9} className="bg-[#FAF7F0] p-0">
                          <div className="p-3">
                            <p className="text-xs font-semibold text-[#6E6557] mb-2">{tr('مواقع زيارات')} {r.name} ({r.visits.length})</p>
                            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              {r.visits.map((v, i) => (
                                <a key={i} href={v.mapsUrl} target="_blank" rel="noreferrer"
                                  className="flex items-center gap-1.5 text-xs bg-white border border-[#F1EBDF] rounded-lg px-2.5 py-1.5 hover:border-[#2563EB]">
                                  <MapPin size={12} className="text-[#2563EB] shrink-0" />
                                  <span className="font-medium text-[#1F1A13] truncate">{v.customerName || tr('زيارة')}</span>
                                  <span className="text-[#9A8F7E] shrink-0">{fmtDateTime(v.createdAt)}</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* تقرير ساعات العمل — الوقت الذي كان فيه المندوب متصلاً وفاتحاً التطبيق */}
      {tab === 'performance' && perfType === 'hours' && (
        <div className="space-y-4">
          <p className="text-xs text-gray-500 -mt-1">{tr('ساعات العمل = مجموع المدد التي كان فيها المندوب متصلاً وفاتحاً التطبيق خلال الفترة المحددة.')}</p>
          {hoursLoading ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل...')}</div>
          ) : (hoursData && hoursData.length > 0) ? (
            <div className="card p-0">
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{tr('المندوب')}</th><th>{tr('ساعات العمل')}</th><th>{tr('إجمالي الدقائق')}</th>
                      <th>{tr('عدد الجلسات')}</th><th>{tr('أول ظهور')}</th><th>{tr('آخر ظهور')}</th><th>{tr('تصدير')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hoursData.map(r => (
                      <tr key={r.id}>
                        <td className="font-medium text-gray-800">{r.name}</td>
                        <td className="font-semibold text-[#1E7A52]">{fmtDuration(r.hours, r.minutes)}</td>
                        <td className="text-gray-600">{r.totalMinutes}</td>
                        <td className="text-gray-600">{r.sessions}</td>
                        <td className="text-gray-500 text-xs">{fmtDateTime(r.firstSeen)}</td>
                        <td className="text-gray-500 text-xs">{fmtDateTime(r.lastSeen)}</td>
                        <td>
                          <button onClick={() => exportRepHours(r)} title={`${tr('تصدير تقرير')} ${r.name}`}
                            className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Download size={15} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('لا توجد بيانات حضور في هذه الفترة.')}</div>
          )}
        </div>
      )}
    </div>
  );
}
