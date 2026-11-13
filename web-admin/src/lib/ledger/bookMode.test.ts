import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  INVENTORY_MODE_UNAVAILABLE, SETUP_METHODS, bookMode, inventoryModeChoices, isLinked, isLinkedMethod, isManualBooks,
  isManualLedger, isManualMethod, linkedFromDay, postsFromOperations, type BookMode, type BookModeSettings,
} from './bookMode';
import { isManualLedger as isManualLedgerFromRoutes } from '../../pages/ledger/routes';
import { ledgerConfigReasonLabels, setupMethodLabels } from './labels';
import { openingStockGate } from '../importData';

/**
 * «ربط الدفاتر» L0 — وضع الدفاتر في الواجهة: جدول الحقيقة، ومطابقته للخادم (services/booksMode.ts)، والذهبيّ للدفاتر
 * اليدوية (لا تغيّر سلوك)، وحارس «لا مقارنة حرفية بـ'CLEAN' أو 'LINKED'» في شاشات الدفاتر والاستيراد.
 */

const root = process.cwd();
const backendSrc = path.resolve(root, '..', 'backend', 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(root, 'src', ...p), 'utf8');
const id = (s: string) => s;

const ACTIVATED = '2026-11-13T08:00:00.000Z';
const METHODS: (string | null | undefined)[] = [undefined, null, '', 'CLEAN', 'LINKED', 'OPENING', 'FULL_HISTORY', 'clean', 'OTHER'];
const ACTIVATIONS: (string | Date | null | undefined)[] = [undefined, null, '', ACTIVATED, new Date(ACTIVATED)];

/** التوقّع مكتوباً باليد (لا اشتقاقاً من الدالة نفسها) */
function expectedMode(method: string | null | undefined, activatedAt: unknown): BookMode {
  if (method === 'CLEAN') return 'MANUAL';
  if (!activatedAt) return 'NONE';
  if (method === 'LINKED') return 'LINKED';
  if (method === 'OPENING' || method === 'FULL_HISTORY') return 'LEGACY';
  return 'NONE';
}

test('bookMode: جدول الحقيقة — CLEAN يدوية بلا شرط التفعيل، وLINKED/القديمتان بالتفعيل وحده، وغيرها NONE', () => {
  assert.equal(bookMode(null), 'NONE');
  assert.equal(bookMode(undefined), 'NONE');
  assert.equal(bookMode({}), 'NONE');
  for (const setupMethod of METHODS) {
    for (const activatedAt of ACTIVATIONS) {
      const s: BookModeSettings = { setupMethod, activatedAt };
      const want = expectedMode(setupMethod, activatedAt);
      const label = `${String(setupMethod)} / ${String(activatedAt)}`;
      assert.equal(bookMode(s), want, label);
      assert.equal(isManualBooks(s), setupMethod === 'CLEAN', label);
      assert.equal(isLinked(s), want === 'LINKED', label);
      assert.equal(postsFromOperations(s), want === 'LINKED' || want === 'LEGACY', label);
    }
  }
  // نقاط صريحة لا تحتمل اللبس
  assert.equal(bookMode({ setupMethod: 'CLEAN', activatedAt: null }), 'MANUAL', 'اليدوية قبل التفعيل يدوية كما كانت المقارنة الحرفية');
  assert.equal(bookMode({ setupMethod: 'LINKED', activatedAt: null }), 'NONE', 'الربط لا يسري قبل التفعيل');
  assert.equal(isLinked({ setupMethod: 'LINKED', activatedAt: ACTIVATED }), true);
  assert.equal(isLinked({ setupMethod: 'linked', activatedAt: ACTIVATED }), false, 'المطابقة حرفية حسّاسة للحالة كالخادم');
  assert.equal(isManualBooks(null), false);
  assert.equal(postsFromOperations({ setupMethod: 'CLEAN', activatedAt: ACTIVATED }), false, 'اليدوية لا يُرحِّل التشغيل إليها شيئاً');
  assert.deepEqual([...SETUP_METHODS], ['CLEAN', 'LINKED', 'OPENING', 'FULL_HISTORY']);
});

