import { Router, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAdmin, requireAdminPermission, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { adminScopeEnabled } from '../services/adminScope';
import { teamName } from '../services/teams';

/**
 * «الفرق» داخل الشركة (طلب المالك ١٧ أكتوبر ٢٠٢٦) — مُركَّبٌ تحت /api/company/teams (routes/company.ts).
 *
 * مطفأة افتراضياً لكل الشركات، ويفعّلها مدير الشركة من «إعدادات الشركة» (CompanySettings.teamsEnabled). الإطفاء يعيد
 * الشركة كما كانت (لا وسم ولا تقييد أصناف)، وتبقى الفرق ووسوم المستندات محفوظة لإعادة التفعيل.
 *
 * الإدارة لمستخدم الشركة الكامل بصلاحية «إعدادات الشركة» وحده — المقيَّد النطاق لا يعيد رسم الفرق التي تحكم ما يراه.
 * والحذف حذفٌ حقيقيّ ولو كان على الفريق مستندات (أمر المالك ٧ نوفمبر ٢٠٢٦: «لا نسخة مؤرشفة ولا مخفية»): المستندات المالية
 * لا تُحذف أبداً بل يُفرَّغ وسمها فتبقى «بلا فريق»، والأرشفة (isActive=false) خيارٌ صريحٌ منفصل لمن أراد بقاءه في التقارير.
 */
const router = Router();
router.use(requireAdmin);

/** إدارة الفرق: صلاحية إعدادات الشركة، وغير مقيَّد النطاق (جلسة المالك تمرّ) */
async function guardManage(req: AuthRequest, res: Response): Promise<boolean> {
  if (await adminScopeEnabled(req)) {
    res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد إدارة الفرق تحتاج صلاحية غير مقيدة' });
    return false;
  }
  return true;
}
const managePerm = requireAdminPermission('canManageCompanySettings');

// حالة الميزة للشركة
router.get('/settings', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const s = await prisma.companySettings.findUnique({ where: { tenantId: tenantId(req) }, select: { teamsEnabled: true } });
    res.json({ success: true, data: { enabled: s?.teamsEnabled === true } });
  } catch (err) { next(err); }
});

// تفعيل/إطفاء الفرق للشركة — الإطفاء لا يحذف شيئاً
router.patch('/settings', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await prisma.companySettings.update({ where: { tenantId: tenantId(req) }, data: { teamsEnabled: enabled } });
    res.json({ success: true, data: { enabled } });
  } catch (err) { next(err); }
});

// الفرق بأعضائها وأصنافها — والمقيَّد يرى ما يشرف عليه وحده
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const restricted = await adminScopeEnabled(req);
    const teams = await prisma.team.findMany({
      where: { tenantId: tid, ...(restricted && { supervisors: { some: { adminId: req.user!.id } } }) },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true, name: true, isActive: true, createdAt: true,
        members: { select: { salesRepId: true, salesRep: { select: { name: true, isActive: true } } } },
        products: { select: { productId: true } },
        supervisors: { select: { adminId: true, admin: { select: { name: true, scopeEnabled: true, scopeMode: true } } } },
        _count: { select: { invoices: true, receipts: true, visits: true, settlements: true } },
      },
    });
    res.json({
      success: true,
      data: teams.map((t) => ({
        id: t.id, name: t.name, isActive: t.isActive, createdAt: t.createdAt,
        members: t.members.map((m) => ({ salesRepId: m.salesRepId, name: m.salesRep.name, isActive: m.salesRep.isActive })),
        productIds: t.products.map((p) => p.productId),
        supervisors: t.supervisors.map((s) => ({
          adminId: s.adminId, name: s.admin.name,
          // مقيّدٌ بفرقه فعلاً؟ (مشرفٌ عُيّن ثم فُكّ تقييده من «مستخدمو الشركة» يرى الشركة كلها)
          teamScoped: s.admin.scopeEnabled === true && s.admin.scopeMode === 'TEAMS',
        })),
        docsCount: t._count.invoices + t._count.receipts + t._count.visits + t._count.settlements,
      })),
    });
  } catch (err) { next(err); }
});

const nameSchema = z.string().trim().min(1, 'اكتب اسم الفريق').max(60);

