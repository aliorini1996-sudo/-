/**
 * المندوب الذكي — محرّك توقّع مشتريات المحل المقترح (حتمي، دالة صرفة بلا قاعدة ولا نموذج لغوي).
 *
 * السؤال: محلٌّ من نوعٍ ما في موقعٍ ما — لم يصبح عميلاً بعد — كم يُتوقَّع أن يشتري من كل منتج؟
 * الجواب من **عملاء الشركة نفسها** المشابهين له (النوع نفسه، الأقرب إليه جغرافياً):
 *   - الانتشار: كم محلاً مشابهاً من كل عشرة يشتري الصنف.
 *   - الكمية الشهرية لمن يشتريه: الوسيط والمدى الربعي (مقدِّر Harrell–Davis المنعَّم).
 *   - أول طلب: ما طلبته المحلات المشابهة في فاتورتها الأولى.
 *   - طلب تجريبي مقترح للأصناف الأوسع انتشاراً.
 *
 * ضوابط ثابتة (من التصميم ونقده):
 *   - لا رقم لمجموعة أقلّ من `minPeers` (≥٥): حدّ خصوصية كي لا يكشف الرقمُ عميلاً بعينه.
 *   - الأشهر الصفرية تُحتسب، والاقتطاع للصفر على **مجموع** الصنف لا على كل شهر.
 *   - صنفٌ يهيمن عليه مشترٍ واحد (>٥٠٪ من المجموع) لا تُعرض كمّيته.
 *   - الموقع يُثبَّت على شبكة (~٥٠٠ م) كي لا تُستخرج قيم فردية بتحريك النقطة قليلاً.
 *   - لا دمج بين الشركات، ولا ضرب للانتشار في الوسيط.
 */

export const ENGINE_VERSION = 'ai-est-1';

/** حلقات البحث عن المحلات المشابهة (كم)؛ الأخيرة = كل مناطق الشركة. */
export const RINGS_KM = [1, 2, 5, 10, 25, Infinity] as const;
export const MAX_PEERS = 30;
const MIN_ACTIVE_MONTHS = 3;
const RECENT_DAYS = 60;
const SNAP_DEG = 0.005;

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface PeerCustomer {
  id: string;
  lat: number;
  lng: number;
  outletType: string;
  /** شهر أول فاتورة بيع له (YYYY-MM بتوقيت الشركة) — أقدميته. */
  firstYm: string | null;
  /** لحظة آخر فاتورة بيع. */
  lastInvoiceAt: Date | null;
}

/** صافي شهر لعميل × صنف: المبيعات موجبة والمرتجعات سالبة (بلا ضريبة للقيمة). */
export interface PeerProductMonth {
  customerId: string;
  productId: string;
  ym: string;
  qty: number;
  value: number;
}

/** بنود الفاتورة الأولى لكل عميل. */
export interface FirstOrderLine {
  customerId: string;
  productId: string;
  qty: number;
}

export interface EngineProduct {
  id: string;
  name: string;
  unit: string;
  priority?: boolean;
}

export interface EngineInput {
  target: { lat: number; lng: number; outletType: string; excludeCustomerId?: string | null };
  now: Date;
  window: { from: string; to: string };
  peers: PeerCustomer[];
  monthly: PeerProductMonth[];
  firstOrders: FirstOrderLine[];
  products: EngineProduct[];
  minPeers: number;
  showMoney: boolean;
  /** معامل معايرة الطلب التجريبي المتعلَّم (حلقة التعلّم) — ١ = بلا معايرة. لا يمسّ أرقام المحلات المشابهة. */
  trialFactor?: number;
  /** نسخة المعايرة المستعملة (تُحفظ في لقطة التحويل). */
  calibrationVersion?: number | null;
}

export interface Range { low: number; median: number; high: number }

export interface ProductEstimate {
  productId: string;
  name: string;
  unit: string;
  priority: boolean;
  /** عدد المحلات المشابهة التي تشتريه، ومن أصل كم. */
  /** null للصنف المحجوب لقلّة مشتريه (أقل من الحدّ) — لا عدد يكشف عميلاً بعينه. */
  buyers: number | null;
  peers: number;
  penetration: number | null;
  /** الكمية الشهرية المتوقعة إن اشتراه (null = لا تكفي البيانات أو مهيمَن). */
  monthlyQty: Range | null;
  monthlyValue: Range | null;
  /** أول طلب متوقع (null = لا تكفي البيانات). */
  firstOrderQty: number | null;
  /** طلب تجريبي مقترح كما يُعرض (null = الصنف ليس واسع الانتشار) — مُعايَر إن وُجدت معايرة. */
  trialQty: number | null;
  /** الطلب التجريبي قبل المعايرة (للقياس). */
  trialQtyRaw: number | null;
  /** هل عُويِر الطلب التجريبي بأول طلبات العملاء الجدد الفعلية؟ */
  trialCalibrated: boolean;
  confidence: Confidence;
  hidden: null | 'FEW_BUYERS' | 'DOMINANT';
}

