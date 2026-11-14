/**
 * الفحوص المسبقة P1..P14 لـ«ربط الدفاتر بكامل النظام» (L2 — العقد scratchpad/l23_contract.md §12، الخطة §4 «Preflight»).
 *
 * B يحجب الاعتماد (L7)، وW تحذيرٌ يُقرّ به المالك. نمطان:
 *   - LIGHT: تقديرٌ سريع لـGET /linking/preflight داخل لقطة قصيرة للقراءة — لا يحتاج محرّك التكلفة ولا أحداث الظلّ.
 *   - FULL: من المعاينة الكاملة (runPreview): P7 يضمّ نِسب AUTO_SALE التي احتاجها الظلّ، وP9/P10 من محرّك التكلفة،
 *     وP13 من عدد أحداث الظلّ الفعلي. وإن غاب أحدهما في FULL يسقط ذلك الفحص وحده إلى تقدير LIGHT بعلامة mode='LIGHT'
 *     (لا رقم «كامل» كاذب).
 *
 * قراءة فقط ومن الجداول التشغيلية وحدها: **لا وصول لأي gl*** (العميل الحارس في الظلّ يرمي SHADOW_GL_ACCESS) — إعدادات
 * الدفاتر والمسودة تأتي في المدخلات. والقاعدة صغيرة جداً (٠٫١ نواة): كل فحص استعلامٌ مجمَّع (groupBy/count) أو مسحٌ
 * مقسَّم بمؤشّر (createdAt, id) بصفحات ثابتة، وأسماء العناصر بدفعة IN واحدة — لا N+1. الاستعلامات متتابعة عمداً:
 * معاملة تفاعلية واحدة على اتصال واحد لا تكسب شيئاً من التوازي.
 *
 * الحساب نفسه صرف (evaluateP1..evaluateP14 وpreflightCheck وpreflightReport) فيُختبر بلا قاعدة؛ loadPreflightFacts
 * وحده يقرأ. المبالغ بالملّي BigInt مقرَّبة **لكل مستند/سطر** ثم مجموعة (قاعدة المطابقة) — JSON عبر toJsonMilli في المسار.
 */
import type { Prisma } from '@prisma/client';
import { addDays, compareLocalDate, daysInMonth, fiscalYearStart, fromDbDate, localDate, zonedStartOfDay } from '../dates';
import { formatMilli, toMilli, unitMilli } from '../money';
import { resolveTemplate } from '../seed';
import { autoSaleKey } from '../builders/invoice';
import { CONSERVATIVE_MS_PER_EVENT, HISTORY_MAX_ROWS } from '../backfill';
import { initialWatermarkAt } from '../sync/classify';
import { createPrismaCheckStore } from '../checks/store.prisma';
import { importBatchRecordIds, loadRunningImportBatch, openingSnapshotFromDbNow, OPENING_STOCK_BATCH_KIND, type ImportBatchStateRow } from '../opening';
import { SETTLEMENT_HAS_REP, SETTLEMENT_OF_DELETED_REP } from '../settlementRep';
import { bookMode } from '../mode';
import { baseMethodLabel, loadReceiptMethodUsage, type ReceiptMethodUsage } from '../../receiptMethodUsage';
import { PAYMENT_METHODS, type InventoryMode, type LocalDate, type Milli, type TemplateKey } from '../types';
import { UNKNOWN_VAN, WH_LOCATION, repOfLocation, type CostingSummary, type LocationKey } from '../../costing/types';
import {
  BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN, BACKFILL_PEAK_BUDGET_MS_PER_MIN, COST_SNAPSHOT_ROW_BYTES, PLATFORM_EVENT_CAP, PREFLIGHT_CODES,
  PREVIEW_LIST_CAPS, ROW_BYTES_ESTIMATE, ROWS_PER_POSTED_EVENT,
  type PreflightCheck, type PreflightCode, type PreflightInput, type PreflightItem, type PreflightLevel, type PreflightMode,
  type PreflightReport,
} from './types';

/** تشغيلي فقط — ممنوع أي gl* (العميل الحارس يرمي): الإعدادات تأتي في input */
export type PreflightDb = Prisma.TransactionClient;

// ═══ الثوابت ═══

/** صفوف كل صفحة في المسح المقسَّم (P10، وP12 في FULL) — صفحة ثابتة لا تحمّل ذاكرة الخادم ولا القاعدة الصغيرة */
export const PREFLIGHT_PAGE_SIZE = 1_000;
/** معرّفات IN لكل استعلام (دفعات المخزون الافتتاحي) */
export const PREFLIGHT_ID_CHUNK = 1_000;
/** P12 في LIGHT: آخر هذا العدد من فواتير الفترة (العقد §12) */
export const PREFLIGHT_LIGHT_ROUNDING_SCAN = 5_000;
/** P11: «مؤرّخ مستقبلاً» = تاريخ الأثر بعد الآن بأكثر من يوم */
export const FUTURE_DATED_SLACK_MS = 24 * 60 * 60_000;
/**
 * P13: فوق هذا العدد من الأحداث يصير الحجم تحذيراً يُقرّ به (ساعات من الترحيل خارج الذروة ونموّ ملحوظ للقاعدة).
 * هو سقف الترحيل التاريخي الكامل القائم (HISTORY_MAX_ROWS في backfill.ts)، وفوق PLATFORM_EVENT_CAP يحجب (B).
 */
export const P13_WARN_EVENTS = HISTORY_MAX_ROWS;
/** مصدر حركة المستودع لاستيراد المخزون الافتتاحي (WarehouseEntry.source — L1، services/suppliers/core.ts) */
export const OPENING_IMPORT_SOURCE = 'OPENING_IMPORT';

export const PREFLIGHT_TITLES_AR: Readonly<Record<PreflightCode, string>> = {
  P1: 'تفعيل النظام المحاسبي المتكامل ومُرحِّل الدفاتر',
  P2: 'نهاية السنة المالية وتاريخ الربط',
  P3: 'عملة الشركة وعملة الدفاتر',
  P4: 'تواريخ الإقفال قبل تاريخ الربط',
  P5: 'دفعات الاستيراد والمخزون الافتتاحي',
  P6: 'تكامل أودو (ازدواج الدفاتر)',
  P7: 'نِسب ضريبة المبيعات ومربعات الإقرار',
  P8: 'توجيه طرق الدفع والفواتير النقدية',
  P9: 'رصيد بلا تكلفة في بداية السنة',
  P10: 'تسعير الوارد وتصنيفه وحُفر الرصيد السالب',
  P11: 'مناديب محذوفون وفواتير بلا مندوب ومستندات مؤرّخة مستقبلاً',
  P12: 'فروق تقريب إجماليات الفواتير',
  P13: 'حجم الترحيل والتخزين والوقت المتوقَّع',
  P14: 'تحويل دفاتر يدوية قائمة',
};

/** المستوى الافتراضي لكل فحص (P7 يصير W للقالب العام، وP13 يصير B فوق سقف المنصّة) */
export const PREFLIGHT_DEFAULT_LEVEL: Readonly<Record<PreflightCode, PreflightLevel>> = {
  P1: 'B', P2: 'B', P3: 'B', P4: 'B', P5: 'B', P6: 'W', P7: 'B', P8: 'B', P9: 'B', P10: 'W', P11: 'W', P12: 'W', P13: 'W', P14: 'B',
};

const LOCK_FIELDS = ['salesLockDate', 'purchaseLockDate', 'taxLockDate', 'hardLockDate'] as const;
type LockField = (typeof LOCK_FIELDS)[number];
const LOCK_LABELS_AR: Readonly<Record<LockField, string>> = {
  salesLockDate: 'إقفال المبيعات', purchaseLockDate: 'إقفال المشتريات', taxLockDate: 'إقفال الضريبة', hardLockDate: 'الإقفال النهائي',
};

const INVOICE_TYPE_AR: Readonly<Record<string, string>> = { CASH: 'نقدية', CREDIT: 'آجلة', RETURN: 'مرتجع' };
const IMPORT_KIND_AR: Readonly<Record<string, string>> = {
  customers: 'العملاء', products: 'الأصناف', prices: 'الأسعار', balances: 'الأرصدة', ledger: 'القيود', opening_stock: 'المخزون الافتتاحي',
};

/** الطرق الأساسية التي تحتاج مساراً في receiptRouting (ONLINE له حسابه دائماً) */
const ROUTED_METHODS = PAYMENT_METHODS.filter((m) => m !== 'ONLINE');

// ═══ المساعدات الصرفة ═══

