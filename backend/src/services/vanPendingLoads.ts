// ============================================================================
// «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦): «يقوم اداري الشركة برفع التحميل ثم يقوم المندوب بالقبول واقرار
// التحميل والتوقيع على التحميل بحيث يكون المستند اثبات للتحميل و اقرار قبول للتحميل».
//   • الإعداد CompanySettings.vanLoadAcceptance (مطفأ افتراضاً، routes/companyVanLoadAcceptance.ts). المطفأة كما كانت حرفياً.
//   • مفعّلاً: تحميل الإدارة (LOAD من اللوحة، لا المندوب ولا مفتاح API) يُتحقَّق منه بمسار الحركة القائم نفسه
//     **تجربةً بلا كتابة** ثم يُحفظ صفّاً معلّقاً (PendingVanLoad) — لا أثر له في أي مخزون أو تكلفة أو دفتر أو تقرير أو مزامنة أو تنبّؤ.
//     وترويسة إعادة الرفع (X-FS-Replay) من مستخدم الشركة طلبٌ حيّ كغيره: صندوق الأوف‑لاين للمندوب وحده، فلا تُعفي تحميل الإدارة.
//   • قبول المندوب وتوقيعه يشغّل مسار الحركة نفسه (routes/vanStock.ts executeVanMovement) بالجسم المحفوظ كأن الإدارة أنشأته، داخل
//     معاملته وتحت قفل الصفّ — حركةٌ واحدة تُختم بلحظة القبول ومعرّف الصفّ. لا نداء إنشاء حركةٍ هنا (locations.test.ts).
//   • ما يغيّر أسطر التحميل بين الإرسال والقبول (PENDING_LINE_ALTERING) يرفضه: المندوب يوقّع على ما أرسلته الإدارة حرفياً.
// ============================================================================

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { roundDecimal } from '../utils/helpers';
import { UNIT_SELECT } from './warehouseStock';
import type { LotEventActor } from './lotsDb';

export const PENDING_STATUSES = ['PENDING', 'DISPUTED', 'ACCEPTED', 'CANCELLED'] as const;
export type PendingStatus = typeof PENDING_STATUSES[number];

/**
 * تحذيرات مسار الحركة التي تعني أن سطراً سيُكتب على غير ما أُرسل (يُترك، أو يُنقل لصنفٍ آخر، أو تتبدّل وحدته أو كميته أو
 * تشغيلته) — ترفض الإرسال (422) والقبول (409). وما سواها إعلامٌ لا يغيّر السطر (LOT_MULTI_IN_VAN، LOT_CREATED، UNIT_INACTIVE،
 * PRODUCT_ARCHIVED…)
 */
export const PENDING_LINE_ALTERING: ReadonlySet<string> = new Set([
  'PRODUCT_NOT_FOUND', 'PRODUCT_PLACEHOLDER_CREATED', 'PRODUCT_REDIRECTED', 'UNIT_INVALID', 'UNIT_FALLBACK_BASE',
  'LOT_IGNORED', 'LOT_CLAMPED', 'LOT_EXPLICIT_FALLBACK', 'LOT_NUMBER_UNKNOWN', 'ZERO_QTY_IGNORED',
]);

/** قفل صفّ التحميل المعلّق — أول ما في كل معاملة تمسّه (القبول، الاعتراض، التعديل، الإلغاء) */
export const pendingLoadLockKey = (id: string): string => 'pending-van-load:' + id;

/** التوقيع صورة PNG بترميز base64 وحدها */
export const PNG_SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

export const pendingAcceptSchema = z.object({
  signature: z.string().max(300_000).regex(PNG_SIGNATURE_RE),
  revision: z.number().int().positive(),
  // الموقع اختياري: غائبٌ أو null (جهازٌ بلا إذن موقع) سواء — لا يُرفض إقرارٌ موقَّع لأن الموقع لم يُلتقط
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});
export const pendingDisputeSchema = z.object({ note: z.string().trim().min(1).max(1000) });
export const pendingCancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

