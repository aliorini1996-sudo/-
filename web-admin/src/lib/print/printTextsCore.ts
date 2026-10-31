// ============================================================================
// نسخة حرفية من backend/src/services/printTextsCore.ts (بعد رأسه) — «نصوص المطبوعات» v1: القائمة المغلقة والأقفال والبنية
// والصورة القانونية — فيقرأ الجهاز ما يحفظه الخادم بالقواعد نفسها، ومتسامحاً مع ما أضافه خادمٌ أحدث.
// لا تعدّل هنا: عدّل ملف الخادم ثم انسخه. الحارس lib/print/printTexts.test.ts يفشل عند أي فرق.
// ============================================================================

import { z } from 'zod';

/** نسخة البنية — أيّ نسخة أخرى (جوال قديم يقرأ إعداداً أحدث) تُعامَل كأنها لا إعدادات (نصوص اليوم) */
export const PRINT_TEXTS_VERSION = 1;

/** اللغة الثانية على الورقة — العربية الأولى دائماً (لغة الفاتورة الضريبية الإلزامية) */
export const PRINT_SECOND_LANGS = ['en', 'fr', 'tr', 'zh'] as const;
export type PrintSecondLang = (typeof PRINT_SECOND_LANGS)[number];

export const PRINT_TEXT_LOCKS = ['none', 'standard', 'zatca', 'fixed', 'shape', 'title'] as const;
export type PrintTextLock = (typeof PRINT_TEXT_LOCKS)[number];

/** shared = ترويسة وتذييل الورقتين معاً */
export type PrintTextDoc = 'invoice' | 'receipt' | 'shared';
export type PrintTextGroup = 'header' | 'title' | 'info' | 'customer' | 'items' | 'totals' | 'installments' | 'footer' | 'amount';

export interface PrintTextEntry {
  key: string;
  /** النصّ العربيّ الافتراضي كما في قالب A4 — مفتاح قاموس الترجمة (PHRASES) للغة الثانية الافتراضية */
  ar: string;
  doc: PrintTextDoc;
  group: PrintTextGroup;
  lock: PrintTextLock;
  /** أطول نصّ (بالمحارف) — 60 للتسميات */
  max: number;
  /** يُخفى ولا يُعاد صياغته (قيمةٌ من بيانات الشركة لا تسمية) */
  hideOnly?: boolean;
}

function e(key: string, ar: string, doc: PrintTextDoc, group: PrintTextGroup, lock: PrintTextLock = 'none', extra?: Partial<PrintTextEntry>): PrintTextEntry {
  return Object.freeze({ key, ar, doc, group, lock, max: 60, ...extra });
}

/**
 * القائمة المغلقة بترتيب العرض. **المفتاح ثابت للأبد** (يُحفظ في صفوف الشركات): حذف مفتاحٍ هنا يجعل كل إعدادٍ محفوظٍ به
 * غير صالح في الخادم الصارم — فالمفتاح المتقاعد يبقى ولا يُقرأ. والإضافة آمنة.
 */
