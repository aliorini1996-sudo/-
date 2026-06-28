import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, DatabaseZap, Play, Save, ServerCog, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { erpApi } from '../api/client';
import { ErpIntegration, ErpSyncLog } from '../types';
import { formatDate } from '../utils/format';

type FormState = ErpIntegration & {
  apiKey?: string;
  bearerToken?: string;
  basicPassword?: string;
};

const empty: FormState = {
  enabled: false,
  provider: 'CUSTOM',
  baseUrl: '',
  authType: 'NONE',
  basicUsername: '',
  apiKey: '',
  bearerToken: '',
  basicPassword: '',
  customersEndpoint: '/customers',
  productsEndpoint: '/products',
  invoicesEndpoint: '/invoices',
  receiptsEndpoint: '/receipts',
  syncCustomers: true,
  syncProducts: true,
  syncInvoices: true,
  syncReceipts: true,
};

const resourceLabels: Record<string, string> = {
  all: 'الكل',
  customers: 'العملاء',
  products: 'المنتجات',
  invoices: 'الفواتير',
  receipts: 'سندات القبض',
  connection: 'اختبار الاتصال',
};

export default function ErpIntegrationPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(empty);

  const { data: settings, isLoading } = useQuery({
    queryKey: ['erp-settings'],
    queryFn: async () => {
      const res = await erpApi.settings();
      return res.data.data as ErpIntegration | null;
    },
  });

  useEffect(() => {
    if (settings) setForm({ ...empty, ...settings, apiKey: '', bearerToken: '', basicPassword: '' });
  }, [settings]);

  const { data: logs } = useQuery({
    queryKey: ['erp-logs'],
    queryFn: async () => {
      const res = await erpApi.logs();
      return res.data.data as ErpSyncLog[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: () => erpApi.saveSettings(form),
    onSuccess: () => {
      toast.success('تم حفظ إعدادات ERP');
      qc.invalidateQueries({ queryKey: ['erp-settings'] });
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر الحفظ'),
  });

  const testMutation = useMutation({
    mutationFn: () => erpApi.test(),
    onSuccess: () => {
      toast.success('تم اختبار الاتصال');
      qc.invalidateQueries({ queryKey: ['erp-logs'] });
    },
    onError: (err: unknown) => {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'فشل اختبار الاتصال');
      qc.invalidateQueries({ queryKey: ['erp-logs'] });
    },
  });

  const syncMutation = useMutation({
    mutationFn: (resource: 'all' | 'customers' | 'products' | 'invoices' | 'receipts') => erpApi.sync(resource),
    onSuccess: () => {
      toast.success('تم تشغيل المزامنة');
      qc.invalidateQueries({ queryKey: ['erp-logs'] });
      qc.invalidateQueries({ queryKey: ['erp-settings'] });
    },
    onError: (err: unknown) => toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّرت المزامنة'),
  });

  const set = (key: keyof FormState, value: string | boolean) => setForm(f => ({ ...f, [key]: value }));
  const busy = saveMutation.isPending || testMutation.isPending || syncMutation.isPending;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">تكامل ERP</h1>
          <p className="text-sm text-gray-500 mt-1">اربط النظام مع أي ERP يدعم REST API لتصدير العملاء والمنتجات والفواتير والتحصيل.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" disabled={busy || isLoading} onClick={() => testMutation.mutate()}><Activity size={16} />اختبار الاتصال</button>
          <button className="btn-primary" disabled={busy || isLoading} onClick={() => saveMutation.mutate()}><Save size={16} />حفظ الإعدادات</button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_.85fr] gap-6">
        <div className="space-y-6">
          <div className="card">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-11 h-11 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><ServerCog size={20} /></div>
              <div>
                <h2 className="font-bold text-[#1F1A13]">إعدادات الاتصال</h2>
                <p className="text-xs text-gray-500">ضع رابط API الرئيسي ونوع المصادقة المعتمد في نظام ERP.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center gap-2 col-span-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} />
                تفعيل التكامل
              </label>
              <div>
                <label className="label">النظام</label>
                <select className="input" value={form.provider} onChange={e => set('provider', e.target.value)}>
                  <option value="CUSTOM">عام / مخصص</option>
                  <option value="ODOO">Odoo</option>
                  <option value="SAP">SAP</option>
                  <option value="ZOHO">Zoho</option>
                  <option value="OTHER">آخر</option>
                </select>
              </div>
              <div>
                <label className="label">نوع المصادقة</label>
                <select className="input" value={form.authType} onChange={e => set('authType', e.target.value)}>
                  <option value="NONE">بدون</option>
                  <option value="API_KEY">API Key</option>
                  <option value="BEARER">Bearer Token</option>
                  <option value="BASIC">Basic Auth</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="label">رابط ERP الأساسي</label>
                <input className="input" dir="ltr" placeholder="https://erp.example.com/api" value={form.baseUrl || ''} onChange={e => set('baseUrl', e.target.value)} />
              </div>
              {form.authType === 'API_KEY' && (
                <div className="col-span-2">
                  <label className="label">API Key {form.hasApiKey && <span className="text-xs text-green-600">محفوظ سابقًا</span>}</label>
                  <input className="input" dir="ltr" type="password" placeholder="اتركه فارغًا للإبقاء على المفتاح الحالي" value={form.apiKey || ''} onChange={e => set('apiKey', e.target.value)} />
                </div>
              )}
              {form.authType === 'BEARER' && (
                <div className="col-span-2">
                  <label className="label">Bearer Token {form.hasBearerToken && <span className="text-xs text-green-600">محفوظ سابقًا</span>}</label>
                  <input className="input" dir="ltr" type="password" placeholder="اتركه فارغًا للإبقاء على الرمز الحالي" value={form.bearerToken || ''} onChange={e => set('bearerToken', e.target.value)} />
                </div>
              )}
              {form.authType === 'BASIC' && (
                <>
                  <div>
                    <label className="label">اسم المستخدم</label>
                    <input className="input" dir="ltr" value={form.basicUsername || ''} onChange={e => set('basicUsername', e.target.value)} />
                  </div>
                  <div>
                    <label className="label">كلمة المرور {form.hasBasicPassword && <span className="text-xs text-green-600">محفوظة</span>}</label>
                    <input className="input" dir="ltr" type="password" placeholder="اتركها فارغة للإبقاء عليها" value={form.basicPassword || ''} onChange={e => set('basicPassword', e.target.value)} />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-11 h-11 rounded-xl bg-[#E4F1EA] text-[#1E7A52] flex items-center justify-center"><DatabaseZap size={20} /></div>
              <div>
                <h2 className="font-bold text-[#1F1A13]">مسارات المزامنة</h2>
                <p className="text-xs text-gray-500">يُرسل النظام طلب POST يحتوي على البيانات إلى كل مسار.</p>
              </div>
            </div>

            <EndpointRow label="العملاء" enabled={form.syncCustomers} endpoint={form.customersEndpoint || ''} onEnabled={v => set('syncCustomers', v)} onEndpoint={v => set('customersEndpoint', v)} />
            <EndpointRow label="المنتجات" enabled={form.syncProducts} endpoint={form.productsEndpoint || ''} onEnabled={v => set('syncProducts', v)} onEndpoint={v => set('productsEndpoint', v)} />
            <EndpointRow label="الفواتير" enabled={form.syncInvoices} endpoint={form.invoicesEndpoint || ''} onEnabled={v => set('syncInvoices', v)} onEndpoint={v => set('invoicesEndpoint', v)} />
            <EndpointRow label="سندات القبض" enabled={form.syncReceipts} endpoint={form.receiptsEndpoint || ''} onEnabled={v => set('syncReceipts', v)} onEndpoint={v => set('receiptsEndpoint', v)} />
          </div>
        </div>

        <div className="space-y-6">
          <div className="card">
            <h2 className="font-bold text-[#1F1A13] mb-4">تشغيل مزامنة يدوية</h2>
            <div className="grid grid-cols-2 gap-3">
              {(['all', 'customers', 'products', 'invoices', 'receipts'] as const).map(r => (
                <button key={r} disabled={busy} onClick={() => syncMutation.mutate(r)} className="btn-secondary justify-center py-2.5">
                  <Play size={14} /> {resourceLabels[r]}
                </button>
              ))}
            </div>
            {settings?.lastSyncAt && <p className="text-xs text-gray-500 mt-4">آخر مزامنة: {formatDate(settings.lastSyncAt)}</p>}
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-bold text-[#1F1A13]">سجل المزامنة</h2>
            </div>
            <div className="divide-y divide-gray-100 max-h-[520px] overflow-y-auto">
              {logs?.length ? logs.map(log => (
                <div key={log.id} className="p-4 flex items-start gap-3">
                  {log.status === 'SUCCESS' ? <CheckCircle2 size={18} className="text-green-600 mt-0.5" /> : <XCircle size={18} className="text-red-500 mt-0.5" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-semibold text-sm text-[#1F1A13]">{resourceLabels[log.resource] || log.resource}</p>
                      <span className="text-xs text-gray-400">{formatDate(log.startedAt)}</span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{log.message || ''}</p>
                    <p className="text-[11px] text-gray-400 mt-1">عدد السجلات: {log.count}</p>
                  </div>
                </div>
              )) : <p className="text-center text-gray-400 text-sm py-10">لا توجد عمليات مزامنة بعد</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EndpointRow({ label, enabled, endpoint, onEnabled, onEndpoint }: {
  label: string;
  enabled: boolean;
  endpoint: string;
  onEnabled: (v: boolean) => void;
  onEndpoint: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 items-center mb-3">
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={enabled} onChange={e => onEnabled(e.target.checked)} />
        {label}
      </label>
      <input className="input" dir="ltr" disabled={!enabled} placeholder="/endpoint" value={endpoint} onChange={e => onEndpoint(e.target.value)} />
    </div>
  );
}
