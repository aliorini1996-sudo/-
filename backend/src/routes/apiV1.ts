import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';
import { API_KEY_RATE_PER_MINUTE } from '../services/apiKeys';
import {
  SYNC_RESOURCES, syncResource, cursorColumn, clampLimit, encodeCursor, decodeCursor, parseSince,
  tenantWhere, sinceWhere, afterCursorWhere, orderByFor, shapeRow, selectFor, SyncResource,
  SYNC_DEFAULT_LIMIT, SYNC_MAX_LIMIT, IDS_MAX_LIMIT,
} from '../services/apiSync';

/**
 * /api/v1 — مسارات المزامنة لمفاتيح «الربط البرمجي API» (services/apiSync.ts).
 * للمفاتيح وحدها: جلسة اللوحة لا تحتاجها، وحصرها يُبقي حدّها وحسابها على المفتاح.
 */
const router = Router();
router.use(authenticate);
router.use((req: AuthRequest, res: Response, next: NextFunction) => {
  if (!req.user?.apiKeyId) {
    res.status(403).json({ success: false, code: 'API_KEY_REQUIRED', message: 'هذه المسارات تعمل بمفتاح API فقط' });
    return;
  }
  next();
});

interface Refusal { status: number; code: string; message: string }

/**
 * حكم المورد لصاحب المفتاح — كما تحكم صفحته في اللوحة: صلاحيته، وعدم تقييد نطاقه (المزامنة تعطي
 * الشركة كاملة فلا تُعطى لمن يرى بعضها)، والنظام المحاسبي ومخزون الشركة. يُقرأ كله من القاعدة في
 * كل طلب، فسحب صلاحية من صاحب المفتاح يسري على مفتاحه في الحال.
 *
 * ومعه عَلَم «تتبّع اللوط» مقروءاً في الاستعلام نفسه (§١٠.١: لا استعلام زائد) — به تُضمّ أعمدة اللوط على الموارد القائمة
 * (selectFor)، و`=== true` وحده يضمّها فتعذّر القراءة يُبقي الشكل القديم.
 */
async function resourceGate(req: AuthRequest, def: SyncResource): Promise<{ refusal: Refusal | null; lotsOn: boolean }> {
  const tid = tenantId(req);
  const [admin, tenant] = await Promise.all([
    prisma.admin.findUnique({ where: { id: req.user!.id }, select: { isActive: true, scopeEnabled: true, [def.permission]: true } as Record<string, true> }),
    prisma.tenant.findUnique({ where: { id: tid }, select: { accountingEnabled: true, warehouseEnabled: true, locationsEnabled: true, lotTrackingEnabled: true } }),
  ]);
  const lotsOn = tenant?.lotTrackingEnabled === true;
  const refuse = (r: Refusal) => ({ refusal: r, lotsOn });
  const a = admin as Record<string, unknown> | null;
  if (!a || a.isActive !== true) return refuse({ status: 401, code: 'API_KEY_OWNER_INACTIVE', message: 'حساب المستخدم صاحب المفتاح معطل' });
  if (a.scopeEnabled === true) return refuse({ status: 403, code: 'API_KEY_SCOPED_OWNER', message: 'صاحب المفتاح مقيد بنطاق محدد والمزامنة تعطي بيانات الشركة كاملة' });
  if (a[def.permission] === false) return refuse({ status: 403, code: 'FORBIDDEN', message: 'صاحب المفتاح لا يملك صلاحية هذا القسم' });
  if (def.accounting && tenant?.accountingEnabled === false) return refuse({ status: 403, code: 'ACCOUNTING_DISABLED', message: 'النظام المحاسبي غير مفعل لشركتك' });
  if (def.warehouse && tenant?.warehouseEnabled !== true) return refuse({ status: 403, code: 'WAREHOUSE_DISABLED', message: 'ميزة مخزون الشركة غير مفعلة لشركتك' });
  // «لوكيشن» بترتيب حارس صفحتها (requireLocations): المحاسبة أعلاه ثم العَلَم — `!== true` فتعذّر القراءة يمنع لا يفتح
  if (def.locations && tenant?.locationsEnabled !== true) return refuse({ status: 403, code: 'LOCATIONS_DISABLED', message: 'ميزة لوكيشن غير مفعلة لشركتك' });
  // «تتبّع اللوط» بترتيب requireLots: المحاسبة أعلاه ثم العَلَم — والمطفأ أو غير المقروء يمنع (§٥.٣، D8)
  if (def.lots && !lotsOn) return refuse({ status: 403, code: 'LOTS_DISABLED', message: 'ميزة تتبع LOT غير مفعلة لشركتك' });
  return { refusal: null, lotsOn };
}

/**
 * موارد الشركة كما تُعلَن في /me وفي قائمة UNKNOWN_RESOURCE: موارد «تتبّع اللوط» للشركة المفعّلة وحدها، فالمطفأة تبقى بقائمتها
 * القديمة حرفياً (§١٠.١، D8 يُخفي) — `=== true` وحده يُظهرها. وموارد الميزات الأقدم (المستودع ولوكيشن) تُعلَن لكل شركة كما كانت.
 */
const listedResources = (lotsOn: boolean) => SYNC_RESOURCES.filter(r => !r.lots || lotsOn);

