/**
 * جسر واتساب ويب المحلي — Field Sales
 *
 * يعمل على جهازك (لا على الخادم): يفتح جلسة واتساب ويب حقيقية، يرفع رمز QR إلى لوحة
 * المالك لتمسحه بهاتفك، ثم يسحب طابور الرسائل من api.fieldsa.net ويرسلها ويُبلّغ النتائج.
 *
 * لماذا على جهازك: IP سكني ومتصفّح حقيقي = سلوك طبيعي. خوادم السحابة تُرفع خطر الحظر
 * كثيراً، وتحتاج Chromium وقرصاً دائماً. المقابل: يعمل فقط والجهاز مفتوح — وهذا مقبول
 * لأنك ترسل بيدك لكل عميل على حدة.
 *
 * التشغيل:  npm install && npm start   (ثم امسح QR من لوحة المالك)
 * الإيقاف:  Ctrl+C   — الجلسة محفوظة في .session فلا تعيد المسح كل مرة.
 */

'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

/**
 * إيجاد متصفّح Chrome على الجهاز.
 *
 * whatsapp-web.js يعتمد puppeteer-core الذي **لا يُنزّل Chromium** — فبلا مسار صريح
 * ينهار فور الإقلاع بـ«Could not find Chrome». وبدل تنزيل 150م.ب قد ينكسر استخراجه،
 * نستخدم Chrome المثبّت أصلاً: متصفّح حقيقي بملفّ تعريف حقيقي = سلوك أطبع أمام واتساب.
 */
function findChrome() {
  const override = (process.env.WA_BRIDGE_CHROME || '').trim();
  if (override) {
    if (!fs.existsSync(override)) {
      console.error(`✖ WA_BRIDGE_CHROME يشير إلى مسار غير موجود:\n  ${override}`);
      process.exit(1);
    }
    return override;
  }

  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = {
    win32: [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      local && path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ],
  }[process.platform] || [];

  const found = candidates.filter(Boolean).find((p) => fs.existsSync(p));
  if (!found) {
    console.error('✖ لم أجد Chrome على هذا الجهاز.');
    console.error('  ثبّت Google Chrome، أو حدّد مساره صراحةً:');
    console.error('  $env:WA_BRIDGE_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"');
    process.exit(1);
  }
  return found;
}

// ------------------------------- الإعدادات ------------------------------- //

const API = (process.env.WA_BRIDGE_API || 'https://api.fieldsa.net/api/wa-bridge').replace(/\/+$/, '');
const KEY = (process.env.WA_BRIDGE_KEY || '').trim();
const POLL_MS = Number(process.env.WA_BRIDGE_POLL_MS || 8000);

// تباعد عشوائي بين الرسائل — الإرسال بإيقاع آلي منتظم هو أوضح إشارة حظر
const MIN_GAP_MS = Number(process.env.WA_BRIDGE_MIN_GAP_MS || 8000);
const MAX_GAP_MS = Number(process.env.WA_BRIDGE_MAX_GAP_MS || 25000);

