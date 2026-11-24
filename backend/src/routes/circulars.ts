import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId, isOwnerSession } from '../middleware/auth';
import { adminRepFilter } from '../services/adminScope';
import { AuthRequest } from '../types';
import {
  AUDIENCE_PERMISSION, CIRCULAR_LIST_MAX, CIRCULAR_MESSAGES as M, CIRCULAR_PENDING_MAX, CIRCULAR_SCOPED_SCAN, READER_KIND,
  SUPPORT_AUTHOR_NAME, CircularAudience, CircularReaderKind, ackReadAt, addressedWhere, circularClosedAt, circularTargets, isCreator,
  membersAt, parseAudience, parseCreateBody, pendingWhere, readStats, visibleToScoped,
} from '../services/circulars';
import { DEVICE_NOW_HEADER } from '../services/liveLocation';

/**
 * «التعميمات» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — مُركَّب على /api/circulars. القواعد الصافية والقرارات الموثّقة في services/circulars.ts.
 *
 * الإدارة (requireAdmin، وصلاحية الجمهور من صفّ المستخدم في القاعدة: REPS ⇐ canManageSalesReps، USERS ⇐ canManageCompanyUsers؛
 * جلسة المالك تمرّ كسائر الصلاحيات):
 *   GET  /?audience=REPS|USERS     قائمة التعميمات الأحدث أولاً (حتى ٢٠٠) بعدّادَي المستلمين والقرّاء
 *   POST /                          نشر تعميم
 *   GET  /:id/reads                 من قرأ ومن لم يقرأ
 *   POST /:id/withdraw              سحب التعميم (يختفي من «المعلّق» عند الجميع)
 * المستلم (مندوب أو مستخدم شركة — صاحب الحساب نفسه وحده):
 *   GET  /pending                   ما لم يؤكّد قراءته بعد، الأقدم أولاً — جلسة «دخول» المالك أو الموظف ومفتاح API: [] دائماً
 *   POST /:id/ack {readAt?}         «تمت القراءة» — متكرّرٌ بلا أثر؛ ٤٠٤ لتعميمٍ غير موجَّه له أو أُغلق قبل لحظة الضغط (readAt:
 *                                   لحظة الضغط على الجهاز لإقرارٍ صُفّ دون اتصال، وإلا «الآن»)؛ وجلسة الدخول والمفتاح ٤٠٣
 */
const router = Router();
router.use(authenticate);

const COMPANY_ROLES = ['ADMIN', 'MANAGER', 'ACCOUNTANT'];

type Reader = { kind: CircularReaderKind; id: string; tenantId: string };

/**
 * القارئ = صاحب الحساب نفسه. جلسة «دخول» المالك أو موظف المنصة تحمل معرّف مدير الشركة، فلو أكّدت لسُجّلت قراءته وهو لم يرها؛
 * ومفتاح API نظامٌ لا إنسان — كلاهما لا يقرأ ولا يؤكّد. ومالك المنصة والموظف خارج الشركة بلا شركة أصلاً.
 */
function readerOf(req: AuthRequest): Reader | null {
  const u = req.user;
  if (!u?.tenantId || isOwnerSession(req) || u.apiKeyId) return null;
  if (u.role === 'SALES_REP') return { kind: 'REP', id: u.id, tenantId: u.tenantId };
  if (COMPANY_ROLES.includes(u.role)) return { kind: 'ADMIN', id: u.id, tenantId: u.tenantId };
  return null;
}

/**
 * القارئ الحاليّ من القاعدة (اسمه ولحظة إضافته)، أو null إن لم يعد فعّالاً في شركته. المندوب يُفحص هنا (authenticate يتخطّاه
 * لنبضاته)، ومستخدم الشركة فحص authenticate حياته قبلنا.
 */
async function liveReader(r: Reader): Promise<{ name: string; createdAt: Date | null } | null> {
  if (r.kind === 'REP') {
    const rep = await prisma.salesRep.findFirst({ where: { id: r.id, tenantId: r.tenantId, isActive: true }, select: { name: true, createdAt: true } });
    return rep ? { name: rep.name, createdAt: rep.createdAt ?? null } : null;
  }
  const admin = await prisma.admin.findUnique({ where: { id: r.id }, select: { name: true, isActive: true, tenantId: true, createdAt: true } });
  return admin?.isActive === true && admin.tenantId === r.tenantId ? { name: admin.name, createdAt: admin.createdAt ?? null } : null;
}

