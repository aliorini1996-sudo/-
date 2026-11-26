/**
 * «سجلّ العميل» — السجلّ الزمني الثابت لكل إجراءٍ على العميل (طلب المالك ٢٦ نوفمبر ٢٠٢٦):
 * «اجعله يستعرض كل اجراء او عمل يتم مع هذا العميل… زيارة او فاتورة او سند او اي شئ بلا استثناء… من قبل اي شخص كان سواء مندوب
 * او اداري… و اجعل سجل العميل هذا لا يمكن لاحد تغيير اي شيء في نهائيا».
 *
 * هذا الملف **العقد المشترك** لكل موضع كتابة: كل مسارٍ أو خدمةٍ تُنشئ أو تغيّر شيئاً يخصّ عميلاً تستدعي recordCustomerActivity
 * — بعميل المعاملة نفسها (tx) متى كانت داخل معاملة، فيُلتزم السطر مع الإجراء أو يُتراجع عنه معه (لا سطر لإجراءٍ لم يقع،
 * ولا إجراء بلا سطر). والجدول إلحاقيٌّ فقط (CustomerActivity): لا مسار يعدّله أو يحذفه، ومُطلِق القاعدة يرفض ذلك
 * (services/customerActivityGuard.ts) إلا حذف الشركة كلها أو حذف العميل نفسه (سجلّه كله معه — قرار المالك ٢٧ نوفمبر ٢٠٢٦).
 *
 * أعراف المراجع (refType → refId) — يطابق بها القارئ (routes/customerActivity.ts) السجلّ بالتاريخ المشتقّ فلا يتكرّر شيء:
 *   CUSTOMER → customer.id · INVOICE → invoice.id (والمرتجع والإشعاران) · RECEIPT → receipt.id · VISIT → repVisit.id
 *   DOCUMENT → customerDocument.id · PAYLINK → customerPaymentLink.id · CARD_PAYMENT → cardPayment.id
 *   ADJUSTMENT → customerAdjustment.id (= accountEntry.id لصفّ التسوية أو الرصيد الافتتاحي) · CATALOG_ORDER → catalogOrder.id
 *   CALL → callLog.id · ROUTE → repRoute.id (محطّة العميل في الخط) · PRICE → product.id (سعر العميل الخاص للصنف)
 *   ASSIGNMENT → salesRep.id (إسناد العميل لمندوب)
 * ورقم المستند (الفاتورة/السند) في refNo، والمبلغ رقماً في amount، والتفاصيل في data — ولا أسرار ولا رموز ولا صور فيها أبداً.
 *
 * عُرف المبلغ (amount) — ثابتٌ لكل مصدرٍ حيٍّ ومشتقّ فتُجمع الأسطر وتُقارن (services/customerActivityDocs.ts balanceEffect مصدره):
 *   • المستند (فاتورة، مرتجع، إشعار، سند قبض، رابط دفع، عملية بطاقة): قيمته موجبةً كما طُبعت — ونوع الحدث يقول اتجاهه.
 *   • ما يمسّ الرصيد مباشرةً (ADJUSTMENT_* وOPENING_BALANCE_SET وLEDGER_JOURNAL_*): **أثره الموقَّع على رصيد العميل** = مدين − دائن —
 *     شطب دينٍ معدوم ٥٠٠ ⇒ −٥٠٠، وردّ رصيدٍ دائن ⇒ +٥٠٠، ورصيدٌ افتتاحي دائن ⇒ سالب، وإلغاء أيٍّ منها ⇒ سالب أثره الأصلي.
 *
 * اللحظتان: `at` لحظة الإجراء (قد تأتي من الجهاز دون اتصال، ولا تتجاوز «الآن» إلا بهامش ساعةٍ صغير — activityRow)، و`recordedAt`
 * لحظة الإدراج بساعة القاعدة وحدها (لا تُكتب من مُدخلٍ أبداً) — وبها يُحسب «بدء سجلّ الشركة» فلا يحرّكه تأريخٌ يدوي.
 */
