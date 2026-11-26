// ============================================================================
// «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): أحداث العميل غير المالية
// ----------------------------------------------------------------------------
// طبقةٌ رقيقة فوق services/customerActivity.ts لمسارات العميل نفسه وزياراته ووثائقه وخطوط السير والإسناد والأسعار الخاصة
// والاستيراد والمكالمات وطلبات المنيو (والمستندات المالية في services/customerActivityDocs.ts):
//   • recordActivityInTx: الحدث **بمقبض المعاملة نفسها** التي تكتب الإجراء — يلتزم معه أو يُلغى معه. أخطاء القاعدة تُرمى فتُلغي
//     المعاملة: لا إجراء بلا أثره. المقابض المزيّفة في الاختبارات القائمة (بلا جدول السجل) تُتخطّى بلا خطأ؛ عميل Prisma الحقيقي
//     يحمل الجدول دائماً.
//   • recordActivityAfter: لمسارٍ بلا معاملة (كتابةٌ واحدة التزمت): الحدث بعد الكتابة، وتعذّره يُسجَّل في السجلّ التشغيلي ولا
//     يُفشل إجراءً تمّ فعلاً (فشلٌ بعد الالتزام كان سيدفع الجهاز إلى إعادة إجراءٍ نجح). وما يُشتقّ من جداوله (الزيارة) يظهر
//     «سجلاً تاريخياً» عند القراءة لو فات حدثه.
//   • activityMeta: الفاعل والمصدر من الطلب مرّةً واحدة — لا يرمي أبداً (اختبارات المسارات تحقن بديلاً لـmiddleware/auth).
// السجل للإلحاق وحده: لا شيء هنا يعدّل صفّاً من سجلّ العميل أو يحذفه.
// ============================================================================

import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../types';
import {
  SYSTEM_ACTOR, actorFromReq, customerDiff, recordCustomerActivity, sourceFromReq,
  type ActivityActor, type ActivityInput, type CustomerActivityAction,
} from './customerActivity';
import { DEVICE_CLOCK_SKEW_TOLERANCE_MS, OFFLINE_INVOICE_DATE_MAX_AGE_MS } from './offlineInvoiceDate';
import { matchableKey, orderPhoneKey, phoneTail, type CustomerCandidate } from './catalogOrders';

export { SYSTEM_ACTOR };
export type { ActivityActor, ActivityInput, CustomerActivityAction };

/** الفاعل والمصدر كما يُحملان إلى بُناة الأحداث */
export interface ActivityMeta { actor: ActivityActor; source: string | null }

/** الفاعل حين يتعذّر actorFromReq — من req.user وحده (لا قراءة ولا رمي) */
function actorFromUser(req: AuthRequest | null | undefined): ActivityActor {
  const u = req?.user;
  if (!u) return SYSTEM_ACTOR;
  const name = typeof u.name === 'string' && u.name ? u.name : null;
  if (u.apiKeyId) return { kind: 'API', id: u.apiKeyId, name };
  if (u.impersonated) return { kind: u.byKind === 'STAFF' ? 'STAFF' : 'OWNER', id: u.by ?? u.id ?? null, name };
  if (u.role === 'SALES_REP') return { kind: 'REP', id: u.id ?? null, name };
  if (u.role === 'PLATFORM_STAFF') return { kind: 'STAFF', id: u.id ?? null, name };
  if (u.role === 'SUPER_ADMIN') return { kind: 'OWNER', id: u.id ?? null, name };
  return { kind: 'ADMIN', id: u.id ?? null, name };
}

/** الفاعل والمصدر من الطلب — لا يرميان أبداً. وsource صريحٌ يغلب المشتقّ (الاستيراد مثلاً) */
export function activityMeta(req: AuthRequest | null | undefined, source?: string | null): ActivityMeta {
  if (!req) return { actor: SYSTEM_ACTOR, source: source ?? 'system' };
  let actor: ActivityActor;
  try { actor = actorFromReq(req) ?? actorFromUser(req); } catch { actor = actorFromUser(req); }
  let derived: string | null = null;
  try { derived = sourceFromReq(req) ?? null; } catch { derived = req.user?.apiKeyId ? 'api' : null; }
  return { actor, source: source ?? derived };
}

type ActivityDb = { customerActivity: { createMany(args: { data: any[] }): Promise<unknown> } };

/** مقبضٌ يحمل جدول السجل؟ المقابض المزيّفة القديمة في الاختبارات لا تحمله */
export function hasActivityTable(db: unknown): db is ActivityDb {
  const d = (db as { customerActivity?: { createMany?: unknown } } | null | undefined)?.customerActivity;
  return !!d && typeof d.createMany === 'function';
}

/** سقف صفوف الإدراج الواحد — الاستيراد ونقل المستندات الجماعيّ يكتبان آلاف الأحداث في معاملةٍ واحدة */
export const ACTIVITY_INSERT_CHUNK = 500;

type InputList = ActivityInput | readonly (ActivityInput | null | undefined)[] | null | undefined;

function validInputs(input: InputList): ActivityInput[] {
  if (!input) return [];
  const arr = (Array.isArray(input) ? input : [input]) as readonly unknown[];
  return arr.filter((i): i is ActivityInput => {
    const x = i as Partial<ActivityInput> | null | undefined;
    return !!x && typeof x.tenantId === 'string' && x.tenantId !== '' && typeof x.customerId === 'string' && x.customerId !== '';
  });
}

