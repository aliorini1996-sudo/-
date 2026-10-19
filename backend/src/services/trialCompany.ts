/**
 * الشركة التجريبية — مصدرٌ واحد لطريقَي إنشائها، فمدّة التجربة وحدودها وعملة الدولة لا تفترق:
 *  - «سجّل بنفسك» (`POST /api/auth/signup`): المسؤول يختار كلمة مروره في النموذج ويدخل فوراً.
 *  - «فتحها سفير» (services/affiliate/portalTrial.ts): المسؤول **بلا كلمة مرور** حتى يختارها بنفسه
 *    من رابط تفعيلٍ يصل بريده وحده. السفير لا يرى كلمة مرورٍ ولا رابطاً ولا جلسةً ولا هوية واتساب.
 *
 * مكانها خدمات الشركة لا دفتر السفراء: الدفتر لا يقرأ الباقة ولا تاريخ الانتهاء ولا حالة النشاط
 * (حارس affiliate.test.ts — درس «MRR 1197»)، وهذا الملف يكتبها كلّها.
 *
 * **حالة التفعيل بلا عمودٍ جديد** (لا db push): `passwordHash` يحمل حارساً يبدأ بـ
 * `PENDING_ACTIVATION_PREFIX` وطوله ٦٨ لا ٦٠، فـbcryptjs 2.4.3 يُعيد false بلا رمي — الدخول وتغيير
 * كلمة المرور يفشلان فشلاً عامّاً كأيّ كلمة مرورٍ خاطئة. والاستعمال الواحد مقارنةٌ‑وتبديل على الحارس
 * نفسه، وإعادة الإرسال تدوّره فيسقط كلّ رابطٍ أقدم (بصمته في الرمز لم تعد تطابق).
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { getCountryTax, CountryTax } from '../config/countries';
import { sendMail, mailLayout } from './mailer';
import { escapeHtml, frontendBase, logEvent } from './affiliate/core';
import { mailTrialActivated } from './affiliate/mail';
import { phoneKey } from './phoneKey';
import { normAffiliatePhone } from './affiliate/rules';

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;
const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────── الإنشاء ─────────────────────────────

export const TRIAL_PERIOD_DAYS = 10;
export const TRIAL_LIMITS = { maxSalesReps: 5, maxAdminUsers: 1 } as const;

/**
 * الشركة ومديرها وإعداداتها داخل معاملة المُستدعي — هو يقرّر ما يُكتب معها في المعاملة نفسها
 * (التسجيل الذاتيّ: لا شيء، والإسناد بعد الالتزام؛ البوابة: الإسناد في المعاملة نفسها).
 */
export async function createTrialCompanyTx(tx: Tx, i: {
  companyName: string; adminName: string; email: string; phone: string;
  countryCode?: string | null; passwordHash: string; now?: Date;
}) {
  const now = i.now ?? new Date();
  const trialEndsAt = new Date(now.getTime() + TRIAL_PERIOD_DAYS * DAY_MS);
  // إعدادات دولة الشركة (العملة/الضريبة/مزوّد الفوترة) — تُشتقّ من رمز الدولة (افتراضي السعودية)
  const ct = getCountryTax(i.countryCode);
  const tenant = await tx.tenant.create({
    data: {
      name: i.companyName,
      plan: 'trial',
      subscriptionEndsAt: trialEndsAt,
      ...TRIAL_LIMITS,
    } as any,
  });
  const admin = await tx.admin.create({
    data: { tenantId: tenant.id, name: i.adminName, email: i.email, passwordHash: i.passwordHash, role: 'ADMIN' } as any,
  });
  await tx.companySettings.create({ data: {
    tenantId: tenant.id, name: i.companyName, phone: i.phone,
    countryCode: ct.code, currency: ct.currency, defaultVatPct: ct.defaultVatPct, einvoiceProvider: ct.provider,
  } as any });
  return { tenant, admin, trialEndsAt, ct };
}

