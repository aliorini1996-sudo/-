// «هدف الشهر» (طلب المالك ٩ نوفمبر ٢٠٢٦) — منطقه الصرف (lib/repTargets.ts) وحرّاسٌ نصّية على توصيله: أيقونة صفحة المناديب
// بعَلَم المحاسبة ونافذتها، وبطاقة رئيسية المندوب بنسختها المحفوظة، والقاموس بلغاته الأربع لكل عبارة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_TARGETS_PER_MONTH, REP_TARGET_TEXTS, REWARD_KINDS, TARGET_ERRORS, TARGET_KINDS, barPct, cleanDecimal, daysLeftText, draftOf, draftProblem,
  emptyDraft, monthLabel, pctText, readNum, rewardText, shiftMonth, targetAmountText, targetErrorCode, targetErrorMessage, targetRemaining, targetStateText,
  targetTitle, targetsFetchDue, toTargetInput, type RepTargetView, type TargetDraft,
} from './repTargets';
import type { UnitChoice } from '../rep/repUnits';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;
const money = (n: number) => `${n.toFixed(2)} ر.س`;

const draft = (over: Partial<TargetDraft> = {}): TargetDraft => ({ ...emptyDraft('2026-11'), targetValue: '50000', rewardValue: '2', ...over });

const view = (over: Partial<RepTargetView> = {}): RepTargetView => ({
  id: 't1', month: '2026-11', kind: 'SALES_AMOUNT', targetValue: 50000, productId: null, productName: null, unitId: null, unitName: null,
  unitFactor: 1, rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2, note: null, createdByName: 'المدير', createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
  progress: { state: 'OK', achieved: 20000, goal: 50000, pct: 40, done: false },
  reward: { kind: 'COMMISSION_SALES_PCT', value: 2, amount: 400, earned: false },
  ...over,
});

const carton: UnitChoice = { id: 'u-carton', name: 'كرتون', factor: 24, price: null };
const piece: UnitChoice = { id: null, name: 'حبة', factor: 1, price: null };

test('draftProblem مرآة حدود الخادم: الشهر YYYY-MM، والقيمة أكبر من صفر حتى سقف نوعها، والمكافأة كذلك، والملاحظة ٣٠٠', () => {
  assert.equal(draftProblem(draft()), null, 'هدف مبيعاتٍ سليم');
  for (const m of ['2026-13', '2026-00', '2026-1', '26-11', '']) assert.equal(draftProblem(draft({ month: m })), 'الشهر غير صحيح', m);

  // المبيعات: > 0 و≤ 1e12
  for (const v of ['0', '-5', '', 'abc']) assert.equal(draftProblem(draft({ targetValue: v })), 'مبلغ الهدف رقم أكبر من صفر', v);
  assert.equal(draftProblem(draft({ targetValue: '1000000000000' })), null, 'السقف نفسه مقبول');
  assert.equal(draftProblem(draft({ targetValue: '1000000000001' })), 'مبلغ الهدف كبير جدا');

  // الكمية: بصنفٍ، > 0 و≤ 1e9
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', targetValue: '10' })), 'اختر صنفاً صحيحاً', 'هدف كميةٍ بلا صنف');
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '1000000000' })), null);
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '1000000001' })), 'كمية الهدف كبيرة جدا');
  assert.equal(draftProblem(draft({ kind: 'PRODUCT_QTY', productId: 'p1', targetValue: '0' })), 'كمية الهدف رقم أكبر من صفر');

  // التحصيل: نسبة > 0 و≤ 100
  assert.equal(draftProblem(draft({ kind: 'COLLECTION_PCT', targetValue: '100' })), null);
  assert.equal(draftProblem(draft({ kind: 'COLLECTION_PCT', targetValue: '100.5' })), 'نسبة التحصيل أكبر من صفر وحتى 100');
  assert.equal(draftProblem(draft({ kind: 'COLLECTION_PCT', targetValue: '0' })), 'نسبة التحصيل أكبر من صفر وحتى 100');

  // المكافأة: العمولة ≤ 100 · الراتب ≤ 1000 · المبلغ ≤ 1e9، وكلها > 0
  assert.equal(draftProblem(draft({ rewardValue: '100' })), null);
  assert.equal(draftProblem(draft({ rewardValue: '101' })), 'نسبة العمولة أكبر من صفر وحتى 100');
  assert.equal(draftProblem(draft({ rewardValue: '0' })), 'نسبة العمولة أكبر من صفر وحتى 100');
  assert.equal(draftProblem(draft({ rewardKind: 'SALARY_PCT', rewardValue: '1000' })), null, 'نسبة الراتب قد تتجاوز ١٠٠٪');
  assert.equal(draftProblem(draft({ rewardKind: 'SALARY_PCT', rewardValue: '1001' })), 'نسبة الراتب أكبر من صفر وحتى 1000');
  assert.equal(draftProblem(draft({ rewardKind: 'FIXED_AMOUNT', rewardValue: '1000000000' })), null);
  assert.equal(draftProblem(draft({ rewardKind: 'FIXED_AMOUNT', rewardValue: '1000000001' })), 'مبلغ المكافأة كبير جدا');
  assert.equal(draftProblem(draft({ rewardKind: 'FIXED_AMOUNT', rewardValue: '' })), 'مبلغ المكافأة رقم أكبر من صفر');

  assert.equal(draftProblem(draft({ note: `  ${'م'.repeat(300)}  ` })), null, 'المسافات حول الملاحظة لا تُحسب');
  assert.equal(draftProblem(draft({ note: 'م'.repeat(301) })), 'الملاحظة 300 حرف على الأكثر');

  // الأرقام العربية والفاصلة العشرية العربية تُقرأ
  assert.equal(draftProblem(draft({ targetValue: '١٥٠٠٠', rewardValue: '٢٫٥' })), null);
  assert.equal(MAX_TARGETS_PER_MONTH, 20);
});