export const PRINT_TEXT_CATALOG: readonly PrintTextEntry[] = Object.freeze([
  // ── مشترك: الترويسة والتذييل ──
  e('h.taxNumber', 'الرقم الضريبي', 'shared', 'header', 'zatca'),
  e('h.commercialReg', 'السجل التجاري', 'shared', 'header', 'zatca'),
  e('h.address', 'العنوان', 'shared', 'header', 'zatca'),
  e('h.phone', 'هاتف', 'shared', 'header'),
  e('h.email', 'البريد', 'shared', 'header'),
  e('foot.thanks', 'شكرا لتعاملكم معنا', 'shared', 'footer', 'none', { max: 160 }),
  e('foot.company', 'اسم الشركة في التذييل', 'shared', 'footer', 'none', { hideOnly: true }),

  // ── الفاتورة ──
  e('inv.title', 'فاتورة ضريبية مبسطة', 'invoice', 'title', 'title'),
  e('inv.returnTitle', 'إشعار دائن مرتجع', 'invoice', 'title', 'title'),
  e('inv.infoHeading', 'بيانات الفاتورة', 'invoice', 'info'),
  e('inv.returnInfoHeading', 'بيانات المرتجع', 'invoice', 'info'),
  e('inv.number', 'رقم الفاتورة', 'invoice', 'info', 'zatca'),
  e('inv.returnNumber', 'رقم المرتجع', 'invoice', 'info', 'zatca'),
  e('inv.date', 'التاريخ', 'invoice', 'info', 'zatca'),
  e('inv.time', 'وقت الإصدار', 'invoice', 'info', 'zatca'),
  e('inv.type', 'النوع', 'invoice', 'info'),
  e('inv.deliveryDate', 'تاريخ التسليم', 'invoice', 'info', 'zatca'),
  e('inv.rep', 'المندوب', 'invoice', 'info'),

  e('cust.heading', 'بيانات العميل', 'invoice', 'customer'),
  e('cust.name', 'الاسم', 'invoice', 'customer', 'standard'),
  e('cust.business', 'المنشأة', 'invoice', 'customer', 'standard'),
  e('cust.commercialReg', 'السجل التجاري', 'invoice', 'customer', 'standard'),
  e('cust.taxNumber', 'الرقم الضريبي', 'invoice', 'customer', 'zatca'),
  e('cust.phone', 'الجوال', 'invoice', 'customer'),
  e('cust.address', 'العنوان', 'invoice', 'customer', 'standard'),

  e('col.item', 'الصنف', 'invoice', 'items', 'zatca'),
  e('col.qty', 'الكمية', 'invoice', 'items', 'zatca'),
  e('col.price', 'السعر', 'invoice', 'items', 'zatca'),
  e('col.priceIncl', 'السعر شامل الضريبة', 'invoice', 'items', 'fixed'),
  e('col.discount', 'الخصم', 'invoice', 'items', 'standard'),
  e('col.tax', 'الضريبة', 'invoice', 'items', 'standard'),
  e('col.total', 'الإجمالي', 'invoice', 'items', 'zatca'),
  e('item.beforeTax', 'قبل الضريبة', 'invoice', 'items', 'fixed'),
  e('note.pricesIncl', 'الأسعار المعروضة شاملة ضريبة القيمة المضافة', 'invoice', 'items', 'fixed', { max: 120 }),

  e('tot.subtotal', 'المجموع قبل الخصم', 'invoice', 'totals'),
  e('tot.discount', 'الخصم', 'invoice', 'totals', 'standard'),
  e('tot.taxable', 'الوعاء الخاضع للضريبة', 'invoice', 'totals', 'fixed'),
  e('tot.vat', 'ضريبة القيمة المضافة', 'invoice', 'totals', 'fixed'),
  e('tot.vatIncl', 'منها ضريبة القيمة المضافة', 'invoice', 'totals', 'fixed'),
  e('tot.grand', 'الإجمالي النهائي', 'invoice', 'totals', 'zatca'),
  e('tot.returnGrand', 'إجمالي المرتجع دائن', 'invoice', 'totals', 'zatca'),
  e('tot.paid', 'المدفوع', 'invoice', 'totals'),
  e('tot.remaining', 'المتبقي', 'invoice', 'totals'),

  e('inst.heading', 'جدول الأقساط', 'invoice', 'installments', 'shape'),
  e('inst.dueDate', 'تاريخ الاستحقاق', 'invoice', 'installments', 'shape'),
  e('inst.amount', 'المبلغ', 'invoice', 'installments', 'shape'),
  e('inst.sum', 'مجموع الأقساط', 'invoice', 'installments', 'shape'),
  e('inst.note', 'الضريبة مستحقة بالكامل على هذه الفاتورة عند التوريد والأقساط جدول سداد لا تجزئة ضريبية', 'invoice', 'installments', 'none', { max: 160, hideOnly: true }),

  // نصّ قرار الطباعة تحت الرمز: يُخفى (ليس إلزامياً) ولا يُعاد صياغته — صياغةٌ حرّة قد تدّعي «اعتماد الهيئة» كذباً
  e('qr.caption', 'رمز الاستجابة السريعة للفاتورة الضريبية', 'invoice', 'footer', 'none', { hideOnly: true }),
  e('sig.recipient', 'توقيع المستلم', 'invoice', 'footer'),
  e('sig.rep', 'توقيع المندوب', 'invoice', 'footer'),
  // الإشعار الدائن (المرتجع): مرجع الفاتورة الأصلية (BT-25، BR-KSA-56) وسببه (KSA-10، BR-KSA-17) — إلزاميان عليه فيُعاد صياغتهما
  // ولا يُخفيان، ويُطبعان متى حملهما المستند وحده (مرتجعات المرحلة الأولى بلا مرجع ورقتها كما كانت)
  e('inv.originalRef', 'الفاتورة الأصلية', 'invoice', 'info', 'zatca'),
  e('inv.noteReason', 'سبب الإرجاع', 'invoice', 'info', 'zatca'),

  // ── سند القبض ──
  e('rcp.title', 'سند قبض', 'receipt', 'title'),
  e('rcp.number', 'رقم السند', 'receipt', 'info', 'shape'),
  e('rcp.date', 'التاريخ', 'receipt', 'info', 'shape'),
  e('rcp.time', 'وقت الإصدار', 'receipt', 'info'),
  e('rcp.rep', 'المندوب', 'receipt', 'info'),
  e('rcp.amount', 'المبلغ المستلم', 'receipt', 'amount', 'shape'),
  e('rcp.forInvoice', 'مقابل الفاتورة رقم', 'receipt', 'amount'),
  e('rcp.forInvoices', 'مقابل الفواتير', 'receipt', 'amount'),
  e('rcp.invoiceNo', 'فاتورة رقم', 'receipt', 'amount'),
  e('rcp.credit', 'رصيد دائن للعميل غير مخصص لفاتورة', 'receipt', 'amount', 'none', { max: 80 }),
  e('rcp.customerHeading', 'بيانات العميل', 'receipt', 'customer'),
  e('rcp.from', 'استلمنا من السيد', 'receipt', 'customer', 'shape'),
  e('rcp.business', 'المنشأة', 'receipt', 'customer'),
  e('rcp.commercialReg', 'السجل التجاري', 'receipt', 'customer'),
  e('rcp.taxNumber', 'الرقم الضريبي', 'receipt', 'customer'),
  e('rcp.phone', 'الجوال', 'receipt', 'customer'),
  e('rcp.address', 'العنوان', 'receipt', 'customer'),
  e('rcp.method', 'طريقة الدفع', 'receipt', 'customer'),
  e('rcp.notes', 'ملاحظات', 'receipt', 'customer'),
  e('rcp.sigPayer', 'توقيع الدافع', 'receipt', 'footer'),
  e('rcp.sigCollector', 'توقيع المستلم المندوب', 'receipt', 'footer'),
] as PrintTextEntry[]);

