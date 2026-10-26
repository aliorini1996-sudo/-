import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { checkText, norm, DATE_OR_NUMBER, PHASE2, RULES, findViolations } from '../../scripts/claims-rules.mjs';
import { loadCmsFixes } from '../../scripts/cms-content.mjs';
import { lastModifiedOf } from '../blog/posts';
import { defaultContent } from '../landing/defaultContent';
import { CMS_FIXES, CMS_FIXES_VERSION, applyCmsFixes, planCmsFixes, publicCmsContent, pricesIn, planPrices, type CmsFix } from './cmsFixes';

/**
 * حرّاس مساعد تصحيح CMS (cmsFixes.ts).
 *
 * القائمة تكتب نصوصاً تُنشر في أهم صفحات الموقع بزرّ واحد، فكل نص جديد يُفحص هنا بالقواعد نفسها التي
 * تحرس dist (scripts/claims-rules.mjs) وبحارس الأسعار، والتطبيق نفسه يُفحص: لا يمسّ شيئاً إن لم يطابق.
 * (المطابقة على CMS الحيّ قيست وقت الكتابة: ١١٣ بنداً تنطبق كلها مرة واحدة ثم «مطبَّق» في الإعادة.)
 */

/** النص المرئي كما يستخرجه verify-claims (الوسوم مسافات) */
const visible = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** أسعار الباقات في المصدر الافتراضي للمستودع (أرقام هندية هناك) — الأسعار الحيّة 299/399/599 */
const ALLOWED = new Set(planPrices(defaultContent));

test('القائمة سليمة البنية: معرّفات فريدة، ونص قديم وجديد مختلفان، ومسار صالح', () => {
  assert.ok(CMS_FIXES.length > 50, 'القائمة أقصر من المتوقع');
  const ids = CMS_FIXES.map((f) => f.id);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'معرّف مكرّر');
  for (const f of CMS_FIXES) {
    assert.ok(f.from.trim().length >= 8, `${f.id}: نص قديم قصير يلتبس`);
    assert.notEqual(f.from, f.to, `${f.id}: لا تغيير`);
    assert.match(f.path, /^(?:[A-Za-z]+(?:\[[^\]]+\])?\.)*[A-Za-z]+$/, `${f.id}: مسار غير صالح ${f.path}`);
  }
});

test('كل نص جديد يجتاز قواعد الادّعاءات كلها (النص المرئي والخام)', () => {
  for (const f of CMS_FIXES) {
    assert.deepEqual(checkText(visible(f.to)), [], `${f.id}: «${visible(f.to)}»`);
    assert.deepEqual(checkText(f.to), [], `${f.id} (خام)`);
  }
});

test('لا نص جديد فيه «معتمد» أو مصادقة أو ترخيص أو شراكة رسمية', () => {
  // «ZATCA certifies no vendor» نفيٌ مشروع فلا يُحجب فعل certify نفسه — الممنوع صفة الاعتماد
  const banned = /معتمد|مصادق|مرخص|شريك\s*رسمي|\bcertified\b|\bapproved\b|\baccredited\b|\bofficial\s+partner\b|certifié|agréé|homologué/i;
  for (const f of CMS_FIXES) assert.doesNotMatch(norm(visible(f.to)), banned, f.id);
});

test('لا نص جديد فيه موعد أو رقم من صنف المواعيد (سنة · شهر · «خلال» · «منذ» · موجة · عدد عملاء)', () => {
  for (const f of CMS_FIXES) {
    // «المرحلة 2» ليست رقماً — كما في requireNear داخل findViolations
    const t = norm(visible(f.to)).replace(new RegExp(PHASE2, 'gi'), ' ');
    assert.doesNotMatch(t, DATE_OR_NUMBER, `${f.id}: «${t}»`);
  }
});

test('صيغة الربط الوحيدة: كل «ندعم/يدعم ربط المرحلة الثانية» يتبعه «مع منصة فاتورة»', () => {
  for (const f of CMS_FIXES) {
    const t = norm(visible(f.to));
    for (const m of t.matchAll(/[نيت]دعم ربط المرحلة الثانية/g)) {
      assert.ok(t.slice(m.index! + m[0].length).startsWith(' مع منصة فاتورة'), `${f.id}: «${t}»`);
    }
    for (const m of t.matchAll(/\bsupports?\s+Phase 2 integration/gi)) {
      assert.ok(t.slice(m.index! + m[0].length).startsWith(' with ZATCA’s Fatoora platform'), `${f.id}: «${t}»`);
    }
  }
});

