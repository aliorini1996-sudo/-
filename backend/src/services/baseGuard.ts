/**
 * «الوحدة الرئيسية» §3 — حارس وحدة الأساس لكل كاتبٍ يكتب كمية أو سعراً مرتبطاً بها (المواصفة §2.5، الثوابت I6 وI10 وD19 وD20).
 *
 * المشكلة: الكاتب يحلّ مدخلاته (لقطة الوحدة، والكمية بالأساس) على أساس الصنف كما قرأه **قبل** معاملته. فلو التزم تحويلٌ
 * (products.ts convert-base: كرتون ⇒ قارورة، يقفل صفّ الصنف FOR UPDATE ويعيد كتابة التاريخ) بين القراءة والكتابة، لكُتب الكرتون
 * قارورةً بعد أن مرّ التحويل على التاريخ — خطأٌ ×٢٤ صامت في المخزون أو السعر. والحارس طبقتان:
 *   (١) **حيّاً قبل المعاملة:** العميل يرسل الأساس الذي يعرفه (`baseUnitName`)، واختلافه عن أساس الصنف الآن ⇒ 400 UNIT_INVALID
 *       فيعيد العميل تحميل أصنافه (staleClientBase). ومفتاح API على صنفٍ حُوِّل بلا الأساس ⇒ 400 BASE_UNIT_REQUIRED (D19).
 *   (٢) **تحت القفل:** FOR KEY SHARE على صفوف الأصناف (يتعارض مع FOR UPDATE وحده) ثم مقارنة الأساس المقروء بالأساس الذي حُلّت
 *       عليه المدخلات ⇒ 409 PRODUCT_UNITS_CHANGED (503 لإعادة الرفع). والانتظار محدود بـLOT_LOCK_TIMEOUT (I10) ⇒ 503 PRODUCT_UNITS_BUSY.
 *
 * المقارنة كلها بـbaseNameKey على الطرفين (D20-أ): اسم أساسٍ أطول من ٦٤ حرفاً لا يُرى «قديماً» أبداً.
 * لا يقرأ هذا الملف الوحدة الرئيسية: الحارس على الأساس وحده (I2).
 */
import type { Prisma } from '@prisma/client';
import { LotError } from './lots';
import { LOT_LOCK_TIMEOUT } from './lotsDb';
import { baseNameKey } from './units';

/** D20-أ: يُعاد تصديره من services/units.ts — مصدرٌ واحد للخادم والويب */
export { baseNameKey } from './units';

/** صنف ← الأساس الذي حُلّت عليه المدخلات (`unit` كما قُرئ قبل المعاملة) واسمه للرسالة */
export type ExpectedBases = ReadonlyMap<string, { name: string; unit: string }>;

/** الأساس المتوقَّع من صفوف أصنافٍ مقروءة قبل المعاملة */
export function expectedBasesOf(products: Iterable<{ id: string; name: string; unit: string }>): ExpectedBases {
  const out = new Map<string, { name: string; unit: string }>();
  for (const p of products) out.set(p.id, { name: p.name, unit: p.unit });
  return out;
}

/** تبدّل أساس صنفٍ (أو أكثر) بين حلّ المدخلات وقفل صفوفها — تحويلٌ متزامن التزم قبلنا */
export class ProductUnitsChangedError extends Error {
  readonly code = 'PRODUCT_UNITS_CHANGED';
  constructor(readonly names: string[]) {
    super(`تغيّرت وحدات «${names.join('، ')}» أثناء الحفظ`);
    this.name = 'ProductUnitsChangedError';
  }
}

/** انتظار قفل صفوف الأصناف تجاوز المهلة — تحويلٌ طويل يمسكها. رسالته بلا «lock timeout» فلا يلتقطها asLotBusy */
export class ProductUnitsBusyError extends Error {
  readonly code = 'PRODUCT_UNITS_BUSY';
  constructor() {
    super('وحدات الأصناف قيد التحديث الآن');
    this.name = 'ProductUnitsBusyError';
  }
}

/**
 * أسماء الأصناف التي تغيّر أساسها: صفٌّ مقفل أساسه ≠ المتوقَّع. صنفٌ غير متوقَّع (خارج الطلب) يُتجاهل، وصفٌّ بلا `unit` نصّيّ
 * لا يُحكم عليه (كـassertBasesUnchanged لصنفٍ غائب عن الخريطة): العمود NOT NULL في القاعدة فلا يقع إلا في مزيّفٍ قديم بلا العمود
 */
export function movedBases(expected: ExpectedBases, rows: ReadonlyArray<{ id: string; unit: string }>): string[] {
  const names: string[] = [];
  for (const r of rows) {
    const e = expected.get(r.id);
    if (e && typeof r.unit === 'string' && baseNameKey(e.unit) !== baseNameKey(r.unit)) names.push(e.name);
  }
  return names;
}

