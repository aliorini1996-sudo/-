/**
 * «إدارة المبيعات» (طلب المالك ١٦ نوفمبر ٢٠٢٦) — قمعٌ واحد لكل من تواصل مع المنصة، بديل صفحة «عروض الأسعار»:
 *  - التسجيل التجريبي: ذاتياً من الموقع (TRIAL) أو حساباً فتحه سفير من بوابته (AMBASSADOR_TRIAL) — يُزامَن من الشركات.
 *  - نماذج الموقع: تواصل معنا، طلب اشتراك، طلب عرض سعر، احجز اجتماع — تُكتب لحظة الإرسال (routes/contact.ts).
 *  - محادثات بوت واتساب (WHATSAPP) — تُزامَن من البوت لمن يملك محادثاته وحده.
 *  - البريد الوارد غير مربوط بالمنصة — لا شيء يُزامَن منه.
 *  - مولد الفواتير المجاني مستثنى بقرار المالك (له صفحته في العملاء المحتملين).
 *
 * **المرحلة والملاحظة للبشر:** المزامنة تحدّث الحقول الوصفية وحدها (syncPatch) ولا تمسّهما أبداً، ولا firstAt بعد الإنشاء.
 * **المزامنة عند فتح الصفحة** مخنوقةٌ مرّةً كل دقيقة لكل عملية، وأفضل جهد: تعذّرها لا يُفشل القائمة.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { fetchWaBot, WaBotResult } from './waBotInbox';

// ───────────────────────────── القنوات والمراحل ─────────────────────────────

export const SALES_CHANNELS = ['TRIAL', 'AMBASSADOR_TRIAL', 'MEETING', 'CONTACT', 'SUBSCRIPTION', 'QUOTE_REQUEST', 'WHATSAPP'] as const;
export type SalesChannel = typeof SALES_CHANNELS[number];
export const SALES_STAGES = ['NEW', 'CONTACTED', 'MEETING', 'NEGOTIATION', 'WON', 'LOST', 'NOT_FIT'] as const;
export type SalesStage = typeof SALES_STAGES[number];

const TRIAL_CHANNELS: SalesChannel[] = ['TRIAL', 'AMBASSADOR_TRIAL'];
export type FormChannel = 'CONTACT' | 'SUBSCRIPTION' | 'QUOTE_REQUEST' | 'MEETING';

/** «من أين أتى» لكل نموذج في الموقع */
export const FORM_ORIGIN: Record<FormChannel, string> = {
  CONTACT: 'الموقع — نموذج تواصل معنا',
  SUBSCRIPTION: 'الموقع — طلب اشتراك',
  QUOTE_REQUEST: 'الموقع — طلب عرض سعر',
  MEETING: 'الموقع — احجز اجتماع',
};
export const TRIAL_ORIGIN = 'الموقع — التسجيل التجريبي';
export const WHATSAPP_ORIGIN = 'واتساب — بوت المبيعات';

const isChannel = (v: unknown): v is SalesChannel => typeof v === 'string' && (SALES_CHANNELS as readonly string[]).includes(v);
const isStage = (v: unknown): v is SalesStage => typeof v === 'string' && (SALES_STAGES as readonly string[]).includes(v);

/** نصٌّ مقصوص بلا فراغات حوله، أو null للفارغ وغير النصّ */
function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

// ───────────────────────────── الحقول الوصفية ─────────────────────────────

/** ما تكتبه المزامنة والنماذج — لا stage ولا note فيه (للبشر وحدهم) */
export interface SalesFields {
  channel: SalesChannel;
  sourceRef: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  country: string | null;
  message: string | null;
  origin: string | null;
  tenantId: string | null;
  firstAt: Date;
  lastAt: Date;
}

const SYNCED_TEXT = ['name', 'company', 'phone', 'email', 'country', 'message', 'origin', 'tenantId'] as const;

/** صفٌّ قائم كما تقرؤه المزامنة (EXISTING_SELECT) */
export interface ExistingRow {
  id: string; channel: string; sourceRef: string; name: string | null; company: string | null; phone: string | null;
  email: string | null; country: string | null; message: string | null; origin: string | null; tenantId: string | null; lastAt: Date;
}

/**
 * ما يتغيّر في صفٍّ قائم عند المزامنة: الحقول الوصفية وlastAt (والقناة لتجربةٍ تغيّر مصدرها) — **أبداً** المرحلة والملاحظة
 * وfirstAt. null = لا تغيير (فلا كتابة).
 */
