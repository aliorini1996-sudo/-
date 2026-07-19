import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ScrollText, LayoutGrid, Boxes, UtensilsCrossed, Plus, ArrowLeft } from 'lucide-react';
import { restaurantApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import type { MenuCategory, ModifierGroup, RestaurantArea, RestaurantTable } from '../../types';

export default function RestaurantDashboard() {
  const { user } = useAuthStore();

  const { data: menu } = useQuery({
    queryKey: ['resto-menu'],
    queryFn: async () => (await restaurantApi.menu()).data.data as { categories: MenuCategory[]; groups: ModifierGroup[] },
  });
  const { data: tables } = useQuery({
    queryKey: ['resto-tables'],
    queryFn: async () => (await restaurantApi.tables()).data.data as { areas: RestaurantArea[]; tables: RestaurantTable[] },
  });

  const itemCount = (menu?.categories ?? []).reduce((s, c) => s + (c.items?.length ?? 0), 0);
  const stats = [
    { icon: ScrollText, label: 'الأقسام', value: menu?.categories.length ?? 0, color: '#E15A30' },
    { icon: UtensilsCrossed, label: 'الأصناف', value: itemCount, color: '#1E7A52' },
    { icon: Boxes, label: 'مجموعات الإضافات', value: menu?.groups.length ?? 0, color: '#C94E28' },
    { icon: LayoutGrid, label: 'الطاولات', value: tables?.tables.length ?? 0, color: '#9A6A00' },
  ];

  const empty = (menu?.categories.length ?? 0) === 0 && (tables?.tables.length ?? 0) === 0;

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-2xl font-bold text-[#1F1A13]">لوحة المطعم</h1>
      </div>
      <p className="text-[#6E6557] text-sm mb-6">أهلاً {user?.name} — أدِر قائمة مطعمك وطاولاتك من هنا.</p>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map(s => (
          <div key={s.label} className="bg-white rounded-2xl p-4 flex items-center gap-3 border border-gray-100">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: s.color }}>
              <s.icon size={22} className="text-white" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#1F1A13]">{s.value}</p>
              <p className="text-xs text-[#6E6557]">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {empty ? (
        <div className="bg-white rounded-2xl border border-[#E9E1D3] p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#FBEBE2] flex items-center justify-center mx-auto mb-4">
            <UtensilsCrossed size={26} className="text-[#E15A30]" />
          </div>
          <h2 className="text-lg font-bold text-[#1F1A13]">ابدأ بإعداد مطعمك</h2>
          <p className="text-sm text-[#6E6557] mt-1 mb-5">أنشئ قائمتك (الأقسام والأصناف) وحدّد صالاتك وطاولاتك لتصبح جاهزاً للكاشير.</p>
          <div className="flex items-center justify-center gap-3">
            <Link to="/app-r/menu" className="btn-primary"><Plus size={16} /> أضف القائمة</Link>
            <Link to="/app-r/tables" className="btn-secondary"><Plus size={16} /> أضف الطاولات</Link>
          </div>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          <Link to="/app-r/menu" className="bg-white rounded-2xl border border-[#E9E1D3] p-5 hover:shadow-md transition-shadow flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-11 h-11 rounded-xl bg-[#FBEBE2] flex items-center justify-center"><ScrollText size={21} className="text-[#E15A30]" /></span>
              <div><p className="font-bold text-[#1F1A13]">القائمة</p><p className="text-xs text-[#6E6557]">الأقسام والأصناف والإضافات</p></div>
            </div>
            <ArrowLeft size={18} className="text-[#9A8F7E]" />
          </Link>
          <Link to="/app-r/tables" className="bg-white rounded-2xl border border-[#E9E1D3] p-5 hover:shadow-md transition-shadow flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-11 h-11 rounded-xl bg-[#EAF5EF] flex items-center justify-center"><LayoutGrid size={21} className="text-[#1E7A52]" /></span>
              <div><p className="font-bold text-[#1F1A13]">الصالات والطاولات</p><p className="text-xs text-[#6E6557]">تنظيم قاعة المطعم</p></div>
            </div>
            <ArrowLeft size={18} className="text-[#9A8F7E]" />
          </Link>
        </div>
      )}

      <p className="text-xs text-[#9A8F7E] mt-8 text-center">
        قريباً: الكاشير (POS)، تذاكر المطبخ، المحاسبة والتقارير — قيد الإنشاء.
      </p>
    </div>
  );
}
