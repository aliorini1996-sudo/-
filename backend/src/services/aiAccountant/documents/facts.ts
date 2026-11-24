/**
 * «المحاسب الذكي AI» — مستندات المحادثة: خدمة الحقائق الحتمية (الحزمة P2 — لا ذكاء اصطناعي، D4).
 *
 * مصدران فقط للحقائق: رمز QR الزكوي (factsFromQr: يُفكّ في الجهاز ويُتحقَّق منه هنا) وإدخال المستخدم في البطاقة
 * (applyUserPatch). بعد كل تغيير يُعاد الفحص (recheck) فتُحسب الفحوص والحالة والاقتراح من الحقائق وحدها:
 *   - الحالة: UPLOADED قبل أي حقائق (ولا إدخال يدوي)، EXTRACTED بلا أي فحص ولا مانع معالجة، وإلا NEEDS_REVIEW
 *     (ومنها بلا QR: إدخال يدوي يبدأ بـTOTAL_MISSING وDATE_MISSING). FAILED لا تصدر من هنا (المخزن: الملف مفقود).
 *   - الاقتراح: suggest.ts (حساب ومعالجة ووضع ضريبة وأشهر) — والخيارات من دليل الشركة بـsuggestFor.
 * نموذج المحادثة يقرأ هذه الحقائق فقط (document_facts) ولا يكتبها ولا يختار مبلغاً أو حساباً أو مصدر دفع.
 * ملف صِرف بلا قاعدة ولا شبكة: المحمِّل (store/view) يقرأ الصفّ والدليل ويمرّرهما.
 */
import { EXPENSE_CATEGORY_KEYS } from '../posting';
import { compareLocalDate, isLocalDate } from '../../gl/dates';
import type { Milli } from '../../gl/types';
import {
  ACCT_ASSET_CLASSES, ACCT_DOC_EXTRA_CATEGORIES, ACCT_DOC_TYPES, emptyFacts,
  type AcctAssetClass, type AcctDocCheck, type AcctDocEnv, type AcctDocFacts, type AcctDocPatch, type AcctDocRecheck,
  type AcctDocStatus, type AcctDocType, type AcctFactsSource, type AcctPaymentHint,
} from './types';
import {
  cleanDocText, factAmount, formatDocAmount, latinDigits, normalizeCurrencyCode, normalizeDocDate, normalizeInvoiceNo, normalizeVatNo,
  parseDocAmount,
} from './normalize';
import { readZatcaQr } from './qr';
import { docChecks } from './checks';
import { factsDecimals, suggestCore, suggestFor, type ChartAccountLike, type DocSuggestResult, type SuggestOpts } from './suggest';

export { suggestFor } from './suggest';
export type { ChartAccountLike, DocSuggestResult, SuggestOpts } from './suggest';

// ═══ رمز QR ═══

export interface QrFactsCtx {
  /** منطقة الشركة (الختم الزمني ⇐ تاريخ ميلادي) */
  tz: string;
  todayLocal: string;
  /** عملة الشركة */
  currency: string;
  /** الرقم الضريبي للشركة (BUYER_OTHER) — companyVat مرادفه في AcctDocEnv */
  tenantVat?: string | null;
  companyVat?: string | null;
  /** اختيارية: إن عُرفت تُجرى فحوص الضريبة أيضاً (وإلا يكملها recheck) — taxDisabled مرادفها في AcctDocEnv */
  taxOff?: boolean;
  taxDisabled?: boolean;
  vatBox?: boolean;
}

/**
 * حقائق المستند من رمز QR الزكوي (base64 من الترويسة X-Zatca-Qr):
 *   - صالح ⇒ البائع ورقمه الضريبي وتاريخ الفاتورة (ميلادي بمنطقة الشركة) والإجمالي والضريبة والوعاء (الإجمالي − الضريبة)،
 *     ونوع المستند (الوسم 9 ⇒ مبسّطة، وإلا ضريبية — يغيّره المستخدم بالشرائح)؛ qrVerified = true.
 *   - تالف ⇒ حقائق فارغة للإدخال اليدوي وQR_INVALID تنبيهاً؛ qrVerified = false.
 * العملة 'SAR': رمز QR الزكوي فاتورة سعودية بالريال — شركةٌ بعملة أخرى يمنعها CURRENCY_MISMATCH حتى تصحّح المبالغ.
 * checks: فحوص لا تحتاج إعداد الضريبة (التاريخ والعملة والـQR) ما لم يُمرَّر taxOff — والكامل من recheck (مع qrRaw).
 */
