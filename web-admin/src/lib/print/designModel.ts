// ============================================================================
// نموذج «التحرير الحرّ» للمطبوعات (pd_spec C.(ii)) — طلب المالك ٣ نوفمبر ٢٠٢٦: حجم الشعار ومكانه بحرّية، وتنسيق كل قسم، والمصمّم
// بالسحب (لوحتا رأس الورقة وتذييلها في A4 والنقطية). دوالّ خالصة بلا React ولا DOM، تكتب كلها عبر withLayout فقط؛ أدوات المحرّر
// (PrintDesignTools) والمصمّم (components/print/designer) يعدّلان الكائن نفسه.
//
// القواعد: تعديلٌ بلا أثر يعيد القالب نفسه (لا يُنشئ layout)، والقيم الافتراضية لا تُكتب (ظاهر/100٪/0 مم)، ومحو آخر مفتاحٍ حرّ يترك
// تخطيط المفاتيح الستة كما هو. القيم تُقصّ إلى حدود النواة (LAYOUT_BOUNDS) وتُلصق بشبكة 0.5 مم — والخادم يتحقّق منها ثانيةً.
// الملفّان الافتراضيان والكلاسيكي لا يحملان تخطيطاً (withLayout يرفضهما) — الكلاسيكي يُحرَّر بنسخته editableClassicCopy.
// ============================================================================

import {
  CANVAS_BANDS, CANVAS_BOX_IDS, CANVAS_CONTENT_MM, CANVAS_FOOTER_ONLY, LAYOUT_BOUNDS, LEGACY_THERMAL_ID, LOCKED_VISIBLE, LOGO_POSITIONS,
  ALIGNS, defaultPrintLayout, isLegacyProfileId, layoutIssues, layoutOf, printableMm, sectionsFor, uniqueProfileId, uniqueProfileName,
  withLayout,
  type CanvasBand, type CanvasBox, type CanvasBoxId, type LogoPosition, type PrintCanvas, type PrintLayout, type PrintProfile,
  type PrintSettingsV1, type SectionId, type SectionStyle,
} from './printSettings';
import { clampBox, logoBox, logoMmBounds, resolveLayout, snapMm } from './layout';

/** ما يُحدَّد في المحرّر والمصمّم: قسم، أو الشعار، أو مربع في لوحة، أو لوحة */
export type DesignSel = SectionId | 'logo' | `box:${CanvasBoxId}` | 'band:header' | 'band:footer';

// ─── أدوات داخلية ───

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const B = LAYOUT_BOUNDS;
const STEP = B.stepMm;
const floorStep = (v: number): number => Math.max(0, Math.floor(v / STEP + 1e-9) * STEP);
const ceilStep = (v: number): number => Math.ceil(v / STEP - 1e-9) * STEP;

/** نصّ JSON بمفاتيح مرتّبة — لمقارنة «هل تغيّر شيء» بلا اعتبارٍ لترتيب المفاتيح */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const editable = (p: PrintProfile): boolean => !isLegacyProfileId(p.id) && p.template !== 'roll_classic';
const canvasCapable = (p: PrintProfile): boolean => p.printer !== 'thermal' && layoutOf(p).design === 'standard';
const contentW = (p: PrintProfile): number => CANVAS_CONTENT_MM[p.printer === 'impact' ? 'impact' : 'page'];

/** نسخة عميقة من التخطيط الفعّال (المحفوظ أو الافتراضي) */
const currentLayout = (p: PrintProfile): PrintLayout => JSON.parse(JSON.stringify(layoutOf(p))) as PrintLayout;

/**
 * يكتب التخطيط التالي كاملاً عبر withLayout — أو يعيد القالب نفسه إن لم يتغيّر شيء (فلا يولد layout من تعديلٍ بلا أثر).
 * المفاتيح الغائبة من next تُحذف فعلاً (لا undefined): التخطيط يُبنى من جديد فوق قالبٍ بلا تخطيط.
 */
function commit(p: PrintProfile, next: PrintLayout): PrintProfile {
  if (!editable(p)) return p;
  for (const k of Object.keys(next) as (keyof PrintLayout)[]) if (next[k] === undefined) delete next[k];
  if (stable(next) === stable(layoutOf(p))) return p;
  const bare = withLayout(p, null);
  return withLayout(bare, next);
}

const sectionIds = (p: PrintProfile, l: PrintLayout): readonly SectionId[] => sectionsFor(p.printer, l.design);

