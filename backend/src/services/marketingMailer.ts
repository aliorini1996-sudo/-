import { sendMail } from './mailer';

/**
 * مُرسل البريد التسويقي — منفصل عن بريد النظام (Resend) لعزل الحصص والسمعة.
 *
 * الأولوية: Brevo (مجاني 300/يوم بلا بطاقة) إن وُجد BREVO_API_KEY، وإلا يعود لـ Resend.
 * هكذا لا يستهلك التسويق حصّة Resend المخصّصة لبريد النظام (تأكيد التسجيل/التواصل).
 */

export function marketingProvider(): 'brevo' | 'resend' {
  return (process.env.BREVO_API_KEY || '').trim() ? 'brevo' : 'resend';
}

interface MarketingMail { subject: string; html: string; to: string; replyTo?: string }

export async function sendMarketingEmail({ subject, html, to, replyTo }: MarketingMail): Promise<boolean> {
  const key = (process.env.BREVO_API_KEY || '').trim();

  // 1) Brevo (مخصّص للتسويق)
  if (key) {
    try {
      const fromEmail = process.env.MARKETING_FROM || process.env.MAIL_FROM || 'info@fieldsa.net';
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Field Sales', email: fromEmail },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
      });
      if (res.ok) return true;
      console.error('[marketing] فشل Brevo:', res.status, await res.text().catch(() => ''));
      return false;
    } catch (e) {
      console.error('[marketing] خطأ Brevo:', e);
      return false;
    }
  }

  // 2) بديل: Resend (بريد النظام) — محدود 100/يوم على المجاني
  return sendMail({ subject, html, to, replyTo });
}
