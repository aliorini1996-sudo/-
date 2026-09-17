/**
 * فحوصات سلامة الدفاتر (M3، DESIGN.md §5.9 REV‑03) — الأنواع المشتركة.
 *
 * النتيجة أخضر أو أصفر أو أحمر لكل فحص، مع صفوف تعمّق (مبالغ نصية لا BigInt) واقتراح إصلاح.
 * الفحوصات في M3: C1 إلى C5 وC4b وC8 إلى C12 وC14 وC15 (C6 في M9، C7 في M6، C13 في M12، C16/C17 لاحقاً).
 */
import type { Milli } from '../types';

export const CHECK_KEYS = ['C1', 'C2', 'C3', 'C4', 'C4b', 'C5', 'C8', 'C9', 'C10', 'C11', 'C12', 'C14', 'C15'] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export function isCheckKey(v: unknown): v is CheckKey {
  return typeof v === 'string' && (CHECK_KEYS as readonly string[]).includes(v);
}

export const CHECK_STATUSES = ['GREEN', 'YELLOW', 'RED'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** الفحوصات التي يُنشأ من تعمّقها «قيد تصحيح حساب رئيسي» (§5.9؛ C6 من M9) */
export const CONTROL_ADJUSTABLE_CHECKS = ['C3', 'C4', 'C5'] as const;
export type ControlAdjustableCheck = (typeof CONTROL_ADJUSTABLE_CHECKS)[number];

export function isControlAdjustableCheck(v: unknown): v is ControlAdjustableCheck {
  return typeof v === 'string' && (CONTROL_ADJUSTABLE_CHECKS as readonly string[]).includes(v);
}

/** اقتراح الإصلاح المعروض في التعمّق */
export type CheckFix =
  | 'REBUILD_BALANCES'
  | 'CONTROL_ADJUSTMENT'
  | 'REVIEW_EVENTS'
  | 'REVIEW_DRAFTS'
  | 'REVIEW_SUSPENSE'
  | 'CONFIGURE_TAXES'
  | 'SYNC_NOW'
  | 'DISABLE_ERP_POSTING';

/** صف تعمّق: قيم قابلة للتسلسل JSON (المبالغ ملّي نصاً) */
export type CheckRow = Record<string, string | number | boolean | null | readonly unknown[] | Record<string, unknown>>;

export interface CheckResult {
  key: CheckKey;
  status: CheckStatus;
  /** عنوان عربي ثابت (الواجهة تترجمه بـtr) */
  title: string;
  /** وصف عربي مختصر للنتيجة */
  summary: string;
  /** مقاييس رأسية (مجاميع، عدد، تأخّر…) */
  metrics: Record<string, string | number | boolean | null>;
  /** أول CHECK_ROW_LIMIT صف تعمّق */
  rows: CheckRow[];
  /** العدد الكلي قبل القص */
  rowCount: number;
  fix: CheckFix | null;
}

export interface ChecksReport {
  tenantId: string;
  ranAt: string;
  durationMs: number;
  overall: CheckStatus;
  results: CheckResult[];
}

export const CHECK_ROW_LIMIT = 200;

/** عناوين الفحوصات (عربية، تُترجم في الواجهة) */
export const CHECK_TITLES: Readonly<Record<CheckKey, string>> = {
  C1: 'توازن القيود',
  C2: 'الأرصدة الشهرية',
  C3: 'ذمم العملاء',
  C4: 'عهدة المناديب',
  C4b: 'العهدة مقابل الشاشة التشغيلية',
  C5: 'أمانات الدفع الإلكتروني',
  C8: 'أحداث الترحيل الآلي',
  C9: 'الحسابات المعلّقة',
  C10: 'المسودات قبل الإقفال',
  C11: 'ضرائب غير مربوطة بمربع',
  C12: 'تسلسل الترقيم',
  C14: 'ازدواج القيد مع ERP',
  C15: 'تأخّر مؤشر المزامنة',
};

const RANK: Record<CheckStatus, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  let w: CheckStatus = 'GREEN';
  for (const s of statuses) if (RANK[s] > RANK[w]) w = s;
  return w;
}

export const milliText = (m: Milli | null | undefined): string | null => (m === null || m === undefined ? null : m.toString());

export function limitRows<T>(rows: readonly T[], limit = CHECK_ROW_LIMIT): T[] {
  return rows.slice(0, limit);
}
