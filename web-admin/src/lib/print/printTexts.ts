/**
 * «نصوص المطبوعات» في الواجهة (طلب المالك ٣١ أكتوبر ٢٠٢٦) — القراءة المتسامحة لعمود الشركة، والمحلِّل الذي تسأله القوالب
 * (A4 والحرارية والنقطية) عن كل نصّ: ماذا يُطبع بالعربية، وما سطره باللغة الثانية، وهل يُخفى على هذا المستند.
 *
 * القاعدة الأولى: شركةٌ بلا نصوص (null أو عطب أو نسخة أحدث) ⇒ `on: false` والمحلِّل يعيد `tr(ar)` حرفاً بحرف ولا يخفي شيئاً —
 * والقوالب لا تغيّر في ورقتها حرفاً واحداً (الحارس الذهبيّ للشريط 58 مم وحرّاس printTexts.test.ts).
 *
 * والثانية: شركةٌ لها نصوص تطبع فاتورتها وسندها **بالعربية أولاً** أيّاً كانت لغة واجهة الجهاز، ومعها اللغة الثانية إن اختارتها —
 * العربية إلزامية في الفاتورة الضريبية واللغة الأخرى ترجمةٌ بجانبها (اللائحة التنفيذية م٦٦). فـ`tr` في المحلِّل هويّة حينها.
 *
 * والثالثة (طلب المالك ٣ نوفمبر ٢٠٢٦): كل نصٍّ يُعاد صياغته ويُحذف — `hidden(key)` = «حذف السطر»: القالب يزيل وحدة المفتاح كاملة
 * (PRINT_TEXT_LINE) على كل مستند، قياسياً كان أو مبسّطاً، ومن المرحلة الأولى أو الثانية؛ والإلزامي سابقاً تنبيهٌ في المحرّر لا منع.
 */
import { PHRASES } from '../../i18n/strings';
import {
  PRINT_STATUS_TITLE_KEYS, PRINT_TEXT_CATALOG, checkPrintTexts, isEmptyPrintTexts, printTextEntry, printTextWarning,
  type PrintSecondLang, type PrintTextEdit, type PrintTextEntry, type PrintTextWarning, type PrintTextsV1,
} from './printTextsCore';

export * from './printTextsCore';

type Tr = (ar: string) => string;

let warnedInvalid = false;

/** العمود خاماً ⇒ الإعداد الصالح أو null (نصوص اليوم): null أو عطب أو نسخة أحدث أو إعدادٌ بلا أثر */
export function normalizePrintTexts(raw: unknown): PrintTextsV1 | null {
  if (raw === null || raw === undefined) return null;
  const r = checkPrintTexts(raw, false);
  if (!r.ok) {
    if (!warnedInvalid) {
      warnedInvalid = true;
      console.warn('[print-texts] نصوص المطبوعات غير صالحة أو أحدث من هذه النسخة — تطبع النصوص الافتراضية', r.issues.slice(0, 3));
    }
    return null;
  }
  return isEmptyPrintTexts(r.value) ? null : r.value;
}

/**
 * ترجماتٌ للورقة أدقّ من قاموس الواجهة: عناوين المستند بحروفها الكبيرة، ومصطلح الفاتورة الضريبية «VAT No.» لا «Tax number»،
 * وما ترجمه القاموس حرفياً فلا يصلح سطراً مطبوعاً («Recipient signature rep»). تسبق القاموس في phraseIn.
 */