export function factsFromQr(
  qrBase64: string, ctx: QrFactsCtx,
): { facts: AcctDocFacts; qrVerified: boolean; checks: AcctDocCheck[] } {
  const decimals = factsDecimals({ currency: 'SAR' }, { currency: ctx.currency });
  const qr = readZatcaQr(qrBase64, { tz: ctx.tz, decimals });
  const taxOff = typeof ctx.taxOff === 'boolean' ? ctx.taxOff : typeof ctx.taxDisabled === 'boolean' ? ctx.taxDisabled : undefined;
  const base = { currency: ctx.currency, todayLocal: ctx.todayLocal, tenantVat: ctx.tenantVat ?? ctx.companyVat ?? null, tz: ctx.tz,
    ...(typeof taxOff === 'boolean' ? { taxOff } : {}), ...(typeof ctx.vatBox === 'boolean' ? { vatBox: ctx.vatBox } : {}) };
  if (!qr.ok) {
    const facts = emptyFacts();
    const checks = docChecks(facts, { ...base, qrVerified: false, qrRaw: null });
    checks.push({ code: 'QR_INVALID', severity: 'warn' });
    return { facts, qrVerified: false, checks };
  }
  const q = qr.qr;
  const facts: AcctDocFacts = {
    ...emptyFacts(),
    docType: q.simplified ? 'SIMPLIFIED_INVOICE' : 'TAX_INVOICE',
    vendorName: q.sellerName,
    vendorVat: q.vatNo || null,
    issueDate: q.issueDate,
    currency: 'SAR',
    subtotal: formatDocAmount(q.totalMilli - q.vatMilli, decimals),
    vatAmount: formatDocAmount(q.vatMilli, decimals),
    total: formatDocAmount(q.totalMilli, decimals),
  };
  return { facts, qrVerified: true, checks: docChecks(facts, { ...base, qrVerified: true, qrRaw: qrBase64 }) };
}

// ═══ تصحيح المستخدم ═══

/** قيمة تصحيح غير صالحة ⇒ 400 باسم الحقل (لا تخمين ولا إسقاط صامت) */
export class AcctDocPatchError extends Error {
  readonly code = 'DOC_PATCH_INVALID';
  readonly field: keyof AcctDocPatch;
  readonly reason: string;
  constructor(field: keyof AcctDocPatch, reason: string) {
    super(`DOC_PATCH_INVALID:${String(field)}:${reason}`);
    this.name = 'AcctDocPatchError';
    this.field = field;
    this.reason = reason;
    Object.setPrototypeOf(this, AcctDocPatchError.prototype);
  }
}

export interface PatchOpts {
  /** عملة الشركة ومنازلها (منازل المبالغ حين لا تذكر الحقائق عملة أخرى) */
  currency?: string | null;
  currencyDecimals?: number | null;
}

const PAYMENT_HINTS: readonly AcctPaymentHint[] = ['PAID', 'UNPAID', 'UNKNOWN'];
const CATEGORY_HINTS: readonly string[] = [...EXPENSE_CATEGORY_KEYS, ...ACCT_DOC_EXTRA_CATEGORIES];
const AMOUNT_FIELDS = ['subtotal', 'vatAmount', 'total'] as const;

/** أقصى أشهر تُقبل في الحقل (الأطول من 24 يُقبل ليُمنع بـMONTHS_INVALID ويُحال للمحاسب، والخيالي يُرفض) */
const MAX_MONTHS_INPUT = 600;

function patchMonths(v: unknown): number | null {
  if (v === null || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(latinDigits(v.trim())) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_MONTHS_INPUT) throw new AcctDocPatchError('months', 'INTEGER_0_600');
  return n;
}