/** مورد مجهول: 404 بقائمة الموارد. مسار خطأٍ نادر، فقراءة العَلَم فيه لا تمسّ مساراً ساخناً، وتعذّرها يُبقي القائمة القديمة لا 500 */
async function unknown(req: AuthRequest, res: Response, name: string): Promise<void> {
  const lotsOn = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { lotTrackingEnabled: true } })
    .then((t) => t?.lotTrackingEnabled === true, () => false);
  res.status(404).json({
    success: false, code: 'UNKNOWN_RESOURCE', message: `مورد غير معروف ${name}`, resources: listedResources(lotsOn).map(r => r.name),
  });
}

router.get('/me', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // عَلَم «تتبّع اللوط» من شركة المفتاح في الاستعلام نفسه (§١٠.١: لا استعلام زائد)
    const key = await prisma.apiKey.findUnique({
      where: { id: req.user!.apiKeyId! },
      select: { name: true, prefix: true, readOnly: true, createdAt: true, tenant: { select: { name: true, lotTrackingEnabled: true } }, admin: { select: { name: true } } },
    });
    res.json({
      success: true,
      data: {
        company: key?.tenant.name ?? null,
        key: key ? { name: key.name, prefix: key.prefix, readOnly: key.readOnly, createdAt: key.createdAt, actsAs: key.admin.name } : null,
        ratePerMinute: API_KEY_RATE_PER_MINUTE,
        serverTime: new Date().toISOString(),
        resources: listedResources(key?.tenant.lotTrackingEnabled === true).map(r => ({ name: r.name, mode: r.mode, hardDeletes: r.hardDeletes })),
      },
    });
  } catch (err) { next(err); }
});

router.get('/sync/:resource', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const def = syncResource(String(req.params.resource));
    if (!def) { await unknown(req, res, String(req.params.resource)); return; }
    const { refusal, lotsOn } = await resourceGate(req, def);
    if (refusal) { res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message }); return; }

    const since = parseSince(req.query.since);
    if (since === 'invalid') { res.status(400).json({ success: false, code: 'BAD_SINCE', message: 'since يجب أن يكون تاريخا بصيغة ISO-8601' }); return; }
    const cursor = decodeCursor(req.query.cursor, def.name);
    if (cursor === 'invalid') { res.status(400).json({ success: false, code: 'BAD_CURSOR', message: 'cursor غير صالح لهذا المورد' }); return; }
    const limit = clampLimit(req.query.limit, SYNC_DEFAULT_LIMIT, SYNC_MAX_LIMIT);

    // وقت الخادم قبل القراءة — هو ما يُبنى عليه since التالي (لا وقت انتهاء القراءة)
    const serverTime = new Date().toISOString();
    const col = cursorColumn(def);
    const where = { AND: [tenantWhere(def, tenantId(req)), sinceWhere(def, since), afterCursorWhere(def, cursor)].filter(Boolean) };
    const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[def.model];
    const rows = await delegate.findMany({ where, orderBy: orderByFor(def), take: limit + 1, select: { ...selectFor(def, lotsOn), id: true, ...(col === 'id' ? {} : { [col]: true }) } });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? encodeCursor({ r: def.name, t: col === 'id' ? null : new Date(last[col] as string | Date).toISOString(), i: String(last.id) })
      : null;
    res.json({ success: true, resource: def.name, mode: def.mode, serverTime, hasMore, nextCursor, data: page.map(r => shapeRow(def, r)) });
  } catch (err) { next(err); }
});

/** كل المعرّفات الحالية للمورد — يطابق بها نظام الشركة ما حُذف حذفاً فعلياً (ما عنده وليس هنا) */
router.get('/sync/:resource/ids', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const def = syncResource(String(req.params.resource));
    if (!def) { await unknown(req, res, String(req.params.resource)); return; }
    const { refusal } = await resourceGate(req, def);
    if (refusal) { res.status(refusal.status).json({ success: false, code: refusal.code, message: refusal.message }); return; }
    const tag = `${def.name}:ids`;
    const cursor = decodeCursor(req.query.cursor, tag);
    if (cursor === 'invalid') { res.status(400).json({ success: false, code: 'BAD_CURSOR', message: 'cursor غير صالح لهذا المورد' }); return; }
    const limit = clampLimit(req.query.limit, 1000, IDS_MAX_LIMIT);
    const delegate = (prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<{ id: string }[]> }>)[def.model];
    const rows = await delegate.findMany({
      where: { AND: [tenantWhere(def, tenantId(req)), cursor ? { id: { gt: cursor.i } } : null].filter(Boolean) },
      orderBy: { id: 'asc' }, take: limit + 1, select: { id: true },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    res.json({
      success: true, resource: def.name, hasMore,
      nextCursor: hasMore && last ? encodeCursor({ r: tag, t: null, i: last.id }) : null,
      ids: page.map(r => r.id),
    });
  } catch (err) { next(err); }
});

// مسار غير معروف تحت /api/v1 — JSON لا صفحة HTML، ولا يسقط إلى موجّهات أخرى
router.use((_req: AuthRequest, res: Response) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'مسار غير موجود' });
});

export default router;
