/**
 * صفحة المعايرة والطباعة التجريبية — «إعدادات الطباعة» M3 (التصميم §5.1 E و§4.14). تحلّ محلّ اختبار الميدان M0: المالك يطبعها
 * على الطابعة الحقيقية (MIP480 أو PRO-V) فيقرأ منها الأرقام التي تُعاير بها القوالب.
 *
 * صفحة المعايرة (نصّ HTML نقيّ بالمم — نفسه لنظام الطباعة وللبلوتوث المباشر):
 *  · مسطرة بالمم على عرض الحزمة كلّه (علامة كل مم، وأطول كل 5 و10 برقمها) — ما قُصّ من طرفيها = الحزمة أعرض من الورق؛
 *  · علامتا الحافتين وخطّ المنتصف — بُعد الحافة من حافة الورق يعطي الإزاحة الأفقية؛
 *  · شريطٌ أسود كامل — حرارة الرأس أو حبر الشريط (رماديٌّ متقطّع = رأسٌ بارد أو شريطٌ بالٍ)؛
 *  · سطرٌ عربيّ بكل مقياس خطّ (90٪ … 130٪) وسطرٌ عريض — أصغر ما يُقرأ على هذه الطابعة؛
 *  · رمز QR **تجريبيّ** بطول الرمز المختوم (~700 محرف) وبنقاط الخلية التي سيطبع بها — يُمسح بالجوال للتأكد؛
 *  · للورق المقطع والمتصل: مسطرةٌ عمودية كل 10 مم على الحافة اليسرى (النصّ العربيّ يمينٌ فلا يتراكبان) وخطّ «نهاية مساحة
 *    الطباعة» — والمتصل ثلاث صفحات لرؤية الانجراف على الثقوب؛
 *  · والورق القصير (نصف صفحة متصلة) لا يتسع لكل ذلك: تنقسم الصفحة قسمين لكلٍّ خطّ نهايته (calibrationLayout) — لا يُقصّ الرمز.
 *
 * والطباعة التجريبية: مستند فاتورةٍ نموذجيّ يمرّ بالقوالب الحقيقية نفسها، وقرار ZATCA فيه **بيئة محاكاة** (علامتها المائية) ورمزه
 * تجريبيٌّ بالطول نفسه (dummyQrValue) — لا buildZatcaQr أبداً: لا يخرج من الإعدادات رمزٌ ضريبيٌّ يشبه الحقيقيّ (§4.14).
 * وكلاهما يحمل «نموذج اختبار — ليس مستندا ضريبيا».
 */
import QRCode from 'qrcode';
import {
  FONT_SCALES, PRINT_SAMPLE_WATERMARK, dotsPerMm, geometry, qrPlan, type PrintProfile,
} from './printSettings';
import type { Company, InvoiceDoc } from '../../rep/RepDocuments';

type Tr = (ar: string) => string;

/** طول الرمز المختوم في المرحلة الثانية تقريباً — الرمز التجريبيّ بطوله فيكون بخلاياه (النسخة 18، 89 خلية) */
export const DUMMY_QR_LENGTH = 700;
const DUMMY_SEED = 'fieldsa.net print test - not a tax invoice - ';

/** حمولةٌ تقول عن نفسها إنها تجربة — من يمسحها يقرأ «not a tax invoice» */
export function dummyQrValue(length = DUMMY_QR_LENGTH): string {
  let s = '';
  while (s.length < length) s += DUMMY_SEED;
  return s.slice(0, length);
}

/** صفحات المعايرة: المتصل ثلاثٌ متتالية (انجراف الثقوب)، وغيره صفحة */
export const calibrationPages = (p: PrintProfile): number => (p.paper.feed === 'continuous' ? 3 : 1);
/** طول شريط المعايرة على الرول (مم) — ثابتٌ ليصحّ @page بلا قياس */
export const CALIBRATION_ROLL_MM = 175;

