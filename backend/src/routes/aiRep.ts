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
 *   GET  /admin/hidden-outlets             المحلات المخفية عن المسح («أُغلق نهائياً / لم أجده» مؤكَّداً) ومن أبلغ عنها
 *   POST /admin/hidden-outlets/:id/unhide  «أعد إظهاره»
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
import { OUTLET_TYPES, OUTLET_TYPE_CODES, googleTypesFor, isOutletType, outletTypeFromGoogle, outletTypeLabel, suggestOutletType } from '../ai-rep/taxonomy';
import { aiRepSettingsSchema, repInScope, settingsView, AiRepSettingsView } from '../ai-rep/settings';
import { estimateOutlet, snapPoint, activeMonths, haversineKm, EstimateResult, MAX_PEERS } from '../ai-rep/estimate';
import { loadEstimateData, invalidateEstimateData, TenantEstimateData } from '../ai-rep/estimateData';
import { isGooglePlaceId, placeProfile, placesApiKey, searchNearby, NearbyPlace, type PlaceReview } from '../ai-rep/places';
import { notePublicScanShops, noteRepScanFailed, publicScan, REP_RETRY_MS, repRetryLeftMs } from '../ai-rep/publicMaps';
import { aiGuide, ruleGuide, type ScanGuide, type ScanShop } from '../ai-rep/scanGuide';
import { aiStudy, ruleStudy, type ShopStudy } from '../ai-rep/profileStudy';
import { CLOSED_KINDS, CLOSED_MEMORY_DAYS, customerBox, mergeNearby, sameDay } from '../ai-rep/nearby';
import { chatCompletion, llmConfig } from '../ai-rep/llm';
import { isGoogleMapsUrl, resolveLocationUrl } from '../services/geoLink';
import { runAdvisor, numbersIn, scrubPii } from '../ai-rep/advisor';
import { advisorSystemPrompt, baseAllowedNumbers, buildAdvisorTools, OutletCtx } from '../ai-rep/advisorTools';
import { getCountryTax } from '../config/countries';
import { GUIDE_QUESTION, GUIDE_QUESTION_LEARNED, planEligible, planFromText, rankCandidates, rulePlan, ruleGuideText, PlanCandidate } from '../ai-rep/guide';
import { getLearned, invalidateLearned, policyFor, recordTurn, resetLearning, rollbackModel } from '../ai-rep/learn/store';
import { learningView } from '../ai-rep/learn/view';
import { assignArm } from '../ai-rep/learn/policy';
import { resolveTuning } from '../ai-rep/learn/calibration';
import { applyLessonAction, renderLessonsBlock, selectLessons } from '../ai-rep/learn/lessons';
import { atDoor, candidateFeatures, classifyIntent, FEEDBACK_REASONS, hourBand, INTENTS, OBJECTION_CODES, outcomeObjection, parseManPlace, selfCheckFlags } from '../ai-rep/learn/signals';
import { riyadhDay } from '../ai-rep/learn/stats';
import type { Intent, Learned } from '../ai-rep/learn/types';
import type { LearnedCtx } from '../ai-rep/advisorTools';
import { addUsage, refundUsage, reserveUsage, usageDay, usageToday } from '../ai-rep/usage';
import { getSession, patchSessionOutlet, peekSession, saveSession, SessionOutlet } from '../ai-rep/session';

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