// ═══════════════════ المستلم ═══════════════════

router.get('/pending', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const reader = readerOf(req);
    if (!reader || (await liveReader(reader)) === null) { res.json({ success: true, data: [] }); return; }
    const rows = await prisma.circular.findMany({
      where: pendingWhere(reader.tenantId, reader.kind, reader.id, new Date()),
      orderBy: { createdAt: 'asc' },
      take: CIRCULAR_PENDING_MAX,
      select: { id: true, title: true, body: true, createdAt: true, createdByName: true, createdByKind: true, createdById: true },
    });
    const data = rows
      .filter((c) => !isCreator(c, reader.kind, reader.id))
      .map((c) => ({ id: c.id, title: c.title, body: c.body, createdAt: c.createdAt, createdByName: c.createdByName }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

router.post('/:id/ack', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const reader = readerOf(req);
    if (!reader) { res.status(403).json({ success: false, code: 'CIRCULAR_ACK_NOT_ALLOWED', message: M.ACK_NOT_ALLOWED }); return; }
    const notFound = () => res.status(404).json({ success: false, code: 'CIRCULAR_NOT_FOUND', message: M.NOT_FOUND });
    const id = String(req.params.id || '');
    const me = await liveReader(reader);
    if (me === null) { notFound(); return; }
    // متكرّرٌ بلا أثر: تأكيدٌ سابق ⇒ نجاح ولو سُحب التعميم بعده (صندوق التطبيق دون اتصال يعيد الرفع فلا يعلق على ٤٠٤)
    const already = await prisma.circularAck.findFirst({
      where: { circularId: id, tenantId: reader.tenantId, readerKind: reader.kind, readerId: reader.id },
      select: { id: true },
    });
    if (already) { res.json({ success: true }); return; }
    // موجَّهٌ له أيّاً كانت حالته — ثم يُفحص الإغلاق بلحظة الضغط لا بلحظة الوصول
    const c = await prisma.circular.findFirst({
      where: { id, ...addressedWhere(reader.tenantId, reader.kind, reader.id) },
      select: { id: true, createdByKind: true, createdById: true, status: true, expiresAt: true, withdrawnAt: true, updatedAt: true, createdAt: true },
    });
    if (!c || isCreator(c, reader.kind, reader.id)) { notFound(); return; }
    // لحظة الضغط: ما صفّه الجهاز دون اتصال (body.readAt مصحَّحاً بانحراف ساعته) محصوراً بين نشر التعميم أو إضافة القارئ و«الآن»،
    // وإلا «الآن». ضغطةٌ قبل السحب أو الانتهاء تُقبل ولو وصلت بعده — قرأه وهو قائم؛ وما بعد الإغلاق (ومنه الإقرار الحيّ لمغلق) ٤٠٤
    const now = new Date();
    const floor = me.createdAt && me.createdAt.getTime() > c.createdAt.getTime() ? me.createdAt : c.createdAt;
    const readAt = ackReadAt({ sent: (req.body as { readAt?: unknown } | undefined)?.readAt, deviceNow: req.headers[DEVICE_NOW_HEADER], now, floor });
    const closedAt = circularClosedAt(c, now);
    if (closedAt && readAt.getTime() >= closedAt.getTime()) { notFound(); return; }
    // ON CONFLICT DO NOTHING: تأكيدان متزامنان صفٌّ واحد بلا P2002
    await prisma.circularAck.createMany({
      data: [{ circularId: c.id, tenantId: reader.tenantId, readerKind: reader.kind, readerId: reader.id, readerName: me.name, readAt }],
      skipDuplicates: true,
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═══════════════════ الإدارة ═══════════════════

/** صلاحية الجمهور من صفّ المستخدم (لا من التوكن) — جلسة المالك تمرّ، ومفتاح API يرث صلاحيات صاحبه */
async function guardAudience(req: AuthRequest, res: Response, audience: CircularAudience): Promise<boolean> {
  if (isOwnerSession(req)) return true;
  const admin = await prisma.admin.findUnique({
    where: { id: req.user!.id },
    select: { isActive: true, canManageSalesReps: true, canManageCompanyUsers: true },
  });
  if (admin?.isActive === true && admin[AUDIENCE_PERMISSION[audience]] === true) return true;
  res.status(403).json({ success: false, code: 'CIRCULAR_FORBIDDEN', message: M.FORBIDDEN });
  return false;
}

/**
 * ما يراه المدير من أعضاء الجمهور: active = المفعّلون (المعرّف ← الاسم) وهم مستلمو «الكل» ومرجع غير المقروء، وjoinedAt لحظة
 * إضافة كلٍّ منهم (يُجمَّد بها «الكل» للتعميم المغلق — membersAt)؛ وللمقيَّد النطاق (تعميمات المناديب) scopeIds = مناديب نطاقه
 * كلهم ولو معطّلين — بها تُفلتر التعميمات والتأكيدات التي يراها.
 */
type View = { restricted: boolean; scopeIds: Set<string> | null; active: Map<string, string>; joinedAt: Map<string, Date | null> };

type Member = { id: string; name: string; createdAt: Date | null };
const viewFrom = (members: Member[], restricted: boolean, scopeIds: Set<string> | null): View => ({
  restricted, scopeIds,
  active: new Map(members.map((m) => [m.id, m.name])),
  joinedAt: new Map(members.map((m) => [m.id, m.createdAt ?? null])),
});

async function viewOf(req: AuthRequest, tid: string, audience: CircularAudience): Promise<View> {
  if (audience === 'USERS') {
    const admins = await prisma.admin.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true, createdAt: true } });
    return viewFrom(admins, false, null);
  }
  const filter = await adminRepFilter(req);
  if (Object.keys(filter).length === 0) {
    const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, isActive: true }, select: { id: true, name: true, createdAt: true } });
    return viewFrom(reps, false, null);
  }
  const reps = await prisma.salesRep.findMany({ where: { tenantId: tid, ...filter }, select: { id: true, name: true, isActive: true, createdAt: true } });
  return viewFrom(reps.filter((r) => r.isActive), true, new Set(reps.map((r) => r.id)));
}

