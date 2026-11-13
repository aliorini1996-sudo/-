/**
 * صفحة معايرة «نموذج الشركة المطبوع مسبقاً» (طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — نصّ HTML نقيّ بالمم يُطبع عبر نظام الطباعة
 * (printHtmlDocument) **على ورق النموذج نفسه**: فتقرأ الشركة كم تنحرف المواضع عن فراغات ورقها وتعدّل الإزاحة (dx/dy) في المصمّم.
 *
 *  · الورقة بمقاس الورق نفسه، و@page بلا هامش، والمواضع بالمم من ركن الورقة الفعلي — كالطباعة الحقيقية (formPrintGeom)؛
 *  · مربعٌ متقطّع لكل حقلٍ في موضعه **بعد الإزاحة الحالية** (printedBox) وفيه اسمه صغيراً؛
 *  · جدول الأصناف: خطٌّ متقطّع عند حدّ كل صفّ ورقمه، وشريطٌ متقطّع لكل عمودٍ باسمه — بالإزاحة نفسها؛
 *  · مسطرتان على الحافتين العليا واليسرى (علامة كل مم، وأطول كل 5 و10 برقمها) **بلا إزاحة**: بُعد علامة 10 عن حافة الورق يقول
 *    انحراف الطابعة نفسها؛
 *  · عنوانٌ صغير في الركن «صفحة معايرة النموذج» بقيمتي الإزاحة الحاليتين.
 *
 * لا صورة النموذج ولا قيم ولا رمز QR (حقل الرمز مربعٌ متقطّع كغيره) — ولشركةٍ أزالت الضريبة (taxOff) لا حقول الضريبة ولا عمودها ولا
 * مربع الرمز: لا تُطبع على مستنداتها، فلا تُذكر على ورقتها.
 *
 * وعلى الطابعة النقطية (طلب المالك ١٣ نوفمبر ٢٠٢٦ — formReachOf): الإبرة لا تبلغ إلا حزمةً في وسط الورقة [x0, x1]، والصفحة نفسها
 * تُرسم نقاطاً (printFormHtmlDirect ← formSheetRaster) فيُرفض كل حبرٍ خارج الحزمة. فلا يخرج منها شيء: المواضع مقصوصةٌ داخلها
 * (formPaperOf)، والمسطرتان داخلها بنصف مم — العليا على y = 0 من x0 إلى x1 وحدهما، واليسرى على x0 — وأرقامهما بالمم من حافة
 * الورقة، ورقم الصفّ والعنوان داخلها، وتعليماتها impactHelp. والورقة data-form-sheet كورقة الفاتورة. والطابعة العادية كما كانت حرفاً.
 */
import {
  FORM_COLUMN_LABELS, FORM_FIELD_LABELS, FORM_TAX_COLUMN_IDS, FORM_TAX_FIELD_IDS, fitForm, formOf, formPaperOf, formReachOf, formSheetSize,
  formTableBox, printedBox, tableRowTop,
} from './formModel';
import type { PrintProfile } from './printSettings';

type Tr = (ar: string) => string;

export interface FormCalibrationOptions {
  /** اسم القالب بعد العنوان */
  name?: string;
  /** «إزالة الضريبة»: بلا حقول الضريبة وعمودها ولا مربع رمز QR */
  taxOff?: boolean;
  /**
   * النقطية بالبلوتوث المباشر (printFormHtmlDirect): الصفحة تُرسم نقاطاً بمقاسها فلا سطر «100٪» في تعليماتها (impactHelp وحدها).
   * وبدونه (نظام الطباعة — مشغّل ويندوز، الافتراضي) يسبقها سطر «100٪ بلا تكبير ولا تصغير» (help[0]): تصغير المتصفح أو المشغّل
   * إلى مساحته يكبر خطؤه على طول الورقة فلا تصلحه إزاحةٌ واحدة. لا أثر له على الطابعة العادية (تعليماتها help كما كانت حرفاً)
   */
  direct?: boolean;
}