const PRINT_PHRASES: Readonly<Record<string, Partial<Record<PrintSecondLang, string>>>> = Object.freeze({
  'فاتورة': { en: 'Invoice', fr: 'Facture' },
  'فاتورة ضريبية': { en: 'Tax Invoice', fr: 'Facture fiscale' },
  'فاتورة ضريبية مبسطة': { en: 'Simplified Tax Invoice', fr: 'Facture fiscale simplifiée' },
  'إشعار دائن': { en: 'Credit Note', fr: 'Avoir', tr: 'Alacak Dekontu', zh: '贷项通知单' },
  'إشعار مدين': { en: 'Debit Note', fr: 'Note de débit', tr: 'Borç Dekontu', zh: '借项通知单' },
  'إشعار دائن مرتجع': { en: 'Credit Note (Return)', fr: 'Avoir (retour)', tr: 'İade Alacak Dekontu', zh: '退货贷项通知单' },
  // «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦): عنوان المرتجع المختوم بلا ضريبة (TAX_FREE_TITLES) — بحروفٍ كبيرة كـ«Invoice»، ولا
  // يرجع سطره الثاني إلى ترجمة «إشعار دائن مرتجع» (افتراضيّ inv.returnTitle) أبداً
  'فاتورة مرتجع': { en: 'Return Invoice', fr: 'Facture de retour', tr: 'İade Faturası', zh: '退货发票' },
  'إجمالي المرتجع دائن': { en: 'Total Return (Credit)', fr: 'Total du retour (avoir)' },
  'إجمالي المرتجع': { en: 'Total Return', fr: 'Total du retour' },
  'الرقم الضريبي': { en: 'VAT No.', fr: 'N° de TVA', tr: 'Vergi No', zh: '税号' },
  'ر.ضريبي': { en: 'VAT No.', fr: 'N° de TVA', tr: 'Vergi No', zh: '税号' },
  'رقم': { en: 'No.', fr: 'N°', tr: 'No', zh: '编号' },
  'الضريبة': { en: 'VAT', fr: 'TVA', tr: 'KDV', zh: '增值税' },
  'المندوب': { en: 'Sales Rep', fr: 'Représentant', tr: 'Temsilci', zh: '销售代表' },
  'المجموع قبل الضريبة': { en: 'Total excl. VAT', fr: 'Total HT', tr: 'KDV hariç toplam', zh: '不含税合计' },
  'توقيع المستلم المندوب': { en: 'Collector signature (rep)', fr: 'Signature du représentant encaisseur', tr: 'Tahsilatçı temsilci imzası', zh: '收款代表签名' },
  // مفاتيح طلب المالك ٣ نوفمبر ٢٠٢٦ (القالب ثنائي اللغة وسطر المنصّة) — نصوصٌ جديدة لا يمسّ أيٌّ منها ترجمةً قائمة
  'رقم الصنف': { en: 'Item Code', fr: 'Code article', tr: 'Ürün kodu', zh: '商品编码' },
  'بيانات البائع': { en: 'Seller', fr: 'Vendeur', tr: 'Satıcı', zh: '卖方' },
  'الرمز البريدي': { en: 'Postal Code', fr: 'Code postal', tr: 'Posta kodu', zh: '邮政编码' },
  'ملاحظات وتعليمات': { en: 'Instructions / Remarks', fr: 'Instructions / Remarques', tr: 'Talimatlar / Notlar', zh: '说明 / 备注' },
  'الإجمالي الخاضع للضريبة (غير شامل الضريبة)': {
    en: 'Total Taxable Amount (Excluding VAT)', fr: 'Montant total imposable (hors TVA)', tr: 'Vergiye tabi toplam tutar (KDV hariç)', zh: '应税总额（不含增值税）',
  },
  'إجمالي المبلغ المستحق': { en: 'Total Amount Due', fr: 'Montant total dû', tr: 'Ödenecek toplam tutar', zh: '应付总额' },
  'صدرت عبر منصة Field Sales · fieldsa.net': {
    en: 'Issued via Field Sales · fieldsa.net', fr: 'Émis via Field Sales · fieldsa.net', tr: 'Field Sales · fieldsa.net üzerinden düzenlendi', zh: '通过 Field Sales · fieldsa.net 开具',
  },
  // سطر الدولة في ترويسة القالب ثنائي اللغة بلغة الشركة الثانية (طلب المالك ٤ نوفمبر ٢٠٢٦) — الإنجليزية «Saudi Arabia» كما اليوم
  'المملكة العربية السعودية': { en: 'Saudi Arabia', fr: 'Arabie saoudite', tr: 'Suudi Arabistan', zh: '沙特阿拉伯' },
});

