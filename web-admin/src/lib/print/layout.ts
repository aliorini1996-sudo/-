// ============================================================================
// محرّك «تخطيط المطبوعات» (pl_spec v2 — C(iii)) — طلب المالك ٣ نوفمبر ٢٠٢٦: مكان الشعار وحجمه ولون التمييز وشكل الجدول
// وترتيب الأقسام لكل قالب طباعة. دوالّ خالصة بلا React ولا DOM، يستهلكها A4 (RepDocuments) والقالب ثنائي اللغة (printGrid)
// والرول (thermalHtml) عبر HTML نصّي.
//
// القاعدة الذهبية: resolveLayout(...) === null ⇒ مسار اليوم حرفياً (لا ملف، ملف افتراضي legacy، roll_classic، أو بلا options.layout)،
// وكل دالة هنا تعيد مع null قيم اليوم بالضبط ({} / null / undefined) — حرّاس *.baseline.test.* تثبت ذلك.
//
// التحرير الحرّ (pd_spec C.(ii)، طلب المالك ٣ نوفمبر ٢٠٢٦): أربعة مفاتيح اختيارية (logoMm/logoAfter/sections/canvas) تُقرأ دفاعياً،
// وكل دالة لها (hasFreeLayout/logoPlan/sectionLook/qrOrphan/resolveCanvas…) تعيد null أو {} لتخطيطٍ بلا أيٍّ منها — فتخطيط
// المفاتيح الستة يطبع كما في 8696ef7 حرفياً (rep/printLayout6.baseline.test.ts).
//
// الاستيراد من النواة type-only عمداً: لا يتوقف هذا الملف على ترتيب وصول حزم البناء، وقائمة الأقسام الافتراضية نسخة محلية
// يحرسها layout.test.ts بمقارنتها مع sectionsFor() في النواة متى وُجدت.
// ============================================================================

import type { PrintProfile, PrinterType, LayoutDesign, SectionId, Align, SectionStyle, CanvasBox, CanvasBoxId, CanvasBand, PrintCanvas } from './printSettingsCore';
import { roundHalfUp } from '../money';

export type CSSProps = Record<string, string | number>;

export interface ResolvedLayout {
  design: LayoutDesign; logo: 'start' | 'center' | 'end' | 'none'; logoSize: 's' | 'm' | 'l';
  accent: string | null; tableStyle: 'lines' | 'grid' | 'striped'; fontScale: number;
  order: readonly SectionId[]; printer: PrinterType;
  // ─── التحرير الحرّ (pd_spec C.(ii)) — كل مفتاح يُضاف فقط حين يوجد ويصحّ؛ غياب الأربعة = تخطيط المفاتيح الستة حرفياً ───
  logoMm?: number;
  logoAfter?: SectionId | 'top';
  sections?: Partial<Record<SectionId, SectionStyle>>;
  canvas?: PrintCanvas;
  /** سقف مجموع اللوحتين على ورقٍ قصير (A5، نصف الصفحة المتصلة) — يوجد مع canvas حين يقلّ عن 200 وحده (paperBandsTotal) */
  bandsTotalMm?: number;
}

// ─── نسخ محلية من ثوابت النواة (C(i)) — يحرسها layout.test.ts مقابل printSettingsCore متى صدّرها ───

