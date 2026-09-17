/**
 * فوترة ZATCA (Z5.1a) — أداة اختبارات حارس النسخ: قراءة ملف الخادم ونسخته في الواجهة، وجسم الملف بعد رأس التعليق.
 * (للاختبارات وحدها — لا يستوردها كود الواجهة.)
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/** جسم الملف بعد أسطر التعليق // والفراغ في أوّله. */
export function copyBody(src: string): string {
  return src.replace(/\r\n/g, '\n').replace(/^(?:[ \t]*\/\/[^\n]*\n|[ \t]*\n)*/, '');
}

export function readWeb(name: string): string {
  return fs.readFileSync(path.join(root, 'src', 'lib', 'zatca', name), 'utf8');
}

export function readBackend(name: string): string {
  const f = path.join(root, '..', 'backend', 'src', 'compliance', 'zatca', name);
  assert(fs.existsSync(f), `ملف الخادم غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8');
}

function assert(ok: boolean, msg: string): void {
  if (!ok) throw new Error(msg);
}