test('readNum وcleanDecimal: الأرقام الهندية والفاصلة نقطةٌ عشرية كخانة DecimalInput، والدخيل لا يُكتب', () => {
  assert.equal(readNum('١٢٫٥'), 12.5);
  assert.equal(readNum('12,5'), 12.5);
  assert.equal(readNum(''), null);
  assert.ok(Number.isNaN(readNum('ab')));
  assert.equal(cleanDecimal('١٢٫٥'), '12.5');
  assert.equal(cleanDecimal('12a'), null, 'حرفٌ دخيل يُتجاهل');
  assert.equal(cleanDecimal('1.2.3'), null);
  assert.equal(cleanDecimal(''), '');
});

test('toTargetInput: الكمية كما كُتبت بوحدة الهدف (الخادم يضرب بالمعامل) ووحدة الأساس null، وغير الكمية بلا صنفٍ ولا وحدة', () => {
  const qty = draft({ kind: 'PRODUCT_QTY', productId: 'p1', unitId: 'u-carton', targetValue: '10', note: '  ركّز على الماء  ' });
  assert.deepEqual(toTargetInput(qty, carton), {
    month: '2026-11', kind: 'PRODUCT_QTY', targetValue: 10, productId: 'p1', unitId: 'u-carton',
    rewardKind: 'COMMISSION_SALES_PCT', rewardValue: 2, note: 'ركّز على الماء',
  });
  assert.equal(toTargetInput(qty, carton).targetValue, 10, '١٠ كراتين تُرسل ١٠ لا ٢٤٠ — الضرب في الخادم مرّةً واحدة');
  assert.equal(toTargetInput(qty, piece).unitId, null, 'وحدة الأساس = unitId null');
  const sales = toTargetInput(draft({ productId: 'p-stale', unitId: 'u-stale', note: '   ', targetValue: '٥٠٠٠٠' }), carton);
  assert.equal(sales.productId, null);
  assert.equal(sales.unitId, null);
  assert.equal(sales.note, null, 'الملاحظة الفارغة null');
  assert.equal(sales.targetValue, 50000);
  // نموذج التعديل يعود بالقيم نفسها
  const t = view({ kind: 'PRODUCT_QTY', productId: 'p1', productName: 'ماء', unitId: 'u-carton', unitName: 'كرتون', unitFactor: 24, targetValue: 10, note: 'م' });
  assert.deepEqual(toTargetInput(draftOf(t), carton), { ...toTargetInput(qty, carton), note: 'م' });
  // أساس الصنف كما رآه النموذج (حارس الخادم من كاشٍ قديم): لهدف الكمية وحده وحين يُعرف
  assert.equal(toTargetInput(qty, piece, 'حبة').baseUnitName, 'حبة');
  assert.equal(toTargetInput(qty, carton, '  حبة ').baseUnitName, 'حبة');
  assert.equal('baseUnitName' in toTargetInput(qty, carton, null), false, 'الصنف لم يُحمَّل ⇒ بلا الحقل (مسار الخادم كما كان)');
  assert.equal('baseUnitName' in toTargetInput(qty, carton, '  '), false);
  assert.equal('baseUnitName' in toTargetInput(draft(), null, 'حبة'), false, 'غير الكمية بلا أساس');
});

