/**
 * «موظفو المنصة» (طلب المالك، ٢٣ أكتوبر ٢٠٢٦) — حساباتٌ منفصلة عن مالك المنصة (SuperAdmin) يفتحها المالك ويمنحها من قدرات
 * لوحته ما يشاء، عدا الإدارة المالية (قراره) وإدارة الموظفين أنفسهم (وإلا فتح الموظف لنفسه حساباً بكل شيء).
 *
 * - **الهوية:** جدول platform_staff، وتوكنٌ بسرٍّ مشتقّ (`staffSecret`) — فلا يقبله `authenticate` في أي مسارٍ آخر من المنصة
 *   (توكنٌ غريب ⇒ ٤٠١)، ولا يجدّده /auth/renew، ولا يمرّ من حارس المندوب. يمنع افتراضاً في كل ما لم يُفتح له هنا.
 * - **الحارس `platformGate`** يحلّ محلّ `authenticate, requireSuperAdmin` على مسارات لوحة المالك وحدها. المالك يمرّ كما كان
 *   (وحسابه يُقرأ الآن: المعطَّل لا يمرّ)؛ والموظف يمرّ إن طابق الطلبُ قاعدةً في ROUTE_RULES ومفتاحُها في صلاحياته —
 *   وما لا قاعدة له للمالك وحده.
 * - **الحساب يُقرأ في كل طلب:** التعطيل وسحب الصلاحية و«إخراج من كل الأجهزة» (tokenVersion) تسري فوراً، وكذلك على جلسة
 *   «دخول» أصدرها الموظف إلى حساب شركة (`impersonationIssuerOk` في authenticate، وفي نبضة قناة البث routes/live.ts).
 * - **جلسة «دخول» الموظف لا تُنشئ اعتماداً دائماً** (حساباً أو كلمة مرور أو مفتاح API — `refuseStaffCredentials`): ما يبقى
 *   بعد سقوطها يلتفّ على التعطيل.
 * - **سجل النشاط:** كل طلب كتابةٍ من الموظف — في لوحة المالك وفي جلسة «دخول» أصدرها (باسمه) — وقراءاتٌ حساسة (سطرٌ كل ربع
 *   ساعة للرابط نفسه)، وأفعال المالك الحساسة — يُكتب السطر **قبل** التنفيذ، وتعذّره يمنع الفعل (٥٠٣): لا فعل بلا أثر.
 */
import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../config/database';
import { AuthRequest, AuthPayload } from '../types';
import { apiKeyFromHeaders } from './apiKeys';

// ───────────────────────────── كتالوج الصلاحيات ─────────────────────────────

