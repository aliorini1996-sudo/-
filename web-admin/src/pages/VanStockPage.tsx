import { Fragment, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { vanStockApi, productApi, salesRepApi, companyApi, lotsApi } from '../api/client';
import { formatDate, activeLocale, formatDayOnly } from '../utils/format';
import { useTr } from '../i18n/strings';
import SearchableSelect from '../components/SearchableSelect';
import { Truck, Package, TrendingDown, Plus, X, Trash2, ArrowDownToLine, Boxes, Calendar, Sparkles, AlertTriangle, Target, Download, Wrench, Layers, ChevronDown, ChevronUp, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import DocumentModal from '../components/DocumentModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { loadNoticeDocFromData, Company } from '../rep/RepDocuments';
import { splitVanMovement } from '../lib/vanMovement';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import VanLoadsLog from '../components/VanLoadsLog';
import { baseQtyText, hasBigUnit, suggestionChoice } from '../lib/adminUnits';
import { choiceById, defaultChoice, unitChoices } from '../rep/repUnits';
import type { UnitDef } from '../lib/units';
import {
  LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS, LOT_WARNING_LABELS, docLotsFrom, isLotExpiredOn, lotErrorOf, lotFlagsOf, lotWarningsOf, roundLot,
  type AllocRowDto, type LotBlockKind, type LotShortageDetail, type LotStatus, type LotWarning, type VanLoadItemLotDto, type VanLotSnapshotDto,
} from '../lib/lots';
import {
  directLoadLotFields, draftFromRows, draftProblem, draftRefs, emptyEntryLot, entryLotProblem, hasMultiLotWarning, isFourDecimals,
  loadSourcesOf, needsExplicitSource, outSourcesOf, shelfLifeOn,
  type EntryLotDraft, type LotBalancesResponse, type LotRowDraft, type PlaceViewWithAvailability,
} from '../lib/stockLots';
import { EntryLotFields, LotRowsEditor, draftProblemText, entryProblemText, fetchLotBalances, fmtLotQty, sourceLabel } from '../components/StockLotFields';

/*
 * الوحدات المتعددة: كل كمية تأتي من الخادم هنا **بوحدة الأساس** (`unit` اسمها) — الرصيد والمحمّل والمباع والاقتراح —
 * ومعها `units` وحدات الصنف فتُعرض «٢ كرتون و٣ حبة» (baseQtyText). وحركات السيارة تحمل لقطة وحدة كل بند (`unit`)
 * فتُعرض بها كما سُجّلت. ونموذج التحميل صفٌّ لكل صنف بوحدةٍ تُختار عليه، و`unitId` يحلّه الخادم إلى معامله.
 *
 * «تتبّع اللوط» (W2، يفعّله المالك لكل شركة): التحميل باقتراح FEFO قابل للتعديل والتقسيم (بالأساس)، وتحذير اللوطين، والتنزيل
 * والإزالة بمصدرٍ صريح حين يتعدّد (D10)، وإتلاف التشغيلة المنتهية غير المباعة بتسوية نقص (lotReason)، وتوسيع صفّ السيارة
 * بتشغيلاته من /van-stock/lot-balances (ومن /lots/balances في «المخزون في تاريخ»). الميزة مطفأة ⇒ لا جلب ولا تغيير مرئي.
 */

/** استجابة /van-stock/suggest — تطابق SuggestResult في الخادم */
interface SuggestRow {
  id: string; name: string; code: string; unit: string;
  /** وحدات الصنف — الكميات بالأساس، وتُحمَّل بأكبر وحدةٍ تنقسم عليها المقترَحة */
  units?: UnitDef[];
  expected: number; withBuffer: number; onVan: number; suggested: number;
  basis: 'weekday' | 'overall' | 'none';
  sampleDays: number; activeDays: number;
  confidence: 'high' | 'medium' | 'low';
  why: string;
}
interface SuggestResponse {
  rows: SuggestRow[];
  meta: {
    targetDate: string; weekday: number; windowDays: number; bufferPct: number;
    dataDays: number; oldestSale: string | null; warning: string | null;
  };
  salesRep: { id: string; name: string };
}

/** وسم الثقة — يُعرض دائماً بجوار الرقم فلا يُقرأ الاقتراح كيقين */
function ConfidenceTag({ c }: { c: SuggestRow['confidence'] }) {
  const map = {
    high: { t: 'ثقة عالية', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    medium: { t: 'ثقة متوسطة', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
    low: { t: 'ثقة منخفضة', cls: 'bg-red-50 text-red-700 border-red-200' },
  }[c];
  return <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold ${map.cls}`}>{map.t}</span>;
}

/** استجابة /van-stock/accuracy — تطابق AccuracyResult في الخادم */
interface AccDay {
  day: string; productId: string; name: string; unit: string;
  expected: number; suggested: number; loaded: number; actual: number; error: number;
  adopted: boolean; outcome: string; open: boolean;
}
interface AccResponse {
  days: AccDay[];
  summary: {
    measured: number; pending: number; unmeasured: number;
    adoptionRate: number | null; mae: number | null; bias: number | null; maePct: number | null;
    under: number; over: number; exact: number; verdict: string;
  };
  meta: { days: number };
}

interface RepSummary {
  salesRepId: string; repName: string; isActive: boolean; canSellWithoutStock: boolean;
  productCount: number; totalRemaining: number; totalLoaded: number; totalSold: number; lastLoadAt: string | null;
  /** «المرتجع التالف» في السيارة — رصيدٌ لا يُباع حتى تزيله الإدارة */
  totalDamaged?: number;
  /** عدد الأدوات في عهدة السيارة الآن (عربة، سلة…) */
  toolsCount?: number;
}
interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
  /** «منتهي الصلاحية» في السيارة: مرتجعٌ عاد بعد انتهاء صلاحيته — لا يُباع ولا يدخل المتبقّي حتى تزيله الإدارة */
  expired?: number;
  /** «المرتجع التالف» في السيارة: مرتجعٌ سجّله المندوب «بضاعة تالفة» — لا يُباع ولا يدخل المتبقّي حتى تزيله الإدارة */
  damaged?: number;
  /** وحدات الصنف (الوحدات المتعددة) — الأرصدة أعلاه بالأساس `unit` */
  units?: UnitDef[];
}
type OutKind = 'EXPIRED_OUT' | 'DAMAGED_OUT';
interface Movement {
  kind: string; date: string; ref: string; by: string | null;
  // unit لقطة وحدة البند كما سُجّل (الكرتون كرتوناً)، وbaseQty كميته بالأساس — بها يعرف الإشعار أنّ وحداته اختلطت.
  // lots: تشغيلات البند («تتبّع اللوط»، withLots=1 والميزة مفعّلة وحدهما) — بالأساس
  items: { name: string; unit: string; qty: number; baseQty?: number | null; lots?: VanLoadItemLotDto[] }[];
}

/** صنفٌ كما يردّه /products — علم اللوط وحقول الصلاحية لتحميل الصنف المتتبَّع */
interface ProductPick {
  id: string; name: string; unit: string; code: string; units?: UnitDef[];
  lotTracked?: boolean; shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null;
}

/** إجراءٌ على تشغيلةٍ في السيارة من تفصيل الصفّ: إتلاف المنتهية غير المباعة، أو تنزيل الموقوفة للمستودع */
interface LotAction { kind: 'DESTROY' | 'UNLOAD'; productId: string; productName: string; lotId: string; lotNumber: string; qty: number }

const fmtQty = (n: number) => Number(n.toFixed(2)).toLocaleString(activeLocale());

/** تشغيلات كل بندٍ على إشعار الحركة (docLotsFrom) — الميزة مطفأة أو البند بلا تشغيلات ⇒ كما هو */
function withMovementLots<D extends { items: object[] }>(doc: D, mv: Movement, lotOn: boolean): D {
  if (!lotOn) return doc;
  return {
    ...doc,
    items: doc.items.map((it, i) => {
      const lots = docLotsFrom(mv.items[i]?.lots);
      return lots ? { ...it, lots } : it;
    }) as D['items'],
  };
}

// لوحة مخزون سيارات المناديب — ملخّص لكل مندوب + تفاصيل المخزون وحركته
export default function VanStockPage() {
  const tr = useTr();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string>('');
  const [showLoad, setShowLoad] = useState(false);
  const [showAccuracy, setShowAccuracy] = useState(false);
  const [noticeMv, setNoticeMv] = useState<Movement | null>(null);
  const [toolsRep, setToolsRep] = useState<RepSummary | null>(null);
  // إزالة المنتهي أو التالف: نافذةٌ بكميةٍ ومصدرٍ صريح بدل window.prompt
  const [removing, setRemoving] = useState<{ row: StockRow; kind: OutKind } | null>(null);
  // «تتبّع اللوط»: الصنف الموسَّع بتشغيلاته، والإجراء المنتظر تأكيده
  const [openLot, setOpenLot] = useState<string | null>(null);
  const [lotAction, setLotAction] = useState<LotAction | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const filtered = !!(from || to);

  // مخزون السيارة بضاعةٌ وقيمة: صفحته تُمنع مع المحاسبة، ومسار /van-stock
  // محروسٌ بالخادم فكلّ طلبٍ هنا كان سيعود ٤٠٣ بلافتة خطأ.
  const { on: accountingOn, ready: accountingReady } = useAccountingOn();

  // بيانات الشركة لرأس ملفّ الإشعار — ومنها علما «لوكيشن» و«تتبّع اللوط» والمستودع
  const companyQ = useQuery({
    queryKey: ['company'],
    queryFn: async () => (await companyApi.get()).data.data as Company,
  });
  const companyFlags = companyQ.data as { locationsEnabled?: boolean; lotTrackingEnabled?: unknown; warehouseEnabled?: boolean } | null | undefined;
  // «تتبّع اللوط» — نسخةٌ بلا العلم تُعامَل إطفاءً، فلا جلب ولا عمود
  const lotOn = lotFlagsOf(companyFlags).on;
  const whOn = companyFlags?.warehouseEnabled === true;

  const summaryQ = useQuery({
    // المدّة جزء من المفتاح، وإلا خدَم الكاشُ أرقامَ مدّة سابقة
    queryKey: ['van-summary', from, to],
    queryFn: async () => (await vanStockApi.summary({ from, to })).data.data as RepSummary[],
    enabled: accountingReady && accountingOn,
  });

  // تبديل صلاحية «البيع بدون مخزون» لمندوب (تحديث متفائل)
  const setSellPerm = useMutation({
    mutationFn: ({ id, val }: { id: string; val: boolean }) => vanStockApi.setSellPermission(id, val),
    onMutate: async ({ id, val }) => {
      await qc.cancelQueries({ queryKey: ['van-summary'] });
      const prev = qc.getQueryData<RepSummary[]>(['van-summary']);
      qc.setQueryData<RepSummary[]>(['van-summary'], (old) => (old || []).map(r => r.salesRepId === id ? { ...r, canSellWithoutStock: val } : r));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['van-summary'], ctx.prev); toast.error(tr('تعذر تغيير الصلاحية')); },
    onSuccess: (_d, v) => toast.success(v.val ? tr('سمح بالبيع بدون مخزون') : tr('منع البيع بدون مخزون')),
    onSettled: () => qc.invalidateQueries({ queryKey: ['van-summary'] }),
  });

  const invalidateVan = () => {
    ['van-current', 'van-movements', 'van-summary', 'van-lot-balances', 'lot-balances-van'].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  };

  /* «تتبّع اللوط»: إجراءٌ على تشغيلةٍ في السيارة — إتلاف المنتهية غير المباعة تسويةُ نقصٍ بوسم EXPIRED_UNSOLD_DESTROY،
   * وتنزيل الموقوفة للمستودع بنوع UNLOAD. كلاهما بالأساس (بلا unitId) ومن تلك التشغيلة صراحةً */
  const runLotAction = useMutation({
    mutationFn: (a: LotAction) => vanStockApi.createLoad(a.kind === 'DESTROY'
      ? {
        salesRepId: selected, type: 'ADJUST', note: tr('إتلاف تشغيلة منتهية لم تبع'),
        items: [{ productId: a.productId, qty: -a.qty, lots: [{ lotId: a.lotId, qty: a.qty }], lotReason: 'EXPIRED_UNSOLD_DESTROY' }],
      }
      : {
        salesRepId: selected, type: 'UNLOAD', note: tr('تنزيل تشغيلة موقوفة للمستودع'),
        items: [{ productId: a.productId, qty: a.qty, lots: [{ lotId: a.lotId, qty: a.qty }] }],
      }),
    onSuccess: (_d, a) => {
      toast.success(a.kind === 'DESTROY' ? tr('أتلفت التشغيلة المنتهية من السيارة') : tr('نزلت التشغيلة الموقوفة للمستودع'));
      setLotAction(null);
      invalidateVan();
      qc.invalidateQueries({ queryKey: ['warehouse-stock'] });
    },
    onError: (e: unknown) => {
      invalidateVan();
      toast.error(lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ'));
    },
  });

  /** رصيدٌ لا يُباع (منتهٍ أو تالف) مع زرّ إزالته — والسالب (إلغاء مرتجعٍ بعد إزالة بضاعته) يظهر ولا يُخفى */
  const outCell = (row: StockRow, kind: OutKind) => {
    const v = (kind === 'EXPIRED_OUT' ? row.expired : row.damaged) ?? 0;
    return Math.abs(v) > 1e-9 ? (
      <span className="inline-flex items-center gap-2">
        <b className="text-red-600">{baseQtyText(v, row, fmtQty)}</b>
        {v > 0 && <button onClick={() => setRemoving({ row, kind })}
          className="text-[11px] font-semibold text-red-600 border border-red-200 rounded-md px-2 py-0.5 hover:bg-red-50 disabled:opacity-50">
          {tr('إزالة')}
        </button>}
      </span>
    ) : <span className="text-[#9A8F7E]">—</span>;
  };

  const currentQ = useQuery({
    queryKey: ['van-current', selected],
    queryFn: async () => (await vanStockApi.current(selected)).data.data as StockRow[],
    enabled: !!selected && accountingReady && accountingOn,
  });
  const movementsQ = useQuery({
    // «تتبّع اللوط»: تشغيلات البنود بـwithLots والميزة مفعّلة وحدها — وبدونها الطلب كما كان
    queryKey: ['van-movements', selected, lotOn],
    queryFn: async () => (await vanStockApi.movements(selected, lotOn ? { withLots: true } : undefined)).data.data as Movement[],
    enabled: !!selected && accountingReady && accountingOn,
  });
  // «تتبّع اللوط»: لقطة تشغيلات السيارة (VanLotSnapshotDto) — قائمة tracked مرجع «الصنف متتبَّع»، والأرصدة لتوسيع الصفّ
  const snapQ = useQuery({
    queryKey: ['van-lot-balances', selected],
    queryFn: async () => (await lotsApi.vanLotBalances(selected)).data.data as VanLotSnapshotDto,
    enabled: lotOn && !!selected && accountingReady && accountingOn,
  });
  const trackedSet = new Set(lotOn ? snapQ.data?.tracked ?? [] : []);
  const repName = summaryQ.data?.find(r => r.salesRepId === selected)?.repName || '';

  const reps = summaryQ.data || [];
  const selectedRep = reps.find(r => r.salesRepId === selected);
  // «لوكيشن» (ميزةٌ يفعّلها المالك): «سجل التحميلات» بعمود الموقع وتصفيته — مطفأةً لا جديد في الصفحة
  const locOn = companyFlags?.locationsEnabled === true;

  if (!accountingReady) return null;
  if (!accountingOn) return <AccountingOffNotice />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1A13] flex items-center gap-2">
            <Truck size={26} className="text-[#E15A30]" /> {tr('مخزون سيارات المناديب')}
          </h1>
          <p className="text-[#6E6557] text-sm mt-1">{tr('متابعة ما حمله كل مندوب في سيارته وما تبقى بعد المبيعات لحظيا')}</p>
        </div>
        <button onClick={() => setShowAccuracy(true)} className="btn-secondary"><Target size={16} /> {tr('دقة الاقتراح')}</button>
        <button onClick={() => setShowLoad(true)} className="btn-primary"><Plus size={17} /> {tr('تسجيل تحميل')}</button>
      </div>

      {/* تصفية بالمدّة */}
      <div className="card">
        <div className="flex gap-3 flex-wrap items-end">
          <div>
            <label className="label text-xs">{tr('من تاريخ')}</label>
            <input type="date" className="input w-40" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label text-xs">{tr('إلى تاريخ')}</label>
            <input type="date" className="input w-40" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          {filtered && (
            <button className="btn-secondary" onClick={() => { setFrom(''); setTo(''); }}>{tr('مسح الفلاتر')}</button>
          )}
          {filtered && (
            // الأرقام تغيّر معناها مع المدّة، فالتنبيه ليس زينة: «المحمّل» و«المباع»
            // صارا تدفّقَي مدّة، و«المتبقي» رصيدٌ بنهايتها لا رصيد اللحظة.
            <p className="text-xs text-[#6E6557] basis-full sm:basis-auto sm:mb-2">
              {tr('المحمل والمباع خلال المدة المحددة والمتبقي رصيد نهايتها')}
            </p>
          )}
        </div>
      </div>

      {/* ملخّص المناديب */}
      <div className="card overflow-hidden p-0">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          <Boxes size={17} className="text-[#E15A30]" /> {tr('ملخص المخزون حسب المندوب')}
        </div>
        {summaryQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : reps.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا يوجد مناديب بعد')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                  <th className="text-right font-semibold px-5 py-2.5">{tr('المندوب')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('أصناف بالسيارة')}</th>
                  {/* عهدةٌ قائمة الآن — لا تتبع المدّة */}
                  <th className="text-center font-semibold px-3 py-2.5">{tr('أدوات بالسيارة')}</th>
                  {/* مجاميعٌ عبر الأصناف بوحدات الأساس (الخادم) — حبّاتٌ لا كراتين لصنفٍ له وحدات، فيُقال ذلك في التلميح */}
                  <th className="text-center font-semibold px-3 py-2.5" title={tr('مجموع بوحدات الأساس')}>{filtered ? tr('محمل بالمدة') : tr('إجمالي محمل')}</th>
                  <th className="text-center font-semibold px-3 py-2.5" title={tr('مجموع بوحدات الأساس')}>{filtered ? tr('مباع بالمدة') : tr('إجمالي مباع')}</th>
                  <th className="text-center font-semibold px-3 py-2.5" title={tr('مجموع بوحدات الأساس')}>{filtered ? tr('التالف بنهاية المدة') : tr('المرتجع التالف')}</th>
                  <th className="text-center font-semibold px-3 py-2.5" title={tr('مجموع بوحدات الأساس')}>{filtered ? tr('المتبقي بنهاية المدة') : tr('المتبقي')}</th>
                  <th className="text-center font-semibold px-3 py-2.5" title={lotOn ? tr('الأصناف المتتبعة باللوط ممنوعة دائما من البيع بلا رصيد ولو سمح للمندوب') : undefined}>{tr('البيع بدون مخزون')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('آخر تحميل')}</th>
                </tr>
              </thead>
              <tbody>
                {reps.map(r => (
                  <tr key={r.salesRepId}
                    onClick={() => setSelected(r.salesRepId)}
                    className={`border-t border-[#F1EBDF] cursor-pointer transition-colors ${selected === r.salesRepId ? 'bg-[#FBEBE2]' : 'hover:bg-[#FAF7F0]'}`}>
                    <td className="px-5 py-3 font-semibold text-[#1F1A13]">{r.repName}{!r.isActive && <span className="text-[10px] text-red-500 mr-2">{tr('موقوف')}</span>}</td>
                    <td className="text-center px-3 py-3">{r.productCount}</td>
                    <td className="text-center px-3 py-3" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setToolsRep(r)} title={tr('عهدة أدوات السيارة')}
                        className="inline-flex items-center gap-1.5 text-[12px] font-semibold rounded-full px-3 py-1 border border-[#E9E1D3] text-[#1F1A13] hover:bg-[#FAF7F0]">
                        <Wrench size={12} className="text-[#E15A30]" /> {formatCount(r.toolsCount ?? 0)}
                      </button>
                    </td>
                    <td className="text-center px-3 py-3 text-[#6E6557]">{fmtQty(r.totalLoaded)}</td>
                    <td className="text-center px-3 py-3 text-[#6E6557]">{fmtQty(r.totalSold)}</td>
                    {/* «المرتجع التالف»: رصيدٌ في السيارة لا يُباع ولا يدخل المتبقّي حتى تزيله الإدارة من تفاصيل المندوب */}
                    <td className={`text-center px-3 py-3 ${Math.abs(r.totalDamaged ?? 0) > 1e-9 ? 'font-bold text-red-600' : 'text-[#9A8F7E]'}`}>
                      {Math.abs(r.totalDamaged ?? 0) > 1e-9 ? fmtQty(r.totalDamaged!) : '—'}
                    </td>
                    <td className={`text-center px-3 py-3 font-bold ${r.totalRemaining < 0 ? 'text-red-600' : 'text-[#1E7A52]'}`}>{fmtQty(r.totalRemaining)}</td>
                    <td className="text-center px-3 py-3" onClick={e => e.stopPropagation()}>
                      <button onClick={() => setSellPerm.mutate({ id: r.salesRepId, val: !r.canSellWithoutStock })}
                        disabled={setSellPerm.isPending}
                        title={r.canSellWithoutStock ? tr('مسموح اضغط للمنع') : tr('ممنوع اضغط للسماح')}
                        className={`text-[11px] font-bold rounded-full px-3 py-1 border transition-colors disabled:opacity-50 ${r.canSellWithoutStock ? 'bg-green-50 text-[#1E7A52] border-green-200 hover:bg-green-100' : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'}`}>
                        {r.canSellWithoutStock ? tr('نعم') : tr('لا')}
                      </button>
                    </td>
                    <td className="text-center px-3 py-3 text-[#9A8F7E] text-xs">{r.lastLoadAt ? formatDate(r.lastLoadAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* «تتبّع اللوط»: البيع بالسالب مقفلٌ على مستوى التشغيلة للصنف المتتبَّع مهما كانت صلاحية المندوب */}
        {lotOn && reps.length > 0 && (
          <p className="px-5 py-2 border-t border-[#F1EBDF] text-[11px] text-[#6E6557] flex items-center gap-1.5">
            <Info size={12} className="text-[#E15A30] shrink-0" />
            {tr('الأصناف المتتبعة باللوط ممنوعة دائما من البيع بلا رصيد ولو سمح للمندوب')}
          </p>
        )}
      </div>

      {/* تفاصيل المندوب المختار */}
      {selected && selectedRep && (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* المخزون الحالي */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
              <Package size={17} className="text-[#E15A30]" /> {tr('مخزون المندوب الحالي')} — {selectedRep.repName}
            </div>
            {currentQ.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
            ) : (currentQ.data || []).length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد بضاعة محملة لهذا المندوب')}</div>
            ) : (
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0">
                    <tr className="text-[#6E6557] text-xs bg-[#FAF7F0]">
                      <th className="text-right font-semibold px-5 py-2.5">{tr('الصنف')}</th>
                      <th className="text-center font-semibold px-2 py-2.5">{tr('محمل')}</th>
                      <th className="text-center font-semibold px-2 py-2.5">{tr('مباع')}</th>
                      <th className="text-center font-semibold px-2 py-2.5">{tr('مرتجع')}</th>
                      <th className="text-center font-semibold px-3 py-2.5">{tr('المتبقي')}</th>
                      <th className="text-center font-semibold px-3 py-2.5">{tr('منتهي الصلاحية')}</th>
                      <th className="text-center font-semibold px-3 py-2.5">{tr('تالف')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(currentQ.data || []).map(row => {
                      const tracked = trackedSet.has(row.productId);
                      const open = tracked && openLot === row.productId;
                      const snapP = tracked ? snapQ.data?.products.find(p => p.productId === row.productId) : undefined;
                      return (
                      <Fragment key={row.productId}>
                      <tr className="border-t border-[#F1EBDF]">
                        <td className="px-5 py-2.5">
                          <p className="font-semibold text-[#1F1A13]">{row.name}</p>
                          <p className="text-[10px] text-[#9A8F7E]">{row.code} · {hasBigUnit(row.units) ? `${tr('وحدة الأساس')} ${row.unit}` : row.unit}</p>
                          {/* «تتبّع اللوط»: عدد التشغيلات والمعزول، ومفتاح توسيع الصفّ بها */}
                          {tracked && (
                            <button type="button" onClick={() => setOpenLot(open ? null : row.productId)}
                              className="mt-0.5 inline-flex items-center gap-1 flex-wrap text-[10px] font-semibold text-[#6E6557] hover:text-[#E15A30]">
                              <Layers size={11} className="text-[#E15A30]" />
                              {snapP ? `${snapP.lots.length} ${tr('تشغيلة')}` : tr('التشغيلات')}
                              {snapP && snapP.quarantined + snapP.expiredUnsold > 1e-6 && (
                                <span className="rounded bg-amber-50 border border-amber-200 text-amber-700 px-1">{tr('معزول')} {baseQtyText(snapP.quarantined + snapP.expiredUnsold, row, fmtQty)}</span>
                              )}
                              {snapP && snapP.unknownUsable < -1e-6 && <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr('عجز')}</span>}
                              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            </button>
                          )}
                        </td>
                        {/* بالأساس من الخادم، مفكَّكةً بوحدات الصنف — «٤٨» بجانب «كرتون» تحت الاسم كانت تُقرأ كراتين */}
                        <td className="text-center px-2 py-2.5 text-[#6E6557]">{baseQtyText(row.loaded, row, fmtQty)}</td>
                        <td className="text-center px-2 py-2.5 text-[#C94E28]">{baseQtyText(row.sold, row, fmtQty)}</td>
                        <td className="text-center px-2 py-2.5 text-[#6E6557]">{baseQtyText(row.returned, row, fmtQty)}</td>
                        <td className={`text-center px-3 py-2.5 font-bold ${row.remaining < 0 ? 'text-red-600' : row.remaining === 0 ? 'text-[#9A8F7E]' : 'text-[#1E7A52]'}`}>{baseQtyText(row.remaining, row, fmtQty)}</td>
                        <td className="text-center px-3 py-2.5">{outCell(row, 'EXPIRED_OUT')}</td>
                        <td className="text-center px-3 py-2.5">{outCell(row, 'DAMAGED_OUT')}</td>
                      </tr>
                      {open && (
                        <tr className="bg-[#FAF7F0]/60">
                          <td colSpan={7} className="px-5 py-3">
                            <VanLotsDetail productId={row.productId} productName={row.name} repId={selected} row={row}
                              snap={snapQ.data} snapLoading={snapQ.isLoading} asOf={to}
                              onAction={setLotAction} busy={runLotAction.isPending} />
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

          {/* حركة المخزون (كم نزل ومتى) */}
          <div className="card p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
              <TrendingDown size={17} className="text-[#E15A30]" /> {tr('حركة البضاعة ماذا نزل ومتى')}
            </div>
            {movementsQ.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
            ) : (movementsQ.data || []).length === 0 ? (
              <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد حركة بعد')}</div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto divide-y divide-[#F1EBDF]">
                {(movementsQ.data || []).map((m, i) => <MovementRow key={i} m={m} onExport={setNoticeMv} />)}
              </div>
            )}
          </div>
        </div>
      )}

      {locOn && <VanLoadsLog reps={reps} />}

      {showLoad && <LoadModal preselectRep={selected} lotOn={lotOn} whOn={whOn} onClose={() => setShowLoad(false)} />}
      {showAccuracy && <AccuracyModal preselectRep={selected} onClose={() => setShowAccuracy(false)} />}
      {noticeMv && <DocumentModal doc={withMovementLots(loadNoticeDocFromData(repName, noticeMv, companyQ.data ?? null), noticeMv, lotOn)} onClose={() => setNoticeMv(null)} />}
      {toolsRep && <ToolsModal repId={toolsRep.salesRepId} repName={toolsRep.repName} onClose={() => setToolsRep(null)} />}
      {removing && (
        <RemoveOutModal row={removing.row} kind={removing.kind} repId={selected} tracked={trackedSet.has(removing.row.productId)}
          onDone={invalidateVan} onClose={() => setRemoving(null)} />
      )}
      {lotAction && (
        <ConfirmDialog
          title={lotAction.kind === 'DESTROY' ? tr('إتلاف تشغيلة منتهية') : tr('تنزيل تشغيلة موقوفة')}
          message={`${lotAction.productName} — ${tr('التشغيلة')} ${lotAction.lotNumber}: ${fmtLotQty(lotAction.qty)}`}
          extra={<p className="text-xs text-[#6E6557]">{lotAction.kind === 'DESTROY'
            ? tr('تخرج الكمية من رصيد السيارة بتسوية نقص موسومة إتلاف منتهي لم يبع')
            : tr('تعود الكمية إلى المستودع وتبقى التشغيلة موقوفة هناك')}</p>}
          confirmLabel={lotAction.kind === 'DESTROY' ? tr('إتلاف') : tr('تنزيل')}
          danger={lotAction.kind === 'DESTROY'} loading={runLotAction.isPending}
          onConfirm={() => runLotAction.mutate(lotAction)} onClose={() => setLotAction(null)} />
      )}
    </div>
  );
}

const formatCount = (n: number) => n.toLocaleString(activeLocale());

/* ═══ عهدة أدوات السيارة (طلب المالك ١٥ أكتوبر ٢٠٢٦) ═══
 * ما سُلّم لسيارة المندوب من أدوات (عربة تحميل، سلة…): الإدارة تسلّم وتستلم، والرصيد لكل أداة مشتقّ من الحركات في الخادم
 * (الاستلام لا يتجاوز العهدة، والاسم يُطابق بلا فروق المسافات). والمندوب يرى عهدته في تطبيقه للاطلاع. */
interface ToolsData {
  balances: { toolName: string; qty: number }[];
  total: number;
  moves: { id: string; type: 'ISSUE' | 'RETURN'; toolName: string; qty: number; note: string | null; createdByName: string | null; createdAt: string }[];
  names: string[];
}

function ToolsModal({ repId, repName, onClose }: { repId: string; repName: string; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const toolsQ = useQuery({
    queryKey: ['van-tools', repId],
    queryFn: async () => (await vanStockApi.tools(repId)).data.data as ToolsData,
  });
  const [type, setType] = useState<'ISSUE' | 'RETURN'>('ISSUE');
  const [rows, setRows] = useState<{ toolName: string; qty: string }[]>([{ toolName: '', qty: '1' }]);
  const [note, setNote] = useState('');
  const filled = rows.filter(r => r.toolName.trim());
  const valid = filled.length > 0 && filled.every(r => Number.isInteger(Number(r.qty)) && Number(r.qty) > 0);
  const save = useMutation({
    mutationFn: () => vanStockApi.toolMove({
      salesRepId: repId, type, note: note.trim() || undefined,
      items: filled.map(r => ({ toolName: r.toolName.trim(), qty: Number(r.qty) })),
    }),
    onSuccess: () => {
      toast.success(type === 'ISSUE' ? tr('سجل تسليم الأدوات للسيارة') : tr('سجل استلام الأدوات من السيارة'));
      setRows([{ toolName: '', qty: '1' }]); setNote('');
      qc.invalidateQueries({ queryKey: ['van-tools', repId] });
      qc.invalidateQueries({ queryKey: ['van-summary'] });
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });
  const balances = toolsQ.data?.balances ?? [];
  // اقتراحات الاسم: للتسليم أسماء أدوات الشركة، وللاستلام ما في عهدة هذه السيارة وحدها
  const suggestions = type === 'ISSUE' ? (toolsQ.data?.names ?? []) : balances.map(b => b.toolName);
  const listId = `van-tool-names-${repId}`;

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><Wrench size={20} className="text-[#E15A30]" /> {tr('أدوات بالسيارة')} — {repName}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">
          {/* العهدة الحالية */}
          <div>
            <p className="text-sm font-bold text-[#1F1A13] mb-2">{tr('العهدة الحالية')}</p>
            {toolsQ.isLoading ? (
              <p className="text-center text-gray-400 text-sm py-4">{tr('جار التحميل')}</p>
            ) : balances.length === 0 ? (
              <p className="text-center text-gray-400 text-sm py-4 border border-dashed border-[#E9E1D3] rounded-xl">{tr('لا توجد أدوات في عهدة هذه السيارة')}</p>
            ) : (
              <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF]">
                {balances.map(b => (
                  <div key={b.toolName} className="flex items-center justify-between px-3.5 py-2.5 text-sm">
                    <span className="font-semibold text-[#1F1A13]">{b.toolName}</span>
                    <b className="tabular-nums text-[#1E7A52]">{formatCount(b.qty)}</b>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* تسليم أو استلام */}
          <div className="border border-[#E9E1D3] rounded-xl p-3.5 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {(['ISSUE', 'RETURN'] as const).map(t => (
                <button key={t} type="button" onClick={() => setType(t)} disabled={t === 'RETURN' && balances.length === 0}
                  className={`py-2 rounded-lg text-sm font-semibold border disabled:opacity-40 ${type === t ? 'bg-[#E15A30] text-white border-[#E15A30]' : 'bg-white text-[#6E6557] border-[#E9E1D3] hover:bg-[#FAF7F0]'}`}>
                  {t === 'ISSUE' ? tr('تسليم للسيارة') : tr('استلام من السيارة')}
                </button>
              ))}
            </div>
            <datalist id={listId}>{suggestions.map(n => <option key={n} value={n} />)}</datalist>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input className="input flex-1" list={listId} placeholder={tr('اسم الأداة مثل عربة تحميل أو سلة')} value={r.toolName} maxLength={80}
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, toolName: e.target.value } : x))} />
                <input type="number" min="1" step="1" inputMode="numeric" className="input w-20 text-center" value={r.qty}
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} className="text-red-400 p-1"><Trash2 size={16} /></button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => setRows(rs => [...rs, { toolName: '', qty: '1' }])}
              className="text-xs font-semibold text-[#E15A30] inline-flex items-center gap-1"><Plus size={13} /> {tr('إضافة أداة')}</button>
            <input className="input" placeholder={tr('ملاحظة اختياري')} value={note} maxLength={300} onChange={e => setNote(e.target.value)} />
            <button type="button" onClick={() => save.mutate()} disabled={!valid || save.isPending} className="btn-primary w-full justify-center">
              {save.isPending ? tr('جار الحفظ') : type === 'ISSUE' ? tr('حفظ التسليم') : tr('حفظ الاستلام')}
            </button>
          </div>

          {/* السجل */}
          {(toolsQ.data?.moves ?? []).length > 0 && (
            <div>
              <p className="text-sm font-bold text-[#1F1A13] mb-2">{tr('سجل التسليم والاستلام')}</p>
              <div className="border border-[#E9E1D3] rounded-xl divide-y divide-[#F1EBDF] max-h-56 overflow-y-auto">
                {toolsQ.data!.moves.map(m => (
                  <div key={m.id} className="px-3.5 py-2 text-xs flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[#1F1A13]">
                        <span className={`font-bold ${m.type === 'ISSUE' ? 'text-[#1E7A52]' : 'text-amber-600'}`}>{m.type === 'ISSUE' ? tr('تسليم للسيارة') : tr('استلام من السيارة')}</span>
                        {' '}{m.toolName} × {formatCount(m.qty)}
                      </p>
                      {m.note && <p className="text-[#9A8F7E] truncate">{m.note}</p>}
                    </div>
                    <div className="text-left text-[#9A8F7E] shrink-0">
                      <p>{formatDate(m.createdAt)}</p>
                      {m.createdByName && <p>{m.createdByName}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const KIND_META: Record<string, { label: string; color: string; sign: string }> = {
  LOAD: { label: 'تحميل', color: 'text-[#1E7A52] bg-green-50', sign: '+' },
  SALE: { label: 'بيع', color: 'text-[#C94E28] bg-[#FBEBE2]', sign: '−' },
  RETURN: { label: 'مرتجع', color: 'text-blue-600 bg-blue-50', sign: '+' },
  EXPIRED_OUT: { label: 'إزالة منتهي الصلاحية', color: 'text-red-600 bg-red-50', sign: '−' },
  // المرتجع التالف يدخل رصيد «المرتجع التالف» لا المتاح، وإزالته من ذلك الرصيد
  RETURN_DAMAGED: { label: 'مرتجع تالف', color: 'text-red-600 bg-red-50', sign: '+' },
  DAMAGED_OUT: { label: 'إزالة مرتجع تالف', color: 'text-red-600 bg-red-50', sign: '−' },
  UNLOAD: { label: 'تنزيل للمستودع', color: 'text-amber-600 bg-amber-50', sign: '−' },
  ADJUST: { label: 'تسوية', color: 'text-purple-600 bg-purple-50', sign: '±' },
};

function MovementRow({ m, onExport }: { m: Movement; onExport?: (m: Movement) => void }) {
  const tr = useTr();
  const meta = KIND_META[m.kind] || KIND_META.ADJUST;
  const canExport = ['LOAD', 'UNLOAD', 'ADJUST'].includes(m.kind); // حركات السيارة (لا المبيعات) تُصدَّر إشعاراً
  return (
    <div className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md ${meta.color}`}>{tr(meta.label)}</span>
          {onExport && canExport && (
            <button onClick={() => onExport(m)} title={tr('إشعار PDF')}
              className="text-[11px] text-slate-600 hover:text-slate-800 flex items-center gap-1 font-semibold">
              <Download size={12} /> {tr('إشعار PDF')}
            </button>
          )}
        </span>
        <span className="text-[11px] text-[#9A8F7E] flex items-center gap-1"><Calendar size={11} /> {formatDate(m.date)}</span>
      </div>
      {m.ref && <p className="text-xs text-[#6E6557] mt-1.5">{m.ref}</p>}
      <div className="flex flex-wrap gap-1.5 mt-1.5">
        {m.items.map((it, j) => {
          // التسوية قد تكون + أو −؛ نُظهر الإشارة الفعلية للكمية لا الرمز ±
          const sign = m.kind === 'ADJUST' ? (it.qty < 0 ? '−' : '+') : meta.sign;
          const isNeg = (m.kind === 'ADJUST' && it.qty < 0);
          // «تتبّع اللوط»: تشغيلات البند بالأساس (withLots) — «غير مسمى» لصفٍّ بلا تشغيلة
          const lots = docLotsFrom(it.lots);
          return (
            <span key={j} className="text-[11px] bg-[#FAF7F0] border border-[#F1EBDF] rounded-md px-2 py-0.5 text-[#1F1A13]">
              {it.name} <b className={isNeg ? 'text-red-600' : undefined}>{sign}{fmtQty(Math.abs(it.qty))}</b> {it.unit}
              {lots && lots.map((l, k) => (
                <span key={k} className="ms-1 inline-flex items-center gap-0.5 rounded bg-white border border-[#E9E1D3] px-1 text-[10px] text-[#6E6557]">
                  <Layers size={10} className="text-[#E15A30]" /> {l.lotNumber ?? tr('غير مسمى')} ×{fmtLotQty(l.qty)}
                </span>
              ))}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// نافذة «دقّة الاقتراح» — الحكم أولاً بالعربية، ثم الأرقام، ثم الأيام تفصيلاً.
// «قيد البيع» يوم لم يكتمل فلا يُحسب — عرضُه محسوباً كان سيتّهم كل تنبّؤٍ
// صباحيّ بالمبالغة قبل أن يبيع المندوب شيئاً.
function AccuracyModal({ preselectRep, onClose }: { preselectRep: string; onClose: () => void }) {
  const tr = useTr();
  const [repId, setRepId] = useState(preselectRep);
  const [days, setDays] = useState(14);
  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string }[] });
  // status/fetchStatus لا isLoading — درس «الموقوف ليس فارغاً» (راجع التقارير)
  const accQ = useQuery({
    queryKey: ['van-accuracy', repId, days],
    enabled: !!repId,
    queryFn: async () => (await vanStockApi.accuracy({ salesRepId: repId, days })).data.data as AccResponse,
  });
  const d = accQ.data;
  const chip = (label: string, val: string, cls: string) => (
    <div className={`rounded-xl border px-3 py-2 ${cls}`}>
      <p className="text-[10px] text-gray-500">{label}</p>
      <p className="text-sm font-bold">{val}</p>
    </div>
  );
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h3 className="font-bold text-[#1F1A13] flex items-center gap-2"><Target size={18} className="text-[#E15A30]" /> {tr('دقة الاقتراح')}</h3>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="flex gap-3 flex-wrap items-end">
            <div className="flex-1 min-w-[180px]">
              <label className="label">{tr('المندوب')}</label>
              <SearchableSelect
                options={(repsQ.data || []).map(r => ({ value: r.id, label: r.name }))}
                value={repId} onChange={setRepId} placeholder={tr('اختر المندوب')} />
            </div>
            <div>
              <label className="label">{tr('الفترة')}</label>
              <select className="input w-32" value={days} onChange={e => setDays(Number(e.target.value))}>
                <option value={7}>{tr('أسبوع')}</option>
                <option value={14}>{tr('أسبوعان')}</option>
                <option value={30}>{tr('شهر')}</option>
                <option value={60}>{tr('شهران')}</option>
              </select>
            </div>
          </div>

          {!repId ? (
            <p className="text-center text-gray-400 py-8 text-sm">{tr('اختر مندوبا لعرض دقة اقتراحاته')}</p>
          ) : accQ.status === 'pending' ? (
            <p className="text-center text-gray-400 py-8 text-sm">{accQ.fetchStatus === 'paused' ? tr('بانتظار عودة الاتصال') : tr('جاري التحميل')}</p>
          ) : accQ.status === 'error' ? (
            <p className="text-center text-red-500 py-8 text-sm">{tr('تعذر تحميل التقرير')}</p>
          ) : d && (
            <>
              {/* الحكم — جملة تُقرأ كما هي، من الخادم */}
              <div className="bg-[#FAF7F0] border border-[#F1EBDF] rounded-xl p-4 text-sm text-[#1F1A13] leading-relaxed">
                {d.summary.verdict}
              </div>

              {d.summary.measured > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {chip(tr('متوسط الخطأ'), d.summary.mae === null ? '—' : `${d.summary.mae} (${d.summary.maePct ?? '—'}٪)`, 'bg-white border-[#E9E1D3]')}
                  {chip(tr('الانحياز'), d.summary.bias === null ? '—' : d.summary.bias > 0 ? `${tr('نقص')} ${d.summary.bias}` : d.summary.bias < 0 ? `${tr('زيادة')} ${Math.abs(d.summary.bias)}` : tr('متوازن'), 'bg-white border-[#E9E1D3]')}
                  {chip(tr('الالتزام بالاقتراح'), d.summary.adoptionRate === null ? '—' : `${d.summary.adoptionRate}٪`, 'bg-white border-[#E9E1D3]')}
                  {chip(`${tr('دقيق')} / ${tr('نقص')} / ${tr('زيادة')}`, `${d.summary.exact} / ${d.summary.under} / ${d.summary.over}`, 'bg-white border-[#E9E1D3]')}
                </div>
              )}

              {d.days.length > 0 ? (
                <div className="table-wrapper border border-[#F1EBDF] rounded-xl">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{tr('اليوم')}</th><th>{tr('الصنف')}</th><th>{tr('التنبؤ')}</th>
                        <th>{tr('حمل')}</th><th>{tr('مباع')}</th><th>{tr('الحكم')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.days.map((r, i) => (
                        <tr key={i} className={r.open ? 'opacity-50' : ''}>
                          <td className="text-xs text-gray-500 tabular-nums">{r.day}</td>
                          <td className="font-medium text-gray-800">{r.name} <span className="text-[10px] text-gray-400">{r.unit}</span></td>
                          <td className="tabular-nums">{fmtQty(r.expected)}</td>
                          <td className="tabular-nums text-gray-600">{fmtQty(r.loaded)}</td>
                          <td className="tabular-nums font-semibold">{fmtQty(r.actual)}</td>
                          <td>
                            {r.open
                              ? <span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-50 text-gray-500 border-gray-200 font-semibold">{tr('قيد البيع')}</span>
                              : <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${r.outcome === 'دقيق' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : r.outcome === 'نقص' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
                                  {tr(r.outcome)} {r.error !== 0 && <span className="tabular-nums">{r.error > 0 ? `+${fmtQty(r.error)}` : `−${fmtQty(Math.abs(r.error))}`}</span>}
                                </span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-center text-gray-400 py-6 text-sm">{tr('لا تحميلات مبنية على اقتراح في هذه الفترة طبق التحميل المقترح عند التحميل ليبدأ القياس')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** سطر نافذة التحميل: مفتاحه rowId لا الصنف. lotEdit صفوف التشغيلات حين يعدّلها المستخدم (null = اقتراح الخادم أو مصدره
 * الوحيد)، وlotEntry تشغيلة التحميل المباشر في شركة بلا مستودع (D4) */
interface LoadRow {
  rowId: string; productId: string; name: string; unit: string; unitId: string | null; qty: string;
  suggestedQty?: number; expectedQty?: number;
  lotEdit: LotRowDraft[] | null; lotEntry: EntryLotDraft;
}
let loadRowSeq = 0;
const loadRowId = () => `l${++loadRowSeq}`;

// نموذج تسجيل تحميل بضاعة لمندوب (للأدمن)
function LoadModal({ preselectRep, lotOn, whOn, onClose }: { preselectRep: string; lotOn: boolean; whOn: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const tr = useTr();
  const [repId, setRepId] = useState(preselectRep);
  const [note, setNote] = useState('');
  // suggestedQty يُحفَظ على الصفّ ليُرسَل مع الحركة — به تُقاس جودة الاقتراح لاحقاً (بالأساس دائماً مهما كانت وحدة الصفّ).
  // الوحدات المتعددة: صفٌّ لكل صنف (كتطبيق المندوب) بوحدةٍ تُختار عليه — `unit` اسمها والكمية بها، و`unitId`
  // (null = الأساس) يُرسل فيحلّه الخادم إلى معامله؛ والتنزيل (الكمية السالبة) يحمل الوحدة نفسها (splitVanMovement).
  // والفهرسة بـrowId («تتبّع اللوط»): تشغيلات كل سطرٍ معه
  const [rows, setRows] = useState<LoadRow[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [windowDays, setWindowDays] = useState(28);
  const [bufferPct, setBufferPct] = useState(15);

  const repsQ = useQuery({ queryKey: ['reps-min'], queryFn: async () => (await salesRepApi.list({ limit: 1000 })).data.data as { id: string; name: string }[] });
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductPick[] });
  const productOf = (id: string) => (prodQ.data || []).find(x => x.id === id);
  const isTracked = (id: string) => lotOn && productOf(id)?.lotTracked === true;
  /** معامل وحدة السطر (١ للأساس) — كميات التشغيلات بالأساس = الكمية × المعامل (D22) */
  const factorOfRow = (r: LoadRow) => choiceById(productOf(r.productId), r.unitId)?.factor ?? 1;
  const baseOfRow = (r: LoadRow) => roundLot((Number(r.qty) || 0) * factorOfRow(r));

  // الوحدة الافتراضية للتحميل = الأكبر (repUnits.defaultChoice): بعد تحويل الصنف إلى الحبّة يبقى «١» كرتوناً كما كان
  const addProduct = (id: string, opt?: { label: string }) => {
    if (!id || rows.some(r => r.productId === id)) return;
    const p = productOf(id);
    if (!p) return;
    const c = defaultChoice(p);
    setRows(rs => [...rs, { rowId: loadRowId(), productId: id, name: opt?.label || p.name, unit: c.name, unitId: c.id, qty: '1', lotEdit: null, lotEntry: emptyEntryLot() }]);
  };
  const patchRow = (rowId: string, p: Partial<LoadRow>) => setRows(rs => rs.map(x => x.rowId === rowId ? { ...x, ...p } : x));
  /** وحدة الصفّ: الكمية رقمها كما هو (يراها المستخدم بجانب الوحدة الجديدة)، ووحدةٌ لم تعد نشطة تُترك — وتوزيع تشغيلاته يُعاد */
  const setRowUnit = (rowId: string, unitId: string | null) => setRows(rs => rs.map(x => {
    if (x.rowId !== rowId) return x;
    const c = choiceById(productOf(x.productId), unitId);
    return c ? { ...x, unit: c.name, unitId: c.id, lotEdit: null } : x;
  }));
  /** المندوب: مصادر التنزيل من سيارته، فتوزيعُ السطور السالبة يُعاد */
  const changeRep = (v: string) => {
    setRepId(v);
    setRows(rs => rs.map(x => (Number(x.qty) < 0 ? { ...x, lotEdit: null } : x)));
  };

  // الاقتراح لا يُطلَب إلا حين يُفتح القسم: طلب شبكة لكل فتح نموذج هدرٌ
  // لمن يعرف كمياته أصلاً.
  const suggestQ = useQuery({
    queryKey: ['van-suggest', repId, windowDays, bufferPct],
    enabled: showSuggest && !!repId,
    queryFn: async () => (await vanStockApi.suggest({ salesRepId: repId, windowDays, bufferPct })).data.data as SuggestResponse,
  });

  /** يملأ النموذج بما يستحقّ تحميلاً فقط — الأصفار ضجيج لا اقتراح */
  const applySuggestion = () => {
    const list = (suggestQ.data?.rows || []).filter(r => r.suggested > 0);
    if (!list.length) { toast.error(tr('لا يوجد ما يقترح تحميله')); return; }
    setRows(list.map(r => {
      // المقترَح بالأساس (٤٨ حبة) يُحمَّل بأكبر وحدةٍ تنقسم عليه تماماً (٢ كرتون)، وإلّا بالأساس كما هو — لا تقريب صامت
      const { choice, qty } = suggestionChoice({ unit: r.unit, units: r.units ?? [] }, r.suggested);
      return {
        rowId: loadRowId(), productId: r.id, name: r.name, unit: choice.name, unitId: choice.id,
        qty: String(qty), suggestedQty: r.suggested,
        // التنبّؤ اليومي — مرجعُ قياس الدقّة؛ suggestedQty كمية تعبئة تتأثر
        // بما في السيارة والهامش فقياسُها يعاقب المحرّك على ما ليس تنبّؤاً
        expectedQty: r.expected,
        lotEdit: null, lotEntry: emptyEntryLot(),
      };
    }));
    setShowSuggest(false);
    toast.success(tr('طبق الاقتراح راجع الكميات قبل الحفظ'));
  };

  // «تتبّع اللوط»: أرصدة تشغيلات أصناف النموذج المتتبَّعة — المستودع (مصادر التحميل) وسيارة المندوب (مصادر التنزيل)
  const trackedIds = [...new Set(rows.filter(r => isTracked(r.productId)).map(r => r.productId))].sort();
  const balQ = useQuery({
    queryKey: ['lot-balances-load', trackedIds.join(',')],
    queryFn: () => fetchLotBalances(trackedIds),
    enabled: lotOn && trackedIds.length > 0,
  });
  const day = balQ.data?.day ?? new Date().toLocaleDateString('en-CA');
  const whViewOf = (productId: string) => balQ.data?.warehouse.find(v => v.productId === productId);
  const vanViewOf = (productId: string) => balQ.data?.vans.find(v => v.salesRepId === repId && v.view.productId === productId)?.view;

  /** مشكلة تشغيلات السطر قبل الحفظ — نصٌّ يُعرض تحته، والسطر غير المتتبَّع بلا مشكلة */
  const lotIssue = (r: LoadRow): string | null => {
    if (!isTracked(r.productId)) return null;
    const q = Number(r.qty);
    if (!q) return null;
    const base = baseOfRow(r);
    if (!isFourDecimals(base)) return tr('كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بوحدة الأساس');
    if (q > 0 && !whOn) return entryProblemText(entryLotProblem(r.lotEntry, { kind: 'INCREASE', expiryRequired: shelfLifeOn(productOf(r.productId)) }), tr);
    if (q > 0) return r.lotEdit ? draftProblemText(draftProblem(r.lotEdit, base, loadSourcesOf(whViewOf(r.productId), day)), tr) : null;
    if (balQ.isLoading) return tr('جار التحميل');
    const sources = outSourcesOf(vanViewOf(r.productId), 'SELLABLE', day);
    if (r.lotEdit) return draftProblemText(draftProblem(r.lotEdit, base, sources), tr);
    return needsExplicitSource(sources) ? tr('للصنف أكثر من تشغيلة في السيارة حدد ما ينزل منه') : null;
  };
  /** حقول التشغيلات في بند الطلب (بالأساس): المعدَّلة صراحةً، أو تشغيلة التحميل المباشر (D4)، وإلا لا شيء فيوزّع الخادم */
  const lotFields = (r: LoadRow) => {
    if (!isTracked(r.productId)) return {};
    const q = Number(r.qty);
    if (q > 0 && !whOn) return directLoadLotFields(r.lotEntry, baseOfRow(r));
    return r.lotEdit ? { lots: draftRefs(r.lotEdit) } : {};
  };

  const save = useMutation({
    mutationFn: async () => {
      // موجب = تحميل للسيارة، سالب = تنزيل للمستودع (يعود بكلفة خروجه).
      //
      // والسالب يُرسَل **بقيمته المطلقة** بنوع UNLOAD لا سالباً كما هو: النوعان يقرآن
      // الإشارة عكسياً — ADJUST يجمع الكمّية كما وردت فالسالب ينقص الرصيد، أمّا UNLOAD
      // فيطرح «المُرجَع» فالسالب فيه **يزيد** رصيد السيارة بدل أن ينقصه. ولأنّ الوثيقة
      // الواحدة تحمل نوعاً واحداً، تُقسَّم الحركة المختلطة إلى وثيقتين. وتشغيلات السطر تتبعه (splitVanMovement).
      const { out, back } = splitVanMovement(
        rows.map(r => ({ productId: r.productId, qty: Number(r.qty), unitId: r.unitId, suggestedQty: r.suggestedQty, expectedQty: r.expectedQty, ...lotFields(r) })),
      );
      const trimmed = note.trim() || undefined;
      const warnings: LotWarning[] = [];
      if (out.length) {
        const res = await vanStockApi.createLoad({ salesRepId: repId, type: 'LOAD', note: trimmed, items: out });
        warnings.push(...lotWarningsOf((res?.data as { warnings?: unknown } | undefined)?.warnings));
        // وثيقة التحميل كُتبت فعلاً: تُسقَط أسطرها فوراً كي لا تُكتب مرّتين لو سقط التنزيل بعدها وأعاد المستخدم المحاولة
        // (نمط MRepLoad — كانت هذه الشاشة تعيد إرسال التحميل كله مع كل محاولة)
        setRows(rs => rs.filter(r => !(Number(r.qty) > 0)));
      }
      if (back.length) {
        const res = await vanStockApi.createLoad({ salesRepId: repId, type: 'UNLOAD', note: trimmed, items: back });
        warnings.push(...lotWarningsOf((res?.data as { warnings?: unknown } | undefined)?.warnings));
      }
      return warnings;
    },
    onSuccess: (warnings) => {
      invalidateAfterMove();
      toast.success(tr('تم حفظ الحركة'));
      // تحذيرات اللوط لا تمنع (أكثر من تشغيلة في السيارة، صرفٌ من غير المسمّى، وحدةٌ مقسومة) — تُقال بعد الحفظ مرةً لكل رمز
      for (const code of new Set(warnings.map(w => w.code))) toast(tr(LOT_WARNING_LABELS[code]), { icon: '⚠️' });
      onClose();
    },
    onError: (e: unknown) => {
      // حتى الفشل يُبطِل المفاتيح: الشقّ الأوّل من الحركة المختلطة قد يكون كُتب
      invalidateAfterMove();
      toast.error(lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ'));
    },
  });
  function invalidateAfterMove() {
    qc.invalidateQueries({ queryKey: ['van-summary'] });
    qc.invalidateQueries({ queryKey: ['van-current'] });
    qc.invalidateQueries({ queryKey: ['van-movements'] });
    // «لوكيشن»: التحميل الجديد مختومٌ بموقع مندوبه — سجلّ التحميلات وملخّص المواقع يتبعانه
    qc.invalidateQueries({ queryKey: ['van-loads-log'] });
    qc.invalidateQueries({ queryKey: ['locations-summary'] });
    if (lotOn) ['van-lot-balances', 'lot-balances-load', 'lot-balances-van', 'lot-balances-wh', 'lot-fefo'].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  }

  const valid = !!repId && rows.length > 0 && rows.every(r => { const q = Number(r.qty); return !Number.isNaN(q) && q !== 0 && !lotIssue(r); });

  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-lg font-bold text-[#1F1A13] flex items-center gap-2"><ArrowDownToLine size={20} className="text-[#E15A30]" /> {tr('تحميل / تنقيص مخزون السيارة')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label className="label">{tr('المندوب')}</label>
            <SearchableSelect
              options={(repsQ.data || []).map(r => ({ value: r.id, label: r.name }))}
              value={repId} onChange={changeRep} placeholder={tr('اختر المندوب')} />
          </div>
          <div>
            <label className="label">{tr('إضافة صنف')}</label>
            <SearchableSelect
              options={(prodQ.data || []).filter(p => !rows.some(r => r.productId === p.id)).map(p => ({ value: p.id, label: p.name, hint: `${p.code} · ${p.unit}` }))}
              value="" onChange={addProduct} resetOnSelect placeholder={tr('ابحث وأضف صنفا')} searchPlaceholder={tr('اكتب اسم/كود الصنف')} />
          </div>

          {/* ─────────── التحميل المقترح ───────────
              موضعه هنا لا في لوحة منفصلة: الاقتراح قرار يُتّخذ لحظة التحميل،
              ولوحة توقّعات مستقلّة تُقرأ مرّة وتُنسى. */}
          <div className="border border-[#E9E1D3] rounded-xl overflow-hidden">
            <button type="button" onClick={() => setShowSuggest(v => !v)} disabled={!repId}
              className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#FBEBE2] disabled:opacity-50 text-start">
              <span className="text-sm font-bold text-[#1F1A13] flex items-center gap-2">
                <Sparkles size={15} className="text-[#E15A30]" />
                {tr('التحميل المقترح')}
              </span>
              <span className="text-[11px] text-[#6E6557]">
                {repId ? (showSuggest ? tr('إخفاء') : tr('اعرض اقتراحا من تاريخ مبيعاته')) : tr('اختر المندوب أولا')}
              </span>
            </button>

            {showSuggest && (
              <div className="p-3.5 space-y-3">
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="w-32">
                    <label className="label !mb-1 !text-[11px]">{tr('نافذة التاريخ يوم')}</label>
                    <input type="number" min={7} max={180} value={windowDays}
                      onChange={e => setWindowDays(Math.min(180, Math.max(7, Number(e.target.value) || 28)))}
                      className="input py-1.5 text-center" />
                  </div>
                  <div className="w-32">
                    <label className="label !mb-1 !text-[11px]">{tr('هامش أمان %')}</label>
                    <input type="number" min={0} max={100} value={bufferPct}
                      onChange={e => setBufferPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
                      className="input py-1.5 text-center" />
                  </div>
                  <button type="button" onClick={applySuggestion}
                    disabled={suggestQ.isLoading || !(suggestQ.data?.rows || []).some(r => r.suggested > 0)}
                    className="btn-primary py-2 px-3.5 text-sm disabled:opacity-50">{tr('املأ النموذج بالاقتراح')}</button>
                </div>

                {suggestQ.isLoading && <p className="text-xs text-[#9A8F7E]">{tr('يحسب')}</p>}
                {suggestQ.isError && <p className="text-xs text-red-600">{tr('تعذر حساب الاقتراح')}</p>}

                {/* التحذير يُعرض كما هو من الخادم — إخفاء رقّة البيانات خداع */}
                {suggestQ.data?.meta.warning && (
                  <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <AlertTriangle size={12} className="inline -mt-0.5 me-1" />{suggestQ.data.meta.warning}
                  </p>
                )}

                {suggestQ.data && (
                  <>
                    <p className="text-[11px] text-[#6E6557]">
                      {tr('بناء على')} <b>{suggestQ.data.meta.dataDays}</b> {tr('يوما فيها مبيعات خلال آخر')}{' '}
                      <b>{suggestQ.data.meta.windowDays}</b> {tr('يوما')}
                      {suggestQ.data.meta.oldestSale && <> · {tr('أقدم بيعة')} {suggestQ.data.meta.oldestSale}</>}
                    </p>
                    <div className="max-h-56 overflow-y-auto border border-[#F1EBDF] rounded-lg divide-y divide-[#F1EBDF]">
                      {suggestQ.data.rows.filter(r => r.suggested > 0).map(r => (
                        <div key={r.id} className="px-3 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              <ConfidenceTag c={r.confidence} />
                              {/* بالأساس: لصنفٍ له وحدات مفكَّكاً «٢ كرتون» — رقم الأساس بجانب اسمه وحده لغيره كما كان */}
                              {hasBigUnit(r.units)
                                ? <b className="text-sm text-[#E15A30]">{baseQtyText(r.suggested, r, fmtQty)}</b>
                                : <><b className="text-sm text-[#E15A30]">{r.suggested}</b><span className="text-[10px] text-[#9A8F7E]">{r.unit}</span></>}
                            </span>
                          </div>
                          {/* «لماذا هذا الرقم» — الاقتراح غير القابل للشرح يُرفض أول خطأ */}
                          <p className="text-[10px] text-[#9A8F7E] mt-0.5 leading-relaxed">{r.why}</p>
                        </div>
                      ))}
                      {!suggestQ.data.rows.some(r => r.suggested > 0) && (
                        <p className="px-3 py-3 text-xs text-[#9A8F7E]">
                          {tr('لا يوجد ما يقترح تحميله إما لا مبيعات سابقة أو السيارة تغطي المتوقع أصلا')}
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <p className="text-[11px] text-[#9A8F7E] bg-[#FAF7F0] rounded-lg px-3 py-2">{tr('أدخل كمية موجبة للتحميل أو سالبة للتنقيص استخدم زر ± أو اكتب مثل ‎-5')}</p>
          {rows.length > 0 && (
            <div className="border border-[#F1EBDF] rounded-xl divide-y divide-[#F1EBDF]">
              {rows.map(r => {
                const neg = Number(r.qty) < 0;
                const choices = unitChoices(productOf(r.productId));
                const tracked = isTracked(r.productId);
                return (
                <div key={r.rowId} className="p-2.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                      <p className={`text-[10px] ${neg ? 'text-red-500 font-semibold' : 'text-[#9A8F7E]'}`}>{neg ? tr('تنقيص') : r.unit}</p>
                    </div>
                    {/* منتقي وحدة الصفّ — لصنفٍ له وحدات وحده؛ الكمية بالوحدة المختارة تحميلاً كانت أو تنقيصاً */}
                    {choices.length > 1 && (
                      <select className="input w-auto py-1.5 text-xs" value={r.unitId ?? ''} aria-label={tr('الوحدة')}
                        onChange={e => setRowUnit(r.rowId, e.target.value || null)}>
                        {choices.map(c => <option key={c.id ?? 'base'} value={c.id ?? ''}>{c.name}{c.factor > 1 ? ` (${c.factor})` : ''}</option>)}
                      </select>
                    )}
                    <button type="button" title={tr('عكس الإشارة تحميل/تنقيص')}
                      onClick={() => patchRow(r.rowId, { qty: String(-(Number(r.qty) || 0)), lotEdit: null })}
                      className="w-9 h-9 rounded-lg border border-[#E9E1D3] text-base font-bold text-[#6E6557] shrink-0 hover:bg-gray-50">±</button>
                    <input type="number" step="any" value={r.qty}
                      onChange={e => patchRow(r.rowId, { qty: e.target.value })}
                      className={`input w-24 text-center py-1.5 ${neg ? 'border-red-300 text-red-600 font-bold' : ''}`} />
                    <button onClick={() => setRows(rs => rs.filter(x => x.rowId !== r.rowId))} className="text-red-400 hover:text-red-600 p-1"><Trash2 size={16} /></button>
                  </div>
                  {/* «تتبّع اللوط»: اقتراح FEFO قابل للتعديل والتقسيم للتحميل، ومصدرٌ صريح للتنزيل، وتشغيلةٌ للتحميل المباشر */}
                  {tracked && Number(r.qty) !== 0 && !Number.isNaN(Number(r.qty)) && (
                    <LoadRowLots row={r} repId={repId} whOn={whOn} factor={factorOfRow(r)} baseQty={baseOfRow(r)}
                      baseUnit={productOf(r.productId)?.unit} whView={whViewOf(r.productId)} vanView={vanViewOf(r.productId)} day={day}
                      balLoading={balQ.isLoading} expiryRequired={shelfLifeOn(productOf(r.productId))} issue={lotIssue(r)}
                      onPatch={p => patchRow(r.rowId, p)} />
                  )}
                </div>
                );
              })}
            </div>
          )}

          <div>
            <label className="label">{tr('ملاحظة اختياري')}</label>
            <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder={tr('مثال تحميل صباح اليوم من المستودع')} />
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={!valid || save.isPending} className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownToLine size={16} />}
            {tr('حفظ الحركة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}

/** ردّ GET /lots/fefo (routes/lots.ts): صفوف الاقتراح لكل الأسطر، والنقص إن وُجد، والتحذيرات — وwarehouse=false بلا مستودع */
interface FefoResponse { rows: AllocRowDto[]; shortage?: LotShortageDetail; warnings: LotWarning[]; warehouse?: boolean; tracked?: boolean }

/** تشغيلات سطرٍ في نافذة التحميل — كل الكميات بالأساس */
function LoadRowLots({ row, repId, whOn, factor, baseQty, baseUnit, whView, vanView, day, balLoading, expiryRequired, issue, onPatch }: {
  row: LoadRow; repId: string; whOn: boolean; factor: number; baseQty: number; baseUnit?: string;
  whView?: PlaceViewWithAvailability; vanView?: PlaceViewWithAvailability; day: string; balLoading: boolean;
  expiryRequired: boolean; issue: string | null; onPatch: (p: Partial<LoadRow>) => void;
}) {
  const tr = useTr();
  const load = baseQty > 0;
  // الاقتراح يتبع الكمية بعد سكونها قليلاً — لا طلب لكل حرف
  const [qtyKey, setQtyKey] = useState(baseQty);
  useEffect(() => { const t = setTimeout(() => setQtyKey(baseQty), 350); return () => clearTimeout(t); }, [baseQty]);
  const fefoQ = useQuery({
    queryKey: ['lot-fefo', row.productId, qtyKey, factor, repId],
    queryFn: async () => {
      // unitFactor لقاعدة الكرتون (D22): كراتين كاملة من تشغيلةٍ واحدة أولاً
      const params = { productId: row.productId, qty: qtyKey, salesRepId: repId || undefined, unitFactor: factor };
      return (await lotsApi.fefo(params)).data.data as FefoResponse;
    },
    enabled: whOn && load && qtyKey > 0 && isFourDecimals(qtyKey) && row.lotEdit === null,
    staleTime: 15_000,
  });
  const lotName = (lotId: string | null) => (lotId === null ? tr('غير مسمى') : whView?.lots.find(l => l.lotId === lotId)?.meta.lotNumber ?? '—');

  // التحميل المباشر بلا مستودع (D4): تشغيلةٌ صريحة أو جديدة أو «غير مسمّى»
  if (load && !whOn) {
    return (
      <EntryLotFields productId={row.productId} kind="INCREASE" value={row.lotEntry} onChange={d => onPatch({ lotEntry: d })}
        expiryRequired={expiryRequired} problem={issue ? entryLotProblem(row.lotEntry, { kind: 'INCREASE', expiryRequired }) : null} />
    );
  }

  const sources = load ? loadSourcesOf(whView, day) : outSourcesOf(vanView, 'SELLABLE', day);
  const box = 'mt-1.5 rounded-lg border border-[#F1EBDF] bg-[#FAF7F0] px-2 py-1.5 space-y-1';
  // المسوّدة المعدَّلة: محرّر الصفوف على مصادر المكان
  if (row.lotEdit !== null) {
    return (
      <div className={box}>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold text-[#6E6557] flex items-center gap-1"><Layers size={11} className="text-[#E15A30]" />
            {load ? tr('توزيع التحميل على التشغيلات') : tr('التشغيلات التي ينزل منها')}</span>
          {(load || !needsExplicitSource(sources)) && (
            <button type="button" onClick={() => onPatch({ lotEdit: null })} className="text-[10px] font-semibold text-[#E15A30]">
              {load ? tr('العودة إلى الاقتراح') : tr('تلقائي')}
            </button>
          )}
        </div>
        <LotRowsEditor rows={row.lotEdit} onChange={rs => onPatch({ lotEdit: rs })} sources={sources} lineBaseQty={baseQty} baseUnit={baseUnit} />
        {issue && <p className="text-[10px] text-red-600">{issue}</p>}
      </div>
    );
  }
  // التنزيل بلا مسوّدة: المصدر الوحيد تلقائياً، والمتعدّد يلزمه اختيارٌ صريح (D10)
  if (!load) {
    if (balLoading) return <p className="mt-1 text-[10px] text-[#9A8F7E]">{tr('جار التحميل')}</p>;
    return (
      <div className={box}>
        {needsExplicitSource(sources) ? (
          <>
            <p className="text-[10px] text-amber-700 font-semibold">{tr('للصنف أكثر من تشغيلة في السيارة حدد ما ينزل منه')}</p>
            <LotRowsEditor rows={[]} onChange={rs => onPatch({ lotEdit: rs })} sources={sources} lineBaseQty={baseQty} baseUnit={baseUnit} />
          </>
        ) : (
          <p className="text-[10px] text-[#6E6557]">
            {sources.length === 1 ? `${tr('ينزل من المصدر الوحيد')}: ${sourceLabel(sources[0], tr)}` : tr('لا رصيد تشغيلات لهذا الصنف في السيارة')}
          </p>
        )}
      </div>
    );
  }
  // التحميل من المستودع: اقتراح FEFO من الخادم (بلا قفل؛ يعاد التحقق عند الحفظ) قابلٌ للتعديل والتقسيم
  const f = fefoQ.data;
  const multi = hasMultiLotWarning(f?.warnings, row.productId);
  return (
    <div className={box}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold text-[#6E6557] flex items-center gap-1"><Layers size={11} className="text-[#E15A30]" /> {tr('اقتراح التشغيلات الأقرب انتهاء أولا')}</span>
        <button type="button" disabled={!f || balLoading}
          onClick={() => onPatch({ lotEdit: f && f.rows.length ? draftFromRows(f.rows) : [] })}
          className="text-[10px] font-semibold text-[#E15A30] disabled:opacity-40">{tr('تعديل التوزيع')}</button>
      </div>
      {fefoQ.isLoading || (fefoQ.isFetching && !f) ? <p className="text-[10px] text-[#9A8F7E]">{tr('يحسب')}</p>
        : fefoQ.isError ? <p className="text-[10px] text-red-600">{lotErrorOf(fefoQ.error)?.message || tr('تعذر حساب الاقتراح')}</p>
          : f && (
            <>
              <div className="flex flex-wrap gap-1">
                {f.rows.map((a, i) => (
                  <span key={i} className={`text-[10px] rounded border px-1.5 py-0.5 ${a.lotId === null ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-white border-[#E9E1D3] text-[#1F1A13]'}`}>
                    {lotName(a.lotId)}{a.expiryDate ? ` · ${tr('ينتهي')} ${formatDayOnly(a.expiryDate)}` : ''} ×<b>{fmtLotQty(a.qty)}</b>
                  </span>
                ))}
              </div>
              {f.shortage && (
                <p className="text-[10px] text-red-600 font-semibold">
                  {tr('المتاح في تشغيلات المستودع أقل من المطلوب')}: {fmtLotQty(f.shortage.available)} / {fmtLotQty(f.shortage.wanted)}{baseUnit ? ` ${baseUnit}` : ''}
                </p>
              )}
              {/* تحذير اللوطين: بعد التحميل تحمل السيارة أكثر من تشغيلة للصنف — يُقال قبل الحفظ */}
              {multi && <p className="text-[10px] text-amber-700 flex items-center gap-1"><AlertTriangle size={10} /> {tr(LOT_WARNING_LABELS.LOT_MULTI_IN_VAN)}</p>}
              {f.warnings.filter(w => w.code !== 'LOT_MULTI_IN_VAN').map((w, i) => (
                <p key={i} className="text-[10px] text-amber-700">{tr(LOT_WARNING_LABELS[w.code])}</p>
              ))}
            </>
          )}
      {issue && <p className="text-[10px] text-red-600">{issue}</p>}
    </div>
  );
}

/** سطرٌ في تفصيل تشغيلات السيارة — من اللقطة الآن أو من /lots/balances في تاريخ */
interface VanLotLine { lotId: string; lotNumber: string; expiryDate: string | null; status: LotStatus; blockKind: LotBlockKind | null; usable: number }

/**
 * تفصيل صفّ السيارة بتشغيلاته: الصالح لكل تشغيلة وحالتها، وغير المسمّى، والمعزول والمحجوز والمنتهي غير المباع. والآن (لا في تاريخ):
 * إتلاف التشغيلة المنتهية غير المباعة، وتنزيل الموقوفة للمستودع.
 */
function VanLotsDetail({ productId, productName, repId, row, snap, snapLoading, asOf, onAction, busy }: {
  productId: string; productName: string; repId: string; row: StockRow; snap?: VanLotSnapshotDto; snapLoading: boolean; asOf: string;
  onAction: (a: LotAction) => void; busy: boolean;
}) {
  const tr = useTr();
  // «المخزون في تاريخ»: أرصدة التشغيلات بنهاية «إلى تاريخ» من /lots/balances (مرشّحات المستودع نفسها)
  const histQ = useQuery({
    queryKey: ['lot-balances-van', productId, asOf],
    queryFn: async () => (await lotsApi.balances({ productId, asOf })).data.data as LotBalancesResponse,
    enabled: !!asOf,
  });
  const q = (n: number) => baseQtyText(n, row, fmtLotQty);
  let lines: VanLotLine[] = [];
  let unknown = 0, held = 0, quarantined = 0, day = snap?.day ?? '';
  if (asOf) {
    if (histQ.isLoading) return <p className="text-xs text-[#9A8F7E]">{tr('جار التحميل')}</p>;
    if (histQ.isError) return <p className="text-xs text-red-600">{tr('تعذر تحميل الأرصدة')}</p>;
    const view = histQ.data?.vans.find(v => v.salesRepId === repId)?.view;
    day = histQ.data?.day ?? asOf;
    lines = (view?.lots ?? []).map(l => ({ lotId: l.lotId, lotNumber: l.meta.lotNumber, expiryDate: l.meta.expiryDate, status: l.meta.status, blockKind: l.meta.blockKind, usable: l.usable.SELLABLE }))
      .filter(l => Math.abs(l.usable) > 1e-6);
    unknown = view?.unknownUsable?.SELLABLE ?? 0;
    held = view?.availability?.held ?? 0;
    quarantined = (view?.availability?.quarantined ?? 0) + (view?.availability?.expiredUnsold ?? 0);
  } else {
    if (snapLoading) return <p className="text-xs text-[#9A8F7E]">{tr('جار التحميل')}</p>;
    const p = snap?.products.find(x => x.productId === productId);
    lines = p?.lots ?? [];
    unknown = p?.unknownUsable ?? 0;
    held = p?.held ?? 0;
    quarantined = (p?.quarantined ?? 0) + (p?.expiredUnsold ?? 0);
  }
  return (
    <div className="space-y-1.5">
      {asOf && <p className="text-[10px] text-[#9A8F7E]">{tr('الأرصدة كما في نهاية يوم')} {formatDayOnly(asOf)}</p>}
      {lines.length === 0 && Math.abs(unknown) <= 1e-6 ? (
        <p className="text-xs text-[#9A8F7E]">{tr('لا رصيد تشغيلات لهذا الصنف في السيارة')}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[#9A8F7E]">
              <th className="text-start font-semibold py-1">{tr('رقم التشغيلة')}</th>
              <th className="text-center font-semibold py-1">{tr('تاريخ الانتهاء')}</th>
              <th className="text-center font-semibold py-1">{tr('الحالة')}</th>
              <th className="text-center font-semibold py-1">{tr('الرصيد')}</th>
              {!asOf && <th className="py-1" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-[#F1EBDF]">
            {lines.map(l => {
              const expired = isLotExpiredOn(l, day);
              const blocked = l.status === 'BLOCKED';
              return (
                <tr key={l.lotId}>
                  <td className="py-1 font-semibold text-[#1F1A13]">{l.lotNumber}</td>
                  <td className={`py-1 text-center ${expired ? 'text-red-600 font-semibold' : 'text-[#6E6557]'}`}>{l.expiryDate ? formatDayOnly(l.expiryDate) : '—'}</td>
                  <td className="py-1 text-center">
                    {blocked
                      ? <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr(l.blockKind ? LOT_BLOCK_KIND_LABELS[l.blockKind] : LOT_STATUS_LABELS.BLOCKED)}</span>
                      : expired ? <span className="rounded bg-amber-50 border border-amber-200 text-amber-700 px-1">{tr('منتهية لم تبع')}</span>
                        : <span className="text-[#1E7A52]">{tr(LOT_STATUS_LABELS.ACTIVE)}</span>}
                  </td>
                  <td className={`py-1 text-center font-bold ${l.usable < -1e-6 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{q(l.usable)}</td>
                  {!asOf && (
                    <td className="py-1 text-end whitespace-nowrap">
                      {l.usable > 1e-6 && !blocked && expired && (
                        <button type="button" disabled={busy}
                          onClick={() => onAction({ kind: 'DESTROY', productId, productName, lotId: l.lotId, lotNumber: l.lotNumber, qty: roundLot(l.usable) })}
                          className="text-[10px] font-semibold text-red-600 border border-red-200 rounded-md px-1.5 py-0.5 hover:bg-red-50 disabled:opacity-50">
                          {tr('إتلاف')}
                        </button>
                      )}
                      {l.usable > 1e-6 && blocked && (
                        <button type="button" disabled={busy}
                          onClick={() => onAction({ kind: 'UNLOAD', productId, productName, lotId: l.lotId, lotNumber: l.lotNumber, qty: roundLot(l.usable) })}
                          className="text-[10px] font-semibold text-amber-700 border border-amber-200 rounded-md px-1.5 py-0.5 hover:bg-amber-50 disabled:opacity-50">
                          {tr('تنزيل')}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {Math.abs(unknown) > 1e-6 && (
              <tr>
                <td className="py-1 font-semibold text-[#6E6557]">{tr('غير مسمى')}</td>
                <td className="py-1 text-center text-[#9A8F7E]">—</td>
                <td className="py-1 text-center">{unknown < 0 && <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr('عجز غير مسمى')}</span>}</td>
                <td className={`py-1 text-center font-bold ${unknown < 0 ? 'text-red-600' : 'text-[#6E6557]'}`}>{q(unknown)}</td>
                {!asOf && <td />}
              </tr>
            )}
          </tbody>
        </table>
      )}
      {(quarantined > 1e-6 || held > 1e-6) && (
        <p className="text-[10px] text-[#6E6557]">
          {quarantined > 1e-6 && <>{tr('معزول')} {q(quarantined)}</>}
          {quarantined > 1e-6 && held > 1e-6 && ' · '}
          {held > 1e-6 && <>{tr('محجوز')} {q(held)} ({tr('بانتظار الاعتماد')})</>}
          {' — '}{tr('ضمن المتبقي ولا يباع')}
        </p>
      )}
    </div>
  );
}

/**
 * إزالة المنتهي صلاحيته (EXPIRED_OUT) أو المرتجع التالف (DAMAGED_OUT) من سيارة المندوب — نافذةٌ بدل window.prompt. الكمية بالأساس
 * (بلا unitId)، والافتراضي كامل الرصيد. وللصنف المتتبَّع: المصدر الوحيد في الدلو تلقائي، والمتعدّد يلزمه اختيارٌ صريح (D10).
 */
function RemoveOutModal({ row, kind, repId, tracked, onDone, onClose }: {
  row: StockRow; kind: OutKind; repId: string; tracked: boolean; onDone: () => void; onClose: () => void;
}) {
  const tr = useTr();
  const have = (kind === 'EXPIRED_OUT' ? row.expired : row.damaged) ?? 0;
  const [qty, setQty] = useState(String(roundLot(have)));
  const [draft, setDraft] = useState<LotRowDraft[] | null>(null);
  const bucket = kind === 'EXPIRED_OUT' ? 'EXPIRED' : 'DAMAGED';
  const balQ = useQuery({
    queryKey: ['lot-balances-van', row.productId, ''],
    queryFn: async () => (await lotsApi.balances({ productId: row.productId })).data.data as LotBalancesResponse,
    enabled: tracked,
  });
  const view = balQ.data?.vans.find(v => v.salesRepId === repId)?.view;
  const sources = tracked ? outSourcesOf(view, bucket, balQ.data?.day ?? '') : [];
  const explicit = tracked && needsExplicitSource(sources);
  const n = Number(qty);
  const qtyOk = n > 0 && n <= have + 1e-9 && (!tracked || isFourDecimals(n));
  const problem = explicit ? draftProblem(draft ?? [], n, sources) : null;
  const save = useMutation({
    mutationFn: () => vanStockApi.createLoad({
      salesRepId: repId, type: kind,
      note: kind === 'EXPIRED_OUT' ? tr('إزالة منتهي الصلاحية') : tr('إزالة مرتجع تالف'),
      items: [{ productId: row.productId, qty: n, ...(explicit && draft ? { lots: draftRefs(draft) } : {}) }],
    }),
    onSuccess: () => {
      toast.success(kind === 'EXPIRED_OUT' ? tr('أزيل المنتهي صلاحيته من السيارة') : tr('أزيل التالف من السيارة'));
      onDone();
      onClose();
    },
    onError: (e: unknown) => toast.error(lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ')),
  });
  return (
    <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center p-4" dir="rtl" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-[#E9E1D3]">
          <h2 className="text-base font-bold text-[#1F1A13] flex items-center gap-2">
            <Trash2 size={18} className="text-[#E15A30]" /> {kind === 'EXPIRED_OUT' ? tr('إزالة منتهي الصلاحية') : tr('إزالة مرتجع تالف')}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <p className="text-sm font-semibold text-[#1F1A13]">{row.name}</p>
          <p className="text-xs text-[#6E6557]">{tr('الرصيد')}: <b>{baseQtyText(have, row, fmtQty)}</b></p>
          <div>
            <label className="label">{kind === 'EXPIRED_OUT' ? tr('كمية منتهي الصلاحية المراد إزالتها من السيارة') : tr('كمية التالف المراد إزالتها من السيارة')}</label>
            <input type="number" step="any" min="0" inputMode="decimal" className="input" value={qty} onChange={e => { setQty(e.target.value); }} />
            {/* الكمية بالأساس دائماً — «٢» لصنفٍ له كرتون حبّتان لا كرتونان */}
            {hasBigUnit(row.units) && <p className="text-[10px] text-[#9A8F7E] mt-1">{tr('بوحدة الأساس')} {row.unit}</p>}
            {qty !== '' && !qtyOk && <p className="text-[10px] text-red-600 mt-1">{tr('الكمية غير صالحة')}</p>}
          </div>
          {tracked && (
            balQ.isLoading ? <p className="text-[10px] text-[#9A8F7E]">{tr('جار التحميل')}</p> : (
              <div className="rounded-lg border border-[#F1EBDF] bg-[#FAF7F0] px-2 py-1.5 space-y-1">
                <p className="text-[10px] font-semibold text-[#6E6557] flex items-center gap-1"><Layers size={11} className="text-[#E15A30]" /> {tr('التشغيلات التي تزال منها')}</p>
                {explicit ? (
                  <LotRowsEditor rows={draft ?? []} onChange={setDraft} sources={sources} lineBaseQty={n || 0} baseUnit={row.unit}
                    problem={qtyOk ? problem : null} />
                ) : (
                  <p className="text-[10px] text-[#6E6557]">{sources.length === 1 ? `${tr('من المصدر الوحيد')}: ${sourceLabel(sources[0], tr)}` : tr('لا رصيد تشغيلات في هذا الرصيد')}</p>
                )}
              </div>
            )
          )}
        </div>
        <div className="flex gap-3 p-5 border-t border-[#E9E1D3]">
          <button onClick={() => save.mutate()} disabled={!qtyOk || !!problem || (tracked && balQ.isLoading) || save.isPending}
            className="btn-primary flex-1 justify-center py-2.5 disabled:opacity-60">
            {save.isPending ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Trash2 size={16} />}
            {tr('إزالة')}
          </button>
          <button onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
