import UIKit
import CoreBluetooth

/// Native Arabic printer picker (code-built, no storyboard), presented by PrintBridge for the `pick` op.
/// On iOS a BLE printer is not paired in Settings: the app scans by itself and the rep taps the printer.
/// Completes exactly once: .saved(name) or .failed(code) with picker_cancelled / bt_off / bt_denied /
/// bt_unsupported. No technical cause and no provider name is shown to the rep.
final class PrinterPickerViewController: UITableViewController, UIAdaptivePresentationControllerDelegate {
    enum PickResult {
        case saved(String)
        case failed(String)
    }

    private enum Row {
        case info
        case status(String, spinner: Bool)
        case hint(String)
        case settings
        case printer(BlePrinter.Candidate)
    }

    private static let unnamed = "طابعة بلا اسم"

    private let ble: BlePrinter
    private var completion: ((PickResult) -> Void)?
    private var failCode = "picker_cancelled"
    private var power: BlePrinter.Power = .pending
    private var emptyHint = false
    private var probing = false
    private var overlay: UIView?
    private var rows: [[Row]] = []
    private let savedId = PrinterStore.load()?.id

    init(ble: BlePrinter, completion: @escaping (PickResult) -> Void) {
        self.ble = ble
        self.completion = completion
        super.init(style: .insetGrouped)
    }

