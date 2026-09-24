import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { isAdsTagRoute } from './adsRoutes';
import { makeGtag, initAdsTag, trackSignup, trackWhatsApp, __setAdsConfigForTests } from './ads';
import { readUtm, optOut, isAdMeasurementUrl, isGoogleAdsStorageName } from './attribution';
import { visitChannelLabel } from './visitChannels';

/**
 * تتبّع حملة Google Ads: أين يُحمَّل الوسم، وهل تصل إشارة النقر المدفوع فعلاً.
 * كل خلل هنا صامت في الإنتاج — الصفحة تعمل والحملة تبدو بلا أثر.
 */

const enc = (p: string) => encodeURI(p); // location.pathname يصل مُرمَّزاً للمسارات العربية

test('الوسم مسموح على كل صفحة تسويقية — ومنها صفحة هبوط الحملة والتسجيل', () => {
  const allowed = [
    '/', '/pricing', '/pricing/', '/signup', '/about', '/terms', '/privacy', '/service-agreement',
    '/contact', '/subscribe-request', '/calculator', '/invoice-generator', '/tutorial', '/profile',
    '/blog', '/blog/field-sales-software-sa/', '/free', '/free/commission',
    enc('/قطاعات'), enc('/قطاعات/مواد-غذائية'), enc('/مزايا/الفوترة-بدون-انترنت'), enc('/نماذج/كشف-حساب-عميل'),
    '/en', '/en/', '/en/pricing/', '/en/blog/x', '/fr/pricing', '/fr/blog/x/', '/tr/pricing', '/zh/contact',
  ];
  const missing = allowed.filter((p) => !isAdsTagRoute(p));
  assert.deepEqual(missing, [], `صفحات تسويقية بلا وسم: ${missing.join(', ')}`);
});

test('الوسم ممنوع داخل التطبيق والبوابات الخاصة وصفحات عملاء عملائنا', () => {
  const denied = [
    '/app', '/app/', '/app/customers', '/app/ledger/moves', '/platform', '/owner', '/login', '/verify-email',
    '/rep', '/rep/', '/m', '/m/', '/ax', '/ax/', '/hx', '/q-fs7k2m', '/qt',
    '/pos', '/kds', '/app-r', // مسارات المطعم — خارج القائمة تلقائياً
    '/c/tenant1/rep1', '/pay/tok123', '/e/tok123', '/payment/success', '/rep-app', '/hookb',
    '/en/app', '/fr/login',
  ];
  const leaked = denied.filter((p) => isAdsTagRoute(p));
  assert.deepEqual(leaked, [], `تسرّب الوسم إلى: ${leaked.join(', ')}`);
});

test('حدود المطابقة: لا بادئات متشابهة ولا مستويات زائدة', () => {
  assert.equal(isAdsTagRoute('/pricingx'), false);
  assert.equal(isAdsTagRoute('/apps-guide'), false);
  assert.equal(isAdsTagRoute('/enx/pricing'), false);   // ليست بادئة لغة
  assert.equal(isAdsTagRoute('/en/en/pricing'), false);
  assert.equal(isAdsTagRoute('/blog/a/b'), false);       // مستوى واحد فقط تحت القسم
  assert.equal(isAdsTagRoute('/pricing/extra'), false);  // الأسعار بلا صفحات فرعية
  assert.equal(isAdsTagRoute('/%E0%A4%A'), false);       // ترميز تالف ⇒ لا وسم، ولا انهيار
  assert.equal(isAdsTagRoute(''), true);                 // الجذر
  assert.equal(isAdsTagRoute(null), true);
});

test('المسار العربي غير المفكوك لا يسقط من القائمة بصمت', () => {
  // قبل الفكّ: `/%D9%82...` لا يطابق «قطاعات» أبداً
  assert.equal(enc('/قطاعات').includes('%'), true);
  assert.equal(isAdsTagRoute(enc('/قطاعات')), true);
});

/**
 * حارس الانحراف: كل مسار مطلق في App.tsx يجب أن يكون **مقرَّراً** هنا — عامّاً
 * يحمل الوسم أو خاصّاً بلا وسم. مسار جديد بلا قرار يُفشل الاختبار بدل أن يُحرم
 * صفحة هبوط من معرّف النقر أو يُدخل وسماً إعلانياً إلى حساب عميل.
 */
test('كل مسارات App.tsx مصنّفة صراحةً، والتصنيف يطابق isAdsTagRoute', () => {
  const PUBLIC = new Set([
    '/', '/about', '/terms', '/service-agreement', '/privacy', '/contact', '/subscribe-request',
    '/calculator', '/tutorial', '/profile', '/invoice-generator', '/pricing', '/signup',
    '/قطاعات', '/قطاعات/:slug', '/مزايا', '/مزايا/:slug', '/نماذج', '/نماذج/:slug',
    '/free', '/free/:tool', '/blog', '/blog/:slug',
  ]);
  const PRIVATE = new Set([
    '/rep', '/m', '/hx', '/ax', '/q-fs7k2m', '/hookb', '/login', '/owner', '/verify-email',
    '/rep-app', '/payment/success', '/c/:tenantId/:repId', '/pay/:token', '/e/:token', '/platform', '/app',
  ]);
  const src = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const paths = [...src.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 40, `تعذّر قراءة مسارات App.tsx (${paths.length})`);

  const undecided: string[] = [];
  const wrong: string[] = [];
  for (const route of paths) {
    const base = route.replace(/^\/(en|fr|tr|zh)(?=\/|$)/, '') || '/';
    const isPublic = PUBLIC.has(base);
    if (!isPublic && !PRIVATE.has(base)) { undecided.push(route); continue; }
    const sample = route.replace(/:[^/]+/g, 'x');
    if (isAdsTagRoute(sample) !== isPublic) wrong.push(`${route} ⇒ ${isAdsTagRoute(sample)}`);
  }
  assert.deepEqual(undecided, [], `مسارات جديدة بلا قرار وسم إعلاني — أضفها إلى adsRoutes.ts أو إلى PRIVATE هنا: ${undecided.join(', ')}`);
  assert.deepEqual(wrong, [], `تصنيف مخالف: ${wrong.join(' | ')}`);
});

