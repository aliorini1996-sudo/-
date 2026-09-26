/**
 * المندوب الذكي AI — المسارات (/api/ai-rep).
 *
 * خاملة عند أي شركة لم يفعّل لها المالك Tenant.aiRepEnabled: كل مسار يُردّ AI_REP_NOT_ALLOWED.
 *
 * للمندوب:
 *   GET  /me            حالة الميزة له وإعداداتها المعروضة واستهلاك اليوم
 *   POST /nearby        المحلات المستهدفة القريبة (Google) مدموجةً بسجلّ الشركة + ملخّص التوقّع لكل محل
 *   POST /estimate      توقّع مشتريات محلٍّ واحد لكل منتج (المحرّك الحتمي)
 *   POST /outcomes      نتيجة زيارة محلٍّ مقترح (منع التكرار بـclientRef)
 * لإدارة الشركة:
 *   GET/PUT /admin/settings   إعدادات الميزة + جاهزية البيانات
 *   GET/POST /admin/classify  تصنيف أنواع العملاء (مقترحٌ من الاسم تؤكّده الإدارة)
 *
 * لا نموذج لغوي هنا: القوائم والأرقام حتمية من بيانات الشركة.
 */
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { authenticate, requireAdmin, requireAdminPermission, requireSalesRep, tenantId } from '../middleware/auth';
import { customerScope, isolationEnabled } from '../services/customerScope';
import { adminScopeEnabled } from '../services/adminScope';
import { OUTLET_TYPES, OUTLET_TYPE_CODES, googleTypesFor, isOutletType, outletTypeLabel, suggestOutletType } from '../ai-rep/taxonomy';
import { aiRepSettingsSchema, repInScope, settingsView, AiRepSettingsView } from '../ai-rep/settings';
import { estimateOutlet, snapPoint, activeMonths, haversineKm, EstimateResult, MAX_PEERS } from '../ai-rep/estimate';
import { loadEstimateData, invalidateEstimateData } from '../ai-rep/estimateData';
import { placesApiKey, searchNearby } from '../ai-rep/places';
import { mergeNearby } from '../ai-rep/nearby';
import { chatCompletion, llmConfig } from '../ai-rep/llm';
import { runAdvisor, numbersIn } from '../ai-rep/advisor';
import { advisorSystemPrompt, baseAllowedNumbers, buildAdvisorTools, isValidOutletCtx, orderStops, OutletCtx } from '../ai-rep/advisorTools';
import { getCountryTax } from '../config/countries';
import { GUIDE_QUESTION, planFromText, rulePlan, ruleGuideText, PlanCandidate } from '../ai-rep/guide';
import type { NearbyPlace } from '../ai-rep/places';

const router = Router();

const NOT_ALLOWED = { success: false, code: 'AI_REP_NOT_ALLOWED', message: 'ميزة المندوب الذكي غير مفعّلة لاشتراك شركتك — تواصل مع مزوّد الخدمة لتفعيلها' };

// ───────────── أدوات مشتركة ─────────────

/** يوم الاستهلاك بتوقيت الرياض (YYYY-MM-DD). */
export function usageDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function tenantGate(tid: string): Promise<{ ok: boolean; accountingOn: boolean; countryCode: string }> {
  const [t, cs] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tid }, select: { isActive: true, aiRepEnabled: true, accountingEnabled: true } }),
    prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { countryCode: true } }),
  ]);
  // مطفأة افتراضياً: لا يمرّ إلا === true، وتعذّر القراءة يمنع
  return { ok: t?.isActive === true && t?.aiRepEnabled === true, accountingOn: t?.accountingEnabled !== false, countryCode: cs?.countryCode || 'SA' };
}

async function readSettings(tid: string): Promise<AiRepSettingsView> {
  const row = await prisma.aiRepSettings.findUnique({ where: { tenantId: tid } });
  return settingsView(row as Partial<AiRepSettingsView> | null);
}

// حارس المندوب: يُعاد فحصه في كل نداء (التوكن يعيش ٨ ساعات) بذاكرة ٣٠ ثانية لتخفيف القراءات
interface RepCtx { tid: string; repId: string; settings: AiRepSettingsView; showMoney: boolean; countryCode: string }
const repGateCache = new Map<string, { at: number; ctx: RepCtx | null }>();
const REP_GATE_TTL_MS = 30 * 1000;

