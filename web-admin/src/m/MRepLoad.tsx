import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search, Plus, Trash2, Loader2, Package, Truck, Sparkles, AlertTriangle,
  ArrowDownToLine, TrendingDown, Download,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { vanStockApi, productApi } from '../api/client';
import { SalesRep } from '../types';
import { formatDate, formatTime, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useBackClose } from '../lib/useBackClose';
import { splitVanMovement } from '../lib/vanMovement';
import { MCard, MRow, MStat, MHeader, MEmpty, MError, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';

/**
 * تسجيل تحميل بضاعة لسيارة مندوب — من تطبيق الإدارة على الجوال.
 *
 * ⚠️ **الإشارة**: الموجب تحميلٌ للسيارة والسالب تنزيلٌ للمستودع، والنوعان
 * يقرآن الإشارة **عكسياً** في الخادم. فالتقسيم والقلب يُتركان لـ`splitVanMovement`
 * وحدها (اقرأ تعليقاتها) — منطقُ تقسيمٍ ثانٍ هنا يعني قاعدتين تتباعدان مع
 * الوقت، وأثرُ خطئه صامت: رصيدُ سيارةٍ ينقلب في الاتجاه المعاكس بلا رسالة.
 *
 * ولماذا الكمّية إدخالٌ حرّ لا أزرار ±١: التحميل الصباحي خمسون كرتوناً، وخمسون
 * نقرة في المستودع تعني أن يُكتَب الرقم في دفتر ورقيّ بدل التطبيق.
 */

interface StockRow {
  productId: string; name: string; code: string; unit: string;
  loaded: number; unloaded: number; adjusted: number; sold: number; returned: number; remaining: number;
}

interface ProductPick { id: string; name: string; code?: string; unit?: string }

/** استجابة /van-stock/suggest — تطابق SuggestResult في الخادم */
interface SuggestRow {
  id: string; name: string; code: string; unit: string;
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

interface Movement {
  kind: string; date: string; ref: string; by: string | null;
  items: { name: string; unit: string; qty: number }[];
}

/** سطر النموذج — الكمّية نصّ لا رقم: «-» و«» حالتا كتابةٍ وسيطتان يمسحهما Number */
interface Row {
  productId: string; name: string; unit: string; qty: string;
  suggestedQty?: number; expectedQty?: number;
}

const KIND_META: Record<string, { label: string; cls: string; sign: string }> = {
  LOAD: { label: 'تحميل', cls: 'text-[#2F855A] bg-[#EAF6F0]', sign: '+' },
  SALE: { label: 'بيع', cls: 'text-[#C94E28] bg-[#FBEBE2]', sign: '−' },
  RETURN: { label: 'مرتجع', cls: 'text-[#2B6CB0] bg-[#EBF2FA]', sign: '+' },
  UNLOAD: { label: 'تنزيل للمستودع', cls: 'text-[#B7791F] bg-[#FDF6E7]', sign: '−' },
  ADJUST: { label: 'تسوية', cls: 'text-[#6B46C1] bg-[#F3EEFB]', sign: '±' },
};

/* إشعار الحركة في حزمة مستقلّة — يجرّ jspdf وhtml2canvas وqrcode معه */
const MLoadNoticeDoc = lazy(() => import('./MLoadNoticeDoc'));

/** الحركات التي لها إشعارٌ يُطبع: حركات السيارة وحدها لا المبيعات والمرتجعات،
 *  فتلك مستنداتها فواتيرُ وسندات لا إشعارُ مخزون — وهو تمييز اللوحة نفسه. */
const EXPORTABLE = ['LOAD', 'UNLOAD', 'ADJUST'];

/** كسورٌ محتملة في الوحدات الموزونة — لكن بلا أصفارٍ زائدة على «١٢» */
const fmtQty = (n: number) => formatNumber(Number(n.toFixed(2)));

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
    queryKey: ['m-van-movements', rep.id],
    queryFn: async () => expectArray<Movement>(
      (await vanStockApi.movements(rep.id)).data?.data, tr('حركة البضاعة ماذا نزل ومتى')),
  });

  /** رصيد الصنف في السيارة الآن — يُعرض على سطره فلا يُحمَّل ما لم ينفد */
  const remainingOf = useMemo(() => {
    const m = new Map<string, number>();
    (stockQ.data ?? []).forEach(s => m.set(s.productId, s.remaining));
    return (id: string) => m.get(id) ?? 0;
  }, [stockQ.data]);

  const totalRemaining = (stockQ.data ?? []).reduce((s, r) => s + r.remaining, 0);

  // المصدر الوحيد للتقسيم — الواجهة تعرضه والحفظ يرسله، فلا يختلف المعروض عن المُرسَل
  const split = useMemo(
    () => splitVanMovement(rows.map(r => ({
      productId: r.productId, qty: Number(r.qty),
      suggestedQty: r.suggestedQty, expectedQty: r.expectedQty,
    }))),
    [rows],
  );
  const hasMovement = split.out.length > 0 || split.back.length > 0;

  const addProduct = (p: ProductPick) => {
    if (rows.some(r => r.productId === p.id)) return;   // تكرار الصنف يُنشئ بندين متنازعين
    setRows(rs => [...rs, { productId: p.id, name: p.name, unit: p.unit || '', qty: '1' }]);
  };
  const addFromStock = (s: StockRow) => {
    if (rows.some(r => r.productId === s.productId)) return;
    setRows(rs => [...rs, { productId: s.productId, name: s.name, unit: s.unit, qty: '1' }]);
  };
  const patchQty = (id: string, v: string) => setRows(rs => rs.map(r => r.productId === id ? { ...r, qty: v } : r));
  const flipSign = (id: string) => setRows(rs => rs.map(r => {
    if (r.productId !== id) return r;
    const n = Number(r.qty);
    return { ...r, qty: Number.isFinite(n) ? String(-n) : r.qty };
  }));
  const dropRow = (id: string) => setRows(rs => rs.filter(r => r.productId !== id));

  /** يملأ النموذج بما يستحقّ تحميلاً فقط — الأصفار ضجيجٌ لا اقتراح */
  const applySuggestion = () => {
    const list = (suggestQ.data?.rows ?? []).filter(r => r.suggested > 0);
    if (!list.length) { toast.error(tr('لا يوجد ما يقترح تحميله')); setConfirm(null); return; }
    setRows(list.map(r => ({
      productId: r.id, name: r.name, unit: r.unit,
      qty: String(r.suggested), suggestedQty: r.suggested,
      // التنبّؤ اليومي مرجعُ قياس الدقّة لا suggestedQty: الأخيرة كمّية تعبئة
      // تتأثّر بما في السيارة وبالهامش، فقياسُها يعاقب المحرّك على ما ليس تنبّؤاً
      expectedQty: r.expected,
    })));
    setShowSuggest(false);
    setConfirm(null);
    toast.success(tr('طبق الاقتراح راجع الكميات قبل الحفظ'));
  };

  const save = useMutation({
    mutationFn: async () => {
      const { out, back } = split;
      const trimmed = note.trim() || undefined;
      if (out.length) {
        await vanStockApi.createLoad({ salesRepId: rep.id, type: 'LOAD', note: trimmed, items: out });
        // وثيقة التحميل كُتبت فعلاً: تُسقَط أسطرها فوراً كي لا تُكتب مرّتين لو
        // سقط التنزيل بعدها وأعاد المستخدم المحاولة
        setRows(rs => rs.filter(r => !(Number(r.qty) > 0)));
      }
      if (back.length) {
        await vanStockApi.createLoad({ salesRepId: rep.id, type: 'UNLOAD', note: trimmed, items: back });
      }
    },
    onSuccess: () => {
      invalidateVanStock();
      toast.success(tr('تم حفظ الحركة'));
      setRows([]);
      setNote('');
      setConfirm(null);
    },
    onError: (e: unknown) => {
      // حتى الفشل يُبطِل المفاتيح: الشقّ الأوّل من الحركة المختلطة قد يكون كُتب،
      // وعرضُ رصيدٍ قديم بعده يخفي عن المستخدم ما صار في السيارة حقّاً
      invalidateVanStock();
      toast.error(errMsg(e, tr('تعذر الحفظ')));
      setConfirm(null);
    },
  });

  function invalidateVanStock() {
    // مفاتيح الجوال ومفاتيح اللوحة معاً — الحزمة واحدة والكاش مشترك، فترك
    // مفاتيح اللوحة يُظهر للأدمن رصيداً قديماً حين ينتقل إليها
    ['m-van-current', 'm-van-movements', 'm-van-suggest', 'van-summary', 'van-current', 'van-movements']
      .forEach(k => qc.invalidateQueries({ queryKey: [k] }));
  }

  const onSave = () => {
    if (!hasMovement) return;
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
                <MStat icon={Truck} label={tr('المتبقي')} value={fmtQty(totalRemaining)}
                  tone={totalRemaining > 0 ? 'good' : 'default'} />
              </div>
              <MCard className="overflow-hidden">
                {/* تمريرٌ داخليّ: قائمة أصنافٍ طويلة كانت ستدفع النموذج خارج الشاشة */}
                <div className="max-h-[250px] overflow-y-auto overscroll-contain">
                  {stockQ.data.map(s => {
                    const picked = rows.some(r => r.productId === s.productId);
                    return (
                      <MRow key={s.productId}
                        title={s.name}
                        subtitle={`${s.code} · ${s.unit}`}
                        // صفٌّ مضافٌ سلفاً لا يُنقر: نقرةٌ لا أثر لها تُقرأ عطلاً
                        onClick={picked ? undefined : () => addFromStock(s)}
                        trailing={(
                          <span className="flex items-center gap-2 flex-shrink-0">
                            <span className={`text-sm font-bold tabular-nums ${s.remaining < 0 ? 'text-[#C0392B]' : s.remaining === 0 ? 'text-[#9A8F7E]' : 'text-[#2F855A]'}`}>
                              {fmtQty(s.remaining)}
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
                                  <b className="text-sm text-[#E15A30] tabular-nums">{fmtQty(r.suggested)}</b>
                                  <span className="text-[10px] text-[#9A8F7E]">{r.unit}</span>
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
                  const picked = rows.some(r => r.productId === p.id);
                  return (
                    <MRow key={p.id}
                      title={p.name}
                      subtitle={[p.code, p.unit].filter(Boolean).join(' · ') || undefined}
                      onClick={picked ? undefined : () => addProduct(p)}
                      trailing={(
                        <span className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-[11px] text-[#9A8F7E] tabular-nums">
                            {fmtQty(remainingOf(p.id))}
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
              const n = Number(r.qty);
              const neg = Number.isFinite(n) && n < 0;
              const zero = !Number.isFinite(n) || n === 0;
              return (
                <div key={r.productId} className="p-3 space-y-2 border-b border-[#F1EBDF] last:border-0">
                  <div className="flex items-start gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[#1F1A13] truncate">{r.name}</span>
                      <span className="block text-[11px] text-[#9A8F7E] truncate mt-0.5">
                        {tr('المتبقي')} {fmtQty(remainingOf(r.productId))}{r.unit ? ` ${r.unit}` : ''}
                      </span>
                      {/* وسمُ الاتجاه على السطر نفسه: الإشارة وحدها تُقرأ خطأً في عجلة المستودع */}
                      <span className={`inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-md ${neg ? 'text-[#B7791F] bg-[#FDF6E7]' : zero ? 'text-[#9A8F7E] bg-[#F5F1E9]' : 'text-[#2F855A] bg-[#EAF6F0]'}`}>
                        {neg ? tr('تنزيل للمستودع') : zero ? tr('لا حركة') : tr('تحميل')}
                      </span>
                    </span>
                    <button onClick={() => dropRow(r.productId)} aria-label={tr('حذف')}
                      className="p-2.5 -m-1 rounded-xl text-[#C0392B] active:bg-[#FDF2F0]">
                      <Trash2 size={16} />
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => flipSign(r.productId)}
                      aria-label={tr('عكس الإشارة تحميل/تنقيص')}
                      className="w-11 h-11 flex-shrink-0 rounded-xl border border-[#E9E1D3] bg-white text-lg font-bold text-[#6E6557] active:bg-[#F1EBDF]">
                      ±
                    </button>
                    {/* إدخالٌ حرّ: خمسون كرتوناً رقمٌ يُكتب لا خمسون نقرة */}
                    <input className={`input flex-1 text-center min-h-[44px] text-base font-bold ${neg ? 'border-[#E4B76A] text-[#B7791F]' : ''}`}
                      dir="ltr" type="number" inputMode="decimal" step="any"
                      value={r.qty} onChange={e => patchQty(r.productId, e.target.value)} />
                  </div>

                  {r.suggestedQty !== undefined && (
                    <p className="text-[10px] text-[#9A8F7E] px-0.5">
                      {tr('التحميل المقترح')} {fmtQty(r.suggestedQty)}
                    </p>
                  )}
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
                return (
                  <MRow key={`${m.date}-${i}`}
                    leading={(
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-md flex-shrink-0 ${meta.cls}`}>
                        {tr(meta.label)}
                      </span>
                    )}
                    title={`${meta.sign}${fmtQty(Math.abs(qty))} · ${m.items.length} ${tr('صنف')}`}
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
        <button onClick={onSave} disabled={!hasMovement || save.isPending}
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
