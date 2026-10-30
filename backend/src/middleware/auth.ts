import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthRequest, AuthPayload } from '../types';
import { bumpRequest } from '../services/requestCounter';
import { liveImpersonationIssuer, auditStaffImpersonationWrite, refuseStaffCredentials } from '../services/platformAccess';
import { ledgerPermissionDecision, LedgerKey } from '../services/gl/permissions';
import {
  apiKeyFromHeaders, isWellFormedApiKey, hashApiKey, apiKeyRouteDecision, takeApiKeyToken, tenantBlockedReason,
  pathAfterApi, markLiveKey, API_KEY_RATE_PER_MINUTE, API_KEY_MAX_PAGE,
} from '../services/apiKeys';

export type AdminPermission =
  | 'canAccessDashboard'
  | 'canManageCustomers'
  | 'canManageProducts'
  | 'canManageSalesReps'
  | 'canManageInvoices'
  | 'canManageReceipts'
  | 'canViewReports'
  | 'canManageVanStock'
  | 'canManageTracking'
  | 'canManageCompanySettings'
  | 'canManageCompanyUsers'
  | 'canManageDailyReport'
  // استلام (توريد) عهدة التحصيل من مستخدمي الشركة — افتراضها false، فيحرسها
  // requireAdminPermission بأمان (يمنع عند القيمة false، فلا يمرّ إلا المفعَّل له)
  | 'canReceiveUserCollections'
  // صلاحية الحذف — يحرسها authenticate على كل طلب DELETE (deleteRefused)، وتُستعمل هنا لحذفٍ يمرّ بـPOST
  | 'canDelete'
  // صلاحيات الدفاتر — تُحرس بـrequireLedgerPermission لا بـrequireAdminPermission
  // (ذاك يمنع عند === false وحدها ويتجاهل الدور، وهذه افتراضها false)
  | 'canViewLedger'
  | 'canPostJournals'
  | 'canManagePayables'
  | 'canManageBank'
  | 'canCloseLedgerPeriods'
  | 'canConfigureLedger';

const COMPANY_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];

export const DELETE_NOT_ALLOWED_MESSAGE = 'لا تملك صلاحية الحذف تواصل مع مدير الشركة';

/**
 * «صلاحية الحذف» لمستخدم الشركة: حارسٌ واحد على كل طلب DELETE بدل حارسٍ في كل مسار — مسار حذفٍ يُضاف غداً محروسٌ
 * تلقائياً. جلسة المالك تتجاوزها كسائر الصلاحيات (isOwnerSession)، والمفتاح البرمجي يرثها من صاحبه.
 */
export function deleteRefused(method: string | undefined, canDelete: boolean | null | undefined, impersonated?: boolean): boolean {
  return (method || '').toUpperCase() === 'DELETE' && canDelete === false && impersonated !== true;
}

// خنق تحديث «آخر ظهور» لمستخدمي الشركة: لا نكتب أكثر من مرة/دقيقة للحساب الواحد.
const PRESENCE_THROTTLE_MS = 60 * 1000;

/** مسارات تضبط اعتماد الحساب نفسه بـauthenticate في مسارها — ممنوعة على جلسة «دخول» الموظف (refuseStaffCredentials) */
const STAFF_DENIED_SELF_PATHS: ReadonlySet<string> = new Set(['/api/auth/change-password']);

/**
 * مسار الطلب كما وجّهه Express (الأساس + المسار): بلا استعلام ولا شرطة أخيرة وبلا حساسية حالة. لا originalUrl: سطر الطلب
 * برابطٍ مطلق (POST http://host/api/auth/change-password) يوجّهه Express بمساره ويبقى originalUrl رابطاً كاملاً لا يطابق
 */
function normalizedUrlPath(req: AuthRequest): string {
  return `${req.baseUrl ?? ''}${req.path ?? ''}`.toLowerCase().replace(/\/+$/, '') || '/';
}

