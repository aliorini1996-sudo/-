/**
 * «نموذج الشركة المطبوع مسبقاً» (design = 'preprinted'، طلب المالك ١٠–١١ نوفمبر ٢٠٢٦) — الشركة تطبع على ورقها الجاهز (إطاراتٌ
 * وعناوين بلغتين وشعارٌ مطبوعةٌ سلفاً) فلا يخرج من الطابعة إلا **القيم وحدها** في فراغاتها: بلا إطارٍ ولا عنوانٍ ولا شعار.
 *
 * قواعده:
 * · ليس TemplateId — يُختار بـ`options.layout.design='preprinted'` ومواضعه `layout.form` (lib/print/formModel.ts، مقصوصةً داخل الورقة
 *   في resolveLayout) فيصل هنا من PrintableInvoice وحده (rep/RepDocuments.tsx): الفاتورة والمرتجع والإشعاران وسند التسليم
 *   (كلها kind 'invoice' — العنوان من القرار). وكل ما سواه يبقى على قالبه حرفاً (الحرّاس الذهبية).
 * · نقيّ تقوده الخصائص كالقالب ثنائي اللغة: القرار والعنوان والشمول من القالب الأصليّ، والرمز عقدةٌ جاهزة (`qr`) تُوضع في مربعها
 *   وحدها — هذا الملف لا يبني رمزاً ولا يكتب قيمته.
 * · الأبعاد بالمم من الركن الأيسر الأعلى الفعلي للورقة (x يميناً) + معايرة الطابعة dx/dy (printedBox). الأوراق formSheets: صفوف
 *   الجدول table.rows لكل ورقة، وحقول الرأس في كل ورقة، وحقول الإجماليات (FORM_LAST_SHEET_IDS) على الأخيرة وحدها، ورقم الصفحة «n/m».
 *   كل ورقة بطول الورق ناقص نصف مم (لا صفحة بيضاء زائدة) مقصوصةٌ (overflow:hidden)، وفاصل الصفحة بين الأوراق وحدها.
 * · القيم كما في القالب ثنائي اللغة (rep/printGrid.tsx): طريقة الدفع، والعنوان «العنوان، الحي»، والبائع من الشركة وعنوانها الوطني،
 *   وسعر الوحدة قبل الضريبة في الشامل، والإجماليات. لغة القيم المسمّاة (valueLang) والأرقام (latinDigits: 0-9 أو أرقام الشركة).
 * · «إزالة الضريبة» وقرار الطباعة: حقول الضريبة (الرقمان الضريبيان ومبلغ الضريبة وعمود نسبتها) لا تُطبع إلا متى أظهر القرار تفصيل
 *   الضريبة ولم يُخفِ أرقامها ولم يكن المستند معفى (isTaxFreePrint) — والمعفى بلا رمزٍ ولو مُرِّرت عقدته.
 * · الخلفية (form.background) صورة النموذج تحت القيم للورق الأبيض والتجربة — تُجلب بمُحمِّلٍ محقون (lib/print/formImage.ts)، وتعذّرها
 *   لا يمنع الطباعة: القيم وحدها وعلم data-form-bg="failed". والصورة مرّةً واحدة في أسلوب الجذر (data-form-bg-css) وكل ورقةٍ طبقةٌ
 *   فارغة تحمل خلفيتها — لا نسخةٌ من data URL في كل ورقة (printPageNode يرفع الأسلوب إلى رأس الوثيقة مرّة لكل النسخ) — وبلوَنها:
 *   مرشّح الأبيض والأسود للمظهر يمسّ <img> وحدها.
 * · ما لا يُحذف بحذف حقله (كالقالب ثنائي اللغة): علامة البروفة وتنبيه سند التسليم من قرار الطباعة (ما لم تُحذف الأختام صراحةً —
 *   areStampsRemoved)، والفاتورة الأصلية وسبب الإشعار (BT-25/KSA-10) ما لم يوضع حقلاهما — في شريطٍ أعلى كل ورقة (data-form-marks).
 */
