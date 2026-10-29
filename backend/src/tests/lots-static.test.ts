// «تتبّع اللوط» — حرّاس نصّية (المواصفة §٨.١ lots-static، قسم P0). أقسام الحزم الأخرى في lots-static-<حزمة>.test.ts.
// نصّي على المصدر: لا قاعدة بيانات ولا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { VOIDABLE_MIRRORS } from '../compliance/zatca/void';
import { LOT_HOLD_MIRRORS, LOT_VAN_REASONS, VAN_MOVE_TYPES } from '../services/lots';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** يزيل التعليقات مع الحفاظ على عدد الأسطر (نمط gl-no-session-locks.test.ts) */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, p1: string) => p1);
const lotModules = (): string[] => fs.readdirSync(path.join(SRC, 'services')).filter((f) => /^lots[A-Z]?\w*\.ts$/.test(f) && !f.endsWith('.test.ts'));
const importsOf = (src: string): string[] => [...src.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s+'([^']+)'/g)].map((m) => m[1])
  .concat([...src.matchAll(/(?:require|import)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]));

test('وحدات services/lots*.ts كلها موجودة ولا تستورد إعداد القاعدة (ن٢-٢) — تأخذ db أو tx معاملاً', () => {
  const files = lotModules().sort();
  assert.deepEqual(files, ['lots.ts', 'lotsDb.ts', 'lotsInvoice.ts', 'lotsRelabel.ts', 'lotsTrace.ts', 'lotsVan.ts', 'lotsWarehouse.ts']);
  for (const f of files) {
    const src = read(`services/${f}`);
    assert.ok(!src.includes("from '../config/database'"), `${f} يستورد config/database`);
    assert.ok(!importsOf(src).some((m) => /config\/database$/.test(m)), `${f} يستورد config/database`);
  }
});

test('lots.ts صرفة: لا تستورد إلا node:crypto و./shelfLife (فرعا المرحلة الثانية يستوردان منها)', () => {
  const imports = importsOf(read('services/lots.ts'));
  assert.deepEqual([...new Set(imports)].sort(), ['./shelfLife', 'node:crypto']);
  // وshelfLife نفسها بلا أي import (فلا تجرّ القاعدة بطريق خلفي)
  assert.deepEqual(importsOf(read('services/shelfLife.ts')), []);
});

test('LOT_HOLD_MIRRORS = VOIDABLE_MIRRORS حرفياً (D24)', () => {
  assert.deepEqual([...LOT_HOLD_MIRRORS], [...VOIDABLE_MIRRORS]);
});

test('VAN_MOVE_TYPES = loadSchema.type، ولا نوع حركة جديد (الإتلاف وسمٌ على صفّ اللوط لا نوع)', () => {
  const van = read('routes/vanStock.ts');
  const schema = van.slice(van.indexOf('const loadSchema = z.object({'), van.indexOf('});', van.indexOf('const loadSchema = z.object({')));
  const m = /type: z\.enum\(\[([^\]]*)\]\)/.exec(schema);
  assert.ok(m, 'loadSchema.type مفقود');
  const types = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(types, [...VAN_MOVE_TYPES]);
  for (const r of LOT_VAN_REASONS) assert.ok(!(VAN_MOVE_TYPES as readonly string[]).includes(r));
  // foldStock يوقع كل نوعٍ غير المعروفة في التسوية — نوعٌ جديد كان سيُحسب تسويةً بصمت
  assert.match(van, /else m\.adjusted \+= qty;/);
});

