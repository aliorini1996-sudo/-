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
import { isSaudiDoc, isSignatureSrc, showsItemUnit } from './RepDocuments';
import { zatcaPrintDecision, type ZatcaPrintDecision } from '../lib/zatca/docPrint';
import { receiptLinkView } from './receiptLinks';
import { PRINT_WARNINGS, dotsPerMm, geometry, legacyThermalProfile, presetPaper, qrPlan, type Paper, type PrintOptions, type PrintProfile, type PrinterDpi } from '../lib/print/printSettings';
import { makePrintTexts, normalizePrintTexts, type PrintTexts } from '../lib/print/printTexts';
import { PrintRefusedError } from '../lib/print/printErrors';
import { COPY_SLOT, LEGACY_THERMAL_GEOM, buildThermalDocument, rollHeightMm, thermalGeom, thermalPageRule, type ThermalGeom } from './thermalHtml';
import { invoiceLotsOf, lotLineText } from './docLots';

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
}

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
  return {
    profile: p, o: p.options, tr: pt.tr, detailed: p.template === 'roll_detailed',
    raster: opts?.raster ?? null, banner: opts?.sampleBanner ?? null, capture: opts?.capture ?? null,
    pt, wide: geometry(p).printableWidthMm >= 70,
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
 */
function printHTML(body: string, geom: ThermalGeom = LEGACY_THERMAL_GEOM): void | Promise<void> {
  const html = buildThermalDocument(body, geom);

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

  classicOut(opts, `
    ${head(doc.company)}
    <div class="sep"></div>
    <div class="c b">${esc(title)}</div>
    ${d.watermark ? `<div class="c b muted">${esc(d.watermark)}</div>` : ''}
    ${d.notice ? `<div class="sep"></div><div class="c muted">${esc(d.notice)}</div>` : ''}
    <div class="sep"></div>
    <div class="row"><span>رقم</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>التاريخ</span><span>${dt(doc.date)}</span></div>
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
function classicOut(opts: ThermalPrintOptions | undefined, body: string): void {
  if (opts?.capture) { opts.capture(buildThermalDocument(body)); return; }
  printHTML(body);
}

/**
 * «مقابل الفاتورة رقم …» بنفس قرار قالب A4 (`receiptLinkView`) — سطورٌ لا جدول. والمترجم للقالبين الجديدين؛ الكلاسيكي عربيّ.
 * `L` تسميات «نصوص المطبوعات» للقالبين الجديدين (lbl) و`hidden` إخفاؤها — غيابهما ⇒ tr كما كان ولا إخفاء (الكلاسيكي حرفاً بحرف).
 * التسمية المخفية تسقط ويبقى رقم الفاتورة ومبلغها: ربط السند بفاتورته لا يُخفى.
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
  const heading = single
    ? (hidden('rcp.forInvoice')
      ? `<div class="c b">${esc(view.links[0].number)}</div>`
      : `<div class="row"><span>${t('rcp.forInvoice', 'مقابل الفاتورة رقم')}</span><span class="b">${esc(view.links[0].number)}</span></div>`)
    : (hidden('rcp.forInvoices') ? '' : `<div class="c muted">${t('rcp.forInvoices', 'مقابل الفواتير')}</div>`);
  const rows = heading + (showAmounts
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
  classicOut(opts, `
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
  if (r.capture) { r.capture(buildThermalDocument(b, geom)); return; }
  return r.raster ? r.raster(buildThermalDocument(b, geom), geom) : printHTML(b, geom);
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

/** رأس الشركة: اسمها ورقمها الضريبي دائماً (إلزاميان)، والشعار والعنوان والهاتف بخيارات القالب */
function rollHead(company: InvoiceDoc['company'], r: Roll): string {
  const logo = company?.logo;
  return `
    ${r.o.showLogo && isRasterSrc(logo) ? `<div class="c logo"><img src="${logo}" alt=""/></div>` : ''}
    <div class="c b lg">${esc(company?.name || r.tr('اسم الشركة'))}</div>${r.pt.companyNameAlt ? `<div class="c b" dir="ltr">${esc(r.pt.companyNameAlt)}</div>` : ''}
    ${company?.taxNumber ? `<div class="c muted">${lbl(r, 'h.taxNumber', 'الرقم الضريبي')} ${esc(company.taxNumber)}</div>` : ''}
    ${r.o.showContact && company?.address ? `<div class="c muted">${esc(company.address)}</div>${r.pt.companyAddressAlt ? `<div class="c muted" dir="ltr">${esc(r.pt.companyAddressAlt)}</div>` : ''}` : ''}
    ${r.o.showContact && company?.phone && !r.pt.hidden('h.phone') ? `<div class="c muted">${lbl(r, 'h.phone', 'هاتف')} ${esc(company.phone)}</div>` : ''}`;
}

/**
 * اسم الشركة والشكر — كلٌّ يُخفى وحده («نصوص المطبوعات»). الإخفاء يسبق كل شيء، ثم صياغة الشركة للشكر (ما تراه في معاينة المحرّر
 * يُطبع)، ثم نصّ تذييل القالب، ثم الافتراضي — كقالب A4.
 */
function rollFoot(company: InvoiceDoc['company'], r: Roll): string {
  return `
    ${r.pt.hidden('foot.company') ? '' : `<div class="c muted">${esc(company?.name || '')}</div>`}
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

function rollInvoiceBody(f: InvoiceFacts, r: Roll): string {
  const { doc, d, title, qr, vatPcts, inclusiveDoc } = f;
  const { o, tr } = r;
  type Item = InvoiceDoc['items'][number];
  const rate = vatPcts.length === 1 ? `${vatPcts[0]}%` : tr('نسب متعددة');
  // «نصوص المطبوعات»: العنوان من القرار، وصياغة الشركة له لمستندات المرحلة الأولى وحدها (المختوم كما هو)
  const tt = r.pt.title(title, { isReturn: !!doc.isReturn, phase2: !!doc.zatca });
  const titleHtml = `${esc(tt.text)}${tt.alt ? altSpan(r, esc(tt.alt), true) : ''}`;
  // الوحدة بخيار القالب، وإجباراً لبندٍ بغير الأساس أو لصنفٍ له وحدات (showsItemUnit — قاعدة A4 نفسها، ويرثها البلوتوث)
  const unit = (it: Item) => (showsItemUnit(it, o.showItemUnit) ? ` <span class="muted">(${esc(it.unit!)})</span>` : '');
  /* الفاتورة القياسية توجب سعر الوحدة غير شامل الضريبة — والتصنيف من القرار (مصدره الخادم في المرحلة الثانية) لا من رقم
   * المشتري الضريبي، كقالب A4 حرفاً بحرف؛ وسند التسليم (بلا تفصيل ضريبة) لا يذكر ضريبةً أصلاً */
  const beforeVat = (it: Item) => (d.showTaxBreakdown && inclusiveDoc && d.standardLayout && it.taxPct > 0
    ? `<div class="muted">${lbl(r, 'item.beforeTax', 'قبل الضريبة')}: ${money((it.unitPrice * 100) / (100 + Number(it.taxPct)))}</div>`
    : '');
  // عمود النسبة حين تختلط النسب وحدها: نسبةٌ واحدة تكفيها خانة الملخّص، والمختلطة لا تُطبع مدمجةً أبداً
  const rateCol = r.detailed && d.showTaxBreakdown && vatPcts.length > 1 && !r.pt.hidden('col.tax');
  const discountShown = !r.pt.hidden('col.discount');
  const items = r.detailed
    ? `<table class="t"><thead><tr>
        <th class="l">${lbl(r, 'col.item', 'الصنف', { stack: true })}</th><th>${lbl(r, 'col.qty', 'الكمية', { stack: true })}</th>
        <th>${d.showTaxBreakdown && inclusiveDoc ? lbl(r, 'col.priceIncl', 'السعر شامل الضريبة', { stack: true }) : lbl(r, 'col.price', 'السعر', { stack: true })}</th>
        ${rateCol ? `<th>${lbl(r, 'col.tax', 'الضريبة', { stack: true })}</th>` : ''}
        <th class="e">${lbl(r, 'col.total', 'الإجمالي', { stack: true })}</th>
      </tr></thead><tbody>${doc.items.map(it => `
        <tr>
          <td class="l">${esc(it.name)}${unit(it)}${it.discountPct > 0 && discountShown ? `<div class="muted">${lbl(r, 'col.discount', 'الخصم')} ${localizeDigits(String(it.discountPct))}%</div>` : ''}${lotRows(doc, it, tr)}</td>
          <td class="n">${localizeDigits(String(it.qty))}</td>
          <td class="n">${money(it.unitPrice)}${beforeVat(it)}</td>
          ${rateCol ? `<td class="n">${localizeDigits(String(it.taxPct))}%</td>` : ''}
          <td class="n e b">${money(it.lineTotal)}</td>
        </tr>`).join('')}</tbody></table>`
    : doc.items.map(it => `
      <div class="item">
        <div class="iname">${esc(it.name)}${unit(it)}</div>
        <div class="row"><span>${localizeDigits(String(it.qty))} × ${money(it.unitPrice)}${it.discountPct > 0 && discountShown ? ` -${localizeDigits(String(it.discountPct))}%` : ''}</span><span class="b">${money(it.lineTotal)}</span></div>
        ${beforeVat(it)}${lotRows(doc, it, tr)}
      </div>`).join('');
  const addr = buyerAddress(doc.customer);
  const sigs = o.showSignatures
    ? ([[doc.recipientSignature, 'sig.recipient', 'توقيع المستلم'], [doc.repSignature, 'sig.rep', 'توقيع المندوب']] as const).map(([src, key, ar]) => isSignatureSrc(src) && !r.pt.hidden(key)
      ? `<div class="c"><img src="${esc(src)}" alt="" style="max-width:70%;max-height:60px"><div class="muted">${lbl(r, key, ar)}</div></div><div class="sep"></div>`
      : '').join('')
    : '';

  return `
    ${rollHead(doc.company, r)}
    <div class="sep"></div>
    ${titleHtml ? `<div class="c b">${titleHtml}</div>` : ''}
    ${COPY_SLOT}
    ${d.watermark ? `<div class="c b muted">${esc(tr(d.watermark))}</div>` : ''}
    ${d.notice ? `<div class="sep"></div><div class="c muted">${esc(tr(d.notice))}</div>` : ''}
    <div class="sep"></div>
    <div class="row"><span>${lbl(r, doc.isReturn ? 'inv.returnNumber' : 'inv.number', 'رقم')}</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>${lbl(r, 'inv.date', 'التاريخ')}</span><span>${dt(doc.date)}</span></div>
    ${doc.deliveryDate ? `<div class="row"><span>${lbl(r, 'inv.deliveryDate', 'تاريخ التسليم')}</span><span>${dt(doc.deliveryDate).split(' ')[0]}</span></div>` : ''}
    ${o.showRepName && !r.pt.hidden('inv.rep') ? `<div class="row"><span>${lbl(r, 'inv.rep', 'المندوب')}</span><span>${esc(doc.repName)}</span></div>` : ''}
    ${r.pt.hidden('cust.name') ? '' : `<div class="row"><span>${lbl(r, 'cust.name', 'العميل')}</span><span>${esc(doc.customer.name)}</span></div>`}
    ${r.detailed && doc.customer.businessName && !r.pt.hidden('cust.business') ? `<div class="row"><span>${lbl(r, 'cust.business', 'المنشأة')}</span><span>${esc(doc.customer.businessName)}</span></div>` : ''}
    ${doc.customer.taxNumber ? `<div class="row"><span>${lbl(r, 'cust.taxNumber', 'الرقم الضريبي')}</span><span>${esc(doc.customer.taxNumber)}</span></div>` : ''}
    ${r.detailed && addr && !r.pt.hidden('cust.address') ? `<div class="row"><span>${lbl(r, 'cust.address', 'العنوان')}</span><span>${esc(addr)}</span></div>` : ''}
    <div class="sep"></div>
    ${items}
    <div class="sep"></div>
    ${d.showTaxBreakdown ? `<div class="row"><span>${lbl(r, 'tot.taxable', 'المجموع قبل الضريبة')}</span><span>${money(doc.total - doc.tax)}</span></div>` : ''}
    ${doc.discount > 0 && !r.pt.hidden('tot.discount') ? `<div class="row"><span>${lbl(r, 'tot.discount', 'الخصم')}</span><span>${money(doc.discount)}</span></div>` : ''}
    ${d.showTaxBreakdown ? `<div class="row"><span>${inclusiveDoc
      ? lbl(r, 'tot.vatIncl', 'منها ضريبة القيمة المضافة', { suffix: rate })
      : lbl(r, 'tot.vat', 'ضريبة القيمة المضافة', { suffix: rate })}</span><span>${money(doc.tax)}</span></div>` : ''}
    <div class="row b lg"><span>${doc.isReturn ? lbl(r, 'tot.returnGrand', 'إجمالي المرتجع دائن')
      : !d.showTaxBreakdown && !inclusiveDoc && doc.tax > 0 ? val(r, 'المبلغ المستحق شامل الضرائب')
      : lbl(r, 'tot.grand', 'الإجمالي')}</span><span>${money(doc.total)}</span></div>
    ${!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined ? `
      ${r.pt.hidden('tot.paid') ? '' : `<div class="row muted"><span>${lbl(r, 'tot.paid', 'المدفوع')}</span><span>${money(doc.paidAmt ?? 0)}</span></div>`}
      ${r.pt.hidden('tot.remaining') ? '' : `<div class="row muted"><span>${lbl(r, 'tot.remaining', 'المتبقي')}</span><span>${money(doc.remainingAmt)}</span></div>`}` : ''}
    <div class="sep"></div>
    ${sigs}
    ${qr}
    ${doc.zatca && doc.zatca.icv !== null ? `<div class="c muted">ICV ${localizeDigits(String(doc.zatca.icv))}</div>` : ''}
    ${doc.zatca?.uuid ? `<div class="c muted" style="word-break:break-all;direction:ltr">${esc(doc.zatca.uuid)}</div>` : ''}
    ${rollFoot(doc.company, r)}`;
}

function rollReceiptBody(doc: ReceiptDoc, r: Roll): string {
  const { o, tr } = r;
  const addr = buyerAddress(doc.customer);
  return `
    ${rollHead(doc.company, r)}
    <div class="sep"></div>
    ${r.pt.hidden('rcp.title') ? '' : `<div class="c b">${lbl(r, 'rcp.title', 'سند قبض', { stack: true })}</div>`}
    ${COPY_SLOT}
    ${doc.cancelled ? `<div class="c b">— ${tr('سند ملغى')} —</div>` : ''}
    <div class="sep"></div>
    <div class="row"><span>${lbl(r, 'rcp.number', 'رقم')}</span><span class="b">${esc(doc.number)}</span></div>
    <div class="row"><span>${lbl(r, 'rcp.date', 'التاريخ')}</span><span>${dt(doc.date)}</span></div>
    ${o.showRepName && !r.pt.hidden('rcp.rep') ? `<div class="row"><span>${lbl(r, 'rcp.rep', 'المندوب')}</span><span>${esc(doc.repName)}</span></div>` : ''}
    <div class="sep"></div>
    <div class="row"><span>${lbl(r, 'rcp.from', 'استلمنا من')}</span><span>${esc(doc.customer.name)}</span></div>
    ${doc.customer.taxNumber && !r.pt.hidden('rcp.taxNumber') ? `<div class="row"><span>${lbl(r, 'rcp.taxNumber', 'الرقم الضريبي')}</span><span>${esc(doc.customer.taxNumber)}</span></div>` : ''}
    ${r.detailed && addr && !r.pt.hidden('rcp.address') ? `<div class="row"><span>${lbl(r, 'rcp.address', 'العنوان')}</span><span>${esc(addr)}</span></div>` : ''}
    ${r.pt.hidden('rcp.method') ? '' : `<div class="row"><span>${lbl(r, 'rcp.method', 'طريقة الدفع')}</span><span>${esc(methodLabelFor(doc.company, doc.paymentMethod, doc.paymentMethodKey, tr))}</span></div>`}
    ${doc.notes && !r.pt.hidden('rcp.notes') ? `<div class="row"><span>${lbl(r, 'rcp.notes', 'ملاحظات')}</span><span>${esc(doc.notes)}</span></div>` : ''}
    <div class="sep"></div>
    <div class="c muted">${lbl(r, 'rcp.amount', 'المبلغ المستلم')}</div>
    <div class="c b xl">${money(doc.amount)} ${curSym()}</div>
    ${receiptInvoiceRows(doc, tr, (key, ar) => lbl(r, key, ar), (key) => r.pt.hidden(key))}
    <div class="sep"></div>
    ${rollFoot(doc.company, r)}`;
}

/**
 * معاينة محرّر «نصوص المطبوعات» (components/print/PrintTextsEditor.tsx): وثيقة الشريط كما تُطبع لهذه الشركة — 58 مم بالملف الافتراضي
 * (الكلاسيكي، أو المختصر متى حفظت نصوصاً) و80 مم بالمختصر — لتُعرض في <iframe srcDoc>. لا طباعة ولا بلوتوث.
 */
export async function thermalPreviewHtml(doc: InvoiceDoc | ReceiptDoc, opts: { tr: Tr; paperMm: 58 | 80 }): Promise<string> {
  const profile: PrintProfile = opts.paperMm === 58
    ? legacyThermalProfile()
    : { ...legacyThermalProfile(), id: 'preview-80', template: 'roll_compact', paper: presetPaper('roll80') as Paper };
  let html = '';
  const capture = (h: string): void => { html = h; };
  if (doc.kind === 'invoice') await printThermalInvoice(doc, { profile, tr: opts.tr, capture });
  else await printThermalReceipt(doc, { profile, tr: opts.tr, capture });
  return html;
}
