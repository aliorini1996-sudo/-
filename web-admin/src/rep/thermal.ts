// طباعة حرارية 58 مم — تعمل مع الطابعة المدمجة أو طابعة بلوتوث عبر نظام الطباعة في الجهاز
/* «إعدادات الطباعة» M2 (التصميم §3.2): القالب الكلاسيكي أعلاه كما هو حرفاً بحرف (بلا قالب أو بالملف legacy-58)، ومعه قالبا
 * رول جديدان بأي عرض — «مختصر» (البند في سطرين) و«مفصّل» (جدول كمية/سعر/إجمالي من 72 مم). القرار الضريبي واحدٌ للثلاثة:
 * يُتّخذ هنا مرّة (`d`) ويُمرَّر للقالبين الجديدين، فلا يبني أيٌّ منهما عنواناً أو رمزاً أو سطر ضريبة لنفسه. */
import QRCode from 'qrcode';
import { buildZatcaQr, zatcaTimestamp } from './zatca';
import { getActiveCurrency, getActiveNumerals } from '../utils/format';
// «إدارة طرق الدفع»: اسم الشركة للطريقة كما كتبته (بلا tr)، وإلا الافتراضي — بلا tr في الكلاسيكي فيبقى «نقدي» بايتاً ببايت
// لشركةٍ بلا إعداد (حارس GOLDEN_RECEIPT_ONE)، ومترجماً في القالبين الجديدين كما اليوم
import { methodLabelFor } from '../lib/paymentMethodsConfig';
import { currencyDecimals, currencySymbol } from '../i18n/countries';
import type { InvoiceDoc, ReceiptDoc } from './RepDocuments';
import { creditNoteRefs, isSaudiDoc, isSignatureSrc, showsItemUnit } from './RepDocuments';
import { zatcaPrintDecision, type ZatcaPrintDecision } from '../lib/zatca/docPrint';
import { receiptLinkView } from './receiptLinks';
import { PRINT_WARNINGS, dotsPerMm, geometry, legacyThermalProfile, presetPaper, qrPlan, type Paper, type PrintOptions, type PrintProfile, type PrinterDpi } from '../lib/print/printSettings';
import { makePrintTexts, normalizePrintTexts, type PrintTexts } from '../lib/print/printTexts';
import { PrintRefusedError } from '../lib/print/printErrors';
import { iosSystemPrint, iosSystemPrintAvailable } from '../lib/print/transport/iosBridge';
import { COPY_SLOT, LEGACY_THERMAL_GEOM, buildThermalDocument, rollHeightMm, thermalGeom, thermalPageRule, type ThermalGeom } from './thermalHtml';
import { invoiceLotsOf, lotLineText } from './docLots';
// «تخطيط المطبوعات» (pl_spec v2 — B2/C(iii)): الشعار في الوسط أو بلا شعار وحجمه، وترتيب الأقسام — null ⇒ رول اليوم حرفاً بحرف
import { logoBox, orderedSections, resolveLayout, rollSectionsHtml, type ResolvedLayout } from '../lib/print/layout';
// «التحرير الحرّ» (طلب المالك ٣ نوفمبر ٢٠٢٦، pd_spec B.2/B.3/C.(iii)): حجم الشعار بالملّيمتر ومحاذاته ومكانه كتلةً مستقلة، ولكل قسم
// إظهار/إخفاء ومحاذاة وحجم خط ومسافة — كلّه خلف hasFreeLayout، فقالبٌ بلا المفاتيح الأربعة يطبع كما قبلها حرفاً بحرف
import { DEFAULT_SECTIONS, fontPx, hasFreeLayout, logoPlan, sectionCssText, sectionLook, visibleOrder, type LogoPlan } from '../lib/print/layout';
import type { SectionId } from '../lib/print/printSettingsCore';

type Tr = (ar: string) => string;
/** الشريط الكلاسيكي عربيٌّ وحده كما اليوم — فمترجمه الهويّة */
const asIs: Tr = (ar) => ar;

/** الطباعة المباشرة (M3، rep/printDirect.ts): تستلم وثيقة الشريط بدل نظام الطباعة فترسمها وترسلها بالبلوتوث */
export type ThermalRasterSink = (html: string, geom: ThermalGeom) => Promise<void>;

export interface ThermalPrintOptions {
  /** قالب الطباعة (lib/print) — غيابه أو الكلاسيكي ⇒ شريط اليوم 58 مم حرفاً بحرف */
  profile?: PrintProfile | null;
  /** مترجم القالبين الجديدين (useTr من الشاشة) — يتبعان قاعدة لغة قوالب A4 */
  tr?: Tr;
  /** القالبان الجديدان وحدهما: الوثيقة للبلوتوث المباشر، ورمز QR خانةً يُرسم فيها بنقاط صحيحة (لا صورة تُعاد عيّنتها) */
  raster?: ThermalRasterSink | null;
  /** الطباعة التجريبية من الإعدادات (القالبان الجديدان): شريط «نموذج اختبار» HTML أوّل المستند وآخره */
  sampleBanner?: string | null;
  /** معاينة محرّر «نصوص المطبوعات»: الوثيقة نفسها تُسلَّم هنا بدل الطباعة (الكلاسيكي والجديدان) */
  capture?: ((html: string) => void) | null;
  /**
   * مصمّم الشريط بالسحب (pd_spec B.5): وسم `data-pd` على كل قسمٍ وعلى الشعار ليضع المصمّم مقابضه فوقها — للمعاينة وحدها،
   * والطباعة الحقيقية لا تمرّره أبداً. الكلاسيكي بلا وسوم (لا يُحرَّر إلا نسخةً مختصرة).
   */
  markers?: boolean;
}

/** طباعةٌ تُرفض بسبب يقرؤه المندوب — الصنف في lib/print/printErrors.ts (يرميه رسم البلوتوث أيضاً)، ويُصدَّر من هنا كما كان */
export { PrintRefusedError };

interface Roll {
  profile: PrintProfile; o: PrintOptions; tr: Tr; detailed: boolean; raster: ThermalRasterSink | null; banner: string | null;
  capture: ((html: string) => void) | null;
  /** «نصوص المطبوعات» (lib/print/printTexts.ts) — بلا نصوص: tr كما مُرِّر ولا إخفاء ولا لغة ثانية */
  pt: PrintTexts;
  /** 72 مم مطبوعة فأعرض: اللغة الثانية بجانب العربي؛ والأضيق تحته */
  wide: boolean;
  /** تخطيط القالب (options.layout) — null ⇒ الشعار والترتيب كاليوم حرفاً بحرف (بلا تخطيط، أو الملف الافتراضي المستبدَل) */
  layout: ResolvedLayout | null;
  /** أحد المفاتيح الحرّة الأربعة (logoMm/logoAfter/sections/canvas) — وإلا مسار التخطيط كما كان حرفاً بحرف */
  free: boolean;
  /** وسوم المصمّم (ThermalPrintOptions.markers) */
  markers: boolean;
}

/**
 * «حذف السطر» (طلب المالك ٣، pl_spec B3): عبارةٌ حذفتها الشركة تُسقط وحدتها كاملةً — التسمية وقيمتها، أو عمود الجدول، أو صفّ
 * الإجمالي، أو الخانة — ولا قفل على أي مفتاح. يساوي isLineDeleted(pt, key) في lib/print/printTexts (= pt.hidden). بلا نصوص: false دائماً.
 */
const gone = (r: Roll, key: string): boolean => r.pt.hidden(key);

/**
 * قالب رول جديد أو null للشريط الكلاسيكي (غياب القالب، أو roll_classic، أو قالبٌ لغير الحرارية).
 *
 * «نصوص المطبوعات»: الشريط الكلاسيكي مجمَّد حرفاً بحرف (الحارس الذهبيّ) ولا يعرف صياغةً ولا إخفاءً ولا لغةً ثانية — فشركةٌ
 * حفظت نصوصاً تطبع مكانه «الشريط المختصر» على ورقه نفسه (58 مم) بخياراته الافتراضية، وهو الذي يحمل نصوصها. وبلا نصوص كما اليوم.
 */
function rollOf(opts: ThermalPrintOptions | undefined, company: InvoiceDoc['company'], standard: boolean): Roll | null {
  const texts = normalizePrintTexts(company?.printTexts);
  let p = opts?.profile;
  if (!p || p.printer !== 'thermal' || p.template === 'roll_classic') {
    if (!texts) return null;
    p = { ...legacyThermalProfile(), template: 'roll_compact' };
  }
  const pt = makePrintTexts(texts, opts?.tr ?? asIs, { standard });
  const layout = resolveLayout(p);
  return {
    profile: p, o: p.options, tr: pt.tr, detailed: p.template === 'roll_detailed',
    raster: opts?.raster ?? null, banner: opts?.sampleBanner ?? null, capture: opts?.capture ?? null,
    pt, wide: geometry(p).printableWidthMm >= 70,
    layout, free: hasFreeLayout(layout), markers: !!opts?.markers,
  };
}