    required init?(coder: NSCoder) {
        return nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "اختيار الطابعة"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "إلغاء", style: .plain, target: self,
                                                           action: #selector(cancelTapped))
        view.semanticContentAttribute = .forceRightToLeft
        tableView.semanticContentAttribute = .forceRightToLeft
        navigationController?.view.semanticContentAttribute = .forceRightToLeft
        navigationController?.navigationBar.semanticContentAttribute = .forceRightToLeft
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 60
        ble.onPower = { [weak self] p in self?.powerChanged(p) }
        ble.onCandidates = { [weak self] in self?.rebuild() }
        perform(#selector(showEmptyHint), with: nil, afterDelay: 20)
        powerChanged(ble.prepare())   // creates the central: first use shows the Bluetooth permission prompt
    }

    // MARK: - state

    private func powerChanged(_ p: BlePrinter.Power) {
        power = p
        switch p {
        case .on:
            failCode = "picker_cancelled"
            if !probing { ble.startScan() }
        case .pending:
            break
        case .failed(let f):
            failCode = f.rawValue
        }
        rebuild()
    }

    @objc private func showEmptyHint() {
        emptyHint = true
        rebuild()
    }

    private func rebuild() {
        var main: [Row] = []
        switch power {
        case .pending:
            main.append(.status("جار البحث…", spinner: true))
        case .failed(.bt_off):
            main.append(.status("البلوتوث مطفأ — شغله من مركز التحكم ثم ارجع", spinner: false))
        case .failed(.bt_denied):
            main.append(.status("اسمح لتطبيق فيلد سيلز باستخدام البلوتوث", spinner: false))
            main.append(.settings)
        case .failed:
            main.append(.status("هذا الجوال لا يدعم البلوتوث", spinner: false))
        case .on:
            for c in ble.candidates { main.append(.printer(c)) }
            main.append(.status("جار البحث…", spinner: true))
            if emptyHint && ble.candidates.isEmpty {
                main.append(.hint("لم تظهر طابعة قريبة — تأكد أنها مشغلة وقريبة وغير متصلة بجوال آخر. ويمكنك دائما مشاركة ملف PDF"))
            }
        }
        rows = [[.info], main]
        tableView.reloadData()
    }

    private static func strength(_ rssi: Int) -> String {
        if rssi > -60 { return "قوية" }
        if rssi > -80 { return "متوسطة" }
        return "ضعيفة"
    }

    // MARK: - table

    override func numberOfSections(in tableView: UITableView) -> Int {
        return rows.count
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        return rows[section].count
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.semanticContentAttribute = .forceRightToLeft
        cell.contentView.semanticContentAttribute = .forceRightToLeft
        cell.selectionStyle = .none
        let title = cell.textLabel
        let sub = cell.detailTextLabel
        title?.textAlignment = .right
        title?.numberOfLines = 0
        sub?.textAlignment = .right
        sub?.numberOfLines = 0
        switch rows[indexPath.section][indexPath.row] {
        case .info:
            title?.text = "شغل الطابعة وقربها من الجوال. لا تقرنها من إعدادات البلوتوث في الآيفون — اخترها من هنا."
            title?.font = UIFont.preferredFont(forTextStyle: .footnote)
            title?.textColor = .secondaryLabel
        case .status(let text, let spinner):
            title?.text = text
            title?.textColor = .secondaryLabel
            if spinner {
                let s = UIActivityIndicatorView(style: .medium)
                s.startAnimating()
                cell.accessoryView = s
            }
        case .hint(let text):
            title?.text = text
            title?.font = UIFont.preferredFont(forTextStyle: .footnote)
            title?.textColor = .secondaryLabel
        case .settings:
            title?.text = "فتح الإعدادات"
            title?.textColor = view.tintColor
            cell.selectionStyle = .default
        case .printer(let c):
            title?.text = c.name ?? PrinterPickerViewController.unnamed
            var detail = "الإشارة: " + PrinterPickerViewController.strength(c.rssi)
            if c.peripheral.identifier == savedId { detail += " · الطابعة المحفوظة" }
            sub?.text = detail
            sub?.textColor = .secondaryLabel
            cell.selectionStyle = .default
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard !probing, indexPath.section < rows.count, indexPath.row < rows[indexPath.section].count else { return }
        switch rows[indexPath.section][indexPath.row] {
        case .settings:
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
        case .printer(let c):
            connect(c)
        default:
            break
        }
    }

    // MARK: - connect

    private func connect(_ c: BlePrinter.Candidate) {
        let name = c.name ?? PrinterPickerViewController.unnamed
        probing = true
        ble.stopScan()
        showOverlay("جار الاتصال بـ\(name)…")
        ble.probe(c, name: name) { [weak self] result in
            guard let self = self else { return }
            self.probing = false
            self.hideOverlay()
            switch result {
            case .saved(let printer):
                self.complete(.saved(printer.name))
                self.dismiss(animated: true, completion: nil)
            case .notPrinter:
                self.alert("هذا الجهاز ليس طابعة — اختر طابعتك")
            case .failed(let f):
                switch f {
                case .bt_off, .bt_denied, .bt_unsupported:
                    self.powerChanged(.failed(f))
                default:
                    self.alert("تعذر الاتصال بالطابعة — تأكد أنها مشغلة وقريبة وغير متصلة بجهاز آخر")
                }
            }
        }
    }

    private func alert(_ text: String) {
        let a = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "حسنا", style: .default) { [weak self] _ in
            self?.rescan()
        })
        present(a, animated: true, completion: nil)
    }

    private func rescan() {
        if case .on = power { ble.startScan() }
        rebuild()
    }

    private func showOverlay(_ text: String) {
        hideOverlay()
        let host: UIView
        if let navView = navigationController?.view {
            host = navView
        } else {
            host = view
        }
        let o = UIView(frame: host.bounds)
        o.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        o.backgroundColor = UIColor.black.withAlphaComponent(0.35)
        let spinner = UIActivityIndicatorView(style: .large)
        spinner.color = .white
        spinner.startAnimating()
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        let stack = UIStackView(arrangedSubviews: [spinner, label])
        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        o.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: o.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: o.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: o.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: o.trailingAnchor, constant: -24),
        ])
        host.addSubview(o)
        overlay = o
    }

    private func hideOverlay() {
        overlay?.removeFromSuperview()
        overlay = nil
    }

    // MARK: - completion

    private func complete(_ r: PickResult) {
        guard let c = completion else { return }
        completion = nil
        NSObject.cancelPreviousPerformRequests(withTarget: self)
        hideOverlay()
        ble.endPicker()
        c(r)
    }

    @objc private func cancelTapped() {
        complete(.failed(failCode))
        dismiss(animated: true, completion: nil)
    }

    /// Swipe-down dismissal of the sheet.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        complete(.failed(failCode))
    }
}