import { forwardRef, type CSSProperties, type ReactNode } from 'react';
import type { InvoiceDoc } from './RepDocuments';
import { gridDateTime, type GridInvoiceFacts } from './printGrid';
import { PRINT_LOOK_CSS, lookNeedsCss, lookRootAttrs, type PrintLook } from './printLook';
import { fmtQty4, type ResolvedLayout } from '../lib/print/layout';
import { areStampsRemoved } from '../lib/print/printSettings';
import {
  FORM_REF_SHEET, FORM_TAX_COLUMN_IDS, FORM_TAX_FIELD_IDS, formFontPt, formSheetSize, formSheets, printedBox, sheetFields, tableRowTop,
  type FormBox, type FormColumn, type FormColumnId, type FormField, type FormFieldId, type FormSheetSize, type FormValueLang, type PrintForm,
} from '../lib/print/formModel';
import type { Align } from '../lib/print/printSettingsCore';
import { phraseIn } from '../lib/print/printTexts';
import { isTaxFreePrint } from '../lib/print/taxFreePrint';
import { formBackgroundRef, useFormImage, type FormImageStatus } from '../lib/print/formImage';
import { hasCustomerPhone } from '../lib/customerPhoneField';
import { currencyDecimals } from '../i18n/countries';
import { getActiveCurrency, getActiveNumerals } from '../utils/format';

export type FormInvoiceFacts = GridInvoiceFacts;

const FONT = "'Noto Kufi Arabic', 'IBM Plex Sans', system-ui, sans-serif";
/** هامش داخلي أفقي للقيمة داخل فراغها (لا تلمس خطوط الإطار المطبوع) */
const PAD_MM = 0.5;

/** = isSaudiDoc في RepDocuments (لا استيراد تشغيليّ منه: هو من يستورد هذا الملف) */
const isSaudi = (c?: { countryCode?: string | null } | null): boolean => (c?.countryCode ?? 'SA').toUpperCase() === 'SA';
/** نصٌّ سطراً واحداً */
const clean = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const r2 = (n: number): number => Math.round(n * 100) / 100;
const mm = (n: number): string => `${r2(n)}mm`;

// ─── الورقة ───

/** مقاس الورقة من مظهر القالب (data-pdf-format: a4/a5/letter أو «العرض×الطول») — والمجهول A4 */
export function formSheetOfLook(look: Pick<PrintLook, 'pdfFormat'>): FormSheetSize {
  const f = look.pdfFormat;
  if (f === 'a5') return { widthMm: 148, lengthMm: 210 };
  if (f === 'letter') return { widthMm: 215.9, lengthMm: 279.4 };
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(f ?? '');
  if (m) return formSheetSize({ widthMm: Number(m[1]), lengthMm: Number(m[2]) });
  return { ...FORM_REF_SHEET };
}

/** ارتفاع الورقة المرسومة: طول الورق ناقص نصف مم (1122.5 بكسل لـA4 قد تُسيل صفحةً بيضاء) */
export const FORM_SHEET_TRIM_MM = 0.5;

// ─── الأرقام ───

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
/** أرقامٌ عربية-هندية للأرقام اللاتينية وحدها (التاريخ والوقت ورقم الصفحة) */
const arDigits = (s: string): string => s.replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]);
/** رقمٌ بفواصله: الأرقام والفاصلتان العشرية والآلاف والنسبة المئوية بأشكالها العربية */
const arNumber = (s: string): string => arDigits(s).replace(/\./g, '٫').replace(/,/g, '٬').replace(/%/g, '٪');

/** أدوات القيم لهذه الورقة */
export interface FormValueKit {
  /** أرقام الشركة عربية-هندية والنموذج لا يطلب اللاتينية */
  arabic: boolean;
  lang: FormValueLang;
  /** منازل العملة العشرية */
  dec: number;
  /** حقول الضريبة تُطبع (القرار يُظهر تفصيلها ولا يُخفي أرقامها والمستند غير معفى) */
  vat: boolean;
  /** سعر الوحدة يُطبع قبل الضريبة (تفصيلٌ ظاهر وأسعارٌ شاملة) */
  exclPrice: boolean;
}