/**
 * تسمية الشريط بنصوص الشركة: صياغتها (مُهرَّبة — نصٌّ حرّ في وثيقةٍ تُكتب بـdocument.write) ومعها سطر اللغة الثانية تحتها في الرول
 * الضيّق أو بجانبها في العريض. بلا نصوص: `tr(ar)` كما يدرجه القالب اليوم حرفاً بحرف. `suffix` (النسبة) للعربي وحده.
 */
function lbl(r: Roll, key: string, ar: string, o?: { suffix?: string; stack?: boolean }): string {
  const base = r.pt.on ? esc(r.pt.text(key, ar)) : r.pt.text(key, ar);
  const text = o?.suffix ? `${base} ${o.suffix}` : base;
  const alt = r.pt.alt(key, ar);
  return alt ? `${text}${altSpan(r, esc(alt), o?.stack)}` : text;
}

/** سطر اللغة الثانية — بأسلوبٍ مضمَّن لا صنفٍ في الوثيقة، فلا تتغيّر وثيقة شركةٍ بلا نصوص حرفاً */
function altSpan(r: Roll, html: string, stack?: boolean): string {
  return r.wide && !stack
    ? `<span dir="ltr" style="font-weight:400;font-size:0.85em;margin-right:4px;unicode-bidi:isolate">${html}</span>`
    : `<span dir="ltr" style="display:block;font-weight:400;font-size:0.85em;unicode-bidi:isolate">${html}</span>`;
}

/** قيمةٌ ثابتة من القاموس (عبارات القرار) بلغة القالب وبجانبها اللغة الثانية — لا تُعاد صياغتها */
function val(r: Roll, ar: string): string {
  const text = r.tr(ar);
  const alt = r.pt.valueAlt(ar, text);
  return alt ? `${text}${altSpan(r, esc(alt))}` : text;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}
/**
 * مبلغ بخانات عملة الشركة النشطة (٢/٣) وبشكل الأرقام الذي اختارته الشركة.
 *
 * الأساس toFixed (لاتيني بخانات مضبوطة) ثم تُترجم الخانات إن اختيرت العربية —
 * وليس Intl: حاجز الآلاف يضيّق سطر الطابعة ٥٨ مم ويكسر محاذاة الأعمدة.
 * ⚠️ لا يمس رمز الفاتورة الضريبية: حمولته تُبنى من الأرقام الخام مباشرة.
 */
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function localizeDigits(s: string): string {
  return getActiveNumerals() === 'arabic'
    ? s.replace(/\d/g, d => AR_DIGITS[Number(d)]).replace(/\./g, '٫')
    : s;
}
function money(n: number): string {
  return localizeDigits((Number(n) || 0).toFixed(currencyDecimals(getActiveCurrency())));
}
function curSym(): string { return currencySymbol(getActiveCurrency()); }
function dt(d: string): string {
  const t = new Date(d);
  if (isNaN(t.getTime())) return '';
  const p = (x: number) => String(x).padStart(2, '0');
  return localizeDigits(`${p(t.getDate())}/${p(t.getMonth() + 1)}/${t.getFullYear()} ${p(t.getHours())}:${p(t.getMinutes())}`);
}

/**
 * يطبع محتوى HTML في إطار مخفي — الشريط الكلاسيكي بمقاس 58 مم كما اليوم حرفاً بحرف (الوثيقة والإطار والمهلة)، والقوالب
 * الجديدة بمقاس ورقها: الإطار بعرض الورق كي يُخطَّط المحتوى بعرضه الفعليّ، ثم تُقاس النسخة الأطول وتُكتب قاعدة @page بطولها
 * (Chrome يُسقط `58mm auto` فيقع على مقاسٍ افتراضيّ) — ولا طباعة قبل تحميل الصور والخطوط.
 * وفي تطبيق الآيفون (iosSystemPrintAvailable) الوثيقة نفسها إلى نافذة الطباعة في التطبيق: print() في WKWebView لا يفتحها،
 * والتطبيق يقسّم الصفحات بمقاس الورق المختار هناك.
 */
function printHTML(body: string, geom: ThermalGeom = LEGACY_THERMAL_GEOM, freeCss?: string): void | Promise<void> {
  const html = buildThermalDocument(body, geom, undefined, freeCss);
  if (iosSystemPrintAvailable()) return iosSystemPrint(html, geom.paperWidthMm, '');

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = geom.legacy
    ? 'position:fixed;right:-9999px;bottom:0;width:80mm;height:0;border:0;'
    : `position:fixed;right:-9999px;bottom:0;width:${geom.paperWidthMm}mm;height:0;border:0;`;
  document.body.appendChild(iframe);
  const idoc = iframe.contentWindow?.document;
  if (!idoc) { iframe.remove(); return; }
  idoc.open(); idoc.write(html); idoc.close();

  const fire = () => {
    try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch { /* */ }
    setTimeout(() => iframe.remove(), 2000);
  };
  if (geom.legacy) {
    // ننتظر تحميل صورة QR قبل إطلاق الطباعة
    setTimeout(fire, 400);
    return;
  }
  return settle(idoc).then(() => {
    // الرول: طول الصفحة = أطول نسخة (كلّ نسخة صفحتها)؛ والورق المقطع طوله ثابتٌ في القاعدة منذ البناء
    if (geom.pageLengthMm === null) {
      const heights = Array.from(idoc.querySelectorAll('section.copy')).map((el) => el.getBoundingClientRect().height);
      const rule = idoc.getElementById('fs-page');
      if (rule) rule.textContent = thermalPageRule(geom, rollHeightMm(heights));
    }
    fire();
  });
}

/** الصور (الرمز والشعار) ثم الخطوط — بسقف زمني: صورةٌ معطوبة لا تحبس الطباعة */
async function settle(idoc: Document): Promise<void> {
  const imgs = Array.from(idoc.images ?? []).filter((img) => !(img.complete && img.naturalWidth > 0));
  await Promise.race([
    Promise.all(imgs.map((img) => new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    }))),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);
  try { await idoc.fonts?.ready; } catch { /* خطّ النظام */ }
}

async function qrBlock(company: InvoiceDoc['company'], date: string, total: number, vat: number): Promise<string> {
  if (!company?.taxNumber) return '';
  try {
    const payload = phase1Payload(company, date, total, vat);
    const url = await QRCode.toDataURL(payload, { width: 160, margin: 0 });
    return `<div class="qr"><img src="${url}" width="124" height="124"/></div>`;
  } catch { return ''; }
}

/** حمولة رمز المرحلة الأولى من بيانات الشركة والمستند — لا تُستدعى إلا خلف `d.qr.source === 'phase1'` (السطر المحروس) */
function phase1Payload(company: NonNullable<InvoiceDoc['company']>, date: string, total: number, vat: number): string {
  return buildZatcaQr({
    sellerName: company.name || '', vatNumber: company.taxNumber as string,
    timestamp: zatcaTimestamp(date), total, vatTotal: vat,
  });
}

/**
 * خانة الرمز للطباعة المباشرة (التصميم §4.3): مكان الصورة مربّعٌ أبيض بمقاس الرمز ومنطقته الصامتة (خليتان) بنقاط qrPlan لهذا
 * القالب، يحمل القيمة كما هي ومستوى تصحيحها — وraster.ts يرسم فيه الرمز بنقاطٍ صحيحة من QRCode.create. ولا يتسع ⇒ رفض.
 */
function qrSlot(value: string, ec: 'L' | 'M', p: PrintProfile): string {
  const cells = QRCode.create(value, { errorCorrectionLevel: ec }).modules.size;
  const plan = qrPlan(p, cells);
  if (!plan || !plan.fits || p.paper.dpi === null) throw new PrintRefusedError(PRINT_WARNINGS.qrNoFit);
  const side = Math.round((((cells + 4) * plan.dotsPerCell + 1) / dotsPerMm(p.paper.dpi as PrinterDpi)) * 100) / 100;
  return `<div class="qr"><div class="qrslot" data-qr-value="${esc(value)}" data-qr-ec="${ec}" style="width:${side}mm;height:${side}mm"></div></div>`;
}

type QrBuilders = {
  stampedQrBlock: (value: string) => Promise<string>;
  qrBlock: (company: InvoiceDoc['company'], date: string, total: number, vat: number) => Promise<string>;
};

