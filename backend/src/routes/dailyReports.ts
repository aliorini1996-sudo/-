// ============================================================================
// التقرير اليومي — إقرارٌ يرفعه المندوب، يمرّ بسلسلة اعتمادٍ تعرّفها الشركة،
// وينتهي تقريراً شاملاً للفريق.
//
// المنطق كلّه في services/dailyReportChain.ts صرفاً ومُختبَراً؛ هذا الملف
// يقرأ ويكتب ويحرس فقط. وكل انتقالٍ يُكتب داخل معاملةٍ واحدة تحمل الخطوة
// والمهمّة والمؤشّر معاً، فلا ينزاح المؤشّر عن الحقيقة.
// ============================================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { authenticate, requireAdmin, requireAdminPermission, requireDailyReport, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminRepFilter, canAccessRep, scopedRepRecordWhere } from '../services/adminScope';
import { roundHalfUp } from '../lib/money';
import {
  ChainLevel, ChainOwner, OwnerRep, ChainTask,
  firstLevel, ownersFor, chainIssues, deriveCursor, canAct,
  countDistinctApprovers, applyAction, describeChain, sortLevels,
} from '../services/dailyReportChain';

const router = Router();
router.use(authenticate);
// الحارس **قبل** تعريف أي مسار: ميزة اشتراك مطفأة افتراضياً، فلا يُفلت مسارٌ
// يُضاف لاحقاً أسفل الملف من التسييج.
router.use(requireDailyReport);

// ————— أدوات مشتركة —————

const actorName = (req: AuthRequest) => req.user?.name || 'مستخدم';

/**
 * هل يملك هذا المستخدم حقّ فعلٍ إداريّ على التقارير؟
 *
 * تُقرأ الصلاحية **من القاعدة** لا من `req.user` — التوكن لا يحمل الصلاحيات،
 * وقراءتها منه كانت ستعطي `undefined` فتمرّ كأنّها ممنوحة. والدور ADMIN يمرّ
 * دائماً: هو مالك الشركة في هذا النظام.
 */
async function hasDailyReportAdminRight(req: AuthRequest): Promise<boolean> {
  const uid = req.user?.id;
  if (!uid) return false;
  if (req.user?.role === 'ADMIN') return true;
  const row = await prisma.admin.findUnique({
    where: { id: uid },
    select: { canViewReports: true, canManageDailyReport: true },
  });
  if (!row) return false;
  // `!== false` لا `=== true`: مستخدمو الشركة القدامى أُنشئوا قبل أعمدة الصلاحيات
  return row.canViewReports !== false || row.canManageDailyReport === true;
}

/**
 * هل يقرأ هذا المستخدم تقارير المناديب؟ — نظير `requireAdmin` +
 * `requireAdminPermission('canViewReports')` حرفاً بحرف، لمسارٍ لا يقع خلفهما.
 * والمنع عند `=== false` لا `!== true`: أعمدة الصلاحيات أُضيفت بعد مستخدمين
 * قدامى، وقلبُ الشرط يسحب الوحدة ممّن لم يمسّها المالك قطّ.
 */
async function canReadRepReports(req: AuthRequest): Promise<boolean> {
  const uid = req.user?.id;
  if (!uid || !['ADMIN', 'MANAGER', 'ACCOUNTANT'].includes(req.user!.role)) return false;
  const row = await prisma.admin.findUnique({ where: { id: uid }, select: { isActive: true, canViewReports: true } });
  return !!row?.isActive && row.canViewReports !== false;
}

/** يُنقل عبر المعاملة ليُترجَم إلى ٤٠٩ خارجها — لا خطأ خادم */
class StuckLevels extends Error {
  constructor(public count: number) { super('stuck'); }
}

/**
 * تغيّرت حالة التقرير بين قراءته والكتابة عليه.
 *
 * كل مسارات الفعل تقرأ التقرير ومهامّه **خارج** المعاملة ثم تكتب داخلها؛ فإن
 * سبقتها إعادةٌ للمندوب من مالكٍ ثانٍ (أو من الجوال والويب معاً) كتبت هذه فوق
 * قرارٍ لم تره: `updateMany` لا تطابق صفّاً والكود يمضي فيفتح المستوى التالي
 * لتقريرٍ أُعيد للتصحيح. فالفحص أنّ الكتابة أغلقت مهمّةً فعلاً هو المقارنة‑والتبديل
 * الوحيدة المتاحة هنا (جدول المهامّ بلا قيدٍ فريد عمداً).
 */
class ReportMoved extends Error {
  constructor() { super('moved'); }
}

/** يترجم ReportMoved إلى ٤٠٩ صريح، ويمرّر ما عداه */
function rethrowMoved(e: unknown, res: Response): boolean {
  if (e instanceof ReportMoved) {
    res.status(409).json({ success: false, code: 'DAILY_REPORT_MOVED', message: 'تغيّرت حالة التقرير أثناء عملك — افتحه من جديد' });
    return true;
  }
  return false;
}

/**
 * صفّ القيمة الحيّ لكل خانة في تقرير.
 *
 * الخانة قد تحمل صفّين في تقريرٍ واحد: قيمة المندوب (levelSeq=0) وقيمة مستوى
 * ENTER، أو صفّان بأرقام مستوياتٍ مختلفة بعد إعادة ترقيم العقد. والقيد الفريد
 * `(reportId, fieldId, levelSeq)` يسمح بتعايشهما عمداً — وهو صحيح كسجلّ، وقاتل
 * في التجميع: جمعُهما يضاعف الرقم، وعرضُ آخرهما في الجدول يناقض الإجمالي على
 * الشاشة نفسها. فيُختار صفٌّ واحد: صفّ المالك الحاليّ للخانة، وإلا الأحدث كتابةً.
 */
type LiveValue = {
  fieldId: string; levelSeq: number;
  declaredNum: number | null; declaredText: string | null;
  labelSnapshot: string; updatedAt: Date;
};
function liveValues<T extends LiveValue>(values: T[], ownerSeq: Map<string, number>): T[] {
  const best = new Map<string, T>();
  for (const v of values) {
    const cur = best.get(v.fieldId);
    if (!cur) { best.set(v.fieldId, v); continue; }
    const want = ownerSeq.get(v.fieldId) ?? 0;
    const vOwns = v.levelSeq === want;
    const cOwns = cur.levelSeq === want;
    if (vOwns !== cOwns) { if (vOwns) best.set(v.fieldId, v); continue; }
    if (v.updatedAt > cur.updatedAt) best.set(v.fieldId, v);
  }
  return [...best.values()];
}

/** تراكمٌ نقديّ بتقريب المنصّة الموحّد — خانة MONEY «تمرّ بـroundHalfUp» */
function addMoney(acc: number, v: number, isMoney: boolean): number {
  return isMoney ? roundHalfUp(acc + v, 2) : acc + v;
}

/**
 * تاريخُ تقريرٍ **محتمَل** — الخادم لا يصدّق ساعة الجهاز على عواهنها.
 *
 * `regex` وحده يقبل «2026-99-99» ويقبل يوماً من سنة ٢٠٩٩. ويومٌ خطأ في المستقبل
 * أخطر من غيره: القيد `(tenant, rep, date)` يحوّله من صفٍّ بتاريخٍ خاطئ إلى
 * **قفلٍ على يومٍ صحيح** لا مسار حذفٍ يفكّه. فالسقف هنا هو يومُ أقصى منطقةٍ
 * زمنيّة على الأرض (UTC+14): ما بعده ليس «اليوم» عند أحد. والأرضية سنةٌ كاملة
 * تكفي كل تصحيحٍ متأخّر ولا تسمح بساعةٍ عالقة في ٢٠٢٠.
 *
 * ⚠️ ما لا يلتقطه: جهازٌ ساعتُه صحيحة ومنطقتُه خاطئة (يعلن +240 وهو في +180)
 * — يومُه المُعلَن يتّسق مع إزاحته المُعلَنة فلا يكشفه الخادم. علاجُه مسار
 * تصحيحِ تاريخٍ لا حارسُ مدخلات.
 */
function reportDateIssue(date: string, nowMs = Date.now()): string | null {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date) return 'تاريخ غير موجود في التقويم';
  const maxDay = new Date(nowMs + 14 * 3600_000).toISOString().slice(0, 10);
  const minDay = new Date(nowMs - 365 * 86400_000).toISOString().slice(0, 10);
  if (date > maxDay) return 'تاريخ التقرير في المستقبل — راجع تاريخ جهازك';
  if (date < minDay) return 'تاريخ التقرير أقدم من سنة — راجع تاريخ جهازك';
  return null;
}

/**
 * مرجع المندوب في تقريرٍ **يتيم** — حُذف صاحبه بعد أن وقّع إقراره.
 *
 * `salesRepId` صار اختيارياً كالفاتورة والسند: الإقرار سجلٌّ يبقى بعد صاحبه.
 * والغياب يُقرأ هنا سلسلةً فارغة لا `null`، لأنّ لكلّ مستهلكٍ للمرجع جواباً
 * صحيحاً عند الغياب:
 *  - `ownersFor` لا يجد توجيهاً خاصاً بمعرّفٍ فارغ فيعيد **الأصحاب
 *    الافتراضيين**، فتُكمل السلسلة طريقها بدل أن تقف عند تقريرٍ بلا صاحب.
 *  - `canAccessRep` لا يجد مندوباً بهذا المعرّف فيمنع المستخدم **المقيَّد
 *    بنطاق** — وهو الاتجاه الآمن: من رآه بنطاقه لا يرثه بعد زواله.
 * والمستخدم غير المقيَّد يرى التقرير كما يرى فاتورة مندوبٍ مستقيل.
 */
const REP_GONE = '';
/** ما يُعرض مكان اسم مندوبٍ حُذف — لا فراغٌ يُقرأ عطلاً في الواجهة */
const REP_GONE_NAME = 'مندوب محذوف';
const repRef = (id: string | null): string => id ?? REP_GONE;

/** يقرأ تعريف السلسلة كاملاً لهذه الشركة */
async function loadChain(tid: string) {
  const [levels, owners, ownerReps, admins] = await Promise.all([
    prisma.dailyReportLevel.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } }),
    prisma.dailyReportLevelOwner.findMany({ where: { tenantId: tid } }),
    prisma.dailyReportOwnerRep.findMany({ where: { tenantId: tid } }),
    prisma.admin.findMany({ where: { tenantId: tid }, select: { id: true, isActive: true } }),
  ]);
  /* حياة صاحب العقدة جزءٌ من صحّة السلسلة: مالكٌ عُطِّل أو حُذف يبتلع تقارير
   * مندوبيه في صندوقٍ لا يفتحه أحد. و`?? false` مقصودة — من ليس في قائمة
   * الشركة محذوفٌ فعلاً، ولا مفتاح أجنبيّ يمنع حذفه. */
  const live = new Map(admins.map(a => [a.id, a.isActive !== false]));
  return {
    levels: levels as unknown as ChainLevel[],
    owners: (owners as unknown as ChainOwner[]).map(o => ({ ...o, adminActive: live.get(o.adminId) ?? false })),
    ownerReps: ownerReps.map(r => ({ ownerId: r.ownerId, salesRepId: r.salesRepId })) as OwnerRep[],
  };
}

/** يسجّل تغييرَ تهيئةٍ في أثر التدقيق — يُستدعى مع كل كتابةٍ على التعريف */
async function logConfig(
  tx: Prisma.TransactionClient,
  tid: string, req: AuthRequest,
  entity: string, action: string, summary: string,
  targetId?: string | null, targetName?: string | null,
) {
  await tx.dailyReportConfigLog.create({
    data: {
      tenantId: tid, entity, action, summary,
      targetId: targetId ?? null, targetName: targetName ?? null,
      actorAdminId: req.user?.id ?? null, actorAdminName: actorName(req),
    },
  });
}

// ════════════════════════════════════════════════════════════════════
//  مسارات المندوب
// ════════════════════════════════════════════════════════════════════

/**
 * نموذج اليوم: الخانات النشطة + تقرير اليوم إن رُفع + آخر إعادةٍ بسببها.
 * `date` يأتي من الجهاز لا من الخادم (انظر تعليق reportDate في المخطّط).
 */
