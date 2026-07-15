import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { authenticate, requireAdmin, tenantId } from '../middleware/auth';
import { AuthRequest } from '../types';

// ============================================================================
// استيراد بيانات الشركات من أنظمتها السابقة (Excel → صفوف JSON من الواجهة).
// كل استيراد معزول لشركة المستخدم (tenantId)، عبر منطق النظام (لا مساس مباشر بـ DB).
// المرحلة 1: العملاء + المنتجات. (الأرصدة/دفتر الأستاذ/الأسعار لاحقاً.)
// ============================================================================

const router = Router();
router.use(authenticate, requireAdmin);

const CHANNELS = ['MT', 'WHOLESALE', 'TT', 'DISCOUNTER', 'CASH_VAN', 'ECOMMERCE'];

type ImportResult = { created: number; skipped: number; total: number; errors: { row: number; message: string }[] };

// ===== استيراد العملاء =====
const customerRow = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional().default(''),
  code: z.string().trim().optional(),            // كود العميل في النظام السابق (لربط الأرصدة لاحقاً)
  businessName: z.string().trim().optional(),
  commercialReg: z.string().trim().optional(),
  taxNumber: z.string().trim().optional(),
  city: z.string().trim().optional(),
  district: z.string().trim().optional(),
  address: z.string().trim().optional(),
  channel: z.string().trim().optional(),
  creditLimit: z.number().nonnegative().optional(),
  paymentDays: z.number().int().nonnegative().optional(),
});

router.post('/customers', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = z.array(customerRow).max(5000).parse(req.body?.rows);
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };

    // موجودون مسبقاً (جوال/كود) لتفادي التكرار
    const existing = await prisma.customer.findMany({ where: { tenantId: tid }, select: { phone: true, code: true } });
    const phones = new Set(existing.map(e => e.phone).filter(Boolean));
    const codes = new Set(existing.map(e => e.code).filter(Boolean));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        if ((r.phone && phones.has(r.phone)) || (r.code && codes.has(r.code))) { result.skipped++; continue; }
        await prisma.customer.create({
          data: {
            tenantId: tid,
            name: r.name,
            phone: r.phone || '—',
            businessName: r.businessName || null,
            commercialReg: r.commercialReg || null,
            taxNumber: r.taxNumber || null,
            city: r.city || null,
            district: r.district || null,
            address: r.address || null,
            channel: r.channel && CHANNELS.includes(r.channel) ? r.channel : null,
            creditLimit: r.creditLimit ?? 0,
            paymentDays: r.paymentDays ?? 30,
            ...(r.code ? { code: r.code } : {}),
          } as never,
        });
        result.created++;
        if (r.phone) phones.add(r.phone);
        if (r.code) codes.add(r.code);
      } catch (e) {
        result.errors.push({ row: i + 2, message: (e as Error).message?.slice(0, 140) || 'خطأ غير معروف' });
      }
    }
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

// ===== استيراد المنتجات =====
const productRow = z.object({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  unit: z.string().trim().optional().default('حبة'),
  basePrice: z.number().nonnegative().optional().default(0),
  taxPct: z.number().min(0).max(100).optional(),
  barcode: z.string().trim().optional(),
  category: z.string().trim().optional(),         // اسم الفئة — تُنشأ إن لزم
});

router.post('/products', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const tid = tenantId(req);
    const rows = z.array(productRow).max(5000).parse(req.body?.rows);
    const result: ImportResult = { created: 0, skipped: 0, total: rows.length, errors: [] };

    const company = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { defaultVatPct: true } });
    const defaultVat = company?.defaultVatPct ?? 15;

    const existing = await prisma.product.findMany({ where: { tenantId: tid }, select: { code: true } });
    const codes = new Set(existing.map(e => e.code));

    // خريطة فئات موجودة/جديدة بالاسم
    const cats = await prisma.productCategory.findMany({ where: { tenantId: tid }, select: { id: true, name: true } });
    const catByName = new Map(cats.map(c => [c.name.trim(), c.id]));

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      try {
        if (codes.has(r.code)) { result.skipped++; continue; }
        let categoryId: string | null = null;
        if (r.category) {
          categoryId = catByName.get(r.category) ?? null;
          if (!categoryId) {
            const nc = await prisma.productCategory.create({ data: { tenantId: tid, name: r.category } });
            categoryId = nc.id; catByName.set(r.category, nc.id);
          }
        }
        await prisma.product.create({
          data: {
            tenantId: tid, code: r.code, name: r.name, unit: r.unit || 'حبة',
            basePrice: r.basePrice ?? 0, taxPct: r.taxPct ?? defaultVat,
            barcode: r.barcode || null, categoryId,
          } as never,
        });
        result.created++;
        codes.add(r.code);
      } catch (e) {
        result.errors.push({ row: i + 2, message: (e as Error).message?.slice(0, 140) || 'خطأ غير معروف' });
      }
    }
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
});

export default router;