const r1 = (n: number): number => Math.round(n * 10) / 10;
const mm = (n: number): string => `${r1(n)}mm`;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** مقاس خلية الرمز التجريبيّ بالمم وعدد نقاطها — من qrPlan كالرمز الحقيقيّ (العادية: 0.5 مم) */
export function calibrationQr(p: PrintProfile): { cells: number; dotsPerCell: number | null; cellMm: number; fits: boolean } {
  const cells = QRCode.create(dummyQrValue(), { errorCorrectionLevel: 'L' }).modules.size;
  const plan = qrPlan(p, cells);
  if (!plan || p.paper.dpi === null) return { cells, dotsPerCell: null, cellMm: 0.5, fits: true };
  return { cells, dotsPerCell: plan.dotsPerCell, cellMm: plan.dotsPerCell / dotsPerMm(p.paper.dpi), fits: plan.fits };
}

/** الرمز التجريبيّ رسماً متّجهاً (SVG) بمقاس الخلية بالمم — حادٌّ في نظام الطباعة؛ وفي البلوتوث تُعاد رسمته الخانة بنقاط صحيحة */
function qrSvg(value: string, cellMm: number): string {
  const m = QRCode.create(value, { errorCorrectionLevel: 'L' }).modules;
  let d = '';
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.get(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const side = mm(m.size * cellMm);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.size} ${m.size}" width="${side}" height="${side}" shape-rendering="crispEdges"><path d="${d}" fill="#000"/></svg>`;
}

export interface CalibrationOptions {
  /** system = وثيقة كاملة بـ@page والحزمة في موضعها من الورق؛ raster = الحزمة وحدها بعرضها (تُلتقط كل صفحةٍ section.cal) */
  mode: 'system' | 'raster';
  /** اسم القالب للعرض */
  name: string;
}

// ─── التخطيط: صفحةٌ واحدة، أو قسمان على الورق القصير ───
//
// لماذا تقديرٌ لا قياس: الوثيقة نصٌّ نقيّ يُبنى قبل أيّ تخطيط (لنظام الطباعة وللبلوتوث معاً). ونصف الصفحة المتصلة (ff_95x55،
// ~129 مم للطباعة) لا يتسع لكل الكتل (~190 مم بالرمز الكبير على MIP480): كان القسم بارتفاعٍ ثابت و overflow: hidden فيُقصّ
// الرمز التجريبيّ وشرحه — وهما ما تُطبع الصفحة لأجله. فالتقدير أدناه نموذجٌ **محافظ** للأسلوب نفسه (يزيد ولا ينقص)، وإن لم
// يتسع كلّ شيءٍ في صفحةٍ انقسمت: الرأس والمساطر وأحجام الخط في قسم، والرمز وتعليقه وشرحه في قسمٍ ثانٍ — لكلٍّ علامته وخطّ
// نهايته. وإن ضاق القسم الأوّل حتى عن أحجام الخط تُركت. والقسم min-height لا height: ما زاد يمدّه ولا يُقصّ.

const PX_MM = 25.4 / 96;
const LINE_HEIGHT = 1.45;
/** متوسّط عرض الحرف بنسبة حجم الخط — أعلى من الواقع عمداً (Tahoma العربية والأرقام نحو 0.5–0.55) فيلتفّ النصّ في التقدير قبل الورق */
const CHAR_EM = 0.62;
/** حجزٌ أسفل كل قسمٍ محدود الطول لخطّ «نهاية مساحة الطباعة» (سطرٌ صغير وحدّه) وأمانٌ فوقه */
const END_SAFETY_MM = 1;

const lineMm = (fontPx: number): number => fontPx * LINE_HEIGHT * PX_MM;
/** ارتفاع نصٍّ يلتفّ على عرض الحزمة */
const textMm = (text: string, fontPx: number, widthMm: number): number =>
  Math.max(1, Math.ceil((Array.from(text).length * CHAR_EM * fontPx * PX_MM) / Math.max(1, widthMm))) * lineMm(fontPx);
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** قسمٌ من صفحة المعايرة: all = كل الكتل؛ rulers = الرأس والمساطر و(أحجام الخط) وشرحها؛ qr = العلامة والعنوان والرمز وشرحه */
export interface CalibrationSection {
  kind: 'all' | 'rulers' | 'qr';
  fonts: boolean;
  /** الارتفاع المقدَّر بالمم (ومعه حجز خطّ النهاية على الورق) */
  mm: number;
}

