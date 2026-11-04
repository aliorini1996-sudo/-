import UIKit
import CoreLocation

// Working-day route tracking — the iOS counterpart of android-rep/.../track/TrackService.kt.
// The web starts it over the `fsTrack` bridge (TrackBridge.swift) with a short-lived track token from
// POST /api/tracking/device-token. This file records the rep's route with CoreLocation and posts it to the
// device ping endpoint, also while the app is in the background or the screen is locked: UIBackgroundModes
// `location` + when-in-use authorization + allowsBackgroundLocationUpdates set while in the foreground, with
// the blue location indicator shown. No "Always" authorization is ever requested. It records only with
// Precise Location on: when it is off, iOS is asked for temporary full accuracy, and nothing starts without it.
// Everything runs on the main queue: the location manager is created on the main thread, the upload session
// delivers on OperationQueue.main and the timer is on the main run loop. Only file writes go to `io`.

/// Shared constants: the same values as android-rep/.../track/TrackContract.kt and
/// web-admin/src/rep/nativeTracking.ts (the web calls this handler; Android uses an intent instead).
enum TrackContract {
    static let handlerName = "fsTrack"
    static let pingUrl = "https://api.fieldsa.net/api/track-device/ping"
    static let deviceNowHeader = "x-fs-device-now"
    static let sampleMs: Double = 5_000
    static let movingKeepMs: Double = 15_000
    static let moveThresholdM: Double = 20
    /// 30 s, the web's own idle gap (trackUpload.ts IDLE_GAP_MS): the manager's map calls a location "live" for
    /// 2 min only, and web points are not stored while the app uploads, so a slower heartbeat turned a rep
    /// standing at a customer amber between two heartbeats.
    static let stationaryMs: Double = 30_000
    static let maxAccuracyM: Double = 500
    static let uploadEveryMs: Double = 30_000
    static let maxBatch = 200
    static let maxQueued = 3_000
    static let backoffMs: [Double] = [30_000, 60_000, 120_000, 300_000]
    static let maxTokenChars = 4_096
    static let requestTimeoutSec: TimeInterval = 15
    /// The server's refusal code (backend/src/services/deviceTrack.ts). A 401/403 stops tracking only with it.
    static let tokenInvalidCode = "TRACK_TOKEN_INVALID"
}

/// One kept fix. `t` is the fix time in ms since 1970 on the device clock; the server corrects the clock
/// skew with the x-fs-device-now header. `speed` is m/s, nil when CoreLocation has no valid speed.
struct TrackPoint: Codable {
    let lat: Double
    let lng: Double
    let accuracy: Double
    let speed: Double?
    let t: Double
}

/// Pure rules, the same as android-rep/.../track/TrackLogic.kt (unit-tested there).
enum TrackLogic {
    /// keep(fix) := accuracy <= 500 && (no last kept || dt >= 30 s || (dt >= 15 s && moved >= 20 m))
    static func shouldKeep(_ fix: TrackPoint, lastKept: TrackPoint?) -> Bool {
        guard fix.accuracy <= TrackContract.maxAccuracyM else { return false }
        guard let last = lastKept else { return true }
        let dt = fix.t - last.t
        if dt >= TrackContract.stationaryMs { return true }
        return dt >= TrackContract.movingKeepMs && distanceMeters(fix, last) >= TrackContract.moveThresholdM
    }

    /// Haversine distance in metres (mean Earth radius 6 371 km).
    static func distanceMeters(_ a: TrackPoint, _ b: TrackPoint) -> Double {
        let r = 6_371_000.0
        let p1 = a.lat * Double.pi / 180
        let p2 = b.lat * Double.pi / 180
        let dp = (b.lat - a.lat) * Double.pi / 180
        let dl = (b.lng - a.lng) * Double.pi / 180
        let s1 = sin(dp / 2)
        let s2 = sin(dl / 2)
        let h = s1 * s1 + cos(p1) * cos(p2) * s2 * s2
        return 2 * r * asin(min(1.0, sqrt(h)))
    }

    /// 30 s → 60 s → 120 s → 300 s, then 300 s for every further failure (`step` = failures so far).
    static func backoffMs(step: Int) -> Double {
        let table = TrackContract.backoffMs
        return table[max(0, min(step, table.count - 1))]
    }

