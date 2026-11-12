// «هدف الشهر» — إصلاحات التدقيق (١٢ نوفمبر ٢٠٢٦) في الواجهة: الصنف الأول المحذوف (F11)، ومنتقي الصنف بعد الألف (F12)، وسباق
// الخروج في تطبيق المندوب (F13)، ومفرد «يوم» (F14)، ولا «١٠٠٪» قبل التحقق (F2/F8)، وتغيّر حجم الوحدة بعد إنشاء الهدف (F4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REP_TARGET_TEXTS, barPct, daysLeftText, draftOf, draftProblem, pctText, pickerSearchDropped, productPickerOptions, shownPct, toTargetInput,
  unitDriftText, unitFactorDrifts, unitRefreshFlag, type RepTargetProductView, type RepTargetView, type RepTargetsData,
} from './repTargets';
import type { UnitChoice } from '../rep/repUnits';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const en = (s: string) => PHRASES[s]?.en ?? s;
const fr = (s: string) => PHRASES[s]?.fr ?? s;

const prod = (productId: string | null, productName: string | null, unitName: string | null, unitId: string | null = null, unitFactor = 1,
  currentUnitFactor?: number | null): RepTargetProductView => ({ productId, productName, unitId, unitName, unitFactor, currentUnitFactor });

const view = (over: Partial<RepTargetView> = {}): RepTargetView => ({
  id: 't1', month: '2026-11', kind: 'PRODUCT_QTY', targetValue: 30, productId: null, productName: 'ماء', unitId: 'u-a', unitName: 'كرتون',
  unitFactor: 24, rewardKind: 'FIXED_AMOUNT', rewardValue: 500, note: null, createdByName: 'المدير', createdAt: '2026-11-01T08:00:00Z',
  updatedAt: '2026-11-01T08:00:00Z',
  progress: { state: 'OK', achieved: 10, goal: 30, pct: 33.3, done: false },
  reward: { kind: 'FIXED_AMOUNT', value: 500, amount: 500, earned: false },
  ...over,
});

test('F11: الصنف الأول المحذوف ⇒ أول صنفٍ باقٍ يصعد إلى السطر الأول بوحدته، والباقي بوحداته، فيُحفظ النموذج', () => {
  const t = view({
    productId: null, productName: 'ماء', unitId: 'u-a', unitName: 'كرتون', unitFactor: 24,
    products: [prod(null, 'ماء', 'كرتون', 'u-a', 24), prod('pB', 'عصير', 'علبة', 'u-b', 6), prod('pC', 'حليب', 'حبة')],
  });
  const d = draftOf(t);
  assert.equal(d.productId, 'pB', 'الباقي الأول في السطر الأول');
  assert.equal(d.unitId, 'u-b', 'بوحدته هو لا الأساس ولا وحدة المحذوف');
  assert.deepEqual(d.extraProducts, [{ productId: 'pC', unitId: null }], 'الباقي بعده بوحدته');
  assert.equal(draftProblem(d), null, 'لا «اختر صنفاً صحيحاً» لتعديل المكافأة وحدها');
  // الجسم: الصنفان الباقيان بالترتيب ووحدتيهما — المحذوف يسقط من الهدف
  const box: UnitChoice = { id: 'u-b', name: 'علبة', factor: 6, price: null };
  const piece: UnitChoice = { id: null, name: 'حبة', factor: 1, price: null };
  assert.deepEqual(toTargetInput(d, box, null, [{ productId: 'pC', unit: piece }]).products,
    [{ productId: 'pB', unitId: 'u-b' }, { productId: 'pC', unitId: null }]);

  // محذوفٌ في الوسط كما كان: يسقط ويبقى الأول
  const mid = draftOf(view({ productId: 'pA', products: [prod('pA', 'ماء', 'كرتون', 'u-a', 24), prod(null, 'عصير', 'علبة'), prod('pC', 'حليب', 'حبة')] }));
  assert.equal(mid.productId, 'pA');
  assert.equal(mid.unitId, 'u-a');
  assert.deepEqual(mid.extraProducts, [{ productId: 'pC', unitId: null }]);
  // كلها محذوفة ⇒ منتقٍ فارغ (هدفٌ ميت)، وخادمٌ أقدم بلا products وصنفه محذوف كذلك
  const dead = draftOf(view({ productId: null, products: [prod(null, 'ماء', 'كرتون', 'u-a', 24), prod(null, 'عصير', 'علبة')] }));
  assert.equal(dead.productId, null);
  assert.equal(dead.unitId, null, 'لا وحدةٌ يتيمة بلا صنف');
  assert.deepEqual(dead.extraProducts, []);
  const old = draftOf(view({ productId: null, unitId: 'u-a' }));
  assert.equal(old.productId, null);
  assert.equal(old.unitId, null);
  // صنفٌ واحد حيّ (خادمٌ أقدم) كما كان
  const one = draftOf(view({ productId: 'pA', unitId: 'u-a' }));
  assert.equal(one.productId, 'pA');
  assert.equal(one.unitId, 'u-a');
});

