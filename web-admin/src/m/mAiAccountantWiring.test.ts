// «المحاسب الذكي AI» — حزمة D (ربط الويب): مفتاح المالك، رابط القائمة الجانبية بعد «الدفاتر»، المسار، وبلاطة /m وشاشتها.
// اسمه ليس mAiAccountant.test.ts: يختلف عن MAiAccountant.tsx بحالة الأحرف وحدها (حارس mLotsLogic.test — ويندوز وماك يخلطانهما).
// حرّاسٌ نصّية حيث الربط سطرٌ في ملفٍّ كبير، وتقييمٌ سلوكيّ لفلتر القائمة وحارس البلاطة كما هما في المصدر حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canLedger } from '../lib/ledgerPerms';
import { locationsPageAllowed } from '../lib/locations';
import { DICT, PHRASES } from '../i18n/strings';

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, 'src', ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

type NavUser = Record<string, unknown> | null;
type NavCfg = Record<string, unknown> | null | undefined;
type NavItem = { to: string; permission?: string };

// ═══ القائمة الجانبية: الفلتر نفسه من MainLayout مُقيَّماً ═══

function sidebar() {
  const s = read('layouts', 'MainLayout.tsx');
  const pagesSrc = /const ACCOUNTING_PAGES = (\[[^\]]*\]);/.exec(s)?.[1];
  assert.ok(pagesSrc, 'ACCOUNTING_PAGES غير موجودة');
  const accountingPages = JSON.parse(pagesSrc.replace(/'/g, '"')) as string[];
  const listAt = s.indexOf('const navItems = [');
  const list = s.slice(listAt, s.indexOf('\n];', listAt));
  const items: NavItem[] = [...list.matchAll(/^\s*\{ to: '([^']+)'[^\n]*$/gm)].map(m => ({
    to: m[1],
    permission: /permission: '(\w+)'/.exec(m[0])?.[1],
  }));
  const head = 'navItems.filter(item => ';
  const from = s.indexOf(head) + head.length;
  let expr = s.slice(from, s.indexOf(').map(item => (', from));
  // الصيغة الوحيدة الخاصّة بـTS في التعبير — تُنزع ليُقيَّم كما هو
  assert.equal(expr.split(' as keyof typeof user').length, 2, 'تغيّر شكل فلتر القائمة — حدّث الحارس');
  expr = expr.replace(' as keyof typeof user', '');
  const fn = new Function('item', 'user', 'companyCfg', 'impersonating', 'ACCOUNTING_PAGES', 'locationsPageAllowed', 'canLedger', `return ${expr};`);
  const visible = (user: NavUser, cfg: NavCfg, impersonating: string | null = null) =>
    items.filter(item => fn(item, user, cfg, impersonating, accountingPages, locationsPageAllowed, canLedger) === true).map(i => i.to);
  return { s, items, accountingPages, visible };
}

// مالك الشركة: ADMIN بإدارة المستخدمين ⇒ يملك صلاحيات الدفاتر ضمناً (canLedger)
const OWNER = { role: 'ADMIN', canManageCompanyUsers: true };
const BOOKS_ON = { accountingSuiteEnabled: true, accountingEnabled: true };

test('القائمة: «المحاسب الذكي» مباشرةً بعد «الدفاتر» بصلاحية التقارير وأيقونة BrainCircuit ومفتاح nav.aiAccountant', () => {
  const { s, items } = sidebar();
  const at = items.findIndex(i => i.to === '/app/ai-accountant');
  assert.ok(at > 0, 'البند غير موجود');
  assert.equal(items[at - 1].to, '/app/ledger', 'ليس تحت «الدفاتر» مباشرة');
  assert.equal(items[at + 1].to, '/app/company-users', 'قبل «مستخدمو الشركة» (قرار المالك)');
  assert.ok(s.includes("{ to: '/app/ai-accountant', icon: BrainCircuit, label: 'nav.aiAccountant', permission: 'canViewReports' }"));
  assert.match(s, /import \{[^}]*\bBrainCircuit\b[^}]*\} from 'lucide-react';/);
  assert.match(s, /aiAccountantEnabled\?: boolean(; \w+\?: boolean)* \} \| null/, 'العَلَم في نوع إعدادات الشركة');
  assert.ok(s.includes("(item.to !== '/app/ai-accountant' || (companyCfg?.aiAccountantEnabled === true && (user?.scopeEnabled !== true || !!impersonating)))"));
});

