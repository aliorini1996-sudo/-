# نظام إدارة المبيعات الميداني - DSD Sales System

## هيكل المشروع
```
dsd-sales-system/
├── backend/          ← Node.js + Express + TypeScript + PostgreSQL
├── web-admin/        ← React + TypeScript + Tailwind (لوحة التحكم الإدارية)
└── mobile/           ← Flutter (تطبيق المندوب - Android)
```

---

## تشغيل النظام

### 1. متطلبات الخادم
- Node.js 20+
- PostgreSQL 15+
- npm أو pnpm

### 2. إعداد قاعدة البيانات
```sql
CREATE DATABASE dsd_db;
```

### 3. تشغيل الـ Backend
```bash
cd backend
npm install
cp .env.example .env
# عدّل .env وضع DATABASE_URL الصحيح
npm run db:push       # إنشاء الجداول
npm run db:seed       # بيانات تجريبية
npm run dev           # تشغيل على http://localhost:3000
```

### 4. تشغيل لوحة التحكم
```bash
cd web-admin
npm install
npm run dev           # تشغيل على http://localhost:5173
```

### 5. تشغيل تطبيق Flutter
```bash
cd mobile
flutter pub get
flutter run
```

---

## بيانات الدخول التجريبية

### لوحة التحكم (Admin)
- البريد: `admin@dsd.com`
- كلمة المرور: `admin123`

### تطبيق المندوب
- اسم المستخدم: `rep1`
- كلمة المرور: `rep123`

---

## API Endpoints

| الطريقة | المسار | الوصف |
|---------|--------|-------|
| POST | /api/auth/login | تسجيل الدخول |
| GET | /api/dashboard | إحصائيات لوحة التحكم |
| GET/POST | /api/customers | العملاء |
| GET/POST | /api/products | المنتجات |
| GET/POST | /api/sales-reps | المناديب |
| GET/POST | /api/invoices | الفواتير |
| PATCH | /api/invoices/:id/cancel | إلغاء فاتورة |
| GET/POST | /api/receipts | سندات القبض |
| PATCH | /api/receipts/:id/cancel | إلغاء سند |
| GET | /api/reports/sales | تقارير المبيعات |
| GET | /api/reports/collections | تقارير التحصيل |
| GET | /api/reports/balances | أرصدة العملاء |
| GET | /api/reports/rep-performance | أداء المناديب |
