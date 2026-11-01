import UIKit
import WebKit
import CoreBluetooth
import QuartzCore

/// The rep's linked printer. `id` is CBPeripheral.identifier: local to this app on this phone, never sent
/// to the server. `service` / `characteristic` are CBUUID.uuidString (a 16-bit UUID stays 4 hex digits).
struct SavedPrinter: Codable {
    let id: UUID
    let name: String
    let service: String
    let characteristic: String
    let withResponse: Bool
}

/// Application Support/fs.print.printer.v1.json — a small file, not the user-defaults store: that store is a
/// "required reason" API that would need a privacy manifest, which this app does not have (ITMS-91053).
enum PrinterStore {
    static let fileName = "fs.print.printer.v1.json"

    private static func fileURL() -> URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return dir.appendingPathComponent(fileName, isDirectory: false)
    }

    static func load() -> SavedPrinter? {
        guard let url = fileURL(), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(SavedPrinter.self, from: data)
    }

    static func save(_ p: SavedPrinter) {
        guard let url = fileURL(), let data = try? JSONEncoder().encode(p) else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
            try data.write(to: url, options: .atomic)
        } catch {
            // Not saved: the next print asks for the printer again.
        }
    }
}

/// Calls a WKScriptMessageHandlerWithReply reply handler exactly once: WebKit raises
/// NSInternalInconsistencyException on a second call, and a handler never called leaves the page promise
/// hanging until the page goes away. If the request is dropped, deinit answers "failed".
final class PrintReply {
    private var handler: ((Any?, String?) -> Void)?

    init(_ handler: @escaping (Any?, String?) -> Void) {
        self.handler = handler
    }

    func ok(_ value: [String: Any]) {
        send(value, nil)
    }

    func fail(_ code: String, detail: String? = nil) {
        var d: [String: Any] = ["ok": false, "code": code]
        if let detail = detail { d["detail"] = detail }
        send(d, nil)
    }

    func reject(_ message: String) {
        send(nil, message)
    }

    private func send(_ value: Any?, _ error: String?) {
        guard let h = handler else { return }
        handler = nil
        h(value, error)
    }

    deinit {
        if let h = handler {
            handler = nil
            h(["ok": false, "code": "failed"], nil)
        }
    }
}

/// Keeps the app running a few seconds after it is sent to the background, so a job can end cleanly at
/// its next mark. No capability needed.
final class PrintBackgroundTask {
    private var id: UIBackgroundTaskIdentifier = .invalid

    func begin() {
        guard id == .invalid else { return }
        id = UIApplication.shared.beginBackgroundTask(withName: "fs-print") { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// `window.webkit.messageHandlers.fsPrint.postMessage(msg)` → Promise (spec C.2).
/// Accepts only the main frame of https://fieldsa.net (exact host) in this app's own web view.
/// ops: hello, pick, print, cancel, systemPrint. Every well-formed request is resolved with a dictionary;
/// only a forbidden origin or a malformed request is rejected ("forbidden" / "bad_request").
final class PrintBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = PrintBridge()

    static let caps = ["print", "pick", "cancel", "systemPrint"]
    static let markerSource =
        "window.__fsIosBridge=Object.freeze({v:1,caps:Object.freeze(['print','pick','cancel','systemPrint'])});"
    static let progressBody =
        "window.dispatchEvent(new CustomEvent('fs-ios-print', { detail: { job: job, sent: sent, total: total } }));"

    weak var webView: WKWebView?
    weak var presenter: UIViewController?
    let ble = BlePrinter()
    private weak var installedController: WKUserContentController?
    private weak var picker: PrinterPickerViewController?
    private var activeJob: String?
    private let background = PrintBackgroundTask()
    private var lastEmit: TimeInterval = 0

    /// Registers the handler and the marker script on the app's web view (called once from ViewController).
    func install(webView: WKWebView, presenter: UIViewController) {
        self.webView = webView
        self.presenter = presenter
        let ucc = webView.configuration.userContentController
        guard installedController !== ucc else { return }   // a second add with the same name would throw
        installedController = ucc
        ucc.addUserScript(WKUserScript(source: PrintBridge.markerSource, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: FSP.handlerName)
    }

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
        case "hello":
            reply.ok(helloInfo())
        case "pick":
            pick(reply)
        case "print":
            startPrint(body, reply)
        case "cancel":
            if let j = body["job"] as? String, j == activeJob { ble.requestCancel(reason: .user) }
            reply.ok(["ok": true])
        case "systemPrint":
            systemPrint(body, reply)
        default:
            reply.reject("bad_request")
        }
    }

    private var busy: Bool { return activeJob != nil || picker != nil }

    // MARK: - hello

    private func helloInfo() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let app = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        var d: [String: Any] = [:]
        d["v"] = FSP.bridgeVersion
        d["app"] = app
        d["build"] = build
        d["auth"] = PrintBridge.authString()   // class property: never creates a central, never prompts
        d["busy"] = busy
        d["caps"] = PrintBridge.caps
        if let p = PrinterStore.load() {
            d["printer"] = ["name": p.name]
        } else {
            d["printer"] = NSNull()
        }
        return d
    }

