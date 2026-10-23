/**
 * وثيقة الشريط الحراريّ — الجزء النقيّ من thermal.ts («إعدادات الطباعة» M2، التصميم §3.2).
 *
 * كان printHTML يبني الوثيقة ويطبعها في نَفَسٍ واحد؛ فانقسم: هنا نصّ HTML وحده (بلا DOM ولا React ولا qrcode)، وفي
 * thermal.ts الإطار المخفيّ والطباعة. ولماذا ملفٌّ مستقلّ لا دالّةٌ داخل thermal.ts: الاختبار الذهبيّ والطباعة المباشرة
 * بالبلوتوث (M3 تلتقط النصّ نفسه في إطارٍ خارج الشاشة) يقرآن الوثيقة من مصدرٍ واحد — فلا نسخة ثانية للرول.
 *
 * القاعدة الأولى: الهندسة الافتراضية (LEGACY_THERMAL_GEOM) تُخرج **نصّ اليوم حرفاً بحرف**، ومعه `@page { size: 58mm auto }`
 * غير الصالح تقنياً (يُسقطه Chrome) — يُترك عمداً كي لا يتغيّر شيءٌ على أجهزةٍ تطبع اليوم. والحارس thermalHtml.test.ts.
 * والقوالب الجديدة (مختصر/مفصّل) تأخذ مقاساً صالحاً `@page { size: W H }`: H يُقاس من ارتفاع المحتوى بعد التخطيط (الرول)
 * أو هو طول الصفحة (الورق المقطع).
 */
import { geometry, type PrintProfile } from '../lib/print/printSettings';

export interface ThermalGeom {
  /** الشريط الكلاسيكي 58 مم كما هو — كل ما عداه يُهمل */
  legacy: boolean;
  paperWidthMm: number;
  /** عرض الحزمة المطبوعة (النقاط ÷ الدقة) */
  printableWidthMm: number;
  /** بداية الحزمة من حافة الورق اليسرى: في المنتصف ثم إزاحة المعايرة */
  bandLeftMm: number;
  /** null = رول بطول محتواه؛ وإلا طول الصفحة (ورق مقطع) */
  pageLengthMm: number | null;
  marginTopMm: number;
  marginBottomMm: number;
  /** تغذية بعد كل نسخة على الرول */
  feedAfterMm: number;
  fontScale: number;
  boldBody: boolean;
  /** مرّات طباعة كاملة (التصميم §3.6) — كلٌّ في «صفحته» بالرمز نفسه */
  copies: number;
  /** «الأصل» للأولى و«نسخة» للبقية (مترجمتان) — سطرٌ صغير تحت العنوان، والعنوان لا يتغيّر */
  copyLabels: readonly [string, string] | null;
}

export const LEGACY_THERMAL_GEOM: ThermalGeom = Object.freeze({
  legacy: true,
  paperWidthMm: 58,
  printableWidthMm: 48,
  bandLeftMm: 5,
  pageLengthMm: null,
  marginTopMm: 0,
  marginBottomMm: 0,
  feedAfterMm: 0,
  fontScale: 1,
  boldBody: false,
  copies: 1,
  copyLabels: null,
});

/** موضع سطر النسخة في جسم القوالب الجديدة (تحت العنوان) — الشريط الكلاسيكي بلا موضع فلا يتغيّر */
export const COPY_SLOT = '<!--fs:copy-->';

/** طول الصفحة المؤقّت للرول قبل قياس المحتوى (يُستبدل بعد التخطيط) */
export const ROLL_PLACEHOLDER_MM = 297;

const mm = (n: number): string => `${Math.round(n * 10) / 10}mm`;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** هندسة الرول من قالب الطباعة — والحزمة لا تخرج عن الورق مهما بلغت الإزاحة */
export function thermalGeom(p: PrintProfile, copyLabels: readonly [string, string] | null): ThermalGeom {
  const g = geometry(p);
  const room = Math.max(0, g.paperWidthMm - g.printableWidthMm);
  return {
    legacy: false,
    paperWidthMm: g.paperWidthMm,
    printableWidthMm: g.printableWidthMm,
    bandLeftMm: Math.min(room, Math.max(0, g.bandLeftMm)),
    pageLengthMm: g.feed === 'roll' ? null : g.paperLengthMm,
    marginTopMm: g.marginTopMm,
    marginBottomMm: g.marginBottomMm,
    feedAfterMm: p.options.feedAfterMm,
    fontScale: p.options.fontScale,
    boldBody: p.options.boldBody,
    copies: p.options.copies,
    copyLabels: p.options.copyLabels ? copyLabels : null,
  };
}

/**
 * قاعدة @page الصالحة للقوالب الجديدة: العرض = عرض الورق، والطول = ما قيس من المحتوى (رول) أو طول الصفحة (مقطع).
 * الورق المقطع يأخذ هامشيه من @page (يتكرّران على كل صفحة)، والرول بلا هامش (الحشوة داخل كل نسخة).
 */