test('barPct: ٠–١٠٠ للشريط والنسبة غير مسقوفة من الخادم، وnull وNaN صفر', () => {
  assert.equal(barPct(null), 0);
  assert.equal(barPct(undefined), 0);
  assert.equal(barPct(Number.NaN), 0);
  assert.equal(barPct(-5), 0);
  assert.equal(barPct(42.5), 42.5);
  assert.equal(barPct(150), 100);
  assert.equal(pctText(null, 'en-US'), '—');
  assert.equal(pctText(42.5, 'en-US'), '42.5%');
});

test('rewardText: عمولة بمبلغها من الخادم، ونسبة الراتب نصّاً فقط، والمبلغ المحدد', () => {
  assert.equal(rewardText(view(), arTr, money), 'عمولة 2% من المبيعات ≈ 400.00 ر.س');
  assert.equal(rewardText(view({ reward: { kind: 'COMMISSION_SALES_PCT', value: 2, amount: null, earned: false } }), arTr, money), 'عمولة 2% من المبيعات',
    'بلا مبلغٍ (معاينة النموذج) النسبة وحدها');
  assert.equal(rewardText(view({ rewardKind: 'SALARY_PCT', rewardValue: 10, reward: { kind: 'SALARY_PCT', value: 10, amount: null, earned: true } }), arTr, money),
    'يستحق 10% من الراتب');
  assert.equal(rewardText(view({ rewardKind: 'FIXED_AMOUNT', rewardValue: 500, reward: { kind: 'FIXED_AMOUNT', value: 500, amount: 500, earned: false } }), arTr, money),
    'مكافأة 500.00 ر.س');
  // الإنجليزية من القاموس بأرقامها
  const en = (s: string) => PHRASES[s]?.en ?? s;
  assert.equal(rewardText(view({ rewardKind: 'SALARY_PCT', rewardValue: 10 }), en, money), 'Earns 10% of salary');
});

test('shiftMonth عبر السنوات، وmonthLabel بتوقيت UTC، والشهر التالف كما هو', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-11', 14), '2028-01');
  assert.equal(shiftMonth('2026-11', -24), '2024-11');
  assert.equal(shiftMonth('2026-11', 0), '2026-11');
  assert.equal(shiftMonth('bad', 1), 'bad');
  assert.equal(monthLabel('2026-11', 'en-US'), 'November 2026');
  assert.ok(monthLabel('2026-01', 'ar-SA-u-nu-latn').includes('2026'), 'يناير لا ينزلق إلى ديسمبر في أي منطقة');
  assert.equal(monthLabel('2026-13', 'en-US'), '2026-13');
});

