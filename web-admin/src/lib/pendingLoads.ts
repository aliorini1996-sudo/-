/**
 * «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — العقد المشترك بين لوحة الإدارة وتطبيق الإدارة على الجوال (/m)
 * وتطبيق المندوب. منطقٌ صرفٌ بلا React ولا عميل HTTP بعينه: كلٌّ يمرّر عميله (api للإدارة، repApi للمندوب) إلى pendingLoadsClient.
 *
 * - الميزة لكل شركة بمفتاحٍ في إعدادات الشركة (vanLoadAcceptance، مطفأ افتراضاً). مطفأة ⇒ لا جلب ولا قسم ولا نصّ: كل شيءٍ كما كان.
 * - مفعّلة: تحميل الإدارة (LOAD) من اللوحة أو /m لا يدخل سيارة المندوب — الخادم يحفظه «بانتظار قبول المندوب» ويردّ 201
 *   {success:true, pending:true, data:<الصفّ>} (isPendingLoadResponse). لا أثر على أي مخزون أو تقرير حتى يقبله المندوب ويوقّع.
 * - المندوب يقبل ويوقّع (PNG) فتُكتب الحركة كأن الإدارة سجّلتها لحظة القبول، أو يعترض بملاحظة فتعدّله الإدارة (PUT ⇒ PENDING
 *   بمراجعةٍ جديدة) أو تلغيه. والإشعار المطبوع للتحميل المقبول يحمل إقرار المندوب وتوقيعه ولحظة القبول (acceptanceOf).
 * - مسارات المعلّق كلها ترفض مفاتيح API (403 API_KEY_FORBIDDEN) وتعمل والجهاز متصل وحده.
 */

export type PendingLoadStatus = 'PENDING' | 'DISPUTED' | 'ACCEPTED' | 'CANCELLED';
export const PENDING_LOAD_STATUSES: readonly PendingLoadStatus[] = ['PENDING', 'DISPUTED', 'ACCEPTED', 'CANCELLED'];

/** تشغيلة سطرٍ معلّق — الكمية بالأساس (D22)؛ lotId null = الرصيد غير المسمّى */
export interface PendingLotView { lotId: string | null; lotNumber: string | null; expiryDate: string | null; qty: number }

/** سطر التحميل المعلّق كما يعرضه الخادم (pendingLinesView): الكمية بوحدة السطر، والأساس baseQty */
export interface PendingLineView {
  productId: string;
  name: string;
  code: string | null;
  qty: number;
  unitId: string | null;
  /** اسم وحدة السطر — وحدةٌ غائبة ⇒ الأساس */
  unitName: string;
  unitFactor: number;
  baseQty: number;
  /** «الوحدة الرئيسية» لصنف السطر — للعرض وحده */
  primaryUnitId: string | null;
  /** تشغيلةٌ جديدة مع تحميلٍ بلا مستودع (D4) — رقمها كما أُرسل */
  lotNumber: string | null;
  lots: PendingLotView[];
  /** موضع السطر في body.items (الخادم يرسله) — به يُطابَق السطر وبنده في التعديل؛ null لخادمٍ لا يرسله */
  idx: number | null;
  /** اسم وحدة الأساس للصنف */
  baseUnit: string | null;
  /** الصنف لم يعد موجوداً منذ الإرسال — القبول سيُرفض PENDING_LOAD_CHANGED */
  missing: boolean;
  /** وحدات الصنف الآن (id, name, factor, isActive) — لمنتقي الوحدة في التعديل */
  units: PendingUnitDef[];
}

/** وحدة صنفٍ كما يرسلها الخادم مع السطر — شكل UnitDef (lib/units) */
export interface PendingUnitDef { id: string; name: string; factor: number; isActive?: boolean }

/** بند جسم POST /van-stock/loads كما حفظه الخادم (بلا clientRef) — للإدارة وحدها، ومنه يبدأ التعديل */
export interface PendingBodyItem {
  productId: string; qty: number; unitId?: string | null; baseUnitName?: string | null;
  suggestedQty?: number; expectedQty?: number;
  lots?: { lotId: string | null; qty: number }[];
  lotNumber?: string; productionDate?: string | null; expiryDate?: string | null;
}
export interface PendingLoadBody { type?: string; salesRepId?: string; note?: string | null; items: PendingBodyItem[] }

