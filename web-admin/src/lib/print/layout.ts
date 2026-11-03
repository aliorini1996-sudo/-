// ============================================================================
// محرّك «تخطيط المطبوعات» (pl_spec v2 — C(iii)) — طلب المالك ٣ نوفمبر ٢٠٢٦: مكان الشعار وحجمه ولون التمييز وشكل الجدول
// وترتيب الأقسام لكل قالب طباعة. دوالّ خالصة بلا React ولا DOM، يستهلكها A4 (RepDocuments) والقالب ثنائي اللغة (printGrid)
// والرول (thermalHtml) عبر HTML نصّي.
//
// القاعدة الذهبية: resolveLayout(...) === null ⇒ مسار اليوم حرفياً (لا ملف، ملف افتراضي legacy، roll_classic، أو بلا options.layout)،
// وكل دالة هنا تعيد مع null قيم اليوم بالضبط ({} / null / undefined) — حرّاس *.baseline.test.* تثبت ذلك.
//
// الاستيراد من النواة type-only عمداً: لا يتوقف هذا الملف على ترتيب وصول حزم البناء، وقائمة الأقسام الافتراضية نسخة محلية
// يحرسها layout.test.ts بمقارنتها مع sectionsFor() في النواة متى وُجدت.
// ============================================================================

import type { PrintProfile, PrinterType, LayoutDesign, SectionId } from './printSettingsCore';
import { roundHalfUp } from '../money';

export type CSSProps = Record<string, string | number>;

export interface ResolvedLayout {
  design: LayoutDesign; logo: 'start' | 'center' | 'end' | 'none'; logoSize: 's' | 'm' | 'l';
  accent: string | null; tableStyle: 'lines' | 'grid' | 'striped'; fontScale: number;
  order: readonly SectionId[]; printer: PrinterType;
}

// ─── نسخ محلية من ثوابت النواة (C(i)) — يحرسها layout.test.ts مقابل printSettingsCore متى صدّرها ───