test('F12: خيارات المنتقي — القائمة المحمَّلة تُصفّى محلياً، وبحث الخادم يُضاف إليها، وصنف السطر حاضرٌ دائماً بلا تكرار', () => {
  type O = { value: string; label: string; hint?: string };
  const loaded: O[] = [{ value: 'a', label: 'Apple', hint: 'A1' }, { value: 'b', label: 'Banana', hint: 'B1' }, { value: 'c', label: 'Cherry' }];
  const none = new Set<string>();
  assert.deepEqual(productPickerOptions(loaded, '', null, none, null).map(o => o.value), ['a', 'b', 'c']);
  assert.deepEqual(productPickerOptions(loaded, ' an ', null, none, null).map(o => o.value), ['b'], 'تصفيةٌ محلية حتى يصل ردّ الخادم');
  assert.deepEqual(productPickerOptions(loaded, 'b1', null, none, null).map(o => o.value), ['b'], 'وبالكود كالمنتقي');
  // ردّ الخادم لما كُتب يُضاف إلى المحمَّلة: الصنف ١٠٠١ بالاسم يظهر
  const remote: O[] = [{ value: 'z1001', label: 'Zucchini' }, { value: 'b', label: 'Banana' }];
  assert.deepEqual(productPickerOptions(loaded, 'zu', remote, none, null).map(o => o.value), ['z1001', 'b']);
  // أصناف الأسطر الأخرى لا تُعرض — في المحمَّلة وفي نتائج البحث
  assert.deepEqual(productPickerOptions(loaded, '', null, new Set(['a']), null).map(o => o.value), ['b', 'c']);
  assert.deepEqual(productPickerOptions(loaded, 'zu', remote, new Set(['b']), null).map(o => o.value), ['z1001']);
  // صنف السطر (لقطة هدفٍ معدَّل خارج القائمة) أولاً فيظهر اسمه لا «اختر الصنف»، ولا يتكرر إن كان فيها
  const snap: O = { value: 'far', label: 'صنف بعيد' };
  assert.deepEqual(productPickerOptions(loaded, '', null, none, snap).map(o => o.value), ['far', 'a', 'b', 'c']);
  assert.deepEqual(productPickerOptions(loaded, 'zu', remote, none, snap).map(o => o.value), ['far', 'z1001', 'b'], 'ولو لم يطابق البحث');
  assert.deepEqual(productPickerOptions(loaded, '', null, none, loaded[1]).map(o => o.value), ['a', 'b', 'c']);

  // التوصيل: بحث الخادم حين تبلغ القائمة حجم صفحتها، والمختار منه يُحفظ بصفّه، واسم اللقطة في المنتقي نفسه
  const modal = read('components', 'RepTargetsModal.tsx');
  assert.ok(modal.includes('const PRODUCTS_PAGE = 1000;'));
  assert.ok(modal.includes('queryFn: async () => (await productApi.list({ limit: PRODUCTS_PAGE })).data.data as ProductPick[],'), 'الكاش المشترك كما كان');
  assert.ok(modal.includes('const searchable = products.length >= PRODUCTS_PAGE;'));
  assert.ok(modal.includes("queryKey: ['rep-target-product-search', q],"));
  assert.ok(modal.includes('queryFn: async () => (await productApi.list({ search: q, limit: 50 })).data.data as ProductPick[],'));
  assert.ok(modal.includes('enabled: searchable && q !== \'\','), 'لا طلب بحثٍ والقائمة كاملة');
  assert.ok(modal.includes('onSearchChange={searchable ? setTyped : undefined}'));
  assert.ok(modal.includes('onPick(id, live?.find(p => p.id === id));'));
  assert.ok(modal.includes('if (row && !products.some(x => x.id === id)) setFound(prev => ({ ...prev, [id]: row }));'));
  assert.ok(modal.includes('products.find(p => p.id === id) ?? found[id] ?? null'), 'وحدة المختار من البحث وأساسه كالمحمَّل');
  assert.ok(modal.includes(': line.productId && line.snapName ? { value: line.productId, label: line.snapName } : null;'));
  // اختيار الصنف نفسه ثانيةً لا يبدّل وحدته (لقطته صارت خياراً في المنتقي)
  assert.ok(modal.includes('if (id === d.productId) return;') && modal.includes('if (id === d.extraProducts[i]?.productId) return;'));
});