/**
 * بانيا الرمز لهذه المهمة: الصورة لنظام الطباعة (الدالّتان أعلاه كما هما — والشريط الكلاسيكي لا يعرف غيرهما)، والخانة للبلوتوث.
 * الاسمان يُظلَّلان محلياً في printThermalInvoice فيبقى السطر المحروس (`const qr = d.qr.source === 'stamped' …`) حرفاً بحرف:
 * المختوم من القرار كما وصل، ورمز المرحلة الأولى خلف مصدره — في الطريقتين.
 */
function qrBuilders(roll: Roll | null): QrBuilders {
  if (!roll?.raster) return { stampedQrBlock, qrBlock };
  const p = roll.profile;
  return {
    stampedQrBlock: async (value) => qrSlot(value, 'L', p),
    qrBlock: async (company, date, total, vat) => {
      if (!company?.taxNumber) return '';
      let payload: string;
      try { payload = phase1Payload(company, date, total, vat); } catch { return ''; }
      return qrSlot(payload, 'M', p);
    },
  };
}

/**
 * رمز المرحلة الثانية المختوم — يُرسم كما وصل من الخادم بلا بناء ولا تعديل.
 *
 * وحمولته نحو ٧٠٠ محرف (التوقيع والمفتاح العامّ والبصمة) مقابل ~١٢٠ في المرحلة الأولى، فنسخته أكبر بكثير وحُجَيراتها
 * أدقّ: صورة ١٢٤px كانت تعطي أقلّ من ٣ نقاط للحُجَيرة على طابعة ٥٨مم/٢٠٣dpi فلا يقرؤها ماسح. فالصورة ١٦٨px من مصدر
 * ٤٢٠px، وتصحيح الخطأ L (لا M) ليقلّ عدد الحُجَيرات — والمعيار لا يشترط مستوى تصحيح.
 */
async function stampedQrBlock(value: string): Promise<string> {
  try {
    const url = await QRCode.toDataURL(value, { width: 420, margin: 0, errorCorrectionLevel: 'L' });
    return `<div class="qr"><img src="${url}" width="168" height="168"/></div>`;
  } catch { return ''; }
}

/**
 * «تتبّع اللوط»: سطرٌ لكل تشغيلة تحت البند بشرط lotOnInvoice — النصّ نفسه في قالب A4 (rep/docLots.ts)، بأرقام الشريط. بلا
 * شرطه أو بلا صفوف: '' فيبقى الشريط حرفاً بحرف كما كان. الكلاسيكي يمرّر asIs (عربيٌّ وحده كما اليوم).
 */
function lotRows(doc: InvoiceDoc, it: InvoiceDoc['items'][number], tr: Tr): string {
  return invoiceLotsOf(doc.company, it)
    .map((l) => `<div class="muted">${esc(lotLineText(l, { tr, unitFactor: it.unitFactor, digits: localizeDigits }))}</div>`)
    .join('');
}

/**
 * الإشعار الدائن: صفّا مرجع الفاتورة الأصلية (BT-25، رقمٌ لاتينيّ باتجاهه) وسبب الإرجاع (KSA-10) — بقاعدة A4 نفسها (creditNoteRefs)
 * ومُهرَّبين (نصٌّ حرّ في وثيقةٍ تُكتب بـdocument.write). `L` تسمية القالب: العربية كما هي للكلاسيكي، وlbl للقالبين الجديدين.
 * مستندٌ لا يحملهما ⇒ '' بلا مسافةٍ ولا سطر، فيبقى الشريط حرفاً بحرف (الحارس الذهبيّ).
 */
function noteRows(doc: InvoiceDoc, L: (key: string, ar: string) => string, del: (key: string) => boolean = () => false): string {
  const { ref, reason } = creditNoteRefs(doc);
  return (ref && !del('inv.originalRef') ?`\n    <div class="row"><span>${L('inv.originalRef', 'الفاتورة الأصلية')}</span><span dir="ltr">${esc(ref)}</span></div>` : '')
    + (reason && !del('inv.noteReason') ? `\n    <div class="row"><span>${L('inv.noteReason', 'سبب الإرجاع')}</span><span>${esc(reason)}</span></div>` : '');
}

function head(company: InvoiceDoc['company']): string {
  return `
    <div class="c b lg">${esc(company?.name || 'الشركة')}</div>
    ${company?.taxNumber ? `<div class="c muted">الرقم الضريبي ${esc(company.taxNumber)}</div>` : ''}
    ${company?.address ? `<div class="c muted">${esc(company.address)}</div>` : ''}
    ${company?.phone ? `<div class="c muted">هاتف ${esc(company.phone)}</div>` : ''}`;
}

export async function printThermalInvoice(doc: InvoiceDoc, opts?: ThermalPrintOptions): Promise<void> {
  const isSimplified = !doc.customer.taxNumber;
  /* فوترة ZATCA المرحلة الثانية (Z5.6b، نقد الخطة 6): القرار نفسه الذي يحكم قالب A4 يحكم الشريط الحراريّ —
   * وإلا طُبع الرمز المبنيّ محلياً على ورقة مستندٍ مختوم. تصنيف ZATCA سعوديّ؛ خارج السعودية العنوان محايد. */
  const d = zatcaPrintDecision(
    { isReturn: !!doc.isReturn, buyerHasTaxNumber: !isSimplified, saudi: isSaudiDoc(doc.company) },
    doc.zatca,
  );
  const title = d.title;
  // القالبان الجديدان أو الكلاسيكي — يُعرف قبل الرمز: البلوتوث المباشر يأخذ الرمز خانةً لا صورة (qrBuilders)
  const roll = rollOf(opts, doc.company, d.standardLayout);
  const { stampedQrBlock, qrBlock } = qrBuilders(roll);
  const qr = d.qr.source === 'stamped' && d.qr.value ? await stampedQrBlock(d.qr.value)
    : d.qr.source === 'phase1' ? await qrBlock(doc.company, doc.date, doc.total, doc.tax)
    : '';
  const items = doc.items.map(it => `
    <div class="item">
      <div class="iname">${esc(it.name)}${it.unit ? ` <span class="muted">(${esc(it.unit)})</span>` : ''}</div>
      <div class="row"><span>${localizeDigits(String(it.qty))} × ${money(it.unitPrice)}${it.discountPct > 0 ? ` -${localizeDigits(String(it.discountPct))}%` : ''}</span><span class="b">${money(it.lineTotal)}</span></div>${lotRows(doc, it, asIs)}
    </div>`).join('');

  // نسبة الضريبة من البنود نفسها: الاشتقاق العكسي من المبالغ كان يطبع نسبة
  // مدمجة لا وجود لها قانونيا عند اختلاط بنود بنسب مختلفة (15% + معفى → «8%»)
  const vatPcts = [...new Set(doc.items.map(it => Number(it.taxPct)))];
  const vatRate = vatPcts.length === 1 ? `${vatPcts[0]}%` : 'نسب متعددة';
  // الأسعار شاملة؟ العلم الصريح ثمّ الاستدلال الحسابي — كقالب A4 حرفاً بحرف
  const inclusiveDoc = doc.pricesIncludeTax ?? (doc.tax > 0 && Math.abs((doc.subtotal - doc.discount) - doc.total) < 0.005);

  // القالبان الجديدان: الوقائع نفسها (القرار والعنوان والرمز والشمول) — والكلاسيكي أدناه لا يتغيّر
  if (roll) {
    // دفاعٌ ثانٍ خلف شاشة النتيجة: مستندٌ لا ورقة له (مُبطل أو لم تحسمه الهيئة) لا يُطبع من أيّ قالبٍ جديد
    if (!d.canPrint) throw new PrintRefusedError(d.notice || 'لا يحمل هذا المستند رمز فاتورة ضريبية');
    await deliverRoll(rollInvoiceBody({ doc, d, title, qr: rollQr(d, qr, roll.profile), vatPcts, inclusiveDoc }, roll), roll);
    return;
  }

  await classicOut(opts, `
    ${head(doc.company)}
    <div class="sep"></div>
    <div class="c b">${esc(title)}</div>
    ${d.watermark ? `<div class="c b muted">${esc(d.watermark)}</div>` : ''}
    ${d.notice ? `<div class="sep"></div><div class="c muted">${esc(d.notice)}</div>` : ''}
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>التاريخ</span><span>${dt(doc.date)}</span></div>${noteRows(doc, (_key, ar) => ar)}
    ${doc.deliveryDate ? `<div class="row"><span>تاريخ التسليم</span><span>${dt(doc.deliveryDate).split(' ')[0]}</span></div>` : ''}
    <div class="row"><span>المندوب</span><span>${esc(doc.repName)}</span></div>
    <div class="row"><span>العميل</span><span>${esc(doc.customer.name)}</span></div>
    ${doc.customer.taxNumber ? `<div class="row"><span>ر.ضريبي</span><span>${esc(doc.customer.taxNumber)}</span></div>` : ''}
    <div class="sep"></div>
    ${items}
    <div class="sep"></div>
    ${d.showTaxBreakdown ? `<div class="row"><span>المجموع قبل الضريبة</span><span>${money(doc.total - doc.tax)}</span></div>` : ''}
    ${doc.discount > 0 ? `<div class="row"><span>الخصم</span><span>${money(doc.discount)}</span></div>` : ''}
    ${d.showTaxBreakdown ? `<div class="row"><span>ض.ق.م ${vatRate}</span><span>${money(doc.tax)}</span></div>` : ''}
    <div class="row b lg"><span>${doc.isReturn ? 'إجمالي المرتجع'
      : !d.showTaxBreakdown && !inclusiveDoc && doc.tax > 0 ? 'المبلغ المستحق شامل الضرائب'
      : 'الإجمالي'}</span><span>${money(doc.total)}</span></div>
    ${!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined ? `
      <div class="row muted"><span>المدفوع</span><span>${money(doc.paidAmt ?? 0)}</span></div>
      <div class="row muted"><span>المتبقي</span><span>${money(doc.remainingAmt)}</span></div>` : ''}
    <div class="sep"></div>
    ${[[doc.recipientSignature, 'توقيع المستلم'], [doc.repSignature, 'توقيع المندوب']].map(([src, label]) => isSignatureSrc(src)
      ? `<div class="c"><img src="${esc(src)}" alt="" style="max-width:70%;max-height:60px"><div class="muted">${label}</div></div><div class="sep"></div>`
      : '').join('')}
    ${qr}
    ${doc.zatca && doc.zatca.icv !== null ? `<div class="c muted">ICV ${localizeDigits(String(doc.zatca.icv))}</div>` : ''}
    ${doc.zatca?.uuid ? `<div class="c muted" style="word-break:break-all;direction:ltr">${esc(doc.zatca.uuid)}</div>` : ''}
    <div class="c muted">${esc(doc.company?.name || '')}</div>
    <div class="c muted">شكرا لتعاملكم معنا</div>
  `);
}

