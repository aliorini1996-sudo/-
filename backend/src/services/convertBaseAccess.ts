// «إضافة وحدة فرعية أصغر» (convert-base) — من يُسمح له بها (مواصفة الوحدة الرئيسية §2.3، D14، D15).
//
// التحويل يعيد كتابة تاريخ الصنف كله: لقطات بنود الفواتير والتحميلات والوارد وطلبات البضاعة، وأسعار العملاء والشرائح، وكميات
// LOT. لذلك لا عمود صلاحية جديداً: يلزمه دور مدير أو مشرف نشط غير مقيّد بنطاق، ومعه صلاحيات الأصناف والفواتير ومخزون السيارات
// معاً. وخلف بوابتين: بوابة الإطلاق في الكود (تُقلب في المرحلة ٥ بمعيار §9)، وعلم الشركة يقلبه مالك المنصّة لكل شركة.
// أيّ بوابة مغلقة ⇒ جلسة المالك وحدها كما كان قبل الميزة (OWNER_ONLY بالرسالة القائمة حرفياً).
import prisma from '../config/database';
import { isOwnerSession, tenantId } from '../middleware/auth';
import type { AuthRequest } from '../types';

/** بوابة الإطلاق (D14-أ): false ⇒ جلسة المالك وحدها كما اليوم. تُقلب true في المرحلة ٥ بمعيار §9 */
export const CONVERT_BASE_OPEN_TO_COMPANY = false;

export interface ConvertBaseActor {
  impersonated?: boolean; apiKeyId?: string | null; role?: string; isActive?: boolean; scopeEnabled?: boolean;
  canManageProducts?: boolean; canManageVanStock?: boolean; canManageInvoices?: boolean;
  tenantOpen?: boolean;   // Tenant.convertBaseOpen (D14-ب)
}
export type ConvertBaseRefusalCode = 'CONVERT_BASE_INTERACTIVE_ONLY' | 'CONVERT_BASE_OWNER_ONLY' | 'CONVERT_BASE_ROLE_FORBIDDEN'
  | 'CONVERT_BASE_FORBIDDEN' | 'CONVERT_BASE_SCOPED_USER';
export interface ConvertBaseRefusal { status: 403; code: ConvertBaseRefusalCode; message: string }
export type ConvertBaseUiCode = 'OWNER_ONLY' | 'SCOPED_USER' | 'FORBIDDEN' | 'ROLE_FORBIDDEN' | null;

/** رسائل الرفض — OWNER_ONLY هي رسالة ما قبل الميزة حرفياً (تكافؤ الإطفاء I1) */
export const CONVERT_BASE_MESSAGES: Record<ConvertBaseRefusalCode, string> = {
  CONVERT_BASE_INTERACTIVE_ONLY: 'إضافة وحدة فرعية أصغر تتم من لوحة الإدارة وحدها — لا عبر مفتاح API',
  CONVERT_BASE_OWNER_ONLY: 'تحويل وحدة الأساس متاح عبر الدعم الفني مؤقتا — تواصل معنا، أو أنشئ الصنف بوحداته من البداية',
  CONVERT_BASE_ROLE_FORBIDDEN: 'إضافة وحدة فرعية أصغر لمستخدم بدور مدير أو مشرف، وحسابه نشط',
  CONVERT_BASE_SCOPED_USER: 'إضافة وحدة فرعية أصغر تخصّ الشركة كلها — لمستخدم غير مقيّد بنطاق',
  CONVERT_BASE_FORBIDDEN: 'تحتاج صلاحية الأصناف والفواتير ومخزون السيارات معاً',
};

const refuse = (code: ConvertBaseRefusalCode): ConvertBaseRefusal => ({ status: 403, code, message: CONVERT_BASE_MESSAGES[code] });

/** الأدوار التي تملك التحويل حين تُفتح البوابتان — المحاسب وغيره ⇒ ROLE_FORBIDDEN */
const CONVERT_BASE_ROLES = new Set(['ADMIN', 'MANAGER']);

