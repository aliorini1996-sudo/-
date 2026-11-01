import Foundation
import CoreBluetooth
import QuartzCore

/// CoreBluetooth central for the rep's BLE receipt/label printer (no UIKit here).
/// Three activities, one at a time: scan (picker), probe (picker row tap → choose and save the write
/// characteristic) and run (print one FSP job with BLE flow control, marks-aware cancel and a close grace).
/// Everything runs on the main queue: the central is created with `queue: nil`, timers are on the main
/// run loop and deferred work uses DispatchQueue.main.
/// The central is created lazily (prepare / probe / run), so the Bluetooth permission prompt appears only
/// when the rep links or prints — never at launch and never for `hello`.
final class BlePrinter: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    enum Fail: String, Error {
        case bt_off, bt_denied, bt_unsupported, not_found, connect, disconnected, interrupted
    }

    enum Outcome {
        case done
        case cancelled
    }

    enum CancelReason {
        case user
        case interrupted
    }

    enum Power {
        case on
        case pending
        case failed(Fail)
    }

    enum ProbeResult {
        case saved(SavedPrinter)
        case notPrinter
        case failed(Fail)
    }

    struct Candidate {
        let peripheral: CBPeripheral
        var name: String?
        var rssi: Int
        var knownService: Bool
    }

    struct Choice {
        let service: CBService
        let characteristic: CBCharacteristic
        let withResponse: Bool
    }

    /// Known printer services and their write characteristic, in order of preference (spec E.3).
    static let table: [(service: String, characteristic: String)] = [
        ("18F0", "2AF1"),
        ("49535343-FE7D-4AE5-8FA9-9FAFD205E455", "49535343-8841-43F4-A8D4-ECBE34729BB3"),
        ("E7810A71-73AE-499D-8C15-FAA9AEF0C3F2", "BEF8D6C9-9C21-4C9E-B632-BD58C1009F9F"),
        ("FF00", "FF02"),
        ("FFE0", "FFE1"),
    ]
    /// Never used for the fallback: GAP, GATT, device info, battery, and "cat printers" (not ESC/POS).
    static let ignoredServices = ["1800", "1801", "180A", "180F", "AE30"]

    private enum Mode {
        case idle, scan, probe, run
    }

    private enum Step {
        case none, power, find, connect, discover, write, drain
    }

    private(set) var central: CBCentralManager?
    private(set) var candidates: [Candidate] = []
    /// Picker hooks (set by PrinterPickerViewController, cleared by endPicker).
    var onPower: ((Power) -> Void)?
    var onCandidates: (() -> Void)?

    private var mode: Mode = .idle
    private var step: Step = .none
    private var target: CBPeripheral?          // strong ref: a released peripheral cancels its connection
    private var readyWaiter: ((Fail?) -> Void)?
    private var connectDone: ((Bool) -> Void)?
    private var discoverDone: (([CBService], Bool) -> Void)?
    private var charFilter: [CBUUID]?
    private var pendingServices = 0
    private var stepTimer: Timer?
    private var stepAction: (() -> Void)?
    private var watchdog: Timer?

    // probe
    private var probeDone: ((ProbeResult) -> Void)?

    // run
    private var job: PrintJob?
    private var saved: SavedPrinter?
    private var runDone: ((Result<Outcome, Fail>) -> Void)?
    private var runProgress: ((Int, Int, Bool) -> Void)?
    private var cancelReason: CancelReason?
    private var plan = WritePlan(total: 0, marks: [])
    private var characteristic: CBCharacteristic?
    private var withResponse = false
    private var dose = WritePlan.minChunk
    private var doseLeft = WritePlan.minChunk
    private var pauseMs = 0
    private var paused = false
    private var awaitingAck = false
    private var yieldScheduled = false
    private var retryScheduled = false
    private var tail: [UInt8] = []
    private var tailSent = 0
    private var lastActivity: TimeInterval = 0
    private var drainStarted: TimeInterval = 0
    private var graceStarted = false
    private var gen = 0

    // MARK: - power

    static func power(of state: CBManagerState) -> Power {
        switch state {
        case .poweredOn: return .on
        case .poweredOff: return .failed(.bt_off)
        case .unauthorized: return .failed(.bt_denied)
        case .unsupported: return .failed(.bt_unsupported)
        case .unknown, .resetting: return .pending
        @unknown default: return .failed(.bt_unsupported)
        }
    }

    @discardableResult
    private func ensureCentral() -> CBCentralManager {
        if let c = central { return c }
        let c = CBCentralManager(delegate: self, queue: nil, options: [CBCentralManagerOptionShowPowerAlertKey: true])
        central = c
        return c
    }

    /// Creates the central if needed (this is what shows the permission prompt) and returns its state.
    func prepare() -> Power {
        return BlePrinter.power(of: ensureCentral().state)
    }

    private func whenReady(_ f: @escaping (Fail?) -> Void) {
        let c = ensureCentral()
        switch BlePrinter.power(of: c.state) {
        case .on:
            f(nil)
        case .failed(let x):
            f(x)
        case .pending:
            readyWaiter = f
            // No timeout while the system permission prompt is on screen.
            if CBCentralManager.authorization != .notDetermined {
                arm(10) { [weak self] in self?.flushReady(.bt_off) }
            }
        }
    }

    private func flushReady(_ fail: Fail?) {
        guard let w = readyWaiter else { return }
        readyWaiter = nil
        disarm()
        w(fail)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let p = BlePrinter.power(of: central.state)
        switch p {
        case .pending:
            break
        case .on:
            flushReady(nil)
        case .failed(let f):
            if readyWaiter != nil {
                flushReady(f)
            } else {
                lostPower(f)
            }
        }
        onPower?(p)
    }

    private func lostPower(_ f: Fail) {
        switch mode {
        case .run:
            switch step {
            case .write: finishRun(.failure(cancelReason == .interrupted ? .interrupted : .disconnected))
            case .drain: completeDrain()
            default: finishRun(.failure(f))
            }
        case .probe:
            finishProbe(.failed(f))
        case .scan:
            mode = .idle
            candidates.removeAll()
            onCandidates?()
        case .idle:
            break
        }
    }

    // MARK: - scan (picker)

    func startScan() {
        guard mode == .idle || mode == .scan, let c = central, c.state == .poweredOn else { return }
        mode = .scan
        if !c.isScanning {
            c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        }
    }

    func stopScan() {
        guard mode == .scan else { return }
        stopScanRadio()
        mode = .idle
    }

    /// Picker closed: stop scanning, abandon a probe, drop the picker hooks.
    func endPicker() {
        onPower = nil
        onCandidates = nil
        if mode == .probe {
            disarm()
            dropTarget()
            probeDone = nil
            mode = .idle
            step = .none
        }
        stopScan()
        candidates.removeAll()
    }

    private func stopScanRadio() {
        if let c = central, c.state == .poweredOn, c.isScanning { c.stopScan() }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if mode == .run {
            if step == .find, let s = saved, peripheral.identifier == s.id {
                central.stopScan()
                disarm()
                connectAndWrite(peripheral)
            }
            return
        }
        guard mode == .scan else { return }
        let advertised = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let trimmed = (peripheral.name ?? advertised)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let name: String? = (trimmed?.isEmpty ?? true) ? nil : trimmed
        let uuids = advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        let known = uuids.contains { u in BlePrinter.table.contains { BlePrinter.matches(u, $0.service) } }
        if name == nil && !known { return }
        var rssi = RSSI.intValue
        if rssi >= 0 { rssi = -100 }   // 127 = not available
        if let i = candidates.firstIndex(where: { $0.peripheral.identifier == peripheral.identifier }) {
            candidates[i].rssi = rssi
            if name != nil { candidates[i].name = name }
            if known { candidates[i].knownService = true }
        } else {
            candidates.append(Candidate(peripheral: peripheral, name: name, rssi: rssi, knownService: known))
        }
        candidates.sort { a, b in
            if a.knownService != b.knownService { return a.knownService }
            let pa = BlePrinter.looksLikePrinter(a.name)
            let pb = BlePrinter.looksLikePrinter(b.name)
            if pa != pb { return pa }
            return a.rssi > b.rssi
        }
        onCandidates?()
    }

    static func looksLikePrinter(_ name: String?) -> Bool {
        guard let n = name?.lowercased() else { return false }
        let tokens = ["print", "pos", "rpp", "rongta", "mpt", "xprinter", "xp-", "pt-", "label", "thermal",
                      "bixolon", "spp-r", "tm-p", "zebra"]
        if tokens.contains(where: { n.contains($0) }) { return true }
        if n.hasPrefix("rp") { return true }
        let chars = Array(n)
        if chars.count >= 2, chars[0] == "p", ("0"..."9").contains(chars[1]) { return true }
        return false
    }

    // MARK: - probe (picker)

    func probe(_ candidate: Candidate, name: String, completion: @escaping (ProbeResult) -> Void) {
        guard mode == .idle || mode == .scan else {
            completion(.failed(.connect))
            return
        }
        stopScanRadio()
        mode = .probe
        step = .power
        probeDone = completion
        let peripheral = candidate.peripheral
        whenReady { [weak self] fail in
            guard let self = self, self.mode == .probe else { return }
            if let f = fail {
                self.finishProbe(.failed(f))
                return
            }
            self.connect(peripheral) { [weak self] ok in
                guard let self = self, self.mode == .probe else { return }
                guard ok else {
                    self.finishProbe(.failed(.connect))
                    return
                }
                self.discover(services: nil, characteristics: nil) { [weak self] services, timedOut in
                    guard let self = self, self.mode == .probe else { return }
                    guard let p = self.target, let pick = BlePrinter.choose(services) else {
                        self.finishProbe(timedOut ? .failed(.connect) : .notPrinter)
                        return
                    }
                    let printer = SavedPrinter(id: p.identifier, name: name,
                                               service: pick.service.uuid.uuidString,
                                               characteristic: pick.characteristic.uuid.uuidString,
                                               withResponse: pick.withResponse)
                    PrinterStore.save(printer)
                    self.finishProbe(.saved(printer))
                }
            }
        }
    }

    private func finishProbe(_ r: ProbeResult) {
        guard mode == .probe, let done = probeDone else { return }
        probeDone = nil
        readyWaiter = nil
        disarm()
        dropTarget()
        mode = .idle
        step = .none
        done(r)
    }

    // MARK: - connect / discover (shared)

    private func connect(_ p: CBPeripheral, _ done: @escaping (Bool) -> Void) {
        guard let c = central, c.state == .poweredOn else {
            done(false)
            return
        }
        step = .connect
        target = p
        p.delegate = self
        connectDone = done
        c.connect(p, options: nil)
        // Connection attempts never time out on their own.
        arm(10) { [weak self] in self?.finishConnect(false) }
    }

    private func finishConnect(_ ok: Bool) {
        guard let d = connectDone else { return }
        connectDone = nil
        disarm()
        d(ok)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard peripheral === target, step == .connect else { return }
        finishConnect(true)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral === target, step == .connect else { return }
        finishConnect(false)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === target else { return }
        switch step {
        case .connect:
            // A late disconnect of an earlier link (e.g. the probe that just saved this printer):
            // ask again; the 10 s timer still bounds the attempt.
            if connectDone != nil, central.state == .poweredOn { central.connect(peripheral, options: nil) }
        case .discover:
            if mode == .probe { finishProbe(.failed(.connect)) } else if mode == .run { finishRun(.failure(.connect)) }
        case .write:
            finishRun(.failure(cancelReason == .interrupted ? .interrupted : .disconnected))
        case .drain:
            // Some printers drop the link right after the job: that is a success.
            completeDrain()
        default:
            break
        }
    }

    private func discover(services: [CBUUID]?, characteristics: [CBUUID]?, _ done: @escaping ([CBService], Bool) -> Void) {
        guard let p = target else {
            done([], false)
            return
        }
        step = .discover
        discoverDone = done
        charFilter = characteristics
        pendingServices = 0
        p.discoverServices(services)
        arm(8) { [weak self] in self?.finishDiscover(timedOut: true) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard peripheral === target, discoverDone != nil else { return }
        let list = peripheral.services ?? []
        if error != nil || list.isEmpty {
            finishDiscover(timedOut: false)
            return
        }
        pendingServices = list.count
        for s in list {
            peripheral.discoverCharacteristics(charFilter, for: s)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard peripheral === target, discoverDone != nil else { return }
        pendingServices -= 1
        if pendingServices <= 0 { finishDiscover(timedOut: false) }
    }

    private func finishDiscover(timedOut: Bool) {
        guard let d = discoverDone else { return }
        discoverDone = nil
        disarm()
        d(target?.services ?? [], timedOut)
    }

    /// Cancels the link (or the pending connection attempt) and forgets the peripheral.
    private func dropTarget() {
        if let p = target, let c = central, c.state == .poweredOn, p.state != .disconnected {
            c.cancelPeripheralConnection(p)
        }
        target = nil
        connectDone = nil
        discoverDone = nil
        pendingServices = 0
    }

    // MARK: - characteristic choice

    static func fullUUID(_ s: String) -> String {
        let u = s.uppercased()
        switch u.count {
        case 4: return "0000" + u + "-0000-1000-8000-00805F9B34FB"
        case 8: return u + "-0000-1000-8000-00805F9B34FB"
        default: return u
        }
    }

    static func matches(_ u: CBUUID, _ s: String) -> Bool {
        return fullUUID(u.uuidString) == fullUUID(s)
    }

    /// CBUUID(string:) raises an Objective-C exception on a malformed string; only well-formed ones pass.
    static func uuid(_ s: String) -> CBUUID? {
        let parts = s.components(separatedBy: "-").map { $0.count }
        guard parts == [4] || parts == [8] || parts == [8, 4, 4, 4, 12] else { return nil }
        let hex = CharacterSet(charactersIn: "0123456789abcdefABCDEF-")
        guard s.unicodeScalars.allSatisfy({ hex.contains($0) }) else { return nil }
        return CBUUID(string: s)
    }

    /// Prefers write-without-response (false), else write-with-response (true); nil = not writable.
    static func writeMode(_ c: CBCharacteristic) -> Bool? {
        if c.properties.contains(.writeWithoutResponse) { return false }
        if c.properties.contains(.write) { return true }
        return nil
    }

    static func choose(_ services: [CBService]) -> Choice? {
        for entry in table {
            for s in services where matches(s.uuid, entry.service) {
                for c in s.characteristics ?? [] where matches(c.uuid, entry.characteristic) {
                    if let wr = writeMode(c) { return Choice(service: s, characteristic: c, withResponse: wr) }
                }
            }
        }
        let usable = services.filter { s in !ignoredServices.contains { matches(s.uuid, $0) } }
        for s in usable {
            for c in s.characteristics ?? [] where c.properties.contains(.writeWithoutResponse) {
                return Choice(service: s, characteristic: c, withResponse: false)
            }
        }
        for s in usable {
            for c in s.characteristics ?? [] where c.properties.contains(.write) {
                return Choice(service: s, characteristic: c, withResponse: true)
            }
        }
        return nil
    }

    static func savedMatch(_ services: [CBService], service: String, characteristic: String) -> Choice? {
        for s in services where matches(s.uuid, service) {
            for c in s.characteristics ?? [] where matches(c.uuid, characteristic) {
                if let wr = writeMode(c) { return Choice(service: s, characteristic: c, withResponse: wr) }
            }
        }
        return nil
    }

    // MARK: - run (print)

    /// Prints one decoded job on the saved printer. `progress(sent, total, force)`; `completion` is called
    /// exactly once (watchdogs guarantee it).
    func run(job: PrintJob, printer: SavedPrinter,
             progress: @escaping (Int, Int, Bool) -> Void,
             completion: @escaping (Result<Outcome, Fail>) -> Void) {
        if mode == .scan { stopScan() }
        guard mode == .idle else {
            completion(.failure(.connect))
            return
        }
        gen += 1
        mode = .run
        step = .power
        self.job = job
        saved = printer
        runDone = completion
        runProgress = progress
        cancelReason = nil
        whenReady { [weak self] fail in
            guard let self = self, self.mode == .run else { return }
            if let f = fail {
                self.finishRun(.failure(f))
                return
            }
            self.find()
        }
    }

    private func find() {
        guard let c = central, let s = saved else {
            finishRun(.failure(.not_found))
            return
        }
        step = .find
        if let p = c.retrievePeripherals(withIdentifiers: [s.id]).first {
            connectAndWrite(p)
            return
        }
        c.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        arm(6) { [weak self] in self?.finishRun(.failure(.not_found)) }
    }

    private func connectAndWrite(_ p: CBPeripheral) {
        connect(p) { [weak self] ok in
            guard let self = self, self.mode == .run else { return }
            guard ok else {
                self.finishRun(.failure(.connect))
                return
            }
            self.locateCharacteristic()
        }
    }

    private func locateCharacteristic() {
        guard let s = saved, let svc = BlePrinter.uuid(s.service), let ch = BlePrinter.uuid(s.characteristic) else {
            fullDiscovery()
            return
        }
        discover(services: [svc], characteristics: [ch]) { [weak self] services, _ in
            guard let self = self, self.mode == .run else { return }
            if let hit = BlePrinter.savedMatch(services, service: s.service, characteristic: s.characteristic) {
                self.startWriting(hit.characteristic, withResponse: hit.withResponse)
            } else {
                self.fullDiscovery()
            }
        }
    }

    private func fullDiscovery() {
        discover(services: nil, characteristics: nil) { [weak self] services, _ in
            guard let self = self, self.mode == .run else { return }
            guard let p = self.target, let s = self.saved, let pick = BlePrinter.choose(services) else {
                self.finishRun(.failure(.connect))
                return
            }
            let updated = SavedPrinter(id: p.identifier, name: s.name, service: pick.service.uuid.uuidString,
                                       characteristic: pick.characteristic.uuid.uuidString,
                                       withResponse: pick.withResponse)
            PrinterStore.save(updated)
            self.saved = updated
            self.startWriting(pick.characteristic, withResponse: pick.withResponse)
        }
    }

    private func startWriting(_ ch: CBCharacteristic, withResponse wr: Bool) {
        guard let j = job else {
            finishRun(.failure(.connect))
            return
        }
        step = .write
        characteristic = ch
        withResponse = wr
        plan = WritePlan(total: j.bytes.count, marks: j.marks)
        dose = WritePlan.dose(j.chunkBytes)
        doseLeft = dose
        pauseMs = WritePlan.pause(j.pauseMs)
        paused = false
        awaitingAck = false
        tail = []
        tailSent = 0
        graceStarted = false
        lastActivity = BlePrinter.now()
        startWatchdog()
        runProgress?(0, j.bytes.count, true)
        pump()
    }

    /// The write loop. Re-entered from peripheralIsReady / didWriteValueFor / the pause and yield timers.
    private func pump() {
        guard mode == .run, step == .write, let p = target, let ch = characteristic, let j = job else { return }
        var packets = 0
        while true {
            if cancelReason != nil && !plan.cancelled && !plan.finished {
                plan.requestCancel()
                tail = j.cancel
            }
            if awaitingAck { return }
            let more = !plan.finished || tailSent < tail.count
            if !more {
                startDrain()
                return
            }
            if paused { return }
            if packets >= 64 {
                scheduleYield()
                return
            }
            let limit: Int
            if withResponse {
                // One ATT write request per packet (MTU − 3). The with-response maximum is 512 whatever the MTU,
                // and above MTU − 3 iOS switches to a queued "long write" that many printer modules do not support.
                limit = min(p.maximumWriteValueLength(for: .withoutResponse), 512)
            } else {
                guard p.canSendWriteWithoutResponse else {
                    scheduleRetry()   // normally resumed by peripheralIsReady(toSendWriteWithoutResponse:)
                    return
                }
                limit = p.maximumWriteValueLength(for: .withoutResponse)
            }
            let fromJob = !plan.finished
            let n = max(1, fromJob ? min(limit, doseLeft) : limit)
            let data: Data
            if fromJob {
                guard let r = plan.next(max: n) else { continue }
                data = Data(j.bytes[r])
            } else {
                let e = min(tailSent + n, tail.count)
                data = Data(tail[tailSent..<e])
                tailSent = e
            }
            p.writeValue(data, for: ch, type: withResponse ? .withResponse : .withoutResponse)
            packets += 1
            lastActivity = BlePrinter.now()
            if withResponse { awaitingAck = true }
            if fromJob {
                doseLeft -= data.count
                runProgress?(plan.sent, plan.total, false)
                if doseLeft <= 0 {
                    doseLeft = dose
                    if j.slow && pauseMs > 0 {
                        paused = true
                        schedulePause()
                        return
                    }
                }
            }
        }
    }

    private func scheduleYield() {
        guard !yieldScheduled else { return }
        yieldScheduled = true
        let g = gen
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.yieldScheduled = false
            if self.gen == g { self.pump() }
        }
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        let g = gen
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50)) { [weak self] in
            guard let self = self else { return }
            self.retryScheduled = false
            if self.gen == g { self.pump() }
        }
    }

    private func schedulePause() {
        let g = gen
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(pauseMs)) { [weak self] in
            guard let self = self, self.gen == g else { return }
            self.paused = false
            self.pump()
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard peripheral === target, mode == .run, step == .write || step == .drain else { return }
        if error != nil {
            if step == .write {
                finishRun(.failure(cancelReason == .interrupted ? .interrupted : .disconnected))
            }
            return
        }
        awaitingAck = false
        lastActivity = BlePrinter.now()
        pump()
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        guard peripheral === target, mode == .run else { return }
        lastActivity = BlePrinter.now()
        if step == .write {
            pump()
        } else if step == .drain {
            drainCheck()
        }
    }

    // MARK: - drain

    private func startDrain() {
        guard step == .write else { return }
        step = .drain
        stopWatchdog()
        drainStarted = BlePrinter.now()
        if withResponse {
            beginGrace()
        } else {
            drainCheck()
        }
    }

    /// Waits (≤ 2 s) until iOS can take writes again, i.e. its own queue has been flushed.
    private func drainCheck() {
        guard mode == .run, step == .drain, !graceStarted else { return }
        let flushed = target?.canSendWriteWithoutResponse ?? true
        if flushed || BlePrinter.now() - drainStarted >= 2 {
            beginGrace()
        } else {
            arm(0.05) { [weak self] in self?.drainCheck() }
        }
    }

    /// Writes without response are not acknowledged: give the printer its close grace + 1 s, then hang up.
    private func beginGrace() {
        guard let j = job else { return }
        graceStarted = true
        arm(Double(WritePlan.grace(j.closeGraceMs)) / 1000) { [weak self] in self?.completeDrain() }
    }

    private func completeDrain() {
        guard mode == .run, step == .drain else { return }
        let total = plan.total
        runProgress?(plan.cancelled ? plan.stopAt : total, total, true)
        if plan.cancelled {
            finishRun(cancelReason == .interrupted ? .failure(.interrupted) : .success(.cancelled))
        } else {
            finishRun(.success(.done))
        }
    }

    // MARK: - cancel / finish

    /// User cancel or app sent to background. Before the first byte the connection is dropped at once;
    /// while writing, the job finishes to the next mark and then sends the cancel bytes.
    func requestCancel(reason: CancelReason = .user) {
        guard mode == .run else { return }
        if cancelReason != .interrupted { cancelReason = reason }
        switch step {
        case .write:
            pump()
        case .drain:
            break
        default:
            finishRun(cancelReason == .interrupted ? .failure(.interrupted) : .success(.cancelled))
        }
    }

    private func finishRun(_ r: Result<Outcome, Fail>) {
        guard mode == .run, let done = runDone else { return }
        disarm()
        stopWatchdog()
        if step == .find { stopScanRadio() }
        dropTarget()
        runDone = nil
        runProgress = nil
        readyWaiter = nil
        job = nil
        saved = nil
        characteristic = nil
        cancelReason = nil
        paused = false
        awaitingAck = false
        tail = []
        tailSent = 0
        graceStarted = false
        mode = .idle
        step = .none
        gen += 1
        done(r)
    }

    // MARK: - timers (selector-based, main run loop, common modes)

    private func arm(_ seconds: TimeInterval, _ action: @escaping () -> Void) {
        disarm()
        stepAction = action
        let t = Timer(timeInterval: seconds, target: self, selector: #selector(stepTimerFired(_:)), userInfo: nil, repeats: false)
        RunLoop.main.add(t, forMode: .common)
        stepTimer = t
    }

    private func disarm() {
        stepTimer?.invalidate()
        stepTimer = nil
        stepAction = nil
    }

    @objc private func stepTimerFired(_ t: Timer) {
        guard t === stepTimer else { return }
        let action = stepAction
        stepTimer = nil
        stepAction = nil
        action?()
    }

    private func startWatchdog() {
        stopWatchdog()
        let t = Timer(timeInterval: 1, target: self, selector: #selector(watchdogTick(_:)), userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        watchdog = t
    }

    private func stopWatchdog() {
        watchdog?.invalidate()
        watchdog = nil
    }

    /// No progress for 15 s while writing ⇒ hang up and report (never leaves the page waiting).
    @objc private func watchdogTick(_ t: Timer) {
        guard mode == .run, step == .write else {
            stopWatchdog()
            return
        }
        if BlePrinter.now() - lastActivity > 15 {
            finishRun(.failure(cancelReason == .interrupted ? .interrupted : .disconnected))
        }
    }

    /// Monotonic seconds from QuartzCore. The boot-time clock APIs of Foundation and Mach are "required reason"
    /// APIs that would need a privacy manifest, which this app does not have (App Store Connect ITMS-91053).
    private static func now() -> TimeInterval {
        return CACurrentMediaTime()
    }
}
