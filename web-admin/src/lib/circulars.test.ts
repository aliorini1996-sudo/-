/**
 * «التعميمات» — طرف الإدارة (طلب المالك ٢٣ نوفمبر ٢٠٢٦): منطق النموذج الصرف (حدود الخادم، وتاريخ الانتهاء، ونسبة القراءة،
 * وحالة العرض، والمرشّحون) مقيَّماً، ثم حرّاسٌ نصّية (اللوحة تعتمد React Query والمتصفّح): زرّ «التعميمات» في صفحة المناديب
 * بصلاحية المناديب وفي صفحة مستخدمي الشركة بصلاحية مستخدمي الشركة، كلٌّ بجمهوره، ومسارات /api/circulars في العميل،
 * وإبطال مفتاح القائمة بعد كل تعديل، ورسائل الخادم مترجمةً، والتواريخ بالمنسِّق الميلادي.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CIRCULAR_BODY_MAX, CIRCULAR_TITLE_MAX, buildCircularBody, canWithdrawCircular, circularCandidates, circularReadsKey,
  circularViewState, circularsKey, endOfLocalDay, filterPeopleByName, localDayOf, readPct, validateCircularDraft,
  type CircularDraft,
} from './circulars';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const panel = () => read('components', 'circulars', 'CircularsPanel.tsx');
const repsPage = () => read('pages', 'SalesRepsPage.tsx');
const usersPage = () => read('pages', 'CompanyUsersPage.tsx');

const NOW = new Date(2026, 10, 23, 10, 30); // ٢٣ نوفمبر ٢٠٢٦ ١٠:٣٠ بتوقيت الجهاز
const draft = (over: Partial<CircularDraft> = {}): CircularDraft => ({
  title: 'تعديل مواعيد الدوام', body: 'يبدأ الدوام الساعة الثامنة\nابتداءً من الأحد', targetAll: true, targetIds: [], expiresOn: '', ...over,
});

test('حدود النموذج = حدود الخادم حرفاً (العنوان ١٢٠ والنص ٤٠٠٠)', () => {
  assert.equal(CIRCULAR_TITLE_MAX, 120);
  assert.equal(CIRCULAR_BODY_MAX, 4000);
  const be = fs.readFileSync(path.join(process.cwd(), '..', 'backend', 'src', 'services', 'circulars.ts'), 'utf8');
  assert.match(be, new RegExp(`export const CIRCULAR_TITLE_MAX = ${CIRCULAR_TITLE_MAX};`), 'حدّ العنوان في الخادم تغيّر');
  assert.match(be, new RegExp(`export const CIRCULAR_BODY_MAX = ${CIRCULAR_BODY_MAX};`), 'حدّ النص في الخادم تغيّر');
});

test('validateCircularDraft: أول خطأ بترتيب الحقول، والنصّان مقصوصان كما يُرسَلان', () => {
  assert.equal(validateCircularDraft(draft(), NOW), null);
  assert.equal(validateCircularDraft(draft({ title: '   ' }), NOW), 'TITLE_EMPTY');
  assert.equal(validateCircularDraft(draft({ title: 'ع'.repeat(121) }), NOW), 'TITLE_LONG');
  assert.equal(validateCircularDraft(draft({ title: `  ${'ع'.repeat(120)}  ` }), NOW), null, 'المسافات حول ١٢٠ حرفاً تُقصّ');
  assert.equal(validateCircularDraft(draft({ body: '\n\n  ' }), NOW), 'BODY_EMPTY');
  assert.equal(validateCircularDraft(draft({ body: 'ن'.repeat(4001) }), NOW), 'BODY_LONG');
  assert.equal(validateCircularDraft(draft({ body: 'ن'.repeat(4000) }), NOW), null);
  // ترتيب الحقول: عنوانٌ فارغ قبل نصٍّ فارغ
  assert.equal(validateCircularDraft(draft({ title: '', body: '' }), NOW), 'TITLE_EMPTY');
  // «محددون» بلا أحد — و«الكل» لا يحتاج قائمة
  assert.equal(validateCircularDraft(draft({ targetAll: false, targetIds: [] }), NOW), 'NO_TARGETS');
  assert.equal(validateCircularDraft(draft({ targetAll: false, targetIds: [''] }), NOW), 'NO_TARGETS');
  assert.equal(validateCircularDraft(draft({ targetAll: false, targetIds: ['r1'] }), NOW), null);
  assert.equal(validateCircularDraft(draft({ targetAll: true, targetIds: [] }), NOW), null);
});

test('تاريخ الانتهاء: نهاية اليوم المختار بتوقيت الجهاز — اليوم نفسه صالح، والأمس مضى، والتاريخ المستحيل مرفوض', () => {
  const end = endOfLocalDay('2026-11-25');
  assert.ok(end);
  assert.deepEqual([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()], [2026, 10, 25, 23, 59, 59]);
  assert.equal(endOfLocalDay('2026-02-31'), null);
  assert.equal(endOfLocalDay('25/11/2026'), null);
  assert.equal(endOfLocalDay(''), null);
  assert.equal(localDayOf(NOW), '2026-11-23');
  assert.equal(validateCircularDraft(draft({ expiresOn: '2026-11-23' }), NOW), null, 'ينتهي اليوم ⇒ يظهر حتى آخره');
  assert.equal(validateCircularDraft(draft({ expiresOn: '2026-11-22' }), NOW), 'EXPIRES_PAST');
  assert.equal(validateCircularDraft(draft({ expiresOn: '2026-13-01' }), NOW), 'EXPIRES_INVALID');
  assert.equal(validateCircularDraft(draft({ expiresOn: '' }), NOW), null);
});

test('buildCircularBody: نصّان مقصوصان، وtargetIds بلا تكرار للمحددين وحدهم، والانتهاء ISO لنهاية اليوم أو null', () => {
  const all = buildCircularBody('REPS', draft({ title: '  عنوان  ', body: '\nسطر ١\nسطر ٢\n', targetIds: ['r1'] }));
  assert.deepEqual(all, { audience: 'REPS', title: 'عنوان', body: 'سطر ١\nسطر ٢', targetAll: true, expiresAt: null });
  assert.ok(!('targetIds' in all), '«الكل» لا يرسل قائمة');
  const some = buildCircularBody('USERS', draft({ targetAll: false, targetIds: ['a', 'b', 'a', ''], expiresOn: '2026-11-25' }));
  assert.equal(some.audience, 'USERS');
  assert.equal(some.targetAll, false);
  assert.deepEqual(some.targetIds, ['a', 'b']);
  assert.equal(some.expiresAt, endOfLocalDay('2026-11-25')!.toISOString());
  // الأسطر الداخلية تبقى (النص يُعرض pre-wrap)
  assert.ok(buildCircularBody('REPS', draft()).body.includes('\n'));
});

test('readPct: صحيحٌ ٠..١٠٠ بلا قسمةٍ على صفر', () => {
  assert.equal(readPct(0, 0), 0);
  assert.equal(readPct(3, 0), 0);
  assert.equal(readPct(0, 10), 0);
  assert.equal(readPct(1, 3), 33);
  assert.equal(readPct(2, 3), 67);
  assert.equal(readPct(10, 10), 100);
  assert.equal(readPct(12, 10), 100);
  assert.equal(readPct(Number.NaN, 10), 0);
});

test('حالة العرض: المسحوب مسحوب، والنشط الماضي انتهاؤه «منتهٍ»، والسحب للنشط وحده', () => {
  assert.equal(circularViewState({ status: 'ACTIVE', expiresAt: null }, NOW), 'ACTIVE');
  assert.equal(circularViewState({ status: 'ACTIVE', expiresAt: new Date(2026, 10, 24).toISOString() }, NOW), 'ACTIVE');
  assert.equal(circularViewState({ status: 'ACTIVE', expiresAt: new Date(2026, 10, 22).toISOString() }, NOW), 'EXPIRED');
  assert.equal(circularViewState({ status: 'WITHDRAWN', expiresAt: null }, NOW), 'WITHDRAWN');
  assert.equal(circularViewState({ status: 'WITHDRAWN', expiresAt: new Date(2026, 10, 22).toISOString() }, NOW), 'WITHDRAWN');
  assert.equal(circularViewState({ status: 'ACTIVE', expiresAt: 'not-a-date' }, NOW), 'ACTIVE');
  assert.equal(canWithdrawCircular({ status: 'ACTIVE', expiresAt: null }, NOW), true);
  assert.equal(canWithdrawCircular({ status: 'ACTIVE', expiresAt: new Date(2026, 10, 22).toISOString() }, NOW), false);
  assert.equal(canWithdrawCircular({ status: 'WITHDRAWN', expiresAt: null }, NOW), false);
});

test('المرشّحون: النشطون وحدهم وبلا الناشر، مرتّبين بالاسم — والبحث بالاسم', () => {
  const rows = [
    { id: 'u3', name: 'سامي', isActive: true },
    { id: 'me', name: 'أحمد', isActive: true },
    { id: 'u2', name: 'خالد', isActive: false },
    { id: 'u1', name: 'بدر' },
  ];
  assert.deepEqual(circularCandidates(rows, 'me').map((r) => r.id), ['u1', 'u3']);
  assert.deepEqual(circularCandidates(rows, null).map((r) => r.id), ['me', 'u1', 'u3']);
  assert.deepEqual(circularCandidates(undefined, 'me'), []);
  assert.deepEqual(filterPeopleByName(circularCandidates(rows, null), ' سا ').map((r) => r.id), ['u3']);
  assert.equal(filterPeopleByName(rows, '').length, rows.length);
  assert.deepEqual(filterPeopleByName([{ id: 'x', name: 'Ahmed Ali' }], 'ahmed').map((r) => r.id), ['x']);
});

test('مفاتيح React Query: القائمة [circulars, audience] و«من قرأ» تحتها فتُبطَل معها', () => {
  assert.deepEqual([...circularsKey('REPS')], ['circulars', 'REPS']);
  assert.deepEqual([...circularReadsKey('USERS', 'c1')].slice(0, 2), [...circularsKey('USERS')]);
});

test('العميل: circularsApi بمسارات /api/circulars الستة على نسخة api الافتراضية', () => {
  const s = read('api', 'client.ts');
  const at = s.indexOf('export const circularsApi = {');
  assert.ok(at > 0, 'circularsApi غائب');
  const block = s.slice(at, s.indexOf('};', at) + 2);
  assert.ok(block.includes("list: (audience: CircularAudience) => api.get('/circulars', { params: { audience } }),"), block);
  assert.ok(block.includes("create: (body: CircularCreateBody) => api.post('/circulars', body),"), block);
  assert.ok(block.includes('reads: (id: string) => api.get(`/circulars/${encodeURIComponent(id)}/reads`),'), block);
  assert.ok(block.includes('withdraw: (id: string) => api.post(`/circulars/${encodeURIComponent(id)}/withdraw`),'), block);
  assert.ok(block.includes("pending: () => api.get('/circulars/pending'),"), block);
  assert.ok(block.includes('ack: (id: string) => api.post(`/circulars/${encodeURIComponent(id)}/ack`),'), block);
  assert.ok(s.includes("import type { CircularAudience, CircularCreateBody } from '../lib/circulars';"));
});

test('صفحة المناديب: زرّ «التعميمات» بصلاحية المناديب يفتح اللوحة بجمهور REPS في PagePanelModal', () => {
  const s = repsPage();
  assert.ok(s.includes("import CircularsPanel from '../components/circulars/CircularsPanel';"));
  assert.ok(s.includes("const circularsOn = user?.role !== 'SALES_REP' && user?.canManageSalesReps !== false;"), 'شرط الإظهار تغيّر');
  assert.match(s, /\{circularsOn && \(\s*<button className="btn-secondary" onClick=\{\(\) => setCircularsOpen\(true\)\}><Megaphone size=\{16\} \/>\{tr\('التعميمات'\)\}<\/button>/, 'الزرّ بلا شرط');
  // بجوار «فرق العمل»
  assert.ok(s.indexOf("{tr('التعميمات')}</button>") > s.indexOf("{tr('فرق العمل')}</button>"));
  assert.match(s, /\{circularsOn && circularsOpen && \(\s*<PagePanelModal title=\{tr\('التعميمات'\)\} icon=\{<Megaphone size=\{20\} \/>\}/);
  assert.ok(s.includes('<CircularsPanel audience="REPS" onDirtyChange={(d) => { circularsDirty.current = d; }} />'));
  assert.ok(!s.includes('audience="USERS"'));
  assert.ok(s.includes("confirmClose={() => !circularsDirty.current || window.confirm(tr('تجاهل مسودة التعميم؟'))}"), 'مسوّدةٌ تضيع بنقرة خارج النافذة');
});

test('صفحة مستخدمي الشركة: زرّ «التعميمات» بصلاحية مستخدمي الشركة قرب «إضافة مستخدم» بجمهور USERS', () => {
  const s = usersPage();
  assert.ok(s.includes("import CircularsPanel from '../components/circulars/CircularsPanel';"));
  assert.ok(s.includes("import PagePanelModal from '../components/PagePanelModal';"));
  assert.ok(s.includes("const circularsOn = user?.role === 'ADMIN' && user?.canManageCompanyUsers !== false;"), 'شرط الإظهار تغيّر');
  assert.match(s, /\{circularsOn && \(\s*<button className="btn-secondary" onClick=\{\(\) => setCircularsOpen\(true\)\}><Megaphone size=\{16\} \/>\{tr\('التعميمات'\)\}<\/button>\s*\)\}\s*<button className="btn-primary" onClick=\{\(\) => \{ setSelected\(null\); setShowModal\(true\); \}\}><Plus size=\{16\} \/>\{tr\('إضافة مستخدم'\)\}/,'الزرّ ليس بجوار «إضافة مستخدم» أو بلا شرط');
  assert.ok(s.includes('<CircularsPanel audience="USERS" onDirtyChange={(d) => { circularsDirty.current = d; }} />'));
  assert.ok(!s.includes('audience="REPS"'));
  // الخطافات قبل الرجوع المبكّر لغير المدير (قواعد React)
  const early = s.indexOf("if (user?.role !== 'ADMIN') {");
  assert.ok(early > 0 && s.indexOf('const [circularsOpen, setCircularsOpen] = useState(false);') < early, 'خطافٌ بعد الرجوع المبكّر');
  assert.ok(s.indexOf('const circularsDirty = useRef(false);') < early);
});

test('اللوحة: مسارات الإدارة الأربعة، وإبطال القائمة بعد النشر والسحب، ورسائل الخادم مترجمة، والتواريخ بالمنسِّق الميلادي', () => {
  const s = panel();
  for (const call of ['circularsApi.list(audience)', 'circularsApi.create(b)', 'circularsApi.reads(row.id)', 'circularsApi.withdraw(id)']) {
    assert.ok(s.includes(call), `${call} غائب`);
  }
  // الموظف لا يُقرّ من هنا — طرفه في نافذة «تمت القراءة»
  assert.ok(!s.includes('circularsApi.ack(') && !s.includes('circularsApi.pending('));
  assert.ok(s.includes('queryKey: circularsKey(audience),'));
  assert.equal(s.match(/onSettled: \(\) => qc\.invalidateQueries\(\{ queryKey: circularsKey\(audience\) \}\)/g)?.length, 2, 'النشر والسحب يُبطلان القائمة');
  assert.ok(s.includes('queryKey: circularReadsKey(audience, row.id),'));
  assert.ok(s.includes('return m ? tr(m) : fallback;'), 'رسالة الخادم تُعرض بلا ترجمة');
  assert.ok(s.includes("import { formatDate, formatDateTime } from '../../utils/format';"));
  assert.ok(!/toLocale(Date|Time)?String\(/.test(s), 'تنسيق تاريخٍ خارج المنسِّق الميلادي');
  // التأكيد قبل النشر والسحب
  assert.match(s, /<ConfirmDialog\s+title=\{tr\('نشر التعميم'\)\}/);
  assert.match(s, /<ConfirmDialog\s+danger\s+title=\{tr\('سحب التعميم'\)\}/);
  // الحدود من الوحدة الصرفة لا أرقامٌ مكرّرة
  assert.ok(s.includes('maxLength={CIRCULAR_TITLE_MAX}') && s.includes('maxLength={CIRCULAR_BODY_MAX}'));
  // النص كما كُتب بأسطره
  assert.ok((s.match(/whitespace-pre-wrap/g)?.length ?? 0) >= 3);
  // المرشّحون من المفاتيح المشتركة: كل المناديب (لا صفحة الخمسين) ومستخدمو الشركة كصفحتهم
  assert.ok(s.includes("queryKey: ['reps-min'],") && s.includes('salesRepApi.list({ limit: 1000 })'));
  assert.ok(s.includes("queryKey: ['company-users'],") && s.includes('companyUserApi.list()'));
});
