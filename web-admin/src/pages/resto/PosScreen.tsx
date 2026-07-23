import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Plus, Minus, Trash2, X, Check, ArrowRight, Store, ShoppingBag, UtensilsCrossed, LogOut, Receipt, Printer } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import toast from 'react-hot-toast';
import { restaurantApi } from '../../api/client';
import { useAuthStore } from '../../store/authStore';
import { BrandIcon } from '../../components/BrandLogo';
import type { MenuCategory, MenuItem, ModifierGroup, RestaurantTable } from '../../types';

// بيانات الإيصال للطباعة الحرارية (تأتي من استجابة الدفع)
interface ReceiptData {
  company?: { name?: string; taxNumber?: string | null; phone?: string | null; address?: string | null } | null;
  invoice: { number: string; total: number; subtotal?: number; taxAmt?: number; qr?: string; issuedAt?: string; einvoiceStatus?: string };
  items: { nameSnap: string; qty: number; unitPrice: number; lineTotal: number }[];
}

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
  // الطلب المُنشأ بانتظار الدفع — يحمل معرّفه وإجماليه المحسوب من الخادم (مصدر الحقيقة للمبلغ)
  const [pending, setPending] = useState<{ orderId: string; total: number } | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [shiftView, setShiftView] = useState<'open' | 'close' | null>(null);

  const { data: menu } = useQuery({
    queryKey: ['resto-menu'],
    queryFn: async () => (await restaurantApi.menu()).data.data as { categories: MenuCategory[]; items: MenuItem[]; groups: ModifierGroup[] },
  });
  const { data: tablesData } = useQuery({
    queryKey: ['resto-tables'],
    queryFn: async () => (await restaurantApi.tables()).data.data as { tables: RestaurantTable[] },
  });
  const { data: shift, refetch: refetchShift } = useQuery({
    queryKey: ['resto-shift'],
    queryFn: async () => (await restaurantApi.currentShift()).data.data as { id: string; openingFloat: number } | null,
  });
  const groups = useMemo(() => new Map((menu?.groups ?? []).map(g => [g.id, g])), [menu]);
  const categories = menu?.categories ?? [];
  const allItems = menu?.items ?? [];
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

  const errMsg = (e: unknown, fallback: string) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;

  // (1) إنشاء الطلب مرّة واحدة — يُعيد الخادم إجماليه الموثوق، ثم نفتح نافذة الدفع بذلك الإجمالي
  const createMut = useMutation({
    mutationFn: async () => {
      const created = await restaurantApi.createOrder({
        channel, tableId: channel === 'DINE_IN' ? (tableId || null) : null, guests: 1,
        items: cart.map(l => ({ menuItemId: l.menuItemId, qty: l.qty, modifierIds: l.mods.map(m => m.id) })),
      });
      const o = created.data.data as { id: string; total: number };
      return { orderId: o.id, total: o.total };
    },
    onSuccess: (p) => setPending(p),
    onError: (e) => toast.error(errMsg(e, 'تعذّر إنشاء الطلب')),
  });

  // (2) دفع الطلب المُنشأ نفسه — إعادة المحاولة عند الفشل تدفع الطلب ذاته (لا تُنشئ طلباً جديداً)
  const payMut = useMutation({
    mutationFn: async (payments: { method: string; amount: number; tendered?: number }[]) => {
      const res = await restaurantApi.payOrder(pending!.orderId, { payments });
      return res.data.data as { order?: { items?: ReceiptData['items'] }; invoice: ReceiptData['invoice']; company?: ReceiptData['company'] };
    },
    onSuccess: (d) => { setReceipt({ company: d.company, invoice: d.invoice, items: d.order?.items ?? [] }); setCart([]); setTableId(''); setPending(null); },
    onError: (e) => toast.error(errMsg(e, 'تعذّر إتمام الدفع')),
  });

  // (3) إلغاء الدفع → إلغاء الطلب المُنشأ (يحرّر الطاولة) فلا تتراكم طلبات يتيمة
  const voidMut = useMutation({
    mutationFn: () => restaurantApi.voidOrder(pending!.orderId, { reason: 'إلغاء من الكاشير' }),
    onSettled: () => setPending(null),
  });
  const cancelPay = () => { if (pending && !payMut.isPending) voidMut.mutate(); };

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
          <span className="text-xs text-[#9A8F7E] hidden md:block">{user?.companyName}</span>
          {shift ? (
            <button onClick={() => setShiftView('close')} className="text-xs bg-[#1E7A52]/20 text-[#7ED9A9] hover:bg-[#1E7A52]/30 rounded-lg px-3 py-1.5 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#5FBE92]" /> إغلاق الوردية
            </button>
          ) : (
            <button onClick={() => setShiftView('open')} className="text-xs bg-[#E15A30]/25 text-[#f0703f] hover:bg-[#E15A30]/35 rounded-lg px-3 py-1.5 font-semibold">فتح وردية</button>
          )}
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
            <button disabled={cart.length === 0 || createMut.isPending} onClick={() => createMut.mutate()}
              className="w-full mt-1 bg-[#1E7A52] hover:bg-[#186845] disabled:bg-gray-300 text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
              {createMut.isPending ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : 'دفع'}
            </button>
          </div>
        </aside>
      </div>

      {modPick && <ModifierPicker item={modPick} groups={groups} onClose={() => setModPick(null)} onAdd={mods => { pushLine(modPick, mods); setModPick(null); }} />}
      {pending && <PaymentModal total={pending.total} loading={payMut.isPending || voidMut.isPending} onClose={cancelPay} onPay={payments => payMut.mutate(payments)} />}
      {receipt && <ReceiptModal receipt={receipt} onClose={() => setReceipt(null)} />}
      {shiftView === 'open' && <OpenShiftModal onClose={() => setShiftView(null)} onDone={() => { setShiftView(null); refetchShift(); }} />}
      {shiftView === 'close' && shift && <CloseShiftModal shiftId={shift.id} onClose={() => setShiftView(null)} onDone={() => { setShiftView(null); refetchShift(); }} />}
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

