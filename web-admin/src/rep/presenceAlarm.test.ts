import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  createPresenceAlarm, installPresenceAlarmUnlock, startPresenceAlarm, stopPresenceAlarm, silencePresenceAlarm,
  PRESENCE_ALARM_CAP_MS, PRESENCE_ALARM_CYCLE_MS, PRESENCE_BEEPS, PRESENCE_VIBRATE, PRESENCE_GAIN, PRESENCE_UNLOCK_EVENTS,
  type AlarmEnv, type AudioCtxLike,
} from './presenceAlarm';

// جرس «أثبت تواجدك» (طلب المالك، ٤ نوفمبر ٢٠٢٦): صوت منبّه واهتزاز يتكرّران حتى الضغط أو النتيجة أو انتهاء المهلة وبسقف ثلاث
// دقائق — وصامتٌ بلا خطأ حيث يمنعه المتصفح. بيئةٌ مزيّفة: ساعةٌ يدوية وسياق صوتٍ يسجّل ما جُدول، واهتزازٌ يُسجَّل.

class FakeParam {
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) { this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['ramp', v, t]); }
}
class FakeOsc {
  type = 'sine'; frequency = new FakeParam(); started: number | null = null; stopped: number | null = null;
  onended: (() => void) | null = null; disconnected = false;
  connect(d: unknown) { return d; }
  disconnect() { this.disconnected = true; }
  start(t = 0) { this.started = t; }
  stop(t = 0) { this.stopped = t; }
}
class FakeGain { gain = new FakeParam(); disconnected = false; connect(d: unknown) { return d; } disconnect() { this.disconnected = true; } }
class FakeSrc { buffer: unknown = null; started: number | null = null; onended: (() => void) | null = null; connect(d: unknown) { return d; } disconnect() { /* */ } start(t = 0) { this.started = t; } }
type ResumeMode = 'run' | 'never' | 'reject';
class FakeCtx implements AudioCtxLike {
  state: string; currentTime = 5; destination = {};
  oscs: FakeOsc[] = []; gains: FakeGain[] = []; srcs: FakeSrc[] = [];
  resumes = 0; suspends = 0; closes = 0;
  constructor(private mode: ResumeMode, initial: string) { this.state = initial; }
  resume() {
    this.resumes++;
    if (this.mode === 'never') return new Promise<void>(() => { /* Chrome بلا إذن صوت: معلّقٌ أبداً */ });
    if (this.mode === 'reject') return Promise.reject(new Error('NotAllowedError'));
    return Promise.resolve().then(() => { this.state = 'running'; });
  }
  suspend() { this.suspends++; return Promise.resolve().then(() => { this.state = 'suspended'; }); }
  close() { this.closes++; return Promise.resolve(); }
  createOscillator() { const o = new FakeOsc(); this.oscs.push(o); return o; }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createBuffer() { return { blank: true }; }
  createBufferSource() { const s = new FakeSrc(); this.srcs.push(s); return s; }
}

/** WakeLockSentinel مزيّف — released يقلبه المتصفح (والاختبار) */
class FakeLock { released = false; releases = 0; release() { this.releases++; this.released = true; return Promise.resolve(); } }
type LockMode = 'grant' | 'defer' | 'reject' | 'none' | 'throw';

function rig(o: { resume?: ResumeMode; initial?: string; noCtx?: boolean; ctxThrows?: boolean; session?: string; visible?: boolean; lock?: LockMode } = {}) {
  let now = 1_000_000;
  let ids = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let visible = o.visible ?? true;
  const visFns = new Set<() => void>();
  const vib: (number[] | 0)[] = [];
  const ctxs: FakeCtx[] = [];
  const session = o.session !== undefined ? { type: o.session } : null;
  const locks: FakeLock[] = [];
  const deferred: (() => void)[] = [];
  const stats = { lockRequests: 0 };
  const env: AlarmEnv = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++ids; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (h) => { timers.delete(h as number); },
    visible: () => visible,
    onVisibility: (fn) => { visFns.add(fn); return () => { visFns.delete(fn); }; },
    makeContext: () => {
      if (o.ctxThrows) throw new Error('NotSupportedError');
      if (o.noCtx) return null;
      const c = new FakeCtx(o.resume ?? 'run', o.initial ?? 'running');
      ctxs.push(c);
      return c;
    },
    vibrate: (p) => { vib.push(p === 0 ? 0 : [...p]); return true; },
    audioSession: () => session,
    wakeLock: () => {
      stats.lockRequests++;
      const m = o.lock ?? 'grant';
      if (m === 'none') return null;
      if (m === 'throw') throw new Error('TypeError');
      if (m === 'reject') return Promise.reject(new Error('NotAllowedError'));
      const l = new FakeLock();
      locks.push(l);
      return m === 'defer' ? new Promise<FakeLock>((r) => { deferred.push(() => r(l)); }) : Promise.resolve(l);
    },
  };
  /** يمضي الوقت ويُطلق المؤقّتات المستحقّة بترتيبها */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  const setVisible = (v: boolean) => { visible = v; for (const f of [...visFns]) f(); };
  const resolveLocks = () => { for (const f of deferred.splice(0)) f(); };
  return { env, advance, setVisible, vib, ctxs, session, timers, visFns, locks, stats, resolveLocks };
}
const flush = () => new Promise((r) => setImmediate(r));
const buzzes = (vib: (number[] | 0)[]) => vib.filter((v) => v !== 0).length;

