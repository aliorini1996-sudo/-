// ============================================================================
// ZATCA المرحلة الثانية (Z5.0) — النظام الضريبي للإصدار: مرحلة أولى أم ثانية (حيّة أو بروفة) أم محجوبة
// ----------------------------------------------------------------------------
// z5_plan §0.1 + §2.1 + نقد الخطة (5، 12):
//   • «حيّة» = CompanySettings.zatcaPhase2StartedAt != null وحده (يضبطه goLive وحده، والمسار يردّ 409 حتى Z5.8).
//     إطفاء علم المالك بعد التفعيل لا يعيد الشركة إلى المرحلة الأولى.
//   • البروفة (Z6): معرّف الشركة في ZATCA_REHEARSAL_TENANT_IDS + العلم + SA + zatca ⇒ وحدة simulation مفعّلة. تُتجاهل
//     تماماً بعد التفعيل الحيّ. غياب المتغيّر (الافتراضي) ⇒ لا بروفة لأحد.
//   • الوحدة: ACTIVE واحدة من بيئة النظام (production للحيّة، simulation للبروفة). لا يكتب أحد EXPIRED فيُشتقّ من
//     certNotAfter. رقم المنشأة الضريبي ≠ رقم الوحدة ⇒ SELLER_VAT_CHANGED (كل فاتورة سترفضها الهيئة). بيانات بائع لا
//     تصلح (أخطاء sellerIssues أو دولة/مزوّد غير الهيئة) ⇒ SELLER_NOT_READY.
//   • كلفة الاستعلام: المرحلة الأولى صفر استعلامات إضافية (الإعدادات محمَّلة، والقائمة من الذاكرة). الوحدات (وبيانات
//     البائع حين لا تُمرَّر) تُقرأ للحيّة أو المسموح لها بالبروفة وحدهما.
//   • جمع بيانات المشتري (D2) والنظام المعروض للعملاء: العلم || التفعيل — لا العلم وحده (نقد الخطة 5).
// لا يستورد services/gl، ولا يكتب شيئاً، ولا يقرأ أسراراً (أعمدة الوحدة العامة وحدها).
// ============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';
import { mapSellerParty } from './mapInvoice';
import { sellerSourceFromSettings } from './onboarding';
import type { SellerSettingsRecord } from './onboardingStore';
import { sellerIssues } from './validators';

export type RegimeMode = 'live' | 'rehearsal';

export const REGIME_BLOCKED_REASONS = Object.freeze([
  'NO_ACTIVE_UNIT', 'MULTIPLE_ACTIVE_UNITS', 'RENEWING', 'AUTH_FAILED', 'EXPIRED', 'SELLER_NOT_READY', 'SELLER_VAT_CHANGED',
] as const);
export type RegimeBlockedReason = (typeof REGIME_BLOCKED_REASONS)[number];

/** أعمدة الوحدة العامة التي يحتاجها الإصدار — بلا مفتاح خاص ولا رموز ولا أسرار. */
export interface UnitForIssuance {
  id: string;
  tenantId: string;
  environment: string;
  status: string;
  keyVersion: number;
  vatNumber: string;
  certNotAfter: Date | null;
  lastIcv: number;
  lastInvoiceHash: string | null;
}

export type Regime =
  | { phase: 1 }
  | { phase: 2; mode: RegimeMode; unit: UnitForIssuance }
  | { phase: 2; mode: RegimeMode; blocked: RegimeBlockedReason };

/** ما يحمّله مسار الفاتورة أصلاً من CompanySettings (Z5.2 يضيف zatcaPhase2StartedAt وtaxNumber إلى select). */
export interface RegimeSettings {
  countryCode: string | null;
  einvoiceProvider: string | null;
  zatcaPhase2StartedAt: Date | null;
  taxNumber: string | null;
}

export const REHEARSAL_TENANTS_VAR = 'ZATCA_REHEARSAL_TENANT_IDS';
const TENANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** حالات الوحدة التي تُقرأ لقرار النظام (غيرها — قيد الربط أو REVOKED — لا يغيّر القرار). */
export const REGIME_UNIT_STATUSES: readonly string[] = Object.freeze(['ACTIVE', 'RENEWING', 'AUTH_FAILED', 'EXPIRED']);
export const LIVE_ENVIRONMENT = 'production';
export const REHEARSAL_ENVIRONMENT = 'simulation';

