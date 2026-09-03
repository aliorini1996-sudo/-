import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { sendMail } from './mailer';
import { recordPresenceSnapshot } from './presence';
import { flushRequestCounts, pruneRequestStats } from './requestCounter';
import { financeSnapshot, quarterFinance, staleDaysOf, EXPENSE_STALE_DAYS } from './finance';
import { backfillInvoices, invoicingReady } from './platformInvoice';

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
      isActive: true, plan: true, createdAt: true, subscriptionEndsAt: true,
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
      <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">${AR_NUM(c.daysOpen)} يوما</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">${c.daysToDeadline !== null ? (c.daysToDeadline >= 0 ? `تبقى ${AR_NUM(c.daysToDeadline)} يوما` : `فاتت منذ ${AR_NUM(-c.daysToDeadline)} يوما`) : (c.severity ?? '—')}</td>
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
  const html = `<div dir="rtl" style="font-family:Segoe UI,Tahoma,sans-serif;line-height:0;color:#1F2823">
    <h2 style="color:#14614E">تذكير يومي بطاقات قرار تجاوزت مهلتها</h2>
    <p>${AR_NUM(urgent.length)} بطاقة تحتاج حسمك القاعدة نعم / لا / أجل <b>بتاريخ</b> لا تأجيل بلا تاريخ </p>
    ${cardsTableHtml(urgent)}
    <p style="color:#5A665E;font-size:13px;margin-top:14px">المصدر ops/decision-cards.json أغلق البطاقة بنقل معرفها إلى closed مع التاريخ أو اطلب ذلك من الوكيل هذا التذكير يرسل يوميا 8 صباحا ما دامت بطاقة متأخرة </p>
  </div>`;
  return sendMail({ subject: `⏰ ${AR_NUM(urgent.length)} بطاقة قرار متأخرة Field Sales`, html });
}


/**
 * ملخّص الجذب لآخر ٧ أيام — من جدول الزيارات الذي يمتلئ آلياً ولا يقرؤه أحد.
 *
 * وجدت الدراسة أن حلقة القياس مقطوعة: كل شيء يُجمَع (القناة، محرّك الذكاء،
 * نقرات واتساب، نوع المحتوى) والمالك يستخرجه **يدوياً** حين يتذكّر — ٤٥ دقيقة
 * شهرياً لقراءة ما تعرفه القاعدة أصلاً. هذا يصل به التقريرَ الأسبوعي القائم.
 */
async function growthSummary(): Promise<string> {
  try {
    const since = new Date(Date.now() - 7 * 864e5);
    const prevSince = new Date(Date.now() - 14 * 864e5);
    const base = { createdAt: { gte: since }, isBot: false } as const;

    const [visits, prevVisits, uniques, byChannel, ai, waClicks, topPaths, signups] = await Promise.all([
      prisma.visit.count({ where: { ...base, waClicked: { not: true } } }),
      prisma.visit.count({ where: { createdAt: { gte: prevSince, lt: since }, isBot: false, waClicked: { not: true } } }),
      prisma.visit.findMany({ where: base, distinct: ['anonId'], select: { anonId: true } }),
      prisma.visit.groupBy({ by: ['channel'], where: { ...base, waClicked: { not: true } }, _count: { _all: true } }),
      prisma.visit.count({ where: { ...base, channel: 'ai_generative' } }),
      prisma.visit.count({ where: { ...base, waClicked: true } }),
      prisma.visit.groupBy({ by: ['path'], where: { ...base, waClicked: { not: true } }, _count: { _all: true }, orderBy: { _count: { path: 'desc' } }, take: 5 }),
      prisma.tenant.count({ where: { createdAt: { gte: since } } }),
    ]);

    const delta = prevVisits > 0 ? Math.round(((visits - prevVisits) / prevVisits) * 100) : null;
    const chan = byChannel
      .filter(c => c.channel)
      .sort((a, b) => b._count._all - a._count._all)
      .map(c => `${c.channel}: ${AR_NUM(c._count._all)}`)
      .join(' · ') || '—';

    return `<h3>الجذب آخر ٧ أيام من جدول الزيارات </h3>
    <ul>
      <li>زيارات <b>${AR_NUM(visits)}</b>${delta !== null ? ` (${delta >= 0 ? '+' : ''}${AR_NUM(delta)}% عن الأسبوع السابق)` : ''} من <b>${AR_NUM(uniques.length)}</b> زائر فريد</li>
      <li>القنوات ${chan}</li>
      <li>من محركات الذكاء الاصطناعي <b>${AR_NUM(ai)}</b> · نقرات واتساب <b>${AR_NUM(waClicks)}</b> · تسجيلات جديدة <b>${AR_NUM(signups)}</b></li>
      <li>أكثر الصفحات ${topPaths.map(t => `${t.path} (${AR_NUM(t._count._all)})`).join(' · ') || '—'}</li>
    </ul>`;
  } catch (e) {
    // التقرير لا يسقط لغياب قسم منه — قسم فارغ خير من بريد لا يصل
    console.error('growthSummary error:', (e as Error).message);
    return '';
  }
}