if (!KEY) {
  console.error('');
  console.error('✖ ينقص المفتاح — لم أجد WA_BRIDGE_KEY.');
  console.error('');
  console.error('  الحلّ في خطوتين:');
  console.error(`  ١) افتح المجلّد:  ${__dirname}`);
  console.error('  ٢) أنشئ ملفاً اسمه  .env  (انسخ .env.example) واكتب فيه سطراً واحداً:');
  console.error('');
  console.error('     WA_BRIDGE_KEY=المفتاح-من-Render');
  console.error('');
  console.error('  المفتاح تجده في: Render ← dsd-backend ← Environment ← WA_BRIDGE_KEY');
  console.error('  بلا علامات تنصيص وبلا مسافات حول علامة =');
  console.error('');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => MIN_GAP_MS + Math.floor(Math.random() * Math.max(1, MAX_GAP_MS - MIN_GAP_MS));
const log = (...a) => console.log(new Date().toLocaleTimeString('ar-SA'), ...a);

// ------------------------------- نداء الخادم ------------------------------- //

let lastFault = ''; // لا نُكرّر نفس سبب العطل كل 8ث فيغرق السجلّ

async function api(path, body, method = 'POST') {
  try {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { 'x-bridge-key': KEY, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    if (!r.ok) {
      // نطبع رسالة الخادم لا رقم الحالة: «401» وحدها لا تُخبر أين الخلل
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        if (j?.message) msg = j.message;
      } catch { /* استجابة غير JSON */ }
      if (msg !== lastFault) {
        log(`✖ ${msg}`);
        if (r.status === 401) log('  المفتاح لديك ≠ المضبوط على Render. تحقّق من الاثنين حرفاً بحرف.');
        if (r.status === 503) log('  أضِف WA_BRIDGE_KEY في Render ← dsd-backend ← Environment، وانتظر إعادة النشر.');
        lastFault = msg;
      }
      return null;
    }
    if (lastFault) { log('✓ استُعيد الاتصال بالخادم'); lastFault = ''; }
    return await r.json();
  } catch (e) {
    // انقطاع الشبكة لا يُسقط الجسر — الدورة التالية تعيد المحاولة
    if (e.message !== lastFault) { log(`⚠ ${path} → ${e.message}`); lastFault = e.message; }
    return null;
  }
}

// ------------------------------- عميل واتساب ------------------------------- //

const CHROME = findChrome();

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.session' }),
  puppeteer: {
    headless: true,
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', async (qr) => {
  log('▸ رمز QR جديد — امسحه بهاتفك: واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز');
  // نطبعه هنا أيضاً لا في اللوحة فقط: يتيح الربط فوراً بلا انتظار نشر الواجهة،
  // ويُنقذك إن كانت اللوحة معطّلة لأي سبب.
  try {
    console.log('\n' + (await qrcode.toString(qr, { type: 'terminal', small: true })));
  } catch (e) {
    log(`⚠ تعذّر رسم الرمز في الطرفية (${e.message}) — استخدم اللوحة`);
  }
  const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
  await api('/qr', { qr: dataUrl });
});

client.on('authenticated', () => log('▸ تمّ التوثيق — جارٍ التجهيز...'));

client.on('ready', async () => {
  const me = client.info;
  const phone = me?.wid?.user || null;
  log(`✓ متصل بالرقم ${phone || '؟'} — الجسر يعمل`);
  await api('/status', { status: 'CONNECTED', phone, pushName: me?.pushname || null });
  reconcile(); // بلا await: لا نُعطّل الجسر إن طال
});

/**
 * مصالحة الرسائل القديمة: الكود القديم كان يُعلّم SENT بمجرّد عودة sendMessage — وهو
 * يعود قبل التسليم — فوُجد عملاء «تم التواصل» لم تصلهم رسالة. واتساب يحتفظ بحالة كل
 * رسالة، فنسأله عن كل واحدة بمعرّفها ونُصحّح السجلّ بالحقيقة لا بالتخمين.
 */
async function reconcile() {
  try {
    const r = await api('/verify-queue', null, 'GET');
    const rows = r?.data?.messages || [];
    if (!rows.length) return;
    log(`▸ مصالحة: ${rows.length} رسالة قديمة بلا تأكيد تسليم — أسأل واتساب عنها`);
    let ok = 0, bad = 0, gone = 0;
    for (const m of rows) {
      let ack = null;
      try {
        const wm = await client.getMessageById(m.waId);
        ack = typeof wm?.ack === 'number' ? wm.ack : null;
      } catch {
        ack = null; // لم تُوجد في سجلّ واتساب ⇒ لم تخرج
      }
      await api('/verify-result', { id: m.id, ack });
      if (ack === null) gone++; else if (ack >= 1) ok++; else bad++;
      await sleep(300); // لا نُرهق المتصفّح
    }
    log(`▸ انتهت المصالحة: ✓ ${ok} وصلت · ✖ ${bad} لم تُسلَّم · ⊘ ${gone} لا أثر لها`);
    if (bad + gone > 0) log(`  أُعيد ${bad + gone} عميلاً إلى «جديد» — يمكن مراسلتهم من جديد`);
  } catch (e) {
    log(`⚠ تعذّرت المصالحة (غير مانع): ${e.message}`);
  }
}

