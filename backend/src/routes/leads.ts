import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { runSearch, qualifyLeads, LeadProvider, RawLead, providersReady } from '../services/leadSources';
import { sendMarketingEmail, marketingProvider } from '../services/marketingMailer';
import { whatsappReady, waNumber, sendWhatsAppText, sendWhatsAppTemplate, waSignatureEnforced } from '../services/whatsapp';
import {
  getWaConfig, saveWaConfig, resolveWaParams, previewWaParams, waSentToday, waRemainingToday, WA_PARAMS, WaParam,
} from '../services/whatsappCampaign';
import { enrichFromWebsite, hunterDomainSearch, hunterReady } from '../services/enrich';
import { getApifyBudget, setApifyCap, apifyReady } from '../services/apifyBudget';
import { getHuntConfig, saveHuntConfig, runAutoHuntBatch, ARAB_COUNTRIES } from '../services/leadHunter';
import { personalize, marketingHtml } from '../services/marketingTemplate';
import { phoneIsMobile } from '../services/phoneType';
import { getEmailConfig, saveEmailConfig, runAutoEmailBatch } from '../services/leadEmailer';
import { getCommunityConfig, saveCommunityConfig, runCommunityHuntBatch } from '../services/communityHunter';

// إدارة العملاء المحتملين (Leads) — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
router.use(authenticate, requireSuperAdmin);

const STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'] as const;

// بناء شرط التصفية المشترك (تستخدمه القائمة والتصدير) من معاملات الاستعلام
function buildLeadWhere(query: Record<string, string>): Record<string, unknown> {
  const { stage, source, countryCode, q, assignedTo, dueOnly, hasEmail, hasPhone, hasWebsite, emailed, whatsapped, optedOut } = query;
  const where: Record<string, unknown> = {};
  if (stage && STAGES.includes(stage as typeof STAGES[number])) where.stage = stage;
  // مستخدمو مولّد الفواتير لهم صفحتهم المستقلة — يُستثنون من قائمة العملاء المحتملين
  if (source) where.source = source;
  else where.source = { not: 'invoice-tool' };
  if (countryCode) where.countryCode = countryCode;
  if (assignedTo) where.assignedTo = assignedTo;
  if (dueOnly === 'true') where.nextFollowUpAt = { lte: new Date() };
  if (hasEmail === 'true') where.email = { not: null };
  else if (query.noEmail === 'true') where.email = null;
  if (hasPhone === 'true') where.phone = { not: null };
  else if (query.noPhone === 'true') where.phone = null;
  if (hasWebsite === 'true') where.website = { not: null };
  // انسحاب واتساب — لعدّ المستهدفين بما يطابق استهداف الإرسال تماماً
  if (optedOut === 'true') where.waOptOut = true;
  else if (optedOut === 'false') where.waOptOut = false;
  // «تمت مراسلته / لم يُراسَل» عبر وجود نشاط (EMAIL/WHATSAPP) — تُدمج بـ AND لدعم الجمع بينها
  const activityAnd: unknown[] = [];
  if (emailed === 'true') activityAnd.push({ activities: { some: { type: 'EMAIL' } } });
  else if (emailed === 'false') activityAnd.push({ activities: { none: { type: 'EMAIL' } } });
  if (whatsapped === 'true') activityAnd.push({ activities: { some: { type: 'WHATSAPP' } } });
  else if (whatsapped === 'false') activityAnd.push({ activities: { none: { type: 'WHATSAPP' } } });
  if (activityAnd.length) where.AND = activityAnd;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { city: { contains: q, mode: 'insensitive' } },
      { country: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } },
    ];
  }
  return where;
}

const leadCreateSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  countryCode: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  source: z.string().optional(),
});

const leadUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().nullish(),
  email: z.string().nullish(),
  website: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().nullish(),
  countryCode: z.string().nullish(),
  category: z.string().nullish(),
  stage: z.enum(STAGES).optional(),
  score: z.number().int().min(0).max(10).nullish(),
  scoreNote: z.string().nullish(),
  assignedTo: z.string().nullish(),
  notes: z.string().nullish(),
  nextFollowUpAt: z.string().nullish(),
  lastContactedAt: z.string().nullish(),
});

