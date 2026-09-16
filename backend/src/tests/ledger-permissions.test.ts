import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ledgerPermissionDecision, LEDGER_KEYS, LedgerAdminRow } from '../services/gl/permissions';

/**
 * صلاحيات الدفاتر الست (M0، §9.1، §9.2).
 *
 * خلافاً لنظائرها افتراضها `false`، فكل نمطٍ منسوخ من الصلاحيات القائمة
 * (`?? true`، `=== false`، مرور الدور المجرّد) يقلب المعنى. الحرّاس أدناه تمنع ذلك.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

test('الأعمدة الست بـ@default(false)', () => {
  const s = read('prisma', 'schema.prisma');
  const i = s.indexOf('model Admin {');
  const block = s.slice(i, s.indexOf('\n}', i));
  for (const k of LEDGER_KEYS) {
    assert.match(block, new RegExp(`${k}\\s+Boolean\\s+@default\\(false\\)`), `${k} يجب أن يكون @default(false)`);
  }
});

test('المفاتيح في adminPermissionSelect وتُنشر بـ?? false', () => {
  const s = read('src', 'routes', 'auth.ts');
  const i = s.indexOf('const adminPermissionSelect');
  const block = s.slice(i, s.indexOf('} as const;', i));
  for (const k of LEDGER_KEYS) assert.match(block, new RegExp(`${k}: true`), `${k} مفقود من adminPermissionSelect`);
  // النشر في دالة مشتركة، والدخول يمرّ بها — التأكيد على جسمها لا على الملف كله
  const f = s.indexOf('export function adminPermissionFields(');
  assert.ok(f >= 0, 'adminPermissionFields مفقودة من auth.ts');
  const fBody = s.slice(f, s.indexOf('\n}', f));
  assert.match(fBody, /LEDGER_PERMISSION_KEYS\.has\(key\) \? \(\(admin as any\)\[key\] \?\? false\)/, 'نشر مفاتيح الدفاتر بلا ?? false');
  assert.doesNotMatch(fBody, /LEDGER_PERMISSION_KEYS\.has\(key\) \? \(\(admin as any\)\[key\] \?\? true\)/);
  assert.match(fBody, /Object\.keys\(adminPermissionSelect\)/, 'النشر يجب أن يمرّ على adminPermissionSelect');
  const login = s.indexOf("router.post('/login'");
  const loginBody = s.slice(login, s.indexOf('\n});', login));
  assert.match(loginBody, /\.\.\.adminPermissionFields\(admin\)/, 'الدخول لا ينشر adminPermissionFields');
  const set = s.match(/const LEDGER_PERMISSION_KEYS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'LEDGER_PERMISSION_KEYS مفقودة من auth.ts');
  for (const k of LEDGER_KEYS) assert.ok(set[1].includes(`'${k}'`), `${k} غائب عن LEDGER_PERMISSION_KEYS في auth.ts`);
});

test('الانتحال والتسجيل ينشران صلاحيات صاحب الحساب ونطاقه كالدخول (§9.1)', () => {
  const s = read('src', 'routes', 'auth.ts');
  const f = s.indexOf('export function adminPermissionFields(');
  const fBody = s.slice(f, s.indexOf('\n}', f));
  assert.match(fBody, /scopeEnabled: \(admin as any\)\.scopeEnabled \?\? false/, 'scopeEnabled غائب عن adminPermissionFields');
  const t = read('src', 'routes', 'tenants.ts');
  const imp = t.indexOf("router.post('/:id/impersonate'");
  assert.ok(imp >= 0, 'مسار الانتحال مفقود');
  const impBody = t.slice(imp, t.indexOf('\n});', imp));
  assert.match(impBody, /user: \{[^}]*\.\.\.adminPermissionFields\(admin\)[^}]*\}/, 'استجابة الانتحال لا تحمل صلاحيات الحساب ونطاقه');
  // الصف كاملاً: select جزئي يُسقط المفاتيح فتصل الويب غائبة
  assert.doesNotMatch(impBody.slice(0, impBody.indexOf('jwt.sign')), /select:/, 'استعلام المدير في الانتحال لا يجوز أن يقتصر على select جزئي');
  const signup = s.indexOf("router.post('/signup'");
  const signupBody = s.slice(signup, s.indexOf('\n});', signup));
  assert.match(signupBody, /\.\.\.adminPermissionFields\(created\.admin\)/, 'استجابة التسجيل لا تحمل صلاحيات الحساب ونطاقه');
});

test('حمولة الأدمن تحمل scopeEnabled — في الدخول و/auth/me', () => {
  const s = read('src', 'routes', 'auth.ts');
  const login = s.indexOf("router.post('/login'");
  const loginBody = s.slice(login, s.indexOf('\n});', login));
  assert.match(loginBody, /\.\.\.adminPermissionFields\(admin\)/, 'scopeEnabled غائب عن استجابة الدخول');
  const me = s.indexOf("router.get('/me'");
  const meBody = s.slice(me, s.indexOf('\n});', me));
  assert.match(meBody, /scopeEnabled: true/, 'scopeEnabled غائب عن select مسار /auth/me');
});

test('companyUsers.ts: الست في userSelect وuserSchema، والإنشاء بـ?? false', () => {
  const s = read('src', 'routes', 'companyUsers.ts');
  const schema = s.slice(s.indexOf('const userSchema'), s.indexOf('const userSelect'));
  const sel = s.slice(s.indexOf('const userSelect'), s.indexOf('} as const;', s.indexOf('const userSelect')));
  for (const k of LEDGER_KEYS) {
    assert.match(schema, new RegExp(`${k}: z\\.boolean\\(\\)\\.optional\\(\\)`), `${k} مفقود من userSchema`);
    assert.match(sel, new RegExp(`${k}: true`), `${k} مفقود من userSelect`);
    assert.match(s, new RegExp(`${k}: body\\.${k} \\?\\? false`), `${k} يجب أن يُنشأ بـ?? false`);
    assert.doesNotMatch(s, new RegExp(`${k}: body\\.${k} \\?\\? true`), `${k} بـ?? true يمنح الدفاتر لكل مستخدم جديد`);
  }
});

test('حارس PUT وPOST ينزع المفاتيح حين تكون الميزة مطفأة', () => {
  const s = read('src', 'routes', 'companyUsers.ts');
  assert.match(s, /accountingSuiteEnabled === true/, 'قراءة العَلَم يجب أن تكون === true');
  const put = s.indexOf("router.put('/:id'");
  const putBody = s.slice(put, s.indexOf('\n});', put));
  const strip = putBody.indexOf('if (!(await ledgerSuiteOn(tid))) stripLedgerKeys(updateData)');
  const update = putBody.indexOf('prisma.admin.update');
  assert.ok(strip > 0, 'PUT لا ينزع مفاتيح الدفاتر');
  assert.ok(strip < update, 'النزع يجب أن يسبق الكتابة');
  const post = s.indexOf("router.post('/'");
  const postBody = s.slice(post, s.indexOf('\n});', post));
  const pStrip = postBody.indexOf('stripLedgerKeys(body');
  assert.ok(pStrip > 0 && pStrip < postBody.indexOf('prisma.admin.create'), 'POST لا ينزع مفاتيح الدفاتر قبل الإنشاء');
  // كل المفاتيح الست في قائمة النزع
  const keys = s.match(/const LEDGER_PERMISSION_KEYS = \[([^\]]*)\]/);
  assert.ok(keys);
  for (const k of LEDGER_KEYS) assert.ok(keys[1].includes(`'${k}'`), `${k} غائب عن قائمة النزع`);
});

test('مسند requireLedgerPermission: canManageCompanyUsers لا الدور المجرّد، وأيٌّ من الست للعرض', () => {
  const src = read('src', 'services', 'gl', 'permissions.ts');
  assert.match(src, /admin\.role === 'ADMIN' && admin\.canManageCompanyUsers === true/, 'قاعدة المالك يجب أن تشترط canManageCompanyUsers');
  assert.doesNotMatch(src, /if \(admin\.role === 'ADMIN'\) return/, 'لا مرور لـrole ADMIN المجرّد');
  assert.match(src, /LEDGER_KEYS\.some\(k => admin\[k\] === true\)/, 'canViewLedger يمرّ بأيٍّ من الست === true');
  const mw = read('src', 'middleware', 'auth.ts');
  assert.match(mw, /export function requireLedgerPermission/, 'requireLedgerPermission مفقود');
  assert.match(mw, /ledgerPermissionDecision\(admin, key, tid\)/, 'الحارس لا يستعمل المسند الصرف');
  assert.match(mw, /LEDGER_SCOPED_ADMIN/);
  assert.match(mw, /LEDGER_PERMISSION_DENIED/);
  for (const k of LEDGER_KEYS) assert.match(mw, new RegExp(`\\| '${k}'`), `${k} مفقود من AdminPermission`);
});

const base = (o: Partial<LedgerAdminRow>): LedgerAdminRow => ({ isActive: true, tenantId: 't1', ...o });
const allFalse = Object.fromEntries(LEDGER_KEYS.map(k => [k, false])) as Record<string, boolean>;

test('صرف: مالك الشركة يملك الست ضمناً، والمدير بلا إدارة المستخدمين لا', () => {
  const owner = base({ role: 'ADMIN', canManageCompanyUsers: true, ...allFalse });
  for (const k of LEDGER_KEYS) assert.equal(ledgerPermissionDecision(owner, k, 't1'), 'ALLOW', k);
  const plainAdmin = base({ role: 'ADMIN', canManageCompanyUsers: false, ...allFalse });
  for (const k of LEDGER_KEYS) assert.equal(ledgerPermissionDecision(plainAdmin, k, 't1'), 'DENIED', k);
});

test('صرف: أي مفتاح أعلى يتضمن العرض، والغائب منع', () => {
  assert.equal(ledgerPermissionDecision(base({ role: 'MANAGER', canConfigureLedger: true }), 'canViewLedger', 't1'), 'ALLOW');
  assert.equal(ledgerPermissionDecision(base({ role: 'MANAGER', canPostJournals: true, canViewLedger: false }), 'canViewLedger', 't1'), 'ALLOW');
  assert.equal(ledgerPermissionDecision(base({ role: 'MANAGER', canPostJournals: true }), 'canConfigureLedger', 't1'), 'DENIED', 'العرض لا يتضمن الأعلى');
  assert.equal(ledgerPermissionDecision(base({ role: 'MANAGER' }), 'canViewLedger', 't1'), 'DENIED', 'الغائب منع');
  assert.equal(ledgerPermissionDecision(base({ role: 'ACCOUNTANT', canManageBank: true }), 'canManageBank', 't1'), 'ALLOW');
});

test('صرف: النطاق يسبق قاعدة المالك، والحساب المعطّل أو شركة أخرى منع', () => {
  assert.equal(ledgerPermissionDecision(base({ role: 'ADMIN', canManageCompanyUsers: true, scopeEnabled: true }), 'canViewLedger', 't1'), 'SCOPED');
  assert.equal(ledgerPermissionDecision(base({ role: 'ADMIN', canManageCompanyUsers: true, isActive: false }), 'canViewLedger', 't1'), 'DENIED');
  assert.equal(ledgerPermissionDecision(base({ role: 'ADMIN', canManageCompanyUsers: true }), 'canViewLedger', 't2'), 'DENIED');
  assert.equal(ledgerPermissionDecision(null, 'canViewLedger', 't1'), 'DENIED');
});
