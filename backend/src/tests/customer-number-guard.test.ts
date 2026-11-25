// «رقم العميل» (طلب المالك ٢٣ نوفمبر ٢٠٢٦) — حارس ثابت: كل إنشاء عميلٍ في الخادم يمرّ بمساعد الترقيم وحده
// (services/customerNumber.ts: createNumberedCustomer/createNumberedCustomers داخل معاملة الإنشاء وتحت قفل صفّ الشركة).
// إنشاءٌ مباشرٌ في أيّ ملفٍّ آخر يُخرج عميلاً بلا رقم (أو يسابق العدّاد فيكرّر رقماً) — فيفشل هذا الحارس ويسمّي الملف والسطر.
//
// النطاق: كل ملف .ts غير اختباري تحت backend/src (ومنها __fixtures__). أمّا backend/prisma/seed.ts فقديمٌ مهجور — بلا tenantId،
// وخارج tsconfig فلا يُبنى، ولا يشغّله النشر (preDeploy) ولا الخادم؛ وسكربت «db:seed» اليدويّ يفشل عليه قبل أن يبلغ الترقيم أصلاً
// (upsert بـwhere: { code } وحده، والكود لم يعد فريداً إلا مع الشركة) — فيُترك عمداً بلا فحص ولا تعديل.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const HELPER = path.join('services', 'customerNumber.ts');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

/**
 * أنماط إنشاء العميل: المباشر (ولو انقسم على سطرين، أو بالأقواس tx['customer'])، والمتداخل في علاقة — ومنها علاقة المندوب
 * «CustomerCreatedByRep» (SalesRep.createdCustomers) — والـSQL الخام.
 */
const CREATE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'customer.create/createMany/createManyAndReturn/upsert', re: /(?:\.customer|\[['"]customer['"]\])\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/g },
  { name: 'nested customer(s)/createdCustomers: { create… }', re: /\b(?:customers?|createdCustomers)\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert)\b/g },
  { name: 'INSERT INTO customers', re: /INSERT\s+INTO\s+"?customers"?/gi },
];

function hits(src: string): { name: string; line: number; text: string }[] {
  const out: { name: string; line: number; text: string }[] = [];
  for (const p of CREATE_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags);
    for (let m = re.exec(src); m; m = re.exec(src)) {
      out.push({ name: p.name, line: src.slice(0, m.index).split('\n').length, text: m[0] });
    }
  }
  return out;
}

/** ملفات backend/src غير الاختبارية (src/tests وكل *.test.ts خارجها) — مسارات نسبية بفاصل / */
function sourceFiles(dir = SRC, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r === 'tests' || e.name === 'node_modules') continue;
      out.push(...sourceFiles(path.join(dir, e.name), r));
    } else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
      out.push(r);
    }
  }
  return out;
}

test('الحارس نفسه: الأنماط تلتقط كل صيغ الإنشاء ولا تلتقط ما ليس إنشاء عميل', () => {
  const bad = [
    'await prisma.customer.create({ data })',
    'tx.customer.createMany ({ data: rows })',
    'db.customer.createManyAndReturn({ data: rows })',
    'await tx.customer.upsert({ where, create, update })',
    'tenant: { connect: { id } }, customer: { create: { name } }',
    'customers: {\n  createMany: { data: [] }\n}',
    'customer: { connectOrCreate: { where, create } }',
    // علاقة المندوب «CustomerCreatedByRep»: إنشاءٌ متداخل عبر SalesRep.createdCustomers
    'createdCustomers: { create: {} }',
    'createdCustomers: {\n  connectOrCreate: { where, create }\n}',
    // الاستدعاء المنقسم على سطرين وصيغة الأقواس
    'tx.customer\n  .create({})',
    "tx['customer'].create({})",
    'tx["customer"]\n  .upsert({ where, create, update })',
    'await tx.$executeRaw`INSERT INTO "customers" ("id") VALUES (${id})`',
    "await tx.$executeRawUnsafe('insert into customers (id) values ($1)', id)",
  ];
  for (const s of bad) assert.equal(hits(s).length, 1, s);
  const fine = [
    'await tx.customerPrice.create({ data })',
    'await tx.customerPrice.upsert({ where, create, update })',
    'await prisma.customer.update({ where, data })',
    'await prisma.customer.findMany({ where })',
    'await tx.customerAssignment.createMany({ data })',
    'await tx.customer\n  .findFirst({ where })',
    "tx['customerPrice'].create({})",
    'createdCustomersCount: { create: 1 }',
    'documents: { create: rows }',
    'customerId: { in: ids }',
    'await createNumberedCustomer(tx, tid, data)',
    "SELECT 1 FROM customers WHERE id = $1 FOR UPDATE",
  ];
  for (const s of fine) assert.deepEqual(hits(s), [], s);
});

