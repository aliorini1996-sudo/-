import { useState, useEffect, useMemo, Fragment, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TrendingUp, Receipt, Users, UserCheck, Wallet, Clock, MapPin,
  RefreshCw, ChevronLeft, AlertTriangle, Package, CalendarDays, UserRound,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { reportApi } from '../api/client';
import { formatCurrency, formatNumber, formatDate, formatDateTime, formatDayOnly, formatTime } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MRow, MStat, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import { useIsLive, livePoll } from './useLiveQuery';

/**
 * شاشة التقارير التحليلية في تطبيق الإدارة على الجوال (سبعة تقارير).
 *
 * **لماذا سبع شاشات في ملفّ واحد بشرائح لا قوائم منسدلة:** المشرف على الجوال
 * يقارن — «كم بعتُ؟ وكم حصّلت؟» — والمقارنة تموت إن كلّفت فتحَ قائمة واختيار
 * بند في كل مرّة. الشرائح تُمرَّر بالإبهام وتُبدَّل بضغطةٍ واحدة.
 *
 * **ولماذا تُخفى مصفاة التاريخ في تقريرين:** «أرصدة العملاء» و«مديونيات
 * المناديب» رصيدان **لحظيّان** يتجاهلهما الخادم تماماً (راجع
 * `backend/src/routes/reports.ts`: مسارا `/balances` و`/rep-receivables` لا
 * يقرآن from/to أصلاً). وإبقاء المصفاة ظاهرةً فوق تقريرٍ لا يقرؤها كذبٌ صامت:
 * يختار المشرف «الشهر الماضي» ويقرأ رصيد اليوم وهو يظنّه رصيد الشهر الماضي.
 *
 * **وكل رقمٍ هنا يأتي من الخادم كما هو** — لا حقل مُخترَع، والمشتقّ الوحيد
 * مجاميعُ الصفوف المعروضة نفسها (فتتّسق البطاقة مع القائمة تحتها دائماً).
 */

// ═══════════════ أشكال استجابات الخادم (مطابقة لـ routes/reports.ts) ═══════════════

/** صفّ مبيعات مُجمَّع: count للمندوب/العميل، وqty+code للصنف */
interface SalesRow { name: string; total: number; count?: number; qty?: number; code?: string }

interface ReceiptRow {
  id: string; number: string; receiptDate: string; amount: number; paymentMethod: string;
  customer: { id: string; name: string }; salesRep: { id: string; name: string } | null;
}
interface CollectionsRes {
  receipts: ReceiptRow[];
  summary: { total: number; count: number; byMethod: Record<string, number> };
}

interface BalanceRow {
  id: string; name: string; phone: string; balance: number; creditLimit: number;
  paymentDays: number; totalSales: number; totalCollected: number;
}

interface VisitLoc { customerName: string; createdAt: string; lat: number; lng: number; mapsUrl: string }
interface PerfRow {
  id: string; name: string; invoicesCount: number; salesTotal: number; collectionsTotal: number;
  discountTotal: number; collectionRate: number; avgInvoice: number;
  workMinutes: number; workHours: number; workMins: number; visitsCount: number; visits: VisitLoc[];
}

interface RecvCustomer {
  id: string; name: string; businessName: string | null; phone: string; city: string | null;
  balance: number; lastPaymentAt: string | null;
}
interface RecvRow {
  id: string; name: string; customersCount: number; debtorsCount: number;
  totalBalance: number; customers: RecvCustomer[];
}

interface WorkVisit {
  customerName: string; start: string; end: string | null;
  durationSec: number | null; hasNote: boolean; parts: number;
}
interface WorkDayRow {
  date: string; firstActivity: string; lastActivity: string;
  spanMinutes: number; appMinutes: number;
  visits: WorkVisit[]; visitsCount: number; visitsSec: number;
  absent: boolean;
}
interface WorkHoursRow {
  id: string; name: string; totalMinutes: number; hours: number; minutes: number; sessions: number;
  firstSeen: string | null; lastSeen: string | null;
  fieldMinutesTotal: number; workedDays: number; absentDays: number; visitsTotal: number;
  avgDayMinutes: number; days: WorkDayRow[];
}

interface CustVisit {
  id: string; customerId: string; customerName: string; repName: string;
  createdAt: string; durationSec: number | null; note: string; mapsUrl: string;
}
/** تجميع الزيارات بالعميل — يُشتقّ على الجهاز (الخادم يرسلها مسطّحة) */
interface CustGroup {
  customerId: string; customerName: string; visitsCount: number;
  avgDurationSec: number | null; lastVisit: string; visits: CustVisit[];
}

// ═══════════════ أدوات مساعدة ═══════════════

type Tr = (ar: string) => string;

const PAGE = 25;

const fmtMin = (m: number, tr: Tr) => `${Math.floor(m / 60)} ${tr('س')} ${m % 60} ${tr('د')}`;

/** مدّة بالثواني بنفس تدرّج تقارير الويب وخريطة التتبّع — null = بلا توقيت */
const fmtSec = (s: number | null, tr: Tr): string | null =>
  s == null || s <= 0 ? null
    : s >= 3600 ? `${Math.floor(s / 3600)} ${tr('س')} ${Math.floor((s % 3600) / 60)} ${tr('د')}`
      : s >= 60 ? `${Math.floor(s / 60)} ${tr('د')} ${s % 60} ${tr('ث')}`
        : `${s} ${tr('ث')}`;

const methodLabel = (m: string, tr: Tr) =>
  m === 'CASH' ? tr('نقدي') : m === 'BANK_TRANSFER' ? tr('تحويل بنكي')
    : m === 'POS' ? tr('شبكة') : m === 'CHEQUE' ? tr('شيك')
      : m === 'ONLINE' ? tr('دفع إلكتروني') : m;

/** المعاملات الفارغة تُحذف: `from=''` يصل الخادم سلسلةً فارغة فيُبنى منها تاريخ باطل */
const params = (o: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));

/**
 * YYYY-MM-DD **بتوقيت الجهاز** لا UTC.
 *
 * `toISOString().slice(0,10)` هو الشائع في المستودع، لكنه يعطي يوم UTC: في
 * الرياض (+3) تقرأ الساعةُ الواحدة ليلاً «أمس»، فيضغط المشرف «اليوم» ويرى
 * مبيعات يومٍ مضى. واليومُ هنا يوم المستخدم لا يوم الخادم.
 */
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