export async function sendWeeklyReport(): Promise<boolean> {
  const m = await platformMetrics();
  const growth = await growthSummary();
  const statuses = cardStatuses();
  const overdue = statuses.filter(c => c.overdue);
  const oldest = statuses[0];
  const html = `<div dir="rtl" style="font-family:Segoe UI,Tahoma,sans-serif;line-height:0;color:#1F2823">
    <h2 style="color:#14614E">التقرير الأسبوعي Field Sales</h2>
    <h3>الاشتراكات والإيراد من جدول الشركات </h3>
    <ul>
      <li>الشركات النشطة اشتراك سار <b>${AR_NUM(m.activeNotExpired)}</b> من أصل ${AR_NUM(m.totalTenants)} مسجلة</li>
      <li>MRR تقديري وفق أسعار الباقات المعتمدة <b>${AR_NUM(m.mrrEstimate)} ر.س</b>${m.unpricedPlans ? ` (+${AR_NUM(m.unpricedPlans)} شركة بباقة بلا سعر معتمد)` : ''} <i>يشمل التجارب النشطة ولا يعكس تحصيلا فعليا</i></li>
      <li>توزيع الباقات ${Object.entries(m.byPlan).map(([p, n]) => `${p}: ${AR_NUM(n)}`).join(' · ') || '—'}</li>
      <li>اشتراكات انتهت خلال 30 يوما إشارة انسحاب <b>${AR_NUM(m.expired30d)}</b> تنتهي خلال 7 أيام <b>${AR_NUM(m.expiring7d)}</b></li>
      <li>شركات جديدة آخر 30 يوما <b>${AR_NUM(m.new30d)}</b> بلغت التفعيل أول فاتورة <b>${AR_NUM(m.activated)}</b></li>
    </ul>
    ${growth}
    <h3>فجوة التنفيذ مؤشرات الخطة </h3>
    <ul>
      <li>بطاقات مفتوحة <b>${AR_NUM(statuses.length)}</b> متأخرة عن مهلتها <b style="color${overdue.length ? '#9B3B2E' : '#14614E'}">${AR_NUM(overdue.length)}</b></li>
      <li>أقدم بطاقة ${oldest ? `«${oldest.title}» — ${AR_NUM(oldest.daysOpen)} يوما الهدف ≤ 7` : '—'}</li>
    </ul>
    ${statuses.length ? cardsTableHtml(statuses) : ''}
    <p style="color:#5A665E;font-size:13px;margin-top:14px">تقرير آلي أسبوعي الاثنين 8 صباحا بتوقيت الرياض يغلق البند T1.4 2 لإرساله يدويا POST /api/tenants/ops/weekly-report من لوحة المالك </p>
  </div>`;
  return sendMail({ subject: `📊 التقرير الأسبوعي Field Sales (${riyadhDateStr()})`, html });
}

// ————— التقرير المالي الشهري —————

const SAR = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;

/**
 * تقرير مالي يصل المالك أول كل شهر عن الشهر المنقضي.
 *
 * غايته أن يُرى الرقم دون فتح اللوحة: المالك الذي لا يفتحها لا يكتشف أن مصروفاً
 * تقادم أو أن الإيراد توقّف إلا بعد شهور. ويحمل التقرير **الإقرار الربعي** في
 * أشهر إقفال الأرباع كي لا يُجمع بيد.
 */
