import { useState, useMemo, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportApi, productApi, teamsApi, companyApi, attendanceAdminApi, lotsApi } from '../api/client';
import AttendanceEditModal from '../components/attendance/AttendanceEditModal';
import AttendanceImportModal from '../components/attendance/AttendanceImportModal';
import PresenceDayModal from '../components/attendance/PresenceDayModal';
import { presenceByRepDay, presenceSummary, type PresenceRow } from '../lib/presenceReport';
import { splitSheetsByTeam } from '../lib/teamReport';
import RepRankingBoard, { RANKING_LABELS, type RankingData, type RankingMetric } from '../components/reports/RepRankingBoard';
import { formatCurrency, activeLocale, formatDayOnly } from '../utils/format';
import { useTr } from '../i18n/strings';
import { channelLabel } from '../lib/channels';
import { filterFlat, filterNested } from '../lib/reportSearch';
import { groupCollectionsByRep, collectionTotals, CollReceiptLike, CollRepGroup } from '../lib/collectionsByRep';
import { companyMethodLabel } from '../lib/paymentMethodsConfig';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Download, TrendingUp, Users, UserCheck, MapPin, FileText, Search, X, Wallet, AlertTriangle, Pencil, Upload } from 'lucide-react';
import { shareOrDownloadExcel, num, ExcelSheet } from '../utils/excel';
import { mergeRuns } from '../lib/mergeRuns';
import { attendanceDayCells, breakOf, compactMinutes, periodsOf, punchDetailRows, punchInUrl, punchOutUrl, periodOutside, placeLabel, entryLabel, type WorkPeriodLike } from '../lib/workPeriods';
import { elementsToPdfBlob, downloadPdf } from '../rep/pdf';
import toast from 'react-hot-toast';
import { useAccountingOn } from '../components/AccountingGate';
import { baseQtyText, docQtyText, hasBigUnit } from '../lib/adminUnits';
import { factorOf, primaryUnitOf, productQtyText, type UnitDef } from '../lib/units';
import { LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS, docLotsFrom, lotFlagsOf, type InvoiceItemLotDto } from '../lib/lots';
import { docLotsText, groupLotSales, uncertainSold, type LotSalesReportDto, type LotSalesRowDto } from '../lib/invoiceLots';

type Tab = 'sales' | 'collections' | 'balances' | 'performance';

// زيارة **مدموجة**: سجلّ المؤقّت وسجلّ الملاحظة للعميل الواحد وقفةٌ واحدة
interface WorkVisit { customerName: string; start: string; end: string | null; durationSec: number | null; hasNote: boolean; parts: number; lat?: number | null; lng?: number | null }
interface WorkDayRow {
  date: string; firstActivity: string; lastActivity: string;
  spanMinutes: number; appMinutes: number;   // spanMinutes = وقت العمل بلا الاستراحات
  visits: WorkVisit[]; visitsCount: number; visitsSec: number;
  absent: boolean;   // يومٌ في المدى بلا أيّ أثر
  // الدوام المتقطّع: فترات اليوم ومجموع ما بينها — اختياريّان (خادمٌ أقدم أثناء انزلاق النشر لا يرسلهما)
  periods?: WorkPeriodLike[]; breakMinutes?: number;
}
interface WorkHoursRow {
  id: string; name: string; totalMinutes: number; hours: number; minutes: number; sessions: number;
  firstSeen: string | null; lastSeen: string | null;
  fieldMinutesTotal: number;   // Σ يوم العمل الميداني (أول أثر → آخر أثر) عبر المدى
  workedDays: number; absentDays: number; visitsTotal: number; avgDayMinutes: number;
  days: WorkDayRow[];
}
interface VisitLoc { customerName: string; createdAt: string; lat: number; lng: number; mapsUrl: string }
interface PerfRow {
  id: string; name: string; invoicesCount: number; salesTotal: number; collectionsTotal: number; collectionRate: number; avgInvoice: number;
  workMinutes: number; workHours: number; workMins: number; visitsCount: number; visits: VisitLoc[];
}
interface RecvCustomer { id: string; name: string; businessName: string | null; phone: string; city: string | null; balance: number; lastPaymentAt: string | null }
interface RecvRow { id: string; name: string; customersCount: number; debtorsCount: number; totalBalance: number; customers: RecvCustomer[] }
interface CustVisit { id: string; customerId: string; customerName: string; repName: string; teamName?: string | null; createdAt: string; durationSec: number | null; note: string; mapsUrl: string }
/** فاتورةٌ حُدّد لها تاريخ تسليم — صفّ «تقرير الطلبات». */
interface OrderRow {
  id: string; number: string; invoiceDate: string; deliveryDate: string;
  total: number; paidAmt: number; status: string;
  customer: { id: string; name: string; phone: string; city: string | null } | null;
  salesRep: { id: string; name: string } | null;
  team?: { id: string; name: string } | null;
}
/** صفّ «تقرير المرتجع» — مستند إرجاعٍ مؤكَّد بفاتورة بيعه (إن رُبط) وبنوده */
interface ReturnRow {
  id: string; number: string; invoiceDate: string; total: number; taxAmt: number;
  reason: 'NORMAL' | 'DAMAGED' | 'EXCHANGE' | string; returnToStock: boolean | null; creditNote: boolean; notes: string | null;
  /** تالفٌ يدخل رصيد «المرتجع التالف» في السيارة (لا يُباع) مهما كانت returnToStock — منذ ١٥ أكتوبر ٢٠٢٦ */
  toDamagedStock?: boolean;
  saleInvoices: string[];
  customer: { id: string; name: string; phone: string; city: string | null } | null;
  salesRep: { id: string; name: string } | null;
  team?: { id: string; name: string } | null;
  // الوحدات المتعددة: `unit` لقطة وحدة البند والكمية بها، و`unitFactor` معاملها و`baseQty`/`baseUnit` بالأساس (routes/reports returnLineView)
  items: {
    name: string; unit: string; qty: number; unitFactor?: number; baseQty?: number; baseUnit?: string; lineTotal: number; returnExpired: boolean | null; expiresAt: string | null;
    // «الوحدة الرئيسية» (R2): رئيسيّ صنف البند — قيمةٌ صادقة ⇒ اسم الوحدة يُلحق بالكمية دائماً («×5 قارورة» لا «×5» تُقرأ كراتين).
    // null أو غائب (خادمٌ أقدم) ⇒ العرض القائم حرفاً
    primaryUnitId?: string | null;
    // «تتبّع اللوط»: صفوف توزيع البند بالأساس (withLots=1 والميزة مفعّلة) — lotId null «غير معروف»
    lots?: InvoiceItemLotDto[];
  }[];
}
/**
 * صفّ «المبيعات حسب الصنف»: `qty` **بالأساس** (`unit` اسمها) و`units` وحدات الصنف — يُعرض «٢ كرتون و٣ حبة».
 * و`primaryUnitId` (الوحدة الرئيسية) يجعل العرض يقف عندها «52 كرتون و2 قارورة» (baseQtyText، R1) — null أو غائب ⇒ القائم
 */
type SalesRow = { name: string; total: number; count?: number; qty?: number; code?: string; unit?: string; units?: UnitDef[]; primaryUnitId?: string | null };
/** أرقام الكمية في التقارير كما كانت (بلا منسّق محلّي) — formatQty يُطبَّق عليها وحدها */
const plainQty = (n: number) => String(Number(n.toFixed(3)));
interface ReturnsSummary { count: number; total: number; salesTotal: number; returnRate: number | null; byReason: Record<string, { count: number; total: number }>; expiredLines: number }
const RETURN_REASON_LABELS: Record<string, string> = { NORMAL: 'مرتجع عادي', DAMAGED: 'بضاعة تالفة', EXCHANGE: 'استبدال' };
interface CustGroup { customerId: string; customerName: string; visitsCount: number; avgDurationSec: number | null; lastVisit: string; visits: CustVisit[] }
/* سند القبض وتجميعةُ المندوب: أنواع وحدة `lib/collectionsByRep` نفسها —
   نسخةٌ ثانية منهما تنحرف عن الحساب الذي تختبره وحدتُه. */
type CollReceipt = CollReceiptLike;
type CollRepRow = CollRepGroup<CollReceipt>;
/** طريقةٌ في ملخّص التحصيل كما حلّها الخادم («إدارة طرق الدفع»: المضافة بمفتاحها) — غائبة من خادمٍ أقدم */
interface CollMethod { id: string; base: string; key: string | null; custom: boolean; label: string; companyLabel: string | null; amount: number }
/** أعمدة الأسس الأربعة في جدول «التحصيل حسب المندوب» — حاضرةٌ دائماً كما قبل الميزة */
const COLL_BASE_COLS = ['CASH', 'POS', 'BANK_TRANSFER', 'CHEQUE'];

