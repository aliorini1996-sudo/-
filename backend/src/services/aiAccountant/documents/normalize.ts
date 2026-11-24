/**
 * «المحاسب الذكي AI» — مستندات المحادثة: توحيد ما يكتبه المستخدم في البطاقة أو يحمله رمز QR الزكوي (بلا ذكاء اصطناعي، D4).
 *
 * المبالغ: قواعد حارس المبلغ في posting.ts نفسها (normalizeAmountText: الأرقام الهندية والفارسية، «٫» عشرية، «٬» وفاصلة
 * الآلاف محذوفة) ثم تحليل عشري حرفي إلى ملّي BigInt بتقريب نصف-لأعلى لمنازل العملة (toMilli). الفرق عن parseAmountArg
 * (منسوخ القاعدة هنا لا مستورد): الصفر مقبول للضريبة (فاتورة معفاة)، وفاصلةٌ لا تفصل آلافاً («1.150,50» أو «12,5») تُرفض
 * ولا تُحذف — parseAmountArg يحذف كل فاصلة فيصير «1.150,50» = 1.15050 بصمت؛ المستند يُسأل عنه ولا يُخمَّن.
 * التواريخ ميلادية YYYY-MM-DD وحدها (سياسة التاريخ الميلادي): سنة 13xx–15xx أو علامة «هـ» ⇒ هجري يُحفظ كما كُتب ليمنعه
 * فحص HIJRI_DATE حتى يُصحَّح، لا يُحوَّل تخميناً.
 * النصوص: سطر واحد بلا محارف تحكّم ولا محارف اتجاه/عرض صفري (حقن الاتجاه في اسم مورد)، بحدّ طول.
 * ملف صِرف بلا قاعدة ولا شبكة.
 */
import { MAX_AMOUNT, cleanText, normalizeAmountText } from '../posting';
import { formatMilli, toMilli } from '../../gl/money';
import { daysInMonth, isLocalDate } from '../../gl/dates';
import type { Milli } from '../../gl/types';
import { currencyDecimalsOf } from '../../../config/countries';

/** حدود النصوص في الحقائق (العقد §7.1: ≤ 120 محرفاً، والسطور ≤ 80 وعددها ≤ 10) */
export const MAX_DOC_TEXT = 120;
export const MAX_LINE_TEXT = 80;
export const MAX_DOC_LINES = 10;
export const MAX_INVOICE_NO = 60;

/** أقصى مبلغ بالملّي (سقف posting.ts نفسه) */
const MAX_MILLI = BigInt(MAX_AMOUNT) * 1000n;

// ═══ الأرقام والنصوص ═══

const DIGITS: Readonly<Record<string, string>> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** الأرقام الهندية والفارسية ⇐ لاتينية (لا تمسّ الفواصل — للأرقام الضريبية والتواريخ ورقم الفاتورة) */
export function latinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => DIGITS[d] ?? d);
}

/** محارف الاتجاه والعرض الصفري (LRM/RLM/ALM، التضمين والعزل، ZWSP/ZWNJ/ZWJ، BOM) — تُزال من كل نص يُخزَّن */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_RE = /[​-‏‪-‮⁦-⁩﻿؜­]/g;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

/** نص حرّ للحقائق: سطر واحد منظّف بحدّ max — والفارغ null */
export function cleanDocText(v: unknown, max = MAX_DOC_TEXT): string | null {
  if (typeof v !== 'string') return null;
  const s = cleanText(stripInvisible(v), max);
  return s === '' ? null : s;
}

// ═══ المبالغ ═══

/** منازل عملة المستند: الصريحة إن مُرّرت، وإلا من رمز العملة (config/countries.ts) */
export function docDecimals(currency: string | null | undefined, explicit?: number | null): number {
  if (typeof explicit === 'number' && Number.isInteger(explicit) && explicit >= 0 && explicit <= 3) return explicit;
  return currencyDecimalsOf(currency ?? null);
}

/** رمز عملة أو اسمها الشائع حول المبلغ («SAR 1,150.00»، «1150 ر.س»، «ريال») — يُزال قبل التحليل */
const CURRENCY_PREFIX_RE = /^(?:[A-Za-z]{3}|SR|ر\.?\s?س\.?|ريال(?:\s*سعودي)?)\s*/;
const CURRENCY_SUFFIX_RE = /\s*(?:[A-Za-z]{3}|SR|ر\.?\s?س\.?|ريال(?:\s*سعودي)?)$/;

/**
 * مبلغ من المستخدم أو من QR ⇐ ملّي مقرَّب لمنازل العملة نصف-لأعلى، أو null إن لم يصلح (سالب، فاصلة ملتبسة، نص، فوق السقف).
 * allowZero: الضريبة والمبلغ قبل الضريبة قد يكونان صفراً؛ الإجمالي لا.
 */
