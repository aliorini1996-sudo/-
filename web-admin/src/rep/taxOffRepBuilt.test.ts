// «إزالة الضريبة» — إصلاحات المراجعة في تطبيق المندوب (CONTRACT2):
//  • E1: الحمولة تُعلن الوضع الذي سعّر به الجهاز (builtTaxFree = taxOff، true/false دائماً) — خارج مفتاح المحاولة (كـpricingDay)،
//    ومحفوظةٌ في الصندوق الأوف‑لاين فتُرفع كما بُنيت؛ وورقة الأوف‑لاين بالوضع نفسه.
//  • E2: 409 TAX_MODE_CHANGED بالاتجاهين — تُجلب الشركة ويُعاد تسعير السلّة بالوضع الجديد (إعادة الضريبة على غير المعدَّل حين تعود).
//  • E6: رسالة «تخليص حكومي» ومنع الإصدار أوف‑لاين (eta/peppol/ttn) لا تظهر لشركةٍ «بلا ضريبة».
// المقاطع تُستخرج من RepApp.tsx حرفاً وتُترجم وتُشغَّل على المساعدات الحقيقية (نمط taxOffRep.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { attemptClientRef } from './liveGate';
import { repBaseQtyByProduct } from './repPriceLists';
import { lineUnitOf, unitChoices } from './repUnits';
import { roundDecimal } from './invoiceCalc';
import { lineNetWithList } from '../lib/priceListPricing';
import { effectiveTaxPct, isTaxOff } from '../lib/taxMode';
import { isTaxModeChanged, repOfflineTaxFree, repRetaxLines } from './repTaxMode';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const repApp = read('rep', 'RepApp.tsx');
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  assert.ok(a >= 0, `غائب: ${from}`);
  const b = s.indexOf(to, a + from.length);
  assert.ok(b > a, `غائب بعده: ${to}`);
  return s.slice(a, b + to.length);
};
function compile<T>(src: string, name: string, deps: Record<string, unknown>): T {
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(deps), `${js}\nreturn ${name};`)(...Object.values(deps)) as T;
}
const OFF = { taxDisabled: true };
const ON = { taxDisabled: false };
type Line = Record<string, any>;

const submit = between(repApp, 'attempt.current = attemptClientRef(attempt.current, body, newClientRef);', "const res = await repApi.post('/invoices', payload);");
const BUILT = 'Object.assign(payload, { builtTaxFree: taxOff });';

// ═══ E1 ═══
/** من مفتاح المحاولة حتى إعلان الوضع — حرفاً */
const buildPayload = (() => {
  const seg = between(submit, 'attempt.current = attemptClientRef(attempt.current, body, newClientRef);', BUILT);
  return (taxOff: boolean, attempt: { current: { key: string; ref: string } | null }, body: Record<string, unknown>) => {
    let n = 0;
    return compile<() => { payload: Record<string, unknown>; clientRef: string }>(
      `function run() {\n${seg}\nreturn { payload, clientRef };\n}`, 'run',
      { attempt, attemptClientRef, body, newClientRef: () => `ref-${++n}`, clientCreatedAt: '2026-11-07T10:00:00.000Z', pricingDay: null,
        saleRef: null, repPricesSeenAt: () => null, listRows: null, listId: null, taxOff },
    )();
  };
})();

test('E1: الحمولة تُعلن builtTaxFree = taxOff (true/false) — وهو خارج مفتاح المحاولة فلا مستند ثانٍ بتغيّره وحده', () => {
  const body = { customerId: 'c1', type: 'CASH', items: [{ productId: 'p', qty: 1, unitPrice: 10, discountPct: 0, taxPct: 0 }] };
  const attempt: { current: { key: string; ref: string } | null } = { current: null };
  const off = buildPayload(true, attempt, body);
  assert.equal(off.payload.builtTaxFree, true);
  assert.equal(off.payload.clientRef, off.clientRef);
  assert.equal('builtTaxFree' in body, false, 'الجسم (مفتاح المحاولة) بلا المفتاح');
  assert.doesNotMatch(attempt.current!.key, /builtTaxFree/);
  // إعادة الضغط بالمحتوى نفسه بعد انقلاب الوضع: المرجع نفسه (idempotency)، والحمولة بالوضع الجديد
  const on = buildPayload(false, attempt, body);
  assert.equal(on.clientRef, off.clientRef);
  assert.equal(on.payload.builtTaxFree, false, 'مُعلَنٌ false صراحةً لا غائباً');
  assert.equal(typeof on.payload.builtTaxFree, 'boolean');
  // الإعلان بعد الحمولة كلّها، قبل الطلب الحيّ وقبل الصندوق الأوف‑لاين — فيُعاد معه كما بُني
  const at = repApp.indexOf(BUILT);
  assert.equal(repApp.split(BUILT).length, 2, 'مرّةً واحدة');
  assert.ok(at > repApp.indexOf('if (pricesSeenAt) Object.assign(payload, { pricesSeenAt });'));
  assert.ok(at < repApp.indexOf("const res = await repApi.post('/invoices', payload);"));
  assert.ok(at < repApp.indexOf("await outboxAdd({ clientRef, repId: currentRepId(), kind: 'invoice', payload, status: 'queued', clientCreatedAt, localNumber });"));
  // taxOff هنا هو نفسه الذي سعّر البنود (isTaxOff للشركة المعطاة للمكوّن)
  assert.match(repApp, /\n {2}const taxOff = isTaxOff\(company\);\n/);
});