const LEGACY_IDS: readonly string[] = ['legacy-58', 'legacy-a4'];
const DESIGNS: readonly LayoutDesign[] = ['standard', 'grid_bilingual'] as LayoutDesign[];
const LOGOS: readonly ResolvedLayout['logo'][] = ['start', 'center', 'end', 'none'];
const SIZES: readonly ResolvedLayout['logoSize'][] = ['s', 'm', 'l'];
const TABLES: readonly ResolvedLayout['tableStyle'][] = ['lines', 'grid', 'striped'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

// نسخ ثوابت التحرير الحرّ من النواة (C.(i)) — النواة تُستورد type-only عمداً؛ يحرسها layout.test.ts مقابل printSettingsCore
const ALIGN_IDS: readonly Align[] = ['start', 'center', 'end'];
const BAND_IDS: readonly CanvasBand[] = ['header', 'footer'];
const BOX_IDS: readonly CanvasBoxId[] = ['logo', 'company', 'title', 'docInfo', 'customer', 'qr', 'totals', 'signatures', 'footer'];
const FOOTER_ONLY: readonly CanvasBoxId[] = ['totals', 'signatures'];
const LOCKED: readonly SectionId[] = ['items', 'qr'];
const CONTENT_MM: Readonly<Record<'page' | 'impact', number>> = Object.freeze({ page: 188, impact: 201 });
const BOUNDS = Object.freeze({
  logoMm: [6, 120] as const, fontPct: [70, 160] as const, spaceMm: [0, 30] as const,
  headerMm: [0, 150] as const, footerMm: [0, 120] as const, bandsTotalMm: 200,
  boxMinMm: 5, qrBoxMinMm: 47, maxBoxes: 9, stepMm: 0.5,
  minItemsMm: 40,
});
/** للحارس في layout.test.ts وحده — المستهلكون يستوردون الثوابت من النواة */
export const ENGINE_CORE_COPIES = Object.freeze({
  ALIGNS: ALIGN_IDS, CANVAS_BANDS: BAND_IDS, CANVAS_BOX_IDS: BOX_IDS, CANVAS_FOOTER_ONLY: FOOTER_ONLY, LOCKED_VISIBLE: LOCKED,
  CANVAS_CONTENT_MM: CONTENT_MM, LAYOUT_BOUNDS: BOUNDS,
});

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
  // الرول: تصميم قياسي وحده (B2) — والشعار بمواضعه الأربعة وأشكال الجدول الثلاثة منذ التحرير الحرّ (pd_spec B.1/B.3)
  const design: LayoutDesign = thermal ? 'standard' as LayoutDesign : pick(raw.design, DESIGNS, 'standard' as LayoutDesign);
  const grid = design === 'grid_bilingual';
  const logo = pick(raw.logo, LOGOS, grid || thermal ? 'center' : 'start');
  const tableStyle = grid ? 'grid' : pick(raw.tableStyle, TABLES, 'lines');
  const accent = typeof raw.accent === 'string' && HEX.test(raw.accent) ? raw.accent : null;
  const fs = Number((profile.options as { fontScale?: unknown }).fontScale);
  const out: ResolvedLayout = {
    design, logo, logoSize: pick(raw.logoSize, SIZES, 'm'), accent, tableStyle,
    fontScale: Number.isFinite(fs) && fs > 0 ? fs : 1,
    order: sanitizeOrder(raw.order, defaultSections(printer, design)),
    printer,
  };
  resolveFreeKeys(out, raw as Record<string, unknown>);
  if (out.canvas) {
    const total = paperBandsTotal((profile as { paper?: unknown }).paper);
    if (total < BOUNDS.bandsTotalMm) out.bandsTotalMm = total;
  }
  return out;
}

/**
 * نسخة bandsTotalFor من النواة (يحرسها layout.test.ts): سقف مجموع اللوحتين = 200، ولا أكثر من طول الصفحة بعد الهامشين و40 مم
 * للأصناف؛ الرول وما بلا طول 200، وA4 لا يتغيّر. على شبكة 0.5 للأسفل.
 */
export function paperBandsTotal(paper: unknown): number {
  if (!paper || typeof paper !== 'object') return BOUNDS.bandsTotalMm;
  const pp = paper as { feed?: unknown; lengthMm?: unknown; marginTopMm?: unknown; marginBottomMm?: unknown };
  if (pp.feed === 'roll' || typeof pp.lengthMm !== 'number' || !Number.isFinite(pp.lengthMm)) return BOUNDS.bandsTotalMm;
  const m = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const room = pp.lengthMm - m(pp.marginTopMm) - m(pp.marginBottomMm) - BOUNDS.minItemsMm;
  return Math.min(BOUNDS.bandsTotalMm, Math.max(0, Math.floor(room / BOUNDS.stepMm + 1e-9) * BOUNDS.stepMm));
}

