// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — إصلاحات المراجعة، المجموعة الثالثة (قرار E6 في CONTRACT2):
//   • محرّر قوائم الأسعار بلا «قبل الضريبة» (PriceRuleForm وPriceListItemsTab) لشركةٍ بلا ضريبة.
//   • «المدفوعات الالكترونية»: وصف العمولة بلا «شاملة الضريبة».
//   • «ربط ERP» (Odoo): لا تحذير «هيئة الزكاة».
//   • مفتاح الإعدادات: أسباب ردّ 409 reasons[] بعبارةٍ لكل سبب (TENANT_FLAG / LIVE / ARMED / REHEARSAL) وتعطيله ما دام ممنوعاً.
//   • لوحة المالك: رفض TAX_OFF_BLOCKS_ZATCA بعبارته مترجمة.
// القاعدة: شركةٌ بلا ضريبة ⇒ لا ذكر للضريبة؛ والغائب أو false ⇒ الشاشة كما كانت حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TAX_MODE_HINT, TAX_MODE_MESSAGES } from '../lib/taxMode';
import {
  TAX_MODE_BLOCKED_TEXT, TAX_MODE_REASON_TEXT, TAX_MODE_ZATCA_REASONS, taxModeBlockLines, taxModeBlockedByZatca, taxModeConflictReasons,
  taxModeErrorMessage, taxModeRefusalLines, taxModeStickyReasons,
} from './taxOffScreens1';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

/** كل ما يُعدّ ذكراً للضريبة في نصٍّ ظاهر (عقد الميزة: «ما يختفي») */
const TAX_WORDS = /ضريب|الضرائب|ض\.ق\.م|\bVAT\b|هيئة الزكاة|الزكاة والضريبة|ZATCA|الفوترة الإلكترونية|إشعار دائن|إشعار مدين|مبسطة|رمز QR/;
const assertNoTax = (text: string, where: string) => {
  const m = TAX_WORDS.exec(text);
  assert.equal(m, null, `${where}: ذكرٌ للضريبة «${m?.[0]}» في: …${m ? text.slice(Math.max(0, m.index - 80), m.index + 80) : ''}…`);
};
const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*?(?:title|aria-label|placeholder|alt)="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, ' ');

/** بيئة متصفّحٍ دنيا لما يستورد مخزن الجلسة وعميل الـAPI — كما في taxOffScreens1.test.ts (لا طلب يخرج: الذاكرة مملوءة) */
let envReady = false;
function browserEnv(): void {
  if (envReady) return;
  envReady = true;
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    } as Storage;
  }
  g.localStorage!.setItem('user', JSON.stringify({ id: 'u1', role: 'ADMIN', scopeEnabled: false }));
  const hook = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (url.includes('/web-admin/src/') && r.source != null) {
      let src = String(r.source);
      if (src.includes('import.meta.env')) src = src.replace(/import\\.meta\\.env/g, '({})');
      if (url.endsWith('/src/store/authStore.ts')) src = src.replace(/window\\.location\\.pathname/g, '"/app"');
      return { ...r, source: src };
    }
    return r;
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

/** يرسم مكوّناً بذاكرة استعلاماتٍ مملوءة (لا جلب: enabled=false) */
function renderWith(el: ReactElement, cache: [unknown[], unknown][]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  for (const [k, v] of cache) qc.setQueryData(k, v);
  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, el)));
}

// ═══ مفتاح الإعدادات: أسباب الرفض ═══

const conflict = (reasons: unknown) => ({ response: { status: 409, data: { success: false, code: 'TAX_MODE_ZATCA_CONFLICT', message: TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT, reasons } } });