// ------------------------------- قائمة + فلاتر ------------------------------- //
router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
    const where = buildLeadWhere(req.query as Record<string, string>);

    const [total, leads] = await Promise.all([
      prisma.lead.count({ where }),
      prisma.lead.findMany({
        where,
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    res.json({ success: true, data: leads, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- إحصائيات القمع ------------------------------- //
router.get('/stats', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // مستخدمو مولّد الفواتير مستثنون (لهم صفحتهم وإحصاءاتهم المستقلة)
    const notTool = { source: { not: 'invoice-tool' } };
    const [byStage, bySource, byCountry, total, won, due] = await Promise.all([
      prisma.lead.groupBy({ by: ['stage'], where: notTool, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['source'], where: notTool, _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['countryCode'], where: notTool, _count: { _all: true } }),
      prisma.lead.count({ where: notTool }),
      prisma.lead.count({ where: { ...notTool, stage: 'WON' } }),
      prisma.lead.count({ where: { ...notTool, nextFollowUpAt: { lte: new Date() }, stage: { notIn: ['WON', 'LOST'] } } }),
    ]);
    const stages: Record<string, number> = {};
    for (const s of STAGES) stages[s] = 0;
    byStage.forEach((r) => { stages[r.stage] = r._count._all; });
    const conversion = total > 0 ? Math.round((won / total) * 1000) / 10 : 0;
    res.json({
      success: true,
      data: {
        total, won, due, conversion,
        stages,
        sources: bySource.map((r) => ({ source: r.source, count: r._count._all })),
        countries: byCountry
          .filter((r) => r.countryCode)
          .map((r) => ({ countryCode: r.countryCode, count: r._count._all }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 15),
      },
    });
  } catch (err) {
    next(err);
  }
});

// هل واتساب مُعدّ في الخادم؟ (قبل /:id حتى لا يبتلعه) — لعرض تنبيه الإعداد في الواجهة
// نُرفق الحصّة اليومية المتبقّية وحالة تأمين الـwebhook ليراهما المالك قبل الإرسال
router.get('/whatsapp-status', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cfg = await getWaConfig();
    const [sentToday, optedOut] = await Promise.all([
      waSentToday(),
      prisma.lead.count({ where: { waOptOut: true } }),
    ]);
    res.json({
      success: true,
      data: {
        ready: whatsappReady(),
        signatureEnforced: waSignatureEnforced(),
        webhookConfigured: !!(process.env.WHATSAPP_VERIFY_TOKEN || '').trim(),
        dailyCap: cfg.dailyCap,
        sentToday,
        remainingToday: Math.max(0, cfg.dailyCap - sentToday),
        optedOut,
      },
    });
  } catch (err) { next(err); }
});

// إعدادات حملة واتساب (القالب والمتغيّرات والحدود) — قبل /:id
router.get('/whatsapp-config', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { ...(await getWaConfig()), available: WA_PARAMS } });
  } catch (err) { next(err); }
});

// تحديث جزئي: يُدمج مع الإعدادات الحالية فلا يمسح المالكُ حقلاً بإغفاله
const waConfigSchema = z.object({
  templateName: z.string(),
  language: z.string(),
  params: z.array(z.enum(['name', 'city', 'country', 'angle', 'angle_en'])).max(6),
  dailyCap: z.number().int().min(1).max(1000),
  batchSize: z.number().int().min(1).max(200),
}).partial();

router.put('/whatsapp-config', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = waConfigSchema.parse(req.body);
    const cfg = { ...(await getWaConfig()), ...patch };
    await saveWaConfig(cfg);
    res.json({ success: true, data: cfg });
  } catch (err) { next(err); }
});

// معاينة ما سيُملأ في متغيّرات القالب لعميل حقيقي (أول مستهدَف) — قبل /:id
router.get('/whatsapp-preview', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const cfg = await getWaConfig();
    const params = (req.query.params ? String(req.query.params).split(',') : cfg.params) as WaParam[];
    const lead = await prisma.lead.findFirst({
      where: { phone: { not: null }, waOptOut: false, activities: { none: { type: 'WHATSAPP' } } },
      select: { name: true, city: true, country: true, countryCode: true },
    });
    if (!lead) {
      res.json({ success: true, data: { lead: null, slots: [] } });
      return;
    }
    res.json({ success: true, data: { lead, slots: previewWaParams(params, lead) } });
  } catch (err) { next(err); }
});

// حالة الإثراء (هل Hunter مُعدّ؟) — قبل /:id
router.get('/enrich-status', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { hunter: hunterReady() } });
});

// أي مصادر البحث جاهزة (لها مفتاح)؟ — قبل /:id
router.get('/sources-status', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: providersReady() });
});

// ميزانية Apify الشهرية (المصدر الوحيد المحكوم برصيد) — قبل /:id
router.get('/apify-budget', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const b = await getApifyBudget();
    res.json({ success: true, data: { ...b, ready: apifyReady(), remaining: Math.max(0, b.monthlyCap - b.used) } });
  } catch (err) { next(err); }
});

const apifyCapSchema = z.object({ monthlyCap: z.number().int().min(0).max(100000) });
router.put('/apify-budget', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { monthlyCap } = apifyCapSchema.parse(req.body);
    const b = await setApifyCap(monthlyCap);
    res.json({ success: true, data: { ...b, ready: apifyReady(), remaining: Math.max(0, b.monthlyCap - b.used) } });
  } catch (err) { next(err); }
});

// مزوّد البريد التسويقي الحالي وحصّته اليومية — قبل /:id
router.get('/email-status', (_req: AuthRequest, res: Response) => {
  const provider = marketingProvider();
  res.json({ success: true, data: { provider, dailyCap: provider === 'brevo' ? 300 : 100 } });
});

// قائمة كل الدول العربية المدعومة (لزرّ «كل الدول» في اللوحة) — قبل /:id
router.get('/arab-countries', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: ARAB_COUNTRIES });
});

// ------------------------- تصنيف الهواتف (جوّال/أرضي) — قبل /:id ------------------------- //
// كم رقماً أرضياً في القاعدة؟ (معاينة قبل التنظيف)
router.get('/phone-audit', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [mobile, landline, unknown, unclassified] = await Promise.all([
      prisma.lead.count({ where: { phone: { not: null }, phoneIsMobile: true } }),
      prisma.lead.count({ where: { phone: { not: null }, phoneIsMobile: false } }),
      prisma.lead.count({ where: { phone: { not: null }, phoneIsMobile: null, waMessages: { some: {} } } }),
      prisma.lead.count({ where: { phone: { not: null }, phoneIsMobile: null } }),
    ]);
    res.json({ success: true, data: { mobile, landline, unknown, unclassified } });
  } catch (err) { next(err); }
});

