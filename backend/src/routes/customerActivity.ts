import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdminPermission, tenantId, isOwnerSession } from '../middleware/auth';
import { AuthRequest } from '../types';
import { customerScope } from '../services/customerScope';
import { SHAPE_INVOICE_RECEIPT, SHAPE_PAYMENT_LINK, SHAPE_VISIT, adminScopeModeOf, scopedRecordWhere } from '../services/adminScope';
import { MERGE_TOLERANCE_MS, asVisitLike, mergeVisitsByRep, type MergedVisit, type VisitLike } from '../services/workDay';
import { matchableKey, orderPhoneKey, phoneTail, type CustomerCandidate } from '../services/catalogOrders';
import { CATALOG_MATCH_LIMIT, uniqueCatalogMatch } from '../services/customerActivityEvents';
import { balanceEffect, safeReceiptNote } from '../services/customerActivityDocs';
import { OPENING_BALANCE_DESCRIPTION } from '../services/importLedger';
import {
  ACTIVITY_CATEGORIES, CREATION_ACTIONS, PLATFORM_SUPPORT_NAME, actionsOfCategory, categoryOfAction, invoiceIssueAction,
  type ActivityActorKind, type ActivityCategory, type ActivityRefType,
} from '../services/customerActivity';

/**
 * «سجلّ العميل» — قراءةٌ وحدها (طلب المالك ٢٦ نوفمبر ٢٠٢٦): GET /api/customers/:id/activity
 *   ?before=<مؤشّر>&limit=<≤٣٠٠، الافتراضي ٢٠٠>&category=<all|visits|sales|returns|money|docs|edits|other>
 *   ⇒ {success, data:{items:[{id, at, action, category, actor:{kind,name}, refType, refId, refNo, amount, data, historical}], nextBefore}}
 *
 * لا مسار هنا ولا في غيره يعدّل السجلّ أو يحذف منه سطراً (والقاعدة ترفض ذلك — services/customerActivityGuard.ts)، إلا حذف العميل
 * نفسه أو الشركة كلها: السجلّ كله يُحذف معه (قرار المالك ٢٧ نوفمبر ٢٠٢٦).
 *
 * من يقرأ: كل من يفتح بطاقة العميل — المندوب ومستخدم الشركة بصلاحية «العملاء» وجلسة «دخول» المالك أو موظف المنصة — والعميل
 * بنطاق الطالب (customerScope: عزل عملاء المناديب ونطاق المستخدم المقيَّد)، وخارجه ٤٠٤ كأنه غير موجود. وداخل العميل يرى
 * القارئ عمل **الجميع** معه (أمر المالك: «لمعرفة الجميع كل سجل عمل اي احد مع هذا العميل»). وكل استعلامٍ بشركة الطالب.
 * وبصلاحيات المستندات نفسها في بقية النظام (resolveViewer):
 *   • المبالغ وتفاصيل المستند المالي: المندوب بـ«عرض كشف الحساب» (canViewStatement كمسار /customers/:id/statement)، ومستخدم
 *     الشركة بـ«الفواتير» للمبيعات والمرتجعات وبـ«سندات القبض» للتحصيل والروابط والبطاقة والتسويات — وبدونها يبقى البند (من فعل
 *     ماذا ومتى) بلا مبلغٍ ولا تفاصيل دفع. والنظام المحاسبي المطفأ ⇒ لا مبالغ لأحد (كما تخفيها الواجهة).
 *   • نطاق المستندات لمستخدم الشركة المقيَّد ومشرف الفرق (scopedRecordWhere كـ/statement و/studio): الفواتير والسندات والزيارات
 *     والروابط والبطاقة بقيده، وسطر السجلّ بمرجعٍ من هذه الأنواع لا يظهر إلا لمرجعٍ في نطاقه (فشلٌ مغلق لما حُذف).
 *   • إحداثيات زيارة مندوبٍ آخر لا تصل المندوب (بيانات تتبّع).
 *   • المالك وموظف المنصة يظهران للشركة بدورهما وحده بلا اسم — والواجهة تسمّيهما «الدعم الفني».
 *
 * التاريخ: ما سبق بدء السجلّ الثابت يُشتقّ عند القراءة من الجداول القائمة (historical: true) — الفواتير بأنواعها وحالتها والسندات
 * والتسويات والأرصدة الافتتاحية وروابط الدفع والدفع بالبطاقة والوثائق والمكالمات وطلبات المنيو وخطوط السير والإسناد والأسعار
 * الخاصة وإنشاء العميل. والمرجع الذي له «سطر ميلاد» في السجلّ (CREATION_ACTIONS) لا يُشتقّ ثانيةً فلا يظهر شيءٌ مرّتين؛ ومرجعٌ قديم
 * سُجّل له بعد ذلك إلغاءٌ وحده يبقى إصداره المشتقّ.
 *
 * الزيارات وقفاتٍ لا سجلّات — حيّها ومشتقّها معاً بدمج كل شاشة (services/workDay.ts mergeVisitsByRep): المؤقّت وملاحظته وصورها
 * بندٌ واحد مرجعه المؤقّت، ومعه visitIds/parts/photosCount. وموضع الوقفة أحدث سجلّاتها، وتُعرض في الصفحة التي يقع فيها موضعها
 * وحدها: تُقرأ حولها سجلّات الهامش (VISIT_CONTEXT_MS) فلا تقطعها حدود الصفحة ولا الأفق، فلا تتكرّر ولا يضيع منها سجلّ.
 *
 * الترقيم: ترتيبٌ كلّيٌّ ثابت (اللحظة الأحدث، ثم رتبة المصدر، ثم ترتيب القاعدة داخله: at ثم id تنازلياً) ومؤشّرٌ مركّب
 * «لحظة~رتبة~معرّف» — فلا يسقط بندٌ يشارك غيره اللحظة نفسها. وأسطر الدفعة الواحدة بلحظاتٍ متزايدة بترتيب إدراجها
 * (recordCustomerActivity)، فأحداث المعاملة الواحدة بترتيب وقوعها. وكل مصدرٍ يُقرأ limit+1 بعد المؤشّر، وما بعد «أفق» أقصر
 * المصادر المقطوعة لا يُعرض حتى تُقرأ الجولة التالية — فلا يتقدّم بندٌ أقدم على بندٍ لم يُقرأ بعد.
 */
const router = Router();

export const ACTIVITY_DEFAULT_LIMIT = 200;
export const ACTIVITY_MAX_LIMIT = 300;
/** جولات القراءة في الطلب الواحد حين تُسقط المطابقةُ بالسجلّ أكثر الصفوف المشتقّة — ثم يُعاد المؤشّر للصفحة التالية */
export const ACTIVITY_MAX_ROUNDS = 4;
/**
 * محلّية الدمج: سجلّ الزيارة يُدمج بلحظته (بداية المؤقّت أو طابعه) ما دام موضعه في الترتيب (طابع التسجيل) قريباً منها — المؤقّت
 * موضعه داخل نافذته ± هذا الهامش، والملاحظة ± هذا الهامش من لحظتها. وما شذّ عنه (طوابع فاسدة يدوية) يُدمج بموضعه كملاحظةٍ بلا
 * توقيت. فلا تتباعد سجلّات الوقفة الواحدة في الترتيب أكثر من VISIT_SPAN_MS أبداً
 */
const VISIT_LOCAL_SKEW_MS = 2 * 60 * 60 * 1000;
/** أقصى مدّة مؤقّتٍ في الدمج (سقف المدّة في المسار: services/visitDuration.ts MAX_VISIT_SECONDS) */
const VISIT_MAX_MERGE_SEC = 4 * 60 * 60;
/** أقصى بُعدٍ في الترتيب بين ملاحظةٍ ومؤقّتها: المدّة + هامش الدمج + هامشا المحلّية */
const VISIT_SPAN_MS = VISIT_MAX_MERGE_SEC * 1000 + MERGE_TOLERANCE_MS + 2 * VISIT_LOCAL_SKEW_MS;
/**
 * هامش سجلّات الوقفة حول مدى الصفحة: عضوية سجلٍّ في وقفته تتعلّق بمؤقّتٍ في حدود VISIT_SPAN_MS منه، وبقيّة أعضاء ذلك المؤقّت في
 * حدود ضعفها — فثلاثة أضعافها تكفي ليُبنى كل سجلٍّ في المدى بوقفته كاملةً كما تبنيها كل صفحةٍ أخرى (لا تكرار ولا ضياع)
 */
export const VISIT_CONTEXT_MS = 3 * VISIT_SPAN_MS;
/** سقف سجلّات الهامش في الجولة (لكل جدول) */
const VISIT_CONTEXT_CAP = 1000;
/** مدّة حفظ «بدء سجلّ الشركة» في الذاكرة — لا يتغيّر إلا بسطرٍ مؤرَّخ قبله */
const LOG_START_TTL_MS = 60 * 60 * 1000;

type AnyRow = Record<string, any>;
type Where = Record<string, unknown>;
type Delegate = { findMany(args: unknown): Promise<AnyRow[]>; findFirst?(args: unknown): Promise<AnyRow | null> };
/** ما تقرؤه الصفحة من القاعدة — PrismaClient في الإنتاج، وقاعدةٌ في الذاكرة في الاختبار */
export interface ActivityDb {
  customer: Delegate & { findFirst(args: unknown): Promise<AnyRow | null> };
  customerActivity: Delegate;
  invoice: Delegate; receipt: Delegate; repVisit: Delegate; customerDocument: Delegate; customerPaymentLink: Delegate;
  cardPayment: Delegate; accountEntry: Delegate; customerAdjustment: Delegate; callLog: Delegate; catalogOrder: Delegate;
  repRouteStop: Delegate; customerAssignment: Delegate; customerPrice: Delegate; admin: Delegate; salesRep: Delegate; apiKey: Delegate;
}

/**
 * نطاق المستندات لمستخدم الشركة المقيَّد (قيود Prisma من scopedRecordWhere لكل نوع) — null بلا قيد.
 * ledger: قيود العميل بلا مستند (التسويات والأرصدة الافتتاحية والقيود اليدوية) — مشرف الفرق لا يراها، ككشف الحساب
 */
export interface RecordScope { invoice: Where; receipt: Where; visit: Where; paylink: Where; card: Where; ledger: boolean }

export interface ActivityDeps {
  db: ActivityDb;
  customerScope(req: AuthRequest, tid: string): Promise<Record<string, unknown>>;
  /** نطاق المستندات (انظر RecordScope) — غيابه بلا قيد */
  recordScope?(req: AuthRequest, tid: string): Promise<RecordScope | null>;
  /** عملاء الشركة غير المحذوفين بذيل جوال المفتاح (مرشّحو نسبة طلب المنيو) — غيابه يقرؤهم بـdb (الاختبار) */
  phoneCandidates?(tid: string, key: string): Promise<CustomerCandidate[]>;
}

