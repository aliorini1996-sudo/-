/**
 * أساس برنامج «سفير فيلد سيلز»: الإعدادات والشروط والسجلّ والتشفير.
 *
 * العقد الحاكم: docs/affiliate/CONTRACT.md — والأشكال الدقيقة: docs/affiliate/API.md.
 *
 * لا بذرة في القاعدة: غياب صفّ الإعدادات يعني القيم الافتراضية، وغياب إصدار
 * الشروط الحالي يعني النصّ المدمج أدناه. فالبرنامج يعمل من أوّل نشرٍ دون أن
 * يكتب أحدٌ في القاعدة يدوياً.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import prisma from '../../config/database';

type Db = Prisma.TransactionClient | typeof prisma;

// ───────────────────────────── الإعدادات ─────────────────────────────

export interface AffiliateSettingsValue {
  intakeOpen: boolean;
  rateBps: number;
  holdDays: number;
  minPayoutHalalas: number;
  refWindowDays: number;
  claimLockDays: number;
  firstPaymentWithinDays: number;
  currentTermsVersion: string;
  disclosureText: string;
}

export const DEFAULT_TERMS_VERSION = '2026-09-v1';

export const DEFAULT_SETTINGS: AffiliateSettingsValue = {
  intakeOpen: true,
  rateBps: 3000,
  holdDays: 30,
  minPayoutHalalas: 10000,
  refWindowDays: 90,
  claimLockDays: 90,
  firstPaymentWithinDays: 180,
  currentTermsVersion: DEFAULT_TERMS_VERSION,
  disclosureText: 'أحصل على عمولة من فيلد سيلز إذا اشتركت عبر رابطي',
};

export async function getSettings(db: Db = prisma): Promise<AffiliateSettingsValue> {
  const row = await db.affiliateSettings.findUnique({ where: { id: 'global' } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    intakeOpen: row.intakeOpen,
    rateBps: row.rateBps,
    holdDays: row.holdDays,
    minPayoutHalalas: row.minPayoutHalalas,
    refWindowDays: row.refWindowDays,
    claimLockDays: row.claimLockDays,
    firstPaymentWithinDays: row.firstPaymentWithinDays,
    currentTermsVersion: row.currentTermsVersion,
    disclosureText: row.disclosureText,
  };
}

// ───────────────────────────── الشروط ─────────────────────────────

/**
 * نصّ الإصدار الأوّل — يطابق قرارات المالك في CONTRACT §0. أيّ تعديلٍ عليه يُنشر
 * إصداراً جديداً من لوحة المالك (لا تعديلاً هنا)، فالسفير الذي قبل نصّاً يبقى
 * نصّه محفوظاً بإصداره.
 */
export const DEFAULT_TERMS_BODY = `شروط برنامج «سفير فيلد سيلز» — الإصدار ${DEFAULT_TERMS_VERSION}

١. الطرفان
فيلد سيلز (منشأة سعودية بسجل تجاري) تدير البرنامج. والسفير فردٌ مستقلّ يسوّق للمنصّة، وليس موظفاً ولا وكيلاً عنها، ولا يحقّ له التعاقد أو الوعد باسمها.

٢. العمولة
- ٣٠٪ من أوّل دفعة مؤكَّدة تدفعها الشركة المُحالة للاشتراك، محسوبةً على المبلغ المدفوع شاملاً ضريبة القيمة المضافة، ولو غطّت الدفعة سنةً مقدّماً.
- عمولةٌ واحدة لكلّ شركة، ولا عمولة على التجديدات أو الدفعات اللاحقة.
- تُحتسب الدفعة إن تمّت خلال ١٨٠ يوماً من تاريخ إسناد الشركة إليك.
- لا عمولة على شركةٍ كانت عميلاً لفيلد سيلز قبل إحالتك.

٣. الإسناد
- رابطك الخاص يُحفظ في متصفّح الزائر ٩٠ يوماً، وآخر رابطٍ فتحه الزائر هو المعتمد.
- يمكن للشركة إدخال رمزك يدوياً عند التسجيل.
- ترشيح شركةٍ بسجلّها التجاري يُراجع، وإن قُبل حُجزت لك ٩٠ يوماً، والأسبق بترشيحٍ مقبول له الأولوية.
- التسجيل ببريدك أو جوالك، أو إحالة منشأةٍ تملكها أو تديرها، إحالةٌ ذاتية لا تستحقّ عمولة.
- لفيلد سيلز القرار النهائي في الإسناد المتنازع عليه.

٤. الاستحقاق والصرف
- تبقى العمولة معلّقة ٣٠ يوماً من تاريخ الدفع، ثم تُعتمد إن بقيت الدفعة قائمة.
- الاسترداد الكامل قبل الصرف يلغي العمولة، والجزئي يخفّضها بقدره، وما يُستردّ بعد الصرف أو بعد تجهيز دفعتك يُخصم من مستحقّاتك القادمة.
- الصرف تحويلٌ بنكي يدوي إلى آيبان سعودي باسمك، متى بلغ رصيدك المعتمد ١٠٠ ريال على الأقل.
- أنت مسؤولٌ عن التزاماتك الضريبية والنظامية المتعلّقة بدخلك من البرنامج.

٥. قواعد التسويق
- يُسمح بالنشر العلني، بشرط أن تحمل ترخيص «موثوق» ساري المفعول، وأن تُظهر وسم «إعلان» بوضوح في كلّ منشور.
- أفصح دائماً أنّك تحصل على عمولة.
- لا رسائل جماعية ولا تواصل بارد مزعج ولا شراء قوائم أرقام، ولا انتحال صفة فيلد سيلز، ولا إعلانات مدفوعة على اسم العلامة.
- لا وعود بمزايا أو أسعار أو خصومات غير منشورة على الموقع الرسمي.
- لا تُرسل لنا بيانات أشخاص. الترشيح اسم منشأة وسجلّها التجاري ومدينتها فقط.

٦. البيانات
نحفظ بياناتك لإدارة حسابك وصرف مستحقّاتك. والآيبان يُخزَّن مشفّراً. ولا ترى من الشركات المُحالة إلا اسمها وحالة اشتراكها.

٧. الإيقاف والتعديل
لفيلد سيلز إيقاف الحساب أو رفض العمولة عند مخالفة هذه الشروط أو الاشتباه بالتحايل، مع ذكر السبب. وتعديل الشروط يُنشر إصداراً جديداً يلزم قبوله لمواصلة المشاركة، ولا يمسّ عمولةً نشأت قبله.`;

