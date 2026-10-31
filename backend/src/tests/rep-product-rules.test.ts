// «قيود المندوب» على الصنف (طلب المالك ٣١ أكتوبر ٢٠٢٦، services/repProductRules.ts): يبيعه المندوب أم لا، ويرجعه أم لا،
// وبأيّ وحدة — الصغرى (الأساس، المعامل ١) أو الكبرى (معامل > ١). القواعد صرفةً، ثم حرّاس نصّية على مواضع التطبيق.
// والسلوك على مسار الفاتورة الحقيقي في multi-unit-routes.test.ts (أداة الوحدات المتعددة نفسها).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REP_PRODUCT_RULE_CODE, hasRepRules, replayPredatesRepRule, repActionAllowed, repLineProblem, repLinkedReturnProblem,
  repRuleConfigProblem, repRulesChanged, repUnitAllowed, repUnitRuleOf,
} from '../services/repProductRules';

const P = { name: 'ماء', unit: 'حبة' };

test('الافتراض بلا قيد — وغياب الحقل (صفٌّ أو كاشٌ قديم) بلا قيد', () => {
  assert.equal(repActionAllowed({}, 'SALE'), true);
  assert.equal(repActionAllowed({ repReturnAllowed: null }, 'RETURN'), true);
  assert.equal(repUnitRuleOf({}, 'SALE'), 'ANY');
  assert.equal(repUnitRuleOf({ repReturnUnit: 'غريب' }, 'RETURN'), 'ANY', 'قيمةٌ مجهولة لا تمنع');
  assert.equal(repLineProblem(P, 'SALE', 24), null);
  assert.equal(repLineProblem(P, 'RETURN', 1), null);
  assert.equal(hasRepRules({}), false);
  assert.equal(hasRepRules({ repSaleAllowed: true, repSaleUnit: 'ANY' }), false);
});

test('المنع الكامل: لا يبيعه أو لا يرجعه — بأي وحدة، والفعل الآخر حرّ', () => {
  assert.match(repLineProblem({ ...P, repSaleAllowed: false }, 'SALE', 1)!, /لا يبيعه المندوب/);
  assert.equal(repLineProblem({ ...P, repSaleAllowed: false }, 'RETURN', 1), null, 'بيعٌ فقط بلا إرجاع ≠ إرجاعٌ ممنوع');
  assert.match(repLineProblem({ ...P, repReturnAllowed: false }, 'RETURN', 24)!, /لا يرجعه المندوب/);
  assert.equal(repLineProblem({ ...P, repReturnAllowed: false }, 'SALE', 24), null);
});

test('قيد الوحدة: الصغرى = المعامل ١ وحده، والكبرى = ما فوقه — لكل فعلٍ قيده', () => {
  assert.equal(repUnitAllowed('BASE', 1), true);
  assert.equal(repUnitAllowed('BASE', 24), false);
  assert.equal(repUnitAllowed('LARGE', 1), false);
  assert.equal(repUnitAllowed('LARGE', 6), true);
  // يُباع بالكرتون فقط ويُرجع بالحبة فقط
  const p = { ...P, repSaleUnit: 'LARGE', repReturnUnit: 'BASE' };
  assert.equal(repLineProblem(p, 'SALE', 24), null);
  assert.match(repLineProblem(p, 'SALE', 1)!, /يباع من المندوب بالوحدة الكبرى فقط/);
  assert.equal(repLineProblem(p, 'RETURN', 1), null);
  assert.match(repLineProblem(p, 'RETURN', 24)!, /يرجع من المندوب بالوحدة الصغرى \(حبة\) فقط/);
});