test('دالّة gtag تدفع كائن arguments لا مصفوفة — وإلا يتجاهل gtag.js كل الأوامر', () => {
  const dl: unknown[] = [];
  const gtag = makeGtag(dl);
  gtag('config', 'AW-123', { allow_ad_personalization_signals: false });
  assert.equal(dl.length, 1);
  assert.equal(Object.prototype.toString.call(dl[0]), '[object Arguments]');
  assert.equal(Array.isArray(dl[0]), false);
  assert.deepEqual(Array.from(dl[0] as ArrayLike<unknown>), ['config', 'AW-123', { allow_ad_personalization_signals: false }]);
});

test('بلا VITE_ADS_ID: صفر تحميل وصفر شبكة، والانتقال بعد التسجيل يحدث مرّة واحدة', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const prev = { window: g.window, document: g.document };
  const touched: string[] = [];
  g.window = { location: { pathname: '/signup', href: 'https://fieldsa.net/signup?gclid=x' }, setTimeout, clearTimeout };
  g.document = { createElement: () => { touched.push('createElement'); throw new Error('لا يجوز'); }, head: {} };
  try {
    assert.equal(initAdsTag('/pricing/'), false);
    assert.equal(initAdsTag('/app'), false);
    let redirects = 0;
    trackSignup(() => { redirects++; });
    assert.equal(redirects, 1); // فوراً ودون انتظار مهلة
    trackWhatsApp('pricing');
    assert.deepEqual(touched, []);
    assert.equal((g.window as Record<string, unknown>).dataLayer, undefined);
  } finally {
    g.window = prev.window;
    g.document = prev.document;
  }
});

test('نقرة إعلان جوجل تصل للخادم بنوع المعرّف وحده لا بقيمته', () => {
  assert.deepEqual(readUtm('?gclid=EAIaIQobChMI123'), { clickId: 'gclid' });
  assert.deepEqual(readUtm('?gbraid=0AAAAA'), { clickId: 'gbraid' });
  assert.deepEqual(readUtm('?wbraid=CkA'), { clickId: 'wbraid' });
  assert.deepEqual(readUtm('?utm_source=google&utm_medium=cpc&gclid=abc'), { source: 'google', medium: 'cpc', clickId: 'gclid' });
  assert.deepEqual(readUtm('?utm_source=sourceforge'), { source: 'sourceforge' });
  assert.deepEqual(readUtm('?gclid='), {}); // معرّف فارغ ليس نقرة
  assert.equal(JSON.stringify(readUtm('?gclid=EAIaIQobChMI123')).includes('EAIa'), false);
});

test('نقرة إعلان بلا gclid: gad_source وgad_campaignid دليل دفع يُرسل نوعه وحده', () => {
  // Safari في التصفّح الخاص يحذف gclid ويُبقي معاملَي Google Ads — بدونهما «بحث عضوي»
  assert.deepEqual(readUtm('?gad_source=1'), { clickId: 'gad_source' });
  assert.deepEqual(readUtm('?gad_campaignid=22334455'), { clickId: 'gad_campaignid' });
  assert.deepEqual(readUtm('?gad_source=1&gad_campaignid=22334455'), { clickId: 'gad_source' });
  // المعرّف الأقوى أولاً حين يجتمعان
  assert.deepEqual(readUtm('?gad_source=1&gclid=abc'), { clickId: 'gclid' });
  assert.deepEqual(readUtm('?gad_source='), {});
  const sent = JSON.stringify(readUtm('?gad_source=5&gad_campaignid=22334455'));
  assert.equal(sent.includes('22334455') || sent.includes('"5"'), false, 'قيمة المعامل لا تُرسل');
});

test('لوحة المالك تسمّي القناتين المدفوعتين بالعربية', () => {
  assert.match(visitChannelLabel('paid_search'), /مدفوع/);
  assert.match(visitChannelLabel('paid_social'), /إعلانات/);
  assert.equal(visitChannelLabel('organic'), 'بحث عضوي');
  assert.equal(visitChannelLabel('قناة_جديدة'), 'قناة_جديدة'); // غير المعروف يظهر كما هو
});

/**
 * كل زرّ واتساب تسويقي يمرّ عبر waHref يجب أن يُطلق تحويل الحملة أيضاً.
 * يُعدّ **كل** استدعاء لـwaHref (لا `href={waHref(` وحده): بطاقة التواصل تبنيه في
 * كائن (`href: waHref(`)، والصفحة الرئيسية داخل HTML محقون (`return waHref(`).
 */
