import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyBody, readBackend, readWeb } from './copyGuard';
import { buyerIssues, isSaudiVat, sellerIssues } from './validators';

/**
 * فوترة ZATCA (Z5.1a) — حارس النسخة: web-admin/src/lib/zatca/validators.ts نسخة حرفية من مُدقِّقات الخادم
 * (backend/src/compliance/zatca/validators.ts) بعد رأس التعليق. أي تعديل على أحدهما دون الآخر يفشل هنا —
 * فالواجهة تحكم على بطاقة العميل بما يحكم به الإصدار.
 */

test('validators.ts: مطابقة بايتاً ببايت لملف الخادم بعد رأس التعليق، وبلا أي import', () => {
  const web = readWeb('validators.ts');
  assert.equal(copyBody(web), copyBody(readBackend('validators.ts')));
  assert.doesNotMatch(copyBody(web), /^\s*import\s/m, 'الملف مكتفٍ بذاته');
  assert.match(web, /^\/\/ نسخة حرفية من backend\/src\/compliance\/zatca\/validators\.ts/m);
});

test('النسخة تعمل في الواجهة: الرقم الضريبي وقواعد المشتري والبائع', () => {
  assert.equal(isSaudiVat('300000000000003'), true);
  assert.equal(isSaudiVat('٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣'), false, 'التطبيع قبل الفحص (buyerData)');
  assert.ok(buyerIssues('standard', {}).some(i => i.rule === 'BR-KSA-81'));
  assert.ok(sellerIssues({}).length > 0);
});