import { Prisma } from '@prisma/client';
import type { AuthRequest } from '../types';

// ═══ الفاعل ═══

export type ActivityActorKind = 'ADMIN' | 'REP' | 'OWNER' | 'STAFF' | 'API' | 'CUSTOMER' | 'SYSTEM';
export const ACTOR_KINDS: readonly ActivityActorKind[] = ['ADMIN', 'REP', 'OWNER', 'STAFF', 'API', 'CUSTOMER', 'SYSTEM'];

export interface ActivityActor { kind: ActivityActorKind; id: string | null; name: string | null }

/** النظام نفسه (المجدولات والمسح وانتهاء الروابط) — بلا هوية */
export const SYSTEM_ACTOR: ActivityActor = Object.freeze({ kind: 'SYSTEM', id: null, name: null }) as ActivityActor;

const ACTOR_TEXT_MAX = 200;

/** نصٌّ قصير غير فارغ أو null */
function shortText(v: unknown, max = ACTOR_TEXT_MAX): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

type ReqUser = NonNullable<AuthRequest['user']> & { byName?: unknown; apiKeyName?: unknown };

/** اسم أفعال المنصّة (جلسة المالك أو موظفه، ومفتاحٌ أصدره الدعم) كما تراه الشركة — عرف النظام (services/customerDocs.ts docUploader) */
export const PLATFORM_SUPPORT_NAME = 'الدعم الفني';

/**
 * من فعلها — من هوية الطلب المصادَق، ولا يرمي أبداً (طلبٌ بلا هوية ⇒ النظام):
 *  • مفتاح «الربط البرمجي» ⇒ API بمعرّف المفتاح (والاسم وسمُ المفتاح متى حمله الطلب، وإلا يُحلّ عند القراءة) — والمفتاح الذي
 *    أصدره الدعم الفني (ownerIssuedKey) باسم «الدعم الفني» كجلسته (docUploader)، لا بوسمه.
 *  • جلسة «دخول» المالك ⇒ OWNER بمعرّف المالك وبلا اسم مدير الشركة الذي وُقّع به التوكن (كـactorOf: «لا يدخل حسابك إلا مديره»)،
 *    وجلسة موظف المنصة ⇒ STAFF بمعرّفه (واسمه متى حمله الطلب).
 *  • المندوب ⇒ REP، ومستخدم الشركة ⇒ ADMIN — باسمه لقطةً لحظة الإجراء.
 */
export function actorFromReq(req: AuthRequest | { user?: AuthRequest['user'] | null } | null | undefined): ActivityActor {
  try {
    const u = (req?.user ?? null) as ReqUser | null;
    if (!u) return { ...SYSTEM_ACTOR };
    if (u.apiKeyId) return { kind: 'API', id: shortText(u.apiKeyId), name: u.ownerIssuedKey === true ? PLATFORM_SUPPORT_NAME : shortText(u.apiKeyName) };
    if (u.impersonated === true) {
      if (u.byKind === 'STAFF') return { kind: 'STAFF', id: shortText(u.by), name: shortText(u.byName) };
      return { kind: 'OWNER', id: shortText(u.by), name: null };
    }
    if (u.role === 'SALES_REP') return { kind: 'REP', id: shortText(u.id), name: shortText(u.name) };
    if (u.role === 'SUPER_ADMIN') return { kind: 'OWNER', id: shortText(u.id), name: null };
    if (u.role === 'PLATFORM_STAFF') return { kind: 'STAFF', id: shortText(u.id), name: shortText(u.name) };
    return { kind: 'ADMIN', id: shortText(u.id), name: shortText(u.name) };
  } catch {
    return { ...SYSTEM_ACTOR };
  }
}

/** العميل الخارجي (المنيو العام، صفحة الدفع) — باسمه كما كتبه */
export function customerActor(name?: string | null): ActivityActor {
  return { kind: 'CUSTOMER', id: null, name: shortText(name) };
}

export type ActivitySource = 'web' | 'rep' | 'm' | 'api' | 'import' | 'public' | 'system';

