import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LedgerKey } from '../../lib/ledgerPerms';
import { LEDGER_ROUTES, LEDGER_DIALOGS } from './routes';

/**
 * عمودا «العرض» و«الكتابة» في جدول §8.2 مقابل صلاحيات النقاط في `backend/src/routes/ledger/**`
 * (حارس نصوص ثابت على `requireLedgerPermission` لكل `router.get` ولكل كتابة، M2 ويتسع مع كل مرحلة).
 * يفشل عند عنصر قائمة يرده الخادم بـ403 لصاحب صلاحية عرضه، أو زر كتابة لا تطابق صلاحيته صلاحية نقطته،
 * أو نقطة دفاتر بلا `requireLedgerPermission`.
 *
 * المحلّل نصّي: يتتبع `Router()` و`router.use('/prefix', …, sub)` عبر الاستيراد النسبي، ويقبل
 * الأسماء المستعارة `const x = requireLedgerPermission('…')` والصلاحية على مستوى التركيب.
 * ما دامت ملفات مسارات M2 لم تُكتب (لا نقطة غير `/status`) تُتخطى مقارنة الصفوف — التشغيل الحاسم بعد وكلاء المسارات.
 */

const backendRoutes = path.resolve(process.cwd(), '..', 'backend', 'src', 'routes', 'ledger');

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
interface Decl { method: Method; path: string; perms: LedgerKey[]; file: string }

const LEDGER_KEY_RE = /^can(ViewLedger|PostJournals|ManagePayables|ManageBank|CloseLedgerPeriods|ConfigureLedger)$/;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** نص النداء كاملاً من موضع `(` بعد الاسم حتى القوس المطابق (يتجاهل الأقواس داخل النصوص). */
function callText(src: string, openIdx: number): string {
  let depth = 0; let q: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return src.slice(openIdx);
}