test('لا إنشاء عميلٍ خارج services/customerNumber.ts — كل منشئ (اللوحة والمندوب والاستيراد والربط البرمجي…) يمرّ بالمساعد', () => {
  const files = sourceFiles();
  assert.ok(files.length > 100, `مسحٌ ناقص: ${files.length} ملف`);
  assert.ok(files.includes('routes/customers.ts') && files.includes('routes/import.ts') && files.includes('services/customerNumber.ts'));
  assert.ok(!files.some((f) => f.startsWith('tests/') || f.endsWith('.test.ts')), 'الاختبارات خارج المسح');
  const violations: string[] = [];
  for (const f of files) {
    if (f === HELPER.split(path.sep).join('/')) continue;
    for (const h of hits(read(f))) violations.push(`${f}:${h.line} ${h.name} — ${h.text}`);
  }
  assert.deepEqual(violations, [], `إنشاء عميلٍ بلا رقم — استعمل createNumberedCustomer/createNumberedCustomers:\n${violations.join('\n')}`);
});

test('المساعد هو موضع الإنشاء الوحيد: فيه customer.create تحت قفل صفّ الشركة، ويصدّر واجهة العقد', () => {
  const helper = read(HELPER);
  assert.ok(hits(helper).some((h) => h.text.startsWith('.customer.create')), 'المساعد بلا customer.create');
  assert.match(helper, /FOR\s+NO\s+KEY\s+UPDATE/, 'قفل صفّ الشركة');
  for (const name of ['createNumberedCustomer', 'createNumberedCustomers', 'reserveCustomerNumbers', 'numberUnnumberedCustomers', 'sweepCustomerNumbers', 'customerNumberOr']) {
    assert.match(helper, new RegExp(`export (async )?function ${name}\\b`), name);
  }
  assert.match(helper, /export const CUSTOMER_NUMBER_TX\b/);
});