/**
 * التحقّق من الجلسة — **والحساب نفسه لمستخدمي لوحة الشركة**.
 *
 * التوكن يعيش ٨ ساعات، فالدور المحفور فيه لا يكفي: حسابٌ حُذف أو عُطِّل يبقى
 * توكنه صالحاً حتى انتهائه، يقرأ ويكتب كأن شيئاً لم يكن.
 *
 * والأخطر أن الحذف كان **يفتح** لا يغلق: قارئ النطاق `adminScopeEnabled` يبحث
 * عن الصفّ فلا يجده فيستنتج «بلا تقييد» = رؤية كاملة. أي أن مستخدماً مقيّداً
 * حُذف حسابه كان يكسب رؤيةً أوسع ممّا كانت له وهو قائم.
 *
 * **الفحص لمستخدمي اللوحة وحدهم عمداً:** المندوب يرسل نبضة موقع كل دقائق،
 * وإضافة قراءةٍ لكل نبضة كلفةٌ في مسار ساخن بلا مقابل — وحساباته يحرسها
 * مسارها. ومستخدمو اللوحة قلّة وطلباتهم تحميل صفحات لا نبضات.
 */
export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // مفتاح «الربط البرمجي API» — يُصادِق على المسارات نفسها بهوية صاحبه (services/apiKeys.ts)
  const presentedKey = apiKeyFromHeaders(req.headers as { authorization?: string; 'x-api-key'?: string | string[] });
  if (presentedKey) { await authenticateApiKey(req, res, next, presentedKey); return; }

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ success: false, message: 'غير مصرح' });
    return;
  }
  let payload: AuthPayload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload;
  } catch {
    res.status(401).json({ success: false, message: 'جلسة منتهية يرجى تسجيل الدخول مجددا' });
    return;
  }
  req.user = payload;

  // جلسة «دخول» إلى حساب شركة: مُصدِرها (المالك أو موظف المنصة) يُقرأ في كل طلب — تعطيله أو إخراجه من أجهزته أو سحب
  // صلاحية «الدخول» منه يُسقطها فوراً، وتوكنٌ بلا مُصدِر (قبل «موظفي المنصة») لا يُقبل (services/platformAccess.ts)
  if (payload.impersonated) {
    try {
      const issuer = await liveImpersonationIssuer(payload);
      if (!issuer) {
        res.status(401).json({ success: false, code: 'IMPERSONATION_ENDED', message: 'انتهت جلسة الدخول الى الشركة' });
        return;
      }
      // جلسة الموظف: كل كتابةٍ سطرٌ باسمه في سجل نشاط المنصة قبل التنفيذ (تعذّره ٥٠٣) — جلسة المالك كما هي
      if (!(await auditStaffImpersonationWrite(req, res, issuer.name))) return;
      // وتغيير كلمة مرور الحساب نفسه اعتمادٌ يبقى بعدها — مساره (/api/auth) خارج موجّهات الشركة فيُحرس هنا
      if (STAFF_DENIED_SELF_PATHS.has(normalizedUrlPath(req)) && refuseStaffCredentials(req, res)) return;
    } catch (err) { next(err); return; }
  }

  // عدّ الطلبات (الاستهلاك) لكل مستخدم — تراكمٌ في الذاكرة، إفراغٌ دوريّ. نتخطّى
  // المالك (لا شركة له) وجلساتِ الانتحال (كي لا تُنسَب طلبات المالك لمستخدم الشركة).
  if (payload.tenantId && !payload.impersonated) {
    if (payload.role === 'SALES_REP') bumpRequest('rep', payload.id, payload.tenantId);
    else if (COMPANY_ROLES.includes(payload.role)) bumpRequest('admin', payload.id, payload.tenantId);
  }

  if (!COMPANY_ROLES.includes(payload.role)) { next(); return; }
  try {
    const admin = await prisma.admin.findUnique({
      where: { id: payload.id },
      select: { isActive: true, lastSeenAt: true, canDelete: true },
    });
    if (!admin?.isActive) {
      res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب سجل الدخول مجددا' });
      return;
    }
    if (deleteRefused(req.method, admin.canDelete, payload.impersonated)) {
      res.status(403).json({ success: false, code: 'DELETE_NOT_ALLOWED', message: DELETE_NOT_ALLOWED_MESSAGE });
      return;
    }
    // لمسة «آخر ظهور» لعدّاد «الزيارات الحية» في لوحة المالك — مخنوقة لمرة/دقيقة،
    // وغير مُنتظَرة كي لا تؤخّر الرد؛ فشلها لا يهمّ فالحضور best-effort.
    //
    // نتخطّاها في جلسة انتحال المالك (impersonated): وإلّا لبمّط دخولُ المالك لوحةَ
    // شركةٍ صفَّ أدمنها كأنه «متصل الآن» فتظهر الشركة حيّة زوراً — تلويثٌ للمقياس نفسه.
    //
    // البوّابة السريعة (القيمة المقروءة) تتجنّب إطلاق أمرٍ حين يكون الظهور حديثاً،
    // والكتابة نفسها ذرّيّة مشروطة (updateMany بشرط النافذة على الصفّ): تحت برستٍ
    // من طلبات متوازية للحساب ذاته يربح صفٌّ واحد فقط ويُلغى الباقي في القاعدة،
    // فلا يتحوّل الخنق إلى N كتابة. (dsd-backend نسخة واحدة، لكن هذا يصمد أيّاً كان.)
    if (!payload.impersonated && (!admin.lastSeenAt || Date.now() - new Date(admin.lastSeenAt).getTime() > PRESENCE_THROTTLE_MS)) {
      const cutoff = new Date(Date.now() - PRESENCE_THROTTLE_MS);
      prisma.admin.updateMany({
        where: { id: payload.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] },
        data: { lastSeenAt: new Date() },
      }).catch(() => { /* لمسة حضور best-effort */ });
    }
    next();
  } catch (err) {
    next(err);
  }
}