// ═══ المؤشّر والترتيب ═══

/** موضعٌ في الترتيب الكلّي: الأحدث أولاً، ثم الرتبة الأعلى، ثم ترتيب القاعدة داخل المصدر (seq) — id لاستئناف القاعدة */
export interface ActivityCursor { at: Date; rank: number; id: string }
interface Pos extends ActivityCursor { seq: number }

/** المؤشّر المركّب «ISO~رتبة~معرّف»، أو لحظةٌ وحدها (ما قبلها تماماً) — وما سواهما يُهمل (من الأحدث) */
export function decodeActivityCursor(raw: unknown): ActivityCursor | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  const m = /^([^~]+)~(-?\d+)~(.*)$/.exec(s);
  if (m) {
    const at = new Date(m[1]);
    if (!Number.isNaN(at.getTime()) && m[3]) return { at, rank: Number(m[2]), id: m[3] };
  }
  const at = new Date(s);
  return Number.isNaN(at.getTime()) ? null : { at, rank: Number.NEGATIVE_INFINITY, id: '' };
}

export function encodeActivityCursor(c: ActivityCursor): string {
  return `${c.at.toISOString()}~${c.rank}~${c.id}`;
}

/** سالبٌ إن سبق a بـb في العرض (أحدث) — seq يُقارَن داخل المصدر الواحد في الجولة نفسها */
function cmpPos(a: Pos, b: Pos): number {
  const d = b.at.getTime() - a.at.getTime();
  if (d !== 0) return d;
  if (a.rank !== b.rank) return b.rank - a.rank;
  return a.seq - b.seq;
}

/** ترتيب القاعدة نفسه بلا seq (at ثم الرتبة ثم id تنازلياً) — لسجلّات الزيارة من قراءتين مختلفتين */
function cmpKey(a: ActivityCursor, b: ActivityCursor): number {
  const d = b.at.getTime() - a.at.getTime();
  if (d !== 0) return d;
  if (a.rank !== b.rank) return b.rank - a.rank;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** قيد اللحظة لمصدرٍ برتبته بعد المؤشّر — بترتيب القاعدة (field desc, id desc) */
export function timeWhere(field: string, c: ActivityCursor | null, rank: number): Record<string, unknown> {
  if (!c) return {};
  if (rank > c.rank) return { [field]: { lt: c.at } };
  if (rank < c.rank) return { [field]: { lte: c.at } };
  return { OR: [{ [field]: { lt: c.at } }, { [field]: c.at, id: { lt: c.id } }] };
}

/** هل الموضع بعد المؤشّر (لم يُعرض بعد)؟ — للمصدر المحسوب في الذاكرة (إنشاء العميل) والوقفات */
function afterCursor(p: { at: Date; rank: number; id: string }, c: ActivityCursor | null): boolean {
  if (!c) return true;
  const d = c.at.getTime() - p.at.getTime();
  if (d !== 0) return d > 0;
  if (p.rank !== c.rank) return p.rank < c.rank;
  return p.id < c.id;
}

// ═══ البنود ═══

interface ActorRef { kind: ActivityActorKind; id: string | null; name: string | null; lookup?: 'admin' | 'rep' }
export interface ActivityOut {
  id: string; at: string; action: string; category: ActivityCategory;
  /** id للمندوب والإداري وحدهما (toOut) */
  actor: { kind: string; name: string | null; id?: string | null };
  refType: string | null; refId: string | null; refNo: string | null; amount: number | null;
  data: Record<string, unknown> | null; historical: boolean;
}
interface Cand {
  pos: Pos;
  hist: boolean;
  action: string;
  actor: ActorRef;
  refType: ActivityRefType | null;
  refId: string | null;
  refNo: string | null;
  amount: number | null;
  data: Record<string, unknown> | null;
  outId: string;
  /** مندوب الوقفة — لحجب إحداثياتها عن مندوبٍ آخر */
  visitRepId?: string | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'object' && v && typeof (v as { toNumber?: unknown }).toNumber === 'function' ? (v as { toNumber(): number }).toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
};
const clip = (s: unknown, max = 500): string | null => {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? (t.length > max ? `${t.slice(0, max)}…` : t) : null;
};
const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));
const optDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = asDate(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
/** حقول التفاصيل بلا الفارغ */
const compact = (o: Record<string, unknown>): Record<string, unknown> | null => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return Object.keys(out).length ? out : null;
};
/** قيدٌ إضافيّ يُضمّ في AND — الفارغ لا شيء (فلا يتصادم مع AND المصدر نفسه) */
const andOf = (...ws: (Where | null | undefined)[]): Where[] => ws.filter((w): w is Where => !!w && Object.keys(w).length > 0);

/** من فعلها في صفٍّ قديم: المندوب بمعرّفه واسمه، وإلا مستخدم الشركة (createdBy قد يكون OWNER:<معرّف> لجلسة المالك) */
function repOrAdmin(repId: unknown, repName: unknown, adminRef?: unknown): ActorRef {
  if (typeof repId === 'string' && repId) return { kind: 'REP', id: repId, name: clip(repName, 200), lookup: repName ? undefined : 'rep' };
  if (typeof adminRef === 'string' && adminRef) {
    if (adminRef.startsWith('OWNER:')) return { kind: 'OWNER', id: adminRef.slice(6) || null, name: null };
    return { kind: 'ADMIN', id: adminRef, name: null, lookup: 'admin' };
  }
  return { kind: 'ADMIN', id: null, name: null };
}

// ═══ القارئ وصلاحياته ═══

/** من يقرأ وما يحقّ له (انظر رأس الملف) */
interface Viewer {
  platform: boolean;
  /** المندوب القارئ — null لغيره */
  repId: string | null;
  /** مبالغ المبيعات والمرتجعات وتفاصيلها */
  salesMoney: boolean;
  /** مبالغ التحصيل (السندات والروابط والبطاقة والتسويات والقيود) وتفاصيلها */
  receiptMoney: boolean;
  /** النظام المحاسبي مفعّل — وإلا لا مبالغ لأحد */
  amounts: boolean;
  scope: RecordScope | null;
}

async function resolveViewer(deps: ActivityDeps, req: AuthRequest, tid: string, customer: AnyRow): Promise<Viewer> {
  // tenant من صفّ العميل نفسه (علاقةٌ في الاستعلام ذاته) — والقراءة المتعذّرة لا تُطفئ شيئاً (كحرّاس النظام: === false صراحةً)
  const amounts = customer.tenant?.accountingEnabled !== false;
  if (isOwnerSession(req)) return { platform: true, repId: null, salesMoney: true, receiptMoney: true, amounts, scope: null };
  const user = req.user;
  if (user?.role === 'SALES_REP') {
    // كمسار كشف الحساب: المندوب بلا «عرض كشف الحساب» لا يرى مالَ العميل (ولا صفّ له ⇒ لا يرى)
    const rep = await deps.db.salesRep.findFirst?.({ where: { id: user.id, tenantId: tid }, select: { canViewStatement: true } });
    const ok = rep?.canViewStatement === true;
    return { platform: false, repId: user.id, salesMoney: ok, receiptMoney: ok, amounts, scope: null };
  }
  // مستخدم الشركة: صفّه محقَّقٌ نشطاً قبل المسار (requireAdminPermission) — والصلاحية تُمنع بـfalse صراحةً كبقية النظام
  const [admin, scope] = await Promise.all([
    user?.id ? deps.db.admin.findFirst?.({ where: { id: user.id, tenantId: tid }, select: { canManageInvoices: true, canManageReceipts: true } }) : null,
    deps.recordScope ? deps.recordScope(req, tid) : Promise.resolve(null),
  ]);
  return {
    platform: false, repId: null, amounts, scope: scope ?? null,
    salesMoney: admin?.canManageInvoices !== false, receiptMoney: admin?.canManageReceipts !== false,
  };
}

/** نطاق المستندات في الإنتاج — scopedRecordWhere لكل نوعٍ كـ/statement و/studio، وغير المقيَّد والمندوب وجلسة المالك بلا قيد */
async function productionRecordScope(req: AuthRequest): Promise<RecordScope | null> {
  if (!req.user || req.user.role === 'SALES_REP' || isOwnerSession(req)) return null;
  const mode = await adminScopeModeOf(req);
  if (mode === null) return null;
  const [invoice, visit, paylink] = await Promise.all([
    scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT), scopedRecordWhere(req, SHAPE_VISIT), scopedRecordWhere(req, SHAPE_PAYMENT_LINK),
  ]);
  return { invoice, receipt: invoice, visit, paylink, card: Object.keys(invoice).length ? { invoice } : {}, ledger: mode !== 'TEAMS' };
}

// ═══ المصادر ═══

interface Ctx {
  db: ActivityDb;
  tid: string;
  customer: AnyRow;
  category: ActivityCategory | 'all';
  viewer: Viewer;
  phoneCandidates(key: string): Promise<CustomerCandidate[]>;
  /**
   * بدء السجلّ الثابت في **الشركة** (أقدم سطرٍ لها — tenantLogStart؛ null = لا سطر بعد). صفوفٌ تُعاد كتابتها بلا إجراءٍ على
   * العميل — محطّات خطّ السير تُحذف وتُنشأ بكل حفظٍ للخطّ، وسعر العميل الخاص يتجدّد طابعه بكل حفظٍ لقائمته — لا تُشتقّ بعده:
   * ما وقع بعده سُجّل حدثاً (دخولٌ للخطّ أو خروج، سعرٌ تغيّر)، وما بقي على حاله ليس إجراءً. وبدء الشركة لا بدء العميل: عميلٌ بلا
   * سطرٍ بعد أُعيد حفظ خطّه اليوم لم «يُضف» اليوم
   */
  logStart: Date | null;
}

/** قيد «قبل بدء السجلّ» لمصدرٍ تُعاد كتابة صفوفه (انظر Ctx.logStart) */
const beforeLog = (field: string, ctx: Ctx): Record<string, unknown> => (ctx.logStart ? { [field]: { lt: ctx.logStart } } : {});
interface RefKey { refType: ActivityRefType; refId: string }
/** مصدرٌ مشتقّ: يقرأ صفوفه بعد المؤشّر بترتيب القاعدة، ومراجعَها للمطابقة بالسجلّ، ثم يبني بنوده */
interface HistSource {
  key: string;
  rank: number;
  categories: readonly ActivityCategory[];
  dateField: string;
  fetch(ctx: Ctx, c: ActivityCursor | null, take: number): Promise<AnyRow[]>;
  refs(row: AnyRow): RefKey[];
  /** rows: صفوف الجولة الآمنة (حتى الأفق) بمواضعها؛ excluded(refType, refId, action, primary) */
  build(rows: { row: AnyRow; pos: Pos }[], excluded: Excluder, ctx: Ctx): Cand[];
}
type Excluder = (refType: ActivityRefType, refId: string, action: string, primary: boolean) => boolean;