/**
 * تصنيف كل الأرقام في القاعدة (جوّال/أرضي) — يُشغَّل مرّة، ثم الصيد يُصنّف تلقائياً.
 * لا يحذف عميلاً: يضبط علماً فقط. الأرضي يبقى عميلاً صالحاً للاتصال والبريد.
 */
router.post('/phone-classify', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const leads = await prisma.lead.findMany({
      where: { phone: { not: null } },
      select: { id: true, phone: true, phoneIsMobile: true },
    });
    let mobile = 0, landline = 0, unknown = 0, changed = 0;
    for (const l of leads) {
      const val = phoneIsMobile(l.phone);
      if (val === true) mobile++; else if (val === false) landline++; else unknown++;
      if (val !== l.phoneIsMobile) {
        await prisma.lead.update({ where: { id: l.id }, data: { phoneIsMobile: val } });
        changed++;
      }
    }
    res.json({ success: true, data: { total: leads.length, mobile, landline, unknown, changed } });
  } catch (err) { next(err); }
});

// ------------------------------- عملاء مولّد الفواتير (صفحة مستقلة) — قبل /:id ------------------------------- //
// كل من استخدم الأداة المجانية: الشركة + رقمها الضريبي + عدد الاستخدامات + آخر فاتورة وأنشطتها
router.get('/invoice-tool', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const weekAgo = new Date(Date.now() - 7 * 86400_000);
    const [leads, usesTotal, useCounts] = await Promise.all([
      prisma.lead.findMany({
        where: { source: 'invoice-tool' },
        orderBy: { updatedAt: 'desc' },
        include: { activities: { where: { type: 'TOOL' }, orderBy: { createdAt: 'desc' }, take: 5, select: { content: true, createdAt: true } } },
      }),
      prisma.leadActivity.count({ where: { type: 'TOOL' } }),
      prisma.leadActivity.groupBy({ by: ['leadId'], where: { type: 'TOOL' }, _count: { _all: true } }),
    ]);
    const usesByLead = new Map(useCounts.map((u) => [u.leadId, u._count._all]));
    const users = leads.map((l) => ({
      id: l.id,
      name: l.name,
      vatNumber: (l.notes?.match(/الرقم الضريبي:\s*(\d+)/) || [])[1] || null,
      country: l.country,
      countryCode: l.countryCode,
      address: l.address,
      createdAt: l.createdAt,
      uses: usesByLead.get(l.id) || 0,
      lastUseAt: l.activities[0]?.createdAt || l.createdAt,
      activities: l.activities,
    }));
    const countries = new Set(users.map((u) => u.countryCode).filter(Boolean)).size;
    const newWeek = users.filter((u) => new Date(u.createdAt) >= weekAgo).length;
    res.json({ success: true, data: { stats: { total: users.length, uses: usesTotal, newWeek, countries }, users } });
  } catch (err) { next(err); }
});

// ------------------------------- غرفة قيادة التسويق — قبل /:id ------------------------------- //
// يجمع مؤشرات الآلية كاملة: الصيد، البريد (سلسلة اللمسات)، التفاعل (فتح/نقر/إلغاء)، والعملاء الساخنين
router.get('/marketing-stats', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [huntCfg, emailCfg, communityCfg, opens, clicks, unsubs, emails, hotLeads, engagedByCountry] = await Promise.all([
      getHuntConfig(),
      getEmailConfig(),
      getCommunityConfig(),
      prisma.leadActivity.count({ where: { type: 'OPEN' } }),
      prisma.leadActivity.count({ where: { type: 'CLICK' } }),
      prisma.leadActivity.count({ where: { type: 'UNSUB' } }),
      prisma.leadActivity.count({ where: { type: 'EMAIL', createdBy: 'auto-email' } }),
      // الساخنون: نقروا رابطاً ولم يُغلقوا — أولوية التواصل البشري
      prisma.lead.findMany({
        where: { activities: { some: { type: 'CLICK' } }, stage: { notIn: ['WON', 'LOST'] } },
        orderBy: { updatedAt: 'desc' },
        take: 12,
        select: { id: true, name: true, country: true, countryCode: true, city: true, phone: true, email: true, stage: true, score: true, updatedAt: true },
      }),
      prisma.lead.groupBy({ by: ['countryCode'], where: { activities: { some: { type: { in: ['OPEN', 'CLICK'] } } } }, _count: { _all: true } }),
    ]);
    const openRate = emails > 0 ? Math.round((opens / emails) * 1000) / 10 : 0;
    const clickRate = emails > 0 ? Math.round((clicks / emails) * 1000) / 10 : 0;
    res.json({
      success: true,
      data: {
        hunt: { enabled: huntCfg.enabled, totalRuns: huntCfg.totalRuns, totalImported: huntCfg.totalImported, countries: huntCfg.countries.length, lastRunAt: huntCfg.lastRunAt },
        email: {
          enabled: emailCfg.enabled, totalSent: emailCfg.totalSent, totalFollowUps: emailCfg.totalFollowUps,
          sentToday: emailCfg.sentToday, dailyCap: emailCfg.dailyCap, touches: emailCfg.touches, gapDays: emailCfg.gapDays, lastRunAt: emailCfg.lastRunAt,
        },
        community: { enabled: communityCfg.enabled, lastRunAt: communityCfg.lastRunAt },
        engagement: { opens, clicks, unsubs, openRate, clickRate },
        hotLeads,
        engagedByCountry: engagedByCountry
          .filter((r) => r.countryCode)
          .map((r) => ({ countryCode: r.countryCode, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
      },
    });
  } catch (err) { next(err); }
});

// ------------------------------- الصيد المستمر (Auto-Hunt) — قبل /:id ------------------------------- //
router.get('/auto-hunt', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await getHuntConfig() }); } catch (err) { next(err); }
});

