// البند 17 (مراجعة استيراد البيانات 2026-09-17): التراجع عن دفعة عملاء لا يحذف بصمت أرصدتهم وكشوفهم المستوردة وقيودهم
// وأسعارهم الخاصة ومحطات خطوط السير، بل يُبقي العميل في blocked بسبب صريح. منطق صرف + حارس ثابت، بلا قاعدة بيانات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { customerBlockReason, importedEntryIndex, revertResponse } from '../services/importLedger';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const zero = { invoices: 0, receipts: 0, paymentLinks: 0, visits: 0, importedEntries: 0, otherEntries: 0, prices: 0, routeStops: 0, assignments: 0, scopes: 0 };

test('سيناريو البند 17: عميل مستورد له قيد في دفعة balances غير متراجع عنها ⇒ «للعميل رصيد أو كشف مستورد، تراجع عنه أولاً»', () => {
  const idx = importedEntryIndex([{ kind: 'balances', recordIds: '["e1"]' }, { kind: 'ledger', recordIds: '["e2"]' }]);
  const customerEntries = ['e1', 'manual-9'];
  const importedEntries = customerEntries.filter((id) => idx.balances.has(id) || idx.ledger.has(id)).length;
  assert.equal(customerBlockReason({ ...zero, importedEntries, otherEntries: customerEntries.length - importedEntries }), 'للعميل رصيد أو كشف مستورد، تراجع عنه أولاً');
  assert.equal(customerBlockReason({ ...zero, otherEntries: 1 }), 'للعميل قيود في كشف الحساب');
});

test('سعر خاص ⇒ سببه، ومحطة خط سير ⇒ سببها، والأسباب القائمة أولاً، والغياب (الشكل القديم) صفر', () => {
  assert.equal(customerBlockReason({ ...zero, prices: 2 }), 'للعميل أسعار خاصة، تراجع عن دفعة الأسعار أو احذفها أولاً');
  assert.equal(customerBlockReason({ ...zero, routeStops: 1 }), 'للعميل محطات في خطوط سير المناديب');
  assert.equal(customerBlockReason({ ...zero, invoices: 1, prices: 2 }), 'للعميل فواتير');
  assert.equal(customerBlockReason(zero), null);
  assert.equal(customerBlockReason({ invoices: 0, receipts: 0, paymentLinks: 0, visits: 0 }), null);
});

// البند 17 (متابعة): CustomerAssignment عليها onDelete: Cascade (schema.prisma:611)، فعميل ليس له إلا إسناد
// لمندوب كان يُحذف ويُمحى إسناده بلا سبب منع ولا ذكر — المندوب يفقد عميله من قائمته بلا تفسير.
test('عميل مُسنَد لمندوب وحده (بلا فواتير ولا قيود) ⇒ سبب منع صريح لا حذف صامت للإسناد', () => {
  assert.equal(customerBlockReason({ ...zero, assignments: 1 }), 'العميل مُسنَد لمندوب، أزل الإسناد أولاً');
  // الأسباب الأقدم أسبق (الاختبارات القائمة تفترض أسبقية الفواتير)، والمحطات قبل الإسناد
  assert.equal(customerBlockReason({ ...zero, invoices: 1, assignments: 3 }), 'للعميل فواتير');
  assert.equal(customerBlockReason({ ...zero, routeStops: 1, assignments: 3 }), 'للعميل محطات في خطوط سير المناديب');
  // الشكل القديم (بلا الحقل) لا ينكسر
  assert.equal(customerBlockReason({ invoices: 0, receipts: 0, paymentLinks: 0, visits: 0 }), null);
});