test('القائمة: مخفيٌّ بلا العَلَم (غائبٌ أو false) وظاهرٌ به — `=== true` لا `!== false`', () => {
  const { visible } = sidebar();
  assert.ok(!visible(OWNER, BOOKS_ON).includes('/app/ai-accountant'), 'العَلَم الغائب (ردٌّ قديم) يُظهره');
  assert.ok(!visible(OWNER, { ...BOOKS_ON, aiAccountantEnabled: false }).includes('/app/ai-accountant'));
  assert.ok(!visible(OWNER, null).includes('/app/ai-accountant'), 'إعداداتٌ لم تصل تُظهره');
  const on = visible(OWNER, { ...BOOKS_ON, aiAccountantEnabled: true });
  assert.ok(on.includes('/app/ai-accountant'));
  assert.equal(on[on.indexOf('/app/ledger') + 1], '/app/ai-accountant', 'في الشريط المعروض: بعد «الدفاتر» مباشرة');
});

test('القائمة: يتبع بوّابات الخادم — المحاسبة المطفأة، وصلاحية التقارير، والنطاق المقيَّد (إلا جلسة المالك)', () => {
  const { visible, accountingPages } = sidebar();
  const cfg = { aiAccountantEnabled: true };
  assert.ok(accountingPages.includes('/app/ai-accountant'), 'من الصفحات المحاسبية');
  assert.ok(!visible(OWNER, { ...cfg, accountingEnabled: false }).includes('/app/ai-accountant'), 'ACCOUNTING_NOT_ALLOWED');
  assert.ok(!visible({ ...OWNER, canViewReports: false }, cfg).includes('/app/ai-accountant'), 'canViewReports');
  assert.ok(visible({ role: 'ADMIN' }, cfg).includes('/app/ai-accountant'), 'الصلاحية الغائبة (مستخدمٌ قديم) لا تمنع — كبقيّة البنود');
  assert.ok(!visible({ role: 'ADMIN', scopeEnabled: true }, cfg).includes('/app/ai-accountant'), 'AI_ACCOUNTANT_SCOPED');
  assert.ok(visible({ role: 'ADMIN', scopeEnabled: true }, cfg, 'شركة').includes('/app/ai-accountant'), 'جلسة المالك لا نطاق لها');
  // بلا دفاتر: يظهر للقراءة (لا يشترط الدفاتر) — فيبقى بعد «التقارير» وقبل «مستخدمو الشركة»
  const noBooks = visible(OWNER, cfg);
  assert.ok(!noBooks.includes('/app/ledger') && noBooks.includes('/app/ai-accountant'), 'القراءة لكل شركة مفعّلة ولو بلا دفاتر');
});

// ═══ المسار ═══

test('App.tsx: صفحةٌ كسولة على مستوى /app (لا تحت /app/ledger) بصلاحية التقارير', () => {
  const s = read('App.tsx');
  assert.ok(s.includes("const AiAccountantPage = lazy(() => import('./pages/AiAccountantPage'));"));
  assert.ok(s.includes('<Route path="ai-accountant" element={<PermissionRoute permission="canViewReports"><AiAccountantPage /></PermissionRoute>} />'));
  assert.doesNotMatch(s, /^import AiAccountantPage/m, 'استيرادٌ ثابت يُدخل الصفحة حزمة الإقلاع');
  // أخٌ لمسار الدفاتر في كتلة /app — LedgerRoute يشترط الدفاتر والقراءة لا تشترطها
  const ledger = s.indexOf('<Route path="ledger" element={<LedgerRoute');
  const ai = s.indexOf('<Route path="ai-accountant"');
  const appEnd = s.indexOf('<Route path="*" element={<Navigate to="/app" replace />} />');
  assert.ok(ledger > 0 && ai > ledger && appEnd > ai, 'داخل كتلة /app بعد الدفاتر');
  assert.ok(!read('pages', 'ledger', 'routes.ts').includes('ai-accountant'), 'ليس صفاً في LEDGER_ROUTES');
});

// ═══ مفتاح المالك ═══

