import { useState, useEffect, useCallback } from 'react';
import repApi from './repApi';
import { formatCurrency, formatDate } from '../utils/format';
import { DocumentResult, invoiceDocFromDetail, receiptDocFromDetail, statementDocFromData, InvoiceDoc, ReceiptDoc, StatementDoc, Company } from './RepDocuments';
import {
  TrendingUp, Eye, EyeOff, Home, FileText, CreditCard, Users,
  Plus, Trash2, ArrowRight, LogOut, Receipt as ReceiptIcon,
  User, Wallet, FileDown, FileBarChart2, RotateCcw, Image as ImageIcon,
  Truck, Package, ArrowDownToLine, Check, MapPin,
} from 'lucide-react';
import { BrandIcon } from '../components/BrandLogo';
import ForgotPasswordDialog from '../components/ForgotPasswordDialog';
import SearchableSelect from '../components/SearchableSelect';
import LanguageToggle from '../components/LanguageToggle';
import { useT } from '../i18n/strings';
import { useRepTracking } from './useRepTracking';

type Screen = 'home' | 'invoices' | 'receipts' | 'customers' | 'vanstock';
type Modal = null | 'customerDetail' | 'createInvoice' | 'createReceipt' | 'createReturn' | 'addCustomer';

interface RepUser {
  id: string; name: string; phone?: string;
  canAddCustomer?: boolean;
  canCreateInvoice?: boolean;
  canSellOnCredit?: boolean;
  canSellInCash?: boolean;
  canCreateReceipt?: boolean;
  canCancelReceipt?: boolean;
  canViewStatement?: boolean;
  canManageVanStock?: boolean;
  canChangePrice?: boolean;
  canSellBelowPrice?: boolean;
  maxDiscountPct?: number;
}