export interface PreflightCheckFields {
  /** الغائب = PREFLIGHT_DEFAULT_LEVEL */
  level?: PreflightLevel;
  ok: boolean;
  notApplicable?: boolean;
  details: string;
  count?: number | null;
  valueMilli?: Milli | null;
  items?: readonly PreflightItem[];
  /** العدد الكلي للعناصر حين تكون items عيّنةً مقصوصة من القاعدة (الغائب = طول items) */
  itemsTotal?: number;
}

/** بناء فحص بعنوانه الثابت ومستواه، وقصّ العناصر إلى PREVIEW_LIST_CAPS.preflightItems مع itemsTruncated */
export function preflightCheck(code: PreflightCode, mode: PreflightMode, f: PreflightCheckFields): PreflightCheck {
  const all = f.items ?? [];
  const cap = PREVIEW_LIST_CAPS.preflightItems;
  const items = all.slice(0, cap);
  const total = Math.max(f.itemsTotal ?? all.length, all.length);
  const out: PreflightCheck = {
    code,
    level: f.level ?? PREFLIGHT_DEFAULT_LEVEL[code],
    // «لا ينطبق» ناجحٌ دائماً (العقد)
    ok: f.notApplicable ? true : f.ok,
    titleAr: PREFLIGHT_TITLES_AR[code],
    details: f.details,
    count: f.count ?? null,
    valueMilli: f.valueMilli ?? null,
    items,
    mode,
  };
  if (f.notApplicable) out.notApplicable = true;
  if (total > items.length) out.itemsTruncated = total - items.length;
  return out;
}

/** التقرير: الفحوص بترتيب P1..P14، وblocking = B غير المتحققة، وwarnings = W غير المتحققة */
export function preflightReport(input: Pick<PreflightInput, 'mode' | 'basis' | 'linkedFrom'>, checks: readonly PreflightCheck[]): PreflightReport {
  const order = new Map<string, number>(PREFLIGHT_CODES.map((c, i) => [c, i]));
  const sorted = [...checks].sort((a, b) => (order.get(a.code) ?? 99) - (order.get(b.code) ?? 99));
  return {
    mode: input.mode,
    linkedFrom: input.linkedFrom,
    basis: input.basis,
    checks: sorted,
    blocking: sorted.filter((c) => c.level === 'B' && !c.ok).length,
    warnings: sorted.filter((c) => c.level === 'W' && !c.ok).length,
  };
}

const money = (m: Milli, decimals: number, currency: string): string => `${formatMilli(m, decimals)} ${currency}`;
/** كمية للعرض بستّ منازل كحدّ أقصى (units.roundQty) بلا أصفار زائدة */
const qtyText = (q: number): string => String(Number(q.toFixed(6)));
const absMilli = (m: Milli): Milli => (m < 0n ? -m : m);

/** وصف موقع مخزون للمالك */
export function locationLabelAr(location: LocationKey, repNames: ReadonlyMap<string, string>): string {
  if (location === WH_LOCATION) return 'المستودع';
  if (location === UNKNOWN_VAN) return 'سيارة غير معروفة';
  const rep = repOfLocation(location);
  return `سيارة ${rep ? (repNames.get(rep) ?? rep) : location}`;
}

/** P13: تقدير الصفوف والبايتات والوقت (الخطة §3 «Throughput and storage») — صرف */
export function estimateLinkVolume(events: number, costSnapshots: number) {
  const eventRows = events * ROWS_PER_POSTED_EVENT;
  return {
    events,
    costSnapshots,
    rows: eventRows + costSnapshots,
    bytesEstimate: eventRows * ROW_BYTES_ESTIMATE + costSnapshots * COST_SNAPSHOT_ROW_BYTES,
    msPerEvent: CONSERVATIVE_MS_PER_EVENT,
    etaMinutesOffPeak: Math.ceil((events * CONSERVATIVE_MS_PER_EVENT) / BACKFILL_OFFPEAK_BUDGET_MS_PER_MIN),
    etaMinutesPeakOnly: Math.ceil((events * CONSERVATIVE_MS_PER_EVENT) / BACKFILL_PEAK_BUDGET_MS_PER_MIN),
  };
}

// ═══ الحقائق (ما يُقرأ من القاعدة) ═══

export interface PreflightFacts {
  /** OD7: مخزون الشركة مفعّل ⇒ PERPETUAL (المصدر نفسه في params.ts) */
  inventoryMode: InventoryMode;
  company: {
    /** currencyOverride ‖ currency؛ null = لا صف إعدادات للشركة */
    currency: string | null;
    countryCode: string;
  };
  /** Invoice.currency غير الفارغة لكل الفواتير — مرتّبة بالعملة */
  invoiceCurrencies: { currency: string; invoices: number }[];
  runningImport: ImportBatchStateRow | null;
  openingStock: {
    /** دفعات opening_stock غير المتراجَع عنها */
    batches: number;
    /** حركاتها التي ليست بمصدر OPENING_IMPORT — مرتّبة بـ(createdAt, id) */
    nonImportEntries: { id: string; batchId: string; source: string; createdAt: Date }[];
  };
  odooActive: boolean;
  /** نِسب ضريبة بنود فواتير الفترة (غير taxFree وغير مسودّة) — مرتّبة */
  saleRates: { taxPct: number; vatCategory: string | null; lines: number }[];
  /**
   * طرق سندات الفترة — مرتّبة بالأساس ثم المخصّصة. الوصف من نطاق «طرق الدفع» (services/receiptMethodUsage.ts): الدفاتر
   * لا تعرف المفتاح المخصّص ولا إعداده، فيصل الفحص أساساً واسماً للعرض لا مفتاحاً يُوجَّه به
   */
  receiptMethods: ReceiptMethodUsage[];
  /** P9 LIGHT: أسطر وارد بلا سعر قبل بداية السنة لكل صنف (null ⇒ لم يُحسب: FULL بمحرّك التكلفة أو الجرد الدوري) */
  unpricedBeforeCutover: { productId: string; lines: number }[] | null;
  /** P10: الوارد منذ linkedFrom */
  receiptsFy: ReceiptsFyFacts;
  /** P11 */
  deletedReps: { repId: string; vanLoads: number; receipts: number; settlements: number }[];
  adminInvoices: { count: number; sample: { id: string; number: string; type: string; invoiceDate: Date; total: number }[] };
  futureDated: { count: number; sample: { id: string; entryDate: Date; debit: number; credit: number; description: string }[] };
  /** P12 */
  rounding: RoundingFacts;
  /** P13 LIGHT (null ⇒ FULL بأحداث الظلّ) */
  volume: VolumeSourceFacts | null;
  names: { products: ReadonlyMap<string, string>; reps: ReadonlyMap<string, string> };
}

export interface ReceiptsFyFacts {
  entries: number;
  /** أسطر بكمية موجبة */
  lines: number;
  pricedLines: number;
  unpricedLines: number;
  /** حركات بلا مورّد أو بلا نمط دفع (⇒ 211002 GRNI حتى تُصنَّف) */
  unclassifiedEntries: number;
  unclassifiedNoVendor: number;
  unclassifiedNoMode: number;
  /** Σ toMilli(qty × unitCost) لأسطرها المسعَّرة — كل سطر مقرَّب وحده */
  unclassifiedValueMilli: Milli;
  /** حركات تستحق الانتباه (سطر بلا سعر أو غير مصنَّفة) بترتيب (createdAt, id) — حتى PREVIEW_LIST_CAPS.preflightItems */
  attention: { id: string; createdAt: Date; supplier: string | null; unpricedLines: number; noVendor: boolean; noMode: boolean; pricedValueMilli: Milli }[];
  attentionTotal: number;
}

export interface RoundingFacts {
  /** الفواتير المفحوصة */
  scanned: number;
  /** LIGHT: المسح مقصور على آخر PREFLIGHT_LIGHT_ROUNDING_SCAN */
  limited: boolean;
  count: number;
  absSumMilli: Milli;
  /** الأكبر |diff| أولاً ثم التاريخ ثم المعرّف — حتى PREVIEW_LIST_CAPS.preflightItems */
  top: { id: string; number: string; invoiceDate: Date; totalMilli: Milli; computedMilli: Milli; diffMilli: Milli }[];
}

export interface VolumeSourceFacts {
  /** initialWatermarkAt(OPENING) — الصفوف المُطابَقة منذه */
  watermarkAt: Date;
  accountEntries: number;
  repSettlements: number;
  settlementEntries: number;
  /** صفوف مصادر محرّك التكلفة (وارد/تحميل/بنود فواتير بأصناف) — حدّ أعلى للّقطات */
  costSourceRows: number;
}

// ═══ الفحوص الصرفة ═══

