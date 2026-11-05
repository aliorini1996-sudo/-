#!/usr/bin/env python3
# حارس إشعارات الآيفون (APNs، طلب المالك ٤ نوفمبر ٢٠٢٦) — مكتبة بايثون القياسية وحدها، يعمل على ويندوز وفي الوورك فلو:
#
#   python -I ci/check_push.py [جذر-المستودع]     ← يخرج 1 مع سطر «✗ …» لكل مخالفة
#   python -I ci/check_push.py --selftest          ← يتأكد أن كل مخالفةٍ معروفة تُرفض، وأن النسخة السليمة تمرّ
#
# ما يحرسه: ملف الصلاحيات (بصمته ومفتاحاه حرفياً، وملفٌّ واحد في المستودع)، والمشروع (سطرٌ واحد يذكر entitlements
# داخل إعداد Release للهدف — درس انهيار 1.0 حين صار ملف الصلاحيات مورداً — وPushBridge.swift في مرحلة المصادر، والصوت
# في مرحلة الموارد، ومعرّفاتنا معرّفةٌ مرّة، وكل معرّفٍ مذكور معرّف، والأقواس متوازنة، والإصدار 1.2.0 في الإعدادين)،
# والصوت (يُعاد توليده فيطابق بايتاً ببايت، وأقلّ من ٣٠ ثانية)، وSwift (بلا واجهات «السبب المطلوب» إذ لا Privacy
# Manifest، وبلا Firebase حيّ، وجسر fsPush بحرّاسه)، وInfo.plist، وبلا CR في الملفات النصية.
import hashlib
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import wave

ENT = "FieldSales/FieldSales.entitlements"
ENT_SHA = "8c9c508f31e3ae1d2f1b2a3b0f0105dd1c39c46970bced4d8c43b84d692a60ca"
ENT_DICT = {"aps-environment": "production", "com.apple.developer.usernotifications.time-sensitive": True}
ENT_LINE = "\t\t\t\tCODE_SIGN_ENTITLEMENTS = FieldSales/FieldSales.entitlements;"

PBX = "FieldSales.xcodeproj/project.pbxproj"
RELEASE_CFG = "CD89F89F237E9D9300C436A1"   # إعداد Release للهدف FieldSales
DEBUG_CFG = "CD89F89E237E9D9300C436A1"     # إعداد Debug للهدف FieldSales
SOURCES_PHASE = "CD89F885237E9D9200C436A1"
RESOURCES_PHASE = "CD89F887237E9D9200C436A1"
OUR_PREFIX = "FA51A0F1C0DE9B5"
BRIDGE_FILE, BRIDGE_BUILD = OUR_PREFIX + "000000011", OUR_PREFIX + "000000012"
WAV_FILE, WAV_BUILD = OUR_PREFIX + "000000021", OUR_PREFIX + "000000022"

WAV = "FieldSales/presence-alarm.wav"
WAV_SHA = "1df8a244ba78c7368bafc1a6d442b548894bb4e8127ffb0442b33e64c300efe1"
WAV_SIZE = 1234844
GEN = "ci/gen_presence_alarm.py"

INFO = "FieldSales/Info.plist"
BRIDGE = "FieldSales/PushBridge.swift"
APPDELEGATE = "FieldSales/AppDelegate.swift"
VIEWCONTROLLER = "FieldSales/ViewController.swift"
WEBVIEW = "FieldSales/WebView.swift"
OLD_PUSH = "FieldSales/PushNotifications.swift"

MARKER = "window.__fsIosPush=Object.freeze({v:1,caps:Object.freeze(['status','register','clear','ready'])});"
EVENT_BODY = "return !window.dispatchEvent(new CustomEvent('fs-ios-push', { detail: ev, cancelable: true }));"
INSTALL_LINE = "        PushBridge.shared.install(webView: FieldSales.webView)"
# ready(): عمر الحدث من دخوله الطابور؛ didRegister: رمزٌ وصل بلا منتظر بعد انتهاء مهلة تسجيل ⇒ حدث 'token'
QUEUE_AGE = "pending.filter { now - $0.queuedAt <= PushBridge.maxEventAge * 1000 }.map { $0.ev }"
LATE_TOKEN = "(ws.isEmpty && registerTimedOut)"