    static func authString() -> String {
        switch CBCentralManager.authorization {
        case .allowedAlways: return "allowed"
        case .notDetermined: return "notDetermined"
        case .denied: return "denied"
        case .restricted: return "restricted"
        @unknown default: return "denied"
        }
    }

    // MARK: - pick

    private func pick(_ reply: PrintReply) {
        if busy {
            reply.fail("busy")
            return
        }
        guard let base = presenter else {
            reply.fail("busy")
            return
        }
        var top: UIViewController = base
        while let next = top.presentedViewController { top = next }
        let vc = PrinterPickerViewController(ble: ble) { [weak self] result in
            self?.picker = nil
            switch result {
            case .saved(let name): reply.ok(["ok": true, "printer": ["name": name]])
            case .failed(let code): reply.fail(code)
            }
        }
        picker = vc
        let nav = UINavigationController(rootViewController: vc)
        nav.modalPresentationStyle = .pageSheet
        nav.view.semanticContentAttribute = .forceRightToLeft
        nav.navigationBar.semanticContentAttribute = .forceRightToLeft
        nav.presentationController?.delegate = vc
        top.present(nav, animated: true, completion: nil)
    }

    // MARK: - print

    static func validJobId(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard u.count >= 8, u.count <= 64 else { return false }
        for c in u {
            let ok = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
            if !ok { return false }
        }
        return true
    }

    private func startPrint(_ body: [String: Any], _ reply: PrintReply) {
        guard let job = body["job"] as? String, PrintBridge.validJobId(job), let payload = body["payload"] as? String else {
            reply.reject("bad_request")
            return
        }
        if payload.utf16.count > FSP.iosMaxPayloadChars {
            reply.fail("too_large")
            return
        }
        if busy {
            reply.fail("busy")
            return
        }
        let decoded: PrintJob
        do {
            decoded = try FSP.decode(payload, maxChars: FSP.iosMaxPayloadChars)
        } catch let e as FSPError {
            if e == .TOO_LONG {
                reply.fail("too_large")
            } else {
                reply.fail("bad_payload", detail: e.rawValue)
            }
            return
        } catch {
            reply.fail("bad_payload")
            return
        }
        if decoded.bytes.count > FSP.iosMaxJobBytes {
            reply.fail("too_large")
            return
        }
        guard let printer = PrinterStore.load() else {
            reply.fail("no_printer")
            return
        }
        activeJob = job
        lastEmit = 0
        UIApplication.shared.isIdleTimerDisabled = true
        ble.run(job: decoded, printer: printer, progress: { [weak self] sent, total, force in
            self?.emitProgress(job, sent, total, force)
        }, completion: { [weak self] result in
            self?.jobEnded()
            switch result {
            case .success(.done): reply.ok(["ok": true, "outcome": "done"])
            case .success(.cancelled): reply.ok(["ok": true, "outcome": "cancelled"])
            case .failure(let f): reply.fail(f.rawValue)
            }
        })
    }

    private func jobEnded() {
        activeJob = nil
        UIApplication.shared.isIdleTimerDisabled = false
        background.end()
    }

    /// `fs-ios-print` CustomEvent, ≤ 10 per second; the first (sent 0) and the last are always sent.
    private func emitProgress(_ job: String, _ sent: Int, _ total: Int, _ force: Bool) {
        let t = CACurrentMediaTime()   // monotonic, and not a "required reason" API (see PrinterStore)
        if !force && t - lastEmit < 0.1 { return }
        lastEmit = t
        webView?.callAsyncJavaScript(PrintBridge.progressBody, arguments: ["job": job, "sent": sent, "total": total],
                                     in: nil, in: .page, completionHandler: nil)
    }

    /// Called by ViewController on UIApplication.didEnterBackgroundNotification. CoreBluetooth is largely
    /// unavailable in the background without the bluetooth-central mode (which this app does not declare),
    /// so the job is ended cleanly at its next mark and reported as `interrupted`.
    func didEnterBackground() {
        guard activeJob != nil else { return }
        background.begin()
        ble.requestCancel(reason: .interrupted)
    }

    // MARK: - systemPrint (AirPrint of the HTML the web would have printed with iframe.print())

    private func systemPrint(_ body: [String: Any], _ reply: PrintReply) {
        guard let html = body["html"] as? String else {
            reply.reject("bad_request")
            return
        }
        if html.utf16.count > 8_388_608 {
            reply.fail("too_large")
            return
        }
        let widthMm = (body["widthMm"] as? NSNumber)?.doubleValue ?? 80
        let rawName = body["name"] as? String ?? ""
        let name = rawName.isEmpty ? "FieldSales" : rawName
        guard let host = presenter else {
            reply.fail("print_unavailable")
            return
        }
        HtmlPrinter.shared.start(html: html, widthMm: widthMm, name: name, host: host) { outcome, code in
            if let o = outcome {
                reply.ok(["ok": true, "outcome": o])
            } else {
                reply.fail(code ?? "failed")
            }
        }
    }
}
