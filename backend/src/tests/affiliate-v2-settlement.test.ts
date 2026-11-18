// «سفير فيلد سيلز» v2 — الدفتر والتسوية ولوحة المالك (V2_SPEC §5 و§6.2 — قرار المالك ١٨ نوفمبر ٢٠٢٦):
// حدود الدورة 1/11/21 بالرياض، دورةٌ مرّةً واحدة بعلامتها ولو تعدّدت النسخ، مسودّاتٌ فقط (المنصّة لا تحرّك مالاً)،
// المواد مفحوصةٌ بالبايتات، والمطالبات الفائتة بلا بيانات اتصالٍ في نصوصها. فوق Prisma ودفترٍ مزيّفين (بلا قاعدة).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Prisma } from '@prisma/client';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'affiliate-v2-settlement-test';
const SRC = path.join(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ─── Prisma مزيّف: علامات OpsMarker وتجميع الدفعات وحدها ───
type Marker = { key: string; value: string; updatedAt: Date; createdAt: Date };
const markers = new Map<string, Marker>();
let markerCreateFails: Error | null = null;
const fakePrisma = {
  opsMarker: {
    async create(a: { data: { key: string; value?: string } }) {
      if (markerCreateFails) throw markerCreateFails;
      if (markers.has(a.data.key)) throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      const now = new Date();
      const m = { key: a.data.key, value: a.data.value ?? 'sent', updatedAt: now, createdAt: now };
      markers.set(m.key, m);
      return m;
    },
    async updateMany(a: { where: { key: string; value: string; updatedAt: { lt: Date } }; data: { value: string } }) {
      const m = markers.get(a.where.key);
      if (!m || m.value !== a.where.value || !(m.updatedAt.getTime() < a.where.updatedAt.lt.getTime())) return { count: 0 };
      m.value = a.data.value; m.updatedAt = new Date();
      return { count: 1 };
    },
    async update(a: { where: { key: string }; data: { value: string } }) {
      const m = markers.get(a.where.key);
      if (!m) throw new Error('missing marker');
      m.value = a.data.value; m.updatedAt = new Date();
      return m;
    },
    async findUnique(a: { where: { key: string } }) { return markers.get(a.where.key) ?? null; },
  },
  affiliatePayout: {
    async aggregate(a: { where: { cycleKey: string } }) {
      const rows = created.filter(c => c.cycleKey === a.where.cycleKey);
      return { _count: { _all: rows.length }, _sum: { netHalalas: rows.length ? rows.reduce((s, r) => s + r.netHalalas, 0) : null } };
    },
  },
};
stub('config/database', { default: fakePrisma });

// ─── دفترٌ مزيّف: ما تستدعيه الدورة ───
class LedgerError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
type Cand = { affiliate: { id: string; fullName: string; code: string; email: string }; netHalalas: number; eligible: boolean; blockedBy: string | null };
let candidates: Cand[] = [];
let created: Array<{ id: string; affiliateId: string; cycleKey: string; netHalalas: number; ibanLast4: string }> = [];
const calls: string[] = [];
stub('services/affiliate/ledger', {
  LedgerError,
  async reconcile() { calls.push('reconcile'); return { accrued: 0, synced: 0 }; },
  async autoApproveEligible() { calls.push('autoApprove'); return { approved: 2, skipped: 1 }; },
  async payoutCandidates() { calls.push('candidates'); return candidates; },
  async createCyclePayout(affiliateId: string, cycle: { cycleKey: string; periodStart: Date; periodEnd: Date }) {
    calls.push(`create:${affiliateId}`);
    // الدفتر الحقيقيّ يفحص هذا داخل القفل (draftPayout: cycle_done)
    if (created.some(c => c.affiliateId === affiliateId && c.cycleKey === cycle.cycleKey)) throw new LedgerError(409, 'للسفير دفعةٌ في هذه الدورة', 'cycle_done');
    const c = candidates.find(x => x.affiliate.id === affiliateId)!;
    const row = { id: `p${created.length + 1}`, affiliateId, cycleKey: cycle.cycleKey, netHalalas: c.netHalalas, ibanLast4: '1234' };
    created.push(row);
    return row;
  },
});
const mails: Array<{ payouts: unknown[]; totalHalalas: number; waitingProfile: number; cycleKey: string }> = [];
stub('services/affiliate/settlementMail', {
  mailOwnerSettlementSummary(s: { payouts: unknown[]; totalHalalas: number; waitingProfile: number; cycleKey: string }) { mails.push(s); },
  mailPayoutFailed() { /* لا شيء */ },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const settlement = require('../services/affiliate/settlement') as typeof import('../services/affiliate/settlement');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const materials = require('../services/affiliate/materials') as typeof import('../services/affiliate/materials');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const missed = require('../services/affiliate/missedClaims') as typeof import('../services/affiliate/missedClaims');

const reset = () => { markers.clear(); markerCreateFails = null; created = []; calls.length = 0; mails.length = 0; };
const aff = (id: string) => ({ id, fullName: `سفير ${id}`, code: `CODE${id}`.toUpperCase().padEnd(8, 'X').slice(0, 8), email: `${id}@x.co` });

// ═══════════════════ حدود الدورة ═══════════════════

test('حدود الدورة: نهاياتها 1 و11 و21 منتصف ليل الرياض (21:00 UTC من اليوم السابق)', () => {
  const at = (iso: string) => settlement.cycleBounds(new Date(iso));
  const mid = at('2026-11-18T12:00:00Z');
  assert.equal(mid.cycleKey, '2026-11-11');
  assert.equal(mid.periodStart.toISOString(), '2026-10-31T21:00:00.000Z', 'البداية = النهاية السابقة (1 نوفمبر بالرياض)');
  assert.equal(mid.periodEnd.toISOString(), '2026-11-10T21:00:00.000Z');
  assert.equal(settlement.nextSettlementAt(new Date('2026-11-18T12:00:00Z')).toISOString(), '2026-11-20T21:00:00.000Z');

  // لحظة النهاية نفسها: الدورة منتهية، والقادمة بعد عشرة أيام
  assert.equal(at('2026-11-10T21:00:00Z').cycleKey, '2026-11-11');
  assert.equal(settlement.nextSettlementAt(new Date('2026-11-10T21:00:00Z')).toISOString(), '2026-11-20T21:00:00.000Z');
  // قبلها بثانية: ما زلنا في دورة ١ نوفمبر (21:00 UTC لم تأتِ — يوم ١٠ بالرياض)
  const before = at('2026-11-10T20:59:59Z');
  assert.equal(before.cycleKey, '2026-11-01');
  assert.equal(before.periodStart.toISOString(), '2026-10-20T21:00:00.000Z', '21 أكتوبر بالرياض');
  assert.equal(settlement.nextSettlementAt(new Date('2026-11-10T20:59:59Z')).toISOString(), '2026-11-10T21:00:00.000Z');
  // يوم ١ بتوقيت UTC قبل منتصف ليل الرياض بثلاث ساعات يُعدّ ١ بالرياض بعد 21:00
  assert.equal(at('2026-11-30T21:30:00Z').cycleKey, '2026-12-01');

  // التفاف السنة والشهر
  const jan = at('2027-01-03T08:00:00Z');
  assert.equal(jan.cycleKey, '2027-01-01');
  assert.equal(jan.periodStart.toISOString(), '2026-12-20T21:00:00.000Z', '21 ديسمبر بالرياض');
  assert.equal(jan.periodEnd.toISOString(), '2026-12-31T21:00:00.000Z');
  assert.equal(settlement.nextSettlementAt(new Date('2026-12-25T10:00:00Z')).toISOString(), '2026-12-31T21:00:00.000Z');
  assert.equal(at('2027-03-05T10:00:00Z').periodStart.toISOString(), '2027-02-20T21:00:00.000Z', 'فبراير: الدورة 21→1 ثمانية أيام');
});

test('حدود الدورة متّصلة بلا فجوةٍ ولا تداخل: نهاية كلّ دورة بداية التي تليها', () => {
  let t = new Date('2026-01-01T00:00:00Z').getTime();
  const end = new Date('2028-12-31T00:00:00Z').getTime();
  let n = 0;
  while (t < end) {
    const now = new Date(t);
    const b = settlement.cycleBounds(now);
    const next = settlement.nextSettlementAt(now);
    assert.ok(b.periodEnd.getTime() <= t && t < next.getTime(), `${now.toISOString()}`);
    const after = settlement.cycleBounds(next);
    assert.equal(after.periodStart.getTime(), b.periodEnd.getTime(), 'لا فجوة');
    assert.equal(after.periodEnd.getTime(), next.getTime());
    const days = (next.getTime() - b.periodEnd.getTime()) / 86_400_000;
    assert.ok(days >= 8 && days <= 11, `${days} أيام`);
    assert.equal(b.periodEnd.getUTCHours(), 21);
    assert.match(b.cycleKey, /^\d{4}-\d{2}-(01|11|21)$/);
    assert.equal(b.cycleKey, new Date(b.periodEnd.getTime() + 3 * 3600_000).toISOString().slice(0, 10), 'المفتاح تاريخ النهاية بالرياض');
    t += 7 * 3600_000 + 13 * 60_000; n++;
  }
  assert.ok(n > 3000);
  assert.equal(settlement.settlementMarkerKey('2026-11-11'), 'ax-settle:2026-11-11');
});

// ═══════════════════ الدورة: مرّةً واحدة ومسودّاتٌ فقط ═══════════════════

const NOW = new Date('2026-11-12T03:00:00Z'); // بعد نهاية دورة ١١ نوفمبر

test('الدورة التلقائية: مصالحة ثمّ اعتماد ثمّ مسودّات للمؤهَّلين وحدهم، وملخّصٌ للمالك', async () => {
  reset();
  candidates = [
    { affiliate: aff('a'), netHalalas: 8970, eligible: true, blockedBy: null },
    { affiliate: aff('b'), netHalalas: 2000, eligible: false, blockedBy: 'below_min' },
    { affiliate: aff('c'), netHalalas: 11970, eligible: false, blockedBy: 'profile_incomplete' },
    { affiliate: aff('d'), netHalalas: 5000, eligible: true, blockedBy: null },
    { affiliate: aff('e'), netHalalas: 7000, eligible: false, blockedBy: 'iban_failed' },
  ];
  const r = await settlement.runSettlementCycle(NOW);
  assert.equal(r.ran, true);
  assert.equal(r.cycleKey, '2026-11-11');
  assert.deepEqual(calls.slice(0, 3), ['reconcile', 'autoApprove', 'candidates'], 'الترتيب: المصالحة ثمّ الاعتماد ثمّ المرشّحون');
  assert.deepEqual(created.map(c => c.affiliateId), ['a', 'd'], 'المؤهَّلون وحدهم — ما دون الحدّ يُرحَّل');
  assert.equal(r.totalHalalas, 13970);
  assert.equal(r.autoApproved, 2);
  assert.deepEqual(r.skipped, { profile_incomplete: 1, iban_failed: 1 }, 'ما دون الحدّ لا يُعدّ حجباً');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].payouts.length, 2);
  assert.equal(mails[0].totalHalalas, 13970);
  assert.equal(mails[0].waitingProfile, 1);
  const m = markers.get('ax-settle:2026-11-11')!;
  assert.notEqual(m.value, 'running', 'العلامة تُختم منجزةً بملخّصها');
  assert.equal(JSON.parse(m.value).payouts, 2);

  const last = await settlement.lastCycleSummary(NOW);
  assert.deepEqual({ ...last, ranAt: !!last.ranAt }, { cycleKey: '2026-11-11', payouts: 2, totalHalalas: 13970, ranAt: true });
});

test('مرّةً واحدة لكلّ دورة: التشغيل الثاني (نسخةٌ أخرى أو إعادة تشغيل) لا يُنشئ شيئاً ولا يرسل بريداً', async () => {
  const before = created.length;
  calls.length = 0; mails.length = 0;
  const r = await settlement.runSettlementCycle(new Date(NOW.getTime() + 3600_000));
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'already_ran');
  assert.equal(created.length, before);
  assert.deepEqual(calls, [], 'لا مصالحة ولا اعتماد ولا مرشّحون');
  assert.equal(mails.length, 0);
});