/**
 * الترتيب ملزم: المفتاح أولاً (لا يرث جلسة المالك ولو أصدره)، ثم جلسة المالك، ثم البوابتان (الإطلاق وعلم الشركة)،
 * ثم الدور والنشاط (ROLE_FORBIDDEN)، ثم النطاق، ثم الصلاحيات الثلاث (FORBIDDEN)
 */
export function convertBaseRefusal(a: ConvertBaseActor, open = CONVERT_BASE_OPEN_TO_COMPANY): ConvertBaseRefusal | null {
  if (a.apiKeyId) return refuse('CONVERT_BASE_INTERACTIVE_ONLY');
  if (a.impersonated === true) return null;
  if (open !== true || a.tenantOpen !== true) return refuse('CONVERT_BASE_OWNER_ONLY');
  if (!CONVERT_BASE_ROLES.has(String(a.role ?? '')) || a.isActive !== true) return refuse('CONVERT_BASE_ROLE_FORBIDDEN');
  if (a.scopeEnabled === true) return refuse('CONVERT_BASE_SCOPED_USER');
  // «لا تساوي false» كحارس requireAdminPermission: العمود افتراضه true، والغائب لا يُقرأ منعاً
  if (a.canManageProducts === false || a.canManageVanStock === false || a.canManageInvoices === false) return refuse('CONVERT_BASE_FORBIDDEN');
  return null;
}

/** للواجهة: الرمز بلا البادئة (OWNER_ONLY…) أو null — يستدعيه adminPermissionFields. المفتاح لا يصل الواجهة فلا رمز له */
export function convertBaseUiCode(a: ConvertBaseActor, open = CONVERT_BASE_OPEN_TO_COMPANY): ConvertBaseUiCode {
  const r = convertBaseRefusal({ ...a, apiKeyId: null }, open);
  return r ? (r.code.slice('CONVERT_BASE_'.length) as Exclude<ConvertBaseUiCode, null>) : null;
}

/**
 * يقرأ صفّ المدير (role, isActive, scopeEnabled, الصلاحيات الثلاث) وعلم شركته، لغير جلسة المالك وغير المفتاح.
 * والبوابة في الكود مغلقة ⇒ لا استعلام أصلاً (الرفض لا يحتاج الصفّ)، فمسار ما قبل الميزة بلا قراءة زائدة.
 * `open` للاختبارات وحدها — المسار يستدعيها بلا معامل فتحكمها بوابة الإطلاق.
 */
export async function convertBaseRefusalFor(req: AuthRequest, open = CONVERT_BASE_OPEN_TO_COMPANY): Promise<ConvertBaseRefusal | null> {
  const u = req.user;
  if (u?.apiKeyId) return refuse('CONVERT_BASE_INTERACTIVE_ONLY');
  if (isOwnerSession(req)) return null;
  if (open !== true) return refuse('CONVERT_BASE_OWNER_ONLY');
  if (!u?.id) return refuse('CONVERT_BASE_ROLE_FORBIDDEN');
  // الصفّ من القاعدة لا من التوكن: الصلاحيات والإيقاف والعلم تُحكم في كل طلب (التوكن يعيش ٨ ساعات)
  const admin = await prisma.admin.findFirst({
    where: { id: u.id, tenantId: tenantId(req) },
    select: {
      role: true, isActive: true, scopeEnabled: true, canManageProducts: true, canManageVanStock: true, canManageInvoices: true,
      tenant: { select: { convertBaseOpen: true } },
    },
  });
  // صفٌّ غائب (حُذف بين المصادقة والطلب) ⇒ البوابة مجهولة فتُقرأ مغلقة
  if (!admin) return refuse('CONVERT_BASE_OWNER_ONLY');
  return convertBaseRefusal({
    role: admin.role, isActive: admin.isActive, scopeEnabled: admin.scopeEnabled,
    canManageProducts: admin.canManageProducts, canManageVanStock: admin.canManageVanStock, canManageInvoices: admin.canManageInvoices,
    tenantOpen: admin.tenant?.convertBaseOpen === true,
  }, open);
}
