import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Minus, Trash2, ShoppingCart, Loader2, Check, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { customerApi, productApi, salesRepApi, invoiceApi, lotsApi } from '../api/client';
import { formatCurrency, formatDate, formatNumber } from '../utils/format';
import { useTr } from '../i18n/strings';
import { useAuthStore } from '../store/authStore';
import { MHeader, MSpinner } from './mobileUi';
import { expectArray, expectObject } from './shape';
import { lineTotal, invoiceTotals, type Line } from './docMath';
import { previewInstallments, defaultFirstDue, MAX_INSTALLMENTS, type InstallmentPeriod } from '../lib/installments';
import { unitChoices, defaultChoice, choiceNet, invoiceItemUnit, type UnitChoice } from '../rep/repUnits';
import { lineKey, addInvoiceLine, setInvoiceLineUnit, stepInvoiceLine, refreshInvoiceLines, qtyText, type SalePick } from './mUnits';
import {
  lotErrorOf, lotFlagsOf, lotWarningsOf, LOT_WARNING_LABELS, type LotWarning, type VanLotSnapshotDto,
} from '../lib/lots';
import { lotErrorText } from '../lib/invoiceLots';
import { vanAvailableOf, vanLotShortages, LOT_CACHE_KEYS } from './mLotsLogic';
import { can } from './perms';
import MUnitChips from './MUnitChips';

interface Pick { id: string; name: string; code?: string; phone?: string; basePrice?: number; taxPct?: number; unit?: string }

/**
 * إنشاء فاتورة من الجوال — على نمط شاشة المندوب بصرياً، **وبدلالة الأدمن حسابياً**.
 *
 * فرقان جوهريان عن شاشة المندوب:
 *  1. **اختيار المندوب إلزاميّ** — لا مقابل له عند المندوب (هو نفسه).
 *  2. **السعر قبل الضريبة** (`product.basePrice`) — راجع `docMath.ts`.
 *
 * والوحدات المتعددة: البند **بوحدته** (كرتون أو حبة) وسعرُه سعرها صافياً، ومفتاحه الصنف مع الوحدة — فكرتونٌ وحبّةٌ من
 * الصنف نفسه بندان، ونقرة «+ حبة» لا تزيد بند الكرتون. والجسم يحمل `unitId` ولقطة الوحدة (`invoiceItemUnit`) فيحلّ
 * الخادم المعامل بنفسه، ويردّ قائمةً قديمة على الشاشة بـ400 UNIT_INVALID بدل أن يقيّد غير ما رآه المستخدم.
 * والحساب كلّه في `mUnits.ts` (مختبَر) — صنفٌ بلا وحدات بندُه وشاشته كما قبل الميزة حرفاً.
 *
 * وثلاث خطوات لا شاشة واحدة: العميل ← الأصناف ← المراجعة. نموذجٌ واحد طويل
 * على الجوال يعني تمريراً لا ينتهي وأخطاءً لا تُرى.
 *
 * ═══ «تتبّع اللوط» (الميزة مفعّلة للشركة وحدها) ═══
 * التوزيع على التشغيلات FEFO **في الخادم** تحت القفل، فلا حقل تشغيلةٍ هنا ولا نقرة: الجسم كما كان حرفاً. والصنف المتتبَّع
 * ممنوعٌ من البيع فوق رصيد تشغيلات سيارة المندوب أيّاً كان «البيع بدون مخزون» (R3)، فيُعرض متاحه من لقطة السيارة
 * (`/van-stock/lot-balances`، المفتاح نفسه في MRepLoad) تنبيهاً قبل الإصدار لا منعاً — والقرار للخادم. واللقطة تُجلب حين
 * في البنود صنفٌ متتبَّع وللمستخدم صلاحية مخزون السيارات وحدهما. والردّ يحمل تحذيرات التوزيع (warnings) فتُقال، والرفض
 * برمزه (LOT_STOCK_INSUFFICIENT وLOT_BUSY) يُشرح بلغة الواجهة (lotErrorText). والورقة بعد الإصدار تُجلب بتشغيلاتها
 * (MDocScreen، withLots).
 */
