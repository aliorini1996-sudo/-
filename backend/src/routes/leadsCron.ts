import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { runAutoHuntBatch, getHuntConfig } from '../services/leadHunter';
import { runAutoEmailBatch, getEmailConfig } from '../services/leadEmailer';
import { runCommunityHuntBatch, getCommunityConfig } from '../services/communityHunter';

// نقطة الصيد المستمر للجدولة الخارجية (GitHub Actions).
// تعمل فقط إذا فُعّل الصيد من اللوحة (enabled)، مع حارس فاصل زمني يمنع أكثر من
// دفعة كل ~18 دقيقة (حماية من التكرار/الإساءة).
const router = Router();
const MIN_INTERVAL_MS = 18 * 60 * 1000;

/**
 * حارس المسارات الدوريّة — **يفشل مغلقاً**.
 *
 * كان الفحص مشروطاً بوجود `AUTO_HUNT_TOKEN`: إن غاب المتغيّر سقط الحارس كلّه
 * وصارت النقاط عامّةً لمن يعرف عنوانها — يُشغّل دفعات صيد ويستهلك حصص Apify
 * وGemini وSerper المدفوعة، ويُطلق حملات بريد باسم الشركة.
 *
 * والمتغيّر مضبوطٌ اليوم على الإنتاج، فهذا التشديد **لا يغيّر سلوكاً قائماً**؛
 * إنما يمنع أن يتحوّل حذفُ متغيّرِ بيئةٍ يوماً إلى فتحِ بابٍ صامت.
 *
 * ⚠️ لا يُطبَّق على `/invgen` ولا على نقاط تتبّع البريد (`/o` `/c` `/u`):
 * تلك يناديها زوّار مجهولون من الأدوات المجانية ومن رسائل البريد، فتحصينها
 * يقتل التقاط العملاء المحتملين وإلغاء الاشتراك.
 */
function requireCronToken(req: Request, res: Response, next: NextFunction) {
  const token = (process.env.AUTO_HUNT_TOKEN || '').trim();
  if (!token) {
    res.status(503).json({ success: false, message: 'الجدولة معطلة AUTO_HUNT_TOKEN غير مضبوط على الخادم' });
    return;
  }
  const provided = (req.headers['x-autohunt-token'] as string || '').trim();
  if (provided !== token) {
    res.status(401).json({ success: false, message: 'توكن غير صالح' });
    return;
  }
  next();
}

router.post('/run', requireCronToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await getHuntConfig();
    if (!cfg.enabled) {
      res.json({ success: true, skipped: true, message: 'الصيد التلقائي متوقف فعله من اللوحة' });
      return;
    }


    // حارس الفاصل الزمني — يمنع التشغيل المتكرّر أو المتوازي
    if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < MIN_INTERVAL_MS) {
      const waitMin = Math.ceil((MIN_INTERVAL_MS - (Date.now() - new Date(cfg.lastRunAt).getTime())) / 60000);
      res.json({ success: true, skipped: true, message: `دفعة حديثة تخطي (~${waitMin} دقيقة على التالية)` });
      return;
    }

    const result = await runAutoHuntBatch('auto-hunt (cron)');
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// دفعة بريد تلقائي (للجدولة) — الحماية: توكن إلزامي + enabled + فاصل زمني
router.post('/email', requireCronToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await getEmailConfig();
    if (!cfg.enabled) {
      res.json({ success: true, skipped: true, message: 'البريد التلقائي متوقف فعله من اللوحة' });
      return;
    }
    if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < MIN_INTERVAL_MS) {
      res.json({ success: true, skipped: true, message: 'دفعة حديثة تخطي' });
      return;
    }
    const result = await runAutoEmailBatch();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// دفعة بحث مجتمعات (للجدولة)