// خنق «آخر استعمال» لمفتاح API — مرة/دقيقة كخنق الحضور
const API_KEY_TOUCH_MS = 60 * 1000;

/** limit في قوائم اللوحة: أعلاه API_KEY_MAX_PAGE لطلب المفتاح (القوائم بلا سقف في الخادم) */
function clampPageQuery(req: AuthRequest): void {
  const q = req.query as Record<string, unknown> | undefined;
  if (!q || q.limit === undefined) return;
  const n = Number(Array.isArray(q.limit) ? q.limit[0] : q.limit);
  if (!Number.isFinite(n) || n > API_KEY_MAX_PAGE) q.limit = String(API_KEY_MAX_PAGE);
}

/**
 * مصادقة مفتاح «الربط البرمجي API»: يصير الطلب طلبَ المستخدم الذي أصدر المفتاح — بدوره وشركته —
 * فتسري عليه حرّاس الصلاحية والنطاق والأعلام في كل مسار كما تسري على صاحبه في اللوحة.
 *
 * ما يُفحص في كل طلب (لا مرة عند الإصدار): المفتاح غير ملغى، والميزة مفعّلة للشركة، واشتراكها
 * نافذ (الجلسة تُفحص عند الدخول وتعيش ٨ ساعات، والمفتاح لا دخول له فيُفحص هنا)، وصاحبه فعّال
 * وفي الشركة نفسها، والمسار ليس ممّا يملك الحساب، والمفتاح «قراءة فقط» لا يكتب، وحدّ الدقيقة.
 * ولا `impersonated` أبداً: المفتاح لا يرث تجاوزات جلسة المالك ولو أصدره المالك.
 */
