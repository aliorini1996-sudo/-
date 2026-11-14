// «ربط الدفاتر» C11 — إصلاح مراجعة ١٤ نوفمبر: مسارا إلغاء السند لا يتجاوزان حرّاس عهدة المستخدم (صرفاً، بلا قاعدة).
// السلوك عبر المسار الحقيقي في l458-a08-routes («حارس عهدة المستخدم»)؛ وهنا الصلاحيات والتقنيع وحارس المصدر.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  NO_CUSTODY_ACCESS, cancelCustodyAccessFor, cancelCustodyAccessFrom, maskCancelOptions, type CancelRefundOptionsView,
} from '../services/receiptCancelSource';

const admin = (o: Record<string, unknown> = {}) => ({ isActive: true, canManageCompanyUsers: true, canReceiveUserCollections: true, ...o });

test('cancelCustodyAccessFrom: مالك المنصة كل شيء، والمندوب لا شيء، والإداري كحارس شاشة العهدة + صلاحية الاستلام للإسناد', () => {
  assert.deepEqual(cancelCustodyAccessFrom({ userId: 'x', role: 'ADMIN', impersonated: true, scoped: true, admin: null }),
    { viewOthers: true, refundOthers: true, selfId: null, unscoped: true });
  assert.deepEqual(cancelCustodyAccessFrom({ userId: 'r', role: 'SALES_REP', scoped: false, admin: admin() }), NO_CUSTODY_ACCESS);
  assert.deepEqual(cancelCustodyAccessFrom({ userId: 'a', role: 'MANAGER', scoped: false, admin: admin() }),
    { viewOthers: true, refundOthers: true, selfId: 'a', unscoped: true });
  // المقيّد بنطاق: لا عهد الآخرين ولا رصيد المندوب — ولو أدار المستخدمين (guardCustody)
  assert.deepEqual(cancelCustodyAccessFrom({ userId: 'a', role: 'MANAGER', scoped: true, admin: admin() }),
    { viewOthers: false, refundOthers: false, selfId: 'a', unscoped: false });
  // بلا إدارة المستخدمين أو غير نشط: لا رؤية ولا إسناد
  for (const o of [{ canManageCompanyUsers: false }, { canManageCompanyUsers: null }, { isActive: false }]) {
    const a = cancelCustodyAccessFrom({ userId: 'a', role: 'ACCOUNTANT', scoped: false, admin: admin(o) });
    assert.deepEqual([a.viewOthers, a.refundOthers, a.unscoped], [false, false, true], JSON.stringify(o));
  }
  // يرى ولا يُسند بلا صلاحية الاستلام (=== false يمنع كـrequireAdminPermission)
  const v = cancelCustodyAccessFrom({ userId: 'a', role: 'ADMIN', scoped: false, admin: admin({ canReceiveUserCollections: false }) });
  assert.deepEqual([v.viewOthers, v.refundOthers], [true, false]);
  assert.deepEqual(cancelCustodyAccessFrom({ userId: null, role: 'ADMIN', scoped: false, admin: admin() }), NO_CUSTODY_ACCESS);
});

test('cancelCustodyAccessFor: لا قراءة لصفّ المستخدم لمالك المنصة ولا للمندوب، وقراءة الصلاحيات الثلاث للإداري', async () => {
  const calls: unknown[] = [];
  const db = { admin: { findUnique: async (a: unknown) => { calls.push(a); return admin(); } } } as never;
  await cancelCustodyAccessFor(db, { id: 'x', role: 'ADMIN', impersonated: true }, false);
  await cancelCustodyAccessFor(db, { id: 'r', role: 'SALES_REP' }, false);
  assert.equal(calls.length, 0);
  const a = await cancelCustodyAccessFor(db, { id: 'a', role: 'ADMIN' }, false);
  assert.equal(a.refundOthers, true);
  assert.deepEqual(calls, [{ where: { id: 'a' }, select: { isActive: true, canManageCompanyUsers: true, canReceiveUserCollections: true } }]);
});

const VIEW: CancelRefundOptionsView = {
  linked: true, custodyClass: 'CUSTODY', handedOver: true, suggested: 'USER_CUSTODY', suggestedUserId: 'u-1', repOutstanding: 0,
  options: [
    { value: 'REP_CUSTODY', label: 'من عهدة المندوب' },
    { value: 'USER_CUSTODY', label: 'من عهدة مستخدم الشركة', userId: 'u-1', userName: 'سارة', userOutstanding: 800 },
    { value: 'MAIN_CASH', label: 'من الصندوق الرئيسي' }, { value: 'BANK', label: 'من الحساب البنكي' },
  ],
};

test('maskCancelOptions: القرار لا يتغيّر، وعهدة المستلِم لصاحبها أو لمن يرى عهد الآخرين، ورصيد المندوب لغير المقيّد', () => {
  const full = { viewOthers: true, refundOthers: true, selfId: 'a', unscoped: true };
  assert.deepEqual(maskCancelOptions(VIEW, full), VIEW);
  const scoped = maskCancelOptions(VIEW, { ...NO_CUSTODY_ACCESS, selfId: 'a' });
  assert.deepEqual([scoped.suggested, scoped.suggestedUserId, scoped.handedOver, scoped.repOutstanding], ['USER_CUSTODY', 'u-1', true, null]);
  assert.deepEqual(scoped.options[1], { value: 'USER_CUSTODY', label: 'من عهدة مستخدم الشركة', userId: 'u-1', userName: 'سارة' });
  // صاحب العهدة يرى رقمه
  assert.equal(maskCancelOptions(VIEW, { ...NO_CUSTODY_ACCESS, selfId: 'u-1' }).options[1].userOutstanding, 800);
  // عهدةٌ لا تكفي (المقترح غيرها) ⇒ لا خيار إسنادٍ لمن لا يملكه
  const short = { ...VIEW, suggested: 'MAIN_CASH' as const, suggestedUserId: null };
  assert.deepEqual(maskCancelOptions(short, { ...NO_CUSTODY_ACCESS, selfId: 'a', unscoped: true }).options.map((o) => o.value), ['REP_CUSTODY', 'MAIN_CASH', 'BANK']);
  assert.equal(maskCancelOptions(short, { viewOthers: true, refundOthers: true, selfId: 'a', unscoped: true }).options[1].userOutstanding, 800);
});

test('حارس المصدر: المساران يمرّران صلاحيات المُلغي كسولةً، والكتابة الصريحة تفحص الصلاحية قبل وجود المستخدم', () => {
  const SRC = path.join(__dirname, '..');
  const routes = fs.readFileSync(path.join(SRC, 'routes/receipts.ts'), 'utf8');
  assert.match(routes, /cancelRefundOptions\(prisma, tid, receipt, \{ repOnly: isRep, access: cancelAccessOf\(req\) \}\)/);
  assert.match(routes, /resolveCancelRefund\(prisma, tid, receipt, \{ body: req\.body, role: req\.user\?\.role, access: cancelAccessOf\(req\) \}\)/);
  assert.match(routes, /cancelCustodyAccessFor\(prisma, req\.user, await adminScopeEnabled\(req\)\)/);
  const svc = fs.readFileSync(path.join(SRC, 'services/receiptCancelSource.ts'), 'utf8');
  const resolve = svc.slice(svc.indexOf('export async function resolveCancelRefund('));
  assert.ok(resolve.indexOf('assertMayRefundFromUser(') < resolve.indexOf('db.admin.findFirst('), 'الصلاحية قبل كشف وجود المستخدم');
  assert.doesNotMatch(svc, /from\s+['"][^'"]*services\/gl[^'"]*['"]/);
});
