import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC_GROUPS, API_DOC_GUIDES } from './apiDocsCatalog';
import { API_SYNC_RESOURCES } from './apiDocsData';

/**
 * «التشغيلات على مستوى السطر» و«مرجع السطر» lineRef (٢ نوفمبر ٢٠٢٦) في مستند الربط — شكوى مُكامِلٍ: مشاكل التشغيلة عنده على
 * مستوى السطر لا المستند. المستند يَعِد بحقولٍ يقرؤها نظامه: كل وعدٍ هنا مقرونٌ بما يرسله الخادم فعلاً (المخطّطات وselect المزامنة
 * والمعالج)، فحقلٌ يُسحب أو يُعاد تسميته في الخادم ويبقى في المستند يُفشل هذا.
 */
const BACKEND = path.resolve(process.cwd(), '..', 'backend', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8').replace(/\r\n/g, '\n');
const SYNC = read('services', 'apiSync.ts');
const endpointOf = (method: string, p: string) => {
  const e = API_DOC_GROUPS.flatMap((g) => g.endpoints).find((x) => x.method === method && x.path === p);
  assert.ok(e, `${method} ${p} غير موثّق`);
  return e!;
};
const fieldOf = (method: string, p: string, name: string) => {
  const f = [...endpointOf(method, p).body, ...endpointOf(method, p).query].find((x) => x.name === name);
  assert.ok(f, `${method} ${p}: الحقل ${name} غائب`);
  return f!;
};
const what = (n: string) => API_SYNC_RESOURCES.find((r) => r.name === n)!.what;
/** أسماء pick('a', 'b') في نصّ */
const picks = (s: string) => [...s.matchAll(/'(\w+)'/g)].map((m) => m[1]);
/** كتلة تعريف موردٍ في apiSync.ts حتى المورد التالي */
const resourceBlock = (name: string) => {
  const at = SYNC.indexOf(`name: '${name}', model:`);
  assert.ok(at > 0, `المورد ${name} في apiSync.ts`);
  const next = SYNC.indexOf("name: '", at + 10);
  return SYNC.slice(at, next > 0 ? next : undefined);
};
/** حقول صفّ التوزيع المضمّن وبطاقة التشغيلة كما في الخادم */
const constPicks = (name: string) => {
  const m = new RegExp(`const ${name} = \\{\\s*select: \\{ \\.\\.\\.pick\\(([^)]*)\\), lot: LOT_CARD \\},\\s*orderBy: LINE_LOTS_ORDER,`).exec(SYNC);
  assert.ok(m, `${name} في apiSync.ts`);
  return picks(m![1]);
};
const LOT_CARD = (() => {
  const m = /const LOT_CARD = \{ select: pick\(([^)]*)\) \};/.exec(SYNC);
  assert.ok(m, 'LOT_CARD في apiSync.ts');
  return picks(m![1]);
})();
/** «lots:[{a, b, lot:{x, y}|null}]» في نصّ المستند ⇒ [[a, b], [x, y]] */
const docLots = (text: string) => {
  const m = /lots:\[\{([^{}]*), lot:\{([^}]*)\}\|null\}\]/.exec(text);
  assert.ok(m, `شكل lots غائب: ${text.slice(0, 80)}`);
  return [m![1].split(', '), m![2].split(', ')];
};