// ─── تنسيق الأقسام ───

/** نمطٌ نظيف: مقصوص إلى الحدود، بلا قيمٍ افتراضية (ظاهر/100٪/0)، وبلا إخفاءٍ للأصناف ولا لرمز QR الرول */
function cleanStyle(id: SectionId, s: Partial<SectionStyle>): SectionStyle {
  const out: SectionStyle = {};
  if (s.visible === false && !LOCKED_VISIBLE.includes(id)) out.visible = false;
  if (s.align !== undefined && (ALIGNS as readonly string[]).includes(s.align)) out.align = s.align;
  if (fin(s.fontPct)) {
    const f = Math.round(clamp(s.fontPct, B.fontPct[0], B.fontPct[1]));
    if (f !== 100) out.fontPct = f;
  }
  for (const k of ['spaceBeforeMm', 'spaceAfterMm'] as const) {
    const v = s[k];
    if (fin(v)) {
      const mm = snapMm(clamp(v, B.spaceMm[0], B.spaceMm[1]));
      if (mm > 0) out[k] = mm;
    }
  }
  return out;
}

/**
 * تنسيق قسم: patch يُدمج فوق المحفوظ (قيمة undefined تحذف مفتاحها، والافتراضي يُحذف)، وnull يمحو تنسيق القسم كلّه. قسمٌ ليس
 * من أقسام التصميم يعيد القالب كما هو.
 */
export function withSectionStyle(p: PrintProfile, id: SectionId, patch: Partial<SectionStyle> | null): PrintProfile {
  const l = currentLayout(p);
  if (!sectionIds(p, l).includes(id)) return p;
  const sections: Partial<Record<SectionId, SectionStyle>> = { ...(l.sections ?? {}) };
  if (patch === null) delete sections[id];
  else {
    const merged: Partial<SectionStyle> = { ...(sections[id] ?? {}) };
    for (const [k, v] of Object.entries(patch) as [keyof SectionStyle, unknown][]) {
      if (v === undefined) delete merged[k];
      else (merged as Record<string, unknown>)[k] = v;
    }
    const st = cleanStyle(id, merged);
    if (Object.keys(st).length) sections[id] = st;
    else delete sections[id];
  }
  if (Object.keys(sections).length) l.sections = sections;
  else delete l.sections;
  return commit(p, l);
}

/** «العودة» لقسمٍ واحد (B.7) */
export const resetSection = (p: PrintProfile, id: SectionId): PrintProfile => withSectionStyle(p, id, null);

// ─── الشعار ───

/** حدود حجم الشعار لهذا القالب (الرول: حتى عرض الحزمة المطبوعة و80 مم) */
export function logoMmRange(p: PrintProfile): readonly [number, number] {
  if (p.printer === 'thermal') return logoMmBounds('roll', printableMm(p) ?? undefined);
  return logoMmBounds(layoutOf(p).design === 'grid_bilingual' ? 'grid' : 'page');
}

/** حجم الشعار الفعّال بالمم (المحفوظ أو ما يقابل s/m/l اليوم) — لعرض المنزلقة */
export function logoMmOf(p: PrintProfile): number {
  const l = layoutOf(p);
  const [lo, hi] = logoMmRange(p);
  if (fin(l.logoMm)) return clamp(l.logoMm, lo, hi);
  const r = resolveLayout(p) ?? resolveLayout({ ...p, options: { ...p.options, layout: l } });
  if (p.printer === 'thermal') {
    const pct = logoBox(r, 'classic', 'roll').px;
    return clamp(snapMm(((printableMm(p) ?? 48) * pct) / 100), lo, hi);
  }
  const px = logoBox(r, 'classic', l.design === 'grid_bilingual' ? 'grid' : 'page').px;
  return clamp(snapMm(px / (96 / 25.4)), lo, hi);
}

/**
 * الشعار: logo (المحاذاة أو بلا شعار)، وlogoMm (null يحذفه فيعود حجم s/m/l؛ الرقم يُقصّ ويُلصق بـ0.5)، وlogoAfter (null = داخل
 * الترويسة كاليوم؛ 'top' أو قسمٌ من أقسام التصميم — وغيرهما يُهمل).
 */
