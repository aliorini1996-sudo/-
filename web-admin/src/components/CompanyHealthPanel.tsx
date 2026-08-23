import { useQuery } from '@tanstack/react-query';
import { tenantApi, analyticsApi } from '../api/client';
import { Tenant } from '../types';
import {
  X, RefreshCw, Activity, Building2, CheckCircle2, AlertTriangle, Clock,
  Users, FileText, Globe2, TrendingUp, Sparkles, HeartPulse, Power,
} from 'lucide-react';
import { backdropClose } from '../lib/backdropClose';

// لوحة «صحّة الشركة» الموحّدة — لمالك المنصّة (M1.P3 / T1.3.1-T1.3.2).
// تجمّع مؤشّرات النمو والمنتج والتشغيل من المصادر القائمة (الشركات + التحليلات)
// بلا أي نقطة نهاية جديدة أو تعديل قاعدة بيانات. النجم الشمالي = الشركات المشتركة النشطة.

interface Vis { total: number; uniques: number; days: number; byCountry: { label: string; count: number }[] }
interface OpsMetrics {
  totalTenants: number; activeTenants: number; activeNotExpired: number;
  byPlan: Record<string, number>; mrrEstimate: number; unpricedPlans: number;
  expired30d: number; expiring7d: number; new30d: number; activated: number;
}
interface OpsCard {
  id: string; title: string; opened: string; deadline?: string; severity?: string;
  daysOpen: number; overdue: boolean; daysToDeadline: number | null;
}

const startOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); };
const daysUntil = (iso?: string | null): number | null => {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
};

