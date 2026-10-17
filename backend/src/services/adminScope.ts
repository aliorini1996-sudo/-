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

/**
 * قيد Prisma على المناديب: قوائم يدوية (adminScopes)، أو — لمشرف الفرق (scopeMode=TEAMS) — مناديب الفرق التي يشرف عليها
 * (teamMemberships). «مقيّد» يُستدلّ عليه من أي مفتاح (isRestricted) لا من اسم مفتاحٍ بعينه.
 */
export type AdminRepFilter = {
  adminScopes?: { some: { adminId: string } };
  teamMemberships?: { some: { team: { supervisors: { some: { adminId: string } } } } };
};

/** فلترٌ بأي مفتاح = مقيّد؛ الفارغ = رؤية كاملة */
const isRestricted = (f: object) => Object.keys(f).length > 0;

/** وضع نطاق المستخدم: null بلا تقييد، LISTS قوائم يدوية، TEAMS مشرف فرق (الفرق، Admin.scopeMode) */
export type AdminScopeMode = 'LISTS' | 'TEAMS';

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
  // جلسة مالك المنصة لا نطاق يقيّدها (يرى الشركة كلها ويعمل فيها بلا استثناء) — صريحةٌ هنا وفي adminScopeModeOf
  if (req.user?.impersonated === true) return false;
  return (await adminScopeModeOf(req)) !== null;
}

/**
 * وضع نطاق المستخدم في استعلامٍ واحد (كما كان: صفّ المستخدم وحده). scopeEnabled يبقى الإشارة الوحيدة إلى «مقيّد» —
 * فمشرف الفرق مقيّدٌ في كل بوّابات «ممنوع على المقيّد» (الدفاتر، المفاتيح، الاستيراد، ERP…) كالمقيّد بالقوائم.
 */
export async function adminScopeModeOf(req: AuthRequest): Promise<AdminScopeMode | null> {
  if (!isCompanyUser(req)) return null;
  // جلسة مالك المنصة لا نطاق يقيّدها (يرى الشركة كلها ويعمل فيها بلا استثناء)
  if (req.user?.impersonated === true) return null;
  const admin = await prisma.admin.findUnique({
    where: { id: req.user!.id },
    select: { scopeEnabled: true, scopeMode: true },
  });
  if (admin?.scopeEnabled !== true) return null;
  return admin.scopeMode === 'TEAMS' ? 'TEAMS' : 'LISTS';
}

/**
 * قيد رؤية العملاء لمستخدم الشركة — يُدمج في استعلامات العملاء. مشرف الفرق يرى كل العملاء (قرار المالك: العملاء
 * مشتركون بين الفرق)، والفصل في المناديب والمستندات الموسومة.
 */
export async function adminCustomerFilter(req: AuthRequest): Promise<AdminCustomerFilter> {
  const mode = await adminScopeModeOf(req);
  if (mode !== 'LISTS') return {};
  return { adminScopes: { some: { adminId: req.user!.id } } };
}

/** قيد رؤية المناديب لمستخدم الشركة — يُدمج في استعلامات المناديب. مشرف الفرق: مناديب فرقه (عضويتهم الحالية) */
export async function adminRepFilter(req: AuthRequest): Promise<AdminRepFilter> {
  const mode = await adminScopeModeOf(req);
  if (mode === null) return {};
  if (mode === 'TEAMS') return { teamMemberships: { some: { team: { supervisors: { some: { adminId: req.user!.id } } } } } };
  return { adminScopes: { some: { adminId: req.user!.id } } };
}

/**
 * هل يرى هذا المستخدم هذا العميل؟ تُستخدم في المسارات التي تستقبل customerId
 * من العميل (تفاصيل/تعديل/إسناد) كي لا يُتجاوز العزل بتمرير معرّف مباشرةً.
 */
export async function canAccessCustomerAsAdmin(req: AuthRequest, tid: string, customerId: string): Promise<boolean> {
  const filter = await adminCustomerFilter(req);
  if (!isRestricted(filter)) return true;
  const found = await prisma.customer.findFirst({
    where: { id: customerId, tenantId: tid, ...filter },
    select: { id: true },
  });
  return found !== null;
}

/** هل يرى هذا المستخدم هذا المندوب؟ (يحرس الإسناد من الكتابة العمياء) */
export async function canAccessRep(req: AuthRequest, tid: string, salesRepId: string): Promise<boolean> {
  const filter = await adminRepFilter(req);
  if (!isRestricted(filter)) return true;
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
  /** «الفرق»: النموذج يحمل وسم الفريق teamId (tagged) فيُقيَّد به مشرف الفرق، أو يتبع فاتورةً موسومة (viaInvoice)،
   *  أو لا يحمله (absent) فبعضوية المندوب */
  team: 'tagged' | 'viaInvoice' | 'absent';
}

