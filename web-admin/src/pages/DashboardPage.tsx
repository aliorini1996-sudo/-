import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '../api/client';
import { formatCurrency, formatDate, statusLabels } from '../utils/format';
import { DashboardStats } from '../types';
import {
  TrendingUp, ShoppingCart, DollarSign, Users,
  FileText, CreditCard, AlertTriangle, Trophy,
} from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType; label: string; value: string; sub?: string; color: string;
}) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${color}`}>
        <Icon size={22} className="text-white" />
      </div>
      <div>
        <p className="text-xs text-gray-500 mb-0.5">{label}</p>
        <p className="text-lg font-bold text-gray-800">{value}</p>
        {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: async () => {
      const res = await dashboardApi.stats();
      return res.data.data as DashboardStats;
    },
    refetchInterval: 60000,
  });

  const { data: trendData } = useQuery({
    queryKey: ['sales-trend'],
    queryFn: async () => {
      const res = await dashboardApi.salesTrend(30);
      return res.data.data as { date: string; total: number }[];
    },
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <div className="w-8 h-8 border-4 border-[#E15A30] border-t-transparent rounded-full animate-spin" />
    </div>
  );

  // معالجة فشل التحميل (مثلاً انقطاع الخادم) بدل تعطّل الصفحة
  if (isError || !data) return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <p className="text-gray-500 mb-3">تعذّر تحميل بيانات لوحة التحكم</p>
      <button onClick={() => refetch()} className="btn-primary">إعادة المحاولة</button>
    </div>
  );

  const d = data;

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">لوحة التحكم</h1>
        <p className="text-sm text-gray-500">{new Intl.DateTimeFormat('ar-SA', { dateStyle: 'full' }).format(new Date())}</p>
      </div>

      {/* Today Stats */}
      <div>
        <h2 className="text-sm font-semibold text-gray-500 mb-3 uppercase tracking-wide">إحصائيات اليوم</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard icon={DollarSign} label="المبيعات اليوم" value={formatCurrency(d.today.salesTotal)} sub={`${d.today.invoicesCount} فاتورة`} color="bg-[#E15A30]" />
          <StatCard icon={CreditCard} label="التحصيل اليوم" value={formatCurrency(d.today.collectionsTotal)} sub={`${d.today.receiptsCount} سند`} color="bg-green-500" />
          <StatCard icon={ShoppingCart} label="مبيعات الشهر" value={formatCurrency(d.month.salesTotal)} sub={`${d.month.invoicesCount} فاتورة`} color="bg-[#E15A30]" />
          <StatCard icon={TrendingUp} label="تحصيل الشهر" value={formatCurrency(d.month.collectionsTotal)} sub={`${d.month.receiptsCount} سند`} color="bg-teal-500" />
        </div>
      </div>

      {/* Customer Stats */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard icon={Users} label="العملاء النشطون" value={String(d.customers.total)} color="bg-purple-500" />
        <StatCard icon={FileText} label="العملاء بأرصدة" value={String(d.customers.withBalance)} color="bg-orange-500" />
        <StatCard icon={AlertTriangle} label="تجاوز الحد الائتماني" value={String(d.customers.creditExceeded)} color="bg-red-500" />
      </div>

      {/* Chart + Top Reps */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Sales Trend */}
        <div className="card lg:col-span-2">
          <h3 className="font-semibold text-gray-700 mb-4">مبيعات آخر 30 يوم</h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={trendData || []}>
              <defs>
                <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={v => v.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v: number) => formatCurrency(v)} labelStyle={{ direction: 'ltr' }} />
              <Area type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2} fill="url(#colorSales)" name="المبيعات" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Top Reps */}
        <div className="card">
          <h3 className="font-semibold text-gray-700 mb-4 flex items-center gap-2">
            <Trophy size={16} className="text-yellow-500" /> أفضل المناديب
          </h3>
          <div className="space-y-3">
            {d.topReps.slice(0, 5).map((rep, i) => (
              <div key={rep.id} className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center text-xs font-bold flex-shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{rep.name}</p>
                  <p className="text-xs text-gray-400">{rep.invoicesCount} فاتورة</p>
                </div>
                <span className="text-sm font-semibold text-[#E15A30] whitespace-nowrap">
                  {formatCurrency(rep.salesTotal)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Recent Invoices + Top Customers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Recent Invoices */}
        <div className="card">
          <h3 className="font-semibold text-gray-700 mb-4">آخر الفواتير</h3>
          <div className="space-y-2">
            {d.recentInvoices.slice(0, 6).map(inv => (
              <div key={inv.id} className="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-800">{inv.number}</p>
                  <p className="text-xs text-gray-400">{inv.customer.name} • {inv.salesRep.name}</p>
                </div>
                <div className="text-left">
                  <p className="text-sm font-semibold text-gray-800">{formatCurrency(inv.total)}</p>
                  <span className={`badge-${inv.type.toLowerCase()}`}>{statusLabels[inv.type]}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Customers */}
        <div className="card">
          <h3 className="font-semibold text-gray-700 mb-4 flex items-center gap-2">
            <Trophy size={16} className="text-orange-500" /> أفضل العملاء
          </h3>
          <div className="space-y-3">
            {d.topCustomers.slice(0, 6).map((c, i) => (
              <div key={c.id} className="flex items-center gap-3">
                <span className="w-6 h-6 rounded-full bg-orange-100 text-orange-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{c.name}</p>
                  <p className="text-xs text-gray-400">الرصيد: {formatCurrency(c.balance)}</p>
                </div>
                <span className="text-sm font-semibold text-orange-600 whitespace-nowrap">
                  {formatCurrency(c.totalSales)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
