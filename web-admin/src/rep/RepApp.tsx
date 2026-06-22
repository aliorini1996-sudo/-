import { useState, useEffect, useCallback } from 'react';
import repApi from './repApi';
import { formatCurrency, formatDate } from '../utils/format';
import { DocumentResult, invoiceDocFromDetail, receiptDocFromDetail, statementDocFromData, InvoiceDoc, ReceiptDoc, StatementDoc, Company } from './RepDocuments';
import {
  TrendingUp, Eye, EyeOff, Home, FileText, CreditCard, Users,
  Search, Plus, Trash2, ArrowRight, LogOut, RefreshCw, Receipt as ReceiptIcon,
  User, Wallet, FileDown, FileBarChart2, RotateCcw, Image as ImageIcon,
} from 'lucide-react';

type Screen = 'home' | 'invoices' | 'receipts' | 'customers';
type Modal = null | 'customerDetail' | 'createInvoice' | 'createReceipt' | 'createReturn' | 'addCustomer';

interface RepUser { id: string; name: string; phone?: string; canAddCustomer?: boolean }

// ============ تسجيل الدخول ============
function RepLogin({ onLogin }: { onLogin: (token: string, user: RepUser) => void }) {
  const [username, setUsername] = useState('rep1');
  const [password, setPassword] = useState('rep123');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await repApi.post('/auth/login', { username, password, role: 'sales_rep' });
      onLogin(res.data.data.token, res.data.data.user);
    } catch {
      setError('بيانات الدخول غير صحيحة');
    } finally { setLoading(false); }
  };

  return (
    <div className="h-full bg-gradient-to-b from-blue-900 via-blue-800 to-blue-600 flex flex-col items-center justify-center px-6">
      <div className="w-16 h-16 bg-white/20 rounded-3xl flex items-center justify-center mb-3">
        <TrendingUp size={36} className="text-white" />
      </div>
      <h1 className="text-white text-xl font-bold">نظام المبيعات الميداني</h1>
      <p className="text-blue-200 text-xs mb-8">DSD Sales System</p>

      <form onSubmit={submit} className="w-full bg-white rounded-3xl p-6 shadow-2xl">
        <h2 className="font-bold text-blue-900 mb-5">تسجيل الدخول</h2>
        <div className="space-y-3">
          <div className="relative">
            <User size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input className="input pr-9" placeholder="اسم المستخدم" dir="ltr"
              value={username} onChange={e => setUsername(e.target.value)} />
          </div>
          <div className="relative">
            <input className="input pr-3 pl-9" type={showPass ? 'text' : 'password'} placeholder="كلمة المرور" dir="ltr"
              value={password} onChange={e => setPassword(e.target.value)} />
            <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              onClick={() => setShowPass(s => !s)}>
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        {error && <p className="text-red-500 text-xs mt-2">{error}</p>}
        <button type="submit" disabled={loading}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-xl mt-5 flex items-center justify-center gap-2 disabled:bg-blue-400">
          {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
          دخول
        </button>
        <div className="mt-4 p-2.5 bg-blue-50 rounded-lg text-[11px] text-blue-700">
          تجريبي: <b>rep1</b> / <b>rep123</b>
        </div>
      </form>
    </div>
  );
}

