import { readFileSync, writeFileSync, mkdirSync } from 'fs';

const dir = 'C:/Users/ali_h/AppData/Local/Temp/';
const files = {
  brand: 'Field Sales - Brand Identity.html',
  components: 'Field Sales - Components.html',
  repapp: 'Field Sales - Rep App.html',
  dashboard: 'Field Sales - Web Dashboard.html',
};
const out = 'C:/Users/ali_h/AppData/Local/Temp/fs-design/';
mkdirSync(out, { recursive: true });

for (const [key, name] of Object.entries(files)) {
  try {
    const html = readFileSync(dir + name, 'utf8');
    const m = html.match(/<script type="__bundler\/template">([\s\S]*?)<\/script>/);
    if (!m) { console.log(key, '→ لا يوجد template'); continue; }
    const data = JSON.parse(m[1]);
    const pages = data.pages || {};
    let i = 0;
    for (const [, page] of Object.entries(pages)) {
      // إزالة سمات الصور (uuid placeholders) لتصغير الحجم — نريد الـ CSS والبنية فقط
      writeFileSync(`${out}${key}-${i}.html`, page);
      i++;
    }
    console.log(`${key} → ${i} صفحة (${(JSON.stringify(pages).length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.log(key, '→ خطأ:', e.message);
  }
}
console.log('المخرجات في:', out);
