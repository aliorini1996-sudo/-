import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { warehouseApi, productApi, companyApi, repStockRequestApi } from '../api/client';
import { formatDate, formatCurrency, formatDayOnly } from '../utils/format';
import { useTr } from '../i18n/strings';
import SearchableSelect from '../components/SearchableSelect';
import { Warehouse, PackagePlus, X, Trash2, TrendingUp, TrendingDown, AlertTriangle, Calendar, ArrowRightLeft, Wallet, Info, FileDown, ClipboardList, Truck, Layers, ChevronDown, ChevronUp, CopyPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import DocumentModal from '../components/DocumentModal';
import StockRequestModal from '../components/StockRequestModal';
import { warehouseNoticeDocFromEntry, Company } from '../rep/RepDocuments';
import { useAuthStore } from '../store/authStore';
import { baseQtyText, biggestUnit, hasBigUnit } from '../lib/adminUnits';
import { choiceById, defaultChoice, unitChoices } from '../rep/repUnits';
import type { UnitDef } from '../lib/units';
import {
  LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS, LOT_WARNING_LABELS, isLotExpiredOn, lotDay, lotErrorOf, lotFlagsOf, lotWarningsOf, roundLot, toBaseQty,
} from '../lib/lots';
import {
  emptyEntryLot, entryLotFields, entryLotProblem, lotRowSummary, newRowId, normalizeEntryLot, outSourcesOf, shelfLifeOn,
  type EntryLotDraft, type EntryLotKind, type PlaceViewWithAvailability,
} from '../lib/stockLots';
import { EntryLotFields, fetchLotBalances, fmtLotQty } from '../components/StockLotFields';

/*
 * الوحدات المتعددة: أرصدة المستودع كلّها **بوحدة الأساس** (`unit`) وتُعرض «٢ كرتون و٣ حبة» من `units`، ومتوسّط التكلفة
 * لوحدة الأساس (الحبة لا الكرتون). وسطر الوارد بوحدته وسعرها كما في فاتورة المورّد («١٠ كرتون بـ٤٨ للكرتون») —
 * الخادم يحلّ `unitId` إلى معامله ويقسم التكلفة عليه عند التقييم. وسجلّ الوارد يقرأ لقطة وحدة كل سطر.
 *
 * «تتبّع اللوط» (W2، يفعّله المالك لكل شركة): سطر الوارد لصنفٍ متتبَّع بتشغيلته (الرقم وتاريخا الإنتاج والانتهاء)، وللصنف
 * أكثر من سطرٍ لدفعتين؛ والتسوية بمصدرٍ صريح؛ وصفّ الرصيد يتوسّع بتشغيلاته والمعزول والعجز (ومع «المخزون في تاريخ»).
 * الميزة مطفأة ⇒ لا جلب ولا عمود ولا تغيير مرئي (§١٠.١).
 */

interface WhRow {
  productId: string; name: string; code: string; unit: string;
  /** وحدات الصنف — لعرض الأرصدة بالأساس مفكَّكة، لا لحسابها */
  units?: UnitDef[];
  received: number; adjusted: number; loadedToVans: number; returnedFromVans: number; onHand: number;
  avgCost: number;     // متوسّط تكلفة **وحدة الأساس** (متحرّك، على الرصيد الباقي)
  costedQty: number;   // كمية من الرصيد تكلفتها معروفة — هي وحدها المقيَّمة
  stockValue: number;  // قيمة الرصيد بتكلفة الشراء
  uncostedQty: number; // كمية واردة بلا سعر — حدّ صدق التقييم
}
interface WhEntry {
  id: string; type: string; note: string | null; supplier: string | null; createdBy: string | null; createdAt: string;
  // lineCost: قيمة السطر كما قرّبها الخادم — للإشعار المطبوع، مجموعها = totalCost.
  // unitName/unitFactor لقطة وحدة السطر: الكمية وتكلفة الوحدة بها (الكرتون كرتوناً)
  // lot: تشغيلة السطر («تتبّع اللوط»، والميزة مفعّلة وحدها)
  items: {
    id: string; qty: number; unitName?: string | null; unitFactor?: number | null; baseQty?: number | null; unitCost: number | null; lineCost?: number | null;
    product: { name: string; unit: string };
    lot?: { lotNumber: string; productionDate: string | null; expiryDate: string | null } | null;
  }[];
  totalCost: number; // يحسبه الخادم بالدالّة المختبَرة — لا يُعاد حسابه هنا
}
/** صنفٌ كما يردّه /products — حقول اللوط والصلاحية لسطر الوارد */
interface ProductPick {
  id: string; name: string; unit: string; code: string; taxPct: number; units?: UnitDef[];
  lotTracked?: boolean; shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null;
}

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

/** ما في مخزون السيارات الآن (GET /warehouse/vans) — الرصيد المتاح وقيمته بكلفة خروجه من المستودع */
interface VansStock {
  qty: number; value: number; uncostedQty: number; unsellableQty: number; reps: number; products: number; deletedVans?: number;
  /** «تتبّع اللوط»: المعزول (تشغيلة موقوفة أو منتهية لم تُبع) والمحجوز (إشعار قياسي بانتظار الاعتماد) — داخلان في المتاح ولا يُباعان */
  lotQuarantined?: number; lotHeld?: number;
}

/** أرصدة تشغيلات أصناف المستودع المتتبَّعة — عرض المستودع وحده بالصنف، ويوم القياس من الخادم */
async function fetchWarehouseLots(ids: string[], asOf: string): Promise<{ day: string; views: Map<string, PlaceViewWithAvailability> }> {
  const r = await fetchLotBalances(ids, asOf);
  return { day: r.day, views: new Map(r.warehouse.map(v => [v.productId, v])) };
}

// مخزون الشركة (المستودع المركزيّ) — مرتبطٌ بمخزون السيارات:
// التحميل يخرج من المستودع، والتنزيل يعود إليه، والوارد يزيده.
export default function CompanyWarehousePage() {
  const tr = useTr();
  const [showEntry, setShowEntry] = useState(false);
  // نافذة «طلب مخزون» لإدارة المشتريات أو الإنتاج
  const [showRequest, setShowRequest] = useState(false);
  const me = useAuthStore(s => s.user);
  // الحركة المعروض إشعارها الآن
  const [noticeOf, setNoticeOf] = useState<WhEntry | null>(null);
  // صفّ الرصيد الموسَّع بتشغيلاته
  const [openLots, setOpenLots] = useState<string | null>(null);
  // إعدادات الشركة لترويسة الإشعار — المفتاح نفسه الذي تقرؤه القوقعة
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as Company | null,
    staleTime: 300_000,
  });
  // «تتبّع اللوط» من /company — نسخةٌ بلا العلم تُعامَل إطفاءً
  const lotOn = lotFlagsOf(companyQ.data as { lotTrackingEnabled?: unknown } | null | undefined).on;

  // المستودع كميّاتٌ وتكلفةٌ وقيمة مخزون: يُمنع كلّه مع المحاسبة
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();

  const stockQ = useQuery({
    queryKey: ['warehouse-stock'],
    queryFn: async () => (await warehouseApi.stock()).data.data as WhRow[],
    enabled: accountingReady && accountingOn,
  });
  /* «المخزون في تاريخ» (طلب المالك ١٨ أكتوبر ٢٠٢٦): '' الآن، أو يومٌ مضى فتُعرض قيمة المستودع وما في السيارات وجدول الأرصدة
   * كما كانت في نهاية يومه. ونافذة «طلب مخزون» وتنبيه «يحتاج استلام» على رصيد اليوم دائماً — الطلب يُبنى على الحاضر */
  const [asOf, setAsOf] = useState('');
  const today = new Date().toLocaleDateString('en-CA');
  const asOfQ = useQuery({
    queryKey: ['warehouse-stock', asOf],
    queryFn: async () => (await warehouseApi.stock(asOf)).data.data as WhRow[],
    enabled: accountingReady && accountingOn && !!asOf,
  });
  // بطاقة «في مخزون السيارات» بجانب قيمة المستودع (طلب المالك ١٨ أكتوبر ٢٠٢٦)
  const vansQ = useQuery({
    queryKey: ['warehouse-vans', asOf],
    queryFn: async () => (await warehouseApi.vans(asOf || undefined)).data.data as VansStock,
    enabled: accountingReady && accountingOn,
  });
  const vans = vansQ.data;
  const entriesQ = useQuery({
    queryKey: ['warehouse-entries'],
    queryFn: async () => (await warehouseApi.entries()).data.data as WhEntry[],
    enabled: accountingReady && accountingOn,
  });

  // طلبات بضاعة المناديب المعلّقة — المفتاح نفسه الذي تقرؤه نافذة «طلب مخزون»، وعددها شارةٌ على زرّها
  const repReqQ = useQuery({
    queryKey: ['rep-stock-requests'],
    queryFn: async () => (await repStockRequestApi.pending()).data.data as unknown[],
    enabled: accountingReady && accountingOn,
  });
  const pendingRepRequests = repReqQ.data?.length ?? 0;

  // «تتبّع اللوط»: الأصناف المتتبَّعة (علم الصنف) — تُجلب والميزة مفعّلة وحدها، بمفتاح قائمة الأصناف نفسه في نافذة الوارد
  const prodQ = useQuery({
    queryKey: ['products-min'],
    queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductPick[],
    enabled: accountingReady && accountingOn && lotOn,
  });
  const trackedSet = new Set(lotOn ? (prodQ.data ?? []).filter(p => p.lotTracked === true).map(p => p.id) : []);

  const rows = stockQ.data || [];
  const lowCount = rows.filter(r => r.onHand <= 0).length;
  // المعروض في البطاقتين والجدول: رصيد التاريخ المختار أو الآن
  const shownRows = asOf ? (asOfQ.data ?? []) : rows;
  const shownLoading = asOf ? asOfQ.isLoading : stockQ.isLoading;
  // فشل الطلب لا يُعرض صفراً: «تعذر تحميل الأرصدة» بدل قيمةٍ خاطئة تحت عنوان التاريخ
  const shownError = asOf ? asOfQ.isError : stockQ.isError;
  // قيمة المخزون بتكلفة الشراء — ومعها حدّ صدقها: كم صنفا وارده بلا سعر
  const totalValue = shownRows.reduce((s, r) => s + r.stockValue, 0);
  const uncostedRows = shownRows.filter(r => r.uncostedQty > 0).length;

  // أرصدة التشغيلات لأصناف الجدول المتتبَّعة، في التاريخ المختار أو الآن
  const trackedIds = shownRows.filter(r => trackedSet.has(r.productId)).map(r => r.productId).sort();
  const lotsQ = useQuery({
    queryKey: ['lot-balances-wh', asOf, trackedIds.join(',')],
    queryFn: () => fetchWarehouseLots(trackedIds, asOf),
    enabled: lotOn && trackedIds.length > 0,
  });
  const lotDayNow = lotsQ.data?.day ?? today;
  // المعزول والمحجوز في السيارات (§٤.٤ البند ٧) يُضافان إلى «لا يُباع»
  const vansLotUnsellable = lotOn ? roundLot((vans?.lotQuarantined ?? 0) + (vans?.lotHeld ?? 0)) : 0;

  if (!accountingReady) return null;
  if (!accountingOn) return <AccountingOffNotice />;

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-[#1F1A13] flex items-center gap-2"><Warehouse size={22} className="text-[#E15A30]" /> {tr('مخزون الشركة')}</h1>
          <p className="text-xs text-[#9A8F7E] mt-1">{tr('المستودع المركزي التحميل يخرج منه والتنزيل يعود إليه والوارد يزيده')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setShowRequest(true)} disabled={rows.length === 0 && pendingRepRequests === 0}
            title={tr('طلب مخزون')} className="btn-secondary disabled:opacity-50 relative">
            <ClipboardList size={17} className="text-[#E15A30]" /> {tr('طلب مخزون')}
            {pendingRepRequests > 0 && (
              <span title={tr('طلبات المناديب')} className="absolute -top-2 -start-2 min-w-[20px] h-5 px-1 rounded-full bg-[#E15A30] text-white text-[11px] font-bold flex items-center justify-center">{pendingRepRequests}</span>
            )}
          </button>
          <button onClick={() => setShowEntry(true)} className="btn-primary"><PackagePlus size={17} /> {tr('استلام / تسوية')}</button>
        </div>
      </div>

      {/* قيمة المخزون بتكلفة الشراء — الغرض من تسجيل سعر الوحدة عند الاستلام */}
      {rows.length > 0 && (
        <div className="card px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><Wallet size={20} /></span>
            <div>
              <p className="text-xs text-[#9A8F7E]">{tr('قيمة المخزون بتكلفة الشراء')}</p>
              <p className={`text-xl font-extrabold text-[#1F1A13] ${shownLoading ? 'opacity-40' : ''}`}>
                {shownError ? <span className="text-sm text-red-600">{tr('تعذر تحميل الأرصدة')}</span> : formatCurrency(totalValue)}
              </p>
            </div>
          </div>
          {/* «المخزون في تاريخ»: البطاقتان والجدول كما كانت في نهاية اليوم المختار */}
          <div className="flex flex-col items-center gap-1">
            <label htmlFor="wh-as-of" className="text-xs text-[#9A8F7E] flex items-center gap-1"><Calendar size={13} /> {tr('المخزون في تاريخ')}</label>
            <div className="flex items-center gap-2">
              <input id="wh-as-of" type="date" className="input py-1.5 text-sm w-40" value={asOf} max={today}
                onChange={e => setAsOf(e.target.value && e.target.value < today ? e.target.value : '')} />
              {asOf && (
                <button type="button" onClick={() => setAsOf('')} className="text-xs text-[#E15A30] font-semibold whitespace-nowrap">{tr('عودة إلى اليوم')}</button>
              )}
            </div>
            {asOf && <p className="text-[11px] text-[#9A8F7E]">{tr('الأرصدة كما في نهاية يوم')} {formatDayOnly(asOf)}</p>}
          </div>
          {uncostedRows > 0 && (
            <p className="text-[11px] text-[#9A8F7E] flex items-center gap-1.5 max-w-sm">
              <Info size={13} className="shrink-0 text-amber-600" />
              {uncostedRows} {tr('صنفا فيه كمية بلا تكلفة معروفة وهي خارج هذه القيمة سجل سعر الوحدة عند الاستلام ليكتمل التقييم')}
            </p>
          )}
          {/* ما في مخزون السيارات: الكمية المتاحة للبيع وقيمتها بكلفة خروجها من المستودع — رابطٌ إلى مخزون السيارات */}
          {vans && (
            <Link to="/app/van-stock" title={tr('مخزون السيارات')}
              className="flex items-center gap-3 rounded-xl border border-[#F1EBDF] bg-[#FAF7F0] px-4 py-2.5 hover:border-[#E15A30]/40 transition-colors">
              <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><Truck size={20} /></span>
              <div>
                <p className="text-xs text-[#9A8F7E]">{tr('في مخزون السيارات')}</p>
                {/* مجموعٌ عبر الأصناف بوحدات الأساس (الخادم) — حبّاتٌ لا كراتين لصنفٍ له وحدات */}
                <p className={`text-lg font-extrabold text-[#1F1A13] leading-tight ${vansQ.isFetching && !vansQ.isLoading ? 'opacity-40' : ''}`}
                  title={tr('مجموع بوحدات الأساس')}>
                  {fmtQty(vans.qty)} <span className="text-xs font-semibold text-[#6E6557]">{tr('وحدة')}</span>
                  <span className="text-[#C9BFAE] mx-1.5">·</span>
                  {formatCurrency(vans.value)}
                </p>
                <p className="text-[11px] text-[#9A8F7E]">
                  {vans.reps} {tr('سيارة')} · {vans.products} {tr('صنف')}
                  {vans.uncostedQty > 0 && <> · {fmtQty(vans.uncostedQty)} {tr('بلا تكلفة معروفة خارج القيمة')}</>}
                  {vans.unsellableQty > 0 && <> · {fmtQty(vans.unsellableQty)} {tr('تالف أو منتهي لا يباع')}</>}
                </p>
                {/* «تتبّع اللوط»: تشغيلاتٌ معزولة أو محجوزة في السيارات — ضمن المتاح أعلاه ولا تُباع */}
                {vansLotUnsellable > 0 && (
                  <p className="text-[11px] text-amber-700">
                    {fmtQty(vansLotUnsellable)} {tr('في تشغيلات معزولة أو محجوزة لا يباع')}
                    {(vans.lotHeld ?? 0) > 0 && <> ({fmtQty(vans.lotHeld ?? 0)} {tr('بانتظار الاعتماد')})</>}
                  </p>
                )}
                {(vans.deletedVans ?? 0) > 0 && (
                  <p className="text-[11px] text-amber-700">{vans.deletedVans} {tr('سيارة لمندوب محذوف لا تعرف بضاعتها فلا تدخل هنا')}</p>
                )}
              </div>
            </Link>
          )}
        </div>
      )}

      {lowCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle size={16} /> {lowCount} {tr('صنفا برصيد صفر أو سالب يحتاج استلام بضاعة')}
        </div>
      )}

      {/* جدول الرصيد */}
      <div className="card p-0 overflow-hidden">
        {shownLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : shownError ? (
          <div className="p-8 text-center text-red-600 text-sm">{tr('تعذر تحميل الأرصدة')}</div>
        ) : shownRows.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد أصناف أضف منتجات ثم سجل استلام بضاعة')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[#FAF7F0] text-[#6E6557] text-xs">
                  <th className="text-start font-semibold px-4 py-2.5">{tr('الصنف')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('الرصيد بالمستودع')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('الوارد')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('خرج للسيارات')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('عاد منها')}</th>
                  {/* لوحدة الأساس (الخادم: avgCost للحبة) — «متوسط تكلفة الوحدة» كان يُقرأ سعر كرتون */}
                  <th className="text-center font-semibold px-3 py-2.5">{tr('متوسط التكلفة لوحدة الأساس')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('قيمة الرصيد')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EBDF]">
                {shownRows.map(r => {
                  const big = biggestUnit(r.units);
                  const tracked = trackedSet.has(r.productId);
                  const view = tracked ? lotsQ.data?.views.get(r.productId) : undefined;
                  const sum = tracked ? lotRowSummary(view, lotDayNow) : null;
                  const open = tracked && openLots === r.productId;
                  return (
                  <Fragment key={r.productId}>
                  <tr className={r.onHand < 0 ? 'bg-red-50/40' : undefined}>
                    <td className="px-4 py-2.5">
                      <div className="font-semibold text-[#1F1A13]">{r.name}</div>
                      <div className="text-[11px] text-[#9A8F7E]">{r.code} · {hasBigUnit(r.units) ? `${tr('وحدة الأساس')} ${r.unit}` : r.unit}</div>
                      {/* «تتبّع اللوط»: شاراتُ التشغيلات ومفتاح توسيع الصفّ بها */}
                      {tracked && (
                        <button type="button" onClick={() => setOpenLots(open ? null : r.productId)}
                          className="mt-1 inline-flex items-center gap-1 flex-wrap text-[10px] font-semibold text-[#6E6557] hover:text-[#E15A30]">
                          <Layers size={11} className="text-[#E15A30]" />
                          {sum ? `${sum.lots} ${tr('تشغيلة')}` : tr('التشغيلات')}
                          {sum && sum.quarantined > 0 && <span className="rounded bg-amber-50 border border-amber-200 text-amber-700 px-1">{tr('معزول')} {baseQtyText(sum.quarantined, r, fmtQty)}</span>}
                          {sum && sum.held > 0 && <span className="rounded bg-sky-50 border border-sky-200 text-sky-700 px-1">{tr('محجوز')} {baseQtyText(sum.held, r, fmtQty)}</span>}
                          {sum?.deficit && <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr('عجز')}</span>}
                          {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`font-extrabold ${r.onHand < 0 ? 'text-red-600' : r.onHand === 0 ? 'text-amber-600' : 'text-[#1E7A52]'}`}>{baseQtyText(r.onHand, r, fmtQty)}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center text-[#6E6557]">{baseQtyText(r.received + r.adjusted, r, fmtQty)}</td>
                    <td className="px-3 py-2.5 text-center text-[#C94E28]">−{baseQtyText(r.loadedToVans, r, fmtQty)}</td>
                    <td className="px-3 py-2.5 text-center text-[#1E7A52]">+{baseQtyText(r.returnedFromVans, r, fmtQty)}</td>
                    <td className="px-3 py-2.5 text-center text-[#6E6557]">
                      {r.avgCost > 0
                        ? <span title={String(r.avgCost)}>{formatCurrency(r.avgCost, undefined, 4)}</span>
                        : <span className="text-[#C9BFAE]">—</span>}
                      {/* وتكلفة أكبر وحدةٍ بجانبها (متوسّط الحبة × معامل الكرتون) — المالك يشتري بالكرتون ويقارن به */}
                      {r.avgCost > 0 && big && (
                        <span className="block text-[10px] text-[#9A8F7E] mt-0.5">{big.name}: {formatCurrency(r.avgCost * Number(big.factor), undefined, 4)}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {r.costedQty !== 0
                        ? <span className={`font-bold ${r.stockValue < 0 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{formatCurrency(r.stockValue)}</span>
                        : <span className="text-[#C9BFAE]">—</span>}
                      {r.uncostedQty > 0 && (
                        <span className="block text-[10px] text-amber-600 mt-0.5">
                          {baseQtyText(r.uncostedQty, r, fmtQty)} {tr('خارج التقييم')}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-[#FAF7F0]/60">
                      <td colSpan={7} className="px-4 py-3">
                        <WarehouseLotsDetail view={view} day={lotDayNow} loading={lotsQ.isLoading} error={lotsQ.isError} row={r} asOf={asOf} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* سجلّ الوارد والتسويات */}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <ArrowRightLeft size={16} className="text-[#E15A30]" /> {tr('سجل الوارد والتسويات')}
        </div>
        {entriesQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : (entriesQ.data || []).length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد حركات وارد بعد')}</div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto divide-y divide-[#F1EBDF]">
            {(entriesQ.data || []).map(e => (
              <div key={e.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1 ${e.type === 'RECEIVE' ? 'text-[#1E7A52] bg-green-50' : 'text-purple-600 bg-purple-50'}`}>
                    {e.type === 'RECEIVE' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {e.type === 'RECEIVE' ? tr('وارد') : tr('تسوية')}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-[11px] text-[#9A8F7E] flex items-center gap-1"><Calendar size={11} /> {formatDate(e.createdAt)}</span>
                    <button type="button" onClick={() => setNoticeOf(e)}
                      title={e.type === 'RECEIVE' ? tr('إشعار وارد PDF') : tr('إشعار تسوية PDF')}
                      aria-label={e.type === 'RECEIVE' ? tr('إشعار وارد PDF') : tr('إشعار تسوية PDF')}
                      className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700">
                      <FileDown size={15} />
                    </button>
                  </span>
                </div>
                {(e.supplier || e.note) && <p className="text-xs text-[#6E6557] mt-1.5">{[e.supplier, e.note].filter(Boolean).join(' · ')}</p>}
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {e.items.map(it => {
                    // لقطة وحدة السطر: «١٠ كرتون · ٤٨/كرتون» — وحدة الصنف اليوم (الأساس بعد التحويل) تنسب سعر الكرتون للحبة
                    const u = it.unitName || it.product.unit;
                    return (
                    <span key={it.id} className="text-[11px] bg-[#FAF7F0] border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
                      {it.product.name} <b className={it.qty < 0 ? 'text-red-600' : undefined}>{it.qty < 0 ? '−' : '+'}{fmtQty(Math.abs(it.qty))}</b> {u}
                      {it.unitCost != null && it.unitCost > 0 && (
                        <span className="text-[#6E6557]"> · {formatCurrency(it.unitCost)}/{u}</span>
                      )}
                      {/* «تتبّع اللوط»: تشغيلة السطر وانتهاؤها */}
                      {lotOn && it.lot && (
                        <span className="ms-1 inline-flex items-center gap-0.5 rounded bg-white border border-[#E9E1D3] px-1 text-[10px] text-[#6E6557]">
                          <Layers size={10} className="text-[#E15A30]" /> {it.lot.lotNumber}
                          {lotDay(it.lot.expiryDate) && <> · {tr('ينتهي')} {formatDayOnly(lotDay(it.lot.expiryDate))}</>}
                        </span>
                      )}
                    </span>
                    );
                  })}
                </div>
                {e.totalCost > 0 && (
                  <p className="text-[11px] text-[#6E6557] mt-1.5">
                    {tr('قيمة البضاعة قبل الضريبة')}: <b className="text-[#1F1A13]">{formatCurrency(e.totalCost)}</b>
                  </p>
                )}
                {e.createdBy && <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('سجلها')}: {e.createdBy}</p>}
              </div>
            ))}
          </div>
        )}
      </div>

      {showEntry && <WarehouseEntryModal lotOn={lotOn} onClose={() => setShowEntry(false)} />}

      {showRequest && (
        <StockRequestModal rows={rows} company={companyQ.data ?? null} by={me?.name}
          onClose={() => setShowRequest(false)} />
      )}

      {/* إشعار الحركة — يُبنى من الصفّ الذي في اليد بقيمه المحسوبة في الخادم، وتشغيلة كل سطرٍ معه والميزة مفعّلة */}
      {noticeOf && (
        <DocumentModal
          doc={withEntryLots(warehouseNoticeDocFromEntry(noticeOf, companyQ.data ?? null), noticeOf, lotOn)}
          onClose={() => setNoticeOf(null)} />
      )}
    </div>
  );
}

/** تشغيلة كل سطرٍ على إشعار الوارد (سطرٌ = تشغيلةٌ واحدة، كميتها بالأساس) — الميزة مطفأة أو السطر بلا تشغيلة ⇒ كما هو */
function withEntryLots<D extends { items: object[] }>(doc: D, entry: WhEntry, lotOn: boolean): D {
  if (!lotOn) return doc;
  return {
    ...doc,
    items: doc.items.map((it, i) => {
      const src = entry.items[i];
      if (!src?.lot) return it;
      return { ...it, lots: [{ lotNumber: src.lot.lotNumber, qty: roundLot(Math.abs(toBaseQty(src))), expiryDate: lotDay(src.lot.expiryDate) }] };
    }) as D['items'],
  };
}

/** تفصيل صفّ الرصيد بتشغيلاته في المستودع: الخام والصالح والمحجوز لكل تشغيلة، وغير المسمّى، والعجز */
function WarehouseLotsDetail({ view, day, loading, error, row, asOf }: {
  view: PlaceViewWithAvailability | undefined; day: string; loading: boolean; error: boolean;
  row: { unit: string; units?: UnitDef[] }; asOf: string;
}) {
  const tr = useTr();
  if (loading) return <p className="text-xs text-[#9A8F7E]">{tr('جار التحميل')}</p>;
  if (error) return <p className="text-xs text-red-600">{tr('تعذر تحميل الأرصدة')}</p>;
  if (!view) return <p className="text-xs text-[#9A8F7E]">{tr('لا تشغيلات لهذا الصنف في المستودع')}</p>;
  const lots = view.lots.filter(l => Math.abs(l.raw.SELLABLE) > 1e-6 || Math.abs(l.held.SELLABLE) > 1e-6);
  const unknown = view.unknown?.SELLABLE ?? 0;
  const q = (n: number) => baseQtyText(n, row, fmtLotQty);
  return (
    <div className="space-y-1.5">
      {asOf && <p className="text-[10px] text-[#9A8F7E]">{tr('الأرصدة كما في نهاية يوم')} {formatDayOnly(asOf)}</p>}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[#9A8F7E]">
            <th className="text-start font-semibold py-1">{tr('رقم التشغيلة')}</th>
            <th className="text-center font-semibold py-1">{tr('تاريخ الانتهاء')}</th>
            <th className="text-center font-semibold py-1">{tr('الحالة')}</th>
            <th className="text-center font-semibold py-1">{tr('الرصيد')}</th>
            <th className="text-center font-semibold py-1">{tr('محجوز')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#F1EBDF]">
          {lots.map(l => {
            const expired = isLotExpiredOn(l.meta, day);
            const blocked = l.meta.status === 'BLOCKED';
            return (
              <tr key={l.lotId}>
                <td className="py-1 font-semibold text-[#1F1A13]">{l.meta.lotNumber}</td>
                <td className={`py-1 text-center ${expired ? 'text-red-600 font-semibold' : 'text-[#6E6557]'}`}>{l.meta.expiryDate ? formatDayOnly(l.meta.expiryDate) : '—'}</td>
                <td className="py-1 text-center">
                  {blocked
                    ? <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr(l.meta.blockKind ? LOT_BLOCK_KIND_LABELS[l.meta.blockKind] : LOT_STATUS_LABELS.BLOCKED)}</span>
                    : expired ? <span className="rounded bg-amber-50 border border-amber-200 text-amber-700 px-1">{tr('منتهية')}</span>
                      : <span className="text-[#1E7A52]">{tr(LOT_STATUS_LABELS.ACTIVE)}</span>}
                </td>
                <td className={`py-1 text-center font-bold ${l.usable.SELLABLE < -1e-6 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{q(l.usable.SELLABLE)}</td>
                <td className="py-1 text-center text-[#6E6557]">{Math.abs(l.held.SELLABLE) > 1e-6 ? q(l.held.SELLABLE) : '—'}</td>
              </tr>
            );
          })}
          {Math.abs(unknown) > 1e-6 && (
            <tr>
              <td className="py-1 font-semibold text-[#6E6557]">{tr('غير مسمى')}</td>
              <td className="py-1 text-center text-[#9A8F7E]">—</td>
              <td className="py-1 text-center">{unknown < 0 && <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr('عجز غير مسمى')}</span>}</td>
              <td className={`py-1 text-center font-bold ${unknown < 0 ? 'text-red-600' : 'text-[#6E6557]'}`}>{q(unknown)}</td>
              <td className="py-1 text-center text-[#9A8F7E]">—</td>
            </tr>
          )}
        </tbody>
      </table>
      {view.deficits.some(d => d.lotId !== null && d.qty < -1e-6) && (
        <p className="text-[10px] text-red-600 flex items-center gap-1"><AlertTriangle size={11} /> {tr('رصيد سالب في تشغيلة راجع الحركات أو صححه بتسوية')}</p>
      )}
    </div>
  );
}

/** سطر نافذة الوارد: مفتاحه rowId لا الصنف — صنفٌ متتبَّع في سطرين لدفعتين بتشغيلتين */
interface EntryRow { rowId: string; productId: string; name: string; unit: string; unitId: string | null; qty: string; unitCost: string; lot: EntryLotDraft }

// نموذج تسجيل وارد (استلام/شراء) أو تسوية للمستودع
function WarehouseEntryModal({ onClose, lotOn }: { onClose: () => void; lotOn: boolean }) {
  const qc = useQueryClient();
  const tr = useTr();
  const [type, setType] = useState<'RECEIVE' | 'ADJUST'>('RECEIVE');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  // الوحدات المتعددة: صفٌّ لكل صنف بوحدةٍ تُختار عليه — الكمية **وسعر الوحدة** بها («١٠ كرتون بـ٤٨ للكرتون» كما في
  // فاتورة المورّد)، و`unitId` (null = الأساس) يحلّه الخادم إلى معامله. والتسوية بالوحدة نفسها زيادةً أو نقصاً.
  // «تتبّع اللوط»: الصنف المتتبَّع يجوز له أكثر من صفّ (دفعتان بتشغيلتين)، فالفهرسة بـrowId
  const [rows, setRows] = useState<EntryRow[]>([]);
  // فاتورة المورّد تعلن السعر شاملاً الضريبة غالباً؛ المؤشّر يخبر الخادم فيردّه
  // إلى صافيه قبل الحفظ — فيبقى العمود بمعنى واحد مهما اختلفت عادة المورّدين
  const [costsIncludeTax, setCostsIncludeTax] = useState(false);

  // taxPct لازمة لاستخراج الضريبة من السعر الشامل في معاينة الإجمالي — والخادم
  // يعيد الاستخراج بنفسه عند الحفظ، فلا تُصدَّق نسبةٌ آتية من المتصفّح
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductPick[] });
  const productOf = (id: string) => (prodQ.data || []).find(x => x.id === id);
  const isTracked = (id: string) => lotOn && productOf(id)?.lotTracked === true;

  // الوحدة الافتراضية = الأكبر (repUnits.defaultChoice): المورّد يبيع بالكرتون، وبعد تحويل الصنف إلى الحبّة يبقى «١» كرتوناً
  const addProduct = (id: string) => {
    if (!id || (rows.some(r => r.productId === id) && !isTracked(id))) return;
    const p = productOf(id);
    if (!p) return;
    const c = defaultChoice(p);
    setRows(rs => [...rs, { rowId: newRowId(), productId: id, name: p.name, unit: c.name, unitId: c.id, qty: '1', unitCost: '', lot: emptyEntryLot() }]);
  };
  /** دفعةٌ ثانية للصنف المتتبَّع: سطرٌ جديد بوحدة السطر نفسها وتشغيلةٍ فارغة */
  const addBatch = (r: EntryRow) => setRows(rs => {
    const at = rs.findIndex(x => x.rowId === r.rowId);
    const copy: EntryRow = { ...r, rowId: newRowId(), qty: '1', unitCost: '', lot: emptyEntryLot() };
    return [...rs.slice(0, at + 1), copy, ...rs.slice(at + 1)];
  });
  const patchRow = (rowId: string, p: Partial<EntryRow>) => setRows(rs => rs.map(r => r.rowId === rowId ? { ...r, ...p } : r));
  /** وحدة السطر: الكمية والسعر رقماهما كما هما — يراهما المستخدم بجانب الوحدة الجديدة («سعر الكرتون») فيصحّحهما */
  const setUnit = (rowId: string, unitId: string | null) => setRows(rs => rs.map(r => {
    if (r.rowId !== rowId) return r;
    const c = choiceById(productOf(r.productId), unitId);
    return c ? { ...r, unit: c.name, unitId: c.id } : r;
  }));
  const removeRow = (rowId: string) => setRows(rs => rs.filter(r => r.rowId !== rowId));

  // «تتبّع اللوط»: اتجاه تشغيلة السطر، وصلاحية صنفه (الانتهاء إلزامي معها)
  const lotKind = (r: EntryRow): EntryLotKind => (type === 'RECEIVE' ? 'RECEIVE' : Number(r.qty) < 0 ? 'DECREASE' : 'INCREASE');
  const trackedRows = rows.filter(r => isTracked(r.productId));
  // مصادر النقص في المستودع (D10): تُجلب لتسويةٍ فيها نقصٌ لصنفٍ متتبَّع وحدها
  const decIds = [...new Set(trackedRows.filter(r => lotKind(r) === 'DECREASE').map(r => r.productId))].sort();
  const srcQ = useQuery({
    queryKey: ['lot-balances-wh', '', decIds.join(',')],
    queryFn: () => fetchWarehouseLots(decIds, ''),
    enabled: lotOn && decIds.length > 0,
  });
  const sourcesOf = (productId: string) => outSourcesOf(srcQ.data?.views.get(productId), 'SELLABLE', srcQ.data?.day ?? '');
  const lotProblem = (r: EntryRow) => (isTracked(r.productId)
    ? entryLotProblem(r.lot, { kind: lotKind(r), expiryRequired: shelfLifeOn(productOf(r.productId)), sourcesCount: sourcesOf(r.productId).length })
    : null);

  const save = useMutation({
    mutationFn: () => {
      const items = rows.map(r => {
        const cost = Number(r.unitCost);
        return {
          productId: r.productId,
          qty: Number(r.qty),
          // وحدة السطر لغير الأساس وحدها — بند الأساس يُرسل كما قبل الميزة (الخادم يقرأ غيابها أساساً بمعامل ١)
          ...(r.unitId && { unitId: r.unitId }),
          // السعر للوارد وحده؛ والفارغ أو الصفر يُرسَل غائباً لا صفراً —
          // «بلا سعر» يُستبعَد من التقييم، بينما صفرٌ يُحسَب بضاعةً مجّانية
          unitCost: type === 'RECEIVE' && r.unitCost.trim() !== '' && !Number.isNaN(cost) && cost > 0 ? cost : undefined,
          // «تتبّع اللوط»: تشغيلة السطر للصنف المتتبَّع وحده — وغيره بلا حقلٍ جديد
          ...(isTracked(r.productId) && entryLotFields(normalizeEntryLot(r.lot, lotKind(r)))),
        };
      }).filter(i => !Number.isNaN(i.qty) && i.qty !== 0);
      return warehouseApi.createEntry({
        type, supplier: supplier.trim() || undefined, note: note.trim() || undefined,
        costsIncludeTax: type === 'RECEIVE' ? costsIncludeTax : undefined,
        items,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['warehouse-stock'] }); qc.invalidateQueries({ queryKey: ['warehouse-vans'] });
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      if (lotOn) { qc.invalidateQueries({ queryKey: ['lot-balances-wh'] }); qc.invalidateQueries({ queryKey: ['lots-of-product'] }); }
      toast.success(tr('تم حفظ الحركة'));
      // تحذيرات اللوط لا تمنع (مثل الإضافة إلى تشغيلة موقوفة) — تُقال بعد الحفظ
      for (const w of lotWarningsOf((res?.data as { warnings?: unknown } | undefined)?.warnings)) toast(tr(LOT_WARNING_LABELS[w.code]), { icon: '⚠️' });
      onClose();
    },
    onError: (e: unknown) => toast.error(lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });

  /**
   * قيمة البضاعة المستلمة — **صافيةً قبل الضريبة دائماً**، ليطابق الرقم المعروض
   * ما سيُخزَّن فعلاً. فلو عُرض شاملاً حين يؤشّر المستخدم «شاملة الضريبة» لرأى
   * رقماً في الشاشة وقرأ غيره في التقرير، وهو أسوأ من ألّا يُعرض شيء.
   * والضريبة تُستخرَج بنسبة كلّ صنف لا بنسبة موحّدة.
   */
  const entryTotal = type !== 'RECEIVE' ? 0 : rows.reduce((sum, r) => {
    const q = Number(r.qty), c = Number(r.unitCost);
    if (Number.isNaN(q) || Number.isNaN(c) || c <= 0) return sum;
    const pct = (prodQ.data || []).find(p => p.id === r.productId)?.taxPct ?? 0;
    const net = costsIncludeTax && pct > 0 ? c / (1 + pct / 100) : c;
    return sum + q * net;
  }, 0);

  // الوارد يتطلّب كميات موجبة؛ التسوية تقبل ± (لكن لا صفر) — وتشغيلة كل سطرٍ متتبَّع مكتملة
  const valid = rows.length > 0 && rows.every(r => {
    const q = Number(r.qty);
    return !Number.isNaN(q) && q !== 0 && (type === 'ADJUST' || q > 0) && !lotProblem(r);
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><PackagePlus size={20} className="text-[#E15A30]" /> {tr('استلام بضاعة / تسوية المستودع')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {/* نوع الحركة */}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setType('RECEIVE')}
              className={`py-2.5 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 ${type === 'RECEIVE' ? 'border-[#1E7A52] bg-green-50 text-[#1E7A52]' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
              <TrendingUp size={16} /> {tr('وارد استلام/شراء')}
            </button>
            <button type="button" onClick={() => setType('ADJUST')}
              className={`py-2.5 rounded-xl border text-sm font-semibold flex items-center justify-center gap-2 ${type === 'ADJUST' ? 'border-purple-500 bg-purple-50 text-purple-600' : 'border-[#E9E1D3] text-[#6E6557]'}`}>
              <TrendingDown size={16} /> {tr('تسوية +/−')}
            </button>
          </div>

          {type === 'RECEIVE' && (
            <div>
              <label className="label">{tr('المورد اختياري')}</label>
              <input className="input" value={supplier} onChange={e => setSupplier(e.target.value)} placeholder={tr('اسم المورد')} />
            </div>
          )}

          <div>
            <label className="label">{tr('إضافة صنف')}</label>
            <SearchableSelect
              options={(prodQ.data || []).filter(p => !rows.some(r => r.productId === p.id) || isTracked(p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.unit}` }))}
              value="" onChange={addProduct} resetOnSelect placeholder={tr('ابحث وأضف صنفا')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
          </div>

          {rows.length > 0 && (
            <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
              {/* رؤوس الأعمدة: بلا تسمية يصير الحقلان رقمين متجاورين لا يُعرَف أيّهما */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FAF7F0] text-[10px] font-semibold text-[#9A8F7E]">
                <span className="min-w-0 flex-1">{tr('الصنف')}</span>
                <span className="w-20 text-center">{tr('الكمية')}</span>
                {type === 'RECEIVE' && <span className="w-24 text-center">{tr('سعر الوحدة')}</span>}
                <span className="w-7" />
              </div>
              <div className="divide-y divide-[#F1EBDF]">
                {rows.map(r => {
                  const q = Number(r.qty), c = Number(r.unitCost);
                  // صافيةً دائماً كالإجمالي تحتها وكالمخزَّن — عرضُ السطر شاملاً
                  // مع إجماليٍّ صافٍ يجعل الأسطر لا تجمع إجمالها أمام العين
                  const pct = (prodQ.data || []).find(p => p.id === r.productId)?.taxPct ?? 0;
                  const net = costsIncludeTax && pct > 0 ? c / (1 + pct / 100) : c;
                  const line = type === 'RECEIVE' && !Number.isNaN(q) && !Number.isNaN(c) && c > 0 ? q * net : null;
                  const choices = unitChoices(productOf(r.productId));
                  const tracked = isTracked(r.productId);
                  const kind = lotKind(r);
                  return (
                    <div key={r.rowId} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                          {/* منتقي وحدة السطر لصنفٍ له وحدات، و«السعر لكل كرتون» تحته فلا يُكتب سعر الحبة في خانة الكرتون */}
                          {choices.length > 1 ? (
                            <select className="input w-auto py-1 text-xs mt-0.5" value={r.unitId ?? ''} aria-label={tr('الوحدة')}
                              onChange={e => setUnit(r.rowId, e.target.value || null)}>
                              {choices.map(ch => <option key={ch.id ?? 'base'} value={ch.id ?? ''}>{ch.name}{ch.factor > 1 ? ` (${ch.factor})` : ''}</option>)}
                            </select>
                          ) : (
                            <p className="text-[11px] text-[#9A8F7E]">{r.unit}</p>
                          )}
                          {choices.length > 1 && type === 'RECEIVE' && (
                            <p className="text-[10px] text-[#9A8F7E] mt-0.5">{tr('السعر لكل')} {r.unit}</p>
                          )}
                        </div>
                        <input type="number" step="any" inputMode="decimal" value={r.qty} onChange={e => patchRow(r.rowId, { qty: e.target.value })}
                          className="input w-20 py-1.5 text-center" placeholder={type === 'ADJUST' ? '±' : '0'} />
                        {type === 'RECEIVE' && (
                          <input type="number" step="any" min="0" inputMode="decimal" value={r.unitCost} onChange={e => patchRow(r.rowId, { unitCost: e.target.value })}
                            className="input w-24 py-1.5 text-center" placeholder={tr('اختياري')} />
                        )}
                        <button onClick={() => removeRow(r.rowId)} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg"><Trash2 size={15} /></button>
                      </div>
                      {line !== null && (
                        <p className="text-[11px] text-[#6E6557] mt-1">{tr('قيمة السطر قبل الضريبة')}: <b className="text-[#1F1A13]">{formatCurrency(line)}</b></p>
                      )}
                      {/* «تتبّع اللوط»: تشغيلة السطر — الرقم وتاريخاه للوارد، ومصدرٌ صريح للنقص، ودفعةٌ ثانية بسطرٍ جديد */}
                      {tracked && (
                        <>
                          <EntryLotFields productId={r.productId} kind={kind} value={r.lot} onChange={d => patchRow(r.rowId, { lot: d })}
                            expiryRequired={shelfLifeOn(productOf(r.productId))}
                            sources={kind === 'DECREASE' ? sourcesOf(r.productId) : undefined}
                            problem={Number(r.qty) ? lotProblem(r) : null} />
                          <button type="button" onClick={() => addBatch(r)}
                            className="mt-1 text-[11px] font-semibold text-[#E15A30] inline-flex items-center gap-1">
                            <CopyPlus size={12} /> {tr('سطر آخر لتشغيلة ثانية')}
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              {type === 'RECEIVE' && (
                <div className="px-3 py-2 bg-[#FAF7F0] border-t border-[#F1EBDF] space-y-2">
                  <label className="flex items-center gap-2 text-[11px] text-[#6E6557] cursor-pointer">
                    <input type="checkbox" checked={costsIncludeTax} onChange={e => setCostsIncludeTax(e.target.checked)} className="accent-[#E15A30]" />
                    {tr('الأسعار المدخلة شاملة الضريبة')}
                  </label>
                  {entryTotal > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[#6E6557]">{tr('قيمة البضاعة المستلمة قبل الضريبة')}</span>
                      <b className="text-[#1F1A13]">{formatCurrency(entryTotal)}</b>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="label">{tr('ملاحظة اختياري')}</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال فاتورة شراء رقم جرد')} />
          </div>
          {type === 'ADJUST' && <p className="text-[11px] text-[#9A8F7E]">{tr('التسوية تقبل موجبا زيادة أو سالبا نقص للجرد والتالف')}</p>}
          {type === 'ADJUST' && trackedRows.length > 0 && (
            <p className="text-[11px] text-[#9A8F7E]">{tr('نقص الصنف المتتبع من تشغيلة محددة وإتلاف تشغيلة موقوفة أو منتهية تسوية نقص منها')}</p>
          )}
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={save.isPending || !valid}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <PackagePlus size={16} />}
            {tr('حفظ الحركة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
