/**
 * المندوب الذكي AI — المسارات (/api/ai-rep).
 *
 * خاملة عند أي شركة لم يفعّل لها المالك Tenant.aiRepEnabled: كل مسار يُردّ AI_REP_NOT_ALLOWED.
 *
 * للمندوب:
 *   GET  /rep/me         حالة الميزة له وإعداداتها واستهلاك اليوم ومفتاح الخريطة (عرض فقط)
 *   POST /rep/nearby     بحث المحلات المستهدفة حول المندوب (Google من الخادم وحده، بحصة محجوزة ذرّياً)،
 *                        مدموجةً بسجلّ الشركة + ملخّص التوقّع — ويحفظ الخادم «جلسة البحث» بمراجع ثابتة P1…
 *   POST /rep/estimate   توقّع مشتريات محلٍّ من الجلسة لكل منتج (بالمرجع لا بإحداثيات من الجهاز)
 *   POST /rep/guide      التوجيه: العقل يفحص محلات الجلسة ويكتب خطة (أو خطة حتمية)
 *   POST /rep/chat       أسئلة المندوب الحرّة للمستشار
 *   POST /rep/outcomes   نتيجة زيارة محلٍّ مقترح (منع التكرار بـclientRef؛ تُرفع من صفّ الإرسال دون اتصال)
 * لإدارة الشركة:
 *   GET/PUT /admin/settings   إعدادات الميزة + جاهزية البيانات
 *   GET/POST /admin/classify  تصنيف أنواع العملاء (مقترحٌ من الاسم تؤكّده الإدارة)
 *
 * الأرقام كلها من المحرّك الحتمي؛ العقل يشرح ولا يخترع (حارس الأرقام في advisor.ts).
 * الإحداثيات والمراجع لا تأتي من الجهاز بعد البحث — فلا تلفيق نقاط لكشف عملاء الزملاء ولا استعلام عند إحداثيات حرّة.
 */
