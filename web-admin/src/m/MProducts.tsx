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
import { unitPriceOf } from '../lib/units';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import {
  hasBigUnit, unitsBrief, qtyText, tierBaseBounds, tierPayload, biggestUnit,
  unitDraftProblem, unitDraftPayload, unitDraftOf, convertDraftProblem, convertedBasePrice, type UnitDraft,
} from './mUnits';
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
 * (convertBase) الذي يوسم التاريخ بمعامله ويقسم أسعار الأساس، بنافذة تأكيدٍ تقول ذلك صراحةً.
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

/** رمز رفض الخادم (BASE_UNIT_CHANGED…) — يقرّر ما يُفعل بعده لا ما يُقال */
function apiCode(e: unknown): string | undefined {
  return (e as { response?: { data?: { code?: string } } })?.response?.data?.code;
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
        product={editing}
        categories={catsQ.data ?? []}
        lotOn={lotOn}
        onClose={() => setEditing(undefined)}
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
              {tr('لوط')}
            </span>
          )}
        </span>
      }
      subtitle={[p.code, p.unit, unitsBrief(p.units, formatNumber), p.category?.name].filter(Boolean).join(' · ')}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className="text-end">
            <span className="block text-xs font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(p.basePrice)}</span>
            {/* الوسم تحت كل سعر معروض — لا يُترك للقارئ أن يخمّن أهو شاملٌ أم صافٍ */}
            <span className="block text-[9px] text-[#9A8F7E]">{multi && `${p.unit} · `}{tr('قبل الضريبة')}</span>
          </span>
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

/**
 * نموذج الصنف — طبقةٌ ملء الشاشة فوق القائمة.
 *
 * **بلا `react-hook-form` عمداً** كنموذج العملاء: نماذجها ترسل `null` للحقول
 * الفارغة. وهنا نُرسل نصّاً فارغاً صريحاً للباركود والفئة — لأن الخادم يترجمه
 * `null` (`data.barcode || null`)، وهو **الطريق الوحيد لمحو** قيمة قديمة؛
 * وحذفُ المفتاح أصلاً كان سيعني «لا تغيّرها» فيبقى الباركود المشطوب مكانه.
 */
function MProductForm({ product, categories, onClose, lotOn = false }: {
  product: Product | null; categories: Cat[]; onClose: () => void;
  /** «تتبّع اللوط» مفعّل للشركة — مطفأ ⇒ لا مفتاح ولا حقل في الحمولة */
  lotOn?: boolean;
}) {
  const tr = useTr();
  const qc = useQueryClient();
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
  const valid = !!form.name.trim() && !!form.code.trim() && !!form.unit.trim()
    && form.basePrice.trim() !== '' && Number.isFinite(price) && price >= 0 && taxOk;

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
      // تبدّل التتبّع: قوائم الأصناف في الفاتورة والتحميل والوارد تقرأ علمه (حقل التشغيلة واقتراحها)، وشاشة التشغيلات
      if (lotChanged) {
        invalidateProducts(qc, product?.id);
        LOT_CACHE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      }
      setLotBalances(null);
      toast.success(product ? tr('تم التحديث') : tr('تم الإضافة'));
      onClose();
    },
    onError: (e: unknown, confirmLot) => {
      const bal = product && !confirmLot ? trackingBalanceOf(e) : null;
      if (bal) { setLotBalances(bal.products); return; }
      setLotBalances(null);
      toast.error(lotErrorOf(e)?.message || apiMessage(e, tr('تعذر الحفظ')));
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
  /* بعد تحويل الأساس يُغلق النموذج كلّه لا شاشة الوحدات وحدها: خاناته تحمل الاسم والسعر **القديمين**، وحفظُها بعده
   * يكتب سعر الكرتون سعراً للحبّة — بيعٌ بأربعة وعشرين ضعفاً بلا خطأ */
  if (unitsOpen && product) {
    return <MProductUnits product={product} onClose={() => setUnitsOpen(false)} onConverted={onClose} />;
  }

  // تغيير اسم الأساس لصنفٍ قائم لا يحوّل كمياته — يُقال قبل الحفظ لا بعده
  const renamingBase = !!product && form.unit.trim() !== '' && form.unit.trim() !== (product.unit || '').trim();

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
        <Group title={tr('بيانات الصنف')}>
          <Field label={tr('اسم الصنف')} required value={form.name} onChange={v => set('name', v)} />
          <Field label={tr('كود الصنف')} required dir="ltr" value={form.code} onChange={v => set('code', v)} />
          <Field label={tr('باركود')} dir="ltr" value={form.barcode} onChange={v => set('barcode', v)} />
          <div>
            {/* نصوص لوحة الويب نفسها (ProductModal) — المعنى واحدٌ فاللفظ واحد في الواجهتين */}
            <Field label={multi ? tr('وحدة الأساس') : tr('وحدة القياس')} required value={form.unit}
              onChange={v => set('unit', v)} placeholder={tr('كرتون / قطعة / كيلو')} />
            {!product && (
              <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr('احفظ الصنف أولا ثم أضف له وحدات بيع أكبر مثل الكرتون')}</p>
            )}
            {renamingBase && (
              <p className="text-[11px] text-[#B7791F] mt-1.5 flex items-start gap-1 leading-relaxed">
                <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                {tr('تغيير الاسم هنا إعادة تسمية فقط ولتصغير وحدة الأساس استخدم تحويل إلى وحدة أصغر')}
              </p>
            )}
          </div>
        </Group>

        <Group title={tr('السعر والضريبة')}>
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
          <Group title={tr('تتبع باللوط')}>
            <label className="flex items-center gap-3 min-h-[44px] cursor-pointer">
              <input type="checkbox" checked={lotValue} onChange={e => setLotChoice(e.target.checked)}
                className="w-5 h-5 accent-[#E15A30] flex-shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[#1F1A13]">{tr('تتبع باللوط')}</span>
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
              subtitle={unitsBrief(units, formatNumber) || tr('لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها')}
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
        <button onClick={() => save.mutate(false)} disabled={!valid || save.isPending}
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
    </div>
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
 */
