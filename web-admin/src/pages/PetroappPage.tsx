import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Fuel, Link2, Play, RefreshCw, Save, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { petroappApi, salesRepApi } from '../api/client';
import { formatDate } from '../utils/format';

/**
 * تكامل بترو آب — كل شركة تربط حساب بترو آب الخاص بها حسب احتياجها:
 * الإعدادات والمفاتيح، ثم مطابقة المركبات/السائقين بالمناديب، ثم تقرير الكلفة.
 */

interface Settings {
  enabled: boolean; baseUrl: string; hasApiKey: boolean;
  syncFuel: boolean; syncService: boolean; syncWash: boolean;
  status: string; lastSyncAt?: string | null; lastError?: string | null; stationsCount?: number;
}
interface Counts { vehicles: number; delegates: number; transactions: number }
interface Rep { id: string; name: string }
interface Vehicle { id: string; externalId: string; plate?: string | null; model?: string | null; salesRepId?: string | null; balance?: number | null }
interface Delegate { id: string; externalId: string; name?: string | null; phone?: string | null; salesRepId?: string | null; balance?: number | null }
interface ReportRow { repId: string | null; name: string; fuel: number; service: number; wash: number; liters: number; count: number; total: number }

const fmt = (n: number) => n.toLocaleString('ar-SA', { maximumFractionDigits: 2 });