export function withLogo(p: PrintProfile, patch: { logo?: LogoPosition; logoMm?: number | null; logoAfter?: SectionId | 'top' | null }): PrintProfile {
  const l = currentLayout(p);
  if (patch.logo !== undefined && (LOGO_POSITIONS as readonly string[]).includes(patch.logo)) l.logo = patch.logo;
  if (patch.logoMm === null) delete l.logoMm;
  else if (fin(patch.logoMm)) {
    const [lo, hi] = logoMmRange(p);
    l.logoMm = clamp(snapMm(patch.logoMm), lo, floorStep(hi));
  }
  if (patch.logoAfter === null) delete l.logoAfter;
  else if (patch.logoAfter === 'top' || (patch.logoAfter !== undefined && sectionIds(p, l).includes(patch.logoAfter))) l.logoAfter = patch.logoAfter;
  return commit(p, l);
}

/** «العودة» للشعار: يحذف logoMm وlogoAfter، والمحاذاة الافتراضية للتصميم */
export function resetLogo(p: PrintProfile): PrintProfile {
  if (!p.options.layout) return p;
  const l = currentLayout(p);
  delete l.logoMm;
  delete l.logoAfter;
  l.logo = defaultPrintLayout(p.printer, l.design).logo;
  return commit(p, l);
}

export function resetSections(p: PrintProfile): PrintProfile {
  if (!p.options.layout?.sections) return p;
  const l = currentLayout(p);
  delete l.sections;
  return commit(p, l);
}

export function resetCanvas(p: PrintProfile): PrintProfile {
  if (!p.options.layout?.canvas) return p;
  const l = currentLayout(p);
  delete l.canvas;
  return commit(p, l);
}

// ─── المصمّم الحرّ: اللوحتان ───

const bandKey = (b: CanvasBand): 'headerMm' | 'footerMm' => (b === 'header' ? 'headerMm' : 'footerMm');
const boxMin = (id: CanvasBoxId): number => (id === 'qr' ? B.qrBoxMinMm : B.boxMinMm);

/** أقصى ارتفاعٍ للوحة مع الأخرى (حدّها، والمجموع 200) */
const bandMax = (c: PrintCanvas, band: CanvasBand): number => {
  const other = band === 'header' ? c.footerMm : c.headerMm;
  return floorStep(Math.min(band === 'header' ? B.headerMm[1] : B.footerMm[1], B.bandsTotalMm - other));
};

/**
 * لوحتان صالحتان بقواعد النواة: أطوالٌ على الشبكة في حدودها (المجموع ≤ 200)، ومربعاتٌ معروفة بلا تكرار، والإجماليات والتواقيع في
 * التذييل، وكل مربعٍ داخل لوحته ≥ 5 مم، ومربع QR ≥ 47 مم (تكبر لوحته إن اتّسع الحدّ، وإلا يعود إلى التدفّق)، ولا مربع في لوحةٍ صفرية.
 */
function sanitizeCanvas(c: PrintCanvas, W: number): PrintCanvas {
  const headerMm = snapMm(clamp(fin(c.headerMm) ? c.headerMm : 0, B.headerMm[0], B.headerMm[1]));
  const footerMm = snapMm(clamp(fin(c.footerMm) ? c.footerMm : 0, B.footerMm[0], Math.min(B.footerMm[1], B.bandsTotalMm - headerMm)));
  const out: PrintCanvas = { headerMm, footerMm, boxes: [] };
  const seen = new Set<CanvasBoxId>();
  const list = Array.isArray(c.boxes) ? c.boxes : [];
  // QR أولاً: قد يكبّر لوحته قبل أن تُقصّ إليها المربعات الأخرى
  const ordered = [...list.filter((b) => b?.id === 'qr'), ...list.filter((b) => b?.id !== 'qr')];
  for (const raw of ordered) {
    if (!raw || !(CANVAS_BOX_IDS as readonly string[]).includes(raw.id) || seen.has(raw.id)) continue;
    if (![raw.x, raw.y, raw.w, raw.h].every(fin)) continue;
    const band: CanvasBand = CANVAS_FOOTER_ONLY.includes(raw.id) ? 'footer'
      : (CANVAS_BANDS as readonly string[]).includes(raw.band) ? raw.band : 'header';
    const min = boxMin(raw.id);
    const key = bandKey(band);
    if (raw.id === 'qr' && out[key] < min) {
      const max = bandMax(out, band);
      if (max < min) continue; // لا يتّسع: يُطبع الرمز في مكانه من التدفّق
      out[key] = ceilStep(min);
    }
    if (out[key] < B.boxMinMm) continue;
    const grown: CanvasBox = raw.id === 'qr' ? { ...raw, band, w: Math.max(raw.w, min), h: Math.max(raw.h, min) } : { ...raw, band };
    const k = clampBox(grown, out[key], W, min);
    const box: CanvasBox = { id: raw.id, band, x: k.x, y: k.y, w: k.w, h: k.h };
    if (raw.align !== undefined && (ALIGNS as readonly string[]).includes(raw.align)) box.align = raw.align;
    if (fin(raw.fontPct)) {
      const f = Math.round(clamp(raw.fontPct, B.fontPct[0], B.fontPct[1]));
      if (f !== 100) box.fontPct = f;
    }
    seen.add(raw.id);
    out.boxes.push(box);
    if (out.boxes.length >= B.maxBoxes) break;
  }
  const rank = (b: CanvasBox): number => CANVAS_BANDS.indexOf(b.band) * 100 + CANVAS_BOX_IDS.indexOf(b.id);
  out.boxes.sort((a, b) => rank(a) - rank(b));
  return out;
}

