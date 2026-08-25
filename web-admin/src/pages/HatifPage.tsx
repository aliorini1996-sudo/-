import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Phone, PhoneCall, Play, Plus, RefreshCw, Save, Trash2, UserMinus, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { salesRepApi, workNumbersApi } from '../api/client';
import { formatDate } from '../utils/format';

/**
 * أرقام العمل وتكامل هاتف — كل شركة حسب احتياجها:
 * المزود اليدوي (شرائح الشركة) يعمل فوراً بصفر كلفة، ومزود هاتف يسحب القنوات
 * بمفاتيح حساب الشركة. الرقم يُسنَد للمندوب ويُحرَّر عند استقالته فتبقى علاقة
 * العميل عند الشركة — وسجل المكالمات يصل عبر ويبهوك ما بعد المكالمة.
 */

interface Settings {
  provider: 'manual' | 'hatif'; baseUrl: string; hasClientSecret: boolean; clientId?: string | null;
  status: string; lastSyncAt?: string | null; lastError?: string | null; webhookUrl: string;
}
interface Counts { channels: number; calls: number }
interface Rep { id: string; name: string }
interface Channel { id: string; e164: string; label?: string | null; provider: string; kind: string; isActive: boolean; assignedRep?: { id: string; name: string } | null; assignedAt?: string | null }
interface CallRow { id: string; direction: string; fromE164: string; toE164: string; startedAt: string; durationSec: number; repName?: string | null; aiSummary?: string | null; recordingUrl?: string | null }
interface RepAgg { repId: string | null; name: string; calls: number; durationSec: number; missed: number }