type Step = 'head' | 'items' | 'review';

/** علم الصنف من قائمة الأصناف (productApi.list يعيد الأعمدة كلّها) — ولا أثر له والميزة مطفأة */
const lotTrackedOf = (p: SalePick | undefined): boolean => (p as { lotTracked?: boolean } | undefined)?.lotTracked === true;

export default function MInvoiceCreate({ presetCustomerId, onClose, onCreated, company }: {
  presetCustomerId?: string;
  onClose: () => void;
  onCreated: (invoiceId: string) => void;
  /** إعدادات الشركة (ردّ /company) — لعلم «تتبّع اللوط» وحده؛ غيابها إطفاء فالشاشة كما كانت حرفاً */
  company?: unknown;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const user = useAuthStore(s => s.user);
  const lotOn = lotFlagsOf(company as { lotTrackingEnabled?: unknown } | null).on;
  const [step, setStep] = useState<Step>('head');
  const [customerId, setCustomerId] = useState(presetCustomerId || '');
  const [salesRepId, setSalesRepId] = useState('');
  const [type, setType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  // «تقسيط» خطة سداد فوق البيع الآجل لا نوع محاسبي ثالث
  const [plan, setPlan] = useState<'IMMEDIATE' | 'INSTALLMENT'>('IMMEDIATE');
  const [insCount, setInsCount] = useState(3);
  const [insFirst, setInsFirst] = useState(defaultFirstDue());
  const [insPeriod, setInsPeriod] = useState<InstallmentPeriod>('MONTHLY');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [discountPct, setDiscountPct] = useState(0);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  // أصناف البنود بوحداتها — قائمة البحث تتبدّل مع كل حرف، ومنتقي وحدة البند وإعادة تسعيره يحتاجان صنفه بعد ذلك
  const [catalog, setCatalog] = useState<Record<string, SalePick>>({});
  const [pq, setPq] = useState('');
  const [cq, setCq] = useState('');

  const customersQ = useQuery({
    queryKey: ['m-inv-customers', cq],
    queryFn: async () => expectArray<Pick>((await customerApi.list({ search: cq, limit: 40 })).data?.data, tr('العملاء')),
    enabled: step === 'head',
  });
  const repsQ = useQuery({
    queryKey: ['m-inv-reps'],
    queryFn: async () => expectArray<Pick>((await salesRepApi.list({ limit: 200 })).data?.data, tr('المناديب')),
    enabled: step === 'head',
  });
  const productsQ = useQuery({
    queryKey: ['m-inv-products', pq],
    queryFn: async () => expectArray<SalePick>((await productApi.list({ search: pq, limit: 60 })).data?.data, tr('الأصناف')),
    enabled: step === 'items',
  });

  // صنفٌ في البنود يعود في قائمةٍ أحدث (بعد 400 UNIT_INVALID مثلاً) ⇒ تُحدَّث وحداته في منتقي بنده، ولقطة بنوده تُحلّ
  // من جديد (refreshInvoiceLines): بلاها يبقى البند بأساسٍ لم يعد قائماً فيرفضه الخادم مرّةً بعد مرّة
  useEffect(() => {
    const fresh = productsQ.data;
    if (!fresh?.length) return;
    const inLines = new Set(lines.map(l => l.productId));
    const hit = fresh.filter(p => inLines.has(p.id) && catalog[p.id] !== p);
    if (!hit.length) return;
    setCatalog(c => ({ ...c, ...Object.fromEntries(hit.map(p => [p.id, p])) }));
    setLines(ls => hit.reduce((acc, p) => refreshInvoiceLines(acc, p), ls));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- القائمة الجديدة وحدها تُطلق التحديث، لا كل تعديلٍ في البنود
  }, [productsQ.data]);

  /* «تتبّع اللوط»: لقطة تشغيلات سيارة المندوب — حين الميزة مفعّلة وفي البنود صنفٌ متتبَّع وللمستخدم صلاحية مخزون السيارات
   * (مسار /van-stock خلفها). المطفأة أو البنود بلا متتبَّع: لا طلب (§١٠.١) */
  const hasLotLine = lotOn && lines.some(l => lotTrackedOf(catalog[l.productId]));
  const snapQ = useQuery({
    queryKey: ['m-van-lots', salesRepId],
    enabled: hasLotLine && !!salesRepId && step !== 'head' && can(user, 'canManageVanStock'),
    staleTime: 15_000,
    // رفضٌ صريح (٤٠٣ صلاحية أو علم، ٤٠٤ مندوب) لا يتغيّر بالإعادة — والتنبيه يسقط بصمت فالخادم يحكم عند الإصدار
    retry: (n, e) => {
      const s = (e as { response?: { status?: number } } | null)?.response?.status ?? 0;
      return !(s >= 400 && s < 500) && n < 2;
    },
    queryFn: async () => expectObject<VanLotSnapshotDto>((await lotsApi.vanLotBalances(salesRepId)).data?.data, tr('التشغيلات')),
  });
  const snap = hasLotLine ? snapQ.data ?? null : null;
  const shortages = useMemo(() => vanLotShortages(lines, snap), [lines, snap]);

  const totals = useMemo(() => invoiceTotals(lines, discountPct), [lines, discountPct]);
  // معاينة جدول الأقساط — والخادم يكتب الحقيقي من إجماليّه
  const insPreview = useMemo(
    () => (plan === 'INSTALLMENT' ? previewInstallments(totals.total, insCount, insFirst, insPeriod) : []),
    [plan, totals.total, insCount, insFirst, insPeriod],
  );
  const customer = customersQ.data?.find(c => c.id === customerId);

  /** إضافة الصنف بوحدة (الافتراض أكبر وحدة): بندٌ قائم بالوحدة نفسها يزيد واحداً — والسعر ⚠️ **قبل** الضريبة (mUnits.invoiceLine) */
  const addProduct = (p: SalePick, c?: UnitChoice) => {
    setCatalog(m => (m[p.id] === p ? m : { ...m, [p.id]: p }));
    setLines(ls => addInvoiceLine(ls, p, c));
  };
  // البند بمفتاحه (الصنف + الوحدة) لا بالصنف وحده: بندا الكرتون والحبّة يُعدَّلان ويُحذفان كلٌّ وحده
  const setQty = (key: string, d: number) => setLines(ls => stepInvoiceLine(ls, key, d));
  const patch = (key: string, k: 'unitPrice' | 'discountPct', v: number) =>
    setLines(ls => ls.map(l => lineKey(l) === key ? { ...l, [k]: v } : l));
  /** تبديل وحدة البند يعيد تسعيره بسعر الوحدة الجديدة — سعر الحبّة على بندٍ صار كرتوناً خسارةٌ صامتة */
  const switchUnit = (key: string, p: SalePick, unitId: string | null) => {
    const c = unitChoices(p).find(o => o.id === unitId);
    if (c) setLines(ls => setInvoiceLineUnit(ls, key, p, c));
  };

  const save = useMutation({
    mutationFn: async () => {
      const res = await invoiceApi.create({
        customerId, salesRepId, type, discountPct,
        ...(notes.trim() && { notes: notes.trim() }),
        ...(invoiceDate && { invoiceDate }),
        ...(plan === 'INSTALLMENT' && {
          paymentPlan: 'INSTALLMENT',
          installmentPlan: { count: insCount, firstDueDate: insFirst, period: insPeriod },
        }),
        items: lines.map(l => ({
          productId: l.productId, qty: l.qty,
          unitPrice: l.unitPrice, discountPct: l.discountPct, taxPct: l.taxPct,
          // وحدة البند ولقطتها كما رآها المستخدم — الخادم يحلّ المعامل بالمعرّف ويرفض لقطةً قديمة (UNIT_INVALID)
          ...invoiceItemUnit(l),
        })),
      });
      // «تتبّع اللوط»: تحذيرات التوزيع (تشغيلتان، وحدةٌ مقسومة، رصيدٌ غير مسمّى) — تأتي مع الميزة المفعّلة وحدها
      const body = res.data as { data: { id: string }; warnings?: unknown };
      return { inv: body.data, warnings: lotWarningsOf(body.warnings) };
    },
    onSuccess: ({ inv, warnings }: { inv: { id: string }; warnings: LotWarning[] }) => {
      qc.invalidateQueries({ queryKey: ['m-docs', 'invoice'] });
      qc.invalidateQueries({ queryKey: ['m-dashboard'] });
      // البيع غيّر أرصدة تشغيلات السيارة وشاشة التتبّع
      if (lotOn) LOT_CACHE_KEYS.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      toast.success(tr('تم إصدار الفاتورة'));
      [...new Set(warnings.map(w => w.code))].forEach(c => toast(tr(LOT_WARNING_LABELS[c])));
      onCreated(inv.id);
    },
    onError: (e: unknown) => {
      const data = (e as { response?: { data?: { message?: string; code?: string } } })?.response?.data;
      // وحدات صنفٍ تغيّرت منذ فُتحت القائمة: تُجلب من جديد فيتحدّث منتقي البند — ورسالة الخادم تسمّي الصنف
      if (data?.code === 'UNIT_INVALID') qc.invalidateQueries({ queryKey: ['m-inv-products'] });
      // «تتبّع اللوط»: الرفض برمزه وتفاصيله بلغة الواجهة (النقص بالمطلوب والمتاح بوحدات الصنف، والانشغال) — واللقطة تُجدَّد
      const lot = lotErrorOf(e);
      if (lot) {
        if (lot.code === 'LOT_STOCK_INSUFFICIENT') qc.invalidateQueries({ queryKey: ['m-van-lots', salesRepId] });
        toast.error(lotErrorText(lot, tr, {
          nameOf: pid => catalog[pid]?.name ?? lines.find(l => l.productId === pid)?.name,
          qtyText: (pid, n) => qtyText(n, pid ? catalog[pid] : null, formatNumber, { withUnit: true }),
        }));
        return;
      }
      toast.error(data?.message || tr('تعذر الإصدار'));
    },
  });

  const headReady = !!customerId && !!salesRepId;

  return (
    <div className="h-full flex flex-col bg-[#FAF7F0]">
      <MHeader
        title={tr('فاتورة جديدة')}
        subtitle={step === 'head' ? tr('العميل والمندوب') : step === 'items' ? tr('الأصناف') : tr('المراجعة')}
        onBack={() => step === 'head' ? onClose() : setStep(step === 'review' ? 'items' : 'head')} />

      {/* خطوات مرئية — يعرف المستخدم أين هو وكم بقي */}
      <div className="flex-shrink-0 flex gap-1 px-3 py-2 bg-white border-b border-[#F1EBDF]">
        {(['head', 'items', 'review'] as Step[]).map((s, i) => (
          <span key={s} className={`flex-1 h-1 rounded-full ${['head', 'items', 'review'].indexOf(step) >= i ? 'bg-[#E15A30]' : 'bg-[#E9E1D3]'}`} />
        ))}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {step === 'head' && (
          <>
            <Field label={tr('نوع الفاتورة')}>
              <div className="flex gap-2">
                {(['CREDIT', 'CASH', 'INSTALLMENT'] as const).map(k => {
                  const on = k === 'INSTALLMENT' ? plan === 'INSTALLMENT' : (type === k && plan !== 'INSTALLMENT');
                  return (
                    <button key={k} onClick={() => {
                      if (k === 'INSTALLMENT') { setType('CREDIT'); setPlan('INSTALLMENT'); }
                      else { setType(k); setPlan('IMMEDIATE'); }
                    }}
                      className={`flex-1 py-3 rounded-xl font-semibold text-sm min-h-[48px] border ${on ? (k === 'INSTALLMENT' ? 'bg-[#5B4B9C] text-white border-[#5B4B9C]' : 'bg-[#E15A30] text-white border-[#E15A30]') : 'bg-white text-[#6E6557] border-[#E9E1D3]'}`}>
                      {k === 'CREDIT' ? tr('آجل') : k === 'CASH' ? tr('نقدي') : tr('تقسيط')}
                    </button>
                  );
                })}
              </div>
            </Field>

            {plan === 'INSTALLMENT' && (
              <Field label={tr('جدولة الأقساط')}>
                <div className="grid grid-cols-3 gap-2">
                  <input type="number" min={2} max={MAX_INSTALLMENTS} inputMode="numeric"
                    className="input text-center" value={insCount} aria-label={tr('عدد الأقساط')}
                    onChange={e => setInsCount(Math.max(2, Math.min(MAX_INSTALLMENTS, Number(e.target.value) || 2)))} />
                  <input type="date" className="input" value={insFirst} aria-label={tr('أول قسط')}
                    onChange={e => setInsFirst(e.target.value)} />
                  <select className="input" value={insPeriod} aria-label={tr('الدورية')}
                    onChange={e => setInsPeriod(e.target.value as InstallmentPeriod)}>
                    <option value="MONTHLY">{tr('شهري')}</option>
                    <option value="SEMI_MONTHLY">{tr('نصف شهري')}</option>
                    <option value="WEEKLY">{tr('أسبوعي')}</option>
                  </select>
                </div>
                {insPreview.length === 0 ? (
                  <p className="text-[11px] text-[#C0392B] mt-2">{tr('المبلغ لا يكفي لتقسيمه على هذا العدد من الأقساط')}</p>
                ) : (
                  <div className="mt-2 border-t border-[#E9E1D3] pt-2 max-h-40 overflow-y-auto">
                    {insPreview.map(r => (
                      <div key={r.seq} className="flex justify-between text-[11.5px] py-0.5">
                        <span className="text-[#9A8F7E]">{tr('قسط')} {r.seq} · {formatDate(r.dueDate as unknown as string)}</span>
                        <span className="font-bold text-[#1F1A13]">{formatCurrency(r.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Field>
            )}

            <Field label={tr('المندوب')} required>
              {repsQ.isLoading ? <MSpinner /> : (
                <select className="input" value={salesRepId} onChange={e => setSalesRepId(e.target.value)}>
                  <option value="">{tr('اختر المندوب')}</option>
                  {(repsQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
            </Field>

            <Field label={tr('العميل')} required>
              <div className="relative mb-2">
                <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
                <input value={cq} onChange={e => setCq(e.target.value)} className="input ps-9" placeholder={tr('ابحث عن عميل')} />
              </div>
              <div className="rounded-xl border border-[#F1EBDF] bg-white max-h-56 overflow-y-auto divide-y divide-[#F1EBDF]">
                {customersQ.isLoading ? <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('جاري التحميل')}</p>
                  : !customersQ.data?.length ? <p className="text-center text-xs text-[#9A8F7E] py-5">{tr('لا نتائج')}</p>
                  : customersQ.data.map(c => (
                    <button key={c.id} onClick={() => setCustomerId(c.id)}
                      className={`w-full text-start px-3 py-3 min-h-[52px] flex items-center gap-2 ${customerId === c.id ? 'bg-[#FBEBE2]' : 'active:bg-[#FAF7F0]'}`}>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-[#1F1A13] truncate">{c.name}</span>
                        <span className="block text-[11px] text-[#9A8F7E] truncate">{[c.code, c.phone].filter(Boolean).join(' · ')}</span>
                      </span>
                      {customerId === c.id && <Check size={16} className="text-[#E15A30] flex-shrink-0" />}
                    </button>
                  ))}
              </div>
            </Field>

            <Field label={tr('تاريخ الفاتورة')}>
              <input type="date" className="input" dir="ltr" value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
              <p className="text-[10px] text-[#9A8F7E] mt-1">{tr('اتركه فارغا لتاريخ اليوم')}</p>
            </Field>
          </>
        )}

        {step === 'items' && (
          <>
            <div className="relative">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-[#9A8F7E]" />
              <input value={pq} onChange={e => setPq(e.target.value)} className="input ps-9" placeholder={tr('ابحث عن صنف')} />
            </div>

            {lines.length > 0 && (
              <div className="rounded-2xl border border-[#F1EBDF] bg-white divide-y divide-[#F1EBDF]">
                {lines.map((l, idx) => {
                  const k = lineKey(l);
                  const p = catalog[l.productId];
                  const opts = unitChoices(p);
                  const multi = opts.length > 1;
                  // «تتبّع اللوط»: متاح الصنف في السيارة على سطره الأول وحده (لا يتكرّر لكل وحدة)، والنقص بمجموع أسطره
                  const lotLine = lotOn && lotTrackedOf(p) && lines.findIndex(x => x.productId === l.productId) === idx;
                  const lotAvail = lotLine ? vanAvailableOf(snap, l.productId) : null;
                  const lotShort = lotLine && shortages.some(s => s.productId === l.productId);
                  // وحدةٌ أُوقفت أو حُذفت منذ أُضيف البند: لا تُردّ إلى الأساس بصمت — يختار المستخدم (والخادم يرفضها أصلاً)
                  const gone = !!l.unitId && !!p && !opts.some(o => o.id === l.unitId);
                  return (
                    <div key={k} className="p-3 space-y-2">
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-[#1F1A13] truncate">{l.name}</span>
                          <span className="block text-[11px] text-[#9A8F7E]">
                            {formatCurrency(lineTotal(l))}
                            {/* الكمية بوحدتها في السطر — «٢» وحدها لا تقول أكرتونان أم حبّتان */}
                            {multi && ` · ${formatNumber(l.qty)} ${l.unit}`}
                          </span>
                        </span>
                        <button onClick={() => setLines(ls => ls.filter(x => lineKey(x) !== k))}
                          className="p-2 text-[#C0392B]" aria-label={tr('حذف')}><Trash2 size={15} /></button>
                      </div>
                      {p && multi && (
                        <MUnitChips options={opts} value={l.unitId ?? null}
                          onChange={id => switchUnit(k, p, id)}
                          taken={o => lines.some(x => x !== l && x.productId === l.productId && (x.unitId ?? null) === o.id)} />
                      )}
                      {gone && <p className="text-[10px] text-[#C0392B]">{tr('وحدة البند لم تعد متاحة اختر وحدة أخرى')}</p>}
                      {/* لم يبقَ للصنف إلا أساسه: المنتقي لا يُرسم لوحدةٍ واحدة، فتُعرض هي خياراً صريحاً لا يُطبَّق بصمت */}
                      {gone && p && !multi && (
                        <button type="button" onClick={() => switchUnit(k, p, null)}
                          className="min-h-[34px] px-3 rounded-full text-[12px] font-semibold border border-[#E9E1D3] bg-white text-[#6E6557] active:bg-[#FAF7F0]">
                          {opts[0].name}
                        </button>
                      )}
                      <div className="flex items-center gap-2">
                        <button onClick={() => setQty(k, -1)} className="w-10 h-10 rounded-xl border border-[#E9E1D3] flex items-center justify-center"><Minus size={15} /></button>
                        <span className="w-10 text-center font-bold">{l.qty}</span>
                        <button onClick={() => setQty(k, 1)} className="w-10 h-10 rounded-xl border border-[#E9E1D3] flex items-center justify-center"><Plus size={15} /></button>
                        <span className="flex-1" />
                        <label className="text-[10px] text-[#9A8F7E]">{tr('السعر')}</label>
                        <input type="number" step="any" inputMode="decimal" dir="ltr" className="input w-20 text-center py-1.5" value={l.unitPrice}
                          aria-label={multi ? `${tr('السعر')} ${l.unit}` : undefined}
                          onChange={e => patch(k, 'unitPrice', Number(e.target.value) || 0)} />
                        <label className="text-[10px] text-[#9A8F7E]">{tr('خصم%')}</label>
                        <input type="number" step="any" inputMode="decimal" dir="ltr" className="input w-14 text-center py-1.5" value={l.discountPct}
                          onChange={e => patch(k, 'discountPct', Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
                      </div>
                      {lotLine && (
                        <p className={`text-[10px] flex items-start gap-1 leading-relaxed ${lotShort ? 'text-[#C0392B]' : 'text-[#6E6557]'}`}>
                          {lotShort && <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />}
                          <span>
                            {tr('يصرف من التشغيلات الأقرب انتهاء تلقائيا')}
                            {lotAvail !== null && (
                              <> · {tr('المتاح في سيارة المندوب')} <b className="tabular-nums">{qtyText(lotAvail, p, formatNumber, { withUnit: true })}</b></>
                            )}
                          </span>
                        </p>
                      )}
                    </div>
                  );
                })}
                <p className="px-3 py-2 text-[10px] text-[#9A8F7E]">{tr('السعر قبل الضريبة تحسب الضريبة تلقائيا')}</p>
                {lines.some(l => unitChoices(catalog[l.productId]).length > 1) && (
                  <p className="px-3 pb-2 -mt-1 text-[10px] text-[#9A8F7E]">{tr('سعر البند لوحدته المختارة وتبديل الوحدة يعيد تسعيره')}</p>
                )}
              </div>
            )}

            <div className="rounded-2xl border border-[#F1EBDF] bg-white divide-y divide-[#F1EBDF]">
              {productsQ.isLoading ? <MSpinner />
                : !productsQ.data?.length ? <p className="text-center text-xs text-[#9A8F7E] py-6">{tr('لا نتائج')}</p>
                : productsQ.data.map(p => {
                  const opts = unitChoices(p);
                  const multi = opts.length > 1;
                  const d = defaultChoice(p);
                  return (
                    <div key={p.id}>
                      {/* النقرة على الصنف تضيفه بوحدته الافتراضية (الأكبر) كما يضيفه المندوب */}
                      <button onClick={() => addProduct(p)}
                        className="w-full text-start px-3 py-3 min-h-[52px] flex items-center gap-2 active:bg-[#FAF7F0]">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-[#1F1A13] truncate">{p.name}</span>
                          <span className="block text-[11px] text-[#9A8F7E]">
                            {/* السعر بوحدته: سعر الكرتون بلا «/ كرتون» يُقرأ سعر حبّة */}
                            {multi
                              ? `${formatCurrency(choiceNet(d, p.basePrice ?? 0))} / ${d.name}`
                              : formatCurrency(Number(p.basePrice ?? 0))} · {tr('ضريبة')} {Number(p.taxPct ?? 15)}%
                            {lotOn && lotTrackedOf(p) && <> · {tr('LOT')}</>}
                          </span>
                        </span>
                        <Plus size={17} className="text-[#E15A30] flex-shrink-0" />
                      </button>
                      {/* وحدةٌ بعينها: بندٌ مستقلّ بسعرها — «+ حبة» بعد كرتونٍ بندٌ ثانٍ لا زيادةٌ على الكرتون */}
                      {multi && (
                        <div className="flex flex-wrap gap-1.5 px-3 pb-3 -mt-1">
                          {opts.map(o => (
                            <button key={o.id ?? 'base'} type="button" onClick={() => addProduct(p, o)}
                              className="min-h-[34px] px-3 rounded-full text-[12px] font-semibold border border-[#E9E1D3] bg-white text-[#6E6557] active:bg-[#FAF7F0]">
                              + {o.name}
                              {o.factor > 1 && <span className="opacity-75 font-normal"> {formatNumber(o.factor)}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </>
        )}

        {step === 'review' && (
          <>
            <div className="rounded-2xl border border-[#F1EBDF] bg-white p-4 space-y-1.5 text-sm">
              <Row k={tr('العميل')} v={customer?.name || '—'} />
              <Row k={tr('المندوب')} v={repsQ.data?.find(r => r.id === salesRepId)?.name || '—'} />
              <Row k={tr('النوع')} v={plan === 'INSTALLMENT' ? tr('تقسيط') : (type === 'CASH' ? tr('نقدي') : tr('آجل'))} />
              <Row k={tr('الأصناف')} v={String(lines.length)} />
            </div>

            <Field label={tr('خصم على الفاتورة %')}>
              <input type="number" step="any" inputMode="decimal" dir="ltr" className="input" value={discountPct}
                onChange={e => setDiscountPct(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
            </Field>
            <Field label={tr('ملاحظات')}>
              <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
            </Field>

            {/* «تتبّع اللوط»: نقصٌ في تشغيلات السيارة يُقال قبل الإصدار لا بعده — والخادم يمنعه تحت القفل أيّاً كان «البيع
                بدون مخزون»، فالزرّ لا يُعطَّل على لقطةٍ قد تكون أقدم من تحميلٍ تمّ للتوّ */}
            {shortages.length > 0 && (
              <div className="rounded-2xl border border-[#F5C6C0] bg-[#FDF2F0] p-3 space-y-1.5 text-[11px] leading-relaxed">
                <p className="font-bold text-[#C0392B] flex items-center gap-1.5">
                  <AlertTriangle size={13} className="flex-shrink-0" /> {tr('الكمية أكبر من المتاح في تشغيلات سيارة المندوب')}
                </p>
                {shortages.map(s => (
                  <p key={s.productId} className="text-[#1F1A13]">
                    {catalog[s.productId]?.name ?? '-'}: <b className="tabular-nums">{qtyText(s.wanted, catalog[s.productId], formatNumber, { withUnit: true })}</b>
                    {' · '}{tr('المتاح في السيارة')} <b className="tabular-nums">{qtyText(s.available, catalog[s.productId], formatNumber, { withUnit: true })}</b>
                  </p>
                ))}
                <p className="text-[#8A6D1F]">{tr('الأصناف المتتبعة بـLOT ممنوعة دائما من البيع بلا رصيد ولو سمح للمندوب')}</p>
              </div>
            )}

            <div className="rounded-2xl border border-[#E9E1D3] bg-white p-4 space-y-2">
              <Row k={tr('الإجمالي قبل الضريبة')} v={formatCurrency(totals.subtotal)} />
              <Row k={tr('الخصم')} v={`− ${formatCurrency(totals.discount)}`} />
              <Row k={tr('الضريبة')} v={formatCurrency(totals.tax)} />
              <div className="border-t border-[#E9E1D3] pt-2 flex justify-between items-center">
                <span className="font-bold text-[#1F1A13]">{tr('الإجمالي')}</span>
                <span className="text-xl font-bold text-[#E15A30]">{formatCurrency(totals.total)}</span>
              </div>
            </div>
          </>
        )}
        <div className="h-2" />
      </div>

      {/* شريط الإجراء الثابت */}
      <div className="flex-shrink-0 border-t border-[#E9E1D3] bg-white p-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
        {step === 'head' && (
          <button onClick={() => setStep('items')} disabled={!headReady}
            className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] disabled:bg-[#E89B7E]">
            {tr('التالي الأصناف')}
          </button>
        )}
        {step === 'items' && (
          <button onClick={() => setStep('review')} disabled={lines.length === 0}
            className="w-full bg-[#E15A30] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:bg-[#E89B7E]">
            <ShoppingCart size={17} />
            {tr('مراجعة')} · {formatCurrency(totals.total)}
          </button>
        )}
        {step === 'review' && (
          <button onClick={() => save.mutate()} disabled={save.isPending || lines.length === 0}
            className="w-full bg-[#2F855A] text-white font-bold py-3.5 rounded-xl min-h-[50px] flex items-center justify-center gap-2 disabled:opacity-60">
            {save.isPending && <Loader2 size={16} className="animate-spin" />}
            {tr('إصدار الفاتورة')}
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}{required && ' *'}</label>
      {children}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[#6E6557] text-sm">{k}</span>
      <span className="text-[#1F1A13] text-sm font-semibold truncate">{v}</span>
    </div>
  );
}