test('R2: بحث الخادم يُدمج مع المطابقات المحلية ولا يحلّ محلّها — صنفٌ ظاهرٌ محلياً لا يختفي حين يردّ الخادم الحسّاس لحالة الأحرف []', () => {
  type O = { value: string; label: string; hint?: string };
  const loaded: O[] = [
    { value: 'p330', label: 'Pepsi 330', hint: 'P-330 · كرتون' }, { value: 'w', label: 'Water', hint: 'W1 · موقوف' }, { value: 'c', label: 'Cola' },
  ];
  const none = new Set<string>();
  // «pepsi» بحروفٍ صغيرة: الخادم (contains بلا mode insensitive) يردّ [] والمحلي يطابق — يبقى ظاهراً قبل الردّ وبعده
  assert.deepEqual(productPickerOptions(loaded, 'pepsi', null, none, null).map(o => o.value), ['p330'], 'قبل وصول الردّ');
  assert.deepEqual(productPickerOptions(loaded, 'pepsi', [], none, null).map(o => o.value), ['p330'], 'بعد ردٍّ فارغ');
  // بجزءٍ من التلميح (الوحدة أو «موقوف») لا يبحث فيه الخادم
  assert.deepEqual(productPickerOptions(loaded, 'كرتون', [], none, null).map(o => o.value), ['p330']);
  assert.deepEqual(productPickerOptions(loaded, 'موقوف', [], none, null).map(o => o.value), ['w']);
  // نتائج الخادم بعد المحلية (فلا تقفز القائمة حين يصل الردّ)، وما في الاثنين مرةً واحدة بصفّه المحمَّل
  const remote: O[] = [{ value: 'far', label: 'Pepsi 1001' }, { value: 'p330', label: 'Pepsi 330 (server)' }, { value: 'far', label: 'dup' }];
  const merged = productPickerOptions(loaded, 'Pepsi', remote, none, null);
  assert.deepEqual(merged.map(o => o.value), ['p330', 'far'], 'بلا تكرار');
  assert.equal(merged[0].label, 'Pepsi 330', 'المحمَّل أولى');
  assert.equal(merged[1].label, 'Pepsi 1001');
  // وبلا نصٍّ: القائمة المحمَّلة كاملةً ثم ما زاد من الخادم
  assert.deepEqual(productPickerOptions(loaded, '', [{ value: 'far', label: 'Pepsi 1001' }], none, null).map(o => o.value), ['p330', 'w', 'c', 'far']);
  // الأسطر الأخرى تُستبعد من الاثنين، وصنف السطر أولاً بلا تكرار
  assert.deepEqual(productPickerOptions(loaded, 'pepsi', remote, new Set(['p330']), null).map(o => o.value), ['far']);
  assert.deepEqual(productPickerOptions(loaded, 'pepsi', remote, new Set(['far']), null).map(o => o.value), ['p330']);
  assert.deepEqual(productPickerOptions(loaded, 'pepsi', remote, none, { value: 'far', label: 'Pepsi 1001' }).map(o => o.value), ['p330', 'far']);
  assert.deepEqual(productPickerOptions(loaded, 'pepsi', [], none, { value: 'snap', label: 'لقطة' }).map(o => o.value), ['snap', 'p330']);
});