export function thermalPageRule(g: ThermalGeom, heightMm?: number): string {
  if (g.pageLengthMm !== null) return `@page { size: ${mm(g.paperWidthMm)} ${mm(g.pageLengthMm)}; margin: ${mm(g.marginTopMm)} 0 ${mm(g.marginBottomMm)} 0; }`;
  const h = heightMm !== undefined && Number.isFinite(heightMm) && heightMm > 0 ? heightMm : ROLL_PLACEHOLDER_MM;
  return `@page { size: ${mm(g.paperWidthMm)} ${mm(h)}; margin: 0; }`;
}

/** طول صفحة الرول من ارتفاع أطول نسخة بالبكسل — يُقرَّب لأعلى بعُشر مم ومعه مم احتياط كي لا تنقسم نسخةٌ على صفحتين */
export function rollHeightMm(copyHeightsPx: readonly number[]): number | undefined {
  const px = Math.max(0, ...copyHeightsPx.filter((h) => Number.isFinite(h)));
  if (!(px > 0)) return undefined;
  return Math.ceil((px * 25.4) / 96 * 10) / 10 + 1;
}

/**
 * نصّ الوثيقة. الهندسة الافتراضية ⇒ وثيقة اليوم حرفاً بحرف. وغيرها ⇒ نسخٌ مكرّرة (لكلٍّ سطر «الأصل/نسخة» مكان COPY_SLOT)
 * بعرض الورق، والحزمة بعرضها الفعليّ في موضعها، والخطّ بمقياس القالب.
 */
export function buildThermalDocument(body: string, geom: ThermalGeom = LEGACY_THERMAL_GEOM, pageHeightMm?: number): string {
  if (geom.legacy) {
    return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style>
    @page { size: 58mm auto; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { width: 58mm; margin: 0; padding: 0; }
    body { padding: 2mm 2.5mm 4mm; font-family: 'Tahoma','Arial',sans-serif; font-size: 11px; color: #000; line-height: 1.5; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: 14px; }
    .xl { font-size: 17px; }
    .sep { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .muted { font-size: 10px; }
    .item { margin: 3px 0; }
    .iname { font-weight: 600; }
    .qr { text-align: center; margin: 8px 0 4px; }
    img { display: inline-block; }
  </style></head><body>${body}</body></html>`;
  }
  const s = geom.fontScale;
  const px = (n: number): string => `${Math.round(n * s * 100) / 100}px`;
  const sheet = geom.pageLengthMm !== null;
  // الرول: الهامشان والتغذية حشوةُ كل نسخة؛ المقطع: الهامشان في @page
  const pad = sheet ? '0' : `${mm(geom.marginTopMm)} 0 ${mm(geom.marginBottomMm + geom.feedAfterMm)}`;
  const n = Math.max(1, Math.min(3, Math.floor(geom.copies) || 1));
  const sections = Array.from({ length: n }, (_, i) => {
    const label = geom.copyLabels ? `<div class="copy-label">${esc(i === 0 ? geom.copyLabels[0] : geom.copyLabels[1])}</div>` : '';
    return `<section class="copy">${body.split(COPY_SLOT).join(label)}</section>`;
  }).join('');
  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style id="fs-page">${thermalPageRule(geom, pageHeightMm)}</style>
  <style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html { width: ${mm(geom.paperWidthMm)}; margin: 0; padding: 0; background: #fff; }
    body { width: ${mm(geom.printableWidthMm)}; margin: 0 auto 0 ${mm(geom.bandLeftMm)}; padding: 0; font-family: 'Tahoma','Arial',sans-serif; font-size: ${px(11)}; color: #000; line-height: 1.5;${geom.boldBody ? ' font-weight: 700;' : ''} }
    .copy { padding: ${pad}; }
    .copy + .copy { break-before: page; page-break-before: always; }
    .c { text-align: center; }
    .b { font-weight: 700; }
    .lg { font-size: ${px(14)}; }
    .xl { font-size: ${px(17)}; }
    .sep { border-top: 1px dashed #000; margin: 4px 0; }
    .row { display: flex; justify-content: space-between; gap: 6px; }
    .muted { font-size: ${px(10)}; }
    .item { margin: 3px 0; }
    .iname { font-weight: ${geom.boldBody ? 700 : 600}; }
    .copy-label { text-align: center; font-size: ${px(10)}; font-weight: 700; }
    .logo img { max-width: 60%; max-height: 16mm; filter: grayscale(1) contrast(1.4); }
    .qr { text-align: center; margin: 8px 0 4px; }
    .qrslot { margin: 0 auto }
    .qrbox .qr img { width: var(--qr); height: var(--qr); }
    table.t { width: 100%; border-collapse: collapse; }
    .t th { font-weight: 700; border-bottom: 1px dashed #000; padding: 1px 2px; text-align: center; }
    .t td { padding: 2px; vertical-align: top; text-align: center; }
    .t .l { text-align: right; }
    .t .e { text-align: left; }
    .t .n { white-space: nowrap; }
    img { display: inline-block; }
  </style></head><body>${sections}</body></html>`;
}
