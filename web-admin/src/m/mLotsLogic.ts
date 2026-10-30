// ============================================================================
// «تتبّع اللوط» في تطبيق الإدارة على الجوال (/m) — منطقٌ صرف تختبره mLotsLogic.test.ts.
// ----------------------------------------------------------------------------
// الاسم ليس mLots.ts عمداً: نظام ملفات ويندوز وماك لا يفرّق حالة الأحرف، فيحلّ './MLots' (الشاشة) إلى './mLots' فيكسر
// الاستيراد الكسول في القوقعة — والحارس في الاختبار.
// الشاشات (MWarehouse وMRepLoad وMLots وMInvoiceCreate وMProducts) ترسم وتستدعي، وهنا وحدها:
//  - هويّة السطر (rowId): صنفٌ متتبَّع قد يحتاج سطرين بالوحدة نفسها (تشغيلتان في وارد واحد)، فمفتاح (الصنف، الوحدة)
//    لا يكفي — والصنف غير المتتبَّع يبقى على منع التكرار القائم حرفاً.
//  - مسودّة تشغيلة السطر (اختيار قائمة، أو جديدة برقمٍ وتاريخين، أو «غير مسمى») وخيارات منتقيها لكل وضع وتحقّقها وحقول جسمها.
//  - مصادر التنزيل من السيارة وتوزيعها الأوّلي (الموقوف والمنتهي أولاً: هو ما يُنزَّل في السحب)، وأسطر إنقاص الصنف الواحد
//    على متاحٍ مشترك (D26) — في السيارة والمستودع.
//  - شاشة التشغيلات (MLots): معاملات البحث، وسبب الإيقاف، وخطة التنزيل، وأضعف يقين للعميل، ورابط الاتصال.
//  - متاح الأصناف المتتبَّعة في سيارة المندوب لفاتورة الإدارة (تنبيهٌ قبل الإصدار، والخادم يمنع).
// تشغيلات البنود على الأوراق يضمّها بانيها نفسه (rep/RepDocuments.tsx: invoiceDocFromDetail وloadNoticeDocFromData
// وwarehouseNoticeDocFromEntry)، فلا نسخة هنا: الشاشة تجلب السجل بتشغيلاته (withLots) وتمرّره كما هو.
// كل كمية هنا **بوحدة الأساس** (D22)، والخادم صاحب القرار: هذه للعرض والتحقق المسبق وحدهما.
// ============================================================================

import {
  LOT_EPS, LOT_BUCKETS, roundLot, normalizeLotNumber, lotDatesProblem, isLotExpiredOn, fefoCompare, lotDay, lotRowsProblem,
  type LotRef, type VanLotSnapshotDto, type LotStatus, type LotBlockKind, type LotCertainty, type LotListParams,
  type LotUnloadPlanDto, type LotTraceDto, type LotBucket, type PlaceLotViewDto,
} from '../lib/lots';
import { qtyText } from './mUnits';
import type { UnitDef } from '../lib/units';

let seq = 0;
/** معرّف سطرٍ محلّي فريد في الجلسة — مفتاح React وهدف التعديل والحذف */
export function newRowId(): string {
  seq += 1;
  return `r${Date.now().toString(36)}${seq.toString(36)}`;
}

/** الكمية الأساسية المطلقة لسطرٍ بوحدته (المعامل التالف ١) — بأربع خانات كرصيد الصنف */
export function lineBaseQty(qty: number, unitFactor: number | null | undefined): number {
  const f = Number(unitFactor);
  const q = Number(qty);
  if (!Number.isFinite(q)) return 0;
  return roundLot(Math.abs(q) * (Number.isFinite(f) && f > 0 ? f : 1));
}

/** صلاحية الصنف مكتملة (shelfLifeOf في الخادم): مفعّلة بمدّة صحيحة موجبة ⇒ انتهاء التشغيلة الجديدة إلزامي */
export function shelfLifeOn(p: { shelfLifeEnabled?: boolean | null; shelfLifeValue?: number | null; shelfLifeUnit?: string | null } | null | undefined): boolean {
  if (!p?.shelfLifeEnabled) return false;
  const v = Number(p.shelfLifeValue);
  return Number.isInteger(v) && v > 0 && ['DAY', 'MONTH', 'YEAR'].includes(String(p.shelfLifeUnit));
}

/**
 * صلاحية صنف السطر حين تُنشأ له تشغيلة: المعروفة عند إضافته (قائمة الأصناف) أولى، ثم المجلوبة ببطاقته (أسطر مخزون السيارة
 * والاقتراح لا تحملها)، والمجهولة **إلزاميةٌ** — المجهول لا يقرّر أن الانتهاء اختياري فيرفضه الخادم بعد الحفظ
 * (LOT_EXPIRY_REQUIRED). والانتهاء المكتوب لصنفٍ بلا صلاحية مقبولٌ في الخادم، فالاحتياط لا يمنع صحيحاً.
 */
export const resolveShelfOn = (known: boolean | undefined, fetched: boolean | undefined): boolean => known ?? fetched ?? true;

/** صنفٌ متتبَّع فعلاً في الواجهة: علم الشركة وعلم الصنف معاً (المطفأة تُخفي ولا تحذف، D8) */
export const isTracked = (lotOn: boolean, p: { lotTracked?: boolean | null } | null | undefined): boolean =>
  lotOn && p?.lotTracked === true;

