/**
 * حارس حقائق الكيان — يفحص **مخرجات البناء** (dist/) أو نسخة الموقع الحيّ، ويفشل إن ناقضت حقائق
 * src/content/entity-facts.mjs. خطة GEO العالمية، البند ١٠، بتصحيحَي نقدها (البندان ٢ و٣).
 *
 * لماذا حارس مستقل عن verify-claims: ذاك يمنع الادّعاء **المحظور** (اعتماد الهيئة، مواعيد، منافسون)،
 * وهذا يمنع **تضارب الحقائق** بين الأسطح. وأكبر عيب GEO اليوم من هذا النوع: الواجهة تقول «كل الدول»
 * وما تقرؤه الزواحف التي لا تشغّل JavaScript (GPTBot وClaudeBot…) يقول «Arab markets» و«22 Arab League».
 *
 * ما يُفحص، وأين (الأسطح لا المتن، بتصحيح النقد ٢: المتن العربي يصف السوق ولا يُمنع):
 *  1. arab-scope — «22 Arab» و«Arab League countries» و«Arab markets» ونظائرها بالفرنسية والتركية والصينية،
 *     و«22 دولة عربية» و«دول الجامعة العربية» بالعربية: في عنوان كل صفحة ووصفها وog وtwitter وkeywords وH1،
 *     وفي كل نصوص JSON-LD، وفي ملفات llms*.txt كلها (هي فهرس عناوين وأوصاف).
 *     «في الأسواق العربية» في عناوين المقالات العربية **مسموحة** هنا (النقد ٢).
 *  2. arab-scope-entity — حصر التغطية في سطح الكيان نفسه: «Arab world» و«monde arabe» و«Arap dünyası»
 *     و«阿拉伯世界» و«الأسواق العربية» و«العالم العربي»: في رؤوس الرئيسيات وصفحات «عن الشركة»، وعُقد
 *     Organization وSoftwareApplication وWebSite في JSON-LD، ورأس llms وقسم Company فيه.
 *  3. area-served — areaServed في عقدة الكيان قائمة دول لا قيمة عالمية.
 *  4. ui-languages — جملة تذكر لغات واجهة التطبيق بقائمة تخالف الحقائق (ar en fr tr zh)، في الرؤوس وJSON-LD
 *     وllms ومتن صفحات الكيان، وavailableLanguage/inLanguage حين تكون قائمة في عقدة التطبيق.
 *     جمل لغات الموقع والمقالات ولغات الفاتورة المطبوعة ليست لغات الواجهة فلا تُفحص.
 *  5. gov-einvoice-abroad — ادّعاء ربط بمنظومة فوترة حكومية خارج السعودية (ETA وPeppol وTTN وKSeF وCFDI…)
 *     أو «الربط الحكومي» عامةً، بلا «عند الطلب» ولا نفي: في الرؤوس وJSON-LD وllms ومتن صفحات الكيان.
 *  6. org-facts — عقدة ‎#organization‎: سنة التأسيس والمقر وصيغ الاسم والبريد والهاتف، وروابط تحميل التطبيق.
 *
 * التشغيل:
 *   node scripts/verify-facts.mjs [--dist <مجلد>]           بعد البناء (الافتراضي web-admin/dist)
 *   node scripts/verify-facts.mjs --live [<الأصل>] [--sitemap <N>]
 *        يجلب (GET فقط) الرئيسيات وصفحات «عن الشركة» وllms، وN صفحة موزّعة بالتساوي من خريطة الموقع
 *   --all-body   يمدّ فحصَي اللغات والربط الحكومي إلى متن كل الصفحات (تدقيق يدوي، لا بوابة بناء)
 *   --json       المخرج JSON
 *   --samples <N> عدد الأمثلة لكل مطابقة (الافتراضي 3)
 *   --probe "<نص>" يشرح حكم الحارس على نصّ واحد (الجمل والعبارات واللغات المكتشفة) ويخرج — لضبط الأنماط
 *
 * غير مربوط بـpackage.json بعد (خطة GEO: يُربط بـpostbuild بعد أن تُصلح المرحلة أ ما يكشفه اليوم).
 * الخروج 1 إن وُجد بند حاجب، و0 إن لم يوجد إلا تحذيرات.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getFacts, IDS, NAME, UI_LANGS, normalizeProfileUrl, storeUrls,
} from '../src/content/entity-facts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

const FACTS = getFacts();
const LIVE = has('--live');
const ORIGIN = (LIVE && opt('--live')) || FACTS.origin;
const DIST = path.resolve(opt('--dist') || path.join(__dirname, '../dist'));
const SITEMAP_N = Number(opt('--sitemap') || 0);
const ALL_BODY = has('--all-body');
const AS_JSON = has('--json');
const SAMPLES = Number(opt('--samples') || 3);
const UA = 'Mozilla/5.0 (compatible; fieldsa-verify-facts/1.0; +https://fieldsa.net/llms.txt)';

// ————————————————————————————————————————————————————————————————————————————————
// تطبيع النص
// ————————————————————————————————————————————————————————————————————————————————

const decode = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** حذف التشكيل والتطويل (كـnorm في claims-rules.mjs) وتوحيد المسافات مع إبقاء حدود الأسطر */
const norm = (s) => decode(s)
  .replace(/[ً-ْٰـ]/g, '')
  .replace(/[ \t\r\f\v ]+/g, ' ')
  .replace(/ ?\n[ \n]*/g, '\n')
  .trim();
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const stripTags = (h) => String(h)
  .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
  .replace(/<\/(?:p|li|h[1-6]|div|td|th|tr|section|article|header|footer|ul|ol|table|blockquote|dd|dt|figcaption)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ');

// ————————————————————————————————————————————————————————————————————————————————
// الأنماط
// ————————————————————————————————————————————————————————————————————————————————

// حدود الكلمة العربية بـ\p{L} لا بنطاق U+0600–U+06FF: «،» و«؛» و«؟» داخل ذلك النطاق، فكانت «والفرنسية،»
// لا تُعدّ لغة و«الأسواق العربية،» لا تُعدّ سوقاً.

/** ١ — حصر التغطية في الدول العربية (كل الرؤوس وJSON-LD وllms) */
const ARAB_SCOPE = [
  /\b22\s+Arab\b|\bArab\s+League\s+(?:countries|states|members?)\b|\bArab\s+markets?\b/giu,
  /\b22\s+pays\s+arabes\b|\bpays\s+de\s+la\s+Ligue\s+arabe\b|\bmarch[ée]s?\s+arabes?\b/giu,
  /\b22\s+Arap\s+ülke\p{L}*|\bArap\s+Birliği\s+ülke\p{L}*|\bArap\s+pazar\p{L}*/giu,
  /22\s*个?阿拉伯国家|阿拉伯联盟(?:国家|成员国)|阿盟(?:国家|成员国)|阿拉伯市场/gu,
  new RegExp([
    `(?:22|٢٢)\\s*دول[ةه]?\\s*عربي[ةه]`,
    `(?:ال)?دول\\s*(?:ال)?عربي[ةه]\\s*(?:ال)?(?:22|٢٢)`,
    `دول\\s*(?:ال)?جامع[ةه]\\s*(?:ال)?(?:دول\\s*(?:ال)?)?عربي[ةه]`,
    `جامع[ةه]\\s*(?:ال)?دول\\s*(?:ال)?عربي[ةه]`,
  ].join('|'), 'gu'),
];

/** ٢ — وصف الكيان نفسه بسوق عربية (أسطح الكيان وحدها) */
const ARAB_ENTITY = [
  /\bArab\s+(?:world|region)\b|\bArabic-speaking\s+(?:markets?|countries)\b/giu,
  /\bmonde\s+arabe\b|\bpays\s+arabes\b/giu,
  /\bArap\s+dünya\p{L}*|\bArap\s+ülke\p{L}*/giu,
  /阿拉伯世界|阿拉伯国家|阿拉伯地区/gu,
  new RegExp(`(?<!\\p{L})(?:[وبف]?(?:بال|لل|ال)|في\\s*ال)?(?:[أا]سواق|عالم|دول|بلدان|منطق[ةه])\\s*(?:ال)?عربي[ةه]?(?!\\p{L})`, 'gu'),
];

/** أسماء اللغات بكل لغة كتابة — لكشف قوائم اللغات (الخمس وأشهر غيرها) */
const LATIN_LANGS = {
  ar: ['Arabic', 'arabe', 'Arapça'],
  en: ['English', 'anglais', '[İI]ngilizce'],
  fr: ['French', 'fran[çc]ais', 'Fransızca'],
  tr: ['Turkish', 'turc', 'Türkçe'],
  zh: ['Chinese', 'Mandarin', 'chinois', 'Çince'],
  es: ['Spanish', 'espagnol', '[İI]spanyolca'],
  pt: ['Portuguese', 'portugais', 'Portekizce'],
  de: ['German', 'allemand', 'Almanca'],
  ru: ['Russian', 'russe', 'Rusça'],
  ja: ['Japanese', 'japonais', 'Japonca'],
  ko: ['Korean', 'cor[ée]en', 'Korece'],
  hi: ['Hindi', 'Hintçe'],
  ur: ['Urdu', 'ourdou', 'Urduca'],
  fa: ['Persian', 'Farsi', 'persan', 'Farsça'],
  he: ['Hebrew', 'h[ée]breu', '[İI]branice'],
  id: ['Indonesian', 'indon[ée]sien', 'Endonezce'],
  it: ['Italian', 'italien', '[İI]talyanca'],
};
const CJK_LANGS = {
  ar: ['阿拉伯语', '阿拉伯文'], en: ['英语', '英文'], fr: ['法语', '法文'], tr: ['土耳其语', '土耳其文'],
  zh: ['中文', '汉语', '华语'], es: ['西班牙语'], pt: ['葡萄牙语'], de: ['德语'], ru: ['俄语'], ja: ['日语', '日文'],
  ko: ['韩语', '朝鲜语'], hi: ['印地语'], ur: ['乌尔都语'], fa: ['波斯语'], he: ['希伯来语'], id: ['印尼语'], it: ['意大利语'],
};
/** الاسم العربي للغة صفةٌ بعد «ال»؛ ولا يُعدّ لغةً إن تلا اسماً مثل «الأسواق العربية» و«الجمهورية التركية» */
const AR_STEMS = {
  ar: 'عربي[ةه]', en: '[إا]ن[جك]ليزي[ةه]', fr: 'فرنسي[ةه]', tr: 'تركي[ةه]', zh: 'صيني[ةه]', es: '[إا]سباني[ةه]',
  pt: 'برتغالي[ةه]', de: '[أا]لماني[ةه]', ru: 'روسي[ةه]', ja: 'ياباني[ةه]', ko: 'كوري[ةه]', hi: 'هندي[ةه]',
  ur: '[أا]ردي[ةه]', fa: 'فارسي[ةه]', he: 'عبري[ةه]', id: '[إا]ندونيسي[ةه]', it: '[إا]يطالي[ةه]',
};
const AR_NOUN_BEFORE = '(?:[أا]سواق|سوق|دول|بلدان|منطق[ةه]|جامع[ةه]|مملك[ةه]|[إا]مارات|جمهوري[ةه]|شركات|شرك[ةه]|مدن|لير[ةه]|عمل[ةه]|حكوم[ةه]|هيئ[ةه]|منتجات|بضائع)';
/** «arabe» صفةٌ في «monde arabe» و«pays arabes» لا اسم لغة */
const FR_ARABE_NOT_LANG = '(?<!(?:monde|pays|march[ée]s?|r[ée]gion|Ligue|[ÉE]tats?|monarchies?)\\s)';
const LANG_RES = Object.fromEntries(Object.keys(LATIN_LANGS).map((code) => [code, new RegExp([
  `(?<![\\p{L}\\p{N}])(?:${LATIN_LANGS[code].map((w) => (w === 'arabe' ? FR_ARABE_NOT_LANG + w : w)).join('|')})(?![\\p{L}])`,
  CJK_LANGS[code].join('|'),
  `(?<!${AR_NOUN_BEFORE}\\s{1,3})(?<!\\p{L})[وف]?(?:بال|لل|ال)${AR_STEMS[code]}(?!\\p{L})`,
  // «بواجهة عربية» و«الواجهة عربية»: اسم اللغة صفةٌ للواجهة نفسها
  `واجه[ةه]\\s+(?:ال)?${AR_STEMS[code]}(?!\\p{L})`,
].join('|'), 'iu')]));
const LATIN_LANG_WORDS = Object.values(LATIN_LANGS).flat().join('|');

const mentionedLangs = (s) => new Set(Object.keys(LANG_RES).filter((code) => LANG_RES[code].test(s)));
/** موضع أول اسم لغة في النص (أو -1) */
const firstLangIndex = (s) => {
  let best = -1;
  for (const re of Object.values(LANG_RES)) {
    const i = s.search(re);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
};
/** أقرب مسافة بين موضع i وأي مطابقة للنمط (Infinity إن لم يطابق) */
const nearest = (re, s, i) => {
  let best = Infinity;
  for (const m of s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    best = Math.min(best, Math.abs(m.index - i), Math.abs(m.index + m[0].length - i));
  }
  return best;
};

/** مفردات الواجهة والتطبيق، والإتاحة، والمحتوى (موقع ومقالات)، ولغات المستند المطبوع */
const APP_KW = /(?<![\p{L}])(?:apps?|application|applications|interfaces?|UI|dashboards?|software|platform|system|product|appli|logiciel|plateforme|syst[èe]me|tableau\s+de\s+bord)(?![\p{L}])|uygulama\p{L}*|arayüz\p{L}*|yazılım\p{L}*|(?<![\p{L}])platform\p{L}*|(?<![\p{L}])sistem\p{L}*|应用|界面|软件|平台|系统|(?:ال)?تطبيق(?:ات)?|(?:ال)?واجه[ةه]|(?:ال)?نظام|(?:ال)?منص[ةه]|(?:ال)?برنامج|(?:ال)?لوح[ةه]/iu;
const AVAIL_KW = /\b(?:available|runs?|works?|offered)\s+in\b|disponible\s+en|fonctionne\s+en|propos[ée]e?s?\s+en|kullanılabilir|mevcut|çalışır|支持|提供|متاح[ةه]?|متوفر[ةه]?|يعمل|تعمل|يدعم|تدعم|بلغات|باللغات/iu;
const CONTENT_KW = /(?<![\p{L}])(?:website|web\s*site|site|blog|pages?|guides?|articles?|posts?|content|home\s*pages?)(?![\p{L}])|web\s*sitesi|sayfa\p{L}*|rehber\p{L}*|makale\p{L}*|网站|博客|页面|首页|指南|文章|(?:ال)?موقع|(?:ال)?مدون[ةه]|صفح[ةه]|صفحات|[أا]دل[ةه]|دليل|مقال(?:ات)?/iu;
const DOC_KW = /bilingual|invoic\w*|receipts?|vouchers?|print\w*|templates?|\bPDF\b|statements?|\bquotes?\b|فاتور|فواتير|سند|ثنائي|طباع|يطبع|تطبع|نموذج|نماذج|كشف|عرض\s*سعر|factur\w*|re[çc]us?|bilingue|imprim\w*|mod[èe]les?|devis|fatura\p{L}*|makbuz\p{L}*|şablon\p{L}*|yazdır\p{L}*|发票|收据|双语|打印|模板|报价/iu;
const ONLY_KW = /\bonly\b|\bexclusively\b|uniquement|seulement|sadece|yalnızca|仅|只有|فقط|وحده|وحدها/iu;

/** ٥ — منظومات فوترة حكومية خارج السعودية (الاختصارات بحالة أحرفها، والعبارات بلا حساسية لها) */
const GOV_NAMED = new RegExp([
  '\\bETA\\b', '\\bPeppol\\b|\\bPEPPOL\\b', '\\bTTN\\b', '\\bKSeF\\b', '\\bCFDI\\b', '\\bNF-?e\\b', '\\bSEFAZ\\b', '\\bDIAN\\b',
  '\\bGİB\\b', '\\bLHDN\\b', '\\bIRN\\b', '\\bIRP\\b', '\\bFBR\\b', '\\beTIMS\\b', '\\bKRA\\b', '\\bFIRS\\b', '\\bBIR\\s+EIS\\b', '\\bSdI\\b',
].join('|'), 'u');
const GOV_NAMED_I = /Egyptian\s+Tax\s+Authority|مصلح[ةه]\s*الضرائب(?:\s*المصري[ةه])?|منظوم[ةه]\s*الفاتور[ةه]\s*الإلكتروني[ةه]\s*المصري[ةه]|El[\s-]?Fatoura|Tunisie\s+TradeNet|\be-?Factura\b|XRechnung|ZUGFeRD|Factur-?X|Chorus\s*Pro|FatturaPA|Sistema\s+di\s+Interscambio|Veri\*?Factu|TicketBAI|e-?Arşiv|MyInvois|e-?Faktur\b|Coretax|全电发票|金税|適格請求書|전자세금계산서|مودیان|hóa\s*đơn\s*điện\s*tử/iu;
const GOV_GENERIC = /government\s+e-?invoic\w*|(?:tax\s+authorit(?:y|ies)|national|state)\s+e-?invoic\w*\s+(?:platform|system|portal)s?|plateforme\s+(?:de\s+)?facturation\s+(?:[ée]lectronique\s+)?(?:gouvernementale|de\s+l['’][ÉE]tat|publique)|devlet\s+e-?fatura\p{L}*|政府电子发票|税务(?:局|机关)(?:电子发票)?(?:平台|系统)|منص[ةه]\s*(?:ال)?فوتر[ةه]\s*(?:ال)?(?:[إا]لكتروني[ةه]\s*)?(?:ال)?حكومي[ةه]|(?:ال)?منظوم[ةه]\s*(?:ال)?حكومي[ةه]|(?:ال)?ربط\s*(?:ال)?حكومي/iu;
const GOV_CLAIM = /\bwe\s+(?:also\s+)?(?:support|integrate|connect|submit)|\bsupports?\b|\bsupported\b|\bintegrat(?:es|ed|ion)\b|\bconnect(?:s|ed|ion)?\b|\blinked\b|\bcompliant\b|\bready\s+for\b|\bworks\s+with\b|prend\w*\s+en\s+charge|int[ée]gr\w*|connect[ée]\w*|connexion|\bconforme\b|\bcompatible\b|destekl\p{L}*|entegr\p{L}*|bağlan\p{L}*|bağlant\p{L}*|uyumlu|支持|对接|集成|接入|兼容|(?<!\p{L})[وف]?(?:ندعم|يدعم|تدعم|مدعوم[ةه]?|(?:ال|بال)?ربط|مربوط[ةه]?|مرتبط[ةه]?|متوافق[ةه]?|متكامل[ةه]?|(?:ال|بال)?تكامل|يتكامل|نتكامل|متصل[ةه]?)(?!\p{L})|(?<!\p{L})جاهز(?:ون|[ةه])?\s*لل?/iu;
// «حسب متطلبات كل منشأة» إتاحة عند الطلب لا ادّعاء ربط قائم
const ON_REQUEST = /عند\s*الطلب|(?:ب)?حسب\s*(?:الطلب|متطلبات|حاج[ةه])|selon\s+les\s+besoins|on\s+request|upon\s+request|on\s+demand|sur\s+demande|à\s+la\s+demande|talep\s+(?:üzerine|halinde|edil)|按需|根据需求|可申请/iu;
const NEGATION = /\bnot\s+(?:yet\s+)?(?:built|implemented|supported|available|integrated|connected|live|offered)|\bno\s+(?:integration|connection)\b|\bdoes\s*n[o']t\b|\bdon['’]t\b|\bisn['’]t\b|n['’]est\s+pas|\bne\s+\S+\s+pas\b|\bpas\s+encore\b|değil|desteklenmi|尚未|不支持|未对接|暂不|غير\s*(?:مبني|متاح|مدعوم|مربوط|مرتبط|منفذ)|لا\s*(?:ندعم|نربط|يدعم|تدعم|يوجد|يتوفر)|لم\s*(?:نبن|ندعم|نربط|يتم|تنفذ)|ليس|ليست/iu;
const SAUDI_CTX = /ZATCA|Fatoora|منص[ةه]\s*«?فاتور[ةه]|هيئ[ةه]\s*الزكا[ةه]|السعودي|Saudi|Suudi|沙特|saoudite/iu;

const ENTITY_TYPES = new Set(['Organization', 'Corporation', 'LocalBusiness', 'SoftwareApplication', 'MobileApplication', 'WebApplication', 'WebSite', 'ContactPoint']);
const APP_TYPES = new Set(['SoftwareApplication', 'MobileApplication', 'WebApplication']);
const PROSE_SKIP = /^(?:url|sameAs|logo|image|item|mainEntityOfPage|downloadUrl|installUrl|email|telephone|contentUrl|thumbnailUrl|embedUrl|target|urlTemplate|@\w+|datePublished|dateModified|foundingDate|priceCurrency|price|lowPrice|highPrice|inLanguage|availableLanguage|addressCountry|addressLocality|postalCode)$/;
const HEAD_META = new Set(['description', 'keywords', 'og:title', 'og:description', 'og:site_name', 'twitter:title', 'twitter:description']);

// ————————————————————————————————————————————————————————————————————————————————
// تقطيع الجمل والعبارات
// ————————————————————————————————————————————————————————————————————————————————

const sentences = (text) => String(text)
  .split(/(?<=[.!?؟])\s+|(?<=[。！？])\s*|\n+|\s+[·•|]\s+/u)
  .map((s) => s.trim().replace(/^(?:[-*>•]\s*)+/, ''))
  .filter(Boolean);

const CLAUSE_SPLIT = new RegExp([
  // «…, and the apps are…» تُقطع، و«Arabic, English, and French» لا تُقطع (يليها اسم لغة)
  `,\\s*(?:and|while|but|whereas|et|mais|tandis\\s+que|ve|ama|ancak|fakat)\\s+(?!(?:also\\s+|aussi\\s+|ayrıca\\s+)?(?:${LATIN_LANG_WORDS})(?![\\p{L}]))`,
  '\\s+(?:while|whereas|tandis\\s+que|ancak|fakat)\\s+',
  '\\s+(?:بينما|لكن|غير\\s+[أا]ن)\\s+',
  '[，；;]',
  // «Title: description» في llms، و«Languages: …»: النقطتان بمسافة بعدهما (لا «https://»)
  '[:：]\\s+',
  // «…، والتطبيقات…» تُقطع، و«بالعربية، والإنجليزية» لا تُقطع
  `،\\s*(?=و(?!(?:بال|لل|ال)(?:${Object.values(AR_STEMS).join('|')})))`,
].join('|'), 'iu');
const clauses = (sentence) => sentence.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);

const setStr = (s) => `{${[...s].sort().join(', ')}}`;
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const UI = new Set(UI_LANGS);

/** جمل تذكر لغات الواجهة بقائمة تخالف الحقائق */
function languageClaims(text) {
  const out = [];
  for (const s of sentences(text)) {
    if (s.length > 1200) continue; // كتلة بلا ترقيم (قائمة روابط) لا جملة
    for (const c of clauses(s)) {
      const langs = mentionedLangs(c);
      if (!langs.size) continue;
      const at = firstLangIndex(c);
      const app = nearest(APP_KW, c, at);
      const content = nearest(CONTENT_KW, c, at);
      // قائمة اللغات تتبع أقرب موصوف لها: «guides in Arabic, English and French» لغات محتوى ولو ذُكرت المنصة قبلها
      if (content < app) continue;
      if (app === Infinity && !AVAIL_KW.test(c)) continue; // لا موصوف: تكفي عبارة إتاحة («Disponible en…»)
      if (DOC_KW.test(c)) continue; // لغات المستند المطبوع لا لغات الواجهة
      if (langs.size < 2 && !ONLY_KW.test(c)) continue;
      if (sameSet(langs, UI)) continue;
      out.push({ match: c, note: `اللغات ${setStr(langs)} ≠ الحقائق ${setStr(UI)}` });
    }
  }
  return out;
}

/** جمل تدّعي ربطاً بمنظومة فوترة حكومية خارج السعودية */
function govClaims(text) {
  const out = [];
  for (const s of sentences(text)) {
    if (s.length > 1200) continue;
    if (/[?؟？]\s*$/.test(s)) continue; // السؤال ليس ادّعاء
    const named = s.match(GOV_NAMED) || s.match(GOV_NAMED_I);
    const generic = !named && s.match(GOV_GENERIC);
    if (!named && !generic) continue;
    if (!GOV_CLAIM.test(s)) continue;
    if (ON_REQUEST.test(s) || NEGATION.test(s)) continue;
    if (generic && SAUDI_CTX.test(s)) continue; // «الربط الحكومي» في سياق السعودية حقيقة لا ادّعاء
    out.push({ match: s, note: `منظومة: ${(named || generic)[0]}` });
  }
  return out;
}

const regexHits = (res, text) => {
  const out = [];
  for (const re of res) for (const m of String(text).matchAll(re)) out.push({ match: m[0], index: m.index });
  return out;
};

// ————————————————————————————————————————————————————————————————————————————————
// استخراج الأسطح
// ————————————————————————————————————————————————————————————————————————————————

function jsonLdNodes(html) {
  const nodes = [];
  const errors = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let root;
    try { root = JSON.parse(m[1]); } catch (e) { errors.push(e.message); continue; }
    const visit = (v, owner, key) => {
      if (typeof v === 'string') {
        if (owner && !PROSE_SKIP.test(key) && !/^https?:\/\//i.test(v)) owner.strings.push({ key, text: norm(v) });
        return;
      }
      if (Array.isArray(v)) { v.forEach((x) => visit(x, owner, key)); return; }
      if (!v || typeof v !== 'object') return;
      const types = [].concat(v['@type'] || []).map(String);
      let node = owner;
      if (types.length || v['@id']) {
        const entity = types.some((t) => ENTITY_TYPES.has(t)) || Object.values(IDS).includes(v['@id']) || !!owner?.entity;
        node = { types, id: v['@id'] || null, obj: v, parent: owner, entity, strings: [] };
        nodes.push(node);
      }
      for (const [k, val] of Object.entries(v)) {
        if (k === '@context' || k === '@type' || k === '@id') continue;
        visit(val, node, k);
      }
    };
    visit(root, null, '');
  }
  return { nodes, errors };
}

// صفحات الكيان: الرئيسية و«عن الشركة» و/profile بكل بادئة لغة. البادئة رمز لغة (en وpt-br…) لا مسار تطبيق
// بحرفين (ax بوابة السفير، hx بوابة الصيد — src/components/WhatsAppFab.tsx: HIDDEN_ON).
const APP_PREFIXES = new Set(['ax', 'hx', 'rep', 'app', 'pos', 'kds', 'pay', 'm', 'c', 'e']);
const LOCALE_DIR = /^([a-z]{2,3}(?:-[a-z0-9]+)?)\//i;
const isEntityPage = (name) => {
  const m = name.match(LOCALE_DIR);
  const rest = m && !APP_PREFIXES.has(m[1].toLowerCase()) ? name.slice(m[0].length) : name;
  return /^(?:(?:about|profile)\/)?index\.html$/i.test(rest);
};

function parseHtml(name, html) {
  const head = [];
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) head.push({ surface: 'title', text: norm(stripTags(t[1])) });
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = ((m[0].match(/\b(?:name|property)\s*=\s*"([^"]+)"/i) || [])[1] || '').toLowerCase();
    if (!HEAD_META.has(key)) continue;
    const content = (m[0].match(/\bcontent\s*=\s*"([^"]*)"/i) || [])[1];
    if (content) head.push({ surface: key, text: norm(content) });
  }
  for (const m of html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) head.push({ surface: 'h1', text: norm(stripTags(m[1])) });
  const { nodes, errors } = jsonLdNodes(html);
  const bodyHtml = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
  const body = norm(stripTags(bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')));
  return { name, kind: 'html', entityPage: isEntityPage(name), head, nodes, ldErrors: errors, body };
}

function parseLlms(name, text) {
  const t = norm(text);
  const first = t.search(/^## /m);
  const pre = first < 0 ? t : t.slice(0, first);
  const entitySections = [...t.matchAll(/^## (?:Company|About|Key facts|الشركة|عن\s[^\n]*)\n[\s\S]*?(?=^## |(?![\s\S]))/gm)].map((m) => m[0]);
  return { name, kind: 'llms', text: t, entityText: [pre, ...entitySections].join('\n') };
}

// ————————————————————————————————————————————————————————————————————————————————
// جمع الوثائق: dist أو الموقع الحيّ
// ————————————————————————————————————————————————————————————————————————————————

function collect(dir, out = [], depth = 0) {
  if (depth > 8 || !fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out, depth + 1);
    else if (/\.html$/i.test(e.name) || /^llms[\w-]*\.txt$/i.test(e.name)) out.push(p);
  }
  return out;
}

const relName = (u) => {
  let p = new URL(u).pathname;
  try { p = decodeURIComponent(p); } catch { /* ترميز تالف: كما هو */ }
  p = p.replace(/^\/+/, '');
  return !p || p.endsWith('/') ? `${p}index.html` : p;
};

async function fetchText(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    return { status: r.status, type: r.headers.get('content-type') || '', text: r.ok ? await r.text() : '' };
  } catch (e) {
    return { status: 0, type: '', text: '', error: e?.message || String(e) };
  }
}

async function liveDocs() {
  const abs = (p) => new URL(p, ORIGIN).href;
  const urls = new Set();
  for (const l of UI_LANGS) {
    const pre = l === 'ar' ? '' : `/${l}`;
    urls.add(abs(`${pre}/`));
    urls.add(abs(`${pre}/about/`));
    if (l !== 'ar') urls.add(abs(`/${l}/llms.txt`));
  }
  urls.add(abs('/profile/'));
  urls.add(abs('/llms.txt'));
  urls.add(abs('/llms-full.txt'));
  const notes = [];
  if (SITEMAP_N > 0) {
    const locs = [];
    const sm = await fetchText(abs('/sitemap.xml'));
    const pull = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => decode(m[1]));
    for (const loc of pull(sm.text)) {
      if (/\.xml$/i.test(loc)) locs.push(...pull((await fetchText(loc)).text));
      else locs.push(loc);
    }
    const pages = locs.filter((u) => u.startsWith(ORIGIN) && !urls.has(u));
    const step = Math.max(1, pages.length / SITEMAP_N);
    for (let i = 0; i < SITEMAP_N && Math.floor(i * step) < pages.length; i++) urls.add(pages[Math.floor(i * step)]);
    notes.push(`خريطة الموقع: ${pages.length} رابطاً، وفُحص منها ${Math.min(SITEMAP_N, pages.length)} موزّعة بالتساوي`);
  }
  const list = [...urls];
  const docs = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const u = list[next++];
      const r = await fetchText(u);
      const name = relName(u);
      const isTxt = /\.txt$/i.test(name);
      if (r.status !== 200) { notes.push(`تخطّيت ${name}: ${r.status || r.error}`); continue; }
      if (isTxt && !/text\/plain/i.test(r.type)) { notes.push(`تخطّيت ${name}: ${r.type || 'بلا نوع'} لا نصّ (قوقعة الصفحة الناعمة)`); continue; }
      if (!isTxt) {
        // مسار غير مبني يُرجع قوقعة الرئيسية العربية بالرمز 200 (نقد GEO ٢٥): canonical يشير إلى غيره ⇒ ليس صفحته
        const canon = (r.text.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i) || [])[1];
        const want = relName(u);
        if (canon && relName(new URL(canon, ORIGIN).href) !== want) {
          notes.push(`تخطّيت ${want}: قوقعة صفحة أخرى (canonical = ${new URL(canon, ORIGIN).pathname})`);
          continue;
        }
      }
      docs.push(isTxt ? parseLlms(name, r.text) : parseHtml(name, r.text));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { docs, notes };
}

function distDocs() {
  if (!fs.existsSync(DIST)) {
    console.error(`✗ لا يوجد ${DIST} — شغّل npm run build أولاً، أو مرّر --dist أو --live`);
    process.exit(1);
  }
  const docs = collect(DIST).map((f) => {
    const name = path.relative(DIST, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    return /\.txt$/i.test(name) ? parseLlms(name, text) : parseHtml(name, text);
  });
  return { docs, notes: [] };
}

// ————————————————————————————————————————————————————————————————————————————————
// الفحص
// ————————————————————————————————————————————————————————————————————————————————

const RULES = {
  'arab-scope': 'حصر التغطية في الدول العربية — الحقيقة: كل دول العالم',
  'arab-scope-entity': 'وصف الكيان بسوق عربية في سطح الكيان — الحقيقة: كل دول العالم',
  'area-served': 'areaServed في عقدة الكيان قائمة دول — الحقيقة: عالمي',
  'ui-languages': 'قائمة لغات الواجهة تخالف الحقائق',
  'gov-einvoice-abroad': 'ادّعاء ربط حكومي خارج السعودية — الحقيقة: حيّ في السعودية وحدها، وعند الطلب لغيرها',
  'org-facts': 'حقيقة في عقدة الكيان تخالف entity-facts',
  'support-languages': 'لغات التواصل في ContactPoint تخالف لغات الواجهة (لغات الدعم لم يُقرّها المالك)',
  'org-name-form': 'صيغة اسم الكيان ليست الرسمية وحدها (خطة GEO ٤.١)',
  'same-as': 'رابط sameAs غير مسجّل في الحقائق',
  'json-ld-parse': 'كتلة JSON-LD لا تُقرأ',
};
const WARN = new Set(['support-languages', 'org-name-form', 'same-as']);

const findings = [];
/** match: العبارة المُدانة (مفتاح التجميع) · context: سطرها حين تكون عبارة قصيرة داخل نصّ أطول */
const add = (rule, doc, surface, match, note = '', context = '') => findings.push({
  rule, level: WARN.has(rule) ? 'warn' : 'block', file: doc.name, surface,
  match: oneLine(match).slice(0, 220), note, context: oneLine(context).slice(0, 240),
});

const PUBLIC_STORES = new Set(storeUrls().map(normalizeProfileUrl));
const SAME_AS_OK = new Set(FACTS.sameAs.map(normalizeProfileUrl));
const NAMES_OK = new Set([NAME.official, ...NAME.alternates]);
const EMAILS_OK = new Set(Object.values(FACTS.contact.email));
const digits = (s) => String(s).replace(/\D/g, '');
const PHONES_OK = new Set([FACTS.contact.phone, FACTS.contact.whatsapp.number].map(digits));
const GLOBAL_AREA = /^(?:worldwide|world|global|earth|all\s+countries|العالم|كل\s+دول\s+العالم)$/i;

/** قيمة لغة schema.org (اسم أو رمز BCP-47) ⇒ رمز */
const schemaLang = (v) => {
  const s = String(typeof v === 'object' && v ? v.name || v.alternateName || '' : v).trim();
  const code = s.match(/^([a-z]{2,3})(?:-|$)/i);
  if (code) return code[1].toLowerCase();
  const found = [...mentionedLangs(s)];
  return found[0] || s;
};

function checkNodes(doc) {
  for (const e of doc.ldErrors) add('json-ld-parse', doc, 'json-ld', e);
  for (const n of doc.nodes) {
    const label = `json-ld:${n.types.join('/') || 'node'}`;
    for (const { key, text } of n.strings) {
      const surface = `${label}.${key}`;
      for (const h of regexHits(ARAB_SCOPE, text)) add('arab-scope', doc, surface, h.match, '', contextAround(text, h));
      if (n.entity) for (const h of regexHits(ARAB_ENTITY, text)) add('arab-scope-entity', doc, surface, h.match, '', contextAround(text, h));
      for (const h of languageClaims(text)) add('ui-languages', doc, surface, h.match, h.note);
      for (const h of govClaims(text)) add('gov-einvoice-abroad', doc, surface, h.match, h.note);
    }
    const o = n.obj;
    const isOrg = n.id === IDS.organization || n.types.some((t) => ['Organization', 'Corporation'].includes(t)) && !n.parent;
    const isApp = n.types.some((t) => APP_TYPES.has(t));
    if ((isOrg || isApp) && o.areaServed !== undefined) {
      const vals = [].concat(o.areaServed);
      const global = vals.length === 1 && (typeof vals[0] === 'string'
        ? GLOBAL_AREA.test(vals[0].trim())
        : vals[0] && typeof vals[0] === 'object' && !/^Country$/i.test(String(vals[0]['@type'])) && GLOBAL_AREA.test(String(vals[0].name || '').trim()));
      if (!global) {
        const names = vals.map((v) => (typeof v === 'string' ? v : v?.name)).filter(Boolean);
        add('area-served', doc, label, `${vals.length} قيمة: ${names.slice(0, 4).join('، ')}${names.length > 4 ? '…' : ''}`, `المتوقع «${FACTS.coverage.schemaAreaServed}» أو حذف areaServed`);
      }
    }
    if (isApp) {
      for (const k of ['availableLanguage', 'inLanguage']) {
        if (!Array.isArray(o[k])) continue; // قيمة واحدة = لغة النص الموصوف لا قائمة لغات
        const got = new Set(o[k].map(schemaLang));
        if (!sameSet(got, UI)) add('ui-languages', doc, `${label}.${k}`, JSON.stringify(o[k]), `اللغات ${setStr(got)} ≠ الحقائق ${setStr(UI)}`);
      }
      for (const u of [].concat(o.downloadUrl || [], o.installUrl || [])) {
        if (!PUBLIC_STORES.has(normalizeProfileUrl(u))) add('org-facts', doc, `${label}.downloadUrl`, u, 'رابط تحميل لتطبيق غير منشور أو غير مسجّل في الحقائق');
      }
    }
    if (n.types.includes('ContactPoint') && Array.isArray(o.availableLanguage)) {
      const got = new Set(o.availableLanguage.map(schemaLang));
      if (!sameSet(got, UI)) add('support-languages', doc, `${label}.availableLanguage`, JSON.stringify(o.availableLanguage), `${setStr(got)} مقابل الواجهة ${setStr(UI)}`);
    }
    if (n.types.includes('ContactPoint') || n.id === IDS.organization) {
      if (o.email && !EMAILS_OK.has(String(o.email).replace(/^mailto:/i, ''))) add('org-facts', doc, `${label}.email`, o.email, `المسجّل: ${[...EMAILS_OK].join('، ')}`);
      if (o.telephone && !PHONES_OK.has(digits(o.telephone))) add('org-facts', doc, `${label}.telephone`, o.telephone, `المسجّل: ${FACTS.contact.phone} أو ${FACTS.contact.whatsapp.number}`);
    }
    if (n.id === IDS.organization && n.types.length) {
      const org = FACTS.organization;
      if (o.foundingDate !== undefined && String(o.foundingDate).slice(0, 4) !== org.founded) add('org-facts', doc, `${label}.foundingDate`, String(o.foundingDate), `الحقيقة: ${org.founded}`);
      const a = o.address || {};
      if (a.addressCountry && !['SA', 'Saudi Arabia', 'السعودية'].includes(String(a.addressCountry?.name || a.addressCountry))) add('org-facts', doc, `${label}.address`, JSON.stringify(a.addressCountry), `الحقيقة: ${org.hq.country}`);
      if (a.addressLocality && ![org.hq.city, org.hq.cityAr].includes(String(a.addressLocality))) add('org-facts', doc, `${label}.address`, String(a.addressLocality), `الحقيقة: ${org.hq.city}`);
      if (o.name !== undefined) {
        if (!String(o.name).includes(NAME.official)) add('org-facts', doc, `${label}.name`, String(o.name), `يجب أن يحمل «${NAME.official}»`);
        else if (String(o.name) !== NAME.official) add('org-name-form', doc, `${label}.name`, String(o.name), `المقترح «${NAME.official}» وحده، والبدائل في alternateName`);
      }
      for (const alt of [].concat(o.alternateName || [])) {
        if (!NAMES_OK.has(String(alt))) add('org-facts', doc, `${label}.alternateName`, String(alt), 'صيغة اسم غير مسجّلة في الحقائق');
      }
      for (const u of [].concat(o.sameAs || [])) {
        if (!SAME_AS_OK.has(normalizeProfileUrl(u))) add('same-as', doc, `${label}.sameAs`, u);
      }
    }
  }
}

function checkDoc(doc) {
  if (doc.kind === 'llms') {
    for (const h of regexHits(ARAB_SCOPE, doc.text)) add('arab-scope', doc, 'llms', h.match, '', contextAround(doc.text, h));
    for (const h of regexHits(ARAB_ENTITY, doc.entityText)) add('arab-scope-entity', doc, 'llms:رأس الملف', h.match, '', contextAround(doc.entityText, h));
    for (const h of languageClaims(doc.text)) add('ui-languages', doc, 'llms', h.match, h.note);
    for (const h of govClaims(doc.text)) add('gov-einvoice-abroad', doc, 'llms', h.match, h.note);
    return;
  }
  for (const { surface, text } of doc.head) {
    for (const h of regexHits(ARAB_SCOPE, text)) add('arab-scope', doc, surface, h.match, '', contextAround(text, h));
    if (doc.entityPage) for (const h of regexHits(ARAB_ENTITY, text)) add('arab-scope-entity', doc, surface, h.match, '', contextAround(text, h));
    for (const h of languageClaims(text)) add('ui-languages', doc, surface, h.match, h.note);
    for (const h of govClaims(text)) add('gov-einvoice-abroad', doc, surface, h.match, h.note);
  }
  checkNodes(doc);
  if (doc.entityPage || ALL_BODY) {
    for (const h of languageClaims(doc.body)) add('ui-languages', doc, 'body', h.match, h.note);
    for (const h of govClaims(doc.body)) add('gov-einvoice-abroad', doc, 'body', h.match, h.note);
  }
}

/** المطابقة في سطرها (llms): العنوان كله لا الكلمتان وحدهما */
function contextAround(text, h) {
  const s = text.lastIndexOf('\n', h.index) + 1;
  const e = text.indexOf('\n', h.index);
  const line = text.slice(s, e < 0 ? undefined : e);
  if (line.length <= 220) return line;
  const from = Math.max(s, h.index - 90);
  const to = Math.min(e < 0 ? text.length : e, h.index + h.match.length + 90);
  return `${from > s ? '…' : ''}${text.slice(from, to)}${to < (e < 0 ? text.length : e) ? '…' : ''}`;
}

// ————————————————————————————————————————————————————————————————————————————————
// التشغيل والتقرير
// ————————————————————————————————————————————————————————————————————————————————

// --probe "<نص>": يشرح حكم الحارس على نصّ واحد ويخرج — لضبط الأنماط دون بناء
const PROBE = opt('--probe');
if (PROBE !== null) {
  const t = norm(PROBE);
  const out = {
    sentences: sentences(t).map((s) => ({ s, clauses: clauses(s).map((c) => ({ c, langs: [...mentionedLangs(c)] })) })),
    arabScope: regexHits(ARAB_SCOPE, t).map((h) => h.match),
    arabEntity: regexHits(ARAB_ENTITY, t).map((h) => h.match),
    uiLanguages: languageClaims(t),
    govEinvoice: govClaims(t),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

const { docs, notes } = LIVE ? await liveDocs() : distDocs();
for (const d of docs) checkDoc(d);

// التجميع بالعبارة (بلا فرق حالة الأحرف) لا بالسطر: «Arab markets» في ستين عنواناً بند واحد بستين موضعاً
const grouped = new Map(); // rule → عبارة → { files:Set, surfaces:Set, count, note, context, level }
for (const f of findings) {
  if (!grouped.has(f.rule)) grouped.set(f.rule, new Map());
  const g = grouped.get(f.rule);
  const key = f.match.toLowerCase();
  if (!g.has(key)) g.set(key, { ...f, files: new Set(), surfaces: new Set(), count: 0 });
  const x = g.get(key);
  x.files.add(f.file);
  x.surfaces.add(f.surface);
  x.count++;
}

const blocking = findings.filter((f) => f.level === 'block');
const htmlCount = docs.filter((d) => d.kind === 'html').length;
const llmsCount = docs.length - htmlCount;
const source = LIVE ? `${ORIGIN} (GET)` : DIST;

if (AS_JSON) {
  const out = {
    source, factsVersion: FACTS.version, html: htmlCount, llms: llmsCount, notes,
    rules: Object.fromEntries([...grouped].map(([rule, g]) => [rule, [...g.values()].map((x) => ({
      level: x.level, match: x.match, note: x.note, context: x.context, count: x.count, surfaces: [...x.surfaces],
      files: x.files.size, sample: [...x.files].slice(0, SAMPLES),
    }))])),
    blocking: blocking.length, warnings: findings.length - blocking.length,
  };
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`حارس حقائق الكيان — المصدر: ${source}`);
  console.log(`  الحقائق ${FACTS.version} (${FACTS.status}) · لغات الواجهة ${setStr(UI)} · سجل الدول ${FACTS.coverage.registryEntries} مدخلاً (${FACTS.coverage.presetCountries} دولة بإعدادات جاهزة + «دولة أخرى») · الربط الحيّ: ${FACTS.coverage.einvoiceLive.join('، ')}`);
  console.log(`  فُحص ${htmlCount} صفحة HTML و${llmsCount} ملف llms${ALL_BODY ? ' (المتن كله)' : ''}`);
  for (const n of notes) console.log(`  · ${n}`);
  const order = Object.keys(RULES);
  for (const rule of order.filter((r) => grouped.has(r))) {
    const g = [...grouped.get(rule).values()].sort((a, b) => b.count - a.count);
    const level = WARN.has(rule) ? '⚠️ تحذير' : '✗ حاجب';
    const occurrences = findings.filter((f) => f.rule === rule).length;
    const files = new Set(findings.filter((f) => f.rule === rule).map((f) => f.file)).size;
    console.log(`\n${level} [${rule}] ${RULES[rule]} — ${occurrences} موضعاً في ${files} ملفاً، ${g.length} صيغة مختلفة`);
    for (const x of g.slice(0, 12)) {
      const sample = [...x.files].slice(0, SAMPLES).join(' · ');
      console.log(`  • «${x.match}»${x.note ? ` — ${x.note}` : ''} — ${x.count} موضعاً`);
      if (x.context && x.context !== x.match) console.log(`      مثال: ${x.context}`);
      console.log(`      ${[...x.surfaces].join('، ')} · ${x.files.size} ملفاً: ${sample}${x.files.size > SAMPLES ? ' …' : ''}`);
    }
    if (g.length > 12) console.log(`  … و${g.length - 12} صيغة أخرى (--json للقائمة كاملة)`);
  }
  console.log(blocking.length
    ? `\n✗ ${blocking.length} موضعاً حاجباً يناقض حقائق الكيان (src/content/entity-facts.mjs)`
    : `\n✓ لا تناقض حاجب مع حقائق الكيان${findings.length ? ` (${findings.length} تحذيراً)` : ''}`);
}
process.exit(blocking.length ? 1 : 0);