type QuickId = 'today' | 'week' | 'month' | 'lastMonth';
const QUICKS: { id: QuickId; label: string }[] = [
  { id: 'today', label: 'اليوم' },
  { id: 'week', label: 'هذا الأسبوع' },
  { id: 'month', label: 'هذا الشهر' },
  { id: 'lastMonth', label: 'الشهر الماضي' },
];

function quickRange(kind: QuickId): { from: string; to: string } {
  const now = new Date();
  if (kind === 'today') { const t = ymd(now); return { from: t, to: t }; }
  if (kind === 'week') {
    // أسبوع العمل في السوق الخليجي يبدأ **السبت** (getDay: الأحد 0 … السبت 6)
    const back = (now.getDay() + 1) % 7;
    const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    return { from: ymd(s), to: ymd(now) };
  }
  if (kind === 'month') {
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
  }
  // اليوم صفر من الشهر الحالي = آخر يوم في الشهر الماضي
  return {
    from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
  };
}

/**
 * نافذة عرض تراكميّة بالتمرير — لا ترقيم صفحات على الجوال.
 *
 * التقارير تصل **كاملةً** في استجابة واحدة (الخادم لا يُرقّمها)، فقصُّ العرض
 * على الجهاز هو ما يمنع ألف صفٍّ من تجميد الإبهام على جهازٍ متواضع.
 */
function useWindowed(resetKey: string, total: number) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => { setLimit(PAGE); }, [resetKey]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (limit < total && el.scrollHeight - el.scrollTop - el.clientHeight < 180) {
      setLimit(l => l + PAGE);
    }
  };
  return { limit, onScroll, hidden: Math.max(0, total - limit) };
}

interface QLike {
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
}

/**
 * الحالات الثلاث في مكان واحد — **بقراءة `status` لا `isLoading`**.
 *
 * عند تقلّب الشبكة يوقف React Query إعادة المحاولة (`fetchStatus='paused'`)
 * فيصير `isLoading` كاذباً (false بلا بيانات ولا خطأ)، فتسقط الشاشة على حالة
 * الفراغ وتقول «لا بيانات» والحقيقة «انقطع الاتصال» — وهما رسالتان تدفعان
 * المشرف إلى قرارين متضادّين. (الدرس نفسه موثّق في ReportsPage.)
 */
function State({ q, empty, emptyText, emptyIcon, children }: {
  q: QLike; empty: boolean; emptyText: string; emptyIcon?: React.ElementType; children: ReactNode;
}) {
  const tr = useTr();
  // ارتفاع ثابت للحالات الثلاث: لبناتها تملأ `h-full`، ولو تُركت داخل جسمٍ
  // فوقه مبدّل تجميع أو تنبيه لتجاوز المحتوى الشاشةَ فظهر شريط تمريرٍ لصفحةٍ
  // ليس فيها إلا دوّارة.
  if (q.status === 'pending') {
    return (
      <div className="h-[260px]">
        <MSpinner text={q.fetchStatus === 'paused' ? tr('بانتظار عودة الاتصال') : undefined} />
      </div>
    );
  }
  if (q.status === 'error') return <div className="h-[260px]"><MError onRetry={() => q.refetch()} /></div>;
  if (empty) return <div className="h-[260px]"><MEmpty text={emptyText} icon={emptyIcon} /></div>;
  return <>{children}</>;
}

/** جسم التقرير: يملك تمريره وحده (الترويسة والمصفاة تبقيان ثابتتين فوقه) */
function Pane({ onScroll, children }: {
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void; children: ReactNode;
}) {
  return (
    <div onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pt-2 pb-4 space-y-2.5">
      {children}
    </div>
  );
}

/** سطر «بقي كذا صفاً» — التمرير يكشفها، والرقم يمنع ظنّ أن القائمة انتهت */
function More({ hidden }: { hidden: number }) {
  const tr = useTr();
  if (hidden <= 0) return null;
  return (
    <p className="text-center text-[11px] text-[#9A8F7E] py-2">
      {tr('مرر لعرض')} {formatNumber(hidden)} {tr('صفا إضافيا')}
    </p>
  );
}

/** صفّ بحرف الاسم — يميّز المناديب والعملاء في قائمةٍ بصريّة سريعة */
function Initial({ name }: { name: string }) {
  const ch = (name || '').trim().charAt(0);
  return (
    <span className="w-9 h-9 rounded-full bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center text-sm font-bold flex-shrink-0">
      {ch || <UserRound size={16} />}
    </span>
  );
}

/** رقم في نهاية الصفّ — tabular حتى تتحاذى الخانات رأسياً في القائمة */
function Amount({ value, tone = 'default', chevron }: {
  value: string; tone?: 'default' | 'good' | 'warn' | 'bad'; chevron?: boolean;
}) {
  const color = tone === 'good' ? 'text-[#2F855A]' : tone === 'warn' ? 'text-[#B7791F]'
    : tone === 'bad' ? 'text-[#C0392B]' : 'text-[#1F1A13]';
  return (
    <span className="flex items-center gap-1 flex-shrink-0">
      <span className={`text-xs font-bold tabular-nums whitespace-nowrap ${color}`}>{value}</span>
      {chevron && <ChevronLeft size={15} className="text-[#C9BFB0]" />}
    </span>
  );
}

/** صفّ يفتح رابطاً خارجياً (خريطة) — MRow زرٌّ لا وصلة، والخرائط تحتاج وصلة */
function MLinkRow({ href, title, subtitle, trailing }: {
  href: string; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="block border-b border-[#F1EBDF] last:border-0 active:bg-[#FAF7F0]">
      <div className="flex items-center gap-3 px-3.5 py-3 min-h-[56px]">
        <MapPin size={16} className="text-[#2563EB] flex-shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[#1F1A13] truncate">{title}</span>
          {subtitle && <span className="block text-[11px] text-[#9A8F7E] truncate mt-0.5">{subtitle}</span>}
        </span>
        {trailing}
      </div>
    </a>
  );
}