export default function CompanyHealthPanel({ onClose }: { onClose: () => void }) {
  const tenantsQ = useQuery({
    queryKey: ['tenants'],
    queryFn: async () => { const r = await tenantApi.list(); return r.data.data as Tenant[]; },
  });
  const visitsQ = useQuery({
    queryKey: ['analytics', 30],
    queryFn: async () => { const r = await analyticsApi.stats(30); return r.data.data as Vis; },
  });
  const opsQ = useQuery({
    queryKey: ['ops-metrics'],
    queryFn: async () => { const r = await tenantApi.opsMetrics(); return r.data.data as OpsMetrics; },
  });
  const cardsQ = useQuery({
    queryKey: ['ops-cards'],
    queryFn: async () => { const r = await tenantApi.opsCards(); return r.data.data as OpsCard[]; },
  });

  const tenants = tenantsQ.data ?? [];
  const loading = tenantsQ.isLoading;
  const refetchAll = () => { tenantsQ.refetch(); visitsQ.refetch(); };
  const fetching = tenantsQ.isFetching || visitsQ.isFetching;

  // مؤشّرات النمو والمنتج (مشتقّة من بيانات الشركات الحقيقية)
  const total = tenants.length;
  const active = tenants.filter(t => t.isActive).length;
  const inactive = total - active;
  const som = startOfMonth();
  const newThisMonth = tenants.filter(t => new Date(t.createdAt) >= som).length;
  const activated = tenants.filter(t => (t._count?.invoices ?? 0) > 0).length; // أصدرت أول فاتورة
  const activationRate = total ? Math.round((activated / total) * 100) : 0;

  // إشارات الاشتراك (تنبيهات التجديد — يغذّي BR-FIN-2)
  const expiringSoon = tenants.filter(t => { const d = daysUntil(t.subscriptionEndsAt); return d !== null && d >= 0 && d <= 7; });
  const expired = tenants.filter(t => { const d = daysUntil(t.subscriptionEndsAt); return d !== null && d < 0; });

  // إجماليات المنصّة
  const totalReps = tenants.reduce((s, t) => s + (t._count?.salesReps ?? 0), 0);
  const totalCustomers = tenants.reduce((s, t) => s + (t._count?.customers ?? 0), 0);
  const totalInvoices = tenants.reduce((s, t) => s + (t._count?.invoices ?? 0), 0);

  // صحّة التشغيل: نجاح جلب البيانات = الـAPI وقاعدة البيانات يستجيبان
  const apiUp = !tenantsQ.isError;
  const analyticsUp = !visitsQ.isError && !!visitsQ.data;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" {...backdropClose(onClose)}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        {/* الترويسة */}
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3] sticky top-0 bg-white rounded-t-2xl z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#FBEBE2] rounded-xl flex items-center justify-center"><HeartPulse size={20} className="text-[#E15A30]" /></div>
            <div>
              <h2 className="text-lg font-bold text-[#1F1A13]">صحة الشركة</h2>
              <p className="text-xs text-[#6E6557]">نظرة موحدة نمو منتج اشتراكات تشغيل</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={refetchAll} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500" title="تحديث">
              <RefreshCw size={15} className={fetching ? 'animate-spin' : ''} />
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
          </div>
        </div>

        {loading ? (
          <div className="py-20 text-center text-gray-400">جار تجميع مؤشرات صحة الشركة</div>
        ) : (
          <div className="p-5 space-y-5">
            {/* النجم الشمالي */}
            <div className="bg-gradient-to-l from-[#FBEBE2] to-[#FAF7F0] border border-[#E9E1D3] rounded-2xl p-5 flex items-center justify-between">
              <div>
                <p className="text-xs text-[#6E6557] flex items-center gap-1.5"><Sparkles size={13} className="text-[#E15A30]" /> النجم الشمالي</p>
                <p className="text-3xl font-bold text-[#E15A30] mt-1">{active}<span className="text-base font-semibold text-[#6E6557] mr-2">شركة نشطة</span></p>
              </div>
              <div className="text-left">
                <p className="text-xs text-[#6E6557]">من إجمالي {total}</p>
                <p className="text-xs text-[#1E7A52] font-semibold mt-1">+{newThisMonth} هذا الشهر</p>
              </div>
            </div>

            {/* مؤشّرات المنتج والنمو */}
            <div>
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><TrendingUp size={15} className="text-[#E15A30]" /> النمو والمنتج</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi icon={Building2} value={String(total)} label="إجمالي الشركات" color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
                <Kpi icon={CheckCircle2} value={`${activationRate}%`} label={`تفعيل (${activated} أصدرت فاتورة)`} color="text-[#1E7A52]" bg="bg-green-50" />
                <Kpi icon={Globe2} value={String(visitsQ.data?.uniques ?? '—')} label="زائر فريد / 30 يوما" color="text-[#E0A02C]" bg="bg-[#FBF0D8]" />
                <Kpi icon={TrendingUp} value={String(visitsQ.data?.total ?? '—')} label="زيارة / 30 يوما" color="text-[#6E6557]" bg="bg-[#EDE7DB]" />
              </div>
            </div>

            {/* الإيراد التقديري — عدّاد MRR من جدول الشركات (خطة فجوة التنفيذ) */}
            <div>
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><TrendingUp size={15} className="text-[#1E7A52]" /> الإيراد التقديري MRR</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi icon={TrendingUp} value={opsQ.data ? `${opsQ.data.mrrEstimate.toLocaleString('ar-EG')} ر.س` : '—'} label="MRR تقديري / شهر" color="text-[#1E7A52]" bg="bg-green-50" />
                <Kpi icon={Building2} value={String(opsQ.data?.activeNotExpired ?? '—')} label="اشتراك سار يشمل التجارب" color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
                <Kpi icon={AlertTriangle} value={String(opsQ.data?.expired30d ?? '—')} label="انتهى آخر 30 يوما إشارة انسحاب" color="text-[#C0392B]" bg="bg-red-50" />
                <Kpi icon={Sparkles} value={String(opsQ.data?.new30d ?? '—')} label="جديدة آخر 30 يوما" color="text-[#E0A02C]" bg="bg-[#FBF0D8]" />
              </div>
              <p className="text-[11px] text-[#9A8F7E] mt-2 leading-relaxed">
                تقدير نظري الاشتراكات السارية × سعر الباقة المعتمد 299/599 يشمل التجارب النشطة ولا يعكس تحصيلا فعليا
                {opsQ.data && opsQ.data.unpricedPlans > 0 ? ` (${opsQ.data.unpricedPlans} شركة بباقة بلا سعر معتمد غير محسوبة)` : ''}
              </p>
            </div>

            {/* فجوة التنفيذ — بطاقات قرار المالك */}
            <div>
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Clock size={15} className="text-[#C0392B]" /> فجوة التنفيذ بطاقات القرار</h3>
              <div className="grid grid-cols-2 gap-3">
                <Kpi icon={FileText} value={String(cardsQ.data?.length ?? '—')} label="بطاقة مفتوحة" color="text-[#6E6557]" bg="bg-[#EDE7DB]" />
                <Kpi icon={AlertTriangle} value={String(cardsQ.data?.filter(c => c.overdue).length ?? '—')} label="متأخرة عن مهلتها الهدف 0" color="text-[#C0392B]" bg="bg-red-50" />
              </div>
              {(cardsQ.data?.length ?? 0) > 0 && (
                <div className="mt-3 bg-white border border-[#E9E1D3] rounded-2xl divide-y divide-[#F1EBDF]">
                  {cardsQ.data!.slice(0, 6).map(c => (
                    <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                      <span className="text-[#1F1A13] font-medium truncate">{c.title}</span>
                      <span className={`text-xs font-semibold shrink-0 ${c.overdue ? 'text-[#C0392B]' : 'text-[#E0A02C]'}`}>
                        {c.daysToDeadline !== null
                          ? (c.daysToDeadline >= 0 ? `مهلة ${c.daysToDeadline} يوم` : `فاتت منذ ${-c.daysToDeadline} يوم`)
                          : `${c.daysOpen} يوما`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={async () => { try { await tenantApi.sendWeeklyReport(); alert('أرسل التقرير الأسبوعي إلى بريد المنصة'); } catch { alert('تعذر الإرسال تحقق من إعداد البريد'); } }}
                className="mt-3 text-xs font-semibold text-[#1E7A52] hover:underline"
              >إرسال التقرير الأسبوعي الآن ←</button>
            </div>

            {/* الاشتراكات والتنبيهات */}
            <div>
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Clock size={15} className="text-[#E15A30]" /> الاشتراكات</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Kpi icon={CheckCircle2} value={String(active)} label="اشتراك نشط" color="text-[#1E7A52]" bg="bg-green-50" />
                <Kpi icon={AlertTriangle} value={String(expiringSoon.length)} label="ينتهي خلال 7 أيام" color="text-[#E0A02C]" bg="bg-[#FBF0D8]" />
                <Kpi icon={AlertTriangle} value={String(expired.length)} label="منته / متأخر" color="text-[#C0392B]" bg="bg-red-50" />
                <Kpi icon={Power} value={String(inactive)} label="موقوف" color="text-[#6E6557]" bg="bg-[#EDE7DB]" />
              </div>
              {(expiringSoon.length > 0 || expired.length > 0) && (
                <div className="mt-3 bg-white border border-[#E9E1D3] rounded-2xl divide-y divide-[#F1EBDF]">
                  {[...expired, ...expiringSoon].slice(0, 6).map(t => {
                    const d = daysUntil(t.subscriptionEndsAt)!;
                    const over = d < 0;
                    return (
                      <div key={t.id} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                        <span className="text-[#1F1A13] font-medium truncate">{t.name}</span>
                        <span className={`text-xs font-semibold shrink-0 ${over ? 'text-[#C0392B]' : 'text-[#E0A02C]'}`}>
                          {over ? `متأخر ${Math.abs(d)} يوم` : `ينتهي خلال ${d} يوم`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* إجماليات المنصّة */}
            <div>
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Users size={15} className="text-[#E15A30]" /> إجماليات المنصة</h3>
              <div className="grid grid-cols-3 gap-3">
                <Kpi icon={Users} value={String(totalReps)} label="مندوب" color="text-[#E15A30]" bg="bg-[#FBEBE2]" />
                <Kpi icon={Building2} value={String(totalCustomers)} label="عميل" color="text-[#1E7A52]" bg="bg-green-50" />
                <Kpi icon={FileText} value={String(totalInvoices)} label="فاتورة" color="text-[#E0A02C]" bg="bg-[#FBF0D8]" />
              </div>
            </div>

            {/* صحّة التشغيل */}
            <div>
              <h3 className="text-sm font-bold text-[#1F1A13] mb-3 flex items-center gap-2"><Activity size={15} className="text-[#E15A30]" /> التشغيل</h3>
              <div className="grid grid-cols-2 gap-3">
                <HealthRow ok={apiUp} label="الAPI وقاعدة البيانات" okText="يستجيبان" badText="لا يستجيبان" />
                <HealthRow ok={analyticsUp} label="خدمة التحليلات" okText="تعمل" badText="غير متاحة" />
              </div>
            </div>

            <p className="text-[11px] text-[#9A8F7E] text-center leading-relaxed">
              مجمعة من المصادر القائمة الشركات + التحليلات + بطاقات القرار بلا تخزين إضافي 
              تقرير أسبوعي آلي يصل بريد المنصة كل اثنين 8 صباحا وتذكير يومي عند وجود بطاقات متأخرة 
              صحة التشغيل مشتقة من نجاح استجابة الخدمات
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ icon: Icon, value, label, color, bg }: { icon: React.ElementType; value: string; label: string; color: string; bg: string }) {
  return (
    <div className="bg-white rounded-xl p-3.5 border border-[#E9E1D3]">
      <div className={`w-9 h-9 ${bg} rounded-lg flex items-center justify-center mb-2`}><Icon size={17} className={color} /></div>
      <p className={`text-lg font-bold ${color} truncate`}>{value}</p>
      <p className="text-[11px] text-[#6E6557] mt-0.5 leading-tight">{label}</p>
    </div>
  );
}

function HealthRow({ ok, label, okText, badText }: { ok: boolean; label: string; okText: string; badText: string }) {
  return (
    <div className={`rounded-xl p-3.5 border flex items-center gap-3 ${ok ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
      <div className={`w-2.5 h-2.5 rounded-full ${ok ? 'bg-[#1E7A52]' : 'bg-[#C0392B]'} ${ok ? 'animate-pulse' : ''}`} />
      <div>
        <p className="text-[13px] font-semibold text-[#1F1A13]">{label}</p>
        <p className={`text-[11px] ${ok ? 'text-[#1E7A52]' : 'text-[#C0392B]'}`}>{ok ? okText : badText}</p>
      </div>
    </div>
  );
}