export async function sendMonthlyFinanceReport(): Promise<boolean> {
  const snap = await financeSnapshot();
  const prev = snap.months[snap.months.length - 2] ?? snap.current;
  const stale = await prisma.operatingExpense.findMany({
    where: { isRecurring: true, OR: [{ endsOn: null }, { endsOn: { gt: new Date() } }] },
    select: { label: true, amountSar: true, reviewedAt: true },
  });
  const staleRows = stale.filter((e) => staleDaysOf(e.reviewedAt) >= EXPENSE_STALE_DAYS);

  // الربع يُقفل في يناير/أبريل/يوليو/أكتوبر عن الربع المنقضي
  const nowR = riyadhNow();
  const mo = nowR.getUTCMonth() + 1;
  let quarterHtml = '';
  if ([1, 4, 7, 10].includes(mo)) {
    const qYear = mo === 1 ? nowR.getUTCFullYear() - 1 : nowR.getUTCFullYear();
    const q = mo === 1 ? 4 : (mo - 1) / 3;
    const qf = await quarterFinance(qYear, q);
    quarterHtml = `<div style="background:#FBEBE2;border:1px solid #E9C9B8;border-radius:12px;padding:14px;margin-top:16px">
      <h3 style="margin:0 0 6px">إقرار الربع ${q} — ${qf.periodLabel}</h3>
      <p style="margin:0">ضريبة مخرجات <b>${SAR(qf.vatCollectedSar)}</b> · مدخلات <b>${SAR(qf.vatPaidSar)}</b>
      ⇐ <b style="color:#B8431F">المستحقّ للهيئة ${SAR(qf.vatDueSar)}</b></p>
      <p style="margin:6px 0 0;font-size:13px;color:#6E6557">إيراد الربع ${SAR(qf.revenueSar)} · مصروفه ${SAR(qf.expensesSar)} · ربحه ${SAR(qf.profitSar)}</p>
    </div>`;
  }

  const html = mailLayoutFinance(`الصورة المالية — ${prev.month}/${prev.year}`, `
    <ul style="line-height:1.9;padding-inline-start:18px">
      <li>محصّل الشهر <b>${SAR(prev.revenueSar)}</b> من ${AR_NUM(prev.paidCount)} عملية دفع</li>
      <li>الإيراد الشهري المتكرّر <b>${SAR(snap.mrrSar)}</b> — ${snap.mrrBasis}</li>
      <li>مصروفات الشهر <b>${SAR(prev.expensesSar)}</b> · عمولة البوابة ${SAR(prev.gatewayFeeSar)}</li>
      <li>صافي الربح <b style="color:${prev.profitSar >= 0 ? '#14614E' : '#9B3B2E'}">${SAR(prev.profitSar)}</b> · هامش ${prev.marginPct}%</li>
      <li>المستحقّ للهيئة عن الشهر <b>${SAR(prev.vatDueSar)}</b></li>
      <li>الشركات الفعّالة ${AR_NUM(snap.totalTenants)} — باشتراك مدفوع ${AR_NUM(snap.payingTenants)}</li>
    </ul>
    ${staleRows.length ? `<div style="background:#FEF6E7;border:1px solid #F0DCB4;border-radius:12px;padding:12px">
      <b style="color:#8A6412">⚠️ ${AR_NUM(staleRows.length)} مصروف متكرّر لم يُراجَع منذ ${AR_NUM(EXPENSE_STALE_DAYS)} يوماً</b>
      <p style="margin:6px 0 0;font-size:13px">${staleRows.map((e) => `${e.label} (${SAR(e.amountSar)})`).join(' · ')}</p>
      <p style="margin:6px 0 0;font-size:12px;color:#6E6557">راجع فاتورة المورّد: مبلغٌ قديم يُحتسب صامتاً ويبدو صحيحاً.</p>
    </div>` : ''}
    ${invoicingReady() ? '' : `<p style="color:#9B3B2E;font-size:13px">🔴 لا تُصدَر فواتير ضريبية لمشتركيك — <b>PLATFORM_VAT_NUMBER</b> غير مضبوط في بيئة الخادم.</p>`}
    ${quarterHtml}
  `);
  return sendMail({ subject: `💰 الصورة المالية — ${prev.month}/${prev.year}`, html });
}

