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
import { TAX_MODE_CODES, TAX_MODE_MESSAGES } from '../../services/taxMode';

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

// ============================================================================
// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — «بلا ضريبة» وربط المرحلة الثانية لا يجتمعان
// ----------------------------------------------------------------------------
// • القلب إلى «بلا ضريبة» (PATCH /api/company/tax-mode) يُرفض 409 TAX_MODE_ZATCA_CONFLICT ما دام أيٌّ من: علم المالك
//   (Tenant.zatcaPhase2Enabled)، أو التفعيل الحيّ، أو التسليح، أو الشركة في قائمة البروفة — فبعد التفعيل يُقفل العلم نهائياً
//   (التفعيل لا يُلغى) كقفل الدولة والعملة أعلاه. وإعادة الضريبة حرّة دائماً.
// • والعكس: تفعيل علم المالك والتسليح والتفعيل الحيّ يُرفض 409 TAX_OFF_BLOCKS_ZATCA ما دامت الضريبة مزالة.
// نقيّ بلا قاعدة؛ الرسائل من services/taxMode.ts (المشترك حرفياً مع الواجهة).
// ============================================================================

export const TAX_MODE_ZATCA_REASONS = Object.freeze(['TENANT_FLAG', 'LIVE', 'ARMED', 'REHEARSAL'] as const);
export type TaxModeZatcaReason = (typeof TAX_MODE_ZATCA_REASONS)[number];

export interface TaxModeZatcaFacts {
  /** Tenant.zatcaPhase2Enabled */
  tenantFlag: boolean | null | undefined;
  /** CompanySettings: لحظة التفعيل الحيّ */
  liveAt: Date | null | undefined;
  /** CompanySettings: لحظة التسليح */
  armedAt: Date | null | undefined;
  /** الشركة في قائمة البروفة (regime.rehearsalTenantIds) */
  rehearsal: boolean;
}

/** أسباب منع «إزالة الضريبة» — فارغة ⇒ مسموح. */
export function taxModeZatcaConflicts(f: TaxModeZatcaFacts): TaxModeZatcaReason[] {
  const out: TaxModeZatcaReason[] = [];
  if (f.tenantFlag === true) out.push('TENANT_FLAG');
  if (f.liveAt != null) out.push('LIVE');
  if (f.armedAt != null) out.push('ARMED');
  if (f.rehearsal === true) out.push('REHEARSAL');
  return out;
}

export function taxModeZatcaConflictBody(reasons: readonly TaxModeZatcaReason[]): Record<string, unknown> {
  return { success: false, code: TAX_MODE_CODES.zatcaConflict, message: TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT, reasons: [...reasons] };
}

export function taxOffBlocksZatcaBody(): Record<string, unknown> {
  return { success: false, code: TAX_MODE_CODES.blocksZatca, message: TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA };
}

/**
 * PUT /api/tenants/:id (مالك المنصة أو موظفها): تفعيل علم المرحلة الثانية لشركةٍ أزالت ضريبتها ⇒ ردّ 409، وإلا null.
 * الانتقال إلى المفعّل وحده يُحرس: الجسم الذي يعيد القيمة نفسها (نموذج الحفظ يرسل الأعلام كلها) والإطفاء يمرّان كما اليوم.
 */
export function ownerZatcaEnableBlock(
  current: { zatcaPhase2Enabled: boolean | null; settings: { taxDisabled: boolean | null } | null } | null,
  next: boolean | undefined,
): { status: number; body: Record<string, unknown> } | null {
  if (next !== true || !current) return null;
  if (current.zatcaPhase2Enabled === true) return null;
  if (current.settings?.taxDisabled !== true) return null;
  return { status: 409, body: taxOffBlocksZatcaBody() };
}
