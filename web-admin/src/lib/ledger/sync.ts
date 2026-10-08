import type { CheckKey, CheckStatus, EventAction, EventNote, EventStatus, PostingState } from '../../api/ledgerReview';
import { milliToDecimalString } from './format';

/**
 * تسميات «مراجعة» و«العملاء» في الدفاتر (M3) — صرفة ومختبَرة في sync.test.ts، بنداءات tr حرفية.
 * نصوص الخادم العربية (عناوين الفحوص وملخصاتها ورسائل الخطأ) لا تُعرض خاماً في الواجهة غير العربية (§8.7).
 */

type Tr = (ar: string) => string;

export const eventStatusLabels = (tr: Tr): Record<EventStatus, string> => ({
  PENDING: tr('بانتظار الترحيل'),
  DONE: tr('مُرحّل'),
  SKIPPED: tr('متخطّى'),
  BLOCKED: tr('محجوب مؤقتا'),
  ERROR: tr('خطأ'),
  HELD: tr('موقوف'),
});

export const postingStateLabels = (tr: Tr): Record<PostingState, string> => ({
  NOT_SYNCED: tr('لم يُلتقط بعد'),
  PENDING: tr('بانتظار الترحيل'),
  BLOCKED: tr('محجوب مؤقتا'),
  ERROR: tr('خطأ'),
  HELD: tr('موقوف'),
  POSTED: tr('مُرحّل'),
  IN_OPENING: tr('ضمن القيد الافتتاحي'),
  SKIPPED: tr('متخطّى'),
  REVERSE_PENDING: tr('العكس بانتظار الترحيل'),
  REVERSED: tr('معكوس'),
});

export type Tone = 'green' | 'amber' | 'red' | 'gray' | 'blue';

export function postingTone(state: PostingState): Tone {
  switch (state) {
    case 'POSTED': return 'green';
    case 'IN_OPENING': case 'REVERSED': case 'SKIPPED': return 'gray';
    case 'ERROR': case 'HELD': return 'red';
    case 'BLOCKED': case 'REVERSE_PENDING': return 'amber';
    default: return 'blue';
  }
}

export function eventTone(status: EventStatus): Tone {
  switch (status) {
    case 'DONE': return 'green';
    case 'SKIPPED': return 'gray';
    case 'ERROR': case 'HELD': return 'red';
    case 'BLOCKED': return 'amber';
    default: return 'blue';
  }
}

export const checkStatusTone = (s: CheckStatus): Tone => (s === 'GREEN' ? 'green' : s === 'YELLOW' ? 'amber' : 'red');

export const TONE_CLASSES: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700',
  amber: 'bg-amber-50 text-amber-800',
  red: 'bg-[#FBE3DF] text-[#8E2A1F]',
  gray: 'bg-[#F1EBDF] text-[#6E6557]',
  blue: 'bg-sky-50 text-sky-800',
};

export const skipReasonLabels = (tr: Tr): Record<string, string> => ({
  OPENING: tr('مشمول بالقيد الافتتاحي'),
  NETTED: tr('تقاصّ مع عكسه'),
  MANUAL: tr('تخطّاه المسؤول'),
  NEVER_MATERIALIZED: tr('أُنشئ وحُذف قبل ترحيله'),
  ZERO_VALUE: tr('قيمة صفرية'),
});

export const sourceTypeLabels = (tr: Tr): Record<string, string> => ({
  INVOICE: tr('فاتورة'),
  RECEIPT: tr('سند قبض'),
  AR_ENTRY: tr('قيد ذمم مستورد'),
  SETTLEMENT: tr('استلام تحصيل'),
  PAYLINK_FEE: tr('عمولة دفع إلكتروني'),
  PAYOUT: tr('توريد أمانات'),
  WH_ENTRY: tr('حركة مستودع'),
  VAN_LOAD: tr('تحميل سيارة'),
  RESTOCK: tr('إرجاع للمخزون'),
  CUSTOMER_ADJUSTMENT: tr('تسوية ذمة عميل'),
});

export const sourceEventLabels = (tr: Tr): Record<string, string> => ({
  POST: tr('ترحيل'),
  REVERSE: tr('عكس'),
  COGS: tr('تكلفة المبيعات'),
  RESTOCK: tr('إرجاع للمخزون'),
});

