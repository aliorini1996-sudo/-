/**
 * محرّك البريد التلقائي المستمر — يرسل دفعات بريد تسويقي للعملاء المحتملين
 * (من لديه بريد ولم يُراسَل) بلا توقّف، مع حدّ يومي يحمي السمعة وحصّة المزوّد.
 *
 * الإعداد يُخزَّن في SiteContent (id="lead_autoemail") — بلا تغيير مخطّط.
 */
import prisma from '../config/database';
import { sendMarketingEmail } from './marketingMailer';
import { personalize, marketingHtml, DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL_BODY } from './marketingTemplate';

export interface EmailConfig {
  enabled: boolean;
  subject: string;
  body: string;
  batchSize: number;   // كم بريد لكل دفعة
  dailyCap: number;    // الحد الأقصى يومياً (حماية السمعة/الحصّة)
  stage: string | null;
  source: string | null;
  countryCode: string | null;
  sentDate: string | null; // YYYY-MM-DD (لإعادة الضبط اليومي)
  sentToday: number;
  totalSent: number;
  lastRunAt: string | null;
}

const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: false,
  subject: DEFAULT_EMAIL_SUBJECT,
  body: DEFAULT_EMAIL_BODY,
  batchSize: 20,
  dailyCap: 80,
  stage: null,
  source: null,
  countryCode: null,
  sentDate: null,
  sentToday: 0,
  totalSent: 0,
  lastRunAt: null,
};

const CONFIG_ID = 'lead_autoemail';

export async function getEmailConfig(): Promise<EmailConfig> {
  const row = await prisma.siteContent.findUnique({ where: { id: CONFIG_ID } });
  if (!row?.data) return { ...DEFAULT_EMAIL_CONFIG };
  try {
    return { ...DEFAULT_EMAIL_CONFIG, ...(JSON.parse(row.data) as Partial<EmailConfig>) };
  } catch {
    return { ...DEFAULT_EMAIL_CONFIG };
  }
}

export async function saveEmailConfig(cfg: EmailConfig): Promise<void> {
  await prisma.siteContent.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, data: JSON.stringify(cfg) },
    update: { data: JSON.stringify(cfg) },
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// تشغيل دفعة بريد تلقائي واحدة (يحترم الحدّ اليومي وحجم الدفعة)
export async function runAutoEmailBatch(): Promise<{
  sent: number; failed: number; remainingToday: number; targeted: number; errors: string[];
}> {
  const cfg = await getEmailConfig();

  // إعادة الضبط اليومي
  if (cfg.sentDate !== today()) { cfg.sentDate = today(); cfg.sentToday = 0; }

  const remaining = Math.max(0, cfg.dailyCap - cfg.sentToday);
  if (remaining <= 0) {
    cfg.lastRunAt = new Date().toISOString();
    await saveEmailConfig(cfg);
    return { sent: 0, failed: 0, remainingToday: 0, targeted: 0, errors: ['بلغ الحدّ اليومي'] };
  }
  const take = Math.min(cfg.batchSize, remaining);

  // من لديه بريد ولم تسبق مراسلته (بلا نشاط EMAIL) + فلاتر اختيارية
  const where: Record<string, unknown> = { email: { not: null }, activities: { none: { type: 'EMAIL' } } };
  if (cfg.stage) where.stage = cfg.stage;
  if (cfg.source) where.source = cfg.source;
  if (cfg.countryCode) where.countryCode = cfg.countryCode;

  const leads = await prisma.lead.findMany({ where, take });
  const targets = leads.filter((l) => l.email && l.email.includes('@'));

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const l of targets) {
    const subject = personalize(cfg.subject, l);
    const html = marketingHtml(cfg.body, l);
    try {
      await sendMarketingEmail({ subject, html, to: l.email! });
      sent++;
      cfg.sentToday++;
      cfg.totalSent++;
      await prisma.lead.update({
        where: { id: l.id },
        data: { lastContactedAt: new Date(), stage: l.stage === 'NEW' ? 'CONTACTED' : l.stage },
      });
      await prisma.leadActivity.create({
        data: { leadId: l.id, type: 'EMAIL', content: `بريد تلقائي: ${subject}`, createdBy: 'auto-email' },
      });
    } catch (e) {
      failed++;
      if (errors.length < 3) errors.push((e as Error).message);
      // نتوقّف عند أول فشل جماعي (غالباً حدّ المزوّد) لتفادي حرق الحصّة
      if ((e as Error).message.includes('429') || (e as Error).message.toLowerCase().includes('quota') || (e as Error).message.includes('402')) break;
    }
  }

  cfg.lastRunAt = new Date().toISOString();
  await saveEmailConfig(cfg);

  return { sent, failed, remainingToday: Math.max(0, cfg.dailyCap - cfg.sentToday), targeted: targets.length, errors };
}