async function authenticateApiKey(req: AuthRequest, res: Response, next: NextFunction, key: string): Promise<void> {
  const invalid = () => res.status(401).json({ success: false, code: 'API_KEY_INVALID', message: 'مفتاح API غير صالح أو ملغى' });
  if (!isWellFormedApiKey(key)) { invalid(); return; }
  // سطر الطلب برابطٍ مطلق (GET http://host/api/auth/me) يوجّهه Express بمساره، لكنّ نصّه لا يبدأ بـ/api —
  // لا عميل سليم يرسله، فيُردّ قبل أي حكم بدل أن يُفهم مساره بطريقتين
  if (!String(req.originalUrl ?? req.url ?? '/').startsWith('/')) {
    res.status(400).json({ success: false, code: 'BAD_REQUEST_TARGET', message: 'صيغة الطلب غير مدعومة' });
    return;
  }
  try {
    const hash = hashApiKey(key);
    const row = await prisma.apiKey.findUnique({
      where: { keyHash: hash },
      select: {
        id: true, tenantId: true, readOnly: true, revokedAt: true, lastUsedAt: true, createdBy: true,
        admin: { select: { id: true, name: true, role: true, isActive: true, tenantId: true, canDelete: true } },
        tenant: { select: { apiEnabled: true, isActive: true, subscriptionEndsAt: true } },
      },
    });
    if (!row || row.revokedAt) { invalid(); return; }

    // الحدّ قبل أي رفض: طلبٌ مرفوض يُحسب على مفتاحه كالمقبول، وإلا صار تكرار المرفوض بلا سقف
    const quota = takeApiKeyToken(row.id);
    res.setHeader('X-RateLimit-Limit', String(API_KEY_RATE_PER_MINUTE));
    if (!quota.ok) {
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('Retry-After', String(quota.retryAfterSec));
      res.status(429).json({ success: false, code: 'API_RATE_LIMIT', message: 'تجاوزت حد الطلبات للمفتاح في الدقيقة حاول بعد قليل' });
      return;
    }
    res.setHeader('X-RateLimit-Remaining', String(quota.remaining));

    if (row.tenant.apiEnabled !== true) {
      res.status(403).json({ success: false, code: 'API_NOT_ALLOWED', message: 'الربط البرمجي API غير مفعل لاشتراك شركتك تواصل مع مزود الخدمة' });
      return;
    }
    const blocked = tenantBlockedReason(row.tenant);
    if (blocked) { res.status(403).json({ success: false, code: 'TENANT_BLOCKED', message: blocked }); return; }
    if (!row.admin.isActive || row.admin.tenantId !== row.tenantId || !COMPANY_ROLES.includes(row.admin.role)) {
      res.status(401).json({ success: false, code: 'API_KEY_OWNER_INACTIVE', message: 'حساب المستخدم صاحب المفتاح معطل' });
      return;
    }
    // المفتاح يرث «صلاحية الحذف» من صاحبه — ولو أصدره الدعم الفني (ownerIssuedKey بلا تجاوزات الجلسة)
    if (deleteRefused(req.method, row.admin.canDelete)) {
      res.status(403).json({ success: false, code: 'DELETE_NOT_ALLOWED', message: DELETE_NOT_ALLOWED_MESSAGE });
      return;
    }
    // الحكم على المسار الذي طابقه Express فعلاً (baseUrl + path) **وعلى** نصّ الطلب — يُرفض إن منعه أيّهما
    const matched = `${req.baseUrl ?? ''}${req.path ?? ''}`;
    const denied = apiKeyRouteDecision(req.method, pathAfterApi(matched || (req.originalUrl ?? req.url ?? '')), row.readOnly)
      ?? apiKeyRouteDecision(req.method, pathAfterApi(req.originalUrl ?? req.url ?? ''), row.readOnly);
    if (denied) { res.status(403).json({ success: false, code: 'API_KEY_FORBIDDEN', message: denied }); return; }

    req.user = {
      id: row.admin.id,
      role: row.admin.role as AuthPayload['role'],
      name: row.admin.name,
      tenantId: row.tenantId,
      apiKeyId: row.id,
      // مفتاحٌ أصدره الدعم الفني (جلسة المالك): أفعاله تُسجَّل OWNER: كجلسته — بلا تجاوزاتها
      ...((row.createdBy || '').startsWith('OWNER:') ? { ownerIssuedKey: true } : {}),
    };
    // يُمحى هنا شيءٌ واحد: ترويسة X-FS-Replay — ترويسة صندوق تطبيق المندوب حين يعيد رفع ما سُجّل دون اتصال، ويتسامح معها
    // الخادم لأن المال قُبض فعلاً والمستند لا يُعدَم (مفتاح طريقة دفع مجهول يسقط بصمت، والمعطّلة تُقبل، ومستند قبل تفعيل
    // المرحلة الثانية يُقبل مرحلةً أولى، وaiPlaceId مكرّر يُسقط ربطه بدل 409). المفتاح عميلٌ حيّ لا صندوق إرسال فلا
    // يرث ذلك بإرسال ترويسة، فتُمحى قبل أي موجّه. أمّا X-FS-Caps فتبقى عمداً (بها يعلن المكامل طباعة رمز المرحلة الثانية).
    // والمحو لا يغطّي تسامحاً يُشتقّ من **الجسم**: ذاك يُحكم عند نقطته بهوية المصادقة (req.user.apiKeyId) — مثل clientRef في
    // POST /customers (routes/customersZatca.ts applyBuyerGateToWrite). والمندوب لا يتأثّر: لا يصادق بمفتاح
    delete req.headers['x-fs-replay'];
    markLiveKey(hash);
    // صفحة قوائم اللوحة محدودة للمفتاح — والسحب الكامل من /api/v1/sync بحدوده الخاصة
    if (!pathAfterApi(matched || (req.originalUrl ?? '')).startsWith('/v1/')) clampPageQuery(req);
    bumpRequest('admin', row.admin.id, row.tenantId);
    if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() > API_KEY_TOUCH_MS) {
      const cutoff = new Date(Date.now() - API_KEY_TOUCH_MS);
      prisma.apiKey.updateMany({
        where: { id: row.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: cutoff } }] },
        data: { lastUsedAt: new Date() },
      }).catch(() => { /* best-effort */ });
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * جلسة مالك المنصة داخل شركة (توكن انتحال من POST /api/tenants/:id/impersonate — لا يصدره إلا SUPER_ADMIN): كل صلاحية مفتوحة
 * ولا نطاق يقيّدها، أياً كانت صلاحيات حساب المدير الذي وُقّع به التوكن. أمر المالك (٢٩ سبتمبر ٢٠٢٦): «اجعل لي كمالك صلاحية تعديل كل شيء بلا استثناء».
 * كل حارس صلاحية أو نطاق يسأل هذه الدالة أولاً؛ وأفعال الجلسة تبقى موسومة «الدعم الفني» في التدقيق.
 * وجلسةٌ أصدرها موظف منصة بصلاحية «الدخول» مثلها، عدا الاعتمادات الدائمة (refuseStaffCredentials) وسطرٍ لكل كتابة باسمه في
 * سجل نشاط المنصة (services/platformAccess.ts).
 */
