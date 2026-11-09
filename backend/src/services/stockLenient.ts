// ============================================================================
// «الربط لا يُرفض» في حركات المخزون (أمر المالك ٩ نوفمبر ٢٠٢٦): نقل البيانات والتكامل (مفتاح API من Odoo وغيره) لا يُرفض
// المستند كله بسطرٍ واحد — يُقبل ويُعالَج ما يمكن معالجته، ويُعاد ما تُرك أو عُدِّل تحذيراً في ردّ النجاح:
//   warnings: [{ code, message, index?, productId? }] — index موضع السطر في items كما أرسله العميل (من الصفر).
// يستعمله وارد المستودع وتسويته (routes/warehouse.ts POST /entries) وحركات السيارة (routes/vanStock.ts POST /loads).
// وصنفٌ ليس في الشركة لا يُرفض ولا يُترك: يُنشأ صنفٌ مؤقّت بمعرّفه نفسه (placeholderProducts) ما لم يكن المعرّف لشركةٍ أخرى.
//
// ما **لا** يتساهل فيه هذا الملف ولا مستدعوه (يمنع فساد الكمية الصامت): حارس وحدة الأساس للصنف المحوَّل (BASE_UNIT_REQUIRED
// وstaleClientBase)، وسباق PRODUCT_UNITS_CHANGED، ونقص رصيد التشغيلة في الإنقاص، وعزل الشركة والصلاحيات، ومنع التكرار clientRef.
// ولا يضرب كميةً بمعاملٍ مخمَّن: وحدةٌ غير صالحة تُقرأ أساساً **فقط** حين لا خطر تحويل، وإلا يُترك سطرها بتحذير.
// ============================================================================
import type { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { BASE_UNIT, UNIT_SELECT, type LineUnit, type UnitRow } from './warehouseStock';
import { baseNameKey, factorOf } from './units';

/** تحذيرٌ في ردّ النجاح — السطر لم يُرفض المستند به */
export interface StockWarning {
  code: string;
  message: string;
  /** موضع السطر في items كما أرسله العميل (من الصفر) */
  index?: number;
  productId?: string;
  /** PRODUCT_REDIRECTED: الصنف الحالي الذي سُجّل عليه السطر */
  toProductId?: string;
}

/** كل الأسطر صفرية: لا حركة ولا رفض */
export const noQuantitiesWarning = (): StockWarning => ({
  code: 'NO_QUANTITIES', message: 'لا توجد كميات صالحة — كل الأسطر بكمية صفر فلم تُسجَّل حركة',
});

/**
 * ردّ «لا شيء يُكتب» (200): كل الأسطر صفرية أو تُركت كلها بتحذير. data: null وnoop: true — لا حركة ولا مرجع clientRef محفوظ،
 * فإعادة الطلب نفسه تعيد الردّ نفسه بلا كتابة.
 */
export function stockNoopBody(warnings: StockWarning[]): { success: true; data: null; noop: true; warnings: StockWarning[] } {
  return { success: true, data: null, noop: true, warnings };
}

/** سطر حركةٍ كما يحتاجه الحكم: صنفه وموضعه في الطلب ووحدته وأساسه المُرسَل */
export interface LenientLine {
  productId: string;
  at: number;
  unitId?: string | null;
  baseUnitName?: string | null;
}

/** صنف السطر من قراءة المسار (أو توأمه الحيّ): الوجود والأرشفة والأساس والوحدات والتتبّع */
export interface LenientProduct {
  id: string;
  name: string;
  code: string;
  unit: string;
  deletedAt?: Date | null;
  baseConvertedAt?: Date | null;
  lotTracked?: boolean | null;
  units?: readonly { id?: string; name: string; factor: number; isActive?: boolean | null }[] | null;
}

const sentBase = (s: string | null | undefined): boolean => baseNameKey(s) !== '';
const codeKey = (s: string | null | undefined): string => String(s ?? '').toLowerCase();

// ═══ ١) صنفٌ لا يتبع الشركة ⇒ صنفٌ مؤقّت بالمعرّف نفسه، أو يُترك سطره ═══

/** معرّفٌ يصلح لصنفٍ مؤقّت: uuid أو رقمٌ أو رمزٌ لاتيني بلا مسافات حتى ١٢٨ حرفاً — وغيره (فارغ، نصٌّ حرّ، طويل) يُترك سطره */
const PLACEHOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** وحدة الأساس للصنف المؤقّت حين لا يرسل السطر baseUnitName */
export const PLACEHOLDER_UNIT = 'حبة';

/** رمز الصنف المؤقّت: P- وأول ثمانية أحرف من معرّفه بأحرفٍ كبيرة */
export const placeholderCodeOf = (id: string): string => `P-${id.slice(0, 8).toUpperCase()}`;

/** أول رمزٍ حرّ للصنف المؤقّت في الشركة (الرمز فريدٌ لكل شركة): الأساس، ثم -2…-99، ثم بذيل المعرّف */
export function freePlaceholderCode(id: string, taken: ReadonlySet<string>): string {
  const base = placeholderCodeOf(id);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${id.slice(-12).toUpperCase()}`;
}

const isUniqueViolation = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'P2002';

const notFound = (l: LenientLine): StockWarning => ({
  code: 'PRODUCT_NOT_FOUND', index: l.at, productId: l.productId,
  message: `صنف السطر ${l.at + 1} غير موجود في هذه الشركة ولا يصلح معرّفه لصنفٍ جديد — تُرك السطر وسُجّل الباقي`,
});

export interface PlaceholderOptions<L> {
  select: Prisma.ProductSelect;
  /** «تتبّع اللوط» مفعّل: الصنف المؤقّت غير متتبَّع، فتشغيلة سطره تُهمل بتحذير LOT_IGNORED لا 422 (D9) */
  lotsOn: boolean;
  carriesLot: (l: L) => boolean;
  stripLot: (l: L) => L;
}

/**
 * أمر المالك (٩ نوفمبر ٢٠٢٦): «محذوفٌ من قبل أو لا — اقبله». سطرٌ صنفه ليس في الشركة (حُذف حذفاً حقيقياً، أو لم يُرسل بعدُ من
 * نظام المُكامِل) ⇒ يُنشأ **صنفٌ مؤقّت بالمعرّف نفسه** فيُعالَج السطر عليه، بتحذير PRODUCT_PLACEHOLDER_CREATED — وحين يرسل المُكامِل
 * الصنف بعدها (PUT /api/products/:id) تُكتب بياناته على المؤقّت. الصنف المؤقّت: الرمز P-XXXXXXXX (حرٌّ في الشركة)، والاسم «صنف »
 * ورمزه، ووحدة الأساس baseUnitName السطر وإلا «حبة»، والسعر صفر، والضريبة نسبة الشركة الافتراضية (وإلا ١٥)، ونشط، بلا وحدات ولا تتبّع.
 *
 * عزل الشركات: معرّفٌ مستعمل لصنفٍ في شركةٍ أخرى لا يُمسّ ولا يُكشف — يُترك سطره بتحذير PRODUCT_NOT_FOUND بالنصّ نفسه لمعرّفٍ
 * لا يصلح. والسباق (طلبان متزامنان بالمعرّف نفسه) يحسمه قيد المفتاح: الخاسر يتجاهل التصادم ويقرأ ما كُتب.
 * الإنشاء خارج معاملة الحركة: إعادة الطلب نفسه تجد الصنف فلا تنشئه ثانيةً، ورفضٌ لاحق بحارسٍ باقٍ لا يمحوه.
 */
/** إنشاء صنفٍ مؤقّت لمعرّفٍ مجهول في حركة مخزون — مطفأ بأمر المالك (٩ نوفمبر ٢٠٢٦: الخادم لا يُنشئ شيئاً من عنده) */
export const stockLenientFlags = { placeholdersOn: false };

export async function placeholderProducts<L extends LenientLine, P extends LenientProduct>(
  tid: string, lines: readonly L[], products: readonly P[], opts: PlaceholderOptions<L>,
): Promise<{ lines: L[]; products: P[]; warnings: StockWarning[] }> {
  const have = new Set(products.map((p) => p.id));
  const unknown = lines.filter((l) => !have.has(l.productId));
  if (!unknown.length) return { lines: [...lines], products: [...products], warnings: [] };
  const valid = [...new Set(unknown.map((l) => l.productId).filter((id) => typeof id === 'string' && PLACEHOLDER_ID.test(id)))];
  // المعرّف في أي شركة (قراءة الوجود والشركة وحدهما) — لصنف شركةٍ أخرى لا يُنشأ شيء
  const taken = valid.length
    ? await prisma.product.findMany({ where: { id: { in: valid } }, select: { id: true, tenantId: true } })
    : [];
  const foreign = new Set(taken.filter((t) => t.tenantId !== tid).map((t) => t.id));
  // «الخادم لا يُنشئ شيئاً لأحد — يقبل النقل فقط» (أمر المالك ٩ نوفمبر ٢٠٢٦): الصنف المؤقّت مطفأ — سطر الصنف المجهول يُترك بتحذير
  // PRODUCT_NOT_FOUND وتُسجَّل بقية الأسطر. true يعيد الإنشاء
  const free = stockLenientFlags.placeholdersOn ? valid.filter((id) => !taken.some((t) => t.id === id)) : [];
  const created = new Set<string>();
  if (free.length) {
    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
    const taxPct = typeof company?.defaultVatPct === 'number' && Number.isFinite(company.defaultVatPct) ? company.defaultVatPct : 15;
    const bases = [...new Set(free.map(placeholderCodeOf))];
    const near = await prisma.product.findMany({ where: { tenantId: tid, OR: bases.map((b) => ({ code: { startsWith: b } })) }, select: { code: true } });
    const codes = new Set(near.map((p) => p.code).filter((c) => bases.some((b) => c.startsWith(b))));
    for (const id of free) {
      const sent = unknown.find((l) => l.productId === id && baseNameKey(l.baseUnitName) !== '')?.baseUnitName;
      const unit = sent ? sent.trim().replace(/\s+/g, ' ').slice(0, 64) : PLACEHOLDER_UNIT;
      for (let attempt = 0; attempt < 3 && !created.has(id); attempt++) {
        const code = freePlaceholderCode(id, codes);
        codes.add(code);
        try {
          await prisma.product.create({
            data: { id, tenantId: tid, code, name: `صنف ${code}`, unit, basePrice: 0, taxPct, status: 'ACTIVE' },
            select: { id: true },
          });
          created.add(id);
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          // طلبٌ متزامن أنشأ المعرّف نفسه قبلنا ⇒ القراءة أدناه تحسم (شركتنا ⇒ يُستعمل، وإلا يُترك السطر)؛ وإلا فالرمز أُخذ ⇒ التالي
          if ((await prisma.product.findMany({ where: { id: { in: [id] } }, select: { id: true } })).length) break;
        }
      }
    }
  }
  const ours = valid.filter((id) => !foreign.has(id));
  const rows = ours.length
    ? (await prisma.product.findMany({
      where: { id: { in: ours }, tenantId: tid },
      select: { ...opts.select, id: true, name: true, code: true, unit: true, deletedAt: true, baseConvertedAt: true, lotTracked: true, units: { select: UNIT_SELECT } },
    })) as unknown as P[]
    : [];
  const all = [...products, ...rows.filter((r) => !have.has(r.id))];
  const byId = new Map(all.map((p) => [p.id, p]));
  const out: L[] = [];
  const warnings: StockWarning[] = [];
  for (const l of lines) {
    if (have.has(l.productId)) { out.push(l); continue; }
    const p = byId.get(l.productId);
    if (!p) { warnings.push(notFound(l)); continue; }
    let line = l;
    if (created.has(l.productId)) {
      warnings.push({
        code: 'PRODUCT_PLACEHOLDER_CREATED', index: l.at, productId: l.productId,
        message: `صنف السطر ${l.at + 1} غير موجود فأُنشئ صنفٌ مؤقّت «${p.name}» بالمعرّف نفسه — أرسل بياناته (PUT /api/products/${l.productId})`,
      });
    }
    if (opts.lotsOn && p.lotTracked !== true && opts.carriesLot(l)) {
      line = opts.stripLot(l);
      warnings.push({
        code: 'LOT_IGNORED', index: l.at, productId: l.productId,
        message: `الصنف «${p.name}» غير متتبَّع بالتشغيلات (صنفٌ مؤقّت) — أُهملت بيانات التشغيلة في السطر ${l.at + 1}`,
      });
    }
    out.push(line);
  }
  return { lines: out, products: all, warnings };
}

// ═══ ٢) صنفٌ مؤرشف في وارد أو تحميل ⇒ توأمه الحيّ بالرمز نفسه، وإلا يُقبل عليه ═══

export interface ArchivedRedirectOptions<L> {
  /** مفتاح API: صنفٌ محوَّل بلا baseUnitName يُرفض BASE_UNIT_REQUIRED — فلا يُنقل إليه سطرٌ لم يكن ليُرفض */
  isApiKey: boolean;
  /** «تتبّع اللوط» مفعّل للشركة: السطر بتشغيلة لا يُنقل، ولا يُنقل بين متتبَّع وغير متتبَّع */
  lotsOn: boolean;
  carriesLot: (l: L) => boolean;
}

/**
 * لماذا لا يُنقل السطر إلى التوأم — null ⇒ يُنقل. كل شرطٍ يمنع أن يصير النقل رفضاً أو كميةً خاطئة لم تكن على الصنف المؤرشف:
 * أساسٌ بالاسم نفسه (الكمية بالأساس نفسه)، ووحدة السطر لها مقابلٌ بالمعامل نفسه، وحارس الأساس يمرّ على التوأم، ولا تشغيلة.
 * يعيد معرّف وحدة التوأم المقابلة (أو null للأساس) حين ينجح.
 */
export function twinRedirect<L extends LenientLine>(
  l: L, from: LenientProduct, to: LenientProduct, opts: ArchivedRedirectOptions<L>,
): { ok: true; unitId: string | null } | { ok: false } {
  if (baseNameKey(from.unit) !== baseNameKey(to.unit)) return { ok: false };
  if (to.baseConvertedAt != null) {
    if (sentBase(l.baseUnitName) && baseNameKey(l.baseUnitName) !== baseNameKey(to.unit)) return { ok: false };
    if (opts.isApiKey && !sentBase(l.baseUnitName)) return { ok: false };
  }
  if (opts.lotsOn && (opts.carriesLot(l) || !!from.lotTracked !== !!to.lotTracked)) return { ok: false };
  if (!l.unitId) return { ok: true, unitId: null };
  // وحدة السطر من وحدات المؤرشف (بمعرّفها) ⇒ وحدة التوأم بالمعامل نفسه (النشطة أولاً ثم بالاسم نفسه). غيرها ⇒ لا نقل
  const src = (from.units ?? []).find((u) => u.id != null && u.id === l.unitId);
  if (!src) return { ok: false };
  const f = factorOf({ unitFactor: src.factor });
  if (f === 1) return { ok: true, unitId: null };
  const same = (to.units ?? []).filter((u) => u.id != null && factorOf({ unitFactor: u.factor }) === f);
  const pick = same.find((u) => u.isActive !== false && baseNameKey(u.name) === baseNameKey(src.name))
    ?? same.find((u) => u.isActive !== false) ?? same.find((u) => baseNameKey(u.name) === baseNameKey(src.name)) ?? same[0];
  return pick?.id ? { ok: true, unitId: pick.id } : { ok: false };
}

/**
 * أسطر الصنف المؤرشف (deletedAt) في الحركة التي كانت تُرفض 422 PRODUCT_ARCHIVED (الوارد RECEIVE وتحميل السيارة LOAD): صنفٌ حيّ
 * واحدٌ برمزه نفسه (بلا اعتبار لحالة الأحرف) ⇒ يُسجَّل السطر عليه بتحذير PRODUCT_REDIRECTED؛ وإلا (لا توأم، أو أكثر من توأم،
 * أو النقل غير آمن — twinRedirect) ⇒ يُقبل على المؤرشف كما أُرسل بتحذير PRODUCT_ARCHIVED. `applies` يحدّد الأسطر المعنيّة
 * (الوارد الموجب وحده: السالب يصير تسوية إنقاص، والتسوية تمرّ على المؤرشف أصلاً).
 */
export function redirectArchivedLines<L extends LenientLine, P extends LenientProduct>(
  lines: readonly L[], byId: ReadonlyMap<string, P>, twins: readonly P[], applies: (l: L) => boolean, opts: ArchivedRedirectOptions<L>,
): { lines: L[]; targets: P[]; warnings: StockWarning[] } {
  const out: L[] = [];
  const targets = new Map<string, P>();
  const warnings: StockWarning[] = [];
  for (const l of lines) {
    const from = byId.get(l.productId);
    if (!from || from.deletedAt == null || !applies(l)) { out.push(l); continue; }
    const live = twins.filter((t) => t.id !== from.id && t.deletedAt == null && codeKey(t.code) === codeKey(from.code));
    const to = live.length === 1 ? live[0] : null;
    const r = to ? twinRedirect(l, from, to, opts) : { ok: false as const };
    if (to && r.ok) {
      targets.set(to.id, to);
      out.push({ ...l, productId: to.id, unitId: r.unitId });
      warnings.push({
        code: 'PRODUCT_REDIRECTED', index: l.at, productId: from.id, toProductId: to.id,
        message: `الصنف «${from.name}» محذوف (مؤرشف) — سُجّل السطر ${l.at + 1} على الصنف الحالي «${to.name}» بالرمز نفسه`,
      });
      continue;
    }
    out.push(l);
    warnings.push({
      code: 'PRODUCT_ARCHIVED', index: l.at, productId: from.id,
      message: `الصنف «${from.name}» محذوف (مؤرشف) — سُجّل السطر ${l.at + 1} عليه كما أُرسل، وصحّح رصيده بتسوية إن لزم`,
    });
  }
  return { lines: out, targets: [...targets.values()], warnings };
}

/**
 * أصنافٌ حيّة (deletedAt null) برموز الأصناف المؤرشفة — بلا اعتبار لحالة الأحرف (الرمز فريدٌ حرفياً فالتوأم الحرفيّ لا يوجد مع
 * المؤرشف). يُستدعى حين يكون في الحركة سطرٌ معنيّ على صنفٍ مؤرشف وحده، فالمسار الشائع بلا استعلامٍ زائد. والمطابقة تُعاد في الذاكرة
 * (redirectArchivedLines) فلا يُعتمد على مرشّح القاعدة وحده. `select` قراءة المسار نفسها ⇒ الصفّ بشكل أصنافه.
 */
export async function liveTwinsOf<P extends LenientProduct>(tid: string, archived: readonly LenientProduct[], select: Prisma.ProductSelect): Promise<P[]> {
  const codes = [...new Set(archived.map((p) => p.code).filter((c): c is string => typeof c === 'string' && c.length > 0))];
  if (!codes.length) return [];
  const rows = await prisma.product.findMany({
    where: { tenantId: tid, deletedAt: null, OR: codes.map((code) => ({ code: { equals: code, mode: 'insensitive' as const } })) },
    select: { ...select, id: true, name: true, code: true, unit: true, deletedAt: true, baseConvertedAt: true, lotTracked: true, units: { select: UNIT_SELECT } },
  });
  return rows as unknown as P[];
}

// ═══ ٣) وحدة البند غير الصالحة ═══

/**
 * وحدة بندٍ بلا رفض (نظير pickLineUnit في warehouseStock.ts، والصارم باقٍ لطلب البضاعة):
 *  - لا unitId ⇒ الأساس كما كان.
 *  - وحدةٌ من وحدات الصنف موقوفة ⇒ تُقبل **بمعاملها المسجَّل** بتحذير UNIT_INACTIVE (كإعادة الرفع أوف‑لاين): العميل سمّى الوحدة
 *    ومعاملها معروف، فالكمية بالأساس صحيحة — لا قراءتها أساساً (×معامل خطأ) ولا ترك السطر.
 *  - وحدةٌ لا تخصّ الصنف (لصنفٍ آخر أو مجهولة أو لشركةٍ أخرى) ⇒ لا يُعرف معاملها لهذا الصنف: تُقرأ أساساً بتحذير UNIT_FALLBACK_BASE
 *    **فقط** حين لا خطر تحويل — الصنف بلا وحدات أكبر ولم تُحوَّل وحدته، والوحدة الغريبة (إن عُرفت) بمعامل ١. وإلا يُترك السطر
 *    (unit: null) بتحذير UNIT_INVALID: «١٠ كراتين» لا تُكتب عشر حبّات بصمت.
 */
export function pickLineUnitLenient(
  rows: readonly UnitRow[],
  product: Pick<LenientProduct, 'units' | 'baseConvertedAt'> | undefined,
  productId: string, unitId: string | null | undefined, opts: { replay?: boolean } = {},
): { unit: LineUnit | null; warning?: { code: string; message: string } } {
  if (!unitId) return { unit: BASE_UNIT };
  const own = rows.find((x) => x.id === unitId && x.productId === productId);
  if (own) {
    const unit: LineUnit = { name: own.name, factor: factorOf({ unitFactor: own.factor }) };
    if (own.isActive === false && !opts.replay) {
      return { unit, warning: { code: 'UNIT_INACTIVE', message: `وحدة «${own.name}» موقوفة لهذا الصنف — سُجّلت الكمية بها كما أُرسلت (معاملها ${unit.factor})` } };
    }
    return { unit };
  }
  const foreign = rows.find((x) => x.id === unitId);
  const risk = (foreign != null && factorOf({ unitFactor: foreign.factor }) !== 1)
    || product?.baseConvertedAt != null
    // وحدات الصنف غير مقروءة ⇒ لا يُعرف أنه بلا وحدات أكبر: خطرٌ
    || product?.units == null
    || product.units.some((u) => factorOf({ unitFactor: u.factor }) !== 1);
  if (!risk) {
    return { unit: BASE_UNIT, warning: { code: 'UNIT_FALLBACK_BASE', message: 'الوحدة المرسلة ليست من وحدات الصنف، والصنف بوحدة أساسٍ وحدها — سُجّلت الكمية بوحدة الأساس' } };
  }
  return { unit: null, warning: { code: 'UNIT_INVALID', message: 'الوحدة المرسلة ليست من وحدات الصنف ولا يُعرف معاملها — تُرك السطر (حدّث قائمة الأصناف وأعد إرساله)' } };
}

/**
 * وحدات أسطر الحركة بلا رفض: استعلامٌ واحد كـresolveLineUnits (ولا استعلام حين لا يحمل سطرٌ وحدة)، ثم pickLineUnitLenient لكل سطر.
 * الأسطر المتروكة تخرج من `lines` ومن `units` معاً — فيبقى units[idx] وحدة items[idx] كما كان.
 */
export async function resolveLineUnitsLenient<L extends LenientLine>(
  tid: string, lines: readonly L[], productsById: ReadonlyMap<string, Pick<LenientProduct, 'units' | 'baseConvertedAt'>>, opts: { replay?: boolean } = {},
): Promise<{ lines: L[]; units: LineUnit[]; warnings: StockWarning[] }> {
  const ids = [...new Set(lines.map((l) => l.unitId).filter((x): x is string => typeof x === 'string' && !!x))];
  const rows: UnitRow[] = ids.length
    ? await prisma.productUnit.findMany({ where: { tenantId: tid, id: { in: ids } }, select: { id: true, productId: true, name: true, factor: true, isActive: true } })
    : [];
  const kept: L[] = [];
  const units: LineUnit[] = [];
  const warnings: StockWarning[] = [];
  for (const l of lines) {
    const r = pickLineUnitLenient(rows, productsById.get(l.productId), l.productId, l.unitId, opts);
    if (r.warning) warnings.push({ ...r.warning, index: l.at, productId: l.productId });
    if (!r.unit) continue;
    kept.push(l);
    units.push(r.unit);
  }
  return { lines: kept, units, warnings };
}

// ═══ المسار كله: الوجود ثم الأرشفة ثم الوحدة ═══

export interface LenientStockLinesOptions<L> extends ArchivedRedirectOptions<L>, PlaceholderOptions<L> {
  /** نوع الحركة الذي كان يرفض المؤرشف (RECEIVE أو LOAD) — null ⇒ المؤرشف يمرّ كما كان (التسوية والتنزيل والإزالة) */
  archived: 'RECEIVE' | 'LOAD' | null;
  /** الأسطر المعنيّة بحكم الأرشفة من حركةٍ نوعها `archived` — الافتراضي كلها */
  archivedApplies?: (l: L) => boolean;
  /** قراءة الأصناف في المسار — تُقرأ بها التوائم فيكون صفّها بشكل أصنافه */
  select: Prisma.ProductSelect;
  replay?: boolean;
}

/**
 * أسطر حركة المخزون بعد التساهل، بالترتيب: صنفٌ لا يتبع الشركة ⇒ صنفٌ مؤقّت بمعرّفه (أو يُترك سطره إن كان المعرّف لشركةٍ أخرى أو
 * لا يصلح)، ثم المؤرشف يُنقل إلى توأمه أو يُقبل، ثم الوحدة تُحلّ أو تُقرأ أساساً أو يُترك سطرها. يعيد الأسطر الباقية ووحداتها
 * (units[idx] لـlines[idx]) والأصناف (المقروءة + المؤقّتة + التوائم المستعملة) والتحذيرات بترتيبها. الأصناف تُقرأ **قبل** حلّ الوحدات
 * كما في المسارين (سباق التحويل يحرسه القفل بعدها).
 */
export async function lenientStockLines<L extends LenientLine, P extends LenientProduct>(
  tid: string, lines: readonly L[], products: readonly P[], opts: LenientStockLinesOptions<L>,
): Promise<{ lines: L[]; units: LineUnit[]; products: P[]; warnings: StockWarning[] }> {
  const warnings: StockWarning[] = [];
  const known = await placeholderProducts(tid, lines, products, opts);
  warnings.push(...known.warnings);
  let kept = known.lines;
  const all: P[] = [...known.products];
  if (opts.archived) {
    const byId = new Map(all.map((p) => [p.id, p]));
    const applies = opts.archivedApplies ?? (() => true);
    const archived = [...new Set(kept.filter((l) => applies(l) && byId.get(l.productId)?.deletedAt != null).map((l) => l.productId))]
      .map((id) => byId.get(id)!);
    if (archived.length) {
      const twins = await liveTwinsOf<P>(tid, archived, opts.select);
      const moved = redirectArchivedLines(kept, byId, twins, applies, opts);
      kept = moved.lines;
      warnings.push(...moved.warnings);
      for (const t of moved.targets) if (!byId.has(t.id)) all.push(t);
    }
  }
  const u = await resolveLineUnitsLenient(tid, kept, new Map(all.map((p) => [p.id, p])), { replay: opts.replay });
  warnings.push(...u.warnings);
  // أصناف الأسطر الباقية وحدها: مؤرشفٌ نُقلت كل أسطره، أو صنفٌ تُرك سطره، لا يُقفل ولا يدخل خطة اللوط ولا حارس الأساس
  const used = new Set(u.lines.map((l) => l.productId));
  return { lines: u.lines, units: u.units, products: all.filter((p) => used.has(p.id)), warnings };
}