const huntConfigSchema = z.object({
  enabled: z.boolean().optional(),
  providers: z.array(z.enum(['osm', 'geoapify', 'here', 'google', 'apollo', 'tomtom', 'serper', 'linkedin'])).optional(),
  countries: z.array(z.string().min(1)).min(1).optional(),
  city: z.string().nullish(),
  keywordsPerRun: z.number().int().min(1).max(6).optional(),
  qualify: z.boolean().optional(),
  enrich: z.boolean().optional(),
  enrichHunter: z.boolean().optional(),
  limit: z.number().int().min(1).max(80).optional(),
});
router.put('/auto-hunt', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = huntConfigSchema.parse(req.body);
    const cfg = await getHuntConfig();
    const merged = { ...cfg, ...patch, city: patch.city === undefined ? cfg.city : (patch.city || null) };
    await saveHuntConfig(merged as typeof cfg);
    res.json({ success: true, data: merged });
  } catch (err) { next(err); }
});

router.post('/auto-hunt/run', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await runAutoHuntBatch('auto-hunt (يدوي)') }); } catch (err) { next(err); }
});

// ------------------------------- البريد التلقائي المستمر — قبل /:id ------------------------------- //
router.get('/auto-email', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await getEmailConfig() }); } catch (err) { next(err); }
});

const autoEmailConfigSchema = z.object({
  enabled: z.boolean().optional(),
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  subject2: z.string().nullish(),
  body2: z.string().nullish(),
  subject3: z.string().nullish(),
  body3: z.string().nullish(),
  touches: z.number().int().min(1).max(3).optional(),
  gapDays: z.number().int().min(1).max(30).optional(),
  batchSize: z.number().int().min(1).max(100).optional(),
  dailyCap: z.number().int().min(1).max(300).optional(),
  stage: z.string().nullish(),
  source: z.string().nullish(),
  countryCode: z.string().nullish(),
});
router.put('/auto-email', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = autoEmailConfigSchema.parse(req.body);
    const cfg = await getEmailConfig();
    const merged = {
      ...cfg, ...patch,
      stage: patch.stage === undefined ? cfg.stage : (patch.stage || null),
      source: patch.source === undefined ? cfg.source : (patch.source || null),
      countryCode: patch.countryCode === undefined ? cfg.countryCode : (patch.countryCode || null),
    };
    await saveEmailConfig(merged as typeof cfg);
    res.json({ success: true, data: merged });
  } catch (err) { next(err); }
});

router.post('/auto-email/run', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await runAutoEmailBatch() }); } catch (err) { next(err); }
});

// ------------------------------- بحث المجتمعات المستمر — قبل /:id ------------------------------- //
router.get('/community-hunt', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await getCommunityConfig() }); } catch (err) { next(err); }
});

const communityConfigSchema = z.object({
  enabled: z.boolean().optional(),
  countries: z.array(z.string().min(1)).min(1).optional(),
  keywordsPerRun: z.number().int().min(1).max(6).optional(),
  limit: z.number().int().min(1).max(40).optional(),
});
router.put('/community-hunt', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const patch = communityConfigSchema.parse(req.body);
    const cfg = await getCommunityConfig();
    const merged = { ...cfg, ...patch };
    await saveCommunityConfig(merged as typeof cfg);
    res.json({ success: true, data: merged });
  } catch (err) { next(err); }
});

router.post('/community-hunt/run', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try { res.json({ success: true, data: await runCommunityHuntBatch() }); } catch (err) { next(err); }
});

// ------------------------------- تفاصيل + أنشطة ------------------------------- //
router.get('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { activities: { orderBy: { createdAt: 'desc' } } },
    });
    if (!lead) { res.status(404).json({ success: false, message: 'العميل المحتمل غير موجود' }); return; }
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- إنشاء يدوي ------------------------------- //
router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = leadCreateSchema.parse(req.body);
    const lead = await prisma.lead.create({
      data: { ...body, name: body.name!, source: body.source || 'manual' },
    });
    await prisma.leadActivity.create({
      data: { leadId: lead.id, type: 'NOTE', content: 'أُنشئ يدوياً', createdBy: req.user?.name },
    });
    res.status(201).json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- تحديث (مرحلة/تقييم/متابعة...) ------------------------------- //
