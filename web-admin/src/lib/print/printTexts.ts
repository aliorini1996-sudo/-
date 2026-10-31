/**
 * «نصوص المطبوعات» في الواجهة (طلب المالك ٣١ أكتوبر ٢٠٢٦) — القراءة المتسامحة لعمود الشركة، والمحلِّل الذي تسأله القوالب
 * (A4 والحرارية والنقطية) عن كل نصّ: ماذا يُطبع بالعربية، وما سطره باللغة الثانية، وهل يُخفى على هذا المستند.
 *
 * القاعدة الأولى: شركةٌ بلا نصوص (null أو عطب أو نسخة أحدث) ⇒ `on: false` والمحلِّل يعيد `tr(ar)` حرفاً بحرف ولا يخفي شيئاً —
 * والقوالب لا تغيّر في ورقتها حرفاً واحداً (الحارس الذهبيّ للشريط 58 مم وحرّاس printTexts.test.ts).
 *
 * والثانية: شركةٌ لها نصوص تطبع فاتورتها وسندها **بالعربية أولاً** أيّاً كانت لغة واجهة الجهاز، ومعها اللغة الثانية إن اختارتها —
 * العربية إلزامية في الفاتورة الضريبية واللغة الأخرى ترجمةٌ بجانبها (اللائحة التنفيذية م٦٦). فـ`tr` في المحلِّل هويّة حينها.
 */
import { PHRASES } from '../../i18n/strings';
import {
  PRINT_TEXT_CATALOG, checkPrintTexts, isEmptyPrintTexts, printTextEntry, printTextHideable,
  type PrintSecondLang, type PrintTextEdit, type PrintTextsV1,
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
  'إجمالي المرتجع دائن': { en: 'Total Return (Credit)', fr: 'Total du retour (avoir)' },
  'إجمالي المرتجع': { en: 'Total Return', fr: 'Total du retour' },
  'الرقم الضريبي': { en: 'VAT No.', fr: 'N° de TVA', tr: 'Vergi No', zh: '税号' },
  'ر.ضريبي': { en: 'VAT No.', fr: 'N° de TVA', tr: 'Vergi No', zh: '税号' },
  'رقم': { en: 'No.', fr: 'N°', tr: 'No', zh: '编号' },
  'الضريبة': { en: 'VAT', fr: 'TVA', tr: 'KDV', zh: '增值税' },
  'المندوب': { en: 'Sales Rep', fr: 'Représentant', tr: 'Temsilci', zh: '销售代表' },
  'المجموع قبل الضريبة': { en: 'Total excl. VAT', fr: 'Total HT', tr: 'KDV hariç toplam', zh: '不含税合计' },
  'توقيع المستلم المندوب': { en: 'Collector signature (rep)', fr: 'Signature du représentant encaisseur', tr: 'Tahsilatçı temsilci imzası', zh: '收款代表签名' },
});

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
  /** يُخفى النصّ (وصفّه) على هذا المستند — الإلزامي لا يُخفى مهما حُفظ، و«القياسي» يبقى على الفاتورة القياسية */
  hidden: (key: string) => boolean;
  /** النصّ مخفيٌّ في الإعداد (للمعاينة: يُرسم مشطوباً لأن hidden يعيد false فيها) */
  hiddenInSettings: (key: string) => boolean;
  /** النصّ الأساسيّ: صياغة الشركة، وإلا الافتراضي (ar افتراضي القالب نفسه — «رقم» في الشريط و«رقم الفاتورة» في A4) — مترجماً كاليوم بلا نصوص */
  text: (key: string, ar: string) => string;
  /** سطر اللغة الثانية أو null — صياغة الشركة بها، وإلا ترجمة صياغتها العربية (أو الافتراضي) من القاموس، ولا يكرّر الأساسيّ */
  alt: (key: string, ar: string) => string | null;
  /** قيمةٌ ثابتة من القاموس (نقدي/آجل/تقسيط…) باللغة الثانية — لا تُعاد صياغتها */
  valueAlt: (ar: string, primary: string) => string | null;
  /**
   * عنوان الفاتورة/المرتجع: صياغة الشركة لمستندات المرحلة الأولى وحدها — المختوم (phase2) يطبع عنوان قرار الطباعة كما هو.
   * '' = أخفته الشركة. `decided` عنوان القرار (عربي) — مترجماً بـtr كما اليوم للشركة بلا نصوص.
   */
  title: (decided: string, f: { isReturn: boolean; phase2: boolean }) => { text: string; alt: string | null };
  companyNameAlt: string | null;
  companyAddressAlt: string | null;
  preview: PrintTextsPreview | null;
}