# كتعبير الوورك فلو حرفياً (حسّاس لحالة الأحرف): واجهات «السبب المطلوب» — لا Privacy Manifest في التطبيق (ITMS-91053)
PRIVACY_RE = re.compile(r"UserDefaults|systemUptime|mach_absolute_time|creationDate|modificationDate|ModificationDate"
                        r"|volumeAvailableCapacity|systemFreeSize|activeInputModes")
# اسم مزوّد الدفع بالبطاقة لا يُذكر أبداً — يُبنى من أجزاء كي لا يطابق هذا الملف نفسه
PROVIDER_RE = re.compile(("near" + r"\s?" + "pay").encode() + b"|" + ("نير" + r"\s?" + "باي").encode(), re.I)
PROVIDER_SCAN = ["FieldSales", "ci", "fastlane", "metadata", "README.md"]

# ملفات نصية لمسها هذا العمل: بلا CR (المستودع LF)
LF_FILES = [BRIDGE, APPDELEGATE, VIEWCONTROLLER, WEBVIEW, INFO, ENT, PBX, GEN, "ci/check_push.py", "fastlane/Fastfile",
            ".github/workflows/ios-testflight.yml", ".github/workflows/ios-push-build-check.yml",
            "metadata/push-notifications.md", "README.md"]

ID_RE = re.compile(r"\b[0-9A-F]{24}\b")
DEF_RE = re.compile(r"^\t\t([0-9A-F]{24})(?: /\*.*?\*/)? = \{")

_wav_cache = {}


def read_bytes(root, rel):
    try:
        with open(os.path.join(root, rel), "rb") as f:
            return f.read()
    except OSError:
        return None


def read_text(root, rel):
    b = read_bytes(root, rel)
    return None if b is None else b.decode("utf-8", errors="replace")


def block(lines, obj_id):
    """(أول سطر، آخر سطر) لكائنٍ متعدد الأسطر في المشروع: «\\t\\t<ID> /* … */ = {» حتى «\\t\\t};»"""
    for i, ln in enumerate(lines):
        m = DEF_RE.match(ln)
        if m and m.group(1) == obj_id and ln.rstrip().endswith("= {"):
            for j in range(i + 1, len(lines)):
                if lines[j] == "\t\t};":
                    return i, j
            return None
    return None


def balance_errors(text):
    """توازن { } و( ) خارج النصوص المقتبسة والتعليقات"""
    stack = []
    i, n = 0, len(text)
    pairs = {"}": "{", ")": "("}
    while i < n:
        c = text[i]
        if c == '"':
            i += 1
            while i < n and text[i] != '"':
                i += 2 if text[i] == "\\" else 1
            i += 1
            continue
        if text.startswith("/*", i):
            k = text.find("*/", i + 2)
            if k < 0:
                return "تعليقٌ غير مغلق"
            i = k + 2
            continue
        if text.startswith("//", i):
            k = text.find("\n", i)
            i = n if k < 0 else k
            continue
        if c in "{(":
            stack.append(c)
        elif c in "})":
            if not stack or stack[-1] != pairs[c]:
                return "قوسٌ «%s» بلا مقابل" % c
            stack.pop()
        i += 1
    return "أقواسٌ غير مغلقة: %s" % "".join(stack) if stack else None