export function evaluateP1(input: Pick<PreflightInput, 'mode' | 'suiteEnabled' | 'workerEnabled'>): PreflightCheck {
  const problems: string[] = [];
  if (!input.suiteEnabled) problems.push('النظام المحاسبي المتكامل غير مفعّل لهذه الشركة (يفعّله مالك المنصّة مع النظام المحاسبي)');
  if (!input.workerEnabled) problems.push('مُرحِّل الدفاتر موقوف على الخادم (LEDGER_WORKER_ENABLED=0) فلن يُرحَّل شيء');
  return preflightCheck('P1', input.mode, {
    ok: problems.length === 0,
    details: problems.length ? `${problems.join('؛ ')}.` : 'النظام المحاسبي المتكامل مفعّل للشركة، ومُرحِّل الدفاتر يعمل.',
  });
}

/** نهاية السنة المؤكَّدة: المسودة أولاً (step1)، ثم صف الإعدادات — null إن لم تُؤكَّد */
export function confirmedFiscalYearEnd(input: Pick<PreflightInput, 'draft' | 'settingsRow'>): { month: number; day: number; source: 'DRAFT' | 'SETTINGS' } | null {
  const d1 = input.draft?.step1;
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  if (d1 && isInt(d1.fiscalYearEndMonth) && isInt(d1.fiscalYearEndDay)) return { month: d1.fiscalYearEndMonth, day: d1.fiscalYearEndDay, source: 'DRAFT' };
  const s = input.settingsRow;
  if (s && isInt(s.fiscalYearEndMonth) && isInt(s.fiscalYearEndDay)) return { month: s.fiscalYearEndMonth, day: s.fiscalYearEndDay, source: 'SETTINGS' };
  return null;
}

export function evaluateP2(input: Pick<PreflightInput, 'mode' | 'basis' | 'linkedFrom' | 'draft' | 'settingsRow'>): PreflightCheck {
  const openingDate = addDays(input.linkedFrom, -1);
  const tail = `الربط من ${input.linkedFrom} والقيد الافتتاحي بتاريخ ${openingDate}`;
  const fy = confirmedFiscalYearEnd(input);
  if (!fy) {
    return preflightCheck('P2', input.mode, {
      ok: false,
      details: `لم تُؤكَّد نهاية السنة المالية في معالج إعداد الدفاتر — أكّدها أولاً (${tail}).`,
    });
  }
  const fyText = `${String(fy.day).padStart(2, '0')}/${String(fy.month).padStart(2, '0')}`;
  // اليوم صالح للشهر في سنة غير كبيسة — قاعدة المعالج نفسها (setup.ts assertFiscalYearEnd)
  if (fy.month < 1 || fy.month > 12 || fy.day < 1 || fy.day > daysInMonth(2001, fy.month)) {
    return preflightCheck('P2', input.mode, { ok: false, details: `نهاية السنة المالية ${fyText} ليست تاريخاً صالحاً — صحّحها في معالج الإعداد (${tail}).` });
  }
  // FY_RESTATED: يجب أن يكون تاريخ الربط بداية سنةٍ مالية بالنهاية المؤكَّدة نفسها (وإلا خلطت المعاينة سنتين)
  if (input.basis === 'FY_RESTATED' && fiscalYearStart(input.linkedFrom, fy.month, fy.day) !== input.linkedFrom) {
    return preflightCheck('P2', input.mode, {
      ok: false,
      details: `تاريخ الربط ${input.linkedFrom} ليس بداية سنةٍ مالية بنهايتها المؤكَّدة ${fyText} (القيد الافتتاحي سيكون بتاريخ ${openingDate}) — أعد تشغيل الفحص بعد حفظ الإعداد.`,
    });
  }
  return preflightCheck('P2', input.mode, { ok: true, details: `نهاية السنة المالية ${fyText} مؤكَّدة؛ ${tail}.` });
}

export function evaluateP3(
  input: Pick<PreflightInput, 'mode' | 'currency'>,
  facts: Pick<PreflightFacts, 'company' | 'invoiceCurrencies'>,
): PreflightCheck {
  const gl = input.currency.trim().toUpperCase();
  const company = facts.company.currency ? facts.company.currency.trim().toUpperCase() : null;
  const foreign = facts.invoiceCurrencies.filter((c) => c.currency.trim().toUpperCase() !== gl);
  const problems: string[] = [];
  if (company && company !== gl) problems.push(`عملة الشركة ${company} تخالف عملة الدفاتر ${gl}`);
  const foreignCount = foreign.reduce((s, c) => s + c.invoices, 0);
  if (foreign.length) problems.push(`${foreignCount} فاتورة بعملة غير عملة الدفاتر (${foreign.map((c) => `${c.currency}: ${c.invoices}`).join('، ')})`);
  return preflightCheck('P3', input.mode, {
    ok: problems.length === 0,
    count: foreignCount,
    details: problems.length
      ? `${problems.join('؛ ')} — الدفاتر بعملة واحدة، فوحّد العملة قبل الربط.`
      : `عملة الشركة ${company ?? gl} تطابق عملة الدفاتر ${gl}، ولا فواتير بعملة أخرى.`,
    items: foreign.map((c) => ({ id: c.currency, label: `فواتير بعملة ${c.currency}`, qty: c.invoices })),
  });
}

/** تاريخ الإقفال من صف الإعدادات (عمود @db.Date ⇒ مكوّنات UTC) */
function lockDateOf(v: Date | string | null | undefined): LocalDate | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return fromDbDate(v);
}

export function evaluateP4(input: Pick<PreflightInput, 'mode' | 'linkedFrom' | 'settingsRow'>): PreflightCheck {
  const openingDate = addDays(input.linkedFrom, -1);
  const items: PreflightItem[] = [];
  const s = input.settingsRow;
  for (const f of LOCK_FIELDS) {
    const d = s ? lockDateOf(s[f] as Date | null) : null;
    if (!d) continue;
    // الإقفال يحكم «حتى تاريخه شاملاً»؛ والقيود الآلية تُزاح إلى أول يوم مفتوح (post.ts SHIFT): إقفالٌ ≥ تاريخ الربط يزيح
    // مستندات السنة، وإقفالٌ = يوم القيد الافتتاحي (آخر يوم في السنة السابقة — الشائع) يزيح القيد الافتتاحي نفسه
    if (compareLocalDate(d, input.linkedFrom) >= 0) {
      items.push({ id: f, label: `${LOCK_LABELS_AR[f]} ${d}: يقع في سنة الربط فتُزاح مستنداتها عن تواريخها`, date: d });
    } else if (compareLocalDate(d, openingDate) >= 0) {
      items.push({ id: f, label: `${LOCK_LABELS_AR[f]} ${d}: يُقفل يوم القيد الافتتاحي ${openingDate} فيُزاح القيد عنه`, date: d });
    }
  }
  return preflightCheck('P4', input.mode, {
    ok: items.length === 0,
    count: items.length,
    details: items.length
      ? `${items.length} تاريخ إقفال لا يسبق القيد الافتتاحي (${openingDate}) — ارفعها قبل الربط (تُرفع بتدقيق وتُعاد بعد اكتمال الترحيل).`
      : `لا تاريخ إقفال يمسّ القيد الافتتاحي (${openingDate}) ولا سنة الربط.`,
    items,
  });
}

export function evaluateP5(input: Pick<PreflightInput, 'mode' | 'timezone'>, facts: Pick<PreflightFacts, 'runningImport' | 'openingStock'>): PreflightCheck {
  const problems: string[] = [];
  const items: PreflightItem[] = [];
  const r = facts.runningImport;
  if (r) {
    const kind = IMPORT_KIND_AR[r.kind] ?? r.kind;
    problems.push(`دفعة استيراد (${kind}) جارية الآن — انتظر انتهاءها`);
    items.push({ id: r.id, label: `دفعة استيراد جارية (${kind})`, date: localDate(r.createdAt, input.timezone) });
  }
  const bad = facts.openingStock.nonImportEntries;
  if (bad.length) {
    problems.push(`${bad.length} حركة من دفعات المخزون الافتتاحي ليست بمصدر «استيراد افتتاحي» فتُعامَل شراءً — صحّح مصدرها أو تراجع عن الدفعة`);
    for (const e of bad) items.push({ id: e.id, label: `حركة مستودع من الدفعة ${e.batchId} بمصدر ${e.source}`, date: localDate(e.createdAt, input.timezone) });
  }
  return preflightCheck('P5', input.mode, {
    ok: problems.length === 0,
    count: (r ? 1 : 0) + bad.length,
    details: problems.length
      ? `${problems.join('؛ ')}.`
      : `لا استيراد جارٍ${facts.openingStock.batches ? `، وحركات دفعات المخزون الافتتاحي (${facts.openingStock.batches}) كلها بمصدر الاستيراد الافتتاحي` : ''}.`,
    items,
  });
}

