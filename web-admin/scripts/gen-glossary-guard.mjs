/**
 * يولّد كتلة GLOSSARY_AVOID في scripts/claims-rules.mjs من قواميس المصطلحات src/i18n/glossary/{ar,en,fr,tr,zh}.json.
 *
 * لماذا نسخة مولَّدة لا استيراد JSON: claims-rules.mjs تستورده سكربتات Node العادية (import JSON فيها يحتاج سمة type)
 * والاختبارات (tsx) وحزمة المتصفح (BlogPostPage يحمّله كسولاً) — ونصّ JS واحد يصلح للثلاثة. المصدر الواحد هو القواميس،
 * واختبار src/i18n/glossary.test.ts يفشل إن انحرفت الكتلة عنها (فلا نسختان تنحرفان بصمت).
 *
 * التشغيل: node scripts/gen-glossary-guard.mjs [--check]   (--check: لا يكتب، ويخرج بـ1 إن كانت الكتلة قديمة)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES_FILE = path.join(ROOT, 'scripts/claims-rules.mjs');
const LANGS = ['ar', 'en', 'fr', 'tr', 'zh'];
const OPEN = '// <glossary-avoid>';
const CLOSE = '// </glossary-avoid>';

const avoid = {};
for (const code of LANGS) {
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/i18n/glossary', `${code}.json`), 'utf8'));
  if (g.code !== code) throw new Error(`glossary/${code}.json: code=${g.code}`);
  avoid[code] = g.avoid;
}

const src = fs.readFileSync(RULES_FILE, 'utf8');
const a = src.indexOf(OPEN);
const b = src.indexOf(CLOSE);
if (a < 0 || b < a) throw new Error('لم تُعثر علامتا الكتلة في claims-rules.mjs');
const headLines = src.slice(a, b).split('\n').filter((l) => l.startsWith('//')).join('\n');
// بند لكل سطر: الكتلة تُقرأ في مراجعة الفرق كلمةً كلمة
const body = LANGS.map((c) => `  ${c}: [\n${avoid[c].map((e) => `    ${JSON.stringify(e)},`).join('\n')}\n  ],`).join('\n');
const block = `${headLines}\nexport const GLOSSARY_AVOID = {\n${body}\n};\n`;
const out = src.slice(0, a) + block + src.slice(b);

if (process.argv.includes('--check')) {
  if (out !== src) { console.error('✗ كتلة GLOSSARY_AVOID قديمة — شغّل: node scripts/gen-glossary-guard.mjs'); process.exit(1); }
  console.log('✓ كتلة GLOSSARY_AVOID مطابقة للقواميس.');
} else if (out !== src) {
  fs.writeFileSync(RULES_FILE, out, 'utf8');
  console.log(`✓ كُتبت كتلة GLOSSARY_AVOID: ${LANGS.map((c) => `${c} ${avoid[c].length}`).join(' · ')}`);
} else console.log('✓ لا تغيير.');