// ─── التحرير الحرّ: قراءة دفاعية للمفاتيح الأربعة (المعيب يسقط وحده — لا التخطيط ولا جيرانه؛ التطبيع الكامل مهمة النواة) ───

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (v: unknown, [lo, hi]: readonly [number, number]): v is number => isNum(v) && v >= lo && v <= hi;
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const r2 = (n: number): number => Math.round(n * 100) / 100;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanStyle(id: SectionId, raw: unknown): SectionStyle | null {
  if (!isObj(raw)) return null;
  const out: SectionStyle = {};
  if (raw.visible === false && !LOCKED.includes(id)) out.visible = false;
  if (typeof raw.align === 'string' && (ALIGN_IDS as readonly string[]).includes(raw.align)) out.align = raw.align as Align;
  if (within(raw.fontPct, BOUNDS.fontPct)) out.fontPct = Math.round(raw.fontPct);
  if (within(raw.spaceBeforeMm, BOUNDS.spaceMm)) out.spaceBeforeMm = raw.spaceBeforeMm;
  if (within(raw.spaceAfterMm, BOUNDS.spaceMm)) out.spaceAfterMm = raw.spaceAfterMm;
  return Object.keys(out).length ? Object.freeze(out) : null;
}

/** اللوحتان كما حُفظتا (القصّ في resolveCanvas): أطوالٌ في حدودها، ومربعاتٌ معروفة بأرقامٍ منتهية بلا تكرار، 9 على الأكثر */
function cleanCanvas(raw: unknown): PrintCanvas | null {
  if (!isObj(raw) || !within(raw.headerMm, BOUNDS.headerMm) || !within(raw.footerMm, BOUNDS.footerMm) || !Array.isArray(raw.boxes)) return null;
  const boxes: CanvasBox[] = [];
  const seen = new Set<string>();
  for (const x of raw.boxes.slice(0, BOUNDS.maxBoxes) as unknown[]) {
    if (!isObj(x)) continue;
    if (typeof x.id !== 'string' || !(BOX_IDS as readonly string[]).includes(x.id) || seen.has(x.id)) continue;
    if (typeof x.band !== 'string' || !(BAND_IDS as readonly string[]).includes(x.band)) continue;
    if (!isNum(x.x) || !isNum(x.y) || !isNum(x.w) || !isNum(x.h)) continue;
    seen.add(x.id);
    const box: CanvasBox = { id: x.id as CanvasBoxId, band: x.band as CanvasBand, x: x.x, y: x.y, w: x.w, h: x.h };
    if (typeof x.align === 'string' && (ALIGN_IDS as readonly string[]).includes(x.align)) box.align = x.align as Align;
    if (within(x.fontPct, BOUNDS.fontPct)) box.fontPct = Math.round(x.fontPct);
    boxes.push(Object.freeze(box));
  }
  return Object.freeze({ headerMm: raw.headerMm, footerMm: raw.footerMm, boxes: Object.freeze(boxes) as CanvasBox[] });
}

function resolveFreeKeys(out: ResolvedLayout, raw: Record<string, unknown>): void {
  const allowed = defaultSections(out.printer, out.design);
  if (within(raw.logoMm, BOUNDS.logoMm)) out.logoMm = raw.logoMm;
  if (raw.logoAfter === 'top' || (typeof raw.logoAfter === 'string' && allowed.includes(raw.logoAfter as SectionId))) out.logoAfter = raw.logoAfter as SectionId | 'top';
  const rs = raw.sections;
  if (isObj(rs)) {
    const sections: Partial<Record<SectionId, SectionStyle>> = {};
    for (const id of allowed) {
      const st = cleanStyle(id, rs[id]);
      if (st) sections[id] = st;
    }
    if (Object.keys(sections).length) out.sections = Object.freeze(sections);
  }
  if (out.printer !== 'thermal' && out.design === 'standard') {
    const c = cleanCanvas(raw.canvas);
    if (c) out.canvas = c;
  }
}

