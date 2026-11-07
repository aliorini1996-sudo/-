// «إزالة الضريبة» (طلب المالك ٧ نوفمبر ٢٠٢٦) — شاشات الإدارة، المجموعة الأولى: إعدادات الشركة (المفتاح، والرقم الضريبي، والفوترة
// الإلكترونية، ومعاينة الترويسة، وتبويب الربط)، والأصناف ونافذتها، والعملاء ونافذتهم وتصديرهم، وشاشات الطباعة (نصوص المطبوعات،
// وإعدادات الطباعة ومعايناتها وأدواتها والمصمّم).
// القاعدة: شركةٌ بلا ضريبة (CompanySettings.taxDisabled === true) ⇒ لا ذكر للضريبة في أي سطرٍ ظاهر إلا مفتاح الإعدادات نفسه وتلميحه؛
// والغائب أو false = الشاشة كما كانت حرفاً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TAX_FREE_TITLES, TAX_MODE_CONFIRM_OFF, TAX_MODE_HINT, TAX_MODE_LABEL, TAX_MODE_MESSAGES } from '../lib/taxMode';
import {
  CUSTOMER_EXPORT_TAX_COL, TAX_MODE_BLOCKED_TEXT, customerExportColWidths, taxModeBlockedByZatca, taxModeChecked, taxModeErrorCode,
  taxModeErrorMessage,
} from './taxOffScreens1';
import {
  TAX_OFF_DEVICE_SAMPLE_NOTE, TAX_OFF_SAMPLE_WATERMARK, TAX_OFF_TEMPLATE_HINTS, TaxOffPrintContext, editorWarningFor, printTextDefault,
  printTextRowVisible, taxFreeInvoiceDoc, taxFreeReceiptDoc, taxOffProfileWarnings, templateHintFor,
} from '../components/print/taxOffPrint';
import {
  PRINT_NOTES, PRINT_SAMPLE_WATERMARK, PRINT_WARNINGS, QR_REMOVE_WARNING, STAMPS_REMOVE_WARNING, ITEMS_REMOVE_WARNING, TEMPLATE_HINTS,
  newProfile, profileWarnings, withDesign, type PrintProfile, type TemplateId,
} from '../lib/print/printSettings';
import { PRINT_TEXT_CATALOG, TAX_PHRASE_KEYS } from '../lib/print/printTexts';
import { withQrRemoved, withSectionStyle, withStampsRemoved } from '../lib/print/designModel';
import { zatcaTabVisible } from '../components/zatca/zatcaAccess';
import { GO_LIVE_ERROR_LABEL } from '../components/zatca/goLiveLogic';
import { PaperPreview, previewInvoiceDoc, previewReceiptDoc } from '../components/print/PrintPreview';
import PrintDesignTools from '../components/print/PrintDesignTools';
import { QrRemoveField, SectionStyleFields, StampsField } from '../components/print/designer/SectionStyleFields';
import type { InvoiceDoc } from '../rep/RepDocuments';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

/** كل ما يُعدّ ذكراً للضريبة في نصٍّ ظاهر (عقد الميزة: «ما يختفي») — الكلمة بصيغها، ض.ق.م، VAT، الهيئة، عناوين الفاتورة الضريبية، الرمز */
const TAX_WORDS = /ضريب|الضرائب|ض\.ق\.م|\bVAT\b|هيئة الزكاة|الزكاة والضريبة|ZATCA|الفوترة الإلكترونية|إشعار دائن|إشعار مدين|مبسطة|رمز QR|data-qr-value|300000000000003|310000000000003/;
const assertNoTax = (text: string, where: string) => {
  const m = TAX_WORDS.exec(text);
  assert.equal(m, null, `${where}: ذكرٌ للضريبة «${m?.[0]}» في: …${m ? text.slice(Math.max(0, m.index - 80), m.index + 80) : ''}…`);
};
/** نصّ HTML الظاهر وسماته (title/aria-label/placeholder) — بلا الوسوم */
const visible = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*?(?:title|aria-label|placeholder|alt)="([^"]*)"[^>]*>/g, ' $1 ').replace(/<[^>]+>/g, ' ');
const inTaxOff = (el: ReactElement) => h(TaxOffPrintContext.Provider, { value: true }, el);

/**
 * بيئة متصفّحٍ دنيا لما يستورد مخزن الجلسة وعميل الـAPI (الإعدادات ونافذة العميل): مخزن الجلسة (zustand) يقرأ localStorage عند الاستيراد،
 * و`import.meta.env` بناءُ Vite لا وجود له في node — خطّافُ تحميلٍ يجعله كائناً فارغاً لملفات src وحدها (لا طلب يخرج: الذاكرة مملوءة)
 */
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
  // مدير شركة غير مقيَّد في مساحة اللوحة — المخزن يقرؤه عند الاستيراد (الرسم على الخادم يقرأ الحالة الأولى لا setState)
  g.localStorage!.setItem('user', JSON.stringify({ id: 'u1', role: 'ADMIN', scopeEnabled: false }));
  const hook = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (url.includes('/web-admin/src/') && r.source != null) {
      let src = String(r.source);
      if (src.includes('import.meta.env')) src = src.replace(/import\.meta\.env/g, '({})');
      if (url.endsWith('/src/store/authStore.ts')) src = src.replace(/window\.location\.pathname/g, '"/app"');
      return { ...r, source: src };
    }
    return r;
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