function estimateAt(c: RepCtx, data: TenantEstimateData, o: { lat: number; lng: number; outletType: string; customerId: string | null }, learned?: Learned | null): EstimateResult {
  const tuning = learned ? resolveTuning(learned, o.outletType, c.settings.learningMode) : { trialFactor: 1, calibrationVersion: null };
  return estimateOutlet({
    target: { lat: o.lat, lng: o.lng, outletType: o.outletType, excludeCustomerId: o.customerId },
    now: new Date(), window: data.window, peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders,
    products: data.products, minPeers: c.settings.minPeers, showMoney: c.showMoney,
    trialFactor: tuning.trialFactor, calibrationVersion: tuning.calibrationVersion,
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
    const [usage, llm] = await Promise.all([usageToday(c.tid, c.repId), Promise.resolve(llmConfig())]);
    res.json({
      success: true,
      data: {
        enabled: true,
        placesConfigured: !!placesApiKey(),
        placesMode: placesApiKey() ? 'AUTO' : 'MANUAL',
        mapsKey: mapsBrowserKey(),
        showMoney: c.showMoney,
        searchRadiusM: c.settings.searchRadiusM,
        minPeers: c.settings.minPeers,
        targetTypes: c.settings.targetOutletTypes.map(code => ({ code, label: outletTypeLabel(code) })),
        dailySearches: { used: usage?.searches ?? 0, limit: c.settings.dailySearchesPerRep },
        advisor: {
          available: c.settings.advisorEnabled && !!llm,
          reason: !c.settings.advisorEnabled ? 'DISABLED_BY_COMPANY' : !llm ? 'NOT_CONFIGURED' : null,
          used: usage?.chatTurns ?? 0,
          limit: c.settings.dailyChatTurnsPerRep,
        },
        learning: { on: c.settings.learningMode !== 'OFF' },
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
    const out = await mergeAndEstimate(req, c, origin, types, found.places);
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

/** دمج محلات Google بسجلّ الشركة فقط (عميل قائم، نتيجة سابقة، عزل العملاء) — بلا توقّع. */
async function mergeOnly(req: AuthRequest, c: RepCtx, origin: { lat: number; lng: number }, types: string[], places: NearbyPlace[], opts: { keepHidden?: boolean } = {}) {
  // العملاء حول المحلات المدموجة نفسها (+ هامش المطابقة) — لا حول المندوب بنصف قطر البحث: المسح يُبقي محلات حتى ×١٫٢٥
  const box = customerBox(places);
  if (!box) return [];
  const placeIds = places.map(p => p.placeId);
  const [isolation, scope] = await Promise.all([isolationEnabled(c.tid), customerScope(req, c.tid)]);
  const near = await prisma.customer.findMany({
    where: {
      tenantId: c.tid,
      OR: [
        { lat: { gte: box.minLat, lte: box.maxLat }, lng: { gte: box.minLng, lte: box.maxLng } },
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
    keepHidden: opts.keepHidden,
  });
  return items;
}

/** دمج محلات Google بسجلّ الشركة (عميل قائم، نتيجة سابقة، عزل العملاء)، ومراجع ثابتة P1…، وملخّص التوقّع لكل محل. */
async function mergeAndEstimate(req: AuthRequest, c: RepCtx, origin: { lat: number; lng: number }, types: string[], places: NearbyPlace[]) {
  const items = await mergeOnly(req, c, origin, types, places);
  // التوقّع: مرّة لكل (نوع، خلية، عميل مستبعَد) — العميل القائم لا يدخل ضمن المحلات المشابهة له نفسه
  const [data, learned] = await Promise.all([loadData(c), getLearned(c.tid)]);
  const memo = new Map<string, ReturnType<typeof summarize>>();
  const withEstimates = items.map((it, i) => {
    const cell = snapPoint(it.lat, it.lng);
    const key = `${it.outletType}|${cell.lat}|${cell.lng}|${it.customerId ?? ''}`;
    let s = memo.get(key);
    if (!s) { s = summarize(estimateAt(c, data, it, learned)); memo.set(key, s); }
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
    const [data, learned] = await Promise.all([loadData(c), getLearned(c.tid)]);
    const result = estimateAt(c, data, o, learned);
    res.json({ success: true, data: { ...result, outletTypeLabel: outletTypeLabel(o.outletType), maxPeers: MAX_PEERS, minPeers: c.settings.minPeers } });
  } catch (err) { next(err); }
});

export const OUTCOME_KINDS = ['INTERESTED', 'CALL_BACK', 'QUOTE', 'NOT_INTERESTED', 'CLOSED', 'NOT_FOUND', 'EXCLUSIVE_SUPPLIER', 'CONVERTED'] as const;
/** ما يسجّله المندوب — «أصبح عميلاً» يكتبه إنشاء العميل وحده (linkConvertedCustomer)، فلا يزوّره جهاز. */
export const REP_OUTCOME_KINDS = ['INTERESTED', 'CALL_BACK', 'QUOTE', 'NOT_INTERESTED', 'CLOSED', 'NOT_FOUND', 'EXCLUSIVE_SUPPLIER'] as const;
const outcomeSchema = z.object({
  clientRef: z.string().uuid(),
  placeId: z.string().min(1).max(300).optional(),
  outletType: z.string().refine(isOutletType, 'نوع محل غير معروف'),
  repTypedName: z.string().trim().max(120).optional(),
  kind: z.enum(REP_OUTCOME_KINDS),
  note: z.string().trim().max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  accuracyM: z.number().min(0).max(100000).optional(),
  occurredAt: z.string().datetime().optional(),
  objection: z.enum(OBJECTION_CODES as [string, ...string[]]).optional(),
  // موقع المحل وعلاقته كما رآهما المندوب — احتياطٌ حين تنتهي جلسة البحث في الذاكرة (رفعٌ مؤجَّل أو بعد إعادة نشر)
  placeLat: z.number().min(-90).max(90).optional(),
  placeLng: z.number().min(-180).max(180).optional(),
  relation: z.enum(['NEW', 'CUSTOMER', 'POSSIBLE_CUSTOMER']).optional(),
}).refine(b => !!b.placeId || !!b.repTypedName, { message: 'اكتب اسم المحل', path: ['repTypedName'] });

export const MAX_OUTCOMES_PER_DAY = 300;
/** أقصى بُعد مقبول بين موقع المحل المرسَل من الجهاز وموقع المندوب — ما وراءه خطأ أو عبث فيُهمَل. */
export const PLACE_SANITY_KM = 10;
const DAY_MS = 86_400_000;

/** الحالة بعد النتيجة: المحوَّل يبقى محوَّلاً، و«لم أجده» المؤكَّد مغلق، وما عداهما مفتوح («مغلق الآن» لحظيّ لا يُغلق المحل). */
export function nextOutletStatus(current: string | null, kind: string, notFoundConfirmed = false): string {
  if (current === 'CONVERTED' || kind === 'CONVERTED') return 'CONVERTED';
  if (kind === 'NOT_FOUND' && notFoundConfirmed) return 'CLOSED';
  return 'OPEN';
}

/**
 * «لم أجده» مؤكَّد: بلاغان متتاليان (بلا نتيجة أخرى بينهما) من مندوبين مختلفين أو في يومين مختلفين، ضمن ذاكرة الإغلاق.
 * والمؤكَّد قبلاً يبقى مؤكَّداً ببلاغ جديد ولو من المندوب نفسه في يومه — لا يُنزله تكرار البلاغ إلى «بلاغ واحد».
 */
export function notFoundConfirmed(prev: { status?: string | null; lastOutcome: string | null; lastOutcomeAt: Date | null; lastSalesRepId: string | null } | null, repId: string, at: Date): boolean {
  if (!prev || prev.lastOutcome !== 'NOT_FOUND' || !prev.lastOutcomeAt) return false;
  if (at.getTime() - prev.lastOutcomeAt.getTime() > CLOSED_MEMORY_DAYS * DAY_MS) return false;
  if (prev.status === 'CLOSED') return true;
  return prev.lastSalesRepId !== repId || !sameDay(prev.lastOutcomeAt, at);
}

/**
 * هل تكتب النتيجة ذاكرة المحل (الحالة وآخر نتيجة ومندوبها وموقعه)؟ الحدث يُسجَّل دائماً، أما الذاكرة فلا:
 *   - المحوَّل (عميل قائم، وقد يكون عميل زميل تحت العزل) لا يُمسّ.
 *   - نتيجة أقدم من المخزّنة (رفعٌ مؤجَّل قديم) لا تمحو الأحدث.
 */
export function outcomeWritesMemory(existing: { status: string; lastOutcomeAt: Date | null } | null, occurredAt: Date): boolean {
  if (!existing) return true;
  if (existing.status === 'CONVERTED') return false;
  return !existing.lastOutcomeAt || existing.lastOutcomeAt.getTime() <= occurredAt.getTime();
}

/** موقع المحل لـ«عند الباب»: الجلسة في الذاكرة، ثم معرّف man:، ثم ما أرسله الجهاز إن كان معقولاً قرب موقع المندوب. */
export function outcomePlace(session: { lat: number; lng: number } | null | undefined, placeId: string | null | undefined,
  sent: { lat: number; lng: number } | null, gps: { lat: number; lng: number } | null): { lat: number; lng: number } | null {
  if (session) return { lat: session.lat, lng: session.lng };
  const man = parseManPlace(placeId);
  if (man) return man;
  if (sent && gps && haversineKm(sent.lat, sent.lng, gps.lat, gps.lng) <= PLACE_SANITY_KM) return sent;
  return null;
}

rep.post('/outcomes', async (req: AuthRequest, res: Response, next: NextFunction) => {
  let reserved: RepCtx | null = null;
  try {
    const c = ctxOf(req);
    const b = outcomeSchema.parse(req.body);
    const dup = await prisma.aiOutletEvent.findUnique({ where: { tenantId_clientRef: { tenantId: c.tid, clientRef: b.clientRef } } });
    if (dup) { res.json({ success: true, data: { eventId: dup.id, outletId: dup.outletId }, idempotent: true }); return; }
    // سقف يومي عالٍ يمنع الإغراق لا العمل — يُحجز ذرّياً ويُعاد إن تعذّر الحفظ
    if (!(await reserveUsage(c.tid, c.repId, 'outcomes', MAX_OUTCOMES_PER_DAY))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: 'بلغت حدّ تسجيل النتائج اليومي — يتجدّد غداً' });
      return;
    }
    reserved = c;

    // لحظة الحدث من الجهاز (دون اتصال) مقيّدة: لا مستقبل ولا أقدم من ٣٠ يوماً
    const now = Date.now();
    let at = b.occurredAt ? new Date(b.occurredAt).getTime() : now;
    if (!Number.isFinite(at) || at > now + 5 * 60000 || at < now - 30 * 86400000) at = now;
    const occurredAt = new Date(at);
    const gps = b.lat != null && b.lng != null ? { lat: b.lat, lng: b.lng } : null;
    // حلقة التعلّم: هل كان عند المحل؟ الجلسة في الذاكرة أولاً (تعيش ٤ ساعات وتضيع بإعادة النشر)، ثم ما أرسله الجهاز
    const so = b.placeId ? peekSession(c.tid, c.repId)?.outlets.find(x => x.placeId === b.placeId) : undefined;
    const sent = b.placeLat != null && b.placeLng != null ? { lat: b.placeLat, lng: b.placeLng } : null;
    const door = gps ? atDoor({ ...gps, accuracyM: b.accuracyM ?? null }, outcomePlace(so, b.placeId, sent, gps)) : null;
    const relation = so?.relation ?? b.relation ?? null;
    const obj = outcomeObjection(b.kind, (b.objection ?? null) as never, b.note);

    const result = await prisma.$transaction(async tx => {
      const existing = b.placeId ? await tx.aiOutlet.findUnique({ where: { tenantId_placeId: { tenantId: c.tid, placeId: b.placeId } } }) : null;
      // المحوَّل عميلٌ في الحقيقة ولو رآه المندوب جديداً (عزل) — فلا تدخل زيارته إحصاء الفرص
      const rel = existing?.status === 'CONVERTED' ? 'CUSTOMER' : relation;
      const event = (outletId: string) => tx.aiOutletEvent.create({
        data: {
          tenantId: c.tid, outletId, salesRepId: c.repId, kind: b.kind, note: b.note ?? null,
          lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracyM: b.accuracyM ?? null, clientRef: b.clientRef, occurredAt,
          objection: obj.objection, objectionSource: obj.source, atDoor: door, relation: rel,
        },
      });
      if (existing && !outcomeWritesMemory(existing, occurredAt)) {
        const ev = await event(existing.id);
        return { eventId: ev.id, outletId: existing.id, applied: false };
      }
      const status = nextOutletStatus(existing?.status ?? null, b.kind, b.kind === 'NOT_FOUND' && notFoundConfirmed(existing, c.repId, occurredAt));
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
      const ev = await event(outlet.id);
      return { eventId: ev.id, outletId: outlet.id, applied: true };
    });
    if (b.placeId && result.applied) patchSessionOutlet(c.tid, c.repId, b.placeId, { lastOutcome: b.kind, ...(CLOSED_KINDS.has(b.kind) && { closed: true }) });
    // الردّ لا يحمل حالة المحل (كان يكشف تحويل زميلٍ لمحلٍّ يراه المندوب جديداً تحت العزل)
    res.status(201).json({ success: true, data: { eventId: result.eventId, outletId: result.outletId } });
  } catch (err) {
    if (reserved) await refundUsage(reserved.tid, reserved.repId, 'outcomes').catch(() => undefined);
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
    const [actx, learned] = await Promise.all([advisorContext(c, outlets, s.origin), getLearned(c.tid)]);
    // حلقة التعلّم: ذراع اليوم لهذا المندوب (ضابطة بالنسبة المختارة)، وسياسة الترتيب، وفترة اليوم
    const now = new Date();
    const arm = assignArm(c.tid, c.repId, riyadhDay(now), c.settings);
    const policy = policyFor(learned, arm);
    const hb = hourBand(now, actx.data.timezone);
    const cands = s.outlets.map(o => ({ ...o, typeLabel: outletTypeLabel(o.outletType), estimate: estimateAt(c, actx.data, o, learned) }));
    const byRef = new Map(cands.map(x => [x.ref, x]));
    const ranked = rankCandidates(cands as Array<PlanCandidate & typeof cands[number]>, policy.params, hb);
    const plan = rulePlan(cands as PlanCandidate[], s.origin, undefined, policy.params, hb);
    const learnedOn = arm === 'LEARNED' && learned.mode !== 'OFF';
    const learnedFlag = learnedOn && !!learned.policy;
    const rules = { text: ruleGuideText(plan, byRef, s.origin, actx.currency), plan, source: 'RULES' as const };
    const turnId = randomUUID();
    const turnBase = {
      id: turnId, tenantId: c.tid, salesRepId: c.repId, kind: 'GUIDE' as const, intent: 'GUIDE', arm, policyVersion: policy.version, hourBand: hb,
      lessonIds: [] as string[], heldOutIds: [] as string[],
    };
    const rulesTurn = (candidatesPlan: string[]) => recordTurn({
      ...turnBase, source: 'RULES', guard: 'NONE', badKinds: [], flags: [], tools: [], hops: 0, tokensIn: 0, tokensOut: 0,
      candidates: candidateFeatures(ranked, candidatesPlan),
    });

    // العقل: إن كان مفعّلاً ومضبوطاً (مفتاح المنصّة الموحّد) — والدورة تُحجز ذرّياً قبل النداء، وإلا الخطة الحتمية (لا كلفة نموذج)
    const cfg = llmConfig();
    if (!cfg || !c.settings.advisorEnabled || !outlets.some(o => !o.closed)) {
      await rulesTurn(plan);
      res.json({ success: true, data: { ...rules, turnId, learned: learnedFlag } }); return;
    }
    if (!(await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep))) {
      await rulesTurn(plan);
      res.json({ success: true, data: { ...rules, turnId, learned: learnedFlag } }); return;
    }
    const lessons = learnedOn
      ? selectLessons(learned.lessons, { turnId, intent: 'GUIDE', types: new Set(outlets.map(o => o.outletType)) })
      : { injected: [], heldOut: [] };
    const lctx: LearnedCtx | null = learned.mode !== 'OFF' ? {
      mode: learned.mode, arm, field: learned.field, policy: policy.params, hb,
      recommended: ranked.slice(0, 5).map(x => x.ref),
      calVersion: learned.calibration?.version ?? null,
      trialFactorFor: t => resolveTuning(learned, t, c.settings.learningMode).trialFactor,
      calCustomers: learned.calibration?.params.customers ?? null,
    } : null;
    const actxL = { ...actx, learned: lctx };
    const question = learnedOn && learned.field ? GUIDE_QUESTION_LEARNED : GUIDE_QUESTION;
    const result = await runAdvisor({
      system: advisorSystemPrompt(actxL, { learned: learnedOn, lessonsBlock: renderLessonsBlock(lessons.injected) }),
      history: [{ role: 'user', text: question, serverAuthored: true }],
      baseAllowed: baseAllowedNumbers(actxL, numbersIn), tools: buildAdvisorTools(actxL), llm: r => chatCompletion(cfg, r),
    });
    // الرموز تُحتسب في كل الأحوال — ومنها الفشل والقالب
    await addUsage(c.tid, c.repId, {
      tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      guardRegen: 'guard' in result && result.guard === 'REGEN' ? 1 : 0,
      guardFallback: 'guard' in result && (result.guard === 'TRIM' || result.guard === 'TEMPLATE') ? 1 : 0,
    });
    const eligible = planEligible(cands);
    const lessonsRec = { lessonIds: lessons.injected.map(l => l.id), heldOutIds: lessons.heldOut };
    if ('error' in result || result.guard === 'TEMPLATE') {
      if ('error' in result) console.warn('[ai-rep] التوجيه بالعقل تعذّر:', result.code, 'tenant', c.tid);
      await recordTurn({
        ...turnBase, ...lessonsRec,
        source: 'error' in result ? 'ERROR' : 'AI', guard: 'error' in result ? 'NONE' : 'TEMPLATE',
        badKinds: 'error' in result ? [] : result.violation?.kinds ?? [],
        flags: 'error' in result ? ['LLM_ERROR'] : ['EMPTY_PLAN'],
        tools: 'error' in result ? [] : result.toolNames, hops: 'error' in result ? 0 : result.hops,
        tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
        candidates: candidateFeatures(ranked, plan),
      });
      res.json({ success: true, data: { ...rules, turnId, learned: learnedFlag } }); return;
    }
    // خطة العقل بترتيب خطواته المرقّمة (بلا إعادة ترتيب تناقض نصّه)، ومن الفرص الجديدة غير المرفوضة وحدها
    const aiPlan = planFromText(result.text, eligible);
    const finalPlan = aiPlan.length ? aiPlan : plan;
    await recordTurn({
      ...turnBase, ...lessonsRec, source: 'AI', guard: result.guard, badKinds: result.violation?.kinds ?? [],
      flags: selfCheckFlags({ kind: 'GUIDE', source: 'AI', intent: 'GUIDE', text: result.text, toolNames: result.toolNames, toolErrors: result.toolErrors, eligibleRefs: eligible }),
      tools: result.toolNames, hops: result.hops, tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      candidates: candidateFeatures(ranked, finalPlan),
    });
    console.info('[ai-rep] توجيه', JSON.stringify({ tenant: c.tid, hops: result.hops, guard: result.guard, arm, tin: result.usage.promptTokens, tout: result.usage.completionTokens }));
    res.json({ success: true, data: { text: result.text, plan: finalPlan, source: 'AI', turnId, learned: learnedFlag } });
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
  /** نيّة السؤال الجاهز (رمز فقط — لا يصل للعقل) */
  intentHint: z.enum(INTENTS as unknown as [string, ...string[]]).optional(),
});

rep.post('/chat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    if (!c.settings.advisorEnabled) { res.status(403).json({ success: false, code: 'AI_ADVISOR_DISABLED', message: 'المستشار الذكي متوقف لشركتك — القوائم والتوقّعات تعمل كالمعتاد' }); return; }
    const cfg = llmConfig();
    if (!cfg) { res.status(503).json({ success: false, code: 'AI_LLM_NOT_CONFIGURED', message: 'المستشار الذكي لم يُفعَّل بعد لدى المنصّة — القوائم والتوقّعات تعمل كالمعتاد' }); return; }
    const body = chatSchema.parse(req.body);
    const s = body.searchId ? getSession(c.tid, c.repId, body.searchId) : null;
    if (body.searchId && !s) { res.status(409).json(NO_SESSION); return; }
    if (!(await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ أسئلة المستشار اليومي (${c.settings.dailyChatTurnsPerRep}) — القوائم والأرقام تعمل كالمعتاد` });
      return;
    }
    const [actx, learned] = await Promise.all([advisorContext(c, s ? s.outlets.map(toOutletCtx) : [], s?.origin ?? null), getLearned(c.tid)]);
    const now = new Date();
    // حلقة التعلّم: نيّة السؤال رمزاً (النص لا يُخزَّن)، والذراع، والدروس، وأداة «ما واجهه الفريق»
    const intent: Intent = (body.intentHint as Intent | undefined) ?? classifyIntent(scrubPii(body.messages[body.messages.length - 1].text));
    const arm = assignArm(c.tid, c.repId, riyadhDay(now), c.settings);
    const policy = policyFor(learned, arm);
    const learnedOn = arm === 'LEARNED' && learned.mode !== 'OFF';
    const hb = hourBand(now, actx.data.timezone);
    const turnId = randomUUID();
    const types = new Set(s ? s.outlets.map(o => o.outletType) : c.settings.targetOutletTypes);
    const lessons = learnedOn ? selectLessons(learned.lessons, { turnId, intent, types }) : { injected: [], heldOut: [] };
    const recommended = s
      ? rankCandidates(s.outlets.map(o => ({ ...o, estimate: estimateAt(c, actx.data, o, learned) })) as PlanCandidate[], policy.params, hb).slice(0, 5).map(x => x.ref)
      : [];
    const lctx: LearnedCtx | null = learned.mode !== 'OFF' ? {
      mode: learned.mode, arm, field: learned.field, policy: policy.params, hb, recommended,
      calVersion: learned.calibration?.version ?? null,
      trialFactorFor: t => resolveTuning(learned, t, c.settings.learningMode).trialFactor,
      calCustomers: learned.calibration?.params.customers ?? null,
    } : null;
    const actxL = { ...actx, learned: lctx };
    const started = Date.now();
    const result = await runAdvisor({
      system: advisorSystemPrompt(actxL, { learned: learnedOn, lessonsBlock: renderLessonsBlock(lessons.injected) }),
      // ردود المستشار السابقة تُقصّ (لا تُرفض) — والأسئلة محدودة بـ1500
      history: body.messages.map(m => ({ role: m.role, text: m.role === 'assistant' ? m.text.slice(0, 3000) : m.text })),
      baseAllowed: baseAllowedNumbers(actxL, numbersIn),
      tools: buildAdvisorTools(actxL),
      llm: r => chatCompletion(cfg, r),
    });
    const turnBase = {
      id: turnId, tenantId: c.tid, salesRepId: c.repId, kind: 'CHAT' as const, intent, arm, policyVersion: policy.version, hourBand: hb,
      lessonIds: lessons.injected.map(l => l.id), heldOutIds: lessons.heldOut,
      tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
    };
    await addUsage(c.tid, c.repId, {
      tokensIn: result.usage.promptTokens, tokensOut: result.usage.completionTokens,
      guardRegen: 'guard' in result && result.guard === 'REGEN' ? 1 : 0,
      guardFallback: 'guard' in result && (result.guard === 'TRIM' || result.guard === 'TEMPLATE') ? 1 : 0,
    });
    if ('error' in result) {
      await recordTurn({ ...turnBase, source: 'ERROR', guard: 'NONE', badKinds: [], flags: ['LLM_ERROR'], tools: [], hops: 0 });
      console.warn('[ai-rep] المستشار تعذّر:', result.code, 'tenant', c.tid);
      res.status(result.code === 'LLM_RATE_LIMIT' ? 429 : 503).json({ success: false, code: 'AI_' + result.code, message: 'المستشار غير متاح مؤقتاً — القوائم والتوقّعات تعمل كالمعتاد، حاول بعد قليل' });
      return;
    }
    // سجلّ بلا محتوى محادثة: الشركة والقفزات والرموز والحارس والزمن
    console.info('[ai-rep] دورة مستشار', JSON.stringify({ tenant: c.tid, hops: result.hops, tools: result.toolNames, guard: result.guard, tin: result.usage.promptTokens, tout: result.usage.completionTokens, cached: result.usage.cachedTokens, ms: Date.now() - started }));
    await recordTurn({
      ...turnBase, source: 'AI', guard: result.guard, badKinds: result.violation?.kinds ?? [],
      flags: selfCheckFlags({ kind: 'CHAT', source: 'AI', intent, text: result.text, toolNames: result.toolNames, toolErrors: result.toolErrors }),
      tools: result.toolNames, hops: result.hops,
    });
    res.json({ success: true, data: { text: result.text, refs: result.refs, guard: result.guard, searchId: s?.searchId ?? null, turnId } });
  } catch (err) { next(err); }
});

const feedbackSchema = z.object({
  turnId: z.string().uuid(),
  vote: z.union([z.literal(1), z.literal(-1)]),
  reason: z.enum(FEEDBACK_REASONS as unknown as [string, ...string[]]).optional(),
});

rep.post('/feedback', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const b = feedbackSchema.parse(req.body);
    const now = new Date();
    const r = await prisma.aiTurn.updateMany({
      where: { id: b.turnId, tenantId: c.tid, salesRepId: c.repId, createdAt: { gte: new Date(now.getTime() - 48 * 3600000) } },
      data: { vote: b.vote, voteReason: b.vote === -1 ? b.reason ?? null : null, votedAt: now },
    });
    if (r.count === 0) { res.status(404).json({ success: false, code: 'AI_TURN_NOT_FOUND', message: 'انتهت مهلة تقييم هذا الرد' }); return; }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ───────────── إضافة محلٍّ من خرائط Google بحساب المندوب (بلا مفتاح Google) ─────────────
// المندوب يبحث في تطبيق خرائط Google بحسابه كأي مستخدم، ثم يلصق رابط المحل (أو نصّ المشاركة) هنا، أو يضغط
// «أنا عند المحل الآن». الخادم يحلّ الرابط إلى موقع (كما يفعل لموقع العميل)، ويضيف المحل لجلسة البحث بمرجع ثابت،
// ويحسب توقّع مشترياته. الاسم يكتبه/يشاركه المندوب بنفسه.
const manualSchema = z.object({
  searchId: z.string().uuid().optional(),
  text: z.string().trim().max(2000).optional(),
  name: z.string().trim().max(120).optional(),
  outletType: z.string().refine(isOutletType, 'نوع محل غير معروف'),
  here: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100000).optional() }).optional(),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
}).refine(b => !!b.text || !!b.here, { message: 'الصق رابط المحل من خرائط Google أو اختر «أنا عند المحل الآن»' });

/** الاسم من نصّ المشاركة: أول سطر ليس رابطاً. */
export function nameFromShare(text: string): string {
  return (text.split(/\r?\n/).map(l => l.replace(/https?:\/\/\S+/g, '').trim()).find(l => l.length > 1) || '').slice(0, 120);
}

// ───────────── «ادرس هذا المحل» من ملفه في خرائط Google (لا من مبيعات الشركة السابقة) ─────────────
// المندوب يضغط محلاً على الخريطة (أو «أنا عند المحل الآن» ⇒ أقرب محل في خرائط Google خلال ٦٠ م) ⇒ ملف المحل من
// Google في الخادم (التقييم، عدد المقيّمين، ساعات العمل، حتى ٥ مراجعات نصية) ⇒ دراسة بالعقل (أو حتمية) في ردٍّ واحد.
// لا يُخزَّن شيء من الملف؛ الجلسة تحفظ المرجع والموقع ونوع المحل فقط (لتسجيل النتيجة وإضافته عميلاً).
const studySchema = z.object({
  searchId: z.string().uuid().optional(),
  placeId: z.string().refine(isGooglePlaceId, 'محل غير معروف').optional(),
  here: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100000).optional() }).optional(),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
}).refine(b => !!b.placeId || !!b.here, { message: 'اختر محلاً من الخريطة' });

const HERE_RADIUS_M = 60;

rep.post('/study', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const b = studySchema.parse(req.body);
    const key = placesApiKey();
    if (!key) { res.status(503).json({ success: false, code: 'PLACES_NOT_CONFIGURED', message: 'دراسة المحل من خرائط Google تحتاج مفتاح Google للمنصّة — لم يُضبط بعد' }); return; }
    // نداءات Google (كلفة) بحصة الدراسة اليومية — تُعاد الحصة إن فشل النداء
    if (!(await reserveUsage(c.tid, c.repId, 'searches', c.settings.dailySearchesPerRep))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ دراسة المحلات اليومي (${c.settings.dailySearchesPerRep}) — يتجدّد غداً` });
      return;
    }
    const fail = async (status: number, body: object) => { await refundUsage(c.tid, c.repId, 'searches'); res.status(status).json({ success: false, ...body }); };

    // «أنا عند المحل الآن»: أقرب محل في خرائط Google لموقع المندوب
    let placeId = b.placeId ?? null;
    if (!placeId && b.here) {
      if ((b.here.accuracyM ?? 0) > 100) { await fail(400, { code: 'GPS_INACCURATE', message: 'دقّة موقعك ضعيفة — اقترب من باب المحل وحاول مجدداً' }); return; }
      const near = await searchNearby({ apiKey: key, lat: b.here.lat, lng: b.here.lng, radiusM: HERE_RADIUS_M, includedTypes: googleTypesFor(OUTLET_TYPE_CODES as string[]), regionCode: c.countryCode });
      if (!near.ok) { await fail(near.code === 'PLACES_QUOTA' ? 429 : 502, { code: near.code, message: near.message }); return; }
      if (!near.places.length) { await fail(404, { code: 'NO_SHOP_HERE', message: 'لا يوجد محل في خرائط Google عند موقعك — اضغط المحل على الخريطة مباشرة' }); return; }
      placeId = near.places[0].placeId;
    }

    const got = await placeProfile({ apiKey: key, placeId: placeId! });
    if (!got.ok) { await fail(got.code === 'PLACES_QUOTA' ? 429 : got.code === 'PLACES_NOT_FOUND' ? 404 : 502, { code: got.code, message: got.message }); return; }
    const p = got.profile;
    // مغلق نهائياً حسب Google: لا دراسة ⇒ تُعاد الحصة كأي فشل
    if (p.closed) { await fail(422, { code: 'PLACE_CLOSED', message: 'هذا المحل مغلق حسب خرائط Google' }); return; }

    // نوع المحل (للتسجيل والإضافة عميلاً فقط — الدراسة لا تحتاجه)
    const outletType = outletTypeFromGoogle(p.primaryType, p.types, OUTLET_TYPE_CODES) ?? suggestOutletType(p.name) ?? c.settings.targetOutletTypes[0] ?? 'GROCERY';
    // ضغطة المندوب على محلٍّ مخفي (أُبلغ عن إغلاقه) تُعيده بذاكرته — لعلّه وجده مفتوحاً
    const [merged] = await mergeOnly(req, c, { lat: p.lat, lng: p.lng }, [outletType], [{
      placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, primaryType: null, types: googleTypesFor([outletType]),
    }], { keepHidden: true });

    let s = getSession(c.tid, c.repId, b.searchId);
    if (!s || s.outlets.length >= 500) {
      s = { searchId: randomUUID(), createdAt: Date.now(), origin: b.gps ?? { lat: p.lat, lng: p.lng }, radiusM: c.settings.searchRadiusM, outlets: [] };
      saveSession(c.tid, c.repId, s);
    }
    const from = b.gps ?? b.here ?? s.origin;
    const distanceM = Math.round(haversineKm(from.lat, from.lng, p.lat, p.lng) * 1000);
    const existing = s.outlets.find(o => o.placeId === p.placeId);
    const ref = existing?.ref ?? `P${s.outlets.length + 1}`;
    const relation = merged?.relation ?? 'NEW';
    const customerId = merged?.customerId ?? null;
    if (!existing) {
      s.outlets.push({ ref, placeId: p.placeId, outletType, lat: p.lat, lng: p.lng, distanceM, relation, lastOutcome: merged?.lastOutcome ?? null, customerId });
    }

    // الدراسة: بالعقل إن ضُبط وتوفّرت حصته، وإلا حتمية من الملف نفسه
    let study: ShopStudy = ruleStudy(p);
    const cfg = llmConfig();
    if (cfg && c.settings.advisorEnabled && (await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep))) {
      const products = (await prisma.product.findMany({
        where: { tenantId: c.tid, status: 'ACTIVE', deletedAt: null }, select: { name: true }, orderBy: { name: 'asc' }, take: 60,
      })).map(x => x.name);
      const ai = await aiStudy(p, { cfg, products, playbook: c.settings.playbook });
      await addUsage(c.tid, c.repId, { tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, ...(ai.study ? {} : { guardFallback: 1 }) });
      if (ai.study) study = ai.study;
      else console.warn('[ai-rep] دراسة المحل بالعقل تعذّرت:', ai.code, 'tenant', c.tid);
    }

    res.json({
      success: true,
      data: {
        searchId: s.searchId,
        item: {
          ref, placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, outletType, outletTypeLabel: outletTypeLabel(outletType),
          distanceM, relation, customerId, lastOutcome: merged?.lastOutcome ?? null, lastOutcomeAt: merged?.lastOutcomeAt ?? null,
          rejectedRecently: merged?.rejectedRecently ?? false, reportedClosed: merged?.reportedClosed ?? false,
        },
        profile: {
          name: p.name, typeLabel: p.typeLabel, address: p.address, mapsUri: p.mapsUri, rating: p.rating, ratingCount: p.ratingCount,
          openNow: p.openNow, hours: p.hours, reviews: p.reviews,
        },
        study,
      },
    });
  } catch (err) { next(err); }
});

// ───────────── المسح: كل المحلات حول المندوب من خرائط Google + توجيه العقل (بلا عمل من المندوب) ─────────────
// بمفتاح الأماكن: البحث الرسمي. بلا مفتاح: بحث خرائط Google العام (وضع تجربة، publicMaps.ts) — بلا مراجعات نصية.
const scanSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).optional(),
});

