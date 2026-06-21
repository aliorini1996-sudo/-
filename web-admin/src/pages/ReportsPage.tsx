import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportApi } from '../api/client';
import { formatCurrency, formatDate } from '../utils/format';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Download, TrendingUp, Users, Package, UserCheck } from 'lucide-react';

type Tab = 'sales' | 'collections' | 'balances' | 'performance';

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState('rep');

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'sales', label: 'تقارير المبيعات', icon: TrendingUp },
    { id: 'collections', label: 'تقارير التحصيل', icon: Download },
    { id: 'balances', label: 'أرصدة العملاء', icon: Users },
    { id: 'performance', label: 'أداء المناديب', icon: UserCheck },
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

  const { data: perfData } = useQuery({
    queryKey: ['report-performance', from, to],
    queryFn: async () => {
      const res = await reportApi.repPerformance({ from, to });
      return res.data.data as { id: string; name: string; invoicesCount: number; salesTotal: number; collectionsTotal: number; collectionRate: number; avgInvoice: number }[];
    },
    enabled: tab === 'performance',
  });

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">التقارير</h1>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-white rounded-xl p-1 border border-gray-100 w-fit">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label">من</label>
            <input type="date" className="input w-36" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">إلى</label>
            <input type="date" className="input w-36" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          {tab === 'sales' && (
            <div>
              <label className="label">تجميع حسب</label>
              <select className="input w-36" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                <option value="rep">المندوب</option>
                <option value="customer">العميل</option>
                <option value="product">الصنف</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Sales Report */}
      {tab === 'sales' && (
        <div className="space-y-4">
          {salesLoading ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">جاري التحميل...</div>
          ) : Array.isArray(salesData) && salesData.length > 0 ? (
            <>
              <div className="card">
                <h3 className="font-semibold text-gray-700 mb-4">مبيعات حسب {groupBy === 'rep' ? 'المندوب' : groupBy === 'customer' ? 'العميل' : 'الصنف'}</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={(salesData as { name: string; total: number; count?: number }[]).slice(0, 10)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    <Bar dataKey="total" fill="#3b82f6" radius={[4, 4, 0, 0]} name="المبيعات" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card p-0">
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{groupBy === 'rep' ? 'المندوب' : groupBy === 'customer' ? 'العميل' : 'الصنف'}</th>
                        <th>{groupBy === 'product' ? 'الكمية' : 'عدد الفواتير'}</th>
                        <th>إجمالي المبيعات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(salesData as { name: string; total: number; count?: number; qty?: number; code?: string }[]).map((row, i) => (
                        <tr key={i}>
                          <td className="font-medium text-gray-800">{row.name}</td>
                          <td className="text-gray-600">{row.count ?? row.qty ?? '-'}</td>
                          <td className="font-semibold text-blue-600">{formatCurrency(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="card text-center text-gray-400 py-12">لا توجد بيانات</div>
          )}
        </div>
      )}

      {/* Collections Report */}
      {tab === 'collections' && collectData && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <div className="card text-center">
              <p className="text-xs text-gray-500">إجمالي التحصيل</p>
              <p className="text-xl font-bold text-green-600">{formatCurrency(collectData.summary.total)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">عدد السندات</p>
              <p className="text-xl font-bold text-gray-700">{collectData.summary.count}</p>
            </div>
            {Object.entries(collectData.summary.byMethod).map(([m, v]) => (
              <div key={m} className="card text-center">
                <p className="text-xs text-gray-500">{m === 'CASH' ? 'نقدي' : m === 'BANK_TRANSFER' ? 'تحويل' : m === 'POS' ? 'شبكة' : 'شيك'}</p>
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
                <tr><th>العميل</th><th>الجوال</th><th>الرصيد</th><th>الحد الائتماني</th><th>نسبة الاستخدام</th></tr>
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
                              className={`h-1.5 rounded-full ${Number(c.balance) > Number(c.creditLimit) ? 'bg-red-500' : 'bg-blue-500'}`}
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
      {tab === 'performance' && perfData && (
        <div className="space-y-4">
          <div className="card p-0">
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>المندوب</th><th>عدد الفواتير</th><th>إجمالي المبيعات</th>
                    <th>التحصيل</th><th>نسبة التحصيل</th><th>متوسط الفاتورة</th>
                  </tr>
                </thead>
                <tbody>
                  {perfData.map(r => (
                    <tr key={r.id}>
                      <td className="font-medium text-gray-800">{r.name}</td>
                      <td className="text-gray-600">{r.invoicesCount}</td>
                      <td className="font-semibold text-blue-600">{formatCurrency(r.salesTotal)}</td>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