test('R7: إغلاق منتقي الصنف بنقرةٍ خارجه يصفّر نصّ البحث في السطر — مرآة شرط إغلاقه: مفتوحٌ (حقل بحثه مرسوم) والنقرة خارجه', () => {
  const inside = { id: 'option' }, outside = { id: 'unit-select' };
  const root = (open: boolean) => ({
    contains: (n: unknown) => n === inside,
    querySelector: (sel: string) => (sel === 'input' && open ? { id: 'search' } : null),
  });
  assert.equal(pickerSearchDropped(root(true), outside), true, 'مفتوحٌ ونقرةٌ خارجه ⇒ يُصفَّر');
  assert.equal(pickerSearchDropped(root(true), inside), false, 'نقرةٌ داخله (خيارٌ أو حقل البحث) لا تُصفّر');
  assert.equal(pickerSearchDropped(root(false), outside), false, 'مغلقٌ بزرّه يُبقي نصّه في حقله فيبقى في السطر');
  assert.equal(pickerSearchDropped(null, outside), false, 'لا منتقٍ مرسوم');

  // التوصيل في ProductLine: غلافٌ للمنتقي وحده، ومستمعٌ في طور الالتقاط (قبل معالج إغلاقه) ما دام في السطر نصّ، يصفّر typed وq معاً
  const modal = read('components', 'RepTargetsModal.tsx');
  const line = modal.slice(modal.indexOf('function ProductLine('));
  assert.ok(line.includes('const pickerRef = useRef<HTMLDivElement>(null);'));
  assert.ok(line.includes("if (typed === '') return;"));
  assert.ok(line.includes("const h = (e: MouseEvent) => { if (pickerSearchDropped(pickerRef.current, e.target)) { setTyped(''); setQ(''); } };"));
  assert.ok(line.includes("document.addEventListener('mousedown', h, true);"), 'طور الالتقاط');
  assert.ok(line.includes("return () => document.removeEventListener('mousedown', h, true);"));
  assert.match(line, /<div ref=\{pickerRef\}>\n\s*<SearchableSelect options=\{options\}[^\n]*\n[^\n]*\/>\n\s*<\/div>/, 'الغلاف للمنتقي وحده');
  // SearchableSelect المشترك كما هو: يفرّغ حقله عند النقر خارجه بلا onSearchChange — وهذا ما يعالجه السطر
  const select = read('components', 'SearchableSelect.tsx');
  assert.ok(select.includes("setOpen(false); setQ(''); } };"));
});

