/**
 * مراجعة المخزون (طلب المالك ٤ نوفمبر ٢٠٢٦: «اصلح المشاكل»، ثم «التحميل فوق رصيد المستودع يمنع») — شاشات السيارات:
 * منطقٌ صرف بلا React ولا شبكة (vanStockFlags.test.ts). وكل كميةٍ هنا **بالأساس** كما يردّها الخادم.
 *  · حالة الصنف من صفوف الخادم (`status`/`archived` اختياريان): «محذوف» يغلب «موقوف»، وغيابهما (خادمٌ أقدم) ⇒ بلا وسم.
 *  · «اسم مكرر»: اسمٌ (بعد تطبيعه) لأكثر من صنف — القديم والجديد يُميَّزان بالكود.
 *  · منتقي التحميل: المحذوف لا يُحمَّل (D3، الخادم يردّه 422 PRODUCT_ARCHIVED) ويبقى للتنزيل ما دام له رصيدٌ في السيارة.
 *  · التحميل فوق رصيد المستودع **منعٌ** (D2: 422 WAREHOUSE_INSUFFICIENT، والمستودع مفعّل وحده) — الواجهة تسبقه بالمتاح لكل سطر،
 *    والتنزيل فوق رصيد السيارة تأكيدٌ صريح (#4).
 *  · clientRef (D8): مرجعٌ لكل محاولة حفظ يُعاد مع الإعادة — فإعادة الإرسال بعد ضياع الردّ تعود بالحركة نفسها لا بثانية.
 */
import { newUuid } from './uuid';
import { productNameKey as sharedNameKey } from './productGuards';

export type ProductFlag = 'ARCHIVED' | 'INACTIVE';

/** وسم الحالة — مفتاحا القاموس */
export const PRODUCT_FLAG_LABELS: Record<ProductFlag, string> = { ARCHIVED: 'محذوف', INACTIVE: 'موقوف' };

type FlagSrc = { status?: unknown; archived?: unknown; deletedAt?: unknown } | null | undefined;

/** «محذوف» (archived أو deletedAt) يغلب «موقوف» (INACTIVE) — والحقول الغائبة بلا وسم */
export function productFlagOf(p: FlagSrc): ProductFlag | null {
  if (!p) return null;
  if (p.archived === true || (p.deletedAt != null && p.deletedAt !== '')) return 'ARCHIVED';
  if (p.status === 'INACTIVE') return 'INACTIVE';
  return null;
}

/**
 * مفتاح الاسم للمقارنة — مفتاح الخادم نفسه (backend/src/services/productNames.ts عبر lib/productGuards): قصٌّ ودمج مسافاتٍ وحروفٌ
 * لاتينية بلا حالة، بلا تطبيعٍ للعربية — فوسم «اسم مكرر» هنا يظهر حيث حذّر الإنشاء نفسه، لا لاسمٍ يشبهه فقط (المراجعة UX4)
 */
export function productNameKey(name: unknown): string {
  return sharedNameKey(typeof name === 'string' ? name : String(name ?? ''));
}

/** معرّفات الأصناف التي يشاركها اسمَها صنفٌ آخر — المعرّف نفسه مرّتين (صفّ السيارة وصفّ الكتالوج) صنفٌ واحد لا تكرار */
export function dupNameIds(items: ReadonlyArray<{ id: string; name?: string | null } | null | undefined>): Set<string> {
  const byKey = new Map<string, Set<string>>();
  for (const it of items) {
    if (!it?.id) continue;
    const k = productNameKey(it.name);
    if (!k) continue;
    const ids = byKey.get(k) ?? new Set<string>();
    ids.add(it.id);
    byKey.set(k, ids);
  }
  const out = new Set<string>();
  for (const ids of byKey.values()) if (ids.size > 1) ids.forEach(id => out.add(id));
  return out;
}

/** «اسم مكرر — كود X» — مفتاح القاموس، و{code} يُملأ بعد الترجمة */
export const DUP_NAME_TEXT = 'اسم مكرر — كود {code}';
export const fillCode = (translated: string, code: string | null | undefined): string => translated.split('{code}').join(code || '—');