/**
 * ترحيب واتساب — لا يُرسل إلا لجوالٍ أعطانا إيّاه صاحبه: من سجّل بنفسه، أو شركةٌ فعّلت حساباً فتحه
 * سفير وأكّدت رقمها في صفحة التفعيل. رقمٌ كتبه طرفٌ ثالث لا يُراسَل (الشروط §٥: لا تواصل بارد).
 * لا يرمي ولا يُنتظر: فشل الترحيب لا يجوز أن يمنع عميلاً من الدخول.
 */
export function sendWaWelcome(i: { phone: string; adminName: string; companyName: string; trialEndsAt: Date }): void {
  void (async () => {
    const url = (process.env.WA_BOT_URL || '').trim().replace(/\/$/, '');
    const key = (process.env.WA_SWEEP_TOKEN || '').trim();
    if (!url || !key) return;
    try {
      const r = await fetch(`${url}/outreach/welcome`, {
        method: 'POST',
        headers: { 'x-sweep-token': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: i.phone,
          adminName: i.adminName,
          companyName: i.companyName,
          trialEndsAt: i.trialEndsAt.toISOString().slice(0, 10),
        }),
        signal: AbortSignal.timeout(12000),
      });
      console.log(`[welcome] ${i.companyName} ⇒ ${r.status}`);
    } catch (e) {
      console.error('[welcome] تعذّر:', e);
    }
  })();
}

/**
 * إشعار «عميل تجريبي جديد» إلى البريد الرئيسي للشركة. كلّ قيمةٍ مُهرَّبة: `mailLayout` لا يهرّب،
 * والاسمان قد يكتبهما سفيرٌ لا الشركة.
 */
export async function notifyOwnerNewTrial(i: {
  companyName: string; adminName: string; email: string; phone: string; ct: CountryTax; trialEndsAt: Date;
  title?: string; extraRows?: [string, string][]; note?: string;
}): Promise<boolean> {
  const title = i.title ?? '🎉 عميل تجريبي جديد';
  const rows: [string, string][] = [
    ['الشركة', i.companyName],
    ['المسؤول', i.adminName],
    ['البريد', i.email],
    ['الجوال', i.phone],
    ['الدولة', `${i.ct.code} · ${i.ct.currency} · ${i.ct.defaultVatPct}%`],
    ['الباقة', 'تجريبية مجانية'],
    ['مدة التجربة', `${TRIAL_PERIOD_DAYS} أيام`],
    ['تاريخ التسجيل', new Date().toISOString().slice(0, 10)],
    ['تنتهي التجربة', i.trialEndsAt.toISOString().slice(0, 10)],
    ...(i.extraRows ?? []),
  ];
  const sent = await sendMail({
    to: process.env.MAIL_TO || 'info@fieldsa.net',
    subject: `${title} ${i.companyName}`,
    replyTo: i.email,
    html: mailLayout(escapeHtml(title), rows.map(([k, v]) => [escapeHtml(k), escapeHtml(v)]),
      escapeHtml(i.note ?? 'سجل عميل جديد للتجربة المجانية عبر fieldsa.net ينصح بالتواصل معه لتفعيل أفضل تجربة وتحويله لمشترك')),
  });
  if (!sent) console.error('[mail] فشل إرسال إشعار عميل تجريبي جديد إلى info@fieldsa.net');
  return sent;
}

// ───────────────────────────── حارس «بانتظار التفعيل» ─────────────────────────────

export const PENDING_ACTIVATION_PREFIX = '!pending-activation:';

/** ٢٠ + ٤٨ = ٦٨ محرفاً — ليس ٦٠، فلا يطابقه bcrypt أبداً ولا يرمي */
export function newPendingHash(): string {
  return PENDING_ACTIVATION_PREFIX + crypto.randomBytes(24).toString('hex');
}

export function isPendingActivationHash(h: unknown): boolean {
  return typeof h === 'string' && h.startsWith(PENDING_ACTIVATION_PREFIX);
}

/**
 * حارسٌ «موقوف»: ما زال بانتظار التفعيل (البادئة نفسها — الدخول يفشل، والشركة منتظرة، وإعادة الإرسال
 * تدوّره حارساً عادياً)، لكنّ كلّ رابطٍ قبله يُقرأ «أُوقف» لا «أُرسل أحدث» — فلا بريدٌ أحدث أُرسل.
 */
