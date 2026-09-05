import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * حرّاس اكتمال اللغات.
 *
 * أُضيفت الصينية لغةً خامسة، ودرسُ إضافتها أنّ أغلب مواضع اللغة في هذا المستودع
 * **تسقط صامتةً**: سلسلة `lang === 'en' ? … : عربي` لا تُنتج خطأ تصريف حين تُغفل
 * لغةً، بل تعرض العربية لمستخدمٍ لا يقرؤها. الاختبارات أدناه تُحوّل أهمّ تلك
 * المواضع من صامتة إلى صاخبة.
 */

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
};

const LANGS = ['ar', 'en', 'fr', 'tr', 'zh'];

test('نوع Lang يحمل اللغات الخمس', () => {
  const s = read('src', 'i18n', 'lang.ts');
  for (const l of LANGS) assert.ok(s.includes(`'${l}'`), `اللغة ${l} غائبة عن lang.ts`);
  // قائمة السماح في التخزين المحلي: إغفالها يُسقط اختيار المستخدم صامتاً عند كل تحميل
  assert.match(s, /saved === 'zh'/, 'الصينية غائبة عن قائمة السماح في localStorage');
  // اشتقاق اللغة من المسار قبل إقلاع React
  assert.match(s, /p === '\/zh'/, 'المسار /zh لا يُشتقّ منه لغة');
});

test('كل بادئة لغة ثلاثة أحرف — basePath تعتمد slice(3)', () => {
  const s = read('src', 'i18n', 'locale.ts');
  const m = s.match(/const PREFIX[^=]*=\s*\{([^}]*)\}/);
  assert.ok(m, 'PREFIX غير موجودة');
  for (const [, p] of m[1].matchAll(/'(\/[a-z-]+)'/g)) {
    assert.equal(p.length, 3, `البادئة ${p} ليست ثلاثة أحرف فتكسر slice(3)`);
  }
  assert.match(s, /zh: '\/zh'/, 'بادئة الصينية مفقودة');
  // نسخة ثانية من الاشتقاق يستعملها LocaleSync — إغفالها يُرجع الصفحة للعربية بعد أول رسم
  assert.match(s, /pathname === '\/zh'/, 'localeFromPath لا تعرف /zh');
  assert.match(s, /hreflang: 'zh-Hans'/, 'بديل hreflang الصيني مفقود');
});

test('القاموسان يحملان الصينية لكل مدخل — بلا نصّ عربي متسرّب', () => {
  const s = read('src', 'i18n', 'strings.ts');
  const tr = (s.match(/\btr:\s*['"]/g) || []).length;
  const zh = (s.match(/\bzh:\s*['"]/g) || []).length;
  assert.equal(zh, tr, `عدد zh (${zh}) لا يطابق عدد tr (${tr}) — مدخل بلا ترجمة صينية`);
  assert.ok(tr > 900, `عدد المداخل ${tr} أقلّ من المتوقّع — هل قُصّ الملف؟`);
  // النوعان يجب أن يعلنا zh وإلا مرّت المداخل الناقصة بلا خطأ تصريف
  assert.match(s, /DICT: Record<string, \{[^}]*zh: string \}>/, 'نوع DICT بلا zh');
  assert.match(s, /PHRASES: Record<string, \{[^}]*zh: string \}>/, 'نوع PHRASES بلا zh');
});

test('مبدّل اللغة يعرض الخمس، والمسارات مسجَّلة', () => {
  const t = read('src', 'components', 'LanguageToggle.tsx');
  for (const l of LANGS) assert.ok(t.includes(`code: '${l}'`), `اللغة ${l} غائبة عن المبدّل`);
  const app = read('src', 'App.tsx');
  // /zh بلا مسارات = إعادة توجيه صامتة للرئيسية العربية عبر الالتقاط الشامل
  assert.match(app, /path="\/zh"/, 'مسار /zh غير مسجَّل');
  assert.match(app, /path="\/zh\/pricing"/, 'مسارات /zh الفرعية ناقصة');
});

test('تنسيق الأرقام والتواريخ يعرف الصينية', () => {
  const s = read('src', 'utils', 'format.ts');
  assert.match(s, /l === 'zh'/, 'الصينية تسقط إلى تنسيق عربي');
  assert.match(s, /'zh-CN'/, 'locale الصيني الصحيح مفقود');
});

test('خطّ المحارف الصينية مغطّى بلا تحميل شبكة', () => {
  const css = read('src', 'index.css');
  // بلا عائلة CJK تظهر الترجمة مربّعات فارغة على أجهزة لا تحمل خطّاً صينياً افتراضياً
  assert.ok(/PingFang SC|Noto Sans CJK|Microsoft YaHei/.test(css), 'قائمة الخطوط بلا عائلة CJK');
});

test('التصيير المسبق وخريطة الموقع يشملان الصينية بنفس رمز hreflang', () => {
  const pre = read('scripts', 'prerender.mjs');
  assert.match(pre, /zh: 'zh-Hans'/, 'رمز hreflang الصيني مفقود من المُصيِّر');
  assert.ok(pre.includes("'en', 'fr', 'tr', 'zh'"), 'الصينية خارج حلقة الرئيسيات المترجمة');
  const map = read('scripts', 'gen-sitemap.mjs');
  assert.match(map, /hreflang="zh-Hans"/, 'خريطة الموقع بلا بديل صيني');
  assert.ok(map.includes("'/zh' + suffix"), 'روابط /zh غائبة عن خريطة الموقع');
});