test('targetTitle وقيم الهدف: المبيعات والتحصيل مالٌ، والكمية رقمٌ ومعه اسم وحدة الهدف', () => {
  assert.equal(targetTitle(view(), arTr), 'مبيعات الشهر');
  assert.equal(targetTitle(view({ kind: 'PRODUCT_QTY', productName: 'ماء ٣٣٠', unitName: 'كرتون' }), arTr), 'ماء ٣٣٠ — كرتون');
  assert.equal(targetTitle(view({ kind: 'PRODUCT_QTY', productName: null, unitName: null }), arTr), 'صنف محذوف');
  assert.equal(targetTitle(view({ kind: 'COLLECTION_PCT', targetValue: 50 }), arTr), 'تحصيل 50% من الديون السابقة');

  const qty = view({ kind: 'PRODUCT_QTY', unitName: 'كرتون' });
  assert.equal(targetAmountText(qty, 12.5, money), '12.5 كرتون', 'الكمية بلا وحدةٍ تُقرأ حبّاتٍ');
  assert.equal(targetAmountText(view(), 1500, money), '1500.00 ر.س');
  assert.equal(targetAmountText(view({ kind: 'COLLECTION_PCT' }), 300, money), '300.00 ر.س', 'هدف التحصيل مبلغٌ = الأساس × النسبة');
  assert.equal(targetRemaining({ achieved: 20000, goal: 50000 }), 30000);
  assert.equal(targetRemaining({ achieved: 60000, goal: 50000 }), 0, 'لا متبقٍّ سالب');
  assert.equal(targetStateText({ state: 'OK' }), null);
  assert.equal(targetStateText({ state: 'NO_BASE' }), 'لا توجد ديون سابقة مفتوحة في بداية الشهر');
  assert.equal(targetStateText({ state: 'PRODUCT_DELETED' }), 'الصنف محذوف');
});

test('daysLeftText: العربية بتمييز العدد، وغيرها بالقاموس، والصفر بلا نصّ', () => {
  assert.equal(daysLeftText(1, 'ar', arTr), 'متبقي يوم واحد');
  assert.equal(daysLeftText(2, 'ar', arTr), 'متبقي يومان');
  assert.equal(daysLeftText(5, 'ar', arTr), 'متبقي 5 أيام');
  assert.equal(daysLeftText(21, 'ar', arTr), 'متبقي 21 يوماً');
  assert.equal(daysLeftText(0, 'ar', arTr), '');
  assert.equal(daysLeftText(21, 'en', s => PHRASES[s]?.en ?? s), '21 days left');
});

test('targetErrorMessage: رموز الخادم مترجمة، وإلا رسالته، وإلا البديل', () => {
  const err = (data: unknown) => ({ response: { data } });
  assert.equal(targetErrorMessage(err({ code: 'TARGET_LIMIT', message: 'x' }), arTr, 'ف'), 'وصلت للحد الأعلى من الأهداف لهذا الشهر (20)');
  assert.equal(targetErrorMessage(err({ code: 'TARGET_UNIT_INVALID' }), s => PHRASES[s]?.en ?? s, 'f'), 'Invalid item unit');
  assert.equal(targetErrorMessage(err({ message: 'رسالة الخادم' }), arTr, 'ف'), 'رسالة الخادم', 'أخطاء التحقق ٤٠٠ برسالتها');
  assert.equal(targetErrorMessage(new Error('net'), arTr, 'تعذر الحفظ'), 'تعذر الحفظ');
  assert.equal(targetErrorMessage(null, arTr, 'ف'), 'ف');
  for (const code of ['REP_NOT_FOUND', 'TARGET_NOT_FOUND', 'TARGET_PRODUCT_INVALID', 'TARGET_UNIT_INVALID', 'TARGET_LIMIT']) assert.ok(TARGET_ERRORS[code], code);
  // حارس أساس الصنف: كاشٌ قديم (400) وتحويلٌ أثناء الحفظ (409) ⇒ راجع الوحدة، والانتظار (503) ⇒ أعد المحاولة — بالترجمة لا برسالة الخادم العربية
  assert.equal(targetErrorMessage(err({ code: 'UNIT_INVALID', message: 'تغيّرت وحدات «ماء»' }), arTr, 'ف'), 'تغيرت وحدات الصنف راجع الوحدة ثم احفظ');
  assert.equal(targetErrorMessage(err({ code: 'PRODUCT_UNITS_CHANGED' }), arTr, 'ف'), 'تغيرت وحدات الصنف راجع الوحدة ثم احفظ');
  assert.equal(targetErrorMessage(err({ code: 'PRODUCT_UNITS_BUSY' }), s => PHRASES[s]?.en ?? s, 'f'), 'The item’s units are being updated. Try again in a moment');
  assert.equal(targetErrorCode(err({ code: 'TARGET_NOT_FOUND' })), 'TARGET_NOT_FOUND');
  assert.equal(targetErrorCode(err({ message: 'x' })), undefined);
  assert.equal(targetErrorCode(new Error('net')), undefined);
});

