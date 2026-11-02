import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC_GROUPS, API_DOC_GUIDES } from './apiDocsCatalog';
import { API_SYNC_RESOURCES } from './apiDocsData';

/**
 * ما يلزم المُكامِل من حدود «التشغيلات على مستوى السطر» (مراجعة ٢ نوفمبر ٢٠٢٦): البطاقة المضمّنة تُقرأ لحظة السحب ولا تُعاد
 * بتعديل تاريخيها، وترتيب صفوف البند ثابتٌ لا يدلّ على أولوية، وتحويل وحدة الأساس يضرب التوزيع المضمّن، وأسطر /returnable
 * تحمل lineRef. كل وعدٍ مقرونٌ بسلوك الخادم، فإن تغيّر الخادم (صار التعديل يحرّك المستند مثلاً) فشل هذا ليُصحَّح المستند.
 */
const BACKEND = path.resolve(process.cwd(), '..', 'backend');
const read = (...p: string[]) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8').replace(/\r\n/g, '\n');
const what = (n: string) => API_SYNC_RESOURCES.find((r) => r.name === n)!.what;
const endpointOf = (method: string, p: string) => {
  const e = API_DOC_GROUPS.flatMap((g) => g.endpoints).find((x) => x.method === method && x.path === p);
  assert.ok(e, `${method} ${p} غير موثّق`);
  return e!;
};
const lineStep = () => API_DOC_GUIDES.find((g) => g.key === 'lots-guide')!.steps.find((s) => s.title === 'اقرأ التشغيلة من السطر نفسه')!;
/** كتلة معالجٍ في موجّه حتى المعالج التالي */
const handler = (src: string, head: string) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  const next = src.indexOf('\nrouter.', at + head.length);
  return src.slice(at, next > 0 ? next : undefined);
};

test('البطاقة المضمّنة: تُقرأ لحظة السحب وتعديل تاريخيها لا يعيد السطر — والمستند يحيل إلى product-lots ويفرّق لقطة الإصدار', () => {
  // الخادم: PATCH /lots/:id يكتب البطاقة وسجلّها وحدهما، فلا يتحرّك طابع فاتورةٍ ولا حركة
  const patch = handler(read('src', 'routes', 'lots.ts'), "router.patch('/:id',");
  assert.match(patch, /tx\.productLot\.updateMany\(/);
  assert.match(patch, /productionDate: dayDate\(nextProd\), expiryDate: dayDate\(nextExp\)/);
  for (const m of ['invoice', 'invoiceItem', 'invoiceItemLot', 'vanLoad', 'vanLoadItem', 'vanLoadItemLot', 'warehouseEntry', 'warehouseEntryItem']) {
    assert.ok(!new RegExp(`tx\\.${m}\\.(update|updateMany|upsert)\\(`).test(patch), `PATCH /lots/:id يحرّك ${m}`);
  }
  // وwarehouse-entries بطابع الإنشاء: لا يُعاد بندٌ أبداً
  const sync = read('src', 'services', 'apiSync.ts');
  const wh = sync.slice(sync.indexOf("name: 'warehouse-entries', model:"), sync.indexOf('\n', sync.indexOf("name: 'warehouse-entries', model:")));
  assert.match(wh, /mode: 'created'/);
  assert.equal(API_SYNC_RESOURCES.find((r) => r.name === 'warehouse-entries')!.mode, 'created');
  // المستند: الموارد الثلاثة والخطوة ومقدمة lots وصفحة الربط
  for (const r of ['invoices', 'van-loads', 'warehouse-entries']) {
    assert.match(what(r), /كما هي لحظة السحب/, `${r}: لحظة السحب`);
    assert.match(what(r), /PATCH \/api\/lots\/:id/, `${r}: سبب البلى`);
    assert.match(what(r), /التاريخين الحيّين وحالة البطاقة من product-lots بـlotId/, `${r}: المرجع الحيّ`);
  }
  // لقطة الإصدار في صفّ الفاتورة لا تتغيّر — والخادم يقول ذلك في PATCH
  assert.match(what('invoices'), /expiryDate في الصفّ نفسه فلقطة انتهاء التشغيلة عند الإصدار لا تتغيّر/);
  assert.match(read('src', 'routes', 'lots.ts'), /InvoiceItemLot\.expiryDate لا تتغيّر/);
  const step = lineStep();
  assert.match(step.text, /بطاقة lot في السطر تُقرأ لحظة السحب/);
  assert.match(step.text, /items\[\]\.lots\[\]\.expiryDate في invoices فلقطة انتهاء التشغيلة عند الإصدار/);
  assert.match(API_DOC_GROUPS.find((g) => g.key === 'lots')!.overview, /كما هي لحظة السحب \(تعديل تاريخيها لاحقاً لا يعيد إرسال المستند/);
  const docs = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'ApiDocs.tsx'), 'utf8');
  assert.ok(docs.includes('كما هي لحظة السحب (تعديل تاريخيها لاحقاً لا يعيد إرسال المستند'), 'صفحة الربط');
});

