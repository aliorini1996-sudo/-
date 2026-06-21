import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminHash = await bcrypt.hash('admin123', 10);
  await prisma.admin.upsert({
    where: { email: 'admin@dsd.com' },
    update: {},
    create: { name: 'مدير النظام', email: 'admin@dsd.com', passwordHash: adminHash, role: 'ADMIN' },
  });

  const repHash = await bcrypt.hash('rep123', 10);
  await prisma.salesRep.upsert({
    where: { username: 'rep1' },
    update: {},
    create: {
      name: 'أحمد محمد', phone: '0501234567', username: 'rep1', passwordHash: repHash,
      canCreateInvoice: true, canCancelInvoice: true, canCreateReceipt: true,
      canChangePrice: true, maxDiscountPct: 10, canViewStatement: true, canAddCustomer: true,
    },
  });

  const cat = await prisma.productCategory.upsert({
    where: { id: 'cat-1' },
    update: {},
    create: { id: 'cat-1', name: 'مواد غذائية' },
  });

  await prisma.product.upsert({
    where: { code: 'P001' },
    update: {},
    create: { code: 'P001', name: 'عصير برتقال 250مل', unit: 'كرتون', basePrice: 50, taxPct: 15, categoryId: cat.id },
  });

  const customerData = {
    name: 'محمد العلي', businessName: 'بقالة العلي للمواد الغذائية',
    commercialReg: '1010234567', taxNumber: '300012345600003',
    phone: '0509876543', city: 'الرياض', district: 'العليا',
    address: 'شارع الملك فهد، مبنى 12',
  };
  await prisma.customer.upsert({
    where: { code: 'C001' },
    update: customerData, // يُحدّث السجل الموجود ببيانات العميل الكاملة
    create: { code: 'C001', ...customerData, creditLimit: 5000, paymentDays: 30 },
  });

  await prisma.companySettings.upsert({
    where: { id: 'company' },
    update: {},
    create: {
      id: 'company',
      name: 'شركة التوزيع المتحدة للمواد الغذائية',
      address: 'الرياض - حي الصناعية - شارع التخصصي',
      taxNumber: '310000000000003',
      commercialReg: '1010111222',
      phone: '0112345678',
      email: 'info@united-dist.com',
    },
  });

  console.log('✅ Seed data inserted');
}

main().catch(console.error).finally(() => prisma.$disconnect());
