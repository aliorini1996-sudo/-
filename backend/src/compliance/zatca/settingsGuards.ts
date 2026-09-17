// ============================================================================
// ZATCA المرحلة الثانية (Z5.0) — حارسان نقيّان على مسارات قائمة (بلا قاعدة بيانات)
// ----------------------------------------------------------------------------
// • D9/F13 (PUT /api/company): بعد التفعيل الحيّ (zatcaPhase2StartedAt) لا تتغيّر الدولة ولا العملة ولا تجاوزها ولا مزوّد
//   الفوترة. يقارن القيم **المشتقّة النهائية** بالمحفوظة (نقد الخطة 32): الصفحة ترسل الدولة مع كل حفظ فتُشتقّ العملة والمزوّد
//   من جديد — حفظ بلا تغيير فعلي يمرّ كما اليوم. شركة غير مفعّلة ⇒ لا قيد إطلاقاً.
// • F12 (DELETE /api/tenants/:id): شركة لها وحدة فوترة (ومعها أي مستند أو سجل) ⇒ 409 واضح قبل أي حذف، بدل P2003 من
//   قيود onDelete: Restrict يصل المالكَ 500.
// ============================================================================

import { ZATCA_ERROR_CATALOGUE } from './errors';

export const PHASE2_LOCKED_SETTINGS = Object.freeze(['countryCode', 'currency', 'currencyOverride', 'einvoiceProvider'] as const);
export type Phase2LockedSetting = (typeof PHASE2_LOCKED_SETTINGS)[number];

export interface Phase2LockCurrent {
  countryCode: string | null;
  currency: string | null;
  currencyOverride: string | null;
  einvoiceProvider: string | null;
  zatcaPhase2StartedAt: Date | null;
}

const norm = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : null);

/**
 * الحقول المقفلة التي سيغيّرها الحفظ فعلاً. next = جسم الكتابة النهائي (بعد الاشتقاق): مفتاح غائب أو undefined = لا يُكتب.
 * '' وnull سواء (تجاوز العملة الفارغ = عملة الدولة).
 */
export function phase2LockedSettingChanges(current: Phase2LockCurrent | null | undefined, next: Readonly<Record<string, unknown>>): Phase2LockedSetting[] {
  if (!current || current.zatcaPhase2StartedAt == null) return [];
  const out: Phase2LockedSetting[] = [];
  for (const f of PHASE2_LOCKED_SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(next, f) || next[f] === undefined) continue;
    if (norm(next[f]) !== norm(current[f])) out.push(f);
  }
  return out;
}

export function phase2SettingsLockedBody(fields: readonly Phase2LockedSetting[]): Record<string, unknown> {
  return { success: false, code: 'ZATCA_SETTINGS_LOCKED', message: ZATCA_ERROR_CATALOGUE.ZATCA_SETTINGS_LOCKED.messageAr, fields: [...fields] };
}

/** حذف الشركة: عدد وحدات الفوترة > 0 ⇒ ردّ 409 (الحالة والجسم)، وإلا null (الحذف كما اليوم). */
export function tenantDeleteArchiveBlock(unitCount: number): { status: number; body: Record<string, unknown> } | null {
  if (!(unitCount > 0)) return null;
  const entry = ZATCA_ERROR_CATALOGUE.TENANT_HAS_EINVOICE_ARCHIVE;
  return { status: entry.status, body: { success: false, code: 'TENANT_HAS_EINVOICE_ARCHIVE', message: entry.messageAr } };
}