/** الشريط الكلاسيكي إلى نظام الطباعة كما اليوم — أو إلى معاينة المحرّر (capture) بالوثيقة نفسها */
function classicOut(opts: ThermalPrintOptions | undefined, body: string): void | Promise<void> {
  if (opts?.capture) { opts.capture(buildThermalDocument(body)); return; }
  return printHTML(body);
}

/**
 * «مقابل الفاتورة رقم …» بنفس قرار قالب A4 (`receiptLinkView`) — سطورٌ لا جدول. والمترجم للقالبين الجديدين؛ الكلاسيكي عربيّ.
 * `L` تسميات «نصوص المطبوعات» للقالبين الجديدين (lbl) و`hidden` إخفاؤها — غيابهما ⇒ tr كما كان ولا إخفاء (الكلاسيكي حرفاً بحرف).
 * والمحذوفة تُسقط سطرها كاملاً (طلب المالك ٣): «مقابل الفاتورة رقم» بصفّه، و«مقابل الفواتير» بكتلته.
 */
function receiptInvoiceRows(doc: ReceiptDoc, tr: Tr = asIs, L?: (key: string, ar: string) => string, hidden: (key: string) => boolean = () => false): string {
  const t = (key: string, ar: string): string => (L ? L(key, ar) : tr(ar));
  const view = receiptLinkView(doc, currencyDecimals(getActiveCurrency()));
  if (view.kind === 'unknown') return '';
  if (view.kind === 'pending') return `<div class="sep"></div><div class="c muted">${tr('يحدد رقم الفاتورة عند مزامنة السند')}</div>`;
  if (view.kind === 'onAccount') return `<div class="sep"></div><div class="c muted">${tr('دفعة على الحساب غير مرتبطة بفاتورة')}</div>`;
  // المفرد والجمع بعدد الفواتير وحده كقالب A4 — والمبالغ تُفصَّل حين تتعدّد أو يفيض رصيد
  const single = view.links.length === 1;
  const showAmounts = !single || view.unallocated > 0;
  /* «حذف السطر» (طلب المالك ٣ — يحلّ محلّ «ربط السند بفاتورته لا يُخفى»): حذف «مقابل الفاتورة رقم» يُسقط صفّه بتسميته ورقمه،
   * وحذف «مقابل الفواتير» يُسقط كتلته كلّها (العنوان وصفوف الفواتير). الكلاسيكي لا يمرّر hidden فلا يتغيّر */
  const blockGone = !single && hidden('rcp.forInvoices');
  const heading = single
    ? (hidden('rcp.forInvoice')
      ? ''
      : `<div class="row"><span>${t('rcp.forInvoice', 'مقابل الفاتورة رقم')}</span><span class="b">${esc(view.links[0].number)}</span></div>`)
    : (blockGone ? '' : `<div class="c muted">${t('rcp.forInvoices', 'مقابل الفواتير')}</div>`);
  const rows = heading + (showAmounts && !blockGone
    ? view.links.map(l => `<div class="row"><span>${esc(l.number)}</span><span>${money(l.amount)}</span></div>`).join('')
    : '');
  const rest = view.unallocated > 0 && !hidden('rcp.credit')
    ? `<div class="row"><span>${t('rcp.credit', 'رصيد دائن للعميل')}</span><span>${money(view.unallocated)}</span></div>`
    : '';
  return `<div class="sep"></div>${rows}${rest}`;
}

export async function printThermalReceipt(doc: ReceiptDoc, opts?: ThermalPrintOptions): Promise<void> {
  const roll = rollOf(opts, doc.company, false);
  if (roll) { await deliverRoll(rollReceiptBody(doc, roll), roll); return; }
  await classicOut(opts, `
    ${head(doc.company)}
    <div class="sep"></div>
    <div class="c b">سند قبض</div>
    ${doc.cancelled ? '<div class="c b">— سند ملغى —</div>' : ''}
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>التاريخ</span><span>${dt(doc.date)}</span></div>
    <div class="row"><span>المندوب</span><span>${esc(doc.repName)}</span></div>
    <div class="sep"></div>
    <div class="row"><span>استلمنا من</span><span>${esc(doc.customer.name)}</span></div>
    <div class="row"><span>طريقة الدفع</span><span>${esc(methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey))}</span></div>
    ${doc.notes ? `<div class="row"><span>ملاحظات</span><span>${esc(doc.notes)}</span></div>` : ''}
    <div class="sep"></div>
    <div class="c muted">المبلغ المستلم</div>
    <div class="c b xl">${money(doc.amount)} ${curSym()}</div>
    ${receiptInvoiceRows(doc)}
    <div class="sep"></div>
    <div class="c muted">${esc(doc.company?.name || '')}</div>
    <div class="c muted">شكرا لتعاملكم معنا</div>
  `);
}

// ═══ القالبان الجديدان: «شريط مختصر» و«شريط مفصّل» بأي عرض (التصميم §1.5) ═══
// يتبعان قاعدة لغة قوالب A4 (tr)، ويأخذان العنوان والرمز وسطر الضريبة وعنوان الإجمالي والتنبيه والعلامة المائية من القرار
// `d` الذي اتّخذته printThermalInvoice — لا شيء من ذلك خيارٌ تُخفيه الشركة (§1.6).

const rollGeom = (r: Roll): ThermalGeom => thermalGeom(r.profile, [r.tr('الأصل'), r.tr('نسخة')]);

/**
 * جسم القالب الجديد إلى طابعته: نظام الطباعة (إطارٌ مخفيّ، كما في M2) أو البلوتوث المباشر (الوثيقة نفسها تُرسم وتُرسل).
 * وفي الطباعة التجريبية شريط «نموذج اختبار» أوّل الجسم وآخره — في كل نسخة.
 */
function deliverRoll(body: string, r: Roll): void | Promise<void> {
  const b = r.banner ? `${r.banner}${body}${r.banner}` : body;
  const geom = rollGeom(r);
  // «التحرير الحرّ»: قواعد الأقسام وشكل الجدول في <style> ثانٍ — '' بلا تحرير فالوثيقة كما كانت
  const css = rollFreeCss(r) || undefined;
  if (r.capture) { r.capture(buildThermalDocument(b, geom, undefined, css)); return; }
  return r.raster ? r.raster(buildThermalDocument(b, geom, undefined, css), geom) : printHTML(b, geom, css);
}

/** شعارٌ يُطمأنّ إليه في <img>: صورة نقطية بصيغة data URL كما يحفظها صفّ الشركة — وغيره لا يُطبع */
const isRasterSrc = (v: unknown): v is string => typeof v === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(v);