def regenerate_wav(root):
    gen = read_bytes(root, GEN)
    if gen is None:
        return None
    key = hashlib.sha256(gen).hexdigest()
    if key not in _wav_cache:
        tmp = tempfile.mkdtemp(prefix="fs-wav-")
        try:
            out = os.path.join(tmp, "presence-alarm.wav")
            r = subprocess.run([sys.executable, "-I", os.path.join(root, GEN), out],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            _wav_cache[key] = read_bytes(tmp, "presence-alarm.wav") if r.returncode == 0 else None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return _wav_cache[key]


def check(root):
    """قائمة المخالفات: (رمزٌ قصير، رسالة عربية)"""
    bad = []

    def fail(code, msg):
        bad.append((code, msg))

    # (أ) ملف الصلاحيات: بصمةٌ ومفتاحان حرفياً، وملفٌّ واحد في المستودع
    ent = read_bytes(root, ENT)
    if ent is None:
        fail("ent.missing", "ملف الصلاحيات غير موجود: " + ENT)
    else:
        if hashlib.sha256(ent).hexdigest() != ENT_SHA:
            fail("ent.sha", "بصمة ملف الصلاحيات تغيّرت (صلاحيةٌ جديدة = قرار وتعديل هنا وفي Fastfile)")
        try:
            d = plistlib.loads(ent)
        except Exception as e:  # noqa: BLE001
            d = None
            fail("ent.plist", "ملف الصلاحيات ليس plist صالحاً: %s" % e)
        if d is not None and (not isinstance(d, dict) or d != ENT_DICT
                              or any(type(d[k]) is not type(v) for k, v in ENT_DICT.items())):
            fail("ent.keys", "مفاتيح الصلاحيات ليست aps-environment=production وtime-sensitive=true وحدهما")
    ents = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root).replace(os.sep, "/")
        dirnames[:] = [x for x in dirnames if not (rel == "." and x in ("Pods", ".git")) and x != ".git"]
        ents += [f if rel == "." else rel + "/" + f for f in filenames if f.lower().endswith(".entitlements")]
    if len(ents) != 1:
        fail("ent.count", "يجب ملف صلاحيات واحد في المستودع، والموجود: %s" % (", ".join(sorted(ents)) or "لا شيء"))

    # (ب) المشروع
    pbx = read_text(root, PBX)
    if pbx is None:
        fail("pbx.missing", "ملف المشروع غير موجود: " + PBX)
    else:
        lines = pbx.split("\n")
        err = balance_errors(pbx)
        if err:
            fail("pbx.balance", "ملف المشروع: " + err)
        rel_blk, dbg_blk = block(lines, RELEASE_CFG), block(lines, DEBUG_CFG)
        src_blk, res_blk = block(lines, SOURCES_PHASE), block(lines, RESOURCES_PHASE)
        for name, blk in (("Release", rel_blk), ("Debug", dbg_blk), ("Sources", src_blk), ("Resources", res_blk)):
            if blk is None:
                fail("pbx.block", "لم يُعثر على كتلة %s في المشروع" % name)
        if rel_blk and not any("name = Release;" == ln.strip() for ln in lines[rel_blk[0]:rel_blk[1]]):
            fail("pbx.block", "الكتلة %s ليست إعداد Release" % RELEASE_CFG)

        def inside(i, blk):
            return blk is not None and blk[0] < i < blk[1]

        ent_lines = [i for i, ln in enumerate(lines) if "entitlements" in ln.lower()]
        if len(ent_lines) != 1:
            fail("pbx.ent_lines", "كلمة entitlements في المشروع على %d سطر — المسموح سطرٌ واحد: CODE_SIGN_ENTITLEMENTS في Release"
                 % len(ent_lines))
        for i in ent_lines:
            if lines[i] != ENT_LINE or not inside(i, rel_blk):
                fail("pbx.ent_where", "سطر غير مسموح (السطر %d): %s" % (i + 1, lines[i].strip()))
        if not ent_lines:
            fail("pbx.ent_where", "لا CODE_SIGN_ENTITLEMENTS في إعداد Release (الإشعارات تحتاج الصلاحيات)")

        if "PushNotifications" in pbx:
            fail("pbx.old_push", "المشروع ما زال يذكر PushNotifications.swift")

        def expect(name, total, ids, phase_line, phase_blk, phase_name):
            hits = [i for i, ln in enumerate(lines) if name in ln]
            if len(hits) != total:
                fail("pbx.count", "%s على %d سطر (المتوقع %d)" % (name, len(hits), total))
            for i in hits:
                if not all(t in ids for t in ID_RE.findall(lines[i])):
                    fail("pbx.ids", "%s بمعرّفٍ غير متوقع (السطر %d)" % (name, i + 1))
            if sum(1 for i in hits if lines[i] == phase_line and inside(i, phase_blk)) != 1:
                fail("pbx.phase", "%s ليس في مرحلة %s مرّةً واحدة" % (name, phase_name))
            others = [i for i in hits if lines[i].startswith("\t\t\t\t") and lines[i].endswith(" */,")
                      and not inside(i, phase_blk) and ID_RE.findall(lines[i])[:1] != [ids[0]]]
            if others:
                fail("pbx.phase", "%s في مرحلة بناءٍ أخرى (السطر %d)" % (name, others[0] + 1))

        expect("PushBridge.swift", 4, [BRIDGE_FILE, BRIDGE_BUILD],
               "\t\t\t\t%s /* PushBridge.swift in Sources */," % BRIDGE_BUILD, src_blk, "Sources")
        expect("presence-alarm.wav", 4, [WAV_FILE, WAV_BUILD],
               "\t\t\t\t%s /* presence-alarm.wav in Resources */," % WAV_BUILD, res_blk, "Resources")
        if sum(1 for ln in lines if "presence-alarm.wav in Resources" in ln) != 2:
            fail("pbx.count", "«presence-alarm.wav in Resources» ليس على سطرين بالضبط (تعريف + مرحلة الموارد)")
        wav_ref = [ln for ln in lines if DEF_RE.match(ln) and DEF_RE.match(ln).group(1) == WAV_FILE]
        if len(wav_ref) != 1 or "lastKnownFileType = audio.wav;" not in wav_ref[0] \
                or 'path = "FieldSales/presence-alarm.wav";' not in wav_ref[0]:
            fail("pbx.wav_ref", "مرجع الصوت ليس audio.wav بالمسار FieldSales/presence-alarm.wav")

        defs = {}
        for ln in lines:
            m = DEF_RE.match(ln)
            if m:
                defs[m.group(1)] = defs.get(m.group(1), 0) + 1
        for i, n in defs.items():
            if n != 1:
                fail("pbx.dup", "المعرّف %s معرَّف %d مرّة" % (i, n))
        refs = {}
        for ln in lines:
            m = DEF_RE.match(ln)
            body = ln[m.end():] if m else ln
            for t in ID_RE.findall(body):
                refs[t] = refs.get(t, 0) + 1
        for t in sorted(set(refs) - set(defs)):
            fail("pbx.undefined", "المعرّف %s مذكور بلا تعريف" % t)
        for t in (BRIDGE_FILE, BRIDGE_BUILD, WAV_FILE, WAV_BUILD):
            if defs.get(t) != 1:
                fail("pbx.ours", "معرّفنا %s غير معرَّف" % t)
            if not refs.get(t):
                fail("pbx.ours", "معرّفنا %s معرَّف لكن لا يشير إليه شيء" % t)
        ours = sorted({t for t in ID_RE.findall(pbx) if t.startswith(OUR_PREFIX)})
        for t in ours:
            if defs.get(t) != 1:
                fail("pbx.ours", "معرّفٌ ببادئتنا %s غير معرَّف مرّةً واحدة" % t)

        mv_all = len(re.findall(r"MARKETING_VERSION = ", pbx))
        mv_ok = pbx.count("MARKETING_VERSION = 1.2.0;")
        if not (mv_all == mv_ok == 2):
            fail("pbx.version", "MARKETING_VERSION يجب 1.2.0 في الإعدادين (الموجود %d من %d)" % (mv_ok, mv_all))

    # (ج) الصوت: يُعاد توليده فيطابق بايتاً ببايت، وبمواصفات آبل
    wav = read_bytes(root, WAV)
    if wav is None:
        fail("wav.missing", "الصوت غير موجود: " + WAV)
    else:
        if len(wav) != WAV_SIZE or hashlib.sha256(wav).hexdigest() != WAV_SHA:
            fail("wav.sha", "بصمة الصوت أو حجمه تغيّر (المتوقع %d بايت)" % WAV_SIZE)
        regen = regenerate_wav(root)
        if regen is None:
            fail("wav.regen", "تعذّر توليد الصوت من " + GEN)
        elif regen != wav:
            fail("wav.regen", "الصوت المحفوظ لا يطابق ما يولّده " + GEN)
        try:
            w = wave.open(os.path.join(root, WAV), "rb")
            try:
                ch, sw, rate, frames, comp = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes(), w.getcomptype()
            finally:
                w.close()
            dur = frames / float(rate) if rate else 0
            if ch != 1 or sw != 2 or rate != 22050 or comp != "NONE" or not (0 < dur < 30):
                fail("wav.params", "الصوت ليس PCM 16-bit أحادياً 22050 هرتز أقلّ من ٣٠ ثانية (%d قناة، %d بايت، %d هرتز، %.2f ث)"
                     % (ch, sw, rate, dur))
        except Exception as e:  # noqa: BLE001
            fail("wav.params", "الصوت ليس WAV صالحاً: %s" % e)

    # (د) Swift
    swift = {}
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, "FieldSales")):
        for f in filenames:
            if f.endswith(".swift"):
                p = os.path.join(dirpath, f)
                swift[os.path.relpath(p, root).replace(os.sep, "/")] = read_text(root, os.path.relpath(p, root))
    for rel, txt in sorted(swift.items()):
        for n, ln in enumerate(txt.split("\n"), 1):
            if PRIVACY_RE.search(ln):
                fail("swift.privacy", "واجهة «سبب مطلوب» (تحتاج Privacy Manifest) في %s:%d" % (rel, n))
            if re.match(r"\s*import\s+Firebase", ln):
                fail("swift.firebase", "import Firebase في %s:%d" % (rel, n))
            k = ln.find("FirebaseApp.configure()")
            if k >= 0 and "//" not in ln[:k]:
                fail("swift.firebase", "FirebaseApp.configure() حيّ في %s:%d" % (rel, n))
    for target in PROVIDER_SCAN:
        base = os.path.join(root, target)
        paths = [base] if os.path.isfile(base) else [os.path.join(d, f) for d, _, fs in os.walk(base) for f in fs]
        for p in paths:
            b = read_bytes(root, os.path.relpath(p, root))
            if b is not None and PROVIDER_RE.search(b):
                fail("text.provider", "اسم مزوّد الدفع في %s" % os.path.relpath(p, root).replace(os.sep, "/"))
    if os.path.exists(os.path.join(root, OLD_PUSH)):
        fail("swift.old_push", OLD_PUSH + " ما زال موجوداً")
    wv = swift.get(WEBVIEW)
    if wv is None or '"push-' in wv:
        fail("swift.webview", "WebView.swift مفقود أو ما زال يسجّل معالجات push-…")
    br = swift.get(BRIDGE)
    if br is None:
        fail("swift.bridge", "PushBridge.swift غير موجود")
    else:
        for need in ('"fsPush"', "__fsIosPush", "fs-ios-push", "contentWorld: .page", 'origin.host == "fieldsa.net"',
                     "isMainFrame", "PrintReply(", MARKER, EVENT_BODY, "message.webView === own",
                     'reply.reject("forbidden")', 'reply.reject("bad_request")'):
            if need not in br:
                fail("swift.bridge", "PushBridge.swift بلا: " + need)
        # الطابور يُعمَّر من دخوله لا من وقت التسليم (لمسةٌ متأخرة أقلعت التطبيق)، والرمز المتأخر بعد مهلة التسجيل يُبلَّغ
        for need in (QUEUE_AGE, "pending.append((ev: ev, queuedAt: PushBridge.nowMs()))",
                     LATE_TOKEN, "self.registerTimedOut = true", "registerTimedOut = false"):
            if need not in br:
                fail("swift.queue", "PushBridge.swift بلا: " + need)
        if re.search(r'ev\["at"\]', br):
            fail("swift.queue", "PushBridge.swift يقرأ ev[\"at\"] — عمر الطابور من queuedAt لا من وقت التسليم")
        for banned, why in ((r"@MainActor", "@MainActor"), (r"\bnonisolated\b", "nonisolated"), (r"\bawait\b", "await"),
                            (r"\bTask\s*[{.(]", "Task")):
            if re.search(banned, br):
                fail("swift.bridge", "PushBridge.swift فيه %s (نمط PrintBridge: إكمالات + DispatchQueue.main)" % why)
    vc = swift.get(VIEWCONTROLLER)
    if vc is None:
        fail("swift.vc", "ViewController.swift غير موجود")
    else:
        vl = vc.split("\n")
        inst = [i for i, ln in enumerate(vl) if ln == INSTALL_LINE]
        prt = [i for i, ln in enumerate(vl) if "// fsPrint bridge" in ln]
        if len(inst) != 1 or len(prt) != 1 or inst[0] > prt[0]:
            fail("swift.vc", "سطر PushBridge.shared.install ليس مرّةً واحدة قبل تعليق «// fsPrint bridge» في ViewController")
        if "push-subscribe" in vc or "handleFCMToken" in vc:
            fail("swift.vc", "ViewController ما زال يعالج رسائل push-… القديمة")
    ad = swift.get(APPDELEGATE)
    if ad is None:
        fail("swift.appdelegate", "AppDelegate.swift غير موجود")
    else:
        for need in ("UNUserNotificationCenter.current().delegate = self", "PushBridge.shared.appDidFinishLaunching()",
                     "PushBridge.shared.didRegister(deviceToken: deviceToken)", "PushBridge.shared.didFailToRegister(error: error)",
                     "PushBridge.shared.received(notification)", "completionHandler([.banner, .list, .sound])",
                     "UNNotificationDefaultActionIdentifier", "PushBridge.shared.opened(response.notification)"):
            if need not in ad:
                fail("swift.appdelegate", "AppDelegate.swift بلا: " + need)

    # (هـ) Info.plist
    info = read_bytes(root, INFO)
    try:
        pl = plistlib.loads(info) if info is not None else None
    except Exception as e:  # noqa: BLE001
        pl = None
        fail("info.plist", "Info.plist ليس plist صالحاً: %s" % e)
    if pl is None:
        if info is None:
            fail("info.plist", "Info.plist غير موجود")
    else:
        if pl.get("FirebaseAppDelegateProxyEnabled") is not False:
            fail("info.firebase", "FirebaseAppDelegateProxyEnabled ليس false في Info.plist")
        modes = pl.get("UIBackgroundModes") or []
        if "remote-notification" in modes:
            fail("info.modes", "UIBackgroundModes فيه remote-notification (لا إشعارات صامتة في هذا الإصدار)")
        if any("bluetooth" in str(m).lower() for m in modes):
            fail("info.modes", "UIBackgroundModes فيه وضع بلوتوث")

    # (و) بلا CR
    for rel in LF_FILES:
        b = read_bytes(root, rel)
        if b is not None and b"\r" in b:
            fail("text.cr", "محرف CR في " + rel + " (المستودع LF)")
    return bad