test('bookMode: مطابقة الخادم services/booksMode.ts قيمةً بقيمة (المرآة لا تنحرف)', async (t) => {
  const f = path.join(backendSrc, 'services', 'booksMode.ts');
  if (!fs.existsSync(f)) { t.skip('الخادم غير موجود بجوار الواجهة'); return; }
  const be = await import(pathToFileURL(f).href) as Record<string, unknown>;
  const mod = (be.bookMode ? be : (be.default as Record<string, unknown>)) as {
    bookMode: (s: unknown) => string; isManualBooks: (s: unknown) => boolean; isLinked: (s: unknown) => boolean;
    postsFromOperations: (s: unknown) => boolean; SETUP_METHODS: readonly string[];
  };
  assert.deepEqual([...mod.SETUP_METHODS], [...SETUP_METHODS], 'طرق الإعداد نفسها');
  const cases: (BookModeSettings | null | undefined)[] = [null, undefined, {}];
  for (const setupMethod of METHODS) for (const activatedAt of ACTIVATIONS) cases.push({ setupMethod, activatedAt });
  for (const s of cases) {
    const label = JSON.stringify(s) ?? String(s);
    assert.equal(bookMode(s), mod.bookMode(s), `bookMode ${label}`);
    assert.equal(isManualBooks(s), mod.isManualBooks(s), `isManualBooks ${label}`);
    assert.equal(isLinked(s), mod.isLinked(s), `isLinked ${label}`);
    assert.equal(postsFromOperations(s), mod.postsFromOperations(s), `postsFromOperations ${label}`);
  }
});

test('isManualLedger (قاعدة الشاشات): يدوية قبل التفعيل وحين CLEAN، والمربوطة المفعّلة والقديمتان ليست يدوية — وroutes.ts يعيد تصديرها نفسها', () => {
  assert.equal(isManualLedgerFromRoutes, isManualLedger, 'مصدر واحد');
  assert.equal(isManualLedger(undefined), true, 'أثناء التحميل: لا وميض لشاشات التشغيل');
  assert.equal(isManualLedger(null), true);
  for (const setupMethod of METHODS) {
    assert.equal(isManualLedger({ setupMethod, activatedAt: null }), true, `قبل التفعيل ${String(setupMethod)}`);
  }
  // ذهبيّ الدفاتر اليدوية: كما كانت المقارنة الحرفية `!activatedAt || setupMethod === 'CLEAN'` تماماً
  for (const setupMethod of METHODS) {
    for (const activatedAt of ACTIVATIONS) {
      const legacy = !activatedAt || setupMethod === 'CLEAN';
      assert.equal(isManualLedger({ setupMethod, activatedAt }), legacy, `${String(setupMethod)} / ${String(activatedAt)}`);
    }
  }
  assert.equal(isManualLedger({ setupMethod: 'CLEAN', activatedAt: ACTIVATED }), true);
  assert.equal(isManualLedger({ setupMethod: 'LINKED', activatedAt: ACTIVATED }), false, 'المربوطة لا تُعرض «دفاتر يدوية»');
  assert.equal(isManualLedger({ setupMethod: 'OPENING', activatedAt: ACTIVATED }), false);
  assert.equal(isManualLedger({ setupMethod: 'FULL_HISTORY', activatedAt: ACTIVATED }), false);
});

test('isManualMethod/isLinkedMethod: الطريقة المفردة بلا شرط التفعيل', () => {
  for (const m of METHODS) {
    assert.equal(isManualMethod(m), m === 'CLEAN', String(m));
    assert.equal(isManualMethod(m), isManualBooks({ setupMethod: m }), String(m));
    assert.equal(isLinkedMethod(m), m === 'LINKED', String(m));
  }
});

test('linkedFromDay: يوم الربط من الحقل الاختياري — نصّ اليوم أو ISO بمنتصف ليل UTC بلا انزلاق، وإلا null', () => {
  assert.equal(linkedFromDay(null), null);
  assert.equal(linkedFromDay(undefined), null);
  assert.equal(linkedFromDay({}), null, 'الخادم لا يرجع الحقل اليوم');
  assert.equal(linkedFromDay({ linkedFrom: null }), null);
  assert.equal(linkedFromDay({ linkedFrom: '' }), null);
  assert.equal(linkedFromDay({ linkedFrom: 'غير تاريخ' }), null);
  assert.equal(linkedFromDay({ linkedFrom: 20260101 }), null);
  assert.equal(linkedFromDay({ linkedFrom: '2026-01-01' }), '2026-01-01');
  // عمود @db.Date يُسلسَل ISO بمنتصف ليل UTC: اليوم نفسه لا اليوم السابق بتوقيت متصفّحٍ غربي
  assert.equal(linkedFromDay({ linkedFrom: '2026-01-01T00:00:00.000Z' }), '2026-01-01');
  assert.equal(linkedFromDay({ linkedFrom: new Date('2026-01-01T00:00:00.000Z') }), '2026-01-01');
  assert.equal(linkedFromDay({ linkedFrom: new Date('invalid') }), null);
  assert.equal(linkedFromDay({ linkedFrom: '2026-01-01junk' }), null, 'لا يُقبل نصّ يبدأ بتاريخ ويتبعه عبث');
  // أي كائن يكفي (أنواع api/* لا تحمل الحقل بعد)
  const status = { setupMethod: 'LINKED', activatedAt: ACTIVATED, linkedFrom: '2026-01-01' };
  assert.equal(linkedFromDay(status), '2026-01-01');
});

