// «الوحدة الرئيسية» — B5a: حرّاس نصّية على شاشات الويب (primary_unit_spec §4.1–٤.3، §5.3، R11، D14-ب، D21):
// نافذة الصنف (طريقتا التعريف والانتقال بينهما و«إضافة وحدة فرعية أصغر» بمعاينةٍ مؤجَّلة)، وقائمة الأصناف بالرئيسية،
// وعلم الشركة في صفحة المنصّة، وتنبيه «وحدة الصنف» في إعدادات الطباعة. والقاعدة الحاكمة: صنفٌ بلا رئيسية كما كان حرفاً (I1).
// B5A_SRC_ROOT (اختياري) يقرأ الشاشات من نسخةٍ أخرى — لإثبات أن الحرّاس تفشل على الشاشات قبل الحزمة
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PHRASES } from '../i18n/strings';

const SRC = process.env.B5A_SRC_ROOT || path.join(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const modal = () => read('components', 'forms', 'ProductModal.tsx');
/** مقطع الدالة `name` حتى الدالة العليا التالية */
const fnBody = (s: string, head: string) => {
  const at = s.indexOf(head);
  assert.ok(at >= 0, `غير موجود: ${head}`);
  const next = s.indexOf('\nfunction ', at + head.length);
  return s.slice(at, next < 0 ? undefined : next);
};
/** قيم كائنٍ ثابت `const NAME … = { … };` في الملف */
const constValues = (s: string, name: string): string[] => {
  const m = s.match(new RegExp(`const ${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert.ok(m, `الثابت ${name} غير موجود`);
  return [...m[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)',/g)].map(x => x[1]);
};
const LANGS = ['en', 'fr', 'tr', 'zh'] as const;
/** العبارة مترجمة بلغاتها الأربع، وكل {عنصر} فيها باقٍ في كل ترجمة (fill يبدّله بعد الترجمة) */
const translated = (ar: string) => {
  const row = PHRASES[ar];
  assert.ok(row, `لا ترجمة: ${ar}`);
  const holes = ar.match(/\{[a-z]+\}/g) ?? [];
  for (const l of LANGS) {
    assert.ok(row[l] && !/[؀-ۿ]/.test(row[l]), `${l} فارغة أو عربية: ${ar}`);
    for (const h of holes) assert.ok(row[l].includes(h), `${l} أسقطت ${h}: ${ar}`);
  }
};

// ─── نافذة الصنف: طريقتا التعريف (§4.1) ───

test('نافذة الصنف: طريقتا التعريف بنصّ مثالٍ، وآخر طريقة لكل مستخدم في المتصفح داخل try/catch', () => {
  const s = modal();
  assert.deepEqual(constValues(s, 'DEF_MODE_LABELS'), [
    'أعرّف الصنف بأصغر وحدة (مثل الحبة)، وأضيف الكرتون وحدةً أكبر',
    'أعرّف الصنف بالكرتون، وفيه وحدة أصغر (مثل الحبة)',
  ]);
  for (const v of constValues(s, 'DEF_MODE_LABELS')) translated(v);
  // مفتاحٌ لكل مستخدم، والقراءة والكتابة محميّتان (نافذة خاصة/تخزين محجوب ⇒ الأولى)، ولا أثر في الخادم
  assert.ok(s.includes('const defModeKey = (userId: string | null | undefined) => `fs.productDefMode.${userId || \'-\'}`;'));
  assert.match(s, /function readDefMode\([^)]*\): DefMode \{\n\s*try \{ return localStorage\.getItem\(defModeKey\(userId\)\) === 'PRIMARY' \? 'PRIMARY' : 'SMALL'; \} catch \{ return 'SMALL'; \}/);
  assert.match(s, /function writeDefMode\([^)]*\): void \{\n\s*try \{ localStorage\.setItem\(defModeKey\(userId\), m\); \} catch/);
  // صنفٌ جديد يبدأ بآخر طريقة، والقائم من رئيسيّه — والاختيار يُحفظ للصنف الجديد وحده
  assert.ok(s.includes("useState<DefMode>(() => (product ? 'SMALL' : readDefMode(userId)))"));
  assert.ok(s.includes('if (!product) { setDefMode(m); writeDefMode(userId, m); return; }'));
  assert.ok(s.includes("const reverseLayout = product ? !!primary : defMode === 'PRIMARY';"));
  // التحكّم فوق خانتي الوحدة والسعر
  assert.ok(s.indexOf('data-def-mode=""') > 0 && s.indexOf('data-def-mode=""') < s.indexOf("register('unit'"));
});

test('نافذة الصنف: الطريقة العكسية تُخفي الوحدة والسعر وتُرسل الإنشاء الذرّي برقعة reverseCreatePayload — ومثال «كرتون فيه 24 قارورة»', () => {
  const s = modal();
  // الخانتان مخفيّتان وrequired مشروط
  assert.ok(s.includes("{...register('unit', { required: !reverseLayout })}"));
  assert.ok(s.includes("{...register('basePrice', { required: !reverseLayout, valueAsNumber: true })}"));
  const rf = s.slice(s.indexOf('data-reverse-form=""'), s.indexOf('{!newReverse && ('));
  for (const k of ["tr('الوحدة الرئيسية')", "tr('الوحدة الفرعية')", "fill(tr('سعر {unit}'), { unit: revPrimaryName })",
    "fill(tr('كم {sub} في {primary}'), { sub: revSubName, primary: revPrimaryName })", "tr('مثال: كرتون فيه 24 قارورة')",
    "fill(tr('سعر {unit} الواحدة'), { unit: revSubName })", "tr('محسوب')", "tr('متقدم')", "tr('قبل الضريبة')", 'data-reverse-preview=""']) {
    assert.ok(rf.includes(k), `خانة النموذج العكسي: ${k}`);
  }
  // التحقق قبل الإرسال، والإنشاء في طلبٍ واحد (لا «احفظ الصنف أولاً» في الوضع العكسي الجديد)، والتعديل برقعة الرئيسية ذرّياً
  assert.ok(s.includes('const problem = reverseFormProblem(rev);'));
  assert.ok(s.includes('...(newReverse ? reverseCreatePayload(rev) : {}),'));
  assert.ok(s.includes('...(reverseLayout && product && primary?.id ? reverseEditPatch(rev, primary.id) : {}),'));
  assert.ok(s.includes('{!newReverse && (\n            <ProductUnitsSection'));
  // كل تعديلٍ لصنفٍ قائم يحمل الأساس كما رآه النموذج (§4.2)
  assert.ok(s.includes('...(product ? { expectedBaseName: savedBase } : {}),'));
  // المحمَّل من «الوحدة الرئيسية» لا يُعاد — والترتيب القائم للمنزوعات باقٍ (حرّاس اللوط والوحدات)
  assert.match(s, /primaryUnitId: _primaryUnitId, baseConvertedAt: _baseConvertedAt, lotTracked: _lotTracked, lotTrackedSince: _lotTrackedSince, units: _units, \.\.\.rest \} = data;/);
  // رمزا الوحدة: الرئيسية والفرعية في «متقدّم» النموذج العكسي، وخانة الرمز العامة للطريقة الأولى وحدها
  assert.match(s, /\{!reverseLayout && \(\n\s*<div className="col-span-2">\n\s*\{\/\*[^*]*\*\/\}\n\s*<label className="label">\{units\.length > 0 \? tr\('كود وحدة الأساس'\)/);
});

test('نافذة الصنف: «قيود المندوب» ترى رئيسية الصنف الجديد بالكرتون وحدةً كبرى — والقائم بوحداته كما كان', () => {
  const s = modal();
  assert.ok(s.includes("? (reverseFormProblem(rev) === null ? [rev.primaryName.trim()] : [])"));
  assert.ok(s.includes(': units.filter((u) => Number(u.factor) > 1 && u.isActive !== false).map((u) => u.name);'));
  assert.ok(s.includes('!(newReverse ? bigNames.length > 0 : hasBigUnit(units))'));
});

// ─── نافذة الصنف: صنفٌ قائم (§4.2) ───

test('صنفٌ قائم: الانتقال إلى «بالكرتون» بخيارين بأسماء وحداته، بلا اختيارٍ مسبق، و(ب) خلف canConvertBase بتلميح سببه', () => {
  const s = modal();
  const sw = s.slice(s.indexOf('data-switch-primary=""'), s.indexOf('data-switch-small=""'));
  assert.ok(sw.includes("fill(tr('اجعل «{unit}» رئيسية (يبقى «{base}» أصغر وحدة)'), { unit: switchUnit.name, base: savedBase })"));
  assert.ok(sw.includes("fill(tr('اجعل «{unit}» رئيسية وأضف وحدة أصغر منها'), { unit: savedBase })"));
  assert.ok(sw.includes('disabled={!canConvertBase}'), 'الخيار (ب) معطّل بلا إذن');
  assert.ok(sw.includes('tr(refusalHint(convertRefusal))'), 'تلميح سبب المنع');
  assert.ok(sw.includes('disabled={modeBusy || switchChoice === null}'), 'المتابعة معطّلة حتى يختار');
  // لا افتراض: كل فتحٍ للانتقال يمسح الاختيار
  assert.ok(s.includes("setSwitchChoice(null);\n    setSwitchAsk(m === 'PRIMARY' ? 'TO_PRIMARY' : 'TO_SMALL');"));
  // (أ) منتقٍ افتراضه أصغر الوحدات الأكبر النشطة
  assert.ok(s.includes('const activeBig = units.filter(u => u.isActive !== false && Number(u.factor) > 1).sort((a, b) => Number(a.factor) - Number(b.factor));'));
  assert.ok(s.includes('const switchUnit = activeBig.find(u => u.id === switchUnitId) ?? activeBig[0] ?? null;'));
  // التبديل علمٌ بمساره بالرئيسية كما رآها النموذج، والعودة بتأكيد ثم unitId: null
  assert.ok(s.includes('productApi.setPrimaryUnit(product.id, { unitId, expectedPrimaryUnitId: primaryUnitId })'));
  assert.ok(s.includes("if (switchChoice === 'EXISTING' && switchUnit) void setPrimary(switchUnit.id);"));
  assert.ok(s.includes("else if (switchChoice === 'CONVERT' && canConvertBase) { closeSwitch(); setConvertOpen(true); }"));
  assert.ok(s.slice(s.indexOf('data-switch-small=""')).includes('onClick={() => void setPrimary(null)}'));
});

test('الإذن: canConvertBase من ردّ الدخول بدل جلسة المالك وحدها، وتلميحات الرفض الأربعة بنصّ المواصفة', () => {
  const s = modal();
  assert.ok(s.includes('useAuthStore(s => s.user?.canConvertBase === true || !!s.impersonating)'));
  assert.ok(s.includes('useAuthStore(s => s.user?.convertBaseRefusalCode ?? null)'));
  assert.doesNotMatch(s, /const ownerSession = useAuthStore/, 'لا إخفاء للزرّ بجلسة المالك وحدها');
  const hints = constValues(s, 'CONVERT_REFUSAL_HINTS');
  assert.deepEqual(hints, [
    'متاحة قريباً لمديري الشركة — اطلبها من الدعم الآن',
    'تخصّ الشركة كلها — لمستخدم غير مقيّد بنطاق',
    'لمستخدم بدور مدير أو مشرف',
    'تتطلّب صلاحيات الأصناف والفواتير ومخزون السيارات معاً',
  ]);
  for (const h of hints) translated(h);
  assert.match(s, /OWNER_ONLY: '[^']+',\n\s*SCOPED_USER: '[^']+',\n\s*ROLE_FORBIDDEN: '[^']+',\n\s*FORBIDDEN: '[^']+',/);
  // زرّ قسم الوحدات ظاهرٌ دائماً لصنفٍ قائم: معطّلٌ بلا إذن مع التلميح
  const sec = fnBody(s, 'function ProductUnitsSection(');
  assert.ok(sec.includes('disabled={busy !== null || !canConvertBase}'));
  assert.ok(sec.includes("{tr('إضافة وحدة فرعية أصغر')}"));
  assert.ok(sec.includes('title={canConvertBase ? undefined : tr(refusalHint(convertRefusal))}'));
});

test('قسم الوحدات: شارة «رئيسية» و«اجعلها الرئيسية» و«وحدة رئيسية» في الإضافة، وexpectedBaseName في كل كتابة، وclearPrimary بتأكيد', () => {
  const sec = fnBody(modal(), 'function ProductUnitsSection(');
  assert.ok(sec.includes("{tr('رئيسية')}") && sec.includes('data-primary-badge=""'));
  assert.ok(sec.includes("title={tr('اجعلها الرئيسية')}") && sec.includes('{!isPrimary && !off && ('));
  assert.ok(sec.includes("{tr('وحدة رئيسية')}") && sec.includes('data-add-make-primary=""'));
  // كتّاب الوحدات يرسلون الأساس كما رآه النموذج (§2.2-د)
  assert.ok(sec.includes('productApi.addUnit(productId, { ...unitFormPayload(adding), ...(addPrimary && { makePrimary: true }), expectedBaseName: baseUnit })'));
  assert.ok(sec.includes('productApi.updateUnit(productId, u.id, { ...unitFormPayload(editing), expectedBaseName: baseUnit })'));
  assert.ok(sec.includes('{ isActive: u.isActive === false, expectedBaseName: baseUnit }'));
  // D13: إيقاف الرئيسية أو حذفها بتأكيدٍ صريح ثم clearPrimary — لا إلغاء صامت
  assert.ok(sec.includes("window.confirm(`${tr('هذه الوحدة الرئيسية — سيُلغى كونها رئيسية ثم تُوقَف')} — ${u.name}`)"));
  assert.ok(sec.includes('{ isActive: false, clearPrimary: true, expectedBaseName: baseUnit }'));
  assert.ok(sec.includes("tr('هذه الوحدة الرئيسية — سيُلغى كونها رئيسية ثم تُحذف')"));
  assert.ok(sec.includes('productApi.removeUnit(productId, u.id, { clearPrimary: true })'));
  // ٤٠٩ «تغيّرت وحدات الصنف» ⇒ «أعد فتحه» وإعادة الجلب لا رسالةٌ عمياء
  assert.ok(sec.includes('if (isUnitsStale(err)) void onStale();'));
  // ورسالة الخادم (unitProblem فيها «الأساس») ببديلها لصنفٍ له رئيسية — وبلاها كما هي (shown)
  assert.ok(sec.includes('else toast.error(tr(shown(serverMessage(err) || fallback)));'));
  // و«قيود المندوب» المحفوظة قبل حذف وحدة: PUT كغيره يحمل الأساس كما رآه النموذج (§4.2)
  assert.match(modal(), /productApi\.update\(product\.id, \{ repSaleAllowed: saleOn, repReturnAllowed: returnOn, repSaleUnit, repReturnUnit, expectedBaseName: savedBase \}\)/);
  // العنوان الفرعي للصنف ذي الرئيسية، والقائم بلاها حرفاً (I1)
  assert.ok(sec.includes("{fill(tr('الحساب الداخلي بوحدة {unit}'), { unit: baseUnit })}"));
  assert.ok(sec.includes("{tr('وحدة الأساس')}: <b className=\"text-gray-700\">{baseUnit}</b> — {tr('أصغر ما يباع من الصنف وكل وحدة أكبر تعرف بعدد وحدات الأساس فيها')}"));
});

test('٤٠٩ «تغيّرت وحدات الصنف»: الرموز الثلاثة تعيد الجلب برسالة المواصفة — في النافذة وفي صفحة الأصناف', () => {
  const s = modal();
  assert.ok(s.includes("const UNITS_STALE_CODES = new Set(['BASE_UNIT_CHANGED', 'PRIMARY_UNIT_CHANGED', 'PRIMARY_UNIT_IN_USE']);"));
  assert.ok(s.includes("const UNITS_STALE_MSG = 'تغيّرت وحدات الصنف — أعد فتحه';"));
  assert.ok(s.includes('try { adopt((await productApi.get(product.id)).data.data as Product); }'));
  const page = read('pages', 'ProductsPage.tsx');
  assert.ok(page.includes("if (selected && (code === 'BASE_UNIT_CHANGED' || code === 'PRIMARY_UNIT_CHANGED')) {"));
  assert.ok(page.includes("toast.error(tr('تغيّرت وحدات الصنف — أعد فتحه'));"));
  assert.ok(page.includes('key={`${selected?.id ?? \'new\'}:${modalKey}`}'), 'النافذة تُعاد بالصنف الجديد');
});

// ─── «إضافة وحدة فرعية أصغر» (§4.3) ───

test('«إضافة وحدة فرعية أصغر»: معاينة dryRun بعد ٤٠٠ms حين تصحّ الخانتان، والتنفيذ معطّلٌ حتى معاينةٍ بالقيم نفسها', () => {
  const d = fnBody(modal(), 'function ConvertBaseDialog(');
  assert.ok(d.includes("{tr('إضافة وحدة فرعية أصغر')}"), 'الاسم الجديد عنواناً');
  // المعاينة: مؤجَّلة ومشروطة بصحّة الخانات، ولا تُطلب عند الفتح (الخانات فارغة ⇒ problem)
  assert.ok(d.includes('if (problem) { setPreviewing(false); return; }'));
  assert.match(d, /const t = setTimeout\(async \(\) => \{[\s\S]*?productApi\.convertBase\(productId, \{ \.\.\.body\(\), dryRun: true \}\)[\s\S]*?\}, 400\);\n\s*return \(\) => clearTimeout\(t\);/);
  assert.ok(d.includes('}, [formKey, previewNonce]);'));
  // ردٌّ متأخّر لقيمٍ سابقة لا يُعتمد
  assert.ok(d.includes('if (mySeq !== seq.current) return;'));
  // مفتاح المعاينة يشمل كل ما يُرسل — وأي تعديلٍ يُبطلها
  assert.ok(d.includes('const formKey = JSON.stringify([form.newBaseName.trim(), form.factor.trim(), form.basePrice.trim(), keepPrimary]);'));
  assert.ok(d.includes('const fresh = preview && preview.key === formKey ? preview.data : null;'));
  assert.ok(d.includes('const ready = !!fresh && !problem && !busy && (!erpLinked || ackErp) && (apiTotal === 0 || ackApi);'));
  assert.ok(d.includes('disabled={!ready}'));
  // keepOldBaseAsPrimary مفعّلٌ افتراضاً، والإقراران حين تقولهما المعاينة
  assert.ok(d.includes('const [keepPrimary, setKeepPrimary] = useState(true);'));
  assert.ok(d.includes('const body = () => ({ ...convertPayload(form, expected), keepOldBaseAsPrimary: keepPrimary });'));
  assert.ok(d.includes('...body(), ...(ackErp && { acknowledgeErp: true }), ...(ackApi && { acknowledgeApi: true }),'));
  assert.ok(d.includes('const erpLinked = fresh?.erpLinked === true;'));
  assert.ok(d.includes('const apiTotal = countOf(fresh?.apiKeys?.write) + countOf(fresh?.apiKeys?.readOnly);'));
  assert.ok(d.includes('data-ack-erp=""') && d.includes('data-ack-api=""'));
  // نصوص المعاينة
  for (const k of ["fill(tr('سيعاد وسم {n} بندا، والفواتير المطبوعة لا تتغير')", "fill(tr('سعر العميل الخاص يبقى لـ«{unit}» كما هو')",
    "fill(tr('مثال لشكل الرصيد بعد الإضافة: {qty}')","tr('قد تستغرق حتى دقيقتين لصنف بتاريخ طويل، ومن يحفظ أثناءها يُطلب منه إعادة المحاولة')",
    "fill(tr('الافتراض في البيع بعد الإضافة: {unit}')", "fill(tr('تبقى «{unit}» الوحدة الرئيسية في العرض والإدخال')"]) {
    assert.ok(d.includes(k), `نصّ المعاينة: ${k}`);
  }
  // سطر الافتراض حين يختلف عن افتراض المندوب اليوم (طبليةٌ بلا رئيسية)
  assert.ok(d.includes('{defaultAfter !== defaultNow && ('));
});

test('«إضافة وحدة فرعية أصغر»: الرموز — BASE_UNIT_CHANGED يعيد فتح الصنف، وBASE_NAME_RETIRED تحت خانة الاسم، والإقرار الطارئ يعيد المعاينة', () => {
  const d = fnBody(modal(), 'function ConvertBaseDialog(');
  assert.ok(d.includes("if (code === 'BASE_UNIT_CHANGED') { onStale(); return true; }"));
  assert.ok(d.includes("if (code === 'BASE_NAME_RETIRED') { setNameError(tr(serverMessage(err) || 'تعذر التحويل')); return true; }"));
  const name = d.indexOf("{tr('اسم الوحدة الفرعية')} *");
  const retired = d.indexOf('data-base-name-retired=""');
  const factor = d.indexOf("fill(tr('كم {sub} في {primary}'), { sub: newName, primary: expected })");
  assert.ok(name > 0 && retired > name && factor > retired, 'رسالة الاسم المتقاعد تحت خانته');
  assert.ok(d.includes("if (code === 'CONVERT_BASE_ERP_ACK' || code === 'CONVERT_BASE_API_ACK') { setPreview(null); setPreviewNonce(n => n + 1); }"));
  // ٤٠٣ وغيرها برسالة الخادم داخل النافذة — في المعاينة والتنفيذ معاً، وبلا «الأساس» (D21): رسائل الخادم القائمة تقول
  // اسم العملية القديم (البوابة المغلقة، وقيد وحدة المندوب، وتكرار الاسم) فتُعرض بالرمز أو ببديلها
  assert.equal(d.split('setError(tr(convertServerText(err)));').length - 1, 2);
  assert.doesNotMatch(d, /setError\(tr\(serverMessage\(err\)/);
  const cst = modal().match(/const convertServerText = \(err: unknown\): string => \{([\s\S]*?)\n\};/);
  assert.ok(cst, 'convertServerText');
  assert.ok(cst[1].includes("if (code === 'CONVERT_BASE_OWNER_ONLY') return refusalHint('OWNER_ONLY');"));
  const repRule = cst[1].match(/if \(code === 'REP_UNIT_RULE_SET'\) return '([^']+)';/);
  assert.ok(repRule);
  assert.doesNotMatch(repRule[1], /الأساس/);
  translated(repRule[1]);
  assert.ok(cst[1].includes("return d21(serverMessage(err) || 'تعذر التحويل');"));
  // وبعد النجاح تتبع النافذة الأمّ الأساس الجديد ورئيسيّه، و«قيود المندوب» تعود «كل الوحدات»
  const s = modal();
  assert.match(s, /setValue\('unit', p\.unit\);\s*setValue\('basePrice', Number\(p\.basePrice\)\);/);
  assert.ok(s.includes('setPrimaryUnitId(p.primaryUnitId ?? null);'));
  assert.match(s, /onDone=\{\(p\) => \{[\s\S]*?adopt\(p\);[\s\S]*?setValue\('repSaleUnit', 'ANY'\);\s*setValue\('repReturnUnit', 'ANY'\);/);
});

test('D21: لا «الأساس» في أي نصٍّ جديد — والنصوص القائمة بها لا تظهر إلا لصنفٍ بلا رئيسية', () => {
  const s = modal();
  // كل عبارة tr('…') فيها «الأساس» في النافذة هي من قبل الحزمة (I1) — لا جديد
  const legacy = new Set([
    'اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف', 'السعر الأساسي', 'سعر وحدة الأساس', 'كود وحدة الأساس', 'عدد وحدات الأساس فيها',
    'فارغ يعني سعر الأساس مضروبا في المعامل', 'وحدة الأساس', 'أصغر ما يباع من الصنف وكل وحدة أكبر تعرف بعدد وحدات الأساس فيها',
    'لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها', 'محسوب من سعر الأساس',
  ]);
  const withBase = [...s.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1]).filter(k => /الأساس/.test(k));
  for (const k of withBase) assert.ok(legacy.has(k), `نصٌّ جديد فيه «الأساس»: ${k}`);
  // ونافذة «إضافة وحدة فرعية أصغر» كلها بلا «الأساس» (الاسم الجديد لزرٍّ تغيّر)
  const d = fnBody(s, 'function ConvertBaseDialog(');
  assert.deepEqual([...d.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1]).filter(k => /الأساس/.test(k)), []);
  // ورسائل التحقق المشتركة التي فيها «الأساس» تُعرض ببديلها في النافذة ولصنفٍ له رئيسية
  const alt = constValues(s, 'D21_TEXT');
  assert.equal(alt.length, 7);
  for (const v of alt) { assert.doesNotMatch(v, /الأساس/); translated(v); }
  assert.ok(d.includes('setError(tr(d21(problem)))'));
  assert.ok(s.includes('const shown = (msg: string) => (primary ? d21(msg) : msg);'));
  // تسمية السعر للصنف ذي الرئيسية بلا «الأساس»، وبلاها كما كانت
  assert.ok(s.includes("{primary ? fill(tr('سعر {unit} الواحدة'), { unit: savedBase }) : tr('السعر الأساسي')} *"));
  assert.ok(s.includes("{units.length > 0 && !primary && <p className=\"text-[10px] text-gray-400 mt-1\">{tr('سعر وحدة الأساس')}</p>}"));
  // تلميح خانة الوحدة يسمّي الزرّ الجديد (الاستثناء الوحيد في §4.2)
  assert.ok(s.includes("{tr('تغيير الاسم هنا إعادة تسمية فقط — لإضافة وحدة أصغر استخدم «إضافة وحدة فرعية أصغر»')}"));
  assert.doesNotMatch(s, /تحويل إلى وحدة أصغر|تحويل وحدة الأساس/);
});

test('كل عبارةٍ بعنصرٍ {…} في الشاشات الأربع مترجمةٌ بلغاتها الأربع وتُبقي عناصرها', () => {
  const files = [modal(), read('pages', 'ProductsPage.tsx'), read('pages', 'PlatformPage.tsx'), read('components', 'print', 'PrintSettingsPanel.tsx')];
  const keys = new Set<string>();
  for (const f of files) for (const m of f.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)) if (/\{[a-z]+\}/.test(m[1])) keys.add(m[1]);
  assert.ok(keys.size >= 20, `عبارات بعناصر: ${keys.size}`);
  for (const k of keys) translated(k);
});

// ─── قائمة الأصناف (§5.3: R4 وR5 وR1) ───

test('قائمة الأصناف: صنفٌ له رئيسية بوسم «كرتون (24 قارورة)» وسعر الرئيسية وتحته سعر الفرعية — وبلاها كما كان حرفاً', () => {
  const s = read('pages', 'ProductsPage.tsx');
  assert.ok(s.includes("import { primaryPriceOf, primaryUnitOf, unitPriceOf } from '../lib/units';"));
  assert.ok(s.includes('data?.data.map(p => { const pu = primaryUnitOf(p); return ('));
  assert.ok(s.includes('{pu ? <span data-primary-unit-label="">{productUnitLabel(p)}</span> : p.unit}'));
  // الرئيسية في الوسم فلا تُكرَّر بين الوحدات، والبقية بسطرها القائم
  assert.ok(s.includes('(p.units ?? []).filter(u => u.isActive !== false && u.id !== pu?.id).map(u => ('));
  assert.ok(s.includes('{formatCurrency(primaryPriceOf(p) ?? 0)} <span className="text-[11px] font-normal text-gray-500">/ {pu.name}</span>'));
  assert.ok(s.includes('<p className="text-[11px] text-gray-400 whitespace-nowrap">{p.unit}: {formatCurrency(p.basePrice)}</p>'));
  // فرع الصنف بلا رئيسية: الخلية القائمة حرفاً
  assert.ok(s.includes('<td className="font-semibold text-[#E15A30]">{formatCurrency(p.basePrice)}</td>'));
  // عنوان العمود: «السعر الأساسي» كما كان إلا حين في الصفحة صنفٌ له رئيسية (D21)
  assert.ok(s.includes("<th>{anyPrimary ? tr('السعر') : tr('السعر الأساسي')}</th>"));
  assert.ok(s.includes('const anyPrimary = rows.some(p => primaryUnitOf(p) !== null);'));
});

test('قائمة الأصناف: أرصدة تأكيد اللوط ونافذة «يحتاج انتباهاً» بالرئيسية لصنفها — وبلاها الرقم كما كان', () => {
  const s = read('pages', 'ProductsPage.tsx');
  assert.ok(s.includes('return p && primaryUnitOf(p) ? baseQtyText(n, p, formatNumber) : formatNumber(n);'));
  assert.ok(s.includes("{tr('المستودع')} {qtyText(b.productId, b.warehouse)}"));
  assert.ok(s.includes("{tr('المستودع')}: {qtyText(r.productId, r.warehouse.total)}"));
  assert.ok(s.includes('<LotAttentionModal rows={attention} qtyText={qtyText}'));
});

// ─── صفحة المنصّة: علم الشركة (D14-ب) ───

test('نافذة المالك: علم «إضافة وحدة فرعية أصغر لمديري الشركة» مطفأ افتراضياً، يُرسل حين يتغيّر وحده، ومعطّل والبوابة مغلقة أو لموظف المنصّة', () => {
  const s = read('pages', 'PlatformPage.tsx');
  assert.ok(s.includes('const [convertBaseOpen, setConvertBaseOpen] = useState(!!tenant.convertBaseOpen);'));
  assert.ok(s.includes('      ...(convertBaseOpen !== !!tenant.convertBaseOpen ? { convertBaseOpen } : {}),\n'), 'في الحمولة حين يتغيّر وحده');
  assert.ok(s.includes('const convertBaseOwnerOnly = access.isStaff;'));
  assert.ok(s.includes('const convertBaseLocked = tenant.convertBaseReleased === false || convertBaseOwnerOnly;'));
  const box = s.slice(s.indexOf('data-convert-base-open=""'));
  assert.ok(box.includes('disabled={convertBaseLocked}'));
  assert.ok(box.includes("{tr('إضافة وحدة فرعية أصغر لمديري الشركة')}"));
  assert.ok(box.includes("{tenant.convertBaseReleased === false && ("));
  assert.ok(box.includes("{tr('متاحة بعد اكتمال المراجعة')}"));
  // النصّ يذكر أن المدير يراها بعد دخوله التالي (الحقل يُحسب لحظة الدخول)
  const note = box.match(/<p className="text-xs text-gray-400 mt-1">\{tr\('([^']+)'\)\}<\/p>/)?.[1] ?? '';
  assert.ok(note.includes('بعد دخوله التالي'), note);
  assert.doesNotMatch(note, /الأساس/);
  translated(note);
  // بجوار «لوكيشن»
  const lc = s.indexOf("{tr('تفعيل صفحة لوكيشن لهذه الشركة')}");
  const cb = s.indexOf("{tr('إضافة وحدة فرعية أصغر لمديري الشركة')}");
  const card = s.indexOf("{tr('تفعيل التحصيل بالبطاقة (NearPay) لهذه الشركة')}");
  assert.ok(lc > 0 && cb > lc && card > cb, 'بعد «لوكيشن» وقبل «التحصيل بالبطاقة»');
});

// ─── إعدادات الطباعة: تنبيه R11 ───

test('إعدادات الطباعة: إطفاء «وحدة الصنف» يظهر تحته تنبيه «×5» حين للشركة صنفٌ بأكثر من وحدة أو برئيسية — والطباعة لا تتغيّر', () => {
  const s = read('components', 'print', 'PrintSettingsPanel.tsx');
  assert.ok(s.includes("<Toggle label={tr('وحدة الصنف')} checked={p.options.showItemUnit} onChange={(v) => setOpt('showItemUnit', v)} />\n                {!p.options.showItemUnit && <ItemUnitWarning />}"));
  const w = fnBody(s, 'function ItemUnitWarning(');
  assert.ok(w.includes("queryKey: ['products-min'],"), 'المفتاح المشترك للكتالوج المختصر');
  assert.ok(w.includes('productApi.list({ limit: 1000 })'));
  assert.ok(w.includes('const multi = q.isError || (q.data ?? []).some((x) => primaryUnitOf(x) !== null || hasBigUnit(x?.units));'));
  assert.ok(w.includes('if (!multi) return null;'));
  assert.ok(w.includes("{tr('إطفاؤه مع أصناف بأكثر من وحدة يطبع «×5» بلا وحدة، فلا يُعرف أكراتين أم حبّات')}"));
  // لا مساس بالإعداد نفسه ولا بحمولته
  assert.equal((s.match(/setOpt\('showItemUnit'/g) || []).length, 1);
});