/** أسوأ دقّة موقع يُمسح حولها: فوقها (الموقع الدقيق مطفأ في الجوال) المحلات والمسافات من نقطةٍ على بعد كيلومترات. */
export const SCAN_MAX_ACCURACY_M = 500;

rep.post('/scan', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const b = scanSchema.parse(req.body);
    // قبل الحجز: الموقع التقريبي جداً لا يستهلك حصة ولا طلبات Google — والواجهة تنبّه لما دونه
    if ((b.accuracyM ?? 0) > SCAN_MAX_ACCURACY_M) {
      res.status(400).json({ success: false, code: 'GPS_INACCURATE', message: 'موقعك تقريبي جداً — فعّل «الموقع الدقيق» لهذا التطبيق من إعدادات الجوال ثم حدّث' });
      return;
    }
    // مهلة بعد مسحٍ فاشل (قبل الحجز): «حدّث» المتكرّر أثناء حجب Google لا يطرقها من جديد
    const repKey = `${c.tid}|${c.repId}`;
    const wait = repRetryLeftMs(repKey);
    if (wait) {
      res.status(429).json({ success: false, code: 'SCAN_COOLDOWN', retryAfterS: Math.ceil(wait / 1000), message: 'تعذّر المسح قبل لحظات — انتظر نصف دقيقة ثم حدّث' });
      return;
    }
    if (!(await reserveUsage(c.tid, c.repId, 'searches', c.settings.dailySearchesPerRep))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: `بلغت حدّ المسح اليومي (${c.settings.dailySearchesPerRep}) — نتائجك الحالية تبقى متاحة` });
      return;
    }
    const origin = { lat: b.lat, lng: b.lng };
    const radiusM = c.settings.searchRadiusM;
    // البحث بأول ثلاثة أنواع (حدّ الطلبات)، والتصنيف والدمج بكل ما تستهدفه الشركة
    const targets = c.settings.targetOutletTypes;
    const types = targets.slice(0, 3);
    type Found = {
      placeId: string; name: string; rating: number | null; ratingCount: number | null; lat: number; lng: number; category: string | null;
      openNow: boolean | null; hours: string[]; address: string | null; type: string;
    };
    const found = new Map<string, Found>();
    const key = placesApiKey();
    let source: 'PLACES' | 'PUBLIC' = key ? 'PLACES' : 'PUBLIC';
    let partial = false;
    if (key) {
      const r = await searchNearby({ apiKey: key, lat: b.lat, lng: b.lng, radiusM, includedTypes: googleTypesFor(types), regionCode: c.countryCode });
      if (r.ok) {
        for (const p of r.places) {
          const type = outletTypeFromGoogle(p.primaryType, p.types, types) ?? types[0];
          found.set(p.placeId, { placeId: p.placeId, name: p.name, rating: null, ratingCount: null, lat: p.lat, lng: p.lng, category: outletTypeLabel(type), openNow: null, hours: [], address: p.address, type });
        }
      } else source = 'PUBLIC';
    }
    if (!found.size) {
      source = 'PUBLIC';
      // نافذتان لكل نوع عبر الذاكرة المؤقتة والقاطع وحدّ التزامن، والنوع من تصنيف Google للمحل (publicMaps.ts)
      const r = await publicScan({ types, targets, lat: b.lat, lng: b.lng, radiusM });
      if (!r.ok) {
        // صيغة مجهولة أو حجب أو قاطع: تُعاد الحصة ويُمهَل المندوب — لا «لا محلات حولك»
        await refundUsage(c.tid, c.repId, 'searches');
        noteRepScanFailed(repKey);
        console.warn('[ai-rep] المسح العام تعذّر', r.code, r.codes.join(','), 'tenant', c.tid);
        res.status(r.code === 'SCAN_COOLDOWN' ? 503 : 502).json({ success: false, code: r.code, message: r.message, retryAfterS: r.retryAfterS ?? Math.ceil(REP_RETRY_MS / 1000) });
        return;
      }
      // صفرُ محلات لمناديب متتالين ⇒ نبضة الصحة تُنذر المالك (publicScanHealth)؛ الناقص الخالي لا يُحسب (حجبٌ لا صيغة)
      if (r.places.length || !r.partial) notePublicScanShops(repKey, r.places.length);
      if (r.partial) {
        partial = true;
        console.warn('[ai-rep] المسح العام ناقص', r.codes.join(','), 'tenant', c.tid);
      }
      for (const p of r.places) {
        found.set(p.placeId, {
          placeId: p.placeId, name: p.name, rating: p.rating, ratingCount: p.ratingCount, lat: p.lat, lng: p.lng, category: p.categories[0] ?? null,
          openNow: p.openNow, hours: p.hours, address: p.address, type: p.type,
        });
      }
    }
    // داخل نطاق الشركة، الأقرب أولاً
    const places = [...found.values()]
      .map(p => ({ ...p, distanceM: Math.round(haversineKm(b.lat, b.lng, p.lat, p.lng) * 1000) }))
      .filter(p => p.distanceM <= radiusM * 1.25)
      .sort((a, z2) => a.distanceM - z2.distanceM)
      .slice(0, 40);
    const merged = await mergeOnly(req, c, origin, targets, places.map(p => ({
      placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, primaryType: null, types: googleTypesFor([p.type]),
    })));
    const byId = new Map(places.map(p => [p.placeId, p]));
    const searchId = randomUUID();
    const items = merged.map((m, i) => {
      const p = byId.get(m.placeId)!;
      // عدد المقيّمين من البحث العام (0 = غير معروف: الواجهة لا تعرضه)، وساعات الأسبوع وحدها (لا سطر الحالة)
      const profile = {
        name: p.name, typeLabel: p.category, address: p.address, mapsUri: `https://www.google.com/maps/place/?q=place_id:${p.placeId}`,
        rating: p.rating, ratingCount: p.ratingCount ?? 0, openNow: p.openNow, hours: p.hours, reviews: [] as PlaceReview[],
      };
      return {
        ref: `P${i + 1}`, placeId: m.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng,
        outletType: m.outletType, outletTypeLabel: outletTypeLabel(m.outletType), distanceM: m.distanceM,
        relation: m.relation, customerId: m.customerId, lastOutcome: m.lastOutcome, lastOutcomeAt: m.lastOutcomeAt, rejectedRecently: m.rejectedRecently,
        reportedClosed: m.reportedClosed,
        profile,
        study: ruleStudy({ ...profile, placeId: p.placeId, primaryType: null, types: [], lat: p.lat, lng: p.lng, priceLevel: null, closed: false, typeLabel: p.category }),
      };
    });
    saveSession(c.tid, c.repId, {
      searchId, createdAt: Date.now(), origin, radiusM,
      outlets: items.map(it => ({ ref: it.ref, placeId: it.placeId, outletType: it.outletType, lat: it.lat, lng: it.lng, distanceM: it.distanceM, relation: it.relation, lastOutcome: it.lastOutcome, customerId: it.customerId })),
    });
    // ذاكرة الزيارات (آخر نتيجة ولحظتها) تصل التوجيه: ما زاره الفريق مؤخراً لا يعود «فرصة جديدة»، والمهتم يصير متابعة
    const shops: ScanShop[] = items.map(it => ({
      ref: it.ref, name: it.name, category: it.profile.typeLabel, rating: it.profile.rating, ratingCount: byId.get(it.placeId)?.ratingCount ?? null, openNow: it.profile.openNow,
      distanceM: it.distanceM, lat: it.lat, lng: it.lng, relation: it.relation, rejectedRecently: it.rejectedRecently,
      lastOutcome: it.lastOutcome, lastOutcomeAt: it.lastOutcomeAt, reportedClosed: it.reportedClosed,
    }));
    const now = new Date();
    let guide: ScanGuide = ruleGuide(shops, origin, now);
    const cfg = llmConfig();
    if (cfg && c.settings.advisorEnabled && shops.length && (await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep))) {
      const ai = await aiGuide(shops, { cfg, playbook: c.settings.playbook, origin, now });
      await addUsage(c.tid, c.repId, { tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, ...(ai.guide ? {} : { guardFallback: 1 }) });
      if (ai.guide) guide = ai.guide;
    }
    console.info('[ai-rep] مسح', JSON.stringify({ tenant: c.tid, source, shops: items.length, guide: guide.source, partial }));
    res.json({ success: true, data: { searchId, source, items, guide, partial } });
  } catch (err) { next(err); }
});