/** اللوحتان كاملتين (null يحذفهما — يعود كل شيء إلى التدفّق). للصفحة والنقطية بالتصميم القياسي وحده */
export function withCanvas(p: PrintProfile, c: PrintCanvas | null): PrintProfile {
  const l = currentLayout(p);
  if (c === null) {
    if (!l.canvas) return p;
    delete l.canvas;
    return commit(p, l);
  }
  if (!canvasCapable(p)) return p;
  l.canvas = sanitizeCanvas(c, contentW(p));
  return commit(p, l);
}

/**
 * إضافة مربع أو تعديله: يُلصق بالشبكة ويُقصّ داخل لوحته والمحتوى؛ الإجماليات والتواقيع تذهب للتذييل، وQR لا يصغر عن 47 مم؛ واللوحة
 * تكبر لتسع ارتفاع المربع (لا موضعه) في حدودها. بلا لوحتين بعد ⇒ تُنشأ لوحتان صفريتان تكبر منهما لوحة المربع.
 */
export function upsertBox(p: PrintProfile, box: CanvasBox): PrintProfile {
  if (!canvasCapable(p) || !box || !(CANVAS_BOX_IDS as readonly string[]).includes(box.id)) return p;
  const c: PrintCanvas = JSON.parse(JSON.stringify(layoutOf(p).canvas ?? { headerMm: 0, footerMm: 0, boxes: [] })) as PrintCanvas;
  const band: CanvasBand = CANVAS_FOOTER_ONLY.includes(box.id) ? 'footer' : (CANVAS_BANDS as readonly string[]).includes(box.band) ? box.band : 'header';
  const min = boxMin(box.id);
  const h = Math.max(min, snapMm(fin(box.h) ? box.h : min));
  const key = bandKey(band);
  if (c[key] < h) c[key] = Math.max(c[key], Math.min(bandMax(c, band), ceilStep(h)));
  const next: CanvasBox = { ...box, band, w: Math.max(min, fin(box.w) ? box.w : min), h };
  c.boxes = [...c.boxes.filter((b) => b.id !== box.id), next];
  return withCanvas(p, c);
}

/** يعيد المربع إلى مكانه في التدفّق (QR منه: يُطبع مع الإجماليات — لا يُحذف أبداً) */
export function removeBox(p: PrintProfile, id: CanvasBoxId): PrintProfile {
  const c = layoutOf(p).canvas;
  if (!c || !c.boxes.some((b) => b.id === id)) return p;
  return withCanvas(p, { ...c, boxes: c.boxes.filter((b) => b.id !== id) });
}

/** تحريك بالمم (x فعلي من اليسار — المصمّم يعكس الأسهم في RTL) أو تغيير الحجم (resize) — داخل اللوحة دائماً */
export function nudgeBox(p: PrintProfile, id: CanvasBoxId, dxMm: number, dyMm: number, resize?: boolean): PrintProfile {
  const c = layoutOf(p).canvas;
  const b = c?.boxes.find((x) => x.id === id);
  if (!c || !b) return p;
  const dx = fin(dxMm) ? dxMm : 0;
  const dy = fin(dyMm) ? dyMm : 0;
  const moved: CanvasBox = resize ? { ...b, w: b.w + dx, h: b.h + dy } : { ...b, x: b.x + dx, y: b.y + dy };
  return withCanvas(p, { ...c, boxes: c.boxes.map((x) => (x.id === id ? moved : x)) });
}

