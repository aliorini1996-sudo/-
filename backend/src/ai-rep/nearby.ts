/**
 * المندوب الذكي — دمج نتائج Google بسجلّ الشركة (دالة صرفة).
 *
 *   - نوع المحل: من نوع Google مقيّداً بالأنواع المستهدفة؛ ما لا يطابقها يُسقط.
 *   - عميل قائم: مطابقة place_id أولاً، ثم أقرب عميل ضمن ٤٠ م من النوع نفسه («ربما عميل حالي»).
 *   - عزل العملاء: العملاء غير المرئيين لهذا المندوب **لا يدخلون المطابقة أصلاً** — فلا يُسقط محلٌّ ولا يُوسم
 *     بسببهم (الإسقاط نفسه كان يكشف موقع عميل الزميل بمجرّد غياب المحل من القائمة). التكرار عند «أضفه عميلاً»
 *     يمنعه الخادم عند الإنشاء برسالة محايدة لا تسمّي المندوب المالك.
 *   - المغلق يُسقط، والمرفوض خلال ٣٠ يوماً ينزل آخر القائمة موسوماً.
 * الترتيب: الجديد أولاً (الأقرب فالأبعد)، ثم العملاء القائمون، ثم المرفوض حديثاً.
 */
import { haversineKm } from './estimate';
import { outletTypeFromGoogle, OutletTypeCode } from './taxonomy';
import type { NearbyPlace } from './places';

export const MATCH_RADIUS_M = 40;
export const REJECT_MEMORY_DAYS = 30;
const REJECT_KINDS = new Set(['NOT_INTERESTED', 'EXCLUSIVE_SUPPLIER']);

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
}

export function mergeNearby(places: NearbyPlace[], opts: {
  origin: { lat: number; lng: number };
  targetTypes: readonly string[];
  customers: CustomerPin[];
  outlets: OutletMemory[];
  isolation: boolean;
  now: Date;
}): NearbyItem[] {
  // مع العزل: المرئيون وحدهم — العميل المحجوب لا يغيّر المخرجات بأي أثر
  const pool = opts.isolation ? opts.customers.filter(c => c.visible) : opts.customers;
  const byPlace = new Map<string, CustomerPin>();
  for (const c of pool) if (c.aiPlaceId) byPlace.set(c.aiPlaceId, c);
  const byId = new Map(pool.map(c => [c.id, c]));
  const memory = new Map<string, OutletMemory>();
  for (const o of opts.outlets) if (o.placeId) memory.set(o.placeId, o);
  const rejectCutoff = opts.now.getTime() - REJECT_MEMORY_DAYS * 86400000;

  const out: NearbyItem[] = [];
  for (const p of places) {
    const outletType = outletTypeFromGoogle(p.primaryType, p.types, opts.targetTypes);
    if (!outletType) continue;
    const mem = memory.get(p.placeId) ?? null;
    if (mem?.status === 'CLOSED') continue;

    let relation: Relation = 'NEW';
    let customer: CustomerPin | null = byPlace.get(p.placeId) ?? null;
    if (!customer && mem?.convertedCustomerId) customer = byId.get(mem.convertedCustomerId) ?? null;
    if (customer) {
      relation = 'CUSTOMER';
    } else if (mem?.status === 'CONVERTED' && !opts.isolation) {
      relation = 'CUSTOMER'; // حُوِّل ثم حُذف العميل أو لا نعرف موقعه — لا يُعرض كجديد (ومع العزل: قد يكون عميل زميل ⇒ لا وسم)
    } else {
      let best: { c: CustomerPin; m: number } | null = null;
      for (const c of pool) {
        if (c.lat == null || c.lng == null) continue;
        if (c.outletType && c.outletType !== outletType) continue;
        const m = haversineKm(p.lat, p.lng, c.lat, c.lng) * 1000;
        if (m <= MATCH_RADIUS_M && (!best || m < best.m)) best = { c, m };
      }
      if (best) { customer = best.c; relation = 'POSSIBLE_CUSTOMER'; }
    }
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
    });
  }

  const group = (i: NearbyItem) => (i.rejectedRecently ? 2 : i.relation === 'NEW' ? 0 : 1);
  return out.sort((a, b) => group(a) - group(b) || a.distanceM - b.distanceM);
}