/**
 * الرمز المختوم بمقاسه على هذا القالب (التصميم §3.4): خلاياه من QRCode.create على القيمة نفسها كما وصلت (لا بناء)،
 * ونقاط الخلية من qrPlan — «تلقائي» أو «كبير» ولا تنزل عن حدّ الدقة. وإن لم يتسع حتى بالحدّ الأدنى تُرفض الطباعة ويبقى PDF.
 * رمز المرحلة الأولى بمقاس اليوم: حمولته نحو ١٢٠ محرفاً فتتسع في أيّ عرض.
 */
function rollQr(d: ZatcaPrintDecision, qr: string, profile: PrintProfile): string {
  if (!qr || d.qr.source !== 'stamped' || !d.qr.value) return qr;
  const cells = QRCode.create(d.qr.value, { errorCorrectionLevel: 'L' }).modules.size;
  const plan = qrPlan(profile, cells);
  if (!plan || !plan.fits) throw new PrintRefusedError(PRINT_WARNINGS.qrNoFit);
  return `<div class="qrbox" style="--qr:${Math.round(plan.sizeMm * 100) / 100}mm">${qr}</div>`;
}

/** المحاذاة المنطقية بحافة الورق الفعلية: البداية يمين الشريط (RTL) — وhtml2canvas لا يعرف start/end فتُكتب فيزيائياً */
const PHYS_ALIGN = Object.freeze({ start: 'right', center: 'center', end: 'left' } as const);
type RollAlign = keyof typeof PHYS_ALIGN;
const JUSTIFY: Readonly<Record<RollAlign, string>> = Object.freeze({ start: 'flex-start', center: 'center', end: 'flex-end' });
const mmCss = (n: number): string => `${Math.round(n * 10) / 10}mm`;

/**
 * خطة الشعار الحرّة (logoPlan من المحرّك): الحجم الأقصى بالملّيمتر ومحاذاته ومكانه — null بلا مفتاحٍ حرّ للشعار (حجم اليوم s/m/l).
 * دفاعاً: لا يتجاوز عرض الحزمة المطبوعة ولا 80 مم (B.2)، ولا ينزل عن 6 مم.
 */
function rollLogoPlan(r: Roll): LogoPlan | null {
  if (!r.free || !r.layout) return null;
  const band = geometry(r.profile).printableWidthMm;
  const plan = logoPlan(r.layout, 'classic', 'roll', band);
  if (!plan) return null;
  const cap = (v: number): number => (Number.isFinite(v) ? Math.min(Math.max(v, 6), band, 80) : Math.min(band, 16));
  return { ...plan, maxWmm: cap(plan.maxWmm), maxHmm: cap(plan.maxHmm) };
}

/**
 * أين يُطبع الشعار: داخل الرأس كاليوم ('header')، أو كتلةً مستقلة أوّل الشريط ('top') أو بعد قسمٍ من أقسام الرول (B.2).
 * قسمٌ ليس من أقسام الرول (مسودّةٌ فاسدة) ⇒ داخل الرأس، فلا يضيع الشعار.
 */
function rollLogoAt(r: Roll): 'header' | 'top' | SectionId {
  const at = rollLogoPlan(r)?.at ?? 'header';
  if (at === 'header' || at === 'top') return at;
  return DEFAULT_SECTIONS.thermal.includes(at) ? at : 'header';
}

/**
 * صورة الشعار: بلا تخطيط كما اليوم حرفاً بحرف (أسلوب `.logo img` في الوثيقة)؛ وبتخطيطٍ «بلا شعار» لا صورة، وحجمه نسبةٌ من عرض
 * اليوم (logoBox: px = max-width المئوية — 36/48/60) والارتفاع بالنسبة نفسها من 16 مم.
 * «التحرير الحرّ»: logoMm صندوقٌ أقصى بالملّيمتر (العرض والارتفاع ≤ logoMm بـmax-width/max-height فلا تمطيط — B.2)، والمحاذاة
 * يمين/وسط/يسار (الوسط بصنف اليوم `c` حرفاً بحرف). `standalone` = كتلة الشعار المستقلة (data-sec="logo").
 */
function rollLogo(logo: string, r: Roll, standalone = false): string {
  const pd = r.markers ? ' data-pd="logo"' : '';
  if (!r.layout) return `<div class="c logo"${pd}><img src="${logo}" alt=""/></div>`;
  const plan = rollLogoPlan(r);
  const box = logoBox(r.layout, 'classic', 'roll');
  if (!(plan ? plan.show : box.show)) return '';
  const align: RollAlign = plan ? plan.align : r.layout.logo === 'start' || r.layout.logo === 'end' ? r.layout.logo : 'center';
  const style = plan
    ? ` style="max-width:${mmCss(plan.maxWmm)};max-height:${mmCss(plan.maxHmm)}"`
    : box.px === 60 ? '' : ` style="max-width:${box.px}%;max-height:${Math.round((16 * box.px) / 60 * 10) / 10}mm"`;
  const cls = align === 'center' ? 'c logo' : 'logo';
  const at = align === 'center' ? '' : ` style="text-align:${PHYS_ALIGN[align]}"`;
  return `<div class="${cls}"${standalone ? ' data-sec="logo"' : ''}${pd}${at}><img src="${logo}" alt=""${style}/></div>`;
}

/** كتلة الشعار المستقلة (logoAfter) — '' والشعار داخل الرأس، أو بلا شعار */
function rollLogoBlock(company: InvoiceDoc['company'], r: Roll): string {
  const logo = company?.logo;
  if (rollLogoAt(r) === 'header' || !r.o.showLogo || !isRasterSrc(logo)) return '';
  return rollLogo(logo, r, true);
}

/**
 * قواعد «التحرير الحرّ» للرول (C.(iii)): لكل قسمٍ له تنسيق — المحاذاة (`.c` و`.row` المرنة داخله؛ والشعار يتبع مفتاحه وحده) وحجم
 * الخط بضرب قيم القالب بالبكسل (fontPx — لا zoom: html2canvas لا يعرفه). وشكل الجدول على الحراري بالأسود وحده (لا تعبئة رمادية،
 * عتبة 160): «شبكة» = خلايا بإطار (المفصّل) أو بندٌ في إطار (المختصر)، و«مخطط» = خطٌّ منقّط بين البنود.
 * '' بلا تخطيطٍ حرّ وجدولٍ بخطوط ⇒ لا <style> ثانٍ.
 */
function rollFreeCss(r: Roll): string {
  if (!r.layout) return '';
  const rules: string[] = [];
  if (r.free) {
    const scale = Number(r.o.fontScale);
    const base = (n: number): number => Math.round(n * (Number.isFinite(scale) && scale > 0 ? scale : 1) * 100) / 100;
    for (const id of DEFAULT_SECTIONS.thermal) {
      const raw = sectionLook(r.layout, id);
      if (!raw || !raw.visible) continue;
      /* جدول المفصّل لا يكبر عن خط القالب: أعمدته الخمسة تملأ الحزمة بخط 100٪ (72 مم)، فالتكبير يكسر الرقم وسط خاناته («٦٠٠» ⇒
       * «٦٠» ثم «٠») والكلمة العربية وسط حروفها — وhtml2canvas يرسم الكلمة المنكسرة حرفاً حرفاً بأشكالها المنفصلة فتتراكب على ورق
       * البلوتوث (مُثبَت في متصفحٍ حقيقيّ). والبديل (عدم الكسر) يُخرج عمود الإجمالي عن الحزمة. فالتصغير يسري والتكبير لا */
      const look = id === 'items' && r.detailed && raw.fontPct > 100 ? { ...raw, fontPct: 100 } : raw;
      const sel = `[data-sec="${id}"]`;
      if (look.align) {
        rules.push(`${sel}, ${sel} .c:not(.logo), ${sel} .copy-label { text-align: ${PHYS_ALIGN[look.align]}; }`);
        rules.push(`${sel} .row { justify-content: ${JUSTIFY[look.align]}; }`);
        // الرمز يتبع محاذاة قسمه أيضاً: الصورة (نظام الطباعة) بـtext-align، وخانة البلوتوث بهامشها — raster.ts يرسم الرمز في مستطيلها
        if (id === 'qr') {
          rules.push(`${sel} .qr { text-align: ${PHYS_ALIGN[look.align]}; }`,
            `${sel} .qrslot { margin: ${look.align === 'start' ? '0 0 0 auto' : look.align === 'end' ? '0 auto 0 0' : '0 auto'}; }`);
        }
      }
      if (look.fontPct !== 100) {
        const f = (n: number): string => `${Math.round(fontPx(base(n), look) * 100) / 100}px`;
        rules.push(`${sel} { font-size: ${f(11)}; }`, `${sel} .lg { font-size: ${f(14)}; }`, `${sel} .xl { font-size: ${f(17)}; }`,
          `${sel} .muted, ${sel} .copy-label { font-size: ${f(10)}; }`);
      }
      /* الخط المكبَّر لا يُقصّ: الحزمة بعرضها والالتقاط بحدودها (raster.ts)، فما فاض عنها يضيع من الورق — في البلوتوث ونظام الطباعة.
       * فالتسمية وقيمتها تنزلان سطراً متى ضاق الصفّ، والرقم الأعرض من سطرٍ كامل ينكسر بدل أن يخرج عن الحزمة (وجدول المفصّل لا يكبر — أعلاه). والكلمة المنكسرة
       * يرسمها html2canvas حرفاً حرفاً بمستطيلاتها (parseTextBounds) — فلا تكسرها إلا كلمةٌ أعرض من سطرٍ كامل */
      if (look.fontPct > 100) {
        rules.push(`${sel} .row { flex-wrap: wrap; }`,
          `${sel} .row > span, ${sel} .iname { overflow-wrap: anywhere; }`);
      }
    }
  }
  const ts = r.layout.tableStyle;
  if (ts === 'grid') rules.push(r.detailed ? '.t th, .t td { border: 1px solid #000; }' : '.item { border: 1px solid #000; padding: 1px 3px; }');
  if (ts === 'striped') rules.push(r.detailed ? '.t tbody tr + tr td { border-top: 1px dotted #000; }' : '.item + .item { border-top: 1px dotted #000; padding-top: 3px; }');
  return rules.join('\n    ');
}

