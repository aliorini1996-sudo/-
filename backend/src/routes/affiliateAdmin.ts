/**
 * لوحة المالك لبرنامج السفراء — `/api/affiliate-admin` (SUPER_ADMIN فقط).
 * الأشكال في docs/affiliate/API.md §2، والمنطق المالي كلّه في services/affiliate/ledger.ts.
 *
 * المنصّة لا تحرّك مالاً: «إنشاء دفعة» يجمّع البنود، والمالك يحوّل من البنك
 * بنفسه، ثم «تسجيل» يثبت المرجع ويقلب العمولات مدفوعة.
 */
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  getSettings, logEvent, logEventSafe, decryptIban, isUniqueViolation, riyadhDay, DEFAULT_TERMS_VERSION, DEFAULT_SETTINGS,
  BUILTIN_TERMS_VERSIONS, builtinTermsBody,
  TERMS_RULE_KEYS, TERMS_RULE_RANGES, TermsRuleKey, parseTermsRules, pickRules, rulesFor,
} from '../services/affiliate/core';
import { canTransition, normCompanyName, normCR } from '../services/affiliate/rules';
import {
  LedgerError, reconcile, approveCommission, holdCommission, releaseCommission, declineCommission,
  createOwnerAttribution, voidAttribution, activateAttribution, linkClaimToTenant,
  payoutCandidates, createPayout, recordPayout, voidPayout, expireStaleClaims, reassignAttribution, adjustAttributionWindow,
  AccrueResult,
} from '../services/affiliate/ledger';
import { mailDecision, mailPayoutRecorded } from '../services/affiliate/mail';

const router = Router();
router.use(authenticate, requireSuperAdmin);

const owner = (req: AuthRequest) => req.user!.id;
const reasonBody = z.object({ reason: z.string().trim().min(3, 'اذكر السبب').max(500) });
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const riyadhDate = (s: string) => new Date(`${s}T00:00:00+03:00`);

/** أخطاء الدفتر تحمل حالتها ورسالتها — والباقي لمعالج الأخطاء العام */
function handle(fn: (req: AuthRequest, res: Response) => Promise<void>) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try { await fn(req, res); } catch (e) {
      if (e instanceof LedgerError) { res.status(e.status).json({ success: false, message: e.message, code: e.code }); return; }
      next(e);
    }
  };
}

// ───────────────────────────── نظرة عامة ─────────────────────────────

router.get('/overview', handle(async (_req, res) => {
  await reconcile().catch(e => console.error('[affiliate] reconcile:', (e as Error).message));
  await expireStaleClaims();
  const now = new Date();
  const [users, claimsUnderReview, attrs, comms, ready, candidates] = await Promise.all([
    prisma.affiliateUser.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.affiliateClaim.count({ where: { status: 'under_review' } }),
    prisma.tenantAttribution.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.affiliateCommission.groupBy({ by: ['status'], _sum: { commissionHalalas: true } }),
    prisma.affiliateCommission.count({ where: { status: 'pending', eligibleAt: { lte: now } } }),
    payoutCandidates(),
  ]);
  const uc = (s: string) => users.find(u => u.status === s)?._count._all ?? 0;
  const ac = (s: string) => attrs.find(a => a.status === s)?._count._all ?? 0;
  const cs = (s: string) => comms.find(c => c.status === s)?._sum.commissionHalalas ?? 0;
  const approvedUnpaid = await prisma.affiliateCommission.aggregate({ where: { status: 'approved' }, _sum: { commissionHalalas: true } });
  res.json({ success: true, data: {
    affiliates: { pending_review: uc('pending_review'), approved: uc('approved'), suspended: uc('suspended'), total: users.reduce((s, u) => s + u._count._all, 0) },
    claimsUnderReview,
    attributions: { active: ac('active'), disputed: ac('disputed') },
    commissions: { pendingHalalas: cs('pending'), onHoldHalalas: cs('on_hold'), readyToApprove: ready, approvedUnpaidHalalas: approvedUnpaid._sum.commissionHalalas ?? 0, paidHalalas: cs('paid') },
    payoutCandidates: candidates.filter(c => c.eligible).length,
  } });
}));

// ───────────────────────────── الإعدادات والشروط ─────────────────────────────

