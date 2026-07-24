/**
 * عزل عملاء المناديب — مصدر الحقيقة الوحيد لقيد رؤية العملاء.
 *
 * القاعدة: الإدارة ترى كل عملاء الشركة دائماً. المندوب — عند تفعيل الشركة للميزة
 * (CompanySettings.customerIsolationEnabled) — لا يرى إلا العملاء الذين له معهم
 * سجلّ في CustomerAssignment. والعميل الذي يفتحه المندوب بنفسه يُنشأ له سجلّ
 * إسناد تلقائي (source=AUTO) فيراه فوراً، وتستطيع الإدارة نزعه بحذف السجلّ.
 *
 * الميزة مُطفأة افتراضياً ⇒ السلوك الحالي لا يتغيّر حتى تشغّلها الشركة.
 */
import prisma from '../config/database';
import { AuthRequest } from '../types';

/** قيد Prisma على العملاء. غياب assignments = بلا تقييد (رؤية كاملة). */
export type CustomerScope = { assignments?: { some: { salesRepId: string } } };

/** هل فعّلت هذه الشركة عزل العملاء؟ */
export async function isolationEnabled(tid: string): Promise<boolean> {
  const settings = await prisma.companySettings.findUnique({
    where: { tenantId: tid },
    select: { customerIsolationEnabled: true },
  });
  return settings?.customerIsolationEnabled === true;
}

/** قيد رؤية العملاء للطالب الحالي — يُدمج في أي استعلام عملاء. */
export async function customerScope(req: AuthRequest, tid: string): Promise<CustomerScope> {
  if (req.user?.role !== 'SALES_REP') return {};
  if (!(await isolationEnabled(tid))) return {};
  return { assignments: { some: { salesRepId: req.user.id } } };
}

/**
 * هل هذا العميل مرئي للطالب؟ تُستخدم في المسارات التي تستقبل customerId من الجهاز
 * (فاتورة/سند/زيارة/كشف حساب) كي لا يُتجاوز العزل بتمرير معرّف مباشرة.
 */
export async function canAccessCustomer(req: AuthRequest, tid: string, customerId: string): Promise<boolean> {
  const scope = await customerScope(req, tid);
  if (!scope.assignments) return true;
  const found = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: tid, ...scope },
    select: { id: true },
  });
  return found !== null;
}

// حقول العميل الحيّة الحسّاسة: لا يحتاجها المندوب لطباعة مستند قديم أصدره بنفسه،
// وكشفها لمندوب نُزع عنه العميل تسريبٌ مالي/موقعي.
const SENSITIVE_CUSTOMER_FIELDS = ['balance', 'creditLimit', 'totalSales', 'totalCollected', 'paymentDays', 'lat', 'lng'] as const;

/**
 * يحجب الحقول الحسّاسة من كائن عميل مُضمَّن في مستند (فاتورة/سند) — يُستخدم حين
 * يطالع المندوب مستنده القديم لعميل لم يعد مُسنَداً له: يبقى المستند وتُحجب البيانات الحيّة.
 */
export function redactCustomer<T>(customer: T): T {
  if (!customer || typeof customer !== 'object') return customer;
  const out = { ...(customer as Record<string, unknown>) };
  for (const key of SENSITIVE_CUSTOMER_FIELDS) delete out[key];
  return out as T;
}

/**
 * يضمن وجود سجلّ إسناد بين المندوب والعميل (يُستدعى عند إنشاء المندوب لعميل).
 * آمن للتكرار: القيد الفريد [customerId, salesRepId] يمنع الازدواج.
 */
export async function ensureAssignment(tid: string, customerId: string, salesRepId: string): Promise<void> {
  await prisma.customerAssignment.upsert({
    where: { customerId_salesRepId: { customerId, salesRepId } },
    create: { tenantId: tid, customerId, salesRepId, source: 'AUTO' },
    update: {},
  });
}