export type EstimateResult =
  | {
      ok: true;
      engineVersion: string;
      outletType: string;
      ringKm: number | null; // null = كل مناطق الشركة
      peers: number;
      medianTenureMonths: number;
      confidence: Confidence;
      window: { from: string; to: string };
      /** إجمالي المشتريات الشهرية المتوقعة للمحل (null إن أُخفي المال). */
      monthlyTotalValue: Range | null;
      products: ProductEstimate[];
      why: string;
      /** نسخة معايرة الطلب التجريبي المطبّقة (null = بلا معايرة). */
      calibrationVersion?: number | null;
    }
  | {
      ok: false;
      engineVersion: string;
      outletType: string;
      reason: 'INSUFFICIENT_PEERS';
      eligiblePeers: number;
      minPeers: number;
      window: { from: string; to: string };
      why: string;
    };

// ───────────── أدوات رياضية ─────────────

/** لوغاريتم غاما (تقريب Lanczos). */
function lnGamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** الكسر المستمر لدالة بيتا غير التامة (Lentz). */
function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** دالة بيتا غير التامة المنظَّمة I_x(a,b). */
export function regIncBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * مقدِّر Harrell–Davis للمئين p: متوسطٌ موزون لكل القيم المرتّبة، فلا يساوي قيمةَ عميلٍ
 * بعينه كما يفعل الوسيط العادي في مجموعة صغيرة.
 */
export function harrellDavis(values: readonly number[], p: number): number {
  const x = [...values].sort((a, b) => a - b);
  const n = x.length;
  if (n === 0) return NaN;
  if (n === 1) return x[0];
  const a = p * (n + 1), b = (1 - p) * (n + 1);
  let sum = 0, prev = 0;
  for (let i = 1; i <= n; i++) {
    const cur = regIncBeta(i / n, a, b);
    sum += (cur - prev) * x[i - 1];
    prev = cur;
  }
  return sum;
}

function plainMedian(values: readonly number[]): number {
  const x = [...values].sort((a, b) => a - b);
  const n = x.length;
  if (!n) return 0;
  return n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2;
}

function hdRange(values: readonly number[]): Range {
  return { low: harrellDavis(values, 0.25), median: harrellDavis(values, 0.5), high: harrellDavis(values, 0.75) };
}

// ───────────── أدوات المكان والزمن ─────────────

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** تثبيت الموقع على شبكة ~٥٠٠ م (مركز الخلية). */
export function snapPoint(lat: number, lng: number): { lat: number; lng: number } {
  const snap = (v: number) => Math.floor(v / SNAP_DEG) * SNAP_DEG + SNAP_DEG / 2;
  return { lat: +snap(lat).toFixed(6), lng: +snap(lng).toFixed(6) };
}