test('inventoryModeChoices: الجرد المستمر مخفيّ حتى L6 إلا لمن قيمته المحفوظة PERPETUAL، وقائمة الخادم هي الحكم إن وصلت', () => {
  assert.deepEqual(inventoryModeChoices('PERIODIC'), ['PERIODIC']);
  assert.deepEqual(inventoryModeChoices(null), ['PERIODIC']);
  assert.deepEqual(inventoryModeChoices(undefined, null), ['PERIODIC']);
  assert.deepEqual(inventoryModeChoices('PERPETUAL'), ['PERIODIC', 'PERPETUAL'], 'القائمة لا تنكسر لشركة قيمتها PERPETUAL أصلاً');
  // قائمة الخادم اليوم (inventoryModeOptions): PERPETUAL غير متاح لغير قيمته
  const today = [{ value: 'PERIODIC', available: true, reason: null }, { value: 'PERPETUAL', available: false, reason: INVENTORY_MODE_UNAVAILABLE }];
  assert.deepEqual(inventoryModeChoices('PERIODIC', today), ['PERIODIC']);
  // L6: الخادم يتيحه فيظهر بلا تعديل في الواجهة
  const l6 = [{ value: 'PERIODIC', available: true }, { value: 'PERPETUAL', available: true }];
  assert.deepEqual(inventoryModeChoices('PERIODIC', l6), ['PERIODIC', 'PERPETUAL']);
  // القيمة المحفوظة تبقى ظاهرة أياً كان حكم القائمة — الحقل يعرض قيمته الحقيقية
  assert.deepEqual(inventoryModeChoices('PERPETUAL', today), ['PERIODIC', 'PERPETUAL']);
  assert.equal(INVENTORY_MODE_UNAVAILABLE, 'INVENTORY_MODE_UNAVAILABLE');
});

test('inventoryModeChoices: مرآة inventoryModeAvailable ورمز الرفض في routes/ledger/config.ts', (t) => {
  const f = path.join(backendSrc, 'routes', 'ledger', 'config.ts');
  if (!fs.existsSync(f)) { t.skip('الخادم غير موجود بجوار الواجهة'); return; }
  const s = fs.readFileSync(f, 'utf8');
  assert.match(s, /export const INVENTORY_MODE_UNAVAILABLE_CODE = 'INVENTORY_MODE_UNAVAILABLE';/);
  assert.match(s, /return mode !== 'PERPETUAL' \|\| current === 'PERPETUAL';/, 'قاعدة الإتاحة في الخادم تغيّرت — راجع inventoryModeChoices');
  assert.match(s, /inventoryModeOptions: inventoryModeOptions\(s\.inventoryMode\)/, 'GET /settings يرسل القائمة');
  // صفحة الإعدادات تعرض الخيار من الدالة لا ثابتاً
  const page = read('pages', 'ledger', 'config', 'SettingsPage.tsx');
  assert.match(page, /const inventoryModes = inventoryModeChoices\(s\?\.inventoryMode, /);
  assert.ok(page.includes(`{inventoryModes.includes('PERPETUAL') && <option value="PERPETUAL">{tr('جرد مستمر')}</option>}`));
  // رفض الخادم له نصّ عربي فلا يظهر «بيانات غير صالحة» العام
  assert.equal(ledgerConfigReasonLabels(id).INVENTORY_MODE_UNAVAILABLE, 'الجرد المستمر يتاح مع ربط الدفاتر بالنظام');
});

test('تسميات طريقة البدء: الثلاث القديمة حرفاً بحرف، وLINKED «دفاتر مربوطة بالنظام»، ونوع SetupMethod يغطي الطرق كلها', () => {
  const labels = setupMethodLabels(id);
  assert.deepEqual(Object.keys(labels).sort(), [...SETUP_METHODS].sort());
  assert.equal(labels.CLEAN, 'بداية نظيفة من يوم التفعيل');
  assert.equal(labels.OPENING, 'أرصدة افتتاحية');
  assert.equal(labels.FULL_HISTORY, 'ترحيل التاريخ الكامل');
  assert.equal(labels.LINKED, 'دفاتر مربوطة بالنظام');
  const api = read('api', 'ledgerSetup.ts');
  const union = /export type SetupMethod = ([^;]+);/.exec(api)?.[1] ?? '';
  assert.deepEqual([...union.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]).sort(), [...SETUP_METHODS].sort());
  // سياق الاستيراد يقبل الطرق المعروفة كلها (ومنها LINKED) من المصدر نفسه
  const notice = read('components', 'ImportLedgerNotice.tsx');
  assert.match(notice, /method: SetupMethod \| null;/);
  assert.match(notice, /SETUP_METHODS as readonly string\[\]\)\.includes\(m\)/);
});