test('«تشغيل الدورة الآن» يدوياً بالمفتاح نفسه: لا دفعة ثانية لسفيرٍ في الدورة، ويلتقط من صار مؤهَّلاً', async () => {
  calls.length = 0; mails.length = 0;
  // أكمل «c» ملفه بعد مرور الدورة
  candidates = candidates.map(c => (c.affiliate.id === 'c' ? { ...c, eligible: true, blockedBy: null } : c));
  const by = { actorType: 'owner' as const, actorId: 'o1' };
  const r = await settlement.runSettlementCycle(new Date(NOW.getTime() + 2 * 3600_000), { by });
  assert.equal(r.ran, true);
  assert.equal(r.manual, true);
  assert.deepEqual(r.payouts.map(p => p.affiliateId), ['c']);
  assert.equal(r.skipped.cycle_done, 2, 'a وd لهما دفعةٌ في هذه الدورة');
  assert.equal(created.filter(c => c.affiliateId === 'a').length, 1);
  assert.equal(mails.length, 1, 'دفعةٌ جديدة ⇒ ملخّص');
  const again = await settlement.runSettlementCycle(new Date(NOW.getTime() + 3 * 3600_000), { by });
  assert.equal(again.payouts.length, 0);
  assert.equal(mails.length, 1, 'اليدويّ بلا جديد لا يرسل بريداً');
});