// ═══ مفتاح «إزالة الضريبة» في إعدادات الشركة ═══

test('رفض القلب: رموز الوضع بعبارتها (409 TAX_MODE_ZATCA_CONFLICT)، وغيرها null فتُعرض رسالة الخادم أو العامة', () => {
  const err = (data: unknown) => ({ response: { status: 409, data } });
  assert.equal(taxModeErrorCode(err({ code: 'TAX_MODE_ZATCA_CONFLICT', reasons: ['LIVE'] })), 'TAX_MODE_ZATCA_CONFLICT');
  assert.equal(taxModeErrorMessage(err({ code: 'TAX_MODE_ZATCA_CONFLICT' })), TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT);
  assert.equal(taxModeErrorMessage(err({ code: 'TAX_OFF_BLOCKS_ZATCA' })), TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA);
  for (const other of [err({ code: 'TAX_MODE_ADMIN_ONLY', message: 'x' }), err({ code: 'toString' }), err(null), new Error('net'), null, undefined]) {
    assert.equal(taxModeErrorCode(other), null);
    assert.equal(taxModeErrorMessage(other), null);
  }
  assert.equal(TAX_MODE_BLOCKED_TEXT, TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT);
});

test('المفتاح معطّل للإزالة ما دام ربط المرحلة الثانية مفعّلاً (العلم أو التفعيل أو التسليح) — والإعادة مسموحة دائماً', () => {
  assert.equal(taxModeBlockedByZatca(null), false);
  assert.equal(taxModeBlockedByZatca({}), false);
  assert.equal(taxModeBlockedByZatca({ zatcaPhase2Enabled: false, zatcaPhase2StartedAt: null }), false);
  assert.equal(taxModeBlockedByZatca({ zatcaPhase2Enabled: true }), true);
  assert.equal(taxModeBlockedByZatca({ zatcaPhase2StartedAt: '2026-10-02T00:00:00Z' }), true);
  assert.equal(taxModeBlockedByZatca({ zatcaGoLiveArmedAt: '2026-10-02T00:00:00Z' }), true);
  assert.equal(taxModeBlockedByZatca({ zatcaPhase2StartedAt: '' }), false);
  assert.equal(taxModeBlockedByZatca({ taxDisabled: true, zatcaPhase2Enabled: true }), false, 'إعادة الضريبة لا تُمنع');
  // القيمة المعروضة: المطلوب أثناء الحفظ، وإلا علم الشركة (=== true وحده)
  assert.equal(taxModeChecked(true, true, { taxDisabled: false }), true);
  assert.equal(taxModeChecked(true, false, { taxDisabled: true }), false);
  assert.equal(taxModeChecked(false, true, { taxDisabled: false }), false);
  assert.equal(taxModeChecked(false, undefined, { taxDisabled: true }), true);
  assert.equal(taxModeChecked(false, undefined, null), false);
});