/**
 * من أين جاء الطلب — أفضل جهد: المفتاح ⇒ api، المندوب ⇒ rep، وتطبيق الإدارة على الجوال (/m) يُعرف بترويسة X-FS-Client
 * أو بصفحة المُحيل (Referer)، وما سواه ⇒ web. لا يرمي.
 */
export function sourceFromReq(req: AuthRequest | { user?: AuthRequest['user'] | null; headers?: unknown } | null | undefined): 'web' | 'rep' | 'm' | 'api' {
  try {
    const u = req?.user;
    if (u?.apiKeyId) return 'api';
    if (u?.role === 'SALES_REP') return 'rep';
    const headers = ((req as { headers?: Record<string, unknown> } | null)?.headers ?? {}) as Record<string, unknown>;
    const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
    const client = String(first(headers['x-fs-client']) ?? '').trim().toLowerCase();
    if (client === 'm' || client === 'web' || client === 'rep' || client === 'api') return client as 'web' | 'rep' | 'm' | 'api';
    const ref = String(first(headers.referer ?? headers.referrer) ?? '');
    if (ref) {
      let path = ref;
      try { path = new URL(ref).pathname; } catch { /* مسارٌ نسبي */ }
      if (/^\/(?:[a-z]{2}\/)?m(?:\/|$|\?|#)/i.test(path)) return 'm';
    }
    return 'web';
  } catch {
    return 'web';
  }
}

// ═══ الإجراءات والمراجع ═══

export type ActivityRefType =
  | 'CUSTOMER' | 'INVOICE' | 'RECEIPT' | 'VISIT' | 'DOCUMENT' | 'PAYLINK' | 'CARD_PAYMENT' | 'ADJUSTMENT' | 'CATALOG_ORDER'
  | 'CALL' | 'ROUTE' | 'PRICE' | 'ASSIGNMENT';
export const REF_TYPES: readonly ActivityRefType[] = [
  'CUSTOMER', 'INVOICE', 'RECEIPT', 'VISIT', 'DOCUMENT', 'PAYLINK', 'CARD_PAYMENT', 'ADJUSTMENT', 'CATALOG_ORDER', 'CALL', 'ROUTE',
  'PRICE', 'ASSIGNMENT',
];

export const CUSTOMER_ACTIONS = [
  'CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_DELETED', 'CUSTOMER_IMPORTED', 'CUSTOMER_STATUS_CHANGED', 'CUSTOMER_LOCATION_SET',
  'CUSTOMER_ASSIGNED', 'CUSTOMER_UNASSIGNED', 'CUSTOMER_PRICE_SET', 'CUSTOMER_PRICE_REMOVED', 'CUSTOMER_PRICE_LIST_CHANGED',
  'CUSTOMER_TAX_DATA_UPDATED',
  'INVOICE_ISSUED', 'RETURN_ISSUED', 'CREDIT_NOTE_ISSUED', 'DEBIT_NOTE_ISSUED', 'INVOICE_CANCELLED', 'INVOICE_VOIDED', 'INVOICE_EXPIRED',
  'INVOICE_REISSUED', 'INVOICE_REASSIGNED', 'INVOICE_PAID', 'INVOICE_UPDATED', 'INVOICE_DELETED',
  'RECEIPT_ISSUED', 'RECEIPT_CANCELLED', 'RECEIPT_REASSIGNED', 'RECEIPT_DELETED', 'ADJUSTMENT_CREATED', 'ADJUSTMENT_UPDATED',
  'OPENING_BALANCE_SET', 'LEDGER_JOURNAL_POSTED', 'LEDGER_JOURNAL_REVERSED',
  'PAYLINK_CREATED', 'PAYLINK_PAID', 'PAYLINK_CANCELLED', 'PAYLINK_EXPIRED', 'PAYLINK_REFUNDED',
  'CARD_PAYMENT_COMPLETED', 'CARD_PAYMENT_FAILED', 'CARD_PAYMENT_REVERSED', 'CARD_PAYMENT_HELD',
  'VISIT_RECORDED', 'VISIT_DELETED', 'VISIT_REASSIGNED', 'DOCUMENT_ADDED', 'DOCUMENT_REMOVED', 'ROUTE_STOP_ADDED', 'ROUTE_STOP_REMOVED',
  'CALL_LOGGED', 'SMART_REP_OUTCOME', 'CATALOG_ORDER_PLACED', 'CATALOG_ORDER_UPDATED', 'OTHER',
] as const;
export type CustomerActivityAction = typeof CUSTOMER_ACTIONS[number];
const ACTION_SET: ReadonlySet<string> = new Set(CUSTOMER_ACTIONS);

/** نوع إصدار المستند من نوعه: الإشعار الدائن/المدين بـdocumentKind، والمرتجع بـtype، وما سواه فاتورة */
export function invoiceIssueAction(inv: { type?: string | null; documentKind?: string | null }): CustomerActivityAction {
  if (inv.documentKind === 'CREDIT_NOTE') return 'CREDIT_NOTE_ISSUED';
  if (inv.documentKind === 'DEBIT_NOTE') return 'DEBIT_NOTE_ISSUED';
  if (inv.type === 'RETURN') return 'RETURN_ISSUED';
  return 'INVOICE_ISSUED';
}

// ═══ التصنيف (مرشّحات الواجهة) ═══

export const ACTIVITY_CATEGORIES = ['visits', 'sales', 'returns', 'money', 'docs', 'edits', 'other'] as const;
export type ActivityCategory = typeof ACTIVITY_CATEGORIES[number];

/** تصنيف كل إجراء — مصدرٌ واحد يقرؤه القارئ ويعيده مع كل سطر (category) فلا تفترق الواجهة عن الخادم */
export const ACTION_CATEGORY: Readonly<Record<CustomerActivityAction, ActivityCategory>> = Object.freeze({
  CUSTOMER_CREATED: 'edits', CUSTOMER_UPDATED: 'edits', CUSTOMER_DELETED: 'edits', CUSTOMER_IMPORTED: 'edits',
  CUSTOMER_STATUS_CHANGED: 'edits', CUSTOMER_LOCATION_SET: 'edits', CUSTOMER_ASSIGNED: 'edits', CUSTOMER_UNASSIGNED: 'edits',
  CUSTOMER_PRICE_SET: 'edits', CUSTOMER_PRICE_REMOVED: 'edits', CUSTOMER_PRICE_LIST_CHANGED: 'edits', CUSTOMER_TAX_DATA_UPDATED: 'edits',
  INVOICE_ISSUED: 'sales', DEBIT_NOTE_ISSUED: 'sales', INVOICE_CANCELLED: 'sales', INVOICE_VOIDED: 'sales', INVOICE_EXPIRED: 'sales',
  INVOICE_REISSUED: 'sales', INVOICE_REASSIGNED: 'sales', INVOICE_PAID: 'sales', INVOICE_UPDATED: 'sales', INVOICE_DELETED: 'sales',
  CATALOG_ORDER_PLACED: 'sales', CATALOG_ORDER_UPDATED: 'sales',
  RETURN_ISSUED: 'returns', CREDIT_NOTE_ISSUED: 'returns',
  RECEIPT_ISSUED: 'money', RECEIPT_CANCELLED: 'money', RECEIPT_REASSIGNED: 'money', RECEIPT_DELETED: 'money', ADJUSTMENT_CREATED: 'money',
  ADJUSTMENT_UPDATED: 'money', OPENING_BALANCE_SET: 'money', LEDGER_JOURNAL_POSTED: 'money', LEDGER_JOURNAL_REVERSED: 'money',
  PAYLINK_CREATED: 'money', PAYLINK_PAID: 'money', PAYLINK_CANCELLED: 'money', PAYLINK_EXPIRED: 'money', PAYLINK_REFUNDED: 'money',
  CARD_PAYMENT_COMPLETED: 'money', CARD_PAYMENT_FAILED: 'money', CARD_PAYMENT_REVERSED: 'money', CARD_PAYMENT_HELD: 'money',
  VISIT_RECORDED: 'visits', VISIT_DELETED: 'visits', VISIT_REASSIGNED: 'visits', ROUTE_STOP_ADDED: 'visits',
  ROUTE_STOP_REMOVED: 'visits', CALL_LOGGED: 'visits', SMART_REP_OUTCOME: 'visits',
  DOCUMENT_ADDED: 'docs', DOCUMENT_REMOVED: 'docs',
  OTHER: 'other',
});

export function categoryOfAction(action: string): ActivityCategory {
  return (ACTION_CATEGORY as Record<string, ActivityCategory>)[action] ?? 'other';
}

export function actionsOfCategory(category: ActivityCategory): CustomerActivityAction[] {
  return CUSTOMER_ACTIONS.filter((a) => ACTION_CATEGORY[a] === category);
}

/**
 * إجراءات «الميلاد»: السطر الذي يقول إن المرجع وُجد (أُصدر/أُنشئ/سُجّل…). القارئ يُسقط السطر المشتقّ من الجداول لمرجعٍ له
 * سطرُ ميلادٍ في السجلّ (لا يظهر مرّتين)، ويُبقيه لمرجعٍ قديم سُجّل له بعد ذلك إلغاءٌ وحده (لا يضيع إصداره).
 * ومحاولة البطاقة التي لم تتمّ (CARD_PAYMENT_FAILED) أو عكسها أو تعليقها للمراجعة ليست ميلاداً: عمليةٌ وافقت قبل بدء السجلّ
 * وعُكست بعده يبقى تحصيلها المشتقّ (COMPLETED) ومعه سطر العكس الحيّ
 */
export const CREATION_ACTIONS: ReadonlySet<string> = new Set<CustomerActivityAction>([
  'CUSTOMER_CREATED', 'CUSTOMER_IMPORTED', 'CUSTOMER_ASSIGNED', 'CUSTOMER_PRICE_SET',
  'INVOICE_ISSUED', 'RETURN_ISSUED', 'CREDIT_NOTE_ISSUED', 'DEBIT_NOTE_ISSUED',
  'RECEIPT_ISSUED', 'ADJUSTMENT_CREATED', 'OPENING_BALANCE_SET', 'PAYLINK_CREATED', 'CARD_PAYMENT_COMPLETED',
  'VISIT_RECORDED', 'DOCUMENT_ADDED', 'ROUTE_STOP_ADDED', 'CALL_LOGGED', 'CATALOG_ORDER_PLACED',
]);

// ═══ الكتابة ═══

export interface ActivityInput {
  tenantId: string;
  customerId: string;
  action: CustomerActivityAction;
  actor: ActivityActor;
  refType?: ActivityRefType;
  refId?: string | null;
  refNo?: string | null;
  amount?: number | string | Prisma.Decimal | null;
  data?: Record<string, unknown> | null;
  source?: string | null;
  at?: Date;
}

/** سقف التفاصيل بعد التسلسل (بايت) وسقف كل نص فيها */
export const ACTIVITY_DATA_MAX_BYTES = 8 * 1024;
export const ACTIVITY_STRING_MAX = 500;
const MAX_DEPTH = 5;
const MAX_ARRAY = 100;
const MAX_KEYS = 100;

/** مفاتيح لا تُحفظ قيمتها أبداً: كلمات المرور والرموز والمفاتيح والتواقيع وأرقام البطاقات */
const SECRET_KEY_RE = /(password|passwd|secret|token|apikey|api_key|authorization|cookie|otp|cvv|keyhash|privatekey|signature|maskedpan|cardnumber|iban)$/i;

const isDecimalLike = (v: object): boolean =>
  typeof (v as { toNumber?: unknown }).toNumber === 'function' && typeof (v as { isFinite?: unknown }).isFinite === 'function';

function clipString(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** قيمةٌ صالحةٌ لـJSON: يُسقط undefined والدوالّ، ويقصّ النصوص، ويستبعد الصور (data:) والأسرار، ويحوّل التاريخ والعشري */
function sanitizeValue(v: unknown, depth: number, strMax: number, arrMax: number): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case 'string':
      // صورةٌ أو ملفٌّ مضمَّن (data URL) لا يُحفظ في السجلّ أبداً
      if (/^data:[^,]{0,100};base64,/i.test(v.slice(0, 120))) return '[omitted]';
      return clipString(v, strMax);
    case 'number': return Number.isFinite(v) ? v : null;
    case 'boolean': return v;
    case 'bigint': return v.toString();
    case 'undefined': case 'function': case 'symbol': return undefined;
    default: break;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'object' && isDecimalLike(v)) {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(v)) {
    const out = v.slice(0, arrMax).map((x) => {
      const s = sanitizeValue(x, depth + 1, strMax, arrMax);
      return s === undefined ? null : s;
    });
    if (v.length > arrMax) out.push(`…+${v.length - arrMax}`);
    return out;
  }
  if (typeof v === 'object') {
    if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) return '[omitted]';
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (n >= MAX_KEYS) break;
      if (SECRET_KEY_RE.test(k)) continue;
      const s = sanitizeValue(x, depth + 1, strMax, arrMax);
      if (s === undefined) continue;
      out[clipString(k, 100)] = s;
      n++;
    }
    return out;
  }
  return undefined;
}

