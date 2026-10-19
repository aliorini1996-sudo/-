import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * حرّاس صفحة تفعيل حساب الشركة (/activate) — قراءةٌ نصّية لا DOM في node.
 *
 * الرمز في وسم الرابط مفتاحُ حسابٍ كامل حتى يُستهلك: يُمحى من الشريط قبل أي طلب، ولا يُخزَّن
 * في المتصفّح، والصفحة صفحة الشركة لا بوابة السفير — فلا تستورد منها ولا تربط إليها.
 */
const src = readFileSync(new URL('./ActivatePage.tsx', import.meta.url), 'utf8');
/** بلا تعليقات — كي لا يمرّ حارسٌ أو يفشل بكلمةٍ في شرح */
const code = src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

test('الرمز من وسم الرابط (#t=) ثم يُمحى من الشريط قبل أي طلب', () => {
  assert.match(code, /window\.location\.hash/, 'الصفحة لا تقرأ الرمز من الوسم');
  const replaceAt = code.indexOf('history.replaceState(');
  const previewAt = code.indexOf('authApi.activationPreview(');
  assert.ok(replaceAt > 0, 'لا history.replaceState — الرمز يبقى في الشريط والسجلّ');
  assert.ok(previewAt > 0, 'لا استدعاء لـ authApi.activationPreview');
  assert.ok(replaceAt < previewAt, 'المحو يجب أن يسبق أول طلب');
  assert.match(code, /history\.replaceState\([^)]*'\/activate'\)/, 'الشريط لا يعود إلى /activate نظيفاً');
  // الرمز في الذاكرة وحدها
  assert.match(code, /const tokenRef = useRef<string \| null>\(null\);/);
});

test('لا تخزين للرمز في المتصفّح', () => {
  assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie/, 'الرمز أو الجلسة تُكتب مباشرةً في التخزين');
});

