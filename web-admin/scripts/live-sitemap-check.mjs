/**
 * الفحص الحيّ للخريطة — ما يتسلّمه الزاحف فعلاً من fieldsa.net بعد النشر، لا ما في dist ولا المصدر.
 *
 * لماذا وُجد (أكتوبر 2026): كل التدقيقات كانت خضراء يومياً بينما 16 رابطاً تركياً وصينياً في الخريطة
 * تعيد قوقعة الرئيسية بـcanonical «/»، ووقع الشيء نفسه في 5 أغسطس (17 صفحة عربية صارت قوقعة
 * لأن خادم Render يبحث بالمسار المرمَّز). verify-sitemap يحرس dist قبل النشر، وهذا يحرس ما بعده:
 * إعدادات الخادم وقواعد إعادة الكتابة والترميز لا تظهر إلا حيّاً.
 *
 * الوضع الأول (الافتراضي) — فحص الخريطة الحية:
 *   يجلب /sitemap.xml ثم كل <loc> (بتوازي 12 ومهلة 15 ثانية) ويفشل (exit 1) إذا:
 *     - الرمز غير 200 (ومنه التحويل 3xx: الخريطة تعلن الرابط النهائي وحده)،
 *     - أو canonical الصفحة غائب أو لا يشير إليها،
 *     - أو عنوانها عنوان الرئيسية العربية لرابط غير الرئيسية (القوقعة)،
 *     - أو هي noindex.
 *   أخطاء الشبكة العابرة (مهلة، انقطاع، 5xx، 429) تُعاد مرتين ثم تُعدّ «تعذّر الفحص» تحذيراً لا فشلاً،
 *   وتعذّر جلب الخريطة نفسها تحذير ينتهي بـ0: لا يفشل الوركفلو لعطل شبكة عابر (health.yml يحرس التوفّر).
 *
 * الوضع الثاني — انتظار اكتمال النشر قبل IndexNow:
 *   --wait-for <خريطة ملتزمة> --urls <ملف الروابط المتغيّرة> [--max-wait 600] [--interval 30]
 *   يستطلع الخريطة الحية حتى تطابق الخريطة الملتزمة في الروابط المتغيّرة: المضاف والمتغيّر بكتلته
 *   (lastmod والبدائل) أو بتاريخ أحدث، والمحذوف غائباً. ينتهي بـ0 دائماً ويكتب deployed=true|false
 *   في GITHUB_OUTPUT؛ انقضاء المهلة تحذير (النشر قد يطول) لا فشل.
 *
 * طلبات GET عامة فقط. خيارات: --origin <أصل> · --sample <N> عيّنة موزّعة بانتظام · --verbose كل البنود.
 */
import fs from 'fs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const ORIGIN = (opt('--origin') || 'https://fieldsa.net').replace(/\/+$/, '');
const CONCURRENCY = Number(opt('--concurrency')) || 12;
const TIMEOUT = Number(opt('--timeout')) || 15000;
const VERBOSE = argv.includes('--verbose');
const UA = 'fieldsa-seo-check/1.0 (+https://fieldsa.net)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normUrl = (u, base = ORIGIN + '/') => { try { return new URL(u, base).href; } catch { return String(u); } };
const shown = (u) => { try { return decodeURI(new URL(u).pathname); } catch { return u; } };
const summary = (md) => {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch { /* اختياري */ }
};
const output = (k, v) => {
  if (!process.env.GITHUB_OUTPUT) return;
  try { fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); } catch { /* اختياري */ }
};

/**
 * GET بلا تتبّع للتحويل. العابر (شبكة/مهلة/5xx/429) يُعاد حتى tries مرات بتراجع؛ والنتيجة
 * {status, body, location} أو {transient: true, error} إن بقي عابراً.
 */
async function get(url, { tries = 3, body = true } = {}) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(i === 1 ? 2000 : 5000);
    try {
      const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (r.status >= 500 || r.status === 429) { last = `HTTP ${r.status}`; continue; }
      return { status: r.status, location: r.headers.get('location') || '', body: body && r.status === 200 ? await r.text() : '' };
    } catch (e) {
      last = e.name === 'TimeoutError' ? `مهلة ${TIMEOUT / 1000} ث` : (e.cause?.code || e.message);
    }
  }
  return { transient: true, error: last };
}

