// «تتبّع اللوط» — حرّاس نصّية للحزمة B5 (المواصفة §٨.٣): فواتير المرحلة الأولى (routes/invoices.ts) وخدمتها
// (services/lotsInvoice.ts) والختم اللاحق (services/invoiceExpiry.ts). نصّي على المصدر: لا قاعدة بيانات ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
/** جسم معالج من سطر تعريفه حتى `\n});` التالي */
function handler(src: string, head: string): string {
  const i = src.indexOf(head);
  assert.ok(i >= 0, `المعالج مفقود: ${head}`);
  const end = src.indexOf('\n});', i);
  assert.ok(end > i, `نهاية المعالج مفقودة: ${head}`);
  return src.slice(i, end);
}
function ordered(text: string, needles: readonly string[], msg: string): void {
  let pos = -1;
  for (const n of needles) {
    const idx = text.indexOf(n, pos + 1);
    assert.ok(idx > pos, `${msg}: «${n}» مفقود أو خارج الترتيب`);
    pos = idx;
  }
}
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') out.push(...sourceFiles(p)); }
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, '/');
const count = (s: string, frag: string) => s.split(frag).length - 1;

test('جرد كتّاب بنود الفاتورة (§٤.١٥): موضعٌ جديد يكتب invoice_items يُفشل هذا حتى يعيد التوزيع تحت قفل اللوط', () => {
  const found: Record<string, string[]> = {};
  const add = (f: string, what: string) => { (found[f] ??= []).push(what); };
  for (const f of sourceFiles(SRC)) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/\.invoiceItem\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)) add(rel(f), `invoiceItem.${m[1]}`);
    for (const m of s.matchAll(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?invoice_items"?/gi)) add(rel(f), `SQL ${m[1].toUpperCase().replace(/\s+/g, ' ')}`);
    if (/'invoice_items'/.test(s)) add(rel(f), 'TABLE-NAME');
    for (const m of s.matchAll(/\.invoice\.(create|createMany|upsert)\(/g)) add(rel(f), `invoice.${m[1]}`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(found).sort(([a], [b]) => (a < b ? -1 : 1))), {
    // الإصدار: بنودٌ متداخلة في إنشاء الفاتورة — المرحلة الأولى توزّع بقفل اللوط (أدناه)، والمرحلتان الثانيتان لـB6
    'routes/invoices.ts': ['invoice.create'],
    'routes/invoicesNotes.ts': ['invoice.create'],
    'routes/invoicesZatca.ts': ['invoice.create'],
    // تحويل وحدة الأساس: يضرب لقطات الصنف في F تحت قفل اللوط (convert-base، D22) — لا يغيّر كمية أساسية
    'routes/products.ts': ['SQL UPDATE'],
    // حذف الشركة: البنود وصفوف توزيعها تعاقبياً
    'routes/tenants.ts': ['invoiceItem.deleteMany'],
    // مُطلِق baseQty: يملأ الفارغ بـqty × المعامل نفسه (= BASE_QTY_SQL) — لا يغيّر الأساس
    'scripts/backfillBaseQty.ts': ['TABLE-NAME'],
    // الختم اللاحق: الصلاحية وحدها، ويتخطّى المختوم (أدناه)
    'services/invoiceExpiry.ts': ['invoiceItem.update', 'invoiceItem.update'],
  });
});

