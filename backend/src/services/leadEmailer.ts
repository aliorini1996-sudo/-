/**
 * محرّك البريد التلقائي المستمر — سلسلة متابعة متعددة اللمسات (حتى 3):
 *  اللمسة 1 تعريف → بعد gapDays اللمسة 2 (قيمة/إثبات) → بعد gapDays اللمسة 3 (رسالة أخيرة).
 *
 * الأولوية للمتابعات (تحوّل أعلى) ثم اللمسات الأولى الجديدة، مع حدّ يومي يحمي السمعة.
 * التوقيت وعدّ اللمسات عبر أنشطة EMAIL و lastContactedAt — بلا تغيير مخطّط.
 * يُستثنى من راسَلنا بإلغاء (نشاط UNSUB) ومن نقر رابطاً (صار ساخناً stage=QUALIFIED — متابعة بشرية).
 *
 * الإعداد يُخزَّن في SiteContent (id="lead_autoemail").
 */
import prisma from '../config/database';
import { sendMarketingEmail } from './marketingMailer';
import { personalize, marketingHtml, touchTemplate, DEFAULT_EMAIL_SUBJECT, DEFAULT_EMAIL_BODY } from './marketingTemplate';

export interface EmailConfig {
  enabled: boolean;
  subject: string;
  body: string;
  subject2: string | null; // اللمسة 2 (null = القالب الافتراضي)
  body2: string | null;
  subject3: string | null; // اللمسة 3
  body3: string | null;
  touches: number;     // عدد لمسات السلسلة (1-3)
  gapDays: number;     // الأيام بين اللمسات
  batchSize: number;   // كم بريد لكل دفعة
  dailyCap: number;    // الحد الأقصى يومياً (حماية السمعة/الحصّة)
  stage: string | null;
  source: string | null;
  countryCode: string | null;
  sentDate: string | null; // YYYY-MM-DD (لإعادة الضبط اليومي)
  sentToday: number;
  totalSent: number;
  totalFollowUps: number;
  lastRunAt: string | null;
}

const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  enabled: false,
  subject: DEFAULT_EMAIL_SUBJECT,
  body: DEFAULT_EMAIL_BODY,
  subject2: null,
  body2: null,
  subject3: null,
  body3: null,
  touches: 3,
  gapDays: 4,
  batchSize: 20,
  dailyCap: 80,
  stage: null,
  source: null,
  countryCode: null,
  sentDate: null,
  sentToday: 0,
  totalSent: 0,
  totalFollowUps: 0,
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

interface Target {
  id: string; name: string; email: string;
  city: string | null; country: string | null; countryCode: string | null; stage: string;
  touch: number; // رقم اللمسة المُرسلة الآن (1-3)
}

// تشغيل دفعة بريد تلقائي واحدة (متابعات أولاً ثم لمسات أولى، ضمن الحدّ اليومي)
export async function runAutoEmailBatch(): Promise<{
  sent: number; failed: number; followUps: number; remainingToday: number; targeted: number; errors: string[];
}> {
  const cfg = await getEmailConfig();

  // إعادة الضبط اليومي
  if (cfg.sentDate !== today()) { cfg.sentDate = today(); cfg.sentToday = 0; }

  const remaining = Math.max(0, cfg.dailyCap - cfg.sentToday);
  if (remaining <= 0) {
    cfg.lastRunAt = new Date().toISOString();
    await saveEmailConfig(cfg);
    return { sent: 0, failed: 0, followUps: 0, remainingToday: 0, targeted: 0, errors: ['بلغ الحدّ اليومي'] };
  }
  const take = Math.min(cfg.batchSize, remaining);

  // فلاتر مشتركة اختيارية
  const base: Record<string, unknown> = { email: { not: null } };
  if (cfg.source) base.source = cfg.source;
  if (cfg.countryCode) base.countryCode = cfg.countryCode;

  const targets: Target[] = [];

  // 1) متابعات مستحقّة (لمسة 2 أو 3): سبقت مراسلتهم، مضى gapDays، لم يلغوا ولم ينقروا
  const touches = Math.max(1, Math.min(3, cfg.touches));
  if (touches > 1) {
    const cutoff = new Date(Date.now() - Math.max(1, cfg.gapDays) * 86400000);
    const candidates = await prisma.lead.findMany({
      where: {
        ...base,
        stage: cfg.stage ? cfg.stage : { in: ['NEW', 'CONTACTED'] },
        lastContactedAt: { lte: cutoff },
        activities: { some: { type: 'EMAIL' }, none: { type: { in: ['UNSUB', 'CLICK'] } } },
      },
      include: { activities: { where: { type: 'EMAIL' }, select: { id: true } } },
      orderBy: { lastContactedAt: 'asc' },
      take: take * 2, // هامش لأن بعضهم أكمل سلسلته
    });
    for (const l of candidates) {
      const touch = l.activities.length + 1;
      if (touch > touches) continue; // أكمل السلسلة
      if (!l.email || !l.email.includes('@')) continue;
      targets.push({ id: l.id, name: l.name, email: l.email, city: l.city, country: l.country, countryCode: l.countryCode, stage: l.stage, touch });
      if (targets.length >= take) break;
    }
  }

  // 2) لمسات أولى: من لم يُراسَل قط (ولم يُلغِ)
  if (targets.length < take) {
    const freshWhere: Record<string, unknown> = {
      ...base,
      activities: { none: { type: { in: ['EMAIL', 'UNSUB'] } } },
    };
    if (cfg.stage) freshWhere.stage = cfg.stage;
    const fresh = await prisma.lead.findMany({ where: freshWhere, take: take - targets.length });
    for (const l of fresh) {
      if (!l.email || !l.email.includes('@')) continue;
      targets.push({ id: l.id, name: l.name, email: l.email, city: l.city, country: l.country, countryCode: l.countryCode, stage: l.stage, touch: 1 });
    }
  }

  let sent = 0;
  let failed = 0;
  let followUps = 0;
  const errors: string[] = [];
  for (const t of targets) {
    const tpl = touchTemplate(t.touch, cfg);
    const subject = personalize(tpl.subject, t);
    const html = marketingHtml(tpl.body, t, { leadId: t.id, touch: t.touch });
    try {
      await sendMarketingEmail({ subject, html, to: t.email });
      sent++;
      if (t.touch > 1) { followUps++; cfg.totalFollowUps++; }
      cfg.sentToday++;
      cfg.totalSent++;
      await prisma.lead.update({
        where: { id: t.id },
        data: { lastContactedAt: new Date(), stage: t.stage === 'NEW' ? 'CONTACTED' : t.stage },
      });
      await prisma.leadActivity.create({
        data: { leadId: t.id, type: 'EMAIL', content: `بريد تلقائي (لمسة ${t.touch}/${cfg.touches}): ${subject}`, createdBy: 'auto-email' },
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

  return { sent, failed, followUps, remainingToday: Math.max(0, cfg.dailyCap - cfg.sentToday), targeted: targets.length, errors };
}