router.get('/settings', handle(async (_req, res) => {
  const row = await prisma.affiliateSettings.findUnique({ where: { id: 'global' } });
  res.json({ success: true, data: { ...(await getSettings()), updatedBy: row?.updatedBy ?? null, updatedAt: row?.updatedAt ?? null } });
}));

const ruleNumber = (k: TermsRuleKey) => z.number().int().min(TERMS_RULE_RANGES[k][0]).max(TERMS_RULE_RANGES[k][1]);
const rulesSchema = z.object(Object.fromEntries(TERMS_RULE_KEYS.map(k => [k, ruleNumber(k).optional()])) as Record<TermsRuleKey, z.ZodOptional<z.ZodNumber>>);

/**
 * الإعدادات التشغيلية فقط. القيم الماليّة تنصّ عليها الشروط، فتغييرها هنا كان
 * سيطبّق على سفيرٍ ما لم يقبله (الشروط §٧) — مكانها نشر إصدارٍ جديد.
 */
router.put('/settings', handle(async (req, res) => {
  const b = z.object({
    intakeOpen: z.boolean().optional(),
    disclosureText: z.string().trim().min(10, 'نصّ الإفصاح ١٠ أحرف على الأقل').max(300).optional(),
  }).merge(rulesSchema).parse(req.body);
  const before = await getSettings();
  const changedRules = TERMS_RULE_KEYS.filter(k => b[k] !== undefined && b[k] !== before[k]);
  if (changedRules.length) throw new LedgerError(409, 'النسبة والحجز والحدود جزءٌ من الشروط — تتغيّر بنشر إصدارٍ جديد من الشروط', 'terms_bound');
  const ops = { ...(b.intakeOpen !== undefined ? { intakeOpen: b.intakeOpen } : {}), ...(b.disclosureText !== undefined ? { disclosureText: b.disclosureText } : {}) };
  const row = await prisma.affiliateSettings.upsert({
    where: { id: 'global' },
    create: { id: 'global', ...before, ...ops, updatedBy: owner(req) },
    update: { ...ops, updatedBy: owner(req) },
  });
  logEventSafe({ entity: 'settings', entityId: 'global', action: 'updated', actorType: 'owner', actorId: owner(req), meta: { changes: { ...ops } } });
  res.json({ success: true, data: row });
}));

router.get('/terms', handle(async (_req, res) => {
  const rows = await prisma.affiliateTerms.findMany({ orderBy: { publishedAt: 'desc' } });
  const defaults = pickRules(DEFAULT_SETTINGS);
  const list = rows.map(t => ({ version: t.version, body: t.body, publishedAt: t.publishedAt, publishedBy: t.publishedBy, rules: parseTermsRules(t.rulesJson, defaults) }));
  for (const v of [...BUILTIN_TERMS_VERSIONS].reverse()) {
    if (!rows.some(r => r.version === v)) list.push({ version: v, body: builtinTermsBody(v) ?? '', publishedAt: new Date('2026-09-13T00:00:00Z'), publishedBy: 'system', rules: defaults });
  }
  res.json({ success: true, data: list });
}));

router.post('/terms', handle(async (req, res) => {
  const b = z.object({
    version: z.string().regex(/^[\w.-]{3,40}$/, 'رمز الإصدار: حروف لاتينية وأرقام و . - _'),
    body: z.string().trim().min(50).max(50_000),
    rules: rulesSchema.optional(),
  }).parse(req.body);
  if ((BUILTIN_TERMS_VERSIONS as readonly string[]).includes(b.version)) throw new LedgerError(409, 'هذا الإصدار موجود');
  const settings = await getSettings();
  // القواعد والنصّ يُنشران معاً في معاملةٍ واحدة — لا لحظة يسري فيها أحدهما دون الآخر
  const rules = { ...pickRules(settings), ...Object.fromEntries(Object.entries(b.rules ?? {}).filter(([, v]) => v !== undefined)) };
  try {
    const t = await prisma.$transaction(async tx => {
      const row = await tx.affiliateTerms.create({ data: { version: b.version, body: b.body, rulesJson: rules, publishedBy: owner(req) } });
      await tx.affiliateSettings.upsert({
        where: { id: 'global' },
        create: { id: 'global', ...settings, ...rules, currentTermsVersion: b.version, updatedBy: owner(req) },
        update: { ...rules, currentTermsVersion: b.version, updatedBy: owner(req) },
      });
      await logEvent(tx, { entity: 'terms', entityId: b.version, action: 'published', actorType: 'owner', actorId: owner(req), meta: { previous: settings.currentTermsVersion, rules } });
      return row;
    });
    res.json({ success: true, data: t });
  } catch (e) {
    if (isUniqueViolation(e)) throw new LedgerError(409, 'هذا الإصدار موجود');
    throw e;
  }
}));