router.get('/form', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const isRep = req.user!.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : String(req.query.salesRepId || '');
    if (!salesRepId) { res.status(400).json({ success: false, message: 'المندوب مطلوب' }); return; }
    /* قراءة تقرير مندوبٍ بمعرّفه **فعلٌ إداريّ** وإن كان بصيغة GET: الاستجابة
     * تحمل كل ما أقرّ به المندوب وتعليقات المراجعين وسجلّ من اعتمد ولماذا أُعيد
     * — أي محتوى `/admin/:id` كاملاً. وحارسا `/admin` و`/config` مركَّبان على
     * فرعيهما وحدهما، فكان هذا المسار مفتوحاً لأيّ مستخدم شركة ولو سُحبت عنه
     * صلاحية التقارير وقُيِّد نطاقه بثلاثة مناديب. الحارسان هنا نظيرا `/admin/:id`
     * حرفاً بحرف: الصلاحية ثمّ النطاق، والفشل ٤٠٤ لا يفصح عن وجود التقرير. */
    if (!isRep) {
      if (!(await canReadRepReports(req))) {
        res.status(403).json({ success: false, message: 'لا تملك صلاحية قراءة تقارير المناديب' }); return;
      }
      if (!(await canAccessRep(req, tid, salesRepId))) {
        res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
      }
    }

    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ success: false, message: 'التاريخ مطلوب بصيغة YYYY-MM-DD' }); return; }

    const [fields, report, chain] = await Promise.all([
      prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { seq: 'asc' } }),
      prisma.dailyReport.findFirst({
        where: { tenantId: tid, salesRepId, reportDate: date },
        include: {
          values: true,
          comments: { orderBy: { createdAt: 'asc' } },
          steps: { orderBy: { createdAt: 'asc' } },
        },
      }),
      loadChain(tid),
    ]);

    /* تقريرٌ أُعيد للتصحيح في يومٍ **آخر** — وهو الحالة الأشيع لا النادرة:
     * المندوب يرفع مساءً والمراجعة تقع صباح الغد، فحين يفتح تطبيقه يرى يومه
     * الجديد ولا سبيل له إلى المُعاد. وبلا هذا الحقل يعلق التقرير «مُعاداً»
     * إلى الأبد ويُجمّد حصيلة يومه، ولا أحد في المنصّة يستطيع إصلاحه. */
    const returnedElsewhere = await prisma.dailyReport.findFirst({
      where: { tenantId: tid, salesRepId, status: 'RETURNED', reportDate: { not: date } },
      orderBy: { reportDate: 'asc' },
      include: { steps: { where: { action: 'RETURN' }, orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    // المندوب يملأ ما لا مستوى له (fillLevelSeq = null)
    const repFields = fields.filter(f => f.fillLevelSeq === null);
    const issues = chainIssues(chain.levels, chain.owners);

    res.json({
      success: true,
      data: {
        fields: repFields,
        report,
        // سبب آخر إعادة — يُعرض للمندوب فوق النموذج
        returnReason: report?.status === 'RETURNED'
          ? ([...(report.steps || [])].reverse().find(s => s.action === 'RETURN')?.reason ?? null)
          : null,
        chainReady: issues.length === 0,
        chainIssues: issues,
        // يومٌ آخر ينتظر تصحيح المندوب — الشاشة تعرضه وتفتحه
        returnedElsewhere: returnedElsewhere
          ? {
              reportDate: returnedElsewhere.reportDate,
              reason: returnedElsewhere.steps[0]?.reason ?? null,
            }
          : null,
      },
    });
  } catch (err) { next(err); }
});

const valueSchema = z.object({
  fieldId: z.string().min(1),
  num: z.number().nullish(),
  text: z.string().nullish(),
}).refine(v => 'num' in v || 'text' in v, {
  // عميلٌ يرسل مفتاحاً مجهولاً (declaredNum مثلاً) كان يمرّ صامتاً فتُكتب
  // القيمة null ويُقال «تمّ». الرفض الصريح أصدق من قيمةٍ فارغة يظنّها صاحبها محفوظة.
  message: 'قيمة الخانة يجب أن تحمل num أو text',
});

const submitSchema = z.object({
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ YYYY-MM-DD'),
  tzOffsetMin: z.number().int().min(-840).max(840).optional(),
  note: z.string().nullish(),
  clientRef: z.string().max(120).nullish(),
  clientCreatedAt: z.string().nullish(),
  values: z.array(valueSchema),
  salesRepId: z.string().nullish(), // للأدمن حين يرفع نيابةً (نادر)
});

/**
 * رفع تقرير اليوم (أو إعادة رفعه بعد إعادةٍ للتصحيح).
 *
 * ترتيب الحارس مقصود: التحليل ← فحص النطاق ← البحث بـclientRef **بلا تصفية
 * بالنطاق داخل الاستعلام** ← الإنشاء. لو صفّى القيدُ التقريرَ القائم لسقط
 * المسار إلى الإنشاء فاصطدم بالقيد الفريد، أو كرّر التقرير نفسه.
 */
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = submitSchema.parse(req.body);
    const isRep = req.user!.role === 'SALES_REP';
    const salesRepId = isRep ? req.user!.id : String(body.salesRepId || '');
    if (!salesRepId) { res.status(400).json({ success: false, message: 'المندوب مطلوب' }); return; }
    /* الرفع نيابةً عن مندوب **فعلٌ إداريّ** يحتاج صلاحيته صراحةً. حارسا
     * `/admin` و`/config` مركَّبان على فرعيهما وحدهما، فكان هذا المسار يقبل أيّ
     * مستخدم شركة — ولو أُنشئ بلا صلاحية تقارير ولا يرى الوحدة أصلاً — فيرفع
     * إقراراً باسم مندوب أو يستبدل إقراراً أُعيد إليه للتصحيح.
     * وفحص النطاق وحده لا يكفي: `canAccessRep` تعيد true بلا استعلام حين يكون
     * عزل النطاق مطفأً — وهو مطفأ افتراضياً. */
    if (!isRep && !(await hasDailyReportAdminRight(req))) {
      res.status(403).json({ success: false, message: 'لا تملك صلاحية رفع تقرير نيابةً عن مندوب' });
      return;
    }
    if (!isRep && !(await canAccessRep(req, tid, salesRepId))) {
      res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
    }
    const dateIssue = reportDateIssue(body.reportDate);
    if (dateIssue) {
      // رمزٌ صريح: حمولةٌ بتاريخٍ مستحيل لا تُصلحها إعادة المحاولة، فيُهملها الصندوق الصادر
      res.status(400).json({ success: false, code: 'DAILY_REPORT_BAD_DATE', message: dateIssue }); return;
    }

    // idempotency للرفع دون اتصال — قبل أي كتابة.
    //
    // **والتصحيح بعد الإعادة مستثنى، لا الصفّ المُعاد**: الفارق بينهما المفتاح
    // وزمن الكتابة. التصحيح اليدويّ يحمل مفتاحاً جديداً (`…-<round+1>`) فلا يجده
    // هذا البحث أصلاً ويمضي إلى مسار إعادة الرفع؛ أمّا إعادةُ الإرسال الآليّة من
    // الصندوق الصادر فتحمل **المفتاح نفسه وزمن كتابته نفسه**. واستثناء الحالة
    // RETURNED وحدها كان يفتح الباب لهذه الثانية: مشرفٌ يُعيد تقريراً ثم تُعيد
    // مزامنةٌ تلقائية رفعَ الأرقام المرفوضة نفسها جولةً جديدة، فيُمحى قرار الإعادة
    // وسببُه بلا خطوةٍ مضادّة ولا يرى المندوب شيئاً.
    // فالمعيار: أحدثُ من آخر رفعةٍ قُبلت = كتابةٌ جديدة، وما دونه تسليمٌ مكرّر.
    if (body.clientRef) {
      const existing = await prisma.dailyReport.findFirst({ where: { tenantId: tid, clientRef: body.clientRef } });
      if (existing) {
        const lastAccepted = existing.clientCreatedAt ?? existing.intakeAt;
        const fresh = !!body.clientCreatedAt && new Date(body.clientCreatedAt) > lastAccepted;
        if (existing.status !== 'RETURNED' || !fresh) {
          res.status(200).json({ success: true, data: existing, idempotent: true }); return;
        }
      }
    }

    const chain = await loadChain(tid);
    const issues = chainIssues(chain.levels, chain.owners);
    if (issues.length) {
      // سلسلةٌ غير جاهزة: نمنع الرفع بدل إنشاء تقريرٍ لا يصل صندوق أحد.
      // الرمز صريحٌ ليتعامل معه الصندوق الصادر إهمالاً لا إعادةَ محاولةٍ أبدية.
      res.status(409).json({ success: false, code: 'DAILY_REPORT_NO_LEVELS', message: `سلسلة الاعتماد غير مكتملة: ${issues[0]}` });
      return;
    }
    const first = firstLevel(chain.levels)!;

    /* خانات المندوب وحدها: `fillLevelSeq === null`. الحمولة تأتي من جهازٍ قد
     * تكون نسختُه أقدم من التهيئة — خانةٌ نُقلت أمس إلى المحاسب ما تزال في
     * صندوقه الصادر. وقبولُها هنا يكتب صفّاً عند levelSeq=0 ويكتب المحاسب صفّه
     * عند مستواه، فتُجمع الخانة مرّتين في يومٍ واحد. والمسار المقابل يحرس نفسه
     * (`/admin/:id/values` يجلب `fillLevelSeq: perm.levelSeq` وحدها) فهذا نظيره. */
    const fields = await prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true, fillLevelSeq: null } });
    const byId = new Map(fields.map(f => [f.id, f]));
    for (const f of fields) {
      if (f.required && f.fillLevelSeq === null) {
        const v = body.values.find(x => x.fieldId === f.id);
        const empty = !v || (v.num === null || v.num === undefined) && !String(v.text || '').trim();
        if (empty) { res.status(400).json({ success: false, message: `الخانة «${f.label}» مطلوبة` }); return; }
      }
    }

    const existingToday = await prisma.dailyReport.findFirst({
      where: { tenantId: tid, salesRepId, reportDate: body.reportDate },
      include: { tasks: true },
    });
    // تقريرٌ قائمٌ غير مُعاد = محاولة رفعٍ ثانية لليوم نفسه
    if (existingToday && existingToday.status !== 'RETURNED') {
      res.status(409).json({ success: false, code: 'DAILY_REPORT_EXISTS', message: 'رُفع تقرير هذا اليوم من قبل' });
      return;
    }

    const clientCreatedAt = body.clientCreatedAt ? new Date(body.clientCreatedAt) : null;
    const round = existingToday ? existingToday.round + 1 : 1;

    const saved = await prisma.$transaction(async tx => {
      const report = existingToday
        ? await tx.dailyReport.update({
            where: { id: existingToday.id },
            data: {
              status: 'SUBMITTED', currentLevelId: first.id, currentLevelSeq: first.seq,
              round, note: body.note ?? null, intakeAt: new Date(),
              // المفتاح يتبع الجولة الجديدة، وإلا بقي الصفّ يحمل مفتاح الجولة
              // الأولى فتعطّلت حماية التكرار لكل رفعةٍ بعدها
              ...(body.clientRef && { clientRef: body.clientRef }),
              ...(clientCreatedAt && { clientCreatedAt }),
            },
          })
        : await tx.dailyReport.create({
            data: {
              tenantId: tid, salesRepId,
              reportDate: body.reportDate, tzOffsetMin: body.tzOffsetMin ?? 0,
              status: 'SUBMITTED', currentLevelId: first.id, currentLevelSeq: first.seq,
              note: body.note ?? null, clientRef: body.clientRef ?? null,
              clientCreatedAt,
            },
          });

      /* قيم المندوب في المستوى 0 — تُستبدَل عند إعادة الرفع، ولا تمسّ قيم
       * المستويات الأعلى. **والحذف مقصورٌ على الخانات التي يملؤها المندوب الآن**:
       * المسحُ الشامل كان يمحو قيمة خانةٍ أُرشفت بين الجولتين — رقمٌ أقرّ به
       * المندوب وعلّق عليه المشرف يتبخّر من القاعدة نهائياً لأنّ حلقة الإنشاء
       * أدناه لا تعيد كتابته (الخانة لم تعد في `byId`). فالأرشفة تصير حذفاً
       * من الباب الخلفي، وهي بالضبط ما وُضعت لتمنعه. */
      await tx.dailyReportValue.deleteMany({
        where: { reportId: report.id, levelSeq: 0, fieldId: { in: [...byId.keys()] } },
      });
      for (const v of body.values) {
        const f = byId.get(v.fieldId);
        if (!f) continue; // خانةٌ أُرشِفت أو انتقلت لمستوىً أعلى بعد فتح الشاشة — تُهمَل بلا خطأ
        await tx.dailyReportValue.create({
          data: {
            tenantId: tid, reportId: report.id, fieldId: f.id, levelSeq: 0,
            labelSnapshot: f.label, kindSnapshot: f.kind,
            declaredNum: f.kind === 'TEXT' ? null : (v.num ?? null),
            declaredText: f.kind === 'TEXT' ? (v.text ?? null) : null,
          },
        });
      }

      // المهامّ القديمة تُلغى، ومهمّة الجولة الجديدة تُفتح
      if (existingToday) {
        await tx.dailyReportTask.updateMany({
          where: { reportId: report.id, state: 'PENDING' },
          data: { state: 'SKIPPED', resolvedAt: new Date() },
        });
      }
      await tx.dailyReportTask.create({
        data: { tenantId: tid, reportId: report.id, levelId: first.id, levelSeq: first.seq, round, state: 'PENDING' },
      });
      await tx.dailyReportStep.create({
        data: {
          tenantId: tid, reportId: report.id, levelSeq: 0, round,
          action: 'SUBMIT', actorAdminName: actorName(req),
          actorSalesRepId: isRep ? req.user!.id : null,
          actorAdminId: isRep ? null : req.user!.id,
        },
      });
      return report;
    });

    res.status(201).json({ success: true, data: saved });
  } catch (err) { next(err); }
});

