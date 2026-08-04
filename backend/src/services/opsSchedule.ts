import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { sendMail } from './mailer';

// خط تشغيل المالك: تذكير يومي ببطاقات القرار المتأخرة + تقرير أسبوعي (T1.4.2).
// المصدر الوحيد للبطاقات: ops/decision-cards.json (يُحدَّث مع كل إغلاق/فتح بطاقة).
// الإرسال عبر mailer القائم (Resend) إلى MAIL_TO — لا أسرار جديدة ولا قنوات عامة.

export interface DecisionCard {
  id: string;
  title: string;
  opened: string; // ISO date
  deadline?: string; // ISO date — بطاقات المهلة التقويمية
  slaDays?: number;
  severity?: string;
  note?: string;
}

interface CardsFile { slaDaysDefault?: number; cards?: DecisionCard[]; closed?: unknown[] }

const DAY = 86400000;
const RIYADH_OFFSET_MS = 3 * 3600000; // UTC+3 ثابتة (لا توقيت صيفياً في السعودية)

function riyadhNow(): Date { return new Date(Date.now() + RIYADH_OFFSET_MS); }
const riyadhDateStr = () => riyadhNow().toISOString().slice(0, 10);

export function loadCards(): { cards: DecisionCard[]; slaDefault: number } {
  try {
    const p = path.resolve(process.cwd(), 'ops/decision-cards.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as CardsFile;
    return { cards: parsed.cards ?? [], slaDefault: parsed.slaDaysDefault ?? 7 };
  } catch {
    return { cards: [], slaDefault: 7 };
  }
}

export interface CardStatus extends DecisionCard {
  daysOpen: number;
  overdue: boolean;
  daysToDeadline: number | null;
}

export function cardStatuses(): CardStatus[] {
  const { cards, slaDefault } = loadCards();
  const now = Date.now();
  return cards
    .map(c => {
      const daysOpen = Math.max(0, Math.floor((now - new Date(c.opened).getTime()) / DAY));
      const sla = c.slaDays ?? slaDefault;
      const daysToDeadline = c.deadline
        ? Math.ceil((new Date(c.deadline).getTime() - now) / DAY)
        : null;
      return { ...c, daysOpen, overdue: daysOpen > sla, daysToDeadline };
    })
    .sort((a, b) => b.daysOpen - a.daysOpen);
}

// ————— مقاييس المنصّة (عدّاد MRR/الاشتراكات من جدول Tenant القائم) —————

const PLAN_PRICES: Record<string, number> = { basic: 299, pro: 599 };

export async function platformMetrics() {
  const tenants = await prisma.tenant.findMany({
    select: {
      isActive: true, plan: true, vertical: true, createdAt: true, subscriptionEndsAt: true,
      _count: { select: { invoices: true } },
    },
  });
  const now = Date.now();
  const active = tenants.filter(t => t.isActive);
  const notExpired = active.filter(t => !t.subscriptionEndsAt || t.subscriptionEndsAt.getTime() >= now);
  const byPlan: Record<string, number> = {};
  let mrr = 0; let unpriced = 0;
  for (const t of notExpired) {
    byPlan[t.plan] = (byPlan[t.plan] ?? 0) + 1;
    const price = PLAN_PRICES[t.plan];
    if (price) mrr += price; else unpriced++;
  }
  const expired30d = tenants.filter(t => t.subscriptionEndsAt
    && t.subscriptionEndsAt.getTime() < now
    && t.subscriptionEndsAt.getTime() > now - 30 * DAY).length;
  const expiring7d = notExpired.filter(t => t.subscriptionEndsAt
    && t.subscriptionEndsAt.getTime() < now + 7 * DAY).length;
  const new30d = tenants.filter(t => t.createdAt.getTime() > now - 30 * DAY).length;
  const activated = tenants.filter(t => (t._count?.invoices ?? 0) > 0).length;
  return {
    totalTenants: tenants.length,
    activeTenants: active.length,
    activeNotExpired: notExpired.length,
    byPlan,
    // تقدير نظري: عدد الشركات النشطة غير المنتهية × سعر الباقة المعتمد (299/599).
    // يشمل التجارب النشطة ولا يعكس تحصيلاً فعلياً — دقّته تكتمل عند وجود سجل دفع.
    mrrEstimate: mrr,
    unpricedPlans: unpriced,
    expired30d,
    expiring7d,
    new30d,
    activated,
  };
}

// ————— بناء الرسائل —————

const AR_NUM = (n: number) => n.toLocaleString('ar-EG');

function cardsTableHtml(list: CardStatus[]): string {
  const rows = list.map(c => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${c.title}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">${AR_NUM(c.daysOpen)} يوماً</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">${c.daysToDeadline !== null ? (c.daysToDeadline >= 0 ? `تبقّى ${AR_NUM(c.daysToDeadline)} يوماً` : `فاتت منذ ${AR_NUM(-c.daysToDeadline)} يوماً`) : (c.severity ?? '—')}</td>
    </tr>`).join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:14px" dir="rtl">
    <tr><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #14614E">البطاقة</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #14614E">عمرها</th><th style="text-align:right;padding:6px 10px;border-bottom:2px solid #14614E">المهلة/الدرجة</th></tr>
    ${rows}</table>`;
}

export async function sendDailyReminder(): Promise<boolean> {
  const statuses = cardStatuses();
  const overdue = statuses.filter(c => c.overdue);
  const nearDeadline = statuses.filter(c => c.daysToDeadline !== null && c.daysToDeadline <= 7);
  const urgent = [...new Map([...overdue, ...nearDeadline].map(c => [c.id, c])).values()];
  if (!urgent.length) return false;
  const html = `<div dir="rtl" style="font-family:Segoe UI,Tahoma,sans-serif;line-height:1.9;color:#1F2823">
    <h2 style="color:#14614E">تذكير يومي — بطاقات قرار تجاوزت مهلتها</h2>
    <p>${AR_NUM(urgent.length)} بطاقة تحتاج حسمك (القاعدة: نعم / لا / أجّل <b>بتاريخ</b> — لا تأجيل بلا تاريخ):</p>
    ${cardsTableHtml(urgent)}
    <p style="color:#5A665E;font-size:13px;margin-top:14px">المصدر: ops/decision-cards.json — أغلق البطاقة بنقل معرّفها إلى closed مع التاريخ (أو اطلب ذلك من الوكيل). هذا التذكير يُرسل يومياً 8 صباحاً ما دامت بطاقة متأخرة.</p>
  </div>`;
  return sendMail({ subject: `⏰ ${AR_NUM(urgent.length)} بطاقة قرار متأخرة — Field Sales`, html });
}

export async function sendWeeklyReport(): Promise<boolean> {
  const m = await platformMetrics();
  const statuses = cardStatuses();
  const overdue = statuses.filter(c => c.overdue);
  const oldest = statuses[0];
  const html = `<div dir="rtl" style="font-family:Segoe UI,Tahoma,sans-serif;line-height:1.9;color:#1F2823">
    <h2 style="color:#14614E">التقرير الأسبوعي — Field Sales</h2>
    <h3>الاشتراكات والإيراد (من جدول الشركات)</h3>
    <ul>
      <li>الشركات النشطة (اشتراك سارٍ): <b>${AR_NUM(m.activeNotExpired)}</b> من أصل ${AR_NUM(m.totalTenants)} مسجّلة</li>
      <li>MRR تقديري وفق أسعار الباقات المعتمدة: <b>${AR_NUM(m.mrrEstimate)} ر.س</b>${m.unpricedPlans ? ` (+${AR_NUM(m.unpricedPlans)} شركة بباقة بلا سعر معتمد)` : ''} — <i>يشمل التجارب النشطة ولا يعكس تحصيلاً فعلياً</i></li>
      <li>توزيع الباقات: ${Object.entries(m.byPlan).map(([p, n]) => `${p}: ${AR_NUM(n)}`).join(' · ') || '—'}</li>
      <li>اشتراكات انتهت خلال 30 يوماً (إشارة انسحاب): <b>${AR_NUM(m.expired30d)}</b> · تنتهي خلال 7 أيام: <b>${AR_NUM(m.expiring7d)}</b></li>
      <li>شركات جديدة آخر 30 يوماً: <b>${AR_NUM(m.new30d)}</b> · بلغت التفعيل (أول فاتورة): <b>${AR_NUM(m.activated)}</b></li>
    </ul>
    <h3>فجوة التنفيذ (مؤشرات الخطة)</h3>
    <ul>
      <li>بطاقات مفتوحة: <b>${AR_NUM(statuses.length)}</b> · متأخرة عن مهلتها: <b style="color:${overdue.length ? '#9B3B2E' : '#14614E'}">${AR_NUM(overdue.length)}</b></li>
      <li>أقدم بطاقة: ${oldest ? `«${oldest.title}» — ${AR_NUM(oldest.daysOpen)} يوماً (الهدف ≤ 7)` : '—'}</li>
    </ul>
    ${statuses.length ? cardsTableHtml(statuses) : ''}
    <p style="color:#5A665E;font-size:13px;margin-top:14px">تقرير آلي أسبوعي (الاثنين 8 صباحاً بتوقيت الرياض) — يغلق البند T1.4.2. لإرساله يدوياً: POST /api/tenants/ops/weekly-report من لوحة المالك.</p>
  </div>`;
  return sendMail({ subject: `📊 التقرير الأسبوعي — Field Sales (${riyadhDateStr()})`, html });
}

// ————— الجدولة —————
// فحص كل ساعة بتوقيت الرياض (UTC+3): التذكير يومياً 8ص عند وجود متأخر، والتقرير كل اثنين 8ص.
// dedupe في الذاكرة — إعادة تشغيل الخادم داخل ساعة الثامنة قد تكرّر رسالة نادرة، وهذا مقبول.

let lastDaily = '';
let lastWeekly = '';

async function tick() {
  try {
    const now = riyadhNow();
    const dateStr = now.toISOString().slice(0, 10);
    const hour = now.getUTCHours(); // بعد إزاحة الرياض: هذه ساعة الرياض
    if (hour === 8) {
      if (now.getUTCDay() === 1 && lastWeekly !== dateStr) {
        lastWeekly = dateStr;
        await sendWeeklyReport();
      }
      if (lastDaily !== dateStr) {
        lastDaily = dateStr;
        await sendDailyReminder();
      }
    }
  } catch (e) {
    console.error('opsSchedule tick error:', e);
  }
}

export function startOpsScheduler() {
  setInterval(tick, 3600000);
  console.log('🗓️ Ops scheduler started (daily reminder + weekly report, 8am Riyadh)');
}
