// «المحاسب الذكي AI» — حزمة D (ربط الويب): مفتاح المالك، رابط القائمة الجانبية بعد «الدفاتر»، المسار، وبلاطة /m وشاشتها.
// اسمه ليس mAiAccountant.test.ts: يختلف عن MAiAccountant.tsx بحالة الأحرف وحدها (حارس mLotsLogic.test — ويندوز وماك يخلطانهما).
// حرّاسٌ نصّية حيث الربط سطرٌ في ملفٍّ كبير، وتقييمٌ سلوكيّ لفلتر القائمة وحارس البلاطة كما هما في المصدر حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { canLedger } from '../lib/ledgerPerms';
import { locationsPageAllowed } from '../lib/locations';
import { DICT, PHRASES } from '../i18n/strings';
import MDocViewer, { docViewKind, revokeDelayMs } from './MDocViewer';
import { sniffDocMime } from '../lib/aiAccountantDocs';

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
  // ورفع المستندات: عارض الجوال يُمرَّر للمحادثة المشتركة (renderViewer) — والمحادثة هي نفسها بـcompact
  assert.ok(s.includes('<AiAccountantChat compact renderViewer={renderViewer} />'));
  assert.ok(!s.includes('<MScreen') && !/overflow-y-auto/.test(s), 'المحادثة تمرّر رسائلها وحدها');
});

// ═══ /m: رفع المستندات في محادثة المحاسب (طلب المالك ١٨ نوفمبر — الحزمة P5) ═══

/** دالّةٌ صرفة من مصدر MAiAccountant (الملف يستورد عميل الـAPI فلا يُحمَّل في node) — جسمها JS بلا أنواع، وثوابتها من المصدر نفسه */
function pureFn<T extends (...a: number[]) => number>(src: string, name: string, params: string[], consts: string[]): T {
  const at = src.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `${name} غير موجودة`);
  const open = src.indexOf('): number {', at) + '): number {'.length;
  const body = src.slice(open, src.indexOf('\n}', open));
  const vals = consts.map(c => {
    const m = new RegExp(`const ${c} = (\\d+);`).exec(src);
    assert.ok(m, `${c} غير موجود`);
    return Number(m[1]);
  });
  const f = new Function(...consts, ...params, body) as (...a: number[]) => number;
  return ((...a: number[]) => f(...vals, ...a)) as T;
}