/**
 * يُلحق حدثاً أو أحداثاً بسجلّ العميل بمقبض المعاملة الممرَّر — داخل معاملة الإجراء نفسها، دفعاتٍ من ٥٠٠. حدثٌ بلا عميل يُسقط
 * (لا سجلّ له). أخطاء القاعدة تُرمى فتُلغي المعاملة كلها.
 */
export async function recordActivityInTx(db: unknown, input: InputList): Promise<void> {
  const list = validInputs(input);
  if (!list.length || !hasActivityTable(db)) return;
  for (let i = 0; i < list.length; i += ACTIVITY_INSERT_CHUNK) {
    const part = list.slice(i, i + ACTIVITY_INSERT_CHUNK);
    await recordCustomerActivity(db, part.length === 1 ? part[0] : part);
  }
}

/** بعد كتابةٍ التزمت بلا معاملة: تعذّر الحدث يُسجَّل ولا يُفشل الإجراء */
export async function recordActivityAfter(db: unknown, input: InputList): Promise<void> {
  try {
    await recordActivityInTx(db, input);
  } catch (e) {
    console.error('[customer-activity] تعذّر تسجيل حدث العميل بعد الإجراء:', (e as Error)?.message ?? e);
  }
}

// ─── لحظة الحدث ───

/**
 * لحظة سطرٍ في السجلّ من لحظةٍ يرسلها الجهاز أو المُرسِل (زيارة، نتيجة المندوب الذكي): تُقبل داخل نافذة العمل دون اتصال وحدها —
 * لا أقدم من سبعة أيام (OFFLINE_INVOICE_DATE_MAX_AGE_MS، حدّ تأريخ فاتورة المندوب) ولا بعد «الآن» بأكثر من خمس دقائق
 * (DEVICE_CLOCK_SKEW_TOLERANCE_MS). وخارجها undefined ⇒ لحظة الكتابة نفسها (افتراض العمود)، ويحفظ المستدعي اللحظة المُرسلة في
 * التفاصيل: سطرٌ مؤرَّخ في ٢٠٩٩ لا يعلو الخطّ الزمني أبداً، وسطرٌ مؤرَّخ في ٢٠٢٠ لا يصير أقدم سطرٍ للعميل فيُخفي تاريخه المشتقّ.
 * نقيّة.
 */
export function boundedActivityAt(moment: Date | null | undefined, now: Date = new Date()): Date | undefined {
  if (!(moment instanceof Date)) return undefined;
  const t = moment.getTime(); const n = now.getTime();
  if (!Number.isFinite(t) || t < n - OFFLINE_INVOICE_DATE_MAX_AGE_MS || t > n + DEVICE_CLOCK_SKEW_TOLERANCE_MS) return undefined;
  return moment;
}

// ─── العميل نفسه ───

/**
 * أعمدة صورة العميل قبل التعديل — الحقول التي يتتبّعها customerDiff (لا الرصيد ولا العدّادات ولا الطابع). تُقرأ في استعلام
 * وجود العميل نفسه قبل الكتابة فلا تُضاف قراءة.
 */
export const CUSTOMER_ACTIVITY_SELECT = {
  id: true, number: true, code: true, name: true, businessName: true, commercialReg: true, taxNumber: true, phone: true, altPhone: true,
  email: true, city: true, district: true, address: true, lat: true, lng: true, channel: true, outletType: true, status: true,
  priceListId: true, creditLimit: true, paymentDays: true, createdBySalesRepId: true,
  buyerType: true, buyerIdScheme: true, buyerIdValue: true, addrStreet: true, addrBuildingNo: true, addrAdditionalNo: true,
  addrPostalCode: true, countryCode: true,
} as const;

/** حقول الفوترة (ZATCA): تغيّرها حدث «بيانات الفوترة» لا تعديلٌ عام */
const TAX_FIELDS = new Set([
  'taxNumber', 'commercialReg', 'buyerType', 'buyerIdScheme', 'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo',
  'addrPostalCode', 'countryCode',
]);
const LOCATION_FIELDS = new Set(['location', 'lat', 'lng']);

type Row = Record<string, unknown>;