export interface CalibrationLayout {
  /** طول القسم = مساحة الطباعة ناقص نصف مم أمان — null للرول (بلا حدّ) */
  bodyMm: number | null;
  /** أقسام الصفحة المنطقية: واحدٌ، أو اثنان على الورق القصير */
  sections: CalibrationSection[];
  /** الأوراق المطبوعة: صفحات المعايرة (المتصل ثلاث) وقسماها على الأقل — تتعاقب الأقسام عليها */
  sheets: number;
}

/** نصوص الصفحة وأحجامها — مصدرٌ واحد للتقدير وللرسم */
function calibrationModel(p: PrintProfile, tr: Tr, name: string) {
  const g = geometry(p);
  const W = g.printableWidthMm;
  const base = p.printer === 'thermal' ? 11 : 12.5;
  const q = calibrationQr(p);
  const slotMm = (q.cells + 4) * q.cellMm + 0.4;
  const fonts = [
    ...FONT_SCALES.map((s) => ({ px: r1(base * s * 100) / 100, bold: false, text: `${tr('حجم الخط')} ${Math.round(s * 100)}% — ${tr('فاتورة ضريبية مبسطة')} 0123456789` })),
    { px: base, bold: true, text: `${tr('خط عريض للنص')} — ${tr('الإجمالي')} 115.00` },
  ];
  const meta = [
    `${r1(g.paperWidthMm)}${g.paperLengthMm !== null ? ` × ${r1(g.paperLengthMm)}` : ''} mm`,
    p.paper.printableDots !== null ? `${p.paper.printableDots} dots` : null,
    p.paper.dpi !== null ? `${p.paper.dpi} dpi` : null,
    `offset ${r1(p.paper.offsetXmm)} mm`,
  ].filter(Boolean).join(' · ');
  const qrCaption = q.dotsPerCell !== null
    ? `QR · ${q.dotsPerCell} dots/cell · ≈ ${Math.round(q.cells * q.cellMm)} mm`
    : `QR · ≈ ${Math.round(q.cells * q.cellMm)} mm`;
  const helpRuler = [
    'قس من حافة الورق إلى بداية المسطرة وإلى نهايتها ثم عدل الإزاحة الأفقية حتى تتساوى المسافتان',
    'إن قص طرف المسطرة فقلل عرض الطباعة بالنقاط',
    ...(p.paper.feed === 'continuous' ? ['يجب أن يقع خط النهاية على المسافة نفسها من الثقب في الصفحات الثلاث'] : []),
  ];
  const helpQr = ['امسح الرمز التجريبي بالجوال — إن لم يقرأ فاختر مقاس الرمز كبير'];
  const small = base * 0.85;
  const help = (lines: readonly string[]) => 1.5 + sum(lines.map((h) => textMm(`• ${tr(h)}`, small, W)));
  // العنوان بأطول صورته («· n/m»)
  const title = `${tr('صفحة معايرة')} — ${name} · 9/9`;
  const banner = 2 * 1.5 * PX_MM + 2 + textMm(tr(PRINT_SAMPLE_WATERMARK), base, W) + 1.5;
  const est = {
    banner,
    title: textMm(title, base * 1.15, W),
    meta: textMm(meta, small, W) + 1.5,
    rulers: (12 + 0.3) + (9 + 1) + (5 + 2 + 2),
    fonts: sum(fonts.map((f) => textMm(f.text, f.px, W))),
    qr: 2 + slotMm + textMm(tr('رمز تجريبي — ليس رمزا ضريبيا'), small, W) + textMm(qrCaption, small, W) + 2,
    helpAll: help([...helpRuler.slice(0, 2), ...helpQr, ...helpRuler.slice(2)]),
    helpRuler: help(helpRuler),
    helpQr: help(helpQr),
    end: lineMm(small) + 0.4 + END_SAFETY_MM,
  };
  return { g, W, base, q, slotMm, fonts, meta, qrCaption, helpRuler, helpQr, est };
}