const ROW_SELECT = {
  id: true, audience: true, title: true, body: true, targetAll: true, targetIds: true, status: true,
  createdByKind: true, createdById: true, createdByName: true, expiresAt: true, withdrawnAt: true, createdAt: true, updatedAt: true,
} as const;

type CircularRecord = {
  id: string; audience: string; title: string; body: string; targetAll: boolean; targetIds: string[]; status: string;
  createdByKind: string | null; createdById: string | null; createdByName: string | null; expiresAt: Date | null;
  withdrawnAt: Date | null; createdAt: Date; updatedAt: Date;
};

/** التأكيدات التي يراها المدير: كلها لغير المقيَّد، ومناديب نطاقه وحدهم للمقيَّد */
function visibleAcks<T extends { readerId: string }>(view: View, acks: T[]): T[] {
  return view.scopeIds ? acks.filter((a) => view.scopeIds!.has(a.readerId)) : acks;
}

/**
 * مستلمو التعميم في نظر المدير: القائم من المفعّلين الآن، والمغلق (سُحب أو انتهى) ممّن وُجد منهم لحظة إغلاقه — من أُضيف بعده
 * لم يصله ولن يصله، فلا يُعدّ ولا يُسرد «لم يقرأه»
 */
function targetsOf(c: CircularRecord, view: View, now: Date): string[] {
  return circularTargets(c, membersAt(view.joinedAt, circularClosedAt(c, now)));
}

/** صفّ القائمة (CircularRow) — targetIds لا تُعاد: العدّاد يكفي، والأسماء من /:id/reads */
function toRow(c: CircularRecord, view: View, ackedIds: string[]) {
  const { readCount, targetCount } = readStats(targetsOf(c, view, new Date()), ackedIds);
  return {
    id: c.id, audience: c.audience, title: c.title, body: c.body, targetAll: c.targetAll,
    targetCount, readCount, status: c.status === 'WITHDRAWN' ? 'WITHDRAWN' : 'ACTIVE',
    createdAt: c.createdAt, createdByName: c.createdByName, expiresAt: c.expiresAt,
  };
}