/** صنفٌ في منتقي حركة السيارة: الكتالوج أو صفّ سيارةٍ محذوفٌ صنفُه */
export interface PickEntry<P> {
  p: P;
  flag: ProductFlag | null;
  dup: boolean;
  /** محذوفٌ برصيدٍ في السيارة: يُضاف تنزيلاً وحده (D3) */
  unloadOnly: boolean;
}

/**
 * قائمة منتقي «تحميل / تنقيص»: الكتالوج (/products بلا المحذوف أصلاً، والموقوف فيه موسوماً ويُحمَّل كما كان)، ثم أصناف السيارة
 * المحذوفة التي ما زال لها متاحٌ فيها — للتنزيل وحده. محذوفٌ بلا رصيدٍ في السيارة لا يُعرض (لا تحميل له ولا ما يُنزَّل).
 * والتكرار يُحسب على القائمة كلها: «M» القديم المحذوف في السيارة و«M» الجديد في الكتالوج كلاهما «اسم مكرر».
 */
export function vanPickList<P extends { id: string; name: string; status?: unknown; archived?: unknown; deletedAt?: unknown }>(
  catalog: ReadonlyArray<P>,
  vanRows: ReadonlyArray<P & { remaining?: number | null }>,
): PickEntry<P>[] {
  const inVan = new Map(vanRows.map(r => [r.id, r]));
  const out: PickEntry<P>[] = [];
  const seen = new Set<string>();
  for (const p of catalog) {
    seen.add(p.id);
    const flag = productFlagOf(p) ?? productFlagOf(inVan.get(p.id));
    if (flag === 'ARCHIVED' && !((inVan.get(p.id)?.remaining ?? 0) > 1e-9)) continue;
    out.push({ p, flag, dup: false, unloadOnly: flag === 'ARCHIVED' });
  }
  for (const r of vanRows) {
    if (seen.has(r.id) || productFlagOf(r) !== 'ARCHIVED' || !((r.remaining ?? 0) > 1e-9)) continue;
    seen.add(r.id);
    out.push({ p: r, flag: 'ARCHIVED', dup: false, unloadOnly: true });
  }
  const dups = dupNameIds([...catalog, ...vanRows]);
  return out.map(e => (dups.has(e.p.id) ? { ...e, dup: true } : e));
}

/** سطر حركةٍ بوحدته: الكمية بإشارتها (موجب تحميل، سالب تنزيل) ومعامل وحدته */
export interface MoveLine { productId: string; qty: number; factor?: number | null }

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** مجموع كل صنفٍ بالأساس في اتجاهٍ واحد — 'load' للموجب و'unload' للسالب بقيمته المطلقة؛ والأصفار وغير الرقم تسقط */
export function baseByProduct(lines: ReadonlyArray<MoveLine>, dir: 'load' | 'unload'): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    const q = Number(l.qty);
    if (!Number.isFinite(q) || q === 0 || (dir === 'load' ? q < 0 : q > 0)) continue;
    const f = Number(l.factor) > 0 ? Number(l.factor) : 1;
    m.set(l.productId, r4((m.get(l.productId) ?? 0) + Math.abs(q) * f));
  }
  return m;
}

export interface OverLine { productId: string; wantBase: number; haveBase: number }

/**
 * التنزيل فوق رصيد السيارة (#4): الخادم يقبله لغير المتتبَّع فتصير السيارة سالبة ويزيد المستودع بما ليس فيه — فيُطلب تأكيدٌ
 * صريح قبل الحفظ. الرصيد المتاح بالأساس من /van-stock/current (غائبٌ = صفر)، وأسطر الصنف الواحد تُجمع.
 */
export function unloadOverVan(lines: ReadonlyArray<MoveLine>, remainingOf: (productId: string) => number | null | undefined): OverLine[] {
  const out: OverLine[] = [];
  for (const [productId, wantBase] of baseByProduct(lines, 'unload')) {
    const haveBase = Number(remainingOf(productId)) || 0;
    if (wantBase > haveBase + 1e-9) out.push({ productId, wantBase, haveBase });
  }
  return out;
}