test('المزامنة: lots المضمّنة في بنود invoices وvan-loads بحقول الخادم حرفياً، وبطاقة lot بحقول LOT_CARD، وبترتيب الإنشاء', () => {
  assert.deepEqual(LOT_CARD, ['lotNumber', 'productionDate', 'expiryDate']);
  assert.ok(SYNC.includes("const LINE_LOTS_ORDER = [{ createdAt: 'asc' }, { id: 'asc' }];"), 'ترتيب الإنشاء ثم المعرّف');
  for (const [res, constName] of [['invoices', 'INVOICE_ITEM_LOTS'], ['van-loads', 'VAN_ITEM_LOTS']]) {
    const [row, card] = docLots(what(res));
    assert.deepEqual(row, constPicks(constName), `${res}: حقول صفّ التوزيع`);
    assert.deepEqual(card, LOT_CARD, `${res}: حقول البطاقة`);
    assert.match(what(res), /createdAt ثم id/, `${res}: الترتيب`);
    assert.match(what(res), /بالكمية الأساسية/, `${res}: الكمية بالأساس`);
    // ومُضمَّنةٌ للمفعّلة وحدها: في lotSelect لا في select المورد
    const block = resourceBlock(res);
    const lotSelect = block.slice(block.indexOf('lotSelect:'), block.indexOf('\n', block.indexOf('lotSelect:')));
    assert.ok(lotSelect.includes(`lots: ${constName}`), `${res}: lots في lotSelect`);
    assert.ok(!block.slice(0, block.indexOf('lotSelect:')).includes(constName), `${res}: lots خارج بوّابة العَلَم`);
  }
  // warehouse-entries: lotId وبطاقته للمفعّلة وحدها
  assert.match(what('warehouse-entries'), new RegExp(`lot:\\{${LOT_CARD.join(', ')}\\}\\|null`));
  const wh = resourceBlock('warehouse-entries');
  assert.ok(wh.includes("lotSelect: { items: { select: { ...pick('id', 'lotId'), lot: LOT_CARD } } }"));
  // والموارد المنفصلة باقية في المستند والخادم، والمستند يقول إنها باقية
  for (const r of ['invoice-item-lots', 'van-load-item-lots', 'product-lots']) {
    assert.ok(API_SYNC_RESOURCES.some((x) => x.name === r), r);
    assert.ok(SYNC.includes(`name: '${r}', model:`), `${r} في الخادم`);
  }
  for (const r of ['invoice-item-lots', 'van-load-item-lots']) assert.match(what(r), /باقٍ كما هو/, r);
});

test('المزامنة: lineRef في select بنود invoices وvan-loads وwarehouse-entries لكل الشركات (لا في lotSelect)، والمستند يقول ذلك', () => {
  const invCols = SYNC.slice(SYNC.indexOf('const INVOICE_ITEM_COLS = ['), SYNC.indexOf('];', SYNC.indexOf('const INVOICE_ITEM_COLS = [')));
  assert.ok(invCols.includes("'lineRef'"), 'INVOICE_ITEM_COLS');
  for (const res of ['van-loads', 'warehouse-entries']) {
    const block = resourceBlock(res);
    const select = block.slice(block.indexOf('select:'), block.indexOf('\n', block.indexOf('select:')));
    assert.ok(select.includes("'lineRef'"), `${res}: lineRef في select البنود`);
  }
  for (const res of ['invoices', 'van-loads', 'warehouse-entries']) {
    const block = resourceBlock(res);
    const lotSelect = block.slice(block.indexOf('lotSelect:'), block.indexOf('\n', block.indexOf('lotSelect:')));
    assert.ok(!lotSelect.includes('lineRef'), `${res}: lineRef لا يُبوَّب بالعَلَم`);
    assert.match(what(res), /lineRef/, `${res}: المستند`);
    assert.match(what(res), /لكل الشركات/, `${res}: بلا شرط الميزة`);
  }
  // وبنود السطر المنقسم في المستودع بالمرجع نفسه
  assert.match(what('warehouse-entries'), /كلها بـlineRef السطر نفسه/);
});