const ord = (field: string) => [{ [field]: 'desc' }, { id: 'desc' }];

function cand(src: HistSource, pos: Pos, c: Omit<Cand, 'pos' | 'hist' | 'outId'>): Cand {
  return { ...c, pos, hist: true, outId: `h:${src.key}:${pos.id}` };
}

/** أبسط مصدر: صفٌّ ⇒ بندٌ واحد، يُسقط إن كان لمرجعه سطر في السجلّ */
function simpleBuild(src: HistSource, one: (row: AnyRow, ctx: Ctx, pos: Pos) => Omit<Cand, 'pos' | 'hist' | 'outId'> & { primary?: boolean } | null) {
  return (rows: { row: AnyRow; pos: Pos }[], excluded: Excluder, ctx: Ctx): Cand[] => {
    const out: Cand[] = [];
    for (const { row, pos } of rows) {
      const c = one(row, ctx, pos);
      if (!c) continue;
      if (c.refType && c.refId && excluded(c.refType, c.refId, c.action, c.primary !== false)) continue;
      const { primary: _p, ...rest } = c;
      out.push(cand(src, pos, rest));
    }
    return out;
  };
}

const RETURN_WHERE = { OR: [{ type: 'RETURN' }, { documentKind: 'CREDIT_NOTE' }] };
const SALES_WHERE = { type: { not: 'RETURN' }, OR: [{ documentKind: null }, { documentKind: { not: 'CREDIT_NOTE' } }] };

const invoices: HistSource = {
  key: 'invoice', rank: 60, categories: ['sales', 'returns'], dateField: 'invoiceDate',
  fetch: (ctx, c, take) => ctx.db.invoice.findMany({
    where: {
      tenantId: ctx.tid, customerId: ctx.customer.id,
      AND: [
        timeWhere('invoiceDate', c, 60), ctx.category === 'returns' ? RETURN_WHERE : ctx.category === 'sales' ? SALES_WHERE : {},
        ...andOf(ctx.viewer.scope?.invoice),
      ],
    },
    orderBy: ord('invoiceDate'), take,
    select: {
      id: true, number: true, type: true, status: true, documentKind: true, invoiceDate: true, total: true, taxAmt: true, paidAmt: true,
      remainingAmt: true, returnReason: true, returnToStock: true, noteReason: true, paymentPlan: true, salesRepId: true,
      salesRep: { select: { name: true } }, originalInvoice: { select: { number: true } }, _count: { select: { items: true } },
    },
  }),
  refs: (r) => [{ refType: 'INVOICE', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(invoices, (r) => {
    const isReturn = r.type === 'RETURN';
    return {
      action: invoiceIssueAction({ type: r.type, documentKind: r.documentKind }), actor: repOrAdmin(r.salesRepId, r.salesRep?.name), refType: 'INVOICE', refId: r.id,
      refNo: r.number ?? null, amount: num(r.total),
      // بأسماء الحقول نفسها التي يكتبها السجلّ الحيّ (services/customerActivityDocs.ts invoiceActivityData): paymentType لنوع البيع،
      // وسبب المرتجع رمزاً في returnReason وعودته للمخزون، وسبب الإشعار نصّاً في reason
      data: compact({
        paymentType: !isReturn && r.documentKind !== 'CREDIT_NOTE' && r.documentKind !== 'DEBIT_NOTE' ? r.type : undefined,
        documentKind: r.documentKind && r.documentKind !== 'INVOICE' ? r.documentKind : undefined,
        status: r.status, cancelled: r.status === 'CANCELLED' ? true : undefined, itemsCount: r._count?.items,
        total: num(r.total), taxTotal: num(r.taxAmt) || undefined, paidAmt: num(r.paidAmt), remainingAmt: num(r.remainingAmt),
        originalInvoiceNo: r.originalInvoice?.number, paymentPlan: r.paymentPlan,
        returnReason: isReturn ? clip(r.returnReason, 300) : undefined,
        returnToStock: isReturn && typeof r.returnToStock === 'boolean' ? r.returnToStock : undefined,
        reason: clip(r.noteReason, 300),
      }),
    };
  })(rows, ex, ctx),
};

const receipts: HistSource = {
  key: 'receipt', rank: 55, categories: ['money'], dateField: 'receiptDate',
  fetch: (ctx, c, take) => ctx.db.receipt.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, AND: [timeWhere('receiptDate', c, 55), ...andOf(ctx.viewer.scope?.receipt)] },
    orderBy: ord('receiptDate'), take,
    select: {
      id: true, number: true, amount: true, paymentMethod: true, status: true, receiptDate: true, notes: true, clientRef: true,
      salesRepId: true, deletedSalesRepId: true, salesRep: { select: { name: true } }, _count: { select: { photos: true } },
      invoiceItems: { select: { amount: true, invoice: { select: { number: true } } }, take: 20 },
    },
  }),
  refs: (r) => [{ refType: 'RECEIPT', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(receipts, (r) => ({
    action: 'RECEIPT_ISSUED', actor: repOrAdmin(r.salesRepId ?? r.deletedSalesRepId, r.salesRep?.name), refType: 'RECEIPT', refId: r.id,
    refNo: r.number ?? null, amount: num(r.amount),
    data: compact({
      paymentMethod: r.paymentMethod, status: r.status, cancelled: r.status === 'CANCELLED' ? true : undefined,
      // ملاحظة سند البطاقة أو الدفع الإلكتروني يكتبها النظام بالبطاقة المقنّعة ورقم المرجع — لا تُعرض (safeReceiptNote)
      note: clip(safeReceiptNote(r.notes, { paymentMethod: r.paymentMethod, clientRef: r.clientRef })),
      photosCount: r._count?.photos || undefined,
      // توزيع السند على الفواتير بشكل السجلّ الحيّ (receiptEventInput: allocations[].invoiceNo/amount)
      allocations: Array.isArray(r.invoiceItems) && r.invoiceItems.length
        ? r.invoiceItems.map((x: AnyRow) => ({ invoiceNo: x.invoice?.number ?? null, amount: num(x.amount) })) : undefined,
    }),
  }))(rows, ex, ctx),
};

const VISIT_SELECT = {
  id: true, createdAt: true, note: true, durationSec: true, startedAt: true, endedAt: true, lat: true, lng: true, customerId: true,
  salesRepId: true, salesRep: { select: { name: true } }, photos: { select: { id: true }, orderBy: { createdAt: 'asc' } },
};

/**
 * الزيارات المشتقّة — صفوفها تُقرأ هنا للترتيب والأفق وحدهما؛ وبنودها تُبنى مع أسطر VISIT_RECORDED الحيّة وقفاتٍ (buildVisitStops)
 */
const visits: HistSource = {
  key: 'visit', rank: 50, categories: ['visits'], dateField: 'createdAt',
  fetch: (ctx, c, take) => ctx.db.repVisit.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, AND: [timeWhere('createdAt', c, 50), ...andOf(ctx.viewer.scope?.visit)] },
    orderBy: ord('createdAt'), take, select: VISIT_SELECT,
  }),
  refs: (r) => [{ refType: 'VISIT', refId: r.id }],
  build: () => [],
};