export function syncPatch(cur: ExistingRow, next: SalesFields): Partial<SalesFields> | null {
  const patch: Record<string, unknown> = {};
  if (cur.channel !== next.channel) patch.channel = next.channel;
  for (const k of SYNCED_TEXT) if ((cur[k] ?? null) !== (next[k] ?? null)) patch[k] = next[k] ?? null;
  if (new Date(cur.lastAt).getTime() !== next.lastAt.getTime()) patch.lastAt = next.lastAt;
  return Object.keys(patch).length ? (patch as Partial<SalesFields>) : null;
}

// ───────────────────────────── التجارب ─────────────────────────────

export interface TrialInput {
  tenant: { id: string; name: string | null; createdAt: Date };
  /** أقدم مدير (ADMIN) للشركة — صاحب التسجيل */
  admin: { name: string | null; email: string | null } | null;
  settings: { phone: string | null; countryCode: string | null } | null;
  attribution: { source: string; codeUsed: string | null; affiliate: { fullName: string | null; code: string | null } | null } | null;
}

/** شركةٌ تجريبية ⇒ صفّها: «فتحها سفير» (portal) قناةٌ مستقلة، والتسجيل الذاتي بكود سفير يُذكر الكود في «من أين أتى» */
export function trialFields(i: TrialInput): SalesFields {
  const a = i.attribution;
  const portal = a?.source === 'portal';
  let origin: string;
  if (portal) {
    origin = `سفير: ${clip(a?.affiliate?.fullName, 120) || clip(a?.affiliate?.code, 40) || clip(a?.codeUsed, 40) || '—'}`;
  } else {
    origin = TRIAL_ORIGIN;
    const code = a?.source === 'signup_code' ? clip(a.codeUsed, 40) || clip(a.affiliate?.code, 40) : null;
    if (code) origin += ` · كود سفير ${code}`;
  }
  return {
    channel: portal ? 'AMBASSADOR_TRIAL' : 'TRIAL',
    sourceRef: i.tenant.id,
    name: clip(i.admin?.name, 200),
    company: clip(i.tenant.name, 200),
    phone: clip(i.settings?.phone, 40),
    email: clip(i.admin?.email, 200),
    country: clip(i.settings?.countryCode, 10),
    message: null,
    origin,
    tenantId: i.tenant.id,
    firstAt: i.tenant.createdAt,
    lastAt: i.tenant.createdAt,
  };
}

// ───────────────────────────── واتساب ─────────────────────────────

/** محادثةٌ من /inbox/threads في البوت ⇒ صفّها، أو null لما لا رقم له أو لا تاريخ */
export function whatsappFields(t: unknown): SalesFields | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const digits = String(o.phone ?? '').replace(/\D/g, '').slice(0, 20);
  if (!digits) return null;
  const lastAt = new Date(String(o.lastAt ?? ''));
  if (Number.isNaN(lastAt.getTime())) return null;
  const stageAr = clip(o.stageAr, 60);
  return {
    channel: 'WHATSAPP',
    sourceRef: digits,
    name: clip(o.name, 200),
    company: null,
    phone: `+${digits}`,
    email: null,
    country: null,
    message: clip(o.lastBody, 300),
    origin: WHATSAPP_ORIGIN + (stageAr ? ` · ${stageAr}` : ''),
    tenantId: null,
    firstAt: lastAt,
    lastAt,
  };
}

// ───────────────────────────── النماذج ─────────────────────────────

export interface FormContactInput {
  channel: FormChannel;
  name?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
  country?: string | null;
  message?: string | null;
}

export function formFields(i: FormContactInput, now: Date = new Date(), ref: string = crypto.randomUUID()): SalesFields {
  return {
    channel: i.channel,
    sourceRef: ref,
    name: clip(i.name, 200),
    company: clip(i.company, 200),
    phone: clip(i.phone, 40),
    email: clip(i.email, 200),
    country: clip(i.country, 100),
    message: clip(i.message, 2000),
    origin: FORM_ORIGIN[i.channel],
    tenantId: null,
    firstAt: now,
    lastAt: now,
  };
}

type Db = typeof prisma;

/**
 * يسجّل تواصلاً وارداً من نموذج — يُنادى **قبل** البريد ولا يرمي أبداً: تعذّر القاعدة لا يمنع البريد (سطر سجلٍّ وحده).
 * true = سُجّل.
 */
