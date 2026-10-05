import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkText, norm, DATE_OR_NUMBER, PHASE2 } from '../../scripts/claims-rules.mjs';
import { defaultContent } from '../landing/defaultContent';
import { CMS_FIXES, applyCmsFixes, planCmsFixes, pricesIn, planPrices, type CmsFix } from './cmsFixes';

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