const documents: HistSource = {
  key: 'doc', rank: 45, categories: ['docs'], dateField: 'createdAt',
  fetch: (ctx, c, take) => ctx.db.customerDocument.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, ...timeWhere('createdAt', c, 45) },
    orderBy: ord('createdAt'), take,
    select: { id: true, kind: true, sizeBytes: true, uploadedByKind: true, uploadedById: true, uploadedByName: true, createdAt: true },
  }),
  refs: (r) => [{ refType: 'DOCUMENT', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(documents, (r) => {
    // رفعته جلسة المالك أو موظفه (uploadedById = OWNER:<معرّف> كـactorOf) ⇒ فاعلٌ من المنصّة لا «إداريّ» الشركة — كالسطر الحيّ
    const byOwner = typeof r.uploadedById === 'string' && r.uploadedById.startsWith('OWNER:');
    const kind: ActivityActorKind = byOwner ? 'OWNER' : r.uploadedByKind === 'REP' ? 'REP' : r.uploadedByKind === 'API' ? 'API' : 'ADMIN';
    const actor: ActorRef = byOwner
      ? { kind, id: (r.uploadedById as string).slice(6) || null, name: null }
      : { kind, id: r.uploadedById ?? null, name: clip(r.uploadedByName, 200) };
    return { action: 'DOCUMENT_ADDED', actor, refType: 'DOCUMENT', refId: r.id, refNo: null, amount: null, data: compact({ kind: r.kind, sizeBytes: r.sizeBytes }) };
  })(rows, ex, ctx),
};

const PAYLINK_SELECT = {
  id: true, amount: true, status: true, createdAt: true, paidAt: true, expiresAt: true, salesRepId: true, createdById: true,
  salesRep: { select: { name: true } }, invoice: { select: { number: true } },
};
const isCanceled = (s: unknown) => s === 'canceled' || s === 'cancelled';

const paylinks: HistSource = {
  key: 'paylink', rank: 40, categories: ['money'], dateField: 'createdAt',
  fetch: (ctx, c, take) => ctx.db.customerPaymentLink.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, AND: [timeWhere('createdAt', c, 40), ...andOf(ctx.viewer.scope?.paylink)] },
    orderBy: ord('createdAt'), take, select: PAYLINK_SELECT,
  }),
  refs: (r) => [{ refType: 'PAYLINK', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(paylinks, (r, cx, pos) => {
    // رابطٌ أُنشئ بعد بدء السجلّ وأُلغي بلا سطر: توأم السباق أو يتيمٌ بلا رابطٍ لدى المزوّد (services/paylink.ts) — لم يصل أحداً
    // فليس إجراءً على العميل، ولا «تاريخاً» قبل السجلّ. والرابط الحقيقيّ بعده له سطر إنشائه فيُسقط هنا على أيّ حال
    if (cx.logStart && pos.at.getTime() >= cx.logStart.getTime() && isCanceled(r.status)) return null;
    return {
      action: 'PAYLINK_CREATED', actor: repOrAdmin(r.salesRepId, r.salesRep?.name, r.createdById), refType: 'PAYLINK', refId: r.id,
      refNo: r.invoice?.number ?? null, amount: num(r.amount),
      data: compact({ status: r.status, invoiceNo: r.invoice?.number, expiresAt: r.expiresAt ? asDate(r.expiresAt).toISOString() : undefined }),
    };
  })(rows, ex, ctx),
};

/** سداد رابط الدفع حدثٌ ثانٍ بلحظته (paidAt) — من العميل نفسه */
const paylinksPaid: HistSource = {
  key: 'paylinkPaid', rank: 38, categories: ['money'], dateField: 'paidAt',
  fetch: (ctx, c, take) => ctx.db.customerPaymentLink.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, AND: [{ paidAt: { not: null } }, timeWhere('paidAt', c, 38), ...andOf(ctx.viewer.scope?.paylink)] },
    orderBy: ord('paidAt'), take, select: PAYLINK_SELECT,
  }),
  refs: (r) => [{ refType: 'PAYLINK', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(paylinksPaid, (r, cx) => ({
    primary: false,
    action: 'PAYLINK_PAID', actor: { kind: 'CUSTOMER', id: null, name: clip(cx.customer.name, 200) }, refType: 'PAYLINK', refId: r.id,
    refNo: r.invoice?.number ?? null, amount: num(r.amount), data: compact({ invoiceNo: r.invoice?.number }),
  }))(rows, ex, ctx),
};

/**
 * عملية البطاقة بحالتها اليوم — بإجراءات الكاتب نفسها (services/cardPayment.ts): الموافقة = تحصيلٌ وقع (COMPLETED)، والمعكوسة
 * بعد الموافقة تحصيلٌ وقع ثم عُكس (COMPLETED بحالتها reversed — وسطر العكس الحيّ REVERSED إن وقع بعد بدء السجلّ لا يُسقطه)،
 * والموقوفة للمراجعة (خُصم واختلف) HELD، والرفض والفشل والانتهاء FAILED. المعلّقة لا تُعرض. والتحصيل وحده «ميلاد» يُسقطه سطره؛
 * وما سواه لا يُسقطه إلا سطرٌ بالإجراء نفسه
 */
const CARD_COLLECTED = new Set(['approved', 'reversed']);
const cardAction = (status: unknown): 'CARD_PAYMENT_COMPLETED' | 'CARD_PAYMENT_HELD' | 'CARD_PAYMENT_FAILED' =>
  (CARD_COLLECTED.has(String(status)) ? 'CARD_PAYMENT_COMPLETED' : status === 'review' ? 'CARD_PAYMENT_HELD' : 'CARD_PAYMENT_FAILED');
const cardPayments: HistSource = {
  key: 'card', rank: 35, categories: ['money'], dateField: 'createdAt',
  fetch: (ctx, c, take) => ctx.db.cardPayment.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, AND: [{ status: { not: 'pending' } }, timeWhere('createdAt', c, 35), ...andOf(ctx.viewer.scope?.card)] },
    orderBy: ord('createdAt'), take,
    select: {
      id: true, amount: true, status: true, statusDetail: true, createdAt: true, approvedAt: true, salesRepId: true, createdById: true,
      cardScheme: true, salesRep: { select: { name: true } }, invoice: { select: { number: true } },
    },
  }),
  refs: (r) => [{ refType: 'CARD_PAYMENT', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(cardPayments, (r) => {
    const action = cardAction(r.status);
    return {
      primary: action === 'CARD_PAYMENT_COMPLETED',
      action, actor: repOrAdmin(r.salesRepId, r.salesRep?.name, r.createdById), refType: 'CARD_PAYMENT', refId: r.id,
      refNo: r.invoice?.number ?? null, amount: num(r.amount),
      data: compact({ status: r.status, reason: clip(r.statusDetail, 200), cardScheme: r.cardScheme, invoiceNo: r.invoice?.number }),
    };
  })(rows, ex, ctx),
};

/**
 * التسويات: كل قيد ADJUSTMENT_* بلا فاتورة ولا سند — «رصيد افتتاحي» مستورد، أو تسوية العميل (CustomerAdjustment: معرّفها معرّف
 * قيدها) وقيد عكسها عند الإلغاء (ADJUSTMENT_UPDATED بحالة الإلغاء)، أو قيدٌ مستوردٌ آخر. ومشرف الفرق لا يراها (كشف حسابه بلا قيدٍ بلا مستند)
 */
const ADJ_TYPES = ['ADJUSTMENT_DEBIT', 'ADJUSTMENT_CREDIT'];
const adjustments: HistSource = {
  key: 'adj', rank: 30, categories: ['money'], dateField: 'createdAt',
  fetch: async (ctx, c, take) => {
    if (ctx.viewer.scope && !ctx.viewer.scope.ledger) return [];
    const rows = await ctx.db.accountEntry.findMany({
      where: { tenantId: ctx.tid, customerId: ctx.customer.id, type: { in: ADJ_TYPES }, invoiceId: null, receiptId: null, ...timeWhere('createdAt', c, 30) },
      orderBy: ord('createdAt'), take,
      select: { id: true, type: true, debit: true, credit: true, description: true, entryDate: true, createdAt: true },
    });
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const adjs = await ctx.db.customerAdjustment.findMany({
      where: { tenantId: ctx.tid, customerId: ctx.customer.id, OR: [{ id: { in: ids } }, { reverseEntryId: { in: ids } }] },
      select: { id: true, kind: true, status: true, note: true, reference: true, method: true, createdBy: true, cancelledBy: true, cancelReason: true, reverseEntryId: true },
    });
    const byId = new Map(adjs.map((a) => [a.id as string, a]));
    const byReverse = new Map(adjs.filter((a) => a.reverseEntryId).map((a) => [a.reverseEntryId as string, a]));
    return rows.map((r) => ({ ...r, adj: byId.get(r.id) ?? null, reversed: byReverse.get(r.id) ?? null }));
  },
  refs: (r) => [{ refType: 'ADJUSTMENT', refId: (r.reversed?.id as string) ?? r.id }],
  build: (rows, ex, ctx) => simpleBuild(adjustments, (r) => {
    // عُرف المبلغ (رأس services/customerActivity.ts): أثر القيد الموقَّع على رصيد العميل (مدين − دائن) كما يكتبه السجلّ الحيّ —
    // للتسوية والرصيد الافتتاحي والقيد المستورد، ولقيد عكس الإلغاء (مدينه − دائنه = سالب أثر الأصل)
    const amount = balanceEffect(r.debit, r.credit);
    const side = num(r.debit) ? 'DEBIT' : 'CREDIT';
    const entryDate = r.entryDate ? asDate(r.entryDate).toISOString() : undefined;
    if (r.reversed) {
      return {
        primary: false, action: 'ADJUSTMENT_UPDATED', actor: repOrAdmin(null, null, r.reversed.cancelledBy), refType: 'ADJUSTMENT',
        refId: r.reversed.id, refNo: clip(r.reversed.reference, 100), amount,
        data: compact({ kind: r.reversed.kind, status: 'CANCELLED', cancelled: true, reason: clip(r.reversed.cancelReason), side }),
      };
    }
    if (r.adj) {
      return {
        action: 'ADJUSTMENT_CREATED', actor: repOrAdmin(null, null, r.adj.createdBy), refType: 'ADJUSTMENT', refId: r.id,
        refNo: clip(r.adj.reference, 100), amount,
        data: compact({
          kind: r.adj.kind, status: r.adj.status, cancelled: r.adj.status === 'CANCELLED' ? true : undefined, note: clip(r.adj.note),
          method: r.adj.method, side, entryDate,
        }),
      };
    }
    const opening = r.description === OPENING_BALANCE_DESCRIPTION;
    return {
      action: opening ? 'OPENING_BALANCE_SET' : 'ADJUSTMENT_CREATED', actor: { kind: 'ADMIN', id: null, name: null },
      refType: 'ADJUSTMENT', refId: r.id, refNo: null, amount,
      data: compact({ side, entryDate, description: opening ? undefined : clip(r.description, 200), source: 'import' }),
    };
  })(rows, ex, ctx),
};

const calls: HistSource = {
  key: 'call', rank: 25, categories: ['visits'], dateField: 'startedAt',
  fetch: (ctx, c, take) => ctx.db.callLog.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, ...timeWhere('startedAt', c, 25) },
    orderBy: ord('startedAt'), take,
    // لا التسجيل ولا النصّ الكامل: رابط التسجيل عند المزوّد، والملخّص يكفي السجلّ
    select: { id: true, direction: true, durationSec: true, startedAt: true, salesRepId: true, aiSummary: true },
  }),
  refs: (r) => [{ refType: 'CALL', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(calls, (r) => ({
    action: 'CALL_LOGGED', actor: r.salesRepId ? { kind: 'REP', id: r.salesRepId, name: null, lookup: 'rep' } : { kind: 'SYSTEM', id: null, name: null },
    refType: 'CALL', refId: r.id, refNo: null, amount: null,
    data: compact({ direction: r.direction, durationSec: r.durationSec || undefined, note: clip(r.aiSummary) }),
  }))(rows, ex, ctx),
};

/**
 * عملاء طلبات المنيو بقاعدة النسبة الواحدة (الكاتب services/customerActivityEvents.ts): أوّل سطرٍ للطلب في السجلّ — على أيّ عميل —
 * نهائيّ، وإلا العميل **الوحيد** المطابق بجواله (uniqueCatalogMatch) من عملاء الشركة غير المحذوفين اليوم (حالة لحظة الطلب لا تُعرف
 * للقديم — والعميل المعروض نفسه مرشّحٌ ولو حُذف). فلا يظهر طلبٌ على عميلين أبداً. يعيد معرّفات الطلبات المنسوبة لهذا العميل
 */
async function catalogOrdersOfCustomer(ctx: Ctx, key: string, rows: AnyRow[]): Promise<Set<string>> {
  const mine = new Set<string>();
  const ids = rows.map((r) => r.id as string);
  const logged = await ctx.db.customerActivity.findMany({
    where: { tenantId: ctx.tid, refType: 'CATALOG_ORDER', refId: { in: ids } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }], select: { refId: true, customerId: true },
  });
  const owner = new Map<string, string>();
  for (const l of logged) if (l.refId && !owner.has(l.refId)) owner.set(l.refId, l.customerId);
  const rest = ids.filter((id) => !owner.has(id));
  for (const [id, cid] of owner) if (cid === ctx.customer.id) mine.add(id);
  if (!rest.length) return mine;
  const candidates = [...await ctx.phoneCandidates(key)];
  if (candidates.length >= CATALOG_MATCH_LIMIT) return mine; // التفرّد غير مضمون ⇒ لا نسبة
  if (!candidates.some((c) => c.id === ctx.customer.id)) {
    candidates.push({ id: ctx.customer.id, name: ctx.customer.name, phone: ctx.customer.phone, createdAt: ctx.customer.createdAt });
  }
  if (uniqueCatalogMatch(key, candidates) === ctx.customer.id) for (const id of rest) mine.add(id);
  return mine;
}