/** مجموعة = قسمٌ في لوحة المالك. الترتيب ترتيب العرض في نافذة الموظف */
export const STAFF_PERMISSIONS = [
  { key: 'tenants.view', group: 'الشركات', label: 'عرض قائمة الشركات وبياناتها' },
  { key: 'tenants.totals', group: 'الشركات', label: 'إجمالي فواتير ومبيعات المنصة' },
  { key: 'tenants.performance', group: 'الشركات', label: 'تقارير أداء الشركة' },
  { key: 'tenants.create', group: 'الشركات', label: 'إضافة شركة' },
  { key: 'tenants.edit', group: 'الشركات', label: 'تعديل الاشتراك وإيقاف الشركة وتفعيلها' },
  { key: 'tenants.resetPassword', group: 'الشركات', label: 'إعادة كلمة مرور مدير الشركة' },
  { key: 'tenants.impersonate', group: 'الشركات', label: 'الدخول إلى حساب الشركة' },
  { key: 'tenants.ledger', group: 'الشركات', label: 'إعادة ضبط دفاتر الشركة وإعداد فواتير رسوم الدفع' },
  { key: 'tenants.delete', group: 'الشركات', label: 'حذف الشركة نهائيا' },

  { key: 'leads.view', group: 'العملاء المحتملون', label: 'عرض العملاء المحتملين' },
  { key: 'leads.edit', group: 'العملاء المحتملون', label: 'إضافة وتعديل وتسجيل المتابعة والتحويل' },
  { key: 'leads.delete', group: 'العملاء المحتملون', label: 'حذف عميل محتمل' },
  { key: 'leads.hunt', group: 'العملاء المحتملون', label: 'الصيد والإثراء والاستيراد والصيد الآلي' },
  { key: 'leads.message', group: 'العملاء المحتملون', label: 'إرسال البريد وواتساب وإعداداتهما والبريد الآلي' },
  { key: 'leads.export', group: 'العملاء المحتملون', label: 'تصدير العملاء المحتملين' },
  { key: 'waBridge.view', group: 'العملاء المحتملون', label: 'جسر واتساب عرض الجلسة والمحادثات' },
  { key: 'waBridge.send', group: 'العملاء المحتملون', label: 'جسر واتساب الإرسال وإدارة الجلسة' },

  { key: 'invoiceTool.view', group: 'عملاء مولد الفواتير', label: 'عرض عملاء مولد الفواتير' },

  { key: 'waInbox.view', group: 'محادثات بوت واتساب', label: 'عرض محادثات بوت واتساب' },

  { key: 'payments.view', group: 'روابط الدفع', label: 'عرض روابط دفع الاشتراكات' },
  { key: 'payments.manage', group: 'روابط الدفع', label: 'إنشاء روابط الدفع وتحديثها وربطها بشركة' },

  { key: 'affiliates.view', group: 'السفراء', label: 'عرض السفراء والإسنادات والعمولات' },
  { key: 'affiliates.manage', group: 'السفراء', label: 'قبول السفراء ورفضهم وإيقافهم والإسنادات والإعدادات' },
  { key: 'affiliates.payouts', group: 'السفراء', label: 'اعتماد العمولات والدفعات والتسويات' },
  { key: 'affiliates.iban', group: 'السفراء', label: 'كشف رقم الآيبان' },

  { key: 'quotes.view', group: 'عروض الأسعار', label: 'عرض سجل عروض الأسعار' },
  { key: 'quotes.delete', group: 'عروض الأسعار', label: 'حذف عرض سعر' },

  { key: 'content.edit', group: 'محتوى الموقع', label: 'تعديل محتوى الصفحة والبروفايل' },

  { key: 'visits.view', group: 'الزيارات', label: 'زيارات الموقع' },
  { key: 'live.view', group: 'الزيارات', label: 'الزيارات الحية' },
  { key: 'live.requests', group: 'الزيارات', label: 'عداد طلبات مستخدمي الشركات' },
] as const;

export type StaffPermissionKey = typeof STAFF_PERMISSIONS[number]['key'];
const KEYS: ReadonlySet<string> = new Set(STAFF_PERMISSIONS.map((p) => p.key));
export const isStaffPermissionKey = (k: unknown): k is StaffPermissionKey => typeof k === 'string' && KEYS.has(k);

// ───────────────────────────── قواعد المسارات ─────────────────────────────

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface RouteRule {
  method: Method;
  /** على المسار الكامل بأحرف صغيرة بلا شرطة أخيرة (/api/leads/x) — راجع `requestPath` */
  path: RegExp;
  key: StaffPermissionKey;
  /** قراءةٌ حساسة تُسجَّل كالكتابة */
  auditRead?: boolean;
}

const SEG = '[^/]+';
const r = (method: Method, path: string, key: StaffPermissionKey, auditRead?: boolean): RouteRule =>
  ({ method, path: new RegExp(`^${path}$`), key, ...(auditRead ? { auditRead } : {}) });

/**
 * الترتيب مقصود: **الحرفيّ قبل المعامِل** في كل بادئة. والمسار يُطابَق بأحرف صغيرة لأن Express يوجّه بلا حساسية حالة —
 * `/api/leads/INVOICE-TOOL` يصل معالج `/invoice-tool` لا `/:id`، فمطابقته حرفاً بحرف كانت تعطيه مفتاح `leads.view`.
 *
 * ما لا قاعدة له للمالك وحده: /api/finance/* (قرار المالك)، /api/paylink/owner/* (أمانات «الإدارة المالية»)،
 * /api/tenants/ops/* (MRR والتقرير الأسبوعي)، /api/promo-videos/*، /api/platform-staff/* (إدارة الموظفين).
 */
