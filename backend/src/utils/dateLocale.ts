/**
 * التقويم الميلادي صريحاً في كل تاريخٍ يكتبه الخادم (رسائل البريد وواتساب والإشعارات والمستندات) — طلب المالك ١٣ نوفمبر ٢٠٢٦:
 * «التاريخ الميلادي في جميع الصفحات بلا استثناء، وأزل التاريخ الهجري نهائياً». نسخةٌ من gregorianLocale في
 * web-admin/src/utils/format.ts: يضع `ca-gregory` في امتداد -u- ويستبدل أي تقويمٍ آخر (islamic-umalqura وأمثاله) ويحفظ ما سواه.
 * ar-SA تقويمه الافتراضي في بعض نسخ ICU أمّ القرى الهجري، فلا تنسيق تاريخٍ بلا هذا المفتاح.
 */
export function gregorianLocale(loc?: string | null): string {
  let base = (loc ?? '').trim();
  if (!base) {
    try { base = new Intl.DateTimeFormat().resolvedOptions().locale || 'ar'; } catch { base = 'ar'; }
  }
  const i = base.toLowerCase().indexOf('-u-');
  if (i < 0) return `${base}-u-ca-gregory`;
  const head = base.slice(0, i);
  // مفاتيح الامتداد أزواج «مفتاح-قيمة(ـقيم)»: يُسقط ca بقيمه ثم يوضع ca-gregory أولاً
  const parts = base.slice(i + 3).split('-');
  const kept: string[] = [];
  for (let k = 0; k < parts.length; k++) {
    if (parts[k].toLowerCase() === 'ca') { while (k + 1 < parts.length && parts[k + 1].length > 2) k++; continue; }
    kept.push(parts[k]);
  }
  return `${head}-u-ca-gregory${kept.length ? `-${kept.join('-')}` : ''}`;
}