test('R1: أرقام الإدارة المقيَّدة بالنطاق — ملاحظةٌ تحت الملخّص حين scoped وحده، والعبارة بلغاتها', () => {
  const data: RepTargetsData = { month: '2026-11', from: '', to: '', isCurrent: true, daysLeft: 3, monthNetSales: 0, targets: [], scoped: true };
  assert.equal(data.scoped, true);
  const modal = read('components', 'RepTargetsModal.tsx');
  const note = "{tr('الأرقام ضمن نطاقك وقد تختلف عما يراه المندوب')}";
  const gate = '{data.scoped && (';
  assert.ok(modal.includes(gate), 'بالعلم وحده (غيابه أو false ⇒ لا ملاحظة)');
  const at = modal.indexOf(note);
  assert.ok(at > modal.indexOf("{tr('الأهداف المحققة')}"), 'تحت الملخّص');
  assert.ok(at > modal.indexOf(gate) && at < modal.indexOf("{targets.length === 0 && editing !== 'new' && ("), 'قبل قائمة الأهداف');
  assert.equal(modal.split(note).length - 1, 1);
  assert.equal(en('الأرقام ضمن نطاقك وقد تختلف عما يراه المندوب'), 'Figures are limited to your scope and may differ from what the rep sees');
});

test('F13: ردّ أهدافٍ لجلسةٍ خرجت أو تبدّلت لا يُعتمد، والخروج والدخول يصفّران حدّ الجلب', () => {
  const fetcher = read('rep', 'repTargetsFetch.ts');
  assert.match(fetcher, /export function resetTargetsFetch\(\): void \{\n\s*lastFetch = null;\n\s*session \+= 1;\n\}/);
  assert.ok(fetcher.includes('export function targetsSession(): number {'));
  const app = read('rep', 'RepApp.tsx');
  const load = app.slice(app.indexOf('const loadTargets = useCallback('), app.indexOf('}, [refreshKey]);', app.indexOf('const loadTargets = useCallback(')));
  assert.ok(load.includes('const me = currentRepId(), gen = targetsSession();'), 'المندوب والجيل قبل الطلب');
  assert.ok(load.includes('const gone = () => gen !== targetsSession() || currentRepId() !== me;'));
  // الحارس قبل أي أثر: لا وسم جلبٍ ولا كاش ولا عرض لردّ جلسةٍ سابقة، ولا في الفشل
  const after = load.indexOf('const data = await fetchMyTargets();');
  assert.ok(after > 0);
  const guard = load.indexOf('if (gone()) return;', after);
  assert.ok(guard > after && guard < load.indexOf('markTargetsFetched(refreshKey);') && guard < load.indexOf("await cacheSet('rep-targets', data);"));
  assert.match(load, /\} catch \(e\) \{\n\s*if \(gone\(\)\) return;/);
  // الخروج: قبل مسح الكاش (جلبٌ معلّق لا يكتب بعده)، والدخول أولاً
  const logout = app.slice(app.indexOf('const logout = async () => {'));
  assert.ok(logout.indexOf('resetTargetsFetch();') > 0 && logout.indexOf('resetTargetsFetch();') < logout.indexOf('await refClear();'));
  const login = app.slice(app.indexOf('const login = async (t: string, u: RepUser) => {'));
  assert.ok(login.indexOf('resetTargetsFetch();') > 0 && login.indexOf('resetTargetsFetch();') < login.indexOf('const prev = currentRepId();'));
  assert.ok(app.includes("import { fetchMyTargets, markTargetsFetched, resetTargetsFetch, targetsFetchNeeded, targetsSession } from './repTargetsFetch';"));
});

test('F14: «متبقي يوم واحد» مفردٌ بالإنجليزية والفرنسية، والجمع كما كان، والتركية والصينية والعربية سليمة', () => {
  assert.equal(daysLeftText(1, 'en', en), '1 day left');
  assert.equal(daysLeftText(1, 'fr', fr), '1 jour restant');
  assert.equal(daysLeftText(2, 'en', en), '2 days left');
  assert.equal(daysLeftText(2, 'fr', fr), '2 jours restants');
  assert.equal(daysLeftText(1, 'tr', s => PHRASES[s]?.tr ?? s), '1 gün kaldı');
  assert.equal(daysLeftText(1, 'zh', s => PHRASES[s]?.zh ?? s), '剩余 1 天');
  assert.equal(daysLeftText(1, 'en', en, n => `#${n}`), '#1 day left', 'العدد بأرقام العرض كالجمع');
  assert.equal(daysLeftText(1, 'ar', arTr), 'متبقي يوم واحد');
  assert.equal(daysLeftText(0, 'en', en), '');
  assert.ok(REP_TARGET_TEXTS.includes('متبقي يوم واحد'), 'في حارس القاموس');
});