/** الجزء قبل المعالج: الصلاحيات تُذكر قبل الدالة. */
const beforeHandler = (call: string) => {
  const m = /\basync\b|\bfunction\b|\(\s*_?req\b|\(\s*\)\s*=>/.exec(call);
  return m ? call.slice(0, m.index) : call;
};

function permsIn(text: string, aliases: Map<string, LedgerKey>): LedgerKey[] {
  const out = new Set<LedgerKey>();
  for (const m of text.matchAll(/requireLedgerPermission\(\s*['"`](\w+)['"`]\s*\)/g)) if (LEDGER_KEY_RE.test(m[1])) out.add(m[1] as LedgerKey);
  for (const [name, key] of aliases) if (new RegExp(`\\b${name}\\b`).test(text)) out.add(key);
  return [...out];
}

const normPath = (p: string) => (`/${p}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/').replace(/:\w+/g, ':p');

function collect(routesDir = backendRoutes): { decls: Decl[]; unguarded: string[] } {
  const files = walk(routesDir);
  const src = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
  const aliasesOf = new Map<string, Map<string, LedgerKey>>();
  const routerVars = new Map<string, Set<string>>();
  const defaultExport = new Map<string, string>();
  const imports = new Map<string, Map<string, { file: string; named: string | null }>>();

  const resolveSpec = (from: string, spec: string) => {
    const base = path.resolve(path.dirname(from), spec);
    for (const c of [`${base}.ts`, path.join(base, 'index.ts'), base]) if (src.has(c)) return c;
    return null;
  };

  for (const [f, s] of src) {
    const aliases = new Map<string, LedgerKey>();
    for (const m of s.matchAll(/(?:const|let)\s+(\w+)\s*=\s*requireLedgerPermission\(\s*['"`](\w+)['"`]\s*\)/g)) if (LEDGER_KEY_RE.test(m[2])) aliases.set(m[1], m[2] as LedgerKey);
    aliasesOf.set(f, aliases);
    routerVars.set(f, new Set([...s.matchAll(/(?:const|let)\s+(\w+)\s*(?::\s*[\w.]+\s*)?=\s*(?:express\.)?Router\(/g)].map(m => m[1])));
    const de = /export\s+default\s+(\w+)\s*;?/.exec(s); if (de) defaultExport.set(f, de[1]);
    const im = new Map<string, { file: string; named: string | null }>();
    for (const m of s.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolveSpec(f, m[3]); if (!target) continue;
      if (m[1]) im.set(m[1], { file: target, named: null });
      for (const part of (m[2] ?? '').split(',').map(x => x.trim()).filter(Boolean)) {
        const [orig, local] = part.replace(/^type\s+/, '').split(/\s+as\s+/);
        im.set((local ?? orig).trim(), { file: target, named: orig.trim() });
      }
    }
    imports.set(f, im);
  }

  // التركيبات: parentKey → [{childKey, prefix, perms}]
  const mountOf = new Map<string, { parent: string; prefix: string; perms: LedgerKey[] }>();
  for (const [f, s] of src) {
    for (const m of s.matchAll(/\b(\w+)\s*\.\s*use\s*\(/g)) {
      const call = callText(s, m.index! + m[0].length - 1);
      const pm = /^\(\s*(['"`])(\/[^'"`]*)\1\s*,([\s\S]*)\)$/.exec(call);
      if (!pm) continue;
      const idents = [...pm[3].matchAll(/\b([A-Za-z_]\w*)\b/g)].map(x => x[1]);
      const last = idents[idents.length - 1];
      if (!last) continue;
      let childKey: string | null = null;
      if (routerVars.get(f)?.has(last)) childKey = `${f}#${last}`;
      else {
        const imp = imports.get(f)?.get(last);
        if (imp) childKey = `${imp.file}#${imp.named ?? defaultExport.get(imp.file) ?? 'router'}`;
      }
      if (childKey) mountOf.set(childKey, { parent: `${f}#${m[1]}`, prefix: pm[2], perms: permsIn(pm[3], aliasesOf.get(f)!) });
    }
  }
  const prefixOf = (key: string, seen = new Set<string>()): { prefix: string; perms: LedgerKey[] } => {
    const mt = mountOf.get(key);
    if (!mt || seen.has(key)) return { prefix: '', perms: [] };
    seen.add(key);
    const up = prefixOf(mt.parent, seen);
    return { prefix: up.prefix + mt.prefix, perms: [...up.perms, ...mt.perms] };
  };

  const decls: Decl[] = [];
  const unguarded: string[] = [];
  for (const [f, s] of src) {
    // صلاحية على مستوى الموجّه: x.use(requireLedgerPermission('…')) بلا مسار
    const routerLevel = new Map<string, LedgerKey[]>();
    for (const m of s.matchAll(/\b(\w+)\s*\.\s*use\s*\(/g)) {
      const call = callText(s, m.index! + m[0].length - 1);
      if (/^\(\s*['"`]/.test(call)) continue;
      const p = permsIn(call, aliasesOf.get(f)!);
      if (p.length) routerLevel.set(m[1], [...(routerLevel.get(m[1]) ?? []), ...p]);
    }
    for (const m of s.matchAll(/\b(\w+)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])(\/[^'"`]*)\3/g)) {
      // موجّه معرَّف بـRouter() في الملف، أو معامل دالة تسجيل اسمه router (لا req.get ولا api.get)
      if (!routerVars.get(f)?.has(m[1]) && !/router$/i.test(m[1])) continue;
      const call = callText(s, s.indexOf('(', m.index! + m[1].length));
      const inline = permsIn(beforeHandler(call), aliasesOf.get(f)!);
      const mount = prefixOf(`${f}#${m[1]}`);
      const perms = inline.length ? inline : [...(routerLevel.get(m[1]) ?? []), ...mount.perms];
      const full = normPath(mount.prefix + m[4]);
      const rel = path.relative(routesDir, f);
      if (perms.length === 0) unguarded.push(`${m[2].toUpperCase()} ${full} (${rel})`);
      decls.push({ method: m[2] as Method, path: full, perms: [...new Set(perms)], file: rel });
    }
  }
  return { decls, unguarded };
}

/** صلاحية الواجهة `ui` تكفي لنقطة تطلب `server`؟ (canLedger: كل مفتاح يتضمن العرض) */
const satisfies = (ui: LedgerKey, server: LedgerKey) => ui === server || server === 'canViewLedger';

/**
 * نقاط كل صف: `get` = نقطة القراءة التي تحمّلها الصفحة، و`writes` = بادئات كل كتابة يطلقها عمود الكتابة.
 * `helpers`: نقاط GET مساعدة يحتاجها النموذج (خيارات ومنتقيات) — صلاحية كلٍّ منها لا تتجاوز عمود العرض ولا عمود
 * الكتابة للصفحة، فلا يتعطل صاحب الكتابة وحدها (مثل canPostJournals بلا canConfigureLedger).
 * `gated`: نداءات تستدعيها الصفحة مشروطة بصلاحية أخرى (`"GET /tags": 'canConfigureLedger'`)، تُشتق وتُقارن في compareCalls.
 * `viewLooser`: صفوف صلاحية عرضها أشد عمداً من نقطة GET (ملحق أ: `GET /fiscal-years` canViewLedger
 * لفلتر التقارير، والصفحة في التهيئة canConfigureLedger).
 */
const ENDPOINTS: Record<string, { get: string[]; writes: string[]; helpers?: string[]; gated?: Record<string, LedgerKey>; viewLooser?: true }> = {
  // M3 (§8.2، ملحق أ): معالج الإعداد وبطاقة الترحيل التاريخي في الفهرس مشروطان بـcanConfigureLedger (canConfigure)
  '': {
    get: ['/status'], writes: [],
    gated: {
      'GET /setup': 'canConfigureLedger', 'POST /setup/draft': 'canConfigureLedger', 'POST /setup/preview-opening': 'canConfigureLedger',
      'POST /setup/commit': 'canConfigureLedger', 'POST /setup/backfill': 'canConfigureLedger', 'GET /mappings/categories': 'canConfigureLedger',
    },
  },
  entries: { get: ['/moves'], writes: ['/moves'] },
  'entries/new': { get: [], writes: ['/moves'], helpers: ['/moves/options', '/accounts', '/status'] },
  // «إعادة الترحيل من المصدر» (M3، §6.1) مشروطة في MoveForm بـcanConfigureLedger
  'entries/:id': { get: ['/moves/:p'], writes: ['/moves'], helpers: ['/moves/options', '/accounts', '/status'], gated: { 'POST /moves/:p/repost-from-source': 'canConfigureLedger' } },
  items: { get: ['/items'], writes: [] },
  'config/settings': { get: ['/settings', '/setup'], writes: ['/settings', '/mappings', '/setup/backfill'], helpers: ['/journals', '/taxes', '/mappings'] },
  'config/accounts': { get: ['/accounts'], writes: ['/accounts'] },
  'config/accounts/:id': {
    get: ['/accounts/:p'], writes: ['/accounts'],
    // LedgerForm المشترك: الملاحظات والمرفقات بـcanPostJournals (canNote/canWrite)، والعلامات بـenabled: canWrite
    gated: { 'GET /tags': 'canConfigureLedger', 'POST /moves/:p/notes': 'canPostJournals', 'POST /moves/:p/attachments': 'canPostJournals' },
  },
  'config/taxes': { get: ['/taxes'], writes: ['/taxes'] },
  'config/journals': { get: ['/journals'], writes: ['/journals'] },
  'config/mappings': { get: ['/mappings', '/mappings/categories'], writes: ['/mappings'] },
  'config/tags': { get: ['/tags'], writes: ['/tags'] },
  'config/fiscal-years': { get: ['/fiscal-years'], writes: ['/fiscal-years'], gated: { 'GET /settings': 'canConfigureLedger' }, viewLooser: true },
  // M3: العملاء (قراءة؛ «تسجيل عجز» M4) ومراجعة
  'customers/invoices': { get: ['/customers/invoices'], writes: [] },
  'customers/receipts': { get: ['/customers/receipts'], writes: [] },
  'customers/custody': { get: ['/customers/custody'], writes: [] },
  'customers/paylink': { get: ['/customers/paylink', '/customers/paylink/entries'], writes: [] },
  'review/events': { get: ['/events'], writes: ['/events'], helpers: ['/status'] },
  'review/attention': { get: ['/moves'], writes: ['/moves/review'] },
  'review/late': { get: ['/moves'], writes: ['/moves/review'] },
  'review/unreviewed': { get: ['/moves'], writes: ['/moves/review'] },
  'review/checks': { get: ['/checks'], writes: ['/checks'], helpers: ['/status'] },
  'review/audit': { get: ['/audit'], writes: [] },
  // M4 (§7.1، ملحق أ): نقطتان لكل تقرير — `GET /reports/:key` و`POST /reports/:key/export`،
  // كلتاهما `requireLedgerPermission('canViewLedger')` (والتصدير معه `ledgerExportLimiter`).
  // التصدير قراءةٌ لا كتابةَ عمودٍ: يعيد مجموعة البيانات ليبنيها المتصفح ملفاً (ADR‑9)، فلا
  // عمود كتابة لهذه الصفوف ولا يُنسَب إليها في `writes`.
  'reports/balance-sheet': { get: ['/reports/:p'], writes: [] },
  'reports/income-statement': { get: ['/reports/:p'], writes: [] },
  'reports/trial-balance': { get: ['/reports/:p'], writes: [] },
  'reports/general-ledger': { get: ['/reports/:p'], writes: [] },
  // ترحيل المسودات وحذفها من الحوار مشروطان بـcanPostJournals (canPost)
  'dialog:lockDates': { get: ['/lock-dates'], writes: ['/lock-dates'], gated: { 'POST /moves/:p/post': 'canPostJournals', 'DELETE /moves/:p': 'canPostJournals' } },
};

/** كتابات تحت بادئة صف بصلاحية مختلفة موثّقة في ملحق أ (لا تُنسب إلى زر الصف). */
const WRITE_EXCEPTIONS: Record<string, LedgerKey> = {
  'POST /moves/:p/repost-from-source': 'canConfigureLedger', // M3، §6.1
  'POST /fiscal-years/:p/close': 'canCloseLedgerPeriods', // M12
};

const underPrefix = (p: string, prefix: string) => p === prefix || p.startsWith(`${prefix}/`);

test('كل صف في الجدول (ومنه الحوارات) له نقاط معرّفة في هذا الحارس', () => {
  for (const r of LEDGER_ROUTES) assert.ok(ENDPOINTS[r.path], `صف بلا نقاط في ledgerMenuPerms: ${r.path || '(الفهرس)'}`);
  for (const d of LEDGER_DIALOGS) assert.ok(ENDPOINTS[`dialog:${d.key}`], `حوار بلا نقاط: ${d.key}`);
});

test('المحلّل نفسه: التركيب عبر الاستيراد، والاسم المستعار، والصلاحية على مستوى التركيب والموجّه', () => {
  const NL = String.fromCharCode(10);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-perms-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.ts'), [
      "import { Router } from 'express';",
      "import accountsRouter from './accounts';",
      "import { movesRouter } from './moves';",
      "const router = Router();",
      "router.use(authenticate, requireAdmin);",
      "router.get('/status', requireLedgerPermission('canViewLedger'), async (req, res) => { res.json({ a: requireLedgerPermission('canConfigureLedger') }); });",
      "router.use('/accounts', accountsRouter);",
      "router.use('/moves', requireLedgerPermission('canPostJournals'), movesRouter);",
      'export default router;',
    ].join(NL));
    fs.writeFileSync(path.join(dir, 'accounts.ts'), [
      "import { Router } from 'express';",
      "const r = Router();",
      "const canConfig = requireLedgerPermission('canConfigureLedger');",
      "r.get('/', requireLedgerPermission(\"canViewLedger\"), async (_req, res) => {});",
      "r.post('/:id/archive', canConfig, async (req: AuthRequest, res) => {});",
      "r.put('/:accountId', async (req, res) => { req.get('/x'); });",
      'export default r;',
    ].join(NL));
    fs.mkdirSync(path.join(dir, 'moves'));
    fs.writeFileSync(path.join(dir, 'moves', 'index.ts'), [
      "import { Router } from 'express';",
      "export const movesRouter = Router();",
      "movesRouter.post(",
      "  '/:id/post',",
      "  async (req, res) => {},",
      ");",
    ].join(NL));
    const { decls, unguarded } = collect(dir);
    const got = Object.fromEntries(decls.map(d => [`${d.method.toUpperCase()} ${d.path}`, d.perms.join('|')]));
    assert.equal(got['GET /status'], 'canViewLedger', 'الصلاحية داخل جسم المعالج لا تُحتسب');
    assert.equal(got['GET /accounts'], 'canViewLedger');
    assert.equal(got['POST /accounts/:p/archive'], 'canConfigureLedger');
    assert.equal(got['POST /moves/:p/post'], 'canPostJournals', 'صلاحية التركيب تسري على الموجّه الفرعي المسمّى');
    assert.deepEqual(unguarded, ['PUT /accounts/:p (accounts.ts)']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('كل نقطة تحت routes/ledger تحمل requireLedgerPermission', () => {
  const { decls, unguarded } = collect();
  assert.ok(decls.some(d => d.method === 'get' && d.path === '/status'), `المحلّل لم يجد GET /status في ${backendRoutes}`);
  assert.deepEqual(unguarded, [], 'نقاط دفاتر بلا requireLedgerPermission');
});

test('عمودا العرض والكتابة يطابقان صلاحيات نقاط الخادم', t => {
  const { decls } = collect();
  if (!decls.some(d => d.path !== '/status')) {
    t.skip('ملفات مسارات M2 لم تُكتب بعد في backend/src/routes/ledger — يُعاد التشغيل بعد وكلاء المسارات');
    return;
  }
  assert.deepEqual(comparePerms(decls), []);
});

test('المقارنة نفسها: خادم مطابق لملحق أ ⇒ لا مشكلات، وانحراف العرض أو الكتابة يُلتقط', () => {
  const d = (method: Method, p: string, perm: LedgerKey): Decl => ({ method, path: p, perms: [perm], file: 'fixture.ts' });
  const V: LedgerKey = 'canViewLedger'; const P: LedgerKey = 'canPostJournals'; const C: LedgerKey = 'canConfigureLedger'; const L: LedgerKey = 'canCloseLedgerPeriods';
  const good: Decl[] = [
    d('get', '/status', V),
    d('get', '/moves', V), d('post', '/moves', P), d('get', '/moves/:p', V), d('put', '/moves/:p', P), d('delete', '/moves/:p', P),
    d('post', '/moves/:p/post', P), d('post', '/moves/post-drafts', P), d('post', '/moves/:p/repost-from-source', C),
    d('get', '/moves/options', V), d('post', '/moves/:p/attachments', P), d('get', '/items', V),
    d('get', '/settings', C), d('put', '/settings', C),
    d('get', '/accounts', V), d('post', '/accounts', C), d('get', '/accounts/:p', V), d('put', '/accounts/:p', C), d('post', '/accounts/:p/archive', C),
    ...['/taxes', '/journals', '/tags'].flatMap(p => [d('get', p, C), d('post', p, C), d('put', `${p}/:p`, C)]),
    d('get', '/mappings', C), d('put', '/mappings', C),
    d('get', '/mappings/categories', C), d('put', '/mappings/categories', C),
    d('get', '/setup', C), d('post', '/setup/draft', C), d('post', '/setup/preview-opening', C), d('post', '/setup/commit', C), d('post', '/setup/backfill', C),
    d('get', '/fiscal-years', V), d('post', '/fiscal-years', C),
    d('get', '/lock-dates', L), d('put', '/lock-dates', L),
    // M3
    ...['/customers/invoices', '/customers/receipts', '/customers/custody', '/customers/paylink', '/customers/paylink/entries', '/events', '/checks'].map(p => d('get', p, V)),
    d('post', '/events/:p/retry', C), d('post', '/events/:p/skip', C), d('post', '/events/:p/release', C), d('post', '/moves/review', P),
    d('post', '/checks/run', C), d('post', '/checks/rebuild-balances', C), d('post', '/checks/:p/control-adjustment', C), d('get', '/audit', C), d('post', '/sync', V),
    // M4: نقطتا التقارير، كلتاهما canViewLedger
    d('get', '/reports/:p', V), d('post', '/reports/:p/export', V),
  ];
  assert.deepEqual(comparePerms(good), []);
  const badView = good.map(x => (x.method === 'get' && x.path === '/items' ? { ...x, perms: [C] } : x));
  assert.ok(comparePerms(badView).some(s => s.startsWith('items: العرض canViewLedger لكن GET /items يطلب canConfigureLedger')));
  const stricterUi = good.map(x => (x.method === 'get' && x.path === '/taxes' ? { ...x, perms: [V] } : x));
  assert.ok(comparePerms(stricterUi).some(s => s.startsWith('config/taxes: العرض canConfigureLedger أشد')));
  const badWrite = good.map(x => (x.method === 'post' && x.path === '/accounts/:p/archive' ? { ...x, perms: [P] } : x));
  assert.ok(comparePerms(badWrite).some(s => s.includes('POST /accounts/:p/archive يطلب canPostJournals')));
  assert.ok(comparePerms(good.filter(x => x.path !== '/lock-dates')).some(s => s.includes('GET /lock-dates غير موجود')));
  // نقطة مساعدة بصلاحية التهيئة تُعطّل نموذج القيد لصاحب canPostJournals وحدها
  const configOptions = good.map(x => (x.method === 'get' && x.path === '/moves/options' ? { ...x, perms: [C] } : x));
  assert.ok(comparePerms(configOptions).some(s => s.startsWith('entries/new: GET /moves/options المساعدة تطلب canConfigureLedger')));
  assert.ok(comparePerms(good.filter(x => x.path !== '/moves/options')).some(s => s.includes('GET /moves/options المساعدة غير موجودة')));
});

function comparePerms(decls: Decl[]): string[] {
  const rows = [
    ...LEDGER_ROUTES.map(r => ({ id: r.path, view: r.view, write: r.write })),
    ...LEDGER_DIALOGS.map(d => ({ id: `dialog:${d.key}`, view: d.view, write: d.write as LedgerKey | null })),
  ];
  const problems: string[] = [];
  for (const row of rows) {
    const ep = ENDPOINTS[row.id];
    for (const g of ep.get) {
      const found = decls.filter(d => d.method === 'get' && d.path === g);
      if (found.length === 0) { problems.push(`${row.id || '(الفهرس)'}: GET ${g} غير موجود في الخادم`); continue; }
      for (const d of found) for (const p of d.perms) {
        if (!satisfies(row.view, p)) problems.push(`${row.id || '(الفهرس)'}: العرض ${row.view} لكن GET ${g} يطلب ${p} (403 لصاحب العرض)`);
        else if (!ep.viewLooser && p !== row.view) problems.push(`${row.id || '(الفهرس)'}: العرض ${row.view} أشد من GET ${g} (${p}) — يُحجب عنصر يسمح به الخادم`);
      }
    }
    for (const g of ep.helpers ?? []) {
      const found = decls.filter(d => d.method === 'get' && d.path === g);
      if (found.length === 0) { problems.push(`${row.id}: GET ${g} المساعدة غير موجودة في الخادم`); continue; }
      for (const d of found) for (const p of d.perms) {
        const cols = [row.view, ...(row.write ? [row.write] : [])];
        const blocked = cols.filter(c => !satisfies(c, p));
        if (blocked.length) problems.push(`${row.id}: GET ${g} المساعدة تطلب ${p} فتُعطَّل الصفحة لصاحب ${blocked.join(' أو ')}`);
      }
    }
    if (ep.writes.length && !row.write) problems.push(`${row.id}: نقاط كتابة بلا عمود كتابة`);
    const writeDecls = decls.filter(d => d.method !== 'get' && ep.writes.some(w => underPrefix(d.path, w)));
    if (ep.writes.length && row.write && !writeDecls.some(d => ep.writes.some(w => underPrefix(d.path, w)))) {
      problems.push(`${row.id}: لا نقطة كتابة تحت ${ep.writes.join('، ')}`);
    }
    for (const d of writeDecls) {
      const key = `${d.method.toUpperCase()} ${d.path}`;
      const expected = WRITE_EXCEPTIONS[key] ?? row.write;
      for (const p of d.perms) if (p !== expected) problems.push(`${row.id}: الكتابة ${row.write} لكن ${key} يطلب ${p} (${d.file})`);
    }
  }
  return problems;
}

// ═══ مسارات عميل الويب مقابل الخادم، ونقاط كل صفحة مشتقة من استدعاءاتها ═══

const webSrc = path.resolve(process.cwd(), 'src');
const API_FILES = ['api/ledgerConfig.ts', 'api/ledgerMoves.ts', 'api/ledgerReview.ts', 'api/ledgerSetup.ts'];
/** ملف مكوّن كل حوار (الصفوف المسارية ملفها من `component`) */
const DIALOG_FILES: Record<string, string> = { lockDates: 'components/ledger/LockDatesDialog.tsx' };

interface ClientRoute { name: string; method: Method; path: string }

/**
 * نقاط عميل الدفاتر من نصوص `api/ledger*.ts`: `<xApi>.<group>.<member>` ⇒ الطريقة والمسار (`${…}` ⇒ :p).
 * الاسم من مفاتيح الكائن بالمسافة البادئة (2 للمجموعة أو الدالة، 4 للعضو)، والدوال المصدَّرة التي تستدعي
 * أعضاء الكائن (مثل fetchListExport) تُعدّ أسماء مستعارة لها.
 */
function clientRoutes(files = API_FILES.map(f => path.join(webSrc, f))): { routes: Map<string, ClientRoute[]>; aliases: Map<string, string[]> } {
  const routes = new Map<string, ClientRoute[]>();
  const aliases = new Map<string, string[]>();
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const lines = s.split(/\r?\n/);
    let apiName: string | null = null; let group: string | null = null; let member: string | null = null;
    lines.forEach(line => {
      const start = /^export const (\w+Api)\s*=\s*\{/.exec(line);
      if (start) { apiName = start[1]; group = null; member = null; return; }
      if (!apiName) return;
      if (/^\};?\s*$/.test(line)) { apiName = null; return; }
      const g = /^ {2}(\w+)\s*:/.exec(line); if (g) { group = g[1]; member = null; }
      const m = /^ {4}(\w+)\s*:/.exec(line); if (m) member = m[1];
      for (const c of line.matchAll(/\bapi\.(get|post|put|patch|delete)\s*(?:<[^()]*>)?\s*\(\s*`\$\{L\}([^`]*)`/g)) {
        const name = `${apiName}.${member ? `${group}.${member}` : group}`;
        routes.set(name, [...(routes.get(name) ?? []), { name, method: c[1] as Method, path: normPath(c[2].replace(/\$\{[^}]*\}/g, ':p')) }]);
      }
    });
    for (const fn of s.matchAll(/export\s+(?:async\s+)?function\s+(\w+)[\s\S]*?(?=\nexport\s|$)/g)) {
      const refs = [...fn[0].matchAll(/\b(ledger\w*Api(?:\.\w+)+)/g)].map(x => x[1]);
      if (refs.length) aliases.set(fn[1], refs);
    }
  }
  return { routes, aliases };
}

/** ملفات صفحة الصف: ملفها وما تستورده نسبياً تحت ledger (بلا صفحات مسارات أخرى ولا routes.ts). */
function rowFiles(entry: string): string[] {
  const routeFiles = new Set(LEDGER_ROUTES.map(r => path.join(webSrc, 'pages', 'ledger', `${r.component}.tsx`)));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (f: string) => {
    if (seen.has(f)) return; seen.add(f);
    if (f !== entry && routeFiles.has(f)) return;
    const rel = path.relative(webSrc, f).split(path.sep).join('/');
    if (!/^(pages|components|lib)\/ledger\//.test(rel) || /\.test\.ts$|\/routes\.ts$/.test(rel)) return;
    out.push(f);
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const base = path.resolve(path.dirname(f), m[1]);
      const hit = [`${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')].find(c => fs.existsSync(c));
      if (hit) visit(hit);
    }
  };
  visit(entry);
  return out;
}

interface RowCall { method: Method; path: string; via: string; file: string }

function rowCalls(entry: string, client = clientRoutes()): { calls: RowCall[]; unknown: string[] } {
  const calls: RowCall[] = []; const unknown: string[] = [];
  // الاسم المستعار يُحتسب بأي ذكر: نداءً أو مرجعاً (`queryFn: fetchAllLedgerAccounts`)
  const aliasRe = client.aliases.size ? new RegExp(`\\b(${[...client.aliases.keys()].join('|')})\\b(?!\\s*[:=]\\s*(?:async\\b|\\())`, 'g') : null;
  for (const f of rowFiles(entry)) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(webSrc, f).split(path.sep).join('/');
    const names = [...s.matchAll(/\b(ledger(?:Config|Moves|Review|Setup)Api(?:\.\w+)+)/g)].map(m => m[1]);
    if (aliasRe) for (const m of s.matchAll(aliasRe)) names.push(...client.aliases.get(m[1])!);
    for (const n of names) {
      const hits = client.routes.get(n);
      if (!hits) { unknown.push(`${n} (${rel})`); continue; }
      for (const h of hits) calls.push({ method: h.method, path: h.path, via: n, file: rel });
    }
  }
  return { calls, unknown };
}

const rowEntry = (id: string): string => {
  if (id.startsWith('dialog:')) return path.join(webSrc, DIALOG_FILES[id.slice('dialog:'.length)]);
  const r = LEDGER_ROUTES.find(x => x.path === id)!;
  return path.join(webSrc, 'pages', 'ledger', `${r.component}.tsx`);
};

/**
 * نقاط الصفحة الفعلية مقابل الحارس والخادم: كل نداء له مسار مسجَّل بطريقته، وكل GET إما في get أو helpers
 * أو gated، وكل كتابة تحت writes أو في gated، إلا ما صلاحيته في الخادم canViewLedger (يكفيه أي صف).
 * gated: نداء مشروط في الصفحة بصلاحية أخرى (مثل `enabled: canWrite`) ⇒ صلاحية النقطة تكفيها تلك الصلاحية.
 * ولا مساعدة مذكورة في الحارس لا تستدعيها الصفحة (قائمة يدوية قديمة).
 */
function compareCalls(decls: Decl[], callsOf: (rowId: string) => RowCall[]): string[] {
  const rows = [
    ...LEDGER_ROUTES.map(r => ({ id: r.path, view: r.view, write: r.write })),
    ...LEDGER_DIALOGS.map(d => ({ id: `dialog:${d.key}`, view: d.view, write: d.write as LedgerKey | null })),
  ];
  const problems: string[] = [];
  for (const row of rows) {
    const ep = ENDPOINTS[row.id];
    const calls = callsOf(row.id);
    const label = row.id || '(الفهرس)';
    for (const c of calls) {
      const key = `${c.method.toUpperCase()} ${c.path}`;
      const server = decls.filter(d => d.method === c.method && d.path === c.path);
      if (server.length === 0) { problems.push(`${label}: ${key} (${c.via} في ${c.file}) غير مسجَّل في الخادم`); continue; }
      const perms = [...new Set(server.flatMap(d => d.perms))];
      const gate = ep.gated?.[key];
      let cols: LedgerKey[] | null = null;
      if (gate) cols = [gate];
      else if (c.method === 'get') cols = ep.get.includes(c.path) ? [row.view] : ep.helpers?.includes(c.path) ? [row.view, ...(row.write ? [row.write] : [])] : null;
      const declared = gate || (c.method === 'get' ? ep.get.includes(c.path) || !!ep.helpers?.includes(c.path) : ep.writes.some(w => underPrefix(c.path, w)));
      if (!declared) {
        if (perms.every(p => p === 'canViewLedger')) continue;
        problems.push(`${label}: ${key} (${c.via} في ${c.file}) يطلب ${perms.join('|')} وغير مذكور في get/helpers/writes/gated`);
        continue;
      }
      for (const col of cols ?? []) for (const p of perms) {
        if (!satisfies(col, p)) problems.push(`${label}: ${key} (${c.via}) يطلب ${p} فيُرفض لصاحب ${col}`);
      }
    }
    for (const h of ep.helpers ?? []) {
      if (!calls.some(c => c.method === 'get' && c.path === h)) problems.push(`${label}: المساعدة GET ${h} لا تستدعيها الصفحة`);
    }
    for (const g of Object.keys(ep.gated ?? {})) {
      if (!calls.some(c => `${c.method.toUpperCase()} ${c.path}` === g)) problems.push(`${label}: gated ${g} لا تستدعيه الصفحة`);
    }
  }
  return problems;
}

test('كل نقطة في عميل الويب (api/ledger*.ts) مسجَّلة في الخادم بطريقتها ومسارها', () => {
  const { decls } = collect();
  const { routes } = clientRoutes();
  assert.ok(routes.size > 20, `المحلّل لم يجد نقاط العميل (${routes.size})`);
  const missing: string[] = [];
  for (const list of routes.values()) for (const r of list) {
    if (!decls.some(d => d.method === r.method && d.path === r.path)) missing.push(`${r.name}: ${r.method.toUpperCase()} ${r.path}`);
  }
  assert.deepEqual(missing, [], 'نقاط يستدعيها الويب ولا يسجّلها الخادم (404)');
});

test('نقاط كل صفحة مشتقة من استدعاءاتها الفعلية: مذكورة في الحارس، ومسجَّلة، وصلاحيتها لا تحجب الصفحة', () => {
  const { decls } = collect();
  const client = clientRoutes();
  const unknown: string[] = [];
  const problems = compareCalls(decls, id => { const r = rowCalls(rowEntry(id), client); unknown.push(...r.unknown); return r.calls; });
  assert.deepEqual([...new Set(unknown)], [], 'استدعاءات لأعضاء غير موجودة في عميل الدفاتر');
  assert.deepEqual(problems, []);
});

test('المحلّلان نفساهما: أسماء العميل ومساراته، والاشتقاق يلتقط /sync غير المسجَّل ونقطة تهيئة في نموذج القيد', () => {
  const NL = String.fromCharCode(10);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-client-'));
  try {
    const f = path.join(dir, 'x.ts');
    fs.writeFileSync(f, [
      "const L = '/ledger';",
      'export const ledgerConfigApi = {',
      '  status: () => api.get<LedgerEnvelope<{ a: 1 }>>(`${L}/status`),',
      '  moves: {',
      '    list: (params?: P) =>',
      '      api.get<LedgerEnvelope<ListPage<R> & { t: T }>>(`${L}/moves`, { params }),',
      '    post: (id: string) => api.post<X>(`${L}/moves/${id}/post`),',
      '  },',
      '  sync: () => api.post<LedgerEnvelope<{ running?: boolean }>>(`${L}/sync`),',
      '};',
      'export async function fetchAll() { return ledgerConfigApi.moves.list(); }',
    ].join(NL));
    const c = clientRoutes([f]);
    assert.deepEqual([...c.routes.values()].flat().map(r => `${r.name} ${r.method} ${r.path}`), [
      'ledgerConfigApi.status get /status', 'ledgerConfigApi.moves.list get /moves', 'ledgerConfigApi.moves.post post /moves/:p/post',
      'ledgerConfigApi.sync post /sync',
    ]);
    assert.deepEqual(c.aliases.get('fetchAll'), ['ledgerConfigApi.moves.list']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const d = (method: Method, p: string, perm: LedgerKey): Decl => ({ method, path: p, perms: [perm], file: 'fixture.ts' });
  const decls: Decl[] = [
    d('get', '/status', 'canViewLedger'), d('get', '/moves/:p', 'canViewLedger'), d('get', '/moves/options', 'canViewLedger'),
    d('get', '/accounts', 'canViewLedger'), d('get', '/journals', 'canConfigureLedger'), d('put', '/lock-dates', 'canCloseLedgerPeriods'),
    d('get', '/lock-dates', 'canCloseLedgerPeriods'), d('post', '/saved-filters', 'canViewLedger'),
    d('post', '/moves/:p/repost-from-source', 'canConfigureLedger'),
  ];
  const call = (method: Method, p: string): RowCall => ({ method, path: p, via: 'fixture', file: 'fixture.tsx' });
  const only = (rowId: string, calls: RowCall[]) => (id: string) => (id === rowId ? calls : []);
  const base = [call('get', '/moves/:p'), call('get', '/moves/options'), call('get', '/accounts'), call('get', '/status'), call('post', '/moves/:p/repost-from-source')];
  const pick = (ps: string[], row: string) => ps.filter(s => s.startsWith(`${row}:`));
  assert.deepEqual(pick(compareCalls(decls, only('entries/:id', base)), 'entries/:id'), []);
  // عودة MoveForm إلى /journals (canConfigureLedger) تُلتقط وإن لم تُذكر يدوياً
  assert.ok(pick(compareCalls(decls, only('entries/:id', [...base, call('get', '/journals')])), 'entries/:id')
    .some(s => s.includes('GET /journals') && s.includes('canConfigureLedger')));
  // نقطة كتابة بصلاحية العرض (المفضلات) مقبولة بلا ذكر
  assert.deepEqual(pick(compareCalls(decls, only('entries/:id', [...base, call('post', '/saved-filters')])), 'entries/:id'), []);
  // POST /sync غير مسجَّل في الخادم
  assert.ok(pick(compareCalls(decls, only('dialog:lockDates', [call('get', '/lock-dates'), call('put', '/lock-dates'), call('post', '/sync')])), 'dialog:lockDates')
    .some(s => s.includes('POST /sync') && s.includes('غير مسجَّل')));
  // مساعدة مذكورة لا تستدعيها الصفحة
  assert.ok(pick(compareCalls(decls, only('entries/:id', base.slice(0, 2))), 'entries/:id').some(s => s.includes('GET /accounts لا تستدعيها')));
});

test('نقاط معالج الإعداد (api/ledgerSetup.ts) مشمولة بالحارس: الفهرس يستدعيها مشروطة، وخفض صلاحيتها أو إسقاط شرطها يُلتقط', () => {
  const client = clientRoutes();
  // العميل يُحلَّل: كل نقاط ledgerSetupApi معروفة بمساراتها
  const setupRoutes = [...client.routes.values()].flat().filter(r => r.name.startsWith('ledgerSetupApi.')).map(r => `${r.method.toUpperCase()} ${r.path}`);
  for (const k of ['GET /setup', 'POST /setup/draft', 'POST /setup/preview-opening', 'POST /setup/commit', 'POST /setup/backfill', 'GET /mappings/categories', 'PUT /mappings/categories']) {
    assert.ok(setupRoutes.includes(k), `ledgerSetupApi بلا ${k}`);
  }
  // الفهرس يصل فعلاً إلى نقاط المعالج عبر استيراداته
  const homeCalls = rowCalls(rowEntry(''), client).calls.map(c => `${c.method.toUpperCase()} ${c.path}`);
  for (const k of Object.keys(ENDPOINTS[''].gated ?? {})) assert.ok(homeCalls.includes(k), `الفهرس لا يستدعي ${k}`);

  const d = (method: Method, p: string, perm: LedgerKey): Decl => ({ method, path: p, perms: [perm], file: 'fixture.ts' });
  const C: LedgerKey = 'canConfigureLedger';
  const decls: Decl[] = [
    d('get', '/status', 'canViewLedger'), d('get', '/setup', C), d('post', '/setup/draft', C), d('post', '/setup/preview-opening', C),
    d('post', '/setup/commit', C), d('post', '/setup/backfill', C), d('get', '/mappings/categories', C),
  ];
  const call = (method: Method, p: string): RowCall => ({ method, path: p, via: 'fixture', file: 'fixture.tsx' });
  const homeFixture = [call('get', '/status'), call('get', '/setup'), call('post', '/setup/draft'), call('post', '/setup/preview-opening'),
    call('post', '/setup/commit'), call('post', '/setup/backfill'), call('get', '/mappings/categories')];
  const only = (calls: RowCall[]) => (id: string) => (id === '' ? calls : []);
  const home = (ps: string[]) => ps.filter(s => s.startsWith('(الفهرس):'));
  assert.deepEqual(home(compareCalls(decls, only(homeFixture))), []);
  // نقطة معالج جديدة بصلاحية التهيئة في الفهرس (عرضه canViewLedger) دون ذكرها مشروطة ⇒ تُلتقط
  assert.ok(home(compareCalls([...decls, d('post', '/setup/reset', C)], only([...homeFixture, call('post', '/setup/reset')])))
    .some(s => s.includes('POST /setup/reset') && s.includes('غير مذكور')));
  // تغيّر صلاحية GET /setup في الخادم إلى ما لا يكفيه شرط الفهرس (canConfigureLedger) ⇒ يُلتقط
  const stricter = decls.map(x => (x.method === 'get' && x.path === '/setup' ? { ...x, perms: ['canCloseLedgerPeriods' as LedgerKey] } : x));
  assert.ok(home(compareCalls(stricter, only(homeFixture))).some(s => s.includes('GET /setup') && s.includes('canCloseLedgerPeriods')));
});