/**
 * يطبّق تصحيح المستخدم (جزئي: الغائب لا يتغيّر، null يمحو) ويعيد حقائق جديدة موحَّدة:
 *   - المبالغ نصوص عشرية بمنازل العملة (الأرقام الهندية وفواصل الآلاف تُوحَّد؛ الملتبس يُرفض AcctDocPatchError).
 *   - الثالث المفقود من (قبل الضريبة، الضريبة، الإجمالي) يُشتق من الآخرين؛ ووعاءٌ كان مشتقاً يتبع الإجمالي والضريبة.
 *   - تغيير العملة يعيد تنسيق المبالغ بمنازلها.
 *   - التواريخ ميلادية (الهجري يُحفظ ليمنعه HIJRI_DATE)، والفترة «إلى» لا تسبق «من».
 * لا يمسّ facts الأصلية.
 */
export function applyUserPatch(facts: AcctDocFacts | null, patch: AcctDocPatch, opts: PatchOpts = {}): AcctDocFacts {
  const prev = facts ?? emptyFacts();
  const out: AcctDocFacts = {
    ...emptyFacts(), ...prev,
    lines: (prev.lines ?? []).map((l) => ({ ...l })),
    lease: prev.lease ? { ...prev.lease } : null,
  };
  const p = patch as Record<string, unknown>;
  const has = (k: keyof AcctDocPatch) => Object.prototype.hasOwnProperty.call(p, k) && p[k] !== undefined;

  // العملة أولاً: منها منازل المبالغ
  if (has('currency')) {
    const c = normalizeCurrencyCode(p.currency ?? '');
    if (c === '') throw new AcctDocPatchError('currency', 'ISO_4217');
    out.currency = c;
  }
  const prevDec = factsDecimals(prev, opts);
  const dec = factsDecimals(out, opts);

  // النصوص
  if (has('vendorName')) out.vendorName = cleanDocText(p.vendorName);
  if (has('buyerName')) out.buyerName = cleanDocText(p.buyerName);
  if (has('invoiceNo')) out.invoiceNo = normalizeInvoiceNo(p.invoiceNo);
  for (const k of ['vendorVat', 'buyerVat'] as const) {
    if (!has(k)) continue;
    const v = normalizeVatNo(p[k] ?? '');
    if (v === '') throw new AcctDocPatchError(k, 'DIGITS');
    out[k] = v;
  }

  // الاختيارات
  if (has('docType')) {
    const v = p.docType;
    if (v !== null && !(ACCT_DOC_TYPES as readonly unknown[]).includes(v)) throw new AcctDocPatchError('docType', 'UNKNOWN');
    out.docType = (v as AcctDocType | null) ?? null;
  }
  if (has('categoryHint')) {
    const v = p.categoryHint;
    if (v !== null && !CATEGORY_HINTS.includes(v as string)) throw new AcctDocPatchError('categoryHint', 'UNKNOWN');
    out.categoryHint = (v as string | null) ?? null;
  }
  if (has('assetClassHint')) {
    const v = p.assetClassHint;
    if (v !== null && !(ACCT_ASSET_CLASSES as readonly unknown[]).includes(v)) throw new AcctDocPatchError('assetClassHint', 'UNKNOWN');
    out.assetClassHint = (v as AcctAssetClass | null) ?? null;
  }
  if (has('paymentHint')) {
    const v = p.paymentHint;
    if (!(PAYMENT_HINTS as readonly unknown[]).includes(v)) throw new AcctDocPatchError('paymentHint', 'UNKNOWN');
    out.paymentHint = v as AcctPaymentHint;
  }
  if (has('vatRatePct')) {
    const v = p.vatRatePct;
    if (v === null) out.vatRatePct = null;
    else if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) out.vatRatePct = Math.round(v * 100) / 100;
    else throw new AcctDocPatchError('vatRatePct', 'RANGE_0_100');
  }
  if (has('months')) out.months = patchMonths(p.months);

  // التواريخ
  for (const k of ['issueDate', 'periodFrom', 'periodTo'] as const) {
    if (!has(k)) continue;
    const v = p[k];
    if (v === null || v === '') { out[k] = null; continue; }
    const d = normalizeDocDate(v);
    if (!d.date) throw new AcctDocPatchError(k, d.hijri ? 'HIJRI' : 'DATE');
    out[k] = d.date;
  }
  if (out.periodFrom && out.periodTo && isLocalDate(out.periodFrom) && isLocalDate(out.periodTo)
    && compareLocalDate(out.periodTo, out.periodFrom) < 0) {
    throw new AcctDocPatchError('periodTo', 'BEFORE_FROM');
  }

  // المبالغ: القديمة بمنازل العملة الجديدة، ثم التصحيح
  const prevM: Record<(typeof AMOUNT_FIELDS)[number], Milli | null> = {
    subtotal: factAmount(prev.subtotal, prevDec), vatAmount: factAmount(prev.vatAmount, prevDec), total: factAmount(prev.total, prevDec),
  };
  const m = { ...prevM };
  for (const k of AMOUNT_FIELDS) {
    if (!has(k)) continue;
    const v = p[k];
    if (v === null || v === '') { m[k] = null; continue; }
    const parsed = parseDocAmount(v, dec, { allowZero: k !== 'total' });
    if (parsed === null) throw new AcctDocPatchError(k, k === 'total' ? 'POSITIVE_DECIMAL' : 'DECIMAL');
    m[k] = parsed;
  }
  // الاشتقاق: وعاءٌ كان «الإجمالي − الضريبة» يتبعهما؛ والمفقود من الثلاثة يُشتق من الآخرين
  const subWasDerived = prevM.subtotal !== null && prevM.total !== null && prevM.vatAmount !== null
    && prevM.subtotal === prevM.total - prevM.vatAmount;
  if (!has('subtotal') && m.total !== null && m.vatAmount !== null && m.total >= m.vatAmount && (m.subtotal === null || subWasDerived)) {
    m.subtotal = m.total - m.vatAmount;
  } else if (!has('total') && m.total === null && m.subtotal !== null && m.vatAmount !== null) {
    const t = m.subtotal + m.vatAmount;
    if (t > 0n) m.total = t;
  } else if (!has('vatAmount') && m.vatAmount === null && m.subtotal !== null && m.total !== null && m.total >= m.subtotal) {
    m.vatAmount = m.total - m.subtotal;
  }
  for (const k of AMOUNT_FIELDS) out[k] = m[k] === null ? null : formatDocAmount(m[k]!, dec);
  return out;
}

