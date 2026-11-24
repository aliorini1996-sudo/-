/**
 * «المحاسب الذكي AI» — سياق الدورة (AcctCtx) والأنواع المشتركة بين الأدوات والمسار والواجهة (طلب المالك ١٧ نوفمبر ٢٠٢٦).
 *
 * السياق يُبنى في الخادم من الجلسة وحدها — لا شيء منه من النموذج: الشركة (tenantId) والمستخدم وصلاحياته ووضع الدفاتر
 * ومنطقة الشركة الزمنية واليوم المحلي والعملة. كل أداة تقرأ tenantId من هنا لا من وسائطها (عزل الشركات وحقن التعليمات).
 *
 * الأحكام (نسخة حرّاس /api/ledger حرفياً):
 *   - suiteOn = Tenant.accountingSuiteEnabled === true && accountingEnabled !== false (requireAccountingSuite).
 *   - booksActivated = suiteOn && GlSettings.activatedAt مضبوط (isLedgerActivated) — الدفاتر المطفأة بالمالك لا تُقرأ ولا يُرحَّل إليها.
 *   - booksMode = bookMode(GlSettings) حين suiteOn وإلا NONE (MANUAL يُحكم بطريقة الإعداد وحدها كما في booksMode.ts).
 *   - canViewLedger / canPostJournals = ledgerPermissionDecision كـrequireLedgerPermission؛ جلسة المالك تمرّ (isOwnerSession).
 *   - canPost = suiteOn && booksActivated && canPostJournals (مفتاح البيئة AI_ACCOUNTANT_WRITE يحكمه بناء أدوات الكتابة).
 *   - warehouseOn = المستودع مفعّل والمحاسبة غير مطفأة و«إدارة المخزون» (canManageVanStock) غير مسحوبة من المستخدم — كحارس
 *     /api/warehouse و/api/suppliers (requireAdminPermission: false الصريحة تمنع، وجلسة المالك تمرّ).
 * الدالة acctCtxFrom صرفة (مختبَرة بلا قاعدة)، وloadAcctCtx تقرأ الصفوف الأربعة ثم تستدعيها.
 * مستندات المحادثة (documents، docTurn) لا يبنيها acctCtxFrom: تُضاف في chat.ts لدورةٍ تحمل رسائلها docIds فقط (شكل السياق
 * النصّي كما هو حرفياً).
 */
import prisma from '../../config/database';
import type { AdvisorTool } from '../../ai-rep/advisor';
import { ledgerPermissionDecision, type LedgerAdminRow } from '../gl/permissions';
import { bookMode } from '../booksMode';
import { companyTimeZone } from '../erpPayload';
import { DEFAULT_TIMEZONE, isValidTimeZone, todayLocal as localToday } from '../gl/dates';
import { isTaxOff } from '../taxMode';
import { amountsInText } from './posting';
import type { AcctDocView } from './documents/types';

/** أداة المحاسب = أداة حلقة المستشار نفسها (ai-rep/advisor.ts): {spec, run(args) ⇒ {data, summaryAr} | {error}} */
export type Tool = AdvisorTool;

export interface AcctCtx {
  tenantId: string;
  adminId: string;
  adminName: string | null;
  impersonated: boolean;
  tz: string;
  todayLocal: string;
  currency: string;
  accountingOn: boolean;
  booksMode: 'NONE' | 'MANUAL' | 'LINKED' | 'LEGACY';
  booksActivated: boolean;
  canViewLedger: boolean;
  canPost: boolean;
  warehouseOn: boolean;
  taxDisabled: boolean;
  /**
   * نص حارس «مبلغ القيد في رسالة المستخدم» (userTextOf): آخر رسالة وحدها إن كان فيها مبلغ، وإلا آخر رسالتين (المبلغ ثم
   * طريقة الدفع) — بالأحدث آخراً وبسطر جديد كما كتبهما.
   */
  userText: string;
  /** آخر رسالة للمستخدم وحدها — مبلغٌ لم يرد فيها جاء من الرسالة السابقة فيُفحص تكرار القيد (اختياري: الغياب = userText) */
  latestUserText?: string;
  /** المستخدم يطلب تسجيل شيء في هذه الدورة (writeIntentOf) — وإلا لا تُعرض أدوات الترحيل (اختياري: الغياب = writeIntentIn(userText)) */
  writeIntent?: boolean;
  /** عنوان الطلب (req.ip) لسجلّ تدقيق الدفاتر كسائر كتابات الدفاتر (اختياري) */
  requestIp?: string | null;
  /** مفتاح عدم التكرار من الجهاز (uuid لكل إرسال) — مرجع القيد AI-<clientRef>-<n> */
  clientRef: string;
  /** ما تدفعه أدوات التقارير — يُعاد للواجهة كما هو */
  reports: AiReport[];
  /** ما رحّلته أدوات الكتابة في هذه الدورة */
  posted: PostedMove[];
  /** تنبيهات للمستخدم (فترة مقفلة، بيانات دفاتر متأخرة…) */
  warnings: string[];
  /**
   * مستندات المحادثة (رفع المستندات، طلب المالك ١٨ نوفمبر ٢٠٢٦): ما أُرفق في رسائل النافذة بمراجعها D1..Dn بترتيب أول ظهور —
   * محمّلة بالشركة والرافع نفسه وحدهما (اختياري: الغياب = لا مستندات). أداة document_facts تقرؤها، ولا يرى النموذج بايتاً.
   */
  documents?: AcctDocView[];
  /** آخر رسالة تحمل مستندات ⇒ لا تُعرض أدوات الكتابة في هذه الدورة (الترحيل من بطاقة المستند وحدها) */
  docTurn?: boolean;
}