# ---------------------------------------------------------------------------------------------------------------------
# --selftest: كل مخالفةٍ معروفة تُرفض بحارسها، والنسخة السليمة تمرّ

def _edit(root, rel, fn):
    p = os.path.join(root, rel)
    with open(p, "rb") as f:
        s = f.read().decode("utf-8")
    s2 = fn(s)
    if s2 == s:
        raise AssertionError("التعديل لم يغيّر " + rel)
    with open(p, "wb") as f:
        f.write(s2.encode("utf-8"))


def _move_wav_to_sources(s):
    line = "\t\t\t\t%s /* presence-alarm.wav in Resources */,\n" % WAV_BUILD
    anchor = "\t\t\t\t%s /* PushBridge.swift in Sources */,\n" % BRIDGE_BUILD
    assert s.count(line) == 1 and s.count(anchor) == 1
    return s.replace(line, "").replace(anchor, anchor + line)


def _debug_entitlements(s):
    lines = s.split("\n")
    i, j = block(lines, DEBUG_CFG)
    k = next(n for n in range(i, j) if lines[n] == "\t\t\t\tCLANG_ENABLE_MODULES = NO;")
    lines.insert(k + 1, ENT_LINE)
    return "\n".join(lines)


def _first_version(s):
    return s.replace("MARKETING_VERSION = 1.2.0;", "MARKETING_VERSION = 1.3.0;", 1)


