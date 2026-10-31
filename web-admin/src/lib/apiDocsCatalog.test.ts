import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC_GROUPS, API_DOC_GUIDES, API_DOC_PLACEHOLDER_KEY } from './apiDocsCatalog';
import { API_BASE_URL, API_DENIED, API_SYNC_RESOURCES } from './apiDocsData';

/**
 * مستند API يُسلَّم لمبرمج الشركة: كل مسارٍ يذكره يجب أن يكون مركَّباً في الخادم بطريقته — مسارٌ يُحذف أو
 * يُعاد تسميته ويبقى في المستند يكسر نظام الشركة بلا إنذار. ولا يذكر المستند مساراً ممنوعاً على المفاتيح.
 *
 * والمطابقة **في ملف موجّه المسار نفسه** لا في كل الملفات مجتمعة: الموجّهات المتداخلة (طرق الدفع والطباعة والفرق تحت
 * /company في routes/company.ts) تعرّف '/' في ملفاتها، فالبحث عن `.put('/payment-methods'` في كل الملفات كان يُفشل مساراً
 * موجوداً، ويُنجح `.get('/payment-methods'` مصادفةً من تقرير طرق الدفع في reports.ts — توثيقٌ يمرّ بمسار غيره.
 */
const BACKEND = path.resolve(process.cwd(), '..', 'backend', 'src');
const ROUTES = path.join(BACKEND, 'routes');
const read = (file: string) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
/** ملف موجّه بمعرّفه النسبيّ داخل routes بلا امتداد ('teams'، 'ledger/index') */
const routeFile = (id: string) => read(path.join(ROUTES, `${id}.ts`));
/** مسار استيراد نسبيّ من مجلد داخل routes ⇒ معرّف الملف ('./ledger' مجلدٌ فيُقرأ index) — وما خارج routes لا يُعدّ */
function resolveRoute(fromDir: string, spec: string): string | null {
  const rel = path.posix.normalize(path.posix.join(fromDir, spec));
  if (rel.startsWith('..')) return null;
  if (fs.existsSync(path.join(ROUTES, `${rel}.ts`))) return rel;
  if (fs.existsSync(path.join(ROUTES, rel, 'index.ts'))) return `${rel}/index`;
  return null;
}

/** المعرّفات المستوردة نسبياً: `import a, { b, c as d } from './x'` ⇒ a,b,d → x (محلولاً من مجلد المستورِد داخل routes) */
function importsOf(src: string, fromDir: string, specPrefix: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^import\s+([^;]+?)\s+from\s+'([^']+)';/gm)) {
    if (!m[2].startsWith(specPrefix)) continue;
    const file = resolveRoute(fromDir, `./${m[2].slice(specPrefix.length)}`);
    if (!file) continue;
    const clause = m[1].trim();
    const braces = /\{([^}]*)\}/.exec(clause);
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
    if (def && !def.startsWith('type ')) out.set(def, file);
    for (const part of braces ? braces[1].split(',') : []) {
      const name = part.trim().split(/\s+as\s+/).pop()!.trim();
      if (name && !name.startsWith('type ')) out.set(name, file);
    }
  }
  return out;
}

/** بادئة كل مسار ⇒ ملفات موجّهاتها: تركيبات index.ts ثم router.use('/sub', x) داخل الموجّهات (الفرق والطباعة وطرق الدفع) */
function mountMap(): Map<string, Set<string>> {
  const index = read(path.join(BACKEND, 'index.ts'));
  const imported = importsOf(index, '.', './routes/');
  const mounts = new Map<string, Set<string>>();
  const add = (prefix: string, file: string) => { if (!mounts.has(prefix)) mounts.set(prefix, new Set()); mounts.get(prefix)!.add(file); };
  for (const m of index.matchAll(/app\.use\('\/api(\/[^']+)',\s*([^\n]+)\);/g)) {
    for (const ident of m[2].match(/[A-Za-z_]\w*/g) ?? []) if (imported.has(ident)) add(m[1], imported.get(ident)!);
  }
  // المتداخلة: موجّهٌ مركّب داخل موجّه — حتى يستقرّ (عمقٌ واحد اليوم، والحلقة تكفي غداً)
  for (let changed = true; changed;) {
    changed = false;
    for (const [prefix, files] of [...mounts]) {
      for (const file of [...files]) {
        const src = routeFile(file);
        const local = importsOf(src, path.posix.dirname(file), './');
        // router.use('/sub', x) تحت البادئة، وrouter.use(createX(deps)) بلا مسار على البادئة نفسها (بيانات المشتري في العملاء)
        for (const m of src.matchAll(/router\.use\((?:'(\/[^']+)',\s*)?(\w+)\b/g)) {
          const child = local.get(m[2]);
          const full = `${prefix}${m[1] ?? ''}`;
          if (child && !mounts.get(full)?.has(child)) { add(full, child); changed = true; }
        }
      }
    }
  }
  return mounts;
}
const MOUNTS = mountMap();

/** أطول بادئة تطابق المسار — هي التي يوجّه إليها Express (الموجّه المتداخل يسبق مسارات أبيه بالترتيب في company.ts) */
function ownerOf(p: string): { prefix: string; files: Set<string> } | null {
  const prefix = [...MOUNTS.keys()].filter((m) => p === m || p.startsWith(`${m}/`)).sort((a, b) => b.length - a.length)[0];
  return prefix ? { prefix, files: MOUNTS.get(prefix)! } : null;
}

const documented = new Set(API_DOC_GROUPS.flatMap((g) => g.endpoints.map((e) => `${e.method} ${e.path}`)));

test('خريطة التركيب تعرف الموجّهات المتداخلة تحت /company — ولا تنسب مساراً لملف غيره', () => {
  assert.deepEqual([...(MOUNTS.get('/company/payment-methods') ?? [])], ['paymentMethodsConfig']);
  assert.deepEqual([...(MOUNTS.get('/company/print-settings') ?? [])], ['printSettings']);
  assert.deepEqual([...(MOUNTS.get('/company/print-texts') ?? [])], ['printTexts']);
  assert.deepEqual([...(MOUNTS.get('/company/teams') ?? [])], ['teams']);
  assert.deepEqual([...(MOUNTS.get('/invoices') ?? [])].sort(), ['invoices', 'invoicesEinvoiceDocs']);
  assert.equal(ownerOf('/company/payment-methods')?.prefix, '/company/payment-methods', 'لا reports.ts ولا company.ts');
  assert.equal(ownerOf('/locations/reps/:salesRepId')?.prefix, '/locations');
});

test('كل مسار في المستند مركَّبٌ في الخادم بطريقته — في ملف موجّهه نفسه', () => {
  const missing: string[] = [];
  for (const g of API_DOC_GROUPS) {
    for (const e of g.endpoints) {
      const owner = ownerOf(e.path);
      if (!owner) { missing.push(`${e.method} ${e.path} (لا بادئة)`); continue; }
      const sub = e.path.slice(owner.prefix.length) || '/';
      const needle = `.${e.method.toLowerCase()}('${sub}'`;
      if (![...owner.files].some((f) => routeFile(f).includes(needle))) missing.push(`${e.method} ${e.path} (${[...owner.files].join('/')})`);
    }
  }
  assert.deepEqual(missing, []);
});

/**
 * التغطية العكسية: كل مسار في موجّهات الميزات الحديثة وما يمسّها موثّقٌ في المستند، أو مستثنى هنا بسببه — فميزةٌ جديدة
 * تُضاف لموجّهٍ منها لا تسقط من دليل الربط بصمت (كما سقطت لوكيشن وطرق الدفع قبل هذا).
 */
const COVERED_ROUTERS = [
  'locations', 'paymentMethodsConfig', 'printSettings', 'printTexts', 'attendanceAdmin', 'teams', 'reports', 'invoices', 'salesReps', 'vanStock', 'warehouse', 'receipts',
  'repStockRequests', 'products', 'lots', 'import',
];
const NOT_DOCUMENTED: Readonly<Record<string, string>> = {
  'PUT /company/teams/:id/supervisors': 'يرفض مفاتيح API دائماً بـ403 (API_KEY_FORBIDDEN بعد فحص صلاحيتي الإعدادات والمستخدمين) — نطاق مستخدمي الشركة من اللوحة وحدها، ومذكورٌ في مقدمة مجموعة الفرق',
  'GET /rep-stock-requests/mine': 'للمندوب وحده (repOnly) والمفتاح مستخدم شركة فيُرفض 403 — رفع الطلب من تطبيق المندوب، ومذكورٌ في GET /rep-stock-requests',
  'PUT /rep-stock-requests/mine': 'للمندوب وحده (repOnly) والمفتاح مستخدم شركة فيُرفض 403',
  'DELETE /rep-stock-requests/mine': 'للمندوب وحده (repOnly) والمفتاح مستخدم شركة فيُرفض 403',
};

test('كل مسار في موجّهات الميزات الحديثة موثّقٌ في المستند أو مستثنى بسبب مكتوب', () => {
  const undocumented: string[] = [];
  let seen = 0;
  for (const file of COVERED_ROUTERS) {
    const prefixes = [...MOUNTS].filter(([, files]) => files.has(file)).map(([p]) => p);
    assert.ok(prefixes.length, `${file} غير مركّب`);
    const src = routeFile(file);
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      seen += 1;
      for (const prefix of prefixes) {
        const full = `${prefix}${m[2] === '/' ? '' : m[2]}`;
        const key = `${m[1].toUpperCase()} ${full}`;
        if (!documented.has(key) && !(key in NOT_DOCUMENTED)) undocumented.push(key);
      }
    }
  }
  assert.deepEqual(undocumented, []);
  // لا نجاح فارغ: قراءة المسارات من الملفات تعمل (٨٧ مساراً يوم كُتب هذا)
  assert.ok(seen >= 80, `قُرئ ${seen} مساراً فقط`);
  for (const key of Object.keys(NOT_DOCUMENTED)) assert.ok(!documented.has(key), `${key} موثّقٌ ومستثنى معاً`);
});