// ───────────────────────────── السفراء ─────────────────────────────

async function earnings(affiliateIds: string[]) {
  if (!affiliateIds.length) return new Map<string, { earned: number; paid: number }>();
  const rows = await prisma.affiliateCommission.groupBy({ by: ['affiliateId', 'status'], where: { affiliateId: { in: affiliateIds } }, _sum: { commissionHalalas: true } });
  const m = new Map<string, { earned: number; paid: number }>();
  for (const r of rows) {
    const e = m.get(r.affiliateId) ?? { earned: 0, paid: 0 };
    const v = r._sum.commissionHalalas ?? 0;
    if (['pending', 'on_hold', 'approved', 'paid'].includes(r.status)) e.earned += v;
    if (r.status === 'paid') e.paid += v;
    m.set(r.affiliateId, e);
  }
  return m;
}

type UserWithCounts = Awaited<ReturnType<typeof listUsers>>[number];
function listUsers(where: object) {
  return prisma.affiliateUser.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 500,
    include: { _count: { select: { claims: true, attributions: true, commissions: true } } },
  });
}

function userRow(u: UserWithCounts, e?: { earned: number; paid: number }) {
  return {
    id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, city: u.city, code: u.code, status: u.status,
    statusReason: u.statusReason, publicPromoter: u.publicPromoter, mawthooqNo: u.mawthooqNo,
    mawthooqExpiry: u.mawthooqExpiry ? riyadhDay(u.mawthooqExpiry) : null, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    counts: u._count, earnedHalalas: e?.earned ?? 0, paidHalalas: e?.paid ?? 0, hasPayout: !!u.ibanEnc,
  };
}

router.get('/affiliates', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const users = await listUsers({
    ...(status ? { status } : {}),
    ...(q ? { OR: [
      { fullName: { contains: q, mode: 'insensitive' } }, { email: { contains: q.toLowerCase() } },
      { code: q.toUpperCase() }, { phone: { contains: q.replace(/\D/g, '') || q } },
    ] } : {}),
  });
  const e = await earnings(users.map(u => u.id));
  res.json({ success: true, data: users.map(u => userRow(u, e.get(u.id))) });
}));

