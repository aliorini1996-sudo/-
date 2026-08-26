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
import prisma from '../config/database';

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

/**
 * تشخيص محكوم — يجيب: كم شركة سجّلت هاتفاً، وكم منها تُطبَّع لأرقام صالحة.
 * لا يكشف رقماً ولا اسم شركة إطلاقاً (أعداد فقط + آخر ٣ خانات مُقنَّعة)، ويخضع
 * لنفس المفتاح والمفتاح الرئيسي. وُجد لأن `linked:false` لرقم مسجَّل قد يعني
 * ثلاثة أشياء مختلفة (لم يُحفظ · صيغة لا تُطبَّع · شركة أخرى) والخلط بينها
 * يجعل العطل غير قابل للتشخيص.
 */
router.get('/diag', async (req: Request, res: Response) => {
  if (!enabled()) { res.status(404).json({ success: false }); return; }
  if (!keyOk(req.get('x-account-key') || undefined)) { res.status(401).json({ success: false }); return; }
  try {
    const rows = await prisma.companySettings.findMany({
      where: { phone: { not: null } },
      select: { phone: true },
    });
    const norm = rows.map((r) => normalizePhone(r.phone)).filter((d) => d.length >= 9);
    res.json({
      success: true,
      data: {
        withPhone: rows.length,          // كم شركة سجّلت هاتفاً
        normalizable: norm.length,       // كم منها يُطبَّع لرقم صالح
        tails: norm.map((d) => '***' + d.slice(-3)), // آخر ٣ خانات فقط
      },
    });
  } catch (e) {
    console.error('[wa-account] diag خطأ:', e);
    res.status(500).json({ success: false });
  }
});

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

export default router;