export async function repContext(req: AuthRequest): Promise<RepCtx | null> {
  const tid = tenantId(req);
  const repId = req.user!.id;
  const key = `${tid}|${repId}`;
  const hit = repGateCache.get(key);
  if (hit && Date.now() - hit.at < REP_GATE_TTL_MS) return hit.ctx;
  const [gate, rep, settings] = await Promise.all([
    tenantGate(tid),
    prisma.salesRep.findFirst({ where: { id: repId, tenantId: tid }, select: { isActive: true } }),
    readSettings(tid),
  ]);
  const ctx = gate.ok && rep?.isActive === true && repInScope(settings, repId)
    ? { tid, repId, settings, showMoney: settings.showMoney && gate.accountingOn, countryCode: gate.countryCode }
    : null;
  repGateCache.set(key, { at: Date.now(), ctx });
  return ctx;
}

export function clearGateCache(tid: string): void {
  for (const k of repGateCache.keys()) if (k.startsWith(`${tid}|`)) repGateCache.delete(k);
}

type UsageField = 'searches' | 'estimates' | 'outcomes' | 'chatTurns' | 'tokensIn' | 'tokensOut' | 'guardRegen' | 'guardFallback';

async function bumpUsage(tid: string, repId: string, field: UsageField | Partial<Record<UsageField, number>>): Promise<void> {
  const day = usageDay();
  const inc = typeof field === 'string' ? { [field]: 1 } : Object.fromEntries(Object.entries(field).filter(([, v]) => (v ?? 0) > 0));
  if (!Object.keys(inc).length) return;
  await prisma.aiUsageDaily.upsert({
    where: { tenantId_salesRepId_day: { tenantId: tid, salesRepId: repId, day } },
    create: { tenantId: tid, salesRepId: repId, day, ...inc },
    update: Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, { increment: v }])),
  });
}

/** ملخّص التوقّع لسطر القائمة. */
function summarize(r: EstimateResult) {
  if (!r.ok) return { ok: false as const, eligiblePeers: r.eligiblePeers, minPeers: r.minPeers };
  return {
    ok: true as const,
    confidence: r.confidence,
    peers: r.peers,
    ringKm: r.ringKm,
    monthlyTotalValue: r.monthlyTotalValue,
    top: r.products.filter(p => p.buyers > 0).slice(0, 3).map(p => ({
      name: p.name, unit: p.unit, penetration: p.penetration, qtyMedian: p.monthlyQty?.median ?? null,
    })),
  };
}

export const MAX_ESTIMATES_PER_DAY = 300;

const latLng = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

// ═════════════ مسارات المندوب ═════════════

const rep = Router();
rep.use(authenticate, requireSalesRep);
rep.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = await repContext(req);
    if (!ctx) { res.status(403).json(NOT_ALLOWED); return; }
    (req as AuthRequest & { aiRep?: RepCtx }).aiRep = ctx;
    next();
  } catch (err) { next(err); }
});
const ctxOf = (req: AuthRequest): RepCtx => (req as AuthRequest & { aiRep: RepCtx }).aiRep;

rep.get('/me', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const usage = await prisma.aiUsageDaily.findUnique({ where: { tenantId_salesRepId_day: { tenantId: c.tid, salesRepId: c.repId, day: usageDay() } } });
    res.json({
      success: true,
      data: {
        enabled: true,
        placesConfigured: !!placesApiKey() || !!mapsBrowserKey(),
        mapsKey: mapsBrowserKey(),
        showMoney: c.showMoney,
        searchRadiusM: c.settings.searchRadiusM,
        targetTypes: c.settings.targetOutletTypes.map(code => ({ code, label: outletTypeLabel(code), google: googleTypesFor([code]) })),
        dailySearches: { used: usage?.searches ?? 0, limit: c.settings.dailySearchesPerRep },
        advisor: {
          available: c.settings.advisorEnabled && !!llmConfig(),
          reason: !c.settings.advisorEnabled ? 'DISABLED_BY_COMPANY' : !llmConfig() ? 'NOT_CONFIGURED' : null,
          used: usage?.chatTurns ?? 0,
          limit: c.settings.dailyChatTurnsPerRep,
        },
      },
    });
  } catch (err) { next(err); }
});

const nearbySchema = z.object({
  ...latLng,
  accuracyM: z.number().min(0).max(100000).optional(),
  types: z.array(z.string()).max(11).optional(),
  radiusM: z.number().int().min(100).max(10000).optional(),
});

