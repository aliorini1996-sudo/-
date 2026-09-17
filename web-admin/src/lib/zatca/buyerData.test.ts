import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyBody, readBackend, readWeb } from './copyGuard';
import { customerBuyerStatus, normalizeBuyerFields, validateBuyerChanges } from './buyerData';

/**
 * فوترة ZATCA (Z5.1a، D2) — حارس النسخة: web-admin/src/lib/zatca/buyerData.ts نسخة حرفية من الخادم (بعد رأس التعليق)، فتفحص
 * نماذج العملاء (لوحة الإدارة و/m وتطبيق المندوب) قبل الإرسال بقواعد الخادم نفسها، وتعرض النواقص كما تعدّها القائمة.
 */

test('buyerData.ts: مطابقة بايتاً ببايت لملف الخادم بعد رأس التعليق، ويستورد validators.ts وbuyerParty.ts وحدهما', () => {
  const body = copyBody(readWeb('buyerData.ts'));
  assert.equal(body, copyBody(readBackend('buyerData.ts')));
  const imports = [...body.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ['./buyerParty', './validators']);
});

test('النسخة تعمل في الواجهة: التطبيع والفحص والحالة', () => {
  const { patch } = normalizeBuyerFields({ addrBuildingNo: '١٢٣٤', buyerType: 'business' });
  assert.deepEqual(patch, { addrBuildingNo: '1234', buyerType: 'BUSINESS' });
  assert.deepEqual(validateBuyerChanges({ addrPostalCode: '123' }, null).errors.map(e => e.field), ['addrPostalCode']);
  assert.equal(customerBuyerStatus({ name: 'x', channel: 'MT' }).classification, 'unclassified');
});
