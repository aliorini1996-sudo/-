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

test('العميل: stockZeroApi بمساريه — المعاينة GET والتنفيذ POST بكلمة التأكيد وzeroRef', () => {
  const s = read('api', 'client.ts');
  assert.match(s, /export const stockZeroApi = \{\n  preview: \(\) => api\.get\('\/stock-zero\/preview'\),\n  run: \(confirm: string, zeroRef: string\) => api\.post\('\/stock-zero', \{ confirm, zeroRef \}\),\n\};/);
});

test('الإظهار: مدير الشركة غير المقيَّد أو جلسة المالك — في الصفحتين، والنافذة خلف الشرط نفسه', () => {
  for (const [name, s] of [['warehouse', wh()], ['van', van()]] as const) {
    assert.ok(s.includes("import StockZeroModal from '../components/StockZeroModal';"), name);
    assert.ok(s.includes('const impersonating = useAuthStore(s => s.impersonating);'), name);
    assert.ok(s.includes(GATE), `${name}: شرط الإظهار تغيّر`);
    assert.ok(s.includes("import { useAuthStore, isStaffImpersonationClient } from '../store/authStore';"), name);
    assert.match(s, /\{canZeroStock && \(\s*<button type="button" onClick=\{\(\) => setShowZero\(true\)\}[^>]*>\s*<Eraser size=\{1\d\} \/> \{tr\('تصفير المخزون'\)\}/, `${name}: الزرّ بلا شرط`);
    assert.ok(s.includes('{showZero && canZeroStock && <StockZeroModal onClose={() => setShowZero(false)} />}'), name);
    assert.equal(s.match(/<StockZeroModal\b/g)?.length, 1, name);
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
  assert.match(s, /const canRun = !!p && !p\.alreadyZero && !blocked && confirmed && !run\.isPending && !previewQ\.isFetching;/);
  assert.match(s, /onClick=\{\(\) => run\.mutate\(\)\} disabled=\{!canRun\}/);
  assert.match(s, /className="btn-danger[^"]*">[\s\S]*?\{tr\('تصفير المخزون'\)\}/);
  assert.match(s, /<input id="stock-zero-confirm"[^/]*?autoComplete="off"/);
  assert.ok(s.includes("{tr('اكتب كلمة التأكيد: تصفير')}"));
  // ما يُرسَل هو المكتوب نفسه (مقصوصاً) — لا الثابت، فالخادم يحكم على ما كتبه المدير
  assert.match(s, /stockZeroApi\.run\(typed\.trim\(\), zeroRef\)/);
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
  assert.match(modal(), /queryKey: \['stock-zero-preview'\],[\s\S]{0,120}gcTime: 0,/);
  const ok = s.slice(s.indexOf('onSuccess: (r) =>'), s.indexOf('onError:'));
  assert.match(ok, /STOCK_ZERO_INVALIDATE_KEYS\.forEach\(k => qc\.invalidateQueries\(\{ queryKey: \[k\] \}\)\);/);
  assert.ok(ok.includes("tr('تم تصفير المخزون')") && ok.includes('r.warehouse.products') && ok.includes('r.vans.reps') && ok.includes('r.vans.products'));
  assert.ok(ok.includes("tr('المخزون صفر أصلا لم يكتب شيء')"));
  assert.ok(ok.indexOf('onClose()') > ok.indexOf('invalidateQueries'));
});

test('الأخطاء: رسالة الخادم مترجمةً بـtr، واللوط المانع يعيد المعاينة', () => {
  const s = modal();
  const err = s.slice(s.indexOf('onError: (e: unknown) =>'), s.indexOf('const blocked'));
  assert.match(err, /toast\.error\(msg \? tr\(msg\) : tr\('تعذر تصفير المخزون'\)\);/);
  assert.match(err, /serverCode\(e\) === 'STOCK_ZERO_LOT_TRACKED'\) void previewQ\.refetch\(\)/);
});

test('المعاينة: الأقسام والتحذيرات وما يمنع', () => {
  const s = modal();
  assert.match(s, /queryKey: \['stock-zero-preview'\]/);
  assert.match(s, /\{p\.warehouse\.enabled && \(/, 'قسم المستودع بلا شرط تفعيله');
  for (const f of ['p.warehouse.products', 'p.warehouse.positiveQty', 'p.warehouse.negativeQty', 'p.warehouse.value', 'p.warehouse.uncostedQty',
    'p.vans.reps', 'p.vans.products', 'p.vans.sellableQty', 'p.vans.negativeQty', 'p.vans.unsellableQty', 'p.vans.value', 'p.vans.deletedVans', 'p.lastRun.actorName']) {
    assert.ok(s.includes(f), f);
  }
  for (const k of [
    'سيارات مناديب محذوفين لا تُمسّ',
    'أجهزة مناديب لم ترفع مستنداتها — اطلب منهم المزامنة قبل التصفير، وإلا ظهرت فواتيرهم المتأخرة رصيداً سالباً',
    'أصناف بتتبع اللوط لها رصيد صفر رصيد المستودع بتسوية نقص بالتشغيلة من مخزون الشركة وأزل رصيد السيارات من مخزون السيارات أولا', 'المخزون صفر الآن لا شيء للتصفير', 'آخر تصفير',
    'لا يمكن التراجع عن التصفير إلا بإدخال استلامات جديدة', 'السجل والمخزون في تاريخ يبقيان بالأرقام القديمة', 'عهدة أدوات السيارات لا تتأثر بالتصفير',
  ]) assert.ok(s.includes(`tr('${k}')`), k);
  // اللوط المانع يعطّل الزرّ (blocked في canRun) ويُخفي حقل التأكيد، ويدلّ على الطريق الحقيقي: «مخزون الشركة» و«مخزون السيارات»
  // (صفحة اللوط عرضٌ لا تسوية فيها)
  assert.match(s, /const blocked = lotBlocked\.length > 0;/);
  assert.match(s, /\{!p\.alreadyZero && !blocked && \(/);
  const box = s.slice(s.indexOf('{blocked && ('), s.indexOf('{p.lastRun && ('));
  assert.match(box, /<Link to="\/app\/warehouse" onClick=\{onClose\}[^>]*>\{tr\('مخزون الشركة'\)\}<\/Link>/);
  assert.match(box, /<Link to="\/app\/van-stock" onClick=\{onClose\}[^>]*>\{tr\('مخزون السيارات'\)\}<\/Link>/);
  assert.doesNotMatch(s, /\/app\/lots|فتح صفحة اللوط|صفرها من صفحة اللوط/);
  // والمساران حقيقيان في الموجِّه (تحت /app)
  const app = read('App.tsx');
  assert.ok(app.includes('<Route path="warehouse" element={<PermissionRoute permission="canManageVanStock"><CompanyWarehousePage />'));
  assert.ok(app.includes('<Route path="van-stock" element={<PermissionRoute permission="canManageVanStock"><VanStockPage />'));
  assert.match(read('layouts', 'MainLayout.tsx'), /to: '\/app\/warehouse'[\s\S]*?to: '\/app\/van-stock'|to: '\/app\/van-stock'[\s\S]*?to: '\/app\/warehouse'/);
  // الأجهزة المعلّقة تحذيرٌ لا منع
  assert.doesNotMatch(s.slice(s.indexOf('const canRun'), s.indexOf(';', s.indexOf('const canRun'))), /pending/);
  // التحذير الأحمر قبل الكتابة
  assert.match(s, /<div role="alert"/);
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
    'أصناف بتتبع اللوط لها رصيد صفر رصيد المستودع بتسوية نقص بالتشغيلة من مخزون الشركة وأزل رصيد السيارات من مخزون السيارات أولا', 'المخزون مشغول بحركة أخرى أعد المحاولة بعد لحظات',
  ];
  // وكل tr('…') عربيٌّ في النافذة مدخلٌ في القاموس
  const used = [...modal().matchAll(/\btr\('([^']+)'\)/g)].map(m => m[1]);
  for (const k of new Set([...phrases, ...used])) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rows = s.match(new RegExp(`^  '${esc}': \\{ en: '[^']+', fr: '[^']+', tr: '[^']+', zh: '[^']+' \\},$`, 'gm'));
    assert.equal(rows?.length, 1, `«${k}» غائبة أو مكرّرة أو ناقصة لغة`);
  }
});