export interface PendingVanLoadView {
  id: string;
  status: PendingLoadStatus;
  salesRepId: string | null;
  /** اسم المندوب الآن، وإلا لقطته وقت الإرسال */
  repName: string;
  revision: number;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string | null;
  disputeNote: string | null;
  disputedAt: string | null;
  acceptedAt: string | null;
  vanLoadId: string | null;
  cancelledAt: string | null;
  cancelledByName: string | null;
  /** صورة التوقيع (data:image/png) — في التفصيل، ولقائمة الإدارة بـwithSignature=1 وحده */
  signature: string | null;
  lines: PendingLineView[];
  /** جسم الطلب كما حُفظ — للإدارة وحدها (null للمندوب) */
  body: PendingLoadBody | null;
}

export interface PendingLoadCounts { pending: number; disputed: number }
export interface PendingLoadList { rows: PendingVanLoadView[]; counts: PendingLoadCounts }

/* ═══ قراءة الردود — متسامحةٌ مع الغياب، فلا تسقط الشاشة بحقلٍ ناقص ═══ */

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown, dflt = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
};
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** صورة توقيعٍ صالحة للعرض: PNG مضمّنٌ وحده (لا رابط خارجي ولا نوعٌ آخر) */
export const PNG_DATA_URL_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
export const safeSignature = (v: unknown): string | null => (typeof v === 'string' && PNG_DATA_URL_RE.test(v) ? v : null);

const asStatus = (v: unknown): PendingLoadStatus =>
  (PENDING_LOAD_STATUSES as readonly string[]).includes(String(v)) ? String(v) as PendingLoadStatus : 'PENDING';

function normalizeLots(raw: unknown): PendingLotView[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingLotView[] = [];
  for (const x of raw) {
    const r = rec(x);
    if (!r) continue;
    const lot = rec(r.lot);
    out.push({
      lotId: str(r.lotId),
      lotNumber: str(r.lotNumber) ?? str(lot?.lotNumber),
      expiryDate: str(r.expiryDate) ?? str(lot?.expiryDate),
      qty: round4(num(r.qty ?? r.baseQty)),
    });
  }
  return out;
}

function normalizeUnits(raw: unknown): PendingUnitDef[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingUnitDef[] = [];
  for (const x of raw) {
    const u = rec(x);
    const id = str(u?.id);
    const name = str(u?.name);
    const factor = num(u?.factor);
    if (!u || !id || !name || !(factor > 0)) continue;
    out.push({ id, name, factor, ...(typeof u.isActive === 'boolean' && { isActive: u.isActive }) });
  }
  return out;
}

/** سطرٌ من ردّ الخادم — الاسم من productName أو name أو product.name، والوحدة الغائبة أساسٌ بمعامل ١ */
export function normalizePendingLine(raw: unknown): PendingLineView | null {
  const r = rec(raw);
  if (!r) return null;
  const product = rec(r.product);
  const productId = str(r.productId) ?? str(product?.id);
  if (!productId) return null;
  const qty = num(r.qty);
  const unitFactor = num(r.unitFactor ?? r.factor, 1) || 1;
  return {
    productId,
    name: str(r.productName) ?? str(r.name) ?? str(product?.name) ?? '',
    code: str(r.productCode) ?? str(r.code) ?? str(product?.code),
    qty,
    unitId: str(r.unitId),
    unitName: str(r.unitName) ?? str(r.unit) ?? str(product?.unit) ?? '',
    unitFactor,
    baseQty: r.baseQty != null && Number.isFinite(Number(r.baseQty)) ? round4(Number(r.baseQty)) : round4(qty * unitFactor),
    primaryUnitId: str(r.primaryUnitId) ?? str(product?.primaryUnitId),
    lotNumber: str(r.lotNumber),
    lots: normalizeLots(r.lots),
    idx: Number.isInteger(r.idx) && (r.idx as number) >= 0 ? r.idx as number : null,
    // سطر الخادم: `unit` أساس الصنف و`unitName` وحدة السطر — وبلا unitName فـ`unit` وحدة السطر لا أساسه
    baseUnit: str(r.baseUnit) ?? str(r.baseUnitName) ?? (str(r.unitName) ? str(r.unit) : null) ?? str(product?.unit),
    missing: r.missing === true,
    units: normalizeUnits(r.units ?? product?.units),
  };
}

