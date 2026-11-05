// الحذف الحقيقي بلا نسخة مخفية (أمر المالك ٥ نوفمبر ٢٠٢٦): الصنف يُحذف وتبقى فواتيره باسمه، والعميل ذو المستندات يُرفض حذفه
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { withDeletedProductName } from '../services/deletedProduct';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('لا أرشفة في حذف الصنف ولا العميل: لا deletedAt يُكتب ولا status DELETED', () => {
  const products = read('routes/products.ts');
  const customers = read('routes/customers.ts');
  assert.ok(!/data:\s*\{\s*deletedAt:\s*new Date\(\)/.test(products), 'حذف الصنف ما زال يؤرشف');
  assert.ok(!/data:\s*\{\s*status:\s*'DELETED'\s*\}/.test(customers), 'حذف العميل ما زال يؤرشف');
  // الصنف: لقطة الاسم في بنود الفواتير قبل الحذف، ثم الحذف بالمحرّك داخل المعاملة نفسها
  const fn = products.slice(products.indexOf('async function hardDeleteLocked'));
  assert.match(fn, /invoiceItem\.updateMany\(\{ where: \{ productId: id, itemName: null \}, data: \{ itemName: p\.name \} \}\)/);
  assert.ok(fn.indexOf('itemName: p.name') < fn.indexOf("purgeInTx(tx, tid, 'Product', [id])"), 'اللقطة قبل الحذف');
  // العميل: ذو المستندات يُرفض بالرمز
  assert.match(customers, /code: 'CUSTOMER_HAS_DOCUMENTS'/);
});

test('بند فاتورةٍ صنفُه محذوف يُعرض باسمه من اللقطة — والبند بلا صنفٍ ولا لقطة يبقى كما هو', () => {
  const a = withDeletedProductName({ productId: null, product: null, itemName: 'كرواسان', unitName: 'حبة', qty: 2 });
  assert.equal((a.product as { name: string }).name, 'كرواسان');
  assert.equal((a.product as { unit: string }).unit, 'حبة');
  assert.equal((a.product as { id: null }).id, null);
  const b = { productId: 'p1', product: { name: 'حيّ', unit: 'كرتون' }, itemName: 'قديم' };
  assert.equal(withDeletedProductName(b), b, 'الصنف الحيّ لا يُمسّ');
  const c = { productId: null, product: null, itemName: null };
  assert.equal(withDeletedProductName(c), c, 'بلا لقطة: كما كان حرفياً');
});

test('المحرّك: لقطة اسم الصنف ووحدته في بنود فواتيره قبل فكّ ربطها (كل مسارات الحذف)، والرؤوس التي فرغت تُحذف', () => {
  const eng = read('services/ownerPurge.ts');
  const body = eng.slice(eng.indexOf('export async function purgeInTx('));
  const snapName = body.indexOf("data: { itemName: p.name }");
  const snapUnit = body.indexOf("data: { unitName: p.unit }");
  const nullify = body.indexOf('for (const n of plan.nullify)');
  assert.ok(snapName > 0 && snapUnit > 0 && snapName < nullify && snapUnit < nullify, 'اللقطة قبل التفريغ');
  assert.match(eng, /\['VanLoadItem', 'vanLoadId', 'VanLoad'\]/);
  assert.match(eng, /\['WarehouseEntryItem', 'entryId', 'WarehouseEntry'\]/);
  assert.match(eng, /items: \{ none: \{\} \}/);
});

test('حذف العميل: قفل صفّه ثم العدّ ثم المحرّك في معاملة واحدة — لا تُحذف فاتورةٌ تُكتب في الأثناء', () => {
  const c = read('routes/customers.ts');
  const h = c.slice(c.indexOf("router.delete('/:id', requireAdmin"));
  const lock = h.indexOf('FOR UPDATE');
  const cnt = h.indexOf('tx.invoice.count(');
  const purge = h.indexOf("purgeInTx(tx, tid, 'Customer', [customer.id])");
  assert.ok(lock > 0 && lock < cnt && cnt < purge, 'الترتيب');
});