export async function recordInboundContact(i: FormContactInput, db: Db = prisma): Promise<boolean> {
  try {
    await db.salesContact.create({ data: formFields(i) });
    return true;
  } catch (e) {
    console.error('[sales-inbox] تعذّر تسجيل التواصل الوارد:', (e as Error)?.message || e);
    return false;
  }
}

// ───────────────────────────── المزامنة ─────────────────────────────

const EXISTING_SELECT = {
  id: true, channel: true, sourceRef: true, name: true, company: true, phone: true, email: true, country: true,
  message: true, origin: true, tenantId: true, lastAt: true,
} as const;

/** يكتب الصفوف: الجديد دفعةً (skipDuplicates لمزامنتين متزامنتين)، والقائم بما تغيّر وحده — المرحلة والملاحظة لا تُمسّان */
async function writeSynced(db: Db, rows: SalesFields[], existing: ExistingRow[]): Promise<{ created: number; updated: number }> {
  const byRef = new Map(existing.map((e) => [e.sourceRef, e]));
  const fresh: SalesFields[] = [];
  let updated = 0;
  for (const row of rows) {
    const cur = byRef.get(row.sourceRef);
    if (!cur) { fresh.push(row); continue; }
    const patch = syncPatch(cur, row);
    if (!patch) continue;
    try {
      await db.salesContact.update({ where: { id: cur.id }, data: patch });
      updated++;
    } catch (e) {
      console.error('[sales-inbox] تعذّر تحديث صف:', (e as Error)?.message || e);
    }
  }
  let created = 0;
  if (fresh.length) created = (await db.salesContact.createMany({ data: fresh, skipDuplicates: true })).count;
  return { created, updated };
}

const TRIAL_SCAN_MAX = 2000;

/** كل شركةٍ باقتها trial ⇒ صفّها (بمعرّف الشركة). يُطابَق القائم بمعرّف الشركة عبر قناتي التجربة معاً */
export async function syncTrials(db: Db = prisma): Promise<{ created: number; updated: number }> {
  const tenants = await db.tenant.findMany({
    where: { plan: 'trial' },
    orderBy: { createdAt: 'desc' },
    take: TRIAL_SCAN_MAX,
    select: {
      id: true, name: true, createdAt: true,
      settings: { select: { phone: true, countryCode: true } },
      admins: { where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, take: 1, select: { name: true, email: true } },
    },
  });
  if (!tenants.length) return { created: 0, updated: 0 };
  const ids = tenants.map((t) => t.id);
  const [attributions, existing] = await Promise.all([
    db.tenantAttribution.findMany({
      where: { tenantId: { in: ids } },
      select: { tenantId: true, source: true, codeUsed: true, affiliate: { select: { fullName: true, code: true } } },
    }),
    db.salesContact.findMany({ where: { channel: { in: TRIAL_CHANNELS }, sourceRef: { in: ids } }, select: EXISTING_SELECT }),
  ]);
  const attrBy = new Map(attributions.map((a) => [a.tenantId, a]));
  const rows = tenants.map((t) => trialFields({
    tenant: { id: t.id, name: t.name, createdAt: t.createdAt },
    admin: t.admins[0] ?? null,
    settings: t.settings ?? null,
    attribution: attrBy.get(t.id) ?? null,
  }));
  return writeSynced(db, rows, existing);
}

export interface WhatsappStatus { ok: boolean; included: boolean; error?: string }

type WaFetcher = (path: string, opts: { timeoutMs: number; timeoutMessage: string }) => Promise<WaBotResult>;

export const WA_SYNC_TIMEOUT_MS = 8000;

/** محادثات البوت (حتى ٥٠٠ — والبوت يقصّها بحدّه) ⇒ صفوفها برقم الجوال. تعذّر البوت يُبقي الصفوف القائمة كما هي */
export async function syncWhatsapp(db: Db = prisma, fetcher: WaFetcher = fetchWaBot): Promise<WhatsappStatus> {
  const r = await fetcher('/inbox/threads?limit=500', {
    timeoutMs: WA_SYNC_TIMEOUT_MS,
    timeoutMessage: 'بوت واتساب لم يستجب خلال ثوانٍ — قد يكون نائماً، أعد التحميل بعد قليل',
  });
  if (!r.ok) return { ok: false, included: true, error: r.message };
  const threads = (r.body as { threads?: unknown } | null)?.threads;
  if (!Array.isArray(threads)) return { ok: false, included: true, error: 'ردّ البوت بلا قائمة محادثات' };
  const byRef = new Map<string, SalesFields>();
  for (const t of threads) {
    const f = whatsappFields(t);
    if (f && !byRef.has(f.sourceRef)) byRef.set(f.sourceRef, f);
  }
  const rows = [...byRef.values()];
  if (rows.length) {
    const existing = await db.salesContact.findMany({
      where: { channel: 'WHATSAPP', sourceRef: { in: rows.map((x) => x.sourceRef) } },
      select: EXISTING_SELECT,
    });
    await writeSynced(db, rows, existing);
  }
  return { ok: true, included: true };
}