// ═══ أخطاء داخلية — رسائلها لاتينية قصيرة لا تطابق asLotBusy (lots.ts) فلا تصير LOT_BUSY ═══

/** تجربة الإرسال بلغت نداء الإنشاء بتحذيراتها — يُرمى من beforeCreate فتُجهَض المعاملة بلا كتابة */
export class VanDryRun extends Error {
  constructor(readonly warnings: { code: string }[]) { super('van-dry-run'); this.name = 'VanDryRun'; }
}
/** القبول: سطرٌ سيُكتب على غير ما أُرسل — تُجهَض المعاملة ويبقى المعلّق كما هو */
export class PendingLinesChanged extends Error {
  constructor(readonly warnings: { code: string }[]) { super('pending-lines-changed'); this.name = 'PendingLinesChanged'; }
}
/** القبول تحت القفل: الصفّ قُبل (إعادة)، أو لم يعد معلّقاً، أو عُدّلت مراجعته */
export class PendingLoadSettled extends Error {
  constructor(readonly state: 'ACCEPTED' | 'NOT_PENDING' | 'REVISED') { super('pending-load-settled'); this.name = 'PendingLoadSettled'; }
}

export const PENDING_LOAD_MESSAGES = Object.freeze({
  PENDING_LOAD_NOT_FOUND: 'التحميل غير موجود',
  PENDING_LOAD_REP_ONLY: 'قبول التحميل والاعتراض عليه للمندوب المستلم وحده',
  PENDING_LOAD_ADMIN_ONLY: 'تعديل التحميل المرسل وإلغاؤه للإدارة',
  API_KEY_FORBIDDEN: 'هذا الإجراء غير متاح بمفتاح API',
  PENDING_LOAD_ONLINE_ONLY: 'قبول التحميل وتوقيعه يتمّان والجهاز متصل',
  PENDING_LOAD_SIGNATURE_REQUIRED: 'وقّع لإقرار استلام البضاعة',
  PENDING_LOAD_NOTE_REQUIRED: 'اكتب سبب الاعتراض',
  PENDING_LOAD_NOT_PENDING: 'لم يعد هذا التحميل بانتظار القبول — حدّث القائمة',
  PENDING_LOAD_REVISED: 'عدّلت الإدارة هذا التحميل — راجع الأصناف ثم وقّع من جديد',
  PENDING_LOAD_ACCEPTED: 'قُبل هذا التحميل ودخل سيارة المندوب — للتراجع سجّل تنزيلاً للمستودع',
  PENDING_LOAD_CANCELLED: 'أُلغي هذا التحميل',
  PENDING_LOAD_STOCK_SHORT: 'رصيد المستودع لا يكفي الآن لهذا التحميل — أبلغ الإدارة لتعديله',
  PENDING_LOAD_LOTS_SHORT: 'تشغيلات هذا التحميل لم تعد متاحة كما أُرسلت — أبلغ الإدارة لتعديله',
  PENDING_LOAD_CHANGED: 'تغيّرت أصناف هذا التحميل أو وحداتها منذ إرساله — أبلغ الإدارة لتعديله',
  PENDING_LOAD_LINES_CHANGED: 'لا يُرسل التحميل للمندوب وبعض أسطره ستتغيّر عند تسجيله — راجع الأصناف والوحدات والتشغيلات ثم أعد الإرسال',
  PENDING_LOAD_REP_INACTIVE: 'المندوب موقوف — فعّله أولاً ليستطيع قبول التحميل',
  PENDING_LOAD_REP_GONE: 'مندوب هذا التحميل محذوف — ألغِ التحميل',
  PENDING_LOAD_REP_FIXED: 'لا يتغيّر مندوب التحميل المرسل — ألغِه وأرسل تحميلاً جديداً',
  PENDING_LOAD_TYPE_INVALID: 'التحميل المرسل للمندوب نوعه تحميل (LOAD) وحده',
  PENDING_LOAD_QTY_NEGATIVE: 'التحميل المرسل للمندوب كميات موجبة فقط — للتنزيل سجل حركة منفصلة',
  PENDING_LOAD_DISPUTED: 'اعترض المندوب على هذا التحميل بعد فتحك له — راجع ملاحظته ثم أعد فتحه من «تحميلات بانتظار القبول»',
});
export type PendingLoadCode = keyof typeof PENDING_LOAD_MESSAGES;