function normalizeBody(raw: unknown): PendingLoadBody | null {
  const b = rec(raw);
  if (!b || !Array.isArray(b.items)) return null;
  const items: PendingBodyItem[] = [];
  for (const x of b.items) {
    const i = rec(x);
    const productId = str(i?.productId);
    if (!i || !productId) continue;
    items.push({ ...(i as object), productId, qty: num(i.qty) } as PendingBodyItem);
  }
  return { ...(b as object), items } as PendingLoadBody;
}

/** صفّ المعلّق من الخادم — null لما ليس صفّاً (لا معرّف) */
export function normalizePendingLoad(raw: unknown): PendingVanLoadView | null {
  const r = rec(raw);
  const id = str(r?.id);
  if (!r || !id) return null;
  const salesRep = rec(r.salesRep);
  const body = normalizeBody(r.body);
  const lineSrc = Array.isArray(r.lines) ? r.lines : Array.isArray(r.items) ? r.items : [];
  let lines = lineSrc.map(normalizePendingLine).filter((l): l is PendingLineView => l !== null);
  // خادمٌ لم يرسل الأسطر (أو صفٌّ للإدارة بجسمه وحده): من الجسم بلا أسماء — أفضل من بطاقةٍ فارغة
  if (!lines.length && body) lines = body.items.map((i) => normalizePendingLine(i)).filter((l): l is PendingLineView => l !== null);
  return {
    id,
    status: asStatus(r.status),
    salesRepId: str(r.salesRepId),
    repName: str(salesRep?.name) ?? str(r.repName) ?? '',
    revision: Math.max(1, Math.trunc(num(r.revision, 1))),
    note: str(r.note),
    createdByName: str(r.createdByName),
    createdAt: str(r.createdAt) ?? '',
    updatedAt: str(r.updatedAt),
    disputeNote: str(r.disputeNote),
    disputedAt: str(r.disputedAt),
    acceptedAt: str(r.acceptedAt),
    vanLoadId: str(r.vanLoadId),
    cancelledAt: str(r.cancelledAt),
    cancelledByName: str(r.cancelledByName),
    signature: safeSignature(r.signature),
    lines: lines.filter((l) => l.qty !== 0),
    body,
  };
}

/** ردّ GET /van-stock/pending-loads: { data: [...], counts: { pending, disputed } } */
export function normalizePendingList(body: unknown): PendingLoadList {
  const b = rec(body);
  const data = Array.isArray(b?.data) ? b!.data as unknown[] : Array.isArray(body) ? body as unknown[] : [];
  const rows = data.map(normalizePendingLoad).filter((r): r is PendingVanLoadView => r !== null);
  const c = rec(b?.counts);
  return {
    rows,
    counts: {
      pending: c ? num(c.pending) : rows.filter((r) => r.status === 'PENDING').length,
      disputed: c ? num(c.disputed) : rows.filter((r) => r.status === 'DISPUTED').length,
    },
  };
}

/** ما يُعرض في قسم «تحميلات بانتظار القبول»: المفتوحة (الاعتراض أولاً ثم الأحدث) ثم المقبولة حديثاً بالأحدث قبولاً */
export function pendingSections(rows: readonly PendingVanLoadView[]): { open: PendingVanLoadView[]; accepted: PendingVanLoadView[] } {
  const t = (s: string | null) => (s ? Date.parse(s) || 0 : 0);
  const open = rows.filter((r) => r.status === 'PENDING' || r.status === 'DISPUTED')
    .sort((a, b) => (a.status === b.status ? t(b.createdAt) - t(a.createdAt) : a.status === 'DISPUTED' ? -1 : 1));
  const accepted = rows.filter((r) => r.status === 'ACCEPTED').sort((a, b) => t(b.acceptedAt) - t(a.acceptedAt));
  return { open, accepted };
}

/** هل ردّ POST /van-stock/loads «أُرسل للمندوب بانتظار قبوله» لا حركةٌ كُتبت؟ (ومنه إعادة المرجع نفسه 200 pending) */
export function isPendingLoadResponse(res: unknown): boolean {
  const d = rec(rec(res)?.data);
  return d?.pending === true;
}