/** قائمة البروفة من البيئة: معرّفات مفصولة بفواصل؛ ما لا يطابق صيغة المعرّف يُهمل. غيابها ⇒ قائمة فارغة. */
export function rehearsalTenantIds(env: Readonly<Record<string, string | undefined>>): ReadonlySet<string> {
  const raw = typeof env[REHEARSAL_TENANTS_VAR] === 'string' ? (env[REHEARSAL_TENANTS_VAR] as string) : '';
  const out = new Set<string>();
  for (const t of raw.split(',')) {
    const id = t.trim();
    if (TENANT_ID_RE.test(id)) out.add(id);
  }
  return out;
}

/** هل البائع صالح لإصدار فاتورة ضريبية؟ (أخطاء sellerIssues + TIN عضو المجموعة الضريبية، كفحص goLive). */
export function sellerNotReady(seller: SellerSettingsRecord): boolean {
  if (seller.countryCode !== 'SA' || seller.einvoiceProvider !== 'zatca') return true;
  if (sellerIssues(mapSellerParty(sellerSourceFromSettings(seller))).some(i => i.severity === 'error')) return true;
  const vat = seller.taxNumber ?? '';
  return vat.length === 15 && vat[10] === '1' && !/^[0-9]{10}$/.test(seller.vatGroupTin ?? '');
}

export interface ResolveRegimeInput {
  tenantId: string;
  settings: RegimeSettings | null;
  /** علم المالك — يُحتاج للبروفة وحدها (الحيّة لا تنظر إليه). */
  tenantFlag?: boolean | null;
  /** وحدات الشركة (أي بيئة وحالة؛ يُصفّى هنا). غيابها للحيّة أو البروفة = لا وحدة. */
  units?: readonly UnitForIssuance[];
  /** بيانات البائع كاملة؛ غيابها = لا فحص جاهزية (المحمِّل يمرّرها دائماً للمرحلة الثانية). */
  seller?: SellerSettingsRecord | null;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
}

/** قرار «هل يُسلك مسار المرحلة الثانية» من الإعدادات والبيئة وحدهما (بلا وحدات): ما يقرّر هل يُستعلم عن شيء. */
export function regimeCandidate(input: Pick<ResolveRegimeInput, 'tenantId' | 'settings' | 'env'>): 'phase1' | 'live' | 'rehearsal-candidate' {
  if (input.settings?.zatcaPhase2StartedAt != null) return 'live';
  if (rehearsalTenantIds(input.env).has(input.tenantId)) return 'rehearsal-candidate';
  return 'phase1';
}

function pickUnit(
  tenantId: string, environment: string, units: readonly UnitForIssuance[], taxNumber: string | null, now: Date,
): { unit: UnitForIssuance } | { blocked: RegimeBlockedReason } {
  const own = units.filter(u => u.tenantId === tenantId && u.environment === environment);
  const active = own.filter(u => u.status === 'ACTIVE');
  if (active.length > 1) return { blocked: 'MULTIPLE_ACTIVE_UNITS' };
  if (active.length === 1) {
    const u = active[0];
    if (!(u.certNotAfter instanceof Date) || !(u.certNotAfter.getTime() > now.getTime())) return { blocked: 'EXPIRED' };
    if ((taxNumber ?? null) !== u.vatNumber) return { blocked: 'SELLER_VAT_CHANGED' };
    return { unit: u };
  }
  for (const s of ['RENEWING', 'AUTH_FAILED', 'EXPIRED'] as const) {
    if (own.some(u => u.status === s)) return { blocked: s };
  }
  return { blocked: 'NO_ACTIVE_UNIT' };
}

/** نقيّ: القرار كاملاً من المُدخلات. */
export function resolveRegimeFrom(input: ResolveRegimeInput): Regime {
  const candidate = regimeCandidate(input);
  if (candidate === 'phase1') return { phase: 1 };
  const s = input.settings;
  let mode: RegimeMode;
  if (candidate === 'live') {
    mode = 'live';
  } else {
    // البروفة: العلم والدولة والمزوّد — وإلا فلا بروفة (مرحلة أولى كما اليوم)
    if (input.tenantFlag !== true || s?.countryCode !== 'SA' || s.einvoiceProvider !== 'zatca') return { phase: 1 };
    mode = 'rehearsal';
  }
  // حيّة بدولة أو مزوّد غير الهيئة: القفل يمنعه منذ Z5.0، وإن وُجد فلا إصدار (فشل مغلق)
  if (s?.countryCode !== 'SA' || s.einvoiceProvider !== 'zatca') return { phase: 2, mode, blocked: 'SELLER_NOT_READY' };
  const picked = pickUnit(input.tenantId, mode === 'live' ? LIVE_ENVIRONMENT : REHEARSAL_ENVIRONMENT, input.units ?? [], s.taxNumber, input.now);
  if ('blocked' in picked) return { phase: 2, mode, blocked: picked.blocked };
  if (input.seller && sellerNotReady(input.seller)) return { phase: 2, mode, blocked: 'SELLER_NOT_READY' };
  return { phase: 2, mode, unit: picked.unit };
}