export function evaluateP6(input: Pick<PreflightInput, 'mode'>, facts: Pick<PreflightFacts, 'odooActive'>): PreflightCheck {
  return preflightCheck('P6', input.mode, {
    ok: !facts.odooActive,
    details: facts.odooActive
      ? 'تكامل أودو مفعّل: ستُرحَّل العمليات في دفاتر المنصّة وتُرسَل إلى أودو أيضاً — دفتران للعمليات نفسها. أقرّ بذلك (OD19) أو أوقف أحدهما.'
      : 'تكامل أودو غير مفعّل.',
  });
}

/**
 * ضريبة القالب التي سيختارها builder الفاتورة لنسبة موجبة (مرآة resolveInvoiceItemTax: أول ضريبة بيع نشطة بالنسبة نفسها
 * حرفياً). النسبة الصفرية لا تُفحص: لا تُرحِّل مبلغ ضريبة أبداً (علامة وعاء أو لا شيء) فلا AUTO_SALE ولا معلّق.
 */
function templateSaleTax<T extends { use: string; rate: number; isActive: boolean }>(taxes: readonly T[], pct: number): T | null {
  return taxes.find((t) => t.isActive && t.use === 'SALE' && t.rate === pct) ?? null;
}

export function evaluateP7(
  input: Pick<PreflightInput, 'mode' | 'templateKey' | 'settingsRow' | 'eventStats'>,
  facts: Pick<PreflightFacts, 'saleRates' | 'company'>,
): PreflightCheck {
  const sa = input.templateKey === 'SA_6D';
  const level: PreflightLevel = sa ? 'B' : 'W';
  const useEvents = input.mode === 'FULL' && !!input.eventStats;
  const mode: PreflightMode = useEvents ? 'FULL' : 'LIGHT';
  const countryCode = (input.settingsRow?.countryCode || facts.company.countryCode || 'SA').toUpperCase();
  let tpl: ReturnType<typeof resolveTemplate>;
  try {
    tpl = resolveTemplate(input.templateKey as TemplateKey, input.templateKey === 'GENERIC_6D' ? { countryCode } : {});
  } catch {
    return preflightCheck('P7', mode, { level, ok: false, details: `لا قالب ضريبي لدولة الشركة ${countryCode} — لا يمكن مطابقة نِسب الضريبة.` });
  }
  const outputVatActive = tpl.taxes.some((t) => t.use === 'SALE' && t.isActive && t.rate > 0);
  const bad = new Map<string, PreflightItem & { pct: number }>();
  const flag = (pct: number, cat: string | null, lines: number | null, why: string) => {
    const id = `${pct}|${cat ?? ''}`;
    const prev = bad.get(id);
    if (prev) { prev.qty = (prev.qty ?? 0) + (lines ?? 0); return; }
    bad.set(id, { id, pct, label: why, qty: lines });
  };
  for (const r of facts.saleRates) {
    const pct = Number(r.taxPct);
    if (!Number.isFinite(pct) || pct < 0) { flag(pct, r.vatCategory, r.lines, `نسبة ضريبة غير صالحة (${String(r.taxPct)}) على ${r.lines} بنداً`); continue; }
    if (pct === 0) continue;
    const tax = templateSaleTax(tpl.taxes, pct);
    if (!tax) {
      flag(pct, null, r.lines, outputVatActive
        ? `نسبة ${pct}٪ بلا ضريبة مبيعات في القالب — ستُرحَّل ${autoSaleKey(pct)} بلا مربع إقرار`
        : `نسبة ${pct}٪ في دولة بلا ضريبة مخرجات نشطة — ستُرحَّل ضريبتها إلى المعلّق 911001`);
    } else if (sa && !tax.vatBox) {
      flag(pct, null, r.lines, `نسبة ${pct}٪ تقابل ${tax.key} بلا مربع إقرار`);
    }
  }
  if (useEvents) {
    for (const pct of input.eventStats!.autoSalePercents) {
      if (![...bad.values()].some((b) => b.pct === pct)) flag(pct, null, null, `احتاج الترحيل ${autoSaleKey(pct)} بلا مربع إقرار`);
    }
  }
  const items = [...bad.values()].sort((a, b) => a.pct - b.pct || byStr(a.id ?? '', b.id ?? '')).map(({ pct: _pct, ...it }) => it);
  const used = facts.saleRates.filter((r) => Number(r.taxPct) > 0).map((r) => Number(r.taxPct));
  const usedText = [...new Set(used)].sort((a, b) => a - b).map((p) => `${p}٪`).join('، ');
  return preflightCheck('P7', mode, {
    level,
    ok: items.length === 0,
    count: items.length,
    details: items.length
      ? `${items.length} نسبة ضريبة على مبيعات الفترة لا تقابل ضريبة بيعٍ بمربع إقرار في القالب — ${sa ? 'تُعرَّف قبل الربط (الإقرار السعودي لا يقبل ضريبة بلا مربع)' : 'راجعها قبل الربط'}.`
      : `كل نِسب ضريبة مبيعات الفترة${usedText ? ` (${usedText})` : ''} تقابل ضريبة بيع في القالب${sa ? ' بمربع إقرار' : ''}.`,
    items,
  });
}

export function evaluateP8(
  input: Pick<PreflightInput, 'mode' | 'receiptRouting' | 'draft'>,
  facts: Pick<PreflightFacts, 'receiptMethods'>,
): PreflightCheck {
  const problems: string[] = [];
  const items: PreflightItem[] = [];
  const byMethod = new Map<string, number>();
  for (const r of facts.receiptMethods) byMethod.set(r.base, (byMethod.get(r.base) ?? 0) + r.receipts);
  const unrouted: string[] = [];
  const unknown: string[] = [];
  for (const [m, n] of [...byMethod.entries()].sort((a, b) => byStr(a[0], b[0]))) {
    if (m === 'ONLINE') continue;
    if (!(ROUTED_METHODS as readonly string[]).includes(m)) {
      unknown.push(m);
      items.push({ id: m, label: `طريقة دفع غير معروفة «${m}» على ${n} سنداً`, qty: n });
      continue;
    }
    const route = input.receiptRouting[m as (typeof ROUTED_METHODS)[number]];
    if (route !== 'CUSTODY' && route !== 'DIRECT') {
      unrouted.push(m);
      items.push({ id: m, label: `«${baseMethodLabel(m)}» بلا مسار (عهدة المندوب أو الحساب مباشرة) — ${n} سنداً`, qty: n });
    }
  }
  if (unknown.length) problems.push(`طرق دفع غير معروفة: ${unknown.join('، ')}`);
  if (unrouted.length) problems.push(`طرق مستعملة بلا مسار في توجيه السندات: ${unrouted.join('، ')}`);
  const cashChosen = input.draft?.step3?.cashInvoiceRouting;
  if (cashChosen !== 'MAIN_CASH' && cashChosen !== 'CUSTODY') {
    problems.push('توجيه الفواتير النقدية (الصندوق الرئيسي أو عهدة المندوب) لم يُختر صراحةً في معالج الإعداد');
    items.push({ id: 'cashInvoiceRouting', label: 'اختر توجيه الفواتير النقدية في معالج الإعداد (الخطوة 3)' });
  }
  // الطرق المخصّصة تُعامل كأساسها في الدفاتر حتى خرائط طرق الدفع (L5) — تُعدَّد ولا تحجب
  const customNotes: string[] = [];
  for (const r of facts.receiptMethods) {
    if (!r.custom) continue;
    customNotes.push(r.custom.label);
    items.push({ id: r.custom.id, label: `«${r.custom.label}» تُعامَل كطريقتها الأساسية (${r.baseLabel}) حتى L5 — ${r.receipts} سنداً`, qty: r.receipts });
  }
  const customText = customNotes.length ? `؛ والطرق المخصّصة (${customNotes.join('، ')}) تُعامَل كطريقتها الأساسية حتى L5` : '';
  return preflightCheck('P8', input.mode, {
    ok: problems.length === 0,
    count: unknown.length + unrouted.length + (cashChosen === 'MAIN_CASH' || cashChosen === 'CUSTODY' ? 0 : 1),
    details: problems.length
      ? `${problems.join('؛ ')}${customText}.`
      : `كل طرق الدفع المستعملة منذ تاريخ الربط لها مسار، وتوجيه الفواتير النقدية مختار (${cashChosen === 'CUSTODY' ? 'عهدة المندوب' : 'الصندوق الرئيسي'})${customText}.`,
    items,
  });
}

