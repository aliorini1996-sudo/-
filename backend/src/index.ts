import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import prisma from './config/database';

import authRouter from './routes/auth';
import customersRouter from './routes/customers';
import productsRouter from './routes/products';
import salesRepsRouter from './routes/salesReps';
import invoicesRouter from './routes/invoices';
import receiptsRouter from './routes/receipts';
import dashboardRouter from './routes/dashboard';
import reportsRouter from './routes/reports';
import notificationsRouter from './routes/notifications';
import companyRouter from './routes/company';
import tenantsRouter from './routes/tenants';
import siteContentRouter from './routes/siteContent';
import contactRouter from './routes/contact';
import vanStockRouter from './routes/vanStock';
import trackingRouter from './routes/tracking';
import supportRouter from './routes/support';
import companyUsersRouter from './routes/companyUsers';
import erpRouter from './routes/erp';
import leadsRouter from './routes/leads';
import leadsCronRouter from './routes/leadsCron';
import analyticsRouter from './routes/analytics';
import promoVideosRouter from './routes/promoVideos';
import importRouter from './routes/import';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimits';

const app = express();
// خلف بروكسي Render — لاحتساب IP الحقيقي في حدود المعدّل
app.set('trust proxy', 1);
const server = http.createServer(app);

// الأصول المسموح بها: FRONTEND_URL (قائمة مفصولة بفواصل) أو * للسماح للجميع.
// يُسمح دائماً بمعاينات Vercel وبالطلبات بلا أصل (تطبيقات الجوال/الأدوات).
const allowedOrigins = (process.env.FRONTEND_URL || '*').split(',').map(s => s.trim()).filter(Boolean);
const corsOrigin = allowedOrigins.includes('*')
  ? '*'
  : (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowedOrigins.includes(origin) || /\.vercel\.app$/.test(origin)) cb(null, true);
      else cb(new Error('Not allowed by CORS'));
    };

export const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true },
});

// CSP مفعّلة: API يقدّم JSON (السياسة خاملة له) لكنها تحمي أي HTML يُقدَّم (صفحات خطأ/الواجهة المحلية الاختيارية).
// inline مسموح لأن الواجهة الاحتياطية المبنيّة تعتمد أنماطاً/معالجات سطرية؛ الصور data: لأن الشعارات base64.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'connect-src': ["'self'", 'wss:', 'https:'],
      'frame-ancestors': ["'none'"],
    },
  },
}));
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// حدّ عام واقٍ لكل واجهة API (حدود أدق على الدخول/التسجيل داخل كل مسار)
app.use('/api', apiLimiter);

app.use('/api/auth', authRouter);
app.use('/api/customers', customersRouter);
app.use('/api/products', productsRouter);
app.use('/api/sales-reps', salesRepsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/company', companyRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/site-content', siteContentRouter);
app.use('/api/contact', contactRouter);
app.use('/api/van-stock', vanStockRouter);
app.use('/api/tracking', trackingRouter);
app.use('/api/support', supportRouter);
app.use('/api/company-users', companyUsersRouter);
app.use('/api/erp', erpRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/leads-cron', leadsCronRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/promo-videos', promoVideosRouter);
app.use('/api/import', importRouter);

// الوسائط المُنتجة (فيديوهات/أصوات ترويجية) — قبل التقاط الواجهة المبنيّة كي لا تبتلعها
app.use('/media', express.static(path.join(process.cwd(), 'media'), { maxAge: '1d' }));

// version = رقم الـcommit المنشور (يوفّره Render عبر RENDER_GIT_COMMIT) — للتحقق الخارجي من نجاح النشر
app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  timestamp: new Date(),
  version: (process.env.RENDER_GIT_COMMIT || 'dev').slice(0, 7),
}));

// عرض الواجهة المبنيّة إن وُجدت (اختياري — الواجهة الرسمية على Vercel)
const webDist = path.join(__dirname, '../../web-admin/dist');
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use(errorHandler);

io.on('connection', socket => {
  socket.on('join-room', (room: string) => socket.join(room));
  socket.on('disconnect', () => {});
});

async function seedDefaults() {
  try {
    // مالك المنصّة (السوبر أدمن) — يدير كل الشركات
    if (await prisma.superAdmin.count() === 0) {
      const hash = await bcrypt.hash('owner123', 10);
      await prisma.superAdmin.create({
        data: { name: 'مالك المنصّة', email: 'owner@dsd.com', passwordHash: hash },
      });
      console.log('✅ Super admin created: owner@dsd.com / owner123');
    }

    // شركة تجريبية أولى + أدمنها + مندوبها + إعداداتها
    if (await prisma.tenant.count() === 0) {
      const adminHash = await bcrypt.hash('admin123', 10);
      const repHash = await bcrypt.hash('rep123', 10);
      const tenant = await prisma.tenant.create({ data: { name: 'الشركة التجريبية', plan: 'pro' } });
      await prisma.companySettings.create({ data: { tenantId: tenant.id, name: 'الشركة التجريبية' } });
      await prisma.admin.create({
        data: { tenantId: tenant.id, name: 'مدير الشركة', email: 'admin@dsd.com', passwordHash: adminHash, role: 'ADMIN' },
      });
      await prisma.salesRep.create({
        data: {
          tenantId: tenant.id, name: 'مندوب تجريبي', phone: '0500000000', username: 'rep1', passwordHash: repHash,
          isActive: true, canCreateInvoice: true, canEditInvoice: true, canCancelInvoice: true,
          canSellOnCredit: true, canSellInCash: true,
          canChangePrice: true, canSellBelowPrice: true, maxDiscountPct: 100,
          canCreateReceipt: true, canEditReceipt: true, canCancelReceipt: true,
          canManageVanStock: true,
          canAddCustomer: true, canEditCustomer: true, canViewStatement: true,
        },
      });
      console.log('✅ Demo tenant created: admin@dsd.com / admin123 — rep1 / rep123');
    }
  } catch (e) {
    console.error('Seed error:', e);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 DSD API running on port ${PORT}`);
  await seedDefaults();
});

export default app;
