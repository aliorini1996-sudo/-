/**
 * جسر واتساب ويب — نقاط الخادم.
 *
 * قسمان:
 *  1) نقاط الجسر  — يستدعيها الجسر المحلي بمفتاح `x-bridge-key` (بلا جلسة مستخدم).
 *  2) نقاط المالك — يستدعيها متصفّح المالك (سوبر أدمن) لعرض QR والإرسال وقراءة المحادثة.
 *
 * الطابور هو جدول WaMessage نفسه بحالة QUEUED — لا نموذج جديد:
 *   المالك يضغط «إرسال» ⇒ QUEUED ⇒ الجسر يسحب ⇒ يرسل ⇒ SENT (أو FAILED).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { waNumber } from '../services/whatsapp';
import { handleInboundMessage } from '../services/waInbound';
import { personalize } from '../services/marketingTemplate';
import { waRemainingToday, getWaConfig } from '../services/whatsappCampaign';
import {
  getBridgeSession, saveBridgeSession, isBridgeAlive, checkBridgeKey, bridgeKeyConfigured,
  getDraftTemplate, saveDraftTemplate,
} from '../services/waBridge';

const router = Router();

// ============================ 1) نقاط الجسر ============================ //

/**
 * تشخيص عام (بلا مصادقة): هل المفتاح مضبوط على الخادم أصلاً؟
 * لا يكشف القيمة — بوليان فقط. بدونه يستحيل التمييز من الخارج بين «الخادم بلا مفتاح»
 * و«مفتاحك خاطئ»، وكلاهما كان يُعطي 401 صمّاء.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ success: true, data: { keyConfigured: bridgeKeyConfigured() } });
});

function requireBridge(req: Request, res: Response, next: NextFunction): void {
  // نفصل الحالتين: الخلط بينهما يجعل العطل غير قابل للتشخيص
  if (!bridgeKeyConfigured()) {
    res.status(503).json({
      success: false,
      code: 'KEY_NOT_SET',
      message: 'WA_BRIDGE_KEY غير مضبوط على الخادم — أضِفه في Environment لخدمة dsd-backend على Render.',
    });
    return;
  }
  if (!checkBridgeKey(req.get('x-bridge-key') || undefined)) {
    res.status(401).json({
      success: false,
      code: 'KEY_MISMATCH',
      message: 'المفتاح لديك لا يطابق WA_BRIDGE_KEY المضبوط على الخادم.',
    });
    return;
  }
  next();
}

// الجسر يرفع صورة QR لتظهر في لوحة المالك فيمسحها بهاتفه
router.post('/qr', requireBridge, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const qr = z.object({ qr: z.string().min(1) }).parse(req.body).qr;
    await saveBridgeSession({ status: 'QR', qr, phone: null, lastHeartbeat: new Date().toISOString(), lastError: null });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// تغيّر حالة الجلسة (اتصل/فُصل/فشل التوثيق)
const statusSchema = z.object({
  status: z.enum(['DISCONNECTED', 'QR', 'CONNECTED', 'AUTH_FAILED']),
  phone: z.string().nullish(),
  pushName: z.string().nullish(),
  error: z.string().nullish(),
});

router.post('/status', requireBridge, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = statusSchema.parse(req.body);
    await saveBridgeSession({
      status: b.status,
      phone: b.phone ?? null,
      pushName: b.pushName ?? null,
      lastError: b.error ?? null,
      qr: b.status === 'CONNECTED' ? null : undefined, // QR لا معنى له بعد الاتصال
      lastHeartbeat: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/**
 * نبضة + سحب الطابور + الأوامر المعلّقة — نداء واحد يقوم بالثلاثة كي يبقى الجسر بسيطاً.
 * الحدّ اليومي يُطبَّق هنا لا في الجسر: الخادم هو مصدر الحقيقة.
 */
router.get('/pull', requireBridge, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const s = await saveBridgeSession({ lastHeartbeat: new Date().toISOString() });
    if (s.status !== 'CONNECTED') {
      res.json({ success: true, data: { messages: [], command: s.command ?? null } });
      return;
    }
    const remaining = await waRemainingToday();
    const messages = remaining <= 0 ? [] : await prisma.waMessage.findMany({
      where: { status: 'QUEUED', direction: 'OUT' },
      orderBy: { createdAt: 'asc' },
      take: Math.min(remaining, 5), // دفعات صغيرة: الجسر يتباطأ بينها بتباعد عشوائي
      select: { id: true, phone: true, body: true },
    });
    res.json({ success: true, data: { messages, command: s.command ?? null, remainingToday: remaining } });
  } catch (err) { next(err); }
});

// الجسر يؤكّد استلام الأمر فنمسحه
router.post('/command-done', requireBridge, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await saveBridgeSession({ command: null });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// نتيجة إرسال رسالة من الطابور
const resultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  waId: z.string().nullish(),
  error: z.string().nullish(),
});

router.post('/result', requireBridge, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = resultSchema.parse(req.body);
    const msg = await prisma.waMessage.findUnique({ where: { id: b.id }, select: { leadId: true } });
    await prisma.waMessage.update({
      where: { id: b.id },
      data: {
        status: b.ok ? 'SENT' : 'FAILED',
        waId: b.ok ? (b.waId ?? undefined) : undefined,
        error: b.ok ? null : (b.error ?? 'فشل غير معروف').slice(0, 300),
      },
    });
    // نجاح الإرسال ⇒ نقل المرحلة وتسجيل النشاط (تماماً كمسار Cloud API)
    if (b.ok && msg?.leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: msg.leadId }, select: { stage: true } });
      await prisma.lead.update({
        where: { id: msg.leadId },
        data: { lastContactedAt: new Date(), ...(lead?.stage === 'NEW' ? { stage: 'CONTACTED' } : {}) },
      });
      await prisma.leadActivity.create({
        data: { leadId: msg.leadId, type: 'WHATSAPP', content: 'واتساب (جسر ويب)', createdBy: 'الجسر' },
      });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ردّ وارد من واتساب ويب — نفس معالجة الـwebhook الرسمي