export const ROUTE_RULES: readonly RouteRule[] = [
  // ── الشركات /api/tenants ──
  r('GET', '/api/tenants', 'tenants.view'),
  r('GET', '/api/tenants/platform-totals', 'tenants.totals'),
  r('POST', '/api/tenants', 'tenants.create'),
  r('GET', `/api/tenants/(?!ops$)${SEG}`, 'tenants.view'),
  r('PUT', `/api/tenants/${SEG}`, 'tenants.edit'),
  r('DELETE', `/api/tenants/${SEG}`, 'tenants.delete'),
  r('POST', `/api/tenants/${SEG}/impersonate`, 'tenants.impersonate'),
  r('GET', `/api/tenants/${SEG}/performance`, 'tenants.performance', true),
  r('POST', `/api/tenants/${SEG}/reset-admin`, 'tenants.resetPassword'),
  r('POST', `/api/tenants/${SEG}/ledger-reset`, 'tenants.ledger'),
  r('PUT', `/api/tenants/${SEG}/ledger-paylink-fee-invoice-from`, 'tenants.ledger'),

  // ── العملاء المحتملون /api/leads ──
  r('GET', '/api/leads', 'leads.view'),
  r('GET', '/api/leads/(stats|marketing-stats|whatsapp-status|enrich-status|sources-status|email-status|arab-countries|phone-audit)', 'leads.view'),
  r('GET', '/api/leads/(whatsapp-config|whatsapp-preview|auto-email)', 'leads.message'),
  r('PUT', '/api/leads/(whatsapp-config|auto-email)', 'leads.message'),
  r('POST', '/api/leads/(auto-email/run|email-test|email|whatsapp-send)', 'leads.message'),
  r('GET', '/api/leads/(apify-budget|auto-hunt|community-hunt)', 'leads.hunt'),
  r('PUT', '/api/leads/(apify-budget|auto-hunt|community-hunt)', 'leads.hunt'),
  r('POST', '/api/leads/(phone-classify|auto-hunt/run|community-hunt/run|search|import|enrich)', 'leads.hunt'),
  r('GET', '/api/leads/invoice-tool', 'invoiceTool.view', true),
  r('GET', '/api/leads/export/csv', 'leads.export', true),
  r('POST', '/api/leads', 'leads.edit'),
  r('GET', `/api/leads/${SEG}`, 'leads.view'),
  r('PUT', `/api/leads/${SEG}`, 'leads.edit'),
  r('DELETE', `/api/leads/${SEG}`, 'leads.delete'),
  r('POST', `/api/leads/${SEG}/(activities|convert)`, 'leads.edit'),

  // ── جسر واتساب /api/wa-bridge (الجزء المصادَق — مسارات الجهاز قبله بحارسها) ──
  r('GET', `/api/wa-bridge/(session|draft|bulk-count|preview/${SEG}|thread/${SEG})`, 'waBridge.view'),
  r('PUT', '/api/wa-bridge/draft', 'waBridge.send'),
  r('POST', '/api/wa-bridge/(send|bulk|queue/clear|logout)', 'waBridge.send'),

  // ── محادثات بوت واتساب /api/wa-inbox ──
  r('GET', '/api/wa-inbox/(stats|threads)', 'waInbox.view'),
  r('GET', `/api/wa-inbox/thread/${SEG}`, 'waInbox.view', true),

  // ── روابط الدفع /api/payments ──
  r('GET', '/api/payments', 'payments.view'),
  r('POST', '/api/payments', 'payments.manage'),
  r('POST', `/api/payments/${SEG}/(refresh|link-tenant)`, 'payments.manage'),

  // ── السفراء /api/affiliate-admin ──
  r('GET', `/api/affiliate-admin/(overview|settings|terms|affiliates|affiliates/${SEG}|claims|attributions|commissions|payouts/candidates|payouts|events|tenants/search)`, 'affiliates.view'),
  r('PUT', '/api/affiliate-admin/settings', 'affiliates.manage'),
  r('POST', '/api/affiliate-admin/(terms|attributions)', 'affiliates.manage'),
  r('POST', `/api/affiliate-admin/affiliates/${SEG}/(approve|reject|suspend|reactivate)`, 'affiliates.manage'),
  r('POST', `/api/affiliate-admin/affiliates/${SEG}/reveal-iban`, 'affiliates.iban'),
  r('POST', `/api/affiliate-admin/claims/${SEG}/(approve|reject|link-tenant)`, 'affiliates.manage'),
  r('POST', `/api/affiliate-admin/attributions/${SEG}/(void|activate|reassign|window)`, 'affiliates.manage'),
  r('POST', `/api/affiliate-admin/commissions/${SEG}/(approve|hold|release|decline)`, 'affiliates.payouts'),
  r('POST', '/api/affiliate-admin/(payouts|adjustments)', 'affiliates.payouts'),
  r('POST', `/api/affiliate-admin/payouts/${SEG}/(record|void)`, 'affiliates.payouts'),

  // ── عروض الأسعار /api/quotes ──
  r('GET', '/api/quotes/admin', 'quotes.view'),
  r('DELETE', `/api/quotes/admin/${SEG}`, 'quotes.delete'),

  // ── محتوى الموقع والبروفايل ──
  r('PUT', '/api/site-content', 'content.edit'),
  r('PUT', '/api/profile-deck(/file)?', 'content.edit'),
  r('DELETE', '/api/profile-deck', 'content.edit'),

  // ── الزيارات /api/analytics ──
  r('GET', '/api/analytics/stats', 'visits.view'),
  r('GET', '/api/analytics/(live-users|live-history)', 'live.view'),
  r('GET', '/api/analytics/request-stats', 'live.requests', true),
];