    static func sameLocalDay(_ a: Date, _ b: Date) -> Bool {
        return Calendar.current.isDate(a, inSameDayAs: b)
    }
}

/// The track token is a JWT signed by the server. The phone only checks its shape and reads `sub` / `exp`
/// (no signature check here: the server verifies every ping and answers 401 to a bad token).
enum TrackToken {
    struct Claims {
        let sub: String
        let exp: Double   // seconds since 1970
    }

    /// Three non-empty base64url parts separated by dots, at most 4096 characters.
    static func looksValid(_ s: String) -> Bool {
        let u = Array(s.utf8)
        guard !u.isEmpty, u.count <= TrackContract.maxTokenChars else { return false }
        var dots = 0
        var run = 0
        for c in u {
            if c == 0x2E {
                if run == 0 { return false }
                dots += 1
                run = 0
                continue
            }
            let ok = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
            if !ok { return false }
            run += 1
        }
        return dots == 2 && run > 0
    }

    static func claims(_ s: String) -> Claims? {
        guard looksValid(s) else { return nil }
        let parts = s.components(separatedBy: ".")
        guard parts.count == 3, let data = base64Url(parts[1]),
              let obj = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
              let sub = obj["sub"] as? String, !sub.isEmpty,
              let expNumber = obj["exp"] as? NSNumber else { return nil }
        let expSec = expNumber.doubleValue
        guard expSec.isFinite, expSec > 0 else { return nil }
        return Claims(sub: sub, exp: expSec)
    }

    private static func base64Url(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        if b.utf8.count % 4 == 1 { return nil }
        while b.utf8.count % 4 != 0 { b += "=" }
        return Data(base64Encoded: b)
    }
}

/// Application Support files, like PrinterStore: small files, not the user-defaults store (a "required
/// reason" API that would need a privacy manifest, which this app does not have — ITMS-91053). They keep the
/// default data protection of app files (readable and writable after the first unlock), so the queue is
/// written while the screen is locked.
enum TrackFiles {
    static let queueName = "fs.track.queue.v1.json"
    static let consentName = "fs.track.consent.v1.json"

    private static func fileURL(_ name: String) -> URL? {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return dir.appendingPathComponent(name, isDirectory: false)
    }

    static func read(_ name: String) -> Data? {
        guard let url = fileURL(name) else { return nil }
        return try? Data(contentsOf: url)
    }

    static func write(_ data: Data, _ name: String) {
        guard let url = fileURL(name) else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
            try data.write(to: url, options: .atomic)
        } catch {
            // Not saved: the points stay in memory and the next write tries again.
        }
    }

    static func remove(_ name: String) {
        guard let url = fileURL(name) else { return }
        try? FileManager.default.removeItem(at: url)
    }
}

/// The persisted upload queue. `sub` is the rep the points belong to: a different rep starting on this phone
/// discards them, so no point is ever sent under another rep's token.
struct TrackQueueFile: Codable {
    let sub: String
    let points: [TrackPoint]
}

/// Keeps the app running until an upload is answered, also when the rep leaves the app at that moment
/// (like PrintBackgroundTask). One instance per request.
final class TrackBackgroundTask {
    private var id: UIBackgroundTaskIdentifier = .invalid