test('صفحة الشركة لا البوابة: لا استيراد من affiliate ولا رابط إلى /ax', () => {
  assert.doesNotMatch(code, /from ['"]\.\.\/affiliate\//, 'استيرادٌ من بوابة السفير');
  assert.doesNotMatch(code, /['"`]\/ax(?![A-Za-z0-9_-])/, 'رابطٌ إلى بوابة السفير');
  assert.doesNotMatch(code, /fieldsa\.net\/ax/);
});

test('التفعيل يدخل الشركة لوحتها بجلستها — بلا تحويل إعلاني', () => {
  assert.match(code, /authApi\.activate\(\{ token, password, acceptTerms: true/, 'لا استدعاء لـ authApi.activate بكلمة المرور والموافقة');
  assert.match(code, /import \{ useAuthStore \} from '\.\.\/store\/authStore'/);
  assert.match(code, /const login = useAuthStore\(\(s\) => s\.login\);/);
  assert.match(code, /login\(session\.token, session\.user\);/, 'لا دخول بالجلسة المُعادة');
  assert.match(code, /window\.location\.replace\('\/app'\)/);
  assert.doesNotMatch(code, /trackSignup|lib\/ads/, 'تحويلٌ إعلاني على صفحة تفعيلٍ فتحها سفير');
});

test('حالات الرابط الأربع، وروابط الشروط في لسانٍ جديد كي لا يضيع الرمز', () => {
  for (const k of ['activate.invalidTitle', 'activate.supersededTitle', 'activate.activeTitle', 'activate.title']) {
    assert.ok(code.includes(`t('${k}')`), `${k} غير معروض`);
  }
  assert.match(code, /<Link to="\/login"/, 'المفعَّل مسبقاً بلا طريقٍ إلى الدخول');
  assert.match(code, /href="\/terms\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(code, /href="\/privacy\/" target="_blank" rel="noopener noreferrer"/);
});

test('كل مفتاح activate.* معروضٍ موجودٌ في القاموس بخمس لغات — والفرنسية بلا فواصل علوية', () => {
  const dict = readFileSync(new URL('../i18n/strings.ts', import.meta.url), 'utf8');
  const used = [...new Set([...code.matchAll(/\bt\('((?:activate|signup)\.[\w.]+)'\)/g)].map((m) => m[1]))];
  assert.ok(used.length > 20, `مفاتيح قليلة على نحوٍ مريب (${used.length})`);
  for (const k of used) {
    const line = dict.split('\n').find((l) => l.trimStart().startsWith(`'${k}': {`));
    assert.ok(line, `المفتاح ${k} غائب عن i18n/strings.ts`);
    for (const l of ['ar', 'en', 'fr', 'tr', 'zh']) assert.match(line!, new RegExp(`\\b${l}: '[^']+'`), `${k}.${l} غائب أو فارغ`);
    if (k.startsWith('activate.')) {
      const fr = line!.match(/\bfr: '([^']*)'/)![1];
      assert.doesNotMatch(fr, /[’']/, `${k}.fr فيه فاصلة علوية`);
      for (const l of ['en', 'fr', 'tr', 'zh']) {
        const v = line!.match(new RegExp(`\\b${l}: '([^']*)'`))![1];
        assert.doesNotMatch(v, /[؀-ۿ]/, `${k}.${l} فيه نصّ عربي`);
      }
    }
  }
});

test('الجوال تكتبه الشركة كاملاً ويُرسل دائماً — لا «إبقاء» صامت لرقمٍ مُقنَّع كتبه السفير', () => {
  assert.match(code, /authApi\.activate\(\{ token, password, acceptTerms: true, phone: companyPhone \}\)/);
  assert.ok(code.includes("companyPhone = local ? `${dial}${local}` : '';"), 'المحلّيّ الفارغ لا يصير مفتاح الدولة وحده');
  assert.ok(code.includes("if (companyPhone.replace(/\\D/g, '').length < 8) { toast.error(t('activate.phoneInvalid')); return; }"), 'الجوال الفارغ أو القصير يُرفض قبل الإرسال');
  assert.doesNotMatch(code, /changePhone|activate\.phoneKeep|activate\.phoneChange/, 'عاد خيار الإبقاء');
  assert.ok(code.includes("t('activate.phoneTypedBy')"), 'المُقنَّع تلميحٌ لا قيمةٌ تُعتمد');
});

test('بلا رمز (إعادة تحميلٍ بعد المحو) ليس «رابطاً منتهياً»، ورابطٌ أحدث في اللسان نفسه يُلتقط ويُمحى', () => {
  assert.match(code, /if \(!token\) \{ setView\(\{ kind: 'noToken' \}\); return; \}/);
  for (const k of ['activate.noTokenTitle', 'activate.noTokenBody']) assert.ok(code.includes(`t('${k}')`), `${k} غير معروض`);
  const hashAt = code.indexOf("window.addEventListener('hashchange', onHash);");
  assert.ok(hashAt > 0, 'لا مستمع لتغيّر الوسم');
  const onHash = code.slice(code.indexOf('const onHash = () => {'), hashAt);
  assert.ok(onHash.indexOf('history.replaceState(') < onHash.indexOf('setAttempt('), 'المحو قبل الفحص');
  assert.match(onHash, /tokenRef\.current = fresh;/);
  assert.match(code, /window\.removeEventListener\('hashchange', onHash\)/);
  // رابطٌ أوقفه الخادم بعد تكرار «الرقم مربوط» له حالته — لا «غير صالح» ولا «أُرسل أحدث»
  assert.match(code, /if \(e\.code === 'link_locked' \|\| e\.state === 'locked'\) return 'locked';/);
  assert.match(code, /else if \(d\.state === 'locked'\) setView\(\{ kind: 'locked' \}\);/);
  for (const k of ['activate.lockedTitle', 'activate.lockedBody']) assert.ok(code.includes(`t('${k}')`), `${k} غير معروض`);
});

test('ردّ إرسالٍ لرابطٍ قديم لا يمسّ الصفحة بعد لصق رابطٍ أحدث، والمفتاح المُلصق لا يُضاعَف', () => {
  const submit = code.slice(code.indexOf('const submit = async'), code.indexOf('const dialOption'));
  const guards = submit.split('if (tokenRef.current !== token) return;').length - 1;
  assert.equal(guards, 2, 'بعد النجاح وفي الخطأ');
  assert.ok(submit.indexOf('if (tokenRef.current !== token) return;') < submit.indexOf('login(session.token'), 'قبل الدخول');
  // الدوليّ المُلصق يُرسل كما هو، والمفتاح المكرَّر يُنزع لمفاتيح الثلاثة أرقام وحدها (‎+91 ‎+39 ‎+7 يقصّ أرقاماً صحيحة)
  assert.match(submit, /if \(typed\.startsWith\('\+'\) \|\| typed\.startsWith\('00'\)\) \{/);
  assert.match(submit, /if \(dialDigits\.length >= 3 && local\.startsWith\(dialDigits\) && local\.length > dialDigits\.length \+ 6\) local = local\.slice\(dialDigits\.length\);/);
  assert.match(code, /onChange=\{\(e\) => setPhone\(keepPhoneChars\(latinDigits\(e\.target\.value\)\)\)\}/, 'الحقل يُبقي «+» الأولى');
});
