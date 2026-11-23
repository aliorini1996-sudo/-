// ============================================================================
// «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — طبقة تطبيق المندوب فوق العقد المشترك (lib/pendingLoads.ts).
//
// - الإدارة ترسل التحميل فيبقى «بانتظار قبول المندوب» بلا أثرٍ في المخزون: لا تنتقل البضاعة من المستودع إلى السيارة إلا حين
//   يقبله المندوب ويوقّع عليه — والخادم وحده يحرّكها (POST /van-stock/pending-loads/:id/accept)، فلا يُطرح هنا شيءٌ محلياً.
// - التطبيع والعميل ورسائل الخادم من العقد المشترك (normalizePendingList وpendingLoadsClient وpendingErrorText)؛ وهنا ما يخصّ
//   المندوب وحده: أقسام شاشته، وبطاقة الرئيسية، والكاش لكل مندوب، وجسما القبول والاعتراض، والانقطاع، ونصّا الكمية والتشغيلة.
// - القبول والاعتراض متصلان وحدهما: لا صفّ صادر ولا إعادة دون اتصال (الخادم يرفض x-fs-replay بـPENDING_LOAD_ONLINE_ONLY).
//   ودون اتصال تُعرض آخر قائمةٍ محفوظة لهذا المندوب بلا أزرار، برسالةٍ صريحة.
// - القبول يحمل `revision` الصفّ المعروض: عدّلته الإدارة بعد فتحه ⇒ 409 PENDING_LOAD_REVISED فيراجع الأصناف ويوقّع من جديد.
// ============================================================================

import { lotDayText } from './docLots';
import {
  PNG_DATA_URL_RE, normalizePendingList, normalizePendingLoad, pendingErrorText, pendingLoadErrorOf,
  type PendingAcceptBody, type PendingLineView, type PendingLoadCounts, type PendingLoadList, type PendingLotView, type PendingVanLoadView,
} from '../lib/pendingLoads';

type Tr = (ar: string) => string;

export const PENDING_LOADS_PATH = '/van-stock/pending-loads';
/** شاشة التطبيق ووسيط رابط الإشعار (/rep?screen=vanloads — notifyPendingLoad في الخادم) */
export const PENDING_LOADS_SCREEN = 'vanloads';

/** حدّ الخادم لصورة التوقيع (pendingAcceptSchema) — لوحة التوقيع تُخرج عشرات الكيلوبايتات */
export const SIGNATURE_MAX = 300_000;
/** حدّ سبب الاعتراض (pendingDisputeSchema) */
export const DISPUTE_NOTE_MAX = 1000;
/** عدّاد البطاقة يُعاد من الخادم بعد هذه المهلة وحدها — الرئيسية تُركَّب مع كل تبديل تبويب */
export const PENDING_COUNTS_FRESH_MS = 30_000;
export const pendingLoadsCacheKey = (repId: string) => `rep-pending-loads:${repId}`;

const EPS = 1e-9;
const at = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** أقسام شاشة المندوب: بانتظار قبوله (الأقدم أولاً — يُستلم بترتيب الإرسال)، ثم اعتراضه القائم، ثم المقبول مؤخراً (الأحدث أولاً) */
export function repPendingSections(rows: readonly PendingVanLoadView[]): { pending: PendingVanLoadView[]; disputed: PendingVanLoadView[]; accepted: PendingVanLoadView[] } {
  const by = (s: PendingVanLoadView['status']) => rows.filter((r) => r.status === s);
  return {
    pending: by('PENDING').sort((a, b) => at(a.createdAt) - at(b.createdAt)),
    disputed: by('DISPUTED').sort((a, b) => at(b.disputedAt ?? b.updatedAt) - at(a.disputedAt ?? a.updatedAt)),
    accepted: by('ACCEPTED').sort((a, b) => at(b.acceptedAt) - at(a.acceptedAt)),
  };
}

/** بطاقة الرئيسية: ما ينتظر قبوله أولاً، وإلا اعتراضه القائم — ولا بطاقة بلا شيء */
export function pendingHomeCardOf(c: PendingLoadCounts | null | undefined): { kind: 'pending' | 'disputed'; n: number } | null {
  if (!c) return null;
  if (c.pending > 0) return { kind: 'pending', n: c.pending };
  if (c.disputed > 0) return { kind: 'disputed', n: c.disputed };
  return null;
}

/** صنفٌ حُذف بعد الإرسال: القبول سيُرفض PENDING_LOAD_CHANGED — لا يُفتح التوقيع، والاعتراض يبلّغ الإدارة */
export const acceptBlocked = (row: Pick<PendingVanLoadView, 'lines'>): boolean => row.lines.some((l) => l.missing);

// ───────── الكاش: آخر قائمة لهذا المندوب (تُعرض دون اتصال بلا أزرار) ─────────

export interface PendingLoadsCache { v: 1; repId: string; at: number; list: PendingLoadList }

export function pendingCacheEntry(repId: string, list: PendingLoadList, now = Date.now()): PendingLoadsCache {
  return { v: 1, repId, at: now, list };
}

/** المحفوظ لهذا المندوب وحده — صفّ مندوبٍ سبقه على الجهاز أو شكلٌ قديم ⇒ null */
export function pendingCacheOf(raw: unknown, repId: string | null | undefined): PendingLoadsCache | null {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r || !repId || r.v !== 1 || r.repId !== repId || typeof r.at !== 'number') return null;
  const l = r.list && typeof r.list === 'object' ? (r.list as Record<string, unknown>) : null;
  if (!l || !Array.isArray(l.rows)) return null;
  return { v: 1, repId, at: r.at, list: normalizePendingList({ data: l.rows, counts: l.counts }) };
}