router.put('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = leadUpdateSchema.parse(req.body);
    const existing = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!existing) { res.status(404).json({ success: false, message: 'العميل المحتمل غير موجود' }); return; }

    const data: Record<string, unknown> = { ...body };
    if (body.nextFollowUpAt !== undefined) data.nextFollowUpAt = body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : null;
    if (body.lastContactedAt !== undefined) data.lastContactedAt = body.lastContactedAt ? new Date(body.lastContactedAt) : null;

    const lead = await prisma.lead.update({ where: { id: req.params.id }, data });

    // سجّل تغيير المرحلة كنشاط
    if (body.stage && body.stage !== existing.stage) {
      await prisma.leadActivity.create({
        data: { leadId: lead.id, type: 'STAGE_CHANGE', content: `${existing.stage} ← ${body.stage}`, createdBy: req.user?.name },
      });
    }
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- حذف ------------------------------- //
router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await prisma.lead.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- إضافة نشاط/متابعة ------------------------------- //
const activitySchema = z.object({
  type: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING', 'WHATSAPP']).default('NOTE'),
  content: z.string().min(1),
  markContacted: z.boolean().optional(),
});
router.post('/:id/activities', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = activitySchema.parse(req.body);
    const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
    if (!lead) { res.status(404).json({ success: false, message: 'العميل المحتمل غير موجود' }); return; }
    const activity = await prisma.leadActivity.create({
      data: { leadId: lead.id, type: body.type, content: body.content, createdBy: req.user?.name },
    });
    if (body.markContacted) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { lastContactedAt: new Date(), stage: lead.stage === 'NEW' ? 'CONTACTED' : lead.stage },
      });
    }
    res.status(201).json({ success: true, data: activity });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- تحويل لمشترك فعلي ------------------------------- //
// يضع المرحلة WON ويربط معرّف الشركة (إن وُجد). إنشاء الشركة نفسه يتم عبر مسار /tenants.
router.post('/:id/convert', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { convertedTenantId } = (req.body || {}) as { convertedTenantId?: string };
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { stage: 'WON', convertedTenantId: convertedTenantId || null },
    });
    await prisma.leadActivity.create({
      data: { leadId: lead.id, type: 'STAGE_CHANGE', content: 'تم تحويله إلى مشترك (WON)', createdBy: req.user?.name },
    });
    res.json({ success: true, data: lead });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- بحث آلي + استيراد ------------------------------- //