test('كل وعد «دون اتصال» في نص جديد يقترن بقيد الشركات المفعّل لها الربط', () => {
  const offline = /بلا إنترنت|بدون إنترنت|دون اتصال|بلا اتصال|أوف-?لاين|\boffline\b/i;
  const limited = /المفعل لها|integration enabled/i;
  for (const f of CMS_FIXES) {
    const t = norm(visible(f.to));
    if (offline.test(t)) assert.match(t, limited, `${f.id}: وعد دون اتصال بلا قيد — «${t}»`);
    // القيد يسمّي الفواتير القياسية والمبسّطة معاً (تصحيح الناقد ٩): «الفاتورة الضريبية» وحدها تُفهم أن
    // المبسّطة تصدر دون اتصال، والتطبيق يمنع الاثنتين والمرتجع حين يكون الربط مفعّلاً (RepApp.tsx)
    if (/المفعل لها/.test(t)) assert.match(t, /القياسية والمبسطة/, `${f.id}: القيد لا يسمّي القياسية والمبسّطة`);
    if (/integration enabled/i.test(t)) assert.match(t, /standard and simplified/i, `${f.id}: constraint must name both invoice types`);
  }
});

test('حارس الأسعار: أسعار النصوص الجديدة من الباقات وحدها، و399 لا تسقط، ولا سعر سنوي', () => {
  assert.deepEqual([...ALLOWED].sort(), ['299', '399', '599'], 'أسعار المصدر الافتراضي تغيّرت — راجع بنود الأسعار');
  for (const f of CMS_FIXES) {
    const prices = pricesIn(f.to);
    for (const p of prices) assert.ok(ALLOWED.has(p), `${f.id}: سعر ${p} ليس من الباقات`);
    if (prices.includes('299') && prices.includes('599')) assert.ok(prices.includes('399'), `${f.id}: جملة سعر تُسقط 399`);
    // مبلغ بأربع خانات فأكثر بجوار العملة = مجموع سنوي (عروض الأسعار تعرض سنوياً مختلفاً) — ممنوع
    assert.doesNotMatch(f.to, /\d[\d,٬]{3,}\s*(?:ر\.?\s?س|ريال|SAR)|SAR\s*\d[\d,]{3,}/, `${f.id}: مبلغ سنوي`);
  }
  // كل بند سعر كان يُسقط 399 صار يذكرها
  for (const f of CMS_FIXES.filter((x) => x.group === 'price')) {
    const before = pricesIn(f.from);
    if (before.includes('299') && before.includes('599')) assert.ok(pricesIn(f.to).includes('399'), f.id);
  }
});

// ── التطبيق ──────────────────────────────────────────────────────────────────

/** يبني محتوى اصطناعياً يحمل نصوص `from` في مساراتها — مكان المحدِّد يُنشأ عنصراً بمفتاحه */
function setPath(root: Record<string, unknown>, path: string, value: string) {
  const segs = path.match(/[^.[\]]+(?:\[[^\]]*\])?/g)!;
  let node: Record<string, unknown> = root;
  segs.forEach((s, i) => {
    const m = s.match(/^([^[]+)(?:\[(.*)\])?$/)!;
    const [, key, sel] = m;
    const last = i === segs.length - 1;
    if (sel === undefined) {
      if (last) node[key] = value;
      else node = (node[key] ??= {}) as Record<string, unknown>;
      return;
    }
    const arr = (node[key] ??= []) as Record<string, unknown>[];
    const [k, v] = sel.split('=');
    let item = arr.find((x) => String(x[k]) === v);
    if (!item) { item = { [k]: v }; arr.push(item); }
    node = item;
  });
}

const PLANS = { pricing: { plans: [{ price: '299' }, { price: '399' }, { price: '599' }] } };

function synthetic(fixes: CmsFix[] = CMS_FIXES) {
  const byPath = new Map<string, string[]>();
  for (const f of fixes) byPath.set(f.path, [...(byPath.get(f.path) || []), f.from]);
  const root: Record<string, unknown> = structuredClone(PLANS);
  for (const [p, froms] of byPath) setPath(root, p, `مقدمة | ${froms.join(' | ')} | خاتمة`);
  return root;
}