/** تعليمات الصفحة على الطابعة العادية — وسطرها الثاني (المربعات المتقطّعة) نفسه على النقطية */
const HELP = Object.freeze([
  'اطبعها على ورق النموذج بمقاس فعلي 100٪ بلا تكبير ولا تصغير',
  'المربعات المتقطعة مواضع الحقول بالإزاحة الحالية — قس بعدها عن فراغاتها ثم عدل الإزاحة في مصمم النموذج',
  'المسطرتان من حافة الورقة بلا إزاحة — علامة 10 على بعد 10 مم من الحافة إن لم تنحرف الطابعة',
]);

/** عبارات الصفحة (عربية؛ مترجمة في القاموس) */
export const FORM_CALIBRATION_TEXTS = Object.freeze({
  title: 'صفحة معايرة النموذج',
  offset: 'الإزاحة',
  table: 'جدول الأصناف',
  help: HELP,
  /**
   * النقطية: تحميل الورق كما في الفواتير — فأول سطرٍ تطبعه الإبرة يختلف بطريقة التحميل — والمسطرتان تبدآن من أول ما تبلغه الإبرة لا
   * من الحافة. وبالبلوتوث المباشر (direct) هي وحدها (النقاط ترسمها الصفحة نفسها لا متصفّحٌ يكبّر)، وعبر نظام الطباعة يسبقها help[0]
   */
  impactHelp: Object.freeze([
    'اطبعها على ورق النموذج محمّلاً كما ستطبع الفواتير',
    HELP[1],
    'المسطرتان من أول ما تبلغه الإبرة وأرقامهما بالمم من حافة الورقة — إن وقعت علامة 10 على 13 مم من الحافة فالإزاحة −3',
  ]),
});

/**
 * هامش الأمان داخل حزمة النقطية (مم): المسطرتان ورقم الصفّ والعنوان على نصف مم من حدّيها على الأقل — فلا تقع نقطةٌ رمادية من
 * تنعيم html2canvas على حدّ الحزمة فيرفضها formSheetRaster
 */
const REACH_INSET = 0.5;
/** ما تشغله المسطرة اليسرى من x0 بأرقامها (علامة 6 مم ثم رقمٌ من ثلاث خانات عند 6.6 مم) — رقم الصفّ يتجنّبه ما أمكن */
const RULER_CLEAR = 11;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const mm = (n: number): string => `${r2(n)}mm`;
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
/** الإزاحة بإشارتها وعُشرها: +1.5 و-2.0 و0.0 */
export const signedMm = (n: number): string => {
  const v = Math.round((Number.isFinite(n) ? n : 0) * 10) / 10;
  return `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(1)}`;
};

/** صندوق مستطيل بالمم (ركنه الأيسر الأعلى) */
type Box = { x: number; y: number; w: number; h: number };
const overlapArea = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * موضع مربع العنوان والتعليمات: أيّ الأركان الأربعة (داخل المسطرتين) أقلّ تغطيةً لمربعات الحقول والجدول — فلا يحجب ما تقيسه الشركة.
 * الأعلى الأيمن عند التساوي (كما كان). hMm تقديرٌ محافظ لارتفاعه، وخلفيته شفافة فما بقي تحته يُرى.
 * reach (النقطية): الأركان داخل ما تبلغه الإبرة [x0 + ½، x1 − ½] — يساراً بعد المسطرة اليسرى (عند x0 + ½) وعرضه لا يتجاوز الحزمة.
 * بلا reach: الورقة كلها (0..W) والحساب كما كان حرفاً.
 */
