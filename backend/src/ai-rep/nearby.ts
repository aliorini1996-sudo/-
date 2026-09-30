/**
 * المندوب الذكي — دمج نتائج Google بسجلّ الشركة (دالة صرفة).
 *
 *   - نوع المحل: من نوع Google مقيّداً بالأنواع المستهدفة؛ ما لا يطابقها يُسقط.
 *   - عميل قائم: مطابقة place_id (أو التحويل) أولاً، ثم بالقرب **واحداً لواحد**: أزواج (محل، عميل) ضمن ٤٠ م مرتّبة
 *     بالمسافة، يأخذ كل عميل أقرب محل له ولا يُلصق بمحلين («ربما عميل حالي») — فلا يَسِم عميلٌ واحد صفّ محلات بجواره.
 *   - عزل العملاء: العملاء غير المرئيين لهذا المندوب **لا يدخلون المطابقة أصلاً** — فلا يُسقط محلٌّ ولا يُوسم
 *     بسببهم (الإسقاط نفسه كان يكشف موقع عميل الزميل بمجرّد غياب المحل من القائمة). التكرار عند «أضفه عميلاً»
 *     يمنعه الخادم عند الإنشاء برسالة محايدة لا تسمّي المندوب المالك.
 *   - الإخفاء بزمن لا إلى الأبد: «مغلق الآن» وبلاغ «لم أجده» الواحد يُخفيان المحل بقية اليوم فقط، و«لم أجده» المؤكَّد
 *     (بلاغان من مندوبين أو في يومين — status CLOSED) يُخفيه CLOSED_MEMORY_DAYS ثم يعود موسوماً «أُبلغ أنه مغلق» آخر
 *     القائمة؛ والوسم نفسه بزمن (REJECT_MEMORY_DAYS) كالمرفوض. العميل (القائم أو المحتمل) لا يُخفى أبداً.
 *   - المرفوض خلال ٣٠ يوماً ينزل آخر القائمة موسوماً.
 * الترتيب: الجديد أولاً (الأقرب فالأبعد)، ثم العملاء القائمون، ثم المرفوض حديثاً والمُبلَّغ عن إغلاقه.
 */
import { haversineKm } from './estimate';
import { outletTypeFromGoogle, OutletTypeCode } from './taxonomy';
import type { NearbyPlace } from './places';

export const MATCH_RADIUS_M = 40;
export const REJECT_MEMORY_DAYS = 30;
/** «أُغلق نهائياً / لم أجده» المؤكَّد يُخفي المحل هذه المدّة ثم يعود موسوماً آخر القائمة. */
export const CLOSED_MEMORY_DAYS = 75;
const DAY_MS = 86_400_000;
const REJECT_KINDS = new Set(['NOT_INTERESTED', 'EXCLUSIVE_SUPPLIER']);
/** نتيجتا الإغلاق: «مغلق الآن» (لحظيّ) و«أُغلق نهائياً / لم أجده». */
export const CLOSED_KINDS = new Set(['CLOSED', 'NOT_FOUND']);

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
/** اليوم نفسه بتوقيت الرياض (كيوم الحصص usageDay). */
export const sameDay = (a: Date, b: Date): boolean => DAY_FMT.format(a) === DAY_FMT.format(b);

export interface CustomerPin {
  id: string;
  lat: number | null;
  lng: number | null;
  outletType: string | null;
  aiPlaceId: string | null;
  /** مرئي لهذا المندوب (عزل العملاء). */
  visible: boolean;
}

export interface OutletMemory {
  placeId: string | null;
  status: string;
  lastOutcome: string | null;
  lastOutcomeAt: Date | null;
  convertedCustomerId: string | null;
}

export type Relation = 'NEW' | 'CUSTOMER' | 'POSSIBLE_CUSTOMER';