function mailLayoutFinance(title: string, body: string): string {
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">FieldSales — ${title}</div>
      <div style="padding:18px 22px;color:#1F1A13;font-size:14px">${body}</div>
    </div>
  </div>`;
}

// ————— الجدولة —————
// فحص كل ساعة بتوقيت الرياض (UTC+3): التذكير يومياً 8ص عند وجود متأخر، والتقرير كل اثنين 8ص.
// dedupe في الذاكرة — إعادة تشغيل الخادم داخل ساعة الثامنة قد تكرّر رسالة نادرة، وهذا مقبول.

/**
 * علامة «أُرسل» معمّرة في القاعدة — كانت متغيّرات ذاكرة تموت مع كل نشر:
 * نشرةٌ داخل ساعة الثامنة كانت تُسقط تقرير الشهر بلا تعويض ولا إنذار
 * (وموعد الكسر الأول كان ١ سبتمبر). الإنشاء الفريد هو القفل نفسه: محاولتان
 * متزامنتان (النبضة الداخلية + شبكة الأمان الخارجية) تكسب إحداهما ويصمت
 * الآخر بتعارض المفتاح — فلا بريد مزدوج.
 */
async function claimMarker(key: string): Promise<boolean> {
  try {
    await prisma.opsMarker.create({ data: { key } });
    return true;
  } catch {
    return false; // قائمة سلفاً أو تعذّرت الكتابة — لا نكرّر البريد على الشكّ
  }
}

/**
 * يضمن تقارير اليوم: يُرسل ما لم يُرسَل بعد ويُرجع ما فعله.
 * تناديه النبضة الداخلية كل ساعة، **و**شبكة أمان خارجية (health.yml ٨:١٥ص
 * الرياض) — فموت العملية أو نشرها في ساعة الثامنة لم يعد يُسقط شيئاً.
 */
export async function ensureScheduledReports(): Promise<{ daily: boolean; weekly: boolean; monthly: boolean }> {
  const now = riyadhNow();
  const dateStr = now.toISOString().slice(0, 10);
  const out = { daily: false, weekly: false, monthly: false };

  if (now.getUTCDay() === 1 && await claimMarker(`weekly:${dateStr}`)) {
    await sendWeeklyReport();
    out.weekly = true;
  }
  if (await claimMarker(`daily:${dateStr}`)) {
    await sendDailyReminder();
    out.daily = true;
  }
  // أول كل شهر: الصورة المالية عن الشهر المنقضي (ومعها الإقرار الربعي عند إقفاله)
  if (now.getUTCDate() === 1 && await claimMarker(`monthly:${dateStr.slice(0, 7)}`)) {
    await sendMonthlyFinanceReport();
    out.monthly = true;
    // وشبكة أمان الفواتير: ما فات إصداره لحظياً يُلتقط هنا
    await backfillInvoices(50).catch((e) => console.error('invoice backfill error:', e));
  }
  return out;
}

async function tick() {
  try {
    // النبضة الداخلية تكتفي بساعة الثامنة؛ وشبكة الأمان الخارجية تنادي
    // ensureScheduledReports مباشرةً فتلتقط ما أسقطه نشرٌ أو موتُ عملية
    if (riyadhNow().getUTCHours() === 8) {
      await ensureScheduledReports();
    }
  } catch (e) {
    console.error('opsSchedule tick error:', e);
  }
}

// لقطة حضور دوريّة لمؤشّر «الزيارات الحية» الزمنيّ — كل ٥ دقائق (بمحاذاة نافذة
// «متصل الآن»). النسخة الواحدة من dsd-backend تجعل مسجّلاً واحداً كافياً؛ ولو
// تعدّدت النسخ يوماً فالتجميع بالذروة يبتلع التكرار.
const PRESENCE_SNAPSHOT_MS = 5 * 60 * 1000;
const REQUEST_FLUSH_MS = 60 * 1000;

export function startOpsScheduler() {
  setInterval(tick, 3600000);

  // لقطة فور الإقلاع كي لا تبقى فجوة بطول فترة الجدولة بعد كل نشر, ثم دورياً.
  recordPresenceSnapshot().catch(e => console.error('presence snapshot (startup) error:', e));
  setInterval(() => {
    recordPresenceSnapshot().catch(e => console.error('presence snapshot error:', e));
  }, PRESENCE_SNAPSHOT_MS);

  // إفراغ عدّاد الطلبات المتراكم في الذاكرة إلى القاعدة كل دقيقة (+ تقليم عند الإقلاع).
  // لا نضيف معالج SIGTERM للإفراغ الأخير عمداً: إضافة مستمع لـSIGTERM في Node تُلغي
  // الإنهاء الافتراضيّ، فيعلّق إيقافَ الخادم عند كل نشر. فقدُ ما دون دقيقة من العدّ
  // عند النشر مقبولٌ لمقياس استهلاكٍ تراكميّ.
  pruneRequestStats().catch(e => console.error('request stats prune error:', e));
  setInterval(() => {
    flushRequestCounts().catch(e => console.error('request flush error:', e));
  }, REQUEST_FLUSH_MS);

  console.log('🗓️ Ops scheduler started (reminders 8am Riyadh · monthly finance report 1st 8am · presence snapshot 5min · request flush 1min)');
}
