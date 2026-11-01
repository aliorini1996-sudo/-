/**
 * UUID v4 بلا افتراضٍ عن المتصفّح — مصدرٌ واحد لمراجع الإعادة الآمنة (clientRef للمندوب، zeroRef لتصفير المخزون):
 * crypto.randomUUID غائبٌ في المتصفّحات الأقدم وفي السياق غير الآمن (http بلا localhost)، واستدعاؤه بلا حارسٍ في مُهيِّئ
 * useState يُسقط النافذة كلّها. فالاحتياط بالترتيب: randomUUID ← v4 من getRandomValues ← v4 من Math.random.
 * والخادم يتحقّق بـz.string().uuid() فالاحتياط بصيغة v4 نفسها (النسخة 4 والمتغيّر 8–b).
 */
export function newUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* سياقٌ غير آمن أو تنفيذٌ يرمي — إلى الاحتياط */ }
  const b = new Uint8Array(16);
  let filled = false;
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') { crypto.getRandomValues(b); filled = true; }
  } catch { /* إلى Math.random */ }
  if (!filled) for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40; // النسخة 4
  b[8] = (b[8] & 0x3f) | 0x80; // المتغيّر RFC 4122
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