// ───────── الإرسال ─────────

/** جسم القبول — بلا توقيع PNG صالحٍ ضمن الحدّ أو بمراجعةٍ غير صحيحة ⇒ null (لا يُرسل)؛ والموقع اختياريٌّ يُرفق صالحاً وحده */
export function acceptBodyOf(signature: string | null | undefined, revision: number, fix?: { lat: number; lng: number } | null): PendingAcceptBody | null {
  if (!signature || signature.length > SIGNATURE_MAX || !PNG_DATA_URL_RE.test(signature)) return null;
  if (!Number.isInteger(revision) || revision < 1) return null;
  const okFix = !!fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lng)
    && Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180 && !(fix.lat === 0 && fix.lng === 0);
  return { signature, revision, ...(okFix && { lat: fix!.lat, lng: fix!.lng }) };
}

/** سبب الاعتراض بعد القصّ — فارغٌ أو فوق الحدّ ⇒ null */
export function disputeNoteOf(note: string | null | undefined): string | null {
  const n = String(note ?? '').trim();
  return n && n.length <= DISPUTE_NOTE_MAX ? n : null;
}

// ───────── الرفض ─────────

export interface RepPendingFailure {
  code: string | null;
  /** لا ردّ من الخادم (انقطاع) */
  offline: boolean;
  /** صفّ الخادم الحالي إن أرفقه الرفض (NOT_PENDING / REVISED) */
  row: PendingVanLoadView | null;
  /** تغيّر الصفّ على الخادم (عدّلته الإدارة أو ألغته أو قُبل من جهازٍ آخر أو حُذف) — تُغلق اللوحة وتُعاد القائمة */
  reload: boolean;
  /** الصفّ ما زال بانتظار القبول والخلل في المستودع أو الأصناف — يبلّغ المندوب الإدارة بالاعتراض من البطاقة نفسها */
  invitesDispute: boolean;
}

const RELOAD_CODES: ReadonlySet<string> = new Set([
  'PENDING_LOAD_NOT_FOUND', 'PENDING_LOAD_NOT_PENDING', 'PENDING_LOAD_REVISED', 'PENDING_LOAD_ACCEPTED', 'PENDING_LOAD_CANCELLED',
]);
const DISPUTE_CODES: ReadonlySet<string> = new Set(['PENDING_LOAD_STOCK_SHORT', 'PENDING_LOAD_LOTS_SHORT', 'PENDING_LOAD_CHANGED']);

export function repPendingFailureOf(e: unknown): RepPendingFailure {
  const err = pendingLoadErrorOf(e);
  if (!err) return { code: null, offline: true, row: null, reload: false, invitesDispute: false };
  return {
    code: err.code,
    offline: false,
    row: normalizePendingLoad(err.body.data),
    reload: (err.code !== null && RELOAD_CODES.has(err.code)) || err.status === 404,
    invitesDispute: err.code !== null && DISPUTE_CODES.has(err.code),
  };
}

/** نصّ الرفض للمندوب بلغته: الانقطاع برسالته هنا، والرموز بعبارات الخادم من العقد المشترك (PENDING_LOAD_MESSAGES) */
export function repPendingFailureText(e: unknown, tr: Tr, action: 'accept' | 'dispute' | 'load'): string {
  if (!pendingLoadErrorOf(e)) {
    if (action === 'dispute') return tr('الاعتراض يرسل والجهاز متصل');
    if (action === 'load') return tr('تعذر تحميل البيانات');
    return tr('قبول التحميل وتوقيعه يتمّان والجهاز متصل');
  }
  return pendingErrorText(e, tr, action === 'load' ? 'تعذر تحميل البيانات' : 'تعذر الحفظ');
}

// ───────── العرض ─────────

/** «٣ كرتون (٧٢ حبة)» — والأساس وحده بلا قوسين */
export function lineQtyText(l: Pick<PendingLineView, 'qty' | 'unitName' | 'unitFactor' | 'baseQty' | 'baseUnit'>, fmt: (n: number) => string): string {
  const main = `${fmt(l.qty)}${l.unitName ? ` ${l.unitName}` : ''}`;
  if (Math.abs(l.unitFactor - 1) <= EPS || !(Math.abs(l.baseQty - l.qty) > EPS)) return main;
  return `${main} (${fmt(l.baseQty)}${l.baseUnit ? ` ${l.baseUnit}` : ''})`;
}

/** سطر تشغيلة: «رقمها · ينتهي يوم · ×كمية أساس» — وبلا رقمٍ «غير مسمى»؛ وكميةٌ صفرية بلا وسم الكمية */
export function lineLotText(l: PendingLotView, line: Pick<PendingLineView, 'baseUnit'>, tr: Tr, fmt: (n: number) => string): string {
  const exp = lotDayText(l.expiryDate);
  return [
    l.lotNumber ?? tr('غير مسمى'),
    exp ? `${tr('ينتهي')} ${exp}` : '',
    Math.abs(l.qty) > EPS ? `×${fmt(l.qty)}${line.baseUnit ? ` ${line.baseUnit}` : ''}` : '',
  ].filter(Boolean).join(' · ');
}
