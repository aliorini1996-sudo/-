import { Fragment, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { warehouseApi, productApi, companyApi, repStockRequestApi } from '../api/client';
import { formatDate, formatCurrency, formatDayOnly } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useLang } from '../i18n/lang';
import SearchableSelect from '../components/SearchableSelect';
import { Warehouse, PackagePlus, X, Trash2, TrendingUp, TrendingDown, AlertTriangle, Calendar, ArrowRightLeft, Wallet, Info, FileDown, ClipboardList, Truck, Layers, ChevronDown, ChevronUp, CopyPlus, Eraser, SlidersHorizontal } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAccountingOn, AccountingOffNotice } from '../components/AccountingGate';
import DocumentModal from '../components/DocumentModal';
import StockRequestModal from '../components/StockRequestModal';
import StockZeroModal from '../components/StockZeroModal';
import { useOwnerBulkPurge } from '../components/OwnerBulkPurge';
import { warehouseNoticeDocFromEntry, Company } from '../rep/RepDocuments';
import { isTaxOff } from '../lib/taxMode';
import { useAuthStore, isStaffImpersonationClient } from '../store/authStore';
import { biggestUnit, hasBigUnit, productUnitLabel } from '../lib/adminUnits';
import { anyBigUnit, fmtTotalQty, qtyText, qtyViewFor, totalsList, unitTotalsParts, type QtyView, type UnitTotal } from '../lib/qtyView';
import { useQtyView } from '../store/qtyViewStore';
import QtyViewToggle from '../components/QtyViewToggle';
import { choiceById, defaultChoice, rebaseRow, unitChoices } from '../rep/repUnits';
import { primaryUnitOf, roundQty, type UnitDef } from '../lib/units';
import { anyPrimary, crossSumLabel, isStaleUnitsError } from '../lib/stockRequest';
import {
  costKindOf, duplicateNames, isDuplicateName, isZeroQty, lowStockCount, rowState, rowUnitCost, signedQty, splitDormant, valueBreakdown,
} from '../lib/warehouseRows';
import { countLead, countText } from '../lib/arCount';
import { entryAttempt, isReplayResponse, productArchivedOf, zeroAdjustStart, type EntryAttempt } from '../lib/warehouseEntry';
import {
  LOT_BLOCK_KIND_LABELS, LOT_STATUS_LABELS, LOT_WARNING_LABELS, isLotExpiredOn, lotDay, lotErrorOf, lotFlagsOf, lotWarningsOf, roundLot, toBaseQty,
} from '../lib/lots';
import {
  autoDecreaseOver, autoDecreasePreview, emptyEntryLot, entryLotFields, entryLotProblem, explicitDecreaseOver, isFourDecimals, lotRowSummary, newRowId, normalizeEntryLot,
  outSourcesOf, shelfLifeOn,
  type EntryLotDraft, type EntryLotKind, type PlaceViewWithAvailability,
} from '../lib/stockLots';
import { EntryLotFields, fetchLotBalances, fmtLotQty } from '../components/StockLotFields';

/*
 * الوحدات المتعددة: أرصدة المستودع كلّها **بوحدة الأساس** (`unit`) وتُعرض «٢ كرتون و٣ حبة» من `units`، ومتوسّط التكلفة
 * لوحدة الأساس (الحبة لا الكرتون). وسطر الوارد بوحدته وسعرها كما في فاتورة المورّد («١٠ كرتون بـ٤٨ للكرتون») —
 * الخادم يحلّ `unitId` إلى معامله ويقسم التكلفة عليه عند التقييم. وسجلّ الوارد يقرأ لقطة وحدة كل سطر.
 *
 * «تتبّع اللوط» (W2، يفعّله المالك لكل شركة): سطر الوارد لصنفٍ متتبَّع بتشغيلته (الرقم وتاريخا الإنتاج والانتهاء)، وللصنف
 * أكثر من سطرٍ لدفعتين؛ ونقص التسوية سحبٌ تلقائي بالأقرب انتهاءً أولاً (أو تحديدٌ يدوي)؛ وصفّ الرصيد يتوسّع بتشغيلاته والمعزول والعجز (ومع «المخزون في تاريخ»).
 * الميزة مطفأة ⇒ لا جلب ولا عمود ولا تغيير مرئي (§١٠.١).
 *
 * «الوحدة الرئيسية» (القاعدة ١٢، primary_unit_spec §5.3): صنفٌ لها تُعرض أرصدته بها («52 كرتون و2 قارورة») ووسمه «الوحدة
 * الرئيسية كرتون (24 قارورة)» بلا كلمة «الأساس» (D21)، وتكلفته للرئيسية أولاً (المتوسّط × معاملها) ثم للقارورة، وسطر الوارد
 * بها افتراضاً (defaultChoice). وكل سطر وارد يحمل `baseUnitName` (الأساس كما رآه النموذج) فيكشف الخادم قائمةً قديمة:
 * 400/409 ⇒ تُجلب الأصناف من جديد ويُعاد كل سطر إلى وحدته الآن (rebaseRow) قبل أن يُعاد الحفظ. `stockValue` لا يتغيّر.
 * والمجاميع عبر الأصناف (ما في السيارات) بالأساس موسومةً «بالوحدات الصغرى» حين في الأصناف ما له رئيسية (R3).
 * صنفٌ بلا رئيسية: كل نصٍّ كما كان حرفاً (I1).
 *
 * «عرض الكميات» (طلب المالك ٤ نوفمبر ٢٠٢٦، lib/qtyView): مبدّلٌ في بطاقة القيمة بين الوحدة الكبرى (عرض اليوم حرفاً) والصغرى
 * (رقم الأساس واسمه، والتكلفة للصغرى وحدها)، وما في السيارات بالكبرى من `vans.major` لكل وحدة. عرضٌ فقط، والنماذج والسجلّ كما هي.
 * لا صنف له وحدةٌ أكبر ⇒ لا مبدّل والصفحة كما كانت.
 *
 * «مراجعة المخزون» (نوفمبر ٢٠٢٦، lib/warehouseRows): الموقوف والمحذوف موسومان في ذيل الجدول وخارج «يحتاج استلام» و«طلب
 * مخزون»، والاسم المكرّر موسومٌ بكوده (S1)؛ و«تسوية» على كل صفّ تفتح نافذة التسوية بصنفه ولو حُذف من المنتجات (S2)؛ وتحت
 * القيمة «الموجب − العجز» حين فيها عجز (S7)؛ والتكلفة الكبرى من قيمة الصف (S8) وعلاماتٌ لا تختلط للعجز وبلا تكلفة (S10)؛
 * ولا إشارة على الصفر والكميات حتى أربع منازل (S9، #19). عرضٌ كلّه: لا رقمٌ مخزَّن ولا القيمة الصافية يتغيّر.
 */