/** مشرفو فرقٍ لم يبقَ لهم فريق: قوائم يدوية مقيّدة (لا تُفكّ — ما لم يُحدَّد له أحد لا يرى شيئاً). db: معاملة الحذف إن وُجدت */
async function demoteOrphanSupervisors(tid: string, adminIds: string[], db: Prisma.TransactionClient = prisma): Promise<void> {
  if (!adminIds.length) return;
  const still = new Set((await db.teamSupervisor.findMany({ where: { adminId: { in: adminIds } }, select: { adminId: true } })).map((s) => s.adminId));
  const orphans = adminIds.filter((id) => !still.has(id));
  if (orphans.length) await db.admin.updateMany({ where: { id: { in: orphans }, tenantId: tid, scopeMode: 'TEAMS' }, data: { scopeMode: 'LISTS' } });
}

router.post('/', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const name = teamName(nameSchema.parse(req.body?.name));
    if (await prisma.team.findFirst({ where: { tenantId: tid, name }, select: { id: true } })) {
      res.status(409).json({ success: false, message: 'يوجد فريق بهذا الاسم' }); return;
    }
    const team = await prisma.team.create({ data: { tenantId: tid, name }, select: { id: true, name: true, isActive: true } });
    res.status(201).json({ success: true, data: team });
  } catch (err) { next(err); }
});

// إعادة التسمية أو الأرشفة/الاستعادة
router.put('/:id', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const body = z.object({ name: nameSchema.optional(), isActive: z.boolean().optional() }).parse(req.body);
    const team = await prisma.team.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true } });
    if (!team) { res.status(404).json({ success: false, message: 'الفريق غير موجود' }); return; }
    const name = body.name !== undefined ? teamName(body.name) : undefined;
    if (name && await prisma.team.findFirst({ where: { tenantId: tid, name, id: { not: team.id } }, select: { id: true } })) {
      res.status(409).json({ success: false, message: 'يوجد فريق بهذا الاسم' }); return;
    }
    const updated = await prisma.team.update({
      where: { id: team.id },
      data: { ...(name !== undefined && { name }), ...(body.isActive !== undefined && { isActive: body.isActive }) },
      select: { id: true, name: true, isActive: true },
    });
    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
});

/**
 * حذفٌ حقيقيّ ولو كان على الفريق مستندات (أمر المالك ٧ نوفمبر ٢٠٢٦: «أي حذف حذفٌ فعليّ — لا نسخة مؤرشفة ولا مخفية»)، في معاملةٍ واحدة:
 *  ١. يُفرَّغ وسم الفريق عن كل صفٍّ يشير إليه اختيارياً (schema.prisma: Invoice وReceipt وRepVisit وRepSettlement) — المستند
 *     الماليّ لا يُحذف أبداً، فيبقى بمبلغه وعميله ومندوبه «بلا فريق» في التقارير. والتفريغ صريحٌ لا اتّكالاً على SetNull في
 *     القاعدة: يحرّك updatedAt فتلتقط مزامنة /api/v1/sync تغيّر teamId.
 *  ٢. تُحذف إعداداته الصرفة: عضويات المناديب ومشرفوه وأصنافه الخاصة (وطابع تلك الأصناف ليرى المزامِن أنها صارت عامة أو لفرقٍ أخرى).
 *  ٣. يُحذف الفريق نفسه، ومن فقد آخر فريقٍ يشرف عليه يعود لقوائمه اليدوية مقيّداً (فشلٌ مغلق).
 */
