import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Package, ChevronLeft, Trash2, Loader2, Layers, AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { productApi } from '../api/client';
import { Product } from '../types';
import { formatCurrency, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { MCard, MRow, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';

/**
 * المنتجات والأسعار في تطبيق الإدارة على الجوال.
 *
 * ⚠️ **السعر المخزَّن صافٍ قبل الضريبة** — قاعدة حاكمة في المنصّة كلّها
 * (`m/docMath.ts` يبني عليها كل فاتورة). فكلّ خانة سعرٍ هنا تحتها سطرٌ صريح
 * يقوله، لأن من يكتب «١١٥» ظنّاً أنه السعر الشامل يبيع بـ١٣٢٫٢٥ ولا يدري.
 *
 * والتصفية على الخادم لا محلياً (بحث/فئة/حالة): قوائم الأصناف تُعدّ بالآلاف،
 * وتصفيةُ ما حُمِّل وحده تُخفي عن المستخدم أصنافاً موجودة فيظنّها غير مسجّلة.
 */

const PAGE = 30;

interface Cat { id: string; name: string }

/** رسالة الخادم لا «حدث خطأ» العمياء — سبب الرفض (كود مكرّر، صنف له حركات) يصل للمستخدم */
function apiMessage(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

export default function MProducts({ onBack }: { onBack: () => void }) {
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
                <ProductRow key={p.id} p={p} onOpen={() => setEditing(p)} />
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

function ProductRow({ p, onOpen }: { p: Product; onOpen: () => void }) {
  const tr = useTr();
  const off = p.status === 'INACTIVE';
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
        </span>
      }
      subtitle={[p.code, p.unit, p.category?.name].filter(Boolean).join(' · ')}
      trailing={
        <span className="flex items-center gap-1 flex-shrink-0">
          <span className="text-end">
            <span className="block text-xs font-bold text-[#E15A30] whitespace-nowrap">{formatCurrency(p.basePrice)}</span>
            {/* الوسم تحت كل سعر معروض — لا يُترك للقارئ أن يخمّن أهو شاملٌ أم صافٍ */}
            <span className="block text-[9px] text-[#9A8F7E]">{tr('قبل الضريبة')}</span>
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
function MProductForm({ product, categories, onClose }: {
  product: Product | null; categories: Cat[]; onClose: () => void;
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

  // طبقات هذا النموذج — من الأعلى بصرياً إلى الأدنى (وطبقة «أسعار الكميات»
  // تسجّل نفسها داخل مكوّنها فتقع فوق الجميع)
  useBackClose(newCat !== null, () => setNewCat(null));
  useBackClose(newCat === null && confirming, () => setConfirming(false));

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
    mutationFn: async () => {
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
      if (product) await productApi.update(product.id, payload);
      else await productApi.create(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['m-products'] });
      if (product) qc.invalidateQueries({ queryKey: ['m-product', product.id] });
      toast.success(product ? tr('تم التحديث') : tr('تم الإضافة'));
      onClose();
    },
    onError: (e: unknown) => toast.error(apiMessage(e, tr('تعذر الحفظ'))),
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
          <Field label={tr('وحدة القياس')} required value={form.unit} onChange={v => set('unit', v)}
            placeholder={tr('كرتون / قطعة / كيلو')} />
        </Group>

        <Group title={tr('السعر والضريبة')}>
          <div>
            <label className="label">{tr('السعر الأساسي')} *</label>
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
        <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
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
    const seed: TierRow[] = (data.priceTiers ?? []).map(t => ({
      uid: ++tierUid,
      minQty: String(t.minQty),
      maxQty: t.maxQty == null ? '' : String(t.maxQty),
      price: String(t.price),
    }));
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
      const tiers = (rows ?? []).map(r => {
        // `maxQty` عند الخادم `optional` لا `nullish`: إرسال null يُسقط الطلب
        // كلّه، فالحدّ الأعلى الفارغ يُحذف مفتاحه أصلاً ومعناه «بلا حدّ»
        const t: { minQty: number; price: number; maxQty?: number } = {
          minQty: Number(r.minQty), price: Number(r.price),
        };
        if (r.maxQty.trim() !== '') t.maxQty = Number(r.maxQty);
        return t;
      });
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
                <p className="text-[11px] text-[#9A8F7E] mb-1">{tr('السعر الأساسي')}</p>
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
                  {rows.map((r, i) => (
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
                    </div>
                  ))}
                </MCard>
              )}

              {invalid && (
                <p className="text-[11px] text-[#C0392B] px-1">{tr('راجع الكميات والأسعار')}</p>
              )}
              <p className="text-[11px] text-[#9A8F7E] px-1 leading-relaxed">
                {tr('سعر الشريحة يطبق عند بلوغ الكمية وهو أيضا قبل الضريبة')}
              </p>
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