interface WhRow {
  productId: string; name: string; code: string; unit: string;
  /** وحدات الصنف — لعرض الأرصدة بالأساس مفكَّكة، لا لحسابها */
  units?: UnitDef[];
  /** «الوحدة الرئيسية» — عرضٌ فقط (خادمٌ قبل الميزة لا يرسلها ⇒ بلا رئيسية) */
  primaryUnitId?: string | null;
  /** حالة الصنف وأرشفته (S1) — عرضٌ فقط، وخادمٌ أقدم لا يرسلهما ⇒ لا وسم */
  status?: 'ACTIVE' | 'INACTIVE' | string;
  archived?: boolean;
  received: number; adjusted: number; loadedToVans: number; returnedFromVans: number; onHand: number;
  avgCost: number;     // متوسّط تكلفة **وحدة الأساس** (متحرّك، على الرصيد الباقي)
  costedQty: number;   // كمية من الرصيد تكلفتها معروفة — هي وحدها المقيَّمة
  stockValue: number;  // قيمة الرصيد بتكلفة الشراء
  uncostedQty: number; // كمية واردة بلا سعر — حدّ صدق التقييم
}
interface WhEntry {
  id: string; type: string; note: string | null; supplier: string | null; createdBy: string | null; createdAt: string;
  /** «تصفير المخزون»: معرّف التصفير الذي كتب هذه التسوية — null (أو غائبٌ من خادمٍ أقدم) لكل حركةٍ عادية */
  zeroRunId?: string | null;
  // lineCost: قيمة السطر كما قرّبها الخادم — للإشعار المطبوع، مجموعها = totalCost.
  // unitName/unitFactor لقطة وحدة السطر: الكمية وتكلفة الوحدة بها (الكرتون كرتوناً)
  // lot: تشغيلة السطر («تتبّع اللوط»، والميزة مفعّلة وحدها)، وproductId لعدّ أصناف الإشعار لا بنوده (نقصٌ تلقائي من تشغيلتين = بندان)
  items: {
    id: string; productId?: string; qty: number; unitName?: string | null; unitFactor?: number | null; baseQty?: number | null; unitCost: number | null; lineCost?: number | null;
    product: { name: string; unit: string };
    lot?: { lotNumber: string; productionDate: string | null; expiryDate: string | null } | null;
  }[];
  totalCost: number; // يحسبه الخادم بالدالّة المختبَرة — لا يُعاد حسابه هنا
}
/** صنفٌ كما يردّه /products — حقول اللوط والصلاحية لسطر الوارد */
interface ProductPick {
  id: string; name: string; unit: string; code: string; taxPct: number; units?: UnitDef[]; primaryUnitId?: string | null;
  lotTracked?: boolean; shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null;
  /** ACTIVE | INACTIVE — الموقوف موسومٌ في منتقي النافذة (S3)، وغيابه كالنشط */
  status?: string;
}

/** جسم POST /warehouse/entries ومعه مرجع المحاولة (D8) — الحقل اختياريّ في الخادم، وخادمٌ أقدم يتجاهله */
type EntryPayload = Parameters<typeof warehouseApi.createEntry>[0] & { clientRef?: string };

/* حتى أربع منازل (مراجعة المخزون #19): منزلتان كانتا تطبعان بقيةً ٠٫٠٠٤ «0» بالأخضر و−٠٫٠٠٤ «−0» بالأحمر — ورقمٌ غير صفرٍ
 * لا يُطبع صفراً أبداً (fmtTotalQty)، وغبار العائمة (مجموع الوارد والتسويات) يُحجب قبله (roundQty) */
const fmtQty = (n: number) => fmtTotalQty(roundQty(n));

/** S13: «لا تعرف بضاعتها» كانت تُقرأ «أنت لا تعرف» — مفتاح القاموس، وأوّل كلمةٍ فيه المعدود (countLead) */
const DELETED_VANS_TEXT = 'سيارة لمندوب محذوف بضاعتها غير معروفة فلا تدخل هنا';