test('أسباب المنع هي أسباب الخادم بترتيبها (compliance/zatca/settingsGuards.ts)، ولكل سببٍ عبارةٌ خاصة لا تتكرّر', () => {
  const be = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'compliance', 'zatca', 'settingsGuards.ts'), 'utf8');
  const m = /export const TAX_MODE_ZATCA_REASONS = Object\.freeze\(\[([^\]]*)\] as const\);/.exec(be);
  assert.ok(m, 'قائمة أسباب الخادم لم تُوجد');
  assert.deepEqual(m![1].split(',').map((s) => s.trim().replace(/'/g, '')), [...TAX_MODE_ZATCA_REASONS]);
  assert.deepEqual([...TAX_MODE_ZATCA_REASONS], ['TENANT_FLAG', 'LIVE', 'ARMED', 'REHEARSAL']);
  const texts = TAX_MODE_ZATCA_REASONS.map((r) => TAX_MODE_REASON_TEXT[r]);
  assert.equal(new Set(texts).size, 4, 'عبارتان متطابقتان');
  for (const t of texts) {
    assert.ok(t.startsWith('لا يمكن إزالة الضريبة لأن '), t);
    assert.notEqual(t, TAX_MODE_BLOCKED_TEXT);
    assert.doesNotMatch(t, /[ً-ْ]/, 'بلا تشكيل (مفتاح ترجمة)');
  }
  assert.match(TAX_MODE_REASON_TEXT.TENANT_FLAG, /إدارة المنصة/);
  assert.match(TAX_MODE_REASON_TEXT.LIVE, /لا يلغى/);
  assert.match(TAX_MODE_REASON_TEXT.ARMED, /انزع التسليح/);
  assert.match(TAX_MODE_REASON_TEXT.REHEARSAL, /تجربة/);
});

test('taxModeConflictReasons: أسباب 409 TAX_MODE_ZATCA_CONFLICT المعروفة بترتيبها الثابت، و[] بلا سببٍ معروف، وnull لغيره', () => {
  assert.deepEqual(taxModeConflictReasons(conflict(['REHEARSAL'])), ['REHEARSAL']);
  assert.deepEqual(taxModeConflictReasons(conflict(['REHEARSAL', 'ARMED', 'TENANT_FLAG'])), ['TENANT_FLAG', 'ARMED', 'REHEARSAL']);
  assert.deepEqual(taxModeConflictReasons(conflict(['LIVE', 'LIVE', 'FUTURE'])), ['LIVE']);
  assert.deepEqual(taxModeConflictReasons(conflict([])), []);
  assert.deepEqual(taxModeConflictReasons(conflict(undefined)), []);
  assert.deepEqual(taxModeConflictReasons(conflict('REHEARSAL')), [], 'ليست مصفوفة');
  assert.deepEqual(taxModeConflictReasons(conflict(['FUTURE'])), []);
  for (const other of [
    { response: { status: 409, data: { code: 'TAX_OFF_BLOCKS_ZATCA', reasons: ['LIVE'] } } },
    { response: { status: 403, data: { code: 'TAX_MODE_ADMIN_ONLY' } } },
    new Error('net'), null, undefined,
  ]) assert.equal(taxModeConflictReasons(other), null);
});

test('رسالة الرفض: سطرٌ بعبارة كل سبب، وبلا سببٍ معروف عبارة الرمز كما كانت، وnull لغير رموز الوضع (فرسالة الخادم أو العامة)', () => {
  assert.deepEqual(taxModeRefusalLines(conflict(['REHEARSAL'])), [TAX_MODE_REASON_TEXT.REHEARSAL]);
  assert.deepEqual(taxModeRefusalLines(conflict(['ARMED', 'TENANT_FLAG'])), [TAX_MODE_REASON_TEXT.TENANT_FLAG, TAX_MODE_REASON_TEXT.ARMED]);
  assert.deepEqual(taxModeRefusalLines(conflict(['LIVE'])), [TAX_MODE_REASON_TEXT.LIVE]);
  assert.deepEqual(taxModeRefusalLines(conflict([])), [TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT]);
  assert.deepEqual(taxModeRefusalLines({ response: { data: { code: 'TAX_OFF_BLOCKS_ZATCA' } } }), [TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA]);
  assert.equal(taxModeRefusalLines({ response: { data: { code: 'TAX_MODE_SCOPED', message: 'x' } } }), null);
  assert.equal(taxModeRefusalLines(new Error('net')), null);
});

test('المفتاح معطّلٌ بعبارة كل سبب: العلم والتفعيل والتسليح من ردّ /company طازجاً، والبروفة (أو رفضٌ بلا سبب) من ردّ الرفض', () => {
  // لا منع
  assert.deepEqual(taxModeBlockLines(null, null), []);
  assert.deepEqual(taxModeBlockLines({}, null), []);
  assert.deepEqual(taxModeBlockLines({ zatcaPhase2Enabled: false, zatcaPhase2StartedAt: '', zatcaGoLiveArmedAt: null }, null), []);
  // من ردّ /company — كل سببٍ بعبارته وبالترتيب الثابت
  assert.deepEqual(taxModeBlockLines({ zatcaPhase2Enabled: true }, null), [TAX_MODE_REASON_TEXT.TENANT_FLAG]);
  assert.deepEqual(taxModeBlockLines({ zatcaPhase2StartedAt: '2026-10-02T00:00:00Z' }, null), [TAX_MODE_REASON_TEXT.LIVE]);
  assert.deepEqual(taxModeBlockLines({ zatcaGoLiveArmedAt: new Date('2026-10-02') }, null), [TAX_MODE_REASON_TEXT.ARMED]);
  assert.deepEqual(taxModeBlockLines({ zatcaGoLiveArmedAt: 'x', zatcaPhase2Enabled: true }, null), [TAX_MODE_REASON_TEXT.TENANT_FLAG, TAX_MODE_REASON_TEXT.ARMED]);
  // البروفة لا تصل في /company: تُحفظ من الرفض فيتعطّل المفتاح (لا حلقة تأكيدٍ ثم رفض)
  assert.deepEqual(taxModeBlockLines({}, ['REHEARSAL']), [TAX_MODE_REASON_TEXT.REHEARSAL]);
  assert.deepEqual(taxModeBlockLines({ zatcaPhase2Enabled: true }, ['REHEARSAL']), [TAX_MODE_REASON_TEXT.TENANT_FLAG, TAX_MODE_REASON_TEXT.REHEARSAL]);
  // رفضٌ بلا سببٍ معروف ⇒ العبارة العامة، وسببٌ معروفٌ يغلبها
  assert.deepEqual(taxModeBlockLines({}, []), [TAX_MODE_BLOCKED_TEXT]);
  assert.deepEqual(taxModeBlockLines({ zatcaPhase2StartedAt: 'x' }, []), [TAX_MODE_REASON_TEXT.LIVE]);
  // إعادة الضريبة حرّة دائماً
  assert.deepEqual(taxModeBlockLines({ taxDisabled: true, zatcaPhase2Enabled: true }, ['REHEARSAL']), []);
  assert.deepEqual(taxModeBlockLines({ taxDisabled: true }, []), []);
  // متّسقٌ مع الحكم القديم حين لا رفض محفوظ
  for (const c of [{}, { zatcaPhase2Enabled: true }, { zatcaPhase2StartedAt: 'x' }, { zatcaGoLiveArmedAt: 'x' }, { taxDisabled: true, zatcaGoLiveArmedAt: 'x' }]) {
    assert.equal(taxModeBlockLines(c, null).length > 0, taxModeBlockedByZatca(c), JSON.stringify(c));
  }
});

test('ما يُحفظ من الرفض: البروفة وحدها (غيرها يُقرأ من /company بعد إعادة قراءته فينفكّ بنزع التسليح)، و[] لرفضٍ بلا سبب', () => {
  assert.equal(taxModeStickyReasons(null), null);
  assert.deepEqual(taxModeStickyReasons([]), []);
  assert.deepEqual(taxModeStickyReasons(['REHEARSAL']), ['REHEARSAL']);
  assert.deepEqual(taxModeStickyReasons(['ARMED', 'REHEARSAL']), ['REHEARSAL']);
  assert.equal(taxModeStickyReasons(['ARMED']), null);
  assert.equal(taxModeStickyReasons(['TENANT_FLAG', 'LIVE']), null);
  // السيناريو كاملاً: شركةٌ في البروفة وحدها ⇒ المفتاح متاح، فرفضٌ بالبروفة ⇒ معطّلٌ بعبارتها
  const company = { zatcaPhase2Enabled: false, zatcaPhase2StartedAt: null, zatcaGoLiveArmedAt: null };
  assert.deepEqual(taxModeBlockLines(company, null), []);
  assert.deepEqual(taxModeBlockLines(company, taxModeStickyReasons(taxModeConflictReasons(conflict(['REHEARSAL'])))), [TAX_MODE_REASON_TEXT.REHEARSAL]);
  // رفضٌ بالتسليح ثم نزعه: لا شيء محفوظ ⇒ المفتاح يعود متاحاً بإعادة قراءة /company
  assert.deepEqual(taxModeBlockLines(company, taxModeStickyReasons(taxModeConflictReasons(conflict(['ARMED'])))), []);
});

test('بطاقة المفتاح (المصدر): تحفظ أسباب الرفض وتعطّل المفتاح بعبارة كل سبب، وتعرض رسالة الرفض بأسبابه', () => {
  const s = read('pages', 'CompanySettingsPage.tsx');
  const card = s.slice(s.indexOf('function TaxModeCard('), s.indexOf('\n/**', s.indexOf('function TaxModeCard(')));
  assert.ok(card.includes('const [stickyReasons, setStickyReasons] = useState<TaxModeZatcaReason[] | null>(null);'));
  assert.ok(card.includes('const sticky = taxModeStickyReasons(taxModeConflictReasons(err));\n      if (sticky) setStickyReasons(sticky);'));
  assert.ok(card.includes('const known = taxModeRefusalLines(err);'));
  assert.ok(card.includes("toast.error(known ? known.map((l) => tr(l)).join('\\n') : tr(typeof server === 'string' && server ? server : 'حدث خطأ في الحفظ'),"));
  assert.ok(card.includes('const blockLines = taxModeBlockLines(company, stickyReasons);\n  const blocked = blockLines.length > 0;'));
  assert.ok(card.includes('disabled={save.isPending || blocked}'));
  assert.ok(card.includes('{blockLines.map((l) => <p key={l}>{tr(l)}</p>)}'));
  // إعادة قراءة الشركة بعد رفض الوضع باقية
  assert.ok(card.includes("if (taxModeErrorCode(err)) qc.invalidateQueries({ queryKey: ['company'] });"));
  assert.ok(!card.includes('TAX_MODE_BLOCKED_TEXT') && !card.includes('taxModeBlockedByZatca('), 'الحكم القديم بلا أسباب');
});

/** صفحة الإعدادات مرسومةً بشركةٍ في الذاكرة ومديرٍ غير مقيَّد */
async function renderSettings(company: Record<string, unknown>): Promise<string> {
  browserEnv();
  const { default: CompanySettingsPage } = await import('./CompanySettingsPage');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['company'], company);
  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(CompanySettingsPage))));
}
const SA = { name: 'شركة', address: 'الرياض', taxNumber: '300000000000003', countryCode: 'SA', currency: 'SAR', accountingEnabled: true, zatcaPhase2Enabled: false };
const cardOf = (html: string) => {
  const at = html.indexOf('<div class="card" data-tax-mode="">');
  assert.ok(at >= 0, 'بطاقة المفتاح غائبة');
  return html.slice(at, html.indexOf('<div class="card"', at + 10) > 0 ? html.indexOf('<div class="card"', at + 10) : undefined);
};