/**
 * ترجمة المفتاح لا النصّ — لمفاتيح جديدة يشترك نصّها العربيّ الافتراضي مع نصٍّ له ترجمةٌ أخرى قائمة («رقم» = No.، و«طريقة الدفع»
 * = Payment method): تُستعمل حين يُطبع افتراضي القائمة نفسه بلا صياغة، فلا تتغيّر ترجمةٌ يطبعها قالبٌ اليوم.
 */
const PRINT_KEY_PHRASES: Readonly<Record<string, Partial<Record<PrintSecondLang, string>>>> = Object.freeze({
  'col.seq': { en: 'Sr.', fr: 'N°', tr: 'Sıra', zh: '序号' },
  'inv.paymentType': { en: 'Payment Type Name', fr: 'Mode de paiement', tr: 'Ödeme türü', zh: '付款方式' },
  'sel.taxNumber': { en: 'VAT Number', fr: 'N° de TVA', tr: 'Vergi No', zh: '税号' },
});

/** ترجمة نصّ مفتاحٍ للورقة: ترجمة المفتاح متى كان النصّ افتراضيَّ القائمة نفسه، ثم phraseIn */
function keyPhraseIn(key: string, ar: string, lang: PrintSecondLang): string | null {
  const entry = printTextEntry(key);
  const own = entry && ar === entry.ar ? PRINT_KEY_PHRASES[key]?.[lang] : undefined;
  return own ?? phraseIn(ar, lang);
}

/** نصّ اللغة الثانية للورقة — ترجمة الطباعة ثم القاموس؛ null لنصٍّ خارجهما */
export function phraseIn(ar: string, lang: PrintSecondLang): string | null {
  const fix = PRINT_PHRASES[ar]?.[lang];
  if (fix) return fix;
  const p = PHRASES[ar];
  return p ? p[lang] ?? null : null;
}

/** معاينة المحرّر: النصوص المخفية تُرسم باهتةً مشطوبة (لا تختفي فيتعذّر إظهارها)، والنقر على نصٍّ يختاره */
export interface PrintTextsPreview {
  onPick: (key: string) => void;
  active: string | null;
}

