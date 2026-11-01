// «تتبّع اللوط» — /m: سطر إنقاصٍ بلا صريح يُسحب تلقائياً مما بقي بعد أسطر صنفه الصريحة، مرآة planWarehouseEntryInTx (withoutRows
// ثم pickOutFefoLines) في المستودع وpickPlan في السيارة — طلب المالك ١ نوفمبر ٢٠٢٦ بدل «المصدر الوحيد وإلا LOT_REQUIRED» في D10:
// لا اختيار يلزمه أيّاً كان عدد المصادر، والممنوع ما فوق مجموعها وحده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { outAutoRows, outGroupProblems, whOutRows, emptyLotDraft, type OutSourceQty } from './mLotsLogic';

const AB: OutSourceQty[] = [{ lotId: 'A', usable: 10 }, { lotId: 'B', usable: 5 }];
const pick = (p: string, base: number) => whOutRows({ ...emptyLotDraft(), pick: p }, base);
const lines = (ls: [string, string, number, number?][]) => ls.map(([key, p, base, factor]) => ({ key, base, factor, rows: pick(p, base) }));
const probs = (sources: OutSourceQty[], ls: [string, string, number][]) => outGroupProblems(sources, lines(ls), { loaded: true });

test('الطلب المختلط [A −١٠، بلا اختيار −٥]: يُسحب من B ⇒ لا مشكلة (الخادم يقبله)', () => {
  assert.equal(probs(AB, [['x', 'A', 10], ['y', '', 5]]).size, 0);
  assert.deepEqual(outAutoRows(AB, lines([['x', 'A', 10], ['y', '', 5]])).get('y'), [{ lotId: 'B', qty: 5 }]);
  assert.equal(probs([{ lotId: 'A', usable: 10 }, { lotId: null, usable: 3 }], [['x', 'UNNAMED', 3], ['y', '', 2]]).size, 0);
});

test('صريحٌ لا يصفّي مصدره ⇒ مصدران باقيان ⇒ لا PICK: يُسحب من الباقي بالترتيب', () => {
  assert.equal(probs(AB, [['x', 'A', 4], ['y', '', 1]]).size, 0, 'كان PICK (LOT_REQUIRED)');
  assert.deepEqual(outAutoRows(AB, lines([['x', 'A', 4], ['y', '', 8]])).get('y'), [{ lotId: 'A', qty: 6 }, { lotId: 'B', qty: 2 }]);
  // صريحٌ على B نفسها: الباقي A:0 وB:3، والسطر بلا اختيار ٣ يكفيه
  assert.equal(probs(AB, [['x', 'A', 10], ['z', 'B', 2], ['y', '', 3]]).size, 0);
});

test('فوق المجموع ⇒ OVER على أول سطر (الخادم: LOT_STOCK_INSUFFICIENT)، ولا معاينة', () => {
  assert.equal(probs(AB, [['x', 'A', 10], ['y', '', 6]]).get('x'), 'OVER');
  assert.equal(probs(AB, [['y', '', 16]]).get('y'), 'OVER');
  assert.equal(probs(AB, [['y', '', 15]]).size, 0);
  assert.equal(outAutoRows(AB, lines([['y', '', 16]])).size, 0);
});

test('ما يرفضه الخادم في الصريح يبقى ممنوعاً على سطره: صريحٌ فوق صالحه، والتلقائي بعده بلا مشكلة من عنده', () => {
  const over = probs(AB, [['x', 'A', 11], ['y', '', 1]]);
  assert.equal(over.get('x'), 'ROW_OVER');
  assert.equal(over.has('y'), false);
  // صريحان يصفّيان كل المصادر وتلقائيٌّ بعدهما: المجموع فوق المصادر ⇒ OVER
  assert.ok(probs(AB, [['x', 'A', 10], ['z', 'B', 5], ['y', '', 1]]).size > 0);
  assert.equal(probs([{ lotId: 'A', usable: 10 }], [['y', '', 1], ['w', '', 2]]).size, 0);
});