/**
 * لوحة رأسٍ تحاكي ترويسة اليوم: الشركة يميناً والشعار بجانبها (أو يساراً أو في الوسط بحسب logo)، والعنوان وبيانات المستند يساراً.
 * بلا شعار (logo none أو إخفاؤه أو الورق المطبوع مسبقاً) لا مربع له. لا تذييل (0) — العميل وQR والإجماليات تجري كاليوم.
 */
export function starterCanvas(p: PrintProfile): PrintCanvas {
  const W = contentW(p);
  const l = layoutOf(p);
  const showLogo = l.logo !== 'none' && p.options.showLogo !== false && p.template !== 'impact_preprinted';
  const L = showLogo ? clamp(ceilStep(logoMmOf(p)), 8, 40) : 0;
  const half = floorStep((W - 4) / 2);
  const right = W - half;
  const boxes: CanvasBox[] = [];
  const top = showLogo && l.logo === 'center' ? L + 2 : 0;
  if (showLogo) {
    const x = l.logo === 'center' ? floorStep((W - L) / 2) : l.logo === 'end' ? 0 : W - L;
    boxes.push({ id: 'logo', band: 'header', x, y: 0, w: L, h: L });
  }
  const besideLogo = showLogo && l.logo === 'start';
  boxes.push({ id: 'company', band: 'header', x: right, y: top, w: besideLogo ? half - L - 2 : half, h: 30 });
  const leftTop = showLogo && l.logo === 'end' ? L + 2 : top;
  boxes.push({ id: 'title', band: 'header', x: 0, y: leftTop, w: half, h: 12 });
  boxes.push({ id: 'docInfo', band: 'header', x: 0, y: leftTop + 14, w: half, h: 30 });
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return sanitizeCanvas({ headerMm: ceilStep(bottom + 2), footerMm: 0, boxes }, W);
}

// ─── الكلاسيكي ───

/**
 * «تحرير الشريط الكلاسيكي» (B.3): نسخةٌ roll_compact على ورق الكلاسيكي نفسه (58 مم) بتخطيط بداية (بلا شعار، قياسي، خطوط، ترتيب اليوم)،
 * ويُوجَّه إليها كل نوع مستندٍ كان يطبع بالكلاسيكي. الكلاسيكي نفسه لا يُمسّ (التراجع = إعادة التوجيه). لا نسخة (newId '') إن لم يكن
 * المعرّف كلاسيكياً أو بلغت القوالب حدّها (12). name: اسمٌ مترجم من الواجهة، وإلا فاسمٌ عربي ثابت.
 */
export function editableClassicCopy(s: PrintSettingsV1, classicId: string, name?: string): { settings: PrintSettingsV1; newId: string } {
  const classic = s.profiles.find((x) => x.id === classicId);
  const isClassic = !!classic && classic.printer === 'thermal' && (classic.id === LEGACY_THERMAL_ID || classic.template === 'roll_classic');
  if (!classic || !isClassic || s.profiles.length >= 12) return { settings: s, newId: '' };
  const id = uniqueProfileId('thermal', s.profiles);
  const options = JSON.parse(JSON.stringify(classic.options)) as PrintProfile['options'];
  const starter = defaultPrintLayout('thermal', 'standard');
  options.layout = { ...starter, logo: 'none', tableStyle: 'lines', order: [...sectionsFor('thermal', 'standard')] };
  const copy: PrintProfile = {
    id,
    name: uniqueProfileName(name?.trim() || 'شريط 58 مم قابل للتحرير', s.profiles),
    printer: 'thermal',
    template: 'roll_compact',
    paper: JSON.parse(JSON.stringify(classic.paper)) as PrintProfile['paper'],
    options,
  };
  const routing = { ...s.routing };
  for (const k of Object.keys(routing) as (keyof typeof routing)[]) if (routing[k] === classicId) routing[k] = id;
  return { settings: { ...s, profiles: [...s.profiles, copy], routing }, newId: id };
}

// ─── أخطاء المفاتيح الحرّة (للعرض بجوار الأداة) ───

const FREE_PATH = /\.options\.layout\.(logoMm|logoAfter|sections|canvas)(\b|\.|\[|$)/;

/** رسائل قواعد النواة للمفاتيح الأربعة وحدها (بلا تكرار) — [] للقالب السليم أو بلا تخطيط */
export function freeIssues(p: PrintProfile): string[] {
  const out: string[] = [];
  for (const i of layoutIssues(p, 'p')) if (FREE_PATH.test(i.path) && !out.includes(i.message)) out.push(i.message);
  return out;
}