/** مترجم الشركة ذات النصوص: العربية كما هي */
const arabic: Tr = (ar) => ar;

const NO_EDIT: PrintTextEdit = Object.freeze({ text: null, alt: null, hidden: false });

/**
 * محلِّل نصوص مستندٍ واحد. `standard` = الفاتورة قياسية (B2B — من قرار الطباعة لا من التخمين) فيبقى ما قفله «القياسي».
 * `texts` = الإعداد المطبَّع (normalizePrintTexts) أو null.
 */
export function makePrintTexts(
  texts: PrintTextsV1 | null,
  tr: Tr,
  f: { standard: boolean; preview?: PrintTextsPreview | null } = { standard: false },
): PrintTexts {
  const preview = f.preview ?? null;
  if (!texts) {
    return {
      on: false, tr, lang: null,
      hidden: () => false, hiddenInSettings: () => false,
      text: (_k, ar) => tr(ar),
      alt: () => null,
      valueAlt: () => null,
      title: (decided) => ({ text: tr(decided), alt: null }),
      companyNameAlt: null, companyAddressAlt: null,
      preview,
    };
  }
  const lang = texts.secondLang;
  const edit = (key: string): PrintTextEdit => (Object.prototype.hasOwnProperty.call(texts.edits, key) ? texts.edits[key] : NO_EDIT);
  const hiddenInSettings = (key: string): boolean => {
    const entry = printTextEntry(key);
    return !!entry && printTextHideable(entry) && edit(key).hidden;
  };
  const hidden = (key: string): boolean => {
    if (preview || !hiddenInSettings(key)) return false;
    return !(printTextEntry(key)?.lock === 'standard' && f.standard);
  };
  const altOf = (key: string, ar: string, primary: string): string | null => {
    if (!lang) return null;
    const e = edit(key);
    const entry = printTextEntry(key);
    const v = e.alt ?? (e.text !== null ? phraseIn(e.text, lang) : (phraseIn(ar, lang) ?? (entry ? phraseIn(entry.ar, lang) : null)));
    return v && v !== primary ? v : null;
  };
  const text = (key: string, ar: string): string => edit(key).text ?? ar;
  return {
    on: true,
    tr: arabic,
    lang,
    hidden,
    hiddenInSettings,
    text,
    alt: (key, ar) => altOf(key, ar, text(key, ar)),
    valueAlt: (ar, primary) => {
      if (!lang) return null;
      const v = phraseIn(ar, lang);
      return v && v !== primary ? v : null;
    },
    title: (decided, t) => {
      if (t.phase2) {
        const v = lang ? phraseIn(decided, lang) : null;
        return { text: decided, alt: v && v !== decided ? v : null };
      }
      const key = t.isReturn ? 'inv.returnTitle' : 'inv.title';
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

/** عدد التعديلات للبطاقة: نصوصٌ أعيدت صياغتها وأخرى أُخفيت */
export function printTextsSummary(t: PrintTextsV1 | null): { reworded: number; hidden: number } {
  if (!t) return { reworded: 0, hidden: 0 };
  let reworded = 0;
  let hiddenCount = 0;
  for (const entry of PRINT_TEXT_CATALOG) {
    const e = t.edits[entry.key];
    if (!e) continue;
    if (e.hidden && printTextHideable(entry)) hiddenCount++;
    // نصّ اللغة الثانية بلا لغةٍ ثانية لا يُطبع (isEmptyPrintTexts) فلا يُعدّ
    else if (e.text !== null || (e.alt !== null && t.secondLang !== null)) reworded++;
  }
  return { reworded, hidden: hiddenCount };
}

/** اسم اللغة الثانية كما يُعرض في المحرّر (باسمها الأصلي) */
export const SECOND_LANG_NAMES: Readonly<Record<PrintSecondLang, string>> = Object.freeze({
  en: 'English', fr: 'Français', tr: 'Türkçe', zh: '中文',
});
