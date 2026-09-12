import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Trash2, Loader2, Warehouse, PackagePlus, Package, Wallet,
  Boxes, AlertTriangle, TrendingUp, TrendingDown, ChevronDown, ChevronUp,
  ArrowRightLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { warehouseApi, productApi } from '../api/client';
import { formatCurrency, formatDate, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { MScreen, MCard, MRow, MStat, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray } from './shape';

/**
 * مخزون الشركة (المستودع المركزيّ) في تطبيق الإدارة على الجوال.
 *
 * الرصيد ليس عموداً مخزَّناً بل **محسوبٌ** في الخادم:
 *   الوارد + تسويات المستودع + العائد من السيارات − المحمّل لها.
 * فلا شيء يُكتب هنا إلا حركةً (وارد أو تسوية)، والباقي قراءةُ حصيلة.
 *
 * ⚠️ **حدّ صدق التقييم** — القاعدة الحاكمة في هذه الشاشة كلّها:
 * `stockValue` قيمةُ الكمّية التي تُعرف تكلفتها (`costedQty`) **وحدها**، و
 * `uncostedQty` كمّيةٌ موجودةٌ في المستودع بلا تكلفةٍ معروفة فهي **خارج** تلك
 * القيمة. فيُعرض الرقمان متجاورين دائماً ويُقال الاستثناء صراحةً — لأن رقماً
 * يُقرأ «قيمة مخزوني» وهو لا يغطّي الرصيد كلّه يُبنى عليه قرار شراءٍ خاطئ،
 * وقد وقع في هذه المنصّة مرّةً فكلّف ألف ضعفٍ في رقمٍ معروض.
 *
 * ⚠️ **والتكلفة المخزَّنة صافيةٌ قبل الضريبة دائماً**: المستخدم يكتب ما في
 * فاتورة مورّده ويؤشّر «شاملة الضريبة»، فيردّها الخادم إلى صافيها قبل الحفظ.
 * لذلك كل رقم تكلفةٍ معروضٍ هنا موسومٌ «قبل الضريبة» بلا استثناء.
 */

/** صفّ الرصيد — مطابقٌ لـ`WarehouseRow` في backend/src/services/warehouseStock.ts */
interface WhRow {
  productId: string; name: string; code: string; unit: string;
  received: number;         // الوارد للمستودع
  adjusted: number;         // تسويات المستودع (+/−)
  loadedToVans: number;     // خرج للسيارات
  returnedFromVans: number; // عاد منها
  onHand: number;           // الرصيد الباقي
  avgCost: number;          // متوسّط تكلفة الوحدة (على المقيَّم وحده)
  costedQty: number;        // الكمّية المقيَّمة
  stockValue: number;       // قيمتها — ولا تشمل uncostedQty
  uncostedQty: number;      // كمّية بلا تكلفة معروفة — خارج القيمة صراحةً
}

/** حركة مستودع كما يردّها `GET /warehouse/entries` (بإجماليها المحسوب في الخادم) */
interface WhEntry {
  id: string; type: string; note: string | null; supplier: string | null;
  createdBy: string | null; createdAt: string;
  items: { id: string; qty: number; unitCost: number | null; product: { name: string; unit: string } }[];
  totalCost: number;
}

interface ProductPick { id: string; name: string; code?: string; unit?: string; taxPct?: number }

/** كسورٌ محتملة في الوحدات الموزونة — بلا أصفارٍ زائدة على «١٢» */
const fmtQty = (n: number) => formatNumber(Number(n.toFixed(2)));

/** رسالة الخادم أولى من رسالتنا: «ميزة مخزون الشركة غير مفعلة» تُفهم، و«تعذر التحميل» لا تُفهم */
function errMsg(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { message?: string } } })?.response?.data?.message || fallback;
}