export async function getTerms(version: string, db: Db = prisma): Promise<{ version: string; body: string } | null> {
  const row = await db.affiliateTerms.findUnique({ where: { version } });
  if (row) return { version: row.version, body: row.body };
  if (version === DEFAULT_TERMS_VERSION) return { version, body: DEFAULT_TERMS_BODY };
  return null;
}

/**
 * القيم الماليّة التي **تنصّ عليها الشروط** — لا تتغيّر إلا بنشر إصدارٍ جديد
 * (الشروط §٧: التعديل يُنشر إصداراً يلزم قبوله). تعديلها من الإعدادات مباشرةً
 * كان سيطبّق ٢٠٪ على سفيرٍ قبِل نصّاً يقول ٣٠٪.
 */
export const TERMS_RULE_KEYS = ['rateBps', 'holdDays', 'minPayoutHalalas', 'refWindowDays', 'claimLockDays', 'firstPaymentWithinDays'] as const;
export type TermsRuleKey = typeof TERMS_RULE_KEYS[number];
export type TermsRules = Record<TermsRuleKey, number>;

export const TERMS_RULE_RANGES: Record<TermsRuleKey, [number, number]> = {
  rateBps: [0, 10000],
  holdDays: [0, 365],
  minPayoutHalalas: [0, 100_000_000],
  refWindowDays: [1, 365],
  claimLockDays: [1, 365],
  firstPaymentWithinDays: [1, 730],
};

/** قراءة قواعد مخزَّنة بتسامح: قيمةٌ ناقصة أو خارج مداها تعود للاحتياط */
export function parseTermsRules(json: unknown, fallback: TermsRules): TermsRules {
  const src = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const out = { ...fallback };
  for (const k of TERMS_RULE_KEYS) {
    const v = src[k];
    const [lo, hi] = TERMS_RULE_RANGES[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi) out[k] = v;
  }
  return out;
}

export function pickRules(s: AffiliateSettingsValue): TermsRules {
  return Object.fromEntries(TERMS_RULE_KEYS.map(k => [k, s[k]])) as TermsRules;
}

/** قواعد الإصدار الذي قبله السفير — بها يُسند إليه ويُحتسب له */
export async function rulesFor(termsVersion: string, db: Db = prisma): Promise<TermsRules> {
  const row = await db.affiliateTerms.findUnique({ where: { version: termsVersion }, select: { rulesJson: true } });
  if (row) return parseTermsRules(row.rulesJson, pickRules(DEFAULT_SETTINGS));
  if (termsVersion === DEFAULT_TERMS_VERSION) return pickRules(DEFAULT_SETTINGS);
  return pickRules(await getSettings(db));
}

// ───────────────────────────── السجلّ ─────────────────────────────