/** جسم الرفض بالرمز ورسالته — وإضافاتٌ اختيارية (data، warnings، lines، lot) */
export function pendingRefusal(code: PendingLoadCode, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { success: false, code, message: PENDING_LOAD_MESSAGES[code], ...extra };
}

/** هل الميزة مفعّلة للشركة؟ (=== true: صفٌّ غائب أو قاعدةٌ بلا العمود ⇒ مطفأة) */
export async function vanLoadAcceptanceOn(tid: string): Promise<boolean> {
  return (await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { vanLoadAcceptance: true } }))?.vanLoadAcceptance === true;
}

/** فاعل سجل تدقيق اللوط عند القبول: المرسِل لا المندوب — جلسة المالك (OWNER:<المعرّف>) «الدعم الفني» كما سجّلها actorOf */
export function pendingEventActor(createdById: string | null | undefined, createdByName: string | null | undefined): LotEventActor {
  const id = createdById ?? '';
  if (id.startsWith('OWNER:')) return { type: 'OWNER', id: id.slice('OWNER:'.length) || null, name: 'الدعم الفني' };
  return { type: 'ADMIN', id: id || null, name: createdByName ?? null };
}

const EVENT_ACTOR_TYPES: ReadonlySet<string> = new Set(['ADMIN', 'OWNER', 'STAFF', 'API_KEY', 'SYSTEM']);
const nullableStr = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * فاعل سجل تدقيق اللوط المحفوظ لحظة الإرسال (createdByActor = lotEventActorOf(req.user)) — به يُكتب القبول كما كان سيُكتب المسار
 * المباشر حرفياً (موظف المنصة STAFF بمعرّفه، والمالك بمعرّفه لا بمعرّف مدير الشركة المنتحَل). شكلٌ غير صالح أو صفٌّ أقدم بلاه ⇒ null
 * فيُبنى من المرسِل (pendingEventActor)
 */
export function storedEventActor(v: unknown): LotEventActor | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { type, id, name } = v as Record<string, unknown>;
  if (typeof type !== 'string' || !EVENT_ACTOR_TYPES.has(type) || !nullableStr(id) || !nullableStr(name)) return null;
  return { type: type as LotEventActor['type'], id, name };
}

/** قفل طلبات بضاعة المناديب للشركة — المفتاح نفسه في routes/repStockRequests.ts (lockTenant) لكل كتابةٍ على الطلبات */
export const repStockRequestLockKey = (tid: string): string => 'rep-stock-request:' + tid;

/**
 * إلغاء تحميلٍ معلّق أُرسل من «تحميل مباشر» لطلب بضاعة المندوب: الطلب عُلِّم «حُمِّل» بمعرّف هذا الصفّ (sentRef، POST
 * /rep-stock-requests/:id/loaded) قبل أن يقبله المندوب، ولم يصل السيارة شيءٌ منه ⇒ يعود الطلب كما كان قبل التحميل:
 *   • «حُمِّل» (LOADED) ⇒ معلّقٌ (PENDING) بلا علامةٍ ولا قرار — يراه الإداري في «طلب مخزون» ويدخل الطلب العام كما كان.
 *     وللمندوب طلبٌ معلّقٌ أحدث (رفعه بعد التحميل) ⇒ لا يصير له معلّقان (طلبٌ معلّق واحد لكل مندوب): يُعلَّم القديم «رُفض» بلحظة
 *     الإلغاء وباسم من ألغى — فيعرف المندوب أنه لم يُحمَّل، ويبقى طلبه الأحدث قائماً.
 *   • معلّقٌ بعلامة «حُمِّلت منه نسخةٌ سابقة» (sentRef على PENDING) ⇒ تُمحى العلامة وتبقى نسخته (updatedAt) كما هي.
 * داخل معاملة الإلغاء بعد قفل الصفّ: قفل طلبات الشركة ثم القراءة — الترتيب «صفّ المعلّق ثم الطلبات» دائماً، و/loaded يأخذ قفل الطلبات
 * وحده ويقرأ المعلّق قراءةً، فلا تعانق: إن علّم الطلب قبلنا رأيناه هنا، وإن جاء بعدنا رأى الصفّ ملغى فرفض (400 VAN_LOAD_MISMATCH)
 */