export function calibrationInfoSpot(boxes: readonly Box[], W: number, H: number, hMm: number, reach?: { x0: number; x1: number } | null): Box {
  const lo = reach ? reach.x0 + REACH_INSET : 0;
  const hi = reach ? reach.x1 - REACH_INSET : W;
  const left = lo + 12;
  const w0 = Math.max(30, Math.min(92, hi - lo - 22));
  const w = reach ? Math.max(0, Math.min(w0, hi - left)) : w0;
  const h = Math.max(5, Math.min(H - 20, hMm));
  const right = Math.max(left, hi - 8 - w);
  const top = 10; const bottom = Math.max(top, H - 6 - h);
  const spots: Box[] = [{ x: right, y: top, w, h }, { x: left, y: top, w, h }, { x: right, y: bottom, w, h }, { x: left, y: bottom, w, h }];
  let best = spots[0];
  let bestArea = Infinity;
  for (const s of spots) {
    const a = boxes.reduce((sum, b) => sum + overlapArea(s, b), 0);
    if (a < bestArea - 1e-9) { best = s; bestArea = a; }
  }
  return best;
}

/** طول علامة المسطرة: 6 مم كل 10، و4 كل 5، و2 لغيرها */
const tickLen = (i: number): number => (i % 10 === 0 ? 6 : i % 5 === 0 ? 4 : 2);

/** مسطرتا الحافتين (بلا إزاحة): علامة كل مم ورقم كل 10 ما ابتعد عن الطرف */
function rulersHtml(W: number, H: number): string {
  const out: string[] = [];
  for (let i = 0; i <= Math.floor(W + 1e-9); i++) {
    out.push(`<i class="t" style="left:${mm(Math.min(i, W - 0.2))};top:0;width:0.2mm;height:${mm(tickLen(i))}"></i>`);
    if (i % 10 === 0 && i > 0 && i < W - 3) out.push(`<b class="n" style="left:${mm(i)};top:6.6mm;transform:translateX(-50%)">${i}</b>`);
  }
  for (let i = 1; i <= Math.floor(H + 1e-9); i++) {
    out.push(`<i class="t" style="left:0;top:${mm(Math.min(i, H - 0.2))};width:${mm(tickLen(i))};height:0.2mm"></i>`);
    if (i % 10 === 0 && i < H - 3) out.push(`<b class="n" style="left:6.6mm;top:${mm(i)};transform:translateY(-50%)">${i}</b>`);
  }
  return out.join('');
}

/**
 * مسطرتا النقطية (بلا إزاحة): العليا على y = 0 بعلامات المليمترات الصحيحة بين lo وhi وحدها، واليسرى على x = lo من 0 إلى H —
 * والأرقام بالمم من حافة الورقة (علامة 10 على 10 مم منها إن لم تنحرف الطابعة) لا من lo، والرقم الأفقيّ ما اتّسع داخل الحزمة وحده
 */
function reachRulersHtml(H: number, lo: number, hi: number): string {
  const out: string[] = [];
  for (let i = Math.ceil(lo - 1e-9); i <= Math.floor(hi - 0.2 + 1e-9); i++) {
    out.push(`<i class="t" style="left:${mm(i)};top:0;width:0.2mm;height:${mm(tickLen(i))}"></i>`);
    if (i % 10 === 0 && i - 3 >= lo && i + 3 <= hi) out.push(`<b class="n" style="left:${mm(i)};top:6.6mm;transform:translateX(-50%)">${i}</b>`);
  }
  for (let i = 1; i <= Math.floor(H + 1e-9); i++) {
    out.push(`<i class="t" style="left:${mm(lo)};top:${mm(Math.min(i, H - 0.2))};width:${mm(tickLen(i))};height:0.2mm"></i>`);
    if (i % 10 === 0 && i < H - 3) out.push(`<b class="n" style="left:${mm(lo + 6.6)};top:${mm(i)};transform:translateY(-50%)">${i}</b>`);
  }
  return out.join('');
}

/**
 * وثيقة صفحة معايرة النموذج — ورقةٌ واحدة (section.sheet) بمقاس الورق ناقص نصف مم (لا تفيض إلى صفحةٍ ثانية). قالبٌ ليس نموذجاً
 * مطبوعاً مسبقاً: المسطرتان والعنوان وحدها.
 * وعلى النقطية (formReachOf): كل ما في الورقة داخل ما تبلغه الإبرة، والورقة data-form-sheet تُرسم نقاطاً بـprintFormHtmlDirect.
 */