const BY_KEY: ReadonlyMap<string, PrintTextEntry> = new Map(PRINT_TEXT_CATALOG.map((x) => [x.key, x] as const));

/** مدخل المفتاح في القائمة أو undefined لمفتاحٍ مجهول */
export function printTextEntry(key: string): PrintTextEntry | undefined {
  return BY_KEY.get(key);
}

/** هل يقبل المفتاح الإخفاء في الإعداد المحفوظ — standard يُقبل (يُطبَّق على المبسّطة وحدها عند الطباعة) */
export function printTextHideable(entry: PrintTextEntry): boolean {
  return entry.lock === 'none' || entry.lock === 'standard' || entry.lock === 'title';
}

/** هل تُعاد صياغته العربية — لا للعبارات الضريبية بصياغتها (fixed) ولا لما يُخفى فقط */
export function printTextRewordable(entry: PrintTextEntry): boolean {
  return entry.lock !== 'fixed' && !entry.hideOnly;
}

/** هل يُكتب له نصٌّ باللغة الثانية — كل ما يُطبع تسميةً (ما يُخفى فقط قيمةٌ أو عبارةٌ لا تُصاغ) */
export function printTextAltEditable(entry: PrintTextEntry): boolean {
  return !entry.hideOnly;
}

/** تعديل نصٍّ واحد: text = صياغة عربية بديلة، alt = نصّ اللغة الثانية، hidden = لا يُطبع (ولا صفّه) */
export interface PrintTextEdit {
  text: string | null;
  alt: string | null;
  hidden: boolean;
}

