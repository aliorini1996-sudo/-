import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس «توقيع المستلم» على فواتير المندوب — اختبارٌ ثابت يقرأ المصدر.
 *
 * ثلاثة أسئلة: هل الميزة **خلف مفتاح المالك** فعلاً في الخادم (لا في الواجهة وحدها)؟
 * هل الصورة **خارج جدول الفواتير** كي لا تُحمَّل مع كل قائمة؟ وهل يصل التوقيع للمستند
 * المطبوع من الخادم لا من رسمٍ محلّيٍّ ربما لم يُحفظ؟
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('المخطّط: مفتاحٌ لكل شركة مطفأ افتراضياً، والصورة في جدولٍ مستقلّ يُحذف مع فاتورته', () => {
  const s = read('prisma', 'schema.prisma');
  assert.match(s, /invoiceSignatureEnabled\s+Boolean\s+@default\(false\)/);
  const model = s.match(/model InvoiceSignature \{[\s\S]*?\n\}/);
  assert.ok(model, 'جدول التوقيع غير موجود');
  assert.match(model![0], /invoiceId\s+String\s+@id/);
  assert.match(model![0], /onDelete: Cascade/);
  const invoice = s.match(/model Invoice \{[\s\S]*?\n\}/)![0];
  assert.doesNotMatch(invoice, /\n\s+(recipientSignature|signatureImage)\s+String/, 'صورة التوقيع عمودٌ في جدول الفواتير');
});

test('الخادم: التوقيع يُحفظ فقط والمفتاح مفعّل، ولا توقيع على مرتجع، والصيغة PNG محدودة الحجم', () => {
  const src = read('src', 'routes', 'invoices.ts');
  assert.match(src, /recipientSignature: z\.string\(\)\.max\(300_000/);
  assert.match(src, /data:image\\\/png;base64/);
  const gate = src.slice(src.indexOf('const signatureImage'), src.indexOf('const signatureImage') + 400);
  assert.match(gate, /body\.type !== 'RETURN'/);
  assert.match(gate, /invoiceSignatureEnabled === true/);
  assert.match(src, /\.\.\.\(signatureImage && \{ signature: \{ create: \{ tenantId: tid, image: signatureImage \} \} \}\)/);
});

test('الخادم: التفصيل يُرجع التوقيع، والشركة تعرف المفتاح، والمالك يستطيع تبديله', () => {
  const inv = read('src', 'routes', 'invoices.ts');
  const detail = inv.slice(inv.indexOf("router.get('/:id'"), inv.indexOf("router.post('/'"));
  assert.match(detail, /signature: \{ select: \{ image: true/);
  assert.match(read('src', 'routes', 'company.ts'), /invoiceSignatureEnabled: tenant\?\.invoiceSignatureEnabled === true/);
  assert.match(read('src', 'routes', 'tenants.ts'), /invoiceSignatureEnabled: z\.boolean\(\)\.optional\(\)/);
});

test('الواجهة: اللوحة خلف المفتاح الصريح وليست على مرتجع، والمستند المتّصل يطبع توقيع الخادم', () => {
  const app = read('..', 'web-admin', 'src', 'rep', 'RepApp.tsx');
  assert.match(app, /const signatureOn = !isReturn && \(company as \{ invoiceSignatureEnabled\?: boolean \} \| null\)\?\.invoiceSignatureEnabled === true;/);
  assert.match(app, /recipientSignature: inv\.signature\?\.image \?\? null/);
  // تعديل الأصناف بعد التوقيع يُسقطه
  assert.match(app, /Math\.abs\(signature\.total - total\) > 0\.001/);
  const docs = read('..', 'web-admin', 'src', 'rep', 'RepDocuments.tsx');
  assert.match(docs, /recipientSignature: inv\.signature\?\.image \?\? null/);
  assert.match(docs, /isSignatureSrc\(doc\.recipientSignature\)/);
});