/** علم الشركة من ردّ GET /company — غيابه (خادمٌ أقدم) إطفاء */
export const vanLoadAcceptanceOn = (company: unknown): boolean => rec(company)?.vanLoadAcceptance === true;

/* ═══ نصوص الواجهة — مفاتيح القاموس (strings.ts PHRASES)، واختبار pendingLoads.test.ts يحرس ترجمتها بالأربع ═══ */

export const PENDING_STATUS_LABELS: Record<PendingLoadStatus, string> = {
  PENDING: 'بانتظار قبول المندوب',
  DISPUTED: 'اعترض المندوب',
  ACCEPTED: 'قبله المندوب ووقع',
  CANCELLED: 'ألغي',
};
/** لون وسم الحالة (صنف Tailwind) — كهرماني للانتظار، أحمر للاعتراض، أخضر للمقبول، رمادي للملغى */
export const PENDING_STATUS_TONES: Record<PendingLoadStatus, string> = {
  PENDING: 'text-amber-800 bg-amber-50 border-amber-200',
  DISPUTED: 'text-red-700 bg-red-50 border-red-200',
  ACCEPTED: 'text-[#1E7A52] bg-[#E4F1EA] border-[#cfe8db]',
  CANCELLED: 'text-gray-500 bg-gray-50 border-gray-200',
};

export const PENDING_LOAD_TEXT = {
  /** بعد إرسال الإدارة والميزة مفعّلة (ردّ pending:true) */
  sent: 'أُرسل التحميل للمندوب بانتظار قبوله وتوقيعه',
  /** تلميح نافذة التحميل والميزة مفعّلة */
  hint: 'التحميل يرسل للمندوب ولا يدخل سيارته ولا يخرج من المستودع حتى يقبله ويوقع عليه',
  section: 'تحميلات بانتظار القبول',
  empty: 'لا تحميلات بانتظار القبول',
  disputeNote: 'ملاحظة المندوب',
  edited: 'عدل التحميل وأعيد للمندوب بانتظار قبوله',
  cancelled: 'ألغي التحميل المرسل',
  cancelConfirm: 'إلغاء هذا التحميل المرسل؟ لن يصل للمندوب ولن يمس المخزون',
  editTitle: 'تعديل تحميل مرسل للمندوب',
  editLoadOnly: 'التحميل المرسل للمندوب كميات موجبة فقط — للتنزيل سجل حركة منفصلة',
  acceptedAt: 'وقت القبول',
  signedBadge: 'موقع من المندوب',
  /** «الإصدار ٢»: عدّلته الإدارة بعد إرساله (revision) — لا «مراجعة» (ترجمتها Review) */
  revised: 'الإصدار',
  /** الإقرار المطبوع على إشعار التحميل المقبول — {name} اسم المندوب */
  declaration: 'أقرّ أنا المندوب {name} باستلام البضاعة الموضحة أعلاه',
  declarationTitle: 'إقرار استلام المندوب',
  settingTitle: 'اشتراط قبول المندوب للتحميل وتوقيعه',
  settingHint: 'تحميل الإدارة يصل المندوب فيراجعه ويقبله ويوقع عليه قبل أن يدخل سيارته — والإشعار الموقع إثبات للتحميل وإقرار باستلامه',
  settingOn: 'فعل اشتراط قبول المندوب للتحميل',
  settingOff: 'أوقف اشتراط قبول المندوب — التحميل يدخل السيارة فور حفظه',
  /** لمدير الشركة الذي يحاول الإيقاف: المفتوح يُحسم أولاً — المعلّق يقبله مندوبه أو يُلغى، والمعترض عليه يُعدَّل فيُقبل أو يُلغى */
  settingOpen: 'لا يمكن إيقاف الميزة ما دامت تحميلات بانتظار قبول المناديب أو معترضا عليها — يحسم كل تحميل أولا بقبول مندوبه له أو بإلغائه',
  /** تعديل الإدارة لتحميلٍ تغيّر منذ فُتح المحرّر (عُدّل من جهازٍ آخر أو اختفى) — عبارةٌ للإدارة لا «وقّع من جديد» */
  editStale: 'تغيّر هذا التحميل منذ فتحته — أعد فتحه من «تحميلات بانتظار القبول»',
  /** اعترض المندوب بعد فتح المحرّر (409 PENDING_LOAD_DISPUTED) — العبارة نفسها التي يرسلها الخادم */
  editDisputed: 'اعترض المندوب على هذا التحميل بعد فتحك له — راجع ملاحظته ثم أعد فتحه من «تحميلات بانتظار القبول»',
} as const;