const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

/**
 * تفاصيل السطر بعد التنظيف — كائنٌ أو null. ما زاد على السقف يُقصّ تدريجياً (نصوصٌ أقصر وقوائم أقصر)، وإن بقي كبيراً
 * تُحفظ أسماء مفاتيحه وحدها بعلامة القصّ — لا يُرفض الإجراء بسبب تفاصيله أبداً
 */
export function sanitizeActivityData(data: unknown): Record<string, unknown> | null {
  try {
    if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data) || data instanceof Date) return null;
    for (const [strMax, arrMax] of [[ACTIVITY_STRING_MAX, MAX_ARRAY], [120, 20], [40, 5]] as const) {
      const out = sanitizeValue(data, 0, strMax, arrMax) as Record<string, unknown> | undefined;
      if (!out || typeof out !== 'object') return null;
      if (Object.keys(out).length === 0) return null;
      if (jsonBytes(out) <= ACTIVITY_DATA_MAX_BYTES) return out;
    }
    return { truncated: true, keys: Object.keys(data as Record<string, unknown>).slice(0, 50).map((k) => clipString(k, 60)) };
  } catch {
    return null;
  }
}

/** أقصى ما يتّسع له عمود المبلغ Decimal(18,4): أقلّ من ١٠^١٤ قيمةً مطلقة */
const AMOUNT_COLUMN_LIMIT = new Prisma.Decimal('1e14');