/** تقارير المندوب نفسه — آخر ٣٠ */
router.get('/mine', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (req.user!.role !== 'SALES_REP') { res.status(403).json({ success: false, message: 'غير مسموح' }); return; }
    const rows = await prisma.dailyReport.findMany({
      where: { tenantId: tid, salesRepId: req.user!.id },
      orderBy: { reportDate: 'desc' }, take: 30,
      select: { id: true, reportDate: true, status: true, currentLevelSeq: true, round: true, approvedAt: true },
    });
    res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════
//  مسارات المراجعة والاعتماد — للوحة الإدارة وحدها
// ════════════════════════════════════════════════════════════════════

// المراجعة والاعتماد صلاحيةُ تقارير. وrequireAdmin وحده لا يكفي: محاسبٌ
// أُنشئ مقيَّداً بالسندات كان يفتح الوحدة كاملةً. وrequireAdminPermission
// يُركَّب **بعد** requireAdmin فلا يضرّ تمريرُه SALES_REP بلا فحص.
router.use('/admin', requireAdmin, requireAdminPermission('canViewReports'));

/** صندوق «بانتظارك»: التقارير الواقفة عند مستوىً أملكه */
router.get('/admin/inbox', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const me = req.user!.id;
    const chain = await loadChain(tid);
    const myOwnerIds = chain.owners.filter(o => o.adminId === me).map(o => o.id);
    if (!myOwnerIds.length) { res.json({ success: true, data: [] }); return; }
    const myLevelIds = [...new Set(chain.owners.filter(o => o.adminId === me).map(o => o.levelId))];

    /* النطاق يدخل الاستعلام نفسه لا يُصفّى بعده: المرشّح السابق كان يقرأ
     * `salesRepId.in` من كائنٍ لا يحمله، فلا يُقصي أحداً — كودٌ ميت. */
    const scope = await scopedRepRecordWhere(req);
    /* والترتيب **بالأحدث** لا بالأقدم: السقف ٢٠٠ يقع قبل تصفية الملكية، فبالأقدم
     * كانت مهامّ اليوم تسقط خارج النافذة وتختفي من الصندوق بلا أثر. */
    const tasks = await prisma.dailyReportTask.findMany({
      where: { tenantId: tid, state: 'PENDING', levelId: { in: myLevelIds }, report: { is: scope } },
      include: { report: { include: { salesRep: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' }, take: 200,
    });

    // التوجيه يُطبَّق بعد الاستعلام: المهمّة للمستوى، والملكية قد تكون مُشعّبة
    const mine = tasks.filter(t => {
      const rep = repRef(t.report.salesRepId);
      const eligible = ownersFor(chain.owners, chain.ownerReps, t.levelId, rep);
      return eligible.some(o => o.adminId === me);
    });

    res.json({
      success: true,
      data: mine.map(t => ({
        reportId: t.reportId, levelSeq: t.levelSeq, round: t.round,
        reportDate: t.report.reportDate, status: t.report.status,
        salesRepId: t.report.salesRepId, salesRepName: t.report.salesRep?.name ?? REP_GONE_NAME,
        submittedAt: t.report.intakeAt,
      })),
    });
  } catch (err) { next(err); }
});

/** تقريرٌ واحد بكل تفاصيله: القيم والتعليقات وسجلّ الخطوات */
router.get('/admin/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const report = await prisma.dailyReport.findFirst({
      where: { id: String(req.params.id), tenantId: tid },
      include: {
        salesRep: { select: { id: true, name: true } },
        values: { orderBy: { levelSeq: 'asc' } },
        comments: { orderBy: { createdAt: 'asc' } },
        steps: { orderBy: { createdAt: 'asc' } },
        tasks: true,
      },
    });
    if (!report) { res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return; }
    if (!(await canAccessRep(req, tid, repRef(report.salesRepId)))) {
      res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return;
    }

    const chain = await loadChain(tid);
    const fields = await prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } });
    const perm = canAct(
      { adminId: req.user!.id, role: req.user!.role },
      report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, repRef(report.salesRepId),
    );
    // الخانات التي يملؤها مستواي (مستوى ENTER)
    const myLevel = chain.levels.find(l => l.id === perm.levelId);
    const myFields = perm.allowed && myLevel?.kind === 'ENTER'
      ? fields.filter(f => f.isActive && f.fillLevelSeq === myLevel.seq)
      : [];
    /* ما هو مخزَّنٌ باسمي فعلاً في هذه الخانات — ولقطةُ جولته.
     * لوحة «بياناتك» كانت تبدأ فارغةً دائماً بينما القاعدة تحمل رقماً كتبتُه في
     * جولةٍ سابقة، فيظنّ صاحب المستوى أنه لم يسجّل شيئاً ويعتمد فوق رقمٍ قديم
     * لا يراه أحد. و`stale` تعني: كُتبت قبل رفعة الجولة الحاليّة ⇒ تخصّ أرقاماً
     * استُبدلت، وحارسُ الاعتماد يطلب تسجيلها من جديد. */
    const myValues = myFields.map(f => {
      const v = report.values.find(x => x.fieldId === f.id && x.levelSeq === myLevel!.seq);
      return v
        ? { fieldId: f.id, num: v.declaredNum, text: v.declaredText, stale: v.updatedAt < report.intakeAt }
        : { fieldId: f.id, num: null, text: null, stale: false };
    });

    res.json({
      success: true,
      data: {
        ...report,
        levels: sortLevels(chain.levels),
        canAct: perm.allowed,
        actLevelSeq: perm.levelSeq,
        actLevelName: myLevel?.name ?? null,
        actLevelKind: myLevel?.kind ?? null,
        myFields, myValues,
        distinctApproversNow: countDistinctApprovers(report.steps as never),
      },
    });
  } catch (err) { next(err); }
});

/** تعليقٌ على خانة (أو على التقرير كلّه إن كان fieldId فارغاً) */
router.post('/admin/:id/comment', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ fieldId: z.string().nullish(), body: z.string().min(1).max(2000) }).parse(req.body);
    const report = await prisma.dailyReport.findFirst({ where: { id: String(req.params.id), tenantId: tid }, include: { tasks: true } });
    if (!report) { res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return; }
    /* النطاق يحرس الفعل كما يحرس القراءة: `GET /admin/:id` وحده كان يفحصه،
     * فمستخدمٌ مقيَّدٌ يُمنع من فتح التقرير ويستطيع التوقيع عليه بطلبٍ مباشر
     * بمعرّفٍ وصله — أسوأ الاحتمالين معاً. والقاعدة موثّقة في adminScope.ts:
     * «والقراءة وحدها لا تكفي: مسارات الإنشاء تحرس المندوب بـcanAccessRep». */
    if (!(await canAccessRep(req, tid, repRef(report.salesRepId)))) {
      res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return;
    }
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, repRef(report.salesRepId));
    if (!perm.allowed) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const c = await prisma.dailyReportComment.create({
      data: {
        tenantId: tid, reportId: report.id, fieldId: body.fieldId ?? null,
        levelSeq: perm.levelSeq ?? 0, round: report.round,
        authorAdminId: req.user!.id, authorAdminName: actorName(req), body: body.body,
      },
    });
    res.status(201).json({ success: true, data: c });
  } catch (err) { next(err); }
});

/** مستوى ENTER يسجّل بياناته هو — صفوفٌ مستقلّة لا تمسّ إقرار المندوب */
router.post('/admin/:id/values', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ values: z.array(valueSchema) }).parse(req.body);
    const report = await prisma.dailyReport.findFirst({ where: { id: String(req.params.id), tenantId: tid }, include: { tasks: true } });
    if (!report) { res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return; }
    if (!(await canAccessRep(req, tid, repRef(report.salesRepId)))) {
      res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return;
    }
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, repRef(report.salesRepId));
    if (!perm.allowed || perm.levelSeq === null) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const fields = await prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true, fillLevelSeq: perm.levelSeq } });
    const byId = new Map(fields.map(f => [f.id, f]));

    try {
      await prisma.$transaction(async tx => {
      // مهمّتي ما تزال مفتوحةً داخل المعاملة: إعادةٌ للمندوب وقعت بيني وبين
      // قراءتي تُغلق المهامّ كلّها، وكتابتي بعدها تسجّل ENTER لجولةٍ انتهت
      const still = await tx.dailyReportTask.count({
        where: { reportId: report.id, levelId: perm.levelId!, round: report.round, state: 'PENDING' },
      });
      if (!still) throw new ReportMoved();
      for (const v of body.values) {
        const f = byId.get(v.fieldId);
        if (!f) continue; // خانةٌ ليست لمستواي — تُهمَل بلا خطأ
        await tx.dailyReportValue.upsert({
          where: { reportId_fieldId_levelSeq: { reportId: report.id, fieldId: f.id, levelSeq: perm.levelSeq! } },
          create: {
            tenantId: tid, reportId: report.id, fieldId: f.id, levelSeq: perm.levelSeq!,
            labelSnapshot: f.label, kindSnapshot: f.kind,
            declaredNum: f.kind === 'TEXT' ? null : (v.num ?? null),
            declaredText: f.kind === 'TEXT' ? (v.text ?? null) : null,
          },
          update: {
            declaredNum: f.kind === 'TEXT' ? null : (v.num ?? null),
            declaredText: f.kind === 'TEXT' ? (v.text ?? null) : null,
          },
        });
      }
      await tx.dailyReportStep.create({
        data: {
          tenantId: tid, reportId: report.id, levelSeq: perm.levelSeq!, round: report.round,
          action: 'ENTER', actorAdminId: req.user!.id, actorAdminName: actorName(req),
        },
      });
      });
    } catch (e) { if (rethrowMoved(e, res)) return; throw e; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** اعتماد المستوى — يفتح التالي، أو يُنهي السلسلة */
router.post('/admin/:id/approve', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const report = await prisma.dailyReport.findFirst({
      where: { id: String(req.params.id), tenantId: tid },
      include: { tasks: true, steps: true, values: true },
    });
    if (!report) { res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return; }
    if (!(await canAccessRep(req, tid, repRef(report.salesRepId)))) {
      res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return;
    }
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, repRef(report.salesRepId));
    if (!perm.allowed || perm.levelSeq === null) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const level = chain.levels.find(l => l.id === perm.levelId);
    // مستوى ENTER لا يعتمد قبل أن يسجّل خاناته المطلوبة
    if (level?.kind === 'ENTER') {
      const req_ = await prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true, fillLevelSeq: level.seq, required: true } });
      for (const f of req_) {
        const v = report.values.find(x => x.fieldId === f.id && x.levelSeq === level.seq);
        const empty = !v || (v.declaredNum === null && !String(v.declaredText || '').trim());
        if (empty) { res.status(400).json({ success: false, message: `سجّل «${f.label}» قبل الاعتماد` }); return; }
        /* **وقيمةٌ من جولةٍ مضت ليست تسجيلاً لهذه الجولة**: القيم بلا عمود
         * `round` (بخلاف الخطوة والتعليق) فحارسٌ يسأل «هل يوجد صفّ؟» يرضيه رقمٌ
         * كتبه صاحب المستوى قبل أن يُعيد المدير التقرير ويصحّح المندوب أرقامه.
         * فيُعتمَد تقريرٌ فيه إقرار مندوبٍ جديد مقابل تحقّق محاسبٍ قديم، ولا خطوة
         * ENTER في هذه الجولة تشهد بشيء. و`intakeAt` يُكتب مع كل رفعة، فمقارنته
         * بـ`updatedAt` تميّز الجولتين بلا عمودٍ جديد. */
        if (v!.updatedAt < report.intakeAt) {
          res.status(400).json({ success: false, message: `سجّل «${f.label}» من جديد — قيمتك المحفوظة من جولةٍ قبل التصحيح` });
          return;
        }
      }
    }

    /* سياق النصاب يُمرَّر وإلّا بقي «يوقّعان معاً» وعداً في المحاكي لا يُنفَّذ:
     * مستوىً عرّفته الشركة بتوقيعين كان يعبره توقيعٌ واحد ويُقفل التقرير. */
    const tr = applyAction('APPROVE', chain.levels, perm.levelSeq, report.round, {
      eligible: ownersFor(chain.owners, chain.ownerReps, perm.levelId!, repRef(report.salesRepId)),
      steps: report.steps as never,
      actorAdminId: req.user!.id,
    });
    const nowSteps = [
      ...(report.steps as never as { action: string; actorAdminId: string | null }[]),
      { action: 'APPROVE', actorAdminId: req.user!.id },
    ];
    const distinct = countDistinctApprovers(nowSteps as never);

    try {
      await prisma.$transaction(async tx => {
      // بالمعرّف لا بالرقم: الرقم يتبدّل بإعادة ترقيم العقد، فيفشل الإغلاق
      // ثم يصطدم إنشاءُ المهمّة التالية بالقيد الفريد فيعلق التقرير أبداً
      const closed = await tx.dailyReportTask.updateMany({
        where: { reportId: report.id, levelId: perm.levelId!, round: report.round, state: 'PENDING' },
        data: { state: tr.closeCurrentAs, resolvedAt: new Date() },
      });
      /* **وأن يُغلق صفٌّ واحدٌ فعلاً شرطُ المضيّ**: العدد كان يُهمَل، فإعادةٌ
       * للمندوب سبقت هذه المعاملة بجزءٍ من الثانية (مالكان لعقدةٍ واحدة، أو
       * الشخص نفسه من الويب والجوال) تُغلق المهامّ كلّها ثم يمضي الاعتماد فيفتح
       * المستوى التالي لتقريرٍ أُعيد للتصحيح: لا المندوب يرى سبب الإعادة ولا
       * يستطيع إعادة الرفع، ويُعتمَد نهائياً بالأرقام التي رُفضت.
       * والشرط «واحدٌ على الأقلّ» لا «واحدٌ بالضبط»: مهمّتان متطابقتان قد تكونان
       * من سباقٍ قديم، وإغلاقهما معاً هو الصواب لا حبسُ التقرير عقاباً عليه. */
      if (!closed.count) throw new ReportMoved();
      if (tr.openNext) {
        await tx.dailyReportTask.create({
          data: { tenantId: tid, reportId: report.id, levelId: tr.openNext.levelId, levelSeq: tr.openNext.levelSeq, round: tr.openNext.round, state: 'PENDING' },
        });
      }
      await tx.dailyReportStep.create({
        data: {
          tenantId: tid, reportId: report.id, levelSeq: perm.levelSeq!, round: report.round,
          action: 'APPROVE', actorAdminId: req.user!.id, actorAdminName: actorName(req),
        },
      });
      await tx.dailyReport.update({
        where: { id: report.id },
        data: {
          status: tr.status,
          currentLevelId: tr.openNext?.levelId ?? null,
          currentLevelSeq: tr.openNext?.levelSeq ?? null,
          ...(tr.finalApproval && {
            approvedByAdminId: req.user!.id, approvedByAdminName: actorName(req),
            approvedAt: new Date(), distinctApprovers: distinct,
          }),
        },
      });
      });
    } catch (e) { if (rethrowMoved(e, res)) return; throw e; }

    // خارج المعاملة عمداً: الاعتماد وقع وسُجّل، وتعذّرُ إصدار الحصيلة عرَضٌ
    // لا يجوز أن يتراجع بتوقيعٍ صحيح.
    // و**كل** اعتمادٍ نهائيّ يستدعيها لا أوّلها: الحصيلة تُحدَّث كما تُصدَر.
    if (tr.finalApproval) await issueOrRefreshDigest(tid, report.reportDate).catch(() => { /* يُعاد في الاعتماد التالي */ });

    res.json({ success: true, data: { status: tr.status, finalApproval: tr.finalApproval, distinctApprovers: distinct } });
  } catch (err) { next(err); }
});

