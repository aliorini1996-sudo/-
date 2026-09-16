// ============================================================================
// ZATCA المرحلة الثانية (Z2) — محلّل XML 1.0 صارم ومحدود (native، بلا تبعيات)
// ----------------------------------------------------------------------------
// يكفي مجموعة UBL الجزئية التي نولّدها ونستقبلها من الهيئة، ويُعامَل كل مُدخل كغير موثوق:
//   • عناصر، سمات (بعلامتي تنصيص مفردة أو مزدوجة)، نص، CDATA (يصير نصاً)، تعليقات وتعليمات
//     معالجة (PI) تُرمَّز ولا تُنفَّذ، إشارات المحارف والكيانات الخمسة المعرّفة مسبقاً فقط.
//   • توحيد نهايات الأسطر (CRLF/CR ⇒ LF) قبل أي شيء، وتطبيع قيم السمات (TAB/LF/CR الحرفية ⇒ فراغ).
//   • حلّ النطاقات (Namespaces 1.0) بالبادئات، ورفض البادئة غير المعلنة.
//   • **يرفض**: DOCTYPE وأي إعلان كيان (فلا توسيع كيانات ولا XXE ولا «مليار ضحكة»)، التداخل
//     الخاطئ، السمات المكرّرة (بالاسم أو بالاسم الموسَّع)، المحارف خارج Char، ترميزاً غير UTF-8،
//     وما يتجاوز حدود الحجم والعمق وعدد العُقد والسمات.
// التحليل تكراري لا عودي (لا فيضان مكدّس مهما كان المُدخل)، ويحفظ لكل عنصر مواضعه في النص
// الأصلي كي يملأ Z2 الخانات الفارغة نصّاً فقط دون إعادة تسلسل المستند.
// ============================================================================

import { TextDecoder } from 'util';

export const NS_XML = 'http://www.w3.org/XML/1998/namespace';
export const NS_XMLNS = 'http://www.w3.org/2000/xmlns/';

/** حدود التحليل. القيم الافتراضية تتّسع لفاتورة بآلاف البنود وتمنع الاستنزاف. */
export interface XmlLimits {
  /** أقصى حجم بالبايت (UTF-8). */
  maxBytes: number;
  /** أقصى عمق تداخل للعناصر (الجذر = 1). أعمق مسار في فاتورة UBL الموقَّعة ≈ 15. */
  maxDepth: number;
  /** أقصى عدد عُقد (عناصر + نصوص + تعليقات + PI). */
  maxNodes: number;
  /** أقصى عدد سمات (بما فيها إعلانات النطاق) للعنصر الواحد. */
  maxAttributes: number;
  /**
   * أقصى عدد إعلانات نطاق (xmlns) في المستند كلّه. كل عنصر يُعلن نطاقاً ينسخ خريطة النطاقات السارية،
   * فبلا هذا الحدّ تتضخّم الذاكرة بحاصل ضرب العناصر × حجم الخريطة (مستند 380KB أسقط Node بنفاد الذاكرة).
   * فاتورة UBL الموقَّعة تحوي نحو 10 إعلانات.
   */
  maxNamespaceDecls: number;
  /**
   * أقصى طول لـURI نطاق. الـURI يُكتب مرة واحدة لكنه يدخل في مقارنات كل عنصر يستعمله (مفتاح منع تكرار
   * السمات، وترتيب C14N)، فبلا حدّ صار مستند 840KB بنطاق طوله 300KB يستهلك 30 ثانية. نطاقات UBL < 100 محرف.
   */
  maxNamespaceUriLength: number;
  /**
   * أقصى عدد سمات (مع إعلانات النطاق) في المستند كلّه. الحدّ لكل عنصر وحده سمح بنحو 1.2 مليون كائن سمة
   * ضمن 8MB (~300MB ذاكرة لكل تحليل، و1.1GB في الختم). الفاتورة الواقعية نحو سمة لكل 5 عُقد.
   */
  maxTotalAttributes: number;
}

export const DEFAULT_XML_LIMITS: Readonly<XmlLimits> = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 400_000,
  maxAttributes: 64,
  maxNamespaceDecls: 128,
  maxNamespaceUriLength: 1024,
  maxTotalAttributes: 200_000,
});