export default function PetroappPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ enabled: false, baseUrl: 'https://api.petroapp.com', apiKey: '', syncFuel: true, syncService: true, syncWash: true });

  const { data } = useQuery({
    queryKey: ['petroapp-settings'],
    queryFn: async () => (await petroappApi.settings()).data.data as { settings: Settings | null; counts: Counts },
  });
  const settings = data?.settings ?? null;
  const counts = data?.counts;

  useEffect(() => {
    if (settings) setForm(f => ({ ...f, enabled: settings.enabled, baseUrl: settings.baseUrl, syncFuel: settings.syncFuel, syncService: settings.syncService, syncWash: settings.syncWash, apiKey: '' }));
  }, [settings]);

  const { data: reps } = useQuery({
    queryKey: ['petroapp-reps'],
    queryFn: async () => (await salesRepApi.list()).data.data as Rep[],
  });
  const { data: vehicles } = useQuery({
    queryKey: ['petroapp-vehicles'],
    queryFn: async () => (await petroappApi.vehicles()).data.data as Vehicle[],
    enabled: !!settings?.enabled,
  });
  const { data: delegates } = useQuery({
    queryKey: ['petroapp-delegates'],
    queryFn: async () => (await petroappApi.delegates()).data.data as Delegate[],
    enabled: !!settings?.enabled,
  });
  const { data: report } = useQuery({
    queryKey: ['petroapp-report'],
    queryFn: async () => (await petroappApi.report()).data.data as { rows: ReportRow[]; totals: ReportRow },
    enabled: !!settings?.enabled,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['petroapp-settings'] });
    qc.invalidateQueries({ queryKey: ['petroapp-vehicles'] });
    qc.invalidateQueries({ queryKey: ['petroapp-delegates'] });
    qc.invalidateQueries({ queryKey: ['petroapp-report'] });
  };

  const save = useMutation({
    mutationFn: () => petroappApi.saveSettings(form.apiKey ? form : { ...form, apiKey: undefined }),
    onSuccess: () => { toast.success('حفظت اعدادات بترو اب'); setForm(f => ({ ...f, apiKey: '' })); invalidate(); },
    onError: () => toast.error('تعذر الحفظ تاكد من الحقول'),
  });
  const test = useMutation({
    mutationFn: () => petroappApi.test(),
    onSuccess: (r) => (r.data.success ? toast.success(r.data.message) : toast.error(r.data.message)),
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || 'فشل الاختبار'),
  });
  const sync = useMutation({
    mutationFn: () => petroappApi.sync(),
    onSuccess: (r) => {
      const steps = r.data.data as { step: string; count: number; error?: string }[];
      const errs = steps.filter(s => s.error);
      toast[errs.length ? 'error' : 'success'](errs.length ? `مزامنة جزئية — ${errs.map(s => s.step).join('، ')} تعثرت` : 'تمت المزامنة');
      invalidate();
    },
    onError: () => toast.error('فشلت المزامنة'),
  });
  const linkVehicle = useMutation({
    mutationFn: ({ id, repId }: { id: string; repId: string | null }) => petroappApi.linkVehicle(id, repId),
    onSuccess: () => { toast.success('حدث الربط واعيد نسب الفواتير'); invalidate(); },
  });
  const linkDelegate = useMutation({
    mutationFn: ({ id, repId }: { id: string; repId: string | null }) => petroappApi.linkDelegate(id, repId),
    onSuccess: () => { toast.success('حدث الربط واعيد نسب الفواتير'); invalidate(); },
  });

  const repSelect = (value: string | null | undefined, onChange: (v: string | null) => void) => (
    <select className="input !py-1 !text-xs max-w-[160px]" value={value ?? ''} onChange={e => onChange(e.target.value || null)}>
      <option value="">— غير مربوط —</option>
      {(reps ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
    </select>
  );

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2"><Fuel className="w-6 h-6 text-[#E15A30]" /> تكامل بترو اب</h1>
          <p className="text-sm text-[#6E6557] mt-1">اربط حساب شركتك لدى بترو اب لتظهر مصاريف الوقود والصيانة والغسيل لكل مندوب داخل تقاريرك ويرى المندوب رصيده واقرب محطة في تطبيقه</p>
        </div>
        {settings && (
          <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full ${settings.status === 'OK' ? 'bg-green-50 text-green-700' : settings.status === 'ERROR' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
            {settings.status === 'OK' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {settings.status === 'OK' ? 'متصل' : settings.status === 'ERROR' ? 'خطا بالمزامنة' : 'بانتظار الربط'}
          </span>
        )}
      </div>

      {/* الإعدادات */}
      <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-xs font-bold text-[#6E6557]">رابط خدمة بترو اب (يزود من مدير حسابكم)</span>
            <input className="input mt-1" dir="ltr" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-[#6E6557]">مفتاح API {settings?.hasApiKey && <span className="text-green-700">(محفوظ — اتركه فارغا للابقاء عليه)</span>}</span>
            <input className="input mt-1" dir="ltr" type="password" placeholder={settings?.hasApiKey ? '••••••••' : 'الصق المفتاح من بترو اب'} value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> تفعيل التكامل</label>
          <span className="text-xs text-[#6E6557]">الخدمات حسب احتياجكم:</span>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.syncFuel} onChange={e => setForm({ ...form, syncFuel: e.target.checked })} /> الوقود</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.syncService} onChange={e => setForm({ ...form, syncService: e.target.checked })} /> الصيانة والزيوت</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.syncWash} onChange={e => setForm({ ...form, syncWash: e.target.checked })} /> الغسيل</label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => save.mutate()} disabled={save.isPending}><Save className="w-4 h-4" /> حفظ</button>
          <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => test.mutate()} disabled={test.isPending || !settings?.hasApiKey}><Play className="w-4 h-4" /> اختبار الاتصال</button>
          <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => sync.mutate()} disabled={sync.isPending || !settings?.enabled}><RefreshCw className={`w-4 h-4 ${sync.isPending ? 'animate-spin' : ''}`} /> مزامنة الان</button>
        </div>
        {settings && (
          <p className="text-xs text-[#6E6557]">
            اخر مزامنة: {settings.lastSyncAt ? formatDate(settings.lastSyncAt) : '—'} · مركبات: {counts?.vehicles ?? 0} · سائقون: {counts?.delegates ?? 0} · فواتير: {counts?.transactions ?? 0} · محطات بالكاش: {settings.stationsCount ?? 0}
            {settings.lastError && <span className="block text-red-600 mt-1 break-all">اخر خطا: {settings.lastError}</span>}
          </p>
        )}
        <p className="text-[11px] text-[#8A8178]">المزامنة تلقائية كل ٣٠ دقيقة، والمفتاح لا يعاد عرضه بعد حفظه. تحتاج مفاتيح حسابكم من مدير علاقتكم في بترو اب.</p>
      </div>

      {/* المطابقة */}
      {settings?.enabled && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
            <h2 className="font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Link2 className="w-4 h-4 text-[#E15A30]" /> السائقون ↔ المناديب <span className="text-xs font-normal text-[#6E6557]">(الاولوية بالنسب)</span></h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]"><th className="py-2">السائق</th><th>الهاتف</th><th>الرصيد</th><th>المندوب</th></tr></thead>
                <tbody>
                  {(delegates ?? []).map(d => (
                    <tr key={d.id} className="border-b border-[#F4EEE3]">
                      <td className="py-2 font-medium">{d.name || d.externalId}</td>
                      <td dir="ltr" className="text-xs text-[#6E6557]">{d.phone || '—'}</td>
                      <td className="text-xs">{d.balance != null ? fmt(d.balance) : '—'}</td>
                      <td>{repSelect(d.salesRepId, repId => linkDelegate.mutate({ id: d.id, repId }))}</td>
                    </tr>
                  ))}
                  {!delegates?.length && <tr><td colSpan={4} className="py-4 text-center text-xs text-[#6E6557]">لا سائقون بعد — شغل المزامنة</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
            <h2 className="font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Link2 className="w-4 h-4 text-[#E15A30]" /> المركبات ↔ المناديب</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]"><th className="py-2">اللوحة</th><th>الموديل</th><th>الرصيد</th><th>المندوب</th></tr></thead>
                <tbody>
                  {(vehicles ?? []).map(v => (
                    <tr key={v.id} className="border-b border-[#F4EEE3]">
                      <td className="py-2 font-medium" dir="ltr">{v.plate || v.externalId}</td>
                      <td className="text-xs text-[#6E6557]">{v.model || '—'}</td>
                      <td className="text-xs">{v.balance != null ? fmt(v.balance) : '—'}</td>
                      <td>{repSelect(v.salesRepId, repId => linkVehicle.mutate({ id: v.id, repId }))}</td>
                    </tr>
                  ))}
                  {!vehicles?.length && <tr><td colSpan={4} className="py-4 text-center text-xs text-[#6E6557]">لا مركبات بعد — شغل المزامنة</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* تقرير الكلفة */}
      {settings?.enabled && (
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
          <h2 className="font-bold text-[#1F1A13] mb-3">كلفة الوقود والخدمات لكل مندوب <span className="text-xs font-normal text-[#6E6557]">(اخر ٣٠ يوما)</span></h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]"><th className="py-2">المندوب</th><th>وقود</th><th>لترات</th><th>صيانة</th><th>غسيل</th><th>الاجمالي</th><th>فواتير</th></tr></thead>
              <tbody>
                {(report?.rows ?? []).map((r, i) => (
                  <tr key={i} className="border-b border-[#F4EEE3]">
                    <td className="py-2 font-medium">{r.name}</td>
                    <td>{fmt(r.fuel)}</td>
                    <td className="text-xs text-[#6E6557]">{fmt(r.liters)}</td>
                    <td>{fmt(r.service)}</td>
                    <td>{fmt(r.wash)}</td>
                    <td className="font-bold text-[#E15A30]">{fmt(r.total)}</td>
                    <td className="text-xs text-[#6E6557]">{r.count}</td>
                  </tr>
                ))}
                {!report?.rows?.length && <tr><td colSpan={7} className="py-4 text-center text-xs text-[#6E6557]">لا فواتير في الفترة</td></tr>}
              </tbody>
              {!!report?.rows?.length && (
                <tfoot><tr className="font-bold border-t-2 border-[#E9E1D3]"><td className="py-2">الاجمالي</td><td>{fmt(report.totals.fuel)}</td><td className="text-xs">{fmt(report.totals.liters)}</td><td>{fmt(report.totals.service)}</td><td>{fmt(report.totals.wash)}</td><td className="text-[#E15A30]">{fmt(report.totals.total)}</td><td className="text-xs">{report.totals.count}</td></tr></tfoot>
              )}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