export type AiReport = {
  kind: 'income-statement' | 'balance-sheet' | 'trial-balance' | 'executive-summary' | 'general-ledger' | 'sales' | 'collections' | 'purchases-inventory' | 'receivables' | 'expenses' | 'profit-estimate' | 'top';
  title: string;
  period: { from: string; to: string } | null;
  currency: string;
  sections: { title: string | null; rows: { label: string; amount: number | null; text?: string; level?: 0 | 1 | 2; bold?: boolean }[] }[];
  notes: string[];
  estimated?: boolean;
};

export type PostedMove = {
  id: string;
  moveId: string;
  moveNumber: string | null;
  ref: string;
  /** PREPAID/PREPAID_AMORT/ASSET من المستندات (EXPENSE لمصروف المستند كمصروف المحادثة) */
  kind: 'EXPENSE' | 'SALARIES' | 'SALARIES_SETTLE' | 'PREPAID' | 'PREPAID_AMORT' | 'ASSET';
  amount: number;
  date: string;
  summaryAr: string;
  lines: { accountCode: string; accountName: string; debit: number; credit: number }[];
  reversed: boolean;
  createdAt: string;
  adminName: string | null;
  // ── قيود المستندات وحدها (الغياب في قيود المحادثة النصّية) ──
  /** المستند الذي رُحّل منه القيد */
  docId?: string;
  /** مرفق المستند على القيد في الدفاتر (يُفتح من لوحة القيد) */
  hasAttachment?: boolean;
  /** قسط إطفاء ⇐ صفّ قيد الدفع المقدّم */
  parentPostId?: string;
  /** تقدّم إطفاء المدفوع مقدماً: الأقساط المرحّلة من عدد الأشهر، وتوقّفه، وموعد القسط التالي، والأشهر المقفلة */
  prepaid?: { posted: number; months: number; stopped?: boolean; nextDate?: string | null; lockedMonths?: string[] };
  /** قسط الإطفاء k من n (PREPAID_AMORT) ⇐ مرجعه وجدول قيد الدفع المقدّم أبيه — «الشهر k من n» في البطاقة */
  amort?: { parentPostId: string; index: number; months: number };
  /** تنبيه عربي (عُكس قيد الدفع بعد أقساط حيّة، فترة مقفلة تُخطّيت، أصلٌ يحتاج إهلاكاً) */
  warning?: string;
};

// ───────────── مفاتيح البيئة (الغياب = مفعّل) ─────────────

/** AI_ACCOUNTANT_LLM=0 يوقف المحادثة كلها (503 AI_ACCOUNTANT_OFF) */
export function aiChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AI_ACCOUNTANT_LLM ?? '').trim() !== '0';
}

/** AI_ACCOUNTANT_WRITE=0 يوقف الترحيل وحده — القراءة تبقى */
export function aiWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AI_ACCOUNTANT_WRITE ?? '').trim() !== '0';
}

// ───────────── البناء ─────────────

/** هوية المستخدم كما في الجلسة (req.user) */
export interface AcctUser {
  id: string;
  role: string;
  tenantId?: string | null;
  name?: string | null;
  impersonated?: boolean;
  /** req.ip — لسجلّ تدقيق الدفاتر */
  requestIp?: string | null;
}