/**
 * رأس الشركة: اسمها دائماً، والشعار والعنوان والهاتف بخيارات القالب. «حذف السطر»: الرقم الضريبي (h.taxNumber) والعنوان
 * (h.address — سطره بلا تسمية ومعه سطر اللغة الثانية) والهاتف تُحذف بوحدتها كاملة.
 */
function rollHead(company: InvoiceDoc['company'], r: Roll): string {
  const logo = company?.logo;
  return `
    ${r.o.showLogo && isRasterSrc(logo) && rollLogoAt(r) === 'header' ? rollLogo(logo, r) : ''}
    <div class="c b lg">${esc(company?.name || r.tr('اسم الشركة'))}</div>${r.pt.companyNameAlt ? `<div class="c b" dir="ltr">${esc(r.pt.companyNameAlt)}</div>` : ''}
    ${company?.taxNumber && !gone(r, 'h.taxNumber') ? `<div class="c muted">${lbl(r, 'h.taxNumber', 'الرقم الضريبي')} ${esc(company.taxNumber)}</div>` : ''}
    ${r.o.showContact && company?.address && !gone(r, 'h.address') ? `<div class="c muted">${esc(company.address)}</div>${r.pt.companyAddressAlt ? `<div class="c muted" dir="ltr">${esc(r.pt.companyAddressAlt)}</div>` : ''}` : ''}
    ${r.o.showContact && company?.phone && !r.pt.hidden('h.phone') ? `<div class="c muted">${lbl(r, 'h.phone', 'هاتف')} ${esc(company.phone)}</div>` : ''}`;
}

/**
 * اسم الشركة والشكر — كلٌّ يُخفى وحده («نصوص المطبوعات»). الإخفاء يسبق كل شيء، ثم صياغة الشركة للشكر (ما تراه في معاينة المحرّر
 * يُطبع)، ثم نصّ تذييل القالب، ثم الافتراضي — كقالب A4.
 */
/** نصّ الشركة الثاني لاسمها في التذييل (foot.company) سطراً تحته كاسمها باللغة الثانية في الرأس — لا شيء بلا نصّها (C-G4) */
function footCompanyAlt(r: Roll): string {
  const alt = r.pt.ownAlt('foot.company');
  return alt ? `<div class="c muted" dir="ltr">${esc(alt)}</div>` : '';
}

function rollFoot(company: InvoiceDoc['company'], r: Roll): string {
  return `
    ${r.pt.hidden('foot.company') ? '' : `<div class="c muted">${esc(r.pt.on && r.pt.text('foot.company', '') !== '' ? r.pt.text('foot.company', '') : company?.name || '')}</div>${footCompanyAlt(r)}`}
    ${r.pt.hidden('foot.thanks') ? '' : `<div class="c muted">${r.o.footerText !== null && !(r.pt.on && r.pt.text('foot.thanks', '') !== '') ? esc(r.o.footerText) : r.pt.on ? lbl(r, 'foot.thanks', 'شكرا لتعاملكم معنا') : esc(r.tr('شكرا لتعاملكم معنا'))}</div>`}`;
}

const buyerAddress = (c: { address?: string; district?: string; city?: string }): string =>
  [c.address, c.district, c.city].filter(Boolean).join('، ');

interface InvoiceFacts {
  doc: InvoiceDoc;
  d: ZatcaPrintDecision;
  title: string;
  qr: string;
  vatPcts: number[];
  inclusiveDoc: boolean;
}

/**
 * أقسام الرول بترتيبها (pl_spec B2): بلا تخطيط ⇒ الترتيب الافتراضي (orderedSections(null)) والأقسام نفسها مقطوعةً من قالب اليوم
 * بمسافاتها، فوصلها = وثيقة اليوم حرفاً بحرف (حارس rollThermal.baseline). وبتخطيطٍ ترتيب الشركة؛ و«بيانات المستند» إن لم يلِها
 * «العميل» تأخذ فاصلها كي لا تلتصق بما بعدها. الرمز قسمٌ قائم يُطبع في أيّ ترتيب، ولا يتعلّق بأيّ عبارة.
 */
function rollSections(r: Roll, parts: Partial<Record<SectionId, string>>, logoBlock = '', keep = ''): string {
  const order = orderedSections(r.layout, 'thermal');
  // «التحرير الحرّ»: القسم المخفيّ (visible:false) يسقط كاملاً — والأصناف والرمز لا يُخفيان أبداً (LOCKED_VISIBLE)
  if (r.free) {
    const shown = new Set<SectionId>(visibleOrder(r.layout, 'thermal'));
    shown.add('items'); shown.add('qr');
    parts = Object.fromEntries(Object.entries(parts).filter(([id]) => shown.has(id as SectionId))) as Partial<Record<SectionId, string>>;
  }
  if (r.layout && parts.info) {
    const present = order.filter((id) => parts[id]);
    const next = present[present.indexOf('info') + 1];
    if (next && next !== 'customer') parts = { ...parts, info: `${parts.info}\n    <div class="sep"></div>` };
  }
  // الرمز قبل الإجماليات أو التواقيع (ترتيبٌ يقبله الخادم) يأخذ فاصله كي لا يلتصق ICV/UUID بما بعده؛ وقبل التذييل كاليوم بلا فاصل
  if (r.layout && parts.qr && parts.qr.trim() !== '') {
    const present = order.filter((id) => (parts[id] ?? '').trim() !== '');
    const next = present[present.indexOf('qr') + 1];
    if (next && next !== 'footer') parts = { ...parts, qr: `${parts.qr}\n    <div class="sep"></div>` };
  }
  if (!r.free && !r.markers) return rollSectionsHtml(order, parts);
  return rollWrapped(r, order, parts, logoBlock, keep);
}

/**
 * مسار «التحرير الحرّ» ووسوم المصمّم: كل قسمٍ في غلافٍ `<div data-sec="id">` بأسلوبه المضمَّن (المسافة قبله وبعده ومحاذاته —
 * sectionCssText) ومعه `data-pd` للمصمّم وحده؛ وكتلة الشعار المستقلة أوّل الشريط أو بعد قسمها (ولو أُخفي القسم: في موضعه).
 * والرأس المخفيّ لا يُسقط سطر «الأصل/نسخة» ولا ما يفرضه قرار الطباعة (keep: العلامة المائية للبروفة وتنبيه سند التسليم —
 * zatcaPrintDecision لا الشركة): موضعهما أوّل الشريط.
 */
function rollWrapped(r: Roll, order: readonly SectionId[], parts: Partial<Record<SectionId, string>>, logoBlock: string, keep = ''): string {
  const at = rollLogoAt(r);
  let out = r.free && parts.header === undefined ? COPY_SLOT + keep : '';
  if (at === 'top') out += logoBlock;
  for (const id of order) {
    const html = parts[id];
    // قسمٌ بلا محتوى في هذا المستند (تواقيع لم تُجمع، رمزٌ لا يلزم): لا مسافة له فلا بياض على الورق — والمصمّم يبقي مقبضه بلا أسلوب
    const blank = typeof html === 'string' && html.trim() === '';
    if (typeof html === 'string' && html !== '' && !(blank && !r.markers)) {
      const look = r.free && !blank ? sectionLook(r.layout, id) : null;
      const style = look ? sectionCssText(look) : '';
      out += `<div data-sec="${id}"${r.markers ? ` data-pd="${id}"` : ''}${style ? ` style="${esc(style)}"` : ''}>${html}</div>`;
    }
    if (at === id) out += logoBlock;
  }
  return out;
}