/** خنق المزامنة لكل عملية: مرّةً كل دقيقة، وواتساب المتعذّر يُعاد بعد ٢٠ث (أُوقظ البوت بالمحاولة الأولى غالباً) */
export const SYNC_EVERY_MS = 60_000;
export const WA_RETRY_MS = 20_000;
const NEVER = Number.NEGATIVE_INFINITY;
const state = {
  trialsAt: NEVER,
  trialsRun: null as Promise<void> | null,
  waNextAt: 0,
  waRun: null as Promise<WhatsappStatus> | null,
  waLast: null as WhatsappStatus | null,
  syncedAt: 0,
};

/** للاختبار: تفريغ الخنق */
export function resetSalesSyncThrottle(): void {
  state.trialsAt = NEVER; state.trialsRun = null; state.waNextAt = 0; state.waRun = null; state.waLast = null; state.syncedAt = 0;
}

/**
 * مزامنة ما قبل القائمة — لا ترمي أبداً. التجارب للجميع، وواتساب حين `includeWhatsapp` وحده.
 * طلبان متزامنان ينتظران المزامنة نفسها لا يبدأان اثنتين.
 */
export async function syncSalesInbox(opts: {
  includeWhatsapp: boolean; db?: Db; fetcher?: WaFetcher; now?: number;
}): Promise<{ whatsapp: WhatsappStatus; syncedAt: Date }> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now();

  if (!state.trialsRun && now - state.trialsAt >= SYNC_EVERY_MS) {
    state.trialsAt = now;
    state.trialsRun = syncTrials(db)
      .then(() => { state.syncedAt = Date.now(); })
      .catch((e) => { console.error('[sales-inbox] تعذّرت مزامنة التجارب:', (e as Error)?.message || e); })
      .finally(() => { state.trialsRun = null; });
  }

  let whatsapp: WhatsappStatus = { ok: true, included: false };
  if (opts.includeWhatsapp) {
    if (!state.waRun && now >= state.waNextAt) {
      state.waRun = syncWhatsapp(db, opts.fetcher)
        .catch((e): WhatsappStatus => {
          console.error('[sales-inbox] تعذّرت مزامنة واتساب:', (e as Error)?.message || e);
          return { ok: false, included: true, error: 'تعذّر حفظ محادثات واتساب' };
        })
        .then((s) => {
          state.waLast = s;
          state.waNextAt = now + (s.ok ? SYNC_EVERY_MS : WA_RETRY_MS);
          return s;
        })
        .finally(() => { state.waRun = null; });
    }
    whatsapp = state.waRun ? await state.waRun : (state.waLast ?? { ok: true, included: true });
  }
  if (state.trialsRun) await state.trialsRun;
  return { whatsapp, syncedAt: new Date(state.syncedAt || now) };
}

// ───────────────────────────── القائمة والتعديل ─────────────────────────────

export interface SalesListParams { channel?: SalesChannel; stage?: SalesStage; q?: string; limit: number }

export const LIST_DEFAULT = 300;
export const LIST_MAX = 1000;

/** معاملات الاستعلام نصوصاً فقط (Express يحلّل ?x[not]=y كائناً) — القناة والمرحلة المجهولتان تُهملان */
export function parseSalesListQuery(query: Record<string, unknown>): SalesListParams {
  const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const n = Number(s(query.limit));
  const limit = Number.isFinite(n) && n >= 1 ? Math.min(LIST_MAX, Math.floor(n)) : LIST_DEFAULT;
  const channel = s(query.channel);
  const stage = s(query.stage);
  const q = s(query.q).slice(0, 100);
  return {
    limit,
    ...(isChannel(channel) ? { channel } : {}),
    ...(isStage(stage) ? { stage } : {}),
    ...(q ? { q } : {}),
  };
}