/** إعادة للمندوب — **السبب إلزاميّ** */
router.post('/admin/:id/return', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = z.object({ reason: z.string().min(3, 'اكتب سبب الإعادة').max(1000) }).parse(req.body);
    const report = await prisma.dailyReport.findFirst({ where: { id: String(req.params.id), tenantId: tid }, include: { tasks: true } });
    if (!report) { res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return; }
    if (!(await canAccessRep(req, tid, repRef(report.salesRepId)))) {
      res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return;
    }
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, repRef(report.salesRepId));
    if (!perm.allowed || perm.levelSeq === null) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const tr = applyAction('RETURN', chain.levels, perm.levelSeq, report.round);
    try {
      await prisma.$transaction(async tx => {
      const closed = await tx.dailyReportTask.updateMany({
        where: { reportId: report.id, state: 'PENDING' },
        data: { state: 'SKIPPED', resolvedAt: new Date() },
      });
      // ولا إعادةَ على تقريرٍ لم يعد فيه ما يُغلق: اعتمادٌ سبقنا نقله للمستوى
      // التالي أو أنهاه، فتكتب هذه فوقه حالةَ RETURNED بلا مهمّةٍ مفتوحة
      if (!closed.count) throw new ReportMoved();
      await tx.dailyReportStep.create({
        data: {
          tenantId: tid, reportId: report.id, levelSeq: perm.levelSeq!, round: report.round,
          action: 'RETURN', actorAdminId: req.user!.id, actorAdminName: actorName(req), reason: body.reason,
        },
      });
      await tx.dailyReport.update({
        where: { id: report.id },
        data: { status: tr.status, currentLevelId: null, currentLevelSeq: null },
      });
      });
    } catch (e) { if (rethrowMoved(e, res)) return; throw e; }
    /* يومٌ كانت حصيلته محجوزةً بهذا التقرير قد يكتمل الآن: الإعادة تُخرج الصفّ
     * من «في الطريق» إلى «عند المندوب»، وبلا هذا النداء يبقى اليوم بلا حصيلة
     * حتى يقع اعتمادٌ نهائيٌّ آخر في التاريخ نفسه — وقد لا يقع أبداً. */
    await issueOrRefreshDigest(tid, report.reportDate).catch(() => { /* عرَضٌ لا يُسقط الإعادة */ });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════
//  التهيئة — «تحديد عدد المستويات وعددها وتشعّباتها» + خانات النموذج
//  كل كتابةٍ هنا تُسجَّل في DailyReportConfigLog: بدونه يرفع أحدهم عتبةً أو
//  يبدّل تسمية خانةٍ قبل الاعتماد بدقيقة، فتشهد خطوةُ الاعتماد بصدقٍ تامّ
//  على نموذجٍ غير الذي مُلئ.
// ════════════════════════════════════════════════════════════════════

// تعريف سلسلة الاعتماد إعدادُ شركةٍ لا عمل يوميّ: من يملك تغييرها يملك أن
// يجعل نفسه مستقبِل كل التقارير عند كل مستوى ثم يعتمدها كلها بنفسه.
router.use('/config', requireAdmin, requireAdminPermission('canManageDailyReport'));

/** التهيئة كاملةً: الخانات والمستويات والملّاك والتوجيه والمناديب */
router.get('/config', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [fields, chain, admins, reps, log, viewers] = await Promise.all([
      prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: [{ isActive: 'desc' }, { seq: 'asc' }] }),
      loadChain(tid),
      // `canViewReports` يعود للواجهة كي تعرف مَن يصلح مستلماً للتقرير الشامل:
      // إسنادُه لمن لا يملكها يُقبل «بنجاح» ثم يردّ عليه الخادم ٤٠٣ عند كل فتح
      prisma.admin.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true, role: true, canViewReports: true }, orderBy: { name: 'asc' } }),
      prisma.salesRep.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.dailyReportConfigLog.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, take: 40 }),
      prisma.dailyReportDigestViewer.findMany({ where: { tenantId: tid }, orderBy: { adminName: 'asc' }, select: { adminId: true, adminName: true } }),
    ]);
    const owners = await prisma.dailyReportLevelOwner.findMany({
      where: { tenantId: tid }, include: { reps: { select: { salesRepId: true } } },
    });
    res.json({
      success: true,
      data: {
        fields,
        levels: sortLevels(chain.levels),
        owners: owners.map(o => ({
          id: o.id, levelId: o.levelId, adminId: o.adminId, adminName: o.adminName,
          isDefault: o.isDefault, repIds: o.reps.map(r => r.salesRepId),
        })),
        admins, reps,
        issues: chainIssues(chain.levels, chain.owners),
        configLog: log,
        digestViewers: viewers,
      },
    });
  } catch (err) { next(err); }
});

// ————— الخانات —————

const fieldSchema = z.object({
  label: z.string().min(1).max(120),
  kind: z.enum(['NUMBER', 'MONEY', 'COUNT', 'TEXT']).default('NUMBER'),
  required: z.boolean().default(false),
  fillLevelSeq: z.number().int().min(1).nullish(),
});

/** مفتاحٌ ثابت لا يتغيّر بتغيّر التسمية — يولّده الخادم */
const makeKey = (label: string, n: number) =>
  `f${n}_${label.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 24).replace(/^_+|_+$/g, '') || 'field'}`;

/**
 * من يملأ هذه الخانة؟ — يجب أن يكون **مستوىً قائماً نوعه ENTER**.
 *
 * `fillLevelSeq` كان يُقبل كأيّ عددٍ ≥١ بلا سؤال: أسنِد خانةً «مطلوبة» إلى
 * مستوى REVIEW (وهو الافتراضيّ لكل عقدةٍ تُنشأ) أو إلى رقمٍ لا مستوى له، فلا
 * يراها المندوب (`/form` يعيد ما `fillLevelSeq` فيه null)، ولا تظهر لصاحب
 * المستوى (`myFields` تُبنى لـENTER وحده)، ولا يمنع أحدٌ الاعتماد (الحارس
 * مشروطٌ بـENTER) — خانةٌ «مطلوبة» تبقى فارغةً شهراً بلا رسالةٍ في أي شاشة.
 */
async function fillLevelIssue(tid: string, seq: number | null | undefined): Promise<string | null> {
  if (seq === null || seq === undefined) return null;
  const lvl = await prisma.dailyReportLevel.findFirst({ where: { tenantId: tid, seq }, select: { kind: true, name: true } });
  if (!lvl) return `لا يوجد مستوى رقمه ${seq} — اختر مستوىً قائماً أو اترك الخانة للمندوب`;
  if (lvl.kind !== 'ENTER') return `المستوى «${lvl.name}» يراجع ويعتمد ولا يسجّل بيانات — اجعله «يسجّل بياناته» أو اترك الخانة للمندوب`;
  return null;
}

router.post('/config/fields', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = fieldSchema.parse(req.body);
    const bad = await fillLevelIssue(tid, body.fillLevelSeq);
    if (bad) { res.status(400).json({ success: false, message: bad }); return; }
    /* الترقيم من **أعلى رقمٍ مستعمَل** لا من العدد: العدد ينقص بحذف خانةٍ بلا
     * قيم، فيعود الرقم المُولَّد إلى ترتيبٍ سبق استعمالُه، ومفتاحُ الخانة يقصّ
     * التسمية عند ٢٤ محرفاً فتتشارك تسميتان عربيّتان لاحقتَه — فيصطدم الإنشاء
     * بـ@@unique([tenantId, key]) ويردّ «السجل موجود مسبقا» على اسمٍ لم يُستعمل
     * قطّ، وتكرار المحاولة لا ينفع أبداً لأنّ العدّاد ثابت. */
    const [agg, keys] = await Promise.all([
      prisma.dailyReportField.aggregate({ where: { tenantId: tid }, _max: { seq: true } }),
      prisma.dailyReportField.findMany({ where: { tenantId: tid }, select: { key: true } }),
    ]);
    const next_ = (agg._max.seq ?? 0) + 1;
    const taken = new Set(keys.map(k => k.key));
    let key = makeKey(body.label, next_);
    for (let i = 2; taken.has(key); i++) key = `${makeKey(body.label, next_)}_${i}`;

    const created = await prisma.$transaction(async tx => {
      const f = await tx.dailyReportField.create({
        data: {
          tenantId: tid, key, label: body.label,
          kind: body.kind, required: body.required, fillLevelSeq: body.fillLevelSeq ?? null,
          seq: next_,
        },
      });
      await logConfig(tx, tid, req, 'FIELD', 'CREATE', `أضاف خانة «${body.label}»`, f.id, body.label);
      return f;
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) { next(err); }
});

