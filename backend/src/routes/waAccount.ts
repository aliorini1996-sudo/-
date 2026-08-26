/**
 * منفذ حساب واتساب — الموجة الثانية من أتمتة الدعم (قراءة فقط، محكومة).
 *
 * يجيب سؤالاً واحداً فقط: «ما ملخّص حساب الشركة التي رقم هاتفها المسجّل هو هذا؟»
 * يستدعيه بوت المبيعات (wa-sales-bot) ليخدم العميل المشترك بأسئلة اشتراكه.
 *
 * الحوكمة — سبع طبقات، والمبدأ الحاكم: «النموذج لا يسرّب ما لا يراه»:
 *  1) الهوية لا تُدّعى: البوت يمرّر رقم واتساب المرسِل الموثّق من توقيع ميتا،
 *     لا أي اسم أو ادّعاء كتبه العميل. الربط = تطابق الرقم مع هاتف الشركة
 *     المسجّل في «إعدادات الشركة» (تضبطه الشركة بنفسها).
 *  2) عزل حتمي: الاستعلام يُبنى هنا بالكود من الرقم فقط؛ الذكاء الاصطناعي
 *     لا يركّب استعلاماً ولا يختار شركة. تطابقان لرقم واحد؟ لا نخمّن — نرفض.
 *  3) تقليل البيانات: ستة حقول فقط (اسم الشركة، الحالة، الباقة، تاريخ الانتهاء,
 *     عدد المناديب، حدّهم). لا فواتير ولا مبالغ ولا عملاء ولا أرصدة.
 *  4) قناة خادم-لخادم: مفتاح X-Account-Key يُقارن timing-safe.
 *  5) مطفأ افتراضياً: بلا WA_ACCOUNT_ENABLED=1 يرجع 404 كأن المنفذ لا وجود له.
 *  6) تدقيق وسقف: كل استعلام يُسجَّل (رقم مُقنَّع + نتيجة)، وحدّ 60 استعلاماً
 *     بالساعة لكل رقم يمنع أي مسح.
 *  7) البوت من جهته لا يذكر معلومة حساب إلا من كتلة محقونة من هنا — قاعدة
 *     صارمة في شخصيته يحرسها اختبار.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import prisma from '../config/database';
import { createInvoice, moyasarConfigured } from '../services/moyasar';

const router = Router();

const enabled = () => (process.env.WA_ACCOUNT_ENABLED || '').trim() === '1';
const bridgeKey = () => (process.env.WA_ACCOUNT_KEY || '').trim();

function keyOk(candidate: string | undefined): boolean {
  const k = bridgeKey();
  if (!k || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(k);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** أرقام فقط، وتوحيد الصيغ المحلية الخليجية الشائعة إلى الدولية (05x ⇒ 9665x) */
export function normalizePhone(v: string | null | undefined): string {
  let d = String(v || '').replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('05')) d = '966' + d.slice(1); // سعودي محلي
  if (d.length === 9 && d.startsWith('5')) d = '966' + d;            // بلا صفر
  return d;
}

// سقف معدّل بالذاكرة: 60/ساعة لكل رقم — يكفي محادثة نشطة ويمنع المسح
const hits = new Map<string, { n: number; windowStart: number }>();
function overLimit(phone: string): boolean {
  const now = Date.now();
  const h = hits.get(phone);
  if (!h || now - h.windowStart > 3600_000) { hits.set(phone, { n: 1, windowStart: now }); return false; }
  h.n += 1;
  return h.n > 60;
}