router.get('/affiliates/:id', handle(async (req, res) => {
  const id = String(req.params.id);
  const [u] = await listUsers({ id });
  if (!u) throw new LedgerError(404, 'السفير غير موجود');
  const [claims, attributions, commissions, adjustments, payouts] = await Promise.all([
    prisma.affiliateClaim.findMany({ where: { affiliateId: id }, orderBy: { submittedAt: 'desc' } }),
    prisma.tenantAttribution.findMany({ where: { affiliateId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.affiliateCommission.findMany({ where: { affiliateId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.affiliateAdjustment.findMany({ where: { affiliateId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.affiliatePayout.findMany({ where: { affiliateId: id }, orderBy: { createdAt: 'desc' } }),
  ]);
  const related = [id, ...claims.map(x => x.id), ...attributions.map(x => x.id), ...commissions.map(x => x.id), ...adjustments.map(x => x.id), ...payouts.map(x => x.id)];
  const events = await prisma.affiliateEvent.findMany({ where: { entityId: { in: related } }, orderBy: { createdAt: 'desc' }, take: 200 });
  const e = await earnings([id]);
  res.json({ success: true, data: {
    affiliate: {
      ...userRow(u, e.get(id)), vatNumber: u.vatNumber, termsVersion: u.termsVersion, termsAcceptedAt: u.termsAcceptedAt, marketingConsent: u.marketingConsent,
      payout: u.ibanEnc && u.ibanLast4 ? { holderName: u.ibanHolderName, bankName: u.bankName, ibanLast4: u.ibanLast4, updatedAt: u.payoutUpdatedAt } : null,
    },
    claims, attributions, commissions, events,
    // «سُوّي» لا يعني «في مسودّة»: المسودّة لم تُحوَّل بعد وقد تُلغى
    adjustments: adjustments.map(a => {
      const p = a.payoutId ? payouts.find(x => x.id === a.payoutId) : undefined;
      return { ...a, settled: p?.status === 'recorded', inDraft: p?.status === 'draft' };
    }),
    payouts: payouts.map(p => ({ ...p, transferredAt: p.transferredAt ? riyadhDay(p.transferredAt) : null })),
  } });
}));

async function decideUser(req: AuthRequest, res: Response, to: string, opts: { from: string[]; reason?: string | null; mail?: 'approved' | 'rejected' | 'suspended' | 'reactivated' }) {
  const id = String(req.params.id);
  const u = await prisma.affiliateUser.findUnique({ where: { id } });
  if (!u) throw new LedgerError(404, 'السفير غير موجود');
  if (!opts.from.includes(u.status) || !canTransition('user', u.status, to)) throw new LedgerError(409, 'انتقالٌ غير مسموح من الحالة الحالية');
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateUser.updateMany({
      where: { id, status: u.status },
      data: { status: to, statusReason: opts.reason ?? null, reviewedAt: new Date(), reviewedBy: owner(req) },
    });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت الحالة — حدّث الصفحة');
    await logEvent(tx, { entity: 'user', entityId: id, action: to, fromState: u.status, toState: to, actorType: 'owner', actorId: owner(req), reason: opts.reason ?? null });
  });
  if (opts.mail) mailDecision(u.email, u.fullName, opts.mail, opts.reason);
  res.json({ success: true, data: { status: to } });
}

router.post('/affiliates/:id/approve', handle(async (req, res) => decideUser(req, res, 'approved', { from: ['pending_review'], mail: 'approved' })));
router.post('/affiliates/:id/reject', handle(async (req, res) => decideUser(req, res, 'rejected', { from: ['pending_review'], reason: reasonBody.parse(req.body).reason, mail: 'rejected' })));
router.post('/affiliates/:id/suspend', handle(async (req, res) => decideUser(req, res, 'suspended', { from: ['approved'], reason: reasonBody.parse(req.body).reason, mail: 'suspended' })));
router.post('/affiliates/:id/reactivate', handle(async (req, res) => {
  const u = await prisma.affiliateUser.findUnique({ where: { id: String(req.params.id) }, select: { status: true } });
  if (u?.status === 'rejected') return decideUser(req, res, 'pending_review', { from: ['rejected'] });
  return decideUser(req, res, 'approved', { from: ['suspended'], mail: 'reactivated' });
}));

router.post('/affiliates/:id/reveal-iban', handle(async (req, res) => {
  const u = await prisma.affiliateUser.findUnique({ where: { id: String(req.params.id) } });
  if (!u) throw new LedgerError(404, 'السفير غير موجود');
  if (!u.ibanEnc) throw new LedgerError(404, 'لا بيانات استلام');
  const iban = decryptIban(u.ibanEnc);
  if (!iban) throw new LedgerError(500, 'تعذّر فكّ التشفير — هل تغيّر مفتاح AFFILIATE_IBAN_KEY أو JWT_SECRET؟');
  await logEvent(prisma, { entity: 'user', entityId: u.id, action: 'iban_revealed', actorType: 'owner', actorId: owner(req) });
  res.json({ success: true, data: { iban, holderName: u.ibanHolderName, bankName: u.bankName } });
}));

// ───────────────────────────── الترشيحات ─────────────────────────────

const ACTIVE_CLAIM = ['under_review', 'approved', 'converted'];

router.get('/claims', handle(async (req, res) => {
  await expireStaleClaims();
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const claims = await prisma.affiliateClaim.findMany({
    where: status ? { status } : {}, orderBy: { submittedAt: 'desc' }, take: 200,
    include: { affiliate: { select: { id: true, fullName: true, code: true } } },
  });
  const crs = [...new Set(claims.map(c => c.crNumber))];
  const [siblings, settingsByCr, tenantNames] = await Promise.all([
    crs.length ? prisma.affiliateClaim.findMany({ where: { crNumber: { in: crs }, status: { in: ACTIVE_CLAIM } }, include: { affiliate: { select: { fullName: true } } } }) : [],
    crs.length ? prisma.companySettings.findMany({ where: { OR: crs.map(cr => ({ commercialReg: { contains: cr } })) }, select: { tenantId: true, commercialReg: true, tenant: { select: { name: true, createdAt: true } } }, take: 200 }) : [],
    prisma.tenant.findMany({ where: { id: { in: claims.map(c => c.tenantId).filter((v): v is string => !!v) } }, select: { id: true, name: true } }),
  ]);
  const nameOf = new Map(tenantNames.map(t => [t.id, t.name]));

  const data = await Promise.all(claims.map(async c => {
    const suggestions: Array<{ tenantId: string; tenantName: string; match: 'cr' | 'name'; createdAt: Date }> = [];
    if (c.status === 'under_review' || c.status === 'approved' || c.status === 'expired') {
      for (const s of settingsByCr) {
        if (normCR(s.commercialReg) === c.crNumber) suggestions.push({ tenantId: s.tenantId, tenantName: s.tenant.name, match: 'cr', createdAt: s.tenant.createdAt });
      }
      // مطابقة الاسم: أطول كلمةٍ مميّزة ثمّ مقارنةٌ بعد التطبيع
      const token = c.companyNameNorm.split(' ').sort((a, b) => b.length - a.length)[0];
      if (token && token.length >= 3) {
        const cands = await prisma.tenant.findMany({ where: { name: { contains: token.slice(0, 4), mode: 'insensitive' } }, select: { id: true, name: true, createdAt: true }, take: 30 });
        for (const t of cands) {
          const n = normCompanyName(t.name);
          if ((n === c.companyNameNorm || n.includes(c.companyNameNorm) || c.companyNameNorm.includes(n)) && n.length >= 3 && !suggestions.some(s => s.tenantId === t.id)) {
            suggestions.push({ tenantId: t.id, tenantName: t.name, match: 'name', createdAt: t.createdAt });
          }
        }
      }
    }
    return {
      id: c.id, affiliate: c.affiliate, companyName: c.companyName, crNumber: c.crNumber, city: c.city, how: c.how, note: c.note,
      status: c.status, reasonCode: c.reasonCode, submittedAt: c.submittedAt, reviewedAt: c.reviewedAt, lockedUntil: c.lockedUntil,
      tenantId: c.tenantId, tenantName: c.tenantId ? (nameOf.get(c.tenantId) ?? null) : null,
      conflicts: siblings.filter(s => s.crNumber === c.crNumber && s.id !== c.id).map(s => ({ claimId: s.id, affiliateName: s.affiliate.fullName, status: s.status })),
      suggestions: suggestions.slice(0, 8),
    };
  }));
  res.json({ success: true, data });
}));

router.post('/claims/:id/approve', handle(async (req, res) => {
  const id = String(req.params.id);
  const c = await prisma.affiliateClaim.findUnique({ where: { id } });
  if (!c) throw new LedgerError(404, 'الترشيح غير موجود');
  if (c.status !== 'under_review') throw new LedgerError(409, 'الترشيح ليس قيد المراجعة');
  const aff = await prisma.affiliateUser.findUnique({ where: { id: c.affiliateId }, select: { status: true } });
  if (aff?.status !== 'approved') throw new LedgerError(409, 'حساب السفير ليس مقبولاً حالياً');
  const now = new Date();
  // الأسبق يفوز: ترشيحٌ معتمد ساري القفل بالسجل نفسه يمنع اعتماد غيره
  const held = await prisma.affiliateClaim.findFirst({ where: { crNumber: c.crNumber, id: { not: id }, OR: [{ status: 'approved', lockedUntil: { gt: now } }, { status: 'converted' }] }, include: { affiliate: { select: { fullName: true } } } });
  if (held) throw new LedgerError(409, `السجل محجوزٌ بترشيحٍ ${held.status === 'converted' ? 'تحوّل لعميل' : 'معتمد'} لـ${held.affiliate.fullName}`);
  // مدّة القفل من الشروط التي قبلها صاحب الترشيح
  const affTerms = await prisma.affiliateUser.findUnique({ where: { id: c.affiliateId }, select: { termsVersion: true } });
  const rules = await rulesFor(affTerms?.termsVersion ?? DEFAULT_TERMS_VERSION);
  const lockedUntil = new Date(now.getTime() + rules.claimLockDays * 24 * 3600_000);
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateClaim.updateMany({ where: { id, status: 'under_review' }, data: { status: 'approved', reviewedAt: now, reviewedBy: owner(req), lockedUntil } });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت الحالة — حدّث الصفحة');
    await logEvent(tx, { entity: 'claim', entityId: id, action: 'approved', fromState: 'under_review', toState: 'approved', actorType: 'owner', actorId: owner(req) });
  });
  res.json({ success: true, data: { status: 'approved', lockedUntil } });
}));

router.post('/claims/:id/reject', handle(async (req, res) => {
  const id = String(req.params.id);
  const { reasonCode } = z.object({ reasonCode: z.enum(['existing_customer', 'duplicate', 'self_referral', 'insufficient', 'other']) }).parse(req.body);
  const c = await prisma.affiliateClaim.findUnique({ where: { id }, select: { status: true } });
  if (!c) throw new LedgerError(404, 'الترشيح غير موجود');
  if (!canTransition('claim', c.status, 'rejected')) throw new LedgerError(409, 'لا يُرفض ترشيحٌ بهذه الحالة');
  await prisma.$transaction(async tx => {
    const won = await tx.affiliateClaim.updateMany({ where: { id, status: c.status }, data: { status: 'rejected', reasonCode, reviewedAt: new Date(), reviewedBy: owner(req), lockedUntil: null } });
    if (won.count !== 1) throw new LedgerError(409, 'تغيّرت الحالة — حدّث الصفحة');
    await logEvent(tx, { entity: 'claim', entityId: id, action: 'rejected', fromState: c.status, toState: 'rejected', actorType: 'owner', actorId: owner(req), reason: reasonCode });
  });
  res.json({ success: true, data: { status: 'rejected' } });
}));

router.post('/claims/:id/link-tenant', handle(async (req, res) => {
  const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.body);
  res.json({ success: true, data: await linkClaimToTenant(String(req.params.id), tenantId, owner(req)) });
}));

// ───────────────────────────── الإسناد ─────────────────────────────

async function attributionView(id: string, accrual?: AccrueResult | null) {
  const a = await prisma.tenantAttribution.findUnique({ where: { id }, include: { commission: { select: { id: true, status: true, commissionHalalas: true } } } });
  if (!a) return null;
  return {
    attribution: { id: a.id, status: a.status }, commission: a.commission,
    commissionCreated: !!accrual?.created, accrualReason: accrual && !accrual.created ? accrual.reason : null,
  };
}

router.get('/attributions', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const rows = await prisma.tenantAttribution.findMany({
    where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 500,
    include: { affiliate: { select: { id: true, fullName: true, code: true } }, commission: { select: { id: true, status: true, commissionHalalas: true } } },
  });
  res.json({ success: true, data: rows.map(a => ({
    id: a.id, tenantId: a.tenantId, tenantName: a.tenantNameSnapshot, affiliate: a.affiliate, source: a.source, status: a.status,
    flags: a.flags, codeUsed: a.codeUsed, refVia: a.refVia, reasonNote: a.reasonNote, effectiveFrom: a.effectiveFrom,
    firstPaymentDeadline: a.firstPaymentDeadline, rateBps: a.rateBps, createdAt: a.createdAt, commission: a.commission,
  })) });
}));

router.post('/attributions', handle(async (req, res) => {
  const b = z.object({ tenantId: z.string().uuid(), affiliateId: z.string().uuid(), reason: z.string().trim().min(3).max(500), effectiveFrom: dateStr.optional() }).parse(req.body);
  const out = await createOwnerAttribution({ ...b, effectiveFrom: b.effectiveFrom ? riyadhDate(b.effectiveFrom) : undefined }, owner(req));
  res.json({ success: true, data: await attributionView(out.attributionId, out.accrual) });
}));

router.post('/attributions/:id/void', handle(async (req, res) => {
  const { reason } = reasonBody.parse(req.body);
  await voidAttribution(String(req.params.id), owner(req), reason);
  res.json({ success: true, data: await attributionView(String(req.params.id)) });
}));

router.post('/attributions/:id/activate', handle(async (req, res) => {
  const { reason } = reasonBody.parse(req.body);
  const out = await activateAttribution(String(req.params.id), owner(req), reason);
  res.json({ success: true, data: await attributionView(String(req.params.id), out.accrual) });
}));

router.post('/attributions/:id/reassign', handle(async (req, res) => {
  const b = z.object({ affiliateId: z.string().uuid(), reason: z.string().trim().min(3, 'اذكر السبب').max(500), effectiveFrom: dateStr.optional(), claimId: z.string().uuid().optional() }).parse(req.body);
  const out = await reassignAttribution(String(req.params.id), {
    affiliateId: b.affiliateId, reason: b.reason, claimId: b.claimId, effectiveFrom: b.effectiveFrom ? riyadhDate(b.effectiveFrom) : undefined,
  }, owner(req));
  res.json({ success: true, data: await attributionView(out.attributionId, out.accrual) });
}));

router.post('/attributions/:id/window', handle(async (req, res) => {
  const b = z.object({ effectiveFrom: dateStr, reason: z.string().trim().min(3, 'اذكر السبب').max(500) }).parse(req.body);
  const out = await adjustAttributionWindow(String(req.params.id), { effectiveFrom: riyadhDate(b.effectiveFrom), reason: b.reason }, owner(req));
  res.json({ success: true, data: await attributionView(out.attributionId, out.accrual) });
}));

// ───────────────────────────── العمولات ─────────────────────────────

router.get('/commissions', handle(async (req, res) => {
  await reconcile().catch(e => console.error('[affiliate] reconcile:', (e as Error).message));
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const rows = await prisma.affiliateCommission.findMany({
    where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 500,
    include: { affiliate: { select: { id: true, fullName: true, code: true } } },
  });
  const links = rows.length ? await prisma.paymentLink.findMany({ where: { id: { in: rows.map(r => r.paymentLinkId) } }, select: { id: true, status: true } }) : [];
  const ls = new Map(links.map(l => [l.id, l.status]));
  const now = Date.now();
  res.json({ success: true, data: rows.map(c => {
    const linkStatus = ls.get(c.paymentLinkId) ?? 'missing';
    return {
      id: c.id, tenantId: c.tenantId, tenantName: c.tenantNameSnapshot, affiliate: c.affiliate, paymentLinkId: c.paymentLinkId,
      paymentAmountHalalas: c.paymentAmountHalalas, refundedHalalas: c.refundedHalalas, coveredMonths: c.coveredMonths, rateBps: c.rateBps, commissionHalalas: c.commissionHalalas,
      paymentPaidAt: c.paymentPaidAt, eligibleAt: c.eligibleAt, status: c.status, reasonNote: c.reasonNote, approvedAt: c.approvedAt,
      payoutId: c.payoutId, linkStatus, readyToApprove: c.status === 'pending' && c.eligibleAt.getTime() <= now && linkStatus === 'paid',
    };
  }) });
}));

router.post('/commissions/:id/approve', handle(async (req, res) => {
  res.json({ success: true, data: { status: await approveCommission(String(req.params.id), owner(req)) } });
}));
router.post('/commissions/:id/hold', handle(async (req, res) => {
  res.json({ success: true, data: { status: await holdCommission(String(req.params.id), owner(req), reasonBody.parse(req.body).reason) } });
}));
router.post('/commissions/:id/release', handle(async (req, res) => {
  res.json({ success: true, data: { status: await releaseCommission(String(req.params.id), owner(req)) } });
}));
router.post('/commissions/:id/decline', handle(async (req, res) => {
  res.json({ success: true, data: { status: await declineCommission(String(req.params.id), owner(req), reasonBody.parse(req.body).reason) } });
}));

// ───────────────────────────── الصرف ─────────────────────────────

router.get('/payouts/candidates', handle(async (_req, res) => {
  res.json({ success: true, data: await payoutCandidates() });
}));

router.get('/payouts', handle(async (req, res) => {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const rows = await prisma.affiliatePayout.findMany({
    where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 300,
    include: { affiliate: { select: { id: true, fullName: true, code: true } }, _count: { select: { commissions: true } } },
  });
  res.json({ success: true, data: rows.map(p => ({
    id: p.id, affiliate: p.affiliate, commissionsHalalas: p.commissionsHalalas, adjustmentsHalalas: p.adjustmentsHalalas, netHalalas: p.netHalalas,
    status: p.status, ibanLast4: p.ibanLast4, holderName: p.holderName, transferredAt: p.transferredAt ? riyadhDay(p.transferredAt) : null, bankReference: p.bankReference,
    createdAt: p.createdAt, voidReason: p.voidReason, commissionCount: p._count.commissions,
  })) });
}));

router.post('/payouts', handle(async (req, res) => {
  const { affiliateId } = z.object({ affiliateId: z.string().uuid() }).parse(req.body);
  res.json({ success: true, data: await createPayout(affiliateId, owner(req)) });
}));

router.post('/payouts/:id/record', handle(async (req, res) => {
  const b = z.object({ bankReference: z.string().trim().min(3).max(80), transferredAt: dateStr }).parse(req.body);
  const when = riyadhDate(b.transferredAt);
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now()) throw new LedgerError(400, 'تاريخ التحويل غير صحيح');
  const p = await recordPayout(String(req.params.id), owner(req), b.bankReference, when);
  const u = await prisma.affiliateUser.findUnique({ where: { id: p.affiliateId }, select: { email: true, fullName: true } });
  if (u) mailPayoutRecorded(u.email, u.fullName, { netHalalas: p.netHalalas, bankReference: b.bankReference, ibanLast4: p.ibanLast4 });
  res.json({ success: true, data: p });
}));

router.post('/payouts/:id/void', handle(async (req, res) => {
  res.json({ success: true, data: await voidPayout(String(req.params.id), owner(req), reasonBody.parse(req.body).reason) });
}));

router.post('/adjustments', handle(async (req, res) => {
  const b = z.object({ affiliateId: z.string().uuid(), amountHalalas: z.number().int().refine(v => v !== 0, 'المبلغ لا يكون صفراً').refine(v => Math.abs(v) <= 100_000_000), note: z.string().trim().min(3).max(500) }).parse(req.body);
  const u = await prisma.affiliateUser.findUnique({ where: { id: b.affiliateId }, select: { id: true } });
  if (!u) throw new LedgerError(404, 'السفير غير موجود');
  const adj = await prisma.$transaction(async tx => {
    // sourceRef فريدٌ لكلّ قيدٍ يدوي — القيد الفريد (commissionId,kind,sourceRef) مع commissionId فارغ لا يمنع التكرار في Postgres أصلاً
    const row = await tx.affiliateAdjustment.create({ data: { affiliateId: u.id, kind: 'correction', sourceRef: `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, amountHalalas: b.amountHalalas, note: b.note, createdBy: owner(req) } });
    await logEvent(tx, { entity: 'adjustment', entityId: row.id, action: 'created', actorType: 'owner', actorId: owner(req), meta: { amountHalalas: b.amountHalalas } });
    return row;
  });
  res.json({ success: true, data: adj });
}));

// ───────────────────────────── السجلّ والبحث ─────────────────────────────

router.get('/events', handle(async (req, res) => {
  const entity = typeof req.query.entity === 'string' && req.query.entity ? req.query.entity : undefined;
  const entityId = typeof req.query.entityId === 'string' && req.query.entityId ? req.query.entityId : undefined;
  const rows = await prisma.affiliateEvent.findMany({ where: { ...(entity ? { entity } : {}), ...(entityId ? { entityId } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json({ success: true, data: rows });
}));

router.get('/tenants/search', handle(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  if (q.length < 2) { res.json({ success: true, data: [] }); return; }
  const isUuid = /^[0-9a-f-]{36}$/i.test(q);
  const tenants = await prisma.tenant.findMany({
    where: { OR: [
      { name: { contains: q, mode: 'insensitive' } },
      ...(isUuid ? [{ id: q }] : []),
      ...(/\d{4,}/.test(q) ? [{ settings: { commercialReg: { contains: q.replace(/\D/g, '') } } }] : []),
    ] },
    select: { id: true, name: true, createdAt: true, settings: { select: { commercialReg: true } } },
    orderBy: { createdAt: 'desc' }, take: 20,
  });
  const attributed = tenants.length
    ? new Set((await prisma.tenantAttribution.findMany({ where: { tenantId: { in: tenants.map(t => t.id) } }, select: { tenantId: true } })).map(a => a.tenantId))
    : new Set<string>();
  res.json({ success: true, data: tenants.map(t => ({ id: t.id, name: t.name, commercialReg: t.settings?.commercialReg ?? null, createdAt: t.createdAt, attributed: attributed.has(t.id) })) });
}));

export default router;
