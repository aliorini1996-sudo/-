// «الفرق» داخل الشركة (services/teams.ts، routes/teams.ts) — طلب المالك ١٧ أكتوبر ٢٠٢٦: مطفأة افتراضياً ويفعّلها مدير
// الشركة من «إعدادات الشركة»؛ المندوب يختار فريقه فتُوسم به مستنداته؛ أصناف الفريق تقيّد البيع.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { activeTeamIdsOf, catalogTeamsFor, isGeneralProduct, productAllowedInTeam, resolveDocTeam, teamCatalogProblem, teamName } from '../services/teams';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const on = { settings: { teamsEnabled: true } };
const rep = (teams: [string, boolean?][], tenant: { settings: { teamsEnabled: boolean } } | null = on) =>
  ({ tenant, teamMemberships: teams.map(([teamId, isActive = true]) => ({ teamId, team: { isActive } })) });

test('الميزة مطفأة للشركة: لا فرق ولا وسم مهما كانت العضويات', () => {
  assert.deepEqual(activeTeamIdsOf(rep([['A'], ['B']], { settings: { teamsEnabled: false } })), []);
  assert.equal(resolveDocTeam(rep([['A']], { settings: { teamsEnabled: false } }), 'A'), null);
  assert.equal(resolveDocTeam(rep([['A']], null), 'A'), null, 'بلا إعدادات = مطفأة');
  assert.deepEqual(activeTeamIdsOf(null), []);
});

test('فريق المستند: المختار من فرقه، وإلا فريقه الوحيد، وإلا «بلا فريق» — بلا رفضٍ أبداً', () => {
  assert.equal(resolveDocTeam(rep([['A'], ['B']]), 'B'), 'B');
  assert.equal(resolveDocTeam(rep([['A'], ['B']]), undefined), null, 'فريقان بلا اختيار');
  assert.equal(resolveDocTeam(rep([['A'], ['B']]), 'X'), null, 'فريقٌ ليس من فرقه (مستند أوف-لاين تغيّرت عضويته)');
  assert.equal(resolveDocTeam(rep([['A']]), undefined), 'A', 'فريقه الوحيد');
  assert.equal(resolveDocTeam(rep([['A']]), 'X'), 'A');
  assert.equal(resolveDocTeam(rep([['A', false], ['B']]), 'A'), 'B', 'الفريق المؤرشف لا يُوسم به');
  assert.equal(resolveDocTeam(rep([]), 'A'), null);
});

test('أصناف الفريق: الصنف بلا فرق عامّ، والخاص لا يبيعه إلا فريقه، والمستند بلا فريق لا يُقيَّد', () => {
  const general = { name: 'ماء', teams: [] };
  const nuts = { name: 'لوز', teams: [{ teamId: 'A' }] };
  const shared = { name: 'كيس', teams: [{ teamId: 'A' }, { teamId: 'B' }] };
  assert.equal(isGeneralProduct(general), true);
  assert.equal(isGeneralProduct({ name: 'بلا حقل' }), true);
  assert.equal(productAllowedInTeam(nuts, 'A'), true);
  assert.equal(productAllowedInTeam(nuts, 'B'), false);
  assert.equal(productAllowedInTeam(shared, 'B'), true, 'المشترك بين فريقين');
  assert.equal(productAllowedInTeam(nuts, null), true);
  assert.equal(teamCatalogProblem([general, shared], ['B']), null);
  assert.match(String(teamCatalogProblem([general, nuts], ['B'])), /«لوز» ليس من أصناف فريقك الحالي/);
  assert.equal(teamCatalogProblem([nuts, shared], ['A', 'B']), null, 'اتحاد فرق المندوب');
  assert.match(String(teamCatalogProblem([general, nuts], [])), /خاص بفريقٍ لست من أعضائه/, 'بلا فرق: العامة وحدها');
  assert.equal(teamCatalogProblem([nuts], null), null, 'الميزة مطفأة');
  assert.equal(teamName('  فريق   المكسرات '), 'فريق المكسرات');
});

test('كتالوج البيع الحيّ: فريق المستند، وإلا كل فرق المندوب (لا تجاوز بحذف الفريق)، وبلا فرق العامة وحدها', () => {
  assert.deepEqual(catalogTeamsFor(rep([['A'], ['B']]), 'B'), ['B']);
  assert.deepEqual(catalogTeamsFor(rep([['A'], ['B']]), null), ['A', 'B'], 'لم يختر أو أرسل فريقاً ليس له');
  assert.deepEqual(catalogTeamsFor(rep([]), null), [], 'مندوبٌ بلا فرق في شركةٍ فعّلتها');
  assert.equal(catalogTeamsFor(rep([['A']], { settings: { teamsEnabled: false } }), null), null, 'مطفأة');
});

