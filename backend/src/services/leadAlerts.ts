/**
 * مستلمو التنبيه اللحظي بالعملاء الجدد (طلب المالك ٨ نوفمبر ٢٠٢٦):
 * «في حال طلب احد اجتماع او قام احد بتسجيل تجربة جديد اجعل ارسال لحظي سريع ايميل مباشرة بدون اي تاخير ابدا».
 *
 * يُرسَل البريد لحظة الحدث نفسه (لا طابور ولا تجميع ولا جدولة): طلب «احجز اجتماع» (routes/contact.ts)، وكل تسجيل تجربة
 * جديدة — تسجيل الشركة بنفسها (routes/auth.ts /signup) وما يفتحه سفير (affiliate/portalTrial.ts) — عبر notifyOwnerNewTrial.
 * البريد الرئيسي (MAIL_TO وإلا info@fieldsa.net) يبقى مستلماً كما كان، ويُضاف إليه الثلاثة. LEAD_ALERT_EMAILS (قائمة بفواصل)
 * يستبدل الثلاثة إن ضُبط في البيئة.
 */
export const LEAD_ALERT_EMAILS: readonly string[] = ['abdullah@fieldsa.net', 'anas@fieldsa.net', 'ceo@fieldsa.net'];

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** المستلمون: البريد الرئيسي ثم الثلاثة (أو قائمة البيئة)، بلا تكرار وبلا عنوانٍ فاسد */
export function leadAlertRecipients(env: Record<string, string | undefined> = process.env): string[] {
  const main = (env.MAIL_TO || 'info@fieldsa.net').trim();
  const extra = env.LEAD_ALERT_EMAILS && env.LEAD_ALERT_EMAILS.trim() !== ''
    ? env.LEAD_ALERT_EMAILS.split(/[,;\s]+/)
    : [...LEAD_ALERT_EMAILS];
  const out: string[] = [];
  for (const raw of [main, ...extra]) {
    const e = raw.trim().toLowerCase();
    if (EMAIL_RE.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}