export function formValueKit(doc: InvoiceDoc, facts: Pick<FormInvoiceFacts, 'zDecision' | 'inclusiveDoc'>, form: Pick<PrintForm, 'latinDigits' | 'valueLang'>): FormValueKit {
  const taxFree = isTaxFreePrint(facts.zDecision, doc);
  const cur = isSaudi(doc.company) ? 'SAR' : getActiveCurrency();
  return {
    arabic: form.latinDigits === false && getActiveNumerals() === 'arabic',
    lang: form.valueLang === 'en' ? 'en' : 'ar',
    dec: currencyDecimals(cur),
    vat: facts.zDecision.showTaxBreakdown && facts.zDecision.hideTaxIds !== true && !taxFree,
    exclPrice: facts.zDecision.showTaxBreakdown && facts.inclusiveDoc,
  };
}

const moneyOf = (k: FormValueKit, n: number): string => {
  const s = Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: k.dec, maximumFractionDigits: k.dec });
  return k.arabic ? arNumber(s) : s;
};
const numOf = (k: FormValueKit, s: string): string => (k.arabic ? arNumber(s) : s);
const dateOf = (k: FormValueKit, v: string | Date | null | undefined, withTime = false): string => {
  if (v === null || v === undefined || v === '') return '';
  const s = gridDateTime(v, withTime);
  if (s === '-') return '';
  return k.arabic ? arDigits(s) : s;
};
/** «10:42» — وقت الإصدار بتوقيت الجهاز */
const timeOf = (k: FormValueKit, v: string | Date | null | undefined): string => {
  const day = dateOf({ ...k, arabic: false }, v);
  if (!day) return '';
  const t = gridDateTime(v as string, true).slice(day.length).trim();
  return k.arabic ? arDigits(t) : t;
};
/** قيمةٌ مسمّاة بلغة القيم: العربية كما هي، والإنجليزية من القاموس (أو العربية إن غابت) */
const named = (k: FormValueKit, ar: string): string => (k.lang === 'en' && ar ? phraseIn(ar, 'en') ?? ar : ar);

// ─── القيم ───

/** قيمةٌ مطبوعة: نصّها واتجاهها (ltr = رقمٌ أو رمزٌ لاتيني معزول) */
export interface FormValue { text: string; ltr: boolean }

type FormItem = InvoiceDoc['items'][number] & { code?: string | null; barcode?: string | null };

/** عنوان المستند بلغة القيم: عنوان القرار (أو صياغة الشركة له) — والمحذوف فارغ */
function titleOf(facts: Pick<FormInvoiceFacts, 'pt' | 'zDecision' | 'title'>, k: FormValueKit): FormValue {
  const decided = facts.zDecision.title;
  const ar = facts.pt.on ? facts.title.text : decided;
  if (!ar) return { text: '', ltr: false };
  if (k.lang !== 'en') return { text: ar, ltr: false };
  // صياغة الشركة الإنجليزية لعنوانها (نصوص المطبوعات، اللغة الثانية الإنجليزية) قبل القاموس — كقوالبها الأخرى
  const own = facts.pt.on && facts.pt.lang === 'en' ? clean(facts.title.alt) : '';
  if (own) return { text: own, ltr: !/[؀-ۿ]/.test(own) };
  const en = phraseIn(ar, 'en') ?? (ar !== decided ? phraseIn(decided, 'en') : null);
  return en ? { text: en, ltr: true } : { text: ar, ltr: false };
}

/**
 * قيم حقول الرأس والإجماليات (بلا رمز QR ولا رقم الصفحة) — الفارغ لا يُطبع. حقول الضريبة متى سمح بها kit.vat وحده.
 */