router.delete('/:id', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const untagged = await prisma.$transaction(async (tx) => {
      const team = await tx.team.findFirst({
        where: { id: req.params.id, tenantId: tid },
        select: { id: true, supervisors: { select: { adminId: true } }, products: { select: { productId: true } } },
      });
      if (!team) return null;
      const tagged = { tenantId: tid, teamId: team.id };
      const invoices = (await tx.invoice.updateMany({ where: tagged, data: { teamId: null } })).count;
      const receipts = (await tx.receipt.updateMany({ where: tagged, data: { teamId: null } })).count;
      const visits = (await tx.repVisit.updateMany({ where: tagged, data: { teamId: null } })).count;
      const settlements = (await tx.repSettlement.updateMany({ where: tagged, data: { teamId: null } })).count;
      await tx.teamMember.deleteMany({ where: { teamId: team.id } });
      await tx.teamSupervisor.deleteMany({ where: { teamId: team.id } });
      await tx.productTeam.deleteMany({ where: { teamId: team.id } });
      const productIds = team.products.map((p) => p.productId);
      if (productIds.length) await tx.product.updateMany({ where: { id: { in: productIds }, tenantId: tid }, data: { updatedAt: new Date() } });
      // deleteMany لا delete: حذفٌ متزامنٌ سبقنا ⇒ 404 لا P2025 بـ500
      if ((await tx.team.deleteMany({ where: { id: team.id, tenantId: tid } })).count === 0) return null;
      await demoteOrphanSupervisors(tid, team.supervisors.map((s) => s.adminId), tx);
      return { invoices, receipts, visits, settlements };
    }, { maxWait: 10_000, timeout: 60_000 });
    if (!untagged) { res.status(404).json({ success: false, message: 'الفريق غير موجود' }); return; }
    res.json({ success: true, data: { untagged } });
  } catch (err) { next(err); }
});

/** القائمة الكاملة بعد التعديل ⇒ إضافاتٌ وإزالات (تفاضليّ لا مسحٌ وإعادة — درس AssignCustomersModal) */
function diff(current: string[], wanted: string[]) {
  const cur = new Set(current), want = new Set(wanted);
  return { add: [...want].filter((x) => !cur.has(x)), remove: [...cur].filter((x) => !want.has(x)) };
}
const idsSchema = z.array(z.string().min(1)).max(5000);

// مناديب الفريق — المندوب قد يكون في أكثر من فريق
router.put('/:id/members', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const salesRepIds = [...new Set(idsSchema.parse(req.body?.salesRepIds))];
    const team = await prisma.team.findFirst({
      where: { id: req.params.id, tenantId: tid }, select: { id: true, members: { select: { salesRepId: true } } },
    });
    if (!team) { res.status(404).json({ success: false, message: 'الفريق غير موجود' }); return; }
    if (salesRepIds.length && await prisma.salesRep.count({ where: { id: { in: salesRepIds }, tenantId: tid } }) !== salesRepIds.length) {
      res.status(400).json({ success: false, message: 'أحد المناديب غير موجود' }); return;
    }
    const { add, remove } = diff(team.members.map((m) => m.salesRepId), salesRepIds);
    await prisma.$transaction([
      ...(remove.length ? [prisma.teamMember.deleteMany({ where: { teamId: team.id, salesRepId: { in: remove } } })] : []),
      ...(add.length ? [prisma.teamMember.createMany({ data: add.map((salesRepId) => ({ tenantId: tid, teamId: team.id, salesRepId })), skipDuplicates: true })] : []),
      prisma.team.update({ where: { id: team.id }, data: { updatedAt: new Date() } }),
    ]);
    res.json({ success: true, data: { added: add.length, removed: remove.length } });
  } catch (err) { next(err); }
});

// أصناف الفريق الخاصة — الصنف قد يُسند لأكثر من فريق، والصنف بلا فرق عامٌّ للجميع
router.put('/:id/products', managePerm, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const productIds = [...new Set(idsSchema.parse(req.body?.productIds))];
    const team = await prisma.team.findFirst({
      where: { id: req.params.id, tenantId: tid }, select: { id: true, products: { select: { productId: true } } },
    });
    if (!team) { res.status(404).json({ success: false, message: 'الفريق غير موجود' }); return; }
    if (productIds.length && await prisma.product.count({ where: { id: { in: productIds }, tenantId: tid } }) !== productIds.length) {
      res.status(400).json({ success: false, message: 'أحد الأصناف غير موجود' }); return;
    }
    const { add, remove } = diff(team.products.map((p) => p.productId), productIds);
    await prisma.$transaction([
      ...(remove.length ? [prisma.productTeam.deleteMany({ where: { teamId: team.id, productId: { in: remove } } })] : []),
      ...(add.length ? [prisma.productTeam.createMany({ data: add.map((productId) => ({ tenantId: tid, teamId: team.id, productId })), skipDuplicates: true })] : []),
      // طابع الأصناف المتغيّرة: المزامنة (/api/v1/sync وERP) ترى تغيّر فرقها
      ...([...add, ...remove].length ? [prisma.product.updateMany({ where: { id: { in: [...add, ...remove] }, tenantId: tid }, data: { updatedAt: new Date() } })] : []),
    ]);
    res.json({ success: true, data: { added: add.length, removed: remove.length } });
  } catch (err) { next(err); }
});