/**
 * التحميل فوق المتاح في المستودع (D2): **منعٌ** — أسطر الصنف الواحد تُجمع، وصنفٌ رصيده صفرٌ أو سالب لا يُحمَّل منه شيء. المستودع غير
 * معروف (null: مطفأ أو لم يُجلب أو تعذّر) ⇒ لا حكم هنا والخادم الحَكَم. وصنفٌ بلا صفٍّ في المستودع = صفر (كحساب الخادم).
 */
export function loadOverWarehouse(lines: ReadonlyArray<MoveLine>, availOf: ReadonlyMap<string, number> | null, partial = false): OverLine[] {
  return overAvailable(lines, availOf, partial);
}

/**
 * الكميات الموجبة بالأساس لكل صنف فوق متاحه (غائبٌ = صفر) — المتاح غير معروف (null) ⇒ لا حكم. `partial`: الخريطة جزئية (ما ردّه
 * الخادم في 422 وحده وصفوف المستودع لم تصل) ⇒ الغائب منها لا حكم عليه لا صفر (المراجعة UX6)
 */
export function overAvailable(lines: ReadonlyArray<MoveLine>, availOf: ReadonlyMap<string, number> | null, partial = false): OverLine[] {
  if (!availOf) return [];
  const out: OverLine[] = [];
  for (const [productId, wantBase] of baseByProduct(lines, 'load')) {
    if (partial && !availOf.has(productId)) continue;
    const haveBase = availOf.get(productId) ?? 0;
    if (wantBase > haveBase + 1e-9) out.push({ productId, wantBase, haveBase });
  }
  return out;
}

/** متبقّي كل صنفٍ في السيارة بالأساس من صفوف /van-stock/current (`remaining`) — شكلٌ غير متوقَّع ⇒ null (لا حكم) */
export function vanRemainingOf(rows: unknown): Map<string, number> | null {
  if (!Array.isArray(rows)) return null;
  const m = new Map<string, number>();
  for (const r of rows) {
    const row = r as { productId?: unknown; remaining?: unknown } | null;
    const n = Number(row?.remaining);
    if (typeof row?.productId === 'string' && Number.isFinite(n)) m.set(row.productId, n);
  }
  return m;
}

/** متاح كل صنفٍ في المستودع بالأساس من صفوف GET /warehouse (`onHand`) — شكلٌ غير متوقَّع ⇒ null (لا حكم) */
export function warehouseAvailOf(rows: unknown): Map<string, number> | null {
  if (!Array.isArray(rows)) return null;
  const m = new Map<string, number>();
  for (const r of rows) {
    const row = r as { productId?: unknown; onHand?: unknown } | null;
    const n = Number(row?.onHand);
    if (typeof row?.productId === 'string' && Number.isFinite(n)) m.set(row.productId, n);
  }
  return m;
}

/** متاحٌ يغلب فيه ما ردّه الخادم في 422 (أحدث من صفوف المستودع المخزّنة) — حتى تصل الصفوف من جديد */
export function withServerAvail(avail: ReadonlyMap<string, number> | null, server: ReadonlyMap<string, number>): Map<string, number> | null {
  if (!avail) return server.size ? new Map(server) : null;
  const m = new Map(avail);
  server.forEach((v, k) => m.set(k, v));
  return m;
}

/** سطر ردّ 422 WAREHOUSE_INSUFFICIENT: موضع البند في الطلب وصنفه ومتاحه وطلبه بالأساس */
export interface WarehouseInsufficientLine { index: number | null; productId: string; availableBase: number; requestedBase: number }

type ErrBody = { response?: { status?: number; data?: Record<string, unknown> | null } } | null | undefined;
const bodyOf = (e: unknown) => (e as ErrBody)?.response?.data ?? null;

/**
 * رفض الخادم تحميلاً فوق رصيد المستودع (D2: 422 WAREHOUSE_INSUFFICIENT) — رسالته وأسطره (الصنف مرةً واحدة)، ولا شيء كُتب.
 * غيره ⇒ null.
 */