export function formFieldValues(
  doc: InvoiceDoc, facts: Pick<FormInvoiceFacts, 'pt' | 'zDecision' | 'title' | 'inclusiveDoc'> & Partial<Pick<FormInvoiceFacts, 'noteRefs'>>, k: FormValueKit,
): Partial<Record<FormFieldId, FormValue>> {
  const company = (doc.company ?? null) as (InvoiceDoc['company'] & { addrCity?: string | null; addrPostalCode?: string | null }) | null;
  const customer = doc.customer as InvoiceDoc['customer'] & { postalCode?: string | null };
  const notes = clean(doc.notes);
  const dueDate = doc.dueDate ?? null;
  const out: Partial<Record<FormFieldId, FormValue>> = {};
  const put = (id: FormFieldId, text: string, ltr: boolean): void => { if (text) out[id] = { text, ltr }; };

  put('docNumber', clean(doc.number), true);
  put('docDate', dateOf(k, doc.date), true);
  put('docTime', timeOf(k, doc.date), true);
  if (!doc.isReturn) {
    const pay = doc.paymentPlan === 'INSTALLMENT' ? 'تقسيط' : doc.type === 'CASH' ? 'نقدي' : 'آجل';
    const text = named(k, pay);
    put('paymentType', text, text !== pay);
  }
  put('dueDate', dateOf(k, dueDate), true);
  put('deliveryDate', dateOf(k, doc.deliveryDate), true);
  const title = titleOf(facts, k);
  put('docTitle', title.text, title.ltr);
  // الإشعار الدائن/المدين: مرجع الفاتورة الأصلية وسببه (BT-25/KSA-10) كما يطبعهما القالب ثنائي اللغة
  put('originalRef', clean(facts.noteRefs?.ref), true);
  put('noteReason', clean(facts.noteRefs?.reason), false);

  put('customerName', clean(customer.name), false);
  put('customerBusiness', clean(customer.businessName), false);
  put('customerAddress', [clean(customer.address), clean(customer.district)].filter(Boolean).join('، '), false);
  put('customerCity', clean(customer.city), false);
  put('customerPostal', clean(customer.postalCode), true);
  if (hasCustomerPhone(customer.phone)) put('customerPhone', clean(customer.phone), true);
  if (k.vat) put('customerVat', clean(customer.taxNumber), true);
  put('customerCr', clean(customer.commercialReg), true);

  put('sellerName', clean(company?.name), false);
  put('sellerAddress', clean(company?.address), false);
  put('sellerCity', clean(company?.addrCity), false);
  put('sellerPostal', clean(company?.addrPostalCode), true);
  put('sellerPhone', clean(company?.phone), true);
  if (k.vat) put('sellerVat', clean(company?.taxNumber), true);
  put('sellerCr', clean(company?.commercialReg), true);
  put('repName', clean(doc.repName), false);

  put('notes', notes, false);
  put('subtotal', moneyOf(k, doc.subtotal), true);
  put('discount', moneyOf(k, doc.discount), true);
  if (k.vat) put('vatAmount', moneyOf(k, doc.tax), true);
  put('totalDue', moneyOf(k, doc.total), true);
  // المدفوع والمتبقي كصفّيهما في القالب ثنائي اللغة: البيع الآجل وحده
  if (!doc.isReturn && doc.type === 'CREDIT' && doc.remainingAmt !== undefined) {
    put('paidAmt', moneyOf(k, doc.paidAmt ?? 0), true);
    put('remainingAmt', moneyOf(k, doc.remainingAmt), true);
  }
  return out;
}

