/**
 * المندوب الذكي AI — المسارات (/api/ai-rep).
 *
 * خاملة عند أي شركة لم يفعّل لها المالك Tenant.aiRepEnabled: كل مسار يُردّ AI_REP_NOT_ALLOWED.
 *
 * للمندوب (الشاشة الحالية):
 *   GET  /rep/me         ما تحتاجه الشاشة: مفتاح الأماكن مضبوط؟ مفتاح الخريطة (عرض فقط)، الأنواع المستهدفة، والمسح المتبقّي اليوم
 *   POST /rep/scan       المسح عند الفتح: كل المحلات حول المندوب (بمفتاح الأماكن، وإلا خرائط Google العامة) مدموجةً بسجلّ
 *                        الشركة، ودراسة حتمية لكل محل، و«الطلب المتوقع من ملف المحل في Google» لكل صنف في سيارة المندوب
 *                        (googleDemand.ts — لا من عملاء مشابهين)، وخطة حتمية فوراً — ويحفظ الخادم «جلسة البحث» بمراجع ثابتة P1…
 *   POST /rep/scan/guide توجيه العقل لذلك المسح من الجلسة (نداء ثانٍ تستبدل به الشاشة الخطة الحتمية حين يصل)
 *   POST /rep/study      دراسة محلٍّ بمراجعاته النصية (مفتاح الأماكن) — بالعقل إن ضُبط وإلا حتمية
 *   POST /rep/outcomes   نتيجة زيارة محلٍّ (منع التكرار بـclientRef؛ تُرفع من صفّ الإرسال دون اتصال)
 *   POST /rep/feedback   👍/👎 على التوجيه أو الدراسة (حلقة التعلّم)
 * مسارات قديمة بلا واجهة حالية (بانتظار قرار المالك): /rep/nearby و/rep/estimate (التوقّع من مبيعات الشركة)،
 *   /rep/guide و/rep/chat (المستشار بالأدوات)، /rep/manual (إضافة محل برابط ملصق).
 * لإدارة الشركة:
 *   GET/PUT /admin/settings   إعدادات الميزة + جاهزية البيانات
 *   GET/POST /admin/classify  تصنيف أنواع العملاء (مقترحٌ من الاسم تؤكّده الإدارة) — لتمييز «ربما عميل حالي» في المسح
 *   GET  /admin/learning …    «ما تعلّمه العقل» وإجراءات الإدارة عليه
 *   GET  /admin/hidden-outlets             المحلات المخفية عن المسح («أُغلق نهائياً / لم أجده» مؤكَّداً) ومن أبلغ عنها
 *   POST /admin/hidden-outlets/:id/unhide  «أعد إظهاره»
 *
 * العقل يكتب ولا يخترع: كل رقم في ردّه من مدخلاته، ولا روابط ولا هواتف ولا وعود خارج دليل البيع (حرّاس scanGuide/profileStudy).
 * لغة المندوب (lang في المسح والدراسة): العقل يكتب بها (العربية السعودية افتراضاً)، والحتمي نصٌّ عربي ومعه وقائعه تركّبها
 * الواجهة بلغتها، وكل خطأ برمزه (code، ومعه limit وretryAfterS حين تلزم) تترجمه الواجهة.
 * الإحداثيات والمراجع لا تأتي من الجهاز بعد البحث — فلا تلفيق نقاط لكشف عملاء الزملاء ولا استعلام عند إحداثيات حرّة.
 * أفعال جلسة المالك (الدعم الفني) تُسجَّل OWNER:<المعرّف> لا باسم مدير الشركة (actorOf).
 */
