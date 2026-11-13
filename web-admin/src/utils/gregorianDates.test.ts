import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeLocale, gregorianLocale, setActiveNumerals } from './format';
import { useLang } from '../i18n/lang';

/**
 * «التاريخ الميلادي في جميع الصفحات بلا استثناء، وأزل التاريخ الهجري نهائياً» (طلب المالك ١٣ نوفمبر ٢٠٢٦).
 * ar-SA تقويمه الافتراضي في Safari/iOS وبعض WebView أندرويد أمّ القرى، وبلا locale يتبع إعداد الجهاز (قد يكون هجرياً) —
 * فكل تنسيق تاريخٍ أو وقت يمرّ بتقويمٍ ميلادي صريح: gregorianLocale(…) أو activeLocale() (وفيه ca-gregory) أو locale إنجليزي
 * (en-*، ميلاديٌّ دائماً) أو خيار calendar: 'gregory'.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED = /gregor|activeLocale\(\)|['"`]en-[A-Z]{2}|calendar:\s*['"]gregory/;
/** ملفّا المساعد نفسه: locale() الداخلي ميلاديٌّ (يثبته الاختبار الأول تشغيلاً)، وDateTimeFormat() بلا وسائط لقراءة لغة الجهاز وحدها */
const EXEMPT = /[\\/]utils[\\/](format|dateLocale)\.ts$/;
/** toLocaleString على **تاريخ** (لا على رقم): المستقبِل تاريخٌ ظاهر — new Date(…) أو اسمٌ ينتهي بـDate/date/At/Time أو d/dt/when */
const DATE_RECEIVER = /(new Date\([^()]*(\([^()]*\)[^()]*)*\)|\b\w*(Date|date|At|Time|time)|\b(d|dt|when|day|stamp))\s*\)?\s*$/;

function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__preview') files(p, out); continue; }
    if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$|\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** نصّ وسائط النداء من القوس المفتوح إلى قوسه المغلق (متوازن تقريباً) */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length && i < open + 600; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return src.slice(open, open + 600);
}

test('gregorianLocale: ميلاديٌّ دائماً — ويستبدل التقويم الهجري الصريح ويحفظ نظام الترقيم', () => {
  for (const l of ['ar-SA', 'ar-SA-u-nu-latn', 'ar-SA-u-nu-arab', 'ar-SA-u-ca-islamic-umalqura-nu-arab', 'ar-SA-u-nu-latn-ca-islamic', 'ar', 'en-US', undefined, '']) {
    const g = gregorianLocale(l as string | undefined);
    assert.equal(new Intl.DateTimeFormat(g).resolvedOptions().calendar, 'gregory', `${String(l)} ⇒ ${g}`);
    assert.doesNotMatch(new Intl.DateTimeFormat(g, { year: 'numeric' }).format(new Date('2026-11-13T10:00:00Z')), /١٤٤٨|1448|هـ/);
  }
  assert.equal(gregorianLocale('ar-SA-u-nu-latn'), 'ar-SA-u-ca-gregory-nu-latn');
  assert.equal(gregorianLocale('ar-SA-u-ca-islamic-umalqura-nu-arab'), 'ar-SA-u-ca-gregory-nu-arab');
});

test('activeLocale ميلاديٌّ في كل لغات الواجهة وبنظامي الترقيم', () => {
  const prev = useLang.getState().lang;
  try {
    for (const lang of ['ar', 'en', 'fr', 'tr', 'zh'] as const) {
      for (const nu of ['arabic', 'latin'] as const) {
        useLang.setState({ lang } as never);
        setActiveNumerals(nu);
        assert.equal(new Intl.DateTimeFormat(activeLocale()).resolvedOptions().calendar, 'gregory', `${lang}/${nu} ⇒ ${activeLocale()}`);
      }
    }
  } finally { useLang.setState({ lang: prev } as never); setActiveNumerals('arabic'); }
});

test('لا تنسيق تاريخٍ بلا تقويمٍ ميلادي صريح في أي ملف', () => {
  const bad: string[] = [];
  for (const f of files(ROOT)) {
    if (EXEMPT.test(f)) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const re of [/\.toLocaleDateString\(/g, /\.toLocaleTimeString\(/g, /\bDateTimeFormat\(/g]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const args = argsAt(src, m.index + m[0].length - 1);
        if (!ALLOWED.test(args)) bad.push(`${path.relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length} ${m[0]}${args.slice(0, 60)}`);
      }
    }
    // toLocaleString على تاريخٍ ظاهر (لا على رقم — الرقم لا تقويم له)
    const ls = /\.toLocaleString\(/g;
    let m: RegExpExecArray | null;
    while ((m = ls.exec(src))) {
      const lineStart = src.lastIndexOf('\n', m.index) + 1;
      if (!DATE_RECEIVER.test(src.slice(Math.max(lineStart, m.index - 80), m.index))) continue;
      const args = argsAt(src, m.index + m[0].length - 1);
      if (!ALLOWED.test(args)) bad.push(`${path.relative(ROOT, f)}:${src.slice(0, m.index).split('\n').length} .toLocaleString${args.slice(0, 60)}`);
    }
  }
  assert.deepEqual(bad, [], `تنسيق تاريخٍ قد يظهر هجرياً — مرّره بـgregorianLocale:\n${bad.join('\n')}`);
});