test('القائمة كاملة تنطبق مرة واحدة بلا تداخل، والإعادة لا تغيّر شيئاً', () => {
  const content = synthetic();
  const first = applyCmsFixes(content);
  const bad = first.results.filter((r) => r.status !== 'applied').map((r) => `${r.fix.id}:${r.status}`);
  assert.deepEqual(bad, [], 'بنود لم تنطبق على نصوصها نفسها (تداخل في الحقل نفسه أو مسار لا يُحلّ)');
  assert.equal(first.applied, CMS_FIXES.length);
  const second = applyCmsFixes(first.value);
  assert.deepEqual([...new Set(second.results.map((r) => r.status))], ['already']);
  assert.equal(second.applied, 0);
  assert.deepEqual(second.value, first.value, 'الإعادة غيّرت المحتوى (إلحاق مزدوج؟)');
});

test('التطبيق لا يغيّر شيئاً إن لم يطابق — ولا يمسّ الأصل', () => {
  const content = {
    ...structuredClone(PLANS),
    faq: { items: [{ q: 'هل الفواتير متوافقة مع هيئة الزكاة والضريبة؟', a: 'نص حرّره المالك بنفسه.' }] },
    blog: [{ slug: 'order-to-cash-cycle', contentHtml: '<p>نص آخر تماماً.</p>', en: { contentHtml: '<p>Other text.</p>' } }],
  };
  const snapshot = structuredClone(content);
  const { value, results, applied } = applyCmsFixes(content);
  assert.equal(applied, 0);
  assert.deepEqual(value, snapshot);
  assert.deepEqual(content, snapshot, 'الأصل تغيّر');
  assert.ok(results.every((r) => r.status === 'missing' || r.status === 'no-field'));
  assert.ok(results.some((r) => r.fix.id === 'home-faq-zatca' && r.status === 'missing'));
});

test('النص الموجود أكثر من مرة لا يُستبدل (ملتبس)', () => {
  const fix = CMS_FIXES.find((f) => f.id === 'order-to-cash-ar')!;
  const content = { ...structuredClone(PLANS), blog: [{ slug: 'order-to-cash-cycle', contentHtml: `${fix.from} … ${fix.from}` }] };
  const { value, results } = applyCmsFixes(content, [fix]);
  assert.equal(results[0].status, 'ambiguous');
  assert.deepEqual(value, content);
});

test('بند سعر لا يُطبَّق إن خالفت أسعارُه باقات المحتوى نفسه', () => {
  const fix = CMS_FIXES.find((f) => f.id === 'cash-guide-price')!;
  const content = {
    pricing: { plans: [{ price: '299' }, { price: '449' }, { price: '599' }] },
    blog: [{ slug: 'cash-van-software-guide', contentHtml: `<p>${fix.from}</p>` }],
  };
  const { value, results } = applyCmsFixes(content, [fix]);
  assert.equal(results[0].status, 'price-mismatch');
  assert.deepEqual(value, content);
  // وبالأرقام الهندية في الباقات (كما في المحتوى الافتراضي) يُطبَّق
  const ok = applyCmsFixes({ ...content, pricing: { plans: [{ price: '٢٩٩' }, { price: '٣٩٩' }, { price: '٥٩٩' }] } }, [fix]);
  assert.equal(ok.results[0].status, 'applied');
});

test('بنود الحقل الواحد تتتابع، والتشغيل الجافّ يطابق التطبيق', () => {
  const fixes = CMS_FIXES.filter((f) => f.path === 'blog[slug=cash-van-software-saudi].contentHtml');
  assert.ok(fixes.length >= 5);
  const content = synthetic(fixes);
  const planned = planCmsFixes(content, fixes).map((r) => r.status);
  const { results, value } = applyCmsFixes(content, fixes);
  assert.deepEqual(results.map((r) => r.status), planned);
  const text = (value as { blog: { contentHtml: string }[] }).blog[0].contentHtml;
  for (const f of fixes) assert.ok(text.includes(f.to), f.id);
  assert.doesNotMatch(text, /المرحلة الأولى/);
});