const LOCKED_ACTIVATION_MARK = `${PENDING_ACTIVATION_PREFIX}locked:`;
export function isLockedActivationHash(h: unknown): boolean {
  return typeof h === 'string' && h.startsWith(LOCKED_ACTIVATION_MARK);
}

/** الشركات التي ما زال مديرها بانتظار التفعيل — سطرٌ واحد لكلّ شركة */
export async function pendingActivationTenantIds(tenantIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(tenantIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const rows = await prisma.admin.findMany({
    where: { tenantId: { in: ids }, role: 'ADMIN', passwordHash: { startsWith: PENDING_ACTIVATION_PREFIX } },
    select: { tenantId: true },
  });
  return new Set(rows.map(r => r.tenantId));
}

/**
 * التجربة تبدأ فعلياً عند التفعيل: الأبعد من نهايتها الحالية ومن «الآن + مدّة التجربة». تاريخٌ
 * مدفوعٌ أو مُمدَّدٌ لا يُقصَّر أبداً، و`null` (غير محدود) يبقى كما هو.
 */
export function trialEndAfterActivation(prev: Date | null, now: Date): Date | null {
  if (!prev) return null;
  return new Date(Math.max(prev.getTime(), now.getTime() + TRIAL_PERIOD_DAYS * DAY_MS));
}

/**
 * يدوّر الحارس — مقارنةٌ‑وتبديل على القيمة القديمة: من طلبين متزامنين يربح واحد، وكلّ رابطٍ سابق
 * يسقط. `notUpdatedSince` مهلةٌ ذرّية على `updatedAt` (الإنشاء والتدوير وحدهما يلمسان صفّ مديرٍ لم
 * يدخل قطّ). يُعيد الحارس الجديد أو null.
 */
export async function rotatePendingHashTx(db: Db, admin: { id: string; passwordHash: string }, opts: { notUpdatedSince?: Date; locked?: boolean } = {}): Promise<string | null> {
  if (!isPendingActivationHash(admin.passwordHash)) return null;
  const fresh = opts.locked ? LOCKED_ACTIVATION_MARK + crypto.randomBytes(24).toString('hex') : newPendingHash();
  const won = await db.admin.updateMany({
    where: {
      id: admin.id, isActive: true, passwordHash: admin.passwordHash,
      ...(opts.notUpdatedSince ? { updatedAt: { lt: opts.notUpdatedSince } } : {}),
    },
    data: { passwordHash: fresh },
  });
  return won.count === 1 ? fresh : null;
}

// ───────────────────────────── رمز التفعيل ─────────────────────────────

export const ACTIVATION_TTL_DAYS = 7;

/**
 * سرٌّ مشتقّ لا يساوي `JWT_SECRET`: وسيط مصادقة اللوحة و`/renew` و`/verify-email` يفكّون بالسرّ الأصليّ
 * وحده، فرمز التفعيل لا يصلح جلسةً هناك أبداً (درس رمز تأكيد البريد الذي يمرّ `authenticate`).
 */
export function activationSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET غير مضبوط');
  const own = process.env.COMPANY_ACTIVATION_SECRET;
  return own && own !== base ? own : `${base}::company-activate`;
}

/** بصمة الحارس داخل الرمز — تدويره يُسقط الرابط القديم بلا تخزينٍ إضافي */
export function activationFingerprint(hash: string): string {
  return crypto.createHash('sha256').update(hash).digest('hex').slice(0, 32);
}

/** حمولةٌ بلا id ولا role ولا tenantId ولا kind — لا تُقرأ جلسةً في أيّ فضاء */
export function signActivationToken(adminId: string, pendingHash: string): string {
  return jwt.sign(
    { aid: adminId, purpose: 'company-activate', fp: activationFingerprint(pendingHash) },
    activationSecret(),
    { expiresIn: `${ACTIVATION_TTL_DAYS}d` } as jwt.SignOptions,
  );
}

const SESSION_KEYS = ['id', 'role', 'tenantId', 'kind', 'uid'];

