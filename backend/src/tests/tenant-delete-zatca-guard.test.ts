// فوترة ZATCA (Z5.0، F12) — حذف شركة لها وحدة فوترة إلكترونية: 409 TENANT_HAS_EINVOICE_ARCHIVE قبل أي حذف، بدل P2003 من قيود
// onDelete: Restrict يصل مالك المنصة 500. الحارس النقيّ + فحص نصّي لموضعه في DELETE /api/tenants/:id وسبب وجوده في المخطّط.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tenantDeleteArchiveBlock } from '../compliance/zatca/settingsGuards';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('الحارس النقيّ: وحدة واحدة أو أكثر ⇒ 409 برسالة عربية؛ صفر ⇒ null (الحذف كما اليوم)', () => {
  for (const n of [0, -1, Number.NaN]) assert.equal(tenantDeleteArchiveBlock(n), null, String(n));
  for (const n of [1, 3]) {
    assert.deepEqual(tenantDeleteArchiveBlock(n), {
      status: 409, body: { success: false, code: 'TENANT_HAS_EINVOICE_ARCHIVE', message: 'لا يمكن حذف شركة لديها سجل فوترة إلكترونية (يلزم حفظه نظاماً)' },
    });
  }
});

test('الموضع: بعد التحقق من وجود الشركة وقبل حارس الدفاتر وقبل أي حذف أو معاملة، بعدّ وحدات الشركة نفسها', () => {
  const src = strip(fs.readFileSync(path.join(__dirname, '..', 'routes', 'tenants.ts'), 'utf8').replace(/\r\n/g, '\n'));
  const start = src.indexOf("router.delete('/:id',");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n});', start));
  const exists = body.indexOf("if (!tenant) { res.status(404)");
  const count = body.indexOf('tenantDeleteArchiveBlock(await prisma.zatcaEgsUnit.count({ where: { tenantId: tid } }))');
  const refuse = body.indexOf('if (einvoiceArchive) { res.status(einvoiceArchive.status).json(einvoiceArchive.body); return; }');
  const gl = body.indexOf('prisma.glSettings.findUnique(');
  const tx = body.indexOf('$transaction(');
  const head = body.indexOf('=>');
  const firstDelete = head + body.slice(head).search(/\.delete(Many)?\(/);
  assert.ok(exists > 0 && exists < count && count < refuse, 'الحارس بعد التحقق من الوجود');
  assert.ok(refuse < gl && refuse < tx && refuse < firstDelete, 'الحارس قبل الدفاتر والمعاملة وأول حذف');
  assert.equal(body.split('zatcaEgsUnit.count(').length - 1, 1);
});

test('السبب في المخطّط: وحدة الفوترة ومستنداتها بـonDelete: Restrict على الشركة', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
  for (const model of ['ZatcaEgsUnit', 'ZatcaDocument']) {
    const m = schema.slice(schema.indexOf(`model ${model} {`), schema.indexOf('\n}', schema.indexOf(`model ${model} {`)));
    assert.match(m, /tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Restrict\)/, model);
  }
});