test('المستند لا يذكر مساراً ممنوعاً على المفاتيح، وكل مسار بطريقة معروفة', () => {
  for (const g of API_DOC_GROUPS) {
    for (const e of g.endpoints) {
      assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method), `${e.method} ${e.path}`);
      for (const d of API_DENIED) assert.ok(!(e.path === d.prefix || e.path.startsWith(`${d.prefix}/`)), `ممنوع في المستند: ${e.path}`);
    }
  }
  assert.ok(API_DOC_GROUPS.reduce((n, g) => n + g.endpoints.length, 0) > 50, 'الفهرس ناقص');
  // مسارٌ مكرّر في مجموعتين مقبول (GET /invoices/open في السندات)، لكن لا مرّتين في المجموعة نفسها
  for (const g of API_DOC_GROUPS) {
    const keys = g.endpoints.map((e) => `${e.method} ${e.path}`);
    assert.equal(new Set(keys).size, keys.length, `مكرّر في ${g.key}`);
  }
});

test('المستند لا يكشف مسارات ملفات الخادم الداخلية', () => {
  const all = JSON.stringify([API_DOC_GROUPS, API_DOC_GUIDES]);
  assert.ok(!/\.ts:\d/.test(all), 'مرجع ملف داخلي');
  assert.ok(!all.includes('src/'), 'مسار شيفرة داخلي');
});

/**
 * المفتاح عميلٌ حيّ لا صندوق إرسال: الخادم يمحو X-FS-Replay من طلبه ولا يشتقّ تسامحاً من جسمه (clientRef). فمستندٌ يَعِده
 * بتسامح الصندوق (إسقاطٌ بدل 409/422/400) يكذب عليه — وقد وقع هذا في قواعد POST /customers فناقض مقدمة الفواتير.
 */
test('المستند لا يَعِد المفتاح بتسامح صندوق المندوب: كل ذكرٍ لـX-FS-Replay يقول إنها تُمحى، وclientRef لا يفتح رفض بيانات المشتري', () => {
  const all = JSON.stringify([API_DOC_GROUPS, API_DOC_GUIDES]);
  let seen = 0;
  for (const m of all.matchAll(/x-fs-replay/gi)) {
    seen += 1;
    const around = all.slice(Math.max(0, m.index! - 160), m.index! + 160);
    assert.match(around, /تُمحى|يمحوها/, `ذكرٌ لـX-FS-Replay بلا «تُمحى»: …${around}…`);
  }
  assert.ok(seen >= 3, 'التحذير من الترويسة غاب عن المستند');
  const post = API_DOC_GROUPS.flatMap((g) => g.endpoints).find((e) => e.method === 'POST' && e.path === '/customers')!;
  const zatcaRule = post.rules.find((r) => r.includes('CUSTOMER_ZATCA_INVALID'))!;
  assert.match(zatcaRule, /لطلب المفتاح دائماً ولو أرسلت clientRef/);
});

test('سبب حذف فترة الحضور في الجسم وحده: لا معامل reason في الرابط (نصٌّ حرّ يُكتب في سجلّات الوصول)', () => {
  const del = API_DOC_GROUPS.flatMap((g) => g.endpoints).find((e) => e.method === 'DELETE' && e.path === '/attendance-admin/rows/:id')!;
  assert.deepEqual(del.query, []);
  assert.deepEqual(del.body.map((f) => [f.name, f.required]), [['reason', true]]);
  // والخادم كذلك: المسار يحلّل الجسم وحده
  const src = routeFile('attendanceAdmin');
  const handler = src.slice(src.indexOf("router.delete('/rows/:id'"), src.indexOf("router.get('/presence'"));
  assert.ok(handler.includes('.parse(req.body ?? {})'), 'السبب من الجسم');
  assert.ok(!handler.includes('req.query'), 'لا سبب من الرابط');
});

/* ═══ دليلا ربط صفحتي «لوكيشن» و«طرق الدفع» ═══ */

/** كل نصوص الخادم — رمز خطأ يذكره المستند يجب أن يرسله الخادم حرفياً */
function backendSources(dir: string): string {
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'tests' ? '' : backendSources(p);
    return d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') ? read(p) : '';
  }).join('\n');
}
const BACKEND_SRC = backendSources(BACKEND);
const CODE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

test('أدلّة الربط: صفحة اللوكيشن وصفحة طرق الدفع وصفحة مخزون الشركة وتتبّع اللوط، بخطوات مرقّمة لكلٍّ منها', () => {
  assert.deepEqual(API_DOC_GUIDES.map((g) => g.title), ['ربط صفحة اللوكيشن', 'ربط صفحة طرق الدفع', 'ربط صفحة مخزون الشركة', 'ربط تتبّع LOT']);
  for (const g of API_DOC_GUIDES) {
    assert.ok(g.intro.length > 50, g.key);
    assert.ok(g.steps.length >= 5, `${g.key}: خطوات قليلة`);
    for (const s of g.steps) assert.ok(s.title && s.text, `${g.key}: خطوة ناقصة`);
  }
  // مسارات الصفحتين الأساسية حاضرة في الخطوات
  const stepPaths = new Set(API_DOC_GUIDES.flatMap((g) => g.steps.filter((s) => s.path).map((s) => `${s.method} ${s.path}`)));
  for (const k of ['GET /locations', 'PUT /locations/reps/:salesRepId', 'GET /locations/summary', 'GET /company/payment-methods', 'PUT /company/payment-methods', 'POST /receipts', 'GET /reports/payment-methods',
    'GET /warehouse', 'POST /warehouse/entries', 'GET /warehouse/entries', 'POST /van-stock/loads', 'GET /rep-stock-requests', 'PUT /rep-stock-requests/:id', 'POST /rep-stock-requests/send',
    // دليل «تتبّع اللوط» (المواصفة §٥.٤): الشركة، ثم التفعيل الجماعي، ثم الوارد، ثم التسمية، ثم FEFO والتحميل، ثم الأرصدة، ثم التتبّع، ثم الإيقاف
    'POST /lots/products/tracking', 'POST /lots/relabel', 'GET /lots/fefo', 'GET /lots/balances', 'GET /lots/:id/trace', 'PATCH /lots/:id/status']) {
    assert.ok(stepPaths.has(k), `الدليل لا يذكر ${k}`);
  }
});

test('كل خطوة بمسار موثّقةٌ في الفهرس بطريقتها — والدليل لا يَعِد بمسارٍ لا يعرفه الفهرس', () => {
  for (const g of API_DOC_GUIDES) {
    for (const s of g.steps) {
      if (!s.path && !s.method) continue;
      assert.ok(s.path && s.method, `${g.key}: «${s.title}» طريقة بلا مسار أو العكس`);
      assert.ok(documented.has(`${s.method} ${s.path}`), `${g.key}: ${s.method} ${s.path} غير موثّق في الفهرس`);
    }
  }
});

test('أمثلة curl: العنوان الحيّ والمفتاح الوهمي في الترويسة وحدها — لا مفتاح حقيقي ولا مفتاح في الرابط', () => {
  assert.match(API_DOC_PLACEHOLDER_KEY, /^fsk_x{40}$/);
  for (const g of API_DOC_GUIDES) {
    for (const s of g.steps) {
      if (!s.curl) continue;
      const at = `${g.key}: «${s.title}»`;
      assert.ok(s.curl.startsWith('curl -s '), at);
      assert.ok(s.curl.includes(`"${API_BASE_URL}/`), `${at}: العنوان`);
      assert.ok(s.curl.includes(`-H "Authorization: Bearer ${API_DOC_PLACEHOLDER_KEY}"`), `${at}: المفتاح في الترويسة`);
      const tokens = s.curl.match(/fsk_[A-Za-z0-9_-]+/g) ?? [];
      assert.deepEqual([...new Set(tokens)], [API_DOC_PLACEHOLDER_KEY], `${at}: مفتاحٌ غير الوهمي`);
      const url = /"(https:\/\/[^"]+)"/.exec(s.curl)![1];
      assert.doesNotMatch(url, /fsk_|[?&](api_?key|key|token)=/i, `${at}: مفتاح في الرابط`);
      // الرابط يطابق مسار الخطوة (حتى أول معامل) — مثالٌ لمسار غير الموصوف يضلّل
      if (s.path) {
        const urlPath = url.slice(API_BASE_URL.length).split('?')[0];
        assert.ok(urlPath.startsWith(s.path.split('/:')[0]), `${at}: ${urlPath} ليس ${s.path}`);
      }
      // جسم -d صالح JSON (ما بين <> قيمٌ يملؤها المبرمج داخل نصوص)
      const body = /-d '([^']+)'/.exec(s.curl);
      if (body) assert.doesNotThrow(() => JSON.parse(body[1]), `${at}: جسم JSON غير صالح`);
    }
  }
});

