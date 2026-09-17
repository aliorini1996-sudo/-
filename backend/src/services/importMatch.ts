/**
 * مطابقة العملاء في الاستيراد (البندان 3 و4 من مراجعة 2026-09-17). منطق صرف بلا قاعدة بيانات.
 *
 * - normImportPhone: أرقام لاتينية بلا فواصل، و00/966/0966 ⇒ 05، والصفر العشري («.0» و«,0» و«٫0») والصيغة العلمية
 *   («5.01234567E+08»)، والخلية بجوالين («0501234567 / 0551234567») ⇒ الأول الصالح؛ والجوالات التافهة (0، «—»،
 *   أقل من 8 أرقام، رقم مكرر) ⇒ null.
 * - buildCustomerMatcher (/balances و/ledger و/prices): الكود وحده إن أُعطي؛ وإلا الجوال (يُصفّى بالاسم عند التعدد) ثم الاسم
 *   الفريد. الغموض ⇒ AMBIGUOUS لا «آخر من يُكتب يفوز»، والكود غير الموجود ⇒ NOT_FOUND بلا سقوط إلى الاسم؛ إلا إن طابق
 *   الجوالُ أو الاسم عميلاً (أو عملاء) بكود تلقائي (cuid: مستورد بلا كود) ⇒ CODE_NOT_FOUND صريح (لا مطابقة صامتة)،
 *   والصف بالكود وحده (بلا اسم ولا جوال) والشركة فيها عملاء بلا كود ⇒ CODE_UNREGISTERED بتلميح.
 * - planCustomerImport (/customers): الصف ذو الكود يُطابَق بالكود وحده (فروع السلاسل تُنشأ مع تنبيه similar)،
 *   والصف بلا كود يُتخطى بجوال صالح ثم باسم مطبَّع. الكود الجديد الذي يطابق جوالُه أو اسمه الفريد عميلاً واحداً معروفاً
 *   بكود تلقائي ⇒ attach (يُكتب الكود في ذلك العميل فتطابقه ملفات الأرصدة والكشوف والأسعار)، وتعذّر تعيينه ⇒ CODE_ATTACHABLE،
 *   واسمٌ يشترك فيه أكثر من عميل بعضهم بكود تلقائي بلا جوال يميّز ⇒ CODE_AMBIGUOUS_NAME (لا عميل ثالث مكرر).
 */
import { normImportName, type CustomerMatch, type CustomerMatchRow, type CustomerMatcher } from './importLedger';

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_INDIC = '۰۱۲۳۴۵۶۷۸۹';

function asciiDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    const e = EXTENDED_INDIC.indexOf(ch);
    out += e >= 0 ? String(e) : ch;
  }
  return out;
}

/** جوال واحد ⇒ أرقامه المطبَّعة، أو null */
function normOnePhone(raw: string): string | null {
  let t = raw.trim();
  // جوال مخزَّن رقماً في CSV/Excel بصيغة علمية («5.01234567E+08»)
  const sci = t.match(/^(\d+)(?:[.,٫](\d+))?e\+?(\d+)$/i);
  if (sci) {
    const frac = sci[2] ?? '';
    const exp = Number(sci[3]);
    if (exp < frac.length) return null;
    t = sci[1] + frac + '0'.repeat(exp - frac.length);
  }
  // رقم عشري «0501234567.0» أو بفاصلة أوروبية «,0» أو فاصل عربي «٫٠»: يُقصّ صفره العشري قبل حذف غير الأرقام
  let d = t.replace(/[.,٫]0+$/, '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0966') && d.length >= 13) d = d.slice(1); // «0966 50…»: صفر محلي قبل رمز الدولة
  if (d.startsWith('9660') && d.length === 13) d = '0' + d.slice(4); // «+966 05…»
  if (d.startsWith('966') && d.length === 12) d = '0' + d.slice(3);
  if (d.length === 9 && d.startsWith('5')) d = '0' + d;
  if (d.length < 8) return null;
  if (/^(\d)\1*$/.test(d)) return null; // كلها أصفار أو الرقم نفسه
  return d;
}

/** الجوال المطبَّع للمطابقة، أو null إن كان فارغاً أو تافهاً */
export function normImportPhone(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const raw = asciiDigits(String(s)).trim();
  // خلية بأكثر من جوال («0501234567 / 0551234567»): أرقامها أطول من جوال واحد ⇒ الأول الصالح
  if (raw.replace(/\D/g, '').length > 14) {
    for (const part of raw.split(/[/;|،,\n]+|\s+(?:و|or|and)\s+/i)) {
      const n = normOnePhone(part);
      if (n) return n;
    }
  }
  return normOnePhone(raw);
}

export interface MatchableCustomer { id: string; code?: string | null; phone?: string | null; name?: string | null }

const trimmed = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');