test('إعدادات الشركة (المصدر): بطاقة المفتاح لمدير الشركة غير المقيَّد، بمسارها المستقل وتأكيد الإزالة وحدها، وتُبطل [company] — وما يُخفى خلف taxOff', () => {
  const s = read('pages', 'CompanySettingsPage.tsx');
  assert.ok(s.includes("const taxOff = isTaxOff(data);"));
  assert.ok(s.includes("const taxModeCardOn = role === 'ADMIN' && !scopeEnabled;"));
  assert.equal((s.match(/<TaxModeCard\b/g) ?? []).length, 1);
  assert.ok(s.includes('{taxModeCardOn && <TaxModeCard company={data} />}'));
  // داخل نموذج الإعدادات العامة بعد بطاقة المرتجع — لا خلف تبويبٍ ولا خلف المحاسبة
  const at = s.indexOf('<TaxModeCard company={data} />');
  assert.ok(at > s.indexOf('{returnPolicyCardOn && <ReturnPolicyCard') && at < s.indexOf('</form>'));
  const card = s.slice(s.indexOf('function TaxModeCard('), s.indexOf('\n/**', s.indexOf('function TaxModeCard(')));
  assert.ok(card.length > 800, 'البطاقة لم تُقتطع');
  assert.ok(card.includes('mutationFn: (taxDisabled: boolean) => companyApi.taxMode.set(taxDisabled),'));
  assert.ok(card.includes('if (off && !window.confirm(tr(TAX_MODE_CONFIRM_OFF))) return;'), 'تأكيد الإزالة');
  assert.equal(card.split('window.confirm(').length - 1, 1, 'الإعادة بلا تأكيد');
  assert.ok(card.includes("qc.invalidateQueries({ queryKey: ['company'] });"), 'لا تحديث لبقية الشاشات بعد القلب');
  assert.ok(card.includes('{tr(TAX_MODE_LABEL)}') && card.includes('{tr(TAX_MODE_HINT)}'));
  assert.ok(card.includes('const known = taxModeErrorMessage(err);'), 'رسالة 409 من TAX_MODE_MESSAGES');
  assert.ok(card.includes('disabled={save.isPending || blocked}'));
  // ما يُخفى للشركة بلا ضريبة — والشرط نفسه كما كان لغيرها
  assert.ok(s.includes("{accountingOn && !taxOff && (\n          <div className=\"card\">"), 'بطاقة الفوترة الإلكترونية');
  assert.match(s, /\{!taxOff && \(\n\s*<div>\n\s*<label className="label">\{tr\('الرقم الضريبي'\)\}<\/label>/, 'خانة الرقم الضريبي');
  assert.ok(s.includes("<Header title={taxOff ? tr(TAX_FREE_TITLES.sale) : tr('فاتورة ضريبية')} company={previewCompany} />"));
  assert.ok(s.includes('taxNumber: taxOff ? undefined : data?.taxNumber,'), 'الرقم الضريبي في معاينة الترويسة');
  assert.ok(s.includes("{taxOff ? tr('الدولة') : tr('الدولة تحدد العملة والضريبة والفوترة الإلكترونية')}"));
});

test('تبويب الربط (المرحلة الثانية) لا يظهر لشركةٍ بلا ضريبة — وغيرها كما كان', () => {
  const on = { zatcaPhase2Enabled: true, countryCode: 'SA' };
  assert.equal(zatcaTabVisible(on, 'ADMIN'), true);
  assert.equal(zatcaTabVisible({ ...on, taxDisabled: false }, 'ADMIN'), true);
  assert.equal(zatcaTabVisible({ ...on, taxDisabled: null }, 'ADMIN'), true);
  assert.equal(zatcaTabVisible({ ...on, taxDisabled: true }, 'ADMIN'), false);
  assert.equal(zatcaTabVisible({ countryCode: 'SA', zatcaPhase2StartedAt: '2026-10-02T00:00:00Z', taxDisabled: true }, 'ADMIN'), false, 'الختم يغلب');
  // رفض التسليح والتفعيل بعد إزالتها من جهازٍ آخر: عبارة الرمز، وإعادة قراءة الشركة فيختفي التبويب
  assert.equal(GO_LIVE_ERROR_LABEL.TAX_OFF_BLOCKS_ZATCA, TAX_MODE_MESSAGES.TAX_OFF_BLOCKS_ZATCA);
  const act = read('components', 'zatca', 'ZatcaActivationSection.tsx');
  assert.equal(act.split("if (e.code === 'TAX_OFF_BLOCKS_ZATCA') void qc.invalidateQueries({ queryKey: ['company'] });").length - 1, 3);
});

// ═══ إعدادات الشركة مرسومةً ═══

/** صفحة الإعدادات مرسومةً بشركةٍ في الذاكرة (لا طلب) ومديرٍ غير مقيَّد */
async function renderSettings(company: Record<string, unknown>): Promise<string> {
  browserEnv();
  const { default: CompanySettingsPage } = await import('./CompanySettingsPage');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['company'], company);
  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(MemoryRouter, null, h(CompanySettingsPage))));
}
const SA_COMPANY = {
  name: 'شركة الاختبار', address: 'الرياض', taxNumber: '300000000000003', commercialReg: '1010000000', countryCode: 'SA', currency: 'SAR',
  accountingEnabled: true, zatcaPhase2Enabled: false,
};

test('إعدادات الشركة بلا ضريبة: لا ذكر للضريبة في الصفحة إلا بطاقة المفتاح (عنوانه وتلميحه) — والاستيراد خارج المجموعة', async () => {
  const html = await renderSettings({ ...SA_COMPANY, taxDisabled: true });
  assert.ok(html.includes('data-tax-mode=""'), 'بطاقة المفتاح غائبة');
  // بطاقة المفتاح وحدها تذكر الضريبة: تُقتطع ثم يُفحص الباقي (قسم الاستيراد للمجموعة الثانية — يُفحص هناك)
  const cardAt = html.indexOf('<div class="card" data-tax-mode="">');
  const cardEnd = html.indexOf('</p></div>', html.indexOf(TAX_MODE_HINT, cardAt)) + '</p></div>'.length;
  const card = html.slice(cardAt, cardEnd);
  assert.ok(card.includes(TAX_MODE_LABEL) && card.includes(TAX_MODE_HINT));
  assert.match(card, /<input type="checkbox"[^>]*checked=""/, 'المفتاح لا يعكس الإزالة');
  const rest = (html.slice(0, cardAt) + html.slice(cardEnd)).split('id="data-import"')[0];
  assertNoTax(visible(rest), 'إعدادات الشركة');
  assert.ok(rest.includes(TAX_FREE_TITLES.sale), 'معاينة الترويسة بعنوان «فاتورة»');
});

