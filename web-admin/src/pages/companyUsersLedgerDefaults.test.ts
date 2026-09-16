import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * صلاحيات الدفاتر في نافذة مستخدمي الشركة (M0، §9.2 ب).
 *
 * النمط القائم يهيّئ كل صلاحية بـ`?? true` ويرسل النموذج كاملاً؛ لو اتُّبع لأرسل كل
 * حفظٍ الصلاحيات الست true صراحةً ولما انطبق `?? false` في الخادم.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};
const KEYS = ['canViewLedger', 'canPostJournals', 'canManagePayables', 'canManageBank', 'canCloseLedgerPeriods', 'canConfigureLedger'];

test('لا ?? true وتهيئة الست بـ=== true', () => {
  const s = read('src', 'pages', 'CompanyUsersPage.tsx');
  for (const k of KEYS) {
    assert.doesNotMatch(s, new RegExp(`${k} \\?\\? true`), `${k} ?? true يمنح الدفاتر بحفظ عادي`);
    assert.match(s, new RegExp(`${k}: user\\?\\.${k} === true`), `${k} يجب أن يُهيّأ بـ=== true`);
  }
});

test('تُنزع الست حين !ledgerOn قبل onSave', () => {
  const s = read('src', 'pages', 'CompanyUsersPage.tsx');
  const i = s.indexOf('const submit = ');
  assert.ok(i > 0);
  const body = s.slice(i, s.indexOf('\n  };', i));
  assert.match(body, /!ledgerOn/, 'النزع غير مشروط بـledgerOn');
  assert.match(body, /const \{ canViewLedger, canPostJournals, canManagePayables, canManageBank, canCloseLedgerPeriods, canConfigureLedger, \.\.\.rest \} = form/, 'النزع بالتفكيك مفقود');
  assert.ok(body.indexOf('...rest') < body.indexOf('onSave({ ...rest'), 'onSave يجب أن يستقبل النموذج بعد النزع');
});

test('الست خارج «تحديد الكل» و«إلغاء الكل»', () => {
  const s = read('src', 'pages', 'CompanyUsersPage.tsx');
  const sp = s.match(/const shownPermissions = [^\n]*/);
  assert.ok(sp, 'shownPermissions مفقودة');
  assert.doesNotMatch(sp[0], /ledger/i, 'الدفاتر لا تدخل shownPermissions');
  for (const m of s.matchAll(/onClick=\{\(\) => setForm\([^\n]*\)\}/g)) {
    assert.doesNotMatch(m[0], /Ledger|ledger/, 'معالج «تحديد/إلغاء الكل» يلمس الدفاتر');
  }
  const pi = s.slice(s.indexOf('const permissionItems'), s.indexOf('];', s.indexOf('const permissionItems')));
  for (const k of KEYS) assert.ok(!pi.includes(k), `${k} داخل permissionItems`);
});