/** أفعال المالك التي تُسجَّل أيضاً (الحساسة وحدها — لا كل تعديلٍ في العملاء المحتملين) */
const OWNER_AUDITED: ReadonlySet<StaffPermissionKey> = new Set<StaffPermissionKey>([
  'tenants.create', 'tenants.edit', 'tenants.resetPassword', 'tenants.impersonate', 'tenants.ledger', 'tenants.delete',
  'affiliates.iban',
]);

/** المسار الكامل كما يُطابَق: الأساس + المسار، بأحرف صغيرة، بلا شرطة أخيرة */
export function requestPath(req: { baseUrl?: string; path?: string }): string {
  const full = `${req.baseUrl ?? ''}${req.path ?? ''}`.toLowerCase().replace(/\/+$/, '');
  return full || '/';
}

export function ruleFor(method: string, fullPath: string): RouteRule | null {
  const m = (method === 'HEAD' ? 'GET' : method).toUpperCase();
  for (const rule of ROUTE_RULES) if (rule.method === m && rule.path.test(fullPath)) return rule;
  return null;
}

// ───────────────────────────── التوكن ─────────────────────────────

export const STAFF_TOKEN_KIND = 'platform_staff';

export function staffSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET غير مضبوط');
  // سرٌّ مشتقّ: توكن الموظف لا يُقبل في أي مسارٍ يتحقّق بـJWT_SECRET (لوحة الشركة، المندوب، التجديد) — يمنع افتراضاً
  return process.env.STAFF_JWT_SECRET || `${base}::platform-staff`;
}

interface StaffTokenPayload { sid: string; kind: typeof STAFF_TOKEN_KIND; tv: number }