// ============ الرئيسية ============
function RepHome({ user, onQuick }: { user: RepUser; onQuick: (s: Screen) => void }) {
  const [stats, setStats] = useState({ salesTotal: 0, collectTotal: 0, invCount: 0, rcpCount: 0 });
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setSyncing(true);
    try {
      // حدود "اليوم" بالتوقيت المحلي للمندوب (وليس UTC) حتى لا تُحتسب فاتورة الفجر ضمن أمس
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(); end.setHours(23, 59, 59, 999);
      const isToday = (iso: string) => { const d = new Date(iso); return d >= start && d <= end; };

      const [inv, rcp] = await Promise.all([
        repApi.get('/invoices', { params: { limit: 200, status: 'CONFIRMED' } }),
        repApi.get('/receipts', { params: { limit: 200 } }),
      ]);
      const invoices = inv.data.data as { total: number; invoiceDate: string; type: string }[];
      const receipts = rcp.data.data as { amount: number; receiptDate: string }[];
      const todayRcp = receipts.filter(r => isToday(r.receiptDate));
      // مبيعات اليوم: فواتير البيع فقط (تُستثنى فواتير الإرجاع)
      const todaySales = invoices.filter(i => isToday(i.invoiceDate) && i.type !== 'RETURN');
      setStats({
        salesTotal: todaySales.reduce((s, i) => s + Number(i.total), 0),
        collectTotal: todayRcp.reduce((s, r) => s + Number(r.amount), 0),
        invCount: todaySales.length,
        rcpCount: todayRcp.length,
      });
    } catch { /* offline */ }
    setSyncing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stat = (label: string, value: string, icon: React.ElementType, color: string, bg: string) => {
    const Icon = icon;
    return (
      <div className={`${bg} rounded-2xl p-4 border`}>
        <Icon size={20} className={color} />
        <p className={`text-base font-bold mt-2 ${color}`}>{value}</p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    );
  };

  const quick = (label: string, icon: React.ElementType, color: string, bg: string, target: Screen) => {
    const Icon = icon;
    return (
      <button onClick={() => onQuick(target)} className={`${bg} rounded-2xl py-4 flex flex-col items-center gap-1.5 border`}>
        <Icon size={26} className={color} />
        <span className={`text-xs font-semibold ${color}`}>{label}</span>
      </button>
    );
  };

  return (
    <div className="p-4 space-y-5 overflow-y-auto h-full pb-24">
      {/* Greeting */}
      <div className="bg-gradient-to-l from-blue-900 to-blue-600 rounded-3xl p-5 flex items-center justify-between">
        <div>
          <p className="text-blue-200 text-xs">مرحباً،</p>
          <p className="text-white text-lg font-bold">{user.name}</p>
          {syncing && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              <span className="text-blue-200 text-[11px]">مزامنة...</span>
            </div>
          )}
        </div>
        <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
          <User size={22} className="text-white" />
        </div>
      </div>

      {/* Stats */}
      <div>
        <p className="text-blue-900 font-bold text-sm mb-3">إحصائيات اليوم</p>
        <div className="grid grid-cols-2 gap-3">
          {stat('المبيعات', formatCurrency(stats.salesTotal), TrendingUp, 'text-blue-600', 'bg-blue-50 border-blue-100')}
          {stat('التحصيل', formatCurrency(stats.collectTotal), Wallet, 'text-green-600', 'bg-green-50 border-green-100')}
          {stat('الفواتير', String(stats.invCount), FileText, 'text-orange-600', 'bg-orange-50 border-orange-100')}
          {stat('سندات القبض', String(stats.rcpCount), CreditCard, 'text-purple-600', 'bg-purple-50 border-purple-100')}
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <p className="text-blue-900 font-bold text-sm mb-3">إجراءات سريعة</p>
        <div className="grid grid-cols-3 gap-3">
          {quick('فاتورة', FileText, 'text-blue-600', 'bg-blue-50 border-blue-100', 'invoices')}
          {quick('سند قبض', CreditCard, 'text-green-600', 'bg-green-50 border-green-100', 'receipts')}
          {quick('العملاء', Users, 'text-orange-600', 'bg-orange-50 border-orange-100', 'customers')}
        </div>
      </div>
    </div>
  );
}