export function warehouseInsufficientOf(e: unknown): { message: string; lines: WarehouseInsufficientLine[] } | null {
  const d = bodyOf(e);
  if (!d || d.code !== 'WAREHOUSE_INSUFFICIENT') return null;
  const seen = new Set<string>();
  const lines: WarehouseInsufficientLine[] = [];
  for (const raw of Array.isArray(d.lines) ? d.lines : []) {
    const x = raw as Partial<WarehouseInsufficientLine> | null;
    if (!x || typeof x.productId !== 'string' || seen.has(x.productId)) continue;
    seen.add(x.productId);
    lines.push({
      index: typeof x.index === 'number' ? x.index : null, productId: x.productId,
      availableBase: Number(x.availableBase) || 0, requestedBase: Number(x.requestedBase) || 0,
    });
  }
  return { message: typeof d.message === 'string' ? d.message : '', lines };
}

/** رفض الخادم تحميلَ صنفٍ محذوف (D3: 422 PRODUCT_ARCHIVED) — الصنف وموضع سطره في الطلب ورسالته */
export function archivedErrorOf(e: unknown): { productId: string | null; index: number | null; message: string } | null {
  const d = bodyOf(e);
  if (!d || d.code !== 'PRODUCT_ARCHIVED') return null;
  return {
    productId: typeof d.productId === 'string' ? d.productId : null,
    index: typeof d.index === 'number' ? d.index : null,
    message: typeof d.message === 'string' ? d.message : '',
  };
}

/** مجاميع ملخّص المندوب كما يردّها GET /van-stock/summary — totalDeficit/deficitCount/totalExpired إضافاتٌ قد تغيب (خادمٌ أقدم) */
export interface RepSummaryTotals { totalRemaining: number; totalDeficit?: number | null; deficitCount?: number | null; totalExpired?: number | null }

/**
 * #10: «المتبقي» ما في السيارة فعلاً (مجموع الموجب) والعجز منفصلاً بالأحمر — كان الصافي يطرح عجز صنفٍ (بيعٌ بلا مخزون) من بضاعة
 * صنفٍ آخر فتظهر سيارةٌ فيها 40 «0». الخادم يُبقي totalRemaining صافياً بإشارته ويضيف totalDeficit (مقدار العجز)، فالموجب =
 * الصافي + العجز. وخادمٌ بلا totalDeficit ⇒ الصافي كما كان بلا سطر عجز (deficit = 0).
 */
export function repRemainingView(r: RepSummaryTotals): { onVan: number; deficit: number; deficitCount: number } {
  const net = Number(r.totalRemaining) || 0;
  const d = Number(r.totalDeficit);
  if (r.totalDeficit == null || !Number.isFinite(d)) return { onVan: net, deficit: 0, deficitCount: 0 };
  const deficit = Math.max(0, Math.abs(d));
  return { onVan: r4(net + deficit), deficit, deficitCount: Math.max(0, Number(r.deficitCount) || 0) };
}

/** مجاميع صفوف سيارةٍ واحدة (/van-stock/current) بالقاعدة نفسها: الأصناف برصيدٍ موجب ومجموعها، والعجز ومقداره، ولا يُباع (منتهٍ وتالف موجبان) */
export function vanRowsTotals(rows: ReadonlyArray<{ remaining?: number | null; expired?: number | null; damaged?: number | null }> | null | undefined): {
  products: number; onVan: number; deficitCount: number; deficit: number; expired: number; damaged: number;
} {
  let products = 0, onVan = 0, deficitCount = 0, deficit = 0, expired = 0, damaged = 0;
  for (const r of rows ?? []) {
    const n = Number(r?.remaining) || 0;
    if (n > 1e-9) { products += 1; onVan += n; } else if (n < -1e-9) { deficitCount += 1; deficit += -n; }
    expired += Math.max(0, Number(r?.expired) || 0);
    damaged += Math.max(0, Number(r?.damaged) || 0);
  }
  return { products, onVan: r4(onVan), deficitCount, deficit: r4(deficit), expired: r4(expired), damaged: r4(damaged) };
}