export function signStaffToken(staff: { id: string; tokenVersion: number }): string {
  const payload: StaffTokenPayload = { sid: staff.id, kind: STAFF_TOKEN_KIND, tv: staff.tokenVersion };
  return jwt.sign(payload, staffSecret(), { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') as jwt.SignOptions['expiresIn'] });
}

/** توكن موظفٍ صالح التوقيع والنوع، أو null */
export function verifyStaffToken(token: string): StaffTokenPayload | null {
  try {
    const p = jwt.verify(token, staffSecret()) as Partial<StaffTokenPayload>;
    if (p?.kind !== STAFF_TOKEN_KIND || typeof p.sid !== 'string' || !p.sid) return null;
    return { sid: p.sid, kind: STAFF_TOKEN_KIND, tv: typeof p.tv === 'number' ? p.tv : -1 };
  } catch {
    return null;
  }
}

export const STAFF_SELECT = {
  id: true, name: true, email: true, isActive: true, permissions: true, tokenVersion: true, mustChangePassword: true,
} as const;

export interface PlatformStaffCtx { id: string; name: string; permissions: string[]; tokenVersion: number }
export type PlatformRequest = AuthRequest & { platformStaff?: PlatformStaffCtx };

/** حسابٌ صالحٌ لهذا التوكن الآن: موجود ونشط ونسخة الجلسة نفسها — وإلا null */
export async function liveStaffFor(p: StaffTokenPayload) {
  const s = await prisma.platformStaff.findUnique({ where: { id: p.sid }, select: STAFF_SELECT });
  if (!s || !s.isActive || s.tokenVersion !== p.tv) return null;
  return s;
}

/** هل يملك موظف الطلب هذا المفتاح؟ للمالك دائماً true — لتقييد ما يعيده معالجٌ مشترك (مثل مصدر العملاء المحتملين) */
export function staffHas(req: PlatformRequest, key: StaffPermissionKey): boolean {
  if (!req.platformStaff) return true;
  return req.platformStaff.permissions.includes(key);
}

// ───────────────────────────── سجل النشاط ─────────────────────────────

const UUIDISH = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface AuditEntry {
  actorType: 'OWNER' | 'STAFF';
  actorId: string;
  actorName?: string | null;
  action: string;
  method?: string | null;
  path?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
}

/** يكتب سطر السجل ويعيد معرّفه — يرمي إن تعذّر (المستدعي يمنع الفعل) */
export async function writePlatformAudit(e: AuditEntry): Promise<string> {
  const row = await prisma.platformAuditLog.create({
    data: {
      actorType: e.actorType, actorId: e.actorId, actorName: e.actorName ?? null, action: e.action,
      method: e.method ?? null, path: e.path ? e.path.slice(0, 300) : null, targetId: e.targetId ?? null,
      detail: e.detail === undefined ? null : JSON.stringify(e.detail).slice(0, 2000), ip: e.ip ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** نتيجة الطلب على سطره (أفضل جهد — السطر نفسه كُتب قبل التنفيذ) */
function stampStatusOnFinish(res: Response, auditId: string): void {
  res.on('finish', () => {
    prisma.platformAuditLog.update({ where: { id: auditId }, data: { status: res.statusCode } }).catch(() => { /* أفضل جهد */ });
  });
}

const auditUnavailable = (res: Response): void => {
  res.status(503).json({ success: false, code: 'AUDIT_UNAVAILABLE', message: 'تعذر تسجيل العملية في سجل النشاط فلم تنفذ حاول مجددا' });
};

async function auditRequest(req: PlatformRequest, res: Response, actorType: 'OWNER' | 'STAFF', key: string): Promise<boolean> {
  try {
    const path = `${req.baseUrl ?? ''}${req.path ?? ''}`;
    const id = await writePlatformAudit({
      actorType, actorId: req.user!.id, actorName: req.user!.name ?? null, action: key,
      method: req.method, path, targetId: path.match(UUIDISH)?.[0] ?? null, ip: req.ip ?? null,
    });
    stampStatusOnFinish(res, id);
    return true;
  } catch {
    auditUnavailable(res);
    return false;
  }
}

/**
 * القراءات الحساسة المسجَّلة تُخفَّف: سطرٌ واحد لكل (موظف|مفتاح|رابط) في النافذة — «عداد الطلبات» تستطلعه الواجهة كل ٣٠ث
 * فيُغرق السجل. يُحدَّث الوقت بعد نجاح الكتابة وحده: تعذّر السجل يبقى يمنع القراءة. الكتابات كلها تُسجَّل.
 */
export const READ_AUDIT_WINDOW_MS = 15 * 60 * 1000;
const READ_AUDIT_MAX_KEYS = 5000;
const readAuditAt = new Map<string, number>();

function readAuditedRecently(k: string, now: number): boolean {
  const at = readAuditAt.get(k);
  return at !== undefined && now - at < READ_AUDIT_WINDOW_MS;
}

function markReadAudited(k: string, now: number): void {
  if (readAuditAt.size >= READ_AUDIT_MAX_KEYS) {
    for (const [key, at] of readAuditAt) if (now - at >= READ_AUDIT_WINDOW_MS) readAuditAt.delete(key);
    // ما زالت ممتلئة بعد التنظيف ⇒ تُفرَّغ: أسوأ ما فيه سطرٌ مكرَّر، لا قراءةٌ بلا سطر
    if (readAuditAt.size >= READ_AUDIT_MAX_KEYS) readAuditAt.clear();
  }
  readAuditAt.set(k, now);
}

/** للاختبار: تفريغ نافذة القراءات */
export function resetReadAuditThrottle(): void { readAuditAt.clear(); }

// ───────────────────────────── الحارس ─────────────────────────────

const PRESENCE_THROTTLE_MS = 60 * 1000;

/**
 * حارس مسارات لوحة المالك — بدل `authenticate, requireSuperAdmin`.
 * ٤٠١ للتوكن الغائب/الفاسد/المنتهي/المُبطَل، و٤٠٣ لما لا يُسمح به (والواجهة لا تُخرج الموظف عند ٤٠٣).
 */
export async function platformGate(req: PlatformRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // مفتاح API شأن شركة — لم يمرّ من requireSuperAdmin قبل، ولا يمرّ هنا
    if (apiKeyFromHeaders(req.headers as { authorization?: string; 'x-api-key'?: string | string[] })) {
      res.status(403).json({ success: false, message: 'غير مسموح' }); return;
    }
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) { res.status(401).json({ success: false, message: 'غير مصرح' }); return; }

    const fullPath = requestPath(req);
    const rule = ruleFor(req.method, fullPath);

    // ── المالك (أو توكنٌ للمنصة لغيره ⇒ ٤٠٣ كما كان requireSuperAdmin) ──
    let platformPayload: AuthPayload | null = null;
    try { platformPayload = jwt.verify(token, process.env.JWT_SECRET!) as AuthPayload; } catch { platformPayload = null; }
    if (platformPayload) {
      if (platformPayload.role !== 'SUPER_ADMIN' || platformPayload.impersonated) {
        res.status(403).json({ success: false, message: 'غير مسموح' }); return;
      }
      const owner = await prisma.superAdmin.findUnique({ where: { id: platformPayload.id }, select: { isActive: true } });
      if (!owner?.isActive) { res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب سجل الدخول مجددا' }); return; }
      req.user = platformPayload;
      if (rule && OWNER_AUDITED.has(rule.key) && req.method !== 'GET' && !(await auditRequest(req, res, 'OWNER', rule.key))) return;
      next(); return;
    }

    // ── الموظف ──
    const sp = verifyStaffToken(token);
    if (!sp) { res.status(401).json({ success: false, message: 'جلسة منتهية يرجى تسجيل الدخول مجددا' }); return; }
    const staff = await liveStaffFor(sp);
    if (!staff) { res.status(401).json({ success: false, message: 'انتهت صلاحية الحساب سجل الدخول مجددا' }); return; }
    if (staff.mustChangePassword) {
      res.status(403).json({ success: false, code: 'STAFF_MUST_CHANGE_PASSWORD', message: 'غير كلمة المرور المؤقتة اولا' }); return;
    }
    if (!rule || !staff.permissions.includes(rule.key)) {
      res.status(403).json({ success: false, code: 'STAFF_FORBIDDEN', message: 'لا تملك صلاحية هذا القسم' }); return;
    }
    req.user = { id: staff.id, role: 'PLATFORM_STAFF', name: staff.name };
    req.platformStaff = { id: staff.id, name: staff.name, permissions: staff.permissions, tokenVersion: staff.tokenVersion };
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (method !== 'GET') {
      if (!(await auditRequest(req, res, 'STAFF', rule.key))) return;
    } else if (rule.auditRead) {
      const k = `${staff.id}|${rule.key}|${req.originalUrl ?? fullPath}`;
      if (!readAuditedRecently(k, Date.now())) {
        if (!(await auditRequest(req, res, 'STAFF', rule.key))) return;
        markReadAudited(k, Date.now());
      }
    }
    touchStaff(staff.id);
    next();
  } catch (err) {
    next(err);
  }
}

const lastTouch = new Map<string, number>();
function touchStaff(id: string): void {
  const now = Date.now();
  if (now - (lastTouch.get(id) ?? 0) < PRESENCE_THROTTLE_MS) return;
  lastTouch.set(id, now);
  prisma.platformStaff.update({ where: { id }, data: { lastSeenAt: new Date(now) } }).catch(() => { /* أفضل جهد */ });
}

// ───────────────────────────── جلسة «دخول» إلى حساب شركة ─────────────────────────────

/** حقول المُصدِر التي يحملها توكن «دخول» — يضعها tenants.ts عند الإصدار */
export function impersonationIssuer(req: PlatformRequest): { by: string; byKind: 'OWNER' | 'STAFF'; btv?: number } {
  if (req.platformStaff) return { by: req.platformStaff.id, byKind: 'STAFF', btv: req.platformStaff.tokenVersion };
  return { by: req.user!.id, byKind: 'OWNER' };
}

/**
 * جلسة «دخول» حيّةٌ ما دام مُصدِرها حيّاً — تُفحص في كل طلب (authenticate). المالك المعطَّل تسقط جلساته؛ والموظف المعطَّل
 * أو المُخرَج من أجهزته أو المسحوبة منه الصلاحية تسقط جلساته داخل حسابات الشركات فوراً — بلا انتظار الساعتين.
 * توكنٌ بلا مُصدِر (صدر قبل هذا الإصدار) لا يُقبل.
 */
export async function impersonationIssuerOk(p: { by?: unknown; byKind?: unknown; btv?: unknown }): Promise<boolean> {
  return (await liveImpersonationIssuer(p)) !== null;
}

/** كـimpersonationIssuerOk ويعيد اسم الموظف المُصدِر معه — لسطر سجل كتاباته بلا قراءةٍ ثانية. null = سقطت الجلسة */
export async function liveImpersonationIssuer(p: { by?: unknown; byKind?: unknown; btv?: unknown }): Promise<{ name: string | null } | null> {
  if (typeof p.by !== 'string' || !p.by) return null;
  if (p.byKind === 'OWNER') {
    const o = await prisma.superAdmin.findUnique({ where: { id: p.by }, select: { isActive: true } });
    return o?.isActive === true ? { name: null } : null;
  }
  if (p.byKind === 'STAFF') {
    const s = await prisma.platformStaff.findUnique({ where: { id: p.by }, select: { name: true, isActive: true, tokenVersion: true, permissions: true } });
    return s && s.isActive && s.tokenVersion === p.btv && s.permissions.includes('tenants.impersonate') ? { name: s.name } : null;
  }
  return null;
}

/** جلسة «دخول» أصدرها موظف منصة لا المالك — تُقيَّد بما لا تُقيَّد به جلسة المالك (أدناه) */
export function isStaffImpersonation(req: { user?: { impersonated?: boolean; byKind?: string } | null }): boolean {
  return req.user?.impersonated === true && req.user?.byKind === 'STAFF';
}

export const STAFF_SESSION_NO_CREDENTIALS = 'لا ينشئ موظف المنصة داخل الشركة حسابات ولا كلمات مرور ولا مفاتيح ربط اطلبها من المالك';

/**
 * جلسة الموظف لا تُنشئ اعتماداً يبقى بعد سقوطها: حساب مستخدم أو مندوب، كلمة مرور، بريد دخول، ترقية إلى مدير، مفتاح API —
 * فتعطيله أو سحب «الدخول» منه يُسقط توكن الجلسة وحده (impersonationIssuerOk) لا ما أنشأه بها. `creates` = الطلب يُنشئ اعتماداً.
 * يردّ ٤٠٣ ويعيد true إن منع (المستدعي يعود). جلسة المالك كما هي.
 */
export function refuseStaffCredentials(req: AuthRequest, res: Response, creates = true): boolean {
  if (!creates || !isStaffImpersonation(req)) return false;
  res.status(403).json({ success: false, code: 'STAFF_SESSION_NO_CREDENTIALS', message: STAFF_SESSION_NO_CREDENTIALS });
  return true;
}

/** الحارس نفسه لمسارٍ كل طلبٍ فيه يُنشئ اعتماداً (إنشاء مستخدم شركة أو مندوب أو مفتاح API) — يُركَّب قبل المعالج */
export function noStaffCredentials(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!refuseStaffCredentials(req, res)) next();
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** طلبٌ مرّ بسطره — authenticate قد يُركَّب مرتين على الطلب نفسه (موجّهان على بادئةٍ واحدة) فلا يُكتب سطران */
const impersonationWriteAudited = new WeakSet<object>();

/**
 * كتابة في جلسة «دخول» أصدرها موظف: أفعاله في جداول الشركة تُوسم «الدعم الفني» (actorOf ⇒ OWNER:) بلا هويته، فيُكتب
 * سطرٌ باسمه في سجل نشاط المنصة **قبل** التنفيذ وحالتُه عند الانتهاء — وتعذّره ٥٠٣ بلا فعل (كـauditRequest). يُنادى من
 * authenticate بعد التحقّق من المُصدِر. true = تابع.
 */
export async function auditStaffImpersonationWrite(req: AuthRequest, res: Response, issuerName: string | null): Promise<boolean> {
  if (!isStaffImpersonation(req) || READ_METHODS.has(req.method) || impersonationWriteAudited.has(req)) return true;
  try {
    const id = await writePlatformAudit({
      actorType: 'STAFF', actorId: String(req.user!.by), actorName: issuerName, action: 'tenants.impersonate.write',
      method: req.method, path: String(req.originalUrl ?? req.url ?? '').split('?')[0], targetId: req.user!.tenantId ?? null, ip: req.ip ?? null,
    });
    impersonationWriteAudited.add(req);
    stampStatusOnFinish(res, id);
    return true;
  } catch {
    auditUnavailable(res);
    return false;
  }
}
