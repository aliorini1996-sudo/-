import UIKit
import WebKit
import UserNotifications

/// «أثبت تواجدك» وتنبيهات الحضور على الآيفون (طلب المالك، ٤ نوفمبر ٢٠٢٦): إشعارات APNs أصلية بلا Firebase.
/// نظير Web Push في أندرويد والويب (backend/src/services/webPush.ts): الخادم يرسل إلى APNs برمز هذا الجهاز، والصفحة
/// (داخل WKWebView التطبيق) تطلب الإذن وتأخذ الرمز من هنا ثمّ تحفظه في الخادم بجلسة المندوب — التطبيق لا يكلّم الخادم.
///
/// `window.webkit.messageHandlers.fsPush.postMessage(msg)` → Promise. الإطار الرئيسي لـhttps://fieldsa.net وحده
/// (كـfsPrint في PrintBridge.swift)، وأيّ أصلٍ آخر يُرفض «forbidden» وطلبٌ فاسد «bad_request». كل طلبٍ يُجاب مرّةً واحدة (PrintReply).
///   {op:'status'}                 ⇒ {ok:true, v:1, perm, token|null, env, error|null}   (بلا طلب إذن أبداً)
///   {op:'register'}               ⇒ {ok:true, perm:'granted', token, env}
///                                   | {ok:false, code:'denied'|'unavailable'(detail:'apns_<code>')|'timeout', perm}
///   {op:'clear', tag, checkId?}   ⇒ {ok:true, removed}   (إشعارات الوسم المعروضة: طلبه وحده أو ما لا معرّف له)
///   {op:'clear', all:true}        ⇒ {ok:true, removed}   (عند تسجيل الخروج: كل الدرج ويُفرَّغ الطابور)
///   {op:'ready'}                  ⇒ {ok:true, events:[…]} (ما انتظر الصفحة: إقلاعٌ بلمسة إشعار قبل تحميلها؛ ≤ ١٥ دقيقة في الطابور)
/// perm: 'granted'|'denied'|'default' (كـNotification.permission). env: 'production'|'sandbox' من ملف التعريف المضمَّن.
/// والأحداث الحيّة: CustomEvent 'fs-ios-push' قابلٌ للإلغاء، detail = {v:1, kind:'receive'|'open'|'token', id, tag, checkId, url, at}.
/// الصفحة تستدعي preventDefault() إقراراً بالاستلام، وإلّا يبقى الحدث في الطابور حتى 'ready'. لذا: المستمع أولاً ثمّ 'ready'.
///
/// كلّه على الخيط الرئيسي كـPrintBridge: AppDelegate وViewController وWebKit هناك، وإكمالات UserNotifications (قد تأتي على
/// خيطٍ خلفيّ) لا تلمس الحالة ولا ردّ WebKit إلا بعد DispatchQueue.main.async.
final class PushBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = PushBridge()

    static let handlerName = "fsPush"
    static let version = 1
    static let markerSource =
        "window.__fsIosPush=Object.freeze({v:1,caps:Object.freeze(['status','register','clear','ready'])});"
    /// true ⇐ مستمعٌ في الصفحة أقرّ بالحدث (preventDefault)
    static let eventBody =
        "return !window.dispatchEvent(new CustomEvent('fs-ios-push', { detail: ev, cancelable: true }));"

    /// مهلة «أثبت تواجدك» في الخادم ربع ساعة (PRESENCE_LATE_MS): حدثٌ بقي في الطابور أطول لا يُسلَّم للصفحة. العمر من دخوله
    /// الطابور لا من وقت تسليم الإشعار (at): لمسةٌ على «نسيت الانصراف» بعد نصف ساعة تُقلع التطبيق فتفتح شاشتها كأندرويد
    static let maxEventAge: TimeInterval = 15 * 60
    static let maxPending = 10
    static let maxDelivered = 50
    /// انتظار الرمز من APNs بعد registerForRemoteNotifications
    static let registerTimeout: TimeInterval = 20

    weak var webView: WKWebView?
    private weak var installedController: WKUserContentController?

    /// آخر رمزٍ من APNs في هذا التشغيل — في الذاكرة وحدها (آبل: لا يُخزَّن الرمز محلياً، ويُطلب عند كل إقلاع)
    private var tokenHex: String?
    /// آخر فشل تسجيل (apns_<NSError.code>) في هذا التشغيل
    private var lastError: String?
    private var waiters: [(id: Int, reply: PrintReply)] = []
    private var nextWaiter = 0
    /// انتهت مهلة تسجيلٍ طلبته الصفحة قبل وصول الرمز: الرمز المتأخر يُبلَّغ بحدث 'token' فتحفظه الصفحة في الخادم
    private var registerTimedOut = false
    /// أحداثٌ لم تُقِرّ بها صفحة، بوقت دخولها الطابور (ms) — في الذاكرة وحدها (لا مخزن user-defaults: واجهة «سبب مطلوب» بلا Privacy Manifest)
    private var pending: [(ev: [String: Any], queuedAt: Double)] = []
    /// معرّفات أحداثٍ سُلِّمت (لا تُسلَّم مرّتين)
    private var delivered: [String] = []

    // MARK: - التركيب والإقلاع

    /// يسجّل المعالج وعلامة الجسر على ويب فيو التطبيق (مرّةً من ViewController، قبل PrintBridge)
    func install(webView: WKWebView) {
        self.webView = webView
        let ucc = webView.configuration.userContentController
        guard installedController !== ucc else { return }   // إضافةٌ ثانية بالاسم نفسه ترمي استثناءً
        installedController = ucc
        ucc.addUserScript(WKUserScript(source: PushBridge.markerSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: PushBridge.handlerName)
    }

    /// من didFinishLaunching: من سبق أن أذن يُسجَّل عند كل إقلاع (آبل: الرمز قد يتغيّر)، ومن لم يأذن لا يُسأل هنا أبداً
    func appDidFinishLaunching() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let auth = settings.authorizationStatus
            DispatchQueue.main.async {
                if PushBridge.permString(auth) == "granted" {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
    }

    // MARK: - من AppDelegate (الخيط الرئيسي)

    func didRegister(deviceToken: Data) {
        let hex = PushBridge.hex(deviceToken)
        let ws = waiters
        waiters.removeAll()
        // الصفحة تعيد حفظه في الخادم بصمت: رمزٌ تبدّل أثناء التشغيل (لا أوّل رمز)، أو رمزٌ وصل بعد انتهاء مهلة تسجيلٍ
        // طلبته الصفحة ولا منتظر له الآن (شبكةٌ بطيئة عند أول تفعيل: الصفحة قالت «تعذّر» والرمز لم يبلغ الخادم)
        let changed = (tokenHex != nil && tokenHex != hex) || (ws.isEmpty && registerTimedOut)
        tokenHex = hex
        lastError = nil
        registerTimedOut = false
        for w in ws {
            w.reply.ok(["ok": true, "perm": "granted", "token": hex, "env": PushBridge.apsEnvironment])
        }
        if changed {
            let now = PushBridge.nowMs()
            deliver([
                "v": PushBridge.version,
                "kind": "token",
                "id": "token:\(Int64(now))",
                "tag": NSNull(),
                "checkId": NSNull(),
                "url": NSNull(),
                "at": now,
            ])
        }
    }

    func didFailToRegister(error: Error) {
        let code = "apns_\((error as NSError).code)"   // 3000: لا aps-environment في التوقيع، 3010: المحاكي
        lastError = code
        let ws = waiters
        waiters.removeAll()
        for w in ws {
            w.reply.ok(["ok": false, "code": "unavailable", "perm": "granted", "detail": code])
        }
    }

    /// إشعارٌ وصل والتطبيق في الواجهة (willPresent)
    func received(_ n: UNNotification) {
        guard let ev = PushBridge.event(kind: "receive", n) else { return }
        if Thread.isMainThread {
            deliver(ev)
        } else {
            DispatchQueue.main.async { self.deliver(ev) }
        }
    }

    /// لمس المندوب الإشعار (didReceive، الفعل الافتراضي) — وقد يكون هذا ما أقلع التطبيق قبل وجود الويب فيو
    func opened(_ n: UNNotification) {
        guard let ev = PushBridge.event(kind: "open", n) else { return }
        if Thread.isMainThread {
            deliver(ev)
        } else {
            DispatchQueue.main.async { self.deliver(ev) }
        }
    }

    // MARK: - fsPush

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let reply = PrintReply(replyHandler)
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        guard frame.isMainFrame, origin.protocol == "https", origin.host == "fieldsa.net",
              origin.port == 0 || origin.port == 443,
              let own = webView, message.webView === own else {
            reply.reject("forbidden")
            return
        }
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            reply.reject("bad_request")
            return
        }
        switch op {
        case "status":
            status(reply)
        case "register":
            register(reply)
        case "clear":
            clear(body, reply)
        case "ready":
            ready(reply)
        default:
            reply.reject("bad_request")
        }
    }

    private func status(_ reply: PrintReply) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let auth = settings.authorizationStatus
            DispatchQueue.main.async {
                reply.ok([
                    "ok": true,
                    "v": PushBridge.version,
                    "perm": PushBridge.permString(auth),
                    "token": (self.tokenHex as Any?) ?? NSNull(),
                    "env": PushBridge.apsEnvironment,
                    "error": (self.lastError as Any?) ?? NSNull(),
                ])
            }
        }
    }

    /// من نقرة المندوب في الصفحة: الإذن (أوّل مرّة فقط) ثمّ التسجيل في APNs وانتظار الرمز بمهلة
    private func register(_ reply: PrintReply) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let auth = settings.authorizationStatus
            DispatchQueue.main.async {
                switch auth {
                case .denied:
                    reply.ok(["ok": false, "code": "denied", "perm": "denied"])
                case .notDetermined:
                    // بلا .badge: لا عدّاد على الأيقونة؛ وبلا .criticalAlert: يحتاج موافقة آبل، والتواجد ليس منها؛ وبلا provisional
                    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
                        DispatchQueue.main.async {
                            if granted {
                                self.awaitToken(reply)
                            } else {
                                reply.ok(["ok": false, "code": "denied", "perm": "denied"])
                            }
                        }
                    }
                default:
                    self.awaitToken(reply)
                }
            }
        }
    }

    private func awaitToken(_ reply: PrintReply) {
        nextWaiter += 1
        let id = nextWaiter
        waiters.append((id: id, reply: reply))
        UIApplication.shared.registerForRemoteNotifications()   // الرمز نفسه يعود سريعاً إن لم يتغيّر
        DispatchQueue.main.asyncAfter(deadline: .now() + PushBridge.registerTimeout) { [weak self] in
            guard let self = self, let i = self.waiters.firstIndex(where: { $0.id == id }) else { return }
            let w = self.waiters.remove(at: i)
            self.registerTimedOut = true
            w.reply.ok(["ok": false, "code": "timeout", "perm": "granted"])
        }
    }

    private func clear(_ body: [String: Any], _ reply: PrintReply) {
        let all = (body["all"] as? Bool) == true
        var wantTag: String?
        var wantCheck: String?
        if !all {
            guard let t = body["tag"] as? String, PushBridge.validKey(t) else {
                reply.reject("bad_request")
                return
            }
            wantTag = t
            if let raw = body["checkId"], !(raw is NSNull) {
                guard let c = raw as? String, PushBridge.validKey(c) else {
                    reply.reject("bad_request")
                    return
                }
                wantCheck = c
            }
        }
        let tag = wantTag
        let checkId = wantCheck
        UNUserNotificationCenter.current().getDeliveredNotifications { list in
            var ids: [String] = []
            for n in list {
                if !all {
                    let info = n.request.content.userInfo
                    guard let t = tag, (info["tag"] as? String) == t else { continue }
                    // كإغلاق الويب (PresenceCheck.tsx): إشعار طلبه، أو إشعارٌ بلا معرّف — لا إشعار طلبٍ أحدث
                    if let want = checkId, let have = info["checkId"] as? String, !have.isEmpty, have != want { continue }
                }
                ids.append(n.request.identifier)
            }
            if !ids.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            }
            let removed = ids.count
            DispatchQueue.main.async {
                if all { self.pending.removeAll() }
                reply.ok(["ok": true, "removed": removed])
            }
        }
    }

    private func ready(_ reply: PrintReply) {
        let now = PushBridge.nowMs()
        // بوقت دخول الطابور لا بـat (وقت تسليم الإشعار): لمسةٌ متأخرة أقلعت التطبيق تبقى صالحة؛ و'receive' يدخله لحظة تسليمه
        let fresh: [[String: Any]] = pending.filter { now - $0.queuedAt <= PushBridge.maxEventAge * 1000 }.map { $0.ev }
        pending.removeAll()
        for ev in fresh {
            if let id = ev["id"] as? String { markDelivered(id) }
        }
        reply.ok(["ok": true, "events": fresh])
    }

    // MARK: - تسليم الأحداث

    /// للصفحة الآن إن كانت صفحتنا وأقرّ مستمعها، وإلّا إلى الطابور (تأخذه الصفحة بـ'ready')
    private func deliver(_ ev: [String: Any]) {
        guard let id = ev["id"] as? String, !delivered.contains(id) else { return }
        guard let wv = webView, PushBridge.isOwnPage(wv.url) else {
            enqueue(ev)
            return
        }
        wv.callAsyncJavaScript(PushBridge.eventBody, arguments: ["ev": ev], in: nil, in: .page) { [weak self] result in
            guard let self = self else { return }
            if case .success(let v) = result, (v as? Bool) == true {
                self.markDelivered(id)
            } else {
                self.enqueue(ev)   // لا مستمع بعد (صفحةٌ تُحمَّل، أو ويبٌ قديم بلا هذا الجسر)
            }
        }
    }

    private func enqueue(_ ev: [String: Any]) {
        guard let id = ev["id"] as? String, !delivered.contains(id),
              !pending.contains(where: { ($0.ev["id"] as? String) == id }) else { return }
        pending.append((ev: ev, queuedAt: PushBridge.nowMs()))
        if pending.count > PushBridge.maxPending { pending.removeFirst(pending.count - PushBridge.maxPending) }
    }

    private func markDelivered(_ id: String) {
        delivered.append(id)
        if delivered.count > PushBridge.maxDelivered { delivered.removeFirst(delivered.count - PushBridge.maxDelivered) }
    }

    // MARK: - أدوات نقيّة

    static func nowMs() -> Double {
        return Date().timeIntervalSince1970 * 1000
    }

    /// حدث 'receive' أو 'open' من إشعارٍ يحمل وسماً صالحاً — وإلّا nil (ليس من تنبيهاتنا: يعرضه iOS بلا حدث)
    static func event(kind: String, _ n: UNNotification) -> [String: Any]? {
        let info = n.request.content.userInfo
        guard let tag = info["tag"] as? String, validKey(tag) else { return nil }
        var checkId: Any = NSNull()
        if let c = info["checkId"] as? String, validKey(c) { checkId = c }
        // المعرّف قد يتكرّر بين طلبين (apns-collapse-id = الوسم): وقت التسليم يميّزهما، ويجمع willPresent وdidReceive للإشعار نفسه
        let at = n.date.timeIntervalSince1970 * 1000
        let id = "\(kind):\(n.request.identifier):\(Int64(at))"
        return [
            "v": version,
            "kind": kind,
            "id": String(id.prefix(128)),
            "tag": tag,
            "checkId": checkId,
            "url": pagePath(info["url"]),
            "at": at,
        ]
    }

    /// رابطٌ داخل التطبيق وحده (كـsw.js): أصل https://fieldsa.net ومسار ‎/rep‎ أو تحته — لا ‎/rep-app‎ ولا «‎//مضيفٌ آخر‎».
    /// الناتج: المسار (+ ?الاستعلام)، وأي شيءٍ آخر ‎/rep‎. التطبيق لا ينتقل إليه بنفسه أبداً: الصفحة تقرأ منه screen
    static func pagePath(_ raw: Any?) -> String {
        guard let s = raw as? String, s.utf16.count <= 512,
              let u = URL(string: s, relativeTo: rootUrl)?.absoluteURL,
              let c = URLComponents(url: u, resolvingAgainstBaseURL: false),
              c.scheme == "https", c.host == "fieldsa.net", c.port == nil || c.port == 443,
              c.user == nil, c.password == nil else { return "/rep" }
        let p = c.percentEncodedPath
        // ‎/rep/../admin‎ أو ترميزه: المتصفح يطبّعه إلى مسارٍ خارج التطبيق — فلا نقاط ولا ترميز في المسار
        guard p == "/rep" || (p.hasPrefix("/rep/") && !p.contains("/.") && !p.contains("%")) else { return "/rep" }
        if let q = c.percentEncodedQuery, !q.isEmpty { return p + "?" + q }
        return p
    }

    static func isOwnPage(_ url: URL?) -> Bool {
        guard let u = url else { return false }
        return u.scheme == "https" && u.host == "fieldsa.net" && (u.port == nil || u.port == 443)
    }

    /// وسمٌ أو معرّف طلب: ١–٦٤ محرفاً من [A-Za-z0-9_-]
    static func validKey(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard !u.isEmpty, u.count <= 64 else { return false }
        for ch in u {
            let ok = (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A) || (ch >= 0x30 && ch <= 0x39) || ch == 0x2D || ch == 0x5F
            if !ok { return false }
        }
        return true
    }

    /// الرمز بالست عشري الصغير كما تأخذه APNs في المسار ‎/3/device/<token>‎ — وطوله متغيّر (آبل: لا يُفترض ٣٢ بايتاً)
    static func hex(_ d: Data) -> String {
        return d.map { String(format: "%02x", $0) }.joined()
    }

    /// كـNotification.permission في الويب: المؤقّت (provisional/ephemeral) إذنٌ — ونحن لا نطلبه أصلاً
    static func permString(_ s: UNAuthorizationStatus) -> String {
        switch s {
        case .authorized, .provisional, .ephemeral: return "granted"
        case .denied: return "denied"
        case .notDetermined: return "default"
        @unknown default: return "default"
        }
    }

    /// بيئة APNs من التوقيع الفعليّ لا من #if DEBUG: ملف التعريف المضمَّن (تطوير/Ad Hoc) يقول قيمته، وتثبيت App Store
    /// وTestFlight بلا embedded.mobileprovision أصلاً — وهما الإنتاج دائماً. development ⇒ 'sandbox'، وغيرها ⇒ 'production'
    static let apsEnvironment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), options: [], in: start.lowerBound..<data.endIndex),
              let plist = (try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound),
                                                                        options: [], format: nil)) as? [String: Any]
        else { return "production" }
        let env = (plist["Entitlements"] as? [String: Any])?["aps-environment"] as? String
        return env == "development" ? "sandbox" : "production"
    }()
}