/** أيّ مفتاحٍ من المفاتيح الحرّة الأربعة — false ⇒ كل مستهلكٍ على مساره قبل التحرير الحرّ حرفياً */
export function hasFreeLayout(l: ResolvedLayout | null): boolean {
  return !!l && (l.logoMm !== undefined || l.logoAfter !== undefined || l.sections !== undefined || l.canvas !== undefined);
}

// ─── الوحدات: مم الورقة على قالب 794 بكسل (96 بكسل/بوصة) ───
export const MM_PX = 96 / 25.4;
export const mmToPx = (mm: number): number => Math.round(mm * MM_PX * 100) / 100;

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
  return { show: true, align: layout.logo, px };
}

// ─── الشعار الحرّ (B.2) ───

export interface LogoPlan { show: boolean; align: Align; maxWmm: number; maxHmm: number; maxPx: number; at: 'header' | 'top' | SectionId }

/** حدود logoMm لكل هدف: الصفحة والثنائي 6–120 (وعرض المحتوى أوسع منها)، والرول 6–عرض الحزمة المطبوعة وحتى 80 */
export function logoMmBounds(target: 'page' | 'grid' | 'roll', printableMm?: number): readonly [number, number] {
  const [lo, hi] = BOUNDS.logoMm;
  if (target !== 'roll') return [lo, Math.min(hi, CONTENT_MM.page)];
  const band = isNum(printableMm) && printableMm > 0 ? printableMm : 80;
  return [lo, Math.max(lo, Math.min(80, band, hi))];
}

/**
 * خطة الشعار — null ⇒ logoBox (حجم اليوم s/m/l ومكانه داخل الترويسة). غير null فقط مع logoMm أو logoAfter.
 * maxWmm/maxHmm: صندوقٌ أقصى (max-width/max-height مع width/height:auto — لا object-fit). بلا logoMm: حجم اليوم بالمم
 * (الصفحة والثنائي: بكسل logoBox؛ الرول: نسبة العرض من الحزمة وارتفاع 16 مم بالنسبة نفسها). show=true لا يتجاوز look.showLogo.
 */
export function logoPlan(l: ResolvedLayout | null, headerStyle: 'classic' | 'banner' | 'minimal', target: 'page' | 'grid' | 'roll', printableMm?: number): LogoPlan | null {
  if (!l || (l.logoMm === undefined && l.logoAfter === undefined)) return null;
  const box = logoBox(l, headerStyle, target);
  const [lo, hi] = logoMmBounds(target, printableMm);
  let maxWmm: number;
  let maxHmm: number;
  if (l.logoMm !== undefined) {
    maxWmm = maxHmm = clamp(l.logoMm, lo, hi);
  } else if (target === 'roll') {
    const band = isNum(printableMm) && printableMm > 0 ? printableMm : 48;
    maxWmm = r2(clamp((band * box.px) / 100, lo, hi));
    maxHmm = r2(clamp((16 * box.px) / TODAY_ROLL_LOGO, lo, hi));
  } else {
    maxWmm = maxHmm = r2(box.px / MM_PX);
  }
  const align: Align = l.logo === 'none' ? box.align : l.logo;
  return { show: box.show, align, maxWmm, maxHmm, maxPx: mmToPx(Math.max(maxWmm, maxHmm)), at: l.logoAfter ?? 'header' };
}

// ─── تنسيق الأقسام (B.3) ───

export interface SectionLook { visible: boolean; align: Align | null; fontPct: number; spaceBeforeMm: number; spaceAfterMm: number }