test('إعدادات الشركة مرسومةً: المفتاح معطّلٌ بعبارة كل سببٍ ظاهر، ومتاحٌ بلا عبارة منعٍ لشركةٍ بلا ربط أو أزالت ضريبتها', async () => {
  const cases: [Record<string, unknown>, string[]][] = [
    [{ zatcaPhase2Enabled: true }, [TAX_MODE_REASON_TEXT.TENANT_FLAG]],
    [{ zatcaPhase2Enabled: true, zatcaGoLiveArmedAt: '2026-11-01T00:00:00Z' }, [TAX_MODE_REASON_TEXT.TENANT_FLAG, TAX_MODE_REASON_TEXT.ARMED]],
    [{ zatcaPhase2Enabled: true, zatcaPhase2StartedAt: '2026-10-02T00:00:00Z' }, [TAX_MODE_REASON_TEXT.TENANT_FLAG, TAX_MODE_REASON_TEXT.LIVE]],
  ];
  for (const [extra, lines] of cases) {
    const card = cardOf(await renderSettings({ ...SA, ...extra }));
    assert.match(card.slice(0, card.indexOf('</label>')), /disabled=""/, JSON.stringify(extra));
    assert.ok(card.includes('data-tax-mode-blocked=""'));
    let from = 0;
    for (const l of lines) {
      const at = card.indexOf(`<p>${l}</p>`, from);
      assert.ok(at > from, `غابت عبارة السبب أو جاءت بغير ترتيبها: ${l}`);
      from = at;
    }
    for (const r of TAX_MODE_ZATCA_REASONS) if (!lines.includes(TAX_MODE_REASON_TEXT[r])) assert.ok(!card.includes(TAX_MODE_REASON_TEXT[r]), r);
    assert.ok(!card.includes(TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT), 'العبارة العامة مع أسبابٍ معروفة');
  }
  for (const company of [{ ...SA }, { ...SA, taxDisabled: true, zatcaPhase2Enabled: true }]) {
    const card = cardOf(await renderSettings(company));
    assert.doesNotMatch(card.slice(0, card.indexOf('</label>')), /disabled=""/);
    assert.ok(!card.includes('data-tax-mode-blocked'));
    assert.ok(card.includes(TAX_MODE_HINT));
  }
});

