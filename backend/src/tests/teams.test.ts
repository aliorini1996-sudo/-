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

// ═══ المرحلة الثانية: التقارير حسب الفريق ═══
import { reportTeamOf, teamDocWhere, teamRepWhere } from '../services/teams';

test('فلتر التقارير بالفريق: نصّاً وحده، و«بلا فريق»، والمستندات بوسمها والمناديب بعضويتهم', () => {
  assert.equal(reportTeamOf(undefined), undefined);
  assert.equal(reportTeamOf(''), undefined);
  assert.equal(reportTeamOf('none'), null);
  assert.equal(reportTeamOf('t1'), 't1');
  assert.equal(reportTeamOf({ not: 'x' }), undefined, 'كائن qs لا يصير شرط Prisma');
  assert.equal(reportTeamOf(['a', 'b']), undefined);
  assert.deepEqual(teamDocWhere(undefined), {});
  assert.deepEqual(teamDocWhere(null), { teamId: null });
  assert.deepEqual(teamDocWhere('t1'), { teamId: 't1' });
  assert.deepEqual(teamRepWhere(undefined), {});
  assert.deepEqual(teamRepWhere('t1'), { teamMemberships: { some: { teamId: 't1' } } });
  assert.deepEqual(teamRepWhere(null), { teamMemberships: { none: {} } });
});

test('حارس نصّي: كل تقارير المستندات تُفلتر بوسم الفريق، وتقارير المناديب بعضويتهم، وساعات العمل لا تُسقط النطاق', () => {
  const r = read('routes/reports.ts');
  const seg = (route: string, next: string) => r.slice(r.indexOf(`router.get('${route}'`), r.indexOf(`router.get('${next}'`));
  assert.ok(seg('/sales', '/orders').includes('...teamDocWhere(team),'), 'المبيعات');
  assert.ok(seg('/sales', '/orders').includes("if (groupBy === 'team') {"), 'التجميع حسب الفريق');
  assert.ok(seg('/orders', '/returns').includes('...teamDocWhere(reportTeamOf(req.query.teamId)),'), 'الطلبات');
  assert.ok(seg('/collections', '/balances').includes('...teamDocWhere(reportTeamOf(req.query.teamId)),'), 'التحصيل');
  const perf = seg('/rep-performance', '/customer-visits');
  assert.equal(perf.split('...teamDocWhere(team)').length - 1, 3, 'مبيعات الأداء وتحصيله وزياراته');
  assert.ok(perf.includes('...teamRepWhere(team) },'), 'مناديب الأداء');
  assert.ok(seg('/customer-visits', '/rep-receivables').includes('...teamDocWhere(reportTeamOf(req.query.teamId)) },'));
  assert.ok(seg('/rep-receivables', '/work-hours').includes('...teamRepWhere(reportTeamOf(req.query.teamId)) },'));
  const hours = seg('/work-hours', '/rep-ranking');
  assert.ok(hours.includes('AND: [await scopedRecordWhere(req, SHAPE_VISIT), { OR: ['), 'النطاق عنصرٌ في AND لا يُكتب فوقه');
  assert.ok(!/\.\.\.\(await scopedRecordWhere\(req, SHAPE_VISIT\)\),\s*AND:/.test(hours), 'نثر النطاق بجانب AND يُسقطه');
  assert.ok(r.slice(r.indexOf("router.get('/rep-ranking'")).split('...teamDocWhere(team)').length - 1 >= 3, 'المبيعات والصنف والزيارات في التقييم');
});