export interface NearbyItem {
  placeId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  outletType: OutletTypeCode;
  distanceM: number;
  relation: Relation;
  customerId: string | null;
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  rejectedRecently: boolean;
  /** أُبلغ أنه أُغلق نهائياً أو لم يُعثر عليه (بعد انقضاء إخفائه) — آخر القائمة وخارج الخطة */
  reportedClosed: boolean;
}

/** هل تُخفي ذاكرة المحل إياه الآن؟ «لم أجده» المؤكَّد CLOSED_MEMORY_DAYS، و«مغلق الآن» والبلاغ الواحد بقية اليوم. */
export function hiddenByMemory(mem: OutletMemory | null, now: Date): boolean {
  if (!mem?.lastOutcome || !mem.lastOutcomeAt || !CLOSED_KINDS.has(mem.lastOutcome)) return false;
  if (mem.lastOutcome === 'NOT_FOUND' && mem.status === 'CLOSED') return mem.lastOutcomeAt.getTime() >= now.getTime() - CLOSED_MEMORY_DAYS * DAY_MS;
  return sameDay(mem.lastOutcomeAt, now);
}

/**
 * وسم «أُبلغ أنه مغلق» بزمن كالمرفوض لا إلى الأبد: البلاغ الواحد REJECT_MEMORY_DAYS، والمؤكَّد REJECT_MEMORY_DAYS بعد
 * انقضاء إخفائه — وإلا أخرج بلاغٌ خاطئ واحد المحلَّ من خطط الفريق كلها بلا رجعة (لا يُقترح فلا يزوره أحد فيصحّحه).
 */
export function reportedClosedByMemory(mem: OutletMemory | null, now: Date): boolean {
  if (mem?.lastOutcome !== 'NOT_FOUND' || !mem.lastOutcomeAt) return false;
  const days = (mem.status === 'CLOSED' ? CLOSED_MEMORY_DAYS : 0) + REJECT_MEMORY_DAYS;
  return mem.lastOutcomeAt.getTime() >= now.getTime() - days * DAY_MS;
}

/** صندوق العملاء المرشّحين للمطابقة: حدود المحلات المدموجة نفسها + هامش (لا نصف قطر البحث — المسح يُبقي محلات أبعد منه). */
export function customerBox(places: { lat: number; lng: number }[], padM = MATCH_RADIUS_M + 50): { minLat: number; maxLat: number; minLng: number; maxLng: number } | null {
  if (!places.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of places) {
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  const dLat = padM / 111320;
  const dLng = dLat / Math.max(0.2, Math.cos((Math.max(Math.abs(minLat), Math.abs(maxLat)) * Math.PI) / 180));
  return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLng: minLng - dLng, maxLng: maxLng + dLng };
}