router.get('/lookup', async (req: Request, res: Response) => {
  // مطفأ = غير موجود (لا نكشف حتى وجود الميزة)
  if (!enabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }

  const phone = normalizePhone(String(req.query.phone || ''));
  if (phone.length < 9) { res.json({ success: true, data: { linked: false } }); return; }
  if (overLimit(phone)) { res.status(429).json({ success: false }); return; }

  const masked = phone.slice(0, 5) + '****' + phone.slice(-3);
  try {
    // الشركات قليلة والهواتف تُخزَّن بصيغ حرّة ⇒ نجلب الهواتف المسجّلة كلها
    // ونطبّع في الذاكرة. عند نموّ المنصّة لألوف الشركات يصير عموداً مطبَّعاً مفهرساً.
    const rows = await prisma.companySettings.findMany({
      where: { phone: { not: null } },
      select: { tenantId: true, phone: true },
    });
    const matches = rows.filter((r) => normalizePhone(r.phone) === phone);

    if (matches.length !== 1) {
      // صفر = غير مربوط؛ أكثر من واحد = غموض ⇒ لا نخمّن هوية (طبقة 2)
      if (matches.length > 1) console.warn(`[wa-account] غموض: ${masked} يطابق ${matches.length} شركات — رُفض`);
      else console.log(`[wa-account] ${masked} غير مربوط`);
      res.json({ success: true, data: { linked: false } });
      return;
    }

    const t = await prisma.tenant.findUnique({
      where: { id: matches[0].tenantId },
      select: { name: true, isActive: true, plan: true, subscriptionEndsAt: true, maxSalesReps: true },
    });
    if (!t) { res.json({ success: true, data: { linked: false } }); return; }

    const repsUsed = await prisma.salesRep.count({ where: { tenantId: matches[0].tenantId, isActive: true } });
    const now = new Date();
    const status = !t.isActive ? 'suspended'
      : t.subscriptionEndsAt && t.subscriptionEndsAt < now ? 'expired'
      : 'active';

    console.log(`[wa-account] ${masked} ⇒ «${t.name}» (${status})`);
    res.json({
      success: true,
      data: {
        linked: true,
        companyName: t.name,
        status,                                                    // active | suspended | expired
        plan: t.plan,                                              // basic | pro | enterprise
        subscriptionEndsAt: t.subscriptionEndsAt?.toISOString().slice(0, 10) ?? null,
        repsUsed,
        repsLimit: t.maxSalesReps,                                 // null = غير محدود
      },
    });
  } catch (e) {
    console.error('[wa-account] خطأ:', e);
    res.status(500).json({ success: false });
  }
});


// ═══════════════════ الموجة ٣: إجراءات محدودة بإذن المالك ═══════════════════
//
// مفتاح منفصل عن القراءة: WA_ACTION_ENABLED. إطفاؤه يُبقي القراءة عاملةً ويوقف
// كل فعل — فصلٌ مقصود، لأن سقف ضرر «يقرأ» غير سقف ضرر «يفعل».
//
// الخادم لا يثق بالبوت في تحديد الشركة: يستقبل رقم الهاتف الموثّق ويعيد استخراج
// المستأجر بنفسه. فلو اختُرق البوت لم يستطع أن يفعل شيئاً لشركة غير شركة الرقم.
// والمندوب المستهدف يُتحقَّق أنه يتبع المستأجر نفسه قبل أي تعديل.

const actionsEnabled = () => (process.env.WA_ACTION_ENABLED || '').trim() === '1';

/** يستخرج المستأجر من رقم موثّق — أو null. نفس منطق القراءة، مركزياً. */
async function tenantByPhone(phone: string): Promise<string | null> {
  const rows = await prisma.companySettings.findMany({
    where: { phone: { not: null } },
    select: { tenantId: true, phone: true },
  });
  const m = rows.filter((r) => normalizePhone(r.phone) === phone);
  return m.length === 1 ? m[0].tenantId : null;   // غموض ⇒ رفض
}