/** المبلغ رقماً عشرياً صالحاً أو null */
function toDecimal(v: unknown): Prisma.Decimal | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const d = v instanceof Prisma.Decimal ? v : new Prisma.Decimal(typeof v === 'object' && isDecimalLike(v as object) ? String(v) : (v as number | string));
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * هامش ساعة الجهاز فوق «الآن» للحظة الإجراء: لحظةٌ أبعد في المستقبل (ساعة جهازٍ خاطئة أو تأريخٌ يدوي) لا تُحفظ — تُسقط فيأخذ السطر
 * لحظة إدراجه، وتبقى المُرسلة في data.claimedAt للتدقيق — فلا يُثبَّت بندٌ أعلى السجلّ إلى ذلك اليوم
 */
export const ACTIVITY_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** صفّ الإدراج من مُدخَلٍ واحد — أو null إن غاب ما لا يقوم السطر بدونه (الشركة والعميل). recordedAt لا يُحمل أبداً (ساعة القاعدة) */
export function activityRow(input: ActivityInput, now = Date.now()): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null;
  const tenantId = shortText(input.tenantId);
  const customerId = shortText(input.customerId);
  if (!tenantId || !customerId) return null;
  const rawAction = typeof input.action === 'string' ? input.action : '';
  const known = ACTION_SET.has(rawAction);
  const actor = (input.actor && typeof input.actor === 'object' ? input.actor : SYSTEM_ACTOR) as Partial<ActivityActor>;
  const kind = (ACTOR_KINDS as readonly string[]).includes(String(actor.kind)) ? (actor.kind as ActivityActorKind) : 'SYSTEM';
  const refType = (REF_TYPES as readonly string[]).includes(String(input.refType)) ? input.refType : null;
  let data = sanitizeActivityData(input.data);
  // إجراءٌ خارج القائمة لا يُرفض: يُحفظ «أخرى» واسمه في التفاصيل
  if (!known && rawAction) data = { ...(data ?? {}), action: clipString(rawAction, 80) };
  const row: Record<string, unknown> = {
    tenantId,
    customerId,
    action: known ? rawAction : 'OTHER',
    actorKind: kind,
    actorId: shortText(actor.id),
    actorName: shortText(actor.name),
    refType,
    refId: shortText(input.refId),
    refNo: shortText(input.refNo, 100),
    source: shortText(input.source, 20),
  };
  const amount = toDecimal(input.amount);
  // مبلغٌ لا يتّسع له العمود (إجماليٌّ معيب من تكامل) لا يُفشل الإجراء في القاعدة: يُحفظ نصّاً في التفاصيل بدل العمود
  if (amount && amount.abs().lt(AMOUNT_COLUMN_LIMIT)) row.amount = amount;
  else if (amount) data = { ...(data ?? {}), amountOutOfRange: amount.toString() };
  const at = toDate(input.at);
  if (at && at.getTime() > now + ACTIVITY_FUTURE_SKEW_MS) data = { ...(data ?? {}), claimedAt: at.toISOString() };
  else if (at) row.at = at;
  if (data) row.data = data as Prisma.InputJsonValue;
  return row;
}