/** null ⇒ لا غلاف (مسار اليوم). مع أيّ مفتاحٍ حرّ: لكل قسمٍ مظهرٌ (الافتراضي ظاهر بلا محاذاة 100٪ بلا مسافات) */
export function sectionLook(l: ResolvedLayout | null, id: SectionId): SectionLook | null {
  if (!l || !hasFreeLayout(l)) return null;
  const s = l.sections?.[id];
  return {
    visible: LOCKED.includes(id) ? true : s?.visible !== false,
    align: s?.align ?? null,
    fontPct: s?.fontPct ?? 100,
    spaceBeforeMm: s?.spaceBeforeMm ?? 0,
    spaceAfterMm: s?.spaceAfterMm ?? 0,
  };
}

/** start = يمين الورقة (RTL) — قيمة فعلية لا منطقية، فيتطابق المتصفح وhtml2canvas وتسميات المحرّر «يمين/وسط/يسار» */
export const physicalAlign = (a: Align): 'right' | 'center' | 'left' => (a === 'start' ? 'right' : a === 'end' ? 'left' : 'center');

/** المحاذاة والمسافتان بالبكسل — لا zoom ولا fontSize أبداً (الخط بـfontPx). القيم الافتراضية لا تُكتب: {} = غلاف بلا style */
export function sectionCss(s: SectionLook): CSSProps {
  const out: CSSProps = {};
  if (s.align) out.textAlign = physicalAlign(s.align);
  if (s.spaceBeforeMm > 0) out.marginTop = mmToPx(s.spaceBeforeMm);
  if (s.spaceAfterMm > 0) out.marginBottom = mmToPx(s.spaceAfterMm);
  return out;
}

/** مثل sectionCss نصّاً للرول (بالمم) — '' بلا شيء */
export function sectionCssText(s: SectionLook): string {
  const out: string[] = [];
  if (s.align) out.push(`text-align:${physicalAlign(s.align)}`);
  if (s.spaceBeforeMm > 0) out.push(`margin-top:${r2(s.spaceBeforeMm)}mm`);
  if (s.spaceAfterMm > 0) out.push(`margin-bottom:${r2(s.spaceAfterMm)}mm`);
  return out.join(';');
}

/** حجم الخط بضرب بكسل القالب في النسبة — بلا مظهر أو 100٪ ⇒ الرقم نفسه حرفياً */
export function fontPx(px: number, s: SectionLook | null): number {
  if (!s || s.fontPct === 100 || !isNum(s.fontPct)) return px;
  return r2((px * s.fontPct) / 100);
}

/** orderedSections ناقص المخفيّ — الأصناف ورمز الرول لا يُحذفان أبداً */
export function visibleOrder(l: ResolvedLayout | null, printer: PrinterType, design?: LayoutDesign): readonly SectionId[] {
  const order = orderedSections(l, printer, design);
  const sections = l?.sections;
  if (!sections) return order;
  return order.filter((id) => LOCKED.includes(id) || sections[id]?.visible !== false);
}

/** القسم الذي يحمل رمز QR: الرول قسمه، والثنائي «البيانات»، والقياسي «الإجماليات» */
export function qrHost(printer: PrinterType, design: LayoutDesign): SectionId {
  if (printer === 'thermal') return 'qr';
  return design === 'grid_bilingual' ? 'info' : 'totals';
}

/**
 * هل يُطبع رمز QR كتلةً مستقلة لأن قسمه مخفي (القياسي: بعد الأصناف؛ الثنائي: بعد الترويسة). لا يقع في الرول (قسمه لا يُخفى)،
 * ولا حين يضع المصمّم مربع QR في لوحةٍ قائمة (هناك يُطبع).
 */
export function qrOrphan(l: ResolvedLayout | null, printer: PrinterType, design: LayoutDesign): boolean {
  if (!l?.sections || printer === 'thermal') return false;
  const host = qrHost(printer, design);
  if (l.sections[host]?.visible !== false) return false;
  const c = l.canvas;
  if (c && design === 'standard') {
    const q = c.boxes.find((b) => b.id === 'qr');
    if (q && (q.band === 'header' ? c.headerMm : c.footerMm) > 0) return false;
  }
  return true;
}