/** كود تلقائي: فارغ أو cuid الافتراضي في المخطط (code @default(cuid())) ⇒ عميل استُورد أو أُنشئ بلا كود */
export function isAutoCustomerCode(code: string | null | undefined): boolean {
  const c = trimmed(code);
  return c === '' || /^c[a-z0-9]{20,32}$/.test(c);
}

/** مطابق العملاء حسب العقد (ج) */
export function buildCustomerMatcher(customers: readonly MatchableCustomer[]): CustomerMatcher {
  const byCode = new Map<string, string>();
  const autoCode = new Set<string>();
  const byPhone = new Map<string, { id: string; name: string }[]>();
  const byName = new Map<string, string[]>();
  for (const c of customers) {
    const code = trimmed(c.code);
    if (code && !byCode.has(code)) byCode.set(code, c.id);
    if (isAutoCustomerCode(c.code)) autoCode.add(c.id);
    const name = trimmed(c.name) ? normImportName(c.name!) : '';
    const phone = normImportPhone(c.phone);
    if (phone) {
      const list = byPhone.get(phone);
      if (list) list.push({ id: c.id, name }); else byPhone.set(phone, [{ id: c.id, name }]);
    }
    if (name) {
      const list = byName.get(name);
      if (list) list.push(c.id); else byName.set(name, [c.id]);
    }
  }
  /** المطابقة بالجوال ثم الاسم، مع المرشحين الذين بُني عليهم القرار */
  const byPhoneOrName = (row: CustomerMatchRow): { m: CustomerMatch; cands: string[] } => {
    const rawName = trimmed(row.customerName);
    const name = rawName ? normImportName(rawName) : '';
    const phone = normImportPhone(row.phone);
    if (phone) {
      const cands = byPhone.get(phone) ?? [];
      if (cands.length === 1) return { m: { id: cands[0].id }, cands: [cands[0].id] };
      if (cands.length > 1) {
        if (name) {
          const same = cands.filter((c) => c.name === name);
          if (same.length === 1) return { m: { id: same[0].id }, cands: [same[0].id] };
        }
        return { m: { error: 'AMBIGUOUS', value: trimmed(row.phone) }, cands: cands.map((c) => c.id) };
      }
    }
    if (name) {
      const ids = byName.get(name) ?? [];
      if (ids.length === 1) return { m: { id: ids[0] }, cands: ids };
      if (ids.length > 1) return { m: { error: 'AMBIGUOUS', value: rawName }, cands: ids };
    }
    return { m: { error: 'NOT_FOUND' }, cands: [] };
  };
  return (row: CustomerMatchRow): CustomerMatch => {
    const code = trimmed(row.customerCode);
    if (code) {
      const id = byCode.get(code);
      if (id) return { id };
      // الكود وحده يحسم، لكن عميلاً (أو عملاء) بكود تلقائي يطابق جوالهم أو اسمهم يستحق خطأ صريحاً لا «استورد العملاء أولا»
      const alt = byPhoneOrName(row);
      if (alt.cands.some((c) => autoCode.has(c))) return { error: 'CODE_NOT_FOUND', value: code };
      // صف بالكود وحده والشركة فيها عملاء بلا كود: تلميح بإضافة الاسم/الجوال أو ربط الأكواد باستيراد العملاء
      if (!trimmed(row.customerName) && !normImportPhone(row.phone) && autoCode.size > 0) return { error: 'CODE_UNREGISTERED', value: code };
      return { error: 'NOT_FOUND' };
    }
    return byPhoneOrName(row).m;
  };
}

// ═══ /customers ═══

export interface ExistingCustomerKey { id?: string; code?: string | null; phone?: string | null; name?: string | null }
export interface CustomerImportRowKey { code?: string | null; phone?: string | null; name: string }

export type CustomerSkipReason = 'CODE_EXISTS' | 'PHONE_EXISTS' | 'NAME_EXISTS' | 'CODE_ATTACHABLE' | 'CODE_AMBIGUOUS_NAME';

export type CustomerImportDecision =
  | { action: 'create'; index: number; row: number; phone: string; similar?: 'phone' | 'name' }
  /** كتابة الكود في عميل قائم بكود تلقائي (fromCode: كوده الحالي، شرط الكتابة) */
  | { action: 'attach'; index: number; row: number; customerId: string; code: string; fromCode: string | null; matchedBy: 'phone' | 'name' }
  | { action: 'skip'; index: number; row: number; reason: CustomerSkipReason };

/** الجوال المخزَّن: الأصلي المقصوص إن كان صالحاً، وإلا «—» */
export function storedCustomerPhone(phone: string | null | undefined): string {
  return normImportPhone(phone) ? trimmed(phone) : '—';
}

interface Bucket { n: number; auto: number; autoIds: string[] }

/**
 * مخطِّط استيراد العملاء بالترتيب (الصفوف المُنشأة سابقاً في الملف نفسه تُحسب موجودة).
 * decide لا يغيّر الحالة؛ commit بعد قرار create أو attach (افتراض نجاح الكتابة).
 */