/** تنبيه أصفر داخل التقرير (قصُّ مدى، عملاء مشتركون…) */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl bg-[#FDF6E7] border border-[#F0E0BC] px-3 py-2 text-[11.5px] text-[#9A5B1E]">
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** سطر تفسيريّ رماديّ — لِما يجب أن يُعرف قبل قراءة الرقم لا بعده */
function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-[#9A8F7E] leading-relaxed px-1">{children}</p>;
}

// ═══════════════ الشاشة ═══════════════

const REPORTS = [
  { id: 'sales', label: 'المبيعات', icon: TrendingUp, dated: true },
  { id: 'collections', label: 'التحصيل', icon: Receipt, dated: true },
  { id: 'balances', label: 'أرصدة العملاء', icon: Users, dated: false },
  { id: 'performance', label: 'أداء المناديب', icon: UserCheck, dated: true },
  { id: 'receivables', label: 'مديونيات المناديب', icon: Wallet, dated: false },
  { id: 'hours', label: 'ساعات العمل', icon: Clock, dated: true },
  { id: 'visits', label: 'زيارات العملاء', icon: MapPin, dated: true },
] as const;

type ReportId = typeof REPORTS[number]['id'];
type GroupBy = 'rep' | 'customer' | 'product';

/** طبقة تفصيلٍ فوق القائمة — بيانات الصفّ كاملةٌ أصلاً فلا طلب ثانٍ */
type Detail =
  | { kind: 'perf'; row: PerfRow }
  | { kind: 'recv'; row: RecvRow }
  | { kind: 'hours'; row: WorkHoursRow }
  | { kind: 'cust'; group: CustGroup };

export default function MReports({ onBack }: { onBack: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [id, setId] = useState<ReportId>('sales');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('rep');
  const [detail, setDetail] = useState<Detail | null>(null);

  useBackClose(!!detail, () => setDetail(null));

  const meta = REPORTS.find(r => r.id === id) ?? REPORTS[0];
  const activeQuick = QUICKS.find(k => {
    const r = quickRange(k.id);
    return r.from === from && r.to === to;
  })?.id;

  // التحديث يُبطل مفاتيح هذا التقرير وحده: إبطال الكلّ يُعيد جلب ستّة تقارير
  // لا ينظر إليها أحد على باقة بياناتٍ محدودة.
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['m-report', id] });
    toast.success(tr('يجري تحديث التقرير'));
  };

  if (detail) return <DetailPane detail={detail} onClose={() => setDetail(null)} />;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={tr('التقارير')}
        subtitle={tr(meta.label)}
        onBack={onBack}
        action={
          <button onClick={refresh} aria-label={tr('تحديث')}
            className="w-11 h-11 flex items-center justify-center text-[#9A8F7E] hover:text-white">
            <RefreshCw size={17} />
          </button>
        } />

      {/* مبدّل التقارير — شرائح تُمرَّر أفقياً بالإبهام */}
      <div className="flex-shrink-0 bg-white border-b border-[#F1EBDF] px-3 py-2 flex gap-1.5 overflow-x-auto overscroll-x-contain">
        {REPORTS.map(r => (
          <button key={r.id} onClick={() => setId(r.id)}
            className={`flex items-center gap-1.5 flex-shrink-0 px-3.5 min-h-[44px] rounded-xl text-xs font-semibold whitespace-nowrap transition-colors
              ${id === r.id ? 'bg-[#E15A30] text-white' : 'bg-[#FAF7F0] text-[#6E6557]'}`}>
            <r.icon size={14} />{tr(r.label)}
          </button>
        ))}
      </div>

      {/* مصفاة المدى — تظهر للتقارير التي يقرأ الخادم تاريخها فقط */}
      {meta.dated ? (
        <div className="flex-shrink-0 bg-white border-b border-[#F1EBDF] px-3 py-2 space-y-2">
          <div className="flex gap-1.5 overflow-x-auto overscroll-x-contain">
            {QUICKS.map(k => (
              <button key={k.id}
                onClick={() => { const r = quickRange(k.id); setFrom(r.from); setTo(r.to); }}
                className={`flex-shrink-0 px-3 min-h-[36px] rounded-lg text-[11px] font-semibold whitespace-nowrap border
                  ${activeQuick === k.id ? 'bg-[#FBEBE2] border-[#E15A30] text-[#C94E28]' : 'bg-white border-[#E9E1D3] text-[#6E6557]'}`}>
                {tr(k.label)}
              </button>
            ))}
            {(from || to) && (
              <button onClick={() => { setFrom(''); setTo(''); }}
                className="flex-shrink-0 px-3 min-h-[36px] rounded-lg text-[11px] font-semibold whitespace-nowrap border border-[#E9E1D3] bg-white text-[#9A8F7E]">
                {tr('إلغاء المدى')}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <CalendarDays size={15} className="text-[#9A8F7E] flex-shrink-0" />
            {/* flex-1 + min-w-0: صنف `input` هو w-full، وحقلان بعرضٍ كامل داخل
                صفٍّ مرن يطفحان خارج شاشة 400px بدل أن يقتسماها */}
            <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}
              aria-label={tr('من')} className="input flex-1 min-w-0 min-h-[44px] text-xs" />
            <span className="text-[11px] text-[#9A8F7E] flex-shrink-0">{tr('إلى')}</span>
            <input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}
              aria-label={tr('إلى')} className="input flex-1 min-w-0 min-h-[44px] text-xs" />
          </div>
        </div>
      ) : (
        <p className="flex-shrink-0 bg-white border-b border-[#F1EBDF] px-4 py-2.5 text-[11px] text-[#9A8F7E]">
          {tr('رصيد لحظي يعكس الوضع الآن لا فترة محددة')}
        </p>
      )}

      {id === 'sales' && <SalesReport from={from} to={to} groupBy={groupBy} onGroupBy={setGroupBy} />}
      {id === 'collections' && <CollectionsReport from={from} to={to} />}
      {id === 'balances' && <BalancesReport />}
      {id === 'performance' && <PerformanceReport from={from} to={to} onOpen={setDetail} />}
      {id === 'receivables' && <ReceivablesReport onOpen={setDetail} />}
      {id === 'hours' && <HoursReport from={from} to={to} onOpen={setDetail} />}
      {id === 'visits' && <VisitsReport from={from} to={to} onOpen={setDetail} />}
    </div>
  );
}

// ═══════════════ ١) المبيعات ═══════════════

