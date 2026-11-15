// «ربط الدفاتر» L9: توجيه الدفاتر اليدوية القديم (التحويل البنكي ونقاط البيع ⇒ عهدة المندوب) يُصحَّح عند التحويل بدل أن يمنعه (OD4)
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedReceiptRouting } from '../services/gl/linking/activate';

test('التحويل: البنكي ونقاط البيع من العهدة إلى حسابهما مباشرة، والنقد والشيكات كما اختارها المستخدم', () => {
  assert.deepEqual(
    linkedReceiptRouting({ CASH: 'CUSTODY', BANK_TRANSFER: 'CUSTODY', POS: 'CUSTODY', CHEQUE: 'CUSTODY' }),
    { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' },
  );
  assert.deepEqual(linkedReceiptRouting({ CASH: 'DIRECT', BANK_TRANSFER: 'DIRECT' }), { CASH: 'DIRECT', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' });
  assert.deepEqual(linkedReceiptRouting(null), { CASH: 'CUSTODY', CHEQUE: 'CUSTODY', BANK_TRANSFER: 'DIRECT', POS: 'DIRECT' });
});