// ═══ لوحة المالك: رفض تفعيل الربط لشركةٍ أزالت ضريبتها ═══

test('لوحة المالك: 409 TAX_OFF_BLOCKS_ZATCA بعبارته مترجمةً (tr)، وغيره من الأخطاء كما كان حرفاً', () => {
  assert.equal(taxModeErrorMessage({ response: { status: 409, data: { code: 'TAX_OFF_BLOCKS_ZATCA', message: 'نص الخادم' } } }), TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA);
  assert.equal(taxModeErrorMessage({ response: { status: 400, data: { message: 'خطأ آخر' } } }), null);
  const s = read('pages', 'PlatformPage.tsx');
  assert.ok(s.includes("import { taxModeErrorMessage } from './taxOffScreens1';"));
  assert.ok(s.includes(`    onError: (err: unknown) => {
      const taxMode = taxModeErrorMessage(err);
      toast.error(taxMode ? tr(taxMode) : (err as { response?: { data?: { message?: string } } })?.response?.data?.message || tr('تعذر التحديث'));
    },`));
  assert.equal(s.split('taxModeErrorMessage(').length - 1, 1);
});

// ═══ المدفوعات الالكترونية ═══

const PAYLINK_SUMMARY = { collected: 100, fees: 5, refunds: 0, payouts: 0, paymentsCount: 2, balance: 95, lastPayout: null, feePct: 4, feeFlat: 1 };
async function renderPaylink(company: Record<string, unknown>): Promise<string> {
  browserEnv();
  const { default: PaylinkPage } = await import('./PaylinkPage');
  return renderWith(h(PaylinkPage), [
    [['company'], company],
    [['paylink-summary'], PAYLINK_SUMMARY],
    [['paylink-links', '', 1], { data: [], meta: { total: 0, limit: 25 } }],
  ]);
}

