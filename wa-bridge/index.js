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

// ------------------------------- الإعدادات ------------------------------- //

const API = (process.env.WA_BRIDGE_API || 'https://api.fieldsa.net/api/wa-bridge').replace(/\/+$/, '');
const KEY = (process.env.WA_BRIDGE_KEY || '').trim();
const POLL_MS = Number(process.env.WA_BRIDGE_POLL_MS || 8000);

// تباعد عشوائي بين الرسائل — الإرسال بإيقاع آلي منتظم هو أوضح إشارة حظر
const MIN_GAP_MS = Number(process.env.WA_BRIDGE_MIN_GAP_MS || 8000);
const MAX_GAP_MS = Number(process.env.WA_BRIDGE_MAX_GAP_MS || 25000);

if (!KEY) {
  console.error('✖ ينقص WA_BRIDGE_KEY. اضبطه بنفس قيمته على Render ثم أعد التشغيل.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => MIN_GAP_MS + Math.floor(Math.random() * Math.max(1, MAX_GAP_MS - MIN_GAP_MS));
const log = (...a) => console.log(new Date().toLocaleTimeString('ar-SA'), ...a);

// ------------------------------- نداء الخادم ------------------------------- //

async function api(path, body, method = 'POST') {
  try {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: { 'x-bridge-key': KEY, 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    if (!r.ok) {
      log(`⚠ ${path} → HTTP ${r.status}`);
      return null;
    }
    return await r.json();
  } catch (e) {
    // انقطاع الشبكة لا يُسقط الجسر — الدورة التالية تعيد المحاولة
    log(`⚠ ${path} → ${e.message}`);
    return null;
  }
}

// ------------------------------- عميل واتساب ------------------------------- //

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', async (qr) => {
  log('▸ رمز QR جديد — افتح لوحة المالك ← واتساب ← امسح الرمز بهاتفك');
  const dataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
  await api('/qr', { qr: dataUrl });
});

client.on('authenticated', () => log('▸ تمّ التوثيق — جارٍ التجهيز...'));

client.on('ready', async () => {
  const me = client.info;
  const phone = me?.wid?.user || null;
  log(`✓ متصل بالرقم ${phone || '؟'} — الجسر يعمل`);
  await api('/status', { status: 'CONNECTED', phone, pushName: me?.pushname || null });
});

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
      waId: msg.id?._serialized || `${phone}_${Date.now()}`,
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

// ------------------------------- حلقة الطابور ------------------------------- //

let busy = false;

async function tick() {
  if (busy) return; // دورة سابقة ما زالت ترسل — لا نُراكم
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
      const gap = jitter();
      log(`  … انتظار ${Math.round(gap / 1000)}ث قبل ${m.phone}`);
      await sleep(gap);
      try {
        const chatId = `${m.phone}@c.us`;
        // نتحقّق أن الرقم على واتساب أصلاً — الإرسال لأرقام غير مسجّلة إشارة سلبية قويّة
        const registered = await client.isRegisteredUser(chatId);
        if (!registered) {
          await api('/result', { id: m.id, ok: false, error: 'الرقم غير مسجّل على واتساب' });
          log(`  ✖ ${m.phone} غير مسجّل على واتساب`);
          continue;
        }
        const sent = await client.sendMessage(chatId, m.body);
        await api('/result', { id: m.id, ok: true, waId: sent?.id?._serialized || null });
        log(`  ✓ أُرسلت إلى ${m.phone}`);
      } catch (e) {
        await api('/result', { id: m.id, ok: false, error: e.message });
        log(`  ✖ فشل ${m.phone}: ${e.message}`);
      }
    }
  } finally {
    busy = false;
  }
}

// ------------------------------- الإقلاع ------------------------------- //

log('▸ جسر واتساب — Field Sales');
log(`▸ الخادم: ${API}`);
client.initialize();
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