import { Router, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { actorOf, authenticate, requireAdmin, requireAdminPermission, requireSalesRep, tenantId } from '../middleware/auth';
import { customerScope, isolationEnabled } from '../services/customerScope';
import { adminScopeEnabled } from '../services/adminScope';
import { OUTLET_TYPES, OUTLET_TYPE_CODES, googleTypesFor, isOutletType, outletTypeFromGoogle, outletTypeLabel, suggestOutletType } from '../ai-rep/taxonomy';
import { aiRepSettingsSchema, NO_SELECTED_REPS, repInScope, settingsView, AiRepSettingsView } from '../ai-rep/settings';
import { estimateOutlet, snapPoint, activeMonths, haversineKm, EstimateResult, MAX_PEERS } from '../ai-rep/estimate';
import { loadEstimateData, invalidateEstimateData, tenantTimezone, TenantEstimateData } from '../ai-rep/estimateData';
import { isGooglePlaceId, placeProfile, placesApiKey, searchNearby, NearbyPlace, type PlaceReview } from '../ai-rep/places';
import { notePublicScanShops, noteRepScanFailed, publicScan, REP_RETRY_MS, repRetryLeftMs } from '../ai-rep/publicMaps';
import { aiGuide, baselineScore, learnedScorer, rankedPool, repLang, ruleGuide, scanCandidates, type ScanGuide, type ScanShop } from '../ai-rep/scanGuide';
import { aiStudy, ruleStudy, type ShopStudy } from '../ai-rep/profileStudy';
import { CLOSED_KINDS, CLOSED_MEMORY_DAYS, customerBox, mergeNearby, sameDay } from '../ai-rep/nearby';
import { chatCompletion, llmConfig } from '../ai-rep/llm';
import { isGoogleMapsUrl, resolveLocationUrl } from '../services/geoLink';
import { runAdvisor, numbersIn, scrubPii } from '../ai-rep/advisor';
import { advisorSystemPrompt, baseAllowedNumbers, buildAdvisorTools, OutletCtx } from '../ai-rep/advisorTools';
import { getCountryTax } from '../config/countries';
import { GUIDE_QUESTION, GUIDE_QUESTION_LEARNED, planEligible, planFromText, rankCandidates, rulePlan, ruleGuideText, PlanCandidate } from '../ai-rep/guide';
import { getLearned, invalidateLearned, policyFor, recordTurn, resetLearning, rollbackModel, updateTurn, type TurnRecord } from '../ai-rep/learn/store';
import { learningView } from '../ai-rep/learn/view';
import { assignArm } from '../ai-rep/learn/policy';
import { resolveTuning } from '../ai-rep/learn/calibration';
import { applyLessonAction, renderLessonsBlock, selectLessons, statsHint } from '../ai-rep/learn/lessons';
import { atDoor, candidateFeatures, classifyIntent, FEEDBACK_REASONS, hourBand, INTENTS, OBJECTION_CODES, outcomeObjection, parseManPlace, selfCheckFlags } from '../ai-rep/learn/signals';
import { riyadhDay } from '../ai-rep/learn/stats';
import type { AiLessonLite, Intent, Learned } from '../ai-rep/learn/types';
import type { LearnedCtx } from '../ai-rep/advisorTools';
import { addUsage, refundUsage, reserveUsage, usageDay, usageToday } from '../ai-rep/usage';
import { getSession, noteShownExpected, patchSessionOutlet, peekSession, saveSession, SessionOutlet, type PendingScanGuide, type SessionDemand } from '../ai-rep/session';
import { expectedFor, expectedView, shownOf, studyExpected, topExpected, typeBaselines, type Anchor, type DemandReview, type ExpectedShop, type TypeBaseline } from '../ai-rep/googleDemand';
import { loadAnchors, loadDemandProducts } from '../ai-rep/googleDemandData';
import { resolveGsigFactor } from '../ai-rep/learn/gsig';

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

/** المسح (ودراسة المراجعات) المتبقّي اليوم لهذا المندوب. */
async function searchesLeft(c: RepCtx): Promise<number> {
  const u = await usageToday(c.tid, c.repId);
  return Math.max(0, c.settings.dailySearchesPerRep - (u?.searches ?? 0));
}

rep.get('/me', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const usage = await usageToday(c.tid, c.repId);
    // ما تقرؤه الشاشة وحده
    res.json({
      success: true,
      data: {
        placesConfigured: !!placesApiKey(),
        mapsKey: mapsBrowserKey(),
        targetTypes: c.settings.targetOutletTypes.map(code => ({ code, label: outletTypeLabel(code) })),
        dailySearches: { used: usage?.searches ?? 0, limit: c.settings.dailySearchesPerRep },
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
// المندوب يفتح محلاً من قائمة المسح أو يضغطه على الخريطة (بمفتاح الأماكن) ⇒ ملف المحل من Google في الخادم (التقييم،
// عدد المقيّمين، ساعات العمل، حتى ٥ مراجعات نصية) ⇒ دراسة بالعقل (أو حتمية) في ردٍّ واحد.
// لا يُخزَّن شيء من الملف؛ الجلسة تحفظ المرجع والموقع ونوع المحل فقط (لتسجيل النتيجة وإضافته عميلاً).
// الحصة: محلٌّ من المسح الأخير يُدرس بلا خصم من «المسح اليومي» (حتى FREE_STUDIES_PER_SCAN لكل مسح) — فالمسح التلقائي
// عند كل فتح لا يلتهم دراسات المندوب؛ وغيره (محلٌّ ضُغط على الخريطة خارج القائمة) بحصة المسح (كلفة Google).
const studySchema = z.object({
  searchId: z.string().uuid().optional(),
  placeId: z.string().refine(isGooglePlaceId, 'محل غير معروف'),
  gps: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  /** لغة واجهة المندوب (repLang: غير المعروفة عربية) — يكتب بها العقل */
  lang: z.string().max(8).optional(),
});

/** دراسات مجانية (بلا خصم من المسح اليومي) لمحلات المسح الواحد. */
export const FREE_STUDIES_PER_SCAN = 10;

/**
 * منتجات دراسة المحل (أسماءً): ذات الأولوية الفعّالة أولاً بترتيب الإدارة، ثم الأكثر مبيعاً في ٩٠ يوماً، ثم بالاسم — حتى ٦٠.
 * priority = ذات الأولوية وحدها (حقلها في مدخل العقل). تُحفظ ١٠ دقائق لكل شركة (تجميع الفواتير على قاعدة صغيرة).
 */
const STUDY_PRODUCTS_TTL_MS = 10 * 60_000;
const studyProductsCache = new Map<string, { at: number; v: { products: string[]; priority: string[] } }>();

export async function studyProducts(tid: string, priorityIds: string[], max = 60): Promise<{ products: string[]; priority: string[] }> {
  const key = `${tid}|${max}|${priorityIds.join(',')}`;
  const hit = studyProductsCache.get(key);
  if (hit && Date.now() - hit.at < STUDY_PRODUCTS_TTL_MS) return hit.v;
  const v = await loadStudyProducts(tid, priorityIds, max);
  if (studyProductsCache.size > 500) studyProductsCache.clear();
  studyProductsCache.set(key, { at: Date.now(), v });
  return v;
}

async function loadStudyProducts(tid: string, priorityIds: string[], max: number): Promise<{ products: string[]; priority: string[] }> {
  const live = { tenantId: tid, status: 'ACTIVE', deletedAt: null };
  const since = new Date(Date.now() - 90 * DAY_MS);
  const [pri, top] = await Promise.all([
    priorityIds.length ? prisma.product.findMany({ where: { ...live, id: { in: priorityIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    // المبيعات وحدها (لا المرتجعات) كما في بيانات التوقّع
    prisma.invoiceItem.groupBy({
      by: ['productId'], where: { productId: { not: null }, invoice: { tenantId: tid, status: 'CONFIRMED', type: { in: ['CASH', 'CREDIT'] }, invoiceDate: { gte: since } } },
      _sum: { lineTotal: true }, orderBy: { _sum: { lineTotal: 'desc' } }, take: max * 2,
    }).catch(() => [] as { productId: string | null }[]),
  ]);
  const byId = new Map(pri.map(x => [x.id, x.name]));
  const priority = priorityIds.map(id => byId.get(id)).filter((n): n is string => !!n);
  const used = new Set(pri.map(x => x.id));
  const topIds = top.map(t => t.productId).filter((id): id is string => !!id && !used.has(id));
  const sold = topIds.length ? await prisma.product.findMany({ where: { ...live, id: { in: topIds } }, select: { id: true, name: true } }) : [];
  const soldName = new Map(sold.map(x => [x.id, x.name]));
  const names = [...priority];
  for (const id of topIds) {
    const n = soldName.get(id);
    if (n && names.length < max) { names.push(n); used.add(id); }
  }
  if (names.length < max) {
    const rest = await prisma.product.findMany({ where: { ...live, id: { notIn: [...used] } }, select: { name: true }, orderBy: { name: 'asc' }, take: max - names.length });
    names.push(...rest.map(x => x.name));
  }
  return { products: [...new Set(names)].slice(0, max), priority };
}

// ───────────── حلقة التعلّم في المسح والدراسة ─────────────

type TurnGuard = Pick<TurnRecord, 'source' | 'guard' | 'badKinds' | 'flags' | 'tokensIn' | 'tokensOut'>;
const RULES_TURN: TurnGuard = { source: 'RULES', guard: 'NONE', badKinds: [], flags: [], tokensIn: 0, tokensOut: 0 };
const uniq = (ids: (string | null | undefined)[]): string[] => [...new Set(ids.filter((x): x is string => !!x))];

/**
 * دروس الدورة كما طُبّقت فعلاً: المحقونة والمحجوبة حين قرأ العقل تعليماته (مصدر AI) وحده — بلا عقل (أو تعذّر النداء) لم
 * تصل شيئاً فلا تُعدّ «مطبَّقة على المسح» — وسطر «من تجربة فريقك» المعروض دائماً.
 */
function shownLessons(rec: TurnGuard, lessons: { injected: AiLessonLite[]; heldOut: string[] }, tips: (AiLessonLite | null | undefined)[]) {
  const brain = rec.source === 'AI';
  return {
    lessonIds: uniq([...(brain ? lessons.injected.map(l => l.id) : []), ...tips.map(l => l?.id)]),
    heldOutIds: brain ? lessons.heldOut : [],
  };
}

/** ما تعلّمته الشركة، وذراع اليوم لهذا المندوب (ضابطة بالنسبة المختارة)، وفترة اليوم بتوقيت الشركة (قراءة صفّ واحد). */
async function learningCtx(c: RepCtx, now: Date) {
  const [learned, tz] = await Promise.all([getLearned(c.tid), tenantTimezone(c.tid).catch(() => 'Asia/Riyadh')]);
  const arm = assignArm(c.tid, c.repId, riyadhDay(now), c.settings);
  return { learned, arm, hb: hourBand(now, tz), learnedOn: arm === 'LEARNED' && learned.mode !== 'OFF' };
}

/** دورة توجيه واحدة لكل مسح، وبحدّ دورة كل دقيقتين للمندوب — «حدّث» المتكرّر لا يُغرق التسميات بدورات متداخلة المرشّحين. */
export const SCAN_TURN_GAP_MS = 2 * 60_000;
const scanTurnAt = new Map<string, number>();

export function claimScanTurn(key: string, now = Date.now()): boolean {
  const last = scanTurnAt.get(key);
  if (last != null && now - last >= 0 && now - last < SCAN_TURN_GAP_MS) return false;
  if (scanTurnAt.size > 5000) for (const [k, t] of scanTurnAt) if (now - t >= SCAN_TURN_GAP_MS) scanTurnAt.delete(k);
  scanTurnAt.set(key, now);
  return true;
}

/**
 * بعد نداء العقل: الرموز تُحتسب، والدورة المحجوزة (chatTurns) تُردّ إن تعذّر النداء بلا رموز مصروفة (حدّ المضيف أو
 * دلو المنصّة، مهلة، مفتاح، تعذّر)، و«الاحتياط» (guardFallback) يُعدّ لما قصّه الحارس أو ردّه للحتمي وحده — لا لتعذّر النداء.
 */
async function settleAi(c: RepCtx, day: string, ai: { source: 'AI' | 'ERROR'; guard: string; tokensIn: number; tokensOut: number }): Promise<void> {
  // ERROR = لم يصل ردّ (والمبتور ثم المتعذّر مصدره AI برموزه) — لا بعدد الرموز: مضيفٌ لا يُبلغ الاستهلاك ردّه وصل
  if (ai.source === 'ERROR') await refundUsage(c.tid, c.repId, 'chatTurns', 1, day);
  await addUsage(c.tid, c.repId, {
    tokensIn: ai.tokensIn, tokensOut: ai.tokensOut,
    guardFallback: ai.source === 'AI' && (ai.guard === 'TRIM' || ai.guard === 'TEMPLATE') ? 1 : 0,
  });
}

// ───────────── «الطلب المتوقع من ملف المحل في Google» (googleDemand.ts) ─────────────
// لكل محل ولكل صنف في سيارة المندوب: حجم الطلب المعتاد للصنف من فواتير الشركة × مؤشرات ملف المحل (عدد المقيّمين مقارنةً
// بمحلات نوعه في المسح، والتقييم، وحديث المراجعات وذكر الصنف فيها حين تُقرأ) × معامل متعلَّم لنوع المحل. لا يمرّ بمحرّك
// المحلات المشابهة (estimateAt). تعذّر أي جزء يُسقط الطلب المتوقع وحده — لا المسح ولا الدراسة.

type DemandInputs = { anchors: Map<string, Anchor>; demand: SessionDemand };

/** مرساة كل صنف (ذاكرة ١٠ دقائق) وأصناف المندوب (من جلسة المسح إن وُجدت، وإلا سيارته الآن) — التعذّر null. */
async function demandInputs(c: RepCtx, sd?: SessionDemand | null): Promise<DemandInputs | null> {
  try {
    const anchors = await loadAnchors(c.tid);
    if (sd) return { anchors, demand: sd };
    const { products, source } = await loadDemandProducts(c.tid, c.repId, c.settings.priorityProductIds, anchors);
    return { anchors, demand: { baselines: {}, products, source } };
  } catch (e) {
    console.warn('[ai-rep] الطلب المتوقع تعذّر تحميله:', (e as Error)?.message, 'tenant', c.tid);
    return null;
  }
}

/** الطلب المتوقع لمحلٍّ واحد — null بلا أصناف. */
function expectedAt(c: RepCtx, d: DemandInputs | null, learned: Learned, o: {
  outletType: string; rating: number | null; ratingCount: number | null; reviews?: DemandReview[] | null; base?: TypeBaseline;
}): ExpectedShop | null {
  if (!d || !d.demand.products.length) return null;
  return expectedFor({
    ...o, products: d.demand.products, anchors: d.anchors, source: d.demand.source, showMoney: c.showMoney,
    cal: resolveGsigFactor(learned, o.outletType, c.settings.learningMode),
  });
}

/** ما عُرض لمحلٍّ ليس عميلاً يُذكر (يوماً) — يُقارن بأول طلب حقيقي إن صار عميلاً (لقطة gsig-1). */
function rememberShown(c: RepCtx, placeId: string, outletType: string, relation: string, e: ExpectedShop | null): void {
  if (!e || relation === 'CUSTOMER') return;
  const sh = shownOf(e, outletType);
  if (sh) noteShownExpected(c.tid, placeId, sh);
}

rep.post('/study', async (req: AuthRequest, res: Response, next: NextFunction) => {
  // الوحدة المحجوزة (يومها) وهل صُرفت عند Google — استثناءٌ بعد الحجز يردّها ما لم تُصرف
  let charged: string | null = null;
  let billed = false;
  try {
    const c = ctxOf(req);
    const b = studySchema.parse(req.body);
    const key = placesApiKey();
    if (!key) { res.status(503).json({ success: false, code: 'PLACES_NOT_CONFIGURED', message: 'دراسة المحل من خرائط Google تحتاج مفتاح Google للمنصّة — لم يُضبط بعد' }); return; }
    // محلٌّ من المسح الأخير: بلا خصم (حتى FREE_STUDIES_PER_SCAN، وإعادة دراسته لا تُحسب ثانيةً)
    const scanSession = getSession(c.tid, c.repId, b.searchId);
    const freeList = scanSession?.scan ? (scanSession.freeStudies ??= []) : null;
    const free = !!freeList && !!scanSession?.outlets.some(o => o.placeId === b.placeId)
      && (freeList.includes(b.placeId) || freeList.length < FREE_STUDIES_PER_SCAN);
    if (!free) {
      charged = await reserveUsage(c.tid, c.repId, 'searches', c.settings.dailySearchesPerRep);
      if (!charged) {
        res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', limit: c.settings.dailySearchesPerRep, message: `بلغت حدّ المسح والدراسة اليومي (${c.settings.dailySearchesPerRep}) — يتجدّد غداً` });
        return;
      }
    }
    // فشل Google (لا يُفوتر) والمحل المغلق نهائياً (لا دراسة للمندوب) يعيدان الوحدة
    const fail = async (status: number, body: object) => {
      if (charged) { await refundUsage(c.tid, c.repId, 'searches', 1, charged); charged = null; }
      res.status(status).json({ success: false, ...body });
    };

    const got = await placeProfile({ apiKey: key, placeId: b.placeId });
    if (!got.ok) { await fail(got.code === 'PLACES_QUOTA' ? 429 : got.code === 'PLACES_NOT_FOUND' ? 404 : 502, { code: got.code, message: got.message }); return; }
    billed = true;
    if (free && freeList && !freeList.includes(b.placeId)) freeList.push(b.placeId);
    const p = got.profile;
    // مغلق نهائياً حسب Google: لا دراسة ⇒ تُعاد الحصة
    if (p.closed) { await fail(422, { code: 'PLACE_CLOSED', message: 'هذا المحل مغلق حسب خرائط Google' }); return; }

    // نوع المحل (للتسجيل والإضافة عميلاً فقط — الدراسة لا تحتاجه)
    const outletType = outletTypeFromGoogle(p.primaryType, p.types, OUTLET_TYPE_CODES) ?? suggestOutletType(p.name) ?? c.settings.targetOutletTypes[0] ?? 'GROCERY';
    // ضغطة المندوب على محلٍّ مخفي (أُبلغ عن إغلاقه) تُعيده بذاكرته — لعلّه وجده مفتوحاً
    const [merged] = await mergeOnly(req, c, { lat: p.lat, lng: p.lng }, [outletType], [{
      placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, primaryType: null, types: googleTypesFor([outletType]),
    }], { keepHidden: true });

    let s = scanSession;
    if (!s || s.outlets.length >= 500) {
      s = { searchId: randomUUID(), createdAt: Date.now(), origin: b.gps ?? { lat: p.lat, lng: p.lng }, radiusM: c.settings.searchRadiusM, outlets: [] };
      saveSession(c.tid, c.repId, s);
    }
    const from = b.gps ?? s.origin;
    const distanceM = Math.round(haversineKm(from.lat, from.lng, p.lat, p.lng) * 1000);
    const existing = s.outlets.find(o => o.placeId === p.placeId);
    const ref = existing?.ref ?? `P${s.outlets.length + 1}`;
    const relation = merged?.relation ?? 'NEW';
    const customerId = merged?.customerId ?? null;
    if (!existing) {
      s.outlets.push({ ref, placeId: p.placeId, outletType, lat: p.lat, lng: p.lng, distanceM, relation, lastOutcome: merged?.lastOutcome ?? null, customerId });
    }

    // حلقة التعلّم: ذراع اليوم لهذا المندوب، ودروس الشركة لنوع المحل وسطر «من تجربة فريقك» في الذراع المتعلّمة وحدها
    const lc = await learningCtx(c, new Date());
    const turnId = randomUUID();
    const lessons = lc.learnedOn
      ? selectLessons(lc.learned.lessons, { turnId, intent: 'STUDY', types: new Set([outletType]), noTools: true })
      : { injected: [], heldOut: [] };
    const tip = lc.learnedOn ? statsHint(lc.learned.lessons, { types: [outletType], hb: lc.hb, prefer: 'STUDY' }) : null;

    // الطلب المتوقع بنصوص المراجعات (المحل عموماً وذكر أصناف المندوب) — يحلّ في الواجهة محلّ طلب المسح
    let expected: ExpectedShop | null = null;
    try {
      const dem = await demandInputs(c, scanSession?.demand);
      expected = expectedAt(c, dem, lc.learned, {
        outletType, rating: p.rating, ratingCount: p.ratingCount, reviews: p.reviews.map(r => ({ rating: r.rating, text: r.text })),
        base: dem?.demand.baselines[outletType],
      });
      rememberShown(c, p.placeId, outletType, relation, expected);
    } catch (e) { expected = null; console.warn('[ai-rep] الطلب المتوقع للدراسة تعذّر:', (e as Error)?.message, 'tenant', c.tid); }

    // الدراسة: بالعقل (بلغة المندوب) إن ضُبط وتوفّرت حصته، وإلا حتمية من الملف نفسه (ونفاد الحصة يُقال للمندوب)
    let study: ShopStudy = ruleStudy(p, tip?.textAr ?? null, tip?.key ?? null);
    let rec: TurnGuard = RULES_TURN;
    let aiQuota = false;
    const cfg = llmConfig();
    if (cfg && c.settings.advisorEnabled) {
      const aiDay = await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep);
      if (!aiDay) aiQuota = true;
      else {
        const { products, priority } = await studyProducts(c.tid, c.settings.priorityProductIds);
        const ai = await aiStudy(p, {
          cfg, products, priority, playbook: c.settings.playbook, lessonsBlock: renderLessonsBlock(lessons.injected), lang: repLang(b.lang),
          expected: studyExpected(expected),
        });
        await settleAi(c, aiDay, ai);
        rec = { source: ai.source, guard: ai.guard, badKinds: ai.badKinds, flags: ai.flags, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut };
        if (ai.study) study = { ...ai.study, teamTip: tip?.textAr ?? null, teamTipKey: tip?.key ?? null };
        else console.warn('[ai-rep] دراسة المحل بالعقل تعذّرت:', ai.code, 'tenant', c.tid);
      }
    }
    // دورة دراسة بلا مرشّحين ولا نص: الحارس وأعلامه والدروس المعروضة — تغذّي تقييم المناديب وتجارب الدروس
    await recordTurn({
      id: turnId, tenantId: c.tid, salesRepId: c.repId, kind: 'STUDY', intent: 'STUDY', arm: lc.arm, policyVersion: 0, hourBand: lc.hb,
      ...rec, tools: [], hops: 0, ...shownLessons(rec, lessons, [tip]),
    });

    res.json({
      success: true,
      data: {
        searchId: s.searchId,
        turnId,
        item: {
          ref, placeId: p.placeId, name: p.name, address: p.address, lat: p.lat, lng: p.lng, outletType, outletTypeLabel: outletTypeLabel(outletType),
          distanceM, relation, customerId, lastOutcome: merged?.lastOutcome ?? null, lastOutcomeAt: merged?.lastOutcomeAt ?? null,
          rejectedRecently: merged?.rejectedRecently ?? false, reportedClosed: merged?.reportedClosed ?? false,
          ...(expected && { expected: expectedView(expected) }),
        },
        profile: {
          name: p.name, typeLabel: p.typeLabel, address: p.address, mapsUri: p.mapsUri, rating: p.rating, ratingCount: p.ratingCount,
          openNow: p.openNow, hours: p.hours, reviews: p.reviews,
        },
        study,
        aiQuota,
        searchesLeft: await searchesLeft(c),
      },
    });
  } catch (err) {
    const c = (req as AuthRequest & { aiRep?: RepCtx }).aiRep;
    if (charged && !billed && c) await refundUsage(c.tid, c.repId, 'searches', 1, charged).catch(() => undefined);
    next(err);
  }
});

// ───────────── المسح: كل المحلات حول المندوب من خرائط Google + توجيه (بلا عمل من المندوب) ─────────────
// بمفتاح الأماكن: البحث الرسمي. بلا مفتاح: بحث خرائط Google العام (publicMaps.ts) — بلا مراجعات نصية.
// الرد فوري بالقائمة والخطة الحتمية؛ وتوجيه العقل (إن ضُبط) نداءٌ ثانٍ POST /rep/scan/guide من الجلسة تستبدل به الشاشة
// الخطة حين يصل — فلا ينتظر المندوب النموذج فوق بحث Google.
const scanSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).optional(),
  /** لغة واجهة المندوب (repLang: غير المعروفة عربية) — يكتب بها توجيه العقل */
  lang: z.string().max(8).optional(),
});

/** أسوأ دقّة موقع يُمسح حولها: فوقها (الموقع الدقيق مطفأ في الجوال) المحلات والمسافات من نقطةٍ على بعد كيلومترات. */
export const SCAN_MAX_ACCURACY_M = 500;

rep.post('/scan', async (req: AuthRequest, res: Response, next: NextFunction) => {
  // الوحدة المحجوزة (يومها) وهل صُرفت (بحث Google نجح) — استثناءٌ بعد الحجز يردّها ما لم تُصرف
  let charged: string | null = null;
  let spent = false;
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
    charged = await reserveUsage(c.tid, c.repId, 'searches', c.settings.dailySearchesPerRep);
    if (!charged) {
      res.status(429).json({ success: false, code: 'AI_REP_DAILY_LIMIT', limit: c.settings.dailySearchesPerRep, message: `بلغت حدّ المسح اليومي (${c.settings.dailySearchesPerRep}) — نتائجك الحالية تبقى متاحة` });
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
        // بحثٌ ناجح مُفوتَر ولو خلا — لا تُعاد وحدته
        spent = true;
        for (const p of r.places) {
          const type = outletTypeFromGoogle(p.primaryType, p.types, types) ?? types[0];
          found.set(p.placeId, { placeId: p.placeId, name: p.name, rating: null, ratingCount: null, lat: p.lat, lng: p.lng, category: outletTypeLabel(type), openNow: null, hours: [], address: p.address, type });
        }
      } else source = 'PUBLIC';
    }
    if (!found.size) {
      source = 'PUBLIC';
      // نافذتان لكل نوع عبر الذاكرة المؤقتة والقاطع وحدّ التزامن، والنوع من تصنيف Google للمحل، وبلد البحث بلد الشركة (publicMaps.ts)
      const r = await publicScan({ types, targets, lat: b.lat, lng: b.lng, radiusM, country: c.countryCode });
      if (!r.ok) {
        // صيغة مجهولة أو حجب أو قاطع: تُعاد الحصة (ما لم يُفوتَر بحث الأماكن) ويُمهَل المندوب — لا «لا محلات حولك»
        if (!spent) await refundUsage(c.tid, c.repId, 'searches', 1, charged);
        charged = null;
        noteRepScanFailed(repKey);
        console.warn('[ai-rep] المسح العام تعذّر', r.code, r.codes.join(','), 'tenant', c.tid);
        res.status(r.code === 'SCAN_COOLDOWN' ? 503 : 502).json({ success: false, code: r.code, message: r.message, retryAfterS: r.retryAfterS ?? Math.ceil(REP_RETRY_MS / 1000) });
        return;
      }
      spent = true;
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
    // حلقة التعلّم: ذراع اليوم وسياسة الترتيب وفترة اليوم — وسطر «من تجربة فريقك» لكل نوع في الذراع المتعلّمة وحدها
    // ومعهما مدخلات «الطلب المتوقع» (مرساة الأصناف وأصناف سيارة المندوب)
    const now = new Date();
    const [lc, dem] = await Promise.all([learningCtx(c, now), merged.length ? demandInputs(c) : Promise.resolve(null)]);
    // الطلب المتوقع لكل محل في تمريرة واحدة: وسيط مقيّمي كل نوع من محلات هذا المسح نفسه — تعذّره يُسقطه وحده لا المسح
    let baselines = new Map<string, TypeBaseline>();
    const expected = new Map<string, ExpectedShop>();
    try {
      baselines = typeBaselines(merged.map(m => ({ outletType: m.outletType, ratingCount: byId.get(m.placeId)?.ratingCount ?? null })));
      for (const m of merged) {
        const p = byId.get(m.placeId)!;
        const e = expectedAt(c, dem, lc.learned, { outletType: m.outletType, rating: p.rating, ratingCount: p.ratingCount, base: baselines.get(m.outletType) });
        if (e) expected.set(m.placeId, e);
      }
    } catch (e) {
      expected.clear();
      console.warn('[ai-rep] الطلب المتوقع تعذّر:', (e as Error)?.message, 'tenant', c.tid);
    }
    const tips = new Map<string, AiLessonLite | null>();
    const studyTip = (t: string): AiLessonLite | null => {
      if (!tips.has(t)) tips.set(t, lc.learnedOn ? statsHint(lc.learned.lessons, { types: [t], hb: lc.hb, prefer: 'STUDY' }) : null);
      return tips.get(t) ?? null;
    };
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
        ...(expected.has(m.placeId) && { expected: expectedView(expected.get(m.placeId)!) }),
        profile,
        study: ruleStudy({ ...profile, placeId: p.placeId, primaryType: null, types: [], lat: p.lat, lng: p.lng, priceLevel: null, closed: false, typeLabel: p.category },
          studyTip(m.outletType)?.textAr ?? null, studyTip(m.outletType)?.key ?? null),
      };
    });
    // ذاكرة الزيارات (آخر نتيجة ولحظتها) تصل التوجيه: ما زاره الفريق مؤخراً لا يعود «فرصة جديدة»، والمهتم يصير متابعة
    const shops: ScanShop[] = items.map(it => ({
      ref: it.ref, placeId: it.placeId, outletType: it.outletType,
      name: it.name, category: it.profile.typeLabel, rating: it.profile.rating, ratingCount: byId.get(it.placeId)?.ratingCount ?? null, openNow: it.profile.openNow,
      distanceM: it.distanceM, lat: it.lat, lng: it.lng, relation: it.relation, rejectedRecently: it.rejectedRecently,
      lastOutcome: it.lastOutcome, lastOutcomeAt: it.lastOutcomeAt, reportedClosed: it.reportedClosed,
      expected: topExpected(expected.get(it.placeId)),
    }));
    for (const it of items) rememberShown(c, it.placeId, it.outletType, it.relation, expected.get(it.placeId) ?? null);
    // الترتيب: السياسة المتعلَّمة في الذراع المتعلّمة إن رُقّيت نسخة، وإلا ترتيب ما قبل التعلّم — فالذراعان سواء حتى يثبت شيء
    const policy = policyFor(lc.learned, lc.arm);
    const score = policy.version > 0 ? learnedScorer(policy.params, lc.hb) : baselineScore;
    const turnId = randomUUID();
    const lessons = lc.learnedOn
      ? selectLessons(lc.learned.lessons, { turnId, intent: 'GUIDE', types: new Set(items.map(it => it.outletType)), noTools: true })
      : { injected: [], heldOut: [] };
    let guide: ScanGuide = ruleGuide(shops, origin, now, score);
    // «من تجربة فريقك» للخطة: أنواع محطاتها بترتيبها ثم بقية الأنواع حوله
    const typeOf = new Map(items.map(it => [it.ref, it.outletType]));
    const tip = lc.learnedOn
      ? statsHint(lc.learned.lessons, { types: uniq([...guide.stops.map(st => typeOf.get(st.ref)), ...items.map(it => it.outletType)]), hb: lc.hb, prefer: 'GUIDE' })
      : null;
    guide = { ...guide, tip: tip?.textAr ?? null, tipKey: tip?.key ?? null };
    // دورة توجيه لهذا المسح: المرشّحون بميزات Google وموضعهم في الخطة (تُسمّى ليلاً بزيارات المندوب نفسه خلال ٧٢ ساعة)؛
    // يحدّثها توجيه العقل حين يصل (updateTurn)
    const recorded = shops.length > 0 && claimScanTurn(repKey, now.getTime());
    if (recorded) {
      await recordTurn({
        id: turnId, tenantId: c.tid, salesRepId: c.repId, kind: 'GUIDE', intent: 'GUIDE', arm: lc.arm, policyVersion: policy.version, hourBand: lc.hb,
        ...RULES_TURN, tools: [], hops: 0, ...shownLessons(RULES_TURN, lessons, [tip, ...tips.values()]),
        candidates: scanCandidates(shops, now, score, guide.stops.map(st => st.ref)),
      });
    }
    // turnId داخل التوجيه (يُحفظ معه في جلسة الشاشة) لتقييم المندوب 👍/👎 — null حين لم تُسجَّل دورة
    const shownTurn = recorded ? turnId : null;
    const learnedFlag = policy.version > 0;
    // العقل: إن ضُبط ومفعّلٌ للشركة وفي المنطقة فرصة أو متابعة — مدخلاته في الجلسة لنداء /scan/guide (الحصة تُحجز هناك)
    const recommended = rankedPool(shops, now, score).map(x => x.s.ref);
    const aiGuidePending = !!llmConfig() && c.settings.advisorEnabled && recommended.length > 0;
    saveSession(c.tid, c.repId, {
      searchId, createdAt: Date.now(), origin, radiusM, scan: true,
      outlets: items.map(it => ({ ref: it.ref, placeId: it.placeId, outletType: it.outletType, lat: it.lat, lng: it.lng, distanceM: it.distanceM, relation: it.relation, lastOutcome: it.lastOutcome, customerId: it.customerId })),
      ...(dem && { demand: { ...dem.demand, baselines: Object.fromEntries(baselines) } }),
      ...(aiGuidePending && {
        aiGuide: {
          at: now, shops, recommended, score, rules: guide, learned: learnedFlag, turnId: shownTurn, lessons, tips: [tip, ...tips.values()],
          playbook: c.settings.playbook, lang: repLang(b.lang),
        },
      }),
    });
    console.info('[ai-rep] مسح', JSON.stringify({ tenant: c.tid, source, shops: items.length, partial, arm: lc.arm, turn: recorded, ai: aiGuidePending, expected: expected.size }));
    res.json({
      success: true,
      data: { searchId, source, items, guide: { ...guide, turnId: shownTurn, learned: learnedFlag }, partial, turnId: shownTurn, aiGuidePending, searchesLeft: await searchesLeft(c) },
    });
  } catch (err) {
    const c = (req as AuthRequest & { aiRep?: RepCtx }).aiRep;
    if (charged && !spent && c) await refundUsage(c.tid, c.repId, 'searches', 1, charged).catch(() => undefined);
    next(err);
  }
});

/**
 * توجيه العقل لمسحٍ من جلسته: دورة محجوزة (chatTurns) تُردّ إن تعذّر النموذج بلا رموز، ودورة المسح تُحدَّث بمصدرها وحارسها
 * وخطتها. guide = null ⇒ تبقى الخطة الحتمية، وreason يقول لماذا (نفاد الحصة يُقال للمندوب).
 */
async function runScanGuide(c: RepCtx, pg: PendingScanGuide, origin: { lat: number; lng: number }) {
  const cfg = llmConfig();
  if (!cfg || !c.settings.advisorEnabled) return { guide: null, reason: 'AI_UNAVAILABLE' as const };
  const day = await reserveUsage(c.tid, c.repId, 'chatTurns', c.settings.dailyChatTurnsPerRep);
  if (!day) return { guide: null, reason: 'AI_QUOTA' as const };
  const ai = await aiGuide(pg.shops, {
    cfg, playbook: pg.playbook, origin, now: pg.at, recommended: pg.recommended, lang: pg.lang,
    lessonsBlock: renderLessonsBlock(pg.lessons.injected), rulesSummary: pg.rules.summary, rulesFacts: pg.rules.facts,
  });
  await settleAi(c, day, ai);
  const rec: TurnGuard = { source: ai.source, guard: ai.guard, badKinds: ai.badKinds, flags: ai.flags, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut };
  if (pg.turnId) {
    await updateTurn(c.tid, c.repId, pg.turnId, {
      ...rec, ...shownLessons(rec, pg.lessons, pg.tips),
      ...(ai.guide && { candidates: scanCandidates(pg.shops, pg.at, pg.score, ai.guide.stops.map(st => st.ref)) }),
    });
  }
  if (!ai.guide) {
    console.warn('[ai-rep] توجيه المسح بالعقل تعذّر:', ai.code ?? ai.flags.join(','), 'tenant', c.tid);
    return { guide: null, reason: ai.source === 'ERROR' ? 'AI_UNAVAILABLE' as const : 'AI_REJECTED' as const };
  }
  console.info('[ai-rep] توجيه المسح', JSON.stringify({ tenant: c.tid, guard: ai.guard, tin: ai.tokensIn, tout: ai.tokensOut }));
  return { guide: { ...ai.guide, tip: pg.rules.tip ?? null, tipKey: pg.rules.tipKey ?? null, turnId: pg.turnId, learned: pg.learned }, reason: null };
}

const scanGuideSchema = z.object({ searchId: z.string().uuid() });

rep.post('/scan/guide', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const c = ctxOf(req);
    const b = scanGuideSchema.parse(req.body);
    const s = getSession(c.tid, c.repId, b.searchId);
    const pg = s?.aiGuide;
    if (!s || !pg) { res.status(409).json(NO_SESSION); return; }
    // نداءٌ واحد لكل مسح: الثاني (إعادة محاولة الشبكة أو شاشة أُعيد تركيبها) ينتظر الأول ولا يُكلّف شيئاً
    if (!pg.result) pg.result = runScanGuide(c, pg, s.origin).catch(e => { pg.result = undefined; throw e; });
    res.json({ success: true, data: await pg.result });
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
    // مندوبٌ محذوف أو من شركة أخرى يُسقط بصمت (كالمنتجات) — لا يرفض كل حفظٍ لاحق؛ و«محدّدون» بلا أحدٍ بعدها مرفوض
    let repIds = input.repIds;
    if (repIds?.length) {
      const valid = await prisma.salesRep.findMany({ where: { tenantId: tid, id: { in: repIds } }, select: { id: true } });
      const ok = new Set(valid.map(v => v.id));
      repIds = [...new Set(repIds)].filter(id => ok.has(id));
    }
    if (input.repScope === 'SELECTED' && repIds && !repIds.length) { res.status(400).json({ success: false, message: NO_SELECTED_REPS }); return; }
    const data = {
      ...input,
      ...(priority && { priorityProductIds: priority }),
      ...(repIds && { repIds }),
      playbook: input.playbook === undefined ? undefined : (input.playbook || null),
      updatedById: actorOf(req),
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
    const r = await applyLessonAction(tid, String(req.params.id), action, actorOf(req), settings.playbook);
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
    const r = await rollbackModel(tid, kind, version, actorOf(req), 'ADMIN');
    if (!r.ok) { res.status(404).json({ success: false, message: 'النسخة غير موجودة أو لا يمكن الرجوع إليها' }); return; }
    res.json({ success: true, data: { ok: true } });
  } catch (err) { next(err); }
});

admin.post('/learning/reset', requireAdminPermission('canManageCompanySettings'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    if (await adminScopeEnabled(req)) { res.status(403).json(SCOPED_LEARNING); return; }
    z.object({ confirm: z.literal(true) }).parse(req.body);
    await resetLearning(tid, actorOf(req));
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

export default router;