test('ثوابت الجرس: رشقةٌ واهتزازٌ داخل الدورة، ونمط اهتزازٍ يقبله المتصفح', () => {
  assert.equal(PRESENCE_ALARM_CAP_MS, 180_000, 'ثلاث دقائق');
  const burstEnd = Math.max(...PRESENCE_BEEPS.map((b) => b.at + b.ms));
  assert.ok(burstEnd < PRESENCE_ALARM_CYCLE_MS);
  assert.ok(PRESENCE_VIBRATE.reduce((a, b) => a + b, 0) < PRESENCE_ALARM_CYCLE_MS, 'الاهتزاز ينتهي قبل الدورة التالية');
  assert.equal(PRESENCE_VIBRATE.length % 2, 1, 'طولٌ فرديّ: آخره اهتزاز');
  assert.ok(PRESENCE_VIBRATE.length <= 99 && PRESENCE_VIBRATE.every((v) => v > 0 && v <= 10_000), 'حدود Blink: ٩٩ عنصراً و١٠ ثوانٍ');
  assert.ok(PRESENCE_BEEPS.every((b) => b.hz >= 1000 && b.hz <= 2000), 'نطاق سمّاعة الجوال');
});

test('يرنّ والصفحة ظاهرة: رشقة نغماتٍ مربّعة بنغمتين واهتزازٌ يُعاد كل دورة، والشدّة تعلو في الدورات الأولى', () => {
  const r = rig();
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  assert.equal(a.running, true);
  assert.deepEqual(r.vib, [[...PRESENCE_VIBRATE]]);
  const c = r.ctxs[0];
  assert.deepEqual(c.oscs.map((x) => x.frequency.events[0][1]), PRESENCE_BEEPS.map((b) => b.hz));
  assert.ok(c.oscs.every((x) => x.type === 'square' && x.started! > c.currentTime && x.stopped! > x.started!), 'على ساعة الصوت بعد الآن');
  const peak = (g: FakeGain) => Math.max(...g.gain.events.map((e) => e[1]));
  assert.equal(peak(c.gains[0]), PRESENCE_GAIN.from);
  r.advance(PRESENCE_ALARM_CYCLE_MS);
  assert.equal(buzzes(r.vib), 2);
  assert.equal(c.oscs.length, PRESENCE_BEEPS.length * 2);
  r.advance(PRESENCE_ALARM_CYCLE_MS * 3);
  assert.equal(peak(c.gains[c.gains.length - 1]), PRESENCE_GAIN.to);
  assert.equal(r.ctxs.length, 1, 'سياقٌ واحد مشترك');
  a.stop();
});

test('الضغطة تُسكت فوراً (الصوت والاهتزاز) ولا يعود للطلب نفسه — وطلبٌ أحدث يرنّ', () => {
  const r = rig();
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  const c = r.ctxs[0];
  a.silence('c1');
  assert.equal(a.running, false);
  assert.equal(r.vib[r.vib.length - 1], 0, 'vibrate(0)');
  assert.ok(c.oscs.every((x) => x.stopped !== null && x.disconnected), 'النغمات المجدولة أُوقفت وفُصلت');
  assert.equal(r.timers.size, 0, 'لا دورة ولا سقف معلّق');
  assert.equal(r.visFns.size, 0, 'لا مستمع ظهور');
  assert.equal(c.closes, 0, 'suspend لا close — يبقى فتح iOS');
  const n = r.vib.length;
  r.advance(30_000);
  a.start('c1'); // «إغلاق مؤقت» بعد فشل الإرسال ثمّ النبضة تعيده
  assert.equal(a.running, false);
  assert.equal(r.vib.length, n);
  a.start('c2');
  assert.equal(a.running, true, 'طلبٌ جديد');
  a.stop('c1');
  assert.equal(a.running, true, 'إيقافٌ بمعرّفٍ آخر لا يمسّه');
  a.stop('c2');
  assert.equal(a.running, false);
});

