import { User } from '../types';

/**
 * صلاحيات تبويبات تطبيق الإدارة على الجوال.
 *
 * **الدلالة مطابقة لـ`PermissionRoute` في اللوحة حرفياً: المنع عند `false`
 * الصريحة وحدها.** الحقل الغائب (`undefined`) يعني «مسموح» — لأن مستخدمي
 * الشركة القدامى أُنشئوا قبل أعمدة الصلاحيات، ومعاملة الغياب منعاً تحجب
 * التطبيق كلّه عن المدير الأصليّ للشركة.
 */
export type PermKey =
  | 'canAccessDashboard'
  | 'canManageTracking'
  | 'canManageCustomers'
  | 'canManageInvoices'
  | 'canManageReceipts';

export function can(user: User | null, key: PermKey): boolean {
  if (!user) return false;
  return user[key] !== false;
}