/** شرط القائمة: نطاق ما يراه الطالب (بلا واتساب لمن لا يملك محادثات البوت) ثم المرشّحات */
export function buildSalesWhere(p: Partial<SalesListParams>, includeWhatsapp: boolean): Prisma.SalesContactWhereInput {
  const and: Prisma.SalesContactWhereInput[] = [];
  if (!includeWhatsapp) and.push({ channel: { not: 'WHATSAPP' } });
  if (p.channel) and.push({ channel: p.channel });
  if (p.stage) and.push({ stage: p.stage });
  if (p.q) {
    const c = { contains: p.q, mode: 'insensitive' as const };
    const or: Prisma.SalesContactWhereInput[] = [{ name: c }, { company: c }, { phone: c }, { email: c }, { origin: c }];
    // جوالٌ يُكتب محلياً (05…) والمخزَّن دولياً (+9665…): الأرقام بلا أصفار البداية
    const digits = p.q.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length >= 4 && digits !== p.q) or.push({ phone: { contains: digits } });
    and.push({ OR: or });
  }
  return and.length ? { AND: and } : {};
}

export interface SalesRow {
  id: string; channel: string; name: string | null; company: string | null; phone: string | null; email: string | null;
  country: string | null; message: string | null; origin: string | null; tenantId: string | null; stage: string;
  note: string | null; firstAt: string; lastAt: string;
}

export function toSalesRow(r: {
  id: string; channel: string; name: string | null; company: string | null; phone: string | null; email: string | null;
  country: string | null; message: string | null; origin: string | null; tenantId: string | null; stage: string;
  note: string | null; firstAt: Date; lastAt: Date;
}): SalesRow {
  return {
    id: r.id, channel: r.channel, name: r.name ?? null, company: r.company ?? null, phone: r.phone ?? null,
    email: r.email ?? null, country: r.country ?? null, message: r.message ?? null, origin: r.origin ?? null,
    tenantId: r.tenantId ?? null, stage: r.stage, note: r.note ?? null,
    firstAt: new Date(r.firstAt).toISOString(), lastAt: new Date(r.lastAt).toISOString(),
  };
}

/** الصفوف بالأحدث تواصلاً، والعدّادات على كل ما يراه الطالب لا على الصفحة المرشَّحة وحدها */
export async function listSalesInbox(p: SalesListParams, includeWhatsapp: boolean, db: Db = prisma): Promise<{
  rows: SalesRow[]; total: number; counts: { byChannel: Record<string, number>; byStage: Record<string, number> };
}> {
  const where = buildSalesWhere(p, includeWhatsapp);
  const scope = buildSalesWhere({}, includeWhatsapp);
  const [rows, total, byChannel, byStage] = await Promise.all([
    db.salesContact.findMany({ where, orderBy: [{ lastAt: 'desc' }, { createdAt: 'desc' }], take: p.limit }),
    db.salesContact.count({ where }),
    db.salesContact.groupBy({ by: ['channel'], where: scope, _count: { _all: true } }),
    db.salesContact.groupBy({ by: ['stage'], where: scope, _count: { _all: true } }),
  ]);
  const channels: Record<string, number> = Object.fromEntries(SALES_CHANNELS.map((c) => [c, 0]));
  for (const g of byChannel) channels[g.channel] = g._count._all;
  const stages: Record<string, number> = Object.fromEntries(SALES_STAGES.map((s) => [s, 0]));
  for (const g of byStage) stages[g.stage] = g._count._all;
  return { rows: rows.map(toSalesRow), total, counts: { byChannel: channels, byStage: stages } };
}

/** تعديل المرحلة والملاحظة وحدهما — الملاحظة الفارغة تُمسح (null) */
export const salesUpdateSchema = z.object({
  stage: z.enum(SALES_STAGES).optional(),
  note: z.string().max(2000).nullable().optional()
    .transform((v) => (v === undefined ? undefined : (v ?? '').trim() || null)),
});
export type SalesUpdate = z.infer<typeof salesUpdateSchema>;

/** null = غير موجود لهذا الطالب (صفّ واتساب لمن لا يملك محادثات البوت كأنه غير موجود ⇒ ٤٠٤) */
export async function updateSalesContact(id: string, body: SalesUpdate, includeWhatsapp: boolean, db: Db = prisma): Promise<SalesRow | null> {
  const cur = await db.salesContact.findUnique({ where: { id } });
  if (!cur || (!includeWhatsapp && cur.channel === 'WHATSAPP')) return null;
  const data: { stage?: string; note?: string | null } = {};
  if (body.stage !== undefined) data.stage = body.stage;
  if (body.note !== undefined) data.note = body.note;
  if (!Object.keys(data).length) return toSalesRow(cur);
  return toSalesRow(await db.salesContact.update({ where: { id }, data }));
}