/** سبب الإيقاف أو الحجب أو الانتظار المفكوك (decodeEventNote في الخادم) ⇒ نص مترجم. */
export function eventNoteText(tr: Tr, note: EventNote | null | undefined): string | null {
  if (!note) return null;
  if (note.kind === 'ERROR') return note.message;
  const labels: Record<string, string> = {
    CURRENCY_MISMATCH: tr('عملة المستند تختلف عن عملة الدفاتر'),
    MISSING_MAPPING: tr('حساب مربوط غير موجود أو مؤرشف'),
    SOURCE_NOT_FOUND: tr('المستند المصدر غير موجود'),
    UNEXPECTED_ENTRY_SHAPE: tr('شكل قيد غير متوقع في كشف الحساب'),
    SIBLING_NOT_FINAL: tr('بانتظار ترحيل الحدث الأصلي'),
    AWAITING_RECONCILER: tr('بانتظار التقاط المستند'),
    SETTLEMENT_ORDER: tr('بانتظار ترحيل سندات المندوب السابقة'),
    INVENTORY_HORIZON: tr('بانتظار أفق المخزون'),
    INVENTORY_HEAD_OF_LINE: tr('بانتظار حدث مخزون سابق'),
  };
  const text = labels[note.reason] ?? note.reason;
  return 'detail' in note && note.detail ? `${text} (${note.detail})` : text;
}

/** الإجراءات المسموحة لحالة الحدث — مرآة EVENT_ACTION_ALLOWED في services/gl/checks/eventActions.ts. */
export const EVENT_ACTION_ALLOWED: Readonly<Record<EventAction, readonly EventStatus[]>> = {
  retry: ['ERROR', 'BLOCKED'],
  release: ['HELD'],
  skip: ['PENDING', 'BLOCKED', 'ERROR', 'HELD'],
};

export function eventActionsFor(status: EventStatus): EventAction[] {
  return (['retry', 'release', 'skip'] as const).filter(a => EVENT_ACTION_ALLOWED[a].includes(status));
}

export const checkTitles = (tr: Tr): Record<CheckKey, string> => ({
  C1: tr('توازن القيود'),
  C2: tr('الأرصدة الشهرية'),
  C3: tr('ذمم العملاء'),
  C4: tr('عهدة المناديب'),
  C4b: tr('العهدة مقابل الشاشة التشغيلية'),
  C5: tr('أمانات الدفع الإلكتروني'),
  C8: tr('أحداث الترحيل الآلي'),
  C9: tr('الحسابات المعلّقة'),
  C10: tr('المسودات قبل الإقفال'),
  C11: tr('ضرائب غير مربوطة بمربع'),
  C12: tr('تسلسل الترقيم'),
  C14: tr('ازدواج القيد مع ERP'),
  C15: tr('تأخّر مؤشر المزامنة'),
});

export const checkStatusLabels = (tr: Tr): Record<CheckStatus, string> => ({
  GREEN: tr('سليم'),
  YELLOW: tr('يحتاج متابعة'),
  RED: tr('خلل'),
});

/** فحوص يُتاح منها قيد تصحيح حساب رئيسي (§5.9، C6 من M9). */
export const CONTROL_ADJUSTABLE: readonly CheckKey[] = ['C3', 'C4', 'C5'];

/** مبلغ ملّي نصي من الخادم ⇒ نص عشري لـLedgerAmount (null ⇒ «0»). */
export const milliAmount = (m: string | null | undefined): string => (m === null || m === undefined ? '0' : milliToDecimalString(m));

/** صفوف أعمدة المبلغ في تعمّق الفحص: المفاتيح المنتهية بـMilli. */
export const isMilliKey = (k: string): boolean => /Milli$/.test(k);

/**
 * رابط المستند التشغيلي لمصدر قيد أو حدث (§6.1 «المصدر: <المستند>»): الصفحات القائمة لا تفتح مستنداً بمعرّفه،
 * فالعميل يُفتح بملفه (`/app/customers?open=`) والباقي بصفحة قائمته.
 */
export function sourceDocumentHref(sourceType: string | null | undefined, opts: { customerId?: string | null } = {}): string | null {
  switch (sourceType) {
    case 'INVOICE':
    case 'CUSTOMER_ADJUSTMENT':
    case 'AR_ENTRY':
      return opts.customerId ? `/app/customers?open=${encodeURIComponent(opts.customerId)}` : sourceType === 'INVOICE' ? '/app/invoices' : '/app/customers';
    case 'RECEIPT':
      return opts.customerId ? `/app/customers?open=${encodeURIComponent(opts.customerId)}` : '/app/receipts';
    case 'SETTLEMENT': return '/app/sales-reps';
    case 'PAYLINK_FEE':
    case 'PAYOUT': return '/app/paylink';
    case 'WH_ENTRY': return '/app/warehouse';
    case 'VAN_LOAD':
    case 'RESTOCK': return '/app/van-stock';
    default: return null;
  }
}

/** مفتاح المصدر ⇒ رابط قائمة الأحداث مفلترة به. */
export const eventsHrefFor = (sourceKeyOrId: string): string => `/app/ledger/review/events?q=${encodeURIComponent(sourceKeyOrId)}`;