test('إنشاء فاتورة المرحلة الأولى يدمج invoiceItemLotColumns بعد linkedExpiry، بمعرّفٍ مولَّدٍ مسبقاً (§٤.٨ البند ٦)', () => {
  const inv = read('routes/invoices.ts');
  const i = inv.indexOf('const inv = await tx.invoice.create({');
  const block = inv.slice(i, inv.indexOf('include:', i));
  ordered(block, [
    '...(lotInvoiceId && { id: lotInvoiceId }),',
    "...(linkedExpiry?.get(saleLinkLines[idx]?.saleItemId ?? '') ?? {}),",
    '...invoiceItemLotColumns(alloc?.lines ?? null, idx, { tenantId: tid, invoiceId: lotInvoiceId ?? \'\', productId: i.productId, vanKey: salesRepId }),',
  ], 'بنود الإنشاء');
  const tx = inv.slice(inv.indexOf('return prisma.$transaction(async tx => {'), i);
  ordered(tx, [
    'SELECT id, unit, "lotTracked", "lotTrackedSince" FROM products WHERE id IN (${Prisma.join(productIds)}) AND "tenantId" = ${tid} FOR KEY SHARE',
    'const saleLink = await assertReturnLinks(tx,',
    'const alloc = lots ? await allocateInvoiceLotsInTx(tx, lots, { lockedRows: lockedUnits }) : null;',
  ], 'داخل المعاملة: القفل المشترك ثم قفل البيع ثم التوزيع قبل الإنشاء');
  assert.ok(inv.includes('const lotInvoiceId = lots ? randomUUID() : null;'));
  assert.ok(inv.indexOf('const lotInvoiceId = lots ? randomUUID() : null;') > inv.indexOf('const invoice = await withNumberRetry('), 'لكل محاولةٍ معرّفها');
});

