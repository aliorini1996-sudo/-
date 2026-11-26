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
import { adminCustomerFilter } from './adminScope';
import { SYSTEM_ACTOR, recordActivityInTx, type ActivityMeta } from './customerActivityEvents';

/**
 * قيد Prisma على العملاء.
 * - `assignments` = قيد المندوب (عملاؤه المُسنَدون).
 * - `adminScopes` = قيد مستخدم الشركة مقيّد النطاق (انظر services/adminScope.ts).
 * غياب المفتاحين = بلا تقييد (رؤية كاملة).
 */
export type CustomerScope = {
  assignments?: { some: { salesRepId: string } };
  adminScopes?: { some: { adminId: string } };
};

/** هل فعّلت هذه الشركة عزل العملاء؟ */
export async function isolationEnabled(tid: string): Promise<boolean> {
  const settings = await prisma.companySettings.findUnique({
    where: { tenantId: tid },
    select: { customerIsolationEnabled: true },
  });
  return settings?.customerIsolationEnabled === true;
}

/**
 * قيد رؤية العملاء للطالب الحالي — يُدمج في أي استعلام عملاء.
 *
 * يغطّي حالتين بمصدر واحد كي لا يُنسى أحدهما في مسار:
 *  - **المندوب:** عملاؤه المُسنَدون (عند تفعيل الشركة للعزل).
 *  - **مستخدم الشركة مقيّد النطاق:** العملاء المُسنَدون له وحده.
 * أي دور آخر (أو غير مقيّد) ⇒ رؤية كاملة كما كان.
 */
export async function customerScope(req: AuthRequest, tid: string): Promise<CustomerScope> {
  if (req.user?.role === 'SALES_REP') {
    if (!(await isolationEnabled(tid))) return {};
    return { assignments: { some: { salesRepId: req.user.id } } };
  }
  return adminCustomerFilter(req);
}

/**
 * هل هذا العميل مرئي للطالب؟ تُستخدم في المسارات التي تستقبل customerId من الجهاز
 * (فاتورة/سند/زيارة/كشف حساب) كي لا يُتجاوز العزل بتمرير معرّف مباشرة.
 */
export async function canAccessCustomer(req: AuthRequest, tid: string, customerId: string): Promise<boolean> {
  const scope = await customerScope(req, tid);
  // بلا أي قيد ⇒ مسموح. الفحص على المفتاحين معاً كي لا يُفلت قيد الإداري.
  if (!scope.assignments && !scope.adminScopes) return true;
  const found = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: tid, ...scope },
    select: { id: true },
  });
  return found !== null;
}

/**
 * canAccessCustomer لدفعة معرّفات باستعلامٍ واحد: null ⇒ بلا قيد (الكل مرئي)، وإلا مجموعة المرئي منها.
 * لمن يحكم على عدّة عملاء معاً (مطابقة طلبات المنيو بالجوال) — فلا يفحص المسار مفاتيح النطاق بنفسه
 * (حارس adminScope.test.ts)، والفحص على المفتاحين معاً كما في canAccessCustomer.
 */
export async function visibleCustomerIds(req: AuthRequest, tid: string, ids: readonly string[]): Promise<Set<string> | null> {
  const scope = await customerScope(req, tid);
  if (!scope.assignments && !scope.adminScopes) return null;
  if (ids.length === 0) return new Set();
  const rows = await prisma.customer.findMany({
    where: { id: { in: [...ids] }, tenantId: tid, ...scope },
    select: { id: true },
  });
  return new Set(rows.map((c) => c.id));
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
 *
 * «أرشيف العميل — السجل الزمني» (طلب المالك ٢٦ نوفمبر ٢٠٢٦): الإسناد الجديد وحده حدث CUSTOMER_ASSIGNED في سجلّ العميل (AUTO)
 * بفاعل الطلب (المندوب الذي فتح العميل)، وإلا «النظام». و«جديد» تقوله الكتابة نفسها لا نافذةٌ زمنية (كانت ٥ ثوانٍ على createdAt
 * فتعدّ إعادة رفعٍ بعد ثانيتين إسناداً جديداً وتكرّر حدثه في سجلٍّ لا يُمحى):
 *   • createdNow — العميل أنشأه هذا الطلب نفسه (التزم إنشاؤه للتوّ): الإسناد التلقائي جزءٌ من إنشائه فحدثه هنا مرّةً واحدة،
 *     وupsert آمنٌ للتكرار.
 *   • غيره (إعادة رفعٍ بـclientRef لعميلٍ قائم) — إدراجٌ ذرّي ON CONFLICT DO NOTHING (createMany skipDuplicates): count = 1 ⇒ هذا
 *     النداء أنشأ الإسناد (إنشاءٌ سابقٌ انقطع قبل إسناده) فحدثه؛ ٠ ⇒ قائمٌ لا حدث له.
 * يبقى سباقٌ ضيّق واحد: إعادة رفعٍ تُدرج الإسناد في أجزاء الثانية بين التزام الإنشاء الأصليّ وإسناده ⇒ حدثان (والبديل حذف حدث
 * الإعادة يُضيّع إسناد إنشاءٍ انقطع قبل إسناده — والفجوة في سجلٍّ «بلا استثناء» أسوأ من سطرٍ مكرّر).
 * الإسناد يُكتب بعد التزام إنشاء العميل (لا داخل معاملته — اتصالٌ آخر)، لكن **الإسناد وحدثه معاملةٌ واحدة** (QA ٢٧ نوفمبر): يُلتزمان
 * معاً أو يُتراجعان معاً — لا إسناد بلا حدثه (كان الحدث بعد الالتزام فيضيع لو تعذّر)، وتعذّر الحدث يُلغي الإسناد فتُعيده إعادة الرفع.
 * واسم المندوب يُقرأ قبل المعاملة (تعذّره لا يُفشل شيئاً: الحدث بلا اسم).
 */
export async function ensureAssignment(
  tid: string, customerId: string, salesRepId: string, meta?: ActivityMeta | null, opts: { createdNow?: boolean } = {},
): Promise<void> {
  const m = meta ?? { actor: SYSTEM_ACTOR, source: 'system' };
  const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { name: true } }).catch(() => null);
  await prisma.$transaction(async (tx) => {
    let created: boolean;
    if (opts.createdNow) {
      await tx.customerAssignment.upsert({
        where: { customerId_salesRepId: { customerId, salesRepId } },
        create: { tenantId: tid, customerId, salesRepId, source: 'AUTO' },
        update: {},
      });
      created = true;
    } else {
      const r = await tx.customerAssignment.createMany({
        data: [{ tenantId: tid, customerId, salesRepId, source: 'AUTO' }],
        skipDuplicates: true,
      });
      created = (r as { count?: unknown } | null | undefined)?.count === 1;
    }
    if (!created) return;
    await recordActivityInTx(tx, {
      tenantId: tid, customerId, action: 'CUSTOMER_ASSIGNED', actor: m.actor, source: m.source, refType: 'ASSIGNMENT', refId: salesRepId,
      data: { salesRepId, ...(rep?.name && { repName: rep.name }), mode: 'AUTO' },
    });
  });
}