test('lotsDb: كل pg_advisory_xact_lock على tx.$executeRaw، ولا أقفال جلسة', () => {
  const code = stripComments(read('services/lotsDb.ts'));
  let uses = 0;
  code.split('\n').forEach((line, i) => {
    if (!/pg_advisory_xact_lock\s*\(/.test(line)) return;
    uses++;
    assert.match(line, /\btx\.\$executeRaw\s*`/, `lotsDb.ts:${i + 1} قفلٌ خارج عميل المعاملة`);
  });
  assert.equal(uses, 1, 'موضعٌ واحد للقفل (حلقة المفاتيح المرتّبة)');
  for (const re of [/pg_advisory_lock\s*\(/, /pg_try_advisory/, /pg_advisory_unlock/]) assert.doesNotMatch(code, re);
});

test('lotsDb: lock_timeout بـset_config المحلي مع الحفظ والاستعادة — لا SET LOCAL يتسرّب (ن٢-٨)، وبترتيب §٣.١', () => {
  const src = read('services/lotsDb.ts');
  assert.doesNotMatch(src, /SET\s+LOCAL\s+lock_timeout/i);
  const fn = src.slice(src.indexOf('export async function lockLotProducts('), src.indexOf('// ═══ البطاقات'));
  const order = [
    'FOR KEY SHARE',
    "SELECT current_setting('lock_timeout')",
    "SELECT set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)",
    'SELECT pg_advisory_xact_lock(${k.key})',
    "SELECT set_config('lock_timeout', ${prev}, true)",
  ];
  let at = -1;
  for (const frag of order) {
    const i = fn.indexOf(frag, at + 1);
    assert.ok(i > at, `الترتيب: «${frag}» مفقود أو قبل سابقه`);
    at = i;
  }
  assert.match(src, /export const LOT_LOCK_TIMEOUT = '5s';/);
  assert.match(fn, /sortedLockKeys\(tenantId, tracked\)/, 'الأقفال للمتتبَّع تحت القفل وحده وبترتيب المفتاح');
});

test('I8: التقييم لا يقرأ أي جدول لوط (R9) — warehouseCost وwarehouseStock وgl/opening', () => {
  for (const f of ['services/warehouseCost.ts', 'services/warehouseStock.ts', 'services/gl/opening.ts']) {
    const src = read(f);
    for (const bad of [/\blotId\b/, /ProductLot/, /productLot/, /\blot_\w+/, /lotTracked/, /services\/lots|\.\/lots/, /LotRelabel|lotRelabel|VanLoadItemLot|vanLoadItemLot|InvoiceItemLot|invoiceItemLot/]) {
      assert.doesNotMatch(src, bad, `${f} يذكر ${bad}`);
    }
  }
});

test('BASE_QTY_SQL موضعٌ واحد (D19)، ولا كمية أساسية مكتوبة نصاً في غيره', () => {
  const defs: string[] = [];
  for (const f of lotModules()) {
    const src = stripComments(read(`services/${f}`));
    if (/BASE_QTY_SQL\s*=/.test(src)) defs.push(f);
    assert.doesNotMatch(src, /"baseQty"|"unitFactor"/, `${f}: كمية أساسية خارج BASE_QTY_SQL`);
  }
  assert.deepEqual(defs, ['lotsDb.ts']);
  assert.match(read('services/lotsDb.ts'), /export const BASE_QTY_SQL = Prisma\.raw\('qty'\);/, 'اللوط أولاً من 4a02616: qty');
});

test('التجميع: الحقبة على صفوف اللوط وحدها، وfoldStock تُستورد ديناميكياً من routes/vanStock (لا مرآة)', () => {
  const src = read('services/lotsDb.ts');
  const code = stripComments(src);
  assert.match(code, /GREATEST\(COALESCE\(t\."lotTrackingSince", '-infinity'::timestamp\), COALESCE\(p\."lotTrackedSince", '-infinity'::timestamp\)\)/);
  assert.match(code, /await import\('\.\.\/routes\/vanStock'\)/);
  assert.doesNotMatch(code, /^import (?!type)[^\n]*'\.\.\/routes\/vanStock'/m, 'استيراد ثابت لمسار يجرّ القاعدة');
  // foldStock باقية في vanStock.ts (debit-note-consumers-static.test.ts يقرأ نصّها هناك)
  assert.match(read('routes/vanStock.ts'), /export function foldStock\(/);
});

test('requireLots: نسخة requireLocations — المحاسبة أولاً ثم العَلَم بشرط !== true، والشركة من الطلب', () => {
  const auth = read('middleware/auth.ts');
  const fn = auth.slice(auth.indexOf('export async function requireLots('), auth.indexOf('export async function requireAccounting('));
  assert.ok(fn.length > 0, 'requireLots مفقودة أو ليست بعد requireLocations');
  assert.match(fn, /const tid = req\.user\?\.tenantId;/);
  assert.match(fn, /select: \{ lotTrackingEnabled: true, accountingEnabled: true \}/);
  const acc = fn.indexOf("'ACCOUNTING_NOT_ALLOWED'"), lots = fn.indexOf("'LOTS_NOT_ALLOWED'");
  assert.ok(acc > 0 && lots > acc, 'المحاسبة قبل العَلَم');
  assert.match(fn, /t\?\.lotTrackingEnabled !== true/);
  assert.ok(auth.indexOf('export async function requireLocations(') < auth.indexOf('export async function requireLots('));
});

test('§١٠.١ وR4: أعمدة P0 على المنتج لا تتسرّب والميزة مطفأة — لا في حمولة ERP، ولا في /api/v1/sync/products حتى تحسمها B7', async () => {
  const { productPayloadRow } = await import('../services/erpPayload');
  assert.deepEqual(productPayloadRow({ id: 'p', name: 'شاي', image: 'data:...', lotTracked: false, lotTrackedSince: null }), { id: 'p', name: 'شاي' },
    'حمولة ERP للمنتج (ولمنتج بند الفاتورة) بلا أعمدة لوط (§٥.٥)');
  const { SYNC_RESOURCES } = await import('../services/apiSync');
  const products = SYNC_RESOURCES.find((r) => r.name === 'products')!;
  assert.deepEqual(Object.keys(products.select).filter((k) => /^lot/i.test(k)), [], 'شكل ردّ المزامنة كما كان (§١٠.١) — B7 تكشف lotTracked إن حسم المالك §٥.٣');
  assert.ok('lotTracked' in products.denied && 'lotTrackedSince' in products.denied, 'العمودان مصنَّفان محجوبين بسببٍ مكتوب');
});

test('الهياكل: تواقيع الحزم مصدَّرة (العقود المجمَّدة §٤.٠)', async () => {
  const expect: Record<string, string[]> = {
    lotsDb: ['acquireLotQueue', 'lockLotProducts', 'loadLotMetas', 'placeViews', 'companyDay', 'resolveOrCreateLot', 'recordLotEvent', 'warehouseOnHandAgg'],
    lotsInvoice: ['allocateInvoiceLotsInTx', 'precheckInvoiceLots', 'freeReturnStamps', 'assertReturnCancelKeepsLots', 'assertRestockOffKeepsLots'],
    lotsVan: ['planVanMovementInTx', 'vanLotSnapshot'],
    lotsWarehouse: ['planWarehouseEntryInTx', 'assertOpeningRevertKeepsLots', 'deleteOrphanOpeningLots'],
    lotsRelabel: ['relabelInTx'],
    lotsTrace: ['lotTrace', 'unloadPlan', 'lotHealth'],
  };
  for (const [mod, fns] of Object.entries(expect)) {
    const m = (await import(`../services/${mod}`)) as Record<string, unknown>;
    for (const f of fns) assert.equal(typeof m[f], 'function', `${mod}.${f}`);
  }
  assert.ok(typeof (await import('../services/lotsDb')).BASE_QTY_SQL === 'object');
});