/**
 * أسطر اقتراح FEFO لصنفٍ في أسطره (GET /lots/fefo?lines=): «كمية:معامل» مفصولةً بفاصلة، والكمية **أساسية** بأربع خانات —
 * الخادم يوزّع الأسطر من متاحٍ مشترك بقاعدة الكرتون، فلا يأخذ اقتراحان مستقلّان التشغيلة نفسها. الأصفار تسقط.
 */
export function fefoLinesParam(lines: readonly { qty: number; unitFactor?: number | null }[]): string {
  return lines
    .map(l => ({ q: lineBaseQty(l.qty, l.unitFactor), f: Number(l.unitFactor) > 0 ? Number(l.unitFactor) : 1 }))
    .filter(l => l.q > LOT_EPS)
    .map(l => `${l.q}:${l.f}`)
    .join(',');
}

// ═══════════════ مسودّة تشغيلة السطر (الوارد والتسوية والتحميل بلا مستودع) ═══════════════

/** pick: '' لم يُختر (الخادم يختار المصدر الوحيد في النقص) · 'NEW' تشغيلة جديدة · 'UNNAMED' غير مسمّى صراحةً · وإلا معرّف لوط */
export interface LotDraft { pick: string; lotNumber: string; productionDate: string; expiryDate: string }
export const emptyLotDraft = (): LotDraft => ({ pick: '', lotNumber: '', productionDate: '', expiryDate: '' });

/**
 * ما يُسمح به لكل حركة:
 *  - IN_STRICT: وارد المستودع — تشغيلةٌ قائمة أو جديدة، لا «غير مسمّى» (§٤.٤ RECEIVE: LOT_REQUIRED). الموقوفة تُقبل بتحذير.
 *  - IN: تسويةٌ بالزيادة — قائمة أو جديدة أو «غير مسمّى» صريح. الموقوفة تُقبل بتحذير LOT_INTO_BLOCKED.
 *  - LOAD: تحميلٌ في شركة بلا مستودع (D4) — كـIN، إلا أن الموقوفة والمنتهية يوم الشركة لا تُحمَّل (I4: LOT_BLOCKED، LOT_EXPIRED).
 *  - OUT: تسوية نقص — قائمة (من المصادر) أو «غير مسمّى» أو بلا اختيار فيختار الخادم المصدر الوحيد (D10).
 */
export type LotDraftMode = 'IN_STRICT' | 'IN' | 'LOAD' | 'OUT';

/**
 * رسائل مشكلة المسودّة — مفاتيح قاموسٍ تمرّ إلى tr(متغيّر)، فلا يلتقطها حارس langs.test ولا missing_keys (يقرآن
 * نداءات tr الحرفية وحدها). لذلك هي هنا ثوابت، واختبار mLotsLogic.test.ts يحرس أن لكلٍّ منها ترجمةً بالأربع.
 */
export const LOT_DRAFT_PROBLEMS = {
  PICK: 'اختر التشغيلة أو أضف تشغيلة جديدة',
  RECEIVE_NEEDS_LOT: 'الوارد يلزمه رقم تشغيلة',
  OUT_NEEDS_SOURCE: 'اختر التشغيلة التي ينقص منها الرصيد',
  NUMBER: 'اكتب رقم التشغيلة',
  EXPIRY_REQUIRED: 'تاريخ الانتهاء إلزامي لصنف له صلاحية',
  DATES: 'تاريخ الإنتاج يجب أن يسبق تاريخ الانتهاء',
  EXPIRED_LOAD: 'التشغيلة المنتهية لا تحمل في السيارة',
} as const;

/**
 * رسالة المشكلة (مفتاح قاموس) أو null — مرآة قواعد الخادم قبل الإرسال. `day` يوم الشركة (لقطة السيارة): في LOAD تشغيلةٌ
 * جديدة انتهاؤها قبله يرفضها الخادم بعد إنشائها (I4: LOT_EXPIRED) كما يرفض المنتهية من القائمة؛ وبلا يومٍ لا حكم.
 */
export function lotDraftProblem(d: LotDraft, mode: LotDraftMode, opts: { shelfOn: boolean; day?: string | null }): string | null {
  if (d.pick === '') return mode === 'OUT' ? null : LOT_DRAFT_PROBLEMS.PICK;
  if (d.pick === 'UNNAMED') return mode === 'IN_STRICT' ? LOT_DRAFT_PROBLEMS.RECEIVE_NEEDS_LOT : null;
  if (d.pick === 'NEW') {
    if (mode === 'OUT') return LOT_DRAFT_PROBLEMS.OUT_NEEDS_SOURCE;
    if (!normalizeLotNumber(d.lotNumber)) return LOT_DRAFT_PROBLEMS.NUMBER;
    const p = lotDatesProblem(d.productionDate || null, d.expiryDate || null, { expiryRequired: opts.shelfOn });
    if (p === 'LOT_EXPIRY_REQUIRED') return LOT_DRAFT_PROBLEMS.EXPIRY_REQUIRED;
    if (p) return LOT_DRAFT_PROBLEMS.DATES;
    if (mode === 'LOAD' && opts.day && isLotExpiredOn({ expiryDate: d.expiryDate || null }, opts.day)) return LOT_DRAFT_PROBLEMS.EXPIRED_LOAD;
  }
  return null;
}

