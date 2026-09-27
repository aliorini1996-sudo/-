// حلقة التعلّم — تفويض دليل البيع (النفي، وكل عبارة «مجاني») وحدود الكلمات اللاتينية في تصنيف النيّة
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, normalizeAr, playbookAuthorizes } from '../ai-rep/learn/signals';

test('النفي في الدليل ليس تفويضاً', () => {
  assert.equal(playbookAuthorizes('اجل', 'لا نبيع بالآجل؛ البيع نقداً فقط'), false);
  assert.equal(playbookAuthorizes('اجل', 'البيع بالآجل غير متاح حالياً، ولا نقبل تأجيل الدفع'), false);
  assert.equal(playbookAuthorizes('ضمان', 'لا نقدّم أي ضمان على المنتجات'), false);
  assert.equal(playbookAuthorizes('ضمان', 'بدون ضمان استرجاع'), false);
  // المثبت يفوّض — ولو وُجد نفيٌ في جملة أخرى
  assert.equal(playbookAuthorizes('اجل', 'البيع بالآجل متاح للعملاء المنتظمين'), true);
  assert.equal(playbookAuthorizes('اجل', 'لا نبيع بالخصم. البيع بالآجل متاح للعملاء المنتظمين'), true);
  assert.equal(playbookAuthorizes('ضمان', 'نقدّم ضمان استرجاع خلال أسبوع'), true);
  assert.equal(playbookAuthorizes('خصم', 'نقدّم خصم للطلبات الأولى'), true);
  assert.equal(playbookAuthorizes('خصم', 'لا خصم على الأسعار المعلنة'), false);
});

test('كل عبارة «… مجاني» في الدرس يلزمها تفويضها', () => {
  const lesson = normalizeAr('أخبر صاحب المحل أن التوصيل مجاني وأن العينة مجانية مع أول طلب');
  assert.equal(playbookAuthorizes('مجان', 'التوصيل مجاني داخل المدينة', lesson), false, 'العينة المجانية غير مفوّضة');
  assert.equal(playbookAuthorizes('مجان', 'التوصيل مجاني والعينة مجانية للعملاء الجدد', lesson), true);
  assert.equal(playbookAuthorizes('مجان', 'التوصيل ليس مجاني والعينة مجانية', lesson), false, 'التوصيل منفيّ');
});

test('الكلمات اللاتينية بحدّ كلمة (لا تطابق داخل كلمة أخرى)', () => {
  assert.equal(classifyIntent('Où dois-je chercher de nouveaux magasins ?'), 'OTHER');
  assert.equal(classifyIntent('What should I offer the butcher?'), 'WHAT_OFFER');
  assert.equal(classifyIntent('Can I give him a voucher?'), 'OTHER');
  assert.equal(classifyIntent('How is the product rotation?'), 'PRODUCT');
  assert.equal(classifyIntent('C’est trop cher pour lui'), 'OBJ_PRICE');
  assert.equal(classifyIntent('He says the price is high'), 'OBJ_PRICE');
  assert.equal(classifyIntent('Plan my route please'), 'ROUTE');
  assert.equal(classifyIntent('What have you learned from our team’s visits?'), 'TEAM_EXPERIENCE');
  assert.equal(classifyIntent('وش أعرض على أقرب فرصة جديدة؟'), 'WHAT_OFFER');
});