// ============ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ ============
function RepLogin({ onLogin }: { onLogin: (token: string, user: RepUser) => void }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForgot, setShowForgot] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await repApi.post('/auth/login', { username, password, role: 'sales_rep' });
      onLogin(res.data.data.token, res.data.data.user);
    } catch {
      setError(t('rep.badCreds'));
    } finally { setLoading(false); }
  };

  return (
    <div className="h-full relative overflow-hidden bg-[#1F1A13] flex flex-col items-center justify-center px-6">
      <div className="absolute top-3 z-20" style={{ insetInlineEnd: '12px' }}><LanguageToggle variant="dark" /></div>
      <div className="absolute inset-0" style={{ background: 'radial-gradient(120% 90% at 50% 0%, rgba(225,90,48,.26), transparent 55%)' }} />
      <span className="absolute rounded-full" style={{ width: 170, height: 170, top: -40, right: -30, background: 'rgba(225,90,48,.14)' }} />
      <span className="absolute rounded-full" style={{ width: 120, height: 120, bottom: 40, left: -30, background: 'rgba(224,160,44,.10)' }} />

      <div className="relative z-10 w-full flex flex-col items-center">
        <div style={{ filter: 'drop-shadow(0 12px 30px rgba(225,90,48,.45))' }}>
          <BrandIcon size={76} radius={0.26} />
        </div>
        <h1 className="text-2xl tracking-tight mt-3" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}>
          <span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span>
        </h1>
        <p className="text-[#9A8F7E] text-xs mb-8">{t('rep.tagline')}</p>

        <form onSubmit={submit} className="w-full bg-white rounded-3xl p-6 shadow-2xl">
          <h2 className="font-bold text-[#1F1A13] mb-5">{t('rep.loginTitle')}</h2>
          <div className="space-y-3">
            <div className="relative">
              <User size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]" />
              <input className="input pr-9" placeholder={t('rep.username')} dir="ltr"
                value={username} onChange={e => setUsername(e.target.value)} />
            </div>
            <div className="relative">
              <input className="input pr-3 pl-9" type={showPass ? 'text' : 'password'} placeholder={t('login.password')} dir="ltr"
                value={password} onChange={e => setPassword(e.target.value)} />
              <button type="button" className="absolute left-3 top-1/2 -translate-y-1/2 text-[#9A8F7E]"
                onClick={() => setShowPass(s => !s)}>
                {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          {error && <p className="text-[#C0392B] text-xs mt-2">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-[#E15A30] hover:bg-[#C94E28] text-white font-bold py-3 rounded-xl mt-5 flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
            {loading && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
            {t('login.submit')}
          </button>
          <button type="button" onClick={() => setShowForgot(true)}
            className="w-full text-center text-xs text-[#6E6557] hover:text-[#E15A30] mt-3 transition-colors">
            {t('login.forgot')}
          </button>
        </form>
      </div>

      {showForgot && <ForgotPasswordDialog role="rep" onClose={() => setShowForgot(false)} />}
    </div>
  );
}

// ============ Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ© ============
function RepHome({ user, onQuick }: { user: RepUser; onQuick: (s: Screen) => void }) {
  const [stats, setStats] = useState({ salesTotal: 0, collectTotal: 0, invCount: 0, rcpCount: 0 });
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setSyncing(true);
    try {
      // Ø­Ø¯ÙˆØ¯ "Ø§Ù„ÙŠÙˆÙ…" Ø¨Ø§Ù„ØªÙˆÙ‚ÙŠØª Ø§Ù„Ù…Ø­Ù„ÙŠ Ù„Ù„Ù…Ù†Ø¯ÙˆØ¨ (ÙˆÙ„ÙŠØ³ UTC) Ø­ØªÙ‰ Ù„Ø§ ØªÙØ­ØªØ³Ø¨ ÙØ§ØªÙˆØ±Ø© Ø§Ù„ÙØ¬Ø± Ø¶Ù…Ù† Ø£Ù…Ø³
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
      // Ù…Ø¨ÙŠØ¹Ø§Øª Ø§Ù„ÙŠÙˆÙ…: ÙÙˆØ§ØªÙŠØ± Ø§Ù„Ø¨ÙŠØ¹ ÙÙ‚Ø· (ØªÙØ³ØªØ«Ù†Ù‰ ÙÙˆØ§ØªÙŠØ± Ø§Ù„Ø¥Ø±Ø¬Ø§Ø¹)
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
      <div className="bg-gradient-to-l from-[#1F1A13] to-[#E15A30] rounded-3xl p-5 flex items-center justify-between">
        <div>
          <p className="text-[#E8C9BC] text-xs">Ù…Ø±Ø­Ø¨Ø§Ù‹ØŒ</p>
          <p className="text-white text-lg font-bold">{user.name}</p>
          {syncing && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              <span className="text-[#E8C9BC] text-[11px]">Ù…Ø²Ø§Ù…Ù†Ø©...</span>
            </div>
          )}
        </div>
        <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
          <User size={22} className="text-white" />
        </div>
      </div>

      {/* Stats */}
      <div>
        <p className="text-[#1F1A13] font-bold text-sm mb-3">Ø¥Ø­ØµØ§Ø¦ÙŠØ§Øª Ø§Ù„ÙŠÙˆÙ…</p>
        <div className="grid grid-cols-2 gap-3">
          {stat('Ø§Ù„Ù…Ø¨ÙŠØ¹Ø§Øª', formatCurrency(stats.salesTotal), TrendingUp, 'text-[#E15A30]', 'bg-[#FBEBE2] border-[#F5DACE]')}
          {stat('Ø§Ù„ØªØ­ØµÙŠÙ„', formatCurrency(stats.collectTotal), Wallet, 'text-green-600', 'bg-green-50 border-green-100')}
          {stat('Ø§Ù„ÙÙˆØ§ØªÙŠØ±', String(stats.invCount), FileText, 'text-orange-600', 'bg-orange-50 border-orange-100')}
          {stat('Ø³Ù†Ø¯Ø§Øª Ø§Ù„Ù‚Ø¨Ø¶', String(stats.rcpCount), CreditCard, 'text-purple-600', 'bg-purple-50 border-purple-100')}
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <p className="text-[#1F1A13] font-bold text-sm mb-3">Ø¥Ø¬Ø±Ø§Ø¡Ø§Øª Ø³Ø±ÙŠØ¹Ø©</p>
        <div className="grid grid-cols-3 gap-3">
          {quick('ÙØ§ØªÙˆØ±Ø©', FileText, 'text-[#E15A30]', 'bg-[#FBEBE2] border-[#F5DACE]', 'invoices')}
          {quick('Ø³Ù†Ø¯ Ù‚Ø¨Ø¶', CreditCard, 'text-green-600', 'bg-green-50 border-green-100', 'receipts')}
          {quick('Ø§Ù„Ø¹Ù…Ù„Ø§Ø¡', Users, 'text-orange-600', 'bg-orange-50 border-orange-100', 'customers')}
        </div>
      </div>
    </div>
  );
}

// ============ Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ø¹Ù…Ù„Ø§Ø¡ ============
function RepCustomers({ onSelect, canAdd, onAdd }: { onSelect: (c: any) => void; canAdd: boolean; onAdd: () => void }) {
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await repApi.get('/customers', { params: { limit: 1000 } });
        setCustomers(res.data.data);
      } catch { /* */ }
      setLoading(false);
    })();
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center gap-2">
        <div className="flex-1">
          <SearchableSelect
            placeholder="Ø§Ø®ØªØ± Ø§Ù„Ø¹Ù…ÙŠÙ„"
            searchPlaceholder="Ø§ÙƒØªØ¨ Ø§Ø³Ù… Ø£Ùˆ Ø¬ÙˆØ§Ù„ Ø§Ù„Ø¹Ù…ÙŠÙ„â€¦"
            value=""
            resetOnSelect
            options={customers.map(c => ({
              value: c.id,
              label: c.name,
              hint: Number(c.balance) > 0 ? `Ø±ØµÙŠØ¯ ${formatCurrency(c.balance)}` : c.phone,
              hintColor: Number(c.balance) > 0 ? 'text-red-500' : undefined,
            }))}
            onChange={(v) => { const c = customers.find(x => x.id === v); if (c) onSelect(c); }}
          />
        </div>
        {canAdd && (
          <button onClick={onAdd} title="Ø¥Ø¶Ø§ÙØ© Ø¹Ù…ÙŠÙ„"
            className="flex-shrink-0 w-10 h-10 bg-[#E15A30] hover:bg-[#C94E28] text-white rounded-xl flex items-center justify-center">
            <Plus size={20} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-24">
        {loading ? (
          <div className="text-center text-gray-400 py-10 text-sm">Ø¬Ø§Ø±ÙŠ Ø§Ù„ØªØ­Ù…ÙŠÙ„...</div>
        ) : customers.length === 0 ? (
          <div className="text-center text-gray-400 py-10 text-sm">Ù„Ø§ ØªÙˆØ¬Ø¯ Ù†ØªØ§Ø¦Ø¬</div>
        ) : customers.map(c => (
          <button key={c.id} onClick={() => onSelect(c)}
            className="w-full flex items-center gap-3 bg-white rounded-2xl p-3 mb-2 border border-gray-100 text-right hover:border-[#E8C9BC]">
            <div className="w-10 h-10 rounded-full bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center font-bold flex-shrink-0">
              {c.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-800 text-sm truncate">{c.name}</p>
              <p className="text-xs text-gray-400">{c.phone} â€¢ {c.city || ''}</p>
            </div>
            <div className="text-left">
              <p className={`text-sm font-bold ${Number(c.balance) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {formatCurrency(c.balance)}
              </p>
              <p className="text-[10px] text-gray-400">Ø§Ù„Ø±ØµÙŠØ¯</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ============ ØªÙØ§ØµÙŠÙ„ Ø§Ù„Ø¹Ù…ÙŠÙ„ ============
function CustomerDetail({ customer, repName, company, perms, onClose, onInvoice, onReceipt, onReturn, onStatement }: {
  customer: any; repName: string; company: Company | null;
  perms: RepUser;
  onClose: () => void; onInvoice: () => void; onReceipt: () => void; onReturn: () => void;
  onStatement: (doc: StatementDoc) => void;
}) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const canCreateInvoice = perms.canCreateInvoice !== false;
  const canSellAnyType = perms.canSellOnCredit !== false || perms.canSellInCash !== false;
  const canCreateReceipt = perms.canCreateReceipt !== false;
  const canViewStatement = perms.canViewStatement !== false;

  useEffect(() => {
    if (!canViewStatement) { setEntries([]); setLoading(false); return; }
    (async () => {
      try {
        const res = await repApi.get(`/customers/${customer.id}/statement`);
        setEntries(res.data.data.entries);
      } catch { /* */ }
      setLoading(false);
    })();
  }, [customer.id, canViewStatement]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">{customer.name}</span>
      </div>

      <div className="p-4 overflow-y-auto flex-1 pb-4">
        {/* Summary */}
        <div className="bg-gradient-to-l from-[#1F1A13] to-[#E15A30] rounded-3xl p-5 text-white">
          <p className="font-bold text-lg">{customer.name}</p>
          {customer.businessName && <p className="text-[#E8C9BC] text-sm">{customer.businessName}</p>}
          <p className="text-[#E8C9BC] text-xs mb-4">{customer.phone}</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className={`font-bold text-sm ${Number(customer.balance) > 0 ? 'text-red-300' : 'text-green-300'}`}>{formatCurrency(customer.balance)}</p>
              <p className="text-[#E8C9BC] text-[10px]">Ø§Ù„Ø±ØµÙŠØ¯</p>
            </div>
            <div>
              <p className="font-bold text-sm">{formatCurrency(customer.creditLimit)}</p>
              <p className="text-[#E8C9BC] text-[10px]">Ø§Ù„Ø­Ø¯ Ø§Ù„Ø§Ø¦ØªÙ…Ø§Ù†ÙŠ</p>
            </div>
            <div>
              <p className="font-bold text-sm">{customer.paymentDays} ÙŠÙˆÙ…</p>
              <p className="text-[#E8C9BC] text-[10px]">ÙØªØ±Ø© Ø§Ù„Ø³Ø¯Ø§Ø¯</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button onClick={onInvoice} disabled={!canCreateInvoice || !canSellAnyType}
            className="bg-[#E15A30] disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <FileText size={16} /> ÙØ§ØªÙˆØ±Ø© Ø¬Ø¯ÙŠØ¯Ø©
          </button>
          <button onClick={onReceipt} disabled={!canCreateReceipt} className="bg-green-600 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <CreditCard size={16} /> Ø³Ù†Ø¯ Ù‚Ø¨Ø¶
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <button onClick={onReturn} className="bg-amber-600 hover:bg-amber-700 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <RotateCcw size={16} /> ÙØ§ØªÙˆØ±Ø© Ø¥Ø±Ø¬Ø§Ø¹
          </button>
          <button
            onClick={() => onStatement(statementDocFromData(customer, entries, repName, company))}
            disabled={loading || !canViewStatement}
            className="bg-slate-700 hover:bg-slate-800 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60">
            <FileBarChart2 size={16} /> ÙƒØ´Ù Ø­Ø³Ø§Ø¨
          </button>
        </div>

        {/* Statement */}
        <p className="font-bold text-gray-700 text-sm mt-5 mb-2">ÙƒØ´Ù Ø§Ù„Ø­Ø³Ø§Ø¨</p>
        {!canViewStatement ? (
          <p className="text-center text-gray-400 py-6 text-sm">لا تملك صلاحية عرض كشف الحساب</p>
        ) : loading ? (
          <p className="text-center text-gray-400 py-6 text-sm">Ø¬Ø§Ø±ÙŠ Ø§Ù„ØªØ­Ù…ÙŠÙ„...</p>
        ) : entries.length === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">Ù„Ø§ ØªÙˆØ¬Ø¯ Ø­Ø±ÙƒØ§Øª</p>
        ) : entries.map(e => {
          const isDebit = Number(e.debit) > 0;
          return (
            <div key={e.id} className="bg-white rounded-xl p-3 mb-2 border border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center ${isDebit ? 'bg-red-50 text-red-500' : 'bg-green-50 text-green-500'}`}>
                  {isDebit ? 'â†‘' : 'â†“'}
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
                <p className="text-[10px] text-gray-400">Ø±ØµÙŠØ¯: {formatCurrency(e.balance)}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ Ø¥Ù†Ø´Ø§Ø¡ ÙØ§ØªÙˆØ±Ø© (Ø¨ÙŠØ¹ Ø£Ùˆ Ø¥Ø±Ø¬Ø§Ø¹) ============
function CreateInvoice({ customer, repName, company, mode = 'sale', perms, onClose, onDone }: { customer: any; repName: string; company: Company | null; mode?: 'sale' | 'return'; perms: RepUser; onClose: () => void; onDone: (doc: InvoiceDoc) => void }) {
  const isReturn = mode === 'return';
  const canSellOnCredit = perms.canSellOnCredit !== false;
  const canSellInCash = perms.canSellInCash !== false;
  const canSellAnyType = canSellOnCredit || canSellInCash;
  const [type, setType] = useState<'CASH' | 'CREDIT'>(canSellOnCredit ? 'CREDIT' : 'CASH');
  const [products, setProducts] = useState<any[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [lines, setLines] = useState<any[]>([]);
  const [showCart, setShowCart] = useState(false); // Ø¹Ø±Ø¶ Ø§Ù„Ø£ØµÙ†Ø§Ù Ø§Ù„Ù…Ø®ØªØ§Ø±Ø© Ù„Ù„Ù…Ø±Ø§Ø¬Ø¹Ø© Ù‚Ø¨Ù„ Ø§Ù„Ø¥ØµØ¯Ø§Ø±
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  // Ø¬Ù„Ø¨ Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª ÙƒØ§Ù…Ù„Ø© (Ø§Ù„Ø§Ø®ØªÙŠØ§Ø± Ø¹Ø¨Ø± Ù‚Ø§Ø¦Ù…Ø© Ù…Ù†Ø³Ø¯Ù„Ø© Ø¨Ø§Ù„ØªØµÙÙŠØ© + Ø´Ø¨ÙƒØ© Ù„Ù„ØªØµÙÙ‘Ø­)
  useEffect(() => {
    (async () => {
      setLoadingProducts(true);
      try {
        const res = await repApi.get('/products', { params: { status: 'ACTIVE', limit: 1000 } });
        setProducts(res.data.data);
      } catch { /* */ }
      setLoadingProducts(false);
    })();
  }, []);

  // Ø§Ù„Ø³Ø¹Ø± Ø§Ù„Ø°ÙŠ ÙŠÙØ¯Ø®Ù„Ù‡ Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ Ø´Ø§Ù…Ù„ Ø§Ù„Ø¶Ø±ÙŠØ¨Ø©Ø› Ù†Ø´ØªÙ‚Ù‘ Ø§Ù„Ø³Ø¹Ø± Ù‚Ø¨Ù„ Ø§Ù„Ø¶Ø±ÙŠØ¨Ø© Ù„Ù„Ù†Ø¸Ø§Ù…
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const preTax = (l: any) => l.unitPrice / (1 + l.taxPct / 100);
  const lineTotal = (l: any) => l.qty * l.unitPrice * (1 - l.discountPct / 100); // Ø´Ø§Ù…Ù„ Ø§Ù„Ø¶Ø±ÙŠØ¨Ø©
  const inclPrice = (p: any) => round2(Number(p.basePrice) * (1 + Number(p.taxPct) / 100)); // Ø§Ù„Ø³Ø¹Ø± Ø´Ø§Ù…Ù„ Ø§Ù„Ø¶Ø±ÙŠØ¨Ø©

  const addProduct = (p: any) => {
    const idx = lines.findIndex(l => l.productId === p.id);
    if (idx >= 0) { const c = [...lines]; c[idx].qty++; setLines(c); }
    else setLines([...lines, { productId: p.id, name: p.name, unit: p.unit, image: p.image || null, qty: 1, unitPrice: inclPrice(p), refPrice: inclPrice(p), discountPct: 0, taxPct: Number(p.taxPct) }]);
  };

  // Ø­Ø¯ÙˆØ¯ ØµÙ„Ø§Ø­ÙŠØ§Øª Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨ (ØªÙÙØ±Ø¶ Ø£ÙŠØ¶Ø§Ù‹ ÙÙŠ Ø§Ù„Ø®Ø§Ø¯Ù… ÙƒØ­Ø§Ø±Ø³ Ù†Ù‡Ø§Ø¦ÙŠ)
  const maxDisc = perms?.maxDiscountPct ?? 0;
  const upd = (i: number, f: string, v: number) => {
    const c = [...lines];
    if (f === 'discountPct') v = Math.max(0, Math.min(v || 0, maxDisc));        // Ø­Ø¯Ù‘ Ø§Ù„Ø®ØµÙ… Ø§Ù„Ù…Ø³Ù…ÙˆØ­
    if (f === 'unitPrice') {
      if (!perms?.canChangePrice) return;                                       // Ù„Ø§ ÙŠÙ…Ù„Ùƒ ØªØºÙŠÙŠØ± Ø§Ù„Ø³Ø¹Ø±
      if (!perms?.canSellBelowPrice) v = Math.max(v || 0, c[i].refPrice);       // Ù„Ø§ ÙŠØ¨ÙŠØ¹ Ø¨Ø£Ù‚Ù„ Ù…Ù† Ø§Ù„Ø³Ø¹Ø±
    }
    c[i][f] = v; setLines(c);
  };

  const qtyInCart = (id: string) => lines.find(l => l.productId === id)?.qty || 0;
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);

  const subtotal = lines.reduce((s, l) => s + l.qty * preTax(l), 0); // Ù‚Ø¨Ù„ Ø§Ù„Ø¶Ø±ÙŠØ¨Ø© ÙˆÙ‚Ø¨Ù„ Ø§Ù„Ø®ØµÙ…
  const discount = lines.reduce((s, l) => s + l.qty * preTax(l) * l.discountPct / 100, 0);
  const tax = lines.reduce((s, l) => s + l.qty * preTax(l) * (1 - l.discountPct / 100) * l.taxPct / 100, 0);
  const total = subtotal - discount + tax; // = Ù…Ø¬Ù…ÙˆØ¹ Ø§Ù„Ø£Ø³Ø¹Ø§Ø± Ø§Ù„Ø´Ø§Ù…Ù„Ø©

  const submit = async () => {
    if (lines.length === 0) { setMsg('Ø£Ø¶Ù ØµÙ†ÙØ§Ù‹'); return; }
    if (perms.canCreateInvoice === false) { setMsg('Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø¥Ù†Ø´Ø§Ø¡ ÙØ§ØªÙˆØ±Ø©'); return; }
    if (!isReturn && !canSellAnyType) { setMsg('Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø¨ÙŠØ¹ Ø§Ù„Ù†Ù‚Ø¯ÙŠ Ø£Ùˆ Ø§Ù„Ø¢Ø¬Ù„'); return; }
    if (!isReturn && type === 'CREDIT' && !canSellOnCredit) { setMsg('Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø¨ÙŠØ¹ Ø§Ù„Ø¢Ø¬Ù„'); return; }
    if (!isReturn && type === 'CASH' && !canSellInCash) { setMsg('Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø¨ÙŠØ¹ Ø§Ù„Ù†Ù‚Ø¯ÙŠ'); return; }
    setLoading(true); setMsg('');
    try {
      const res = await repApi.post('/invoices', {
        customerId: customer.id, type: isReturn ? 'RETURN' : type, discountPct: 0,
        // Ù†Ø±Ø³Ù„ Ø§Ù„Ø³Ø¹Ø± Ù‚Ø¨Ù„ Ø§Ù„Ø¶Ø±ÙŠØ¨Ø© (Ù…Ø´ØªÙ‚Ù‘Ø§Ù‹ Ù…Ù† Ø§Ù„Ø³Ø¹Ø± Ø§Ù„Ø´Ø§Ù…Ù„)
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
    } catch (err: any) { setMsg(err?.response?.data?.message || 'ØªØ¹Ø°Ù‘Ø± Ø¥ØµØ¯Ø§Ø± Ø§Ù„Ù…Ø³ØªÙ†Ø¯ØŒ Ø­Ø§ÙˆÙ„ Ù…Ø¬Ø¯Ø¯Ø§Ù‹'); setLoading(false); }
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className={`${isReturn ? 'bg-amber-700' : 'bg-[#1F1A13]'} text-white p-4 flex items-center gap-3`}>
        <button onClick={() => showCart ? setShowCart(false) : onClose()}><ArrowRight size={20} /></button>
        <span className="font-bold">{showCart ? 'Ù…Ø±Ø§Ø¬Ø¹Ø© Ø§Ù„Ø£ØµÙ†Ø§Ù' : isReturn ? 'ÙØ§ØªÙˆØ±Ø© Ø¥Ø±Ø¬Ø§Ø¹' : 'ÙØ§ØªÙˆØ±Ø© Ø¬Ø¯ÙŠØ¯Ø©'}</span>
      </div>

      {/* ===== Ø´Ø§Ø´Ø© Ø§Ø®ØªÙŠØ§Ø± Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª (Ø´Ø¨ÙƒØ© Ø£ÙŠÙ‚ÙˆÙ†Ø§Øª) ===== */}
      {!showCart ? (
        <>
          <div className="px-3 pt-3">
            <div className={`${isReturn ? 'bg-amber-50 border-amber-100' : 'bg-[#FBEBE2] border-[#F5DACE]'} rounded-xl p-2.5 mb-2 flex items-center gap-2 border`}>
              <User size={15} className={isReturn ? 'text-amber-700' : 'text-[#E15A30]'} />
              <span className="font-semibold text-xs text-gray-800">{customer.name}</span>
            </div>

            {isReturn ? (
              <div className="bg-amber-50 border border-amber-100 rounded-xl p-2 mb-2 text-[11px] text-amber-800 text-center">
                Ù…Ø±ØªØ¬Ø¹ Ù…Ø¨ÙŠØ¹Ø§Øª â€” Ø³ÙŠÙØ®ÙÙ‘Ø¶ Ø±ØµÙŠØ¯ Ø§Ù„Ø¹Ù…ÙŠÙ„ Ø¨Ù‚ÙŠÙ…Ø© Ø§Ù„Ù…Ø±ØªØ¬Ø¹
              </div>
            ) : (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-gray-600">Ø§Ù„Ù†ÙˆØ¹:</span>
                <button disabled={!canSellOnCredit} onClick={() => setType('CREDIT')} className={`px-3 py-1 rounded-full text-xs disabled:bg-gray-100 disabled:text-gray-300 ${type === 'CREDIT' ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>Ø¢Ø¬Ù„</button>
                <button disabled={!canSellInCash} onClick={() => setType('CASH')} className={`px-3 py-1 rounded-full text-xs disabled:bg-gray-100 disabled:text-gray-300 ${type === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'}`}>Ù†Ù‚Ø¯ÙŠ</button>
              </div>
            )}
            {!isReturn && !canSellAnyType && <p className="text-[11px] text-red-500 mb-2">Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© Ø§Ù„Ø¨ÙŠØ¹ Ø§Ù„Ù†Ù‚Ø¯ÙŠ Ø£Ùˆ Ø§Ù„Ø¢Ø¬Ù„.</p>}

            <div className="mb-2">
              <SearchableSelect
                placeholder="Ø§Ø®ØªØ± ØµÙ†ÙØ§Ù‹ Ù„Ø¥Ø¶Ø§ÙØªÙ‡"
                searchPlaceholder="Ø§ÙƒØªØ¨ Ø§Ø³Ù… Ø§Ù„ØµÙ†Ùâ€¦"
                value=""
                resetOnSelect
                options={products.map(p => ({ value: p.id, label: p.name, hint: formatCurrency(inclPrice(p)) }))}
                onChange={(v) => { const p = products.find(x => x.id === v); if (p) addProduct(p); }}
              />
            </div>
          </div>

          {/* Ø´Ø¨ÙƒØ© Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª */}
          <div className="flex-1 overflow-y-auto px-3 pb-28">
            {loadingProducts ? (
              <div className="text-center text-gray-400 py-10 text-sm">Ø¬Ø§Ø±ÙŠ Ø§Ù„ØªØ­Ù…ÙŠÙ„...</div>
            ) : products.length === 0 ? (
              <div className="text-center text-gray-400 py-10 text-sm">Ù„Ø§ ØªÙˆØ¬Ø¯ Ø£ØµÙ†Ø§Ù</div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                {products.map(p => {
                  const q = qtyInCart(p.id);
                  return (
                    <button key={p.id} onClick={() => addProduct(p)}
                      className={`relative bg-white rounded-xl border overflow-hidden text-right transition-all ${q > 0 ? (isReturn ? 'border-amber-400 ring-1 ring-amber-300' : 'border-[#E15A30] ring-1 ring-[#F5C9BA]') : 'border-gray-100'}`}>
                      <div className="relative w-full aspect-square bg-gray-50 flex items-center justify-center overflow-hidden">
                        {p.image
                          ? <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
                          : <ImageIcon size={26} className="text-gray-300" />}
                        {q > 0 && (
                          <span className={`absolute top-1 left-1 ${isReturn ? 'bg-amber-600' : 'bg-[#E15A30]'} text-white text-[11px] font-bold w-5 h-5 rounded-full flex items-center justify-center shadow`}>
                            {q}
                          </span>
                        )}
                      </div>
                      <div className="p-1.5">
                        <p className="text-[11px] font-semibold text-gray-800 leading-tight line-clamp-2 h-7">{p.name}</p>
                        <p className={`text-[11px] font-bold mt-0.5 ${isReturn ? 'text-amber-600' : 'text-[#E15A30]'}`}>{formatCurrency(inclPrice(p))}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Ø´Ø±ÙŠØ· Ø§Ù„Ø¹Ø±Ø¨Ø© Ø§Ù„Ø³ÙÙ„ÙŠ */}
          {lines.length > 0 && (
            <div className="absolute bottom-0 right-0 left-0 p-3 bg-white border-t shadow-lg">
              <button onClick={() => setShowCart(true)}
                className={`w-full ${isReturn ? 'bg-amber-600' : 'bg-[#E15A30]'} text-white font-semibold py-3 rounded-xl flex items-center justify-between px-4`}>
                <span className="flex items-center gap-2">
                  <span className="bg-white/25 w-6 h-6 rounded-full flex items-center justify-center text-xs">{itemCount}</span>
                  Ù…Ø±Ø§Ø¬Ø¹Ø© ÙˆØ¥ØµØ¯Ø§Ø±
                </span>
                <span className="font-bold">{formatCurrency(total)}</span>
              </button>
            </div>
          )}
        </>
      ) : (
        /* ===== Ø´Ø§Ø´Ø© Ù…Ø±Ø§Ø¬Ø¹Ø© Ø§Ù„Ø£ØµÙ†Ø§Ù Ø§Ù„Ù…Ø®ØªØ§Ø±Ø© ===== */
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
                  {[['Ø§Ù„ÙƒÙ…ÙŠØ©', 'qty'], ['Ø§Ù„Ø³Ø¹Ø± Ø´Ø§Ù…Ù„', 'unitPrice'], ['Ø®ØµÙ…%', 'discountPct']].map(([lbl, f]) => {
                    const locked = (f === 'unitPrice' && !perms?.canChangePrice) || (f === 'discountPct' && maxDisc === 0);
                    return (
                      <div key={f}>
                        <label className="text-[10px] text-gray-400 flex items-center gap-0.5">
                          {lbl}{f === 'discountPct' && maxDisc > 0 && <span className="text-[#E15A30]">(Ø­Ø¯ {maxDisc}%)</span>}
                        </label>
                        <input type="number" readOnly={locked} max={f === 'discountPct' ? maxDisc : undefined} min={0}
                          className={`input text-center !py-1.5 text-sm ${locked ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''}`}
                          value={l[f]} onChange={e => upd(i, f, Number(e.target.value))} title={locked ? 'ØºÙŠØ± Ù…ØµØ±Ù‘Ø­ Ù„Ùƒ Ø¨ØªØ¹Ø¯ÙŠÙ„ Ù‡Ø°Ø§ Ø§Ù„Ø­Ù‚Ù„' : undefined} />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between items-center mt-2 text-xs">
                  <span className="text-gray-400">Ù…Ù†Ù‡Ø§ Ø¶Ø±ÙŠØ¨Ø©: {formatCurrency(l.qty * preTax(l) * (1 - l.discountPct / 100) * l.taxPct / 100)}</span>
                  <span className="font-bold text-[#E15A30]">{formatCurrency(lineTotal(l))}</span>
                </div>
              </div>
            ))}

            <div className="bg-white rounded-xl p-4 mt-2 border border-gray-100 space-y-1.5 text-sm">
              <div className="flex justify-between text-gray-500"><span>Ù‚Ø¨Ù„ Ø§Ù„Ø®ØµÙ…</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between text-red-500"><span>Ø§Ù„Ø®ØµÙ…</span><span>- {formatCurrency(discount)}</span></div>
              <div className="flex justify-between text-[#E15A30]"><span>Ø§Ù„Ø¶Ø±ÙŠØ¨Ø© 15%</span><span>{formatCurrency(tax)}</span></div>
              <div className="flex justify-between font-bold text-base border-t pt-2"><span>Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ</span><span>{formatCurrency(total)}</span></div>
            </div>
            {msg && <p className="text-red-500 text-xs mt-2 text-center">{msg}</p>}
          </div>

          <div className="p-4 border-t bg-white">
            <button onClick={submit} disabled={loading || (!isReturn && (perms.canCreateInvoice === false || !canSellAnyType))} className={`w-full ${isReturn ? 'bg-amber-600 disabled:bg-amber-400' : 'bg-[#E15A30] disabled:bg-[#E89B7E]'} text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2`}>
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
              {isReturn ? 'Ø¥ØµØ¯Ø§Ø± ÙØ§ØªÙˆØ±Ø© Ø§Ù„Ø¥Ø±Ø¬Ø§Ø¹' : 'Ø¥ØµØ¯Ø§Ø± Ø§Ù„ÙØ§ØªÙˆØ±Ø©'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ============ Ø¥Ù†Ø´Ø§Ø¡ Ø³Ù†Ø¯ Ù‚Ø¨Ø¶ ============
function CreateReceipt({ customer, repName, company, perms, onClose, onDone }: { customer: any; repName: string; company: Company | null; perms: RepUser; onClose: () => void; onDone: (doc: ReceiptDoc) => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (perms.canCreateReceipt === false) { setMsg('لا تملك صلاحية إصدار سند قبض'); return; }
    if (!amount || Number(amount) <= 0) { setMsg('Ø£Ø¯Ø®Ù„ Ù…Ø¨Ù„ØºØ§Ù‹ ØµØ­ÙŠØ­Ø§Ù‹'); return; }
    setLoading(true); setMsg('');
    try {
      const res = await repApi.post('/receipts', { customerId: customer.id, amount: Number(amount), paymentMethod: method, notes: notes || undefined });
      const rcp = res.data.data;
      onDone({
        kind: 'receipt', number: rcp.number, date: rcp.receiptDate,
        company, customer, repName, amount: Number(amount), paymentMethod: method, notes: notes || undefined,
      });
    } catch (err: any) { setMsg(err?.response?.data?.message || 'ØªØ¹Ø°Ù‘Ø± Ø¥ØµØ¯Ø§Ø± Ø§Ù„Ø³Ù†Ø¯ØŒ Ø­Ø§ÙˆÙ„ Ù…Ø¬Ø¯Ø¯Ø§Ù‹'); setLoading(false); }
  };

  const methods = [['CASH', 'Ù†Ù‚Ø¯ÙŠ'], ['BANK_TRANSFER', 'ØªØ­ÙˆÙŠÙ„'], ['POS', 'Ø´Ø¨ÙƒØ©'], ['CHEQUE', 'Ø´ÙŠÙƒ']];

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-green-700 text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">Ø¥ØµØ¯Ø§Ø± Ø³Ù†Ø¯ Ù‚Ø¨Ø¶</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="bg-green-50 rounded-xl p-3 flex items-center justify-between border border-green-100">
          <div className="flex items-center gap-2">
            <User size={16} className="text-green-700" />
            <span className="font-semibold text-sm">{customer.name}</span>
          </div>
          <span className="text-xs text-gray-500">Ø±ØµÙŠØ¯: {formatCurrency(customer.balance)}</span>
        </div>

        <div>
          <label className="label">Ø§Ù„Ù…Ø¨Ù„Øº Ø§Ù„Ù…Ø­ØµÙ‘Ù„</label>
          <input type="number" className="input text-lg font-bold" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div>
          <label className="label">Ø·Ø±ÙŠÙ‚Ø© Ø§Ù„Ø¯ÙØ¹</label>
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
          <label className="label">Ù…Ù„Ø§Ø­Ø¸Ø§Øª</label>
          <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {msg && <p className="text-red-500 text-xs text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-green-400">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
          Ø¥ØµØ¯Ø§Ø± Ø§Ù„Ø³Ù†Ø¯
        </button>
      </div>
    </div>
  );
}

// ============ Ø¥Ø¶Ø§ÙØ© Ø¹Ù…ÙŠÙ„ Ø¬Ø¯ÙŠØ¯ ============
function AddCustomer({ onClose, onCreated }: { onClose: () => void; onCreated: (c: any) => void }) {
  const [form, setForm] = useState({
    name: '', businessName: '', phone: '', commercialReg: '', taxNumber: '',
    city: '', district: '', address: '', creditLimit: '', paymentDays: '30',
  });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) { setMsg('Ø§Ø³Ù… Ø§Ù„Ø¹Ù…ÙŠÙ„ Ù…Ø·Ù„ÙˆØ¨'); return; }
    if (form.phone.trim().length < 9) { setMsg('Ø±Ù‚Ù… Ø¬ÙˆØ§Ù„ ØµØ­ÙŠØ­ Ù…Ø·Ù„ÙˆØ¨ (9 Ø£Ø±Ù‚Ø§Ù… Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„)'); return; }
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
      setMsg(err?.response?.data?.message || 'ØªØ¹Ø°Ù‘Ø± Ø¥Ø¶Ø§ÙØ© Ø§Ù„Ø¹Ù…ÙŠÙ„');
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
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">Ø¥Ø¶Ø§ÙØ© Ø¹Ù…ÙŠÙ„ Ø¬Ø¯ÙŠØ¯</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø£Ø³Ø§Ø³ÙŠØ©</p>
          <div className="space-y-3">
            {field('Ø§Ø³Ù… Ø§Ù„Ø¹Ù…ÙŠÙ„', 'name', { required: true })}
            {field('Ø§Ø³Ù… Ø§Ù„Ù…Ù†Ø´Ø£Ø©', 'businessName')}
            {field('Ø±Ù‚Ù… Ø§Ù„Ø¬ÙˆØ§Ù„', 'phone', { required: true, ltr: true })}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù†Ø¸Ø§Ù…ÙŠØ©</p>
          <div className="grid grid-cols-2 gap-3">
            {field('Ø§Ù„Ø³Ø¬Ù„ Ø§Ù„ØªØ¬Ø§Ø±ÙŠ', 'commercialReg', { ltr: true })}
            {field('Ø§Ù„Ø±Ù‚Ù… Ø§Ù„Ø¶Ø±ÙŠØ¨ÙŠ', 'taxNumber', { ltr: true })}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">Ø§Ù„Ø¹Ù†ÙˆØ§Ù†</p>
          <div className="grid grid-cols-2 gap-3">
            {field('Ø§Ù„Ù…Ø¯ÙŠÙ†Ø©', 'city')}
            {field('Ø§Ù„Ø­ÙŠ', 'district')}
          </div>
          <div className="mt-3">{field('Ø§Ù„Ø¹Ù†ÙˆØ§Ù† Ø§Ù„ØªÙØµÙŠÙ„ÙŠ', 'address')}</div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ù…Ø§Ù„ÙŠØ©</p>
          <div className="grid grid-cols-2 gap-3">
            {field('Ø§Ù„Ø­Ø¯ Ø§Ù„Ø§Ø¦ØªÙ…Ø§Ù†ÙŠ', 'creditLimit', { type: 'number', ltr: true })}
            {field('ÙØªØ±Ø© Ø§Ù„Ø³Ø¯Ø§Ø¯ (ÙŠÙˆÙ…)', 'paymentDays', { type: 'number', ltr: true })}
          </div>
        </div>

        {msg && <p className="text-red-500 text-xs text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-[#E15A30] text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
          Ø­ÙØ¸ Ø§Ù„Ø¹Ù…ÙŠÙ„
        </button>
      </div>
    </div>
  );
}

// ============ Ù‚Ø§Ø¦Ù…Ø© Ø¨Ø³ÙŠØ·Ø© (ÙÙˆØ§ØªÙŠØ±/Ø³Ù†Ø¯Ø§Øª) ============
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
      {loading ? <div className="text-center text-gray-400 py-10 text-sm">Ø¬Ø§Ø±ÙŠ Ø§Ù„ØªØ­Ù…ÙŠÙ„...</div>
        : items.length === 0 ? <div className="text-center text-gray-400 py-10 text-sm">Ù„Ø§ ØªÙˆØ¬Ø¯ Ø¨ÙŠØ§Ù†Ø§Øª</div>
        : items.map(it => {
          const isReturn = kind === 'invoice' && it.type === 'RETURN';
          return (
          <button key={it.id} onClick={() => open(it.id)}
            className="w-full text-right bg-white rounded-2xl p-3 mb-2 border border-gray-100 flex items-center justify-between hover:border-[#E8C9BC]">
            <div className="flex items-center gap-3">
              <span className={`w-9 h-9 rounded-full flex items-center justify-center ${isReturn ? 'bg-amber-50 text-amber-600' : kind === 'invoice' ? 'bg-[#FBEBE2] text-[#E15A30]' : 'bg-green-50 text-green-600'}`}>
                {isReturn ? <RotateCcw size={16} /> : kind === 'invoice' ? <FileText size={16} /> : <ReceiptIcon size={16} />}
              </span>
              <div>
                <p className="font-semibold text-xs text-gray-800 flex items-center gap-1.5">
                  {it.number}
                  {isReturn && <span className="bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded-full">Ù…Ø±ØªØ¬Ø¹</span>}
                </p>
                <p className="text-[11px] text-gray-400">{it.customer?.name} â€¢ {formatDate(kind === 'invoice' ? it.invoiceDate : it.receiptDate)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <p className={`font-bold text-sm ${isReturn ? 'text-amber-600' : kind === 'invoice' ? 'text-gray-800' : 'text-green-600'}`}>
                {isReturn ? '- ' : ''}{formatCurrency(kind === 'invoice' ? it.total : it.amount)}
              </p>
              {openingId === it.id
                ? <span className="w-4 h-4 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin" />
                : <FileDown size={16} className="text-gray-400" />}
            </div>
          </button>
          );
        })}
    </div>
  );
}

// ============ Ø§Ù„ØªØ·Ø¨ÙŠÙ‚ Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠ ============
// ============ Ù…Ø®Ø²ÙˆÙ† Ø³ÙŠØ§Ø±ØªÙŠ ============
function RepVanStock({ canLoad }: { canLoad: boolean }) {
  const [view, setView] = useState<'list' | 'load'>('list');
  const [stock, setStock] = useState<{ productId: string; name: string; code: string; unit: string; loaded: number; sold: number; returned: number; remaining: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<{ id: string; name: string; unit: string; code: string }[]>([]);
  const [rows, setRows] = useState<{ productId: string; name: string; unit: string; qty: string }[]>([]);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadStock = useCallback(async () => {
    setLoading(true);
    try { const r = await repApi.get('/van-stock/current'); setStock(r.data.data); } catch { /* offline */ }
    setLoading(false);
  }, []);
  useEffect(() => { loadStock(); }, [loadStock]);
  useEffect(() => { repApi.get('/products', { params: { limit: 1000, status: 'ACTIVE' } }).then(r => setProducts(r.data.data)).catch(() => {}); }, []);
  useEffect(() => { if (!canLoad && view === 'load') setView('list'); }, [canLoad, view]);

  const fmt = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

  const addProduct = (id: string) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = products.find(x => x.id === id); if (!p) return;
    setRows(rs => [...rs, { productId: id, name: p.name, unit: p.unit, qty: '1' }]);
  };

  const submit = async () => {
    if (!canLoad) { setMsg({ ok: false, text: 'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ­Ù…ÙŠÙ„ Ù…Ø®Ø²ÙˆÙ† Ø§Ù„Ø³ÙŠØ§Ø±Ø©' }); return; }
    const items = rows.map(r => ({ productId: r.productId, qty: Number(r.qty) })).filter(i => i.qty > 0);
    if (!items.length) { setMsg({ ok: false, text: 'Ø£Ø¶Ù ØµÙ†ÙØ§Ù‹ ÙˆÙƒÙ…ÙŠØ© ØµØ­ÙŠØ­Ø©' }); return; }
    setSaving(true); setMsg(null);
    try {
      await repApi.post('/van-stock/loads', { type: 'LOAD', note: note.trim() || undefined, items });
      setRows([]); setNote(''); setView('list'); loadStock();
      setMsg({ ok: true, text: 'ØªÙ… ØªØ³Ø¬ÙŠÙ„ Ø§Ù„ØªØ­Ù…ÙŠÙ„ Ø¨Ù†Ø¬Ø§Ø­' });
    } catch (e) {
      setMsg({ ok: false, text: (e as { response?: { data?: { message?: string } } })?.response?.data?.message || 'ØªØ¹Ø°Ù‘Ø± Ø§Ù„Ø­ÙØ¸' });
    }
    setSaving(false);
  };

  if (view === 'load') {
    return (
      <div className="h-full flex flex-col">
        <div className="p-3 flex items-center gap-2 border-b border-gray-100">
          <button onClick={() => setView('list')} className="p-1.5 text-[#6E6557]"><ArrowRight size={18} /></button>
          <span className="font-bold text-[#1F1A13]">ØªØ­Ù…ÙŠÙ„ Ø¨Ø¶Ø§Ø¹Ø© Ù„Ù„Ø³ÙŠØ§Ø±Ø©</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-28">
          <div>
            <label className="text-xs font-semibold text-[#6E6557] mb-1 block">Ø¥Ø¶Ø§ÙØ© ØµÙ†Ù</label>
            <SearchableSelect dark resetOnSelect value="" onChange={addProduct}
              options={products.filter(p => !rows.some(r => r.productId === p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} Â· ${p.unit}` }))}
              placeholder="Ø§Ø¨Ø­Ø« ÙˆØ£Ø¶Ù ØµÙ†ÙØ§Ù‹â€¦" searchPlaceholder="Ø§ÙƒØªØ¨ Ø§Ø³Ù…/ÙƒÙˆØ¯ Ø§Ù„ØµÙ†Ùâ€¦" />
          </div>
          {rows.map((r, i) => (
            <div key={r.productId} className="flex items-center gap-2 bg-white border border-gray-100 rounded-xl p-2.5 shadow-sm">
              <div className="flex-1 min-w-0"><p className="text-sm font-semibold truncate">{r.name}</p><p className="text-[10px] text-gray-400">{r.unit}</p></div>
              <input type="number" min="0" step="any" inputMode="decimal" value={r.qty}
                onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))}
                className="w-20 text-center border border-gray-200 rounded-lg py-1.5" />
              <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-red-400 p-1"><Trash2 size={16} /></button>
            </div>
          ))}
          {rows.length === 0 && <p className="text-center text-gray-400 text-xs py-6">Ù„Ù… ØªÙØ¶Ù Ø£ÙŠ ØµÙ†Ù Ø¨Ø¹Ø¯</p>}
          <input className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm" placeholder="Ù…Ù„Ø§Ø­Ø¸Ø© (Ø§Ø®ØªÙŠØ§Ø±ÙŠ)" value={note} onChange={e => setNote(e.target.value)} />
          {msg && <p className={`text-xs text-center ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</p>}
        </div>
        <div className="p-3 border-t border-gray-100">
          <button onClick={submit} disabled={saving || rows.length === 0} className="w-full bg-[#E15A30] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
            {saving ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownToLine size={18} />} Ø­ÙØ¸ Ø§Ù„ØªØ­Ù…ÙŠÙ„
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center justify-between border-b border-gray-100">
        <span className="font-bold text-[#1F1A13] flex items-center gap-2"><Truck size={18} className="text-[#E15A30]" /> Ù…Ø®Ø²ÙˆÙ† Ø³ÙŠØ§Ø±ØªÙŠ</span>
        <button
          onClick={() => { if (canLoad) { setView('load'); setMsg(null); } }}
          disabled={!canLoad}
          title={canLoad ? undefined : 'Ù„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ­Ù…ÙŠÙ„ Ù…Ø®Ø²ÙˆÙ† Ø§Ù„Ø³ÙŠØ§Ø±Ø©'}
          className="bg-[#E15A30] text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          <Plus size={14} /> ØªØ­Ù…ÙŠÙ„
        </button>
      </div>
      {msg && msg.ok && <div className="mx-3 mt-3 bg-green-50 text-green-700 text-xs rounded-lg px-3 py-2 flex items-center gap-1.5"><Check size={14} /> {msg.text}</div>}
      {!canLoad && <div className="mx-3 mt-3 bg-amber-50 text-amber-700 text-xs rounded-lg px-3 py-2">ÙŠÙ…ÙƒÙ†Ùƒ Ø¹Ø±Ø¶ Ù…Ø®Ø²ÙˆÙ† Ø§Ù„Ø³ÙŠØ§Ø±Ø© ÙÙ‚Ø·ØŒ ÙˆÙ„Ø§ ØªÙ…Ù„Ùƒ ØµÙ„Ø§Ø­ÙŠØ© ØªØ³Ø¬ÙŠÙ„ ØªØ­Ù…ÙŠÙ„ Ø¬Ø¯ÙŠØ¯.</div>}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 pb-24">
        {loading ? <p className="text-center text-gray-400 text-sm py-8">Ø¬Ø§Ø±Ù Ø§Ù„ØªØ­Ù…ÙŠÙ„â€¦</p>
          : stock.length === 0 ? (
            <div className="text-center py-10">
              <Package size={40} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-400 text-sm">Ù„Ø§ ØªÙˆØ¬Ø¯ Ø¨Ø¶Ø§Ø¹Ø© ÙÙŠ Ø³ÙŠØ§Ø±ØªÙƒ Ø¨Ø¹Ø¯.</p>
              {canLoad && <p className="text-gray-400 text-xs mt-1">Ø§Ø¶ØºØ· Â«ØªØ­Ù…ÙŠÙ„Â» Ù„ØªØ³Ø¬ÙŠÙ„ Ù…Ø§ Ø­Ù…ÙŽÙ‘Ù„ØªÙ‡.</p>}
            </div>
          ) : stock.map(s => (
            <div key={s.productId} className="bg-white border border-gray-100 rounded-xl p-3 shadow-sm flex items-center justify-between">
              <div className="min-w-0">
                <p className="font-semibold text-sm text-[#1F1A13] truncate">{s.name}</p>
                <p className="text-[11px] text-gray-400">Ù…Ø­Ù…ÙŽÙ‘Ù„ {fmt(s.loaded)} Â· Ù…ÙØ¨Ø§Ø¹ {fmt(s.sold)} {s.unit}</p>
              </div>
              <div className="text-left shrink-0">
                <p className={`text-lg font-bold ${s.remaining < 0 ? 'text-red-600' : s.remaining === 0 ? 'text-gray-400' : 'text-[#1E7A52]'}`}>{fmt(s.remaining)}</p>
                <p className="text-[10px] text-gray-400">Ù…ØªØ¨Ù‚Ù‘ÙŠ</p>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

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

  // ØªØªØ¨Ù‘Ø¹ GPS â€” ÙŠØ¹Ù…Ù„ ÙÙ‚Ø· Ø¹Ù†Ø¯ ØªØ³Ø¬ÙŠÙ„ Ø§Ù„Ø¯Ø®ÙˆÙ„ ÙˆØªÙØ¹ÙŠÙ„ Ø§Ù„Ø´Ø±ÙƒØ© Ù„Ù„ØªØªØ¨Ù‘Ø¹ ÙˆÙ…ÙˆØ§ÙÙ‚Ø© Ø§Ù„Ù…Ù†Ø¯ÙˆØ¨
  const trackStatus = useRepTracking(!!token && !!user);

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
    { id: 'home', label: 'Ø§Ù„Ø±Ø¦ÙŠØ³ÙŠØ©', icon: Home },
    { id: 'invoices', label: 'Ø§Ù„ÙÙˆØ§ØªÙŠØ±', icon: FileText },
    { id: 'receipts', label: 'Ø§Ù„ØªØ­ØµÙŠÙ„', icon: CreditCard },
    { id: 'customers', label: 'Ø§Ù„Ø¹Ù…Ù„Ø§Ø¡', icon: Users },
    { id: 'vanstock', label: 'Ù…Ø®Ø²ÙˆÙ†ÙŠ', icon: Truck },
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
            <CustomerDetail customer={selectedCustomer} repName={user.name} company={company} perms={user} onClose={() => setModal(null)}
              onInvoice={() => setModal('createInvoice')} onReceipt={() => setModal('createReceipt')} onReturn={() => setModal('createReturn')}
              onStatement={(doc) => { setModal(null); setDocResult(doc); }} />
          ) : modal === 'createInvoice' && selectedCustomer ? (
            <CreateInvoice customer={selectedCustomer} repName={user.name} company={company} perms={user} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'createReturn' && selectedCustomer ? (
            <CreateInvoice customer={selectedCustomer} repName={user.name} company={company} mode="return" perms={user} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'createReceipt' && selectedCustomer ? (
            <CreateReceipt customer={selectedCustomer} repName={user.name} company={company} perms={user} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'addCustomer' ? (
            <AddCustomer onClose={() => setModal(null)}
              onCreated={(c) => { setModal('customerDetail'); setSelectedCustomer(c); }} />
          ) : (
            <>
              {/* Top bar */}
              <div className="bg-[#1F1A13] text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                <span className="flex items-center gap-2">
                  <BrandIcon size={26} radius={0.3} />
                  <span className="text-sm" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 700 }}><span className="text-[#FAF7F0]">Field</span><span className="text-[#E15A30]"> Sales</span></span>
                </span>
                <div className="flex items-center gap-3">
                  {(trackStatus === 'active' || trackStatus === 'requesting') && (
                    <span className="flex items-center gap-1 text-[11px] text-[#5FBE92]" title="Ù…Ø´Ø§Ø±ÙƒØ© Ù…ÙˆÙ‚Ø¹Ùƒ Ù…ÙØ¹Ù‘Ù„Ø©">
                      <span className={`w-2 h-2 rounded-full bg-[#5FBE92] ${trackStatus === 'active' ? 'animate-pulse' : ''}`} /> <MapPin size={12} />
                    </span>
                  )}
                  {trackStatus === 'denied' && (
                    <span className="flex items-center gap-1 text-[11px] text-amber-400" title="ÙØ¹Ù‘Ù„ Ø¥Ø°Ù† Ø§Ù„Ù…ÙˆÙ‚Ø¹ Ù…Ù† Ø¥Ø¹Ø¯Ø§Ø¯Ø§Øª Ø§Ù„Ù…ØªØµÙØ­">
                      <MapPin size={12} /> Ø§Ù„Ù…ÙˆÙ‚Ø¹ Ù…ØªÙˆÙ‚Ù‘Ù
                    </span>
                  )}
                  <button onClick={logout} className="text-[#9A8F7E] hover:text-white"><LogOut size={18} /></button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-hidden">
                {screen === 'home' && <RepHome key={refreshKey} user={user} onQuick={setScreen} />}
                {screen === 'invoices' && <SimpleList key={`invoices-${refreshKey}`} endpoint="/invoices" kind="invoice" onOpen={(d) => setDocResult(invoiceDocFromDetail(d, user.name, company))} />}
                {screen === 'receipts' && <SimpleList key={`receipts-${refreshKey}`} endpoint="/receipts" kind="receipt" onOpen={(d) => setDocResult(receiptDocFromDetail(d, user.name, company))} />}
                {screen === 'customers' && <RepCustomers onSelect={c => { setSelectedCustomer(c); setModal('customerDetail'); }} canAdd={!!user.canAddCustomer} onAdd={() => setModal('addCustomer')} />}
                {screen === 'vanstock' && <RepVanStock canLoad={user.canManageVanStock !== false} />}
              </div>

              {/* Bottom nav */}
              <div className="flex-shrink-0 bg-white border-t border-gray-100 grid grid-cols-5 px-2 py-1.5">
                {tabs.map(t => {
                  const Icon = t.icon;
                  const active = screen === t.id;
                  return (
                    <button key={t.id} onClick={() => setScreen(t.id)}
                      className={`flex flex-col items-center gap-0.5 py-1.5 rounded-xl ${active ? 'text-[#E15A30]' : 'text-gray-400'}`}>
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