// البند 17 (الإغلاقة): AdminCustomerScope عليها onDelete: Cascade (schema.prisma:214)، فنطاق مستخدم مقيَّد على
// العميل كان يُمحى بصمت مع حذفه. القرار: النطاق أثر صلاحيات لا بيانات عمل ⇒ لا يمنع الحذف، لكنه يُحذف صراحةً
// ويُعدّ ويُذكر في الرد بـremovedScopes كبقيّة التوابع.
test('نطاقات مستخدمي الشركة لا تمنع الحذف (أثر صلاحيات) لكنها تُعدّ وتُذكر', () => {
  assert.equal(customerBlockReason({ ...zero, scopes: 7 }), null, 'النطاق صار سبب منع');
  // ولا تغيّر ترتيب الأسباب القائمة ولا تحجب سبباً حقيقياً
  assert.equal(customerBlockReason({ ...zero, scopes: 7, invoices: 1 }), 'للعميل فواتير');
  assert.equal(customerBlockReason({ ...zero, scopes: 7, assignments: 1 }), 'العميل مُسنَد لمندوب، أزل الإسناد أولاً');
  // الشكل القديم (بلا الحقل) لا ينكسر
  assert.equal(customerBlockReason({ invoices: 0, receipts: 0, paymentLinks: 0, visits: 0 }), null);
  // والعدد يظهر في الرد لا في المنع
  const r = revertCustomers([{ id: 'c1', scopes: 4 }]);
  assert.equal(r.response.removedScopes, 4);
  assert.equal(r.response.reverted, true);
});

test('حارس ثابت: التراجع يعدّ الإسنادات داخل المعاملة قبل حذف العميل', () => {
  const src = read('routes/import.ts');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const branch = rv.slice(rv.indexOf("if (batch.kind === 'customers') {"), rv.indexOf("} else if (batch.kind === 'products') {"));
  const count = branch.indexOf('tx.customerAssignment.count({ where: { customerId: cid, tenantId: tid } })');
  assert.ok(count > 0, 'لا عدّ لإسنادات العميل في معاملة التراجع');
  assert.ok(count < branch.indexOf('tx.customer.deleteMany('), 'العدّ بعد الحذف لا قبله');
  assert.ok(count < branch.indexOf("status: 'blocked'"), 'العدّ خارج بصمة customerBlockReason');
});

test('حارس ثابت: عدّ القيود المستوردة والأسعار والمحطات داخل المعاملة قبل tx.accountEntry.deleteMany، والفهرس قبل الحلقة', () => {
  const src = read('routes/import.ts');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const branch = rv.slice(rv.indexOf("if (batch.kind === 'customers') {"), rv.indexOf("} else if (batch.kind === 'products') {"));
  let pos = -1;
  for (const n of [
    'loadImportedIndex(tid)', 'for (const cid of ids)', 'acquirePostLock(tx, tid)', 'tx.repVisit.count(',
    'tx.accountEntry.findMany({ where: { customerId: cid }, select: { id: true } })', 'idx.balances.has(', 'idx.ledger.has(',
    'tx.customerPrice.count({ where: { customerId: cid } })', 'tx.repRouteStop.count({ where: { customerId: cid, tenantId: tid } })',
    "status: 'blocked'", 'tx.accountEntry.deleteMany(',
  ]) {
    const k = branch.indexOf(n, pos + 1);
    assert.ok(k > pos, `تراجع العملاء: ${n} خارج الترتيب`);
    pos = k;
  }
});

// ═══ البند 17 (إغلاقة الدفعة 2): ما حُذف مع العميل يُحصى ويُذكر — لا حذف صامت ═══

/** تجميع توابع العملاء المحذوفين كما في import.ts (المحمي لا يُحذف فلا يُحسب) */
function revertCustomers(rows: { id: string; blocked?: string; entries?: number; prices?: number; notifications?: number; assignments?: number; scopes?: number }[]) {
  const totals = { removedEntries: 0, removedPrices: 0, removedNotifications: 0, removedAssignments: 0, removedScopes: 0 };
  const blocked: { id: string; name: string; reason: string }[] = [];
  let removed = 0;
  for (const r of rows) {
    if (r.blocked) { blocked.push({ id: r.id, name: r.id, reason: r.blocked }); continue; }
    removed++;
    totals.removedEntries += r.entries ?? 0;
    totals.removedPrices += r.prices ?? 0;
    totals.removedNotifications += r.notifications ?? 0;
    totals.removedAssignments += r.assignments ?? 0;
    totals.removedScopes += r.scopes ?? 0;
  }
  return { removed, blocked, totals, response: revertResponse('customers', removed, blocked, blocked.length, { ...totals }) };
}

