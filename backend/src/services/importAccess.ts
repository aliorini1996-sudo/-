/**
 * صلاحيات استيراد البيانات والتراجع عنها (البندان 5 و21 من مراجعة 2026-09-17).
 *
 * requireAdmin وحده كان يمرّر أي مستخدم شركة: محاسب سُحبت منه صلاحية العملاء يستورد عملاء وأرصدة ويتراجع عن دفعات المالك،
 * ومستخدم مقيّد النطاق يرى كل دفعات الشركة ويتراجع عنها. هنا:
 * 1. المقيّد النطاق (scopeEnabled) ⇒ 403 IMPORT_SCOPED_ADMIN (الاستيراد والتراجع على مستوى الشركة كلها).
 * 2. صلاحية النوع === false ⇒ 403 IMPORT_PERMISSION_DENIED (افتراض الصلاحيات true كـrequireAdminPermission).
 * 3. ثم requireAccounting للأنواع المحاسبية.
 * صف المدير يُقرأ مرة واحدة من القاعدة (تغيير الصلاحية يسري فوراً).
 */
import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { requireAccounting } from '../middleware/auth';
import { AuthRequest } from '../types';

export const IMPORT_KINDS = ['customers', 'products', 'prices', 'balances', 'ledger', 'opening_stock'] as const;
export type ImportKind = typeof IMPORT_KINDS[number];

export type ImportPermission = 'canManageCustomers' | 'canManageProducts' | 'canManageVanStock';

export const IMPORT_KIND_PERMISSION: Readonly<Record<ImportKind, ImportPermission>> = {
  customers: 'canManageCustomers',
  balances: 'canManageCustomers',
  ledger: 'canManageCustomers',
  products: 'canManageProducts',
  prices: 'canManageProducts',
  opening_stock: 'canManageVanStock',
};

/** الأنواع التي يحرسها requireAccounting (والتراجع عنها يفحص accountingEnabled) */
export const IMPORT_ACCOUNTING_KINDS: readonly ImportKind[] = ['products', 'prices', 'balances', 'ledger', 'opening_stock'];

export const IMPORT_SCOPED_ADMIN_MESSAGE =
  'حسابك مقيّد بنطاق عملاء محدد، واستيراد البيانات والتراجع عنها على مستوى الشركة كلها، فيتولاها مستخدم غير مقيّد';
export const IMPORT_PERMISSION_DENIED_MESSAGE = 'لا تملك صلاحية استيراد هذا النوع من البيانات';
/** نص requireAccounting نفسه (middleware/auth.ts) */
export const ACCOUNTING_NOT_ALLOWED_MESSAGE = 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة';

export function isImportKind(k: unknown): k is ImportKind {
  return typeof k === 'string' && (IMPORT_KINDS as readonly string[]).includes(k);
}

export function isImportAccountingKind(k: unknown): boolean {
  return isImportKind(k) && IMPORT_ACCOUNTING_KINDS.includes(k);
}

export interface ImportActor {
  scopeEnabled?: boolean | null;
  perms: Record<string, boolean | null | undefined>;
}

export type ImportAccessDecision =
  | { ok: true }
  | { ok: false; status: 403; code: 'IMPORT_SCOPED_ADMIN' | 'IMPORT_PERMISSION_DENIED'; message: string; details: Record<string, unknown> };

/**
 * القرار الصرف. kind=null ⇒ فحص النطاق وحده (قبل البحث عن الدفعة في التراجع).
 * صف المدير الغائب ⇒ مرفوض، والنوع غير المعروف ⇒ مرفوض.
 */
export function importAccessDecision(actor: ImportActor | null | undefined, kind: string | null): ImportAccessDecision {
  if (actor?.scopeEnabled === true) {
    return { ok: false, status: 403, code: 'IMPORT_SCOPED_ADMIN', message: IMPORT_SCOPED_ADMIN_MESSAGE, details: {} };
  }
  if (!actor) {
    return { ok: false, status: 403, code: 'IMPORT_PERMISSION_DENIED', message: IMPORT_PERMISSION_DENIED_MESSAGE, details: { kind, permission: null } };
  }
  if (kind === null) return { ok: true };
  if (!isImportKind(kind)) {
    return { ok: false, status: 403, code: 'IMPORT_PERMISSION_DENIED', message: IMPORT_PERMISSION_DENIED_MESSAGE, details: { kind, permission: null } };
  }
  const permission = IMPORT_KIND_PERMISSION[kind];
  if (actor.perms[permission] === false) {
    return { ok: false, status: 403, code: 'IMPORT_PERMISSION_DENIED', message: IMPORT_PERMISSION_DENIED_MESSAGE, details: { kind, permission } };
  }
  return { ok: true };
}

/** الأنواع المسموحة (لترشيح GET /batches)؛ المقيّد والغائب ⇒ لا شيء */
export function importKindsAllowed(actor: ImportActor | null | undefined): ImportKind[] {
  return IMPORT_KINDS.filter((k) => importAccessDecision(actor, k).ok);
}

/** جسم رد الرفض */
export function importAccessBody(d: Exclude<ImportAccessDecision, { ok: true }>): Record<string, unknown> {
  return { success: false, code: d.code, message: d.message, ...d.details };
}

/** قراءة واحدة لصف المدير */
export async function loadImportActor(req: AuthRequest): Promise<ImportActor | null> {
  if (!req.user?.id) return null;
  const a = await prisma.admin.findUnique({
    where: { id: req.user.id },
    select: { scopeEnabled: true, canManageCustomers: true, canManageProducts: true, canManageVanStock: true },
  });
  if (!a) return null;
  return {
    scopeEnabled: a.scopeEnabled,
    perms: { canManageCustomers: a.canManageCustomers, canManageProducts: a.canManageProducts, canManageVanStock: a.canManageVanStock },
  };
}

/**
 * وسيط مسار الكتابة: النطاق ثم صلاحية النوع ثم requireAccounting للأنواع المحاسبية.
 * accounting:false حين يليه requireAccounting صريحاً في المسار (فلا يُفحص مرتين).
 */
export function requireImportAccess(kind: ImportKind, opts: { accounting?: boolean } = {}) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    try {
      const d = importAccessDecision(await loadImportActor(req), kind);
      if (!d.ok) { res.status(d.status).json(importAccessBody(d)); return; }
      if (opts.accounting !== false && IMPORT_ACCOUNTING_KINDS.includes(kind)) { await requireAccounting(req, res, next); return; }
      next();
    } catch (err) { next(err); }
  };
}
