import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adoptVerdict, shouldAdopt, jwtExpMs, AdoptInput } from './sessionAdoption';

/**
 * حرّاس حلقة الإقلاع التي أبلغ عنها أكثر من عميل.
 *
 * العَرَض: بعد الدخول تعلق الرئيسية على «جاري التحميل»، ثمّ شاشة الشعار ثمّ
 * الرئيسية ثمّ الشعار… كلّ ثانيةٍ تقريباً، **بلا رسالة خطأ واحدة**.
 * السبب: ٤٠١ يمحو توكن التطبيق ويُعيد تحميل `/m`، والإقلاع يتبنّى توكن اللوحة
 * الميّت نفسه فيعود ٤٠١… والرسائل تموت كلّها مع الصفحة التي أطلقتها.
 */

const NOW = 1_760_000_000_000; // لحظة ثابتة — لا ساعة حقيقية في الاختبار

/** توكن بصيغة JWT بلا توقيع صحيح — المهمّ حمولته */
function tok(payload: Record<string, unknown>, salt = ''): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig${salt}`;
}

const ALIVE = tok({ id: 'a1', exp: Math.floor(NOW / 1000) + 3600 });
const DEAD = tok({ id: 'a1', exp: Math.floor(NOW / 1000) - 3600 });
const ADMIN_USER = JSON.stringify({ id: 'a1', name: 'مدير', role: 'ADMIN' });

const base: AdoptInput = {
  path: '/m',
  mToken: null,
  dashToken: ALIVE,
  dashUserRaw: ADMIN_USER,
  signedOut: null,
  rejected: null,
  nowMs: NOW,
};

const at = (over: Partial<AdoptInput>): AdoptInput => ({ ...base, ...over });

test('قراءة انتهاء التوكن: حيّ وميّت وتالف', () => {
  assert.equal(jwtExpMs(ALIVE), (Math.floor(NOW / 1000) + 3600) * 1000);
  assert.equal(jwtExpMs(DEAD), (Math.floor(NOW / 1000) - 3600) * 1000);
  assert.equal(jwtExpMs('لا شيء'), null, 'نصٌّ ليس توكناً');
  assert.equal(jwtExpMs(''), null);
  assert.equal(jwtExpMs(tok({ id: 'a1' })), null, 'حمولة بلا exp');
});

test('الميزة تبقى حيّة: جلسة لوحةٍ صحيحة تُتبنّى', () => {
  assert.equal(adoptVerdict(base), 'adopt');
  assert.equal(adoptVerdict(at({ path: '/m/' })), 'adopt', 'الشرطة الأخيرة لا تُغيّر شيئاً');
});

test('لا تبنّي خارج مسار التطبيق ولا فوق جلسةٍ قائمة ولا بعد خروجٍ صريح', () => {
  assert.equal(adoptVerdict(at({ path: '/login' })), 'not-app-path');
  assert.equal(adoptVerdict(at({ path: '/media/m/x' })), 'not-app-path');
  assert.equal(adoptVerdict(at({ mToken: ALIVE })), 'already-has-session');
  assert.equal(adoptVerdict(at({ signedOut: '1' })), 'signed-out');
});

test('لا تبنّي بلا جلسة لوحة، ولا لجلسة مالك المنصّة', () => {
  assert.equal(adoptVerdict(at({ dashToken: null })), 'no-dashboard-session');
  assert.equal(adoptVerdict(at({ dashUserRaw: null })), 'no-dashboard-session');
  assert.equal(adoptVerdict(at({ dashUserRaw: '{{ تالف' })), 'no-dashboard-session', 'نصٌّ لا يُحلَّل');
  assert.equal(adoptVerdict(at({ dashUserRaw: JSON.stringify({ role: 'SUPER_ADMIN' }) })), 'owner-session');
});

/* ═══ قاطعا الحلقة ═══ */

test('التوكن الذي ردّه الخادم لا يُجرَّب ثانيةً — وهذا ما يكسر الدوران', () => {
  assert.equal(adoptVerdict(at({ rejected: ALIVE })), 'rejected-before');
  // ووسمٌ لتوكنٍ آخر لا يمنع شيئاً: الرفض للتوكن بعينه لا للتبنّي
  assert.equal(adoptVerdict(at({ rejected: tok({ id: 'a1', exp: 9 }, 'x') })), 'adopt');
});

test('التوكن المنتهي لا يُتبنّى أصلاً — فلا ومضة ٤٠١ ولا إعادة تحميل', () => {
  assert.equal(adoptVerdict(at({ dashToken: DEAD })), 'expired');
  // وعلى حدّ اللحظة بالضبط: منتهٍ
  const edge = tok({ id: 'a1', exp: Math.floor(NOW / 1000) });
  assert.equal(adoptVerdict(at({ dashToken: edge })), 'expired');
});

test('توكنٌ لا تُقرأ مدّته يُجرَّب مرّةً ثمّ يُوسَم — لا يُرفض ابتداءً', () => {
  /* الرفض ابتداءً يقتل الميزة لكل توكنٍ بصيغةٍ غير متوقّعة. والتجربة الواحدة
   * ثمنُها ٤٠١ واحد يلتقطه الوسم، لا حلقة. */
  const opaque = 'abc.def.ghi';
  assert.equal(adoptVerdict(at({ dashToken: opaque })), 'adopt');
  assert.equal(adoptVerdict(at({ dashToken: opaque, rejected: opaque })), 'rejected-before');
});

test('الحلقة المُبلَّغ عنها لا تقوم: محاكاة الدورة كاملةً', () => {
  /* هذه هي الرواية حرفاً: توكن اللوحة انتهى بعد ثماني ساعات، والتطبيق متبنٍّ
   * نسخةً منه. نمثّل ما يفعله الكود عند كل ٤٠١ ثمّ إقلاع، ونعدّ الدورات. */
  const store: Record<string, string> = { token: DEAD, user: ADMIN_USER, m_token: DEAD, m_user: ADMIN_USER };

  let boots = 0;
  for (let i = 0; i < 10; i++) {
    boots++;
    // إقلاع: هل يُتبنّى؟
    if (shouldAdopt({
      path: '/m', mToken: store.m_token ?? null, dashToken: store.token ?? null,
      dashUserRaw: store.user ?? null, signedOut: store.m_signed_out ?? null,
      rejected: store.m_rejected ?? null, nowMs: NOW,
    })) {
      store.m_token = store.token;
      store.m_user = store.user;
    }
    if (!store.m_token) break;           // شاشة دخولٍ ساكنة — لا طلب ولا دوران
    // طلبٌ بتوكنٍ ميّت ⇒ ٤٠١ ⇒ sessionExpired: محوٌ ووسم
    const dead = store.m_token;
    delete store.m_token; delete store.m_user;
    store.m_rejected = dead;
  }

  assert.equal(boots, 2, `الحلقة دارت ${boots} مرّة — القاطع لا يعمل`);
  assert.equal(store.m_token, undefined, 'يجب أن ينتهي إلى شاشة دخولٍ ساكنة');
  assert.equal(store.m_rejected, DEAD, 'التوكن الميّت يجب أن يبقى موسوماً');
});

test('ودخولٌ جديد بعد الحلقة يُنظّف الوسم فيعود التبنّي', () => {
  const fresh = tok({ id: 'a1', exp: Math.floor(NOW / 1000) + 7200 }, 'new');
  // بعد دخولٍ ناجح: الوسم يُمسح (كما يفعل `login` في المتجر)
  assert.equal(adoptVerdict(at({ dashToken: fresh, rejected: null })), 'adopt');
});

/* ═══ الوصل بالمكوّنات ═══ */

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');

test('المتجر يستعمل القاعدة ولا ينسخها، ويمسح الوسم عند الدخول', () => {
  const s = read('src', 'store', 'authStore.ts');
  assert.match(s, /shouldAdopt\(\{/, 'التبنّي لا ينادي القاعدة');
  assert.doesNotMatch(s, /role\?: string \}\)\?\.role === 'SUPER_ADMIN'\) return;/,
    'نسخةٌ ثانية من الشرط بقيت في المتجر');
  assert.match(s, /localStorage\.removeItem\(REJECTED_KEY\)/, 'الدخول لا يمسح وسم الرفض فيبقى التبنّي ميّتاً');
  assert.match(s, /sessionExpired: \(\) =>/, 'فعل انتهاء الجلسة مفقود');
  // وانتهاءُ الجلسة لا يرفع علامة الخروج الصريح — وإلّا ماتت الميزة لكل الناس
  // بالقوس المفتوح: `sessionExpired: () => void;` في الواجهة يسبق التنفيذ
  const i = s.indexOf('sessionExpired: () => {');
  const body = s.slice(i, s.indexOf('\n  },', i));
  assert.doesNotMatch(body, /setItem\(SIGNED_OUT/, 'انتهاء الجلسة ليس خروجاً صريحاً');
  assert.match(body, /setItem\(REJECTED_KEY, dead\)/, 'التوكن المرفوض يجب أن يُوسَم');
});

test('المعترِض لا يُعيد التحميل إلى المسار الذي يقف عليه', () => {
  /* هذه الحركة بعينها هي التي ركبتها الحلقة: `/m` وجهةُ التطبيق وهي مساره،
   * فالانتقال إليها إقلاعٌ كامل. */
  const s = read('src', 'api', 'client.ts');
  assert.match(s, /useAuthStore\.getState\(\)\.sessionExpired\(\)/, 'المعترِض لا يستعمل فعل انتهاء الجلسة');
  assert.match(s, /if \(!samePath\(window\.location\.pathname, loginPath\)\) window\.location\.href = loginPath;/,
    'الانتقال يجب أن يكون مشروطاً باختلاف المسار');
  assert.match(s, /const samePath =/, 'مقارنة المسارين مفقودة');
});
