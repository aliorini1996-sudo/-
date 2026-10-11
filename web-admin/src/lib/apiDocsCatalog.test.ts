import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API_DOC_GROUPS } from './apiDocsCatalog';
import { API_DENIED } from './apiDocsData';

/**
 * مستند API يُسلَّم لمبرمج الشركة: كل مسارٍ يذكره يجب أن يكون مركَّباً في الخادم بطريقته — مسارٌ يُحذف أو
 * يُعاد تسميته ويبقى في المستند يكسر نظام الشركة بلا إنذار. ولا يذكر المستند مساراً ممنوعاً على المفاتيح.
 */
const ROUTES = path.resolve(process.cwd(), '..', 'backend', 'src', 'routes');
const routeSources = fs.readdirSync(ROUTES).filter(f => f.endsWith('.ts')).map(f => fs.readFileSync(path.join(ROUTES, f), 'utf8')).join('\n');
const index = fs.readFileSync(path.resolve(process.cwd(), '..', 'backend', 'src', 'index.ts'), 'utf8');
const mounts = [...new Set([...index.matchAll(/app\.use\('\/api(\/[^']+)'/g)].map(m => m[1]))].sort((a, b) => b.length - a.length);

test('كل مسار في المستند مركَّبٌ في الخادم بطريقته', () => {
  const missing: string[] = [];
  for (const g of API_DOC_GROUPS) {
    for (const e of g.endpoints) {
      const mount = mounts.find(m => e.path === m || e.path.startsWith(`${m}/`));
      if (!mount) { missing.push(`${e.method} ${e.path} (لا بادئة)`); continue; }
      const sub = e.path.slice(mount.length) || '/';
      const needle = `.${e.method.toLowerCase()}('${sub}'`;
      if (!routeSources.includes(needle)) missing.push(`${e.method} ${e.path}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('المستند لا يذكر مساراً ممنوعاً على المفاتيح، وكل مسار بطريقة معروفة', () => {
  for (const g of API_DOC_GROUPS) {
    for (const e of g.endpoints) {
      assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(e.method), `${e.method} ${e.path}`);
      for (const d of API_DENIED) assert.ok(!(e.path === d.prefix || e.path.startsWith(`${d.prefix}/`)), `ممنوع في المستند: ${e.path}`);
    }
  }
  assert.ok(API_DOC_GROUPS.reduce((n, g) => n + g.endpoints.length, 0) > 50, 'الفهرس ناقص');
});

test('المستند لا يكشف مسارات ملفات الخادم الداخلية', () => {
  const all = JSON.stringify(API_DOC_GROUPS);
  assert.ok(!/\.ts:\d/.test(all), 'مرجع ملف داخلي');
  assert.ok(!all.includes('src/'), 'مسار شيفرة داخلي');
});
