/**
 * «تصفير المخزون» (طلب المالك ١ نوفمبر ٢٠٢٦) — حرّاسٌ نصّية (النافذة تعتمد React Query والمتصفّح):
 * الزرّ لمدير الشركة غير المقيَّد (وله «تحميل مخزون السيارة») ولجلسة المالك وحدهما في الصفحتين — لا لـ«دخول» موظف المنصة، والتنفيذ بكلمة «تصفير» مكتوبةً، وzeroRef يُولَّد مرةً
 * لكل فتحٍ ويُعاد مع كل محاولة، وبعد النجاح يُبطَل كل مفتاح أرصدةٍ وحركاتٍ وتشغيلات تقرؤه الصفحتان، وحركات التصفير موسومة.
 * والعبارات (ورسائل الخادم حرفاً) في القاموس بلغاته الأربع.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const modal = () => read('components', 'StockZeroModal.tsx');
const wh = () => read('pages', 'CompanyWarehousePage.tsx');
const van = () => read('pages', 'VanStockPage.tsx');

const GATE = "const canZeroStock = !isStaffImpersonationClient() && ((me?.role === 'ADMIN' && !me?.scopeEnabled && me?.canManageVanStock !== false) || !!impersonating);";

// ── بيئة متصفّحٍ دنيا قبل استيراد المخزن: يقرأ localStorage وwindow.location لحظة تحميله ──
const store = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
for (const [k, v] of Object.entries({
  window: { location: { pathname: '/app/warehouse' } },
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => { store.set(key, String(val)); },
    removeItem: (key: string) => { store.delete(key); },
  },
})) Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
const { isStaffImpersonationClient } = await import('../store/authStore');
const { newUuid } = await import('../lib/uuid');
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** شرط الإظهار كما هو مكتوبٌ في الصفحة — مقيَّماً لا مقارَناً نصّاً فقط */
type Me = { role?: string; scopeEnabled?: boolean; canManageVanStock?: boolean } | null;
function gateOf(src: string): (me: Me, impersonating: string | null, staff: boolean) => boolean {
  const m = src.match(/const canZeroStock = (.+);\r?\n/);
  assert.ok(m, 'canZeroStock غائب');
  return (me, impersonating, staff) =>
    new Function('me', 'impersonating', 'isStaffImpersonationClient', `return ${m[1]};`)(me, impersonating, () => staff) as boolean;
}

test('العميل: stockZeroApi بمساريه — المعاينة GET والتنفيذ POST بكلمة التأكيد وzeroRef، وsalesRepId لسيارةٍ واحدة يُرسَل حين يوجد وحده', () => {
  const s = read('api', 'client.ts');
  const block = s.slice(s.indexOf('export const stockZeroApi = {'), s.indexOf('};', s.indexOf('export const stockZeroApi = {')) + 2);
  assert.ok(block.includes("preview: (salesRepId?: string) => api.get('/stock-zero/preview', salesRepId ? { params: { salesRepId } } : undefined),"), block);
  // غائبٌ ⇒ الجسم كما كان حرفاً (الشركة كلها)؛ والخادم يرفض null والفارغ (400) فلا يُرسَلان أبداً
  assert.ok(block.includes("run: (confirm: string, zeroRef: string, salesRepId?: string) => api.post('/stock-zero', salesRepId ? { confirm, zeroRef, salesRepId } : { confirm, zeroRef }),"), block);
});