const GROUPS: { id: GroupBy; label: string }[] = [
  { id: 'rep', label: 'المندوب' },
  { id: 'customer', label: 'العميل' },
  { id: 'product', label: 'الصنف' },
];

/**
 * المبيعات مُجمَّعةً (مندوب/عميل/صنف) — التجميع مدعومٌ في الخادم صراحةً.
 *
 * ونُرسل `groupBy` **دائماً**: مسار «بلا تجميع» يُرجع كل الفواتير ببنودها في
 * استجابة واحدة — حمولةٌ لا معنى لها على شاشة 400px وباقة جوال.
 */
function SalesReport({ from, to, groupBy, onGroupBy }: {
  from: string; to: string; groupBy: GroupBy; onGroupBy: (g: GroupBy) => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-report', 'sales', from, to, groupBy],
    queryFn: async () => expectArray<SalesRow>(
      (await reportApi.sales(params({ from, to, groupBy }))).data?.data, 'تقرير المبيعات'),
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const { limit, onScroll, hidden } = useWindowed(`${from}|${to}|${groupBy}`, rows.length);

  const sum = useMemo(() => rows.reduce(
    (a, r) => ({ total: a.total + r.total, count: a.count + (r.count ?? 0), qty: a.qty + (r.qty ?? 0) }),
    { total: 0, count: 0, qty: 0 }), [rows]);

  const byProduct = groupBy === 'product';
  const rowsLabel = byProduct ? tr('عدد الأصناف') : groupBy === 'rep' ? tr('عدد المناديب') : tr('عدد العملاء');

  return (
    <Pane onScroll={onScroll}>
      <div className="flex gap-1.5">
        {GROUPS.map(g => (
          <button key={g.id} onClick={() => onGroupBy(g.id)}
            className={`flex-1 min-h-[44px] rounded-xl text-xs font-semibold transition-colors
              ${groupBy === g.id ? 'bg-[#FBEBE2] text-[#C94E28] border border-[#E15A30]' : 'bg-white text-[#6E6557] border border-[#F1EBDF]'}`}>
            {tr('حسب')} {tr(g.label)}
          </button>
        ))}
      </div>

      {/* الخادم يقصّ المبيعات على ٩٠ يوماً حين لا يُمرَّر مدى — والصمت عن القصّ
          يجعل التقرير يُقرأ على أنه «كل التاريخ» فتُبنى عليه مقارنة باطلة */}
      {!from && !to && <Hint>{tr('بلا مدى محدد يعرض الخادم آخر تسعين يوما فقط')}</Hint>}

      <State q={q} empty={rows.length === 0} emptyText={tr('لا مبيعات في هذا المدى')} emptyIcon={TrendingUp}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي المبيعات')} value={formatCurrency(sum.total)} icon={TrendingUp} />
          <MStat
            label={byProduct ? tr('إجمالي الكمية') : tr('عدد الفواتير')}
            value={formatNumber(byProduct ? sum.qty : sum.count)}
            icon={byProduct ? Package : Receipt} />
          <MStat label={rowsLabel} value={formatNumber(rows.length)} icon={Users} />
          <MStat
            label={byProduct ? tr('متوسط قيمة الصنف') : tr('متوسط الفاتورة')}
            value={formatCurrency(byProduct
              ? (rows.length ? sum.total / rows.length : 0)
              : (sum.count ? sum.total / sum.count : 0))} />
        </div>

        <MCard>
          {rows.slice(0, limit).map((r, i) => (
            <MRow key={`${r.name}-${i}`}
              title={r.name}
              subtitle={byProduct
                ? [r.code, `${formatNumber(r.qty ?? 0)} ${tr('وحدة')}`].filter(Boolean).join(' · ')
                : `${formatNumber(r.count ?? 0)} ${tr('فاتورة')}`}
              trailing={<Amount value={formatCurrency(r.total)} />} />
          ))}
        </MCard>
        <More hidden={hidden} />
      </State>
    </Pane>
  );
}

// ═══════════════ ٢) التحصيل ═══════════════

function CollectionsReport({ from, to }: { from: string; to: string }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-report', 'collections', from, to],
    queryFn: async () => expectObject<CollectionsRes>(
      (await reportApi.collections(params({ from, to }))).data?.data, 'تقرير التحصيل'),
  });
  const receipts = useMemo(() => q.data?.receipts ?? [], [q.data]);
  const { limit, onScroll, hidden } = useWindowed(`${from}|${to}`, receipts.length);
  const summary = q.data?.summary;
  const methods = summary ? Object.entries(summary.byMethod) : [];

  return (
    <Pane onScroll={onScroll}>
      <State q={q} empty={!summary || summary.count === 0}
        emptyText={tr('لا سندات قبض في هذا المدى')} emptyIcon={Receipt}>
        {summary && (
          <>
            <div className="grid grid-cols-2 gap-2.5">
              <MStat label={tr('إجمالي التحصيل')} value={formatCurrency(summary.total)} tone="good" icon={Wallet} />
              <MStat label={tr('عدد السندات')} value={formatNumber(summary.count)} icon={Receipt} />
            </div>

            {/* التوزيع على طرق الدفع: النقد في السيارة سؤالُ المشرف الأول */}
            <MCard>
              {methods.map(([m, v]) => (
                <MRow key={m} title={methodLabel(m, tr)}
                  subtitle={summary.total > 0 ? `${Math.round((v / summary.total) * 100)}%` : undefined}
                  trailing={<Amount value={formatCurrency(v)} tone="good" />} />
              ))}
            </MCard>

            <p className="text-[11px] font-semibold text-[#6E6557] px-1 pt-1">{tr('السندات')}</p>
            <MCard>
              {receipts.slice(0, limit).map(r => (
                <MRow key={r.id}
                  leading={<Initial name={r.customer.name} />}
                  title={r.customer.name}
                  subtitle={`${r.number} · ${formatDate(r.receiptDate)} · ${methodLabel(r.paymentMethod, tr)}`}
                  note={r.salesRep ? `${tr('المندوب')}: ${r.salesRep.name}` : undefined}
                  trailing={<Amount value={formatCurrency(r.amount)} tone="good" />} />
              ))}
            </MCard>
            <More hidden={hidden} />
          </>
        )}
      </State>
    </Pane>
  );
}

// ═══════════════ ٣) أرصدة العملاء ═══════════════