/**
 * مشرفو الفريق — مستخدمو شركة يرون فرقهم وحدها: المشرف المضاف يُقيَّد بنطاق «فرق» (scopeEnabled + scopeMode=TEAMS):
 * مناديب فرقه، وما وُسم بفرقه من فواتير وسندات وزيارات، وكل العملاء (قرار المالك: العملاء مشتركون).
 *
 * كتابة النطاق تحتاج صلاحية «مستخدمو الشركة» فوق «إعدادات الشركة» (كمسار نطاق المستخدم)، ومن غير مقيّد. ومدير الشركة
 * (دور ADMIN) لا يكون مشرفاً — لا يُقيَّد صاحب الحساب. والإزالة لا تفكّ التقييد: مشرفٌ بلا فرق لا يرى شيئاً حتى يُضاف
 * لفريق أو يُفكّ تقييده من «مستخدمو الشركة» — فشلٌ مغلق لا رؤيةٌ كاملة مفاجئة.
 */
router.put('/:id/supervisors', managePerm, requireAdminPermission('canManageCompanyUsers'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // كتابة نطاق مستخدمي الشركة: مفاتيح API ممنوعة منها (كمسارات /company-users)
    if (req.user?.apiKeyId) { res.status(403).json({ success: false, code: 'API_KEY_FORBIDDEN', message: 'هذا الإجراء غير متاح بمفتاح API' }); return; }
    if (!(await guardManage(req, res))) return;
    const tid = tenantId(req);
    const adminIds = [...new Set(idsSchema.parse(req.body?.adminIds))];
    const team = await prisma.team.findFirst({
      where: { id: req.params.id, tenantId: tid }, select: { id: true, supervisors: { select: { adminId: true } } },
    });
    if (!team) { res.status(404).json({ success: false, message: 'الفريق غير موجود' }); return; }
    const admins = adminIds.length
      ? await prisma.admin.findMany({ where: { id: { in: adminIds }, tenantId: tid }, select: { id: true, role: true } })
      : [];
    if (admins.length !== adminIds.length) { res.status(400).json({ success: false, message: 'أحد المستخدمين غير موجود' }); return; }
    const { add, remove } = diff(team.supervisors.map((s) => s.adminId), adminIds);
    // المضافون وحدهم: مشرفٌ رُقّي لاحقاً إلى مدير يبقى قابلاً للإزالة لا يُجمِّد حفظ الفريق
    if (admins.some((a) => a.role === 'ADMIN' && add.includes(a.id))) {
      res.status(400).json({ success: false, code: 'SUPERVISOR_IS_ADMIN', message: 'مدير الشركة لا يكون مشرف فريق — اجعل المشرف بدور «مشرف» أو «محاسب»' });
      return;
    }
    await prisma.$transaction([
      ...(remove.length ? [prisma.teamSupervisor.deleteMany({ where: { teamId: team.id, adminId: { in: remove } } })] : []),
      ...(add.length ? [prisma.teamSupervisor.createMany({ data: add.map((adminId) => ({ tenantId: tid, teamId: team.id, adminId })), skipDuplicates: true })] : []),
      // المضاف يُقيَّد بفرقه — يسري فوراً (النطاق يُقرأ من القاعدة لا من التوكن)
      ...(add.length ? [prisma.admin.updateMany({ where: { id: { in: add }, tenantId: tid, role: { not: 'ADMIN' } }, data: { scopeEnabled: true, scopeMode: 'TEAMS' } })] : []),
      prisma.team.update({ where: { id: team.id }, data: { updatedAt: new Date() } }),
    ]);
    // من فقد آخر فريقٍ يشرف عليه يعود لقوائمه اليدوية مقيّداً — فشلٌ مغلق (مشرفٌ بلا فرق كان يرى كل العملاء)
    if (remove.length) await demoteOrphanSupervisors(tid, remove);
    res.json({ success: true, data: { added: add.length, removed: remove.length } });
  } catch (err) { next(err); }
});

export default router;
