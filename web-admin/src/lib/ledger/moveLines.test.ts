import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GlMoveLine } from '../../api/ledgerMoves';
import { gridLinesFromMove, moveInputLines } from './moveLines';

/**
 * تحويل سطور القيد (§6.1): علم التوليد من الخادم لا من taxRole، وإعادة الحفظ دون تعديل لا تكرر الضريبة
 * ولا تُسقط سطر الضريبة اليدوي. العقد في backend/src/services/gl/draft.ts: السطر على حساب VAT بـtaxId يُعدّ يدوياً
 * أياً كان دوره، وTAX/MARKER على غير حساب VAT يُسقط، وgenerated=true يُهمل ويُعاد توليده.
 */

const S = 'tax_S15_PURCH';
const Z = 'tax_Z_PURCH';
const VAT_IN = 'acc_116001';

const line = (over: Partial<GlMoveLine>): GlMoveLine => ({
  id: `l${over.seq ?? 0}`, seq: 0, accountId: 'acc_x', account: { code: 'x', name: 'x', type: 'expense', controlKind: null },
  label: null, debit: 0, credit: 0, customerId: null, vendorId: null, salesRepId: null, partnerName: null, analyticAccountId: null,
  productId: null, quantity: null, taxId: null, taxName: null, taxRole: null, taxBase: null, vatBox: null, vatAdjustment: false,
  dueDate: null, posted: false, generated: false, gross: null, ...over,
});

/** قيد مخزَّن: وعاء بضريبة، مقابل، سطر ضريبة يدوي ملاصق للمولَّد، علامة يدوية، ثم سطر الضريبة المولَّد. */
const stored: GlMoveLine[] = [
  line({ seq: 0, accountId: 'acc_621004', label: 'إيجار', debit: 100, taxId: S, taxRole: 'BASE' }),
  line({ seq: 1, accountId: 'acc_111001', label: 'صندوق', credit: 120 }),
  line({ seq: 2, accountId: VAT_IN, account: { code: '116001', name: 'VAT', type: 'asset_current', controlKind: 'VAT_IN' }, label: 'تسوية', debit: 5, taxId: S, taxRole: 'TAX', vatBox: 'SA_7', taxBase: 40 }),
  line({ seq: 3, accountId: VAT_IN, label: 'علامة', taxId: Z, taxRole: 'MARKER', vatBox: 'SA_9', taxBase: 250, salesRepId: 'rep1', dueDate: '2026-10-01' }),
  line({ seq: 4, accountId: VAT_IN, label: 'ضريبة 15٪', debit: 15, taxId: S, taxRole: 'TAX', vatBox: 'SA_7', taxBase: 100, generated: true }),
];

test('التحميل: علم generated من الخادم وحده، وسطر الضريبة اليدوي (TAX على حساب VAT) قابل للتحرير', () => {
  const grid = gridLinesFromMove(stored);
  assert.deepEqual(grid.map(l => !!l.generated), [false, false, false, false, true]);
  assert.equal(grid[2].taxRole, 'TAX');
  assert.equal(grid[3].taxRole, 'MARKER');
  assert.equal(grid[0].taxRole, null, 'BASE لا يُحمل دوراً');
  assert.equal(grid[4].taxRole, null, 'المولَّد لا يُحمل دوراً');
});

test('إعادة الحفظ دون تعديل: المولَّد محذوف (لا تكرار)، واليدوي مرسَل بحسابه وtaxId (لا إسقاط)، ولا TAX صريح', () => {
  const { sent, input } = moveInputLines(gridLinesFromMove(stored));
  assert.deepEqual(sent.map(l => l.key), ['l0', 'l1', 'l2', 'l3']);
  assert.equal(input.length, 4);
  // لا سطر مولَّد يُرسل بلا generated: كل سطر TAX يُرسَل هو اليدوي وحده
  assert.ok(!input.some(l => l.generated === true));
  assert.equal(input.filter(l => l.taxId === S && l.accountId === VAT_IN).length, 1, 'سطر ضريبة S واحد على حساب VAT (اليدوي)');
  assert.deepEqual(input[0], {
    accountId: 'acc_621004', label: 'إيجار', debit: '100', credit: undefined, taxId: S, vatBox: null, analyticAccountId: null,
    partnerName: null, customerId: null, vendorId: null,
  });
  assert.equal(input[2].taxRole, undefined, 'TAX لا يُرسل: الخادم يعرف اليدوي بحساب VAT مع taxId');
  assert.deepEqual(input[2], {
    accountId: VAT_IN, label: 'تسوية', debit: '5', credit: undefined, taxId: S, vatBox: 'SA_7', analyticAccountId: null,
    partnerName: null, customerId: null, vendorId: null, taxBaseMilli: '40',
  });
  assert.equal(input[3].taxRole, 'MARKER');
  assert.equal(input[3].taxBaseMilli, '250');
  assert.equal(input[3].salesRepId, 'rep1');
  assert.equal(input[3].dueDate, '2026-10-01');
});