/** المدينون وحدهم (`type=overdue`) — من رصيده صفر ليس بنداً في تقرير مديونية */
function BalancesReport() {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-report', 'balances'],
    queryFn: async () => expectArray<BalanceRow>(
      (await reportApi.balances({ type: 'overdue' })).data?.data, 'أرصدة العملاء'),
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const { limit, onScroll, hidden } = useWindowed('balances', rows.length);

  const sum = useMemo(() => ({
    total: rows.reduce((s, c) => s + c.balance, 0),
    exceeded: rows.filter(c => c.creditLimit > 0 && c.balance > c.creditLimit).length,
  }), [rows]);

  return (
    <Pane onScroll={onScroll}>
      <State q={q} empty={rows.length === 0} emptyText={tr('لا عملاء مدينين')} emptyIcon={Users}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي مديونية الشركة')} value={formatCurrency(sum.total)} tone="bad" icon={Wallet} />
          <MStat label={tr('العملاء المدينون')} value={formatNumber(rows.length)} icon={Users} />
          <MStat label={tr('متجاوزو الحد الائتماني')} value={formatNumber(sum.exceeded)}
            tone={sum.exceeded > 0 ? 'bad' : 'default'} icon={AlertTriangle} />
          <MStat label={tr('متوسط المديونية')}
            value={formatCurrency(rows.length ? sum.total / rows.length : 0)} />
        </div>

        <MCard>
          {rows.slice(0, limit).map(c => {
            const over = c.creditLimit > 0 && c.balance > c.creditLimit;
            return (
              <MRow key={c.id}
                leading={<Initial name={c.name} />}
                title={c.name}
                subtitle={[c.phone, c.creditLimit > 0 ? `${tr('الحد')} ${formatCurrency(c.creditLimit)}` : null]
                  .filter(Boolean).join(' · ')}
                note={over ? tr('تجاوز الحد الائتماني') : undefined}
                trailing={<Amount value={formatCurrency(c.balance)} tone={over ? 'bad' : 'warn'} />} />
            );
          })}
        </MCard>
        <More hidden={hidden} />
      </State>
    </Pane>
  );
}

// ═══════════════ ٤) أداء المناديب ═══════════════

