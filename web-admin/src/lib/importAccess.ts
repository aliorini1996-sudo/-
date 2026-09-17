// صلاحيات بطاقات الاستيراد وسجل الدفعات في الواجهة (البندان 5 و21 من مراجعة 2026-09-17) — صرف.
// المرآة لـbackend/src/services/importAccess.ts: الخادم يفرض (403 IMPORT_SCOPED_ADMIN / IMPORT_PERMISSION_DENIED)،
// والواجهة تخفي ما سيُرفض وتشرح السبب بدل أن تعرض بطاقة تفشل بعد رفع الملف.
import type { ImportKind } from './importData';

export type ImportPermission = 'canManageCustomers' | 'canManageProducts' | 'canManageVanStock';

export const IMPORT_KIND_PERMISSION: Readonly<Record<ImportKind, ImportPermission>> = {
  customers: 'canManageCustomers',
  balances: 'canManageCustomers',
  ledger: 'canManageCustomers',
  products: 'canManageProducts',
  prices: 'canManageProducts',
  opening_stock: 'canManageVanStock',
};

const KINDS = Object.keys(IMPORT_KIND_PERMISSION) as ImportKind[];

export interface ImportAccessUser {
  scopeEnabled?: boolean | null;
  canManageCustomers?: boolean | null;
  canManageProducts?: boolean | null;
  canManageVanStock?: boolean | null;
}

export interface ImportAccess {
  /** مقيّد النطاق: لا استيراد ولا تراجع ولا سجل دفعات */
  scoped: boolean;
  allowed: Record<ImportKind, boolean>;
}

/** نص شرح المستخدم المقيّد (مفتاح tr) */
export const IMPORT_SCOPED_NOTE = 'حسابك مقيّد بنطاق عملاء محدد؛ الاستيراد والتراجع على مستوى الشركة يتولاهما مستخدم غير مقيّد';
/** نص شرح الأنواع المخفية لغياب صلاحيتها (مفتاح tr) */
export const IMPORT_HIDDEN_KINDS_NOTE = 'بعض أنواع الاستيراد مخفية لأنك لا تملك صلاحيتها (العملاء/المنتجات/المستودع)';

/** الصلاحية الغائبة تُعدّ مسموحة (كالخادم: false الصريح وحده يمنع)؛ المقيّد ⇒ كل الأنواع ممنوعة */
export function importAccess(user: ImportAccessUser | null | undefined): ImportAccess {
  const scoped = user?.scopeEnabled === true;
  const allowed = {} as Record<ImportKind, boolean>;
  for (const k of KINDS) allowed[k] = !scoped && user?.[IMPORT_KIND_PERMISSION[k]] !== false;
  return { scoped, allowed };
}

/** التراجع عن دفعة بحسب صلاحية نوعها؛ النوع غير المعروف ⇒ لا */
export function revertAllowed(access: ImportAccess, kind: string | null | undefined): boolean {
  if (access.scoped || !kind) return false;
  return (access.allowed as Record<string, boolean | undefined>)[kind] === true;
}

/** مفتاح الشرح الظاهر فوق البطاقات، أو null إن لم يُخفَ شيء */
export function importAccessNote(access: ImportAccess): string | null {
  if (access.scoped) return IMPORT_SCOPED_NOTE;
  return KINDS.some((k) => !access.allowed[k]) ? IMPORT_HIDDEN_KINDS_NOTE : null;
}

/** بطاقات الاستيراد الظاهرة (بالترتيب المعطى) */
export function visibleImportKinds<K extends string>(access: ImportAccess, kinds: readonly K[]): K[] {
  if (access.scoped) return [];
  return kinds.filter((k) => (access.allowed as Record<string, boolean | undefined>)[k] === true);
}

/**
 * سجل الدفعات من رد GET /import/batches: scoped:true من الخادم أو مقيّد محلياً ⇒ لا قائمة (تُعرض الملاحظة)،
 * وإلا القائمة كما أتت (الخادم رشّحها بالأنواع المسموحة).
 */
export function batchesView<T>(access: ImportAccess, body: { data?: T[] | null; scoped?: boolean } | null | undefined): { scoped: boolean; list: T[] } {
  const scoped = access.scoped || body?.scoped === true;
  return { scoped, list: scoped ? [] : Array.isArray(body?.data) ? body!.data! : [] };
}