const catalogOrders: HistSource = {
  key: 'order', rank: 20, categories: ['sales'], dateField: 'createdAt',
  fetch: async (ctx, c, take) => {
    const key = orderPhoneKey(ctx.customer.phone);
    if (!matchableKey(key)) return [];
    const rows = await ctx.db.catalogOrder.findMany({
      where: { tenantId: ctx.tid, phoneKey: key, ...timeWhere('createdAt', c, 20) },
      orderBy: ord('createdAt'), take,
      select: {
        id: true, status: true, customerName: true, note: true, createdAt: true, invoiceId: true, salesRepId: true,
        salesRep: { select: { name: true } }, _count: { select: { items: true } },
      },
    });
    if (!rows.length) return rows;
    const mine = await catalogOrdersOfCustomer(ctx, key, rows);
    return rows.map((r) => ({ ...r, attributed: mine.has(r.id) }));
  },
  refs: (r) => [{ refType: 'CATALOG_ORDER', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(catalogOrders, (r) => (r.attributed ? {
    action: 'CATALOG_ORDER_PLACED', actor: { kind: 'CUSTOMER', id: null, name: clip(r.customerName, 200) }, refType: 'CATALOG_ORDER',
    refId: r.id, refNo: null, amount: null,
    // unverified كالسطر الحيّ (routes/publicCatalog.ts): الصفحة علنيّة بلا مصادقة — الاسم والملاحظة ما ادّعاه المُرسِل، والنسبة بالجوال
    data: compact({
      unverified: true, status: r.status, itemsCount: r._count?.items, note: clip(r.note), toRep: clip(r.salesRep?.name, 200),
      invoiced: r.invoiceId ? true : undefined,
    }),
  } : null))(rows, ex, ctx),
};

const routeStops: HistSource = {
  key: 'route', rank: 15, categories: ['visits'], dateField: 'createdAt',
  fetch: (ctx, c, take) => ctx.db.repRouteStop.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, AND: [timeWhere('createdAt', c, 15), beforeLog('createdAt', ctx)] },
    orderBy: ord('createdAt'), take,
    select: {
      id: true, routeId: true, seq: true, createdAt: true,
      route: { select: { name: true, isActive: true, isPermanent: true, routeDate: true, salesRep: { select: { name: true } } } },
    },
  }),
  refs: (r) => [{ refType: 'ROUTE', refId: r.routeId }],
  build: (rows, ex, ctx) => simpleBuild(routeStops, (r) => ({
    action: 'ROUTE_STOP_ADDED', actor: { kind: 'ADMIN', id: null, name: null }, refType: 'ROUTE', refId: r.routeId, refNo: null, amount: null,
    data: compact({
      routeName: clip(r.route?.name, 200), toRep: clip(r.route?.salesRep?.name, 200), seq: r.seq, isPermanent: r.route?.isPermanent,
      routeDate: r.route?.routeDate, inactive: r.route?.isActive === false ? true : undefined,
    }),
  }))(rows, ex, ctx),
};

const assignments: HistSource = {
  key: 'assign', rank: 12, categories: ['edits'], dateField: 'createdAt',
  fetch: (ctx, c, take) => ctx.db.customerAssignment.findMany({
    where: { tenantId: ctx.tid, customerId: ctx.customer.id, ...timeWhere('createdAt', c, 12) },
    orderBy: ord('createdAt'), take,
    select: { id: true, salesRepId: true, source: true, createdAt: true, salesRep: { select: { name: true } } },
  }),
  refs: (r) => [{ refType: 'ASSIGNMENT', refId: r.salesRepId }],
  build: (rows, ex, ctx) => simpleBuild(assignments, (r) => ({
    action: 'CUSTOMER_ASSIGNED',
    // AUTO = المندوب فتح العميل بنفسه، MANUAL = أسندته الإدارة
    actor: r.source === 'AUTO' ? repOrAdmin(r.salesRepId, r.salesRep?.name) : { kind: 'ADMIN', id: null, name: null },
    refType: 'ASSIGNMENT', refId: r.salesRepId, refNo: null, amount: null,
    data: compact({ toRep: clip(r.salesRep?.name, 200), auto: r.source === 'AUTO' ? true : undefined }),
  }))(rows, ex, ctx),
};

/** أسعار العميل الخاصة (بلا tenantId في جدولها — والعميل نفسه محقَّقٌ في الشركة قبلها) */
const prices: HistSource = {
  key: 'price', rank: 10, categories: ['edits'], dateField: 'updatedAt',
  fetch: (ctx, c, take) => ctx.db.customerPrice.findMany({
    where: { customerId: ctx.customer.id, AND: [timeWhere('updatedAt', c, 10), beforeLog('updatedAt', ctx)] },
    orderBy: ord('updatedAt'), take,
    select: { id: true, productId: true, price: true, updatedAt: true, product: { select: { name: true } } },
  }),
  refs: (r) => [{ refType: 'PRICE', refId: r.productId }],
  build: (rows, ex, ctx) => simpleBuild(prices, (r) => ({
    action: 'CUSTOMER_PRICE_SET', actor: { kind: 'ADMIN', id: null, name: null }, refType: 'PRICE', refId: r.productId, refNo: null,
    amount: num(r.price), data: compact({ productName: clip(r.product?.name, 200), unitPrice: num(r.price) }),
  }))(rows, ex, ctx),
};

/** إنشاء العميل — بندٌ واحد من صفّه نفسه (رتبةٌ دنيا: آخر ما يُعرض في لحظته) */
const CREATED_RANK = 5;
const created: HistSource = {
  key: 'created', rank: CREATED_RANK, categories: ['edits'], dateField: 'createdAt',
  fetch: async (ctx, c) => {
    const at = asDate(ctx.customer.createdAt);
    return afterCursor({ at, rank: CREATED_RANK, id: ctx.customer.id }, c) ? [ctx.customer] : [];
  },
  refs: (r) => [{ refType: 'CUSTOMER', refId: r.id }],
  build: (rows, ex, ctx) => simpleBuild(created, (r) => ({
    action: 'CUSTOMER_CREATED', actor: repOrAdmin(r.createdBySalesRepId, r.createdBySalesRep?.name), refType: 'CUSTOMER', refId: r.id,
    refNo: r.number != null ? String(r.number) : null, amount: null,
    data: compact({ name: clip(r.name, 200), businessName: clip(r.businessName, 200), offline: r.clientRef ? true : undefined }),
  }))(rows, ex, ctx),
};

export const HIST_SOURCES: readonly HistSource[] = [
  invoices, receipts, visits, documents, paylinks, paylinksPaid, cardPayments, adjustments, calls, catalogOrders, routeStops, assignments,
  prices, created,
];
/** رتبة أسطر السجلّ الثابت: أعلى من كل مصدرٍ مشتقّ */
export const LOG_RANK = 100;

// ═══ الوقفات: الزيارات الحيّة والمشتقّة معاً ═══

/** سجلّ زيارةٍ واحد في الدمج — صفّ RepVisit (مشتقّ) أو سطر VISIT_RECORDED (حيّ) */
interface VisitRec {
  /** مفتاحٌ فريد للسجلّ في الجولة: L:<سطر> أو V:<زيارة> */
  key: string;
  /** معرّف الزيارة (مرجع السطر الحيّ) */
  visitId: string;
  pos: Pos;
  /** موضعه من القراءة الرئيسية للجولة (فيُرتَّب مع غيره بـseq) — لا من قراءة الهامش */
  main: boolean;
  live: boolean;
  logId: string | null;
  salesRepId: string;
  createdAt: Date;
  /** لحظة الدمج ومدّته بعد المحلّية (localize) — وما خُزّن كما هو في raw* للعرض */
  startedAt: Date | null;
  durationSec: number | null;
  rawStartedAt: Date | null;
  rawDurationSec: number | null;
  lat: number | null;
  lng: number | null;
  note: string | null;
  photoIds: string[];
  photosCount: number;
  hasLocation: boolean;
  offline: boolean;
  repName: string | null;
  actor: ActorRef;
}

/**
 * لحظة الدمج ومدّته (انظر VISIT_LOCAL_SKEW_MS): المدّة بسقف المسار، والمؤقّت الذي يبعد طابعه عن نافذته أكثر من الهامش — وكذا
 * الملاحظة عن لحظتها — يُدمج بموضعه بلا توقيت
 */
function localize(rec: Omit<VisitRec, 'startedAt' | 'durationSec'>): VisitRec {
  const pos = rec.pos.at.getTime();
  const dur = rec.rawDurationSec && rec.rawDurationSec > 0 ? Math.min(rec.rawDurationSec, VISIT_MAX_MERGE_SEC) : null;
  const start = (rec.rawStartedAt ?? rec.createdAt).getTime();
  if (dur) {
    const local = pos >= start - VISIT_LOCAL_SKEW_MS && pos <= start + dur * 1000 + VISIT_LOCAL_SKEW_MS;
    return { ...rec, startedAt: local ? new Date(start) : rec.pos.at, durationSec: local ? dur : null };
  }
  return { ...rec, startedAt: Math.abs(start - pos) <= VISIT_LOCAL_SKEW_MS ? new Date(start) : rec.pos.at, durationSec: null };
}

function visitRecOfLog(r: AnyRow, pos: Pos, main: boolean): VisitRec {
  const d = isObj(r.data) ? r.data : {};
  const rep = typeof d.salesRepId === 'string' && d.salesRepId ? d.salesRepId : r.actorKind === 'REP' && r.actorId ? String(r.actorId) : null;
  const dur = num(d.durationSec);
  return localize({
    key: `L:${r.id}`, visitId: typeof r.refId === 'string' && r.refId ? r.refId : r.id, pos, main, live: true, logId: r.id,
    // بلا مندوبٍ معروف لا يُدمج بغيره (مجموعةٌ وحده)
    salesRepId: rep ?? `log:${r.id}`, createdAt: pos.at,
    rawStartedAt: optDate(d.startedAt), rawDurationSec: dur && dur > 0 ? dur : null, lat: null, lng: null,
    note: clip(d.note, 2000), photoIds: [], photosCount: num(d.photosCount) ?? 0, hasLocation: d.hasLocation === true,
    offline: d.offline === true, repName: clip(d.repName, 200) ?? (r.actorKind === 'REP' ? clip(r.actorName, 200) : null),
    actor: { kind: r.actorKind as ActivityActorKind, id: r.actorId ?? null, name: r.actorName ?? null },
  });
}