function PerformanceReport({ from, to, onOpen }: {
  from: string; to: string; onOpen: (d: Detail) => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-report', 'performance', from, to],
    queryFn: async () => expectArray<PerfRow>(
      (await reportApi.repPerformance(params({ from, to }))).data?.data, 'أداء المناديب'),
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const { limit, onScroll, hidden } = useWindowed(`${from}|${to}`, rows.length);

  const sum = useMemo(() => rows.reduce((a, r) => ({
    sales: a.sales + r.salesTotal,
    collected: a.collected + r.collectionsTotal,
    invoices: a.invoices + r.invoicesCount,
    visits: a.visits + r.visitsCount,
  }), { sales: 0, collected: 0, invoices: 0, visits: 0 }), [rows]);
  const rate = sum.sales > 0 ? Math.round((sum.collected / sum.sales) * 100) : 0;

  return (
    <Pane onScroll={onScroll}>
      <State q={q} empty={rows.length === 0} emptyText={tr('لا مناديب نشطين')} emptyIcon={UserCheck}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي المبيعات')} value={formatCurrency(sum.sales)} icon={TrendingUp} />
          <MStat label={tr('إجمالي التحصيل')} value={formatCurrency(sum.collected)} tone="good" icon={Wallet} />
          {/* النسبة من **مجاميع المعروض** لا متوسّط نسب المناديب: متوسّط النسب
              يساوي بين مندوبٍ باع ألفاً وآخر باع مليوناً فيُجمّل التقصير */}
          <MStat label={tr('نسبة التحصيل')} value={`${formatNumber(rate)}%`}
            tone={rate >= 80 ? 'good' : rate >= 50 ? 'warn' : 'bad'} />
          <MStat label={tr('عدد الفواتير')} value={formatNumber(sum.invoices)} icon={Receipt} />
          <MStat label={tr('عدد الزيارات')} value={formatNumber(sum.visits)} icon={MapPin} />
          <MStat label={tr('المناديب')} value={formatNumber(rows.length)} icon={UserCheck} />
        </div>

        <MCard>
          {rows.slice(0, limit).map(r => (
            <MRow key={r.id}
              leading={<Initial name={r.name} />}
              title={r.name}
              subtitle={`${formatNumber(r.invoicesCount)} ${tr('فاتورة')} · ${tr('تحصيل')} ${formatNumber(r.collectionRate)}% · ${formatNumber(r.visitsCount)} ${tr('زيارة')}`}
              trailing={<Amount value={formatCurrency(r.salesTotal)} chevron />}
              onClick={() => onOpen({ kind: 'perf', row: r })} />
          ))}
        </MCard>
        <More hidden={hidden} />
      </State>
    </Pane>
  );
}

// ═══════════════ ٥) مديونيات المناديب ═══════════════

/**
 * رصيد كل عميل مُسنَد لكل مندوب — **لحظيّ** بلا مدى تاريخ.
 *
 * والإجمالي المعتمَد هنا هو **المتمايز**: العميل المُسنَد لمندوبين يُحسب رصيده
 * تحت كلٍّ منهما، فمجموع أعمدة المناديب يتضخّم بالتكرار ولا يساوي مديونية
 * الشركة. نُظهر المتمايز كبيراً ونُصرّح بمجموع الأعمدة تحته لا العكس.
 */
function ReceivablesReport({ onOpen }: { onOpen: (d: Detail) => void }) {
  const tr = useTr();
  const live = useIsLive();
  const q = useQuery({
    queryKey: ['m-report', 'receivables'],
    queryFn: async () => expectArray<RecvRow>(
      (await reportApi.repReceivables()).data?.data, 'مديونيات المناديب'),
    // التقرير الوحيد الذي يستحقّ استطلاعاً: رصيدٌ لحظيّ يتغيّر بكل سند قبض
    // يُصدره مندوبٌ في الميدان الآن. والبقيّة تقاريرُ مدىً لا تتحرّك وحدها.
    refetchInterval: livePoll(60000, live),
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const { limit, onScroll, hidden } = useWindowed('receivables', rows.length);

  const sum = useMemo(() => {
    const bal = new Map<string, number>();        // العميل → رصيده مرّة واحدة
    const reps = new Map<string, number>();       // العميل → كم مندوباً أُسنِد لهم
    for (const r of rows) for (const c of r.customers) {
      bal.set(c.id, c.balance);
      reps.set(c.id, (reps.get(c.id) ?? 0) + 1);
    }
    let receivable = 0, debtors = 0, shared = 0;
    for (const b of bal.values()) { receivable += b; if (b > 0) debtors++; }
    for (const nRep of reps.values()) if (nRep > 1) shared++;
    return {
      receivable, debtors, shared, customers: bal.size,
      columns: rows.reduce((s, r) => s + r.totalBalance, 0),
    };
  }, [rows]);

  return (
    <Pane onScroll={onScroll}>
      <State q={q} empty={!rows.some(r => r.customersCount > 0)}
        emptyText={tr('لا عملاء مسندين للمناديب بعد أسندهم من صفحة المناديب')} emptyIcon={Wallet}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('مديونية المسندين بلا تكرار')} value={formatCurrency(sum.receivable)}
            tone={sum.receivable > 0 ? 'bad' : 'good'} icon={Wallet} />
          <MStat label={tr('العملاء المدينون')} value={formatNumber(sum.debtors)} icon={Users} />
          <MStat label={tr('العملاء المسندون')} value={formatNumber(sum.customers)} />
          <MStat label={tr('المناديب')} value={formatNumber(rows.length)} icon={UserCheck} />
        </div>

        {sum.shared > 0 && (
          <Note>
            <b>{formatNumber(sum.shared)}</b> {tr('عميل مسند لأكثر من مندوب فرصيده محسوب تحت كل منهم لا تجمع أعمدة المناديب مجموعها')}
            {' '}{formatCurrency(sum.columns)} {tr('اعتمد الإجمالي أعلاه')}
          </Note>
        )}

        <MCard>
          {rows.slice(0, limit).map(r => (
            <MRow key={r.id}
              leading={<Initial name={r.name} />}
              title={r.name}
              subtitle={`${formatNumber(r.customersCount)} ${tr('عميل مسند')} · ${tr('المدينون')} ${formatNumber(r.debtorsCount)}`}
              note={r.customersCount === 0 ? tr('لا عملاء مسندين لهذا المندوب') : undefined}
              trailing={<Amount value={formatCurrency(r.totalBalance)}
                tone={r.totalBalance > 0 ? 'bad' : 'good'} chevron={r.customersCount > 0} />}
              onClick={r.customersCount > 0 ? () => onOpen({ kind: 'recv', row: r }) : undefined} />
          ))}
        </MCard>
        <More hidden={hidden} />
      </State>
    </Pane>
  );
}

// ═══════════════ ٦) ساعات العمل ═══════════════

function HoursReport({ from, to, onOpen }: {
  from: string; to: string; onOpen: (d: Detail) => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-report', 'hours', from, to],
    queryFn: async () => {
      // إزاحة الجهاز تُمرَّر للخادم: «اليوم» يوم المندوب لا يوم الخادم
      const res = await reportApi.workHours(
        params({ from, to, tz: String(-new Date().getTimezoneOffset()) }));
      return {
        rows: expectArray<WorkHoursRow>(res.data?.data, 'ساعات العمل'),
        // الخادم يقصّ المدى عند ٣١ يوماً ويُعلن ذلك — تجاهلُه يجعل المشرف
        // يختار ثلاثة أشهر ويقرأ شهراً واحداً وهو يظنّه ثلاثة
        clamped: (res.data?.meta?.rangeClamped as number | undefined) ?? null,
      };
    },
  });
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  const { limit, onScroll, hidden } = useWindowed(`${from}|${to}`, rows.length);

  const sum = useMemo(() => rows.reduce((a, r) => ({
    field: a.field + r.fieldMinutesTotal,
    worked: a.worked + r.workedDays,
    absent: a.absent + r.absentDays,
    visits: a.visits + r.visitsTotal,
  }), { field: 0, worked: 0, absent: 0, visits: 0 }), [rows]);

  return (
    <Pane onScroll={onScroll}>
      {!from && !to && <Hint>{tr('بلا مدى محدد يعرض الخادم آخر سبعة أيام')}</Hint>}
      {q.data?.clamped != null && (
        <Note>{tr('المدى المطلوب أطول من المسموح عرضت آخر')} {formatNumber(q.data.clamped)} {tr('يوما فقط')}</Note>
      )}

      <State q={q} empty={rows.length === 0} emptyText={tr('لا بيانات حضور في هذه الفترة')} emptyIcon={Clock}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي وقت العمل')} value={fmtMin(sum.field, tr)} tone="good" icon={Clock} />
          <MStat label={tr('أيام الحضور')} value={formatNumber(sum.worked)} icon={CalendarDays} />
          <MStat label={tr('أيام بلا نشاط')} value={formatNumber(sum.absent)}
            tone={sum.absent > 0 ? 'bad' : 'default'} />
          <MStat label={tr('عدد الزيارات')} value={formatNumber(sum.visits)} icon={MapPin} />
        </div>

        {/* المقياس يُشرح مرّةً هنا: «إجمالي وقت العمل» ليس وقت التطبيق مفتوحاً */}
        <Hint>{tr('إجمالي وقت العمل يقاس من أول أثر مرصود في اليوم إلى آخره ونشاط التطبيق هو الوقت الذي كان فيه التطبيق مفتوحا ومتصلا فقط')}</Hint>

        <MCard>
          {rows.slice(0, limit).map(r => (
            <MRow key={r.id}
              leading={<Initial name={r.name} />}
              title={r.name}
              subtitle={`${formatNumber(r.workedDays)} ${tr('يوم حضور')} · ${formatNumber(r.absentDays)} ${tr('بلا نشاط')} · ${formatNumber(r.visitsTotal)} ${tr('زيارة')}`}
              trailing={<Amount value={fmtMin(r.fieldMinutesTotal, tr)} chevron />}
              onClick={() => onOpen({ kind: 'hours', row: r })} />
          ))}
        </MCard>
        <More hidden={hidden} />
      </State>
    </Pane>
  );
}

// ═══════════════ ٧) زيارات العملاء ═══════════════

function VisitsReport({ from, to, onOpen }: {
  from: string; to: string; onOpen: (d: Detail) => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ['m-report', 'visits', from, to],
    queryFn: async () => expectObject<{ count: number; visits: CustVisit[] }>(
      (await reportApi.customerVisits(params({ from, to }))).data?.data, 'زيارات العملاء'),
  });
  const visits = useMemo(() => q.data?.visits ?? [], [q.data]);

  // صفٌّ لكل عميل لا لكل زيارة: المشرف يسأل «مَن زرناه وكم مرّة» قبل «متى»
  const groups = useMemo<CustGroup[]>(() => {
    const map = new Map<string, CustVisit[]>();
    for (const v of visits) {
      const arr = map.get(v.customerId) ?? [];
      arr.push(v);
      map.set(v.customerId, arr);
    }
    const out = [...map.values()].map(vs => {
      const durs = vs.map(x => x.durationSec).filter((d): d is number => typeof d === 'number' && d > 0);
      return {
        customerId: vs[0].customerId,
        customerName: vs[0].customerName,
        visitsCount: vs.length,
        avgDurationSec: durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null,
        lastVisit: vs[0].createdAt,   // الخادم يرتّب تنازلياً ⇒ الأحدث أولاً
        visits: vs,
      };
    });
    out.sort((a, b) => b.visitsCount - a.visitsCount || (b.lastVisit > a.lastVisit ? 1 : -1));
    return out;
  }, [visits]);

  const { limit, onScroll, hidden } = useWindowed(`${from}|${to}`, groups.length);
  const avgAll = useMemo(() => {
    const durs = visits.map(v => v.durationSec).filter((d): d is number => typeof d === 'number' && d > 0);
    return durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null;
  }, [visits]);

  return (
    <Pane onScroll={onScroll}>
      <State q={q} empty={visits.length === 0} emptyText={tr('لا زيارات في هذا المدى')} emptyIcon={MapPin}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي الزيارات')} value={formatNumber(visits.length)} icon={MapPin} />
          <MStat label={tr('العملاء المزارون')} value={formatNumber(groups.length)} icon={Users} />
          <MStat label={tr('متوسط مدة الزيارة')} value={fmtSec(avgAll, tr) ?? tr('بلا توقيت')} icon={Clock} />
          <MStat label={tr('متوسط الزيارات للعميل')}
            value={formatNumber(groups.length ? Math.round((visits.length / groups.length) * 10) / 10 : 0)} />
        </div>

        <MCard>
          {groups.slice(0, limit).map(g => (
            <MRow key={g.customerId}
              leading={<Initial name={g.customerName} />}
              title={g.customerName || tr('عميل بلا اسم')}
              subtitle={`${formatNumber(g.visitsCount)} ${tr('زيارة')} · ${tr('آخر زيارة')} ${formatDateTime(g.lastVisit)}`}
              trailing={<Amount value={fmtSec(g.avgDurationSec, tr) ?? tr('بلا توقيت')} chevron />}
              onClick={() => onOpen({ kind: 'cust', group: g })} />
          ))}
        </MCard>
        <More hidden={hidden} />
      </State>
    </Pane>
  );
}

