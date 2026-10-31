// «لوكيشن» (services/locations.ts + routes/locations.ts) — مواقع الشركة وختم الفواتير والتحميلات بموقع المندوب وقت الإصدار.
// البناء الصافي، ثم حرّاسٌ نصّية على **كل** مسار يُنشئ فاتورةً أو تحميلاً (مسارٌ جديد بلا ختمٍ يُفشل هذا)، والبوّابة والعَلَم
// والنطاق، ثم المعالجات الحقيقية فوق Prisma مزيّف في الذاكرة (الإسناد والأرشفة والحذف والملخّص وختم التحميل).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLocationsSummary, inheritedLocation, locationDocWhere, locationFilterOf, locationName, locationPointProblem, repStampLocation,
  type ProductInfo,
} from '../services/locations';

const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const schema = fs.readFileSync(path.join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8').replace(/\r\n/g, '\n');
const modelBlock = (name: string) => {
  const i = schema.indexOf(`model ${name} {`);
  assert.ok(i >= 0, `النموذج ${name} مفقود`);
  return schema.slice(i, schema.indexOf('\n}', i));
};

// ═══ الدوالّ الصافية ═══

test('الختم الجديد: موقع المندوب والميزة مفعّلة وحدها — المطفأة لا يُكتب لها ختمٌ أبداً', () => {
  const on = { locationsEnabled: true };
  assert.equal(repStampLocation({ locationId: 'L1', tenant: on }), 'L1');
  assert.equal(repStampLocation({ locationId: null, tenant: on }), null, 'مندوبٌ بلا موقع');
  assert.equal(repStampLocation({ locationId: '', tenant: on }), null);
  assert.equal(repStampLocation({ locationId: 'L1', tenant: { locationsEnabled: false } }), null, 'الإطفاء يوقف الختم ويُبقي الإسناد');
  assert.equal(repStampLocation({ locationId: 'L1' }), null, 'بلا عَلَم مقروء ⇒ لا ختم (فشلٌ مغلق)');
  assert.equal(repStampLocation({ locationId: 'L1', tenant: null }), null);
  assert.equal(repStampLocation(null), null);
  assert.equal(repStampLocation(undefined), null);
});

test('الإرث: المرتبط يأخذ ختم أصله كما هو — null لأصلٍ بلا ختم', () => {
  assert.equal(inheritedLocation({ locationId: 'L2' }), 'L2');
  assert.equal(inheritedLocation({ locationId: null }), null);
  assert.equal(inheritedLocation({}), null);
  assert.equal(inheritedLocation(null), null);
});

test('فلتر الموقع: نصٌّ وحده، none = «بلا موقع»، وكائن qs يُهمل — ومفتاحٌ عدديّ واحد لا AND/OR', () => {
  assert.equal(locationFilterOf(undefined), undefined);
  assert.equal(locationFilterOf(''), undefined);
  assert.equal(locationFilterOf({ not: 'L1' }), undefined, 'locationId[not]=x لا يصير شرط Prisma');
  assert.equal(locationFilterOf(['L1', 'L2']), undefined);
  assert.equal(locationFilterOf('none'), null);
  assert.equal(locationFilterOf('L1'), 'L1');
  assert.deepEqual(locationDocWhere(undefined), {});
  assert.deepEqual(locationDocWhere(null), { locationId: null });
  assert.deepEqual(locationDocWhere('L1'), { locationId: 'L1' });
  for (const w of [locationDocWhere(null), locationDocWhere('L1')]) {
    assert.deepEqual(Object.keys(w), ['locationId'], 'لا مفتاح AND/OR يمحو النطاق أو البحث عند النشر');
  }
});

test('اسم الموقع ونقطته: تشذيبٌ وطيّ فراغ وحدّ ٦٠، والنقطة زوجٌ ضمن المدى أو لا شيء', () => {
  assert.equal(locationName('  فرع   الرياض '), 'فرع الرياض');
  assert.equal(locationName('x'.repeat(80)).length, 60);
  assert.equal(locationPointProblem(null, null), null, 'بلا نقطة مقبول (مدينة)');
  assert.equal(locationPointProblem(undefined, undefined), null);
  assert.equal(locationPointProblem(24.71, 46.67), null);
  assert.match(String(locationPointProblem(24.71, null)), /معا/);
  assert.match(String(locationPointProblem(null, 46.67)), /معا/);
  assert.match(String(locationPointProblem(91, 46)), /العرض/);
  assert.match(String(locationPointProblem(24, -181)), /الطول/);
  assert.match(String(locationPointProblem(Number.NaN, 46)), /العرض/);
});

const LOCS = [
  { id: 'L1', name: 'الرياض', isActive: true, lat: 24.71, lng: 46.67 },
  { id: 'L2', name: 'جدة', isActive: true, lat: null, lng: null },
  { id: 'L3', name: 'الدمام', isActive: false, lat: null, lng: null }, // مؤرشف بلا حركة
  { id: 'L4', name: 'أبها', isActive: false, lat: null, lng: null }, // مؤرشف بحركة في الفترة
];
const PRODUCTS = new Map<string, ProductInfo>([['P1', { name: 'شاهي', unit: 'علبة' }], ['P2', { name: 'سكر', unit: 'كيس' }]]);

test('الملخّص: البيع والمرتجع لكل موقع بختم المستند، والإشعار المدين (CREDIT) بيع والدائن (RETURN) مرتجع', () => {
  const s = buildLocationsSummary([
    { locationId: 'L1', type: 'CASH', amount: 100.1234, count: 2 },
    { locationId: 'L1', type: 'CREDIT', amount: 50, count: 1 }, // ومعها إشعارٌ مدين مخزَّن CREDIT
    { locationId: 'L1', type: 'RETURN', amount: 30, count: 1 },
    { locationId: null, type: 'CASH', amount: 7, count: 1 },
    { locationId: 'GONE', type: 'CREDIT', amount: 3, count: 1 }, // موقعٌ حُذف بين الاستعلامين ⇒ «بلا موقع» لا يضيع
    { locationId: 'L4', type: 'RETURN', amount: 5, count: 1 },
  ], [], LOCS, PRODUCTS);
  const l1 = s.rows.find((r) => r.locationId === 'L1')!;
  assert.deepEqual(l1.sales, { count: 3, amount: 150.123 }, 'المبالغ بثلاث منازل');
  assert.deepEqual(l1.returns, { count: 1, amount: 30 });
  assert.equal(l1.net, 120.123);
  assert.deepEqual(s.none.sales, { count: 2, amount: 10 });
  assert.equal(s.none.locationId, null);
  assert.equal(s.none.name, null);
  // الفعّال يظهر ولو بلا حركة، والمؤرشف بحركته وحدها، والفعّال أولاً ثم بالاسم
  assert.deepEqual(s.rows.map((r) => r.locationId), ['L1', 'L2', 'L4'], 'الرياض ثم جدة (الفعّال بالاسم) ثم أبها المؤرشف');
  assert.equal(s.rows.find((r) => r.locationId === 'L4')!.isActive, false);
  assert.ok(!s.rows.some((r) => r.locationId === 'L3'), 'المؤرشف بلا حركة لا يُعرض');
  // الإجمالي = الصفوف + «بلا موقع» بلا ازدواج
  assert.deepEqual(s.totals.sales, { count: 5, amount: 160.123 });
  assert.deepEqual(s.totals.returns, { count: 2, amount: 35 });
  assert.equal(s.totals.net, 125.123);
});

test('الملخّص: التحميلات عدداً وكمياتٍ إجمالاً ولكل صنف (بالكمية تنازلياً) — بلا مبلغٍ مُختلَق', () => {
  const s = buildLocationsSummary([], [
    { locationId: 'L2', items: [{ productId: 'P1', qty: 10 }, { productId: 'P2', qty: 4.5 }] },
    { locationId: 'L2', items: [{ productId: 'P2', qty: 8 }] },
    { locationId: null, items: [{ productId: 'P1', qty: 1 }] },
    { locationId: 'L3', items: [{ productId: 'X', qty: 2 }] }, // مؤرشف بتحميلٍ في الفترة ⇒ يظهر
  ], LOCS, PRODUCTS);
  const l2 = s.rows.find((r) => r.locationId === 'L2')!;
  assert.equal(l2.loads.count, 2);
  assert.equal(l2.loads.qty, 22.5);
  assert.deepEqual(l2.loads.products, [
    { productId: 'P2', name: 'سكر', unit: 'كيس', qty: 12.5 },
    { productId: 'P1', name: 'شاهي', unit: 'علبة', qty: 10 },
  ]);
  assert.ok(!('value' in l2.loads), 'لا قيمة: لا كلفة مخزّنة لكل تحميل');
  assert.equal(s.none.loads.count, 1);
  assert.deepEqual(s.rows.find((r) => r.locationId === 'L3')!.loads.products, [{ productId: 'X', name: '', unit: null, qty: 2 }], 'صنفٌ بلا اسمٍ مقروء لا يسقط');
  assert.deepEqual(s.totals.loads, { count: 4, qty: 25.5 });
  // موقعٌ فعّال بلا أيّ حركة: صفرٌ صريح لا غياب
  assert.deepEqual(s.rows.find((r) => r.locationId === 'L1')!.loads, { count: 0, qty: 0, products: [] });
});

// ═══ حرّاسٌ نصّية: المخطط ═══

test('المخطط: إضافيٌّ وحده — عَلَم مطفأ، نموذجٌ جديد، وأعمدةٌ اختيارية بـSetNull بلا @@unique على الجداول القائمة', () => {
  assert.match(modelBlock('Tenant'), /\n\s*locationsEnabled\s+Boolean\s+@default\(false\)/, 'العَلَم مطفأ افتراضياً');
  const loc = modelBlock('SalesLocation');
  assert.match(loc, /@@map\("sales_locations"\)/);
  assert.match(loc, /\n\s*name\s+String\n/);
  assert.match(loc, /\n\s*lat\s+Float\?\n/);
  assert.match(loc, /\n\s*lng\s+Float\?\n/);
  assert.match(loc, /\n\s*isActive\s+Boolean\s+@default\(true\)/);
  assert.match(loc, /tenant\s+Tenant\s+@relation\(fields: \[tenantId\], references: \[id\], onDelete: Cascade\)/);
  for (const m of ['SalesRep', 'Invoice', 'VanLoad']) {
    const b = modelBlock(m);
    assert.match(b, /\n\s*locationId\s+String\?\s*\n/, `${m}.locationId اختياريّ`);
    assert.match(b, /\n\s*location\s+SalesLocation\?\s+@relation\(fields: \[locationId\], references: \[id\], onDelete: SetNull\)/, `${m}: SetNull — حذف الموقع لا يحذف مستنداً`);
    for (const line of b.split('\n').filter((l) => l.includes('@@unique'))) {
      assert.ok(!line.includes('locationId'), `${m}: لا @@unique جديد على جدولٍ قائم`);
    }
  }
  // لا خلط مع جدول التتبّع: نقاط GPS تبقى RepLocation
  assert.match(modelBlock('SalesRep'), /\n\s*locations\s+RepLocation\[\]/);
});

// ═══ حرّاسٌ نصّية: كل مسار إنشاء يختم ═══

/** ملفات المصدر (بلا الاختبارات) — لجرد مسارات الإنشاء */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests') sourceFiles(p, out); continue; }
    if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, '/');