test('ترتيب صفوف البند: ثابتٌ بـcreatedAt ثم id لا «ترتيب إنشاء» — الصفوف تُكتب معاً بمعرّف uuid', () => {
  // الخادم: صفوف البند الواحد إنشاءٌ متداخلٌ واحد، والمعرّف uuid، فالتعادل في createdAt يحسمه معرّفٌ عشوائي
  const lots = read('src', 'services', 'lots.ts');
  const cols = lots.slice(lots.indexOf('export function invoiceItemLotColumns('), lots.indexOf('\n}\n', lots.indexOf('export function invoiceItemLotColumns(')));
  assert.match(cols, /out\.lots = \{\s*create: entry\.rows\.map\(/);
  const schema = read('prisma', 'schema.prisma');
  for (const model of ['InvoiceItemLot', 'VanLoadItemLot']) {
    const block = schema.slice(schema.indexOf(`model ${model} {`), schema.indexOf('\n}', schema.indexOf(`model ${model} {`)));
    assert.match(block, /id\s+String\s+@id @default\(uuid\(\)\)/, `${model}.id`);
    assert.match(block, /createdAt\s+DateTime\s+@default\(now\(\)\)/, `${model}.createdAt`);
  }
  assert.ok(read('src', 'services', 'apiSync.ts').includes("const LINE_LOTS_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }];"));
  // المستند: لا «ترتيب الإنشاء» لصفوف التوزيع، والتحذير من استنتاج الأولوية حاضر
  const texts = [what('invoices'), what('van-loads'), lineStep().text, API_DOC_GROUPS.find((g) => g.key === 'lots')!.overview];
  for (const t of texts) {
    assert.ok(!/بترتيب (الإنشاء|إنشائها)/.test(t), `«ترتيب الإنشاء» باقٍ: ${t.slice(0, 60)}`);
    assert.match(t, /createdAt ثم id/);
  }
  for (const t of [what('invoices'), what('van-loads'), lineStep().text]) assert.match(t, /لا تستنتج منه أولوية/);
});

test('تحويل وحدة الأساس: المستند يأمر بضرب التوزيع المضمّن مع baseQty — كما يضربه الخادم في التحويل نفسه', () => {
  const products = read('src', 'routes', 'products.ts');
  assert.match(products, /UPDATE "invoice_item_lots" SET "quantity" = "quantity" \* \$\{F\}::float8/);
  assert.match(products, /UPDATE "van_load_item_lots" SET "qty" = "qty" \* \$\{F\}::float8/);
  const rule = endpointOf('POST', '/products/:id/convert-base').rules.find((r) => r.startsWith('لنظامكم:'));
  assert.ok(rule, 'قاعدة «لنظامكم» غائبة');
  assert.ok(rule!.includes('items[].lots[].quantity في invoices'), 'quantity المضمّنة');
  assert.ok(rule!.includes('items[].lots[].qty في van-loads'), 'qty المضمّنة');
  const sync = API_DOC_GUIDES.find((g) => g.key === 'lots-guide')!.steps.find((s) => s.title === 'أبقِ نظامكم متزامناً')!;
  assert.match(sync.text, /ومعها items\[\]\.lots المضمّنة في invoices \(quantity\) وvan-loads \(qty\)/);
});

test('GET /invoices/:id/returnable: أسطره تحمل lineRef كما يعيده الخادم، وcreditable لا يحمله والمستند يقول ذلك', () => {
  const inv = read('src', 'routes', 'invoices.ts');
  const ret = handler(inv, "router.get('/:id/returnable',");
  assert.match(ret, /lineRef: true,/, 'select');
  assert.match(ret, /lineRef: it\.lineRef \?\? null,/, 'السطر');
  const e = endpointOf('GET', '/invoices/:id/returnable');
  assert.match(e.response, /lines:\[\{saleItemId, productId, name, code, lineRef,/);
  assert.ok(e.rules.some((r) => r.startsWith('lineRef «مرجع السطر» لبند البيع كما حُفظ') && r.includes('null لما لم يُرسَل')), 'قاعدة lineRef');
  assert.match(API_DOC_GROUPS.find((g) => g.key === 'invoices')!.overview, /وأسطر GET \/invoices\/:id\/returnable \(لبند البيع؛ وGET \/invoices\/:id\/creditable لا يحمله\)/);
  // creditable: CreditableLine بلا lineRef في الخادم، والمستند لا يَعِد به ويدلّ على مصدره
  const notes = read('src', 'compliance', 'zatca', 'notes.ts');
  const line = notes.slice(notes.indexOf('export interface CreditableLine {'), notes.indexOf('\n}', notes.indexOf('export interface CreditableLine {')));
  assert.ok(line.length > 100 && !line.includes('lineRef'), 'CreditableLine صار يحمل lineRef: حدّث المستند');
  const c = endpointOf('GET', '/invoices/:id/creditable');
  assert.ok(!/\blineRef\b/.test(c.response), 'creditable لا يعيد lineRef');
  assert.ok(c.rules.some((r) => r.startsWith('lines لا تحمل lineRef')), 'قاعدة creditable');
});

test('GET /van-stock/movements: lineRef حاضرٌ لكل بند، وnull لبند فاتورةٍ خارج نطاق المقيَّد — كما يحجبه الخادم مع رقمها', () => {
  const van = read('src', 'routes', 'vanStock.ts');
  const mv = handler(van, "router.get('/movements',");
  assert.match(mv, /lineRef: i\.lineRef \?\? null,/, 'بنود حركات السيارة');
  assert.match(mv, /lineRef: !visible \|\| visible\.has\(inv\.id\) \? \(i\.lineRef \?\? null\) : null,/, 'بنود الفواتير بالنطاق');
  assert.match(mv, /'مستند خارج نطاقك'/);
  const e = endpointOf('GET', '/van-stock/movements');
  assert.match(e.response, /lineRef\(«مرجع السطر» المحفوظ على بند الحركة أو الفاتورة، وnull لما لم يُرسَل ولبند فاتورةٍ خارج نطاق المستخدم المقيَّد\)/);
  assert.ok(e.rules.some((r) => r.includes('«مستند خارج نطاقك» وlineRef بنودها null')), 'قاعدة النطاق');
});