test('إعدادات الشركة بضريبتها: الحقول والبطاقات كما كانت، والمفتاح غير مفعّل', async () => {
  const html = await renderSettings({ ...SA_COMPANY });
  for (const k of ['الرقم الضريبي', 'الدولة تحدد العملة والضريبة والفوترة الإلكترونية', 'الضريبة الافتراضية', 'الفوترة الإلكترونية الربط الحكومي', 'فاتورة ضريبية', '300000000000003']) {
    assert.ok(html.includes(k), `غاب «${k}» عن الشركة ذات الضريبة`);
  }
  const card = html.slice(html.indexOf('data-tax-mode'));
  assert.doesNotMatch(card.slice(0, card.indexOf('</label>')), /checked=""/);
  // المفتاح معطّل برسالة المنع لشركةٍ ربطها مفعّل
  const blocked = await renderSettings({ ...SA_COMPANY, zatcaPhase2Enabled: true });
  const bc = blocked.slice(blocked.indexOf('data-tax-mode'));
  assert.match(bc.slice(0, bc.indexOf('</label>')), /disabled=""/);
  assert.ok(bc.includes(TAX_MODE_MESSAGES.TAX_MODE_ZATCA_CONFLICT));
});

// ═══ الأصناف والعملاء ═══

test('الأصناف (المصدر): عمود «الضريبة %» وخلاياه خلف taxOff، والعدّاد بعموده، وخانة النسبة ورموز الوحدة وأكواد الفوترة في النافذة', () => {
  const page = read('pages', 'ProductsPage.tsx');
  assert.ok(page.includes('const taxOff = isTaxOff(company);'));
  assert.ok(page.includes("{!taxOff && <th>{tr('الضريبة %')}</th>}"));
  assert.ok(page.includes('{!taxOff && <td className="text-gray-600">{p.taxPct}%</td>}'));
  assert.ok(page.includes('const cols = 8 - (taxOff ? 1 : 0) + (lotOn ? 1 : 0)'));
  assert.ok(page.includes('taxOff={taxOff}'));
  const m = read('components', 'forms', 'ProductModal.tsx');
  assert.match(m, /taxOff = false, zatcaCollect = false, lotTrackingOn = false \}: Props\)/);
  assert.match(m, /\{!taxOff && \(\n\s*<div>\n\s*<label className="label">\{tr\('نسبة الضريبة %'\)\}<\/label>/, 'خانة النسبة');
  assert.ok(m.includes("{taxOff ? null : <>{tr('قبل الضريبة')} · </>}"), '«قبل الضريبة» في تلميح القائمة');
  assert.ok(m.includes("{activeList ? listHint : taxOff ? null : <p className=\"text-[10px] text-gray-400 mt-1\">{tr('قبل الضريبة')}</p>}"));
  assert.match(m, /\{!taxOff && \(\n\s*<input className="input py-1\.5 text-sm" dir="ltr" maxLength=\{16\} value=\{f\.unitCode\} placeholder=\{tr\('رمز الوحدة الضريبي'\)\}/);
  assert.match(m, /\{!taxOff && \(\n\s*<details className="rounded-lg border border-gray-100 bg-gray-50\/60">\n\s*<summary[^\n]*\{tr\('متقدم'\)\}/, 'رمزا الوحدة في النموذج العكسي');
  assert.match(m, /\{!taxOff && \(\n\s*<details className="rounded-xl border border-gray-200 bg-gray-50\/60">/, 'أكواد الفوترة الإلكترونية');
  // النسبة لا تُرسل: الجديد يرثها الخادم (defaultVatPct مخزّنة)، والقائم بلا تغيير
  assert.ok(m.includes('...(taxOff ? { taxPct: undefined } : {}),'));
  assert.ok(m.indexOf('...(taxOff ? { taxPct: undefined } : {}),') > m.indexOf('void confirmThenSave('));
});

test('نافذة الصنف مرسومةً بلا ضريبة: لا نسبة ولا «قبل الضريبة» ولا رموز الوحدة ولا أكواد الفوترة — جديداً وقائماً بوحدات؛ وبضريبتها كما كانت', async () => {
  browserEnv();
  const { default: ProductModal } = await import('../components/forms/ProductModal');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } } });
  qc.setQueryData(['price-lists'], { lists: [], timezone: 'Asia/Riyadh' });
  qc.setQueryData(['product-categories'], []);
  const existing = {
    id: 'p1', code: 'P1', name: 'ماء', unit: 'قارورة', basePrice: 1, taxPct: 15, status: 'ACTIVE', unitCode: 'PCE',
    units: [{ id: 'u1', name: 'كرتون', factor: 24, price: 20, unitCode: 'CT', isActive: true }],
  };
  const render = (product: unknown, taxOff?: boolean) => renderToStaticMarkup(h(QueryClientProvider, { client: qc },
    h(ProductModal, { product: product as never, onClose: () => {}, onSave: () => {}, loading: false, ...(taxOff === undefined ? {} : { taxOff }) })));
  for (const product of [null, existing]) {
    const off = render(product, true);
    assert.ok(off.includes('data-product-units') || product === null, 'النافذة لم تُرسم');
    assertNoTax(visible(off), `نافذة الصنف ${product ? 'القائم' : 'الجديد'}`);
    const today = render(product);
    assert.ok(today.includes('نسبة الضريبة %') && today.includes('أكواد الفوترة الإلكترونية'), 'الشركة ذات الضريبة فقدت خاناتها');
    assert.equal(render(product, false), today, 'taxOff:false غيّر النافذة');
  }
});

test('نافذة العميل بلا ضريبة: لا خانة الرقم الضريبي — وبضريبتها كما كانت', async () => {
  browserEnv();
  const { default: CustomerModal } = await import('../components/forms/CustomerModal');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const render = (taxOff?: boolean) => renderToStaticMarkup(h(QueryClientProvider, { client: qc },
    h(CustomerModal, { customer: { id: 'c1', name: 'عميل', taxNumber: '310000000000003', status: 'ACTIVE' } as never, onClose: () => {}, onSave: () => {}, loading: false, ...(taxOff === undefined ? {} : { taxOff }) })));
  const off = render(true);
  assertNoTax(visible(off), 'نافذة العميل');
  const today = render();
  assert.ok(today.includes('الرقم الضريبي'));
  assert.equal(render(false), today, 'taxOff:false غيّر النافذة');
});

test('تصدير العملاء: بلا عمود الرقم الضريبي ولا عرضه لشركةٍ بلا ضريبة — والعروض كما كانت لغيرها', () => {
  assert.deepEqual(customerExportColWidths(true, false), [26, 28, 24, 14, 14, 24, 14, 14, 28, 18, 16, 14, 14, 14, 10, 10, 40, 14]);
  assert.deepEqual(customerExportColWidths(false, false), [26, 28, 24, 14, 14, 24, 14, 14, 28, 18, 16, 14, 10, 40, 14]);
  for (const acc of [true, false]) {
    const off = customerExportColWidths(acc, true);
    const on = customerExportColWidths(acc, false);
    assert.equal(off.length, on.length - 1);
    assert.deepEqual(off, on.filter((_, i) => i !== CUSTOMER_EXPORT_TAX_COL));
  }
  const page = read('pages', 'CustomersPage.tsx');
  assert.ok(page.includes("...(taxOff ? {} : { [tr('الرقم الضريبي')]: c.taxNumber || '' }),"));
  // موضع العمود في الصفّ هو موضعه في العروض (بعد العنوان، العاشر)
  const row = page.slice(page.indexOf('const rows = all.map(c => ({'), page.indexOf('const out = await shareOrDownloadExcel('));
  const keys = [...row.matchAll(/\[tr\('([^']+)'\)\]:/g)].map((x) => x[1]);
  assert.equal(keys.indexOf('الرقم الضريبي'), CUSTOMER_EXPORT_TAX_COL);
  assert.ok(page.includes('colWidths: customerExportColWidths(accountingOn, taxOff)'));
  assert.ok(page.includes('taxOff={taxOff}'), 'نافذة العميل لا تعرف الوضع');
});

// ═══ نصوص المطبوعات ═══

test('محرّر النصوص بلا ضريبة: عبارات الضريبة كلها مخفية وما سواها ظاهر — وعنوانا المستند «فاتورة» و«فاتورة مرتجع» — وبضريبتها كل شيء', () => {
  for (const e of PRINT_TEXT_CATALOG) {
    assert.equal(printTextRowVisible(e.key, false), true, `${e.key}: يُخفى للشركة ذات الضريبة`);
    assert.equal(printTextDefault(e, false), e.ar);
    const shown = printTextRowVisible(e.key, true);
    assert.equal(shown, !TAX_PHRASE_KEYS.includes(e.key), e.key);
    if (shown) assertNoTax(printTextDefault(e, true), `صفّ ${e.key}`);
  }
  assert.equal(printTextDefault({ key: 'inv.title', ar: 'فاتورة ضريبية مبسطة' }, true), TAX_FREE_TITLES.sale);
  assert.equal(printTextDefault({ key: 'inv.returnTitle', ar: 'إشعار دائن مرتجع' }, true), TAX_FREE_TITLES.return);
  // التنبيهات: سطر المنصّة وحده يبقى
  for (const w of ['tax', 'standard', 'status', null] as const) {
    assert.equal(editorWarningFor(w, true), null);
    assert.equal(editorWarningFor(w, false), w);
  }
  assert.equal(editorWarningFor('platform', true), 'platform');
});

test('محرّر النصوص (المصدر): القائمة والسطور المحذوفة بالمرشِّح، والمبدّلان وتحذير العنوان وسؤال الحذف خلف taxOff، والمعاينة مختومة', () => {
  const e = read('components', 'print', 'PrintTextsEditor.tsx');
  assert.ok(e.includes('const taxOff = isTaxOff(company);'));
  assert.ok(e.includes("(e.doc === tab || e.doc === 'shared') && printTextRowVisible(e.key, taxOff)"));
  assert.ok(e.includes('const groups = useMemo(() => groupsFor(tab, taxOff), [tab, taxOff]);'));
  assert.ok(e.includes('deletedLines(draft, tab).filter((e) => printTextRowVisible(e.key, taxOff))'));
  assert.ok(e.includes('return taxOff ? taxFreeInvoiceDoc(d) : d;') && e.includes('return taxOff ? taxFreeReceiptDoc(d) : d;'));
  assert.match(e, /\{!taxOff && \(\n\s*<Seg small value=\{sample\.standard \? 'standard' : 'simplified'\}/);
  assert.match(e, /\{!taxOff && \(\n\s*<label[^\n]*>\n\s*<input[^\n]*checked=\{sample\.inclusive\}/);
  assert.ok(e.includes('{isTitle && !taxOff && (active || edited) && ('));
  assert.ok(e.includes('{warning && warningShown && ('));
  assert.match(e, /if \(taxOff\) \{ setEdit\(key, \{ hidden: true \}\); return; \}\n\s*const ask = deleteConfirmText\(key, tr\);/);
  assert.ok(e.includes('{tr(sampleWatermark(taxOff))}'));
  assert.ok(!e.includes('tr(PRINT_SAMPLE_WATERMARK)'), 'العلامة الثابتة ما زالت في المحرّر');
});

// ═══ المستندات النموذجية ═══

const docText = (d: unknown) => JSON.stringify(d);

test('المستند النموذجي بلا ضريبة: مختوم taxFree، بنسبة صفر، والإجمالي = البنود − الخصم، بلا رقم ضريبي للطرفين ولا قرار هيئة', () => {
  const base: InvoiceDoc = {
    kind: 'invoice', number: 'INV-1', date: '2026-11-07T08:00:00Z', type: 'CREDIT', repName: 'م',
    company: { name: 'ش', taxNumber: '300000000000003' }, customer: { name: 'ع', taxNumber: '310000000000003' },
    items: [{ name: 'أ', qty: 2, unitPrice: 28.75, discountPct: 0, taxPct: 15, lineTotal: 57.5, taxAmt: 7.5 }, { name: 'ب', qty: 1, unitPrice: 57.5, discountPct: 10, taxPct: 15, lineTotal: 51.75 }],
    subtotal: 95, discount: 5, tax: 13.5, total: 103.5, pricesIncludeTax: true, paidAmt: 50, remainingAmt: 53.5,
    installments: [{ seq: 1, dueDate: '2026-12-07', amount: 51.75 }, { seq: 2, dueDate: '2027-01-07', amount: 51.75 }],
    zatca: { phase: 2 } as never, einvoice: { provider: 'eta', status: 'SENT' },
  };
  const d = taxFreeInvoiceDoc(base);
  assert.equal(d.taxFree, true);
  assert.equal(d.tax, 0);
  assert.equal(d.pricesIncludeTax, false);
  assert.ok(d.items.every((it) => it.taxPct === 0));
  assert.equal(d.items[0].taxAmt, 0);
  assert.equal('taxAmt' in d.items[1], false, 'ضريبة سطرٍ لم تكن');
  assert.deepEqual(d.items.map((it) => [it.unitPrice, it.lineTotal]), [[28.75, 57.5], [57.5, 51.75]], 'السعر المكتوب نهائي');
  assert.equal(d.subtotal, 109.25);
  assert.equal(d.total, 104.25);
  assert.equal(d.paidAmt, 50);
  assert.equal(d.remainingAmt, 54.25);
  assert.equal(d.zatca, undefined);
  assert.equal(d.einvoice, undefined);
  assert.equal(d.company?.taxNumber, undefined);
  assert.equal(d.customer.taxNumber, undefined);
  assert.ok(!docText(d).includes('300000000000003') && !docText(d).includes('310000000000003'));
  assert.equal(base.tax, 13.5, 'المدخل لا يتغيّر');
  const r = taxFreeReceiptDoc({ kind: 'receipt', number: 'R', date: 'x', company: { name: 'ش', taxNumber: '300000000000003' }, customer: { name: 'ع', taxNumber: '310000000000003' }, repName: 'م', amount: 1, paymentMethod: 'CASH' });
  assert.ok(!docText(r).includes('3000000') && !docText(r).includes('3100000'));
});

test('معاينة «إعدادات الطباعة»: فاتورة الشركة بلا ضريبة وسندها بلا رقمٍ ضريبي ولا ضريبة — وبضريبتها كما كانت حرفاً', () => {
  const id = (s: string) => s;
  const now = new Date('2026-11-07T08:00:00Z');
  const off = previewInvoiceDoc({ name: 'ش', taxNumber: '300000000000777', taxDisabled: true }, id, now);
  assert.equal(off.taxFree, true);
  assert.equal(off.tax, 0);
  assert.ok(off.items.every((it) => it.taxPct === 0 && (it.taxAmt ?? 0) === 0));
  assert.ok(!off.zatca, 'عرض الهيئة في نموذج شركةٍ بلا ضريبة');
  assert.ok(!docText(off).includes('300000000000777') && !docText(off).includes('310000000000003'));
  assert.ok(!docText(previewReceiptDoc({ name: 'ش', taxNumber: '300000000000777', taxDisabled: true }, id, now)).match(/300000000000777|310000000000003/));
  const today = previewInvoiceDoc({ name: 'ش' }, id, now);
  assert.deepEqual(previewInvoiceDoc({ name: 'ش', taxDisabled: false }, id, now).items, today.items);
  assert.equal(today.customer.taxNumber, '310000000000003');
  assert.ok(today.tax > 0 && !today.taxFree);
});

// ═══ إعدادات الطباعة ═══

const PROFILES = (): PrintProfile[] => [
  newProfile('thermal', 'r', []), newProfile('page', 'p', []), newProfile('impact', 'i', []),
  withDesign(newProfile('page', 'g', []), 'grid_bilingual'),
];

test('المخطّط «المقاس والهوامش» بلا ضريبة: لا رقم ضريبي ولا عنوانٌ ضريبي ولا سطرا الضريبة ولا رمز، والعلامة «نموذج اختبار» — وبلا العلم كما كان', () => {
  for (const p of PROFILES()) {
    const props = { profile: p, companyName: 'شركة', brandColor: '#123456' };
    const off = renderToStaticMarkup(inTaxOff(h(PaperPreview, props)));
    assertNoTax(visible(off), `المخطّط ${p.id}`);
    assert.ok(off.includes(TAX_OFF_SAMPLE_WATERMARK) && off.includes('فاتورة'));
    const today = renderToStaticMarkup(h(PaperPreview, props));
    assert.equal(renderToStaticMarkup(h(TaxOffPrintContext.Provider, { value: false }, h(PaperPreview, props))), today);
    assert.ok(today.includes(PRINT_SAMPLE_WATERMARK) && today.includes('فاتورة ضريبية مبسطة') && today.includes('300000000000003'));
  }
});

test('أدوات التصميم بلا ضريبة: لا صفّ للرمز ولا كتلة حذفه ولا أختام الحالة ولا تنبيه هيئة — وبلا العلم كما كانت', () => {
  for (const p0 of PROFILES()) {
    // قالبٌ قابلٌ للتحرير حذف الأصناف والرمز والأختام وأخفى قسم الإجماليات — أقصى ما يُنبَّه عليه
    const p = withStampsRemoved(withQrRemoved(withSectionStyle(withSectionStyle(p0, 'items', { visible: false }), 'totals', { visible: false }), true), true);
    const props = { p, update: () => {}, phase2: false };
    const off = renderToStaticMarkup(inTaxOff(h(PrintDesignTools, props)));
    assertNoTax(visible(off), `أدوات ${p0.id}`);
    for (const gone of ['data-tool-qr', 'data-tool-stamps', 'data-qr-remove', 'data-stamps', 'data-compliance-note', 'data-tool-row="qr"', 'data-qr-orphan']) {
      assert.ok(!off.includes(gone), `${p0.id}: ${gone}`);
    }
    const today = renderToStaticMarkup(h(PrintDesignTools, props));
    assert.equal(renderToStaticMarkup(h(TaxOffPrintContext.Provider, { value: false }, h(PrintDesignTools, props))), today);
  }
  // الحقول وحدها: بلا العلم كما كانت، وبه لا شيء
  const p = withStampsRemoved(withQrRemoved(newProfile('page', 'x', []), true), true);
  assert.equal(renderToStaticMarkup(inTaxOff(h(QrRemoveField, { p, update: () => {} }))), '');
  assert.equal(renderToStaticMarkup(inTaxOff(h(StampsField, { p, update: () => {} }))), '');
  assert.ok(renderToStaticMarkup(h(QrRemoveField, { p, update: () => {} })).includes(QR_REMOVE_WARNING));
  assert.ok(renderToStaticMarkup(h(StampsField, { p, update: () => {} })).includes(STAMPS_REMOVE_WARNING));
  const hiddenItems = withSectionStyle(newProfile('thermal', 'r', []), 'items', { visible: false });
  const sf = renderToStaticMarkup(inTaxOff(h(SectionStyleFields, { p: hiddenItems, update: () => {}, id: 'items', phase2: false })));
  assert.ok(!sf.includes(ITEMS_REMOVE_WARNING));
  assertNoTax(visible(sf), 'تنسيق قسم الأصناف');
});

test('تنبيهات القالب ووصفه بلا ضريبة: بلا تنبيهات الرمز والفاتورة الضريبية — والنتيجة نفسها حرفاً بلا العلم', () => {
  for (const p0 of PROFILES()) {
    const p = withStampsRemoved(withQrRemoved(withSectionStyle(p0, 'items', { visible: false }), true), true);
    for (const phase2 of [false, true]) {
      const r = profileWarnings(p, { phase2 });
      assert.equal(taxOffProfileWarnings(r, false), r);
      const off = taxOffProfileWarnings(r, true);
      for (const w of [...off.warnings, ...off.notes]) assertNoTax(w, `تنبيه ${p0.id}`);
      for (const gone of [PRINT_WARNINGS.qrRemoved, PRINT_WARNINGS.itemsRemoved, PRINT_WARNINGS.stampsRemoved, PRINT_WARNINGS.qrNoFit, PRINT_WARNINGS.phase2Narrow, PRINT_NOTES.impactTopPly]) {
        assert.ok(![...off.warnings, ...off.notes].includes(gone));
      }
    }
  }
  for (const t of Object.keys(TEMPLATE_HINTS) as TemplateId[]) {
    assert.equal(templateHintFor(t, TEMPLATE_HINTS[t], false), TEMPLATE_HINTS[t]);
    assertNoTax(templateHintFor(t, TEMPLATE_HINTS[t], true), `وصف ${t}`);
    assert.doesNotMatch(templateHintFor(t, TEMPLATE_HINTS[t], true), /QR/);
  }
  for (const v of Object.values(TAX_OFF_TEMPLATE_HINTS)) assertNoTax(v!, 'بديل الوصف');
  assertNoTax(TAX_OFF_DEVICE_SAMPLE_NOTE, 'تلميح الطباعة التجريبية');
  assertNoTax(TAX_OFF_SAMPLE_WATERMARK, 'العلامة');
});

test('إعدادات الطباعة (المصدر): اللوحة توفّر السياق من علم الشركة، وقسم «رمز QR» وملاحظته خلفه، والطباعة التجريبية والمعايرة بلا ضريبة', () => {
  const panel = read('components', 'print', 'PrintSettingsPanel.tsx');
  assert.ok(panel.includes('const taxOff = isTaxOff(company);'));
  assert.ok(panel.includes('<TaxOffPrintContext.Provider value={taxOff}>') && panel.includes('</TaxOffPrintContext.Provider>'));
  assert.ok(panel.includes("{!taxOff && (<Section title={tr('رمز QR')}>"));
  assert.ok(panel.includes('{!taxOff && <p className="text-[11px] text-[#6E6557] flex items-start gap-1.5"><Info size={12} className="mt-0.5 shrink-0" />{tr(QR_PANEL_NOTE)}</p>}'));
  assert.ok(panel.includes('const { warnings, notes } = taxOffProfileWarnings(profileWarnings(p, { phase2 }), taxOff);'));
  assert.ok(panel.includes('const hint = templateHintFor(t, t ? TEMPLATE_HINTS[t] : DESIGN_HINTS.grid_bilingual ?? \'\', taxOff);'));
  const tools = read('components', 'print', 'PrintDeviceTools.tsx');
  assert.ok(tools.includes('const taxOff = useTaxOffPrint() || isTaxOff(company);'), 'أدوات الجهاز في المندوب بلا سياق: من علم الشركة');
  assert.ok(tools.includes('const PRINT_SAMPLE_WATERMARK = sampleWatermark(taxOff);'));
  assert.ok(tools.includes('buildCalibrationPage(p, t, taxOff ? { ...o, taxOff } : o)'));
  assert.ok(tools.includes('{taxOff ? tr(TAX_OFF_DEVICE_SAMPLE_NOTE) :'));
  // المصمّم: العلامة والتنبيهات ومربع الرمز
  const canvas = read('components', 'print', 'designer', 'A4BandsCanvas.tsx');
  assert.ok(canvas.includes("addableBoxes(p, doc).filter((id) => !(taxOff && id === 'qr'))"));
  assert.ok(canvas.includes("drawnBoxes(p, bandR.boxes).filter((b) => !(taxOff && b.id === 'qr'))"));
  assert.ok(canvas.includes('{tr(sampleWatermark(taxOff))}') && canvas.includes("{doc === 'invoice' && qrRemoved && !taxOff && ("));
  const strip = read('components', 'print', 'designer', 'RollStrip.tsx');
  assert.ok(strip.includes('{tr(sampleWatermark(taxOff))}') && strip.includes('const qrRemoved = isQrRemoved(l) && !taxOff;'));
  assert.ok(read('components', 'print', 'designer', 'PrintDesigner.tsx').includes('{isItemsRemoved(layoutOf(p)) && !taxOff && ('));
  assert.ok(read('components', 'print', 'designer', 'DesignInspector.tsx').includes("sectionsFor(p.printer, l.design).filter((s) => s !== 'qr')"));
  // لا عبارة ثابتة تذكر الضريبة في المساعد نفسه إلا حارس الاختبار
  const helper = read('components', 'print', 'taxOffPrint.ts');
  for (const m of helper.matchAll(/'([^'\n]*[؀-ۿ][^'\n]*)'/g)) assertNoTax(m[1], 'عبارات المساعد');
  assert.ok(TAX_MODE_CONFIRM_OFF.length > 0);
});