test('الإظهار: مدير الشركة غير المقيَّد أو جلسة المالك — في الصفحتين، والنافذة خلف الشرط نفسه', () => {
  for (const [name, s] of [['warehouse', wh()], ['van', van()]] as const) {
    assert.ok(s.includes("import StockZeroModal from '../components/StockZeroModal';"), name);
    assert.ok(s.includes('const impersonating = useAuthStore(s => s.impersonating);'), name);
    assert.ok(s.includes(GATE), `${name}: شرط الإظهار تغيّر`);
    assert.ok(s.includes("import { useAuthStore, isStaffImpersonationClient } from '../store/authStore';"), name);
    assert.match(s, /\{canZeroStock && \(\s*<button type="button" onClick=\{\(\) => setShowZero\(true\)\}[^>]*>\s*<Eraser size=\{1\d\} \/> \{tr\('تصفير المخزون'\)\}/, `${name}: الزرّ بلا شرط`);
    assert.ok(s.includes('{showZero && canZeroStock && <StockZeroModal onClose={() => setShowZero(false)} />}'), name);
    // «مخزون السيارات» نافذتان: الشركة كلها، وسيارة المندوب المختار (salesRepId)
    assert.equal(s.match(/<StockZeroModal\b/g)?.length, name === 'van' ? 2 : 1, name);
  }
  // في «مخزون الشركة» بجانب «استلام / تسوية»
  const w = wh();
  const zeroBtn = w.indexOf('setShowZero(true)');
  const entryBtn = w.indexOf("tr('استلام / تسوية')");
  assert.ok(zeroBtn > 0 && entryBtn > zeroBtn && entryBtn - zeroBtn < 400, 'الزرّ ليس بجانب «استلام / تسوية»');
  // زرٌّ ثانويٌّ بلون الخطر كأزرار الترويسة لا زرّاً أحمر ممتلئاً
  assert.match(w, /setShowZero\(true\)\} className="btn-secondary text-\[#C0392B\]/);
});

test('الإظهار مقيَّماً في الصفحتين: «دخول» موظف المنصة مستثنى من الفرعين، ومديرٌ بلا «تحميل مخزون السيارة» لا يراه', () => {
  for (const [name, s] of [['warehouse', wh()], ['van', van()]] as const) {
    const gate = gateOf(s);
    const admin = { role: 'ADMIN' };
    assert.equal(gate(admin, null, false), true, `${name}: مدير الشركة`);
    assert.equal(gate({ ...admin, canManageVanStock: true }, null, false), true, name);
    assert.equal(gate({ ...admin, scopeEnabled: true }, null, false), false, `${name}: المقيَّد`);
    assert.equal(gate({ ...admin, canManageVanStock: false }, null, false), false, `${name}: بلا صلاحية المخزون`);
    assert.equal(gate({ role: 'MANAGER' }, null, false), false, `${name}: غير المدير`);
    assert.equal(gate(null, null, false), false, name);
    // جلسة المالك: لا دور ولا نطاق ولا صلاحية تقيّدها
    assert.equal(gate({ role: 'ADMIN', scopeEnabled: true, canManageVanStock: false }, 'Co', false), true, `${name}: المالك`);
    // «دخول» الموظف: دوره ADMIN و impersonating قائم — والخادم يردّه ٤٠٣ دائماً
    assert.equal(gate(admin, 'Co', true), false, `${name}: الموظف بانتحال`);
    assert.equal(gate(admin, null, true), false, `${name}: الموظف بفرع المدير`);
  }
});

test('isStaffImpersonationClient: علامة impersonating_from نفسها التي تقرؤها MainLayout، وlocalStorage الرامي = ليس موظفاً', () => {
  store.clear();
  assert.equal(isStaffImpersonationClient(), false);
  store.set('impersonating_from', '/platform');
  assert.equal(isStaffImpersonationClient(), false, 'دخول المالك');
  store.set('impersonating_from', '/staff');
  assert.equal(isStaffImpersonationClient(), true);
  store.set('impersonating_from', '/staff/x');
  assert.equal(isStaffImpersonationClient(), false, 'المطابقة حرفية كـMainLayout');
  const ls = g.localStorage;
  Object.defineProperty(g, 'localStorage', { value: { getItem: () => { throw new Error('blocked'); } }, configurable: true, writable: true });
  try { assert.equal(isStaffImpersonationClient(), false); } finally {
    Object.defineProperty(g, 'localStorage', { value: ls, configurable: true, writable: true });
  }
  store.clear();
  // والعلامة هي التي يكتبها impersonate ويقرؤها MainLayout للعودة
  assert.match(read('layouts', 'MainLayout.tsx'), /localStorage\.getItem\('impersonating_from'\) === '\/staff'/);
  assert.match(read('store', 'authStore.ts'), /export function isStaffImpersonationClient\(\): boolean \{\n  try \{ return localStorage\.getItem\('impersonating_from'\) === '\/staff'; \} catch \{ return false; \}\n\}/);
});

test('التأكيد المكتوب: الزرّ معطّل حتى تساوي الكتابة «تصفير» بعد trim، والحقل بلا إكمال تلقائي', () => {
  const s = modal();
  assert.match(s, /export const STOCK_ZERO_CONFIRM_WORD = 'تصفير';/);
  assert.match(s, /const confirmed = typed\.trim\(\) === STOCK_ZERO_CONFIRM_WORD;/);
  assert.match(s, /const canRun = !!p && !p\.alreadyZero && confirmed && !run\.isPending && !previewQ\.isFetching;/);
  assert.match(s, /onClick=\{\(\) => run\.mutate\(\)\} disabled=\{!canRun\}/);
  assert.match(s, /className="btn-danger[^"]*">[\s\S]*?\{van \? tr\('تصفير هذه السيارة'\) : tr\('تصفير المخزون'\)\}/);
  assert.match(s, /<input id="stock-zero-confirm"[^/]*?autoComplete="off"/);
  assert.ok(s.includes("{tr('اكتب كلمة التأكيد: تصفير')}"));
  // ما يُرسَل هو المكتوب نفسه (مقصوصاً) — لا الثابت، فالخادم يحكم على ما كتبه المدير
  assert.match(s, /stockZeroApi\.run\(typed\.trim\(\), zeroRef, salesRepId\)/);
});

test('zeroRef: يُولَّد مرةً لكل فتح (مُهيِّئ useState) ويُعاد كما هو مع كل محاولة', () => {
  const s = modal();
  assert.match(s, /const \[zeroRef\] = useState\(\(\) => newUuid\(\)\);/);
  assert.ok(s.includes("import { newUuid } from '../lib/uuid';"));
  assert.equal(s.match(/newUuid\(\)/g)?.length, 1, 'توليدٌ ثانٍ يكسر إعادة المحاولة بالمرجع نفسه');
  // لا استدعاء لـcrypto.randomUUID بلا حارس في النافذة (يُسقطها حيث يغيب)
  assert.doesNotMatch(s, /crypto\.randomUUID\(/);
  assert.doesNotMatch(s, /setZeroRef/);
  // النافذة تُركَّب عند الفتح وتُزال عند الإغلاق — فكل فتحٍ مرجعٌ جديد
  assert.ok(wh().includes('{showZero && canZeroStock && <StockZeroModal'));
});

test('newUuid: v4 صالح لـz.string().uuid() — مع randomUUID، وبغيابه، وحين يرمي، وبلا getRandomValues', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const setCrypto = (v: unknown) => Object.defineProperty(globalThis, 'crypto', { value: v, configurable: true, writable: true });
  try {
    assert.match(newUuid(), UUID_V4, 'randomUUID الأصلي');
    const grv = (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 0xff; return a; };
    setCrypto({ getRandomValues: grv });
    assert.match(newUuid(), UUID_V4, 'بلا randomUUID (متصفّح أقدم)');
    setCrypto({ randomUUID: () => { throw new Error('insecure context'); }, getRandomValues: grv });
    assert.match(newUuid(), UUID_V4, 'randomUUID يرمي');
    setCrypto({});
    assert.match(newUuid(), UUID_V4, 'بلا getRandomValues');
    setCrypto({ getRandomValues: () => { throw new Error('x'); } });
    assert.match(newUuid(), UUID_V4, 'getRandomValues يرمي');
    setCrypto(undefined);
    const a = newUuid(), b = newUuid();
    assert.match(a, UUID_V4, 'بلا crypto أصلاً');
    assert.notEqual(a, b);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'crypto', desc);
  }
  // مولّد المندوب (clientRef) هو نفسه — لا نسختان من الاحتياط
  const odb = read('rep', 'offlineDb.ts');
  assert.ok(odb.includes("import { newUuid } from '../lib/uuid';"));
  assert.match(odb, /export function newClientRef\(\): string \{\n  return newUuid\(\);\n\}/);
});

test('بعد النجاح: يُبطَل كل مفتاح أرصدةٍ وحركاتٍ وتشغيلات تقرؤه الصفحتان — ثم رسالةٌ بالأعداد وإغلاق', () => {
  const s = modal();
  const list = s.slice(s.indexOf('export const STOCK_ZERO_INVALIDATE_KEYS = ['), s.indexOf('] as const;'));
  const keys = [...list.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
  // كل مفتاح استعلامٍ لأرصدة أو حركات أو تشغيلات في الصفحتين (ونوافذهما) يجب أن يكون في القائمة
  const pageKeys = new Set<string>();
  for (const src of [wh(), van(), read('components', 'VanLoadsLog.tsx'), read('components', 'StockLotFields.tsx')]) {
    for (const m of src.matchAll(/queryKey: \['([a-z-]+)'/g)) pageKeys.add(m[1]);
  }
  const stockish = [...pageKeys].filter(k => /^(warehouse-|van-(summary|current|movements|loads-log|suggest|lot-balances)$|lot-|lots)/.test(k));
  assert.ok(stockish.length >= 10, `مفاتيح أقلّ من المتوقّع: ${stockish.join(',')}`);
  for (const k of stockish) assert.ok(keys.includes(k), `المفتاح ${k} لا يُبطَل بعد التصفير`);
  for (const k of ['warehouse-stock', 'warehouse-vans', 'warehouse-entries', 'van-summary', 'van-current', 'van-movements', 'lot-balances-wh', 'lot-balances-van', 'lots']) {
    assert.ok(keys.includes(k), k);
  }
  // المعاينة لا تُبطَل: النافذة تُغلق بعدها مباشرةً ومعاينتها gcTime: 0 طازجةٌ عند كل فتح — إبطالها إعادة حسابٍ ثقيلة تُرمى
  assert.ok(!keys.includes('stock-zero-preview'), 'stock-zero-preview في قائمة الإبطال');
  assert.deepEqual(keys, [
    'warehouse-stock', 'warehouse-vans', 'warehouse-entries',
    'van-summary', 'van-current', 'van-movements', 'van-loads-log', 'van-suggest', 'locations-summary',
    'van-lot-balances', 'lot-balances-wh', 'lot-balances-van', 'lot-balances-load', 'lot-fefo', 'lots-of-product', 'lots',
  ]);
  assert.match(modal(), /queryKey: \['stock-zero-preview', salesRepId \?\? null\],[\s\S]{0,140}gcTime: 0,/);
  const ok = s.slice(s.indexOf('onSuccess: (r) =>'), s.indexOf('onError:'));
  assert.match(ok, /STOCK_ZERO_INVALIDATE_KEYS\.forEach\(k => qc\.invalidateQueries\(\{ queryKey: \[k\] \}\)\);/);
  assert.ok(ok.includes("tr('تم تصفير المخزون')") && ok.includes('r.warehouse.products') && ok.includes('r.vans.reps') && ok.includes('r.vans.products'));
  assert.ok(ok.includes("tr('المخزون صفر أصلا لم يكتب شيء')"));
  assert.ok(ok.indexOf('onClose()') > ok.indexOf('invalidateQueries'));
});

test('الأخطاء: رسالة الخادم مترجمةً بـtr، والانشغال يعيد المعاينة — ولا منع لأصناف اللوط بعد اليوم', () => {
  const s = modal();
  const err = s.slice(s.indexOf('onError: (e: unknown) =>'), s.indexOf('const canRun'));
  assert.ok(err.length > 0);
  assert.match(err, /toast\.error\(msg \? tr\(msg\) : tr\('تعذر تصفير المخزون'\)\);/);
  assert.match(err, /serverCode\(e\) === 'STOCK_ZERO_BUSY'\) void previewQ\.refetch\(\)/);
  // «أصناف اللوط تُصفَّر تشغيلةً تشغيلة» (١٨ نوفمبر): الخادم لا يرفضها فلا رمز ولا قائمة منعٍ في النافذة
  assert.doesNotMatch(s, /STOCK_ZERO_LOT_TRACKED|lotBlocked|\bblocked\b/);
});

test('المعاينة: الأقسام والتحذيرات وما يمنع', () => {
  const s = modal();
  assert.match(s, /queryKey: \['stock-zero-preview', salesRepId \?\? null\]/);
  assert.match(s, /\{p\.warehouse\.enabled && \(/, 'قسم المستودع بلا شرط تفعيله');
  for (const f of ['p.warehouse.products', 'p.warehouse.positiveQty', 'p.warehouse.negativeQty', 'p.warehouse.value', 'p.warehouse.uncostedQty',
    'p.vans.reps', 'p.vans.products', 'p.vans.sellableQty', 'p.vans.negativeQty', 'p.vans.unsellableQty', 'p.vans.value', 'p.vans.deletedVans', 'p.lastRun.actorName']) {
    assert.ok(s.includes(f), f);
  }
  for (const k of [
    'سيارات مناديب محذوفين لا تُمسّ',
    'أجهزة مناديب لم ترفع مستنداتها — اطلب منهم المزامنة قبل التصفير، وإلا ظهرت فواتيرهم المتأخرة رصيداً سالباً',
    'أصناف بتتبع اللوط', 'تصفر كل تشغيلة بكميتها والجزء بلا تشغيلة بسطر وحده', 'أصناف أخرى بتتبع اللوط', 'غير مسمى', 'ينتهي', 'منتهي', 'تالف',
    'المخزون صفر الآن لا شيء للتصفير', 'آخر تصفير',
    'لا يمكن التراجع عن التصفير إلا بإدخال استلامات جديدة', 'السجل والمخزون في تاريخ يبقيان بالأرقام القديمة', 'عهدة أدوات السيارات لا تتأثر بالتصفير',
  ]) assert.ok(s.includes(`tr('${k}')`), k);
  // «أصناف اللوط تُصفَّر تشغيلةً تشغيلة» (١٨ نوفمبر): لا منع ولا إحالة إلى تسويةٍ يدوية — حقل التأكيد لكل ما ليس صفراً، وقسم أصناف اللوط
  // بتشغيلاتها (رقمها أو «غير مسمى»، وانتهاؤها يوماً خالصاً، ودلو المرتجع المنتهي أو التالف، وكميتها والسالب أحمر) من lotProducts
  assert.match(s, /\{!p\.alreadyZero && \(\s*<div>\s*<label htmlFor="stock-zero-confirm"/);
  assert.match(s, /const lotProducts = p\?\.lotProducts \?\? \[\];/);
  const box = s.slice(s.indexOf('{lotProducts.length > 0 && ('), s.indexOf('{p.lastRun && ('));
  assert.ok(box.length > 0, 'قسم أصناف اللوط غائب');
  for (const f of [
    "{tr('أصناف بتتبع اللوط')}", "{tr('تصفر كل تشغيلة بكميتها والجزء بلا تشغيلة بسطر وحده')}", "{l.lotNumber ?? tr('غير مسمى')}",
    "formatDayOnly(l.expiryDate)", "l.bucket === 'EXPIRED' ? tr('منتهي') : tr('تالف')", 'fmtQty(l.qty)', "l.qty < 0 ? 'text-red-600'",
    'p.lotProductsTotal > lotProducts.length', "{tr('أصناف أخرى بتتبع اللوط')}",
    "it.place === 'WAREHOUSE' ? tr('المستودع المركزي') : `${tr('سيارة المندوب')}: ${it.repName ?? ''}`",
  ]) assert.ok(box.includes(f), f);
  assert.doesNotMatch(s, /\/app\/lots|فتح صفحة اللوط|صفرها من صفحة اللوط|<Link\b/);
  // الأجهزة المعلّقة تحذيرٌ لا منع
  assert.doesNotMatch(s.slice(s.indexOf('const canRun'), s.indexOf(';', s.indexOf('const canRun'))), /pending/);
  // التحذير الأحمر قبل الكتابة
  assert.match(s, /<div role="alert"/);
});

test('«تصفير سيارة مندوب واحدة» (١٨ نوفمبر): زرّ «تصفير هذه السيارة» في تفصيل المندوب وفي شاشة تحميله على الجوال بالشرط نفسه، والنافذة بسيارته وحدها', () => {
  const s = modal();
  // النافذة: salesRepId يحدّد النطاق في المعاينة والتنفيذ، والعنوان باسم المندوب، ولا روابط تُخرج الجوال إلى اللوحة
  assert.match(s, /export default function StockZeroModal\(\{ onClose, salesRepId, repName, onZeroed \}/);
  assert.match(s, /const van = !!salesRepId;/);
  assert.match(s, /queryFn: async \(\) => \(await stockZeroApi\.preview\(salesRepId\)\)\.data\.data as StockZeroPreview,/);
  assert.match(s, /\{van \? `\$\{tr\('تصفير سيارة المندوب'\)\}: \$\{name\}` : tr\('تصفير المخزون'\)\}/);
  assert.match(s, /const name = p\?\.salesRep\?\.name \|\| repName \|\| '';/);
  // سيارةٌ واحدة: أصناف اللوط بلا وسم موقعها (كلها في سيارته)
  assert.match(s, /\{!van && <span className="font-normal text-\[#9A8F7E\]"> — \{it\.place === 'WAREHOUSE'/);
  // التأكيد بالكلمة نفسها والزرّ بالشرط نفسه في الحالين — والشطب لا يعود إلى المستودع (تحذير)
  assert.equal(s.match(/const confirmed = /g)?.length, 1);
  assert.ok(s.includes("{van && <p>{tr('بضاعة السيارة لا تعود إلى المستودع لإرجاعها سجل تنزيلا بدلا من التصفير')}</p>}"));
  const ok = s.slice(s.indexOf('onSuccess: (r) =>'), s.indexOf('onError:'));
  assert.ok(ok.indexOf('onZeroed?.()') > ok.indexOf('invalidateQueries') && ok.indexOf('onZeroed?.()') < ok.indexOf('onClose()'));

  // «مخزون السيارات»: في رأس تفصيل المندوب المختار، بشرط زرّ الشركة نفسه (canZeroStock)
  const v = van();
  assert.match(v, /const \[zeroRep, setZeroRep\] = useState<\{ id: string; name: string \} \| null>\(null\);/);
  const head = v.slice(v.indexOf("{tr('مخزون المندوب الحالي')} — {selectedRep.repName}"), v.indexOf('{currentQ.isLoading ?'));
  assert.match(head, /\{canZeroStock && \(\s*<button type="button" onClick=\{\(\) => setZeroRep\(\{ id: selectedRep\.salesRepId, name: selectedRep\.repName \}\)\}[^>]*>\s*<Eraser size=\{14\} \/> \{tr\('تصفير هذه السيارة'\)\}/);
  assert.ok(v.includes('{zeroRep && canZeroStock && <StockZeroModal salesRepId={zeroRep.id} repName={zeroRep.name} onClose={() => setZeroRep(null)} />}'));

  // الجوال (/m): شاشة تحميل المندوب — قسم «مخزون المندوب الحالي» — بالشرط نفسه حرفاً، وبعد التصفير مفاتيح الجوال واللوحة معاً
  const m = read('m', 'MRepLoad.tsx');
  assert.ok(m.includes(GATE), 'شرط الإظهار في /m تغيّر');
  assert.ok(m.includes("import { useAuthStore, isStaffImpersonationClient } from '../store/authStore';"));
  assert.ok(m.includes("const StockZeroModal = lazy(() => import('../components/StockZeroModal'));"));
  assert.match(m, /\{canZeroStock && \(\s*<button type="button" onClick=\{\(\) => setZeroOpen\(true\)\}[^>]*>\s*<Eraser size=\{13\} \/> \{tr\('تصفير هذه السيارة'\)\}/);
  assert.ok(m.includes('<StockZeroModal salesRepId={rep.id} repName={rep.name} onZeroed={invalidateVanStock} onClose={() => setZeroOpen(false)} />'));
  assert.match(m, /\{zeroOpen && canZeroStock && \(/);
  assert.ok(m.includes('useBackClose(zeroOpen, () => setZeroOpen(false));'));
  const gate = gateOf(m);
  assert.equal(gate({ role: 'ADMIN' }, null, false), true);
  assert.equal(gate({ role: 'ADMIN', scopeEnabled: true }, null, false), false);
  assert.equal(gate({ role: 'ADMIN' }, 'Co', true), false);

  // القاموس: العبارات الجديدة ورسالة الخادم (STOCK_ZERO_REP_NOT_FOUND) بلغاتها الأربع
  const dict = read('i18n', 'strings.ts');
  for (const k of ['تصفير هذه السيارة', 'تصفير سيارة المندوب', 'تم تصفير سيارة المندوب', 'المندوب غير موجود']) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal(dict.match(new RegExp(`^  '${esc}': \\{ en: '[^']+', fr: '[^']+', tr: '[^']+', zh: '[^']+' \\},$`, 'gm'))?.length, 1, k);
  }
});

test('السجلّ: تسوية التصفير شارةٌ حمراء وأصنافها مطويّة «N صنف»، وحركة السيارة موسومة', () => {
  const w = wh();
  assert.match(w, /zeroRunId\?: string \| null;/);
  assert.match(w, /const isZero = !!e\.zeroRunId;/);
  assert.match(w, /const itemsOpen = !isZero \|\| openZeroEntries\.has\(e\.id\);/);
  assert.match(w, /\{isZero \? tr\('تصفير المخزون'\) : e\.type === 'RECEIVE' \? tr\('وارد'\) : tr\('تسوية'\)\}/);
  assert.match(w, /\{e\.items\.length\} \{tr\('صنف'\)\} · \{itemsOpen \? tr\('إخفاء الأصناف'\) : tr\('إظهار الأصناف'\)\}/);
  assert.match(w, /\{itemsOpen && \(\n\s*<div className="flex flex-wrap gap-1\.5 mt-1\.5">/);
  const v = van();
  assert.match(v, /zeroRunId\?: string \| null;/);
  assert.match(v, /const meta = m\.zeroRunId \? \{ \.\.\.base, label: 'تصفير المخزون'/);
  assert.match(v, /\{tr\(meta\.label\)\}/);
});

test('القاموس: كل عبارة جديدة ورسائل الخادم حرفاً بلغاتها الأربع، بلا تكرار', () => {
  const s = read('i18n', 'strings.ts');
  const phrases = [
    'تصفير المخزون', 'إظهار الأصناف', 'إخفاء الأصناف', 'اكتب كلمة التأكيد: تصفير', 'تم تصفير المخزون', 'آخر تصفير',
    'سيارات مناديب محذوفين لا تُمسّ',
    'أجهزة مناديب لم ترفع مستنداتها — اطلب منهم المزامنة قبل التصفير، وإلا ظهرت فواتيرهم المتأخرة رصيداً سالباً',
    // رسائل الخادم (routes/stockZero.ts) — تُعرض بـtr(message)
    'هذا الإجراء غير متاح بمفتاح API', 'تصفير المخزون لمدير الشركة وحده', 'تصفير المخزون لمدير الشركة غير المقيد بنطاق',
    'اكتب كلمة التأكيد تصفير', 'تصفير آخر قيد التنفيذ انتظر ثم أعد المحاولة',
    'المخزون مشغول بحركة أخرى أعد المحاولة بعد لحظات',
  ];
  // وكل tr('…') عربيٌّ في النافذة مدخلٌ في القاموس
  const used = [...modal().matchAll(/\btr\('([^']+)'\)/g)].map(m => m[1]);
  for (const k of new Set([...phrases, ...used])) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = s.match(new RegExp(`^  '${esc}': \\{ en: '[^']+', fr: '[^']+', tr: '[^']+', zh: '[^']+' \\},$`, 'gm'));
    assert.equal(rows?.length, 1, `«${k}» غائبة أو مكرّرة أو ناقصة لغة`);
  }
});