test('كل رمز خطأ في الدليلين وجدول الأخطاء يرسله الخادم حرفياً', () => {
  const guides = JSON.stringify(API_DOC_GUIDES);
  const docs = read(path.join(process.cwd(), 'src', 'components', 'ApiDocs.tsx'));
  // الجدول كله حتى نهاية مصفوفته (ومنه صفّ 503 بعد 429)
  const table = docs.slice(docs.indexOf("['400',"), docs.indexOf('].map(([c, d])', docs.indexOf("['400',")));
  assert.ok(table.length > 200 && table.includes("['503',"), 'جدول الأخطاء');
  const codes = new Set([...guides.matchAll(CODE_RE), ...table.matchAll(CODE_RE)].map((m) => m[0]));
  for (const must of ['LOCATIONS_NOT_ALLOWED', 'PAYMENT_METHODS_NOT_ALLOWED', 'PAYMENT_METHOD_UNKNOWN', 'LOCATION_ARCHIVED', 'PAYMENT_METHODS_CONFLICT',
    'LOTS_NOT_ALLOWED', 'LOTS_DISABLED', 'LOT_STOCK_INSUFFICIENT', 'LOT_REQUIRED', 'LOT_BUSY', 'LOT_SCOPED_USER', 'LOT_CHANGED']) {
    assert.ok(codes.has(must), `الدليل لا يذكر ${must}`);
  }
  const unknown = [...codes].filter((c) => !BACKEND_SRC.includes(`'${c}'`));
  assert.deepEqual(unknown, [], 'رموز لا يعرفها الخادم');
});

test('الدليلان يُرسمان داخل المستند المحمَّل قبل فهرس المسارات', () => {
  const docs = read(path.join(process.cwd(), 'src', 'components', 'ApiDocs.tsx'));
  const refDiv = docs.indexOf('<div ref={ref}');
  const guides = docs.indexOf('API_DOC_GUIDES.map(');
  const catalog = docs.indexOf('API_DOC_GROUPS.map(');
  assert.ok(refDiv > 0 && guides > refDiv && catalog > guides, 'الترتيب: داخل div المستند، الدليلان ثم الفهرس');
  // الأسطر والشرطات في النصوص تبقى أسطراً في الملف المحمَّل (لا صنف tailwind هناك)
  assert.match(docs, /\.api-text\{white-space:pre-line\}/);
});

/** نقطة واحدة في الفهرس بطريقتها ومسارها */
const endpointOf = (method: string, p: string) => {
  const e = API_DOC_GROUPS.flatMap((g) => g.endpoints).find((x) => x.method === method && x.path === p);
  assert.ok(e, `${method} ${p} غير موثّق`);
  return e!;
};
const fieldOf = (e: { body: { name: string; desc: string }[]; query: { name: string; desc: string; type: string }[] }, name: string) => {
  const f = [...e.body, ...e.query].find((x) => x.name === name);
  assert.ok(f, `الحقل ${name} غائب`);
  return f as { name: string; desc: string; type?: string };
};

test('دقّة المستند: وضعا قيد المرتجع كما في الخادم (NEAR_EXPIRY وSTILL_VALID) لا «مدة الإرجاع من البيع»', () => {
  const modes = /RETURN_RULE_MODES = \[([^\]]+)\]/.exec(read(path.join(BACKEND, 'services', 'shelfLife.ts')))![1].match(/[A-Z_]+/g)!;
  assert.deepEqual(modes, ['NEAR_EXPIRY', 'STILL_VALID']);
  const rule = endpointOf('POST', '/invoices').rules.find((r) => r.includes('RETURN_RULE_BLOCKED'))!;
  const blocked = endpointOf('GET', '/invoices/:id/returnable').rules.find((r) => r.startsWith('returnBlocked'))!;
  for (const text of [rule, blocked]) {
    for (const m of modes) assert.ok(text.includes(m), `${m} غائب: ${text.slice(0, 80)}`);
    assert.doesNotMatch(text, /مدة الإرجاع/);
  }
});

test('دقّة المستند: clientCreatedAt لا يصنع يوم المرتجع لطلب المفتاح ولا يُخزَّن، والاستيراد يفحص بيانات المشتري صفاً صفاً', () => {
  assert.match(fieldOf(endpointOf('POST', '/invoices'), 'clientCreatedAt').desc, /لطلب المفتاح لا يُخزَّن/);
  assert.match(fieldOf(endpointOf('POST', '/invoices/:id/credit-note'), 'clientCreatedAt').desc, /لطلب المفتاح لا يُخزَّن/);
  assert.match(fieldOf(endpointOf('POST', '/invoices/:id/debit-note'), 'clientCreatedAt').desc, /لطلب المفتاح لا يُخزَّن/);
  const rule = endpointOf('POST', '/invoices').rules.find((r) => r.includes('RETURN_RULE_BLOCKED'))!;
  assert.match(rule, /clientCreatedAt لا يُقرأ للمفتاح/);
  const imp = endpointOf('POST', '/customers').rules.find((r) => r.includes('/import/customers'))!;
  assert.match(imp, /CUSTOMER_ZATCA_INVALID/);
  // والخادم كذلك: البوابة في مسار الاستيراد مشروطة بهوية المفتاح
  assert.ok(routeFile('import').includes('if (req.user?.apiKeyId) {\n      result.errors.push(...await importBuyerRowsGate(prisma, tid, rows));'));
});

test('دقّة المستند: تقرير التحصيل يعرف ONLINE (سندات روابط الدفع)، ورفع البصمات يرفض المندوب خارج النطاق صفاً لا 404', () => {
  const col = endpointOf('GET', '/reports/collections');
  assert.match(fieldOf(col, 'paymentMethod').type ?? '', /\bONLINE\b/);
  assert.match(col.response, /ONLINE\?:number/);
  // سندات الدفع الإلكتروني يكتبها الخادم بـONLINE
  assert.ok(read(path.join(BACKEND, 'services', 'paylink.ts')).includes("paymentMethod: 'ONLINE'"));

  const imp = endpointOf('POST', '/attendance-admin/import');
  assert.ok(!imp.gates.some((g) => g.includes('404 لغيرهم')), 'الرفع لا يرجع 404 لمندوب خارج النطاق');
  assert.ok(imp.gates.some((g) => g.includes('rejected[]') && g.includes('المندوب غير موجود')));
  assert.ok(routeFile('attendanceAdmin').includes("rejected.push({ index, message: 'المندوب غير موجود' })"));
});

test('دقّة المستند: teamId في الفاتورة والسند يذكر أولوية إشراف صاحب المفتاح كما في resolveDocTeam', () => {
  const teams = read(path.join(BACKEND, 'services', 'teams.ts'));
  const fn = teams.slice(teams.indexOf('export function resolveDocTeam'), teams.indexOf('export function settlementTeamOf'));
  // الإشراف قبل فرق المندوب، ثم المطلوب منها، ثم الوحيد
  const sup = fn.indexOf('if (supervised.length)');
  assert.ok(sup > 0 && sup < fn.indexOf('if (requested && ids.includes(requested))') && fn.indexOf('ids.length === 1') > sup);
  for (const [method, p] of [['POST', '/invoices'], ['POST', '/receipts']]) {
    const d = fieldOf(endpointOf(method, p), 'teamId').desc;
    assert.match(d, /إشراف/, `${p}: أولوية الإشراف غائبة`);
    assert.ok(d.indexOf('١)') < d.indexOf('٢)') && d.indexOf('٢)') < d.indexOf('٣)') && d.indexOf('٣)') < d.indexOf('٤)'), `${p}: الترتيب`);
    assert.match(d, /لا رفض/);
  }
});

/* ═══ الوحدات المتعددة للصنف ═══ */

