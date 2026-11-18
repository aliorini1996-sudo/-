/**
 * «المحاسب الذكي AI» — مستندات المحادثة: الفحوص الآلية على الحقائق (جدول §5.1 بعد D4: بلا فحوص الذكاء الاصطناعي).
 *
 * block يمنع «سجّل القيد» حتى يُصحَّح، وwarn يظهر كهرماناً ويُسمح بالترحيل معه. الترتيب ثابت (ترتيب الجدول) لعرضٍ مستقرّ:
 *   TOTAL_MISSING (block؛ لعقد الإيجار NOT_A_PAYMENT block: «كم دُفع ومن أي حساب؟» — العقد وحده ليس دفعاً، D2)
 *   DATE_MISSING (block) · SUM_MISMATCH (block: قبل الضريبة + الضريبة ≠ الإجمالي بأكثر من 0.01، أو ضريبة/وعاء فوق الإجمالي)
 *   VAT_RATE_ODD (warn: الضريبة ليست ≈15٪ ولا ≈5٪ من الوعاء) · VAT_NO_TAX_NUMBER (warn ⇒ NON_DEDUCTIBLE، D7)
 *   VAT_BLOCKED_CATEGORY (warn: ضيافة/سكن موظفين، أو عقد إيجار بلا فاتورة ضريبية ⇒ NON_DEDUCTIBLE)
 *   VAT_NO_BOX (warn: دليل بلا مربّع ضريبة ⇒ لا فصل) · BUYER_OTHER (warn: رقم المشتري الضريبي ليس رقم الشركة)
 *   CURRENCY_MISMATCH (block) · DATE_FUTURE (block) · DATE_TOO_OLD (warn: أقدم من سنة — القيد يُرفض بتاريخه فيُقترح اليوم)
 *   HIJRI_DATE (block: الميلادي وحده) · QR_MISMATCH (block: ما عدّله المستخدم يناقض QR متحقَّقاً منه: الإجمالي والضريبة
 *   والرقم الضريبي للمورد) · QR_INVALID (warn) · MONTHS_INVALID (block: أشهر الإطفاء خارج 1..24 أو مطلوبة غائبة)
 *   NEEDS_DEPRECIATION (warn: الأصل «يحتاج إهلاكاً يسجّله المحاسب»، D3).
 * فحوص الضريبة لا تُجرى لشركة أزالت الضريبة (taxOff)، ولا حين لا يُعرف وضعها (taxOff غائب — حقائق QR قبل recheck).
 * DUPLICATE_SUSPECT يحسبه الترحيل تحت القفل (الحزمة P3)، وFILE_GONE المخزن (P1) — لا هنا.
 * DATE_FUTURE وDATE_TOO_OLD نسبيّان لليوم: يُخزَّنان مع غيرهما لكنهما **مشتقّان عند كل عرض** (refreshDateChecks بيوم الشركة
 * الحالي في docViewsFor) ولا يمنعان الترحيل من المخزَّن (postingDateProblem في الخطة يحكم التاريخ تحت القفل) — فاتورةٌ
 * مؤرّخة غداً رُفعت اليوم لا تبقى «مانعة» بعد أن يحلّ تاريخها.
 * ملف صِرف بلا قاعدة ولا شبكة.
 */
import { MAX_BACKDATE_DAYS } from '../posting';
import { addDays, compareLocalDate, isLocalDate } from '../../gl/dates';
import { taxOnBase } from '../../gl/draft';
import { unitMilli } from '../../gl/money';
import type { Milli } from '../../gl/types';
import {
  ACCT_PREPAID_MAX_MONTHS, VENDOR_VAT_RE, type AcctDocCheck, type AcctDocFacts, type AcctDocStatus, type AcctDocSuggestion,
} from './types';
import { factAmount, formatDocAmount, isHijriFactDate, normalizeVatNo } from './normalize';
import { readZatcaQr } from './qr';
import { VAT_BLOCKED_ACCOUNTS, factsDecimals, paidMonths } from './suggest';

/** فرق «قبل الضريبة + الضريبة ≠ الإجمالي» المسموح: 0.01 (ملّي) */
export const SUM_TOLERANCE_MILLI = 10n;

/** نسب الضريبة المعتادة في المملكة: الأساسية 15٪، و5٪ (السابقة/المخفّضة) */
export const USUAL_VAT_RATES: readonly number[] = [15, 5];

