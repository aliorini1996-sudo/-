import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Package, ChevronLeft, Trash2, Loader2, Layers, AlertTriangle, Boxes, ArrowRightLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { productApi } from '../api/client';
import { Product, ProductUnit } from '../types';
import { formatCurrency, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { useBackClose } from '../lib/useBackClose';
import { unitPriceOf, primaryUnitOf, primaryPriceOf, derivedBasePrice } from '../lib/units';
import {
  productUnitLabel, primaryOrBiggest, reverseFormProblem, reverseCreatePayload, reverseEditPatch, reverseFormOf, reverseSubPrice,
  EMPTY_REVERSE_FORM, type ReverseForm,
} from '../lib/adminUnits';
import { defaultChoice } from '../rep/repUnits';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import {
  hasBigUnit, unitsBrief, qtyText, tierBaseBounds, tierPayload, tierPrimaryDraft, tierFromPrimary,
  unitDraftProblem, unitDraftPayload, unitDraftOf, type UnitDraft,
} from './mUnits';
import {
  fill, errorCode, productUnitsChanged, readDefMode, writeDefMode, primaryCandidates, canAddSubUnit, convertRefusalHint,
  emptySubUnitDraft, subUnitDraftProblem, subUnitPrice, subUnitDraftKey, subUnitBody, dryRunOf, dryRunItems, dryRunNeeds,
  canRunSubUnit, defaultAfterLine, tiersFitPrimary,
  type DefMode, type ConvertRefusalCode, type SubUnitDraft, type SubUnitDryRun,
} from './mPrimaryUnit';
import { lotErrorOf } from '../lib/lots';
import { productLotNote, productLotPayload, trackingBalanceOf, type TrackingBalanceProduct } from '../lib/lotTrackingUi';
import { shelfLifeOn, LOT_CACHE_KEYS } from './mLotsLogic';

/**
 * المنتجات والأسعار في تطبيق الإدارة على الجوال.
 *
 * ⚠️ **السعر المخزَّن صافٍ قبل الضريبة** — قاعدة حاكمة في المنصّة كلّها
 * (`m/docMath.ts` يبني عليها كل فاتورة). فكلّ خانة سعرٍ هنا تحتها سطرٌ صريح
 * يقوله، لأن من يكتب «١١٥» ظنّاً أنه السعر الشامل يبيع بـ١٣٢٫٢٥ ولا يدري.
 *
 * والتصفية على الخادم لا محلياً (بحث/فئة/حالة): قوائم الأصناف تُعدّ بالآلاف،
 * وتصفيةُ ما حُمِّل وحده تُخفي عن المستخدم أصنافاً موجودة فيظنّها غير مسجّلة.
 *
 * ═══ الوحدات المتعددة ═══
 * وحدة الصنف هي **وحدة الأساس** (أصغر ما يُباع منه) وسعره سعرها، والوحدات الأكبر (كرتون = ٢٤ حبة) تُدار في شاشة
 * «وحدات البيع» بعقود الخادم نفسها (productApi.addUnit/updateUnit/removeUnit). وتغيير اسم الأساس **لا يحوّل**
 * الكميات: «٢» المسجّلة كرتوناً تُقرأ «٢ حبة» إن صار الاسم حبة — فالتقسيم إلى وحدةٍ أصغر طريقُه «تحويل وحدة الأساس»
 * (convertBase) الذي يوسم التاريخ بمعامله ويقسم أسعار الأساس، بنافذة تأكيدٍ تقول ذلك صراحةً — واسمه في الواجهة
 * «إضافة وحدة فرعية أصغر» (§4.3)، بمعاينة dryRun قبل التنفيذ.
 *
 * ═══ «الوحدة الرئيسية» (القاعدة ١٢) ═══
 * صنفٌ يُعرَّف بالكرتون وفيه وحدة أصغر: القارورة تبقى `unit/basePrice` (الحساب لا ينقلب)، والكرتون وحدةٌ بمعامله و`primaryUnitId`
 * يشير إليه — للعرض («كرتون (24 قارورة)» وسعر الكرتون بارزاً) والإدخال الافتراضي وحدهما. وبلا رئيسية كل شيءٍ كما كان حرفاً (I1).
 *
 * ═══ «تتبّع باللوط» ═══
 * للشركة المفعّلة لها الميزة وحدها (`lotOn` من القوقعة): مفتاحٌ في نموذج الصنف وشارة «لوط» في القائمة. والمفتاح يُرسل
 * `lotTracked` **حين يتغيّر وحده** (productLotPayload، كنافذة اللوحة): الخادم يقفل الصنف ويفتح الحقبة متى حمل الجسم
 * انتقالاً، فحفظ الصنف لتعديلٍ آخر لا يمرّ بها. وإطفاء صنفٍ له أرصدة في تشغيلات يردّه الخادم 409 LOT_TRACKING_HAS_BALANCE
 * بتفاصيلها، فتُعرض ويُعاد الحفظ نفسه بـconfirmLotBalances بعد تأكيدٍ صريح (D9). والمطفأة: لا مفتاح ولا شارة ولا حقل.
 */

const PAGE = 30;

interface Cat { id: string; name: string }

/** رسالة الخادم لا «حدث خطأ» العمياء — سبب الرفض (كود مكرّر، صنف له حركات) يصل للمستخدم */
function apiMessage(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

/**
 * وحدات صنفٍ تغيّرت ⇒ كل قائمة أصنافٍ في التطبيق تُجلب من جديد: الفاتورة والتحميل والوارد تبني وحدة البند وسعره
 * منها، وقائمةٌ قديمة تبيع بمعاملٍ لم يعد قائماً (فيرفضها الخادم بعد أن يكتب المستخدم كل شيء).
 */
function invalidateProducts(qc: ReturnType<typeof useQueryClient>, productId?: string) {
  ['m-products', 'm-inv-products', 'm-van-products', 'm-wh-products', 'products']
    .forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  if (productId) qc.invalidateQueries({ queryKey: ['m-product', productId] });
}

export default function MProducts({ onBack, lotOn = false }: {
  onBack: () => void;
  /** «تتبّع اللوط» مفعّل للشركة (lotFlagsOf في القوقعة) — مطفأ ⇒ الشاشة كما كانت حرفاً */
  lotOn?: boolean;
}) {
  const tr = useTr();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'INACTIVE'>('');
  const [limit, setLimit] = useState(PAGE);
  // undefined = مغلق · null = صنف جديد · Product = تعديل
  const [editing, setEditing] = useState<Product | null | undefined>(undefined);
  // ⚠️ الشرط `!== undefined` لا `!!editing`: القيمة null تعني «صنف جديد» وهي مفتوحة
  useBackClose(editing !== undefined, () => setEditing(undefined));
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => { setDq(q.trim()); setLimit(PAGE); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const catsQ = useQuery({
    queryKey: ['m-product-categories'],
    queryFn: async () => expectArray<Cat>((await productApi.categories()).data?.data, tr('الفئات')),
  });

  const listQ = useQuery({
    queryKey: ['m-products', dq, cat, status, limit],
    queryFn: async () => {
      // المفتاح الفارغ يُحذف لا يُرسَل: `categoryId=` أو `status=` فارغين يصلان
      // الخادم نصّاً فارغاً لا «بلا تصفية»
      const params: Record<string, string | number> = { limit };
      if (dq) params.search = dq;
      if (cat) params.categoryId = cat;
      if (status) params.status = status;
      const body = (await productApi.list(params)).data as {
        data?: unknown; pagination?: { total?: number };
      };
      return {
        items: expectArray<Product>(body?.data, tr('الأصناف')),
        total: typeof body?.pagination?.total === 'number' ? body.pagination.total : null,
      };
    },
  });

  // تمرير قريب من القاع ⇒ صفحة أخرى (بلا زرّ «المزيد» ولا ترقيم أرقام)
  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el || listQ.isFetching) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160
        && (listQ.data?.items.length ?? 0) >= limit) setLimit(l => l + PAGE);
  }, [listQ.isFetching, listQ.data, limit]);

  if (editing !== undefined) {
    return (
      <MProductForm
        // الصنف بعد كتابةٍ فورية (رئيسيةٌ جُعلت أو أُلغيت) يُعاد فتحه بنموذجٍ جديد تُبذر خاناته منه
        key={editing ? `${editing.id}:${editing.primaryUnitId ?? ''}:${editing.unit}` : 'new'}
        product={editing}
        categories={catsQ.data ?? []}
        lotOn={lotOn}
        onClose={() => setEditing(undefined)}
        onReplace={p => setEditing(p)}
      />
    );
  }

  const filtered = !!dq || !!cat || !!status;
  const total = listQ.data?.total;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={tr('إدارة المنتجات')}
        subtitle={total != null ? `${formatNumber(total)} ${tr('صنف')}` : undefined}
        onBack={onBack}
        action={
          <button onClick={() => setEditing(null)} aria-label={tr('إضافة صنف')}
            className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0">
            <Plus size={20} />
          </button>
        } />

      <div className="flex-shrink-0 p-3 pb-2 space-y-2">
        <div className="relative">
          <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
          <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9 min-h-[44px]"
            placeholder={tr('بحث بالاسم أو الكود أو الباركود')} />
        </div>
        <div className="flex gap-2">
          <select className="input flex-1 min-h-[44px]" value={cat}
            aria-label={tr('الفئة')}
            onChange={e => { setCat(e.target.value); setLimit(PAGE); }}>
            <option value="">{tr('كل الفئات')}</option>
            {(catsQ.data ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="input w-28 min-h-[44px]" value={status}
            aria-label={tr('الحالة')}
            onChange={e => { setStatus(e.target.value as '' | 'ACTIVE' | 'INACTIVE'); setLimit(PAGE); }}>
            <option value="">{tr('الكل')}</option>
            <option value="ACTIVE">{tr('نشط')}</option>
            <option value="INACTIVE">{tr('غير نشط')}</option>
          </select>
        </div>
      </div>

      <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {listQ.isLoading ? <MSpinner />
          : listQ.isError ? <MError onRetry={() => listQ.refetch()} />
          : !listQ.data?.items.length ? <MEmpty icon={Package}
              text={filtered ? tr('لا نتائج') : tr('لا توجد أصناف')} />
          : (
            <MCard>
              {listQ.data.items.map(p => (
                <ProductRow key={p.id} p={p} lotOn={lotOn} onOpen={() => setEditing(p)} />
              ))}
            </MCard>
          )}
        {listQ.isFetching && !listQ.isLoading && (
          <p className="text-center text-[11px] text-[#9A8F7E] py-3">{tr('جاري التحميل')}</p>
        )}
      </div>
    </div>
  );
}

function ProductRow({ p, onOpen, lotOn = false }: { p: Product; onOpen: () => void; lotOn?: boolean }) {
  const tr = useTr();
  const off = p.status === 'INACTIVE';
  // شارة «لوط» للصنف المتتبَّع والميزة مفعّلة وحدها (الإطفاء يُخفي ولا يحذف، D8)
  const lot = lotOn && p.lotTracked === true;
  // وحداته الأكبر بمعاملاتها في سطره («كرتون ٢٤»)، والسعر يُسمّى بوحدته: سعرُ حبّةٍ بلا اسمها يُقرأ سعر كرتون
  const multi = hasBigUnit(p.units);
  // «الوحدة الرئيسية» (R4، R5): الوسم «كرتون (24 قارورة)»، والسعر البارز سعر الكرتون بوسمه وسعر القارورة تحته صغيراً.
  // وبلا رئيسية صالحة السطر كما كان حرفاً (I1)
  const prim = primaryUnitOf(p);
  const primPrice = prim ? primaryPriceOf(p) : null;
  return (
    <MRow
      onClick={onOpen}
      leading={p.image
        ? <img src={p.image} alt="" className="w-9 h-9 rounded-lg object-cover border border-[#F1EBDF] flex-shrink-0" />
        : (
          <span className="w-9 h-9 rounded-lg bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center flex-shrink-0">
            <Package size={16} />
          </span>
        )}
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{p.name}</span>
          {off && (
            <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#F1EBDF] text-[#6E6557]">
              {tr('معطل')}
            </span>
          )}
          {lot && (
            <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#FBEBE2] text-[#C94E28]">
              {tr('LOT')}
            </span>
          )}
        </span>
      }
      subtitle={(prim
        ? [p.code, productUnitLabel(p, formatNumber), unitsBrief((p.units ?? []).filter(u => u.id !== prim.id), formatNumber), p.category?.name]
        : [p.code, p.unit, unitsBrief(p.units, formatNumber), p.category?.name]).filter(Boolean).join(' · ')}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          {prim && primPrice != null ? (
            <span className="text-end">
              <span className="block text-xs font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(primPrice)}</span>
              <span className="block text-[9px] text-[#9A8F7E]">{prim.name} · {tr('قبل الضريبة')}</span>
              <span className="block text-[9px] text-[#9A8F7E] whitespace-nowrap">{formatCurrency(p.basePrice, undefined, 4)} / {p.unit}</span>
            </span>
          ) : (
          <span className="text-end">
            <span className="block text-xs font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(p.basePrice)}</span>
            {/* الوسم تحت كل سعر معروض — لا يُترك للقارئ أن يخمّن أهو شاملٌ أم صافٍ */}
            <span className="block text-[9px] text-[#9A8F7E]">{multi && `${p.unit} · `}{tr('قبل الضريبة')}</span>
          </span>
          )}
          <ChevronLeft size={15} className="text-[#C9BFB0]" />
        </span>
      } />
  );
}