// ---------- الإيصال + الطباعة الحرارية ----------
function ReceiptModal({ receipt, onClose }: { receipt: ReceiptData; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className="p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#EAF5EF] flex items-center justify-center mx-auto mb-4"><Check size={32} className="text-[#1E7A52]" /></div>
        <h2 className="text-lg font-bold text-[#1F1A13]">تمّ الدفع بنجاح</h2>
        <p className="text-sm text-[#6E6557] mt-1">فاتورة رقم <span className="font-mono font-bold" dir="ltr">{receipt.invoice.number}</span></p>
        <p className="text-2xl font-bold text-[#E15A30] mt-3">{money(receipt.invoice.total)}</p>
        <div className="flex gap-3 mt-6">
          <button onClick={() => window.print()} className="btn-secondary flex-1 justify-center py-3"><Printer size={17} /> طباعة الإيصال</button>
          <button onClick={onClose} className="btn-primary flex-1 justify-center py-3">طلب جديد</button>
        </div>
      </div>
      <ThermalReceipt receipt={receipt} />
    </Overlay>
  );
}

// إيصال حراري 80مم — يظهر عند الطباعة فقط (window.print) ويتضمّن رمز الفوترة الإلكترونية (ZATCA QR)
function ThermalReceipt({ receipt }: { receipt: ReceiptData }) {
  const { company, invoice, items } = receipt;
  const date = invoice.issuedAt ? new Date(invoice.issuedAt) : new Date();
  const line = (label: string, value: string, bold = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: bold ? 700 : 400, fontSize: bold ? 14 : 12 }}>
      <span>{label}</span><span dir="ltr">{value}</span>
    </div>
  );
  const dash = <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />;
  return (
    <>
      <style>{`
        .pos-print { display: none; }
        @media print {
          body * { visibility: hidden !important; }
          .pos-print, .pos-print * { visibility: visible !important; }
          .pos-print { display: block !important; position: fixed; top: 0; left: 0; right: 0; margin: 0 auto; width: 80mm; padding: 4mm; box-sizing: border-box; color: #000; }
          @page { size: 80mm auto; margin: 0; }
        }
      `}</style>
      <div className="pos-print" dir="rtl" style={{ fontFamily: "'IBM Plex Sans Arabic', sans-serif", fontSize: 12, lineHeight: 1.55 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{company?.name || 'مطعم'}</div>
          {company?.taxNumber ? <div>الرقم الضريبي: <span dir="ltr">{company.taxNumber}</span></div> : null}
          {company?.phone ? <div dir="ltr">{company.phone}</div> : null}
          {company?.address ? <div>{company.address}</div> : null}
        </div>
        {dash}
        <div style={{ textAlign: 'center', fontWeight: 700 }}>فاتورة ضريبية مبسّطة</div>
        {line('رقم الفاتورة', invoice.number)}
        {line('التاريخ', date.toLocaleString('ar-EG'))}
        {dash}
        {items.map((it, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{it.nameSnap} ×{it.qty}</span>
            <span dir="ltr">{money(it.qty * it.unitPrice)}</span>
          </div>
        ))}
        {dash}
        {invoice.subtotal != null ? line('المجموع قبل الضريبة', money(invoice.subtotal)) : null}
        {invoice.taxAmt != null ? line('ضريبة القيمة المضافة', money(invoice.taxAmt)) : null}
        {line('الإجمالي', money(invoice.total), true)}
        {invoice.qr ? (
          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <QRCodeSVG value={invoice.qr} size={120} level="M" />
            <div style={{ fontSize: 10, marginTop: 3 }}>فاتورة إلكترونية معتمدة — ZATCA</div>
          </div>
        ) : null}
        <div style={{ textAlign: 'center', marginTop: 10 }}>شكراً لزيارتكم</div>
      </div>
    </>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ---------- الورديات ودرج النقد (M4) ----------
const methodLabel = (m: string) => ({ CASH: 'نقد', CARD: 'بطاقة', WALLET: 'محفظة', ON_ACCOUNT: 'آجل' } as Record<string, string>)[m] || m;

function OpenShiftModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [floatAmt, setFloatAmt] = useState('');
  const mut = useMutation({
    mutationFn: () => restaurantApi.openShift({ openingFloat: Number(floatAmt) || 0 }),
    onSuccess: () => { toast.success('فُتحت الوردية'); onDone(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'تعذّر فتح الوردية'),
  });
  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
        <h2 className="font-bold text-[#1F1A13]">فتح وردية</h2>
        <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
      </div>
      <div className="p-5">
        <label className="label">النقد الافتتاحي في الدرج</label>
        <input type="number" min={0} className="input text-lg" autoFocus value={floatAmt} onChange={e => setFloatAmt(e.target.value)} placeholder="0.00" />
        <p className="text-xs text-[#9A8F7E] mt-1">المبلغ النقدي الموجود في الدرج عند بدء الوردية.</p>
      </div>
      <div className="p-4 border-t border-[#E9E1D3]">
        <button onClick={() => mut.mutate()} disabled={mut.isPending} className="w-full btn-primary justify-center py-3">
          {mut.isPending ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={17} />} فتح الوردية
        </button>
      </div>
    </Overlay>
  );
}

interface ZReport {
  shift: { openingFloat: number; expectedCash: number };
  salesTotal: number; netTotal: number; taxTotal: number; invoiceCount: number;
  byMethod: { method: string; amount: number }[];
}
function CloseShiftModal({ shiftId, onClose, onDone }: { shiftId: string; onClose: () => void; onDone: () => void }) {
  const { data: z } = useQuery({
    queryKey: ['resto-zreport', shiftId],
    queryFn: async () => (await restaurantApi.zReport(shiftId)).data.data as ZReport,
  });
  const [declared, setDeclared] = useState('');
  const expected = z?.shift?.expectedCash ?? 0;
  const variance = declared !== '' ? Math.round((Number(declared) - expected) * 100) / 100 : null;
  const mut = useMutation({
    mutationFn: () => restaurantApi.closeShift(shiftId, { declaredCash: Number(declared) || 0 }),
    onSuccess: () => { toast.success('أُغلقت الوردية'); onDone(); },
    onError: () => toast.error('تعذّر إغلاق الوردية'),
  });
  const stat = (label: string, value: string) => (
    <div className="bg-white rounded-xl border border-[#E9E1D3] p-3 text-center"><p className="text-base font-bold text-[#1F1A13]">{value}</p><p className="text-[11px] text-[#6E6557]">{label}</p></div>
  );
  return (
    <Overlay onClose={onClose}>
      <div className="flex items-center justify-between p-4 border-b border-[#E9E1D3]">
        <h2 className="font-bold text-[#1F1A13]">إغلاق الوردية — تقرير Z</h2>
        <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
      </div>
      <div className="p-5 space-y-3 max-h-[62vh] overflow-y-auto">
        {!z ? <div className="text-center py-6 text-gray-400">جاري التحميل…</div> : (
          <>
            <div className="grid grid-cols-2 gap-2">
              {stat('عدد الفواتير', String(z.invoiceCount))}
              {stat('إجمالي المبيعات', money(z.salesTotal))}
              {stat('صافي المبيعات', money(z.netTotal))}
              {stat('الضريبة', money(z.taxTotal))}
            </div>
            {z.byMethod.length > 0 && (
              <div className="bg-[#FAF7F0] rounded-xl p-3 border border-[#E9E1D3]">
                <p className="text-xs font-bold text-[#6E6557] mb-1.5">حسب طريقة الدفع</p>
                {z.byMethod.map(m => (<div key={m.method} className="flex justify-between text-sm"><span>{methodLabel(m.method)}</span><span className="font-semibold tabular-nums">{money(m.amount)}</span></div>))}
              </div>
            )}
            <div className="bg-[#FAF7F0] rounded-xl p-3 border border-[#E9E1D3] space-y-1 text-sm">
              <div className="flex justify-between"><span>النقد الافتتاحي</span><span className="tabular-nums">{money(z.shift.openingFloat)}</span></div>
              <div className="flex justify-between font-semibold"><span>النقد المتوقّع في الدرج</span><span className="tabular-nums">{money(expected)}</span></div>
            </div>
            <div>
              <label className="label">النقد المعدود فعلياً</label>
              <input type="number" min={0} className="input text-lg" autoFocus value={declared} onChange={e => setDeclared(e.target.value)} placeholder={String(expected)} />
              {variance !== null && (
                <div className={`mt-2 flex justify-between items-center rounded-lg px-3 py-2 ${variance === 0 ? 'bg-[#EAF5EF] text-[#1E7A52]' : variance < 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                  <span className="text-sm font-semibold">{variance === 0 ? 'مطابق ✓' : variance < 0 ? 'عجز في الدرج' : 'فائض في الدرج'}</span>
                  <span className="font-bold tabular-nums">{money(Math.abs(variance))}</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <div className="p-4 border-t border-[#E9E1D3] flex gap-3">
        <button onClick={() => mut.mutate()} disabled={mut.isPending || declared === ''} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
          {mut.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Check size={16} />} إغلاق الوردية
        </button>
        <button onClick={onClose} className="btn-secondary">إلغاء</button>
      </div>
    </Overlay>
  );
}
