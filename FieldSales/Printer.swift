import UIKit
import WebKit

func printView(webView: WKWebView){
    let printController = UIPrintInteractionController.shared

    let printInfo = UIPrintInfo(dictionary:nil)
    printInfo.outputType = UIPrintInfo.OutputType.general
    printInfo.jobName = webView.url?.absoluteString ?? "FieldSales"
    printInfo.duplex = UIPrintInfo.Duplex.none
    printInfo.orientation = UIPrintInfo.Orientation.portrait

    printController.printPageRenderer = UIPrintPageRenderer()
          
    printController.printPageRenderer?.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)

    printController.printInfo = printInfo
    printController.showsNumberOfCopies = true
    printController.present(animated: true)
}

/// AirPrint of an HTML document for the `systemPrint` bridge op: `window.print()` inside a WKWebView is a
/// silent no-op on iOS, so the web hands the same HTML it would have printed through iframe.print() and
/// the app prints it from an off-screen web view. One job at a time.
/// Completion: (outcome "printed" | "dismissed", nil) or (nil, code "print_unavailable" | "busy" | "failed").
final class HtmlPrinter: NSObject, WKNavigationDelegate {
    static let shared = HtmlPrinter()

    private var web: WKWebView?
    private var done: ((String?, String?) -> Void)?
    private var jobName = "FieldSales"
    private var retired: [WKWebView] = []

    func start(html: String, widthMm: Double, name: String, host: UIViewController,
               completion: @escaping (String?, String?) -> Void) {
        guard UIPrintInteractionController.isPrintingAvailable else {
            completion(nil, "print_unavailable")
            return
        }
        guard web == nil, done == nil else {
            completion(nil, "busy")
            return
        }
        let mm = widthMm.isFinite ? widthMm : 80
        let width = CGFloat(max(160, min(1200, mm * 96 / 25.4)))
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true   // same as the main web view; base URL is fieldsa.net
        let w = WKWebView(frame: CGRect(x: -10_000, y: 0, width: width, height: 800), configuration: config)
        w.navigationDelegate = self
        w.isUserInteractionEnabled = false
        host.view.addSubview(w)   // must be in the hierarchy to render
        web = w
        done = completion
        jobName = name
        w.loadHTMLString(html, baseURL: URL(string: "https://fieldsa.net/"))
        perform(#selector(timedOut), with: nil, afterDelay: 15)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === web else { return }
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(timedOut), object: nil)
        perform(#selector(showSheet), with: nil, afterDelay: 0.5)   // let images settle
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        finish(nil, "failed")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === web else { return }
        finish(nil, "failed")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === web else { return }
        finish(nil, "failed")
    }

    @objc private func timedOut() {
        finish(nil, "failed")
    }

    @objc private func showSheet() {
        guard let w = web, done != nil else { return }
        let pc = UIPrintInteractionController.shared
        let info = UIPrintInfo(dictionary: nil)
        info.outputType = .general
        info.jobName = jobName
        pc.printingItem = nil
        pc.printingItems = nil
        pc.printPageRenderer = nil
        pc.printInfo = info
        pc.printFormatter = w.viewPrintFormatter()
        let shown = pc.present(animated: true) { [weak self] _, completed, _ in
            self?.finish(completed ? "printed" : "dismissed", nil)
        }
        if !shown { finish(nil, "failed") }
    }

    private func finish(_ outcome: String?, _ code: String?) {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(timedOut), object: nil)
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(showSheet), object: nil)
        if let w = web {
            w.navigationDelegate = nil
            retired.append(w)   // removed a little later, after the print system has rendered it
            perform(#selector(dropRetired), with: nil, afterDelay: 2)
        }
        web = nil
        guard let d = done else { return }
        done = nil
        d(outcome, code)
    }

    @objc private func dropRetired() {
        guard web == nil else { return }
        for w in retired { w.removeFromSuperview() }
        retired.removeAll()
    }
}
