/**
 * «عرض الكميات» (طلب المالك ٤ نوفمبر ٢٠٢٦): مبدّلٌ في «مخزون الشركة» و«مخزون السيارات» بين الوحدة الكبرى والصغرى —
 * نقيٌّ بلا React ولا شبكة، يُختبر وحده (qtyView.test.ts). والمخزن المشترك بين الصفحتين في store/qtyViewStore.ts.
 *
 * عرضٌ فقط: كل حسابٍ بالأساس كما كان، ولا رقم هنا يدخل جمعاً أو مقارنة.
 *  · «الكبرى» (الافتراضي) = `baseQtyText` حرفاً — عرض اليوم: «52 كرتون و2 قارورة».
 *  · «الصغرى» = رقم الأساس بجانب اسمه («1,250 قارورة») لصنفٍ له وحدةٌ أكبر؛ وصنفٌ بلا وحدات كما هو في الحالين.
 *  · المجاميع عبر الأصناف (ما في السيارات، ملخّص المناديب) يجمعها الخادم لكل وحدةٍ كبرى (`major`) وتُعرض
 *    «22.75 كرتون · 40 حبة» — لا كرتونٌ وحبّةٌ رقماً واحداً.
 * والمبدّل يظهر حين في الصفحة صنفٌ له وحدةٌ أكبر وحده، وإلّا فالعرض «الكبرى» = اليوم حرفاً (`qtyViewFor`).
 * الفخّ الحاكم (adminUnits): كل رقمٍ بجانب اسم وحدته هو.
 */
import { baseQtyText, hasBigUnit } from './adminUnits';
import type { UnitDef } from './units';

export type QtyView = 'major' | 'minor';

/** مفتاح التفضيل في التخزين المحلي — لكل مشاهدٍ في متصفّحه، مشتركٌ بين الصفحتين */
export const QTY_VIEW_KEY = 'fs_qty_view';
export const DEFAULT_QTY_VIEW: QtyView = 'major';

export function isQtyView(v: unknown): v is QtyView {
  return v === 'major' || v === 'minor';
}

type QtyProduct = { unit?: string | null; units?: UnitDef[] | null; primaryUnitId?: string | null } | null | undefined;

/**
 * كمية بالأساس للعرض بحسب المبدّل: «الكبرى» = baseQtyText حرفاً، و«الصغرى» = رقم الأساس واسمه لصنفٍ له وحدةٌ أكبر.
 * قيمةٌ غير «الصغرى» تُقرأ «الكبرى» (عرض اليوم).
 */
export function qtyText(view: QtyView, baseQty: number, p: QtyProduct, fmt: (n: number) => string): string {
  if (view === 'minor' && p && hasBigUnit(p.units)) {
    const base = String(p.unit ?? '');
    const n = Number(baseQty) || 0;
    return base ? `${fmt(n)} ${base}` : fmt(n);
  }
  return baseQtyText(baseQty, p, fmt);
}

/** مجموعٌ لوحدةٍ كبرى كما يرسله الخادم (`major`) — الكمية بتلك الوحدة لا بالأساس */
export interface UnitTotal { unit: string; qty: number }

/** القائمة كما وصلت، أو null حين لم يرسلها الخادم (خادمٌ أقدم ⇒ يُعرض القائم حرفاً) */
export function totalsList(x: unknown): UnitTotal[] | null {
  return Array.isArray(x) ? (x as UnitTotal[]) : null;
}

/**
 * منسّق مجاميع الوحدة الكبرى: حتى أربع منازل كما يقرّبها الخادم — بيضةٌ واحدة من كرتون ٣٦٠ «0.0028 كرتون» لا «0 كرتون».
 * (toLocaleString بلا خيارٍ يقف عند ثلاث، ومنسّق الصفحة fmtQty عند اثنتين.) ورقمٌ غير صفرٍ لا يُطبع صفراً ولا «-0» أبداً.
 */
export function fmtTotalQty(n: number, locale = 'en-US'): string {
  const q = Number(n);
  if (!Number.isFinite(q) || q === 0) return (0).toLocaleString(locale);
  return q.toLocaleString(locale, Math.abs(q) < 0.00005 ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 4 });
}