export function ymIndex(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

export function ymFromIndex(i: number): string {
  const y = Math.floor(i / 12), m = (i % 12) + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** عدد الأشهر الفعلية للعميل داخل النافذة (من أول فاتورة له أو بداية النافذة، أيّهما أحدث). */
export function activeMonths(firstYm: string | null, window: { from: string; to: string }): number {
  if (!firstYm) return 0;
  const start = Math.max(ymIndex(window.from), ymIndex(firstYm));
  const end = ymIndex(window.to);
  return end >= start ? end - start + 1 : 0;
}

// ───────────── التقريب للعرض ─────────────

/** كمية للعرض: أقل من ١ بمنزلة عشرية، وغير ذلك عدد صحيح (لا دقّة زائفة). */
export function roundQty(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 1 ? Math.round(v * 10) / 10 : Math.round(v);
}

/** قيمة مالية للعرض: لأقرب ١٠ تحت الألف، ولأقرب ٥٠ فوقها. */
export function roundMoney(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v < 1000 ? Math.round(v / 10) * 10 : Math.round(v / 50) * 50;
}

function roundRange(r: Range, fn: (v: number) => number): Range {
  return { low: fn(r.low), median: fn(r.median), high: fn(r.high) };
}

function lowerConfidence(c: Confidence): Confidence {
  return c === 'HIGH' ? 'MEDIUM' : 'LOW';
}

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
export function ymLabelAr(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${AR_MONTHS[m - 1]} ${y}`;
}

function ringLabel(ringKm: number | null): string {
  return ringKm == null ? 'في كل مناطق شركتك' : `ضمن ${ringKm} كم من المحل`;
}

// ───────────── المحرّك ─────────────

export function estimateOutlet(input: EngineInput, typeLabel: string): EstimateResult {
  const { window, minPeers } = input;
  const snapped = snapPoint(input.target.lat, input.target.lng);
  const recentCutoff = input.now.getTime() - RECENT_DAYS * 86400000;

  // الأهلية: النوع نفسه، أقدمية ٣ أشهر فعلية داخل النافذة، وفاتورة خلال ٦٠ يوماً
  const eligible = input.peers
    .filter(p => p.outletType === input.target.outletType)
    .filter(p => p.id !== input.target.excludeCustomerId)
    .filter(p => activeMonths(p.firstYm, window) >= MIN_ACTIVE_MONTHS)
    .filter(p => p.lastInvoiceAt != null && p.lastInvoiceAt.getTime() >= recentCutoff)
    .map(p => ({ p, km: haversineKm(snapped.lat, snapped.lng, p.lat, p.lng) }))
    .sort((a, b) => a.km - b.km);

  let ringKm: number | null = null;
  let chosen: typeof eligible | null = null;
  for (const r of RINGS_KM) {
    const inRing = eligible.filter(e => e.km <= r);
    if (inRing.length >= minPeers) {
      chosen = inRing.slice(0, MAX_PEERS);
      ringKm = Number.isFinite(r) ? r : null;
      break;
    }
  }

  if (!chosen) {
    return {
      ok: false, engineVersion: ENGINE_VERSION, outletType: input.target.outletType,
      reason: 'INSUFFICIENT_PEERS', eligiblePeers: eligible.length, minPeers, window,
      why: `لا تكفي بيانات شركتك لتقدير رقم: ${eligible.length} من «${typeLabel}» فقط بمبيعات منتظمة، والحد الأدنى ${minPeers}. صنّف أنواع عملائك وأضف مواقعهم ليتحسّن التقدير.`,
    };
  }

  const peerIds = new Set(chosen.map(c => c.p.id));
  const months = new Map(chosen.map(c => [c.p.id, activeMonths(c.p.firstYm, window)]));
  const fromIdx = ymIndex(window.from), toIdx = ymIndex(window.to);

  // صافي كل (عميل، صنف) داخل النافذة — الاقتطاع للصفر على المجموع
  const totals = new Map<string, { qty: number; value: number }>();
  for (const r of input.monthly) {
    if (!peerIds.has(r.customerId)) continue;
    const i = ymIndex(r.ym);
    if (i < fromIdx || i > toIdx) continue;
    const k = `${r.customerId}|${r.productId}`;
    const t = totals.get(k) ?? { qty: 0, value: 0 };
    t.qty += r.qty; t.value += r.value;
    totals.set(k, t);
  }
  const perPeer = (customerId: string, productId: string) => {
    const t = totals.get(`${customerId}|${productId}`);
    const m = months.get(customerId) || 1;
    return { qty: Math.max(0, t?.qty ?? 0) / m, value: Math.max(0, t?.value ?? 0) / m };
  };

  const peersN = chosen.length;
  const tenures = chosen.map(c => months.get(c.p.id) ?? 0);
  // الأقدمية بوسيط عادي لا Harrell–Davis: سقفها طول النافذة، والمتوسط الموزون لا يبلغ السقف إلا إن بلغه الجميع
  const medianTenure = plainMedian(tenures);
  const tenureNeeded = Math.min(6, ymIndex(window.to) - ymIndex(window.from) + 1);
  const near = ringKm != null && ringKm <= 2;
  const confidence: Confidence = ringKm == null ? 'LOW' : near && peersN >= 8 && medianTenure >= tenureNeeded ? 'HIGH' : 'MEDIUM';

  // أول طلب لكل عميل مشابه
  const firstByPeer = new Map<string, Map<string, number>>();
  for (const f of input.firstOrders) {
    if (!peerIds.has(f.customerId)) continue;
    const m = firstByPeer.get(f.customerId) ?? new Map<string, number>();
    m.set(f.productId, (m.get(f.productId) ?? 0) + f.qty);
    firstByPeer.set(f.customerId, m);
  }

  const products: ProductEstimate[] = [];
  for (const prod of input.products) {
    const rows = chosen.map(c => perPeer(c.p.id, prod.id));
    const buyerRows = rows.filter(r => r.qty > 0);
    const buyers = buyerRows.length;
    if (buyers === 0 && !prod.priority) continue;
    const penetration = buyers / peersN;

    let hidden: ProductEstimate['hidden'] = null;
    let monthlyQty: Range | null = null;
    let monthlyValue: Range | null = null;
    let pConf: Confidence = confidence;
    if (buyers >= minPeers) {
      const qtys = buyerRows.map(r => r.qty);
      const sum = qtys.reduce((a, b) => a + b, 0);
      if (sum > 0 && Math.max(...qtys) / sum > 0.5) {
        hidden = 'DOMINANT';
      } else {
        const r = hdRange(qtys);
        if (r.median > 0 && (r.high - r.low) / r.median > 1) pConf = lowerConfidence(pConf);
        monthlyQty = roundRange(r, roundQty);
        if (input.showMoney) monthlyValue = roundRange(hdRange(buyerRows.map(x => x.value)), roundMoney);
      }
    } else if (buyers > 0) {
      hidden = 'FEW_BUYERS';
    }

    // أول طلب: من بين المشابهين الذين كان الصنف في فاتورتهم الأولى
    const fo: number[] = [];
    for (const c of chosen) {
      const q = firstByPeer.get(c.p.id)?.get(prod.id);
      if (q != null && q > 0) fo.push(q);
    }
    const firstOrderQty = fo.length >= minPeers ? Math.max(1, roundQty(harrellDavis(fo, 0.5))) : null;

    // طلب تجريبي: للأصناف التي يشتريها نصف المشابهين فأكثر، ولها رقم معروض — ومعايرته (إن وُجدت) عليه وحده
    let trialQty: number | null = null;
    let trialQtyRaw: number | null = null;
    let trialCalibrated = false;
    if (penetration >= 0.5 && hidden === null && monthlyQty) {
      const base = firstOrderQty ?? monthlyQty.low;
      trialQtyRaw = Math.max(1, Math.round(base));
      const f = input.trialFactor ?? 1;
      trialCalibrated = Number.isFinite(f) && f > 0 && f !== 1;
      trialQty = trialCalibrated ? Math.max(1, Math.round(base * f)) : trialQtyRaw;
    }

    products.push({
      productId: prod.id, name: prod.name, unit: prod.unit, priority: !!prod.priority,
      buyers: hidden === 'FEW_BUYERS' ? null : buyers, peers: peersN,
      penetration: hidden === 'FEW_BUYERS' ? null : Math.round(penetration * 100) / 100,
      monthlyQty, monthlyValue, firstOrderQty, trialQty, trialQtyRaw, trialCalibrated, confidence: pConf, hidden,
    });
  }

  products.sort((a, b) =>
    Number(b.priority) - Number(a.priority) ||
    (b.penetration ?? 0) - (a.penetration ?? 0) ||
    (b.monthlyValue?.median ?? 0) - (a.monthlyValue?.median ?? 0) ||
    a.name.localeCompare(b.name, 'ar'));

  // إجمالي المحل الشهري: الصفر محتسب لمن لا يشتري شيئاً
  let monthlyTotalValue: Range | null = null;
  if (input.showMoney) {
    const perPeerTotal = chosen.map(c => input.products.reduce((s, prod) => s + perPeer(c.p.id, prod.id).value, 0));
    monthlyTotalValue = roundRange(hdRange(perPeerTotal), roundMoney);
  }

  return {
    ok: true, engineVersion: ENGINE_VERSION, outletType: input.target.outletType,
    ringKm, peers: peersN, medianTenureMonths: Math.round(medianTenure), confidence, window,
    monthlyTotalValue, products,
    calibrationVersion: products.some(p => p.trialCalibrated) ? input.calibrationVersion ?? null : null,
    why: `مبني على ${peersN} من «${typeLabel}» من عملاء شركتك ${ringLabel(ringKm)}، ومشترياتها الفعلية من ${ymLabelAr(window.from)} إلى ${ymLabelAr(window.to)}.`,
  };
}

/** نافذة الأشهر المكتملة: آخرها الشهر السابق لشهر `now` المحلي. */
export function completeWindow(nowLocalYm: string, months: number): { from: string; to: string } {
  const to = ymIndex(nowLocalYm) - 1;
  return { from: ymFromIndex(to - (months - 1)), to: ymFromIndex(to) };
}

/** شهر لحظةٍ ما بمنطقة زمنية (YYYY-MM). */
export function ymInTz(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  return `${y}-${m}`;
}