test('سيناريو البند 17: ردّ التراجع يذكر عدد كل صفّ تابع حُذف (إشعارات وقيود وأسعار وإسنادات) لا حذفاً صامتاً', () => {
  const r = revertCustomers([
    { id: 'c1', entries: 3, notifications: 2, scopes: 2 },
    { id: 'c2', notifications: 1, prices: 0, scopes: 1 },
    { id: 'c3', blocked: 'للعميل فواتير' },
  ]);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.response, {
    removed: 2, blocked: [{ id: 'c3', name: 'c3', reason: 'للعميل فواتير' }], remaining: 1, kind: 'customers', reverted: false,
    removedEntries: 3, removedPrices: 0, removedNotifications: 3, removedAssignments: 0, removedScopes: 3,
  });
  // العميل الممنوع لا تُحسب توابعه (لم تُحذف)
  const only = revertCustomers([{ id: 'c1', blocked: 'للعميل زيارات ميدانية', entries: 9, notifications: 9, scopes: 9 }]);
  assert.deepEqual(only.totals, { removedEntries: 0, removedPrices: 0, removedNotifications: 0, removedAssignments: 0, removedScopes: 0 });
  assert.equal(only.response.removed, 0);
  // دفعة نظيفة: الحقول حاضرة بأصفار (الواجهة لا تخمّن)
  const clean = revertCustomers([{ id: 'c1' }]);
  assert.equal(clean.response.reverted, true);
  assert.deepEqual(
    [clean.response.removedEntries, clean.response.removedPrices, clean.response.removedNotifications, clean.response.removedAssignments, clean.response.removedScopes],
    [0, 0, 0, 0, 0],
  );
});

test('حارس ثابت (البند 17): كل deleteMany تابع يُلتقط عدده ويُجمَع، والإسناد يُحذف صراحةً لا بـCascade صامت', () => {
  const src = read('routes/import.ts');
  const rv = src.slice(src.indexOf("router.post('/batches/:id/revert'"));
  const branch = rv.slice(rv.indexOf("if (batch.kind === 'customers') {"), rv.indexOf("} else if (batch.kind === 'products') {"));
  for (const n of [
    'const removedEntries = (await tx.accountEntry.deleteMany(',
    'const removedPrices = (await tx.customerPrice.deleteMany(',
    'const removedNotifications = (await tx.notification.deleteMany(',
    'const removedAssignments = (await tx.customerAssignment.deleteMany(',
    'const removedScopes = (await tx.adminCustomerScope.deleteMany(',
  ]) assert.ok(branch.includes(n), `حذف بلا عدّ: ${n}`);
  // البند 17 (الإغلاقة): النطاق يُحذف صراحةً قبل العميل (وإلا محاه Cascade بصمت) ويصعد إلى الحصيلة
  assert.ok(branch.indexOf('tx.adminCustomerScope.deleteMany(') < branch.indexOf('tx.customer.deleteMany('));
  assert.match(branch, /customerRemoved\.removedScopes \+= out\.removedScopes/);
  // الحذف الصريح للإسناد قبل حذف العميل (وإلا محاه Cascade بصمت)
  assert.ok(branch.indexOf('tx.customerAssignment.deleteMany(') < branch.indexOf('tx.customer.deleteMany('));
  assert.match(branch, /return \{ status: 'removed' as const, removedEntries, removedPrices, removedNotifications, removedAssignments, removedScopes \}/);
  assert.match(branch, /customerRemoved\.removedNotifications \+= out\.removedNotifications/);
  // الرد: ملخّص التراجع عن العملاء يحمل الأعداد
  const tail = rv.slice(rv.indexOf("if (batch.kind === 'customers' || batch.kind === 'products' || batch.kind === OPENING_STOCK_KIND)"));
  assert.match(tail, /batch\.kind === 'customers' \? \{ \.\.\.customerRemoved \} : \{\}/);
  assert.match(tail, /revertResponse\(batch\.kind, removed, blocked, remainingIds\.length, extra\)/);
});
