import { useState, useEffect, useCallback } from 'react';
import repApi from './repApi';
import { fetchThenCache, cacheGet, cacheSet, requestPersistentStorage, newClientRef, outboxAdd, refClear, currentRepId } from './offlineDb';
import { isNetworkError, startAutoSync, syncOutbox, pendingCount, rejectedCount, onOutboxChange, outboxDocs, requeue, discard } from './offlineSync';
import type { OutboxDoc } from './offlineDb';
import { formatCurrency, formatDate, setActiveCurrency, getActiveCurrency } from '../utils/format';
import { currencyDecimals } from '../i18n/countries';
import { DocumentResult, invoiceDocFromDetail, receiptDocFromDetail, statementDocFromData, InvoiceDoc, ReceiptDoc, StatementDoc, Company } from './RepDocuments';
import {
  TrendingUp, Eye, EyeOff, Home, FileText, CreditCard, Users,
  Plus, Trash2, ArrowRight, LogOut, Receipt as ReceiptIcon,
  User, Wallet, FileDown, FileBarChart2, RotateCcw, Image as ImageIcon,
  Truck, Package, ArrowDownToLine, Check, MapPin, ScanLine, RefreshCw, Fuel, BookOpen, Copy, ExternalLink, PhoneCall, PhoneIncoming, PhoneOutgoing, PhoneMissed,
  Camera, X, ClipboardCheck, Timer, Square, Link2, ClipboardList, MessageCircle,
} from 'lucide-react';
import { computeInvoiceTotals, roundDecimal, priceFromLineTotal } from './invoiceCalc';
import { getVisitTimer, setVisitTimer, clearVisitTimer, elapsedSec, fmtElapsed, type VisitTimer } from './visitTimer';
import DecimalInput from '../components/DecimalInput';
import { startRenewLoop, clearRenewRejection } from './renew';
import { tokenTenantId } from './jwt';
import { BrandIcon } from '../components/BrandLogo';
import AppIntro from '../components/AppIntro';
import ForgotPasswordDialog from '../components/ForgotPasswordDialog';
import SearchableSelect from '../components/SearchableSelect';
import BarcodeScanner from './BarcodeScanner';
import LanguageToggle from '../components/LanguageToggle';
import { useT, useTr } from '../i18n/strings';
import { useRepTracking } from './useRepTracking';
import { useHeartbeat } from './useHeartbeat';

type Screen = 'home' | 'invoices' | 'receipts' | 'customers' | 'vanstock' | 'fuel' | 'worknum';
type Modal = null | 'customerDetail' | 'createInvoice' | 'createReceipt' | 'createReturn' | 'addCustomer' | 'logVisit';

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

// ============ تسجيل الدخول ============
function RepLogin({ onLogin, onBack }: { onLogin: (token: string, user: RepUser) => void; onBack?: () => void }) {
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
      {onBack && (
        <button onClick={onBack} className="absolute top-3 z-20 text-[#9A8F7E] hover:text-white p-1" style={{ insetInlineStart: '12px' }} aria-label={t('intro.back')}>
          <ArrowRight size={20} />
        </button>
      )}
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

// ============ الرئيسية ============

// ═══ شاشة «رقم عملي» (تكامل هاتف) — تظهر فقط حين تفعّل الشركة الميزة ═══

interface WorkNumSummary {
  enabled: boolean;
  channel?: { e164: string; label?: string | null; kind: string } | null;
  lastCalls?: { direction: string; fromE164: string; toE164: string; startedAt: string; durationSec: number; aiSummary?: string | null }[];
}

function RepWorkNumber() {
  const tr = useTr();
  const [sum, setSum] = useState<WorkNumSummary | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await repApi.get('/work-numbers/rep/summary');
        if (cancelled) return;
        setSum(data.data as WorkNumSummary);
        await cacheSet('rep-worknum-summary', data.data);
      } catch {
        const cached = await cacheGet<WorkNumSummary>('rep-worknum-summary');
        if (!cancelled && cached?.data) setSum(cached.data);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!sum) return <div className="p-6 text-center text-sm text-gray-400">{tr('يحمل')}…</div>;
  if (!sum.enabled) return <div className="p-6 text-center text-sm text-gray-400">{tr('ميزة ارقام العمل غير مفعلة لشركتك')}</div>;

  const copy = () => {
    if (!sum.channel) return;
    navigator.clipboard?.writeText(sum.channel.e164);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const dirIcon = (d: string) => d === 'OUT' ? <PhoneOutgoing size={15} className="text-blue-600" /> : d === 'MISSED' ? <PhoneMissed size={15} className="text-red-500" /> : <PhoneIncoming size={15} className="text-green-600" />;
  const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}${tr('د')} ${s % 60}${tr('ث')}` : `${s}${tr('ث')}`);

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full pb-24">
      <div className="bg-gradient-to-l from-[#0e4f46] to-[#17877a] rounded-3xl p-5 text-white">
        <p className="text-xs opacity-80">{tr('رقم عملك — اعطه لعملائك')}</p>
        {sum.channel ? (
          <>
            <button onClick={copy} className="text-2xl font-bold mt-1 tracking-wide" dir="ltr">{sum.channel.e164}</button>
            <p className="text-[10px] opacity-70 mt-1">{copied ? tr('نسخ') : tr('اضغط الرقم لنسخه')}{sum.channel.label ? ` · ${sum.channel.label}` : ''}</p>
          </>
        ) : (
          <p className="text-sm font-bold mt-1">{tr('لم يسند لك رقم بعد — اطلب من ادارتك')}</p>
        )}
      </div>

      <div>
        <p className="text-[#1F1A13] font-bold text-sm mb-2">{tr('اخر المكالمات')}</p>
        {sum.lastCalls?.length ? (
          <div className="space-y-2">
            {sum.lastCalls.map((c, i) => (
              <div key={i} className="bg-white border border-gray-100 rounded-2xl px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  {dirIcon(c.direction)}
                  <div>
                    <p className="text-sm font-semibold text-[#1F1A13]" dir="ltr">{c.direction === 'OUT' ? c.toE164 : c.fromE164}</p>
                    {c.aiSummary && <p className="text-[10px] text-gray-400 max-w-[200px] truncate">{c.aiSummary}</p>}
                  </div>
                </div>
                <div className="text-left">
                  <p className="text-xs font-bold text-[#6E6557]">{mins(c.durationSec)}</p>
                  <p className="text-[10px] text-gray-400">{formatDate(c.startedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400">{tr('لا مكالمات بعد — تظهر تلقائيا بعد ربط شركتك بهاتف')}</p>
        )}
      </div>
    </div>
  );
}


// ═══ شاشة الوقود (بترو آب) — تظهر فقط حين تربط الشركة حسابها ═══

interface FuelTx { kind: string; amount: number; liters?: number | null; stationName?: string | null; occurredAt: string; odometer?: number | null }
interface FuelSummary {
  enabled: boolean; linked?: boolean;
  vehicle?: { plate?: string | null; model?: string | null; balance?: number | null } | null;
  delegate?: { name?: string | null; balance?: number | null } | null;
  balance?: number | null; balanceAt?: string | null;
  lastTransactions?: FuelTx[];
  stations?: { name?: string; km: number; services?: string }[];
  lastSyncAt?: string | null;
}

const FUEL_KIND_AR: Record<string, string> = { FUEL: 'وقود', SERVICE: 'صيانة', WASH: 'غسيل' };

function RepFuel() {
  const tr = useTr();
  const [sum, setSum] = useState<FuelSummary | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (coords?: { lat: number; lng: number }) => {
      try {
        const { data } = await repApi.get('/petroapp/rep/summary', { params: coords });
        if (cancelled) return;
        setSum(data.data as FuelSummary); setStale(false);
        await cacheSet('rep-fuel-summary', data.data);
      } catch {
        const cached = await cacheGet<FuelSummary>('rep-fuel-summary');
        if (!cancelled && cached?.data) { setSum(cached.data); setStale(true); }
      }
    };
    // نطلب الموقع لأقرب المحطات — ورفضه لا يمنع بقية الشاشة
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => load({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => load(),
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 300000 },
      );
    } else load();
    return () => { cancelled = true; };
  }, []);

  if (!sum) return <div className="p-6 text-center text-sm text-gray-400">{tr('يحمل')}…</div>;
  if (!sum.enabled) return <div className="p-6 text-center text-sm text-gray-400">{tr('ربط بترو اب غير مفعل لشركتك')}</div>;

  const openDrive = () => {
    // فتح تطبيق PetroApp Drive — رابط المتجر المناسب للنظام (لا مخطط رابط عميق موثق بعد)
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    window.open(ios
      ? 'https://apps.apple.com/sa/app/petroapp-drive/id1267297826'
      : 'https://play.google.com/store/apps/details?id=petro.petroapp', '_blank');
  };

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full pb-24">
      {/* بطاقة الرصيد */}
      <div className="bg-gradient-to-l from-[#0b2a5e] to-[#1a73e8] rounded-3xl p-5 text-white">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs opacity-80">{tr('رصيد الوقود')}</p>
            <p className="text-2xl font-bold mt-1">{sum.balance != null ? formatCurrency(sum.balance) : '—'}</p>
            {sum.balanceAt && <p className="text-[10px] opacity-70 mt-0.5">{tr('حتى')} {formatDate(sum.balanceAt)}</p>}
          </div>
          <Fuel size={34} className="opacity-90" />
        </div>
        {(sum.vehicle?.plate || sum.delegate?.name) && (
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            {sum.vehicle?.plate && <span className="bg-white/15 rounded-lg px-2.5 py-1" dir="ltr">🚚 {sum.vehicle.plate}</span>}
            {sum.delegate?.name && <span className="bg-white/15 rounded-lg px-2.5 py-1">👤 {sum.delegate.name}</span>}
          </div>
        )}
        {stale && <p className="text-[10px] opacity-70 mt-2">{tr('بيانات محفوظة — لا اتصال')}</p>}
      </div>

      {!sum.linked && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-xs text-amber-800">
          {tr('حسابك غير مربوط بسائق او مركبة بترو اب بعد — اطلب من ادارتك الربط من شاشة بترو اب')}
        </div>
      )}

      <button onClick={openDrive} className="w-full bg-[#E15A30] text-white rounded-2xl py-3.5 font-bold text-sm">
        {tr('فتح تطبيق بترو اب للتعبئة')}
      </button>

      {/* أقرب المحطات */}
      {!!sum.stations?.length && (
        <div>
          <p className="text-[#1F1A13] font-bold text-sm mb-2">{tr('اقرب المحطات')}</p>
          <div className="space-y-2">
            {sum.stations.map((s, i) => (
              <div key={i} className="bg-white border border-gray-100 rounded-2xl px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <MapPin size={16} className="text-[#E15A30]" />
                  <div>
                    <p className="text-sm font-semibold text-[#1F1A13]">{s.name || tr('محطة')}</p>
                    {s.services && <p className="text-[10px] text-gray-400">{s.services}</p>}
                  </div>
                </div>
                <span className="text-xs font-bold text-[#1a73e8]" dir="ltr">{s.km} km</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* آخر الفواتير */}
      <div>
        <p className="text-[#1F1A13] font-bold text-sm mb-2">{tr('اخر التعبئات والخدمات')}</p>
        {sum.lastTransactions?.length ? (
          <div className="space-y-2">
            {sum.lastTransactions.map((tx, i) => (
              <div key={i} className="bg-white border border-gray-100 rounded-2xl px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#1F1A13]">
                    {tr(FUEL_KIND_AR[tx.kind] || tx.kind)}{tx.liters ? ` · ${tx.liters} ${tr('لتر')}` : ''}
                  </p>
                  <p className="text-[10px] text-gray-400">{tx.stationName || ''} · {formatDate(tx.occurredAt)}</p>
                </div>
                <span className="text-sm font-bold text-[#E15A30]">{formatCurrency(tx.amount)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400">{tr('لا عمليات بعد')}</p>
        )}
      </div>
    </div>
  );
}

// ═══ بطاقة رابط منيو المنتجات — تفتح المنيو العام او تنسخ رابطه للمشاركة ═══
function MenuLinkCard({ repId }: { repId: string }) {
  const tr = useTr();
  const [copied, setCopied] = useState(false);
  const tenantId = tokenTenantId(localStorage.getItem('rep_token'));
  if (!tenantId) return null;
  const url = `${window.location.origin}/c/${tenantId}/${repId}`;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); }
    catch { // سياقات غير آمنة — احتياط بحقل مؤقت
      const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="bg-white border border-gray-100 rounded-2xl px-4 py-3 flex items-center gap-3">
      <span className="w-9 h-9 rounded-xl bg-[#FBEBE2] border border-[#F5DACE] flex items-center justify-center flex-shrink-0">
        <BookOpen size={18} className="text-[#E15A30]" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-[#1F1A13]">{tr('منيو المنتجات')}</p>
        <p className="text-[10px] text-gray-400 truncate">{tr('شارك الرابط مع عملائك — اسعار محدثة دائما')}</p>
      </div>
      <button onClick={() => window.open(url, '_blank')} title={tr('فتح المنيو')}
        className="w-9 h-9 rounded-xl bg-gray-50 border border-gray-100 flex items-center justify-center text-gray-500 hover:text-[#E15A30]">
        <ExternalLink size={16} />
      </button>
      <button onClick={copy} title={tr('نسخ الرابط')}
        className={`w-9 h-9 rounded-xl border flex items-center justify-center ${copied ? 'bg-green-50 border-green-200 text-green-600' : 'bg-gray-50 border-gray-100 text-gray-500 hover:text-[#E15A30]'}`}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function RepHome({ user, onQuick, fuelOn, workNumOn, menuOn }: { user: RepUser; onQuick: (s: Screen) => void; fuelOn?: boolean; workNumOn?: boolean; menuOn?: boolean }) {
  const tr = useTr();
  // `null` = **لا نعرف بعد**، وهو غير الصفر. كان الجلب الفاشل يُبتلع في `catch`
  // فتبقى القيم الابتدائية أصفاراً وتُعرَض كأنّها حقيقة: مندوبٌ بذمّته خمسة عشر
  // ألفاً يقرأ «رصيد التحصيل لديك: ٠٫٠٠» بخطٍّ عريض أخضر، فيطمئنّ ويُسلّم ناقصاً.
  // فرّقنا الحالات الثلاث: تحميل · بيانات (طازجة أو موسومة بزمنها) · تعذّر.
  const [stats, setStats] = useState<null | { salesTotal: number; collectTotal: number; collectBalance: number; collectShow: boolean; invCount: number; rcpCount: number }>(null);
  const [stale, setStale] = useState<number | null>(null); // لحظة آخر نجاح إن عرضنا مخزّناً
  const [failed, setFailed] = useState(false);             // لا شبكة ولا كاش ⇒ لا نزعم رقماً
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setSyncing(true);
    try {
      // حدود "اليوم" بالتوقيت المحلي للمندوب حتى لا تُحسب فاتورة الفجر ضمن أمس.
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end = new Date(); end.setHours(23, 59, 59, 999);
      const isToday = (iso: string) => { const d = new Date(iso); return d >= start && d <= end; };

      const [inv, rcp, bal] = await Promise.all([
        repApi.get('/invoices', { params: { limit: 200, status: 'CONFIRMED' } }),
        repApi.get('/receipts', { params: { limit: 200 } }),
        repApi.get('/receipts/collection-balance'),
      ]);
      const invoices = inv.data.data as { total: number; invoiceDate: string; type: string }[];
      const receipts = rcp.data.data as { amount: number; receiptDate: string }[];
      const todayRcp = receipts.filter(r => isToday(r.receiptDate));
      // مبيعات اليوم: فواتير البيع فقط (تُستثنى فواتير الإرجاع)
      const todaySales = invoices.filter(i => isToday(i.invoiceDate) && i.type !== 'RETURN');
      const fresh = {
        salesTotal: todaySales.reduce((s, i) => s + Number(i.total), 0),
        collectTotal: todayRcp.reduce((s, r) => s + Number(r.amount), 0),
        // رصيد التحصيل المتراكم لدى المندوب — لا يُصفّر يوميًا، ينقص فقط عند استلام الإدارة
        collectBalance: Number(bal.data.data?.outstanding ?? 0),
        collectShow: bal.data.data?.enabled !== false, // الميزة اختيارية لكل مندوب
        invCount: todaySales.length,
        rcpCount: todayRcp.length,
      };
      setStats(fresh); setStale(null); setFailed(false);
      await cacheSet('rep-home-stats', fresh);
    } catch {
      // انقطاع: نعرض آخر نسخة معروفة **موسومةً بزمنها**؛ فإن لم توجد فلا رقم أصلاً
      const cached = await cacheGet<NonNullable<typeof stats>>('rep-home-stats');
      if (cached?.data) { setStats(cached.data); setStale(cached.updatedAt); setFailed(false); }
      else { setStats(null); setStale(null); setFailed(true); }
    }
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
          <p className="text-[#E8C9BC] text-xs">{tr('مرحبا')}</p>
          <p className="text-white text-lg font-bold">{user.name}</p>
          {syncing && (
            <div className="flex items-center gap-1.5 mt-1">
              <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              <span className="text-[#E8C9BC] text-[11px]">{tr('مزامنة')}</span>
            </div>
          )}
        </div>
        <div className="w-12 h-12 bg-white/20 rounded-full flex items-center justify-center">
          <User size={22} className="text-white" />
        </div>
      </div>

      {/* شريط الحالة: يفصل «لا نعرف» عن «صفر» — والفرق بينهما نقدٌ في جيب المندوب */}
      {(stale !== null || failed) && (
        <div className={`rounded-2xl px-4 py-3 border text-xs flex items-center justify-between gap-3 ${failed ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          <span>
            {failed
              ? tr('تعذر تحميل الأرقام لا تعتمد على هذه الشاشة الآن')
              : `${tr('أرقام غير محدثة آخر تحديث')} ${formatDate(new Date(stale!).toISOString())}`}
          </span>
          <button onClick={load} className="shrink-0 font-semibold underline">{tr('تحديث')}</button>
        </div>
      )}

      {/* رصيد التحصيل المتراكم — لا يُصفّر يوميًا، ينقص فقط عند تسليمه للإدارة (اختياري حسب صلاحية المندوب) */}
      {stats?.collectShow && (
        <div className="bg-white rounded-3xl p-5 border-2 border-green-100 flex items-center justify-between">
          <div>
            <p className="text-xs text-gray-500">{tr('رصيد التحصيل لديك')}</p>
            <p className="text-2xl font-extrabold text-green-700 mt-1">{formatCurrency(stats.collectBalance)}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">{tr('المبلغ الذي عليك تسليمه للإدارة')}</p>
          </div>
          <div className="w-14 h-14 bg-green-50 rounded-2xl flex items-center justify-center">
            <Wallet size={26} className="text-green-600" />
          </div>
        </div>
      )}

      {/* Stats */}
      <div>
        <p className="text-[#1F1A13] font-bold text-sm mb-3">{tr('إحصائيات اليوم')}</p>
        <div className="grid grid-cols-2 gap-3">
          {/* «—» لا «٠»: رقمٌ لم يصل ليس رقماً يساوي صفراً */}
          {stat(tr('المبيعات'), stats ? formatCurrency(stats.salesTotal) : '—', TrendingUp, 'text-[#E15A30]', 'bg-[#FBEBE2] border-[#F5DACE]')}
          {stat(tr('تحصيل اليوم'), stats ? formatCurrency(stats.collectTotal) : '—', Wallet, 'text-green-600', 'bg-green-50 border-green-100')}
          {stat(tr('الفواتير'), stats ? String(stats.invCount) : '—', FileText, 'text-orange-600', 'bg-orange-50 border-orange-100')}
          {stat(tr('سندات القبض'), stats ? String(stats.rcpCount) : '—', CreditCard, 'text-purple-600', 'bg-purple-50 border-purple-100')}
        </div>
      </div>

      {/* Quick actions */}
      <div>
        <p className="text-[#1F1A13] font-bold text-sm mb-3">{tr('إجراءات سريعة')}</p>
        <div className="grid grid-cols-3 gap-3">
          {quick(tr('فاتورة'), FileText, 'text-[#E15A30]', 'bg-[#FBEBE2] border-[#F5DACE]', 'invoices')}
          {quick(tr('سند قبض'), CreditCard, 'text-green-600', 'bg-green-50 border-green-100', 'receipts')}
          {quick(tr('العملاء'), Users, 'text-orange-600', 'bg-orange-50 border-orange-100', 'customers')}
          {fuelOn && quick(tr('الوقود'), Fuel, 'text-blue-600', 'bg-blue-50 border-blue-100', 'fuel')}
          {workNumOn && quick(tr('رقم عملي'), PhoneCall, 'text-teal-700', 'bg-teal-50 border-teal-100', 'worknum')}
        </div>
      </div>

      {/* منيو المنتجات — ميزة اشتراك يفعلها المالك (كنمط ERP)؛ البطاقة تظهر فقط عند التفعيل */}
      {menuOn && <MenuLinkCard repId={user.id} />}
    </div>
  );
}