test('المدفوعات الالكترونية بلا ضريبة: «4% + 1 ريال لكل دفعة» بلا «شاملة الضريبة» ولا ذكر للضريبة — وبضريبتها كما كانت', async () => {
  const off = await renderPaylink({ accountingEnabled: true, taxDisabled: true });
  assert.ok(off.includes('4% + 1 ريال لكل دفعة<'), 'وصف العمولة غائب');
  assert.ok(!off.includes('شاملة الضريبة'));
  assertNoTax(visible(off), 'المدفوعات الالكترونية');
  for (const company of [{ accountingEnabled: true }, { accountingEnabled: true, taxDisabled: false }, { accountingEnabled: true, taxDisabled: null }]) {
    const on = await renderPaylink(company);
    assert.ok(on.includes('4% + 1 ريال لكل دفعة شاملة الضريبة<'), JSON.stringify(company));
  }
  const s = read('pages', 'PaylinkPage.tsx');
  assert.ok(s.includes("${taxOff ? tr('ريال لكل دفعة') : tr('ريال لكل دفعة شاملة الضريبة')}"));
  // ذاكرة ['company'] نفسها التي تقرؤها بوّابة المحاسبة — لا طلبٌ زائد
  assert.ok(s.includes("queryKey: ['company'],\n    queryFn: async () => (await companyApi.get()).data.data as { taxDisabled?: boolean } | null,\n    staleTime: 300_000,"));
});

// ═══ ربط ERP (Odoo) ═══