test('علامة «running» قديمة (نسخةٌ ماتت في منتصف الدورة) تُستأنف، والحديثة تُحترم، وخطأ القاعدة لا يُعدّ إنجازاً', async () => {
  reset();
  candidates = [{ affiliate: aff('a'), netHalalas: 8970, eligible: true, blockedBy: null }];
  markers.set('ax-settle:2026-11-11', { key: 'ax-settle:2026-11-11', value: 'running', updatedAt: new Date(NOW.getTime() - 5 * 60_000), createdAt: NOW });
  assert.equal((await settlement.runSettlementCycle(NOW)).ran, false, 'نسخةٌ أخرى تعمل الآن');
  markers.get('ax-settle:2026-11-11')!.updatedAt = new Date(NOW.getTime() - 45 * 60_000);
  const r = await settlement.runSettlementCycle(NOW);
  assert.equal(r.ran, true, 'استئنافٌ بعد موت العملية');
  assert.equal(created.length, 1);

  reset();
  markerCreateFails = new Error('database unreachable');
  await assert.rejects(() => settlement.runSettlementCycle(NOW), /unreachable/, 'تُعاد المحاولة في النبضة التالية');
  assert.equal(markers.size, 0);
  assert.equal(created.length, 0);
});

// ═══════════════════ المواد التسويقية: البايتات هي الحَكَم ═══════════════════