router.patch('/config/fields/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = fieldSchema.partial().parse(req.body);
    const cur = await prisma.dailyReportField.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    if (!cur) { res.status(404).json({ success: false, message: 'الخانة غير موجودة' }); return; }

    // تغيير النوع بعد وجود قيم يعيد تفسير أرقامٍ مكتوبة — يُمنع، ويُنشأ بديلٌ بدله
    if (body.kind && body.kind !== cur.kind) {
      const used = await prisma.dailyReportValue.count({ where: { fieldId: cur.id } });
      if (used) { res.status(409).json({ success: false, message: 'لا يمكن تغيير نوع خانةٍ لها قيم — أرشِفها وأنشئ بديلاً' }); return; }
    }
    if (body.fillLevelSeq !== undefined) {
      const bad = await fillLevelIssue(tid, body.fillLevelSeq);
      if (bad) { res.status(400).json({ success: false, message: bad }); return; }
    }

    const updated = await prisma.$transaction(async tx => {
      const f = await tx.dailyReportField.update({ where: { id: cur.id }, data: body });
      const parts: string[] = [];
      if (body.label && body.label !== cur.label) parts.push(`غيّر تسمية «${cur.label}» إلى «${body.label}»`);
      if (body.required !== undefined && body.required !== cur.required) parts.push(body.required ? 'جعلها مطلوبة' : 'جعلها اختيارية');
      if (body.fillLevelSeq !== undefined && body.fillLevelSeq !== cur.fillLevelSeq) parts.push('غيّر من يملؤها');
      if (parts.length) await logConfig(tx, tid, req, 'FIELD', 'UPDATE', parts.join(' و'), f.id, f.label);
      return f;
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

/**
 * أرشفة لا حذف.
 * حذف صفّ التعريف ييتّم كل قيمةٍ رُفعت تحته في تقارير الشهر الماضي ويكسر
 * التقرير الشامل. والقاعدة نفسها ترفض الحذف (Restrict على القيم)، وهذا
 * المسار يمنعه قبلها برسالةٍ مفهومة.
 */
router.post('/config/fields/:id/archive', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const cur = await prisma.dailyReportField.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    if (!cur) { res.status(404).json({ success: false, message: 'الخانة غير موجودة' }); return; }
    const restore = req.body?.restore === true;
    await prisma.$transaction(async tx => {
      await tx.dailyReportField.update({
        where: { id: cur.id },
        data: { isActive: restore, archivedAt: restore ? null : new Date() },
      });
      await logConfig(tx, tid, req, 'FIELD', restore ? 'UPDATE' : 'ARCHIVE',
        restore ? `أعاد تفعيل «${cur.label}»` : `أرشف خانة «${cur.label}»`, cur.id, cur.label);
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/** حذفٌ نهائيّ — يُسمح به فقط لخانةٍ لم تُستعمل قطّ */
router.delete('/config/fields/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const cur = await prisma.dailyReportField.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    if (!cur) { res.status(404).json({ success: false, message: 'الخانة غير موجودة' }); return; }
    const used = await prisma.dailyReportValue.count({ where: { fieldId: cur.id } });
    if (used) { res.status(409).json({ success: false, message: `للخانة ${used} قيمة في تقارير سابقة — أرشِفها بدل حذفها` }); return; }
    await prisma.$transaction(async tx => {
      await tx.dailyReportField.delete({ where: { id: cur.id } });
      await logConfig(tx, tid, req, 'FIELD', 'DELETE', `حذف خانة «${cur.label}» (بلا قيم)`, cur.id, cur.label);
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/config/fields/reorder', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const ids = z.array(z.string()).parse(req.body?.ids || []);
    await prisma.$transaction(async tx => {
      for (let i = 0; i < ids.length; i++) {
        await tx.dailyReportField.updateMany({ where: { id: ids[i], tenantId: tid }, data: { seq: i + 1 } });
      }
      await logConfig(tx, tid, req, 'FIELD', 'REORDER', 'أعاد ترتيب الخانات');
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ————— المستويات —————

const levelSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['REVIEW', 'ENTER']).default('REVIEW'),
  quorum: z.enum(['ALL', 'ANY']).default('ALL'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'لون غير صالح').nullish(),
  posX: z.number().finite().nullish(),
  posY: z.number().finite().nullish(),
  /// المستخدم صاحب العقدة — تُنشأ العقدة وصاحبها معاً في نداءٍ واحد،
  /// فالعقدة **شخصٌ بعينه** لا طبقةٌ تُملأ لاحقاً. وعقدةٌ بلا صاحب لا معنى لها.
  adminId: z.string().uuid().nullish(),
});

router.post('/config/levels', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = levelSchema.parse(req.body);
    // `afterSeq` = تُدرَج الطبقة **بعد** هذا الموضع؛ غيابها = إلحاقٌ في آخر السلسلة.
    // الإدراج وسط السلسلة مطلبُ رسمِ العُقد: المالك يضيف «مدير المبيعات» بين
    // المشرف والمحاسب، لا في آخر الصفّ ثم يعيد الترتيب.
    const afterSeq = typeof req.body?.afterSeq === 'number' ? req.body.afterSeq : null;
    const max = await prisma.dailyReportLevel.aggregate({ where: { tenantId: tid }, _max: { seq: true } });
    const at = afterSeq === null ? (max._max.seq ?? 0) + 1 : afterSeq + 1;

    const created = await prisma.$transaction(async tx => {
      if (afterSeq !== null) {
        // إزاحةٌ تنازليّة: القيد الفريد (tenantId, seq) يصطدم لو أُزيح تصاعدياً
        const shift = await tx.dailyReportLevel.findMany({
          where: { tenantId: tid, seq: { gte: at } }, orderBy: { seq: 'desc' },
        });
        for (const l of shift) {
          await tx.dailyReportLevel.update({ where: { id: l.id }, data: { seq: l.seq + 1 } });
          // التابعون يتحرّكون مع العقدة، وإلا سُلّمت خانةٌ لشخصٍ آخر
          await tx.dailyReportTask.updateMany({ where: { tenantId: tid, levelId: l.id }, data: { levelSeq: l.seq + 1 } });
          await tx.dailyReport.updateMany({ where: { tenantId: tid, currentLevelId: l.id }, data: { currentLevelSeq: l.seq + 1 } });
        }
        // الخانات تُزاح تنازلياً حتى لا يدهس تحديثٌ سابقٌ لاحقاً
        const fields = await tx.dailyReportField.findMany({
          where: { tenantId: tid, fillLevelSeq: { gte: at } }, orderBy: { fillLevelSeq: 'desc' }, select: { id: true, fillLevelSeq: true },
        });
        for (const f of fields) {
          await tx.dailyReportField.update({ where: { id: f.id }, data: { fillLevelSeq: (f.fillLevelSeq ?? 0) + 1 } });
        }
      }
      const l = await tx.dailyReportLevel.create({
        data: {
          tenantId: tid, seq: at, name: body.name, kind: body.kind, quorum: body.quorum,
          color: body.color ?? null, posX: body.posX ?? null, posY: body.posY ?? null,
        },
      });
      // العقدة شخصٌ بعينه: يُربط صاحبها في المعاملة نفسها، فلا توجد لحظةٌ
      // تكون فيها عقدةٌ منشورةً بلا مستقبِل تبتلع تقارير لا يراها أحد.
      if (body.adminId) {
        const adm = await tx.admin.findFirst({ where: { id: body.adminId, tenantId: tid }, select: { id: true, name: true } });
        if (!adm) throw Object.assign(new Error('المستخدم غير موجود'), { status: 400 });
        await tx.dailyReportLevelOwner.create({
          data: { tenantId: tid, levelId: l.id, adminId: adm.id, adminName: adm.name, isDefault: true },
        });
      }
      await logConfig(tx, tid, req, 'LEVEL', 'CREATE', `أضاف عقدة «${body.name}» في الموضع ${at}`, l.id, body.name);
      return l;
    });
    res.status(201).json({ success: true, data: created });
  } catch (err) { next(err); }
});

router.patch('/config/levels/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = levelSchema.partial().parse(req.body);
    const cur = await prisma.dailyReportLevel.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    if (!cur) { res.status(404).json({ success: false, message: 'المستوى غير موجود' }); return; }
    // تقاريرُ واقفةٌ عند هذا المستوى الآن: تعديل نوعه يغيّر قواعد اللعبة تحتها
    const stuck = await prisma.dailyReportTask.count({ where: { tenantId: tid, levelId: cur.id, state: 'PENDING' } });
    if (stuck && body.kind && body.kind !== cur.kind) {
      res.status(409).json({ success: false, message: `${stuck} تقرير واقفٌ عند هذا المستوى — اعتمدها أو أعِدها قبل تغيير نوعه` });
      return;
    }
    /* ENTER ← REVIEW وللعقدة خاناتٌ مُسنَدة: الخانة تصير بلا مالكٍ يراها —
     * لا المندوب (fillLevelSeq ليس null) ولا صاحب العقدة (`myFields` لـENTER
     * وحده) ولا حارس الاعتماد (مشروطٌ بـENTER). فتبقى «مطلوبة» وفارغة أبداً. */
    if (body.kind === 'REVIEW' && cur.kind === 'ENTER') {
      const owned = await prisma.dailyReportField.findMany({
        where: { tenantId: tid, isActive: true, fillLevelSeq: cur.seq }, select: { label: true },
      });
      if (owned.length) {
        res.status(409).json({
          success: false,
          message: `يسجّل هذا المستوى ${owned.length} خانة (${owned.map(f => f.label).join('، ')}) — انقلها لمستوىً آخر أو للمندوب قبل تغيير دوره`,
        });
        return;
      }
    }
    const updated = await prisma.$transaction(async tx => {
      const l = await tx.dailyReportLevel.update({ where: { id: cur.id }, data: body });
      await logConfig(tx, tid, req, 'LEVEL', 'UPDATE', `عدّل المستوى «${cur.name}»`, l.id, l.name);
      return l;
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

/** حذف مستوى — يُعاد الترقيم داخل المعاملة فلا تبقى فجوة */
router.delete('/config/levels/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const cur = await prisma.dailyReportLevel.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    if (!cur) { res.status(404).json({ success: false, message: 'المستوى غير موجود' }); return; }
    // **كل تقريرٍ واقفٍ في السلسلة** لا الواقف عند هذه العقدة وحدها: حذفها
    // يعيد ترقيم ما بعدها، وتقريرٌ واقفٌ عند عقدةٍ لاحقة يتحرّك رقمه تحته.
    // والترقيم يُزامَن الآن، لكنّ المنع أصدق: المالك يرى العدد ويقرّر.
    /* الفحص **داخل** المعاملة: كان خارجها، فتقريرٌ يُرفع في تلك اللحظة — من
     * مندوبٍ عادت شبكته مثلاً — يُنشئ مهمّةً على عقدةٍ تُحذف بعدها بأجزاء من
     * الثانية، فيقف بلا مخرج: لا يظهر في صندوق أحد ولا يُعتمد ولا يُعاد. */
    /* ولا تُحذف آخر عقدة: السلسلة الفارغة تردّ **كل** رفعات الشركة بـ٤٠٩
     * `DAILY_REPORT_NO_LEVELS`، وتُخفي النموذج عن كل مندوب، وتحبس كل تقريرٍ
     * مُعادٍ بلا مخرج. وبانر الإعداد يقول ذلك — لكن **بعد** وقوع الحذف ولمن فتح
     * تبويب الإعداد وحده. ومن أراد إيقاف الميزة يُطفئ اشتراكها لا يُفرّغ مسارها. */
    const total = await prisma.dailyReportLevel.count({ where: { tenantId: tid } });
    if (total <= 1) {
      res.status(409).json({ success: false, message: 'هذه آخر عقدة في المسار — حذفها يوقف رفع التقارير لكل المناديب. أضف بديلاً أوّلاً أو أوقف الميزة من إعدادات الشركة' });
      return;
    }
    /* وما سيمحوه الـcascade يُكتب في الأثر **قبل** أن يُمحى: حذف العقدة يُسقط
     * ملّاكها ومعهم شبكة توجيه المناديب (١١ صفّاً في حالةٍ واقعية)، وإعادةُ
     * إضافتها تُنشئ مالكاً واحداً افتراضياً فيختفي التشعّب صامتاً — والسطر
     * «حذف المستوى «المحاسب»» لا يذكر اسم مالكٍ ولا مندوباً يُعاد البناء منه. */
    const owners = await prisma.dailyReportLevelOwner.findMany({
      where: { tenantId: tid, levelId: cur.id },
      include: { reps: { select: { salesRepId: true } } },
    });
    const routes = owners.reduce((s, o) => s + o.reps.length, 0);
    const who = owners.map(o => `${o.adminName}${o.isDefault ? ' (افتراضي)' : ''}${o.reps.length ? ` — ${o.reps.length} مندوب` : ''}`).join('، ');
    const summary = owners.length
      ? `حذف المستوى «${cur.name}» ومعه ${owners.length} مالك و${routes} توجيهاً: ${who}`
      : `حذف المستوى «${cur.name}» (بلا ملّاك)`;

    try {
      await prisma.$transaction(async tx => {
        const stuck = await tx.dailyReportTask.count({ where: { tenantId: tid, state: 'PENDING' } });
        if (stuck) throw new StuckLevels(stuck);
        await tx.dailyReportLevel.delete({ where: { id: cur.id } });
        await renumberLevels(tx, tid);
        await logConfig(tx, tid, req, 'LEVEL', 'DELETE', summary, cur.id, cur.name);
      });
    } catch (e) {
      if (e instanceof StuckLevels) {
        res.status(409).json({ success: false, message: `${e.count} تقرير واقفٌ في المسار — اعتمدها أو أعِدها قبل حذف عقدة` });
        return;
      }
      throw e;
    }
    // العدد يعود للواجهة كي يقول التأكيد ما ضاع فعلاً لا «حُذفت العقدة» وحدها
    res.json({ success: true, data: { removedOwners: owners.length, removedRoutes: routes } });
  } catch (err) { next(err); }
});

/**
 * ملّاك مستوىً وتوجيههم — **هذا هو التشعّب**.
 * يُستبدَل التعريف كاملاً في معاملةٍ واحدة، ويُحرَس أن يكون فيه مالكٌ افتراضيّ
 * واحد على الأكثر: مالكان افتراضيّان يجعلان مستقبِل التقرير غير محدَّد.
 */
router.put('/config/levels/:id/owners', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const level = await prisma.dailyReportLevel.findFirst({ where: { id: String(req.params.id), tenantId: tid } });
    if (!level) { res.status(404).json({ success: false, message: 'المستوى غير موجود' }); return; }
    const body = z.object({
      owners: z.array(z.object({
        adminId: z.string().min(1),
        isDefault: z.boolean().default(false),
        repIds: z.array(z.string()).default([]),
      })),
    }).parse(req.body);

    const defaults = body.owners.filter(o => o.isDefault).length;
    if (defaults > 1) { res.status(400).json({ success: false, message: 'مالكٌ افتراضيٌّ واحد لكل مستوى' }); return; }
    /* ولا **صفر** أيضاً: مستوىً كل ملّاكه موجَّهون لمناديب بعينهم يترك كل مندوبٍ
     * خارج القوائم بلا مستقبِل، فيرفض `chainIssues` السلسلةَ كلّها ويرتدّ رفعُ
     * **كل** مناديب الشركة بـ٤٠٩. وكان يُقبل هنا صامتاً ثمّ ينفجر بعيداً عن سببه:
     * المالك يضبط التوجيه فتتوقّف الميزة، ولا شيء يربط الأمرين. الرفض هنا يقع
     * في وجه الفعل الذي سبّبه ويسمّي العلاج. */
    if (body.owners.length && defaults === 0) {
      res.status(400).json({
        success: false,
        message: 'عيّن مستقبِلاً لبقية المناديب: عقدةٌ كل مُلّاكها موجَّهون تُوقف رفع التقارير للشركة كلّها',
      });
      return;
    }

    const admins = await prisma.admin.findMany({ where: { tenantId: tid, id: { in: body.owners.map(o => o.adminId) } }, select: { id: true, name: true } });
    const nameOf = new Map(admins.map(a => [a.id, a.name]));
    for (const o of body.owners) {
      if (!nameOf.has(o.adminId)) { res.status(400).json({ success: false, message: 'مستخدم غير موجود في الشركة' }); return; }
    }

    await prisma.$transaction(async tx => {
      await tx.dailyReportLevelOwner.deleteMany({ where: { tenantId: tid, levelId: level.id } });
      for (const o of body.owners) {
        const created = await tx.dailyReportLevelOwner.create({
          data: { tenantId: tid, levelId: level.id, adminId: o.adminId, adminName: nameOf.get(o.adminId)!, isDefault: o.isDefault },
        });
        for (const rid of [...new Set(o.repIds)]) {
          await tx.dailyReportOwnerRep.create({ data: { tenantId: tid, ownerId: created.id, salesRepId: rid } });
        }
      }
      const who = body.owners.map(o => nameOf.get(o.adminId)).join(' و') || 'لا أحد';
      await logConfig(tx, tid, req, 'OWNER', 'UPDATE', `ضبط ملّاك المستوى «${level.name}»: ${who}`, level.id, level.name);
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * المحاكي: «لو رفع هذا المندوب تقريره الآن، من يستقبله وبأي ترتيب؟»
 * أرخص عنصر في الميزة وأعلاه قيمة — بدونه يضبط المالك شبكة توجيهٍ لا يرى
 * أثرها إلا بعد أن يعلق تقرير مندوبٍ أسبوعاً.
 */
router.post('/config/preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const salesRepId = String(req.body?.salesRepId || '');
    const rep = await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, select: { name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }
    const chain = await loadChain(tid);
    res.json({
      success: true,
      data: {
        lines: describeChain(chain.levels, chain.owners, chain.ownerReps, rep.name, salesRepId),
        issues: chainIssues(chain.levels, chain.owners),
      },
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════
//  التقرير الشامل للفريق
// ════════════════════════════════════════════════════════════════════

/**
 * صفٌّ لكل مندوب × عمودٌ لكل خانة نشطة، لمدّةٍ محدّدة.
 *
 * السقف ٣١ يوماً **معلَنٌ في الاستجابة لا مقصوصٌ صامتاً**، وتقييد النطاق
 * معلَنٌ أيضاً: إجمالٌ يشمل مناديب المستخدم المُسنَدين وحدهم يجب أن يقول ذلك،
 * وإلا قُرئ إجمالاً للشركة.
 */

// ═══════════════════════ التقرير الشامل: مستلموه وأرشيفه ═══════════════════════

/**
 * الحصائل التي تخصّ هذا المستخدم — **أرشيفٌ دائم لا صندوق وارد**.
 *
 * لا تُقرأ من صندوق الاعتماد ولا تختفي بفعلٍ عليها: ما صدر يبقى في قائمته
 * ما دام مُسنَداً، وهو معنى «يبقى عنده مستمر». والإسناد يُقرأ لحظة الطلب
 * لا يُنسَخ على الحصيلة: سحبُ الإسناد يُخفي الأرشيف كلّه، ومنحُه يفتحه
 * كاملاً بما صدر قبل المنح.
 */
router.get('/digests', requireAdmin, requireAdminPermission('canViewReports'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const viewer = await prisma.dailyReportDigestViewer.findFirst({
      where: { tenantId: tid, adminId: req.user!.id }, select: { id: true },
    });
    // الصلاحية يحرسها الوسيط أعلاه (يقرؤها من القاعدة — req.user لا يحملها)،
    // ويبقى هنا فحص الإسناد وحده
    if (!viewer) { res.json({ success: true, data: { assigned: false, digests: [] } }); return; }

    const digests = await prisma.dailyReportDigest.findMany({
      where: { tenantId: tid },
      orderBy: { reportDate: 'desc' },
      take: 180,
    });
    res.json({ success: true, data: { assigned: true, digests } });
  } catch (err) { next(err); }
});

/**
 * محتوى حصيلة يومٍ صدر. الأرقام تُجمَّع من التقارير المُعتمَدة نفسها لا من
 * نسخةٍ مخزَّنة: المُعتمَد مقفولٌ بـ409، فالتجميع ثابتٌ ولا ينزاح، ونسخةٌ
 * ثانية كانت ستفتح باب تناقضٍ بين رقمين لمصدرٍ واحد.
 */
router.get('/digests/:date', requireAdmin, requireAdminPermission('canViewReports'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ success: false, message: 'تاريخ غير صالح' }); return; }

    const viewer = await prisma.dailyReportDigestViewer.findFirst({
      where: { tenantId: tid, adminId: req.user!.id }, select: { id: true },
    });
    if (!viewer) { res.status(403).json({ success: false, message: 'التقرير الشامل غير مُسنَد لك' }); return; }

    const digest = await prisma.dailyReportDigest.findFirst({ where: { tenantId: tid, reportDate: date } });
    if (!digest) { res.status(404).json({ success: false, message: 'لم تصدر حصيلة هذا اليوم' }); return; }

    /* النطاق يُطبَّق على **البسط والمقام معاً**: صفوفٌ مقيَّدةٌ بمناديبه وعدّادٌ
     * على مستوى الشركة يولّدان «غائبين لم يغيبوا» — سبعة عشر مندوباً «لم يرفعوا»
     * في يومٍ رفع فيه الجميع. وهو كائنُ مرشِّحٍ لا قائمة معرّفات: وجودُ مفتاحٍ
     * فيه = مقيَّد (نمط `/team`)، ولا يفحص المسارُ مفاتيح النطاق بنفسه. */
    const repFilter = await adminRepFilter(req);
    const scoped = Object.keys(repFilter).length > 0;

    const [fields, reports] = await Promise.all([
      prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } }),
      prisma.dailyReport.findMany({
        // نطاق المستخدم يُحترم هنا كما في كل مسارٍ آخر: الحصيلة لا تكون
        // بابَ التفافٍ يرى منه مستخدمٌ مقيَّدٌ أرقامَ مناديب لا يراهم
        where: { tenantId: tid, reportDate: date, status: 'APPROVED', ...(await scopedRepRecordWhere(req)) },
        include: { salesRep: { select: { id: true, name: true } }, values: true },
        orderBy: { salesRepId: 'asc' },
      }),
    ]);

    // مالك كل خانةٍ الآن: 0 = المندوب، n = مستوى ENTER. يُستعمل لاختيار الصفّ
    // الحيّ حين تحمل الخانة صفّين في تقريرٍ واحد.
    const ownerSeq = new Map(fields.map(f => [f.id, f.fillLevelSeq ?? 0]));
    const isMoney = new Map(fields.map(f => [f.id, f.kind === 'MONEY']));

    // تجميعٌ في المعالج لا استعلامٌ لكل مندوب — ومن **نفس** الصفوف الحيّة التي
    // يعرضها الجدول، فلا يقع رقمان متناقضان على شاشةٍ واحدة
    const liveByReport = reports.map(r => ({ r, vals: liveValues(r.values, ownerSeq) }));
    const rows = liveByReport.map(({ r, vals }) => ({
      /* صفٌّ لكل تقرير، ومفتاحه في الجدول هو `salesRepId` — فتقريران ليتيمين
       * مختلفَين كانا سيحملان المفتاح نفسه. معرّف التقرير يفرّقهما. */
      salesRepId: r.salesRepId ?? `gone:${r.id}`,
      salesRepName: r.salesRep?.name ?? REP_GONE_NAME,
      soloApproved: r.distinctApprovers === 1,
      approvedAt: r.approvedAt,
      values: Object.fromEntries(vals.map(v => [v.fieldId, v.declaredNum ?? v.declaredText ?? null])),
    }));
    // إجماليّ خانةٍ لم يكتب فيها أحدٌ ذلك اليوم = غياب لا صفر. وخانةٌ أُضيفت
    // بعد ذلك اليوم تظهر في حصيلته بـ«٠» فتبدو كأن الفريق أنفق صفراً وقتها.
    const totals: Record<string, number> = {};
    const seen = new Set<string>();
    // ولقطة التسمية لحظة التوقيع تسبق التسمية الحاليّة: الحصيلة مستندٌ مقفول،
    // وإعادةُ تسمية خانةٍ بعد شهر تعيد كتابة معنى أرقامٍ أُقرّت ووُقّعت تحتها.
    const labelSnap = new Map<string, Map<string, number>>();
    for (const { vals } of liveByReport) {
      for (const v of vals) {
        // «كُتب فيها شيء» لا «وُجد لها صفّ»: تطبيق المندوب يرسل كل الخانات ولو
        // فارغة فيُنشأ صفٌّ بـnull، فكانت خانةٌ تركها الجميع فارغةً تُطبع «٠»
        // في صفّ الإجمالي — إقرارٌ بأنّ الفريق لم يصرف شيئاً، وهو عكس الواقع.
        if (v.declaredNum === null && !String(v.declaredText || '').trim()) continue;
        seen.add(v.fieldId);
        const m = labelSnap.get(v.fieldId) ?? new Map<string, number>();
        m.set(v.labelSnapshot, (m.get(v.labelSnapshot) ?? 0) + 1);
        labelSnap.set(v.fieldId, m);
        if (v.declaredNum === null) continue;
        totals[v.fieldId] = addMoney(totals[v.fieldId] ?? 0, v.declaredNum, isMoney.get(v.fieldId) === true);
      }
    }
    /** التسمية الغالبة على قيم ذلك اليوم — وإلا التسمية الحاليّة لخانةٍ بلا قيم */
    const labelOf = (id: string, now: string) => {
      const m = labelSnap.get(id);
      if (!m) return now;
      return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    };

    // **العدّادات تُحسب حيّةً من نفس الصفوف التي يبنيها الجدول**، ولا تُقرأ من
    // الصفّ المخزَّن. تقريرٌ متأخّر يصل بعد الإصدار (من صندوق صادرٍ أوف‑لاين)
    // كان يدخل الجدول والإجمالي بينما يبقى الرأس يقول «تقريران» — رقمان
    // متناقضان على شاشةٍ واحدة، وكلاهما من عندنا.
    /* وعدّاد المناديب يُقرأ من **لقطة يوم الإصدار** (يُحدَّث مع كل اعتمادٍ لذلك
     * اليوم) لا من عدد اليوم الحاليّ: شركةٌ كانت ثلاثة مناديب في مارس وصارت
     * اثني عشر في يونيو كانت حصيلة مارس تقول «٩ مناديب لم يرفعوا» عن يومٍ رفع
     * فيه الجميع ولم يكن أكثرهم موظّفاً وقتها. والمقيَّد بالنطاق يُحسب بنطاقه. */
    const repCountEff = scoped
      ? await prisma.salesRep.count({ where: { tenantId: tid, isActive: true, ...repFilter } })
      : digest.repCount;
    const live = {
      reportCount: reports.length,
      repCount: repCountEff,
      soloApprovedCount: reports.filter(r => r.distinctApprovers === 1).length,
    };

    res.json({
      success: true,
      data: {
        digest: { ...digest, ...live },
        // أرقام لحظة الإصدار على مستوى الشركة — تُخفى عن المقيَّد بالنطاق كي لا
        // تتجاور مع صفوفٍ مقيَّدة فتُقرأ نقصاً في الأرقام
        issuedCounts: scoped ? null : { reportCount: digest.reportCount, repCount: digest.repCount, soloApprovedCount: digest.soloApprovedCount },
        /* تقارير وصلت بعد الإصدار — تُعرض صراحةً لا تُدَسّ في الإجمالي بصمت.
         * وتُعدّ **بزمن اعتمادها** لا بفرق العدّادين: الطرح كان يُعطي صفراً دائماً
         * للمقيَّد بالنطاق (بسطٌ مقيَّد ناقص مقامٍ غير مقيَّد) فيُدَسّ المتأخّر بصمت. */
        lateReports: reports.filter(r => r.approvedAt && r.approvedAt > digest.issuedAt).length,
        // الخانات المؤرشَفة تبقى معروضة: حصيلةٌ قديمة تُقرأ بخاناتها هي
        // hadData=false ⇒ الواجهة تطبع شرطة لا صفراً
        fields: fields.map(f => ({ id: f.id, label: labelOf(f.id, f.label), kind: f.kind, isActive: f.isActive, hadData: seen.has(f.id) })),
        rows, totals,
        missingReps: Math.max(0, repCountEff - reports.length),
        scoped,
        scopedNote: scoped ? 'الحصيلة تعرض المناديب المُسنَدين لك وحدهم' : null,
      },
    });
  } catch (err) { next(err); }
});

/** مستلمو التقرير الشامل — قراءةً ضمن التهيئة، وكتابةً بصلاحيتها */
router.put('/config/digest-viewers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const ids: string[] = Array.isArray(req.body?.adminIds) ? req.body.adminIds.map(String) : [];
    const admins = await prisma.admin.findMany({
      where: { tenantId: tid, id: { in: ids } }, select: { id: true, name: true, isActive: true, canViewReports: true },
    });
    /* مستلمٌ بلا صلاحية تقارير إسنادٌ «ناجح» لا يعمل أبداً: الكتابة هنا تحتاج
     * `canManageDailyReport` والقراءة تحتاج `canViewReports`، فالأوّل يستطيع أن
     * يُسنِد لمن لا يملك الثاني — ثمّ يردّ `GET /digests` عليه ٤٠٣ عند كل فتح،
     * فتعرض شاشته «تعذر تحميل الحصائل» ولا أحد يعرف السبب. الرفض هنا يقع في وجه
     * الفعل الذي سبّبه ويسمّي العلاج. والمنع عند `=== false` كنظيره في الوسيط. */
    const blocked = admins.filter(a => !a.isActive || a.canViewReports === false);
    if (blocked.length) {
      res.status(400).json({
        success: false,
        message: `${blocked.map(a => a.name).join('، ')}: لا يملك صلاحية «عرض التقارير» فلن يفتح الحصيلة — امنحه الصلاحية أو أزِله من المستلمين`,
      });
      return;
    }
    await prisma.$transaction(async tx => {
      await tx.dailyReportDigestViewer.deleteMany({ where: { tenantId: tid } });
      for (const a of admins) {
        await tx.dailyReportDigestViewer.create({ data: { tenantId: tid, adminId: a.id, adminName: a.name } });
      }
      await logConfig(tx, tid, req, 'OWNER', 'UPDATE',
        admins.length ? `عيّن مستلمي التقرير الشامل: ${admins.map(a => a.name).join('، ')}` : 'ألغى كل مستلمي التقرير الشامل');
    });
    res.json({ success: true, data: { count: admins.length } });
  } catch (err) { next(err); }
});

/**
 * يعيد ترقيم العقد ١..ن **ويُزامن كل ما يشير إلى الرقم** في المعاملة نفسها.
 *
 * الرقم مفتاحٌ مشتقّ يشير إليه ثلاثة: مهامّ التقارير الواقفة، وخانات النموذج
 * المسنَدة لمستوى (fillLevelSeq)، ومؤشّر التقرير (currentLevelSeq). وتركُ
 * أيٍّ منها على رقمٍ قديم بعد حذف عقدةٍ أو إدراج أخرى يُسلّم خانةً مطلوبة
 * لشخصٍ آخر، أو يُعلّق تقريراً عند مستوىً لم يعد موجوداً.
 *
 * وقيم التقارير (DailyReportValue.levelSeq) **لا تُمَسّ**: تلك سجلٌّ تاريخيّ
 * يقول من كتب الرقم، وإعادةُ كتابته تزوير.
 */
async function renumberLevels(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], tid: string) {
  const rest = await tx.dailyReportLevel.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } });

  /* خانات العقدة المحذوفة **تُحرَّر أوّلاً**: الترقيم أدناه ينقل الخانات بمطابقة
   * الرقم القديم، ورقمُ المحذوفة لم يعد لأيّ مستوىً باقٍ فلا تُلمَس — فترثها
   * العقدة التي تأخذ رقمها. والوارث إن كان REVIEW لم يرَ الخانة ولم يفحصها
   * حارس الاعتماد ولا يراها المندوب: خانةٌ «مطلوبة» لا يملؤها أحدٌ أبداً. وإن
   * كان ENTER مُنع من الاعتماد بخانةٍ لم تكن له قطّ.
   * فتعود الخانة إلى المندوب (`null`) — وهو الموضع الوحيد الذي يُرى فيه دائماً. */
  const liveSeqs = rest.map(l => l.seq);
  await tx.dailyReportField.updateMany({
    where: { tenantId: tid, fillLevelSeq: { not: null, notIn: liveSeqs } },
    data: { fillLevelSeq: null },
  });

  for (let i = 0; i < rest.length; i++) {
    const want = i + 1;
    if (rest[i].seq === want) continue;
    const from = rest[i].seq;
    await tx.dailyReportLevel.update({ where: { id: rest[i].id }, data: { seq: want } });
    await tx.dailyReportTask.updateMany({ where: { tenantId: tid, levelId: rest[i].id }, data: { levelSeq: want } });
    await tx.dailyReportField.updateMany({ where: { tenantId: tid, fillLevelSeq: from }, data: { fillLevelSeq: want } });
    await tx.dailyReport.updateMany({ where: { tenantId: tid, currentLevelId: rest[i].id }, data: { currentLevelSeq: want } });
  }
}