export interface PrintTextsV1 {
  version: 1;
  /** null = العربية وحدها (كاليوم) */
  secondLang: PrintSecondLang | null;
  /** اسم الشركة وعنوانها باللغة الثانية — يُطبعان تحت العربيين متى اختيرت لغة ثانية */
  companyNameAlt: string | null;
  companyAddressAlt: string | null;
  /** مفاتيح القائمة وحدها، بترتيبها، وبلا تعديلٍ فارغ (الصورة القانونية) */
  edits: Record<string, PrintTextEdit>;
}

export const PRINT_TEXTS_LIMITS = Object.freeze({
  /** لا صور — الحدّ يحرس صفّ الشركة المقروء مع كل /company؛ 32 كيلوبايت تتسع لكل نصٍّ بحدّه ولغةٍ ثانية بثلاثة بايتات للمحرف (الصينية) */
  maxBytes: 32 * 1024,
  companyNameAltMax: 80,
  companyAddressAltMax: 160,
});

// ─── البنية (zod) — صارمة في الخادم (مفتاح مجهول ⇒ رفض)، ومتسامحة في الجهاز (مفتاح مجهول يُهمل) ───

function makePrintTextsSchema(strict: boolean) {
  const edit = strict
    ? z.object({ text: z.string().nullable(), alt: z.string().nullable(), hidden: z.boolean() }).strict()
    : z.object({ text: z.string().nullable(), alt: z.string().nullable(), hidden: z.boolean() });
  const shape = {
    version: z.literal(1),
    secondLang: z.enum(PRINT_SECOND_LANGS).nullable(),
    companyNameAlt: z.string().nullable(),
    companyAddressAlt: z.string().nullable(),
    edits: z.record(z.string(), edit),
  };
  return strict ? z.object(shape).strict() : z.object(shape);
}

/** المخطط الصارم الذي يحفظ به PUT /api/company/print-texts */
export const printTextsV1Schema = makePrintTextsSchema(true);
const lenientSchema = makePrintTextsSchema(false);

// ─── رسائل الرفض (عربية؛ مترجمة في قاموس الواجهة) ───

export const PRINT_TEXTS_ISSUES = Object.freeze({
  shape: 'بنية نصوص المطبوعات غير صالحة',
  unknownKey: 'حقل غير معروف في نصوص المطبوعات',
  tooLarge: 'نصوص المطبوعات أكبر من الحد المسموح 32 كيلوبايت',
  unknownText: 'نص غير معروف في نصوص المطبوعات',
  locked: 'هذا النص إلزامي في الفاتورة الضريبية ولا يخفى',
  hideOnly: 'هذا السطر يخفى ولا يعاد صياغته',
  fixed: 'هذه العبارة الضريبية لا تعاد صياغتها بالعربية',
  tooLong: 'النص أطول من الحد المسموح',
  companyNameAlt: 'اسم الشركة باللغة الثانية أطول من 80 حرفا',
  companyAddressAlt: 'العنوان باللغة الثانية أطول من 160 حرفا',
});

export interface PrintTextsIssue { path: string; message: string }