// ═══════════════ طبقات التفصيل ═══════════════

function DetailPane({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  if (detail.kind === 'perf') return <PerfDetail row={detail.row} onClose={onClose} />;
  if (detail.kind === 'recv') return <RecvDetail row={detail.row} onClose={onClose} />;
  if (detail.kind === 'hours') return <HoursDetail row={detail.row} onClose={onClose} />;
  return <CustDetail group={detail.group} onClose={onClose} />;
}

function PerfDetail({ row, onClose }: { row: PerfRow; onClose: () => void }) {
  const tr = useTr();
  const { limit, onScroll, hidden } = useWindowed(row.id, row.visits.length);
  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={row.name} subtitle={tr('أداء المندوب')} onBack={onClose} />
      <Pane onScroll={onScroll}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي المبيعات')} value={formatCurrency(row.salesTotal)} icon={TrendingUp} />
          <MStat label={tr('إجمالي التحصيل')} value={formatCurrency(row.collectionsTotal)} tone="good" icon={Wallet} />
          <MStat label={tr('نسبة التحصيل')} value={`${formatNumber(row.collectionRate)}%`}
            tone={row.collectionRate >= 80 ? 'good' : row.collectionRate >= 50 ? 'warn' : 'bad'} />
          <MStat label={tr('متوسط الفاتورة')} value={formatCurrency(row.avgInvoice)} />
          <MStat label={tr('عدد الفواتير')} value={formatNumber(row.invoicesCount)} icon={Receipt} />
          <MStat label={tr('إجمالي الخصومات')} value={formatCurrency(row.discountTotal)}
            tone={row.discountTotal > 0 ? 'warn' : 'default'} />
          <MStat label={tr('نشاط التطبيق')} value={fmtMin(row.workMinutes, tr)} icon={Clock} />
          <MStat label={tr('عدد الزيارات')} value={formatNumber(row.visitsCount)} icon={MapPin} />
        </div>

        {row.visits.length > 0 && (
          <>
            {/* مواقع الزيارات: الخادم يرسل ما له إحداثيات فقط، وقد تقلّ عن العدّاد */}
            <p className="text-[11px] font-semibold text-[#6E6557] px-1 pt-1">
              {tr('مواقع الزيارات المرصودة')} ({formatNumber(row.visits.length)})
            </p>
            <MCard>
              {row.visits.slice(0, limit).map((v, i) => (
                <MLinkRow key={`${v.createdAt}-${i}`} href={v.mapsUrl}
                  title={v.customerName || tr('زيارة')}
                  subtitle={formatDateTime(v.createdAt)}
                  trailing={<span className="text-[11px] font-semibold text-[#2563EB] flex-shrink-0">{tr('خريطة')}</span>} />
              ))}
            </MCard>
            <More hidden={hidden} />
          </>
        )}
      </Pane>
    </div>
  );
}