test('الكتابة: items[].lineRef في POST /invoices و/van-stock/loads و/warehouse/entries، وlines[].lineRef في الإشعارين — اختياري ≤ 100 كمخطّطات الخادم', () => {
  const sites: [string, string, string, string][] = [
    ['POST', '/invoices', 'items[].lineRef', 'invoices'],
    ['POST', '/van-stock/loads', 'items[].lineRef', 'vanStock'],
    ['POST', '/warehouse/entries', 'items[].lineRef', 'warehouse'],
    ['POST', '/invoices/:id/credit-note', 'lines[].lineRef', 'invoices'],
    ['POST', '/invoices/:id/debit-note', 'lines[].lineRef', 'invoices'],
  ];
  for (const [method, p, name] of sites) {
    const f = fieldOf(method, p, name);
    assert.equal(f.required, false, `${p}: اختياري`);
    assert.equal(f.type, 'string ≤ 100 | null', `${p}: النوع`);
    assert.match(f.desc, /الفارغ بعد القصّ = null/, `${p}: الفارغ null`);
    assert.match(f.desc, /الأطول من 100 حرف 400/, `${p}: الطول 400`);
    assert.match(f.desc, /لا فرادة/, `${p}: لا فرادة`);
  }
  // الخادم: المخطّط نفسه (قصٌّ وحدّ ١٠٠ ويقبل null) في الموجّهات الثلاثة
  const inv = read('routes', 'invoices.ts');
  assert.ok(inv.includes('export const lineRefField = z.string().trim().max(100).nullish();'), 'lineRefField');
  const field = (src: string, schema: string) => {
    const at = src.indexOf(schema);
    assert.ok(at >= 0, schema);
    return src.slice(at, src.indexOf('\n});', at));
  };
  for (const schema of ['const invoiceItemSchema = z.object({', 'const creditNoteSchema = z.object({', 'const debitNoteSchema = z.object({']) {
    assert.match(field(inv, schema), /lineRef: lineRefField,/, schema);
  }
  assert.match(read('routes', 'vanStock.ts'), /lineRef: z\.string\(\)\.trim\(\)\.max\(100\)\.nullish\(\)/);
  assert.match(read('routes', 'warehouse.ts'), /lineRef: z\.string\(\)\.trim\(\)\.max\(100\)\.nullish\(\)/);
  // المرتجع والمرحلة الثانية: الحقل يَعِد بهما، والخادم يكتبه في مسار المرحلة الثانية
  assert.match(fieldOf('POST', '/invoices', 'items[].lineRef').desc, /المرتجع/);
  assert.ok(read('routes', 'invoicesZatca.ts').includes('...lineRefColumn(i.lineRef)'), 'المرحلة الثانية تكتب المرجع');
  // ولا يدخل حمولة ERP — في المستند، والخادم يجرّده منها
  assert.match(fieldOf('POST', '/invoices', 'items[].lineRef').desc, /لا يدخل حمولة ERP/);
  assert.ok(read('services', 'erpPayload.ts').includes('withoutLineRef'), 'erpPayload لا يجرّد lineRef');
  // والإشعار الدائن 'FULL' بلا مرجع كما في noteLineRefs
  assert.match(fieldOf('POST', '/invoices/:id/credit-note', 'lines[].lineRef').desc, /'FULL' لا مرجع/);
  assert.ok(/input === 'FULL'\) return lines\.map\(\(\) => null\)/.test(read('routes', 'invoicesNotes.ts')), 'FULL بلا مرجع في الخادم');
});