test('السقف ثلاث دقائق من أوّل رنين — إعادة التركيب (StrictMode، النبضة) لا تعيده، وطلبٌ أحدث بعدٍّ جديد', () => {
  const r = rig();
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  a.stop('c1'); a.start('c1'); // StrictMode: تركيبٌ ففكٌّ فتركيب
  r.advance(60_000);
  a.stop('c1');
  r.advance(10_000);
  a.start('c1');
  assert.equal(a.running, true);
  r.advance(PRESENCE_ALARM_CAP_MS - 70_000 - 1);
  assert.equal(a.running, true);
  r.advance(1);
  assert.equal(a.running, false, 'انتهى السقف');
  assert.equal(r.vib[r.vib.length - 1], 0);
  assert.ok(r.ctxs[0].suspends >= 1, 'السياق يُوقف للبطارية');
  const n = r.vib.length;
  a.start('c1');
  r.advance(10_000);
  assert.equal(r.vib.length, n, 'بعد السقف لا رنين للطلب نفسه');
  a.start('c2');
  assert.equal(a.running, true);
  r.advance(PRESENCE_ALARM_CAP_MS - 1);
  assert.equal(a.running, true);
  r.advance(1);
  assert.equal(a.running, false);
});

test('مؤقّتٌ متأخّر (الصفحة مخفية طويلاً): السقف بالساعة — لا رنين بعده', () => {
  const r = rig();
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  r.timers.clear(); // المتصفح أخّر المؤقّتات كلها
  r.advance(PRESENCE_ALARM_CAP_MS + 5_000);
  r.setVisible(false); r.setVisible(true);
  const n = buzzes(r.vib);
  assert.equal(n, 1, 'لا دورة بعد السقف');
  assert.equal(a.running, false);
});

test('مخفية: لا رنين ولا اهتزاز (Blink يُبقي الصوت في الخلفية)، وظاهرةً يعود — وطلبٌ ركّب مخفياً ينتظر الظهور', () => {
  const r = rig();
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  const c = r.ctxs[0];
  r.setVisible(false);
  assert.equal(r.vib[r.vib.length - 1], 0);
  assert.ok(c.oscs.every((x) => x.stopped !== null));
  const n = r.vib.length;
  const tones = c.oscs.length;
  r.advance(20_000);
  assert.equal(r.vib.length, n, 'لا اهتزاز مخفياً');
  assert.equal(c.oscs.length, tones);
  assert.equal(a.running, true, 'الجرس قائم — يعود بالظهور');
  r.setVisible(true);
  assert.equal(buzzes(r.vib), 2);
  assert.equal(c.oscs.length, tones + PRESENCE_BEEPS.length);
  r.setVisible(true); // ظهورٌ مكرّر لا يضاعف الدورة
  assert.equal(buzzes(r.vib), 2);
  a.stop();

  const h = rig({ visible: false });
  const b = createPresenceAlarm(h.env);
  b.start('c9');
  assert.equal(h.vib.length, 0);
  assert.equal(h.ctxs.length, 0, 'لا سياق صوتٍ والصفحة مخفية');
  h.setVisible(true);
  assert.equal(buzzes(h.vib), 1);
  b.stop();
});

test('سياقٌ موقوف واستئنافٌ معلّق أبداً أو مرفوض: لا نغمة تُجدول، والاهتزاز يمضي، ولا خطأ', async () => {
  for (const mode of ['never', 'reject'] as const) {
    const r = rig({ resume: mode, initial: 'suspended' });
    const a = createPresenceAlarm(r.env);
    a.start('c1');
    await flush();
    r.advance(PRESENCE_ALARM_CYCLE_MS);
    await flush();
    const c = r.ctxs[0];
    assert.equal(c.oscs.length, 0, `${mode}: لا جدولة على سياقٍ موقوف`);
    assert.equal(c.resumes, 2, `${mode}: محاولةٌ كل دورة`);
    assert.equal(buzzes(r.vib), 2);
    a.silence('c1');
  }
});