/**
 * يُصدِر حصيلة اليوم إن اكتمل، **ويُحدّثها إن صدرت** — يُستدعى بعد كل اعتمادٍ
 * نهائيّ وبعد كل إعادةٍ للمندوب.
 *
 * ═══════════ لماذا «إصدارٌ يتجدّد» لا «إصدارٌ مرّةً واحدة» ═══════════
 * الشرط القديم كان يتحقّق حتماً عند **أوّل** اعتمادٍ نهائيّ يسبق ثاني رفعة —
 * وهو الحال الغالب في أي شركة بأكثر من مندوب: الساعة ٨:٠٥ لا يوجد تقريرٌ آخر
 * «في الطريق» فتصدر الحصيلة بـ«تقرير واحد»، ثم تتجمّد أبداً لأنّ كل اعتمادٍ
 * تالٍ يجد `existing` فينصرف — فيقرأ المدير عن يوم عملٍ كامل: «١ تقرير · ١٩
 * مندوب لم يرفع». الصفّ **علامةٌ لا نسخة** (نصّ المخطّط)، فلا ضير في تحديث
 * عدّاداته: التحديث يجعل العلامة صادقة بدل أن يحرسها الجمود.
 *
 * **و«في الطريق» لا تشمل المُعاد للتصحيح**: تقريرٌ عند المندوب ليس في السلسلة،
 * وقد لا يعود أبداً (إجازة، استقالة، تجاهل) — وعدّه حاجزاً كان يُسقط يوماً
 * كاملاً بتسعة عشر تقريراً موقّعاً من الأرشيف إلى الأبد بلا أي إجراءٍ متاح.
 * فيصدر اليوم بما اكتمل، ويُحدَّث حين يُصحَّح المُعاد ويُعتمد، والنقص معلَنٌ في
 * `missingReps` و`lateReports`.
 *
 * ومندوبٌ لم يرفع أصلاً لا يمنع الإصدار — لكنّ غيابه **يُعدّ ويُعرض**:
 * `repCount` مقابل `reportCount`. حصيلةٌ تخفي الغائبين تبدو كاملةً وهي ناقصة.
 *
 * ولا يُصدَر ليومٍ بلا تقارير: «صفر تقرير» ليس يوماً مكتملاً بل يومٌ لم يبدأ.
 *
 * الخطأ هنا **لا يُسقط الاعتماد**: التوقيع وقع وسُجّل، وتعذّرُ إصدار الحصيلة
 * عرَضٌ يُعاد حسابه في الاعتماد التالي أو يُصدَر يدوياً. فيُستدعى **خارج**
 * معاملة الاعتماد وبـcatch صامت.
 *
 * `force` للإصدار اليدويّ: يتجاوز حاجز «ما زال في الطريق» وحده — لا يتجاوز
 * «يومٌ بلا تقريرٍ معتمَد».
 */
