/**
 * منظّف النصوص العربية: يزيل التشكيل وعلامات الترقيم بأسلوب صياغة المنصّة.
 *
 * القواعد هنا هي عين القواعد التي نُظّفت بها نصوص المستودع، منقولةً إلى
 * المتصفّح كي يستطيع المالك تنظيف محتوى الموقع المحفوظ في CMS بضغطة واحدة
 * — بلا نشر جديد وبلا لمس قاعدة البيانات من خارج اللوحة.
 *
 * ما لا يُمسّ (ليس ترقيماً بل معنى): الروابط والبريد الإلكترونيّ والأرقام
 * العشريّة ورموز العملة (ر.س · ض.ق.م) والأوقات والتواريخ وأسماء الملفّات
 * وأرقام الإصدار والنائبات {name} ووسوم HTML.
 */

// التشكيل وعلامة التطويل — حذفها آمن في كل موضع
const DIACRITICS = /[ً-ْٰـۖ-ۭ]/g;

// علامات مفردة تُحذف دائماً
const SINGLE = new Set('،؛؟!…‘’·—–.:,;');

/**
 * علامات مزدوجة: تُحذف **فقط إذا اكتمل زوجها** داخل النصّ نفسه.
 * نصّ مقطوع (بداية جملة تكمل في متغيّر) قد يحمل الفاتح دون المغلق،
 * فحذف أحدهما يترك قوساً يتيماً أمام القارئ.
 */
const PAIRS: [string, string][] = [['(', ')'], ['[', ']'], ['«', '»'], ['“', '”']];

// حدّا النائب: محرفا تحكّم لا يردان في نصّ بشريّ، فلا يلتهم فكُّ التجميد أرقام النصّ
const H0 = '\u0001';
const H1 = '\u0002';

// مقاطع تُجمَّد قبل التنظيف ثم تُعاد كما كانت
const PROTECTED: RegExp[] = [
  /https?:\/\/[^\s،؛؟!«»…]*[^\s،؛؟!«»….]/g,      // روابط (بلا ابتلاع الترقيم بعدها)
  /\b[\w.+-]+@[\w-]+(?:\.[a-zA-Z]{2,})+/g,        // بريد إلكتروني
  /\bwww\.[\w-]+(?:\.[a-zA-Z]{2,})+/g,            // نطاقات
  /\bv?\d+\.\d+\.\d+\b/g,                          // أرقام إصدار ثلاثية (قبل العشرية)
  /\d+[.,]\d+/g,                                   // أرقام عشرية
  /\d+:\d+/g,                                      // أوقات
  /\d{4}-\d{2}-\d{2}/g,                            // تواريخ
  /[ء-ي]\.[ء-ي](?:\.[ء-ي])*/g, // ر.س · ض.ق.م
  /\{[^{}]*\}/g,                                   // نائبات {name}
  /\b\w+\.(?:js|ts|tsx|json|pdf|png|jpg|jpeg|svg|xml|csv|xlsx|webp|mp4)\b/g,
  /&[a-zA-Z]+;|&#\d+;/g,                           // كيانات HTML
  /<\/?[a-zA-Z][^>]*>/g,                           // وسوم HTML داخل النصّ
];

/** ينظّف نصّاً واحداً. يعيده كما هو إن لم يتغيّر شيء. */
export function cleanText(input: string): string {
  if (!input) return input;

  // ١) تجميد المحميّ
  const holes: string[] = [];
  let work = input;
  for (const re of PROTECTED) {
    work = work.replace(re, (m) => {
      holes.push(m);
      return H0 + (holes.length - 1) + H1;
    });
  }

  // ٢) التشكيل
  work = work.replace(DIACRITICS, '');

  // ٣) الترقيم — المزدوج بشرط اكتمال زوجه
  const drop = new Set(SINGLE);
  for (const [o, c] of PAIRS) {
    const no = work.split(o).length - 1;
    const nc = work.split(c).length - 1;
    if (no > 0 && no === nc) { drop.add(o); drop.add(c); }
  }
  if ((work.split('"').length - 1) % 2 === 0) drop.add('"');
  work = Array.from(work).map((ch) => (drop.has(ch) ? ' ' : ch)).join('');

  // ٤) جمع المسافات داخل السطر مع صون إزاحة بدايته وفواصل الأسطر
  work = work
    .split('\n')
    .map((line) => {
      const indent = (line.match(/^[ \t]*/) || [''])[0];
      return indent + line.slice(indent.length).replace(/[ \t]{2,}/g, ' ');
    })
    .join('\n');

  // ٥) صون مسافات الأطراف كما كانت (إزالة نقطة النهاية لا تُخلّف مسافة لم تكن)
  const lead = (input.match(/^\s*/) || [''])[0];
  const trail = (input.match(/\s*$/) || [''])[0];
  work = lead + work.trim() + trail;

  // ٦) فكّ التجميد
  return work.replace(new RegExp(H0 + '(\\d+)' + H1, 'g'), (_m, i: string) => holes[Number(i)]);
}

/** ينظّف كل قيمة نصّية في شجرة كائن، ويعيد النسخة المنظّفة وعدد ما تغيّر. */
export function cleanDeep<T>(node: T): { value: T; changed: number } {
  let changed = 0;
  const walk = (n: unknown): unknown => {
    if (typeof n === 'string') {
      const out = cleanText(n);
      if (out !== n) changed++;
      return out;
    }
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) o[k] = walk(v);
      return o;
    }
    return n;
  };
  return { value: walk(node) as T, changed };
}