export type XmlErrorCode =
  | 'SIZE' | 'DEPTH' | 'NODES' | 'ATTRS' | 'ENCODING' | 'CHAR' | 'DOCTYPE' | 'ENTITY' | 'SYNTAX'
  | 'NESTING' | 'DUP_ATTR' | 'NS_UNDECLARED' | 'NS_INVALID' | 'NS_RELATIVE' | 'NS_LIMIT' | 'NO_ROOT' | 'CONTENT_OUTSIDE_ROOT' | 'LIMITS'
  // تُستعمل من c14n/stamp للبنية الخاصّة بالهيئة
  | 'NOT_INVOICE' | 'FOREIGN_SIGNATURE' | 'AMBIGUOUS_QR_ID' | 'STRUCTURE';

export class XmlError extends Error {
  readonly code: XmlErrorCode;
  readonly offset: number;
  constructor(code: XmlErrorCode, message: string, offset = -1) {
    super(offset >= 0 ? `${code}: ${message} (offset ${offset})` : `${code}: ${message}`);
    this.name = 'XmlError';
    this.code = code;
    this.offset = offset;
  }
}

export interface XmlAttribute {
  qname: string;
  prefix: string;   // '' بلا بادئة
  local: string;
  ns: string;       // '' لسمة بلا بادئة (السمات لا ترث النطاق الافتراضي)
  value: string;    // بعد فكّ الإشارات والتطبيع
}

export interface XmlNsDecl {
  prefix: string;   // '' للنطاق الافتراضي
  uri: string;      // '' لإلغاء النطاق الافتراضي (xmlns="")
}

export interface XmlElement {
  kind: 'element';
  qname: string;
  prefix: string;
  local: string;
  ns: string;
  attributes: XmlAttribute[];
  nsDecls: XmlNsDecl[];
  /** النطاقات السارية (البادئة ⇒ URI، '' للافتراضي). بلا ربط xml الضمني. مشتركة مع الأب إن لم يُعلَن جديد. */
  inScope: ReadonlyMap<string, string>;
  children: XmlChild[];
  parent: XmlElement | null;
  depth: number;
  /** موضع '<' لوسم البداية. */
  start: number;
  /** الموضع بعد '>' لوسم البداية (أو '/>'). */
  openEnd: number;
  /** موضع '</' لوسم النهاية (= openEnd للعنصر ذاتي الإغلاق). */
  closeStart: number;
  /** الموضع بعد '>' لوسم النهاية. */
  end: number;
  selfClosing: boolean;
}

export interface XmlText { kind: 'text'; value: string; start: number; end: number }
export interface XmlComment { kind: 'comment'; value: string; start: number; end: number }
export interface XmlPI { kind: 'pi'; target: string; data: string; start: number; end: number }
export type XmlChild = XmlElement | XmlText | XmlComment | XmlPI;
export type XmlMisc = XmlComment | XmlPI;

export interface XmlDeclaration { version: string; encoding?: string; standalone?: string; start: number; end: number }

