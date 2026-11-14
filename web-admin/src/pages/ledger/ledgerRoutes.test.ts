import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canLedger, LEDGER_KEYS, type LedgerKey } from '../../lib/ledgerPerms';
import type { User } from '../../types';
import {
  LEDGER_ROUTES, LEDGER_DIALOGS, ledgerMenus, visibleLedgerMenus, menuItemViewPerm, type LedgerMenu,
} from './routes';

/**
 * جدول مسارات الدفاتر (§8.2، M2 ويتسع مع كل مرحلة): `routes.ts` مصدر تسجيل `App.tsx` وقوائم
 * `LedgerLayout` معاً — فكل عنصر قائمة مسجّل، وكل مسجّل ملفوف بـ`LedgerRoute perm={العرض}`،
 * ولكل صف ملف صفحة، وقاعدة الظهور بـcanLedger.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
const identity = (s: string) => s;
// M6 وM7: صفوف «ربط الدفاتر» L4/L5/L8 (تقارير الشركاء والتسوية الموجّهة) — عقد §6.4
const DELIVERED = new Set(['M2', 'M3', 'M4', 'M6', 'M7']);

test('صفوف الجدول: مسارات فريدة، ومفاتيح صلاحيات صحيحة، ومراحل مسلَّمة وحدها', () => {
  const paths = LEDGER_ROUTES.map(r => r.path);
  assert.equal(new Set(paths).size, paths.length, 'مسار مكرر في LEDGER_ROUTES');
  for (const r of LEDGER_ROUTES) {
    assert.ok((LEDGER_KEYS as readonly string[]).includes(r.view), `view غير معروف: ${r.path}`);
    assert.ok(r.write === null || (LEDGER_KEYS as readonly string[]).includes(r.write), `write غير معروف: ${r.path}`);
    assert.ok(DELIVERED.has(r.milestone), `مسار لمرحلة لم تُسلَّم لا يُسجَّل: ${r.path} (${r.milestone})`);
    assert.doesNotMatch(r.path, /^\/|\/$/, `المسار نسبي بلا شرطة طرفية: ${r.path}`);
  }
  for (const d of LEDGER_DIALOGS) assert.ok(DELIVERED.has(d.milestone), d.key);
});

test('صفوف M2 من جدول §8.2 كلها موجودة بصلاحياتها', () => {
  const expected: [string, string, LedgerKey, LedgerKey | null][] = [
    ['', 'LedgerHome', 'canViewLedger', 'canConfigureLedger'],
    ['entries', 'entries/MoveList', 'canViewLedger', 'canPostJournals'],
    ['entries/new', 'entries/MoveForm', 'canViewLedger', 'canPostJournals'],
    ['entries/:id', 'entries/MoveForm', 'canViewLedger', 'canPostJournals'],
    ['items', 'entries/MoveLineList', 'canViewLedger', 'canPostJournals'],
    ['config/settings', 'config/SettingsPage', 'canConfigureLedger', 'canConfigureLedger'],
    ['config/accounts', 'config/AccountList', 'canViewLedger', 'canConfigureLedger'],
    ['config/accounts/:id', 'config/AccountForm', 'canViewLedger', 'canConfigureLedger'],
    ['config/taxes', 'config/TaxList', 'canConfigureLedger', 'canConfigureLedger'],
    ['config/journals', 'config/JournalList', 'canConfigureLedger', 'canConfigureLedger'],
    ['config/mappings', 'config/MappingsPage', 'canConfigureLedger', 'canConfigureLedger'],
    ['config/tags', 'config/TagList', 'canConfigureLedger', 'canConfigureLedger'],
    ['config/fiscal-years', 'config/FiscalYearList', 'canConfigureLedger', 'canConfigureLedger'],
  ];
  for (const [p, component, view, write] of expected) {
    const r = LEDGER_ROUTES.find(x => x.path === p);
    assert.ok(r, `مسار M2 غير مسجَّل: ${p || '(الفهرس)'}`);
    assert.deepEqual({ component: r.component, view: r.view, write: r.write }, { component, view, write }, p);
  }
  const m3: [string, string, LedgerKey, LedgerKey | null][] = [
    ['customers/invoices', 'customers/InvoicePostingList', 'canViewLedger', null],
    ['customers/receipts', 'customers/ReceiptPostingList', 'canViewLedger', null],
    ['customers/custody', 'customers/CustodyPage', 'canViewLedger', 'canPostJournals'],
    ['customers/paylink', 'customers/PaylinkClearingPage', 'canViewLedger', null],
    ['review/events', 'review/SyncEventsPage', 'canViewLedger', 'canConfigureLedger'],
    ['review/attention', 'review/MoveReviewList', 'canViewLedger', 'canPostJournals'],
    ['review/late', 'review/MoveReviewList', 'canViewLedger', 'canPostJournals'],
    ['review/unreviewed', 'review/MoveReviewList', 'canViewLedger', 'canPostJournals'],
    ['review/checks', 'review/IntegrityChecksPage', 'canViewLedger', 'canConfigureLedger'],
    ['review/audit', 'review/AuditLogPage', 'canConfigureLedger', null],
  ];
  for (const [p, component, view, write] of m3) {
    const r = LEDGER_ROUTES.find(x => x.path === p);
    assert.ok(r, `مسار M3 غير مسجَّل: ${p}`);
    assert.deepEqual({ component: r.component, view: r.view, write: r.write, milestone: r.milestone }, { component, view, write, milestone: 'M3' }, p);
  }
  // M4 (§7.1 إلى §7.5): صفحةٌ لكل تقرير فوق قشرة reports/ReportView المشتركة، بلا عمود كتابة
  const m4: [string, string, LedgerKey, LedgerKey | null][] = [
    ['reports/balance-sheet', 'reports/BalanceSheetPage', 'canViewLedger', null],
    ['reports/income-statement', 'reports/IncomeStatementPage', 'canViewLedger', null],
    ['reports/trial-balance', 'reports/TrialBalancePage', 'canViewLedger', null],
    ['reports/general-ledger', 'reports/GeneralLedgerPage', 'canViewLedger', null],
  ];
  for (const [p, component, view, write] of m4) {
    const r = LEDGER_ROUTES.find(x => x.path === p);
    assert.ok(r, `مسار M4 غير مسجَّل: ${p}`);
    assert.deepEqual({ component: r.component, view: r.view, write: r.write, milestone: r.milestone }, { component, view, write, milestone: 'M4' }, p);
  }
  // «ربط الدفاتر بالنظام» L2 (العقد l23 §15): معاينة للقراءة، عرضها وكتابتها canConfigureLedger
  const linking = LEDGER_ROUTES.find(x => x.path === 'linking');
  assert.deepEqual(linking && { component: linking.component, view: linking.view, write: linking.write, milestone: linking.milestone },
    { component: 'linking/LinkingPreviewPage', view: 'canConfigureLedger', write: 'canConfigureLedger', milestone: 'M3' });
  // مسارات المراحل اللاحقة في القائمتين لا تُسجَّل قبل مرحلتها («تسويات الذمم» سُلّمت مع «ربط الدفاتر» L4)
  for (const p of ['review/uncosted']) assert.ok(!LEDGER_ROUTES.some(r => r.path === p), `مسار لمرحلة لاحقة: ${p}`);
  const lock = LEDGER_DIALOGS.find(d => d.key === 'lockDates');
  assert.deepEqual(lock && { view: lock.view, write: lock.write }, { view: 'canCloseLedgerPeriods', write: 'canCloseLedgerPeriods' });
});

test('لكل صف ملف صفحة، ويلتقطه نمط import.meta.glob في App.tsx', () => {
  for (const r of LEDGER_ROUTES) {
    const f = path.join(root, 'src', 'pages', 'ledger', `${r.component}.tsx`);
    assert.ok(fs.existsSync(f), `ملف الصفحة غير موجود: ${f}`);
    assert.ok(r.component.split('/').length <= 2, `عمق المكوّن يتجاوز نمط glob: ${r.component}`);
  }
  assert.ok(!fs.existsSync(path.join(root, 'src', 'pages', 'ledger', 'LedgerComingSoonPage.tsx')), 'صفحة M0 المؤقتة أُزيلت من M2');
});

test('كل عنصر قائمة مسجّل في الجدول، وكل صفحة قائمة (لا نموذج ولا فهرس) لها عنصر', () => {
  const menus = ledgerMenus(identity);
  const menuPaths = new Set<string>();
  for (const m of menus) for (const s of m.sections) for (const i of s.items) {
    if (i.kind === 'route') {
      assert.ok(LEDGER_ROUTES.some(r => r.path === i.path), `عنصر قائمة غير مسجّل: ${i.path}`);
      menuPaths.add(i.path);
    } else if (i.kind === 'link') {
      // رابط لصفحة قائمة خارج /app/ledger (§8.2 «العملاء ← /app/customers») — لا يُسجَّل في الجدول
      assert.match(i.href, /^\/app\/(?!ledger)/, `رابط خارجي داخل الدفاتر: ${i.href}`);
    } else {
      assert.ok(LEDGER_DIALOGS.some(d => d.key === i.dialog), `حوار غير معرَّف: ${i.dialog}`);
    }
    assert.ok(menuItemViewPerm(i), `عنصر بلا صلاحية عرض: ${i.label}`);
  }
  for (const r of LEDGER_ROUTES) {
    if (r.path === '' || /(^|\/)(new|:id)$/.test(r.path)) continue;
    assert.ok(menuPaths.has(r.path), `مسار قائمة بلا عنصر في LedgerLayout: ${r.path}`);
  }
  for (const d of LEDGER_DIALOGS) {
    assert.ok(menus.some(m => m.sections.some(s => s.items.some(i => i.kind === 'dialog' && i.dialog === d.key))), `حوار بلا عنصر: ${d.key}`);
  }
  // ترتيب القوائم مرآة Odoo (§8.2): العملاء قبل المحاسبة، ومراجعة بعدها، ثم «إعداد التقارير» (M4)، والتهيئة آخراً
  assert.deepEqual(menus.map(m => m.key), ['customers', 'accounting', 'review', 'reports', 'config']);
  assert.ok(menus[0].sections.some(s => s.items.some(i => i.kind === 'link' && i.href === '/app/customers')));
  {
  }
});

test('App.tsx: كل صف مسجّل من LEDGER_ROUTES ملفوفاً بـLedgerRoute perm={العرض} تحت هيكل LedgerLayout', () => {
  const app = read('src', 'App.tsx');
  assert.match(app, /import \{ LEDGER_ROUTES \} from '\.\/pages\/ledger\/routes';/);
  assert.match(app, /LEDGER_ROUTES\.map\(r => \{/, 'التسجيل من الجدول لا يدوياً');
  assert.match(app, /const element = <LedgerRoute perm=\{r\.view\}><Page \/><\/LedgerRoute>;/, 'كل صف ملفوف بـLedgerRoute perm={r.view}');
  assert.match(app, /\? <Route key="\(index\)" index element=\{element\} \/>/);
  assert.match(app, /: <Route key=\{r\.path\} path=\{r\.path\} element=\{element\} \/>/);
  assert.match(app, /<Route path="ledger" element=\{<LedgerRoute perm="canViewLedger"><LedgerLayout \/><\/LedgerRoute>\} children=\{ledgerChildRoutes\} \/>/,
    'الهيكل ملفوف بـLedgerRoute وأبناؤه صفوف الجدول');
  assert.match(app, /import\.meta\.glob<\{ default: ComponentType \}>\(\['\.\/pages\/ledger\/\*\.tsx', '\.\/pages\/ledger\/\*\/\*\.tsx'\]\)/);
  // لا مسار دفاتر مسجّل يدوياً خارج الجدول
  assert.equal([...app.matchAll(/path="ledger[^"]*"/g)].length, 1, 'مسار دفاتر حرفي خارج LEDGER_ROUTES');
  assert.doesNotMatch(app, /LedgerComingSoonPage/);
});

const u = (o: Partial<User>): User => ({ id: 'x', name: 'x', role: 'MANAGER', ...o }) as User;
const flat = (menus: LedgerMenu[]) => menus.flatMap(m => m.sections.flatMap(s => s.items.map(i => (i.kind === 'route' ? i.path : i.kind === 'link' ? `link:${i.href}` : `dialog:${i.dialog}`))));
const visibleFor = (user: User) => visibleLedgerMenus(ledgerMenus(identity), k => canLedger(user, k));

test('قاعدة الظهور: العنصر بصلاحية عرضه، والقائمة الفارغة تُخفى كلها', () => {
  const all = flat(ledgerMenus(identity));
  const owner = u({ role: 'ADMIN', canManageCompanyUsers: true });
  assert.deepEqual(flat(visibleFor(owner)), all, 'مالك الشركة يرى كل عناصر M2 وM3');

  const viewer = u({ canViewLedger: true });
  assert.deepEqual(flat(visibleFor(viewer)).sort(), [
    'config/accounts', 'entries', 'items',
    'customers/invoices', 'customers/receipts', 'customers/custody', 'customers/paylink', 'link:/app/customers',
    'review/events', 'review/attention', 'review/late', 'review/unreviewed', 'review/checks',
    // M4: التقارير الأربعة كلها بـcanViewLedger، فيراها صاحب العرض وحده بلا تهيئة
    'reports/balance-sheet', 'reports/income-statement', 'reports/trial-balance', 'reports/general-ledger',
    // «ربط الدفاتر» L4/L5/L8: تقارير الشركاء وشاشات العمليات كلها بـcanViewLedger (خريطة الطرق وحدها بالتهيئة)
    'reports/partner-ledger', 'reports/aged-receivable', 'reports/aged-payable', 'reports/product-ledger', 'reports/late-arrivals',
    'customers/adjustments', 'customers/user-custody', 'customers/clearing',
  ].sort());
  assert.ok(!flat(visibleFor(viewer)).includes('config/payment-methods'), '«طرق الدفع والحسابات» لمن يملك canConfigureLedger وحده');
  assert.ok(!flat(visibleFor(viewer)).includes('review/audit'), 'سجل التدقيق لمن يملك canConfigureLedger وحده');
  assert.deepEqual(visibleFor(viewer).find(m => m.key === 'config')?.sections.length, 1, 'القسم بلا عناصر ظاهرة يُخفى');

  const closer = u({ canCloseLedgerPeriods: true });
  assert.ok(flat(visibleFor(closer)).includes('dialog:lockDates'));
  assert.ok(!flat(visibleFor(viewer)).includes('dialog:lockDates'), '«تواريخ الإقفال…» لمن يملك canCloseLedgerPeriods وحده');

  const configurer = u({ canConfigureLedger: true });
  assert.ok(flat(visibleFor(configurer)).includes('config/settings'));
  // ربط الدفاتر: في «التهيئة ← المحاسبة» آخراً، لمن يملك canConfigureLedger (والمالك)، لا لصاحب العرض وحده
  assert.ok(flat(visibleFor(configurer)).includes('linking'));
  assert.ok(flat(visibleFor(owner)).includes('linking'));
  assert.ok(!flat(visibleFor(viewer)).includes('linking'), 'المعاينة لا تظهر لصاحب canViewLedger وحده');
  const accountingConfig = ledgerMenus(identity).find(m => m.key === 'config')?.sections.find(sec => sec.label === 'المحاسبة');
  const lastItem = accountingConfig?.items[accountingConfig.items.length - 1];
  assert.deepEqual(lastItem, { kind: 'route', label: 'ربط الدفاتر بالنظام (معاينة)', path: 'linking' });
  assert.ok(flat(visibleFor(configurer)).includes('review/audit'));
  assert.ok(flat(visibleFor(configurer)).includes('config/payment-methods'));
  assert.ok(!flat(visibleFor(configurer)).includes('dialog:lockDates'));

  assert.deepEqual(visibleFor(u({ role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: true })), [], 'مقيّد النطاق لا يرى شيئاً');
  assert.deepEqual(visibleFor(u({})), [], 'بلا صلاحية لا قوائم');
});

test('LedgerLayout يبني القوائم بقاعدة الظهور ويفتح LockDatesDialog بصلاحيته', () => {
  const layout = read('src', 'pages', 'ledger', 'LedgerLayout.tsx');
  assert.match(layout, /visibleLedgerMenus\(ledgerMenus\(tr\), k => canLedger\(user, k\)\)/);
  assert.match(layout, /dialog === 'lockDates' && canLedger\(user, 'canCloseLedgerPeriods'\) && <LockDatesDialog/);
  assert.match(layout, /<Outlet \/>/);
  assert.match(layout, /i\.kind === 'link' \? \(/, 'الرابط الخارجي يُعرض في القائمة');
  assert.doesNotMatch(layout, /PermissionRoute|\bcan\(/, 'الدفاتر بـcanLedger وحدها');
});

// ═══ الدفاتر اليدوية المستقلة (أمر المالك، 2026-09-28) ═══
import { isManualLedger, manualLedgerMenus, MANUAL_LEDGER_HIDDEN_PATHS } from './routes';

test('الدفاتر اليدوية: القائمة بلا «العملاء» (مستندات التشغيل) ولا أحداث الترحيل الآلي والمستندات المتأخرة، والباقي كما هو', () => {
  const all = ledgerMenus((s: string) => s);
  const manual = manualLedgerMenus(all);
  assert.ok(!manual.some(m => m.key === 'customers'));
  const paths = manual.flatMap(m => m.sections.flatMap(s => s.items.flatMap(i => (i.kind === 'route' ? [i.path] : []))));
  for (const p of MANUAL_LEDGER_HIDDEN_PATHS) assert.ok(!paths.includes(p), p);
  assert.ok(paths.includes('entries') && paths.includes('review/checks'));
  assert.ok(paths.includes('linking'), 'معاينة الربط تعمل قبل التفعيل (الدفاتر اليدوية)');
  assert.equal(isManualLedger({ activatedAt: '2027-01-15T09:00:00Z', setupMethod: 'CLEAN' }), true);
  assert.equal(isManualLedger({ activatedAt: null, setupMethod: null }), true);
  assert.equal(isManualLedger({ activatedAt: '2026-01-01T00:00:00Z', setupMethod: 'OPENING' }), false, 'التفعيلات السابقة كما كانت');
});

// ═══ «ربط الدفاتر» L4/L5/L8 (عقد §6.4 A12): صفوف الجدول والقوائم حرفياً ═══

test('ربط الدفاتر: صفوف جدول §6.4 بمكوّناتها وصلاحياتها ومراحلها حرفياً', () => {
  const expected: [string, string, LedgerKey, LedgerKey | null, string][] = [
    ['reports/partner-ledger', 'reports/PartnerLedgerPage', 'canViewLedger', null, 'M6'],
    ['reports/aged-receivable', 'reports/AgedReceivablePage', 'canViewLedger', null, 'M6'],
    ['reports/aged-payable', 'reports/AgedPayablePage', 'canViewLedger', null, 'M6'],
    ['reports/late-arrivals', 'reports/LateArrivalsPage', 'canViewLedger', null, 'M6'],
    ['reports/product-ledger', 'reports/ProductLedgerPage', 'canViewLedger', null, 'M6'],
    ['customers/adjustments', 'customers/CustomerAdjustmentsPage', 'canViewLedger', 'canPostJournals', 'M4'],
    ['customers/clearing', 'customers/ClearingPage', 'canViewLedger', 'canPostJournals', 'M7'],
    ['customers/user-custody', 'customers/UserCustodyPage', 'canViewLedger', null, 'M3'],
    ['config/payment-methods', 'config/PaymentMethodMapPage', 'canConfigureLedger', 'canConfigureLedger', 'M3'],
  ];
  for (const [p, component, view, write, milestone] of expected) {
    const r = LEDGER_ROUTES.find(x => x.path === p);
    assert.ok(r, `مسار غير مسجَّل: ${p}`);
    assert.deepEqual({ component: r.component, view: r.view, write: r.write, milestone: r.milestone }, { component, view, write, milestone }, p);
  }
});

test('ربط الدفاتر: عناصر القوائم بنصوصها الحرفية ومواضعها (العملاء، إعداد التقارير ← الشركاء، التهيئة ← المحاسبة)', () => {
  const menus = ledgerMenus(identity);
  const routesOf = (key: string, section?: string) => menus.find(m => m.key === key)!.sections
    .filter(s => section === undefined || s.label === section)
    .flatMap(s => s.items.flatMap(i => (i.kind === 'route' ? [`${i.label}=${i.path}`] : [])));
  const customers = routesOf('customers');
  for (const x of ['تسويات ذمم العملاء=customers/adjustments', 'عهدة مستخدمي الشركة=customers/user-custody', 'تسوية الحسابات الوسيطة=customers/clearing']) {
    assert.ok(customers.includes(x), x);
  }
  assert.deepEqual(routesOf('reports', 'الشركاء'), [
    'دفتر أستاذ الشركاء=reports/partner-ledger',
    'أعمار الذمم المدينة=reports/aged-receivable',
    'أعمار الذمم الدائنة=reports/aged-payable',
    'تقرير الأصناف من الدفاتر=reports/product-ledger',
    'مستندات وصلت متأخرة (تقرير)=reports/late-arrivals',
  ]);
  assert.ok(routesOf('config', 'المحاسبة').includes('طرق الدفع والحسابات=config/payment-methods'));
  // كل صفّ جديد يُستدعى من قائمته بنصّ tr حرفي (حارس langs.test) — لا تسمية مركّبة
  const src = read('src', 'pages', 'ledger', 'routes.ts');
  for (const l of ['تسويات ذمم العملاء', 'عهدة مستخدمي الشركة', 'تسوية الحسابات الوسيطة', 'الشركاء', 'دفتر أستاذ الشركاء', 'أعمار الذمم المدينة',
    'أعمار الذمم الدائنة', 'تقرير الأصناف من الدفاتر', 'مستندات وصلت متأخرة (تقرير)', 'طرق الدفع والحسابات']) {
    assert.ok(src.includes(`tr('${l}')`), l);
  }
});

test('ربط الدفاتر: الدفاتر اليدوية بلا شاشات التشغيل المربوط ولا تقريري الترحيل الآلي، ويبقى دفتر الشريك والأعمار', () => {
  const manual = manualLedgerMenus(ledgerMenus(identity));
  const paths = manual.flatMap(m => m.sections.flatMap(s => s.items.flatMap(i => (i.kind === 'route' ? [i.path] : []))));
  for (const p of ['customers/adjustments', 'customers/user-custody', 'customers/clearing', 'config/payment-methods', 'reports/late-arrivals', 'reports/product-ledger']) {
    assert.ok(MANUAL_LEDGER_HIDDEN_PATHS.includes(p), `غير مخفي لليدوية: ${p}`);
    assert.ok(!paths.includes(p), p);
  }
  for (const p of ['reports/partner-ledger', 'reports/aged-receivable', 'reports/aged-payable']) assert.ok(paths.includes(p), `يبقى لليدوية: ${p}`);
  // المسارات القديمة في القائمة نفسها كما كانت
  for (const p of ['customers/invoices', 'customers/receipts', 'customers/custody', 'customers/paylink', 'review/events', 'review/late']) {
    assert.ok(MANUAL_LEDGER_HIDDEN_PATHS.includes(p), p);
  }
  // القسم الذي يُفرغ يُخفى: «الشركاء» يبقى بثلاثة عناصر لليدوية
  const partners = manual.find(m => m.key === 'reports')!.sections.find(s => s.label === 'الشركاء')!;
  assert.deepEqual(partners.items.map(i => (i.kind === 'route' ? i.path : '')), ['reports/partner-ledger', 'reports/aged-receivable', 'reports/aged-payable']);
});
