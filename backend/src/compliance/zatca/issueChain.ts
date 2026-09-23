// ============================================================================
// ZATCA المرحلة الثانية (Z5.2) — تخصيص السلسلة ICV/PIH تحت قفل صفّ الوحدة (منطق نقيّ + واجهة المخزن)
// ----------------------------------------------------------------------------
// z5_plan §2.2 الخطوات 1 و8 + design Z5.3 + نقد الخطة (8، 9، 12، 19، 34):
//   • رأس السلسلة يُقرأ داخل المعاملة بعد SELECT … FOR UPDATE على صفّ الوحدة (أول قفل)، ثم — في جملة **مستقلة** — ذيلها: المستند
//     الذي ICV = lastIcv (JOIN مع القفل في جملة واحدة يعيد تقييم الصفّ المقفل بلقطة قديمة للجدول الآخر في READ COMMITTED فيرى
//     الذيل الذي التزمه الحامل السابق مفقوداً).
//   • الحارس (fencing، نقد 34): الوحدة ACTIVE، وkeyVersion = نسخة المفتاح الذي فُتح قبل المعاملة (تجديد بينهما ⇒ ZATCA_UNIT_BUSY
//     قابل للإعادة بمفتاح جديد)، ورقمها الضريبي = رقم المنشأة الحالي (SELLER_VAT_CHANGED، نقد 12)، وسلامة الذيل: lastIcv = 0 بلا
//     تجزئة ولا مستند، أو ذيل موجود ICV وتجزئته = lastIcv وlastInvoiceHash. أي خلل ⇒ ZATCA_CHAIN_CONFLICT (تنبيه، بلا إعادة).
//   • ICV الجديد = lastIcv + 1، وPIH = lastInvoiceHash ?? INITIAL_PIH. التقدّم نفسه CAS في documentStore.advanceUnitChain
//     (status='ACTIVE' AND lastIcv = icv−1) — حارس ثانٍ داخل القفل.
//   • لحظة الإصدار بعد القفل (نقد 19) ولا تسبق IssueDate/IssueTime للذيل: ساعة متأخرة قليلاً ⇒ لحظة الذيل نفسها (الثانية نفسها)؛
//     تأخّر أكبر من السماح ⇒ ZATCA_STAMP_FAILED (تنبيه) بدل سلسلة يسبق فيها ICV أكبر وقتاً أصغر.
// لا قاعدة بيانات هنا (المحوّل في issueStore.prisma.ts) ولا services/gl.
// ============================================================================

import { INITIAL_PIH } from './crypto';
import type { LockedUnitRow } from './documentStore';
import { unitUnavailableError, ZatcaHttpError, type UnitUnavailableReason } from './errors';
import { isIsoDate, isIsoTime } from './time';

/** المستند صاحب ICV = lastIcv (آخر حلقة ملتزَمة). */
export interface ChainTail {
  icv: number;
  invoiceHash: string;
  issueDate: string;
  issueTime: string;
}

export interface ChainHead {
  unit: LockedUnitRow;
  tail: ChainTail | null;
}

/** Tx = مقبض معاملة المحوّل. */
export interface IssuanceChainStore<Tx = unknown> {
  /** SELECT … FOR UPDATE على صفّ الوحدة ثم قراءة الذيل (جملتان). null = لا وحدة. */
  lockChainHead(tx: Tx, unitId: string): Promise<ChainHead | null>;
}

/** الوحدة كما فُتح مفتاحها قبل المعاملة. */
export interface ExpectedIssuanceUnit {
  id: string;
  tenantId: string;
  keyVersion: number;
  vatNumber: string;
}

export interface ChainSlot {
  unitId: string;
  icv: number;
  pih: string;
  tail: ChainTail | null;
}

/** أقصى ICV (عمود Int في Postgres). */
export const MAX_ICV = 2_147_483_647;
/** تجزئة SHA-256 بـbase64 (44 محرفاً بحشو واحد). */
const HASH_RE = /^[A-Za-z0-9+/]{43}=$/;
/** سماح تأخّر ساعة الخادم عن لحظة الذيل قبل رفض الإصدار. */
export const CLOCK_SKEW_TOLERANCE_MS = 120_000;

export function chainConflictError(code: string): ZatcaHttpError {
  return new ZatcaHttpError('ZATCA_CHAIN_CONFLICT', { logDetail: { source: 'CHAIN', code } });
}

