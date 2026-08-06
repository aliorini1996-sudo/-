/**
 * نطاق المستخدم الإداري — عزل العملاء والمناديب عن بعض مستخدمي الشركة.
 *
 * نظير `customerScope.ts` لكن على مستوى الإدارة: هناك المندوب يُقيَّد بعملائه
 * المُسنَدين، وهنا **مستخدم الشركة** يُقيَّد بقائمتين مستقلّتين (عملاء، مناديب)
 * — بقرار المالك.
 *
 * ملكية النطاق لكل مستخدم لا للشركة: `Admin.scopeEnabled`. افتراضياً false
 * ⇒ كل المستخدمين القائمين يبقون على رؤيتهم الكاملة بعد db push بلا انقطاع.
 *
 * ═══════════════ خطر بنيويّ في «قائمتين مستقلّتين» وكيف عولج ═══════════════
 * القائمتان قد تتناقضان: عميل مرئيّ ومندوبه مخفيّ. لو أُسنِد ذلك العميل لذلك
 * المندوب لظهر في فواتير مندوب لا يراه المستخدم — إسنادٌ «أعمى». لذلك:
 * **الإسناد يُفلتَر بالمناديب المرئيّين** (`canAccessRep`)، فلا يُسنِد المستخدم
 * لمن لا يرى. القائمتان تبقيان مستقلّتين للعرض، والكتابة وحدها مقيّدة.
 *
 * نطاق التطبيق: القوائم والإسناد، والتقارير والفواتير والسندات والزيارات
 * ولوحة المعلومات والتتبّع. **والقراءة وحدها لا تكفي**: مسارات الإنشاء تحرس
 * المندوب بـ`canAccessRep` كي لا يُنسَب سجلّ لمن لا يراه المستخدم، ومسارات
 * الـidempotency (clientRef) تحرس العميل — وإلا كشفَ من يعرف مرجعاً سجلّاً
 * خارج نطاقه بعميله كاملاً.
 *
 * ما يبقى عامّاً عمداً: فحوص التفرّد (اسم مستخدم/جوال) — تقييدها يسمح بتكرارها.
 */
import prisma from '../config/database';
import { AuthRequest } from '../types';

/** قيد Prisma على العملاء. غياب المفتاح = بلا تقييد (رؤية كاملة). */
export type AdminCustomerFilter = { adminScopes?: { some: { adminId: string } } };

/** قيد Prisma على المناديب. */
export type AdminRepFilter = { adminScopes?: { some: { adminId: string } } };

/** أدوار لوحة الشركة (غير المندوب ومالك المنصّة) */
const ADMIN_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];

function isCompanyUser(req: AuthRequest): boolean {
  return !!req.user && ADMIN_ROLES.includes(req.user.role);
}

/**
 * هل هذا المستخدم الإداري مقيّد النطاق؟
 * يُقرأ من قاعدة البيانات لا من التوكن: تغيير الصلاحية يسري فوراً بلا انتظار
 * انتهاء جلسة المستخدم (٨ ساعات) — وإلا بقي يرى ما مُنع عنه.
 */
export async function adminScopeEnabled(req: AuthRequest): Promise<boolean> {
  if (!isCompanyUser(req)) return false;
  const admin = await prisma.admin.findUnique({
    where: { id: req.user!.id },
    select: { scopeEnabled: true },
  });
  return admin?.scopeEnabled === true;
}

/** قيد رؤية العملاء لمستخدم الشركة — يُدمج في استعلامات العملاء. */
export async function adminCustomerFilter(req: AuthRequest): Promise<AdminCustomerFilter> {
  if (!(await adminScopeEnabled(req))) return {};
  return { adminScopes: { some: { adminId: req.user!.id } } };
}

/** قيد رؤية المناديب لمستخدم الشركة — يُدمج في استعلامات المناديب. */
export async function adminRepFilter(req: AuthRequest): Promise<AdminRepFilter> {
  if (!(await adminScopeEnabled(req))) return {};
  return { adminScopes: { some: { adminId: req.user!.id } } };
}

/**
 * هل يرى هذا المستخدم هذا العميل؟ تُستخدم في المسارات التي تستقبل customerId
 * من العميل (تفاصيل/تعديل/إسناد) كي لا يُتجاوز العزل بتمرير معرّف مباشرةً.
 */
export async function canAccessCustomerAsAdmin(req: AuthRequest, tid: string, customerId: string): Promise<boolean> {
  const filter = await adminCustomerFilter(req);
  if (!filter.adminScopes) return true;
  const found = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: tid, ...filter },
    select: { id: true },
  });
  return found !== null;
}