test('F2/F8: لا «١٠٠٪» ولا شريطٌ ممتلئ لهدفٍ لم يتحقق، والمحقَّق كما هو', () => {
  assert.equal(shownPct(99.96, false), 99.9);
  assert.equal(shownPct(100, false), 99.9, 'نسخةٌ محفوظة قبل إصلاح الخادم');
  assert.equal(shownPct(99.9, false), 99.9);
  assert.equal(shownPct(42.5, false), 42.5);
  assert.equal(shownPct(100, true), 100);
  assert.equal(shownPct(120, true), 120, 'التجاوز للمحقَّق غير مسقوف');
  assert.equal(shownPct(99.96), 99.96, 'بلا done كما كانت');
  assert.equal(shownPct(null, false), null);
  assert.equal(shownPct(Number.NaN, false), null);
  assert.equal(pctText(99.95, 'en-US', false), '99.9%');
  assert.equal(pctText(99.96, 'en-US', false), '99.9%');
  assert.equal(pctText(100, 'en-US', true), '100%');
  assert.equal(pctText(null, 'en-US', false), '—');
  assert.equal(barPct(99.96, false), 99.9);
  assert.equal(barPct(120, true), 100);
  assert.equal(barPct(null, false), 0);
  // البطاقة والنافذة تمرّران حال التحقق في كل موضع نسبة وشريط
  const card = read('rep', 'RepTargetsCard.tsx');
  const modal = read('components', 'RepTargetsModal.tsx');
  assert.equal(card.match(/pctText\(p\.pct, activeLocale\(\), p\.done\)/g)?.length, 2);
  assert.equal(card.match(/barPct\(p\.pct, p\.done\)/g)?.length, 2);
  assert.equal(modal.match(/pctText\(p\.pct, activeLocale\(\), p\.done\)/g)?.length, 1);
  assert.equal(modal.match(/barPct\(p\.pct, p\.done\)/g)?.length, 2, 'الشريط وaria-valuenow');
  for (const f of [card, modal]) assert.doesNotMatch(f, /pctText\(p\.pct, activeLocale\(\)\)|barPct\(p\.pct\)/);
});