export function parseDocAmount(v: unknown, decimals: number, opts: { allowZero?: boolean } = {}): Milli | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null;
    s = String(v);
  } else if (typeof v === 'string') {
    s = v;
  } else return null;
  s = normalizeAmountText(stripInvisible(s).trim()).replace(CURRENCY_PREFIX_RE, '').replace(CURRENCY_SUFFIX_RE, '').trim();
  // المسافة فاصلَ آلاف («1 150.00») وحدها — لا «12 5»
  s = s.replace(/(\d)[   ](?=\d{3}(?!\d))/g, '$1');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  let m: Milli;
  try {
    m = toMilli(s, decimals);
  } catch {
    return null;
  }
  if (m < 0n || m > MAX_MILLI) return null;
  if (m === 0n && !opts.allowZero) return null;
  return m;
}

/** ملّي ⇐ نص عشري بمنازل العملة بلا فواصل («1150.00») — صيغة الحقائق المخزّنة */
export function formatDocAmount(milli: Milli, decimals: number): string {
  return formatMilli(milli, decimals);
}

/** مبلغ مخزّن في الحقائق ⇐ ملّي (null للغائب أو التالف) */
export function factAmount(v: string | null | undefined, decimals: number): Milli | null {
  if (v === null || v === undefined || v === '') return null;
  return parseDocAmount(v, decimals, { allowZero: true });
}

// ═══ التواريخ ═══

export interface DocDate {
  /** YYYY-MM-DD (الهجري يُحفظ بصيغته ليُمنع بفحص HIJRI_DATE) أو null إن لم يُفهم */
  date: string | null;
  hijri: boolean;
}

const HIJRI_MARK_RE = /(?:هـ|ه|AH|A\.H\.?)$/i;
const GREG_MARK_RE = /(?:م|AD|A\.D\.?|G)$/i;

/** سنة هجرية لمستند معاصر (١٣٠٠ = ١٨٨٢م، ١٥٩٩ = ٢١٧٥م): لا يقع فيها تاريخ ميلادي صالح للدفاتر */
export function isHijriYear(y: number): boolean {
  return y >= 1300 && y <= 1599;
}

function hijriDate(y: number, m: number, d: number): DocDate {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 30)) return { date: null, hijri: true };
  return { date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, hijri: true };
}

/**
 * تاريخ يكتبه المستخدم ⇐ YYYY-MM-DD: «2026-11-10» أو «2026/11/10» أو «10/11/2026» (يوم/شهر/سنة كعادة المملكة) أو بأرقام
 * هندية، و«م» في آخره تُهمل. «هـ» أو سنة 13xx–15xx ⇒ hijri (يُحفظ ليُمنع). غير المفهوم ⇒ {date:null}.
 */
export function normalizeDocDate(v: unknown): DocDate {
  if (typeof v !== 'string') return { date: null, hijri: false };
  let s = latinDigits(stripInvisible(v)).trim().replace(/\s+/g, ' ');
  let hijriMark = false;
  if (HIJRI_MARK_RE.test(s)) { hijriMark = true; s = s.replace(HIJRI_MARK_RE, '').trim(); }
  else if (GREG_MARK_RE.test(s)) s = s.replace(GREG_MARK_RE, '').trim();
  let y: number, m: number, d: number;
  let mm: RegExpExecArray | null;
  if ((mm = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) { y = +mm[3]; m = +mm[2]; d = +mm[1]; }
  else return { date: null, hijri: hijriMark };
  if (hijriMark || isHijriYear(y)) return hijriDate(y, m, d);
  if (y < 1900 || y > 2100 || !(m >= 1 && m <= 12) || !(d >= 1 && d <= daysInMonth(y, m))) return { date: null, hijri: false };
  const out = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isLocalDate(out) ? { date: out, hijri: false } : { date: null, hijri: false };
}

/** تاريخ مخزّن في الحقائق هجري؟ (سنته 13xx–15xx) */
export function isHijriFactDate(v: string | null | undefined): boolean {
  if (!v) return false;
  const y = Number(v.slice(0, 4));
  return Number.isInteger(y) && isHijriYear(y);
}

// ═══ الأرقام الضريبية والعملة ورقم الفاتورة ═══

/** رقم ضريبي ⇐ أرقام لاتينية بلا مسافات وشرطات؛ null للفارغ، و'' (غير صالح) لما فيه غير الأرقام أو أطول من 20 */
export function normalizeVatNo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = latinDigits(stripInvisible(v)).replace(/[\s\-‐-―_.]/g, '');
  if (s === '') return null;
  return /^\d{1,20}$/.test(s) ? s : '';
}

/** رمز عملة ISO من ثلاثة أحرف («ر.س» و«ريال» و«SR» ⇒ SAR)؛ null للفارغ، و'' لغير المفهوم */
export function normalizeCurrencyCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = stripInvisible(v).trim();
  if (s === '') return null;
  if (/^(?:SR|ر\.?\s?س\.?|ريال(?:\s*سعودي)?)$/i.test(s)) return 'SAR';
  return /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : '';
}

/** رقم الفاتورة: نص قصير بأرقام لاتينية */
export function normalizeInvoiceNo(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return cleanDocText(latinDigits(v), MAX_INVOICE_NO);
}

/** مفتاح مقارنة لاسم أو رقم (مطابقة التكرار عند الترحيل): أرقام لاتينية، أحرف صغيرة، بلا مسافات وعلامات */
export function normKey(v: string | null | undefined): string {
  return latinDigits(stripInvisible(v ?? '')).toLowerCase().replace(/[\s\-_.,،/\\#:()]+/g, '');
}