test('outAutoRows: بترتيب الانتهاء ثم ترتيب المصادر، وقاعدة الكرتون لكل سطر، والأسطر تتابع على المتاح (D26)', () => {
  const s = [{ lotId: 'L2', usable: 30, expiryDate: '2027-02-01' }, { lotId: 'L1', usable: 20, expiryDate: '2026-12-01' }, { lotId: null, usable: 5 }];
  // L1 أقرب انتهاءً، لكنها لا تكفي كرتوناً (٢٤) فيؤخذ الكرتون كاملاً من L2
  assert.deepEqual(outAutoRows(s, lines([['c', '', 24, 24]])).get('c'), [{ lotId: 'L2', qty: 24 }]);
  // بلا معامل: L1 أولاً حتى تنفد ثم L2
  assert.deepEqual(outAutoRows(s, lines([['p', '', 24]])).get('p'), [{ lotId: 'L1', qty: 20 }, { lotId: 'L2', qty: 4 }]);
  // سطران: الكرتون يُخدم أولاً (cartonRank، D22) فيأخذ كرتونه كاملاً من L2، والحبّات بعده من L1 الأقرب انتهاءً
  const two = outAutoRows(s, lines([['p', '', 18], ['c', '', 24, 24]]));
  assert.deepEqual(two.get('p'), [{ lotId: 'L1', qty: 18 }]);
  assert.deepEqual(two.get('c'), [{ lotId: 'L2', qty: 24 }]);
  // الكرتون أولاً ولو جاء سطره ثانياً: A أقرب انتهاءً ١٢ وB ٥، [٥ حبّات، كرتون ١٢] ⇒ الكرتون A كاملةً والحبّات من B
  const ctn = outAutoRows([{ lotId: 'A', usable: 12, expiryDate: '2026-12-01' }, { lotId: 'B', usable: 5, expiryDate: '2027-01-01' }],
    lines([['p', '', 5, 1], ['c', '', 12, 12]]));
  assert.deepEqual(ctn.get('p'), [{ lotId: 'B', qty: 5 }]);
  assert.deepEqual(ctn.get('c'), [{ lotId: 'A', qty: 12 }]);
  // غير المسمّى آخراً
  assert.deepEqual(outAutoRows(s, lines([['p', '', 52]])).get('p'), [{ lotId: 'L1', qty: 20 }, { lotId: 'L2', qty: 30 }, { lotId: null, qty: 2 }]);
  // الصريحة لا معاينة لها، وبلا مصادر لا معاينة
  assert.equal(outAutoRows(s, lines([['x', 'L1', 3]])).size, 0);
  assert.equal(outAutoRows([], lines([['p', '', 1]])).size, 0);
});

test('شاشتا الجوال: لا «تلقائي حين يكون للصنف مصدر واحد»، والتنزيل التلقائي بلا lots مع تحديدٍ يدوي اختياري', () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'm', f), 'utf8');
  const f = read('MLotFields.tsx');
  assert.doesNotMatch(f, /مصدر واحد|المصدر الوحيد/);
  assert.match(f, /tr\('تلقائي: الأقرب انتهاءً أولاً'\)/);
  const wh = read('MWarehouse.tsx');
  assert.match(wh, /outAutoRows\(sources, lines\)/);
  assert.match(wh, /autoRows=\{outAuto\.get\(k\) \?\? null\}/);
  const rep = read('MRepLoad.tsx');
  assert.match(rep, /return r\.outManual \? \{ lots: outRowsOf\(r\) \} : \{\};/, 'التلقائي يجب ألا يرسل lots');
  assert.doesNotMatch(rep, /sourcesOf\(r\.productId\)\.length > 1 \? \{ lots/, 'الصريح الإلزامي لأكثر من مصدر (D10) ملغى');
  assert.match(rep, /outAutoRows\(fefoSourcesOf\(pid\), lines\)/, 'المعاينة بترتيب السحب لا بترتيب الإخراج اليدوي');
  assert.match(rep, /tr\('تحديد التشغيلة يدوياً'\)/);
});

test('تطبيق المندوب (MRepLoad): تغيّر الكمية أو الإشارة أو الوحدة أو الأساس يعيد التنزيل «تلقائياً» لا يدوياً بلا صفوف (مراجعة C7)', () => {
  const rep = fs.readFileSync(path.join(process.cwd(), 'src', 'm', 'MRepLoad.tsx'), 'utf8');
  assert.match(rep, /const AUTO_OUT: Pick<Row, 'outManual' \| 'outLots'> = \{ outManual: false, outLots: undefined \};/);
  // كل مسارٍ يُسقط outLots يُسقط outManual معه — وإلا أعاد prefillOutLines ملأه بترتيب الإخراج ('OUT') فخالف خطة FEFO
  // جسم الدالة: حتى أول سطرٍ بعدها بإزاحة المكوّن (const أو function أو تعليق)
  const body = (start: string) => {
    const i = rep.indexOf(start);
    assert.ok(i > 0, `${start} غائب`);
    const rest = rep.slice(i + start.length);
    const end = /\n {2}(?:const |function |async function |\/\*|\/\/)/.exec(rest);
    return rest.slice(0, end ? end.index : undefined);
  };
  for (const f of ['const patchQty = ', 'const flipSign = ', 'const setRowUnit = ', 'async function refreshRowUnits']) {
    assert.match(body(f), /\.\.\.AUTO_OUT/, `${f} يُسقط outLots ويُبقي outManual`);
  }
  assert.equal(rep.split('outLots: undefined').length - 1, 1, 'إسقاط الصفوف خارج AUTO_OUT يُبقي outManual');
  assert.match(rep, /onAuto=\{\(\) => patchRow\(k, AUTO_OUT\)\}/);
});