test('استئنافٌ ينجح: نغمات الدورة بعده — لا لدورةٍ مضت ولا بعد الإيقاف', async () => {
  const r = rig({ resume: 'run', initial: 'suspended' });
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  const c = r.ctxs[0];
  assert.equal(c.oscs.length, 0);
  await flush();
  assert.equal(c.oscs.length, PRESENCE_BEEPS.length, 'بعد الاستئناف مباشرةً');
  r.advance(PRESENCE_ALARM_CYCLE_MS);
  assert.equal(c.oscs.length, PRESENCE_BEEPS.length * 2);
  a.stop();

  const s = rig({ resume: 'run', initial: 'suspended' });
  const b = createPresenceAlarm(s.env);
  b.start('c1');
  b.silence('c1'); // ضغط قبل أن يُستأنف
  await flush();
  assert.equal(s.ctxs[0].oscs.length, 0);
});

test('بلا Web Audio، أو إنشاء السياق يرمي، أو الاهتزاز يرمي، أو مُغلق: لا خطأ، وما يعمل يعمل', () => {
  for (const o of [{ noCtx: true }, { ctxThrows: true }]) {
    const r = rig(o);
    const a = createPresenceAlarm(r.env);
    assert.doesNotThrow(() => { a.start('c1'); r.advance(PRESENCE_ALARM_CYCLE_MS * 2); a.unlock(); a.silence('c1'); });
    assert.equal(buzzes(r.vib), 3, 'الاهتزاز وحده');
  }
  const r = rig();
  const a = createPresenceAlarm({ ...r.env, vibrate: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => a.start('c1'));
  assert.equal(r.ctxs[0].oscs.length, PRESENCE_BEEPS.length, 'الصوت وحده');
  a.stop();
  const z = rig();
  const b = createPresenceAlarm(z.env);
  b.start('c1');
  z.ctxs[0].state = 'closed';
  z.advance(PRESENCE_ALARM_CYCLE_MS * 2);
  assert.equal(z.ctxs.length, 2, 'سياقٌ مغلق يُستبدل');
  b.stop();
  // بلا متصفّح أصلاً (node): المشترك لا يرمي ولا يُبقي مؤقّتاً
  assert.doesNotThrow(() => { startPresenceAlarm('x'); silencePresenceAlarm('x'); stopPresenceAlarm(); });
});

test('iOS: audioSession «playback» أثناء الرنين وحده، ويعود كما كان مخفياً وبعد الإيقاف', () => {
  const r = rig({ session: 'auto' });
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  assert.equal(r.session!.type, 'playback');
  r.setVisible(false);
  assert.equal(r.session!.type, 'auto', 'موسيقى المندوب تعود');
  r.setVisible(true);
  assert.equal(r.session!.type, 'playback');
  a.silence('c1');
  assert.equal(r.session!.type, 'auto');
  const p = rig({ session: 'playback' });
  const b = createPresenceAlarm(p.env);
  b.start('c1'); b.stop();
  assert.equal(p.session!.type, 'playback', 'ما ضبطه غيرنا لا يُمسّ');
});

test('الفتح باللمسة: استئنافٌ ومخزنٌ صامت داخلها بلا انتظار، ثمّ إيقافٌ حتى يرنّ طلب — لا close', async () => {
  const r = rig({ resume: 'run', initial: 'suspended' });
  const a = createPresenceAlarm(r.env);
  a.unlock();
  const c = r.ctxs[0];
  assert.equal(c.resumes, 1);
  assert.equal(c.srcs.length, 1);
  assert.equal(c.srcs[0].started, 0, 'التشغيل بدأ داخل اللمسة نفسها (WebKit)');
  assert.equal(a.unlocked, false, 'لم يُرَ يعمل بعد');
  await flush();
  assert.equal(a.unlocked, true);
  assert.equal(c.suspends, 1, 'لا سياق يعمل بلا طلب');
  assert.equal(c.closes, 0);
  a.unlock();
  assert.equal(c.resumes, 1, 'مرّةً واحدة');
  // يرنّ الآن: الفتح لا يوقفه
  const s = rig({ resume: 'run', initial: 'suspended' });
  const b = createPresenceAlarm(s.env);
  b.start('c1');
  b.unlock();
  await flush();
  assert.equal(s.ctxs[0].suspends, 0);
  b.stop();
  // Chrome بلا لمسةٍ مسموحة: معلّقٌ — لا خطأ، ويُحاول باللمسة التالية
  const n = rig({ resume: 'never', initial: 'suspended' });
  const d = createPresenceAlarm(n.env);
  d.unlock(); d.unlock();
  await flush();
  assert.equal(d.unlocked, false);
  assert.equal(n.ctxs[0].resumes, 2);
});

test('Chrome: سياقٌ يولد «running» داخل اللمسة يُفتح ثمّ يُوقف حتى يرنّ طلب، ويُستأنف بلا لمسة — ولا يُوقف رنيناً قائماً', async () => {
  const listeners = new Map<string, () => void>();
  const target = {
    addEventListener: (t: string, fn: () => void) => { listeners.set(t, fn); },
    removeEventListener: (t: string, fn: () => void) => { if (listeners.get(t) === fn) listeners.delete(t); },
  } as unknown as EventTarget;
  const r = rig({ resume: 'run', initial: 'running' });
  const a = createPresenceAlarm(r.env);
  installPresenceAlarmUnlock(target, a);
  listeners.get('pointerup')!();
  const c = r.ctxs[0];
  assert.equal(a.unlocked, true);
  assert.equal(listeners.size, 0, 'أُزيلت باللمسة نفسها');
  assert.equal(c.suspends, 1, 'لا سياق يعمل من أوّل لمسةٍ إلى أوّل طلب');
  assert.equal(c.resumes, 0);
  assert.equal(c.closes, 0, 'suspend لا close');
  await flush();
  assert.equal(c.state, 'suspended');
  a.start('c1');
  assert.equal(c.oscs.length, 0, 'لا جدولة على سياقٍ موقوف');
  await flush();
  assert.equal(c.resumes, 1);
  assert.equal(c.oscs.length, PRESENCE_BEEPS.length, 'يُستأنف بلا لمسة ويرنّ');
  a.stop();
  // يرنّ الآن ثمّ أوّل لمسة: لا يُوقف
  const s = rig({ initial: 'running' });
  const b = createPresenceAlarm(s.env);
  b.start('c1');
  b.unlock();
  assert.equal(b.unlocked, true);
  assert.equal(s.ctxs[0].suspends, 0);
  b.stop();
});

test('قفل الشاشة: يُطلب مرّةً ما دام يرنّ ظاهراً، ويُحرَّر بالضغطة والإيقاف والسقف والإخفاء — ويُطلب ثانيةً بالظهور', async () => {
  // الجوال موضوعٌ والتطبيق مفتوح: لا تنطفئ الشاشة بمهلتها فيسكت الجرس قبل السقف
  const r = rig();
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  assert.equal(r.stats.lockRequests, 1);
  await flush();
  r.advance(PRESENCE_ALARM_CYCLE_MS * 3);
  assert.equal(r.stats.lockRequests, 1, 'لا طلب كل دورة');
  assert.equal(r.locks[0].releases, 0);
  a.silence('c1');
  assert.equal(r.locks[0].releases, 1, 'الضغطة تحرّره');
  r.advance(PRESENCE_ALARM_CYCLE_MS * 3);
  assert.equal(r.stats.lockRequests, 1);

  const s = rig();
  const b = createPresenceAlarm(s.env);
  b.start('c1');
  await flush();
  b.stop('c1');
  assert.equal(s.locks[0].releases, 1, 'الإيقاف (النتيجة، فكّ النافذة)');

  const c = rig();
  const d = createPresenceAlarm(c.env);
  d.start('c1');
  await flush();
  c.advance(PRESENCE_ALARM_CAP_MS);
  assert.equal(d.running, false);
  assert.equal(c.locks[0].releases, 1, 'السقف: تعود الشاشة لمهلتها');
  assert.equal(c.stats.lockRequests, 1);

  // المتصفح يحرّره والصفحة مخفية: يُطلب ثانيةً بظهورها، وما بقي من السقف
  const h = rig();
  const e = createPresenceAlarm(h.env);
  e.start('c1');
  await flush();
  h.setVisible(false);
  assert.equal(h.locks[0].releases, 1);
  h.advance(20_000);
  assert.equal(h.stats.lockRequests, 1, 'لا طلب مخفياً');
  h.setVisible(true);
  assert.equal(h.stats.lockRequests, 2);
  await flush();
  e.silence('c1');
  assert.equal(h.locks[1].releases, 1);

  // حرّره المتصفح والصفحة ظاهرة (released): طلبٌ آخر في الدورة التالية
  const y = rig();
  const f = createPresenceAlarm(y.env);
  f.start('c1');
  await flush();
  y.locks[0].released = true;
  y.advance(PRESENCE_ALARM_CYCLE_MS);
  assert.equal(y.stats.lockRequests, 2);
  f.stop();

  // طلبٌ ركّب مخفياً: لا قفل حتى الظهور
  const v = rig({ visible: false });
  const g = createPresenceAlarm(v.env);
  g.start('c1');
  assert.equal(v.stats.lockRequests, 0);
  v.setVisible(true);
  assert.equal(v.stats.lockRequests, 1);
  g.stop();
});

test('قفل الشاشة يصل بعد الإسكات أو الإخفاء: يُحرَّر فوراً ولا يُحفظ', async () => {
  const r = rig({ lock: 'defer' });
  const a = createPresenceAlarm(r.env);
  a.start('c1');
  a.silence('c1');
  r.resolveLocks();
  await flush();
  assert.equal(r.locks[0].releases, 1);

  const h = rig({ lock: 'defer' });
  const b = createPresenceAlarm(h.env);
  b.start('c1');
  h.setVisible(false);
  h.setVisible(true);
  assert.equal(h.stats.lockRequests, 2);
  h.resolveLocks();
  await flush();
  assert.equal(h.locks[0].releases, 1, 'طلب ما قبل الإخفاء يُحرَّر');
  assert.equal(h.locks[1].releases, 0, 'والأحدث يُمسك');
  b.stop();
  assert.equal(h.locks[1].releases, 1);
});

test('قفل الشاشة مرفوضٌ أو غائب أو يرمي: لا خطأ، والصوت والاهتزاز يمضيان، والطلب مرّةً لكل ظهور', async () => {
  for (const mode of ['reject', 'none', 'throw'] as const) {
    const r = rig({ lock: mode });
    const a = createPresenceAlarm(r.env);
    assert.doesNotThrow(() => a.start('c1'));
    await flush();
    r.advance(PRESENCE_ALARM_CYCLE_MS * 2);
    await flush();
    assert.equal(buzzes(r.vib), 3, `${mode}: الاهتزاز`);
    assert.equal(r.ctxs[0].oscs.length, PRESENCE_BEEPS.length * 3, `${mode}: الصوت`);
    assert.equal(r.stats.lockRequests, 1, `${mode}: لا يُعاد كل دورة`);
    r.setVisible(false); r.setVisible(true);
    assert.equal(r.stats.lockRequests, 2, `${mode}: ويُعاد بالظهور`);
    a.stop();
  }
});

test('قفل الشاشة في المتصفح: navigator.wakeLock.request(\'screen\') بسياقه، وبلا wakeLock لا شيء', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls: { self: unknown; type: string }[] = [];
  const sentinel = new FakeLock();
  const wakeLock = { request(this: unknown, type: string) { calls.push({ self: this, type }); return Promise.resolve(sentinel); } };
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { wakeLock }, configurable: true, writable: true });
    const r = rig();
    const { wakeLock: _drop, ...env } = r.env; // قفل البيئة الحقيقية
    void _drop;
    const a = createPresenceAlarm(env);
    a.start('c1');
    await flush();
    assert.deepEqual(calls, [{ self: wakeLock, type: 'screen' }]);
    a.silence('c1');
    assert.equal(sentinel.releases, 1);
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });
    const b = createPresenceAlarm(env);
    assert.doesNotThrow(() => { b.start('c2'); b.stop(); });
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('installPresenceAlarmUnlock: مستمعو التقاط سلبيون لأحداث التفعيل، يُزالون حين يُرى الصوت يعمل أو بالمُزيل', async () => {
  const listeners = new Map<string, { fn: () => void; opts: AddEventListenerOptions }>();
  const target = {
    addEventListener: (t: string, fn: () => void, opts: AddEventListenerOptions) => { listeners.set(t, { fn, opts }); },
    removeEventListener: (t: string, fn: () => void) => { if (listeners.get(t)?.fn === fn) listeners.delete(t); },
  } as unknown as EventTarget;
  const r = rig({ resume: 'run', initial: 'suspended' });
  const a = createPresenceAlarm(r.env);
  const off = installPresenceAlarmUnlock(target, a);
  assert.deepEqual([...listeners.keys()].sort(), [...PRESENCE_UNLOCK_EVENTS].sort());
  assert.ok(!listeners.has('pointerdown') && !listeners.has('touchstart'), 'لا تُحتسب لمسةً في WebKit');
  assert.ok([...listeners.values()].every((l) => l.opts.capture === true && l.opts.passive === true));
  listeners.get('pointerup')!.fn();
  assert.equal(r.ctxs[0].resumes, 1);
  await flush();
  assert.equal(a.unlocked, true);
  listeners.get('click')!.fn();
  assert.equal(listeners.size, 0, 'أُزيلت بعد أن رُئي يعمل');
  assert.doesNotThrow(off);
  const l2 = new Map<string, unknown>();
  const t2 = { addEventListener: (t: string, fn: unknown) => { l2.set(t, fn); }, removeEventListener: (t: string) => { l2.delete(t); } } as unknown as EventTarget;
  const off2 = installPresenceAlarmUnlock(t2, createPresenceAlarm(rig().env));
  off2();
  assert.equal(l2.size, 0, 'المُزيل (فكّ useEffect أو الخروج)');
  assert.doesNotThrow(() => installPresenceAlarmUnlock(null)());
});

