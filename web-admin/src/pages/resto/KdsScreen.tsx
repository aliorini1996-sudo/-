import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChefHat, Check, Clock, ArrowRight, Store, ShoppingBag, Bike } from 'lucide-react';
import { restaurantApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { BrandIcon } from '../../components/BrandLogo';

// شاشة المطبخ (KDS) — تعرض التذاكر النشطة وتُحدَّث بالاستقصاء كل 8 ثوانٍ (بلا WebSocket في v1).
// البند: FIRED (في المطبخ) → READY (جاهز) → SERVED (قُدِّم، يختفي من الشاشة).

interface KdsItem { id: string; nameSnap: string; qty: number; station: string; note?: string | null; kotStatus: string; firedAt?: string | null; modifiers: { nameSnap: string }[] }
interface KdsOrder { id: string; number: number; channel: string; status: string; createdAt: string; table?: { number: string } | null; items: KdsItem[] }

const channelIcon = (c: string) => (c === 'DINE_IN' ? Store : c === 'DELIVERY' ? Bike : ShoppingBag);
const channelLabel = (c: string) => ({ DINE_IN: 'صالة', TAKEAWAY: 'سفري', DELIVERY: 'توصيل' } as Record<string, string>)[c] || c;
const stationLabel = (s: string) => ({ KITCHEN: 'المطبخ', GRILL: 'الشواء', BAR: 'البار', COLD: 'بارد' } as Record<string, string>)[s] || s;

// دقائق منذ الإرسال — تلوّن البطاقة حسب التأخّر
function minutesSince(iso?: string | null): number {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export default function KdsScreen() {
  const qc = useQueryClient();
  const isStaff = useAuthStore(s => s.user?.role) === 'SALES_REP'; // كاشير/نادل — لا لوحة إدارة له
  const { data, isLoading } = useQuery({
    queryKey: ['resto-kds'],
    queryFn: async () => (await restaurantApi.kds()).data.data as KdsOrder[],
    refetchInterval: 8000,        // استقصاء دوريّ — قرار v1
    refetchOnWindowFocus: true,
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['resto-kds'] });

  const itemMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => restaurantApi.itemStatus(id, status),
    onSuccess: invalidate,
  });
  const serveMut = useMutation({
    mutationFn: (id: string) => restaurantApi.serveOrder(id),
    onSuccess: invalidate,
  });

  const orders = data ?? [];

  return (
    <div dir="rtl" className="min-h-screen bg-[#1F1A13] text-white" style={{ fontFamily: "'IBM Plex Sans','IBM Plex Sans Arabic',sans-serif" }}>
      <header className="flex items-center justify-between px-4 h-14 border-b border-white/10 sticky top-0 bg-[#1F1A13] z-10">
        <div className="flex items-center gap-2.5">
          <BrandIcon size={30} radius={0.28} />
          <span className="font-bold flex items-center gap-2"><ChefHat size={18} className="text-[#E15A30]" /> شاشة المطبخ</span>
          <span className="text-xs text-[#9A8F7E]">{orders.length} تذكرة نشطة</span>
        </div>
        <div className="flex items-center gap-2">
          <a href="/pos" className="text-xs bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5 flex items-center gap-1"><ArrowRight size={13} /> الكاشير</a>
          {!isStaff && <a href="/app-r" className="text-xs bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5">اللوحة</a>}
        </div>
      </header>

      <div className="p-4">
        {isLoading ? (
          <div className="text-center py-24 text-[#9A8F7E]">جاري التحميل…</div>
        ) : orders.length === 0 ? (
          <div className="text-center py-24 text-[#9A8F7E]">
            <ChefHat size={40} className="mx-auto mb-3 opacity-50" />
            لا تذاكر في المطبخ الآن
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {orders.map(o => {
              const mins = minutesSince(o.items[0]?.firedAt ?? o.createdAt);
              const urgent = mins >= 15, warn = mins >= 8;
              const Icon = channelIcon(o.channel);
              const allReady = o.items.every(i => i.kotStatus === 'READY');
              return (
                <div key={o.id} className="rounded-2xl overflow-hidden bg-[#2C261D] border-2"
                  style={{ borderColor: urgent ? '#E15A30' : warn ? '#E4A11B' : '#3a342b' }}>
                  <div className="flex items-center justify-between px-3 py-2" style={{ background: urgent ? '#E15A30' : warn ? '#E4A11B' : '#3a342b' }}>
                    <span className="font-bold text-sm flex items-center gap-1.5">
                      <Icon size={14} /> #{o.number}{o.table?.number ? ` · طاولة ${o.table.number}` : ` · ${channelLabel(o.channel)}`}
                    </span>
                    <span className="text-xs flex items-center gap-1 font-semibold"><Clock size={12} /> {mins}د</span>
                  </div>
                  <div className="p-3 space-y-2">
                    {o.items.map(it => (
                      <button key={it.id}
                        onClick={() => itemMut.mutate({ id: it.id, status: it.kotStatus === 'READY' ? 'SERVED' : 'READY' })}
                        className={`w-full text-right rounded-xl px-3 py-2 transition-colors ${it.kotStatus === 'READY' ? 'bg-[#1E7A52]/25 border border-[#1E7A52]' : 'bg-white/5 hover:bg-white/10 border border-transparent'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-semibold text-sm">
                            {it.kotStatus === 'READY' && <Check size={13} className="inline ml-1 text-[#5FBE92]" />}
                            {it.nameSnap}
                          </span>
                          <span className="text-sm font-bold text-[#E15A30] shrink-0">×{it.qty}</span>
                        </div>
                        {it.modifiers.length > 0 && (
                          <p className="text-[11px] text-[#C9BEAC] mt-0.5">{it.modifiers.map(m => m.nameSnap).join('، ')}</p>
                        )}
                        {it.note && <p className="text-[11px] text-[#E4A11B] mt-0.5">ملاحظة: {it.note}</p>}
                        <p className="text-[10px] text-[#9A8F7E] mt-0.5">{stationLabel(it.station)}</p>
                      </button>
                    ))}
                    <button onClick={() => serveMut.mutate(o.id)}
                      className={`w-full py-2 rounded-xl text-sm font-bold ${allReady ? 'bg-[#1E7A52] hover:bg-[#186845]' : 'bg-white/10 hover:bg-white/20'}`}>
                      تمّ التقديم
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