const BUSY_SQLSTATES = new Set(['55P03', '40P01']);
const errFields = (e: unknown) => {
  const o = e as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown } | null | undefined;
  return {
    code: typeof o?.code === 'string' ? o.code : '',
    metaCode: typeof o?.meta?.code === 'string' ? o.meta.code : '',
    msg: typeof o?.message === 'string' ? o.message : '',
  };
};
/**
 * انشغالٌ خام من القاعدة أو من Prisma: 55P03 (lock_timeout) و40P01 (deadlock) وP2028 (انقضاء المعاملة) وP2034 (تعارض كتابة).
 * أخطاء التطبيق (بحالة HTTP رقمية: UnitInvalidError وأخطاء الموجّهات وLotError) ليست انشغالاً ولو حملت رسالتُها اسمَ صنفٍ يطابق النمط
 */
function isRawBusy(e: unknown): boolean {
  if (e instanceof LotError || e instanceof ProductUnitsChangedError || e instanceof ProductUnitsBusyError) return false;
  if (typeof (e as { status?: unknown } | null | undefined)?.status === 'number') return false;
  const { code, metaCode, msg } = errFields(e);
  return code === 'P2028' || code === 'P2034' || BUSY_SQLSTATES.has(code) || BUSY_SQLSTATES.has(metaCode)
    || /\b55P03\b|\b40P01\b|lock timeout|deadlock detected|Transaction already closed|expired transaction/i.test(msg);
}

export interface LockedBaseRow { id: string; unit: string; lotTracked: boolean; lotTrackedSince: Date | null }

/**
 * قفلٌ مشترك FOR KEY SHARE (ORDER BY id) بمهلة LOT_LOCK_TIMEOUT محلية تُحفظ وتُستعاد، ثم المقارنة. يتخطّى معاملةً مزيّفة بلا
 * $queryRaw (اختبارات المسارات). 55P03 ⇒ ProductUnitsBusyError، والاختلاف ⇒ ProductUnitsChangedError.
 * الترتيب: بعد أقفال المستند والدلو والقفل الاستشاري، وقبل أقفال LOT الاستشارية (lotsDb.ts §٣.١).
 * لا استعادة عند الفشل: المعاملة الفاشلة مُجهَضة أصلاً، وset_config المحلي يزول بنهايتها.
 */