client.on('auth_failure', async (m) => {
  log('✖ فشل التوثيق:', m);
  await api('/status', { status: 'AUTH_FAILED', error: String(m) });
});

client.on('disconnected', async (reason) => {
  log('✖ انفصلت الجلسة:', reason);
  await api('/status', { status: 'DISCONNECTED', error: String(reason) });
});

// الردود الواردة — نتجاهل المجموعات والحالات، ونرفع رسائل الأفراد فقط
client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return;        // مجموعة
    if (msg.from === 'status@broadcast') return;   // حالة
    const phone = msg.from.replace(/@.*$/, '');
    const r = await api('/inbound', {
      waId: msgId(msg) || `${phone}_${Date.now()}`,
      phone,
      body: msg.body || '',
    });
    const d = r?.data;
    if (d?.optOut) log(`⛔ ${phone} طلب الإيقاف — استُثني نهائياً`);
    else if (d?.leadId) log(`💬 ردّ من ${phone} — رُفعت مرحلته إلى «مؤهَّل»`);
  } catch (e) {
    log('⚠ تعذّر رفع ردّ وارد:', e.message);
  }
});

// ------------------------------- تأكيد التسليم ------------------------------- //

/**
 * ⚠️ `client.sendMessage()` يُرجع **undefined** في whatsapp-web.js 1.34 مع نسخة واتساب
 * ويب الحالية — لا كائن رسالة. مُقاس بالتجربة على رقم الجسر نفسه: المُرجَع undefined
 * بينما الرسالة تصل فعلاً (ACK=3).
 *
 * أثر ذلك على الكود القديم: `sent?.id?._serialized || null` = null دائماً، فحُفظت 34
 * رسالة بلا معرّف، واستحال معرفة أيّها وصل. ولو وثقنا بالمُرجَع لتعطّل كل شيء.
 *
 * البديل: نلتقط الرسالة من حدث `message_create` الذي يُطلقه واتساب عند كل إرسال منّا —
 * فنحصل على المعرّف الحقيقي بلا الاعتماد على قيمة مُرجَعة معطوبة.
 */
/**
 * ⚠️ معرّف الرسالة: واتساب أعاد تسمية `id._serialized` إلى **`id.$1`** (أثر تصغير في
 * كودهم)، والمكتبة 1.34.7 ما زالت تقرأ `_serialized` فتُعيد undefined دائماً.
 * مقيس على الإنتاج: id = {fromMe, remote:"…@lid", id:"3EB0…", self:"out", $1:"true_…_out"}
 * نقرأ الاسمين، ونبني المعرّف من أجزائه احتياطاً إن تغيّرا معاً لاحقاً.
 */
function msgId(m) {
  const id = m && m.id;
  if (!id) return null;
  if (id._serialized) return id._serialized;
  if (id.$1) return id.$1;
  if (id.id && id.remote) return `${!!id.fromMe}_${id.remote}_${id.id}_${id.self || 'out'}`;
  return null;
}

/**
 * التقاط الرسالة الصادرة من حدث `message_create`.
 * لا نُطابق بـchatId: واتساب صار يُعنون بـ`@lid` (108560…@lid) لا بالرقم، فأي مطابقة
 * بـ`966…@c.us` تفشل دائماً. نُطابق بـ(منّا + نفس النصّ) — دقيق لأننا نرسل واحدة واحدة.
 */
function captureOutgoing(body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); client.removeListener('message_create', handler); resolve(v); };
    const handler = (msg) => {
      if (msg && msg.fromMe && msg.body === body) done(msg);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    client.on('message_create', handler);
  });
}