export default function ReportsPage() {
  const tr = useTr();

  /* المحاسبة مطفأة ⇒ تبقى من التقارير أعمال الميدان وحدها: زيارات العملاء
   * وساعات عمل المناديب. المبيعات والتحصيل وأرصدة العملاء ومديونيات المندوب
   * وأداؤه (فواتير ومبيعات وتحصيل) تُحذف من التبويبات ومن قوائم نوع التقرير،
   * ولا يُطلَب استعلامها. والقيم «الفعّالة» أدناه تُشتقّ من الحالة لا تحلّ محلّها:
   * فلو كان التبويب المحفوظ مالياً سقط إلى تبويبٍ مسموح بدل أن يُعرض فارغاً. */
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();

  const [tabState, setTab] = useState<Tab>('sales');
  const tab: Tab = accountingOn ? tabState : (tabState === 'sales' || tabState === 'collections' ? 'balances' : tabState);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState('rep');
  const [search, setSearch] = useState('');
  /* «فرق العمل»: فلتر الفريق ('' كل الفرق، 'none' بلا فريق، أو معرّف) — يظهر حين فعّلت الشركة الفرق ولها فرق. المستندات
   * تُفلتر بوسمها والمناديب بعضويتهم (الخادم)، والفريق جزءٌ من مفتاح كل استعلام فلا يعرض الكاش فريقاً آخر. */
  const [teamFilterState, setTeamFilter] = useState('');
  const [splitByTeam, setSplitByTeam] = useState(false);
  const teamsSettingsQ = useQuery({ queryKey: ['teams-settings'], queryFn: async () => (await teamsApi.settings()).data.data as { enabled: boolean } });
  const teamsQ = useQuery({
    queryKey: ['teams'], queryFn: async () => (await teamsApi.list()).data.data as { id: string; name: string; isActive: boolean }[],
    enabled: teamsSettingsQ.data?.enabled === true,
  });
  const teamsOn = teamsSettingsQ.data?.enabled === true && (teamsQ.data?.length ?? 0) > 0;
  const teamFilter = teamsOn ? teamFilterState : '';
  const tp: Record<string, string> = teamFilter ? { teamId: teamFilter } : {};
  const teamFilterName = teamFilter === 'none' ? tr('بلا فريق') : teamsQ.data?.find(t => t.id === teamFilter)?.name ?? '';
  // نوع تقرير المناديب: أداء | ساعات العمل | مديونيات | تقييم الأداء (ترتيب حسب معيار)
  const [perfTypeState, setPerfType] = useState<'performance' | 'hours' | 'receivables' | 'ranking'>('performance');
  // المحاسبة مطفأة: يبقى ساعات العمل وتقييم الأداء بمعاييره الميدانية
  const perfType = accountingOn ? perfTypeState : (perfTypeState === 'ranking' ? 'ranking' : 'hours');
  // تقييم الأداء: المعياران الماليّان (المبيعات وكمية الصنف) يختفيان مع المحاسبة المطفأة
  const rankMetrics: RankingMetric[] = accountingOn ? ['sales', 'visits', 'product', 'distance', 'appTime'] : ['visits', 'distance', 'appTime'];
  const [rankMetricState, setRankMetric] = useState<RankingMetric>('sales');
  const rankMetric: RankingMetric = rankMetrics.includes(rankMetricState) ? rankMetricState : 'visits';
  const [rankProduct, setRankProduct] = useState('');
  // نوع تقرير العملاء: أرصدة العملاء | زيارات العملاء
  // نوع تقرير المبيعات: التجميعة كما كانت، أو قائمة الطلبات (فواتير بتاريخ تسليم)
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as { attendanceEnabled?: boolean; paymentMethodsConfig?: unknown; lotTrackingEnabled?: boolean; lotOnInvoice?: boolean } | null,
    staleTime: 300_000,
  });
  /* «تتبّع اللوط» (ميزةٌ يفعّلها المالك): تقرير «المبيعات حسب التشغيلة» وتشغيلات بنود المرتجع — مطفأةً لا خيار ولا عمود ولا
   * طلب (§١٠.١)، ونوعٌ محفوظ «حسب التشغيلة» يسقط إلى التجميعة */
  const lotOn = lotFlagsOf(companyQ.data).on;
  const [salesTypeState, setSalesType] = useState<'summary' | 'orders' | 'returns' | 'lots'>('summary');
  const salesType = salesTypeState === 'lots' && !lotOn ? 'summary' : salesTypeState;
  // نوع تقرير التحصيل: ملخّصٌ عامّ (كما كان) أو تفصيلٌ لكلّ مندوب
  const [collType, setCollType] = useState<'summary' | 'byRep'>('summary');
  const [expandedColl, setExpandedColl] = useState<string | null>(null); // صفّ المندوب المفتوح
  const [custTypeState, setCustType] = useState<'balances' | 'visits'>('balances');
  const custType = accountingOn ? custTypeState : 'visits';

  // اسم المندوب للعرض: الفارغ هو دلو «بلا مندوب» (سندٌ من اللوحة أو مندوبٌ حُذف)
  const collRepName = (r: { name: string }) => r.name || tr('بدون مندوب سند من الإدارة');

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    ...(accountingOn ? [
      { id: 'sales' as Tab, label: tr('تقارير المبيعات'), icon: TrendingUp },
      { id: 'collections' as Tab, label: tr('تقارير التحصيل'), icon: Download },
    ] : []),
    { id: 'balances', label: tr('العملاء'), icon: Users },
    { id: 'performance', label: tr('أداء المناديب'), icon: UserCheck },
  ];

  const { data: salesData, isLoading: salesLoading } = useQuery({
    queryKey: ['report-sales', from, to, groupBy, teamFilter],
    queryFn: async () => {
      const res = await reportApi.sales({ from, to, groupBy, ...tp });
      return res.data.data;
    },
    enabled: accountingReady && accountingOn && tab === 'sales' && salesType === 'summary',
  });

  /* الطلبات: المدى يُطبَّق على **تاريخ التسليم** لا تاريخ الفاتورة — السؤال
   * «ما الذي عليّ تسليمه بين هذين التاريخين». */
  const ordersQ = useQuery({
    queryKey: ['report-orders', from, to, teamFilter],
    queryFn: async () => {
      const res = await reportApi.orders({ from, to, ...tp });
      return res.data.data as { orders: OrderRow[]; summary: { count: number; total: number; paid: number }; rangeApplied: boolean; defaultDays: number | null };
    },
    enabled: accountingReady && accountingOn && tab === 'sales' && salesType === 'orders',
  });

  // تقرير المرتجع — مستندات الإرجاع المؤكَّدة في المدى (تاريخ المرتجع)، ومعها نسبة المرتجع من مبيعات المدى نفسه
  const returnsQ = useQuery({
    queryKey: ['report-returns', from, to, teamFilter, lotOn],
    queryFn: async () => {
      const res = await reportApi.returns({ from, to, ...tp, ...(lotOn && { withLots: '1' }) });
      return res.data.data as { returns: ReturnRow[]; summary: ReturnsSummary; rangeApplied: boolean; defaultDays: number | null };
    },
    enabled: accountingReady && accountingOn && tab === 'sales' && salesType === 'returns',
  });

  // «تتبّع اللوط» — المبيعات حسب التشغيلة: لكل (صنف، تشغيلة) المباع والمرتجع والصافي بالأساس وعدد العملاء، بالنطاق والفريق
  const lotSalesQ = useQuery({
    queryKey: ['report-lot-sales', from, to, teamFilter],
    queryFn: async () => {
      const params = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...tp };
      return (await lotsApi.lotSales(params)).data.data as LotSalesReportDto;
    },
    enabled: accountingReady && accountingOn && lotOn && tab === 'sales' && salesType === 'lots',
    // رفض ٤xx (مدى مقلوب، الميزة أُطفئت) لا يتغيّر بالإعادة فيُقال فوراً — الإعادة للشبكة و٥xx
    retry: (n, e) => {
      const st = (e as { response?: { status?: number } } | null)?.response?.status ?? 0;
      return !(st >= 400 && st < 500) && n < 2;
    },
  });

  const { data: collectData } = useQuery({
    queryKey: ['report-collections', from, to, teamFilter],
    queryFn: async () => {
      const res = await reportApi.collections({ from, to, ...tp });
      return res.data.data as { receipts: CollReceipt[]; summary: { total: number; count: number; byMethod: Record<string, number>; methods?: CollMethod[] } };
    },
    enabled: accountingReady && accountingOn && tab === 'collections',
  });

  const { data: balancesData } = useQuery({
    queryKey: ['report-balances'],
    queryFn: async () => {
      const res = await reportApi.balances({ type: 'overdue' });
      return res.data.data as { id: string; name: string; phone: string; balance: number; creditLimit: number }[];
    },
    enabled: accountingReady && accountingOn && tab === 'balances' && custType === 'balances',
  });

  // تقرير زيارات العملاء — كل الزيارات في تقرير واحد (العميل، المندوب الزائر، الوقت)
  const { data: visitsData, status: visitsStatus, fetchStatus: visitsFetchStatus, refetch: visitsRefetch } = useQuery({
    queryKey: ['report-customer-visits', from, to, teamFilter],
    queryFn: async () => {
      const res = await reportApi.customerVisits({ from, to, ...tp });
      return res.data.data as { count: number; visits: CustVisit[] };
    },
    enabled: tab === 'balances' && custType === 'visits',
  });

  const [expandedPerf, setExpandedPerf] = useState<string | null>(null); // صفّ مواقع الزيارات المفتوح
  const [expandedCust, setExpandedCust] = useState<string | null>(null); // صفّ العميل المفتوح في تقرير الزيارات
  const [openDay, setOpenDay] = useState<string | null>(null);           // «معرّف المندوب|التاريخ» لليوم المفتوح
  // تعديل بصمات يومٍ لمندوب، ورفع بصمات من Excel (طلب المالك ٢١ أكتوبر ٢٠٢٦) — لشركةٍ فعّلت بصمة الحضور
  const [editDay, setEditDay] = useState<{ rep: { id: string; name: string }; date: string } | null>(null);
  // تفاصيل «التحقق العشوائي من التواجد» لمندوبٍ في يوم
  const [presenceDay, setPresenceDay] = useState<{ repName: string; date: string; rows: PresenceRow[] } | null>(null);
  const [showImport, setShowImport] = useState(false);
  const attendanceOn = companyQ.data?.attendanceEnabled === true;
  /* «إدارة طرق الدفع»: اسم الشركة للطريقة (مضافة أو مدمجة سمّتها) كما كتبته، وإلا كلمات هذا التقرير منذ قبل الميزة — و«تحويل»
   * القصير في البطاقات ورؤوس الأعمدة. وكان كل ما سوى الأربع (الإلكتروني وقيمٌ قديمة) يُقرأ «شيك» خطأً: الإلكتروني باسمه الآن */
  const baseMethodLabel = (m: string, short = false) => m === 'CASH' ? tr('نقدي') : m === 'BANK_TRANSFER' ? (short ? tr('تحويل') : tr('تحويل بنكي'))
    : m === 'POS' ? tr('شبكة') : m === 'CHEQUE' ? tr('شيك') : m === 'ONLINE' ? tr('دفع الكتروني') : m;
  const methodLabel = (m: string, key?: string | null) => companyMethodLabel(companyQ.data, m, key) ?? baseMethodLabel(m);
  /** طرق الملخّص: من الخادم بأسماء الشركة (المضافة سطرٌ بمفتاحها)، وخادمٌ أقدم ⇒ byMethod بالأساس كما اليوم */
  const collMethods = useMemo<{ id: string; label: string; short: string; amount: number }[]>(() => {
    const sm = collectData?.summary;
    if (!sm) return [];
    if (sm.methods) return sm.methods.map(m => {
      const own = m.companyLabel ?? (m.custom ? m.label : null);
      return { id: m.id, label: own ?? baseMethodLabel(m.base), short: own ?? baseMethodLabel(m.base, true), amount: m.amount };
    });
    return Object.entries(sm.byMethod).map(([m, v]) => {
      const own = companyMethodLabel(companyQ.data, m);
      return { id: m, label: own ?? baseMethodLabel(m), short: own ?? baseMethodLabel(m, true), amount: v };
    });
  }, [collectData, companyQ.data, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  /* أعمدة «التحصيل حسب المندوب»: الأسس الأربعة دائماً ثم ما حُصّل به غيرها (الإلكتروني والمضافة) — فتجمع الأعمدة الإجمالي.
   * والمفتاح المضاف عمودٌ إن عرفه الخادم (ملخّصه)، وإلا سندُه في عمود أساسه — قاعدة الخادم نفسها، لا كاش الشركة في المتصفح */
  const collKnownKeys = useMemo(
    () => new Set((collectData?.summary.methods ?? []).filter(m => m.custom && m.key).map(m => m.key as string)),
    [collectData],
  );
  const collCols = useMemo(() => {
    const extra = collMethods.map(m => m.id).filter(id => !COLL_BASE_COLS.includes(id));
    // عمود أساسٍ بلا تحصيلٍ في الفترة يحمل اسم الشركة أيضاً («مدى» لا «شبكة») — الملخّص لا يذكر إلا ما حُصّل به
    return [...COLL_BASE_COLS, ...extra].map(id => ({ id, short: collMethods.find(m => m.id === id)?.short ?? companyMethodLabel(companyQ.data, id) ?? baseMethodLabel(id, true) }));
  }, [collMethods, companyQ.data, tr]); // eslint-disable-line react-hooks/exhaustive-deps
  const { data: perfData } = useQuery({
    queryKey: ['report-performance', from, to, teamFilter],
    queryFn: async () => {
      const res = await reportApi.repPerformance({ from, to, ...tp });
      return res.data.data as PerfRow[];
    },
    enabled: accountingReady && accountingOn && tab === 'performance' && perfType === 'performance',
  });

  // مديونيات المندوب: رصيد كل عميل مُسنَد — لحظيّ، فلا يدخل التاريخ في مفتاح الكاش
  // نقرأ status/fetchStatus لا isLoading: عند تقلّب الشبكة يوقف React Query
  // إعادة المحاولة (fetchStatus='paused') فيصير isLoading **كاذباً** (false مع
  // غياب البيانات والخطأ معاً) — وسلسلة عرضٍ تعتمد عليه تسقط على حالة الفراغ
  // وتقول للمشرف «لا عملاء مُسنَدين» والحقيقة «انقطع الاتصال». أُثبت هذا
  // بالمعاينة: status=pending + fetchStatus=paused + failureCount=1.
  const { data: recvData, status: recvStatus, fetchStatus: recvFetchStatus, refetch: recvRefetch } = useQuery({
    queryKey: ['report-rep-receivables', teamFilter],
    queryFn: async () => {
      const res = await reportApi.repReceivables(tp);
      return res.data.data as RecvRow[];
    },
    enabled: accountingReady && accountingOn && tab === 'performance' && perfType === 'receivables',
  });

  // تقييم الأداء — الترتيب من الخادم بالمعيار المختار (والصنف لمعيار الكمية)، بحدود اليوم المحلي للمتصفّح
  const rankingQ = useQuery({
    queryKey: ['report-rep-ranking', from, to, rankMetric, rankMetric === 'product' ? rankProduct : '', teamFilter],
    queryFn: async () => {
      const res = await reportApi.repRanking({
        metric: rankMetric, from, to, tz: String(-new Date().getTimezoneOffset()), ...tp,
        ...(rankMetric === 'product' ? { productId: rankProduct } : {}),
      });
      return res.data.data as RankingData;
    },
    enabled: tab === 'performance' && perfType === 'ranking' && (rankMetric !== 'product' || !!rankProduct),
  });
  const rankProductsQ = useQuery({
    queryKey: ['products-min'],
    queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as { id: string; name: string }[],
    enabled: tab === 'performance' && perfType === 'ranking' && rankMetric === 'product',
  });

  // نفس درس المديونيات: fetchStatus='paused' يجعل isLoading كاذباً فيُعرض
  // «لا بيانات حضور» والحقيقة «انقطع الاتصال» — نقرأ الحالة الصريحة
  const { data: hoursData, status: hoursStatus, fetchStatus: hoursFetchStatus } = useQuery({
    queryKey: ['report-work-hours', from, to, teamFilter],
    queryFn: async () => {
      const res = await reportApi.workHours({ from, to, tz: String(-new Date().getTimezoneOffset()), ...tp });
      // نلتقط meta لا البيانات وحدها: الخادم يقصّ المدى عند ٣١ يوماً ويُعلن ذلك
      // في `rangeClamped` — وكانت الواجهة تتجاهله، فيختار المشرف ثلاثة أشهر
      // ويقرأ شهراً واحداً وهو يظنّه ثلاثة. القصّ الصامت أسوأ من رفض الطلب.
      return {
        rows: res.data.data as WorkHoursRow[],
        clampedDays: (res.data.meta?.rangeClamped as number | undefined) ?? null,
      };
    },
    enabled: tab === 'performance' && perfType === 'hours',
  });

  // صيغة عرض المدة: «Xس Yد»
  const fmtDuration = (h: number, m: number) => `${h} ${tr('س')} ${m} ${tr('د')}`;
  const fmtDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(activeLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString(activeLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  const fmtMin = (min: number) => fmtDuration(Math.floor(min / 60), min % 60);
  // مدة الزيارة بالثواني — بنفس تدرّج خريطة التتبّع حتى يتطابق المعروضان
  const fmtVisitDur = (sec: number | null) => sec == null || sec <= 0 ? null
    : sec >= 3600 ? `${Math.floor(sec / 3600)} ${tr('س')} ${Math.floor((sec % 3600) / 60)} ${tr('د')}`
    : sec >= 60 ? `${Math.floor(sec / 60)} ${tr('د')} ${sec % 60} ${tr('ث')}`
    : `${sec} ${tr('ث')}`;
  // منسّقات خلايا «الحضور اليومي» — ورقة كل المناديب وورقة المندوب الواحد من مصدرٍ واحد
  const dayCellFx = { tr, clock: fmtClock, minutes: fmtMin, visitDur: fmtVisitDur };
  // وقت بصمةٍ في خلية الفترات: بموقعٍ معلوم رابطٌ بدبّوسٍ صغير يفتح مكانها على الخريطة (ولا يطوي صفّ اليوم)،
  // وبلا موقع وقتٌ عاديّ كما كان
  const punchTime = (iso: string, url: string | null, tone: string, label: string) => url
    ? <a href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} title={label}
        className={`inline-flex items-center gap-0.5 rounded px-2 py-0.5 text-xs font-bold tabular-nums hover:underline ${tone}`}>
        <MapPin size={11} className="opacity-70" />{fmtClock(iso)}
      </a>
    : <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold tabular-nums ${tone}`}>{fmtClock(iso)}</span>;

  const groupLabel = () => groupBy === 'rep' ? tr('المندوب') : groupBy === 'customer' ? tr('العميل')
    : groupBy === 'channel' ? tr('القناة') : groupBy === 'region' ? tr('المنطقة') : groupBy === 'team' ? tr('الفريق') : tr('الصنف');
  // اسم العرض: أكواد القنوات تُترجَم، ودلو الفريق الفارغ «بلا فريق»؛ البقية كما هي
  const displayName = (name: string) => groupBy === 'channel' ? (name === 'UNSET' ? tr('غير محدد') : tr(channelLabel(name)))
    : groupBy === 'team' && !name ? tr('بلا فريق') : name;

  /**
   * تصفية بالاسم — **على المعروض، والتصدير يتبعها**.
   *
   * تصديرُ ملفٍ يخالف ما على الشاشة فخٌّ صامت: يبحث المشرف عن مندوب، يضغط
   * «تصدير»، فيخرج له الجميع ويظنّه بحثَه. لذلك تقرأ `buildSheets` هذه
   * القوائم نفسها لا الأصلية.
   *
   * والمطابقة على مستويين حيث يوجد تعشيش: اسم المندوب **أو** اسم عميلٍ تحته —
   * فيجد المشرفُ العميلَ ويعرف مَن يتولّاه.
   */
  const q = search.trim();
  const salesRows = useMemo(() => {
    if (!Array.isArray(salesData)) return salesData;
    const rows = salesData as { name: string; total: number; count?: number; qty?: number; code?: string }[];
    return filterFlat(rows, q, r => [r.name, displayName(r.name), r.code]);
  }, [salesData, q, groupBy]);

  // البحث: رقم الطلب أو العميل أو المندوب أو المدينة
  const orderRows = useMemo(
    () => filterFlat(ordersQ.data?.orders || [], q, o => [o.number, o.customer?.name, o.customer?.phone, o.customer?.city, o.salesRep?.name]),
    [ordersQ.data, q],
  );
  // البحث: رقم المرتجع أو فاتورة بيعه أو العميل أو المندوب أو المدينة أو اسم صنف فيه
  const returnRows = useMemo(
    () => filterFlat(returnsQ.data?.returns || [], q, r => [
      r.number, ...r.saleInvoices, r.customer?.name, r.customer?.phone, r.customer?.city, r.salesRep?.name, ...r.items.map(i => i.name),
    ]),
    [returnsQ.data, q],
  );
  // «حسب التشغيلة»: البحث باسم الصنف أو كوده أو رقم التشغيلة، والعرض مجمَّعٌ بالصنف بترتيب الخادم
  const lotSalesRows = useMemo(
    () => filterFlat(lotSalesQ.data?.rows || [], q, r => [r.productName, r.productCode, r.lotNumber]),
    [lotSalesQ.data, q],
  );
  const lotGroups = useMemo(() => groupLotSales(lotSalesRows, lotSalesQ.data?.products || []), [lotSalesRows, lotSalesQ.data]);
  // كمية تشغيلةٍ بالأساس بوحدات صنفها («٢ كرتون و٣ حبة»)
  // ولصنفٍ له وحدة رئيسية يقف عندها «2 كرتون و3 قارورة» (R1) — primaryUnitId من صفّ الخادم، وغيابه أو null ⇒ القائم
  const lotQty = (r: Pick<LotSalesRowDto, 'unit' | 'units'> & { primaryUnitId?: string | null }, n: number) => baseQtyText(n, r, plainQty, { withUnit: true });
  // تشغيلات بند مرتجعٍ نصّاً: الكمية بوحدة الأساس (صفوف التوزيع بالأساس، D22)
  const returnLotsText = (it: ReturnRow['items'][number]) =>
    docLotsText(docLotsFrom(it.lots), tr('غير معروف'), n => `${plainQty(n)}${it.baseUnit ? ` ${it.baseUnit}` : ''}`);
  // في المرتجعات بندٌ بغير وحدة الأساس (حبّةٌ من كرتون، كرتونٌ قديم بعد التحويل)؟ — تُكتب الوحدة بجانب الكمية حينها.
  // وكذلك بندٌ لصنفٍ له وحدة رئيسية (R2): «1» بلا وحدة تُقرأ كرتوناً وهي قارورة — `!!primaryUnitId` قيمةٌ صادقة لا حضور المفتاح
  const returnsMultiUnit = returnRows.some(r => r.items.some(i => factorOf(i) !== 1 || !!i.primaryUnitId));
  const returnTotals = useMemo(() => ({
    count: returnRows.length,
    total: Math.round(returnRows.reduce((t, r) => t + Number(r.total || 0), 0) * 1e6) / 1e6,
  }), [returnRows]);
  const reasonLabel = (r: string) => tr(RETURN_REASON_LABELS[r] ?? r);

  const orderTotals = useMemo(() => ({
    count: orderRows.length,
    total: Math.round(orderRows.reduce((t, o) => t + Number(o.total || 0), 0) * 1e6) / 1e6,
    remaining: Math.round(orderRows.reduce((t, o) => t + (Number(o.total || 0) - Number(o.paidAmt || 0)), 0) * 1e6) / 1e6,
  }), [orderRows]);

  const balanceRows = useMemo(
    () => filterFlat(balancesData || [], q, c => [c.name, c.phone]),
    [balancesData, q],
  );

  /**
   * تجميع سندات القبض على المناديب — في الواجهة لا الخادم.
   *
   * مسار `/reports/collections` يردّ السندات كاملةً ومعها مندوب كلّ سند، فالتجميع
   * هنا لا يكلّف طلباً ولا يفتح مساراً جديداً يحتاج حارس نطاق.
   *
   * ودلوُ «بلا مندوب» ليس حالةً نادرة: `Receipt.salesRepId` اختياريّ (سندٌ يصدره
   * إداريّ من اللوحة)، و`onDelete: SetNull` يُفرغه حين يُحذف المندوب. فإسقاطُه
   * يعني اختفاء مالٍ محصَّل من التقرير بلا أثر — ومجموعُ الأعمدة لا يطابق
   * البطاقة فوقه، وهو أسوأ من عرض صفٍّ بلا اسم.
   */
  const collRepRows = useMemo<CollRepRow[]>(
    () => groupCollectionsByRep(collectData?.receipts, (r) => (r.paymentMethodKey && collKnownKeys.has(r.paymentMethodKey) ? r.paymentMethodKey : r.paymentMethod)),
    [collectData, collKnownKeys],
  );

  // البحث يصفّي بالمندوب **أو** بعميلٍ في سنداته — فيعرف المشرف من حصّل من ذاك العميل
  const collRepShown = useMemo(
    () => filterFlat(collRepRows, q, r => [collRepName(r), ...r.receipts.map(rc => rc.customer?.name), ...r.receipts.map(rc => rc.receiptNumber)]),
    [collRepRows, q, tr],
  );
  // مجاميع المعروض — تُقارَن بالبطاقة أعلى الشاشة فيُكشف أيّ سقوطٍ في التجميع
  const collShownTotals = useMemo(() => collectionTotals(collRepShown), [collRepShown]);

  // إجمالي مديونية الشركة: مجموع أرصدة العملاء المعروضين (كلٌّ مرّة، من المعروض
  // فيحترم النطاق والبحث). تقرير الأرصدة يعرض المدينين (رصيد موجب).
  const balanceTotal = useMemo(() => {
    if (!balanceRows) return null;
    const total = balanceRows.reduce((s, c) => s + Number(c.balance || 0), 0);
    return { total: Math.round(total * 100) / 100, count: balanceRows.length };
  }, [balanceRows]);

  const visitRows = useMemo(
    () => filterFlat(visitsData?.visits || [], q, v => [v.customerName, v.repName, v.note]),
    [visitsData, q],
  );
  // تجميع الزيارات بالعميل: صفّ لكل عميل (عدد الزيارات + متوسط المدّة)، والتوسيع يُظهر كل زياراته
  const custGroups = useMemo<CustGroup[]>(() => {
    const map = new Map<string, CustVisit[]>();
    for (const v of visitRows) {
      const arr = map.get(v.customerId) || [];
      arr.push(v);
      map.set(v.customerId, arr);
    }
    const groups = [...map.values()].map(visits => {
      const durs = visits.map(x => x.durationSec).filter((d): d is number => typeof d === 'number' && d > 0);
      const avg = durs.length ? Math.round(durs.reduce((s, d) => s + d, 0) / durs.length) : null;
      return {
        customerId: visits[0].customerId,
        customerName: visits[0].customerName,
        visitsCount: visits.length,
        avgDurationSec: avg,
        lastVisit: visits[0].createdAt, // الخادم يرتّب تنازلياً ⇒ الأحدث أولاً
        visits,
      };
    });
    groups.sort((a, b) => b.visitsCount - a.visitsCount || (b.lastVisit > a.lastVisit ? 1 : -1));
    return groups;
  }, [visitRows]);

  const perfRows = useMemo(
    () => filterFlat(perfData || [], q, r => [r.name, ...r.visits.map(v => v.customerName)]),
    [perfData, q],
  );

  // تقييم الأداء: البحث بالاسم يقطّع اللوحة، والمرتبة تبقى مرتبته بين الجميع
  const rankRowsShown = useMemo(
    () => filterFlat(rankingQ.data?.rows || [], q, r => [r.name]),
    [rankingQ.data, q],
  );

  // ساعات العمل: **إيجادٌ لا تقطيع** — مقاييس اليوم تصف اليوم كلّه ولا تُشتقّ
  // من زياراتٍ مُنتقاة، فقصُّها مع إبقاء الرقم يُنتج صفحةً أرقامُها لا تشرح جدولها.
  const hoursRows = useMemo(
    () => filterFlat(hoursData?.rows || [], q, r => [r.name, ...r.days.flatMap(d => d.visits.map(v => v.customerName))]),
    [hoursData, q],
  );

  // «التحقق العشوائي من التواجد» لأيام التقرير نفسها — بصلاحية التتبّع (مسارات /attendance-admin): من لا يملكها لا يرى الشارة
  const hoursSpan = useMemo(() => {
    const days = (hoursData?.rows ?? []).flatMap(r => r.days.map(d => d.date)).sort();
    return days.length ? { from: days[0], to: days[days.length - 1] } : null;
  }, [hoursData]);
  const presenceQ = useQuery({
    queryKey: ['report-presence', hoursSpan?.from, hoursSpan?.to],
    queryFn: async () => (await attendanceAdminApi.presence({ from: hoursSpan!.from, to: hoursSpan!.to, tz: -new Date().getTimezoneOffset() })).data.data as PresenceRow[],
    enabled: attendanceOn && !!hoursSpan && tab === 'performance' && perfType === 'hours',
    retry: false,
  });
  const presenceMap = useMemo(() => presenceByRepDay(presenceQ.data ?? []), [presenceQ.data]);

  // المديونيات: قائمة عملاء مسطّحة ⇒ التقطيع مفيدٌ وآمن، بشرط إعادة حساب
  // مجاميع المندوب من المعروض (تكفّلت به `filterNested`).
  const recvRows = useMemo(
    () => recvData && filterNested(recvData, q, c => [c.name, c.businessName, c.phone, c.city],
      (r, kept) => ({
        ...r, customers: kept,
        customersCount: kept.length,
        debtorsCount: kept.filter(c => c.balance > 0).length,
        totalBalance: Math.round(kept.reduce((a, c) => a + c.balance, 0) * 100) / 100,
      })),
    [recvData, q],
  );

  // الإجمالي المتمايز: يُشتقّ من المعروض بإزالة تكرار العميل المُسنَد لأكثر من مندوب،
  // فيُعطي مديونية الشركة الحقيقيّة (لا مجموع الأعمدة المتضخّم بالتكرار)، ويحترم
  // النطاق والبحث لأنه مبنيّ على recvRows نفسها.
  const recvSummary = useMemo(() => {
    if (!recvRows) return null;
    const bal = new Map<string, number>();     // customerId → رصيد (مرّة واحدة)
    const repsPer = new Map<string, number>();  // customerId → عدد المناديب المُسنَد لهم
    for (const r of recvRows) for (const c of r.customers) {
      bal.set(c.id, c.balance);
      repsPer.set(c.id, (repsPer.get(c.id) || 0) + 1);
    }
    let receivable = 0, debtors = 0, shared = 0;
    for (const b of bal.values()) { receivable += b; if (b > 0) debtors++; }
    for (const n of repsPer.values()) if (n > 1) shared++;
    return {
      distinctCustomers: bal.size,
      distinctReceivable: Math.round(receivable * 100) / 100,
      distinctDebtors: debtors,
      sharedCustomers: shared,
      columnsSum: Math.round(recvRows.reduce((s, r) => s + r.totalBalance, 0) * 100) / 100,
    };
  }, [recvRows]);

  // يبني أوراق بيانات التبويب النشط (مشتركة بين Excel وPDF)
  const buildSheets = (): { sheets: ExcelSheet[]; fname: string } | null => {
    let sheets: ExcelSheet[] | null = null;
    let fname = tr('تقرير');
    if (tab === 'performance' && perfType === 'hours' && hoursRows?.length) {
      // المندوب مرّةً لكل مندوب، والتاريخ وإجمالي اليوم مرّةً لكل يوم — لا تكرار في كل صفّ
      // صفٌّ واحد لكل مندوب×يوم: فترات الدوام المتقطّع في خليةٍ واحدة لا صفٌّ لكل فترة
      const dayItems = hoursRows.flatMap((r, ri) => r.days.map(d => ({ rep: String(ri), row: {
          [tr('المندوب')]: r.name, [tr('التاريخ')]: d.date,
          ...attendanceDayCells(d, dayCellFx),
        } as Record<string, unknown> })));
      const daily = mergeRuns(dayItems.map(x => x.row), [{ cols: [tr('المندوب')], keyOf: i => dayItems[i].rep }]);
      // زيارةٌ واحدة لكل وقفة: بداية ونهاية صريحتان بدل صفَّين لعميلٍ واحد
      const visitItems = hoursRows.flatMap((r, ri) => r.days.flatMap(d => d.visits.map(v => ({ rep: String(ri), day: d.date, row: {
          [tr('المندوب')]: r.name, [tr('التاريخ')]: d.date,
          [tr('اسم العميل')]: v.customerName,
          [tr('رابط الموقع')]: v.lat != null && v.lng != null ? `https://www.google.com/maps?q=${v.lat},${v.lng}` : '',
          [tr('بداية الزيارة')]: fmtClock(v.start),
          [tr('نهاية الزيارة')]: v.end ? fmtClock(v.end) : tr('بلا توقيت'),
          [tr('مدة الزيارة')]: fmtVisitDur(v.durationSec) || tr('بلا توقيت'),
          [tr('ملاحظة/صور')]: v.hasNote ? tr('نعم') : '',
          [tr('إجمالي وقت العمل لليوم')]: fmtMin(d.spanMinutes),
        } as Record<string, unknown> }))));
      const visits = mergeRuns(visitItems.map(x => x.row), [
        { cols: [tr('المندوب')], keyOf: i => visitItems[i].rep },
        { cols: [tr('التاريخ'), tr('إجمالي وقت العمل لليوم')], keyOf: i => `${visitItems[i].rep}|${visitItems[i].day}` },
      ]);
      // أين حضر وأين انصرف: صفٌّ لكل فترة بموقعَي بصمتيها، المندوب والتاريخ موحّدان (أيام البصمة وحدها)
      const punches = punchDetailRows(hoursRows, true, dayCellFx);
      sheets = [
        { name: tr('ملخص المناديب'), rows: hoursRows.map(r => ({
          [tr('المندوب')]: r.name,
          [tr('أيام الحضور')]: r.workedDays,
          [tr('أيام بلا نشاط')]: r.absentDays,
          [tr('إجمالي وقت العمل')]: fmtMin(r.fieldMinutesTotal),
          [tr('متوسط اليوم')]: fmtMin(r.avgDayMinutes),
          [tr('نشاط التطبيق')]: fmtDuration(r.hours, r.minutes),
          [tr('عدد الزيارات')]: r.visitsTotal,
          [tr('أول ظهور')]: fmtDateTime(r.firstSeen), [tr('آخر ظهور')]: fmtDateTime(r.lastSeen),
        })), colWidths: [22, 12, 12, 14, 12, 14, 12, 18, 18] },
        { name: tr('الحضور اليومي'), rows: daily.rows, merges: daily.merges, colWidths: [22, 12, 12, 12, 30, 10, 14, 14, 12, 16] },
        ...(punches.rows.length ? [{ name: tr('تفاصيل البصمات'), rows: punches.rows, merges: punches.merges,
          colWidths: [22, 12, 10, 42, 10, 42, 12], pdfLinkLabel: tr('فتح الخريطة') }] : []),
        { name: tr('تفاصيل الزيارات'), rows: visits.rows, merges: visits.merges, colWidths: [22, 12, 24, 34, 12, 12, 12, 12, 16] },
      ];
      fname = tr('ساعات العمل');
    } else if (tab === 'performance' && perfType === 'receivables' && recvRows?.some(r => r.customersCount > 0)) {
      sheets = [
        { name: tr('ملخص المديونيات'), rows: recvRows.map(r => ({
          [tr('المندوب')]: r.name, [tr('العملاء المسندون')]: r.customersCount,
          [tr('العملاء المدينون')]: r.debtorsCount, [tr('إجمالي المديونية')]: num(r.totalBalance),
        })), colWidths: [22, 16, 16, 18] },
        (() => {
          const items = recvRows.flatMap((r, ri) => r.customers.map(c => ({ rep: String(ri), row: {
            [tr('المندوب')]: r.name, [tr('العميل')]: c.name, [tr('النشاط التجاري')]: c.businessName || '',
            [tr('الجوال')]: c.phone, [tr('المدينة')]: c.city || '', [tr('الرصيد')]: num(c.balance),
            [tr('آخر تحصيل')]: c.lastPaymentAt ? fmtDay(c.lastPaymentAt) : tr('لم يحصل قط'),
          } as Record<string, unknown> })));
          const m = mergeRuns(items.map(x => x.row), [{ cols: [tr('المندوب')], keyOf: i => items[i].rep }]);
          return { name: tr('تفاصيل المديونيات'), rows: m.rows, merges: m.merges, colWidths: [22, 24, 20, 16, 14, 14, 16] };
        })(),
      ];
      // ورقة «إجمالي المُسنَدين» — تُضاف دائماً (الميزة عامّة لكل الشركات)
      if (recvSummary) {
        sheets.unshift({ name: tr('إجمالي المسندين'), rows: [{
          [tr('إجمالي مديونية العملاء المسندين بلا تكرار')]: num(recvSummary.distinctReceivable),
          [tr('العملاء المدينون')]: recvSummary.distinctDebtors,
          [tr('عملاء مشتركون بين مناديب')]: recvSummary.sharedCustomers,
          [tr('مجموع الأعمدة قد يتضخم بالتكرار')]: num(recvSummary.columnsSum),
        }], colWidths: [32, 16, 22, 28] });
      }
      fname = tr('مديونيات المندوب');
    } else if (tab === 'performance' && perfType === 'ranking' && rankRowsShown.length) {
      // القيمة رقماً في عمودها بوحدته — والمبالغ بخانات العملة
      const unit = rankMetric === 'sales' ? '' : rankMetric === 'distance' ? ` (${tr('كم')})` : rankMetric === 'appTime' ? ` (${tr('دقيقة')})`
        : rankMetric === 'product' && rankingQ.data?.product ? ` (${rankingQ.data.product.unit})` : '';
      const label = `${tr(RANKING_LABELS[rankMetric])}${rankMetric === 'product' && rankingQ.data?.product ? ` — ${rankingQ.data.product.name}` : ''}${unit}`;
      // «الوحدة الرئيسية» (R9): كمية الصنف رقماً بالأساس كما كانت (للجمع والفرز)، ونصّها بالرئيسية «52 كرتون و2 قارورة»
      // عمودٌ يُضاف حين للصنف رئيسية صالحة — وبلاها الورقة كما كانت حرفاً
      const rankProduct = rankMetric === 'product' && primaryUnitOf(rankingQ.data?.product) ? rankingQ.data!.product : null;
      sheets = [{ name: tr('تقييم الأداء'), rows: rankRowsShown.map(r => ({
        [tr('المرتبة')]: r.rank, [tr('المندوب')]: r.name,
        [label]: rankMetric === 'sales' ? num(r.value) : r.value,
        ...(rankProduct && { [tr('الكمية بوحداتها')]: productQtyText(r.value, rankProduct) }),
      })), colWidths: rankProduct ? [10, 26, 30, 24] : [10, 26, 30] }];
      fname = tr('تقييم الأداء');
    } else if (tab === 'performance' && perfType === 'performance' && perfRows?.length) {
      sheets = [{ name: tr('أداء المناديب'), rows: perfRows.map(r => ({
        [tr('المندوب')]: r.name, [tr('عدد الفواتير')]: r.invoicesCount, [tr('إجمالي المبيعات')]: num(r.salesTotal),
        [tr('التحصيل')]: num(r.collectionsTotal), [tr('نسبة التحصيل %')]: r.collectionRate, [tr('متوسط الفاتورة')]: num(r.avgInvoice),
        [tr('ساعات العمل')]: fmtDuration(r.workHours, r.workMins), [tr('عدد الزيارات')]: r.visitsCount,
        [tr('روابط مواقع الزيارات')]: r.visits.map(v => v.mapsUrl).join('\n'),
      })), colWidths: [22, 12, 16, 14, 14, 16, 14, 12, 55] }];
      // ورقة مواقع الزيارات (روابط خرائط Google)
      const locItems = perfRows.flatMap((r, ri) => r.visits.map(v => ({ rep: String(ri), row: {
        [tr('المندوب')]: r.name, [tr('العميل')]: v.customerName, [tr('الوقت')]: fmtDateTime(v.createdAt), [tr('رابط الموقع')]: v.mapsUrl,
      } as Record<string, unknown> })));
      const loc = mergeRuns(locItems.map(x => x.row), [{ cols: [tr('المندوب')], keyOf: i => locItems[i].rep }]);
      if (loc.rows.length) sheets.push({ name: tr('مواقع الزيارات'), rows: loc.rows, merges: loc.merges, colWidths: [22, 22, 18, 40] });
      fname = tr('أداء المناديب');
    } else if (tab === 'sales' && salesType === 'returns' && returnRows.length) {
      sheets = [
        { name: tr('المرتجعات'), rows: returnRows.map(r => ({
          [tr('رقم المرتجع')]: r.number,
          [tr('التاريخ')]: fmtDay(r.invoiceDate),
          [tr('العميل')]: r.customer?.name || '—',
          [tr('المندوب')]: r.salesRep?.name || '—',
          ...(teamsOn && { [tr('الفريق')]: r.team?.name || tr('بلا فريق') }),
          [tr('السبب')]: reasonLabel(r.reason),
          [tr('يعود للمخزون')]: r.toDamagedStock ? tr('تالف بالسيارة') : r.returnToStock ? tr('نعم') : tr('لا'),
          [tr('من فاتورة البيع')]: r.saleInvoices.join('، '),
          [tr('الإجمالي')]: num(r.total),
        })), colWidths: [16, 12, 24, 20, 14, 12, 18, 14] },
        { name: tr('تفاصيل الأصناف'), rows: returnRows.flatMap(r => r.items.map(i => ({
          [tr('رقم المرتجع')]: r.number,
          [tr('التاريخ')]: fmtDay(r.invoiceDate),
          [tr('العميل')]: r.customer?.name || '—',
          ...(teamsOn && { [tr('الفريق')]: r.team?.name || tr('بلا فريق') }),
          [tr('الصنف')]: i.name,
          [tr('الكمية')]: i.qty,
          // الوحدات المتعددة: الكمية بوحدة البند (حبّةٌ من كرتون) — عمود الوحدة حين في المرتجعات بندٌ بغير الأساس، فلا يُقرأ «١» كرتوناً
          ...(returnsMultiUnit && { [tr('الوحدة')]: i.unit || '' }),
          [tr('القيمة')]: num(i.lineTotal),
          [tr('منتهي الصلاحية')]: i.returnExpired === true ? tr('نعم') : i.returnExpired === false ? tr('لا') : '',
          // «تتبّع اللوط»: تشغيلات البند بالأساس — عمودٌ حين تُفعَّل الميزة
          ...(lotOn && { [tr('التشغيلات')]: returnLotsText(i) }),
        }))), colWidths: [...(returnsMultiUnit ? [16, 12, 24, 26, 10, 12, 14, 14] : [16, 12, 24, 26, 10, 14, 14]), ...(lotOn ? [34] : [])] },
      ];
      fname = tr('تقرير المرتجع');
    } else if (tab === 'sales' && salesType === 'lots' && lotSalesRows.length) {
      // الكميات بالأساس أرقاماً (للجمع داخل الصنف في Excel) ومعها اسم الأساس
      sheets = [{ name: tr('المبيعات حسب التشغيلة'), rows: lotSalesRows.map(r => ({
        [tr('الصنف')]: r.productName,
        [tr('كود الصنف')]: r.productCode || '',
        [tr('رقم التشغيلة')]: r.lotNumber ?? tr('غير معروف'),
        [tr('تاريخ الإنتاج')]: r.productionDate || '',
        [tr('تاريخ الانتهاء')]: r.expiryDate || '',
        [tr('الحالة')]: r.status ? tr(r.blockKind ? LOT_BLOCK_KIND_LABELS[r.blockKind] : LOT_STATUS_LABELS[r.status]) : '',
        [tr('الوحدة')]: r.unit || '',
        [tr('مباع')]: r.sold,
        [tr('مرتجع')]: r.returned,
        [tr('صافي المبيع')]: r.net,
        [tr('عدد العملاء')]: r.customers,
        [tr('عدد فواتير البيع')]: r.invoices,
      })), colWidths: [26, 12, 16, 12, 12, 14, 10, 10, 10, 10, 10, 12] }];
      fname = tr('المبيعات حسب التشغيلة');
    } else if (tab === 'sales' && salesType === 'orders' && orderRows.length) {
      sheets = [{ name: tr('تقرير الطلبات'), rows: orderRows.map(o => ({
        [tr('رقم الفاتورة')]: o.number,
        [tr('العميل')]: o.customer?.name || '—',
        [tr('الجوال')]: o.customer?.phone || '',
        [tr('المدينة')]: o.customer?.city || '',
        [tr('المندوب')]: o.salesRep?.name || '—',
        ...(teamsOn && { [tr('الفريق')]: o.team?.name || tr('بلا فريق') }),
        [tr('تاريخ الفاتورة')]: fmtDay(o.invoiceDate),
        [tr('تاريخ التسليم')]: fmtDay(o.deliveryDate),
        [tr('الإجمالي')]: num(Number(o.total || 0)),
        [tr('المتبقي')]: num(Number(o.total || 0) - Number(o.paidAmt || 0)),
      })), colWidths: [16, 24, 16, 14, 20, 14, 14, 14, 14] }];
      fname = tr('تقرير الطلبات');
    } else if (tab === 'sales' && salesType === 'summary' && Array.isArray(salesRows) && salesRows.length) {
      // حسب الصنف بوحدات: الكمية بالأساس رقماً (للجمع في Excel) ومعها اسم الأساس ونصّها مفكَّكاً «٢ كرتون و٣ حبة»
      const multi = groupBy === 'product' && (salesRows as SalesRow[]).some(r => hasBigUnit(r.units));
      sheets = [{ name: tr('المبيعات'), rows: (salesRows as SalesRow[]).map(r => ({
        [tr('الاسم')]: groupBy === 'team' ? displayName(r.name) : r.name, [tr('العدد/الكمية')]: r.count ?? r.qty ?? '',
        ...(multi && { [tr('الوحدة')]: r.unit || '', [tr('الكمية بوحداتها')]: baseQtyText(Number(r.qty) || 0, r, plainQty) }),
        [tr('الإجمالي')]: num(r.total),
      })), colWidths: multi ? [28, 14, 12, 24, 16] : [28, 14, 16] }];
      fname = tr('تقارير المبيعات');
    } else if (tab === 'balances' && custType === 'visits' && visitRows?.length) {
      sheets = [
        { name: tr('ملخص العملاء'), colWidths: [26, 14, 16, 22], rows: custGroups.map(g => ({
          [tr('العميل')]: g.customerName, [tr('عدد الزيارات')]: g.visitsCount,
          [tr('متوسط مدة الزيارة')]: fmtVisitDur(g.avgDurationSec) || tr('بلا توقيت'), [tr('آخر زيارة')]: fmtDateTime(g.lastVisit),
        })) },
        { name: tr('كل الزيارات'), colWidths: [24, 20, 20, 14, 24, 40], rows: visitRows.map(v => ({
          [tr('العميل')]: v.customerName, [tr('المندوب')]: v.repName, ...(teamsOn && { [tr('الفريق')]: v.teamName || tr('بلا فريق') }),
          [tr('التاريخ والوقت')]: fmtDateTime(v.createdAt),
          [tr('مدة الزيارة')]: fmtVisitDur(v.durationSec) || tr('بلا توقيت'), [tr('ملاحظة')]: v.note, [tr('الموقع')]: v.mapsUrl,
        })) },
      ];
      fname = tr('زيارات العملاء');
    } else if (tab === 'balances' && balanceRows?.length) {
      sheets = [{ name: tr('أرصدة العملاء'), rows: balanceRows.map(c => ({
        [tr('العميل')]: c.name, [tr('الجوال')]: c.phone, [tr('الرصيد')]: num(c.balance), [tr('الحد الائتماني')]: num(c.creditLimit),
      })), colWidths: [24, 16, 14, 16] }];
      if (balanceTotal) sheets.unshift({ name: tr('الإجمالي'), rows: [{
        [tr('إجمالي مديونية الشركة')]: num(balanceTotal.total), [tr('عدد العملاء المدينين')]: balanceTotal.count,
      }], colWidths: [28, 20] });
      fname = tr('أرصدة العملاء');
    } else if (tab === 'collections' && collType === 'byRep' && collRepShown.length) {
      /* التصدير يتبع المعروض (البحث ضمناً) كبقيّة التقارير — ورقتان: تجميعة
       * المناديب، ثمّ كلّ سندٍ بمندوبه كي يُراجَع المبلغ سنداً سنداً. */
      // رؤوس أعمدة الطرق فريدة: اسمٌ مضاف يطابق «تحويل» القصير أو رأساً آخر كان سيمحو عموده في الصفّ (مفاتيح كائن)
      const usedHeads = new Set<string>([tr('المندوب'), tr('عدد السندات'), tr('الإجمالي')]);
      const colHeads = collCols.map(c => {
        let h = c.short;
        for (let i = 2; usedHeads.has(h); i++) h = `${c.short} (${i})`;
        usedHeads.add(h);
        return h;
      });
      sheets = [
        { name: tr('التحصيل حسب المندوب'), rows: collRepShown.map(r => ({
          [tr('المندوب')]: collRepName(r),
          [tr('عدد السندات')]: r.count,
          // الأسس الأربعة كما اليوم ثم الإلكتروني والمضافة بأسماء الشركة — أعمدة الشاشة نفسها
          ...Object.fromEntries(collCols.map((c, i) => [colHeads[i], num(r.byMethod[c.id] || 0)])),
          [tr('الإجمالي')]: num(r.total),
        })), colWidths: [24, 12, ...collCols.map(() => 14), 16] },
        { name: tr('السندات'), rows: collRepShown.flatMap(r => r.receipts.map(rc => ({
          [tr('المندوب')]: collRepName(r),
          ...(teamsOn && { [tr('الفريق')]: rc.team?.name || tr('بلا فريق') }),
          [tr('رقم السند')]: rc.receiptNumber,
          [tr('التاريخ')]: fmtDateTime(rc.receiptDate),
          [tr('العميل')]: rc.customer?.name || '—',
          [tr('طريقة الدفع')]: methodLabel(rc.paymentMethod, rc.paymentMethodKey),
          [tr('المبلغ')]: num(Number(rc.amount) || 0),
        }))), colWidths: [24, 16, 18, 24, 14, 14] },
      ];
      // صفّ الإجماليّ في رأس الملفّ: من يفتح الورقة يقرأ الحصيلة قبل الصفوف
      sheets.unshift({ name: tr('الإجمالي'), rows: [{
        [tr('إجمالي التحصيل')]: num(collShownTotals.total),
        [tr('عدد السندات')]: collShownTotals.count,
        [tr('عدد المناديب المحصلين')]: collRepShown.length,
      }], colWidths: [20, 16, 22] });
      fname = tr('التحصيل حسب المندوب');
    } else if (tab === 'collections' && collectData) {
      sheets = [{ name: tr('التحصيل'), rows: [
        { [tr('البند')]: tr('إجمالي التحصيل'), [tr('القيمة')]: num(collectData.summary.total) },
        { [tr('البند')]: tr('عدد السندات'), [tr('القيمة')]: collectData.summary.count },
        ...collMethods.map(m => ({ [tr('البند')]: m.label, [tr('القيمة')]: num(m.amount) })),
      ], colWidths: [20, 16] }];
      fname = tr('تقارير التحصيل');
    }
    return sheets ? { sheets, fname } : null;
  };

  const day = () => new Date().toISOString().slice(0, 10);
  const safeName = (s: string) => s.replace(/[\\/?*[\]:]/g, '·').slice(0, 60);

  // تصدير Excel للتبويب النشط
  // «ورقة لكل فريق»: أوراق المستندات تُقسَم بعمود الفريق (lib/teamReport.ts) — حين لا فلتر فريق
  const exportSheets = (sheets: ExcelSheet[]) => (teamsOn && !teamFilter && splitByTeam ? splitSheetsByTeam(sheets, tr('الفريق')) : sheets);
  // أرصدة العملاء لا تنقسم بالفريق (العملاء مشتركون) — فلا يُكتب اسم فريقٍ على ملفٍ لم يُفلتر به
  const exportTeamName = tab === 'balances' && custType === 'balances' ? '' : teamFilterName;
  const withTeam = (name: string) => (exportTeamName ? `${name} - ${exportTeamName}` : name);
  const handleExport = async () => {
    const built = buildSheets();
    if (!built) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    const out = await shareOrDownloadExcel(exportSheets(built.sheets), `${withTeam(built.fname)}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };

  // يحوّل أوراق البيانات إلى PDF (جداول مطبوعة، عربية سليمة عبر html2canvas).
  // ═══ التقطيع إلزاميّ ═══ جدولٌ طويل (تفاصيل زيارات آلاف المناديب) في عنصرٍ
  // واحد كان يتجاوز حدّ الـcanvas فيخرج PDF صفحاتٍ بيضاء صامتة. نقسّم صفوف كل
  // ورقة إلى شرائح، عنصرٌ لكل شريحة، ويجمعها elementsToPdfBlob بمقياسٍ آمن.
  const ROWS_PER_SLICE = 300;
  const sheetsToPdf = async (sheets: ExcelSheet[], title: string) => {
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const linksCol = tr('روابط مواقع الزيارات'); // عمود الروابط المجمّعة يُستبعد من PDF (يطول الصف)
    // المديونيات لحظية: لا نطبع نطاقاً ضُبط في تبويبٍ آخر على تقريرٍ لا يتأثر به
    const range = (tab === 'performance' && perfType === 'receivables')
      ? tr('لحظي وقت الإصدار')
      : (from && to) ? `${from} — ${to}` : tr('كل الفترات');
    const teamLine = exportTeamName ? ` · ${tr('الفريق')}: ${exportTeamName}` : '';
    const header = `<div style="border-bottom:2px solid #E15A30;padding-bottom:10px;margin-bottom:8px"><h2 style="font-size:18px;margin:0;color:#1F1A13">${esc(title)}</h2><p style="font-size:12px;color:#6E6557;margin:4px 0 0">${esc(tr('الفترة'))}: ${esc(range)}${esc(teamLine)} · ${esc(tr('تاريخ الإصدار'))}: ${esc(new Date().toLocaleDateString(activeLocale()))}</p></div>`;
    const wrap = (inner: string, withHeader: boolean): HTMLElement => {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:-99999px;top:0;width:780px;background:#fff;padding:24px;font-family:Tahoma,Arial,sans-serif;direction:rtl';
      el.innerHTML = (withHeader ? header : '') + inner;
      document.body.appendChild(el);
      return el;
    };
    const els: HTMLElement[] = [];
    let firstEl = true;
    for (const sh of sheets) {
      const cols = (sh.rows.length ? Object.keys(sh.rows[0]) : []).filter(c => c !== linksCol);
      const thead = `<tr>${cols.map(c => `<th style="border:1px solid #ddd;padding:6px 8px;background:#FAF7F0;font-size:11px;text-align:right;font-weight:700">${esc(c)}</th>`).join('')}</tr>`;
      // كل شريحة صفحةٌ مستقلّة تحمل رأس الجدول ثانيةً، فلا تُقرأ الأرقام بلا عناوينها
      for (let i = 0; i < Math.max(1, sh.rows.length); i += ROWS_PER_SLICE) {
        const slice = sh.rows.slice(i, i + ROWS_PER_SLICE);
        const cont = i > 0 ? ` (${tr('تابع')})` : '';
        // ورقةٌ تطلب نصّاً قصيراً لروابطها («فتح الخريطة»): الرابط الطويل يملأ الخلية أسطراً — والنصّ يبقى رابطاً قابلاً للنقر
        const cell = (v: unknown) => sh.pdfLinkLabel && typeof v === 'string' && /^https?:\/\/\S+$/.test(v)
          ? `<a href="${esc(v).replace(/"/g, '&quot;')}" style="color:#2E6FB0;text-decoration:underline">${esc(sh.pdfLinkLabel)}</a>`
          : esc(v);
        const td = (v: unknown, span = 1) => `<td${span > 1 ? ` rowspan="${span}"` : ''} style="border:1px solid #eee;padding:5px 8px;font-size:11px;text-align:right;word-break:break-word;vertical-align:middle">${cell(v)}</td>`;
        const tbody = slice.map((r, j) => {
          const at = i + j; // رقم الصفّ في الورقة كلها
          return `<tr>${cols.map(c => {
            const m = sh.merges?.find(x => x.col === c && at >= x.from && at <= x.to);
            if (!m) return td(r[c]);
            const top = Math.max(m.from, i);                       // أول صفّ للدمج داخل هذه الشريحة
            if (at !== top) return '';                              // مغطّى بالخلية الموحّدة
            return td(m.value, Math.min(m.to, i + ROWS_PER_SLICE - 1) - top + 1);
          }).join('')}</tr>`;
        }).join('');
        const inner = `<h3 style="font-size:13px;margin:16px 0 6px;color:#1F1A13">${esc(sh.name)}${cont}</h3><table style="width:100%;border-collapse:collapse;table-layout:fixed">${thead}${tbody}</table>`;
        els.push(wrap(inner, firstEl));
        firstEl = false;
      }
    }
    // مؤشّر «جارٍ الإنشاء» + تنفّس للمتصفّح قبل الالتقاط الثقيل (html2canvas يحجب
    // الخيط) كي لا تبدو الصفحة معلّقةً بلا سبب. والتنزيل مباشرٌ لا مشاركة.
    const toastId = toast.loading(tr('جارٍ إنشاء PDF'));
    await new Promise(r => setTimeout(r, 30));
    try {
      const blob = await elementsToPdfBlob(els);
      downloadPdf(blob, `${safeName(title)}-${day()}`);
      toast.success(tr('تم التصدير'), { id: toastId });
    } catch { toast.error(tr('تعذر إنشاء PDF — جرّب مدى أقصر أو صدّر Excel'), { id: toastId }); }
    finally { els.forEach(e => e.remove()); }
  };

  // تصدير PDF للتبويب النشط
  const handleExportPdf = async () => {
    const built = buildSheets();
    if (!built) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    await sheetsToPdf(exportSheets(built.sheets), withTeam(built.fname));
  };

  // تصدير تقرير مندوب واحد بشكل مستقل (Excel أو PDF، اسم الملف باسم المندوب)
  const repPerfSheets = (r: PerfRow) => {
    const rows = [{
      [tr('المندوب')]: r.name, [tr('عدد الفواتير')]: r.invoicesCount, [tr('إجمالي المبيعات')]: num(r.salesTotal),
      [tr('التحصيل')]: num(r.collectionsTotal), [tr('نسبة التحصيل %')]: r.collectionRate, [tr('متوسط الفاتورة')]: num(r.avgInvoice),
      [tr('ساعات العمل')]: fmtDuration(r.workHours, r.workMins), [tr('عدد الزيارات')]: r.visitsCount,
      [tr('روابط مواقع الزيارات')]: r.visits.map(v => v.mapsUrl).join('\n'),
    }];
    const sheets = [{ name: tr('أداء المندوب'), rows, colWidths: [22, 12, 16, 14, 14, 16, 14, 12, 55] }];
    if (r.visits.length) sheets.push({
      name: tr('مواقع الزيارات'),
      rows: r.visits.map(v => ({ [tr('العميل')]: v.customerName, [tr('الوقت')]: fmtDateTime(v.createdAt), [tr('رابط الموقع')]: v.mapsUrl })),
      colWidths: [22, 18, 40],
    });
    return sheets;
  };
  const repHoursSheets = (r: WorkHoursRow) => [
    { name: tr('الحضور اليومي'), colWidths: [12, 12, 12, 30, 10, 14, 14, 12, 16],
      rows: r.days.map(d => ({ [tr('التاريخ')]: d.date, ...attendanceDayCells(d, dayCellFx) })) },
    (() => {
      const items = r.days.flatMap(d => d.visits.map(v => ({ day: d.date, row: {
        [tr('التاريخ')]: d.date, [tr('اسم العميل')]: v.customerName,
        [tr('رابط الموقع')]: v.lat != null && v.lng != null ? `https://www.google.com/maps?q=${v.lat},${v.lng}` : '',
        [tr('بداية الزيارة')]: fmtClock(v.start),
        [tr('نهاية الزيارة')]: v.end ? fmtClock(v.end) : tr('بلا توقيت'),
        [tr('مدة الزيارة')]: fmtVisitDur(v.durationSec) || tr('بلا توقيت'),
        [tr('ملاحظة/صور')]: v.hasNote ? tr('نعم') : '',
        [tr('إجمالي وقت العمل لليوم')]: fmtMin(d.spanMinutes),
      } as Record<string, unknown> })));
      const m = mergeRuns(items.map(x => x.row), [{ cols: [tr('التاريخ'), tr('إجمالي وقت العمل لليوم')], keyOf: i => items[i].day }]);
      return { name: tr('تفاصيل الزيارات'), colWidths: [12, 24, 34, 12, 12, 12, 12, 16], rows: m.rows, merges: m.merges };
    })(),
  ];
  // ملف المندوب الواحد: «تفاصيل البصمات» بعد «الحضور اليومي» متى بصم في المدى (بلا عمود المندوب)
  const repHoursSheetsAll = (r: WorkHoursRow): ExcelSheet[] => {
    const [daily, visits] = repHoursSheets(r);
    const p = punchDetailRows([r], false, dayCellFx);
    return p.rows.length
      ? [daily, { name: tr('تفاصيل البصمات'), rows: p.rows, merges: p.merges, colWidths: [12, 10, 42, 10, 42, 12], pdfLinkLabel: tr('فتح الخريطة') }, visits]
      : [daily, visits];
  };
  const exportRepPerf = async (r: PerfRow) => {
    const out = await shareOrDownloadExcel(repPerfSheets(r), `${tr('أداء')}-${safeName(withTeam(r.name))}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepPerfPdf = (r: PerfRow) => sheetsToPdf(repPerfSheets(r), `${tr('أداء')} - ${r.name}`);
  const exportRepHours = async (r: WorkHoursRow) => {
    const out = await shareOrDownloadExcel(repHoursSheetsAll(r), `${tr('ساعات العمل')}-${safeName(withTeam(r.name))}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepHoursPdf = (r: WorkHoursRow) => sheetsToPdf(repHoursSheetsAll(r), `${tr('ساعات العمل')} - ${r.name}`);
  // تصدير مديونيات مندوب واحد (باسمه) — الورقة نفسها التي يراها على الشاشة
  const repRecvSheets = (r: RecvRow) => [{
    name: tr('مديونيات المندوب'), colWidths: [24, 20, 16, 14, 14, 16],
    rows: r.customers.map(c => ({
      [tr('العميل')]: c.name, [tr('النشاط التجاري')]: c.businessName || '', [tr('الجوال')]: c.phone,
      [tr('المدينة')]: c.city || '', [tr('الرصيد')]: num(c.balance),
      [tr('آخر تحصيل')]: c.lastPaymentAt ? fmtDay(c.lastPaymentAt) : tr('لم يحصل قط'),
    })),
  }];
  const exportRepRecv = async (r: RecvRow) => {
    const out = await shareOrDownloadExcel(repRecvSheets(r), `${tr('مديونيات')}-${safeName(withTeam(r.name))}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepRecvPdf = (r: RecvRow) => sheetsToPdf(repRecvSheets(r), `${tr('مديونيات')} - ${r.name}`);
  // تصدير كل زيارات عميل واحد (بالمندوب والوقت والمدّة) — الورقة نفسها التي تظهر عند التوسيع
  const custVisitSheets = (g: CustGroup) => [{
    name: tr('زيارات العميل'), colWidths: [22, 20, 14, 28, 40],
    rows: g.visits.map(v => ({
      [tr('المندوب')]: v.repName,
      [tr('التاريخ والوقت')]: fmtDateTime(v.createdAt),
      [tr('مدة الزيارة')]: fmtVisitDur(v.durationSec) || tr('بلا توقيت'),
      [tr('ملاحظة')]: v.note,
      [tr('الموقع')]: v.mapsUrl,
    })),
  }];
  const exportCustVisits = async (g: CustGroup) => {
    const out = await shareOrDownloadExcel(custVisitSheets(g), `${tr('زيارات')}-${safeName(withTeam(g.customerName))}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportCustVisitsPdf = (g: CustGroup) => sheetsToPdf(custVisitSheets(g), `${tr('زيارات')} - ${g.customerName}`);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('التقارير')}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {teamsOn && !teamFilter && (
            <label className="flex items-center gap-1.5 text-xs text-[#6E6557] cursor-pointer" title={tr('أوراق المستندات تقسم ورقة لكل فريق')}>
              <input type="checkbox" checked={splitByTeam} onChange={e => setSplitByTeam(e.target.checked)} className="w-4 h-4 accent-[#E15A30]" />
              {tr('ورقة لكل فريق')}
            </label>
          )}
          <button className="btn-secondary" onClick={handleExport}><Download size={16} /> {tr('تصدير Excel')}</button>
          <button className="btn-secondary" onClick={handleExportPdf}><FileText size={16} /> {tr('تصدير PDF')}</button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-white rounded-xl p-1 border border-gray-100 w-fit">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${tab === t.id ? 'bg-[#E15A30] text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            <t.icon size={15} />{t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="card mb-4">
        <div className="flex gap-3 flex-wrap items-end">
          {/* المديونيات رصيدٌ لحظيّ: نُخفي فلترَي التاريخ بدل تركهما يوحيان بتصفيةٍ لا تُطبَّق */}
          {!(tab === 'performance' && perfType === 'receivables') ? (
            <>
              <div>
                <label className="label">{tr('من')}</label>
                <input type="date" className="input w-36" value={from} onChange={e => setFrom(e.target.value)} />
              </div>
              <div>
                <label className="label">{tr('إلى')}</label>
                <input type="date" className="input w-36" value={to} onChange={e => setTo(e.target.value)} />
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-400 pb-2">{tr('الأرصدة لحظية تعكس وضع المديونية الآن لا فترة محددة')}</p>
          )}
          {/* «فرق العمل»: الفريق — المستندات بوسمها والمناديب بعضويتهم؛ أرصدة العملاء لا تنقسم (العملاء مشتركون) */}
          {teamsOn && !(tab === 'balances' && custType === 'balances') && (
            <div>
              <label className="label">{tr('الفريق')}</label>
              <select className="input w-44" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
                <option value="">{tr('كل الفرق')}</option>
                {(teamsQ.data ?? []).map(t => <option key={t.id} value={t.id}>{t.name}{t.isActive ? '' : ` (${tr('مؤرشف')})`}</option>)}
                <option value="none">{tr('بلا فريق')}</option>
              </select>
            </div>
          )}
          {/* البحث: يظهر حيث يوجد ما يُصفّى — وملخّص التحصيل بطاقاتٌ بلا صفوف */}
          {!(tab === 'collections' && collType === 'summary') && (
            <div className="flex-1 min-w-[200px]">
              <label className="label">{tr('بحث')}</label>
              <div className="relative">
                <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-gray-400 pointer-events-none" />
                <input
                  className="input ps-9 pe-8 w-full"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={tr('اسم العميل أو المندوب')} />
                {search && (
                  <button type="button" onClick={() => setSearch('')} title={tr('مسح البحث')}
                    className="absolute top-1/2 -translate-y-1/2 end-2 text-gray-400 hover:text-gray-600">
                    <X size={15} />
                  </button>
                )}
              </div>
            </div>
          )}
          {tab === 'sales' && (
            <div>
              <label className="label">{tr('نوع التقرير')}</label>
              <select className="input w-44" value={salesType} onChange={e => setSalesType(e.target.value as 'summary' | 'orders' | 'returns' | 'lots')}>
                <option value="summary">{tr('تقرير المبيعات')}</option>
                <option value="orders">{tr('تقرير الطلبات')}</option>
                <option value="returns">{tr('تقرير المرتجع')}</option>
                {lotOn && <option value="lots">{tr('المبيعات حسب التشغيلة')}</option>}
              </select>
            </div>
          )}
          {tab === 'sales' && salesType === 'summary' && (
            <div>
              <label className="label">{tr('تجميع حسب')}</label>
              <select className="input w-36" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                <option value="rep">{tr('المندوب')}</option>
                <option value="customer">{tr('العميل')}</option>
                <option value="product">{tr('الصنف')}</option>
                <option value="channel">{tr('القناة')}</option>
                <option value="region">{tr('المنطقة')}</option>
                {teamsOn && <option value="team">{tr('الفريق')}</option>}
              </select>
            </div>
          )}
          {tab === 'collections' && (
            <div>
              <label className="label">{tr('نوع التقرير')}</label>
              <select className="input w-44" value={collType} onChange={e => { setCollType(e.target.value as 'summary' | 'byRep'); setExpandedColl(null); }}>
                <option value="summary">{tr('ملخص التحصيل')}</option>
                <option value="byRep">{tr('التحصيل حسب المندوب')}</option>
              </select>
            </div>
          )}
          {tab === 'performance' && (
            <div>
              <label className="label">{tr('نوع التقرير')}</label>
              <select className="input w-44" value={perfType} onChange={e => setPerfType(e.target.value as 'performance' | 'hours' | 'receivables' | 'ranking')}>
                {accountingOn && <option value="performance">{tr('أداء المندوب')}</option>}
                <option value="hours">{tr('ساعات العمل')}</option>
                {accountingOn && <option value="receivables">{tr('مديونيات المندوب')}</option>}
                <option value="ranking">{tr('تقييم الأداء')}</option>
              </select>
            </div>
          )}
          {tab === 'balances' && accountingOn && (
            <div>
              <label className="label">{tr('نوع التقرير')}</label>
              <select className="input w-44" value={custType} onChange={e => setCustType(e.target.value as 'balances' | 'visits')}>
                {accountingOn && <option value="balances">{tr('أرصدة العملاء')}</option>}
                <option value="visits">{tr('زيارات العملاء')}</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* حصيلة البحث: بلا هذا السطر يبدو الفراغُ الناتج عن بحثٍ ضيّق كأنه
          غيابُ بيانات — وهي رسالةٌ مختلفة تماماً تدفع المشرف لمطاردة عطلٍ لا وجود له. */}
      {q && (() => {
        const shown = tab === 'sales' ? (salesType === 'orders' ? orderRows.length : salesType === 'returns' ? returnRows.length : salesType === 'lots' ? lotSalesRows.length : (Array.isArray(salesRows) ? salesRows.length : 0))
          : tab === 'collections' ? collRepShown.length
          : tab === 'balances' ? (custType === 'visits' ? custGroups.length : balanceRows.length)
          : perfType === 'performance' ? perfRows.length
          : perfType === 'hours' ? hoursRows.length
          : perfType === 'ranking' ? rankRowsShown.length
          : (recvRows?.length ?? 0);
        return (
          <div className={`mb-4 rounded-xl px-4 py-2.5 text-sm border ${shown ? 'bg-[#FAF7F0] border-[#F1EBDF] text-[#6E6557]' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
            {shown
              ? <>{tr('نتائج البحث عن')} «<b>{search}</b>»: {shown} {tr('سجل')} — {tr('التصدير يشمل المعروض فقط')}</>
              : <>{tr('لا نتائج مطابقة للبحث')} «<b>{search}</b>»</>}
            <button onClick={() => setSearch('')} className="ms-2 underline font-semibold">{tr('مسح البحث')}</button>
          </div>
        );
      })()}

      {/* Sales Report */}
      {tab === 'sales' && salesType === 'summary' && (
        <div className="space-y-4">
          {salesLoading ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
          ) : Array.isArray(salesRows) && salesRows.length > 0 ? (
            <>
              <div className="card">
                <h3 className="font-semibold text-gray-700 mb-4">{tr('مبيعات حسب')} {groupLabel()}</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={(salesRows as { name: string; total: number; count?: number }[]).slice(0, 10).map(r => ({ ...r, name: displayName(r.name) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    <Bar dataKey="total" fill="#3b82f6" radius={[4, 4, 0, 0]} name={tr('المبيعات')} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card p-0">
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{groupLabel()}</th>
                        <th>{groupBy === 'product' ? tr('الكمية') : tr('عدد الفواتير')}</th>
                        <th>{tr('إجمالي المبيعات')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(salesRows as SalesRow[]).map((row, i) => (
                        <tr key={i}>
                          <td className="font-medium text-gray-800">{displayName(row.name)}</td>
                          {/* حسب الصنف: الكمية بالأساس من الخادم — مفكَّكةً «٢ كرتون و٣ حبة» لصنفٍ له وحدات، والرقم كما كان لغيره */}
                          <td className="text-gray-600">{groupBy === 'product' && hasBigUnit(row.units) ? baseQtyText(Number(row.qty) || 0, row, plainQty) : (row.count ?? row.qty ?? '-')}</td>
                          <td className="font-semibold text-[#E15A30]">{formatCurrency(row.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="card text-center text-gray-400 py-12">{tr('لا توجد بيانات')}</div>
          )}
        </div>
      )}

      {/* تقرير المرتجع: مستندات الإرجاع المؤكَّدة في المدى، الأحدث أوّلاً */}
      {tab === 'sales' && salesType === 'returns' && (
        <div className="space-y-4">
          {returnsQ.isPending ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
          ) : returnsQ.isError ? (
            <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
              <span>{tr('تعذر تحميل التقرير')}</span>
              <button onClick={() => returnsQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
            </div>
          ) : returnRows.length === 0 ? (
            <div className="card text-center text-gray-400 py-12">
              {q ? tr('لا نتائج مطابقة للبحث') : tr('لا مرتجعات في هذه الفترة')}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('عدد المرتجعات')}</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums">{returnTotals.count}</p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('إجمالي قيمة المرتجعات')}</p>
                  <p className="text-xl font-bold text-amber-700 tabular-nums">{formatCurrency(returnTotals.total)}</p>
                </div>
                {/* النسبة على المرتجعات كلها لا على نتائج البحث — بحثٌ يقطّع القائمة لا يغيّر نسبة الشركة */}
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('نسبة المرتجع من المبيعات')}</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums">
                    {returnsQ.data?.summary.returnRate == null ? '—' : `${returnsQ.data.summary.returnRate}%`}
                  </p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500 mb-1">{tr('السبب')}</p>
                  <div className="space-y-0.5 text-xs">
                    {Object.entries(returnsQ.data?.summary.byReason ?? {}).map(([k, v]) => (
                      <p key={k} className="flex justify-between gap-2"><span className="text-gray-600">{reasonLabel(k)}</span><b className="tabular-nums">{v.count}</b></p>
                    ))}
                  </div>
                </div>
              </div>
              {returnsQ.data?.rangeApplied === false && returnsQ.data.defaultDays && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2">
                  {tr('بلا مدى محدد يعرض الخادم آخر تسعين يوما فقط')}
                </div>
              )}
              <div className="card p-0">
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th><th>{tr('رقم المرتجع')}</th><th>{tr('العميل')}</th><th>{tr('المندوب')}</th>
                        <th>{tr('التاريخ')}</th><th>{tr('السبب')}</th><th>{tr('من فاتورة البيع')}</th>
                        <th>{tr('الأصناف')}</th><th>{tr('الإجمالي')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {returnRows.map((r, i) => (
                        <tr key={r.id}>
                          <td className="text-gray-400">{i + 1}</td>
                          <td className="font-medium text-gray-800" dir="ltr">
                            {r.number}
                            {r.creditNote && <span className="ms-1.5 text-[10px] text-[#5B4B9C]">{tr('إشعار دائن')}</span>}
                          </td>
                          <td className="text-gray-700">{r.customer?.name || '—'}</td>
                          <td className="text-gray-600">{r.salesRep?.name || '—'}</td>
                          <td className="text-gray-500 text-sm">{fmtDay(r.invoiceDate)}</td>
                          <td className="text-sm">
                            <span className={r.reason === 'DAMAGED' ? 'text-red-600 font-semibold' : 'text-gray-700'}>{reasonLabel(r.reason)}</span>
                            {r.toDamagedStock
                              ? <span className="block text-[10px] text-red-600">{tr('تالف بالسيارة')}</span>
                              : r.returnToStock && <span className="block text-[10px] text-[#1E7A52]">{tr('يعود للمخزون')}</span>}
                          </td>
                          <td className="text-gray-600 text-sm" dir="ltr">{r.saleInvoices.length ? r.saleInvoices.join('، ') : '—'}</td>
                          <td className="text-xs text-gray-600">
                            {r.items.map((it, j) => (
                              <span key={j} className="block">
                                {/* بوحدة البند حين بغير الأساس: «×١ حبة» من بند كرتون لا «×١» تُقرأ كرتوناً */}
                                {/* ولصنفٍ له وحدة رئيسية يُلحق اسم الوحدة دائماً «×5 قارورة» (R2) */}
                                {it.name} ×{docQtyText({ qty: it.qty, unitName: it.unit, unitFactor: it.unitFactor, primaryUnitId: it.primaryUnitId }, plainQty)}
                                {it.returnExpired === true && <span className="ms-1 text-[10px] font-semibold text-red-600">{tr('منتهي الصلاحية')}</span>}
                                {/* «تتبّع اللوط»: تشغيلات البند بالأساس — والبند بلا صفوف (غير متتبَّع) بلا سطر */}
                                {lotOn && returnLotsText(it) && <span className="block text-[10px] text-[#6E6557]">{tr('التشغيلة')}: {returnLotsText(it)}</span>}
                              </span>
                            ))}
                          </td>
                          <td className="tabular-nums font-semibold text-amber-700">{formatCurrency(r.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* «تتبّع اللوط» — المبيعات حسب التشغيلة: لكل صنفٍ تشغيلاته (FEFO و«غير معروف» آخراً) بالمباع والمرتجع والصافي بالأساس */}
      {tab === 'sales' && salesType === 'lots' && (
        <div className="space-y-4">
          {lotSalesQ.isPending ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
          ) : lotSalesQ.isError ? (
            <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
              {/* رفضٌ برسالةٍ من الخادم (مدى مقلوب، معامل غير صالح، الميزة مطفأة) يُقال بنصّه — وإلا الرسالة العامة */}
              <span>{(lotSalesQ.error as { response?: { data?: { message?: string } } } | null)?.response?.data?.message || tr('تعذر تحميل التقرير')}</span>
              <button onClick={() => lotSalesQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
            </div>
          ) : lotSalesRows.length === 0 ? (
            <div className="card text-center text-gray-400 py-12">
              {q ? tr('لا نتائج مطابقة للبحث') : tr('لا مبيعات بتشغيلات في هذه الفترة')}
            </div>
          ) : (
            <>
              {/* العدّادات على التقرير كله لا على نتائج البحث — والكمية لا تُجمع عبر الأصناف فلا بطاقة لها */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('التشغيلات')}</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums">{lotSalesQ.data?.summary.lots ?? 0}</p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('الأصناف')}</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums">{lotSalesQ.data?.summary.products ?? 0}</p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('عدد العملاء')}</p>
                  <p className="text-xl font-bold text-[#E15A30] tabular-nums">{lotSalesQ.data?.summary.customers ?? 0}</p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('عدد فواتير البيع')}</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums">{lotSalesQ.data?.summary.invoices ?? 0}</p>
                </div>
              </div>
              {lotSalesQ.data?.rangeApplied === false && lotSalesQ.data.defaultDays && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2">
                  {tr('بلا مدى محدد يعرض الخادم آخر تسعين يوما فقط')}
                </div>
              )}
              {lotSalesQ.data?.scoped && (
                <div className="rounded-xl border border-[#F1EBDF] bg-[#FAF7F0] text-[#6E6557] text-xs px-3 py-2">{tr('تقرير التشغيلات مقيد بنطاقك')}</div>
              )}
              {lotSalesQ.data?.truncated && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs px-3 py-2">{tr('النتيجة مقطوعة عند الحد الأقصى للفواتير ضيق المدى')}</div>
              )}
              <div className="card p-0">
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('الصنف')}</th><th>{tr('التشغيلة')}</th><th>{tr('تاريخ الانتهاء')}</th><th>{tr('الحالة')}</th>
                        <th>{tr('مباع')}</th><th>{tr('مرتجع')}</th><th>{tr('صافي المبيع')}</th>
                        <th>{tr('عدد العملاء')}</th><th>{tr('عدد فواتير البيع')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lotGroups.map(g => (
                        <Fragment key={g.productId}>
                          {g.rows.map((r, j) => {
                            const u = uncertainSold(r);
                            return (
                              <tr key={r.lotId ?? 'unknown'}>
                                <td className="text-gray-800">
                                  {j === 0 && <><p className="font-medium">{r.productName}</p>{r.productCode && <p className="text-[11px] text-gray-400">{r.productCode}</p>}</>}
                                </td>
                                <td className="font-semibold" dir="ltr">{r.lotNumber ?? <span className="font-normal text-gray-500">{tr('غير معروف')}</span>}</td>
                                <td className="text-sm text-gray-600 whitespace-nowrap">{r.expiryDate ? formatDayOnly(r.expiryDate) : '—'}</td>
                                <td className="text-xs whitespace-nowrap">
                                  {r.status === 'BLOCKED'
                                    ? <span className="px-2 py-0.5 rounded-full font-semibold bg-red-50 text-red-700">{tr(r.blockKind ? LOT_BLOCK_KIND_LABELS[r.blockKind] : LOT_STATUS_LABELS.BLOCKED)}</span>
                                    : r.status ? <span className="text-gray-500">{tr(LOT_STATUS_LABELS[r.status])}</span> : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="tabular-nums">
                                  {lotQty(r, r.sold)}
                                  {u.assumed > 0 && <span className="block text-[10px] text-amber-700">{tr('مفترض')} {lotQty(r, u.assumed)}</span>}
                                  {u.unknown > 0 && r.lotId !== null && <span className="block text-[10px] text-gray-400">{tr('غير معروف')} {lotQty(r, u.unknown)}</span>}
                                </td>
                                <td className="tabular-nums text-gray-600">{lotQty(r, r.returned)}</td>
                                <td className={`tabular-nums font-semibold ${r.net < 0 ? 'text-red-600' : 'text-gray-800'}`}>{lotQty(r, r.net)}</td>
                                <td className="tabular-nums">{r.customers}</td>
                                <td className="tabular-nums text-gray-600">{r.invoices}</td>
                              </tr>
                            );
                          })}
                          {g.rows.length > 1 && g.product && (
                            <tr className="bg-[#FAF7F0]">
                              <td className="text-xs font-semibold text-[#6E6557]" colSpan={4}>{tr('إجمالي الصنف')} — {g.product.productName}</td>
                              <td className="tabular-nums font-semibold">{lotQty(g.product, g.product.sold)}</td>
                              <td className="tabular-nums font-semibold text-gray-600">{lotQty(g.product, g.product.returned)}</td>
                              <td className="tabular-nums font-bold">{lotQty(g.product, g.product.net)}</td>
                              <td className="tabular-nums font-semibold">{g.product.customers}</td>
                              <td className="tabular-nums font-semibold text-gray-600">{g.product.invoices}</td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* تقرير الطلبات: الفواتير التي حُدّد لها تاريخ تسليم، الأقرب تسليماً أوّلاً */}
      {tab === 'sales' && salesType === 'orders' && (
        <div className="space-y-4">
          {ordersQ.isPending ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل')}</div>
          ) : ordersQ.isError ? (
            <div className="card flex flex-col items-center gap-3 py-10 text-gray-500">
              <span>{tr('تعذر تحميل التقرير')}</span>
              <button onClick={() => ordersQ.refetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
            </div>
          ) : orderRows.length === 0 ? (
            <div className="card text-center text-gray-400 py-12">
              {q ? tr('لا نتائج مطابقة للبحث') : tr('لا طلبات بتاريخ تسليم في هذه الفترة')}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-4">
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('عدد الطلبات')}</p>
                  <p className="text-xl font-bold text-gray-700 tabular-nums">{orderTotals.count}</p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('إجمالي قيمة الطلبات')}</p>
                  <p className="text-xl font-bold text-[#E15A30] tabular-nums">{formatCurrency(orderTotals.total)}</p>
                </div>
                <div className="card text-center">
                  <p className="text-xs text-gray-500">{tr('المتبقي على الطلبات')}</p>
                  <p className="text-xl font-bold text-red-600 tabular-nums">{formatCurrency(orderTotals.remaining)}</p>
                </div>
              </div>
              <div className="card p-0">
                <div className="px-5 py-2.5 border-b border-[#F1EBDF] text-[12px] text-[#6E6557]">
                  {tr('المدى محسوب على تاريخ التسليم لا تاريخ الفاتورة والترتيب بالأقرب تسليما')}
                </div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th><th>{tr('رقم الفاتورة')}</th><th>{tr('العميل')}</th><th>{tr('المندوب')}</th>
                        <th>{tr('تاريخ الفاتورة')}</th><th>{tr('تاريخ التسليم')}</th>
                        <th>{tr('الإجمالي')}</th><th>{tr('المتبقي')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderRows.map((o, i) => {
                        const remaining = Number(o.total || 0) - Number(o.paidAmt || 0);
                        // تسليمٌ مضى موعده: ما لم يُسلَّم بعدُ عملٌ متأخّر، والمشرف يريده بارزاً
                        const late = new Date(o.deliveryDate).getTime() < new Date(new Date().toDateString()).getTime();
                        return (
                          <tr key={o.id}>
                            <td className="text-gray-400">{i + 1}</td>
                            <td className="font-medium text-gray-800" dir="ltr">{o.number}</td>
                            <td className="text-gray-700">{o.customer?.name || '—'}</td>
                            <td className="text-gray-600">{o.salesRep?.name || '—'}</td>
                            <td className="text-gray-500 text-sm">{fmtDay(o.invoiceDate)}</td>
                            <td className={`text-sm font-semibold ${late ? 'text-[#C0392B]' : 'text-[#1E7A52]'}`}>
                              {fmtDay(o.deliveryDate)}
                              {late && <span className="ms-1.5 text-[10px]">{tr('متأخر')}</span>}
                            </td>
                            <td className="tabular-nums font-semibold text-[#E15A30]">{formatCurrency(Number(o.total || 0))}</td>
                            <td className="tabular-nums">{remaining > 0.004
                              ? <b className="text-red-600">{formatCurrency(remaining)}</b>
                              : <span className="text-[#1E7A52]">{tr('مسدد')}</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Collections Report */}
      {tab === 'collections' && collectData && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('إجمالي التحصيل')}</p>
              <p className="text-xl font-bold text-green-600">{formatCurrency(collectData.summary.total)}</p>
            </div>
            <div className="card text-center">
              <p className="text-xs text-gray-500">{tr('عدد السندات')}</p>
              <p className="text-xl font-bold text-gray-700">{collectData.summary.count}</p>
            </div>
            {collMethods.map(m => (
              <div key={m.id} className="card text-center">
                <p className="text-xs text-gray-500">{m.short}</p>
                <p className="text-lg font-bold text-gray-700">{formatCurrency(m.amount)}</p>
              </div>
            ))}
          </div>

          {/* التحصيل حسب المندوب — صفٌّ لكلّ مندوب يُفتح على سنداته */}
          {collType === 'byRep' && (
            collRepShown.length === 0 ? (
              <div className="card text-center py-12 text-gray-400">
                {q ? tr('لا نتائج مطابقة للبحث') : tr('لا سندات قبض في هذه الفترة')}
              </div>
            ) : (
              <div className="card p-0">
                <div className="px-5 py-3 border-b border-[#F1EBDF] flex items-center gap-3 text-sm flex-wrap">
                  <span className="flex items-center gap-2"><UserCheck size={16} className="text-[#E15A30]" /><b className="text-[#1F1A13]">{tr('عدد المناديب المحصلين')}: {collRepShown.length}</b></span>
                  <span className="text-[#9A8F7E]">•</span>
                  <span className="text-[#6E6557]">{tr('إجمالي المعروض')}: <b className="text-green-700 tabular-nums">{formatCurrency(collShownTotals.total)}</b> ({collShownTotals.count} {tr('سند')})</span>
                </div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>#</th><th>{tr('المندوب')}</th><th>{tr('عدد السندات')}</th>
                        {collCols.map(c => <th key={c.id}>{c.short}</th>)}
                        <th>{tr('الإجمالي')}</th><th>{tr('النسبة')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {collRepShown.map((r, i) => {
                        /* النسبة من إجمالي **المعروض** لا من إجمالي الفترة: مع بحثٍ
                           نشط تجمع النسب ١٠٠٪ بدل أن تبدو ناقصةً بلا سبب ظاهر. */
                        const pct = collShownTotals.total > 0 ? Math.round((r.total / collShownTotals.total) * 100) : 0;
                        return (
                          <Fragment key={r.id}>
                            <tr className="cursor-pointer hover:bg-[#FAF7F0]" onClick={() => setExpandedColl(p => p === r.id ? null : r.id)}>
                              <td className="text-gray-400">{i + 1}</td>
                              <td className="font-medium text-gray-800">
                                <span className="inline-flex items-center gap-1.5">
                                  <span className="text-[#E15A30] text-xs w-3">{expandedColl === r.id ? '▲' : '▾'}</span>
                                  {collRepName(r)}
                                </span>
                              </td>
                              <td className="tabular-nums text-gray-700">{r.count}</td>
                              {collCols.map(c => (
                                <td key={c.id} className="tabular-nums text-gray-600">{r.byMethod[c.id] ? formatCurrency(r.byMethod[c.id]) : <span className="text-gray-300">—</span>}</td>
                              ))}
                              <td className="tabular-nums font-bold text-green-600">{formatCurrency(r.total)}</td>
                              <td>
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 min-w-[40px] bg-gray-200 rounded-full h-1.5">
                                    <div className="h-1.5 rounded-full bg-green-500" style={{ width: `${pct}%` }} />
                                  </div>
                                  <span className="text-xs text-gray-600 w-9 tabular-nums">{pct}%</span>
                                </div>
                              </td>
                            </tr>
                            {expandedColl === r.id && (
                              <tr>
                                <td colSpan={5 + collCols.length} className="bg-[#FAF7F0] p-0">
                                  <div className="p-3">
                                    <p className="text-xs font-semibold text-[#6E6557] mb-2">{tr('سندات')} {collRepName(r)} ({r.count})</p>
                                    <div className="overflow-x-auto rounded-lg border border-[#F1EBDF] bg-white">
                                      <table className="w-full text-sm">
                                        <thead>
                                          <tr className="text-[11px] text-[#9A8F7E] border-b border-[#F1EBDF]">
                                            <th className="text-start font-medium py-1.5 px-3">#</th>
                                            <th className="text-start font-medium py-1.5 px-3">{tr('رقم السند')}</th>
                                            <th className="text-start font-medium py-1.5 px-3">{tr('التاريخ')}</th>
                                            <th className="text-start font-medium py-1.5 px-3">{tr('العميل')}</th>
                                            <th className="text-start font-medium py-1.5 px-3">{tr('طريقة الدفع')}</th>
                                            <th className="text-start font-medium py-1.5 px-3">{tr('المبلغ')}</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {r.receipts.map((rc, j) => (
                                            <tr key={rc.id} className="border-b border-[#F6F1E8] last:border-0">
                                              <td className="py-1.5 px-3 text-gray-400">{j + 1}</td>
                                              <td className="py-1.5 px-3 font-medium text-gray-700" dir="ltr">{rc.receiptNumber}</td>
                                              <td className="py-1.5 px-3 text-gray-500">{fmtDateTime(rc.receiptDate)}</td>
                                              <td className="py-1.5 px-3 text-gray-700">{rc.customer?.name || '—'}</td>
                                              <td className="py-1.5 px-3 text-gray-500">{methodLabel(rc.paymentMethod, rc.paymentMethodKey)}</td>
                                              <td className="py-1.5 px-3 tabular-nums font-semibold text-green-600">{formatCurrency(Number(rc.amount) || 0)}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {/* Balances Report */}
      {tab === 'balances' && custType === 'balances' && balanceRows && (
        <div className="space-y-4">
        {balanceTotal && (
          <div className="card p-0 overflow-hidden border-t-4 border-[#E15A30]">
            <div className="px-4 py-3.5 bg-[#FBEBE2]/50 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-[#FBEBE2] flex items-center justify-center shrink-0"><Wallet size={18} className="text-[#E15A30]" /></div>
                <div>
                  <p className="text-[12px] text-[#6E6557]">{tr('إجمالي مديونية الشركة')}</p>
                  <p className="text-xl font-extrabold tabular-nums text-red-600">{formatCurrency(balanceTotal.total)}</p>
                </div>
              </div>
              <div className="text-[12px] text-[#6E6557]">{tr('عدد العملاء المدينين')}: <b className="text-[#1F1A13]">{balanceTotal.count}</b></div>
            </div>
          </div>
        )}
        <div className="card p-0">
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr><th>{tr('العميل')}</th><th>{tr('الجوال')}</th><th>{tr('الرصيد')}</th><th>{tr('الحد الائتماني')}</th><th>{tr('نسبة الاستخدام')}</th></tr>
              </thead>
              <tbody>
                {balanceRows.map(c => (
                  <tr key={c.id}>
                    <td className="font-medium text-gray-800">{c.name}</td>
                    <td className="font-mono text-sm text-gray-500">{c.phone}</td>
                    <td className={`font-semibold ${Number(c.balance) > Number(c.creditLimit) ? 'text-red-600' : 'text-orange-600'}`}>
                      {formatCurrency(c.balance)}
                    </td>
                    <td className="text-gray-500">{formatCurrency(c.creditLimit)}</td>
                    <td>
                      {Number(c.creditLimit) > 0 && (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${Number(c.balance) > Number(c.creditLimit) ? 'bg-red-500' : 'bg-[#E15A30]'}`}
                              style={{ width: `${Math.min(100, (Number(c.balance) / Number(c.creditLimit)) * 100)}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500 w-10">
                            {Math.round((Number(c.balance) / Number(c.creditLimit)) * 100)}%
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        </div>
      )}

      {/* Customer Visits Report — كل الزيارات في تقرير واحد: العميل، المندوب، الوقت */}
      {/* حالتا التحميل والخطأ صريحتان: visitRows مصفوفةٌ صادقة دائماً، فبلا هذا
          كان الجدول يظهر «إجمالي الزيارات: ٠» أثناء الجلب أو عند تعطّله — كذباً
          يدفع المشرف لظنّ أنّ المناديب لم يزوروا أحداً. */}
      {tab === 'balances' && custType === 'visits' && visitsStatus === 'pending' && (
        <div className="card flex items-center justify-center h-32 text-gray-400">
          {visitsFetchStatus === 'paused' ? tr('بانتظار عودة الاتصال') : tr('جاري التحميل')}
        </div>
      )}
      {tab === 'balances' && custType === 'visits' && visitsStatus === 'error' && (
        <div className="card flex flex-col items-center justify-center h-32 gap-2 text-gray-500">
          <span>{tr('تعذر تحميل التقرير')}</span>
          <button onClick={() => visitsRefetch()} className="btn-secondary">{tr('إعادة المحاولة')}</button>
        </div>
      )}
      {tab === 'balances' && custType === 'visits' && visitsStatus === 'success' && visitRows && (
        <div className="card p-0">
          <div className="px-5 py-3 border-b border-[#F1EBDF] flex items-center gap-3 text-sm flex-wrap">
            <span className="flex items-center gap-2"><MapPin size={16} className="text-[#E15A30]" /><b className="text-[#1F1A13]">{tr('إجمالي الزيارات')}: {visitRows.length}</b></span>
            <span className="text-[#9A8F7E]">•</span>
            <span className="text-[#6E6557]">{tr('عدد العملاء المزارين')}: {custGroups.length}</span>
          </div>
          <div className="table-wrapper">
            <table className="table">
              <thead>
                <tr><th>#</th><th>{tr('العميل')}</th><th>{tr('عدد الزيارات')}</th><th>{tr('متوسط مدة الزيارة')}</th><th>{tr('آخر زيارة')}</th><th>{tr('تصدير')}</th></tr>
              </thead>
              <tbody>
                {custGroups.map((g, i) => (
                  <Fragment key={g.customerId}>
                    <tr className="cursor-pointer hover:bg-[#FAF7F0]" onClick={() => setExpandedCust(p => p === g.customerId ? null : g.customerId)}>
                      <td className="text-gray-400">{i + 1}</td>
                      <td className="font-medium text-gray-800">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-[#E15A30] text-xs w-3">{expandedCust === g.customerId ? '▲' : '▾'}</span>
                          {g.customerName || '—'}
                        </span>
                      </td>
                      <td><span className="inline-flex items-center gap-1 font-bold text-[#2563EB]"><MapPin size={13} /> {g.visitsCount}</span></td>
                      <td className="text-gray-600 tabular-nums">{fmtVisitDur(g.avgDurationSec) || <span className="text-gray-400">{tr('بلا توقيت')}</span>}</td>
                      <td className="text-gray-500 text-sm">{fmtDateTime(g.lastVisit)}</td>
                      <td>
                        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                          <button onClick={() => exportCustVisits(g)} title={`${tr('تصدير Excel')} — ${g.customerName}`}
                            className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Download size={15} /></button>
                          <button onClick={() => exportCustVisitsPdf(g)} title={`${tr('تصدير PDF')} — ${g.customerName}`}
                            className="p-1.5 rounded-lg text-[#E15A30] hover:bg-[#FBEBE2]"><FileText size={15} /></button>
                        </div>
                      </td>
                    </tr>
                    {expandedCust === g.customerId && (
                      <tr>
                        <td colSpan={6} className="bg-[#FAF7F0] p-0">
                          <div className="p-3">
                            <p className="text-xs font-semibold text-[#6E6557] mb-2">{tr('كل زيارات')} {g.customerName} ({g.visitsCount})</p>
                            <div className="overflow-x-auto rounded-lg border border-[#F1EBDF] bg-white">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-[11px] text-[#9A8F7E] border-b border-[#F1EBDF]">
                                    <th className="text-start font-medium py-1.5 px-3">#</th>
                                    <th className="text-start font-medium py-1.5 px-3">{tr('المندوب')}</th>
                                    <th className="text-start font-medium py-1.5 px-3">{tr('التاريخ والوقت')}</th>
                                    <th className="text-start font-medium py-1.5 px-3">{tr('مدة الزيارة')}</th>
                                    <th className="text-start font-medium py-1.5 px-3">{tr('ملاحظة')}</th>
                                    <th className="text-start font-medium py-1.5 px-3">{tr('الموقع')}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {g.visits.map((v, j) => (
                                    <tr key={v.id} className="border-b border-[#F6F1E8] last:border-0">
                                      <td className="py-1.5 px-3 text-gray-400">{j + 1}</td>
                                      <td className="py-1.5 px-3 font-medium text-gray-700">{v.repName || '—'}</td>
                                      <td className="py-1.5 px-3 text-gray-500">{fmtDateTime(v.createdAt)}</td>
                                      <td className="py-1.5 px-3 text-[#2E6FB0] tabular-nums">{fmtVisitDur(v.durationSec) || <span className="text-gray-400">{tr('بلا توقيت')}</span>}</td>
                                      <td className="py-1.5 px-3 text-gray-500">{v.note || '—'}</td>
                                      <td className="py-1.5 px-3">{v.mapsUrl ? <a href={v.mapsUrl} target="_blank" rel="noopener noreferrer" className="text-[#2563EB] hover:underline">{tr('خريطة')}</a> : '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* تقييم الأداء — ترتيب المناديب حسب معيارٍ يختاره المشرف */}
      {tab === 'performance' && perfType === 'ranking' && (
        <RepRankingBoard
          metric={rankMetric} onMetric={setRankMetric} metrics={rankMetrics}
          products={rankProductsQ.data ?? []} productId={rankProduct} onProduct={setRankProduct}
          data={rankingQ.data} loading={rankingQ.isLoading || (rankingQ.fetchStatus === 'fetching' && !rankingQ.data)}
          rows={rankRowsShown}
        />
      )}

      {/* Performance Report */}
      {tab === 'performance' && perfType === 'performance' && perfRows && (
        <div className="space-y-4">
          <div className="card p-0">
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>{tr('المندوب')}</th><th>{tr('عدد الفواتير')}</th><th>{tr('إجمالي المبيعات')}</th>
                    <th>{tr('التحصيل')}</th><th>{tr('نسبة التحصيل')}</th><th>{tr('متوسط الفاتورة')}</th>
                    <th>{tr('ساعات العمل')}</th><th>{tr('عدد الزيارات')}</th><th>{tr('تصدير')}</th>
                  </tr>
                </thead>
                <tbody>
                  {perfRows.map(r => (
                    <Fragment key={r.id}>
                    <tr>
                      <td className="font-medium text-gray-800">{r.name}</td>
                      <td className="text-gray-600">{r.invoicesCount}</td>
                      <td className="font-semibold text-[#E15A30]">{formatCurrency(r.salesTotal)}</td>
                      <td className="text-green-600">{formatCurrency(r.collectionsTotal)}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-100 rounded-full h-1.5 w-16">
                            <div className="h-1.5 rounded-full bg-green-500" style={{ width: `${r.collectionRate}%` }} />
                          </div>
                          <span className="text-xs text-gray-600 w-10">{r.collectionRate}%</span>
                        </div>
                      </td>
                      <td className="text-gray-500">{formatCurrency(r.avgInvoice)}</td>
                      <td className="font-semibold text-[#1E7A52]">{fmtDuration(r.workHours, r.workMins)}</td>
                      <td>
                        {r.visits.length > 0 ? (
                          <button onClick={() => setExpandedPerf(p => p === r.id ? null : r.id)}
                            className="inline-flex items-center gap-1 text-[#2563EB] font-semibold hover:underline"
                            title={tr('عرض مواقع الزيارات')}>
                            <MapPin size={13} /> {r.visitsCount} {expandedPerf === r.id ? '▲' : '▾'}
                          </button>
                        ) : <span className="text-gray-500">{r.visitsCount}</span>}
                      </td>
                      <td>
                        <div className="flex items-center gap-1">
                          <button onClick={() => exportRepPerf(r)} title={`${tr('تصدير Excel')} — ${r.name}`}
                            className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Download size={15} /></button>
                          <button onClick={() => exportRepPerfPdf(r)} title={`${tr('تصدير PDF')} — ${r.name}`}
                            className="p-1.5 rounded-lg text-[#E15A30] hover:bg-[#FBEBE2]"><FileText size={15} /></button>
                        </div>
                      </td>
                    </tr>
                    {expandedPerf === r.id && r.visits.length > 0 && (
                      <tr>
                        <td colSpan={9} className="bg-[#FAF7F0] p-0">
                          <div className="p-3">
                            <p className="text-xs font-semibold text-[#6E6557] mb-2">{tr('مواقع زيارات')} {r.name} ({r.visits.length})</p>
                            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              {r.visits.map((v, i) => (
                                <a key={i} href={v.mapsUrl} target="_blank" rel="noreferrer"
                                  className="flex items-center gap-1.5 text-xs bg-white border border-[#F1EBDF] rounded-lg px-2.5 py-1.5 hover:border-[#2563EB]">
                                  <MapPin size={12} className="text-[#2563EB] shrink-0" />
                                  <span className="font-medium text-[#1F1A13] truncate">{v.customerName || tr('زيارة')}</span>
                                  <span className="text-[#9A8F7E] shrink-0">{fmtDateTime(v.createdAt)}</span>
                                </a>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* تقرير ساعات العمل — على نمط تقارير الحضور المتخصّصة: صفٌّ لكل يوم في
          المدى (والغائب يظهر فارغاً لا يُحذف)، ومفتاح ألوان أعلى الجدول، وشريطا
          ملخّص: ساعات ثم أيام. والزيارات تُفتح بالنقر على اليوم فلا تزحم الجدول. */}
      {tab === 'performance' && perfType === 'hours' && (
        <div className="space-y-4">
          {editDay && <AttendanceEditModal rep={editDay.rep} date={editDay.date} onClose={() => setEditDay(null)} />}
          {presenceDay && <PresenceDayModal {...presenceDay} onClose={() => setPresenceDay(null)} />}
          {showImport && <AttendanceImportModal onClose={() => setShowImport(false)} />}
          {/* مفتاح الألوان — سأل المالك «هل الأخضر بداية والأحمر نهاية؟»، وما
              لا يُشرح يُخمَّن. الشرح هنا أرخص من تخمينٍ يُبنى عليه قرار. */}
          <div className="card py-3">
            <div className="flex items-center gap-x-5 gap-y-2 flex-wrap text-xs text-[#6E6557]">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#E7F5EE] border border-[#1E7A52]" /> {tr('بداية العمل')}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#FBEBE2] border border-[#C0392B]" /> {tr('نهاية العمل')}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#EAF3FB] border border-[#2E6FB0]" /> {tr('وقت داخل الزيارات')}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#F1EBDF] border border-[#B3A996]" /> {tr('يوم بلا نشاط')}</span>
              {attendanceOn && <>
                <span className="flex items-center gap-1.5"><span className="rounded bg-amber-100 px-1 text-[10px] font-bold text-amber-800">{tr('خارج النطاق')}</span> {tr('بصمة قبلت خارج نطاق العملاء')}</span>
                <span className="flex items-center gap-1.5"><span className="rounded bg-blue-50 px-1 text-[10px] font-bold text-blue-700">{tr('معدلة')}</span> {tr('عدلت او اضيفت اداريا')}</span>
              </>}
              <span className="text-[#9A8F7E]">· {tr('انقر على أي يوم لعرض زياراته')}</span>
              {attendanceOn && (
                <button onClick={() => setShowImport(true)} className="ms-auto btn-secondary py-1.5 px-3 text-xs">
                  <Upload size={14} /> {tr('رفع بصمات من Excel')}
                </button>
              )}
            </div>
            <p className="text-[11px] text-[#9A8F7E] mt-2 leading-relaxed">
              {tr('إجمالي وقت العمل يقاس من أول نشاط مرصود في اليوم موقع أو فتح تطبيق أو زيارة إلى آخره أقرب مقياس متاح لخروج المندوب وعودته و نشاط التطبيق هو الوقت الذي كان فيه التطبيق مفتوحا ومتصلا فقط')}
              {' '}{tr('ومع بصمة الحضور والانصراف يسجل كل دخول وكل خروج فترة عمل ويحسب الإجمالي من مجموع الفترات بلا ما بينها')}
            </p>
          </div>

          {hoursData?.clampedDays != null && (
            <div className="rounded-xl px-4 py-2.5 text-sm border bg-amber-50 border-amber-200 text-amber-800">
              {tr('المدى المطلوب أطول من المسموح عرضت آخر')} {hoursData.clampedDays} {tr('يوما فقط')}
            </div>
          )}
          {hoursStatus === 'pending' ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">
              {hoursFetchStatus === 'paused' ? tr('بانتظار عودة الاتصال') : tr('جاري التحميل')}
            </div>
          ) : hoursStatus === 'error' ? (
            <div className="card flex items-center justify-center h-32 text-red-500">{tr('تعذر تحميل التقرير')}</div>
          ) : (hoursRows && hoursRows.length > 0) ? (
            hoursRows.map(r => (
              <div key={r.id} className="card p-0 overflow-hidden">
                {/* ترويسة المندوب */}
                <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-3 bg-[#FAF7F0] border-b border-[#F1EBDF]">
                  <p className="font-bold text-[#1F1A13]">{r.name}</p>
                  <div className="flex items-center gap-1">
                    <button onClick={() => exportRepHours(r)} title={`${tr('تصدير Excel')} — ${r.name}`}
                      className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Download size={15} /></button>
                    <button onClick={() => exportRepHoursPdf(r)} title={`${tr('تصدير PDF')} — ${r.name}`}
                      className="p-1.5 rounded-lg text-[#E15A30] hover:bg-[#FBEBE2]"><FileText size={15} /></button>
                  </div>
                </div>

                {/* الجدول اليومي */}
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('التاريخ')}</th><th>{tr('فترات العمل')}</th>
                        <th>{tr('إجمالي وقت العمل')}</th><th>{tr('نشاط التطبيق')}</th>
                        <th>{tr('عدد الزيارات')}</th><th>{tr('وقت داخل الزيارات')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.days.map(d => (
                        <Fragment key={d.date}>
                          <tr
                            onClick={() => d.visitsCount > 0 && setOpenDay(openDay === `${r.id}|${d.date}` ? null : `${r.id}|${d.date}`)}
                            className={`${d.absent ? 'bg-[#FCFAF6] text-[#B3A996]' : d.visitsCount > 0 ? 'cursor-pointer hover:bg-[#FAF7F0]' : ''}`}>
                            <td className="tabular-nums text-xs whitespace-nowrap">
                              {d.date}
                              {d.visitsCount > 0 && <span className="ms-1 text-[#9A8F7E]">{openDay === `${r.id}|${d.date}` ? '▲' : '▾'}</span>}
                              {attendanceOn && (
                                <button onClick={(e) => { e.stopPropagation(); setEditDay({ rep: { id: r.id, name: r.name }, date: d.date }); }}
                                  title={tr('تعديل بصمات الحضور')} aria-label={tr('تعديل بصمات الحضور')}
                                  className="ms-1.5 inline-flex p-1 rounded text-[#9A8F7E] hover:text-[#E15A30] hover:bg-[#FBEBE2] align-middle">
                                  <Pencil size={12} />
                                </button>
                              )}
                            </td>
                            {d.absent ? (
                              <td colSpan={5} className="text-center text-xs">{tr('لا نشاط مسجل في هذا اليوم')}</td>
                            ) : (
                              <>
                                {/* فترات اليوم في خليةٍ واحدة — فترةٌ لكل حضور→انصراف مسجَّلين (الدوام المتقطّع: خرج وعاد)،
                                    صفٌّ واحد لليوم لا صفٌّ لكل فترة. يومٌ بلا بصمة امتدادٌ واحد من أول أثرٍ إلى آخره كما كان:
                                    بدايةٌ خضراء ونهايةٌ حمراء. ووقتُ بصمةٍ بموقعٍ معلوم رابطٌ بدبّوسٍ يفتح مكانها على الخريطة */}
                                <td>
                                  <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                    {periodsOf(d).map((p, i) => (
                                      <Fragment key={i}>
                                        {i > 0 && <span className="text-[#C9BFB0]">·</span>}
                                        <span className="inline-flex items-center gap-1"
                                          title={p.source === 'PUNCH' ? tr('من بصمة الحضور والانصراف') : tr('من أول أثر مرصود إلى آخره بلا بصمة')}>
                                          {punchTime(p.start, punchInUrl(p), 'bg-[#E7F5EE] text-[#1E7A52]', [tr('موقع الحضور'), p.inDevice, p.inOutside != null ? placeLabel(p.inOutside, p.inDistanceM, tr) : null].filter(Boolean).join(' · '))}
                                          <span className="text-[#C9BFB0]">–</span>
                                          {p.end
                                            ? punchTime(p.end, punchOutUrl(p), 'bg-[#FBEBE2] text-[#C0392B]', [tr('موقع الانصراف'), p.outDevice, p.outOutside != null ? placeLabel(p.outOutside, p.outDistanceM, tr) : null].filter(Boolean).join(' · '))
                                            : <span className="text-xs text-gray-400">{tr('لم ينصرف')}</span>}
                                          {/* وسما الفترة: بصمةٌ قُبلت خارج النطاق، وفترةٌ عُدّلت أو أُضيفت إدارياً أو رُفعت من Excel */}
                                          {periodOutside(p) && (
                                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800"
                                              title={[p.inOutside ? `${tr('الحضور')}: ${placeLabel(p.inOutside, p.inDistanceM, tr)}` : null, p.outOutside ? `${tr('الانصراف')}: ${placeLabel(p.outOutside, p.outDistanceM, tr)}` : null].filter(Boolean).join(' · ')}>
                                              {tr('خارج النطاق')}
                                            </span>
                                          )}
                                          {p.source === 'PUNCH' && (p.edited || (p.entry && p.entry !== 'APP')) && (
                                            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">{entryLabel(p, tr)}</span>
                                          )}
                                        </span>
                                      </Fragment>
                                    ))}
                                    {breakOf(d) > 0 && (
                                      <span className="text-[11px] text-[#9A8F7E] whitespace-nowrap">{tr('الاستراحة')} {compactMinutes(breakOf(d), tr)}</span>
                                    )}
                                    {/* «التحقق العشوائي من التواجد»: في الوقت من المُرسَل — النقر يفتح التفاصيل */}
                                    {(() => {
                                      const pr = presenceMap.get(`${r.id}|${d.date}`);
                                      if (!pr?.length) return null;
                                      const s = presenceSummary(pr);
                                      if (!s.asked) return null;
                                      const tone = s.tone === 'bad' ? 'bg-red-50 text-red-700' : s.tone === 'warn' ? 'bg-amber-100 text-amber-800' : 'bg-green-50 text-green-700';
                                      return (
                                        <button onClick={(e) => { e.stopPropagation(); setPresenceDay({ repName: r.name, date: d.date, rows: pr }); }}
                                          title={tr('التحقق من التواجد')} className={`rounded px-1.5 py-0.5 text-[10px] font-bold whitespace-nowrap ${tone}`}>
                                          {tr('التحقق')} {s.onTime}/{s.asked}
                                        </button>
                                      );
                                    })()}
                                  </span>
                                </td>
                                <td className="font-bold text-[#1F1A13] tabular-nums">{fmtMin(d.spanMinutes)}</td>
                                <td className="text-gray-600 tabular-nums">{fmtMin(d.appMinutes)}</td>
                                <td className="tabular-nums">{d.visitsCount}</td>
                                <td className="tabular-nums text-[#2E6FB0] font-semibold">{fmtVisitDur(d.visitsSec) || '—'}</td>
                              </>
                            )}
                          </tr>
                          {openDay === `${r.id}|${d.date}` && d.visits.length > 0 && (
                            <tr>
                              <td colSpan={6} className="bg-[#FDFBF7] p-0">
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>{tr('اسم العميل')}</th><th>{tr('الزيارات والموقع')}</th><th>{tr('بداية الزيارة')}</th>
                                      <th>{tr('نهاية الزيارة')}</th><th>{tr('مدة الزيارة')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {d.visits.map((v, i) => (
                                      <tr key={i}>
                                        <td className="font-medium text-gray-800">
                                          {v.customerName}
                                          {v.hasNote && <span className="ms-1.5 text-[10px] text-[#2E6FB0]" title={tr('رافقتها ملاحظة أو صور')}>📝</span>}
                                        </td>
                                        {/* عدد وقفات هذا العميل في هذا اليوم، ودبّوسٌ يفتح موقع الوقفة
                                            على الخريطة — بشكل عمود «عدد الزيارات» في تقرير العملاء.
                                            والموقع قد يغيب: زيارةٌ سُجّلت والـGPS مغلق. */}
                                        <td>
                                          <span className="inline-flex items-center gap-1.5">
                                            <span className="font-bold text-[#2563EB] tabular-nums">{d.visits.filter(x => x.customerName === v.customerName).length}</span>
                                            {v.lat != null && v.lng != null ? (
                                              <a href={`https://www.google.com/maps?q=${v.lat},${v.lng}`} target="_blank" rel="noopener noreferrer"
                                                onClick={e => e.stopPropagation()} title={tr('عرض موقع الزيارة على الخريطة')}
                                                className="text-[#E15A30] hover:text-[#C2410C]"><MapPin size={14} /></a>
                                            ) : (
                                              <span className="text-gray-300" title={tr('لا موقع مسجل لهذه الزيارة')}><MapPin size={14} /></span>
                                            )}
                                          </span>
                                        </td>
                                        <td className="tabular-nums text-[#1E7A52] font-semibold">{fmtClock(v.start)}</td>
                                        <td className="tabular-nums text-[#C0392B] font-semibold">{v.end ? fmtClock(v.end) : <span className="text-gray-400 font-normal">{tr('بلا توقيت')}</span>}</td>
                                        <td className="tabular-nums text-[#2E6FB0] font-semibold">{fmtVisitDur(v.durationSec) || <span className="text-gray-400 font-normal">{tr('بلا توقيت')}</span>}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* شريط ملخّص الساعات */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#F1EBDF] border-t border-[#F1EBDF]">
                  {[
                    [tr('إجمالي وقت العمل'), fmtMin(r.fieldMinutesTotal), 'text-[#1E7A52]'],
                    [tr('متوسط اليوم'), fmtMin(r.avgDayMinutes), 'text-[#1F1A13]'],
                    [tr('نشاط التطبيق'), fmtDuration(r.hours, r.minutes), 'text-[#1F1A13]'],
                    [tr('وقت داخل الزيارات'), fmtVisitDur(r.days.reduce((a, d) => a + d.visitsSec, 0)) || '—', 'text-[#2E6FB0]'],
                  ].map(([label, val, cls], i) => (
                    <div key={i} className="bg-white px-3 py-2.5">
                      <p className="text-[10px] text-gray-500">{label}</p>
                      <p className={`text-sm font-bold tabular-nums ${cls}`}>{val}</p>
                    </div>
                  ))}
                </div>
                {/* شريط ملخّص الأيام */}
                <div className="grid grid-cols-3 gap-px bg-[#F1EBDF] border-t border-[#F1EBDF]">
                  {[
                    [tr('أيام الحضور'), String(r.workedDays), 'text-[#1E7A52]'],
                    [tr('أيام بلا نشاط'), String(r.absentDays), r.absentDays > 0 ? 'text-[#C0392B]' : 'text-[#9A8F7E]'],
                    [tr('عدد الزيارات'), String(r.visitsTotal), 'text-[#1F1A13]'],
                  ].map(([label, val, cls], i) => (
                    <div key={i} className="bg-white px-3 py-2.5">
                      <p className="text-[10px] text-gray-500">{label}</p>
                      <p className={`text-sm font-bold tabular-nums ${cls}`}>{val}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('لا توجد بيانات حضور في هذه الفترة')}</div>
          )}
        </div>
      )}

      {/* تقرير مديونيات المندوب — رصيد كل عميل مُسنَد، ليُقرأ تقصير التحصيل ويُصدَّر */}
      {tab === 'performance' && perfType === 'receivables' && (
        <div className="space-y-4">
          {recvStatus === 'pending' ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">
              {recvFetchStatus === 'paused' ? tr('بانتظار عودة الاتصال') : tr('جاري التحميل')}
            </div>
          ) : recvStatus === 'error' ? (
            /* فشل الجلب ليس «لا عملاء مُسنَدين»: عرضُ الفراغ كحقيقةٍ يطمئن المشرف كذباً */
            <div className="card flex flex-col items-center justify-center h-32 text-gray-400 gap-2">
              <p className="text-red-500">{tr('تعذر تحميل التقرير')}</p>
              <button onClick={() => recvRefetch()} className="text-xs font-semibold text-[#E15A30] underline">{tr('إعادة المحاولة')}</button>
            </div>
          ) : recvRows && recvRows.some(r => r.customersCount > 0) ? (
            <>
            {recvSummary && (
              <div className="card p-0 overflow-hidden border-t-4 border-[#E15A30]">
                <div className="px-4 py-3.5 bg-[#FBEBE2]/50">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-xl bg-[#FBEBE2] flex items-center justify-center shrink-0"><Wallet size={18} className="text-[#E15A30]" /></div>
                      <div>
                        <p className="text-[12px] text-[#6E6557]">{tr('إجمالي مديونية العملاء المسندين بلا تكرار')}</p>
                        <p className={`text-xl font-extrabold tabular-nums ${recvSummary.distinctReceivable > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(recvSummary.distinctReceivable)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-[12px] text-[#6E6557]">
                      <span>{tr('العملاء المدينون')}: <b className="text-[#1F1A13]">{recvSummary.distinctDebtors}</b></span>
                      <span>{tr('العملاء المسندون')}: <b className="text-[#1F1A13]">{recvSummary.distinctCustomers}</b></span>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#9A8F7E]">{tr('رصيد لحظي صاف للعملاء المسندين يستبعد غير المسندين وقد يختلف عن تقرير أرصدة العملاء')}</p>
                  {recvSummary.sharedCustomers > 0 && (
                    <div className="mt-2.5 flex items-start gap-2 text-[11.5px] text-[#9A5B1E] bg-[#FBEBE2] rounded-lg px-3 py-2">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>
                        <b>{recvSummary.sharedCustomers}</b> {tr('عميل مسند لأكثر من مندوب فرصيده محسوب تحت كل منهم لا تجمع أعمدة المناديب مجموعها')} {formatCurrency(recvSummary.columnsSum)} {tr('اعتمد الإجمالي أعلاه')}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            {recvRows.map(r => (
              <div key={r.id} className="card p-0 overflow-hidden">
                <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-3 bg-[#FAF7F0] border-b border-[#F1EBDF]">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="font-bold text-[#1F1A13]">{r.name}</p>
                    <span className="text-xs text-gray-500">{r.customersCount} {tr('عميل مسند')} · {tr('المدينون')}: {r.debtorsCount}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className={`font-bold text-sm ${r.totalBalance > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(r.totalBalance)}</p>
                    {r.customers.length > 0 && (
                      <div className="flex items-center gap-1">
                        <button onClick={() => exportRepRecv(r)} title={`${tr('تصدير Excel')} — ${r.name}`}
                          className="p-1.5 rounded-lg text-[#1E7A52] hover:bg-green-50"><Download size={15} /></button>
                        <button onClick={() => exportRepRecvPdf(r)} title={`${tr('تصدير PDF')} — ${r.name}`}
                          className="p-1.5 rounded-lg text-[#E15A30] hover:bg-[#FBEBE2]"><FileText size={15} /></button>
                      </div>
                    )}
                  </div>
                </div>
                {r.customers.length === 0 ? (
                  <p className="text-center text-xs text-gray-400 py-4">{tr('لا عملاء مسندين لهذا المندوب')}</p>
                ) : (
                  <div className="table-wrapper">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{tr('العميل')}</th><th>{tr('الجوال')}</th><th>{tr('المدينة')}</th>
                          <th>{tr('الرصيد')}</th><th>{tr('آخر تحصيل')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.customers.map(c => (
                          <tr key={c.id}>
                            <td>
                              <p className="font-medium text-gray-800">{c.name}</p>
                              {c.businessName && <p className="text-[11px] text-gray-400">{c.businessName}</p>}
                            </td>
                            <td className="text-gray-600 font-mono text-xs" dir="ltr">{c.phone}</td>
                            <td className="text-gray-600">{c.city || '—'}</td>
                            <td className={`font-semibold ${c.balance > 0 ? 'text-red-600' : 'text-green-600'}`}>{formatCurrency(c.balance)}</td>
                            <td className="text-xs text-gray-500">{c.lastPaymentAt ? fmtDay(c.lastPaymentAt) : <span className="text-orange-500 font-medium">{tr('لم يحصل قط')}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
            </>
          ) : (
            <div className="card flex flex-col items-center justify-center h-36 text-gray-400 gap-1">
              <p>{tr('لا عملاء مسندين للمناديب بعد')}</p>
              <p className="text-xs">{tr('أسند العملاء لمناديبهم من صفحة المناديب لتظهر مديونياتهم هنا')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