test('E1: الصندوق الأوف‑لاين يحفظ builtTaxFree مع الحمولة (نسخةٌ مهيكلة كـIndexedDB) — والورقة بالوضع نفسه', () => {
  for (const [company, zero, paperFree] of [[OFF, true, true], [OFF, false, false], [ON, true, false], [null, true, false]] as const) {
    const taxOff = isTaxOff(company);
    const attempt: { current: { key: string; ref: string } | null } = { current: null };
    const items = [{ productId: 'p', qty: 2, unitPrice: 10, discountPct: 0, taxPct: zero ? 0 : 15 }];
    const { payload } = buildPayload(taxOff, attempt, { customerId: 'c1', type: 'CASH', items });
    const stored = structuredClone({ clientRef: payload.clientRef, kind: 'invoice', payload, status: 'queued' });
    assert.equal((stored.payload as Record<string, unknown>).builtTaxFree, taxOff, `${JSON.stringify(company)}`);
    // الورقة: «بلا ضريبة» إذا سعّر الجهاز بلا ضريبة وكل البنود صفر — ما يختمه الخادم عند الرفع بهذا الإعلان (E1) أيّاً كان وضع الشركة حينها
    assert.equal(repOfflineTaxFree(company, (stored.payload as { items: Line[] }).items), paperFree);
    if (paperFree) assert.equal((stored.payload as Record<string, unknown>).builtTaxFree, true, 'الورقة «بلا ضريبة» ⇒ الحمولة تُعلن ذلك');
  }
  // الصندوق يرفع الحمولة كما حُفظت (لا يُعاد بناؤها عند الرفع)
  assert.match(read('rep', 'offlineSync.ts'), /repApi\.post\(endpoint, doc\.payload, \{ headers: \{ 'X-FS-Replay': '1'/);
});

// ═══ E6 ═══
test('E6: لا منع ولا رسالة «تخليص حكومي» أوف‑لاين لشركةٍ «بلا ضريبة» — وبضريبتها كما كان حرفاً', () => {
  const seg = between(repApp, 'const provider = (company as any)?.einvoiceProvider;', "setLoading(false); return;\n        }");
  const gate = (company: Record<string, unknown>) => {
    const msgs: string[] = [];
    const run = compile<() => string>(`function run() {\n${seg}\nreturn 'queued';\n}`, 'run', {
      company, taxOff: isTaxOff(company), setMsg: (m: string) => { msgs.push(m); }, tr: (s: string) => s, setLoading: () => undefined,
    });
    return { out: run() ?? 'refused', msgs };
  };
  for (const provider of ['eta', 'peppol', 'ttn']) {
    const on = gate({ einvoiceProvider: provider });
    assert.equal(on.out, 'refused', `${provider}: بضريبتها يُمنع كما كان`);
    assert.deepEqual(on.msgs, ['لا يمكن إصدار فاتورة دون اتصال في هذا السوق يتطلب تخليصا حكوميا لحظيا']);
    const onFalse = gate({ einvoiceProvider: provider, taxDisabled: false });
    assert.equal(onFalse.out, 'refused');
    const off = gate({ einvoiceProvider: provider, taxDisabled: true });
    assert.deepEqual([off.out, off.msgs], ['queued', []], `${provider}: «بلا ضريبة» يُصفّ بلا رسالة تخليص`);
  }
  for (const company of [{ einvoiceProvider: 'none' }, { einvoiceProvider: 'zatca', taxDisabled: true }, {}]) assert.equal(gate(company).out, 'queued');
  // نصّ التخليص الوحيد في البيع والمرتجع، ومحروسٌ بالوضع
  assert.equal(repApp.split('تخليصا حكوميا').length, 2);
  assert.match(seg, /if \(!taxOff && \['eta', 'peppol', 'ttn'\]\.includes\(provider\)\) \{/);
});

// ═══ E2 ═══
const water = { id: 'p-w', name: 'ماء', unit: 'قارورة', basePrice: 10, taxPct: 15, units: [] as never[] };
const [BOTTLE] = unitChoices(water);
/** inclOf من CreateInvoice حرفاً بوضع الشركة المعطى */
const inclOfFor = (company: unknown) =>
  compile<(p: unknown, c: unknown, baseQty?: number) => number>(between(repApp, 'const inclOf = ', ';\n'), 'inclOf', {
    custPrices: {}, listPrices: {}, listRules: [], lineNetWithList, roundDecimal,
    priceDay: '2026-11-07', currencyDecimals: () => 2, getActiveCurrency: () => 'SAR', effectiveTaxPct, company,
  });
/** مؤثّر الانقلاب حرفاً: يجري حين يخالف وضعُ الشركة الجديد آخرَ وضعٍ رآه */
const effectFor = () => {
  const eff = between(repApp, 'const taxOffSeen = useRef(taxOff);', '}, [taxOff]);');
  const body = between(eff, 'if (taxOffSeen.current === taxOff) return;', '\n    });\n');
  return (seen: { current: boolean }, company: unknown, prev: Line[], perms: unknown) => {
    let next = prev;
    compile<() => void>(`function run() {\n${body}\n}`, 'run', {
      taxOffSeen: seen, taxOff: isTaxOff(company as never), company, products: [water], inclOf: inclOfFor(company), perms,
      repBaseQtyByProduct, repRetaxLines, setLines: (f: (p: Line[]) => Line[]) => { next = f(next); },
    })();
    return next;
  };
};

test('E2: 409 TAX_MODE_CHANGED بالاتجاهين — تُجلب الشركة دائماً برسالةٍ محايدة، ثم يُعاد التسعير بالوضع الجديد (والضريبة تعود على غير المعدَّل)', () => {
  // المعالج: بلا شرطٍ على الاتجاه — الجلب والرسالة والإيقاف، قبل رسالة الخادم العامة
  const fail = between(repApp, 'if (isZatcaOutdatedClient(err)) setNeedsUpdate(true);', 'const refreshUnits = async');
  const line = fail.split('\n').find((l) => l.includes('isTaxModeChanged(err)'))!;
  const handle = (err: unknown) => {
    const calls: string[] = [];
    const out = compile<() => string>(`function run() {\n${line.trim()}\nreturn 'fallthrough';\n}`, 'run', {
      isTaxModeChanged, err, onCompanyStale: () => calls.push('pull'), setMsg: (m: string) => calls.push(`msg:${m}`),
      tr: (s: string) => s, setLoading: (v: boolean) => calls.push(`loading:${v}`),
    })();
    return { out: out ?? 'handled', calls };
  };
  const neutral = 'تغيرت إعدادات الشركة راجع الأسعار ثم أعد الإصدار';
  for (const direction of ['أزيلت', 'أعيدت']) {
    const r = handle({ response: { status: 409, data: { code: 'TAX_MODE_CHANGED', message: direction } } });
    assert.deepEqual(r, { out: 'handled', calls: ['pull', `msg:${neutral}`, 'loading:false'] }, direction);
  }
  assert.equal(handle({ response: { status: 409, data: { code: 'OTHER' } } }).out, 'fallthrough');
  // الرسالة محايدة بكل لغة (تُعرض لشركةٍ «بلا ضريبة» كذلك)
  assert.ok(PHRASES[neutral], 'المفتاح في القاموس');
  for (const [lang, rx] of [['en', /tax|VAT/i], ['fr', /TVA|taxe/i], ['tr', /KDV|vergi/i], ['zh', /税/]] as const) {
    assert.doesNotMatch(String(PHRASES[neutral][lang] ?? ''), rx, lang);
  }
  assert.doesNotMatch(neutral, /ضريب/);

  // ثم الانقلاب بعد الجلب — الاتجاهان على سلّةٍ سُعّرت بالوضع القديم
  const run = effectFor();
  const perms = { canSellBelowPrice: false };
  // (أ) كاشٌ «بلا ضريبة» والشركة أعادتها: غير المعدَّل يعود شاملاً بنسبة صنفه، والمعدَّل يدوياً بسعره المكتوب فوق الأرضية
  const offCart: Line[] = [
    { productId: 'p-w', ...lineUnitOf(BOTTLE, water.unit), qty: 2, unitPrice: 10, refPrice: 10, taxPct: 0 },
    { productId: 'p-w', ...lineUnitOf(BOTTLE, water.unit), qty: 1, unitPrice: 12, refPrice: 10, taxPct: 0 },
  ];
  const seenOff = { current: true };
  const back = run(seenOff, ON, offCart, perms);
  assert.deepEqual(back.map((l) => [l.taxPct, l.unitPrice, l.refPrice]), [[15, 11.5, 11.5], [15, 12, 11.5]]);
  assert.equal(seenOff.current, false);
  // (ب) كاشٌ بضريبتها والشركة أزالتها: صفرٌ وصافٍ
  const seenOn = { current: false };
  const off = run(seenOn, OFF, back, perms);
  assert.deepEqual(off.map((l) => [l.taxPct, l.unitPrice]), [[0, 10], [0, 12]]);
  // لا انقلاب (جلبٌ بالوضع نفسه): السلّة نفسها
  assert.equal(run({ current: true }, OFF, off, perms), off);
  // وبعدها تُعلن الحمولة الوضع الجديد — فلا 409 ثانية
  assert.equal(buildPayload(isTaxOff(ON), { current: null }, { items: back }).payload.builtTaxFree, false);
});