/** هل يرى هذا المستخدم هذا المندوب؟ (يحرس الإسناد من الكتابة العمياء) */
export async function canAccessRep(req: AuthRequest, tid: string, salesRepId: string): Promise<boolean> {
  const filter = await adminRepFilter(req);
  if (!filter.adminScopes) return true;
  const found = await prisma.salesRep.findFirst({
    where: { id: salesRepId, tenantId: tid, ...filter },
    select: { id: true },
  });
  return found !== null;
}

/**
 * يستبدل نطاق مستخدم كاملاً بقائمتين مُعطاتين — **بالفرق لا بالمسح والإعادة**.
 *
 * لماذا تفاضلي: الاستبدال الكامل (deleteMany ثم createMany) يمحو كل النطاق
 * لحظةً، فلو انقطع الطلب بينهما بقي المستخدم بلا نطاق = رؤية صفرية مفاجئة.
 * والأخطر: تحرير جزئي من واجهة تحمل قائمة قديمة يمحو ما أُضيف بينهما.
 *
 * `null` تعني «لا تلمس هذه القائمة» — فيُحدَّث العملاء وحدهم أو المناديب وحدهم.
 */
export async function setAdminScope(
  tid: string,
  adminId: string,
  customerIds: string[] | null,
  salesRepIds: string[] | null,
): Promise<{ customers: number; reps: number }> {
  if (customerIds) {
    // نتحقّق أن كل المعرّفات تخصّ هذه الشركة — حارس ضدّ تسريب عابر للشركات
    const valid = await prisma.customer.findMany({
      where: { tenantId: tid, id: { in: customerIds } }, select: { id: true },
    });
    const want = new Set(valid.map((c) => c.id));
    const current = await prisma.adminCustomerScope.findMany({ where: { adminId }, select: { customerId: true } });
    const have = new Set(current.map((r) => r.customerId));
    const toAdd = [...want].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !want.has(id));
    if (toRemove.length) await prisma.adminCustomerScope.deleteMany({ where: { adminId, customerId: { in: toRemove } } });
    if (toAdd.length) {
      await prisma.adminCustomerScope.createMany({
        data: toAdd.map((customerId) => ({ tenantId: tid, adminId, customerId })),
        skipDuplicates: true,
      });
    }
  }

  if (salesRepIds) {
    const valid = await prisma.salesRep.findMany({
      where: { tenantId: tid, id: { in: salesRepIds } }, select: { id: true },
    });
    const want = new Set(valid.map((r) => r.id));
    const current = await prisma.adminRepScope.findMany({ where: { adminId }, select: { salesRepId: true } });
    const have = new Set(current.map((r) => r.salesRepId));
    const toAdd = [...want].filter((id) => !have.has(id));
    const toRemove = [...have].filter((id) => !want.has(id));
    if (toRemove.length) await prisma.adminRepScope.deleteMany({ where: { adminId, salesRepId: { in: toRemove } } });
    if (toAdd.length) {
      await prisma.adminRepScope.createMany({
        data: toAdd.map((salesRepId) => ({ tenantId: tid, adminId, salesRepId })),
        skipDuplicates: true,
      });
    }
  }

  const [customers, reps] = await Promise.all([
    prisma.adminCustomerScope.count({ where: { adminId } }),
    prisma.adminRepScope.count({ where: { adminId } }),
  ]);
  return { customers, reps };
}

/**
 * شكل السجلّ من حيث علاقتَي العميل والمندوب على النموذج المُستعلَم: هل كلٌّ منهما
 * إلزاميّ (`String`) أم اختياريّ (`String?`).
 *
 * ═══════════════ لماذا يجب أن يعرف القيدُ الشكلَ (خللٌ كسر الميزة) ═══════════════
 * استثناء «السجلّ بلا عميل/مندوب» كان يُصاغ دائماً بـ`{ customerId: null }` /
 * `{ salesRepId: null }`. لكن **Prisma يرفض `null` على حقلٍ إلزاميّ** (نوع الفلتر
 * لا يقبل null) فيرمي `PrismaClientValidationError` ⇒ استجابة 500. و`customerId`
 * إلزاميّ في الفاتورة/السند/الزيارة، و`salesRepId` إلزاميّ في الزيارة — فأول
 * مستخدمٍ فُعِّل نطاقُه فعلاً عُطِّلت عنه لوحةُ التحكم وكل القوائم.
 *
 * والاستثناء بلا معنى أصلاً على الحقل الإلزاميّ: لا فاتورة بلا عميل ولا زيارة بلا
 * مندوب — فقيد العلاقة وحده هو الصحيح. الاستثناء يلزم فقط حيث الحقل اختياريّ
 * حقّاً (الإشعار على مستوى الشركة قد يكون بلا عميل ولا مندوب).
 */