export default function MWarehouse({ onBack }: { onBack: () => void }) {
  const tr = useTr();
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  const [openId, setOpenId] = useState<string | null>(null); // الصنف المفتوح تفصيله
  const [entryOpen, setEntryOpen] = useState(false);         // طبقة تسجيل الحركة

  useBackClose(entryOpen, () => setEntryOpen(false));

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const stockQ = useQuery({
    queryKey: ['m-wh-stock'],
    queryFn: async () => expectArray<WhRow>((await warehouseApi.stock()).data?.data, tr('مخزون الشركة')),
  });

  const entriesQ = useQuery({
    queryKey: ['m-wh-entries'],
    queryFn: async () => expectArray<WhEntry>((await warehouseApi.entries()).data?.data, tr('سجل الوارد والتسويات')),
  });

  const all = useMemo(() => stockQ.data ?? [], [stockQ.data]);

  /* التصفية محلّية هنا — بعكس شاشة المنتجات: مسار `GET /warehouse` يحسب الرصيد
     لأصناف الشركة كلّها في ردٍّ واحد ولا يقبل وسيط بحث أصلاً، فما حُمِّل **هو**
     كلّ ما عند الخادم ولا يمكن أن تُخفي التصفيةُ صنفاً موجوداً. */
  const rows = useMemo(() => {
    const s = dq.toLowerCase();
    if (!s) return all;
    return all.filter(r => r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s));
  }, [all, dq]);

  /* الإجماليات على القائمة **كاملةً** لا على المصفّاة: بطاقةٌ مكتوبٌ عليها
     «قيمة المخزون» يجب أن تصف المستودع لا نتيجة بحثٍ عابرة، وإلا قرأ المستخدم
     قيمة صنفين وظنّها قيمة شركته. */
  const totals = useMemo(() => all.reduce((a, r) => ({
    value: a.value + r.stockValue,
    costed: a.costed + r.costedQty,
    uncosted: a.uncosted + r.uncostedQty,
  }), { value: 0, costed: 0, uncosted: 0 }), [all]);

  if (entryOpen) return <MWarehouseEntry onClose={() => setEntryOpen(false)} />;

  const searching = dq !== '';

  return (
    <MScreen
      header={
        <>
          <MHeader
            title={tr('مخزون الشركة')}
            subtitle={tr('المستودع المركزي التحميل يخرج منه والتنزيل يعود إليه والوارد يزيده')}
            onBack={onBack}
            action={
              <button onClick={() => setEntryOpen(true)} aria-label={tr('استلام بضاعة أو تسوية')}
                className="w-11 h-11 rounded-xl bg-[#E15A30] text-white flex items-center justify-center flex-shrink-0">
                <PackagePlus size={20} />
              </button>
            } />
          <div className="flex-shrink-0 bg-[#FAF7F0] p-3 pb-2">
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
              <input value={q} onChange={e => setQ(e.target.value)} className="input ps-9 min-h-[44px]"
                placeholder={tr('بحث بالاسم أو الكود')} />
            </div>
          </div>
        </>
      }>
      <div className="bg-[#FAF7F0] min-h-full p-3 pt-1 space-y-4">

        {/* ─────────── إجمال المستودع ─────────── */}
        <section className="space-y-2.5">
          {stockQ.isLoading ? (
            <MCard><div className="py-10"><MSpinner /></div></MCard>
          ) : stockQ.isError ? (
            <MCard><div className="py-10">
              <MError onRetry={() => stockQ.refetch()} text={errMsg(stockQ.error, tr('تعذر تحميل البيانات'))} />
            </div></MCard>
          ) : !all.length ? (
            <MCard><div className="py-10">
              <MEmpty icon={Warehouse} text={tr('لا توجد أصناف أضف منتجات ثم سجل استلام بضاعة')} />
            </div></MCard>
          ) : (
            <>
              {/* البطاقتان الطويلتا العنوان بعرض الشاشة: لافتة `MStat` تُقصّ بـ`truncate`،
                  و«قيمة المخزون بتكلفة الش…» لافتةٌ تُقرأ قيمةً مطلقة فتكذب */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="col-span-2">
                  <MStat icon={Wallet} label={tr('قيمة المخزون بتكلفة الشراء')} value={formatCurrency(totals.value)} />
                </div>
                <MStat icon={Boxes} label={tr('عدد الأصناف')} value={formatNumber(all.length)} />
                <MStat icon={Package} label={tr('الكمية المقيمة')} value={fmtQty(totals.costed)} />
                <div className="col-span-2">
                  <MStat icon={AlertTriangle} label={tr('كمية خارج التقييم')} value={fmtQty(totals.uncosted)}
                    tone={totals.uncosted > 0 ? 'warn' : 'default'} />
                </div>
              </div>

              {/* حدّ صدق الرقم يُقال في السطر التالي له مباشرةً لا في شاشة مساعدة */}
              {totals.uncosted > 0 ? (
                <p className="text-[11px] text-[#8A6D1F] bg-[#FDF6E7] border border-[#F0E0B8] rounded-xl px-3 py-2.5 leading-relaxed">
                  <AlertTriangle size={12} className="inline -mt-0.5 me-1" />
                  {tr('قيمة المخزون تغطي الكمية المقيمة وحدها ولا تشمل الكمية خارج التقييم وهي كمية في المستودع لا تعرف تكلفتها سجل سعر الوحدة عند الاستلام ليكتمل التقييم')}
                </p>
              ) : (
                <p className="text-[11px] text-[#6E6557] px-1 leading-relaxed">
                  {tr('كل الرصيد مقيم بتكلفة معروفة والقيمة أعلاه تغطيه كاملا')}
                </p>
              )}
              <p className="text-[11px] text-[#9A8F7E] px-1">{tr('كل قيم التكلفة قبل الضريبة')}</p>
            </>
          )}
        </section>

        {/* ─────────── أرصدة الأصناف ─────────── */}
        {!stockQ.isLoading && !stockQ.isError && all.length > 0 && (
          <section className="space-y-2.5">
            <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">
              {tr('الرصيد بالمستودع')}
            </h3>
            {!rows.length ? (
              <MCard><div className="py-10"><MEmpty icon={Package} text={tr('لا نتائج')} /></div></MCard>
            ) : (
              <MCard>
                {rows.map(r => (
                  <StockRow key={r.productId} r={r}
                    open={openId === r.productId}
                    onToggle={() => setOpenId(id => (id === r.productId ? null : r.productId))} />
                ))}
              </MCard>
            )}
            {searching && rows.length > 0 && (
              <p className="text-[11px] text-[#9A8F7E] px-1">
                {formatNumber(rows.length)} {tr('من')} {formatNumber(all.length)} {tr('صنف')}
              </p>
            )}
          </section>
        )}

        {/* ─────────── سجلّ الحركات ─────────── */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide flex items-center gap-1.5">
            <ArrowRightLeft size={13} /> {tr('سجل الوارد والتسويات')}
          </h3>
          {entriesQ.isLoading ? (
            <MCard><div className="py-10"><MSpinner /></div></MCard>
          ) : entriesQ.isError ? (
            <MCard><div className="py-10">
              <MError onRetry={() => entriesQ.refetch()} text={errMsg(entriesQ.error, tr('تعذر تحميل البيانات'))} />
            </div></MCard>
          ) : !entriesQ.data?.length ? (
            <MCard><div className="py-10">
              <MEmpty icon={ArrowRightLeft} text={tr('لا توجد حركات وارد بعد')} />
            </div></MCard>
          ) : (
            <>
              <MCard>
                {entriesQ.data.slice(0, 20).map(e => <EntryRow key={e.id} e={e} />)}
              </MCard>
              {entriesQ.data.length > 20 && (
                <p className="text-[11px] text-[#9A8F7E] px-1">{tr('يعرض أحدث الحركات')}</p>
              )}
            </>
          )}
        </section>

        <div className="h-2" />
      </div>
    </MScreen>
  );
}

/* ═══════════════════════ صفّ رصيدٍ يتوسّع بتفصيله ═══════════════════════ */

function StockRow({ r, open, onToggle }: { r: WhRow; open: boolean; onToggle: () => void }) {
  const tr = useTr();
  const tone = r.onHand < 0 ? 'text-[#C0392B]' : r.onHand === 0 ? 'text-[#B7791F]' : 'text-[#2F855A]';
  return (
    // الفاصل على الغلاف لا على `MRow`: الصفّ صار وحيد أبيه فـ`last:border-0`
    // تُسقط فاصله، فيلتصق التفصيل بالصفّ الذي يليه
    <div className="border-b border-[#F1EBDF] last:border-0">
      <MRow
        onClick={onToggle}
        title={r.name}
        subtitle={[r.code, r.unit].filter(Boolean).join(' · ')}
        trailing={
          <span className="flex items-center gap-2 flex-shrink-0">
            <span className="text-end">
              <span className={`block text-sm font-bold tabular-nums ${tone}`} dir="ltr">{fmtQty(r.onHand)}</span>
              <span className="block text-[9px] text-[#9A8F7E]">{r.unit}</span>
            </span>
            {open ? <ChevronUp size={15} className="text-[#C9BFB0]" /> : <ChevronDown size={15} className="text-[#C9BFB0]" />}
          </span>
        } />

      {open && (
        <div className="px-3.5 pb-3 -mt-0.5 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Cell label={tr('الوارد')} value={fmtQty(r.received)} />
            <Cell label={tr('تسويات')} value={signed(r.adjusted)}
              tone={r.adjusted < 0 ? 'bad' : r.adjusted > 0 ? 'good' : 'muted'} />
            <Cell label={tr('خرج للسيارات')} value={`−${fmtQty(r.loadedToVans)}`} tone="bad" />
            <Cell label={tr('عاد منها')} value={`+${fmtQty(r.returnedFromVans)}`} tone="good" />
          </div>

          <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#6E6557]">{tr('متوسط تكلفة الوحدة')}</span>
              <b className="text-[11px] text-[#1F1A13] tabular-nums" dir="ltr">
                {r.avgCost > 0 ? formatCurrency(r.avgCost, undefined, 4) : '—'}
              </b>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-[#6E6557]">{tr('قيمة الرصيد')}</span>
              <b className={`text-[11px] tabular-nums ${r.stockValue < 0 ? 'text-[#C0392B]' : 'text-[#1F1A13]'}`} dir="ltr">
                {r.costedQty !== 0 ? formatCurrency(r.stockValue) : '—'}
              </b>
            </div>
            <p className="text-[10px] text-[#9A8F7E]">{tr('قبل الضريبة')}</p>
            {/* الاستثناء على الصفّ نفسه: قيمةٌ تحتها كمّيةٌ لا تشملها تُقرأ كاملةً بلا هذا السطر */}
            {r.uncostedQty > 0 && (
              <p className="text-[10px] text-[#8A6D1F] leading-relaxed">
                <AlertTriangle size={10} className="inline -mt-0.5 me-1" />
                {fmtQty(r.uncostedQty)} {r.unit} {tr('خارج التقييم لا تعرف تكلفتها')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** إشارةٌ صريحة على التسوية: «٣» و«−٣» يفترقان في المعنى افتراقاً تامّاً */
function signed(n: number): string {
  if (n === 0) return fmtQty(0);
  return `${n < 0 ? '−' : '+'}${fmtQty(Math.abs(n))}`;
}

function Cell({ label, value, tone = 'default' }: {
  label: string; value: string; tone?: 'default' | 'good' | 'bad' | 'muted';
}) {
  const color = tone === 'good' ? 'text-[#2F855A]' : tone === 'bad' ? 'text-[#C0392B]'
    : tone === 'muted' ? 'text-[#9A8F7E]' : 'text-[#1F1A13]';
  return (
    <div className="rounded-xl bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2">
      <p className="text-[10px] text-[#9A8F7E] truncate">{label}</p>
      <p className={`text-[13px] font-bold tabular-nums ${color}`} dir="ltr">{value}</p>
    </div>
  );
}

/* ═══════════════════════ صفّ حركةٍ في السجلّ ═══════════════════════ */

function EntryRow({ e }: { e: WhEntry }) {
  const tr = useTr();
  const receive = e.type === 'RECEIVE';
  return (
    <MRow
      leading={
        <span className={`text-[10px] font-bold px-2 py-1 rounded-md flex-shrink-0 flex items-center gap-1 ${receive ? 'text-[#2F855A] bg-[#EAF6F0]' : 'text-[#6B46C1] bg-[#F3EEFB]'}`}>
          {receive ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
          {receive ? tr('وارد') : tr('تسوية')}
        </span>
      }
      title={`${formatNumber(e.items.length)} ${tr('صنف')}`}
      subtitle={[e.supplier, e.note, e.createdBy].filter(Boolean).join(' · ') || undefined}
      note={formatDate(e.createdAt)}
      trailing={e.totalCost > 0 ? (
        <span className="text-end flex-shrink-0">
          <span className="block text-xs font-bold text-[#1F1A13] whitespace-nowrap tabular-nums" dir="ltr">
            {formatCurrency(e.totalCost)}
          </span>
          {/* الإجمالي يحسبه الخادم صافياً — والوسم يمنع قراءته شاملاً */}
          <span className="block text-[9px] text-[#9A8F7E]">{tr('قبل الضريبة')}</span>
        </span>
      ) : undefined} />
  );
}

/* ═══════════════════════ تسجيل وارد أو تسوية ═══════════════════════ */

/** سطر النموذج — الكمّية والسعر نصّان: «−» و«» حالتا كتابةٍ وسيطتان يمسحهما Number */
interface FormRow {
  productId: string; name: string; unit: string;
  /** نسبة ضريبة الصنف — لازمةٌ لمعاينة الصافي حين تكون الأسعار شاملة */
  taxPct: number;
  qty: string; unitCost: string;
}

/**
 * نموذج الحركة — طبقةٌ ملء الشاشة فوق شاشة المخزون.
 *
 * **وارد** يزيد المستودع بكمّياتٍ موجبة ويقبل سعر وحدة، و**تسوية** جردٌ أو تالف
 * بكمّيةٍ موجبة أو سالبة **بلا سعر** (الخادم يرفض سعراً مع تسوية رفضاً صريحاً،
 * فلا نُرسله أصلاً).
 */
function MWarehouseEntry({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [type, setType] = useState<'RECEIVE' | 'ADJUST'>('RECEIVE');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState<FormRow[]>([]);
  // فاتورة المورّد تُعلن السعر شاملاً الضريبة غالباً؛ المؤشّر يُخبر الخادم فيردّه
  // إلى صافيه قبل الحفظ — فيبقى للعمود معنى واحد مهما اختلفت عادة المورّدين
  const [costsIncludeTax, setCostsIncludeTax] = useState(false);
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const prodQ = useQuery({
    queryKey: ['m-wh-products', dq],
    queryFn: async () => {
      // المفتاح الفارغ يُحذف لا يُرسَل نصّاً فارغاً — الخادم يقرؤه بحثاً عن «»
      const params: Record<string, string | number> = { limit: 30 };
      if (dq) params.search = dq;
      return expectArray<ProductPick>((await productApi.list(params)).data?.data, tr('الأصناف'));
    },
  });

  const addProduct = (p: ProductPick) => {
    if (rows.some(r => r.productId === p.id)) return;  // تكرار الصنف يُنشئ بندين متنازعين
    setRows(rs => [...rs, {
      productId: p.id, name: p.name, unit: p.unit || '',
      taxPct: typeof p.taxPct === 'number' ? p.taxPct : 0,
      qty: '1', unitCost: '',
    }]);
  };
  const patch = (id: string, k: 'qty' | 'unitCost', v: string) =>
    setRows(rs => rs.map(r => (r.productId === id ? { ...r, [k]: v } : r)));
  const dropRow = (id: string) => setRows(rs => rs.filter(r => r.productId !== id));

  /** صافي سعر الوحدة كما سيُخزَّن — الخادم يستخرج الضريبة بنسبة كلّ صنف لا بنسبةٍ موحّدة */
  const netOf = (r: FormRow): number | null => {
    const c = Number(r.unitCost);
    if (r.unitCost.trim() === '' || !Number.isFinite(c) || c <= 0) return null;
    return costsIncludeTax && r.taxPct > 0 ? c / (1 + r.taxPct / 100) : c;
  };

  /**
   * قيمة البضاعة المستلمة — **صافيةً قبل الضريبة دائماً** ليطابق المعروضُ ما
   * سيُخزَّن فعلاً. فلو عُرضت شاملةً حين يؤشّر المستخدم «شاملة الضريبة» لرأى
   * رقماً في الشاشة وقرأ غيره في التقرير، وهو أسوأ من ألّا يُعرض شيء.
   */
  const total = type !== 'RECEIVE' ? 0 : rows.reduce((s, r) => {
    const qty = Number(r.qty);
    const net = netOf(r);
    return net === null || !Number.isFinite(qty) ? s : s + qty * net;
  }, 0);

  const qtyBad = (r: FormRow) => {
    const n = Number(r.qty);
    if (r.qty.trim() === '' || !Number.isFinite(n) || n === 0) return true;
    return type === 'RECEIVE' && n < 0;   // الوارد موجبٌ دائماً؛ التنقيص تسويةٌ صريحة
  };
  /* سعرٌ مكتوبٌ غير موجب يُرفض هنا لا يُسقَط صامتاً: الخادم لا يقبل إلا موجباً،
     وإسقاطُ «٠» أو «−٥» بصمت يحفظ الكمّية بلا تكلفة ويظنّها المستخدم مسعَّرة.
     والخانة الفارغة وحدها تعني «بلا سعر» — ومعناها معلنٌ تحت الحقل. */
  const costBad = (r: FormRow) => {
    if (type !== 'RECEIVE' || r.unitCost.trim() === '') return false;
    const c = Number(r.unitCost);
    return !Number.isFinite(c) || c <= 0 || c > 1e9;
  };

  const valid = rows.length > 0 && rows.every(r => !qtyBad(r) && !costBad(r));

  const save = useMutation({
    mutationFn: async () => {
      const items = rows.map(r => {
        const item: { productId: string; qty: number; unitCost?: number } = {
          productId: r.productId, qty: Number(r.qty),
        };
        // السعر للوارد وحده، والفارغ يُرسَل **غائباً** لا صفراً: «بلا سعر» كمّيةٌ
        // خارج التقييم، بينما صفرٌ بضاعةٌ مجّانية — ومعناهما في الدفاتر مختلف
        if (type === 'RECEIVE' && r.unitCost.trim() !== '') item.unitCost = Number(r.unitCost);
        return item;
      });
      await warehouseApi.createEntry({
        type,
        supplier: type === 'RECEIVE' ? supplier.trim() || undefined : undefined,
        note: note.trim() || undefined,
        costsIncludeTax: type === 'RECEIVE' ? costsIncludeTax : undefined,
        items,
      });
    },
    onSuccess: () => {
      // مفاتيح الجوال ومفاتيح اللوحة معاً — الحزمة واحدة والكاش مشترك، فترك
      // مفاتيح اللوحة يُظهر رصيداً قديماً لمن ينتقل إليها بعد الحفظ
      ['m-wh-stock', 'm-wh-entries', 'warehouse-stock', 'warehouse-entries']
        .forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(tr('تم حفظ الحركة'));
      onClose();
    },
    onError: (e: unknown) => toast.error(errMsg(e, tr('تعذر الحفظ'))),
  });

  const receive = type === 'RECEIVE';

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader title={tr('استلام بضاعة أو تسوية')} subtitle={tr('مخزون الشركة')} onBack={onClose} />

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-4">

        {/* ─────────── نوع الحركة ─────────── */}
        <div className="grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => setType('RECEIVE')}
            className={`min-h-[48px] rounded-xl border text-sm font-bold flex items-center justify-center gap-2 ${receive ? 'border-[#2F855A] bg-[#EAF6F0] text-[#2F855A]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
            <TrendingUp size={16} /> {tr('وارد')}
          </button>
          <button type="button" onClick={() => setType('ADJUST')}
            className={`min-h-[48px] rounded-xl border text-sm font-bold flex items-center justify-center gap-2 ${!receive ? 'border-[#6B46C1] bg-[#F3EEFB] text-[#6B46C1]' : 'border-[#E9E1D3] bg-white text-[#6E6557]'}`}>
            <TrendingDown size={16} /> {tr('تسوية')}
          </button>
        </div>
        <p className="text-[11px] text-[#9A8F7E] px-1 -mt-2 leading-relaxed">
          {receive
            ? tr('الوارد استلام أو شراء يزيد المستودع بكميات موجبة')
            : tr('التسوية تقبل موجبا زيادة أو سالبا نقص للجرد والتالف')}
        </p>

        {/* ─────────── المورّد ─────────── */}
        {receive && (
          <section className="space-y-2.5">
            <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('المورد اختياري')}</h3>
            <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3">
              <input className="input min-h-[44px]" value={supplier} maxLength={200}
                placeholder={tr('اسم المورد')} onChange={e => setSupplier(e.target.value)} />
            </div>
          </section>
        )}

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
                  const picked = rows.some(r => r.productId === p.id);
                  return (
                    <MRow key={p.id}
                      title={p.name}
                      subtitle={[p.code, p.unit].filter(Boolean).join(' · ') || undefined}
                      // صفٌّ مضافٌ سلفاً لا يُنقر: نقرةٌ لا أثر لها تُقرأ عطلاً
                      onClick={picked ? undefined : () => addProduct(p)}
                      trailing={picked
                        ? <span className="text-[10px] font-bold text-[#2F855A] flex-shrink-0">{tr('مضاف')}</span>
                        : <Plus size={17} className="text-[#E15A30] flex-shrink-0" />} />
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
              const badQty = qtyBad(r);
              const badCost = costBad(r);
              const net = netOf(r);
              const qty = Number(r.qty);
              const line = receive && net !== null && Number.isFinite(qty) ? qty * net : null;
              return (
                <div key={r.productId} className="p-3 space-y-2 border-b border-[#F1EBDF] last:border-0">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                      {r.unit && <span className="block text-[11px] text-[#9A8F7E] truncate mt-0.5">{r.unit}</span>}
                    </span>
                    <button onClick={() => dropRow(r.productId)} aria-label={tr('حذف')}
                      className="p-2.5 -m-1 rounded-xl text-[#C0392B] active:bg-[#FDF2F0]">
                      <Trash2 size={16} />
                    </button>
                  </div>

                  <div className="flex items-end gap-2">
                    <label className="flex-1 min-w-0">
                      <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('الكمية')}</span>
                      <input className={`input text-center min-h-[44px] text-base font-bold ${badQty ? 'border-[#E4B76A]' : ''}`}
                        dir="ltr" type="number" inputMode="decimal" step="any"
                        placeholder={receive ? '0' : '±'}
                        value={r.qty} onChange={e => patch(r.productId, 'qty', e.target.value)} />
                    </label>
                    {receive && (
                      <label className="flex-1 min-w-0">
                        <span className="block text-[10px] text-[#9A8F7E] mb-1">{tr('سعر الوحدة')}</span>
                        <input className={`input text-center min-h-[44px] ${badCost ? 'border-[#C0392B]' : ''}`}
                          dir="ltr" type="number" inputMode="decimal" step="any" min="0"
                          placeholder={tr('اختياري')}
                          value={r.unitCost} onChange={e => patch(r.productId, 'unitCost', e.target.value)} />
                      </label>
                    )}
                  </div>

                  {badQty && (
                    <p className="text-[10px] text-[#B7791F]">
                      {receive ? tr('كمية الوارد يجب أن تكون موجبة') : tr('اكتب كمية غير صفرية موجبة أو سالبة')}
                    </p>
                  )}
                  {badCost && <p className="text-[10px] text-[#C0392B]">{tr('سعر الوحدة يجب أن يكون أكبر من صفر أو يترك فارغا')}</p>}
                  {receive && !badCost && r.unitCost.trim() === '' && (
                    // أثرُ ترك الخانة فارغة يُقال قبل الحفظ لا بعده
                    <p className="text-[10px] text-[#9A8F7E]">{tr('بلا سعر تدخل الكمية المخزون خارج التقييم')}</p>
                  )}
                  {line !== null && (
                    <p className="text-[10px] text-[#6E6557]">
                      {tr('قيمة السطر قبل الضريبة')}: <b className="text-[#1F1A13] tabular-nums">{formatCurrency(line)}</b>
                    </p>
                  )}
                </div>
              );
            })}
          </MCard>
        </section>

        {/* ─────────── الأسعار والضريبة ─────────── */}
        {receive && (
          <section className="space-y-2.5">
            <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3 space-y-2.5">
              <label className="flex items-center gap-2.5 min-h-[44px] cursor-pointer">
                <input type="checkbox" checked={costsIncludeTax} className="w-5 h-5 accent-[#E15A30] flex-shrink-0"
                  onChange={e => setCostsIncludeTax(e.target.checked)} />
                <span className="text-sm font-semibold text-[#1F1A13]">{tr('الأسعار المدخلة شاملة الضريبة')}</span>
              </label>
              {/* السطر الحاكم: المستخدم يجب أن يعرف أيّ رقمٍ يكتب وأيّ رقمٍ يُخزَّن */}
              <p className="text-[11px] text-[#B7791F] leading-relaxed flex items-start gap-1">
                <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                {tr('المخزن صافي قبل الضريبة دائما فإن كان سعر فاتورة المورد شاملا فأشر هنا ليرده النظام إلى صافيه قبل الحفظ')}
              </p>
            </div>
          </section>
        )}

        {/* ─────────── ملاحظة ─────────── */}
        <section className="space-y-2.5">
          <h3 className="text-[11px] font-bold text-[#9A8F7E] px-1 uppercase tracking-wide">{tr('ملاحظة اختياري')}</h3>
          <div className="bg-white rounded-2xl border border-[#F1EBDF] p-3">
            <input className="input min-h-[44px]" value={note} maxLength={300}
              placeholder={tr('مثال فاتورة شراء رقم جرد')} onChange={e => setNote(e.target.value)} />
          </div>
        </section>

        <div className="h-2" />
      </div>

      {/* شريط الحفظ ثابتٌ أسفل الشاشة: نموذجٌ طويل وزرُّ حفظٍ في قاعه لا يُرى */}
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {receive && total > 0 && (
          <p className="text-[11px] text-[#6E6557] mb-2 px-0.5 flex items-center justify-between gap-2">
            <span>{tr('قيمة البضاعة المستلمة قبل الضريبة')}</span>
            <b className="text-[#1F1A13] tabular-nums">{formatCurrency(total)}</b>
          </p>
        )}
        <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
          className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
          {save.isPending ? <Loader2 size={16} className="animate-spin" /> : <PackagePlus size={16} />}
          {tr('حفظ الحركة')}
        </button>
      </div>
    </div>
  );
}