/** الفاتورة والسند: لكلٍّ عميلٌ إلزاميّ، وقد لا يكون له مندوب (سجلّ أنشأته الإدارة)، ويحملان وسم الفريق. */
export const SHAPE_INVOICE_RECEIPT: RecordShape = { customer: 'required', rep: 'nullable', team: 'tagged' };
/** زيارة المندوب (RepVisit): العميل والمندوب كلاهما إلزاميّ — لا استثناء null لأيّهما — وتحمل وسم الفريق. */
export const SHAPE_VISIT: RecordShape = { customer: 'required', rep: 'required', team: 'tagged' };
/** الإشعار: قد يكون على مستوى الشركة بلا عميل ولا مندوب — كلاهما اختياريّ — ولا وسم فريقٍ له. */
export const SHAPE_NOTIFICATION: RecordShape = { customer: 'nullable', rep: 'nullable', team: 'absent' };
/** رابط الدفع (CustomerPaymentLink): عميلٌ إلزاميّ ومندوبٌ اختياريّ — ومشرف الفرق بوسم فاتورته (invoiceId إلزاميّ)،
 *  لا بعضوية مندوبه: مندوبٌ في فريقين كان يكشف روابط فواتير الفريق الآخر ويتيح إلغاءها */
export const SHAPE_PAYMENT_LINK: RecordShape = { customer: 'required', rep: 'nullable', team: 'viaInvoice' };

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
  // مشرف الفرق: بوسم المستند (لا بعضوية مندوبه الحالية) — فمندوبٌ في فريقين لا يكشف عمله للفريق الآخر
  if (rep.teamMemberships) return composeTeamRecordWhere(req.user!.id, shape);
  return composeRecordWhere(cust, rep, shape);
}

/**
 * قيد مشرف الفرق — صافٍ ليُختبَر وحده. النموذج الموسوم: ما وُسم بفرقه وحده (والقديم «بلا فريق» ومستند المكتب بلا فريق
 * لا يراهما — فشلٌ مغلق). وبلا وسم (الإشعار): بعضوية مندوبه في فرقه، واستثناء null على الحقل الاختياريّ وحده.
 * مفتاحٌ واحد AND في المستوى الأعلى — المستدعون ينثرون OR بحثهم بعده.
 */
export function composeTeamRecordWhere(adminId: string, shape: RecordShape): Record<string, unknown> {
  const supervised = { supervisors: { some: { adminId } } };
  if (shape.team === 'tagged') return { AND: [{ team: supervised }] };
  if (shape.team === 'viaInvoice') return { AND: [{ invoice: { team: supervised } }] };
  const scoped = { salesRep: { teamMemberships: { some: { team: supervised } } } };
  return { AND: [shape.rep === 'nullable' ? { OR: [scoped, { salesRepId: null }] } : scoped] };
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

/**
 * إعادة الرفع بـclientRef تُعيد السجلّ القائم كاملاً — فللمستخدم المقيَّد يجب أن يقع السجلّ نفسه في نطاقه (عميله
 * ومندوبه، ومشرف الفرق بوسمه)، لا عميله وحده. `find` من المستدعي (findFirst على نموذجه بالقيد)، والمندوب وغير المقيَّد
 * بلا استعلامٍ إضافيّ.
 */
export async function existingInScope(
  req: AuthRequest,
  shape: RecordShape,
  find: (scope: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const scope = await scopedRecordWhere(req, shape);
  if (!Object.keys(scope).length) return true;
  return Boolean(await find(scope));
}

/**
 * مشرف الفرق (وضع TEAMS): معرّفه لقيود ما لا شكل مستندٍ له — استلامات التحصيل وقيود كشف الحساب — وإلا null.
 * المقيَّد بالقوائم وغير المقيَّد والمندوب وجلسة المالك: null (بلا قيد فرق).
 */
export async function teamSupervisorIdOf(req: AuthRequest): Promise<string | null> {
  return (await adminScopeModeOf(req)) === 'TEAMS' ? req.user!.id : null;
}

/**
 * قيد الفريق على ما يحمل `teamId` بلا شكل مستند (استلام التحصيل، وسندات العهدة معه): المشرف بفرقه (وإن طلب فريقاً منها
 * فبه وحده)، وغير المقيَّد بالفريق المطلوب إن طلبه، وإلا لا قيد. صافٍ ليُختبَر وحده.
 */
export function composeTeamCustodyWhere(supervisorId: string | null, requestedTeamId?: string | null): Record<string, unknown> {
  const team = requestedTeamId && requestedTeamId !== 'none' ? requestedTeamId : null;
  if (supervisorId) return { team: { ...(team && { id: team }), supervisors: { some: { adminId: supervisorId } } } };
  // 'none': ما لا فريق له (سندات واستلامات ما قبل الميزة، أو المسلَّم «بلا فريق») — ليُستلم صراحةً
  if (requestedTeamId === 'none') return { teamId: null };
  return team ? { teamId: team } : {};
}

/** قيد على سجلّ يحمل `salesRepId` فقط (موقع مندوب، جلسة حضور، تحميل سيارة) — ومشرف الفرق بعضوية مندوبه في فرقه */
export async function scopedRepRecordWhere(req: AuthRequest): Promise<Record<string, unknown>> {
  const rep = await adminRepFilter(req);
  return isRestricted(rep) ? { salesRep: rep } : {};
}

/** يقرأ نطاق مستخدم (للواجهة) */
export async function getAdminScope(adminId: string): Promise<{ customerIds: string[]; salesRepIds: string[] }> {
  const [cs, rs] = await Promise.all([
    prisma.adminCustomerScope.findMany({ where: { adminId }, select: { customerId: true } }),
    prisma.adminRepScope.findMany({ where: { adminId }, select: { salesRepId: true } }),
  ]);
  return { customerIds: cs.map((c) => c.customerId), salesRepIds: rs.map((r) => r.salesRepId) };
}
