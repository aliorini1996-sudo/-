/**
 * وكيل واتساب — نقاط المالك (السوبر أدمن فقط).
 *
 * وضع الظل: يولّد الرد المقترح بلا إرسال، ليختبر المالك جودة الردود على محادثات
 * حقيقية قبل تفعيل الأتمتة الكاملة (WA_AGENT_ENABLED). لا يمسّ قاعدة العملاء ولا يرسل شيئاً.
 */

import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import { shadowSuggest, waAgentEnabled } from '../services/wa-agent/engine';
import { anthropicReady, anthropicModel } from '../services/anthropic';
import { geminiReady } from '../services/gemini';

const router = Router();
router.use(authenticate, requireSuperAdmin);

// حالة الوكيل — أي مزوّد ذكاء مضبوط وهل الأتمتة مفعّلة
router.get('/status', (_req: AuthRequest, res: Response) => {
  res.json({
    success: true,
    data: {
      autoEnabled: waAgentEnabled(),
      claude: anthropicReady(),
      claudeModel: anthropicReady() ? anthropicModel() : null,
      gemini: geminiReady(),
      llmReady: anthropicReady() || geminiReady(),
    },
  });
});

const suggestSchema = z.object({
  phone: z.string().min(6).max(20),
  message: z.string().min(1).max(2000),
  prior: z
    .array(z.object({ role: z.enum(['customer', 'agent']), text: z.string().min(1).max(2000) }))
    .max(20)
    .optional(),
  name: z.string().max(80).optional(),
  isReturning: z.boolean().optional(),
});

// وضع الظل: يولّد ردّاً مقترحاً بلا إرسال
router.post('/suggest', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const p = suggestSchema.safeParse(req.body);
    if (!p.success) {
      res.status(400).json({ success: false, message: 'مدخلات غير صحيحة', code: 'BAD_INPUT' });
      return;
    }
    if (!anthropicReady() && !geminiReady()) {
      res.status(503).json({
        success: false,
        message: 'لا يوجد مزوّد ذكاء مضبوط — اضبط ANTHROPIC_API_KEY أو GEMINI_API_KEY',
        code: 'NO_LLM',
      });
      return;
    }
    const prior = (p.data.prior ?? []).map((m) => ({ role: m.role, text: m.text }));
    const out = await shadowSuggest({
      phone: p.data.phone,
      customerMessage: p.data.message,
      priorMessages: prior,
      name: p.data.name,
      isReturning: p.data.isReturning,
    });
    res.json({ success: true, data: out });
  } catch (err) {
    next(err);
  }
});

export default router;