export function evaluateP9(
  input: Pick<PreflightInput, 'mode' | 'costing'>,
  facts: Pick<PreflightFacts, 'inventoryMode' | 'unpricedBeforeCutover' | 'names'>,
): PreflightCheck {
  if (facts.inventoryMode === 'PERIODIC') {
    // الجرد الدوري (OD7): لا سطور مخزون افتتاحية ولا تكلفة مبيعات لكل بيع، فالرصيد بلا تكلفة لا يمسّ الدفاتر
    return preflightCheck('P9', input.mode, {
      ok: true, notApplicable: true,
      details: 'الشركة على الجرد الدوري (بلا مخزون الشركة): لا سطور مخزون افتتاحية تُقيَّم، فلا ينطبق.',
    });
  }
  const costing: CostingSummary | null = input.mode === 'FULL' ? (input.costing ?? null) : null;
  if (costing) {
    const list = costing.uncostedAtCutover;
    const products = new Set(list.map((u) => u.productId)).size;
    const neg = costing.negativeAtCutover.length;
    const negText = neg ? `، و${neg} رصيداً سالب الكمية في بداية السنة` : '';
    return preflightCheck('P9', 'FULL', {
      ok: list.length === 0,
      count: list.length,
      details: list.length
        ? `${list.length} رصيداً بلا تكلفة في بداية السنة (${products} صنفاً، كمية ${qtyText(costing.uncostedAtCutoverTotalQty)}) سيدخل الافتتاح بقيمة صفر — عبّئ تكلفتها (معالج تعبئة التكلفة) أو أقرّ بالصفر${negText}.`
        : `كل أرصدة المخزون في بداية السنة مقيَّمة بتكلفة${negText}.`,
      items: list.map((u) => ({
        id: `${u.productId}|${u.location}`,
        label: `${facts.names.products.get(u.productId) ?? u.productId} — ${locationLabelAr(u.location, facts.names.reps)}`,
        qty: u.uncostedQty,
      })),
    });
  }
  const rows = facts.unpricedBeforeCutover ?? [];
  const lines = rows.reduce((s, r) => s + r.lines, 0);
  return preflightCheck('P9', 'LIGHT', {
    ok: lines === 0,
    count: lines,
    details: lines
      ? `تقدير: ${lines} سطر وارد بلا سعر قبل بداية السنة على ${rows.length} صنفاً — قد يبقى منه رصيد بلا تكلفة في الافتتاح. المعاينة الكاملة تحسب الرصيد الفعلي.`
      : 'تقدير: لا وارد بلا سعر قبل بداية السنة، فلا رصيد بلا تكلفة متوقَّع في الافتتاح.',
    items: rows.map((r) => ({ id: r.productId, label: `${facts.names.products.get(r.productId) ?? r.productId} — أسطر وارد بلا سعر`, qty: r.lines })),
  });
}

export function evaluateP10(
  input: Pick<PreflightInput, 'mode' | 'linkedFrom' | 'timezone' | 'currency' | 'currencyDecimals' | 'costing'>,
  facts: Pick<PreflightFacts, 'receiptsFy' | 'names'>,
): PreflightCheck {
  const r = facts.receiptsFy;
  const dec = input.currencyDecimals;
  const holes = input.mode === 'FULL' && input.costing ? input.costing.holesFy : null;
  const mode: PreflightMode = holes ? 'FULL' : 'LIGHT';
  const parts: string[] = [];
  if (r.lines) {
    // نسبة مقرَّبة لأسفل بمنزلة: 99.96٪ لا تُعرض 100٪ وفيها سطر بلا سعر
    const pct = Math.floor((r.pricedLines * 1000) / r.lines) / 10;
    parts.push(`الوارد منذ ${input.linkedFrom}: ${r.lines} سطراً، المسعَّر منها ${r.pricedLines} (${pct}٪)`);
  } else {
    parts.push(`لا وارد منذ ${input.linkedFrom}`);
  }
  if (r.unclassifiedEntries) {
    parts.push(`${r.unclassifiedEntries} حركة وارد بلا مورّد (${r.unclassifiedNoVendor}) أو بلا نمط دفع (${r.unclassifiedNoMode}) بقيمة ${money(r.unclassifiedValueMilli, dec, input.currency)} — تُرحَّل إلى «بضاعة مستلمة لم تُفوتر» (211002) حتى تُصنَّف`);
  }
  if (holes && holes.count) {
    parts.push(`${holes.count} رصيداً سالباً سُدّ خلال السنة بفرق ${money(holes.varianceMilli, dec, input.currency)} على تكلفة المبيعات`);
  } else if (!holes) {
    parts.push('وحُفر الرصيد السالب تظهر في المعاينة الكاملة');
  }
  const ok = r.unpricedLines === 0 && r.unclassifiedEntries === 0 && (!holes || holes.count === 0);
  const items: PreflightItem[] = r.attention.map((e) => {
    const why: string[] = [];
    if (e.unpricedLines) why.push(`${e.unpricedLines} سطراً بلا سعر`);
    if (e.noVendor) why.push('بلا مورّد');
    if (e.noMode) why.push('بلا نمط دفع');
    return {
      id: e.id,
      label: `وارد${e.supplier ? ` «${e.supplier}»` : ''}: ${why.join('، ')}`,
      valueMilli: e.pricedValueMilli,
      date: localDate(e.createdAt, input.timezone),
    };
  });
  let total = r.attentionTotal;
  if (holes) {
    total += holes.count;
    for (const h of holes.sample) {
      items.push({
        id: h.key,
        label: `حفرة سالب: ${facts.names.products.get(h.productId) ?? h.productId} — ${locationLabelAr(h.location, facts.names.reps)}`,
        valueMilli: h.varianceMilli,
      });
    }
  }
  return preflightCheck('P10', mode, {
    ok,
    count: r.unpricedLines + r.unclassifiedEntries + (holes?.count ?? 0),
    valueMilli: r.unclassifiedValueMilli,
    details: `${parts.join('؛ ')}.`,
    items,
    itemsTotal: total,
  });
}

export function evaluateP11(
  input: Pick<PreflightInput, 'mode' | 'linkedFrom' | 'timezone' | 'currencyDecimals'>,
  facts: Pick<PreflightFacts, 'deletedReps' | 'adminInvoices' | 'futureDated'>,
): PreflightCheck {
  const dec = input.currencyDecimals;
  const parts: string[] = [];
  const items: PreflightItem[] = [];
  const reps = facts.deletedReps;
  if (reps.length) {
    parts.push(`${reps.length} مندوباً محذوفاً له حركات منذ ${input.linkedFrom} (سيارته وعهدته بمعرّفه المحذوف)`);
    for (const d of reps) {
      items.push({ id: d.repId, label: `مندوب محذوف ${d.repId}: ${d.vanLoads} حركة سيارة، ${d.receipts} سنداً، ${d.settlements} استلاماً` });
    }
  }
  const adm = facts.adminInvoices;
  if (adm.count) {
    parts.push(`${adm.count} فاتورة بأصناف بلا مندوب (فاتورة إدارة أو مندوب محذوف) تُخرج من المستودع وتعود إليه (OD8)`);
    for (const i of adm.sample) {
      items.push({ id: i.id, label: `فاتورة ${INVOICE_TYPE_AR[i.type] ?? i.type} ${i.number} بلا مندوب`, valueMilli: toMilli(i.total, dec), date: localDate(i.invoiceDate, input.timezone) });
    }
  }
  const fut = facts.futureDated;
  if (fut.count) {
    parts.push(`${fut.count} قيداً في حساب العملاء مؤرّخاً بعد الغد (خطأ تاريخ محتمل) يُرحَّل بتاريخه`);
    for (const e of fut.sample) {
      items.push({
        id: e.id, label: `قيد عميل مؤرّخ مستقبلاً: ${e.description}`,
        valueMilli: toMilli(e.debit ?? 0, dec) - toMilli(e.credit ?? 0, dec), date: localDate(e.entryDate, input.timezone),
      });
    }
  }
  const count = reps.length + adm.count + fut.count;
  return preflightCheck('P11', input.mode, {
    ok: count === 0,
    count,
    details: count
      ? `${parts.join('؛ ')}.`
      : `لا مناديب محذوفين بحركات منذ ${input.linkedFrom}، ولا فواتير أصناف بلا مندوب، ولا مستندات مؤرّخة مستقبلاً.`,
    items,
    itemsTotal: count,
  });
}

/** P12 لفاتورة واحدة: الإجمالي المخزَّن مقابل (الصافي − الخصم + الضريبة) — كل حدّ مقرَّب وحده إلى منازل العملة */
export function invoiceRoundingDiff(inv: { subtotal: number; discountAmt: number; taxAmt: number; total: number }, decimals: number) {
  const totalMilli = toMilli(inv.total ?? 0, decimals);
  const computedMilli = toMilli(inv.subtotal ?? 0, decimals) - toMilli(inv.discountAmt ?? 0, decimals) + toMilli(inv.taxAmt ?? 0, decimals);
  return { totalMilli, computedMilli, diffMilli: totalMilli - computedMilli };
}