test('المحدِّد الملتبس (معرّف مقال مكرّر) لا يُخمَّن', () => {
  const fix = CMS_FIXES.find((f) => f.id === 'barcode')!;
  const content = {
    ...structuredClone(PLANS),
    blog: [
      { slug: 'barcode-scanning-invoices', contentHtml: fix.from },
      { slug: 'barcode-scanning-invoices', contentHtml: fix.from },
    ],
  };
  const { results, value } = applyCmsFixes(content, [fix]);
  assert.equal(results[0].status, 'no-field');
  assert.deepEqual(value, content);
});

/**
 * كتلة Article كما يسطّحها verify-claims (الأقواس والفواصل مسافات): العنوان ثم الوصف ثم datePublished — فعبارة
 * ربط قرب آخر الوصف تضع السنة في نافذة حارس الموعد. هذا ما أفشل أول بناء بالطبقة العامة (٤ أوصاف).
 */
const articleLdText = (title: string, description: string) =>
  ` @type : Article headline : ${title} description : ${description} inLanguage : ar datePublished : 2026-08-04 dateModified : ${CMS_FIXES_VERSION} image : https://fieldsa.net/og-image.png `;

test('لا مصطلح «المرحلة الثانية» في بند وصف — الوصف تتلوه datePublished في كتلة Article (كقاعدة catalog.mjs)', () => {
  const inDesc = CMS_FIXES.filter((f) => /\.description$/.test(f.path) && new RegExp(PHASE2, 'i').test(norm(f.to))).map((f) => f.id);
  assert.deepEqual(inDesc, [], 'جملة الربط في وصف مقال');
  // والقاعدة تعضّ فعلاً: الوصف القديم بجملة الربط في آخره كان يُفشل البناء
  const dated = RULES.find((r) => r.id === 'zatca-phase2-dated')!;
  assert.ok(findViolations(dated, articleLdText('', `How field reps issue simplified QR tax invoices. We support Phase 2 integration with ZATCA’s Fatoora platform.`)).length > 0);
});

// ── الطبقة العامة: المنشور مصحَّحاً، والمحرّر خام ──────────────────────────────

