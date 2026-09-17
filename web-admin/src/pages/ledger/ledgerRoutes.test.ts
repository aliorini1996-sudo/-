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
const DELIVERED = new Set(['M2', 'M3']);

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
  // مسارات M4+ في القائمتين لا تُسجَّل قبل مرحلتها
  for (const p of ['customers/adjustments', 'review/uncosted']) assert.ok(!LEDGER_ROUTES.some(r => r.path === p), `مسار لمرحلة لاحقة: ${p}`);
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
  // ترتيب القوائم مرآة Odoo (§8.2): العملاء قبل المحاسبة، ومراجعة بعدها وقبل التهيئة، و«العملاء ← /app/customers» فيها
  assert.deepEqual(menus.map(m => m.key), ['customers', 'accounting', 'review', 'config']);
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
  ].sort());
  assert.ok(!flat(visibleFor(viewer)).includes('review/audit'), 'سجل التدقيق لمن يملك canConfigureLedger وحده');
  assert.deepEqual(visibleFor(viewer).find(m => m.key === 'config')?.sections.length, 1, 'القسم بلا عناصر ظاهرة يُخفى');

  const closer = u({ canCloseLedgerPeriods: true });
  assert.ok(flat(visibleFor(closer)).includes('dialog:lockDates'));
  assert.ok(!flat(visibleFor(viewer)).includes('dialog:lockDates'), '«تواريخ الإقفال…» لمن يملك canCloseLedgerPeriods وحده');

  const configurer = u({ canConfigureLedger: true });
  assert.ok(flat(visibleFor(configurer)).includes('config/settings'));
  assert.ok(flat(visibleFor(configurer)).includes('review/audit'));
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
