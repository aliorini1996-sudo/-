// IndexNow — إشعار فوري لمحركات البحث (Bing وشركاؤه) بروابط الموقع بدل انتظار الزحف.
// أهميته لـGEO: فهرس Bing يغذّي ChatGPT Search وCopilot وDuckDuckGo مباشرةً.
// الاستخدام: node scripts/indexnow.mjs            → يرسل روابط sitemap.xml كاملة (أول مرة أو عند تغيّر الخريطة)
//           node scripts/indexnow.mjs url1 url2  → يرسل روابط محددة فقط
// لا يُرسَل عند كل بناء (احترام البروتوكول: أشعِر عند التغيير فقط) — يُشغَّل من الصيانة المجدولة عند تغيّر الخريطة.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST = 'fieldsa.net';
const KEY = '6548b7ac3458e8bcee3dd9f0c1fe55f3'; // ملف التحقق: public/<KEY>.txt
const ENDPOINT = 'https://api.indexnow.org/indexnow';

function sitemapUrls() {
  const sm = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
  return [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function submit(urls) {
  // حد البروتوكول 10,000 رابط لكل طلب — دفعة واحدة تكفي حالياً
  const batch = urls.slice(0, 10000);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: batch }),
  });
  // 200 = قُبل، 202 = قُبل (سيُتحقق من المفتاح لاحقاً) — كلاهما نجاح
  if (res.status === 200 || res.status === 202) {
    console.log(`✅ IndexNow: أُرسل ${batch.length} رابطاً (HTTP ${res.status})`);
  } else {
    console.error(`❌ IndexNow: HTTP ${res.status} — ${await res.text()}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const urls = args.length ? args : sitemapUrls();
console.log(`IndexNow → ${HOST}: ${urls.length} رابط...`);
submit(urls);