const charLen = (s: string): number => Array.from(s).length;
/**
 * نصّ سطر واحد: محارف التحكم والأسطر والمسافات المتكررة ⇒ مسافة واحدة؛ والفارغ null. وتُحذف قبلها محارف الاتجاه والمحارف الخفيّة
 * (U+200B وLRM/RLM وU+202A–U+202E وU+2060–U+2064 وU+2066–U+2069): تسميةٌ منها وحدها تُخفي نصّاً مقفلاً، وRLO مفتوحٌ يقلب الرقم
 * الضريبي المطبوع بعدها. ZWNJ/ZWJ (U+200C/U+200D) يبقيان — حرفان حقيقيان في الكتابة العربية والفارسية.
 */
const oneLineOrNull = (s: string | null): string | null => {
  if (s === null) return null;
  const v = s.replace(/[​‎‏‪-‮⁠-⁤⁦-⁩]/g, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  return v ? v : null;
};

/** طول JSON بالبايت (UTF-8) — بلا TextEncoder ليعمل في الخادم والمتصفح سواء */
export function printTextsBytes(v: unknown): number {
  const s = JSON.stringify(v) ?? '';
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } else n += 3;
  }
  return n;
}

/** الإعداد الفارغ — يساوي null في الأثر (نصوص اليوم) */
export function emptyPrintTexts(): PrintTextsV1 {
  return { version: 1, secondLang: null, companyNameAlt: null, companyAddressAlt: null, edits: {} };
}

/**
 * الصورة القانونية: النصوص سطراً واحداً (والفارغ null)، والتعديل الذي لا يغيّر شيئاً يُحذف، والمفاتيح بترتيب القائمة — ومفتاحٌ
 * مجهول يُحذف هنا (الصارم رفضه قبلها في printTextsIssuesRaw؛ والمتسامح يهمله: مفتاحٌ أضافه خادمٌ أحدث).
 */
export function canonicalPrintTexts(s: PrintTextsV1): PrintTextsV1 {
  const edits: Record<string, PrintTextEdit> = {};
  for (const entry of PRINT_TEXT_CATALOG) {
    const raw = Object.prototype.hasOwnProperty.call(s.edits, entry.key) ? s.edits[entry.key] : undefined;
    if (!raw) continue;
    const text = printTextRewordable(entry) ? oneLineOrNull(raw.text) : null;
    const alt = printTextAltEditable(entry) ? oneLineOrNull(raw.alt) : null;
    const hidden = raw.hidden === true;
    if (text === null && alt === null && !hidden) continue;
    edits[entry.key] = { text, alt, hidden };
  }
  return {
    version: 1,
    secondLang: s.secondLang,
    companyNameAlt: oneLineOrNull(s.companyNameAlt),
    companyAddressAlt: oneLineOrNull(s.companyAddressAlt),
    edits,
  };
}

/** قواعد ما قبل الصورة القانونية (المفاتيح المجهولة والإخفاء المقفل والأطوال) — تُشغَّل على المُحلَّل */
function printTextsIssuesRaw(s: PrintTextsV1): PrintTextsIssue[] {
  const out: PrintTextsIssue[] = [];
  for (const [key, edit] of Object.entries(s.edits)) {
    const entry = BY_KEY.get(key);
    const at = `edits.${key}`;
    if (!entry) { out.push({ path: at, message: PRINT_TEXTS_ISSUES.unknownText }); continue; }
    if (edit.hidden && !printTextHideable(entry)) out.push({ path: `${at}.hidden`, message: PRINT_TEXTS_ISSUES.locked });
    if (entry.hideOnly && (oneLineOrNull(edit.text) !== null || oneLineOrNull(edit.alt) !== null)) out.push({ path: at, message: PRINT_TEXTS_ISSUES.hideOnly });
    else if (entry.lock === 'fixed' && oneLineOrNull(edit.text) !== null) out.push({ path: `${at}.text`, message: PRINT_TEXTS_ISSUES.fixed });
    const text = oneLineOrNull(edit.text);
    const alt = oneLineOrNull(edit.alt);
    if (text !== null && charLen(text) > entry.max) out.push({ path: `${at}.text`, message: PRINT_TEXTS_ISSUES.tooLong });
    if (alt !== null && charLen(alt) > entry.max) out.push({ path: `${at}.alt`, message: PRINT_TEXTS_ISSUES.tooLong });
  }
  const name = oneLineOrNull(s.companyNameAlt);
  if (name !== null && charLen(name) > PRINT_TEXTS_LIMITS.companyNameAltMax) out.push({ path: 'companyNameAlt', message: PRINT_TEXTS_ISSUES.companyNameAlt });
  const addr = oneLineOrNull(s.companyAddressAlt);
  if (addr !== null && charLen(addr) > PRINT_TEXTS_LIMITS.companyAddressAltMax) out.push({ path: 'companyAddressAlt', message: PRINT_TEXTS_ISSUES.companyAddressAlt });
  return out;
}

