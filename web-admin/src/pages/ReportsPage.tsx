import { useState, useMemo, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportApi } from '../api/client';
import { formatCurrency } from '../utils/format';
import { useTr } from '../i18n/strings';
import { channelLabel } from '../lib/channels';
import { filterFlat, filterNested } from '../lib/reportSearch';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Download, TrendingUp, Users, UserCheck, MapPin, FileText, Search, X } from 'lucide-react';
import { shareOrDownloadExcel, num } from '../utils/excel';
import { elementToPdfBlob, shareOrDownloadPdf } from '../rep/pdf';
import toast from 'react-hot-toast';

type Tab = 'sales' | 'collections' | 'balances' | 'performance';

// زيارة **مدموجة**: سجلّ المؤقّت وسجلّ الملاحظة للعميل الواحد وقفةٌ واحدة
interface WorkVisit { customerName: string; start: string; end: string | null; durationSec: number | null; hasNote: boolean; parts: number }
interface WorkDayRow {
  date: string; firstActivity: string; lastActivity: string;
  spanMinutes: number; appMinutes: number;
  visits: WorkVisit[]; visitsCount: number; visitsSec: number;
  absent: boolean;   // يومٌ في المدى بلا أيّ أثر
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

export default function ReportsPage() {
  const tr = useTr();
  const [tab, setTab] = useState<Tab>('sales');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState('rep');
  const [search, setSearch] = useState('');
  // نوع تقرير المناديب: أداء | ساعات العمل | مديونيات
  const [perfType, setPerfType] = useState<'performance' | 'hours' | 'receivables'>('performance');

  const methodLabel = (m: string) => m === 'CASH' ? tr('نقدي') : m === 'BANK_TRANSFER' ? tr('تحويل بنكي') : m === 'POS' ? tr('شبكة') : tr('شيك');

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'sales', label: tr('تقارير المبيعات'), icon: TrendingUp },
    { id: 'collections', label: tr('تقارير التحصيل'), icon: Download },
    { id: 'balances', label: tr('أرصدة العملاء'), icon: Users },
    { id: 'performance', label: tr('أداء المناديب'), icon: UserCheck },
  ];

  const { data: salesData, isLoading: salesLoading } = useQuery({
    queryKey: ['report-sales', from, to, groupBy],
    queryFn: async () => {
      const res = await reportApi.sales({ from, to, groupBy });
      return res.data.data;
    },
    enabled: tab === 'sales',
  });

  const { data: collectData } = useQuery({
    queryKey: ['report-collections', from, to],
    queryFn: async () => {
      const res = await reportApi.collections({ from, to });
      return res.data.data as { receipts: unknown[]; summary: { total: number; count: number; byMethod: Record<string, number> } };
    },
    enabled: tab === 'collections',
  });

  const { data: balancesData } = useQuery({
    queryKey: ['report-balances'],
    queryFn: async () => {
      const res = await reportApi.balances({ type: 'overdue' });
      return res.data.data as { id: string; name: string; phone: string; balance: number; creditLimit: number }[];
    },
    enabled: tab === 'balances',
  });

  const [expandedPerf, setExpandedPerf] = useState<string | null>(null); // صفّ مواقع الزيارات المفتوح
  const [openDay, setOpenDay] = useState<string | null>(null);           // «معرّف المندوب|التاريخ» لليوم المفتوح
  const { data: perfData } = useQuery({
    queryKey: ['report-performance', from, to],
    queryFn: async () => {
      const res = await reportApi.repPerformance({ from, to });
      return res.data.data as PerfRow[];
    },
    enabled: tab === 'performance' && perfType === 'performance',
  });

  // مديونيات المندوب: رصيد كل عميل مُسنَد — لحظيّ، فلا يدخل التاريخ في مفتاح الكاش
  // نقرأ status/fetchStatus لا isLoading: عند تقلّب الشبكة يوقف React Query
  // إعادة المحاولة (fetchStatus='paused') فيصير isLoading **كاذباً** (false مع
  // غياب البيانات والخطأ معاً) — وسلسلة عرضٍ تعتمد عليه تسقط على حالة الفراغ
  // وتقول للمشرف «لا عملاء مُسنَدين» والحقيقة «انقطع الاتصال». أُثبت هذا
  // بالمعاينة: status=pending + fetchStatus=paused + failureCount=1.
  const { data: recvData, status: recvStatus, fetchStatus: recvFetchStatus, refetch: recvRefetch } = useQuery({
    queryKey: ['report-rep-receivables'],
    queryFn: async () => {
      const res = await reportApi.repReceivables();
      return res.data.data as RecvRow[];
    },
    enabled: tab === 'performance' && perfType === 'receivables',
  });

  // نفس درس المديونيات: fetchStatus='paused' يجعل isLoading كاذباً فيُعرض
  // «لا بيانات حضور» والحقيقة «انقطع الاتصال» — نقرأ الحالة الصريحة
  const { data: hoursData, status: hoursStatus, fetchStatus: hoursFetchStatus } = useQuery({
    queryKey: ['report-work-hours', from, to],
    queryFn: async () => {
      const res = await reportApi.workHours({ from, to, tz: String(-new Date().getTimezoneOffset()) });
      return res.data.data as WorkHoursRow[];
    },
    enabled: tab === 'performance' && perfType === 'hours',
  });

  // صيغة عرض المدة: «Xس Yد»
  const fmtDuration = (h: number, m: number) => `${h} ${tr('س')} ${m} ${tr('د')}`;
  const fmtDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString('ar', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('ar', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtClock = (iso: string) => new Date(iso).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
  const fmtMin = (min: number) => fmtDuration(Math.floor(min / 60), min % 60);
  // مدة الزيارة بالثواني — بنفس تدرّج خريطة التتبّع حتى يتطابق المعروضان
  const fmtVisitDur = (sec: number | null) => sec == null || sec <= 0 ? null
    : sec >= 3600 ? `${Math.floor(sec / 3600)} ${tr('س')} ${Math.floor((sec % 3600) / 60)} ${tr('د')}`
    : sec >= 60 ? `${Math.floor(sec / 60)} ${tr('د')} ${sec % 60} ${tr('ث')}`
    : `${sec} ${tr('ث')}`;

  const groupLabel = () => groupBy === 'rep' ? tr('المندوب') : groupBy === 'customer' ? tr('العميل')
    : groupBy === 'channel' ? tr('القناة') : groupBy === 'region' ? tr('المنطقة') : tr('الصنف');
  // اسم العرض: أكواد القنوات تُترجَم؛ البقية كما هي
  const displayName = (name: string) => groupBy === 'channel' ? (name === 'UNSET' ? tr('غير محدّد') : tr(channelLabel(name))) : name;

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

  const balanceRows = useMemo(
    () => filterFlat(balancesData || [], q, c => [c.name, c.phone]),
    [balancesData, q],
  );

  const perfRows = useMemo(
    () => filterFlat(perfData || [], q, r => [r.name, ...r.visits.map(v => v.customerName)]),
    [perfData, q],
  );

  // ساعات العمل: **إيجادٌ لا تقطيع** — مقاييس اليوم تصف اليوم كلّه ولا تُشتقّ
  // من زياراتٍ مُنتقاة، فقصُّها مع إبقاء الرقم يُنتج صفحةً أرقامُها لا تشرح جدولها.
  const hoursRows = useMemo(
    () => filterFlat(hoursData || [], q, r => [r.name, ...r.days.flatMap(d => d.visits.map(v => v.customerName))]),
    [hoursData, q],
  );

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

  // يبني أوراق بيانات التبويب النشط (مشتركة بين Excel وPDF)
  const buildSheets = (): { sheets: { name: string; rows: Record<string, unknown>[]; colWidths?: number[] }[]; fname: string } | null => {
    let sheets: { name: string; rows: Record<string, unknown>[]; colWidths?: number[] }[] | null = null;
    let fname = tr('تقرير');
    if (tab === 'performance' && perfType === 'hours' && hoursRows?.length) {
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
        { name: tr('الحضور اليومي'), rows: hoursRows.flatMap(r => r.days.map(d => ({
          [tr('المندوب')]: r.name, [tr('التاريخ')]: d.date,
          [tr('بداية العمل')]: d.absent ? tr('لا نشاط') : fmtClock(d.firstActivity),
          [tr('نهاية العمل')]: d.absent ? tr('لا نشاط') : fmtClock(d.lastActivity),
          [tr('إجمالي وقت العمل')]: d.absent ? '—' : fmtMin(d.spanMinutes),
          [tr('نشاط التطبيق')]: d.absent ? '—' : fmtMin(d.appMinutes),
          [tr('عدد الزيارات')]: d.visitsCount,
          [tr('وقت داخل الزيارات')]: fmtVisitDur(d.visitsSec) || '—',
        }))), colWidths: [22, 12, 12, 12, 14, 14, 12, 16] },
        // زيارةٌ واحدة لكل وقفة: بداية ونهاية صريحتان بدل صفَّين لعميلٍ واحد
        { name: tr('تفاصيل الزيارات'), rows: hoursRows.flatMap(r => r.days.flatMap(d => d.visits.map(v => ({
          [tr('المندوب')]: r.name, [tr('التاريخ')]: d.date,
          [tr('اسم العميل')]: v.customerName,
          [tr('بداية الزيارة')]: fmtClock(v.start),
          [tr('نهاية الزيارة')]: v.end ? fmtClock(v.end) : tr('بلا توقيت'),
          [tr('مدة الزيارة')]: fmtVisitDur(v.durationSec) || tr('بلا توقيت'),
          [tr('ملاحظة/صور')]: v.hasNote ? tr('نعم') : '',
          [tr('إجمالي وقت العمل لليوم')]: fmtMin(d.spanMinutes),
        })))), colWidths: [22, 12, 24, 12, 12, 12, 12, 16] },
      ];
      fname = tr('ساعات العمل');
    } else if (tab === 'performance' && perfType === 'receivables' && recvRows?.length) {
      sheets = [
        { name: tr('ملخص المديونيات'), rows: recvRows.map(r => ({
          [tr('المندوب')]: r.name, [tr('العملاء المسندون')]: r.customersCount,
          [tr('العملاء المدينون')]: r.debtorsCount, [tr('إجمالي المديونية')]: num(r.totalBalance),
        })), colWidths: [22, 16, 16, 18] },
        { name: tr('تفاصيل المديونيات'), rows: recvRows.flatMap(r => r.customers.map(c => ({
          [tr('المندوب')]: r.name, [tr('العميل')]: c.name, [tr('النشاط التجاري')]: c.businessName || '',
          [tr('الجوال')]: c.phone, [tr('المدينة')]: c.city || '', [tr('الرصيد')]: num(c.balance),
          [tr('آخر تحصيل')]: c.lastPaymentAt ? fmtDay(c.lastPaymentAt) : tr('لم يُحصَّل قط'),
        }))), colWidths: [22, 24, 20, 16, 14, 14, 16] },
      ];
      fname = tr('مديونيات المندوب');
    } else if (tab === 'performance' && perfType === 'performance' && perfRows?.length) {
      sheets = [{ name: tr('أداء المناديب'), rows: perfRows.map(r => ({
        [tr('المندوب')]: r.name, [tr('عدد الفواتير')]: r.invoicesCount, [tr('إجمالي المبيعات')]: num(r.salesTotal),
        [tr('التحصيل')]: num(r.collectionsTotal), [tr('نسبة التحصيل %')]: r.collectionRate, [tr('متوسط الفاتورة')]: num(r.avgInvoice),
        [tr('ساعات العمل')]: fmtDuration(r.workHours, r.workMins), [tr('عدد الزيارات')]: r.visitsCount,
        [tr('روابط مواقع الزيارات')]: r.visits.map(v => v.mapsUrl).join('\n'),
      })), colWidths: [22, 12, 16, 14, 14, 16, 14, 12, 55] }];
      // ورقة مواقع الزيارات (روابط خرائط Google)
      const locRows = perfRows.flatMap(r => r.visits.map(v => ({
        [tr('المندوب')]: r.name, [tr('العميل')]: v.customerName, [tr('الوقت')]: fmtDateTime(v.createdAt), [tr('رابط الموقع')]: v.mapsUrl,
      })));
      if (locRows.length) sheets.push({ name: tr('مواقع الزيارات'), rows: locRows, colWidths: [22, 22, 18, 40] });
      fname = tr('أداء المناديب');
    } else if (tab === 'sales' && Array.isArray(salesRows) && salesRows.length) {
      sheets = [{ name: tr('المبيعات'), rows: (salesRows as { name: string; total: number; count?: number; qty?: number }[]).map(r => ({
        [tr('الاسم')]: r.name, [tr('العدد/الكمية')]: r.count ?? r.qty ?? '', [tr('الإجمالي')]: num(r.total),
      })), colWidths: [28, 14, 16] }];
      fname = tr('تقارير المبيعات');
    } else if (tab === 'balances' && balanceRows?.length) {
      sheets = [{ name: tr('أرصدة العملاء'), rows: balanceRows.map(c => ({
        [tr('العميل')]: c.name, [tr('الجوال')]: c.phone, [tr('الرصيد')]: num(c.balance), [tr('الحد الائتماني')]: num(c.creditLimit),
      })), colWidths: [24, 16, 14, 16] }];
      fname = tr('أرصدة العملاء');
    } else if (tab === 'collections' && collectData) {
      sheets = [{ name: tr('التحصيل'), rows: [
        { [tr('البند')]: tr('إجمالي التحصيل'), [tr('القيمة')]: num(collectData.summary.total) },
        { [tr('البند')]: tr('عدد السندات'), [tr('القيمة')]: collectData.summary.count },
        ...Object.entries(collectData.summary.byMethod).map(([m, v]) => ({ [tr('البند')]: methodLabel(m), [tr('القيمة')]: num(v) })),
      ], colWidths: [20, 16] }];
      fname = tr('تقارير التحصيل');
    }
    return sheets ? { sheets, fname } : null;
  };

  const day = () => new Date().toISOString().slice(0, 10);
  const safeName = (s: string) => s.replace(/[\\/?*[\]:]/g, '·').slice(0, 60);

  // تصدير Excel للتبويب النشط
  const handleExport = async () => {
    const built = buildSheets();
    if (!built) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    const out = await shareOrDownloadExcel(built.sheets, `${built.fname}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };

  // يحوّل أوراق البيانات إلى PDF (جداول مطبوعة، عربية سليمة عبر html2canvas)
  const sheetsToPdf = async (sheets: { name: string; rows: Record<string, unknown>[] }[], title: string) => {
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const linksCol = tr('روابط مواقع الزيارات'); // عمود الروابط المجمّعة يُستبعد من PDF (يطول الصف)
    // المديونيات لحظية: لا نطبع نطاقاً ضُبط في تبويبٍ آخر على تقريرٍ لا يتأثر به
    const range = (tab === 'performance' && perfType === 'receivables')
      ? tr('لحظيّ — وقت الإصدار')
      : (from && to) ? `${from} — ${to}` : tr('كل الفترات');
    const tables = sheets.map(sh => {
      const cols = (sh.rows.length ? Object.keys(sh.rows[0]) : []).filter(c => c !== linksCol);
      const thead = `<tr>${cols.map(c => `<th style="border:1px solid #ddd;padding:6px 8px;background:#FAF7F0;font-size:11px;text-align:right;font-weight:700">${esc(c)}</th>`).join('')}</tr>`;
      const tbody = sh.rows.map(r => `<tr>${cols.map(c => `<td style="border:1px solid #eee;padding:5px 8px;font-size:11px;text-align:right;word-break:break-word">${esc(r[c])}</td>`).join('')}</tr>`).join('');
      return `<h3 style="font-size:13px;margin:16px 0 6px;color:#1F1A13">${esc(sh.name)}</h3><table style="width:100%;border-collapse:collapse;table-layout:fixed">${thead}${tbody}</table>`;
    }).join('');
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-99999px;top:0;width:780px;background:#fff;padding:24px;font-family:Tahoma,Arial,sans-serif;direction:rtl';
    el.innerHTML = `<div style="border-bottom:2px solid #E15A30;padding-bottom:10px;margin-bottom:8px"><h2 style="font-size:18px;margin:0;color:#1F1A13">${esc(title)}</h2><p style="font-size:12px;color:#6E6557;margin:4px 0 0">${esc(tr('الفترة'))}: ${esc(range)} · ${esc(tr('تاريخ الإصدار'))}: ${esc(new Date().toLocaleDateString('ar'))}</p></div>${tables}`;
    document.body.appendChild(el);
    try {
      const blob = await elementToPdfBlob(el);
      const out = await shareOrDownloadPdf(blob, `${safeName(title)}-${day()}.pdf`);
      toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
    } catch { toast.error(tr('تعذّر إنشاء PDF')); }
    finally { el.remove(); }
  };

  // تصدير PDF للتبويب النشط
  const handleExportPdf = async () => {
    const built = buildSheets();
    if (!built) { toast.error(tr('لا توجد بيانات للتصدير')); return; }
    await sheetsToPdf(built.sheets, built.fname);
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
    { name: tr('الحضور اليومي'), colWidths: [12, 12, 12, 14, 14, 12, 16],
      rows: r.days.map(d => ({
        [tr('التاريخ')]: d.date,
        [tr('بداية العمل')]: d.absent ? tr('لا نشاط') : fmtClock(d.firstActivity),
        [tr('نهاية العمل')]: d.absent ? tr('لا نشاط') : fmtClock(d.lastActivity),
        [tr('إجمالي وقت العمل')]: d.absent ? '—' : fmtMin(d.spanMinutes),
        [tr('نشاط التطبيق')]: d.absent ? '—' : fmtMin(d.appMinutes),
        [tr('عدد الزيارات')]: d.visitsCount,
        [tr('وقت داخل الزيارات')]: fmtVisitDur(d.visitsSec) || '—',
      })) },
    { name: tr('تفاصيل الزيارات'), colWidths: [12, 24, 12, 12, 12, 12, 16],
      rows: r.days.flatMap(d => d.visits.map(v => ({
        [tr('التاريخ')]: d.date, [tr('اسم العميل')]: v.customerName,
        [tr('بداية الزيارة')]: fmtClock(v.start),
        [tr('نهاية الزيارة')]: v.end ? fmtClock(v.end) : tr('بلا توقيت'),
        [tr('مدة الزيارة')]: fmtVisitDur(v.durationSec) || tr('بلا توقيت'),
        [tr('ملاحظة/صور')]: v.hasNote ? tr('نعم') : '',
        [tr('إجمالي وقت العمل لليوم')]: fmtMin(d.spanMinutes),
      }))) },
  ];
  const exportRepPerf = async (r: PerfRow) => {
    const out = await shareOrDownloadExcel(repPerfSheets(r), `${tr('أداء')}-${safeName(r.name)}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepPerfPdf = (r: PerfRow) => sheetsToPdf(repPerfSheets(r), `${tr('أداء')} - ${r.name}`);
  const exportRepHours = async (r: WorkHoursRow) => {
    const out = await shareOrDownloadExcel(repHoursSheets(r), `${tr('ساعات العمل')}-${safeName(r.name)}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepHoursPdf = (r: WorkHoursRow) => sheetsToPdf(repHoursSheets(r), `${tr('ساعات العمل')} - ${r.name}`);
  // تصدير مديونيات مندوب واحد (باسمه) — الورقة نفسها التي يراها على الشاشة
  const repRecvSheets = (r: RecvRow) => [{
    name: tr('مديونيات المندوب'), colWidths: [24, 20, 16, 14, 14, 16],
    rows: r.customers.map(c => ({
      [tr('العميل')]: c.name, [tr('النشاط التجاري')]: c.businessName || '', [tr('الجوال')]: c.phone,
      [tr('المدينة')]: c.city || '', [tr('الرصيد')]: num(c.balance),
      [tr('آخر تحصيل')]: c.lastPaymentAt ? fmtDay(c.lastPaymentAt) : tr('لم يُحصَّل قط'),
    })),
  }];
  const exportRepRecv = async (r: RecvRow) => {
    const out = await shareOrDownloadExcel(repRecvSheets(r), `${tr('مديونيات')}-${safeName(r.name)}-${day()}`);
    toast.success(out === 'shared' ? tr('تمت المشاركة') : tr('تم التصدير'));
  };
  const exportRepRecvPdf = (r: RecvRow) => sheetsToPdf(repRecvSheets(r), `${tr('مديونيات')} - ${r.name}`);

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{tr('التقارير')}</h1>
        <div className="flex items-center gap-2">
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
            <p className="text-xs text-gray-400 pb-2">{tr('الأرصدة لحظية — تعكس وضع المديونية الآن لا فترة محددة.')}</p>
          )}
          {/* البحث: يظهر حيث يوجد ما يُصفّى — تبويب التحصيل ملخّصٌ بلا صفوف */}
          {tab !== 'collections' && (
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
              <label className="label">{tr('تجميع حسب')}</label>
              <select className="input w-36" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
                <option value="rep">{tr('المندوب')}</option>
                <option value="customer">{tr('العميل')}</option>
                <option value="product">{tr('الصنف')}</option>
                <option value="channel">{tr('القناة')}</option>
                <option value="region">{tr('المنطقة')}</option>
              </select>
            </div>
          )}
          {tab === 'performance' && (
            <div>
              <label className="label">{tr('نوع التقرير')}</label>
              <select className="input w-44" value={perfType} onChange={e => setPerfType(e.target.value as 'performance' | 'hours' | 'receivables')}>
                <option value="performance">{tr('أداء المندوب')}</option>
                <option value="hours">{tr('ساعات العمل')}</option>
                <option value="receivables">{tr('مديونيات المندوب')}</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* حصيلة البحث: بلا هذا السطر يبدو الفراغُ الناتج عن بحثٍ ضيّق كأنه
          غيابُ بيانات — وهي رسالةٌ مختلفة تماماً تدفع المشرف لمطاردة عطلٍ لا وجود له. */}
      {q && (() => {
        const shown = tab === 'sales' ? (Array.isArray(salesRows) ? salesRows.length : 0)
          : tab === 'balances' ? balanceRows.length
          : perfType === 'performance' ? perfRows.length
          : perfType === 'hours' ? hoursRows.length
          : (recvRows?.length ?? 0);
        return (
          <div className={`mb-4 rounded-xl px-4 py-2.5 text-sm border ${shown ? 'bg-[#FAF7F0] border-[#F1EBDF] text-[#6E6557]' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
            {shown
              ? <>{tr('نتائج البحث عن')} «<b>{search}</b>»: {shown} {tr('سجلّ')} — {tr('التصدير يشمل المعروض فقط')}</>
              : <>{tr('لا نتائج مطابقة للبحث')} «<b>{search}</b>»</>}
            <button onClick={() => setSearch('')} className="ms-2 underline font-semibold">{tr('مسح البحث')}</button>
          </div>
        );
      })()}

      {/* Sales Report */}
      {tab === 'sales' && (
        <div className="space-y-4">
          {salesLoading ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('جاري التحميل...')}</div>
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
                      {(salesRows as { name: string; total: number; count?: number; qty?: number; code?: string }[]).map((row, i) => (
                        <tr key={i}>
                          <td className="font-medium text-gray-800">{displayName(row.name)}</td>
                          <td className="text-gray-600">{row.count ?? row.qty ?? '-'}</td>
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
            {Object.entries(collectData.summary.byMethod).map(([m, v]) => (
              <div key={m} className="card text-center">
                <p className="text-xs text-gray-500">{m === 'CASH' ? tr('نقدي') : m === 'BANK_TRANSFER' ? tr('تحويل') : m === 'POS' ? tr('شبكة') : tr('شيك')}</p>
                <p className="text-lg font-bold text-gray-700">{formatCurrency(v)}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Balances Report */}
      {tab === 'balances' && balanceRows && (
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
          {/* مفتاح الألوان — سأل المالك «هل الأخضر بداية والأحمر نهاية؟»، وما
              لا يُشرح يُخمَّن. الشرح هنا أرخص من تخمينٍ يُبنى عليه قرار. */}
          <div className="card py-3">
            <div className="flex items-center gap-x-5 gap-y-2 flex-wrap text-xs text-[#6E6557]">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#E7F5EE] border border-[#1E7A52]" /> {tr('بداية العمل')}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#FBEBE2] border border-[#C0392B]" /> {tr('نهاية العمل')}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#EAF3FB] border border-[#2E6FB0]" /> {tr('وقت داخل الزيارات')}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-[#F1EBDF] border border-[#B3A996]" /> {tr('يوم بلا نشاط')}</span>
              <span className="text-[#9A8F7E]">· {tr('انقر على أي يوم لعرض زياراته')}</span>
            </div>
            <p className="text-[11px] text-[#9A8F7E] mt-2 leading-relaxed">
              {tr('«إجمالي وقت العمل» يُقاس من أول نشاط مرصود في اليوم (موقع أو فتح تطبيق أو زيارة) إلى آخره — أقرب مقياس متاح لخروج المندوب وعودته. و«نشاط التطبيق» هو الوقت الذي كان فيه التطبيق مفتوحاً ومتصلاً فقط.')}
            </p>
          </div>

          {hoursStatus === 'pending' ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">
              {hoursFetchStatus === 'paused' ? tr('بانتظار عودة الاتصال...') : tr('جاري التحميل...')}
            </div>
          ) : hoursStatus === 'error' ? (
            <div className="card flex items-center justify-center h-32 text-red-500">{tr('تعذّر تحميل التقرير')}</div>
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
                        <th>{tr('التاريخ')}</th><th>{tr('بداية العمل')}</th><th>{tr('نهاية العمل')}</th>
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
                            <td className="tabular-nums text-xs">
                              {d.date}
                              {d.visitsCount > 0 && <span className="ms-1 text-[#9A8F7E]">{openDay === `${r.id}|${d.date}` ? '▲' : '▾'}</span>}
                            </td>
                            {d.absent ? (
                              <td colSpan={6} className="text-center text-xs">{tr('لا نشاط مسجّل في هذا اليوم')}</td>
                            ) : (
                              <>
                                <td><span className="inline-block rounded px-2 py-0.5 text-xs font-bold tabular-nums bg-[#E7F5EE] text-[#1E7A52]">{fmtClock(d.firstActivity)}</span></td>
                                <td><span className="inline-block rounded px-2 py-0.5 text-xs font-bold tabular-nums bg-[#FBEBE2] text-[#C0392B]">{fmtClock(d.lastActivity)}</span></td>
                                <td className="font-bold text-[#1F1A13] tabular-nums">{fmtMin(d.spanMinutes)}</td>
                                <td className="text-gray-600 tabular-nums">{fmtMin(d.appMinutes)}</td>
                                <td className="tabular-nums">{d.visitsCount}</td>
                                <td className="tabular-nums text-[#2E6FB0] font-semibold">{fmtVisitDur(d.visitsSec) || '—'}</td>
                              </>
                            )}
                          </tr>
                          {openDay === `${r.id}|${d.date}` && d.visits.length > 0 && (
                            <tr>
                              <td colSpan={7} className="bg-[#FDFBF7] p-0">
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>{tr('اسم العميل')}</th><th>{tr('بداية الزيارة')}</th>
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
            <div className="card flex items-center justify-center h-32 text-gray-400">{tr('لا توجد بيانات حضور في هذه الفترة.')}</div>
          )}
        </div>
      )}

      {/* تقرير مديونيات المندوب — رصيد كل عميل مُسنَد، ليُقرأ تقصير التحصيل ويُصدَّر */}
      {tab === 'performance' && perfType === 'receivables' && (
        <div className="space-y-4">
          {recvStatus === 'pending' ? (
            <div className="card flex items-center justify-center h-32 text-gray-400">
              {recvFetchStatus === 'paused' ? tr('بانتظار عودة الاتصال...') : tr('جاري التحميل...')}
            </div>
          ) : recvStatus === 'error' ? (
            /* فشل الجلب ليس «لا عملاء مُسنَدين»: عرضُ الفراغ كحقيقةٍ يطمئن المشرف كذباً */
            <div className="card flex flex-col items-center justify-center h-32 text-gray-400 gap-2">
              <p className="text-red-500">{tr('تعذّر تحميل التقرير')}</p>
              <button onClick={() => recvRefetch()} className="text-xs font-semibold text-[#E15A30] underline">{tr('إعادة المحاولة')}</button>
            </div>
          ) : recvRows && recvRows.some(r => r.customersCount > 0) ? (
            recvRows.map(r => (
              <div key={r.id} className="card p-0 overflow-hidden">
                <div className="flex items-center justify-between flex-wrap gap-2 px-4 py-3 bg-[#FAF7F0] border-b border-[#F1EBDF]">
                  <div className="flex items-center gap-3 flex-wrap">
                    <p className="font-bold text-[#1F1A13]">{r.name}</p>
                    <span className="text-xs text-gray-500">{r.customersCount} {tr('عميل مُسنَد')} · {tr('المدينون')}: {r.debtorsCount}</span>
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
                  <p className="text-center text-xs text-gray-400 py-4">{tr('لا عملاء مُسنَدين لهذا المندوب')}</p>
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
                            <td className="text-xs text-gray-500">{c.lastPaymentAt ? fmtDay(c.lastPaymentAt) : <span className="text-orange-500 font-medium">{tr('لم يُحصَّل قط')}</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))
          ) : (
            <div className="card flex flex-col items-center justify-center h-36 text-gray-400 gap-1">
              <p>{tr('لا عملاء مُسنَدين للمناديب بعد.')}</p>
              <p className="text-xs">{tr('أسنِد العملاء لمناديبهم من صفحة المناديب لتظهر مديونياتهم هنا.')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
