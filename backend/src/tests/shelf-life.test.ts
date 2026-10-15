// صلاحية الصنف (services/shelfLife.ts، services/invoiceExpiry.ts) — تاريخ الانتهاء من تاريخ البيع بالأيام أو الأشهر
// أو السنوات، وحالة المرتجع (منتهٍ أم لا). صرفٌ بلا قاعدة، ومعه حارسٌ نصّي على المسارات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addShelfLife, expiryDateFor, localDateIn, shelfLifeOf, shelfLifeProblem } from '../services/shelfLife';
import { isExpiredOn } from '../services/invoiceExpiry';

test('الأيام: تعبر الشهر والسنة', () => {
  assert.equal(addShelfLife('2026-10-11', 30, 'DAY'), '2026-11-10');
  assert.equal(addShelfLife('2026-12-25', 10, 'DAY'), '2027-01-04');
  assert.equal(addShelfLife('2028-02-28', 1, 'DAY'), '2028-02-29', 'سنة كبيسة');
});

test('الأشهر بالتقويم وتُقصّ إلى آخر الشهر', () => {
  assert.equal(addShelfLife('2026-10-11', 6, 'MONTH'), '2027-04-11');
  assert.equal(addShelfLife('2026-01-31', 1, 'MONTH'), '2026-02-28', '٣١ يناير + شهر = آخر فبراير لا ٣ مارس');
  assert.equal(addShelfLife('2027-12-31', 2, 'MONTH'), '2028-02-29');
  assert.equal(addShelfLife('2026-10-11', 18, 'MONTH'), '2028-04-11');
});

test('السنوات، و٢٩ فبراير + سنة = ٢٨ فبراير', () => {
  assert.equal(addShelfLife('2026-10-11', 2, 'YEAR'), '2028-10-11');
  assert.equal(addShelfLife('2028-02-29', 1, 'YEAR'), '2029-02-28');
  assert.equal(addShelfLife('2028-02-29', 4, 'YEAR'), '2032-02-29');
});

test('تاريخ البيع بتوقيت الشركة لا UTC', () => {
  // ١:٣٠ فجر ١٢ أكتوبر بالرياض = ٢٢:٣٠ يوم ١١ بتوقيت UTC
  const at = new Date('2026-10-11T22:30:00Z');
  assert.equal(localDateIn(at, 'Asia/Riyadh'), '2026-10-12');
  const p = { shelfLifeEnabled: true, shelfLifeValue: 10, shelfLifeUnit: 'DAY' };
  assert.equal(expiryDateFor(p, at, 'Asia/Riyadh')?.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(expiryDateFor(p, at, 'Africa/Casablanca')?.toISOString(), '2026-10-21T00:00:00.000Z');
});

test('صنفٌ بلا صلاحية مفعّلة أو بإعداد ناقص: لا تاريخ', () => {
  const at = new Date('2026-10-11T08:00:00Z');
  assert.equal(expiryDateFor({ shelfLifeEnabled: false, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }, at, 'Asia/Riyadh'), null);
  assert.equal(expiryDateFor({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' }, at, 'Asia/Riyadh'), null);
  assert.equal(shelfLifeOf({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'WEEK' }), null);
  assert.deepEqual(shelfLifeOf({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'YEAR' }), { value: 3, unit: 'YEAR' });
});

test('التحقّق: المفعّلة تلزمها مدةٌ صحيحة ووحدة، والمطفأة تُقبل', () => {
  assert.equal(shelfLifeProblem({ shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null }), null);
  assert.equal(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 12, shelfLifeUnit: 'MONTH' }), null);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 0, shelfLifeUnit: 'DAY' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 2.5, shelfLifeUnit: 'DAY' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 5, shelfLifeUnit: null })), /وحدة/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 101, shelfLifeUnit: 'YEAR' })), /أطول من المعقول/);
});

test('المرتجع: منتهٍ إن جاء بعد يوم الانتهاء، ويوم الانتهاء نفسه آخر يومٍ صالح', () => {
  const exp = new Date('2026-10-20T00:00:00.000Z');
  assert.equal(isExpiredOn('2026-10-19', exp), false);
  assert.equal(isExpiredOn('2026-10-20', exp), false);
  assert.equal(isExpiredOn('2026-10-21', exp), true);
  assert.equal(isExpiredOn('2027-01-01', exp), true);
});