MUTATIONS = [
    ("صلاحيةٌ زائدة في ملف الصلاحيات", ENT,
     lambda s: s.replace("</dict>", "\t<key>com.apple.developer.associated-domains</key>\n\t<array/>\n</dict>"),
     {"ent.sha", "ent.keys"}),
    ("CODE_SIGN_ENTITLEMENTS في Debug أيضاً", PBX, _debug_entitlements, {"pbx.ent_lines", "pbx.ent_where"}),
    ("ملف الصلاحيات مرجعٌ في المشروع (PBXFileReference)", PBX,
     lambda s: s.replace("\t\t%s /* PushBridge.swift */ = {" % BRIDGE_FILE,
                         "\t\t%s031 /* FieldSales.entitlements */ = {isa = PBXFileReference; lastKnownFileType = text.plist.entitlements; "
                         "path = FieldSales/FieldSales.entitlements; sourceTree = \"<group>\"; };\n\t\t%s /* PushBridge.swift */ = {"
                         % (OUR_PREFIX + "000000", BRIDGE_FILE), 1),
     {"pbx.ent_lines", "pbx.ent_where"}),
    ("الصوت خارج مرحلة الموارد", PBX, _move_wav_to_sources, {"pbx.phase"}),
    ("كلمة UserDefaults في تعليق Swift", BRIDGE, lambda s: s + "// UserDefaults\n", {"swift.privacy"}),
    ("اسم مزوّد الدفع في metadata", "metadata/push-notifications.md",
     lambda s: s + "\n" + "Near" + "Pay\n", {"text.provider"}),
    ("MARKETING_VERSION 1.3.0 في إعدادٍ واحد", PBX, _first_version, {"pbx.version"}),
    ("بايتٌ واحد تغيّر في الصوت", None, None, {"wav.sha", "wav.regen"}),
    ("remote-notification في UIBackgroundModes", INFO,
     lambda s: s.replace("<string>processing</string>", "<string>processing</string>\n\t\t<string>remote-notification</string>", 1),
     {"info.modes"}),
    ("ready() يعمّر الطابور بوقت التسليم (at)", BRIDGE,
     lambda s: s.replace(QUEUE_AGE, "pending.filter { now - ($0.ev[\"at\"] as? Double ?? 0) <= PushBridge.maxEventAge * 1000 }"
                         ".map { $0.ev }", 1), {"swift.queue"}),
    ("الرمز المتأخر بعد المهلة بلا حدث", BRIDGE, lambda s: s.replace(" || " + LATE_TOKEN, "", 1), {"swift.queue"}),
    ("@MainActor في PushBridge.swift", BRIDGE,
     lambda s: s.replace("final class PushBridge:", "@MainActor\nfinal class PushBridge:", 1), {"swift.bridge"}),
    ("تركيب الجسر بعد fsPrint", VIEWCONTROLLER,
     lambda s: s.replace(INSTALL_LINE + "\n", "", 1).replace(
         "PrintBridge.shared.install(webView: FieldSales.webView, presenter: self)\n",
         "PrintBridge.shared.install(webView: FieldSales.webView, presenter: self)\n" + INSTALL_LINE + "\n", 1),
     {"swift.vc"}),
    ("import FirebaseMessaging في AppDelegate", APPDELEGATE, lambda s: "import FirebaseMessaging\n" + s, {"swift.firebase"}),
    ("CRLF في PushBridge.swift", BRIDGE, lambda s: s.replace("\n", "\r\n", 3), {"text.cr"}),
    ("معرّفٌ بلا تعريف في مرحلة المصادر", PBX,
     lambda s: s.replace("\t\t\t\t%s /* PushBridge.swift in Sources */,\n" % BRIDGE_BUILD,
                         "\t\t\t\t%s /* PushBridge.swift in Sources */,\n\t\t\t\t%s099 /* Ghost.swift in Sources */,\n"
                         % (BRIDGE_BUILD, OUR_PREFIX + "000000"), 1),
     {"pbx.undefined", "pbx.ours"}),
    ("قوسٌ ناقص في المشروع", PBX, lambda s: s.replace("\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;", "\t\t\trunOnlyForDeploymentPostprocessing = 0;", 1),
     {"pbx.balance"}),
]