// ملاحظة: apify متاح هنا (بحث يدوي) وحده — وهو مستبعَد عمداً من إعداد الصيد المستمر أعلاه
// لأن دورة الـ24/7 كانت ستستنزف رصيد الشهر (1000 مكان) في نصف يوم.
const PROVIDER_ENUM = z.enum(['osm', 'geoapify', 'here', 'google', 'apollo', 'tomtom', 'serper', 'linkedin', 'apify']);
const searchSchema = z.object({
  // يدعم عدّة مصادر وعدّة أنشطة معاً (مع توافق رجعي للـ provider/query المفردين)
  providers: z.array(PROVIDER_ENUM).min(1).max(9).optional(),
  provider: PROVIDER_ENUM.optional(),
  queries: z.array(z.string().min(1)).min(1).max(10).optional(),
  query: z.string().min(1).optional(), // نوع النشاط: "تجارة جملة"، "food distributor"...
  country: z.string().optional(),       // اسم الدولة بأي لغة
  city: z.string().optional(),
  limit: z.number().int().min(1).max(120).optional(),
  qualify: z.boolean().optional(),      // تأهيل بـ Claude
  enrich: z.boolean().optional(),       // إثراء تلقائي (زيارة المواقع) بعد الاستيراد
  enrichHunter: z.boolean().optional(), // إضافة Hunter للإثراء التلقائي
}).refine((d) => (d.providers?.length || d.provider) && (d.queries?.length || d.query), {
  message: 'حدّد مصدراً واحداً على الأقل ونشاطاً واحداً على الأقل',
});
router.post('/search', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = searchSchema.parse(req.body);
    const providers = (body.providers?.length ? body.providers : [body.provider!]) as LeadProvider[];
    const queries = body.queries?.length ? body.queries : [body.query!];

    const search = await prisma.leadSearch.create({
      data: {
        provider: providers.join('+'), query: queries.join('، '), country: body.country, city: body.city,
        status: 'running', createdBy: req.user?.name,
      },
    });

    // تشغيل كل التوليفات (مصدر × نشاط)، دمج النتائج، وجمع أخطاء المصادر دون إيقاف الباقي
    const ready = providersReady();
    const rawAll: RawLead[] = [];
    const errors: string[] = [];
    for (const p of providers) {
      if (!ready[p]) { errors.push(`مصدر ${p}: يتطلّب مفتاحاً في الخادم — تخطّي`); continue; } // تخطّي مرّة واحدة بدل خطأ لكل نشاط
      for (const q of queries) {
        try {
          const r = await runSearch(p, q, body.country, body.city, body.limit);
          rawAll.push(...r);
        } catch (e) {
          errors.push(`${p} · «${q}»: ${(e as Error).message}`);
        }
      }
    }

    // إزالة التكرار الداخلي (نفس المكان من مصدر/نشاط مختلف)
    const seen = new Set<string>();
    const raw = rawAll.filter((r) => (seen.has(r.sourceId) ? false : (seen.add(r.sourceId), true)));

    // إن فشلت كل التوليفات ولا نتائج → خطأ واضح
    if (raw.length === 0 && errors.length) {
      await prisma.leadSearch.update({ where: { id: search.id }, data: { status: 'failed', error: errors.join(' | ') } });
      res.status(502).json({ success: false, message: errors.join(' | ') });
      return;
    }

    // إزالة التكرار: استبعاد ما هو موجود مسبقاً بنفس sourceId
    const ids = raw.map((r) => r.sourceId);
    const existing = await prisma.lead.findMany({
      where: { sourceId: { in: ids } },
      select: { sourceId: true },
    });
    const have = new Set(existing.map((e) => e.sourceId));
    const fresh = raw.filter((r) => !have.has(r.sourceId));

    // تأهيل اختياري بـ Claude
    let scores: Map<number, { score: number; note: string }> = new Map();
    if (body.qualify && fresh.length) {
      scores = await qualifyLeads(fresh.map((f) => ({ name: f.name, category: f.category, city: f.city, country: f.country })));
    }

    // إدراج الجدد
    let imported = 0;
    const created: { id: string; website: string | null; email: string | null; phone: string | null }[] = [];
    for (let i = 0; i < fresh.length; i++) {
      const f = fresh[i];
      const sc = scores.get(i);
      try {
        const lead = await prisma.lead.create({
          data: {
            name: f.name, phone: f.phone, email: f.email, website: f.website, address: f.address,
            city: f.city, country: f.country, countryCode: f.countryCode, category: f.category,
            lat: f.lat, lng: f.lng, mapsUrl: f.mapsUrl, source: f.source, sourceId: f.sourceId,
            score: sc?.score ?? null, scoreNote: sc?.note ?? null,
          },
        });
        await prisma.leadActivity.create({
          data: { leadId: lead.id, type: 'IMPORT', content: `بحث آلي عبر ${f.source}`, createdBy: req.user?.name },
        });
        created.push({ id: lead.id, website: lead.website, email: lead.email, phone: lead.phone });
        imported++;
      } catch {
        // تجاهل تصادم sourceId الفريد (سباق نادر)
      }
    }

    // إثراء تلقائي بعد البحث (زيارة المواقع + Hunter اختياري) للجدد الذين لديهم موقع وينقصهم تواصل
    let enrichedEmail = 0;
    if (body.enrich) {
      const toEnrich = created.filter((c) => c.website && (!c.email || !c.phone)).slice(0, 40);
      for (const c of toEnrich) {
        const found: { email?: string; phone?: string } = await enrichFromWebsite(c.website!);
        if (body.enrichHunter && !found.email) {
          const h = await hunterDomainSearch(c.website!);
          found.email = found.email || h.email;
          found.phone = found.phone || h.phone;
        }
        const data: Record<string, unknown> = {};
        if (!c.email && found.email) { data.email = found.email; enrichedEmail++; }
        if (!c.phone && found.phone) data.phone = found.phone;
        if (Object.keys(data).length) {
          await prisma.lead.update({ where: { id: c.id }, data });
          await prisma.leadActivity.create({
            data: { leadId: c.id, type: 'NOTE', content: `إثراء تلقائي: ${Object.keys(data).join('، ')}`, createdBy: req.user?.name },
          });
        }
      }
    }

    await prisma.leadSearch.update({
      where: { id: search.id },
      data: { status: 'done', found: raw.length, imported, error: errors.length ? errors.join(' | ') : null },
    });

    res.json({
      success: true,
      data: { found: raw.length, imported, duplicates: raw.length - fresh.length, enrichedEmail, errors },
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- استيراد دفعة (CSV/يدوي) ------------------------------- //
const bulkSchema = z.object({
  leads: z.array(leadCreateSchema).min(1).max(2000),
});
router.post('/import', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { leads } = bulkSchema.parse(req.body);
    let imported = 0;
    for (const l of leads) {
      try {
        await prisma.lead.create({ data: { ...l, name: l.name!, source: l.source || 'csv', phoneIsMobile: phoneIsMobile(l.phone) } });
        imported++;
      } catch {
        // تجاهل الصفوف الفاشلة (مكرّر/غير صالح)
      }
    }
    res.json({ success: true, data: { imported, total: leads.length } });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- بريد تسويقي (إرسال جماعي) ------------------------------- //
// يُرسل بريداً للعملاء المحتملين الذين لديهم بريد (ضمن الفلاتر أو قائمة معرّفات)،
// ثم ينقل من كان في مرحلة «جديد» إلى «تم التواصل» ويسجّل النشاط.
const emailSchema = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  replyTo: z.string().optional(),
  ids: z.array(z.string()).optional(),   // إرسال لقائمة محدّدة
  stage: z.string().optional(),          // أو ضمن فلاتر (مطابقة للقائمة)
  source: z.string().optional(),
  countryCode: z.string().optional(),
  q: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

// يستبدل عناصر نائبة بسيطة في النص ({{name}} / {{city}} / {{country}})
// personalize + marketingHtml مُستخرجان إلى services/marketingTemplate (مشتركان مع الإرسال التلقائي)

// إرسال نسخة تجريبية من البريد التسويقي إلى عنوان محدّد (لمعاينته في صندوق الوارد)
const emailTestSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
});
router.post('/email-test', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { to, subject, body } = emailTestSchema.parse(req.body);
    const sample = { name: 'شركتكم', city: '', country: '' };
    const html = marketingHtml(body, sample);
    try {
      await sendMarketingEmail({ subject: `[تجربة] ${personalize(subject, sample)}`, html, to });
      res.json({ success: true });
    } catch (e) {
      res.status(502).json({ success: false, message: (e as Error).message });
    }
  } catch (err) {
    next(err);
  }
});