/** حقول تشغيلة سطر الوارد أو التسوية (warehouseApi.createEntry): سطرٌ = تشغيلةٌ واحدة */
export function entryLotFields(d: LotDraft): { lotId?: string | null; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } {
  if (d.pick === '') return {};
  if (d.pick === 'UNNAMED') return { lotId: null };
  if (d.pick === 'NEW') {
    return { lotNumber: normalizeLotNumber(d.lotNumber) ?? d.lotNumber.trim(), productionDate: d.productionDate || null, expiryDate: d.expiryDate || null };
  }
  return { lotId: d.pick };
}

/**
 * حقول تشغيلة سطر التحميل في شركة بلا مستودع (D4، vanStockApi.createLoad): القائمة والـ«غير مسمّى» صفٌّ صريح بكمية السطر
 * الأساسية، والجديدة رقمٌ وتاريخان يُنشئها الخادم بمصدر LOAD.
 */
export function loadLotFields(d: LotDraft, baseQty: number): { lots?: LotRef[]; lotNumber?: string; productionDate?: string | null; expiryDate?: string | null } {
  if (d.pick === '') return {};
  if (d.pick === 'NEW') {
    return { lotNumber: normalizeLotNumber(d.lotNumber) ?? d.lotNumber.trim(), productionDate: d.productionDate || null, expiryDate: d.expiryDate || null };
  }
  return { lots: [{ lotId: d.pick === 'UNNAMED' ? null : d.pick, qty: roundLot(baseQty) }] };
}

/** خيارٌ في منتقي تشغيلة السطر (MLotFields) — value معرّف لوط، أو 'NEW'، أو 'UNNAMED' */
export interface LotPickChoice {
  value: string; kind: 'LOT' | 'NEW' | 'UNNAMED';
  lotNumber: string | null; expiryDate: string | null;
  blocked: boolean; expired: boolean;
  /** النقص وحده: صالح المصدر بالأساس */
  usable: number | null;
  /** يُعرض ولا يُختار — تحميل السيارة (I4): الموقوفة والمنتهية يوم الشركة لا تُحمَّل */
  disabled: boolean;
}

/**
 * خيارات المنتقي لكل وضع — مرآة الخادم قبل الإرسال:
 *  - OUT: مصادر المستودع بصالحها (> EPS، أيّاً كانت حالتها: الإتلاف من هنا)، ثم «غير مسمى» إن كان له صالح.
 *  - غيره: تشغيلات الصنف بوسم الموقوفة والمنتهية، ثم «تشغيلة جديدة»، ثم «غير مسمى» (لا في الوارد). وفي LOAD الموقوفة
 *    والمنتهية معطّلة: الخادم يرفضهما (LOT_BLOCKED، LOT_EXPIRED) فلا تُعرضان قابلتين للاختيار.
 */
export function lotPickChoices(
  mode: LotDraftMode,
  src: {
    lots?: readonly { id: string; lotNumber: string; expiryDate: string | null; status: LotStatus }[] | null;
    view?: PlaceLotViewDto | null;
  },
  day: string,
): LotPickChoice[] {
  if (mode === 'OUT') {
    const v = src.view;
    const named: LotPickChoice[] = (v?.lots ?? [])
      .filter(l => l.usable.SELLABLE > LOT_EPS)
      .map(l => ({
        value: l.lotId, kind: 'LOT', lotNumber: l.meta.lotNumber, expiryDate: lotDay(l.meta.expiryDate),
        blocked: l.meta.status === 'BLOCKED', expired: isLotExpiredOn(l.meta, day), usable: roundLot(l.usable.SELLABLE), disabled: false,
      }));
    const uu = roundLot(v?.unknownUsable?.SELLABLE ?? 0);
    return uu > LOT_EPS
      ? [...named, { value: 'UNNAMED', kind: 'UNNAMED', lotNumber: null, expiryDate: null, blocked: false, expired: false, usable: uu, disabled: false }]
      : named;
  }
  const out: LotPickChoice[] = (src.lots ?? []).map(l => {
    const blocked = l.status === 'BLOCKED';
    const expired = isLotExpiredOn(l, day);
    return {
      value: l.id, kind: 'LOT', lotNumber: l.lotNumber, expiryDate: lotDay(l.expiryDate), blocked, expired, usable: null,
      disabled: mode === 'LOAD' && (blocked || expired),
    };
  });
  out.push({ value: 'NEW', kind: 'NEW', lotNumber: null, expiryDate: null, blocked: false, expired: false, usable: null, disabled: false });
  if (mode !== 'IN_STRICT') {
    out.push({ value: 'UNNAMED', kind: 'UNNAMED', lotNumber: null, expiryDate: null, blocked: false, expired: false, usable: null, disabled: false });
  }
  return out;
}

/**
 * اختيارٌ لم يعد بين خيارات وضعه المتاحة — قلبُ إشارة التسوية (تشغيلةٌ من قائمة الزيادة ليست مصدراً)، أو تشغيلةٌ أُوقفت أو
 * انتهت قبل التحميل، أو مصدرٌ نفد. يُصفَّر حين تصل الخيارات، فلا يعرض المنتقي «تلقائي» والجسم يرسل غيره.
 */