const DIR_AR: Record<string, string> = { IN: 'واردة', OUT: 'صادرة', MISSED: 'فائتة' };
const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}د ${s % 60}ث` : `${s}ث`);

export default function HatifPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({ provider: 'manual' as 'manual' | 'hatif', baseUrl: 'https://api.voxa.sa', clientId: '', clientSecret: '' });
  const [newNum, setNewNum] = useState({ e164: '', label: '' });

  const { data } = useQuery({
    queryKey: ['hatif-settings'],
    queryFn: async () => (await workNumbersApi.settings()).data.data as { settings: Settings | null; counts: Counts },
  });
  const settings = data?.settings ?? null;

  useEffect(() => {
    if (settings) setForm(f => ({ ...f, provider: settings.provider, baseUrl: settings.baseUrl, clientId: settings.clientId || '', clientSecret: '' }));
  }, [settings]);

  const { data: reps } = useQuery({ queryKey: ['hatif-reps'], queryFn: async () => (await salesRepApi.list()).data.data as Rep[] });
  const { data: channels } = useQuery({ queryKey: ['hatif-channels'], queryFn: async () => (await workNumbersApi.list()).data.data as Channel[] });
  const { data: callsData } = useQuery({ queryKey: ['hatif-calls'], queryFn: async () => (await workNumbersApi.calls()).data.data as { calls: CallRow[]; byRep: RepAgg[] } });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['hatif-settings'] });
    qc.invalidateQueries({ queryKey: ['hatif-channels'] });
    qc.invalidateQueries({ queryKey: ['hatif-calls'] });
  };

  const save = useMutation({
    mutationFn: () => workNumbersApi.saveSettings(form.clientSecret ? form : { ...form, clientSecret: undefined }),
    onSuccess: () => { toast.success('حفظت اعدادات الاتصالات'); setForm(f => ({ ...f, clientSecret: '' })); invalidate(); },
    onError: () => toast.error('تعذر الحفظ'),
  });
  const test = useMutation({
    mutationFn: () => workNumbersApi.test(),
    onSuccess: (r) => (r.data.success ? toast.success(r.data.message) : toast.error(r.data.message)),
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || 'فشل الاختبار'),
  });
  const sync = useMutation({
    mutationFn: () => workNumbersApi.sync(),
    onSuccess: (r) => { r.data.success ? toast.success(`سحبت ${r.data.count} قناة من هاتف`) : toast.error(r.data.message || 'تعذرت المزامنة'); invalidate(); },
  });
  const addNum = useMutation({
    mutationFn: () => workNumbersApi.add(newNum.e164, newNum.label || undefined),
    onSuccess: () => { toast.success('اضيف الرقم للمخزون'); setNewNum({ e164: '', label: '' }); invalidate(); },
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || 'تعذرت الاضافة'),
  });
  const assign = useMutation({
    mutationFn: ({ id, repId }: { id: string; repId: string }) => workNumbersApi.assign(id, repId),
    onSuccess: () => { toast.success('اسند الرقم للمندوب'); invalidate(); },
  });
  const release = useMutation({
    mutationFn: (id: string) => workNumbersApi.release(id),
    onSuccess: () => { toast.success('حرر الرقم — علاقة العملاء بقيت عند الشركة'); invalidate(); },
  });
  const removeNum = useMutation({
    mutationFn: (id: string) => workNumbersApi.remove(id),
    onSuccess: () => { toast.success('حذف الرقم'); invalidate(); },
    onError: (e: { response?: { data?: { message?: string } } }) => toast.error(e.response?.data?.message || 'تعذر الحذف'),
  });

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2"><PhoneCall className="w-6 h-6 text-[#E15A30]" /> ارقام العمل وربط هاتف</h1>
          <p className="text-sm text-[#6E6557] mt-1">رقم عمل مؤسسي لكل مندوب تملكه الشركة لا المندوب — يسند ويحرر عند الاستقالة فتبقى علاقة العميل عندك وسجل المكالمات يصل تلقائيا</p>
        </div>
        {settings && (
          <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full ${settings.status === 'OK' ? 'bg-green-50 text-green-700' : settings.status === 'ERROR' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
            {settings.status === 'OK' ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
            {settings.provider === 'manual' ? 'يدوي — بلا مزود' : settings.status === 'OK' ? 'متصل بهاتف' : settings.status === 'ERROR' ? 'خطا بالاتصال' : 'بانتظار الربط'}
          </span>
        )}
      </div>

      {/* الإعدادات */}
      <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-xs font-bold text-[#6E6557]">المزود:</span>
          <label className="inline-flex items-center gap-2"><input type="radio" checked={form.provider === 'manual'} onChange={() => setForm({ ...form, provider: 'manual' })} /> يدوي — شرائح الشركة (بلا كلفة)</label>
          <label className="inline-flex items-center gap-2"><input type="radio" checked={form.provider === 'hatif'} onChange={() => setForm({ ...form, provider: 'hatif' })} /> هاتف — الصوت الذكي (api.voxa.sa)</label>
        </div>
        {form.provider === 'hatif' && (
          <>
            <div className="grid sm:grid-cols-3 gap-4">
              <label className="block">
                <span className="text-xs font-bold text-[#6E6557]">رابط الخدمة</span>
                <input className="input mt-1" dir="ltr" value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-[#6E6557]">Client ID <span className="font-normal">(من Settings ← API Connect)</span></span>
                <input className="input mt-1" dir="ltr" value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-xs font-bold text-[#6E6557]">Client Secret {settings?.hasClientSecret && <span className="text-green-700">(محفوظ)</span>}</span>
                <input className="input mt-1" dir="ltr" type="password" placeholder={settings?.hasClientSecret ? '••••••••' : ''} value={form.clientSecret} onChange={e => setForm({ ...form, clientSecret: e.target.value })} />
              </label>
            </div>
            {settings?.webhookUrl && (
              <div className="bg-[#FAF7F0] border border-[#E9E1D3] rounded-xl p-3 text-xs">
                <span className="font-bold text-[#6E6557]">عنوان الويبهوك — الصقه في لوحة هاتف (Settings ← API Connect ← Webhook):</span>
                <div className="flex items-center gap-2 mt-1.5">
                  <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] bg-white border border-[#E9E1D3] rounded-lg px-2.5 py-1.5" dir="ltr">{settings.webhookUrl}</code>
                  <button className="btn-secondary !py-1.5 !px-2.5" onClick={() => { navigator.clipboard.writeText(settings.webhookUrl); toast.success('نسخ'); }}><Copy className="w-3.5 h-3.5" /></button>
                </div>
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary inline-flex items-center gap-1.5" onClick={() => save.mutate()} disabled={save.isPending}><Save className="w-4 h-4" /> حفظ</button>
          {form.provider === 'hatif' && <>
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => test.mutate()} disabled={test.isPending}><Play className="w-4 h-4" /> اختبار الاتصال</button>
            <button className="btn-secondary inline-flex items-center gap-1.5" onClick={() => sync.mutate()} disabled={sync.isPending}><RefreshCw className={`w-4 h-4 ${sync.isPending ? 'animate-spin' : ''}`} /> سحب الارقام من هاتف</button>
          </>}
        </div>
        {settings?.lastError && <p className="text-xs text-red-600 break-all">اخر خطا: {settings.lastError}</p>}
        {settings?.lastSyncAt && <p className="text-[11px] text-[#8A8178]">اخر مزامنة: {formatDate(settings.lastSyncAt)}</p>}
      </div>

      {/* مخزون الأرقام */}
      <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
          <h2 className="font-bold text-[#1F1A13] flex items-center gap-2"><Phone className="w-4 h-4 text-[#E15A30]" /> مخزون الارقام <span className="text-xs font-normal text-[#6E6557]">({channels?.length ?? 0})</span></h2>
          <div className="flex gap-2 items-center">
            <input className="input !py-1.5 !text-xs w-40" dir="ltr" placeholder="0501234567" value={newNum.e164} onChange={e => setNewNum({ ...newNum, e164: e.target.value })} />
            <input className="input !py-1.5 !text-xs w-32" placeholder="تسمية (اختياري)" value={newNum.label} onChange={e => setNewNum({ ...newNum, label: e.target.value })} />
            <button className="btn-secondary !py-1.5 inline-flex items-center gap-1" onClick={() => addNum.mutate()} disabled={!newNum.e164 || addNum.isPending}><Plus className="w-3.5 h-3.5" /> اضافة</button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]"><th className="py-2">الرقم</th><th>التسمية</th><th>المصدر</th><th>المندوب المسند</th><th>اجراءات</th></tr></thead>
            <tbody>
              {(channels ?? []).map(ch => (
                <tr key={ch.id} className={`border-b border-[#F4EEE3] ${!ch.isActive ? 'opacity-50' : ''}`}>
                  <td className="py-2 font-bold" dir="ltr">{ch.e164}</td>
                  <td className="text-xs text-[#6E6557]">{ch.label || '—'}</td>
                  <td className="text-xs">{ch.provider === 'hatif' ? 'هاتف' : 'يدوي'}</td>
                  <td>
                    {ch.assignedRep ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="font-medium">{ch.assignedRep.name}</span>
                        <button title="تحرير الرقم (استقال المندوب)" className="text-amber-600 hover:text-amber-800" onClick={() => release.mutate(ch.id)}><UserMinus className="w-4 h-4" /></button>
                      </span>
                    ) : (
                      <select className="input !py-1 !text-xs max-w-[160px]" value="" onChange={e => e.target.value && assign.mutate({ id: ch.id, repId: e.target.value })}>
                        <option value="">— اسناد لمندوب —</option>
                        {(reps ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    )}
                  </td>
                  <td>
                    {!ch.assignedRep && <button title="حذف" className="text-red-500 hover:text-red-700" onClick={() => removeNum.mutate(ch.id)}><Trash2 className="w-4 h-4" /></button>}
                  </td>
                </tr>
              ))}
              {!channels?.length && <tr><td colSpan={5} className="py-4 text-center text-xs text-[#6E6557]">لا ارقام بعد — اضف رقما يدويا او اسحب من هاتف</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* تقرير المكالمات */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
          <h2 className="font-bold text-[#1F1A13] mb-3">مكالمات المناديب <span className="text-xs font-normal text-[#6E6557]">(اخر ٣٠ يوما)</span></h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-right text-xs text-[#6E6557] border-b border-[#E9E1D3]"><th className="py-2">المندوب</th><th>مكالمات</th><th>المدة</th><th>فائتة</th></tr></thead>
              <tbody>
                {(callsData?.byRep ?? []).map((r, i) => (
                  <tr key={i} className="border-b border-[#F4EEE3]">
                    <td className="py-2 font-medium">{r.name}</td>
                    <td>{r.calls}</td>
                    <td className="text-xs">{mins(r.durationSec)}</td>
                    <td className="text-xs text-red-600">{r.missed || '—'}</td>
                  </tr>
                ))}
                {!callsData?.byRep?.length && <tr><td colSpan={4} className="py-4 text-center text-xs text-[#6E6557]">لا مكالمات بعد — تصل تلقائيا عبر الويبهوك بعد ربط هاتف</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-5">
          <h2 className="font-bold text-[#1F1A13] mb-3">اخر المكالمات</h2>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {(callsData?.calls ?? []).slice(0, 20).map(c => (
              <div key={c.id} className="border border-[#F4EEE3] rounded-xl px-3 py-2 text-xs flex items-center justify-between gap-2">
                <div>
                  <span className={`font-bold ${c.direction === 'MISSED' ? 'text-red-600' : c.direction === 'OUT' ? 'text-blue-600' : 'text-green-700'}`}>{DIR_AR[c.direction] || c.direction}</span>
                  <span className="text-[#6E6557]"> · {c.repName || 'غير منسوب'} · </span>
                  <span dir="ltr">{c.direction === 'OUT' ? c.toE164 : c.fromE164}</span>
                  {c.aiSummary && <p className="text-[#8A8178] mt-0.5">{c.aiSummary}</p>}
                </div>
                <div className="text-left shrink-0">
                  <div className="text-[#6E6557]">{mins(c.durationSec)}</div>
                  <div className="text-[10px] text-[#B7AD9D]">{formatDate(c.startedAt)}</div>
                </div>
              </div>
            ))}
            {!callsData?.calls?.length && <p className="text-xs text-[#6E6557] text-center py-4">—</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
