import UIKit
import WebKit

/// Application Support/fs.track.consent.v1.json — the rep accepted the one-time background-location
/// disclosure on this phone (a small file like PrinterStore, see TrackFiles).
struct TrackConsent: Codable {
    let accepted: Bool
    let at: Double   // ms since 1970
}

enum TrackConsentStore {
    static func accepted() -> Bool {
        guard let data = TrackFiles.read(TrackFiles.consentName),
              let c = try? JSONDecoder().decode(TrackConsent.self, from: data) else { return false }
        return c.accepted
    }

    static func saveAccepted() {
        let c = TrackConsent(accepted: true, at: (Date().timeIntervalSince1970 * 1000).rounded())
        guard let data = try? JSONEncoder().encode(c) else { return }
        TrackFiles.write(data, TrackFiles.consentName)
    }
}

/// `window.webkit.messageHandlers.fsTrack.postMessage({ action: 'start', token })` and
/// `postMessage({ action: 'stop' })` from web-admin/src/rep/nativeTracking.ts.
/// Accepts only the main frame of https://fieldsa.net (exact host) in this app's own web view, like PrintBridge.
/// Fire and forget: nothing is answered to the page, and anything malformed is ignored.
/// start: token shape → one-time disclosure (same text as Android) → TrackService, which asks for when-in-use
/// authorization if it was never asked (and for full accuracy if Precise Location is off) and begins after the
/// answer. stop: TrackService stops and forgets the token.
final class TrackBridge: NSObject, WKScriptMessageHandler {
    static let shared = TrackBridge()

    static let disclosureTitle = "تسجيل موقعك أثناء اليوم"
    // The Android text says a persistent notification shows while it runs; on iPhone it is the blue
    // location indicator at the top of the screen, so only that last clause differs.
    static let disclosureBody = "يسجّل فيلد سيلز موقعك أثناء يوم العمل حتى لو خرجت من التطبيق أو أقفلت الشاشة، ليظهر لمديرك على خريطة التتبّع. يتوقف التسجيل عند تسجيل الخروج أو في نهاية اليوم، ويظهر مؤشّر الموقع أعلى الشاشة ما دام يعمل."
    static let acceptTitle = "موافق"
    static let laterTitle = "ليس الآن"

    weak var webView: WKWebView?
    weak var presenter: UIViewController?
    private weak var installedController: WKUserContentController?
    private weak var disclosure: UIAlertController?
    /// The newest start waiting for the foreground or for the disclosure answer.
    private var pendingToken: String?

    /// Registers the handler on the app's web view (called once from ViewController, next to PrintBridge).
    func install(webView: WKWebView, presenter: UIViewController) {
        self.webView = webView
        self.presenter = presenter
        let ucc = webView.configuration.userContentController
        guard installedController !== ucc else { return }   // a second add with the same name would throw
        installedController = ucc
        ucc.add(self, contentWorld: .page, name: TrackContract.handlerName)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive(_:)),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        guard frame.isMainFrame, origin.protocol == "https", origin.host == "fieldsa.net",
              origin.port == 0 || origin.port == 443,
              let own = webView, message.webView === own else {
            return
        }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "start":
            guard let token = body["token"] as? String, TrackToken.looksValid(token) else { return }
            start(token)
        case "stop":
            stop()
        default:
            break
        }
    }

    // MARK: - start

    private func start(_ token: String) {
        guard let c = TrackToken.claims(token), c.exp > Date().timeIntervalSince1970 else { return }
        pendingToken = token
        proceed()
    }

    /// Runs the pending start once the app is active: with when-in-use authorization, background location
    /// updates can only be started from the foreground (and the disclosure must be seen).
    private func proceed() {
        guard let token = pendingToken else { return }
        guard UIApplication.shared.applicationState == .active else { return }   // resumed by appDidBecomeActive
        if TrackConsentStore.accepted() {
            pendingToken = nil
            TrackService.shared.start(token: token)
            return
        }
        guard disclosure == nil else { return }   // already on screen: the answer uses the newest token
        showDisclosure()
    }

    private func showDisclosure() {
        guard let base = presenter else {
            pendingToken = nil
            return
        }
        var top: UIViewController = base
        while let next = top.presentedViewController { top = next }
        if top.isBeingPresented || top.isBeingDismissed {
            // A sheet is mid-transition: present a moment later instead of failing to present.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.proceed()
            }
            return
        }
        let a = UIAlertController(title: TrackBridge.disclosureTitle, message: TrackBridge.disclosureBody, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: TrackBridge.laterTitle, style: .cancel) { [weak self] _ in
            // Asked again at the next app open (the web starts again then).
            self?.pendingToken = nil
        })
        let accept = UIAlertAction(title: TrackBridge.acceptTitle, style: .default) { [weak self] _ in
            TrackConsentStore.saveAccepted()
            guard let self = self, let token = self.pendingToken else { return }
            self.pendingToken = nil
            TrackService.shared.start(token: token)
        }
        a.addAction(accept)
        a.preferredAction = accept
        disclosure = a
        top.present(a, animated: true, completion: nil)
    }

    @objc private func appDidBecomeActive(_ notification: Notification) {
        proceed()
    }

    // MARK: - stop

    private func stop() {
        pendingToken = nil
        if let a = disclosure, a.presentingViewController != nil, !a.isBeingDismissed {
            a.dismiss(animated: true, completion: nil)
        }
        TrackService.shared.stop()
    }
}