function visitRecOfRow(r: AnyRow, pos: Pos, main: boolean): VisitRec {
  const photoIds = Array.isArray(r.photos) ? r.photos.map((p: AnyRow) => String(p.id)) : [];
  const lat = num(r.lat); const lng = num(r.lng);
  const dur = num(r.durationSec);
  return localize({
    key: `V:${r.id}`, visitId: r.id, pos, main, live: false, logId: null, salesRepId: String(r.salesRepId), createdAt: asDate(r.createdAt),
    rawStartedAt: optDate(r.startedAt), rawDurationSec: dur && dur > 0 ? dur : null, lat, lng, note: clip(r.note, 2000),
    photoIds, photosCount: photoIds.length, hasLocation: lat != null && lng != null, offline: false, repName: clip(r.salesRep?.name, 200),
    actor: repOrAdmin(r.salesRepId, r.salesRep?.name),
  });
}

type MergedRec = VisitRec & VisitLike;

/** بند الوقفة: مرجعه رأسها (المؤقّت أوّلاً — وصور الأرشيف مفهرسةٌ به)، وموضعه anchor (أحدث سجلّاتها) */
function stopCand(m: MergedVisit<MergedRec>, anchor: Pos): Cand {
  const srcs = m.sources;
  const head = srcs[0];
  const notes = [...new Set(srcs.map((v) => (v.note || '').trim()).filter(Boolean))];
  const photoIds = srcs.flatMap((v) => v.photoIds);
  const photosCount = srcs.reduce((s, v) => s + (v.photosCount || 0), 0);
  // مدّة المؤقّت كما خُزّنت (سقف الدمج للنافذة وحدها)
  const durationSec = m.durationSec ? head.rawDurationSec ?? m.durationSec : null;
  const end = durationSec ? new Date(m.start.getTime() + durationSec * 1000) : m.end;
  return {
    pos: anchor, hist: srcs.every((v) => !v.live), outId: head.live && head.logId ? head.logId : `h:visit:${head.visitId}`,
    action: 'VISIT_RECORDED', actor: head.actor, refType: 'VISIT', refId: head.visitId, refNo: null, amount: null,
    visitRepId: head.salesRepId,
    data: compact({
      durationSec: durationSec ?? undefined, startedAt: m.start.toISOString(), endedAt: end ? end.toISOString() : undefined,
      note: notes.length ? clip(notes.join('\n'), 2000) : undefined, photosCount: photosCount || undefined,
      photoIds: photoIds.length ? photoIds.slice(0, 30) : undefined, lat: m.lat ?? undefined, lng: m.lng ?? undefined,
      hasLocation: m.lat != null || srcs.some((v) => v.hasLocation) ? true : undefined,
      repName: srcs.map((v) => v.repName).find(Boolean) ?? undefined, offline: srcs.some((v) => v.offline) ? true : undefined,
      parts: m.parts > 1 ? m.parts : undefined, visitIds: srcs.length > 1 ? srcs.map((s) => s.visitId) : undefined,
    }),
  };
}

/**
 * الوقفات التي يقع موضعها (أحدث سجلّاتها) في مدى الجولة: بعد المؤشّر وحتى الأفق — من سجلّات المدى وهامشها معاً. والوقفة التي
 * موضعها قبل المؤشّر عُرضت كاملةً في صفحةٍ سبقت فلا تُعاد، والتي موضعها بعد الأفق تُعرض في جولتها. السجلّات بترتيبٍ ثابت قبل الدمج
 * (ترتيب القاعدة) فتتطابق الوقفة نفسها في كل صفحة
 */
function buildVisitStops(recs: VisitRec[], customerId: string, inRange: (r: VisitRec) => boolean): Cand[] {
  const sorted = [...recs].sort((a, b) => cmpKey(a.pos, b.pos));
  const out: Cand[] = [];
  for (const m of mergeVisitsByRep(sorted.map((v) => asVisitLike({ ...v, customerId })))) {
    const anchor = [...m.sources].sort((a, b) => cmpKey(a.pos, b.pos))[0];
    if (inRange(anchor)) out.push(stopCand(m, anchor.pos));
  }
  return out;
}

// ═══ الصفحة ═══

interface Window { cands: Cand[]; horizon: Pos | null }

/** نوع المرجع ⇒ جدوله وقيد نطاقه (RecordScope) — لسطور السجلّ عند القارئ المقيَّد */
const SCOPED_REFS: Readonly<Record<string, { model: 'invoice' | 'receipt' | 'repVisit' | 'customerPaymentLink' | 'cardPayment'; scope: 'invoice' | 'receipt' | 'visit' | 'paylink' | 'card' }>> = {
  INVOICE: { model: 'invoice', scope: 'invoice' }, RECEIPT: { model: 'receipt', scope: 'receipt' }, VISIT: { model: 'repVisit', scope: 'visit' },
  PAYLINK: { model: 'customerPaymentLink', scope: 'paylink' }, CARD_PAYMENT: { model: 'cardPayment', scope: 'card' },
};
const LEDGER_ACTIONS = new Set(['ADJUSTMENT_CREATED', 'ADJUSTMENT_UPDATED', 'OPENING_BALANCE_SET', 'LEDGER_JOURNAL_POSTED', 'LEDGER_JOURNAL_REVERSED']);

/**
 * أيّ أسطر السجلّ يراها القارئ المقيَّد: سطرٌ بمرجع فاتورة/سند/زيارة/رابط/بطاقة يظهر إن كان مرجعه في نطاقه اليوم (والمحذوف أو
 * المجمَّع بلا مرجع لا يظهر — فشلٌ مغلق كبقية النظام)، وقيود العميل بلا مستند لمن يرى القيود. وغير المقيَّد يرى الكلّ
 */
async function logVisibility(ctx: Ctx, rows: AnyRow[]): Promise<(r: AnyRow) => boolean> {
  const scope = ctx.viewer.scope;
  if (!scope) return () => true;
  const want = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = SCOPED_REFS[r.refType as string];
    if (!s || typeof r.refId !== 'string' || !r.refId) continue;
    const set = want.get(r.refType) ?? new Set<string>();
    set.add(r.refId);
    want.set(r.refType, set);
  }
  const visible = new Set<string>();
  await Promise.all([...want].map(async ([refType, ids]) => {
    const s = SCOPED_REFS[refType];
    const found = await ctx.db[s.model].findMany({
      where: { tenantId: ctx.tid, id: { in: [...ids] }, AND: andOf(scope[s.scope]) }, select: { id: true },
    });
    for (const f of found) visible.add(`${refType}:${f.id}`);
  }));
  return (r) => {
    if (SCOPED_REFS[r.refType as string]) return typeof r.refId === 'string' && visible.has(`${r.refType}:${r.refId}`);
    if (r.refType === 'ADJUSTMENT' || LEDGER_ACTIONS.has(r.action)) return scope.ledger;
    return true;
  };
}

