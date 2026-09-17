/**
 * مفاتيح المصادر (M3، DESIGN.md §5.2، §5.3، §5.4، §6.1) — النسخة المرجعية.
 *
 * كل مفتاح يُكتب في gl_source_events.sourceKey وgl_move_sources.sourceKey بقيد فريد [tenantId, sourceKey]:
 *   INVOICE:<id>:POST | INVOICE:<id>:REVERSE | INVOICE:<id>:COGS | INVOICE:<id>:RESTOCK:<generation>
 *   RECEIPT:<id>:POST | RECEIPT:<id>:REVERSE
 *   AR_ENTRY:<entryId>:POST | AR_ENTRY:<entryId>:REVERSE
 *   SETTLEMENT:<id>:POST | SETTLEMENT:<id>:REVERSE
 *   PAYLINK_FEE:<entryId> | PAYOUT:<payoutId> | WH_ENTRY:<id> | VAN_LOAD:<id>:POST
 *   CUSTODY_SHORTAGE:<id>:POST|REVERSE (M4)
 * «إعادة الترحيل من المصدر» (§6.1): <base>:REPOST:<n> و<base>:REPOST_REV:<n> حيث <base> مفتاح POST الأصلي،
 * فيبقى الثلاثة تحت نمط `<base>*` («القيد الحيّ» = آخر GlMoveSource تحت النمط ليس لقيده reversal).
 *
 * مفاتيح الـbuilders في M1 (receiptKey، settlementKey، arEntryEventKey، paylinkFeeKey، payoutKey) تُعاد تصديرها أو
 * تطابقها حرفياً؛ اختبار gl-sync-classify يتحقق من التطابق.
 */
import { receiptKey as builderReceiptKey } from '../builders/receipt';
import { settlementKey as builderSettlementKey } from '../builders/custody';
import { paylinkFeeKey as builderPaylinkFeeKey, payoutKey as builderPayoutKey } from '../builders/paylink';
import type { SourceEvent, SourceType } from '../types';

export type PostOrReverse = Extract<SourceEvent, 'POST' | 'REVERSE'>;

export const invoiceKey = (invoiceId: string, event: Extract<SourceEvent, 'POST' | 'REVERSE' | 'COGS'>): string =>
  `INVOICE:${invoiceId}:${event}`;
export const invoiceRestockKey = (invoiceId: string, generation: number): string => `INVOICE:${invoiceId}:RESTOCK:${generation}`;
export const receiptKey = builderReceiptKey;
/** صف AccountEntry بلا فاتورة ولا سند (§5.2) — ومفتاح «تسوية ذمة عميل» M4 */
export const arEntryKey = (entryId: string, event: PostOrReverse = 'POST'): string => `AR_ENTRY:${entryId}:${event}`;
export const settlementKey = builderSettlementKey;
export const paylinkFeeKey = builderPaylinkFeeKey;
export const payoutKey = builderPayoutKey;
export const whEntryKey = (entryId: string): string => `WH_ENTRY:${entryId}`;
export const vanLoadKey = (loadId: string): string => `VAN_LOAD:${loadId}:POST`;
export const custodyShortageKey = (shortageId: string, event: PostOrReverse = 'POST'): string => `CUSTODY_SHORTAGE:${shortageId}:${event}`;

/** مفتاح POST (الأساس) لكل مصدر: ما تُقارن به بوابة الأشقاء وREPOST */
export function postKeyOf(sourceType: SourceType, sourceId: string): string {
  switch (sourceType) {
    case 'INVOICE': return invoiceKey(sourceId, 'POST');
    case 'RECEIPT': return receiptKey(sourceId, 'POST');
    case 'AR_ENTRY':
    case 'CUSTOMER_ADJUSTMENT': return arEntryKey(sourceId, 'POST');
    case 'SETTLEMENT': return settlementKey(sourceId, 'POST');
    case 'PAYLINK_FEE': return paylinkFeeKey(sourceId);
    case 'PAYOUT': return payoutKey(sourceId);
    case 'WH_ENTRY': return whEntryKey(sourceId);
    case 'VAN_LOAD': return vanLoadKey(sourceId);
    case 'RESTOCK': return invoiceKey(sourceId, 'POST');
  }
}

/** مفتاح REVERSE لمصادر لها عكس؛ null لغيرها */
export function reverseKeyOf(sourceType: SourceType, sourceId: string): string | null {
  switch (sourceType) {
    case 'INVOICE': return invoiceKey(sourceId, 'REVERSE');
    case 'RECEIPT': return receiptKey(sourceId, 'REVERSE');
    case 'AR_ENTRY':
    case 'CUSTOMER_ADJUSTMENT': return arEntryKey(sourceId, 'REVERSE');
    case 'SETTLEMENT': return settlementKey(sourceId, 'REVERSE');
    default: return null;
  }
}

export const repostKey = (baseKey: string, n: number): string => `${baseKey}:REPOST:${n}`;
export const repostRevKey = (baseKey: string, n: number): string => `${baseKey}:REPOST_REV:${n}`;