export function isOwnerSession(req: { user?: { impersonated?: boolean } | null }): boolean {
  return req.user?.impersonated === true;
}

/**
 * «من فعلها» لحقول التدقيق النصية (updatedById، changedById، سجلّ الدرس): توكن الانتحال يحمل معرّف مدير الشركة،
 * فجلسة المالك تُسجَّل OWNER:<المعرّف> لا باسم المدير — وعد اتفاقية البيانات «لا يدخل حسابك إلا مديره».
 */
export function actorOf(req: { user?: { id?: string; impersonated?: boolean; ownerIssuedKey?: boolean } | null }): string {
  const id = req.user?.id ?? '';
  // ومفتاح API أصدره الدعم الفني يُسجَّل مثل جلسته — دون أن يرث تجاوزاتها (isOwnerSession لا تنظر إليه)
  return isOwnerSession(req) || req.user?.ownerIssuedKey === true ? `OWNER:${id}` : id;
}

/** دور لوحة الشركة. حياة الحساب (حذف/تعطيل) تُفحص في `authenticate` قبله. */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || !COMPANY_ROLES.includes(req.user.role)) {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

export function requireAdminPermission(permission: AdminPermission) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (req.user?.role === 'SALES_REP') { next(); return; }
      if (!req.user || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user.role)) {
        res.status(403).json({ success: false, message: 'غير مسموح' });
        return;
      }
      // جلسة مالك المنصة: كل صلاحية مفتوحة (حياة الحساب فحصها authenticate قبله)
      if (isOwnerSession(req)) { next(); return; }
      // نجلب السجلّ كاملاً بدل select بمفتاح ديناميكي: المفتاح الديناميكي
      // يجعل نوع النتيجة اتّحاداً يشمل حقول العلاقات (adminScopes…) فيفشل
      // فحص الأنواع. السجلّ صغير وبمفتاح أساسي، فالكلفة مهملة والقراءة أوضح.
      const admin = await prisma.admin.findUnique({ where: { id: req.user.id } });
      if (!admin?.isActive || admin[permission] === false) {
        res.status(403).json({ success: false, message: 'لا تملك صلاحية الوصول لهذا القسم' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireSalesRep(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'SALES_REP') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

// مالك المنصّة فقط (إدارة الشركات والاشتراكات)
export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    res.status(403).json({ success: false, message: 'غير مسموح' });
    return;
  }
  next();
}

// يضمن وجود معرّف شركة لكل مستخدم (عدا السوبر أدمن) — حارس ضد تسريب البيانات
export function tenantId(req: AuthRequest): string {
  if (!req.user?.tenantId) throw new Error('لا توجد شركة مرتبطة بالحساب');
  return req.user.tenantId;
}

// حارس «النظام المحاسبي» — يعزل المنتجات ومخزون السيارات والمستودع والفواتير والسندات.
// خلافاً لبقيّة أعلام الاشتراك، افتراض هذا العَلَم `true`: فلا نمنع إلا حين يكون
// `false` صراحةً. و`!t?.accountingEnabled` خطأٌ هنا لأنّه يمنع أيضاً عند تعذّر القراءة.
// ونقرأ tenantId من الطلب مباشرةً لا عبر tenantId(req): الأخيرة ترمي استثناءً
// للسوبر أدمن (لا شركة له) فتحوّل مروره من 403 إلى 500.
/**
 * التقرير اليومي — ميزة اشتراك **مطفأة افتراضياً**.
 *
 * الشرط `!== true` لا `=== false`، عكسَ حارس المحاسبة: ذاك عَلَمٌ مفعّل
 * افتراضياً فيُمنع عند false الصريحة وحدها؛ وهذا مطفأ افتراضياً، فتعذّرُ
 * قراءة الصفّ يجب أن **يمنع** لا أن يفتح. وقلبُ الشرط هنا يفتح الميزة
 * لكل شركة تعذّرت قراءة صفّها.
 */
export async function requireDailyReport(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    // لا شركة = سوبر أدمن؛ تمريره كما في requireAccounting (tenantId(req) ترمي له)
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { dailyReportEnabled: true } });
    if (t?.dailyReportEnabled !== true) {
      res.status(403).json({ success: false, code: 'DAILY_REPORT_NOT_ALLOWED', message: 'التقرير اليومي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * صفحة «طرق الدفع» (GET /api/reports/payment-methods) — ميزة اشتراك **مطفأة افتراضياً** يفعّلها المالك لكل شركة.
 *
 * - الشرط `!== true` لا `=== false` (كالتقرير اليومي): تعذّرُ قراءة الصفّ يجب أن **يمنع** لا أن يفتح.
 * - وأرقامها كلها من سندات القبض وفواتير البيع النقدي، فهي صفحةٌ مالية: المحاسبة المطفأة تمنعها **قبل** فحص عَلَمها
 *   (ACCOUNTING_NOT_ALLOWED كتقييم الأداء بمعياره الماليّ) — فلا يرى المستخدم «غير مفعّلة» لميزةٍ اشتُريت وهي محجوبةٌ بغيرها.
 * - الشركة من الطلب مباشرةً (`req.user?.tenantId`): tenantId(req) ترمي للسوبر أدمن فتحوّل ٤٠٣ إلى ٥٠٠.
 * - جلسة المالك (الانتحال) لا تتجاوز العَلَم: العَلَم صلاحية اشتراكٍ للشركة لا صلاحية مستخدم.
 */
export async function requirePaymentMethods(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    // لا شركة = سوبر أدمن؛ تمريره كما في requireAccounting
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { paymentMethodsEnabled: true, accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    if (t?.paymentMethodsEnabled !== true) {
      res.status(403).json({ success: false, code: 'PAYMENT_METHODS_NOT_ALLOWED', message: 'صفحة طرق الدفع غير مفعّلة لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * «لوكيشن» (/api/locations: المواقع وإسناد المناديب وملخّص الفواتير والتحميلات لكل موقع) — ميزة اشتراك **مطفأة
 * افتراضياً** يفعّلها المالك لكل شركة (services/locations.ts). على نمط requirePaymentMethods حرفياً:
 * - الشرط `!== true` لا `=== false`: تعذّرُ قراءة الصفّ يجب أن **يمنع** لا أن يفتح.
 * - ما تختمه الميزة فواتيرُ وتحميلات — وحدات «النظام المحاسبي» — فالمحاسبة المطفأة تمنعها **قبل** فحص عَلَمها
 *   (ACCOUNTING_NOT_ALLOWED)، فلا يرى المستخدم «غير مفعّلة» لميزةٍ اشتُريت وهي محجوبةٌ بغيرها.
 * - الشركة من الطلب مباشرةً (`req.user?.tenantId`): tenantId(req) ترمي للسوبر أدمن فتحوّل ٤٠٣ إلى ٥٠٠.
 * - جلسة المالك (الانتحال) لا تتجاوز العَلَم: العَلَم صلاحية اشتراكٍ للشركة لا صلاحية مستخدم.
 * - يحرس صفحة الميزة وحدها: الختم في مسارات الإصدار يقرأ العَلَم من صفّ المندوب نفسه (repStampLocation)، وفلتر الموقع
 *   في قائمتَي الفواتير والتحميلات مفتاحٌ بريء لا يكشف شيئاً لشركةٍ بلا مواقع.
 */
export async function requireLocations(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    // لا شركة = سوبر أدمن؛ تمريره كما في requireAccounting
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { locationsEnabled: true, accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    if (t?.locationsEnabled !== true) {
      res.status(403).json({ success: false, code: 'LOCATIONS_NOT_ALLOWED', message: 'صفحة لوكيشن غير مفعّلة لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * «تتبّع اللوط» (/api/lots) — ميزة **مطفأة افتراضياً** يفعّلها المالك لكل شركة (services/lots.ts). نسخة requireLocations:
 * المحاسبة المطفأة تمنع أولاً (اللوط على المخزون والفواتير)، ثم العَلَم بشرط `!== true`، والشركة من الطلب مباشرةً،
 * وجلسة المالك لا تتجاوز العَلَم. يحرس موجّه اللوط وحده: مسارات الإصدار والتحميل تقرأ العَلَم من صفٍّ محمَّل أصلاً.
 */
export async function requireLots(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true, accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    if (t?.lotTrackingEnabled !== true) {
      res.status(403).json({ success: false, code: 'LOTS_NOT_ALLOWED', message: 'تتبع LOT غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

export async function requireAccounting(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true } });
    if (t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_NOT_ALLOWED', message: 'النظام المحاسبي غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * النظام المحاسبي المتكامل — مطفأ افتراضياً: الشرط `!== true` (نمط requireDailyReport).
 * ويشترط أيضاً ألا يكون النظام المحاسبي (accountingEnabled) مطفأً صراحةً.
 * tenantId من req.user مباشرةً: tenantId(req) ترمي للسوبر أدمن فتحوّل 403 إلى 500.
 */
export async function requireAccountingSuite(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const tid = req.user?.tenantId;
    if (!tid) { next(); return; }
    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { accountingSuiteEnabled: true, accountingEnabled: true } });
    if (t?.accountingSuiteEnabled !== true || t?.accountingEnabled === false) {
      res.status(403).json({ success: false, code: 'ACCOUNTING_SUITE_NOT_ALLOWED', message: 'النظام المحاسبي المتكامل غير مفعّل لهذه الشركة تواصل مع مزود الخدمة' });
      return;
    }
    next();
  } catch (err) { next(err); }
}

/**
 * صلاحية الدفاتر (§9.1) — يُقرأ المستخدم من القاعدة لا من التوكن، والمسند الصرف
 * `ledgerPermissionDecision` يطابق `canLedger` في الويب:
 * مقيّد النطاق ⇒ LEDGER_SCOPED_ADMIN؛ مالك الشركة (ADMIN مع canManageCompanyUsers)
 * يمرّ؛ canViewLedger يمرّ بأيٍّ من الست؛ غير ذلك true الصريحة وحدها ⇒ وإلا
 * LEDGER_PERMISSION_DENIED. المندوب يمنعه requireAdmin قبله في سلسلة الموجّه.
 */
export function requireLedgerPermission(key: LedgerKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const tid = req.user?.tenantId;
      if (!req.user || !tid || !COMPANY_ROLES.includes(req.user.role)) {
        res.status(403).json({ success: false, code: 'LEDGER_PERMISSION_DENIED', message: 'لا تملك صلاحية الوصول لهذا القسم' });
        return;
      }
      // جلسة مالك المنصة: كل صلاحيات الدفاتر ولا نطاق
      if (isOwnerSession(req)) { next(); return; }
      const admin = await prisma.admin.findUnique({
        where: { id: req.user.id },
        select: {
          isActive: true, tenantId: true, role: true, canManageCompanyUsers: true, scopeEnabled: true,
          canViewLedger: true, canPostJournals: true, canManagePayables: true,
          canManageBank: true, canCloseLedgerPeriods: true, canConfigureLedger: true,
        },
      });
      const decision = ledgerPermissionDecision(admin, key, tid);
      if (decision === 'SCOPED') {
        res.status(403).json({ success: false, code: 'LEDGER_SCOPED_ADMIN', message: 'الدفاتر على مستوى الشركة كلها وحسابك مقيد بنطاق محدد' });
        return;
      }
      if (decision !== 'ALLOW') {
        res.status(403).json({ success: false, code: 'LEDGER_PERMISSION_DENIED', message: 'لا تملك صلاحية الوصول لهذا القسم' });
        return;
      }
      next();
    } catch (err) { next(err); }
  };
}