/** ما يُعرض للعملاء في GET /company (Z5.2): بلا معرّف وحدة ولا رقم ضريبي. */
export type RegimeView = { phase: 1 } | { phase: 2; mode: RegimeMode; blocked: RegimeBlockedReason | null };

export function regimeView(r: Regime): RegimeView {
  if (r.phase === 1) return { phase: 1 };
  return { phase: 2, mode: r.mode, blocked: 'blocked' in r ? r.blocked : null };
}

/**
 * D2 — جمع بيانات المشتري وقبولها ونظامها المعروض: علم المالك أو التفعيل الحيّ، لشركة سعودية.
 * (العلم وحده كان سيُسقط حقول المشتري ويُعيد العملاء إلى المرحلة الأولى إن أُطفئ بعد التفعيل — نقد الخطة 5.)
 */
export function zatcaCollectOn(input: {
  tenantFlag: boolean | null | undefined;
  settings: { countryCode: string | null; zatcaPhase2StartedAt: Date | null } | null | undefined;
}): boolean {
  const s = input.settings;
  return (input.tenantFlag === true || s?.zatcaPhase2StartedAt != null) && s?.countryCode === 'SA';
}

// ─── المحمِّل ───

const UNIT_SELECT = {
  id: true, tenantId: true, environment: true, status: true, keyVersion: true, vatNumber: true, certNotAfter: true, lastIcv: true,
  lastInvoiceHash: true,
} satisfies Prisma.ZatcaEgsUnitSelect;

const SELLER_SELECT = {
  tenantId: true, legalName: true, taxNumber: true, commercialReg: true, sellerIdScheme: true, sellerIdValue: true,
  addrStreet: true, addrBuildingNo: true, addrAdditionalNo: true, addrDistrict: true, addrCity: true, addrPostalCode: true,
  vatGroupTin: true, countryCode: true, currency: true, currencyOverride: true, einvoiceProvider: true, zatcaPhase2StartedAt: true,
} satisfies Prisma.CompanySettingsSelect;

/** الجزء الذي يستعمله المحمِّل من عميل Prisma (أو معاملة). الاستيراد نوعي فلا يُحمَّل @prisma/client من هذا الملف. */
export type RegimeDb = Pick<PrismaClient, 'zatcaEgsUnit' | 'tenant' | 'companySettings'>;

export interface ResolveInvoiceRegimeOptions {
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  /** بيانات البائع إن حمّلها المستدعي (وإلا تُقرأ للمرحلة الثانية وحدها). */
  seller?: SellerSettingsRecord | null;
}

/**
 * المحمِّل: المرحلة الأولى بلا أي استعلام. الحيّة: الوحدات (production) + البائع. المسموح لها بالبروفة: العلم أولاً، ثم
 * الوحدات (simulation) + البائع إن انطبقت شروطها.
 */
export async function resolveInvoiceRegime(
  db: RegimeDb, tenantId: string, settings: RegimeSettings | null, opts: ResolveInvoiceRegimeOptions = {},
): Promise<Regime> {
  const env = opts.env ?? process.env;
  const candidate = regimeCandidate({ tenantId, settings, env });
  if (candidate === 'phase1') return { phase: 1 };
  let tenantFlag: boolean | null = null;
  if (candidate === 'rehearsal-candidate') {
    tenantFlag = (await db.tenant.findUnique({ where: { id: tenantId }, select: { zatcaPhase2Enabled: true } }))?.zatcaPhase2Enabled === true;
    if (!tenantFlag || settings?.countryCode !== 'SA' || settings.einvoiceProvider !== 'zatca') return { phase: 1 };
  }
  const environment = candidate === 'live' ? LIVE_ENVIRONMENT : REHEARSAL_ENVIRONMENT;
  const units = await db.zatcaEgsUnit.findMany({
    where: { tenantId, environment, status: { in: [...REGIME_UNIT_STATUSES] } },
    select: UNIT_SELECT,
  });
  const seller = opts.seller !== undefined ? opts.seller : await db.companySettings.findUnique({ where: { tenantId }, select: SELLER_SELECT });
  return resolveRegimeFrom({ tenantId, settings, tenantFlag, units, seller, env, now: opts.now ?? new Date() });
}