/** هل المفتاح تحت نمط `<base>*` («القيد الحيّ»، §5.4، §6.1)؟ الأساس نفسه أو REPOST/REPOST_REV منه */
export function isUnderPostPattern(key: string, baseKey: string): boolean {
  return key === baseKey || key.startsWith(`${baseKey}:REPOST:`) || key.startsWith(`${baseKey}:REPOST_REV:`);
}

/** n التالي = 1 + عدد مفاتيح REPOST القائمة للأساس (§6.1) */
export function nextRepostIndex(existingKeys: readonly string[], baseKey: string): number {
  return 1 + existingKeys.filter((k) => k.startsWith(`${baseKey}:REPOST:`)).length;
}

/** CUSTODY_SHORTAGE (M4، P27) ليس ضمن SOURCE_TYPES بعد */
export type KeySourceType = SourceType | 'CUSTODY_SHORTAGE';

export interface ParsedSourceKey {
  sourceType: KeySourceType;
  sourceId: string;
  event: SourceEvent;
  /** مفتاح POST الأساس للمصدر (دون لاحقة REPOST) */
  baseKey: string;
  /** لاحقة «إعادة الترحيل من المصدر» */
  repost: { kind: 'REPOST' | 'REPOST_REV'; n: number } | null;
  /** INVOICE:<id>:RESTOCK:<generation> */
  generation: number | null;
}

const ID = '([^:]+)';
const POS_INT = '([1-9]\\d*)';

/**
 * تحليل مفتاح؛ null لشكل غير معروف. أحداث مفاتيح بلا لاحقة (PAYLINK_FEE/PAYOUT/WH_ENTRY) حدثها POST.
 * لمفتاح REPOST_REV يكون event = REVERSE، ولـREPOST يكون POST.
 */
export function parseSourceKey(key: string): ParsedSourceKey | null {
  let m: RegExpExecArray | null;
  const repostSuffix = `(?::(REPOST|REPOST_REV):${POS_INT})?`;
  const withRepost = (sourceType: SourceType, sourceId: string, baseKey: string, baseEvent: SourceEvent, r?: string, n?: string, extra: Partial<ParsedSourceKey> = {}): ParsedSourceKey => ({
    sourceType, sourceId, baseKey,
    event: r === 'REPOST_REV' ? 'REVERSE' : baseEvent,
    repost: r ? { kind: r as 'REPOST' | 'REPOST_REV', n: Number(n) } : null,
    generation: null, ...extra,
  });

  if ((m = new RegExp(`^INVOICE:${ID}:RESTOCK:(0|${POS_INT.slice(1, -1)})$`).exec(key))) {
    return { sourceType: 'RESTOCK', sourceId: m[1], event: 'RESTOCK', baseKey: invoiceKey(m[1], 'POST'), repost: null, generation: Number(m[2]) };
  }
  if ((m = new RegExp(`^INVOICE:${ID}:COGS$`).exec(key))) {
    return { sourceType: 'INVOICE', sourceId: m[1], event: 'COGS', baseKey: invoiceKey(m[1], 'POST'), repost: null, generation: null };
  }
  if ((m = new RegExp(`^(INVOICE|RECEIPT|AR_ENTRY|SETTLEMENT):${ID}:POST${repostSuffix}$`).exec(key))) {
    const t = m[1] as SourceType;
    return withRepost(t, m[2], `${t}:${m[2]}:POST`, 'POST', m[3], m[4]);
  }
  if ((m = new RegExp(`^(INVOICE|RECEIPT|AR_ENTRY|SETTLEMENT):${ID}:REVERSE$`).exec(key))) {
    const t = m[1] as SourceType;
    return withRepost(t, m[2], `${t}:${m[2]}:POST`, 'REVERSE');
  }
  if ((m = new RegExp(`^(PAYLINK_FEE|PAYOUT|WH_ENTRY):${ID}${repostSuffix}$`).exec(key))) {
    const t = m[1] as SourceType;
    return withRepost(t, m[2], `${t}:${m[2]}`, 'POST', m[3], m[4]);
  }
  if ((m = new RegExp(`^VAN_LOAD:${ID}:POST${repostSuffix}$`).exec(key))) {
    return withRepost('VAN_LOAD', m[1], vanLoadKey(m[1]), 'POST', m[2], m[3]);
  }
  if ((m = new RegExp(`^CUSTODY_SHORTAGE:${ID}:(POST|REVERSE)$`).exec(key))) {
    return {
      sourceType: 'CUSTODY_SHORTAGE', sourceId: m[1], event: m[2] as SourceEvent,
      baseKey: custodyShortageKey(m[1], 'POST'), repost: null, generation: null,
    };
  }
  return null;
}

/** مفتاح الشقيق POST لحدث REVERSE/COGS/RESTOCK (بوابة الأشقاء §5.4) */
export function siblingPostKey(key: string): string | null {
  const p = parseSourceKey(key);
  if (!p || p.event === 'POST') return null;
  return p.baseKey;
}