export function stalePick(pick: string, choices: readonly LotPickChoice[]): boolean {
  return pick !== '' && !choices.some(c => c.value === pick && !c.disabled);
}

// ═══════════════ مصادر التنزيل من السيارة (UNLOAD، D10) ═══════════════

export interface OutSource {
  lotId: string | null; lotNumber: string | null; expiryDate: string | null;
  status: LotStatus | null; blockKind: LotBlockKind | null; usable: number; expired: boolean;
}

/**
 * مصادر صالح «صالح للبيع» في السيارة من لقطتها: كل تشغيلة صالحها > EPS أيّاً كانت حالتها، ثم غير المسمّى إن كان له صالح.
 * الترتيب: المسحوبة، ثم الموقوفة، ثم المنتهية، ثم FEFO — ما يجب إخراجه أولاً في الأعلى.
 */
export function vanOutSources(p: VanLotSnapshotDto['products'][number] | null | undefined, day: string): OutSource[] {
  if (!p) return [];
  const rank = (s: OutSource) => (s.status === 'BLOCKED' ? (s.blockKind === 'RECALL' ? 0 : 1) : s.expired ? 2 : 3);
  const named: OutSource[] = (p.lots ?? [])
    .filter(l => Number(l.usable) > LOT_EPS)
    .map(l => ({
      lotId: l.lotId, lotNumber: l.lotNumber, expiryDate: lotDay(l.expiryDate), status: l.status, blockKind: l.blockKind ?? null,
      usable: roundLot(Number(l.usable)), expired: isLotExpiredOn(l, day),
    }))
    .sort((a, b) => rank(a) - rank(b) || fefoCompare(a, b));
  const uu = Number(p.unknownUsable);
  return uu > LOT_EPS
    ? [...named, { lotId: null, lotNumber: null, expiryDate: null, status: null, blockKind: null, usable: roundLot(uu), expired: false }]
    : named;
}

/** توزيعٌ أوّلي بترتيب المصادر حتى الكمية — يعدّله المستخدم، والمجموع الناقص يبقى ناقصاً فيُرى لا يُخفى */
export function prefillOut(sources: readonly OutSource[], baseQty: number): LotRef[] {
  let left = roundLot(baseQty);
  const out: LotRef[] = [];
  for (const s of sources) {
    if (left <= LOT_EPS) break;
    const q = roundLot(Math.min(s.usable, left));
    if (q > LOT_EPS) { out.push({ lotId: s.lotId, qty: q }); left = roundLot(left - q); }
  }
  return out;
}

/** تعيين كمية مصدرٍ في صفوف السطر — الصفر والسالب يحذفان الصفّ، والترتيب يتبع المصادر */
export function setOutQty(rows: readonly LotRef[], sources: readonly OutSource[], lotId: string | null, qty: number): LotRef[] {
  const q = Number.isFinite(qty) ? roundLot(qty) : 0;
  const next = new Map(rows.map(r => [r.lotId, r.qty] as const));
  if (q > LOT_EPS) next.set(lotId, q); else next.delete(lotId);
  return sources.filter(s => next.has(s.lotId)).map(s => ({ lotId: s.lotId, qty: next.get(s.lotId)! }));
}

// ═══════════════ أسطر إنقاصٍ لصنفٍ واحد على متاحٍ مشترك (D26) ═══════════════
// الخادم يجمع أسطر الصنف قبل الفحص (pickPlan في السيارة، وplanWarehouseEntryInTx في المستودع): سطران على تشغيلةٍ واحدة يُفحصان
// معاً لا كلٌّ وحده. وصنفٌ متتبَّع يجوز له سطران بوحدتين («−١ كرتون» و«−٥ حبّات»)، فالتوزيع الأوّلي والتحقق على مستوى الصنف.

/** مصدرٌ للإنقاص بصالحه بالأساس — lotId: null = «غير مسمى» */
export interface OutSourceQty { lotId: string | null; usable: number }

/**
 * التوزيع الأوّلي لأسطر إنقاص صنفٍ واحد من متاحٍ مشترك — مرآة allocateOutLines: الصفوف المعدّلة يدوياً (rows) تُخصم أولاً كما
 * هي، ثم يُملأ كل سطرٍ بلا تعديل مما بقي، أسطر المعامل الأكبر أولاً (الكرتون قبل الحبّة فلا يُشقّ بلا حاجة) ثم بالترتيب.
 * فلا يأخذ سطران التشغيلة نفسها مرّتين. والناقص يبقى ناقصاً فيُرى.
 */
export function prefillOutLines(
  sources: readonly OutSource[],
  lines: readonly { key: string; base: number; factor?: number | null; rows?: readonly LotRef[] | null }[],
): Map<string, LotRef[]> {
  const left = new Map(sources.map(s => [s.lotId, s.usable] as const));
  const take = (rows: readonly LotRef[]) => {
    for (const r of rows) if (left.has(r.lotId)) left.set(r.lotId, roundLot(left.get(r.lotId)! - r.qty));
  };
  const out = new Map<string, LotRef[]>();
  for (const l of lines) if (l.rows) { out.set(l.key, [...l.rows]); take(l.rows); }
  const factorOf = (f: number | null | undefined) => (Number(f) > 0 ? Number(f) : 1);
  const auto = lines.map((l, i) => ({ l, i })).filter(x => !x.l.rows)
    .sort((a, b) => factorOf(b.l.factor) - factorOf(a.l.factor) || a.i - b.i);
  for (const { l } of auto) {
    const rows = prefillOut(sources.map(s => ({ ...s, usable: Math.max(0, left.get(s.lotId) ?? 0) })), l.base);
    out.set(l.key, rows);
    take(rows);
  }
  return out;
}

