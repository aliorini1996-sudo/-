import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Trash2, Loader2, Package, Truck, Sparkles, AlertTriangle,
  ArrowDownToLine, TrendingDown, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { vanStockApi, productApi, lotsApi } from '../api/client';
import { SalesRep } from '../types';
import { activeLocale, formatDate, formatTime, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { primaryUnitOf, type UnitDef } from '../lib/units';
import { unitChoices, defaultChoice, rebaseRow } from '../rep/repUnits';
import { productUnitLabel } from '../lib/adminUnits';
import { splitVanMovement } from '../lib/vanMovement';
import {
  lotFlagsOf, lotWarningsOf, lotRowsRemaining, roundLot, LOT_EPS, LOT_WARNING_LABELS, LOT_STATUS_LABELS,
  type LotRef, type LotWarning, type VanLotSnapshotDto, type AllocRowDto, type LotShortageDetail,
} from '../lib/lots';
import { MCard, MRow, MStat, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import {
  nextStockLineUnit, stockLineUnit, suggestionLine, movementQtyText, qtyText, hasBigUnit,
  type StockLineUnit,
} from './mUnits';
import {
  newRowId, shelfLifeOn, resolveShelfOn, emptyLotDraft, lotDraftProblem, loadLotFields, lineBaseQty, fefoLinesParam,
  vanOutSources, prefillOutLines, sourcesLeftFor, outGroupProblems, setOutQty, lotLineLabel, lotQtyText, LOT_CACHE_KEYS, VAN_OUT_PROBLEMS,
  type LotDraft, type OutSource,
} from './mLotsLogic';
import MUnitChips from './MUnitChips';
import MLotFields, { useProductLots } from './MLotFields';
import { anyPrimary, fill, qtyTotalLabel, refetchUnitsOn, withBaseUnitName, backWithBaseNames } from './mPrimaryUnit';

/**
 * تسجيل تحميل بضاعة لسيارة مندوب — من تطبيق الإدارة على الجوال.
 *
 * ⚠️ **الإشارة**: الموجب تحميلٌ للسيارة والسالب تنزيلٌ للمستودع، والنوعان
 * يقرآن الإشارة **عكسياً** في الخادم. فالتقسيم والقلب يُتركان لـ`splitVanMovement`
 * وحدها (اقرأ تعليقاتها؛ و`splitLoadRows` في mUnits.ts غلافٌ رقيق عليها) — منطقُ
 * تقسيمٍ ثانٍ هنا يعني قاعدتين تتباعدان مع الوقت، وأثرُ خطئه صامت: رصيدُ سيارةٍ
 * ينقلب في الاتجاه المعاكس بلا رسالة.
 *
 * ⚠️ **الوحدات المتعددة**: السطر **بوحدته** (كرتون أو حبة) و`unitId` يُرسَل معه فيحلّ
 * الخادم معامله — بلاه يُسجَّل تحميل خمسين كرتوناً خمسين حبّة. وصنفٌ يُحمَّل بوحدتين
 * سطران. أمّا الرصيد والمقترح فبالأساس من الخادم، فيُعرضان «٢ كرتون و٣ حبة» لا رقماً
 * بجانب اسم وحدة السطر (رقم الحبّات بجانب «كرتون» يقود إلى تحميلٍ خاطئ ٢٤ ضعفاً).
 *
 * ولماذا الكمّية إدخالٌ حرّ لا أزرار ±١: التحميل الصباحي خمسون كرتوناً، وخمسون
 * نقرة في المستودع تعني أن يُكتَب الرقم في دفتر ورقيّ بدل التطبيق.
 */

interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
  /** «منتهي الصلاحية» في السيارة — لا يُباع ولا يدخل المتبقّي، وتزيله الإدارة من لوحة مخزون السيارات */
  expired?: number;
  /** «المرتجع التالف» في السيارة — لا يُباع ولا يدخل المتبقّي، وتزيله الإدارة من لوحة مخزون السيارات */
  damaged?: number;
  /** وحدات الصنف — كل كميات الصفّ بالأساس، وتُعرض بها «٢ كرتون و٣ حبة» */
  units?: UnitDef[];
  /** «الوحدة الرئيسية» (القاعدة ١٢): عرضٌ وافتراضٌ فقط — الرصيد «52 كرتون و2 قارورة»، وسطر التحميل الأول بها */
  primaryUnitId?: string | null;
}

interface ProductPick {
  id: string; name: string; code?: string; unit?: string; units?: UnitDef[]; primaryUnitId?: string | null;
  /** «تتبّع اللوط»: علم الصنف وصلاحيته (إلزام انتهاء التشغيلة الجديدة في شركة بلا مستودع) */
  lotTracked?: boolean; shelfLifeEnabled?: boolean; shelfLifeValue?: number | null; shelfLifeUnit?: string | null;
}

/** استجابة /van-stock/suggest — تطابق SuggestResult في الخادم */
interface SuggestRow {
  id: string; name: string; code: string; unit: string;
  expected: number; withBuffer: number; onVan: number; suggested: number;
  basis: 'weekday' | 'overall' | 'none';
  sampleDays: number; activeDays: number;
  confidence: 'high' | 'medium' | 'low';
  why: string;
  /** وحدات الصنف — الأرقام كلّها بالأساس */
  units?: UnitDef[];
  /** الوحدة الرئيسية — الاقتراح يُحمَّل بها حين تقسمه (suggestionLine) ويُعرض بها */
  primaryUnitId?: string | null;
}
interface SuggestResponse {
  rows: SuggestRow[];
  meta: {
    targetDate: string; weekday: number; windowDays: number; bufferPct: number;
    dataDays: number; oldestSale: string | null; warning: string | null;
  };
  salesRep: { id: string; name: string };
}

interface Movement {
  kind: string; date: string; ref: string; by: string | null;
  /** `unit` لقطة وحدة البند و`qty` بها، و`baseQty` كميته بالأساس — لمن يجمع بنوداً تختلف وحداتها.
   *  و`lots` صفوف تشغيلات البند (withLots=1 والميزة مفعّلة وحدها) — للإشعار المطبوع */
  items: { name: string; unit: string; qty: number; baseQty?: number | null; lots?: unknown }[];
}

/**
 * سطر النموذج — الكمّية نصّ لا رقم: «-» و«» حالتا كتابةٍ وسيطتان يمسحهما Number.
 * والكمية **بوحدة السطر** (`unit`/`unitId`)، و`suggestedQty`/`expectedQty` بالأساس دائماً (DESIGN «قرارات أثناء التنفيذ»).
 * و`rowId` هويّته: صنفٌ متتبَّع قد يأخذ سطرين بالوحدة نفسها (لكل تشغيلةٍ سطر)، فلا يكفي (الصنف، الوحدة) مفتاحاً.
 */
interface Row extends StockLineUnit {
  rowId: string;
  productId: string; name: string; qty: string;
  suggestedQty?: number; expectedQty?: number;
  /** «تتبّع اللوط»: انتهاء التشغيلة الجديدة إلزامي (شركة بلا مستودع، D4) — معروفٌ للمضاف من قائمة الأصناف وحده؛ وغائبٌ
   *  (مخزون السيارة، الاقتراح) ⇒ يُجلب من بطاقة الصنف حين تُختار «تشغيلة جديدة» (resolveShelfOn) */
  shelfOn?: boolean;
  /** تشغيلة التحميل في شركة بلا مستودع (D4) — سطرٌ = تشغيلة */
  lot?: LotDraft;
  /** توزيع التنزيل على مصادر السيارة بالأساس — غائبٌ ⇒ التوزيع الأوّلي (prefillOut) */
  outLots?: LotRef[];
  /** «الوحدة الرئيسية» للصنف كما عرفها كتالوج الشاشة حين أُضيف السطر — عرض الرصيد بها وحده، لا يدخل الجسم (D1) */
  primaryUnitId?: string | null;
}

/** ردّ GET /lots/fefo — لكل سطرٍ صفوفه بترتيب الأسطر المرسلة */
interface FefoResp {
  rows: AllocRowDto[]; lines?: { idx: number; rows: AllocRowDto[] }[];
  shortage?: LotShortageDetail; warnings: LotWarning[];
}

/** قيمةٌ تستقرّ بعد مهلة — لاقتراح FEFO: لا طلب شبكةٍ لكل رقمٍ يُكتب في الكمية */
function useSettled<T>(v: T, ms: number): T {
  const [s, setS] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setS(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return s;
}

const KIND_META: Record<string, { label: string; cls: string; sign: string }> = {
  LOAD: { label: 'تحميل', cls: 'text-[#2F855A] bg-[#EAF6F0]', sign: '+' },
  SALE: { label: 'بيع', cls: 'text-[#C94E28] bg-[#FBEBE2]', sign: '−' },
  RETURN: { label: 'مرتجع', cls: 'text-[#2B6CB0] bg-[#EBF2FA]', sign: '+' },
  UNLOAD: { label: 'تنزيل للمستودع', cls: 'text-[#B7791F] bg-[#FDF6E7]', sign: '−' },
  ADJUST: { label: 'تسوية', cls: 'text-[#6B46C1] bg-[#F3EEFB]', sign: '±' },
  EXPIRED_OUT: { label: 'إزالة منتهي الصلاحية', cls: 'text-[#C0392B] bg-[#FDECEA]', sign: '−' },
  RETURN_DAMAGED: { label: 'مرتجع تالف', cls: 'text-[#C0392B] bg-[#FDECEA]', sign: '+' },
  DAMAGED_OUT: { label: 'إزالة مرتجع تالف', cls: 'text-[#C0392B] bg-[#FDECEA]', sign: '−' },
};

/* إشعار الحركة في حزمة مستقلّة — يجرّ jspdf وhtml2canvas وqrcode معه */
const MLoadNoticeDoc = lazy(() => import('./MLoadNoticeDoc'));

/** الحركات التي لها إشعارٌ يُطبع: حركات السيارة وحدها لا المبيعات والمرتجعات،
 *  فتلك مستنداتها فواتيرُ وسندات لا إشعارُ مخزون — وهو تمييز اللوحة نفسه. */
const EXPORTABLE = ['LOAD', 'UNLOAD', 'ADJUST'];

/** كسورٌ محتملة في الوحدات الموزونة — لكن بلا أصفارٍ زائدة على «١٢» */
const fmtQty = (n: number) => formatNumber(Number(n.toFixed(2)));

/** كمية تشغيلةٍ بالأساس: أربع خانات (D22) لا خانتان — تُعرض عبر lotQtyText بوحدات الصنف أو باسم الأساس، لا عاريةً */
const fmtLotQ = (n: number) => new Intl.NumberFormat(activeLocale(), { maximumFractionDigits: 4 }).format(roundLot(n));

/** رسالة الخادم أولى من رسالتنا: «منتج غير صالح» تُصلح الخطأ و«تعذر الحفظ» لا تصلح شيئاً */
function errMsg(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

export default function MRepLoad({ rep, company, onClose }: {
  rep: SalesRep;
  /** إعدادات الشركة — لترويسة إشعار الحركة وحدها */
  company?: unknown;
  onClose: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  /* «تتبّع اللوط» — مطفأ ⇒ لا لقطة ولا اقتراح ولا حقل: الشاشة والجسم كما قبل الميزة (§١٠.١). والمستودع يقرّر مصدر
   * التحميل: مفعّلٌ ⇒ يوزّع الخادم بـFEFO (اقتراحٌ يُعرض هنا)، ومطفأٌ ⇒ تشغيلةٌ صريحة لكل سطر (D4) */
  const lotOn = lotFlagsOf(company as { lotTrackingEnabled?: unknown } | null).on;
  const warehouseOn = (company as { warehouseEnabled?: boolean } | null)?.warehouseEnabled === true;

  const [rows, setRows] = useState<Row[]>([]);
  // إشعار حركةٍ واحدة معروضٌ الآن — طبقةٌ فوق هذه الشاشة
  const [noticeMv, setNoticeMv] = useState<Movement | null>(null);

  useBackClose(!!noticeMv, () => setNoticeMv(null));

  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [showSuggest, setShowSuggest] = useState(false);
  const [windowDays, setWindowDays] = useState(28);
  const [bufferPct, setBufferPct] = useState(15);
  // تأكيدٌ واحد بحالتين: استبدال المُدخَل بالاقتراح · حفظ حركةٍ فيها تنزيل
  const [confirm, setConfirm] = useState<null | 'apply' | 'save'>(null);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const stockQ = useQuery({
    queryKey: ['m-van-current', rep.id],
    queryFn: async () => expectArray<StockRow>(
      (await vanStockApi.current(rep.id)).data?.data, tr('مخزون المندوب الحالي')),
  });

  const prodQ = useQuery({
    queryKey: ['m-van-products', dq],
    queryFn: async () => {
      // المفتاح الفارغ يُحذف لا يُرسَل نصّاً فارغاً — الخادم يقرؤه بحثاً عن «»
      const params: Record<string, string | number> = { limit: 30 };
      if (dq) params.search = dq;
      return expectArray<ProductPick>((await productApi.list(params)).data?.data, tr('الأصناف'));
    },
  });

  // الاقتراح لا يُطلَب إلا حين يُفتح القسم: طلبُ شبكةٍ لكلّ فتحِ شاشةٍ هدرٌ
  // على مَن يعرف كمّياته أصلاً — وشبكةُ المستودع ضعيفة غالباً.
  const suggestQ = useQuery({
    queryKey: ['m-van-suggest', rep.id, windowDays, bufferPct],
    enabled: showSuggest,
    queryFn: async () => expectObject<SuggestResponse>(
      (await vanStockApi.suggest({ salesRepId: rep.id, windowDays, bufferPct })).data?.data,
      tr('التحميل المقترح')),
  });

  const mvQ = useQuery({
    queryKey: ['m-van-movements', rep.id, lotOn],
    // withLots للإشعار المطبوع وحده: صفوف تشغيلات كل بند — وبدونه الطلب كما كان حرفاً
    queryFn: async () => expectArray<Movement>(
      (await vanStockApi.movements(rep.id, lotOn ? { withLots: true } : undefined)).data?.data, tr('حركة البضاعة ماذا نزل ومتى')),
  });

  /* لقطة تشغيلات السيارة: قائمة الأصناف المتتبَّعة (tracked) ومصادر التنزيل بصالحها — طلبٌ واحد للشاشة والميزة مفعّلة */
  const snapQ = useQuery({
    queryKey: ['m-van-lots', rep.id],
    enabled: lotOn,
    queryFn: async () => expectObject<VanLotSnapshotDto>((await lotsApi.vanLotBalances(rep.id)).data?.data, tr('التشغيلات')),
  });
  const trackedSet = useMemo(() => new Set(snapQ.data?.tracked ?? []), [snapQ.data]);
  // علم الصنف من قائمة الأصناف ريثما تصل اللقطة — وبعدها اللقطة المرجع (أصناف السيارة والاقتراح لا تحمل العلم)
  const pickTracked = useMemo(
    () => new Set((prodQ.data ?? []).filter(p => p.lotTracked === true).map(p => p.id)), [prodQ.data]);
  const trackedOf = (productId: string) => lotOn && (snapQ.data ? trackedSet.has(productId) : pickTracked.has(productId));
  const sourcesOf = (productId: string): OutSource[] =>
    vanOutSources(snapQ.data?.products.find(p => p.productId === productId), snapQ.data?.day ?? '');

  /** رصيد الصنف في السيارة الآن (بالأساس) — يُعرض على سطره فلا يُحمَّل ما لم ينفد */
  const remainingOf = useMemo(() => {
    const m = new Map<string, number>();
    (stockQ.data ?? []).forEach(s => m.set(s.productId, s.remaining));
    return (id: string) => m.get(id) ?? 0;
  }, [stockQ.data]);

  const totalRemaining = (stockQ.data ?? []).reduce((s, r) => s + r.remaining, 0);
  // مجموع المتبقّي عبر الأصناف بالأساس — يُسمّى كذلك حين لصنفٍ وحدةٌ أكبر، فلا يُقرأ ١٢٠٠ حبة «١٢٠٠ كرتون»
  const anyMulti = (stockQ.data ?? []).some(s => hasBigUnit(s.units));
  // ولصنفٍ له «وحدة رئيسية» (R3): «المتبقي بالوحدات الصغرى» — «بوحدات الأساس» لا تُقال لمن عرّف صنفه بالكرتون (D21)
  const remainingLabel = qtyTotalLabel(tr, 'المتبقي', 'المتبقي بوحدات الأساس', { primary: anyPrimary(stockQ.data), multi: anyMulti });

  /* «تتبّع اللوط» لكل سطرٍ متتبَّع (والمطفأ لا شيء):
   *  - تحميلٌ في شركة بلا مستودع (D4): تشغيلةٌ صريحة (قائمة مؤهَّلة، أو جديدة، أو «غير مسمى»).
   *  - تنزيل: صفوفٌ صريحة حين للصنف في السيارة أكثر من مصدر (D10)، والمصدر الوحيد يختاره الخادم.
   *  - تحميلٌ من المستودع: لا شيء — الخادم يوزّع بـFEFO عند الحفظ، والمعاينة أدناه اقتراحه نفسه. */

  /* أسطر التنزيل على مستوى الصنف (D26): صنفٌ متتبَّع يجوز له سطران بوحدتين («−١ كرتون» و«−٥ حبّات»)، والخادم يجمعهما قبل
   * الفحص. فالتوزيع الأوّلي من متاحٍ مشترك (ما أخذه سطرٌ لا يأخذه آخر)، والتحقق بمجموع الأسطر ومجموع كل تشغيلةٍ عبرها */
  const outPlan = useMemo(() => {
    const rowsOf = new Map<string, LotRef[]>();
    const problems = new Map<string, string>();
    const byProduct = new Map<string, { r: Row; base: number }[]>();
    for (const r of rows) {
      const n = Number(r.qty);
      if (!(n < 0) || !trackedOf(r.productId)) continue;
      byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), { r, base: lineBaseQty(n, r.unitFactor) }]);
    }
    for (const [pid, ls] of byProduct) {
      const sources = sourcesOf(pid);
      const filled = prefillOutLines(sources, ls.map(({ r, base }) => ({ key: r.rowId, base, factor: r.unitFactor, rows: r.outLots })));
      filled.forEach((v, k) => rowsOf.set(k, v));
      const multi = sources.length > 1;
      outGroupProblems(sources, ls.map(({ r, base }) => ({ key: r.rowId, base, rows: multi ? filled.get(r.rowId) ?? [] : null })), { loaded: !!snapQ.data })
        .forEach((p, k) => problems.set(k, VAN_OUT_PROBLEMS[p]));
    }
    return { rowsOf, problems, byProduct };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackedOf وsourcesOf تقرآن اللقطة والعلم وحدهما
  }, [rows, snapQ.data, lotOn, pickTracked]);
  const outRowsOf = (r: Row): LotRef[] => outPlan.rowsOf.get(r.rowId) ?? [];
  /** مصادر السطر بما يبقى له بعد أسطر صنفه الأخرى — «المتاح» المعروض عليه */
  const outSourcesOf = (r: Row): OutSource[] => sourcesLeftFor(
    sourcesOf(r.productId),
    (outPlan.byProduct.get(r.productId) ?? []).filter(x => x.r.rowId !== r.rowId).map(x => outRowsOf(x.r)),
  );

  /* صلاحية الصنف لتشغيلة التحميل الجديدة (D4): المضاف من قائمة الأصناف يحملها، وأسطر مخزون السيارة والاقتراح لا تحملها —
   * فتُجلب ببطاقة الصنف حين تُختار «تشغيلة جديدة» لسطرٍ مجهولها، والمجهولة إلزامية ريثما تصل (resolveShelfOn) */
  const shelfIds = lotOn && !warehouseOn
    ? [...new Set(rows.filter(r => r.shelfOn === undefined && r.lot?.pick === 'NEW' && Number(r.qty) > 0 && trackedOf(r.productId)).map(r => r.productId))]
    : [];
  const shelfQs = useQueries({
    queries: shelfIds.map(id => ({
      queryKey: ['m-product-shelf', id],
      staleTime: 60_000,
      queryFn: async () => shelfLifeOn((await productApi.get(id)).data?.data as ProductPick | undefined),
    })),
  });
  const shelfOf = (r: Row): boolean => {
    const i = shelfIds.indexOf(r.productId);
    return resolveShelfOn(r.shelfOn, i >= 0 ? shelfQs[i]?.data : undefined);
  };

  const lotPartOf = (r: Row): { lots?: LotRef[]; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } => {
    const n = Number(r.qty);
    if (!trackedOf(r.productId) || !Number.isFinite(n) || n === 0) return {};
    if (n > 0) return warehouseOn ? {} : loadLotFields(r.lot ?? emptyLotDraft(), lineBaseQty(n, r.unitFactor));
    return sourcesOf(r.productId).length > 1 ? { lots: outRowsOf(r) } : {};
  };
  /** مشكلة تشغيلة السطر (مفتاح قاموس) أو null — تمنع الحفظ قبل أن يرفضه الخادم */
  const lotProblemOf = (r: Row): string | null => {
    const n = Number(r.qty);
    if (!trackedOf(r.productId) || !Number.isFinite(n) || n === 0) return null;
    if (n > 0) return warehouseOn ? null : lotDraftProblem(r.lot ?? emptyLotDraft(), 'LOAD', { shelfOn: shelfOf(r), day: snapQ.data?.day });
    // التنزيل: مرآة pickPlan (D10، D26، I1) على مستوى الصنف — بلا مصدر، أو فوق مجموع المصادر، أو توزيعٌ ناقص، أو تشغيلةٌ فوق صالحها
    return outPlan.problems.get(r.rowId) ?? null;
  };

  // المصدر الوحيد للتقسيم (splitVanMovement، وsplitLoadRows غلافٌ عليها بلا حقول اللوط) — الواجهة تعرضه والحفظ يرسله،
  // فلا يختلف المعروض عن المُرسَل. وحقول اللوط غائبةٌ لغير المتتبَّع فالجسم كما كان حرفاً
  // و«الوحدة الرئيسية» (§3 البند ١٣، §5.3): كل بندٍ يحمل أساس صنفه كما عرفه كتالوج الشاشة (`baseUnitName`) — تحويلٌ للصنف بعد
  // فتح الشاشة يُردّ 400 UNIT_INVALID أو 409 PRODUCT_UNITS_CHANGED بدل أن يُقيَّد «١٠» كرتوناً قارورةً. والتنزيل يُعاد بناؤه
  // في splitVanMovement فيُعاد إليه أساسه بالترتيب (backWithBaseNames)
  const split = useMemo(
    () => {
      const items = rows.map(r => withBaseUnitName({
        productId: r.productId, qty: Number(r.qty), unitId: r.unitId,
        suggestedQty: r.suggestedQty, expectedQty: r.expectedQty,
        ...lotPartOf(r),
      }, r.baseUnit));
      const s = splitVanMovement(items);
      return { out: s.out, back: backWithBaseNames(items, s.back) };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lotPartOf تقرأ اللقطة والعلمين وخطة التنزيل وحدها
    [rows, snapQ.data, lotOn, warehouseOn, outPlan],
  );
  const hasMovement = split.out.length > 0 || split.back.length > 0;
  const lotBlocked = rows.some(r => lotProblemOf(r) !== null);

  /* اقتراح FEFO للتحميل من المستودع: طلبٌ لكل صنفٍ متتبَّع بأسطره كلّها («كمية:معامل») فيوزّعها الخادم من متاحٍ مشترك
   * كما يوزّعها الحفظ — بعد أن تستقرّ الكميات المكتوبة */
  const settled = useSettled(rows, 400);
  const fefoGroups = useMemo(() => {
    if (!lotOn || !warehouseOn) return [];
    const m = new Map<string, { rowId: string; qty: number; unitFactor: number }[]>();
    for (const r of settled) {
      const n = Number(r.qty);
      if (!trackedOf(r.productId) || !(n > 0) || lineBaseQty(n, r.unitFactor) <= LOT_EPS) continue;
      m.set(r.productId, [...(m.get(r.productId) ?? []), { rowId: r.rowId, qty: n, unitFactor: r.unitFactor }]);
    }
    return [...m].map(([productId, ls]) => ({ productId, ls, spec: fefoLinesParam(ls) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackedOf تقرأ اللقطة والعلم
  }, [settled, lotOn, warehouseOn, snapQ.data, pickTracked]);
  const fefoQs = useQueries({
    queries: fefoGroups.map(g => ({
      queryKey: ['m-van-fefo', rep.id, g.productId, g.spec],
      staleTime: 15_000,
      queryFn: async () => {
        // lines يحمل أسطر الصنف كلّها (qty يُتجاهل معه) — lotsApi.fefo يمرّر المعاملات كما هي
        const params = { productId: g.productId, qty: g.ls.reduce((s, l) => s + lineBaseQty(l.qty, l.unitFactor), 0), salesRepId: rep.id, lines: g.spec };
        return ((await lotsApi.fefo(params)).data?.data ?? null) as FefoResp | null;
      },
    })),
  });
  /** معاينة سطرٍ بهويّته: صفوفه المقترحة، وتحذيرات صنفه ونقصه (على السطر الأول للصنف وحده) */
  const fefoOf = (rowId: string) => {
    for (const [gi, g] of fefoGroups.entries()) {
      const i = g.ls.findIndex(l => l.rowId === rowId);
      if (i < 0) continue;
      const d = fefoQs[gi]?.data ?? null;
      return {
        loading: !!fefoQs[gi]?.isLoading,
        rows: d?.lines?.find(l => l.idx === i)?.rows ?? [],
        first: i === 0, warnings: d?.warnings ?? [], shortage: d?.shortage ?? null,
      };
    }
    return null;
  };

  /**
   * نقرة الصنف: أوّل سطرٍ بوحدته الافتراضية (الأكبر)، وكل نقرةٍ بعدها سطرٌ بوحدةٍ لم يأخذها سطر — وصنفٌ أُخذت
   * وحداته كلّها (أو بلا وحدات وله سطر) لا يُضاف: سطران بوحدةٍ واحدة يتنازعان الكمية.
   */
  /* والصنف المتتبَّع يُضاف سطراً جديداً ولو أُخذت وحداته — لكل تشغيلةٍ سطرها (D4) */
  /* والوحدة الافتراضية «الرئيسية» حين للصنف رئيسية (defaultChoice، R6)، وتُحفظ على السطر لعرض رصيده بها وحده */
  const addLine = (p: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null }, productId: string, name: string, extra: Partial<Row> = {}) =>
    setRows(rs => {
      const u = nextStockLineUnit(p, rs, productId) ?? (trackedOf(productId) ? stockLineUnit(p, defaultChoice(p)) : null);
      return u ? [...rs, { rowId: newRowId(), productId, name, qty: '1', ...u, primaryUnitId: p.primaryUnitId ?? null, ...extra }] : rs;
    });
  const addProduct = (p: ProductPick) => addLine(p, p.id, p.name, lotOn ? { shelfOn: shelfLifeOn(p) } : {});
  const addFromStock = (s: StockRow) => addLine(s, s.productId, s.name);
  // تغيّر الكمية أو إشارتها أو وحدتها يُسقط توزيع التنزيل اليدوي: كميته لم تعد كمية السطر
  const patchQty = (key: string, v: string) => setRows(rs => rs.map(r => r.rowId === key ? { ...r, qty: v, outLots: undefined } : r));
  const flipSign = (key: string) => setRows(rs => rs.map(r => {
    if (r.rowId !== key) return r;
    const n = Number(r.qty);
    return { ...r, qty: Number.isFinite(n) ? String(-n) : r.qty, outLots: undefined };
  }));
  const dropRow = (key: string) => setRows(rs => rs.filter(r => r.rowId !== key));
  const patchRow = (key: string, patch: Partial<Row>) => setRows(rs => rs.map(r => (r.rowId === key ? { ...r, ...patch } : r)));
  /** وحدة السطر تتبدّل والكمية المكتوبة كما هي — والمنتقي يعطّل وحدةً أخذها سطرٌ آخر للصنف */
  const setRowUnit = (key: string, unitId: string | null) => setRows(rs => rs.map(r => {
    if (r.rowId !== key) return r;
    const p = { unit: r.baseUnit, units: r.units, primaryUnitId: r.primaryUnitId };
    const c = unitChoices(p).find(o => o.id === unitId);
    return c ? { ...r, ...stockLineUnit(p, c), outLots: undefined } : r;
  }));

  /** يملأ النموذج بما يستحقّ تحميلاً فقط — الأصفار ضجيجٌ لا اقتراح */
  const applySuggestion = () => {
    const list = (suggestQ.data?.rows ?? []).filter(r => r.suggested > 0);
    if (!list.length) { toast.error(tr('لا يوجد ما يقترح تحميله')); setConfirm(null); return; }
    setRows(list.map(r => {
      // المقترح بالأساس: يُحمَّل بأكبر وحدةٍ تنقسم عليها الكمية تماماً (٤٨ حبة ⇒ ٢ كرتون)، وإلّا بالأساس كما هو.
      // والتنبّؤ اليومي مرجعُ قياس الدقّة لا suggestedQty: الأخيرة كمّية تعبئة تتأثّر بما في السيارة وبالهامش،
      // فقياسُها يعاقب المحرّك على ما ليس تنبّؤاً — وكلاهما بالأساس مهما كانت وحدة السطر
      const l = suggestionLine(r);
      return { ...l, rowId: newRowId(), productId: r.id, name: r.name, qty: String(l.qty), primaryUnitId: r.primaryUnitId ?? null };
    }));
    setShowSuggest(false);
    setConfirm(null);
    toast.success(tr('طبق الاقتراح راجع الكميات قبل الحفظ'));
  };

  const save = useMutation({
    mutationFn: async () => {
      const { out, back } = split;
      const trimmed = note.trim() || undefined;
      // «تتبّع اللوط»: تحذيرات الوثيقتين (تشغيلتان في السيارة، كرتونٌ مقسوم، رصيدٌ غير مسمّى) — لا تمنع لكنها تُقال
      const warnings: LotWarning[] = [];
      if (out.length) {
        const res = await vanStockApi.createLoad({ salesRepId: rep.id, type: 'LOAD', note: trimmed, items: out });
        warnings.push(...lotWarningsOf((res.data as { warnings?: unknown } | undefined)?.warnings));
        // وثيقة التحميل كُتبت فعلاً: تُسقَط أسطرها فوراً كي لا تُكتب مرّتين لو
        // سقط التنزيل بعدها وأعاد المستخدم المحاولة
        setRows(rs => rs.filter(r => !(Number(r.qty) > 0)));
      }
      if (back.length) {
        const res = await vanStockApi.createLoad({ salesRepId: rep.id, type: 'UNLOAD', note: trimmed, items: back });
        warnings.push(...lotWarningsOf((res.data as { warnings?: unknown } | undefined)?.warnings));
      }
      return warnings;
    },
    onSuccess: (warnings) => {
      invalidateVanStock();
      toast.success(tr('تم حفظ الحركة'));
      [...new Set(warnings.map(w => w.code))].forEach(c => toast(tr(LOT_WARNING_LABELS[c])));
      setRows([]);
      setNote('');
      setConfirm(null);
    },
    onError: (e: unknown) => {
      // حتى الفشل يُبطِل المفاتيح: الشقّ الأوّل من الحركة المختلطة قد يكون كُتب،
      // وعرضُ رصيدٍ قديم بعده يخفي عن المستخدم ما صار في السيارة حقّاً
      invalidateVanStock();
      // أساس صنفٍ تغيّر (كاشٌ قديم أو سباقٌ مع «إضافة وحدة فرعية أصغر»): الأصناف تُجلب من جديد، وأسطر الشاشة يُعاد أساسها
      // بها (rebaseRow كتطبيق المندوب) فلا يُرفض الحفظ التالي ثانيةً — ورسالة الخادم تسمّي الصنف. و503 PRODUCT_UNITS_BUSY
      // رسالته وحدها: الكتالوج لم يتغيّر بعد
      if (refetchUnitsOn(e)) {
        qc.invalidateQueries({ queryKey: ['m-van-products'] });
        void refreshRowUnits();
      }
      toast.error(errMsg(e, tr('تعذر الحفظ')));
      setConfirm(null);
    },
  });

  /**
   * وحدات أصناف الأسطر من الخادم الآن، وكل سطرٍ يُعاد أساسه بها: «٢ كرتون» تبقى كرتونين بعد أن صار الأساس قارورة، وسطرٌ
   * أُوقفت وحدته يصير بالأساس بكميته × معامله ظاهراً (rebaseRow). وصنفٌ تعذّر جلبه يبقى سطره كما هو — والخادم يحكم.
   */
  async function refreshRowUnits() {
    const ids = [...new Set(rows.map(r => r.productId))];
    const fresh = new Map<string, ProductPick>();
    await Promise.all(ids.map(async id => {
      try {
        const p = (await productApi.get(id)).data?.data as ProductPick | undefined;
        if (p && typeof p.unit === 'string') fresh.set(id, p);
      } catch { /* يبقى السطر كما هو */ }
    }));
    setRows(rs => rs.map(r => {
      const p = fresh.get(r.productId);
      const next = p ? rebaseRow(r, p) : null;
      if (!p || !next) return r;
      return { ...r, ...stockLineUnit(p, next.choice), qty: String(next.qty), primaryUnitId: p.primaryUnitId ?? null, outLots: undefined };
    }));
  }

  function invalidateVanStock() {
    // مفاتيح الجوال ومفاتيح اللوحة معاً — الحزمة واحدة والكاش مشترك، فترك
    // مفاتيح اللوحة يُظهر للأدمن رصيداً قديماً حين ينتقل إليها
    // و«تتبّع اللوط» في الجهتين: لقطة السيارة واقتراحها وأرصدة المستودع وخيارات المنتقي (تشغيلةٌ أُنشئت مع تحميلٍ بلا
    // مستودع) وشاشة التتبّع — الجوال واللوحة (LOT_CACHE_KEYS)
    ['m-van-current', 'm-van-movements', 'm-van-suggest', 'van-summary', 'van-current', 'van-movements',
      ...(lotOn ? LOT_CACHE_KEYS : [])]
      .forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  }

  const onSave = () => {
    if (!hasMovement || lotBlocked) return;
    // التنزيل يعكس اتجاه الرصيد — يُؤكَّد صراحةً، والتحميل الصِّرف يمضي بلا حاجز
    if (split.back.length) { setConfirm('save'); return; }
    save.mutate();
  };

  const suggestRows = (suggestQ.data?.rows ?? []).filter(r => r.suggested > 0);

  /* تصدير حركةٍ واحدة: نعرض إشعارها ملء الشاشة بدل شاشة التحميل — مطابقةً
   * للوحة، ولأن عارض المستندات يحتاج الشاشة كلّها ليُخرج PDF بمقاس A4. */
  if (noticeMv) {
    return (
      <Suspense fallback={<MSpinner />}>
        <MLoadNoticeDoc repName={rep.name} movement={noticeMv} company={company}
          onClose={() => setNoticeMv(null)} />
      </Suspense>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('تسجيل تحميل بضاعة')} subtitle={rep.name} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">

        {/* ─────────── رصيد السيارة الآن ───────────
            قبل النموذج لا بعده: مَن لا يرى المتبقّي يُحمّل فوق حمولةٍ قائمة */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">
            {tr('مخزون المندوب الحالي')}
          </h3>
          {stockQ.isLoading ? (
            <MCard><div className="py-10"><MSpinner /></div></MCard>
          ) : stockQ.isError ? (
            <MCard><div className="py-10">
              <MError onRetry={() => stockQ.refetch()} text={tr('تعذر تحميل مخزون السيارة')} />
            </div></MCard>
          ) : !stockQ.data?.length ? (
            <MCard><div className="py-10">
              <MEmpty icon={Package} text={tr('لا توجد بضاعة محملة لهذا المندوب')} />
            </div></MCard>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <MStat icon={Package} label={tr('أصناف بالسيارة')} value={formatNumber(stockQ.data.length)} />
                <MStat icon={Truck} label={remainingLabel} value={fmtQty(totalRemaining)}
                  tone={totalRemaining > 0 ? 'good' : 'default'} />
              </div>
              <MCard className="overflow-hidden">
                {/* تمريرٌ داخليّ: قائمة أصنافٍ طويلة كانت ستدفع النموذج خارج الشاشة */}
                <div className="max-h-[250px] overflow-y-auto overscroll-contain">
                  {stockQ.data.map(s => {
                    // «مضاف» حين لا وحدة حرّة للصنف — وله وحدةٌ أخرى ⇒ النقرة سطرٌ ثانٍ بها. والمتتبَّع يقبل سطراً لكل تشغيلة
                    const picked = !trackedOf(s.productId) && nextStockLineUnit(s, rows, s.productId) === null;
                    return (
                      <MRow key={s.productId}
                        title={s.name}
                        // ما لا يُباع (منتهٍ أو تالف) يُذكر بجانب الصنف — لا يدخل المتبقّي
                        subtitle={[
                          `${s.code} · ${productUnitLabel(s, formatNumber)}`,
                          (s.expired ?? 0) > 0 ? `${tr('منتهي الصلاحية')} ${qtyText(s.expired!, s, fmtQty)}` : '',
                          (s.damaged ?? 0) > 0 ? `${tr('تالف')} ${qtyText(s.damaged!, s, fmtQty)}` : '',
                        ].filter(Boolean).join(' · ')}
                        // صفٌّ مضافٌ سلفاً لا يُنقر: نقرةٌ لا أثر لها تُقرأ عطلاً
                        onClick={picked ? undefined : () => addFromStock(s)}
                        trailing={(
                          <span className="flex items-center gap-2 flex-shrink-0">
                            <span className={`text-sm font-bold tabular-nums ${s.remaining < 0 ? 'text-[#C0392B]' : s.remaining === 0 ? 'text-[#9A8F7E]' : 'text-[#2F855A]'}`}>
                              {qtyText(s.remaining, s, fmtQty)}
                            </span>
                            {picked
                              ? <span className="text-[10px] font-bold text-[#2F855A]">{tr('مضاف')}</span>
                              : <Plus size={16} className="text-[#E15A30]" />}
                          </span>
                        )} />
                    );
                  })}
                </div>
              </MCard>
            </>
          )}
        </section>

        {/* ─────────── التحميل المقترح ───────────
            موضعه لحظةَ التحميل لا في لوحةٍ منفصلة: توقّعٌ يُقرأ في شاشةٍ أخرى
            يُقرأ مرّة ويُنسى، وهنا يصير قراراً */}
        <section className="space-y-2.5">
          <div className="bg-white rounded-2xl border border-[#F1EBDF] overflow-hidden">
            <button type="button" onClick={() => setShowSuggest(v => !v)}
              className="w-full min-h-[52px] px-3.5 py-3 bg-[#FBEBE2] flex items-center justify-between gap-2 text-start">
              <span className="text-sm font-bold text-[#1F1A13] flex items-center gap-2">
                <Sparkles size={15} className="text-[#E15A30]" />
                {tr('التحميل المقترح')}
              </span>
              <span className="text-[11px] text-[#6E6557] truncate">
                {showSuggest ? tr('إخفاء') : tr('اعرض اقتراحا من تاريخ مبيعاته')}
              </span>
            </button>

            {showSuggest && (
              <div className="p-3.5 space-y-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="label !mb-1 !text-[11px]">{tr('نافذة التاريخ يوم')}</label>
                    <input className="input text-center min-h-[44px]" dir="ltr" type="number" inputMode="numeric"
                      min={7} max={180} value={windowDays}
                      onChange={e => setWindowDays(Math.min(180, Math.max(7, Number(e.target.value) || 28)))} />
                  </div>
                  <div className="flex-1">
                    <label className="label !mb-1 !text-[11px]">{tr('هامش أمان %')}</label>
                    <input className="input text-center min-h-[44px]" dir="ltr" type="number" inputMode="numeric"
                      min={0} max={100} value={bufferPct}
                      onChange={e => setBufferPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
                  </div>
                </div>

                {suggestQ.isLoading ? (
                  <div className="py-8"><MSpinner text={tr('يحسب')} /></div>
                ) : suggestQ.isError ? (
                  <button onClick={() => suggestQ.refetch()}
                    className="w-full rounded-xl border border-[#F5C6C0] bg-[#FDF2F0] p-3.5 text-start min-h-[56px]">
                    <p className="text-[11px] text-[#C0392B]">{tr('تعذر حساب الاقتراح')}</p>
                    <p className="text-xs font-bold text-[#C0392B] mt-1">{tr('إعادة المحاولة')}</p>
                  </button>
                ) : (
                  <>
                    {/* التحذير كما يرده الخادم — إخفاء رقّة البيانات خداعٌ يُتّخذ عليه قرار */}
                    {suggestQ.data?.meta.warning && (
                      <p className="text-[11px] text-[#8A6D1F] bg-[#FDF6E7] border border-[#F0E0B8] rounded-xl px-3 py-2 leading-relaxed">
                        <AlertTriangle size={12} className="inline -mt-0.5 me-1" />
                        {suggestQ.data.meta.warning}
                      </p>
                    )}
                    {suggestQ.data && (
                      <p className="text-[11px] text-[#6E6557] leading-relaxed px-0.5">
                        {tr('بناء على')} <b>{formatNumber(suggestQ.data.meta.dataDays)}</b>{' '}
                        {tr('يوما فيها مبيعات خلال آخر')} <b>{formatNumber(suggestQ.data.meta.windowDays)}</b>{' '}
                        {tr('يوما')}
                      </p>
                    )}

                    {!suggestRows.length ? (
                      <p className="text-[11px] text-[#9A8F7E] leading-relaxed px-0.5">
                        {tr('لا يوجد ما يقترح تحميله إما لا مبيعات سابقة أو السيارة تغطي المتوقع أصلا')}
                      </p>
                    ) : (
                      <>
                        <div className="max-h-[220px] overflow-y-auto overscroll-contain rounded-xl border border-[#F1EBDF] divide-y divide-[#F1EBDF]">
                          {suggestRows.map(r => (
                            <div key={r.id} className="px-3 py-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                                <span className="flex items-center gap-1.5 flex-shrink-0">
                                  <ConfidenceTag c={r.confidence} />
                                  {/* المقترح بالأساس: لصنفٍ له وحدات «٢ كرتون» لا «٤٨» بجانب اسمٍ يُقرأ كرتوناً */}
                                  {hasBigUnit(r.units) ? (
                                    <b className="text-sm text-[#E15A30] tabular-nums">{qtyText(r.suggested, r, fmtQty)}</b>
                                  ) : (
                                    <>
                                      <b className="text-sm text-[#E15A30] tabular-nums">{fmtQty(r.suggested)}</b>
                                      <span className="text-[10px] text-[#9A8F7E]">{r.unit}</span>
                                    </>
                                  )}
                                </span>
                              </div>
                              {/* «لماذا هذا الرقم» — اقتراحٌ لا يُشرَح يُرفض أوّل خطأ ثم لا يُصدَّق */}
                              <p className="text-[10px] text-[#9A8F7E] mt-0.5 leading-relaxed">{r.why}</p>
                            </div>
                          ))}
                        </div>
                        <button type="button"
                          onClick={() => (rows.length ? setConfirm('apply') : applySuggestion())}
                          className="w-full bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2">
                          <Sparkles size={16} />
                          {tr('املأ النموذج بالاقتراح')}
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ─────────── إضافة صنف ─────────── */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('إضافة صنف')}</h3>
          <div className="relative">
            <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
            <input className="input ps-9 min-h-[44px]" value={q} onChange={e => setQ(e.target.value)}
              placeholder={tr('اكتب اسم/كود الصنف')} />
          </div>
          <MCard className="overflow-hidden">
            {prodQ.isLoading ? (
              <div className="py-10"><MSpinner /></div>
            ) : prodQ.isError ? (
              <div className="py-10"><MError onRetry={() => prodQ.refetch()} /></div>
            ) : !prodQ.data?.length ? (
              <div className="py-10"><MEmpty icon={Package} text={tr('لا توجد أصناف')} /></div>
            ) : (
              <div className="max-h-[250px] overflow-y-auto overscroll-contain">
                {prodQ.data.map(p => {
                  const picked = !trackedOf(p.id) && nextStockLineUnit(p, rows, p.id) === null;
                  return (
                    <MRow key={p.id}
                      title={p.name}
                      subtitle={[p.code, productUnitLabel(p, formatNumber)].filter(Boolean).join(' · ') || undefined}
                      onClick={picked ? undefined : () => addProduct(p)}
                      trailing={(
                        <span className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[11px] text-[#9A8F7E] tabular-nums">
                            {qtyText(remainingOf(p.id), p, fmtQty)}
                          </span>
                          {picked
                            ? <span className="text-[10px] font-bold text-[#2F855A]">{tr('مضاف')}</span>
                            : <Plus size={17} className="text-[#E15A30]" />}
                        </span>
                      )} />
                  );
                })}
              </div>
            )}
          </MCard>
        </section>

        {/* ─────────── الأصناف المختارة ─────────── */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('الأصناف المختارة')}</h3>
          <MCard>
            {!rows.length ? (
              <p className="p-6 text-center text-[11px] text-[#9A8F7E]">{tr('ابحث وأضف صنفا')}</p>
            ) : rows.map(r => {
              const k = r.rowId;
              const n = Number(r.qty);
              const neg = Number.isFinite(n) && n < 0;
              const zero = !Number.isFinite(n) || n === 0;
              // والرئيسية معها: الرصيد والمقترح «52 كرتون و2 قارورة» (R1)
              const prod = { unit: r.baseUnit, units: r.units, primaryUnitId: r.primaryUnitId };
              const opts = unitChoices(prod);
              const tracked = trackedOf(r.productId);
              return (
                <div key={k} className="p-3 space-y-2 border-b border-[#F1EBDF] last:border-0">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                      {/* الرصيد بالأساس بوحدة الأساس أو مفكَّكاً — لا بجانب اسم وحدة السطر */}
                      <span className="block text-[11px] text-[#9A8F7E] truncate mt-0.5">
                        {tr('المتبقي')} {qtyText(remainingOf(r.productId), prod, fmtQty, { withUnit: true })}
                      </span>
                      {/* وسمُ الاتجاه على السطر نفسه: الإشارة وحدها تُقرأ خطأً في عجلة المستودع */}
                      <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-md ${neg ? 'text-[#B7791F] bg-[#FDF6E7]' : zero ? 'text-[#9A8F7E] bg-[#F5F1E9]' : 'text-[#2F855A] bg-[#EAF6F0]'}`}>
                        {neg ? tr('تنزيل للمستودع') : zero ? tr('لا حركة') : tr('تحميل')}
                      </span>
                    </span>
                    <button onClick={() => dropRow(k)} aria-label={tr('حذف')}
                      className="p-2.5 -m-1 rounded-xl text-[#C0392B] active:bg-[#FDF2F0]">
                      <Trash2 size={16} />
                    </button>
                  </div>

                  {/* المتتبَّع: سطران بالوحدة نفسها جائزان (تشغيلتان)، فلا وحدة «مأخوذة» */}
                  <MUnitChips options={opts} value={r.unitId} onChange={id => setRowUnit(k, id)}
                    taken={c => !tracked && rows.some(x => x !== r && x.productId === r.productId && (x.unitId ?? null) === c.id)} />

                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => flipSign(k)}
                      aria-label={tr('عكس الإشارة تحميل/تنقيص')}
                      className="w-11 h-11 flex-shrink-0 rounded-xl border border-[#E9E1D3] bg-white text-lg font-bold text-[#6E6557] active:bg-[#F1EBDF]">
                      ±
                    </button>
                    {/* إدخالٌ حرّ: خمسون كرتوناً رقمٌ يُكتب لا خمسون نقرة */}
                    <input className={`input flex-1 text-center min-h-[44px] text-base font-bold ${neg ? 'border-[#E4B76A] text-[#B7791F]' : ''}`}
                      dir="ltr" type="number" inputMode="decimal" step="any"
                      aria-label={opts.length > 1 ? `${tr('الكمية')} ${r.unit}` : undefined}
                      value={r.qty} onChange={e => patchQty(k, e.target.value)} />
                    {/* الكمية بوحدة السطر — اسمها بجانبها حين للصنف أكثر من وحدة */}
                    {opts.length > 1 && <span className="text-[12px] font-semibold text-[#6E6557] flex-shrink-0">{r.unit}</span>}
                  </div>

                  {r.suggestedQty !== undefined && (
                    <p className="text-[10px] text-[#9A8F7E] px-0.5">
                      {tr('التحميل المقترح')} {qtyText(r.suggestedQty, prod, fmtQty)}
                    </p>
                  )}

                  {/* «تتبّع اللوط» للصنف المتتبَّع وحده: معاينة FEFO للتحميل من المستودع، أو تشغيلة التحميل بلا مستودع،
                      أو توزيع التنزيل على مصادر السيارة */}
                  {tracked && !zero && !neg && warehouseOn && <FefoPreview productId={r.productId} prod={prod} f={fefoOf(r.rowId)} />}
                  {/* الموقوفة والمنتهية يوم الشركة لا تُحمَّل (I4) — معطّلةٌ في المنتقي بيوم اللقطة */}
                  {tracked && !zero && !neg && !warehouseOn && (
                    <MLotFields productId={r.productId} mode="LOAD" shelfOn={shelfOf(r)} draft={r.lot ?? emptyLotDraft()}
                      prod={prod} day={snapQ.data?.day} onChange={d => patchRow(k, { lot: d })} />
                  )}
                  {/* «المتاح» لكل مصدر ما يبقى لهذا السطر بعد أسطر صنفه الأخرى (D26) */}
                  {tracked && neg && (
                    <OutLotsEditor sources={outSourcesOf(r)} prod={prod} loading={snapQ.isLoading}
                      base={lineBaseQty(n, r.unitFactor)} rows={outRowsOf(r)}
                      onChange={lots => patchRow(k, { outLots: lots })} />
                  )}
                  {tracked && (() => {
                    const p = lotProblemOf(r);
                    // مشكلة المسودّة يقولها منتقيها نفسه — وهنا ما سواها (التنزيل)
                    return p && (neg || warehouseOn) ? <p className="text-[10px] text-[#C0392B] px-0.5">{tr(p)}</p> : null;
                  })()}
                </div>
              );
            })}
          </MCard>
          <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
            {tr('الموجب تحميل للسيارة والسالب تنزيل للمستودع والأصفار تسقط')}
          </p>
        </section>

        {/* ─────────── ملاحظة ─────────── */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('ملاحظة اختياري')}</h3>
          <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3">
            <input className="input min-h-[44px]" value={note} onChange={e => setNote(e.target.value)}
              placeholder={tr('مثال تحميل صباح اليوم من المستودع')} />
          </div>
        </section>

        {/* ─────────── حركة البضاعة ─────────── */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide flex items-center gap-1.5">
            <TrendingDown size={13} /> {tr('حركة البضاعة ماذا نزل ومتى')}
          </h3>
          {mvQ.isLoading ? (
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-6 text-center text-[11px] text-[#9A8F7E]">
              {tr('جاري التحميل')}
            </div>
          ) : mvQ.isError ? (
            <button onClick={() => mvQ.refetch()}
              className="w-full rounded-2xl border border-[#F5C6C0] bg-[#FDF2F0] p-3.5 text-start min-h-[56px]">
              <p className="text-[11px] text-[#C0392B]">{tr('تعذر تحميل البيانات')}</p>
              <p className="text-xs font-bold text-[#C0392B] mt-1">{tr('إعادة المحاولة')}</p>
            </button>
          ) : !mvQ.data?.length ? (
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-6 text-center text-[11px] text-[#9A8F7E]">
              {tr('لا توجد حركة بعد')}
            </div>
          ) : (
            <MCard>
              {mvQ.data.slice(0, 12).map((m, i) => {
                const meta = KIND_META[m.kind] || KIND_META.ADJUST;
                const qty = m.items.reduce((s, it) => s + it.qty, 0);
                // بنودٌ تختلف وحداتها تُجمع لكل وحدة («٢ كرتون · ٥ حبة») — «٧» رقمٌ بلا وحدة؛ وبالأساس كلّها: كما كانت
                const mixed = movementQtyText(m.items, fmtQty);
                return (
                  <MRow key={`${m.date}-${i}`}
                    leading={(
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-md flex-shrink-0 ${meta.cls}`}>
                        {tr(meta.label)}
                      </span>
                    )}
                    title={`${meta.sign}${mixed ?? fmtQty(Math.abs(qty))} · ${m.items.length} ${tr('صنف')}`}
                    subtitle={m.ref || undefined}
                    note={`${formatDate(m.date)} · ${formatTime(m.date)}`}
                    trailing={EXPORTABLE.includes(m.kind) ? (
                      <button onClick={() => setNoticeMv(m)} aria-label={tr('إشعار PDF')}
                        className="p-2.5 -m-1 rounded-xl text-[#6E6557] active:bg-[#F1EBDF] flex-shrink-0">
                        <Download size={16} />
                      </button>
                    ) : undefined} />
                );
              })}
            </MCard>
          )}
        </section>

        <div className="h-2" />
      </div>

      {/* شريط الحفظ ثابتٌ أسفل الشاشة: نموذجٌ طويل وزرُّ حفظٍ في قاعه لا يُرى */}
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {hasMovement && (
          <p className="text-[11px] text-[#6E6557] mb-2 px-0.5">
            {tr('تحميل')}: <b className="tabular-nums">{formatNumber(split.out.length)}</b>
            {' · '}
            {tr('تنزيل للمستودع')}: <b className="tabular-nums">{formatNumber(split.back.length)}</b>
          </p>
        )}
        <button onClick={onSave} disabled={!hasMovement || lotBlocked || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />}
          {tr('حفظ الحركة')}
        </button>
      </div>

      {confirm === 'apply' && (
        <MConfirm
          title={tr('املأ النموذج بالاقتراح')}
          message={tr('سيستبدل ما أدخلته بالكميات المقترحة')}
          confirmLabel={tr('املأ النموذج بالاقتراح')}
          onConfirm={applySuggestion}
          onClose={() => setConfirm(null)} />
      )}

      {confirm === 'save' && (
        <MConfirm
          title={tr('حفظ الحركة')}
          message={`${tr('تحميل')}: ${formatNumber(split.out.length)} · ${tr('تنزيل للمستودع')}: ${formatNumber(split.back.length)} — ${tr('السالب ينزل للمستودع ولا يحمل للسيارة')}`}
          confirmLabel={tr('حفظ الحركة')}
          loading={save.isPending}
          onConfirm={() => save.mutate()}
          onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}

/* ═══════════════════════ لبنات داخلية ═══════════════════════ */

/**
 * «تتبّع اللوط»: معاينة توزيع FEFO لسطر تحميلٍ من المستودع — الخادم يعيد التوزيع نفسه عند الحفظ تحت القفل، فهذه قراءةٌ
 * لما سيحدث لا اختيارٌ يُرسل. وتحذيرات الصنف ونقصه على سطره الأول وحده (لا تتكرّر لكل وحدة).
 */
function FefoPreview({ productId, prod, f }: {
  productId: string;
  /** وحدات الصنف: كميات التوزيع بالأساس بجانب سطرٍ بوحدته (القاعدة ٨) */
  prod: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null };
  f: { loading: boolean; rows: AllocRowDto[]; first: boolean; warnings: LotWarning[]; shortage: LotShortageDetail | null } | null;
}) {
  const tr = useTr();
  const lotsQ = useProductLots(productId, !!f && f.rows.some(r => r.lotId));
  if (!f) return <p className="text-[10px] text-[#9A8F7E] px-0.5">{tr('جاري حساب التشغيلات المقترحة')}</p>;
  const numberOf = (id: string | null) => (id ? lotsQ.data?.find(l => l.id === id)?.lotNumber ?? '…' : null);
  return (
    <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-2.5 py-2 space-y-1">
      <p className="text-[10px] font-semibold text-[#6E6557]">{tr('التشغيلات المقترحة الأقرب انتهاء أولا')}</p>
      {f.loading ? <p className="text-[10px] text-[#9A8F7E]">{tr('جاري التحميل')}</p>
        : !f.rows.length ? <p className="text-[10px] text-[#C0392B]">{tr('لا رصيد صالحا لهذا الصنف في المستودع')}</p>
        : f.rows.map((r, i) => (
          <div key={`${r.lotId ?? 'u'}-${i}`} className="flex items-center justify-between gap-2 text-[11px]">
            <span className="min-w-0 truncate text-[#1F1A13]">
              {lotLineLabel({ lotNumber: numberOf(r.lotId), expiryDate: r.expiryDate }, tr('غير مسمى'), tr('ينتهي'))}
            </span>
            <b className="tabular-nums flex-shrink-0">{lotQtyText(r.qty, prod, fmtLotQ)}</b>
          </div>
        ))}
      {f.first && f.shortage && (
        <p className="text-[10px] text-[#C0392B]">
          {tr('المتاح في المستودع')} {lotQtyText(f.shortage.available, prod, fmtLotQ)} — {tr('لن يحفظ التحميل بأكثر منه')}
        </p>
      )}
      {f.first && [...new Set(f.warnings.map(w => w.code))].map(c => (
        <p key={c} className="text-[10px] text-[#B7791F] flex items-start gap-1">
          <AlertTriangle size={10} className="flex-shrink-0 mt-0.5" /> {tr(LOT_WARNING_LABELS[c])}
        </p>
      ))}
      <p className="text-[9px] text-[#9A8F7E]">{tr('يؤكد التوزيع عند الحفظ')}</p>
    </div>
  );
}

/**
 * «تتبّع اللوط»: توزيع سطر التنزيل على مصادر السيارة (D10) — المصدر الوحيد يُنزَّل منه تلقائياً، وأكثر من مصدرٍ يلزمه
 * توزيعٌ صريح مجموعه كمية السطر بالأساس. الموقوف والمنتهي في الأعلى: هو ما يُخرج أولاً في السحب.
 */
function OutLotsEditor({ sources, prod, loading, base, rows, onChange }: {
  sources: OutSource[]; prod: { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null };
  loading: boolean; base: number; rows: LotRef[]; onChange: (rows: LotRef[]) => void;
}) {
  const tr = useTr();
  // التوزيع يُدخَل بالأساس: أرقامه بجانب اسم الأساس بلا تفكيك، والمصدر الوحيد مفكَّكاً بوحدات الصنف (القاعدة ٨)
  const baseOnly = { unit: prod.unit };
  const label = (s: OutSource) => lotLineLabel(s, tr('غير مسمى'), tr('ينتهي'));
  if (loading) return <p className="text-[10px] text-[#9A8F7E] px-0.5">{tr('جاري التحميل')}</p>;
  if (sources.length === 0) return null;
  if (sources.length === 1) {
    return (
      <p className="text-[10px] text-[#6E6557] px-0.5">
        {tr('ينزل من')} {label(sources[0])} · {tr('المتاح')} {lotQtyText(sources[0].usable, prod, fmtLotQ)}
      </p>
    );
  }
  const left = lotRowsRemaining(rows, base);
  return (
    <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-2.5 py-2 space-y-1.5">
      {/* التوزيع بالأساس (R8) — ولصنفٍ له «وحدة رئيسية» يُسمّى الأساس باسمه لا «وحدة الأساس» (D21)، وبلاها النصّ كما كان */}
      <p className="text-[10px] font-semibold text-[#6E6557]">
        {primaryUnitOf(prod) ? fill(tr('من أي تشغيلة ينزل بـ{unit}'), { unit: String(prod.unit ?? '') }) : tr('من أي تشغيلة ينزل بوحدة الأساس')}
      </p>
      {sources.map(s => {
        const v = rows.find(r => r.lotId === s.lotId)?.qty;
        return (
          <div key={s.lotId ?? 'u'} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px]">
              <span className="block truncate text-[#1F1A13]">{label(s)}</span>
              <span className="block text-[10px] text-[#9A8F7E]">
                {tr('المتاح')} {lotQtyText(s.usable, baseOnly, fmtLotQ)}
                {s.status === 'BLOCKED' && <b className="text-[#C0392B]"> · {tr(LOT_STATUS_LABELS.BLOCKED)}</b>}
                {s.status !== 'BLOCKED' && s.expired && <b className="text-[#C0392B]"> · {tr('منتهي الصلاحية')}</b>}
              </span>
            </span>
            <input className="input w-20 text-center min-h-[40px]" dir="ltr" type="number" inputMode="decimal" step="any" min="0"
              aria-label={label(s)} value={v ?? ''}
              onChange={e => onChange(setOutQty(rows, sources, s.lotId, Number(e.target.value)))} />
          </div>
        );
      })}
      {Math.abs(left) > LOT_EPS && (
        <p className="text-[10px] text-[#C0392B]">
          {left > 0 ? tr('باقي بلا توزيع') : tr('زائد عن كمية السطر')} {lotQtyText(Math.abs(left), baseOnly, fmtLotQ)}
        </p>
      )}
    </div>
  );
}

/** وسم الثقة — يُعرض دائماً بجوار الرقم فلا يُقرأ الاقتراح يقيناً */
function ConfidenceTag({ c }: { c: SuggestRow['confidence'] }) {
  const tr = useTr();
  const label = c === 'high' ? tr('ثقة عالية') : c === 'medium' ? tr('ثقة متوسطة') : tr('ثقة منخفضة');
  const cls = c === 'high' ? 'bg-[#EAF6F0] text-[#2F855A] border-[#C7E6D6]'
    : c === 'medium' ? 'bg-[#FDF6E7] text-[#B7791F] border-[#F0E0B8]'
      : 'bg-[#FDF2F0] text-[#C0392B] border-[#F5C6C0]';
  return <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${cls}`}>{label}</span>;
}

/**
 * ورقة تأكيد — نسخةٌ محلّية مطابقة لنظيرتها في شاشة المناديب (غير مُصدَّرة هناك).
 * و`useBackClose` داخلها: زرّ رجوع أندرويد يُغلق الورقة لا التطبيق كلّه.
 */
function MConfirm({ title, message, confirmLabel, loading, danger, onConfirm, onClose }: {
  title: string; message: string; confirmLabel: string;
  loading?: boolean; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const tr = useTr();
  useBackClose(true, onClose);
  return (
    // النقر على العتمة يُغلق — إلا والفعل جارٍ، فإغلاقٌ وقتها يُخفي نتيجته
    <div className="absolute inset-0 z-[700] bg-black/50 flex items-end"
      onClick={() => { if (!loading) onClose(); }}>
      <div className="w-full bg-white rounded-t-3xl p-4 space-y-3" onClick={e => e.stopPropagation()}
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <div className="flex items-start gap-3">
          <span className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${danger ? 'bg-[#FDF2F0] text-[#C0392B]' : 'bg-[#FBEBE2] text-[#C94E28]'}`}>
            <AlertTriangle size={20} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-[#1F1A13]">{title}</span>
            <span className="block text-[12px] text-[#6E6557] mt-1 leading-relaxed">{message}</span>
          </span>
        </div>
        <div className="flex gap-2.5 pt-1">
          <button onClick={onClose} disabled={loading}
            className="flex-1 min-h-[48px] rounded-xl border border-[#E9E1D3] bg-white font-bold text-sm text-[#1F1A13]">
            {tr('إلغاء')}
          </button>
          <button onClick={onConfirm} disabled={loading}
            className={`flex-1 min-h-[48px] rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 ${danger ? 'bg-[#C0392B] disabled:bg-[#D98A80]' : 'bg-[#E15A30] disabled:bg-[#E89B7E]'}`}>
            {loading && <Loader2 size={16} className="animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