router.post('/community', requireCronToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cfg = await getCommunityConfig();
    if (!cfg.enabled) { res.json({ success: true, skipped: true, message: 'بحث المجتمعات متوقف فعله من اللوحة' }); return; }
    if (cfg.lastRunAt && Date.now() - new Date(cfg.lastRunAt).getTime() < MIN_INTERVAL_MS) {
      res.json({ success: true, skipped: true, message: 'دفعة حديثة تخطي' });
      return;
    }
    res.json({ success: true, data: await runCommunityHuntBatch() });
  } catch (err) {
    next(err);
  }
});

// ------------------- التقاط مستخدمي الأدوات المجانية (مولّد الفواتير) ------------------- //
// كل من يحمّل/يطبع فاتورة من الأداة العامة هو موزّع نشط باسمه ورقمه الضريبي → يُحفظ كعميل محتمل
// ساخن (source=invoice-tool) يظهر في لوحة المالك، وبيانات عميله وفاتورته في نشاط TOOL. بلا تغيير مخطط.
router.post('/invgen', async (req: Request, res: Response) => {
  try {
    const b = (req.body || {}) as Record<string, unknown>;
    const s = (v: unknown, max = 160) => String(v ?? '').trim().slice(0, max);
    const sellerName = s(b.sellerName);
    if (sellerName.length < 3) { res.status(400).json({ success: false }); return; }
    const vatNumber = s(b.vatNumber, 20).replace(/[^\d]/g, '');
    const buyerName = s(b.buyerName);
    const buyerVat = s(b.buyerVat, 20).replace(/[^\d]/g, '');
    const address = s(b.address, 200);
    const country = s(b.country, 40) || null;
    const countryCode = s(b.countryCode, 2).toUpperCase() || null;
    const total = Number(b.total) || 0;
    const currency = s(b.currency, 8);

    // مفتاح إزالة التكرار: الرقم الضريبي إن وُجد وإلا الاسم المطبّع
    const sourceId = `invgen:${vatNumber || sellerName.toLowerCase().replace(/\s+/g, '-')}`;
    const detail = [
      buyerName ? `عميل الفاتورة ${buyerName}${buyerVat ? ` (ض ${buyerVat})` : ''}` : null,
      total > 0 ? `الإجمالي ${total.toFixed(2)} ${currency}` : null,
      address ? `العنوان ${address}` : null,
    ].filter(Boolean).join(' · ');

    let lead = await prisma.lead.findUnique({ where: { sourceId } });
    if (!lead) {
      lead = await prisma.lead.create({
        data: {
          name: sellerName,
          address: address || null,
          country, countryCode,
          category: 'مستخدم مولد الفواتير',
          source: 'invoice-tool', sourceId,
          stage: 'NEW', score: 8,
          scoreNote: 'يستخدم مولد الفواتير المجاني موزع نشط يصدر فواتير 🔥',
          notes: vatNumber ? `الرقم الضريبي ${vatNumber}` : null,
        },
      });
    }
    // نشاط استخدام (بحد أقصى نشاط كل 6 ساعات لتفادي الضجيج مع الاستخدام المتكرر)
    const recent = await prisma.leadActivity.findFirst({
      where: { leadId: lead.id, type: 'TOOL', createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } },
    });
    if (!recent) {
      await prisma.leadActivity.create({
        data: { leadId: lead.id, type: 'TOOL', content: `أصدر فاتورة من المولد المجاني${detail ? ' — ' + detail : ''}`, createdBy: 'invoice-generator' },
      });
    }
    res.json({ success: true });
  } catch {
    res.json({ success: true }); // لا نُفشل الأداة العامة أبداً
  }
});