router.post('/inbound', requireBridge, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const b = z.object({
      waId: z.string().min(1),
      phone: z.string().min(5),
      body: z.string().optional(),
    }).parse(req.body);
    const r = await handleInboundMessage({ waId: b.waId, phone: b.phone, body: b.body || '' });
    res.json({ success: true, data: r });
  } catch (err) { next(err); }
});

// ============================ 2) نقاط المالك ============================ //

router.use(authenticate, requireSuperAdmin);

// حالة الجلسة + QR — تقرأها اللوحة كل ثانيتين أثناء الربط
router.get('/session', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const s = await getBridgeSession();
    const alive = isBridgeAlive(s);
    const [queued, cfg, remaining] = await Promise.all([
      prisma.waMessage.count({ where: { status: 'QUEUED', direction: 'OUT' } }),
      getWaConfig(),
      waRemainingToday(),
    ]);
    res.json({
      success: true,
      data: {
        // الجسر قد يُغلق فجأة (إطفاء الجهاز) فلا تصل رسالة فصل — النبضة هي الحقيقة
        status: alive ? s.status : 'DISCONNECTED',
        bridgeAlive: alive,
        keyConfigured: bridgeKeyConfigured(),
        qr: alive ? s.qr : null,
        phone: s.phone,
        pushName: s.pushName,
        lastError: s.lastError,
        lastHeartbeat: s.lastHeartbeat,
        queued,
        dailyCap: cfg.dailyCap,
        remainingToday: remaining,
      },
    });
  } catch (err) { next(err); }
});

// نصّ الرسالة الافتراضي (يُحرّره المالك) — {{name}} {{city}} {{country}} {{angle}}
router.get('/draft', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { template: await getDraftTemplate() } });
  } catch (err) { next(err); }
});

router.put('/draft', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const t = z.object({ template: z.string().min(1).max(4000) }).parse(req.body).template;
    await saveDraftTemplate(t);
    res.json({ success: true, data: { template: t } });
  } catch (err) { next(err); }
});

// معاينة الرسالة المخصّصة لعميل بعينه (الزاوية تُحقن حسب دولته)
router.get('/preview/:leadId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      select: { id: true, name: true, city: true, country: true, countryCode: true, phone: true, waOptOut: true },
    });
    if (!lead) {
      res.status(404).json({ success: false, message: 'العميل غير موجود' });
      return;
    }
    const template = await getDraftTemplate();
    res.json({
      success: true,
      data: { lead, text: personalize(template, lead), phone: waNumber(lead.phone), optOut: lead.waOptOut },
    });
  } catch (err) { next(err); }
});

// إدراج رسالة لعميل واحد في الطابور — قلب «الإرسال لكل عميل على حدة»
const sendSchema = z.object({ leadId: z.string(), text: z.string().min(1).max(4000) });

router.post('/send', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const b = sendSchema.parse(req.body);
    const s = await getBridgeSession();
    if (!isBridgeAlive(s) || s.status !== 'CONNECTED') {
      res.status(400).json({ success: false, message: 'الجسر غير متصل — شغّل الجسر على جهازك وامسح رمز QR.' });
      return;
    }
    const lead = await prisma.lead.findUnique({
      where: { id: b.leadId },
      select: { id: true, phone: true, waOptOut: true, name: true },
    });
    if (!lead) {
      res.status(404).json({ success: false, message: 'العميل غير موجود' });
      return;
    }
    // من طلب الإيقاف لا يُراسَل — لا استثناء ولا تجاوز يدوي
    if (lead.waOptOut) {
      res.status(403).json({ success: false, message: `«${lead.name}» طلب إيقاف المراسلة — لا يمكن الإرسال إليه.` });
      return;
    }
    const phone = waNumber(lead.phone);
    if (!phone) {
      res.status(400).json({ success: false, message: 'لا يوجد رقم هاتف صالح لهذا العميل' });
      return;
    }
    if ((await waRemainingToday()) <= 0) {
      res.status(429).json({ success: false, message: 'بلغت الحدّ اليومي — يُستأنف غداً أو ارفع الحدّ من الإعدادات.' });
      return;
    }
    const msg = await prisma.waMessage.create({
      data: { leadId: lead.id, phone, direction: 'OUT', status: 'QUEUED', body: b.text },
    });
    res.json({ success: true, data: { id: msg.id, phone } });
  } catch (err) { next(err); }
});

// محادثة عميل (صادر + وارد) بالترتيب الزمني
router.get('/thread/:leadId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const messages = await prisma.waMessage.findMany({
      where: { leadId: req.params.leadId },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, direction: true, body: true, status: true, error: true, createdAt: true },
    });
    res.json({ success: true, data: messages });
  } catch (err) { next(err); }
});

// طلب فصل الجلسة — يُنفَّذ عند سحب الجسر التالي
router.post('/logout', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await saveBridgeSession({ command: 'LOGOUT' });
    res.json({ success: true, message: 'سيُفصل الجسر خلال ثوانٍ.' });
  } catch (err) { next(err); }
});

export default router;
