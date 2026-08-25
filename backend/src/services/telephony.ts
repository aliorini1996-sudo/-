import crypto from 'crypto';
import prisma from '../config/database';
import { toE164 } from '../lib/phone';

/**
 * طبقة الاتصالات (أرقام العمل) — تجريد بمزوّدين كي لا تُعاد كتابة المنصّة إن
 * تغيّر المزوّد أو أُضيف ثانٍ:
 *   manual: بلا مزوّد إطلاقاً — الشركة تُدخل أرقامها يدوياً (M0، صفر كلفة).
 *   hatif:  محوّل هاتف (api.voxa.sa) — OAuth2 client_credentials بمفاتيح كل شركة.
 *
 * قيود عقد هاتف الحاكمة (من docs.hatif.io — 57 مساراً مقروءاً):
 * - الرقم يعيش على «القناة» لا المستخدم ⇒ خريطة قناة↔مندوب عندنا لا عندهم.
 * - 120 طلب/دقيقة لكامل مساحة العمل ⇒ ويبهوك لا استقصاء، والمزامنة يدوية/نادرة.
 * - لا توقيع HMAC موثّقاً للويبهوك ⇒ سرّ عشوائي في المسار يُقارن بأمان زمني.
 */

// ═══ محوّل هاتف ═══

interface HatifConfig { baseUrl: string; clientId: string; clientSecret: string }

const TIMEOUT_MS = 30_000;

// كاش التوكن لكل مستأجر — يُجدَّد قبل الانتهاء بدقيقة (التوثيق يحذّر من طلبه من المتصفح؛ لا يغادر الخادم)
const tokenCache = new Map<string, { token: string; exp: number }>();

async function hatifToken(tenantId: string, cfg: HatifConfig): Promise<string> {
  const hit = tokenCache.get(tenantId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: 'VoxaAPI',
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`token: HTTP ${res.status}`);
    const body = await res.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('token: لا access_token في الاستجابة');
    tokenCache.set(tenantId, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  } finally { clearTimeout(timer); }
}

async function hatifGet(tenantId: string, cfg: HatifConfig, path: string): Promise<unknown> {
  const token = await hatifToken(tenantId, cfg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error(`429: تجاوز حدّ 120 طلب/دقيقة — أعد المحاولة لاحقاً`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

export interface ProviderChannel { id: string; e164: string | null; label?: string; kind: string }

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}
const str = (v: unknown) => (v === undefined ? undefined : String(v));

/** يقرأ قنوات مساحة العمل بأشكال استجابة متسامحة (الصيغة الدقيقة تُثبَّت مع أول حساب حقيقي) */
export function parseChannels(body: unknown): ProviderChannel[] {
  let arr: Record<string, unknown>[] = [];
  if (Array.isArray(body)) arr = body as Record<string, unknown>[];
  else if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const k of ['data', 'channels', 'items', 'result']) {
      if (Array.isArray(o[k])) { arr = o[k] as Record<string, unknown>[]; break; }
    }
  }
  return arr.map((c) => {
    const rawNum = str(pick(c, ['phoneNumber', 'phone_number', 'number', 'e164', 'msisdn', 'identifier']));
    const kindRaw = (str(pick(c, ['type', 'kind', 'channelType'])) || '').toLowerCase();
    return {
      id: str(pick(c, ['id', 'channelId', 'uuid'])) || '',
      e164: toE164(rawNum ?? null),
      label: str(pick(c, ['name', 'label', 'title'])),
      kind: kindRaw.includes('whatsapp') ? 'whatsapp' : kindRaw.includes('voice') || kindRaw.includes('phone') ? 'voice' : 'both',
    };
  }).filter((c) => c.id);
}

