/**
 * معرّف حزمة الواجهة (Z5.0): يُحقن وقت البناء عبر Vite `define` (vite.config.ts). تبلغه نبضة المندوب للخادم
 * (SalesRep.clientBundle) فتعرف جاهزية التفعيل (Z5.8) أي الأجهزة على حزمة قديمة. خارج Vite (الاختبارات) = 'dev'.
 */
declare const __BUILD_ID__: string | undefined;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' && __BUILD_ID__ !== '' ? __BUILD_ID__ : 'dev';
