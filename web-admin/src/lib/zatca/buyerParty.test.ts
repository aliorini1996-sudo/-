import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyBody, readBackend, readWeb } from './copyGuard';
import { classifyBuyerSubtype, mapBuyerPartyLike } from './buyerParty';

/**
 * فوترة ZATCA (Z5.1a) — حارس النسخة: web-admin/src/lib/zatca/buyerParty.ts نسخة حرفية من الخادم (بعد رأس التعليق).
 * تطابق الخادم نفسه مع mapInvoice.ts (الوحدة الحيّة) يثبته backend/src/compliance/zatca/buyerData.test.ts.
 */

test('buyerParty.ts: مطابقة بايتاً ببايت لملف الخادم بعد رأس التعليق، ويستورد validators.ts وحده', () => {
  const body = copyBody(readWeb('buyerParty.ts'));
  assert.equal(body, copyBody(readBackend('buyerParty.ts')));
  const imports = [...body.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual([...new Set(imports)], ['./validators']);
});

test('النسخة تعمل في الواجهة: التصنيف والطرف', () => {
  assert.equal(classifyBuyerSubtype({ commercialReg: '2050012345' }), '01');
  assert.equal(classifyBuyerSubtype({ buyerType: 'INDIVIDUAL', taxNumber: '300000000000003' }), '02');
  assert.deepEqual(mapBuyerPartyLike({ name: 'x', commercialReg: '1' }, '01').otherId, { scheme: 'CRN', value: '1' });
  assert.deepEqual(mapBuyerPartyLike({ name: 'x', commercialReg: '1' }, '02'), { registrationName: 'x' });
});