test('MAiAccountant: العارض MDocViewer عبر renderViewer بمفتاح المستند، والبايتات من documents.content كـBlob', () => {
  const s = read('m', 'MAiAccountant.tsx');
  assert.match(s, /import MDocViewer, \{ type MDocViewerDoc \} from '\.\/MDocViewer';/, 'استيرادٌ ثابت: الشاشة كسولةٌ أصلاً');
  assert.match(s, /\(doc: MDocViewerDoc, onClose: \(\) => void, src\?: string \| null\) =>\s*<MDocViewer key=\{doc\.id\} doc=\{doc\} onClose=\{onClose\} load=\{loadDocContent\} src=\{src\} \/>/,
    'بمفتاح المستند: تبديله يعيد الجلب ويُبطل رابط السابق');
  assert.match(s, /const renderViewer = useCallback\(/, 'مرجعٌ ثابت — لا عارضٌ يُعاد تركيبه كل رسم');
  assert.match(s, /await aiAccountantApi\.documents\.content\(id\);/);
  assert.ok(s.includes('return data instanceof Blob ? data : new Blob([data as BlobPart]);'));
});

test('المحادثة المشتركة تقبل renderViewer (عقد الحزمة P4b) — الجوال يعرض طبقته بدل عارض سطح المكتب', () => {
  const chat = read('components', 'aiAccountant', 'AiAccountantChat.tsx');
  assert.match(chat, /renderViewer\?:\s*\(\s*doc:\s*\w+,\s*onClose:\s*\(\)\s*=>\s*void(,\s*src\?:[^)]*)?\s*\)\s*=>\s*(React\.)?ReactNode/,
    'النوع: (doc, onClose[, src]) => ReactNode');
  assert.match(chat, /renderViewer\(/, 'يُستدعى حين يُمرَّر');
});

test('المدخل على الجوال: الصينية بين شريط القوالب والنموذج، وحشوة المنطقة الآمنة باقيةٌ على النموذج (أسفل الشاشة)', () => {
  const chat = read('components', 'aiAccountant', 'AiAccountantChat.tsx');
  assert.match(chat, /import AttachTray from '\.\/docs\/AttachTray';/);
  const bar = chat.indexOf('<TemplateBar');
  const tray = chat.indexOf('<AttachTray', bar);
  const form = chat.indexOf('<form', bar);
  assert.ok(bar > 0 && tray > bar && form > tray, 'TemplateBar ثم AttachTray ثم النموذج');
  assert.ok(chat.slice(form, form + 700).includes("'px-3 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))]'"),
    'compact: حشوة المنطقة الآمنة على النموذج — آخر ما في الشاشة فوق مؤشّر الآيفون');
});

test('بلا اتصال: شريطٌ بنمط القوقعة (navigator.onLine وonline/offline) — ولا طابور مستندات على الجهاز', () => {
  const s = read('m', 'MAiAccountant.tsx');
  assert.ok(s.includes("const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;"));
  assert.ok(s.includes("window.addEventListener('online', sync);") && s.includes("window.addEventListener('offline', sync);"));
  assert.ok(s.includes("window.removeEventListener('online', sync);") && s.includes("window.removeEventListener('offline', sync);"));
  assert.match(s, /\{!online && \(\s*<div role="status"/);
  assert.ok(s.includes("{tr('لا يوجد اتصال — رفع المستندات يحتاج اتصالاً بالإنترنت ولا يحفظ على الجهاز')}"));
  for (const f of ['MAiAccountant.tsx', 'MDocViewer.tsx']) {
    assert.doesNotMatch(read('m', f), /localStorage|sessionStorage|indexedDB|outbox|offlineSync/i, `${f}: المستند لا يُحفظ على الجهاز`);
  }
});

test('لوحة المفاتيح لا تغطّي بطاقة المستند: ما تغطّيه يُطرح من الارتفاع، وحقل البطاقة يُكشف', () => {
  const s = read('m', 'MAiAccountant.tsx');
  const inset = pureFn<(layoutH: number, vvH: number, vvTop: number) => number>(s, 'keyboardInset', ['layoutH', 'vvH', 'vvTop'], ['KB_MIN_PX']);
  assert.equal(inset(800, 800, 0), 0, 'بلا لوحة');
  assert.equal(inset(800, 450, 0), 350, 'آيفون/كروم ١٠٨+: التخطيط باقٍ والمرئيّ قصُر');
  assert.equal(inset(800, 449.6, 0), 350, 'تقريب');
  assert.equal(inset(800, 450, 200), 150, 'آيفون أزاح المرئيّ: يُعوَّض ما تحته وحده');
  assert.equal(inset(800, 450, 350), 0, 'أزاحه كلّه');
  assert.equal(inset(450, 450, 0), 0, 'أندرويد resizes-content قصّر التخطيط نفسه — لا تعويض مرّتين');
  assert.equal(inset(800, 744, 0), 0, 'شريط أدوات المتصفّح ليس لوحة مفاتيح');

  // معاملاتها كائنات بأنواع: يُستبدل التوقيع بمعاملاتٍ رقمية تُبنى منها الكائنات نفسها
  const sig = 'export function revealDelta(field: { top: number; bottom: number }, box: { top: number; bottom: number }, view: { top: number; bottom: number }): number {';
  assert.ok(s.includes(sig), 'تغيّر توقيع revealDelta — حدّث الحارس');
  const reveal = pureFn<(...a: number[]) => number>(
    s.replace(sig, 'export function revealDelta(): number {\n  const field = { top: fT, bottom: fB }, box = { top: bT, bottom: bB }, view = { top: vT, bottom: vB };'),
    'revealDelta', ['fT', 'fB', 'bT', 'bB', 'vT', 'vB'], ['REVEAL_GAP_PX']);
  const gap = Number(/const REVEAL_GAP_PX = (\d+);/.exec(s)?.[1]);
  assert.equal(reveal(300, 340, 56, 700, 0, 800), 0, 'ظاهرٌ أصلاً');
  assert.equal(reveal(500, 540, 56, 700, 0, 450), 540 - (450 - gap), 'تحت اللوحة ⇒ يُرفع فوقها بهامش');
  assert.equal(reveal(20, 60, 56, 700, 0, 450), 20 - (56 + gap), 'فوق الصندوق ⇒ يُنزل');
  assert.equal(reveal(300, 800, 56, 700, 0, 450), 300 - (56 + gap), 'أطول من المرئيّ ⇒ أعلاه أولاً');
  assert.equal(reveal(150, 190, 56, 700, 200, 650), 150 - (200 + gap), 'آيفون أزاح المرئيّ: أعلاه من الإزاحة');
  assert.equal(reveal(260, 300, 56, 700, 200, 650), 0, 'داخل المرئيّ المُزاح');

  // الربط: الإزاحة تطرح من ارتفاع الشاشة، والكشف لحقول الرسائل وحدها ([data-entry]) بعد الرسم وبعد انزلاق اللوحة
  assert.ok(s.includes('style={kb ? { paddingBottom: kb } : undefined} onFocus={onFocusIn}'));
  assert.ok(s.includes("vv.addEventListener('resize', sync);") && s.includes("vv.addEventListener('scroll', sync);"));
  assert.ok(s.includes("vv.removeEventListener('resize', sync);") && s.includes("vv.removeEventListener('scroll', sync);"));
  assert.ok(s.includes("!el.closest('[data-entry]')"), 'المدخل أسفل الصفحة لا يُمرَّر — يستقرّ فوق اللوحة بالارتفاع');
  assert.match(s, /useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[kb, reveal\]\);/);
  assert.ok(s.includes('timer.current = window.setTimeout(reveal, 350);'));
  assert.ok(s.includes('useEffect(() => () => window.clearTimeout(timer.current), []);'), 'المهلة تُلغى عند المغادرة');
});

test('MDocViewer: قائمة مرآة العقد (lib/aiAccountantDocs) — القائمة البيضاء وتوقيع البايتات كالخادم، والإبطال بمهلته', () => {
  // المصدر الواحد: الجوال لا ينسخ الفحص فيفترق عن سطح المكتب والرفع يوماً
  const s = read('m', 'MDocViewer.tsx');
  assert.ok(s.includes("import { BLOB_REVOKE_DELAY_MS, isDocMime, sniffDocMime, type DocMime } from '../lib/aiAccountantDocs';"));
  assert.doesNotMatch(s, /0x25|0xff, 0xd8|0x89, 0x50|'image\/png'/, 'لا نسخة ثانية من القائمة ولا التوقيعات');

  assert.equal(docViewKind('application/pdf'), 'pdf');
  assert.equal(docViewKind('image/jpeg'), 'image');
  assert.equal(docViewKind('IMAGE/PNG; charset=binary'), 'image');
  for (const bad of ['image/webp', 'image/heic', 'text/html', 'image/svg+xml', 'constructor', '__proto__', 'toString', '', null, undefined, 7]) {
    assert.equal(docViewKind(bad), null, String(bad));
  }
  const b = (...x: number[]) => new Uint8Array(x);
  const ascii = (t: string) => new Uint8Array([...t].map(c => c.charCodeAt(0)));
  assert.equal(sniffDocMime(ascii('%PDF-1.7\n')), 'application/pdf');
  assert.equal(sniffDocMime(b(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffDocMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffDocMime(ascii('%PDF')), null, 'مقطوع');
  assert.equal(sniffDocMime(b(0x89, 0x50, 0x4e, 0x47)), null, 'مقطوع');
  assert.equal(sniffDocMime(ascii('<html>')), null);
  assert.equal(sniffDocMime(ascii('<svg ')), null);
  assert.equal(sniffDocMime(new Uint8Array(0)), null);
  assert.equal(revokeDelayMs('pdf'), 60_000, 'لسانٌ فُتح للتوّ قد يكون ما زال يقرؤه');
  assert.equal(revokeDelayMs('image'), 0);
});

test('MDocViewer: طبقةٌ بملء الشاشة — الصورة داخلها، وPDF برابط لمسة، وما لا يُعرف لا يُعرض', () => {
  let loads = 0;
  const load = async () => { loads++; return new Blob([]); };
  const html = (doc: { id: string; fileName: string; mimeType: string; sizeBytes?: number }, src?: string) =>
    renderToStaticMarkup(createElement(MDocViewer, { doc, onClose: () => {}, load, src }));

  const img = html({ id: 'd1', fileName: 'فاتورة صيانة.jpg', mimeType: 'image/jpeg', sizeBytes: 2048 }, 'blob:img-1');
  assert.match(img, /class="fixed inset-0 z-\[60\][^"]*"/);
  assert.match(img, /role="dialog"/);
  assert.match(img, /aria-modal="true"/);
  assert.match(img, /dir="rtl"/);
  assert.match(img, /<img src="blob:img-1" alt="فاتورة صيانة.jpg"/);
  assert.match(img, /aria-label="إغلاق"/);
  assert.ok(img.includes('2 KB'));
  assert.ok(!img.includes('<a '), 'الصورة داخل الشاشة لا في لسان');

  const pdf = html({ id: 'd2', fileName: 'عقد.pdf', mimeType: 'application/pdf' }, 'blob:pdf-1');
  assert.match(pdf, /<a href="blob:pdf-1" target="_blank" rel="noopener noreferrer"/);
  assert.ok(pdf.includes('فتح الملف'));
  assert.ok(!pdf.includes('<img'));

  const loading = html({ id: 'd3', fileName: 'x.pdf', mimeType: 'application/pdf' });
  assert.ok(loading.includes('جاري التحميل') && !loading.includes('<a ') && !loading.includes('<img'));
  // نوعٌ فارغ (بطاقة قيدٍ لا تعرفه): يُجلب ويحكم التوقيع — لا يُرفض مسبقاً
  const blank = html({ id: 'd6', fileName: 'مستند', mimeType: '' });
  assert.ok(blank.includes('جاري التحميل') && !blank.includes('تعذر فتح المرفق'));

  for (const mimeType of ['text/html', 'image/svg+xml']) {
    for (const src of ['blob:evil', undefined]) {
      const bad = html({ id: 'd4', fileName: 'x', mimeType }, src);
      assert.ok(!bad.includes('blob:evil'), `${mimeType}: الرابط لا يصل الصفحة`);
      assert.ok(bad.includes('تعذر فتح المرفق') && !bad.includes('إعادة المحاولة') && !bad.includes('جاري التحميل'),
        `${mimeType}: نوعٌ خارج القائمة لا يُجلب ولا يُعاد`);
    }
  }
  const localBlank = html({ id: 'd7', fileName: 'x', mimeType: '' }, 'blob:local');
  assert.ok(!localBlank.includes('blob:local') && localBlank.includes('تعذر فتح المرفق'), 'معاينةٌ محلّية بلا نوعٍ معروف لا تُعرض');

  const xss = html({ id: 'd5', fileName: '<img src=x onerror=alert(1)>.pdf', mimeType: 'application/pdf' }, 'blob:p');
  assert.ok(!xss.includes('<img src=x') && xss.includes('&lt;img src=x'), 'اسم الملف نصٌّ مهرَّب');
  assert.equal(loads, 0, 'الرسم وحده لا يجلب — الجلب في تأثيرٍ بعد التركيب، ولا جلب مع src');
});

test('MDocViewer: الرجوع يُغلقه، والجلب المتأخّر لا يُنشئ رابطاً، والرابط يُبطَل عند الإغلاق — والطبقة في body', () => {
  const s = read('m', 'MDocViewer.tsx');
  assert.ok(s.includes('useBackClose(true, onClose);'), 'زرّ الرجوع/سحبة الحافة تُغلقه لا تُخرج من التطبيق');
  const alive = s.indexOf('if (!alive) return;');
  const create = s.indexOf('URL.createObjectURL(');
  assert.ok(alive > 0 && create > alive, 'لا رابط لعارضٍ أُغلق أثناء الجلب');
  assert.ok(s.includes("if (!mime || (declared && viewKindOfMime(mime) !== declared)) throw new Error('DOC_SIGNATURE');"), 'التوقيع يطابق النوع المعلن');
  assert.ok(s.includes('if (src || refused) return;'), 'نوعٌ معلن خارج القائمة لا يُجلب');
  assert.ok(s.includes('new Blob([blob], { type: mime })'), 'الـBlob بالنوع المفحوص لا بما ردّه الخادم');
  assert.match(s, /useEffect\(\(\) => \(\) => \{\s*const o = owned\.current;\s*owned\.current = null;\s*if \(o\) revokeLater\(o\.url, o\.kind\);\s*\}, \[\]\);/);
  assert.ok(s.includes('setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs(kind))'));
  assert.ok(s.includes("createPortal(overlay, document.body)"));
  assert.doesNotMatch(s, /window\.open\(/, 'لا نافذة تُفتح برمجياً — يحجبها المتصفّح بعد انتظار الشبكة');
});

// ═══ الترجمات (القاموس ملك الحزمة C1 — هذه الحرّاس تتحقّق بعد الدمج) ═══

test('الترجمات: مفتاح التنقّل وعبارات هذه الحزمة بالأربع، والفرنسية بـ’ لا \'', () => {
  const nav = DICT['nav.aiAccountant'];
  assert.ok(nav, "DICT['nav.aiAccountant'] غائب — الرابط يظهر بمفتاحه الخام");
  assert.equal(nav.ar, 'المحاسب الذكي');
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(nav[l]?.trim(), `nav.aiAccountant بلا ${l}`);
  const literals = new Set<string>();
  for (const f of [['m', 'MAiAccountant.tsx'], ['m', 'MDocViewer.tsx'], ['pages', 'PlatformPage.tsx']]) {
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