test('حارس نصّي: الصلاحية من تاريخ البيع — الصنف يتحقّق مدمجاً بالمحفوظ، والإصدار يسجّلها، والوارد لا يحسبها', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const products = read('routes/products.ts');
  assert.equal(products.split('shelfLifeProblem(').length - 1, 2, 'الإنشاء والتعديل كلاهما يتحقّقان');
  assert.ok(products.includes('data.shelfLifeEnabled ?? exists.shelfLifeEnabled'), 'التعديل يدمج مع المحفوظ');

  // كل مخارج الإصدار تسجّل الصلاحية: المرتجع المرتبط، والمرحلة الثانية، والمرحلة الأولى، والإشعارات
  const inv = read('routes/invoices.ts');
  for (const frag of [
    'if (note && tracksExpiry) await stampExpiryAfterIssue(tid, note.status, note.body);',
    'if (phase2 && tracksExpiry) await stampExpiryAfterIssue(tid, phase2.status, phase2.body);',
    'if (tracksExpiry) await stampExpiryAfterIssue(tid, 201, { data: invoice });',
    'await stampExpiryAfterIssue(tid, r.status, r.body);',
  ]) assert.ok(inv.includes(frag), `مخرج إصدار بلا تسجيل الصلاحية: ${frag}`);
  // لا استعلام إضافي لشركةٍ لا تستعمل الصلاحية: الشرط من استعلام الأصناف القائم نفسه
  assert.ok(inv.includes('const tracksExpiry = products.some((p) => shelfLifeOf(p));'));

  const svc = read('services/invoiceExpiry.ts');
  const after = svc.slice(svc.indexOf('export async function stampExpiryAfterIssue'));
  assert.match(after, /try \{\s*await stampInvoiceExpiry\(tenantId, id\);\s*\} catch/, 'التسجيل لا يُفشل الإصدار أبداً');
  // المرتجع الحرّ يُقاس على آخر بيعٍ لهذا الصنف لهذا العميل قبله، غير ملغى ولا إشعار؛ والمرتبط على بند أصله
  for (const frag of ['customerId: inv.customerId', 'type: { in: SALE_TYPES }', "status: { not: 'CANCELLED' }",
    'invoiceDate: { lte: inv.invoiceDate }', "orderBy: [{ invoice: { invoiceDate: 'desc' } }", 'it.creditedItemId']) {
    assert.ok(svc.includes(frag), `قياس المرتجع: ${frag}`);
  }

  const wh = read('routes/warehouse.ts');
  assert.ok(!/expiresAt|shelfLife/.test(wh), 'الوارد لا يحسب الصلاحية بعد أن صارت من تاريخ البيع');
});

// ═══ أساس حساب الصلاحية لكل صنف (١٥ أكتوبر ٢٠٢٦): البيع | الشراء بتاريخٍ مكتوب | تحميل السيارة ═══
import { dayOf, fifoBatchAt, purchaseExpiry, shelfLifeBasisOf } from '../services/shelfLife';

test('الأساس: الغائب أو غير المعروف = البيع', () => {
  assert.equal(shelfLifeBasisOf({}), 'SALE');
  assert.equal(shelfLifeBasisOf({ shelfLifeBasis: 'X' }), 'SALE');
  assert.equal(shelfLifeBasisOf({ shelfLifeBasis: 'VAN_LOAD' }), 'VAN_LOAD');
});