/** الصفوف التي يُبنى منها السياق (قراءة واحدة لكلٍّ منها) */
export interface AcctRows {
  tenant: { accountingEnabled?: boolean | null; accountingSuiteEnabled?: boolean | null; warehouseEnabled?: boolean | null } | null;
  admin: (LedgerAdminRow & { name?: string | null; canManageVanStock?: boolean | null }) | null;
  company: { name?: string | null; currency?: string | null; countryCode?: string | null; taxDisabled?: boolean | null } | null;
  gl: { setupMethod?: string | null; activatedAt?: Date | null; timezone?: string | null; currency?: string | null } | null;
}

export interface AcctInput {
  /** رسائل المستخدم في المحادثة (بترتيبها) — يُؤخذ منها آخر اثنتين لـuserText */
  userMessages: string[];
  clientRef: string;
  now?: Date;
}

/** اسم من طلب القيد كما يُكتب على القيد وفي سجلّ القيود: جلسة المالك «الدعم الفني» لا اسم مدير الشركة (actorOf) */
export const OWNER_SESSION_NAME = 'الدعم الفني';

/**
 * نصّ حارس المبلغ: آخر رسالة وحدها إن كان فيها مبلغ (بعد إسقاط التواريخ وأرقام الأشهر — amountsInText)، فطلبٌ جديد لا يرث
 * مبلغ رسالةٍ سابقة رُحّل قيدها في دورتها؛ وإلا آخر رسالتين (ردٌّ قصير على سؤال: المبلغ ثم «نقداً») — لا أقدم منهما أبداً.
 */
export function userTextOf(userMessages: string[]): string {
  const last = userMessages[userMessages.length - 1] ?? '';
  if (amountsInText(last).length > 0) return last;
  return userMessages.slice(-2).join('\n');
}

/**
 * نيّة التسجيل في نص الحارس: أدوات الترحيل لا تُعرض إلا لطلبٍ يسجّل شيئاً («سجّل/رحّل/دفعنا/صرفنا/سدّدنا/رواتب/مصروف/قيد»)
 * — دورة تقرير بحت (وهي التي تُدخل للنموذج نصوصاً يكتبها غير المستخدم: أسماء العملاء والأصناف والحسابات) لا تُرحّل شيئاً.
 */
export const WRITE_INTENT_RE = /سج[ّ]?ل|رح[ّ]?ل|دفع|صرف|سد[ّ]?د|رواتب|راتب|أجور|مصروف(?!ات)|قيد|\b(?:record|post|paid|pay|salar(?:y|ies)|expense)\b/i;
export function writeIntentIn(text: string): boolean {
  return WRITE_INTENT_RE.test(text || '');
}

/**
 * نصّ الإرسال الافتراضي لمستندٍ بلا كلام (الويب يرسله): قراءةٌ وتلخيص — لا يطابق WRITE_INTENT_RE عمداً («…واقترح قيده»
 * كانت تطابق «قيد» فتُعرض أدوات الترحيل على رفعٍ مجرد). الترحيل من بطاقة المستند وحدها.
 */
export const DOC_READ_DEFAULT_TEXT = 'اقرأ المستند المرفق ولخّص بياناته';

/** طلب تقرير صريح — ردٌّ بهذا لا يرث نيّة التسجيل من الرسالة السابقة */
export const REPORT_INTENT_RE = /قائمة|ميزان|تقرير|ملخص|ذمم|أعلى|مبيعات|تحصيل|ربح|أرباح|خسار|كشف|مشتريات|مخزون|مصروفات|\b(?:report|statement|balance|summary)\b/i;

/**
 * نيّة التسجيل للدورة: في آخر رسالة، أو في سابقتها وآخر رسالةٍ ردٌّ يكملها لا طلب تقرير (سُئل «كم المبلغ؟» فكتب «1500»، أو
 * «نقداً أم بنك؟» فكتب «من البنك») — فسؤال التقرير بعد قيدٍ رُحّل لا تُعرض فيه أدوات الترحيل.
 */
export function writeIntentOf(userMessages: string[]): boolean {
  const last = userMessages[userMessages.length - 1] ?? '';
  if (writeIntentIn(last)) return true;
  const prev = userMessages[userMessages.length - 2] ?? '';
  return writeIntentIn(prev) && !REPORT_INTENT_RE.test(last);
}

/** هوية الفاعل في الصفوف النصّية والحصة (كـactorOf في middleware/auth): جلسة المالك OWNER:<id> لا معرّف مدير الشركة وحده */
export function actorRefOf(id: string, impersonated: boolean | undefined): string {
  return impersonated === true ? `OWNER:${id}` : id;
}