/** مفاتيح مخطّط zod باسمه في ملف موجّه: `const <name> = z.object({ … });` ⇒ أسماء حقوله العليا */
function zodKeys(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name} = z.object({`);
  assert.ok(start >= 0, `المخطّط ${name} غائب`);
  const body = src.slice(start, src.indexOf('\n});', start));
  return [...body.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);
}

test('دقّة المستند: مسارات وحدات الصنف والتحويل بحقول مخطّطاتها في الخادم حرفياً', () => {
  const products = routeFile('products');
  const bodyOf = (method: string, p: string) => endpointOf(method, p).body.map((f) => f.name).sort();
  assert.deepEqual(bodyOf('POST', '/products/:id/units'), zodKeys(products, 'unitCreateSchema').sort());
  assert.deepEqual(bodyOf('PUT', '/products/:id/units/:unitId'), zodKeys(products, 'unitUpdateSchema').sort());
  assert.deepEqual(bodyOf('POST', '/products/:id/convert-base'), zodKeys(products, 'convertBaseSchema').sort());
  // ورموز الرفض التي يذكرها المستند يرسلها الخادم
  for (const code of ['PRODUCT_UNITS_INVALID', 'BASE_UNIT_CHANGED', 'UNIT_NOT_FOUND', 'PRODUCT_NOT_FOUND']) {
    assert.ok(products.includes(`'${code}'`), `${code} لا يرسله موجّه الأصناف`);
  }
  assert.match(endpointOf('POST', '/products/:id/convert-base').response, /BASE_UNIT_CHANGED/);
  // «تتبّع اللوط» (D22): عدّادات صفوف التشغيلات في converted يرسلها الموجّه بأسمائها، و503 LOT_BUSY لانشغال قفلها
  const convertResp = endpointOf('POST', '/products/:id/convert-base').response;
  for (const k of ['vanLoadItemLots', 'invoiceItemLots', 'lotRelabels']) {
    assert.ok(convertResp.includes(k) && new RegExp(`\\b${k}\\b`).test(products.slice(products.indexOf("router.post('/:id/convert-base'"))), `converted.${k}`);
  }
  assert.match(convertResp, /503 \{code:'LOT_BUSY'\}/);
  // الشرائح بحدودها بالأساس كما في priceTierSchema
  const tiers = endpointOf('PUT', '/products/:id/price-tiers').body.map((f) => f.name);
  for (const k of ['minQty', 'maxQty', 'baseMinQty', 'baseMaxQty', 'price']) assert.ok(tiers.includes(`tiers[].${k}`), `tiers[].${k}`);
  assert.ok(/baseMinQty: z\.number\(\)/.test(products) && /baseMaxQty: z\.number\(\)/.test(products), 'الحدّان بالأساس في مخطّط الشرائح');
});

test('دقّة المستند: unitId في بنود الفاتورة والتحميل والوارد وتعديل طلب البضاعة والإشعار الدائن — وفي مخطّطاتها في الخادم', () => {
  const sites: [string, string, string, string][] = [
    ['POST', '/invoices', 'items[].unitId', 'invoices'],
    ['POST', '/van-stock/loads', 'items[].unitId', 'vanStock'],
    ['POST', '/warehouse/entries', 'items[].unitId', 'warehouse'],
    ['PUT', '/rep-stock-requests/:id', 'items[].unitId', 'repStockRequests'],
    ['POST', '/invoices/:id/credit-note', 'lines[].unitId', 'invoices'],
  ];
  for (const [method, p, field, router] of sites) {
    const f = fieldOf(endpointOf(method, p), field);
    assert.equal((f as { required?: boolean }).required, false, `${p}: unitId اختياري`);
    assert.match(f.desc, /وحدة الأساس/, `${p}: الغياب = الأساس`);
    assert.ok(routeFile(router).includes('unitId: z.string()'), `${router}: unitId ليس في المخطّط`);
  }
  // كل مسارات الكتابة ترفض الوحدة غير الصالحة 400 ولا تقرؤها أساساً بصمت (warehouseStock.ts pickLineUnit)؛ ورمزها UNIT_INVALID
  // في كل مسار كتابة، ومنه POST /van-stock/loads (معالج 4xx في موجّهه يمرّر رمز الوحدة كالمعالج العامّ)
  assert.match(fieldOf(endpointOf('POST', '/invoices'), 'items[].unitId').desc, /400 UNIT_INVALID/);
  assert.ok(BACKEND_SRC.includes("code: 'UNIT_INVALID'"), 'الخادم يرسل UNIT_INVALID');
  const stockSrc = read(path.join(BACKEND, 'services', 'warehouseStock.ts'));
  assert.ok(/if \(!u\) throw new UnitInvalidError\(/.test(stockSrc) && /isActive === false && !opts\.replay\) throw new UnitInvalidError\(/.test(stockSrc), 'pickLineUnit يرفض الغريبة والموقوفة');
  for (const [method, p] of [['POST', '/van-stock/loads'], ['POST', '/warehouse/entries'], ['PUT', '/rep-stock-requests/:id']]) {
    const e = endpointOf(method, p);
    assert.doesNotMatch(fieldOf(e, 'items[].unitId').desc, /بلا رفض/, `${p}: «بلا رفض» كاذبة`);
    assert.match(fieldOf(e, 'items[].unitId').desc, /400/, `${p}: رفض الوحدة غير الصالحة`);
    assert.match(e.response, /400/, `${p}: الرد لا يذكر 400`);
  }
  for (const [method, p] of [['POST', '/van-stock/loads'], ['POST', '/warehouse/entries'], ['PUT', '/rep-stock-requests/:id']]) assert.match(fieldOf(endpointOf(method, p), 'items[].unitId').desc, /UNIT_INVALID/, p);
  // POST /van-stock/loads: معالج موجّهه يردّ وحدة البند غير الصالحة برمزها — والمستند يَعِد به في الحقل والردّ
  assert.ok(routeFile('vanStock').includes("unitInvalid ? { success: false, code: 'UNIT_INVALID', message: err.message }"), 'معالج vanStock تغيّر: راجع رمز الوحدة في المستند');
  assert.doesNotMatch(endpointOf('POST', '/van-stock/loads').response, /بلا code لوحدة/);
  // والإشعار الدائن: معرّفٌ ليس من وحدات الصنف 400 UNIT_INVALID لا «وحدة الأساس»
  const cn = fieldOf(endpointOf('POST', '/invoices/:id/credit-note'), 'lines[].unitId').desc;
  assert.match(cn, /UNIT_INVALID/);
  assert.doesNotMatch(cn, /معرّف لا يخصّ الصنف = وحدة الأساس/);
  // المرتجع المرتبط يقبل الوحدة الموقوفة (allowInactive في invoices.ts)
  assert.ok(routeFile('invoices').includes("allowInactive: body.type === 'RETURN' && !!body.originalInvoiceId"));
  assert.match(fieldOf(endpointOf('POST', '/invoices'), 'items[].unitId').desc, /originalInvoiceId/);
  // الاقتراح والتنبّؤ بالأساس دائماً
  for (const k of ['items[].suggestedQty', 'items[].expectedQty']) assert.match(fieldOf(endpointOf('POST', '/van-stock/loads'), k).desc, /بوحدة الأساس دائماً|بالأساس دائماً/);
});

test('دقّة المستند: ردّ /returnable بحقوله في الخادم، والمرتجع المرتبط يسعّره الخادم لا السعر المرسل', () => {
  const r = endpointOf('GET', '/invoices/:id/returnable');
  const handler = routeFile('invoices').slice(routeFile('invoices').indexOf("router.get('/:id/returnable'"));
  for (const k of ['soldBase', 'returnedBase', 'returnableBase', 'refundPerBase', 'unitName', 'unitFactor', 'lineTotal']) {
    assert.match(r.response, new RegExp(`\\b${k}\\b`), `${k} غائب عن الرد الموثّق`);
    assert.ok(new RegExp(`\\b${k}\\b`).test(handler.slice(0, 6000)), `${k} لا يرسله الخادم`);
  }
  const post = endpointOf('POST', '/invoices');
  assert.ok(!post.rules.some((x) => x.includes('ولا يتحقق من السعر')), 'القاعدة القديمة: الخادم لا يسعّر المرتجع');
  assert.ok(post.rules.some((x) => x.includes('الخادم يسعّر المرتجع المرتبط بنفسه')));
  assert.ok(routeFile('invoices').includes('priceLinkedReturn(body.items'), 'والخادم يسعّره فعلاً');
});

test('دقّة المستند: الأرصدة والتجميعات بالأساس ومعها units — صنفٌ بلا وحدات كما كان', () => {
  for (const [method, p] of [['GET', '/van-stock/current'], ['GET', '/van-stock/suggest'], ['GET', '/warehouse'], ['GET', '/rep-stock-requests']]) {
    assert.match(endpointOf(method, p).response, /units/, `${p}: units غائبة`);
  }
  for (const [method, p] of [['GET', '/van-stock/loads'], ['POST', '/van-stock/loads'], ['POST', '/warehouse/entries'], ['GET', '/warehouse/entries'], ['GET', '/invoices/:id']]) {
    const resp = endpointOf(method, p).response;
    for (const k of ['unitName', 'unitFactor', 'baseQty']) assert.match(resp, new RegExp(k), `${method} ${p}: ${k}`);
  }
  const stock = API_DOC_GROUPS.find((g) => g.key === 'stock')!.overview;
  assert.match(stock, /بوحدة الأساس/);
  assert.match(stock, /اجمع baseQty لا qty/);
  assert.match(API_DOC_GROUPS.find((g) => g.key === 'products')!.overview, /صنفٌ بلا وحدات: units فارغة/);
});

/* ═══ «تتبّع اللوط» (المواصفة §٥.٤، الحزمة B7) ═══ */

/** الحقول العليا لجسمٍ موثّق (بلا الحقول المتداخلة name[].x) */
const topBody = (method: string, p: string) => endpointOf(method, p).body.map((f) => f.name).filter((n) => !n.includes('[')).sort();

test('«تتبّع LOT»: مجموعة lots بمسارات /api/lots كلها بالترتيب، وحرّاسها كما في الموجّه (المندوب ثم المحاسبة ثم العَلَم ثم الصلاحية) ومفتاح القراءة', () => {
  const lots = routeFile('lots');
  const group = API_DOC_GROUPS.find((g) => g.key === 'lots');
  assert.ok(group, 'مجموعة lots غائبة');
  const server = [...lots.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} /lots${m[2] === '/' ? '' : m[2]}`);
  assert.ok(server.length >= 15, `قُرئ ${server.length} مساراً فقط`);
  assert.deepEqual(group!.endpoints.map((e) => `${e.method} ${e.path}`), server, 'كل مسار بترتيب الموجّه (الثابتة قبل /:id)');
  // الحرّاس في الخادم بهذا الترتيب، والمستند يذكرها لكل مسار
  const order = ["req.user?.role === 'SALES_REP'", 'router.use(requireLots);', "router.use(requireAdminPermission('canManageVanStock'));"].map((s) => lots.indexOf(s));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'ترتيب حرّاس الموجّه');
  for (const e of group!.endpoints) {
    const at = `${e.method} ${e.path}`;
    const gates = e.gates.join(' | ');
    assert.ok(e.gates[0].includes('لا مندوب'), `${at}: رفض المندوب أولاً`);
    assert.ok(gates.indexOf('ACCOUNTING_NOT_ALLOWED') >= 0 && gates.indexOf('ACCOUNTING_NOT_ALLOWED') < gates.indexOf('LOTS_NOT_ALLOWED'), `${at}: المحاسبة قبل العَلَم`);
    assert.match(gates, /canManageVanStock/, at);
    if (e.method === 'GET') assert.match(gates, /مسموح لمفتاح القراءة فقط/, at);
    else assert.match(gates, /API_KEY_FORBIDDEN/, `${at}: مفتاح القراءة فقط`);
  }
  // الصلاحيات الإضافية في الخادم والمستند
  assert.ok(lots.includes("router.post('/products/tracking', requireAdminPermission('canManageProducts')"));
  assert.ok(lots.includes("router.put('/settings', requireAdminPermission('canManageCompanySettings')"));
  assert.match(endpointOf('POST', '/lots/products/tracking').permission, /canManageProducts/);
  assert.match(endpointOf('PUT', '/lots/settings').permission, /canManageCompanySettings/);
  assert.match(endpointOf('GET', '/lots/:id/trace').permission, /canManageCustomers/);
  // مقدمة المجموعة: العَلَم والصلاحيات والنطاق واليقين وlotId = null والكمية الأساسية والتسامح الذي لا يناله المفتاح والحجز والحقبة
  for (const k of ['lotTrackingEnabled', 'canManageVanStock', 'LOT_SCOPED_USER', 'CONFIRMED', 'ASSUMED', 'UNKNOWN', 'lotId = null', 'بوحدة الأساس', 'X-FS-Replay', 'held', 'الحقبة', 'LOT_BUSY']) {
    assert.ok(group!.overview.includes(k), `المقدمة لا تذكر ${k}`);
  }
});