/** مقطع الإنشاء: من نداء create إلى أول include بعده (حيث تنتهي البيانات) */
const createBlock = (src: string, call: string) => {
  const i = src.indexOf(call);
  assert.ok(i >= 0, `نداء الإنشاء مفقود: ${call}`);
  return src.slice(i, src.indexOf('include:', i));
};

test('جرد: الفواتير تُنشأ في ثلاثة مواضع والتحميلات في موضعٍ واحد — موضعٌ جديد يُفشل هذا حتى يُختم', () => {
  const inv = new Map<string, number>();
  const van = new Map<string, number>();
  for (const f of sourceFiles(SRC)) {
    const s = fs.readFileSync(f, 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
    const ni = (s.match(/\.invoice\.(create|createMany|upsert)\(/g) ?? []).length;
    const nv = (s.match(/\.vanLoad\.(create|createMany|upsert)\(/g) ?? []).length;
    if (ni) inv.set(rel(f), ni);
    if (nv) van.set(rel(f), nv);
  }
  assert.deepEqual([...inv.entries()].sort(), [['routes/invoices.ts', 1], ['routes/invoicesNotes.ts', 1], ['routes/invoicesZatca.ts', 1]],
    'مسار إنشاء فاتورة جديد: اختمه بموقع المندوب (repStampLocation) أو أورثه من أصله ثم حدّث هذا الجرد');
  assert.deepEqual([...van.entries()], [['routes/vanStock.ts', 1]], 'مسار إنشاء تحميل جديد: اختمه ثم حدّث هذا الجرد');
});

test('المرحلة الأولى: الختم من صفّ المندوب القائم (العَلَم في include نفسه)، والمرتجع المرتبط يرث من صفّ بيعه المقفل', () => {
  const inv = read('routes', 'invoices.ts');
  // ومعه عَلَم «تتبّع اللوط» في القراءة نفسها (§٤.٨ البند ١) — لا استعلام
  assert.ok(inv.includes("include: { tenant: { select: { locationsEnabled: true, lotTrackingEnabled: true, settings: { select: { teamsEnabled: true } } } }, teamMemberships:"), 'العَلَم في القراءة نفسها — لا استعلام');
  assert.ok(inv.includes('const docLocationId = repStampLocation(rep);'));
  assert.ok(inv.indexOf('const docLocationId = repStampLocation(rep);') > inv.indexOf("if (!rep) { res.status(404).json({ success: false, message: 'المندوب غير موجود' }); return; }"));
  // داخل المعاملة: الإرث من التحقق المقفل نفسه (لا استعلام زائد) قبل الإنشاء
  const tx = inv.slice(inv.indexOf('return prisma.$transaction(async tx => {'), inv.indexOf('const inv = await tx.invoice.create({'));
  assert.ok(tx.includes('let invLocationId = docLocationId;'));
  assert.ok(tx.includes('const saleLink = await assertReturnLinks(tx, { tenantId: tid, customerId, saleInvoiceId: saleForReturn, lines: saleLinkLines, lock: true });'));
  assert.ok(tx.includes('invLocationId = inheritedLocation(saleLink);'));
  assert.ok(createBlock(inv, 'const inv = await tx.invoice.create({').includes('...(invLocationId && { locationId: invLocationId }),'), 'المسار القديم يكتب الختم');
  const svc = read('services', 'returnLinks.ts');
  assert.match(svc, /select: \{ customerId: true, type: true, status: true, documentKind: true, locationId: true,/, 'ختم البيع في القراءة القائمة');
  assert.ok(svc.includes('return { locationId: sale?.locationId ?? null };'));
});

test('المرحلة الثانية: البيع يُختم من السياق، والإشعاران (ومنهما مرتجع المرحلة الثانية) يرثان ختم الأصل المقفل', () => {
  const inv = read('routes', 'invoices.ts');
  const ctx = inv.slice(inv.indexOf('const phase2Ctx: Phase2IssuanceContext = {'), inv.indexOf('};', inv.indexOf('const phase2Ctx: Phase2IssuanceContext = {')));
  assert.ok(ctx.includes('locationId: docLocationId,'), 'سياق المرحلة الثانية يحمل الختم');
  const z = read('routes', 'invoicesZatca.ts');
  assert.match(z, /\n\s*locationId\?: string \| null;/, 'Phase2IssuanceContext.locationId');
  assert.ok(createBlock(z, 'const row = await t.invoice.create({').includes('...(ctx.locationId && { locationId: ctx.locationId }),'));
  const n = read('routes', 'invoicesNotes.ts');
  const sel = n.slice(n.indexOf('const ORIGINAL_SELECT = {'), n.indexOf('} satisfies Prisma.InvoiceSelect;', n.indexOf('const ORIGINAL_SELECT = {')));
  assert.ok(sel.includes('locationId: true,'), 'ختم الأصل في قراءته المقفلة');
  assert.ok(n.includes('locationId: row.locationId ?? null,'));
  assert.ok(createBlock(n, 'const row = await t.invoice.create({').includes('...(locked.original.locationId && { locationId: locked.original.locationId }),'), 'الإشعار يرث ختم أصله');
  assert.match(read('compliance', 'zatca', 'notes.ts'), /\n\s*locationId\?: string \| null;/, 'NoteOriginalInvoice.locationId');
  // القاعدة محقونة في الملفّين — لا استعلام للختم فيهما
  for (const f of ['invoicesZatca.ts', 'invoicesNotes.ts']) assert.doesNotMatch(read('routes', f), /from '\.\.\/config\/database'/, f);
});

test('التحميل: LOAD وحده يُختم بموقع المندوب من صفّه القائم (العَلَم في include نفسه)', () => {
  const v = read('routes', 'vanStock.ts');
  const post = v.slice(v.indexOf("router.post('/loads'"), v.indexOf("router.get('/current'"));
  // «تتبّع اللوط» (B4): عَلَما اللوط والمستودع في القراءة نفسها، وسيارة المندوب المحذوف (D30) بلا صفّ مندوب
  assert.ok(post.includes("const rep = gone ? null : await prisma.salesRep.findFirst({ where: { id: salesRepId, tenantId: tid }, include: { tenant: { select: { locationsEnabled: true, lotTrackingEnabled: true, warehouseEnabled: true } } } });"));
  assert.ok(post.includes("const loadLocationId = data.type === 'LOAD' ? repStampLocation(rep) : null;"), 'فقط التحميلات');
  assert.ok(createBlock(post, 'db.vanLoad.create({').includes('...(loadLocationId && { locationId: loadLocationId }),'));
});

// ═══ حرّاسٌ نصّية: البوّابة والعَلَم والقوائم ═══

test('الحارس: مطفأ افتراضياً (`!== true`)، والمحاسبة المطفأة تمنع قبله، والشركة من الطلب', () => {
  const s = read('middleware', 'auth.ts');
  const i = s.indexOf('export async function requireLocations');
  assert.ok(i > 0, 'الحارس مفقود');
  const g = s.slice(i, s.indexOf('\n}\n', i));
  assert.match(g, /const tid = req\.user\?\.tenantId;/);
  assert.match(g, /t\?\.locationsEnabled !== true/);
  assert.doesNotMatch(g, /locationsEnabled === false/);
  assert.ok(g.indexOf("code: 'ACCOUNTING_NOT_ALLOWED'") > 0 && g.indexOf("code: 'ACCOUNTING_NOT_ALLOWED'") < g.indexOf("code: 'LOCATIONS_NOT_ALLOWED'"), 'المحاسبة أولاً');
});

test('العَلَم: في تحديث الشركة لا إنشائها، و/company بـ=== true', () => {
  const t = read('routes', 'tenants.ts');
  const c = t.indexOf('const createTenantSchema');
  const u = t.indexOf('const updateTenantSchema');
  assert.ok(c >= 0 && u > c);
  assert.doesNotMatch(t.slice(c, u), /locationsEnabled/, 'لا يُقبل عند الإنشاء');
  assert.match(t.slice(u, t.indexOf('});', u)), /locationsEnabled: z\.boolean\(\)\.optional\(\)/);
  const co = read('routes', 'company.ts');
  assert.match(co, /locationsEnabled: true, paymentMethodsEnabled: true \}/, 'في select');
  assert.match(co, /locationsEnabled: tenant\?\.locationsEnabled === true/);
});

test('المسارات: الراوتر خلف المصادقة والإدارة والعَلَم، والتعريف لغير المقيَّد، والإسناد بنطاق المندوب، والملخّص بنطاق المستندات', () => {
  const r = read('routes', 'locations.ts');
  assert.ok(r.includes('router.use(authenticate, requireAdmin, requireLocations);'));
  for (const route of ["router.post('/'", "router.put('/:id'", "router.delete('/:id'"]) {
    const i = r.indexOf(route);
    assert.ok(i > 0, route);
    assert.ok(r.slice(i, i + 120).includes('managePerm'), `${route}: صلاحية إعدادات الشركة`);
    assert.ok(r.slice(i, i + 300).includes('if (!(await guardManage(req, res))) return;'), `${route}: المقيَّد لا يعيد رسم المواقع`);
  }
  assert.ok(r.includes("const managePerm = requireAdminPermission('canManageCompanySettings');"));
  const assign = r.slice(r.indexOf("router.put('/reps/:salesRepId'"), r.indexOf("router.post('/'"));
  assert.ok(assign.includes("requireAdminPermission('canManageSalesReps')"));
  assert.ok(assign.indexOf('canAccessRep(req, tid, salesRepId)') < assign.indexOf('prisma.salesRep.update'), 'النطاق قبل الكتابة');
  assert.ok(assign.includes("code: 'LOCATION_ARCHIVED'"));
  const sum = r.slice(r.indexOf("router.get('/summary'"), r.indexOf("router.get('/reps'"));
  assert.ok(sum.includes("requireAdminPermission('canViewReports')"));
  assert.ok(sum.includes('scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT)') && sum.includes('scopedRepRecordWhere(req)'), 'نطاق المستخدم ومشرف الفرق');
  assert.ok(sum.includes('const tz = await tenantTz(tid);') && sum.includes('paymentMethodsRange(req.query.from, req.query.to, tz)'), 'أيام الشركة');
  assert.ok(sum.includes("status: 'CONFIRMED', invoiceDate: { gte: range.gte, lt: range.lt }, ...docScope"));
  assert.ok(sum.includes("type: 'LOAD', createdAt: { gte: range.gte, lt: range.lt }, ...repScope"));
  // /summary و/reps قبل /:id
  assert.ok(r.indexOf("router.get('/summary'") < r.indexOf("router.put('/:id'"));
  assert.ok(read('index.ts').includes("app.use('/api/locations', locationsRouter);"));
});

test('القائمتان: فلتر الموقع مفتاحٌ عدديّ في الفواتير وسجلّ التحميلات، واسم الموقع مع الصفّ', () => {
  const inv = read('routes', 'invoices.ts');
  const list = inv.slice(inv.indexOf("router.get('/', async"), inv.indexOf("router.get('/by-client-ref/:clientRef'"));
  assert.ok(list.length > 0, 'مقطع قائمة الفواتير');
  assert.ok(list.includes('const location = locationFilterOf(req.query.locationId);'));
  assert.ok(list.includes('...locationDocWhere(location),'));
  assert.ok(list.includes('location: { select: { id: true, name: true } },'));
  const v = read('routes', 'vanStock.ts');
  const loads = v.slice(v.indexOf("router.get('/loads'"), v.indexOf("router.get('/movements'"));
  assert.ok(loads.includes('const location = locationFilterOf(req.query.locationId);') && loads.includes('...locationDocWhere(location),'));
  assert.ok(loads.includes('location: l.location ?? null'));
  // المزامنة: الأعمدة الثلاثة مسموحة (تصنيفها محروسٌ في api-sync.test.ts)
  const sync = read('services', 'apiSync.ts');
  // داخل قائمة أعمدة المندوب (أعمدةٌ أُضيفت قبله من ميزاتٍ أخرى لا تكسر الحارس)
  const repCols = sync.slice(sync.indexOf('const SALES_REP_COLS = ['), sync.indexOf('];', sync.indexOf('const SALES_REP_COLS = [')));
  assert.ok(repCols.includes("'locationId',"), 'المندوب');
  assert.match(sync, /'teamId',\n[^\n]*\n\s*'locationId',\n\];/, 'الفاتورة');
  assert.ok(sync.includes("pick('id', 'salesRepId', 'deletedSalesRepId', 'locationId', 'type'"), 'التحميل');
});

// ═══ المعالجات الحقيقية فوق Prisma مزيّف ═══

type Row = Record<string, any>;
const T = 'T1';
const stub = (r: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, r));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

let st: {
  admin: Row; tenant: Row; reps: Row[]; locations: Row[]; invoiceGroups: Row[]; loads: Row[]; products: Row[];
  hasInvoice: boolean; hasLoad: boolean;
};
let calls: { op: string; args: Row }[] = [];
function reset(): void {
  calls = [];
  st = {
    admin: { isActive: true, scopeEnabled: false, scopeMode: 'LISTS', canManageCompanySettings: true, canManageSalesReps: true, canViewReports: true, canManageVanStock: true },
    tenant: { locationsEnabled: true, accountingEnabled: true },
    reps: [
      { id: 'R1', tenantId: T, name: 'محمد', isActive: true, locationId: 'L1', canManageVanStock: true },
      { id: 'R2', tenantId: T, name: 'خالد', isActive: true, locationId: null, canManageVanStock: true },
      { id: 'RX', tenantId: 'OTHER', name: 'غريب', isActive: true, locationId: null, canManageVanStock: true },
    ],
    locations: [
      { id: 'L1', tenantId: T, name: 'الرياض', lat: 24.71, lng: 46.67, isActive: true },
      { id: 'L2', tenantId: T, name: 'جدة', lat: null, lng: null, isActive: false },
      { id: 'LX', tenantId: 'OTHER', name: 'خارج', lat: null, lng: null, isActive: true },
    ],
    invoiceGroups: [], loads: [], products: [], hasInvoice: false, hasLoad: false,
  };
}
reset();
const log = (op: string, args: Row) => { calls.push({ op, args }); };
const idMatch = (row: Row, idw: unknown) => idw === undefined || (typeof idw === 'string' ? row.id === idw : (idw as Row)?.not !== undefined ? row.id !== (idw as Row).not : true);

const db: Row = {
  admin: { async findUnique() { return st.admin; } },
  tenant: { async findUnique() { return st.tenant; } },
  glSettings: { async findUnique() { return { timezone: 'Asia/Riyadh' }; } },
  companySettings: { async findUnique() { return { countryCode: 'SA' }; } },
  salesRep: {
    async findFirst(a: Row) {
      log('salesRep.findFirst', a);
      const r = st.reps.find((x) => x.tenantId === a.where.tenantId && idMatch(x, a.where.id));
      if (!r) return null;
      return a.include?.tenant ? { ...r, tenant: { locationsEnabled: st.tenant.locationsEnabled } } : { ...r };
    },
    async findMany(a: Row) { return st.reps.filter((x) => x.tenantId === a.where.tenantId).map((x) => ({ id: x.id, name: x.name, isActive: x.isActive, locationId: x.locationId })); },
    async count(a: Row) { log('salesRep.count', a); return st.reps.filter((x) => x.tenantId === a.where.tenantId && x.locationId === a.where.locationId).length; },
    async groupBy(a: Row) {
      const m = new Map<string, number>();
      for (const x of st.reps.filter((r) => r.tenantId === a.where.tenantId && r.locationId)) m.set(x.locationId, (m.get(x.locationId) ?? 0) + 1);
      return [...m.entries()].map(([locationId, n]) => ({ locationId, _count: { _all: n } }));
    },
    async update(a: Row) { log('salesRep.update', a); const r = st.reps.find((x) => x.id === a.where.id)!; Object.assign(r, a.data); return r; },
  },
  salesLocation: {
    async findFirst(a: Row) {
      log('salesLocation.findFirst', a);
      return st.locations.find((x) => x.tenantId === a.where.tenantId && idMatch(x, a.where.id) && (a.where.name === undefined || x.name === a.where.name)) ?? null;
    },
    async findMany(a: Row) { return st.locations.filter((x) => x.tenantId === a.where.tenantId); },
    async create(a: Row) { log('salesLocation.create', a); const row = { id: 'NEW', isActive: true, ...a.data }; st.locations.push(row); return row; },
    async update(a: Row) { log('salesLocation.update', a); const r = st.locations.find((x) => x.id === a.where.id)!; Object.assign(r, a.data); return r; },
    async delete(a: Row) { log('salesLocation.delete', a); st.locations = st.locations.filter((x) => x.id !== a.where.id); return {}; },
  },
  invoice: {
    async findFirst(a: Row) { log('invoice.findFirst', a); return st.hasInvoice ? { id: 'I1' } : null; },
    async groupBy(a: Row) { log('invoice.groupBy', a); return st.invoiceGroups; },
  },
  vanLoad: {
    async findFirst(a: Row) { log('vanLoad.findFirst', a); return st.hasLoad ? { id: 'V1' } : null; },
    async findMany(a: Row) { log('vanLoad.findMany', a); return st.loads; },
    async create(a: Row) { log('vanLoad.create', a); return { id: 'VNEW', ...a.data, items: [] }; },
  },
  product: {
    async count(a: Row) { return (a.where.id.in as string[]).length; },
    // POST /loads («الوحدة الرئيسية» §2.7): الأصناف بأساسها بدل العدّ — كل معرّفٍ مطلوب صنفٌ صالح بلا تحويل (من st.products إن وُجد)
    async findMany(a?: Row) {
      const ids = a?.where?.id?.in as string[] | undefined;
      if (!ids || st.products.length) return st.products;
      return ids.map((id) => ({ id, name: id, unit: 'حبة', primaryUnitId: null, baseConvertedAt: null, units: [] }));
    },
  },
};
db.$transaction = async (fn: (tx: Row) => Promise<unknown>) => fn(db);
db.$executeRaw = async () => 0;
stub('config/database', { default: db });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const locationsRouter = (require('../routes/locations') as typeof import('../routes/locations')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vanRouter = (require('../routes/vanStock') as typeof import('../routes/vanStock')).default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireLocations } = require('../middleware/auth') as typeof import('../middleware/auth');

/** يشغّل مكدّس المسار كلّه (حرّاسه ثم معالجه) — بلا وسائط الراوتر العامة (المصادقة) */
async function call(router: unknown, method: string, p: string, req: Row): Promise<{ status: number; body: Row }> {
  const layer = (router as { stack: Row[] }).stack.find((l) => l.route?.path === p && l.route.methods?.[method]);
  assert.ok(layer, `${method.toUpperCase()} ${p} مفقود`);
  const res: Row = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: Row) => { res.body = b; return res; };
  const full = { query: {}, params: {}, body: {}, headers: {}, user: { id: 'ADM', role: 'ADMIN', tenantId: T }, ...req };
  for (const h of layer.route.stack as Row[]) {
    let passed = false;
    let err: unknown;
    await h.handle(full, res, (e?: unknown) => { if (e) err = e; else passed = true; });
    if (err) throw err;
    if (!passed) break;
  }
  return { status: res.statusCode, body: res.body };
}