/* ═══ clientRef (D8): مرجعٌ لكل محاولة حفظ ═══
 * المرجع مربوطٌ بمحتوى المستند: إعادة الضغط بالمحتوى نفسه (بعد انقطاعٍ ضاع فيه الردّ) تحمل المرجع نفسه فيعيد الخادم الحركة
 * الأولى بـ200 ولا يكتب شيئاً، وتعديل الأسطر مستندٌ آخر بمرجعٍ جديد. وبعد النجاح يُنسى المرجع: تحميلٌ ثانٍ مقصودٌ بالكميات
 * نفسها حركةٌ جديدة لا «إعادة». والمستند المقسوم (تحميل + تنزيل) مرجعان، لكلٍّ محتواه. */

export interface RefMemo { sig: string; ref: string }

/** بصمة المستند للمقارنة — JSON بترتيب مفاتيحه كما بُني (البناء واحدٌ في الشاشة فالترتيب ثابت) */
export const moveSig = (body: unknown): string => JSON.stringify(body ?? null);

/** مرجع المحاولة: المحفوظ إن طابقت البصمة، وإلا مرجعٌ جديد (uuid ≤ 64 من [A-Za-z0-9-]) */
export function refFor(memo: RefMemo | null | undefined, body: unknown, gen: () => string = newUuid): RefMemo {
  const sig = moveSig(body);
  return memo && memo.sig === sig ? memo : { sig, ref: gen() };
}

/** الجسم ومعه clientRef — النوع كما هو (العميل لا يصف الحقل بعد، والخادم يقبله اختيارياً) */
export function withClientRef<B extends object>(body: B, clientRef: string): B {
  return { ...body, clientRef } as B;
}

/** خطأٌ بلا جوابٍ حاسم من الخادم (انقطاعٌ أو مهلة، أو 5xx من الوكيل أو الخادم) — قد تكون الحركة كُتبت ولم يصل ردّها */
export function isIndeterminateError(e: unknown): boolean {
  const r = (e as ErrBody)?.response;
  if (!r) return true;
  return typeof r.status === 'number' && r.status >= 500;
}

/**
 * D8 بعد ضياع الردّ (المراجعة F1): الإرسال، فإن لم يأتِ جوابٌ حاسم سُئل الخادم عن المرجع نفسه (GET ?clientRef=) — موجودٌ ⇒ ردّ
 * إعادةٍ (200 replay) كأنّ الإعادة نجحت فلا تُكتب الحركة ثانيةً؛ غائبٌ أو تعذّر السؤال ⇒ يُرمى الخطأ الأصلي (والمرجع باقٍ للإعادة).
 * `lookup` يعيد صفوف القائمة بذلك المرجع.
 */
export async function sendWithRefRecovery<R>(send: () => Promise<R>, lookup: () => Promise<unknown>): Promise<R | { status: 200; data: { success: true; data: unknown; replay: true; recovered: true } }> {
  try {
    return await send();
  } catch (e) {
    if (!isIndeterminateError(e)) throw e;
    let found: unknown = null;
    try { found = await lookup(); } catch { found = null; }
    if (Array.isArray(found) && found.length > 0) return { status: 200, data: { success: true, data: found[0], replay: true, recovered: true } };
    throw e;
  }
}

/** ردّ إعادةٍ لمستندٍ سبق حفظه بالمرجع نفسه: 200 بدل 201 (أو علم replay/idempotent في الجسم) — الحركة الأولى لا ثانية */
export function isReplayResponse(res: unknown): boolean {
  const r = res as { status?: number; data?: { replay?: unknown; idempotent?: unknown } | null } | null | undefined;
  return r?.status === 200 || r?.data?.replay === true || r?.data?.idempotent === true;
}

/* ═══ «حركة البضاعة» (#11) ═══
 * المرتجع الذي لا يعود للمخزون لا «+» له، والمرتجع المنتهي يدخل رصيد «منتهي الصلاحية» لا المتاح، والإلغاء حركةٌ عكسية بتاريخه.
 * الخادم يسمّيها بأنواعٍ إضافية (أو يعلّم RETURN بـreturnToStock=false / returnExpired) — وخادمٌ أقدم بأنواعه القائمة كما كان. */