const STATUS_REASON: Readonly<Record<string, UnitUnavailableReason>> = Object.freeze({
  RENEWING: 'RENEWING', AUTH_FAILED: 'AUTH_FAILED', EXPIRED: 'EXPIRED',
});

/** حالة وحدة غير ACTIVE ⇒ سبب عدم التوفّر المعروض. */
export function unavailableForStatus(status: string, source = 'CHAIN'): ZatcaHttpError {
  return unitUnavailableError(STATUS_REASON[status] ?? 'NO_ACTIVE_UNIT', { source, code: `status:${String(status).slice(0, 24)}` });
}

/**
 * نقيّ: الخانة التالية في السلسلة من الرأس المقفل، أو يرمي ZatcaHttpError. sellerVat = CompanySettings.taxNumber الحالي
 * (undefined ⇒ لا مقارنة).
 */
export function nextChainSlot(head: ChainHead | null, expected: ExpectedIssuanceUnit, sellerVat?: string | null): ChainSlot {
  if (!head) return fail(unitUnavailableError('NO_ACTIVE_UNIT', { source: 'CHAIN', code: 'missing' }));
  const u = head.unit;
  if (u.id !== expected.id || u.tenantId !== expected.tenantId) return fail(unitUnavailableError('UNIT_CONFIG', { source: 'CHAIN', code: 'unit-mismatch' }));
  if (u.status !== 'ACTIVE') return fail(unavailableForStatus(u.status));
  if (u.keyVersion !== expected.keyVersion) {
    return fail(new ZatcaHttpError('ZATCA_UNIT_BUSY', { logDetail: { source: 'CHAIN', code: 'KEY_VERSION' } }));
  }
  if (u.vatNumber !== expected.vatNumber || (sellerVat !== undefined && (sellerVat ?? null) !== u.vatNumber)) {
    return fail(unitUnavailableError('SELLER_VAT_CHANGED', { source: 'CHAIN', code: 'vat' }));
  }
  const last = u.lastIcv;
  if (!Number.isSafeInteger(last) || last < 0) return fail(chainConflictError('LAST_ICV_INVALID'));
  if (last >= MAX_ICV) return fail(chainConflictError('ICV_EXHAUSTED'));
  if (last === 0) {
    if (u.lastInvoiceHash !== null || head.tail !== null) return fail(chainConflictError('HEAD_ZERO_NOT_EMPTY'));
    return { unitId: u.id, icv: 1, pih: INITIAL_PIH, tail: null };
  }
  const hash = u.lastInvoiceHash;
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return fail(chainConflictError('LAST_HASH_INVALID'));
  const tail = head.tail;
  if (!tail) return fail(chainConflictError('TAIL_MISSING'));
  if (tail.icv !== last || tail.invoiceHash !== hash) return fail(chainConflictError('TAIL_MISMATCH'));
  if (!isIsoDate(tail.issueDate) || !isIsoTime(tail.issueTime)) return fail(chainConflictError('TAIL_TIME_INVALID'));
  return { unitId: u.id, icv: last + 1, pih: hash, tail };
}

function fail(e: ZatcaHttpError): never {
  throw e;
}

/** لحظة الذيل (IssueDate + IssueTime بتوقيت الرياض الثابت UTC+3). */
export function tailInstant(tail: Pick<ChainTail, 'issueDate' | 'issueTime'>): Date {
  return new Date(`${tail.issueDate}T${tail.issueTime}+03:00`);
}

/**
 * نقد 19: لحظة الإصدار تُؤخذ بعد القفل ولا تسبق الذيل. الساعة متأخرة ≤ السماح ⇒ لحظة الذيل (ثانيته نفسها)؛ أكثر ⇒ يرمي.
 */
export function issuedAtAfter(now: Date, tail: ChainTail | null, toleranceMs: number = CLOCK_SKEW_TOLERANCE_MS): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw chainConflictError('CLOCK_INVALID');
  if (!tail) return new Date(now.getTime());
  const t = tailInstant(tail).getTime();
  if (!Number.isFinite(t)) throw chainConflictError('TAIL_TIME_INVALID');
  if (now.getTime() >= t) return new Date(now.getTime());
  if (t - now.getTime() <= toleranceMs) return new Date(t);
  throw new ZatcaHttpError('ZATCA_STAMP_FAILED', { logDetail: { source: 'CHAIN', code: 'CLOCK_BEHIND' } });
}