function MProductTiers({ product, onClose }: { product: Product; onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [rows, setRows] = useState<TierRow[] | null>(null);

  const q = useQuery({
    queryKey: ['m-product', product.id],
    queryFn: async () => expectObject<Product>((await productApi.get(product.id)).data?.data, tr('الصنف')),
  });

  // البذرة مرّة واحدة: إعادةُ الجلب بعد الحفظ يجب ألّا تدهس تحريراً جارياً
  useEffect(() => {
    const data = q.data;
    if (!data) return;
    const seed: TierRow[] = (data.priceTiers ?? []).map(t => {
      const b = tierBaseBounds(t);
      return {
        uid: ++tierUid,
        minQty: String(b.min),
        maxQty: b.max == null ? '' : String(b.max),
        price: String(t.price),
      };
    });
    setRows(prev => prev ?? seed);
  }, [q.data]);

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

  const save = useMutation({
    mutationFn: async () => {
      // الحدود بالأساس في العمودين معاً، والحدّ الأعلى الفارغ بلا مفتاح (`maxQty` عند الخادم optional لا nullish:
      // إرسال null يُسقط الطلب كلّه) — tierPayload في mUnits.ts
      const tiers = (rows ?? []).map(r =>
        tierPayload(Number(r.minQty), r.maxQty.trim() === '' ? null : Number(r.maxQty), Number(r.price)));
      await productApi.updatePriceTiers(product.id, tiers);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['m-products'] });
      qc.invalidateQueries({ queryKey: ['m-product', product.id] });
      toast.success(tr('تم الحفظ'));
      onClose();
    },
    onError: (e: unknown) => toast.error(apiMessage(e, tr('تعذر الحفظ'))),
  });

  const basePrice = q.data?.basePrice ?? product.basePrice;
  // وحدات الصنف الآن (لا ما حُمِّل مع القائمة): الشريحة بالأساس، وتلميحها بأكبر وحدة («٢ كرتون» و«سعر الكرتون»)
  const cur = q.data ?? product;
  const multi = hasBigUnit(cur.units);
  const big = biggestUnit(cur.units);

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
                <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('السعر الأساسي')}{multi ? ` (${cur.unit})` : ''}</p>
                <p className="text-lg font-bold text-[#1F1A13]">{formatCurrency(basePrice)}</p>
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
                    const pr = Number(r.price);
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
                      {/* الشريحة بالأساس مقروءةً بالوحدات: «من ٤٨» تُقرأ «من ٢ كرتون»، وسعر الحبّة يُرى سعرَ كرتون */}
                      {multi && big && r.minQty.trim() !== '' && Number.isFinite(min) && (
                        <p className="text-[10px] text-[#9A8F7E]">
                          {tr('من')} {qtyText(min, cur, formatNumber)}
                          {r.price.trim() !== '' && Number.isFinite(pr) && ` · ${formatCurrency(pr * Number(big.factor))} / ${big.name}`}
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
              {multi && (
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
 */
function MProductUnits({ product, onClose, onConverted }: {
  product: Product; onClose: () => void;
  /** التحويل تمّ — يُغلق نموذج الصنف كلّه (خاناته بالأساس القديم) */
  onConverted: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  // تقييدٌ مؤقّت: التحويل بجلسة المالك وحدها (الخادم يفرضه) — docs/multi-unit/REVIEW.md
  const ownerSession = useAuthStore(x => !!x.impersonating);
  // undefined = مغلق · null = وحدة جديدة · ProductUnit = تعديل
  const [editing, setEditing] = useState<ProductUnit | null | undefined>(undefined);
  const [removing, setRemoving] = useState<ProductUnit | null>(null);
  const [converting, setConverting] = useState(false);
  useBackClose(editing !== undefined, () => setEditing(undefined));
  useBackClose(!!removing, () => setRemoving(null));
  useBackClose(converting, () => setConverting(false));

  const q = useQuery({
    queryKey: ['m-product', product.id],
    queryFn: async () => expectObject<Product>((await productApi.get(product.id)).data?.data, tr('الصنف')),
  });
  // الصنف كما هو على الخادم الآن — الأساس الذي يُرسَل expectedBaseName منه، لا من قائمةٍ حُمِّلت قبل دقائق
  const p = q.data ?? product;
  const units = p.units ?? [];

  const toggle = useMutation({
    mutationFn: async (u: ProductUnit) => productApi.updateUnit(product.id, u.id, { isActive: u.isActive === false }),
    onSuccess: (_r, u) => {
      invalidateProducts(qc, product.id);
      toast.success(u.isActive === false ? tr('فعلت الوحدة') : tr('أوقفت الوحدة'));
      setEditing(undefined);
      setRemoving(null);
    },
    onError: (e: unknown) => toast.error(apiMessage(e, tr('تعذر الحفظ'))),
  });
  const remove = useMutation({
    mutationFn: async (u: ProductUnit) => productApi.removeUnit(product.id, u.id),
    onSuccess: () => {
      invalidateProducts(qc, product.id);
      toast.success(tr('حذفت الوحدة'));
      setRemoving(null);
      setEditing(undefined);
    },
    onError: (e: unknown) => { toast.error(apiMessage(e, tr('تعذر الحفظ'))); setRemoving(null); },
  });

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

              {units.length === 0 ? (
                <div className="min-h-[160px]">
                  <MEmpty icon={Boxes} text={tr('لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها')} />
                </div>
              ) : (
                <MCard>
                  {units.map(u => {
                    const off = u.isActive === false;
                    return (
                      <MRow key={u.id} onClick={() => setEditing(u)}
                        title={
                          <span className="flex items-center gap-1.5">
                            <span className="truncate">{u.name}</span>
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
                                {u.price == null ? tr('محسوب من سعر الأساس') : tr('قبل الضريبة')}
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

{ownerSession && (
              <MCard onClick={() => setConverting(true)}>
                <MRow
                  leading={
                    <span className="w-9 h-9 rounded-lg bg-[#FDF6E7] text-[#B7791F] flex items-center justify-center flex-shrink-0">
                      <ArrowRightLeft size={16} />
                    </span>
                  }
                  title={tr('تحويل إلى وحدة أصغر')}
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
          onToggle={u => toggle.mutate(u)} toggling={toggle.isPending}
          onRemove={u => setRemoving(u)} />
      )}

      {removing && (
        <Sheet title={tr('حذف الوحدة')} onClose={() => { if (!remove.isPending) setRemoving(null); }}>
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
              <button onClick={() => toggle.mutate(removing)} disabled={remove.isPending || toggle.isPending}
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

      {converting && q.data && (
        <ConvertSheet product={p}
          onClose={() => setConverting(false)}
          onConverted={() => { setConverting(false); onConverted(); }} />
      )}
    </div>
  );
}

/** نموذج الوحدة — ورقةٌ سفلية: إضافةٌ أو تعديل، ومعها الإيقاف والحذف للوحدة القائمة */
function UnitSheet({ product, unit, onClose, onSaved, onToggle, toggling, onRemove }: {
  product: Product;
  /** null = وحدة جديدة */
  unit: ProductUnit | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onToggle: (u: ProductUnit) => void;
  toggling: boolean;
  onRemove: (u: ProductUnit) => void;
}) {
  const tr = useTr();
  const [d, setD] = useState<UnitDraft>(() => unitDraftOf(unit));
  // الرسالة بعد أوّل كتابة لا قبلها: نموذجٌ فارغ يفتح بخطأٍ أحمر يُقرأ عطلاً
  const [touched, setTouched] = useState(false);
  const set = (k: keyof UnitDraft, v: string) => { setTouched(true); setD(x => ({ ...x, [k]: v })); };

  // الحارس نفسه الذي يرفض به الخادم (unitProblem) — والأساس بين «الأخريات» بمعامل ١ كما في الخادم
  const others = (product.units ?? []).filter(u => u.id !== unit?.id);
  const problem = unitDraftProblem(d, product.unit, others);
  const f = Math.round(Number(d.factor));
  const derived = Number.isFinite(f) && f > 1 ? unitPriceOf({ name: d.name, factor: f }, product.basePrice) : null;
  const factorChanged = !!unit && d.factor.trim() !== '' && Number(d.factor) !== Number(unit.factor);

  const save = useMutation({
    mutationFn: async () => {
      const body = unitDraftPayload(d);
      if (unit) await productApi.updateUnit(product.id, unit.id, body);
      else await productApi.addUnit(product.id, body);
    },
    onSuccess: () => onSaved(unit ? tr('حفظت الوحدة') : tr('أضيفت الوحدة')),
    onError: (e: unknown) => toast.error(apiMessage(e, tr('تعذر الحفظ'))),
  });
  const busy = save.isPending || toggling;

  return (
    <Sheet title={unit ? `${tr('تعديل')} «${unit.name}»` : tr('إضافة وحدة')} onClose={() => { if (!busy) onClose(); }}>
      {/* نصوص لوحة الويب نفسها (ProductModal) — المعنى واحدٌ فاللفظ واحد في الواجهتين */}
      <div className="max-h-[58vh] overflow-y-auto overscroll-contain space-y-3 -mx-1 px-1">
        <Field label={tr('اسم الوحدة')} required value={d.name} onChange={v => set('name', v)} />
        <NumField label={`${tr('عدد وحدات الأساس فيها')} (${product.unit})`} required integer
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
            {tr('فارغ يعني سعر الأساس مضروبا في المعامل')}
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
 * تحويل وحدة الأساس إلى أصغر منها (كرتون ⇒ حبة) — خطوتان: النموذج ثم نافذة تأكيدٍ تقول ما سيحدث بالأرقام.
 *
 * التحويل لا تراجع عنه ويمسّ تاريخ الصنف كلّه في معاملةٍ واحدة على الخادم: الكرتون يصير وحدةً بمعاملها **بسعره**، وتُوسم
 * صفوفه القديمة بمعاملها فلا يتغيّر رقمٌ مطبوع، وتُقسم أسعار العملاء والشرائح على المعامل. فالتأكيد يسمّي الوحدتين
 * والمعامل والسعرين صراحةً — «هل أنت متأكد؟» وحدها تُنقر بلا قراءة. و`expectedBaseName` من الصنف الحيّ: نقرةٌ ثانية
 * أو مديرٌ آخر سبق ⇒ 409 BASE_UNIT_CHANGED فلا يُضرب التاريخ بالمعامل مرّتين.
 */
function ConvertSheet({ product, onClose, onConverted }: {
  product: Product; onClose: () => void; onConverted: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [d, setD] = useState({ newBaseName: '', factor: '', basePrice: '' });
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [touched, setTouched] = useState(false);
  const set = (k: 'newBaseName' | 'factor' | 'basePrice', v: string) => { setTouched(true); setD(x => ({ ...x, [k]: v })); };

  const problem = convertDraftProblem(d, product);
  const F = Math.round(Number(d.factor));
  const auto = convertedBasePrice(product.basePrice, F);
  const priceBad = d.basePrice.trim() !== '' && (!Number.isFinite(Number(d.basePrice)) || Number(d.basePrice) < 0);
  const newPrice = d.basePrice.trim() === '' ? auto : Number(d.basePrice);
  const newName = d.newBaseName.trim();
  const shownNew = newName || tr('الوحدة الجديدة');

  const run = useMutation({
    mutationFn: async () => productApi.convertBase(product.id, {
      newBaseName: newName, factor: F, expectedBaseName: product.unit,
      // الفارغ لا يُرسَل: الخادم يقسم السعر القديم على المعامل بأربع منازل (المعروض هنا نفسه)
      ...(d.basePrice.trim() !== '' && { basePrice: Number(d.basePrice) }),
    }),
    onSuccess: () => {
      invalidateProducts(qc, product.id);
      toast.success(tr('تم تحويل وحدة الأساس'));
      onConverted();
    },
    onError: (e: unknown) => {
      // سبقه تحويلٌ أو تعديل: الصنف يُقرأ من جديد ولا يُعاد الطلب على أساسٍ لم يعد قائماً
      if (apiCode(e) === 'BASE_UNIT_CHANGED') { invalidateProducts(qc, product.id); onClose(); }
      else setStep('form');
      toast.error(apiMessage(e, tr('تعذر الحفظ')));
    },
  });

  if (step === 'confirm') {
    return (
      <Sheet title={tr('تأكيد التحويل')} onClose={() => { if (!run.isPending) setStep('form'); }}>
        <div className="max-h-[58vh] overflow-y-auto overscroll-contain space-y-2.5 -mx-1 px-1">
          {/* ما سيحدث بالأرقام: الوحدتان والمعامل والسعران — «هل أنت متأكد؟» وحدها تُنقر بلا قراءة */}
          <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2.5 space-y-2 text-[12px] text-[#1F1A13] leading-relaxed">
            <p>
              <b>«{product.unit}» = {formatNumber(F)} {newName}</b> · {formatCurrency(product.basePrice)}
            </p>
            <p>
              <span className="text-[#6E6557]">{tr('سعر وحدة الأساس الجديدة')}: </span>
              <b>«{newName}»</b> · {formatCurrency(newPrice, undefined, 4)}
            </p>
            {(product.units?.length ?? 0) > 0 && (
              <p>
                <span className="text-[#6E6557]">{tr('الوحدات القائمة تضرب معاملاتها في')} </span>
                <b>{formatNumber(F)}</b>
              </p>
            )}
          </div>
          <ConvertFacts product={product} />
          <p className="text-[11px] font-bold text-[#C0392B] flex items-center gap-1">
            <AlertTriangle size={12} className="flex-shrink-0" />
            {tr('لا يمكن التراجع عن التحويل')}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate()} disabled={run.isPending}
            className="flex-1 bg-[#C0392B] text-white font-bold py-3 rounded-xl min-h-[48px] flex items-center justify-center gap-2 disabled:opacity-60">
            {run.isPending && <Loader2 size={16} className="animate-spin" />}
            {tr('تأكيد التحويل')}
          </button>
          <button onClick={() => setStep('form')} disabled={run.isPending}
            className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
            {tr('رجوع')}
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={tr('تحويل وحدة الأساس إلى وحدة أصغر')} onClose={onClose}>
      <div className="max-h-[58vh] overflow-y-auto overscroll-contain space-y-3 -mx-1 px-1">
        <ConvertFacts product={product} />
        <Field label={tr('اسم وحدة الأساس الجديدة')} required value={d.newBaseName}
          onChange={v => set('newBaseName', v)} placeholder={tr('حبة')} />
        <NumField label={`${tr('عدد وحدات الأساس الجديدة في الوحدة الحالية')} (${shownNew} / ${product.unit})`} required integer
          value={d.factor} onChange={v => set('factor', v)} placeholder="24" />
        <div>
          <NumField label={`${tr('سعر وحدة الأساس الجديدة')} (${tr('اختياري')})`} value={d.basePrice} onChange={v => set('basePrice', v)}
            placeholder={F >= 2 ? String(auto) : undefined} />
          <p className="text-[11px] text-[#9A8F7E] mt-1.5">{tr('فارغ يعني السعر الحالي مقسوما على المعامل')}</p>
          {priceBad && <p className="text-[11px] text-[#C0392B] mt-1">{tr('سعر الوحدة رقم موجب')}</p>}
        </div>
        {touched && problem && <p className="text-[11px] text-[#C0392B]">{tr(problem)}</p>}
      </div>
      <div className="flex gap-2">
        <button onClick={() => setStep('confirm')} disabled={!!problem || priceBad}
          className="flex-1 bg-[#E15A30] text-white font-bold py-3 rounded-xl min-h-[48px] disabled:bg-[#E89B7E]">
          {tr('متابعة')}
        </button>
        <button onClick={onClose}
          className="px-5 border border-[#E9E1D3] bg-white rounded-xl min-h-[48px] text-sm font-semibold text-[#1F1A13]">
          {tr('إلغاء')}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * ما يفعله التحويل — بنود نافذة لوحة الويب نفسها (ProductModal) حرفاً: المعنى واحدٌ فاللفظ واحد، ويقرؤها المدير قبل أن
 * يكتب المعامل وتعود في نافذة التأكيد بجانب الأرقام.
 */
function ConvertFacts({ product }: { product: Product }) {
  const tr = useTr();
  return (
    <ul className="text-[11px] text-[#6E6557] leading-relaxed space-y-1 list-disc ps-4">
      <li>
        {tr('الصنف يباع اليوم بوحدة')} «<b>{product.unit}</b>». {tr('بعد التحويل تصير وحدة بيع بالمعامل الذي تكتبه وبسعرها الحالي')} ({formatCurrency(product.basePrice)})، {tr('وتصبح وحدة الأساس الجديدة هي الأصغر')}.
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