/**
 * رسائل الخادم برموزها (PENDING_LOAD_MESSAGES في backend/src/services/vanPendingLoads.ts ورموز مسار الإعداد) — العبارة نفسها
 * مفتاح القاموس، فتُعرض مترجمةً بلغة الواجهة ولو أرسل الخادم العربية. رمزٌ مجهول ⇒ رسالة الخادم كما هي.
 */
export const PENDING_LOAD_MESSAGES: Readonly<Record<string, string>> = {
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
  VAN_LOAD_ACCEPTANCE_SCOPED: 'حسابك مقيد بنطاق محدد — هذا الإعداد للشركة كلها',
  VAN_LOAD_ACCEPTANCE_ADMIN_ONLY: 'اشتراط قبول المندوب للتحميل لمدير الشركة وحده',
  VAN_LOAD_ACCEPTANCE_INVALID: 'قيمة الإعداد غير صحيحة — enabled: true أو false',
  VAN_LOAD_ACCEPTANCE_OPEN_LOADS: 'توجد تحميلات بانتظار قبول المناديب أو معترض عليها — لا تتوقف الميزة حتى يقبلها المناديب أو تلغيها',
  COMPANY_SETTINGS_MISSING: 'احفظ بيانات الشركة أولا',
};

/** رمز خطأ المعلّق وحالته ورسالته من خطأ axios — null لخطأٍ بلا ردّ (انقطاع) */
export function pendingLoadErrorOf(e: unknown): { status: number; code: string | null; message: string | null; body: Rec } | null {
  const r = rec(rec(e)?.response);
  if (!r) return null;
  const body = rec(r.data) ?? {};
  return { status: num(r.status), code: str(body.code), message: str(body.message), body };
}

/** نصّ الخطأ للمستخدم مترجماً: رمزٌ معروف ⇒ عبارته، وإلا رسالة الخادم (مترجمةً إن كانت في القاموس)، وإلا البديل */
export function pendingErrorText(e: unknown, tr: (ar: string) => string, fallback: string): string {
  const err = pendingLoadErrorOf(e);
  // مفتاحٌ من الكائن نفسه لا من نموذجه: رمزٌ مثل «toString» كان يعيد دالةً بدل النصّ
  if (err?.code && Object.prototype.hasOwnProperty.call(PENDING_LOAD_MESSAGES, err.code)) return tr(PENDING_LOAD_MESSAGES[err.code]);
  return err?.message ? tr(err.message) : tr(fallback);
}

/**
 * أصناف الأسطر التي «ستتغيّر عند التسجيل» من ردّ الرفض (422 PENDING_LOAD_LINES_CHANGED عند الإرسال أو التعديل، و409 PENDING_LOAD_CHANGED
 * عند القبول): warnings[].productId بلا تكرار — بها تُسمّى الأسطر في رسالة الرفض فيعرف المدير ما يراجع. غيرها (أو بلا warnings) ⇒ []
 */
export function pendingChangedProductIds(e: unknown): string[] {
  const w = pendingLoadErrorOf(e)?.body.warnings;
  if (!Array.isArray(w)) return [];
  return [...new Set(w.map((x) => str(rec(x)?.productId)).filter((v): v is string => v !== null))];
}

/** نصّ الرفض (pendingErrorText) وبعده أسماء أصناف الأسطر المتغيّرة إن عُرفت — «… — سكر، أرز» */
export function pendingRefusalText(e: unknown, tr: (ar: string) => string, fallback: string, nameOf: (productId: string) => string | null | undefined): string {
  const names = pendingChangedProductIds(e).map((id) => (nameOf(id) ?? '').trim()).filter(Boolean);
  const text = pendingErrorText(e, tr, fallback);
  return names.length ? `${text} — ${[...new Set(names)].join('، ')}` : text;
}

