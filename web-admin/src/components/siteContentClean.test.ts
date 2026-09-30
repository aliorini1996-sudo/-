import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPlain, cleanContent } from '../lib/siteContentClean';

/**
 * زرّ «تنظيف النصوص» في محرّر محتوى الموقع (قرار المالك ٣٠ سبتمبر ٢٠٢٦: يبقى مقصوراً على النص العادي).
 */

test('cleanPlain: يحمي الروابط والوسوم وMarkdown ولا يلصق الكلمة بما قبلها', () => {
  assert.equal(cleanPlain('جربه على fieldsa.net، ثم سجّل'), 'جربه على fieldsa.net ثم سجل', 'الكلمة التصقت بالنطاق');
  assert.equal(cleanPlain('اقرأ [الدليل](/blog/x)، وبعدها ابدأ'), 'اقرأ [الدليل](/blog/x) وبعدها ابدأ');
  assert.equal(cleanPlain('<b>مهم</b>، جداً.'), '<b>مهم</b> جدا');
  assert.equal(cleanPlain('صورة ![شعار](/img/a.png) هنا.'), 'صورة ![شعار](/img/a.png) هنا');
  assert.equal(cleanPlain('زر https://fieldsa.net/pricing، الآن'), 'زر https://fieldsa.net/pricing الآن');
});

test('cleanContent: الروابط والصور والكلمات المفتاحية والبريد تبقى، والنثر يُنظَّف ويُعدّ', () => {
  const draft = {
    heroImage: 'data:image/png;base64,AAAA',
    hero: { title: 'مرحباً، بكم.', ctaUrl: '/signup', phone: '+966 (55) 000-0000' },
    seo: { keywords: 'فواتير، تحصيل، مخزون' },
    contact: { email: 'help@fieldsa.net', site: 'fieldsa.net' },
    blog: [{ slug: 'my-post', body: 'اقرأ [هنا](/x)، ثم ابدأ.' }],
  };
  const { value, changed } = cleanContent(draft);
  assert.equal(value.heroImage, draft.heroImage);
  assert.equal(value.hero.ctaUrl, '/signup');
  assert.equal(value.hero.phone, draft.hero.phone, 'رقم الهاتف فقد أقواسه');
  assert.equal(value.seo.keywords, draft.seo.keywords, 'الكلمات المفتاحية فقدت فواصلها');
  assert.equal(value.contact.email, draft.contact.email);
  assert.equal(value.contact.site, 'fieldsa.net');
  assert.equal(value.blog[0].slug, 'my-post');
  assert.equal(value.hero.title, 'مرحبا بكم');
  assert.equal(value.blog[0].body, 'اقرأ [هنا](/x) ثم ابدأ');
  assert.equal(changed, 2);
});