test('«تتبّع LOT»: أجسام مسارات الكتابة بحقول مخطّطاتها في الموجّه حرفياً', () => {
  const lots = routeFile('lots');
  assert.deepEqual(topBody('POST', '/lots'), zodKeys(lots, 'createSchema').sort());
  assert.deepEqual(topBody('POST', '/lots/relabel'), zodKeys(lots, 'relabelSchema').sort());
  assert.deepEqual(topBody('POST', '/lots/products/tracking'), zodKeys(lots, 'trackingSchema').sort());
  assert.deepEqual(topBody('PATCH', '/lots/:id'), zodKeys(lots, 'updateSchema').sort());
  assert.deepEqual(topBody('PATCH', '/lots/:id/status'), zodKeys(lots, 'statusSchema').sort());
  assert.deepEqual(topBody('PUT', '/lots/settings'), ['lotOnInvoice']);
  assert.ok(lots.includes('z.object({ lotOnInvoice: z.boolean() })'));
  // أسطر التسمية المتداخلة
  const relabel = lots.slice(lots.indexOf('const relabelSchema = z.object({'), lots.indexOf('\n});', lots.indexOf('const relabelSchema = z.object({')));
  const nested = endpointOf('POST', '/lots/relabel').body.map((f) => f.name).filter((n) => n.startsWith('lines[].')).map((n) => n.slice('lines[].'.length)).sort();
  assert.deepEqual(nested, ['expiryDate', 'lotNumber', 'productionDate', 'qty', 'toLotId']);
  for (const k of nested) assert.match(relabel, new RegExp(`^ {4}${k}: (z\\.|dateField,)`, 'm'), `lines[].${k} ليس في المخطّط`);
  // ومعاملات القراءة يقرؤها الخادم
  for (const [p, keys] of [['/lots', ['q', 'productId', 'status', 'expiringWithinDays', 'page', 'limit']], ['/lots/balances', ['productId', 'productIds', 'asOf']],
    ['/lots/fefo', ['productId', 'qty', 'unitFactor', 'lines', 'salesRepId']], ['/lots/:id/trace', ['scope']], ['/lots/:id/events', ['limit']]] as [string, string[]][]) {
    assert.deepEqual(endpointOf('GET', p).query.map((f) => f.name), keys, p);
    for (const k of keys) assert.ok(lots.includes(`req.query.${k}`), `${p}: الخادم لا يقرأ ${k}`);
  }
});