export async function testHatifConnection(tenantId: string, cfg: HatifConfig): Promise<{ ok: boolean; message: string; count?: number }> {
  try {
    const body = await hatifGet(tenantId, cfg, '/v1/channels/service-account');
    const channels = parseChannels(body);
    return { ok: true, message: `الاتصال ناجح — ${channels.length} قناة في مساحة العمل`, count: channels.length };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ═══ مزامنة القنوات من المزوّد إلى مخزون الأرقام ═══

export async function syncChannels(tenantId: string): Promise<{ ok: boolean; count: number; error?: string }> {
  const integ = await prisma.telephonyIntegration.findUnique({ where: { tenantId } });
  if (!integ || integ.provider !== 'hatif' || !integ.clientId || !integ.clientSecret) {
    return { ok: false, count: 0, error: 'المزوّد يدويّ أو المفاتيح ناقصة' };
  }
  try {
    const body = await hatifGet(tenantId, { baseUrl: integ.baseUrl, clientId: integ.clientId, clientSecret: integ.clientSecret }, '/v1/channels/service-account');
    const channels = parseChannels(body);
    let count = 0;
    for (const ch of channels) {
      if (!ch.e164) continue; // قناة بلا رقم مفهوم (واتساب فقط بلا msisdn مثلاً) — تُتخطى بلا كسر
      await prisma.workChannel.upsert({
        where: { tenantId_e164: { tenantId, e164: ch.e164 } },
        create: { tenantId, e164: ch.e164, label: ch.label, provider: 'hatif', providerChannelId: ch.id, kind: ch.kind },
        update: { label: ch.label ?? undefined, provider: 'hatif', providerChannelId: ch.id, kind: ch.kind },
      });
      count++;
    }
    await prisma.telephonyIntegration.update({ where: { tenantId }, data: { status: 'OK', lastSyncAt: new Date(), lastError: null } });
    return { ok: true, count };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await prisma.telephonyIntegration.update({ where: { tenantId }, data: { status: 'ERROR', lastError: msg.slice(0, 900) } });
    return { ok: false, count: 0, error: msg };
  }
}

// ═══ ويبهوك ما بعد المكالمة ═══

export interface ParsedCallEvent {
  providerCallId: string;
  direction: 'IN' | 'OUT' | 'MISSED';
  fromE164: string;
  toE164: string;
  startedAt: Date;
  durationSec: number;
  recordingUrl?: string;
  transcript?: string;
  aiSummary?: string;
  channelProviderId?: string;
  channelE164?: string | null;
}

/**
 * يقرأ حمولة «ما بعد المكالمة» بأسماء حقول مرشّحة — الصيغة الدقيقة غير منشورة
 * علنياً فتُثبَّت مع أول ويبهوك حقيقي، والقارئ المتسامح يمنع كسر الإنتاج حتى ذلك.
 */
export function parseCallWebhook(body: Record<string, unknown>): ParsedCallEvent | null {
  const call = (body.call && typeof body.call === 'object' ? body.call : body) as Record<string, unknown>;
  const id = str(pick(call, ['id', 'callId', 'call_id', 'uuid', 'sid']));
  if (!id) return null;
  const dirRaw = (str(pick(call, ['direction', 'type'])) || '').toLowerCase();
  const answered = pick(call, ['answered', 'isAnswered']) !== false;
  const direction: ParsedCallEvent['direction'] =
    dirRaw.includes('out') ? 'OUT' : (!answered || dirRaw.includes('miss')) ? 'MISSED' : 'IN';
  const from = toE164(str(pick(call, ['from', 'caller', 'callerNumber', 'from_number', 'src'])) ?? null);
  const to = toE164(str(pick(call, ['to', 'callee', 'calleeNumber', 'to_number', 'dst'])) ?? null);
  const started = str(pick(call, ['startedAt', 'started_at', 'startTime', 'timestamp', 'date']));
  const startedAt = started ? new Date(started) : new Date();
  const durRaw = pick(call, ['duration', 'durationSec', 'duration_seconds', 'billsec']);
  const durationSec = Number.isFinite(Number(durRaw)) ? Math.max(0, Math.round(Number(durRaw))) : 0;
  const channel = (call.channel && typeof call.channel === 'object' ? call.channel : {}) as Record<string, unknown>;
  return {
    providerCallId: id,
    direction,
    fromE164: from ?? '',
    toE164: to ?? '',
    startedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
    durationSec,
    recordingUrl: str(pick(call, ['recordingUrl', 'recording_url', 'recording'])),
    transcript: str(pick(call, ['transcript', 'transcription'])),
    aiSummary: str(pick(call, ['aiSummary', 'summary', 'ai_summary'])),
    channelProviderId: str(pick(call, ['channelId', 'channel_id'])) ?? str(pick(channel, ['id'])),
    channelE164: toE164((str(pick(channel, ['phoneNumber', 'number'])) ?? str(pick(call, ['channelNumber', 'line']))) ?? null),
  };
}

/**
 * يقيّد المكالمة: مطابقة القناة ← لقطة المندوب وقت الحدث، ومطابقة الطرف الآخر ← عميل.
 * الإدخال متسامح مع التكرار (القيد الفريد يبتلع إعادة إرسال الويبهوك).
 */
export async function recordCallEvent(tenantId: string, ev: ParsedCallEvent): Promise<'created' | 'duplicate'> {
  // القناة: بمعرّف المزوّد أولاً ثم بالرقم
  const channel = await prisma.workChannel.findFirst({
    where: {
      tenantId,
      OR: [
        ...(ev.channelProviderId ? [{ providerChannelId: ev.channelProviderId }] : []),
        ...(ev.channelE164 ? [{ e164: ev.channelE164 }] : []),
        // احتياط: أحد طرفَي المكالمة هو رقم القناة نفسه
        { e164: ev.direction === 'OUT' ? ev.fromE164 : ev.toE164 },
      ],
    },
  });
  // الطرف الآخر (العميل المحتمل)
  const peer = ev.direction === 'OUT' ? ev.toE164 : ev.fromE164;
  let customerId: string | null = null;
  if (peer) {
    const digits = peer.replace('+', '');
    const local = digits.startsWith('966') ? '0' + digits.slice(3) : null;
    const customer = await prisma.customer.findFirst({
      where: { tenantId, OR: [{ phone: peer }, { phone: digits }, ...(local ? [{ phone: local }] : [])] },
      select: { id: true },
    });
    customerId = customer?.id ?? null;
  }
  try {
    await prisma.callLog.create({
      data: {
        tenantId,
        workChannelId: channel?.id ?? null,
        salesRepId: channel?.assignedRepId ?? null, // لقطة — لا تتغيّر بإعادة الإسناد لاحقاً
        customerId,
        direction: ev.direction,
        fromE164: ev.fromE164,
        toE164: ev.toE164,
        startedAt: ev.startedAt,
        durationSec: ev.durationSec,
        recordingUrl: ev.recordingUrl,
        transcript: ev.transcript,
        aiSummary: ev.aiSummary,
        providerCallId: ev.providerCallId,
      },
    });
    return 'created';
  } catch (e) {
    // P2002 = القيد الفريد (tenantId, providerCallId) — إعادة إرسال ويبهوك، ليست خطأ
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') return 'duplicate';
    throw e;
  }
}

/** مقارنة سرّ الويبهوك بأمان زمني — 404 عند الفشل (لا نكشف وجود المسار) */
export function webhookSecretMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