export interface PrintTexts {
  /** للشركة نصوص محفوظة — false ⇒ كل دالّة أدناه تعيد سلوك اليوم حرفاً */
  on: boolean;
  /** مترجم القالب لما ليس في القائمة: لغة الواجهة كاليوم، أو الهويّة (العربية) للشركة ذات النصوص */
  tr: Tr;
  /** اللغة الثانية على الورقة أو null */
  lang: PrintSecondLang | null;
  /**
   * لغة العمود الثاني في القالب ثنائي اللغة: اللغة الثانية التي اختارتها الشركة، وإلا الإنجليزية — وبلا نصوص الإنجليزية كاليوم.
   * (طلب المالك ٤ نوفمبر ٢٠٢٦: شركةٌ اختارت الفرنسية أو التركية أو الصينية تُطبع تسمياتها بها لا بالإنجليزية)
   */
  gridLang: PrintSecondLang;
  /**
   * «حذف السطر»: true ⇒ القالب يزيل وحدة المفتاح كاملة (PRINT_TEXT_LINE: التسمية وقيمتها، العمود، صفّ الإجمالي، الصندوق…) —
   * لكل مفتاح وعلى كل مستند (طلب المالك ٣ نوفمبر ٢٠٢٦). false بلا نصوص وفي المعاينة (هناك hiddenInSettings).
   */
  hidden: (key: string) => boolean;
  /** السطر محذوفٌ في الإعداد (للمعاينة: يُرسم مشطوباً قابلاً للنقر لأن hidden يعيد false فيها) — أيّ مفتاح */
  hiddenInSettings: (key: string) => boolean;
  /** النصّ الأساسيّ: صياغة الشركة، وإلا الافتراضي (ar افتراضي القالب نفسه — «رقم» في الشريط و«رقم الفاتورة» في A4) — مترجماً كاليوم بلا نصوص */
  text: (key: string, ar: string) => string;
  /** سطر اللغة الثانية أو null — صياغة الشركة بها، وإلا ترجمة صياغتها العربية (أو الافتراضي) من القاموس، ولا يكرّر الأساسيّ */
  alt: (key: string, ar: string) => string | null;
  /** قيمةٌ ثابتة من القاموس (نقدي/آجل/تقسيط…) باللغة الثانية — لا تُعاد صياغتها */
  valueAlt: (ar: string, primary: string) => string | null;
  /**
   * تسمية العمود الثاني في القالب ثنائي اللغة بلغة `gridLang`: المحذوف null؛ ونصّ الشركة باللغة الثانية (أيّاً كانت)؛ وإلا ترجمة
   * صياغتها العربية وحدها (لا ترجمة الافتراضي القديم بجانب صياغةٍ جديدة)؛ وإلا ترجمة الافتراضي. بلا نصوص: ترجمة `ar` بالإنجليزية.
   */
  en: (key: string, ar: string) => string | null;
  /**
   * نصّ الشركة نفسه باللغة الثانية (edit.alt) لسطرٍ لا يُطبع سطره الثاني من القاموس (اسم الشركة في التذييل، تعليق الرمز المختوم،
   * سطر المنصّة، «#»…): null بلا نصوص أو بلا لغة ثانية أو للمحذوف — ولا ترجمة من القاموس.
   */
  ownAlt: (key: string) => string | null;
  /** تنبيه المحرّر للمفتاح (printTextWarning) أو null — لا يمنع شيئاً */
  warning: (key: string) => PrintTextWarning | null;
  /**
   * عنوان الفاتورة/المرتجع بصياغة الشركة — في المرحلتين (طلب المالك ٣ نوفمبر ٢٠٢٦)، ومنه ما حُفظ قبله: المرحلة لا تغيّر العنوان
   * (قرار المالك ٣ نوفمبر ٢٠٢٦ «طبّقها تلقائياً»؛ ورمز QR المرحلة الثانية يُطبع كاليوم). '' = حذفته الشركة. `decided` عنوان القرار
   * (عربي) — مترجماً بـtr كما اليوم للشركة بلا نصوص. inv.title يصوغ عناوين الفاتورة وinv.returnTitle عناوين الإشعار الدائن
   * وinv.debitTitle عنوان الإشعار المدين (طلب المالك ٤ نوفمبر ٢٠٢٦)، وعناوين الحالة في القرار بمفاتيحها (قرار المالك ٤ نوفمبر ٢٠٢٦):
   * inv.deliveryNoteTitle وinv.voidTitle وinv.pendingTitle — تُعاد صياغتها وتُحذف كغيرها. المفتاح من titleKeyOf.
   */
  title: (decided: string, f: { isReturn: boolean; phase2: boolean }) => { text: string; alt: string | null };
  companyNameAlt: string | null;
  companyAddressAlt: string | null;
  preview: PrintTextsPreview | null;
}

/** مترجم الشركة ذات النصوص: العربية كما هي */
const arabic: Tr = (ar) => ar;

const NO_EDIT: PrintTextEdit = Object.freeze({ text: null, alt: null, hidden: false });

/** ما يصوغه inv.title (عناوين الفاتورة) وinv.returnTitle (عناوين الإشعار الدائن) من عناوين القرار — والإشعار المدين inv.debitTitle، وعناوين الحالة بمفاتيحها (titleKeyOf) */
const INVOICE_TITLES: ReadonlySet<string> = new Set(['فاتورة ضريبية مبسطة', 'فاتورة ضريبية', 'فاتورة']);
// و«فاتورة مرتجع» (عنوان المرتجع المختوم بلا ضريبة — TAX_FREE_TITLES): صياغة الشركة لعنوان المرتجع تسري عليه كما تسري «فاتورة» بـinv.title
const RETURN_TITLES: ReadonlySet<string> = new Set(['إشعار دائن مرتجع', 'إشعار دائن', 'فاتورة مرتجع']);
/** عنوان الإشعار المدين في قرار المرحلة الثانية — يصوغه inv.debitTitle */
const DEBIT_TITLE = 'إشعار مدين';
/**
 * عناوين الحالة في قرار الطباعة (lib/zatca/docPrint.ts) ⇒ مفاتيحها: نصّ القائمة الافتراضي هو عنوان القرار نفسه حرفاً (يحرسه
 * printTexts.test.ts على zatcaPrintDecision) — قرار المالك ٤ نوفمبر ٢٠٢٦
 */