/** تعميمٌ في الشركة يملك المدير جمهوره ويراه (المقيَّد: ما نشره أو ما كل مستلميه في نطاقه) — وإلا ردّ ٤٠٤/٤٠٣ وnull */
async function loadManaged(req: AuthRequest, res: Response): Promise<{ c: CircularRecord; view: View; audience: CircularAudience; tid: string } | null> {
  const tid = tenantId(req);
  const c = await prisma.circular.findFirst({ where: { id: String(req.params.id || ''), tenantId: tid }, select: ROW_SELECT });
  const audience = c ? parseAudience(c.audience) : null;
  if (!c || !audience) { res.status(404).json({ success: false, code: 'CIRCULAR_NOT_FOUND', message: M.NOT_FOUND }); return null; }
  if (!(await guardAudience(req, res, audience))) return null;
  const view = await viewOf(req, tid, audience);
  if (view.restricted && !visibleToScoped(c, req.user!.id, view.scopeIds!)) {
    res.status(404).json({ success: false, code: 'CIRCULAR_NOT_FOUND', message: M.NOT_FOUND });
    return null;
  }
  return { c, view, audience, tid };
}

router.get('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const audience = parseAudience(req.query.audience);
    if (!audience) { res.status(400).json({ success: false, code: 'CIRCULAR_AUDIENCE_INVALID', message: M.AUDIENCE_INVALID }); return; }
    if (!(await guardAudience(req, res, audience))) return;
    const tid = tenantId(req);
    const view = await viewOf(req, tid, audience);
    const me = req.user!.id;
    const rows = await prisma.circular.findMany({
      where: {
        tenantId: tid, audience,
        // المقيَّد: المرشّحون وحدهم (ما نشره، أو بمستلمين محدَّدين) ثم يُفحص النطاق في الذاكرة
        ...(view.restricted && { OR: [{ createdByKind: 'ADMIN', createdById: me }, { targetAll: false }] }),
      },
      orderBy: { createdAt: 'desc' },
      take: view.restricted ? CIRCULAR_SCOPED_SCAN : CIRCULAR_LIST_MAX,
      select: ROW_SELECT,
    });
    const shown = (view.restricted ? rows.filter((c) => visibleToScoped(c, me, view.scopeIds!)) : rows).slice(0, CIRCULAR_LIST_MAX);
    const acks = shown.length
      ? await prisma.circularAck.findMany({
        where: { tenantId: tid, circularId: { in: shown.map((c) => c.id) }, readerKind: READER_KIND[audience] },
        select: { circularId: true, readerId: true },
      })
      : [];
    const byCircular = new Map<string, string[]>();
    for (const a of visibleAcks(view, acks)) {
      const list = byCircular.get(a.circularId);
      if (list) list.push(a.readerId); else byCircular.set(a.circularId, [a.readerId]);
    }
    res.json({ success: true, data: shown.map((c) => toRow(c, view, byCircular.get(c.id) ?? [])) });
  } catch (err) { next(err); }
});