// ───────────── دراسة مراجعات لصقها المندوب من تطبيق خرائط Google (بحسابه، بلا مفتاح Google) ─────────────
rep.post('/manual', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const b = manualSchema.parse(req.body);
    let loc: { lat: number; lng: number } | null = null;
    if (b.here) {
      if ((b.here.accuracyM ?? 0) > 100) { res.status(400).json({ success: false, code: 'GPS_INACCURATE', message: 'دقّة موقعك ضعيفة — اقترب من باب المحل وحاول مجدداً' }); return; }
      loc = { lat: b.here.lat, lng: b.here.lng };
    } else {
      const url = (b.text || '').match(/https?:\/\/\S+/)?.[0];
      if (url && !isGoogleMapsUrl(url)) { res.status(400).json({ success: false, code: 'NOT_GOOGLE_MAPS', message: 'الصق رابط المحل من خرائط Google فقط' }); return; }
      // روابط Google وحدها، وفي كل تحويلة — لا يجلب الخادم عنواناً يكتبه المستخدم خارج Google
      loc = await resolveLocationUrl(url || b.text || '', { googleOnly: true });
      if (!loc) { res.status(422).json({ success: false, code: 'LINK_UNRESOLVED', message: 'تعذّر قراءة موقع المحل من الرابط — افتح المحل في خرائط Google واضغط «مشاركة» ثم انسخ الرابط' }); return; }
    }
    if (!(await reserveUsage(c.tid, c.repId, 'estimates', MAX_ESTIMATES_PER_DAY))) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', message: 'بلغت حدّ التوقّعات اليومي — يتجدّد غداً' });
      return;
    }
    const name = (b.name || nameFromShare(b.text || '')).trim();
    // معرّف ثابت للمحل من موقعه (لمنع التكرار وربط نتائج الزيارات) — ليس معرّف Google
    const placeId = `man:${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`;
    let s = getSession(c.tid, c.repId, b.searchId);
    if (!s) {
      s = { searchId: randomUUID(), createdAt: Date.now(), origin: b.gps ?? loc, radiusM: c.settings.searchRadiusM, outlets: [] };
      saveSession(c.tid, c.repId, s);
    }
    const existing = s.outlets.find(o => o.placeId === placeId);
    // المطابقة بالعملاء حول موقع المحل نفسه (قد يكون بعيداً عن المندوب)، والمسافة من نقطة الجلسة
    const merged = await mergeAndEstimate(req, c, loc, [b.outletType], [{
      placeId, name, address: null, lat: loc.lat, lng: loc.lng, primaryType: null, types: googleTypesFor([b.outletType]),
    }]);
    const found = merged.items[0];
    if (!found) { res.status(409).json({ success: false, message: 'تعذّرت إضافة المحل' }); return; }
    const it = { ...found, distanceM: Math.round(haversineKm(s.origin.lat, s.origin.lng, loc.lat, loc.lng) * 1000) };
    const ref = existing?.ref ?? `P${s.outlets.length + 1}`;
    if (!existing) {
      s.outlets.push({ ref, placeId, outletType: it.outletType, lat: it.lat, lng: it.lng, distanceM: it.distanceM, relation: it.relation, lastOutcome: it.lastOutcome, customerId: it.customerId });
    }
    res.status(existing ? 200 : 201).json({ success: true, data: { searchId: s.searchId, item: { ...it, ref, name } } });
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
    invalidateLearned(tid);
    res.json({ success: true, data: { settings: settingsView(row as Partial<AiRepSettingsView>) } });
  } catch (err) { next(err); }
});