test('F4: حجم وحدةٍ تغيّر بعد إنشاء الهدف — تنبيهٌ بالقديم والحالي، وrefreshUnitFactor بقرارٍ صريح وحده', () => {
  const snaps = [prod('pA', 'ماء', 'كرتون', 'u-a', 24, 12), prod('pB', 'عصير', 'علبة', 'u-b', 6, null), prod('pC', 'حليب', 'شدة', 'u-c', 4, 4)];
  const same = [{ productId: 'pA', unitId: 'u-a' }, { productId: 'pB', unitId: 'u-b' }, { productId: 'pC', unitId: 'u-c' }];
  const drifts = unitFactorDrifts(snaps, same);
  assert.deepEqual(drifts, [{ productId: 'pA', productName: 'ماء', unitName: 'كرتون', savedFactor: 24, currentFactor: 12 }],
    'null (لا فرق) والمساوي لا ينبّهان');
  // سطرٌ غيّر وحدته أو صنفه: الخادم يلتقط الحالية على أي حال فلا تنبيه
  assert.deepEqual(unitFactorDrifts(snaps, [{ productId: 'pA', unitId: null }]), []);
  assert.deepEqual(unitFactorDrifts(snaps, [{ productId: 'pZ', unitId: 'u-a' }]), []);
  assert.deepEqual(unitFactorDrifts(snaps, [{ productId: null, unitId: null }]), []);
  // خادمٌ أقدم بلا الحقل، أو قيمةٌ تالفة
  assert.deepEqual(unitFactorDrifts([prod('pA', 'ماء', 'كرتون', 'u-a', 24)], [{ productId: 'pA', unitId: 'u-a' }]), []);
  assert.deepEqual(unitFactorDrifts([prod('pA', 'ماء', 'كرتون', 'u-a', 24, 0)], [{ productId: 'pA', unitId: 'u-a' }]), []);
  // صنفٌ صعد إلى السطر الأول (F11) يُطابَق بمعرّفه لا بموضعه
  assert.equal(unitFactorDrifts([prod(null, 'س', 'كرتون', 'u-x', 10), prod('pA', 'ماء', 'كرتون', 'u-a', 24, 12)], [{ productId: 'pA', unitId: 'u-a' }]).length, 1);

  assert.equal(unitDriftText(drifts[0], arTr, String, 'حبة'), 'ماء: كرتون كان 24 حبة وأصبح 12 حبة');
  assert.equal(unitDriftText(drifts[0], arTr), 'ماء: كرتون كان 24 وأصبح 12', 'الأساس مجهول ⇒ الأرقام وحدها');
  assert.equal(unitDriftText(drifts[0], en, String, 'pc'), 'ماء: كرتون was 24 pc and is now 12 pc');

  assert.deepEqual(unitRefreshFlag(drifts, true), { refreshUnitFactor: true });
  assert.deepEqual(unitRefreshFlag(drifts, false), {}, 'بلا قرارٍ صريح لا يُرسل');
  assert.deepEqual(unitRefreshFlag([], true), {}, 'خانةٌ بقيت مؤشَّرة بعد تبديل الوحدة لا تُرسل');

  // النافذة: التنبيه وخانة الاعتماد، والحقل لا يُرسل إلا عبر unitRefreshFlag
  const modal = read('components', 'RepTargetsModal.tsx');
  assert.ok(modal.includes('const drifts = productKind ? unitFactorDrifts(snaps, [{ productId: d.productId, unitId: d.unitId }, ...d.extraProducts]) : [];'));
  assert.ok(modal.includes("{tr('اعتمد حجم الوحدة الحالي')}") && modal.includes("{tr('تغير حجم الوحدة بعد إنشاء الهدف')}"));
  assert.ok(modal.includes('checked={refreshUnits} onChange={e => setRefreshUnits(e.target.checked)}'));
  assert.ok(modal.includes('const [refreshUnits, setRefreshUnits] = useState(false);'), 'غير مؤشَّرة افتراضياً');
  assert.doesNotMatch(modal, /refreshUnitFactor/, 'لا إرسالٌ مباشر للحقل');
});

test('القاموس: العبارات الجديدة بلغاتها الأربع ومواضعها', () => {
  const keys = ['متبقي يوم واحد', 'تغير حجم الوحدة بعد إنشاء الهدف', '{product}: {unit} كان {old} وأصبح {new}',
    'يبقى الهدف بالحجم القديم ما لم تعتمد الحجم الحالي', 'اعتمد حجم الوحدة الحالي', 'الأرقام ضمن نطاقك وقد تختلف عما يراه المندوب'];
  for (const k of keys) {
    const e = PHRASES[k];
    assert.ok(e, k);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(e[l]?.trim(), `${k} بلا ${l}`);
      for (const ph of k.match(/\{\w+\}/g) ?? []) assert.ok(e[l].includes(ph), `${k} (${l}) بلا ${ph}`);
    }
  }
  // المفرد يحمل {n} في ترجماته كالجمع (العدد بأرقام العرض)
  for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES['متبقي يوم واحد'][l].includes('{n}'), l);
});
