import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * البند 25 — صفحة إعدادات الدفاتر: تغيير المنطقة الزمنية وللشركة أرصدة أو كشوف مستوردة يرتدّ
 * 409 `LEDGER_TIMEZONE_IMPORTS_CONFLICT`، فتعرض الصفحة تأكيداً عربياً صريحاً ثم تعيد الإرسال
 * بـ`rebaseImportDates` وتعرض عدد القيود المُعاد ضبطها.
 *
 * الفحص بالنص لا بالاستيراد: `api/ledgerConfig.ts` يستورد axios و`import.meta.env` فلا يُحمَّل
 * تحت node:test — وهو المسلك نفسه في setupLogic.test.ts لحرّاس هذا البند في المعالج.
 */
const src = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');

test('البند 25: settings.update يمرّر rebaseImportDates عند التأكيد وحده، ويقرأ rebasedImportEntries', () => {
  const api = src('api', 'ledgerConfig.ts');
  assert.match(api, /update: \(data: GlSettingsInput, opts\?: \{ rebaseImportDates\?: boolean \}\)/);
  // مخطط الخادم strict: العلم لا يُرسل في الحفظ العادي وإلا ارتدّ كل حفظ بـ400
  assert.match(api, /\.\.\.\(opts\?\.rebaseImportDates \? \{ rebaseImportDates: true \} : \{\}\)/);
  assert.match(api, /rebasedImportEntries\?: number/);

  const at = api.indexOf('export function rebasedImportEntriesOf');
  assert.ok(at > 0, 'قارئ عدد القيود المُعاد ضبطها غير موجود');
  const fn = api.slice(at, at + 500);
  // يُقرأ من الغلاف ومن data معاً: الرقم خبر للمالك لا يُسقط لاختلاف موضعه
  assert.match(fn, /body\?\.rebasedImportEntries \?\?/);
  assert.match(fn, /body\?\.data as/);
});

test('البند 25: الصفحة تلتقط 409 وتعرض تأكيد إعادة الضبط وتعيد الإرسال ثم تعرض العدد', () => {
  const page = src('pages', 'ledger', 'config', 'SettingsPage.tsx');
  assert.match(page, /timezoneImportsConflictOf\(ledgerErrorOf\(e\)\)/);
  assert.match(page, /<TimezoneImportsConflictNotice/);
  assert.match(page, /onConfirm=\{\(\) => save\.mutate\(\{ rebaseImportDates: true \}\)\}/);
  assert.match(page, /rebasedImportEntriesOf\(r\.data\)/);
  assert.match(page, /أُعيد ضبط تواريخ \{count\} قيداً مستورداً على المنطقة الزمنية الجديدة/);
  // الحفظ العادي يبقى بلا علم إعادة الضبط
  assert.match(page, /save\.mutate\(undefined\)/);
});

test('البند 25: تعارض المنطقة لا يُعيد جلب الإعدادات، فتبقى المسودة ويُرسل التأكيد بالمنطقة الجديدة', () => {
  const page = src('pages', 'ledger', 'config', 'SettingsPage.tsx');
  const at = page.indexOf('onError: e => {');
  assert.ok(at > 0, 'معالج فشل الحفظ غير موجود');
  const onError = page.slice(at, at + 600);
  const returnAt = onError.indexOf('if (conflict) return;');
  const invalidateAt = onError.indexOf('invalidateQueries');
  assert.ok(returnAt > 0, 'مسار التعارض لا يخرج قبل إعادة الجلب');
  assert.ok(invalidateAt > returnAt, 'إعادة جلب الإعدادات تمسح المسودة فيُرسل زر التأكيد جسماً فارغاً');
});

test('البند 25: رمز التعارض له نص عربي في تسميات أخطاء التهيئة فلا يظهر «تعذر الحفظ» العام', () => {
  assert.match(src('lib', 'ledger', 'labels.ts'), /LEDGER_TIMEZONE_IMPORTS_CONFLICT: tr\(/);
});