test('كل استدعاء waHref في الصفحات العامّة يرافقه trackWhatsApp', () => {
  const dir = new URL('../pages/', import.meta.url);
  const gaps: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const links = src.split('\n').filter((l) => /\bwaHref\(/.test(l) && !/^\s*import\b/.test(l)).length;
    if (!links) continue;
    const tracked = (src.match(/trackWhatsApp\(/g) || []).length;
    if (tracked < links) gaps.push(`${f}: ${links} رابط / ${tracked} تتبّع`);
    // HTML محقون لا يحمل onClick: يلزم وسم data-wa-track ومستمع مفوَّض يُطلق التحويل
    if (/dangerouslySetInnerHTML/.test(src) && !/data-wa-track/.test(src.replace(/closest\?*\.?\(\s*'a\[data-wa-track\]'\s*\)/g, ''))) {
      gaps.push(`${f}: رابط واتساب داخل HTML محقون بلا data-wa-track`);
    }
    if (/dangerouslySetInnerHTML/.test(src) && !/closest\?*\.?\(\s*'a\[data-wa-track\]'\s*\)/.test(src)) {
      gaps.push(`${f}: لا مستمع نقر مفوَّض لروابط data-wa-track`);
    }
  }
  assert.deepEqual(gaps, [], `أزرار واتساب بلا تحويل: ${gaps.join(' · ')}`);
});

/**
 * رابط `wa.me/<رقم>` مباشر في صفحة عامّة يتخطّى المحوّل `/go/wa` وتحويل الحملة
 * معاً — فنقرة الإعلان التي تنتهي بمحادثة لا تُحتسب أبداً. روابط المشاركة
 * (`wa.me/?text=`) ليست محادثة معنا فلا تُفحص. الاستثناء بوسم صريح في السطر نفسه.
 */
test('لا رابط wa.me برقم مباشر في الصفحات العامّة', () => {
  // منيو المندوب `/c/:tenant/:rep`: رقم مندوب الشركة المشتركة لعملائها — ليس رقمنا ولا تحويلاً لحملتنا
  const NOT_OURS = new Set(['CatalogPage.tsx']);
  const dir = new URL('../pages/', import.meta.url);
  const direct: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx') && !NOT_OURS.has(n))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
      if (/wa\.me\/(\$\{|[0-9])/.test(line) && !/wa-identity/.test(line)) direct.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(direct, [], `روابط واتساب مباشرة بلا تتبّع — استخدم waHref مع trackWhatsApp: ${direct.join(' · ')}`);
});

/* ─── المسار والوسم مُفعَّل ────────────────────────────────────────────────
 * المعرّفات تُقرأ من import.meta.env وهي فارغة تحت tsx، فبلا __setAdsConfigForTests
 * تمرّ فحوص المسار أعلاه مهما فعل الكود (الوحدة خاملة أصلاً). هنا بيئة متصفّح
 * مصغّرة: نافذة ومستند وتخزين محلي ومتصفّح — تُثبَّت وتُستعاد لكل اختبار. */

interface FakeEl { tag: string; async?: boolean; src?: string }
interface Sandbox {
  win: Record<string, unknown> & { location: { pathname: string; href: string } };
  scripts: FakeEl[];
  timers: (() => void)[];
  dataLayer: () => unknown[] | undefined;
}

const GLOBALS = ['window', 'document', 'localStorage', 'navigator'] as const;

function withBrowser(
  opts: { href: string; optout?: boolean; gpc?: boolean; dnt?: boolean; storageThrows?: boolean },
  fn: (sb: Sandbox) => void,
): void {
  const url = new URL(opts.href);
  const scripts: FakeEl[] = [];
  const timers: (() => void)[] = [];
  const store = new Map<string, string>(opts.optout ? [['fs_optout', '1']] : []);
  const win = {
    location: { pathname: url.pathname, href: url.href, search: url.search, hostname: url.hostname },
    setTimeout: (cb: () => void) => { timers.push(cb); return timers.length; },
    clearTimeout: () => { /* المؤقّت اليدوي لا يُلغى — نختبر أن `after` لا يتكرّر رغم ذلك */ },
  } as Sandbox['win'];
  const values: Record<(typeof GLOBALS)[number], unknown> = {
    window: win,
    document: {
      createElement: (tag: string) => ({ tag }),
      head: { appendChild: (el: FakeEl) => { scripts.push(el); return el; } },
      cookie: '',
    },
    localStorage: {
      getItem: (k: string) => { if (opts.storageThrows) throw new Error('SecurityError'); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (opts.storageThrows) throw new Error('SecurityError'); store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    navigator: { globalPrivacyControl: opts.gpc === true, doNotTrack: opts.dnt ? '1' : undefined },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const k of GLOBALS) Object.defineProperty(g, k, { value: values[k], configurable: true, writable: true });
  __setAdsConfigForTests({ adsId: 'AW-TEST', labelSignup: 'AW-TEST/signup', labelWhatsApp: 'AW-TEST/wa' });
  try {
    fn({ win, scripts, timers, dataLayer: () => win.dataLayer as unknown[] | undefined });
  } finally {
    __setAdsConfigForTests({});
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

const argsOf = (entry: unknown) => {
  assert.equal(Object.prototype.toString.call(entry), '[object Arguments]', 'gtag.js يتجاهل ما ليس كائن arguments');
  return Array.from(entry as ArrayLike<unknown>);
};

test('الوسم مُفعَّل: صفحة هبوط الحملة تحمّل سكربتاً واحداً فقط وبإعداد بلا تخصيص إعلاني', () => {
  const href = 'https://fieldsa.net/pricing/?gclid=EAIaTest';
  withBrowser({ href }, ({ win, scripts, dataLayer }) => {
    assert.equal(initAdsTag('/pricing/'), true);
    // تكرار المسار نفسه وتنقّل داخلي إلى صفحة تسويقية أخرى ⇒ لا تحميل ثانٍ
    assert.equal(initAdsTag('/pricing/'), true);
    win.location.pathname = '/signup';
    assert.equal(initAdsTag('/signup'), true);

    assert.equal(scripts.length, 1, `عدد سكربتات الوسم: ${scripts.length}`);
    assert.equal(scripts[0].async, true);
    assert.equal(scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=AW-TEST');

    const dl = dataLayer() || [];
    assert.equal(dl.length, 2, 'المتوقّع أمرا js وconfig فقط');
    assert.equal(argsOf(dl[0])[0], 'js');
    const [cmd, id, cfg] = argsOf(dl[1]) as [string, string, Record<string, unknown>];
    assert.equal(cmd, 'config');
    assert.equal(id, 'AW-TEST');
    assert.equal(cfg.allow_ad_personalization_signals, false, 'إشارات التخصيص الإعلاني يجب أن تبقى معطّلة');
    assert.equal(cfg.page_location, href, 'رابط الهبوط بمعرّف النقر يُثبَّت في الإعداد');
    assert.deepEqual(Object.keys(cfg).sort(), ['allow_ad_personalization_signals', 'page_location'],
      'مفتاح إعداد جديد (user_data، allow_google_signals…) يغيّر ما تَعِد به سياسة الخصوصية — راجعها أولاً');
  });
});

test('الوسم مُفعَّل: لا تحميل ولا dataLayer داخل التطبيق والبوابات وصفحات عملاء عملائنا', () => {
  for (const p of ['/app', '/app/customers', '/m', '/rep', '/login', '/hx', '/ax', '/c/a/b', '/pay/t', '/payment/success']) {
    withBrowser({ href: `https://fieldsa.net${p}?gclid=x` }, ({ scripts, dataLayer, timers }) => {
      assert.equal(initAdsTag(p), false, `حُمِّل الوسم على ${p}`);
      let redirects = 0;
      trackSignup(() => { redirects++; });
      trackWhatsApp('x');
      assert.equal(redirects, 1, `الانتقال بعد التسجيل على ${p} يجب أن يحدث فوراً ومرّة واحدة`);
      assert.equal(scripts.length, 0, `سكربت وسم على ${p}`);
      assert.equal(dataLayer(), undefined, `dataLayer على ${p}`);
      assert.equal(timers.length, 0);
    });
  }
});

test('الوسم مُفعَّل: وسم محمَّل من صفحة تسويقية لا يُطلق تحويلاً بعد الانتقال إلى مسار محجوب', () => {
  withBrowser({ href: 'https://fieldsa.net/pricing/?gclid=x' }, ({ win, dataLayer, scripts }) => {
    assert.equal(initAdsTag('/pricing/'), true);
    const before = (dataLayer() || []).length;
    for (const p of ['/app', '/c/tenant/rep', '/pay/tok']) {
      win.location.pathname = p;
      let redirects = 0;
      trackSignup(() => { redirects++; });
      trackWhatsApp('x');
      assert.equal(redirects, 1);
      assert.equal((dataLayer() || []).length, before, `دُفع تحويل على ${p}`);
    }
    assert.equal(scripts.length, 1);
  });
});

test('الوسم مُفعَّل: تحويل التسجيل يُرسل ثم ينتقل مرّة واحدة مهما تكرّر التأكيد أو سبقته المهلة', () => {
  // (أ) تأكيد الإرسال مرّتين ثم المهلة
  withBrowser({ href: 'https://fieldsa.net/signup' }, ({ dataLayer, timers }) => {
    let redirects = 0;
    trackSignup(() => { redirects++; });
    assert.equal(redirects, 0, 'لا انتقال قبل تأكيد الإرسال أو المهلة');
    const dl = dataLayer() || [];
    const [cmd, name, params] = argsOf(dl[dl.length - 1]) as [string, string, Record<string, unknown>];
    assert.equal(cmd, 'event');
    assert.equal(name, 'conversion');
    assert.equal(params.send_to, 'AW-TEST/signup');
    const cb = params.event_callback as () => void;
    cb(); cb();
    timers.forEach((t) => t());
    assert.equal(redirects, 1);
  });
  // (ب) المهلة أولاً (وسم محجوب لا يؤكّد) ثم تأكيد متأخّر
  withBrowser({ href: 'https://fieldsa.net/signup' }, ({ dataLayer, timers }) => {
    let redirects = 0;
    trackSignup(() => { redirects++; });
    assert.equal(timers.length, 1);
    timers[0]();
    assert.equal(redirects, 1);
    const dl = dataLayer() || [];
    ((argsOf(dl[dl.length - 1])[2] as Record<string, unknown>).event_callback as () => void)();
    assert.equal(redirects, 1);
  });
  // (ج) تحويل واتساب يحمل تسميته ومرجع الصفحة
  withBrowser({ href: 'https://fieldsa.net/pricing/' }, ({ dataLayer }) => {
    trackWhatsApp('pricing');
    const dl = dataLayer() || [];
    const params = argsOf(dl[dl.length - 1])[2] as Record<string, unknown>;
    assert.equal(params.send_to, 'AW-TEST/wa');
    assert.equal(params.ref, 'pricing');
  });
});

test('الوسم مُفعَّل: رفض التتبّع يمنع التحميل كلياً (إيقاف صريح · GPC · DNT · تخزين محجوب)', () => {
  const cases: [string, Parameters<typeof withBrowser>[0]][] = [
    ['fs_optout=1', { href: 'https://fieldsa.net/pricing/?gclid=x', optout: true }],
    ['GPC', { href: 'https://fieldsa.net/pricing/?gclid=x', gpc: true }],
    ['DNT', { href: 'https://fieldsa.net/pricing/?gclid=x', dnt: true }],
    ['تخزين محجوب', { href: 'https://fieldsa.net/pricing/?gclid=x', storageThrows: true }],
  ];
  for (const [name, opts] of cases) {
    withBrowser(opts, ({ scripts, dataLayer }) => {
      assert.equal(initAdsTag('/pricing/'), false, `حُمِّل الوسم رغم ${name}`);
      let redirects = 0;
      trackSignup(() => { redirects++; });
      assert.equal(redirects, 1);
      assert.equal(scripts.length, 0, `سكربت رغم ${name}`);
      assert.equal(dataLayer(), undefined, `dataLayer رغم ${name}`);
    });
  }
});

/**
 * Google Analytics يضع كوكيز `_ga` لا تذكرها سياسة الخصوصية. عودة معرّف GA إلى
 * الكود (سطر إعداد واحد) كانت ستجعل السياسة المنشورة كاذبة بصمت.
 */
test('لا Google Analytics في الكود ما لم تذكره سياسة الخصوصية بلغاتها الخمس', () => {
  const srcRoot = new URL('../', import.meta.url);
  const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return walk(new URL(`${e.name}/`, dir));
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [new URL(e.name, dir).href] : [];
  });
  const usesGa = walk(srcRoot).filter((href) => {
    const s = readFileSync(new URL(href), 'utf8');
    // قراءة المتغيّر فعلاً (لا ذكره في تعليق) أو معرّف G- مكتوب في الكود
    return /env\??\.\s*VITE_GA_ID|\bgtag\(\s*['"]config['"]\s*,\s*['"]G-|googletagmanager\.com\/gtag\/js\?id=G-/.test(s);
  });
  if (!usesGa.length) return;
  const landing = new URL('../landing/', import.meta.url);
  const silent = ['defaultContent.ts', 'defaultContentEn.ts', 'defaultContentFr.ts', 'defaultContentTr.ts', 'defaultContentZh.ts']
    .filter((f) => {
      const s = readFileSync(new URL(f, landing), 'utf8');
      return !(/Google Analytics/.test(s) && /\b_ga\b/.test(s));
    });
  assert.deepEqual(silent, [], `Google Analytics مستخدم في ${usesGa.join(', ')} والسياسة لا تذكره في: ${silent.join(', ')}`);
});

/* ─── زرّ «إيقاف القياس»: وعد السياسة (القسم ٧) بحذف ما وضعه وسم Google Ads ─────── */

/** طلبات القياس الإعلاني وما ليس منها — تُستعمل للحذف عند الإيقاف ولعامل الخدمة معاً */
const AD_URLS = [
  'https://www.googletagmanager.com/gtag/js?id=AW-123',
  'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123/?url=https%3A%2F%2Ffieldsa.net%2F%3Fgclid%3Dx',
  'https://www.googleadservices.com/pagead/conversion/123/?gclid=x',
  'https://region1.google-analytics.com/g/collect?v=2',
  'https://www.google.com/pagead/1p-conversion/123/?gclid=x',
  'https://www.google.com/ccm/collect?en=page_view',
  'https://www.google.com/rmkt/collect/123/',
];
const NON_AD_URLS = [
  'https://fieldsa.net/assets/index-abc123.js',
  'https://fieldsa.net/icons/icon-192.png',
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic',
  'https://www.google.com/maps/vt?x=1',
  'https://google.com/pagead/x',               // النطاق www.google.com وحده
  'https://notgoogletagmanager.com/gtag/js',   // لاحقة نطاق لا جزء من كلمة
];

test('isAdMeasurementUrl: نطاقات الوسم ومسارات التحويل وحدها', () => {
  assert.deepEqual(AD_URLS.filter((u) => !isAdMeasurementUrl(u)), []);
  assert.deepEqual(NON_AD_URLS.filter((u) => isAdMeasurementUrl(u)), []);
  assert.equal(isAdMeasurementUrl('ليس رابطاً'), false);
});

test('isGoogleAdsStorageName: البادئتان والأسماء الثابتة لا غير', () => {
  for (const n of ['_gcl_au', '_gcl_aw', '_gcl_gs', '_gcl_ag', '_gcl_ls', '_gac_UA-1', '_gac_gb_123', 'FPGCLAW', 'FPGCLGB', 'FPLC']) {
    assert.equal(isGoogleAdsStorageName(n), true, n);
  }
  for (const n of ['fs_optout', 'fs_ref', 'fs_ref_clicked', 'app_lang', 'ax_token', '_ga', '_gcl', 'gcl_au', 'FPID']) {
    assert.equal(isGoogleAdsStorageName(n), false, n);
  }
});

type Globals = Record<string, unknown>;

async function withGlobals(values: Globals, fn: () => Promise<void>): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const k of Object.keys(values)) Object.defineProperty(g, k, { value: values[k], configurable: true, writable: true });
  try {
    await fn();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

function fakeStorage(m: Map<string, string>) {
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

/** Cache Storage مصغّرة: اسم الكاش ⇒ روابط طلباته */
function fakeCaches(entries: Map<string, Set<string>>) {
  return {
    keys: async () => [...entries.keys()],
    open: async (name: string) => {
      if (!entries.has(name)) entries.set(name, new Set());
      const set = entries.get(name)!;
      return {
        keys: async () => [...set].map((url) => ({ url })),
        delete: async (req: { url: string } | string) => set.delete(typeof req === 'string' ? req : req.url),
        put: async (req: { url: string } | string) => { set.add(typeof req === 'string' ? req : req.url); },
        match: async () => undefined,
        addAll: async () => undefined,
      };
    },
    delete: async (name: string) => entries.delete(name),
    match: async () => undefined,
  };
}

test('إيقاف القياس: يحذف كوكيز الوسم بكل نطاق، ومفاتيح الإسناد والوسم، وطلبات القياس المخزّنة', async () => {
  const local = new Map<string, string>([
    ['fs_anon', 'a_1'], ['fs_sess', '{}'], ['fs_ft', '{}'],
    ['_gcl_ls', '{"gclid":"x"}'], ['_gac_gb_123', 'x'],
    ['fs_ref', 'CODE'], ['fs_ref_clicked', '1'], ['app_lang', 'en'], ['ax_token', 't'],
  ]);
  const session = new Map<string, string>([['_gcl_aw', 'x'], ['keep_me', 'y']]);
  const writes: string[] = [];
  const document = {
    get cookie() { return '_gcl_gs=2.1.k1; _gac_UA-1=1.x; fs_other=1; _gcl_aw=GCL.1.x'; },
    set cookie(v: string) { writes.push(v); },
  };
  const entries = new Map<string, Set<string>>([['dsd-rep-v3', new Set([...AD_URLS, ...NON_AD_URLS, 'https://fieldsa.net/rep'])]]);

  await withGlobals({
    window: { location: { hostname: 'www.fieldsa.net', pathname: '/privacy/', search: '' } },
    document,
    localStorage: fakeStorage(local),
    sessionStorage: fakeStorage(session),
    navigator: {},
    caches: fakeCaches(entries),
  }, async () => {
    await optOut();
  });

  // التخزين المحلي: علامة الإيقاف تبقى، ومعرّفاتنا ومفاتيح الوسم تُحذف، ورمز الإحالة واللغة لا يُمسّان
  assert.equal(local.get('fs_optout'), '1');
  assert.deepEqual([...local.keys()].sort(), ['app_lang', 'ax_token', 'fs_optout', 'fs_ref', 'fs_ref_clicked']);
  assert.deepEqual([...session.keys()], ['keep_me']);

  // الكوكيز: كل اسم للوسم (المقروء من document.cookie والثابت) على المسار / وبلا نطاق وبالنطاق ونطاقه الأب
  const cleared = (name: string, domain: string | null) => writes.some((w) => {
    if (!w.startsWith(`${name}=;`) || !/Max-Age=0/.test(w) || !/; path=\/(;|$)/.test(w)) return false;
    return domain === null ? !/domain=/.test(w) : w.endsWith(`; domain=${domain}`);
  });
  const missing: string[] = [];
  for (const name of ['_gcl_au', '_gcl_aw', '_gcl_gs', '_gac_UA-1', 'FPGCLAW', 'FPGCLGB', 'FPLC']) {
    for (const d of [null, '.www.fieldsa.net', '.fieldsa.net']) if (!cleared(name, d)) missing.push(`${name}@${d ?? 'host'}`);
  }
  assert.deepEqual(missing, [], `كوكيز لم تُحذف: ${missing.join(', ')}`);
  assert.equal(writes.some((w) => w.startsWith('fs_other=')), false, 'حُذف كوكي ليس للوسم');
  assert.equal(writes.some((w) => /domain=\.net\b/.test(w)), false, 'محاولة على لاحقة النطاق العلوي وحدها');

  // Cache Storage: طلبات القياس وحدها تُحذف، والقوقعة والأصول تبقى للعمل دون اتصال
  assert.deepEqual([...entries.keys()], ['dsd-rep-v3']);
  assert.deepEqual([...entries.get('dsd-rep-v3')!].sort(), [...NON_AD_URLS, 'https://fieldsa.net/rep'].sort());
});

test('إيقاف القياس لا ينهار ولا يعلق: بلا caches، وcaches ترمي، وتخزين محجوب', async () => {
  const doc = { cookie: '' };
  const blocked = {
    get length(): number { throw new Error('SecurityError'); },
    key: () => { throw new Error('SecurityError'); },
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
    removeItem: () => { throw new Error('SecurityError'); },
  };
  const win = { location: { hostname: 'fieldsa.net', pathname: '/privacy/', search: '' } };
  await withGlobals({ window: win, document: doc, localStorage: blocked, sessionStorage: blocked, navigator: {}, caches: undefined }, async () => {
    await optOut();
  });
  const throwing = { keys: async () => { throw new Error('boom'); } };
  await withGlobals({ window: win, document: doc, localStorage: fakeStorage(new Map()), sessionStorage: fakeStorage(new Map()), navigator: {}, caches: throwing }, async () => {
    await optOut();
  });
});

/* ─── عامل الخدمة: لا تخزين لطلبات القياس الإعلاني، ولا تغيير لأي طلب آخر ───── */

const SW_SRC = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

function loadServiceWorker(entries: Map<string, Set<string>>, caches: unknown = fakeCaches(entries)) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const fetched: string[] = [];
  vm.runInNewContext(SW_SRC, {
    self: {
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
    },
    caches,
    fetch: (req: { url: string } | string) => {
      fetched.push(typeof req === 'string' ? req : req.url);
      return Promise.resolve({ clone: () => ({}) });
    },
    URL,
  });
  return { handlers, fetched };
}

const flush = () => new Promise((r) => setImmediate(r));

test('عامل الخدمة: طلبات القياس الإعلاني تمرّ إلى الشبكة بلا اعتراض ولا تخزين', async () => {
  const entries = new Map<string, Set<string>>([['dsd-rep-v3', new Set()]]);
  const { handlers } = loadServiceWorker(entries);
  assert.equal(typeof handlers.fetch, 'function');
  const intercepted = (url: string) => {
    let responded = false;
    handlers.fetch({ request: { method: 'GET', url, mode: 'no-cors' }, respondWith: (p: Promise<unknown>) => { responded = true; void p; } });
    return responded;
  };
  const touchedAds = AD_URLS.filter(intercepted);
  assert.deepEqual(touchedAds, [], `اعترض عامل الخدمة طلب قياس: ${touchedAds.join(' · ')}`);
  // بقية الطلبات على سلوكها السابق تماماً: تُعترض وتُخزَّن
  const untouched = NON_AD_URLS.filter((u) => !intercepted(u));
  assert.deepEqual(untouched, [], `تغيّر سلوك طلب غير إعلاني: ${untouched.join(' · ')}`);
  await flush();
  const cached = [...entries.get('dsd-rep-v3')!];
  assert.equal(cached.some((u) => isAdMeasurementUrl(u)), false, 'خُزّن طلب قياس');
  assert.equal(cached.length, NON_AD_URLS.length);
});

test('عامل الخدمة والواجهة يطبّقان قاعدة القياس نفسها', () => {
  const { handlers } = loadServiceWorker(new Map([['dsd-rep-v3', new Set<string>()]]));
  const extra = ['https://www.google.com/search?q=x', 'https://stats.g.doubleclick.net/g/collect', 'https://www.googletagmanager.com/gtm.js?id=GTM-1'];
  const drift = [...AD_URLS, ...NON_AD_URLS, ...extra].filter((url) => {
    let responded = false;
    handlers.fetch({ request: { method: 'GET', url, mode: 'no-cors' }, respondWith: () => { responded = true; } });
    return responded === isAdMeasurementUrl(url);
  });
  assert.deepEqual(drift, [], `قاعدتا sw.js وattribution.ts انحرفتا في: ${drift.join(' · ')}`);
});

test('عامل الخدمة: التفعيل يمحو طلبات القياس المخزّنة سابقاً دون تغيير اسم الكاش', async () => {
  // اسم الكاش ثابت: رفعه يمحو قوقعة المندوب والأصول المخزّنة للعمل دون اتصال
  assert.match(SW_SRC, /const CACHE = 'dsd-rep-v3';/);
  const entries = new Map<string, Set<string>>([
    ['dsd-rep-v3', new Set([...AD_URLS, ...NON_AD_URLS, '/rep'])],
    ['dsd-rep-v2', new Set(['/rep'])],
  ]);
  const { handlers } = loadServiceWorker(entries);
  let done: Promise<unknown> = Promise.resolve();
  handlers.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
  await done;
  assert.deepEqual([...entries.keys()], ['dsd-rep-v3'], 'الكاش القديم يُحذف كما كان');
  // التنظيف يجري في الخلفية خارج waitUntil — ننتظر اكتماله بدورات قليلة
  const hasAds = () => [...entries.get('dsd-rep-v3')!].some((u) => isAdMeasurementUrl(u));
  for (let i = 0; i < 50 && hasAds(); i++) await flush();
  assert.deepEqual([...entries.get('dsd-rep-v3')!].sort(), [...NON_AD_URLS, '/rep'].sort());
});

/**
 * الصفحات المفتوحة تنتظر انتهاء وعد التفعيل قبل أيّ طلب (مواصفة Service Worker، وskipWaiting
 * يفعّل العامل والصفحات مفتوحة). فالوعد الممرَّر إلى waitUntil يجب ألّا ينتظر المرور على
 * مدخلات الكاش — وهي تكبر بلا حدّ (أصول كل نشر وبلاطات الخرائط) — وإلا تأخّرت الملاحة بعد النشر.
 */
test('عامل الخدمة: وعد التفعيل لا ينتظر المرور على مدخلات الكاش، والتنظيف يكتمل في الخلفية', async () => {
  const entries = new Map<string, Set<string>>([
    ['dsd-rep-v3', new Set([...AD_URLS, ...NON_AD_URLS, '/rep'])],
    ['dsd-rep-v2', new Set(['/rep'])],
  ]);
  const base = fakeCaches(entries);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let listing = false;
  // مدخلات الكاش «بطيئة» عمداً: لا تُعاد حتى نفتح البوابة
  const slow = {
    ...base,
    open: async (name: string) => {
      const c = await base.open(name);
      return { ...c, keys: async () => { listing = true; await gate; return c.keys(); } };
    },
  };
  const { handlers } = loadServiceWorker(entries, slow);
  const cap: { p?: Promise<unknown> } = {};
  handlers.activate({ waitUntil: (p: Promise<unknown>) => { cap.p = p; } });
  assert.ok(cap.p, 'التفعيل لم يمرّر وعداً إلى waitUntil');
  const settled = await Promise.race([
    cap.p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 200)),
  ]);
  assert.equal(settled, true, 'وعد التفعيل ينتظر المرور على مدخلات الكاش — الملاحة تتأخّر بعد النشر');
  assert.deepEqual([...entries.keys()], ['dsd-rep-v3'], 'الكاش القديم يُحذف داخل وعد التفعيل');
  for (let i = 0; i < 20 && !listing; i++) await flush();
  assert.equal(listing, true, 'التنظيف لم يبدأ عند التفعيل');
  release();
  const hasAds = () => [...entries.get('dsd-rep-v3')!].some((u) => isAdMeasurementUrl(u));
  for (let i = 0; i < 50 && hasAds(); i++) await flush();
  assert.deepEqual([...entries.get('dsd-rep-v3')!].sort(), [...NON_AD_URLS, '/rep'].sort());
});

/* ─── قمع الحملة: زرّ التجربة يصل إلى صفحة التسجيل بكل لغة ────────────────── */

/**
 * `pathForLocale('/signup', 'en')` ⇒ `/en/signup` غير مسجَّل، فيحوّله المسار `*` إلى
 * الرئيسية العربية: زائر الحملة غير العربي لا يسجّل ولا يُرسل تحويل التسجيل.
 * كل هدف ثابت لـpathForLocale يجب أن يكون مساراً مسجَّلاً في App.tsx بكل بادئة لغة.
 */
test('كل رابط pathForLocale ثابت يقع على مسار مسجَّل في App.tsx بكل لغة', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const routes = new Set([...app.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map((m) => m[1]));
  const srcRoot = new URL('../', import.meta.url);
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return walk(new URL(`${e.name}/`, dir));
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [new URL(e.name, dir)] : [];
  });
  const broken: string[] = [];
  let seen = 0;
  for (const file of walk(srcRoot)) {
    const s = readFileSync(file, 'utf8');
    for (const m of s.matchAll(/pathForLocale\(\s*'(\/[^']*)'/g)) {
      seen++;
      for (const prefix of ['/en', '/fr', '/tr', '/zh']) {
        const p = m[1] === '/' ? prefix : prefix + m[1];
        if (!routes.has(p)) broken.push(`${file.pathname.split('/src/').pop()}: ${p}`);
      }
    }
  }
  assert.ok(seen > 5, `تعذّر العثور على استدعاءات pathForLocale (${seen})`);
  assert.deepEqual([...new Set(broken)], [], `روابط تقع على مسار غير مسجَّل فتُحوَّل إلى الرئيسية: ${[...new Set(broken)].join(' · ')}`);
  // صفحة الأسعار (هبوط الحملة) تربط التسجيل بلا بادئة، و/signup نفسه يحمل الوسم فيُطلق التحويل
  const pricing = readFileSync(new URL('../pages/PricingPage.tsx', import.meta.url), 'utf8');
  assert.match(pricing, /const signupPath = '\/signup';/);
  assert.ok(routes.has('/signup'));
  assert.equal(isAdsTagRoute('/signup'), true);
});

/**
 * زرّ التجربة في صفحة الأسعار تنقّل داخلي (`<Link>`) لا `<a href>`: إعادة تحميل المستند
 * تُضيع وسوم الهبوط المحفوظة في الذاكرة فتصل زيارة /signup بلا وسوم ولا معرّف نقر،
 * ومُحيلها fieldsa.net يُسقطه الخادم ⇒ «مباشرة» بدل الحملة في أهم خطوة من القمع.
 */
test('صفحة الأسعار: لا <a> يوجّه إلى /signup — التسجيل بـ<Link> يحفظ وسوم الحملة', () => {
  const pricing = readFileSync(new URL('../pages/PricingPage.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // التعليقات قد تذكر «<a>» نصّاً
  // العنصر كاملاً حتى </a>: خصائصه قد تحوي «=>» فلا يصلح القصّ عند أول «>»
  const anchors = [...pricing.matchAll(/<a\b[\s\S]*?<\/a>/g)].map((m) => m[0]);
  assert.ok(anchors.length > 0, 'تعذّر قراءة وسوم <a> في PricingPage.tsx');
  const reload = anchors.filter((a) => /signupPath|['"`]\/signup/.test(a));
  assert.deepEqual(reload, [], `رابط تسجيل يعيد تحميل الصفحة: ${reload.join(' · ')}`);
  const links = pricing.match(/<Link\s+to=\{signupPath\}/g) || [];
  assert.ok(links.length >= 2, `المتوقّع زرّا تجربة بـ<Link> (بطاقة الباقة وأسفل الصفحة)، وُجد ${links.length}`);
});