/** <url> ← Map(رابط مرمَّز ← {lastmod, block}) */
function parseSitemap(xml) {
  const out = new Map();
  for (const m of String(xml).matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = (m[1].match(/<loc>\s*([^<]+?)\s*<\/loc>/) || [])[1];
    if (!loc) continue;
    out.set(normUrl(loc.replace(/&amp;/g, '&')), {
      lastmod: (m[1].match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/) || [])[1] || '',
      block: m[1].replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

async function liveSitemap() {
  const r = await get(`${ORIGIN}/sitemap.xml?nocache=${Date.now()}`, { tries: 2 });
  if (r.transient || r.status !== 200) return null;
  return parseSitemap(r.body);
}

// ───────── الوضع الثاني: انتظار النشر ─────────
async function waitForDeploy() {
  const committedFile = opt('--wait-for');
  const urlsFile = opt('--urls');
  const maxWait = (Number(opt('--max-wait')) || 600) * 1000;
  const interval = (Number(opt('--interval')) || 30) * 1000;
  if (!committedFile || !fs.existsSync(committedFile)) {
    console.warn(`⚠ الخريطة الملتزمة غير موجودة (${committedFile || '—'}) — لا انتظار.`);
    output('deployed', 'false');
    return 0;
  }
  const committed = parseSitemap(fs.readFileSync(committedFile, 'utf8'));
  const urls = urlsFile && fs.existsSync(urlsFile)
    ? [...new Set(fs.readFileSync(urlsFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((u) => normUrl(u)))]
    : [];
  if (!urls.length) {
    console.log('لا روابط متغيّرة — لا شيء ننتظره.');
    output('deployed', 'true');
    return 0;
  }
  /** هل يعكس الحيّ الحالةَ الملتزمة لهذا الرابط؟ */
  const settled = (live, u) => {
    const c = committed.get(u);
    const l = live.get(u);
    if (!c) return !l; // محذوف من الخريطة ⇒ يجب أن يغيب حيّاً
    if (!l) return false;
    return l.block === c.block || (!!l.lastmod && !!c.lastmod && l.lastmod > c.lastmod); // نشرٌ أحدث تجاوزه
  };
  const start = Date.now();
  let pending = urls;
  let polls = 0;
  console.log(`انتظار النشر: ${urls.length} رابطاً متغيّراً، حتى ${maxWait / 1000} ثانية كل ${interval / 1000} ثانية…`);
  while (Date.now() - start <= maxWait) {
    polls++;
    const live = await liveSitemap();
    if (live) {
      pending = urls.filter((u) => !settled(live, u));
      if (!pending.length) {
        const secs = Math.round((Date.now() - start) / 1000);
        console.log(`✓ النشر مكتمل: الخريطة الحية تطابق الملتزمة في الروابط المتغيّرة كلها (بعد ${secs} ثانية، ${polls} استطلاع).`);
        summary(`- ✅ اكتمل النشر بعد ${secs} ثانية (${urls.length} رابطاً متغيّراً).`);
        output('deployed', 'true');
        return 0;
      }
      console.log(`  … ${pending.length}/${urls.length} لم تظهر بعد (مثل ${shown(pending[0])})`);
    } else {
      console.log('  … تعذّر جلب الخريطة الحية — إعادة المحاولة');
    }
    if (Date.now() - start + interval > maxWait) break;
    await sleep(interval);
  }
  console.warn(`⚠ انقضت المهلة (${maxWait / 1000} ثانية) و${pending.length} رابطاً لم يظهر حيّاً بعد — قد يطول النشر أو يكون فشل في Render.`);
  for (const u of pending.slice(0, 5)) console.warn(`    ${shown(u)}`);
  summary(`- ⚠️ لم يُتحقق من اكتمال النشر خلال ${maxWait / 1000} ثانية (${pending.length} رابطاً معلّقاً).`);
  output('deployed', 'false');
  return 0;
}

// ───────── الوضع الأول: فحص الخريطة الحية ─────────
async function checkLive() {
  const sm = await get(`${ORIGIN}/sitemap.xml?nocache=${Date.now()}`, { tries: 3 });
  if (sm.transient || sm.status !== 200) {
    const why = sm.transient ? sm.error : `HTTP ${sm.status}`;
    console.warn(`⚠ تعذّر جلب الخريطة الحية (${why}) — لا فحص في هذا التشغيل (غير مانع).`);
    summary(`### الفحص الحيّ للخريطة\n\n⚠️ تعذّر جلب الخريطة الحية (${why}) — لم يُفحص شيء.\n`);
    return 0;
  }
  let locs = [...parseSitemap(sm.body).keys()];
  const total = locs.length;
  const sample = Number(opt('--sample')) || 0;
  if (sample && sample < locs.length) {
    // عيّنة حتمية موزّعة بانتظام على الخريطة كلها، والرئيسية دائماً منها
    const step = locs.length / sample;
    const picked = new Set([normUrl('/')]);
    for (let i = 0; picked.size < sample && i < sample * 2; i++) picked.add(locs[Math.floor(i * step) % locs.length]);
    locs = locs.filter((u) => picked.has(u));
  }

  const home = await get(`${ORIGIN}/`, { tries: 3 });
  const titleOf = (h) => ((h.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  const homeTitle = home.transient || home.status !== 200 ? null : titleOf(home.body);

  const cats = new Map(); // key → {title, level, items}
  const add = (level, key, title, item) => {
    if (!cats.has(key)) cats.set(key, { level, title, count: 0, items: [] });
    const c = cats.get(key);
    c.count++;
    if (VERBOSE || c.items.length < 10) c.items.push(item);
  };
  let okCount = 0;
  let badCount = 0; // روابط بخلل مؤكَّد (الرابط الواحد قد يقع في أكثر من فئة)
  let netCount = 0;
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, locs.length) }, async () => {
    while (i < locs.length) {
      const u = locs[i++];
      const r = await get(u);
      const where = shown(u);
      if (r.transient) { netCount++; add('warn', 'network', 'تعذّر الفحص (شبكة أو خادم عابر)', `${where} — ${r.error}`); continue; }
      if (r.status !== 200) {
        badCount++;
        add('error', 'status', 'رمز غير 200', `${where} — ${r.status}${r.location ? ` ← ${decodeURI(r.location)}` : ''}`);
        continue;
      }
      const head = r.body.slice(0, Math.max(r.body.search(/<body\b/i), 0) || r.body.length);
      const canonTag = (head.match(/<link\b[^>]*rel=["']canonical["'][^>]*>/i) || [])[0] || '';
      const canon = (canonTag.match(/href=["']([^"']+)["']/i) || [])[1];
      const robotsTag = (head.match(/<meta\b[^>]*name=["']robots["'][^>]*>/i) || [])[0] || '';
      const title = titleOf(head);
      let bad = false;
      if (!canon) { add('error', 'no-canonical', 'صفحة بلا canonical', where); bad = true; }
      else if (normUrl(canon, u) !== u) { add('error', 'canonical', 'canonical لا يشير إلى الصفحة نفسها', `${where} ← ${shown(normUrl(canon, u))}`); bad = true; }
      if (homeTitle && u !== normUrl('/') && title === homeTitle) { add('error', 'shell', 'عنوان الرئيسية على رابط غير الرئيسية (قوقعة SPA)', where); bad = true; }
      if (/noindex/i.test(robotsTag)) { add('error', 'noindex', 'صفحة noindex داخل الخريطة', where); bad = true; }
      if (bad) badCount++; else okCount++;
    }
  }));

  const errors = [...cats.values()].filter((c) => c.level === 'error');
  const warns = [...cats.values()].filter((c) => c.level === 'warn');
  const failed = badCount;
  const line = `الفحص الحيّ: ${locs.length}${sample ? ` (عيّنة من ${total})` : ''} رابطاً من ${ORIGIN}/sitemap.xml — سليم ${okCount} · خلل ${failed} · تعذّر ${netCount}`;
  console.log(line);
  if (!homeTitle) console.warn('  ⚠ تعذّر جلب الرئيسية — فحص «عنوان القوقعة» معطّل في هذا التشغيل');
  let md = `### الفحص الحيّ للخريطة\n\n${line}\n`;
  for (const c of [...warns, ...errors]) {
    const sign = c.level === 'error' ? '✗' : '⚠';
    (c.level === 'error' ? console.error : console.warn)(`\n  ${sign} ${c.title} — ${c.count}`);
    for (const it of c.items) (c.level === 'error' ? console.error : console.warn)(`      ${it}`);
    md += `\n- ${c.level === 'error' ? '❌' : '⚠️'} ${c.title}: ${c.count}\n${c.items.slice(0, 10).map((x) => `  - \`${x}\``).join('\n')}\n`;
  }
  summary(md);
  if (failed) {
    console.error(`\n✗ الفحص الحيّ فشل: ${failed} رابطاً في الخريطة لا يتسلّم الزاحف منه صفحته.`);
    return 1;
  }
  console.log(warns.length ? '\n✓ لا خلل مؤكَّد (راجع ما تعذّر فحصه أعلاه).' : '\n✓ كل روابط الخريطة الحية 200 بـcanonical ذاتي.');
  return 0;
}

// exitCode لا process.exit(): الخروج الفوري وطلبات fetch ما زالت تُغلق مقابسها يُسقط Node على ويندوز
// (UV_HANDLE_CLOSING) برمز 127 بدل نتيجة الفحص. مؤقّتات AbortSignal.timeout لا تُبقي العملية حيّة.
process.exitCode = opt('--wait-for') !== null ? await waitForDeploy() : await checkLive();