rep.post('/nearby', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = nearbySchema.parse(req.body);
    const types = (body.types?.length ? body.types.filter(t => c.settings.targetOutletTypes.includes(t)) : c.settings.targetOutletTypes);
    if (!types.length) { res.status(400).json({ success: false, message: 'اختر نوع محل من الأنواع المستهدفة' }); return; }

    const usage = await prisma.aiUsageDaily.findUnique({ where: { tenantId_salesRepId_day: { tenantId: c.tid, salesRepId: c.repId, day: usageDay() } } });
    if ((usage?.searches ?? 0) >= c.settings.dailySearchesPerRep) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ البحث اليومي (${c.settings.dailySearchesPerRep}) — القوائم السابقة والتوقّعات تبقى متاحة` });
      return;
    }

    const radiusM = Math.min(body.radiusM ?? c.settings.searchRadiusM, 10000);
    const found = await searchNearby({ apiKey: placesApiKey(), lat: body.lat, lng: body.lng, radiusM, includedTypes: googleTypesFor(types), regionCode: c.countryCode });
    if (!found.ok) {
      res.status(found.code === 'PLACES_NOT_CONFIGURED' ? 503 : found.code === 'PLACES_QUOTA' ? 429 : 502).json({ success: false, code: found.code, message: found.message });
      return;
    }
    await bumpUsage(c.tid, c.repId, 'searches');

    const out = await mergeAndEstimate(req, c, { lat: body.lat, lng: body.lng }, radiusM, types, found.places);
    res.json({ success: true, data: { ...out, radiusM, attribution: 'Google Maps' } });
  } catch (err) { next(err); }
});


/** دمج محلات Google بسجلّ الشركة (عميل قائم، نتيجة سابقة، عزل العملاء) ثم ملخّص التوقّع لكل محل. */
async function mergeAndEstimate(req: AuthRequest, c: RepCtx, origin: { lat: number; lng: number }, radiusM: number, types: string[], places: NearbyPlace[]) {
  const body = origin;
  // عملاء الشركة حول نقطة البحث (صندوق يغطي نصف القطر + هامش المطابقة) مع رؤيتهم لهذا المندوب
  const dLat = (radiusM + 200) / 111320;
  const dLng = dLat / Math.max(0.2, Math.cos((body.lat * Math.PI) / 180));
  const placeIds = places.map(p => p.placeId);
  const [isolation, scope] = await Promise.all([isolationEnabled(c.tid), customerScope(req, c.tid)]);
  const near = await prisma.customer.findMany({
    where: {
      tenantId: c.tid,
      OR: [
        { lat: { gte: body.lat - dLat, lte: body.lat + dLat }, lng: { gte: body.lng - dLng, lte: body.lng + dLng } },
        { aiPlaceId: { in: placeIds } },
      ],
    },
    select: { id: true, lat: true, lng: true, outletType: true, aiPlaceId: true },
  });
  // الرؤية بقيد النطاق نفسه (بلا قيد ⇒ الكل) — لا فحص لمفتاح نطاق بعينه
  const vis = near.length ? await prisma.customer.findMany({ where: { tenantId: c.tid, id: { in: near.map(n => n.id) }, ...scope }, select: { id: true } }) : [];
  const visibleIds = new Set(vis.map(v => v.id));
  const outlets = await prisma.aiOutlet.findMany({
    where: { tenantId: c.tid, placeId: { in: placeIds } },
    select: { placeId: true, status: true, lastOutcome: true, lastOutcomeAt: true, convertedCustomerId: true },
  });

  const items = mergeNearby(places, {
    origin: { lat: body.lat, lng: body.lng },
    targetTypes: types,
    customers: near.map(n => ({ ...n, visible: visibleIds.has(n.id) })),
    outlets,
    isolation,
    now: new Date(),
  });

  // التوقّع: مرّة لكل (نوع، خلية) — محلات الخلية الواحدة تشترك في المحلات المشابهة نفسها
  const data = await loadEstimateData(c.tid, { windowMonths: c.settings.estimateWindowMonths, priorityProductIds: c.settings.priorityProductIds });
  const memo = new Map<string, ReturnType<typeof summarize>>();
  const withEstimates = items.map(it => {
    const cell = snapPoint(it.lat, it.lng);
    const key = `${it.outletType}|${cell.lat}|${cell.lng}`;
    let s = memo.get(key);
    if (!s) {
      s = summarize(estimateOutlet({
        target: { lat: it.lat, lng: it.lng, outletType: it.outletType, excludeCustomerId: it.customerId },
        now: new Date(), window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
        products: data.products, minPeers: c.settings.minPeers, showMoney: c.showMoney,
      }, outletTypeLabel(it.outletType)));
      memo.set(key, s);
    }
    return { ...it, outletTypeLabel: outletTypeLabel(it.outletType), estimate: s };
  });

  return { items: withEstimates, window: data.window };
}

/** مفتاح خرائط المتصفّح (Maps JavaScript + Places) — مقيَّد بنطاق الموقع في Google Cloud. */
function mapsBrowserKey(): string | null {
  const k = (process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  return k || null;
}

const estimateSchema = z.object({
  ...latLng,
  outletType: z.string().refine(isOutletType, 'نوع محل غير معروف'),
  customerId: z.string().optional(),
});

rep.post('/estimate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = estimateSchema.parse(req.body);
    // سقف يومي للتوقّعات: الأرقام مجمّعة (≥٥) لكن الاستعلام المتكرّر بمواقع مختلفة يُحدّ
    const used = await prisma.aiUsageDaily.findUnique({ where: { tenantId_salesRepId_day: { tenantId: c.tid, salesRepId: c.repId, day: usageDay() } }, select: { estimates: true } });
    if ((used?.estimates ?? 0) >= MAX_ESTIMATES_PER_DAY) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: 'بلغت حدّ التوقّعات اليومي — يتجدّد غداً' });
      return;
    }
    const data = await loadEstimateData(c.tid, { windowMonths: c.settings.estimateWindowMonths, priorityProductIds: c.settings.priorityProductIds });
    const result = estimateOutlet({
      target: { lat: body.lat, lng: body.lng, outletType: body.outletType, excludeCustomerId: body.customerId ?? null },
      now: new Date(), window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
      products: data.products, minPeers: c.settings.minPeers, showMoney: c.showMoney,
    }, outletTypeLabel(body.outletType));
    await bumpUsage(c.tid, c.repId, 'estimates');
    res.json({ success: true, data: { ...result, outletTypeLabel: outletTypeLabel(body.outletType), maxPeers: MAX_PEERS } });
  } catch (err) { next(err); }
});

export const OUTCOME_KINDS = ['INTERESTED', 'CALL_BACK', 'QUOTE', 'NOT_INTERESTED', 'CLOSED', 'EXCLUSIVE_SUPPLIER', 'CONVERTED'] as const;
const outcomeSchema = z.object({
  clientRef: z.string().uuid(),
  placeId: z.string().min(1).max(300).optional(),
  outletType: z.string().refine(isOutletType, 'نوع محل غير معروف'),
  repTypedName: z.string().trim().max(120).optional(),
  kind: z.enum(OUTCOME_KINDS),
  note: z.string().trim().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100000).optional(),
  occurredAt: z.string().datetime().optional(),
}).refine(b => !!b.placeId || !!b.repTypedName, { message: 'اكتب اسم المحل', path: ['repTypedName'] });

/** الحالة بعد النتيجة: المحوَّل يبقى محوَّلاً، والمغلق مغلق، وما عداهما مفتوح. */
export function nextOutletStatus(current: string | null, kind: string): string {
  if (current === 'CONVERTED' || kind === 'CONVERTED') return 'CONVERTED';
  if (kind === 'CLOSED') return 'CLOSED';
  return 'OPEN';
}

rep.post('/outcomes', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const b = outcomeSchema.parse(req.body);
    const dup = await prisma.aiOutletEvent.findUnique({ where: { tenantId_clientRef: { tenantId: c.tid, clientRef: b.clientRef } } });
    if (dup) { res.json({ success: true, data: { eventId: dup.id, outletId: dup.outletId }, idempotent: true }); return; }

    // لحظة الحدث من الجهاز (دون اتصال) مقيّدة: لا مستقبل ولا أقدم من ٣٠ يوماً
    const now = Date.now();
    let at = b.occurredAt ? new Date(b.occurredAt).getTime() : now;
    if (!Number.isFinite(at) || at > now + 5 * 60000 || at < now - 30 * 86400000) at = now;
    const occurredAt = new Date(at);
    const gps = b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null;

    const result = await prisma.$transaction(async tx => {
      const existing = b.placeId ? await tx.aiOutlet.findUnique({ where: { tenantId_placeId: { tenantId: c.tid, placeId: b.placeId } } }) : null;
      const status = nextOutletStatus(existing?.status ?? null, b.kind);
      const outlet = existing
        ? await tx.aiOutlet.update({
            where: { id: existing.id },
            data: {
              status, lastOutcome: b.kind, lastOutcomeAt: occurredAt, lastSalesRepId: c.repId,
              ...(b.repTypedName && { repTypedName: b.repTypedName }),
              ...(gps && { lat: gps.lat, lng: gps.lng }),
            },
          })
        : await tx.aiOutlet.create({
            data: {
              tenantId: c.tid, placeId: b.placeId ?? null, outletType: b.outletType, repTypedName: b.repTypedName ?? null,
              lat: gps?.lat ?? null, lng: gps?.lng ?? null, status, lastOutcome: b.kind, lastOutcomeAt: occurredAt,
              lastSalesRepId: c.repId, createdBySalesRepId: c.repId,
            },
          });
      const ev = await tx.aiOutletEvent.create({
        data: {
          tenantId: c.tid, outletId: outlet.id, salesRepId: c.repId, kind: b.kind, note: b.note ?? null,
          lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracyM: b.accuracyM ?? null, clientRef: b.clientRef, occurredAt,
        },
      });
      return { eventId: ev.id, outletId: outlet.id, status: outlet.status };
    });
    await bumpUsage(c.tid, c.repId, 'outcomes');
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    // سباق رفعين بالـclientRef نفسه: القيد الفريد يرفض الثاني ⇒ نعيد الأول
    if ((err as { code?: string })?.code === 'P2002') {
      const b = req.body as { clientRef?: string };
      const tid = tenantId(req);
      const dup = b.clientRef ? await prisma.aiOutletEvent.findUnique({ where: { tenantId_clientRef: { tenantId: tid, clientRef: b.clientRef } } }).catch(() => null) : null;
      if (dup) { res.json({ success: true, data: { eventId: dup.id, outletId: dup.outletId }, idempotent: true }); return; }
    }
    next(err);
  }
});

// ───────────── المستشار (محادثة) ─────────────

const chatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().trim().min(1).max(1500) })).min(1).max(8)
    .refine(m => m[m.length - 1].role === 'user', 'آخر رسالة يجب أن تكون سؤال المندوب'),
  outlets: z.array(z.object({
    ref: z.string().regex(/^P\d{1,3}$/),
    outletType: z.string(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    distanceM: z.number().min(0).max(100000),
    relation: z.enum(['NEW', 'CUSTOMER', 'POSSIBLE_CUSTOMER']),
    lastOutcome: z.string().max(40).nullable().optional(),
    customerId: z.string().max(64).nullable().optional(),
  })).max(20).optional(),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});

rep.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    if (!c.settings.advisorEnabled) { res.status(403).json({ success: false, code: 'AI_ADVISOR_DISABLED', message: 'المستشار الذكي متوقف لشركتك — القوائم والتوقّعات تعمل كالمعتاد' }); return; }
    const cfg = llmConfig();
    if (!cfg) { res.status(503).json({ success: false, code: 'AI_LLM_NOT_CONFIGURED', message: 'المستشار الذكي لم يُفعَّل بعد لدى مزوّد الخدمة — القوائم والتوقّعات تعمل كالمعتاد' }); return; }
    const body = chatSchema.parse(req.body);
    const usage = await prisma.aiUsageDaily.findUnique({ where: { tenantId_salesRepId_day: { tenantId: c.tid, salesRepId: c.repId, day: usageDay() } }, select: { chatTurns: true } });
    if ((usage?.chatTurns ?? 0) >= c.settings.dailyChatTurnsPerRep) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ أسئلة المستشار اليومي (${c.settings.dailyChatTurnsPerRep}) — القوائم والأرقام تعمل كالمعتاد` });
      return;
    }
    // عميلٌ في السياق يجب أن يكون مرئياً لهذا المندوب (عزل العملاء) — وإلا يُحذف معرّفه
    const outlets = (body.outlets ?? []).filter(o => isValidOutletCtx(o as OutletCtx)) as OutletCtx[];
    const custIds = outlets.map(o => o.customerId).filter((x): x is string => !!x);
    if (custIds.length) {
      const vis = await prisma.customer.findMany({ where: { tenantId: c.tid, id: { in: custIds }, ...(await customerScope(req, c.tid)) }, select: { id: true } });
      const ok = new Set(vis.map(v => v.id));
      for (const o of outlets) if (o.customerId && !ok.has(o.customerId)) o.customerId = null;
    }
    const [data, company] = await Promise.all([
      loadEstimateData(c.tid, { windowMonths: c.settings.estimateWindowMonths, priorityProductIds: c.settings.priorityProductIds }),
      prisma.companySettings.findUnique({ where: { tenantId: c.tid }, select: { name: true } }),
    ]);
    const actx = {
      companyName: company?.name || 'الشركة', outlets, origin: body.gps ?? null, data,
      minPeers: c.settings.minPeers, showMoney: c.showMoney, playbook: c.settings.playbook, now: new Date(),
      currency: getCountryTax(c.countryCode).currency,
    };
    const started = Date.now();
    const result = await runAdvisor({
      system: advisorSystemPrompt(actx),
      history: body.messages,
      baseAllowed: baseAllowedNumbers(actx, numbersIn),
      tools: buildAdvisorTools(actx),
      llm: r => chatCompletion(cfg, r),
    });
    if ('error' in result) {
      console.warn('[ai-rep] المستشار تعذّر:', result.code, 'tenant', c.tid);
      const status = result.code === 'LLM_RATE_LIMIT' ? 429 : 503;
      res.status(status).json({ success: false, code: 'AI_LLM_' + result.code.replace(/^LLM_/, ''), message: 'المستشار غير متاح مؤقتاً — القوائم والتوقّعات تعمل كالمعتاد، حاول بعد قليل' });
      return;
    }
    await bumpUsage(c.tid, c.repId, {
      chatTurns: 1, tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      guardRegen: result.guard === 'REGEN' ? 1 : 0, guardFallback: result.guard === 'TRIM' || result.guard === 'TEMPLATE' ? 1 : 0,
    });
    // سجلّ بلا محتوى محادثة: الشركة والقفزات والرموز والحارس والزمن
    console.info('[ai-rep] دورة مستشار', JSON.stringify({ tenant: c.tid, hops: result.hops, tools: result.toolNames, guard: result.guard, tin: result.usage.promptTokens, tout: result.usage.completionTokens, cached: result.usage.cachedTokens, ms: Date.now() - started }));
    res.json({ success: true, data: { text: result.text, refs: result.refs, guard: result.guard } });
  } catch (err) { next(err); }
});