router.post('/', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = parseCreateBody(req.body, new Date());
    if (!parsed.ok) { res.status(400).json({ success: false, code: parsed.code, message: parsed.message }); return; }
    const input = parsed.data;
    if (!(await guardAudience(req, res, input.audience))) return;
    const tid = tenantId(req);
    const view = await viewOf(req, tid, input.audience);
    const owner = isOwnerSession(req);
    // الناشر: مستخدم الشركة باسمه، وجلسة «دخول» المالك أو الموظف (ومفتاحٌ أصدره الدعم الفني) باسم «الدعم الفني»
    const createdByKind = owner ? 'OWNER' : 'ADMIN';
    const createdById = owner ? (req.user!.by ?? null) : req.user!.id;
    const createdByName = owner || req.user!.ownerIssuedKey === true ? SUPPORT_AUTHOR_NAME : (req.user!.name || null);
    // الناشر لا يصله تعميمه (USERS) — يُحذف من المحدَّدين ولا يُعدّ في «الكل»
    const selfId = !owner && input.audience === 'USERS' ? req.user!.id : null;
    const recipients = [...view.active.keys()].filter((id) => id !== selfId);

    let targetAll = input.targetAll;
    let targetIds: string[] = [];
    if (input.targetAll) {
      if (recipients.length === 0) { res.status(400).json({ success: false, code: 'CIRCULAR_NO_RECIPIENTS', message: M.NO_RECIPIENTS }); return; }
      // المقيَّد النطاق: «الكل» = مناديب نطاقه المفعّلون الآن، يُحفظون قائمةً فلا يتّسع التعميم بتوسّع الشركة
      if (view.restricted) { targetAll = false; targetIds = recipients; }
    } else {
      targetIds = input.targetIds.filter((id) => id !== selfId);
      if (targetIds.length === 0) { res.status(400).json({ success: false, code: 'CIRCULAR_TARGETS_REQUIRED', message: M.TARGETS_REQUIRED }); return; }
      // كل مستلمٍ من الشركة نفسها، مفعّلٌ، وفي نطاق المقيَّد (view.active كذلك تُبنى)
      if (targetIds.some((id) => !view.active.has(id))) {
        res.status(400).json({ success: false, code: 'CIRCULAR_TARGET_INVALID', message: M.TARGET_INVALID });
        return;
      }
    }

    const created = await prisma.circular.create({
      data: {
        tenantId: tid, audience: input.audience, title: input.title, body: input.body, targetAll, targetIds,
        status: 'ACTIVE', createdByKind, createdById, createdByName, expiresAt: input.expiresAt,
      },
      select: ROW_SELECT,
    });
    res.status(201).json({ success: true, data: toRow(created, view, []) });
  } catch (err) { next(err); }
});

router.get('/:id/reads', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await loadManaged(req, res);
    if (!m) return;
    const acks = await prisma.circularAck.findMany({
      where: { tenantId: m.tid, circularId: m.c.id, readerKind: READER_KIND[m.audience] },
      orderBy: { readAt: 'asc' },
      select: { readerId: true, readerName: true, readAt: true },
    });
    const shown = visibleAcks(m.view, acks);
    const { unreadIds } = readStats(targetsOf(m.c, m.view, new Date()), shown.map((a) => a.readerId));
    res.json({
      success: true,
      data: {
        read: shown.map((a) => ({ id: a.readerId, name: a.readerName ?? m.view.active.get(a.readerId) ?? '', readAt: a.readAt })),
        unread: unreadIds
          .map((id) => ({ id, name: m.view.active.get(id) ?? '' }))
          .sort((x, y) => x.name.localeCompare(y.name, 'ar')),
      },
    });
  } catch (err) { next(err); }
});

router.post('/:id/withdraw', requireAdmin, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const m = await loadManaged(req, res);
    if (!m) return;
    // متكرّرٌ بلا أثر: المسحوب يبقى مسحوباً (بلحظة سحبه الأولى) ويُعاد صفّه
    let c: CircularRecord = m.c;
    if (c.status !== 'WITHDRAWN') {
      const withdrawnAt = new Date();
      const done = await prisma.circular.updateMany({ where: { id: c.id, tenantId: m.tid, status: 'ACTIVE' }, data: { status: 'WITHDRAWN', withdrawnAt } });
      // سحبٌ متزامن سبقنا: لحظته هو المحفوظة
      const fresh = done.count === 0 ? await prisma.circular.findFirst({ where: { id: c.id, tenantId: m.tid }, select: ROW_SELECT }) : null;
      c = fresh ?? { ...c, status: 'WITHDRAWN', withdrawnAt };
    }
    const acks = await prisma.circularAck.findMany({
      where: { tenantId: m.tid, circularId: c.id, readerKind: READER_KIND[m.audience] },
      select: { readerId: true },
    });
    const row = toRow(c, m.view, visibleAcks(m.view, acks).map((a) => a.readerId));
    res.json({ success: true, data: row });
  } catch (err) { next(err); }
});

export default router;