export function verifyActivationToken(token: string): { aid: string; fp: string } | null {
  try {
    const p = jwt.verify(token, activationSecret()) as Record<string, unknown>;
    if (!p || typeof p !== 'object') return null;
    if (p.purpose !== 'company-activate' || typeof p.aid !== 'string' || typeof p.fp !== 'string') return null;
    if (SESSION_KEYS.some(k => k in p)) return null;
    return { aid: p.aid, fp: p.fp };
  } catch { return null; }
}

/** الرمز في **المقطع** (#) لا الاستعلام: لا يصل الخادم ولا سجلّات Render ولا ترويسة Referer */
export function activationUrl(token: string): string {
  return `${frontendBase()}/activate#t=${encodeURIComponent(token)}`;
}

/**
 * بريد التفعيل — يصل عنواناً **كتبه السفير ولم تُثبت ملكيّته** بعد، فنصّه ثابتٌ كلّه: لا اسم منشأة ولا
 * اسم مسؤول ولا شيء كتبه أحد (قاعدة mail.ts لبريد التأكيد). وبهوية FieldSales لا «سفير»: المرسل إليه
 * عميلٌ لا سفير.
 */
export function mailCompanyActivation(to: string, token: string): void {
  try {
    const url = escapeHtml(activationUrl(token));
    const para = (s: string) => `<p style="margin:0 0 12px">${s}</p>`;
    const html = `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">FieldSales — تفعيل حساب شركتك</div>
      <div style="padding:22px;color:#3a342b;font-size:15px;line-height:1.8">
        ${para('مرحباً،')}
        ${para('فُتح لمنشأتكم حسابٌ تجريبي على منصّة FieldSales بطلبكم، عن طريق أحد سفراء FieldSales.')}
        ${para('اختر كلمة مرورك بنفسك من الزرّ أدناه. السفير لا يعرفها، ولا يستطيع الدخول إلى حسابكم.')}
        ${para('الرابط صالح ٧ أيام ويعمل مرّةً واحدة.')}
        ${para('إن لم تطلبوا ذلك فتجاهلوا هذه الرسالة، ولن يُفعَّل شيء.')}
        <div style="text-align:center;margin:22px 0">
          <a href="${url}" style="background:#E15A30;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:12px;display:inline-block">تفعيل الحساب</a>
        </div>
        <p style="margin:0 0 12px;color:#6E6557;font-size:12px;word-break:break-all">${url}</p>
        <p dir="ltr" style="margin:12px 0 0;color:#6E6557;font-size:13px;line-height:1.6;text-align:left">A FieldSales trial account was opened for your business at your request through a FieldSales ambassador. Choose your own password with the button above: the ambassador does not know it and cannot sign in to your account. The link is valid for 7 days and works once. If you did not ask for this, ignore this email and nothing will be activated.</p>
      </div>
    </div>
  </div>`;
    sendMail({ to, subject: 'فعّل حساب شركتك — FieldSales', html })
      .then(ok => { if (!ok) console.error('[activation] بريد التفعيل لم يُرسل'); })
      .catch(e => console.error('[activation] mail error:', (e as Error).message));
  } catch (e) {
    console.error('[activation] mail error:', (e as Error).message);
  }
}

// ───────────────────────────── المعاينة والتفعيل ─────────────────────────────

function loadActivationAdmin(id: string) {
  return prisma.admin.findUnique({
    where: { id },
    select: {
      id: true, tenantId: true, name: true, email: true, passwordHash: true, isActive: true,
      tenant: { select: { id: true, name: true, isActive: true, subscriptionEndsAt: true, settings: { select: { phone: true, countryCode: true } } } },
    },
  });
}
type ActivationAdmin = NonNullable<Awaited<ReturnType<typeof loadActivationAdmin>>>;

type Inspection =
  | { state: 'invalid' } | { state: 'already_active' } | { state: 'superseded' } | { state: 'locked' }
  | { state: 'ready'; admin: ActivationAdmin };

