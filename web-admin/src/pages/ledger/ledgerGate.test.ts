import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canLedger, LEDGER_KEYS } from '../../lib/ledgerPerms';
import type { User } from '../../types';

/**
 * بوّابة الدفاتر في الويب (M0، §8.1، §10.1).
 *
 * (أ) مسارات الدفاتر ملفوفة بـLedgerRoute لا PermissionRoute؛ (ب) m/perms.ts بلا
 * مفاتيح دفاتر؛ (ج) canLedger صرفة تطابق مسند الخادم.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('(أ) لا PermissionRoute بصلاحية دفاتر، وكل مسار ledger ملفوف بـLedgerRoute', () => {
  const app = read('src', 'App.tsx');
  assert.doesNotMatch(app, /PermissionRoute permission="can(ViewLedger|PostJournals|ManagePayables|ManageBank|CloseLedgerPeriods|ConfigureLedger)"/,
    'PermissionRoute يحجب مالك الشركة الذي أعمدته false');
  const routes = [...app.matchAll(/<Route path="ledger[^"]*" element=\{([^\n]*)\} \/>/g)];
  assert.ok(routes.length >= 1, 'مسار /app/ledger غير مسجَّل');
  for (const r of routes) assert.match(r[1], /^<LedgerRoute perm="can\w+Ledger|^<LedgerRoute perm="can(PostJournals|ManagePayables|ManageBank)"/, `مسار دفاتر غير ملفوف بـLedgerRoute: ${r[0]}`);
  assert.doesNotMatch(app, /path="ledger[^"]*" element=\{<PermissionRoute/, 'مسار دفاتر خلف PermissionRoute');
});

test('(ب) m/perms.ts لا يحتوي أي مفتاح Ledger', () => {
  assert.doesNotMatch(read('src', 'm', 'perms.ts'), /Ledger/, 'مفاتيح الدفاتر لا تُضاف إلى can() — قاعدتها !== false');
});

const allFalse = Object.fromEntries(LEDGER_KEYS.map(k => [k, false])) as Partial<User>;
const u = (o: Partial<User>): User => ({ id: 'x', name: 'x', role: 'MANAGER', ...o }) as User;

test('(ج) canLedger: مالك الشركة يملك الست ضمناً، والمدير المجرّد لا', () => {
  const owner = u({ role: 'ADMIN', canManageCompanyUsers: true, ...allFalse });
  assert.equal(canLedger(owner, 'canViewLedger'), true);
  assert.equal(canLedger(owner, 'canConfigureLedger'), true);
  const admin = u({ role: 'ADMIN', canManageCompanyUsers: false, ...allFalse });
  for (const k of LEDGER_KEYS) assert.equal(canLedger(admin, k), false, k);
});

test('(ج) canLedger: الأعلى يتضمن العرض، والغائب منع، والنطاق يمنع المالك', () => {
  assert.equal(canLedger(u({ role: 'MANAGER', canConfigureLedger: true }), 'canViewLedger'), true);
  assert.equal(canLedger(u({ role: 'MANAGER', canPostJournals: true, canViewLedger: false }), 'canViewLedger'), true);
  assert.equal(canLedger(u({ role: 'MANAGER' }), 'canViewLedger'), false, 'الغائب منع خلافاً لـcan()');
  assert.equal(canLedger(u({ role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: true }), 'canViewLedger'), false);
  assert.equal(canLedger(null, 'canViewLedger'), false);
});

test('عنصر القائمة وبوابة الميزة بالدلالة الصحيحة', () => {
  const gate = read('src', 'components', 'LedgerGate.tsx');
  assert.match(gate, /accountingSuiteEnabled === true && company\?\.accountingEnabled !== false/, 'on يجب أن يكون === true مع !== false');
  assert.doesNotMatch(gate, /\baccountingOn\b/, 'اسم accountingOn محجوز لاختبارات العدّ');
  const route = read('src', 'components', 'ledger', 'LedgerRoute.tsx');
  assert.match(route, /if \(!ready\) return null;/);
  assert.match(route, /if \(!on\) return <LedgerOffNotice \/>;/);
  assert.match(route, /if \(!canLedger\(user, perm\)\)/);
});