/** أقسام الصفحة لهذا القالب: واحدٌ إن اتسع كل شيء، وإلا الرأس والمساطر ثم الرمز — والتقدير لكلٍّ داخل طول القسم */
export function calibrationLayout(p: PrintProfile, tr: Tr, name = ''): CalibrationLayout {
  const { g, est } = calibrationModel(p, tr, name);
  const bodyMm = g.paperLengthMm === null ? null : Math.max(20, (g.usableLengthMm ?? 0) - 0.5);
  const end = bodyMm === null ? 0 : est.end;
  const head = est.banner + est.title;
  const all: CalibrationSection = { kind: 'all', fonts: true, mm: head + est.meta + est.rulers + est.fonts + est.qr + est.helpAll + end };
  const pages = calibrationPages(p);
  if (bodyMm === null || all.mm <= bodyMm) return { bodyMm, sections: [all], sheets: pages };
  const withFonts = head + est.meta + est.rulers + est.fonts + est.helpRuler + end;
  const rulers: CalibrationSection = withFonts <= bodyMm
    ? { kind: 'rulers', fonts: true, mm: withFonts }
    : { kind: 'rulers', fonts: false, mm: withFonts - est.fonts };
  const qr: CalibrationSection = { kind: 'qr', fonts: false, mm: head + est.qr + est.helpQr + end };
  return { bodyMm, sections: [rulers, qr], sheets: Math.max(pages, 2) };
}

/**
 * وثيقة صفحة المعايرة. العرض = الحزمة المطبوعة (النقاط ÷ الدقة) للحرارية والنقطية، والورق ناقص هامشين للعادية؛ وكل ورقةٍ
 * section.cal بطولٍ أدنى = مساحة الطباعة (الورق ناقص الهامشين، ونصف مم أمانٍ كي لا يفيض صفٌّ إلى صفحة ثانية). والورق القصير
 * يقسم الصفحة قسمين (calibrationLayout) يتعاقبان على الأوراق.
 */