function rollInvoiceBody(f: InvoiceFacts, r: Roll): string {
  const { doc, d, title, qr, vatPcts, inclusiveDoc } = f;
  const { o, tr } = r;
  type Item = InvoiceDoc['items'][number];
  const rate = vatPcts.length === 1 ? `${vatPcts[0]}%` : tr('نسب متعددة');
  // «نصوص المطبوعات»: العنوان من القرار، وصياغة الشركة له وحذفها عبر المحلِّل (المحذوف ⇒ نصٌّ فارغ فلا سطر)
  const tt = r.pt.title(title, { isReturn: !!doc.isReturn, phase2: !!doc.zatca });
  const titleHtml = `${esc(tt.text)}${tt.alt ? altSpan(r, esc(tt.alt), true) : ''}`;
  // الوحدة بخيار القالب، وإجباراً لبندٍ بغير الأساس أو لصنفٍ له وحدات (showsItemUnit — قاعدة A4 نفسها، ويرثها البلوتوث)
  const unit = (it: Item) => (showsItemUnit(it, o.showItemUnit) ? ` <span class="muted">(${esc(it.unit!)})</span>` : '');
  /* الفاتورة القياسية توجب سعر الوحدة غير شامل الضريبة — والتصنيف من القرار (مصدره الخادم في المرحلة الثانية) لا من رقم
   * المشتري الضريبي، كقالب A4 حرفاً بحرف؛ وسند التسليم (بلا تفصيل ضريبة) لا يذكر ضريبةً أصلاً */
  const beforeVat = (it: Item) => (d.showTaxBreakdown && inclusiveDoc && d.standardLayout && it.taxPct > 0 && !gone(r, 'item.beforeTax')
    ? `<div class="muted">${lbl(r, 'item.beforeTax', 'قبل الضريبة')}: ${money((it.unitPrice * 100) / (100 + Number(it.taxPct)))}</div>`
    : '');
  // عمود النسبة حين تختلط النسب وحدها: نسبةٌ واحدة تكفيها خانة الملخّص، والمختلطة لا تُطبع مدمجةً أبداً
  const rateCol = r.detailed && d.showTaxBreakdown && vatPcts.length > 1 && !r.pt.hidden('col.tax');
  const discountShown = !r.pt.hidden('col.discount');
  /* «حذف السطر» في جدول الأصناف: العمود كلّه (رأسه وكل خلاياه) في المفصّل، وجزؤه من سطر البند في المختصر (بلا تسميات).
   * السعر عمودٌ واحد بتسميتين — يُحذف بحذف التسمية الظاهرة على هذا المستند */
  const priceKey = d.showTaxBreakdown && inclusiveDoc ? 'col.priceIncl' : 'col.price';
  const showItem = !gone(r, 'col.item');
  const showQty = !gone(r, 'col.qty');
  const showPrice = !gone(r, priceKey);
  const showTotal = !gone(r, 'col.total');
  const compactRow = (it: Item): string => {
    const left = [showQty ? localizeDigits(String(it.qty)) : '', showPrice ? money(it.unitPrice) : ''].filter(Boolean).join(' × ')
      + (it.discountPct > 0 && discountShown ? ` -${localizeDigits(String(it.discountPct))}%` : '');
    return left || showTotal ? `<div class="row"><span>${left}</span>${showTotal ? `<span class="b">${money(it.lineTotal)}</span>` : ''}</div>` : '';
  };
  const items = r.detailed
    ? `<table class="t"><thead><tr>
        ${showItem ? `<th class="l">${lbl(r, 'col.item', 'الصنف', { stack: true })}</th>` : ''}${showQty ? `<th>${lbl(r, 'col.qty', 'الكمية', { stack: true })}</th>` : ''}
        ${showPrice ? `<th>${d.showTaxBreakdown && inclusiveDoc ? lbl(r, 'col.priceIncl', 'السعر شامل الضريبة', { stack: true }) : lbl(r, 'col.price', 'السعر', { stack: true })}</th>` : ''}
        ${rateCol ? `<th>${lbl(r, 'col.tax', 'الضريبة', { stack: true })}</th>` : ''}
        ${showTotal ? `<th class="e">${lbl(r, 'col.total', 'الإجمالي', { stack: true })}</th>` : ''}
      </tr></thead><tbody>${doc.items.map(it => `
        <tr>
          ${showItem ? `<td class="l">${esc(it.name)}${unit(it)}${it.discountPct > 0 && discountShown ? `<div class="muted">${lbl(r, 'col.discount', 'الخصم')} ${localizeDigits(String(it.discountPct))}%</div>` : ''}${lotRows(doc, it, tr)}</td>` : ''}
          ${showQty ? `<td class="n">${localizeDigits(String(it.qty))}</td>` : ''}
          ${showPrice ? `<td class="n">${money(it.unitPrice)}${beforeVat(it)}</td>` : ''}
          ${rateCol ? `<td class="n">${localizeDigits(String(it.taxPct))}%</td>` : ''}
          ${showTotal ? `<td class="n e b">${money(it.lineTotal)}</td>` : ''}
        </tr>`).join('')}</tbody></table>`
    : doc.items.map(it => `
      <div class="item">
        ${showItem ? `<div class="iname">${esc(it.name)}${unit(it)}</div>` : ''}
        ${compactRow(it)}
        ${beforeVat(it)}${lotRows(doc, it, tr)}
      </div>`).join('');
  const addr = buyerAddress(doc.customer);
  const sigs = o.showSignatures
    ? ([[doc.recipientSignature, 'sig.recipient', 'توقيع المستلم'], [doc.repSignature, 'sig.rep', 'توقيع المندوب']] as const).map(([src, key, ar]) => isSignatureSrc(src) && !r.pt.hidden(key)
      ? `<div class="c"><img src="${esc(src)}" alt="" style="max-width:70%;max-height:60px"><div class="muted">${lbl(r, key, ar)}</div></div><div class="sep"></div>`
      : '').join('')
    : '';
  const numberKey = doc.isReturn ? 'inv.returnNumber' : 'inv.number';
  const vatKey = inclusiveDoc ? 'tot.vatIncl' : 'tot.vat';
  // صفّ الإجمالي النهائي بتسمياته الثلاث صفٌّ واحد: يُحذف بحذف tot.returnGrand للمرتجع، وإلا بحذف tot.grand
  const grandKey = doc.isReturn ? 'tot.returnGrand' : 'tot.grand';
  // العلامة المائية للبروفة وتنبيه سند التسليم من قرار الطباعة: في الرأس كاليوم، وأوّل الشريط إن أُخفي الرأس (keep)
  const keep = `${d.watermark ? `<div class="c b muted">${esc(tr(d.watermark))}</div>` : ''}${d.notice ? `<div class="sep"></div><div class="c muted">${esc(tr(d.notice))}</div>` : ''}`;

  return rollSections(r, {
    header: `
    ${rollHead(doc.company, r)}
    <div class="sep"></div>
    ${titleHtml ? `<div class="c b">${titleHtml}</div>` : ''}
    ${COPY_SLOT}
    ${d.watermark ? `<div class="c b muted">${esc(tr(d.watermark))}</div>` : ''}
    ${d.notice ? `<div class="sep"></div><div class="c muted">${esc(tr(d.notice))}</div>` : ''}
    <div class="sep"></div>`,
    info: `
    ${gone(r, numberKey) ? '' : `<div class="row"><span>${lbl(r, numberKey, 'رقم')}</span><span class="b">${esc(doc.number)}</span></div>`}
    ${gone(r, 'inv.date') ? '' : `<div class="row"><span>${lbl(r, 'inv.date', 'التاريخ')}</span><span>${dt(doc.date)}</span></div>`}${noteRows(doc, (key, ar) => lbl(r, key, ar), (key) => gone(r, key))}
    ${doc.deliveryDate && !gone(r, 'inv.deliveryDate') ? `<div class="row"><span>${lbl(r, 'inv.deliveryDate', 'تاريخ التسليم')}</span><span>${dt(doc.deliveryDate).split(' ')[0]}</span></div>` : ''}
    ${o.showRepName && !r.pt.hidden('inv.rep') ? `<div class="row"><span>${lbl(r, 'inv.rep', 'المندوب')}</span><span>${esc(doc.repName)}</span></div>` : ''}`,
    customer: `
    ${r.pt.hidden('cust.name') ? '' : `<div class="row"><span>${lbl(r, 'cust.name', 'العميل')}</span><span>${esc(doc.customer.name)}</span></div>`}
    ${r.detailed && doc.customer.businessName && !r.pt.hidden('cust.business') ? `<div class="row"><span>${lbl(r, 'cust.business', 'المنشأة')}</span><span>${esc(doc.customer.businessName)}</span></div>` : ''}
    ${doc.customer.taxNumber && !gone(r, 'cust.taxNumber') ? `<div class="row"><span>${lbl(r, 'cust.taxNumber', 'الرقم الضريبي')}</span><span>${esc(doc.customer.taxNumber)}</span></div>` : ''}
    ${r.detailed && addr && !r.pt.hidden('cust.address') ? `<div class="row"><span>${lbl(r, 'cust.address', 'العنوان')}</span><span>${esc(addr)}</span></div>` : ''}
    <div class="sep"></div>`,
    items: `
    ${items}
    <div class="sep"></div>`,
    totals: `
    ${gone(r, 'tot.taxable') ? '' : `${d.showTaxBreakdown ? `<div class="row"><span>${lbl(r, 'tot.taxable', 'المجموع قبل الضريبة')}</span><span>${money(doc.total - doc.tax)}</span></div>` : ''}`}
    ${doc.discount > 0 && !r.pt.hidden('tot.discount') ? `<div class="row"><span>${lbl(r, 'tot.discount', 'الخصم')}</span><span>${money(doc.discount)}</span></div>` : ''}
    ${gone(r, vatKey) ? '' : `${d.showTaxBreakdown ? `<div class="row"><span>${inclusiveDoc
      ? lbl(r, 'tot.vatIncl', 'منها ضريبة القيمة المضافة', { suffix: rate })
      : lbl(r, 'tot.vat', 'ضريبة القيمة المضافة', { suffix: rate })}</span><span>${money(doc.tax)}</span></div>` : ''}`}
    ${gone(r, grandKey) ? '' : `<div class="row b lg"><span>${doc.isReturn ? lbl(r, 'tot.returnGrand', 'إجمالي المرتجع دائن')
      : !d.showTaxBreakdown && !inclusiveDoc && doc.tax > 0 ? val(r, 'المبلغ المستحق شامل الضرائب')
      : lbl(r, 'tot.grand', 'الإجمالي')}</span><span>${money(doc.total)}</span></div>`}
    ${!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined ? `
      ${r.pt.hidden('tot.paid') ? '' : `<div class="row muted"><span>${lbl(r, 'tot.paid', 'المدفوع')}</span><span>${money(doc.paidAmt ?? 0)}</span></div>`}
      ${r.pt.hidden('tot.remaining') ? '' : `<div class="row muted"><span>${lbl(r, 'tot.remaining', 'المتبقي')}</span><span>${money(doc.remainingAmt)}</span></div>`}` : ''}
    <div class="sep"></div>`,
    signatures: `
    ${sigs}`,
    qr: `
    ${qr}
    ${doc.zatca && doc.zatca.icv !== null ? `<div class="c muted">ICV ${localizeDigits(String(doc.zatca.icv))}</div>` : ''}
    ${doc.zatca?.uuid ? `<div class="c muted" style="word-break:break-all;direction:ltr">${esc(doc.zatca.uuid)}</div>` : ''}`,
    footer: `
    ${rollFoot(doc.company, r)}`,
  }, rollLogoBlock(doc.company, r), keep);
}