export function evaluateP12(
  input: Pick<PreflightInput, 'mode' | 'linkedFrom' | 'timezone' | 'currency' | 'currencyDecimals'>,
  facts: Pick<PreflightFacts, 'rounding'>,
): PreflightCheck {
  const r = facts.rounding;
  const dec = input.currencyDecimals;
  const scope = r.limited ? `آخر ${r.scanned} فاتورة منذ ${input.linkedFrom}` : `${r.scanned} فاتورة منذ ${input.linkedFrom}`;
  return preflightCheck('P12', input.mode, {
    ok: r.count === 0,
    count: r.count,
    valueMilli: r.absSumMilli,
    details: r.count
      ? `${r.count} فاتورة من ${scope} يختلف إجماليها عن (الصافي − الخصم + الضريبة) بأكثر من أصغر وحدة عملة (مجموع الفروق ${money(r.absSumMilli, dec, input.currency)}) — يُرحَّل الفرق سطرَ تقريب.`
      : `إجماليات ${scope} تطابق (الصافي − الخصم + الضريبة) في حدود أصغر وحدة عملة.`,
    items: r.top.map((i) => ({
      id: i.id,
      label: `فاتورة ${i.number}: الإجمالي ${formatMilli(i.totalMilli, dec)} والمحسوب ${formatMilli(i.computedMilli, dec)}`,
      valueMilli: i.diffMilli,
      date: localDate(i.invoiceDate, input.timezone),
    })),
    itemsTotal: r.count,
  });
}

const VOLUME_SOURCE_LABELS: Readonly<Record<string, string>> = {
  ACCOUNT_ENTRY: 'قيود حساب العملاء (فواتير وسندات)',
  REP_SETTLEMENT: 'استلامات المناديب',
  SETTLEMENT_ENTRY: 'حركات أمانات الدفع الإلكتروني',
  COST_SOURCE: 'سطور حركات المخزون (لقطات التكلفة)',
};

export function evaluateP13(
  input: Pick<PreflightInput, 'mode' | 'eventStats' | 'costing'>,
  facts: Pick<PreflightFacts, 'volume'>,
): PreflightCheck {
  const fullEvents = input.mode === 'FULL' && input.eventStats ? input.eventStats : null;
  const v = facts.volume;
  let events: number;
  let snapshots: number;
  const items: PreflightItem[] = [];
  if (fullEvents) {
    events = fullEvents.eventsToPost;
    for (const [k, n] of Object.entries(fullEvents.byType).sort((a, b) => byStr(a[0], b[0]))) items.push({ id: k, label: `أحداث ${k}`, qty: n });
  } else {
    events = (v?.accountEntries ?? 0) + (v?.repSettlements ?? 0) + (v?.settlementEntries ?? 0);
    if (v) {
      items.push({ id: 'ACCOUNT_ENTRY', label: VOLUME_SOURCE_LABELS.ACCOUNT_ENTRY, qty: v.accountEntries });
      items.push({ id: 'REP_SETTLEMENT', label: VOLUME_SOURCE_LABELS.REP_SETTLEMENT, qty: v.repSettlements });
      items.push({ id: 'SETTLEMENT_ENTRY', label: VOLUME_SOURCE_LABELS.SETTLEMENT_ENTRY, qty: v.settlementEntries });
    }
  }
  const costing = input.mode === 'FULL' ? input.costing ?? null : null;
  if (costing) {
    snapshots = costing.moveCount;
  } else {
    snapshots = v?.costSourceRows ?? 0;
    if (v) items.push({ id: 'COST_SOURCE', label: VOLUME_SOURCE_LABELS.COST_SOURCE, qty: v.costSourceRows });
  }
  const est = estimateLinkVolume(events, snapshots);
  // FULL: الصفوف والبايتات المقيسة من الظلّ (قسم «الوقت والتخزين») إن وصلت — لا تقدير 9 صفوف/حدث بجوار رقمٍ مقيس
  const measured = fullEvents?.storage ?? null;
  const rows = measured ? measured.rows : est.rows;
  const overCap = events > PLATFORM_EVENT_CAP;
  const mb = ((measured ? measured.bytesEstimate : est.bytesEstimate) / 1_048_576).toFixed(1);
  const head = `${fullEvents ? '' : 'تقدير: '}≈ ${events} حدثاً للترحيل التاريخي و${snapshots} لقطة تكلفة ⇒ ≈ ${rows} صفاً (≈ ${mb} م.ب)، ووقت الترحيل ≈ ${est.etaMinutesOffPeak} دقيقة خارج الذروة (${est.etaMinutesPeakOnly} دقيقة إن اقتصر على ميزانية الذروة)`;
  const tail = overCap
    ? ` — يتجاوز سقف المنصّة ${PLATFORM_EVENT_CAP} حدث، فلا يُربط قبل رفع سعة القاعدة.`
    : events > P13_WARN_EVENTS
      ? ` — حجم كبير: ساعات من الترحيل ونموّ ملحوظ للقاعدة، أقرّ به.`
      : '.';
  return preflightCheck('P13', fullEvents ? 'FULL' : 'LIGHT', {
    level: overCap ? 'B' : 'W',
    ok: !overCap && events <= P13_WARN_EVENTS,
    count: events,
    details: head + tail,
    items,
  });
}

export function evaluateP14(input: Pick<PreflightInput, 'mode' | 'settingsRow'>): PreflightCheck {
  const s = input.settingsRow;
  // دفاتر يدوية مفعّلة (CLEAN) ⇒ التحويل إلى المربوطة مسارٌ مستقل (L9) بمراجعة القيود اليدوية — عبر mode.ts لا مقارنة حرفية
  if (s && s.activatedAt && bookMode(s) === 'MANUAL') {
    return preflightCheck('P14', input.mode, {
      ok: false,
      details: 'للشركة دفاتر يدوية مفعّلة: تحويلها إلى دفاتر مربوطة يأتي في مرحلة لاحقة (L9) بمراجعة القيود اليدوية واحداً واحداً، ولا يُربط من هنا.',
    });
  }
  return preflightCheck('P14', input.mode, { ok: true, notApplicable: true, details: 'لا دفاتر يدوية مفعّلة تحتاج تحويلاً.' });
}

/** كل الفحوص على الحقائق — صرف */
export function evaluatePreflight(input: PreflightInput, facts: PreflightFacts): PreflightReport {
  return preflightReport(input, [
    evaluateP1(input), evaluateP2(input), evaluateP3(input, facts), evaluateP4(input), evaluateP5(input, facts),
    evaluateP6(input, facts), evaluateP7(input, facts), evaluateP8(input, facts), evaluateP9(input, facts),
    evaluateP10(input, facts), evaluateP11(input, facts), evaluateP12(input, facts), evaluateP13(input, facts), evaluateP14(input),
  ]);
}

// ═══ القراءة ═══

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const chunks = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** P10: الوارد منذ بداية السنة بمسح مقسَّم (createdAt, id) — صفحتان لكل ألف حركة (الحركات ثم أسطرها) */
async function loadReceiptsFy(db: PreflightDb, tenantId: string, cutoverStart: Date, decimals: number): Promise<ReceiptsFyFacts> {
  const cap = PREVIEW_LIST_CAPS.preflightItems;
  const out: ReceiptsFyFacts = {
    entries: 0, lines: 0, pricedLines: 0, unpricedLines: 0, unclassifiedEntries: 0, unclassifiedNoVendor: 0, unclassifiedNoMode: 0,
    unclassifiedValueMilli: 0n, attention: [], attentionTotal: 0,
  };
  let after: { at: Date; id: string } | null = null;
  for (;;) {
    // مؤشّر مفتاحيّ (createdAt, id) > الأخير — لا OFFSET (يعيد مسح ما قبله في كل صفحة)
    // الحدّ الأدنى للنطاق = المؤشّر لا بداية السنة: Postgres لا يشتقّه من OR فتعود كل صفحة لمسح السنة من أولها
    const where: Prisma.WarehouseEntryWhereInput = {
      tenantId, type: 'RECEIVE', createdAt: { gte: after ? after.at : cutoverStart },
      ...(after ? { OR: [{ createdAt: { gt: after.at } }, { createdAt: after.at, id: { gt: after.id } }] } : {}),
    };
    const page = await db.warehouseEntry.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: PREFLIGHT_PAGE_SIZE,
      select: { id: true, createdAt: true, supplier: true, vendorId: true, paymentMode: true, items: { select: { qty: true, unitCost: true } } },
    });
    for (const e of page) {
      out.entries++;
      let unpriced = 0;
      let value = 0n;
      for (const it of e.items) {
        const q = Number(it.qty);
        if (!(Number.isFinite(q) && q > 0)) continue; // وارد سالب قديم يُعامَل تسويةً في المحرّك، لا تسعيراً
        out.lines++;
        const cost = it.unitCost;
        if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
          out.pricedLines++;
          // قيمة السطر بوحدته (الكمية والتكلفة كلتاهما بوحدة الصفّ) مقرَّبة وحدها — كـinValueMilli في المحرّك وR11
          value += toMilli(q * cost, decimals);
        } else {
          unpriced++;
        }
      }
      out.unpricedLines += unpriced;
      const noVendor = !e.vendorId;
      const noMode = !e.paymentMode;
      if (noVendor || noMode) {
        out.unclassifiedEntries++;
        if (noVendor) out.unclassifiedNoVendor++;
        if (noMode) out.unclassifiedNoMode++;
        out.unclassifiedValueMilli += value;
      }
      if (unpriced || noVendor || noMode) {
        out.attentionTotal++;
        if (out.attention.length < cap) {
          out.attention.push({ id: e.id, createdAt: e.createdAt, supplier: e.supplier ?? null, unpricedLines: unpriced, noVendor, noMode, pricedValueMilli: value });
        }
      }
    }
    if (page.length < PREFLIGHT_PAGE_SIZE) break;
    const last = page[page.length - 1];
    after = { at: last.createdAt, id: last.id };
  }
  return out;
}