test('حارس نصّي: الوسم من قراءة المندوب القائمة (لا استعلام جديد)، والمرتجع والإشعار يرثان فريق الأصل', () => {
  const inv = read('routes/invoices.ts');
  assert.ok(inv.includes("include: { tenant: { select: { settings: { select: { teamsEnabled: true } } } }, teamMemberships: { select: TEAM_MEMBERSHIP_SELECT } },"));
  assert.ok(inv.includes('let docTeamId = resolveDocTeam(rep, body.teamId);'));
  assert.ok(inv.includes("code: 'PRODUCT_NOT_IN_TEAM'"), 'أصناف الفريق تقيّد البيع في الخادم');
  // قيد الأصناف لبيع المندوب الحيّ وحده: لا الرفع المؤجَّل (يُعدم في صندوق الإرسال) ولا فاتورة الإدارة، ولا المرتجع المرتبط
  assert.ok(inv.includes("if (req.user!.role === 'SALES_REP' && String(req.headers['x-fs-replay'] || '') !== '1'"));
  assert.ok(inv.includes("&& !(body.type === 'RETURN' && body.originalInvoiceId)) {"), 'المرتجع من فاتورة بيعٍ لا يُفحص');
  assert.ok(inv.includes('teamCatalogProblem(products, catalogTeamsFor(rep, docTeamId))'));
  // المرتجع المرتبط يرث فريق فاتورة بيعه كما هو (null للقديمة) — مقروءٌ لشركةٍ فعّلت الفرق وحدها
  assert.ok(inv.includes("if (isReturn && body.originalInvoiceId && rep.tenant?.settings?.teamsEnabled === true) {"));
  assert.ok(inv.includes('if (saleTeam) docTeamId = saleTeam.teamId ?? null;'));
  assert.ok(inv.includes('...(docTeamId && { teamId: docTeamId }),'), 'المسار القديم يكتب الوسم');
  assert.ok(inv.includes('teamId: docTeamId,'), 'سياق المرحلة الثانية');
  assert.ok(read('routes/invoicesZatca.ts').includes('...(ctx.teamId && { teamId: ctx.teamId }),'));
  assert.ok(read('routes/invoicesNotes.ts').includes('...(locked.original.teamId && { teamId: locked.original.teamId }),'), 'الإشعار يرث فريق أصله');
  assert.ok(read('routes/receipts.ts').includes('...(docTeamId && { teamId: docTeamId }),'));
  assert.ok(read('services/paylink.ts').includes('...(link.invoice?.teamId && { teamId: link.invoice.teamId }),'), 'سند الدفع يرث فريق فاتورته');
  // الزيارة: يُحلّ فريقها كالفاتورة والسند (ترجع لفريق المندوب الوحيد)
  assert.ok(read('routes/visits.ts').includes('const visitTeamId = resolveDocTeam('));
});

test('حارس نصّي: إدارة الفرق لمدير غير مقيَّد بصلاحية إعدادات الشركة، والفريق ذو المستندات يُؤرشف لا يُحذف', () => {
  const r = read('routes/teams.ts');
  assert.match(r, /router\.use\(requireAdmin\);/);
  for (const route of ["router.patch('/settings'", "router.post('/'", "router.put('/:id'", "router.delete('/:id'", "router.put('/:id/members'", "router.put('/:id/products'"]) {
    const i = r.indexOf(route);
    assert.ok(i > 0, route);
    const head = r.slice(i, r.indexOf('\n', r.indexOf('try {', i) + 10));
    assert.ok(head.includes('managePerm'), `${route}: بلا صلاحية إعدادات الشركة`);
    assert.ok(r.slice(i, i + 400).includes('if (!(await guardManage(req, res))) return;'), `${route}: المقيَّد يعيد رسم فرقه`);
  }
  assert.ok(r.includes("code: 'TEAM_HAS_DOCUMENTS'"));
  assert.ok(read('routes/company.ts').includes("router.use('/teams', teamsRouter);"), 'تحت بادئة الشركة المصنّفة');
  // علم الميزة في إعدادات الشركة (يفعّلها مديرها) ومطفأ افتراضياً
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const settings = schema.slice(schema.indexOf('model CompanySettings {'), schema.indexOf('\n}', schema.indexOf('model CompanySettings {')));
  assert.match(settings, /teamsEnabled\s+Boolean @default\(false\)/);
});