const STATUS_TITLE_KEY: ReadonlyMap<string, string> = new Map(
  PRINT_STATUS_TITLE_KEYS.map((k) => [(printTextEntry(k) as PrintTextEntry).ar, k] as const),
);

/**
 * مفتاح عنوان المستند لعنوان القرار (عربي): عنوان حالةٍ ⇒ مفتاحه (سند التسليم/الملغى/بانتظار الاعتماد) أيّاً كان المستند؛ وإلا
 * inv.returnTitle لعناوين الإشعار الدائن، وinv.debitTitle للإشعار المدين، وinv.title لعناوين الفاتورة — وnull لعنوانٍ خارجها (يُطبع
 * كما قرّره القرار). تسأله القوالب عن مفتاح النقر في المعاينة وسمة data-line.
 */
export function titleKeyOf(decided: string, isReturn: boolean): string | null {
  const status = STATUS_TITLE_KEY.get(decided);
  if (status) return status;
  if (isReturn) return RETURN_TITLES.has(decided) ? 'inv.returnTitle' : null;
  if (decided === DEBIT_TITLE) return 'inv.debitTitle';
  return INVOICE_TITLES.has(decided) ? 'inv.title' : null;
}

/** تنبيه المفتاح أو null لمفتاحٍ مجهول */
const warningOf = (key: string): PrintTextWarning | null => {
  const entry = printTextEntry(key);
  return entry ? printTextWarning(entry) : null;
};

/**
 * محلِّل نصوص مستندٍ واحد. `texts` = الإعداد المطبَّع (normalizePrintTexts) أو null. `standard` (الفاتورة قياسية B2B) باقٍ في
 * التوقيع للمستدعين ولا يغيّر شيئاً اليوم: الحذف يسري على القياسية أيضاً (والتنبيه في المحرّر).
 */