// ───────────── «ما تعلّمه العقل» (حلقة التعلّم) ─────────────

const SCOPED_LEARNING = { success: false, message: 'حسابك مقيد بنطاق محدد — «ما تعلّمه العقل» يحتاج صلاحية غير مقيدة' };

admin.get('/learning', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_LEARNING); return; }
    const settings = await readSettings(tid);
    res.json({ success: true, data: await learningView(tid, settings) });
  } catch (err) { next(err); }
});

const lessonActionSchema = z.object({ action: z.enum(['approve', 'reject', 'disable', 'enable', 'restore']) });

admin.post('/learning/lessons/:id', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_LEARNING); return; }
    const { action } = lessonActionSchema.parse(req.body);
    const settings = await readSettings(tid);
    const r = await applyLessonAction(tid, String(req.params.id), action, req.user!.id, settings.playbook);
    if (!r.ok) {
      const message = r.status === 404 ? 'الدرس غير موجود'
        : r.code === 'TRIAL_CAP' ? 'دروس التجربة بلغت حدّها (٤) — عطّل درساً قيد التجربة أولاً ثم أعد المحاولة'
        : r.code === 'INVALID_TEXT' ? 'نص الدرس لم يعد يوافق دليل البيع الحالي — لا يمكن تفعيله'
        : 'لا يمكن تطبيق هذا الإجراء على حالة الدرس الحالية';
      res.status(r.status).json({ success: false, code: r.code, message });
      return;
    }
    invalidateLearned(tid);
    res.json({ success: true, data: { lesson: r.lesson } });
  } catch (err) { next(err); }
});