export function buildFormCalibration(p: PrintProfile, tr: Tr, opts: FormCalibrationOptions = {}): string {
  const S = formSheetSize(p.paper);
  const W = S.widthMm;
  const H = r2(S.lengthMm - 0.5);
  // المواضع كما تُرسم (مقصوصةً داخل الورقة على الشبكة، وعلى النقطية داخل ما تبلغه الإبرة — كـresolveLayout) لا كما في القالب
  // غير المحفوظ حرفاً
  const raw = formOf(p);
  const form = raw ? fitForm(raw, formPaperOf(p)) : null;
  const reach = formReachOf(p);
  /** حدّا ما يُرسم أفقياً: داخل الحزمة بنصف مم على النقطية — والورقة كلها على العادية (فحساب رقم الصفّ كما كان) */
  const lo = reach ? reach.x0 + REACH_INSET : 0;
  const hi = reach ? reach.x1 - REACH_INSET : W;
  const taxOff = opts.taxOff === true;
  const T = FORM_CALIBRATION_TEXTS;
  // النقطية: impactHelp — وعبر نظام الطباعة (لا direct) يسبقها سطر «100٪» (help[0])؛ والعادية help كما كانت
  const help: readonly string[] = reach ? (opts.direct === true ? T.impactHelp : [T.help[0], ...T.impactHelp]) : T.help;
  const parts: string[] = [];
  /** ما رُسم من مربعات (بعد الإزاحة) — ليوضع العنوان حيث لا يحجبها */
  const drawn: Box[] = [];

  if (form) {
    const fields = form.fields.filter((f) => !(taxOff && (FORM_TAX_FIELD_IDS.includes(f.id) || f.id === 'qr')));
    for (const f of fields) {
      const b = printedBox(form, f);
      drawn.push(b);
      parts.push(`<div class="f" data-field="${f.id}" style="left:${mm(b.x)};top:${mm(b.y)};width:${mm(b.w)};height:${mm(b.h)}"><span>${esc(tr(FORM_FIELD_LABELS[f.id]))}</span></div>`);
    }
    const t = form.table;
    const box = formTableBox(t);
    if (t && box) {
      const cols = t.columns.filter((c) => !(taxOff && FORM_TAX_COLUMN_IDS.includes(c.id)));
      const tb = printedBox(form, box);
      drawn.push(tb);
      /** أعلى الصفّ i بعد الإزاحة */
      const rowY = (i: number): number => printedBox(form, { x: 0, y: tableRowTop(t, i), w: 0, h: 0 }).y;
      for (const c of cols) {
        const cb = printedBox(form, { x: c.x, y: t.y, w: c.w, h: box.h });
        parts.push(`<div class="c" data-column="${c.id}" style="left:${mm(cb.x)};top:${mm(cb.y)};width:${mm(cb.w)};height:${mm(cb.h)}"><span>${esc(tr(FORM_COLUMN_LABELS[c.id]))}</span></div>`);
      }
      // حدّ كل صفّ (من أعلى الأول إلى أسفل الأخير) على عرض الجدول كله
      for (let i = 0; i <= t.rows; i++) {
        parts.push(`<i class="r" data-row-line="${i}" style="left:${mm(tb.x)};top:${mm(rowY(i))};width:${mm(tb.w)}"></i>`);
      }
      // رقم الصفّ يسار الجدول إن اتّسع، وإلا يمينه، وإلا بلا رقم — وعلى النقطية داخل الحزمة: يساره إن خلا من المسطرة اليسرى،
      // وإلا يمينه، وإلا يساره فوق علامات المسطرة، وإلا بلا رقم
      const leftSide = `left:${mm(tb.x - 4)}`;
      const rightSide = `left:${mm(tb.x + tb.w + 0.6)}`;
      const side = reach
        ? (tb.x - 4 >= lo + RULER_CLEAR ? leftSide : tb.x + tb.w <= hi - 4.5 ? rightSide : tb.x - 4 >= lo ? leftSide : null)
        : tb.x >= 4.5 ? leftSide : tb.x + tb.w <= W - 4.5 ? rightSide : null;
      if (side) {
        for (let i = 0; i < t.rows; i++) parts.push(`<b class="rn" style="${side};top:${mm(rowY(i) + t.rowMm / 2)}">${i + 1}</b>`);
      }
    }
  }

  const name = opts.name ? ` — ${esc(opts.name)}` : '';
  const offsets = form
    ? `<div>${esc(tr(T.offset))}: <span dir="ltr">dx ${signedMm(form.dxMm)} mm · dy ${signedMm(form.dyMm)} mm</span></div>`
    : '';
  const tableLine = form?.table
    ? `<div>${esc(tr(T.table))}: <span dir="ltr">${form.table.rows} × ${r2(form.table.rowMm)} mm</span></div>`
    : '';
  // العنوان 3.8 مم، والسطور القصيرة 3.3، وكل تعليمةٍ سطران من 2.9 (قد تلتفّ؛ وثلاثة على النقطية: سطرها الأخير أطول والحزمة قد
  // تضيق) — والحشوة
  const infoH = 2 + 3.8 + 3.3 * (1 + (form ? 1 : 0) + (form?.table ? 1 : 0)) + 2.9 * (reach ? 3 : 2) * help.length;
  const spot = calibrationInfoSpot(drawn, W, H, infoH, reach);
  const info = `<div class="info" data-form-calibration-info="" style="left:${mm(spot.x)};top:${mm(spot.y)};width:${mm(spot.w)}"><div class="h">${esc(tr(T.title))}${name}</div>${offsets}${tableLine}<div dir="ltr" class="sz">${r2(W)} × ${r2(S.lengthMm)} mm</div>${help.map((h) => `<div class="hp">• ${esc(tr(h))}</div>`).join('')}</div>`;
  // النقطية: الورقة ورقة نموذجٍ تُرسم نقاطاً (formRasterPages تأخذ كل [data-form-sheet])، والمسطرتان داخل الحزمة، واسم الحقل
  // الطويل والعنوان مقصوصان داخل صندوقيهما فلا يفيض حبرٌ خارج الحزمة (لاسمٍ أعرض من حقلٍ ضيّق على حدّها)
  const sheetAttrs = reach ? ' data-form-sheet="1"' : '';
  const rulers = reach ? reachRulersHtml(H, lo, hi) : rulersHtml(W, H);
  const reachCss = reach ? '\n    .f, .info { overflow: hidden; }' : '';

  return `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8"/>
  <style>
    @page { size: ${mm(W)} ${mm(S.lengthMm)}; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; background: #fff; }
    body { width: ${mm(W)}; font-family: Tahoma, Arial, sans-serif; color: #000; }
    .sheet { position: relative; width: ${mm(W)}; height: ${mm(H)}; overflow: hidden; }
    .t { position: absolute; background: #000; }
    .n { position: absolute; font-size: 2.4mm; font-weight: 400; line-height: 1; }
    .f { position: absolute; border: 0.25mm dashed #000; }
    .f > span { position: absolute; top: 0.3mm; right: 0.4mm; font-size: 2.2mm; line-height: 1; white-space: nowrap; background: #fff; padding: 0 0.3mm; }
    .c { position: absolute; border-left: 0.2mm dashed #000; border-right: 0.2mm dashed #000; }
    .c > span { position: absolute; top: 0.3mm; left: 0; right: 0; text-align: center; font-size: 2mm; line-height: 1; white-space: nowrap; overflow: hidden; }
    .r { position: absolute; height: 0; border-top: 0.15mm dashed #000; }
    .rn { position: absolute; font-size: 2mm; font-weight: 400; line-height: 1; transform: translateY(-50%); }
    .info { position: absolute; font-size: 2.4mm; line-height: 1.35; background: transparent; padding: 0.5mm 1mm; }
    .info .h { font-weight: 700; font-size: 2.8mm; }
    .info .hp { font-size: 2.1mm; }${reachCss}
  </style></head><body><section class="sheet" data-form-calibration=""${sheetAttrs}>${rulers}${parts.join('')}${info}</section></body></html>`;
}