/** مجموعةٌ للعرض: نصّها («22.75 كرتون») وكميتها بإشارتها — لتلوين كل مجموعةٍ بإشارتها هي */
export interface UnitTotalItem { text: string; qty: number }

/** مجموعات الخادم للعرض بترتيبه — المدخل التالف يُتخطّى ولا يُسقط الشاشة */
export function unitTotalsItems(totals: ReadonlyArray<UnitTotal | null | undefined> | null | undefined, fmt: (n: number) => string): UnitTotalItem[] {
  if (!Array.isArray(totals)) return [];
  const out: UnitTotalItem[] = [];
  for (const t of totals) {
    if (!t) continue;
    const q = Number(t.qty);
    if (!Number.isFinite(q)) continue;
    const u = String(t.unit ?? '').trim();
    out.push({ text: u ? `${fmt(q)} ${u}` : fmt(q), qty: q });
  }
  return out;
}

/** «22.75 كرتون» لكل مجموعة بترتيب الخادم — المدخل التالف يُتخطّى ولا يُسقط الشاشة */
export function unitTotalsParts(totals: ReadonlyArray<UnitTotal | null | undefined> | null | undefined, fmt: (n: number) => string): string[] {
  return unitTotalsItems(totals, fmt).map(x => x.text);
}

/** «22.75 كرتون · 40 حبة» — والقائمة الفارغة صفر */
export function unitTotalsText(totals: ReadonlyArray<UnitTotal | null | undefined> | null | undefined, fmt: (n: number) => string): string {
  const parts = unitTotalsParts(totals, fmt);
  return parts.length ? parts.join(' · ') : fmt(0);
}

/** في الصفحة صنفٌ له وحدةٌ أكبر؟ — وإلّا فالمبدّل بلا معنى ويُخفى */
export function anyBigUnit(rows: ReadonlyArray<{ units?: UnitDef[] | null } | null | undefined>): boolean {
  return rows.some(r => !!r && hasBigUnit(r.units));
}

/** العرض النافذ: المبدّل مخفيّ ⇒ «الكبرى» (اليوم حرفاً) أيّاً كان المحفوظ */
export function qtyViewFor(view: QtyView, shown: boolean): QtyView {
  return shown && isQtyView(view) ? view : DEFAULT_QTY_VIEW;
}

type KV = Pick<Storage, 'getItem' | 'setItem'>;

/** التخزين المحلي إن أمكن — الوصول إليه قد يرمي (نافذة خاصة، بياناتٌ محجوبة) */
function defaultStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** التفضيل المحفوظ، وإلّا «الكبرى» — غائبٌ أو تالفٌ أو تخزينٌ يرمي */
export function loadQtyView(storage: KV | null = defaultStorage()): QtyView {
  try {
    const v = storage?.getItem(QTY_VIEW_KEY);
    return isQtyView(v) ? v : DEFAULT_QTY_VIEW;
  } catch {
    return DEFAULT_QTY_VIEW;
  }
}

/** حفظ التفضيل — تخزينٌ محجوبٌ يُبقيه لهذه الجلسة وحدها بلا خطأ */
export function saveQtyView(view: QtyView, storage: KV | null = defaultStorage()): void {
  if (!isQtyView(view)) return;
  try {
    storage?.setItem(QTY_VIEW_KEY, view);
  } catch {
    /* محجوب: لا شيء */
  }
}

/**
 * لوحة المفاتيح في مجموعة الخيارات (role="radiogroup"): الفهرس التالي، أو null لمفتاحٍ لا يخصّها.
 * الأسهم تدور، و«التالي» في الاتجاه من اليمين لليسار هو السهم الأيسر.
 */
export function radioKeyStep(key: string, index: number, count: number, rtl: boolean): number | null {
  if (count <= 0) return null;
  const next = key === 'ArrowDown' || key === (rtl ? 'ArrowLeft' : 'ArrowRight');
  const prev = key === 'ArrowUp' || key === (rtl ? 'ArrowRight' : 'ArrowLeft');
  if (next) return (index + 1) % count;
  if (prev) return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
