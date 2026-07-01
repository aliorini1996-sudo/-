import { sendMail } from './mailer';

/**
 * مُرسل البريد التسويقي — منفصل عن بريد النظام (Resend) لعزل الحصص والسمعة.
 *
 * الأولوية: Brevo (مجاني 300/يوم بلا بطاقة) إن وُجد BREVO_API_KEY، وإلا يعود لـ Resend.
 * يرمي خطأً بسبب واضح عند الفشل (ليظهر للمستخدم بدل رسالة عامة).
 */

export function marketingProvider(): 'brevo' | 'resend' {
  return (process.env.BREVO_API_KEY || '').trim() ? 'brevo' : 'resend';
}

// يفصل «الاسم <البريد>» أو «البريد» إلى اسم وبريد نقي (Brevo يتطلّب بريداً نقياً)
function parseFrom(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] || 'Field Sales').replace(/^["']|["']$/g, ''), email: m[2].trim() };
  return { name: 'Field Sales', email: raw.trim() };
}

interface MarketingMail { subject: string; html: string; to: string; replyTo?: string }

export async function sendMarketingEmail({ subject, html, to, replyTo }: MarketingMail): Promise<void> {
  const key = (process.env.BREVO_API_KEY || '').trim();

  // 1) Brevo (مخصّص للتسويق)
  if (key) {
    const { name, email } = parseFrom(process.env.MARKETING_FROM || process.env.MAIL_FROM || 'info@fieldsa.net');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name, email },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
      }),
    });
    if (res.ok) return;
    const t = await res.text().catch(() => '');
    let msg = t.slice(0, 200);
    try { msg = JSON.parse(t)?.message || msg; } catch { /* نص خام */ }
    throw new Error(`Brevo ${res.status}: ${msg}`);
  }

  // 2) بديل: Resend (بريد النظام) — محدود 100/يوم على المجاني
  const ok = await sendMail({ subject, html, to, replyTo });
  if (!ok) throw new Error('فشل الإرسال عبر Resend (تحقّق من الحصّة اليومية أو ضبط المفتاح).');
}
