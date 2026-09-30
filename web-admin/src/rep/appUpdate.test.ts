import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_UPDATE_CHECK_GAP_MS, fetchLatestBuildId, isNewerBuild, shouldAutoReload } from './appUpdate';

/**
 * تحديث تطبيق المندوب نفسه (بلاغ المالك، ٢٩ سبتمبر ٢٠٢٦: «بصمة الحضور مفعّلة ولا تظهر لبعض المناديب») — التطبيق المفتوح أياماً
 * في الخلفية يظلّ على شيفرة قديمة لا زرّ بصمة فيها.
 */

const OLD = '20260925T101500Z-a25b33e';
const NEW = '20260929T090000Z-c0ffee1';

test('isNewerBuild: الأحدث وحده يطلق التحديث — لا الأقدم (حافة CDN قديمة) ولا المطابق ولا المعطوب، ولا في التطوير', () => {
  assert.equal(isNewerBuild(OLD, NEW), true);
  assert.equal(isNewerBuild(NEW, OLD), false, 'لا رجوع إلى نسخة أقدم ولا حلقة');
  assert.equal(isNewerBuild(NEW, NEW), false);
  assert.equal(isNewerBuild('dev', NEW), false, 'خارج البناء لا تحديث');
  for (const bad of [null, undefined, 42, '', 'x y', '<script>', 'a'.repeat(41)]) assert.equal(isNewerBuild(OLD, bad), false, String(bad));
});

test('fetchLatestBuildId: بلا كاش (معامل وقت + no-store)، وأي فشل ⇒ null صامت', async () => {
  let seen: { url: string; init?: RequestInit } | null = null;
  const ok = (async (url: string, init?: RequestInit) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ buildId: NEW }) };
  }) as unknown as typeof fetch;
  assert.equal(await fetchLatestBuildId(ok, 123), NEW);
  assert.equal(seen!.url, '/build.json?t=123');
  assert.equal(seen!.init?.cache, 'no-store');
  const notFound = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  assert.equal(await fetchLatestBuildId(notFound), null);
  const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await fetchLatestBuildId(offline), null);
  const garbage = (async () => ({ ok: true, json: async () => ({ buildId: 7 }) })) as unknown as typeof fetch;
  assert.equal(await fetchLatestBuildId(garbage), null);
});

test('shouldAutoReload: خاملٌ وحده، ومرة لكل حزمة (لا حلقة إن قُدّمت الصفحة القديمة نفسها)', () => {
  assert.equal(shouldAutoReload(NEW, true, null), true);
  assert.equal(shouldAutoReload(NEW, false, null), false, 'نموذج أو مستند مفتوح ⇒ الشريط لا إعادة التحميل');
  assert.equal(shouldAutoReload(NEW, true, NEW), false, 'جُرّبت لهذه الحزمة');
  assert.equal(shouldAutoReload(NEW, true, OLD), true);
  assert.equal(APP_UPDATE_CHECK_GAP_MS, 5 * 60 * 1000);
});

test('حارس ثابت: البناء ينشر /build.json بمعرّف الحزمة، والتطبيق يفحصه ويعيد التحميل خاملاً أو يعرض الشريط', () => {
  const vite = fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8');
  assert.match(vite, /fileName: 'build\.json', source: JSON\.stringify\(\{ buildId: BUILD_ID \}\)/);
  assert.match(vite, /plugins: \[react\(\), buildInfo\(\)\]/);
  const app = fs.readFileSync(path.resolve(process.cwd(), 'src', 'rep', 'RepApp.tsx'), 'utf8');
  assert.match(app, /if \(isNewerBuild\(BUILD_ID, remote\)\) setUpdateReady\(remote\)/);
  assert.match(app, /const idle = screen === 'home' && modal === null && docResult === null;/);
  assert.match(app, /const iv = window\.setInterval\(check, APP_UPDATE_CHECK_GAP_MS\);/);
  // وإعدادات الشركة تتجدّد دورياً أثناء فتح التطبيق (ميزة يفعّلها المالك تظهر بلا خروج وعودة)
  assert.match(app, /const iv = window\.setInterval\(refresh, COMPANY_REFRESH_TICK_MS\);/);
});

test('حارس ثابت: عامل الخدمة لا يخزّن /build.json (رابط فريد كل فحص يراكم نسخاً، والمخزَّن القديم يُخفي التحديث)', () => {
  const sw = fs.readFileSync(path.resolve(process.cwd(), 'public', 'sw.js'), 'utf8');
  const bypass = sw.indexOf("if (url.pathname === '/build.json') return;");
  assert.ok(bypass > 0);
  assert.ok(bypass < sw.indexOf('// بقية الأصول: الشبكة أولاً ثم الكاش'), 'قبل مسار التخزين العام');
});