export interface EventInput {
  entity: 'user' | 'claim' | 'attribution' | 'commission' | 'payout' | 'adjustment' | 'settings' | 'terms' | 'mail' | 'payment';
  entityId: string;
  action: string;
  fromState?: string | null;
  toState?: string | null;
  actorType: 'system' | 'affiliate' | 'owner' | 'company';
  actorId?: string | null;
  reason?: string | null;
  meta?: Prisma.InputJsonValue;
}

export async function logEvent(db: Db, e: EventInput): Promise<void> {
  await db.affiliateEvent.create({
    data: {
      entity: e.entity, entityId: e.entityId, action: e.action,
      fromState: e.fromState ?? null, toState: e.toState ?? null,
      actorType: e.actorType, actorId: e.actorId ?? null, reason: e.reason ?? null,
      ...(e.meta !== undefined ? { meta: e.meta } : {}),
    },
  });
}

/** السجلّ لا يُسقط العملية التي يوثّقها */
export function logEventSafe(e: EventInput): void {
  logEvent(prisma, e).catch(err => console.error('[affiliate] event log failed:', (err as Error).message));
}

// ───────────────────────────── المصادقة ─────────────────────────────

/** سرّ مشتقّ — توكن لوحة الشركة لا يُفكّ هنا، وتوكن السفير لا يُفكّ هناك */
export function affiliateSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET غير مضبوط');
  return process.env.AFFILIATE_JWT_SECRET || `${base}::affiliate`;
}

export interface AffiliateSession { uid: string; kind: 'affiliate'; tv: number }
type Purpose = 'ax-verify' | 'ax-reset';

export function signSession(uid: string, tokenVersion: number): string {
  return jwt.sign({ uid, kind: 'affiliate', tv: tokenVersion }, affiliateSecret(), { expiresIn: '7d' });
}

export function verifySession(token: string): AffiliateSession | null {
  try {
    const p = jwt.verify(token, affiliateSecret()) as Partial<AffiliateSession> & { purpose?: string };
    if (p.kind !== 'affiliate' || typeof p.uid !== 'string' || typeof p.tv !== 'number' || p.purpose) return null;
    return { uid: p.uid, kind: 'affiliate', tv: p.tv };
  } catch { return null; }
}

/** رموز الغرض الواحد (تأكيد البريد/الاستعادة) — لا تصلح جلسةً ولا العكس */
export function signPurpose(purpose: Purpose, uid: string, tokenVersion: number, expiresIn: string): string {
  return jwt.sign({ uid, purpose, tv: tokenVersion }, affiliateSecret(), { expiresIn } as jwt.SignOptions);
}

export function verifyPurpose(purpose: Purpose, token: string): { uid: string; tv: number } | null {
  try {
    const p = jwt.verify(token, affiliateSecret()) as { uid?: string; purpose?: string; tv?: number; kind?: string };
    if (p.purpose !== purpose || typeof p.uid !== 'string' || typeof p.tv !== 'number' || p.kind) return null;
    return { uid: p.uid, tv: p.tv };
  } catch { return null; }
}

/** scrypt: `salt:hash` — النمط نفسه في منصّة الصيد */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

/** يستهلك الزمن نفسه وإن لم يوجد الحساب — لا قناة زمنية لتعداد البُرُد */
export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const [salt, hash] = String(stored || DUMMY_HASH).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  const ok = candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  return ok && !!stored;
}

export function ipHash(ip: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'fieldsa-visits')).digest('hex').slice(0, 16);
}

// ───────────────────────────── تشفير الآيبان ─────────────────────────────

function ibanKey(): Buffer {
  const raw = process.env.AFFILIATE_IBAN_KEY;
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (k.length === 32) return k;
  }
  return crypto.createHash('sha256').update(`${affiliateSecret()}::iban`).digest();
}

/** AES-256-GCM: `iv:tag:cipher` بـhex */
export function encryptIban(iban: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ibanKey(), iv);
  const enc = Buffer.concat([c.update(iban, 'utf8'), c.final()]);
  return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptIban(stored: string): string | null {
  try {
    const [iv, tag, enc] = stored.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', ibanKey(), Buffer.from(iv, 'hex'));
    d.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ───────────────────────────── مساعدات ─────────────────────────────

export function frontendBase(): string {
  return (process.env.FRONTEND_URL || 'https://fieldsa.net').split(',')[0].trim().replace(/\/$/, '');
}

export function referralLink(code: string): string {
  return `${frontendBase()}/?ref=${code}`;
}

/** اليوم بتوقيت الرياض (+٣ بلا توقيت صيفي) */
export function riyadhDay(d: Date = new Date()): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

export function isUniqueViolation(e: unknown, field?: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!field) return true;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.includes(field) : String(target ?? '').includes(field);
}

export const DAY_MS = 24 * 3600_000;