export async function reopenRepRequestsOf(tx: Prisma.TransactionClient, tid: string, pendingId: string, decidedBy: string | null): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${repStockRequestLockKey(tid)}))`;
  const rows = await tx.repStockRequest.findMany({
    where: { tenantId: tid, sentRef: pendingId, status: { in: ['LOADED', 'PENDING'] } },
    select: { id: true, salesRepId: true, status: true, updatedAt: true },
  });
  for (const r of rows) {
    if (r.status === 'PENDING') {
      await tx.repStockRequest.update({ where: { id: r.id }, data: { sentRef: null, updatedAt: r.updatedAt } });
      continue;
    }
    const newer = await tx.repStockRequest.findFirst({
      where: { tenantId: tid, salesRepId: r.salesRepId, status: 'PENDING', id: { not: r.id } }, select: { id: true },
    });
    await tx.repStockRequest.update({
      where: { id: r.id },
      data: newer
        ? { status: 'REJECTED', sentRef: null, decidedAt: new Date(), decidedBy }
        : { status: 'PENDING', sentRef: null, decidedAt: null, decidedBy: null },
    });
  }
  return rows.length;
}

/** اسم المرسِل كما يُحفظ: جلسة المالك «الدعم الفني» لا باسم مدير الشركة (كعهدة الأدوات) */
export const pendingActorName = (actor: string, userName: string | null | undefined): string | null =>
  (actor.startsWith('OWNER:') ? 'الدعم الفني' : (userName ?? null));

/** كل أعمدة الصفّ عدا التوقيع (يُقرأ حين يُطلب وحده) — واسم المندوب الحيّ */
export const PENDING_SELECT = {
  id: true, tenantId: true, salesRepId: true, repName: true, status: true, body: true, revision: true, note: true, clientRef: true,
  createdById: true, createdByName: true, disputeNote: true, disputedAt: true, acceptedAt: true, acceptedLat: true, acceptedLng: true,
  vanLoadId: true, cancelledAt: true, cancelledById: true, cancelledByName: true, createdAt: true, updatedAt: true,
  salesRep: { select: { name: true } },
} as const;

/** الصفّ كما يُقرأ بـPENDING_SELECT (والتوقيع حين يُطلب) */
export interface PendingRow {
  id: string; tenantId: string; salesRepId: string | null; repName: string | null; status: string; body: Prisma.JsonValue;
  revision: number; note: string | null; clientRef: string | null; createdById: string | null; createdByName: string | null;
  disputeNote: string | null; disputedAt: Date | null; acceptedAt: Date | null; acceptedLat: number | null; acceptedLng: number | null;
  vanLoadId: string | null; cancelledAt: Date | null; cancelledById: string | null; cancelledByName: string | null;
  createdAt: Date; updatedAt: Date; salesRep?: { name: string } | null; signature?: string | null;
}

/** تشغيلة سطرٍ كما أرسلتها الإدارة — الكمية بالأساس */
export interface PendingLineLot { lotId: string | null; lotNumber: string | null; expiryDate: string | null; qty: number }

/** سطر التحميل المعلّق للعرض (المندوب يراجعه قبل التوقيع، والإدارة في القائمة، والطباعة) */
export interface PendingLineView {
  /** موضع السطر في body.items */
  idx: number;
  productId: string;
  name: string;
  code: string | null;
  /** وحدة الأساس (و baseUnit مثلها صراحةً) */
  unit: string;
  baseUnit: string | null;
  primaryUnitId: string | null;
  units: { id: string; name: string; factor: number; isActive: boolean }[];
  unitId: string | null;
  unitName: string;
  unitFactor: number;
  /** بوحدة السطر كما أُرسلت */
  qty: number;
  /** qty × معامل الوحدة (أربع خانات) */
  baseQty: number;
  lots: PendingLineLot[];
  /** رقم تشغيلةٍ جديدة كما أُرسل مسطَّحاً على السطر (تحميلٌ بلا مستودع D4) — وهو في lots أيضاً */
  lotNumber: string | null;
  /** الصنف لم يعد موجوداً (حُذف بعد الإرسال) — القبول سيُرفض PENDING_LOAD_CHANGED */
  missing: boolean;
}

/** عقد الصفّ في كل ردود المسارات */
export interface PendingVanLoadView {
  id: string;
  salesRepId: string | null;
  repName: string | null;
  status: string;
  revision: number;
  note: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  disputeNote: string | null;
  disputedAt: Date | null;
  acceptedAt: Date | null;
  acceptedLat: number | null;
  acceptedLng: number | null;
  vanLoadId: string | null;
  cancelledAt: Date | null;
  cancelledByName: string | null;
  lines: PendingLineView[];
  lineCount: number;
  /** للإدارة وحدها: معرّف المرسِل وجسم التحميل كما سيُسجَّل (لتعديله) */
  createdById?: string | null;
  body?: Prisma.JsonValue;
  /** حين يُطلب وحده (GET /pending-loads/:id، أو withSignature=1 للإدارة على المقبول) */
  signature?: string | null;
}

type RawItem = Record<string, unknown>;
const itemsOf = (body: Prisma.JsonValue): RawItem[] => {
  const items = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).items : null;
  return Array.isArray(items) ? items.filter((i): i is RawItem => !!i && typeof i === 'object' && !Array.isArray(i)) : [];
};
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const dayOf = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/**
 * أسطر الصفوف للعرض بقراءتين للشركة كلها (الأصناف بوحداتها، والتشغيلات المذكورة) — لا استعلام لكل صفّ.
 * السطر بكمية صفر لا يُعرض (لا يُسجَّل في الحركة أصلاً).
 */
export async function pendingLinesView(tid: string, rows: readonly { id: string; body: Prisma.JsonValue }[]): Promise<Map<string, PendingLineView[]>> {
  const out = new Map<string, PendingLineView[]>();
  const productIds = new Set<string>();
  const lotIds = new Set<string>();
  for (const r of rows) {
    for (const i of itemsOf(r.body)) {
      if (typeof i.productId === 'string') productIds.add(i.productId);
      if (Array.isArray(i.lots)) for (const l of i.lots) { const id = l && typeof l === 'object' ? str((l as RawItem).lotId) : null; if (id) lotIds.add(id); }
      const flat = str(i.lotId);
      if (flat) lotIds.add(flat);
    }
  }
  const [products, lots] = await Promise.all([
    productIds.size
      ? prisma.product.findMany({
        where: { tenantId: tid, id: { in: [...productIds] } },
        select: { id: true, name: true, code: true, unit: true, primaryUnitId: true, units: { select: UNIT_SELECT } },
      })
      : Promise.resolve([]),
    lotIds.size
      ? prisma.productLot.findMany({ where: { tenantId: tid, id: { in: [...lotIds] } }, select: { id: true, lotNumber: true, expiryDate: true } })
      : Promise.resolve([]),
  ]);
  const productById = new Map(products.map((p) => [p.id, p]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  for (const r of rows) {
    const lines: PendingLineView[] = [];
    itemsOf(r.body).forEach((i, idx) => {
      const qty = Number(i.qty);
      if (!Number.isFinite(qty) || qty === 0) return;
      const productId = typeof i.productId === 'string' ? i.productId : '';
      const p = productById.get(productId);
      const unitId = str(i.unitId);
      const u = unitId && p ? p.units.find((x) => x.id === unitId) : undefined;
      const unitFactor = u ? Number(u.factor) || 1 : 1;
      const baseQty = roundDecimal(qty * unitFactor, 4);
      const lotRows: PendingLineLot[] = [];
      if (Array.isArray(i.lots)) {
        for (const x of i.lots) {
          if (!x || typeof x !== 'object' || Array.isArray(x)) continue;
          const o = x as RawItem;
          const id = str(o.lotId);
          const meta = id ? lotById.get(id) : undefined;
          lotRows.push({
            lotId: id, lotNumber: meta?.lotNumber ?? str(o.lotNumber), expiryDate: meta ? dayOf(meta.expiryDate) : str(o.expiryDate),
            qty: roundDecimal(Math.abs(Number(o.qty) || 0), 4),
          });
        }
      } else if (str(i.lotId) || str(i.lotNumber)) {
        const id = str(i.lotId);
        const meta = id ? lotById.get(id) : undefined;
        lotRows.push({ lotId: id, lotNumber: meta?.lotNumber ?? str(i.lotNumber), expiryDate: meta ? dayOf(meta.expiryDate) : str(i.expiryDate), qty: baseQty });
      }
      lines.push({
        idx, productId, name: p?.name ?? '', code: p?.code ?? null, unit: p?.unit ?? '', baseUnit: p?.unit ?? null, primaryUnitId: p?.primaryUnitId ?? null,
        units: (p?.units ?? []).map((x) => ({ id: x.id, name: x.name, factor: Number(x.factor), isActive: x.isActive !== false })),
        unitId: u ? unitId : null, unitName: u?.name ?? p?.unit ?? '', unitFactor, qty, baseQty, lots: lotRows, lotNumber: str(i.lotNumber), missing: !p,
      });
    });
    out.set(r.id, lines);
  }
  return out;
}

/** الصفّ بعقد العرض: الإدارة ترى الجسم ومعرّف المرسِل، والتوقيع حين يُطلب وحده */
export function pendingLoadView(row: PendingRow, lines: PendingLineView[] | undefined, opts: { admin: boolean; withSignature: boolean }): PendingVanLoadView {
  const ls = lines ?? [];
  return {
    id: row.id,
    salesRepId: row.salesRepId,
    repName: row.salesRep?.name ?? row.repName ?? null,
    status: row.status,
    revision: row.revision,
    note: row.note,
    createdByName: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    disputeNote: row.disputeNote,
    disputedAt: row.disputedAt,
    acceptedAt: row.acceptedAt,
    acceptedLat: row.acceptedLat,
    acceptedLng: row.acceptedLng,
    vanLoadId: row.vanLoadId,
    cancelledAt: row.cancelledAt,
    cancelledByName: row.cancelledByName,
    lines: ls,
    lineCount: ls.length,
    ...(opts.admin && { createdById: row.createdById, body: row.body }),
    ...(opts.withSignature && { signature: row.signature ?? null }),
  };
}

/** تنبيه المندوب بتحميلٍ ينتظره — لا يُنتظَر ولا يُفشل الطلب (اشتراكات الويب وآيفون عبر sendPushToRep) */
export function notifyPendingLoad(salesRepId: string): void {
  void import('./webPush')
    .then((m) => m.sendPushToRep(salesRepId, {
      title: 'تحميل بانتظار قبولك',
      body: 'أرسلت الإدارة تحميل بضاعة لسيارتك — راجعه ثم اقبله ووقّع عليه',
      url: '/rep?screen=vanloads',
      tag: 'van-load',
    }, { ttlSec: 86400 }))
    .catch(() => 0);
}