/** رموز رفض تعديل الإدارة التي تعني أن التحميل تغيّر منذ فُتح المحرّر — مراجعته قديمة فكل إعادةٍ منه تُرفض */
export const PENDING_EDIT_STALE_CODES: ReadonlySet<string> = new Set([
  'PENDING_LOAD_REVISED', 'PENDING_LOAD_DISPUTED', 'PENDING_LOAD_ACCEPTED', 'PENDING_LOAD_CANCELLED', 'PENDING_LOAD_NOT_FOUND',
]);

/**
 * رفض تعديل الإدارة لأن التحميل تغيّر منذ فُتح المحرّر ⇒ نصٌّ للإدارة (لا عبارة المندوب «… ثم وقّع من جديد» التي يحملها
 * PENDING_LOAD_REVISED)، فيُغلق المحرّر وتُعاد القائمة: المقبول والملغى بعبارتيهما، والاعتراض بملاحظة المندوب من الصفّ المردود،
 * وما سواهما «تغيّر منذ فتحته». غير ذلك (أو انقطاع) ⇒ null فيُعرض الرفض المعتاد ويبقى المحرّر
 */
export function pendingEditStaleText(e: unknown, tr: (ar: string) => string): string | null {
  const err = pendingLoadErrorOf(e);
  if (!err?.code || !PENDING_EDIT_STALE_CODES.has(err.code)) return null;
  if (err.code === 'PENDING_LOAD_ACCEPTED' || err.code === 'PENDING_LOAD_CANCELLED') return tr(PENDING_LOAD_MESSAGES[err.code]);
  if (err.code === 'PENDING_LOAD_DISPUTED') {
    const text = tr(PENDING_LOAD_TEXT.editDisputed);
    const note = str(rec(err.body.data)?.disputeNote);
    return note ? `${text} — ${tr(PENDING_LOAD_TEXT.disputeNote)}: ${note}` : text;
  }
  return tr(PENDING_LOAD_TEXT.editStale);
}

/* ═══ الإشعار المطبوع ═══ */

/** إقرار المندوب على إشعار التحميل المقبول — يطبعه PrintableLoadNotice تحت الأصناف */
export interface LoadNoticeAcceptance { repName: string; signature: string; acceptedAt: string }

/** الإقرار من صفّ مقبولٍ بتوقيعٍ صالح ولحظة قبول — وإلا null فيُطبع الإشعار كما كان حرفاً */
export function acceptanceOf(view: Pick<PendingVanLoadView, 'status' | 'signature' | 'acceptedAt' | 'repName'> | null | undefined, repName?: string): LoadNoticeAcceptance | null {
  if (!view || view.status !== 'ACCEPTED') return null;
  const signature = safeSignature(view.signature);
  if (!signature || !view.acceptedAt) return null;
  return { repName: (repName ?? view.repName ?? '').trim() || view.repName, signature, acceptedAt: view.acceptedAt };
}

/** جملة الإقرار بعد ترجمتها: {name} ⇒ اسم المندوب */
export const acceptanceSentence = (translated: string, repName: string): string => translated.split('{name}').join(repName || '—');

/** بند حركة الإشعار (عقد loadNoticeDocFromData) */
export interface NoticeMovementItem {
  name: string; qty: number; unit?: string; unitName?: string | null; unitFactor?: number | null; baseQty?: number | null;
  primaryUnitId?: string | null; lots?: unknown;
}
export interface NoticeMovement { kind: string; date: string; ref?: string; by?: string | null; items: NoticeMovementItem[] }

/**
 * حركة إشعار التحميل المقبول: من الحركة التي كتبها القبول (vanLoad في GET /pending-loads/:id — لقطة وحدة كل بند وتشغيلاته كما
 * سُحبت)، وإلا من أسطر المعلّق نفسها (الوثيقة التي وقّعها المندوب). والتاريخ لحظة القبول.
 */