export interface DocCheckInput {
  /** عملة الشركة */
  currency: string;
  currencyDecimals?: number | null;
  /** اليوم المحلي بتوقيت الشركة YYYY-MM-DD */
  todayLocal: string;
  /** الرقم الضريبي للشركة (BUYER_OTHER) */
  tenantVat: string | null;
  /** الشركة أزالت الضريبة؛ الغياب ⇒ لا فحوص ضريبة (غير معروف بعد) */
  taxOff?: boolean;
  /** دليل فيه مربّع ضريبة المدخلات (الافتراضي true) */
  vatBox?: boolean;
  /** QR فُكّ وتحقّق عند الرفع */
  qrVerified: boolean;
  /** نصّ QR المخزَّن (لإعادة المقارنة بعد تصحيح المستخدم، ولإبقاء QR_INVALID) */
  qrRaw?: string | null;
  /** منطقة الشركة (لتاريخ الختم الزمني — لا يُقارن هنا، لكن فكّ QR يحتاجه) */
  tz?: string;
  /** PDF ⇒ لا QR يُقرأ منه (الإصدار الأول: إدخال يدوي) */
  mimeType?: string;
  /** الاقتراح (للضريبة المحجوبة بالحساب، والأشهر المطلوبة، والإهلاك) */
  suggestion?: AcctDocSuggestion | null;
  /** حساب الإطفاء للمدفوع مقدماً (ضريبة سكن الموظفين محجوبة ولو كان الحساب 115002) */
  amortizationCode?: string | null;
}

const check = (
  code: AcctDocCheck['code'], severity: AcctDocCheck['severity'], field?: AcctDocCheck['field'], details?: Record<string, string>,
): AcctDocCheck => ({ code, severity, ...(field ? { field } : {}), ...(details ? { details } : {}) });

const absMilli = (v: Milli): Milli => (v < 0n ? -v : v);

// ═══ فحوص التاريخ النسبية لليوم (مشتقّة عند العرض) ═══

/** فحوصٌ تتغيّر بمرور الأيام وحده: لا تُقرأ من المخزَّن بل تُعاد بيوم الشركة الحالي */
export const DATE_RELATIVE_CHECKS: readonly AcctDocCheck['code'][] = ['DATE_FUTURE', 'DATE_TOO_OLD'];

export const isDateRelativeCheck = (c: Pick<AcctDocCheck, 'code'>): boolean => DATE_RELATIVE_CHECKS.includes(c.code);

/**
 * تاريخ المستند (ميلادي صالح) مقابل اليوم المحلي: بعده ⇒ DATE_FUTURE (مانع)، وأقدم من MAX_BACKDATE_DAYS ⇒ DATE_TOO_OLD
 * (منبّه: القيد يُرفض بتاريخه فيُقترح اليوم). الهجري والتالف واليوم غير الصالح ⇒ لا شيء (لها فحوصها).
 */
export function dateRelativeChecks(issueDate: string | null | undefined, todayLocal: string): AcctDocCheck[] {
  if (!issueDate || isHijriFactDate(issueDate) || !isLocalDate(issueDate) || !isLocalDate(todayLocal)) return [];
  if (compareLocalDate(issueDate, todayLocal) > 0) return [check('DATE_FUTURE', 'block', 'issueDate', { date: issueDate, today: todayLocal })];
  const oldest = addDays(todayLocal, -MAX_BACKDATE_DAYS);
  if (compareLocalDate(issueDate, oldest) < 0) return [check('DATE_TOO_OLD', 'warn', 'issueDate', { date: issueDate, oldest })];
  return [];
}

/** ما يلي فحوص التاريخ في ترتيب الجدول — الجديد يُدرج قبل أوّلها حين لم يكن له مكانٌ مخزَّن */
const AFTER_DATE_CHECKS: readonly AcctDocCheck['code'][] = ['HIJRI_DATE', 'QR_MISMATCH', 'QR_INVALID', 'MONTHS_INVALID', 'NEEDS_DEPRECIATION'];

/**
 * الفحوص المخزّنة بفحوص التاريخ النسبية محسوبةً من جديد بيوم الشركة الحالي (في مكانها من الترتيب الثابت). changed ⇒ تغيّر
 * شيء عن المخزَّن (فتُشتق الحالة من جديد: refreshedStatus).
 */
export function refreshDateChecks(
  stored: readonly AcctDocCheck[], facts: Pick<AcctDocFacts, 'issueDate'> | null, todayLocal: string,
): { checks: AcctDocCheck[]; changed: boolean } {
  if (!isLocalDate(todayLocal)) return { checks: [...stored], changed: false };
  const fresh = facts ? dateRelativeChecks(facts.issueDate, todayLocal) : [];
  const old = stored.filter(isDateRelativeCheck);
  const same = old.length === fresh.length && old.every((c, i) => c.code === fresh[i].code
    && JSON.stringify(c.details ?? {}) === JSON.stringify(fresh[i].details ?? {}));
  if (same) return { checks: [...stored], changed: false };
  const at = stored.findIndex(isDateRelativeCheck);
  const rest = stored.filter((c) => !isDateRelativeCheck(c));
  let pos = at >= 0 ? stored.slice(0, at).filter((c) => !isDateRelativeCheck(c)).length : rest.findIndex((c) => AFTER_DATE_CHECKS.includes(c.code));
  if (pos < 0) pos = rest.length;
  return { checks: [...rest.slice(0, pos), ...fresh, ...rest.slice(pos)], changed: true };
}