const pointOf = (r: Row | null | undefined): { lat: number; lng: number } | null => {
  const lat = r?.lat; const lng = r?.lng;
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

export interface CustomerEventCtx {
  tenantId: string;
  customerId: string;
  meta: ActivityMeta;
  /** أسماء قوائم الأسعار (معرّف ⇒ اسم) لحدث «نوع السعر» — اختيارية */
  priceListNames?: ReadonlyMap<string, string> | null;
  /** تفاصيل إضافية تُدمج في data كل حدث (سبب التعديل أو مصدره) */
  extra?: Record<string, unknown> | null;
  /** حدثٌ واحد لكل حقول الفوترة (مسار بيانات الفوترة) بدل توزيعها */
  taxOnly?: boolean;
}

const withExtra = (data: Row, extra?: Record<string, unknown> | null): Row => ({ ...data, ...(extra ?? {}) });

/**
 * أحداث تعديل العميل من صورتيه قبل الكتابة وبعدها (customerDiff — الحقول المتتبَّعة وحدها): الحالة حدثها، والموقع حدثه، ونوع
 * السعر حدثه، وبيانات الفوترة حدثها، والباقي «تعديل بيانات العميل» بقائمة التغييرات. لا تغيير ⇒ لا حدث.
 * المرجع CUSTOMER بمعرّفه (عرف services/customerActivity.ts) — والقارئ يُسقط الاشتقاق التاريخيّ بسطر «الميلاد» وحده (الإضافة).
 */
export function customerUpdateEvents(before: Row | null | undefined, after: Row | null | undefined, ctx: CustomerEventCtx): ActivityInput[] {
  if (!before || !after) return [];
  const changes = customerDiff(before, after);
  if (!changes.length) return [];
  const base = {
    tenantId: ctx.tenantId, customerId: ctx.customerId, actor: ctx.meta.actor, source: ctx.meta.source,
    refType: 'CUSTOMER' as const, refId: ctx.customerId,
  };
  const out: ActivityInput[] = [];
  const status = changes.find((c) => c.field === 'status');
  const location = changes.filter((c) => LOCATION_FIELDS.has(c.field));
  const priceList = changes.find((c) => c.field === 'priceListId');
  const tax = changes.filter((c) => TAX_FIELDS.has(c.field));
  const rest = changes.filter((c) => c.field !== 'status' && c.field !== 'priceListId' && !LOCATION_FIELDS.has(c.field) && !TAX_FIELDS.has(c.field));
  if (status) {
    out.push({ ...base, action: 'CUSTOMER_STATUS_CHANGED', data: withExtra({ oldStatus: status.from ?? null, newStatus: status.to ?? null }, ctx.extra) });
  }
  if (location.length) {
    out.push({ ...base, action: 'CUSTOMER_LOCATION_SET', data: withExtra({ from: pointOf(before), to: pointOf(after) }, ctx.extra) });
  }
  if (priceList) {
    const from = typeof priceList.from === 'string' && priceList.from ? priceList.from : null;
    const to = typeof priceList.to === 'string' && priceList.to ? priceList.to : null;
    out.push({
      ...base, action: 'CUSTOMER_PRICE_LIST_CHANGED',
      data: withExtra({
        from, to,
        ...(from && ctx.priceListNames?.get(from) && { fromName: ctx.priceListNames.get(from) }),
        ...(to && ctx.priceListNames?.get(to) && { toName: ctx.priceListNames.get(to) }),
      }, ctx.extra),
    });
  }
  if (tax.length) out.push({ ...base, action: 'CUSTOMER_TAX_DATA_UPDATED', data: withExtra({ changes: tax }, ctx.extra) });
  if (rest.length) out.push({ ...base, action: 'CUSTOMER_UPDATED', data: withExtra({ changes: rest }, ctx.extra) });
  if (ctx.taxOnly && out.length > 0) {
    // مسار بيانات الفوترة: حدثٌ واحد «بيانات الفوترة» بكل ما تغيّر — وما يكتبه كله بيانات فوترة (اسم المنشأة والمدينة والحيّ من
    // العنوان الوطني كذلك)، فلا يصير تغيّر الحيّ وحده «تعديل بيانات العميل»
    return [{ ...base, action: 'CUSTOMER_TAX_DATA_UPDATED', data: withExtra({ changes }, ctx.extra) }];
  }
  return out;
}

/** معرّفا قوائم الأسعار في تغيّر «نوع السعر» بين صورتين — لقراءة أسمائهما مرّةً واحدة حين تغيّر وحده */
export function priceListIdsChanged(before: Row | null | undefined, after: Row | null | undefined): string[] {
  const a = before?.priceListId ?? null; const b = after?.priceListId ?? null;
  if (a === b) return [];
  return [a, b].filter((x): x is string => typeof x === 'string' && x !== '');
}

// ─── تعديل العميل: القفل والصورتان ───

/** أعمدة صورة العميل (CUSTOMER_ACTIVITY_SELECT) لقراءتها خاماً تحت القفل — أسماء حقول Customer أسماء أعمدتها (لا @map فيها) */
const CUSTOMER_IMAGE_COLUMNS = Prisma.raw(Object.keys(CUSTOMER_ACTIVITY_SELECT).map((k) => `"${k}"`).join(', '));

type RawQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
type RawDb = { $queryRaw?: RawQuery };

/**
 * يقفل صفّ العميل (FOR UPDATE) داخل معاملة التعديل ويعيد صورته **تحت القفل** — الصورة «قبل» لحدث التعديل. سؤال الوجود في أوّل
 * المسار يسبق الكتابة بانتظاراتٍ (بوابة المشتري، رابط Google عبر الشبكة، فحوص التكرار)، فتعديلٌ موازٍ التزم بينهما (مديرٌ آخر،
 * صندوق المندوب، تصنيف المندوب الذكي) كان يُنسب في الفرق لهذا الفاعل؛ وتحت القفل لا يكتب أحدٌ بين الصورة والكتابة.
 * null ⇒ لا صفّ تحت القفل (حُذف في الأثناء فتفشل الكتابة بعده P2025، أو مقبضٌ مزيّف بلا SQL خام) — فيبقى للمستدعي ما سأل عنه أوّلاً
 */
export async function lockCustomerImage(tx: unknown, tenantId: string, customerId: string): Promise<Row | null> {
  const db = tx as RawDb | null | undefined;
  if (typeof db?.$queryRaw !== 'function') return null;
  const rows = await db.$queryRaw`SELECT ${CUSTOMER_IMAGE_COLUMNS} FROM "customers" WHERE "id" = ${customerId} AND "tenantId" = ${tenantId} FOR UPDATE`;
  const row = Array.isArray(rows) ? rows[0] : null;
  return row && typeof row === 'object' && (row as Row).id === customerId ? (row as Row) : null;
}

/**
 * صورة العميل «بعد» لحدث التعديل: الحقول التي كتبها الطلب وحدها (قيمةٌ غير undefined في بيانات الكتابة) من الصفّ الذي أعادته
 * الكتابة، ومعها extraKeys (الحالة حين أعاد الإحياءُ المؤرشفَ نشطاً). الحقل الغائب لم يُمسّ (customerDiff) — فلا ينسب الفرقُ لهذا
 * الفاعل حقلاً لم يكتبه. نقيّة.
 */
export function writtenImage(row: Row | null | undefined, written: Record<string, unknown> | null | undefined, extraKeys: readonly string[] = []): Row | null {
  if (!row || typeof row !== 'object') return null;
  const out: Row = { id: row.id };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(row, k);
  for (const [k, v] of Object.entries(written ?? {})) {
    if (v !== undefined && has(k)) out[k] = row[k];
  }
  for (const k of extraKeys) if (has(k)) out[k] = row[k];
  return out;
}

type PriceListDb = { priceList?: { findMany?: (a: unknown) => Promise<unknown> } };

/**
 * أحداث تعديل العميل في معاملة الكتابة نفسها — الصورة «قبل» تحت القفل (lockCustomerImage) و«بعد» بالحقول المكتوبة (writtenImage)،
 * واسما قائمتي الأسعار حين كُتب نوع السعر وتغيّر. خطأ القاعدة يُرمى فيُلغي التعديل كلّه: لا تعديل بلا أثره
 */
export async function recordCustomerEdit(
  tx: unknown, tenantId: string, before: Row | null | undefined, after: Row | null | undefined, meta: ActivityMeta,
  opts: { extra?: Record<string, unknown> | null; taxOnly?: boolean } = {},
): Promise<void> {
  if (!before || !after || typeof after.id !== 'string' || !hasActivityTable(tx)) return;
  const ids = Object.prototype.hasOwnProperty.call(after, 'priceListId') ? priceListIdsChanged(before, after) : [];
  const pl = (tx as PriceListDb).priceList;
  let names: Map<string, string> | null = null;
  if (ids.length && pl && typeof pl.findMany === 'function') {
    const lists = (await pl.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })) as { id: string; name: string }[] | null;
    names = new Map((lists ?? []).map((l) => [l.id, l.name]));
  }
  await recordActivityInTx(tx, customerUpdateEvents(before, after, {
    tenantId, customerId: after.id, meta, priceListNames: names, extra: opts.extra ?? null, taxOnly: opts.taxOnly,
  }));
}

