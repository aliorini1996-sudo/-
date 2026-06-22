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
import { errorHandler } from './middleware/errorHandler';

const app = express();
const server = http.createServer(app);

export const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', credentials: true },
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

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

app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

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

async function seedAdmin() {
  try {
    const count = await prisma.admin.count();
    if (count === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await prisma.admin.create({
        data: { name: 'مدير النظام', email: 'admin@dsd.com', passwordHash: hash, role: 'ADMIN' },
      });
      console.log('✅ Admin created: admin@dsd.com / admin123');
    }
  } catch (e) {
    console.error('Seed error:', e);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 DSD API running on port ${PORT}`);
  await seedAdmin();
});

export default app;
