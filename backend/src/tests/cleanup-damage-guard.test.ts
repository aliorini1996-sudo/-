import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseCoords } from '../services/geoLink';

/**
 * حارس ضرر «تنظيف النصوص» (مراجعة ٣٠ سبتمبر ٢٠٢٦). التزاما a0f52aa وaa0c3be أزالا الترقيم آلياً من النصوص فأتلفا
 * شيفرةً تسكن داخل سلاسل: محارف تحكّم مكان أرقام CSS، والنطاق بلا نقطته، وتعبير الإحداثيات. قرار المالك:
 * الأسلوب في النصوص يبقى، والضرر التقني يُسترجع — وهذا الحارس يمنع عودته من أي منظّفٍ لاحق.
 */

const ROOT = path.resolve(process.cwd(), '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f, out); continue; }
    if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(f);
  }
  return out;
}
const files = [...walk(path.join(ROOT, 'backend', 'src')), ...walk(path.join(ROOT, 'web-admin', 'src'))]
  // compliance/zatca للقراءة فقط بقرارٍ سابق — ما فيه من أثرٍ يُعالَج هناك
  .filter(f => !f.split(path.sep).join('/').includes('backend/src/compliance/zatca/'));

test('لا محرف تحكّم في الشيفرة (كان المنظّف يضعها مكان أرقام CSS فيبطل التنسيق)', () => {
  const bad = files.filter(f => /[\x01-\x08\x0B\x0C\x0E-\x1F]/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(f => path.relative(ROOT, f)), []);
});

test('النطاق يُكتب بنقطته في كل نصٍّ يصل العملاء، لا اسمه بمسافة', () => {
  // تُبنى من جزأين كي لا يطابق الحارسُ نفسه
  const broken = [['fieldsa', 'net'], ['heygen', 'com'], ['hunter', 'io']].map(([a, b]) => new RegExp(`\\b${a} ${b}\\b`, 'i'));
  const bad = files.filter(f => { const s = fs.readFileSync(f, 'utf8'); return broken.some(re => re.test(s)); });
  assert.deepEqual(bad.map(f => path.relative(ROOT, f)), []);
});

test('لا كلمة ملتصقة بمتغيّر أو بوسم مغلق (حذف «: » أو «، » بينهما)', () => {
  const glued = /\$\{[^}]+\}[ء-ي]{2,}|<\/(b|strong|a|code|span|em)>[ء-ي]{2,}/;
  const bad = files.filter(f => !/\.test\.tsx?$/.test(f) && glued.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(bad.map(f => path.relative(ROOT, f)), []);
});

test('قوالب البريد وتنسيق المدوّنة: CSS بنقطتيه، ومحدّد المقال بنقطته', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
  for (const f of [['backend', 'src', 'routes', 'auth.ts'], ['backend', 'src', 'services', 'marketingTemplate.ts'], ['backend', 'src', 'routes', 'leadsCron.ts'], ['backend', 'src', 'services', 'opsSchedule.ts']]) {
    const s = read(...f);
    const noColon = [...s.matchAll(/style="([^"]*)"/g)].map(m => m[1]).filter(v => !v.includes(':'));
    assert.deepEqual(noColon, [], `${f.join('/')}: style بلا نقطتين`);
  }
  assert.match(read('backend', 'src', 'routes', 'auth.ts'), /style="background:#E15A30;color:#fff;/, 'زرّ تأكيد البريد');
  assert.match(read('backend', 'src', 'routes', 'leadsCron.ts'), /<!doctype html>/);
  // وسم السجلّ [mail] يُبحث به في سجلات Render
  const mailLogs = [...read('backend', 'src', 'services', 'mailer.ts').matchAll(/console\.\w+\('([^']*)'/g)].map(m => m[1]);
  assert.ok(mailLogs.length >= 4 && mailLogs.every(m => m.startsWith('[mail] ')), `mailer.ts: ${JSON.stringify(mailLogs)}`);
  const blog = read('web-admin', 'src', 'pages', 'BlogPostPage.tsx');
  assert.match(blog, /\.article-prose \{ font-size:16\.5px; line-height:1\.95;/);
  assert.doesNotMatch(blog, /^\s*article-prose\b/m, 'محدّد المقال بلا نقطة');
});

test('parseCoords: لصق الإحداثيات بفاصلة لاتينية أو عربية أو بمسافة', () => {
  assert.deepEqual(parseCoords('24.7136, 46.6753'), { lat: 24.7136, lng: 46.6753 });
  assert.deepEqual(parseCoords('24.7136،46.6753'), { lat: 24.7136, lng: 46.6753 });
  assert.deepEqual(parseCoords('24.7136 46.6753'), { lat: 24.7136, lng: 46.6753 }, 'صيغة النص الإرشادي في نافذة العميل');
  assert.equal(parseCoords('abc 1'), null);
});