async function issueOrRefreshDigest(tid: string, reportDate: string, force = false): Promise<'issued' | 'refreshed' | 'blocked' | 'empty'> {
  // القراءات في معاملةٍ واحدة: بلا ذلك قد يُقرأ pending=0 قبل وصول تقريرٍ
  // متأخّر ثم يُعدّ approved بعده، فتُخزَّن عدّاداتٌ لم تقع في لحظةٍ واحدة.
  // والقيد الفريد يحسم التصادم، وهذا يحسم اللقطة.
  const [inFlight, approved, repCount, existing] = await prisma.$transaction([
    prisma.dailyReport.count({ where: { tenantId: tid, reportDate, status: { in: ['SUBMITTED', 'IN_REVIEW'] } } }),
    prisma.dailyReport.findMany({
      where: { tenantId: tid, reportDate, status: 'APPROVED' },
      select: { distinctApprovers: true },
    }),
    prisma.salesRep.count({ where: { tenantId: tid, isActive: true } }),
    prisma.dailyReportDigest.findFirst({ where: { tenantId: tid, reportDate }, select: { id: true } }),
  ]);
  if (approved.length === 0) return 'empty';
  if (inFlight > 0 && !(existing || force)) return 'blocked';

  const counts = {
    reportCount: approved.length,
    repCount,
    soloApprovedCount: approved.filter(r => r.distinctApprovers === 1).length,
  };
  if (existing) {
    await prisma.dailyReportDigest.update({ where: { id: existing.id }, data: counts });
    return 'refreshed';
  }
  await prisma.dailyReportDigest.create({
    data: { tenantId: tid, reportDate, ...counts },
  }).catch(() => { /* سباقُ اعتمادين متزامنين — القيد الفريد يحسمه، والصفّ موجود */ });
  return 'issued';
}

/**
 * إصدارٌ يدويّ لحصيلة يوم — الوعد الذي كان مكتوباً في التعليق وغير مبنيّ.
 *
 * يومٌ فيه تقريرٌ عالقٌ في السلسلة لا يخرج منها (مالك عقدته خارج نطاقه، أو
 * مندوبٌ ترك العمل ولم يصحّح) كان يحجب حصيلة يومه **أبداً**: لا حذف لتقريرٍ
 * يوميّ، ولا اعتماد إداريّ يتجاوز، ولا إصدار يدويّ — فيغيب يوم عملٍ كاملٍ
 * بتسعة عشر تقريراً موقّعاً عن أرشيف من بُنيت الميزة لأجلهم.
 *
 * وهو بصلاحية **تهيئة** التقرير لا بصلاحية قراءته: من يُصدر يومـاً ناقصاً
 * يتحمّل قرار إعلانه، والنقص يبقى معلَناً في `missingReps` و`lateReports`.
 */