const SRC = new URL('../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, SRC), 'utf8');

test('publicCmsContent: يطبّق القائمة على نسخة ويختم تاريخ تعديل المقال المصحَّح وحده — ولا يمسّ الأصل', () => {
  const fix = CMS_FIXES.find((f) => f.id === 'order-to-cash-ar')!;
  const content = {
    ...structuredClone(PLANS),
    blog: [
      { slug: 'order-to-cash-cycle', date: '2026-08-04', contentHtml: `<p>${fix.from}</p>` },
      { slug: 'untouched-post', date: '2026-08-04', contentHtml: '<p>نص لا تمسّه القائمة.</p>' },
      { slug: 'newer-post', date: '2026-08-04', modified: '2026-12-01', contentHtml: '<p>نص.</p>' },
    ],
  };
  const snapshot = structuredClone(content);
  const r = publicCmsContent(content, [fix]);
  assert.deepEqual(content, snapshot, 'الأصل تغيّر');
  assert.equal(r.applied, 1);
  const [fixed, untouched, newer] = (r.value as typeof content).blog as { slug: string; date: string; modified?: string; contentHtml: string }[];
  assert.ok(fixed.contentHtml.includes(fix.to));
  assert.equal(fixed.modified, CMS_FIXES_VERSION);
  assert.equal(lastModifiedOf(fixed), CMS_FIXES_VERSION, 'lastmod/dateModified لا يتبع الختم');
  assert.equal(untouched.modified, undefined, 'مقال بلا بند خُتم تاريخه');
  assert.equal(newer.modified, '2026-12-01');
  assert.deepEqual(r.posts, [{ slug: 'order-to-cash-cycle', langs: ['ar'], applied: true }]);
  assert.deepEqual(r.home, { touched: false, applied: false });
});

test('publicCmsContent بعد حفظ المالك للزر: النص نفسه، لا تطبيق جديد، والتاريخ ثابت لا يرجع إلى تاريخ المقال', () => {
  const content = synthetic();
  const saved = applyCmsFixes(content).value; // ما يحفظه المالك من المحرّر (بلا ختم تاريخ)
  const fresh = publicCmsContent(content);
  const after = publicCmsContent(saved);
  assert.equal(after.applied, 0);
  assert.ok(after.posts.length > 0 && after.posts.every((p) => !p.applied));
  assert.deepEqual(after.value, fresh.value, 'المنشور بعد الحفظ يخالف المنشور قبله');
  assert.ok(after.home.touched && !after.home.applied);
  assert.equal(publicCmsContent(null).value, null);
});

/**
 * لقطة حيّة من /api/site-content (GET عام) — أو ملف بالمتغيّر CMS_SNAPSHOT. بلا شبكة يُتخطّى الاختبار.
 * إخفاقه يعني أن CMS تغيّر بعد كتابة القائمة (نفي جديد أو فقرة حُرّرت): حدّث cmsFixes.ts لا الاختبار.
 */
async function liveSnapshot(): Promise<Record<string, unknown> | null> {
  try {
    const file = process.env.CMS_SNAPSHOT;
    const body = file
      ? JSON.parse(readFileSync(file, 'utf8'))
      : await (await fetch('https://api.fieldsa.net/api/site-content', { signal: AbortSignal.timeout(15000) })).json();
    const data = body?.data ?? null;
    return data && typeof data === 'object' && Array.isArray(data.blog) ? data : null;
  } catch {
    return null;
  }
}

test('لقطة CMS الحيّة: القائمة تزيل «not built» و«غير مبنية لدينا» و«وفق المرحلة الأولى» من مقالات المدوّنة كلها، ولا عبارة ربط بجوار تاريخ كتلة Article', async (t) => {
  const live = await liveSnapshot();
  if (!live) { t.skip('CMS غير متاح (بلا شبكة) — CMS_SNAPSHOT=<ملف> للتشغيل على لقطة محفوظة'); return; }
  const { value } = publicCmsContent(live);
  const visible = (h: unknown) => String(h ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  // الاستثناءات العمدية في رأس cmsFixes.ts (الذكر التعليمي للمرحلة الأولى، ومعادلة العهدة، ومقال المقارنة)
  // لا تحوي أياً من العبارات الثلاث — فلا استثناء هنا
  const STALE: [string, RegExp][] = [
    ['not built', /not\s+(?:yet\s+)?built/i],
    ['غير مبنية لدينا', /غير\s*مبني[ةه]?\s*لدينا/],
    ['وفق المرحلة الأولى', /وفق\s+(?:ال)?مرحل[ةه]\s+ال[أا]ول[ىي]/],
  ];
  const stale = RULES.find((r) => r.id === 'zatca-phase2-stale-denial')!;
  const dated = RULES.find((r) => r.id === 'zatca-phase2-dated')!;
  const left: string[] = [];
  const blog = (value as { blog: Record<string, unknown>[] }).blog;
  for (const p of blog) {
    for (const [L, v] of [['ar', p], ['en', p.en]] as const) {
      if (!v || typeof v !== 'object') continue;
      // كتلة Article المُصيَّرة: لا عبارة ربط في العنوان أو الوصف بجوار datePublished (ما أفشل verify-claims)
      const ld = articleLdText(norm(String((v as Record<string, unknown>).title ?? '')), norm(String((v as Record<string, unknown>).description ?? '')));
      for (const hit of findViolations(dated, ld)) left.push(`${L}/${p.slug}: [dated في كتلة Article] «${hit.match}»`);
      for (const f of ['title', 'description', 'excerpt', 'contentHtml']) {
        const text = visible(norm(String((v as Record<string, unknown>)[f] ?? '')));
        for (const [name, re] of STALE) if (re.test(text)) left.push(`${L}/${p.slug}.${f}: «${name}»`);
        // وما تلتقطه قاعدة النفي القديم نفسها (رأس cmsFixes.ts: لا يبقى منه شيء بعد القائمة كاملة)
        for (const hit of findViolations(stale, text)) left.push(`${L}/${p.slug}.${f}: [stale-denial] «${hit.match.slice(0, 70)}»`);
      }
    }
  }
  assert.deepEqual(left, [], 'نفي قديم باقٍ في المنشور بعد القائمة');
});

test('السكربتات تحمّل القائمة نفسها (scripts/cms-content.mjs بـesbuild) وتطبّقها بالنتيجة نفسها', async () => {
  const mod = await loadCmsFixes();
  assert.equal(mod.CMS_FIXES.length, CMS_FIXES.length);
  assert.equal(mod.CMS_FIXES_VERSION, CMS_FIXES_VERSION);
  assert.match(CMS_FIXES_VERSION, /^\d{4}-\d{2}-\d{2}$/, 'التاريخ ثابت مكتوب لا «اليوم»');
  const content = synthetic();
  assert.deepEqual(mod.publicCmsContent(content).value, publicCmsContent(content).value);
  // والسكربتات الثلاث تقرأ CMS عبر الوحدة المشتركة لا جلباً خاصاً بها
  for (const s of ['prerender.mjs', 'gen-llms.mjs', 'gen-sitemap.mjs']) {
    const src = read(`../scripts/${s}`);
    assert.match(src, /from '\.\/cms-content\.mjs'/, `${s} لا يستعمل الوحدة المشتركة`);
    assert.doesNotMatch(src, /fetch\(\s*(?:API|CMS_API)/, `${s} ما زال يجلب CMS الخام بنفسه`);
  }
});

test('الواجهة: الصفحات العامة تجلب المحتوى المصحَّح، والمحرّران يقرآن CMS الخام', () => {
  const layer = read('content/publicSiteContent.ts');
  assert.match(layer, /publicCmsContent\(/, 'نقطة الجلب العامة لا تطبّق القائمة');
  // (الملف يستورد عميل API فلا يُستورد هنا — يُقرأ نصّه) المفتاح تحت بادئة 'site-content' فيُبطله حفظ المحرّرين،
  // ومختلف عن مفتاح ProfileEditorPanel ('site-content' وحده) فلا يتشاركان الذاكرة
  assert.ok(layer.includes("PUBLIC_SITE_CONTENT_KEY = ['site-content', 'public'] as const"), 'مفتاح المحتوى العام تغيّر');

  const PUBLIC = ['blog/useBlog.ts', 'pages/LandingPage.tsx', 'pages/PricingPage.tsx', 'pages/InfoPage.tsx', 'pages/ContactPage.tsx', 'pages/RepAppPage.tsx', 'pages/ProfilePage.tsx'];
  for (const f of PUBLIC) {
    const src = read(f);
    assert.match(src, /queryKey: PUBLIC_SITE_CONTENT_KEY/, `${f}: لا يستعمل مفتاح المحتوى العام`);
    assert.match(src, /fetchPublicSiteContent/, `${f}: لا يجلب المحتوى المصحَّح`);
    assert.doesNotMatch(src, /siteContentApi\.get\(/, `${f}: يقرأ CMS الخام`);
  }

  // المحرّران: الخام بمفتاحيهما، ولا يمسّان الطبقة العامة (الزرّ وحده يطبّق القائمة على المسوّدة بيد المالك)
  const EDITORS: [string, string][] = [['components/SiteContentEditor.tsx', 'site-content-edit'], ['components/ProfileEditorPanel.tsx', 'site-content']];
  for (const [f, key] of EDITORS) {
    const src = read(f);
    assert.match(src, new RegExp(`queryKey: \\['${key}'\\],\\s*queryFn: async \\(\\) => [^\\n]*siteContentApi\\.get\\(\\)`), `${f}: لا يقرأ CMS الخام`);
    assert.doesNotMatch(src, /publicSiteContent|publicCmsContent|PUBLIC_SITE_CONTENT_KEY|fetchPublicSiteContent/, `${f}: يستدعي الطبقة العامة`);
  }
  // في المحرّر لا يُستدعى applyCmsFixes إلا داخل دالة الزر applyFixes (لا عند التحميل في useEffect)
  const editor = read('components/SiteContentEditor.tsx').replace(/\r\n/g, '\n');
  const from = editor.indexOf('const applyFixes = () => {');
  const to = editor.indexOf('\n  };', from);
  const calls = [...editor.matchAll(/applyCmsFixes\(/g)].map((m) => m.index!);
  assert.ok(from > 0 && calls.length >= 1 && calls.every((at) => at > from && at < to), 'المحرّر يطبّق القائمة خارج زرّها');

  // كل قارئ آخر لـsiteContentApi.get() في الواجهة يمرّ بالطبقة: لا صفحة جديدة تقرأ الخام بصمت
  const readers: string[] = [];
  (function walk(dir: URL, rel: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /siteContentApi\.get\(/.test(readFileSync(new URL(e.name, dir), 'utf8'))) readers.push(`${rel}${e.name}`);
    }
  })(SRC, '');
  assert.deepEqual(readers.sort(), ['components/ProfileEditorPanel.tsx', 'components/SiteContentEditor.tsx', 'content/publicSiteContent.ts']);
});