test('تحرير سطر الضريبة اليدوي: تغيير المبلغ يُرسَل، وتغيير الحساب يُسقط MARKER والوعاء فلا يُسقطه الخادم صامتاً', () => {
  const grid = gridLinesFromMove(stored);
  grid[2] = { ...grid[2], debit: '7' };
  grid[3] = { ...grid[3], accountId: 'acc_621004' };
  const { input } = moveInputLines(grid);
  assert.equal(input[2].debit, '7');
  assert.equal(input[3].accountId, 'acc_621004');
  assert.equal(input[3].taxRole, undefined);
  assert.equal(input[3].taxBaseMilli, undefined);
});

test('سطر TAX لم يعلّمه الخادم مولَّداً لا يُحذف لمجرد دوره (الخطأ السابق: taxRole ⇒ generated)', () => {
  const only = [
    line({ seq: 0, accountId: VAT_IN, debit: 15, taxId: S, taxRole: 'TAX', vatBox: 'SA_7' }),
    line({ seq: 1, accountId: 'acc_112001', credit: 15 }),
  ];
  assert.equal(moveInputLines(gridLinesFromMove(only)).input.length, 2);
});

test('السطور الفارغة كلياً تُهمل، وفهارس sent تطابق lineIndex في أخطاء الخادم', () => {
  const grid = gridLinesFromMove(stored);
  grid.splice(1, 0, { ...grid[1], key: 'empty', accountId: '', label: '', debit: '', credit: '' });
  const { sent, input } = moveInputLines(grid);
  assert.equal(sent.length, input.length);
  assert.ok(!sent.some(l => l.key === 'empty'));
  assert.equal(sent[1].key, 'l1');
});

test('priceInclude: الوعاء المخزَّن صافٍ ⇒ إعادة الحفظ والتكرار ترسل المبلغ الشامل من الخادم، ثابتاً عبر ثلاث مرات', () => {
  const P = 'tax_S15_PURCH_INCL';
  // ما يرده GET بعد حفظ «مصروف 1150 شامل»: وعاء صافٍ 1000 بـgross=1150، ومقابل 1150، وضريبة مولَّدة 150
  const loaded: GlMoveLine[] = [
    line({ seq: 0, accountId: 'acc_621004', label: 'إيجار', debit: 1000, taxId: P, taxRole: 'BASE', gross: 1150 }),
    line({ seq: 1, accountId: 'acc_111001', label: 'صندوق', credit: 1150 }),
    line({ seq: 2, accountId: VAT_IN, label: 'ضريبة 15٪', debit: 150, taxId: P, taxRole: 'TAX', vatBox: 'SA_7', taxBase: 1000, generated: true }),
  ];
  const grid = gridLinesFromMove(loaded);
  assert.equal(grid[0].debit, '1000', 'الشبكة تعرض الصافي فتتوازن مع سطر الضريبة المولَّد');
  for (let n = 0; n < 3; n++) {
    // إعادة الحفظ دون تعديل (أو التكرار: duplicate يستعمل moveInputLines(gridLinesFromMove(...)) نفسها)
    const { input } = moveInputLines(gridLinesFromMove(loaded));
    assert.equal(input.length, 2);
    assert.equal(input[0].debit, '1150', `المبلغ الشامل لا الصافي (مرة ${n + 1})`);
    assert.equal(input[0].credit, undefined);
    assert.equal(input[1].credit, '1150');
  }
  // مبلغ يعدّله المستخدم يُرسَل كما كتبه (شاملاً كأي إدخال)، وتغيير الضريبة يُرسل المعروض
  const edited = gridLinesFromMove(loaded);
  edited[0] = { ...edited[0], debit: '2300' };
  assert.equal(moveInputLines(edited).input[0].debit, '2300');
  const retaxed = gridLinesFromMove(loaded);
  retaxed[0] = { ...retaxed[0], taxId: S };
  assert.equal(moveInputLines(retaxed).input[0].debit, '1000');
  // سطر بلا gross (ضريبة غير شاملة) يُرسَل صافياً كما هو
  assert.equal(moveInputLines(gridLinesFromMove(stored)).input[0].debit, '100');
});