test('«تتبّع LOT»: حقول التشغيلات في المسارات القائمة موثّقة وفي مخطّطات الخادم، وwithLots حيث يقرؤه', () => {
  const sites: [string, string, string, string, RegExp][] = [
    ['POST', '/invoices', 'items[].lots', 'invoices', /\blots: z\.unknown\(\)\.optional\(\)/],
    ['POST', '/van-stock/loads', 'items[].lots', 'vanStock', /\blots: z\.unknown\(\)\.optional\(\)/],
    ['POST', '/van-stock/loads', 'items[].lotNumber', 'vanStock', /\blotNumber: z\.unknown\(\)\.optional\(\)/],
    ['POST', '/van-stock/loads', 'items[].productionDate', 'vanStock', /\bproductionDate: z\.unknown\(\)\.optional\(\)/],
    ['POST', '/van-stock/loads', 'items[].expiryDate', 'vanStock', /\bexpiryDate: z\.unknown\(\)\.optional\(\)/],
    ['POST', '/van-stock/loads', 'items[].lotReason', 'vanStock', /\blotReason: z\.unknown\(\)\.optional\(\)/],
    ['POST', '/van-stock/loads', 'deletedSalesRepId', 'vanStock', /\bdeletedSalesRepId: z\.string\(\)\.optional\(\)/],
    ['POST', '/warehouse/entries', 'items[].lotId', 'warehouse', /\blotId: z\.string\(\)/],
    ['POST', '/warehouse/entries', 'items[].lotNumber', 'warehouse', /\blotNumber: z\.string\(\)/],
    ['POST', '/warehouse/entries', 'items[].productionDate', 'warehouse', /\bproductionDate: z\.string\(\)/],
    ['POST', '/warehouse/entries', 'items[].expiryDate', 'warehouse', /\bexpiryDate: z\.string\(\)/],
    ['POST', '/products', 'lotTracked', 'products', /\blotTracked: z\.boolean\(\)/],
    ['PUT', '/products/:id', 'lotTracked', 'products', /\blotTracked: z\.boolean\(\)/],
    ['PUT', '/products/:id', 'confirmLotBalances', 'products', /\bconfirmLotBalances: z\.boolean\(\)/],
  ];
  for (const [method, p, field, router, schema] of sites) {
    const f = fieldOf(endpointOf(method, p), field) as { required?: boolean; desc: string };
    assert.equal(f.required, false, `${method} ${p} ${field}: اختياري (المطفأة كما كانت)`);
    assert.ok(schema.test(routeFile(router)), `${router}: ${field} ليس في المخطّط`);
  }
  // الكمية الأساسية في كل صفوف التشغيلات الصريحة
  for (const [method, p] of [['POST', '/invoices'], ['POST', '/van-stock/loads']]) assert.match(fieldOf(endpointOf(method, p), 'items[].lots').desc, /بالكمية الأساسية/);
  // withLots: موثّق حيث يقرؤه الخادم
  for (const [method, p, router] of [['GET', '/invoices/:id', 'invoices'], ['GET', '/invoices/by-client-ref/:clientRef', 'invoices'], ['GET', '/invoices/:id/returnable', 'invoices'],
    ['GET', '/van-stock/loads', 'vanStock'], ['GET', '/van-stock/movements', 'vanStock'], ['GET', '/reports/returns', 'reports'],
    // POST /invoices: ردّ تكرار clientRef (المبكر وسباق P2002) يحمل التوزيع بـwithLots=1 وحده
    ['POST', '/invoices', 'invoices']]) {
    assert.match(fieldOf(endpointOf(method, p), 'withLots').desc, /يُهمل[^.]*مطفأة|مفعّلة للشركة، وإلا يُهمل/, `${p}: withLots يُهمل والميزة مطفأة`);
    assert.ok(/withLots/.test(routeFile(router)), `${router} لا يقرأ withLots`);
  }
  // والخادم: مسارا التكرار في POST /invoices يقرآن wantsLots
  const invSrc = routeFile('invoices');
  const postInv = invSrc.slice(invSrc.indexOf("router.post('/', "), invSrc.indexOf("router.patch('/:id/cancel'"));
  assert.ok(postInv.length > 1000 && (postInv.match(/\(await wantsLots\(req, tid2?\)\) \? \{ include: ITEM_LOTS_INCLUDE \} : true/g) ?? []).length >= 2, 'ردّا التكرار في POST /invoices بـwithLots');
  // والمطفأة تتجاهله كما تقول مقدمة المجموعة (D8 يُخفي ولا يحذف): كل قراءةٍ لـwithLots في الخادم مقرونةٌ بعَلَم الشركة —
  // وإلا كشفت فواتيرُ شركةٍ أطفأت الميزة صفوفَ حقبتها السابقة
  for (const router of ['invoices', 'vanStock', 'reports']) {
    const src = routeFile(router);
    const reads = [...src.matchAll(/req\.query\.withLots\b/g)];
    assert.ok(reads.length > 0, router);
    for (const m of reads) {
      const near = src.slice(Math.max(0, m.index! - 300), m.index! + 400);
      assert.ok(/lotTrackingEnabled|lotTrackingOn\(/.test(near), `${router}: withLots بلا عَلَم الشركة`);
    }
  }
  assert.match(API_DOC_GROUPS.find((g) => g.key === 'lots')!.overview, /withLots يُتجاهل/, 'المقدمة: المطفأة تتجاهل withLots');
  // ولا وعدٌ مطلق بأن المطفأة «لا تغيّر شيئاً في أي مسار» (الأعمدة الجديدة تظهر بقيمها الافتراضية) — في المقدمة ولا في الدليل
  const lotsGuideIntro = API_DOC_GUIDES.find((g) => g.key === 'lots-guide')!.intro;
  assert.match(lotsGuideIntro, /withLots يُتجاهل/, 'الدليل: المطفأة تتجاهل withLots');
  for (const t of [API_DOC_GROUPS.find((g) => g.key === 'lots')!.overview, lotsGuideIntro]) assert.ok(!/لا تغيّر شيئاً في أي مسار/.test(t), 'وعدٌ مطلق كاذب');
  // الأعلام في /company كما يرسلها الخادم
  const company = routeFile('company');
  for (const k of ['lotTrackingEnabled', 'lotOnInvoice']) {
    assert.match(endpointOf('GET', '/company').response, new RegExp(`\\b${k}\\b`));
    assert.ok(company.includes(`${k}:`), `company.ts لا يرسل ${k}`);
  }
});

test('«تتبّع LOT»: القواعد التي صارت كاذبة للصنف المتتبَّع مصحّحة — لا بيع للمفتاح فوق المخزون، ولا «لا فحص» ولا مستودع سالب بلا استثناء', () => {
  const sellRule = endpointOf('POST', '/invoices').rules.find((r) => r.includes('المفتاح يستطيع البيع بأكثر من مخزون السيارة'))!;
  assert.match(sellRule, /LOT_STOCK_INSUFFICIENT/);
  assert.match(sellRule, /canSellWithoutStock/);
  const noCheck = endpointOf('POST', '/van-stock/loads').rules.find((r) => r.startsWith('لا فحص لتوفر الكمية'))!;
  assert.match(noCheck, /LOT_STOCK_INSUFFICIENT/);
  const negative = endpointOf('GET', '/warehouse').rules.find((r) => r.includes('قد يصيران سالبين'))!;
  assert.match(negative, /LOT_STOCK_INSUFFICIENT/);
  const guide = API_DOC_GUIDES.find((g) => g.key === 'warehouse-guide')!;
  for (const needle of ['وقد يصير سالباً', 'لا فحص لتوفر الكمية']) {
    const step = guide.steps.map((s) => s.text).join('\n').split('\n').find((l) => l.includes(needle))!;
    assert.match(step, /LOT_STOCK_INSUFFICIENT/, needle);
  }
  // «البيع بدون مخزون» (PATCH /van-stock/sell-permission) ومتبقّي السيارة السالب: الإذن لا يُعفي الصنف المتتبَّع، والقفل لكل مُصدِر ومنه المفتاح
  const perm = endpointOf('PATCH', '/van-stock/sell-permission');
  assert.match(fieldOf(perm, 'canSellWithoutStock').desc, /LOT_STOCK_INSUFFICIENT/, 'canSellWithoutStock: الإذن لا يُعفي المتتبَّع');
  const permRule = (start: string) => perm.rules.find((r) => r.startsWith(start))!;
  assert.match(permRule('عند false'), /LOT_STOCK_INSUFFICIENT/, 'رفض المندوب للمتتبَّع 409 لا 403');
  assert.match(permRule('القيد لا يسري'), /LOT_STOCK_INSUFFICIENT/, 'الإدارة والمفتاح مقيّدان بالتشغيلات');
  const negRemaining = endpointOf('GET', '/van-stock/current').rules.find((r) => r.startsWith('remaining قد يكون سالباً'))!;
  assert.match(negRemaining, /LOT_STOCK_INSUFFICIENT/);
  assert.match(negRemaining, /قبل التفعيل/, 'المتتبَّع لا يصير سالباً إلا من تاريخ ما قبل التفعيل');
  // وكل نصٍّ في المستند يَعِد بالبيع فوق المخزون بهذا الإذن يذكر استثناء المتتبَّع
  for (const g of API_DOC_GROUPS) {
    for (const e of g.endpoints) {
      const texts = [...e.rules, ...e.body.map((f) => `${f.name}: ${f.desc}`), ...e.query.map((f) => `${f.name}: ${f.desc}`)];
      for (const t of texts) {
        if (/canSellWithoutStock/.test(t) && /(فوق|بأكثر من|سالباً)/.test(t)) assert.match(t, /LOT_STOCK_INSUFFICIENT/, `${e.method} ${e.path}: ${t.slice(0, 80)}`);
      }
    }
  }
});

test('«تتبّع LOT»: حدث الشركة في lot-events (productId الحرفي من الخادم وbefore/after بعَلَم الشركة) موثّقٌ في المورد ومسار السجل والدليل', () => {
  const tenants = read(path.join(ROUTES, 'tenants.ts'));
  const m = /export const TENANT_LOT_EVENT_PRODUCT = '([^']+)';/.exec(tenants);
  assert.ok(m, 'TENANT_LOT_EVENT_PRODUCT في tenants.ts');
  const star = `productId = "${m![1]}"`;
  // ما يكتبه الخادم لحدث الشركة: lotId null وعَلَم الشركة وحقبتها
  assert.ok(/lotId: null, productId: TENANT_LOT_EVENT_PRODUCT/.test(tenants));
  assert.ok(/before: \{ lotTrackingEnabled:/.test(tenants) && /after: \{ lotTrackingEnabled: [^}]*lotTrackingSince:/.test(tenants));
  const lotEvents = API_SYNC_RESOURCES.find((r) => r.name === 'lot-events')!.what;
  const eventsRules = endpointOf('GET', '/lots/:id/events').rules.join('\n');
  const guideSync = API_DOC_GUIDES.find((g) => g.key === 'lots-guide')!.steps.map((s) => s.text).join('\n');
  for (const [where, text] of [['API_SYNC_RESOURCES lot-events', lotEvents], ['GET /lots/:id/events', eventsRules], ['lots-guide', guideSync]] as [string, string][]) {
    assert.ok(text.includes(star), `${where}: لا يذكر ${star}`);
    for (const k of ['lotTrackingEnabled', 'lotTrackingSince', 'lotTracked', 'lotTrackedSince']) assert.ok(new RegExp(`\\b${k}\\b`).test(text), `${where}: لا يذكر ${k}`);
  }
});

test('«تتبّع LOT»: موارد المزامنة الخمسة في المستند، وأعمدة LOT الشرطية في products وvan-loads وwarehouse-entries كما في الخادم', () => {
  const names = API_SYNC_RESOURCES.map((r) => r.name);
  for (const n of ['product-lots', 'van-load-item-lots', 'invoice-item-lots', 'lot-relabels', 'lot-events']) assert.ok(names.includes(n), n);
  const what = (n: string) => API_SYNC_RESOURCES.find((r) => r.name === n)!.what;
  assert.match(what('product-lots'), /LOTS_DISABLED/);
  assert.match(what('products'), /lotTracked/);
  assert.match(what('van-loads'), /\bid\b/);
  assert.match(what('warehouse-entries'), /lotId/);
  const sync = read(path.join(BACKEND, 'services', 'apiSync.ts'));
  assert.ok(sync.includes("lotSelect: { lotTracked: true }"), 'products.lotSelect');
  assert.ok(sync.includes("lotSelect: { items: { select: pick('id') } }"), 'van-loads.lotSelect');
  assert.ok(sync.includes("lotSelect: { items: { select: pick('id', 'lotId') } }"), 'warehouse-entries.lotSelect');
  // ونصيحة التحويل تشمل موارد التشغيلات بطابع الإنشاء
  const convert = endpointOf('POST', '/products/:id/convert-base').rules.join('\n');
  for (const r of ['van-load-item-lots', 'invoice-item-lots', 'lot-relabels']) assert.ok(convert.includes(`/v1/sync/${r}`), `convert-base لا يذكر ${r}`);
});