export interface XmlDocument {
  /** النص الأصلي كما حُلِّل (المواضع كلها فيه). */
  source: string;
  hasBom: boolean;
  declaration: XmlDeclaration | null;
  prolog: XmlMisc[];
  root: XmlElement;
  epilog: XmlMisc[];
  nodeCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// المحارف والأسماء
// ─────────────────────────────────────────────────────────────────────────────

/** أي محرف خارج إنتاج Char في XML 1.0 (مع u: البدائل المنفردة تطابق فتُرفض). */
const NON_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

const NC_START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NC_CHAR = `${NC_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
/** QName = NCName (':' NCName)? — يُطابَق لاصقاً عند موضع محدّد. */
const QNAME = new RegExp(`[${NC_START}][${NC_CHAR}]*(?::[${NC_START}][${NC_CHAR}]*)?`, 'uy');

export function isXmlCharCode(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd
    || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

const isS = (c: number) => c === 0x20 || c === 0x9 || c === 0xa || c === 0xd;

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// ─────────────────────────────────────────────────────────────────────────────
// المحلّل
// ─────────────────────────────────────────────────────────────────────────────

class Parser {
  private pos = 0;
  private nodes = 0;
  private nsDeclCount = 0;
  private attrCount = 0;
  /** كل URI نطاق مميَّز ⇒ رقم صغير، فمفتاح منع تكرار السمات لا يحمل الـURI كاملاً (لا تكلفة بطوله لكل عنصر). */
  private readonly nsIds = new Map<string, number>();
  private nsId(uri: string): number {
    let id = this.nsIds.get(uri);
    if (id === undefined) { id = this.nsIds.size; this.nsIds.set(uri, id); }
    return id;
  }
  readonly n: number;

  constructor(readonly src: string, readonly limits: XmlLimits) {
    this.n = src.length;
  }

  fail(code: XmlErrorCode, msg: string, at = this.pos): never {
    throw new XmlError(code, msg, at);
  }

  private count() {
    if (++this.nodes > this.limits.maxNodes) this.fail('NODES', `عدد العُقد تجاوز ${this.limits.maxNodes}`);
  }

  private skipS(): boolean {
    const start = this.pos;
    while (this.pos < this.n && isS(this.src.charCodeAt(this.pos))) this.pos++;
    return this.pos > start;
  }

  private startsWith(s: string, at = this.pos) {
    return this.src.startsWith(s, at);
  }

  private readQName(): string {
    QNAME.lastIndex = this.pos;
    const m = QNAME.exec(this.src);
    if (!m) this.fail('SYNTAX', 'اسم XML غير صالح');
    this.pos += m[0].length;
    if (this.src.charCodeAt(this.pos) === 0x3a /* : */) this.fail('SYNTAX', `اسم بنقطتين غير صالح: ${m[0]}:`);
    return m[0];
  }

  /** يفكّ إشارة تبدأ عند '&' في s؛ يعيد [المحرف، الموضع بعد ';']. at = إزاحة s في المصدر للأخطاء. */
  private readRef(s: string, amp: number, at: number): [string, number] {
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0 || semi - amp > 40) this.fail('SYNTAX', "'&' بلا إشارة صحيحة", at + amp);
    const name = s.slice(amp + 1, semi);
    if (name.charCodeAt(0) === 0x23 /* # */) {
      let cp: number;
      if (/^#x[0-9A-Fa-f]+$/.test(name)) cp = parseInt(name.slice(2), 16);
      else if (/^#[0-9]+$/.test(name)) cp = parseInt(name.slice(1), 10);
      else return this.fail('SYNTAX', `إشارة محرف غير صالحة &${name};`, at + amp);
      if (!isXmlCharCode(cp)) this.fail('CHAR', `إشارة إلى محرف غير مسموح &${name};`, at + amp);
      return [String.fromCodePoint(cp), semi + 1];
    }
    const v = PREDEFINED[name];
    if (v === undefined) this.fail('ENTITY', `كيان غير معرّف &${name};`, at + amp);
    return [v, semi + 1];
  }

  /** نص محتوى: فكّ الإشارات، CRLF/CR ⇒ LF، ورفض ']]>' الحرفية. */
  private decodeText(raw: string, at: number): string {
    const bad = raw.indexOf(']]>');
    if (bad >= 0) this.fail('SYNTAX', "']]>' غير مسموحة في النص", at + bad);
    if (raw.indexOf('&') < 0) return raw.indexOf('\r') < 0 ? raw : raw.replace(/\r\n?/g, '\n');
    let out = '';
    let i = 0;
    for (;;) {
      const amp = raw.indexOf('&', i);
      const lit = raw.slice(i, amp < 0 ? raw.length : amp);
      out += lit.indexOf('\r') < 0 ? lit : lit.replace(/\r\n?/g, '\n');
      if (amp < 0) return out;
      const [ch, next] = this.readRef(raw, amp, at);
      out += ch;
      i = next;
    }
  }

  /** قيمة سمة: CRLF ⇒ LF ثم TAB/LF/CR الحرفية ⇒ فراغ؛ الإشارات تُفكّ بلا تطبيع (XML §3.3.3). */
  private decodeAttr(raw: string, at: number): string {
    const lt = raw.indexOf('<');
    if (lt >= 0) this.fail('SYNTAX', "'<' غير مسموحة في قيمة سمة", at + lt);
    let out = '';
    let i = 0;
    for (;;) {
      const amp = raw.indexOf('&', i);
      out += raw.slice(i, amp < 0 ? raw.length : amp).replace(/\r\n|[\r\n\t]/g, ' ');
      if (amp < 0) return out;
      const [ch, next] = this.readRef(raw, amp, at);
      out += ch;
      i = next;
    }
  }

  private parseDeclaration(): XmlDeclaration | null {
    if (!this.startsWith('<?xml')) return null;
    const after = this.src.charCodeAt(this.pos + 5);
    if (!(isS(after) || after === 0x3f)) return null; // <?xml-stylesheet … ليس إعلاناً: يُحلَّل PI عادياً
    const start = this.pos;
    const re = /<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(["'])([^"']*)\1(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\3)?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(["'])(yes|no)\5)?[ \t\r\n]*\?>/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.src);
    if (!m) this.fail('SYNTAX', 'إعلان XML غير صالح');
    if (m[2] !== '1.0') this.fail('SYNTAX', `إصدار XML غير مدعوم: ${m[2]}`);
    if (m[4] !== undefined && m[4].toUpperCase() !== 'UTF-8') this.fail('ENCODING', `الترميز المسموح UTF-8 فقط (وُجد ${m[4]})`);
    this.pos += m[0].length;
    const decl: XmlDeclaration = { version: m[2], start, end: this.pos };
    if (m[4] !== undefined) decl.encoding = m[4];
    if (m[6] !== undefined) decl.standalone = m[6];
    return decl;
  }

  private parseComment(): XmlComment {
    const start = this.pos;
    const close = this.src.indexOf('-->', start + 4);
    if (close < 0) this.fail('SYNTAX', 'تعليق غير مغلق');
    const raw = this.src.slice(start + 4, close);
    const dd = raw.indexOf('--');
    if (dd >= 0) this.fail('SYNTAX', "'--' غير مسموحة داخل تعليق", start + 4 + dd);
    if (raw.endsWith('-')) this.fail('SYNTAX', "التعليق لا ينتهي بـ '-'", close - 1);
    this.pos = close + 3;
    this.count();
    return { kind: 'comment', value: raw.replace(/\r\n?/g, '\n'), start, end: this.pos };
  }

  private parsePI(): XmlPI {
    const start = this.pos;
    this.pos += 2;
    const target = this.readQName();
    if (target.indexOf(':') >= 0) this.fail('SYNTAX', 'اسم تعليمة المعالجة لا يحوي نقطتين', start + 2);
    if (target.toLowerCase() === 'xml') this.fail('SYNTAX', 'إعلان XML في غير موضعه (أو اسم PI محجوز)', start);
    let data = '';
    if (this.startsWith('?>')) {
      this.pos += 2;
    } else {
      if (!this.skipS()) this.fail('SYNTAX', 'فراغ مطلوب بعد اسم تعليمة المعالجة');
      const close = this.src.indexOf('?>', this.pos);
      if (close < 0) this.fail('SYNTAX', 'تعليمة معالجة غير مغلقة', start);
      data = this.src.slice(this.pos, close).replace(/\r\n?/g, '\n');
      this.pos = close + 2;
    }
    this.count();
    return { kind: 'pi', target, data, start, end: this.pos };
  }

  /** عناصر خارج الجذر: فراغات وتعليقات وPI فقط. */
  private parseMisc(out: XmlMisc[], beforeRoot: boolean): void {
    for (;;) {
      this.skipS();
      if (this.pos >= this.n) return;
      if (this.startsWith('<!--')) { out.push(this.parseComment()); continue; }
      if (this.startsWith('<?')) { out.push(this.parsePI()); continue; }
      if (this.startsWith('<!DOCTYPE')) this.fail('DOCTYPE', 'DOCTYPE غير مسموح (لا DTD ولا كيانات)');
      if (this.startsWith('<!ENTITY')) this.fail('ENTITY', 'إعلان الكيانات غير مسموح');
      if (this.startsWith('<!')) this.fail('SYNTAX', "تعريف '<!' غير مدعوم");
      if (beforeRoot && this.src.charCodeAt(this.pos) === 0x3c) return;
      if (beforeRoot) this.fail('CONTENT_OUTSIDE_ROOT', 'نص قبل العنصر الجذر');
      this.fail('CONTENT_OUTSIDE_ROOT', 'محتوى بعد نهاية العنصر الجذر');
    }
  }

  /**
   * C14N 1.0/1.1 يشترط الفشل مع نطاق نسبي، وApache Santuario (الذي تستعمله الـSDK) يرمي
   * RelativeNamespace حين لا تقع ':' بعد أول محرف. نرفضه هنا كي لا نجزّئ مستنداً تعجز الهيئة عن تجزئته.
   * القيمة الفارغة (xmlns="") إلغاءٌ للنطاق الافتراضي لا URI، فتُقبل.
   */
  private checkNsUri(uri: string, at: number): void {
    if (uri.length > this.limits.maxNamespaceUriLength) this.fail('NS_LIMIT', `طول URI النطاق تجاوز ${this.limits.maxNamespaceUriLength}`, at);
    if (uri !== '' && uri.indexOf(':') <= 0) this.fail('NS_RELATIVE', `نطاق نسبي غير قابل للتطبيع (C14N): «${uri}»`, at);
  }

  private parseStartTag(parent: XmlElement | null, depth: number): XmlElement {
    const start = this.pos;
    if (depth > this.limits.maxDepth) this.fail('DEPTH', `عمق التداخل تجاوز ${this.limits.maxDepth}`);
    this.pos++;
    const qname = this.readQName();
    // تخصيص كسول: العنصر بلا سمات (الأغلب) لا يدفع مصفوفات ومجموعات لا يحتاجها
    let raw: Array<{ qname: string; value: string; at: number }> | null = null;
    let selfClosing = false;
    for (;;) {
      const hadS = this.skipS();
      if (this.pos >= this.n) this.fail('SYNTAX', `وسم بداية غير مغلق <${qname}`, start);
      const c = this.src.charCodeAt(this.pos);
      if (c === 0x3e /* > */) { this.pos++; break; }
      if (c === 0x2f /* / */) {
        if (this.src.charCodeAt(this.pos + 1) !== 0x3e) this.fail('SYNTAX', "'/' بلا '>'");
        this.pos += 2;
        selfClosing = true;
        break;
      }
      if (!hadS) this.fail('SYNTAX', 'فراغ مطلوب قبل السمة');
      const at = this.pos;
      const aname = this.readQName();
      this.skipS();
      if (this.src.charCodeAt(this.pos) !== 0x3d /* = */) this.fail('SYNTAX', `'=' مطلوبة بعد السمة ${aname}`);
      this.pos++;
      this.skipS();
      const q = this.src.charCodeAt(this.pos);
      if (q !== 0x22 && q !== 0x27) this.fail('SYNTAX', `قيمة السمة ${aname} بلا علامة تنصيص`);
      const close = this.src.indexOf(q === 0x22 ? '"' : "'", this.pos + 1);
      if (close < 0) this.fail('SYNTAX', `قيمة السمة ${aname} غير مغلقة`);
      const value = this.decodeAttr(this.src.slice(this.pos + 1, close), this.pos + 1);
      this.pos = close + 1;
      if (raw === null) raw = [];
      else if (raw.some(r => r.qname === aname)) this.fail('DUP_ATTR', `سمة مكرّرة ${aname}`, at); // ≤ 64 سمة: مسح خطّي أرخص من Set
      raw.push({ qname: aname, value, at });
      if (raw.length > this.limits.maxAttributes) this.fail('ATTRS', `عدد السمات تجاوز ${this.limits.maxAttributes}`, at);
      if (++this.attrCount > this.limits.maxTotalAttributes) this.fail('ATTRS', `عدد السمات في المستند تجاوز ${this.limits.maxTotalAttributes}`, at);
    }
    this.count();
    if (raw === null) {
      const inherited: ReadonlyMap<string, string> = parent ? parent.inScope : EMPTY_SCOPE;
      const colon0 = qname.indexOf(':');
      const prefix0 = colon0 < 0 ? '' : qname.slice(0, colon0);
      let ns0: string;
      if (prefix0 === '') ns0 = inherited.get('') ?? '';
      else if (prefix0 === 'xml') ns0 = NS_XML;
      else if (prefix0 === 'xmlns') return this.fail('NS_INVALID', 'البادئة xmlns محجوزة', start + 1);
      else {
        const u = inherited.get(prefix0);
        if (u === undefined) return this.fail('NS_UNDECLARED', `بادئة غير معلنة: ${prefix0}`, start + 1);
        ns0 = u;
      }
      return {
        kind: 'element', qname, prefix: prefix0, local: colon0 < 0 ? qname : qname.slice(colon0 + 1), ns: ns0,
        attributes: EMPTY_ATTRS, nsDecls: EMPTY_DECLS, inScope: inherited, children: [], parent, depth,
        start, openEnd: this.pos, closeStart: selfClosing ? this.pos : -1, end: selfClosing ? this.pos : -1, selfClosing,
      };
    }

    // ─── النطاقات ───
    const parentScope: ReadonlyMap<string, string> = parent ? parent.inScope : EMPTY_SCOPE;
    const nsDecls: XmlNsDecl[] = [];
    const plain: typeof raw = [];
    for (const a of raw) {
      if (a.qname === 'xmlns') {
        if (a.value === NS_XML || a.value === NS_XMLNS) this.fail('NS_INVALID', 'لا يُربط النطاق الافتراضي بنطاق xml/xmlns', a.at);
        this.checkNsUri(a.value, a.at);
        nsDecls.push({ prefix: '', uri: a.value });
      } else if (a.qname.startsWith('xmlns:')) {
        const p = a.qname.slice(6);
        if (p === 'xmlns') this.fail('NS_INVALID', 'البادئة xmlns لا تُعلَن', a.at);
        if (p === 'xml') {
          if (a.value !== NS_XML) this.fail('NS_INVALID', 'البادئة xml لا تُربط بغير نطاقها', a.at);
          continue; // إعلان زائد مسموح؛ الربط ضمني دائماً ولا يُرسم في C14N
        }
        if (a.value === '') this.fail('NS_INVALID', `إلغاء ربط البادئة ${p} غير مسموح في Namespaces 1.0`, a.at);
        if (a.value === NS_XML || a.value === NS_XMLNS) this.fail('NS_INVALID', `نطاق محجوز للبادئة ${p}`, a.at);
        this.checkNsUri(a.value, a.at);
        nsDecls.push({ prefix: p, uri: a.value });
      } else {
        plain.push(a);
      }
    }
    let inScope = parentScope;
    if (nsDecls.length) {
      this.nsDeclCount += nsDecls.length;
      if (this.nsDeclCount > this.limits.maxNamespaceDecls) {
        this.fail('NS_LIMIT', `عدد إعلانات النطاق في المستند تجاوز ${this.limits.maxNamespaceDecls}`, start);
      }
      const m = new Map(parentScope);
      for (const d of nsDecls) m.set(d.prefix, d.uri);
      inScope = m;
    }
    const resolve = (prefix: string, at: number): string => {
      if (prefix === 'xml') return NS_XML;
      if (prefix === 'xmlns') this.fail('NS_INVALID', 'البادئة xmlns محجوزة', at);
      const uri = inScope.get(prefix);
      if (uri === undefined) this.fail('NS_UNDECLARED', `بادئة غير معلنة: ${prefix}`, at);
      return uri;
    };
    const colon = qname.indexOf(':');
    const prefix = colon < 0 ? '' : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    const ns = prefix === '' ? (inScope.get('') ?? '') : resolve(prefix, start + 1);
    const attributes: XmlAttribute[] = [];
    const expanded = new Set<string>();
    for (const a of plain) {
      const ac = a.qname.indexOf(':');
      const ap = ac < 0 ? '' : a.qname.slice(0, ac);
      const al = ac < 0 ? a.qname : a.qname.slice(ac + 1);
      const ans = ap === '' ? '' : resolve(ap, a.at);
      const key = `${this.nsId(ans)}\u0000${al}`;
      if (expanded.has(key)) this.fail('DUP_ATTR', `سمة مكرّرة بعد حلّ النطاق {${ans}}${al}`, a.at);
      expanded.add(key);
      attributes.push({ qname: a.qname, prefix: ap, local: al, ns: ans, value: a.value });
    }
    return {
      kind: 'element', qname, prefix, local, ns, attributes, nsDecls, inScope, children: [], parent, depth,
      start, openEnd: this.pos, closeStart: selfClosing ? this.pos : -1, end: selfClosing ? this.pos : -1, selfClosing,
    };
  }

  parse(hasBom: boolean): XmlDocument {
    const src = this.src;
    if (hasBom) this.pos = 1;
    const declaration = this.parseDeclaration();
    const prolog: XmlMisc[] = [];
    this.parseMisc(prolog, true);
    if (this.pos >= this.n) this.fail('NO_ROOT', 'لا يوجد عنصر جذر');

    const root = this.parseStartTag(null, 1);
    const stack: XmlElement[] = root.selfClosing ? [] : [root];
    let textParts: string[] = [];
    let textStart = -1;
    let textEnd = -1;
    const flush = () => {
      if (textStart < 0) return;
      const top = stack[stack.length - 1];
      this.count();
      top.children.push({ kind: 'text', value: textParts.length === 1 ? textParts[0] : textParts.join(''), start: textStart, end: textEnd });
      textParts = [];
      textStart = -1;
    };

    while (stack.length) {
      if (this.pos >= this.n) this.fail('NESTING', `عنصر غير مغلق <${stack[stack.length - 1].qname}>`, stack[stack.length - 1].start);
      const c = src.charCodeAt(this.pos);
      if (c !== 0x3c /* < */) {
        let lt = src.indexOf('<', this.pos);
        if (lt < 0) lt = this.n;
        const value = this.decodeText(src.slice(this.pos, lt), this.pos);
        if (textStart < 0) textStart = this.pos;
        textParts.push(value);
        this.pos = lt;
        textEnd = lt;
        continue;
      }
      const c1 = src.charCodeAt(this.pos + 1);
      const top = stack[stack.length - 1];
      if (c1 === 0x2f /* / */) {
        flush();
        const closeStart = this.pos;
        this.pos += 2;
        const name = this.readQName();
        this.skipS();
        if (src.charCodeAt(this.pos) !== 0x3e) this.fail('SYNTAX', `وسم نهاية غير مكتمل </${name}`, closeStart);
        this.pos++;
        if (name !== top.qname) this.fail('NESTING', `وسم نهاية </${name}> لا يطابق <${top.qname}>`, closeStart);
        top.closeStart = closeStart;
        top.end = this.pos;
        stack.pop();
        continue;
      }
      if (c1 === 0x21 /* ! */) {
        if (this.startsWith('<!--')) { flush(); top.children.push(this.parseComment()); continue; }
        if (this.startsWith('<![CDATA[')) {
          const close = src.indexOf(']]>', this.pos + 9);
          if (close < 0) this.fail('SYNTAX', 'قسم CDATA غير مغلق');
          if (textStart < 0) textStart = this.pos;
          textParts.push(src.slice(this.pos + 9, close).replace(/\r\n?/g, '\n'));
          this.pos = close + 3;
          textEnd = this.pos;
          continue;
        }
        if (this.startsWith('<!DOCTYPE')) this.fail('DOCTYPE', 'DOCTYPE غير مسموح');
        if (this.startsWith('<!ENTITY')) this.fail('ENTITY', 'إعلان الكيانات غير مسموح');
        this.fail('SYNTAX', "تعريف '<!' غير مدعوم");
      }
      if (c1 === 0x3f /* ? */) { flush(); top.children.push(this.parsePI()); continue; }
      flush();
      const el = this.parseStartTag(top, stack.length + 1);
      top.children.push(el);
      if (!el.selfClosing) stack.push(el);
    }

    const epilog: XmlMisc[] = [];
    this.parseMisc(epilog, false);
    return { source: src, hasBom, declaration, prolog, root, epilog, nodeCount: this.nodes };
  }
}

const EMPTY_SCOPE: ReadonlyMap<string, string> = new Map();
/** مصفوفتان مجمَّدتان مشتركتان لكل عنصر بلا سمات (التعديل عليهما يرمي في الوضع الصارم). */
const EMPTY_ATTRS = Object.freeze([]) as unknown as XmlAttribute[];
const EMPTY_DECLS = Object.freeze([]) as unknown as XmlNsDecl[];

/**
 * يدمج الحدود حقلاً حقلاً: undefined ⇒ الافتراضي، وأي قيمة ليست عدداً صحيحاً موجباً آمناً (NaN، سالب،
 * نص…) ترمي — فلا يُلغى حدٌّ بصمت لأن متغيّر إعداد غير مضبوط (كل مقارنة مع NaN/undefined كاذبة).
 */
export function resolveLimits(limits: Partial<XmlLimits> | undefined): XmlLimits {
  const out = { ...DEFAULT_XML_LIMITS } as XmlLimits;
  if (limits === undefined || limits === null) return out;
  if (typeof limits !== 'object') throw new XmlError('LIMITS', 'حدود التحليل يجب أن تكون كائناً');
  for (const k of Object.keys(DEFAULT_XML_LIMITS) as Array<keyof XmlLimits>) {
    const v = (limits as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new XmlError('LIMITS', `الحدّ ${k} يجب أن يكون عدداً صحيحاً موجباً (وُجد ${String(v)})`);
    out[k] = v;
  }
  return out;
}

/**
 * يحلّل مستند XML كاملاً. المُدخل نص JavaScript أو بايتات UTF-8 (تُفكّ بصرامة: بايتات غير صالحة ⇒ رفض).
 * يرمي XmlError بكود ثابت عند أي مخالفة.
 */
export function parseXml(input: string | Uint8Array, limits: Partial<XmlLimits> = {}): XmlDocument {
  const lim = resolveLimits(limits);
  let src: string;
  if (typeof input === 'string') {
    if (input.length > lim.maxBytes) throw new XmlError('SIZE', `الحجم تجاوز ${lim.maxBytes} بايت`);
    src = input;
  } else if (input instanceof Uint8Array) {
    if (input.length > lim.maxBytes) throw new XmlError('SIZE', `الحجم تجاوز ${lim.maxBytes} بايت`);
    try {
      src = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      throw new XmlError('ENCODING', 'بايتات UTF-8 غير صالحة');
    }
  } else {
    throw new XmlError('SYNTAX', 'المُدخل يجب أن يكون نصاً أو بايتات');
  }
  const bad = NON_CHAR.exec(src);
  if (bad) throw new XmlError('CHAR', `محرف غير مسموح في XML 1.0 (U+${(bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase()})`, bad.index);
  if (typeof input === 'string' && Buffer.byteLength(src, 'utf8') > lim.maxBytes) {
    throw new XmlError('SIZE', `الحجم تجاوز ${lim.maxBytes} بايت`);
  }
  const hasBom = src.charCodeAt(0) === 0xfeff;
  return new Parser(src, lim).parse(hasBom);
}

// ─────────────────────────────────────────────────────────────────────────────
// أدوات تصفّح بسيطة
// ─────────────────────────────────────────────────────────────────────────────

export function childElements(el: XmlElement, ns?: string, local?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) {
    if (c.kind !== 'element') continue;
    if (ns !== undefined && c.ns !== ns) continue;
    if (local !== undefined && c.local !== local) continue;
    out.push(c);
  }
  return out;
}

/** العنصر الابن الوحيد بهذا الاسم الموسَّع؛ undefined إن لم يوجد، ويرمي إن تكرّر. */
export function onlyChild(el: XmlElement, ns: string, local: string): XmlElement | undefined {
  const all = childElements(el, ns, local);
  if (all.length > 1) throw new XmlError('STRUCTURE', `العنصر {${ns}}${local} مكرّر تحت <${el.qname}>`, all[1].start);
  return all[0];
}

/** يتبع مساراً من الأبناء الوحيدين؛ undefined عند أي حلقة ناقصة. */
export function childPath(el: XmlElement, path: ReadonlyArray<readonly [string, string]>): XmlElement | undefined {
  let cur: XmlElement | undefined = el;
  for (const [ns, local] of path) {
    if (!cur) return undefined;
    cur = onlyChild(cur, ns, local);
  }
  return cur;
}

/** نصوص الأبناء المباشرة مجمَّعة (CDATA ضمنها؛ التعليقات تُتجاهل). */
export function directText(el: XmlElement): string {
  let s = '';
  for (const c of el.children) if (c.kind === 'text') s += c.value;
  return s;
}

/** قيمة سمة بلا نطاق. */
export function attr(el: XmlElement, local: string): string | undefined {
  for (const a of el.attributes) if (a.ns === '' && a.local === local) return a.value;
  return undefined;
}

/** كل العناصر تحت el (بدونه) بترتيب المستند — تكراري بلا عودية. */
export function descendants(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: Array<{ e: XmlElement; i: number }> = [{ e: el, i: 0 }];
  while (stack.length) {
    const top = stack[stack.length - 1];
    if (top.i >= top.e.children.length) { stack.pop(); continue; }
    const c = top.e.children[top.i++];
    if (c.kind === 'element') {
      out.push(c);
      stack.push({ e: c, i: 0 });
    }
  }
  return out;
}

/** تهريب نص عنصر للكتابة داخل خانة (& < > وCR). */
export function escapeXmlText(s: string): string {
  return s.replace(/[&<>\r]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#xD;'));
}

/**
 * يملأ عناصر فارغة (<x></x>) بنصوص، على النص الأصلي مباشرة — لا يلمس أي بايت آخر.
 * يرفض العنصر ذاتي الإغلاق أو غير الفارغ (لا إعادة ختم لمستند مختوم)، والتكرار.
 */
export function fillEmptyElements(doc: XmlDocument, fills: ReadonlyArray<{ element: XmlElement; text: string }>): string {
  const seen = new Set<XmlElement>();
  for (const f of fills) {
    const el = f.element;
    if (seen.has(el)) throw new XmlError('STRUCTURE', `الخانة <${el.qname}> مكرّرة في الملء`, el.start);
    seen.add(el);
    if (el.selfClosing || el.openEnd !== el.closeStart || el.children.length) {
      throw new XmlError('STRUCTURE', `الخانة <${el.qname}> ليست فارغة بصيغة <x></x>`, el.start);
    }
  }
  const sorted = [...fills].sort((a, b) => b.element.openEnd - a.element.openEnd);
  let s = doc.source;
  for (const f of sorted) s = s.slice(0, f.element.openEnd) + escapeXmlText(f.text) + s.slice(f.element.openEnd);
  return s;
}

/** normalize-space في XPath 1.0 (فراغ، TAB، LF، CR فقط). */
export function normalizeSpace(s: string): string {
  return s.replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '');
}