/** ما يكفي من عميل Prisma (أو معاملته) للكتابة — يقبل tx داخل $transaction */
export interface ActivityWriter { customerActivity: { createMany(args: { data: any[] }): Promise<unknown> } }

/**
 * أسطر الدفعة الواحدة بلا لحظةٍ صريحة: لحظاتٌ متزايدة بدقّةٍ واحدة بترتيب الإدراج (الأساس الآن + i مللي ثانية) — فأحداث
 * المعاملة الواحدة (سداد الرابط ثم سنده) تبقى بترتيب وقوعها في القراءة (الأحدث أولاً: at تنازلياً ثم id تنازلياً) لا بترتيب
 * معرّفاتها العشوائية. السطر الوحيد يبقى بلحظة القاعدة الافتراضية، وما حمل لحظته (لحظة الجهاز) لا يُمسّ
 */
function orderBatch(rows: Record<string, unknown>[], base = Date.now()): Record<string, unknown>[] {
  if (rows.length < 2) return rows;
  let i = 0;
  return rows.map((r) => (r.at instanceof Date ? r : { ...r, at: new Date(base + i++) }));
}

/**
 * يُلحق سطراً (أو أسطراً) بسجلّ العميل. مرِّر عميل المعاملة (tx) متى كان الإجراء داخل معاملة — فيُلتزم السطر معه أو يُتراجع.
 * لا يرمي بسبب شكل المُدخل (يُنظَّف أو يُسقط السطر الناقص)؛ خطأ القاعدة وحده يصعد — فيُفشل معاملته كأي كتابةٍ فيها.
 * القائمة الفارغة لا شيء، وأسطر الدفعة بترتيب إدراجها (orderBatch).
 */