const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`;
const pad = (head: number[] | Buffer) => Buffer.concat([Buffer.from(head as number[]), Buffer.alloc(64, 7)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = pad(Buffer.from('%PDF-1.7\n'));
const MP4 = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]));
const MOV = pad(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')]));
const WEBM = pad([0x1a, 0x45, 0xdf, 0xa3]);
const SVG = pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));

test('المواد: النوع من البايتات لا من البادئة، والفئة تطابقه، وSVG/HTML مرفوضان', () => {
  const ok = materials.parseMaterialData(dataUrl('image/png', PNG), 'image');
  assert.ok(ok.ok && ok.mime === 'image/png' && ok.bytes.length === PNG.length);
  const mov = materials.parseMaterialData(dataUrl('video/quicktime', MOV), 'video');
  assert.ok(mov.ok && mov.mime === 'video/quicktime');
  const mp4 = materials.parseMaterialData(dataUrl('video/mp4', MP4), 'video');
  assert.ok(mp4.ok && mp4.mime === 'video/mp4');
  assert.ok(materials.parseMaterialData(dataUrl('video/webm', WEBM), 'video').ok);
  assert.ok(materials.parseMaterialData(dataUrl('application/pdf', PDF), 'document').ok);

  const bad: Array<[string, ReturnType<typeof materials.parseMaterialData>]> = [
    ['PDF بادئته صورة', materials.parseMaterialData(dataUrl('image/png', PDF), 'image')],
    ['صورةٌ في فئة المستند', materials.parseMaterialData(dataUrl('image/png', PNG), 'document')],
    ['SVG', materials.parseMaterialData(dataUrl('image/svg+xml', SVG), 'image')],
    ['HTML', materials.parseMaterialData(dataUrl('text/html', SVG), 'document')],
    ['SVG ببادئة PNG', materials.parseMaterialData(dataUrl('image/png', SVG), 'image')],
    ['ليس data URL', materials.parseMaterialData('https://x.co/a.png', 'image')],
    ['base64 تالف', materials.parseMaterialData('data:image/png;base64,iVBOR*w0K', 'image')],
    ['صغيرٌ جداً', materials.parseMaterialData(dataUrl('image/png', PNG.subarray(0, 12)), 'image')],
  ];
  for (const [name, r] of bad) assert.equal(r.ok, false, name);
  // الحجم قبل أيّ فحص: نصٌّ أطول من ٨ ميغابايت بعد الفكّ يُرفض فوراً
  const huge = `data:image/png;base64,${'A'.repeat(Math.ceil((materials.MATERIAL_MAX_BYTES + 3) / 3) * 4 + 100)}`;
  const h = materials.parseMaterialData(huge, 'image');
  assert.ok(!h.ok && /٨ ميغابايت/.test(h.reason));
  assert.equal(materials.MATERIAL_MAX_BYTES, 8 * 1024 * 1024, 'V2_SPEC §6.2: ملف ≤ ٨ ميغابايت');
});

test('المواد: اسم الملف بلا محارف اتجاهٍ ولا مسار، وامتداده من النوع المفحوص', () => {
  assert.equal(materials.materialFileName('عرض‮fdp.exe', 'application/pdf', 'عرض'), 'عرض fdp.pdf');
  assert.equal(materials.materialFileName('../../etc/passwd', 'image/png', 'ص'), '.. .. etc passwd.png');
  assert.equal(materials.materialFileName('', 'video/mp4', 'فيديو تعريفي'), 'فيديو تعريفي.mp4');
  assert.equal(materials.materialFileName('photo.HEIC', 'image/jpeg', 'x'), 'photo.jpg');
});

test('المواد: قواعد الفئات قبل أيّ كتابة', async () => {
  const by = { actorType: 'owner' as const, actorId: 'o1' };
  const rejects = async (input: Parameters<typeof materials.createMaterial>[0], re: RegExp) => {
    await assert.rejects(() => materials.createMaterial(input, by), (e: unknown) => e instanceof LedgerError && e.status === 400 && re.test(e.message));
  };
  await rejects({ title: 'ن', category: 'text', textBody: 'x' }, /العنوان/);
  await rejects({ title: 'نصّ جاهز', category: 'text' }, /النصّ الجاهز/);
  await rejects({ title: 'رابط', category: 'link', url: 'javascript:alert(1)' }, /https/);
  await rejects({ title: 'رابط', category: 'link' }, /الرابط/);
  await rejects({ title: 'صورة', category: 'image' }, /أرفق الملف/);
  await rejects({ title: 'صورة', category: 'image', url: 'https://x.co/a.png', dataUrl: dataUrl('image/png', PNG) }, /رابط/);
  await rejects({ title: 'فيديو', category: 'video', url: 'https://youtu.be/x', dataUrl: dataUrl('video/mp4', MP4) }, /واحدٌ منهما/);
  await rejects({ title: 'فيديو', category: 'video' }, /واحدٌ منهما/);
  await rejects({ title: 'مستند', category: 'document', dataUrl: dataUrl('image/png', PNG) }, /الفئة/);
  await rejects({ title: 'فئة', category: 'audio' as never, textBody: 'x' }, /فئة/);
});

// ═══════════════════ المطالبات الفائتة ═══════════════════

test('المطالبة الفائتة: الاسم والملاحظة بلا جوالٍ ولا بريد، والرقم والسجل في خانتيهما مطبَّعين', () => {
  const v = missed.normalizeMissedClaim({ companyName: '  مؤسسة   النور  ', contactPhone: '055 123 4567', crNumber: '١٠١٠١٢٣٤٥٦', note: 'زرتهم في المعرض' });
  assert.deepEqual(v, { companyName: 'مؤسسة النور', contactPhone: '966551234567', crNumber: '1010123456', note: 'زرتهم في المعرض' });
  assert.deepEqual(missed.normalizeMissedClaim({ companyName: 'مطعم الريف' }), { companyName: 'مطعم الريف', contactPhone: null, crNumber: null, note: null });
  const code = (input: Parameters<typeof missed.normalizeMissedClaim>[0]) => {
    try { missed.normalizeMissedClaim(input); return 'ok'; } catch (e) { return (e as LedgerError).code; }
  };
  assert.equal(code({ companyName: 'النور 0551234567' }), 'contact_in_text');
  assert.equal(code({ companyName: 'النور', note: 'المدير ali@x.co' }), 'contact_in_text');
  assert.equal(code({ companyName: 'ن' }), 'invalid');
  assert.equal(code({ companyName: 'النور', note: 'x'.repeat(201) }), 'invalid');
  assert.equal(code({ companyName: 'النور', crNumber: '12345' }), 'invalid_cr');
  assert.equal(code({ companyName: 'النور', contactPhone: '12' }), 'invalid_phone');
  assert.equal(missed.MISSED_CLAIM_OPEN_LIMIT, 20, 'V2_SPEC §6.1: الحد ٢٠ مفتوحة');
  assert.equal(missed.MISSED_CLAIM_WINDOW_DAYS, 30, 'الشروط v4: خلال ٣٠ يوماً من تسجيل الشركة');
  assert.deepEqual([...missed.MISSED_CLAIM_STATUSES], ['under_review', 'accepted', 'rejected', 'withdrawn']);
  assert.deepEqual([...materials.MATERIAL_CATEGORIES], ['image', 'video', 'document', 'text', 'link']);
});

// ═══════════════════ حرّاس الوصل ═══════════════════

test('المجدول: نبضةٌ كلّ ساعة بعد تأخير الإقلاع، unref، ومفتاح إطفاء — ومن index.ts مع ترقية الإرث', () => {
  const s = strip(read('services', 'affiliate', 'settlement.ts'));
  const sched = s.slice(s.indexOf('export function startAffiliateSettlementScheduler'));
  assert.match(sched, /process\.env\.AX_SETTLEMENT_ENABLED === '0'/);
  assert.match(sched, /setInterval\([\s\S]*3600_000\)\.unref\?\.\(\)/);
  assert.match(sched, /setTimeout\([\s\S]*\)\.unref\?\.\(\)/);
  assert.match(sched, /if \(running\) return;/, 'نبضتان لا تتراكبان في العملية الواحدة');
  assert.match(sched, /autoApproveEligible\(now\)[\s\S]*runSettlementCycle\(now\)/, 'الاعتماد بعد الحجز في كلّ نبضة لا كلّ عشرة أيام');
  const run = s.slice(s.indexOf('export async function runSettlementCycle'), s.indexOf('export async function lastCycleSummary'));
  assert.match(run, /claimMarker\(key, now\)/);
  assert.match(s, /settlementMarkerKey = \(cycleKey: string\) => `ax-settle:\$\{cycleKey\}`/);
  const order = ['claimMarker(', 'reconcile()', 'autoApproveEligible(now)', 'payoutCandidates()', 'createCyclePayout(', 'mailOwnerSettlementSummary('].map(x => run.indexOf(x));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `ترتيب الدورة ${order}`);
  assert.doesNotMatch(run, /createPayout\(|recordPayout|status: 'recorded'/, 'مسودّاتٌ فقط بمنفّذ النظام');

  const index = strip(read('index.ts'));
  const listen = index.slice(index.indexOf('server.listen('));
  assert.ok(listen.indexOf('startAffiliateSettlementScheduler()') > listen.indexOf('startPresenceChecks()'), 'مع المجدولات الأخرى بعد الإقلاع');
  assert.match(listen, /promoteLegacyPendingAffiliates/, 'ترقية pending_* القديمة مرّةً عند الإقلاع (الوكيل A)');
  assert.match(index, /import \{ startAffiliateSettlementScheduler \} from '\.\/services\/affiliate\/settlement';/);
});

test('مسارات المالك v2: المستند يُسجَّل عرضه، والفشل بسببٍ محدود، والقبول إسنادٌ يدويّ قبل ختم المطالبة', () => {
  const admin = strip(read('routes', 'affiliateAdmin.ts'));
  const route = (sig: string) => {
    const i = admin.indexOf(sig);
    assert.ok(i >= 0, sig);
    return admin.slice(i, admin.indexOf('\nrouter.', i + 10));
  };
  const doc = route("router.get('/affiliates/:id/documents/:kind'");
  assert.match(doc, /\(DOC_KINDS as readonly string\[\]\)\.includes\(kind\)/, 'نوعٌ معروف قبل أيّ قراءة');
  assert.match(doc, /documentDataUrl\(id, kind as /);
  // من ملف الوكيل A توقيعا §11 وحدهما — فيبقى تنفيذه الأصليّ في الدمج
  assert.match(admin, /import \{ profileStatus, documentDataUrl \} from '\.\.\/services\/affiliate\/documents';/);
  assert.match(doc, /action: 'document_viewed', \.\.\.platformActor\(req\)/);
  assert.ok(doc.indexOf('document_viewed') < doc.indexOf('res.json'), 'الحدث قبل الردّ');
  assert.match(route("router.post('/payouts/:id/fail'"), /min\(3, 'اذكر السبب'\)\.max\(300\)[\s\S]*await failPayout\(String\(req\.params\.id\), platformActor\(req\), reason\)/);
  assert.match(route("router.post('/settlement/run'"), /runSettlementCycle\(new Date\(\), \{ by: platformActor\(req\) \}\)/);
  const accept = route("router.post('/missed-claims/:id/accept'");
  const o = ['prepareMissedClaimAccept(', 'await createOwnerAttribution(', 'markMissedClaimAccepted('].map(x => accept.indexOf(x));
  assert.ok(o[0] > 0 && o[1] > o[0] && o[2] > o[1], 'فحوص القبول ثمّ الإسناد ثمّ الختم — فشل الإسناد يُبقيها قيد المراجعة');
  assert.match(accept, /effectiveFrom: prep\.effectiveFrom/, 'الإسناد من لحظة تسجيل الشركة');
  const overview = route("router.get('/overview'");
  for (const k of ['newAffiliates7d', 'incompleteProfiles', 'missedClaimsUnderReview', 'nextSettlementAt', 'lastCycle']) assert.match(overview, new RegExp(k), k);
  assert.doesNotMatch(overview, /pending_review:/, 'v2: لا طلبات انضمام بانتظار المراجعة');
  const detail = route("router.get('/affiliates/:id'");
  assert.match(detail, /profileStatus\(id\)/);
  assert.match(detail, /select: \{ kind: true, mime: true, sizeBytes: true, createdAt: true \}/, 'بياناتٌ وصفية فقط — لا المستند في التفصيل');
  assert.match(route("router.post('/affiliates/:id/reactivate'"), /decideUser\(req, res, 'approved', \{ from: \['rejected'\]/, 'v2 §3: rejected→approved');
  // المستند لا يُقرأ إلا بمساره المسجَّل
  const ledger = strip(read('services', 'affiliate', 'ledger.ts'));
  assert.doesNotMatch(admin.replace(doc, '') + ledger, /documentDataUrl\(/);
});