test('«تتبّع LOT» (D9): حقول التشغيلة لصنفٍ غير متتبَّع والميزة مفعّلة 422 NOT_TRACKED لا «تُهمل»، وخطة التنزيل [] له، وLOT_BUSY في المسار غير المتتبَّع — كما في الخادم', () => {
  // الخادم: الرمز القائم بسبب NOT_TRACKED، ومساره في السيارة والمستودع، وانشغال معاملة المسار غير المتتبَّع ⇒ LOT_BUSY
  const lotsVan = read(path.join(BACKEND, 'services', 'lotsVan.ts'));
  assert.ok(/new LotError\('LOT_PRODUCT_MISMATCH'[^;]*reason: 'NOT_TRACKED'/s.test(lotsVan), 'lotOnUntrackedError في lotsVan.ts');
  for (const router of ['vanStock', 'warehouse']) {
    const src = routeFile(router);
    assert.ok(src.includes('lotOnUntrackedError('), `${router}: لا رفض NOT_TRACKED`);
    const at = src.lastIndexOf('assertStillUntracked(tx, tid, productIds)');
    assert.ok(at > 0 && /\.catch\((busy|\(e: unknown\) => \{ throw asLotBusy\(e\) \?\? e; \})\)/.test(src.slice(at, at + 400)), `${router}: P2028 في المسار غير المتتبَّع ليس LOT_BUSY`);
  }
  for (const [p, fields] of [
    ['/van-stock/loads', ['items[].lots', 'items[].lotNumber', 'items[].productionDate', 'items[].expiryDate', 'items[].lotReason']],
    ['/warehouse/entries', ['items[].lotId', 'items[].lotNumber', 'items[].productionDate', 'items[].expiryDate']],
  ] as [string, string[]][]) {
    const e = endpointOf('POST', p);
    // لا وصف حقل تشغيلة يَعِد بإهماله لغير المتتبَّع (صار 422 والميزة مفعّلة)
    for (const f of fields) assert.ok(!/يُهمل لغيره/.test(fieldOf(e, f).desc), `${p} ${f}: «يُهمل لغيره» كاذبة والميزة مفعّلة`);
    assert.match(fieldOf(e, fields[0]).desc, /422 LOT_PRODUCT_MISMATCH[^)]*NOT_TRACKED/, `${p} ${fields[0]}`);
    const rule = e.rules.find((r) => r.includes("reason:'NOT_TRACKED'"));
    assert.ok(rule, `${p}: قاعدة NOT_TRACKED غائبة`);
    assert.match(rule!, /422 \{code:'LOT_PRODUCT_MISMATCH', detail:\{productId, idx, reason:'NOT_TRACKED'\}\}/);
    assert.match(rule!, /والميزة مطفأة تُهمل هذه الحقول/, `${p}: المطفأة تُهملها كما كانت`);
    const busy = e.rules.find((r) => r.startsWith('«تتبّع LOT» — الانشغال'));
    assert.ok(busy, `${p}: قاعدة الانشغال`);
    assert.match(busy!, /TRACKING_CHANGED/);
    assert.match(busy!, /غير متتبَّعة والميزة مفعّلة/, `${p}: LOT_BUSY للمسار غير المتتبَّع تحت الضغط`);
  }
  // خطة التنزيل فارغة لصنفٍ أُطفئ تتبّعه — في المستند كما في الخادم
  assert.ok(/lotTracked !== true\) return \[\];/.test(read(path.join(BACKEND, 'services', 'lotsTrace.ts'))), 'unloadPlan لا يعيد [] لغير المتتبَّع');
  const plan = endpointOf('GET', '/lots/:id/unload-plan');
  assert.match(plan.response, /و\[\] لتشغيلة صنفٍ أُطفئ تتبّعه/);
  assert.ok(plan.rules.some((r) => r.includes('[]') && r.includes('NOT_TRACKED')), 'unload-plan: التنزيل بـLOT لغير المتتبَّع 422');
  // الإشعار الدائن (المرحلة الثانية) من المسارات التي تردّ LOT_BUSY TRACKING_CHANGED
  assert.ok(/TRACKING_CHANGED|assertLockedStillUntracked/.test(routeFile('invoicesNotes')), 'invoicesNotes بلا حارس TRACKING_CHANGED');
  assert.ok(endpointOf('POST', '/invoices/:id/credit-note').rules.some((r) => /LOT_BUSY[^"]*TRACKING_CHANGED/.test(r)), 'credit-note: TRACKING_CHANGED');
});

test('أرقام أقسام الأدلّة وأيقوناتها تكفي كل دليل والفهرس بعدها', () => {
  const docs = read(path.join(process.cwd(), 'src', 'components', 'ApiDocs.tsx'));
  const nums = /const GUIDE_NUMBERS = \[([^\]]+)\]/.exec(docs)![1].match(/'[^']+'/g)!;
  assert.ok(nums.length >= API_DOC_GUIDES.length + 1, `GUIDE_NUMBERS ${nums.length} لـ${API_DOC_GUIDES.length} أدلّة والفهرس`);
  const icons = docs.slice(docs.indexOf('const GUIDE_ICONS'), docs.indexOf('};', docs.indexOf('const GUIDE_ICONS')));
  for (const g of API_DOC_GUIDES) assert.ok(icons.includes(`'${g.key}':`), `${g.key} بلا أيقونة`);
});

/* ═══ «استيراد البيانات» (/api/import): مفتوحٌ للمفتاح ومدخل الوحدات والتشغيلات بالجملة ═══ */

test('الاستيراد: مجموعة import بمسارات الموجّه كلها بالترتيب، وأجسامها ومعاملاتها بحقول مخطّطات zod حرفياً', () => {
  const src = routeFile('import');
  const group = API_DOC_GROUPS.find((g) => g.key === 'import');
  assert.ok(group, 'مجموعة import غائبة');
  const server = [...src.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} /import${m[2]}`);
  assert.equal(server.length, 8, `قُرئ ${server.length} مساراً`);
  assert.deepEqual(group!.endpoints.map((e) => `${e.method} ${e.path}`), server, 'كل مسار بترتيب الموجّه');
  for (const [p, bodySchema, rowSchema] of [
    ['/import/customers', 'customersBody', 'customerRow'], ['/import/products', 'productsBody', 'productRow'],
    ['/import/balances', 'balancesBody', 'balanceRow'], ['/import/ledger', 'ledgerBody', 'ledgerRow'],
    ['/import/prices', 'pricesBody', 'priceRow'], ['/import/opening-stock', 'openingStockBody', 'openingStockRow'],
  ] as [string, string, string][]) {
    const names = endpointOf('POST', p).body.map((f) => f.name);
    assert.deepEqual(names.filter((n) => !n.includes('[')).sort(), zodKeys(src, bodySchema).sort(), `${p}: الجسم`);
    assert.deepEqual(names.filter((n) => /^rows\[\]\.\w+$/.test(n)).map((n) => n.slice('rows[].'.length)).sort(), zodKeys(src, rowSchema).sort(), `${p}: الصف`);
  }
  // الوحدات المتداخلة في صف المنتج
  const at = src.indexOf('const productRow = z.object({');
  const unitKeys = [...src.slice(at, src.indexOf('\n});', at)).matchAll(/^ {4}(\w+): z\./gm)].map((m) => m[1]).sort();
  assert.deepEqual(unitKeys, ['factor', 'name', 'price', 'unitCode']);
  assert.deepEqual(endpointOf('POST', '/import/products').body.map((f) => f.name).filter((n) => n.startsWith('rows[].units[].'))
    .map((n) => n.slice('rows[].units[].'.length)).sort(), unitKeys);
  assert.deepEqual(endpointOf('GET', '/import/batches').query.map((f) => f.name).sort(), zodKeys(src, 'batchesQuery').sort());
  // حدود الدفعة كما في الموجّه
  const limits = /IMPORT_ROW_LIMITS = \{ customers: (\d+), products: (\d+), balances: (\d+), ledger: (\d+), prices: (\d+) \}/.exec(src);
  assert.ok(limits, 'IMPORT_ROW_LIMITS');
  for (const [i, p] of ['/import/customers', '/import/products', '/import/balances', '/import/ledger', '/import/prices'].entries()) {
    assert.ok(fieldOf(endpointOf('POST', p), 'rows').desc.includes(limits![i + 1]), `${p}: الحدّ ${limits![i + 1]}`);
  }
  assert.ok(src.includes('rows: z.array(openingStockRow).min(1).max(5000)'));
  // الحرّاس: مفتاح القراءة فقط يبلغ السجلّ وحده، والتراجع بصلاحية الحذف
  for (const e of group!.endpoints) {
    assert.match(e.gates.join(' | '), e.method === 'GET' ? /مسموح لمفتاح القراءة فقط/ : /API_KEY_FORBIDDEN/, `${e.method} ${e.path}`);
  }
  assert.ok(src.includes("router.post('/batches/:id/revert', requireAdminPermission('canDelete')"));
  assert.match(endpointOf('POST', '/import/batches/:id/revert').permission, /canDelete/);
});

test('الاستيراد: كل رمز خطأ صفٍّ وكل رمز رفضٍ ترسله وحدات الاستيراد موثّقٌ في مجموعتها، وكل رمزٍ فيها يرسله الخادم حرفياً', () => {
  const text = JSON.stringify(API_DOC_GROUPS.find((g) => g.key === 'import'));
  const ledger = read(path.join(BACKEND, 'services', 'importLedger.ts'));
  const start = ledger.indexOf('export const IMPORT_ROW_MESSAGES');
  const rowCodes = [...ledger.slice(start, ledger.indexOf('};', start)).matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);
  assert.ok(rowCodes.length >= 24, `قُرئ ${rowCodes.length} رمز صفّ فقط`);
  const thrown = new Set<string>([...rowCodes, 'CUSTOMER_ZATCA_INVALID']);
  for (const f of [routeFile('import'), ledger, read(path.join(BACKEND, 'services', 'importAccess.ts'))]) {
    for (const m of f.matchAll(/ImportHttpError\(\d{3}, '([A-Z_]+)'/g)) thrown.add(m[1]);
    for (const m of f.matchAll(/code: '([A-Z][A-Z0-9_]+)'/g)) thrown.add(m[1]);
  }
  assert.ok(thrown.size >= 45, `قُرئ ${thrown.size} رمزاً فقط`);
  const missing = [...thrown].filter((c) => !new RegExp(`\\b${c}\\b`).test(text));
  assert.deepEqual(missing, [], 'رموزٌ يرسلها الاستيراد غائبة عن مجموعته');
  const unknown = [...new Set([...text.matchAll(CODE_RE)].map((m) => m[0]))].filter((c) => !BACKEND_SRC.includes(`'${c}'`));
  assert.deepEqual(unknown, [], 'رموزٌ في مجموعة الاستيراد لا يعرفها الخادم');
  // أسباب التخطّي في الردود كما في الخادم
  for (const c of ['CODE_EXISTS', 'PHONE_EXISTS', 'NAME_EXISTS', 'CODE_ATTACHABLE', 'CODE_AMBIGUOUS_NAME', 'DUPLICATE_IN_FILE', 'PRODUCT_ARCHIVED', 'DUPLICATE_PAIR']) {
    assert.ok(text.includes(c), `سبب التخطّي ${c}`);
  }
});

test('الاستيراد: عقد التاريخ dateContract برسالة المفتاح حرفياً، والوحدات والتشغيلات في صفوفها، والتراجع يحرس التشغيلات', () => {
  const src = routeFile('import');
  const contract = /const IMPORT_DATE_CONTRACT = '([^']+)';/.exec(src)![1];
  const keyMsg = /const IMPORT_DATE_CONTRACT_KEY_MESSAGE = `([^`]+)`;/.exec(src)![1].replace('${IMPORT_DATE_CONTRACT}', contract);
  assert.equal(contract, 'local-ymd-v2');
  assert.ok(src.includes('assertImportDateContract(body.dateContract, !!req.user?.apiKeyId);'), 'رسالة المفتاح لطلب المفتاح');
  for (const p of ['/import/balances', '/import/ledger']) {
    const f = fieldOf(endpointOf('POST', p), 'dateContract') as { required?: boolean; desc: string };
    assert.equal(f.required, true, `${p}: dateContract إلزامي`);
    assert.ok(f.desc.includes(keyMsg), `${p}: رسالة المفتاح`);
    assert.match(f.desc, /IMPORT_CLIENT_OUTDATED/);
    assert.match(endpointOf('POST', p).response, /expected:'local-ymd-v2', received/);
  }
  // الوحدات: units[] في المنتجات وunit في الأسعار والجرد، وUNIT_NOT_FOUND لا أساسٌ صامت
  assert.match(fieldOf(endpointOf('POST', '/import/prices'), 'rows[].unit').desc, /الأساس/);
  assert.ok(endpointOf('POST', '/import/prices').rules.some((r) => r.includes('UNIT_NOT_FOUND') && r.includes('موقوفة')));
  assert.ok(endpointOf('POST', '/import/prices').rules.some((r) => r.includes('بست منازل')), 'سعر الوحدة ÷ المعامل بست منازل');
  assert.ok(src.includes('roundHalfUp(w.price / w.unitFactor, 6)'));
  assert.ok(endpointOf('POST', '/import/opening-stock').rules.some((r) => r.includes('UNIT_NOT_FOUND') && r.includes('baseQty')));
  assert.ok(endpointOf('POST', '/import/products').rules.some((r) => r.includes('PRODUCT_UNIT_INVALID')));
  // «تتبّع LOT»: أعمدة الجرد وتحذيره ورفض التراجع وحذف اليتيمة
  const stock = endpointOf('POST', '/import/opening-stock');
  for (const k of ['rows[].lotNumber', 'rows[].productionDate', 'rows[].expiryDate']) assert.match(fieldOf(stock, k).desc, /«تتبّع LOT»/);
  assert.match(stock.response, /LOT_INTO_BLOCKED', productId, detail:\{row, lotId, lotNumber, blockKind\}/);
  assert.ok(stock.rules.some((r) => r.includes('OPENING_IMPORT')) && stock.rules.some((r) => /مطفأة تُتجاهل أعمدة التشغيلة/.test(r)));
  const used = /export const OPENING_LOTS_USED_MESSAGE = '([^']+)'/.exec(read(path.join(BACKEND, 'services', 'lotsWarehouse.ts')))![1];
  const revert = endpointOf('POST', '/import/batches/:id/revert').rules.join('\n');
  assert.ok(revert.includes(used), 'سبب منع التراجع حرفياً');
  assert.match(revert, /product-lots\/ids/);
  assert.match(revert, /DELETE/);
  // ولا يُذكر حارسٌ أُسقط من الخادم (الإقرار بتاريخ البدء لا أثر له اليوم)
  assert.ok(!/OPENING_STOCK_AFTER_CUTOVER/.test(JSON.stringify(stock)));
  assert.ok(!src.includes("'OPENING_STOCK_AFTER_CUTOVER'"));
});

test('دقّة المستند: كل رمز يرسله موجّه الأصناف موثّقٌ، وconvert-base مقيّد بجلسة الدعم للمفتاح، وأعمدة الصلاحية في الجسمين', () => {
  const products = routeFile('products');
  const all = JSON.stringify(API_DOC_GROUPS);
  const codes = [...new Set([...products.matchAll(/'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)].map((m) => m[1]))];
  assert.ok(codes.length >= 6, `قُرئ ${codes.length} رمزاً فقط`);
  assert.deepEqual(codes.filter((c) => !new RegExp(`\\b${c}\\b`).test(all)), [], 'رموز موجّه الأصناف غائبة عن المستند');
  // التقييد في الخادم قبل الجسم، والمستند يقوله في الحرّاس والرد ولا يدلّ المفتاح عليه كمسارٍ عادي
  const h = products.slice(products.indexOf("router.post('/:id/convert-base'"));
  const gate = h.indexOf("code: 'CONVERT_BASE_OWNER_ONLY'");
  assert.ok(gate > 0 && gate < h.indexOf('convertBaseSchema.parse') && h.slice(0, gate).includes('if (!isOwnerSession(req))'), 'الحارس قبل الجسم');
  const cb = endpointOf('POST', '/products/:id/convert-base');
  assert.ok(cb.gates.some((g) => g.includes('CONVERT_BASE_OWNER_ONLY')));
  assert.match(cb.response, /^403 \{success:false, code:'CONVERT_BASE_OWNER_ONLY'/);
  assert.match(fieldOf(endpointOf('PUT', '/products/:id'), 'unit').desc, /CONVERT_BASE_OWNER_ONLY/);
  assert.match(API_DOC_GROUPS.find((g) => g.key === 'products')!.overview, /CONVERT_BASE_OWNER_ONLY/);
  // أعمدة الصلاحية وقيد المرتجع في الجسمين كما في المخطّط
  const schemaKeys = zodKeys(products, 'productSchema');
  for (const k of ['shelfLifeBasis', 'shelfLifeFromDate', 'returnRuleEnabled', 'returnRuleMode', 'returnRuleMetric', 'returnRuleValue',
    'repSaleAllowed', 'repReturnAllowed', 'repSaleUnit', 'repReturnUnit']) {
    assert.ok(schemaKeys.includes(k), `${k} ليس في productSchema`);
    fieldOf(endpointOf('POST', '/products'), k);
    fieldOf(endpointOf('PUT', '/products/:id'), k);
  }
  assert.ok(!endpointOf('POST', '/products').rules.some((r) => r.includes('لا يُتحقق منه')), 'categoryId يُتحقق منه الآن');
  assert.ok(products.includes("res.status(400).json({ success: false, message: 'التصنيف غير موجود' })"));
});

test('«تتبّع LOT»: قيم detail.reason وdetail.mode في مقدمة مجموعة lots هي ما يرسله الخادم حرفياً', () => {
  const overview = API_DOC_GROUPS.find((g) => g.key === 'lots')!.overview;
  const lotsSrc = ['lots.ts', 'lotsVan.ts', 'lotsInvoice.ts', 'lotsRelabel.ts', 'lotsWarehouse.ts']
    .map((f) => read(path.join(BACKEND, 'services', f))).join('\n') + routeFile('invoicesZatca');
  // كل سببٍ تذكره المقدمة يرسله الخادم في detail
  const listed = /وقيم detail\.reason: ([^\n]*?)\. 422 لرفض/.exec(overview);
  assert.ok(listed, 'قائمة detail.reason غائبة عن المقدمة');
  for (const r of ['NOT_TRACKED', 'TRACKING_CHANGED', 'NEGATIVE', 'LOTS_AND_NUMBER', 'LOT_NUMBER_INVALID', 'DELETED_VAN', 'REMOVAL', 'RELABEL', 'CORRECTION']) {
    assert.ok(new RegExp(`\\b${r}\\b`).test(listed![1]), `السبب ${r} غائب عن المقدمة`);
    assert.ok(lotsSrc.includes(`reason: '${r}'`), `السبب ${r} لا يرسله الخادم`);
  }
  // ووضع إزالة المرتجع (إلغاؤه أو إطفاء عودته) كما في assertRemovalKeepsLots — لا RESTOCK مختصراً
  const modeUnion = /assertRemovalKeepsLots\([^)]*mode: ('[A-Z_]+'(?: \| '[A-Z_]+')*)\)/.exec(read(path.join(BACKEND, 'services', 'lotsInvoice.ts')));
  assert.ok(modeUnion, 'توقيع assertRemovalKeepsLots تغيّر');
  const modes = [...modeUnion![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(modes, ['CANCEL', 'RESTOCK_OFF']);
  assert.match(overview, new RegExp(`mode = ${modes.join(' أو ')}`));
});