/** مصدر الحقائق بعد إضافة مصدر: QR ثم تصحيح ⇒ QR+USER، والإدخال وحده USER */
export function mergeFactsSource(prev: AcctFactsSource | null | undefined, add: 'QR' | 'USER'): AcctFactsSource {
  if (!prev || prev === add) return add;
  return 'QR+USER';
}

// ═══ إعادة الفحص ═══

export interface RecheckInput {
  mimeType: string;
  qrVerified: boolean;
  manualEntry: boolean;
  taxOff: boolean;
  /** عملة الشركة */
  currency: string;
  todayLocal: string;
  tenantVat: string | null;
  /** حدّ الرسملة بوحدة العملة الكبرى (AI_ACCOUNTANT_ASSET_THRESHOLD) */
  assetThreshold: number;
  /** اختيارية (AcctDocEnv): منازل العملة، مربّع الضريبة، نصّ QR المخزَّن (QR_MISMATCH/QR_INVALID)، المنطقة، الحدّ بالملّي، الدليل */
  currencyDecimals?: number | null;
  vatBox?: boolean;
  qrRaw?: string | null;
  tz?: string;
  assetThresholdMilli?: bigint;
  accounts?: readonly ChartAccountLike[] | null;
}

/** حالة QR للمستند المخزّن (DocQrState في store.ts) + نوعه إن عُرف */
export interface DocQrStateLike {
  qrRaw: string | null;
  qrVerified: boolean;
  manualEntry: boolean;
  mimeType?: string;
}

/**
 * يعيد حساب الفحوص والحالة والاقتراح من الحقائق. facts null:
 *   - manualEntry ⇒ NEEDS_REVIEW بفحوص الحقائق الفارغة (الإجمالي والتاريخ مفقودان) — البطاقة تفتح للتحرير.
 *   - وإلا UPLOADED بلا فحوص ولا اقتراح.
 * مانع معالجة (بضاعة، أرض/مبنى، أكثر من 24 شهراً) بلا فحص ⇒ NEEDS_REVIEW أيضاً (لا «جاهز» لما لا يُرحَّل).
 * صيغتان: (facts, input) بالمدخلات الصريحة، أو (facts, env, state) بسياق الشركة المحمَّل (AcctDocEnv) وحالة QR المخزّنة.
 */