/** قيمة خليّة في جدول الأصناف — n = تسلسل البند في المستند (من 1). عمود الضريبة متى سمح به kit.vat وحده */
export function formCellValue(it: FormItem, id: FormColumnId, n: number, k: FormValueKit): FormValue {
  switch (id) {
    case 'sr': return { text: numOf(k, String(n)), ltr: true };
    case 'itemCode': return { text: clean(it.code), ltr: true };
    case 'barcode': return { text: clean(it.barcode), ltr: true };
    case 'description': return { text: clean(it.name), ltr: false };
    case 'qty': return { text: numOf(k, fmtQty4(Number(it.qty))), ltr: true };
    case 'unit': return { text: clean(it.unit), ltr: false };
    case 'unitPrice': {
      // كالقالب ثنائي اللغة: الشامل يُطبع قبل الضريبة متى ظهر تفصيلها
      const r = Number(it.taxPct) || 0;
      const p = k.exclPrice && r > 0 ? (it.unitPrice * 100) / (100 + r) : it.unitPrice;
      return { text: moneyOf(k, p), ltr: true };
    }
    case 'discountPct': return { text: Number(it.discountPct) > 0 ? numOf(k, `${Number(it.discountPct)}%`) : '', ltr: true };
    case 'vatPct': return { text: k.vat ? numOf(k, `${Number(it.taxPct) || 0}%`) : '', ltr: true };
    case 'lineTotal': return { text: moneyOf(k, it.lineTotal), ltr: true };
    default: return { text: '', ltr: false };
  }
}

// ─── الرسم ───

const textAlignOf = (a: Align | undefined): CSSProperties['textAlign'] => (a === 'center' ? 'center' : a === 'end' ? 'end' : 'start');
const justifyOf = (a: Align | undefined): CSSProperties['justifyContent'] => (a === 'center' ? 'center' : a === 'end' ? 'flex-end' : 'flex-start');

/** صندوق قيمةٍ مطلق بالمم: سطرٌ واحد في وسط ارتفاعه، والزائد يُقصّ بنقاط */
function valueBoxStyle(b: FormBox, align: Align | undefined, pt: number, bold: boolean): CSSProperties {
  return {
    position: 'absolute', left: mm(b.x), top: mm(b.y), width: mm(b.w), height: mm(b.h), boxSizing: 'border-box',
    padding: `0 ${PAD_MM}mm`, lineHeight: mm(b.h), fontSize: `${pt}pt`, fontWeight: bold ? 700 : undefined, textAlign: textAlignOf(align),
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  };
}

const valueNode = (v: FormValue): ReactNode => (v.ltr
  ? <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>{v.text}</span>
  : <span dir="auto" style={{ unicodeBidi: 'isolate' }}>{v.text}</span>);

/** رمز QR في مربعه: الصورة بضلع min(w,h) بلا حشوةٍ ولا إطار — وما تحتها (التعليق) يُقصّ بحدود المربع. بلا علامات اقتباس (نصّ <style> لا يُهرَّب) */
const qrCss = (side: number): string => [
  '[data-print-layout=preprinted] [data-form-qr] div { padding: 0 !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; max-width: none !important; }',
  `[data-print-layout=preprinted] [data-form-qr] img[alt=QR] { display: block !important; width: ${r2(side)}mm !important; height: ${r2(side)}mm !important; max-width: none !important; }`,
].join('\n');

/**
 * صورة الخلفية مرّةً في أسلوب الجذر (لا في كل ورقة) — وكل ورقةٍ طبقةٌ فارغةٌ بها. الرابط بلا علامات اقتباس (نصّ <style> يُهرَّب في تصيير
 * الخادم كـqrCss، ومحارف base64 جائزةٌ في url() بلا اقتباس).
 * !important بمحدِّدٍ أخصّ من مظهر الأبيض والأسود (`[data-print-look~="mono"] * { background: transparent !important }` يمحو الصورة)
 */
export const formBgCss = (src: string): string =>
  `[data-print-layout=preprinted] [data-form-bg-layer] { background-image: url(${src}) !important; background-size: 100% 100% !important; background-repeat: no-repeat !important; }`;

/** شريط ما لا يُحذف بحذف حقله: أعلى الورقة بين هامشين 8 مم (بالمعايرة)، والسطور تلتفّ ولا تُقصّ */
const MARKS_BAND = Object.freeze({ x: 8, y: 2, pt: 8 });

export interface FormMark { key: string; text: string; bold?: boolean }