test('نافذة المالك: خانة «المحاسب الذكي AI» مطفأة افتراضياً (`!!`) وتُرسل في التحديث، بعد صندوق الدفاتر وتتعطّل بلا المحاسبة', () => {
  const s = read('pages', 'PlatformPage.tsx');
  const modal = s.slice(s.indexOf('function EditTenantModal('), s.indexOf('/** رد PUT /tenants/:id/ledger-paylink-fee-invoice-from'));
  assert.ok(modal.length > 1000, 'EditTenantModal غير موجودة');
  assert.match(modal, /const \[aiAccountantEnabled, setAiAccountantEnabled\] = useState\(!!tenant\.aiAccountantEnabled\);/);
  const payload = modal.slice(modal.indexOf('mutationFn: () => tenantApi.update(tenant.id, {'), modal.indexOf('onSuccess:'));
  assert.match(payload, /\n {6}aiAccountantEnabled,\n/, 'العَلَم في حمولة tenantApi.update');
  const suite = modal.indexOf('checked={accountingSuiteEnabled}');
  const box = modal.indexOf('checked={aiAccountantEnabled} disabled={!accountingEnabled} onChange={e => setAiAccountantEnabled(e.target.checked)}');
  const after = modal.indexOf('<LedgerPaylinkFeeSection');
  assert.ok(suite > 0 && box > suite && after > box, 'الخانة بعد صندوق الدفاتر وقبل أقسامه المستقلّة');
  assert.ok(modal.slice(box, after).includes("{tr('تفعيل المحاسب الذكي AI لهذه الشركة')}"));
  // لا في نموذج الإنشاء: الأعلام في التحديث وحده (كحارس الخادم)
  assert.equal((s.match(/aiAccountantEnabled/g) || []).length - (modal.match(/aiAccountantEnabled/g) || []).length, 1, 'خارج النافذة: الشارة وحدها');
});

test('صفّ الشركة: شارة «المحاسب الذكي» للمفعّلة وحدها (=== true)', () => {
  const s = read('pages', 'PlatformPage.tsx');
  const col = s.slice(s.indexOf('function TenantColumn('), s.indexOf('function EditTenantModal('));
  assert.match(col, /\{t\.aiAccountantEnabled === true && \(/);
  assert.ok(col.includes("{tr('المحاسب الذكي')}"));
});

test('نوع Tenant يحمل العلم اختيارياً', () => {
  const s = read('types', 'index.ts');
  const tenant = s.slice(s.indexOf('export interface Tenant {'), s.indexOf('\n}', s.indexOf('export interface Tenant {')));
  assert.match(tenant, /\n {2}aiAccountantEnabled\?: boolean;/);
});

// ═══ /m: البلاطة والقوقعة والشاشة ═══

test('الرئيسية: «aiAccountant» في HomeSection وبلاطتها بعد «الموردون» مباشرة بأيقونة BrainCircuit — والأعمدة كما كانت', () => {
  const s = read('m', 'MHome.tsx');
  assert.match(s, /export type HomeSection = [^;]*'aiAccountant'/);
  const tiles = s.slice(s.indexOf('const SECTION_TILES'), s.indexOf('];', s.indexOf('const SECTION_TILES')));
  const ids = [...tiles.matchAll(/\{ id: '(\w+)'/g)].map(m => m[1]);
  assert.equal(ids[ids.indexOf('suppliers') + 1], 'aiAccountant', 'في الخانة بجانب «الموردون» (قرار المالك)');
  assert.ok(tiles.includes("{ id: 'aiAccountant', label: 'المحاسب الذكي', icon: BrainCircuit }"));
  assert.match(s, /import \{[^}]*\bBrainCircuit\b[^}]*\} from 'lucide-react';/);
  assert.match(s, /n >= 5 \? 'grid-cols-3' : n === 4 \? 'grid-cols-2' : n === 3 \? 'grid-cols-3' : n === 2 \? 'grid-cols-2' : 'grid-cols-1'/);
});

test('القوقعة: البلاطة بحارس موجّه /api/ai-accountant بترتيبه — المحاسبة ثمّ العلم (=== true) ثمّ التقارير ثمّ النطاق', () => {
  const s = read('m', 'MobileApp.tsx');
  assert.match(s, /const MAiAccountant = lazy\(\(\) => import\('\.\/MAiAccountant'\)\);/, 'الشاشة يجب أن تكون كسولة');
  assert.doesNotMatch(s, /^import MAiAccountant/m, 'استيرادٌ ثابت يُدخل الشاشة حزمة الإقلاع');
  assert.ok(s.includes("const aiAccountantOn = (company as { aiAccountantEnabled?: boolean } | null)?.aiAccountantEnabled === true;"));
  const exprM = /const aiAccountantAllowed = ([^;]+);/.exec(s);
  assert.ok(exprM, 'aiAccountantAllowed غير موجود');
  const allowed = new Function('accountingOn', 'aiAccountantOn', 'can', 'user', `return ${exprM[1]};`) as
    (acc: boolean, on: boolean, can: (u: NavUser, k: string) => boolean, u: NavUser) => boolean;
  const can = (u: NavUser, k: string) => !!u && u[k] !== false; // دلالة m/perms.ts
  const admin = { role: 'ADMIN' };
  assert.equal(allowed(true, true, can, admin), true);
  assert.equal(allowed(false, true, can, admin), false, 'ACCOUNTING_NOT_ALLOWED');
  assert.equal(allowed(true, false, can, admin), false, 'العلم مطفأ');
  assert.equal(allowed(true, true, can, { ...admin, canViewReports: false }), false, 'canViewReports');
  assert.equal(allowed(true, true, can, { ...admin, scopeEnabled: true }), false, 'AI_ACCOUNTANT_SCOPED');
  assert.equal(allowed(true, true, can, null), false);
  // تُضاف فوق قائمة الأقسام الأصلية بمذكَّرة ثانية — تبعيات الأولى كما هي (حارس mLotsLogic.test)
  assert.match(s, /\}, \[user, accountingOn, warehouseOn, lotOn\]\);/);
  assert.ok(s.includes("() => (aiAccountantAllowed ? [...baseSections, 'aiAccountant'] : baseSections),"));
  assert.ok(s.includes('[baseSections, aiAccountantAllowed]'));
  assert.match(s, /section === 'aiAccountant' \? <MAiAccountant onBack=\{\(\) => setSection\(null\)\} \/>/, 'القسم غير موصول');
  const tabs = s.slice(s.indexOf('const TABS'), s.indexOf('/** حدث تثبيت PWA'));
  assert.doesNotMatch(tabs, /aiAccountant/, 'المقاعد خمسة وقد امتلأت — المحاسب قسمٌ لا تبويب');
});