/** مصادر سطرٍ بما يبقى له بعد صفوف أسطر صنفه الأخرى — «المتاح» المعروض على السطر هو ما يبقى له حقّاً */
export function sourcesLeftFor<S extends OutSourceQty>(sources: readonly S[], others: readonly (readonly LotRef[])[]): S[] {
  const used = new Map<string | null, number>();
  for (const rows of others) for (const r of rows) used.set(r.lotId, (used.get(r.lotId) ?? 0) + r.qty);
  return sources.map(s => ({ ...s, usable: Math.max(0, roundLot(s.usable - (used.get(s.lotId) ?? 0))) }));
}

/** سطر إنقاصٍ لصنف: key هويّته، وbase كميته الأساسية، وrows صفوفه الصريحة — null ⇒ بلا صريح (الخادم يختار المصدر الوحيد، D10) */
export interface OutLine { key: string; base: number; rows: readonly LotRef[] | null }
export type OutProblem = 'NO_BALANCE' | 'OVER' | 'PICK' | 'DISTRIBUTE' | 'ROW_OVER';

/**
 * مشكلات أسطر إنقاص صنفٍ واحد (لكل سطرٍ واحدةٌ على الأكثر) — مرآة الخادم قبل الإرسال (D10، D26، I1، I2):
 *  - المصادر لم تصل بعد ⇒ لا حكم (لا يُمنع الحفظ على ظنّ).
 *  - لا مصدر صالح ⇒ NO_BALANCE على كل سطر (LOT_STOCK_INSUFFICIENT).
 *  - مجموع أسطر الصنف فوق مجموع مصادره ⇒ OVER على أول سطر (السبب الجذري: لا يُصلحه توزيع).
 *  - سطرٌ بلا صريح والمصادر أكثر من واحد ⇒ PICK (LOT_REQUIRED)؛ وصريحٌ فارغ أو مجموعه غير كميته ⇒ DISTRIBUTE.
 *  - مجموع كل تشغيلة عبر الأسطر (والسطر بلا صريح على المصدر الوحيد) فوق صالحها ⇒ ROW_OVER على كل سطرٍ يأخذ منها. وتشغيلةٌ
 *    ليست مصدراً صالحها صفر (مصدرٌ نفد، أو «غير مسمى» بلا صالح: I2).
 */
export function outGroupProblems(
  sources: readonly OutSourceQty[], lines: readonly OutLine[], opts: { loaded: boolean },
): Map<string, OutProblem> {
  const out = new Map<string, OutProblem>();
  const live = lines.filter(l => l.base > LOT_EPS);
  if (!opts.loaded || !live.length) return out;
  const set = (k: string, p: OutProblem) => { if (!out.has(k)) out.set(k, p); };
  if (!sources.length) {
    for (const l of live) set(l.key, 'NO_BALANCE');
    return out;
  }
  // السبب الجذري أولاً: مجموعٌ فوق المصادر لا يُصلحه توزيع
  const want = roundLot(live.reduce((s, l) => s + l.base, 0));
  const total = roundLot(sources.reduce((s, x) => s + x.usable, 0));
  const over = want > total + LOT_EPS;
  if (over) set(live[0].key, 'OVER');
  for (const l of live) {
    if (l.rows === null) { if (sources.length > 1) set(l.key, 'PICK'); }
    // صفوفٌ فارغة ليست «الخادم يوزّع» هنا كما في lotRowsProblem: الإنقاص الصريح يلزمه مجموعٌ يساوي كمية السطر
    else if (!l.rows.length || lotRowsProblem(l.rows, roundLot(l.base))) set(l.key, 'DISTRIBUTE');
  }
  if (over) return out;
  const usableOf = new Map(sources.map(s => [s.lotId, s.usable] as const));
  const sum = new Map<string | null, number>();
  const who = new Map<string | null, string[]>();
  for (const l of live) {
    const rows = l.rows ?? (sources.length === 1 ? [{ lotId: sources[0].lotId, qty: l.base }] : []);
    for (const r of rows) {
      sum.set(r.lotId, roundLot((sum.get(r.lotId) ?? 0) + r.qty));
      who.set(r.lotId, [...(who.get(r.lotId) ?? []), l.key]);
    }
  }
  for (const [lotId, q] of sum) {
    if (q > (usableOf.get(lotId) ?? 0) + LOT_EPS) for (const k of who.get(lotId) ?? []) set(k, 'ROW_OVER');
  }
  return out;
}

/** رسائل مشكلة سطر التنزيل من السيارة — مفاتيح قاموسٍ تمرّ إلى tr(متغيّر)، ويحرس ترجمتها mLotsLogic.test.ts.
 *  وPICK لا يقع في التنزيل (أكثر من مصدرٍ ⇒ صفوفٌ صريحة دائماً)، فرسالته رسالة التوزيع */
