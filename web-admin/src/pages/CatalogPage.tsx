import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Phone, MessageCircle, Package, Plus, Minus, Trash2, ShoppingBag, X, ChevronLeft, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { currencyDecimals, currencySymbol } from '../i18n/countries';
import { isTaxOff } from '../lib/taxMode';
import { newUuid } from '../lib/uuid';
import {
  CART_MAX_QTY, ORDER_NAME_MAX, ORDER_NOTE_MAX, ORDER_PHONE_MAX, catalogGross, cartQty, cartUnitOptions, checkoutProblem,
  formatQty, loadCart, orderDraft, orderFailure, orderSignature, parseQtyInput, pickClientRef, pickedUnitId, reconcileCart, resolveCart,
  saveCart, setCartQty, stepCartQty,
  type CartLine, type CheckoutForm, type PendingRef, type ResolvedCart,
} from '../lib/catalogCart';

/**
 * منيو المنتجات العام — الصفحة التي يشاركها المندوب مع عملائه:
 * /c/{tenantId}/{repId}
 *
 * بلا مصادقة، محمولة أولاً (العميل يفتحها من واتساب على جواله)، بهوية الشركة
 * (شعار ولون)، وبختم المندوب: «مندوبك فلان» بزرَّي اتصال وواتساب على رقم عمله.
 * السعر المعروض شامل الضريبة — نفس معادلة السعر المعلن في تطبيق المندوب.
 *
 * الطلب من المنيو (طلب المالك ٢٤ نوفمبر ٢٠٢٦): حين يرسل الخادم `orderEnabled: true` يضيف العميل الأصناف بالضغط عليها
 * (بالوحدة الرئيسية افتراضاً) إلى سلّةٍ محفوظة على جهازه لكل رابط، ثم «إتمام الطلب» باسمه وجواله فيصل الطلب مندوبَ الرابط
 * («طلب جديد» في تطبيقه). منطق السلّة كلّه في lib/catalogCart.ts؛ وبلا العلم (خادمٌ أقدم) الصفحة كما كانت حرفاً.
 */