/** جولة واحدة: كل مصدرٍ limit+1 بعد المؤشّر، ثم المطابقة بالسجلّ، ثم البنود حتى أفق أقصر المصادر المقطوعة */
async function loadWindow(ctx: Ctx, cursor: ActivityCursor | null, take: number): Promise<Window> {
  const { db, tid, customer, category } = ctx;
  const logActions = category === 'all' ? null : actionsOfCategory(category);
  const sources = HIST_SOURCES.filter((s) => category === 'all' || s.categories.includes(category));
  const [logRows, ...histRows] = await Promise.all([
    db.customerActivity.findMany({
      where: { tenantId: tid, customerId: customer.id, ...(logActions ? { action: { in: logActions } } : {}), ...timeWhere('at', cursor, LOG_RANK) },
      orderBy: ord('at'), take,
    }),
    ...sources.map((s) => s.fetch(ctx, cursor, take)),
  ]);

  // المواضع، والأفق: آخر صفٍّ قُرئ من كل مصدرٍ بلغ سقفه — أوّلها في الترتيب
  const lastOf: Pos[] = [];
  const logPos: Pos[] = logRows.map((r, i) => ({ at: asDate(r.at), rank: LOG_RANK, id: r.id, seq: i }));
  if (logRows.length >= take) lastOf.push(logPos[logPos.length - 1]);
  const histPos = sources.map((s, k) => histRows[k].map((row, i) => ({ row, pos: { at: asDate(row[s.dateField]), rank: s.rank, id: row.id as string, seq: i } })));
  sources.forEach((s, k) => { if (histRows[k].length >= take) lastOf.push(histPos[k][histPos[k].length - 1].pos); });
  const horizon = lastOf.length ? [...lastOf].sort(cmpPos)[0] : null;
  const safe = (p: Pos) => !horizon || cmpPos(p, horizon) <= 0;

  // سجلّات الزيارة في مدى الجولة، ثم هامشها حولها (قبل المؤشّر وبعد الأفق) — لتُبنى وقفاتها كاملة
  const vk = sources.indexOf(visits);
  const visitLogs = logRows.map((r, i) => ({ r, pos: logPos[i] })).filter(({ r }) => r.action === 'VISIT_RECORDED');
  const visitRows = vk >= 0 ? histPos[vk] : [];
  const inRangeAts = [...visitLogs, ...visitRows.map(({ row, pos }) => ({ r: row, pos }))].filter(({ pos }) => safe(pos)).map(({ pos }) => pos.at.getTime());
  let ctxLogs: AnyRow[] = [];
  let ctxRows: AnyRow[] = [];
  if (inRangeAts.length) {
    const lo = new Date(Math.min(...inRangeAts) - VISIT_CONTEXT_MS - 1);
    const hi = new Date((cursor ? cursor.at.getTime() : Math.max(...inRangeAts)) + VISIT_CONTEXT_MS);
    [ctxLogs, ctxRows] = await Promise.all([
      db.customerActivity.findMany({
        where: { tenantId: tid, customerId: customer.id, action: 'VISIT_RECORDED', at: { gt: lo, lte: hi } },
        orderBy: ord('at'), take: VISIT_CONTEXT_CAP,
      }),
      db.repVisit.findMany({
        where: { tenantId: tid, customerId: customer.id, AND: [{ createdAt: { gt: lo, lte: hi } }, ...andOf(ctx.viewer.scope?.visit)] },
        orderBy: ord('createdAt'), take: VISIT_CONTEXT_CAP, select: VISIT_SELECT,
      }),
    ]);
  }

  // المطابقة بالسجلّ: مرجعٌ له سطرُ ميلاد (أو السطر نفسه) لا يُشتقّ ثانيةً
  const refIds = new Set<string>();
  const refTypes = new Set<string>();
  sources.forEach((s, k) => histPos[k].forEach(({ row, pos }) => {
    if (!safe(pos)) return;
    for (const r of s.refs(row)) if (r.refId) { refIds.add(r.refId); refTypes.add(r.refType); }
  }));
  // وكل صفوف الزيارات المقروءة (الرئيسية كلها والهامش): سجلٌّ له سطر VISIT_RECORDED يمثّله سطره الحيّ في الوقفة لا صفّه
  for (const row of [...visitRows.map(({ row: x }) => x), ...ctxRows]) { refIds.add(row.id); refTypes.add('VISIT'); }
  const born = new Set<string>();
  const exact = new Set<string>();
  if (refIds.size) {
    const logged = await db.customerActivity.findMany({
      where: { tenantId: tid, customerId: customer.id, refType: { in: [...refTypes] }, refId: { in: [...refIds] } },
      select: { refType: true, refId: true, action: true },
    });
    for (const l of logged) {
      const k = `${l.refType}:${l.refId}`;
      exact.add(`${k}:${l.action}`);
      if (CREATION_ACTIONS.has(l.action)) born.add(k);
    }
  }
  const excluded: Excluder = (refType, refId, action, primary) =>
    exact.has(`${refType}:${refId}:${action}`) || (primary && born.has(`${refType}:${refId}`));
  const visible = await logVisibility(ctx, [...logRows.filter((r, i) => safe(logPos[i]) || r.action === 'VISIT_RECORDED'), ...ctxLogs]);

  const cands: Cand[] = [];
  logRows.forEach((r, i) => {
    if (!safe(logPos[i]) || r.action === 'VISIT_RECORDED' || !visible(r)) return;
    cands.push({
      pos: logPos[i], hist: false, action: r.action, outId: r.id,
      actor: { kind: r.actorKind as ActivityActorKind, id: r.actorId ?? null, name: r.actorName ?? null },
      refType: r.refType ?? null, refId: r.refId ?? null, refNo: r.refNo ?? null, amount: num(r.amount),
      data: isObj(r.data) ? r.data : null,
    });
  });
  sources.forEach((s, k) => {
    const rows = histPos[k].filter(({ pos }) => safe(pos));
    if (rows.length) cands.push(...s.build(rows, excluded, ctx));
  });

  // الوقفات: أسطر VISIT_RECORDED الحيّة وصفوف الزيارات المشتقّة (بلا ما له سطر ميلاد) من القراءة الرئيسية ثم الهامش
  if (inRangeAts.length) {
    const recs = new Map<string, VisitRec>();
    for (const { r, pos } of visitLogs) if (visible(r)) recs.set(`L:${r.id}`, visitRecOfLog(r, pos, true));
    for (const { row, pos } of visitRows) if (!excluded('VISIT', row.id, 'VISIT_RECORDED', true)) recs.set(`V:${row.id}`, visitRecOfRow(row, pos, true));
    const ctxPos = (at: unknown, rank: number, id: string): Pos => ({ at: asDate(at), rank, id, seq: Number.POSITIVE_INFINITY });
    for (const r of ctxLogs) if (!recs.has(`L:${r.id}`) && visible(r)) recs.set(`L:${r.id}`, visitRecOfLog(r, ctxPos(r.at, LOG_RANK, r.id), false));
    for (const row of ctxRows) {
      if (recs.has(`V:${row.id}`) || excluded('VISIT', row.id, 'VISIT_RECORDED', true)) continue;
      recs.set(`V:${row.id}`, visitRecOfRow(row, ctxPos(row.createdAt, visits.rank, row.id), false));
    }
    const inRange = (v: VisitRec) => v.main && afterCursor(v.pos, cursor) && safe(v.pos);
    cands.push(...buildVisitStops([...recs.values()], customer.id, inRange));
  }

  // مصدرٌ يُنتج أكثر من قسم (الفواتير: مبيعات ومرتجعات) يُرشَّح بالبند
  const inCat = category === 'all' ? cands : cands.filter((c) => categoryOfAction(c.action) === category);
  inCat.sort((a, b) => cmpPos(a.pos, b.pos));
  return { cands: inCat, horizon };
}

/** أسماء ما لم يُلتقط اسمه: المستخدم والمندوب بمعرّفهما، والمفتاح البرمجي بوسمه — كلها بشركة الطالب */
async function resolveNames(db: ActivityDb, tid: string, cands: Cand[]): Promise<void> {
  const want = { admin: new Set<string>(), rep: new Set<string>(), api: new Set<string>() };
  for (const c of cands) {
    if (c.actor.name || !c.actor.id) continue;
    if (c.actor.kind === 'API') want.api.add(c.actor.id);
    else if (c.actor.lookup === 'rep' || c.actor.kind === 'REP') want.rep.add(c.actor.id);
    else if (c.actor.lookup === 'admin' || c.actor.kind === 'ADMIN') want.admin.add(c.actor.id);
  }
  const q = (d: Delegate, ids: Set<string>, select: Record<string, true> = { id: true, name: true }) => (ids.size
    ? d.findMany({ where: { tenantId: tid, id: { in: [...ids] } }, select })
    : Promise.resolve([] as AnyRow[]));
  const [admins, reps, keys] = await Promise.all([
    q(db.admin, want.admin), q(db.salesRep, want.rep), q(db.apiKey, want.api, { id: true, name: true, createdBy: true }),
  ]);
  const names = {
    admin: new Map(admins.map((r) => [r.id as string, r.name as string])),
    rep: new Map(reps.map((r) => [r.id as string, r.name as string])),
    // مفتاحٌ أصدره الدعم الفني (createdBy = OWNER:<معرّف>) يظهر «الدعم الفني» كجلسته — لا بوسمه
    api: new Map(keys.map((r) => [r.id as string, String(r.createdBy ?? '').startsWith('OWNER:') ? PLATFORM_SUPPORT_NAME : r.name as string])),
  };
  for (const c of cands) {
    if (c.actor.name || !c.actor.id) continue;
    const book = c.actor.kind === 'API' ? names.api : c.actor.lookup === 'rep' || c.actor.kind === 'REP' ? names.rep : names.admin;
    c.actor.name = book.get(c.actor.id) ?? null;
  }
}

/**
 * أرقام الفواتير التي لم يلتقطها السطر الحيّ القديم (قبل أن يحملها الكاتب): توزيع السند (allocations[].invoiceId بلا invoiceNo)
 * وفاتورة بيع المرتجع المرتبط (saleInvoiceId بلا originalInvoiceNo) — من جدول الفواتير بشركة الطالب، دفعةً واحدة. يُبنى نسخةً
 * جديدة من التفاصيل (السطر المخزَّن لا يُمسّ)، والفاتورة المحذوفة يبقى توزيعها بلا رقم
 */
async function fillInvoiceNumbers(db: ActivityDb, tid: string, cands: Cand[]): Promise<void> {
  const want = new Set<string>();
  const missing = (c: Cand) => {
    const d = c.data;
    if (c.hist || !d) return;
    if (Array.isArray(d.allocations)) {
      for (const a of d.allocations) if (isObj(a) && !a.invoiceNo && typeof a.invoiceId === 'string' && a.invoiceId) want.add(a.invoiceId);
    }
    if (!d.originalInvoiceNo && typeof d.saleInvoiceId === 'string' && d.saleInvoiceId) want.add(d.saleInvoiceId);
  };
  cands.forEach(missing);
  if (!want.size) return;
  const rows = await db.invoice.findMany({ where: { tenantId: tid, id: { in: [...want] } }, select: { id: true, number: true } });
  const no = new Map(rows.filter((r) => r.number).map((r) => [r.id as string, String(r.number)]));
  if (!no.size) return;
  for (const c of cands) {
    const d = c.data;
    if (c.hist || !d) continue;
    let next: Record<string, unknown> | null = null;
    if (Array.isArray(d.allocations) && d.allocations.some((a) => isObj(a) && !a.invoiceNo && no.has(a.invoiceId as string))) {
      next = { ...d, allocations: d.allocations.map((a) => (isObj(a) && !a.invoiceNo && no.has(a.invoiceId as string) ? { ...a, invoiceNo: no.get(a.invoiceId as string) } : a)) };
    }
    if (!d.originalInvoiceNo && no.has(d.saleInvoiceId as string)) next = { ...(next ?? d), originalInvoiceNo: no.get(d.saleInvoiceId as string) };
    if (next) c.data = next;
  }
}

// ═══ الحجب بالصلاحية ═══

/** تفاصيل البند المالي المحجوب: من فعل ماذا وحالته ونوعه وأرقام مستنداته — بلا مبلغٍ ولا بيانات دفعٍ ولا ملاحظة */
const SAFE_FINANCIAL_KEYS = new Set([
  'paymentType', 'documentKind', 'invoiceType', 'status', 'newStatus', 'cancelled', 'itemsCount', 'invoicesCount', 'reason', 'returnReason',
  'returnToStock', 'originalInvoiceNo', 'invoiceNo', 'offline', 'via', 'kind', 'method', 'paymentMethod', 'paymentMethodKey', 'cardScheme',
  'zatcaPhase', 'repName', 'toRep', 'fromRep', 'expiresAt', 'entryDate', 'side', 'source', 'count', 'reversed', 'settled',
  // أرقام القيود والسندات وأوضاع الإجراء وحالاته (جولة الإصلاح: القيود اليدوية والحذف النهائي وإغلاق المراجعة) — بلا مال
  'moveNo', 'receiptNo', 'reversalNo', 'mode', 'closedAfterReview', 'cascade', 'previousStatus', 'fromStatus', 'oldStatus',
  'receiptAlreadyCancelled', 'purged',
]);
/** مفاتيح المال في تفاصيل غير مالية (تقدير طلب المنيو، سعر الصنف) — تُحذف حين يُطفأ النظام المحاسبي */
const MONEY_KEY_RE = /^(amount|total|taxTotal|tax|discount|paidAmt|remainingAmt|overpaid|unitPrice|price|estimate|balance|debit|credit|subtotal|lineTotal|refundAmount|amountOutOfRange)$/i;

function financialSafe(data: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!data) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SAFE_FINANCIAL_KEYS.has(k)) out[k] = v;
    // توزيع السند: أرقام الفواتير وحدها بلا مبالغها (وهل سُدّدت كاملة، وهل عاد مبلغها إلى فاتورةٍ باقية بحذف السند نهائياً)
    else if (k === 'allocations' && Array.isArray(v)) {
      out[k] = v.filter(isObj).map((a) => compact({
        invoiceNo: a.invoiceNo, settled: a.settled === true ? true : undefined, restored: a.restored === true ? true : undefined,
      })).filter(Boolean);
    }
  }
  return Object.keys(out).length ? out : null;
}