/** مهلة معاملة تعديل العميل: قفل صفّه ينتظر معاملة فاتورةٍ أو سندٍ تمسكه (تحدّث رصيده) — والكتابة نفسها قصيرة */
export const CUSTOMER_EDIT_TX = { maxWait: 10_000, timeout: 30_000 } as const;

const str = (v: unknown, n = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

/** حدث إضافة العميل (أو استيراده) — refType CUSTOMER بمعرّفه، ولحظته لحظة إنشائه (عميل صفّ المندوب بلحظة جهازه) */
export function customerCreatedInput(
  tenantId: string, customer: Row & { id: string }, meta: ActivityMeta,
  opts: { action?: 'CUSTOMER_CREATED' | 'CUSTOMER_IMPORTED'; data?: Record<string, unknown> | null } = {},
): ActivityInput {
  const at = customer.createdAt instanceof Date && !Number.isNaN(customer.createdAt.getTime()) ? customer.createdAt : undefined;
  return {
    tenantId, customerId: customer.id, action: opts.action ?? 'CUSTOMER_CREATED', actor: meta.actor, source: meta.source,
    refType: 'CUSTOMER', refId: customer.id,
    ...(at && { at }),
    data: {
      ...(str(customer.name) && { name: str(customer.name) }),
      ...(str(customer.businessName) && { businessName: str(customer.businessName) }),
      ...(typeof customer.number === 'number' && { number: customer.number }),
      ...(str(customer.code, 100) && { code: str(customer.code, 100) }),
      ...(str(customer.phone, 40) && { phone: str(customer.phone, 40) }),
      ...(str(customer.city, 100) && { city: str(customer.city, 100) }),
      ...(typeof customer.lat === 'number' && typeof customer.lng === 'number' && { hasLocation: true }),
      ...(opts.data ?? {}),
    },
  };
}

// لا حدث «حذف العميل» بعد اليوم — قرار المالك (٢٧ نوفمبر ٢٠٢٦): «بعد حذف العميل يحذف سجله معه»، فسجلّه كله يُحذف في معاملة
// حذفه (services/ownerPurge.ts purgeInTx، وroutes/import.ts للتراجع عن الاستيراد)

// ─── التجميع لكل عميل ───

/** عددٌ لكل عميل من صفوفٍ تحمل customerId (أو من groupBy بـ_count) — للأحداث المجمَّعة: حدثٌ واحد لكل عميلٍ متأثّر */
export function countByCustomer(rows: readonly { customerId: string | null; _count?: { _all?: number } | number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows ?? []) {
    if (!r || typeof r.customerId !== 'string' || !r.customerId) continue;
    const c = typeof r._count === 'number' ? r._count : (typeof r._count?._all === 'number' ? r._count._all : 1);
    m.set(r.customerId, (m.get(r.customerId) ?? 0) + c);
  }
  return m;
}

/** حدثٌ مجمَّع واحد لكل عميل (count في data) — نقل المستندات بين المناديب أو الفرق وما شابه */
export function perCustomerEvents(
  tenantId: string, counts: ReadonlyMap<string, number>, action: CustomerActivityAction, meta: ActivityMeta,
  data: Record<string, unknown>, refType?: ActivityInput['refType'],
): ActivityInput[] {
  const out: ActivityInput[] = [];
  for (const [customerId, count] of counts) {
    if (count <= 0) continue;
    out.push({ tenantId, customerId, action, actor: meta.actor, source: meta.source, ...(refType && { refType }), data: { ...data, count } });
  }
  return out;
}

// ─── طلبات المنيو: عميل الطلب ───
//
// قاعدة النسبة الواحدة (الكاتب هنا والقارئ routes/customerActivity.ts): طلب المنيو بلا customerId، فيُنسب لعميلٍ **حين يطابق جوالُه
// عميلاً واحداً بالضبط** من عملاء الشركة غير المحذوفين الموجودين لحظة الطلب (createdAt ≤ لحظة الطلب) — بمفتاح مطابقة تطبيق المندوب
// (orderPhoneKey: الأرقام الهندية لاتينيةً ثم phoneKey، ومفتاحٌ يصلح للمطابقة matchableKey). عميلان بالجوال نفسه (الجوال حرٌّ غير فريد
// منذ ١٤ نوفمبر ٢٠٢٦) ⇒ لا نسبة: لا يُلصق طلبٌ بعميلٍ ليس صاحبه، ولا يظهر طلبٌ على عميلين. وأوّل سطرٍ كُتب للطلب في السجلّ نهائيّ:
// إغلاقه وحذفه مع مندوبه يتبعان عميلَ ذلك السطر لا مطابقةً جديدة.

/** يطابق ذيلَ الجوال (آخر ثمانية أرقامٍ بعد ترجمة الأرقام الهندية) في SQL — والحكم بعده بالمفتاح الكامل في JS (uniqueCatalogMatch) */
const PHONE_TAIL_SQL = Prisma.sql`right(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 8)`;
/** سقف المرشّحين بذيلٍ واحد — بلوغه يجعل التفرّد غير مضمون فلا نسبة */
export const CATALOG_MATCH_LIMIT = 200;

/**
 * العميل الوحيد المطابق لمفتاح الجوال بين المرشّحين (ومن وُجد منهم لحظة asOf حين تُعطى) — أو null حين لا مطابق أو أكثر من واحد.
 * المفتاح غير الصالح للمطابقة لا يطابق شيئاً. نقيّة.
 */
export function uniqueCatalogMatch(
  key: string | null | undefined, candidates: readonly CustomerCandidate[], asOf?: Date | string | null,
): string | null {
  if (!matchableKey(key)) return null;
  const cut = asOf == null ? NaN : new Date(asOf).getTime();
  let found: string | null = null;
  for (const c of candidates ?? []) {
    if (!c || orderPhoneKey(c.phone) !== key) continue;
    if (Number.isFinite(cut) && new Date(c.createdAt).getTime() > cut) continue;
    if (found !== null && found !== c.id) return null;
    found = c.id;
  }
  return found;
}

type CatalogMatchDb = { $queryRaw: RawQuery };

/** عميل الطلب بقاعدة المطابقة الفريدة — مفتاح الطلب ولحظته (asOf). المفتاح غير الصالح ⇒ null بلا استعلام */
export async function matchCatalogCustomerUnique(
  db: unknown, tenantId: string, key: string | null | undefined, asOf?: Date | string | null,
): Promise<string | null> {
  if (!matchableKey(key)) return null;
  const d = db as Partial<CatalogMatchDb> | null | undefined;
  if (typeof d?.$queryRaw !== 'function') return null;
  const rows = await d.$queryRaw`
    SELECT id, name, phone, "createdAt" FROM customers
    WHERE "tenantId" = ${tenantId} AND status <> 'DELETED' AND ${PHONE_TAIL_SQL} = ${phoneTail(key)}
    LIMIT ${CATALOG_MATCH_LIMIT}`;
  const list = Array.isArray(rows) ? (rows as CustomerCandidate[]) : [];
  if (list.length >= CATALOG_MATCH_LIMIT) return null;
  return uniqueCatalogMatch(key, list, asOf);
}

export interface CatalogOrderRef { id: string; phoneKey: string | null; createdAt: Date | string }

type CatalogOwnerDb = CatalogMatchDb & {
  customerActivity: { findMany(a: unknown): Promise<unknown> };
};

/**
 * عملاء طلبات المنيو (معرّف الطلب ⇒ معرّف العميل) بالقاعدة الواحدة: عميل أوّل سطرٍ للطلب في السجلّ إن وُجد (نهائيّ)، وإلا المطابقة
 * الفريدة لحظة الطلب — استعلامٌ واحد لسطور السجلّ (دفعات ١٠٠٠، فهرس tenantId+refType+refId) وآخر لكل ذيول الجوالات. طلبٌ بلا
 * عميلٍ لا يرد في الخريطة. مقبضٌ بلا جدول السجل ⇒ خريطةٌ فارغة
 */
export async function catalogOrderCustomers(db: unknown, tenantId: string, orders: readonly CatalogOrderRef[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!orders?.length || !hasActivityTable(db)) return out;
  const d = db as unknown as CatalogOwnerDb;
  const ids = [...new Set(orders.map((o) => o.id))];
  for (let i = 0; typeof d.customerActivity.findMany === 'function' && i < ids.length; i += 1000) {
    const logged = (await d.customerActivity.findMany({
      where: { tenantId, refType: 'CATALOG_ORDER', refId: { in: ids.slice(i, i + 1000) } },
      orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { refId: true, customerId: true },
    })) as { refId: string | null; customerId: string }[] | null;
    for (const r of logged ?? []) if (r.refId && !out.has(r.refId)) out.set(r.refId, r.customerId);
  }
  const rest = orders.filter((o) => !out.has(o.id) && matchableKey(o.phoneKey));
  if (!rest.length || typeof d.$queryRaw !== 'function') return out;
  const tails = [...new Set(rest.map((o) => phoneTail(o.phoneKey as string)))];
  const rows = await d.$queryRaw`
    SELECT id, name, phone, "createdAt" FROM customers
    WHERE "tenantId" = ${tenantId} AND status <> 'DELETED' AND ${PHONE_TAIL_SQL} = ANY(${tails}::text[])`;
  const candidates = Array.isArray(rows) ? (rows as CustomerCandidate[]) : [];
  for (const o of rest) {
    const id = uniqueCatalogMatch(o.phoneKey, candidates, o.createdAt);
    if (id) out.set(o.id, id);
  }
  return out;
}

/** عميل طلب منيو واحد بالقاعدة الواحدة (catalogOrderCustomers) — أو null */
export async function catalogOrderCustomer(db: unknown, tenantId: string, order: CatalogOrderRef): Promise<string | null> {
  return (await catalogOrderCustomers(db, tenantId, [order])).get(order.id) ?? null;
}

// ─── حذف المندوب ───

type RepDb = {
  invoice: { groupBy(a: unknown): Promise<unknown> };
  receipt: { groupBy(a: unknown): Promise<unknown> };
  repVisit: { groupBy(a: unknown): Promise<unknown> };
  customerAssignment: { findMany(a: unknown): Promise<unknown> };
  repRouteStop?: { findMany?(a: unknown): Promise<unknown> };
  catalogOrder?: { findMany?(a: unknown): Promise<unknown> };
  customer?: { findMany?(a: unknown): Promise<unknown> };
};
type CountRows = { customerId: string | null; _count?: { _all?: number } | number }[];

/**
 * «أرشيف العميل»: ما يصيب عملاء المندوب بحذفه — يُقرأ قبل التفريغ والحذف في معاملة الحذف نفسها (حذف المدير routes/salesReps.ts،
 * والحذف النهائي للمالك routes/ownerPurge.ts)، ومقبضٌ بلا جدول السجل (المزيّف القديم) لا يُقرأ له شيء:
 *   • حدثٌ مجمَّع لكل عميلٍ متأثّر (عدده في data.count): فواتيره وسنداته تبقى بلا مندوب (INVOICE_REASSIGNED / RECEIPT_REASSIGNED
 *     إلى «بلا مندوب»)، وزياراته تُحذف معه (VISIT_DELETED)، وإسناده يُنزع (CUSTOMER_UNASSIGNED).
 *   • وما يحذفه التعاقب (onDelete: Cascade) بلا سطرٍ في المسار: محطّات خطوط المندوب النشطة ⇒ ROUTE_STOP_REMOVED لكل عميلٍ في كل
 *     خطّ (مرجع ROUTE بمعرّف الخطّ كحذف الخطّ نفسه)، وطلبات المنيو المرسلة إليه ⇒ CATALOG_ORDER_UPDATED (newStatus DELETED) على
 *     عميل الطلب بالقاعدة الواحدة (catalogOrderCustomers).
 *   • وما يفرّغه SetNull في بطاقة العميل: «المندوب الذي أضاف العميل» ⇒ CUSTOMER_UPDATED بالحقل من المندوب إلى لا أحد.
 */
export async function repDeleteEvents(tx: unknown, tenantId: string, rep: { id: string; name: string | null }, meta: ActivityMeta, reason: string): Promise<ActivityInput[]> {
  if (!hasActivityTable(tx)) return [];
  const db = tx as unknown as RepDb;
  const mine = { tenantId, salesRepId: rep.id };
  const invoices = (await db.invoice.groupBy({ by: ['customerId'], where: mine, _count: { _all: true } })) as CountRows;
  const receipts = (await db.receipt.groupBy({ by: ['customerId'], where: mine, _count: { _all: true } })) as CountRows;
  const visits = (await db.repVisit.groupBy({ by: ['customerId'], where: mine, _count: { _all: true } })) as CountRows;
  const assigned = (await db.customerAssignment.findMany({ where: mine, select: { customerId: true } })) as CountRows;
  const moved = { kind: 'REP', fromRepId: rep.id, fromRep: rep.name, toRep: null, reason };
  const repInfo = { salesRepId: rep.id, repName: rep.name, reason };
  const base = { tenantId, actor: meta.actor, source: meta.source };

  // محطّات خطوط المندوب النشطة (بقايا الخطوط الموقوفة خرجت يوم أُوقفت) — حدثٌ لكل عميلٍ في كل خطّ
  const stopDb = db.repRouteStop;
  const stops: { customerId: string; routeId: string; route?: { name?: string | null } | null }[] = [];
  if (stopDb && typeof stopDb.findMany === 'function') {
    const rows = await stopDb.findMany({
      where: { tenantId, route: { salesRepId: rep.id, isActive: true } },
      select: { customerId: true, routeId: true, route: { select: { name: true } } },
    });
    if (Array.isArray(rows)) stops.push(...rows);
  }
  const seenStop = new Set<string>();
  const stopEvents: ActivityInput[] = [];
  for (const s of stops) {
    const key = `${s.customerId}|${s.routeId}`;
    if (!s.customerId || seenStop.has(key)) continue;
    seenStop.add(key);
    stopEvents.push({
      ...base, customerId: s.customerId, action: 'ROUTE_STOP_REMOVED', refType: 'ROUTE', refId: s.routeId,
      data: { ...(s.route?.name && { routeName: s.route.name }), salesRepId: rep.id, ...(rep.name && { repName: rep.name }), reason },
    });
  }

  // طلبات المنيو المرسلة إلى المندوب (تُحذف معه) — على عميل كل طلبٍ بالقاعدة الواحدة
  const orderDb = db.catalogOrder;
  const orders: (CatalogOrderRef & { status?: string | null })[] = [];
  if (orderDb && typeof orderDb.findMany === 'function') {
    const rows = await orderDb.findMany({ where: mine, select: { id: true, phoneKey: true, status: true, createdAt: true } });
    if (Array.isArray(rows)) orders.push(...rows);
  }
  const owners = await catalogOrderCustomers(tx, tenantId, orders);
  const orderEvents: ActivityInput[] = [];
  for (const o of orders) {
    const customerId = owners.get(o.id);
    if (!customerId) continue;
    orderEvents.push({
      ...base, customerId, action: 'CATALOG_ORDER_UPDATED', refType: 'CATALOG_ORDER', refId: o.id,
      data: { oldStatus: o.status ?? null, newStatus: 'DELETED', salesRepId: rep.id, ...(rep.name && { repName: rep.name }), reason },
    });
  }

  // «المندوب الذي أضاف العميل» يُفرَّغ (SetNull) — تغيّرٌ في بطاقة كل عميلٍ أضافه
  const customerDb = db.customer;
  const created: { id: string }[] = [];
  if (customerDb && typeof customerDb.findMany === 'function') {
    const rows = await customerDb.findMany({ where: { tenantId, createdBySalesRepId: rep.id }, select: { id: true } });
    if (Array.isArray(rows)) created.push(...rows);
  }
  const creatorEvents: ActivityInput[] = created.filter((c) => !!c?.id).map((c) => ({
    ...base, customerId: c.id, action: 'CUSTOMER_UPDATED' as const, refType: 'CUSTOMER' as const, refId: c.id,
    data: { changes: [{ field: 'createdBySalesRepId', from: rep.id, to: null }], salesRepId: rep.id, ...(rep.name && { repName: rep.name }), reason },
  }));

  return [
    ...perCustomerEvents(tenantId, countByCustomer(invoices ?? []), 'INVOICE_REASSIGNED', meta, moved, 'INVOICE'),
    ...perCustomerEvents(tenantId, countByCustomer(receipts ?? []), 'RECEIPT_REASSIGNED', meta, moved, 'RECEIPT'),
    ...perCustomerEvents(tenantId, countByCustomer(visits ?? []), 'VISIT_DELETED', meta, repInfo, 'VISIT'),
    ...perCustomerEvents(tenantId, countByCustomer(assigned ?? []), 'CUSTOMER_UNASSIGNED', meta, repInfo, 'ASSIGNMENT').map((e) => ({ ...e, refId: rep.id })),
    ...stopEvents,
    ...orderEvents,
    ...creatorEvents,
  ];
}

// ─── أسعار العملاء الخاصة لصنف ───

type PriceDb = {
  customerPrice: { findMany(a: { where: unknown; select: { customerId: true; price: true } }): Promise<{ customerId: string; price: number }[]> };
  product: { findFirst(a: { where: unknown; select: { name: true; unit: true } }): Promise<{ name: string; unit: string } | null> };
};

/** ما يصيب أسعار العملاء الخاصة لصنفٍ بإجراءٍ على الصنف نفسه */
export type ProductPriceChange =
  | { action: 'CUSTOMER_PRICE_REMOVED'; reason: 'PRODUCT_DELETED' | 'PRODUCT_MERGED' | 'OWNER_PURGE' | 'IMPORT_REVERTED'; mergedInto?: string | null }
  | { action: 'CUSTOMER_PRICE_SET'; reason: 'BASE_UNIT_CONVERTED'; factor: number; fromUnit: string; toUnit: string };

/**
 * «أرشيف العميل»: حدثٌ لكل عميلٍ له سعرٌ خاصّ لهذا الصنف — يُقرأ قبل الكتابة (حذف الصنف أو دمجه يحذف أسعاره، وتحويل وحدة الأساس
 * يقسمها على المعامل) ويُكتب في المعاملة نفسها. المرجع PRICE بمعرّف الصنف (عرف services/customerActivity.ts). مقبضٌ بلا جدول السجل
 * (المزيّف القديم) لا يُقرأ له شيء
 */
export async function productCustomerPriceEvents(
  tx: unknown, tenantId: string, productId: string, meta: ActivityMeta, change: ProductPriceChange,
): Promise<ActivityInput[]> {
  if (!hasActivityTable(tx)) return [];
  const db = tx as unknown as PriceDb;
  const rows = await db.customerPrice.findMany({ where: { productId, product: { tenantId } }, select: { customerId: true, price: true } });
  if (!rows?.length) return [];
  const p = await db.product.findFirst({ where: { id: productId, tenantId }, select: { name: true, unit: true } });
  return rows.map((r) => {
    const price = Number(r.price);
    const data: Record<string, unknown> = change.action === 'CUSTOMER_PRICE_REMOVED'
      ? { productId, productName: p?.name ?? null, unit: p?.unit ?? null, price, reason: change.reason, ...(change.mergedInto && { mergedInto: change.mergedInto }) }
      : {
        productId, productName: p?.name ?? null, from: price, to: change.factor > 0 ? price / change.factor : price,
        fromUnit: change.fromUnit, toUnit: change.toUnit, factor: change.factor, reason: change.reason,
      };
    return {
      tenantId, customerId: r.customerId, action: change.action, actor: meta.actor, source: meta.source,
      refType: 'PRICE' as const, refId: productId, data,
    };
  });
}

/**
 * غلافا موجّه الأصناف (routes/products.ts): حذف الصنف وتحويل وحدة أساسه — الرموز هنا لا في الموجّه (مستند الربط البرمجي يُلزم
 * توثيق كل رمزٍ نصّيّ في ملف موجّه الأصناف، وهذه رموز سجلّ العميل لا ردودٌ للمكامل)
 */
export function productDeletedPriceEvents(tx: unknown, tenantId: string, productId: string, meta: ActivityMeta): Promise<ActivityInput[]> {
  return productCustomerPriceEvents(tx, tenantId, productId, meta, { action: 'CUSTOMER_PRICE_REMOVED', reason: 'PRODUCT_DELETED' });
}
export function productBaseConvertedPriceEvents(
  tx: unknown, tenantId: string, productId: string, meta: ActivityMeta, conv: { factor: number; fromUnit: string; toUnit: string },
): Promise<ActivityInput[]> {
  return productCustomerPriceEvents(tx, tenantId, productId, meta, { action: 'CUSTOMER_PRICE_SET', reason: 'BASE_UNIT_CONVERTED', ...conv });
}

// ─── خطوط السير ───

export interface RouteStopRef {
  customerId: string; routeId: string; routeName: string | null; salesRepId: string | null;
  /** تاريخ دخول العميل خطّ المندوب (طابع المحطّة) — يرثه الحفظ للعميل الباقي فلا يُعدّ دخوله «الآن» (routes/repRoutes.ts) */
  createdAt?: Date | null;
}

/**
 * تاريخ دخول كل عميلٍ باقٍ خطّ مندوبه: أقدم طابع محطّةٍ له في خطوط المندوب نفسه التي حذفها الحفظ — فإعادة حفظ الخطّ (حذفٌ وإنشاء)
 * لا تجعل عضويةً قديمة تبدو جديدة، ولا يضيع تاريخها قبل بدء السجلّ. عميلٌ في خطّ مندوبٍ آخر (غُيّر المندوب) دخل الجديد الآن. نقيّة
 */
export function keptStopDates(old: readonly RouteStopRef[], repId: string): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const s of old) {
    if (s.salesRepId !== repId || !(s.createdAt instanceof Date) || Number.isNaN(s.createdAt.getTime())) continue;
    const cur = out.get(s.customerId);
    if (!cur || s.createdAt < cur) out.set(s.customerId, s.createdAt);
  }
  return out;
}