export const VAN_OUT_PROBLEMS: Record<OutProblem, string> = {
  NO_BALANCE: 'لا رصيد صالحا لهذا الصنف في السيارة',
  OVER: 'كمية التنزيل أكبر من رصيد تشغيلات الصنف في السيارة',
  PICK: 'وزع كمية التنزيل على التشغيلات',
  DISTRIBUTE: 'وزع كمية التنزيل على التشغيلات',
  ROW_OVER: 'كمية تشغيلة أكبر من المتاح فيها',
};

/** رسائل مشكلة سطر نقص المستودع (التسوية السالبة) — سطرٌ = تشغيلة، فلا توزيع: DISTRIBUTE لا يقع ورسالته «اختر» */
export const WH_OUT_PROBLEMS: Record<OutProblem, string> = {
  NO_BALANCE: 'لا رصيد صالحا لهذا الصنف في المستودع',
  OVER: 'الكمية أكبر من رصيد تشغيلات الصنف في المستودع',
  PICK: 'للصنف أكثر من مصدر في المستودع فاختر التشغيلة',
  DISTRIBUTE: 'اختر التشغيلة التي ينقص منها الرصيد',
  ROW_OVER: 'كمية تشغيلة أكبر من المتاح فيها',
};

/** مصادر نقص المستودع من عرضه (GET /lots/balances): كل تشغيلة صالحها > EPS، ثم غير المسمّى بصالحه الموجب — مرآة pickOutSources */
export function whOutSources(view: PlaceLotViewDto | null | undefined): OutSourceQty[] {
  if (!view) return [];
  const named = (view.lots ?? []).filter(l => l.usable.SELLABLE > LOT_EPS).map(l => ({ lotId: l.lotId, usable: roundLot(l.usable.SELLABLE) }));
  const uu = roundLot(view.unknownUsable?.SELLABLE ?? 0);
  return uu > LOT_EPS ? [...named, { lotId: null, usable: uu }] : named;
}

/** صفوف سطر نقص المستودع من مسودّته (سطرٌ = تشغيلة): الاختيار صفٌّ بكمية السطر، وبلا اختيار null — المصدر الوحيد للخادم */
export function whOutRows(d: LotDraft, base: number): LotRef[] | null {
  if (d.pick === '') return null;
  if (d.pick === 'NEW') return [];
  return [{ lotId: d.pick === 'UNNAMED' ? null : d.pick, qty: roundLot(base) }];
}

/** نصّ تشغيلةٍ مختصر في سطر: «L-12 · ينتهي 2026-12-01» — والرقم الغائب «غير مسمى» (المستدعي يترجم) */
export function lotLineLabel(l: { lotNumber: string | null; expiryDate?: string | null }, unnamed: string, expires: string): string {
  const d = lotDay(l.expiryDate);
  return [l.lotNumber ?? unnamed, d ? `${expires} ${d}` : ''].filter(Boolean).join(' · ');
}

/**
 * كمية تشغيلةٍ بالأساس بجانب سطرٍ بوحدته (القاعدة ٨، docs/multi-unit/DESIGN.md): «٢ كرتون و٦ حبة» لصنفٍ له وحدات أكبر،
 * وإلّا الرقم بجانب اسم الأساس — فلا يُقرأ «المتاح ٣٠» ثلاثين كرتوناً. مقرّبةً بأربع خانات (D22) قبل منسّق الشاشة `num`.
 * لكميةٍ يُدخلها المستخدم بالأساس (توزيع التنزيل) يُمرَّر `{ unit }` وحده: الرقم واسم الأساس بلا تفكيك.
 */
export function lotQtyText(baseQty: number, p: { unit?: string | null; units?: UnitDef[] | null } | null | undefined, num: (n: number) => string): string {
  return qtyText(roundLot(Number(baseQty) || 0), p, num, { withUnit: true });
}

/**
 * مفاتيح كاش التشغيلات في الجوال واللوحة معاً (الحزمة واحدة والكاش مشترك) — تتبدّل بكل حركةٍ أو تغيّر حالةٍ لتشغيلة.
 * المطابقة في TanStack على **العنصر الأول كاملاً** لا على بادئة نصّه ('lot-balances' لا يطابق 'lot-balances-wh')، فكل مفتاحٍ
 * بعينه، ويحرسها اختبارٌ يستخرج مفاتيح queryKey من m/ وpages/ وcomponents/:
 *  - الجوال: القائمة والبطاقة وتتبّعها (m-lots/m-lot)، وخيارات المنتقي، ولقطة السيارة واقتراح FEFO، وتفصيل المستودع.
 *  - اللوحة: صفحة التشغيلات، وأرصدة المستودع والسيارة والتحميل، ولقطة السيارة، واقتراح FEFO، وتشغيلات الصنف للمنتقي،
 *    وتشغيلات سيارة المندوب المحذوف، وتقرير مبيعات التشغيلات.
 * تُبطَل حين الميزة مفعّلة وحدها (§١٠.١).
 */
export const LOT_CACHE_KEYS = [
  'm-lots', 'm-lot', 'm-lot-opts', 'm-van-lots', 'm-van-fefo', 'm-wh-lots',
  'lots', 'lot-balances-wh', 'lot-balances-van', 'lot-balances-load', 'van-lot-balances', 'lot-fefo', 'lots-of-product',
  'rep-delete-van-lots', 'report-lot-sales',
] as const;

