import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { runSearch, qualifyLeads, LeadProvider, RawLead, providersReady } from '../services/leadSources';
import { sendMarketingEmail, marketingProvider } from '../services/marketingMailer';
import { whatsappReady, waNumber, sendWhatsAppText, sendWhatsAppTemplate } from '../services/whatsapp';
import { enrichFromWebsite, hunterDomainSearch, hunterReady } from '../services/enrich';

// إدارة العملاء المحتملين (Leads) — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
router.use(authenticate, requireSuperAdmin);

const STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'] as const;

// بناء شرط التصفية المشترك (تستخدمه القائمة والتصدير) من معاملات الاستعلام
function buildLeadWhere(query: Record<string, string>): Record<string, unknown> {
  const { stage, source, countryCode, q, assignedTo, dueOnly, hasEmail, hasPhone, hasWebsite, emailed, whatsapped } = query;
  const where: Record<string, unknown> = {};
  if (stage && STAGES.includes(stage as typeof STAGES[number])) where.stage = stage;
  if (source) where.source = source;
  if (countryCode) where.countryCode = countryCode;
  if (assignedTo) where.assignedTo = assignedTo;
  if (dueOnly === 'true') where.nextFollowUpAt = { lte: new Date() };
  if (hasEmail === 'true') where.email = { not: null };
  else if (query.noEmail === 'true') where.email = null;
  if (hasPhone === 'true') where.phone = { not: null };
  else if (query.noPhone === 'true') where.phone = null;
  if (hasWebsite === 'true') where.website = { not: null };
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
    const [byStage, bySource, byCountry, total, won, due] = await Promise.all([
      prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['source'], _count: { _all: true } }),
      prisma.lead.groupBy({ by: ['countryCode'], _count: { _all: true } }),
      prisma.lead.count(),
      prisma.lead.count({ where: { stage: 'WON' } }),
      prisma.lead.count({ where: { nextFollowUpAt: { lte: new Date() }, stage: { notIn: ['WON', 'LOST'] } } }),
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
router.get('/whatsapp-status', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { ready: whatsappReady() } });
});

// حالة الإثراء (هل Hunter مُعدّ؟) — قبل /:id
router.get('/enrich-status', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: { hunter: hunterReady() } });
});

// أي مصادر البحث جاهزة (لها مفتاح)؟ — قبل /:id
router.get('/sources-status', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: providersReady() });
});

// مزوّد البريد التسويقي الحالي وحصّته اليومية — قبل /:id
router.get('/email-status', (_req: AuthRequest, res: Response) => {
  const provider = marketingProvider();
  res.json({ success: true, data: { provider, dailyCap: provider === 'brevo' ? 300 : 100 } });
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
const PROVIDER_ENUM = z.enum(['osm', 'geoapify', 'here', 'google', 'apollo', 'tomtom', 'serper', 'linkedin']);
const searchSchema = z.object({
  // يدعم عدّة مصادر وعدّة أنشطة معاً (مع توافق رجعي للـ provider/query المفردين)
  providers: z.array(PROVIDER_ENUM).min(1).max(8).optional(),
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
        await prisma.lead.create({ data: { ...l, name: l.name!, source: l.source || 'csv' } });
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
function personalize(text: string, lead: { name: string; city?: string | null; country?: string | null }): string {
  return text
    .replace(/\{\{\s*name\s*\}\}/g, lead.name || '')
    .replace(/\{\{\s*city\s*\}\}/g, lead.city || '')
    .replace(/\{\{\s*country\s*\}\}/g, lead.country || '');
}

// قالب بريد تسويقي بهوية Field Sales
function marketingHtml(bodyText: string, lead: { name: string; city?: string | null; country?: string | null }): string {
  const safe = personalize(bodyText, lead)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:20px 24px"><span style="font-size:20px;font-weight:700;color:#fff">Field<span style="color:#E15A30"> Sales</span></span></div>
      <div style="padding:22px 24px;color:#3a342b;font-size:15px;line-height:1.9">${safe}</div>
      <div style="padding:16px 24px;border-top:1px solid #F1EBDF">
        <a href="https://fieldsa.net" style="display:inline-block;background:#E15A30;color:#fff;text-decoration:none;padding:11px 24px;border-radius:10px;font-weight:600">اكتشف Field Sales</a>
      </div>
      <div style="padding:12px 24px;color:#9A8F7E;font-size:12px;border-top:1px solid #F1EBDF">
        رسالة أعمال من Field Sales · fieldsa.net · إن لم ترغب بتلقّي رسائلنا، ردّ بكلمة «إلغاء».
      </div>
    </div>
  </div>`;
}

router.post('/email', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = emailSchema.parse(req.body);
    // يستهدف من لديه بريد ولم تسبق مراسلته (بلا نشاط EMAIL) — لا يُعاد الإرسال أبداً
    const where: Record<string, unknown> = {
      email: { not: null },
      activities: { none: { type: 'EMAIL' } },
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
    for (const l of targets) {
      const subject = personalize(body.subject, l);
      const html = marketingHtml(body.body, l);
      const ok = await sendMarketingEmail({ subject, html, to: l.email!, replyTo: body.replyTo });
      if (ok) {
        sent++;
        await prisma.lead.update({
          where: { id: l.id },
          data: { lastContactedAt: new Date(), stage: l.stage === 'NEW' ? 'CONTACTED' : l.stage },
        });
        await prisma.leadActivity.create({
          data: { leadId: l.id, type: 'EMAIL', content: `بريد تسويقي: ${subject}`, createdBy: req.user?.name },
        });
      } else {
        failed++;
      }
    }

    res.json({ success: true, data: { targeted: targets.length, sent, failed } });
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
  useNameParam: z.boolean().optional(), // إدراج اسم العميل كأول متغيّر {{1}}
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
    const language = body.language || 'ar';

    const where: Record<string, unknown> = {
      phone: { not: null },
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

    const cap = body.limit ?? 50;
    const leads = await prisma.lead.findMany({ where, take: cap });
    const targets = leads.filter((l) => waNumber(l.phone));

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const l of targets) {
      const num = waNumber(l.phone);
      try {
        if (body.mode === 'text') {
          await sendWhatsAppText(num, personalize(body.text!, l));
        } else {
          await sendWhatsAppTemplate(num, body.templateName!, language, body.useNameParam ? [l.name] : []);
        }
        sent++;
        await prisma.lead.update({
          where: { id: l.id },
          data: { lastContactedAt: new Date(), stage: l.stage === 'NEW' ? 'CONTACTED' : l.stage },
        });
        await prisma.leadActivity.create({
          data: { leadId: l.id, type: 'WHATSAPP', content: `واتساب تسويقي (${body.mode})`, createdBy: req.user?.name },
        });
      } catch (e) {
        failed++;
        if (errors.length < 3) errors.push(`${l.name}: ${(e as Error).message}`);
      }
    }

    res.json({ success: true, data: { targeted: targets.length, sent, failed, errors } });
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
