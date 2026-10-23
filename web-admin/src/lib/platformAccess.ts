/**
 * «موظفو المنصة» (طلب المالك، ٢٣ أكتوبر ٢٠٢٦) — ما يظهر في لوحة المالك لمن يفتحها.
 *
 * - المالك (SUPER_ADMIN على /platform): كل شيء كما كان.
 * - الموظف (PLATFORM_STAFF على /staff): ما منحه المالك وحده — القسم الذي لم يُمنح لا يظهر أصلاً، والزرّ الذي لم يُمنح لا يُرسم.
 *
 * هذا إخفاءٌ لا حماية: الخادم يمنع كل ما لم يُمنح (backend/src/services/platformAccess.ts: platformGate وROUTE_RULES)،
 * ومفاتيحه هي نفسها هنا — اختبار platformAccess.test.ts يفرض أن كل مفتاحٍ تسأل عنه الواجهة موجودٌ في كتالوج الخادم.
 */
import { useAuthStore } from '../store/authStore';
import type { User } from '../types';

/** مفاتيح صلاحيات الموظف — نسخة كتالوج الخادم (STAFF_PERMISSIONS)، يفرض الاختبار التطابق */
export type StaffKey =
  | 'tenants.view' | 'tenants.totals' | 'tenants.performance' | 'tenants.create' | 'tenants.edit' | 'tenants.resetPassword'
  | 'tenants.impersonate' | 'tenants.ledger' | 'tenants.delete'
  | 'leads.view' | 'leads.edit' | 'leads.delete' | 'leads.hunt' | 'leads.message' | 'leads.export' | 'waBridge.view' | 'waBridge.send'
  | 'invoiceTool.view'
  | 'waInbox.view'
  | 'payments.view' | 'payments.manage'
  | 'affiliates.view' | 'affiliates.manage' | 'affiliates.payouts' | 'affiliates.iban'
  | 'quotes.view' | 'quotes.delete'
  | 'content.edit'
  | 'visits.view' | 'live.view' | 'live.requests';

export interface PlatformAccess {
  /** مالك المنصة: كل شيء، ومعه ما لا يُمنح لأحد (المالية وإدارة الموظفين) */
  isOwner: boolean;
  isStaff: boolean;
  can: (key: StaffKey) => boolean;
}

/** القرار الصرف — مُصدَّر للاختبار */
export function accessFor(user: Pick<User, 'role' | 'permissions'> | null | undefined): PlatformAccess {
  if (user?.role === 'SUPER_ADMIN') return { isOwner: true, isStaff: false, can: () => true };
  if (user?.role === 'PLATFORM_STAFF') {
    const granted = new Set(Array.isArray(user.permissions) ? user.permissions : []);
    return { isOwner: false, isStaff: true, can: (k) => granted.has(k) };
  }
  return { isOwner: false, isStaff: false, can: () => false };
}

export function usePlatformAccess(): PlatformAccess {
  const user = useAuthStore((s) => s.user);
  return accessFor(user);
}

/** مسار لوحة من يفتحها — للعودة إليها (بعد «دخول» شركة أو انتهاء الجلسة) */
export const platformHome = (user: Pick<User, 'role'> | null | undefined) => (user?.role === 'PLATFORM_STAFF' ? '/staff' : '/platform');