export function mergeNearby(places: NearbyPlace[], opts: {
  origin: { lat: number; lng: number };
  targetTypes: readonly string[];
  customers: CustomerPin[];
  outlets: OutletMemory[];
  isolation: boolean;
  now: Date;
  /** للدراسة بضغطة المندوب: المحل المخفي يُعاد بذاكرته بدل أن يُسقط */
  keepHidden?: boolean;
}): NearbyItem[] {
  // مع العزل: المرئيون وحدهم — العميل المحجوب لا يغيّر المخرجات بأي أثر
  const pool = opts.isolation ? opts.customers.filter(c => c.visible) : opts.customers;
  const byPlace = new Map<string, CustomerPin>();
  for (const c of pool) if (c.aiPlaceId) byPlace.set(c.aiPlaceId, c);
  const byId = new Map(pool.map(c => [c.id, c]));
  const memory = new Map<string, OutletMemory>();
  for (const o of opts.outlets) if (o.placeId) memory.set(o.placeId, o);
  const rejectCutoff = opts.now.getTime() - REJECT_MEMORY_DAYS * DAY_MS;

  // ١) المطابقة الصريحة: معرّف المكان أو التحويل
  type Row = { p: NearbyPlace; outletType: OutletTypeCode; mem: OutletMemory | null; relation: Relation; customer: CustomerPin | null };
  const rows: Row[] = [];
  const claimed = new Set<string>();
  for (const p of places) {
    const outletType = outletTypeFromGoogle(p.primaryType, p.types, opts.targetTypes);
    if (!outletType) continue;
    let mem = memory.get(p.placeId) ?? null;
    // مع العزل: محلٌّ حُوِّل لعميل غير مرئي لهذا المندوب يُعامَل كأن لا ذاكرة له (الوسم نفسه يكشف عميل الزميل)
    if (opts.isolation && mem?.status === 'CONVERTED' && !(mem.convertedCustomerId && byId.has(mem.convertedCustomerId))) mem = null;
    let relation: Relation = 'NEW';
    let customer: CustomerPin | null = byPlace.get(p.placeId) ?? null;
    if (!customer && mem?.convertedCustomerId) customer = byId.get(mem.convertedCustomerId) ?? null;
    if (customer) {
      relation = 'CUSTOMER';
      claimed.add(customer.id);
    } else if (mem?.status === 'CONVERTED' && !opts.isolation) {
      relation = 'CUSTOMER'; // حُوِّل ثم حُذف العميل أو لا نعرف موقعه — لا يُعرض كجديد (ومع العزل: قد يكون عميل زميل ⇒ لا وسم)
    }
    rows.push({ p, outletType, mem, relation, customer });
  }

  // ٢) البقية بالقرب، واحداً لواحد: الأقرب أولاً (والنوع المطابق قبل العميل بلا نوع عند التساوي)
  const pairs: { r: Row; c: CustomerPin; m: number; typed: boolean }[] = [];
  for (const r of rows) {
    if (r.relation !== 'NEW') continue;
    for (const c of pool) {
      if (c.lat == null || c.lng == null || claimed.has(c.id)) continue;
      if (c.outletType && c.outletType !== r.outletType) continue;
      const m = haversineKm(r.p.lat, r.p.lng, c.lat, c.lng) * 1000;
      if (m <= MATCH_RADIUS_M) pairs.push({ r, c, m, typed: !!c.outletType });
    }
  }
  pairs.sort((a, b) => a.m - b.m || Number(b.typed) - Number(a.typed));
  for (const x of pairs) {
    if (x.r.customer || claimed.has(x.c.id)) continue;
    x.r.customer = x.c; x.r.relation = 'POSSIBLE_CUSTOMER';
    claimed.add(x.c.id);
  }

  const out: NearbyItem[] = [];
  for (const { p, outletType, mem, relation, customer } of rows) {
    // الإخفاء بعد المطابقة: العميل القائم أو المحتمل لا يُخفى أبداً
    const hidden = relation === 'NEW' && hiddenByMemory(mem, opts.now);
    if (hidden && !opts.keepHidden) continue;
    const rejectedRecently = !!mem?.lastOutcome && REJECT_KINDS.has(mem.lastOutcome)
      && !!mem.lastOutcomeAt && mem.lastOutcomeAt.getTime() >= rejectCutoff;
    out.push({
      placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, outletType,
      distanceM: Math.round(haversineKm(opts.origin.lat, opts.origin.lng, p.lat, p.lng) * 1000),
      relation,
      customerId: customer && customer.visible ? customer.id : null,
      lastOutcome: mem?.lastOutcome ?? null,
      lastOutcomeAt: mem?.lastOutcomeAt ? mem.lastOutcomeAt.toISOString() : null,
      rejectedRecently,
      reportedClosed: relation === 'NEW' && reportedClosedByMemory(mem, opts.now),
    });
  }

  const group = (i: NearbyItem) => (i.rejectedRecently || i.reportedClosed ? 2 : i.relation === 'NEW' ? 0 : 1);
  return out.sort((a, b) => group(a) - group(b) || a.distanceM - b.distanceM);
}