export type MovementKey =
  | 'LOAD' | 'SALE' | 'RETURN' | 'RETURN_DAMAGED' | 'EXPIRED_OUT' | 'DAMAGED_OUT' | 'UNLOAD' | 'ADJUST'
  | 'RETURN_NO_STOCK' | 'RETURN_EXPIRED' | 'SALE_CANCELLED' | 'RETURN_CANCELLED';

const KIND_ALIASES: Record<string, MovementKey> = {
  RETURN_NO_STOCK: 'RETURN_NO_STOCK', RETURN_NOT_RESTOCKED: 'RETURN_NO_STOCK', RETURN_NO_RESTOCK: 'RETURN_NO_STOCK',
  RETURN_EXPIRED: 'RETURN_EXPIRED',
  SALE_CANCELLED: 'SALE_CANCELLED', SALE_CANCEL: 'SALE_CANCELLED', CANCEL_SALE: 'SALE_CANCELLED',
  RETURN_CANCELLED: 'RETURN_CANCELLED', RETURN_CANCEL: 'RETURN_CANCELLED', CANCEL_RETURN: 'RETURN_CANCELLED',
};
const KNOWN: ReadonlySet<string> = new Set(['LOAD', 'SALE', 'RETURN', 'RETURN_DAMAGED', 'EXPIRED_OUT', 'DAMAGED_OUT', 'UNLOAD', 'ADJUST']);

/** مفتاح عرض الحركة: الأنواع الإضافية بأسمائها، والمرتجع الموسوم بلا عودةٍ أو منتهياً كذلك؛ ونوعٌ مجهول ⇒ تسوية (إشارتها من الكمية) */
export function movementKey(m: { kind?: unknown; returnToStock?: unknown; returnExpired?: unknown }): MovementKey {
  const k = String(m?.kind ?? '');
  if (KIND_ALIASES[k]) return KIND_ALIASES[k];
  if (k === 'RETURN' && m.returnToStock === false) return 'RETURN_NO_STOCK';
  if (k === 'RETURN' && m.returnExpired === true) return 'RETURN_EXPIRED';
  return (KNOWN.has(k) ? k : 'ADJUST') as MovementKey;
}

/** نصوص الحركة الإضافية وإشاراتها — مفاتيح القاموس؛ و'' إشارةٌ محايدة (لا أثر على المتاح) */
export const EXTRA_KIND_META: Record<'RETURN_NO_STOCK' | 'RETURN_EXPIRED' | 'SALE_CANCELLED' | 'RETURN_CANCELLED', { label: string; sign: string }> = {
  RETURN_NO_STOCK: { label: 'مرتجع لا يعود للمخزون', sign: '' },
  RETURN_EXPIRED: { label: 'مرتجع منتهي الصلاحية', sign: '+' },
  SALE_CANCELLED: { label: 'إلغاء بيع', sign: '+' },
  RETURN_CANCELLED: { label: 'إلغاء مرتجع', sign: '−' },
};

/** نصوص الحركة — مفاتيح القاموس، و{names} يُملأ بأسماء الأصناف بعد الترجمة */
export const VAN_MOVE_TEXT = {
  whInsufficient: 'التحميل أكبر من المتاح في المستودع ولم يحفظ: {names}',
  whLine: 'أكثر من المتاح في المستودع لا يحفظ التحميل',
  whPending: 'جار جلب رصيد المستودع',
  archived: 'صنف محذوف لا يحمل للسيارة — نزّل رصيده منها فقط: {names}',
  unloadOver: 'التنزيل أكبر من رصيد السيارة: {names} — ستصير السيارة سالبة ويزيد المستودع بما ليس فيه',
  replay: 'سبق حفظ هذه الحركة فلم تسجل مرة ثانية',
  archivedLine: 'صنف محذوف لا يحمل للسيارة — نزّل رصيده منها فقط',
  uncertain: 'لم يصل رد الحفظ السابق — احفظ مرة أخرى بالمحتوى نفسه ولن تسجل الحركة مرتين',
} as const;
export const fillNames = (translated: string, names: ReadonlyArray<string>): string => translated.split('{names}').join(names.filter(Boolean).join('، ') || '—');