export async function lockBases(tx: Prisma.TransactionClient, tid: string, expected: ExpectedBases): Promise<LockedBaseRow[]> {
  const ids = [...new Set(expected.keys())].filter((x) => typeof x === 'string' && x.length > 0).sort();
  if (!ids.length) return [];
  if (typeof (tx as { $queryRaw?: unknown }).$queryRaw !== 'function') return [];
  let rows: LockedBaseRow[];
  try {
    const prevRows = await tx.$queryRaw<{ lock_timeout: string }[]>`SELECT current_setting('lock_timeout') AS lock_timeout`;
    const prev = prevRows?.[0]?.lock_timeout ?? '0';
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)`;
    rows = await tx.$queryRaw<LockedBaseRow[]>`
      SELECT id, unit, "lotTracked", "lotTrackedSince" FROM products
      WHERE "tenantId" = ${tid} AND id = ANY(${ids}::text[])
      ORDER BY id
      FOR KEY SHARE`;
    await tx.$executeRaw`SELECT set_config('lock_timeout', ${prev}, true)`;
  } catch (e) {
    if (isRawBusy(e)) throw new ProductUnitsBusyError();
    throw e;
  }
  const moved = movedBases(expected, rows ?? []);
  if (moved.length) throw new ProductUnitsChangedError(moved);
  return rows ?? [];
}

/**
 * لصفوف lockLotProducts (`units`: صنف ← أساسه تحت القفل): المقارنة نفسها بلا قفلٍ ثانٍ. صنفٌ غائب عن الخريطة (صفوفٌ مقفلة سلفاً
 * بلا `unit`) لا يُحكم عليه هنا.
 */
export function assertBasesUnchanged(expected: ExpectedBases, locked: ReadonlyMap<string, string>): void {
  const names: string[] = [];
  for (const [pid, e] of expected) {
    const u = locked.get(pid);
    if (u === undefined) continue;
    if (baseNameKey(e.unit) !== baseNameKey(u)) names.push(e.name);
  }
  if (names.length) throw new ProductUnitsChangedError(names);
}

/** اسم أساسٍ مُرسَل فعلاً (لا غائب ولا فارغ بعد القصّ) */
const sentBase = (s: string | null | undefined): boolean => baseNameKey(s) !== '';

/** المقارنة الحيّة قبل المعاملة: أول صنفٍ أرسل بنده baseUnitName ≠ أساسه الآن، أو null. بندٌ بلا الحقل ⇒ مسار اليوم */
export function staleClientBase(
  lines: ReadonlyArray<{ productId: string; baseUnitName?: string | null }>, products: ExpectedBases,
): string | null {
  for (const l of lines) {
    if (!sentBase(l.baseUnitName)) continue;
    const p = products.get(l.productId);
    if (p && baseNameKey(l.baseUnitName) !== baseNameKey(p.unit)) return p.name;
  }
  return null;
}

/** D19-ب: مفتاح API وصنفٌ محوَّل وبندٌ بلا baseUnitName ⇒ اسم الصنف (للرسالة 400 BASE_UNIT_REQUIRED)، وإلا null */
export function missingBaseForApi(
  isApiKey: boolean,
  lines: ReadonlyArray<{ productId: string; baseUnitName?: string | null }>,
  products: ReadonlyMap<string, { name: string; baseConvertedAt: Date | null }>,
): string | null {
  if (!isApiKey) return null;
  for (const l of lines) {
    const p = products.get(l.productId);
    if (p?.baseConvertedAt && !sentBase(l.baseUnitName)) return p.name;
  }
  return null;
}

type GuardReply = { status: number; body: { success: false; code: string; message: string } };

/** ردّ D19 الموحّد لكل الكتّاب: 400 BASE_UNIT_REQUIRED باسم الصنف */
export function baseUnitRequiredReply(name: string): GuardReply {
  return {
    status: 400,
    body: {
      success: false, code: 'BASE_UNIT_REQUIRED',
      message: `تغيّرت وحدات «${name}» — أرسل baseUnitName (اسم وحدته الصغرى الحالية كما في GET /products) مع كل بند`,
    },
  };
}

/**
 * ProductUnitsChangedError ⇒ 409 حيّاً و503 لإعادة الرفع. ProductUnitsBusyError، وأخطاء الانتظار الخام 55P03 و40P01
 * (من Prisma أو من $queryRaw)، وP2028 (انقضاء معاملة Prisma) ⇒ 503 PRODUCT_UNITS_BUSY — كما يفعل asLotBusy. وإلا null.
 * LotError (ومنه LOT_BUSY في مسارات LOT) ليس له: يمرّ إلى معالجه كما كان.
 */
export function baseGuardReply(err: unknown, replay: boolean): GuardReply | null {
  if (err instanceof ProductUnitsChangedError) {
    return {
      status: replay ? 503 : 409,
      body: { success: false, code: 'PRODUCT_UNITS_CHANGED', message: `تغيّرت وحدات «${err.names.join('، ')}» أثناء الحفظ — حدّث الأصناف ثم أعد المحاولة` },
    };
  }
  if (err instanceof ProductUnitsBusyError || isRawBusy(err)) {
    return { status: 503, body: { success: false, code: 'PRODUCT_UNITS_BUSY', message: 'وحدات الأصناف قيد التحديث الآن — أعد المحاولة بعد لحظات' } };
  }
  return null;
}

/** I10: خيارات كل معاملة تفاعلية جديدة فيها lockBases — لا تسبق مهلة Prisma الافتراضية (٥٠٠٠ms) مهلة القفل */
export const BASE_GUARD_TX = { maxWait: 10_000, timeout: 20_000 } as const;

// ═══ I10: سجلّ «قيد التحويل» في ذاكرة العملية — إسراعٌ لا ضمان (§2.2-ز، §2.13). القفل في القاعدة هو الحارس ═══

const converting = new Map<string, number>();
const convKey = (tid: string, pid: string) => `${tid}\u0000${pid}`;

/** يُستدعى قبل معاملة convert-base. عدّادٌ لا علم: تحويلان متداخلان للصنف نفسه لا يمحو أحدهما الآخر */
export function markConverting(tid: string, pid: string): void {
  const k = convKey(tid, pid);
  converting.set(k, (converting.get(k) ?? 0) + 1);
}

/** يُستدعى في finally بعد المعاملة — ولو رمت */
export function unmarkConverting(tid: string, pid: string): void {
  const k = convKey(tid, pid);
  const n = (converting.get(k) ?? 0) - 1;
  if (n > 0) converting.set(k, n);
  else converting.delete(k);
}

/** هل أحد هذه الأصناف قيد تحويلٍ في هذه العملية الآن */
export function anyConverting(tid: string, pids: Iterable<string>): boolean {
  if (!converting.size) return false;
  for (const pid of pids) if (converting.has(convKey(tid, pid))) return true;
  return false;
}