/** السند: الأقسام نفسها بلا أصناف ولا تواقيع ولا رمز — والمبلغ وفواتيره قسم «الإجماليات» */
function rollReceiptBody(doc: ReceiptDoc, r: Roll): string {
  const { o, tr } = r;
  const addr = buyerAddress(doc.customer);
  // وسم «سند ملغى»: في الرأس كاليوم، وأوّل الشريط إن أُخفي الرأس (keep) — فلا يُطبع سندٌ ملغى بلا وسمه
  const cancelled = doc.cancelled ? `<div class="c b">— ${tr('سند ملغى')} —</div>` : '';
  return rollSections(r, {
    header: `
    ${rollHead(doc.company, r)}
    <div class="sep"></div>
    ${r.pt.hidden('rcp.title') ? '' : `<div class="c b">${lbl(r, 'rcp.title', 'سند قبض', { stack: true })}</div>`}
    ${COPY_SLOT}
    ${cancelled}
    <div class="sep"></div>`,
    info: `
    ${gone(r, 'rcp.number') ? '' : `<div class="row"><span>${lbl(r, 'rcp.number', 'رقم')}</span><span class="b">${esc(doc.number)}</span></div>`}
    ${gone(r, 'rcp.date') ? '' : `<div class="row"><span>${lbl(r, 'rcp.date', 'التاريخ')}</span><span>${dt(doc.date)}</span></div>`}
    ${o.showRepName && !r.pt.hidden('rcp.rep') ? `<div class="row"><span>${lbl(r, 'rcp.rep', 'المندوب')}</span><span>${esc(doc.repName)}</span></div>` : ''}
    <div class="sep"></div>`,
    customer: `
    ${gone(r, 'rcp.from') ? '' : `<div class="row"><span>${lbl(r, 'rcp.from', 'استلمنا من')}</span><span>${esc(doc.customer.name)}</span></div>`}
    ${doc.customer.taxNumber && !r.pt.hidden('rcp.taxNumber') ? `<div class="row"><span>${lbl(r, 'rcp.taxNumber', 'الرقم الضريبي')}</span><span>${esc(doc.customer.taxNumber)}</span></div>` : ''}
    ${r.detailed && addr && !r.pt.hidden('rcp.address') ? `<div class="row"><span>${lbl(r, 'rcp.address', 'العنوان')}</span><span>${esc(addr)}</span></div>` : ''}
    ${r.pt.hidden('rcp.method') ? '' : `<div class="row"><span>${lbl(r, 'rcp.method', 'طريقة الدفع')}</span><span>${esc(methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey, tr))}</span></div>`}
    ${doc.notes && !r.pt.hidden('rcp.notes') ? `<div class="row"><span>${lbl(r, 'rcp.notes', 'ملاحظات')}</span><span>${esc(doc.notes)}</span></div>` : ''}
    <div class="sep"></div>`,
    totals: `
    ${gone(r, 'rcp.amount') ? '' : `<div class="c muted">${lbl(r, 'rcp.amount', 'المبلغ المستلم')}</div>
    <div class="c b xl">${money(doc.amount)} ${curSym()}</div>`}
    ${receiptInvoiceRows(doc, tr, (key, ar) => lbl(r, key, ar), (key) => r.pt.hidden(key))}
    <div class="sep"></div>`,
    footer: `
    ${rollFoot(doc.company, r)}`,
  }, rollLogoBlock(doc.company, r), cancelled);
}

/**
 * معاينة محرّر «نصوص المطبوعات» (components/print/PrintTextsEditor.tsx): وثيقة الشريط كما تُطبع لهذه الشركة — 58 مم بالملف الافتراضي
 * (الكلاسيكي، أو المختصر متى حفظت نصوصاً) و80 مم بالمختصر — لتُعرض في <iframe srcDoc>. لا طباعة ولا بلوتوث.
 * `profile` (اختياري — معاينة «التخطيط» الحيّة في إعدادات الطباعة): قالبٌ حراريّ بعينه بتخطيطه بدل الافتراضي؛ وغيابه كما كان.
 */
export async function thermalPreviewHtml(doc: InvoiceDoc | ReceiptDoc, opts: { tr: Tr; paperMm: 58 | 80; profile?: PrintProfile | null; markers?: boolean }): Promise<string> {
  const profile: PrintProfile = opts.profile && opts.profile.printer === 'thermal' ? opts.profile
    : opts.paperMm === 58
    ? legacyThermalProfile()
    : { ...legacyThermalProfile(), id: 'preview-80', template: 'roll_compact', paper: presetPaper('roll80') as Paper };
  let html = '';
  const capture = (h: string): void => { html = h; };
  // markers (مصمّم الشريط، pd_spec B.5): وسوم data-pd للمقابض — تُمرَّر متى طُلبت وحدها فمعاينة اليوم كما هي
  const markers = opts.markers ? { markers: true } : {};
  if (doc.kind === 'invoice') await printThermalInvoice(doc, { profile, tr: opts.tr, capture, ...markers });
  else await printThermalReceipt(doc, { profile, tr: opts.tr, capture, ...markers });
  return html;
}