/* ─── عامل الخدمة: اهتزاز إشعار الطلب، ورسالة الفتح بعد عرضه ───────────────── */

const SW_SRC = fs.readFileSync(path.resolve(process.cwd(), 'public', 'sw.js'), 'utf8');

function loadPush() {
  const handlers: Record<string, (e: unknown) => void> = {};
  const order: string[] = [];
  const shown: { title: string; opts: Record<string, unknown> }[] = [];
  const posted: unknown[] = [];
  let resolveShow: () => void = () => { /* */ };
  vm.runInNewContext(SW_SRC, {
    self: {
      addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; },
      skipWaiting: () => undefined,
      location: { origin: 'https://fieldsa.net' },
      registration: {
        showNotification: (title: string, opts: Record<string, unknown>) => {
          order.push('show'); shown.push({ title, opts });
          return new Promise<void>((r) => { resolveShow = () => { order.push('shown'); r(); }; });
        },
      },
      clients: {
        claim: () => undefined,
        matchAll: async () => {
          order.push('matchAll');
          return [
            { url: 'https://fieldsa.net/rep', postMessage: (m: unknown) => { order.push('post'); posted.push(JSON.parse(JSON.stringify(m))); } },
            { url: 'https://fieldsa.net/rep-app', postMessage: () => { order.push('post-download-page'); } },
          ];
        },
      },
    },
    URL,
  });
  const push = (data: Record<string, unknown>) => {
    let waited: Promise<unknown> | null = null;
    handlers.push({ data: { json: () => data, text: () => '' }, waitUntil: (p: Promise<unknown>) => { waited = p; } });
    return () => waited;
  };
  return { push, order, shown, posted, resolve: () => resolveShow() };
}