def copy_repo(src, dst):
    for rel in ("FieldSales", "ci", "fastlane", "metadata", ".github"):
        if os.path.isdir(os.path.join(src, rel)):
            shutil.copytree(os.path.join(src, rel), os.path.join(dst, rel),
                            ignore=shutil.ignore_patterns("Pods", ".git", "build", "DerivedData"))
    os.makedirs(os.path.join(dst, "FieldSales.xcodeproj"), exist_ok=True)
    shutil.copy2(os.path.join(src, PBX), os.path.join(dst, PBX))
    if os.path.isfile(os.path.join(src, "README.md")):
        shutil.copy2(os.path.join(src, "README.md"), os.path.join(dst, "README.md"))


def selftest(src):
    problems = []
    base = check(src)
    if base:
        problems.append("المستودع نفسه لا يمرّ (%d مخالفة) — أصلحه قبل الفحص الذاتي" % len(base))
    for title, rel, fn, expected in MUTATIONS:
        tmp = tempfile.mkdtemp(prefix="fs-push-selftest-")
        try:
            copy_repo(src, tmp)
            if rel is None:
                p = os.path.join(tmp, WAV)
                with open(p, "r+b") as f:
                    f.seek(5000)
                    b = f.read(1)
                    f.seek(5000)
                    f.write(bytes([b[0] ^ 0x01]))
            else:
                _edit(tmp, rel, fn)
            codes = {c for c, _ in check(tmp)}
            if not codes:
                problems.append("لم تُرفض المخالفة: " + title)
            elif not (codes & expected):
                problems.append("رُفضت «%s» لكن بغير حارسها المتوقع (%s ← %s)" % (title, ", ".join(sorted(expected)),
                                                                                  ", ".join(sorted(codes))))
            else:
                print("✓ تُرفض: " + title)
        except Exception as e:  # noqa: BLE001
            problems.append("تعذّر تطبيق «%s»: %r" % (title, e))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    tmp = tempfile.mkdtemp(prefix="fs-push-selftest-")
    try:
        copy_repo(src, tmp)
        clean = check(tmp)
        if clean:
            problems.append("النسخة السليمة لا تمرّ: " + "؛ ".join(m for _, m in clean))
        else:
            print("✓ النسخة السليمة تمرّ")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    for p in problems:
        print("✗ " + p)
    return 1 if problems else 0


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    args = [a for a in argv if a != "--selftest"]
    root = os.path.abspath(args[0]) if args else os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    if "--selftest" in argv:
        rc = selftest(root)
        print("✓ الفحص الذاتي لحارس الإشعارات ناجح" if rc == 0 else "✗ الفحص الذاتي لحارس الإشعارات فشل")
        return rc
    bad = check(root)
    for _, msg in bad:
        print("✗ " + msg)
    if bad:
        print("✗ حارس إشعارات الآيفون: %d مخالفة" % len(bad))
        return 1
    print("✓ حارس إشعارات الآيفون: الصلاحيات والمشروع والصوت وSwift وInfo.plist سليمة")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