function sameFingerprint(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** فحصٌ واحد للمعاينة والتفعيل — فلا تقول المعاينة «جاهز» لرابطٍ يرفضه التفعيل */
async function inspectActivation(token: string): Promise<Inspection> {
  const p = verifyActivationToken(token);
  if (!p) return { state: 'invalid' };
  const admin = await loadActivationAdmin(p.aid);
  if (!admin || !admin.isActive || !admin.tenant) return { state: 'invalid' };
  if (!isPendingActivationHash(admin.passwordHash)) return { state: 'already_active' };
  // أوقفه تكرار «الرقم مربوطٌ بحسابٍ آخر» — لا رابطٌ أحدث، فلا يُقال «افتح آخر رسالة»
  if (isLockedActivationHash(admin.passwordHash)) return { state: 'locked' };
  // أُرسل رابطٌ أحدث (إعادة إرسال دوّرت الحارس) — هذا لم يعد يصلح
  if (!sameFingerprint(activationFingerprint(admin.passwordHash), p.fp)) return { state: 'superseded' };
  return { state: 'ready', admin };
}

/** أوّل ٤ أرقام وآخر ٣ — يتعرّف صاحب الرقم عليه ولا يقرؤه غيره كاملاً */
export function maskPhone(phone: string | null | undefined): string | null {
  const d = phoneKey(phone);
  if (d.length < 8) return null;
  return `+${d.slice(0, 4)}${'•'.repeat(d.length - 7)}${d.slice(-3)}`;
}

export type ActivationPreview =
  | { state: 'invalid' } | { state: 'already_active' } | { state: 'superseded' } | { state: 'locked' }
  | {
      state: 'ready'; companyName: string; adminName: string; email: string; phoneMasked: string | null;
      countryCode: string | null; openedBy: string | null; trialDays: number;
    };

export async function activationPreview(token: string): Promise<ActivationPreview> {
  const ins = await inspectActivation(token);
  if (ins.state !== 'ready') return ins;
  const { admin } = ins;
  const attribution = await prisma.tenantAttribution.findUnique({
    where: { tenantId: admin.tenantId }, select: { source: true, affiliate: { select: { fullName: true } } },
  });
  return {
    state: 'ready',
    companyName: admin.tenant.name,
    adminName: admin.name,
    // اسم الدخول نفسه كما خُزِّن — الدخول يطابق البريد حرفياً
    email: admin.email,
    phoneMasked: maskPhone(admin.tenant.settings?.phone),
    countryCode: admin.tenant.settings?.countryCode ?? null,
    openedBy: attribution?.source === 'portal' ? attribution.affiliate.fullName : null,
    trialDays: TRIAL_PERIOD_DAYS,
  };
}

export class ActivationError extends Error {
  constructor(public status: number, message: string, public code: string) { super(message); }
}

const ALREADY_ACTIVE = 'فُعّل هذا الحساب مسبقاً — سجّل الدخول ببريدك وكلمة مرورك';
const SUPERSEDED = 'أُرسل إليك رابطٌ أحدث — افتح آخر رسالة تفعيل وصلتك';

const LINK_LOCKED = 'تكرّر إدخال رقمٍ مربوطٍ بحسابٍ آخر فأُوقف هذا الرابط حمايةً للحساب — اطلب رابطاً جديداً أو تواصل معنا';

/** «الرقم مربوطٌ بحسابٍ آخر» لكلّ رابط — بعدها يُوقف */
export const PHONE_TAKEN_LIMIT = 3;

/**
 * رفضُ «الرقم مربوطٌ بحسابٍ آخر» يكشف لحامل الرابط أنّ الرقم عميلٌ قائم — وحامل الرابط قد يكون السفير
 * نفسه (فتح الحساب ببريدٍ ثانٍ له). فلا يبقى سؤالاً مجانياً: كلّ رفضٍ حدثٌ يراه المالك على الإسناد،
 * وبعد PHONE_TAKEN_LIMIT **لهذا الرابط** (منذ آخر فتحٍ أو إعادة إرسال) يُدوَّر الحارس «موقوفاً» فيسقط
 * الرابط ويُقرأ «أُوقف» — والشركة الحقيقية تطلب غيره فتبدأ عدّاً جديداً. يرمي دائماً.
 */
async function phoneTakenProbe(admin: ActivationAdmin, matchedTenantId: string): Promise<never> {
  const att = await prisma.tenantAttribution.findUnique({ where: { tenantId: admin.tenantId }, select: { id: true } });
  if (att) {
    await logEvent(prisma, {
      entity: 'attribution', entityId: att.id, action: 'activation_phone_taken',
      actorType: 'company', actorId: admin.tenantId, meta: { matchedTenantId },
    });
    const issued = await prisma.affiliateEvent.findFirst({
      where: { entity: 'attribution', entityId: att.id, action: { in: ['created', 'activation_resent'] } },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    const n = await prisma.affiliateEvent.count({
      where: { entity: 'attribution', entityId: att.id, action: 'activation_phone_taken', ...(issued ? { createdAt: { gte: issued.createdAt } } : {}) },
    });
    if (n >= PHONE_TAKEN_LIMIT && await rotatePendingHashTx(prisma, { id: admin.id, passwordHash: admin.passwordHash ?? '' }, { locked: true })) {
      throw new ActivationError(409, LINK_LOCKED, 'link_locked');
    }
  }
  throw new ActivationError(409, 'هذا الرقم مربوط بحساب آخر — أدخل رقماً آخر أو تواصل معنا', 'phone_taken');
}

/**
 * التفعيل: كلمة مرورٍ يختارها صاحب الرابط، وجوالُ الشركة يكتبه كاملاً، ثمّ تبدأ التجربة. يُعيد معرّف
 * المدير، والمسار يُصدر الجلسة كالدخول.
 *
 * الاستعمال الواحد: `updateMany` مشروطٌ بالحارس المقروء — رابطان متزامنان يربح أحدهما ويُرفض الآخر
 * `already_active`. وكلّ ما بعد الالتزام (واتساب، بريد المالك والسفير) لا يُنتظر ولا يرمي.
 */
export async function activateCompany(i: { token: string; password: string; phone: string; ipHash: string | null }): Promise<{ adminId: string }> {
  const now = new Date();
  const ins = await inspectActivation(i.token);
  if (ins.state === 'invalid') throw new ActivationError(400, 'رابط التفعيل غير صالح أو منتهي الصلاحية', 'invalid');
  if (ins.state === 'already_active') throw new ActivationError(409, ALREADY_ACTIVE, 'already_active');
  if (ins.state === 'superseded') throw new ActivationError(409, SUPERSEDED, 'superseded');
  if (ins.state === 'locked') throw new ActivationError(409, LINK_LOCKED, 'link_locked');
  const { admin } = ins;
  // شركةٌ أوقفها المالك لا تُفعَّل — والرابط لا يُستهلك فيعمل إن أُعيدت
  if (!admin.tenant.isActive) throw new ActivationError(403, 'اشتراك الشركة موقوف - تواصل مع مزود الخدمة', 'tenant_inactive');

  // الجوال: كتبه السفير، والشركة **تكتبه كاملاً** هنا — لا «إبقاء» صامت لرقمٍ مُقنَّع: وإلا صار رقمٌ يملكه
  // السفير (أو أخطأ في خاناته المخفيّة) هويةَ واتساب الشركة (ملخّصها وروابط دفعها وإجراءاتها) لأنّ المدير
  // لم يعترض. وبمطبِّع البوابة الصارم نفسه (لا «+966966…» ولا ٨ أرقامٍ أيّاً كانت): رقمٌ تحقّقت منه البوابة
  // لا يُستبدل برقمٍ مكسور يصله الترحيب ويصير هويةً.
  const norm = normAffiliatePhone(typeof i.phone === 'string' ? i.phone : '');
  if (!norm) throw new ActivationError(400, 'رقم الجوال مطلوب ويجب ان يكون صحيحا', 'invalid_phone');
  const cleaned = `+${norm}`;
  const nextKey = phoneKey(cleaned);
  // رقمٌ مربوطٌ بشركةٍ **فعّالة الهوية** يُرفض — **في كلّ تفعيل**، تغيّر الرقم أو أُعيد كما كتبه السفير: فرقمُ
  // المنتظر لا يُعدّ هويةً فقد يأخذه غيره في أثناء الانتظار، وتفعيلٌ يُبقيه يُعيد الغموض فتتوقّف بوابة واتساب
  // للشركتين. والمنتظر تفعيلُه لا يحجب: رقمه لم يؤكّده صاحبه، والبوابة لا تعدّه هوية.
  const others = await prisma.companySettings.findMany({
    where: { tenantId: { not: admin.tenantId }, phone: { not: null } }, select: { tenantId: true, phone: true },
  });
  const hits = others.filter(o => phoneKey(o.phone) === nextKey);
  const pending = await pendingActivationTenantIds(hits.map(h => h.tenantId));
  const hit = hits.find(h => !pending.has(h.tenantId));
  if (hit) await phoneTakenProbe(admin, hit.tenantId);
  const newPhone: string | null = nextKey !== phoneKey(admin.tenant.settings?.phone) ? cleaned : null;

  const newHash = await bcrypt.hash(i.password, 10);
  const prevEnd = admin.tenant.subscriptionEndsAt;
  const nextEnd = trialEndAfterActivation(prevEnd, now);

  const attribution = await prisma.tenantAttribution.findUnique({
    where: { tenantId: admin.tenantId },
    select: { id: true, source: true, status: true, flags: true, tenantNameSnapshot: true, affiliate: { select: { email: true, fullName: true, code: true } } },
  });
  const portal = attribution?.source === 'portal' ? attribution : null;
  // نفس شبكة السفير لحظة الفتح؟ معلومةٌ للمالك فقط — لا توقف الإسناد ولا العمولة (قرار المالك)
  let ipMatch = false;
  if (portal && i.ipHash) {
    const created = await prisma.affiliateEvent.findFirst({
      where: { entity: 'attribution', entityId: portal.id, action: 'created' }, orderBy: { createdAt: 'asc' }, select: { meta: true },
    });
    const stored = (created?.meta as { ipHash?: unknown } | null | undefined)?.ipHash;
    ipMatch = typeof stored === 'string' && stored === i.ipHash;
  }

  try {
    await prisma.$transaction(async tx => {
      const won = await tx.admin.updateMany({
        where: { id: admin.id, passwordHash: admin.passwordHash },
        data: { passwordHash: newHash, emailVerified: true },
      });
      if (won.count !== 1) throw new ActivationError(409, ALREADY_ACTIVE, 'already_active');
      if (newPhone) await tx.companySettings.updateMany({ where: { tenantId: admin.tenantId }, data: { phone: newPhone } });
      // مقارنةٌ‑وتبديل: دفعةٌ متزامنة مدّدت الاشتراك لا يُكتب فوقها
      if (prevEnd && nextEnd && nextEnd.getTime() !== prevEnd.getTime()) {
        await tx.tenant.updateMany({ where: { id: admin.tenantId, subscriptionEndsAt: prevEnd }, data: { subscriptionEndsAt: nextEnd } });
      }
      if (portal) {
        if (ipMatch && !portal.flags.includes('ip_match')) {
          await tx.tenantAttribution.update({ where: { id: portal.id }, data: { flags: { push: 'ip_match' } } });
        }
        await logEvent(tx, {
          entity: 'attribution', entityId: portal.id, action: 'company_activated',
          actorType: 'company', actorId: admin.tenantId, meta: { phoneChanged: !!newPhone, ipMatch },
        });
      }
    });
  } catch (e) {
    // خسر السباق: إمّا فعّله رابطٌ آخر، وإمّا دوّرته إعادة إرسالٍ (أو إيقافٌ) بين الفحص والكتابة — الرسالة تصف ما حدث فعلاً
    if (e instanceof ActivationError && e.code === 'already_active') {
      const now2 = (await inspectActivation(i.token)).state;
      if (now2 === 'superseded') throw new ActivationError(409, SUPERSEDED, 'superseded');
      if (now2 === 'locked') throw new ActivationError(409, LINK_LOCKED, 'link_locked');
      // سحبه السفير بين الفحص والكتابة — لا «فُعّل مسبقاً، سجّل الدخول» لدخولٍ سيفشل
      if (now2 === 'invalid') throw new ActivationError(400, 'رابط التفعيل غير صالح أو منتهي الصلاحية', 'invalid');
    }
    throw e;
  }

  // ─── بعد الالتزام: لا شيء هنا يُسقط التفعيل ───
  const phone = newPhone ?? admin.tenant.settings?.phone ?? null;
  const trialEnd = nextEnd ?? prevEnd;
  // الآن فقط يُراسَل الجوال: الشركة نفسها فعّلت وأكّدت رقمها
  if (phone && trialEnd) sendWaWelcome({ phone, adminName: admin.name, companyName: admin.tenant.name, trialEndsAt: trialEnd });
  if (portal) {
    const aff = portal.affiliate;
    sendMail({
      to: process.env.MAIL_TO || 'info@fieldsa.net',
      subject: `✅ شركة فعّلت حساباً فتحه سفير ${admin.tenant.name}`,
      html: mailLayout('✅ شركة فعّلت حساباً فتحه سفير', [
        ['الشركة', escapeHtml(admin.tenant.name)],
        ['السفير', escapeHtml(`${aff.fullName} · ${aff.code}`)],
        ['تاريخ التفعيل', now.toISOString().slice(0, 10)],
        ['تنتهي التجربة', trialEnd ? trialEnd.toISOString().slice(0, 10) : 'غير محدود'],
        ['غيّرت الجوال', newPhone ? 'نعم' : 'لا'],
        ['نفس شبكة السفير (ip_match)', ipMatch ? 'نعم — معلومةٌ لا توقف الإسناد' : 'لا'],
      ], 'اختار مسؤول الشركة كلمة مروره بنفسه من رابط بريده — السفير لم يرَ كلمة مرور ولا رابطاً.'),
    }).then(ok => { if (!ok) console.error('[activation] إشعار المالك لم يُرسل'); })
      .catch(e => console.error('[activation] owner mail error:', (e as Error).message));
    // إسنادٌ أبطله المالك لا يُبشَّر صاحبه بشركةٍ لم تعد محسوبةً له
    if (portal.status !== 'void') mailTrialActivated(aff.email, aff.fullName, portal.tenantNameSnapshot);
  }
  return { adminId: admin.id };
}

// ───────────────────────────── التسجيل الذاتيّ ببريدٍ بانتظار التفعيل ─────────────────────────────

export const ACTIVATION_RESEND_COOLDOWN_MS = 10 * 60_000;
/** سقف ما تُعيد إرساله محاولات التسجيل لكلّ حساب — نموذجٌ عامّ لا يُغرق صندوق أحد ولا يدوّر روابطه بلا نهاية */
export const SIGNUP_MAX_RESENDS = 5;

/**
 * مسؤولٌ فتح له سفيرٌ حساباً ثمّ جاء يسجّل بنفسه بالبريد نفسه: لا يُنشأ حسابٌ ثانٍ، ويُعاد إليه رابط
 * التفعيل بتدوير الحارس (الآلية نفسها لإعادة إرسال السفير) — مرّةً كلّ عشر دقائق على الأكثر، بمهلةٍ
 * ذرّية على `updatedAt`. البريد للعنوان المخزَّن وحده. لا يرمي أبداً (قرار المالك ٧).
 */
export async function resendActivationForSignup(adminId: string): Promise<void> {
  try {
    const admin = await prisma.admin.findUnique({ where: { id: adminId }, select: { id: true, email: true, passwordHash: true, isActive: true, tenantId: true } });
    if (!admin || !admin.isActive || !isPendingActivationHash(admin.passwordHash)) return;
    const attribution = await prisma.tenantAttribution.findUnique({ where: { tenantId: admin.tenantId }, select: { id: true } });
    if (attribution) {
      const sent = await prisma.affiliateEvent.count({ where: { entity: 'attribution', entityId: attribution.id, action: 'activation_resent', actorType: 'company' } });
      if (sent >= SIGNUP_MAX_RESENDS) return;
    }
    const fresh = await prisma.$transaction(async tx => {
      const h = await rotatePendingHashTx(tx, admin, { notUpdatedSince: new Date(Date.now() - ACTIVATION_RESEND_COOLDOWN_MS) });
      if (h && attribution) {
        await logEvent(tx, { entity: 'attribution', entityId: attribution.id, action: 'activation_resent', actorType: 'company', actorId: admin.tenantId, meta: { via: 'signup' } });
      }
      return h;
    });
    if (fresh) mailCompanyActivation(admin.email, signActivationToken(admin.id, fresh));
  } catch (e) {
    console.error('[activation] signup resend skipped:', (e as Error).message);
  }
}