router.post('/digests/:date/issue', requireAdmin, requireAdminPermission('canManageDailyReport'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ success: false, message: 'تاريخ غير صالح' }); return; }
    const out = await issueOrRefreshDigest(tid, date, true);
    if (out === 'empty') {
      res.status(409).json({ success: false, message: 'لا تقرير معتمَد في هذا اليوم — لا حصيلة لِما لم يبدأ' }); return;
    }
    const pending = await prisma.dailyReport.count({ where: { tenantId: tid, reportDate: date, status: { not: 'APPROVED' } } });
    await prisma.$transaction(async tx => {
      await logConfig(tx, tid, req, 'DIGEST', out === 'refreshed' ? 'UPDATE' : 'CREATE',
        pending ? `أصدر حصيلة ${date} يدوياً وفيها ${pending} تقرير غير معتمَد` : `أصدر حصيلة ${date} يدوياً`, null, date);
    });
    res.json({ success: true, data: { result: out, pending } });
  } catch (err) { next(err); }
});

/**
 * صفٌّ لكل مندوب في المدّة: عدّاداتُ أيامه وإجماليُّ كل خانة.
 *
 * **ما رُفض لا يُجمع**: أرقام تقريرٍ أُعيد للتصحيح تبقى في القاعدة حتى إعادة
 * الرفع، وكانت تدخل إجمالي المدّة بلا وسم — فيخرج للشركة رقمان لليوم نفسه:
 * حصيلة اليوم تقول ٥٠٠٠ بعد التصحيح، و«التقرير الشامل» يقول ٥٠٠٠٠ قبله.
 * وما لم يُعتمد بعدُ يبقى داخل الإجمالي (لم يُرفض، وإخراجُه يُفرغ تقرير اليوم
 * الجاري من معناه) وعدده معلَنٌ في `pending` و`totalsNote`.
 *
 * و`seen` تعني «كُتب فيها رقمٌ أو نصّ» — بها تظهر أعمدة الخانات المؤرشَفة التي
 * لها قيمٌ في المدّة، ولا تظهر خانةٌ أُضيفت بعدها.
 */
function teamRows(
  reports: { salesRepId: string | null; salesRep: { name: string } | null; status: string; distinctApprovers: number; values: LiveValue[] }[],
  fields: { id: string; kind: string; fillLevelSeq: number | null }[],
) {
  const ownerSeq = new Map(fields.map(f => [f.id, f.fillLevelSeq ?? 0]));
  const isMoney = new Map(fields.map(f => [f.id, f.kind === 'MONEY']));
  const byRep = new Map<string, { salesRepId: string; salesRepName: string; days: number; approved: number; soloApproved: number; pending: number; returned: number; totals: Record<string, number> }>();
  const seen = new Set<string>();
  for (const r of reports) {
    /* تقارير كل من حُذف تُجمع في صفٍّ واحد: المعرّف زال فلا سبيل للتفريق
     * بينهم، وإخفاؤها يُنقص إجماليّ المدّة عن مجموع ما رُفع فيها فعلاً. */
    const key = repRef(r.salesRepId);
    let row = byRep.get(key);
    if (!row) {
      row = { salesRepId: key, salesRepName: r.salesRep?.name ?? REP_GONE_NAME, days: 0, approved: 0, soloApproved: 0, pending: 0, returned: 0, totals: {} };
      byRep.set(key, row);
    }
    row.days += 1;
    if (r.status === 'APPROVED') {
      row.approved += 1;
      // «اعتمده شخص واحد» — لا يُمنع لكنه لا يُخفى
      if (r.distinctApprovers <= 1) row.soloApproved += 1;
    } else if (r.status === 'RETURNED') row.returned += 1;
    else row.pending += 1;

    if (r.status === 'RETURNED') continue;
    // صفٌّ واحد لكل خانة: قد تحمل صفّ المندوب وصفّ مستوى ENTER معاً
    for (const v of liveValues(r.values, ownerSeq)) {
      if (v.declaredNum !== null || String(v.declaredText || '').trim()) seen.add(v.fieldId);
      if (v.declaredNum === null || v.declaredNum === undefined) continue;
      row.totals[v.fieldId] = addMoney(row.totals[v.fieldId] ?? 0, v.declaredNum, isMoney.get(v.fieldId) === true);
    }
  }
  return {
    rows: [...byRep.values()].sort((a, b) => a.salesRepName.localeCompare(b.salesRepName, 'ar')),
    seen,
  };
}

/**
 * سجلّ تقارير مندوبٍ واحد — يوماً بيوم.
 *
 * الطرق الثلاثة تجيب أسئلة مختلفة ولا يُغني أحدها عن الآخر: `/team` يطوي
 * المدّة كلّها في صفٍّ واحد لكل مندوب، و`/digests/:date` يقطع الفريق كلّه في
 * يومٍ واحد. وبقي السؤال الذي يُسأل في **صفحة المندوب نفسها** — حيث سجلّ
 * تحصيله وسجلّ تحميله — بلا جواب: ماذا أقرّ هذا المندوب في كلّ يوم؟
 *
 * والصفّ يحمل الحالة وزمن الرفع والاعتماد وعند أيّ مستوى يقف الآن، لا الأرقام
 * وحدها: تقريرٌ عالقٌ أربعة أيام عند مستوىً واحد معلومةٌ إداريّة لا تقلّ عن
 * مبالغه، وهي لا تظهر في أيّ شاشةٍ أخرى.
 *
 * والمُعاد للتصحيح **يظهر في السجلّ** وإن كان خارج إجماليّ `/team`: السجلّ
 * سردُ ما جرى لا حصيلةَ ما اعتُمد، وإخفاؤه يطمس سبب فجوة يومٍ في الحصيلة.
 */
router.get('/rep/:salesRepId', requireAdmin, requireAdminPermission('canViewReports'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const repId = String(req.params.salesRepId || '');
    // النطاق أوّلاً: ٤٠٤ لا ٤٠٣ — لا يفصح عن وجود مندوبٍ خارج نطاق السائل
    if (!(await canAccessRep(req, tid, repId))) {
      res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
    }
    const rep = await prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { id: true, name: true } });
    if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }

    /* المدّة اختيارية: بلا مدّةٍ يُعرض آخر ٣٠ يوماً — وهو ما يريده من يفتح
     * صفحة مندوب، لا شهرٌ يختاره أوّلاً ليرى شيئاً. والسقف ٩٢ يوماً: مندوبٌ
     * واحد لا الفريق، فالحمل ثلث حمل `/team` عند نفس المدّة. */
    const DEF_DAYS = 30;
    const MAX_DAYS = 92;
    const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const qTo = String(req.query.to || '');
    const qFrom = String(req.query.from || '');
    const to = isDate(qTo) ? qTo : new Date().toISOString().slice(0, 10);
    let from = isDate(qFrom) ? qFrom : new Date(Date.parse(to) - (DEF_DAYS - 1) * 86400000).toISOString().slice(0, 10);
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const capped = days > MAX_DAYS;
    // القصّ من **الطرف الأقدم**: من يوسّع المدّة يريد الأحدث لا الأقدم
    if (capped) from = new Date(Date.parse(to) - (MAX_DAYS - 1) * 86400000).toISOString().slice(0, 10);

    const [fields, reports, chain] = await Promise.all([
      // بلا قيد isActive: خانةٌ أُرشفت لها أرقامٌ في أيّامٍ ماضية، وإخفاء عمودها
      // يمحو ما أُقرّ به فعلاً يومها (نفس قاعدة `/team` و`/digests`)
      prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } }),
      prisma.dailyReport.findMany({
        where: { tenantId: tid, salesRepId: repId, reportDate: { gte: from, lte: to } },
        include: { values: true },
        orderBy: { reportDate: 'desc' },
      }),
      loadChain(tid),
    ]);

    const ownerSeq = new Map(fields.map(f => [f.id, f.fillLevelSeq ?? 0]));
    const levelName = new Map(chain.levels.map(l => [l.seq, l.name]));
    const seen = new Set<string>();
    const rows = reports.map(r => {
      const vals = liveValues(r.values, ownerSeq);
      for (const v of vals) {
        if (v.declaredNum !== null || String(v.declaredText || '').trim()) seen.add(v.fieldId);
      }
      return {
        id: r.id,
        reportDate: r.reportDate,
        status: r.status,
        round: r.round,
        note: r.note,
        submittedAt: r.intakeAt,
        approvedAt: r.approvedAt,
        // «اعتمده شخص واحد» — يُعلَن هنا كما يُعلَن في الحصيلة، لا يُخفى
        soloApproved: r.status === 'APPROVED' && r.distinctApprovers <= 1,
        // عند أيّ مستوىً يقف الآن — فارغٌ للمعتمَد والمُعاد
        currentLevelName: r.status === 'PENDING' ? (levelName.get(r.currentLevelSeq ?? -1) ?? null) : null,
        values: Object.fromEntries(vals.map(v => [v.fieldId, v.declaredNum ?? v.declaredText ?? null])),
      };
    });

    res.json({
      success: true,
      data: {
        rep,
        // الخانات النصّية تبقى: السجلّ سردٌ لا جدول إجماليّات، وملاحظةُ يومٍ
        // قد تكون كلّ ما يفسّر رقمه
        fields: fields.filter(f => f.isActive || seen.has(f.id)).map(f => ({ id: f.id, label: f.label, kind: f.kind })),
        rows,
        meta: {
          from, to, capped,
          cappedNote: capped ? `المدّة قُصّت إلى ${MAX_DAYS} يوماً (من ${from} إلى ${to})` : null,
          approved: rows.filter(r => r.status === 'APPROVED').length,
          pending: rows.filter(r => r.status === 'PENDING').length,
          returned: rows.filter(r => r.status === 'RETURNED').length,
        },
      },
    });
  } catch (err) { next(err); }
});

router.get('/team', requireAdmin, requireAdminPermission('canViewReports'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ success: false, message: 'حدّد المدّة بصيغة YYYY-MM-DD' }); return;
    }
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const capped = days > 31;
    const toEff = capped ? new Date(Date.parse(from) + 30 * 86400000).toISOString().slice(0, 10) : to;

    /* النطاق يُنشر كما هو لا يُستخرَج منه مفتاح: الدالّة تُرجع مرشّحَ علاقةٍ
     * `{ salesRep: { adminScopes } }`، وقراءة `salesRepId.in` منه كانت تقرأ
     * مفتاحاً غير موجود فتصير undefined ويسقط القيد **صامتاً** — فيرى مستخدمٌ
     * مقيَّدٌ بمندوبَين أرقامَ الشركة كلّها. وهذا هو نمط بقيّة المسارات. */
    const scope = await scopedRepRecordWhere(req);

    const [fields, reports] = await Promise.all([
      /* الخانات **بلا قيد `isActive`**: الأرشفة مخرجُ خانةٍ لم تعد تُجمع، وكانت
       * تمحو عمودها من كل مدّةٍ ماضية — الإجمالي محسوبٌ في `row.totals` ولا عمود
       * يحمله. كـ`/digests`: «حصيلةٌ قديمة تُقرأ بخاناتها هي». */
      prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } }),
      prisma.dailyReport.findMany({
        where: {
          tenantId: tid,
          reportDate: { gte: from, lte: toEff },
          ...scope,
        },
        include: { salesRep: { select: { id: true, name: true } }, values: true },
        orderBy: [{ salesRepId: 'asc' }, { reportDate: 'asc' }],
      }),
    ]);
    // تجميعٌ في المعالج لا استعلامٌ لكل مندوب (الدالّة فوق — ولماذا فيها)
    const { rows, seen } = teamRows(reports, fields);
    const pendingDays = rows.reduce((s, r) => s + r.pending, 0);
    const returnedDays = rows.reduce((s, r) => s + r.returned, 0);
    // «اعتمده شخص واحد» على مستوى المدّة كلّها — لا يُمنع ولا يُخفى
    const soloApprovedDays = rows.reduce((s, r) => s + r.soloApproved, 0);
    res.json({
      success: true,
      data: {
        // المؤرشَفة تظهر إن كان لها رقمٌ في المدّة، وتُوسَم بـisActive للواجهة
        fields: fields.filter(f => f.kind !== 'TEXT' && (f.isActive || seen.has(f.id))),
        rows,
        meta: {
          from, to: toEff,
          capped, cappedNote: capped ? `المدّة قُصّت إلى ٣١ يوماً (من ${from} إلى ${toEff})` : null,
          // النطاق كائنُ مرشِّحٍ الآن لا قائمة معرّفات: وجودُ مفتاحٍ فيه = مقيَّد
          scoped: Object.keys(scope).length > 0,
          scopedNote: Object.keys(scope).length > 0 ? 'الإجمالي يشمل المناديب المُسنَدين لك وحدهم' : null,
          pendingDays, returnedDays, soloApprovedDays,
          totalsNote: returnedDays || pendingDays
            ? `الإجماليات لا تشمل ${returnedDays} تقريراً أُعيد للتصحيح${pendingDays ? `، وتشمل ${pendingDays} تقريراً لم يُعتمَد بعد` : ''}`
            : null,
        },
      },
    });
  } catch (err) { next(err); }
});

export default router;