router.post('/email', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = emailSchema.parse(req.body);
    // يستهدف من لديه بريد ولم تسبق مراسلته (بلا نشاط EMAIL) ولم يُلغِ الاشتراك — لا يُعاد الإرسال أبداً
    const where: Record<string, unknown> = {
      email: { not: null },
      activities: { none: { type: { in: ['EMAIL', 'UNSUB'] } } },
    };
    if (body.ids?.length) {
      where.id = { in: body.ids };
    } else {
      if (body.stage && STAGES.includes(body.stage as typeof STAGES[number])) where.stage = body.stage;
      if (body.source) where.source = body.source;
      if (body.countryCode) where.countryCode = body.countryCode;
      if (body.q) {
        where.OR = [
          { name: { contains: body.q, mode: 'insensitive' } },
          { city: { contains: body.q, mode: 'insensitive' } },
          { country: { contains: body.q, mode: 'insensitive' } },
        ];
      }
    }

    const cap = body.limit ?? 50;
    const leads = await prisma.lead.findMany({ where, take: cap });
    const targets = leads.filter((l) => l.email && l.email.includes('@'));

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const l of targets) {
      const subject = personalize(body.subject, l);
      const html = marketingHtml(body.body, l, { leadId: l.id, touch: 1 });
      try {
        await sendMarketingEmail({ subject, html, to: l.email!, replyTo: body.replyTo });
        sent++;
        await prisma.lead.update({
          where: { id: l.id },
          data: { lastContactedAt: new Date(), stage: l.stage === 'NEW' ? 'CONTACTED' : l.stage },
        });
        await prisma.leadActivity.create({
          data: { leadId: l.id, type: 'EMAIL', content: `بريد تسويقي: ${subject}`, createdBy: req.user?.name },
        });
      } catch (e) {
        failed++;
        if (errors.length < 3) errors.push((e as Error).message);
      }
    }

    res.json({ success: true, data: { targeted: targets.length, sent, failed, errors } });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- واتساب تسويقي آلي (Cloud API) ------------------------------- //