/**
 * حالة العرض بعد تحديث فحوص التاريخ (حكم recheck نفسه): المرفوع والفاشل كما هما؛ وغيرهما NEEDS_REVIEW إن بقي فحص أو لا
 * حقائق أو مانع معالجة (بضاعة/أرض ومبنى — بلا فحص)، وإلا EXTRACTED.
 */
export function refreshedStatus(stored: AcctDocStatus, checks: readonly AcctDocCheck[], facts: AcctDocFacts | null): AcctDocStatus {
  if (stored === 'UPLOADED' || stored === 'FAILED') return stored;
  const blocked = !!facts && (facts.categoryHint === 'inventory_goods' || facts.assetClassHint === 'land_buildings');
  return checks.length > 0 || !facts || blocked ? 'NEEDS_REVIEW' : 'EXTRACTED';
}

/** الضريبة قريبة من نسبة على الوعاء؟ (هامش: وحدة عملة أو 0.5٪ من الضريبة المتوقعة — تقريب السطور في الفواتير الطويلة) */
function nearRate(base: Milli, vat: Milli, rate: number, decimals: number): boolean {
  const expected = taxOnBase(base, rate, decimals);
  const unit = unitMilli(decimals);
  const rel = (expected * 5n) / 1000n;
  const tol = rel > unit ? rel : unit;
  return absMilli(vat - expected) <= tol;
}

/** نسبة الضريبة إلى الوعاء نصاً بمنزلتين (للتفاصيل) */
function ratePct(base: Milli, vat: Milli): string {
  if (base <= 0n) return '';
  const bp = (vat * 1_000_000n) / base; // جزء من مليون
  return (Number(bp) / 10_000).toFixed(2);
}

/**
 * فحوص الحقائق. facts فارغة (إدخال يدوي لم يبدأ) ⇒ TOTAL_MISSING وDATE_MISSING (و QR_INVALID إن وصل QR تالف).
 */