export async function recordCustomerActivity(
  db: { customerActivity: { createMany(args: { data: any[] }): Promise<unknown> } },
  input: ActivityInput | ActivityInput[],
): Promise<void> {
  let rows: Record<string, unknown>[] = [];
  try {
    const list = Array.isArray(input) ? input : [input];
    rows = orderBatch(list.map((i) => { try { return activityRow(i); } catch { return null; } }).filter((r): r is Record<string, unknown> => r !== null));
  } catch {
    rows = [];
  }
  if (rows.length === 0) return;
  await db.customerActivity.createMany({ data: rows });
}

// ═══ فرق التعديل ═══

/** حقول العميل التي يُسجَّل تغيّرها — لا الرصيد ولا العدّادات ولا الطوابع (تتغيّر بالمستندات لا بالتعديل) */
export const TRACKED_CUSTOMER_FIELDS = [
  // code: «رمز العميل» المرجعي (ref) يغيّره التعديل والاستيراد عمداً — والمعرّف المولَّد لا يتغيّر وحده فلا فرق كاذب
  'name', 'businessName', 'code', 'phone', 'altPhone', 'email', 'address', 'city', 'district', 'status', 'creditLimit', 'paymentDays',
  'paymentTermDays', 'priceListId', 'channel', 'outletType', 'taxNumber', 'commercialReg', 'crNumber',
  'buyerType', 'buyerIdScheme', 'buyerIdValue', 'addrStreet', 'addrBuildingNo', 'addrAdditionalNo', 'addrPostalCode', 'countryCode',
  'notes', 'salesRepId', 'createdBySalesRepId',
] as const;

