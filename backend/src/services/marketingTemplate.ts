/**
 * قالب البريد التسويقي المشترك (بطاقة بصرية + نصّ ثنائي اللغة) —
 * يُستخدم في الإرسال اليدوي (routes/leads) والإرسال التلقائي المستمر (services/leadEmailer).
 */

export interface LeadLike { name: string; city?: string | null; country?: string | null }

// يستبدل العناصر النائبة {{name}} / {{city}} / {{country}}
export function personalize(text: string, lead: LeadLike): string {
  return text
    .replace(/\{\{\s*name\s*\}\}/g, lead.name || '')
    .replace(/\{\{\s*city\s*\}\}/g, lead.city || '')
    .replace(/\{\{\s*country\s*\}\}/g, lead.country || '');
}

// قالب بريد تسويقي بهوية Field Sales (بطاقة hero + شريط ميزات + CTA وتذييل ثنائي اللغة)
export function marketingHtml(bodyText: string, lead: LeadLike): string {
  const safe = personalize(bodyText, lead)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const feat = (ar: string, en: string) => `<td style="padding:9px 12px;vertical-align:top;width:50%">
    <span style="color:#E15A30;font-weight:700">●</span>
    <span style="color:#1F1A13;font-size:14px;font-weight:600"> ${ar}</span>
    <span style="color:#9A8F7E;font-size:12px"> · ${en}</span></td>`;
  return `<div style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#F1EBDF;padding:24px 12px">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;box-shadow:0 2px 10px rgba(31,26,19,0.08)">
      <a href="https://fieldsa.net" style="display:block"><img src="https://fieldsa.net/email/hero.png" alt="Field Sales" width="600" style="width:100%;max-width:600px;display:block;border:0" /></a>
      <div dir="auto" style="padding:26px 28px 10px;color:#3a342b;font-size:15px;line-height:1.95">${safe}</div>
      <table role="presentation" width="100%" style="border-collapse:collapse;margin:4px 14px 6px">
        <tr>${feat('فواتير ZATCA', 'ZATCA e-invoicing')}${feat('التحصيل والذمم', 'Collections')}</tr>
        <tr>${feat('مخزون سيارة المندوب', 'Van inventory')}${feat('تتبّع GPS', 'Live GPS tracking')}</tr>
      </table>
      <div style="padding:16px 24px 26px;text-align:center">
        <a href="https://fieldsa.net" style="display:inline-block;background:#E15A30;color:#ffffff;text-decoration:none;padding:14px 38px;border-radius:12px;font-weight:700;font-size:16px">جرّب Field Sales مجاناً &nbsp;·&nbsp; Start free</a>
      </div>
      <div dir="auto" style="padding:14px 26px;color:#9A8F7E;font-size:12px;line-height:1.7;border-top:1px solid #F1EBDF;background:#FAF7F0">
        رسالة أعمال من Field Sales — إن لم ترغب بتلقّي رسائلنا، ردّ بكلمة «إلغاء».<br>
        This is a B2B message from Field Sales · <a href="https://fieldsa.net" style="color:#6E6557;text-decoration:underline">fieldsa.net</a> · reply "unsubscribe" to opt out.
      </div>
    </div>
  </div>`;
}

// النص الافتراضي المزدوج (عربي/إنجليزي) للبريد التلقائي
export const DEFAULT_EMAIL_SUBJECT = 'Field Sales — نظام مبيعات المناديب والتوزيع | Field-sales & distribution platform';
export const DEFAULT_EMAIL_BODY = [
  'مرحباً فريق {{name}}،',
  '',
  'Field Sales منصّة متكاملة لإدارة مبيعات المناديب الميدانيين والتوزيع: فواتير ضريبية متوافقة مع ZATCA، تحصيل وإدارة ذمم، مخزون سيارة المندوب، وتتبّع المواقع بالـGPS — في لوحة واحدة سهلة.',
  '',
  'يسعدنا أن نعرض عليكم النظام في جولة قصيرة، أو جرّبوه مجاناً على fieldsa.net.',
  '',
  '— — —',
  '',
  'Hello {{name}} team,',
  '',
  'Field Sales is an all-in-one platform to run your field reps and distribution: ZATCA-compliant tax invoicing, collections & receivables, van inventory, and live GPS tracking — all in one simple dashboard.',
  '',
  "We'd be glad to give you a short demo, or start your free trial at fieldsa.net.",
  '',
  'مع خالص التحية · Best regards,',
  'فريق Field Sales',
].join('\n');