test('الحارس تشغيلاً: المحاسبة المطفأة أولاً، ثم العَلَم المطفأ أو غير المقروء يمنع، والمفعّل يمرّ', async () => {
  const run = async () => {
    const res: Row = { statusCode: 200, body: null };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: Row) => { res.body = b; return res; };
    let passed = false;
    await requireLocations({ user: { id: 'ADM', role: 'ADMIN', tenantId: T } } as never, res as never, () => { passed = true; });
    return { passed, status: res.statusCode, code: res.body?.code };
  };
  reset();
  assert.deepEqual(await run(), { passed: true, status: 200, code: undefined });
  st.tenant = { locationsEnabled: false, accountingEnabled: true };
  assert.deepEqual(await run(), { passed: false, status: 403, code: 'LOCATIONS_NOT_ALLOWED' });
  st.tenant = { accountingEnabled: true } as Row;
  assert.equal((await run()).code, 'LOCATIONS_NOT_ALLOWED', 'غير مقروء ⇒ يمنع');
  st.tenant = { locationsEnabled: true, accountingEnabled: false };
  assert.equal((await run()).code, 'ACCOUNTING_NOT_ALLOWED');
});

test('ختم التحميل تشغيلاً: LOAD بموقع المندوب، والتنزيل بلا ختم، والميزة المطفأة بلا ختم', async () => {
  reset();
  const load = async (type: string, user: Row = { id: 'ADM', role: 'ADMIN', tenantId: T }) => {
    calls = [];
    const r = await call(vanRouter, 'post', '/loads', { user, body: { salesRepId: 'R1', type, items: [{ productId: 'P1', qty: 5 }] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return calls.find((c) => c.op === 'vanLoad.create')!.args.data;
  };
  assert.equal((await load('LOAD')).locationId, 'L1', 'تحميل الإدارة');
  assert.equal((await load('LOAD', { id: 'R1', role: 'SALES_REP', tenantId: T })).locationId, 'L1', 'تحميل المندوب لنفسه');
  assert.ok(!('locationId' in (await load('UNLOAD'))), 'التنزيل بلا ختم');
  st.tenant.locationsEnabled = false;
  assert.ok(!('locationId' in (await load('LOAD'))), 'الميزة مطفأة ⇒ لا ختم');
  st.tenant.locationsEnabled = true;
  st.reps[0].locationId = null;
  assert.ok(!('locationId' in (await load('LOAD'))), 'مندوبٌ بلا موقع ⇒ بلا ختم (لا رفض)');
});

test('الإسناد تشغيلاً: موقعٌ من الشركة وفعّال، ومندوبٌ في النطاق — وإلا 404/409 بلا كتابة', async () => {
  reset();
  const assign = (salesRepId: string, locationId: string | null) => call(locationsRouter, 'put', '/reps/:salesRepId', { params: { salesRepId }, body: { locationId } });
  const ok = await assign('R2', 'L1');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.data, { salesRepId: 'R2', locationId: 'L1' });
  assert.equal(st.reps.find((r) => r.id === 'R2')!.locationId, 'L1');
  const writes = () => calls.filter((c) => c.op === 'salesRep.update').length;
  const before = writes();
  assert.equal((await assign('R2', 'L2')).body.code, 'LOCATION_ARCHIVED', 'المؤرشف لا يُسند إليه');
  assert.equal((await assign('R2', 'LX')).status, 404, 'موقع شركةٍ أخرى');
  assert.equal((await assign('RX', 'L1')).status, 404, 'مندوب شركةٍ أخرى');
  assert.equal(writes(), before, 'لا كتابة عند الرفض');
  const off = await assign('R1', null);
  assert.equal(off.status, 200);
  assert.equal(st.reps.find((r) => r.id === 'R1')!.locationId, null, 'null = بلا موقع');
});

test('التعريف تشغيلاً: الاسم الفريد والنقطة الكاملة، ولا أرشفة ولا حذف وفيه مناديب، ولا حذف وعليه مستندات', async () => {
  reset();
  assert.equal((await call(locationsRouter, 'post', '/', { body: { name: ' الرياض ' } })).body.code, 'LOCATION_NAME_TAKEN');
  assert.equal((await call(locationsRouter, 'post', '/', { body: { name: 'الخبر', lat: 26.2 } })).status, 400, 'نصف نقطة');
  const created = await call(locationsRouter, 'post', '/', { body: { name: '  فرع   الخبر ', lat: 26.28, lng: 50.2 } });
  assert.equal(created.status, 201);
  assert.equal(calls.find((c) => c.op === 'salesLocation.create')!.args.data.name, 'فرع الخبر');
  assert.equal(created.body.data.repsCount, 0);

  const archive = await call(locationsRouter, 'put', '/:id', { params: { id: 'L1' }, body: { isActive: false } });
  assert.equal(archive.status, 409);
  assert.equal(archive.body.code, 'LOCATION_HAS_REPS', 'مندوبٌ في الموقع ⇒ يُنقل أولاً');
  assert.equal((await call(locationsRouter, 'delete', '/:id', { params: { id: 'L1' } })).body.code, 'LOCATION_HAS_REPS');

  st.reps[0].locationId = null;
  st.hasInvoice = true;
  assert.equal((await call(locationsRouter, 'delete', '/:id', { params: { id: 'L1' } })).body.code, 'LOCATION_HAS_DOCUMENTS', 'يُؤرشف بدل الحذف');
  st.hasInvoice = false;
  st.hasLoad = true;
  assert.equal((await call(locationsRouter, 'delete', '/:id', { params: { id: 'L1' } })).body.code, 'LOCATION_HAS_DOCUMENTS', 'والتحميلات كالفواتير');
  assert.ok(!calls.some((c) => c.op === 'salesLocation.delete'));
  assert.equal((await call(locationsRouter, 'put', '/:id', { params: { id: 'L1' }, body: { isActive: false } })).status, 200, 'بلا مناديب ⇒ يُؤرشف');
  // مسح النقطة: الزوج null معاً، ونصفها يُرفض
  assert.equal((await call(locationsRouter, 'put', '/:id', { params: { id: 'L1' }, body: { lat: null } })).status, 400);
  assert.equal((await call(locationsRouter, 'put', '/:id', { params: { id: 'L1' }, body: { lat: null, lng: null } })).status, 200);

  // المقيَّد النطاق لا يعيد رسم المواقع
  st.admin = { ...st.admin, scopeEnabled: true };
  assert.equal((await call(locationsRouter, 'post', '/', { body: { name: 'تبوك' } })).status, 403);
});

test('الملخّص تشغيلاً: الفترة بأيام الشركة، والمؤكَّد وحده بتاريخه، والتحميلات LOAD بلحظتها، وأسماء الأصناف', async () => {
  reset();
  st.invoiceGroups = [
    { locationId: 'L1', type: 'CASH', _sum: { total: 200 }, _count: { _all: 2 } },
    { locationId: 'L1', type: 'RETURN', _sum: { total: 20 }, _count: { _all: 1 } },
    { locationId: null, type: 'CREDIT', _sum: { total: null }, _count: { _all: 0 } },
  ];
  st.loads = [{ locationId: 'L1', items: [{ productId: 'P1', qty: 12 }] }];
  st.products = [{ id: 'P1', name: 'شاهي', unit: 'علبة' }];
  const r = await call(locationsRouter, 'get', '/summary', { query: { from: '2026-10-01', to: '2026-10-21' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.range, { from: '2026-10-01', to: '2026-10-21', timezone: 'Asia/Riyadh' });
  const where = calls.find((c) => c.op === 'invoice.groupBy')!.args.where;
  assert.equal(where.status, 'CONFIRMED');
  assert.equal(where.invoiceDate.gte.toISOString(), '2026-09-30T21:00:00.000Z', 'منتصف ليل الرياض');
  assert.equal(where.invoiceDate.lt.toISOString(), '2026-10-21T21:00:00.000Z', 'منتصف ليل اليوم التالي لـ«إلى»');
  const lw = calls.find((c) => c.op === 'vanLoad.findMany')!.args.where;
  assert.equal(lw.type, 'LOAD');
  assert.deepEqual(Object.keys(lw.createdAt), ['gte', 'lt']);
  const l1 = r.body.data.rows.find((x: Row) => x.locationId === 'L1');
  assert.deepEqual([l1.sales, l1.returns, l1.net], [{ count: 2, amount: 200 }, { count: 1, amount: 20 }, 180]);
  assert.deepEqual(l1.loads, { count: 1, qty: 12, products: [{ productId: 'P1', name: 'شاهي', unit: 'علبة', qty: 12 }] });
  assert.equal((await call(locationsRouter, 'get', '/summary', { query: { from: '2026-13-01' } })).status, 400, 'تاريخٌ غير صالح يُرفض لا يُسقَط');
});