function RecvDetail({ row, onClose }: { row: RecvRow; onClose: () => void }) {
  const tr = useTr();
  const { limit, onScroll, hidden } = useWindowed(row.id, row.customers.length);
  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={row.name} subtitle={tr('مديونيات العملاء المسندين')} onBack={onClose} />
      <Pane onScroll={onScroll}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي المديونية')} value={formatCurrency(row.totalBalance)}
            tone={row.totalBalance > 0 ? 'bad' : 'good'} icon={Wallet} />
          <MStat label={tr('العملاء المدينون')} value={formatNumber(row.debtorsCount)} icon={Users} />
        </div>

        <MCard>
          {row.customers.slice(0, limit).map(c => (
            <MRow key={c.id}
              leading={<Initial name={c.name} />}
              title={c.businessName ? `${c.name} — ${c.businessName}` : c.name}
              subtitle={[c.phone, c.city].filter(Boolean).join(' · ')}
              // «لم يحصل قط» هو عينُ التقصير الذي يبحث عنه المشرف، فيُرفع لسطر بارز
              note={c.lastPaymentAt
                ? `${tr('آخر تحصيل')}: ${formatDate(c.lastPaymentAt)}`
                : tr('لم يحصل منه قط')}
              trailing={<Amount value={formatCurrency(c.balance)} tone={c.balance > 0 ? 'bad' : 'good'} />} />
          ))}
        </MCard>
        <More hidden={hidden} />
      </Pane>
    </div>
  );
}

function HoursDetail({ row, onClose }: { row: WorkHoursRow; onClose: () => void }) {
  const tr = useTr();
  const [openDay, setOpenDay] = useState<string | null>(null);
  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={row.name} subtitle={tr('ساعات العمل')} onBack={onClose} />
      <Pane>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('إجمالي وقت العمل')} value={fmtMin(row.fieldMinutesTotal, tr)} tone="good" icon={Clock} />
          <MStat label={tr('متوسط اليوم')} value={fmtMin(row.avgDayMinutes, tr)} />
          <MStat label={tr('أيام الحضور')} value={formatNumber(row.workedDays)} icon={CalendarDays} />
          <MStat label={tr('أيام بلا نشاط')} value={formatNumber(row.absentDays)}
            tone={row.absentDays > 0 ? 'bad' : 'default'} />
          <MStat label={tr('نشاط التطبيق')} value={fmtMin(row.totalMinutes, tr)} />
          <MStat label={tr('عدد الزيارات')} value={formatNumber(row.visitsTotal)} icon={MapPin} />
        </div>

        <p className="text-[11px] font-semibold text-[#6E6557] px-1 pt-1">{tr('الحضور اليومي')}</p>
        <MCard>
          {/* Fragment لا div: فاصلُ MRow هو `last:border-0`، ولفُّ كل صفٍّ في
              عنصرٍ يجعله «الابن الأخير» في غلافه فتختفي الفواصل من القائمة كلّها */}
          {row.days.map(d => (
            <Fragment key={d.date}>
              <MRow
                title={formatDayOnly(d.date)}
                subtitle={d.absent
                  ? tr('لا نشاط مسجل في هذا اليوم')
                  : `${formatTime(d.firstActivity)} ← ${formatTime(d.lastActivity)} · ${formatNumber(d.visitsCount)} ${tr('زيارة')}`}
                trailing={d.absent
                  ? <span className="text-[11px] text-[#B3A996] flex-shrink-0">{tr('غياب')}</span>
                  : <Amount value={fmtMin(d.spanMinutes, tr)} chevron={d.visitsCount > 0} />}
                onClick={d.visitsCount > 0
                  ? () => setOpenDay(p => (p === d.date ? null : d.date))
                  : undefined} />
              {openDay === d.date && (
                <div className="bg-[#FDFBF7] border-b border-[#F1EBDF] last:border-0 px-3.5 py-2 space-y-1.5">
                  {d.visits.map((v, i) => <VisitLine key={`${d.date}-${i}`} v={v} />)}
                </div>
              )}
            </Fragment>
          ))}
        </MCard>
      </Pane>
    </div>
  );
}

/** وقفةٌ واحدة لكل عميل: بداية ونهاية صريحتان لا صفّان لزيارةٍ مُجزّأة */
function VisitLine({ v }: { v: WorkVisit }) {
  const tr = useTr();
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="flex-1 min-w-0 truncate text-[#1F1A13] font-medium">
        {v.customerName}
        {v.hasNote && <span className="ms-1 text-[#2E6FB0]">{tr('ملاحظة')}</span>}
      </span>
      <span className="tabular-nums text-[#1E7A52] font-semibold">{formatTime(v.start)}</span>
      <span className="text-[#C9BFB0]">←</span>
      <span className="tabular-nums text-[#C0392B] font-semibold">
        {v.end ? formatTime(v.end) : tr('بلا توقيت')}
      </span>
      <span className="tabular-nums text-[#2E6FB0] font-semibold w-16 text-end">
        {fmtSec(v.durationSec, tr) ?? '—'}
      </span>
    </div>
  );
}

function CustDetail({ group, onClose }: { group: CustGroup; onClose: () => void }) {
  const tr = useTr();
  const { limit, onScroll, hidden } = useWindowed(group.customerId, group.visits.length);
  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={group.customerName || tr('عميل بلا اسم')} subtitle={tr('زيارات العميل')} onBack={onClose} />
      <Pane onScroll={onScroll}>
        <div className="grid grid-cols-2 gap-2.5">
          <MStat label={tr('عدد الزيارات')} value={formatNumber(group.visitsCount)} icon={MapPin} />
          <MStat label={tr('متوسط مدة الزيارة')} value={fmtSec(group.avgDurationSec, tr) ?? tr('بلا توقيت')} icon={Clock} />
        </div>

        <MCard>
          {group.visits.slice(0, limit).map(v => {
            const dur = fmtSec(v.durationSec, tr);
            const title = v.repName || tr('مندوب محذوف');
            const sub = [formatDateTime(v.createdAt), dur, v.note].filter(Boolean).join(' · ');
            // زيارةٌ بلا إحداثيات تبقى صفّاً عادياً: غيابُ الموقع لا يحذف الزيارة
            return v.mapsUrl
              ? <MLinkRow key={v.id} href={v.mapsUrl} title={title} subtitle={sub}
                trailing={<span className="text-[11px] font-semibold text-[#2563EB] flex-shrink-0">{tr('خريطة')}</span>} />
              : <MRow key={v.id} title={title} subtitle={sub}
                trailing={<span className="text-[11px] text-[#9A8F7E] flex-shrink-0">{tr('بلا موقع')}</span>} />;
          })}
        </MCard>
        <More hidden={hidden} />
      </Pane>
    </div>
  );
}