export function noticeMovementOf(view: PendingVanLoadView, vanLoad?: unknown): NoticeMovement {
  const vl = rec(vanLoad);
  const date = view.acceptedAt ?? str(vl?.createdAt) ?? view.createdAt;
  const ref = str(vl?.note) ?? view.note ?? '';
  if (vl && Array.isArray(vl.items) && vl.items.length) {
    return {
      kind: 'LOAD', date, ref, by: str(vl.createdBy),
      items: (vl.items as unknown[]).map((x) => {
        const i = rec(x) ?? {};
        const p = rec(i.product) ?? {};
        return {
          name: str(p.name) ?? '', qty: num(i.qty), unit: str(i.unitName) ?? str(p.unit) ?? undefined, unitName: str(i.unitName),
          unitFactor: i.unitFactor == null ? null : num(i.unitFactor, 1), baseQty: i.baseQty == null ? null : num(i.baseQty),
          primaryUnitId: str(p.primaryUnitId), lots: i.lots,
        };
      }),
    };
  }
  return {
    kind: 'LOAD', date, ref, by: 'ADMIN',
    items: view.lines.map((l) => ({
      name: l.name, qty: l.qty, unit: l.unitName || undefined, unitName: l.unitName || null, unitFactor: l.unitFactor, baseQty: l.baseQty,
      primaryUnitId: l.primaryUnitId,
      // صفوف التشغيلات بشكل VanLoadItemLotDto الذي يقرؤه docLotsFrom
      lots: l.lots.length ? l.lots.map((x) => ({ lotId: x.lotId, qty: x.qty, lot: x.lotId ? { lotNumber: x.lotNumber, expiryDate: x.expiryDate } : null })) : undefined,
    })),
  };
}

/* ═══ التعديل ═══ */

/** سطرٌ محايد لنموذج التعديل (اللوحة و/m يبنيان صفّهما منه): الاسم والوحدة من أسطر العرض، والباقي من الجسم كما حُفظ */
export interface PendingEditLine {
  productId: string; name: string; unitId: string | null; unitName: string; unitFactor: number;
  /** أساس الصنف كما أرسله النموذج (baseUnitName في الجسم)، وإلا أساسه في سطر العرض */
  baseUnitName: string | null;
  /** وحدات الصنف الآن ورئيسيته (من سطر العرض) — لمنتقي الوحدة وعرض الرصيد */
  units: PendingUnitDef[]; primaryUnitId: string | null;
  qty: number; suggestedQty?: number; expectedQty?: number;
  lots?: { lotId: string | null; qty: number }[];
  lotNumber?: string; productionDate?: string | null; expiryDate?: string | null;
}

export function pendingEditLines(view: PendingVanLoadView): PendingEditLine[] {
  const items = view.body?.items ?? view.lines.map((l) => ({ productId: l.productId, qty: l.qty, unitId: l.unitId } as PendingBodyItem));
  const used = new Set<number>();
  const byIdx = view.body ? new Map(view.lines.filter((l) => l.idx !== null).map((l) => [l.idx as number, l])) : new Map<number, PendingLineView>();
  return items.map((i, at) => ({ i, at })).filter(({ i }) => num(i.qty) > 0).map(({ i, at }) => {
    // سطر العرض المطابق: بموضعه في الجسم (idx من الخادم)، وإلا بالصنف والوحدة — صنفٌ في سطرين بوحدتين لا يأخذ اسم وحدة غيره
    let l = byIdx.get(at);
    if (!l) {
      const k = view.lines.findIndex((x, n) => !used.has(n) && x.productId === i.productId && (x.unitId ?? null) === (i.unitId ?? null));
      if (k >= 0) { used.add(k); l = view.lines[k]; }
    }
    return {
      productId: i.productId, name: l?.name ?? '', unitId: i.unitId ?? null, unitName: l?.unitName ?? '', unitFactor: l?.unitFactor ?? 1,
      baseUnitName: i.baseUnitName ?? l?.baseUnit ?? null, units: l?.units ?? [], primaryUnitId: l?.primaryUnitId ?? null, qty: num(i.qty),
      ...(i.suggestedQty != null && { suggestedQty: i.suggestedQty }),
      ...(i.expectedQty != null && { expectedQty: i.expectedQty }),
      ...(Array.isArray(i.lots) && i.lots.length && { lots: i.lots.map((x) => ({ lotId: x.lotId ?? null, qty: num(x.qty) })) }),
      ...(i.lotNumber && { lotNumber: i.lotNumber }),
      ...(i.productionDate !== undefined && { productionDate: i.productionDate }),
      ...(i.expiryDate !== undefined && { expiryDate: i.expiryDate }),
    };
  });
}

