import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Plus, Minus, Trash2, X, Check, ArrowRight, Store, ShoppingBag, UtensilsCrossed, LogOut, Receipt } from 'lucide-react';
import toast from 'react-hot-toast';
import { restaurantApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { BrandIcon } from '../../components/BrandLogo';
import type { MenuCategory, MenuItem, ModifierGroup, RestaurantTable } from '../../types';

const money = (n: number) => `${(Math.round(n * 100) / 100).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ر.س`;

interface CartMod { id: string; name: string; priceDelta: number; }
interface CartLine { key: string; menuItemId: string; name: string; basePrice: number; taxPct: number; qty: number; mods: CartMod[]; }
const unitPrice = (l: CartLine) => l.basePrice + l.mods.reduce((s, m) => s + m.priceDelta, 0);

export default function PosScreen() {
  const { user, logout } = useAuthStore();
  const [cart, setCart] = useState<CartLine[]>([]);
  const [catId, setCatId] = useState<string>('all');
  const [channel, setChannel] = useState<'DINE_IN' | 'TAKEAWAY'>('DINE_IN');
  const [tableId, setTableId] = useState<string>('');
  const [modPick, setModPick] = useState<MenuItem | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  const [receipt, setReceipt] = useState<{ number: string; total: number } | null>(null);

  const { data: menu } = useQuery({
    queryKey: ['resto-menu'],
    queryFn: async () => (await restaurantApi.menu()).data.data as { categories: MenuCategory[]; groups: ModifierGroup[] },
  });
  const { data: tablesData } = useQuery({
    queryKey: ['resto-tables'],
    queryFn: async () => (await restaurantApi.tables()).data.data as { tables: RestaurantTable[] },
  });
  const groups = useMemo(() => new Map((menu?.groups ?? []).map(g => [g.id, g])), [menu]);
  const categories = menu?.categories ?? [];
  const allItems = categories.flatMap(c => (c.items ?? []).map(it => ({ ...it, categoryId: it.categoryId ?? c.id })));
  const items = (catId === 'all' ? allItems : allItems.filter(it => it.categoryId === catId)).filter(it => it.isAvailable !== false);

  const subtotal = cart.reduce((s, l) => s + l.qty * unitPrice(l), 0);
  const taxAmt = cart.reduce((s, l) => s + l.qty * unitPrice(l) * (l.taxPct ?? 0) / 100, 0);
  const total = subtotal + taxAmt;

  const addItem = (it: MenuItem) => {
    if (it.modifierGroups?.length) { setModPick(it); return; }
    pushLine(it, []);
  };
  const pushLine = (it: MenuItem, mods: CartMod[]) => {
    const modKey = mods.map(m => m.id).sort().join(',');
    setCart(c => {
      const found = c.find(l => l.menuItemId === it.id && l.mods.map(m => m.id).sort().join(',') === modKey);
      if (found) return c.map(l => l === found ? { ...l, qty: l.qty + 1 } : l);
      return [...c, { key: `${it.id}-${modKey}-${c.length}`, menuItemId: it.id, name: it.name, basePrice: it.basePrice, taxPct: it.taxPct ?? 15, qty: 1, mods }];
    });
  };
  const setQty = (key: string, d: number) => setCart(c => c.flatMap(l => l.key === key ? (l.qty + d <= 0 ? [] : [{ ...l, qty: l.qty + d }]) : [l]));

  const payMut = useMutation({
    mutationFn: async (payments: { method: string; amount: number; tendered?: number }[]) => {
      const created = await restaurantApi.createOrder({
        channel, tableId: channel === 'DINE_IN' ? (tableId || null) : null, guests: 1,
        items: cart.map(l => ({ menuItemId: l.menuItemId, qty: l.qty, modifierIds: l.mods.map(m => m.id) })),
      });
      const orderId = created.data.data.id as string;
      const res = await restaurantApi.payOrder(orderId, { payments });
      return res.data.data.invoice as { number: string; total: number };
    },
    onSuccess: (inv) => { setReceipt({ number: inv.number, total: inv.total }); setCart([]); setTableId(''); setPayOpen(false); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر إتمام الدفع'),
  });

  const handleLogout = () => { logout(); window.location.replace('/login'); };

  return (
    <div dir="rtl" className="h-screen flex flex-col bg-[#FAF7F0] overflow-hidden" style={{ fontFamily: "'IBM Plex Sans','IBM Plex Sans Arabic',sans-serif" }}>
      {/* شريط علوي */}
      <header className="flex items-center justify-between px-4 h-14 bg-[#1F1A13] text-white flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <BrandIcon size={30} radius={0.28} />
          <span className="font-bold"><span>Field</span><span className="text-[#E15A30]"> Restaurant</span> <span className="text-[#9A8F7E] text-sm">· الكاشير</span></span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#9A8F7E] hidden sm:block">{user?.companyName}</span>
          <a href="/app-r" className="text-xs bg-white/10 hover:bg-white/20 rounded-lg px-3 py-1.5 flex items-center gap-1"><ArrowRight size={13} /> اللوحة</a>
          <button onClick={handleLogout} className="text-red-300 hover:bg-red-500/20 rounded-lg p-1.5"><LogOut size={16} /></button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* القائمة */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* الأقسام */}
          <div className="flex gap-2 p-3 overflow-x-auto flex-shrink-0 border-b border-[#E9E1D3]">
            <Tab active={catId === 'all'} onClick={() => setCatId('all')}>الكل</Tab>
            {categories.map(c => <Tab key={c.id} active={catId === c.id} onClick={() => setCatId(c.id)}>{c.name}</Tab>)}
          </div>
          {/* شبكة الأصناف */}
          <div className="flex-1 overflow-y-auto p-3">
            {items.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-400">
                <UtensilsCrossed size={32} className="mb-2" /> لا أصناف — أضف القائمة من اللوحة
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {items.map(it => (
                  <button key={it.id} onClick={() => addItem(it)}
                    className="bg-white rounded-xl border border-[#E9E1D3] p-3 text-right hover:border-[#E15A30] hover:shadow-md transition-all min-h-[84px] flex flex-col justify-between">
                    <span className="font-bold text-sm text-[#1F1A13] leading-tight">{it.name}</span>
                    <span className="text-[#E15A30] font-bold text-sm mt-1">{money(it.basePrice)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* عربة الطلب */}
        <aside className="w-[340px] flex-shrink-0 bg-white border-r border-[#E9E1D3] flex flex-col">
          {/* نوع الطلب */}
          <div className="p-3 border-b border-[#E9E1D3] space-y-2">
            <div className="flex gap-2">
              <TypeBtn active={channel === 'DINE_IN'} onClick={() => setChannel('DINE_IN')} icon={Store} label="صالة" />
              <TypeBtn active={channel === 'TAKEAWAY'} onClick={() => setChannel('TAKEAWAY')} icon={ShoppingBag} label="سفري" />
            </div>
            {channel === 'DINE_IN' && (
              <select className="input" value={tableId} onChange={e => setTableId(e.target.value)}>
                <option value="">اختر الطاولة (اختياري)</option>
                {(tablesData?.tables ?? []).map(t => <option key={t.id} value={t.id}>طاولة {t.number}</option>)}
              </select>
            )}
          </div>
          {/* البنود */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-300 text-sm"><Receipt size={28} className="mb-2" /> العربة فارغة</div>
            ) : cart.map(l => (
              <div key={l.key} className="bg-[#FAF7F0] rounded-xl p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-sm text-[#1F1A13] truncate">{l.name}</p>
                    {l.mods.length > 0 && <p className="text-[11px] text-[#9A8F7E] truncate">{l.mods.map(m => m.name).join('، ')}</p>}
                  </div>
                  <button onClick={() => setCart(c => c.filter(x => x.key !== l.key))} className="text-gray-400 hover:text-red-500"><Trash2 size={14} /></button>
                </div>
                <div className="flex items-center justify-between mt-1.5">
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setQty(l.key, -1)} className="w-7 h-7 rounded-lg bg-white border border-[#E9E1D3] flex items-center justify-center"><Minus size={13} /></button>
                    <span className="w-6 text-center font-bold text-sm">{l.qty}</span>
                    <button onClick={() => setQty(l.key, 1)} className="w-7 h-7 rounded-lg bg-white border border-[#E9E1D3] flex items-center justify-center"><Plus size={13} /></button>
                  </div>
                  <span className="font-bold text-sm text-[#1F1A13]">{money(l.qty * unitPrice(l))}</span>
                </div>
              </div>
            ))}
          </div>
          {/* الإجمالي والدفع */}
          <div className="p-3 border-t border-[#E9E1D3] space-y-1.5">
            <Row label="المجموع" value={money(subtotal)} />
            <Row label="ضريبة القيمة المضافة" value={money(taxAmt)} />
            <div className="flex items-center justify-between pt-1"><span className="font-bold">الإجمالي</span><span className="font-bold text-lg text-[#E15A30]">{money(total)}</span></div>
            <button disabled={cart.length === 0} onClick={() => setPayOpen(true)}
              className="w-full mt-1 bg-[#1E7A52] hover:bg-[#186845] disabled:bg-gray-300 text-white font-bold py-3 rounded-xl">دفع</button>
          </div>
        </aside>
      </div>

      {modPick && <ModifierPicker item={modPick} groups={groups} onClose={() => setModPick(null)} onAdd={mods => { pushLine(modPick, mods); setModPick(null); }} />}
      {payOpen && <PaymentModal total={total} loading={payMut.isPending} onClose={() => setPayOpen(false)} onPay={payments => payMut.mutate(payments)} />}
      {receipt && <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={`text-sm rounded-lg px-3.5 py-1.5 font-semibold whitespace-nowrap ${active ? 'bg-[#E15A30] text-white' : 'bg-white border border-[#E9E1D3] text-[#6E6557]'}`}>{children}</button>;
}
function TypeBtn({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: React.ElementType; label: string }) {
  return <button onClick={onClick} className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-semibold border ${active ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}><Icon size={15} /> {label}</button>;
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-sm text-[#6E6557]"><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}

// ---------- منتقي الإضافات ----------
function ModifierPicker({ item, groups, onClose, onAdd }: { item: MenuItem; groups: Map<string, ModifierGroup>; onClose: () => void; onAdd: (m: CartMod[]) => void }) {
  const itemGroups = (item.modifierGroups ?? []).map(g => groups.get(g.groupId)).filter((g): g is ModifierGroup => !!g);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const toggle = (g: ModifierGroup, modId: string) => {
    const multi = (g.maxSelect ?? 1) > 1;
    setSel(s => {
      const cur = s[g.id] ?? [];
      if (multi) return { ...s, [g.id]: cur.includes(modId) ? cur.filter(x => x !== modId) : [...cur, modId] };
      return { ...s, [g.id]: cur.includes(modId) ? [] : [modId] };
    });
  };
  const missing = itemGroups.find(g => (g.minSelect ?? 0) > 0 && (sel[g.id]?.length ?? 0) < 1);
  const confirm = () => {
    if (missing) { toast.error(`اختر «${missing.name}»`); return; }
    const mods: CartMod[] = [];
    for (const g of itemGroups) for (const id of (sel[g.id] ?? [])) {
      const m = g.modifiers?.find(x => x.id === id); if (m) mods.push({ id: m.id, name: m.name, priceDelta: m.priceDelta ?? 0 });
    }
    onAdd(mods);
  };
  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
        <h2 className="font-bold text-[#1F1A13]">{item.name}</h2>
        <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
      </div>
      <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {itemGroups.map(g => (
          <div key={g.id}>
            <p className="font-bold text-sm mb-2">{g.name} <span className="text-xs font-normal text-[#9A8F7E]">{(g.minSelect ?? 0) > 0 ? '(إلزامي)' : '(اختياري)'}</span></p>
            <div className="flex flex-wrap gap-2">
              {(g.modifiers ?? []).map(m => {
                const on = (sel[g.id] ?? []).includes(m.id);
                return (
                  <button key={m.id} onClick={() => toggle(g, m.id)}
                    className={`text-sm rounded-lg px-3 py-2 border ${on ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28] font-semibold' : 'border-[#E9E1D3] text-[#3a342b]'}`}>
                    {on && <Check size={13} className="inline ml-1" />}{m.name}{m.priceDelta ? <span className="text-[#E15A30]"> +{m.priceDelta}</span> : ''}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="p-4 border-t border-[#E9E1D3]"><button onClick={confirm} className="w-full btn-primary justify-center py-2.5">إضافة للطلب</button></div>
    </Overlay>
  );
}

// ---------- الدفع ----------
function PaymentModal({ total, loading, onClose, onPay }: { total: number; loading: boolean; onClose: () => void; onPay: (p: { method: string; amount: number; tendered?: number }[]) => void }) {
  const [method, setMethod] = useState<'CASH' | 'CARD'>('CASH');
  const [tendered, setTendered] = useState('');
  const change = method === 'CASH' && tendered ? Math.max(0, Number(tendered) - total) : 0;
  const submit = () => {
    if (method === 'CASH' && tendered && Number(tendered) < total) { toast.error('المبلغ المستلَم أقل من الإجمالي'); return; }
    onPay([{ method, amount: total, tendered: method === 'CASH' && tendered ? Number(tendered) : undefined }]);
  };
  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
        <h2 className="font-bold text-[#1F1A13]">الدفع — {money(total)}</h2>
        <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
      </div>
      <div className="p-4 space-y-4">
        <div className="flex gap-2">
          <TypeBtn active={method === 'CASH'} onClick={() => setMethod('CASH')} icon={Receipt} label="نقد" />
          <TypeBtn active={method === 'CARD'} onClick={() => setMethod('CARD')} icon={Check} label="بطاقة" />
        </div>
        {method === 'CASH' && (
          <div>
            <label className="label">المبلغ المستلَم</label>
            <input type="number" className="input text-lg" autoFocus value={tendered} onChange={e => setTendered(e.target.value)} placeholder={String(Math.ceil(total))} />
            {tendered && Number(tendered) >= total && (
              <div className="mt-2 flex items-center justify-between bg-[#EAF5EF] rounded-lg px-3 py-2">
                <span className="text-sm text-[#1F5C3F] font-semibold">الباقي</span>
                <span className="font-bold text-[#1E7A52]">{money(change)}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="p-4 border-t border-[#E9E1D3]">
        <button onClick={submit} disabled={loading} className="w-full bg-[#1E7A52] hover:bg-[#186845] disabled:opacity-60 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
          {loading ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={18} />} تأكيد الدفع وإصدار الفاتورة
        </button>
      </div>
    </Overlay>
  );
}

// ---------- الإيصال ----------
function ReceiptModal({ receipt, onClose }: { receipt: { number: string; total: number }; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className="p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#EAF5EF] flex items-center justify-center mx-auto mb-4"><Check size={32} className="text-[#1E7A52]" /></div>
        <h2 className="text-lg font-bold text-[#1F1A13]">تمّ الدفع بنجاح</h2>
        <p className="text-sm text-[#6E6557] mt-1">فاتورة رقم <span className="font-mono font-bold" dir="ltr">{receipt.number}</span></p>
        <p className="text-2xl font-bold text-[#E15A30] mt-3">{money(receipt.total)}</p>
        <button onClick={onClose} className="w-full mt-6 btn-primary justify-center py-3">طلب جديد</button>
      </div>
    </Overlay>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}