test('targetsFetchDue: أول مرة، وبعد مستندٍ أو مزامنة (refreshKey)، وبعد ٣٠ ثانية — وإلّا تكفي المحفوظة', () => {
  assert.equal(targetsFetchDue(null, 0, 1000), true);
  assert.equal(targetsFetchDue({ at: 1000, key: 0 }, 0, 1000 + 29_999), false, 'تبديل تبويبٍ سريع لا يطلب');
  assert.equal(targetsFetchDue({ at: 1000, key: 0 }, 0, 1000 + 30_000), true);
  assert.equal(targetsFetchDue({ at: 1000, key: 0 }, 1, 1001), true, 'صدر مستند ⇒ جلبٌ فوري');
  assert.equal(targetsFetchDue({ at: 5000, key: 0 }, 0, 1000), true, 'ساعةٌ رجعت للخلف لا تحبس الجلب');
});

test('القاموس: كل عبارةٍ تنتجها الوحدة وكل tr في النافذة والبطاقة بلغاتها الأربع ومواضعها {..}', () => {
  const keys = new Set<string>(REP_TARGET_TEXTS);
  for (const k of TARGET_KINDS) assert.ok(keys.has(k.label), k.label);
  for (const k of REWARD_KINDS) assert.ok(keys.has(k.label), k.label);
  const files = [read('components', 'RepTargetsModal.tsx'), read('rep', 'RepTargetsCard.tsx'), read('lib', 'repTargets.ts')];
  let literals = 0;
  for (const f of files) for (const m of f.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)) { keys.add(m[1]); literals += 1; }
  assert.ok(literals > 40, `قُرئت ${literals} عبارة فقط`);
  for (const k of keys) {
    const e = PHRASES[k];
    assert.ok(e, `غير موجودة في القاموس: ${k}`);
    for (const lang of LANGS) {
      assert.ok(e[lang]?.trim(), `${k} بلا ${lang}`);
      for (const ph of k.match(/\{\w+\}/g) ?? []) assert.ok(e[lang].includes(ph), `${k} (${lang}) بلا ${ph}`);
    }
  }
  // لا ذكر للضريبة في الميزة (وضع «إزالة الضريبة»)
  for (const k of keys) assert.doesNotMatch(k, /ضريب/, k);
});

test('صفحة المناديب: أيقونة «هدف الشهر» أوّل الإجراءات بعَلَم المحاسبة، وتفتح نافذة الأهداف', () => {
  const page = read('pages', 'SalesRepsPage.tsx');
  assert.match(page, /import \{[^}]*\bTarget\b[^}]*\} from 'lucide-react';/);
  assert.ok(page.includes("import RepTargetsModal from '../components/RepTargetsModal';"));
  assert.ok(page.includes('const [targetsRep, setTargetsRep] = useState<SalesRep | null>(null);'));
  const btn = "{accountingOn && (\n                        <button onClick={() => setTargetsRep(r)} className=\"p-1.5 hover:bg-[#FBEBE2] rounded text-[#E15A30]\" title={tr('هدف الشهر')} aria-label={tr('هدف الشهر')}><Target size={14} /></button>\n                      )}";
  const at = page.indexOf(btn);
  assert.ok(at > 0, 'الزرّ محروسٌ بـaccountingOn');
  assert.ok(at < page.indexOf('onClick={() => setCollectRep(r)}'), 'قبل زرّ استلام التحصيل');
  assert.ok(page.includes('{targetsRep && <RepTargetsModal rep={targetsRep} onClose={() => setTargetsRep(null)} />}'));
  // النافذة: مفاتيح react-query وإبطالها، وحذفٌ بتأكيد، وإغلاق الخلفية الآمن
  const modal = read('components', 'RepTargetsModal.tsx');
  assert.ok(modal.includes("queryKey: ['rep-targets', rep.id, month],"));
  assert.equal(modal.match(/qc\.invalidateQueries\(\{ queryKey: \['rep-targets', rep\.id\] \}\)/g)?.length, 2, 'الحفظ والحذف يبطلان أشهر المندوب');
  assert.ok(modal.includes('{...backdropClose(onClose)}'));
  assert.ok(modal.includes('<ConfirmDialog'));
  assert.ok(modal.includes("queryKey: ['products-min'],"), 'كاش الأصناف المشترك');
  assert.ok(modal.includes('choiceById(product, d.unitId)') && modal.includes('defaultChoice(p).id'), 'وحدة الصنف من repUnits');
  // أساس الصنف المحمَّل يُرسل مع هدف الكمية، ورفض الحارس يعيد جلب الأصناف
  assert.ok(modal.includes('onSave(toTargetInput(d, choice, product?.unit ?? null));'));
  assert.ok(modal.includes("if (isStaleUnitsError(e)) void qc.invalidateQueries({ queryKey: ['products-min'] });"));
  // تعذّر قائمة الأصناف (بلا صلاحية الأصناف) يُقال تحت المنتقي لا قائمةٌ فارغة صامتة
  assert.ok(modal.includes("prodStatus === 403 ? tr('اختيار الصنف يحتاج صلاحية إدارة الأصناف')"));
  assert.ok(modal.includes('{productsError && ('));
  // هدفٌ يُعدَّل اختفى من القائمة ⇒ يُغلق نموذجه فلا تبقى الأزرار معطّلة
  assert.ok(modal.includes("if (editing && editing !== 'new' && data && !q.isPlaceholderData && !data.targets.some(t => t.id === editing)) setEditing(null);"));
  const client = read('api', 'client.ts');
  assert.ok(client.includes('export const repTargetsApi = {'));
  for (const s of ["api.get(`/rep-targets/rep/${repId}`", "api.post(`/rep-targets/rep/${repId}`, body)", "api.put(`/rep-targets/${id}`, body)", "api.delete(`/rep-targets/${id}`)"]) {
    assert.ok(client.includes(s), s);
  }
});