test('R1: الإصدار لا يستدعي دوال اللوط إلا داخل شرط العلم، وغير المتتبَّع بلا خيار مهلة ولا طابور ولا استعلام', () => {
  const post = stripComments(handler(read('routes/invoices.ts'), "router.post('/',"));
  assert.ok(post.includes("include: { tenant: { select: { locationsEnabled: true, lotTrackingEnabled: true, settings: { select: { teamsEnabled: true } } } }"), 'العلم من صفّ المندوب');
  assert.ok(post.includes('const lotsOn = rep.tenant?.lotTrackingEnabled === true;'));
  assert.ok(post.includes('const preTracked = new Set(lotsOn ? products.filter((p) => p.lotTracked === true).map((p) => p.id) : []);'));
  assert.ok(post.includes('const tracksLots = preTracked.size > 0;'));
  // كل نداء لوط في المسار، بحرّاسه
  const guarded: [string, string][] = [
    ['companyDay(', 'if (tracksLots) {'],
    ['invoiceLotMoment(', 'if (tracksLots) {'],
    ['lotPlan = {', 'if (tracksLots) {'],
    ['linkedReturnExpiry(tid, lotLines', 'if (lots && isReturn) {'],
  ];
  for (const [call, guard] of guarded) {
    const at = post.indexOf(call);
    assert.ok(at > 0, `مفقود: ${call}`);
    const g = post.lastIndexOf(guard, at);
    assert.ok(g > 0 && !post.slice(g, at).includes('\n    }\n'), `${call} خارج ${guard}`);
  }
  // لقطة المرتجع الحرّ: للإشعار الدائن «برقمٍ يدويّ» قبل فرع المرحلة الثانية («اشتراط اختيار فاتورة البيع» مطفأ)، وفي المرحلة
  // الأولى — كلاهما بخطة اللوط شرطاً (lotPlan لا تُبنى إلا لمستندٍ متتبَّع)
  const frGuards = ['if (manualReturn && lotPlan) {', 'if (lots && isReturn) {'];
  const frAt = [...post.matchAll(/freeReturnStamps\(prisma/g)].map((m) => m.index ?? -1);
  assert.equal(frAt.length, frGuards.length, 'موضع لقطة المرتجع الحرّ ناقص أو زائد');
  frAt.forEach((at, i) => {
    const g = post.lastIndexOf(frGuards[i], at);
    assert.ok(g > 0 && !post.slice(g, at).includes('\n    }\n'), `freeReturnStamps(prisma خارج ${frGuards[i]}`);
  });
  assert.equal(count(post, 'acquireLotQueue('), 1);
  assert.ok(post.includes('releaseLots = lots ? await acquireLotQueue(tid, preTracked) : null;'));
  assert.equal(count(post, 'allocateInvoiceLotsInTx('), 1);
  assert.ok(post.includes('const lots = lotPlan;'));
  assert.equal(count(post, 'lotPlan = {'), 1);
  // المهلة الموسّعة للمستند المتتبَّع وحده (D13)، وغيره بلا خيار
  assert.ok(post.includes('}, tracksLots ? LOT_TX_OPTIONS : undefined);'));
  assert.equal(count(post, 'LOT_TX_OPTIONS'), 1);
  // canSellWithoutStock: المتتبَّع يُتخطّى في الفحص القديم ويُمنع داخل المعاملة لكل فاعل (R3) — والمتخطّى تحمله الخطة فلا يُصدر
  // بلا أي فحص إن أُطفئ تتبّعه قبل القفل (D25 بالعكس، trackingLost في allocateInvoiceLotsInTx)
  const stock = post.slice(post.indexOf("if (rep.canSellWithoutStock === false && body.type !== 'RETURN') {"));
  const skip = 'if (preTracked.has(pid)) { stockCheckSkipped.push(pid); continue; }';
  assert.ok(stock.includes(skip) && stock.indexOf(skip) < stock.indexOf('const rem = remById.get(pid) ?? 0;'));
  const plan = post.slice(post.indexOf('lotPlan = {'), post.indexOf('};', post.indexOf('lotPlan = {')));
  assert.ok(plan.includes('...(stockCheckSkipped.length > 0 && { stockCheckSkipped }),'), 'الخطة تحمل ما تخطّاه الفحص القديم');
  assert.ok(post.includes('let lotPlan: IssuanceLotPlan | null = null;'));
  // شكل الردّ (§٤.٨ البند ٩، D11): صفوف التوزيع في ردّ المستند المتتبَّع وحده، وغيره بنوده كما كانت
  const create = post.slice(post.indexOf('const inv = await tx.invoice.create({'));
  assert.ok(create.includes('include: { items: (lots ? { include: ITEM_LOTS_INCLUDE } : true) as true, customer: true, installments:'));
});

test('الطابور قبل withNumberRetry ويُحرَّر بعد الالتزام وفي finally؛ وكذلك الإلغاء وإطفاء العودة', () => {
  const inv = read('routes/invoices.ts');
  const post = handler(inv, "router.post('/',");
  ordered(post, [
    'let releaseLots: (() => void) | null = null;',
    'releaseLots = lots ? await acquireLotQueue(tid, preTracked) : null;',
    'const invoice = await withNumberRetry(',
    'releaseLots?.();',
    '  } finally {\n    releaseLots?.();\n  }',
  ], 'POST /');
  const cancel = handler(inv, "router.patch('/:id/cancel',");
  ordered(cancel, [
    'include: { receiptItems: true, tenant: { select: { lotTrackingEnabled: true } } },',
    "const lotReturnCancel = invoice.type === 'RETURN' && invoice.tenant?.lotTrackingEnabled === true;",
    'if (lotReturnCancel) {',
    'releaseLots = await acquireLotQueue(tid, lotCancel);',
    'await lockInvoiceForCancel(tx, tid, invoice.id);',
    // الحارس لأصنافه المتتبَّعة وحدها؛ وغير المتتبَّع: إعادة قراءة التتبّع FOR KEY SHARE وحدها (D25، §١٠.٢)
    'if (lotCancel.length) await assertReturnCancelKeepsLots(tx, tid, invoice.id);',
    'else if (lotPids.length) await assertReturnStillUntracked(tx, tid, lotPids);',
    "const inv = await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'CANCELLED' } });",
    '}, lotCancel.length ? LOT_TX_OPTIONS : undefined);',
    'const lh = lotReply(err, lotCancel.length > 0);',
    '  } finally {\n    releaseLots?.();\n  }',
  ], 'الإلغاء');
  const restock = handler(inv, "router.patch('/:id/restock',");
  ordered(restock, [
    'select: { id: true, type: true, tenant: { select: { lotTrackingEnabled: true } } }',
    'if (returnToStock === false && invoice.tenant?.lotTrackingEnabled === true) {',
    'releaseLots = await acquireLotQueue(tid, lotOff);',
    'SELECT id FROM invoices WHERE id = ${invoice.id} AND "tenantId" = ${tid} FOR UPDATE',
    'await assertRestockOffKeepsLots(tx, tid, invoice.id);',
    'return tx.invoice.update({ where: { id: invoice.id }, data: { returnToStock } });',
    '}, LOT_TX_OPTIONS);',
    // غير المتتبَّع والميزة مفعّلة: معاملةٌ بلا خيار فيها إعادة قراءة التتبّع وحدها (D25) — كالإلغاء؛ والكتابة قبلها فيُقفل صفّ
    // الفاتورة قبل الأصناف (ترتيب §٣.١ — لا يعكسه مسار)
    'if (lotPids.length) {',
    'const row = await tx.invoice.update({ where: { id: invoice.id }, data: { returnToStock } });',
    'await assertReturnStillUntracked(tx, tid, lotPids);',
    'return row;',
    '});',
    'const updated = await prisma.invoice.update({ where: { id: req.params.id }, data: { returnToStock } });',
    'const lh = lotReply(err, lotOff.length > 0);',
    '  } finally {\n    releaseLots?.();\n  }',
  ], 'إطفاء العودة');
});

test('المعالجات تحوّل LotError (والانشغال في مسار اللوط وحده) قبل errorHandler، وبعد ReturnLinkError وقبل سباق P2002', () => {
  const inv = read('routes/invoices.ts');
  const post = handler(inv, "router.post('/',");
  const c = post.slice(post.indexOf('} catch (err) {'));
  ordered(c, [
    'if (err instanceof ReturnLinkError)',
    'const lh = lotReply(err, lotPlan != null);',
    "if (lh.body.code === 'LOT_REPLAY_HELD' && lotPlan?.clientRef) {",
    'await recordReplayHeld(prisma, {',
    "if (e?.code === 'P2002' && String(e?.meta?.target ?? '').includes('clientRef') && req.body?.clientRef) {",
  ], 'catch في POST /');
  assert.ok(handler(inv, "router.post('/:id/credit-note',").includes('const lh = lotReply(err, false);'), 'الإشعار الدائن: LotError وحده');
  assert.match(inv, /const lotReply = \(err: unknown, lotPath: boolean\) => \(err instanceof LotError \|\| lotPath \? lotHttpError\(err\) : null\);/);
});

test('القراءات تضمّ صفوف التوزيع بـwithLots=1 وحده (D11)', () => {
  const inv = read('routes/invoices.ts');
  assert.ok(handler(inv, "router.get('/:id',").includes('...((await wantsLots(req, tid)) && ITEM_LOTS_INCLUDE)'));
  assert.ok(handler(inv, "router.get('/by-client-ref/:clientRef',").includes('include: { items: ((await wantsLots(req, tid)) ? { include: ITEM_LOTS_INCLUDE } : true) as true, customer: true },'));
  assert.ok(handler(inv, "router.get('/:id/returnable',").includes('const lotsByItem = (await wantsLots(req, tid)) ? await saleItemLots(prisma, tid, sale.items.map((i) => i.id)) : null;'));
  // والميزة مفعّلة (D8 يُخفي ولا يحذف): العَلَم بعد المعامل فبلا withLots لا استعلام (§١٠.١) — كـwithLotsOf في vanStock.ts
  assert.ok(inv.includes("const wantsLots = async (req: AuthRequest, tid: string): Promise<boolean> => (req.query.withLots === '1' || req.query.withLots === 'true')\n  && (await prisma.tenant.findUnique({ where: { id: tid }, select: { lotTrackingEnabled: true } }))?.lotTrackingEnabled === true;"));
  assert.ok(!/wantsLots\(req\)/.test(inv), 'لا قراءة withLots بلا عَلَم الشركة');
});

test('stampInvoiceExpiry يرشّح بـexpiresAt == null (D12)، وfreeReturnStamps نسخةٌ واحدة يغلّفها lotsInvoice', () => {
  const svc = read('services/invoiceExpiry.ts');
  const fn = svc.slice(svc.indexOf('export async function stampInvoiceExpiry'), svc.indexOf('export interface ReturnStamp'));
  assert.ok(fn.includes('creditedItemId: true, returnOfItemId: true, expiresAt: true, product: { select: LIFE }'));
  assert.ok(fn.includes('const lines = inv.items.filter((it) => it.productId && it.product && shelfLifeOf(it.product) && it.expiresAt == null);'));
  assert.ok(fn.includes('const free = await freeReturnStamps(tenantId,'), 'المرتجع الحرّ بالدالّة المستخرجة');
  assert.equal(count(svc, 'export async function freeReturnStamps'), 1);
  const lots = read('services/lotsInvoice.ts');
  assert.ok(lots.includes("const expiry = await import('./invoiceExpiry');") && lots.includes('expiry.freeReturnStamps('), 'تغليفٌ لا نسخة');
});

test('lotsInvoice: lockLotProducts يسبق أول قراءة رصيد لوط وأول كتابة، وClientRefRace تحت القفل قبل التوزيع', () => {
  const s = stripComments(read('services/lotsInvoice.ts'));
  const alloc = s.slice(s.indexOf('export async function allocateInvoiceLotsInTx('), s.indexOf('export async function precheckInvoiceLots('));
  ordered(alloc, [
    'await lockLotProducts(tx,',
    // انتظار قفل اللوط (55P03/40P01) ⇒ LOT_BUSY في المصدر (D14) — الإشعار الدائن لا يحوّل خطأ القاعدة
    'throw asLockBusy(e) ?? e;',
    'tx.invoice.findUnique(', 'throw new ClientRefRace();',
    // D25 بالعكس: ما تخطّاه فحص المخزون القديم ثم أُطفئ — بعد السباق على clientRef (المكرَّر 200) وقبل التوزيع
    'const lost = trackingLost(plan, tracked);',
    'await allocateTracked(tx, plan, tracked);', 'await tx.notification.create(',
  ], 'allocateInvoiceLotsInTx');
  const removal = s.slice(s.indexOf('async function assertRemovalKeepsLots('), s.indexOf('export async function assertReturnCancelKeepsLots('));
  ordered(removal, ['await lockLotProducts(tx, tid, pids);', 'lotRemovalsOf(items, epoch, tracked)', 'await placeViews(tx,', 'removalKeepsLots(view, removals)'], 'حارس الإزالة');
  // إعادة قراءة التتبّع لمرتجعٍ غير متتبَّع: FOR KEY SHARE وحده — لا قفل لوط ولا قراءة شركة ولا عرض سيارة (§١٠.٢)
  const still = s.slice(s.indexOf('export async function assertReturnStillUntracked('), s.indexOf('export async function recordReplayHeld('));
  assert.ok(still.length > 0 && still.length < 1500, 'جسم الدالّة وحده');
  assert.ok(still.includes('FOR KEY SHARE') && still.includes("throw lotErr('LOT_BUSY', {}, { reason: 'TRACKING_CHANGED', productIds: now });"));
  assert.ok(!/lockLotProducts|placeViews|tenant\.findUnique|invoice\.findFirst|pg_advisory/.test(still));
  // الفحص المسبق بلا قفل (ن٢-٣): لا lockLotProducts ولا كتابة — ويكشف ما أُطفئ بعد تخطّي الفحص القديم فلا يُوقَّع
  const pre = s.slice(s.indexOf('export async function precheckInvoiceLots('), s.indexOf('export interface FreeReturnStampsQuery'));
  assert.ok(!/lockLotProducts|\.create\(|\.update\(/.test(pre));
  ordered(pre, ['const lost = trackingLost(plan, tracked);', 'await allocateTracked(db, plan, tracked);'], 'precheckInvoiceLots');
  // البيع لكل سطر (allocateOutLines) لا على المجموع ثم distributeToLines (D22، مراجعة الوحدات)
  assert.ok(s.includes('allocateOutLines({') && !/\ballocateOut\(|distributeToLines\(/.test(s));
});