test('الردود: lineRef في ردود البنود الموثّقة، وسطر المستودع المنقسم يحمل المرجع نفسه — كما يكتبه موجّه المستودع', () => {
  for (const [method, p] of [['POST', '/van-stock/loads'], ['GET', '/van-stock/loads'], ['POST', '/warehouse/entries'], ['GET', '/warehouse/entries'], ['GET', '/invoices/:id'], ['GET', '/van-stock/movements']]) {
    assert.match(endpointOf(method, p).response, /\blineRef\b/, `${method} ${p}`);
  }
  assert.match(endpointOf('POST', '/warehouse/entries').response, /وlineRef السطر نفسه/);
  assert.ok(endpointOf('POST', '/warehouse/entries').rules.some((r) => r.includes('وكلها بـitems[].lineRef السطر')));
  // الخادم: كل بنود السطر المنقسم تُكتب بمرجعه (splitByLine)
  const wh = read('routes', 'warehouse.ts');
  const at = wh.indexOf('const lineRef = i.lineRef != null');
  const split = wh.slice(at, wh.indexOf('}),\n      },\n    });', at));
  assert.ok(at > 0 && split.length > 100, 'entryData في warehouse.ts');
  assert.match(split, /return split\.map\(\(r\) => \{[^]*?lotId: r\.lotId, \.\.\.lineRef \};/, 'بنود السطر المنقسم بلا مرجعه');
  assert.match(split, /return \[\{[^]*?\.\.\.lineRef,\s*\}\];/, 'السطر الواحد بلا مرجعه');
  // والحركات: المرجع حاضرٌ دائماً في /movements — للحركة كما حُفظ، وللفاتورة كذلك إلا خارج النطاق (null كرقمها وعميلها)
  assert.ok((read('routes', 'vanStock.ts').match(/lineRef: (?:[^,]*?\()?i\.lineRef \?\? null/g) ?? []).length >= 2, '/movements بلا lineRef');
});

test('REST: GET /invoices يوثّق withLots مع withItems كما في GET /invoices/:id، والخادم يقرؤه في القائمة بعَلَم الشركة', () => {
  const f = fieldOf('GET', '/invoices', 'withLots');
  assert.equal(f.required, false);
  assert.match(f.desc, /withItems=1/);
  assert.match(f.desc, /يُهمل[^.]*مطفأة/, 'المطفأة تتجاهله');
  // شكل الصفّ هو ITEM_LOTS_INCLUDE نفسه (lot فيه الرقم والانتهاء)
  const inv = read('routes', 'invoices.ts');
  assert.ok(inv.includes('const ITEM_LOTS_INCLUDE = { lots: { include: { lot: { select: { lotNumber: true, expiryDate: true } } } } } as const;'));
  assert.match(f.desc, /lot:\{lotNumber, expiryDate\}\|null/);
  assert.match(endpointOf('GET', '/invoices').response, /lots مع withLots=1/);
  // القائمة (router.get('/') حتى by-client-ref) تقرأ withLots بـwantsLots (عَلَم الشركة) وتضمّ ITEM_LOTS_INCLUDE
  const list = inv.slice(inv.indexOf("router.get('/', "), inv.indexOf("router.get('/by-client-ref/:clientRef'"));
  assert.ok(list.length > 500, 'معالج القائمة');
  assert.ok(/wantsLots\(req, tid\)/.test(list), 'القائمة لا تقرأ withLots بعَلَم الشركة');
  assert.ok(list.includes('ITEM_LOTS_INCLUDE'), 'القائمة لا تضمّ صفوف التوزيع');
});

test('دليل «ربط تتبّع LOT»: خطوة «اقرأ التشغيلة من السطر نفسه» قبل خطوة المزامنة، بمثال بندٍ صالحٍ بحقول الخادم', () => {
  const guide = API_DOC_GUIDES.find((g) => g.key === 'lots-guide')!;
  const i = guide.steps.findIndex((s) => s.title === 'اقرأ التشغيلة من السطر نفسه');
  assert.ok(i > 0, 'الخطوة غائبة');
  assert.equal(guide.steps[i + 1]?.title, 'أبقِ نظامكم متزامناً', 'قبل خطوة المزامنة');
  const step = guide.steps[i];
  for (const k of ['items[].lineRef', 'POST /api/invoices', 'POST /api/van-stock/loads', 'POST /api/warehouse/entries', 'GET /api/invoices?withItems=1&withLots=1', 'invoice-item-lots', 'van-load-item-lots']) {
    assert.ok(step.text.includes(k), `الخطوة لا تذكر ${k}`);
  }
  assert.match(step.text, /باقية كما هي/);
  // المثال: سطر تعليق ثم JSON صالح — بند بمرجعه وتوزيعه، وكل صفٍّ بحقول INVOICE_ITEM_LOTS وبطاقةٍ بحقول LOT_CARD
  assert.ok(step.sample, 'لا مثال');
  const [comment, ...json] = step.sample!.split('\n');
  assert.ok(comment.startsWith('// ') && comment.includes('/api/v1/sync/invoices'));
  const item = JSON.parse(json.join('\n')) as { lineRef: string; baseQty: number; lots: Array<Record<string, unknown> & { quantity: number; lot: Record<string, unknown> }> };
  assert.equal(typeof item.lineRef, 'string');
  assert.ok(item.lots.length >= 2, 'مثال توزيعٍ على أكثر من تشغيلة');
  assert.equal(item.lots.reduce((n, r) => n + r.quantity, 0), item.baseQty, 'Σ quantity = baseQty');
  for (const r of item.lots) {
    assert.deepEqual(Object.keys(r), [...constPicks('INVOICE_ITEM_LOTS'), 'lot']);
    assert.deepEqual(Object.keys(r.lot), LOT_CARD);
  }
  // والمثال لا يحمل مفتاحاً، ورابط curl للمزامنة نفسها
  assert.ok(!/fsk_/.test(step.sample!));
  assert.ok(step.curl?.includes('/v1/sync/invoices?'), 'curl المزامنة');
  // والمستند يرسم المثال كتلة كود في الدليل
  const docs = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'ApiDocs.tsx'), 'utf8');
  assert.ok(docs.includes('{s.sample && <Code>{s.sample}</Code>}'), 'ApiDocs لا يرسم sample');
});