export function docChecks(facts: AcctDocFacts, input: DocCheckInput): AcctDocCheck[] {
  const out: AcctDocCheck[] = [];
  const dec = factsDecimals(facts, input);
  const total = factAmount(facts.total, dec);
  const vat = factAmount(facts.vatAmount, dec);
  const sub = factAmount(facts.subtotal, dec);
  const isLease = facts.docType === 'LEASE_CONTRACT';
  const vatKnown = typeof input.taxOff === 'boolean';
  const taxOn = vatKnown && input.taxOff === false;
  const vatBox = input.vatBox !== false;

  // ── الإجمالي والتاريخ ──
  if (total === null || total <= 0n) {
    out.push(isLease ? check('NOT_A_PAYMENT', 'block', 'total') : check('TOTAL_MISSING', 'block', 'total'));
  }
  if (!facts.issueDate) out.push(check('DATE_MISSING', 'block', 'issueDate'));

  // ── الاتّساق الحسابي ──
  if (total !== null) {
    if (vat !== null && vat > total) {
      out.push(check('SUM_MISMATCH', 'block', 'vatAmount', { vatAmount: formatDocAmount(vat, dec), total: formatDocAmount(total, dec) }));
    } else if (sub !== null && vat !== null && absMilli(sub + vat - total) > SUM_TOLERANCE_MILLI) {
      out.push(check('SUM_MISMATCH', 'block', 'total', {
        subtotal: formatDocAmount(sub, dec), vatAmount: formatDocAmount(vat, dec), total: formatDocAmount(total, dec),
        diff: formatDocAmount(absMilli(sub + vat - total), dec),
      }));
    } else if (sub !== null && vat === null && sub > total) {
      out.push(check('SUM_MISMATCH', 'block', 'subtotal', { subtotal: formatDocAmount(sub, dec), total: formatDocAmount(total, dec) }));
    }
  }

  // ── الضريبة (D7) ──
  if (taxOn && vat !== null && vat > 0n) {
    if (vatBox) {
      const base = sub ?? (total !== null && total > vat ? total - vat : null);
      if (base !== null && base > 0n && !USUAL_VAT_RATES.some((r) => nearRate(base, vat, r, dec))) {
        out.push(check('VAT_RATE_ODD', 'warn', 'vatAmount', { ratePct: ratePct(base, vat) }));
      }
      if (!isLease && !VENDOR_VAT_RE.test(facts.vendorVat ?? '')) {
        out.push(check('VAT_NO_TAX_NUMBER', 'warn', 'vendorVat'));
      }
      if (isLease) {
        out.push(check('VAT_BLOCKED_CATEGORY', 'warn', 'docType', { reason: 'NO_TAX_INVOICE' }));
      } else if (input.suggestion) {
        // الحساب المحجوب: للمدفوع مقدماً حساب إطفائه (سكن الموظفين)، وإلا الحساب المقترح (الضيافة)
        const code = input.suggestion.treatment === 'PREPAID' && input.amortizationCode ? input.amortizationCode : input.suggestion.accountCode;
        const blocked = VAT_BLOCKED_ACCOUNTS[code];
        if (blocked) out.push(check('VAT_BLOCKED_CATEGORY', 'warn', 'categoryHint', { accountCode: code, reason: blocked }));
      }
    } else {
      out.push(check('VAT_NO_BOX', 'warn', 'vatAmount'));
    }
  }

  // ── المشتري ──
  const buyerVat = normalizeVatNo(facts.buyerVat ?? '');
  const tenantVat = normalizeVatNo(input.tenantVat ?? '');
  if (buyerVat && tenantVat && buyerVat !== tenantVat) out.push(check('BUYER_OTHER', 'warn', 'buyerVat'));

  // ── العملة ──
  if (facts.currency && input.currency && facts.currency.toUpperCase() !== input.currency.toUpperCase()) {
    out.push(check('CURRENCY_MISMATCH', 'block', 'currency', { currency: facts.currency, companyCurrency: input.currency.toUpperCase() }));
  }

  // ── التاريخ ──
  const dateIssues: AcctDocCheck[] = [];
  if (facts.issueDate) {
    if (isHijriFactDate(facts.issueDate)) {
      dateIssues.push(check('HIJRI_DATE', 'block', 'issueDate', { date: facts.issueDate }));
    } else if (!isLocalDate(facts.issueDate)) {
      out.push(check('DATE_MISSING', 'block', 'issueDate'));
    } else {
      out.push(...dateRelativeChecks(facts.issueDate, input.todayLocal));
    }
  }
  for (const f of ['periodFrom', 'periodTo'] as const) {
    const v = facts[f];
    if (v && isHijriFactDate(v)) dateIssues.push(check('HIJRI_DATE', 'block', f, { date: v }));
  }
  out.push(...dateIssues);

  // ── QR ──
  const pdf = /pdf/i.test(input.mimeType ?? '');
  if (!pdf && input.qrRaw) {
    const qr = readZatcaQr(input.qrRaw, { tz: input.tz ?? 'Asia/Riyadh', decimals: dec });
    if (!qr.ok) {
      out.push(check('QR_INVALID', 'warn'));
    } else if (input.qrVerified) {
      const fields: string[] = [];
      const factVat = normalizeVatNo(facts.vendorVat ?? '');
      if ((qr.qr.vatNo ?? '') !== (factVat ?? '')) fields.push('vendorVat');
      // مبالغ QR بعملة الفاتورة (ريال في الغالب): عملةٌ أخرى صرّح بها المستخدم تعني تحويلاً — لا مقارنة مبالغ
      if ((facts.currency ?? 'SAR').toUpperCase() === 'SAR') {
        const unit = unitMilli(dec);
        if (total === null || absMilli(total - qr.qr.totalMilli) > unit) fields.push('total');
        if (vat === null || absMilli(vat - qr.qr.vatMilli) > unit) fields.push('vatAmount');
      }
      if (fields.length) {
        out.push(check('QR_MISMATCH', 'block', fields[0] as keyof AcctDocFacts, {
          fields: fields.join(','),
          qrTotal: formatDocAmount(qr.qr.totalMilli, dec),
          qrVatAmount: formatDocAmount(qr.qr.vatMilli, dec),
        }));
      }
    }
  }

  // ── أشهر الإطفاء (D2) ──
  const months = paidMonths(facts);
  if (months !== null && (!Number.isInteger(months) || months < 1 || months > ACCT_PREPAID_MAX_MONTHS)) {
    out.push(check('MONTHS_INVALID', 'block', 'months', {
      months: String(months), max: String(ACCT_PREPAID_MAX_MONTHS), reason: months > ACCT_PREPAID_MAX_MONTHS ? 'REFERRED' : 'RANGE',
    }));
  } else if (input.suggestion?.treatment === 'PREPAID' && input.suggestion.months === null) {
    out.push(check('MONTHS_INVALID', 'block', 'months', { max: String(ACCT_PREPAID_MAX_MONTHS), reason: 'MISSING' }));
  }

  // ── الأصل (D3) ──
  if (input.suggestion?.treatment === 'ASSET') {
    out.push(check('NEEDS_DEPRECIATION', 'warn', 'assetClassHint', { accountCode: input.suggestion.accountCode }));
  }
  return out;
}

/** أيّ فحص مانع؟ */
export function hasBlockingCheck(checks: readonly AcctDocCheck[]): boolean {
  return checks.some((c) => c.severity === 'block');
}