// ============ قائمة العملاء ============
function RepCustomers({ onSelect, canAdd, onAdd }: { onSelect: (c: any) => void; canAdd: boolean; onAdd: () => void }) {
  const tr = useTr();
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      // الشبكة أولاً ثم الكاش عند الانقطاع — يعمل أوف‑لاين بآخر نسخة مزامَنة
      const { data } = await fetchThenCache('customers', async () =>
        (await repApi.get('/customers', { params: { limit: 1000 } })).data.data);
      if (data) setCustomers(data as any[]);
      setLoading(false);
    })();
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center gap-2">
        <div className="flex-1">
          <SearchableSelect
            placeholder={tr('اختر العميل')}
            searchPlaceholder={tr('اكتب اسم أو جوال العميل')}
            value=""
            resetOnSelect
            options={customers.map(c => ({
              value: c.id,
              label: c.name,
              hint: Number(c.balance) > 0 ? `${tr('رصيد')} ${formatCurrency(c.balance)}` : c.phone,
              hintColor: Number(c.balance) > 0 ? 'text-red-500' : undefined,
            }))}
            onChange={(v) => { const c = customers.find(x => x.id === v); if (c) onSelect(c); }}
          />
        </div>
        {canAdd && (
          <button onClick={onAdd} title={tr('إضافة عميل')}
            className="flex-shrink-0 w-10 h-10 bg-[#E15A30] hover:bg-[#C94E28] text-white rounded-xl flex items-center justify-center">
            <Plus size={20} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-24">
        {loading ? (
          <div className="text-center text-gray-400 py-10 text-sm">{tr('جاري التحميل')}</div>
        ) : customers.length === 0 ? (
          <div className="text-center text-gray-400 py-10 text-sm">{tr('لا توجد نتائج')}</div>
        ) : customers.map(c => (
          <button key={c.id} onClick={() => onSelect(c)}
            className="w-full flex items-center gap-3 bg-white rounded-2xl p-3 mb-2 border border-gray-100 text-right hover:border-[#E8C9BC]">
            <div className="w-10 h-10 rounded-full bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center font-bold flex-shrink-0">
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
              <p className="text-[10px] text-gray-400">{tr('الرصيد')}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ============ تفاصيل العميل ============
/**
 * ورقة «رابط دفع» — ميزة الدفع الإلكتروني (اشتراك يفعّله المالك كالمنيو).
 *
 * القاعدة من المالك: الرابط يصدر من فاتورة قائمة وبكامل متبقّيها — لا رابط حر.
 * المندوب يختار الفاتورة فيصدر النظام رابط ميسر ويعرضه للنسخ أو مشاركة واتساب.
 * الإصدار يحتاج اتصالاً (إنشاء فاتورة لدى ميسر) — لا عمل أوف‑لاين هنا عمداً.
 */
function PayLinkSheet({ customer, onClose }: { customer: any; onClose: () => void }) {
  const tr = useTr();
  const [invoices, setInvoices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState<string | null>(null);
  const [link, setLink] = useState<{ payUrl: string; amount: number; invoiceNumber: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await repApi.get('/invoices', { params: { customerId: customer.id, status: 'CONFIRMED', type: 'CREDIT', limit: 50 } });
        // غير المسددة فقط — الرابط بكامل المتبقي فلا معنى لفاتورة صفرية
        setInvoices((res.data.data || []).filter((i: any) => Number(i.remainingAmt) > 0.004));
      } catch { setError(tr('تعذر تحميل الفواتير تحقق من الاتصال')); }
      setLoading(false);
    })();
  }, [customer.id]);

  const issue = async (inv: any) => {
    setIssuing(inv.id); setError(null);
    try {
      const res = await repApi.post('/paylink/issue', { invoiceId: inv.id });
      setLink({ payUrl: res.data.data.payUrl, amount: res.data.data.amount, invoiceNumber: inv.number });
    } catch (e: any) {
      setError(e?.response?.data?.message || tr('تعذر اصدار الرابط تحقق من الاتصال'));
    }
    setIssuing(null);
  };

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.payUrl); } catch {
      const ta = document.createElement('textarea');
      ta.value = link.payUrl; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };

  const waText = link
    ? encodeURIComponent(`${tr('مرحبا يمكنك سداد فاتورة')} ${link.invoiceNumber} ${tr('بمبلغ')} ${formatCurrency(link.amount)} ${tr('الكترونيا عبر الرابط')}\n${link.payUrl}`)
    : '';
  const waHref = link
    ? (customer.phone ? `https://wa.me/${String(customer.phone).replace(/[^0-9]/g, '')}?text=${waText}` : `https://wa.me/?text=${waText}`)
    : '#';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end" onClick={onClose}>
      <div className="bg-white rounded-t-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-gray-100 flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-[#2E6FB0]/10 text-[#2E6FB0] flex items-center justify-center"><Link2 size={18} /></span>
          <div className="flex-1">
            <p className="font-bold text-sm">{tr('رابط دفع الكتروني')}</p>
            <p className="text-[11px] text-gray-400">{customer.name}</p>
          </div>
          <button onClick={onClose} className="text-gray-400"><X size={20} /></button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {link ? (
            <div className="text-center">
              <p className="text-sm text-gray-600 mb-1">{tr('فاتورة')} {link.invoiceNumber}</p>
              <p className="text-2xl font-bold text-[#1F1A13] mb-3">{formatCurrency(link.amount)}</p>
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 text-[11px] text-gray-500 break-all mb-4" dir="ltr">{link.payUrl}</div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={copy} className="bg-[#1F1A13] text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
                  {copied ? <ClipboardCheck size={16} /> : <ClipboardList size={16} />} {copied ? tr('نسخ') : tr('نسخ الرابط')}
                </button>
                <a href={waHref} target="_blank" rel="noreferrer" className="bg-green-600 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
                  <MessageCircle size={16} /> {tr('ارسال واتساب')}
                </a>
              </div>
              <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">{tr('عند سداد العميل يسجل سند القبض تلقائيا باسمك وتسدد الفاتورة')}</p>
              <button onClick={() => setLink(null)} className="mt-3 text-xs text-[#2E6FB0] font-semibold">{tr('اصدار رابط لفاتورة اخرى')}</button>
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-3 leading-relaxed">{tr('اختر الفاتورة ليصدر رابط دفع بكامل المبلغ المتبقي عليها')}</p>
              {error && <p className="bg-red-50 text-red-600 text-xs rounded-xl p-3 mb-3">{error}</p>}
              {loading ? (
                <p className="text-center text-gray-400 py-8 text-sm">{tr('جاري التحميل')}</p>
              ) : invoices.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">{tr('لا توجد فواتير غير مسددة لهذا العميل')}</p>
              ) : invoices.map(inv => (
                <button key={inv.id} onClick={() => issue(inv)} disabled={!!issuing}
                  className="w-full bg-white border border-gray-200 hover:border-[#2E6FB0] rounded-xl p-3.5 mb-2 flex items-center justify-between disabled:opacity-50">
                  <div className="text-right">
                    <p className="text-sm font-bold text-gray-800">{inv.number}</p>
                    <p className="text-[10px] text-gray-400">{formatDate(inv.invoiceDate || inv.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-left">
                      <p className="text-sm font-bold text-[#2E6FB0]">{formatCurrency(inv.remainingAmt)}</p>
                      <p className="text-[10px] text-gray-400">{tr('المتبقي')}</p>
                    </div>
                    {issuing === inv.id
                      ? <span className="w-4 h-4 border-2 border-gray-300 border-t-[#2E6FB0] rounded-full animate-spin" />
                      : <Link2 size={15} className="text-gray-300" />}
                  </div>
                </button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CustomerDetail({ customer, repName, company, perms, onClose, onInvoice, onReceipt, onReturn, onStatement, onOpenDoc, onLogVisit, visitActive, visitElapsedLabel, onStartVisit, paylinkOn }: {
  customer: any; repName: string; company: Company | null;
  /** ميزة الدفع الإلكتروني مفعلة لهذه الشركة (بوابة المالك كالمنيو) */
  paylinkOn?: boolean;
  perms: RepUser;
  onClose: () => void; onInvoice: () => void; onReceipt: () => void; onReturn: () => void;
  onStatement: (doc: StatementDoc) => void;
  onOpenDoc: (doc: InvoiceDoc | ReceiptDoc) => void;
  onLogVisit: () => void;
  /** مؤقّت الزيارة: نشط لهذا العميل؟ + العدّاد الحيّ + بدء التوقيت */
  visitActive: boolean; visitElapsedLabel: string; onStartVisit: () => void;
}) {
  const tr = useTr();
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  // 'unassigned' = نزعت الإدارة هذا العميل (عزل العملاء)، 'offline' = تعذّر الاتصال.
  // نميّزهما عن «لا توجد حركات» كي لا يظنّ المندوب أن العميل بلا حركات فعلاً.
  const [statementError, setStatementError] = useState<'unassigned' | 'offline' | null>(null);
  const [payLinkOpen, setPayLinkOpen] = useState(false);

  // فتح مستند الحركة (فاتورة/سند) من كشف الحساب
  const openDoc = async (e: any) => {
    const invId = e.invoiceId; const recId = e.receiptId;
    if (!invId && !recId) return;
    setOpeningId(e.id);
    try {
      if (invId) {
        const res = await repApi.get(`/invoices/${invId}`);
        onOpenDoc(invoiceDocFromDetail(res.data.data, repName, company));
      } else {
        const res = await repApi.get(`/receipts/${recId}`);
        onOpenDoc(receiptDocFromDetail(res.data.data, repName, company));
      }
    } catch { /* */ }
    setOpeningId(null);
  };
  // العميل نُزع من هذا المندوب ⇒ كل إجراء عليه سيُرفض من الخادم، فنمنعه في الواجهة
  const unassigned = statementError === 'unassigned';
  const canCreateInvoice = perms.canCreateInvoice !== false && !unassigned;
  const canSellAnyType = perms.canSellOnCredit !== false || perms.canSellInCash !== false;
  const canCreateReceipt = perms.canCreateReceipt !== false && !unassigned;
  const canViewStatement = perms.canViewStatement !== false;

  useEffect(() => {
    if (!canViewStatement) { setEntries([]); setLoading(false); return; }
    (async () => {
      try {
        const res = await repApi.get(`/customers/${customer.id}/statement`);
        setEntries(res.data.data.entries);
        setStatementError(null);
      } catch (err) {
        setEntries([]);
        const status = (err as { response?: { status?: number } })?.response?.status;
        // 404/403 = العميل لم يعد مُسنَداً لهذا المندوب (أو حُذف). غير ذلك = انقطاع/خلل مؤقّت.
        setStatementError(status === 404 || status === 403 ? 'unassigned' : 'offline');
      }
      setLoading(false);
    })();
  }, [customer.id, canViewStatement]);

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold flex-1 truncate">{customer.name}</span>
        {/* مؤقّت الزيارة: يبدأ بضغطة، ويظهر عدّاداً حيّاً حتى الخروج من الملفّ.
            يُخفى إن نُزع العميل (لا زيارة لعميل غير مُسنَد). */}
        {!unassigned && (
          visitActive ? (
            <span className="flex items-center gap-1.5 bg-[#2E6FB0] rounded-full px-3 py-1.5 text-sm font-bold tabular-nums"
              title={tr('الزيارة جارية تنتهي عند خروجك من ملف العميل')}>
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
              {visitElapsedLabel}
            </span>
          ) : (
            <button onClick={onStartVisit}
              className="flex items-center gap-1.5 bg-[#5FBE92] rounded-full px-3 py-1.5 text-sm font-bold active:scale-95 transition"
              title={tr('ابدأ توقيت الزيارة')}>
              <Timer size={15} /> {tr('بدء الزيارة')}
            </button>
          )
        )}
      </div>

      {/* شريط تذكير أسفل الرأس أثناء التوقيت — يوضّح أن الوقت يُحسب */}
      {visitActive && (
        <div className="bg-[#2E6FB0]/10 text-[#2E6FB0] text-[11px] px-4 py-1.5 flex items-center gap-1.5 border-b border-[#2E6FB0]/20">
          <Square size={9} className="fill-current" /> {tr('يحسب وقت الزيارة الآن سيسجل تلقائيا عند خروجك')}
        </div>
      )}

      <div className="p-4 overflow-y-auto flex-1 pb-4">
        {/* نُزع العميل من المندوب (عزل العملاء): تنبيه صريح بدل صمت مضلّل */}
        {unassigned && (
          <div className="mb-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl p-3.5 text-sm leading-relaxed">
            <p className="font-bold mb-1">{tr('هذا العميل لم يعد ضمن عملائك')}</p>
            <p className="text-xs">{tr('نقلته الإدارة إلى مندوب آخر فلا يمكنك إصدار فاتورة أو سند أو زيارة له راجع الإدارة إن كان ذلك غير متوقع')}</p>
          </div>
        )}

        {/* Summary */}
        <div className={`bg-gradient-to-l from-[#1F1A13] to-[#E15A30] rounded-3xl p-5 text-white ${unassigned ? 'opacity-60' : ''}`}>
          <p className="font-bold text-lg">{customer.name}</p>
          {customer.businessName && <p className="text-[#E8C9BC] text-sm">{customer.businessName}</p>}
          <p className="text-[#E8C9BC] text-xs mb-4">{customer.phone}</p>
          {/* الأرقام المالية مخزّنة محلياً وقد تكون قديمة — نخفيها بعد نزع العميل بدل عرض رقم مضلّل */}
          {unassigned ? (
            <p className="text-[#E8C9BC] text-xs text-center py-2">{tr('البيانات المالية غير متاحة')}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className={`font-bold text-sm ${Number(customer.balance) > 0 ? 'text-red-300' : 'text-green-300'}`}>{formatCurrency(customer.balance)}</p>
                <p className="text-[#E8C9BC] text-[10px]">{tr('الرصيد')}</p>
              </div>
              <div>
                <p className="font-bold text-sm">{formatCurrency(customer.creditLimit)}</p>
                <p className="text-[#E8C9BC] text-[10px]">{tr('الحد الائتماني')}</p>
              </div>
              <div>
                <p className="font-bold text-sm">{customer.paymentDays} {tr('يوم')}</p>
                <p className="text-[#E8C9BC] text-[10px]">{tr('فترة السداد')}</p>
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button onClick={onInvoice} disabled={!canCreateInvoice || !canSellAnyType}
            className="bg-[#E15A30] disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <FileText size={16} /> {tr('فاتورة جديدة')}
          </button>
          <button onClick={onReceipt} disabled={!canCreateReceipt} className="bg-green-600 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <CreditCard size={16} /> {tr('سند قبض')}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <button onClick={onReturn} disabled={unassigned}
            className="bg-amber-600 hover:bg-amber-700 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <RotateCcw size={16} /> {tr('فاتورة إرجاع')}
          </button>
          <button
            onClick={() => onStatement(statementDocFromData(customer, entries, repName, company))}
            disabled={loading || !canViewStatement || unassigned || !!statementError}
            className="bg-slate-700 hover:bg-slate-800 disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-60">
            <FileBarChart2 size={16} /> {tr('كشف حساب')}
          </button>
        </div>
        {/* تسجيل زيارة ميدانية: ملاحظة + صور رفوف مع إثبات موقع — تراها الإدارة في خريطة التتبّع */}
        <button onClick={onLogVisit} disabled={unassigned}
          className="w-full mt-3 bg-[#5FBE92] hover:bg-[#4EA97E] disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
          <ClipboardCheck size={16} /> {tr('تسجيل زيارة')}
        </button>
        {/* الدفع الإلكتروني: رابط سداد يشاركه المندوب واتساب — يظهر فقط حين يفعل المالك الميزة */}
        {paylinkOn && (
          <button onClick={() => setPayLinkOpen(true)} disabled={unassigned}
            className="w-full mt-3 bg-[#2E6FB0] hover:bg-[#255C94] disabled:bg-gray-300 disabled:text-gray-500 text-white rounded-xl py-3 font-semibold text-sm flex items-center justify-center gap-2">
            <Link2 size={16} /> {tr('رابط دفع الكتروني')}
          </button>
        )}
        {payLinkOpen && <PayLinkSheet customer={customer} onClose={() => setPayLinkOpen(false)} />}

        {/* Statement */}
        <p className="font-bold text-gray-700 text-sm mt-5 mb-2">{tr('كشف الحساب')}</p>
        {!canViewStatement ? (
          <p className="text-center text-gray-400 py-6 text-sm">{tr('لا تملك صلاحية عرض كشف الحساب')}</p>
        ) : loading ? (
          <p className="text-center text-gray-400 py-6 text-sm">{tr('جاري التحميل')}</p>
        ) : statementError === 'unassigned' ? (
          <p className="text-center text-amber-700 py-6 text-sm">{tr('كشف الحساب غير متاح هذا العميل لم يعد ضمن عملائك')}</p>
        ) : statementError === 'offline' ? (
          <p className="text-center text-gray-400 py-6 text-sm">{tr('تعذر تحميل كشف الحساب تحقق من الاتصال')}</p>
        ) : entries.length === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">{tr('لا توجد حركات')}</p>
        ) : entries.map(e => {
          const isDebit = Number(e.debit) > 0;
          const hasDoc = !!(e.invoiceId || e.receiptId); // الحركات المرتبطة بفاتورة/سند قابلة للفتح
          return (
            <button key={e.id} type="button" onClick={() => hasDoc && openDoc(e)} disabled={!hasDoc}
              className={`w-full text-right bg-white rounded-xl p-3 mb-2 border border-gray-100 flex items-center justify-between ${hasDoc ? 'hover:border-[#E8C9BC] active:bg-gray-50' : 'cursor-default'}`}>
              <div className="flex items-center gap-2">
                <span className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${isDebit ? 'bg-red-50 text-red-500' : 'bg-green-50 text-green-500'}`}>
                  {isDebit ? '↑' : '↓'}
                </span>
                <div className="text-right">
                  <p className="text-xs font-medium text-gray-700">{e.description}</p>
                  <p className="text-[10px] text-gray-400">
                    {formatDate(e.entryDate)}
                    {e.invoice?.number ? ` • ${e.invoice.number}` : e.receipt?.number ? ` • ${e.receipt.number}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="text-left">
                  <p className={`text-xs font-bold ${isDebit ? 'text-red-600' : 'text-green-600'}`}>
                    {isDebit ? formatCurrency(e.debit) : formatCurrency(e.credit)}
                  </p>
                  <p className="text-[10px] text-gray-400">{tr('رصيد')}: {formatCurrency(e.balance)}</p>
                </div>
                {hasDoc && (openingId === e.id
                  ? <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-[#E15A30] rounded-full animate-spin" />
                  : <FileDown size={14} className="text-gray-300" />)}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============ تسجيل زيارة ميدانية ============
// المندوب عند العميل: ملاحظة نصية + صور (الرفوف/المنتجات) + إثبات موقع GPS. تعمل أوف‑لاين
// (تُصفّ في الـOutbox وتُرفع عند الاتصال) وتظهر للإدارة/المشرف من خريطة تتبّع المندوب.
function LogVisit({ customer, onClose, onDone }: { customer: any; onClose: () => void; onDone: (offline: boolean) => void }) {
  const tr = useTr();
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<string[]>([]); // data URLs مضغوطة
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [gps, setGps] = useState<'getting' | 'ok' | 'denied'>('getting');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState<null | 'online' | 'offline'>(null);

  // التقاط موقع المندوب (إثبات الوصول) فور فتح النافذة
  useEffect(() => {
    if (!navigator.geolocation) { setGps('denied'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }); setGps('ok'); },
      () => setGps('denied'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  }, []);

  // ضغط الصورة عبر canvas (أقصى بُعد 1280 وجودة 0.7) — يبقيها صغيرة للرفع والتخزين
  const compress = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1280;
        let { width, height } = img;
        if (width > max || height > max) {
          const s = Math.min(max / width, max / height);
          width = Math.round(width * s); height = Math.round(height * s);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => reject(new Error('img'));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error('read'));
    reader.readAsDataURL(file);
  });

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // يسمح بإعادة اختيار نفس الملف لاحقاً
    for (const f of files) {
      if (photos.length >= 8) { setMsg(tr('الحد الأقصى 8 صور')); break; }
      try { const url = await compress(f); setPhotos(prev => (prev.length < 8 ? [...prev, url] : prev)); }
      catch { /* تجاهل ملف تالف */ }
    }
  };

  const save = async () => {
    if (!note.trim() && photos.length === 0) { setMsg(tr('أضف ملاحظة أو صورة على الأقل')); return; }
    setBusy(true); setMsg('');
    const clientRef = newClientRef();
    const clientCreatedAt = new Date().toISOString();
    // عميل أُنشئ أوف‑لاين يُشار إليه بـ customerClientRef فيحلّه الخادم
    const custRef = customer._offline ? { customerClientRef: customer.clientRef } : { customerId: customer.id };
    const payload: Record<string, unknown> = {
      ...custRef,
      note: note.trim() || undefined,
      lat: coords?.lat, lng: coords?.lng,
      photos: photos.length ? photos : undefined,
      clientRef, createdAt: clientCreatedAt,
    };
    try {
      await repApi.post('/visits', payload);
      setDone('online');
    } catch (err) {
      if (isNetworkError(err)) {
        await outboxAdd({ clientRef, repId: currentRepId(), kind: 'visit', payload, status: 'queued', clientCreatedAt });
        setDone('offline');
      } else {
        setMsg((err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر حفظ الزيارة'));
        setBusy(false);
      }
    }
  };

  if (done) return (
    <div className="h-full flex flex-col items-center justify-center bg-gray-50 p-8 text-center">
      <div className="w-16 h-16 rounded-full bg-[#5FBE92] flex items-center justify-center mb-4">
        <Check size={32} className="text-white" />
      </div>
      <p className="font-bold text-gray-800 text-lg">{tr('تم تسجيل الزيارة')}</p>
      <p className="text-sm text-gray-500 mt-1">
        {done === 'offline' ? tr('محفوظة على الجهاز وسترفع عند عودة الاتصال') : tr('وصلت الزيارة وصورها للإدارة')}
      </p>
      <button onClick={() => onDone(done === 'offline')}
        className="mt-6 bg-[#1F1A13] text-white rounded-xl px-8 py-3 font-semibold text-sm">{tr('تم')}</button>
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">{tr('تسجيل زيارة')}</span>
      </div>

      <div className="p-4 overflow-y-auto flex-1">
        <p className="text-sm font-semibold text-gray-700">{customer.name}</p>
        {/* حالة الموقع — إثبات وصول المندوب */}
        <div className={`mt-2 inline-flex items-center gap-1.5 text-[11px] rounded-full px-2.5 py-1 ${
          gps === 'ok' ? 'bg-green-50 text-green-600' : gps === 'getting' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500'}`}>
          <MapPin size={12} />
          {gps === 'ok' ? tr('تم تحديد موقعك') : gps === 'getting' ? tr('جار تحديد الموقع') : tr('الموقع غير متاح')}
        </div>

        {/* ملاحظة نصية */}
        <label className="block text-xs font-medium text-gray-500 mt-4 mb-1">{tr('ملاحظة الزيارة')}</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4}
          placeholder={tr('مثال تم عرض المنتجات الجديدة الرفوف منظمة طلب توريد الأسبوع القادم')}
          className="w-full border border-gray-200 rounded-xl p-3 text-sm resize-none focus:outline-none focus:border-[#E15A30]" />

        {/* صور الزيارة (الرفوف/المنتجات) — الكاميرا مباشرة على الجوّال */}
        <label className="block text-xs font-medium text-gray-500 mt-4 mb-1">{tr('صور الزيارة')} ({photos.length}/8)</label>
        <div className="grid grid-cols-3 gap-2">
          {photos.map((p, i) => (
            <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-gray-200">
              <img src={p} alt="" className="w-full h-full object-cover" />
              <button onClick={() => setPhotos(prev => prev.filter((_, idx) => idx !== i))}
                className="absolute top-1 left-1 w-6 h-6 rounded-full bg-black/60 text-white flex items-center justify-center">
                <X size={14} />
              </button>
            </div>
          ))}
          {photos.length < 8 && (
            <label className="aspect-square rounded-xl border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-gray-400 cursor-pointer active:bg-gray-100">
              <Camera size={22} />
              <span className="text-[10px] mt-1">{tr('تصوير')}</span>
              <input type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={onPick} />
            </label>
          )}
        </div>

        {msg && <p className="text-red-500 text-xs mt-3 text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t border-gray-100 bg-white">
        <button onClick={save} disabled={busy}
          className="w-full bg-[#5FBE92] disabled:bg-gray-300 text-white rounded-xl py-3.5 font-bold text-sm flex items-center justify-center gap-2">
          {busy ? <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" /> : <ClipboardCheck size={18} />}
          {tr('حفظ الزيارة')}
        </button>
      </div>
    </div>
  );
}

// ============ إنشاء فاتورة (بيع أو إرجاع) ============
function CreateInvoice({ customer, repName, company, mode = 'sale', perms, onClose, onDone }: { customer: any; repName: string; company: Company | null; mode?: 'sale' | 'return'; perms: RepUser; onClose: () => void; onDone: (doc: InvoiceDoc) => void }) {
  const tr = useTr();
  const isReturn = mode === 'return';
  const canSellOnCredit = perms.canSellOnCredit !== false;
  const canSellInCash = perms.canSellInCash !== false;
  const canSellAnyType = canSellOnCredit || canSellInCash;
  const [type, setType] = useState<'CASH' | 'CREDIT'>(canSellOnCredit ? 'CREDIT' : 'CASH');
  const [returnReason, setReturnReason] = useState<'NORMAL' | 'DAMAGED' | 'EXCHANGE'>('NORMAL'); // سبب المرتجع
  const [deliveryDate, setDeliveryDate] = useState(''); // تاريخ التسليم الاختياري — فارغ = لا يظهر بالفاتورة
  const [products, setProducts] = useState<any[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [lines, setLines] = useState<any[]>([]);
  const [showCart, setShowCart] = useState(false); // عرض الأصناف المختارة للمراجعة قبل الإصدار
  const [showScanner, setShowScanner] = useState(false); // ماسح الباركود
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  // جلب قائمة المنتجات كاملة (الاختيار عبر قائمة منسدلة بالتصفية + شبكة للتصفّح)
  useEffect(() => {
    (async () => {
      setLoadingProducts(true);
      const { data } = await fetchThenCache('products', async () =>
        (await repApi.get('/products', { params: { status: 'ACTIVE', limit: 1000 } })).data.data);
      if (data) setProducts(data as any[]);
      setLoadingProducts(false);
    })();
  }, []);

  // اسعار هذا العميل الخاصة (صافية) — بدونها يعرض التطبيق basePrice الاعلى ويرفضه
  // الخادم لان سعر العميل هو السقف المرجعي. كاش مستقل لكل عميل: مفتاح مشترك كان
  // يسرب تسعير عميل الى اخر في الوضع الاوف-لاين. وغيابها لا يعطل شيئا (يسقط لـbasePrice).
  const [custPrices, setCustPrices] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!customer?.id || customer._offline) return;
    (async () => {
      const { data } = await fetchThenCache(`custprices:${customer.id}`, async () =>
        (await repApi.get(`/products/customer-prices/${customer.id}`)).data.data);
      if (data) setCustPrices(Object.fromEntries((data as any[]).map(r => [r.productId, Number(r.price)])));
    })();
  }, [customer?.id]);

  // سباق تحميل: بند اضيف قبل وصول اسعار العميل يبقى بالسعر الاساسي. نصحح فقط الاسطر
  // التي لم يمسها المندوب (unitPrice ما زال يساوي refPrice) فلا نطمس تعديلا يدويا.
  useEffect(() => {
    if (!Object.keys(custPrices).length) return;
    setLines(prev => prev.map(l => {
      const cp = custPrices[l.productId];
      if (cp === undefined) return l;
      const fresh = roundDecimal(cp * (1 + Number(l.taxPct) / 100), currencyDecimals(getActiveCurrency()));
      if (fresh === l.refPrice) return l;
      const untouched = Math.abs(Number(l.unitPrice) - Number(l.refPrice)) < 1e-9;
      return { ...l, refPrice: fresh, ...(untouched ? { unitPrice: fresh } : {}) };
    }));
  }, [custPrices]);

  // السعر الذي يُدخله المندوب شامل الضريبة؛ نشتقّ السعر قبل الضريبة للنظام
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // بخانات عملة الدولة: round2 الثابتة صارت — بعد تخزين السعر كما يرسل — تقص الفلس
  // الثالث في اسواق الدينار (KWD/BHD/OMR) فيخالف المخزن ما اعلن
  // السعر المتفق مع هذا العميل ان وجد، وإلا السعر الاساسي — وكلاهما صافٍ فيحول لشامل
  const netPriceOf = (p: any) => custPrices[p.id] ?? Number(p.basePrice);
  const inclPrice = (p: any) => roundDecimal(netPriceOf(p) * (1 + Number(p.taxPct) / 100), currencyDecimals(getActiveCurrency())); // السعر شامل الضريبة

  const addProduct = (p: any) => {
    // تحديث دالّي + نسخ غير مُفسِد — يضمن صحّة المسح السريع المتتابع للباركود
    setLines(prev => {
      const idx = prev.findIndex(l => l.productId === p.id);
      if (idx >= 0) { const c = [...prev]; c[idx] = { ...c[idx], qty: c[idx].qty + 1 }; return c; }
      return [...prev, { productId: p.id, name: p.name, unit: p.unit, image: p.image || null, qty: 1, unitPrice: inclPrice(p), refPrice: inclPrice(p), discountPct: 0, taxPct: Number(p.taxPct) }];
    });
  };

  // مسح باركود مستمرّ → إيجاد الصنف بحقل barcode وإضافته؛ يُعيد نتيجة للعرض داخل الماسح (يبقى مفتوحاً)
  const onScan = (code: string): { ok: boolean; label: string } => {
    const p = products.find((x) => x.barcode && String(x.barcode) === code);
    if (p) { addProduct(p); return { ok: true, label: p.name }; }
    return { ok: false, label: `${tr('لا يوجد صنف بهذا الباركود')}: ${code}` };
  };

  // حدود صلاحيات المندوب (تُفرض أيضاً في الخادم كحارس نهائي)
  const maxDisc = perms?.maxDiscountPct ?? 0;
  const upd = (i: number, f: string, v: number) => {
    const c = [...lines];
    if (f === 'discountPct') v = Math.max(0, Math.min(v || 0, maxDisc));        // حدّ الخصم المسموح
    if (f === 'unitPrice') {
      if (!perms?.canChangePrice) return;                                       // لا يملك تغيير السعر
      if (!perms?.canSellBelowPrice) v = Math.max(v || 0, c[i].refPrice);       // لا يبيع بأقل من السعر
    }
    if (f === 'lineTotal') {
      // تعديل إجمالي البند: يُشتق السعر الشامل عكسياً — بنفس صلاحيات السعر وحدوده
      if (!perms?.canChangePrice) return;
      const p = priceFromLineTotal(v, c[i].qty, c[i].discountPct, c[i].taxPct, true);
      if (p === null) return;
      c[i].unitPrice = perms?.canSellBelowPrice ? p : Math.max(p, c[i].refPrice);
      setLines(c); return;
    }
    c[i][f] = v; setLines(c);
  };

  const qtyInCart = (id: string) => lines.find(l => l.productId === id)?.qty || 0;
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);

  // الإجماليات من **المحرّك المشترك** بوضع «الأسعار شاملة»: سعر البند كما
  // أُعلن للعميل يبقى حرفياً هو المعروض والمرسل والمخزون — التحويل الوسيط
  // round2(preTax) كان يجعل سعر 10.00 المعلن يُقيَّد 10.01 ويطبع ورقة تناقض نفسها
  const dec = currencyDecimals(getActiveCurrency());
  const repCalc = computeInvoiceTotals(
    lines.map(l => ({ qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct })),
    { companyVat: 15, decimals: dec, invoiceDiscountPct: 0, pricesIncludeTax: true }, // taxPct يأتي مع كل بند
  );
  const subtotal = repCalc.subtotal;
  const discount = repCalc.discountAmt;
  const tax = repCalc.taxAmt;
  const total = repCalc.total;

  const submit = async () => {
    if (lines.length === 0) { setMsg(tr('أضف صنفا')); return; }
    if (perms.canCreateInvoice === false) { setMsg(tr('لا تملك صلاحية إنشاء فاتورة')); return; }
    if (!isReturn && !canSellAnyType) { setMsg(tr('لا تملك صلاحية البيع النقدي أو الآجل')); return; }
    if (!isReturn && type === 'CREDIT' && !canSellOnCredit) { setMsg(tr('لا تملك صلاحية البيع الآجل')); return; }
    if (!isReturn && type === 'CASH' && !canSellInCash) { setMsg(tr('لا تملك صلاحية البيع النقدي')); return; }
    setLoading(true); setMsg('');
    const clientRef = newClientRef();
    const clientCreatedAt = new Date().toISOString();
    // عميل أُنشئ أوف‑لاين (بلا id خادمي بعد) يُشار إليه بـ customerClientRef فيحلّه الخادم
    const custRef = customer._offline ? { customerClientRef: customer.clientRef } : { customerId: customer.id };
    const payload = {
      ...custRef, type: isReturn ? 'RETURN' : type, discountPct: 0,
      ...(isReturn && { returnReason }),
      // الاسعار شاملة كما اعلنت للعميل — المحرك (عميلا وخادما) يشتق الضريبة داخليا
      pricesIncludeTax: true,
      items: lines.map(l => ({ productId: l.productId, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct })),
      ...(deliveryDate && { deliveryDate }), // اختياري — لا يُرسل إن لم يُحدد
      clientRef, clientCreatedAt, // idempotency + العمل دون اتصال
    };
    // الطباعة من نتائج المحرك نفسها: سطر البند يساوي حصته من الاجمالي حتما
    const printItems = lines.map((l, i) => ({ name: l.name, unit: l.unit, qty: l.qty, unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct, lineTotal: repCalc.items[i].lineTotal, taxAmt: repCalc.items[i].taxAmt }));
    try {
      const res = await repApi.post('/invoices', payload);
      const inv = res.data.data;
      onDone({
        kind: 'invoice', number: inv.number, date: inv.invoiceDate, deliveryDate: inv.deliveryDate ?? (deliveryDate || undefined), type, isReturn,
        company, customer, repName, items: printItems,
        subtotal, discount, tax, total,
        paidAmt: Number(inv.paidAmt), remainingAmt: Number(inv.remainingAmt),
      });
    } catch (err: any) {
      // انقطاع الشبكة ⇒ نلتقط الفاتورة في الصفّ الصادر ونطبع برقم مؤقّت (ترتفع عند الاتصال)
      if (isNetworkError(err)) {
        const provider = (company as any)?.einvoiceProvider;
        if (['eta', 'peppol', 'ttn'].includes(provider)) {
          // أسواق التخليص الحكومي اللحظي: لا يُسمح بالإصدار أوف‑لاين (قرار المالك)
          setMsg(tr('لا يمكن إصدار فاتورة دون اتصال في هذا السوق يتطلب تخليصا حكوميا لحظيا')); setLoading(false); return;
        }
        const localNumber = 'محلي-' + clientRef.slice(0, 8).toUpperCase();
        await outboxAdd({ clientRef, repId: currentRepId(), kind: 'invoice', payload, status: 'queued', clientCreatedAt, localNumber });
        const paid = type === 'CASH' && !isReturn ? total : 0;
        onDone({
          kind: 'invoice', number: localNumber, offline: true, date: clientCreatedAt, deliveryDate: deliveryDate || undefined, type, isReturn,
          company, customer, repName, items: printItems,
          subtotal, discount, tax, total,
          paidAmt: paid, remainingAmt: isReturn ? 0 : total - paid,
        });
      } else {
        setMsg(err?.response?.data?.message || tr('تعذر إصدار المستند حاول مجددا')); setLoading(false);
      }
    }
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      {showScanner && (
        <BarcodeScanner
          onDetect={onScan}
          onClose={() => setShowScanner(false)}
          onProceed={() => { setShowScanner(false); setShowCart(true); }}
          itemCount={lines.length}
        />
      )}
      <div className={`${isReturn ? 'bg-amber-700' : 'bg-[#1F1A13]'} text-white p-4 flex items-center gap-3`}>
        <button onClick={() => showCart ? setShowCart(false) : onClose()}><ArrowRight size={20} /></button>
        <span className="font-bold">{showCart ? tr('مراجعة الأصناف') : isReturn ? tr('فاتورة إرجاع') : tr('فاتورة جديدة')}</span>
      </div>

      {/* ===== شاشة اختيار المنتجات (شبكة أيقونات) ===== */}
      {!showCart ? (
        <>
          <div className="px-3 pt-3">
            <div className={`${isReturn ? 'bg-amber-50 border-amber-100' : 'bg-[#FBEBE2] border-[#F5DACE]'} rounded-xl p-2.5 mb-2 flex items-center gap-2 border`}>
              <User size={15} className={isReturn ? 'text-amber-700' : 'text-[#E15A30]'} />
              <span className="font-semibold text-xs text-gray-800">{customer.name}</span>
            </div>

            {isReturn ? (
              <div className="mb-2 space-y-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-600">{tr('سبب الإرجاع')}:</span>
                  {([['NORMAL', 'مرتجع عادي'], ['DAMAGED', 'بضاعة تالفة'], ['EXCHANGE', 'استبدال']] as const).map(([v, label]) => (
                    <button key={v} onClick={() => setReturnReason(v)}
                      className={`px-2.5 py-1 rounded-full text-[11px] ${returnReason === v ? 'bg-amber-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                      {tr(label)}
                    </button>
                  ))}
                </div>
                <div className="bg-amber-50 border border-amber-100 rounded-xl p-2 text-[11px] text-amber-800 text-center">
                  {tr('مرتجع مبيعات سيخفض رصيد العميل بقيمة المرتجع')}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs text-gray-600">{tr('النوع')}:</span>
                <button disabled={!canSellOnCredit} onClick={() => setType('CREDIT')} className={`px-3 py-1 rounded-full text-xs disabled:bg-gray-100 disabled:text-gray-300 ${type === 'CREDIT' ? 'bg-orange-500 text-white' : 'bg-gray-100 text-gray-600'}`}>{tr('آجل')}</button>
                <button disabled={!canSellInCash} onClick={() => setType('CASH')} className={`px-3 py-1 rounded-full text-xs disabled:bg-gray-100 disabled:text-gray-300 ${type === 'CASH' ? 'bg-green-500 text-white' : 'bg-gray-100 text-gray-600'}`}>{tr('نقدي')}</button>
              </div>
            )}
            {!isReturn && !canSellAnyType && <p className="text-[11px] text-red-500 mb-2">{tr('لا تملك صلاحية البيع النقدي أو الآجل')}.</p>}

            <div className="mb-2 flex items-stretch gap-2">
              <div className="flex-1">
                <SearchableSelect
                  placeholder={tr('اختر صنفا لإضافته')}
                  searchPlaceholder={tr('اكتب اسم الصنف')}
                  value=""
                  resetOnSelect
                  options={products.map(p => ({ value: p.id, label: p.name, hint: formatCurrency(inclPrice(p)) }))}
                  onChange={(v) => { const p = products.find(x => x.id === v); if (p) addProduct(p); }}
                />
              </div>
              <button type="button" onClick={() => setShowScanner(true)} title={tr('مسح الباركود')}
                className="shrink-0 px-3 rounded-xl bg-[#1F1A13] text-white flex items-center justify-center">
                <ScanLine size={18} />
              </button>
            </div>
          </div>

          {/* شبكة المنتجات */}
          <div className="flex-1 overflow-y-auto px-3 pb-28">
            {loadingProducts ? (
              <div className="text-center text-gray-400 py-10 text-sm">{tr('جاري التحميل')}</div>
            ) : products.length === 0 ? (
              <div className="text-center text-gray-400 py-10 text-sm">{tr('لا توجد أصناف')}</div>
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

          {/* شريط العربة السفلي */}
          {lines.length > 0 && (
            <div className="absolute bottom-0 right-0 left-0 p-3 bg-white border-t shadow-lg">
              <button onClick={() => setShowCart(true)}
                className={`w-full ${isReturn ? 'bg-amber-600' : 'bg-[#E15A30]'} text-white font-semibold py-3 rounded-xl flex items-center justify-between px-4`}>
                <span className="flex items-center gap-2">
                  <span className="bg-white/25 w-6 h-6 rounded-full flex items-center justify-center text-xs">{itemCount}</span>
                  {tr('مراجعة وإصدار')}
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
                  {[['الكمية', 'qty'], ['السعر شامل', 'unitPrice'], ['خصم%', 'discountPct']].map(([lbl, f]) => {
                    const locked = (f === 'unitPrice' && !perms?.canChangePrice) || (f === 'discountPct' && maxDisc === 0);
                    return (
                      <div key={f}>
                        <label className="text-[10px] text-gray-400 flex items-center gap-0.5">
                          {tr(lbl)}{f === 'discountPct' && maxDisc > 0 && <span className="text-[#E15A30]">({tr('حد')} {maxDisc}%)</span>}
                        </label>
                        <DecimalInput readOnly={locked} min={0}
                          className={`input text-center !py-1.5 text-sm ${locked ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''}`}
                          value={l[f]} onCommit={v => upd(i, f, v)} title={locked ? tr('غير مصرح لك بتعديل هذا الحقل') : undefined} />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between items-center mt-2 text-xs">
                  <span className="text-gray-400">{tr('منها ضريبة')}: {formatCurrency(repCalc.items[i]?.taxAmt ?? 0)}</span>
                  {perms?.canChangePrice ? (
                    <span className="inline-flex items-center gap-1">
                      <DecimalInput min={0}
                        className="input !py-1 !px-2 text-sm font-bold text-[#E15A30] w-28 text-center"
                        title={tr('عدل الاجمالي وسينعكس على السعر الشامل')}
                        value={repCalc.items[i]?.lineTotal ?? 0}
                        onCommit={v => upd(i, 'lineTotal', v)} />
                    </span>
                  ) : (
                    <span className="font-bold text-[#E15A30]">{formatCurrency(repCalc.items[i]?.lineTotal ?? 0)}</span>
                  )}
                </div>
              </div>
            ))}

            <div className="bg-white rounded-xl p-4 mt-2 border border-gray-100 space-y-1.5 text-sm">
              <div className="flex justify-between text-gray-500"><span>{tr('قبل الخصم')}</span><span>{formatCurrency(subtotal)}</span></div>
              <div className="flex justify-between text-red-500"><span>{tr('الخصم')}</span><span>- {formatCurrency(discount)}</span></div>
              <div className="flex justify-between text-[#E15A30]"><span>{tr('الضريبة')} {(() => { const ps = [...new Set(lines.map(l => Number(l.taxPct)))]; return ps.length === 1 ? `${ps[0]}%` : tr('نسب متعددة'); })()}</span><span>{formatCurrency(tax)}</span></div>
              <div className="flex justify-between font-bold text-base border-t pt-2"><span>{tr('الإجمالي')}</span><span>{formatCurrency(total)}</span></div>
            </div>
            {!isReturn && (
              <div className="bg-white rounded-xl p-3 mt-2 border border-gray-100">
                <label className="text-[10px] text-gray-400 block mb-1">{tr('تاريخ التسليم (اختياري — لا يظهر بالفاتورة إن تُرك فارغاً)')}</label>
                <div className="flex items-center gap-2">
                  <input type="date" className="input !py-1.5 text-sm flex-1" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} />
                  {deliveryDate && <button type="button" className="text-xs text-red-500" onClick={() => setDeliveryDate('')}>{tr('مسح')}</button>}
                </div>
              </div>
            )}
            {msg && <p className="text-red-500 text-xs mt-2 text-center">{msg}</p>}
          </div>

          <div className="p-4 border-t bg-white">
            <button onClick={submit} disabled={loading || (!isReturn && (perms.canCreateInvoice === false || !canSellAnyType))} className={`w-full ${isReturn ? 'bg-amber-600 disabled:bg-amber-400' : 'bg-[#E15A30] disabled:bg-[#E89B7E]'} text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2`}>
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
              {isReturn ? tr('إصدار فاتورة الإرجاع') : tr('إصدار الفاتورة')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ============ إنشاء سند قبض ============
function CreateReceipt({ customer, repName, company, perms, onClose, onDone }: { customer: any; repName: string; company: Company | null; perms: RepUser; onClose: () => void; onDone: (doc: ReceiptDoc) => void }) {
  const tr = useTr();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const submit = async () => {
    if (perms.canCreateReceipt === false) { setMsg(tr('لا تملك صلاحية إصدار سند قبض')); return; }
    if (!amount || Number(amount) <= 0) { setMsg(tr('أدخل مبلغا صحيحا')); return; }
    setLoading(true); setMsg('');
    const clientRef = newClientRef();
    const clientCreatedAt = new Date().toISOString();
    const custRef = customer._offline ? { customerClientRef: customer.clientRef } : { customerId: customer.id };
    const payload = { ...custRef, amount: Number(amount), paymentMethod: method, notes: notes || undefined, clientRef, clientCreatedAt };
    try {
      const res = await repApi.post('/receipts', payload);
      const rcp = res.data.data;
      onDone({
        kind: 'receipt', number: rcp.number, date: rcp.receiptDate,
        company, customer, repName, amount: Number(amount), paymentMethod: method, notes: notes || undefined,
      });
    } catch (err: any) {
      // انقطاع الشبكة ⇒ التقاط السند في الصفّ وطباعته برقم مؤقّت
      if (isNetworkError(err)) {
        const localNumber = 'محلي-' + clientRef.slice(0, 8).toUpperCase();
        await outboxAdd({ clientRef, repId: currentRepId(), kind: 'receipt', payload, status: 'queued', clientCreatedAt, localNumber });
        onDone({
          kind: 'receipt', number: localNumber, offline: true, date: clientCreatedAt,
          company, customer, repName, amount: Number(amount), paymentMethod: method, notes: notes || undefined,
        });
      } else { setMsg(err?.response?.data?.message || tr('تعذر إصدار السند حاول مجددا')); setLoading(false); }
    }
  };

  const methods = [['CASH', 'نقدي'], ['BANK_TRANSFER', 'تحويل'], ['POS', 'شبكة'], ['CHEQUE', 'شيك']];

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-green-700 text-white p-4 flex items-center gap-3">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold">{tr('إصدار سند قبض')}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="bg-green-50 rounded-xl p-3 flex items-center justify-between border border-green-100">
          <div className="flex items-center gap-2">
            <User size={16} className="text-green-700" />
            <span className="font-semibold text-sm">{customer.name}</span>
          </div>
          <span className="text-xs text-gray-500">{tr('رصيد')}: {formatCurrency(customer.balance)}</span>
        </div>

        <div>
          <label className="label">{tr('المبلغ المحصل')}</label>
          <input type="number" step="0.01" inputMode="decimal" className="input text-lg font-bold" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} />
        </div>

        <div>
          <label className="label">{tr('طريقة الدفع')}</label>
          <div className="flex flex-wrap gap-2">
            {methods.map(([v, lbl]) => (
              <button key={v} onClick={() => setMethod(v)}
                className={`px-4 py-2 rounded-full text-sm ${method === v ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                {tr(lbl)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="label">{tr('ملاحظات')}</label>
          <textarea className="input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        {msg && <p className="text-red-500 text-xs text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-green-600 text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-green-400">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
          {tr('إصدار السند')}
        </button>
      </div>
    </div>
  );
}

// ============ إضافة عميل جديد ============
function AddCustomer({ onClose, onCreated }: { onClose: () => void; onCreated: (c: any) => void }) {
  const tr = useTr();
  const [form, setForm] = useState({
    name: '', businessName: '', phone: '', commercialReg: '', taxNumber: '',
    city: '', district: '', address: '', creditLimit: '', paymentDays: '30',
  });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  // الموقع على الخريطة (اختياري): التقاط GPS مباشر أو لصق رابط خرائط Google
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locUrl, setLocUrl] = useState('');
  const [gps, setGps] = useState<'idle' | 'getting' | 'ok' | 'denied'>('idle');

  const captureGps = () => {
    if (!navigator.geolocation) { setGps('denied'); return; }
    setGps('getting');
    navigator.geolocation.getCurrentPosition(
      (p) => { setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }); setGps('ok'); },
      () => setGps('denied'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name.trim()) { setMsg(tr('اسم العميل مطلوب')); return; }
    if (form.phone.trim().length < 9) { setMsg(tr('رقم جوال صحيح مطلوب 9 أرقام على الأقل')); return; }
    setLoading(true); setMsg('');
    const clientRef = newClientRef();
    const clientCreatedAt = new Date().toISOString();
    const payload = {
      name: form.name.trim(),
      businessName: form.businessName.trim() || undefined,
      phone: form.phone.trim(),
      commercialReg: form.commercialReg.trim() || undefined,
      taxNumber: form.taxNumber.trim() || undefined,
      city: form.city.trim() || undefined,
      district: form.district.trim() || undefined,
      address: form.address.trim() || undefined,
      // الموقع الاختياري: إحداثيات GPS إن التُقطت، ورابط الموقع إن لُصق (يحلّه الخادم)
      lat: coords?.lat,
      lng: coords?.lng,
      locationUrl: locUrl.trim() || undefined,
      creditLimit: form.creditLimit ? Number(form.creditLimit) : undefined,
      paymentDays: form.paymentDays ? Number(form.paymentDays) : undefined,
      clientRef, clientCreatedAt,
    };
    try {
      const res = await repApi.post('/customers', payload);
      onCreated(res.data.data);
    } catch (err: any) {
      // انقطاع الشبكة ⇒ نلتقط العميل في الصفّ ونتابع بعميل محلي مؤقّت (يحمل clientRef).
      // فاتورته/سنده لاحقاً يشيران إليه بـ customerClientRef فيحلّه الخادم عند الرفع.
      if (isNetworkError(err)) {
        await outboxAdd({ clientRef, repId: currentRepId(), kind: 'customer', payload, status: 'queued', clientCreatedAt });
        onCreated({ ...payload, id: 'local-' + clientRef, clientRef, _offline: true, balance: 0, creditLimit: payload.creditLimit ?? 0, status: 'ACTIVE' });
      } else {
        setMsg(err?.response?.data?.message || tr('تعذر إضافة العميل'));
        setLoading(false);
      }
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
        <span className="font-bold">{tr('إضافة عميل جديد')}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">{tr('البيانات الأساسية')}</p>
          <div className="space-y-3">
            {field(tr('اسم العميل'), 'name', { required: true })}
            {field(tr('اسم المنشأة'), 'businessName')}
            {field(tr('رقم الجوال'), 'phone', { required: true, ltr: true })}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">{tr('البيانات النظامية')}</p>
          <div className="grid grid-cols-2 gap-3">
            {field(tr('السجل التجاري'), 'commercialReg', { ltr: true })}
            {field(tr('الرقم الضريبي'), 'taxNumber', { ltr: true })}
          </div>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">{tr('العنوان')}</p>
          <div className="grid grid-cols-2 gap-3">
            {field(tr('المدينة'), 'city')}
            {field(tr('الحي'), 'district')}
          </div>
          <div className="mt-3">{field(tr('العنوان التفصيلي'), 'address')}</div>
        </div>

        {/* الموقع على الخريطة — اختياري: يظهر للإدارة على خريطة التتبّع */}
        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">{tr('موقع العميل على الخريطة اختياري')}</p>
          <button type="button" onClick={captureGps}
            className={`w-full flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold border ${coords ? 'border-green-600 text-green-700 bg-green-50' : 'border-[#E15A30] text-[#E15A30]'}`}>
            <MapPin size={16} />
            {coords ? tr('تم تحديد الموقع ✓') : gps === 'getting' ? tr('جار تحديد الموقع') : tr('التقاط موقعي الحالي عند العميل')}
          </button>
          {coords && <p className="text-[11px] text-green-600 mt-1 text-center" dir="ltr">{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</p>}
          {gps === 'denied' && <p className="text-[11px] text-amber-600 mt-1">{tr('تعذر الوصول للموقع الصق الرابط أدناه بدلا منه')}</p>}
          <div className="mt-2">
            <input className="input" dir="ltr" placeholder={tr('أو الصق رابط الموقع من خرائط Google')}
              value={locUrl} onChange={e => setLocUrl(e.target.value)} />
          </div>
          <p className="text-[10px] text-gray-400 mt-1">{tr('من تطبيق خرائط Google مشاركة ← نسخ الرابط ثم الصقه هنا')}</p>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-400 mb-2">{tr('البيانات المالية')}</p>
          <div className="grid grid-cols-2 gap-3">
            {field(tr('الحد الائتماني'), 'creditLimit', { type: 'number', ltr: true })}
            {field(tr('فترة السداد يوم'), 'paymentDays', { type: 'number', ltr: true })}
          </div>
        </div>

        {msg && <p className="text-red-500 text-xs text-center">{msg}</p>}
      </div>

      <div className="p-4 border-t bg-white">
        <button onClick={submit} disabled={loading} className="w-full bg-[#E15A30] text-white font-semibold py-3 rounded-xl flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Plus size={16} />}
          {tr('حفظ العميل')}
        </button>
      </div>
    </div>
  );
}

// ============ قائمة بسيطة (فواتير/سندات) ============
function SimpleList({ endpoint, kind, onOpen }: { endpoint: string; kind: 'invoice' | 'receipt'; onOpen: (detail: any) => void }) {
  const tr = useTr();
  const PAGE = 30;
  const [items, setItems] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // جلب صفحة: replace=true للأولى/عند تغيّر الفلتر، وإلا تُضاف لنهاية القائمة (قائمة متتالية)
  const fetchPage = useCallback(async (p: number, replace: boolean) => {
    if (replace) setLoading(true); else setLoadingMore(true);
    try {
      const params: Record<string, string | number> = { limit: PAGE, page: p };
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await repApi.get(endpoint, { params });
      const data = res.data.data as any[];
      setPages(res.data.pagination?.pages ?? 1);
      setTotal(res.data.pagination?.total ?? data.length);
      setItems(prev => (replace ? data : [...prev, ...data]));
      setPage(p);
    } catch { /* */ }
    setLoading(false); setLoadingMore(false);
  }, [endpoint, from, to]);
  useEffect(() => { fetchPage(1, true); }, [fetchPage]);

  // تحميل تلقائي عند الاقتراب من نهاية القائمة
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (loading || loadingMore || page >= pages) return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) fetchPage(page + 1, false);
  };

  const open = async (id: string) => {
    setOpeningId(id);
    try { const res = await repApi.get(`${endpoint}/${id}`); onOpen(res.data.data); } catch { /* */ }
    setOpeningId(null);
  };

  return (
    <div className="h-full overflow-y-auto p-3 pb-24" onScroll={onScroll}>
      {/* فلتر التاريخ — أعلى القائمة */}
      <div className="bg-white rounded-2xl p-2.5 mb-2 border border-gray-100">
        <div className="flex items-center gap-1.5">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label={tr('من تاريخ')}
            className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-[11px] text-gray-700" />
          <span className="text-gray-400 text-[11px] shrink-0">{tr('إلى')}</span>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label={tr('إلى تاريخ')}
            className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1.5 text-[11px] text-gray-700" />
          {(from || to) && (
            <button onClick={() => { setFrom(''); setTo(''); }} className="text-[11px] text-[#E15A30] px-1 shrink-0">{tr('مسح')}</button>
          )}
        </div>
        {!loading && <p className="text-[10px] text-gray-400 mt-1.5">{tr('الإجمالي')}: {total}</p>}
      </div>

      {loading ? <div className="text-center text-gray-400 py-10 text-sm">{tr('جاري التحميل')}</div>
        : items.length === 0 ? <div className="text-center text-gray-400 py-10 text-sm">{tr('لا توجد بيانات')}</div>
        : <>
        {items.map(it => {
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
                  {isReturn && <span className="bg-amber-100 text-amber-700 text-[9px] px-1.5 py-0.5 rounded-full">{tr('مرتجع')}</span>}
                </p>
                <p className="text-[11px] text-gray-400">{it.customer?.name} • {formatDate(kind === 'invoice' ? it.invoiceDate : it.receiptDate)}</p>
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
        {loadingMore && <div className="text-center text-gray-400 py-3 text-xs">{tr('جاري تحميل المزيد')}</div>}
        {!loadingMore && page < pages && (
          <button onClick={() => fetchPage(page + 1, false)} className="w-full text-center text-[#E15A30] text-xs py-3 font-semibold">
            {tr('تحميل المزيد')}
          </button>
        )}
        {!loadingMore && page >= pages && items.length > 0 && (
          <p className="text-center text-gray-300 text-[11px] py-3">— {tr('نهاية القائمة')} —</p>
        )}
        </>}
    </div>
  );
}

// ============ مخزون سيارتي ============
function RepVanStock({ canLoad }: { canLoad: boolean }) {
  const tr = useTr();
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
  useEffect(() => { (async () => { const { data } = await fetchThenCache('products', async () => (await repApi.get('/products', { params: { limit: 1000, status: 'ACTIVE' } })).data.data); if (data) setProducts(data as { id: string; name: string; unit: string; code: string }[]); })(); }, []);
  useEffect(() => { if (!canLoad && view === 'load') setView('list'); }, [canLoad, view]);

  const fmt = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

  const addProduct = (id: string) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = products.find(x => x.id === id); if (!p) return;
    setRows(rs => [...rs, { productId: id, name: p.name, unit: p.unit, qty: '1' }]);
  };

  const submit = async () => {
    if (!canLoad) { setMsg({ ok: false, text: tr('لا تملك صلاحية تحميل مخزون السيارة') }); return; }
    // التحميل موجب فقط؛ التنقيص متاح للإدارة من لوحة التحكم
    const items = rows.map(r => ({ productId: r.productId, qty: Number(r.qty) })).filter(i => i.qty > 0);
    if (!items.length) { setMsg({ ok: false, text: tr('أضف صنفا وكمية صحيحة') }); return; }
    setSaving(true); setMsg(null);
    try {
      await repApi.post('/van-stock/loads', { type: 'LOAD', note: note.trim() || undefined, items });
      setRows([]); setNote(''); setView('list'); loadStock();
      setMsg({ ok: true, text: tr('تم تسجيل التحميل بنجاح') });
    } catch (e) {
      setMsg({ ok: false, text: (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ') });
    }
    setSaving(false);
  };

  if (view === 'load') {
    return (
      <div className="h-full flex flex-col">
        <div className="p-3 flex items-center gap-2 border-b border-gray-100">
          <button onClick={() => setView('list')} className="p-1.5 text-[#6E6557]"><ArrowRight size={18} /></button>
          <span className="font-bold text-[#1F1A13]">{tr('تحميل بضاعة للسيارة')}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3 pb-28">
          <div>
            <label className="text-xs font-semibold text-[#6E6557] mb-1 block">{tr('إضافة صنف')}</label>
            <SearchableSelect dark resetOnSelect value="" onChange={addProduct}
              options={products.filter(p => !rows.some(r => r.productId === p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.unit}` }))}
              placeholder={tr('ابحث وأضف صنفا')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
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
          {rows.length === 0 && <p className="text-center text-gray-400 text-xs py-6">{tr('لم تضف أي صنف بعد')}</p>}
          <input className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm" placeholder={tr('ملاحظة اختياري')} value={note} onChange={e => setNote(e.target.value)} />
          {msg && <p className={`text-xs text-center ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</p>}
        </div>
        <div className="p-3 border-t border-gray-100">
          <button onClick={submit} disabled={saving || rows.length === 0} className="w-full bg-[#E15A30] disabled:bg-[#E89B7E] text-white font-bold py-3 rounded-xl flex items-center justify-center gap-2">
            {saving ? <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownToLine size={18} />} {tr('حفظ التحميل')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 flex items-center justify-between border-b border-gray-100">
        <span className="font-bold text-[#1F1A13] flex items-center gap-2"><Truck size={18} className="text-[#E15A30]" /> {tr('مخزون سيارتي')}</span>
        <button
          onClick={() => { if (canLoad) { setView('load'); setMsg(null); } }}
          disabled={!canLoad}
          title={canLoad ? undefined : tr('لا تملك صلاحية تحميل مخزون السيارة')}
          className="bg-[#E15A30] text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          <Plus size={14} /> {tr('تحميل')}
        </button>
      </div>
      {msg && msg.ok && <div className="mx-3 mt-3 bg-green-50 text-green-700 text-xs rounded-lg px-3 py-2 flex items-center gap-1.5"><Check size={14} /> {msg.text}</div>}
      {!canLoad && <div className="mx-3 mt-3 bg-amber-50 text-amber-700 text-xs rounded-lg px-3 py-2">{tr('يمكنك عرض مخزون السيارة فقط ولا تملك صلاحية تسجيل تحميل جديد')}</div>}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 pb-24">
        {loading ? <p className="text-center text-gray-400 text-sm py-8">{tr('جار التحميل')}</p>
          : stock.length === 0 ? (
            <div className="text-center py-10">
              <Package size={40} className="mx-auto text-gray-300 mb-2" />
              <p className="text-gray-400 text-sm">{tr('لا توجد بضاعة في سيارتك بعد')}</p>
              {canLoad && <p className="text-gray-400 text-xs mt-1">{tr('اضغط تحميل لتسجيل ما حملته')}</p>}
            </div>
          ) : stock.map(s => (
            <div key={s.productId} className="bg-white border border-gray-100 rounded-xl p-3 shadow-sm flex items-center justify-between">
              <div className="min-w-0">
                <p className="font-semibold text-sm text-[#1F1A13] truncate">{s.name}</p>
                <p className="text-[11px] text-gray-400">{tr('محمل')} {fmt(s.loaded)} · {tr('مباع')} {fmt(s.sold)} {s.unit}</p>
              </div>
              <div className="text-left shrink-0">
                <p className={`text-lg font-bold ${s.remaining < 0 ? 'text-red-600' : s.remaining === 0 ? 'text-gray-400' : 'text-[#1E7A52]'}`}>{fmt(s.remaining)}</p>
                <p className="text-[10px] text-gray-400">{tr('متبقي')}</p>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

// لوحة العمل دون اتصال — تعرض المستندات المنتظرة والمرفوضة، مع رفع/إعادة محاولة/إزالة
function OutboxPanel({ onClose, onSync, syncing }: { onClose: () => void; onSync: () => void; syncing: boolean }) {
  const tr = useTr();
  const [docs, setDocs] = useState<OutboxDoc[]>([]);
  const load = () => outboxDocs().then(setDocs);
  useEffect(() => { load(); const off = onOutboxChange(load); const iv = window.setInterval(load, 4000); return () => { off(); window.clearInterval(iv); }; }, []);

  const kindLabel = (k: OutboxDoc['kind']) => k === 'invoice' ? tr('فاتورة') : k === 'receipt' ? tr('سند قبض') : k === 'visit' ? tr('زيارة') : tr('عميل');
  const custName = (d: OutboxDoc) => (d.payload as any)?.name || (d.payload as any)?.customerName || '';
  const pendingList = docs.filter(d => d.status === 'queued');
  const rejectedList = docs.filter(d => d.status === 'rejected');

  return (
    <div className="absolute inset-0 z-50 bg-white flex flex-col" dir="rtl">
      <div className="bg-[#1F1A13] text-white p-4 flex items-center gap-3 flex-shrink-0">
        <button onClick={onClose}><ArrowRight size={20} /></button>
        <span className="font-bold text-sm">{tr('العمل دون اتصال')}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {docs.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <Check size={40} className="mx-auto mb-2 text-green-500" />
            <p className="text-sm">{tr('كل المستندات مرفوعة لا شيء بانتظار الرفع')}</p>
          </div>
        )}

        {rejectedList.length > 0 && (
          <div>
            <p className="text-xs font-bold text-red-600 mb-2">{tr('مرفوضة تحتاج إجراء')} ({rejectedList.length})</p>
            <div className="space-y-2">
              {rejectedList.map(d => (
                <div key={d.clientRef} className="bg-red-50 border border-red-200 rounded-xl p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-800">{kindLabel(d.kind)} {d.localNumber ? `· ${d.localNumber}` : ''} {custName(d) && `· ${custName(d)}`}</span>
                  </div>
                  <p className="text-xs text-red-600 mt-1 leading-relaxed">{d.error || tr('رفضه الخادم')}</p>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => requeue(d.clientRef)} className="flex-1 text-xs bg-[#1F1A13] text-white rounded-lg py-1.5">{tr('إعادة المحاولة')}</button>
                    <button onClick={() => { if (confirm(tr('إزالة هذا المستند نهائيا من الصف'))) discard(d.clientRef); }} className="flex-1 text-xs border border-red-300 text-red-600 rounded-lg py-1.5">{tr('إزالة')}</button>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">
              {tr('إن رفض الخادم مستندا سلمت نسخته الورقية للعميل عالج السبب مثل حد الائتمان ثم أعد المحاولة أو تواصل مع الإدارة لتسويته')}
            </p>
          </div>
        )}

        {pendingList.length > 0 && (
          <div>
            <p className="text-xs font-bold text-amber-600 mb-2">{tr('بانتظار الرفع')} ({pendingList.length})</p>
            <div className="space-y-2">
              {pendingList.map(d => (
                <div key={d.clientRef} className="bg-amber-50 border border-amber-100 rounded-xl p-3 flex items-center justify-between">
                  <span className="text-sm text-gray-800">{kindLabel(d.kind)} {d.localNumber ? `· ${d.localNumber}` : ''} {custName(d) && `· ${custName(d)}`}</span>
                  <span className="text-[11px] text-amber-600">{new Date(d.clientCreatedAt).toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {pendingList.length > 0 && (
        <div className="flex-shrink-0 p-4 border-t border-gray-100">
          <button onClick={onSync} disabled={syncing}
            className="w-full bg-[#E15A30] text-white rounded-xl py-3 font-bold flex items-center justify-center gap-2 disabled:opacity-60">
            <RefreshCw size={18} className={syncing ? 'animate-spin' : ''} />
            {syncing ? tr('جار الرفع') : `${tr('ارفع الآن')} (${pendingList.length})`}
          </button>
        </div>
      )}
    </div>
  );
}

export default function RepApp() {
  const tr = useTr();
  const [token, setToken] = useState(localStorage.getItem('rep_token'));
  const [user, setUser] = useState<RepUser | null>(() => {
    try { return JSON.parse(localStorage.getItem('rep_user') || 'null'); } catch { return null; }
  });
  // شاشة تعريفية قبل الدخول (متطلّب App Store 5.1.1(v)): يفتح التطبيق عليها لا على الدخول
  const [showLogin, setShowLogin] = useState(false);
  const [screen, setScreen] = useState<Screen>('home');
  const [modal, setModal] = useState<Modal>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<any>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [docResult, setDocResult] = useState<InvoiceDoc | ReceiptDoc | StatementDoc | null>(null);
  // من أين فُتح المستند؟ لإعادة المندوب لشاشة العميل عند إغلاقه بدل قائمة الفواتير
  const [docBack, setDocBack] = useState<'customerDetail' | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [fuelOn, setFuelOn] = useState(false); // ربط بترو آب مفعّل لشركة المندوب؟
  const [workNumOn, setWorkNumOn] = useState(false); // ميزة أرقام العمل (هاتف) مفعّلة؟
  const [pending, setPending] = useState(0);       // مستندات أوف‑لاين بانتظار الرفع
  const [rejected, setRejected] = useState(0);     // مستندات رفضها الخادم (تحتاج مراجعة)
  const [syncing, setSyncing] = useState(false);
  const [showOutbox, setShowOutbox] = useState(false);

  // تتبّع GPS — يعمل فقط عند تسجيل الدخول وتفعيل الشركة للتتبّع وموافقة المندوب
  const trackStatus = useRepTracking(!!token && !!user);
  useHeartbeat(!!token && !!user); // نبضة حضور لحساب ساعات العمل (مستقلّة عن GPS)

  // ───────── مؤقّت زيارة العميل ─────────
  // يعيش على مستوى RepApp (لا داخل CustomerDetail) كي ينجو من فتح النوافذ
  // الفرعية (فاتورة/سند) التي تُفكِّك المكوّن، ومن إعادة تحميل التبويب.
  const [visitTimer, setVisitTimerState] = useState<VisitTimer | null>(() => getVisitTimer());
  const [tick, setTick] = useState(0); // يُحدِّث العدّاد الحيّ كل ثانية
  useEffect(() => {
    if (!visitTimer) return;
    const iv = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(iv);
  }, [visitTimer]);
  const visitElapsed = visitTimer ? elapsedSec(visitTimer.startedAt) : 0;
  void tick; // العدّاد يُعاد رسمه عبر tick

  // يُنهي المؤقّت ويرفع الزيارة (أوف‑لاين عبر الصفّ الصادر). صامت: المؤقّت
  // للقياس لا لعمل حرج، فلا يزعج المندوب برسالة خطأ.
  const finalizeVisit = async (t: VisitTimer) => {
    clearVisitTimer();
    setVisitTimerState(null);
    const endedAt = new Date().toISOString();
    const clientDurationSec = elapsedSec(t.startedAt);
    if (clientDurationSec < 2) return; // ضغطة خاطئة — لا زيارة مدّتها صفر
    const clientRef = newClientRef();
    const custRef = t.offline ? { customerClientRef: t.customerClientRef } : { customerId: t.customerId };
    const payload: Record<string, unknown> = { ...custRef, startedAt: t.startedAt, endedAt, clientDurationSec, clientRef, createdAt: endedAt };
    try {
      await repApi.post('/visits', payload);
    } catch (err) {
      if (isNetworkError(err)) {
        await outboxAdd({ clientRef, repId: currentRepId(), kind: 'visit', payload, status: 'queued', clientCreatedAt: endedAt });
      }
      // خطأ غير شبكي (عزل عميل مثلاً) يُتجاهَل بصمت — لا نكسر تجربة المندوب
    }
  };

  // بدء توقيت زيارة عميل. إن كان مؤقّت آخر نشطاً (عميل مختلف) نُنهيه أولاً
  // فلا تضيع مدّته ولا تختلط بالجديدة.
  const startVisit = (c: { id: string; name: string; _offline?: boolean; clientRef?: string }) => {
    if (visitTimer && visitTimer.customerId !== c.id) void finalizeVisit(visitTimer);
    const t: VisitTimer = {
      customerId: c.id, customerName: c.name,
      offline: !!c._offline, customerClientRef: c.clientRef,
      startedAt: new Date().toISOString(),
    };
    setVisitTimer(t);
    setVisitTimerState(t);
  };

  // نجاة الأيتام: مؤقّت بقي من جلسة سابقة (أُغلق التطبيق دون خروج) وتجاوز
  // السقف (٤ ساعات) يُنهى فوراً عند الإقلاع — الخادم يقصّه، فلا مدّة خيالية.
  useEffect(() => {
    if (!token) return;
    const orphan = getVisitTimer();
    if (orphan && elapsedSec(orphan.startedAt) > 4 * 3600) void finalizeVisit(orphan);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // الجلسة المنزلقة: تجديد صامت للتوكن كي لا يُخرَج المندوب بانتهاء الساعات
  // الثماني — لا أثناء العمل ولا أثناء الخمول. (انظر rep/renew.ts)
  useEffect(() => {
    if (!token) return;
    return startRenewLoop();
  }, [token]);

  // العمل دون اتصال: بدء المزامنة التلقائية + متابعة عدد المنتظرين (يُحدَّث بعد كل التقاط/رفع)
  useEffect(() => {
    if (!token) return;
    startAutoSync();
    const refresh = () => { pendingCount().then(setPending); rejectedCount().then(setRejected); };
    refresh();
    const off = onOutboxChange(refresh);
    // تحديث دوري خفيف (يلتقط الالتقاطات من شاشات أخرى)
    const iv = window.setInterval(refresh, 5000);
    return () => { off(); window.clearInterval(iv); };
  }, [token]);

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await syncOutbox();
      setPending(r.pending);
      if (r.sent > 0) setRefreshKey(k => k + 1); // تحديث القوائم بعد رفع ناجح
    } finally { setSyncing(false); }
  };

  useEffect(() => {
    if (!token) return;
    // إعدادات الشركة (العملة + countryCode/defaultVatPct لمحرّك الحساب) — تُخزَّن للعمل أوف‑لاين
    (async () => {
      const { data } = await fetchThenCache<Company>('company', async () =>
        (await repApi.get('/company')).data.data);
      if (data) { setCompany(data); setActiveCurrency((data as { currency?: string })?.currency); }
    })();
    // هل ربطت الشركة بترو آب؟ (يظهر زرّ الوقود) — فشله الصامت يعني إخفاء الزرّ فقط
    (async () => {
      try {
        const { data } = await repApi.get('/petroapp/rep/summary', { background: true });
        const on = !!(data?.data?.enabled);
        setFuelOn(on); await cacheSet('rep-fuel-on', on);
      } catch {
        const cached = await cacheGet<boolean>('rep-fuel-on');
        if (cached?.data) setFuelOn(true);
      }
    })();
    // ميزة أرقام العمل (هاتف) — نفس نمط زرّ الوقود: فشل الفحص يخفي الزرّ فقط
    (async () => {
      try {
        const { data } = await repApi.get('/work-numbers/rep/summary', { background: true });
        const on = !!(data?.data?.enabled);
        setWorkNumOn(on); await cacheSet('rep-worknum-on', on);
      } catch {
        const cached = await cacheGet<boolean>('rep-worknum-on');
        if (cached?.data) setWorkNumOn(true);
      }
    })();
    // تخزين دائم يقلّل طرد المتصفّح لبيانات الأوف‑لاين (أفضل جهد)
    requestPersistentStorage();
  }, [token]);

  // جهاز مشترك: قاعدة IndexedDB مشتركة للأصل، فلا يرث المندوب الجديد بيانات سابقه
  // المخزّنة (عملاء/أصناف) — وإلا ظهرت له قائمة عملاء زميله عند أول تعذّر شبكة.
  // الصفّ الصادر لا يُمسح (مستندات لم تُرفع بعد)، بل يُرفَع كلٌّ بجلسة صاحبه.
  const login = async (t: string, u: RepUser) => {
    const prev = currentRepId();
    if (prev && prev !== u.id) await refClear();
    localStorage.setItem('rep_token', t);
    localStorage.setItem('rep_user', JSON.stringify(u));
    clearRenewRejection(); // دخولٌ جديد: أي رفض تجديد سابق لم يعد قائماً
    setToken(t); setUser(u);
  };
  const logout = async () => {
    // زيارة جارية عند تسجيل الخروج تُنهى وتُرفع أولاً كي لا تضيع مدّتها
    const t = getVisitTimer();
    if (t) await finalizeVisit(t);
    await refClear();
    localStorage.removeItem('rep_token'); localStorage.removeItem('rep_user');
    setToken(null); setUser(null);
  };

  const tabs: { id: Screen; label: string; icon: React.ElementType }[] = [
    { id: 'home', label: 'الرئيسية', icon: Home },
    { id: 'invoices', label: 'الفواتير', icon: FileText },
    { id: 'receipts', label: 'التحصيل', icon: CreditCard },
    { id: 'customers', label: 'العملاء', icon: Users },
    { id: 'vanstock', label: 'مخزوني', icon: Truck },
  ];

  // إطار الجوّال يظهر فقط على سطح المكتب (للمعاينة). أمّا على الجوّال الحقيقي أو داخل
  // التطبيق (PWA/TWA) فيُعرض المحتوى ملء الشاشة — وإلا ظهر «جوال داخل جوال».
  const framed = !(typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(max-width: 640px)').matches));
  return (
    <div className={framed ? 'min-h-screen bg-slate-200 flex items-center justify-center p-4' : 'bg-white'} style={framed ? undefined : { height: '100dvh' }} dir="rtl">
      <div className={framed ? 'relative w-[400px] h-[820px] bg-black rounded-[44px] p-2.5 shadow-2xl' : 'relative w-full h-full'}>
        {/* notch — سطح المكتب فقط */}
        {framed && <div className="absolute top-2.5 left-1/2 -translate-x-1/2 w-32 h-6 bg-black rounded-b-2xl z-30" />}
        <div className={framed ? 'w-full h-full bg-white rounded-[36px] overflow-hidden relative flex flex-col' : 'w-full h-full bg-white overflow-hidden relative flex flex-col'}>
          {showOutbox && <OutboxPanel onClose={() => setShowOutbox(false)} onSync={syncNow} syncing={syncing} />}
          {!token || !user ? (
            showLogin ? (
              <RepLogin onLogin={login} onBack={() => setShowLogin(false)} />
            ) : (
              <AppIntro app="rep" onProceed={() => setShowLogin(true)} />
            )
          ) : docResult ? (
            <DocumentResult doc={docResult} onClose={() => {
              const k = docResult.kind;
              const back = docBack;
              setDocResult(null); setDocBack(null);
              // فُتح من شاشة العميل → نعود إليها؛ وإلا لقائمة نوع المستند
              if (back === 'customerDetail' && selectedCustomer) { setModal('customerDetail'); return; }
              setScreen(k === 'invoice' ? 'invoices' : k === 'receipt' ? 'receipts' : 'customers');
            }} />
          ) : modal === 'customerDetail' && selectedCustomer ? (
            <CustomerDetail customer={selectedCustomer} repName={user.name} company={company} perms={user}
              paylinkOn={(company as any)?.paylinkEnabled === true}
              // الخروج الحقيقي لقائمة العملاء يُنهي مؤقّت هذا العميل ويرفع الزيارة.
              // النوافذ الفرعية (فاتورة/سند) لا تمرّ من هنا فيبقى المؤقّت جارياً.
              onClose={() => { if (visitTimer && visitTimer.customerId === selectedCustomer.id) void finalizeVisit(visitTimer); setModal(null); }}
              visitActive={!!visitTimer && visitTimer.customerId === selectedCustomer.id}
              visitElapsedLabel={fmtElapsed(visitElapsed)}
              onStartVisit={() => startVisit(selectedCustomer)}
              onInvoice={() => setModal('createInvoice')} onReceipt={() => setModal('createReceipt')} onReturn={() => setModal('createReturn')}
              onLogVisit={() => setModal('logVisit')}
              onStatement={(doc) => { setDocBack('customerDetail'); setModal(null); setDocResult(doc); }}
              onOpenDoc={(doc) => { setDocBack('customerDetail'); setModal(null); setDocResult(doc); }} />
          ) : modal === 'createInvoice' && selectedCustomer ? (
            <CreateInvoice customer={selectedCustomer} repName={user.name} company={company} perms={user} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'createReturn' && selectedCustomer ? (
            <CreateInvoice customer={selectedCustomer} repName={user.name} company={company} mode="return" perms={user} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'createReceipt' && selectedCustomer ? (
            <CreateReceipt customer={selectedCustomer} repName={user.name} company={company} perms={user} onClose={() => setModal('customerDetail')}
              onDone={(doc) => { setModal(null); setRefreshKey(k => k + 1); setDocResult(doc); }} />
          ) : modal === 'logVisit' && selectedCustomer ? (
            <LogVisit customer={selectedCustomer} onClose={() => setModal('customerDetail')}
              onDone={(offline) => { setModal('customerDetail'); if (offline) setRefreshKey(k => k + 1); }} />
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
                  {/* شارة العمل دون اتصال: بانتظار الرفع / مرفوض — نقرة تفتح لوحة المراجعة */}
                  {(pending > 0 || rejected > 0) && (
                    <button onClick={() => setShowOutbox(true)}
                      className={`flex items-center gap-1 text-[11px] rounded-full px-2 py-1 border ${rejected > 0 ? 'bg-red-500/20 text-red-300 border-red-500/40' : 'bg-amber-500/20 text-amber-300 border-amber-500/40'}`}
                      title={tr('مستندات العمل دون اتصال')}>
                      <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
                      <span>{rejected > 0 ? `${rejected} ${tr('مرفوض')}` : `${pending} ${tr('بانتظار الرفع')}`}</span>
                    </button>
                  )}
                  {(trackStatus === 'active' || trackStatus === 'requesting') && (
                    <span className="flex items-center gap-1 text-[11px] text-[#5FBE92]" title={tr('مشاركة موقعك مفعلة')}>
                      <span className={`w-2 h-2 rounded-full bg-[#5FBE92] ${trackStatus === 'active' ? 'animate-pulse' : ''}`} /> <MapPin size={12} />
                    </span>
                  )}
                  {trackStatus === 'denied' && (
                    <span className="flex items-center gap-1 text-[11px] text-amber-400" title={tr('فعل إذن الموقع من إعدادات المتصفح')}>
                      <MapPin size={12} /> {tr('الموقع متوقف')}
                    </span>
                  )}
                  <LanguageToggle variant="dark" />
                  <button onClick={logout} className="text-[#9A8F7E] hover:text-white"><LogOut size={18} /></button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-hidden">
                {screen === 'home' && <RepHome key={refreshKey} user={user} onQuick={setScreen} fuelOn={fuelOn} workNumOn={workNumOn} menuOn={!!(company as { catalogEnabled?: boolean } | null)?.catalogEnabled} />}
                {screen === 'invoices' && <SimpleList key={`invoices-${refreshKey}`} endpoint="/invoices" kind="invoice" onOpen={(d) => { setDocBack(null); setDocResult(invoiceDocFromDetail(d, user.name, company)); }} />}
                {screen === 'receipts' && <SimpleList key={`receipts-${refreshKey}`} endpoint="/receipts" kind="receipt" onOpen={(d) => { setDocBack(null); setDocResult(receiptDocFromDetail(d, user.name, company)); }} />}
                {screen === 'customers' && <RepCustomers onSelect={c => { setSelectedCustomer(c); setModal('customerDetail'); }} canAdd={!!user.canAddCustomer} onAdd={() => setModal('addCustomer')} />}
                {screen === 'vanstock' && <RepVanStock canLoad={user.canManageVanStock !== false} />}
                {screen === 'fuel' && <RepFuel />}
                {screen === 'worknum' && <RepWorkNumber />}
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
                      <span className="text-[10px] font-medium">{tr(t.label)}</span>
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
