import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC_GROUPS, API_DOC_GUIDES, API_DOC_PLACEHOLDER_KEY } from './apiDocsCatalog';
import { API_BASE_URL, API_DENIED } from './apiDocsData';

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
  'locations', 'paymentMethodsConfig', 'printSettings', 'attendanceAdmin', 'teams', 'reports', 'invoices', 'salesReps', 'vanStock', 'warehouse', 'receipts',
];
const NOT_DOCUMENTED: Readonly<Record<string, string>> = {
  'PUT /company/teams/:id/supervisors': 'يرفض مفاتيح API دائماً بـ403 (API_KEY_FORBIDDEN بعد فحص صلاحيتي الإعدادات والمستخدمين) — نطاق مستخدمي الشركة من اللوحة وحدها، ومذكورٌ في مقدمة مجموعة الفرق',
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

test('دليلا الربط: صفحة اللوكيشن وصفحة طرق الدفع، بخطوات مرقّمة لكلٍّ منهما', () => {
  assert.deepEqual(API_DOC_GUIDES.map((g) => g.title), ['ربط صفحة اللوكيشن', 'ربط صفحة طرق الدفع']);
  for (const g of API_DOC_GUIDES) {
    assert.ok(g.intro.length > 50, g.key);
    assert.ok(g.steps.length >= 5, `${g.key}: خطوات قليلة`);
    for (const s of g.steps) assert.ok(s.title && s.text, `${g.key}: خطوة ناقصة`);
  }
  // مسارات الصفحتين الأساسية حاضرة في الخطوات
  const stepPaths = new Set(API_DOC_GUIDES.flatMap((g) => g.steps.filter((s) => s.path).map((s) => `${s.method} ${s.path}`)));
  for (const k of ['GET /locations', 'PUT /locations/reps/:salesRepId', 'GET /locations/summary', 'GET /company/payment-methods', 'PUT /company/payment-methods', 'POST /receipts', 'GET /reports/payment-methods']) {
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
  const table = docs.slice(docs.indexOf("['400',"), docs.indexOf("['429',") + 80);
  assert.ok(table.length > 200, 'جدول الأخطاء');
  const codes = new Set([...guides.matchAll(CODE_RE), ...table.matchAll(CODE_RE)].map((m) => m[0]));
  for (const must of ['LOCATIONS_NOT_ALLOWED', 'PAYMENT_METHODS_NOT_ALLOWED', 'PAYMENT_METHOD_UNKNOWN', 'LOCATION_ARCHIVED', 'PAYMENT_METHODS_CONFLICT']) {
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