/**
 * جسم PUT /van-stock/pending-loads/:id — جسم التحميل نفسه بمراجعة الصفّ التي بدأ منها التعديل، ولحظته (updatedAt) كما فُتح عليها:
 * اعترض المندوب بعدها ⇒ 409 PENDING_LOAD_DISPUTED فلا يُمحى اعتراضٌ لم يره الإداري
 */
export interface PendingEditBody {
  type: 'LOAD'; salesRepId: string; note?: string; revision: number; updatedAt?: string;
  items: PendingBodyItem[];
}

/* ═══ العميل — أيّ عميلٍ بشكل axios (api للإدارة، repApi للمندوب) ═══ */

export interface HttpLike {
  /** background: طلبٌ خلفيّ لعميل المندوب (repApi) — فشله العابر بـ401 لا يُخرج الجلسة؛ وعميل الإدارة يتجاهله */
  get(url: string, config?: { params?: Record<string, unknown>; background?: boolean }): Promise<{ data: unknown; status?: number }>;
  post(url: string, body?: unknown): Promise<{ data: unknown; status?: number }>;
  put(url: string, body?: unknown): Promise<{ data: unknown; status?: number }>;
}

export interface PendingListParams {
  /** open = PENDING وDISPUTED؛ وبلا status: المفتوحة ثم المقبولة حديثاً */
  status?: 'open' | PendingLoadStatus;
  /** للإدارة وحدها — المندوب يرى ما له */
  salesRepId?: string;
  /** صور التوقيع في صفوف المقبولة (للإدارة) */
  withSignature?: boolean;
  limit?: number;
}

export interface PendingAcceptBody { signature: string; revision: number; lat?: number; lng?: number }

const P = '/van-stock/pending-loads';
const one = (id: string) => `${P}/${encodeURIComponent(id)}`;

/** خيارات الطلب لا وسائطه — background لعدّاد بطاقة المندوب (طلبٌ تلقائي لا فعلٌ منه) */
export interface PendingRequestOpts { background?: boolean }

export function pendingLoadsClient(http: HttpLike) {
  return {
    list: (params: PendingListParams = {}, opts: PendingRequestOpts = {}) => http.get(P, {
      params: {
        ...(params.status && { status: params.status }),
        ...(params.salesRepId && { salesRepId: params.salesRepId }),
        ...(params.withSignature && { withSignature: '1' }),
        ...(params.limit && { limit: params.limit }),
      },
      ...(opts.background && { background: true }),
    }),
    get: (id: string) => http.get(one(id)),
    accept: (id: string, body: PendingAcceptBody) => http.post(`${one(id)}/accept`, body),
    dispute: (id: string, note: string) => http.post(`${one(id)}/dispute`, { note }),
    update: (id: string, body: PendingEditBody) => http.put(one(id), body),
    cancel: (id: string, reason?: string) => http.post(`${one(id)}/cancel`, reason ? { reason } : {}),
  };
}
export type PendingLoadsClient = ReturnType<typeof pendingLoadsClient>;

/** القائمة مقروءةً (صفوفٌ وعدّادات) */
export async function fetchPendingList(client: PendingLoadsClient, params?: PendingListParams, opts?: PendingRequestOpts): Promise<PendingLoadList> {
  return normalizePendingList((await client.list(params, opts)).data);
}

/** صفٌّ واحد بتوقيعه، والحركة التي كتبها القبول إن وُجدت (لإشعاره) */
export async function fetchPendingDetail(client: PendingLoadsClient, id: string): Promise<{ view: PendingVanLoadView; vanLoad: unknown } | null> {
  const body = rec((await client.get(id)).data);
  const data = rec(body?.data) ?? body;
  const view = normalizePendingLoad(data);
  return view ? { view, vanLoad: data?.vanLoad ?? null } : null;
}

/** مفتاح ذاكرة القائمة — البادئة وحدها تُبطل كل نطاقاتها (اللوحة كلها، ومندوبٌ في /m) */
export const PENDING_LOADS_KEY = 'pending-van-loads';