test('المرتجع من فاتورة بيع: «الكبرى فقط» لبندٍ بيع بالأساس محجوبٌ (لا وحدة إرجاعٍ أكبر من وحدة البيع)', () => {
  assert.match(repLinkedReturnProblem({ ...P, repReturnUnit: 'LARGE' }, 1)!, /الكبرى فقط/);
  assert.equal(repLinkedReturnProblem({ ...P, repReturnUnit: 'LARGE' }, 24), null);
  assert.equal(repLinkedReturnProblem({ ...P, repReturnUnit: 'BASE' }, 24), null, 'الحبة من الكرتون متاحة دائماً');
  assert.match(repLinkedReturnProblem({ ...P, repReturnAllowed: false }, 24)!, /لا يرجعه/);
  // بوحدات الصنف: بيع بالكرتون (١٢) وقد أُوقف، والباليت (١٢٠) أكبر منه ⇒ لا وحدة كبرى يُرجع بها
  const units = [{ factor: 12, isActive: false }, { factor: 120, isActive: true }];
  assert.match(repLinkedReturnProblem({ ...P, repReturnUnit: 'LARGE' }, 12, units)!, /الكبرى فقط/);
  assert.equal(repLinkedReturnProblem({ ...P, repReturnUnit: 'LARGE' }, 120, units), null);
  assert.equal(repLinkedReturnProblem({ ...P, repReturnUnit: 'LARGE' }, 12, [{ factor: 6, isActive: true }]), null, 'علبةٌ من كرتون');
});

test('تسامح صندوق الأوف-لاين: مستندٌ أُنشئ على الجهاز قبل آخر تغيير للقيد يُقبل، وبعده أو بلا لحظة يُرفض', () => {
  const p = { ...P, repSaleAllowed: false, repRulesChangedAt: new Date('2026-10-31T10:00:00Z') };
  assert.equal(replayPredatesRepRule(p, true, '2026-10-31T09:59:00Z'), true);
  assert.equal(replayPredatesRepRule(p, true, '2026-10-31T10:01:00Z'), false);
  assert.equal(replayPredatesRepRule(p, false, '2026-10-31T09:00:00Z'), false, 'الإصدار الحيّ لا تسامح له');
  assert.equal(replayPredatesRepRule(p, true, undefined), false, 'إعادةٌ بلا لحظة جهاز ليست صندوقاً');
  assert.equal(replayPredatesRepRule(p, true, 'غير تاريخ'), false);
  assert.equal(replayPredatesRepRule({ ...p, repRulesChangedAt: null }, true, '2026-10-31T09:00:00Z'), false);
});