import { Router, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { authenticate, requireAdmin, requireAdminPermission, requireSalesRep, tenantId } from '../middleware/auth';
import { customerScope, isolationEnabled } from '../services/customerScope';
import { adminScopeEnabled } from '../services/adminScope';
import { OUTLET_TYPES, OUTLET_TYPE_CODES, googleTypesFor, isOutletType, outletTypeLabel, suggestOutletType } from '../ai-rep/taxonomy';
import { aiRepSettingsSchema, repInScope, settingsView, AiRepSettingsView } from '../ai-rep/settings';
import { estimateOutlet, snapPoint, activeMonths, EstimateResult, MAX_PEERS } from '../ai-rep/estimate';
import { loadEstimateData, invalidateEstimateData, TenantEstimateData } from '../ai-rep/estimateData';
import { placesApiKey, searchNearby, NearbyPlace } from '../ai-rep/places';
import { mergeNearby } from '../ai-rep/nearby';
import { chatCompletion, llmConfig } from '../ai-rep/llm';
import { runAdvisor, numbersIn } from '../ai-rep/advisor';
import { advisorSystemPrompt, baseAllowedNumbers, buildAdvisorTools, OutletCtx } from '../ai-rep/advisorTools';
import { getCountryTax } from '../config/countries';
import { GUIDE_QUESTION, planEligible, planFromText, rulePlan, ruleGuideText, PlanCandidate } from '../ai-rep/guide';
import { addUsage, refundUsage, reserveUsage, usageDay, usageToday } from '../ai-rep/usage';
import { getSession, patchSessionOutlet, saveSession, SessionOutlet } from '../ai-rep/session';

export { usageDay };

const router = Router();

const NOT_ALLOWED = { success: false, code: 'AI_REP_NOT_ALLOWED', message: 'ميزة المندوب الذكي غير مفعّلة لاشتراك شركتك — تواصل مع مزوّد الخدمة لتفعيلها' };
const NO_SESSION = { success: false, code: 'AI_REP_SEARCH_EXPIRED', message: 'انتهت نتيجة البحث — اضغط «ابحث عن فرص حولي» من جديد' };

// ───────────── أدوات مشتركة ─────────────

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

/** ملخّص التوقّع لسطر القائمة (الأصناف المحجوبة لا تدخل «الأعلى»). */
function summarize(r: EstimateResult) {
  if (!r.ok) return { ok: false as const, eligiblePeers: r.eligiblePeers, minPeers: r.minPeers };
  return {
    ok: true as const,
    confidence: r.confidence,
    peers: r.peers,
    ringKm: r.ringKm,
    monthlyTotalValue: r.monthlyTotalValue,
    top: r.products.filter(p => (p.buyers ?? 0) > 0 && p.penetration != null).slice(0, 3).map(p => ({
      name: p.name, unit: p.unit, penetration: p.penetration, qtyMedian: p.monthlyQty?.median ?? null,
    })),
  };
}

export const MAX_ESTIMATES_PER_DAY = 300;

/** مفتاح خرائط المتصفّح — **لعرض الخريطة وحده** (Maps JavaScript API)، مقيَّد بنطاق الموقع وحصة يومية في Google Cloud. */
function mapsBrowserKey(): string | null {
  const k = (process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim();
  if (!k || k === placesApiKey()) return null; // مفتاح الخادم لا يغادر الخادم أبداً
  return k;
}

function estimateAt(c: RepCtx, data: TenantEstimateData, o: { lat: number; lng: number; outletType: string; customerId: string | null }): EstimateResult {
  return estimateOutlet({
    target: { lat: o.lat, lng: o.lng, outletType: o.outletType, excludeCustomerId: o.customerId },
    now: new Date(), window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
    products: data.products, minPeers: c.settings.minPeers, showMoney: c.showMoney,
  }, outletTypeLabel(o.outletType));
}

const loadData = (c: RepCtx) => loadEstimateData(c.tid, { windowMonths: c.settings.estimateWindowMonths, priorityProductIds: c.settings.priorityProductIds });

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
    const usage = await usageToday(c.tid, c.repId);
    res.json({
      success: true,
      data: {
        enabled: true,
        placesConfigured: !!placesApiKey(),
        mapsKey: mapsBrowserKey(),
        showMoney: c.showMoney,
        searchRadiusM: c.settings.searchRadiusM,
        minPeers: c.settings.minPeers,
        targetTypes: c.settings.targetOutletTypes.map(code => ({ code, label: outletTypeLabel(code) })),
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
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).optional(),
  types: z.array(z.string()).max(11).optional(),
});

rep.post('/nearby', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = nearbySchema.parse(req.body);
    const types = (body.types?.length ? body.types.filter(t => c.settings.targetOutletTypes.includes(t)) : c.settings.targetOutletTypes);
    if (!types.length) { res.status(400).json({ success: false, message: 'اختر نوع محل من الأنواع المستهدفة' }); return; }
    const apiKey = placesApiKey();
    if (!apiKey) { res.status(503).json({ success: false, code: 'PLACES_NOT_CONFIGURED', message: 'مفتاح خرائط Google لم يُضبط بعد — تواصل مع مزوّد الخدمة' }); return; }
    // الحجز قبل نداء Google (كلفة): ذرّيّ فلا تتجاوزه الطلبات المتزامنة
    if (!(await reserveUsage(c.tid, c.repId, 'searches', c.settings.dailySearchesPerRep))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ البحث اليومي (${c.settings.dailySearchesPerRep}) — نتائجك الحالية تبقى متاحة` });
      return;
    }
    // نطاق البحث من إعداد الشركة وحده (لا يوسّعه الجهاز)
    const radiusM = c.settings.searchRadiusM;
    const found = await searchNearby({ apiKey, lat: body.lat, lng: body.lng, radiusM, includedTypes: googleTypesFor(types), regionCode: c.countryCode });
    if (!found.ok) {
      await refundUsage(c.tid, c.repId, 'searches');
      res.status(found.code === 'PLACES_QUOTA' ? 429 : 502).json({ success: false, code: found.code, message: found.message });
      return;
    }
    const origin = { lat: body.lat, lng: body.lng };
    const out = await mergeAndEstimate(req, c, origin, radiusM, types, found.places);
    const searchId = randomUUID();
    saveSession(c.tid, c.repId, {
      searchId, createdAt: Date.now(), origin, radiusM,
      outlets: out.items.map(it => ({
        ref: it.ref, placeId: it.placeId, outletType: it.outletType, lat: it.lat, lng: it.lng, distanceM: it.distanceM,
        relation: it.relation, lastOutcome: it.lastOutcome, customerId: it.customerId,
      })),
    });
    res.json({ success: true, data: { searchId, items: out.items, window: out.window, radiusM, attribution: 'Google Maps' } });
  } catch (err) { next(err); }
});

/** دمج محلات Google بسجلّ الشركة (عميل قائم، نتيجة سابقة، عزل العملاء)، ومراجع ثابتة P1…، وملخّص التوقّع لكل محل. */
async function mergeAndEstimate(req: AuthRequest, c: RepCtx, origin: { lat: number; lng: number }, radiusM: number, types: string[], places: NearbyPlace[]) {
  const dLat = (radiusM + 200) / 111320;
  const dLng = dLat / Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  const placeIds = places.map(p => p.placeId);
  const [isolation, scope] = await Promise.all([isolationEnabled(c.tid), customerScope(req, c.tid)]);
  const near = await prisma.customer.findMany({
    where: {
      tenantId: c.tid,
      OR: [
        { lat: { gte: origin.lat - dLat, lte: origin.lat + dLat }, lng: { gte: origin.lng - dLng, lte: origin.lng + dLng } },
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
    origin, targetTypes: types, customers: near.map(n => ({ ...n, visible: visibleIds.has(n.id) })), outlets, isolation, now: new Date(),
  });
  // التوقّع: مرّة لكل (نوع، خلية، عميل مستبعَد) — العميل القائم لا يدخل ضمن المحلات المشابهة له نفسه
  const data = await loadData(c);
  const memo = new Map<string, ReturnType<typeof summarize>>();
  const withEstimates = items.map((it, i) => {
    const cell = snapPoint(it.lat, it.lng);
    const key = `${it.outletType}|${cell.lat}|${cell.lng}|${it.customerId ?? ''}`;
    let s = memo.get(key);
    if (!s) { s = summarize(estimateAt(c, data, it)); memo.set(key, s); }
    return { ...it, ref: `P${i + 1}`, outletTypeLabel: outletTypeLabel(it.outletType), estimate: s };
  });
  return { items: withEstimates, window: data.window };
}

const estimateSchema = z.object({ searchId: z.string().uuid(), ref: z.string().regex(/^P\d{1,3}$/) });

rep.post('/estimate', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = estimateSchema.parse(req.body);
    const s = getSession(c.tid, c.repId, body.searchId);
    const o = s?.outlets.find(x => x.ref === body.ref);
    if (!s || !o) { res.status(409).json(NO_SESSION); return; }
    if (!(await reserveUsage(c.tid, c.repId, 'estimates', MAX_ESTIMATES_PER_DAY))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: 'بلغت حدّ التوقّعات اليومي — يتجدّد غداً' });
      return;
    }
    const result = estimateAt(c, await loadData(c), o);
    res.json({ success: true, data: { ...result, outletTypeLabel: outletTypeLabel(o.outletType), maxPeers: MAX_PEERS, minPeers: c.settings.minPeers } });
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
    if (b.placeId) patchSessionOutlet(c.tid, c.repId, b.placeId, { lastOutcome: b.kind, ...(b.kind === 'CLOSED' && { closed: true }) });
    await addUsage(c.tid, c.repId, { outcomes: 1 });
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

// ───────────── العقل: التوجيه والمحادثة ─────────────

function toOutletCtx(o: SessionOutlet): OutletCtx {
  return { ref: o.ref, outletType: o.outletType, lat: o.lat, lng: o.lng, distanceM: o.distanceM, relation: o.relation, lastOutcome: o.lastOutcome, customerId: o.customerId, closed: o.closed };
}

async function advisorContext(c: RepCtx, outlets: OutletCtx[], origin: { lat: number; lng: number } | null) {
  const [data, company] = await Promise.all([
    loadData(c),
    prisma.companySettings.findUnique({ where: { tenantId: c.tid }, select: { name: true } }),
  ]);
  return {
    companyName: company?.name || 'الشركة', outlets, origin, data, minPeers: c.settings.minPeers, showMoney: c.showMoney,
    playbook: c.settings.playbook, now: new Date(), currency: getCountryTax(c.countryCode).currency,
  };
}

const guideSchema = z.object({ searchId: z.string().uuid() });

rep.post('/guide', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const body = guideSchema.parse(req.body);
    const s = getSession(c.tid, c.repId, body.searchId);
    if (!s) { res.status(409).json(NO_SESSION); return; }
    const outlets = s.outlets.map(toOutletCtx);
    const actx = await advisorContext(c, outlets, s.origin);
    const cands = s.outlets.map(o => ({ ...o, typeLabel: outletTypeLabel(o.outletType), estimate: estimateAt(c, actx.data, o) }));
    const byRef = new Map(cands.map(x => [x.ref, x]));
    const plan = rulePlan(cands as PlanCandidate[], s.origin);
    const rules = { text: ruleGuideText(plan, byRef, s.origin, actx.currency), plan, source: 'RULES' as const };

    // العقل: إن كان مفعّلاً ومضبوطاً — والدورة تُحجز ذرّياً قبل النداء، وإلا الخطة الحتمية (لا كلفة نموذج)
    const cfg = llmConfig();
    if (!cfg || !c.settings.advisorEnabled || !outlets.some(o => !o.closed)) { res.json({ success: true, data: rules }); return; }
    if (!(await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep))) { res.json({ success: true, data: rules }); return; }
    const result = await runAdvisor({
      system: advisorSystemPrompt(actx), history: [{ role: 'user', text: GUIDE_QUESTION }],
      baseAllowed: baseAllowedNumbers(actx, numbersIn), tools: buildAdvisorTools(actx), llm: r => chatCompletion(cfg, r),
    });
    // الرموز تُحتسب في كل الأحوال — ومنها الفشل والقالب
    await addUsage(c.tid, c.repId, {
      tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      guardRegen: 'guard' in result && result.guard === 'REGEN' ? 1 : 0,
      guardFallback: 'guard' in result && (result.guard === 'TRIM' || result.guard === 'TEMPLATE') ? 1 : 0,
    });
    if ('error' in result || result.guard === 'TEMPLATE') {
      if ('error' in result) console.warn('[ai-rep] التوجيه بالعقل تعذّر:', result.code, 'tenant', c.tid);
      res.json({ success: true, data: rules }); return;
    }
    // خطة العقل بترتيب خطواته المرقّمة (بلا إعادة ترتيب تناقض نصّه)، ومن الفرص الجديدة غير المرفوضة وحدها
    const aiPlan = planFromText(result.text, planEligible(cands));
    console.info('[ai-rep] توجيه', JSON.stringify({ tenant: c.tid, hops: result.hops, guard: result.guard, tin: result.usage.promptTokens, tout: result.usage.completionTokens }));
    res.json({ success: true, data: { text: result.text, plan: aiPlan.length ? aiPlan : plan, source: 'AI' } });
  } catch (err) { next(err); }
});

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(6000),
  })).min(1).max(8)
    .refine(m => m[m.length - 1].role === 'user', 'آخر رسالة يجب أن تكون سؤال المندوب')
    .refine(m => m.every(x => x.role === 'assistant' || x.text.length <= 1500), 'السؤال أطول من 1500 حرف'),
  searchId: z.string().uuid().optional(),
});

rep.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    if (!c.settings.advisorEnabled) { res.status(403).json({ success: false, code: 'AI_ADVISOR_DISABLED', message: 'المستشار الذكي متوقف لشركتك — القوائم والتوقّعات تعمل كالمعتاد' }); return; }
    const cfg = llmConfig();
    if (!cfg) { res.status(503).json({ success: false, code: 'AI_LLM_NOT_CONFIGURED', message: 'المستشار الذكي لم يُفعَّل بعد لدى مزوّد الخدمة — القوائم والتوقّعات تعمل كالمعتاد' }); return; }
    const body = chatSchema.parse(req.body);
    const s = body.searchId ? getSession(c.tid, c.repId, body.searchId) : null;
    if (body.searchId && !s) { res.status(409).json(NO_SESSION); return; }
    if (!(await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ أسئلة المستشار اليومي (${c.settings.dailyChatTurnsPerRep}) — القوائم والأرقام تعمل كالمعتاد` });
      return;
    }
    const actx = await advisorContext(c, s ? s.outlets.map(toOutletCtx) : [], s?.origin ?? null);
    const started = Date.now();
    const result = await runAdvisor({
      system: advisorSystemPrompt(actx),
      // ردود المستشار السابقة تُقصّ (لا تُرفض) — والأسئلة محدودة بـ1500
      history: body.messages.map(m => ({ role: m.role, text: m.role === 'assistant' ? m.text.slice(0, 3000) : m.text })),
      baseAllowed: baseAllowedNumbers(actx, numbersIn),
      tools: buildAdvisorTools(actx),
      llm: r => chatCompletion(cfg, r),
    });
    await addUsage(c.tid, c.repId, {
      tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      guardRegen: 'guard' in result && result.guard === 'REGEN' ? 1 : 0,
      guardFallback: 'guard' in result && (result.guard === 'TRIM' || result.guard === 'TEMPLATE') ? 1 : 0,
    });
    if ('error' in result) {
      console.warn('[ai-rep] المستشار تعذّر:', result.code, 'tenant', c.tid);
      res.status(result.code === 'LLM_RATE_LIMIT' ? 429 : 503).json({ success: false, code: 'AI_' + result.code, message: 'المستشار غير متاح مؤقتاً — القوائم والتوقّعات تعمل كالمعتاد، حاول بعد قليل' });
      return;
    }
    // سجلّ بلا محتوى محادثة: الشركة والقفزات والرموز والحارس والزمن
    console.info('[ai-rep] دورة مستشار', JSON.stringify({ tenant: c.tid, hops: result.hops, tools: result.toolNames, guard: result.guard, tin: result.usage.promptTokens, tout: result.usage.completionTokens, cached: result.usage.cachedTokens, ms: Date.now() - started }));
    res.json({ success: true, data: { text: result.text, refs: result.refs, guard: result.guard, searchId: s?.searchId ?? null } });
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
    if (await adminScopeEnabled(req)) {
      res.status(403).json({ success: false, message: 'حسابك مقيد بنطاق محدد — إعدادات المندوب الذكي تحتاج صلاحية غير مقيدة' });
      return;
    }
    const settings = await readSettings(tid);
    res.json({
      success: true,
      data: {
        settings,
        outletTypes: OUTLET_TYPES.map(t => ({ code: t.code, label: t.ar })),
        placesConfigured: !!placesApiKey(),
        mapsConfigured: !!mapsBrowserKey(),
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
    let priority = input.priorityProductIds;
    if (priority?.length) {
      const valid = await prisma.product.findMany({ where: { tenantId: tid, id: { in: priority }, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
      const ok = new Set(valid.map(v => v.id));
      priority = [...new Set(priority)].filter(id => ok.has(id));
    }
    if (input.repIds?.length) {
      const ok = await prisma.salesRep.count({ where: { tenantId: tid, id: { in: input.repIds } } });
      if (ok !== new Set(input.repIds).size) { res.status(400).json({ success: false, message: 'مندوب مختار غير موجود في شركتك' }); return; }
    }
    const data = {
      ...input,
      ...(priority && { priorityProductIds: priority }),
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
