import { Router, Response } from 'express';
import { z } from 'zod';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  listFeatures, updateFeature, listJobs, getJob, deleteJob,
  createJob, createBatch, getStats, listVoices,
} from '../services/promoVideoService';

// الفيديوهات الترويجية — لمالك المنصّة (السوبر أدمن) فقط
const router = Router();
router.use(authenticate, requireSuperAdmin);

// أخطاء الخدمة تحمل status اختيارياً — تُحوَّل لاستجابة JSON موحّدة
function fail(res: Response, e: unknown) {
  const err = e as Error & { status?: number };
  res.status(err.status || 500).json({ success: false, message: err.message || 'حدث خطأ' });
}

// المميزات وسيناريوهاتها
router.get('/features', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: listFeatures() });
});

// الأصوات العربية المتاحة (Edge دائماً + Google عند وجود المفتاح)
router.get('/voices', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: listVoices() });
});

router.put('/features/:id', (req: AuthRequest, res: Response) => {
  try {
    const body = z.object({
      script: z.string().optional(),
      duration: z.number().int().optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body);
    res.json({ success: true, data: updateFeature(req.params.id, body) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ success: false, message: e.errors[0].message });
    fail(res, e);
  }
});

// الوظائف (الفيديوهات المُنتجة)
router.get('/jobs', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: listJobs() });
});

router.get('/jobs/:id', (req: AuthRequest, res: Response) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, message: 'الفيديو غير موجود' });
  res.json({ success: true, data: job });
});

router.post('/generate', (req: AuthRequest, res: Response) => {
  try {
    const { featureId, voiceId } = z.object({
      featureId: z.string().min(1),
      voiceId: z.string().optional(),
    }).parse(req.body);
    res.status(201).json({ success: true, data: createJob(featureId, voiceId) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ success: false, message: 'المميزة مطلوبة' });
    fail(res, e);
  }
});

router.post('/generate-batch', (req: AuthRequest, res: Response) => {
  try {
    const { featureIds, voiceId } = z.object({
      featureIds: z.array(z.string().min(1)).min(1),
      voiceId: z.string().optional(),
    }).parse(req.body);
    res.status(201).json({ success: true, data: createBatch(featureIds, voiceId) });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ success: false, message: 'اختر مميزة واحدة على الأقل' });
    fail(res, e);
  }
});

router.delete('/jobs/:id', (req: AuthRequest, res: Response) => {
  try {
    deleteJob(req.params.id);
    res.json({ success: true });
  } catch (e) { fail(res, e); }
});

// الإحصائيات + جاهزية خدمات الإنتاج (TTS/Avatar)
router.get('/stats', (_req: AuthRequest, res: Response) => {
  res.json({ success: true, data: getStats() });
});

export default router;