/** ما في مخزون السيارات الآن (GET /warehouse/vans) — الرصيد المتاح وقيمته بكلفة خروجه من المستودع */
interface VansStock {
  qty: number; value: number; uncostedQty: number; unsellableQty: number; reps: number; products: number; deletedVans?: number;
  /** «تتبّع اللوط»: المعزول (تشغيلة موقوفة أو منتهية لم تُبع) والمحجوز (إشعار قياسي بانتظار الاعتماد) — داخلان في المتاح ولا يُباعان */
  lotQuarantined?: number; lotHeld?: number;
  /** «عرض الكميات»: المجاميع نفسها لكل وحدةٍ كبرى («22.75 كرتون · 40 حبة») — خادمٌ أقدم لا يرسلها ⇒ العرض القائم */
  major?: { qty: UnitTotal[]; uncostedQty: UnitTotal[]; unsellableQty: UnitTotal[] };
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
  // تمييز العدد بالعربية (S14): «6 أصناف» و«سيارتان» — واللغات الأخرى كما كانت
  const lang = useLang(s => s.lang);
  const [showEntry, setShowEntry] = useState(false);
  /* «تسوية» من صفّ الجدول (S2): النافذة بصنف الصفّ نفسه — اسمه ووحداته من صفّ المستودع لا من قائمة المنتجات، فيصل إلى صنفٍ
   * محذوفٍ بقي له رصيد (الخادم يقبل التسوية لأي صنفٍ للشركة). null = النافذة كما كانت من زرّ «استلام / تسوية» */
  const [entrySeed, setEntrySeed] = useState<WhRow | null>(null);
  const openEntry = (seed: WhRow | null) => { setEntrySeed(seed); setShowEntry(true); };
  // نافذة «طلب مخزون» لإدارة المشتريات أو الإنتاج
  const [showRequest, setShowRequest] = useState(false);
  const me = useAuthStore(s => s.user);
  /* «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦): لمدير الشركة غير المقيَّد بنطاق ولجلسة المالك وحدهما — إظهارٌ فقط،
   * والخادم هو الحَكَم (يرفض المقيَّد ومفتاح API وانتحال الموظف) */
  const impersonating = useAuthStore(s => s.impersonating);
  // «دخول» موظف المنصة دوره ADMIN و`impersonating` قائم — يُستثنى من الفرعين فالخادم يرفضه دائماً (٤٠٣)، ومديرٌ نُزعت منه «تحميل مخزون السيارة» يرفضه كذلك
  const canZeroStock = !isStaffImpersonationClient() && ((me?.role === 'ADMIN' && !me?.scopeEnabled && me?.canManageVanStock !== false) || !!impersonating);
  const [showZero, setShowZero] = useState(false);
  // تسويات التصفير المفتوحة أصنافها في السجلّ — مطويّةٌ افتراضاً («N صنف») فلا يغرق السجلّ بمئات الأسطر
  const [openZeroEntries, setOpenZeroEntries] = useState<Set<string>>(() => new Set());
  const toggleZeroEntry = (id: string) => setOpenZeroEntries(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
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
  // «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): شركةٌ بلا ضريبة — لا «قبل الضريبة» ولا «شاملة الضريبة»، والتكلفة كما تُكتب
  const taxOff = isTaxOff(companyQ.data);

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
  const purge = useOwnerBulkPurge('WarehouseEntry');

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
  // «يحتاج استلام» للنشط وحده (S1): الموقوف والمحذوف لا يُشترى فلا يُعدّ ناقصاً
  const lowCount = lowStockCount(rows);
  // المعروض في البطاقتين والجدول: رصيد التاريخ المختار أو الآن
  const shownRows = asOf ? (asOfQ.data ?? []) : rows;
  const shownLoading = asOf ? asOfQ.isLoading : stockQ.isLoading;
  // فشل الطلب لا يُعرض صفراً: «تعذر تحميل الأرصدة» بدل قيمةٍ خاطئة تحت عنوان التاريخ
  const shownError = asOf ? asOfQ.isError : stockQ.isError;
  // قيمة المخزون بتكلفة الشراء — ومعها حدّ صدقها: كم صنفا وارده بلا سعر
  const totalValue = shownRows.reduce((s, r) => s + r.stockValue, 0);
  const uncostedRows = shownRows.filter(r => r.uncostedQty > 0).length;
  // S7: القيمة صافيةٌ كما هي، وتحتها «منها عجز» حين في الصفوف قيمةٌ سالبة — ومنها ما في أصنافٍ محذوفة أو موقوفة
  const breakdown = valueBreakdown(shownRows);
  const deficitDormant = shownRows.filter(r => r.stockValue < 0 && rowState(r) !== null).length;
  // S1: النشط أولاً ثم الموقوف والمحذوف في ذيل الجدول، والاسم المكرّر (بعد التطبيع) موسومٌ في كل صفوفه
  const { active: activeRows, dormant: dormantRows } = splitDormant(shownRows);
  const dupNames = duplicateNames(shownRows);
  // R3: في الأصناف ما له وحدة رئيسية (صادقة — null لا يُعدّ)؟ — فالمجاميع عبر الأصناف (بالأساس) تُوسم «بالوحدات الصغرى»،
  // وعمود متوسط التكلفة يُوسم بوحدة كل خلية، وإلا كل وسمٍ كما كان حرفياً (I1)
  const hasPrimary = anyPrimary(rows) || anyPrimary(shownRows);
  // «عرض الكميات» (طلب المالك ٤ نوفمبر ٢٠٢٦): المبدّل لصفحةٍ فيها صنفٌ له وحدةٌ أكبر وحدها — وإلّا «الكبرى» = اليوم حرفاً
  const anyBig = anyBigUnit(rows) || anyBigUnit(shownRows);
  const qv = qtyViewFor(useQtyView(), anyBig);
  // ما في السيارات بالوحدة الكبرى من الخادم — «الصغرى» أو خادمٌ أقدم ⇒ المجموع بالأساس كما كان. ومبدّلٌ مخفيّ (لا وحدة أكبر
  // في الأصناف، فالعرض «الكبرى») ⇒ مجاميع الخادم لكل وحدة أساسٍ باسمها (S13): رقمٌ واحد كان يجمع بيضاً وكراتين بلا اسم
  const vansMajor = qv === 'major' ? vans?.major : undefined;
  // S11: صنفٌ بلا وحدات في جدولٍ فيه أصنافٌ مفكَّكة يُلحق اسم أساسه («-25 كرتون») — وجدولٌ بلا وحداتٍ أكبر كما كان حرفاً
  const unitOpt = { withUnit: anyBig };
  // وسم مجموعٍ بالأساس عبر الأصناف (بطاقة السيارات حين لا مجاميع لكل وحدة)
  const crossUnitWord = hasPrimary || anyBig ? tr('بالوحدات الصغرى') : tr('وحدة');
  const vansQtyTotals = totalsList(vansMajor?.qty);
  const vansUncostedTotals = totalsList(vansMajor?.uncostedQty);
  const vansUnsellableTotals = totalsList(vansMajor?.unsellableQty);

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

  // «تسوية» على صفّ الجدول (S2) لرصيد اليوم وحده: تحت تاريخٍ مضى تُكتب الحركة الآن لا في ذلك اليوم
  const rowActions = !asOf;
  const colCount = rowActions ? 8 : 7;
  const renderRow = (r: WhRow) => {
    // «الوحدة الرئيسية» الصالحة — غيابها (أو معرّفٌ تالف) الصفّ كما كان حرفاً
    const prim = primaryUnitOf(r);
    const tracked = trackedSet.has(r.productId);
    const view = tracked ? lotsQ.data?.views.get(r.productId) : undefined;
    const sum = tracked ? lotRowSummary(view, lotDayNow) : null;
    const open = tracked && openLots === r.productId;
    // S1: حال الصنف (محذوف/موقوف) واسمه المكرّر — وسمٌ فقط، والأرقام كما هي
    const state = rowState(r);
    const dup = isDuplicateName(r, dupNames);
    // S9/S11: لا إشارة على الصفر، وصنفٌ بلا وحدات في جدولٍ مفكَّك بكلمة أساسه
    const q = (n: number) => qtyText(qv, n, r, fmtQty, unitOpt);
    return (
      <Fragment key={r.productId}>
      <tr className={state ? 'bg-[#FAF7F0]/70' : r.onHand < 0 && !isZeroQty(r.onHand) ? 'bg-red-50/40' : undefined}>
        <td className="px-4 py-2.5">
          <div className={`font-semibold ${state ? 'text-[#6E6557]' : 'text-[#1F1A13]'}`}>{r.name}</div>
          <div className="text-[11px] text-[#9A8F7E]">{r.code} · {prim ? `${tr('الوحدة الرئيسية')} ${productUnitLabel(r)}` : hasBigUnit(r.units) ? `${tr('وحدة الأساس')} ${r.unit}` : r.unit}</div>
          {(state || dup) && (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] font-semibold">
              {state === 'ARCHIVED' && <span className="rounded bg-slate-100 border border-slate-200 text-slate-600 px-1.5">{tr('محذوف — بقي له رصيد')}</span>}
              {state === 'INACTIVE' && <span className="rounded bg-slate-100 border border-slate-200 text-slate-600 px-1.5">{tr('موقوف')}</span>}
              {/* الاسم نفسه لأكثر من صنف: الكود يميّز الحالي من القديم */}
              {dup && <span className="rounded bg-amber-50 border border-amber-200 text-amber-700 px-1.5">{tr('اسم مكرر')} · <span dir="ltr">{r.code}</span></span>}
            </div>
          )}
          {/* «تتبّع اللوط»: شاراتُ التشغيلات ومفتاح توسيع الصفّ بها */}
          {tracked && (
            <button type="button" onClick={() => setOpenLots(open ? null : r.productId)}
              className="mt-1 inline-flex items-center gap-1 flex-wrap text-[10px] font-semibold text-[#6E6557] hover:text-[#E15A30]">
              <Layers size={11} className="text-[#E15A30]" />
              {sum ? `${sum.lots} ${tr('تشغيلة')}` : tr('التشغيلات')}
              {sum && sum.quarantined > 0 && <span className="rounded bg-amber-50 border border-amber-200 text-amber-700 px-1">{tr('معزول')} {qtyText(qv, sum.quarantined, r, fmtQty)}</span>}
              {sum && sum.held > 0 && <span className="rounded bg-sky-50 border border-sky-200 text-sky-700 px-1">{tr('محجوز')} {qtyText(qv, sum.held, r, fmtQty)}</span>}
              {sum?.deficit && <span className="rounded bg-red-50 border border-red-200 text-red-600 px-1">{tr('عجز')}</span>}
              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </td>
        <td className="px-3 py-2.5 text-center">
          <span className={`font-extrabold ${isZeroQty(r.onHand) ? 'text-amber-600' : r.onHand < 0 ? 'text-red-600' : 'text-[#1E7A52]'}`}>{q(r.onHand)}</span>
        </td>
        <td className="px-3 py-2.5 text-center text-[#6E6557]">
          {q(r.received + r.adjusted)}
          {!isZeroQty(r.adjusted) && (
            <span className="block text-[10px] text-[#9A8F7E] mt-0.5">{tr('منها تسويات')} {signedQty(r.adjusted, r.adjusted < 0 ? '−' : '+', q(Math.abs(r.adjusted)))}</span>
          )}
        </td>
        <td className={`px-3 py-2.5 text-center ${isZeroQty(r.loadedToVans) ? 'text-[#C9BFAE]' : 'text-[#C94E28]'}`}>{signedQty(r.loadedToVans, '−', q(r.loadedToVans))}</td>
        <td className={`px-3 py-2.5 text-center ${isZeroQty(r.returnedFromVans) ? 'text-[#C9BFAE]' : 'text-[#1E7A52]'}`}>{signedQty(r.returnedFromVans, '+', q(r.returnedFromVans))}</td>
        <td className="px-3 py-2.5 text-center text-[#6E6557]"><WhCostCell r={r} qv={qv} hasPrimary={hasPrimary} /></td>
        <td className="px-3 py-2.5 text-center">
          {/* S10: عجزٌ نشأ قبل أي سعر «عجز بلا تكلفة» لا «0.00» يُقرأ مقيَّماً بصفر */}
          {costKindOf(r) === 'deficitUncosted'
            ? <span className="text-[11px] font-semibold text-red-600">{tr('عجز بلا تكلفة')}</span>
            : r.costedQty !== 0
              ? <span className={`font-bold ${r.stockValue < 0 ? 'text-red-600' : 'text-[#1F1A13]'}`}>{formatCurrency(r.stockValue)}</span>
              : <span className="text-[#C9BFAE]">—</span>}
          {r.uncostedQty > 0 && (
            <span className="block text-[10px] text-amber-600 mt-0.5">
              {q(r.uncostedQty)} {tr('خارج التقييم')}
            </span>
          )}
        </td>
        {rowActions && (
          <td className="px-2 py-2.5 text-center">
            {/* D1: تسوية بصنف الصفّ نفسه ولو حُذف من المنتجات — طريق تصحيح رصيده */}
            <button type="button" onClick={() => openEntry(r)} title={tr('تسوية رصيد هذا الصنف')} aria-label={`${tr('تسوية رصيد هذا الصنف')} ${r.name}`}
              className="inline-flex items-center gap-1 rounded-lg border border-[#E9E1D3] px-2 py-1 text-[11px] font-semibold text-purple-600 hover:bg-purple-50 whitespace-nowrap">
              <SlidersHorizontal size={12} /> {tr('تسوية')}
            </button>
          </td>
        )}
      </tr>
      {open && (
        <tr className="bg-[#FAF7F0]/60">
          <td colSpan={colCount} className="px-4 py-3">
            <WarehouseLotsDetail view={view} day={lotDayNow} loading={lotsQ.isLoading} error={lotsQ.isError} row={r} asOf={asOf} qv={qv} />
          </td>
        </tr>
      )}
      </Fragment>
    );
  };

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
          {canZeroStock && (
            <button type="button" onClick={() => setShowZero(true)} className="btn-secondary text-[#C0392B] border-red-200 hover:bg-red-50">
              <Eraser size={17} /> {tr('تصفير المخزون')}
            </button>
          )}
          <button onClick={() => openEntry(null)} className="btn-primary"><PackagePlus size={17} /> {tr('استلام / تسوية')}</button>
        </div>
      </div>

      {/* قيمة المخزون بتكلفة الشراء — الغرض من تسجيل سعر الوحدة عند الاستلام */}
      {rows.length > 0 && (
        <div className="card px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><Wallet size={20} /></span>
            <div>
              <p className="text-xs text-[#9A8F7E]">{tr('قيمة المخزون بتكلفة الشراء')}</p>
              {/* S15: «…» أثناء التحميل لا «0.00» — تاريخٌ اختير للتوّ لم تصل أرصدته بعد */}
              <p className={`text-xl font-extrabold text-[#1F1A13] ${shownLoading ? 'opacity-40' : ''}`}>
                {shownError ? <span className="text-sm text-red-600">{tr('تعذر تحميل الأرصدة')}</span> : shownLoading ? '…' : formatCurrency(totalValue)}
              </p>
              {/* S7: القيمة صافية — والعجز فيها يُقال لا يُطرح بصمت. يظهر حين في الصفوف قيمةٌ سالبة وحده */}
              {breakdown && !shownLoading && !shownError && (
                <p className="text-[11px] text-[#9A8F7E] mt-0.5 max-w-xs leading-relaxed">
                  {tr('منها عجز')} <b className="text-red-600" dir="ltr">{formatCurrency(breakdown.deficit)}</b>
                  {' '}({countLead(lang, breakdown.deficitCount, 'صنف', 'صنفا برصيد سالب', tr)}
                  {deficitDormant > 0 && <>، {tr('منها {n} محذوفة أو موقوفة').split('{n}').join(String(deficitDormant))}</>})
                  {' · '}{tr('والموجب')} <b className="text-[#1F1A13]" dir="ltr">{formatCurrency(breakdown.positive)}</b>
                </p>
              )}
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
          {/* «عرض الكميات»: الجدول وما في السيارات بالوحدة الكبرى أو الصغرى — عرضٌ فقط */}
          {anyBig && <QtyViewToggle />}
          {uncostedRows > 0 && (
            <p className="text-[11px] text-[#9A8F7E] flex items-center gap-1.5 max-w-sm">
              <Info size={13} className="shrink-0 text-amber-600" />
              {countLead(lang, uncostedRows, 'صنف', 'صنفا فيه كمية بلا تكلفة معروفة وهي خارج هذه القيمة سجل سعر الوحدة عند الاستلام ليكتمل التقييم', tr)}
            </p>
          )}
          {/* ما في مخزون السيارات: الكمية المتاحة للبيع وقيمتها بكلفة خروجها من المستودع — رابطٌ إلى مخزون السيارات */}
          {vans && (
            <Link to="/app/van-stock" title={tr('مخزون السيارات')}
              className="flex items-center gap-3 rounded-xl border border-[#F1EBDF] bg-[#FAF7F0] px-4 py-2.5 hover:border-[#E15A30]/40 transition-colors">
              <span className="w-10 h-10 rounded-xl bg-[#FBEBE2] text-[#E15A30] flex items-center justify-center"><Truck size={20} /></span>
              <div>
                <p className="text-xs text-[#9A8F7E]">{tr('في مخزون السيارات')}</p>
                {/* مجموعٌ عبر الأصناف بوحدات الأساس (الخادم) — حبّاتٌ لا كراتين لصنفٍ له وحدات؛ و«الكبرى» لكل وحدةٍ كبرى من الخادم */}
                <p className={`text-lg font-extrabold text-[#1F1A13] leading-tight ${vansQ.isFetching && !vansQ.isLoading ? 'opacity-40' : ''}`}
                  title={vansQtyTotals ? undefined : tr(crossSumLabel(hasPrimary))}>
                  {vansQtyTotals
                    ? <UnitTotalsInline list={vansQtyTotals} base={vans.qty} />
                    : <>{fmtQty(vans.qty)} <span className="text-xs font-semibold text-[#6E6557]">{crossUnitWord}</span></>}
                  <span className="text-[#C9BFAE] mx-1.5">·</span>
                  {formatCurrency(vans.value)}
                </p>
                {/* S13/S14: كل كميةٍ بوحدتها (لا «1,500» تُقرأ ريالاً)، والعدد بتمييزه العربي («سيارتان · 6 أصناف») */}
                <p className="text-[11px] text-[#9A8F7E]">
                  {countText(lang, vans.reps, 'سيارة', tr)} · {countText(lang, vans.products, 'صنف', tr)}
                  {vans.uncostedQty > 0 && <> · {vansUncostedTotals ? <UnitTotalsInline list={vansUncostedTotals} base={vans.uncostedQty} paren /> : <>{fmtQty(vans.uncostedQty)} {crossUnitWord}</>} {tr('بلا تكلفة معروفة خارج القيمة')}</>}
                  {vans.unsellableQty > 0 && <> · {vansUnsellableTotals ? <UnitTotalsInline list={vansUnsellableTotals} base={vans.unsellableQty} paren /> : <>{fmtQty(vans.unsellableQty)} {crossUnitWord}</>} {tr('تالف أو منتهي لا يباع')}</>}
                </p>
                {/* «تتبّع اللوط»: تشغيلاتٌ معزولة أو محجوزة في السيارات — ضمن المتاح أعلاه ولا تُباع.
                    مجموعٌ بالأساس عبر الأصناف: تحت مجاميع «الكبرى» (بلا وسمٍ فوقه) يُوسم «بالوحدات الصغرى» وإلّا قُرئ كراتين */}
                {vansLotUnsellable > 0 && (
                  <p className="text-[11px] text-amber-700">
                    {fmtQty(vansLotUnsellable)}{vansQtyTotals && <> {tr('بالوحدات الصغرى')}</>} {tr('في تشغيلات معزولة أو محجوزة لا يباع')}
                    {(vans.lotHeld ?? 0) > 0 && <> ({fmtQty(vans.lotHeld ?? 0)} {tr('بانتظار الاعتماد')})</>}
                  </p>
                )}
                {(vans.deletedVans ?? 0) > 0 && (
                  <p className="text-[11px] text-amber-700">{countLead(lang, vans.deletedVans ?? 0, 'سيارة', DELETED_VANS_TEXT, tr)}</p>
                )}
              </div>
            </Link>
          )}
        </div>
      )}

      {lowCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm text-amber-800 flex items-center gap-2">
          {/* على رصيد اليوم دائماً — وتحت تاريخٍ مضى يُقال ذلك (S15) فلا يُقرأ عن جدولٍ أرصدته موجبة */}
          <AlertTriangle size={16} /> {asOf && <b>{tr('رصيد اليوم')}:</b>} {countLead(lang, lowCount, 'صنف', 'صنفا برصيد صفر أو سالب يحتاج استلام بضاعة', tr)}
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
                  {/* S12: الوارد ومعه التسويات بإشارتها — و«منها تسويات» تحت الرقم حين توجد، فلا يُقرأ نقص الجرد وارداً أقلّ */}
                  <th className="text-center font-semibold px-3 py-2.5">{tr('الوارد والتسويات')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('خرج للسيارات')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('عاد منها')}</th>
                  {/* لوحدة الأساس (الخادم: avgCost للحبة) — «متوسط تكلفة الوحدة» كان يُقرأ سعر كرتون. ومع أصنافٍ لها رئيسية: خلية
                      الصنف ذي الرئيسية موسومةٌ باسم كل وحدة (الرئيسية أولاً)، فالعنوان بلا «الأساس» (D21) */}
                  <th className="text-center font-semibold px-3 py-2.5">{hasPrimary ? tr('متوسط التكلفة') : tr('متوسط التكلفة لوحدة الأساس')}</th>
                  <th className="text-center font-semibold px-3 py-2.5">{tr('قيمة الرصيد')}</th>
                  {rowActions && <th className="px-2 py-2.5"><span className="sr-only">{tr('تسوية')}</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F1EBDF]">
                {activeRows.map(renderRow)}
                {/* S1: الموقوف والمحذوف الذي بقي له رصيد في ذيل الجدول بعنوانه — لا يبدو الصنف مكرّراً بجانب بديله */}
                {dormantRows.length > 0 && (
                  <tr className="bg-[#F4F0E8]">
                    <td colSpan={colCount} className="px-4 py-2 text-[11px] font-bold text-[#6E6557]">
                      {tr('أصناف موقوفة أو محذوفة لها رصيد')} ({fmtQty(dormantRows.length)})
                      <span className="block text-[10px] font-normal text-[#9A8F7E]">{tr('لا تعد في «يحتاج استلام» ولا «طلب مخزون» — صحح رصيدها بتسوية')}</span>
                    </td>
                  </tr>
                )}
                {dormantRows.map(renderRow)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* سجلّ الوارد والتسويات */}
      {purge.bar}
      <div className="card p-0 overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#F1EBDF] font-bold text-[#1F1A13] text-sm flex items-center gap-2">
          {purge.enabled && purge.headerBox((entriesQ.data || []).map(e => e.id))}
          <ArrowRightLeft size={16} className="text-[#E15A30]" /> {tr('سجل الوارد والتسويات')}
        </div>
        {entriesQ.isLoading ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('جار التحميل')}</div>
        ) : (entriesQ.data || []).length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">{tr('لا توجد حركات وارد بعد')}</div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto divide-y divide-[#F1EBDF]">
            {(entriesQ.data || []).map(e => {
              // تسوية «تصفير المخزون»: شارةٌ حمراء بدل «تسوية»، وأصنافها مطويّة بعددها حتى تُفتح
              const isZero = !!e.zeroRunId;
              const itemsOpen = !isZero || openZeroEntries.has(e.id);
              return (
              <div key={e.id} className="px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                  {purge.enabled && purge.rowBox(e.id)}
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-md flex items-center gap-1 ${isZero ? 'text-red-700 bg-red-50 border border-red-200' : e.type === 'RECEIVE' ? 'text-[#1E7A52] bg-green-50' : 'text-purple-600 bg-purple-50'}`}>
                    {isZero ? <Eraser size={12} /> : e.type === 'RECEIVE' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {isZero ? tr('تصفير المخزون') : e.type === 'RECEIVE' ? tr('وارد') : tr('تسوية')}
                  </span>
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
                {isZero && (
                  <button type="button" onClick={() => toggleZeroEntry(e.id)} aria-expanded={itemsOpen}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-[#6E6557] hover:text-[#E15A30]">
                    {e.items.length} {tr('صنف')} · {itemsOpen ? tr('إخفاء الأصناف') : tr('إظهار الأصناف')}
                    {itemsOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                )}
                {itemsOpen && (
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {e.items.map(it => {
                    // لقطة وحدة السطر: «١٠ كرتون · ٤٨/كرتون» — وحدة الصنف اليوم (الأساس بعد التحويل) تنسب سعر الكرتون للحبة.
                    // ونقصٌ «تلقائي» سُحب من أكثر من تشغيلة بنودٌ للصنف نفسه بتشغيلاتها (المفتاح معرّف البند لا الصنف)
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
                )}
                {e.totalCost > 0 && (
                  <p className="text-[11px] text-[#6E6557] mt-1.5">
                    {taxOff ? tr('قيمة البضاعة') : tr('قيمة البضاعة قبل الضريبة')}: <b className="text-[#1F1A13]">{formatCurrency(e.totalCost)}</b>
                  </p>
                )}
                {e.createdBy && <p className="text-[11px] text-[#9A8F7E] mt-1">{tr('سجلها')}: {e.createdBy}</p>}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {showEntry && <WarehouseEntryModal lotOn={lotOn} seed={entrySeed} stockRows={rows} taxOff={taxOff} onClose={() => { setShowEntry(false); setEntrySeed(null); }} />}
      {showZero && canZeroStock && <StockZeroModal onClose={() => setShowZero(false)} />}

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

/**
 * خلية متوسّط التكلفة (S8، S10) — ثلاث علاماتٍ لا تختلط بدل «—» واحدة: رصيدٌ مقيَّم ⇒ المتوسّط (والكبرى من قيمة الصف، فالكمية ×
 * تكلفة الكرتون = قيمة الصف)، وعجزٌ له قيمة ⇒ «تكلفة العجز»، وعجزٌ نشأ قبل أي سعر ⇒ «عجز بلا تكلفة»، ورصيدٌ بلا تكلفة معروفة ⇒
 * «بلا تكلفة»، و«—» لصفٍّ لا رصيد له وحده. عرضٌ فقط.
 */
function WhCostCell({ r, qv, hasPrimary }: { r: WhRow; qv: QtyView; hasPrimary: boolean }) {
  const tr = useTr();
  const kind = costKindOf(r);
  if (kind === 'none') return <span className="text-[#C9BFAE]">—</span>;
  if (kind === 'uncosted') return <span className="text-[11px] font-semibold text-amber-600">{tr('بلا تكلفة')}</span>;
  if (kind === 'deficitUncosted') return <span className="text-[11px] font-semibold text-red-600">{tr('عجز بلا تكلفة')}</span>;
  const deficit = kind === 'deficit';
  // للأساس: متوسّط الخادم للمقيَّم، وللعجز قيمته ÷ كميته (متوسّط الخادم له صفر)
  const base = rowUnitCost(r, 1) ?? 0;
  const prim = primaryUnitOf(r);
  const big = biggestUnit(r.units);
  const head = deficit ? <span className="block text-[10px] font-semibold text-red-600">{tr('تكلفة العجز')}</span> : null;
  // «عرض الكميات» بالصغرى: تكلفة الوحدة الصغرى وحدها باسمها («بيض: 0.3068») — لا سطر كرتونٍ تحتها
  if (qv === 'minor' && hasBigUnit(r.units)) return <>{head}<span title={String(base)}>{r.unit}: {formatCurrency(base, undefined, 4)}</span></>;
  if (prim) {
    /* «الوحدة الرئيسية»: تكلفتها أولاً ثم القارورة سطراً تحتها، كلٌّ باسم وحدته */
    return (
      <>
        {head}
        <span>{prim.name}: {formatCurrency(rowUnitCost(r, Number(prim.factor)) ?? 0, undefined, 4)}</span>
        {/* التلميح (المتوسّط غير المقرَّب للقارورة) على سطر القارورة نفسه — على سطر الكرتون يُقرأ تكلفة كرتون */}
        {deficit
          ? <span className="block text-[10px] text-[#9A8F7E] mt-0.5">{r.unit}: {formatCurrency(base, undefined, 4)}</span>
          : <span className="block text-[10px] text-[#9A8F7E] mt-0.5" title={String(r.avgCost)}>{r.unit}: {formatCurrency(r.avgCost, undefined, 4)}</span>}
      </>
    );
  }
  return (
    <>
      {head}
      {/* العنوان بلا «لوحدة الأساس» حين في الجدول صنفٌ له رئيسية — فخلية غيره تُسمّي وحدتها كي لا تُقرأ سعر كرتون */}
      <span title={String(base)}>{hasPrimary ? `${r.unit}: ` : ''}{formatCurrency(base, undefined, 4)}</span>
      {/* وتكلفة أكبر وحدةٍ بجانبها — المالك يشتري بالكرتون ويقارن به */}
      {big && <span className="block text-[10px] text-[#9A8F7E] mt-0.5">{big.name}: {formatCurrency(rowUnitCost(r, Number(big.factor)) ?? 0, undefined, 4)}</span>}
    </>
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

/**
 * «عرض الكميات» بالكبرى في بطاقة «ما في السيارات»: مجموعات الخادم بأربع منازل («0.0028 كرتون» لا «0»)، كلٌّ رقمه واسمه
 * لا ينكسران بين سطرين، ويُضمّ بـ« + » لا بـ« · » فاصلِ بنود السطر — و`paren` يحيط المتعدّد بقوسين قبل وسمه
 * («(0.25 كرتون + 6 كيس) بلا تكلفة معروفة») كي لا تُقرأ مجموعته الأولى بنداً بلا وسم.
 * قائمةٌ فارغة ومجموع الأساس غير صفر (كسورٌ دون أربع منازل) ⇒ رقم الأساس موسوماً، لا «0» لبضاعةٍ قائمة.
 */
function UnitTotalsInline({ list, base, paren = false }: { list: UnitTotal[]; base: number; paren?: boolean }) {
  const tr = useTr();
  const parts = unitTotalsParts(list, fmtTotalQty);
  if (!parts.length) return Math.abs(base) > 1e-9 ? <>{fmtQty(base)} {tr('بالوحدات الصغرى')}</> : <>{fmtTotalQty(0)}</>;
  const body = parts.map((x, i) => (
    <Fragment key={i}>{i > 0 && ' + '}<span className="whitespace-nowrap">{x}</span></Fragment>
  ));
  return paren && parts.length > 1 ? <>({body})</> : <>{body}</>;
}

/** تفصيل صفّ الرصيد بتشغيلاته في المستودع: الخام والصالح والمحجوز لكل تشغيلة، وغير المسمّى، والعجز */
function WarehouseLotsDetail({ view, day, loading, error, row, asOf, qv }: {
  view: PlaceViewWithAvailability | undefined; day: string; loading: boolean; error: boolean;
  row: { unit: string; units?: UnitDef[]; primaryUnitId?: string | null }; asOf: string;
  /** «عرض الكميات» النافذ في الصفحة */
  qv: QtyView;
}) {
  const tr = useTr();
  if (loading) return <p className="text-xs text-[#9A8F7E]">{tr('جار التحميل')}</p>;
  if (error) return <p className="text-xs text-red-600">{tr('تعذر تحميل الأرصدة')}</p>;
  if (!view) return <p className="text-xs text-[#9A8F7E]">{tr('لا تشغيلات لهذا الصنف في المستودع')}</p>;
  const lots = view.lots.filter(l => Math.abs(l.raw.SELLABLE) > 1e-6 || Math.abs(l.held.SELLABLE) > 1e-6);
  const unknown = view.unknown?.SELLABLE ?? 0;
  const q = (n: number) => qtyText(qv, n, row, fmtLotQty);
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

/**
 * سطر نافذة الوارد: مفتاحه rowId لا الصنف — صنفٌ متتبَّع في سطرين لدفعتين بتشغيلتين. و`baseUnit` أساس الصنف **كما رآه النموذج**
 * لحظة إضافة السطر (product.unit): يُرسَل `baseUnitName` فيكشف الخادم قائمةً قديمة، ولا يتغيّر إلا بإعادة الأساس (rebaseRows)
 */
interface EntryRow { rowId: string; productId: string; name: string; unit: string; unitId: string | null; baseUnit: string; qty: string; unitCost: string; lot: EntryLotDraft }

// نموذج تسجيل وارد (استلام/شراء) أو تسوية للمستودع
// `seed` (D1): «تسوية» من صفّ الجدول — النافذة تسويةً بسطر صنف الصفّ ولو حُذف من المنتجات. و`stockRows` أرصدة اليوم:
// «الرصيد الآن» تحت كل سطر و«اجعل الرصيد صفراً» للتسوية، ومعرفة المحذوف قبل الإرسال
function WarehouseEntryModal({ onClose, lotOn, seed = null, stockRows = [], taxOff = false }: { onClose: () => void; lotOn: boolean; seed?: WhRow | null; stockRows?: WhRow[]; taxOff?: boolean }) {
  const qc = useQueryClient();
  const tr = useTr();
  const [type, setType] = useState<'RECEIVE' | 'ADJUST'>(seed ? 'ADJUST' : 'RECEIVE');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  // صنف الصفّ كما في صفّ المستودع — قائمة المنتجات لا تحمل المحذوف، فيُحلّ منه اسمه ووحداته وأساسه (الخادم يقبل التسوية لأي صنفٍ للشركة)
  const seedPick: ProductPick | null = seed
    ? { id: seed.productId, name: seed.name, unit: seed.unit, code: seed.code, taxPct: 0, units: seed.units, primaryUnitId: seed.primaryUnitId ?? null }
    : null;
  // الوحدات المتعددة: صفٌّ لكل صنف بوحدةٍ تُختار عليه — الكمية **وسعر الوحدة** بها («١٠ كرتون بـ٤٨ للكرتون» كما في
  // فاتورة المورّد)، و`unitId` (null = الأساس) يحلّه الخادم إلى معامله. والتسوية بالوحدة نفسها زيادةً أو نقصاً.
  // «تتبّع اللوط»: الصنف المتتبَّع يجوز له أكثر من صفّ (دفعتان بتشغيلتين)، فالفهرسة بـrowId
  const [rows, setRows] = useState<EntryRow[]>(() => {
    if (!seedPick) return [];
    const c = defaultChoice(seedPick);
    // الكمية فارغة: المستخدم يكتب التسوية أو يضغط «اجعل الرصيد صفراً» — لا حفظ بكميةٍ لم يرها
    return [{ rowId: newRowId(), productId: seedPick.id, name: seedPick.name, unit: c.name, unitId: c.id, baseUnit: String(seedPick.unit ?? ''), qty: '', unitCost: '', lot: emptyEntryLot() }];
  });
  // فاتورة المورّد تعلن السعر شاملاً الضريبة غالباً؛ المؤشّر يخبر الخادم فيردّه
  // إلى صافيه قبل الحفظ — فيبقى العمود بمعنى واحد مهما اختلفت عادة المورّدين
  const [costsIncludeTaxState, setCostsIncludeTax] = useState(false);
  // «إزالة الضريبة»: لا خانة «شاملة الضريبة» ولا خصم ضريبةٍ من التكلفة — المكتوب هو التكلفة (والخادم يتجاهل العلم كذلك)
  const costsIncludeTax = !taxOff && costsIncludeTaxState;
  // D8: مرجع محاولة الحفظ — يُعاد مع الإعادة بالمحتوى نفسه (ضاع الردّ ⇒ الخادم يردّ الحركة نفسها ولا يكتبها ثانية)، ومحتوى آخر ⇒ مرجعٌ جديد
  const attempt = useRef<EntryAttempt>(null);
  // D3: المحذوف لا يُستلم (الخادم 422 PRODUCT_ARCHIVED) — من صفوف المستودع، ومعه ما ردّه الخادم في هذه النافذة
  const [refusedArchived, setRefusedArchived] = useState<ReadonlySet<string>>(() => new Set());
  const isArchived = (id: string) => refusedArchived.has(id) || stockRows.some(s => s.productId === id && s.archived === true) || (seed?.productId === id && seed.archived === true);
  const archivedReceive = (r: EntryRow) => type === 'RECEIVE' && isArchived(r.productId);
  const stockOf = (id: string) => stockRows.find(s => s.productId === id);

  // taxPct لازمة لاستخراج الضريبة من السعر الشامل في معاينة الإجمالي — والخادم
  // يعيد الاستخراج بنفسه عند الحفظ، فلا تُصدَّق نسبةٌ آتية من المتصفّح
  const prodQ = useQuery({ queryKey: ['products-min'], queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductPick[] });
  /* «تتبّع اللوط» لصنف الصفّ الغائب عن القائمة (المحذوف): الصفّ لا يحمل علم الصنف، فيُقرأ من الصنف نفسه (GET /products/:id يقرأ
   * المحذوف) والميزة مفعّلة وحدها — وتعذّر القراءة يُبقي السطر بلا تشغيلة كما كان */
  const seedMissing = !!seedPick && prodQ.isSuccess && !(prodQ.data || []).some(x => x.id === seedPick.id);
  const seedProdQ = useQuery({
    queryKey: ['wh-seed-product', seedPick?.id ?? ''],
    queryFn: async () => (await productApi.get(seedPick!.id)).data.data as ProductPick,
    enabled: lotOn && seedMissing,
    retry: false,
  });
  const seedFull: ProductPick | null = seedPick && seedProdQ.data
    ? { ...seedPick, lotTracked: seedProdQ.data.lotTracked, shelfLifeEnabled: seedProdQ.data.shelfLifeEnabled, shelfLifeValue: seedProdQ.data.shelfLifeValue, shelfLifeUnit: seedProdQ.data.shelfLifeUnit }
    : seedPick;
  const productOf = (id: string) => (prodQ.data || []).find(x => x.id === id) ?? (seedFull?.id === id ? seedFull : undefined);
  const isTracked = (id: string) => lotOn && productOf(id)?.lotTracked === true;
  // S3: الموقوف موسومٌ في المنتقي والاسم المكرّر يُقال (والكود في التلميح يميّز) — الاسم المضاف إلى السطر من الصنف لا من الوسم
  const pickDup = duplicateNames(prodQ.data || []);
  const optionLabel = (p: ProductPick) => [
    p.name,
    String(p.status ?? '').toUpperCase() === 'INACTIVE' ? `(${tr('موقوف')})` : '',
    isDuplicateName(p, pickDup) ? `· ${tr('اسم مكرر')}` : '',
  ].filter(Boolean).join(' ');
  /** «اجعل الرصيد صفراً»: كمية التسوية عكس رصيد اليوم — بالرئيسية حين ينقسم عليها، وإلّا بالأساس */
  const zeroRow = (r: EntryRow) => {
    const s = stockOf(r.productId);
    const p = productOf(r.productId);
    const z = s ? zeroAdjustStart(p ?? s, s.onHand) : null;
    const c = z ? choiceById(p, z.unitId) : null;
    if (z && c) patchRow(r.rowId, { unit: c.name, unitId: c.id, qty: String(z.qty) });
  };

  // الوحدة الافتراضية = الرئيسية، وإلّا الأكبر (repUnits.defaultChoice): المورّد يبيع بالكرتون، وبعد تحويل الصنف إلى الحبّة
  // يبقى «١» كرتوناً — ولصنفٍ رئيسيّه كرتون لا تقفز إلى الطبلية
  const addProduct = (id: string) => {
    if (!id || (rows.some(r => r.productId === id) && !isTracked(id))) return;
    const p = productOf(id);
    if (!p) return;
    const c = defaultChoice(p);
    setRows(rs => [...rs, { rowId: newRowId(), productId: id, name: p.name, unit: c.name, unitId: c.id, baseUnit: String(p.unit ?? ''), qty: '1', unitCost: '', lot: emptyEntryLot() }]);
  };
  /**
   * ردّ «وحدات الصنف تغيّرت» (400 UNIT_INVALID أو 409 PRODUCT_UNITS_CHANGED): الأصناف من جديد، وكل سطرٍ بوحدته الآن
   * (rebaseRow): الكرتون يبقى كرتوناً ولو صار وحدةً بعد تحويل الأساس، ووحدةٌ أُوقفت تصير قوارير بكميتها × معاملها ظاهرةً،
   * وسعر الوحدة يُفرَّغ حينها (كان لكرتونٍ لم يعد السطر به). والأساس المرسَل بعدها هو أساس الصنف الآن.
   */
  const rebaseRows = async () => {
    const before = prodQ.data || [];
    const fresh = await qc.fetchQuery({
      queryKey: ['products-min'], staleTime: 0,
      queryFn: async () => (await productApi.list({ limit: 1000 })).data.data as ProductPick[],
    });
    setRows(rs => rs.map(r => {
      const p = fresh.find(x => x.id === r.productId);
      const was = choiceById(before.find(x => x.id === r.productId), r.unitId);
      const rb = rebaseRow({ unit: r.unit, unitId: r.unitId, unitFactor: was?.id ? was.factor : 1, qty: r.qty }, p);
      if (!p || !rb) return r;
      const moved = rb.qty !== r.qty;
      return { ...r, unit: rb.choice.name, unitId: rb.choice.id, baseUnit: String(p.unit ?? ''), qty: String(rb.qty), ...(moved && { unitCost: '' }) };
    }));
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
  // مصادر النقص في المستودع: تُجلب لتسويةٍ فيها نقصٌ لصنفٍ متتبَّع وحدها — لمعاينة السحب التلقائي، وللتحديد اليدوي، ولمنع ما فوق الرصيد
  const decIds = [...new Set(trackedRows.filter(r => lotKind(r) === 'DECREASE').map(r => r.productId))].sort();
  const srcQ = useQuery({
    queryKey: ['lot-balances-wh', '', decIds.join(',')],
    queryFn: () => fetchWarehouseLots(decIds, ''),
    enabled: lotOn && decIds.length > 0,
  });
  const sourcesOf = (productId: string) => outSourcesOf(srcQ.data?.views.get(productId), 'SELLABLE', srcQ.data?.day ?? '');
  // «التلقائي» يُسحب بالأقرب انتهاءً أولاً **مما بقي بعد صريح أسطر صنفه** كما يحكم الخادم (pickOutFefoLines بعد withoutRows) أيّاً
  // كان عدد المصادر: [A −١٠ صريحة، تلقائي −٥] يصفّي A فيُسحب من B — والكمية بالأساس بمعامل وحدة السطر، والمعامل لقاعدة الكرتون (D22)
  const decRowsOf = (productId: string) => trackedRows.filter(x => x.productId === productId && lotKind(x) === 'DECREASE');
  const decLinesOf = (productId: string) => decRowsOf(productId).map(x => {
    const factor = choiceById(productOf(x.productId), x.unitId)?.factor ?? 1;
    return { draft: x.lot, baseQty: Number(x.qty) * factor, unitFactor: factor };
  });
  /** ما سيُسحب لهذا السطر «التلقائي» (معاينة، والخادم يحسم): سطرٌ تلقائي من أكثر من تشغيلة يُكتب بنداً لكلٍّ بعد الحفظ */
  const autoRowsOf = (r: EntryRow) => {
    const at = decRowsOf(r.productId).findIndex(x => x.rowId === r.rowId);
    return at < 0 ? null : autoDecreasePreview(sourcesOf(r.productId), decLinesOf(r.productId))[at] ?? null;
  };
  // والتلقائي فوق مجموع ما بقي يردّه الخادم LOT_STOCK_INSUFFICIENT — يُمنع هنا لا بعد الإرسال. وكذلك الصريح مجموعاً لكل مصدر
  // (D26، ROW_OVER في الجوال): [A −١٢، تلقائي −٢] و[A −٦، A −٦] مع A:10 — والمصادر لم تصل (null) لا تمنع
  const lotProblem = (r: EntryRow) => {
    if (!isTracked(r.productId)) return null;
    // كمية الصنف المتتبَّع بالأساس بأربع خانات (isLotQty في الخادم) — وإلا لا معاينة ولا حفظ
    const q = Number(r.qty);
    if (q && !isFourDecimals(Math.abs(q) * (choiceById(productOf(r.productId), r.unitId)?.factor ?? 1))) return 'LOT_QTY_INVALID' as const;
    const kind = lotKind(r);
    const at = kind === 'DECREASE' ? decRowsOf(r.productId).findIndex(x => x.rowId === r.rowId) : -1;
    return entryLotProblem(r.lot, {
      kind, expiryRequired: shelfLifeOn(productOf(r.productId)),
      autoOver: autoDecreaseOver(sourcesOf(r.productId), decLinesOf(r.productId)),
      sourceOver: at >= 0 && explicitDecreaseOver(srcQ.isSuccess ? sourcesOf(r.productId) : null, decLinesOf(r.productId))[at],
    });
  };

  const save = useMutation({
    mutationFn: () => {
      const items = rows.map(r => {
        const cost = Number(r.unitCost);
        return {
          productId: r.productId,
          qty: Number(r.qty),
          // وحدة السطر لغير الأساس وحدها — بند الأساس يُرسل كما قبل الميزة (الخادم يقرأ غيابها أساساً بمعامل ١)
          ...(r.unitId && { unitId: r.unitId }),
          // الأساس كما رآه النموذج (§2.8) — خالف أساس الصنف الآن ⇒ 400 UNIT_INVALID، وسباقٌ مع تحويل ⇒ 409
          ...(r.baseUnit && { baseUnitName: r.baseUnit }),
          // السعر للوارد وحده؛ والفارغ أو الصفر يُرسَل غائباً لا صفراً —
          // «بلا سعر» يُستبعَد من التقييم، بينما صفرٌ يُحسَب بضاعةً مجّانية
          unitCost: type === 'RECEIVE' && r.unitCost.trim() !== '' && !Number.isNaN(cost) && cost > 0 ? cost : undefined,
          // «تتبّع اللوط»: تشغيلة السطر للصنف المتتبَّع وحده — وغيره بلا حقلٍ جديد
          ...(isTracked(r.productId) && entryLotFields(normalizeEntryLot(r.lot, lotKind(r)))),
        };
      }).filter(i => !Number.isNaN(i.qty) && i.qty !== 0);
      const body = {
        type, supplier: supplier.trim() || undefined, note: note.trim() || undefined,
        costsIncludeTax: type === 'RECEIVE' ? costsIncludeTax : undefined,
        items,
      };
      // المرجع من المحتوى: الإعادة بلا تعديل ترسل المرجع نفسه، وأي تعديلٍ في النموذج مرجعٌ جديد
      attempt.current = entryAttempt(attempt.current, body);
      const payload: EntryPayload = { ...body, clientRef: attempt.current.ref };
      return warehouseApi.createEntry(payload);
    },
    onSuccess: (res) => {
      attempt.current = null;
      qc.invalidateQueries({ queryKey: ['warehouse-stock'] }); qc.invalidateQueries({ queryKey: ['warehouse-vans'] });
      qc.invalidateQueries({ queryKey: ['warehouse-entries'] });
      if (lotOn) { qc.invalidateQueries({ queryKey: ['lot-balances-wh'] }); qc.invalidateQueries({ queryKey: ['lots-of-product'] }); }
      // ردٌّ بالمرجع نفسه (200) = حركةٌ حُفظت في محاولةٍ ضاع ردّها — لا تُكتب ثانية
      toast.success(isReplayResponse(res?.data) ? tr('هذه الحركة محفوظة من قبل ولم تسجل مرة ثانية') : tr('تم حفظ الحركة'));
      // تحذيرات اللوط لا تمنع (مثل الإضافة إلى تشغيلة موقوفة) — تُقال بعد الحفظ
      for (const w of lotWarningsOf((res?.data as { warnings?: unknown } | undefined)?.warnings)) toast(tr(LOT_WARNING_LABELS[w.code]), { icon: '⚠️' });
      onClose();
    },
    onError: (e: unknown) => {
      // D3: وارد صنفٍ محذوف — يُعلَّم سطره فيُقال عليه ويُمنع الحفظ حتى يُحذف السطر أو تصير الحركة تسوية
      const arch = productArchivedOf(e);
      if (arch) setRefusedArchived(s => new Set([...s, arch.productId]));
      toast.error(lotErrorOf(e)?.message || (e as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر الحفظ'));
      // وحدات صنفٍ تغيّرت منذ فُتحت النافذة: لا يُعاد الحفظ بأساسٍ قديم — الأسطر بوحداتها الآن، والمستخدم يراجعها
      if (isStaleUnitsError(e)) void rebaseRows().catch(() => qc.invalidateQueries({ queryKey: ['products-min'] }));
    },
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
  // ومصادر النقص قيد الجلب: لا يُحكم على «التلقائي» قبل أن يُعرف أيكفيه رصيد التشغيلات
  const srcPending = decIds.length > 0 && srcQ.isLoading;
  const valid = !srcPending && rows.length > 0 && rows.every(r => {
    const q = Number(r.qty);
    return !Number.isNaN(q) && q !== 0 && (type === 'ADJUST' || q > 0) && !lotProblem(r) && !archivedReceive(r);
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
              options={(prodQ.data || []).filter(p => !rows.some(r => r.productId === p.id) || isTracked(p.id)).map(p => ({ value: p.id, label: optionLabel(p), hint: `${p.code} · ${productUnitLabel(p)}` }))}
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
                  const prim = primaryUnitOf(productOf(r.productId));
                  const tracked = isTracked(r.productId);
                  const kind = lotKind(r);
                  const stock = stockOf(r.productId);
                  return (
                    <div key={r.rowId} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-[#1F1A13] truncate">{r.name}</p>
                          {/* منتقي وحدة السطر لصنفٍ له وحدات، و«السعر لكل كرتون» تحته فلا يُكتب سعر الحبة في خانة الكرتون */}
                          {choices.length > 1 ? (
                            <select className="input w-auto py-1 text-xs mt-0.5" value={r.unitId ?? ''} aria-label={tr('الوحدة')}
                              onChange={e => setUnit(r.rowId, e.target.value || null)}>
                              {choices.map(ch => <option key={ch.id ?? 'base'} value={ch.id ?? ''}>{ch.name}{ch.factor > 1 ? ` (${ch.factor})` : ''}{prim && ch.id === prim.id ? ` · ${tr('رئيسية')}` : ''}</option>)}
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
                        <p className="text-[11px] text-[#6E6557] mt-1">{taxOff ? tr('قيمة السطر') : tr('قيمة السطر قبل الضريبة')}: <b className="text-[#1F1A13]">{formatCurrency(line)}</b></p>
                      )}
                      {/* رصيد اليوم للصنف — والتسوية تعيده صفراً بضغطة (D1) لصنفٍ في سطرٍ واحد */}
                      {stock && (
                        <p className="text-[11px] text-[#9A8F7E] mt-1 flex items-center gap-2 flex-wrap">
                          <span>{tr('الرصيد الآن')}: <b className={stock.onHand < 0 ? 'text-red-600' : 'text-[#1F1A13]'}>{qtyText('major', stock.onHand, stock, fmtQty, { withUnit: true })}</b></span>
                          {type === 'ADJUST' && !isZeroQty(stock.onHand) && rows.filter(x => x.productId === r.productId).length === 1 && (
                            <button type="button" onClick={() => zeroRow(r)} className="font-semibold text-purple-600 hover:underline">{tr('اجعل الرصيد صفرا')}</button>
                          )}
                        </p>
                      )}
                      {archivedReceive(r) && (
                        <p className="text-[11px] text-red-600 mt-1">{tr('صنف محذوف لا يستلم في المستودع استعمل التسوية لتصحيح رصيده')}</p>
                      )}
                      {/* «تتبّع اللوط»: تشغيلة السطر — الرقم وتاريخاه للوارد، وللنقص سحبٌ تلقائي بالأقرب انتهاءً أولاً (أو تحديدٌ يدوي)، ودفعةٌ ثانية بسطرٍ جديد */}
                      {tracked && (
                        <>
                          <EntryLotFields productId={r.productId} kind={kind} value={r.lot} onChange={d => patchRow(r.rowId, { lot: d })}
                            expiryRequired={shelfLifeOn(productOf(r.productId))}
                            sources={kind === 'DECREASE' ? sourcesOf(r.productId) : undefined}
                            autoRows={kind === 'DECREASE' ? autoRowsOf(r) : undefined}
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
                  {!taxOff && (
                  <label className="flex items-center gap-2 text-[11px] text-[#6E6557] cursor-pointer">
                    <input type="checkbox" checked={costsIncludeTax} onChange={e => setCostsIncludeTax(e.target.checked)} className="accent-[#E15A30]" />
                    {tr('الأسعار المدخلة شاملة الضريبة')}
                  </label>
                  )}
                  {entryTotal > 0 && (
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[#6E6557]">{taxOff ? tr('قيمة البضاعة المستلمة') : tr('قيمة البضاعة المستلمة قبل الضريبة')}</span>
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