export function acctCtxFrom(user: AcctUser, rows: AcctRows, input: AcctInput): AcctCtx {
  const tenantId = String(user.tenantId ?? '');
  const impersonated = user.impersonated === true;
  const accountingOn = rows.tenant?.accountingEnabled !== false;
  // مطفأ افتراضياً: لا يمرّ إلا === true، وتعذّر قراءة الصفّ يمنع
  const suiteOn = rows.tenant?.accountingSuiteEnabled === true && accountingOn;
  const booksActivated = suiteOn && !!rows.gl?.activatedAt;
  const decide = (key: 'canViewLedger' | 'canPostJournals') =>
    suiteOn && (impersonated || ledgerPermissionDecision(rows.admin, key, tenantId) === 'ALLOW');
  const canViewLedger = decide('canViewLedger');
  const canPostJournals = decide('canPostJournals');
  const zone = companyTimeZone(rows.gl?.timezone, rows.company?.countryCode);
  const tz = zone && isValidTimeZone(zone) ? zone : DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();
  return {
    tenantId,
    adminId: user.id,
    adminName: impersonated ? OWNER_SESSION_NAME : (rows.admin?.name || user.name || null),
    impersonated,
    tz,
    todayLocal: localToday(now, tz),
    currency: (rows.company?.currency || rows.gl?.currency || 'SAR').trim() || 'SAR',
    accountingOn,
    booksMode: suiteOn ? bookMode(rows.gl) : 'NONE',
    booksActivated,
    canViewLedger,
    canPost: suiteOn && booksActivated && canPostJournals,
    // كحارس /api/warehouse و/api/suppliers: «إدارة المخزون» false الصريحة تمنع، والمعطّل والصفّ الغائب يمنعان، وجلسة المالك تمرّ
    warehouseOn: rows.tenant?.warehouseEnabled === true && accountingOn
      && (impersonated || (rows.admin?.isActive === true && rows.admin.canManageVanStock !== false)),
    taxDisabled: isTaxOff(rows.company),
    userText: userTextOf(input.userMessages),
    latestUserText: input.userMessages[input.userMessages.length - 1] ?? '',
    writeIntent: writeIntentOf(input.userMessages),
    requestIp: user.requestIp ?? null,
    clientRef: input.clientRef,
    reports: [],
    posted: [],
    warnings: [],
  };
}

/** أدنى شكل للعميل: PrismaClient والمزيّف في الاختبارات */
export interface AcctCtxDb {
  tenant: { findUnique(args: unknown): Promise<unknown> };
  admin: { findUnique(args: unknown): Promise<unknown> };
  companySettings: { findUnique(args: unknown): Promise<unknown> };
  glSettings: { findUnique(args: unknown): Promise<unknown> };
}

/** يقرأ الصفوف الأربعة بالتوازي ويبني السياق — مع اسم الشركة للتعليمات */
export async function loadAcctCtx(user: AcctUser, input: AcctInput, db: AcctCtxDb = prisma as unknown as AcctCtxDb): Promise<{ ctx: AcctCtx; companyName: string }> {
  const tid = String(user.tenantId ?? '');
  if (!tid) throw new Error('لا توجد شركة مرتبطة بالحساب');
  const [tenant, admin, company, gl] = await Promise.all([
    db.tenant.findUnique({ where: { id: tid }, select: { name: true, accountingEnabled: true, accountingSuiteEnabled: true, warehouseEnabled: true } }),
    db.admin.findUnique({
      where: { id: user.id },
      select: {
        name: true, isActive: true, tenantId: true, role: true, canManageCompanyUsers: true, scopeEnabled: true, canManageVanStock: true,
        canViewLedger: true, canPostJournals: true, canManagePayables: true, canManageBank: true, canCloseLedgerPeriods: true, canConfigureLedger: true,
      },
    }),
    db.companySettings.findUnique({ where: { tenantId: tid }, select: { name: true, currency: true, countryCode: true, taxDisabled: true } }),
    db.glSettings.findUnique({ where: { tenantId: tid }, select: { setupMethod: true, activatedAt: true, timezone: true, currency: true } }),
  ]) as [AcctRows['tenant'] & { name?: string | null } | null, AcctRows['admin'], AcctRows['company'], AcctRows['gl']];
  const ctx = acctCtxFrom(user, { tenant, admin, company, gl }, input);
  return { ctx, companyName: (company?.name || tenant?.name || '').trim() };
}