/* ───────────────────────────── نموذج الصنف ───────────────────────────── */

type FormState = {
  name: string; code: string; barcode: string; unit: string;
  basePrice: string; taxPct: string; categoryId: string;
  status: 'ACTIVE' | 'INACTIVE';
};

const emptyForm: FormState = {
  name: '', code: '', barcode: '', unit: '',
  basePrice: '', taxPct: '', categoryId: '', status: 'ACTIVE',
};

/** تخزين المتصفّح أو null — الوصول نفسه قد يرمي (وضع خاص، بيانات محجوبة) فلا يُسقط النموذج */
function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/**
 * نموذج الصنف — طبقةٌ ملء الشاشة فوق القائمة.
 *
 * **بلا `react-hook-form` عمداً** كنموذج العملاء: نماذجها ترسل `null` للحقول
 * الفارغة. وهنا نُرسل نصّاً فارغاً صريحاً للباركود والفئة — لأن الخادم يترجمه
 * `null` (`data.barcode || null`)، وهو **الطريق الوحيد لمحو** قيمة قديمة؛
 * وحذفُ المفتاح أصلاً كان سيعني «لا تغيّرها» فيبقى الباركود المشطوب مكانه.
 *
 * ═══ «الوحدة الرئيسية» (§4.1، §4.2، §4.4) ═══
 * «طريقة تعريف الصنف»: بأصغر وحدة (النموذج القائم حرفاً) أو بالكرتون وفيه وحدة أصغر. الصنف الجديد بالكرتون يُرسَل في طلب
 * POST واحد ذرّي (reverseCreatePayload: الفرعية `unit`، والكرتون وحدةٌ بسعره الصريح، و`primaryUnitName`)، والافتراض آخر
 * طريقةٍ اختارها هذا المستخدم. والصنف القائم ذو الرئيسية تُعرض خاناته بالترتيب العكسي ويُحفظ برقعةٍ ذرّية (reverseEditPatch).
 * والانتقال بين الطريقتين لصنفٍ قائم كتابةٌ فورية لا «حفظ التعديلات»: جعل وحدةٍ موجودة رئيسية (علمٌ، D11)، أو «إضافة وحدة
 * فرعية أصغر» (convert-base، D12)، أو العودة إلى الافتراضي. وكل حفظٍ لصنفٍ قائم يرسل `expectedBaseName` (الأساس الذي فُتح
 * عليه النموذج) فيُردّ 409 إن حُوِّل الصنف منذ فُتح — لا يُكتب سعر الكرتون سعراً للقارورة.
 */