/**
 * إشعار التسليم من واتساب — الحقيقة الوحيدة:
 *   -1 خطأ · 0 معلّق · 1 وصل الخادم · 2 سُلّم للجهاز · 3 قُرئ
 * ننتظر ACK ≥ 1؛ وما دونه ليس إرسالاً ولا يُعلّم عميلاً «تم التواصل».
 */
function waitForAck(msg, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const id = msgId(msg);
    if (!id) return resolve(false);
    if (typeof msg.ack === 'number' && msg.ack >= 1) return resolve(true);
    const done = (v) => { clearTimeout(timer); client.removeListener('message_ack', handler); resolve(v); };
    const handler = (m, ack) => {
      if (msgId(m) !== id) return;
      if (ack >= 1) done(true);
      else if (ack < 0) done(false); // ACK_ERROR — رفض صريح
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    client.on('message_ack', handler);
  });
}

// ------------------------------- حلقة الطابور ------------------------------- //

let busy = false;
let stopped = false;        // توقّف تلقائي (مُعطَّل افتراضياً)
let consecutiveFails = 0;

/**
 * التوقّف التلقائي عند تتابع الإخفاقات — **مُعطَّل افتراضياً بطلب المالك**.
 *
 * 0 = لا يتوقّف أبداً (الافتراضي) · أي رقم > 0 = يتوقّف بعد هذا العدد من الإخفاقات المتتالية.
 * لتفعيله:  set WA_BRIDGE_MAX_FAILS=5  قبل التشغيل، أو أضِفه في .env
 *
 * يبقى التحذير مطبوعاً في الحالتين: تتابع الإخفاقات يعني أن واتساب يرفض الإرسال،
 * والاستمرار عندها هو ما يقود إلى تقييد الرقم. المعلومة تُعرض، والقرار للمالك.
 */
const MAX_FAILS = Number(process.env.WA_BRIDGE_MAX_FAILS ?? 0);
const WARN_AT = 5; // نُنبّه عند هذا العدد ولو كان الإيقاف مُعطَّلاً