/**
 * سطور شريط الورقة: علامة البروفة وتنبيه القرار (ما لم تُحذف الأختام صراحةً — areStampsRemoved كالقالب ثنائي اللغة)، ومرجع الفاتورة
 * الأصلية وسببه ما لم يضع النموذج حقليهما — بتسميةٍ بلغة القيم. فارغة ⇒ لا شريط.
 */
export function formMarks(
  facts: Pick<FormInvoiceFacts, 'zDecision'> & Partial<Pick<FormInvoiceFacts, 'noteRefs'>>, form: Pick<PrintForm, 'fields'>,
  layout: Pick<ResolvedLayout, 'stamps'> | null | undefined, k: Pick<FormValueKit, 'lang'>,
): FormMark[] {
  const out: FormMark[] = [];
  const has = (id: FormFieldId): boolean => form.fields.some((f) => f.id === id);
  if (!areStampsRemoved(layout ?? null)) {
    const wm = clean(facts.zDecision.watermark);
    const notice = clean(facts.zDecision.notice);
    if (wm) out.push({ key: 'wm', text: wm, bold: true });
    if (notice) out.push({ key: 'nt', text: notice });
  }
  const label = (ar: string): string => (k.lang === 'en' ? phraseIn(ar, 'en') ?? ar : ar);
  const ref = clean(facts.noteRefs?.ref);
  const reason = clean(facts.noteRefs?.reason);
  if (ref && !has('originalRef')) out.push({ key: 'ref', text: `${label('الفاتورة الأصلية')}: ${ref}` });
  if (reason && !has('noteReason')) out.push({ key: 'why', text: `${label('سبب الإرجاع')}: ${reason}` });
  return out;
}

export interface FormInvoiceProps {
  doc: InvoiceDoc;
  facts: FormInvoiceFacts;
  look: PrintLook;
  layout: ResolvedLayout;
  qr: ReactNode | null;
  /** مقاس الورقة إن عُرف (المعاينة) — وإلا من مظهر القالب */
  sheet?: FormSheetSize;
}

/** تخطيطٌ بلا مواضع (لا يقع: resolveLayout لا يضع التصميم بلا نموذجٍ صالح) — ورقةٌ فارغة لا قالبٌ آخر */
const EMPTY_FORM: PrintForm = { image: null, dxMm: 0, dyMm: 0, background: false, latinDigits: true, valueLang: 'ar', fields: [], table: null };