// ─── المصمّم الحرّ: لوحتا الرأس والتذييل (B.4) ───

export interface CanvasBoxR extends Required<Omit<CanvasBox, 'align' | 'fontPct'>> { align: Align; fontPct: number; px: { left: number; top: number; width: number; height: number } }
export interface CanvasBandR { band: CanvasBand; hMm: number; hPx: number; boxes: CanvasBoxR[] }
export interface ResolvedCanvas { contentWmm: number; header: CanvasBandR | null; footer: CanvasBandR | null; placed: ReadonlySet<CanvasBoxId>; hostOf: Readonly<Record<CanvasBoxId, SectionId>> }

/** مضيف كل مربع في التدفّق: ما لم يوضع في لوحةٍ يُطبع في قسمه */
const HOST_OF: Readonly<Record<CanvasBoxId, SectionId>> = Object.freeze({
  logo: 'header', company: 'header', title: 'header', docInfo: 'info', customer: 'info',
  qr: 'totals', totals: 'totals', signatures: 'signatures', footer: 'footer',
});

/** أقرب مضاعفٍ للخطوة (0.5 افتراضاً) — بلا -0 ولا كسور عائمة */
export function snapMm(v: number, step: number = BOUNDS.stepMm): number {
  if (!isNum(v)) return 0;
  const st = isNum(step) && step > 0 ? step : BOUNDS.stepMm;
  const r = Math.round(Math.round(v / st) * st * 1000) / 1000;
  return r === 0 ? 0 : r;
}

/** أكبر مضاعفٍ لخطوة الشبكة لا يتجاوز الحدّ */
const floorStep = (lim: number): number => Math.max(0, Math.floor(lim / BOUNDS.stepMm + 1e-9) * BOUNDS.stepMm);
/** أصغر مضاعفٍ لخطوة الشبكة لا ينقص عن الحدّ */
const ceilStep = (lim: number): number => Math.ceil(lim / BOUNDS.stepMm - 1e-9) * BOUNDS.stepMm;

/**
 * المربع داخل لوحته وعرض المحتوى، بأبعاد ≥ minMm على شبكة 0.5 (غير المنتهي ⇒ 0 أو minMm). لوحةٌ أقصر من minMm تقصّ الارتفاع
 * إليها (والمستدعي يكبّر اللوحة إن أراد الحدّ).
 */
export function clampBox(b: CanvasBox, bandHmm: number, contentWmm: number, minMm: number): CanvasBox {
  const W = floorStep(isNum(contentWmm) && contentWmm > 0 ? contentWmm : CONTENT_MM.page);
  const H = floorStep(isNum(bandHmm) && bandHmm > 0 ? bandHmm : 0);
  const min = ceilStep(isNum(minMm) && minMm > 0 ? minMm : BOUNDS.boxMinMm);
  const w = clamp(snapMm(isNum(b.w) ? b.w : min), Math.min(min, W), W);
  const h = clamp(snapMm(isNum(b.h) ? b.h : min), Math.min(min, H), H);
  const x = clamp(snapMm(isNum(b.x) ? b.x : 0), 0, floorStep(W - w));
  const y = clamp(snapMm(isNum(b.y) ? b.y : 0), 0, floorStep(H - h));
  return { ...b, x, y, w, h };
}

/**
 * اللوحتان جاهزتين للرسم — null بلا canvas أو على الرول/الثنائي أو بلوحتين صفريتين. يقصّ المربعات داخل المحتوى واللوحة، ويكبّر
 * مربع QR إلى qrMinMm (وحدّ القراءة 47 مم) ويكبّر لوحته لتسعه، ويُسقط QR من سند القبض والمربع المعيب أو المكرر، ومربعاً في لوحةٍ
 * صفرية، و«تذييلياً» في الرأس — فيعود كلٌّ منها إلى مكانه في التدفّق (placed لا يحمله).
 */