// ------------------- تتبّع البريد التسويقي (نقاط عامة بلا مصادقة) ------------------- //
// OPEN عبر بكسل 1×1، CLICK عبر إعادة توجيه، UNSUB بصفحة تأكيد — كلها تُسجَّل في LeadActivity.

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// بكسل الفتح — يسجّل OPEN مرة واحدة لكل لمسة، ويرفع الدرجة لمن يفتح
router.get('/o/:id.gif', async (req: Request, res: Response) => {
  const send = () => {
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' });
    res.end(PIXEL);
  };
  try {
    const id = req.params.id;
    const touch = String(req.query.t || '1').slice(0, 2);
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, score: true } });
    if (!lead) { send(); return; }
    const marker = `فتح البريد (لمسة ${touch})`;
    const dup = await prisma.leadActivity.findFirst({ where: { leadId: id, type: 'OPEN', content: marker } });
    if (!dup) {
      await prisma.leadActivity.create({ data: { leadId: id, type: 'OPEN', content: marker, createdBy: 'email-tracking' } });
      // فاتحُ البريد أدفأ من غيره — نرفع درجته إلى 7 على الأقل
      if ((lead.score ?? 0) < 7) await prisma.lead.update({ where: { id }, data: { score: 7, scoreNote: 'فتح بريدنا التسويقي' } }).catch(() => {});
    }
  } catch { /* لا نُفشل بكسلاً */ }
  send();
});

// نقرة CTA — تسجّل CLICK وترقّي العميل إلى QUALIFIED (ساخن) ثم تعيد التوجيه للموقع
router.get('/c/:id', async (req: Request, res: Response) => {
  // حماية من إعادة التوجيه المفتوحة: الوجهة داخل fieldsa.net فقط
  const raw = String(req.query.u || 'https://fieldsa.net');
  let dest = 'https://fieldsa.net';
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' && (u.hostname === 'fieldsa.net' || u.hostname.endsWith('.fieldsa.net'))) dest = u.toString();
  } catch { /* وجهة غير صالحة → الافتراضية */ }
  try {
    const id = req.params.id;
    const touch = String(req.query.t || '1').slice(0, 2);
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, stage: true } });
    if (lead) {
      await prisma.leadActivity.create({ data: { leadId: id, type: 'CLICK', content: `نقر رابط البريد (لمسة ${touch})`, createdBy: 'email-tracking' } });
      const data: Record<string, unknown> = { score: 9, scoreNote: 'نقر رابط بريدنا عميل ساخن 🔥', nextFollowUpAt: new Date() };
      if (lead.stage === 'NEW' || lead.stage === 'CONTACTED') data.stage = 'QUALIFIED';
      await prisma.lead.update({ where: { id }, data }).catch(() => {});
    }
  } catch { /* لا نعطّل التوجيه */ }
  res.redirect(302, dest);
});

// إلغاء الاشتراك — يسجّل UNSUB (يستثنيه المُرسِل نهائياً) ويعرض تأكيداً ثنائي اللغة
router.get('/u/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true } });
    if (lead) {
      const dup = await prisma.leadActivity.findFirst({ where: { leadId: id, type: 'UNSUB' } });
      if (!dup) await prisma.leadActivity.create({ data: { leadId: id, type: 'UNSUB', content: 'ألغى الاشتراك من البريد التسويقي', createdBy: 'email-tracking' } });
    }
  } catch { /* نعرض التأكيد على أي حال */ }
  res.set('Content-Type', 'text/html; charset=utf-8').send(`< doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تم إلغاء الاشتراك Unsubscribed</title></head>
  <body style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#F1EBDF;margin:0;padding:48px 16px;text-align:center">
    <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:18px;padding:36px 28px;box-shadow:0 2px 10px rgba(1,2.08)">
      <div style="font-size:40px">✅</div>
      <h2 style="color:#1F1A13;margin:12px 0 6px">تم إلغاء اشتراكك</h2>
      <p style="color:#6E6557;line-height:3;margin:0">لن تصلك رسائل تسويقية من Field Sales بعد الآن <br><span style="font-size:13px">You have been unsubscribed from Field Sales marketing emails </span></p>
      <a href="0 style="display:inline-block;margin-top:20px;color:#E15A30;text-decoration:none;font-weight:700">fieldsa net</a>
    </div>
  </body></html>`);
});

export default router;