/** مفاتيح أرصدة السيارات والمستودع (الجوال واللوحة) — تتبدّل بتنزيلٍ من شاشة التشغيلات */
export const STOCK_CACHE_KEYS = [
  'm-van-current', 'm-van-movements', 'm-van-suggest', 'm-wh-stock', 'm-wh-entries',
  'van-summary', 'van-current', 'van-movements', 'van-stock', 'van-loads-log', 'warehouse-stock', 'warehouse-entries', 'warehouse-vans',
] as const;

// ═══════════════ شاشة التشغيلات (MLots) ═══════════════

/** حجم دفعة القائمة وسقفها — الخادم يقصّ limit عند ٢٠٠ (GET /lots)، والقريب من الانتهاء بأيام اللوحة نفسها */
export const M_LOTS_PAGE = 30;
export const M_LOTS_MAX = 200;
export const M_LOTS_SOON_DAYS = 30;

export interface MLotsFilter { q: string; status: '' | LotStatus; soon: boolean }

/** معاملات GET /lots — الفارغ يُحذف لا يُرسل (`status=` فارغاً يصل الخادم نصّاً)، والصفحة الأولى بحدٍّ يكبر بالتمرير */
export function lotListParams(f: MLotsFilter, limit: number): LotListParams {
  const q = f.q.trim();
  const lim = Math.trunc(Number(limit));
  return {
    ...(q ? { q } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.soon ? { expiringWithinDays: M_LOTS_SOON_DAYS } : {}),
    page: 1,
    limit: Math.min(M_LOTS_MAX, lim > 0 ? lim : M_LOTS_PAGE),
  };
}

/** الحدّ التالي عند بلوغ قاع القائمة — null حين لا مزيد: دفعةٌ ناقصة، أو بلغ المعروضُ العددَ الكلي، أو سقف الخادم */
export function nextLotsLimit(limit: number, shown: number, total: number | null | undefined): number | null {
  if (shown < limit) return null;
  if (total != null && shown >= total) return null;
  if (limit >= M_LOTS_MAX) return null;
  return Math.min(M_LOTS_MAX, limit + M_LOTS_PAGE);
}

/** سقف السبب في الخادم (statusSchema: max 500) */
export const LOT_REASON_MAX = 500;
export const STATUS_REASON_PROBLEMS = {
  EMPTY: 'اكتب سبب هذا التعديل على التشغيلة',
  LONG: 'السبب أطول من 500 حرف',
} as const;

/** سبب الإيقاف أو السحب أو إعادة التنشيط — إلزامي في الاتجاهين (D27)، وبسقف الخادم */
export function statusReasonProblem(reason: string | null | undefined): string | null {
  const r = (reason ?? '').trim();
  if (!r) return STATUS_REASON_PROBLEMS.EMPTY;
  if (r.length > LOT_REASON_MAX) return STATUS_REASON_PROBLEMS.LONG;
  return null;
}

/**
 * المقيّد بنطاقٍ لا يوقف ولا يسحب (LOT_SCOPED_USER) — وجلسة المالك (الانتحال) غير مقيّدة أبداً. الزرّ يُعطَّل بسببه
 * قبل الضغط، والخادم يفرضه على كل حال.
 */
export const scopedLotUser = (user: { scopeEnabled?: boolean | null } | null | undefined, impersonating: unknown): boolean =>
  user?.scopeEnabled === true && !impersonating;

const anyPositive = (b: Partial<Record<LotBucket, number>> | null | undefined): boolean =>
  !!b && LOT_BUCKETS.some(k => roundLot(Number(b[k]) || 0) > LOT_EPS);

/**
 * خطة التنزيل بعد الإيقاف — كل سيارةٍ فيها من التشغيلة صالحٌ أو محجوزٌ موجب في **أيّ دلو** (anyPositive في unloadPlan
 * بالخادم): منتهٍ أو تالفٌ وحده يبقى، فلا تُقرأ تشغيلةٌ مسحوبة «لا رصيد في السيارات» وهي فيها. ما فيه صالحٌ يُنزَّل أولاً
 * (الأكبر قبل)، ثم ما بقي.
 */
export function unloadPlanRows(plan: readonly LotUnloadPlanDto[] | null | undefined): LotUnloadPlanDto[] {
  const sell = (r: LotUnloadPlanDto) => roundLot(Number(r.usable?.SELLABLE) || 0);
  return [...(plan ?? [])]
    .filter(r => anyPositive(r.usable) || anyPositive(r.held))
    .sort((a, b) => sell(b) - sell(a) || (a.repName ?? '').localeCompare(b.repName ?? '') || a.salesRepId.localeCompare(b.salesRepId));
}

/** في الخطة منتهٍ أو تالفٌ من التشغيلة في سيارة — لا يُنزَّل بزرّ «تنزيل» بل يُزال من دلوه في مخزون السيارات (كاللوحة) */
export function unloadPlanHasRemovals(plan: readonly LotUnloadPlanDto[] | null | undefined): boolean {
  return (plan ?? []).some(r => roundLot(Number(r.usable?.EXPIRED) || 0) > LOT_EPS || roundLot(Number(r.usable?.DAMAGED) || 0) > LOT_EPS);
}