// ============ قائمة العملاء ============
function RepCustomers({ onSelect, canAdd, onAdd }: { onSelect: (c: any) => void; canAdd: boolean; onAdd: () => void }) {
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await repApi.get('/customers', { params: { search, limit: 30 } });
        setCustomers(res.data.data);
      } catch { /* */ }
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className="input pr-9" placeholder="بحث عن عميل..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {canAdd && (
          <button onClick={onAdd} title="إضافة عميل"
            className="flex-shrink-0 w-10 h-10 bg-blue-600 hover:bg-blue-700 text-white rounded-xl flex items-center justify-center">
            <Plus size={20} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-24">
        {loading ? (
          <div className="text-center text-gray-400 py-10 text-sm">جاري التحميل...</div>
        ) : customers.length === 0 ? (
          <div className="text-center text-gray-400 py-10 text-sm">لا توجد نتائج</div>
        ) : customers.map(c => (
          <button key={c.id} onClick={() => onSelect(c)}
            className="w-full flex items-center gap-3 bg-white rounded-2xl p-3 mb-2 border border-gray-100 text-right hover:border-blue-200">
            <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold flex-shrink-0">
              {c.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-800 text-sm truncate">{c.name}</p>
              <p className="text-xs text-gray-400">{c.phone} • {c.city || ''}</p>
            </div>
            <div className="text-left">
              <p className={`text-sm font-bold ${Number(c.balance) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {formatCurrency(c.balance)}
              </p>
              <p className="text-[10px] text-gray-400">الرصيد</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ============ تفاصيل العميل ============
function CustomerDetail({ customer, repName, company, onClose, onInvoice, onReceipt, onReturn, onStatement }: {
  customer: any; repName: string; company: Company | null;
  onClose: () => void; onInvoice: () => void; onReceipt: () => void; onReturn: () => void;
  onStatement: (doc: StatementDoc) => void;
}) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await repApi.get(`/customers/${customer.id}/statement`);
        setEntries(res.data.data.entries);
      } catch { /* */ }
      setLoading(false);
    })();
  }, [customer.id]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-blue-900 text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">{customer.name}</span>
      </div>

      <div className="p-4 overflow-y-auto flex-1 pb-4">
        {/* Summary */}
        <div className="bg-gradient-to-l from-blue-900 to-blue-600 rounded-3xl p-5 text-white">
          <p className="font-bold text-lg">{customer.name}</p>
          {customer.businessName && <p className="text-blue-200 text-sm">{customer.businessName}</p>}
          <p className="text-blue-200 text-xs mb-4">{customer.phone}</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className={`font-bold text-sm ${Number(customer.balance) > 0 ? 'text-red-300' : 'text-green-300'}`}>{formatCurrency(customer.balance)}</p>
              <p className="text-blue-200 text-[10px]">الرصيد</p>
            </div>
            <div>
              <p className="font-bold text-sm">{formatCurrency(customer.creditLimit)}</p>
              <p className="text-blue-200 text-[10px]">الحد الائتماني</p>
            </div>
            <div>
              <p className="font-bold text-sm">{customer.paymentDays} يوم</p>
              <p className="text-blue-200 text-[10px]">فترة السداد</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button onClick={onInvoice} className="bg-blue-600 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <FileText size={16} /> فاتورة جديدة
          </button>
          <button onClick={onReceipt} className="bg-green-600 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <CreditCard size={16} /> سند قبض
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <button onClick={onReturn} className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <RotateCcw size={16} /> فاتورة إرجاع
          </button>
          <button
            onClick={() => onStatement(statementDocFromData(customer, entries, repName, company))}
            disabled={loading}
            className="bg-slate-700 hover:bg-slate-800 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60">
            <FileBarChart2 size={16} /> كشف حساب
          </button>
        </div>

        {/* Statement */}
        <p className="font-bold text-gray-700 text-sm mt-5 mb-2">كشف الحساب</p>
        {loading ? (
          <p className="text-center text-gray-400 py-6 text-sm">جاري التحميل...</p>
        ) : entries.length === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">لا توجد حركات</p>
        ) : entries.map(e => {
          const isDebit = Number(e.debit) > 0;
          return (
            <div key={e.id} className="bg-white rounded-xl p-3 mb-2 border border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center ${isDebit ? 'bg-red-50 text-red-500' : 'bg-green-50 text-green-500'}`}>
                  {isDebit ? '↑' : '↓'}
                </span>
                <div>
                  <p className="text-xs font-medium text-gray-700">{e.description}</p>
                  <p className="text-[10px] text-gray-400">{formatDate(e.entryDate)}</p>
                </div>
              </div>
              <div className="text-left">
                <p className={`text-xs font-bold ${isDebit ? 'text-red-600' : 'text-green-600'}`}>
                  {isDebit ? formatCurrency(e.debit) : formatCurrency(e.credit)}
                </p>
                <p className="text-[10px] text-gray-400">رصيد: {formatCurrency(e.balance)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ إنشاء فاتورة (بيع أو إرجاع) ============
function CreateInvoice({ customer, repName, company, mode = 'sale', onClose, onDone }: { customer: any; repName: string; company: Company | null; mode?: 'sale' | 'return'; onClose: () => void; onDone: (doc: InvoiceDoc) => void }) {
  const isReturn = mode === 'return';
  const [type, setType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<any[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [lines, setLines] = useState<any[]>([]);
  const [showCart, setShowCart] = useState(false); // عرض الأصناف المختارة للمراجعة قبل الإصدار
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  // جلب المنتجات كشبكة أيقونات (مصفّاة بالبحث) — أسلوب نقطة البيع
  useEffect(() => {
    const t = setTimeout(async () => {
      setLoadingProducts(true);
      try {
        const res = await repApi.get('/products', { params: { search: search || undefined, status: 'ACTIVE', limit: 60 } });
        setProducts(res.data.data);
      } catch { /* */ }
      setLoadingProducts(false);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  // السعر الذي يُدخله المندوب شامل الضريبة؛ نشتقّ السعر قبل الضريبة للنظام
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const preTax = (l: any) => l.unitPrice / (1 + l.taxPct / 100);
  const lineTotal = (l: any) => l.qty * l.unitPrice * (1 - l.discountPct / 100); // شامل الضريبة
  const inclPrice = (p: any) => round2(Number(p.basePrice) * (1 + Number(p.taxPct) / 100)); // السعر شامل الضريبة

  const addProduct = (p: any) => {
    const idx = lines.findIndex(l => l.productId === p.id);
    if (idx >= 0) { const c = [...lines]; c[idx].qty++; setLines(c); }
    else setLines([...lines, { productId: p.id, name: p.name, unit: p.unit, image: p.image || null, qty: 1, unitPrice: inclPrice(p), discountPct: 0, taxPct: Number(p.taxPct) }]);
  };

  const upd = (i: number, f: string, v: number) => { const c = [...lines]; c[i][f] = v; setLines(c); };

  const qtyInCart = (id: string) => lines.find(l => l.productId === id)?.qty || 0;
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);

  const subtotal = lines.reduce((s, l) => s + l.qty * preTax(l), 0); // قبل الضريبة وقبل الخصم
  const discount = lines.reduce((s, l) => s + l.qty * preTax(l) * l.discountPct / 100, 0);
  const tax = lines.reduce((s, l) => s + l.qty * preTax(l) * (1 - l.discountPct / 100) * l.taxPct / 100, 0);
  const total = subtotal - discount + tax; // = مجموع الأسعار الشاملة

  const submit = async () => {
    if (lines.length === 0) { setMsg('أضف صنفاً'); return; }
    setLoading(true); setMsg('');
    try {
      const res = await repApi.post('/invoices', {
        customerId: customer.id, type: isReturn ? 'RETURN' : type, discountPct: 0,
        // نرسل السعر قبل الضريبة (مشتقّاً من السعر الشامل)
        items: lines.map(l => ({ productId: l.productId, qty: l.qty, unitPrice: round2(preTax(l)), discountPct: l.discountPct, taxPct: l.taxPct })),
      });
      const inv = res.data.data;
      onDone({
        kind: 'invoice', number: inv.number, date: inv.invoiceDate, type, isReturn,
        company, customer, repName,
        items: lines.map(l => ({ name: l.name, unit: l.unit, qty: l.qty, unitPrice: round2(preTax(l)), discountPct: l.discountPct, taxPct: l.taxPct, lineTotal: lineTotal(l) })),
        subtotal, discount, tax, total,
        paidAmt: Number(inv.paidAmt), remainingAmt: Number(inv.remainingAmt),
      });
    } catch (err: any) { setMsg(err?.response?.data?.message || 'تعذّر إصدار المستند، حاول مجدداً'); setLoading(false); }
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className={`${isReturn ? 'bg-amber-700' : 'bg-blue-900'} text-white p-4 flex items-center gap-3`}>
        <button onClick={() => showCart ? setShowCart(false) : onClose()}><ArrowRight size={20} /></button>
        <span className="font-bold">{showCart ? 'مراجعة الأصناف' : isReturn ? 'فاتورة إرجاع' : 'فاتورة جديدة'}</span>
      </div>

      {/* ===== شاشة اختيار المنتجات (شبكة أيقونات) ===== */}
      {!showCart ? (
        <>
          <div className="px-3 pt-3">
            <div className={`${isReturn ? 'bg-amber-50 border-amber-100' : 'bg-blue-50 border-blue-100'} rounded-xl p-2.5 mb-2 flex items-center gap-2 border`}>
              <User size={15} className={isReturn ? 'text-amber-700' : 'text-blue-600'} />
              <span className="font-semibold text-xs text-gray-800">{customer.name}</span>
            </div>

            {isReturn ? (
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-2 mb-2 text-[11px] text-amber-800 text-center">
                مرتجع مبيعات — سيُخفّض رصيد العميل بقيمة المرتجع
              </div>
            ) : (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-gray-600">النوع:</span>
                <button onClick={() => setType('CREDIT')} className={`px-3 py-1 rounded-full text-xs ${type === 'CREDIT' ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>آجل</button>
                <button onClick={() => setType('CASH')} className={`px-3 py-1 rounded-full text-xs ${type === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'}`}>نقدي</button>
              </div>
            )}

            <div className="relative mb-2">
              <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input className="input pr-9" placeholder="ابحث عن صنف..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>

          {/* شبكة المنتجات */}
          <div className="flex-1 overflow-y-auto px-3 pb-28">
            {loadingProducts ? (
              <div className="text-center text-gray-400 py-10 text-sm">جاري التحميل...</div>
            ) : products.length === 0 ? (
              <div className="text-center text-gray-400 py-10 text-sm">لا توجد أصناف</div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {products.map(p => {
                  const q = qtyInCart(p.id);
                  return (
                    <button key={p.id} onClick={() => addProduct(p)}
                      className={`relative bg-white rounded-xl border overflow-hidden text-right transition-all ${q > 0 ? (isReturn ? 'border-amber-400 ring-1 ring-amber-300' : 'border-blue-400 ring-1 ring-blue-300') : 'border-gray-100'}`}>
                      <div className="relative w-full aspect-square bg-gray-50 flex items-center justify-center overflow-hidden">
                        {p.image
                          ? <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
                          : <ImageIcon size={26} className="text-gray-300" />}
                        {q > 0 && (
                          <span className={`absolute top-1 left-1 ${isReturn ? 'bg-amber-600' : 'bg-blue-600'} text-white text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center shadow`}>
                            {q}
                          </span>
                        )}
                      </div>
                      <div className="p-1.5">
                        <p className="text-[11px] font-semibold text-gray-800 leading-tight line-clamp-2 h-7">{p.name}</p>
                        <p className={`text-[11px] font-bold mt-0.5 ${isReturn ? 'text-amber-600' : 'text-blue-600'}`}>{formatCurrency(inclPrice(p))}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* شريط العربة السفلي */}
          {lines.length > 0 && (
            <div className="absolute bottom-0 right-0 left-0 p-3 bg-white border-t shadow-lg">
              <button onClick={() => setShowCart(true)}
                className={`w-full ${isReturn ? 'bg-amber-600' : 'bg-blue-600'} text-white font-semibold py-3 rounded-xl flex items-center justify-between px-4`}>
                <span className="flex items-center gap-2">
                  <span className="bg-white/25 w-6 h-6 rounded-full flex items-center justify-center text-xs">{itemCount}</span>
                  مراجعة وإصدار
                </span>
                <span className="font-bold">{formatCurrency(total)}</span>
              </button>
            </div>
          )}
        </>
      ) : (
        /* ===== شاشة مراجعة الأصناف المختارة ===== */
        <>
          <div className="flex-1 overflow-y-auto p-4">
            {lines.map((l, i) => (
              <div key={l.productId} className="bg-white rounded-xl p-3 mb-2 border border-gray-100">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-10 h-10 rounded-lg bg-gray-50 flex items-center justify-center overflow-hidden flex-shrink-0">
                    {l.image ? <img src={l.image} alt="" className="w-full h-full object-cover" /> : <ImageIcon size={16} className="text-gray-300" />}
                  </div>
                  <span className="font-semibold text-sm flex-1">{l.name}</span>
                  <button onClick={() => setLines(lines.filter((_, j) => j !== i))} className="text-red-400"><Trash2 size={15} /></button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {[['الكمية', 'qty'], ['السعر شامل', 'unitPrice'], ['خصم%', 'discountPct']].map(([lbl, f]) => (
                    <div key={f}>
                      <label className="text-[10px] text-gray-400">{lbl}</label>
                      <input type="number" className="input text-center !py-1.5 text-sm" value={l[f]}
                        onChange={e => upd(i, f, Number(e.target.value))} />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between items-center mt-2 text-xs">
                  <span className="text-gray-400">منها ضريبة: {formatCurrency(l.qty * preTax(l) * (1 - l.discountPct / 100) * l.taxPct / 100)}</span>
                  <span className="font-bold text-blue-600">{formatCurrency(lineTotal(l))}</span>
                </div>
              </div>
            ))}

            <div className="bg-white rounded-xl p-4 mt-2 border border-gray-100 space-y-1.5 text-sm">
              <div className="flex justify-between text-gray-500"><span>قبل الخصم</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between text-red-500"><span>الخصم</span><span>- {formatCurrency(discount)}</span></div>
              <div className="flex justify-between text-blue-600"><span>الضريبة 15%</span><span>{formatCurrency(tax)}</span></div>
              <div className="flex justify-between font-bold text-base border-t pt-2"><span>الإجمالي</span><span>{formatCurrency(total)}</span></div>
            </div>
            {msg && <p className="text-red-500 text-xs mt-2 text-center">{msg}</p>}
          </div>

          <div className="p-4 border-t bg-white">
            <button onClick={submit} disabled={loading} className={`w-full ${isReturn ? 'bg-amber-600 disabled:bg-amber-400' : 'bg-blue-600 disabled:bg-blue-400'} text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2`}>
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
              {isReturn ? 'إصدار فاتورة الإرجاع' : 'إصدار الفاتورة'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ============ إنشاء سند قبض ============
function CreateReceipt({ customer, repName, company, onClose, onDone }: { customer: any; repName: string; company: Company | null; onClose: () => void; onDone: (doc: ReceiptDoc) => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (!amount || Number(amount) <= 0) { setMsg('أدخل مبلغاً صحيحاً'); return; }
    setLoading(true); setMsg('');
    try {
      const res = await repApi.post('/receipts', { customerId: customer.id, amount: Number(amount), paymentMethod: method, notes: notes || undefined });
      const rcp = res.data.data;
      onDone({
        kind: 'receipt', number: rcp.number, date: rcp.receiptDate,
        company, customer, repName, amount: Number(amount), paymentMethod: method, notes: notes || undefined,
      });
    } catch (err: any) { setMsg(err?.response?.data?.message || 'تعذّر إصدار السند، حاول مجدداً'); setLoading(false); }
  };

  const methods = [['CASH', 'نقدي'], ['BANK_TRANSFER', 'تحويل'], ['POS', 'شبكة'], ['CHEQUE', 'شيك']];

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-green-700 text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">إصدار سند قبض</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="bg-green-50 rounded-xl p-3 flex items-center justify-between border border-green-100">
          <div className="flex items-center gap-2">
            <User size={16} className="text-green-700" />
            <span className="font-semibold text-sm">{customer.name}</span>
          </div>
          <span className="text-xs text-gray-500">رصيد: {formatCurrency(customer.balance)}</span>
        </div>

        <div>
          <label className="label">المبلغ المحصّل</label>
          <input type="number" className="input text-lg font-bold" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div>
          <label className="label">طريقة الدفع</label>
          <div className="flex flex-wrap gap-2">
            {methods.map(([v, lbl]) => (
              <button key={v} onClick={() => setMethod(v)}
                className={`px-4 py-2 rounded-full text-sm ${method === v ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">ملاحظات</label>
          <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {msg && <p className="text-red-500 text-xs text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-green-400">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
          إصدار السند
        </button>
      </div>
    </div>
  );
}

// ============ إضافة عميل جديد ============
function AddCustomer({ onClose, onCreated }: { onClose: () => void; onCreated: (c: any) => void }) {
  const [form, setForm] = useState({
    name: '', businessName: '', phone: '', commercialReg: '', taxNumber: '',
    city: '', district: '', address: '', creditLimit: '', paymentDays: '30',
  });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) { setMsg('اسم العميل مطلوب'); return; }
    if (form.phone.trim().length < 9) { setMsg('رقم جوال صحيح مطلوب (9 أرقام على الأقل)'); return; }
    setLoading(true); setMsg('');
    try {
      const res = await repApi.post('/customers', {
        name: form.name.trim(),
        businessName: form.businessName.trim() || undefined,
        phone: form.phone.trim(),
        commercialReg: form.commercialReg.trim() || undefined,
        taxNumber: form.taxNumber.trim() || undefined,
        city: form.city.trim() || undefined,
        district: form.district.trim() || undefined,
        address: form.address.trim() || undefined,
        creditLimit: form.creditLimit ? Number(form.creditLimit) : undefined,
        paymentDays: form.paymentDays ? Number(form.paymentDays) : undefined,
      });
      onCreated(res.data.data);
    } catch (err: any) {
      setMsg(err?.response?.data?.message || 'تعذّر إضافة العميل');
      setLoading(false);
    }
  };

  const field = (label: string, key: string, opts?: { required?: boolean; type?: string; ltr?: boolean }) => (
    <div>
      <label className="label">{label}{opts?.required && ' *'}</label>
      <input className="input" type={opts?.type || 'text'} dir={opts?.ltr ? 'ltr' : 'rtl'}
        value={(form as any)[key]} onChange={e => set(key, e.target.value)} />
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-blue-900 text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">إضافة عميل جديد</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">البيانات الأساسية</p>
          <div className="space-y-3">
            {field('اسم العميل', 'name', { required: true })}
            {field('اسم المنشأة', 'businessName')}
            {field('رقم الجوال', 'phone', { required: true, ltr: true })}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">البيانات النظامية</p>
          <div className="grid grid-cols-2 gap-3">
            {field('السجل التجاري', 'commercialReg', { ltr: true })}
            {field('الرقم الضريبي', 'taxNumber', { ltr: true })}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">العنوان</p>
          <div className="grid grid-cols-2 gap-3">
            {field('المدينة', 'city')}
            {field('الحي', 'district')}
          </div>
          <div className="mt-3">{field('العنوان التفصيلي', 'address')}</div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">البيانات المالية</p>
          <div className="grid grid-cols-2 gap-3">
            {field('الحد الائتماني', 'creditLimit', { type: 'number', ltr: true })}
            {field('فترة السداد (يوم)', 'paymentDays', { type: 'number', ltr: true })}
          </div>
        </div>

        {msg && <p className="text-red-500 text-xs text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-blue-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-blue-400">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
          حفظ العميل
        </button>
      </div>
    </div>
  );
}

// ============ قائمة بسيطة (فواتير/سندات) ============
function SimpleList({ endpoint, kind, onOpen }: { endpoint: string; kind: 'invoice' | 'receipt'; onOpen: (detail: any) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const res = await repApi.get(endpoint, { params: { limit: 50 } }); setItems(res.data.data); } catch { /* */ }
    setLoading(false);
  }, [endpoint]);
  useEffect(() => { load(); }, [load]);

  const open = async (id: string) => {
    setOpeningId(id);
    try { const res = await repApi.get(`${endpoint}/${id}`); onOpen(res.data.data); } catch { /* */ }
    setOpeningId(null);
  };

  return (
    <div className="h-full overflow-y-auto p-3 pb-24">
      {loading ? <div className="text-center text-gray-400 py-10 text-sm">جاري التحميل...</div>
        : items.length === 0 ? <div className="text-center text-gray-400 py-10 text-sm">لا توجد بيانات</div>
        : items.map(it => {
          const isReturn = kind === 'invoice' && it.type === 'RETURN';
          return (
          <button key={it.id} onClick={() => open(it.id)}
            className="w-full text-right bg-white rounded-2xl p-3 mb-2 border border-gray-100 flex items-center justify-between hover:border-blue-200">
            <div className="flex items-center gap-3">
              <span className={`w-9 h-9 rounded-full flex items-center justify-center ${isReturn ? 'bg-amber-50 text-amber-600' : kind === 'invoice' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'}`}>
                {isReturn ? <RotateCcw size={16} /> : kind === 'invoice' ? <FileText size={16} /> : <ReceiptIcon size={16} />}
              </span>
              <div>
                <p className="font-semibold text-xs text-gray-800 flex items-center gap-1.5">
                  {it.number}
                  {isReturn && <span className="bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded-full">مرتجع</span>}
                </p>
                <p className="text-[11px] text-gray-400">{it.customer?.name} • {formatDate(kind === 'invoice' ? it.invoiceDate : it.receiptDate)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <p className={`font-bold text-sm ${isReturn ? 'text-amber-600' : kind === 'invoice' ? 'text-gray-800' : 'text-green-600'}`}>
                {isReturn ? '- ' : ''}{formatCurrency(kind === 'invoice' ? it.total : it.amount)}
              </p>
              {openingId === it.id
                ? <span className="w-4 h-4 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                : <FileDown size={16} className="text-gray-400" />}
            </div>
          </button>
          );
        })}
    </div>
  );
}

// ============ التطبيق الرئيسي ============
export default function RepApp() {
  const [token, setToken] = useState(localStorage.getItem('rep_token'));
  const [user, setUser] = useState<RepUser | null>(() => {
    try { return JSON.parse(localStorage.getItem('rep_user') || 'null'); } catch { return null; }
  });
  const [screen, setScreen] = useState<Screen>('home');
  const [modal, setModal] = useState<Modal>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [docResult, setDocResult] = useState<InvoiceDoc | ReceiptDoc | StatementDoc | null>(null);
  const [company, setCompany] = useState<Company | null>(null);

  useEffect(() => {
    if (!token) return;
    repApi.get('/company').then(res => setCompany(res.data.data)).catch(() => {});
  }, [token]);

  const login = (t: string, u: RepUser) => {
    localStorage.setItem('rep_token', t);
    localStorage.setItem('rep_user', JSON.stringify(u));
    setToken(t); setUser(u);
  };
  const logout = () => {
    localStorage.removeItem('rep_token'); localStorage.removeItem('rep_user');
    setToken(null); setUser(null);
  };

  const tabs: { id: Screen; label: string; icon: React.ElementType }[] = [
    { id: 'home', label: 'الرئيسية', icon: Home },
    { id: 'invoices', label: 'الفواتير', icon: FileText },
    { id: 'receipts', label: 'التحصيل', icon: CreditCard },
    { id: 'customers', label: 'العملاء', icon: Users },
  ];

  // Phone frame
  return (
    <div className="min-h-screen bg-slate-200 flex items-center justify-center p-4" dir="rtl">
      <div className="relative w-[400px] h-[820px] bg-black rounded-[44px] p-2.5 shadow-2xl">
        {/* notch */}
        <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-b-2xl z-30" />
        <div className="w-full h-full bg-white rounded-[36px] overflow-hidden relative flex flex-col">
          {!token || !user ? (
            <RepLogin onLogin={login} />
          ) : docResult ? (
            <DocumentResult doc={docResult} onClose={() => {
              const k = docResult.kind;
              setDocResult(null);
              setScreen(k === 'invoice' ? 'invoices' : k === 'receipt' ? 'receipts' : 'customers');
            }} />
          ) : modal === 'customerDetail' && selectedCustomer ? (
            <CustomerDetail customer={selectedCustomer} repName={user.name} company={company} onClose={() => setModal(null)}
              onInvoice={() => setModal('createInvoice')} onReceipt={() => setModal('createReceipt')} onReturn={() => setModal('createReturn')}
              onStatement={(doc) => { setModal(null); setDocResult(doc); }} />
          ) : modal === 'createInvoice' && selectedCustomer ? (
            <CreateInvoice customer={selectedCustomer} repName={user.name} company={company} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'createReturn' && selectedCustomer ? (
            <CreateInvoice customer={selectedCustomer} repName={user.name} company={company} mode="return" onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'createReceipt' && selectedCustomer ? (
            <CreateReceipt customer={selectedCustomer} repName={user.name} company={company} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'addCustomer' ? (
            <AddCustomer onClose={() => setModal(null)}
              onCreated={(c) => { setModal('customerDetail'); setSelectedCustomer(c); }} />
          ) : (
            <>
              {/* Top bar */}
              <div className="bg-blue-900 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                <span className="font-bold text-sm">نظام المبيعات الميداني</span>
                <button onClick={logout} className="text-blue-200 hover:text-white"><LogOut size={18} /></button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-hidden">
                {screen === 'home' && <RepHome key={refreshKey} user={user} onQuick={setScreen} />}
                {screen === 'invoices' && <SimpleList key={`invoices-${refreshKey}`} endpoint="/invoices" kind="invoice" onOpen={(d) => setDocResult(invoiceDocFromDetail(d, user.name, company))} />}
                {screen === 'receipts' && <SimpleList key={`receipts-${refreshKey}`} endpoint="/receipts" kind="receipt" onOpen={(d) => setDocResult(receiptDocFromDetail(d, user.name, company))} />}
                {screen === 'customers' && <RepCustomers onSelect={c => { setSelectedCustomer(c); setModal('customerDetail'); }} canAdd={!!user.canAddCustomer} onAdd={() => setModal('addCustomer')} />}
              </div>

              {/* Bottom nav */}
              <div className="flex-shrink-0 bg-white border-t border-gray-100 grid grid-cols-4 px-2 py-1.5">
                {tabs.map(t => {
                  const Icon = t.icon;
                  const active = screen === t.id;
                  return (
                    <button key={t.id} onClick={() => setScreen(t.id)}
                      className={`flex flex-col items-center gap-0.5 py-1.5 rounded-xl ${active ? 'text-blue-600' : 'text-gray-400'}`}>
                      <Icon size={20} />
                      <span className="text-[10px] font-medium">{t.label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
