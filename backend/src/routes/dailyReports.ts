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
import { canAccessRep, scopedRepRecordWhere } from '../services/adminScope';
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

/** يقرأ تعريف السلسلة كاملاً لهذه الشركة */
async function loadChain(tid: string) {
  const [levels, owners, ownerReps] = await Promise.all([
    prisma.dailyReportLevel.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } }),
    prisma.dailyReportLevelOwner.findMany({ where: { tenantId: tid } }),
    prisma.dailyReportOwnerRep.findMany({ where: { tenantId: tid } }),
  ]);
  return {
    levels: levels as unknown as ChainLevel[],
    owners: owners as unknown as ChainOwner[],
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
      },
    });
  } catch (err) { next(err); }
});

const valueSchema = z.object({
  fieldId: z.string().min(1),
  num: z.number().nullish(),
  text: z.string().nullish(),
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
    if (!isRep && !(await canAccessRep(req, tid, salesRepId))) {
      res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return;
    }

    // idempotency للرفع دون اتصال — قبل أي كتابة.
    //
    // **والصفّ المُعاد للتصحيح مستثنى**: الـidempotency تحرس التكرار لا تسدّ
    // التصحيح. مندوبٌ أُعيد إليه تقريره ثم أعاد رفعه بالمفتاح نفسه كان يتلقّى
    // «تمّ» بينما لم يُكتب شيء — فيعلق التقرير في RETURNED إلى الأبد بلا مسارٍ
    // يُخرجه. وهذا حزام أمانٍ على الخادم يعمل مهما فعلت الواجهة بالمفتاح.
    if (body.clientRef) {
      const existing = await prisma.dailyReport.findFirst({ where: { tenantId: tid, clientRef: body.clientRef } });
      if (existing && existing.status !== 'RETURNED') {
        res.status(200).json({ success: true, data: existing, idempotent: true }); return;
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

    const fields = await prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true } });
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

      // قيم المندوب في المستوى 0 — تُستبدَل عند إعادة الرفع، ولا تمسّ قيم المستويات الأعلى
      await tx.dailyReportValue.deleteMany({ where: { reportId: report.id, levelSeq: 0 } });
      for (const v of body.values) {
        const f = byId.get(v.fieldId);
        if (!f) continue; // خانةٌ أُرشِفت بين فتح الشاشة والرفع — تُهمَل بلا خطأ
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

    const scope = await scopedRepRecordWhere(req);
    const tasks = await prisma.dailyReportTask.findMany({
      where: { tenantId: tid, state: 'PENDING', levelId: { in: myLevelIds } },
      include: { report: { include: { salesRep: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'asc' }, take: 200,
    });

    // التوجيه يُطبَّق بعد الاستعلام: المهمّة للمستوى، والملكية قد تكون مُشعّبة
    const mine = tasks.filter(t => {
      const rep = t.report.salesRepId;
      const eligible = ownersFor(chain.owners, chain.ownerReps, t.levelId, rep);
      return eligible.some(o => o.adminId === me);
    }).filter(t => {
      // نطاق المستخدم على المناديب (إن كان مفعّلاً) يُحترم فوق الملكية
      const w = scope as { salesRepId?: { in?: string[] } };
      return !w.salesRepId?.in || w.salesRepId.in.includes(t.report.salesRepId);
    });

    res.json({
      success: true,
      data: mine.map(t => ({
        reportId: t.reportId, levelSeq: t.levelSeq, round: t.round,
        reportDate: t.report.reportDate, status: t.report.status,
        salesRepId: t.report.salesRepId, salesRepName: t.report.salesRep.name,
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
    if (!(await canAccessRep(req, tid, report.salesRepId))) {
      res.status(404).json({ success: false, message: 'التقرير غير موجود' }); return;
    }

    const chain = await loadChain(tid);
    const fields = await prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } });
    const perm = canAct(
      { adminId: req.user!.id, role: req.user!.role },
      report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, report.salesRepId,
    );
    // الخانات التي يملؤها مستواي (مستوى ENTER)
    const myLevel = chain.levels.find(l => l.id === perm.levelId);
    const myFields = perm.allowed && myLevel?.kind === 'ENTER'
      ? fields.filter(f => f.isActive && f.fillLevelSeq === myLevel.seq)
      : [];

    res.json({
      success: true,
      data: {
        ...report,
        levels: sortLevels(chain.levels),
        canAct: perm.allowed,
        actLevelSeq: perm.levelSeq,
        actLevelName: myLevel?.name ?? null,
        actLevelKind: myLevel?.kind ?? null,
        myFields,
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
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, report.salesRepId);
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
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, report.salesRepId);
    if (!perm.allowed || perm.levelSeq === null) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const fields = await prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true, fillLevelSeq: perm.levelSeq } });
    const byId = new Map(fields.map(f => [f.id, f]));

    await prisma.$transaction(async tx => {
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
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, report.salesRepId);
    if (!perm.allowed || perm.levelSeq === null) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const level = chain.levels.find(l => l.id === perm.levelId);
    // مستوى ENTER لا يعتمد قبل أن يسجّل خاناته المطلوبة
    if (level?.kind === 'ENTER') {
      const req_ = await prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true, fillLevelSeq: level.seq, required: true } });
      for (const f of req_) {
        const v = report.values.find(x => x.fieldId === f.id && x.levelSeq === level.seq);
        const empty = !v || (v.declaredNum === null && !String(v.declaredText || '').trim());
        if (empty) { res.status(400).json({ success: false, message: `سجّل «${f.label}» قبل الاعتماد` }); return; }
      }
    }

    const tr = applyAction('APPROVE', chain.levels, perm.levelSeq, report.round);
    const nowSteps = [
      ...(report.steps as never as { action: string; actorAdminId: string | null }[]),
      { action: 'APPROVE', actorAdminId: req.user!.id },
    ];
    const distinct = countDistinctApprovers(nowSteps as never);

    await prisma.$transaction(async tx => {
      await tx.dailyReportTask.updateMany({
        where: { reportId: report.id, levelSeq: perm.levelSeq!, round: report.round, state: 'PENDING' },
        data: { state: tr.closeCurrentAs, resolvedAt: new Date() },
      });
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
    if (report.status === 'APPROVED') { res.status(409).json({ success: false, message: 'التقرير مُعتمَد ومقفول' }); return; }

    const chain = await loadChain(tid);
    const perm = canAct({ adminId: req.user!.id }, report.tasks as unknown as ChainTask[], chain.levels, chain.owners, chain.ownerReps, report.salesRepId);
    if (!perm.allowed || perm.levelSeq === null) { res.status(403).json({ success: false, message: perm.reason || 'غير مسموح' }); return; }

    const tr = applyAction('RETURN', chain.levels, perm.levelSeq, report.round);
    await prisma.$transaction(async tx => {
      await tx.dailyReportTask.updateMany({
        where: { reportId: report.id, state: 'PENDING' },
        data: { state: 'SKIPPED', resolvedAt: new Date() },
      });
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
router.use('/config', requireAdmin, requireAdminPermission('canManageCompanySettings'));

/** التهيئة كاملةً: الخانات والمستويات والملّاك والتوجيه والمناديب */
router.get('/config', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const [fields, chain, admins, reps, log] = await Promise.all([
      prisma.dailyReportField.findMany({ where: { tenantId: tid }, orderBy: [{ isActive: 'desc' }, { seq: 'asc' }] }),
      loadChain(tid),
      prisma.admin.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } }),
      prisma.salesRep.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      prisma.dailyReportConfigLog.findMany({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, take: 40 }),
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

router.post('/config/fields', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const body = fieldSchema.parse(req.body);
    const count = await prisma.dailyReportField.count({ where: { tenantId: tid } });
    const created = await prisma.$transaction(async tx => {
      const f = await tx.dailyReportField.create({
        data: {
          tenantId: tid, key: makeKey(body.label, count + 1), label: body.label,
          kind: body.kind, required: body.required, fillLevelSeq: body.fillLevelSeq ?? null,
          seq: count + 1,
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
        for (const l of shift) await tx.dailyReportLevel.update({ where: { id: l.id }, data: { seq: l.seq + 1 } });
      }
      const l = await tx.dailyReportLevel.create({
        data: { tenantId: tid, seq: at, name: body.name, kind: body.kind, quorum: body.quorum, color: body.color ?? null },
      });
      await logConfig(tx, tid, req, 'LEVEL', 'CREATE', `أضاف طبقة «${body.name}» في الموضع ${at}`, l.id, body.name);
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
    const stuck = await prisma.dailyReportTask.count({ where: { tenantId: tid, levelId: cur.id, state: 'PENDING' } });
    if (stuck) { res.status(409).json({ success: false, message: `${stuck} تقرير واقفٌ عند هذا المستوى — اعتمدها أو أعِدها أولاً` }); return; }
    await prisma.$transaction(async tx => {
      await tx.dailyReportLevel.delete({ where: { id: cur.id } });
      const rest = await tx.dailyReportLevel.findMany({ where: { tenantId: tid }, orderBy: { seq: 'asc' } });
      for (let i = 0; i < rest.length; i++) {
        if (rest[i].seq !== i + 1) await tx.dailyReportLevel.update({ where: { id: rest[i].id }, data: { seq: i + 1 } });
      }
      await logConfig(tx, tid, req, 'LEVEL', 'DELETE', `حذف المستوى «${cur.name}»`, cur.id, cur.name);
    });
    res.json({ success: true });
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

    const scope = await scopedRepRecordWhere(req);
    const scopedRepIds = (scope as { salesRepId?: { in?: string[] } }).salesRepId?.in;

    const [fields, reports] = await Promise.all([
      prisma.dailyReportField.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { seq: 'asc' } }),
      prisma.dailyReport.findMany({
        where: {
          tenantId: tid,
          reportDate: { gte: from, lte: toEff },
          ...(scopedRepIds && { salesRepId: { in: scopedRepIds } }),
        },
        include: { salesRep: { select: { id: true, name: true } }, values: true },
        orderBy: [{ salesRepId: 'asc' }, { reportDate: 'asc' }],
      }),
    ]);

    // تجميعٌ في المعالج لا استعلامٌ لكل مندوب
    const byRep = new Map<string, { salesRepId: string; salesRepName: string; days: number; approved: number; soloApproved: number; totals: Record<string, number> }>();
    for (const r of reports) {
      let row = byRep.get(r.salesRepId);
      if (!row) {
        row = { salesRepId: r.salesRepId, salesRepName: r.salesRep.name, days: 0, approved: 0, soloApproved: 0, totals: {} };
        byRep.set(r.salesRepId, row);
      }
      row.days += 1;
      if (r.status === 'APPROVED') {
        row.approved += 1;
        // «اعتمده شخص واحد» — لا يُمنع لكنه لا يُخفى
        if (r.distinctApprovers <= 1) row.soloApproved += 1;
      }
      for (const v of r.values) {
        if (v.declaredNum === null || v.declaredNum === undefined) continue;
        row.totals[v.fieldId] = (row.totals[v.fieldId] ?? 0) + v.declaredNum;
      }
    }

    res.json({
      success: true,
      data: {
        fields: fields.filter(f => f.kind !== 'TEXT'),
        rows: [...byRep.values()].sort((a, b) => a.salesRepName.localeCompare(b.salesRepName, 'ar')),
        meta: {
          from, to: toEff,
          capped, cappedNote: capped ? `المدّة قُصّت إلى ٣١ يوماً (من ${from} إلى ${toEff})` : null,
          scoped: !!scopedRepIds,
          scopedNote: scopedRepIds ? 'الإجمالي يشمل المناديب المُسنَدين لك وحدهم' : null,
        },
      },
    });
  } catch (err) { next(err); }
});

export default router;