/**
 * إعدادٌ لا أثر له — يُعامَل كـnull: الحفظ يكتب null والقراءة نصوص اليوم. وبلا لغةٍ ثانية لا أثر لنصوصها (الاسم والعنوان وalt كل صفّ)
 * — فإطفاء «بلغتين» وحده لا يُبقي الشركة على «العربية أولاً» وشريط المختصر بلا سببٍ ظاهر.
 */
export function isEmptyPrintTexts(s: PrintTextsV1): boolean {
  const c = canonicalPrintTexts(s);
  if (c.secondLang !== null) return false;
  return Object.values(c.edits).every((e) => e.text === null && !e.hidden);
}

export type PrintTextsCheck = { ok: true; value: PrintTextsV1 } | { ok: false; issues: PrintTextsIssue[] };

/**
 * البنية ثم القواعد ثم الصورة القانونية — strict للحفظ في الخادم (مفتاح مجهول أو إخفاءٌ مقفل ⇒ رفض)، وغير strict لقراءة الجهاز:
 * ما لا يصلح من التعديلات يُهمل وحده (إخفاء نصٍّ صار مقفلاً في نسخةٍ أحدث يُطبع النصّ؛ والأطول من حدّه يُقصّ للحدّ)، فلا يفقد
 * الجهاز إعداد الشركة كلّه لسطرٍ واحد. نسخة غير 1 ترفض في الحالتين.
 */
export function checkPrintTexts(raw: unknown, strict: boolean): PrintTextsCheck {
  const parsed = (strict ? printTextsV1Schema : lenientSchema).safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 10).map((i) => ({
        path: i.path.join('.'),
        message: i.code === 'unrecognized_keys' ? PRINT_TEXTS_ISSUES.unknownKey : PRINT_TEXTS_ISSUES.shape,
      })),
    };
  }
  const shaped: PrintTextsV1 = parsed.data; // فحص تصريف: مخرج zod يطابق الواجهات أعلاه
  if (strict) {
    const issues = printTextsIssuesRaw(shaped);
    if (issues.length) return { ok: false, issues };
    return { ok: true, value: canonicalPrintTexts(shaped) };
  }
  const value = canonicalPrintTexts(shaped);
  const clip = (s: string | null, max: number): string | null => (s === null ? null : Array.from(s).slice(0, max).join('').trimEnd() || null);
  for (const [key, edit] of Object.entries(value.edits)) {
    const entry = BY_KEY.get(key) as PrintTextEntry;
    const hidden = edit.hidden && printTextHideable(entry);
    const text = clip(edit.text, entry.max);
    const alt = clip(edit.alt, entry.max);
    if (text === null && alt === null && !hidden) delete value.edits[key];
    else value.edits[key] = { text, alt, hidden };
  }
  value.companyNameAlt = clip(value.companyNameAlt, PRINT_TEXTS_LIMITS.companyNameAltMax);
  value.companyAddressAlt = clip(value.companyAddressAlt, PRINT_TEXTS_LIMITS.companyAddressAltMax);
  return { ok: true, value };
}