/** مجاميع خطة التنزيل: الصالح للتنزيل، والمحجوز، وعدد السيارات التي فيها ما يُنزَّل */
export function unloadPlanTotals(plan: readonly LotUnloadPlanDto[] | null | undefined): { usable: number; held: number; vans: number } {
  let usable = 0, held = 0, vans = 0;
  for (const r of plan ?? []) {
    const u = roundLot(Number(r.usable?.SELLABLE) || 0);
    usable += Math.max(0, u);
    held += Math.max(0, roundLot(Number(r.held?.SELLABLE) || 0));
    if (u > LOT_EPS) vans += 1;
  }
  return { usable: roundLot(usable), held: roundLot(held), vans };
}

const CERTAINTY_RANK: Record<LotCertainty, number> = { UNKNOWN: 0, ASSUMED: 1, CONFIRMED: 2 };

/** أضعف يقين في قائمة (غير معروف < مفترض < مؤكد) — الفارغة null */
export function weakestCertainty(list: readonly LotCertainty[]): LotCertainty | null {
  let w: LotCertainty | null = null;
  for (const c of list) {
    if (!(c in CERTAINTY_RANK)) continue;
    if (w === null || CERTAINTY_RANK[c] < CERTAINTY_RANK[w]) w = c;
  }
  return w;
}

type TraceCustomer = NonNullable<LotTraceDto['customers']>[number];

/** مجاميع عميلٍ في شاشة التتبّع: المباع والمرتجع والصافي، وأضعف يقين، وهل جاء شيءٌ منه بالنطاق الموسّع وحده */
export function customerLotTotals(c: TraceCustomer): { sold: number; returned: number; net: number; weakest: LotCertainty | null; broadOnly: boolean } {
  let sold = 0, returned = 0;
  for (const i of c.invoices) { sold += Number(i.sold) || 0; returned += Number(i.returned) || 0; }
  return {
    sold: roundLot(sold), returned: roundLot(returned), net: roundLot(sold - returned),
    weakest: weakestCertainty(c.invoices.map(i => i.weakest)),
    broadOnly: c.invoices.length > 0 && c.invoices.every(i => i.broad),
  };
}

/**
 * رابط الاتصال بعميلٍ وصلته التشغيلة (السحب يبدأ بالهاتف): الأرقام العربية-الهندية لاتينية، وما سوى الأرقام و«+» البادئة
 * يسقط. رقمٌ أقصر من ٥ أو أطول من ١٥ (E.164) ⇒ null فلا رابط.
 */
export function telHref(phone: string | null | undefined): string | null {
  if (typeof phone !== 'string') return null;
  const s = phone
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .trim();
  const plus = s.startsWith('+') || s.startsWith('00');
  const digits = s.replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 5 || digits.length > 15) return null;
  return `tel:${plus ? '+' : ''}${digits}`;
}

// ═══════════════ فاتورة الإدارة: متاح الأصناف المتتبَّعة في سيارة المندوب ═══════════════

/** الطلب الأساسي لكل صنفٍ متتبَّع في أسطر الفاتورة — مجموع أسطره بوحداتها (كرتونان + ٥ حبّات = ٥٣)، بترتيب ظهوره */
export function trackedDemand(
  lines: readonly { productId: string; qty: number; unitFactor?: number | null }[],
  tracked: (productId: string) => boolean,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    if (!tracked(l.productId)) continue;
    out.set(l.productId, roundLot((out.get(l.productId) ?? 0) + lineBaseQty(l.qty, l.unitFactor)));
  }
  return out;
}

/**
 * متاح الصنف للبيع في سيارة المندوب من لقطتها (§٧): products[].available (المسمّى المؤهَّل ثم غير المسمّى، D17)، والمتتبَّع
 * الغائب عن products صفر (لا رصيد له)، وغير المتتبَّع أو بلا لقطة null (لا قيد لوطٍ عليه).
 */
export function vanAvailableOf(snap: VanLotSnapshotDto | null | undefined, productId: string): number | null {
  if (!snap || !Array.isArray(snap.tracked) || !snap.tracked.includes(productId)) return null;
  const p = snap.products?.find(x => x.productId === productId);
  return p ? Math.max(0, roundLot(Number(p.available) || 0)) : 0;
}

export interface VanLotShortage { productId: string; wanted: number; available: number }

/**
 * أصناف الفاتورة المتتبَّعة التي يتجاوز طلبها متاح السيارة — تنبيهٌ قبل الإصدار بالكمية الأساسية؛ والخادم يمنع تحت القفل
 * (LOT_STOCK_INSUFFICIENT) أيّاً كان «البيع بدون مخزون». المتتبَّع من اللقطة نفسها (tracked) لا من علم الصنف المحمّل.
 */
export function vanLotShortages(
  lines: readonly { productId: string; qty: number; unitFactor?: number | null }[],
  snap: VanLotSnapshotDto | null | undefined,
): VanLotShortage[] {
  if (!snap) return [];
  const demand = trackedDemand(lines, pid => vanAvailableOf(snap, pid) !== null);
  const out: VanLotShortage[] = [];
  for (const [productId, wanted] of demand) {
    const available = vanAvailableOf(snap, productId) ?? 0;
    if (wanted > available + LOT_EPS) out.push({ productId, wanted, available });
  }
  return out;
}