function MProductForm({ product, categories, onClose, onReplace, lotOn = false }: {
  product: Product | null; categories: Cat[]; onClose: () => void;
  /** الصنف كما صار بعد كتابةٍ فورية (جعل وحدةٍ رئيسية أو العودة) — يُعاد فتح النموذج به فتُبذر خاناته من جديد */
  onReplace: (p: Product) => void;
  /** «تتبّع اللوط» مفعّل للشركة — مطفأ ⇒ لا مفتاح ولا حقل في الحمولة */
  lotOn?: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore(x => x.user);
  const ownerSession = useAuthStore(x => !!x.impersonating);
  const [form, setForm] = useState<FormState>(() => product ? {
    name: product.name || '',
    code: product.code || '',
    barcode: product.barcode || '',
    unit: product.unit || '',
    basePrice: String(product.basePrice ?? ''),
    taxPct: product.taxPct == null ? '' : String(product.taxPct),
    categoryId: product.categoryId || product.category?.id || '',
    status: product.status || 'ACTIVE',
  } : emptyForm);
  // «الوحدة الرئيسية» كما فُتح عليها النموذج — منها تُبذر الخانات العكسية، ويُرسَل معرّفها في الرقعة (409 إن تغيّرت)
  const seedPrim = product ? primaryUnitOf(product) : null;
  // طريقة تعريف الصنف الجديد: آخر ما اختاره هذا المستخدم (لكل مستخدم، بلا أثرٍ في الخادم)، وإلّا الأولى (§4.1)
  const [defMode, setDefMode] = useState<DefMode>(() => (product ? 'base' : readDefMode(safeStorage(), user?.id)));
  const rev = product ? !!seedPrim : defMode === 'primary';
  const [rf, setRf] = useState<ReverseForm>(() => (product ? reverseFormOf(product) : null) ?? EMPTY_REVERSE_FORM);
  const [rfTouched, setRfTouched] = useState(false);
  const setR = (k: keyof ReverseForm, v: string) => { setRfTouched(true); setRf(f => ({ ...f, [k]: v })); };
  const pickMode = (m: DefMode) => { setDefMode(m); writeDefMode(safeStorage(), user?.id, m); };
  // الانتقال بين الطريقتين لصنفٍ قائم: ورقة الخيارات، وورقة «إضافة وحدة فرعية أصغر» منها
  const [switching, setSwitching] = useState(false);
  const [subUnitOpen, setSubUnitOpen] = useState(false);
  // الأساس الذي فُتح عليه النموذج — يُرسَل expectedBaseName مع كل حفظ (409 BASE_UNIT_CHANGED إن حُوِّل الصنف منذ فُتح)
  const savedBase = product?.unit ?? '';
  // الفئة المُنشأة للتوّ تُضاف محلياً: إبطالُ الكاش غير متزامن، ولولاها لظهرت
  // خانة الفئة فارغةً لحظةً بعد الإنشاء وكأن الاختيار ضاع
  const [extraCats, setExtraCats] = useState<Cat[]>([]);
  const [newCat, setNewCat] = useState<string | null>(null); // null = مغلق
  const [confirming, setConfirming] = useState(false);
  const [tiersOpen, setTiersOpen] = useState(false);
  const [unitsOpen, setUnitsOpen] = useState(false);
  // وحدات الصنف كما هي على الخادم الآن — الصنف الممرَّر لقطةٌ من القائمة لا تعرف وحدةً أُضيفت في شاشة الوحدات للتوّ
  const liveQ = useQuery({
    queryKey: ['m-product', product?.id],
    enabled: !!product,
    queryFn: async () => expectObject<Product>((await productApi.get(product!.id)).data?.data, tr('الصنف')),
  });
  const units = liveQ.data?.units ?? product?.units;
  const multi = hasBigUnit(units);
  const livePrimaryId = (liveQ.data ?? product)?.primaryUnitId ?? null;

  /* «تتبّع باللوط» — null = لم يلمسه المستخدم فيتبع الصنف كما هو على الخادم الآن (liveQ) لا لقطة القائمة: تبديلٌ من
   * اللوحة بعد تحميل القائمة يُقرأ هنا، فلا يُرسل «انتقالٌ» عن حالةٍ لم تعد قائمة. والإرسال حين يتغيّر وحده. */
  const [lotChoice, setLotChoice] = useState<boolean | null>(null);
  const lotBase = liveQ.data ?? product;
  const lotValue = lotChoice ?? (lotBase?.lotTracked === true);
  const lotNote = lotOn ? productLotNote(lotBase ?? null, lotValue) : null;
  // إطفاءٌ ردّه الخادم بأرصدة في تشغيلات (D9) — تفاصيلها للتأكيد، ثم الحفظ نفسه بـconfirmLotBalances
  const [lotBalances, setLotBalances] = useState<TrackingBalanceProduct[] | null>(null);

  // طبقات هذا النموذج — من الأعلى بصرياً إلى الأدنى (وطبقة «أسعار الكميات»
  // تسجّل نفسها داخل مكوّنها فتقع فوق الجميع)
  useBackClose(newCat !== null, () => setNewCat(null));
  useBackClose(newCat === null && confirming, () => setConfirming(false));
  useBackClose(lotBalances !== null, () => setLotBalances(null));
  useBackClose(unitsOpen, () => setUnitsOpen(false));
  useBackClose(switching, () => setSwitching(false));
  useBackClose(subUnitOpen, () => setSubUnitOpen(false));

  // الحقول النصّية وحدها — `status` له مُبدِّله الخاص أدناه كي لا يُكتب فيه نصّ حرّ
  type TextKey = 'name' | 'code' | 'barcode' | 'unit' | 'basePrice' | 'taxPct' | 'categoryId';
  const set = (k: TextKey, v: string) => setForm(f => ({ ...f, [k]: v }));

  const allCats = useMemo(() => {
    const map = new Map<string, Cat>();
    [...categories, ...extraCats].forEach(c => map.set(c.id, c));
    return [...map.values()];
  }, [categories, extraCats]);

  const price = Number(form.basePrice);
  const taxOk = form.taxPct.trim() === ''
    || (Number.isFinite(Number(form.taxPct)) && Number(form.taxPct) >= 0 && Number(form.taxPct) <= 100);
  // الوضع العكسي: الخانتان المخفيّتان (unit وbasePrice) لا تُشترطان — تحلّ محلّهما خانات الرئيسية والفرعية (reverseFormProblem)
  const revProblem = rev ? reverseFormProblem(rf) : null;
  const valid = rev
    ? !!form.name.trim() && !!form.code.trim() && taxOk && revProblem === null
    : !!form.name.trim() && !!form.code.trim() && !!form.unit.trim()
      && form.basePrice.trim() !== '' && Number.isFinite(price) && price >= 0 && taxOk;

  /** وحدات الصنف تغيّرت منذ فُتح النموذج (409 BASE_UNIT_CHANGED/PRIMARY_UNIT_CHANGED): يُقال ويُغلق، فيُفتح على الجديد */
  const unitsChangedClose = () => {
    toast.error(tr('تغيّرت وحدات الصنف — أعد فتحه'));
    invalidateProducts(qc, product?.id);
    onClose();
  };

  const save = useMutation({
    /** confirmLot: إعادة الحفظ بعد تأكيد إطفاء التتبّع والصنف له أرصدة في تشغيلات (D9) — وإلا الحفظ العادي */
    mutationFn: async (confirmLot: boolean = false) => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        code: form.code.trim(),
        unit: form.unit.trim(),
        basePrice: price,
        status: form.status,
        barcode: form.barcode.trim(),
        categoryId: form.categoryId,
      };
      // نسبةٌ فارغة تُحذف لا تُرسَل: الخادم يقرأ غيابها «ورّث ضريبة دولة الشركة»
      // عند الإنشاء و«لا تغيّرها» عند التعديل، بينما NaN يرفضه مخطّطه أصلاً
      if (form.taxPct.trim() !== '') payload.taxPct = Number(form.taxPct);
      // الحقول غير المذكورة (الصورة، سياسة التالف، أكواد الفوترة) تبقى كما هي:
      // مسار التعديل `partial()` فلا يُصفّر ما لم يصله
      // «الوحدة الرئيسية»: الفرعية والرئيسية تغلبان unit/basePrice المخفيّتين — إنشاءٌ ذرّي، أو رقعةٌ ذرّية لصنفٍ قائم
      // وصنفٌ قائم لا يُرسل أبداً حمولة الإنشاء (units وprimaryUnitName) — رئيسيته بلا معرّف ⇒ لا رقعة، فيُحفظ كما كان
      if (rev) Object.assign(payload, product ? (seedPrim?.id ? reverseEditPatch(rf, String(seedPrim.id)) : {}) : reverseCreatePayload(rf));
      // الأساس الذي فُتح عليه النموذج — صنفٌ حُوِّل منذ فُتح يُردّ 409 بدل أن يُكتب سعر الكرتون سعراً للقارورة (§4.2)
      if (product) payload.expectedBaseName = savedBase;
      // «تتبّع باللوط»: المفتاح حين يتغيّر وحده (والصنف الجديد حين يُفعَّل)، والمطفأة لا شيء — الحمولة كما كانت حرفاً
      const lot = productLotPayload(product ? (lotBase ?? null) : null, lotOn, lotValue);
      Object.assign(payload, lot);
      if (confirmLot && lot.lotTracked === false) payload.confirmLotBalances = true;
      if (product) await productApi.update(product.id, payload);
      else await productApi.create(payload);
      return 'lotTracked' in lot;
    },
    onSuccess: (lotChanged) => {
      qc.invalidateQueries({ queryKey: ['m-products'] });
      if (product) qc.invalidateQueries({ queryKey: ['m-product', product.id] });
      // تبدّل التتبّع أو الوحدات: قوائم الأصناف في الفاتورة والتحميل والوارد تقرأ علمه ووحداته، وشاشة التشغيلات
      if (lotChanged || rev) invalidateProducts(qc, product?.id);
      if (lotChanged) LOT_CACHE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      setLotBalances(null);
      toast.success(product ? tr('تم التحديث') : tr('تم الإضافة'));
      onClose();
    },
    onError: (e: unknown, confirmLot) => {
      if (productUnitsChanged(e)) { setLotBalances(null); unitsChangedClose(); return; }
      const bal = product && !confirmLot ? trackingBalanceOf(e) : null;
      if (bal) { setLotBalances(bal.products); return; }
      setLotBalances(null);
      toast.error(lotErrorOf(e)?.message || apiMessage(e, tr('تعذر الحفظ')));
    },
  });

  /** جعل وحدةٍ موجودة رئيسية (الخيار «أ») أو العودة إلى الافتراضي (null) — علمٌ فوري (D11)، والنموذج يُعاد فتحه بالنتيجة */
  const setPrimary = useMutation({
    mutationFn: async (unitId: string | null) => {
      const res = await productApi.setPrimaryUnit(product!.id, { unitId, expectedPrimaryUnitId: livePrimaryId });
      return expectObject<Product>((res.data as { data?: unknown })?.data, tr('الصنف'));
    },
    onSuccess: (fresh) => {
      invalidateProducts(qc, product?.id);
      toast.success(tr('تم الحفظ'));
      setSwitching(false);
      onReplace(fresh);
    },
    onError: (e: unknown) => {
      if (productUnitsChanged(e)) { setSwitching(false); unitsChangedClose(); return; }
      toast.error(apiMessage(e, tr('تعذر الحفظ')));
    },
  });

  const del = useMutation({
    mutationFn: async () => {
      if (!product) return false;
      const res = await productApi.remove(product.id);
      return (res.data as { archived?: boolean })?.archived === true;
    },
    onSuccess: (archived) => {
      qc.invalidateQueries({ queryKey: ['m-products'] });
      // الأرشفة تُقال صراحةً: الصنف ذو الحركات لا يُمحى، وسكوتُنا يجعل المستخدم
      // يظنّ فواتيره القديمة ضاعت معه
      toast.success(archived
        ? tr('حذف الصنف من القوائم فواتيره وكشوفه القديمة باقية كما هي')
        : tr('تم حذف الصنف'));
      setConfirming(false);
      onClose();
    },
    onError: (e: unknown) => { toast.error(apiMessage(e, tr('تعذر حذف الصنف'))); setConfirming(false); },
  });

  const addCat = useMutation({
    mutationFn: async () => {
      const res = await productApi.createCategory({ name: (newCat ?? '').trim() });
      // قراءةٌ متساهلة عمداً: الفئة أُنشئت فعلاً على الخادم، فرميُ خطأٍ على شكل
      // ردٍّ غير متوقَّع كان سيقول «تعذّر الحفظ» عن كتابةٍ نجحت
      const c = (res.data as { data?: { id?: string; name?: string } })?.data;
      return c && typeof c.id === 'string' && typeof c.name === 'string'
        ? { id: c.id, name: c.name } : null;
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['m-product-categories'] });
      if (c) { setExtraCats(list => [...list, c]); set('categoryId', c.id); }
      setNewCat(null);
      toast.success(tr('تمت إضافة الفئة'));
    },
    onError: (e: unknown) => toast.error(apiMessage(e, tr('تعذر الحفظ'))),
  });

  if (tiersOpen && product) {
    return <MProductTiers product={product} onClose={() => setTiersOpen(false)} />;
  }
  /* بعد «إضافة وحدة فرعية أصغر» يُغلق النموذج كلّه لا شاشة الوحدات وحدها: خاناته تحمل الاسم والسعر **القديمين**، وحفظُها
   * بعده يكتب سعر الكرتون سعراً للحبّة — بيعٌ بأربعة وعشرين ضعفاً بلا خطأ (والخادم يردّه الآن 409 بـexpectedBaseName) */
  if (unitsOpen && product) {
    return <MProductUnits product={product} onClose={() => setUnitsOpen(false)} onConverted={onClose} />;
  }

  // تغيير اسم الأساس لصنفٍ قائم لا يحوّل كمياته — يُقال قبل الحفظ لا بعده (والفرعية في الوضع العكسي هي الأساس)
  const shownBase = rev ? rf.subName : form.unit;
  const renamingBase = !!product && shownBase.trim() !== '' && shownBase.trim() !== (product.unit || '').trim();
  const liveProduct = liveQ.data ?? product;

  return (
    <div className="relative h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={product ? tr('تعديل صنف') : tr('إضافة صنف جديد')}
        subtitle={product?.code}
        onBack={onClose}
        action={product ? (
          <button onClick={() => setConfirming(true)} className="p-2 text-[#9A8F7E] hover:text-white"
            aria-label={tr('حذف الصنف')}>
            <Trash2 size={18} />
          </button>
        ) : undefined} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">
        {/* «طريقة تعريف الصنف» — للجديد اختيارٌ يُتذكَّر، وللقائم حالته وزرّ الانتقال (كتابةٌ فورية بخياريها) */}
        <Group title={tr('طريقة تعريف الصنف')}>
          {!product ? (
            <div className="space-y-2" role="radiogroup" aria-label={tr('طريقة تعريف الصنف')}>
              <ModeOption on={defMode === 'base'} onClick={() => pickMode('base')}
                text={tr('أعرّف الصنف بأصغر وحدة (مثل الحبة)، وأضيف الكرتون وحدةً أكبر')} />
              <ModeOption on={defMode === 'primary'} onClick={() => pickMode('primary')}
                text={tr('أعرّف الصنف بالكرتون، وفيه وحدة أصغر (مثل الحبة)')} />
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="flex-1 min-w-0 text-[12px] text-[#1F1A13] leading-relaxed">
                {rev
                  ? tr('أعرّف الصنف بالكرتون، وفيه وحدة أصغر (مثل الحبة)')
                  : tr('أعرّف الصنف بأصغر وحدة (مثل الحبة)، وأضيف الكرتون وحدةً أكبر')}
              </p>
              <button type="button" onClick={() => setSwitching(true)} disabled={!liveQ.data}
                className="px-3 min-h-[40px] rounded-xl border border-[#E9E1D3] bg-white text-[12px] font-semibold text-[#E15A30] flex-shrink-0 disabled:opacity-50">
                {tr('تغيير')}
              </button>
            </div>
          )}
        </Group>

        <Group title={tr('بيانات الصنف')}>
          <Field label={tr('اسم الصنف')} required value={form.name} onChange={v => set('name', v)} />
          <Field label={tr('كود الصنف')} required dir="ltr" value={form.code} onChange={v => set('code', v)} />
          <Field label={tr('باركود')} dir="ltr" value={form.barcode} onChange={v => set('barcode', v)} />
          {!rev && (
          <div>
            {/* نصوص لوحة الويب نفسها (ProductModal) — المعنى واحدٌ فاللفظ واحد في الواجهتين */}
            <Field label={multi ? tr('وحدة الأساس') : tr('وحدة القياس')} required value={form.unit}
              onChange={v => set('unit', v)} placeholder={tr('كرتون / قطعة / كيلو')} />
            {!product && (
              <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr('احفظ الصنف أولا ثم أضف له وحدات بيع أكبر مثل الكرتون')}</p>
            )}
            {renamingBase && <RenameHint />}
          </div>
          )}
        </Group>

        {rev && (
          <ReverseFields f={rf} set={setR} touched={rfTouched} problem={revProblem} renaming={renamingBase} />
        )}

        <Group title={rev ? tr('الضريبة') : tr('السعر والضريبة')}>
          {!rev && (
          <div>
            <label className="label">{tr('السعر الأساسي')}{multi && product ? ` (${product.unit})` : ''} *</label>
            <input className="input min-h-[44px]" type="number" dir="ltr" step="any" min="0"
              inputMode="decimal" value={form.basePrice}
              onChange={e => set('basePrice', e.target.value)} />
            {/* السطر الحاكم: من يكتب هنا رقماً شاملاً يبيع أعلى من سعره ولا يدري */}
            <p className="text-[11px] text-[#B7791F] mt-1.5 flex items-center gap-1">
              <AlertTriangle size={11} className="flex-shrink-0" />
              {tr('السعر قبل الضريبة تحسب الضريبة تلقائيا')}
            </p>
          </div>
          )}
          <div>
            <label className="label">{tr('نسبة الضريبة %')}</label>
            <input className="input min-h-[44px]" type="number" dir="ltr" step="0.01" min="0" max="100"
              inputMode="decimal" value={form.taxPct}
              onChange={e => set('taxPct', e.target.value)} />
            <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr('اتركها فارغة لتطبيق ضريبة دولة الشركة')}</p>
            {!taxOk && <p className="text-[11px] text-[#C0392B] mt-1">{tr('النسبة بين صفر ومئة')}</p>}
          </div>
        </Group>

        <Group title={tr('الفئة والحالة')}>
          <div>
            <label className="label">{tr('الفئة')}</label>
            <div className="flex gap-2">
              <select className="input flex-1 min-h-[44px]" value={form.categoryId}
                onChange={e => set('categoryId', e.target.value)}>
                <option value="">{tr('بدون فئة')}</option>
                {allCats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="button" onClick={() => setNewCat('')} aria-label={tr('فئة جديدة')}
                className="w-11 h-11 rounded-xl border border-[#E9E1D3] bg-white text-[#E15A30] flex items-center justify-center flex-shrink-0">
                <Plus size={18} />
              </button>
            </div>
          </div>
          <div>
            <label className="label">{tr('الحالة')}</label>
            <select className="input min-h-[44px]" value={form.status}
              onChange={e => setForm(f => ({ ...f, status: e.target.value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE' }))}>
              <option value="ACTIVE">{tr('نشط')}</option>
              <option value="INACTIVE">{tr('غير نشط')}</option>
            </select>
          </div>
        </Group>

        {/* «تتبّع باللوط» — للشركة المفعّلة لها الميزة وحدها، بنصوص نافذة اللوحة نفسها (المعنى واحدٌ فاللفظ واحد) */}
        {lotOn && (
          <Group title={tr('تتبع بـLOT')}>
            <label className="flex items-center gap-3 min-h-[44px] cursor-pointer">
              <input type="checkbox" checked={lotValue} onChange={e => setLotChoice(e.target.checked)}
                className="w-5 h-5 accent-[#E15A30] flex-shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[#1F1A13]">{tr('تتبع بـLOT')}</span>
                <span className="block text-[11px] text-[#9A8F7E]">{tr('رقم التشغيلة وتاريخ انتهائها في كل حركة')}</span>
              </span>
            </label>
            <p className="text-[11px] text-[#6E6557] leading-relaxed">
              {tr('يسجل الوارد بتشغيلته ويصرف المندوب الأقرب انتهاء تلقائيا ولا يباع من التشغيلات أكثر من رصيدها ولو سمح البيع بدون مخزون')}
            </p>
            {lotValue && shelfLifeOn(lotBase) && (
              <p className="text-[11px] text-[#6E6557]">{tr('تاريخ انتهاء التشغيلة إلزامي لأن صلاحية الصنف مفعلة')}</p>
            )}
            {lotNote === 'OFF' && (
              <p className="text-[11px] text-[#8A6D1F] bg-[#FDF6E7] border border-[#F0E0B8] rounded-xl px-3 py-2 leading-relaxed">
                {tr('الإطفاء يخفي تشغيلات الصنف ولا يحذفها وإن كانت له أرصدة في تشغيلات نطلب تأكيدك عند الحفظ')}
              </p>
            )}
            {lotNote === 'NEW_EPOCH' && (
              <p className="text-[11px] text-[#8A6D1F] bg-[#FDF6E7] border border-[#F0E0B8] rounded-xl px-3 py-2 leading-relaxed">
                {tr('إعادة التفعيل تبدأ حقبة جديدة للصنف أرصدته تصير غير مسماة حتى تسمى من جديد')}
              </p>
            )}
          </Group>
        )}

        {/* وحدات البيع لصنفٍ قائم فقط كالشرائح: مساراتها تحتاج معرّفاً، والجديد بلا معرّف بعد */}
        {product && (
          <MCard onClick={() => setUnitsOpen(true)}>
            <MRow
              leading={
                <span className="w-9 h-9 rounded-lg bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center flex-shrink-0">
                  <Boxes size={16} />
                </span>
              }
              title={tr('وحدات البيع')}
              subtitle={unitsBrief(units, formatNumber, livePrimaryId, tr('رئيسية')) || tr('لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها')}
              trailing={
                <span className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs font-bold text-[#1F1A13]">
                    {formatNumber(units?.length ?? 0)}
                  </span>
                  <ChevronLeft size={15} className="text-[#C9BFB0]" />
                </span>
              } />
          </MCard>
        )}

        {/* أسعار الكميات لصنفٍ قائم فقط: مسار الخادم يحتاج معرّفاً، والجديد بلا معرّف بعد */}
        {product && (
          <MCard onClick={() => setTiersOpen(true)}>
            <MRow
              leading={
                <span className="w-9 h-9 rounded-lg bg-[#FBEBE2] text-[#C94E28] flex items-center justify-center flex-shrink-0">
                  <Layers size={16} />
                </span>
              }
              title={tr('أسعار الكميات')}
              subtitle={tr('سعر خاص عند بلوغ كمية معينة')}
              trailing={
                <span className="flex items-center gap-1 flex-shrink-0">
                  <span className="text-xs font-bold text-[#1F1A13]">
                    {formatNumber(product.priceTiers?.length ?? 0)}
                  </span>
                  <ChevronLeft size={15} className="text-[#C9BFB0]" />
                </span>
              } />
          </MCard>
        )}

        <div className="h-2" />
      </div>

      {/* زرّ الحفظ ثابت أسفل — لا يُبحث عنه بالتمرير */}
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => { setRfTouched(true); save.mutate(false); }} disabled={!valid || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {product ? tr('حفظ التعديلات') : tr('إضافة الصنف')}
        </button>
      </div>

      {newCat !== null && (
        <Sheet title={tr('فئة جديدة')} onClose={() => setNewCat(null)}>
          <input className="input min-h-[44px]" autoFocus value={newCat}
            placeholder={tr('اسم الفئة')} onChange={e => setNewCat(e.target.value)} />
          <div className="flex gap-2">
            <button onClick={() => addCat.mutate()} disabled={!newCat.trim() || addCat.isPending}
              className="flex-1 bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
              {addCat.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr('حفظ')}
            </button>
            <button onClick={() => setNewCat(null)}
              className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}

      {/* D9: إطفاء تتبّع صنفٍ له أرصدة في تشغيلات — تأكيدٌ صريح بالتفاصيل، والإطفاء يُخفي ولا يحذف */}
      {lotBalances && (
        <Sheet title={tr('للصنف أرصدة في تشغيلات')} onClose={() => setLotBalances(null)}>
          <p className="text-[12px] text-[#6E6557] leading-relaxed">
            {tr('إطفاء التتبع يخفي هذه التشغيلات ولا يحذفها وإعادة التفعيل لاحقا تبدأ حقبة جديدة تصير فيها الأرصدة غير مسماة حتى تسمى')}
          </p>
          <div className="max-h-40 overflow-y-auto rounded-xl border border-[#E9E1D3] divide-y divide-[#F1EBDF] text-xs">
            {lotBalances.map(b => (
              <div key={b.productId} className="px-3 py-2">
                <p className="font-semibold text-[#1F1A13]">{b.name ?? '-'}</p>
                <p className="text-[#6E6557] tabular-nums">
                  {tr('المستودع')} {formatNumber(b.warehouse)}
                  {b.vans.length > 0 && <> · {tr('في سيارات المناديب')} {formatNumber(b.vans.reduce((s, v) => s + v.qty, 0))} ({formatNumber(b.vans.length)})</>}
                </p>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={() => save.mutate(true)} disabled={save.isPending}
              className="flex-1 bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
              {save.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr('أكد الإطفاء')}
            </button>
            <button onClick={() => setLotBalances(null)}
              className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}

      {confirming && product && newCat === null && (
        <Sheet title={tr('حذف الصنف')} onClose={() => setConfirming(false)}>
          <p className="text-[12px] text-[#6E6557] leading-relaxed">
            {tr('سيتم حذف الصنف')} «{product.name}» {tr('من كل القوائم ولن يمكن بيعه في فواتير جديدة فواتيره وسنداته وكشوفه القديمة تبقى كما هي بالاسم نفسه ولا يمكن التراجع عن الحذف')}
          </p>
          <div className="flex gap-2">
            <button onClick={() => del.mutate()} disabled={del.isPending}
              className="flex-1 bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
              {del.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr('حذف نهائي')}
            </button>
            <button onClick={() => setConfirming(false)}
              className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}

      {/* الانتقال بين طريقتي التعريف لصنفٍ قائم — كتابةٌ فورية، والنموذج يُعاد فتحه بالنتيجة */}
      {switching && liveProduct && !subUnitOpen && (
        <SwitchModeSheet product={liveProduct} toReverse={!rev} busy={setPrimary.isPending}
          canSub={canAddSubUnit(user, ownerSession)} refusal={user?.convertBaseRefusalCode ?? null}
          onClose={() => { if (!setPrimary.isPending) setSwitching(false); }}
          onSetPrimary={unitId => setPrimary.mutate(unitId)}
          onAddSub={() => { setSwitching(false); setSubUnitOpen(true); }} />
      )}

      {subUnitOpen && liveProduct && (
        <SubUnitSheet product={liveProduct}
          onClose={() => setSubUnitOpen(false)}
          onConverted={() => { setSubUnitOpen(false); onClose(); }} />
      )}
    </div>
  );
}

/** خيار «طريقة تعريف الصنف» — زرّ راديو بنصّ مثالٍ لا مصطلح (D21) */
function ModeOption({ on, onClick, text }: { on: boolean; onClick: () => void; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick}
      className={`w-full text-start rounded-xl border px-3 py-2.5 min-h-[48px] text-[12px] leading-relaxed flex items-start gap-2
        ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#1F1A13] font-semibold' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
      <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 ${on ? 'border-[#E15A30] bg-[#E15A30]' : 'border-[#C9BFB0]'}`} />
      <span className="min-w-0 flex-1">{text}</span>
    </button>
  );
}

/** تلميح خانة الوحدة لصنفٍ قائم يُعاد تسمية أصغر وحداته — نصّ المواصفة (§4.2) لكل الأصناف، و`sub` لخانة الفرعية في العكسي */
function RenameHint({ sub = false }: { sub?: boolean }) {
  const tr = useTr();
  return (
    <p className="text-[11px] text-[#B7791F] mt-1.5 flex items-start gap-1 leading-relaxed">
      <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
      {sub
        ? tr('تغيير اسم الوحدة الفرعية هنا إعادة تسمية فقط — لإضافة وحدة أصغر استخدم «إضافة وحدة فرعية أصغر»')
        : tr('تغيير الاسم هنا إعادة تسمية فقط — لإضافة وحدة أصغر استخدم «إضافة وحدة فرعية أصغر»')}
    </p>
  );
}

/**
 * خانات «أعرّف الصنف بالكرتون، وفيه وحدة أصغر» (§4.1): الرئيسية وسعرها، ثم الفرعية والعدد وسعرها الاختياري، ورمزا الوحدتين
 * الضريبيان في «متقدّم»، ومعاينةٌ حيّة بالأرقام. والتحقق reverseFormProblem (lib/adminUnits.ts) — والخادم الحَكَم.
 */
function ReverseFields({ f, set, touched, problem, renaming }: {
  f: ReverseForm; set: (k: keyof ReverseForm, v: string) => void; touched: boolean; problem: string | null; renaming: boolean;
}) {
  const tr = useTr();
  const pn = f.primaryName.trim() || tr('الوحدة الرئيسية');
  const sn = f.subName.trim() || tr('الوحدة الفرعية');
  const F = Math.round(Number(f.factor));
  const fOk = Number.isFinite(F) && F >= 2;
  const pp = Number(f.primaryPrice);
  const ppOk = f.primaryPrice.trim() !== '' && Number.isFinite(pp) && pp >= 0;
  const sub = fOk && ppOk ? reverseSubPrice(f) : null;
  const derived = fOk && ppOk ? derivedBasePrice(pp, F) : null;
  return (
    <Group title={tr('الوحدة الرئيسية')}>
      <Field label={tr('الوحدة الرئيسية')} required value={f.primaryName} onChange={v => set('primaryName', v)}
        placeholder={tr('مثال: كرتون')} />
      <div>
        <NumField label={fill(tr('سعر {unit}'), { unit: pn })} required value={f.primaryPrice} onChange={v => set('primaryPrice', v)} />
        <p className="text-[11px] text-[#B7791F] mt-1.5 flex items-center gap-1">
          <AlertTriangle size={11} className="flex-shrink-0" />
          {tr('السعر قبل الضريبة تحسب الضريبة تلقائيا')}
        </p>
      </div>
      <div>
        <Field label={tr('الوحدة الفرعية')} required value={f.subName} onChange={v => set('subName', v)} placeholder={tr('حبة')} />
        {renaming && <RenameHint sub />}
      </div>
      <div>
        <NumField label={fill(tr('كم {sub} في {primary}'), { sub: sn, primary: pn })} required integer value={f.factor}
          onChange={v => set('factor', v)} placeholder="24" />
        <p className="text-[11px] text-[#9A8F7E] mt-1.5">
          {fill(tr('مثال: {unit} = 24 {sub}'), { unit: pn, sub: sn })}
        </p>
      </div>
      <NumField label={`${fill(tr('سعر {unit} الواحدة'), { unit: sn })} (${tr('اختياري')})`} value={f.subPrice}
        onChange={v => set('subPrice', v)}
        placeholder={derived != null ? `≈ ${derived} ${tr('محسوب')}` : undefined} />
      <details className="rounded-xl border border-[#F1EBDF] px-3 py-2">
        <summary className="text-[12px] font-semibold text-[#6E6557] cursor-pointer min-h-[32px] flex items-center">{tr('متقدم')}</summary>
        <div className="space-y-3 pt-2">
          <Field label={`${tr('رمز الوحدة الضريبي')} — ${pn}`} dir="ltr" value={f.primaryUnitCode}
            onChange={v => set('primaryUnitCode', v)} placeholder="CT" />
          <Field label={`${tr('رمز الوحدة الضريبي')} — ${sn}`} dir="ltr" value={f.subUnitCode}
            onChange={v => set('subUnitCode', v)} placeholder="PCE" />
        </div>
      </details>
      {/* معاينة حيّة بالأرقام: «١ كرتون = ٢٤ قارورة · ٤٨٫٠٠ للكرتون · ٢٫٠٠ للقارورة» */}
      {fOk && ppOk && sub != null && (
        <p className="text-[12px] text-[#1F1A13] bg-[#FAF7F0] border border-[#F1EBDF] rounded-xl px-3 py-2 leading-relaxed tabular-nums">
          1 {pn} = {formatNumber(F)} {sn} · {formatCurrency(pp)} / {pn} · {formatCurrency(sub, undefined, 4)} / {sn}
        </p>
      )}
      {touched && problem && <p className="text-[11px] text-[#C0392B]">{tr(problem)}</p>}
    </Group>
  );
}

/**
 * الانتقال بين طريقتي التعريف لصنفٍ قائم (§4.2):
 *  - إلى العكسي خياران **بلا افتراض** (وحدات الصنف أكبر من أساسه دائماً، فلا يعرف النظام أكان الأساس قارورة أم كرتوناً له
 *    طبلية): (أ) لكل وحدةٍ نشطة صالحة «اجعل «طبلية» رئيسية (يبقى «كرتون» أصغر وحدة)» — علمٌ فوري، و(ب) «اجعل «كرتون»
 *    رئيسية وأضف وحدة أصغر منها» — «إضافة وحدة فرعية أصغر»، معطّلٌ بتلميح سببه لمن لا يملكها. وزرّ المتابعة معطّل حتى يختار.
 *  - إلى الافتراضي: تأكيدٌ ثم إلغاء الرئيسية (`unitId: null`).
 */
function SwitchModeSheet({ product, toReverse, busy, canSub, refusal, onClose, onSetPrimary, onAddSub }: {
  product: Product; toReverse: boolean; busy: boolean; canSub: boolean;
  refusal: ConvertRefusalCode | null;
  onClose: () => void; onSetPrimary: (unitId: string | null) => void; onAddSub: () => void;
}) {
  const tr = useTr();
  const [choice, setChoice] = useState<string | null>(null); // معرّف وحدة (أ) أو 'SUB' (ب)
  const cands = primaryCandidates(product.units);
  const base = product.unit;

  if (!toReverse) {
    const cur = primaryUnitOf(product);
    return (
      <Sheet title={tr('طريقة تعريف الصنف')} onClose={onClose}>
        <p className="text-[12px] text-[#6E6557] leading-relaxed">
          {fill(tr('يعود الصنف إلى التعريف بأصغر وحدة «{base}» ولا تبقى «{unit}» الوحدة الرئيسية — لا يتغير أي رصيد أو سعر'), { base, unit: cur?.name ?? '' })}
        </p>
        <div className="flex gap-2">
          <button onClick={() => onSetPrimary(null)} disabled={busy}
            className="flex-1 bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
            {busy && <Loader2 size={16} className="animate-spin" />}
            {tr('تأكيد')}
          </button>
          <button onClick={onClose} disabled={busy}
            className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
            {tr('إلغاء')}
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={tr('أعرّف الصنف بالكرتون، وفيه وحدة أصغر (مثل الحبة)')} onClose={onClose}>
      <div className="max-h-[58vh] overflow-y-auto overscroll-contain space-y-2 -mx-1 px-1" role="radiogroup">
        {cands.map(u => (
          <ModeOption key={u.id} on={choice === u.id} onClick={() => setChoice(u.id!)}
            text={fill(tr('اجعل «{unit}» رئيسية (يبقى «{base}» أصغر وحدة)'), { unit: u.name, base })} />
        ))}
        <div>
          <button type="button" role="radio" aria-checked={choice === 'SUB'} disabled={!canSub}
            onClick={() => setChoice('SUB')}
            className={`w-full text-start rounded-xl border px-3 py-2.5 min-h-[48px] text-[12px] leading-relaxed flex items-start gap-2 disabled:opacity-50
              ${choice === 'SUB' ? 'border-[#E15A30] bg-[#FBEBE2] text-[#1F1A13] font-semibold' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
            <span className={`mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 ${choice === 'SUB' ? 'border-[#E15A30] bg-[#E15A30]' : 'border-[#C9BFB0]'}`} />
            <span className="min-w-0 flex-1">{fill(tr('اجعل «{unit}» رئيسية وأضف وحدة أصغر منها'), { unit: base })}</span>
          </button>
          {!canSub && <p className="text-[11px] text-[#9A8F7E] mt-1 px-1">{tr(convertRefusalHint(refusal))}</p>}
        </div>
      </div>
      <div className="flex gap-2">
        <button disabled={!choice || busy}
          onClick={() => { if (choice === 'SUB') onAddSub(); else if (choice) onSetPrimary(choice); }}
          className="flex-1 bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {busy && <Loader2 size={16} className="animate-spin" />}
          {tr('متابعة')}
        </button>
        <button onClick={onClose} disabled={busy}
          className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
          {tr('إلغاء')}
        </button>
      </div>
    </Sheet>
  );
}

/* ─────────────────────── أسعار الكميات (price tiers) ─────────────────────── */

let tierUid = 0;
interface TierRow { uid: number; minQty: string; maxQty: string; price: string }

/**
 * شرائح السعر بالكمية — شاشةٌ ملء الشاشة فوق نموذج الصنف.
 *
 * الخادم يستبدل الشرائح كلّها بما يصله (حذفٌ ثم إنشاء في معاملة واحدة)، فما
 * يُعرض هنا هو الحقيقة الكاملة لا إضافةً عليها: صفٌّ حُذف من الشاشة يُحذف فعلاً.
 *
 * والحدود والسعر **بوحدة الأساس** (القاعدتان ٤ و٥): تُقرأ من عموديها بالأساس (`baseMinQty`) لا من القديمين — بعد
 * تحويل الأساس صار القديم كراتين والجديد حبّات، وقراءة القديم تُسقط الشريحة إلى ١/٢٤ من حدّها — وتُكتب في الأربعة.
 *
 * و«الوحدة الرئيسية» (§4.4): لصنفٍ له رئيسية وكل حدود شرائحه القائمة مضاعفاتٌ صحيحة لمعاملها تُدخَل الشرائح وتُعرض **بالرئيسية**
 * (tierToPrimary/tierFromPrimary) ويُرسَل `expectedPrimary` كما رآه النموذج — رئيسيةٌ تغيّر معاملها منذ فُتحت الشاشة ⇒ 409
 * PRIMARY_UNIT_CHANGED بلا كتابة. وإلّا بالفرعية بوسمها. والتخزين بالأساس دائماً، و`expectedBaseName` مع كل حفظ.
 */
function MProductTiers({ product, onClose }: { product: Product; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [rows, setRows] = useState<TierRow[] | null>(null);
  // ما بُذرت به الشاشة: الأساس، والرئيسية ومعاملها حين تُدخَل الشرائح بها (null = بالأساس) — ثابتان حتى الحفظ
  const [seed, setSeed] = useState<{ base: string; primary: { id: string; name: string; factor: number } | null } | null>(null);

  const q = useQuery({
    queryKey: ['m-product', product.id],
    queryFn: async () => expectObject<Product>((await productApi.get(product.id)).data?.data, tr('الصنف')),
  });

  // البذرة مرّة واحدة: إعادةُ الجلب بعد الحفظ يجب ألّا تدهس تحريراً جارياً
  useEffect(() => {
    const data = q.data;
    if (!data || rows !== null) return;
    const prim = primaryUnitOf(data);
    const F = prim ? Math.round(Number(prim.factor)) : 0;
    const usePrim = !!prim && tiersFitPrimary(data.priceTiers ?? [], F);
    setSeed({ base: data.unit, primary: usePrim && prim?.id ? { id: prim.id, name: prim.name, factor: F } : null });
    setRows((data.priceTiers ?? []).map(t => {
      if (usePrim) return { uid: ++tierUid, ...tierPrimaryDraft(t, F) };
      const b = tierBaseBounds(t);
      return {
        uid: ++tierUid,
        minQty: String(b.min),
        maxQty: b.max == null ? '' : String(b.max),
        price: String(t.price),
      };
    }));
  }, [q.data, rows]);

  const patch = (uid: number, k: 'minQty' | 'maxQty' | 'price', v: string) =>
    setRows(rs => (rs ?? []).map(r => (r.uid === uid ? { ...r, [k]: v } : r)));

  const invalid = (rows ?? []).some(r => {
    const min = Number(r.minQty);
    const p = Number(r.price);
    if (r.minQty.trim() === '' || !Number.isFinite(min) || min < 0) return true;
    if (r.price.trim() === '' || !Number.isFinite(p) || p < 0) return true;
    const mx = r.maxQty.trim();
    return mx !== '' && (!Number.isFinite(Number(mx)) || Number(mx) < min);
  });

  const pr = seed?.primary ?? null;
  const save = useMutation({
    mutationFn: async () => {
      // الحدود بالأساس في العمودين معاً، والحدّ الأعلى الفارغ بلا مفتاح (`maxQty` عند الخادم optional لا nullish:
      // إرسال null يُسقط الطلب كلّه) — tierPayload في mUnits.ts، وtierFromPrimary للمُدخَل بالرئيسية
      const tiers = (rows ?? []).map(r => {
        const min = Number(r.minQty);
        const max = r.maxQty.trim() === '' ? null : Number(r.maxQty);
        return pr ? tierFromPrimary(min, max, Number(r.price), pr.factor) : tierPayload(min, max, Number(r.price));
      });
      await productApi.updatePriceTiers(product.id, tiers, seed?.base || undefined, pr ? { id: pr.id, factor: pr.factor } : undefined);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['m-products'] });
      qc.invalidateQueries({ queryKey: ['m-product', product.id] });
      toast.success(tr('تم الحفظ'));
      onClose();
    },
    onError: (e: unknown) => {
      // وحدات الصنف تغيّرت منذ فُتحت الشاشة: لا تُكتب حدودٌ محسوبة على معاملٍ قديم — يُعاد جلب الصنف وبذر الحقول منه
      if (productUnitsChanged(e)) {
        toast.error(tr('تغيّرت وحدات الصنف — أعد فتحه'));
        invalidateProducts(qc, product.id);
        // البذر بعد وصول الصنف الجديد لا قبله: إعادة البذر من الكاش القديم تعيد المعامل القديم نفسه
        void q.refetch().then(() => { setRows(null); setSeed(null); });
        return;
      }
      toast.error(apiMessage(e, tr('تعذر الحفظ')));
    },
  });

  const basePrice = q.data?.basePrice ?? product.basePrice;
  // وحدات الصنف الآن (لا ما حُمِّل مع القائمة): الشريحة بالأساس، وتلميحها بالرئيسية وإلّا بأكبر وحدة («٢ كرتون» و«سعر الكرتون»)
  const cur = q.data ?? product;
  const multi = hasBigUnit(cur.units);
  const big = primaryOrBiggest(cur);
  const curPrim = primaryUnitOf(cur);
  const curPrimPrice = primaryPriceOf(cur);

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('أسعار الكميات')} subtitle={product.name} onBack={onClose}
        action={
          <button onClick={() => setRows(rs => [...(rs ?? []), { uid: ++tierUid, minQty: '', maxQty: '', price: '' }])}
            disabled={rows === null} aria-label={tr('إضافة شريحة')}
            className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0 disabled:bg-[#8A7F6E]">
            <Plus size={20} />
          </button>
        } />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {/* الخطأ أوّلاً: `rows` تبقى null عند الإخفاق، فترتيبٌ معكوس كان سيترك
            الشاشة على المُدوِّرة أبداً بلا زرّ إعادة محاولة */}
        {q.isError ? <MError onRetry={() => q.refetch()} />
          : q.isLoading || rows === null ? <MSpinner />
          : (
            <>
              <MCard className="p-3.5">
                {curPrim && curPrimPrice != null ? (
                  <>
                    <p className="text-[11px] text-[#9A8F7E] mb-1">{fill(tr('سعر {unit}'), { unit: curPrim.name })}</p>
                    <p className="text-lg font-bold text-[#1F1A13]">{formatCurrency(curPrimPrice)}</p>
                    <p className="text-[11px] text-[#9A8F7E]">{fill(tr('سعر {unit} الواحدة'), { unit: cur.unit })} {formatCurrency(basePrice, undefined, 4)}</p>
                  </>
                ) : (
                  <>
                    <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('السعر الأساسي')}{multi ? ` (${cur.unit})` : ''}</p>
                    <p className="text-lg font-bold text-[#1F1A13]">{formatCurrency(basePrice)}</p>
                  </>
                )}
                <p className="text-[11px] text-[#B7791F] mt-1.5 flex items-center gap-1">
                  <AlertTriangle size={11} className="flex-shrink-0" />
                  {tr('السعر قبل الضريبة تحسب الضريبة تلقائيا')}
                </p>
              </MCard>

              {rows.length === 0 ? (
                <div className="min-h-[180px]">
                  <MEmpty icon={Layers} text={tr('لا توجد شرائح أسعار')} />
                </div>
              ) : (
                <MCard>
                  {rows.map((r, i) => {
                    const min = Number(r.minQty);
                    const prc = Number(r.price);
                    return (
                    <div key={r.uid} className="p-3 space-y-2 border-b border-[#F1EBDF] last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 text-[11px] font-bold text-[#9A8F7E]">
                          {tr('شريحة')} {formatNumber(i + 1)}
                        </span>
                        <button onClick={() => setRows(rs => (rs ?? []).filter(x => x.uid !== r.uid))}
                          aria-label={tr('حذف')}
                          className="w-10 h-10 -m-1 flex items-center justify-center text-[#C0392B]">
                          <Trash2 size={15} />
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <TierField label={tr('من كمية')} value={r.minQty} onChange={v => patch(r.uid, 'minQty', v)} />
                        <TierField label={tr('إلى كمية')} value={r.maxQty} placeholder={tr('بلا حد')}
                          onChange={v => patch(r.uid, 'maxQty', v)} />
                        <TierField label={tr('السعر')} value={r.price} onChange={v => patch(r.uid, 'price', v)} />
                      </div>
                      {/* بالرئيسية: معادلها بالفرعية («= ٤٨ قارورة · ٢٫٠٠ / قارورة») — التخزين بها */}
                      {pr && r.minQty.trim() !== '' && Number.isFinite(min) && (
                        <p className="text-[10px] text-[#9A8F7E]">
                          = {formatNumber(min * pr.factor)} {cur.unit}
                          {r.price.trim() !== '' && Number.isFinite(prc) && ` · ${formatCurrency(prc / pr.factor, undefined, 4)} / ${cur.unit}`}
                        </p>
                      )}
                      {/* الشريحة بالأساس مقروءةً بالوحدات: «من ٤٨» تُقرأ «من ٢ كرتون»، وسعر الحبّة يُرى سعرَ كرتون */}
                      {!pr && multi && big && r.minQty.trim() !== '' && Number.isFinite(min) && (
                        <p className="text-[10px] text-[#9A8F7E]">
                          {tr('من')} {qtyText(min, cur, formatNumber)}
                          {r.price.trim() !== '' && Number.isFinite(prc) && ` · ${formatCurrency(prc * Number(big.factor))} / ${big.name}`}
                        </p>
                      )}
                    </div>
                    );
                  })}
                </MCard>
              )}

              {invalid && (
                <p className="text-[11px] text-[#C0392B] px-1">{tr('راجع الكميات والأسعار')}</p>
              )}
              <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
                {tr('سعر الشريحة يطبق عند بلوغ الكمية وهو أيضا قبل الضريبة')}
              </p>
              {/* وسم وحدة الإدخال: بالرئيسية، أو بالفرعية باسمها لصنفٍ له رئيسية (D21)، أو «بوحدة الأساس» كما كان */}
              {pr ? (
                <p className="text-[11px] text-[#B7791F] px-1 leading-relaxed">
                  {fill(tr('الحدود والأسعار بـ{unit}'), { unit: pr.name })}
                </p>
              ) : curPrim ? (
                <p className="text-[11px] text-[#B7791F] px-1 leading-relaxed">
                  {fill(tr('الحدود والأسعار بـ{unit}'), { unit: cur.unit })}
                </p>
              ) : multi && (
                <p className="text-[11px] text-[#B7791F] px-1 leading-relaxed">
                  {tr('حدود الشرائح وأسعارها بوحدة الأساس')} ({cur.unit})
                </p>
              )}
              <div className="h-2" />
            </>
          )}
      </div>

      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        <button onClick={() => save.mutate()} disabled={rows === null || invalid || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {tr('حفظ')}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────── وحدات البيع (الوحدات المتعددة) ─────────────────────── */

/**
 * وحدات البيع الأكبر من وحدة الأساس — شاشةٌ ملء الشاشة فوق نموذج الصنف، كشاشة الشرائح.
 *
 * كل كتابةٍ هنا طلبٌ مستقلّ بعقود الخادم (addUnit/updateUnit/removeUnit)، والوحدات تُقرأ بعدها من الخادم لا من ذاكرة
 * الشاشة: الخادم يقفل صفّ الصنف ويرفض الاسم المكرر والمعامل المكرر، فما يُعرض هو ما قُبل لا ما كُتب.
 *
 * والمعامل يغيّر المستقبل وحده: كل مستندٍ يحمل لقطة معامل وحدته يوم صدوره، فكرتونٌ صار ١٢ لا يُنقص مخزون شهرٍ مضى.
 * والحذف فعليّ للسبب نفسه — والإيقاف بديلٌ يُعرض بجانبه: يحجب الوحدة عن البيع ويُبقيها لمستندٍ أوف‑لاين صدر بها.
 *
 * و«الوحدة الرئيسية» (§4.4): بطاقتا «الوحدة الرئيسية» ثم «الوحدة الفرعية» لصنفٍ له رئيسية (وبلاها بطاقة الأساس كما كانت)،
 * وشارة «رئيسية» على وحدتها، و«اجعلها الرئيسية» في ورقة كل وحدةٍ نشطة غيرها، وإيقاف الرئيسية أو حذفها بتأكيدٍ صريح ثم
 * `clearPrimary` (وإلّا 409 PRIMARY_UNIT_IN_USE). وكل كتابةٍ ترسل `expectedBaseName` من الصنف الحيّ.
 */
function MProductUnits({ product, onClose, onConverted }: {
  product: Product; onClose: () => void;
  /** «إضافة وحدة فرعية أصغر» تمّت — يُغلق نموذج الصنف كلّه (خاناته بالأساس القديم) */
  onConverted: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  // «إضافة وحدة فرعية أصغر»: canConvertBase من ردّ الدخول، أو جلسة المالك — والخادم يفرض البوابتين (§3)
  const user = useAuthStore(x => x.user);
  const ownerSession = useAuthStore(x => !!x.impersonating);
  const canSub = canAddSubUnit(user, ownerSession);
  // undefined = مغلق · null = وحدة جديدة · ProductUnit = تعديل
  const [editing, setEditing] = useState<ProductUnit | null | undefined>(undefined);
  const [removing, setRemoving] = useState<ProductUnit | null>(null);
  // إيقاف الوحدة الرئيسية — تأكيدٌ صريح قبل clearPrimary (D13)
  const [stopping, setStopping] = useState<ProductUnit | null>(null);
  const [converting, setConverting] = useState(false);
  useBackClose(editing !== undefined, () => setEditing(undefined));
  useBackClose(!!removing, () => setRemoving(null));
  useBackClose(!!stopping, () => setStopping(null));
  useBackClose(converting, () => setConverting(false));

  const q = useQuery({
    queryKey: ['m-product', product.id],
    queryFn: async () => expectObject<Product>((await productApi.get(product.id)).data?.data, tr('الصنف')),
  });
  // الصنف كما هو على الخادم الآن — الأساس الذي يُرسَل expectedBaseName منه، لا من قائمةٍ حُمِّلت قبل دقائق
  const p = q.data ?? product;
  const units = p.units ?? [];
  const prim = primaryUnitOf(p);
  const primPrice = primaryPriceOf(p);

  /** وحدات الصنف تغيّرت منذ فُتحت الشاشة: يُقال ويُعاد جلب الصنف — لا كتابة على أساسٍ قديم */
  const onWriteError = (e: unknown) => {
    if (productUnitsChanged(e)) {
      toast.error(tr('تغيّرت وحدات الصنف — أعد فتحه'));
      invalidateProducts(qc, product.id);
      return;
    }
    toast.error(apiMessage(e, tr('تعذر الحفظ')));
  };
  const done = () => { setEditing(undefined); setRemoving(null); setStopping(null); };

  const toggle = useMutation({
    mutationFn: async (u: ProductUnit) => productApi.updateUnit(product.id, u.id, {
      isActive: u.isActive === false, expectedBaseName: p.unit,
      // إيقاف الرئيسية بعد تأكيدها وحده (stopping) — وإلّا يردّه الخادم 409 PRIMARY_UNIT_IN_USE
      ...(u.isActive !== false && u.id === p.primaryUnitId && { clearPrimary: true }),
    }),
    onSuccess: (_r, u) => {
      invalidateProducts(qc, product.id);
      toast.success(u.isActive === false ? tr('فعلت الوحدة') : tr('أوقفت الوحدة'));
      done();
    },
    onError: (e: unknown) => { onWriteError(e); setStopping(null); },
  });
  const remove = useMutation({
    mutationFn: async (u: ProductUnit) =>
      productApi.removeUnit(product.id, u.id, { ...(u.id === p.primaryUnitId && { clearPrimary: true }), expectedBaseName: p.unit }),
    onSuccess: () => {
      invalidateProducts(qc, product.id);
      toast.success(tr('حذفت الوحدة'));
      done();
    },
    onError: (e: unknown) => { onWriteError(e); setRemoving(null); },
  });
  const makePrimary = useMutation({
    mutationFn: async (u: ProductUnit) =>
      productApi.setPrimaryUnit(product.id, { unitId: u.id, expectedPrimaryUnitId: p.primaryUnitId ?? null }),
    onSuccess: () => {
      invalidateProducts(qc, product.id);
      toast.success(tr('تم الحفظ'));
      done();
    },
    onError: onWriteError,
  });
  /** الإيقاف من الورقة أو من نافذة الحذف: الرئيسية النشطة تمرّ بتأكيدها أوّلاً */
  const requestToggle = (u: ProductUnit) => {
    if (u.isActive !== false && u.id === p.primaryUnitId) { setRemoving(null); setStopping(u); return; }
    toggle.mutate(u);
  };

  return (
    <div className="relative h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('وحدات البيع')} subtitle={product.name} onBack={onClose}
        action={
          <button onClick={() => setEditing(null)} disabled={!q.data} aria-label={tr('إضافة وحدة')}
            className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0 disabled:bg-[#8A7F6E]">
            <Plus size={20} />
          </button>
        } />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {/* الخطأ أوّلاً كشاشة الشرائح: بلا الصنف الحيّ لا تُفتح كتابةٌ على أساسٍ قد يكون تغيّر */}
        {q.isError ? <MError onRetry={() => q.refetch()} />
          : q.isLoading ? <MSpinner />
          : (
            <>
              {prim ? (
                <>
                  {/* «الوحدة الرئيسية» ثم «الوحدة الفرعية» (§4.4) — بلا كلمة «الأساس» (D21) */}
                  <MCard className="p-3.5">
                    <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('الوحدة الرئيسية')}</p>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-lg font-bold text-[#1F1A13] truncate">
                        {prim.name} <span className="text-[12px] font-normal text-[#6E6557]">= {formatNumber(prim.factor)} {p.unit}</span>
                      </p>
                      <span className="text-end flex-shrink-0">
                        <span className="block text-sm font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(primPrice ?? 0)}</span>
                        <span className="block text-[9px] text-[#9A8F7E]">{tr('قبل الضريبة')}</span>
                      </span>
                    </div>
                  </MCard>
                  <MCard className="p-3.5">
                    <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('الوحدة الفرعية')}</p>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-lg font-bold text-[#1F1A13] truncate">{p.unit}</p>
                      <span className="text-end flex-shrink-0">
                        <span className="block text-sm font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(p.basePrice, undefined, 4)}</span>
                        <span className="block text-[9px] text-[#9A8F7E]">{tr('قبل الضريبة')}</span>
                      </span>
                    </div>
                    <p className="text-[11px] text-[#9A8F7E] mt-1.5 leading-relaxed">
                      {fill(tr('الحساب الداخلي بوحدة {unit}'), { unit: p.unit })}
                    </p>
                  </MCard>
                </>
              ) : (
              <MCard className="p-3.5">
                <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('وحدة الأساس')}</p>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-lg font-bold text-[#1F1A13] truncate">{p.unit}</p>
                  <span className="text-end flex-shrink-0">
                    <span className="block text-sm font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(p.basePrice)}</span>
                    <span className="block text-[9px] text-[#9A8F7E]">{tr('قبل الضريبة')}</span>
                  </span>
                </div>
                <p className="text-[11px] text-[#9A8F7E] mt-1.5 leading-relaxed">
                  {tr('أصغر ما يباع من الصنف وكل وحدة أكبر تعرف بعدد وحدات الأساس فيها')}
                </p>
              </MCard>
              )}

              {units.length === 0 ? (
                <div className="min-h-[160px]">
                  <MEmpty icon={Boxes} text={tr('لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها')} />
                </div>
              ) : (
                <MCard>
                  {units.map(u => {
                    const off = u.isActive === false;
                    const isPrim = !!prim && u.id === prim.id;
                    return (
                      <MRow key={u.id} onClick={() => setEditing(u)}
                        title={
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{u.name}</span>
                            {isPrim && (
                              <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#FBEBE2] text-[#C94E28]">
                                {tr('رئيسية')}
                              </span>
                            )}
                            {off && (
                              <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#F1EBDF] text-[#6E6557]">
                                {tr('موقوفة')}
                              </span>
                            )}
                          </span>
                        }
                        // المعامل بوحدة الأساس صراحةً: «كرتون» وحده لا يقول كم حبّةً فيه
                        subtitle={[`= ${formatNumber(u.factor)} ${p.unit}`, u.unitCode].filter(Boolean).join(' · ')}
                        trailing={
                          <span className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-end">
                              <span className="block text-xs font-bold text-[#1F1A13] whitespace-nowrap">
                                {/* `?? undefined` لا null: Number(null) = 0 «سعرٌ صالح» في unitPriceOf فيظهر الكرتون مجّاناً */}
                                {formatCurrency(unitPriceOf({ ...u, price: u.price ?? undefined }, p.basePrice))}
                              </span>
                              <span className="block text-[9px] text-[#9A8F7E]">
                                {u.price == null
                                  ? (prim ? fill(tr('محسوب من سعر {unit}'), { unit: p.unit }) : tr('محسوب من سعر الأساس'))
                                  : tr('قبل الضريبة')}
                              </span>
                            </span>
                            <ChevronLeft size={15} className="text-[#C9BFB0]" />
                          </span>
                        } />
                    );
                  })}
                </MCard>
              )}
              {/* كل كتابةٍ هنا تلتزم فوراً — لا تنتظر «حفظ التعديلات» في نموذج الصنف خلفها */}
              <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
                {tr('تحفظ الوحدات فور إضافتها أو تعديلها')}
              </p>

              {/* «إضافة وحدة فرعية أصغر» (convert-base) — لمن يملكها وحده؛ والخادم يحكم في كل طلب */}
              {canSub && (
              <MCard onClick={() => setConverting(true)}>
                <MRow
                  leading={
                    <span className="w-9 h-9 rounded-lg bg-[#FDF6E7] text-[#B7791F] flex items-center justify-center flex-shrink-0">
                      <ArrowRightLeft size={16} />
                    </span>
                  }
                  title={tr('إضافة وحدة فرعية أصغر')}
                  subtitle={tr('لصنف يباع بالكرتون ويرجع أو يباع بالحبة')}
                  trailing={<ChevronLeft size={15} className="text-[#C9BFB0] flex-shrink-0" />} />
              </MCard>
              )}
              <div className="h-2" />
            </>
          )}
      </div>

      {editing !== undefined && q.data && (
        <UnitSheet product={p} unit={editing}
          onClose={() => setEditing(undefined)}
          onSaved={msg => { invalidateProducts(qc, product.id); toast.success(msg); setEditing(undefined); }}
          onUnitsChanged={() => { toast.error(tr('تغيّرت وحدات الصنف — أعد فتحه')); invalidateProducts(qc, product.id); setEditing(undefined); }}
          onToggle={requestToggle} toggling={toggle.isPending}
          onMakePrimary={u => makePrimary.mutate(u)} makingPrimary={makePrimary.isPending}
          onRemove={u => setRemoving(u)} />
      )}

      {removing && (
        <Sheet title={tr('حذف الوحدة')} onClose={() => { if (!remove.isPending) setRemoving(null); }}>
          {removing.id === p.primaryUnitId && (
            <p className="text-[12px] font-semibold text-[#B7791F] leading-relaxed">{tr('هذه الوحدة الرئيسية — سيُلغى كونها رئيسية ثم تُحذف')}</p>
          )}
          <p className="text-[12px] text-[#6E6557] leading-relaxed">
            «{removing.name}» — {tr('حذف الوحدة نهائيا؟ الفواتير والحركات السابقة بها تبقى كما هي وللإيقاف المؤقت استخدم إيقاف')}
          </p>
          <div className="flex gap-2">
            <button onClick={() => remove.mutate(removing)} disabled={remove.isPending || toggle.isPending}
              className="flex-1 bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
              {remove.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr('حذف نهائي')}
            </button>
            {/* الإيقاف بجانب الحذف: يحجبها عن البيع ويُبقيها لمستندٍ أوف‑لاين صدر بها — وهو غالباً المقصود */}
            {removing.isActive !== false && (
              <button onClick={() => requestToggle(removing)} disabled={remove.isPending || toggle.isPending}
                className="px-4 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13] flex items-center justify-center gap-2">
                {toggle.isPending && <Loader2 size={14} className="animate-spin" />}
                {tr('إيقاف')}
              </button>
            )}
            <button onClick={() => setRemoving(null)} disabled={remove.isPending || toggle.isPending}
              className="px-4 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}

      {/* D13: إيقاف الوحدة الرئيسية — لا إلغاءٌ صامت يقلب افتراض المندوب من كرتونٍ إلى قارورة */}
      {stopping && (
        <Sheet title={tr('إيقاف')} onClose={() => { if (!toggle.isPending) setStopping(null); }}>
          <p className="text-[12px] text-[#6E6557] leading-relaxed">
            «{stopping.name}» — {tr('هذه الوحدة الرئيسية — سيُلغى كونها رئيسية ثم تُوقَف')}
          </p>
          <div className="flex gap-2">
            <button onClick={() => toggle.mutate(stopping)} disabled={toggle.isPending}
              className="flex-1 bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
              {toggle.isPending && <Loader2 size={16} className="animate-spin" />}
              {tr('إيقاف')}
            </button>
            <button onClick={() => setStopping(null)} disabled={toggle.isPending}
              className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
              {tr('إلغاء')}
            </button>
          </div>
        </Sheet>
      )}

      {converting && q.data && (
        <SubUnitSheet product={p}
          onClose={() => setConverting(false)}
          onConverted={() => { setConverting(false); onConverted(); }} />
      )}
    </div>
  );
}

/** نموذج الوحدة — ورقةٌ سفلية: إضافةٌ أو تعديل، ومعها الإيقاف والحذف و«اجعلها الرئيسية» للوحدة القائمة */
function UnitSheet({ product, unit, onClose, onSaved, onUnitsChanged, onToggle, toggling, onMakePrimary, makingPrimary, onRemove }: {
  product: Product;
  /** null = وحدة جديدة */
  unit: ProductUnit | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  /** 409 BASE_UNIT_CHANGED/PRIMARY_UNIT_CHANGED — الشاشة تعيد جلب الصنف */
  onUnitsChanged: () => void;
  onToggle: (u: ProductUnit) => void;
  toggling: boolean;
  onMakePrimary: (u: ProductUnit) => void;
  makingPrimary: boolean;
  onRemove: (u: ProductUnit) => void;
}) {
  const tr = useTr();
  const [d, setD] = useState<UnitDraft>(() => unitDraftOf(unit));
  // «وحدة رئيسية» للمضافة (makePrimary) — في المعاملة نفسها على الخادم
  const [asPrimary, setAsPrimary] = useState(false);
  // الرسالة بعد أوّل كتابة لا قبلها: نموذجٌ فارغ يفتح بخطأٍ أحمر يُقرأ عطلاً
  const [touched, setTouched] = useState(false);
  const set = (k: keyof UnitDraft, v: string) => { setTouched(true); setD(x => ({ ...x, [k]: v })); };

  // الحارس نفسه الذي يرفض به الخادم (unitProblem) — والأساس بين «الأخريات» بمعامل ١ كما في الخادم
  const others = (product.units ?? []).filter(u => u.id !== unit?.id);
  const problem = unitDraftProblem(d, product.unit, others);
  const f = Math.round(Number(d.factor));
  const derived = Number.isFinite(f) && f > 1 ? unitPriceOf({ name: d.name, factor: f }, product.basePrice) : null;
  const factorChanged = !!unit && d.factor.trim() !== '' && Number(d.factor) !== Number(unit.factor);
  // لصنفٍ له رئيسية: نصوص الوحدة الصغرى باسمها لا «الأساس» (D21) — وبلاها النصوص كما كانت حرفاً (I1)
  const hasPrim = !!primaryUnitOf(product);
  // «اجعلها الرئيسية»: لوحدةٍ قائمة نشطة بمعاملٍ صالح ليست الرئيسية الآن (شروط primaryUnitOf)
  const canBePrimary = !!unit && unit.id !== product.primaryUnitId && primaryCandidates([unit]).length === 1;

  const save = useMutation({
    mutationFn: async () => {
      const body = unitDraftPayload(d);
      if (unit) await productApi.updateUnit(product.id, unit.id, { ...body, expectedBaseName: product.unit });
      else await productApi.addUnit(product.id, { ...body, expectedBaseName: product.unit, ...(asPrimary && { makePrimary: true }) });
    },
    onSuccess: () => onSaved(unit ? tr('حفظت الوحدة') : tr('أضيفت الوحدة')),
    onError: (e: unknown) => {
      if (productUnitsChanged(e)) { onUnitsChanged(); return; }
      toast.error(apiMessage(e, tr('تعذر الحفظ')));
    },
  });
  const busy = save.isPending || toggling || makingPrimary;

  return (
    <Sheet title={unit ? `${tr('تعديل')} «${unit.name}»` : tr('إضافة وحدة')} onClose={() => { if (!busy) onClose(); }}>
      {/* نصوص لوحة الويب نفسها (ProductModal) — المعنى واحدٌ فاللفظ واحد في الواجهتين */}
      <div className="max-h-[58vh] overflow-y-auto overscroll-contain space-y-3 -mx-1 px-1">
        <Field label={tr('اسم الوحدة')} required value={d.name} onChange={v => set('name', v)} />
        <NumField label={hasPrim ? fill(tr('كم {unit} فيها'), { unit: product.unit }) : `${tr('عدد وحدات الأساس فيها')} (${product.unit})`} required integer
          value={d.factor} onChange={v => set('factor', v)} placeholder="24" />
        {factorChanged && (
          <p className="text-[11px] text-[#B7791F] flex items-start gap-1 leading-relaxed">
            <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
            {tr('تغيير المعامل لا يغير الفواتير والحركات السابقة فكل حركة تحفظ معامل وحدتها لحظتها')}
          </p>
        )}
        <div>
          <NumField label={tr('السعر اختياري')} value={d.price} onChange={v => set('price', v)}
            placeholder={derived != null ? String(derived) : undefined} />
          <p className="text-[11px] text-[#9A8F7E] mt-1.5">
            {hasPrim ? fill(tr('فارغ يعني سعر {unit} مضروبا في المعامل'), { unit: product.unit }) : tr('فارغ يعني سعر الأساس مضروبا في المعامل')}
            {derived != null && ` = ${formatCurrency(derived)}`}
          </p>
          {/* السطر الحاكم كخانة سعر الصنف: رقمٌ شاملٌ مكتوبٌ هنا يبيع الكرتون أعلى من سعره */}
          <p className="text-[11px] text-[#B7791F] mt-1 flex items-center gap-1">
            <AlertTriangle size={11} className="flex-shrink-0" />
            {tr('السعر قبل الضريبة تحسب الضريبة تلقائيا')}
          </p>
        </div>
        <Field label={tr('رمز الوحدة الضريبي')} dir="ltr" value={d.unitCode}
          onChange={v => set('unitCode', v)} placeholder="CT" />
        {!unit && (
          <label className="flex items-center gap-2.5 min-h-[44px] cursor-pointer">
            <input type="checkbox" checked={asPrimary} onChange={e => setAsPrimary(e.target.checked)}
              className="w-5 h-5 accent-[#E15A30] flex-shrink-0" />
            <span className="text-sm font-semibold text-[#1F1A13]">{tr('وحدة رئيسية')}</span>
          </label>
        )}
        {/* رسالة الحارس مفتاحٌ في القاموس كما يكتبها الخادم — والخادم يبقى الحَكَم */}
        {touched && problem && <p className="text-[11px] text-[#C0392B]">{tr(problem)}</p>}
      </div>

      <div className="flex gap-2">
        <button onClick={() => save.mutate()} disabled={!!problem || busy}
          className="flex-1 bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending && <Loader2 size={16} className="animate-spin" />}
          {tr('حفظ')}
        </button>
        <button onClick={onClose} disabled={busy}
          className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
          {tr('إلغاء')}
        </button>
      </div>
      {unit && canBePrimary && (
        <button onClick={() => onMakePrimary(unit)} disabled={busy}
          className="w-full border border-[#E15A30] bg-[#FBEBE2] rounded-xl min-h-[44px] text-[13px] font-semibold text-[#C94E28] flex items-center justify-center gap-2 disabled:opacity-60">
          {makingPrimary && <Loader2 size={14} className="animate-spin" />}
          {tr('اجعلها الرئيسية')}
        </button>
      )}
      {unit && (
        <div className="flex gap-2">
          <button onClick={() => onToggle(unit)} disabled={busy}
            className="flex-1 border border-[#E9E1D3] bg-white rounded-xl min-h-[44px] text-[13px] font-semibold text-[#6E6557] flex items-center justify-center gap-2 disabled:opacity-60">
            {toggling && <Loader2 size={14} className="animate-spin" />}
            {unit.isActive === false ? tr('تفعيل') : tr('إيقاف')}
          </button>
          <button onClick={() => onRemove(unit)} disabled={busy}
            className="flex-1 border border-[#E9C3BC] bg-white rounded-xl min-h-[44px] text-[13px] font-semibold text-[#C0392B] disabled:opacity-60">
            {tr('حذف')}
          </button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * «إضافة وحدة فرعية أصغر» (convert-base، §4.3) — كرتونٌ قائم له تاريخ تُضاف إليه القارورة: «الكرتون = 24 قارورة».
 *
 * لا تراجع عنها، وتمسّ تاريخ الصنف كلّه في معاملةٍ واحدة على الخادم: الوحدة الحالية تصير وحدةً بمعاملها **بسعرها**، وتُوسم
 * صفوفها القديمة بمعاملها فلا يتغيّر رقمٌ مطبوع، وتُقسم أسعار العملاء والشرائح على العدد. و«تبقى الحالية رئيسية» مفعّلٌ
 * افتراضاً (D12) فلا يتغيّر عرض الصنف ولا افتراض المندوب.
 *
 * **المعاينة قبل التنفيذ:** `dryRun` بتأخير ٤٠٠ms بعد آخر تعديل حين تصحّ الخانتان (لا عند الفتح)، وزرّ التنفيذ معطّل حتى
 * تنجح معاينةٌ **بالقيم الحالية نفسها** (subUnitDraftKey) ويُؤشَّر ما تطلبه من إقرار (ERP ومفاتيح API). و`expectedBaseName`
 * من الصنف الحيّ: نقرةٌ ثانية أو مديرٌ آخر سبق ⇒ 409 BASE_UNIT_CHANGED فلا يُضرب التاريخ بالعدد مرّتين.
 */
function SubUnitSheet({ product, onClose, onConverted }: {
  product: Product; onClose: () => void; onConverted: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [d, setD] = useState<SubUnitDraft>(emptySubUnitDraft);
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState<{ key: string; r: SubUnitDryRun } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  // 409 BASE_NAME_RETIRED تحت خانة الاسم — اسمٌ كان وحدة هذا الصنف قبل تحويلٍ سابق
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [ackErp, setAckErp] = useState(false);
  const [ackApi, setAckApi] = useState(false);
  const set = (k: 'newBaseName' | 'factor' | 'basePrice', v: string) => { setTouched(true); setNameErr(null); setD(x => ({ ...x, [k]: v })); };

  const problem = subUnitDraftProblem(d, product);
  const key = subUnitDraftKey(d);
  const F = Math.round(Number(d.factor));
  const newName = d.newBaseName.trim();
  const shownNew = newName || tr('الوحدة الفرعية');
  const cur = product.unit;
  const subPrice = F >= 2 ? subUnitPrice(d, product.basePrice) : null;

  /** رسالة رفض الخادم وما يُفعل بها: الأساس تغيّر ⇒ إغلاقٌ وإعادة جلب، والاسم المتقاعد تحت خانته، وغيره رسالته */
  const onServerError = (e: unknown): string | null => {
    const code = errorCode(e);
    if (code === 'BASE_UNIT_CHANGED') {
      toast.error(tr('تغيّرت وحدات الصنف — أعد فتحه'));
      invalidateProducts(qc, product.id);
      onClose();
      return null;
    }
    const msg = apiMessage(e, tr('تعذر الحفظ'));
    if (code === 'BASE_NAME_RETIRED') { setNameErr(msg); return null; }
    return msg;
  };

  // المعاينة: حين تصحّ الخانتان، بعد ٤٠٠ms من آخر تعديل — وكل تعديلٍ يُبطل ما قبله (البصمة)
  useEffect(() => {
    if (problem) { setPreviewing(false); return; }
    let live = true;
    const t = setTimeout(async () => {
      setPreviewing(true);
      setPreviewErr(null);
      try {
        const res = await productApi.convertBase(product.id, subUnitBody(d, cur, { dryRun: true }));
        const r = dryRunOf(res.data);
        if (live) setPreview(r ? { key, r } : null);
      } catch (e) {
        if (live) { setPreview(null); setPreviewErr(onServerError(e)); }
      } finally {
        if (live) setPreviewing(false);
      }
    }, 400);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- البصمة تحمل القيم كلّها
  }, [key, problem, product.id, cur]);

  const shown = preview && preview.key === key ? preview.r : null;
  const needs = dryRunNeeds(shown);
  const runnable = !problem && canRunSubUnit({ previewKey: preview?.key ?? null, key, preview: preview?.r ?? null, ackErp, ackApi });
  const afterLine = shown ? defaultAfterLine(shown.primaryAfter, defaultChoice(product).name) : null;

  const run = useMutation({
    mutationFn: async () => productApi.convertBase(product.id, subUnitBody(d, cur, { acknowledgeErp: ackErp, acknowledgeApi: ackApi })),
    onSuccess: () => {
      invalidateProducts(qc, product.id);
      toast.success(tr('أضيفت الوحدة الفرعية'));
      onConverted();
    },
    onError: (e: unknown) => {
      const msg = onServerError(e);
      if (msg) toast.error(msg);
    },
  });

  return (
    <Sheet title={tr('إضافة وحدة فرعية أصغر')} onClose={() => { if (!run.isPending) onClose(); }}>
      <div className="max-h-[62vh] overflow-y-auto overscroll-contain space-y-3 -mx-1 px-1">
        <SubUnitFacts product={product} />
        <div>
          <Field label={tr('الوحدة الفرعية')} required value={d.newBaseName}
            onChange={v => set('newBaseName', v)} placeholder={tr('حبة')} />
          {nameErr && <p className="text-[11px] text-[#C0392B] mt-1">{nameErr}</p>}
        </div>
        <NumField label={fill(tr('كم {sub} في {primary}'), { sub: shownNew, primary: cur })} required integer
          value={d.factor} onChange={v => set('factor', v)} placeholder="24" />
        <NumField label={`${fill(tr('سعر {unit} الواحدة'), { unit: shownNew })} (${tr('اختياري')})`} value={d.basePrice}
          onChange={v => set('basePrice', v)}
          placeholder={subPrice != null && d.basePrice.trim() === '' ? `≈ ${subPrice} ${tr('محسوب')}` : undefined} />
        <label className="flex items-start gap-2.5 min-h-[44px] cursor-pointer">
          <input type="checkbox" checked={d.keepPrimary} onChange={e => { setTouched(true); setD(x => ({ ...x, keepPrimary: e.target.checked })); }}
            className="w-5 h-5 mt-0.5 accent-[#E15A30] flex-shrink-0" />
          <span className="text-[12px] text-[#1F1A13] leading-relaxed">
            {fill(tr('تبقى «{unit}» الوحدة الرئيسية في العرض والإدخال'), { unit: cur })}
          </span>
        </label>
        {touched && problem && <p className="text-[11px] text-[#C0392B]">{tr(problem)}</p>}

        {/* المعاينة بالأرقام — ما يفعله الخادم لو نُفِّذ الآن بهذه القيم نفسها */}
        {!problem && previewing && !shown && <p className="text-[11px] text-[#9A8F7E]">{tr('جاري التحميل')}</p>}
        {!problem && previewErr && <p className="text-[11px] text-[#C0392B]">{previewErr}</p>}
        {shown && (
          <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2.5 space-y-1.5 text-[12px] text-[#1F1A13] leading-relaxed">
            <p><b>1 {cur} = {formatNumber(F)} {newName}</b> · {formatCurrency(product.basePrice)} / {cur}
              {subPrice != null && <> · {formatCurrency(subPrice, undefined, 4)} / {newName}</>}</p>
            <p>{fill(tr('سيعاد وسم {n} بندا، والفواتير المطبوعة لا تتغير'), { n: formatNumber(dryRunItems(shown)) })}</p>
            <p>{fill(tr('سعر العميل الخاص يبقى لـ«{unit}» كما هو'), { unit: cur })}</p>
            {afterLine && <p className="font-semibold text-[#B7791F]">{fill(tr('الافتراض في البيع بعد الإضافة: {unit}'), { unit: afterLine })}</p>}
            <p className="text-[11px] text-[#6E6557]">{tr('قد تستغرق حتى دقيقتين لصنف بتاريخ طويل، ومن يحفظ أثناءها يُطلب منه إعادة المحاولة')}</p>
          </div>
        )}
        {shown && needs.erp && (
          <label className="flex items-start gap-2.5 min-h-[44px] cursor-pointer">
            <input type="checkbox" checked={ackErp} onChange={e => setAckErp(e.target.checked)}
              className="w-5 h-5 mt-0.5 accent-[#E15A30] flex-shrink-0" />
            <span className="text-[12px] text-[#1F1A13] leading-relaxed">
              {fill(tr('الصنف مربوط بنظام ERP بوحدة واحدة: ما سبق الإضافة بـ{unit} وما بعدها بـ{sub} هناك — أؤكد المتابعة'), { unit: cur, sub: shownNew })}
            </span>
          </label>
        )}
        {shown && needs.apiKeys > 0 && (
          <label className="flex items-start gap-2.5 min-h-[44px] cursor-pointer">
            <input type="checkbox" checked={ackApi} onChange={e => setAckApi(e.target.checked)}
              className="w-5 h-5 mt-0.5 accent-[#E15A30] flex-shrink-0" />
            <span className="text-[12px] text-[#1F1A13] leading-relaxed">
              {fill(tr('للشركة ربط برمجي نشط ({n} مفتاح) — بعد الإضافة تقرأ كمياته وأسعاره بـ{sub}، وأبلغت المتكامل'), { n: formatNumber(needs.apiKeys), sub: shownNew })}
            </span>
          </label>
        )}
        <p className="text-[11px] font-bold text-[#C0392B] flex items-center gap-1">
          <AlertTriangle size={12} className="flex-shrink-0" />
          {tr('لا يمكن التراجع عن التحويل')}
        </p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => run.mutate()} disabled={!runnable || run.isPending}
          className="flex-1 bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-50">
          {(run.isPending || previewing) && <Loader2 size={16} className="animate-spin" />}
          {tr('إضافة وحدة فرعية أصغر')}
        </button>
        <button onClick={onClose} disabled={run.isPending}
          className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
          {tr('إلغاء')}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * ما تفعله «إضافة وحدة فرعية أصغر» — بلفظ D21 (لا «الأساس»): يقرؤها المدير قبل أن يكتب العدد.
 */
function SubUnitFacts({ product }: { product: Product }) {
  const tr = useTr();
  return (
    <ul className="text-[11px] text-[#6E6557] leading-relaxed space-y-1 list-disc ps-4">
      <li>
        {fill(tr('الصنف يباع اليوم بـ«{unit}» بسعر {price}. بعد الإضافة يبقى «{unit}» بسعره وتصير الوحدة الفرعية أصغر وحدة له'),
          { unit: product.unit, price: formatCurrency(product.basePrice) })}
      </li>
      <li>{tr('أرقام الفواتير والحركات السابقة لا تتغير: ما بيع بها يبقى مطبوعا كما هو وتحسب كميته بالوحدة الجديدة تلقائيا')}</li>
      <li>{tr('أسعار العملاء الخاصة وشرائح الأسعار تقسم على المعامل فيبقى سعر الوحدة الحالية لكل عميل كما هو')}</li>
      <li>{tr('المندوب يستمر في البيع بالوحدة الحالية افتراضيا')}</li>
    </ul>
  );
}

/** خانة رقمية للوحدات والتحويل — صحيحةٌ للمعامل (لوحة أرقام بلا فاصلة) وعشريةٌ للسعر */
function NumField({ label, value, onChange, placeholder, required, integer }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean; integer?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}{required && ' *'}</label>
      <input className="input min-h-[44px]" type="number" dir="ltr" step={integer ? 1 : 'any'} min="0"
        inputMode={integer ? 'numeric' : 'decimal'} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </div>
  );
}

/* ──────────────────────────── لبنات هذا الملفّ ──────────────────────────── */

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{title}</h3>
      <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, value, onChange, required, dir, placeholder }: {
  label: string; value: string; onChange: (v: string) => void;
  required?: boolean; dir?: 'ltr' | 'rtl'; placeholder?: string;
}) {
  return (
    <div>
      <label className="label">{label}{required && ' *'}</label>
      <input className="input min-h-[44px]" dir={dir} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function TierField({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="flex-1 min-w-0">
      <span className="block text-[10px] text-[#9A8F7E] mb-1 truncate">{label}</span>
      <input className="input min-h-[44px] text-center" type="number" dir="ltr" step="any" min="0"
        inputMode="decimal" value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)} />
    </label>
  );
}

/** ورقة سفلية — الخلفية زرٌّ حقيقيّ لا `div` بنقرة، فتصلها لوحة المفاتيح والقارئ */
function Sheet({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  const tr = useTr();
  return (
    <div className="absolute inset-0 z-30 flex items-end">
      <button type="button" onClick={onClose} aria-label={tr('إغلاق')} className="absolute inset-0 bg-black/40" />
      <div className="relative w-full bg-white rounded-t-2xl border-t border-[#E9E1D3] p-4 space-y-3"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <p className="text-sm font-bold text-[#1F1A13]">{title}</p>
        {children}
      </div>
    </div>
  );
}