// إرسال جماعي آلي عبر WhatsApp Cloud API لمن لديه هاتف ولم تسبق مراسلته عبر واتساب،
// ثم NEW→CONTACTED + نشاط WHATSAPP. يدعم قالباً معتمداً (للتسويق البارد) أو نصّاً (نافذة 24س).
const waSendSchema = z.object({
  mode: z.enum(['template', 'text']).default('template'),
  text: z.string().optional(),          // وضع النص
  templateName: z.string().optional(),  // وضع القالب
  language: z.string().optional(),      // رمز لغة القالب (افتراضي ar)
  useNameParam: z.boolean().optional(), // مهجور — يُقبل ويُتجاهل (كي لا تفشل الواجهة القديمة)
  params: z.array(z.enum(['name', 'city', 'country', 'angle', 'angle_en'])).max(6).optional(),
  ids: z.array(z.string()).optional(),
  stage: z.string().optional(),
  source: z.string().optional(),
  countryCode: z.string().optional(),
  q: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).refine((d) => (d.mode === 'text' ? !!d.text : !!d.templateName), {
  message: 'حدّد نص الرسالة (وضع النص) أو اسم القالب (وضع القالب)',
});

router.post('/whatsapp-send', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (!whatsappReady()) {
      res.status(400).json({
        success: false,
        message: 'واتساب غير مُعدّ — أضِف WHATSAPP_TOKEN و WHATSAPP_PHONE_NUMBER_ID في إعدادات الخادم.',
      });
      return;
    }
    const body = waSendSchema.parse(req.body);
    const cfg = await getWaConfig();
    const language = body.language || cfg.language || 'ar';
    // ترتيب متغيّرات القالب: الطلب أولاً، وإلا الإعدادات المحفوظة (تتضمّن الزاوية افتراضياً).
    // useNameParam مهجور ويُتجاهل: كان يقصر القالب على الاسم فتضيع زاوية الدولة.
    const params: WaParam[] = body.params ?? cfg.params;

    // الحدّ اليومي يحمي تقييم جودة الرقم في Meta — تجاوزه يقود إلى تقييد الرقم لا إلى مبيعات
    const remaining = await waRemainingToday(cfg.dailyCap);
    if (remaining <= 0) {
      res.status(429).json({
        success: false,
        message: `بلغت الحدّ اليومي (${cfg.dailyCap} رسالة). يُستأنف الإرسال غداً، أو ارفع الحدّ من إعدادات الحملة.`,
      });
      return;
    }

    const where: Record<string, unknown> = {
      phone: { not: null },
      waOptOut: false, // من طلب الإيقاف لا يُراسَل مجدداً — لا استثناء
      phoneIsMobile: { not: false }, // الأرضي المؤكَّد لا واتساب له
      activities: { none: { type: 'WHATSAPP' } },
    };
    if (body.ids?.length) {
      where.id = { in: body.ids };
    } else {
      if (body.stage && STAGES.includes(body.stage as typeof STAGES[number])) where.stage = body.stage;
      if (body.source) where.source = body.source;
      if (body.countryCode) where.countryCode = body.countryCode;
      if (body.q) {
        where.OR = [
          { name: { contains: body.q, mode: 'insensitive' } },
          { city: { contains: body.q, mode: 'insensitive' } },
          { country: { contains: body.q, mode: 'insensitive' } },
        ];
      }
    }

    // الدفعة لا تتجاوز المتبقّي من الحصّة اليومية مهما طُلب
    const cap = Math.min(body.limit ?? cfg.batchSize, remaining);
    const leads = await prisma.lead.findMany({ where, take: cap });
    const targets = leads.filter((l) => waNumber(l.phone));

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const l of targets) {
      const num = waNumber(l.phone);
      const text = body.mode === 'text' ? personalize(body.text!, l) : null;
      try {
        const waId = body.mode === 'text'
          ? await sendWhatsAppText(num, text!)
          : await sendWhatsAppTemplate(num, body.templateName!, language, resolveWaParams(params, l));
        sent++;
        // سجلّ الرسالة: أساس الحدّ اليومي، ومفتاح ربط حالة التسليم والردّ لاحقاً
        await prisma.waMessage.create({
          data: {
            waId, leadId: l.id, phone: num, direction: 'OUT', status: 'SENT',
            body: text ?? `[قالب: ${body.templateName}]`,
            template: body.mode === 'template' ? body.templateName : null,
          },
        });
        await prisma.lead.update({
          where: { id: l.id },
          data: { lastContactedAt: new Date(), stage: l.stage === 'NEW' ? 'CONTACTED' : l.stage },
        });
        await prisma.leadActivity.create({
          data: { leadId: l.id, type: 'WHATSAPP', content: `واتساب تسويقي (${body.mode})`, createdBy: req.user?.name },
        });
      } catch (e) {
        failed++;
        await prisma.waMessage.create({
          data: {
            leadId: l.id, phone: num, direction: 'OUT', status: 'FAILED',
            body: text ?? `[قالب: ${body.templateName}]`,
            template: body.mode === 'template' ? body.templateName : null,
            error: (e as Error).message.slice(0, 300),
          },
        });
        if (errors.length < 3) errors.push(`${l.name}: ${(e as Error).message}`);
      }
    }

    res.json({
      success: true,
      data: { targeted: targets.length, sent, failed, errors, remainingToday: Math.max(0, remaining - sent) },
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- إثراء البيانات (بريد/هاتف ناقص) ------------------------------- //
// يزور موقع كل عميل (و/أو Hunter) ويملأ البريد/الهاتف الناقص فقط، لمن لديه موقع.
const enrichSchema = z.object({
  providers: z.array(z.enum(['website', 'hunter'])).min(1).default(['website']),
  ids: z.array(z.string()).optional(),
  stage: z.string().optional(),
  source: z.string().optional(),
  countryCode: z.string().optional(),
  q: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

router.post('/enrich', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = enrichSchema.parse(req.body);
    const useHunter = body.providers.includes('hunter');
    const useWebsite = body.providers.includes('website');

    // نستهدف من لديه موقع وينقصه بريد أو هاتف
    const where: Record<string, unknown> = {
      website: { not: null },
      OR: [{ email: null }, { phone: null }],
    };
    if (body.ids?.length) where.id = { in: body.ids };
    else {
      if (body.stage && STAGES.includes(body.stage as typeof STAGES[number])) where.stage = body.stage;
      if (body.source) where.source = body.source;
      if (body.countryCode) where.countryCode = body.countryCode;
    }

    const cap = body.limit ?? 40;
    const leads = await prisma.lead.findMany({ where, take: cap });

    let processed = 0;
    let emailFilled = 0;
    let phoneFilled = 0;
    for (const l of leads) {
      if (!l.website) continue;
      processed++;
      const found: { email?: string; phone?: string } = {};
      if (useWebsite) Object.assign(found, await enrichFromWebsite(l.website));
      if (useHunter && (!found.email)) {
        const h = await hunterDomainSearch(l.website);
        found.email = found.email || h.email;
        found.phone = found.phone || h.phone;
      }
      const data: Record<string, unknown> = {};
      if (!l.email && found.email) { data.email = found.email; emailFilled++; }
      if (!l.phone && found.phone) { data.phone = found.phone; phoneFilled++; }
      if (Object.keys(data).length) {
        await prisma.lead.update({ where: { id: l.id }, data });
        await prisma.leadActivity.create({
          data: { leadId: l.id, type: 'NOTE', content: `إثراء: ${Object.keys(data).join('، ')} من ${body.providers.join('+')}`, createdBy: req.user?.name },
        });
      }
    }

    res.json({ success: true, data: { processed, emailFilled, phoneFilled } });
  } catch (err) {
    next(err);
  }
});

// ------------------------------- تصدير CSV ------------------------------- //
router.get('/export/csv', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    // يحترم نفس فلاتر القائمة → «تصدير كل تصفية على حدة»
    const where = buildLeadWhere(req.query as Record<string, string>);
    const leads = await prisma.lead.findMany({ where, orderBy: { createdAt: 'desc' } });
    const cols = ['name', 'phone', 'email', 'website', 'address', 'city', 'country', 'category', 'stage', 'score', 'source', 'mapsUrl'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [cols.join(',')];
    for (const l of leads) rows.push(cols.map((c) => esc((l as Record<string, unknown>)[c])).join(','));
    const csv = '﻿' + rows.join('\r\n'); // BOM لضمان العربية في Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
