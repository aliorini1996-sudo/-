import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { runSearch, qualifyLeads, LeadProvider } from '../services/leadSources';
import { sendMail } from '../services/mailer';

// إدارة العملاء المحتملين (Leads) — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
router.use(authenticate, requireSuperAdmin);

const STAGES = ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'] as const;

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
    const { stage, source, countryCode, q, assignedTo, dueOnly } = req.query as Record<string, string>;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));

    const where: Record<string, unknown> = {};
    if (stage && STAGES.includes(stage as typeof STAGES[number])) where.stage = stage;
    if (source) where.source = source;
    if (countryCode) where.countryCode = countryCode;
    if (assignedTo) where.assignedTo = assignedTo;
    if (dueOnly === 'true') where.nextFollowUpAt = { lte: new Date() };
    if ((req.query.hasEmail as string) === 'true') where.email = { not: null };
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
        { country: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
      ];
    }

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
  type: z.enum(['NOTE', 'CALL', 'EMAIL', 'MEETING']).default('NOTE'),
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
const searchSchema = z.object({
  provider: z.enum(['osm', 'geoapify', 'here', 'google']).default('osm'),
  query: z.string().min(1),       // نوع النشاط: "تجارة جملة"، "food distributor"...
  country: z.string().optional(), // اسم الدولة بأي لغة
  city: z.string().optional(),
  limit: z.number().int().min(1).max(120).optional(),
  qualify: z.boolean().optional(), // تأهيل بـ Claude
});
router.post('/search', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = searchSchema.parse(req.body);
    const search = await prisma.leadSearch.create({
      data: {
        provider: body.provider, query: body.query, country: body.country, city: body.city,
        status: 'running', createdBy: req.user?.name,
      },
    });

    let raw;
    try {
      raw = await runSearch(body.provider as LeadProvider, body.query, body.country, body.city, body.limit);
    } catch (e) {
      await prisma.leadSearch.update({
        where: { id: search.id },
        data: { status: 'failed', error: (e as Error).message },
      });
      res.status(502).json({ success: false, message: (e as Error).message });
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
        imported++;
      } catch {
        // تجاهل تصادم sourceId الفريد (سباق نادر)
      }
    }

    await prisma.leadSearch.update({
      where: { id: search.id },
      data: { status: 'done', found: raw.length, imported },
    });

    res.json({ success: true, data: { found: raw.length, imported, duplicates: raw.length - fresh.length } });
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
    const where: Record<string, unknown> = { email: { not: null } };
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
      const ok = await sendMail({ subject, html, to: l.email!, replyTo: body.replyTo });
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

// ------------------------------- تصدير CSV ------------------------------- //
router.get('/export/csv', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const leads = await prisma.lead.findMany({ orderBy: { createdAt: 'desc' } });
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