/** P12: LIGHT آخر PREFLIGHT_LIGHT_ROUNDING_SCAN فاتورة باستعلام واحد، وFULL كل فواتير الفترة بمسح مقسَّم (invoiceDate, id) */
async function loadRounding(db: PreflightDb, tenantId: string, cutoverStart: Date, decimals: number, full: boolean): Promise<RoundingFacts> {
  const cap = PREVIEW_LIST_CAPS.preflightItems;
  const unit = unitMilli(decimals);
  const out: RoundingFacts = { scanned: 0, limited: false, count: 0, absSumMilli: 0n, top: [] };
  const select = { id: true, number: true, invoiceDate: true, subtotal: true, discountAmt: true, taxAmt: true, total: true } as const;
  const base: Prisma.InvoiceWhereInput = { tenantId, invoiceDate: { gte: cutoverStart }, status: { not: 'DRAFT' } };
  type RoundingRow = { id: string; number: string; invoiceDate: Date; subtotal: number; discountAmt: number; taxAmt: number; total: number };
  const fold = (rows: readonly RoundingRow[]) => {
    for (const inv of rows) {
      out.scanned++;
      const d = invoiceRoundingDiff(inv, decimals);
      if (absMilli(d.diffMilli) <= unit) continue;
      out.count++;
      out.absSumMilli += absMilli(d.diffMilli);
      out.top.push({ id: inv.id, number: inv.number, invoiceDate: inv.invoiceDate, ...d });
      // نافذة محدودة: نُبقي الأكبر فرقاً فقط (لا تراكم في الذاكرة)
      if (out.top.length > cap * 2) out.top = sortRoundingTop(out.top).slice(0, cap);
    }
  };
  if (!full) {
    const rows = await db.invoice.findMany({
      where: base, orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }], take: PREFLIGHT_LIGHT_ROUNDING_SCAN, select,
    });
    fold(rows);
    out.limited = rows.length >= PREFLIGHT_LIGHT_ROUNDING_SCAN;
  } else {
    let after: { at: Date; id: string } | null = null;
    for (;;) {
      const page: RoundingRow[] = await db.invoice.findMany({
        // الحدّ الأدنى = المؤشّر (after.at ≥ بداية السنة) لا بداية السنة — كمسح الوارد أعلاه
        where: {
          ...base,
          ...(after ? { invoiceDate: { gte: after.at }, OR: [{ invoiceDate: { gt: after.at } }, { invoiceDate: after.at, id: { gt: after.id } }] } : {}),
        },
        orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], take: PREFLIGHT_PAGE_SIZE, select,
      });
      fold(page);
      if (page.length < PREFLIGHT_PAGE_SIZE) break;
      const last: RoundingRow = page[page.length - 1];
      after = { at: last.invoiceDate, id: last.id };
    }
  }
  out.top = sortRoundingTop(out.top).slice(0, cap);
  return out;
}

function sortRoundingTop<T extends { diffMilli: Milli; invoiceDate: Date; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const x = absMilli(a.diffMilli);
    const y = absMilli(b.diffMilli);
    if (x !== y) return x > y ? -1 : 1;
    const t = a.invoiceDate.getTime() - b.invoiceDate.getTime();
    return t !== 0 ? t : byStr(a.id, b.id);
  });
}