export function recheck(facts: AcctDocFacts | null, input: RecheckInput): AcctDocRecheck;
export function recheck(facts: AcctDocFacts | null, env: AcctDocEnv, state: DocQrStateLike): AcctDocRecheck;
export function recheck(facts: AcctDocFacts | null, a: RecheckInput | AcctDocEnv, state?: DocQrStateLike): AcctDocRecheck {
  if (state) {
    return recheckWithEnv(facts, a as AcctDocEnv, {
      mimeType: state.mimeType ?? '', qrVerified: state.qrVerified, manualEntry: state.manualEntry, qrRaw: state.qrRaw,
    });
  }
  const input = a as RecheckInput;
  if (!facts && !input.manualEntry) return { checks: [], status: 'UPLOADED', suggestion: null };
  const f = facts ?? emptyFacts();
  const sOpts: SuggestOpts = {
    taxOff: input.taxOff, vatBox: input.vatBox, assetThreshold: input.assetThreshold,
    ...(typeof input.assetThresholdMilli === 'bigint' ? { assetThresholdMilli: input.assetThresholdMilli } : {}),
    currency: input.currency, currencyDecimals: input.currencyDecimals ?? null,
  };
  const core = suggestCore(f, sOpts, input.accounts ?? null);
  const checks = docChecks(f, {
    currency: input.currency, currencyDecimals: input.currencyDecimals ?? null, todayLocal: input.todayLocal,
    tenantVat: input.tenantVat, taxOff: input.taxOff, vatBox: input.vatBox, qrVerified: input.qrVerified,
    qrRaw: input.qrRaw ?? null, tz: input.tz, mimeType: input.mimeType,
    suggestion: core.suggestion, amortizationCode: core.amortizationAccount?.code ?? null,
  });
  const status: AcctDocStatus = checks.length > 0 || core.blocked ? 'NEEDS_REVIEW' : 'EXTRACTED';
  return { checks, status, suggestion: core.suggestion };
}

// ═══ بالبيئة المحمَّلة (AcctDocEnv من store.ts) ═══

/** recheck بسياق الشركة المحمَّل: المحمِّل يمرّر env وصفّ المستند */
export function recheckWithEnv(
  facts: AcctDocFacts | null, env: AcctDocEnv,
  doc: { mimeType: string; qrVerified: boolean; manualEntry: boolean; qrRaw?: string | null },
): AcctDocRecheck {
  return recheck(facts, {
    mimeType: doc.mimeType, qrVerified: doc.qrVerified, manualEntry: doc.manualEntry, qrRaw: doc.qrRaw ?? null,
    taxOff: env.taxDisabled, currency: env.currency, currencyDecimals: env.currencyDecimals, todayLocal: env.todayLocal,
    tenantVat: env.companyVat, assetThreshold: Number(env.assetThresholdMilli) / 1000, assetThresholdMilli: env.assetThresholdMilli,
    vatBox: env.vatBox, tz: env.tz, accounts: env.accounts,
  });
}

/** الاقتراح والخيارات بسياق الشركة المحمَّل */
export function suggestWithEnv(facts: AcctDocFacts | null, env: AcctDocEnv): DocSuggestResult {
  return suggestFor(facts, env.accounts, {
    taxOff: env.taxDisabled, vatBox: env.vatBox, assetThresholdMilli: env.assetThresholdMilli,
    currency: env.currency, currencyDecimals: env.currencyDecimals,
  });
}

/** factsFromQr بسياق الشركة المحمَّل (بفحوص الضريبة كاملة) */
export function factsFromQrWithEnv(qrBase64: string, env: AcctDocEnv): ReturnType<typeof factsFromQr> {
  return factsFromQr(qrBase64, {
    tz: env.tz, todayLocal: env.todayLocal, currency: env.currency, tenantVat: env.companyVat, taxOff: env.taxDisabled, vatBox: env.vatBox,
  });
}
