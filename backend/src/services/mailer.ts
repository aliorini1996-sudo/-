import nodemailer from 'nodemailer';

// خدمة إرسال البريد — تدعم SMTP (مثل Zoho) أو Resend (HTTP)، حسب متغيّرات البيئة.
// إن لم يُضبط أيٌّ منهما، تتخطّى بهدوء دون كسر الطلب.

const smtpReady = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const smtpPort = Number(process.env.SMTP_PORT || 465);
const transporter = smtpReady
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: smtpPort,
      secure: smtpPort === 465, // 465 = SSL، 587 = STARTTLS
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
    })
  : null;

interface MailInput {
  subject: string;
  html: string;
  replyTo?: string;
  to?: string; // المستقبِل (افتراضياً MAIL_TO/info@fieldsa.net)
}

export async function sendMail({ subject, html, replyTo, to: toOverride }: MailInput): Promise<boolean> {
  const to = toOverride || process.env.MAIL_TO || 'info@fieldsa.net';

  // 1) عبر SMTP (Zoho وغيره)
  if (transporter) {
    try {
      await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, html, replyTo });
      return true;
    } catch (e) { console.error('[mail] فشل SMTP:', e); return false; }
  }

  // 2) عبر Resend (HTTP) كبديل
  const key = process.env.RESEND_API_KEY;
  if (key) {
    try {
      const from = process.env.MAIL_FROM || 'Field Sales <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      if (!res.ok) { console.error('[mail] فشل Resend:', res.status, await res.text().catch(() => '')); return false; }
      return true;
    } catch (e) { console.error('[mail] خطأ Resend:', e); return false; }
  }

  console.log('[mail] لم يُضبط بريد (SMTP/Resend) — تم تخطّي:', subject);
  return false;
}

// قالب بريد موحّد بهوية Field Sales
export function mailLayout(title: string, rows: [string, string][], extra = ''): string {
  const items = rows.map(([k, v]) => `<tr><td style="padding:6px 10px;color:#6E6557;white-space:nowrap">${k}</td><td style="padding:6px 10px;font-weight:600;color:#1F1A13">${v || '—'}</td></tr>`).join('');
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">FieldSales — ${title}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;padding:10px">${items}</table>
      ${extra ? `<div style="padding:14px 20px;color:#3a342b;font-size:14px;line-height:1.7;border-top:1px solid #F1EBDF">${extra}</div>` : ''}
    </div>
  </div>`;
}