test('«ما الجديد»: بند ٢ نوفمبر للتشغيلات على مستوى السطر يذكر lineRef والتشغيلات المضمّنة وبقاء الموارد المنفصلة، والعنوان يشمله', () => {
  const docs = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'ApiDocs.tsx'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(docs.includes('title="ما الجديد (٢٩ أكتوبر – ٧ نوفمبر ٢٠٢٦)"'), 'العنوان');
  const list = docs.slice(docs.indexOf('title="ما الجديد'), docs.indexOf('</ul>', docs.indexOf('title="ما الجديد')));
  // أول البنود دليل «حركات المخزون من نظامكم» (٢ نوفمبر)، وبعده بند التشغيلات على مستوى السطر بالتاريخ نفسه
  // بنود ٥ نوفمبر (الأحدث) أولاً ثم بنود ٢ نوفمبر
  const bullets = [...list.matchAll(/<li>([^]*?)<\/li>/g)].map((m) => m[1]).filter((b) => !b.startsWith('٥ نوفمبر — ') && !b.startsWith('٧ نوفمبر — '));
  assert.ok(bullets[0].startsWith('٢ نوفمبر — '), 'أول بند');
  const first = bullets.find((b) => b.includes('items[].lineRef'))!;
  assert.ok(first, 'بند lineRef غائب');
  assert.ok(first.startsWith('٢ نوفمبر — '), 'بند lineRef بتاريخ ٢ نوفمبر');
  assert.ok(bullets.slice(0, bullets.indexOf(first)).every((b) => b.startsWith('٢ نوفمبر — ')), 'لا بند أقدم قبله');
  for (const k of ['items[].lineRef', 'lines[].lineRef', 'invoices', 'van-loads', 'warehouse-entries', 'withLots=1', 'invoice-item-lots', 'باقية كما هي']) {
    assert.ok(first.includes(k), `البند لا يذكر ${k}`);
  }
  // ومقدمة مجموعة الفواتير ومجموعة lots تذكران المرجع والتشغيلات المضمّنة
  assert.match(API_DOC_GROUPS.find((g) => g.key === 'invoices')!.overview, /«مرجع السطر» lineRef/);
  const lots = API_DOC_GROUPS.find((g) => g.key === 'lots')!.overview;
  assert.match(lots, /التشغيلات على مستوى السطر/);
  assert.match(lots, /تبقى موارد المزامنة الخمسة كما هي/);
});