async function tick() {
  if (busy || stopped) return; // دورة سابقة ما زالت ترسل، أو توقّفنا تلقائياً — لا نُراكم
  busy = true;
  try {
    const r = await api('/pull', null, 'GET');
    const data = r?.data;
    if (!data) return;

    if (data.command === 'LOGOUT') {
      log('▸ أمر فصل من اللوحة — جارٍ الخروج');
      await api('/command-done', {});
      try { await client.logout(); } catch { /* قد تكون الجلسة منتهية أصلاً */ }
      await api('/status', { status: 'DISCONNECTED', error: null });
      return;
    }

    const messages = data.messages || [];
    if (!messages.length) return;
    log(`▸ ${messages.length} رسالة في الطابور (متبقٍّ اليوم: ${data.remainingToday ?? '?'})`);

    for (const m of messages) {
      if (stopped) break;
      const gap = jitter();
      log(`  … انتظار ${Math.round(gap / 1000)}ث قبل ${m.phone}`);
      await sleep(gap);
      try {
        const chatId = `${m.phone}@c.us`;
        // رقم بلا واتساب (أرضي غالباً) — نتخطّاه بلا احتساب: بيانات ناقصة لا رفض من واتساب
        const registered = await client.isRegisteredUser(chatId);
        if (!registered) {
          await api('/result', { id: m.id, ok: false, error: 'الرقم غير مسجّل على واتساب' });
          log(`  ⊘ ${m.phone} — لا واتساب على هذا الرقم (تُخطّي)`);
          continue;
        }

        // نُنصت قبل الإرسال: message_create قد يسبق عودة sendMessage
        const waiter = captureOutgoing(m.body);
        await client.sendMessage(chatId, m.body); // مُرجَعه undefined — لا نستعمله
        const sent = await waiter;
        // بلا ACK لا نُعلّم العميل «تم التواصل»
        const acked = sent ? await waitForAck(sent) : false;
        if (!acked) {
          consecutiveFails++;
          await api('/result', {
            id: m.id, ok: false,
            error: 'لم يؤكّد واتساب التسليم (ACK) — الرقم مقيَّد أو الرسالة حُجبت',
          });
          log(`  ✖ ${m.phone} — أُرسلت بلا تأكيد تسليم (متتالية: ${consecutiveFails})`);
        } else {
          consecutiveFails = 0; // نجاح مؤكّد يُصفّر العدّاد
          await api('/result', { id: m.id, ok: true, waId: msgId(sent) });
          log(`  ✓ سُلّمت إلى ${m.phone}`);
        }
      } catch (e) {
        consecutiveFails++;
        await api('/result', { id: m.id, ok: false, error: e.message });
        log(`  ✖ فشل ${m.phone}: ${e.message} (متتالية: ${consecutiveFails})`);
      }

      // تنبيه بلا إيقاف: تتابع الإخفاقات يعني أن واتساب يرفض الإرسال — معلومة تُعرض والقرار للمالك
      if (consecutiveFails === WARN_AT) {
        log('');
        log(`⚠️  ${consecutiveFails} إخفاقات متتالية — واتساب يرفض الإرسال الآن.`);
        log('   الاستمرار في هذه الحالة هو ما يقود إلى تقييد الرقم.');
        log('   (الإيقاف التلقائي مُعطَّل. لتفعيله: set WA_BRIDGE_MAX_FAILS=5)');
        log('');
      }

      // الإيقاف التلقائي — مُعطَّل ما لم يُضبط WA_BRIDGE_MAX_FAILS > 0
      if (MAX_FAILS > 0 && consecutiveFails >= MAX_FAILS) {
        stopped = true;
        log('');
        log(`🛑 توقّف تلقائي — ${MAX_FAILS} إخفاقات متتالية.`);
        log('   أوقف الجسر، انتظر ساعات، وابدأ بعدد أقلّ بكثير.');
        log('');
        await api('/status', {
          status: 'CONNECTED', phone: client.info?.wid?.user || null,
          error: `توقّف تلقائي: ${MAX_FAILS} إخفاقات متتالية — واتساب يرفض الإرسال`,
        });
        break;
      }
    }
  } finally {
    busy = false;
  }
}

// ------------------------------- الإقلاع ------------------------------- //

/**
 * حارس البقاء: whatsapp-web.js وPuppeteer يرميان أخطاءً غير متزامنة (انقطاع صفحة،
 * جلسة تُحدَّث، عنصر يختفي) خارج أي try/catch لدينا — وNode يُسقط العملية كلّها عندها.
 * فتنغلق النافذة فجأة والرسائل تبقى معلّقة في الطابور بلا تفسير. نُسجّل ونستمرّ.
 */
process.on('unhandledRejection', (e) => {
  log(`⚠ خطأ غير معالَج (الجسر مستمرّ): ${e?.message || e}`);
});
process.on('uncaughtException', (e) => {
  log(`⚠ استثناء (الجسر مستمرّ): ${e?.message || e}`);
});

log('▸ جسر واتساب — Field Sales');
log(`▸ الخادم: ${API}`);
log(`▸ المتصفّح: ${CHROME}`);
client.initialize().catch((e) => {
  log(`✖ تعذّر إقلاع المتصفّح: ${e.message}`);
  log('  جرّب إغلاق كل نوافذ الجسر ثم إعادة التشغيل.');
});
setInterval(tick, POLL_MS);

// خروج نظيف: نُبلّغ اللوحة فلا تبقى «متصل» وهماً
async function shutdown() {
  log('▸ إيقاف الجسر...');
  await api('/status', { status: 'DISCONNECTED', error: 'أُوقف الجسر يدوياً' });
  try { await client.destroy(); } catch { /* تجاهل */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