/** لا يُسجَّل فرقها أبداً ولو مُرِّرت (حارس صريح فوق القائمة أعلاه) */
const NEVER_DIFF: ReadonlySet<string> = new Set([
  'balance', 'totalSales', 'totalCollected', 'updatedAt', 'createdAt', 'id', 'tenantId', 'clientRef', 'clientCreatedAt', 'number',
]);

function normDiffValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') { const s = v.trim(); return s === '' ? null : s; }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'object' && isDecimalLike(v as object)) return (v as { toNumber(): number }).toNumber();
  return v;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && Number.isFinite(Number(b))) return Math.abs(a - Number(b)) < 1e-9;
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number.isFinite(Number(a))) return Math.abs(b - Number(a)) < 1e-9;
  return JSON.stringify(a) === JSON.stringify(b);
}

const clipDiff = (v: unknown): unknown => (typeof v === 'string' ? clipString(v, ACTIVITY_STRING_MAX) : v);

/**
 * ما تغيّر في بطاقة العميل بين لقطتين — الحقول المتتبَّعة وحدها، والحقل الغائب من `after` لم يُمسّ (تعديلٌ جزئي).
 * الفارغ وnull سواء، والإحداثيّان حقلٌ واحد «location». الرصيد والعدّادات والطوابع لا تدخل أبداً
 */
export function customerDiff(before: Record<string, unknown>, after: Record<string, unknown>): { field: string; from: unknown; to: unknown }[] {
  const out: { field: string; from: unknown; to: unknown }[] = [];
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  for (const field of TRACKED_CUSTOMER_FIELDS) {
    if (NEVER_DIFF.has(field) || !Object.prototype.hasOwnProperty.call(a, field) || a[field] === undefined) continue;
    const from = normDiffValue(b[field]);
    const to = normDiffValue(a[field]);
    if (!sameValue(from, to)) out.push({ field, from: clipDiff(from), to: clipDiff(to) });
  }
  const touched = (k: string) => Object.prototype.hasOwnProperty.call(a, k) && a[k] !== undefined;
  if (touched('lat') || touched('lng')) {
    const num = (v: unknown) => { const n = normDiffValue(v); return typeof n === 'number' && Number.isFinite(n) ? n : n == null ? null : Number(n); };
    const point = (lat: unknown, lng: unknown) => {
      const la = num(lat); const lo = num(lng);
      return la == null || lo == null || !Number.isFinite(la) || !Number.isFinite(lo) ? null : { lat: la, lng: lo };
    };
    const from = point(b.lat, b.lng);
    const to = point(touched('lat') ? a.lat : b.lat, touched('lng') ? a.lng : b.lng);
    if (!sameValue(from, to)) out.push({ field: 'location', from, to });
  }
  return out;
}

export { allowActivityPurge } from './customerActivityGuard';
