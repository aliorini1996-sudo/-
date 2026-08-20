import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttribution, contentTypeOf, refFromPath, makeWaCode } from '../services/attribution';

test('محرك ذكاء توليدي يصنف ai_generative ويعرف اسمه', () => {
  const r = resolveAttribution({ referrerHost: 'chatgpt.com', path: '/' });
  assert.equal(r.channel, 'ai_generative');
  assert.equal(r.aiEngine, 'chatgpt');
});

test('نطاق فرعي لمحرك الذكاء يلتقط أيضا', () => {
  const r = resolveAttribution({ referrerHost: 'www.perplexity.ai', path: '/' });
  assert.equal(r.aiEngine, 'perplexity');
  assert.equal(r.channel, 'ai_generative');
});

test('بحث جوجل ⇒ organic، وبلا محيل ⇒ direct', () => {
  assert.equal(resolveAttribution({ referrerHost: 'www.google.com' }).channel, 'organic');
  assert.equal(resolveAttribution({ referrerHost: null }).channel, 'direct');
});

test('قيمة UTM خارج القاموس تطبع إلى other لا ترفض الزيارة', () => {
  const r = resolveAttribution({ utm: { source: 'مصدر-غريب', medium: 'شيء' } });
  assert.equal(r.utmSource, 'other');
  assert.equal(r.utmMedium, 'other');
});

test('قيمة UTM معروفة تحفظ كما هي بحروف صغيرة', () => {
  const r = resolveAttribution({ utm: { source: 'SourceForge', medium: 'Directory' } });
  assert.equal(r.utmSource, 'sourceforge');
  assert.equal(r.utmMedium, 'directory');
});

test('ai_answer كوسم صريح يصنف ai_generative', () => {
  assert.equal(resolveAttribution({ utm: { medium: 'ai_answer' } }).channel, 'ai_generative');
});

test('غياب الوسوم لا يخترع قيما', () => {
  const r = resolveAttribution({});
  assert.equal(r.utmSource, null);
  assert.equal(r.utmCampaign, null);
});

test('نوع المحتوى يشتق من المسار', () => {
  assert.equal(contentTypeOf('/'), 'landing');
  assert.equal(contentTypeOf('/en/'), 'landing');
  assert.equal(contentTypeOf('/blog/x/'), 'blog');
  assert.equal(contentTypeOf('/en/blog/x/'), 'blog');
  assert.equal(contentTypeOf('/invoice-generator/'), 'tool');
  assert.equal(contentTypeOf('/pricing/'), 'pricing');
  assert.equal(contentTypeOf(null), null);
});

test('ref يشتق من المسار آليا ولا يتضارب بين الصفحات', () => {
  assert.equal(refFromPath('/'), 'home');
  assert.equal(refFromPath('/pricing/'), 'pricing');
  assert.equal(refFromPath('/blog/van-sales/'), 'blog-van-sales');
  assert.notEqual(refFromPath('/pricing/'), refFromPath('/blog/x/'));
});

test('رمز واتساب ٨ محارف بلا أحرف ملتبسة', () => {
  const c = makeWaCode('seed');
  assert.equal(c.length, 8);
  assert.match(c, /^[2-9A-HJ-NP-Z]+$/); // لا 0/O/1/I
});

test('رموز واتساب متنوعة فعلا — الخلل السابق أنتج D2222222', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 500; i++) codes.add(makeWaCode('seed' + i));
  // تكرار الرمز يعني محادثات لا تنسب لزياراتها ⇒ انهيار الإسناد بصمت
  assert.ok(codes.size >= 495, `تنوع ضعيف: ${codes.size}/500 فريد`);
  // ولا رمز من محرف واحد مكرر
  for (const c of [...codes].slice(0, 50)) {
    assert.ok(new Set(c.split('')).size >= 3, `رمز ضعيف: ${c}`);
  }
});
