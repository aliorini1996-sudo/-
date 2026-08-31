import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROFILE_DECK, DECK_COUNT, deckImg } from './profileDeck';

/**
 * حرّاس صفحة البروفايل: **الصور ونصوصها مصدرٌ واحد لا ينفصل**.
 *
 * الصفحة تعرض شرائح العرض مصدَّرةً من بوربوينت كما هي، ويرافقها نصُّ كل شريحة
 * مقروءاً للآلة (لقارئ الشاشة ولزاحف البحث). والخطر الوحيد في هذا التصميم أن
 * يُحدَّث أحدهما دون الآخر: صورةٌ جديدة بنصٍّ قديم تجعل الصفحة **تنطق غير ما
 * تُظهر** — وهو أسوأ من غياب النصّ، لأنه يكذب على قارئ الشاشة وعلى جوجل.
 */

const PUBLIC = path.join(process.cwd(), 'public');

test('لكل شريحة صورةٌ موجودة فعلاً على القرص', () => {
  assert.ok(DECK_COUNT > 0, 'لا شرائح');
  for (const s of PROFILE_DECK) {
    const p = path.join(PUBLIC, deckImg(s.n).replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `صورة الشريحة ${s.n} مفقودة: ${deckImg(s.n)}`);
    assert.ok(fs.statSync(p).size > 4096, `صورة الشريحة ${s.n} فارغة أو مقتطعة`);
  }
});

test('لا صورة زائدة بلا نصّ يرافقها', () => {
  const dir = path.join(PUBLIC, 'media', 'profile-deck');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.webp')).sort();
  assert.equal(files.length, DECK_COUNT,
    `عدد الصور (${files.length}) لا يساوي عدد الشرائح الموصوفة (${DECK_COUNT}) — أحدهما حُدّث دون الآخر`);
});

test('الترقيم متّصل من ١ بلا فجوة — وإلا ظهرت شريحة بلا سابقتها', () => {
  const ns = PROFILE_DECK.map(s => s.n);
  assert.deepEqual(ns, Array.from({ length: DECK_COUNT }, (_, i) => i + 1), 'ترقيم الشرائح مضطرب');
});

test('كل شريحة لها عنوان وسطر واحد على الأقل — بديل الصورة لا يكون فارغاً', () => {
  for (const s of PROFILE_DECK) {
    assert.ok(s.title.trim().length > 1, `الشريحة ${s.n} بلا عنوان`);
    assert.ok(s.lines.length > 0, `الشريحة ${s.n} بلا نصّ مرافق`);
    assert.equal(s.lines[0], s.title, `عنوان الشريحة ${s.n} لا يطابق أول سطورها`);
  }
});

/** محارف الاتجاه غير المرئية تُفسد النصّ الذي يتلوه قارئ الشاشة */
test('النصوص نظيفة من محارف الاتجاه ومن الفراغ المزدوج', () => {
  const BAD = /[‎‏؜⁦-⁩]/;
  for (const s of PROFILE_DECK) {
    for (const l of s.lines) {
      assert.doesNotMatch(l, BAD, `الشريحة ${s.n}: محرف اتجاه في «${l.slice(0, 30)}»`);
      assert.doesNotMatch(l, /\s{2,}/, `الشريحة ${s.n}: فراغ مزدوج في «${l.slice(0, 30)}»`);
      assert.equal(l, l.trim(), `الشريحة ${s.n}: فراغ على الأطراف`);
    }
  }
});

/** الملفّ القابل للتنزيل يجب أن يكون موجوداً — الزرّ يشير إليه في مكانين */
test('ملفّ البروفايل PDF موجود ومسارُه هو ما تشير إليه الصفحة', () => {
  const pdf = path.join(PUBLIC, 'fieldsales-profile.pdf');
  assert.ok(fs.existsSync(pdf), 'ملف البروفايل PDF مفقود من public');
  assert.ok(fs.statSync(pdf).size > 100_000, 'ملف البروفايل صغير بشكل مريب');
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ProfilePage.tsx'), 'utf8');
  assert.match(page, /const PROFILE_PDF = '\/fieldsales-profile\.pdf'/, 'مسار الملف في الصفحة تغيّر');
});

/**
 * الصفحة تعرض صوراً، فلو مُنع التكبير لبقي نصّ الشريحة على الجوال أصغر من أن
 * يُقرأ بلا مخرج. والرخصة يجب أن تُعاد عند المغادرة فلا تتسرّب للتطبيق.
 */
test('صفحة البروفايل تسمح بالتكبير وتعيد الإعداد عند المغادرة', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ProfilePage.tsx'), 'utf8');
  assert.match(page, /user-scalable=yes/, 'التكبير ممنوع — نصّ الشريحة غير مقروء على الجوال');
  assert.match(page, /if \(before !== null\) tag\.setAttribute\('content', before\)/,
    'لا يُعاد إعداد العرض عند المغادرة — الرخصة تتسرّب لبقية التطبيق');
});

test('الشرائح تُحمَّل كسولاً عدا الأولى — أحد عشر صورة دفعةً تُثقل أول رسم', () => {
  const page = fs.readFileSync(path.join(process.cwd(), 'src', 'pages', 'ProfilePage.tsx'), 'utf8');
  assert.match(page, /loading=\{s\.n === 1 \? 'eager' : 'lazy'\}/, 'التحميل الكسول غائب');
  assert.match(page, /aspectRatio: '16 \/ 9'/, 'نسبة الشريحة غير مثبَّتة — تنزلق الصفحة عند التحميل');
});