test('عامل الخدمة: اهتزازٌ صريح لإشعار «أثبت تواجدك» وحده، بلا silent — ورسالة الفتح بعد عرضه لا قبله', async () => {
  const sw = loadPush();
  const waited = sw.push({ title: 'أثبت تواجدك', body: 'x', url: '/rep?screen=presence', tag: 'presence', checkId: 'c1' });
  const o = sw.shown[0].opts;
  assert.ok(Array.isArray(o.vibrate));
  const pattern = [...(o.vibrate as number[])];
  assert.ok(pattern.length > 0 && pattern.length <= 99 && pattern.every((v) => v > 0 && v <= 10_000));
  assert.equal(o.silent, undefined, 'silent مع vibrate يرمي TypeError');
  assert.equal(o.renotify, true);
  assert.equal(o.requireInteraction, true);
  assert.equal(o.tag, 'presence', 'renotify يلزمه وسم');
  await flush();
  assert.deepEqual(sw.order, ['show'], 'لا رسالة قبل وجود الإشعار: لمسة المندوب في النافذة تجده لتغلقه');
  sw.resolve();
  await flush(); await flush();
  assert.deepEqual(sw.order, ['show', 'shown', 'matchAll', 'post']);
  assert.deepEqual(sw.posted, [{ type: 'OPEN_SCREEN', screen: 'presence' }]);
  assert.ok(waited(), 'waitUntil');

  const att = loadPush();
  att.push({ title: 'الحضور', body: 'x', url: '/rep?screen=attendance', tag: 'att-in' });
  assert.equal(att.shown[0].opts.vibrate, undefined, 'تنبيهات الحضور كما كانت');
  assert.equal(att.shown[0].opts.renotify, false);
  att.resolve();
  await flush(); await flush();
  assert.deepEqual(att.order, ['show', 'shown'], 'لا رسالة فتحٍ لغير الطلب');
});