test('تطبيق المندوب: بطاقة «هدف الشهر» في الرئيسية بعد خط السير، تُحفظ وتُعرض بلا اتصال، ومحروسةٌ بالمحاسبة', () => {
  const app = read('rep', 'RepApp.tsx');
  const home = app.slice(app.indexOf('function RepHome('), app.indexOf('function RepCustomers('));
  assert.ok(home.length > 1000, 'RepHome موجودة');
  assert.ok(home.includes('{accountingOn && targets && <RepTargetsCard data={targets} stale={targetsStale} onRetry={() => { void loadTargets(true); }} />}'));
  assert.ok(home.includes("await cacheSet('rep-targets', data);"));
  assert.ok(home.includes("cacheGet<RepTargetsData>('rep-targets')"));
  // المحفوظة المعروضة قبل جلبٍ جارٍ موسومةٌ بزمنها (لا تقدّم الأمس كأنه اللحظة)، و«تحديث» الإحصائيات يحدّث الأهداف أيضاً
  assert.ok(home.includes('if (cached?.data) { setTargets(cached.data); setTargetsStale(due ? cached.updatedAt : null); }'));
  assert.ok(home.includes('onClick={() => { void load(); void loadTargets(true); }}'));
  assert.ok(read('rep', 'RepTargetsCard.tsx').includes('{onRetry && <button type="button" onClick={onRetry}'), 'البطاقة الموسومة تُحدَّث وحدها');
  assert.ok(home.includes('if (!accountingOn) { setTargets(null); setTargetsStale(null); return; }'), 'لا طلب والمحاسبة مطفأة');
  assert.ok(home.indexOf('<RepTargetsCard') > home.indexOf("onClick={() => onQuick('route')}"), 'بعد بطاقة خط السير');
  assert.ok(home.indexOf('<RepTargetsCard') < home.indexOf("{tr('إحصائيات اليوم')}"), 'قبل إحصائيات اليوم');
  // السطر المحروس لم يتغيّر (repRoutesFixes.test.ts)
  assert.match(app, /await cacheSet\('rep-home-stats', fresh\);\s*\n\s*loadRoute\(\);/);
  assert.ok(app.includes('<RepHome key={refreshKey} refreshKey={refreshKey} '), 'الرئيسية تعرف مفتاح تحديثها');
  const fetcher = read('rep', 'repTargetsFetch.ts');
  assert.ok(fetcher.includes("repApi.get('/rep-targets/mine', { background: true })"), 'طلبٌ خلفيّ لا يُخرج المندوب');
});