    func begin() {
        guard id == .invalid else { return }
        id = UIApplication.shared.beginBackgroundTask(withName: "fs-track-upload") { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// Singleton CoreLocation recorder + uploader.
/// Stops on: explicit stop (web), token expiry, local day change since start, 401/403 from the ping (token
/// dropped), `data.stop === true` (the company turned tracking off), location permission revoked or Precise
/// Location turned off.
final class TrackService: NSObject, CLLocationManagerDelegate {
    static let shared = TrackService()

    private enum Stop {
        case explicit     // the web asked (logout, tracking turned off for this rep, another rep's start)
        case dayChanged   // the local calendar day changed since start
        case expired      // the token's exp has passed
        case rejected     // 401 / 403 with TRACK_TOKEN_INVALID: the token or the rep is no longer accepted
        case serverStop   // data.stop: tracking is off for this rep now
        case denied       // location permission revoked, or Precise Location off (not granted / turned off)
    }

    /// A cached fix delivered right after startUpdatingLocation can be minutes old; it is not today's route.
    private static let staleFixMs: Double = 60_000
    private static let tickSec: TimeInterval = 5
    /// Key in Info.plist NSLocationTemporaryUsageDescriptionDictionary: the purpose iOS shows when it asks
    /// for temporary full accuracy (Precise Location off). Both must be renamed together.
    private static let fullAccuracyPurposeKey = "WorkdayRoute"
    /// The full-accuracy answer can reach the completion before the manager reports the new accuracy.
    private static let accuracySettleSec: TimeInterval = 1

    /// allowsBackgroundLocationUpdates = true without the `location` background mode raises an exception.
    private static let backgroundModeDeclared: Bool = {
        let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
        return modes.contains("location")
    }()

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private let manager = CLLocationManager()
    private let io = DispatchQueue(label: "net.fieldsa.track.io", qos: .utility)
    private let session: URLSession

    // Run state.
    private var token: String?
    private var tokenExp: Double = 0            // token exp, seconds since 1970
    private var startedAt: Date?
    private var running = false                 // location updates on
    private var waitingAuth = false             // when-in-use or full accuracy asked; begins after the answer
    private var accuracyAsked = false           // the temporary full-accuracy prompt was asked for this run
    private var epoch = 0                     // +1 on every new run and every stop: late answers of an older run only touch the queue
    private var timer: Timer?
    private var lastKept: TrackPoint?
    private var lastSampleT: Double?
    private var keptThisRun = 0
    private var firstUpload = false             // the first kept point after start is sent at once

    // Queue state: belongs to queueSub, survives a stop and an app restart (TrackFiles.queueName).
    private var queueLoaded = false
    private var queueSub: String?
    private var queue: [TrackPoint] = []
    private var queueGen = 0                    // +1 whenever the queue is discarded
    private var inFlight = 0                    // points at the front of `queue` in the request on the wire
    private var uploading = false
    private var lastUploadT: Double = 0         // ms since 1970
    private var backoffStep = 0
    private var retryAt: Double = 0             // ms since 1970

    private override init() {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = TrackContract.requestTimeoutSec
        c.timeoutIntervalForResource = TrackContract.requestTimeoutSec * 2
        c.waitsForConnectivity = false
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpShouldSetCookies = false
        c.httpCookieAcceptPolicy = .never
        session = URLSession(configuration: c, delegate: nil, delegateQueue: OperationQueue.main)
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
    }

    // MARK: - start / stop (called by TrackBridge on the main thread)

    /// Starts today's tracking, or only refreshes the token when the same rep is already tracked today.
    /// The caller has checked the token's shape and the rep has accepted the disclosure.
    func start(token newToken: String) {
        let now = Date()
        guard let c = TrackToken.claims(newToken), c.exp > now.timeIntervalSince1970 else { return }
        if running || waitingAuth {
            if c.sub == queueSub, let s = startedAt, TrackLogic.sameLocalDay(now, s) {
                token = newToken
                tokenExp = c.exp
                uploadIfDue(force: true)
                return
            }
            finish(.explicit)
        }
        adoptQueue(for: c.sub)
        epoch += 1
        token = newToken
        tokenExp = c.exp
        startedAt = now
        accuracyAsked = false
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if manager.accuracyAuthorization == .fullAccuracy {
                begin()
            } else {
                waitingAuth = true
                askFullAccuracy()   // begin() follows only once Precise Location is on
            }
        case .notDetermined:
            waitingAuth = true
            manager.requestWhenInUseAuthorization()   // begin() follows in locationManagerDidChangeAuthorization
        default:
            // Denied or restricted: nothing to record. The web keeps its own location status.
            token = nil
            tokenExp = 0
            startedAt = nil
        }
    }

    /// The web asked to stop (logout, or tracking turned off for this rep).
    func stop() {
        guard running || waitingAuth || token != nil else { return }
        finish(.explicit)
    }

    /// When-in-use (or Always) with Precise Location on. With Precise off every fix is about 1–5 km wide and
    /// the keep filter (500 m) drops them all: the run would show the indicator all day and record nothing.
    private var canRecord: Bool {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            return manager.accuracyAuthorization == .fullAccuracy
        default:
            return false
        }
    }

    /// Precise Location is off: asks iOS for full accuracy for this session, with the purpose text of
    /// fullAccuracyPurposeKey (Info.plist). A grant reaches locationManagerDidChangeAuthorization, which begins;
    /// a refusal, or an error such as the app no longer being in the foreground, ends the start in
    /// accuracyAnswered. Asked once per run: the delegate may report the reduced accuracy again meanwhile.
    private func askFullAccuracy() {
        guard waitingAuth, !running, !accuracyAsked else { return }
        accuracyAsked = true
        let askedEpoch = epoch
        manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: TrackService.fullAccuracyPurposeKey) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + TrackService.accuracySettleSec) {
                self?.accuracyAnswered(epoch: askedEpoch)
            }
        }
    }

    private func accuracyAnswered(epoch askedEpoch: Int) {
        guard askedEpoch == epoch, waitingAuth, !running else { return }   // already begun, stopped or restarted
        if canRecord {
            begin()
        } else {
            finish(.denied)   // asked again at the next app open (the web starts again then)
        }
    }

    private func begin() {
        guard token != nil, !running else { return }
        waitingAuth = false
        running = true
        lastKept = nil
        lastSampleT = nil
        keptThisRun = 0
        firstUpload = true
        backoffStep = 0
        retryAt = 0
        if TrackService.backgroundModeDeclared {
            manager.allowsBackgroundLocationUpdates = true
        }
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
        let t = Timer(timeInterval: TrackService.tickSec, target: self, selector: #selector(tickFired(_:)), userInfo: nil, repeats: true)
        RunLoop.main.add(t, forMode: .common)
        timer = t
        if !queue.isEmpty { uploadIfDue(force: true) }   // left over from an earlier run of this rep
    }

    private func finish(_ why: Stop) {
        let tok = token
        let live = tokenExp > Date().timeIntervalSince1970
        if running || waitingAuth {
            manager.stopUpdatingLocation()
            if TrackService.backgroundModeDeclared {
                manager.allowsBackgroundLocationUpdates = false
            }
        }
        timer?.invalidate()
        timer = nil
        running = false
        waitingAuth = false
        accuracyAsked = false
        epoch += 1
        token = nil
        tokenExp = 0
        startedAt = nil
        lastKept = nil
        lastSampleT = nil
        keptThisRun = 0
        firstUpload = false
        switch why {
        case .serverStop:
            dropQueue()
        case .rejected:
            // As on Android: the points were captured while the token was valid; they wait in the file for
            // this rep's next start (another rep's start discards them in adoptQueue).
            break
        case .explicit, .dayChanged, .denied:
            // One last batch while the token is still in hand; whatever is left waits in the file for this
            // rep's next start.
            if let t = tok, live, !uploading, !queue.isEmpty { send(t, closing: true) }
        case .expired:
            break
        }
    }

    // MARK: - queue

    private func adoptQueue(for sub: String) {
        if !queueLoaded {
            queueLoaded = true
            if let f = loadQueueFile() {
                queueSub = f.sub
                queue = f.points.count > TrackContract.maxQueued ? Array(f.points.suffix(TrackContract.maxQueued)) : f.points
            }
        }
        if queueSub != sub {
            queueGen += 1
            queue = []
            inFlight = 0
            queueSub = sub
            persistQueue()
        }
    }

    private func dropQueue() {
        queueGen += 1
        queue = []
        inFlight = 0
        persistQueue()
    }

    private func enqueue(_ p: TrackPoint) {
        keptThisRun += 1
        queue.append(p)
        if queue.count > TrackContract.maxQueued {
            let drop = queue.count - TrackContract.maxQueued
            queue.removeFirst(drop)
            inFlight = max(0, inFlight - drop)
        }
        persistQueue()
    }

    private func loadQueueFile() -> TrackQueueFile? {
        return io.sync { () -> TrackQueueFile? in
            guard let data = TrackFiles.read(TrackFiles.queueName) else { return nil }
            return try? JSONDecoder().decode(TrackQueueFile.self, from: data)
        }
    }

    private func persistQueue() {
        let snapshot: TrackQueueFile?
        if let sub = queueSub, !queue.isEmpty {
            snapshot = TrackQueueFile(sub: sub, points: queue)
        } else {
            snapshot = nil
        }
        io.async {
            if let s = snapshot, let data = try? JSONEncoder().encode(s) {
                TrackFiles.write(data, TrackFiles.queueName)
            } else {
                TrackFiles.remove(TrackFiles.queueName)
            }
        }
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running else { return }
        let nowMs = Date().timeIntervalSince1970 * 1000
        for loc in locations {
            accept(loc, nowMs: nowMs)
        }
        uploadIfDue(force: false)
    }

    private func accept(_ loc: CLLocation, nowMs: Double) {
        guard loc.horizontalAccuracy >= 0, CLLocationCoordinate2DIsValid(loc.coordinate) else { return }
        let t = loc.timestamp.timeIntervalSince1970 * 1000
        if nowMs - t > TrackService.staleFixMs { return }
        if let s = lastSampleT, t - s < TrackContract.sampleMs { return }   // one sample per 5 s, like Android's interval
        lastSampleT = t
        let speed: Double? = loc.speed >= 0 ? loc.speed : nil
        let p = TrackPoint(lat: loc.coordinate.latitude, lng: loc.coordinate.longitude,
                           accuracy: loc.horizontalAccuracy, speed: speed, t: t)
        guard p.lat.isFinite, p.lng.isFinite, p.accuracy.isFinite, t.isFinite else { return }
        guard TrackLogic.shouldKeep(p, lastKept: lastKept) else { return }
        lastKept = p
        enqueue(p)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            if manager.accuracyAuthorization == .fullAccuracy {
                if waitingAuth { begin() }
            } else if running {
                // Precise Location turned off in Settings (or the temporary full accuracy ended) mid-run:
                // every fix is dropped from now on, so stop instead of showing the indicator for nothing.
                finish(.denied)
            } else if waitingAuth {
                askFullAccuracy()   // the when-in-use answer came with Precise off (no-op once asked)
            }
        case .notDetermined:
            break
        default:
            if running || waitingAuth { finish(.denied) }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // kCLErrorLocationUnknown and the like are transient: updates continue by themselves.
        if let e = error as? CLError, e.code == .denied, running || waitingAuth {
            finish(.denied)
        }
    }

    // MARK: - timer

    @objc private func tickFired(_ t: Timer) {
        guard t === timer, running else { return }
        let now = Date()
        if now.timeIntervalSince1970 >= tokenExp {
            finish(.expired)
            return
        }
        if let s = startedAt, !TrackLogic.sameLocalDay(now, s) {
            finish(.dayChanged)
            return
        }
        uploadIfDue(force: false)
    }

    // MARK: - upload

    /// Every 30 s while running, at once for the first kept point after start (and on `force`), never
    /// during a backoff and never with a request already on the wire (the 5 s tick retries).
    private func uploadIfDue(force: Bool) {
        guard running, let tok = token, !uploading, !queue.isEmpty else { return }
        let nowMs = Date().timeIntervalSince1970 * 1000
        if nowMs < retryAt { return }
        let firstPointWaiting = firstUpload && keptThisRun > 0
        if !force && !firstPointWaiting && nowMs - lastUploadT < TrackContract.uploadEveryMs { return }
        send(tok, closing: false)
    }

    private func send(_ tok: String, closing: Bool) {
        guard !uploading, !queue.isEmpty, let url = URL(string: TrackContract.pingUrl) else { return }
        let batch = Array(queue.prefix(TrackContract.maxBatch))
        guard let body = TrackService.body(batch) else {
            // Not representable as JSON (cannot happen with the finite values accepted above): drop the
            // batch rather than stall the queue on it.
            queue.removeFirst(batch.count)
            persistQueue()
            return
        }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: TrackContract.requestTimeoutSec)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer " + tok, forHTTPHeaderField: "Authorization")
        req.setValue(TrackService.deviceNow(), forHTTPHeaderField: TrackContract.deviceNowHeader)
        req.httpBody = body
        uploading = true
        inFlight = batch.count
        if keptThisRun > 0 { firstUpload = false }   // a send of leftovers alone does not count as the first point's
        lastUploadT = Date().timeIntervalSince1970 * 1000
        let gen = queueGen
        let sentEpoch = epoch
        let count = batch.count
        let bg = TrackBackgroundTask()
        bg.begin()
        let task = session.dataTask(with: req) { [weak self] data, response, error in
            self?.answered(gen: gen, epoch: sentEpoch, closing: closing, count: count, data: data, response: response, error: error)
            bg.end()
        }
        task.resume()
    }

    private func answered(gen: Int, epoch sentEpoch: Int, closing: Bool, count: Int,
                          data: Data?, response: URLResponse?, error: Error?) {
        uploading = false
        var status = 0
        if error == nil, let http = response as? HTTPURLResponse { status = http.statusCode }
        let ok = status >= 200 && status <= 299
        // A 401/403 without our refusal code comes from something in front of the server (a firewall, a
        // hotel captive portal): retried with the backoff instead of ending the rep's day.
        let refused = (status == 401 || status == 403) && TrackService.serverSaysTokenInvalid(data)
        let retry = status == 0 || status == 408 || status == 429 || status >= 500 ||
            ((status == 401 || status == 403) && !refused)
        let stopNow = ok && TrackService.serverSaysStop(data)

        // 1. The queue (unless it was discarded meanwhile): 2xx removes the batch; any other 4xx refuses the
        //    batch itself, which is dropped so the queue cannot stall on it.
        if gen == queueGen {
            if ok || (!refused && !retry) {
                let n = min(inFlight, queue.count)
                if n > 0 { queue.removeFirst(n) }
            }
            inFlight = 0
            persistQueue()
        }

        // 2. The run: only the run that sent this request may act on the answer.
        guard sentEpoch == epoch else { return }
        if stopNow {
            finish(.serverStop)
            return
        }
        if refused {
            finish(.rejected)
            return
        }
        if ok {
            backoffStep = 0
            retryAt = 0
            if !closing && count >= TrackContract.maxBatch { uploadIfDue(force: true) }   // drain a backlog
            return
        }
        if retry {
            retryAt = Date().timeIntervalSince1970 * 1000 + TrackLogic.backoffMs(step: backoffStep)
            backoffStep += 1
        }
    }

    /// `{ "points": [{ lat, lng, accuracy, speed|null, capturedAt }] }` — matches the backend pingSchema.
    private static func body(_ pts: [TrackPoint]) -> Data? {
        var arr: [[String: Any]] = []
        arr.reserveCapacity(pts.count)
        for p in pts {
            var d: [String: Any] = [:]
            d["lat"] = p.lat
            d["lng"] = p.lng
            d["accuracy"] = p.accuracy
            if let s = p.speed {
                d["speed"] = s
            } else {
                d["speed"] = NSNull()
            }
            d["capturedAt"] = iso.string(from: Date(timeIntervalSince1970: p.t / 1000))
            arr.append(d)
        }
        let obj: [String: Any] = ["points": arr]
        guard JSONSerialization.isValidJSONObject(obj) else { return nil }   // false for NaN / infinity
        return try? JSONSerialization.data(withJSONObject: obj, options: [])
    }

    /// `{ success: false, code: "TRACK_TOKEN_INVALID" }`: the server refused the token itself.
    private static func serverSaysTokenInvalid(_ data: Data?) -> Bool {
        guard let d = data,
              let obj = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any] else { return false }
        return (obj["code"] as? String) == TrackContract.tokenInvalidCode
    }

    /// `{ success: true, data: { stored: 0, stop: true } }`: tracking is off for this rep now.
    private static func serverSaysStop(_ data: Data?) -> Bool {
        guard let d = data,
              let obj = (try? JSONSerialization.jsonObject(with: d, options: [])) as? [String: Any],
              let inner = obj["data"] as? [String: Any] else { return false }
        return (inner["stop"] as? Bool) == true || (inner["disabled"] as? Bool) == true
    }

    /// The device clock in ms since 1970 as a decimal string — exactly what the web sends in this header
    /// (web-admin/src/rep/repApi.ts: String(Date.now())). The server reads it with Number() in
    /// correctCapturedAt (backend/src/services/liveLocation.ts) to correct the device clock skew.
    private static func deviceNow() -> String {
        return String(Int64((Date().timeIntervalSince1970 * 1000).rounded()))
    }
}
