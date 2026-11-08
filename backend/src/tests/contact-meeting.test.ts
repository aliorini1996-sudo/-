// «احجز اجتماع» (طلب المالك ٨ نوفمبر ٢٠٢٦) — POST /api/contact/meeting: الاسم والجوال الدولي فقط.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meetingSchema } from '../routes/contact';
import { pageLangLabel } from '../lib/pageLang';

test('المخطط: الاسم والجوال الدولي E.164 من أي دولة، والدولة رمز ISO اختياري', () => {
  for (const ok of [
    { name: 'علي', phone: '+966512345678' },
    { name: 'John', phone: '+14155550100', country: 'US', lang: 'en' },
    { name: 'Niue', phone: '+6834002', country: 'NU' },
    { name: 'Max', phone: '+491701234567890' },
  ]) assert.ok(meetingSchema.safeParse(ok).success, JSON.stringify(ok));
  for (const bad of [
    { name: '', phone: '+966512345678' },
    { name: 'a', phone: '0512345678' },
    { name: 'a', phone: '+0512345678' },
    { name: 'a', phone: '+96651234567890123' },
    { name: 'a', phone: '+966 51 234' },
    { name: 'a', phone: '+966512345678', country: 'sa' },
    { name: 'x'.repeat(121), phone: '+966512345678' },
  ]) assert.equal(meetingSchema.safeParse(bad).success, false, JSON.stringify(bad));
});

// البند 16 من خطة GEO العالمية: صفحة بلغة جديدة لا تُرفض بـ400 فيضيع العميل.
test('لغة الصفحة: أي وسم BCP-47 قصير صحيح مقبول، لا القائمة الخماسية وحدها', () => {
  const base = { name: 'Ana', phone: '+5511912345678' };
  for (const lang of ['ar', 'en', 'fr', 'tr', 'zh', 'es', 'de', 'pt-BR', 'zh-Hant', 'es-419', 'sr-Latn-RS', 'fil', 'EN', ' es ']) {
    const r = meetingSchema.safeParse({ ...base, lang });
    assert.ok(r.success, `يجب أن تُقبل ${JSON.stringify(lang)}`);
  }
  assert.equal(meetingSchema.parse({ ...base, lang: ' pt-BR ' }).lang, 'pt-BR', 'الفراغات حول الوسم تُقصّ');
});

test('لغة الصفحة: القيمة المشوّهة تُرفض', () => {
  const base = { name: 'Ana', phone: '+5511912345678' };
  for (const lang of [
    '', 'e', 'english', 'pt_BR', 'en-', '-en', 'en--US', 'en-x-private', 'zh-Hant-TW-abcdefghi',
    'en US', '<b>', 'ar"><script>', 'عربي', `en-${'abcdefgh-'.repeat(4)}ab`, 5, null,
  ]) {
    assert.equal(meetingSchema.safeParse({ ...base, lang }).success, false, `يجب أن تُرفض ${JSON.stringify(lang)}`);
  }
});

test('اسم لغة الصفحة في بريد الإدارة لا ينهار مع أي وسم مقبول', () => {
  assert.equal(pageLangLabel('es'), 'الإسبانية (es)');
  assert.match(pageLangLabel('pt-BR'), /البرتغالية.*\(pt-BR\)$/);
  assert.match(pageLangLabel('zh-Hant'), /الصينية.*\(zh-Hant\)$/);
  // وسم لا يعرفه ICU يُعرض كما هو، والذي يرفضه ICU (منطقة برقمين) كذلك، بلا استثناء
  assert.equal(pageLangLabel('qqq'), 'qqq');
  assert.equal(pageLangLabel('en-12'), 'en-12');
});