export function resolveCanvas(l: ResolvedLayout | null, ctx: { printer: 'page' | 'impact'; qrMinMm: number; kind: 'invoice' | 'receipt' }): ResolvedCanvas | null {
  const c = l?.canvas;
  if (!l || !c || l.printer === 'thermal' || l.design !== 'standard') return null;
  const W = CONTENT_MM[ctx.printer] ?? CONTENT_MM.page;
  const qrSide = Math.min(floorStep(W), ceilStep(Math.max(BOUNDS.qrBoxMinMm, isNum(ctx.qrMinMm) ? ctx.qrMinMm : 0)));
  const bandH: Record<CanvasBand, number> = {
    header: snapMm(clamp(isNum(c.headerMm) ? c.headerMm : 0, 0, BOUNDS.headerMm[1])),
    footer: snapMm(clamp(isNum(c.footerMm) ? c.footerMm : 0, 0, BOUNDS.footerMm[1])),
  };
  // سقف المجموع: 200، أو أقل على الورق القصير (bandsTotalMm من resolveLayout) — التذييل يُقصّ أولاً ثم الرأس
  const total = isNum(l.bandsTotalMm) ? clamp(l.bandsTotalMm, 0, BOUNDS.bandsTotalMm) : BOUNDS.bandsTotalMm;
  if (bandH.header > total) bandH.header = total;
  if (bandH.header + bandH.footer > total) bandH.footer = Math.max(0, total - bandH.header);
  const kept: CanvasBox[] = [];
  const seen = new Set<CanvasBoxId>();
  for (const b of c.boxes.slice(0, BOUNDS.maxBoxes)) {
    if (!b || !BOX_IDS.includes(b.id) || !BAND_IDS.includes(b.band) || seen.has(b.id)) continue;
    if (![b.x, b.y, b.w, b.h].every(isNum)) continue;
    if (b.id === 'qr' && ctx.kind === 'receipt') continue;
    if (b.band === 'header' && FOOTER_ONLY.includes(b.id)) continue;
    if (bandH[b.band] <= 0) continue;
    seen.add(b.id);
    kept.push(b.id === 'qr' ? { ...b, w: Math.max(b.w, qrSide), h: Math.max(b.h, qrSide) } : b);
  }
  // رمز QR لا يصغر عن حدّ القراءة: تكبر لوحته لتسعه (ولو تجاوزت حدّها — الرمز أولى من الحدّ)
  const q = kept.find((b) => b.id === 'qr');
  if (q) {
    const y = clamp(snapMm(q.y), 0, floorStep(Math.max(0, bandH[q.band] - BOUNDS.boxMinMm)));
    bandH[q.band] = Math.max(bandH[q.band], ceilStep(y + q.h), ceilStep(qrSide));
  }
  const resolveBox = (b: CanvasBox): CanvasBoxR => {
    const k = clampBox(b, bandH[b.band], W, b.id === 'qr' ? qrSide : BOUNDS.boxMinMm);
    return {
      id: k.id, band: k.band, x: k.x, y: k.y, w: k.w, h: k.h,
      align: k.align && ALIGN_IDS.includes(k.align) ? k.align : 'start',
      fontPct: within(k.fontPct, BOUNDS.fontPct) ? Math.round(k.fontPct) : 100,
      px: { left: mmToPx(k.x), top: mmToPx(k.y), width: mmToPx(k.w), height: mmToPx(k.h) },
    };
  };
  const band = (id: CanvasBand): CanvasBandR | null => {
    if (bandH[id] <= 0) return null;
    const boxes = kept.filter((b) => b.band === id).sort((a, b) => BOX_IDS.indexOf(a.id) - BOX_IDS.indexOf(b.id)).map(resolveBox);
    return { band: id, hMm: bandH[id], hPx: mmToPx(bandH[id]), boxes };
  };
  const header = band('header');
  const footer = band('footer');
  if (!header && !footer) return null;
  return { contentWmm: W, header, footer, placed: new Set(kept.map((b) => b.id)), hostOf: HOST_OF };
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
