/**
 * استعادة كلمة مرور مستخدمي الشركات بالبريد (طلب المالك ٢١ نوفمبر ٢٠٢٦) — والاستعادة برقم جوال الشركة لمن نسي بريده.
 *
 * - الرابط رمزٌ موقَّع بسرٍّ خاصّ (لا يُقرأ جلسةً في أيّ فضاء)، صالحٌ ساعة، ويحمل **بصمة كلمة المرور الحالية**: يعمل مرّةً
 *   واحدة ويسقط وحده متى تغيّرت كلمة المرور (بالاستعادة نفسها أو بغيرها) — بلا جدولٍ جديد.
 * - في المقطع (#t=) لا الاستعلام: لا يصل الخادم ولا سجلّات Render ولا ترويسة Referer (كرابط التفعيل).
 * - الردّ على الطلب واحدٌ وُجد البريد أم لا (قرار المالك: لا «لا يوجد حساب بهذا البريد»).
 * - حسابٌ ينتظر التفعيل (فتحه سفير) لا كلمة مرور له تُستعاد: يُعاد إليه رابط التفعيل بآليته القائمة.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { sendMail } from './mailer';
import { escapeHtml, frontendBase } from './affiliate/core';
import { phoneKey } from './phoneKey';
import { isPendingActivationHash, resendActivationForSignup } from './trialCompany';

export const RESET_TTL = '1h';
/** لا يُرسل للحساب الواحد أكثر من بريد استعادة كل دقيقتين — فوق حدّ الطلبات لكل عنوان (mailLimiter) */
export const RESET_COOLDOWN_MS = 2 * 60 * 1000;
/** أقصى عدد شركاتٍ يطابقها رقم جوال واحد — وما زاد غموضٌ لا يُرسل له شيء */
const PHONE_MAX_TENANTS = 3;

function resetSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error('JWT_SECRET غير مضبوط');
  const own = process.env.PASSWORD_RESET_SECRET;
  return own && own !== base ? own : `${base}::password-reset`;
}

/** بصمة كلمة المرور **والبريد**: تغيّر أيٍّ منهما يُسقط الرابط — فلا يبقى رابطٌ أُرسل لعنوانٍ قديم صالحاً بعد نقل الحساب لغيره */
export function resetFingerprint(hash: string, email: string): string {
  return crypto.createHash('sha256').update(`${hash}|${String(email).trim().toLowerCase()}`).digest('hex').slice(0, 32);
}

export function signResetToken(adminId: string, passwordHash: string, email: string): string {
  return jwt.sign({ aid: adminId, purpose: 'password-reset', fp: resetFingerprint(passwordHash, email) }, resetSecret(), { expiresIn: RESET_TTL } as jwt.SignOptions);
}

const SESSION_KEYS = ['id', 'role', 'tenantId', 'kind', 'uid'];

export function verifyResetToken(token: string): { aid: string; fp: string } | null {
  try {
    const p = jwt.verify(token, resetSecret()) as Record<string, unknown>;
    if (p.purpose !== 'password-reset' || typeof p.aid !== 'string' || typeof p.fp !== 'string') return null;
    if (SESSION_KEYS.some((k) => k in p)) return null;
    return { aid: p.aid, fp: p.fp };
  } catch { return null; }
}

export function resetUrl(token: string): string {
  return `${frontendBase()}/reset-password#t=${encodeURIComponent(token)}`;
}