test('الشراء: التاريخ المكتوب + المدة — صلاحيةٌ واحدة لكل الكمية', () => {
  const p = { shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH', shelfLifeBasis: 'PURCHASE', shelfLifeFromDate: new Date('2026-08-31T00:00:00Z') };
  assert.equal(purchaseExpiry(p)?.toISOString(), '2027-02-28T00:00:00.000Z', '٣١ أغسطس + ٦ أشهر = آخر فبراير');
  assert.equal(purchaseExpiry({ ...p, shelfLifeFromDate: '2026-10-01' })?.toISOString(), '2027-04-01T00:00:00.000Z');
  assert.equal(purchaseExpiry({ ...p, shelfLifeFromDate: null }), null);
  assert.equal(purchaseExpiry({ ...p, shelfLifeEnabled: false }), null);
  assert.equal(dayOf('2026-10-01T05:00:00Z'), '2026-10-01');
  assert.equal(dayOf('ليس تاريخاً'), null);
});

test('التحقّق: أساس الشراء يلزمه تاريخ، والأساس المجهول يُرفض', () => {
  const base = { shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' };
  assert.match(String(shelfLifeProblem({ ...base, shelfLifeBasis: 'PURCHASE', shelfLifeFromDate: null })), /تاريخ الشراء/);
  assert.equal(shelfLifeProblem({ ...base, shelfLifeBasis: 'PURCHASE', shelfLifeFromDate: '2026-10-01' }), null);
  assert.equal(shelfLifeProblem({ ...base, shelfLifeBasis: 'VAN_LOAD' }), null);
  assert.match(String(shelfLifeProblem({ ...base, shelfLifeBasis: 'WAREHOUSE' })), /أساس حساب الصلاحية/);
});

test('تحميل السيارة: الأقدم يُصرف أولاً — البيع من الدفعة التي بلغها المصروف قبله', () => {
  const A = new Date('2026-10-01T06:00:00Z'), B = new Date('2026-10-05T06:00:00Z'), C = new Date('2026-10-09T06:00:00Z');
  const loads = [{ qty: 50, at: B }, { qty: 100, at: A }, { qty: 30, at: C }]; // الترتيب الزمني لا ترتيب الورود
  assert.equal(fifoBatchAt(loads, 0)?.getTime(), A.getTime());
  assert.equal(fifoBatchAt(loads, 99)?.getTime(), A.getTime(), 'الوحدة المئة ما زالت من الدفعة الأولى');
  assert.equal(fifoBatchAt(loads, 100)?.getTime(), B.getTime());
  assert.equal(fifoBatchAt(loads, 175)?.getTime(), C.getTime());
  assert.equal(fifoBatchAt(loads, 500)?.getTime(), C.getTime(), 'بيعٌ فوق المحمَّل يُنسب لآخر دفعة');
  assert.equal(fifoBatchAt([], 0), null, 'بلا تحميل: غير معروف');
});

test('حارس نصّي: صلاحية ما بيع بأساس الصنف في كل المواضع، وتحميل السيارة يحسب المصروف قبله بلا هذا البيع', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const svc = read('services/invoiceExpiry.ts');
  assert.ok(svc.split('await saleExpiryFor(').length - 1 >= 3, 'البيع والمرتجع الحرّ والمرتبط');
  assert.match(svc, /id: \{ not: invoiceId \}/, 'المصروف قبل البيع لا يشمل البيع نفسه');
  assert.match(svc, /type: 'UNLOAD', createdAt: \{ lt: saleAt \}/, 'التنزيل للمستودع مصروف');
  assert.match(read('routes/invoices.ts'), /await saleExpiryFor\(tid, tz, it\.product!/, 'شاشة اختيار فاتورة البيع');
});

// ═══ قيد المرتجع لكل صنف (١٥ أكتوبر ٢٠٢٦): قرب الانتهاء | ما زال صالحاً، بالأيام | بالنسبة ═══
import { daysBetween, returnRuleConfigProblem, returnRuleProblem, shelfLifeDays } from '../services/shelfLife';

const RULE_BASE = { shelfLifeEnabled: true, shelfLifeValue: 100, shelfLifeUnit: 'DAY', returnRuleEnabled: true };
const EXP = new Date('2026-12-31T00:00:00Z');

test('قيد المرتجع: الإعداد — مطفأ يُقبل، والمفعّل يلزمه صلاحيةٌ واتجاهٌ وحدٌّ صحيح', () => {
  assert.equal(returnRuleConfigProblem({ returnRuleEnabled: false }), null);
  assert.match(String(returnRuleConfigProblem({ returnRuleEnabled: true, returnRuleMode: 'NEAR_EXPIRY', returnRuleMetric: 'DAYS', returnRuleValue: 5 })), /تفعيل صلاحية/);
  assert.match(String(returnRuleConfigProblem({ ...RULE_BASE, returnRuleMode: 'X', returnRuleMetric: 'DAYS', returnRuleValue: 5 })), /متى يقبل/);
  assert.match(String(returnRuleConfigProblem({ ...RULE_BASE, returnRuleMode: 'NEAR_EXPIRY', returnRuleMetric: null, returnRuleValue: 5 })), /بالأيام أو بنسبة/);
  assert.match(String(returnRuleConfigProblem({ ...RULE_BASE, returnRuleMode: 'NEAR_EXPIRY', returnRuleMetric: 'DAYS', returnRuleValue: 0 })), /أكبر من صفر/);
  assert.match(String(returnRuleConfigProblem({ ...RULE_BASE, returnRuleMode: 'STILL_VALID', returnRuleMetric: 'PERCENT', returnRuleValue: 120 })), /١٠٠٪/);
  assert.equal(returnRuleConfigProblem({ ...RULE_BASE, returnRuleMode: 'STILL_VALID', returnRuleMetric: 'PERCENT', returnRuleValue: 50 }), null);
});

test('قيد المرتجع: الأيام والنسبة من يوم المرتجع إلى الانتهاء', () => {
  assert.equal(daysBetween('2026-12-21', '2026-12-31'), 10);
  assert.equal(daysBetween('2027-01-02', '2026-12-31'), -2);
  assert.equal(shelfLifeDays({ shelfLifeEnabled: true, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }), 182.625);
  assert.equal(shelfLifeDays({ shelfLifeEnabled: false, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }), null);
});

test('قيد المرتجع «قرب الانتهاء»: يُقبل إن بقي الحدّ أو أقل، والمنتهي يُقبل', () => {
  const days = { ...RULE_BASE, returnRuleMode: 'NEAR_EXPIRY', returnRuleMetric: 'DAYS', returnRuleValue: 10 };
  assert.equal(returnRuleProblem(days, EXP, '2026-12-21'), null, 'باقٍ ١٠ = الحدّ');
  assert.match(String(returnRuleProblem(days, EXP, '2026-12-20')), /10 يوماً أو أقل، والباقي 11 يوماً/);
  assert.equal(returnRuleProblem(days, EXP, '2026-12-31'), null, 'يوم الانتهاء');
  assert.equal(returnRuleProblem(days, EXP, '2027-01-05'), null, 'المنتهي يُقبل');
  const pct = { ...RULE_BASE, returnRuleMode: 'NEAR_EXPIRY', returnRuleMetric: 'PERCENT', returnRuleValue: 20 };
  assert.equal(returnRuleProblem(pct, EXP, '2026-12-11'), null, 'باقٍ ٢٠ من ١٠٠ يوم = ٢٠٪');
  assert.match(String(returnRuleProblem(pct, EXP, '2026-12-10')), /20٪ أو أقل، والباقي 21٪/);
});

test('قيد المرتجع «ما زال صالحاً»: يُقبل إن بقي الحدّ أو أكثر، والمنتهي يُرفض', () => {
  const days = { ...RULE_BASE, returnRuleMode: 'STILL_VALID', returnRuleMetric: 'DAYS', returnRuleValue: 30 };
  assert.equal(returnRuleProblem(days, EXP, '2026-12-01'), null, 'باقٍ ٣٠ = الحدّ');
  assert.match(String(returnRuleProblem(days, EXP, '2026-12-02')), /30 يوماً أو أكثر، والباقي 29 يوماً/);
  assert.match(String(returnRuleProblem(days, EXP, '2027-01-01')), /منتهي الصلاحية/);
  const pct = { ...RULE_BASE, returnRuleMode: 'STILL_VALID', returnRuleMetric: 'PERCENT', returnRuleValue: 50 };
  assert.equal(returnRuleProblem(pct, EXP, '2026-11-11'), null, 'باقٍ ٥٠ من ١٠٠ يوم = ٥٠٪');
  assert.match(String(returnRuleProblem(pct, EXP, '2026-11-21')), /50٪ أو أكثر، والباقي 40٪/);
});

test('قيد المرتجع: المطفأ أو بلا صلاحية أو بإعدادٍ ناقص لا يرفض شيئاً', () => {
  const off = { ...RULE_BASE, returnRuleEnabled: false, returnRuleMode: 'STILL_VALID', returnRuleMetric: 'DAYS', returnRuleValue: 30 };
  assert.equal(returnRuleProblem(off, EXP, '2027-06-01'), null);
  assert.equal(returnRuleProblem({ ...off, returnRuleEnabled: true, shelfLifeEnabled: false }, EXP, '2027-06-01'), null);
  assert.equal(returnRuleProblem({ ...off, returnRuleEnabled: true, returnRuleValue: null }, EXP, '2027-06-01'), null);
});

test('حارس نصّي: القيد يُفرض قبل الإصدار بمرحلتيه، بشرطٍ من استعلام الأصناف القائم، والصنف يتحقّق مدمجاً', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const inv = read('routes/invoices.ts');
  const post = inv.slice(inv.indexOf("router.post('/',"));
  const gate = post.indexOf('if (isReturn && products.some((p) => p.returnRuleEnabled && shelfLifeOf(p))) {');
  assert.ok(gate > 0 && gate < post.indexOf('regimeCandidate({'), 'القيد قبل فرع المرحلة الثانية (يشمل الإشعار الدائن)');
  assert.ok(post.indexOf("code: 'RETURN_RULE_BLOCKED'") > gate);
  assert.match(inv, /returnBlocked: expiresAt \? returnRuleProblem\(it\.product!, expiresAt, today\) : null/, 'شاشة اختيار فاتورة البيع');
  const products = read('routes/products.ts');
  assert.equal(products.split('returnRuleConfigProblem(').length - 1, 2, 'الإنشاء والتعديل كلاهما يتحقّقان من القيد');
  assert.ok(products.includes('data.returnRuleEnabled ?? exists.returnRuleEnabled'), 'التعديل يدمج القيد مع المحفوظ');
});