// ───────────── الخريطة داخل التطبيق ─────────────

const analyzeSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(100).max(10000).optional(),
  types: z.array(z.string()).max(11).optional(),
  places: z.array(z.object({
    placeId: z.string().min(1).max(300),
    primaryType: z.string().max(80).nullable().optional(),
    types: z.array(z.string().max(80)).max(40).optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })).max(60),
});

rep.post('/analyze', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = analyzeSchema.parse(req.body);
    const types = (body.types?.length ? body.types.filter(t => c.settings.targetOutletTypes.includes(t)) : c.settings.targetOutletTypes);
    if (!types.length) { res.status(400).json({ success: false, message: 'اختر نوع محل من الأنواع المستهدفة' }); return; }
    const usage = await prisma.aiUsageDaily.findUnique({ where: { tenantId_salesRepId_day: { tenantId: c.tid, salesRepId: c.repId, day: usageDay() } }, select: { searches: true } });
    if ((usage?.searches ?? 0) >= c.settings.dailySearchesPerRep) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ البحث اليومي (${c.settings.dailySearchesPerRep}) — القوائم السابقة والتوقّعات تبقى متاحة` });
      return;
    }
    await bumpUsage(c.tid, c.repId, 'searches');
    const radiusM = Math.min(body.radiusM ?? c.settings.searchRadiusM, 10000);
    const places: NearbyPlace[] = body.places
      // فقط ما يقع داخل النطاق فعلاً (هامش 20٪) — لا تحليل لمحلات بعيدة أرسلها جهاز عابث
      .filter(pl => haversineKm(body.lat, body.lng, pl.lat, pl.lng) * 1000 <= radiusM * 1.2)
      .map(pl => ({ placeId: pl.placeId, name: '', address: null, lat: pl.lat, lng: pl.lng, primaryType: pl.primaryType ?? null, types: pl.types ?? [] }));
    const out = await mergeAndEstimate(req, c, { lat: body.lat, lng: body.lng }, radiusM, types, places);
    res.json({ success: true, data: { ...out, radiusM } });
  } catch (err) { next(err); }
});

// ───────────── التوجيه: فحص كل المحلات المجاورة وخطة زيارة ─────────────

const guideSchema = z.object({
  outlets: chatSchema.shape.outlets,
  gps: chatSchema.shape.gps,
});

rep.post('/guide', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = guideSchema.parse(req.body);
    const outlets = (body.outlets ?? []).filter(o => isValidOutletCtx(o as OutletCtx)) as OutletCtx[];
    const custIds = outlets.map(o => o.customerId).filter((x): x is string => !!x);
    if (custIds.length) {
      const vis = await prisma.customer.findMany({ where: { tenantId: c.tid, id: { in: custIds }, ...(await customerScope(req, c.tid)) }, select: { id: true } });
      const ok = new Set(vis.map(v => v.id));
      for (const o of outlets) if (o.customerId && !ok.has(o.customerId)) o.customerId = null;
    }
    const [data, company] = await Promise.all([
      loadEstimateData(c.tid, { windowMonths: c.settings.estimateWindowMonths, priorityProductIds: c.settings.priorityProductIds }),
      prisma.companySettings.findUnique({ where: { tenantId: c.tid }, select: { name: true } }),
    ]);
    const currency = getCountryTax(c.countryCode).currency;
    const origin = body.gps ?? null;
    const now = new Date();
    const cands = outlets.map(o => ({
      ...o,
      typeLabel: outletTypeLabel(o.outletType),
      estimate: estimateOutlet({
        target: { lat: o.lat, lng: o.lng, outletType: o.outletType, excludeCustomerId: o.customerId ?? null },
        now, window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
        products: data.products, minPeers: c.settings.minPeers, showMoney: c.showMoney,
      }, outletTypeLabel(o.outletType)),
    }));
    const byRef = new Map(cands.map(x => [x.ref, x]));
    const plan = rulePlan(cands as PlanCandidate[], origin);
    const rules = { text: ruleGuideText(plan, byRef, origin, currency), plan, source: 'RULES' as const };

    // العقل: يفحص القائمة بالأدوات ويكتب التوجيه — إن كان مفعّلاً ومضبوطاً وضمن حدّ اليوم، وإلا الخطة الحتمية
    const cfg = llmConfig();
    const used = await prisma.aiUsageDaily.findUnique({ where: { tenantId_salesRepId_day: { tenantId: c.tid, salesRepId: c.repId, day: usageDay() } }, select: { chatTurns: true } });
    if (!cfg || !c.settings.advisorEnabled || !outlets.length || (used?.chatTurns ?? 0) >= c.settings.dailyChatTurnsPerRep) {
      res.json({ success: true, data: rules }); return;
    }
    const actx = {
      companyName: company?.name || 'الشركة', outlets, origin, data, minPeers: c.settings.minPeers, showMoney: c.showMoney,
      playbook: c.settings.playbook, now, currency,
    };
    const result = await runAdvisor({
      system: advisorSystemPrompt(actx), history: [{ role: 'user', text: GUIDE_QUESTION }],
      baseAllowed: baseAllowedNumbers(actx, numbersIn), tools: buildAdvisorTools(actx), llm: r => chatCompletion(cfg, r),
    });
    if ('error' in result || result.guard === 'TEMPLATE') {
      if ('error' in result) console.warn('[ai-rep] التوجيه بالعقل تعذّر:', result.code, 'tenant', c.tid);
      res.json({ success: true, data: rules }); return;
    }
    await bumpUsage(c.tid, c.repId, {
      chatTurns: 1, tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      guardRegen: result.guard === 'REGEN' ? 1 : 0, guardFallback: result.guard === 'TRIM' ? 1 : 0,
    });
    const newRefs = new Set(cands.filter(x => x.relation === 'NEW').map(x => x.ref));
    const aiPlan = planFromText(result.text, newRefs);
    const ordered = aiPlan.length && origin ? orderStops(origin, aiPlan.map(r => byRef.get(r)!)).map(x => x.ref) : aiPlan;
    console.info('[ai-rep] توجيه', JSON.stringify({ tenant: c.tid, hops: result.hops, guard: result.guard, tin: result.usage.promptTokens, tout: result.usage.completionTokens }));
    res.json({ success: true, data: { text: result.text, plan: ordered.length ? ordered : plan, source: 'AI' } });
  } catch (err) { next(err); }
});

router.use('/rep', rep);

// ═════════════ مسارات إدارة الشركة ═════════════

const admin = Router();
admin.use(authenticate, requireAdmin);
admin.use(async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const gate = await tenantGate(tenantId(req));
    if (!gate.ok) { res.status(403).json(NOT_ALLOWED); return; }
    next();
  } catch (err) { next(err); }
});

/** جاهزية البيانات لكل نوع مستهدف: كم عميلاً مصنّفاً، وبموقع، وبمبيعات منتظمة. */
async function readiness(tid: string, settings: AiRepSettingsView) {
  const data = await loadEstimateData(tid, { windowMonths: settings.estimateWindowMonths, priorityProductIds: settings.priorityProductIds });
  const [classified, unclassified, noPin] = await Promise.all([
    prisma.customer.groupBy({ by: ['outletType'], where: { tenantId: tid, status: 'ACTIVE', outletType: { not: null } }, _count: { _all: true } }),
    prisma.customer.count({ where: { tenantId: tid, status: 'ACTIVE', outletType: null } }),
    prisma.customer.count({ where: { tenantId: tid, status: 'ACTIVE', outletType: { not: null }, OR: [{ lat: null }, { lng: null }] } }),
  ]);
  const cutoff = Date.now() - 60 * 86400000;
  const perType = OUTLET_TYPES.map(t => {
    const peers = data.peers.filter(p => p.outletType === t.code);
    const regular = peers.filter(p => p.lastInvoiceAt && p.lastInvoiceAt.getTime() >= cutoff && activeMonths(p.firstYm, data.window) >= 3).length;
    return {
      code: t.code, label: t.ar, targeted: settings.targetOutletTypes.includes(t.code),
      classified: classified.find(c => c.outletType === t.code)?._count._all ?? 0,
      withLocation: peers.length,
      withRegularSales: regular,
      ready: regular >= settings.minPeers,
    };
  });
  return { window: data.window, unclassified, classifiedWithoutLocation: noPin, perType };
}

admin.get('/settings', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const settings = await readSettings(tid);
    res.json({
      success: true,
      data: {
        settings,
        outletTypes: OUTLET_TYPES.map(t => ({ code: t.code, label: t.ar })),
        placesConfigured: !!placesApiKey() || !!mapsBrowserKey(),
        advisorConfigured: !!llmConfig(),
        readiness: await readiness(tid, settings),
      },
    });
  } catch (err) { next(err); }
});

admin.put('/settings', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) {
      res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد — إعدادات المندوب الذكي تحتاج صلاحية غير مقيدة' });
      return;
    }
    const input = aiRepSettingsSchema.parse(req.body);
    // المنتجات والمناديب يجب أن تكون ملك الشركة (لا معرّفات من شركة أخرى)
    if (input.priorityProductIds?.length) {
      const ok = await prisma.product.count({ where: { tenantId: tid, id: { in: input.priorityProductIds }, status: 'ACTIVE', deletedAt: null } });
      if (ok !== new Set(input.priorityProductIds).size) { res.status(400).json({ success: false, message: 'منتج مختار غير موجود أو غير نشط' }); return; }
    }
    if (input.repIds?.length) {
      const ok = await prisma.salesRep.count({ where: { tenantId: tid, id: { in: input.repIds } } });
      if (ok !== new Set(input.repIds).size) { res.status(400).json({ success: false, message: 'مندوب مختار غير موجود في شركتك' }); return; }
    }
    const data = {
      ...input,
      ...(input.priorityProductIds && { priorityProductIds: [...new Set(input.priorityProductIds)] }),
      ...(input.repIds && { repIds: [...new Set(input.repIds)] }),
      playbook: input.playbook === undefined ? undefined : (input.playbook || null),
      updatedById: req.user!.id,
    };
    const row = await prisma.aiRepSettings.upsert({ where: { tenantId: tid }, create: { tenantId: tid, ...data }, update: data });
    invalidateEstimateData(tid);
    clearGateCache(tid);
    res.json({ success: true, data: { settings: settingsView(row as Partial<AiRepSettingsView>) } });
  } catch (err) { next(err); }
});

admin.get('/classify', requireAdminPermission('canManageCustomers'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const filter = req.query.filter === 'all' ? 'all' : 'unclassified';
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(String(req.query.limit)) || 100));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = {
      tenantId: tid,
      status: { not: 'BLOCKED' },
      ...(await customerScope(req, tid)),
      ...(filter === 'unclassified' && { outletType: null }),
      ...(search && { OR: [{ name: { contains: search } }, { businessName: { contains: search } }] }),
    };
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where, skip: (page - 1) * limit, take: limit, orderBy: { name: 'asc' },
        select: { id: true, name: true, businessName: true, district: true, city: true, outletType: true, lat: true, lng: true },
      }),
      prisma.customer.count({ where }),
    ]);
    res.json({
      success: true,
      data: rows.map(r => ({
        id: r.id, name: r.name, businessName: r.businessName, district: r.district, city: r.city,
        outletType: r.outletType, suggested: r.outletType ? null : suggestOutletType(r.businessName, r.name),
        hasLocation: r.lat != null && r.lng != null,
      })),
      pagination: { page, limit, total },
    });
  } catch (err) { next(err); }
});

const classifySchema = z.object({
  items: z.array(z.object({
    customerId: z.string().min(1),
    outletType: z.enum(OUTLET_TYPE_CODES as unknown as [string, ...string[]]).nullable(),
  })).min(1).max(500),
});

admin.post('/classify', requireAdminPermission('canManageCustomers'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const { items } = classifySchema.parse(req.body);
    const scope = await customerScope(req, tid);
    const allowed = await prisma.customer.findMany({ where: { tenantId: tid, id: { in: items.map(i => i.customerId) }, ...scope }, select: { id: true } });
    const ok = new Set(allowed.map(a => a.id));
    // تجميع حسب النوع: تحديثٌ واحد لكل نوع بدل صفّ صفّ
    const byType = new Map<string | null, string[]>();
    for (const it of items) {
      if (!ok.has(it.customerId)) continue;
      const list = byType.get(it.outletType) ?? [];
      list.push(it.customerId);
      byType.set(it.outletType, list);
    }
    let updated = 0;
    await prisma.$transaction(async tx => {
      for (const [outletType, ids] of byType) {
        const r = await tx.customer.updateMany({ where: { tenantId: tid, id: { in: ids } }, data: { outletType } });
        updated += r.count;
      }
    });
    invalidateEstimateData(tid);
    res.json({ success: true, data: { updated, skipped: items.length - updated } });
  } catch (err) { next(err); }
});

router.use('/admin', admin);

// قائمة الأنواع (ثابتة) — لأي مستخدم مسجّل في شركة مفعّلة
router.get('/types', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const gate = await tenantGate(tenantId(req));
    if (!gate.ok) { res.status(403).json(NOT_ALLOWED); return; }
    res.json({ success: true, data: OUTLET_TYPES.map(t => ({ code: t.code, label: t.ar })) });
  } catch (err) { next(err); }
});

export default router;