export interface RecordShape {
  customer: 'required' | 'nullable';
  rep: 'required' | 'nullable';
}

/** الفاتورة والسند: لكلٍّ عميلٌ إلزاميّ، وقد لا يكون له مندوب (سجلّ أنشأته الإدارة). */
export const SHAPE_INVOICE_RECEIPT: RecordShape = { customer: 'required', rep: 'nullable' };
/** زيارة المندوب (RepVisit): العميل والمندوب كلاهما إلزاميّ — لا استثناء null لأيّهما. */
export const SHAPE_VISIT: RecordShape = { customer: 'required', rep: 'required' };
/** الإشعار: قد يكون على مستوى الشركة بلا عميل ولا مندوب — كلاهما اختياريّ. */
export const SHAPE_NOTIFICATION: RecordShape = { customer: 'nullable', rep: 'nullable' };

/**
 * قيد على أي سجلّ يحمل `customerId` و/أو `salesRepId` (فاتورة، سند، زيارة…).
 *
 * القاعدة **AND لا OR**: السجلّ يظهر فقط إن كان عميله **وأيضاً** مندوبه ضمن
 * النطاق. الجمع بـOR يسرّب: فاتورةٌ لعميل مرئيّ حرّرها مندوب مخفيّ تكشف اسم
 * المندوب وأداءه، والعكس يكشف اسم العميل ورصيده.
 *
 * `shape` **إلزاميّ** (لا افتراضيّ عمداً): كل مستدعٍ يصرّح بشكل نموذجه، فالمترجم
 * يفشل عند إغفاله — وإلا عاد خللُ null الصامت على نموذجٍ إلزاميّ الحقول.
 */
export async function scopedRecordWhere(req: AuthRequest, shape: RecordShape): Promise<Record<string, unknown>> {
  const [cust, rep] = await Promise.all([adminCustomerFilter(req), adminRepFilter(req)]);
  return composeRecordWhere(cust, rep, shape);
}

/**
 * تركيب القيد — مفصولٌ عن قاعدة البيانات ليُختبَر وحده (القاعدة أعلاه).
 *
 * على الحقل **الإلزاميّ** يُكتفى بقيد العلاقة (`{ customer: … }`) بلا استثناء
 * null — فالسجلّ لا يكون بلا ذلك الطرف، واستثناء null يرميه Prisma. وعلى الحقل
 * **الاختياريّ** يُضاف `OR` باستثناء `{ …Id: null }` كي لا يختفي سجلّ المكتب
 * (بلا مندوب) أو الإشعار على مستوى الشركة (بلا عميل) عن المستخدم المقيَّد.
 */
export function composeRecordWhere(
  cust: AdminCustomerFilter,
  rep: AdminRepFilter,
  shape: RecordShape,
): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  if (cust.adminScopes) {
    const scoped = { customer: { adminScopes: cust.adminScopes } };
    and.push(shape.customer === 'nullable' ? { OR: [scoped, { customerId: null }] } : scoped);
  }
  if (rep.adminScopes) {
    const scoped = { salesRep: { adminScopes: rep.adminScopes } };
    and.push(shape.rep === 'nullable' ? { OR: [scoped, { salesRepId: null }] } : scoped);
  }
  return and.length ? { AND: and } : {};
}

/** قيد على سجلّ يحمل `salesRepId` فقط (موقع مندوب، جلسة حضور، تحميل سيارة) */
export async function scopedRepRecordWhere(req: AuthRequest): Promise<Record<string, unknown>> {
  const rep = await adminRepFilter(req);
  return rep.adminScopes ? { salesRep: { adminScopes: rep.adminScopes } } : {};
}

/** يقرأ نطاق مستخدم (للواجهة) */
export async function getAdminScope(adminId: string): Promise<{ customerIds: string[]; salesRepIds: string[] }> {
  const [cs, rs] = await Promise.all([
    prisma.adminCustomerScope.findMany({ where: { adminId }, select: { customerId: true } }),
    prisma.adminRepScope.findMany({ where: { adminId }, select: { salesRepId: true } }),
  ]);
  return { customerIds: cs.map((c) => c.customerId), salesRepIds: rs.map((r) => r.salesRepId) };
}