/** عنوان الخادم يُقرأ عند النداء لا على مستوى الوحدة — فتُستورد الصفحة في الاختبار (node بلا import.meta.env) بلا خطأ */
const apiBase = () => (import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api');

interface CatalogData {
  /** `taxDisabled: true` («إزالة الضريبة») يرسله الخادم للشركة بلا ضريبة وحدها — غائبٌ = المنيو كما كان */
  company: { name: string; logo?: string | null; primaryColor?: string | null; currency: string; taxDisabled?: boolean };
  rep: { name: string; contact?: string | null };
  /** الطلب من المنيو مفعّل في الخادم (مع `id` لكل صنف ووحدة) — غائبٌ = منيو عرضٍ فقط كما كان */
  orderEnabled?: boolean;
  /**
   * الوحدات المتعددة: `unit`/`basePrice` لوحدة الأساس (الحبة)، و`units` وحدات البيع الأكبر النشطة بمعاملها وسعرها
   * الصافي (المحدَّد لها، وإلا الأساس × المعامل — يحسبه الخادم). وصنفٌ بلا وحدات: `units` فارغة أو غائبة (خادمٌ أقدم).
   */
  products: CatalogProduct[];
}

/**
 * صنف المنيو. «الوحدة الرئيسية» (routes/publicCatalog.ts): الوحدة الرئيسية وحدها تحمل `isPrimary: true` والمفتاح غائب في
 * غيرها — صنفٌ بلا رئيسية يصل كما كان حرفاً. و`id` (للصنف وللوحدة) يصل مع الطلب من المنيو وحده: به يُبنى سطر السلّة.
 */
type CatalogUnit = { id?: string; name: string; factor: number; price: number; isPrimary?: boolean };
type CatalogProduct = { id?: string; name: string; unit: string; basePrice: number; taxPct: number; image?: string | null; category?: string | null; units?: CatalogUnit[] };

/** سطر سعرٍ في بطاقة الصنف: السعر الصافي (قبل الضريبة) ووسمه */
export interface CatalogPriceLine { key: string; price: number; label: string }

/**
 * أسطر أسعار بطاقة الصنف بترتيب العرض: `main` السعر البارز، و`rest` الأسطر الصغيرة تحته.
 * - بلا وحدة رئيسية: البارز سعر الأساس بوسمه (`unit`)، ثم الوحدات الأكبر «كرتون (24 حبة)» — كما كان حرفاً (I1).
 * - بوحدة رئيسية (أول وحدة `isPrimary === true`): البارز سعرها بوسم «كرتون (24 قارورة)»، ثم سعر الوحدة الصغرى سطراً
 *   تحته، ثم بقية الوحدات بترتيب الخادم — العميل يطلب بالكرتون، والقارورة معلومة لا عنوان.
 */
export function catalogPriceLines(p: CatalogProduct): { main: CatalogPriceLine; rest: CatalogPriceLine[] } {
  const units = p.units ?? [];
  const unitLine = (u: CatalogUnit): CatalogPriceLine => ({ key: u.name, price: u.price, label: `${u.name} (${u.factor} ${p.unit})` });
  const baseLine: CatalogPriceLine = { key: p.unit, price: p.basePrice, label: p.unit };
  const primary = units.find(u => u.isPrimary === true);
  if (!primary) return { main: baseLine, rest: units.map(unitLine) };
  return { main: unitLine(primary), rest: [baseLine, ...units.filter(u => u !== primary).map(unitLine)] };
}

export default function CatalogPage() {
  const { tenantId, repId } = useParams();
  const [data, setData] = useState<CatalogData | null>(null);
  const [err, setErr] = useState(false);
  const [cat, setCat] = useState<string | null>(null);
  // ─── الطلب من المنيو ───
  const [cart, setCart] = useState<CartLine[]>([]);
  // مرجع الإعادة الآمنة المعلّق — يُحفظ مع السلّة فإعادة المحاولة (ولو بعد تحديث الصفحة) لا تكرّر الطلب عند المندوب
  const [pending, setPending] = useState<PendingRef | null>(null);
  // لا يُكتب التخزين قبل قراءته — وإلا محت السلّةُ الفارغة الأولى سلّةَ الأمس
  const [cartReady, setCartReady] = useState(false);
  const [unitPick, setUnitPick] = useState<Record<string, string | null>>({});
  const [sheet, setSheet] = useState(false);
  const [form, setForm] = useState<CheckoutForm>({ name: '', phone: '', note: '', website: '' });
  const [sending, setSending] = useState(false);
  const [orderErr, setOrderErr] = useState<{ msg: string; reload?: true } | null>(null);
  const [done, setDone] = useState<{ repName: string } | null>(null);

  // روابط المنيو خاصة تُشارك يداً بيد — لا تُفهرس
  useEffect(() => {
    const m = document.createElement('meta');
    m.name = 'robots'; m.content = 'noindex, nofollow';
    document.head.appendChild(m);
    return () => { document.head.removeChild(m); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase()}/public/catalog/${tenantId}/${repId}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (!cancelled) { setData(j.data as CatalogData); document.title = `${j.data.company.name} — منيو المنتجات`; } })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
  }, [tenantId, repId]);

  const brand = data?.company.primaryColor || '#E15A30';
  const dec = currencyDecimals(data?.company.currency || 'SAR');
  const sym = currencySymbol(data?.company.currency || 'SAR');
  /* «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): منيو شركةٍ بلا ضريبة — السعر المكتوب هو ما يدفعه العميل (لا رفع بالنسبة)، ولا
   * عبارة «شاملة الضريبة». والخادم يرسل taxPct صفراً كذلك؛ والحارس هنا لنسخةٍ قديمة من الخادم */
  const taxOff = isTaxOff(data?.company);
  // السعر شامل الضريبة — مطابق لمعادلة تطبيق المندوب حرفياً (CatalogPrices أسفل الملف)

  const cats = useMemo(() => {
    const set = new Map<string, number>();
    for (const p of data?.products ?? []) {
      const k = p.category ?? 'أخرى';
      set.set(k, (set.get(k) ?? 0) + 1);
    }
    return [...set.keys()];
  }, [data]);

  const shown = (data?.products ?? []).filter(p => !cat || (p.category ?? 'أخرى') === cat);
  const wa = data?.rep.contact ? `https://wa.me/${data.rep.contact.replace(/[^0-9]/g, '')}` : null;

  // السلّة تظهر بعلم الخادم وحده — خادمٌ أقدم (بلا معرّفات) يبقي المنيو عرضاً فقط ولا يلمس التخزين
  const canOrder = data?.orderEnabled === true;

  // سلّة هذا الرابط من الجهاز، مطابَقةً بالمنيو الحالي (صنفٌ أُوقف أو وحدةٌ أُلغيت تسقط)
  useEffect(() => {
    if (!data || data.orderEnabled !== true || !tenantId || !repId) return;
    const stored = loadCart(tenantId, repId);
    setCart(reconcileCart(stored.lines, data.products));
    setPending(stored.pending);
    setCartReady(true);
  }, [data, tenantId, repId]);

  useEffect(() => {
    if (cartReady && tenantId && repId) saveCart(tenantId, repId, { lines: cart, pending });
  }, [cart, pending, cartReady, tenantId, repId]);

  const resolved: ResolvedCart = useMemo(
    () => resolveCart(canOrder ? cart : [], data?.products ?? [], { dec, taxOff }),
    [canOrder, cart, data, dec, taxOff],
  );
  const hasCart = resolved.count > 0;
  const sheetOpen = sheet && hasCart;

  // حذف آخر سطرٍ من داخل النافذة يغلقها — فلا تنفتح وحدها مع أول إضافةٍ بعدها
  useEffect(() => { if (sheet && !hasCart) setSheet(false); }, [sheet, hasCart]);

  // النافذة السفلية على الجوال: الصفحة خلفها لا تتمرّر مع الإصبع
  useEffect(() => {
    if (!sheetOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [sheetOpen]);

  const changeQty = (productId: string, unitId: string | null, qty: number) => setCart(c => setCartQty(c, productId, unitId, qty));
  const stepQty = (productId: string, unitId: string | null, delta: number) => setCart(c => stepCartQty(c, productId, unitId, delta));

  async function submitOrder(website: string) {
    if (!data || !tenantId || !repId || sending) return;
    const problem = checkoutProblem(form, resolved.count);
    if (problem) { setOrderErr({ msg: problem }); return; }
    const draft = orderDraft({ ...form, website }, cart, data.products);
    // المرجع نفسه للجسم نفسه: إعادة المحاولة بعد انقطاعٍ وصل فيه الطلب يردّ عليها الخادم بالطلب نفسه
    const ref = pickClientRef(pending, orderSignature(draft), newUuid);
    setPending(ref);
    setSending(true);
    setOrderErr(null);
    try {
      const r = await fetch(`${apiBase()}/public/catalog/${tenantId}/${repId}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientRef: ref.ref, ...draft }),
      });
      if (!r.ok) { setOrderErr(orderFailure(r.status)); return; }
      const j = await r.json().catch(() => null) as { data?: { repName?: string } } | null;
      setDone({ repName: j?.data?.repName || data.rep.name });
      setCart([]);
      setPending(null);
      setSheet(false);
      // الاسم والجوال يبقيان لطلبٍ تالٍ في الزيارة نفسها، والملاحظة تخصّ هذا الطلب وحده
      setForm(f => ({ ...f, note: '' }));
    } catch {
      setOrderErr(orderFailure(null));
    } finally {
      setSending(false);
    }
  }

  if (err) {
    return (
      <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAF7F0', fontFamily: 'system-ui, sans-serif', color: '#6E6557', padding: 24, textAlign: 'center' }}>
        الرابط غير صحيح او لم يعد متاحا — تواصل مع مندوبك
      </div>
    );
  }
  if (!data) {
    return (
      <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#FAF7F0' }}>
        <div style={{ width: 34, height: 34, border: '3px solid #E9E1D3', borderTopColor: '#E15A30', borderRadius: '50%', animation: 'spin 0.9s linear infinite' }} />
        <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
      </div>
    );
  }

  return (
    <div dir="rtl" style={{ minHeight: '100vh', background: '#FAF7F0', fontFamily: "'IBM Plex Sans Arabic', system-ui, sans-serif", color: '#1F1A13', paddingBottom: hasCart ? 170 : 80 }}>
      {/* رأس الشركة */}
      <header style={{ background: '#fff', borderBottom: '1px solid #E9E1D3', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 0, zIndex: 10 }}>
        {data.company.logo
          ? <img src={data.company.logo} alt="" style={{ width: 44, height: 44, borderRadius: 12, objectFit: 'cover', border: '1px solid #E9E1D3' }} />
          : <span style={{ width: 44, height: 44, borderRadius: 12, background: brand, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Package size={22} color="#fff" /></span>}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.company.name}</div>
          <div style={{ fontSize: 11.5, color: '#8A8178' }}>{taxOff ? 'منيو المنتجات' : 'منيو المنتجات · الاسعار شاملة الضريبة'}</div>
        </div>
      </header>

      {/* شريط المندوب */}
      <div style={{ background: brand, color: '#fff', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 13.5, flex: 1 }}>مندوبك: <b>{data.rep.name}</b></span>
        {data.rep.contact && (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <a href={`tel:${data.rep.contact}`} aria-label="اتصال" style={{ width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><Phone size={17} /></a>
            {wa && <a href={wa} target="_blank" rel="noreferrer" aria-label="واتساب" style={{ width: 34, height: 34, borderRadius: 10, background: 'rgba(255,255,255,.18)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#fff' }}><MessageCircle size={17} /></a>}
          </span>
        )}
      </div>

      {/* فئات */}
      {cats.length > 1 && (
        <div style={{ display: 'flex', gap: 8, overflowX: 'auto', padding: '12px 16px 4px', WebkitOverflowScrolling: 'touch' }}>
          <button onClick={() => setCat(null)} style={{ flexShrink: 0, border: '1px solid ' + (cat === null ? brand : '#E9E1D3'), background: cat === null ? brand : '#fff', color: cat === null ? '#fff' : '#4A4239', borderRadius: 999, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>الكل</button>
          {cats.map(c => (
            <button key={c} onClick={() => setCat(c)} style={{ flexShrink: 0, border: '1px solid ' + (cat === c ? brand : '#E9E1D3'), background: cat === c ? brand : '#fff', color: cat === c ? '#fff' : '#4A4239', borderRadius: 999, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>{c}</button>
          ))}
        </div>
      )}

      {/* الأصناف */}
      <main style={{ padding: '12px 16px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
        {shown.map((p, i) => (
          <div key={i} style={{ background: '#fff', border: '1px solid #E9E1D3', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ aspectRatio: '1', background: '#F6F1E7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {p.image
                ? <img src={p.image} alt={p.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                : <Package size={34} color="#D8CDB9" />}
            </div>
            <div style={{ padding: '10px 12px' }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.45, minHeight: 38 }}>{p.name}</div>
              <CatalogPrices p={taxOff ? { ...p, taxPct: 0 } : p} brand={brand} dec={dec} sym={sym} />
              {canOrder && p.id && (
                <CardOrder p={p} pid={p.id} cart={cart} picked={unitPick} brand={brand}
                  onPick={(pid, u) => setUnitPick(m => ({ ...m, [pid]: u }))} onStep={stepQty} onQty={changeQty} />
              )}
            </div>
          </div>
        ))}
        {!shown.length && <p style={{ gridColumn: '1/-1', textAlign: 'center', color: '#8A8178', fontSize: 13, padding: 30 }}>لا اصناف في هذه الفئة</p>}
      </main>

      {/* زر واتساب عائم — يرتفع فوق شريط «إتمام الطلب» حين تمتلئ السلّة فلا يغطّيه */}
      {wa && (
        <a href={`${wa}?text=${encodeURIComponent('مرحبا اطلعت على منيو المنتجات وارغب بالطلب')}`} target="_blank" rel="noreferrer"
          style={{ position: 'fixed', bottom: hasCart ? 'calc(92px + env(safe-area-inset-bottom))' : 18, insetInlineStart: 18, background: '#1E7A52', color: '#fff', borderRadius: 999, padding: '12px 20px', fontWeight: 800, fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 8, boxShadow: '0 10px 26px rgba(30,122,82,.4)', textDecoration: 'none' }}>
          <MessageCircle size={18} /> اطلب عبر واتساب
        </a>
      )}

      <footer style={{ textAlign: 'center', padding: '26px 16px 10px', fontSize: 11, color: '#B7AD9D' }}>
        مدعوم من <a href="/" style={{ color: '#8A8178', fontWeight: 700, textDecoration: 'none' }}>FieldSales</a>
      </footer>

      {/* شريط «إتمام الطلب» الثابت أسفل الشاشة — يختفي والسلّة فارغة */}
      {hasCart && !sheetOpen && (
        <div style={{ position: 'fixed', insetInline: 0, bottom: 0, zIndex: 20, padding: '10px 16px calc(10px + env(safe-area-inset-bottom))', background: 'rgba(250,247,240,.96)', borderTop: '1px solid #E9E1D3' }}>
          <button type="button" onClick={() => { setOrderErr(null); setSheet(true); }}
            style={{ width: '100%', maxWidth: 560, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 12, background: brand, color: '#fff', border: 'none', borderRadius: 14, padding: '11px 14px', cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 10px 24px rgba(31,26,19,.18)', textAlign: 'start' }}>
            <span style={{ position: 'relative', width: 40, height: 40, borderRadius: 12, background: 'rgba(255,255,255,.18)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <ShoppingBag size={20} />
              <span style={{ position: 'absolute', top: -5, insetInlineEnd: -5, minWidth: 20, height: 20, borderRadius: 999, background: '#fff', color: brand, fontSize: 11.5, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{resolved.count}</span>
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 800, fontSize: 15.5 }}>إتمام الطلب</span>
              <span style={{ display: 'block', fontSize: 12, opacity: 0.92, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {resolved.count} صنف · الإجمالي التقريبي <b>{fmtMoney(resolved.total, dec)}</b> {sym}
              </span>
            </span>
            <ChevronLeft size={22} style={{ flexShrink: 0 }} />
          </button>
        </div>
      )}

      {sheetOpen && (
        <CheckoutSheet
          brand={brand} dec={dec} sym={sym} taxOff={taxOff} repName={data.rep.name}
          resolved={resolved} form={form} sending={sending} error={orderErr}
          onForm={patch => { setForm(f => ({ ...f, ...patch })); if (orderErr && !orderErr.reload) setOrderErr(null); }}
          onStep={(l, d) => stepQty(l.productId, l.unitId, d)}
          onQty={(l, q) => changeQty(l.productId, l.unitId, q)}
          onClose={() => { if (!sending) setSheet(false); }}
          onSubmit={submitOrder}
        />
      )}

      {done && <OrderDone repName={done.repName} brand={brand} onBack={() => setDone(null)} />}
    </div>
  );
}

/** المبلغ بخانات العملة وأرقام المنيو (ar-SA) — كتنسيق CatalogPrices */
const fmtMoney = (v: number, dec: number) => v.toLocaleString('ar-SA', { minimumFractionDigits: dec, maximumFractionDigits: dec });

/**
 * عدّاد الكمية: − (أو سلّة المهملات عند ١) والكمية قابلةً للكتابة و+. الخانة تقبل الأرقام العربية والكسر، والمسودة الفارغة أو
 * الصفر لا تحذف السطر أثناء الكتابة (يعود الرقم عند مغادرة الخانة) — الحذف بالزرّ وحده فلا يضيع سطرٌ بلمسة.
 * الخط 16px: دونه يكبّر سفاري الآيفون الصفحة عند لمس الخانة.
 */
function QtyStepper({ qty, brand, onStep, onQty, height = 38 }: { qty: number; brand: string; onStep: (delta: number) => void; onQty: (q: number) => void; height?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const btn = { width: height, height: '100%', border: 'none', background: 'transparent', color: brand, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0 } as const;
  return (
    <div dir="ltr" style={{ display: 'flex', alignItems: 'center', height, border: `1.5px solid ${brand}`, borderRadius: 10, overflow: 'hidden', background: '#fff' }}>
      <button type="button" aria-label={qty <= 1 ? 'حذف من الطلب' : 'إنقاص'} onClick={() => onStep(-1)} style={btn}>
        {qty <= 1 ? <Trash2 size={16} /> : <Minus size={17} />}
      </button>
      <input
        aria-label="الكمية" inputMode="decimal" enterKeyHint="done"
        value={draft ?? formatQty(qty)}
        onFocus={e => { setDraft(formatQty(qty)); const el = e.currentTarget; requestAnimationFrame(() => el.select()); }}
        onChange={e => { setDraft(e.target.value); const n = parseQtyInput(e.target.value); if (n > 0) onQty(n); }}
        onBlur={() => setDraft(null)}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        style={{ flex: 1, minWidth: 0, width: '100%', height: '100%', border: 'none', outline: 'none', textAlign: 'center', fontWeight: 800, fontSize: 16, color: '#1F1A13', background: 'transparent', fontFamily: 'inherit', padding: 0 }}
      />
      <button type="button" aria-label="زيادة" onClick={() => onStep(1)} disabled={qty >= CART_MAX_QTY} style={btn}>
        <Plus size={17} />
      </button>
    </div>
  );
}

/**
 * أداة الطلب في بطاقة الصنف: منتقي الوحدة (حين للصنف وحدات بيع) بعدّاد كلّ وحدةٍ في السلّة، ثم «أضف» أو العدّاد للوحدة
 * المختارة. الافتراضية الرئيسية وإلا الأساس (pickedUnitId).
 */
export function CardOrder({ p, pid, cart, picked, brand, onPick, onStep, onQty }: {
  p: CatalogProduct; pid: string; cart: CartLine[]; picked: Record<string, string | null>; brand: string;
  onPick: (productId: string, unitId: string | null) => void;
  onStep: (productId: string, unitId: string | null, delta: number) => void;
  onQty: (productId: string, unitId: string | null, qty: number) => void;
}) {
  const options = cartUnitOptions(p);
  const unitId = pickedUnitId(p, cart, picked);
  const qty = cartQty(cart, pid, unitId);
  return (
    <div style={{ marginTop: 10 }}>
      {options.length > 1 && (
        <div role="group" aria-label="الوحدة" style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {options.map(o => {
            const on = o.unitId === unitId;
            const inCart = cartQty(cart, pid, o.unitId);
            return (
              <button key={o.unitId ?? ''} type="button" aria-pressed={on} onClick={() => onPick(pid, o.unitId)}
                style={{ border: '1px solid ' + (on ? brand : '#E9E1D3'), background: on ? brand : '#fff', color: on ? '#fff' : '#4A4239', borderRadius: 999, padding: '4px 10px', fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.4 }}>
                {o.name}{inCart > 0 && <span style={{ opacity: 0.85 }}> · {formatQty(inCart)}</span>}
              </button>
            );
          })}
        </div>
      )}
      {qty > 0
        ? <QtyStepper qty={qty} brand={brand} onStep={d => onStep(pid, unitId, d)} onQty={q => onQty(pid, unitId, q)} />
        : (
          <button type="button" onClick={() => onStep(pid, unitId, 1)}
            style={{ width: '100%', height: 38, border: 'none', borderRadius: 10, background: brand, color: '#fff', fontWeight: 800, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer', fontFamily: 'inherit' }}>
            <Plus size={16} /> أضف
          </button>
        )}
    </div>
  );
}

/**
 * نافذة «إتمام الطلب» السفلية: ملخّص الأسطر بعدّاداتها والإجمالي التقريبي، ثم الاسم والجوال (مطلوبان) والملاحظة، وحقل فخٍّ
 * مخفيّ باسم `website` (يملؤه الروبوت فيردّ الخادم بنجاحٍ وهميّ ولا يُخزَّن شيء)، ثم «إرسال الطلب».
 */
export function CheckoutSheet({ brand, dec, sym, taxOff, repName, resolved, form, sending, error, onForm, onStep, onQty, onClose, onSubmit }: {
  brand: string; dec: number; sym: string; taxOff: boolean; repName: string;
  resolved: ResolvedCart; form: CheckoutForm; sending: boolean; error: { msg: string; reload?: true } | null;
  onForm: (patch: Partial<CheckoutForm>) => void;
  onStep: (l: CartLine, delta: number) => void; onQty: (l: CartLine, q: number) => void;
  onClose: () => void; onSubmit: (website: string) => void;
}) {
  const field = { width: '100%', boxSizing: 'border-box', border: '1px solid #E0D6C4', borderRadius: 12, padding: '11px 12px', fontSize: 16, fontFamily: 'inherit', color: '#1F1A13', background: '#fff', outline: 'none' } as const;
  const label = { display: 'block', fontSize: 12.5, fontWeight: 700, color: '#4A4239', marginBottom: 5 } as const;
  return (
    <div role="dialog" aria-modal="true" aria-label="إتمام الطلب" onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(31,26,19,.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 560, maxHeight: '92vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: '#FAF7F0', borderRadius: '20px 20px 0 0', boxShadow: '0 -12px 36px rgba(31,26,19,.25)' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 1, background: '#FAF7F0', padding: '14px 16px 10px', borderBottom: '1px solid #E9E1D3', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 16.5 }}>إتمام الطلب</div>
            <div style={{ fontSize: 12, color: '#8A8178' }}>يصل طلبك إلى مندوبك: <b style={{ color: '#4A4239' }}>{repName}</b></div>
          </div>
          <button type="button" aria-label="إغلاق" onClick={onClose} disabled={sending}
            style={{ width: 36, height: 36, borderRadius: 10, border: '1px solid #E9E1D3', background: '#fff', color: '#4A4239', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '12px 16px calc(16px + env(safe-area-inset-bottom))' }}>
          {/* ملخّص الأسطر */}
          <div style={{ background: '#fff', border: '1px solid #E9E1D3', borderRadius: 14, overflow: 'hidden' }}>
            {resolved.lines.map((l, i) => (
              <div key={l.key} style={{ padding: '10px 12px', borderTop: i ? '1px solid #F0E9DC' : 'none', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.4 }}>{l.name}</div>
                  <div style={{ fontSize: 11.5, color: '#8A8178', marginTop: 2 }}>{l.unitLabel} · {fmtMoney(l.grossUnit, dec)} {sym}</div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: brand, marginTop: 3 }}>{fmtMoney(l.lineTotal, dec)} <span style={{ fontSize: 10.5 }}>{sym}</span></div>
                </div>
                <div style={{ width: 118, flexShrink: 0 }}>
                  <QtyStepper qty={l.qty} brand={brand} height={34} onStep={d => onStep(l, d)} onQty={q => onQty(l, q)} />
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', margin: '12px 2px 2px' }}>
            <span style={{ fontWeight: 700, fontSize: 13.5 }}>الإجمالي التقريبي · {resolved.count} صنف</span>
            <span style={{ fontWeight: 800, fontSize: 17, color: brand }}>{fmtMoney(resolved.total, dec)} <span style={{ fontSize: 11.5 }}>{sym}</span></span>
          </div>
          <p style={{ margin: '0 2px 14px', fontSize: 11.5, color: '#8A8178', lineHeight: 1.6 }}>
            {taxOff ? 'السعر النهائي يؤكده مندوبك عند الفاتورة' : 'شامل الضريبة · السعر النهائي يؤكده مندوبك عند الفاتورة'}
          </p>

          {/* بيانات العميل */}
          <form noValidate onSubmit={e => {
            e.preventDefault();
            const trap = e.currentTarget.elements.namedItem('website');
            onSubmit(trap instanceof HTMLInputElement ? trap.value : '');
          }}>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor="co-name" style={label}>الاسم <span style={{ color: brand }}>*</span></label>
              <input id="co-name" autoComplete="name" maxLength={ORDER_NAME_MAX} value={form.name} onChange={e => onForm({ name: e.target.value })} style={field} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label htmlFor="co-phone" style={label}>رقم الجوال <span style={{ color: brand }}>*</span></label>
              <input id="co-phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" maxLength={ORDER_PHONE_MAX} value={form.phone} onChange={e => onForm({ phone: e.target.value })} style={{ ...field, textAlign: 'right' }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="co-note" style={label}>ملاحظة <span style={{ fontWeight: 400, color: '#8A8178' }}>(اختياري)</span></label>
              <textarea id="co-note" rows={2} maxLength={ORDER_NOTE_MAX} value={form.note} onChange={e => onForm({ note: e.target.value })} style={{ ...field, resize: 'vertical', minHeight: 64 }} />
            </div>
            {/* فخّ الروبوتات: خارج الشاشة ومخفيٌّ عن قارئ الشاشة ولوحة المفاتيح — الإنسان لا يراه فيبقى فارغاً. غير متحكَّمٍ به
                ويُقرأ من الـDOM عند الإرسال: روبوتٌ يضبط القيمة مباشرةً بلا أحداث كتابةٍ لا يمرّ بحالة React فيفلت */}
            <div aria-hidden="true" style={{ position: 'absolute', left: -10000, top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
              <input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
            </div>

            {error && (
              <div role="alert" style={{ background: '#FDECEA', border: '1px solid #F5C6C0', color: '#9A2A1A', borderRadius: 12, padding: '10px 12px', fontSize: 13, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 1 }}>{error.msg}</span>
                {error.reload && (
                  <button type="button" onClick={() => window.location.reload()}
                    style={{ flexShrink: 0, border: '1px solid #9A2A1A', background: '#fff', color: '#9A2A1A', borderRadius: 10, padding: '6px 10px', fontSize: 12.5, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <RefreshCw size={14} /> تحديث
                  </button>
                )}
              </div>
            )}

            <button type="submit" disabled={sending}
              style={{ width: '100%', height: 50, border: 'none', borderRadius: 14, background: brand, color: '#fff', fontWeight: 800, fontSize: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: sending ? 'default' : 'pointer', opacity: sending ? 0.75 : 1, fontFamily: 'inherit' }}>
              {sending ? <><Loader2 size={18} style={{ animation: 'spin 0.9s linear infinite' }} /> جاري الإرسال…</> : 'إرسال الطلب'}
            </button>
            <style>{'@keyframes spin{to{transform:rotate(360deg)}}'}</style>
          </form>
        </div>
      </div>
    </div>
  );
}

/** شاشة النجاح: «وصل طلبك إلى مندوبك …» وأنّه سيتواصل معه — والسلّة قد فُرّغت */
export function OrderDone({ repName, brand, onBack }: { repName: string; brand: string; onBack: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-label="تم إرسال الطلب"
      style={{ position: 'fixed', inset: 0, zIndex: 40, background: '#FAF7F0', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 380, width: '100%', textAlign: 'center' }}>
        <span style={{ width: 76, height: 76, borderRadius: '50%', background: '#E3F2EA', color: '#1E7A52', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <CheckCircle2 size={42} />
        </span>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: '18px 0 8px', lineHeight: 1.5 }}>وصل طلبك إلى مندوبك {repName}</h1>
        <p style={{ fontSize: 14, color: '#6E6557', margin: '0 0 24px', lineHeight: 1.7 }}>سيتواصل معك مندوبك قريباً لتأكيد الطلب والسعر النهائي.</p>
        <button type="button" onClick={onBack}
          style={{ width: '100%', height: 48, border: 'none', borderRadius: 14, background: brand, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer', fontFamily: 'inherit' }}>
          العودة إلى المنيو
        </button>
      </div>
    </div>
  );
}

/**
 * أسعار بطاقة الصنف شاملةً الضريبة بمعادلة تطبيق المندوب حرفياً: البارز ثم الأسطر الصغيرة (catalogPriceLines).
 * بلا وحدة رئيسية الناتج هو ما كانت البطاقة تعرضه قبل الميزة حرفاً: سعر الأساس بارزاً ثم وحدات البيع الأكبر (كرتون ٢٤) —
 * العميل يطلب بالكرتون لا بالحبة. وبوحدة رئيسية سعرها البارز وسعر الوحدة الصغرى سطرٌ تحته.
 */
export function CatalogPrices({ p, brand, dec, sym }: { p: CatalogProduct; brand: string; dec: number; sym: string }) {
  // المعادلة في lib/catalogCart.ts مصدراً واحداً للبطاقة والسلّة — سعر الكرتون في البطاقة هو سعره في «إتمام الطلب»
  const gross = (price: number) => catalogGross(price, p.taxPct, dec);
  const money = (price: number) => gross(price).toLocaleString('ar-SA', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const { main, rest } = catalogPriceLines(p);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ color: brand, fontWeight: 800, fontSize: 15 }}>{money(main.price)} <span style={{ fontSize: 11 }}>{sym}</span></span>
        <span style={{ fontSize: 10.5, color: '#8A8178' }}>{main.label}</span>
      </div>
      {rest.map(l => (
        <div key={l.key} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 3 }}>
          <span style={{ color: '#4A4239', fontWeight: 700, fontSize: 12.5 }}>{money(l.price)} <span style={{ fontSize: 10 }}>{sym}</span></span>
          <span style={{ fontSize: 10.5, color: '#8A8178' }}>{l.label}</span>
        </div>
      ))}
    </>
  );
}