test('مسارات الإنشاء موصولة بالمساعد في معاملة: POST /customers وPUT لمعرّفٍ مجهول واستيراد العملاء', () => {
  const customers = read('routes/customers.ts');
  const post = customers.slice(customers.indexOf("router.post('/', async"), customers.indexOf('function keepableCustomerId'));
  const put = customers.slice(customers.indexOf('async function createMissingOnPut('), customers.indexOf("router.put('/:id',"));
  // POST: معاملةٌ بجسم — قفل الشركة ثم إعادة فحص clientRef تحته ثم الإنشاء (فرفعان متزامنان للمستند نفسه لا يُنشئان عميلين)
  assert.match(post, /const outcome = await prisma\.\$transaction\(async \(tx\) => \{/, 'POST: داخل معاملة');
  assert.match(post, /\} as any\);\n\s*return \{ replayed: null, created \};\n\s*\}, CUSTOMER_NUMBER_TX\);/, 'POST: بمهلة الترقيم');
  const lockAt = post.indexOf('await lockTenantForCustomerNumbers(tx, tid);');
  const recheckAt = post.indexOf('await tx.customer.findFirst({ where: { tenantId: tid, clientRef: data.clientRef } })');
  const createAt = post.indexOf('await createNumberedCustomer(tx, tid, {');
  assert.ok(post.indexOf('const outcome = await prisma.$transaction(') < lockAt && lockAt < recheckAt && recheckAt < createAt,
    'POST: القفل ثم إعادة فحص clientRef ثم الإنشاء — كلها في المعاملة');
  assert.match(post, /if \(outcome\.replayed\) \{ await replyReplayed\(outcome\.replayed\); return; \}/, 'POST: المُعاد تحت القفل بردّ الفحص الأوّل نفسه');
  assert.match(put, /await prisma\.\$transaction\(\(tx\) => createNumberedCustomer\(tx, tid, \{/, 'PUT-create: داخل معاملة');
  assert.match(put, /\} as any\), CUSTOMER_NUMBER_TX\)/, 'PUT-create: بمهلة الترقيم');
  for (const [name, body] of [['POST', post], ['PUT-create', put]] as const) {
    assert.equal(body.split('createNumberedCustomer(tx, tid, {').length - 1, 1, `${name}: إنشاءٌ واحد بالمساعد`);
    // آثار الاتصال العامّ (الإسناد وتوقّعات المندوب الذكي) بعد الالتزام لا داخل المعاملة
    const created = body.indexOf('CUSTOMER_NUMBER_TX)');
    for (const after of ['await ensureAssignment(tid, customer.id, creatorRepId', 'invalidateEstimateData(tid)']) {
      const i = body.indexOf(after);
      assert.ok(i > created, `${name}: ${after} بعد الالتزام`);
    }
  }
  assert.ok(post.indexOf('linkConvertedCustomer(tid, customer, creatorRepId)') > post.indexOf('CUSTOMER_NUMBER_TX)'), 'ربط المحلّ المحوَّل بعد الالتزام');
  // تصادم المعرّف يُلتقط خارج المعاملة (فيُلغيها كلها ولا يُستهلك رقم) — 'RACED' كما كان
  assert.match(put, /CUSTOMER_NUMBER_TX\)\.catch\(\(err: unknown\) => \{\n\s*if \(keepId && isIdConflict\(err\)\) return null;/);

  const imp = read('routes/import.ts');
  const route = imp.slice(imp.indexOf("router.post('/customers'"), imp.indexOf("router.post('/products'"));
  const write = route.slice(route.indexOf('writeItem: async (tx: Prisma.TransactionClient, { r, phone }) => {'), route.indexOf('flush: (tx, written)'));
  assert.match(write, /const c = await createNumberedCustomer\(tx, tid, \{/, 'الاستيراد في معاملة الشريحة');
  assert.match(write, /return c\.id;/);
});

test('رقم العميل للقراءة وحدها: ليس في مخطّط الإنشاء والتعديل ولا بين مفاتيح الرقم المرجعي — ولا مطابقة به في الاستيراد', () => {
  const customers = read('routes/customers.ts');
  const schema = customers.slice(customers.indexOf('const customerSchema = z.object({'), customers.indexOf('\n});', customers.indexOf('const customerSchema = z.object({')));
  assert.doesNotMatch(schema, /^\s*number\s*:/m, 'number في customerSchema');
  const refKeys = customers.slice(customers.indexOf('const CUSTOMER_REF_KEYS'), customers.indexOf('\n', customers.indexOf('const CUSTOMER_REF_KEYS')));
  assert.doesNotMatch(refKeys, /'number'/, 'number مرجعٌ خارجيّ');
  // مطابقة الاستيراد (الكود ثم الجوال ثم الاسم) لا تقرأ الرقم: كودٌ رقميّ من نظامٍ سابق لا يلتصق برقم عميلٍ آخر
  const match = read('services/importMatch.ts');
  assert.doesNotMatch(match, /customerNumber|\.number\b|number:\s*true/, 'مطابقة الاستيراد بالرقم');
  const imp = read('routes/import.ts');
  assert.doesNotMatch(imp, /customerNumberOr|customerNumberQuery/, 'الاستيراد لا يبحث بالرقم');
});