export function customerImportPlanner(existing: readonly ExistingCustomerKey[]) {
  const codes = new Set<string>();
  // عدد العملاء لكل جوال/اسم، ومنهم ذوو الكود التلقائي (الصف بلا كود يُنشأ بـcuid فيُعدّ تلقائياً، بلا معرّف معروف)
  const phones = new Map<string, Bucket>();
  const names = new Map<string, Bucket>();
  const byId = new Map<string, { phone: string | null; name: string; code: string | null }>();
  const bump = (m: Map<string, Bucket>, k: string, auto: boolean, id?: string) => {
    const e = m.get(k) ?? { n: 0, auto: 0, autoIds: [] };
    e.n++;
    if (auto) { e.auto++; if (id) e.autoIds.push(id); }
    m.set(k, e);
  };
  const add = (c: ExistingCustomerKey) => {
    const code = trimmed(c.code); if (code) codes.add(code);
    const auto = isAutoCustomerCode(c.code);
    const phone = normImportPhone(c.phone); if (phone) bump(phones, phone, auto, c.id);
    const name = trimmed(c.name) ? normImportName(c.name!) : '';
    if (name) bump(names, name, auto, c.id);
    if (c.id) byId.set(c.id, { phone, name, code: typeof c.code === 'string' ? c.code : null });
  };
  existing.forEach(add);
  /** العميل الوحيد المعروف المعرّف في الحاوية: كل ذوي الكود التلقائي فيها واحد ومعرّفه معلوم */
  const soleAuto = (b: Bucket | undefined): string | undefined => (b && b.auto === 1 && b.autoIds.length === 1 ? b.autoIds[0] : undefined);
  return {
    decide(r: CustomerImportRowKey, index: number): CustomerImportDecision {
      const row = index + 2;
      const code = trimmed(r.code);
      const phone = normImportPhone(r.phone);
      const name = trimmed(r.name) ? normImportName(r.name) : '';
      if (code) {
        if (codes.has(code)) return { action: 'skip', index, row, reason: 'CODE_EXISTS' };
        // عميل بكود تلقائي بالجوال نفسه (أو الاسم الفريد) هو غالباً العميل نفسه مستورداً بلا كود ⇒ يُربط الكود به لا إنشاء مكرر
        const p = phone ? phones.get(phone) : undefined;
        const nm = name ? names.get(name) : undefined;
        if (p ? p.auto > 0 : nm !== undefined && nm.n === 1 && nm.auto === 1) {
          const target = p ? soleAuto(p) : soleAuto(nm);
          if (target) {
            return { action: 'attach', index, row, customerId: target, code, fromCode: byId.get(target)?.code ?? null, matchedBy: p ? 'phone' : 'name' };
          }
          return { action: 'skip', index, row, reason: 'CODE_ATTACHABLE' };
        }
        // اسم يشترك فيه أكثر من عميل بعضهم بكود تلقائي، ولا جوال يميّز ⇒ لا يُعرف أيهم، ولا يُنشأ عميل آخر مكرر
        if (!phone && nm !== undefined && nm.n > 1 && nm.auto > 0) return { action: 'skip', index, row, reason: 'CODE_AMBIGUOUS_NAME' };
        const similar = phone && phones.has(phone) ? 'phone' as const : name && names.has(name) ? 'name' as const : undefined;
        return { action: 'create', index, row, phone: storedCustomerPhone(r.phone), ...(similar ? { similar } : {}) };
      }
      if (phone && phones.has(phone)) return { action: 'skip', index, row, reason: 'PHONE_EXISTS' };
      if (name && names.has(name)) return { action: 'skip', index, row, reason: 'NAME_EXISTS' };
      return { action: 'create', index, row, phone: storedCustomerPhone(r.phone) };
    },
    commit(r: CustomerImportRowKey): void { add(r); },
    /** بعد attach: العميل صار بكود بشري (لا يُربط به كود آخر، والكود محجوز) */
    commitAttach(d: { customerId: string; code: string }): void {
      codes.add(d.code);
      const c = byId.get(d.customerId);
      if (!c) return;
      for (const [m, k] of [[phones, c.phone], [names, c.name]] as const) {
        const b = k ? m.get(k) : undefined;
        if (!b) continue;
        const i = b.autoIds.indexOf(d.customerId);
        if (i >= 0) { b.autoIds.splice(i, 1); b.auto--; }
      }
      c.code = d.code;
    },
  };
}

/** خطة كاملة لصفوف الملف (للاختبار ولمسار /customers) */
export function planCustomerImport(existing: readonly ExistingCustomerKey[], rows: readonly CustomerImportRowKey[]): CustomerImportDecision[] {
  const planner = customerImportPlanner(existing);
  return rows.map((r, i) => {
    const d = planner.decide(r, i);
    if (d.action === 'create') planner.commit(r);
    else if (d.action === 'attach') planner.commitAttach(d);
    return d;
  });
}
