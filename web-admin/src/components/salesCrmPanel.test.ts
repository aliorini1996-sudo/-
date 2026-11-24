/**
 * «إدارة المبيعات» (طلب المالك ١٦ نوفمبر ٢٠٢٦) — حلّت محلّ «عروض الأسعار» في لوحة المالك: كل من تواصل مع المنصة في قائمة واحدة.
 * حرّاسٌ نصّية وصرفة (النافذة تعتمد React Query والمتصفّح): نافذة «عروض الأسعار» زالت، والزرّ والتركيب خلف can('sales.view')،
 * والنافذة تعرض القنوات السبع بأسمائها، وعميل الواجهة على مساري /leads/sales-inbox كما في الخادم، وكل نصٍّ مترجم بلغاته الأربع.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SALES_CHANNELS, SALES_STAGES, SALES_NOTE_MAX, SALES_LIMIT_DEFAULT, SALES_LIMIT_MAX, channelOf, stageOf, inboxParams, intlDigits,
  mailHref, telHref, waHref, waHrefForRow, dialForCountry,
} from '../lib/salesCrm';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const BACKEND = path.resolve(process.cwd(), '..', 'backend', 'src');
const readBackend = (...p: string[]) => fs.readFileSync(path.join(BACKEND, ...p), 'utf8').replace(/\r\n/g, '\n');

// ───────────────────────────── لوحة المالك ─────────────────────────────

test('PlatformPage: لا «عروض الأسعار» — والنافذة وملفها زالا', () => {
  const page = read('pages', 'PlatformPage.tsx');
  assert.doesNotMatch(page, /QuotesPanel/);
  assert.doesNotMatch(page, /quotes\.view|quotes\.delete|menu\.quotes|setShowQuotes/);
  assert.doesNotMatch(page, /tr\('عروض الأسعار'\)/);
  assert.equal(fs.existsSync(path.join(SRC, 'components', 'QuotesPanel.tsx')), false, 'QuotesPanel.tsx باقٍ');
  // ولا ملف آخر يستوردها
  const importers = walk(SRC).filter((f) => /QuotesPanel/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f));
  assert.deepEqual(importers, []);
});

test('PlatformPage: زرّ «إدارة المبيعات» وتركيب نافذتها خلف can(\'sales.view\') — للمالك كل can() صادقة', () => {
  const page = read('pages', 'PlatformPage.tsx');
  assert.match(page, /import SalesCrmPanel from '\.\.\/components\/SalesCrmPanel';/);
  assert.match(page, /\bsales: can\('sales\.view'\)/, 'مفتاح القسم في menu');
  // الزرّ داخل كتلة menu.sales، بأيقونة واسم
  const btn = page.match(/\{menu\.sales && \(\s*<button onClick=\{\(\) => setShowSales\(true\)\}[\s\S]*?<\/button>\s*\)\}/);
  assert.ok(btn, 'زرّ «إدارة المبيعات» خارج menu.sales');
  assert.match(btn[0], /<TrendingUp size=\{18\}/);
  assert.match(btn[0], /tr\('إدارة المبيعات'\)/);
  assert.equal((page.match(/setShowSales\(true\)/g) || []).length, 1, 'زرٌّ ثانٍ يفتح النافذة');
  assert.equal((page.match(/tr\('إدارة المبيعات'\)/g) || []).length, 1);
  // والتركيب نفسه بشرط المفتاح: صلاحيةٌ سُحبت والنافذة مفتوحة تُغلقها
  assert.match(page, /\{showSales && menu\.sales && <SalesCrmPanel onClose=\{\(\) => setShowSales\(false\)\} \/>\}/);
  assert.equal((page.match(/<SalesCrmPanel\b/g) || []).length, 1);
  // في الشريط الجانبي موضع «عروض الأسعار»: بعد السفراء وقبل محتوى الموقع
  const iAff = page.indexOf('setShowAffiliates(true)');
  const iSales = page.indexOf('setShowSales(true)');
  const iContent = page.indexOf('setShowProfile(true)');
  assert.ok(iAff > 0 && iAff < iSales && iSales < iContent, 'موضع الزرّ في الشريط الجانبي');
});

test('كتالوج الصلاحيات في الواجهة: sales.view بدل quotes.* — ولا تبعية عروض أسعار في نافذة الموظفين', () => {
  const access = read('lib', 'platformAccess.ts');
  const typeBlock = access.match(/export type StaffKey =([\s\S]*?);/);
  assert.ok(typeBlock);
  assert.match(typeBlock[1], /'sales\.view'/);
  assert.doesNotMatch(typeBlock[1], /'quotes\./);
  assert.doesNotMatch(read('components', 'StaffPanel.tsx'), /quotes\./);
});

// ───────────────────────────── النافذة ─────────────────────────────

test('SalesCrmPanel: شاشة كاملة كالعملاء المحتملين، بالقنوات والحالات والأعمدة والملاحظتين', () => {
  const panel = read('components', 'SalesCrmPanel.tsx');
  assert.match(panel, /<div className="fixed inset-0 z-50 bg-\[#FAF7F0\] overflow-y-auto" dir="rtl">/, 'ليست شاشة كاملة');
  assert.doesNotMatch(panel, /max-w-3xl max-h-\[94vh\]|backdropClose/, 'نافذة صغيرة لا شاشة');
  assert.match(panel, /<h1[^>]*>[\s\S]*?tr\('إدارة المبيعات'\)/);
  assert.match(panel, /onClick=\{onClose\}/);
  assert.match(panel, /onClick=\{\(\) => refetch\(\)\}/, 'زرّ التحديث');
  // القنوات من الكتالوج المشترك بأسمائها المترجمة، و«الكل» أولاً
  assert.match(panel, /label=\{tr\('الكل'\)\}/);
  assert.match(panel, /channels\.map\(\(c\) => \(\s*<ChannelChip key=\{c\.value\} active=\{channel === c\.value\} label=\{tr\(c\.label\)\} count=\{byChannel\[c\.value\] \?\? 0\}/);
  assert.match(panel, /SALES_STAGES\.map\(\(s\) => <option key=\{s\.value\} value=\{s\.value\}>\{tr\(s\.label\)\}/);
  // واتساب لا يظهر لمن لا يُرسل له (الخادم يقرّر included)
  assert.match(panel, /c\.value !== 'WHATSAPP' \|\| data\?\.whatsapp\.included !== false/);
  // الأعمدة السبعة بالترتيب
  const heads = [...panel.matchAll(/<th[^>]*>\{tr\('([^']+)'\)\}<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['العميل', 'الجوال', 'البريد', 'من أين أتى', 'وقت التسجيل', 'الحالة', 'مسؤول الصفقة', 'الملاحظات']);
  // الروابط: tel: وwa.me وmailto: من الأدوات الصرفة
  assert.match(panel, /telHref\(row\.phone\)/);
  assert.match(panel, /const wa = waHrefForRow\(row\);/);
  assert.doesNotMatch(panel, /dialOf\(row\.country\)/, 'الدولة نصّاً في نموذج الاشتراك لا رمزاً');
  assert.match(panel, /mailHref\(row\.email\)/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer"/);
  // الحالة تُحفظ عند الاختيار (PUT)، والملاحظات سجلٌّ بأيقونة وعدّاد كملاحظات الشركات (SalesNotesModal، ١٦ نوفمبر)
  assert.match(panel, /mutationFn: \(body: SalesUpdate\) => salesApi\.update\(row\.id, body\)/);
  assert.match(panel, /onChange=\{\(e\) => m\.mutate\(\{ stage: e\.target\.value as SalesUpdate\['stage'\] \}\)\}/);
  assert.match(panel, /<SalesNotesButton row=\{row\} onClick=\{\(\) => setNotesOpen\(true\)\} \/>/);
  assert.match(panel, /<SalesNotesModal row=\{row\} onClose=\{\(\) => setNotesOpen\(false\)\} \/>/);
  // الصفّ المحفوظ يُكتب في الذاكرة قبل التحديث — فلا ترجع الحالة القديمة حتى تعود المزامنة
  const success = panel.match(/onSuccess: \(res\) => \{([\s\S]*?)\n {4}\},/);
  assert.ok(success, 'onSuccess لا يستلم ردّ الحفظ');
  assert.match(success[1], /const fresh = res\.data\.data as SalesRow;/);
  assert.match(success[1], /qc\.setQueriesData<SalesInbox>\(\{ queryKey: \['sales-inbox'\] \}, \(old\) => old && \{ \.\.\.old, rows: old\.rows\.map\(\(x\) => \(x\.id === fresh\.id \? fresh : x\)\) \}\);/);
  assert.ok(success[1].indexOf('setQueriesData') < success[1].indexOf('invalidateQueries'), 'الكتابة في الذاكرة بعد الإبطال');
  // «عرض المزيد»: الحدّ في المفتاح وفي الطلب، والزرّ يرفعه إلى سقفه حين بقي ما لم يُعرض
  assert.match(panel, /queryKey: \['sales-inbox', channel, stage, q, limit\]/);
  assert.match(panel, /inboxParams\(\{ channel, stage, q, limit \}\)/);
  assert.match(panel, /\{data\.total > rows\.length && limit < SALES_LIMIT_MAX && \(\s*<button onClick=\{\(\) => setLimit\(SALES_LIMIT_MAX\)\}/);
  assert.match(panel, /tr\('عرض المزيد'\)/);
  // التاريخ بالمنسّق الميلادي المشترك (utils/format) لا بتنسيقٍ محلي
  // «وقت التسجيل» أوّل ظهورٍ للعميل، وآخر تواصلٍ تحته إن اختلف (طلب المالك ١٦ نوفمبر ٢٠٢٦)
  assert.match(panel, /formatDateTime\(row\.firstAt\)/);
  assert.match(panel, /row\.firstAt !== row\.lastAt && <p[^>]*>\{tr\('آخر تواصل'\)\} \{formatDateTime\(row\.lastAt\)\}/);
  assert.doesNotMatch(panel, /toLocale(Date)?String\(/);
  // الملاحظتان
  assert.match(panel, /data\?\.whatsapp\.included && !data\.whatsapp\.ok && \(/);
  assert.match(panel, /tr\('تعذر جلب محادثات واتساب الآن — أعد التحميل بعد قليل'\)/);
  assert.match(panel, /tr\('البريد الوارد غير مربوط بالمنصة بعد'\)/);
  // ولا أثر لمولّد الفواتير (أمر المالك)
  assert.doesNotMatch(panel, /invoice-tool|invoiceTool|مولد الفواتير/);
});

test('القنوات الثماني والحالات السبع بمفاتيح الخادم وأسمائها', () => {
  assert.deepEqual(SALES_CHANNELS.map((c) => [c.value, c.label]), [
    ['TRIAL', 'تسجيل تجريبي'],
    ['AMBASSADOR_TRIAL', 'تجربة عبر سفير'],
    ['SALES_CREATED', 'فُتح من قبل المبيعات'],
    ['MEETING', 'طلب اجتماع'],
    ['CONTACT', 'إيميل — تواصل معنا'],
    ['SUBSCRIPTION', 'طلب اشتراك'],
    ['QUOTE_REQUEST', 'طلب عرض سعر'],
    ['WHATSAPP', 'واتساب'],
  ]);
  assert.deepEqual(SALES_STAGES.map((s) => s.value), ['NEW', 'CONTACTED', 'MEETING', 'NEGOTIATION', 'WON', 'LOST', 'NOT_FIT']);
  assert.equal(SALES_NOTE_MAX, 2000);
  // مجهولٌ من خادمٍ أحدث يُعرض بمفتاحه لا ينهار
  assert.deepEqual([channelOf('EMAIL').label, stageOf('X').label], ['EMAIL', 'X']);
  assert.equal(channelOf('WHATSAPP').label, 'واتساب');
});

test('عقد الخادم: كل قناة وحالة مكتوبةٌ في خدمة صندوق المبيعات أو موجّهها', () => {
  const svcPath = path.join(BACKEND, 'services', 'salesInbox.ts');
  assert.ok(fs.existsSync(svcPath), 'backend/src/services/salesInbox.ts غائب');
  const server = readBackend('services', 'salesInbox.ts') + readBackend('routes', 'leads.ts') + readBackend('routes', 'contact.ts');
  for (const c of SALES_CHANNELS) assert.ok(server.includes(`'${c.value}'`), `القناة ${c.value} لا يعرفها الخادم`);
  for (const s of SALES_STAGES) assert.ok(server.includes(`'${s.value}'`), `الحالة ${s.value} لا يعرفها الخادم`);
});

// ───────────────────────────── عميل الواجهة ─────────────────────────────

test('salesApi: GET /leads/sales-inbox وPUT /leads/sales-inbox/:id — والمساران في موجّه العملاء المحتملين قبل /:id', () => {
  const client = read('api', 'client.ts');
  const block = client.match(/export const salesApi = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'salesApi غائب');
  assert.match(block[1], /inbox: \(params\?: SalesInboxParams\) => api\.get\('\/leads\/sales-inbox', \{ params \}\)/);
  assert.match(block[1], /update: \(id: string, body: SalesUpdate\) => api\.put\(`\/leads\/sales-inbox\/\$\{encodeURIComponent\(id\)\}`, body\)/);
  // سجلّ عروض الأسعار لم يعد له عميلٌ في الواجهة؛ الإصدار من الرابط الخاص باقٍ
  const quotes = client.match(/export const quotesApi = \{([\s\S]*?)\n\};/);
  assert.ok(quotes);
  assert.match(quotes[1], /issue: /);
  assert.doesNotMatch(quotes[1], /quotes\/admin/);

  const leads = readBackend('routes', 'leads.ts');
  const iGet = leads.search(/router\.get\(\s*'\/sales-inbox'/);
  const iPut = leads.search(/router\.put\(\s*'\/sales-inbox\/:id'/);
  const iParam = leads.search(/router\.get\(\s*'\/:id'/);
  assert.ok(iGet > 0, 'GET /sales-inbox غائب من routes/leads.ts');
  assert.ok(iPut > 0, 'PUT /sales-inbox/:id غائب من routes/leads.ts');
  assert.ok(iParam < 0 || (iGet < iParam && iPut < iParam), 'مسارا sales-inbox بعد /:id فيبتلعهما');
});

// ───────────────────────────── الأدوات الصرفة ─────────────────────────────

test('روابط الاتصال: tel: وwa.me بالشكل الدولي، وmailto: لبريدٍ صالح وحده', () => {
  assert.equal(telHref('+966 55 123 4567'), 'tel:+966551234567');
  assert.equal(telHref('055-123-4567'), 'tel:0551234567');
  assert.equal(telHref('12'), null);
  assert.equal(telHref(null), null);

  assert.equal(waHref('+966551234567'), 'https://wa.me/966551234567');
  assert.equal(waHref('00966551234567'), 'https://wa.me/966551234567');
  assert.equal(waHref('0551234567'), 'https://wa.me/966551234567', 'الجوال السعودي المحلي');
  assert.equal(waHref('551234567'), 'https://wa.me/966551234567');
  assert.equal(waHref('01012345678', '+20'), 'https://wa.me/201012345678', 'محليٌّ ودولته معروفة');
  assert.equal(waHref('01012345678'), null, 'محليٌّ غير سعودي ودولته مجهولة لا يُخمَّن');
  assert.equal(waHref('971501234567'), 'https://wa.me/971501234567');
  assert.equal(waHref(''), null);
  assert.equal(intlDigits('+1 (415) 555-0100'), '14155550100');
  // بلا دولة: رقمٌ مجرّد أقصر من دوليٍّ كامل لا يُعدّ دولياً (51234567 ليس +51 بيرو)
  assert.equal(waHref('51234567'), null);

  // دولة الصفّ: رمزها ISO أو اسمها كما كُتب في نموذج الاشتراك وعرض السعر
  assert.equal(dialForCountry('AE'), '+971');
  assert.equal(dialForCountry('ae'), '+971');
  assert.equal(dialForCountry('الإمارات'), '+971');
  assert.equal(dialForCountry('الامارات'), '+971', 'بلا همزة');
  assert.equal(dialForCountry('UAE'), '+971');
  assert.equal(dialForCountry('United Arab Emirates'), '+971');
  assert.equal(dialForCountry('المملكة العربية السعودية'), '+966');
  assert.equal(dialForCountry('السعوديه'), '+966');
  assert.equal(dialForCountry('KSA'), '+966');
  assert.equal(dialForCountry('كويت'), '+965', 'بلا «ال»');
  assert.equal(dialForCountry('UK'), '+44');
  assert.equal(dialForCountry('أرض الأحلام'), '');
  assert.equal(dialForCountry(null), '');

  // حالات المراجعة: الدولة نصّاً — لا تخمين سعودي ولا رقم مجرّد يُعدّ دولياً
  const row = (phone: string, country: string | null) => waHrefForRow({ phone, country });
  assert.equal(row('0501234567', 'الإمارات'), 'https://wa.me/971501234567', '05 الإماراتي ليس سعودياً');
  assert.equal(row('51234567', 'الكويت'), 'https://wa.me/96551234567');
  assert.equal(row('33123456', 'قطر'), 'https://wa.me/97433123456');
  assert.equal(row('1012345678', 'مصر'), 'https://wa.me/201012345678');
  // ومعروفة ورقمها دوليٌّ بمفتاحها أو بـ+/00: كما هو
  assert.equal(row('96551234567', 'الكويت'), 'https://wa.me/96551234567');
  assert.equal(row('+971501234567', 'السعودية'), 'https://wa.me/971501234567');
  assert.equal(row('0551234567', 'SA'), 'https://wa.me/966551234567');
  // دولةٌ كُتبت ولم تُعرف: لا رابط لرقمٍ محلي أو مجرّد، و+/00 يكفيان
  assert.equal(row('0501234567', 'أرض الأحلام'), null);
  assert.equal(row('51234567', 'أرض الأحلام'), null);
  assert.equal(row('+96551234567', 'أرض الأحلام'), 'https://wa.me/96551234567');
  assert.equal(row('0096551234567', 'أرض الأحلام'), 'https://wa.me/96551234567');
  // بلا دولة (تواصل معنا) أو «XX»: التخمين السعودي وحده
  assert.equal(row('0551234567', null), 'https://wa.me/966551234567');
  assert.equal(row('0551234567', 'XX'), 'https://wa.me/966551234567');
  assert.equal(row('0501234567', ' '), 'https://wa.me/966501234567');

  assert.equal(mailHref('a.b@x.co'), 'mailto:a.b@x.co');
  assert.equal(mailHref(' a@x.co '), 'mailto:a@x.co');
  assert.equal(mailHref('a@x.co?cc=evil@y.co'), null, 'لا معاملات تُحقن في mailto:');
  assert.equal(mailHref('not an email'), null);
  assert.equal(mailHref(null), null);
});

test('inboxParams: الفارغ لا يُرسل، والبحث مقصوص', () => {
  assert.deepEqual(inboxParams({ channel: '', stage: '', q: '  ' }), {});
  assert.deepEqual(inboxParams({ channel: 'TRIAL', stage: 'NEW', q: ' علي ' }), { channel: 'TRIAL', stage: 'NEW', q: 'علي' });
  assert.deepEqual(inboxParams({ channel: '', stage: '', q: '', limit: SALES_LIMIT_MAX }), { limit: 1000 });
  // كحدود الخادم (الافتراضي ٣٠٠ والسقف ١٠٠٠)
  assert.deepEqual([SALES_LIMIT_DEFAULT, SALES_LIMIT_MAX], [300, 1000]);
  const svc = readBackend('services', 'salesInbox.ts');
  assert.match(svc, /LIST_DEFAULT = 300\b/);
  assert.match(svc, /LIST_MAX = 1000\b/);
});

// ───────────────────────────── الترجمة ─────────────────────────────

test('كل نصّ في النافذة والزرّ وأسماء القنوات والحالات مترجمٌ في PHRASES بلغاته الأربع', () => {
  const strings = read('i18n', 'strings.ts');
  const phrasesAt = strings.indexOf('export const PHRASES');
  assert.ok(phrasesAt > 0);
  const phrases = strings.slice(phrasesAt);
  const entryOf = (k: string) => {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = phrases.match(new RegExp(`^\\s*'${esc}'\\s*:\\s*\\{\\s*en:\\s*'((?:[^'\\\\]|\\\\.)*)',\\s*fr:\\s*'((?:[^'\\\\]|\\\\.)*)',\\s*tr:\\s*'((?:[^'\\\\]|\\\\.)*)',\\s*zh:\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*\\}`, 'm'));
    return m ? { en: m[1], fr: m[2], tr: m[3], zh: m[4] } : null;
  };

  const panel = read('components', 'SalesCrmPanel.tsx');
  const keys = new Set<string>([
    ...[...panel.matchAll(/\btr\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map((m) => m[1]),
    ...SALES_CHANNELS.map((c) => c.label),
    ...SALES_STAGES.map((s) => s.label),
    'إدارة المبيعات',
  ]);
  assert.ok(keys.size >= 30, `نصوص أقل من المتوقّع (${keys.size})`);
  const missing: string[] = [];
  const bad: string[] = [];
  for (const k of keys) {
    const e = entryOf(k);
    if (!e) { missing.push(k); continue; }
    for (const [lang, v] of Object.entries(e)) {
      if (!v.trim() || /[؀-ۿ]/.test(v)) bad.push(`${k} (${lang})`);
    }
  }
  assert.deepEqual(missing, [], `بلا ترجمة في PHRASES: ${missing.join(' | ')}`);
  assert.deepEqual(bad, [], `ترجمة فارغة أو عربية: ${bad.join(' | ')}`);

  // الفرنسية الجديدة بفاصلةٍ مطبعية (’) لا ASCII
  const block = phrases.slice(phrases.indexOf('// «إدارة المبيعات»'), phrases.indexOf("'طلب عرض سعر': {") + 200);
  assert.ok(block.length > 200, 'كتلة عبارات «إدارة المبيعات» غائبة');
  for (const m of block.matchAll(/fr:\s*'((?:[^'\\]|\\.)*)'/g)) assert.doesNotMatch(m[1], /\\'/, `فاصلة ASCII في الفرنسية: ${m[1]}`);
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}