export function buildCalibrationDocument(p: PrintProfile, tr: Tr, opts: CalibrationOptions): string {
  const { g, W, base, q, slotMm, fonts, meta, qrCaption, helpRuler, helpQr } = calibrationModel(p, tr, opts.name);
  const raster = p.printer !== 'page';
  const roll = g.paperLengthMm === null;
  const layout = calibrationLayout(p, tr, opts.name);
  const { bodyMm, sheets } = layout;
  const dummy = dummyQrValue();
  const room = Math.max(0, g.paperWidthMm - W);
  const bandLeft = raster ? Math.min(room, Math.max(0, g.bandLeftMm)) : (g.paperWidthMm - W) / 2;

  const ticks: string[] = [];
  for (let i = 0; i <= Math.floor(W + 1e-9); i++) {
    const h = i % 10 === 0 ? 8 : i % 5 === 0 ? 5 : 3;
    ticks.push(`<i style="left:${mm(Math.min(i, W - 0.3))};height:${h}mm"></i>`);
    if (i % 10 === 0 && i > 0 && i < W - 3) ticks.push(`<b style="left:${mm(i)}">${i}</b>`);
  }
  const vticks: string[] = [];
  if (bodyMm !== null) {
    for (let y = 10; y < bodyMm - 2; y += 10) vticks.push(`<i style="top:${mm(y)}"></i><b style="top:${mm(y - 1.6)}">${y}</b>`);
  }
  const fontsHtml = fonts.map((f) => `<div style="font-size:${f.px}px${f.bold ? ';font-weight:700' : ''}">${esc(f.text)}</div>`).join('');
  const helpHtml = (lines: readonly string[]) => `<div class="help">${lines.map((h) => `<div>• ${esc(tr(h))}</div>`).join('')}</div>`;

  const head = (n: number) => `
    <div class="banner">${esc(tr(PRINT_SAMPLE_WATERMARK))}</div>
    <div class="title">${esc(tr('صفحة معايرة'))} — ${esc(opts.name)}${sheets > 1 ? ` · <span dir="ltr">${n}/${sheets}</span>` : ''}</div>`;
  const rulers = `
    <div class="meta" dir="ltr">${esc(meta)}</div>
    <div class="ruler" dir="ltr">${ticks.join('')}</div>
    <div class="edges" dir="ltr"><span class="e l"></span><span class="mid"></span><span class="e r"></span></div>
    <div class="bar"></div>`;
  const qrBlock = `
    <div class="qrwrap">
      <div class="qrslot" data-qr-value="${esc(dummy)}" data-qr-ec="L" style="width:${mm(slotMm)};height:${mm(slotMm)}">${qrSvg(dummy, q.cellMm)}</div>
      <div class="cap">${esc(tr('رمز تجريبي — ليس رمزا ضريبيا'))}</div>
      <div class="cap" dir="ltr">${esc(qrCaption)}</div>
    </div>`;
  const tail = bodyMm !== null ? `
    <div class="vruler" dir="ltr">${vticks.join('')}</div><div class="end">— ${esc(tr('نهاية مساحة الطباعة'))} —</div>` : '';

  const section = (n: number) => {
    const s = layout.sections[(n - 1) % layout.sections.length];
    const body = s.kind === 'all'
      ? `${rulers}
    <div class="fonts">${fontsHtml}</div>${qrBlock}
    ${helpHtml([...helpRuler.slice(0, 2), ...helpQr, ...helpRuler.slice(2)])}`
      : s.kind === 'rulers'
        ? `${rulers}${s.fonts ? `
    <div class="fonts">${fontsHtml}</div>` : ''}
    ${helpHtml(helpRuler)}`
        : `${qrBlock}
    ${helpHtml(helpQr)}`;
    return `
  <section class="cal" data-cal="${s.kind}"${bodyMm !== null ? ` style="min-height:${mm(bodyMm)}"` : ''}>${head(n)}${body}${tail}
  </section>`;
  };

  // نظام الطباعة: @page بمقاس الورق والحزمة في موضعها؛ الرول طوله ثابت. البلوتوث: الحزمة وحدها (المُرمِّز يضع الهامش)
  const sys = opts.mode === 'system';
  const pageRule = sys
    ? `@page { size: ${mm(g.paperWidthMm)} ${mm(roll ? CALIBRATION_ROLL_MM : (g.paperLengthMm as number))}; margin: ${roll ? '0' : `${mm(g.marginTopMm)} 0 ${mm(g.marginBottomMm)} 0`}; }`
    : '';
  const rollPad = roll ? `padding: ${mm(g.marginTopMm)} 0 ${mm(g.marginBottomMm + p.options.feedAfterMm)};` : '';
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style>
    ${pageRule}
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html { margin: 0; padding: 0; background: #fff; ${sys ? `width: ${mm(g.paperWidthMm)};` : ''} }
    body { width: ${mm(W)}; margin: 0 auto 0 ${sys ? mm(bandLeft) : '0'}; padding: 0; font-family: Tahoma, Arial, sans-serif; font-size: ${base}px; color: #000; line-height: ${LINE_HEIGHT}; }
    .cal { position: relative; ${rollPad} }
    .cal + .cal { break-before: page; page-break-before: always; }
    .banner { text-align: center; font-weight: 700; border: 1.5px solid #000; padding: 1mm; margin-bottom: 1.5mm; }
    .title { text-align: center; font-weight: 700; font-size: 1.15em; }
    .meta { text-align: center; font-size: 0.85em; margin-bottom: 1.5mm; }
    .ruler { position: relative; height: 12mm; border-top: 0.3mm solid #000; }
    .ruler i { position: absolute; top: 0; width: 0.3mm; background: #000; }
    .ruler b { position: absolute; top: 8.2mm; font-size: 2.6mm; font-weight: 400; transform: translateX(-50%); line-height: 1; }
    .edges { position: relative; height: 9mm; margin-top: 1mm; }
    .edges .e { position: absolute; top: 0; width: 1.5mm; height: 9mm; background: #000; }
    .edges .l { left: 0; } .edges .r { right: 0; }
    .edges .mid { position: absolute; top: 0; left: 50%; width: 0.3mm; height: 9mm; margin-left: -0.15mm; background: #000; }
    .bar { height: 5mm; background: #000; margin: 2mm 0; }
    .fonts > div { overflow-wrap: anywhere; }
    .qrwrap { text-align: center; margin: 2mm 0; }
    .qrslot { margin: 0 auto; display: flex; align-items: center; justify-content: center; background: #fff; }
    .qrslot svg { display: block; }
    .cap { font-size: 0.85em; }
    .help { font-size: 0.85em; margin-top: 1.5mm; }
    .vruler { position: absolute; top: 0; left: 0; bottom: 0; width: 6mm; border-left: 0.3mm solid #000; }
    .vruler i { position: absolute; left: 0; width: 3mm; height: 0.3mm; background: #000; }
    .vruler b { position: absolute; left: 3.4mm; font-size: 2.4mm; font-weight: 400; line-height: 1; }
    .end { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; border-bottom: 0.4mm solid #000; font-size: 0.85em; }
  </style></head><body>${Array.from({ length: sheets }, (_, i) => section(i + 1)).join('')}</body></html>`;
}

/** شريط «نموذج اختبار» أعلى المستند التجريبيّ (وأسفله أيضاً على الرول) — القالب نفسه بلا تعديل بينهما */
export function sampleBannerHtml(text: string): string {
  // مدمج (سطرٌ واحد بإطار) — فلا يدفع ورقة A4 النموذجية إلى صفحةٍ لا تدفعها إليها الفاتورة الحقيقية
  return `<div data-sample-banner="" style="text-align:center;font-weight:700;font-size:12px;line-height:1.4;border:1.5px solid #000;padding:1px 6px;margin:0 0 4px;color:#000;background:#fff">${esc(text)}</div>`;
}

/**
 * مستند الطباعة التجريبية: فاتورة نموذجية باسم الشركة ورقمها الضريبي (كما تطبع حقاً)، وقرارها بيئة محاكاة برمزٍ تجريبيّ —
 * فيمرّ بالقوالب الحقيقية وقرارها كاملاً، ولا يُبنى له رمز المرحلة الأولى أبداً.
 */
export function sampleInvoiceDoc(company: Company | null | undefined, tr: Tr, now: Date = new Date()): InvoiceDoc {
  // صنفان: الفاتورة الحقيقية القصيرة — وورقة A4 النموذجية بعلامتي التجربة لا تفيض إلى صفحةٍ ثانية على MIP480
  const items = [
    { name: `${tr('صنف تجريبي')} 1`, unit: tr('الوحدة'), qty: 2, unitPrice: 28.75, discountPct: 0, taxPct: 15, lineTotal: 57.5 },
    { name: `${tr('صنف تجريبي')} 2`, unit: tr('الوحدة'), qty: 1, unitPrice: 57.5, discountPct: 0, taxPct: 15, lineTotal: 57.5 },
  ];
  return {
    kind: 'invoice',
    number: 'TEST-0001',
    date: now.toISOString(),
    type: 'CASH',
    company: { ...(company ?? {}), name: company?.name || tr('اسم الشركة'), taxNumber: company?.taxNumber || '300000000000003', printSettings: undefined },
    customer: { name: tr('عميل تجريبي') },
    repName: tr('مندوب تجريبي'),
    items,
    subtotal: 100,
    discount: 0,
    tax: 15,
    total: 115,
    pricesIncludeTax: true,
    zatca: {
      phase: 2, mode: 'rehearsal', mirror: 'reported', documentStatus: 'REPORTED', subtype: '02', documentKind: 'INVOICE',
      qr: dummyQrValue(), printable: true, overdue: false, reportDeadline: null, issuedAt: null,
      uuid: '00000000-0000-0000-0000-000000000000', icv: 1, warnings: 0,
    },
  };
}