test('ختم التغيير وفحص الإعداد: «الكبرى فقط» يلزمه وحدةٌ كبرى نشطة', () => {
  assert.equal(repRulesChanged({}, { repSaleAllowed: true }), false, 'إرسال الافتراض ليس تغييراً');
  assert.equal(repRulesChanged({ repSaleUnit: 'ANY' }, { repSaleUnit: 'BASE' }), true);
  assert.equal(repRulesChanged({ repReturnAllowed: true }, { repReturnAllowed: false }), true);
  assert.equal(repRuleConfigProblem({ repSaleUnit: 'BASE' }, null), null, 'الصغرى متاحة دائماً');
  assert.match(repRuleConfigProblem({ repSaleUnit: 'LARGE' }, null)!, /وحدة كبرى نشطة/);
  assert.match(repRuleConfigProblem({ repReturnUnit: 'LARGE' }, [{ factor: 24, isActive: false }])!, /وحدة كبرى نشطة/);
  assert.equal(repRuleConfigProblem({ repReturnUnit: 'LARGE' }, [{ factor: 24, isActive: true }]), null);
});

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('حارس نصّي: الفحص للمندوب وحده قبل فرع المرحلة الثانية، بلقطة الخادم وبلا استعلامٍ زائد ولحظة deviceAt', () => {
  const inv = read('routes/invoices.ts');
  const post = inv.slice(inv.indexOf("router.post('/',"));
  const gate = post.indexOf("if (req.user!.role === 'SALES_REP') {\n      const action = isReturn ? 'RETURN' : 'SALE';");
  assert.ok(gate > 0, 'حارس قيود المندوب غائب');
  assert.ok(gate < post.indexOf('regimeCandidate({'), 'قبل فرع المرحلة الثانية (يشمل المرتجع-إشعاراً)');
  assert.ok(gate > post.indexOf('const deviceAt ='), 'لحظة الجهاز من deviceAt (لا clientCreatedAt خام، ولا لحظة مفتاح)');
  const block = post.slice(gate, gate + 1600);
  assert.match(block, /replayPredatesRepRule\(p, isReplay, deviceAt\)/);
  // التصنيف بوحدة البند المعروفة (معاملها على الخادم) لا بمعاملٍ يرسله الجهاز في إعادة الرفع
  assert.match(block, /const known = snap\.unitName \? p\.units\.find\(/);
  assert.match(block, /repLineProblem\(p, action, known \? Number\(known\.factor\) : snap\.unitFactor\)/);
  assert.match(block, /code: REP_PRODUCT_RULE_CODE/);
  // الأعمدة من استعلام الأصناف القائم (لا استعلام جديد في مسار الإصدار)
  assert.match(post, /repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: true, repReturnUnit: true, repRulesChangedAt: true,/);
  assert.equal(REP_PRODUCT_RULE_CODE, 'REP_PRODUCT_RULE');
  // /returnable: السبب للمندوب وحده ويتقدّم قيد الصلاحية، وقيد وحدة المرتجع يصله وحده
  const ret = inv.slice(inv.indexOf("router.get('/:id/returnable'"), inv.indexOf("router.get('/:id/returnable'") + 7000);
  assert.match(ret, /\.\.\.\(isRep && repLinkedReturnProblem\(it\.product!, factorOf\(it\), it\.product!\.units\)/);
  assert.match(ret, /isRep \? \{ repReturnUnit: repUnitRuleOf\(it\.product!, 'RETURN'\) \} : \{\}/);
  // الإشعار الدائن المباشر (POST /:id/credit-note) للمندوب
  const notes = read('routes/invoicesNotes.ts');
  // والإشعار الكامل (بديل الإلغاء بعد الربط) يحكمه canCancelInvoice لا قيد المرتجع — كإلغاء المرحلة الأولى
  assert.match(notes, /if \(ctx\.actor\?\.role === 'SALES_REP' && effectiveCreditScope\(prepared\.creditable, prepared\.lines\) !== 'FULL'\) \{\n      const replay = isReplayRequest\(ctx\.caps\);/);
  assert.match(notes, /repLineProblem\(p, 'RETURN', l\.creditUnitFactor\)/);
  assert.match(notes, /repReturnAllowed: true, repReturnUnit: true, repRulesChangedAt: true,/);
});

test('حارس نصّي: الحفظ يختم التغيير ويتحقّق من «الكبرى فقط»، والوحدات والتحويل لا يتركان القيد بلا معنى', () => {
  const products = read('routes/products.ts');
  assert.equal(products.split('repRuleConfigProblem(repRules.merged').length - 1, 2, 'الإنشاء والتعديل كلاهما');
  assert.match(products, /const repRules = repRuleWrite\(data, exists\);/);
  // «الكبرى فقط» يُفحص حين يُضبط من جديد وحده — قيدٌ قائم فقد وحدته الكبرى لا يحبس تعديلات الصنف الأخرى
  assert.match(products, /const repProblem = newlyLarge \? repRuleConfigProblem\(repRules\.merged, exists\.units\) : null;/);
  assert.match(products, /code: 'REP_UNIT_RULE_INVALID'/);
  assert.equal(products.split('refuseLargeRuleWithout(product,').length - 1, 2, 'تعديل الوحدة وحذفها');
  // التحويل ومعاينته (dryRun) يرفضان بالحارس المشترك نفسه (الوحدة الرئيسية §2.2-ز): القيد قبل فحص المعامل والاسم، تحت القفل
  const convert = products.slice(products.indexOf("router.post('/:id/convert-base'"));
  const refusalOn = products.slice(products.indexOf('async function convertBaseRefusalOn('), products.indexOf("router.post('/:id/convert-base'"));
  assert.ok(refusalOn.indexOf("'REP_UNIT_RULE_SET'") > 0 && refusalOn.indexOf("'REP_UNIT_RULE_SET'") < refusalOn.indexOf('baseConversionProblem(product, body)'));
  assert.ok(convert.indexOf('await convertBaseRefusalOn(tx, tid, product, body);') > convert.indexOf('const product = await lockProduct(tx, tid, req.params.id);'));
  // المزامنة: الأربعة معروضة، والختم سباكة داخلية
  const sync = read('services/apiSync.ts');
  assert.match(sync, /'repSaleAllowed', 'repReturnAllowed', 'repSaleUnit', 'repReturnUnit',/);
  assert.match(sync, /repRulesChangedAt: 'سباكة داخلية/);
});