test('MAiAccountant: ترويسة برجوع ثمّ المحادثة نفسها بـcompact، بلا تمريرٍ ثانٍ حولها', () => {
  const s = read('m', 'MAiAccountant.tsx');
  assert.match(s, /import AiAccountantChat from '\.\.\/components\/aiAccountant\/AiAccountantChat';/);
  assert.match(s, /export default function MAiAccountant\(\{ onBack \}: \{ onBack: \(\) => void \}\)/);
  assert.match(s, /<MHeader title=\{tr\('المحاسب الذكي'\)\}[^>]*onBack=\{onBack\} \/>/);
  assert.ok(s.includes('<AiAccountantChat compact />'));
  assert.ok(!s.includes('<MScreen') && !/overflow-y-auto/.test(s), 'المحادثة تمرّر رسائلها وحدها');
});

// ═══ الترجمات (القاموس ملك الحزمة C1 — هذه الحرّاس تتحقّق بعد الدمج) ═══

test('الترجمات: مفتاح التنقّل وعبارات هذه الحزمة بالأربع، والفرنسية بـ’ لا \'', () => {
  const nav = DICT['nav.aiAccountant'];
  assert.ok(nav, "DICT['nav.aiAccountant'] غائب — الرابط يظهر بمفتاحه الخام");
  assert.equal(nav.ar, 'المحاسب الذكي');
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(nav[l]?.trim(), `nav.aiAccountant بلا ${l}`);
  const literals = new Set<string>();
  for (const f of [['m', 'MAiAccountant.tsx'], ['pages', 'PlatformPage.tsx']]) {
    const src = read(...f);
    for (const m of src.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)) if (/المحاسب الذكي/.test(m[1]) || f[0] === 'm') literals.add(m[1]);
  }
  literals.add('المحاسب الذكي'); // بلاطة MHome تمرّ إلى tr بمتغيّر
  assert.ok(literals.size >= 4, [...literals].join(' | '));
  for (const k of literals) {
    const p = PHRASES[k];
    assert.ok(p, `بلا ترجمة: ${k}`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(p[l]?.trim(), `${k} بلا ${l}`);
    assert.ok(!p.fr.includes("'"), `فاصلة فرنسية مستقيمة: ${k}`);
  }
});
