/**
 * بريد برنامج السفراء — بهوية فيلد سيلز، وكلّ نصٍّ من المستخدم مُهرَّب.
 * الإرسال لا يُسقط أيّ عملية: الفشل يُسجَّل ويُكمَل.
 */
import { sendMail } from '../mailer';
import { escapeHtml, frontendBase, riyadhDay } from './core';

function layout(title: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const body = paragraphs.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const button = cta
    ? `<div style="text-align:center;margin:22px 0">
         <a href="${escapeHtml(cta.url)}" style="background:#E15A30;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:12px;display:inline-block">${escapeHtml(cta.label)}</a>
       </div>
       <p style="margin:0;color:#6E6557;font-size:12px;word-break:break-all">${escapeHtml(cta.url)}</p>`
    : '';
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">سفير فيلد سيلز — ${escapeHtml(title)}</div>
      <div style="padding:22px;color:#3a342b;font-size:15px;line-height:1.8">${body}${button}</div>
    </div>
  </div>`;
}

function send(to: string, subject: string, html: string): void {
  sendMail({ to, subject, html })
    .then(ok => { if (!ok) console.error(`[affiliate] mail not sent: ${subject}`); })
    .catch(e => console.error('[affiliate] mail error:', (e as Error).message));
}

const sar = (h: number) => (h / 100).toFixed(2);
const portal = () => `${frontendBase()}/ax`;

/**
 * بريدا التأكيد والاستعادة يصلان عنواناً **لم تُثبت ملكيّته** ويطلبهما أيّ أحد —
 * فلا يحملان نصّاً كتبه الطالب (الاسم): «مرحباً اشتراكك موقوف ادفع عبر fieldsa-pay.com»
 * كانت ستصل الضحيّة داخل بريدٍ رسميٍّ حقيقي من فيلد سيلز.
 */
export function mailVerify(to: string, _name: string, token: string): void {
  const url = `${portal()}?verify=${encodeURIComponent(token)}`;
  send(to, 'تأكيد بريدك — سفير فيلد سيلز', layout('تأكيد البريد', [
    'مرحباً،',
    'شكراً لطلب الانضمام إلى برنامج سفير فيلد سيلز. أكّد بريدك ليصل طلبك إلى المراجعة.',
    'الرابط صالح يومين. إن لم تكن أنت من سجّل فتجاهل الرسالة.',
  ], { label: 'تأكيد البريد', url }));
}

export function mailReset(to: string, _name: string, token: string): void {
  const url = `${portal()}?reset=${encodeURIComponent(token)}`;
  send(to, 'استعادة كلمة المرور — سفير فيلد سيلز', layout('استعادة كلمة المرور', [
    'مرحباً،',
    'طلبتَ تعيين كلمة مرور جديدة. الرابط صالح ساعة واحدة ويُستعمل مرّة.',
    'إن لم تطلب ذلك فتجاهل الرسالة، وكلمة مرورك الحالية تبقى كما هي.',
  ], { label: 'تعيين كلمة مرور جديدة', url }));
}

export function mailOwnerNewApplicant(a: { fullName: string; email: string; phone: string | null; city: string | null; publicPromoter: boolean; mawthooqNo: string | null }): void {
  const to = process.env.MAIL_TO || 'info@fieldsa.net';
  send(to, `طلب سفير جديد: ${a.fullName}`, layout('طلب انضمام جديد', [
    `<b>${escapeHtml(a.fullName)}</b> أكّد بريده وينتظر موافقتك.`,
    `البريد: ${escapeHtml(a.email)} · الجوال: ${escapeHtml(a.phone ?? '—')} · المدينة: ${escapeHtml(a.city ?? '—')}`,
    a.publicPromoter ? `سينشر علناً — رقم موثوق: ${escapeHtml(a.mawthooqNo ?? '—')}` : 'لن ينشر علناً.',
    'راجع الطلب من لوحة المالك ← السفراء.',
  ]));
}

export function mailDecision(to: string, name: string, decision: 'approved' | 'rejected' | 'suspended' | 'reactivated', reason?: string | null): void {
  const titles = { approved: 'قُبل طلبك', rejected: 'نتيجة طلبك', suspended: 'إيقاف الحساب', reactivated: 'أُعيد تفعيل حسابك' } as const;
  const lines: Record<typeof decision, string[]> = {
    approved: ['يسعدنا قبولك سفيراً لفيلد سيلز. ادخل البوابة لتجد رابطك الخاص وتبدأ.'],
    rejected: ['نعتذر، لم يُقبل طلب الانضمام في الوقت الحالي.'],
    suspended: ['أُوقف حسابك في برنامج السفراء مؤقتاً.'],
    reactivated: ['أُعيد تفعيل حسابك ويمكنك مواصلة الإحالة.'],
  };
  send(to, `${titles[decision]} — سفير فيلد سيلز`, layout(titles[decision], [
    `مرحباً ${escapeHtml(name)}،`,
    ...lines[decision],
    ...(reason ? [`السبب: ${escapeHtml(reason)}`] : []),
  ], decision === 'approved' || decision === 'reactivated' ? { label: 'دخول البوابة', url: portal() } : undefined));
}

export function mailCommissionCreated(to: string, name: string, c: { tenantName: string; commissionHalalas: number; eligibleAt: Date; onHold: boolean }): void {
  send(to, 'شركةٌ أحلتها دفعت — سفير فيلد سيلز', layout('عمولة جديدة', [
    `مرحباً ${escapeHtml(name)}،`,
    `دفعت «${escapeHtml(c.tenantName)}» اشتراكها الأوّل، ونشأت لك عمولة بقيمة <b>${sar(c.commissionHalalas)} ريال</b>.`,
    c.onHold
      ? 'العمولة موقوفة حتى تُحسم مراجعة الإسناد.'
      : `تبقى معلّقة حتى ${riyadhDay(c.eligibleAt)} ثم تُعتمد إن بقيت الدفعة قائمة.`,
  ], { label: 'عرض أرباحي', url: portal() }));
}

export function mailPayoutRecorded(to: string, name: string, p: { netHalalas: number; bankReference: string; ibanLast4: string }): void {
  send(to, 'حُوِّلت مستحقّاتك — سفير فيلد سيلز', layout('تحويل مستحقّات', [
    `مرحباً ${escapeHtml(name)}،`,
    `حوّلنا <b>${sar(p.netHalalas)} ريال</b> إلى الآيبان المنتهي بـ${escapeHtml(p.ibanLast4)}.`,
    `مرجع التحويل: ${escapeHtml(p.bankReference)}`,
  ], { label: 'عرض الدفعات', url: portal() }));
}

/** تغيير بيانات الاستلام يُبلَّغ به صاحب الحساب — جلسةٌ مسروقة لا تحوّل المستحقّات بصمت */
export function mailPayoutProfileChanged(to: string, name: string, ibanLast4: string): void {
  send(to, 'تغيّرت بيانات الاستلام — سفير فيلد سيلز', layout('تغيير بيانات الاستلام', [
    `مرحباً ${escapeHtml(name)}،`,
    `حُدّثت بيانات استلام مستحقّاتك إلى آيبانٍ ينتهي بـ${escapeHtml(ibanLast4)}.`,
    'إن لم تكن أنت من غيّرها فاستعد كلمة المرور فوراً وتواصل معنا قبل موعد الصرف.',
  ], { label: 'دخول البوابة', url: portal() }));
}