test('ربط ERP: تحذير «هيئة الزكاة» خلف !taxOff وعبارة المسودات والسندات باقية — من ذاكرة [company] نفسها', () => {
  const s = read('pages', 'ErpIntegrationPage.tsx');
  assert.ok(s.includes('const taxOff = isTaxOff(companyCfg);'));
  assert.ok(s.includes("queryKey: ['company'],\n    queryFn: async () => (await companyApi.get()).data.data as { taxDisabled?: boolean } | null,\n    staleTime: 300_000,"));
  const box = s.slice(s.indexOf("{tr('الفواتير تصل إلى Odoo مسودات"), s.indexOf('</div>', s.indexOf("{tr('الفواتير تصل إلى Odoo مسودات")));
  assert.ok(box.includes("{!taxOff && <p>{tr('إن كانت فواتيرك تُبلَّغ لهيئة الزكاة من Field Sales"), 'التحذير بلا شرط');
  assert.equal(s.split('هيئة الزكاة').length - 1, 2, 'ذكرٌ آخر للهيئة خارج الشرط (التعليق والتحذير وحدهما)');
  // لا ذكر آخر للضريبة في نصوص الصفحة الظاهرة (tr)
  const shown = [...s.matchAll(/tr\('([^']*)'\)/g)].map((m) => m[1]).filter((t) => !t.startsWith('إن كانت فواتيرك تُبلَّغ لهيئة الزكاة'));
  assertNoTax(shown.join(' | '), 'ربط ERP');
});

// ═══ محرّر قوائم الأسعار ═══

const FIXED_RULE = {
  id: 'r1', priceListId: 'L1', scope: 'category', productId: null, categoryId: 'c1', kind: 'fixed', basePrice: null, primaryPrice: 10, percent: null,
  minQty: 0, startsOn: null, endsOn: null,
};

async function renderRuleForm(company: Record<string, unknown> | null): Promise<string> {
  browserEnv();
  const { default: PriceRuleForm } = await import('../components/priceLists/PriceRuleForm');
  const noop = () => {};
  return renderWith(
    h(PriceRuleForm, { listId: 'L1', rule: FIXED_RULE as never, categories: [{ id: 'c1', name: 'مشروبات' }], onSaved: noop, onCancel: noop, onStale: noop, onDirtyChange: noop } as never),
    [[['company'], company]],
  );
}

test('قاعدة «سعر ثابت» بلا ضريبة: الخانة «السعر» بلا «قبل الضريبة» ولا ذكر للضريبة — وبضريبتها «السعر قبل الضريبة» كما كانت', async () => {
  const off = await renderRuleForm({ taxDisabled: true });
  assert.ok(off.includes('السعر'), 'الخانة غائبة');
  assert.ok(!off.includes('قبل الضريبة'));
  assertNoTax(visible(off), 'نموذج القاعدة');
  for (const company of [{}, { taxDisabled: false }, null]) {
    const on = await renderRuleForm(company);
    assert.ok(on.includes('السعر قبل الضريبة'), JSON.stringify(company));
  }
  const s = read('components', 'priceLists', 'PriceRuleForm.tsx');
  assert.ok(s.includes("const valueLabel = draft.kind === 'fixed' ? (taxOff ? tr('السعر') : tr('السعر قبل الضريبة'))"));
  assert.ok(s.includes('const taxOff = isTaxOff(companyCfg);'));
});

async function renderItemsTab(company: Record<string, unknown> | null): Promise<string> {
  browserEnv();
  const { default: PriceListItemsTab } = await import('../components/priceLists/PriceListItemsTab');
  return renderWith(h(PriceListItemsTab, { listId: 'L1', itemsCount: 3 }), [
    [['company'], company],
    [['product-categories'], []],
  ]);
}

test('«أسعار الأصناف» بلا ضريبة: التلميح «السعر بالوحدة الرئيسية…» بلا «صاف قبل الضريبة» — وبضريبتها كما كان حرفاً', async () => {
  const off = await renderItemsTab({ taxDisabled: true });
  assert.ok(off.includes('السعر بالوحدة الرئيسية، ويحفظ كل سطر عند Enter أو الخروج منه، والفارغ يحذف الصنف من القائمة'));
  assertNoTax(visible(off), 'أسعار الأصناف');
  for (const company of [{}, { taxDisabled: false }, null]) {
    const on = await renderItemsTab(company);
    assert.ok(on.includes('السعر صاف قبل الضريبة بالوحدة الرئيسية، ويحفظ كل سطر عند Enter أو الخروج منه، والفارغ يحذف الصنف من القائمة'), JSON.stringify(company));
  }
  // لا ذكر آخر للضريبة في نصوص المكوّنين الظاهرة إلا الفرعين المشروطين
  for (const f of ['PriceListItemsTab.tsx', 'PriceRuleForm.tsx']) {
    const s = read('components', 'priceLists', f);
    const shown = [...s.matchAll(/tr\('([^']*)'\)/g)].map((m) => m[1])
      .filter((t) => t !== 'السعر قبل الضريبة' && t !== 'السعر صاف قبل الضريبة بالوحدة الرئيسية، ويحفظ كل سطر عند Enter أو الخروج منه، والفارغ يحذف الصنف من القائمة');
    assertNoTax(shown.join(' | '), f);
  }
});