/** «a•••@g•••.com» — يكفي صاحبه ليعرفه ولا يكشفه لغيره */
export function maskEmail(email: string): string {
  const [user, domain = ''] = String(email).split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${(user || '?').slice(0, 1)}•••@${(host || '?').slice(0, 1)}•••${tld}`;
}

/** أرقام عربية/فارسية ⇒ لاتينية ثم مفتاح الجوال الموحّد (05x ⇒ 9665x) */
export function companyPhoneKey(v: string): string {
  const latin = String(v || '').replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return phoneKey(latin);
}

/** كُتب الرقم بلا رمز دولة؟ (يبدأ بصفرٍ محلي أو قصيرٌ) — بعد الأرقام اللاتينية وقبل مفتاح الجوال */
function isLocalPhone(v: string): boolean {
  const d = String(v || '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[^\d+]/g, '');
  return !d.startsWith('+') && !d.startsWith('00') && d.replace(/\D/g, '').length <= 10;
}

/**
 * هل رقم الطالب `input` هو جوال الشركة المحفوظ `stored`؟ بالمفتاح الموحّد كاملاً — وبآخر تسعة أرقام **فقط** حين كتب الطالب رقماً
 * محلياً بلا رمز دولة (شركةٌ إماراتية محفوظة 971… يكتبها صاحبها 050…). رقمٌ برمز دولة لا يطابق شركةً في دولةٍ أخرى بذيله
 */
export function samePhone(input: string, stored: string): boolean {
  const x = companyPhoneKey(input), y = companyPhoneKey(stored);
  if (x.length < 7 || y.length < 7) return false;
  if (x === y) return true;
  return isLocalPhone(input) && x.length >= 9 && y.length >= 9 && x.slice(-9) === y.slice(-9);
}

const lastSent = new Map<string, number>();
function coolingDown(adminId: string, now = Date.now()): boolean {
  const t = lastSent.get(adminId);
  if (t && now - t < RESET_COOLDOWN_MS) return true;
  lastSent.set(adminId, now);
  if (lastSent.size > 5000) for (const [k, v] of lastSent) if (now - v > RESET_COOLDOWN_MS) lastSent.delete(k);
  return false;
}

type AdminRow = { id: string; name: string; email: string; passwordHash: string; isActive: boolean; tenant: { isActive: boolean; name: string } | null };
const ADMIN_SELECT = { id: true, name: true, email: true, passwordHash: true, isActive: true, tenant: { select: { isActive: true, name: true } } } as const;

/** البريد كما خُزّن، أو بحالة أحرفٍ أخرى إن طابق حساباً واحداً فقط (الحرف الأول الكبير من لوحة الجوال) */
export async function findAdminByEmail(email: string): Promise<AdminRow | null> {
  const e = String(email || '').trim();
  if (!e) return null;
  const exact = await prisma.admin.findUnique({ where: { email: e }, select: ADMIN_SELECT });
  if (exact) return exact;
  const ci = await prisma.admin.findMany({ where: { email: { equals: e, mode: 'insensitive' } }, select: ADMIN_SELECT, take: 3 });
  const same = ci.filter((a) => a.email.toLowerCase() === e.toLowerCase());
  return same.length === 1 ? same[0] : null;
}

/** يرسل لهذا الحساب ما يناسبه: رابط تفعيلٍ لمن ينتظره، وإلا رابط استعادة — ولا شيء لموقوفٍ أو شركةٍ موقوفة */
async function sendRecoveryFor(admin: AdminRow, via: 'email' | 'phone'): Promise<boolean> {
  if (!admin.isActive || !admin.tenant?.isActive) return false;
  if (isPendingActivationHash(admin.passwordHash)) { await resendActivationForSignup(admin.id); return true; }
  if (coolingDown(admin.id)) return true;
  mailPasswordReset(admin.email, signResetToken(admin.id, admin.passwordHash, admin.email), via);
  return true;
}

/** «نسيت كلمة المرور»: لا يُعلم الطالب بشيء — الردّ واحد (المسار) */
export async function requestPasswordReset(email: string): Promise<void> {
  const admin = await findAdminByEmail(email);
  if (admin) await sendRecoveryFor(admin, 'email');
}

/**
 * «نسيت بريدي»: رقم جوال الشركة (إعدادات الشركة) ⇒ رابط الاستعادة إلى بريد مديرها (دور ADMIN) — ويُعاد البريد مقنّعاً ليعرفه.
 * المطابقة في الذاكرة بالمفتاح الموحّد بعد ترشيحٍ بآخر ستة أرقام. أكثر من PHONE_MAX_TENANTS شركة بالرقم نفسه ⇒ لا شيء.
 */
export async function recoverByCompanyPhone(phone: string): Promise<string[]> {
  const key = companyPhoneKey(phone);
  if (key.length < 7) return [];
  // الجوال محفوظٌ كما كُتب في الإعدادات (بمسافات أو أرقام عربية) فلا يُرشَّح بنصٍّ في القاعدة — حقلان صغيران لكل شركة
  const settings = await prisma.companySettings.findMany({
    where: { phone: { not: null } },
    select: { tenantId: true, phone: true },
    take: 20000,
  });
  const tenants = [...new Set(settings.filter((s) => s.phone && samePhone(phone, s.phone)).map((s) => s.tenantId))];
  if (tenants.length === 0 || tenants.length > PHONE_MAX_TENANTS) return [];
  const admins = await prisma.admin.findMany({
    where: { tenantId: { in: tenants }, role: 'ADMIN', isActive: true },
    select: ADMIN_SELECT,
    orderBy: { createdAt: 'asc' },
    take: 6,
  });
  const out: string[] = [];
  for (const a of admins) if (await sendRecoveryFor(a, 'phone')) out.push(maskEmail(a.email));
  return [...new Set(out)];
}

export class ResetError extends Error {
  constructor(public status: number, message: string, public code: string) { super(message); }
}
export const RESET_INVALID = 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية';

/** الرمز صالح ويطابق كلمة المرور الحالية لحسابٍ نشط — وإلا ResetError */
async function adminOfToken(token: string) {
  const v = verifyResetToken(token);
  if (!v) throw new ResetError(400, RESET_INVALID, 'invalid');
  const admin = await prisma.admin.findUnique({ where: { id: v.aid }, include: { tenant: true } });
  if (!admin || !admin.isActive || isPendingActivationHash(admin.passwordHash) || resetFingerprint(admin.passwordHash, admin.email) !== v.fp) {
    throw new ResetError(400, RESET_INVALID, 'invalid');
  }
  return admin;
}

export async function resetPreview(token: string) {
  const a = await adminOfToken(token);
  return { name: a.name, email: a.email, companyName: a.tenant?.name ?? null };
}

/**
 * تعيين كلمة المرور الجديدة — تحديثٌ مشروط بالبصمة نفسها (updateMany حيث passwordHash القديم): طلبان متزامنان بالرابط نفسه
 * ينجح أحدهما وحده. والبريد صار مُثبَت الملكية (emailVerified). وبريد تنبيهٍ بالتغيير لصاحب الحساب.
 */
export async function resetPassword(token: string, password: string) {
  const admin = await adminOfToken(token);
  const hash = await bcrypt.hash(password, 10);
  const { count } = await prisma.admin.updateMany({
    where: { id: admin.id, passwordHash: admin.passwordHash, email: admin.email, isActive: true },
    data: { passwordHash: hash, emailVerified: true },
  });
  if (count !== 1) throw new ResetError(400, RESET_INVALID, 'invalid');
  lastSent.delete(admin.id);
  mailPasswordChanged(admin.email);
  return prisma.admin.findUnique({ where: { id: admin.id }, include: { tenant: true } });
}

// ───────────────────────────── البريد ─────────────────────────────
// نصٌّ ثابت بهوية FieldSales — لا اسم ولا شيء كتبه أحد غير البريد نفسه (مُهرَّباً)

function shell(title: string, body: string): string {
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">FieldSales — ${title}</div>
      <div style="padding:22px;color:#3a342b;font-size:15px;line-height:1.8">${body}</div>
    </div>
  </div>`;
}
const para = (s: string) => `<p style="margin:0 0 12px">${s}</p>`;