/**
 * فرق محطّات الحفظ: من دخل خطّ المندوب ومن خرج منه — حدثٌ لكل عميلٍ تغيّر حاله، لا لكل محطّةٍ بقيت. «القديم» محطّات الخطوط
 * النشطة التي حذفها الحفظ؛ والخطّ الجديد لمندوب newRepId. عميلٌ في خطٍّ قديم لمندوبٍ آخر (غُيّر المندوب في التعديل) خرج من خطّ ذاك
 * ولو بقي في الجديد. نقيّة.
 */
export function diffRouteStops(old: readonly RouteStopRef[], next: readonly string[], newRepId: string): { added: string[]; removed: RouteStopRef[] } {
  const sameRepOld = new Set(old.filter((s) => s.salesRepId === newRepId).map((s) => s.customerId));
  const nextSet = new Set(next);
  const added = [...nextSet].filter((c) => !sameRepOld.has(c));
  const removed: RouteStopRef[] = [];
  const seen = new Set<string>();
  for (const s of old) {
    const stays = s.salesRepId === newRepId && nextSet.has(s.customerId);
    const key = `${s.customerId}|${s.salesRepId ?? ''}`;
    if (stays || seen.has(key)) continue;
    seen.add(key);
    removed.push(s);
  }
  return { added, removed };
}