test('عامل الخدمة: عرضٌ فاشل لا يحجب رسالة الفتح', async () => {
  const handlers: Record<string, (e: unknown) => void> = {};
  const posted: unknown[] = [];
  vm.runInNewContext(SW_SRC, {
    self: {
      addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; },
      skipWaiting: () => undefined,
      location: { origin: 'https://fieldsa.net' },
      registration: { showNotification: () => Promise.reject(new Error('TypeError')) },
      clients: { claim: () => undefined, matchAll: async () => [{ url: 'https://fieldsa.net/rep', postMessage: (m: unknown) => posted.push(m) }] },
    },
    URL,
  });
  let waited: Promise<unknown> | null = null;
  handlers.push({ data: { json: () => ({ tag: 'presence', checkId: 'c1' }), text: () => '' }, waitUntil: (p: Promise<unknown>) => { waited = p; } });
  await (waited as unknown as Promise<unknown>).catch(() => null);
  await flush();
  assert.equal(posted.length, 1);
});

/* ─── حرّاس التوصيل ─────────────────────────────────────────────────────────── */

test('حارس ثابت: النافذة تشغّل الجرس ما دامت تنتظر الضغط، والضغطة تُسكته قبل كل شيء، والتطبيق يفتح الصوت للمقيَّد وحده', () => {
  const read = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), ...p), 'utf8');
  const modal = read('src', 'rep', 'PresenceCheck.tsx');
  assert.match(modal, /const alarmOn = !result && !busy && phase !== 'expired';/, 'يسكت بالنتيجة أو بدء الردّ أو انتهاء المهلة');
  assert.match(modal, /if \(!alarmOn\) return;\n\s*startPresenceAlarm\(pending\.id\);\n\s*return \(\) => stopPresenceAlarm\(pending\.id\);\n\s*\}, \[alarmOn, pending\.id\]\);/);
  const confirmAt = modal.indexOf('const confirm = async () => {');
  const busyAt = modal.indexOf('if (busy) return;', confirmAt);
  const silenceAt = modal.indexOf('silencePresenceAlarm(pending.id);', confirmAt);
  assert.ok(confirmAt > 0 && busyAt < silenceAt && silenceAt < modal.indexOf('onAttempt();', confirmAt), 'داخل اللمسة نفسها قبل أي انتظار');
  assert.ok(silenceAt < modal.indexOf('closePresenceNotifications(pending.id);', silenceAt), 'ومعه إشعاره');
  // الإشعار يُغلق بلمسةٍ من المندوب والنافذة ظاهرة — لا بظهورها وحده: جوالٌ موضوع بشاشةٍ مضيئة يبقى إنذار أندرويد فيه يرنّ،
  // وإلّا سكت كل شيء حين تنطفئ الشاشة (المخفية لا ترنّ)
  assert.match(modal, /for \(const ev of PRESENCE_UNLOCK_EVENTS\) document\.addEventListener\(ev, seen, opts\);/);
  assert.match(modal, /for \(const ev of PRESENCE_UNLOCK_EVENTS\) document\.removeEventListener\(ev, seen, opts\);/);
  assert.match(modal, /const opts: AddEventListenerOptions = \{ capture: true, passive: true \};/);
  assert.doesNotMatch(modal, /addEventListener\('visibilitychange'/, 'لا إغلاق بالظهور');
  assert.doesNotMatch(modal, /^\s*seen\(\);\s*$/m, 'ولا عند التركيب');
  assert.doesNotMatch(modal, /OPEN_SCREEN/, 'ولا برسالة العامل');
  assert.doesNotMatch(modal, /useEffect\([^)]*confirm\(\)/, 'لا ردّ تلقائي');
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /useEffect\(\(\) => \(user\?\.requirePresenceCheck === true \? installPresenceAlarmUnlock\(\) : undefined\), \[user\?\.requirePresenceCheck\]\);/);
  const sw = read('public', 'sw.js');
  assert.match(sw, /vibrate: data\.tag === 'presence' \? PRESENCE_VIBRATE_PUSH : undefined,/);
  assert.doesNotMatch(sw, /\bsilent:/, 'silent مع vibrate يرمي');
  const mod = read('src', 'rep', 'presenceAlarm.ts');
  assert.doesNotMatch(mod, /\.close\(\)/, 'suspend لا close');
});