/** قائمة مناديب الشركة — للبوت كي يعرّف المندوب المقصود قبل طلب الإذن */
router.get('/reps', async (req: Request, res: Response) => {
  if (!enabled() || !actionsEnabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }
  const phone = normalizePhone(String(req.query.phone || ''));
  if (phone.length < 9 || overLimit(phone)) { res.status(phone.length < 9 ? 200 : 429).json({ success: true, data: { reps: [] } }); return; }
  try {
    const tid = await tenantByPhone(phone);
    if (!tid) { res.json({ success: true, data: { reps: [] } }); return; }
    const reps = await prisma.salesRep.findMany({
      where: { tenantId: tid },
      select: { id: true, name: true, username: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: { reps } });
  } catch (e) {
    console.error('[wa-account] reps خطأ:', e);
    res.status(500).json({ success: false });
  }
});

/** كلمة مرور مؤقّتة قوية وسهلة النطق في واتساب (بلا أحرف ملتبسة) */
function tempPassword(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';       // بلا I و O
  const num = '23456789';                        // بلا 0 و 1
  const pick = (set: string, n: number) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  return pick(abc, 4) + pick(num, 4);            // ٨ خانات — يطابق سياسة الحدّ الأدنى
}

/**
 * تنفيذ إجراء — يُستدعى من البوت **بعد** موافقة المالك الصريحة على واتسابه.
 * قائمة بيضاء بإجراءين فقط، كلاهما قابل للعكس:
 *   reset_rep_password — كلمة مرور مؤقّتة (يمكن إعادتها ثانية)
 *   toggle_rep_active  — تفعيل/إيقاف مندوب (يمكن عكسه)
 */
router.post('/action', async (req: Request, res: Response) => {
  if (!enabled() || !actionsEnabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }
  try {
    const body = z.object({
      phone: z.string().min(9),
      action: z.enum(['reset_rep_password', 'toggle_rep_active']),
      repId: z.string().uuid(),
    }).parse(req.body);

    const phone = normalizePhone(body.phone);
    const tid = await tenantByPhone(phone);
    if (!tid) { res.status(403).json({ success: false, message: 'رقم غير مربوط بشركة' }); return; }

    // المندوب يجب أن يتبع شركة الرقم — الحاجز الذي يمنع أي تسرّب عبر المستأجرين
    const rep = await prisma.salesRep.findFirst({
      where: { id: body.repId, tenantId: tid },
      select: { id: true, name: true, username: true, isActive: true },
    });
    if (!rep) { res.status(403).json({ success: false, message: 'المندوب لا يتبع هذه الشركة' }); return; }

    const masked = phone.slice(0, 5) + '****' + phone.slice(-3);
    if (body.action === 'reset_rep_password') {
      const pwd = tempPassword();
      await prisma.salesRep.update({ where: { id: rep.id }, data: { passwordHash: await bcrypt.hash(pwd, 10) } });
      console.log(`[wa-action] ${masked} ⇒ إعادة تعيين كلمة مرور «${rep.name}» (${rep.username})`);
      res.json({ success: true, data: { action: body.action, repName: rep.name, username: rep.username, tempPassword: pwd } });
      return;
    }

    const next = !rep.isActive;
    await prisma.salesRep.update({ where: { id: rep.id }, data: { isActive: next } });
    console.log(`[wa-action] ${masked} ⇒ ${next ? 'تفعيل' : 'إيقاف'} «${rep.name}»`);
    res.json({ success: true, data: { action: body.action, repName: rep.name, username: rep.username, isActive: next } });
  } catch (e) {
    console.error('[wa-account] action خطأ:', e);
    res.status(400).json({ success: false });
  }
});


// ═════════════ توسعة: قراءة أوسع · إجراءات إضافية · تجديد بالدفع ═════════════

/**
 * ملخّص تشغيلي موسّع — يجيب أسئلة الدعم الأكثر تكراراً بلا كشف تفاصيل حسّاسة.
 * أعداد ومجاميع فقط: لا أسماء عملاء ولا أرقامهم ولا بنود فواتير.
 */
router.get('/summary', async (req: Request, res: Response) => {
  if (!enabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }
  const phone = normalizePhone(String(req.query.phone || ''));
  if (phone.length < 9) { res.json({ success: true, data: null }); return; }
  if (overLimit(phone)) { res.status(429).json({ success: false }); return; }
  try {
    const tid = await tenantByPhone(phone);
    if (!tid) { res.json({ success: true, data: null }); return; }

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [invCount, invSum, recSum, custCount, overCredit, lastInv] = await Promise.all([
      prisma.invoice.count({ where: { tenantId: tid, createdAt: { gte: monthStart } } }),
      prisma.invoice.aggregate({ where: { tenantId: tid, createdAt: { gte: monthStart } }, _sum: { total: true } }),
      prisma.receipt.aggregate({ where: { tenantId: tid, createdAt: { gte: monthStart } }, _sum: { amount: true } }),
      prisma.customer.count({ where: { tenantId: tid } }),
      prisma.customer.count({ where: { tenantId: tid, creditLimit: { gt: 0 }, balance: { gt: 0 } } }),
      prisma.invoice.findFirst({ where: { tenantId: tid }, orderBy: { createdAt: 'desc' }, select: { number: true, total: true, createdAt: true } }),
    ]);

    res.json({
      success: true,
      data: {
        monthInvoices: invCount,
        monthSalesSar: Number(invSum._sum.total ?? 0),
        monthCollectedSar: Number(recSum._sum.amount ?? 0),
        customers: custCount,
        customersWithBalance: overCredit,
        lastInvoice: lastInv
          ? { number: lastInv.number, totalSar: Number(lastInv.total), date: lastInv.createdAt.toISOString().slice(0, 10) }
          : null,
      },
    });
  } catch (e) {
    console.error('[wa-account] summary خطأ:', e);
    res.status(500).json({ success: false });
  }
});

/**
 * رابط تجديد — يُنشأ **بمبلغ من قائمة بيضاء صلبة** لا من أي رقم يمرّره البوت.
 * سابقة Air Canada تنطبق مضاعفةً على المال: لو تُرك المبلغ للنموذج لألزم الشركة
 * بسعرٍ اخترعه. الخادم يحسب المبلغ من الباقة والمدّة، ويتجاهل أي مبلغ وارد.
 */
const PLAN_MONTHLY_SAR: Record<string, number> = { basic: 299, pro: 599 };

router.post('/renewal-link', async (req: Request, res: Response) => {
  if (!enabled() || !actionsEnabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }
  if (!moyasarConfigured()) { res.status(503).json({ success: false, message: 'بوابة الدفع غير مهيأة' }); return; }
  try {
    const body = z.object({
      phone: z.string().min(9),
      months: z.number().int().min(1).max(12),   // سقف سنة — يمنع مبلغاً ضخماً بالخطأ
    }).parse(req.body);

    const phone = normalizePhone(body.phone);
    const tid = await tenantByPhone(phone);
    if (!tid) { res.status(403).json({ success: false, message: 'رقم غير مربوط بشركة' }); return; }

    const t = await prisma.tenant.findUnique({ where: { id: tid }, select: { name: true, plan: true } });
    if (!t) { res.status(403).json({ success: false }); return; }

    const monthly = PLAN_MONTHLY_SAR[t.plan];
    if (!monthly) {
      // enterprise أو باقة غير قياسية ⇒ لا نخمّن سعراً، يتولّاها المالك
      res.status(409).json({ success: false, message: 'باقة غير قياسية — التجديد يتم عبر صاحب المنصّة' });
      return;
    }

    const amountSar = monthly * body.months;
    const description = `تجديد اشتراك ${t.name} — ${body.months} شهر (${t.plan})`;
    const row = await prisma.paymentLink.create({
      data: { tenantId: tid, description, amountHalalas: Math.round(amountSar * 100), months: body.months },
    });
    const FRONT = (process.env.FRONTEND_URL || 'https://fieldsa.net').replace(/\/$/, '');
    const inv = await createInvoice({
      amountHalalas: row.amountHalalas,
      description,
      successUrl: `${FRONT}/payment/success?ref=${row.id}`,
      backUrl: `${FRONT}/payment/success?ref=${row.id}`,
      metadata: { ref: row.id, tenantId: tid },
    });
    await prisma.paymentLink.update({
      where: { id: row.id },
      data: { moyasarInvoiceId: inv.id, url: inv.url },
    });

    const masked = phone.slice(0, 5) + '****' + phone.slice(-3);
    console.log(`[wa-action] ${masked} ⇒ رابط تجديد ${amountSar} ريال / ${body.months} شهر لـ«${t.name}»`);
    res.json({ success: true, data: { url: inv.url, amountSar, months: body.months, companyName: t.name, plan: t.plan } });
  } catch (e) {
    console.error('[wa-account] renewal خطأ:', e);
    res.status(400).json({ success: false });
  }
});


/**
 * ماسح الأحداث الاستباقية — يُستدعى دورياً من البوت (لا يرسل شيئاً بنفسه).
 *
 * فصلُ الكشف عن الإرسال مقصود: الخادم يعرف البيانات، والبوت يملك قناة واتساب
 * وقوالبها. وهكذا يبقى الخادم بلا أي تبعية لميتا، ويبقى قرار الإرسال (والقالب
 * والحدّ) في مكان واحد.
 *
 * يعيد فقط شركات **لها هاتف مسجَّل** — فبلا قناة لا معنى للحدث.
 */
router.get('/events', async (req: Request, res: Response) => {
  if (!enabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }
  try {
    const now = new Date();
    const in3d = new Date(now.getTime() + 3 * 864e5);
    const events: Array<Record<string, unknown>> = [];

    // ١) اشتراك ينتهي خلال ٣ أيام (أو انتهى ولم يُجدَّد)
    const ending = await prisma.tenant.findMany({
      where: { isActive: true, subscriptionEndsAt: { not: null, lte: in3d } },
      select: { id: true, name: true, subscriptionEndsAt: true, settings: { select: { phone: true } } },
    });
    for (const t of ending) {
      const ph = normalizePhone(t.settings?.phone);
      if (ph.length < 9) continue;
      events.push({
        kind: 'subscription_ending',
        tenantId: t.id, companyName: t.name, phone: ph,
        endsAt: t.subscriptionEndsAt?.toISOString().slice(0, 10),
      });
    }

    // ٢) مندوب نشط لم يزامن منذ ٣ أيام (آخر فاتورة أو موقع)
    const staleSince = new Date(now.getTime() - 3 * 864e5);
    const reps = await prisma.salesRep.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, tenantId: true,
        tenant: { select: { name: true, isActive: true, settings: { select: { phone: true } } } },
      },
    });
    for (const r of reps) {
      if (!r.tenant?.isActive) continue;
      const ph = normalizePhone(r.tenant.settings?.phone);
      if (ph.length < 9) continue;
      const last = await prisma.invoice.findFirst({
        where: { salesRepId: r.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      });
      // مندوب بلا أي فاتورة قط ليس «متوقّفاً» — قد يكون جديداً. نتجاهله.
      if (!last || last.createdAt >= staleSince) continue;
      const days = Math.floor((now.getTime() - last.createdAt.getTime()) / 864e5);
      events.push({ kind: 'rep_not_syncing', tenantId: r.tenantId, companyName: r.tenant.name, phone: ph, repName: r.name, days });
    }

    res.json({ success: true, data: { events } });
  } catch (e) {
    console.error('[wa-account] events خطأ:', e);
    res.status(500).json({ success: false });
  }
});

export default router;