const rollbackSchema = z.object({ version: z.number().int().min(0).max(100000) });

admin.post('/learning/models/:kind/rollback', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_LEARNING); return; }
    const kind = req.params.kind === 'POLICY' || req.params.kind === 'CALIBRATION' ? req.params.kind : null;
    if (!kind) { res.status(400).json({ success: false, message: 'نوع غير معروف' }); return; }
    const { version } = rollbackSchema.parse(req.body);
    const r = await rollbackModel(tid, kind, version, req.user!.id, 'ADMIN');
    if (!r.ok) { res.status(404).json({ success: false, message: 'النسخة غير موجودة أو لا يمكن الرجوع إليها' }); return; }
    res.json({ success: true, data: { ok: true } });
  } catch (err) { next(err); }
});

admin.post('/learning/reset', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_LEARNING); return; }
    z.object({ confirm: z.literal(true) }).parse(req.body);
    await resetLearning(tid, req.user!.id);
    res.json({ success: true, data: { ok: true } });
  } catch (err) { next(err); }
});

// ───────────── المحلات المخفية عن المسح («أُغلق نهائياً / لم أجده» مؤكَّداً) ─────────────
// اسم المحل من Google لا يُخزَّن — القائمة بنوعه واسمه الذي كتبه المندوب إن وُجد ورابطه في خرائط Google ومن أبلغ ومتى.