function stripMoney(v: unknown, priceDiff: boolean, depth = 0): unknown {
  if (depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => stripMoney(x, priceDiff, depth + 1));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEY_RE.test(k) || (priceDiff && (k === 'from' || k === 'to'))) continue;
      out[k] = stripMoney(x, priceDiff, depth + 1);
    }
    return out;
  }
  return v;
}

/** باب البند المالي: المبيعات والمرتجعات (الفواتير بأنواعها) أو التحصيل (قسم المال كله) — وطلب المنيو ليس مستنداً مالياً */
function moneyGate(c: Cand): 'sales' | 'receipts' | null {
  const cat = categoryOfAction(c.action);
  if (cat === 'money') return 'receipts';
  if ((cat === 'sales' || cat === 'returns') && c.refType !== 'CATALOG_ORDER' && !c.action.startsWith('CATALOG_ORDER')) return 'sales';
  return null;
}

function redact(c: Cand, v: Viewer): { amount: number | null; data: Record<string, unknown> | null } {
  let { amount, data } = c;
  const gate = moneyGate(c);
  const allowed = gate === 'sales' ? v.salesMoney : gate === 'receipts' ? v.receiptMoney : true;
  if (gate && (!allowed || !v.amounts)) { amount = null; data = financialSafe(data); }
  else if (!v.amounts) { amount = null; data = stripMoney(data, c.action.startsWith('CUSTOMER_PRICE')) as Record<string, unknown> | null; }
  // إحداثيات زيارة مندوبٍ آخر بيانات تتبّع — لا تصل المندوب
  if (v.repId && c.refType === 'VISIT' && data && (data.lat !== undefined || data.lng !== undefined) && c.visitRepId !== v.repId) {
    const { lat: _la, lng: _lo, ...rest } = data;
    data = rest;
  }
  return { amount, data };
}

function toOut(c: Cand, viewer: Viewer): ActivityOut {
  // المالك وموظف المنصة يظهران للشركة بدورهما وحده بلا اسم (والواجهة تسمّيهما «الدعم الفني» كـactorOf/docUploader) — والاسم
  // لجلسة المنصة نفسها
  const hideName = (c.actor.kind === 'OWNER' || c.actor.kind === 'STAFF') && !viewer.platform;
  const { amount, data } = redact(c, viewer);
  // معرّف المنفّذ للمندوب والإداري وحدهما (ترشيح «من نفّذ» بلا خلطٍ بين اسمين متطابقين) — لا لأفعال المنصّة ولا المفتاح ولا العميل
  const showId = (c.actor.kind === 'REP' || c.actor.kind === 'ADMIN') && !!c.actor.id;
  return {
    id: c.outId, at: c.pos.at.toISOString(), action: c.action, category: categoryOfAction(c.action),
    actor: { kind: c.actor.kind, name: hideName ? null : c.actor.name ?? null, ...(showId && { id: c.actor.id }) },
    refType: c.refType, refId: c.refId, refNo: c.refNo, amount, data, historical: c.hist,
  };
}

export interface ActivityQuery { cursor: ActivityCursor | null; limit: number; category: ActivityCategory | 'all' }

export function parseActivityQuery(q: Record<string, unknown> | undefined): ActivityQuery {
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const n = Number(first(q?.limit));
  const limit = Number.isFinite(n) && n >= 1 ? Math.min(ACTIVITY_MAX_LIMIT, Math.floor(n)) : ACTIVITY_DEFAULT_LIMIT;
  const cat = String(first(q?.category) ?? 'all');
  const category = (ACTIVITY_CATEGORIES as readonly string[]).includes(cat) ? (cat as ActivityCategory) : 'all';
  return { cursor: decodeActivityCursor(first(q?.before)), limit, category };
}

const logStartCache = new WeakMap<object, Map<string, { at: Date; exp: number }>>();

/**
 * بدء السجلّ الثابت في الشركة: لحظة إدراج أقدم سطرٍ لها (recordedAt بساعة القاعدة — انظر Ctx.logStart) بفهرس (tenantId, recordedAt).
 * لا لحظة الإجراء `at`: سطرٌ مؤرَّخ يدوياً أو من جهازٍ دون اتصال لا يحرّك القاطع إلى الوراء فيُخفي تاريخاً. ثابتٌ بعد أوّل سطر (الأسطر
 * لا تُحذف ولا تُدرج في الماضي) فيُحفظ ساعةً لكل قاعدة؛ وبلا سطرٍ بعد لا يُحفظ شيء. صفٌّ بلا recordedAt (القاعدة في الذاكرة) ⇒ at
 */
export async function tenantLogStart(db: ActivityDb, tid: string, now = Date.now()): Promise<Date | null> {
  let book = logStartCache.get(db);
  if (!book) { book = new Map(); logStartCache.set(db, book); }
  const hit = book.get(tid);
  if (hit && hit.exp > now) return hit.at;
  const [first] = await db.customerActivity.findMany({
    where: { tenantId: tid }, orderBy: [{ recordedAt: 'asc' }, { at: 'asc' }, { id: 'asc' }], take: 1, select: { recordedAt: true, at: true },
  });
  const raw = first?.recordedAt ?? first?.at;
  if (!raw) return null;
  const at = asDate(raw);
  book.set(tid, { at, exp: now + LOG_START_TTL_MS });
  return at;
}

/** مرشّحو نسبة طلب المنيو من db وحده (الاختبار): عملاء الشركة غير المحذوفين بالمفتاح نفسه */
async function dbPhoneCandidates(db: ActivityDb, tid: string, key: string): Promise<CustomerCandidate[]> {
  const rows = await db.customer.findMany({
    where: { tenantId: tid, status: { not: 'DELETED' } }, select: { id: true, name: true, phone: true, createdAt: true }, take: 5000,
  });
  return rows.filter((r) => orderPhoneKey(r.phone) === key) as CustomerCandidate[];
}

/**
 * صفحةٌ من سجلّ العميل: null = العميل غير موجود في شركة الطالب أو خارج نطاقه (٤٠٤). تُجمَع الجولات حتى تمتلئ الصفحة أو تنفد
 * المصادر، ومؤشّر الصفحة التالية موضع آخر بندٍ عُرض (أو الأفق حين تفرغ الجولات بالمطابقة)
 */
export async function loadCustomerActivity(
  deps: ActivityDeps, req: AuthRequest, tid: string, customerId: string, query: ActivityQuery,
): Promise<{ items: ActivityOut[]; nextBefore: string | null } | null> {
  const scope = await deps.customerScope(req, tid);
  const customer = await deps.db.customer.findFirst({
    where: { id: customerId, tenantId: tid, ...scope },
    select: {
      id: true, name: true, businessName: true, phone: true, number: true, createdAt: true, clientRef: true, createdBySalesRepId: true,
      createdBySalesRep: { select: { name: true } }, tenant: { select: { accountingEnabled: true } },
    },
  });
  if (!customer) return null;
  const [viewer, logStart] = await Promise.all([resolveViewer(deps, req, tid, customer), tenantLogStart(deps.db, tid)]);
  const ctx: Ctx = {
    db: deps.db, tid, customer, category: query.category, viewer, logStart,
    phoneCandidates: (key) => (deps.phoneCandidates ? deps.phoneCandidates(tid, key) : dbPhoneCandidates(deps.db, tid, key)),
  };
  const take = query.limit + 1;
  const out: Cand[] = [];
  let cursor = query.cursor;
  let nextBefore: string | null = null;
  for (let round = 0; ; round++) {
    const need = query.limit - out.length;
    const w = await loadWindow(ctx, cursor, take);
    if (w.cands.length > need) {
      out.push(...w.cands.slice(0, need));
      nextBefore = encodeActivityCursor(out[out.length - 1].pos);
      break;
    }
    out.push(...w.cands);
    if (!w.horizon) { nextBefore = null; break; }
    // ما قبل الأفق كله عُرض — والجولة التالية بعده
    cursor = w.horizon;
    if (out.length >= query.limit || round + 1 >= ACTIVITY_MAX_ROUNDS) { nextBefore = encodeActivityCursor(w.horizon); break; }
  }
  await Promise.all([resolveNames(deps.db, tid, out), fillInvoiceNumbers(deps.db, tid, out)]);
  return { items: out.map((c) => toOut(c, viewer)), nextBefore };
}

export function createCustomerActivityRouter(deps: ActivityDeps): Router {
  const r = Router();
  // المصادقة والصلاحية على المسار نفسه لا router.use: الموجّه مركَّبٌ على /api/customers قبل موجّه العملاء، فلا يُصادَق طلبٌ لغيره
  // مرّتين. requireAdminPermission('canManageCustomers') كموجّه العملاء نفسه: المندوب يمرّ، ومستخدم الشركة بصلاحية العملاء،
  // وجلسة «دخول» المالك أو الموظف بكل صلاحية — وصلاحيات المال والنطاق داخل القراءة (resolveViewer)
  r.get('/:id/activity', authenticate, requireAdminPermission('canManageCustomers'), async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tid = tenantId(req);
      const page = await loadCustomerActivity(deps, req, tid, String(req.params.id ?? ''), parseActivityQuery(req.query));
      if (!page) { res.status(404).json({ success: false, message: 'العميل غير موجود' }); return; }
      res.json({ success: true, data: page });
    } catch (err) { next(err); }
  });
  return r;
}

/** ذيل الجوال في SQL كمطابقة تطبيق المندوب والكاتب (ترجمة الأرقام الهندية ثم آخر ثمانية أرقام) — والحكم بعده بالمفتاح الكامل */
const PHONE_TAIL_SQL = Prisma.sql`right(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 8)`;

const productionDeps: ActivityDeps = {
  db: prisma as unknown as ActivityDb,
  customerScope: (req, tid) => customerScope(req, tid) as Promise<Record<string, unknown>>,
  recordScope: (req) => productionRecordScope(req),
  phoneCandidates: async (tid, key) => {
    const rows = await prisma.$queryRaw<CustomerCandidate[]>(Prisma.sql`
      SELECT id, name, phone, "createdAt" FROM customers
      WHERE "tenantId" = ${tid} AND status <> 'DELETED' AND ${PHONE_TAIL_SQL} = ${phoneTail(key)}
      LIMIT ${CATALOG_MATCH_LIMIT}`);
    return Array.isArray(rows) ? rows : [];
  },
};

router.use(createCustomerActivityRouter(productionDeps));
export default router;