export function passwordResetHtml(to: string, token: string, via: 'email' | 'phone'): string {
  const url = escapeHtml(resetUrl(token));
  return shell('إعادة تعيين كلمة المرور', `
        ${para('مرحباً،')}
        ${para(via === 'phone'
    ? 'طلب أحدهم استعادة الدخول إلى حساب شركتكم برقم جوالها. بريد الدخول إلى حسابكم هو:'
    : 'وصلنا طلب لإعادة تعيين كلمة مرور حسابكم. بريد الدخول هو:')}
        <p dir="ltr" style="margin:0 0 14px;font-weight:700;color:#1F1A13;text-align:center">${escapeHtml(to)}</p>
        ${para('اختر كلمة مرور جديدة من الزرّ أدناه. الرابط صالح ساعة واحدة ويعمل مرّةً واحدة.')}
        <div style="text-align:center;margin:22px 0">
          <a href="${url}" style="background:#E15A30;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:12px;display:inline-block">تعيين كلمة مرور جديدة</a>
        </div>
        <p style="margin:0 0 12px;color:#6E6557;font-size:12px;word-break:break-all">${url}</p>
        ${para('إن لم تطلبوا ذلك فتجاهلوا هذه الرسالة، ولن يتغيّر شيء في حسابكم.')}
        <p dir="ltr" style="margin:12px 0 0;color:#6E6557;font-size:13px;line-height:1.6;text-align:left">We received a request to reset the password of your FieldSales account (${escapeHtml(to)}). Use the button above within one hour. If it wasn't you, ignore this email.</p>`);
}

function mailPasswordReset(to: string, token: string, via: 'email' | 'phone'): void {
  try {
    sendMail({ to, subject: 'إعادة تعيين كلمة المرور — FieldSales', html: passwordResetHtml(to, token, via) })
      .then((ok) => { if (!ok) console.error('[reset] بريد الاستعادة لم يُرسل'); })
      .catch((e) => console.error('[reset] mail error:', (e as Error).message));
  } catch (e) { console.error('[reset] mail error:', (e as Error).message); }
}

function mailPasswordChanged(to: string): void {
  try {
    const html = shell('تم تغيير كلمة المرور', `
        ${para('مرحباً،')}
        ${para('تم تغيير كلمة مرور حسابكم على FieldSales الآن عبر رابط الاستعادة.')}
        ${para('إن لم تكن أنت من غيّرها فتواصل معنا فوراً بالردّ على هذه الرسالة أو عبر info@fieldsa.net.')}
        <p dir="ltr" style="margin:12px 0 0;color:#6E6557;font-size:13px;line-height:1.6;text-align:left">Your FieldSales password was just changed. If this wasn't you, contact us immediately.</p>`);
    sendMail({ to, subject: 'تم تغيير كلمة المرور — FieldSales', html })
      .catch((e) => console.error('[reset] changed-mail error:', (e as Error).message));
  } catch (e) { console.error('[reset] changed-mail error:', (e as Error).message); }
}