const SCOPED_HIDDEN = { success: false, message: 'حسابك مقيد بنطاق محدد — المحلات المخفية تحتاج صلاحية غير مقيدة' };

admin.get('/hidden-outlets', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_HIDDEN); return; }
    const since = new Date(Date.now() - CLOSED_MEMORY_DAYS * DAY_MS);
    const rows = await prisma.aiOutlet.findMany({
      where: { tenantId: tid, status: 'CLOSED', lastOutcome: 'NOT_FOUND', lastOutcomeAt: { gte: since } },
      orderBy: { lastOutcomeAt: 'desc' }, take: 200,
      select: { id: true, placeId: true, outletType: true, repTypedName: true, lat: true, lng: true, lastOutcomeAt: true, lastSalesRepId: true },
    });
    const evs = rows.length ? await prisma.aiOutletEvent.findMany({
      where: { tenantId: tid, outletId: { in: rows.map(r => r.id) }, kind: 'NOT_FOUND', occurredAt: { gte: since } },
      orderBy: { occurredAt: 'desc' }, take: 1000, select: { outletId: true, salesRepId: true, occurredAt: true },
    }) : [];
    const repIds = [...new Set([...rows.map(r => r.lastSalesRepId).filter((x): x is string => !!x), ...evs.map(e => e.salesRepId)])];
    const reps = repIds.length ? await prisma.salesRep.findMany({ where: { tenantId: tid, id: { in: repIds } }, select: { id: true, name: true } }) : [];
    const repName = new Map(reps.map(r => [r.id, r.name]));
    res.json({
      success: true,
      data: {
        memoryDays: CLOSED_MEMORY_DAYS,
        items: rows.map(r => {
          const man = parseManPlace(r.placeId);
          const pin = man ?? (r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : null);
          return {
            id: r.id, outletType: r.outletType, outletTypeLabel: outletTypeLabel(r.outletType), name: r.repTypedName,
            mapsUri: r.placeId && isGooglePlaceId(r.placeId) ? `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(r.placeId)}`
              : pin ? `https://www.google.com/maps?q=${pin.lat},${pin.lng}` : null,
            reportedAt: r.lastOutcomeAt,
            hiddenUntil: r.lastOutcomeAt ? new Date(r.lastOutcomeAt.getTime() + CLOSED_MEMORY_DAYS * DAY_MS) : null,
            reports: evs.filter(e => e.outletId === r.id).slice(0, 5).map(e => ({ repName: repName.get(e.salesRepId) ?? null, at: e.occurredAt })),
          };
        }),
      },
    });
  } catch (err) { next(err); }
});

admin.post('/hidden-outlets/:id/unhide', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_HIDDEN); return; }
    // مفتوح بلا آخر نتيجة (فلا يؤكّده بلاغٌ واحد لاحق)، ولحظة الإظهار سياجٌ يمنع رفعاً مؤجَّلاً أقدم منها أن يعيد إخفاءه
    const r = await prisma.aiOutlet.updateMany({
      where: { id: String(req.params.id), tenantId: tid, status: 'CLOSED' },
      data: { status: 'OPEN', lastOutcome: null, lastOutcomeAt: new Date() },
    });
    if (r.count === 0) { res.status(404).json({ success: false, message: 'المحل غير موجود أو لم يعد مخفياً' }); return; }
    res.json({ success: true, data: { ok: true } });
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