test('openingStockGate: اليدوية (CLEAN) مفتوحة كما كانت، والمربوطة قبل التفعيل لا تُعامَل بداية نظيفة', () => {
  const now = new Date('2026-09-16T21:30:00Z'); // 2026-09-17 بتوقيت الرياض
  const ctx = (method: string | null, cutoverDate: string | null) => ({ activated: false, cutoverDate, timezone: 'Asia/Riyadh', method });
  for (const cutoverDate of ['2026-09-17', '2026-09-01', null]) {
    assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx('CLEAN', cutoverDate), serverBlock: null, now }), { state: 'open' });
  }
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: ctx('LINKED', '2026-01-01'), serverBlock: null, now }),
    { state: 'ack', cutoverDate: '2026-01-01', minCutoverDate: '2026-09-18' });
  assert.deepEqual(openingStockGate({ warehouseEnabled: true, ctx: { ...ctx('LINKED', '2026-01-01'), activated: true }, serverBlock: null, now }),
    { state: 'blocked', reason: 'active', cutoverDate: '2026-01-01' });
});

// ═══ حارس ثابت: لا مقارنة حرفية بوضع الدفاتر خارج bookMode.ts ═══

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

test('حارس: شاشات الدفاتر والاستيراد لا تقارن setupMethod حرفياً بـCLEAN أو LINKED — الحكم من lib/ledger/bookMode.ts', () => {
  const files = [
    ...walk(path.join(root, 'src', 'pages', 'ledger')),
    ...walk(path.join(root, 'src', 'lib', 'ledger')).filter((f) => path.basename(f) !== 'bookMode.ts'),
    path.join(root, 'src', 'components', 'ImportLedgerNotice.tsx'),
    path.join(root, 'src', 'lib', 'importData.ts'),
  ];
  assert.ok(files.length > 20, `عدد الملفات ${files.length} أقلّ من المتوقّع`);
  const literal = /(?:[!=]==?\s*['"](?:CLEAN|LINKED)['"])|(?:['"](?:CLEAN|LINKED)['"]\s*[!=]==?)|case\s+['"](?:CLEAN|LINKED)['"]/;
  const offenders: string[] = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (literal.test(line)) offenders.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'استعمل isManualBooks/isManualMethod/isLinked من lib/ledger/bookMode.ts');
});

test('المربوطة تُوصف بيوم ربطها في الإعدادات والفهرس والمعالج — لـisLinked وحدها فلا تمسّ اليدوية', () => {
  const ui = read('pages', 'ledger', 'setup', 'setupUi.tsx');
  assert.ok(ui.includes("tr('دفاتر مربوطة بالنظام منذ {date}').replace('{date}', formatDayOnly(day))"));
  assert.match(ui, /const day = linkedFromDay\(settings\);/);
  for (const [file, arg] of [
    [['pages', 'ledger', 'config', 'SettingsPage.tsx'], 's'],
    [['pages', 'ledger', 'LedgerHome.tsx'], 'q.data'],
    [['pages', 'ledger', 'setup', 'SetupWizard.tsx'], 'status'],
  ] as const) {
    const s = read(...file);
    const esc = arg.replace('.', '\\.');
    assert.match(s, new RegExp(`\\{isLinked\\(${esc}\\) && <LinkedBooksNote settings=\\{${esc}\\} />\\}`), file.join('/'));
  }
  // نصّ الدفاتر اليدوية في مواضعه كما كان
  const manualText = "tr('دفاتر يدوية مستقلة: منفصلة تماما عن المبيعات والمخزون والتحصيل، لا يُرحَّل إليها شيء آليا، وكل قيد فيها يُدخله المحاسب')";
  for (const file of [['pages', 'ledger', 'config', 'SettingsPage.tsx'], ['pages', 'ledger', 'LedgerHome.tsx'], ['pages', 'ledger', 'setup', 'SetupWizard.tsx'], ['pages', 'ledger', 'setup', 'SetupReview.tsx']]) {
    assert.ok(read(...file).includes(manualText), file.join('/'));
  }
});