export const FormInvoice = forwardRef<HTMLDivElement, FormInvoiceProps>(({ doc, facts, look, layout, qr: qrIn, sheet }, ref) => {
  const form = layout.form ?? EMPTY_FORM;
  const S = sheet ?? formSheetOfLook(look);
  const taxFree = isTaxFreePrint(facts.zDecision, doc);
  // المعفى بلا رمزٍ ولو مُرِّرت عقدته (كالقالب ثنائي اللغة)
  const qr = taxFree ? null : qrIn;
  const k = formValueKit(doc, facts, form);
  const values = formFieldValues(doc, facts, k);
  const bg = useFormImage(formBackgroundRef(form));
  const bgStatus: FormImageStatus | null = form.background && form.image ? bg.status : null;
  const table = form.table;
  const columns: FormColumn[] = table ? table.columns.filter((c) => k.vat || !FORM_TAX_COLUMN_IDS.includes(c.id)) : [];
  const sheets = formSheets(doc.items as FormItem[], table ? table.rows : null);
  const qrField = form.fields.find((f) => f.id === 'qr');
  const qrPrinted = !!qrField && qr !== null && qr !== undefined && qr !== false;
  const marks = formMarks(facts, form, layout, k);
  const band = printedBox(form, { x: MARKS_BAND.x, y: MARKS_BAND.y, w: Math.max(10, S.widthMm - 2 * MARKS_BAND.x), h: 0 });
  const marksNode = marks.length ? (
    <div data-form-marks="" style={{
      position: 'absolute', left: mm(band.x), top: mm(band.y), width: mm(band.w), boxSizing: 'border-box', padding: `0.5mm ${PAD_MM}mm`,
      fontSize: `${MARKS_BAND.pt}pt`, lineHeight: 1.35, textAlign: 'center', background: '#fff',
    }}>
      {marks.map((m) => <div key={m.key} style={m.bold ? { fontWeight: 700 } : undefined}><span dir="auto" style={{ unicodeBidi: 'isolate' }}>{m.text}</span></div>)}
    </div>
  ) : null;

  const fieldNode = (f: FormField, page: { n: number; of: number }): ReactNode => {
    if (FORM_TAX_FIELD_IDS.includes(f.id) && !k.vat) return null;
    const b = printedBox(form, f);
    if (f.id === 'qr') {
      if (!qrPrinted) return null;
      return (
        <div key={f.id} data-form-field="qr" data-form-qr=""
          style={{ position: 'absolute', left: mm(b.x), top: mm(b.y), width: mm(b.w), height: mm(b.h), overflow: 'hidden', display: 'flex', justifyContent: justifyOf(f.align), alignItems: 'flex-start' }}>
          {qr}
        </div>
      );
    }
    const v: FormValue | undefined = f.id === 'pageNo' ? { text: k.arabic ? arDigits(`${page.n}/${page.of}`) : `${page.n}/${page.of}`, ltr: true } : values[f.id];
    if (!v || !v.text) return null;
    return (
      <div key={f.id} data-form-field={f.id} style={valueBoxStyle(b, f.align, formFontPt(f.fontPct), f.bold === true)}>
        {valueNode(v)}
      </div>
    );
  };

  const rowNodes = (items: FormItem[], offset: number): ReactNode[] => {
    if (!table || columns.length === 0) return [];
    const pt = formFontPt(table.fontPct);
    return items.map((it, i) => (
      <div key={`r${i}`} data-form-row={offset + i + 1}>
        {columns.map((c) => {
          const v = formCellValue(it, c.id, offset + i + 1, k);
          if (!v.text) return null;
          const b = printedBox(form, { x: c.x, y: tableRowTop(table, i), w: c.w, h: table.rowMm });
          return <div key={c.id} data-form-col={c.id} style={valueBoxStyle(b, c.align, pt, false)}>{valueNode(v)}</div>;
        })}
      </div>
    ));
  };

  const bgSrc = bg.status === 'ready' && bg.src && bgStatus !== null ? bg.src : null;
  const bgLayer = bgSrc ? (
    <div aria-hidden="true" data-form-bg-layer=""
      style={{ position: 'absolute', left: mm(form.dxMm || 0), top: mm(form.dyMm || 0), width: mm(S.widthMm), height: mm(S.lengthMm) }} />
  ) : null;

  return (
    <div ref={ref} {...lookRootAttrs(look)} data-print-layout="preprinted" data-form-sheets={sheets.length}
      {...(bgStatus !== null ? { 'data-form-bg': bgStatus } : {})}
      style={{ width: mm(S.widthMm), background: '#fff', color: '#000', fontFamily: FONT, direction: 'rtl', margin: 0, padding: 0, boxSizing: 'border-box' }}>
      {sheets.map((s) => (
        <div key={s.index} data-form-sheet={s.index + 1}
          style={{
            position: 'relative', width: mm(S.widthMm), height: mm(S.lengthMm - FORM_SHEET_TRIM_MM), overflow: 'hidden', boxSizing: 'border-box',
            ...(s.last ? {} : { breakAfter: 'page', pageBreakAfter: 'always' }),
          }}>
          {bgLayer}
          {sheetFields(form, s.last).map((f) => fieldNode(f, { n: s.index + 1, of: s.count }))}
          {rowNodes(s.items, s.offset)}
          {marksNode}
        </div>
      ))}
      {bgSrc ? <style data-form-bg-css="">{formBgCss(bgSrc)}</style> : null}
      {qrPrinted && qrField ? <style>{qrCss(Math.min(qrField.w, qrField.h))}</style> : null}
      {lookNeedsCss(look) ? <style>{PRINT_LOOK_CSS}</style> : null}
    </div>
  );
});
FormInvoice.displayName = 'FormInvoice';