/** كل ما تحتاجه الفحوص من القاعدة — قراءة فقط، استعلامات مجمّعة/مقسّمة بعدد ثابت لا يتبع حجم البيانات (عدا صفحات المسح) */
export async function loadPreflightFacts(db: PreflightDb, tenantId: string, input: PreflightInput): Promise<PreflightFacts> {
  const cutoverStart = zonedStartOfDay(input.linkedFrom, input.timezone);
  const dec = input.currencyDecimals;
  const full = input.mode === 'FULL';
  const costing = full ? input.costing ?? null : null;
  const eventStats = full ? input.eventStats ?? null : null;
  const cap = PREVIEW_LIST_CAPS.preflightItems;

  // الشركة: OD7 من مخزون الشركة (كـparams.ts)، والعملة والدولة وأسماء الطرق المخصّصة بقراءة واحدة
  // الوضع المحلول مع خيارات المعاينة/المسار أولاً (مصدرٌ واحد)، وإلا قاعدة OD7 نفسها في params.ts
  const inventoryMode: InventoryMode = input.inventoryMode
    ?? ((await db.tenant.findUnique({ where: { id: tenantId }, select: { warehouseEnabled: true } }))?.warehouseEnabled ? 'PERPETUAL' : 'PERIODIC');
  const cs = await db.companySettings.findUnique({
    where: { tenantId }, select: { countryCode: true, currency: true, currencyOverride: true },
  });
  const company = { currency: cs ? (cs.currencyOverride || cs.currency) : null, countryCode: (cs?.countryCode || 'SA').toUpperCase() };

  // P3: العملات المخالفة على كل الفواتير (الافتتاح يشمل ذمم ما قبل السنة) — GROUP BY لا صفوف
  const curGroups = await db.invoice.groupBy({ by: ['currency'], where: { tenantId, currency: { not: null } }, _count: { _all: true } });
  const invoiceCurrencies = curGroups
    .filter((g): g is typeof g & { currency: string } => typeof g.currency === 'string')
    .map((g) => ({ currency: g.currency, invoices: g._count._all }))
    .sort((a, b) => byStr(a.currency, b.currency));

  // P5
  const runningImport = await loadRunningImportBatch(db, tenantId, input.now);
  const batches = await db.importBatch.findMany({ where: { tenantId, reverted: false, kind: OPENING_STOCK_BATCH_KIND }, select: { id: true, recordIds: true } });
  const batchOf = new Map<string, string>();
  for (const b of [...batches].sort((a, b2) => byStr(a.id, b2.id))) for (const id of importBatchRecordIds(b.recordIds)) if (!batchOf.has(id)) batchOf.set(id, b.id);
  const nonImportEntries: PreflightFacts['openingStock']['nonImportEntries'] = [];
  for (const ids of chunks([...batchOf.keys()], PREFLIGHT_ID_CHUNK)) {
    const rows = await db.warehouseEntry.findMany({
      where: { tenantId, id: { in: ids }, source: { not: OPENING_IMPORT_SOURCE } }, select: { id: true, source: true, createdAt: true },
    });
    for (const r of rows) nonImportEntries.push({ id: r.id, batchId: batchOf.get(r.id) ?? '', source: r.source, createdAt: r.createdAt });
  }
  nonImportEntries.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byStr(a.id, b.id));

  // P6: الدالّة نفسها التي يستعملها فحص C14 (قراءتان: الشركة والتكامل — لا gl*)
  const odooActive = await createPrismaCheckStore(db).erpOdooActive(tenantId);

  // P7: نِسب بنود فواتير الفترة غير المعفاة — GROUP BY على البنود بقيد الفاتورة
  const rateGroups = await db.invoiceItem.groupBy({
    by: ['taxPct', 'vatCategory'],
    where: { invoice: { tenantId, invoiceDate: { gte: cutoverStart }, taxFree: false, status: { not: 'DRAFT' } } },
    _count: { _all: true },
  });
  const saleRates = rateGroups
    .map((g) => ({ taxPct: g.taxPct, vatCategory: g.vatCategory ?? null, lines: g._count._all }))
    .sort((a, b) => a.taxPct - b.taxPct || byStr(a.vatCategory ?? '', b.vatCategory ?? ''));

  // P8: طرق سندات الفترة — من نطاق «طرق الدفع» (الأساس واسم المخصّصة للعرض؛ الدفاتر لا تقرأ المفتاح ولا الإعداد)
  const receiptMethods = await loadReceiptMethodUsage(db, tenantId, cutoverStart);

  // P9 LIGHT: أسطر وارد بلا سعر قبل بداية السنة لكل صنف (لا يُحتاج مع محرّك التكلفة ولا في الجرد الدوري)
  let unpricedBeforeCutover: PreflightFacts['unpricedBeforeCutover'] = null;
  if (inventoryMode === 'PERPETUAL' && !costing) {
    const g = await db.warehouseEntryItem.groupBy({
      by: ['productId'],
      where: {
        entry: { tenantId, type: 'RECEIVE', createdAt: { lt: cutoverStart } },
        qty: { gt: 0 },
        OR: [{ unitCost: null }, { unitCost: { lte: 0 } }],
      },
      _count: { _all: true },
    });
    unpricedBeforeCutover = g.map((r) => ({ productId: r.productId, lines: r._count._all })).sort((a, b) => b.lines - a.lines || byStr(a.productId, b.productId));
  }

  // P10
  const receiptsFy = await loadReceiptsFy(db, tenantId, cutoverStart, dec);

  // P11: المناديب المحذوفون (GROUP BY على ثلاثة مصادر)، وفواتير الأصناف بلا مندوب، والمؤرّخ مستقبلاً — عدٌّ وعيّنة محدودة
  const [vlDel, rcDel, stDel] = [
    await db.vanLoad.groupBy({ by: ['deletedSalesRepId'], where: { tenantId, deletedSalesRepId: { not: null }, createdAt: { gte: cutoverStart } }, _count: { _all: true } }),
    await db.receipt.groupBy({ by: ['deletedSalesRepId'], where: { tenantId, deletedSalesRepId: { not: null }, receiptDate: { gte: cutoverStart } }, _count: { _all: true } }),
    // استلامات المحذوفين وحدهم بمرشّحها المسمّى (حارس rep-delete-keeps-settlements): تشخيصٌ لا رصيد
    await db.repSettlement.groupBy({ by: ['deletedSalesRepId'], where: { tenantId, ...SETTLEMENT_OF_DELETED_REP, settledAt: { gte: cutoverStart } }, _count: { _all: true } }),
  ];
  const del = new Map<string, { repId: string; vanLoads: number; receipts: number; settlements: number }>();
  const bump = (id: string | null, k: 'vanLoads' | 'receipts' | 'settlements', n: number) => {
    if (!id) return;
    const row = del.get(id) ?? { repId: id, vanLoads: 0, receipts: 0, settlements: 0 };
    row[k] += n;
    del.set(id, row);
  };
  for (const g of vlDel) bump(g.deletedSalesRepId, 'vanLoads', g._count._all);
  for (const g of rcDel) bump(g.deletedSalesRepId, 'receipts', g._count._all);
  for (const g of stDel) bump(g.deletedSalesRepId, 'settlements', g._count._all);
  const deletedReps = [...del.values()].sort((a, b) => byStr(a.repId, b.repId));

  // فواتير بأصناف بلا مندوب (OD8، D14) — الإشعار المدين بلا أصناف في المحرّك فيُستثنى (documentKind قد يكون null للقديم)
  const adminWhere: Prisma.InvoiceWhereInput = {
    tenantId, salesRepId: null, invoiceDate: { gte: cutoverStart }, status: { not: 'DRAFT' }, type: { in: ['CASH', 'CREDIT', 'RETURN'] },
    AND: [{ OR: [{ documentKind: null }, { documentKind: { not: 'DEBIT_NOTE' } }] }],
    items: { some: { productId: { not: null } } },
  };
  const adminCount = await db.invoice.count({ where: adminWhere });
  const adminSample = adminCount
    ? await db.invoice.findMany({
      where: adminWhere, orderBy: [{ invoiceDate: 'asc' }, { id: 'asc' }], take: cap,
      select: { id: true, number: true, type: true, invoiceDate: true, total: true },
    })
    : [];

  const futureAfter = new Date(input.now.getTime() + FUTURE_DATED_SLACK_MS);
  const futWhere: Prisma.AccountEntryWhereInput = { tenantId, entryDate: { gt: futureAfter } };
  const futCount = await db.accountEntry.count({ where: futWhere });
  const futSample = futCount
    ? await db.accountEntry.findMany({
      where: futWhere, orderBy: [{ entryDate: 'desc' }, { id: 'asc' }], take: cap,
      select: { id: true, entryDate: true, debit: true, credit: true, description: true },
    })
    : [];

  // P12
  const rounding = await loadRounding(db, tenantId, cutoverStart, dec, full);

  // P13 LIGHT: صفوف المصادر المُطابَقة منذ المؤشّر الابتدائي (OPENING بـT0 من الآن)، وصفوف مصادر التكلفة (حدّ أعلى للّقطات)
  let volume: VolumeSourceFacts | null = null;
  if (!eventStats || !costing) {
    const watermarkAt = initialWatermarkAt({
      method: 'OPENING', cutoverDate: input.linkedFrom, openingSnapshotAt: openingSnapshotFromDbNow(input.now), timezone: input.timezone,
    });
    let accountEntries = 0;
    let repSettlements = 0;
    let settlementEntries = 0;
    if (!eventStats) {
      accountEntries = await db.accountEntry.count({ where: { tenantId, createdAt: { gte: watermarkAt } } });
      repSettlements = await db.repSettlement.count({ where: { tenantId, ...SETTLEMENT_HAS_REP, createdAt: { gte: watermarkAt } } });
      settlementEntries = await db.settlementEntry.count({ where: { tenantId, createdAt: { gte: watermarkAt } } });
    }
    let costSourceRows = 0;
    if (!costing) {
      costSourceRows += await db.warehouseEntryItem.count({ where: { entry: { tenantId } } });
      costSourceRows += await db.vanLoadItem.count({ where: { vanLoad: { tenantId } } });
      costSourceRows += await db.invoiceItem.count({ where: { invoice: { tenantId }, productId: { not: null } } });
    }
    volume = { watermarkAt, accountEntries, repSettlements, settlementEntries, costSourceRows };
  }

  // الأسماء بدفعة واحدة لكل نوع (عناصر P9 وحُفر P10 — حتى 50 لكلٍّ)
  const productIds = new Set<string>();
  const repIds = new Set<string>();
  const addLoc = (loc: LocationKey) => { const r = repOfLocation(loc); if (r) repIds.add(r); };
  if (inventoryMode === 'PERPETUAL') {
    if (costing) {
      for (const u of costing.uncostedAtCutover.slice(0, cap)) { productIds.add(u.productId); addLoc(u.location); }
    } else {
      for (const u of (unpricedBeforeCutover ?? []).slice(0, cap)) productIds.add(u.productId);
    }
  }
  if (costing) for (const h of costing.holesFy.sample.slice(0, cap)) { productIds.add(h.productId); addLoc(h.location); }
  const products = new Map<string, string>();
  if (productIds.size) {
    const rows = await db.product.findMany({ where: { tenantId, id: { in: [...productIds].sort(byStr) } }, select: { id: true, name: true } });
    for (const p of rows) products.set(p.id, p.name);
  }
  const reps = new Map<string, string>();
  if (repIds.size) {
    const rows = await db.salesRep.findMany({ where: { tenantId, id: { in: [...repIds].sort(byStr) } }, select: { id: true, name: true } });
    for (const r of rows) reps.set(r.id, r.name);
  }

  return {
    inventoryMode, company, invoiceCurrencies, runningImport,
    openingStock: { batches: batches.length, nonImportEntries },
    odooActive, saleRates, receiptMethods, unpricedBeforeCutover, receiptsFy,
    deletedReps,
    adminInvoices: { count: adminCount, sample: adminSample.map((i) => ({ id: i.id, number: i.number, type: i.type, invoiceDate: i.invoiceDate, total: i.total })) },
    futureDated: { count: futCount, sample: futSample.map((e) => ({ id: e.id, entryDate: e.entryDate, debit: e.debit, credit: e.credit, description: e.description })) },
    rounding, volume,
    names: { products, reps },
  };
}

/** الفحوص المسبقة P1..P14 (العقد §12) — قراءة تشغيلية فقط على db (معاملة اللقطة أو العميل الحارس في الظلّ) */
export async function runPreflight(db: PreflightDb, tenantId: string, input: PreflightInput): Promise<PreflightReport> {
  const facts = await loadPreflightFacts(db, tenantId, input);
  return evaluatePreflight(input, facts);
}