const LEGACY_IDS: readonly string[] = ['legacy-58', 'legacy-a4'];
const DESIGNS: readonly LayoutDesign[] = ['standard', 'grid_bilingual'] as LayoutDesign[];
const LOGOS: readonly ResolvedLayout['logo'][] = ['start', 'center', 'end', 'none'];
const SIZES: readonly ResolvedLayout['logoSize'][] = ['s', 'm', 'l'];
const TABLES: readonly ResolvedLayout['tableStyle'][] = ['lines', 'grid', 'striped'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

/** ترتيب الأقسام الافتراضي لكل طابعة/تصميم — نسخة من sectionsFor() في النواة */
export const DEFAULT_SECTIONS: Readonly<Record<'page' | 'grid' | 'thermal', readonly SectionId[]>> = Object.freeze({
  page: Object.freeze(['header', 'info', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'] as SectionId[]),
  grid: Object.freeze(['header', 'info', 'parties', 'items', 'note', 'totals', 'installments', 'signatures', 'footer'] as SectionId[]),
  thermal: Object.freeze(['header', 'info', 'customer', 'items', 'totals', 'signatures', 'qr', 'footer'] as SectionId[]),
});

function defaultSections(printer: PrinterType, design: LayoutDesign = 'standard' as LayoutDesign): readonly SectionId[] {
  if (printer === 'thermal') return DEFAULT_SECTIONS.thermal;
  return design === 'grid_bilingual' ? DEFAULT_SECTIONS.grid : DEFAULT_SECTIONS.page;
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback);

/** ترتيب محفوظ يُقبل كما هو إن كان تبديلاً تاماً لأقسام التصميم؛ وإلا فالافتراضي (التطبيع الكامل مهمة canonicalPrintSettings في النواة) */
function sanitizeOrder(order: unknown, allowed: readonly SectionId[]): readonly SectionId[] {
  if (!Array.isArray(order) || order.length !== allowed.length) return allowed;
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== 'string' || !allowed.includes(id as SectionId) || seen.has(id)) return allowed;
    seen.add(id);
  }
  return Object.freeze(order.slice() as SectionId[]);
}

/** null ⇒ مسار اليوم دون أي مساس (لا ملف، ملف legacy، roll_classic، أو بلا options.layout). */
export function resolveLayout(profile: PrintProfile | null | undefined): ResolvedLayout | null {
  if (!profile || !profile.options) return null;
  if (LEGACY_IDS.includes(profile.id) || profile.template === 'roll_classic') return null;
  const raw = (profile.options as { layout?: unknown }).layout as Partial<Record<keyof ResolvedLayout, unknown>> | null | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const printer = profile.printer;
  const thermal = printer === 'thermal';
  // الرول: تصميم قياسي وحده، شعار في الوسط أو بلا شعار، وجدول بخطوط (B2) — دفاعياً حتى لو مرّ مسودّة محرّر
  const design: LayoutDesign = thermal ? 'standard' as LayoutDesign : pick(raw.design, DESIGNS, 'standard' as LayoutDesign);
  const grid = design === 'grid_bilingual';
  let logo = pick(raw.logo, LOGOS, grid || thermal ? 'center' : 'start');
  if (thermal && logo !== 'none') logo = 'center';
  const tableStyle = thermal ? 'lines' : grid ? 'grid' : pick(raw.tableStyle, TABLES, 'lines');
  const accent = typeof raw.accent === 'string' && HEX.test(raw.accent) ? raw.accent : null;
  const fs = Number((profile.options as { fontScale?: unknown }).fontScale);
  return {
    design, logo, logoSize: pick(raw.logoSize, SIZES, 'm'), accent, tableStyle,
    fontScale: Number.isFinite(fs) && fs > 0 ? fs : 1,
    order: sanitizeOrder(raw.order, defaultSections(printer, design)),
    printer,
  };
}

/** null ⇒ ترتيب sectionsFor() الافتراضي */
export function orderedSections(layout: ResolvedLayout | null, printer: PrinterType, design?: LayoutDesign): readonly SectionId[] {
  if (!layout) return defaultSections(printer, design);
  return layout.order;
}

// أحجام الشعار — اليوم في RepDocuments Header: classic 42، banner 46، minimal 34؛ والرول max-width 60%
const TODAY_PAGE_LOGO: Readonly<Record<'classic' | 'banner' | 'minimal', number>> = { classic: 42, banner: 46, minimal: 34 };
const PAGE_LOGO: Readonly<Record<ResolvedLayout['logoSize'], number>> = { s: 34, m: 42, l: 56 };
const GRID_LOGO: Readonly<Record<ResolvedLayout['logoSize'], number>> = { s: 48, m: 64, l: 84 };
/** للرول: px = نسبة max-width المئوية للشعار (اليوم 60%) — 60/80/100% منها */
const TODAY_ROLL_LOGO = 60;
const ROLL_LOGO: Readonly<Record<ResolvedLayout['logoSize'], number>> = { s: 36, m: 48, l: 60 };

/**
 * صندوق الشعار. null ⇒ قيم اليوم (الصفحة: الحجم حسب شكل الترويسة والمحاذاة 'start'). show=true لا يتجاوز look.showLogo
 * ولا شعار الشركة — المستهلك يجمعهما. للهدف 'roll' تعني px نسبة max-width المئوية (اليوم 60).
 */
export function logoBox(layout: ResolvedLayout | null, headerStyle: 'classic' | 'banner' | 'minimal', target: 'page' | 'grid' | 'roll'):
  { show: boolean; align: 'start' | 'center' | 'end'; px: number } {
  if (!layout) {
    if (target === 'grid') return { show: true, align: 'center', px: GRID_LOGO.m };
    if (target === 'roll') return { show: true, align: 'center', px: TODAY_ROLL_LOGO };
    return { show: true, align: 'start', px: TODAY_PAGE_LOGO[headerStyle] ?? TODAY_PAGE_LOGO.classic };
  }
  const table = target === 'grid' ? GRID_LOGO : target === 'roll' ? ROLL_LOGO : PAGE_LOGO;
  const px = table[layout.logoSize] ?? table.m;
  if (layout.logo === 'none') return { show: false, align: target === 'page' ? 'start' : 'center', px };
  const align = target === 'roll' ? 'center' : layout.logo;
  return { show: true, align, px };
}

/** mono ⇒ '#000'؛ بلا تخطيط أو بلا لون مختار ⇒ لون الشركة (كاليوم) ثم البديل */
export function accentColor(layout: ResolvedLayout | null, companyPrimary: string | null | undefined, mono: boolean, fallback: string): string {
  if (mono) return '#000';
  if (layout?.accent && HEX.test(layout.accent)) return layout.accent;
  return companyPrimary || fallback;
}

/** أنماط الجدول — null أو 'lines' ⇒ {} (أنماط اليوم في القالب كما هي). mono: حدود #000 فقط بلا تعبئة رمادية (عتبة النقطية 160). */
export function tableCss(layout: ResolvedLayout | null, mono: boolean): { table: CSSProps; th: CSSProps; td: CSSProps; rowAlt: CSSProps | null } {
  if (!layout || layout.tableStyle === 'lines') return { table: {}, th: {}, td: {}, rowAlt: null };
  const ink = mono || layout.design === 'grid_bilingual' ? '#000' : '#d1d5db';
  const rule = `1px solid ${ink}`;
  if (layout.tableStyle === 'grid') {
    return {
      table: { borderCollapse: 'collapse', border: rule },
      th: { border: rule },
      td: { border: rule },
      rowAlt: null,
    };
  }
  // striped: صفوف متناوبة بتعبئة فاتحة؛ وعلى mono تصير خطوطاً سوداء رفيعة
  if (mono) {
    return { table: { borderCollapse: 'collapse' }, th: { borderBottom: '1px solid #000' }, td: { borderBottom: '1px solid #000' }, rowAlt: null };
  }
  return { table: { borderCollapse: 'collapse' }, th: {}, td: {}, rowAlt: { background: '#f9fafb' } };
}

/** undefined ⇒ لا تكبير (بلا تخطيط أو fontScale=1) — فتبقى الملفات القديمة كاليوم حرفياً */
export function scaleStyle(layout: ResolvedLayout | null): CSSProps | undefined {
  if (!layout || !Number.isFinite(layout.fontScale) || layout.fontScale === 1) return undefined;
  return { zoom: layout.fontScale };
}

/** الكمية بأربع منازل كحدّ أقصى، بلا أصفار زائدة، بأرقام لاتينية (نصف-لأعلى) */
export function fmtQty4(q: number): string {
  const n = Number(q);
  if (!Number.isFinite(n)) return '0';
  const s = roundHalfUp(n, 4).toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

/** ضريبة السطر: taxAmt المخزّنة إن وُجدت، وإلا تُشتق من lineTotal (شامل أو غير شامل) بتقريب نصف-لأعلى لمنزلتين */
export function lineVat(it: { taxAmt?: number | null; lineTotal: number; taxPct: number }, inclusive: boolean): number {
  if (it.taxAmt != null && Number.isFinite(Number(it.taxAmt))) return Number(it.taxAmt);
  const total = Number(it.lineTotal) || 0;
  const pct = Number(it.taxPct) || 0;
  if (pct <= 0) return 0;
  const vat = inclusive ? total - (total * 100) / (100 + pct) : (total * pct) / 100;
  return roundHalfUp(vat, 2);
}

/** أقسام الرول بالترتيب المطلوب — يتخطى الغائب والفارغ */
export function rollSectionsHtml(order: readonly SectionId[], parts: Partial<Record<SectionId, string>>): string {
  let out = '';
  for (const id of order) {
    const html = parts[id];
    if (typeof html === 'string' && html !== '') out += html;
  }
  return out;
}

// خصائص بلا وحدة (لا يُلحق بها px)
const UNITLESS = new Set(['zoom', 'lineHeight', 'fontWeight', 'opacity', 'flex', 'flexGrow', 'flexShrink', 'zIndex', 'order']);

/** CSSProps ⇒ نص style للقوالب النصية (الرول): camelCase ⇒ kebab، والأرقام ⇒ px إلا الخصائص بلا وحدة */
export function cssText(p: CSSProps): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue;
    const prop = k.replace(/^(Webkit|Moz|ms)(?=[A-Z])/, m => `-${m.toLowerCase()}`).replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
    const val = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
    out.push(`${prop}:${val}`);
  }
  return out.join(';');
}