export function makePrintTexts(
  texts: PrintTextsV1 | null,
  tr: Tr,
  f: { standard: boolean; preview?: PrintTextsPreview | null } = { standard: false },
): PrintTexts {
  const preview = f.preview ?? null;
  if (!texts) {
    return {
      on: false, tr, lang: null, gridLang: 'en',
      hidden: () => false, hiddenInSettings: () => false,
      text: (_k, ar) => tr(ar),
      alt: () => null,
      valueAlt: () => null,
      en: (key, ar) => keyPhraseIn(key, ar, 'en'),
      ownAlt: () => null,
      warning: warningOf,
      title: (decided) => ({ text: tr(decided), alt: null }),
      companyNameAlt: null, companyAddressAlt: null,
      preview,
    };
  }
  const lang = texts.secondLang;
  const gridLang: PrintSecondLang = lang ?? 'en';
  const edit = (key: string): PrintTextEdit => (Object.prototype.hasOwnProperty.call(texts.edits, key) ? texts.edits[key] : NO_EDIT);
  const hiddenInSettings = (key: string): boolean => !!printTextEntry(key) && edit(key).hidden;
  const hidden = (key: string): boolean => !preview && hiddenInSettings(key);
  const altOf = (key: string, ar: string, primary: string): string | null => {
    if (!lang) return null;
    const e = edit(key);
    const entry = printTextEntry(key);
    const v = e.alt ?? (e.text !== null ? phraseIn(e.text, lang) : (keyPhraseIn(key, ar, lang) ?? (entry ? keyPhraseIn(key, entry.ar, lang) : null)));
    return v && v !== primary ? v : null;
  };
  const en = (key: string, ar: string): string | null => {
    if (hidden(key)) return null;
    const e = edit(key);
    // نصّ الشركة باللغة الثانية أيّاً كانت (C-G1)
    if (lang && e.alt !== null) return e.alt;
    // صياغةٌ عربية بلا نصٍّ ثانٍ: ترجمتها وحدها — لا ترجمة الافتراضي القديم بجانب الصياغة الجديدة (C-G2)
    if (e.text !== null) return phraseIn(e.text, gridLang);
    const entry = printTextEntry(key);
    return keyPhraseIn(key, ar, gridLang) ?? (entry ? keyPhraseIn(key, entry.ar, gridLang) : null);
  };
  const ownAlt = (key: string): string | null => (lang && !hidden(key) ? edit(key).alt : null);
  const text = (key: string, ar: string): string => edit(key).text ?? ar;
  return {
    on: true,
    tr: arabic,
    lang,
    gridLang,
    hidden,
    hiddenInSettings,
    text,
    alt: (key, ar) => altOf(key, ar, text(key, ar)),
    valueAlt: (ar, primary) => {
      if (!lang) return null;
      const v = phraseIn(ar, lang);
      return v && v !== primary ? v : null;
    },
    en,
    ownAlt,
    warning: warningOf,
    title: (decided, t) => {
      /* المفتاح: عنوان الإشعار المدين inv.debitTitle (C-G6)، وعناوين الحالة بمفاتيحها (قرار المالك ٤ نوفمبر ٢٠٢٦) — والحذف ''
       * فلا سطر عنوان. وعنوانٌ خارج القائمة ⇒ كما قرّره القرار */
      const key = titleKeyOf(decided, t.isReturn);
      if (key === null) {
        const v = lang ? phraseIn(decided, lang) : null;
        return { text: decided, alt: v && v !== decided ? v : null };
      }
      if (hidden(key)) return { text: '', alt: null };
      const primary = text(key, decided);
      const e = edit(key);
      /* ترجمةٌ كُتبت بلا صياغةٍ عربية تخصّ العنوان الذي تترجمه (entry.ar: «فاتورة ضريبية مبسطة») — فلا تُطبع تحت عنوان قرارٍ آخر
       * («فاتورة ضريبية» للقياسية أو «فاتورة» خارج السعودية): ذاك يُترجم من القاموس، وإلا وصفت الإنجليزيةُ فاتورةً قياسية بأنها مبسّطة */
      if (e.text === null && e.alt !== null && decided !== printTextEntry(key)?.ar) {
        const v = lang ? phraseIn(decided, lang) : null;
        return { text: primary, alt: v && v !== primary ? v : null };
      }
      return { text: primary, alt: altOf(key, decided, primary) };
    },
    companyNameAlt: lang ? texts.companyNameAlt : null,
    companyAddressAlt: lang ? texts.companyAddressAlt : null,
    preview,
  };
}

/** «حذف السطر» لمحلِّل مستند — للقوالب النصّية (thermal.ts) والـJSX سواء: = pt.hidden(key) */
export function isLineDeleted(pt: PrintTexts, key: string): boolean {
  return pt.hidden(key);
}

/** عدد التعديلات للبطاقة: نصوصٌ أعيدت صياغتها وأخرى حُذفت سطورها */
export function printTextsSummary(t: PrintTextsV1 | null): { reworded: number; hidden: number } {
  if (!t) return { reworded: 0, hidden: 0 };
  let reworded = 0;
  let hiddenCount = 0;
  for (const entry of PRINT_TEXT_CATALOG) {
    const e = t.edits[entry.key];
    if (!e) continue;
    if (e.hidden) hiddenCount++;
    // نصّ اللغة الثانية بلا لغةٍ ثانية لا يُطبع (isEmptyPrintTexts) فلا يُعدّ
    else if (e.text !== null || (e.alt !== null && t.secondLang !== null)) reworded++;
  }
  return { reworded, hidden: hiddenCount };
}

/** اسم اللغة الثانية كما يُعرض في المحرّر (باسمها الأصلي) */
export const SECOND_LANG_NAMES: Readonly<Record<PrintSecondLang, string>> = Object.freeze({
  en: 'English', fr: 'Français', tr: 'Türkçe', zh: '中文',
});
