import ExpoModulesCore
import CoreBluetooth
import UIKit

// iTag型(紛失防止タグ)/PTTボタン型のBLEボタンをアプリで直接受けるモジュール。
//
// なぜ必要か: シャッターリモコン等は「Bluetoothキーボード(HID)」として繋がる
// ため、ロック中にキーを押すとiOSがFace ID/パスコード画面を出してしまい、
// アプリには届かない(OSの仕様で回避不可)。一方、iTag型はGATT通知という
// 生の信号を送る機器なので、bluetooth-central バックグラウンドモードが
// あればロック中・バックグラウンドでもアプリが直接受信できる。
// (Apple公式もPushToTalkの設計で「Bluetoothアクセサリのボタンによる
// バックグラウンドからの送信開始」を想定している)
//
// 対応する機器:
// - iTag(押すたびに0x01を通知するだけ。離した通知は無い)→ 押すたびに送信ON/OFF(トグル)
// - PTTボタン(PTT-Z01等)/Pryme型(押すと非0、離すと0x00)→ 押している間だけ送信(ホールド)
//
// 設計上の要点(レビューで確認された事故を防ぐための不変条件):
// - 「押下」として扱う通知は、登録時に確定した『押下サービス+キャラクタリスティック』
//   (FFE0/FFE1 または FFF0/FFF1 のみ)からのもの、かつ登録済みペリフェラルからの
//   ものに限る。再接続時もこの組だけを購読する(推測で別の通知を購読しない)。
//   電池残量などの無関係な通知で勝手に送信が始まる=ホットマイク事故の防止。
// - 登録は『実際にボタンが2回押されたこと』を確認してから確定する
//   (近くの無関係なFFE0機器を誤登録しない)。
// - 購読が実際に有効になった(ready)後の通知だけを押下として扱う。
//   例外: 購読設定(CCCD)が無い安価なiTagは、登録時に「購読を要求して失敗(属性なし)した
//   状態で実際の2回押しが届いた」ことを確認した場合に限り、接続のたびに同じく購読を
//   要求し、同じ失敗(属性なし)が返った時点で ready とする。
// - 「押す(down)」を送った後にリンクが切れた・異常連打で無効化した等の場合は、
//   必ず「離す(up)」を合成して送る(送信が開いたまま残る事故の防止)。
// - 再接続は登録済みペリフェラルに対してのみ行う(解除済み・旧タグが
//   送信を握り続ける事故の防止)。
// - 状態はすべてメインキューに閉じ込める(JSスレッドとの競合防止)。
public class BleButtonModule: Module {
  fileprivate var central: BleButtonCentral?

  public func definition() -> ModuleDefinition {
    Name("BleButton")

    Events("onPress", "onStateChanged")

    Constants([
      "buildTag": "button-2"
    ])

    OnCreate {
      let helper = BleButtonCentral(module: self)
      self.central = helper
      // 登録済みボタンがある場合のみ、起動直後から接続維持を始める
      // (未登録ならBluetooth権限ダイアログを出さないため、Managerは作らない)。
      DispatchQueue.main.async {
        helper.startIfRegistered()
      }
    }

    // JS側の onPress 購読が始まった/終わった(バックグラウンド起動直後の
    // 「押下の取りこぼし」を後追いで再送するために使う)。
    // onStateChanged だけ購読されている状態で押下を捨てないよう、onPress に限定して見る。
    OnStartObserving("onPress") {
      DispatchQueue.main.async {
        self.central?.setObserving(true)
      }
    }
    OnStopObserving("onPress") {
      DispatchQueue.main.async {
        self.central?.setObserving(false)
      }
    }

    // 登録済みボタンへの接続維持を(再)開始する。
    // JSは前面復帰のたびに呼ぶので、Bluetoothオフ/登録情報の復元失敗からの再試行もここで行われる。
    Function("start") {
      DispatchQueue.main.async {
        self.central?.startIfRegistered()
      }
    }

    // 現在の状態: { registered, connected, ready, name?, holdCapable?, mode? }
    // 状態はメインキューに閉じているため、メインキュー上で読み取る。
    Function("getStatus") { () -> [String: Any] in
      if Thread.isMainThread {
        return self.central?.status() ?? ["registered": false, "connected": false, "ready": false]
      }
      return DispatchQueue.main.sync {
        self.central?.status() ?? ["registered": false, "connected": false, "ready": false]
      }
    }

    // 近くのBLEボタンを探して登録する(前面での初期設定用)。
    // 接続後に「実際のボタン押下(2回)」を確認してから登録を確定する。
    // 成功すると { name, holdCapable } を返し、以後は自動で接続維持される。
    AsyncFunction("startSetup") { (promise: Promise) in
      DispatchQueue.main.async {
        self.central?.startSetup(promise: promise)
      }
    }

    // 登録を解除して切断する。
    Function("unregister") {
      DispatchQueue.main.async {
        self.central?.unregister()
      }
    }

    // 押し方の方式("hold"=押している間だけ / "toggle"=押すたびにON/OFF)を保存する。
    // 離した通知を送らないボタン(iTag)は常に "toggle" として動く。
    Function("setMode") { (mode: String) in
      DispatchQueue.main.async {
        self.central?.setMode(mode)
      }
    }
  }

  fileprivate func emit(_ name: String, _ payload: [String: Any] = [:]) {
    sendEvent(name, payload)
  }
}

// CoreBluetooth側の実装。CBCentralManagerDelegate等はNSObjectが必要なので
// モジュール本体とは別クラスにする(PttDelegateと同じ構成)。
// すべての状態アクセスはメインキュー上で行う(Managerのdelegate queueも.main)。
final class BleButtonCentral: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private weak var module: BleButtonModule?

  // MARK: - 保存キー(UserDefaults)

  private static let uuidKey = "BleButtonPeripheralUUID"
  private static let nameKey = "BleButtonPeripheralName"
  // 登録時に「実際の押下」で確定した押下サービス/キャラクタリスティック。
  // 再接続時はこの組だけを購読する(推測で別の通知を押下扱いしないため)。
  private static let serviceKey = "BleButtonPressService"
  private static let charKey = "BleButtonPressCharacteristic"
  // 離した通知(0x00)を別に送ってくるボタンか(=押している間だけ送信が可能か)。
  private static let holdCapableKey = "BleButtonHoldCapable"
  private static let modeKey = "BleButtonMode"
  // 押下特性に購読設定(CCCD)が無いボタンか。安価なiTagの一部は、購読しなくても
  // 押下を通知してくる(購読の書き込みは「属性が見つからない」で失敗する)。
  private static let noCccdKey = "BleButtonNoCccd"

  // MARK: - UUID

  // 押下通知として受け付けるのは、この2組だけ(iTag系の事実上の標準FFE0/FFE1と、
  // 一部の互換品が使うFFF0/FFF1)。以前の「既知の独自特性(FA01)」や
  // 「通知できる特性を全部購読」は、無関係な機器・通知を押下と誤認する
  // (ホットマイク)恐れがあるため廃止した。
  private static let pressPairs: [(service: CBUUID, characteristic: CBUUID)] = [
    (service: CBUUID(string: "FFE0"), characteristic: CBUUID(string: "FFE1")),
    (service: CBUUID(string: "FFF0"), characteristic: CBUUID(string: "FFF1")),
  ]
  private static let pressServiceUUIDs: [CBUUID] = [CBUUID(string: "FFE0"), CBUUID(string: "FFF0")]
  // 紛失防止タグの警報(Immediate Alert / Link Loss)。どちらも Alert Level(2A06)に
  // 0x00 を書くと鳴らなくなる。Link Loss は接続のたびに書かないと、切断時にタグが鳴る。
  private static let immediateAlertService = CBUUID(string: "1802")
  private static let linkLossService = CBUUID(string: "1803")
  private static let alertLevelChar = CBUUID(string: "2A06")
  // ボタンではない(またはロック中に使えない)機器のサービス。広告・接続後のどちらかで
  // これらが見えたら登録候補から外す。HIDはロック中に使えず、心拍/速度/環境センサーは
  // 通知を流し続けるため「押下確認」をすり抜ける恐れがある。
  private static let excludedServices: Set<CBUUID> = [
    CBUUID(string: "1812"), // HID(キーボード型)
    CBUUID(string: "180D"), // Heart Rate
    CBUUID(string: "1814"), // Running Speed and Cadence
    CBUUID(string: "1816"), // Cycling Speed and Cadence
    CBUUID(string: "181A"), // Environmental Sensing
  ]

  // MARK: - 調整値

  // 登録時に候補として扱う最低電波強度。「手に持ってスマホのすぐ近く」ならこれを
  // 上回る。遠くの無関係な機器を候補から外しつつ、安タグを取りこぼさない値。
  private static let setupMinRSSI = -75
  // トグル操作の連打・多重通知の抑制。押すたびにON/OFFなので長め(0.8秒)にとる。
  private static let toggleDebounce: TimeInterval = 0.8
  // 異常連打の検出: 2秒以内に4回を超える通知が来たら故障/押しっぱなし/チャタリングとみなす。
  private static let rateWindow: TimeInterval = 2.0
  private static let rateLimitCount = 4
  private static let muteDuration: TimeInterval = 30
  // JS購読前に届いた押下を後から再送する期限。長いと「押したのに反応せず、
  // 忘れた頃に送信が始まる」事故になるため短くする。離す(up)は期限なしで必ず届ける。
  private static let replayWindow: TimeInterval = 3
  // 購読直後に一部機種が送る「現在値」を押下と誤認しないための猶予。
  // 通常運用では誤送信(ホットマイク)に直結するので長めにとる。
  private static let subscribeGrace: TimeInterval = 1.0
  // 登録確認中の猶予。「2回押して」の案内直後の素早い1回目を捨てないよう短くする
  // (ここで初期値を1回数えても、確定にはもう1回の実押下が必要なので安全側)。
  private static let setupSubscribeGrace: TimeInterval = 0.3
  // 登録確定の直後は、確定に使った押下の続き(3回目の押下や離す)で送信が始まらないよう無視する。
  private static let postSetupQuiet: TimeInterval = 1.0
  // 登録確認: 同じ特性への通知が「0.3秒以上離れて2回」届いたら押下とみなす
  // (1回の押下で出る2フレームやチャタリングを2回と数えないため)。
  private static let confirmMinGap: TimeInterval = 0.3
  // 条件成立後、少し見届けてから確定する(直後の0x00でホールド対応を判定し、
  // 通知を流し続ける機器を弾くため)。
  private static let confirmSettle: TimeInterval = 0.7
  // 購読設定(CCCD)が無い候補は、購読しなくても通知を出す(=勝手に通知を出し続ける機器と
  // 区別しにくい)ため、登録確認を厳しくする:
  //  - 2回の押下(非0の通知)は、この時間以内の間隔であること(長い周期で通知する機器を弾く)
  //  - 条件成立後、この時間見届け、その間に3回目の押下(非0)が来たら登録しない
  //    (短い周期で通知する機器を弾く)
  //  - 押下確認の待ち時間を短くする(他人のタグに長く捕まらないように)
  private static let noCccdMaxGap: TimeInterval = 3.0
  private static let noCccdConfirmSettle: TimeInterval = 3.0
  private static let noCccdConfirmTimeout: TimeInterval = 12
  // 登録確認中にこれを超える通知が来た機器はボタンではない(センサー等)とみなす。
  private static let setupFloodLimit = 8
  // 押下をJSへ渡す時に、iOSにアプリを動かし続けてもらう時間(PushToTalkの呼び出しが間に合うように)。
  private static let backgroundHoldSeconds: TimeInterval = 8
  private static let defaultName = "BLEボタン"

  // 登録内容(保存値をまとめたもの)。押下サービス/特性が無い・許可外なら nil。
  private struct Registration {
    let identifier: UUID
    let service: CBUUID
    let characteristic: CBUUID
    let holdCapable: Bool
    // 実際に使う方式。ホールド非対応のボタンは常に "toggle"。
    let mode: String
    // 購読設定(CCCD)が無く、購読なしで押下が届くボタン(登録時に実際の押下で確認済み)。
    let noCccd: Bool
  }

  // 登録確認中の、特性ごとの観測結果。
  private struct SetupProbe {
    var firstAt: TimeInterval = 0
    var count: Int = 0
    var sawNonZero: Bool = false
    var holdCapable: Bool = false
    // 非0(押した)通知の回数と、最初/最後に届いた時刻(購読設定が無い候補の判定用)。
    var nonZeroCount: Int = 0
    var firstNonZeroAt: TimeInterval = 0
    var lastNonZeroAt: TimeInterval = 0
  }

  // MARK: - 接続状態

  private var manager: CBCentralManager?
  private var peripheral: CBPeripheral?
  // リンクが繋がっている(まだ押下を受けられるとは限らない)。
  private var connected = false
  // 押下キャラクタリスティックの購読が実際に有効になった(ここで初めてボタンとして使える)。
  private var ready = false
  private var subscribeGraceUntil: TimeInterval = 0
  private var pressQuietUntil: TimeInterval = 0
  // 状態復元(バックグラウンド再起動)後に、poweredOnを待ってから再購読するためのフラグ。
  private var needsRediscovery = false
  // 状態復元で引き継いだ「登録外」の接続(前プロセスの設定途中の候補など)。poweredOn後に切る。
  private var restoredStrays: [CBPeripheral] = []
  private var readyTimeoutWork: DispatchWorkItem?
  private var reconnectBackoffWork: DispatchWorkItem?
  // 準備失敗で自分から切断した時に、次の再接続まで置く間隔(0なら即時)。
  private var nextReconnectDelay: TimeInterval = 0

  // MARK: - 押下状態

  // ホールド方式で「押す」を送り、まだ「離す」を送っていない。
  private var isDown = false
  // 最後の「離す」以降に、押す/トグルを送ったか(送信中かもしれない)。
  // リンク切断・異常連打の無効化時に「離す」を合成して、送信を確実に止めるために使う。
  private var pressSinceRelease = false
  private var lastToggleAt: TimeInterval = 0
  private var recentNotifyTimes: [TimeInterval] = []
  private var mutedUntil: TimeInterval = 0
  private var unmuteWork: DispatchWorkItem?
  // JS側が onPress を購読中か。未購読中(バックグラウンド起動直後など)の押下は
  // 保持しておき、購読開始時に再送する(起こした一押し目を無駄にしない)。
  private var observing = false
  private var pendingPresses: [(kind: String, at: TimeInterval)] = []
  private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
  private var backgroundEndWork: DispatchWorkItem?

  // MARK: - 初期設定(スキャン→接続→押下確認)の状態

  private var setupPromise: Promise?
  // スキャンで見つけた候補(識別子ごとに最良RSSIを保持)。scoreはボタンらしさ:
  // 2=FFE0/FFF0を広告 / 1=名前が iTAG・PTT で始まる。
  private var setupCandidates: [UUID: (peripheral: CBPeripheral, rssi: Int, score: Int, name: String)] = [:]
  // 近い順に並べた接続試行キュー(先頭から1台ずつ接続→押下確認していく)。
  private var setupQueue: [CBPeripheral] = []
  private var setupAwaitingPress = false
  // 特性の発見待ちの押下サービス数。
  private var setupPendingPressServices = 0
  // 購読要求を出した/購読が確認できた押下特性(FFE1/FFF1)。
  private var setupSubscribing: Set<CBUUID> = []
  private var setupSubscribed: Set<CBUUID> = []
  // 購読設定(CCCD)が無いため、購読なしで押下を待っている押下特性。
  private var setupNoCccd: Set<CBUUID> = []
  // 今回の登録で「購読なしで待ったが押下が届かなかった」候補があったか(失敗時の案内用)。
  private var setupNoCccdUnanswered = false
  private var setupProbes: [CBUUID: SetupProbe] = [:]
  private var setupFinalizeWork: DispatchWorkItem?
  private var scanDeadlineWork: DispatchWorkItem?
  private var connectTimeoutWork: DispatchWorkItem?
  private var confirmTimeoutWork: DispatchWorkItem?
  private var masterTimeoutWork: DispatchWorkItem?

  init(module: BleButtonModule) {
    self.module = module
    super.init()
  }

  // MARK: - 公開操作(すべてメインキューから呼ばれる)

  func setObserving(_ value: Bool) {
    observing = value
    guard value, !pendingPresses.isEmpty else { return }
    // 購読開始時: 未配信の押下を再送する(アプリがボタン押下で起こされた直後、
    // JSの購読が間に合わなかったケース)。押す/トグルは3秒以内のものだけ
    // (遅れて送信が始まる事故を防ぐ)。離すは止める方向なので年齢に関係なく届ける。
    let now = Self.now()
    let queued = pendingPresses
    pendingPresses = []
    for item in queued {
      let age = now - item.at
      if item.kind != "up" && age > Self.replayWindow { continue }
      holdBackgroundTime()
      module?.emit("onPress", [
        "kind": item.kind,
        "replayed": true,
        "ageMs": max(0, Int(age * 1000)),
      ])
    }
  }

  func startIfRegistered() {
    guard registeredUUID() != nil else { return }
    guard loadRegistration() != nil else {
      // 旧ビルドで登録された(押下サービス/特性が保存されていない)ボタン。
      // どの通知が押下か確定できないまま購読すると誤送信の恐れがあるため接続しない。
      emitState("error", "ボタンの登録情報が古い形式です。一度「登録を解除」して、もう一度登録してください")
      return
    }
    ensureManager()
    // Bluetoothオフ/権限なしは didUpdateState では「変わった時」しか通知されないため、
    // 前面復帰のたびに現状を画面へ出す(電源が戻れば poweredOn で自動再接続する)。
    if let manager {
      switch manager.state {
      case .poweredOff:
        emitState("error", "Bluetoothがオフになっています")
      case .unauthorized:
        emitState("error", "Bluetooth権限がありません(設定→アプリで許可)")
      default:
        break
      }
    }
    connectIfPossible()
  }

  func status() -> [String: Any] {
    var result: [String: Any] = [
      "registered": registeredUUID() != nil,
      "connected": connected,
      "ready": ready,
    ]
    if let name = UserDefaults.standard.string(forKey: Self.nameKey) {
      result["name"] = name
    }
    if let reg = loadRegistration() {
      result["holdCapable"] = reg.holdCapable
      result["mode"] = reg.mode
      result["noCccd"] = reg.noCccd
    }
    return result
  }

  func setMode(_ mode: String) {
    guard mode == "hold" || mode == "toggle" else { return }
    let before = loadRegistration()?.mode
    UserDefaults.standard.set(mode, forKey: Self.modeKey)
    guard let reg = loadRegistration(), reg.mode != before else { return }
    // 実際に方式が変わる時点で送信中かもしれない状態は、必ず「離す」で閉じる
    // (ホールドで押している最中にトグルへ切り替えた等で、送信が開いたまま残らないように)。
    // 同じ方式の再設定(起動時の同期など)では、押している最中の送信を止めない。
    releaseIfNeeded()
    emitState("debug", "ボタンの方式: \(reg.mode == "hold" ? "押している間だけ送信" : "押すたびに送信ON/OFF")")
  }

  func startSetup(promise: Promise) {
    if setupPromise != nil {
      promise.reject("E_BUSY", "すでに検索中です")
      return
    }
    // 再登録に備えて既存の接続は解除しておく(失敗時はfailSetupで復旧する)。
    // 押している最中なら、ここで「離す」も送られる。
    disconnectCurrent()
    setupPromise = promise
    setupCandidates = [:]
    setupNoCccdUnanswered = false
    ensureManager()
    guard let manager else {
      failSetup("E_INTERNAL", "Bluetoothを初期化できませんでした")
      return
    }
    // どの経路でも必ず結末がつくように全体の期限を設ける。
    let master = DispatchWorkItem { [weak self] in
      self?.failSetup("E_TIMEOUT", "時間切れです。もう一度お試しください")
    }
    masterTimeoutWork = master
    DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: master)

    // 重要: didUpdateStateは「状態が変わった時」しか呼ばれない。
    // すでに確定している状態(オフ/権限なし/非対応)はここで即座に失敗させる。
    switch manager.state {
    case .poweredOn:
      beginScan()
      emitState("scanning", "近くのボタンを検索中...(ボタンを1回押すと見つかりやすくなります)")
    case .poweredOff:
      failSetup("E_POWERED_OFF", "Bluetoothがオフです。コントロールセンターでオンにしてください")
    case .unauthorized:
      failSetup("E_UNAUTHORIZED", "Bluetoothの使用が許可されていません。設定アプリで許可してください")
    case .unsupported:
      failSetup("E_UNSUPPORTED", "この端末はBluetooth LEに対応していません(シミュレーターでは使えません)")
    default:
      // .unknown(権限ダイアログ表示中など)/.resetting は didUpdateState を待つ。
      emitState("scanning", "Bluetoothの準備中...")
    }
  }

  func unregister() {
    // 設定途中なら中断する。
    if setupPromise != nil {
      failSetup("E_CANCELLED", "登録を中断しました")
    }
    // 押している最中なら、ここで「離す」も送られる。
    disconnectCurrent()
    let defaults = UserDefaults.standard
    for key in [Self.uuidKey, Self.nameKey, Self.serviceKey, Self.charKey, Self.holdCapableKey, Self.modeKey, Self.noCccdKey] {
      defaults.removeObject(forKey: key)
    }
    mutedUntil = 0
    unmuteWork?.cancel()
    unmuteWork = nil
    recentNotifyTimes = []
    // 未配信の押す/トグルは捨てる(解除後に送信が始まらないように)。離すは残す。
    pendingPresses = pendingPresses.filter { $0.kind == "up" }
    emitState("idle", "登録を解除しました")
  }

  // MARK: - 登録情報

  private func registeredUUID() -> UUID? {
    guard let s = UserDefaults.standard.string(forKey: Self.uuidKey) else { return nil }
    return UUID(uuidString: s)
  }

  private func loadRegistration() -> Registration? {
    let defaults = UserDefaults.standard
    guard let identifier = registeredUUID() else { return nil }
    guard let serviceString = defaults.string(forKey: Self.serviceKey),
          let charString = defaults.string(forKey: Self.charKey) else { return nil }
    // 保存値から直接CBUUIDを作らず、許可済みの組と文字列で照合する
    // (想定外の値なら登録として扱わない=購読もしない)。
    guard let pair = Self.pressPairs.first(where: { p in
      p.service.uuidString.uppercased() == serviceString.uppercased()
        && p.characteristic.uuidString.uppercased() == charString.uppercased()
    }) else { return nil }
    let holdCapable = defaults.bool(forKey: Self.holdCapableKey)
    let stored = defaults.string(forKey: Self.modeKey)
    let mode: String = holdCapable ? (stored == "toggle" ? "toggle" : "hold") : "toggle"
    return Registration(
      identifier: identifier,
      service: pair.service,
      characteristic: pair.characteristic,
      holdCapable: holdCapable,
      mode: mode,
      noCccd: defaults.bool(forKey: Self.noCccdKey)
    )
  }

  // MARK: - UUIDの補助

  // 押下サービスに対応する押下特性(FFE0→FFE1 / FFF0→FFF1)。それ以外は nil。
  private static func pressCharacteristic(forService service: CBUUID) -> CBUUID? {
    for pair in pressPairs where pair.service == service {
      return pair.characteristic
    }
    return nil
  }

  private static func pressService(forCharacteristic characteristic: CBUUID) -> CBUUID? {
    for pair in pressPairs where pair.characteristic == characteristic {
      return pair.service
    }
    return nil
  }

  // 特性が属するサービスのUUID。iOS 15以降のSDKでは service は弱参照(Optional)。
  private static func serviceUUID(of characteristic: CBCharacteristic) -> CBUUID? {
    let service: CBService? = characteristic.service
    return service?.uuid
  }

  private static func matches(_ characteristic: CBCharacteristic, service: CBUUID, characteristic expected: CBUUID) -> Bool {
    guard characteristic.uuid == expected else { return false }
    guard let owner = Self.serviceUUID(of: characteristic) else { return false }
    return owner == service
  }

  // 許可された押下の組(FFE0/FFE1・FFF0/FFF1)に属する特性か。
  private static func isPressPair(_ characteristic: CBCharacteristic) -> Bool {
    guard let owner = Self.serviceUUID(of: characteristic),
          let expected = Self.pressCharacteristic(forService: owner) else { return false }
    return characteristic.uuid == expected
  }

  // 押下通知を受けられる特性か(notify と indicate のどちらでもよい)。
  private static func canNotify(_ characteristic: CBCharacteristic) -> Bool {
    return characteristic.properties.contains(.notify) || characteristic.properties.contains(.indicate)
  }

  // 状態復元で引き継いだペリフェラルに、登録した押下特性(登録したサービスの下のもの)の
  // 購読が有効なまま残っているか(iOSは発見済みのサービス・特性・購読状態も復元する)。
  // 購読設定(CCCD)が無いボタンは isNotifying にならないため、ここでは引き継ぎ扱いにしない
  // (通常の準備手順で購読を要求し直し、猶予付きで ready にする)。
  private static func hasInheritedPressSubscription(_ p: CBPeripheral, reg: Registration) -> Bool {
    let services: [CBService] = p.services ?? []
    for service in services where service.uuid == reg.service {
      let characteristics: [CBCharacteristic] = service.characteristics ?? []
      for c in characteristics where c.uuid == reg.characteristic && c.isNotifying {
        return true
      }
    }
    return false
  }

  // 購読(通知の有効化)の失敗が「購読設定(CCCD)が無い」ことによるものか。
  // iOS は購読の書き込み先(CCCD)を探して見つからないと、ATTの Attribute Not Found を返す。
  private static func isMissingCccd(_ error: Error?) -> Bool {
    return (error as? CBATTError)?.code == .attributeNotFound
  }

  private static func displayName(_ raw: String?) -> String {
    // iTagは名前の後ろに空白が付いていることが多い。
    let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? defaultName : trimmed
  }

  private static func now() -> TimeInterval {
    // 端末のスリープ中も進み、かつ時刻合わせ(NITZ/NTP・手動変更)で巻き戻らない時計で測る。
    // スリープを挟んだ古い押下を「新しい」と誤認しないため、また壁時計(Date)だと時刻が
    // 巻き戻った瞬間に猶予・デバウンスの判定が狂い、「離す」や停止の押下が捨てられて
    // 送信が開いたまま残り得るため。比較する値はすべてこのプロセス内で測ったもの。
    // (Darwin の CLOCK_MONOTONIC はスリープ中も進む)
    return Double(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
  }

  private func candidateName(_ p: CBPeripheral) -> String {
    let fromPeripheral = Self.displayName(p.name)
    if fromPeripheral != Self.defaultName { return fromPeripheral }
    return Self.displayName(setupCandidates[p.identifier]?.name)
  }

  // MARK: - 接続維持

  private func ensureManager() {
    guard manager == nil else { return }
    // 復元識別子を付けておくと、アプリがメモリ回収で終了しても、接続イベントで
    // iOSがアプリをバックグラウンド起動して接続を引き継げる(業務利用の生命線)。
    manager = CBCentralManager(
      delegate: self,
      queue: .main,
      options: [CBCentralManagerOptionRestoreIdentifierKey: "jp.co.medident.miriseintercom.blebutton"]
    )
  }

  private func connectIfPossible() {
    guard let manager, manager.state == .poweredOn else { return }
    guard setupPromise == nil else { return }
    guard let reg = loadRegistration() else { return }
    if let p = peripheral, p.identifier == reg.identifier {
      if p.state == .connecting { return }
      if p.state == .connected {
        // 繋がっているのに購読が完了していない(準備の途中で止まった)なら、準備をやり直す。
        if !ready && readyTimeoutWork == nil {
          p.delegate = self
          connected = true
          beginReadySequence(p, reg: reg)
        }
        return
      }
    }
    let found = manager.retrievePeripherals(withIdentifiers: [reg.identifier])
    guard let target = found.first else {
      // 端末側のBluetoothデータベースに登録情報が無い(機種変更・ネットワーク設定
      // リセット後など)。あきらめずに次の start()(前面復帰のたび)で再試行する。
      emitState("error", "登録したボタンを端末から読み出せませんでした。次にアプリを開いた時に再試行します。直らない場合は「登録を解除」して再登録してください")
      return
    }
    peripheral = target
    target.delegate = self
    emitState("connecting", "登録済みボタンへ接続中...(つながらない時はボタンを1回押してください)")
    // iOSの接続要求は期限なしで維持される: ボタンが眠っていても、
    // 次に電波を出した瞬間に自動接続される。
    manager.connect(target, options: nil)
  }

  // 接続後: 登録した押下サービス+警報サービスだけを探し、押下特性を購読する。
  // 一定時間内に購読が有効にならなければ、接続を切ってやり直す(中途半端な状態で放置しない)。
  private func beginReadySequence(_ p: CBPeripheral, reg: Registration) {
    ready = false
    readyTimeoutWork?.cancel()
    let work = DispatchWorkItem { [weak self, weak p] in
      guard let self, let p else { return }
      self.readyTimeoutWork = nil
      guard self.setupPromise == nil, !self.ready, p === self.peripheral else { return }
      self.dropLinkForRetry(p, "ボタンの準備が完了しませんでした。接続し直します", delay: 5)
    }
    readyTimeoutWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    p.discoverServices([reg.service, Self.linkLossService, Self.immediateAlertService])
  }

  // grace=false: 状態復元で購読(通知の有効化)をそのまま引き継いだ場合。購読し直して
  // いないので「現在値」は送られてこない。猶予を付けると、アプリを起こした押下そのものを
  // 捨ててしまう。
  private func markReady(_ p: CBPeripheral, grace: Bool = true) {
    readyTimeoutWork?.cancel()
    readyTimeoutWork = nil
    connected = true
    guard !ready else { return }
    ready = true
    // 一部機種は購読直後に「現在値」を勝手に送ってくる。これを押下と誤認しない。
    subscribeGraceUntil = grace ? Self.now() + Self.subscribeGrace : 0
    let name = UserDefaults.standard.string(forKey: Self.nameKey) ?? Self.displayName(p.name)
    emitState("connected", "接続しました: \(name)")
  }

  // 準備に失敗した接続をいったん切り、少し待ってから再接続させる
  // (即時に繰り返すと失敗ループでメインキューと電池を消耗するため遅延を付ける)。
  private func dropLinkForRetry(_ p: CBPeripheral, _ detail: String, delay: TimeInterval) {
    emitState("error", detail)
    resetLinkState()
    nextReconnectDelay = delay
    manager?.cancelPeripheralConnection(p)
  }

  private func scheduleReconnect(_ p: CBPeripheral, after delay: TimeInterval) {
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.reconnectBackoffWork = nil
      guard let manager = self.manager, manager.state == .poweredOn else { return }
      guard self.setupPromise == nil, let reg = self.loadRegistration(), p.identifier == reg.identifier else { return }
      manager.connect(p, options: nil)
    }
    reconnectBackoffWork?.cancel()
    reconnectBackoffWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  // リンクが失われた/使えなくなった時の後始末。押している最中(送信中かもしれない)なら
  // 必ず「離す」を合成して送る(ホットマイク防止)。
  private func resetLinkState() {
    releaseIfNeeded()
    connected = false
    ready = false
    readyTimeoutWork?.cancel()
    readyTimeoutWork = nil
    recentNotifyTimes = []
  }

  private func disconnectCurrent() {
    cancelSetupTimers()
    reconnectBackoffWork?.cancel()
    reconnectBackoffWork = nil
    nextReconnectDelay = 0
    if let manager {
      if manager.isScanning { manager.stopScan() }
      if let p = peripheral { manager.cancelPeripheralConnection(p) }
    }
    peripheral = nil
    resetLinkState()
    resetSetupProbe()
    setupQueue = []
  }

  // MARK: - 押下の処理(通常運用)

  private func handlePress(byte: UInt8, reg: Registration, now: TimeInterval) {
    // 異常連打で一時停止中。
    if now < mutedUntil { return }
    // 購読直後の初期値・登録確定直後の押下の続きは押下ではない。
    // ただし「押している間だけ」で送信中の「離す」は止める方向なので、猶予中でも必ず通す
    // (猶予の判定の取り違えで離すを捨てると、送信が開いたまま残るため)。
    let isRelease = reg.mode == "hold" && byte == 0 && isDown
    if !isRelease && (now <= subscribeGraceUntil || now < pressQuietUntil) { return }

    // 異常連打の検出(押しっぱなしで通知が出続ける・チャタリング・故障)。
    recentNotifyTimes.append(now)
    recentNotifyTimes.removeAll { now - $0 > Self.rateWindow }
    if recentNotifyTimes.count > Self.rateLimitCount {
      muteButton(now)
      return
    }

    // 先頭1バイト: 0x00=離した / それ以外=押した。
    let pressed = byte != 0
    if reg.mode == "hold" {
      // 押している間だけ送信。押す/離すの「変化」だけを送る(重複は無視)。
      if pressed {
        if isDown { return }
        isDown = true
        deliverPress("down")
      } else {
        if !isDown { return }
        isDown = false
        deliverPress("up")
      }
      return
    }
    // トグル: 押した瞬間だけを数える(離した通知は無視)。連続フレームはデバウンスで1回に丸める。
    guard pressed else { return }
    guard now - lastToggleAt > Self.toggleDebounce else { return }
    lastToggleAt = now
    deliverPress("toggle")
  }

  private func muteButton(_ now: TimeInterval) {
    mutedUntil = now + Self.muteDuration
    recentNotifyTimes = []
    // 送信中かもしれないので必ず止める(トグル方式でも「離す」で停止を促す)。
    releaseIfNeeded()
    // 文言はAndroid版・利用者マニュアルと揃える(マニュアルのトラブル表で引用しているため)。
    emitState("error", "ボタンの信号が多すぎるため、30秒間ボタンを止めました(押しっぱなし・故障の可能性)")
    unmuteWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.unmuteWork = nil
      if self.ready {
        self.emitState("connected", "ボタンを再び使えるようになりました")
      }
    }
    unmuteWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.muteDuration, execute: work)
  }

  // 送信中かもしれない状態なら「離す」を送る。ホールドで押している最中はもちろん、
  // トグルでONにした可能性がある場合も送る(ボタンが使えなくなった後に、
  // 誰も止められない送信が残る事故を防ぐ。送信していなければJS側で何も起きない)。
  private func releaseIfNeeded() {
    guard isDown || pressSinceRelease else { return }
    isDown = false
    deliverPress("up")
  }

  private func deliverPress(_ kind: String) {
    pressSinceRelease = (kind != "up")
    // バックグラウンド(ロック中)でも、JSがPushToTalkを呼び終えるまでiOSに
    // アプリを動かし続けてもらう(BLEイベントで起こされた直後は猶予が短いため)。
    holdBackgroundTime()
    if observing {
      module?.emit("onPress", ["kind": kind])
    } else {
      // JSがまだ購読していない(バックグラウンド起動直後など)。
      // 破棄せず保持し、購読開始時に再送する。
      queuePendingPress(kind, at: Self.now())
    }
  }

  private func queuePendingPress(_ kind: String, at time: TimeInterval) {
    // 再送期限を過ぎた押す/トグルは先に捨てる(離すは残す)。
    pendingPresses.removeAll { $0.kind != "up" && time - $0.at > Self.replayWindow }
    // 未配信の「押す→離す」「トグル→トグル」は打ち消し合うので両方捨てる
    // (JSに一瞬だけ送信させる無駄を省く)。
    // 未配信の「トグル→離す」はトグルだけ捨てて離すは残す(以前に届けたトグルで
    // 送信中かもしれないので、止める指示は必ず届ける)。
    if let last = pendingPresses.last {
      if last.kind == "down" && kind == "up" {
        pendingPresses.removeLast()
        return
      }
      if last.kind == "toggle" && kind == "toggle" {
        pendingPresses.removeLast()
        return
      }
      if last.kind == "toggle" && kind == "up" {
        pendingPresses.removeLast()
      }
    }
    pendingPresses.append((kind: kind, at: time))
    if pendingPresses.count > 8 {
      pendingPresses.removeFirst(pendingPresses.count - 8)
    }
  }

  private func holdBackgroundTime() {
    if backgroundTask == .invalid {
      backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "BleButtonPress") { [weak self] in
        // 期限切れ: iOSの指示どおり直ちに終了する(終了しないとアプリが強制終了される)。
        self?.endBackgroundTime()
      }
    }
    // 押下のたびに終了予定を延長する。
    backgroundEndWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.endBackgroundTime()
    }
    backgroundEndWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.backgroundHoldSeconds, execute: work)
  }

  private func endBackgroundTime() {
    backgroundEndWork?.cancel()
    backgroundEndWork = nil
    if backgroundTask != .invalid {
      let task = backgroundTask
      backgroundTask = .invalid
      UIApplication.shared.endBackgroundTask(task)
    }
  }

  // MARK: - 初期設定

  private func cancelSetupTimers() {
    scanDeadlineWork?.cancel()
    scanDeadlineWork = nil
    connectTimeoutWork?.cancel()
    connectTimeoutWork = nil
    confirmTimeoutWork?.cancel()
    confirmTimeoutWork = nil
    masterTimeoutWork?.cancel()
    masterTimeoutWork = nil
  }

  private func resetSetupProbe() {
    setupAwaitingPress = false
    setupPendingPressServices = 0
    setupSubscribing = []
    setupSubscribed = []
    setupNoCccd = []
    setupProbes = [:]
    setupFinalizeWork?.cancel()
    setupFinalizeWork = nil
  }

  private func beginScan() {
    guard let manager, manager.state == .poweredOn, setupPromise != nil else { return }
    guard scanDeadlineWork == nil, !manager.isScanning else { return }
    setupCandidates = [:]
    setupQueue = []
    // サービス指定なしの全体スキャン(前面のみ)。名前だけで判別できるiTag/PTTボタンも
    // 拾うため、OS側ではフィルターせず didDiscover で候補を絞る。
    // 重複を許可する: 既定では同じ機器の広告が1回にまとめられ、検索中にボタンを
    // スマホへ近づけても最良の電波強度が更新されず「遠すぎる」で失敗するため
    // (8秒間の前面検索だけなので電池への影響は小さい)。
    manager.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    let work = DispatchWorkItem { [weak self] in self?.finishScanWindow() }
    scanDeadlineWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
  }

  // スキャン終了: 近い順(電波強度優先→ボタンらしさ)に接続試行キューを組み、
  // 先頭から1台ずつ「接続→ボタン通知あり→実押下2回で確定」を試す。
  private func finishScanWindow() {
    guard setupPromise != nil else { return }
    scanDeadlineWork = nil
    manager?.stopScan()
    let ranked = setupCandidates.values
      .filter { $0.rssi >= Self.setupMinRSSI && $0.rssi != 127 } // 127=電波強度不明
      .sorted { a, b in
        if a.rssi != b.rssi { return a.rssi > b.rssi }
        return a.score > b.score
      }
      .prefix(4)
      .map { $0.peripheral }
    setupQueue = Array(ranked)
    if setupQueue.isEmpty {
      if setupCandidates.isEmpty {
        failSetup("E_NOT_FOUND", "ボタンが見つかりませんでした。ボタンを1回押した直後に、もう一度お試しください")
      } else {
        failSetup("E_TOO_FAR", "近くにボタンが見つかりませんでした。ボタンをスマホにくっつけて、もう一度お試しください")
      }
      return
    }
    tryNextSetupCandidate()
  }

  // キューの先頭候補に接続を試す。接続失敗・押下確認失敗のたびに次の候補へ進む。
  private func tryNextSetupCandidate() {
    guard setupPromise != nil else { return }
    confirmTimeoutWork?.cancel()
    confirmTimeoutWork = nil
    connectTimeoutWork?.cancel()
    connectTimeoutWork = nil
    resetSetupProbe()
    // 直前の候補を切り離す(登録済みの機器であっても設定中は一度切る。
    // 失敗した場合は failSetup → startIfRegistered で繋ぎ直す)。
    if let p = peripheral {
      manager?.cancelPeripheralConnection(p)
    }
    peripheral = nil
    guard !setupQueue.isEmpty else {
      if setupNoCccdUnanswered {
        // 購読なしで待ったが押下が届かなかった: iPhoneでは押下を受け取れない機種の可能性が高い。
        failSetup("E_CONFIRM_TIMEOUT", "ボタンの押下が届きませんでした。ボタンをスマホの近くで短く2回押して、もう一度お試しください(何度試しても届かない場合、お使いのボタンはiPhoneでは使えない機種の可能性があります)")
      } else {
        failSetup("E_CONFIRM_TIMEOUT", "ボタンを確定できませんでした。ボタンをスマホの近くで短く2回押して、もう一度お試しください")
      }
      return
    }
    let next = setupQueue.removeFirst()
    connectForSetup(next)
  }

  private func connectForSetup(_ target: CBPeripheral) {
    guard let manager else { return }
    if manager.isScanning { manager.stopScan() }
    peripheral = target
    target.delegate = self
    emitState("connecting", "接続中: \(candidateName(target))(反応が無い時はボタンを1回押してください)")
    manager.connect(target, options: nil)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.setupPromise != nil else { return }
      self.connectTimeoutWork = nil
      // この候補は接続できなかった。次の候補へ。
      self.tryNextSetupCandidate()
    }
    connectTimeoutWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
  }

  private func scheduleConfirmTimeout(_ seconds: TimeInterval) {
    confirmTimeoutWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.setupPromise != nil else { return }
      self.confirmTimeoutWork = nil
      // 押下を確認済みで確定を見届け中なら、そちらを優先する。
      if self.setupFinalizeWork != nil { return }
      if !self.setupNoCccd.isEmpty && self.setupProbes.isEmpty {
        self.setupNoCccdUnanswered = true
        self.emitState("debug", "購読なしで待ちましたが、押下が届きませんでした")
      }
      // この候補は購読できない/押下が来なかった(=別の機器の可能性)。次の候補へ。
      self.tryNextSetupCandidate()
    }
    confirmTimeoutWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
  }

  // 押下特性の購読が有効になった後にだけ呼ばれる。ここから実際の押下(2回)を待つ。
  private func beginConfirmPhase(_ p: CBPeripheral, timeout: TimeInterval = 20) {
    setupAwaitingPress = true
    emitState("confirming", "「\(candidateName(p))」に接続。ボタンを短く2回押してください")
    scheduleConfirmTimeout(timeout)
  }

  // 登録確認中の通知。購読が確認できた押下特性(FFE1/FFF1)への通知だけを数える。
  private func handleSetupNotification(_ p: CBPeripheral, _ characteristic: CBCharacteristic, data: Data, now: TimeInterval) {
    let isCandidate = setupSubscribed.contains(characteristic.uuid) && Self.isPressPair(characteristic)
    let inGrace = now <= subscribeGraceUntil
    // 調査用: 設定中は「どの特性に・何のデータが来たか」を画面ログに出す。
    let hex = data.map { String(format: "%02x", $0) }.joined()
    let serviceText = Self.serviceUUID(of: characteristic)?.uuidString ?? "?"
    emitState("debug", "通知受信 \(serviceText)/\(characteristic.uuid.uuidString)=\(hex.isEmpty ? "空" : hex) [\(isCandidate ? "押下候補" : "対象外")]\(inGrace ? "(初期値)" : "")")

    guard setupAwaitingPress, isCandidate, !inGrace, let byte = data.first else { return }
    let noCccd = setupNoCccd.contains(characteristic.uuid)
    var probe = setupProbes[characteristic.uuid] ?? SetupProbe()
    if noCccd, byte != 0, setupFinalizeWork == nil, probe.nonZeroCount > 0,
       now - probe.lastNonZeroAt > Self.noCccdMaxGap {
      // 前の押下から間が空きすぎた: 人の「2回押し」ではない可能性があるので、この通知から数え直す。
      probe = SetupProbe()
    }
    probe.count += 1
    if probe.firstAt == 0 { probe.firstAt = now }
    if byte != 0 {
      probe.sawNonZero = true
      probe.nonZeroCount += 1
      if probe.firstNonZeroAt == 0 { probe.firstNonZeroAt = now }
      probe.lastNonZeroAt = now
    } else if probe.sawNonZero {
      // 押した(非0)の後に離した(0x00)が来た=押している間だけ送信できるボタン。
      probe.holdCapable = true
    }
    setupProbes[characteristic.uuid] = probe

    if probe.count == 1 && setupFinalizeWork == nil {
      // 進み具合を見せる(1回目が届いたことが分かれば、もう1回押してもらえる)。
      emitState("confirming", "1回目を確認しました。もう1回押してください")
    }
    let enough: Bool
    if noCccd {
      // 購読設定が無い候補: 押した(非0)通知が、0.3秒以上・3秒以内の間隔で2回。
      enough = probe.nonZeroCount >= 2 && probe.lastNonZeroAt - probe.firstNonZeroAt >= Self.confirmMinGap
    } else {
      enough = probe.count >= 2 && now - probe.firstAt >= Self.confirmMinGap
    }
    guard setupFinalizeWork == nil, enough else { return }
    // 条件成立。直後の「離す(0x00)」や通知の出続け(センサー等)を見届けてから確定する。
    let charUUID = characteristic.uuid
    let work = DispatchWorkItem { [weak self, weak p] in
      guard let self, let p else { return }
      self.setupFinalizeWork = nil
      self.finalizeSetup(p, charUUID: charUUID)
    }
    setupFinalizeWork = work
    let settle = noCccd ? Self.noCccdConfirmSettle : Self.confirmSettle
    DispatchQueue.main.asyncAfter(deadline: .now() + settle, execute: work)
    emitState("confirming", noCccd
      ? "ボタンの押下を確認しました。登録しています...(3秒ほど、ボタンを押さずにお待ちください)"
      : "ボタンの押下を確認しました。登録しています...")
  }

  private func finalizeSetup(_ p: CBPeripheral, charUUID: CBUUID) {
    guard setupPromise != nil, setupAwaitingPress, p === peripheral else { return }
    guard let probe = setupProbes[charUUID], let pressServiceUUID = Self.pressService(forCharacteristic: charUUID) else {
      tryNextSetupCandidate()
      return
    }
    if probe.count > Self.setupFloodLimit {
      // 人の押下では出ない頻度で通知が来た=ボタンではない機器(センサー等)の可能性。
      emitState("debug", "通知が多すぎるため対象外にしました(\(probe.count)回)")
      tryNextSetupCandidate()
      return
    }
    if setupNoCccd.contains(charUUID) && probe.nonZeroCount > 2 {
      // 購読設定が無い候補で、確認後の見届け中にも押下(非0)が届いた: 勝手に通知を出し
      // 続ける機器の可能性があるため登録しない(本物のボタンなら、2回押して待てば通る)。
      emitState("debug", "購読設定が無い候補で押下が続いたため対象外にしました(\(probe.nonZeroCount)回)")
      tryNextSetupCandidate()
      return
    }
    confirmRegistration(
      p,
      service: pressServiceUUID,
      characteristic: charUUID,
      holdCapable: probe.holdCapable,
      noCccd: setupNoCccd.contains(charUUID)
    )
  }

  private func confirmRegistration(_ p: CBPeripheral, service: CBUUID, characteristic: CBUUID, holdCapable: Bool, noCccd: Bool) {
    let name = candidateName(p)
    let defaults = UserDefaults.standard
    defaults.set(p.identifier.uuidString, forKey: Self.uuidKey)
    defaults.set(name, forKey: Self.nameKey)
    defaults.set(service.uuidString, forKey: Self.serviceKey)
    defaults.set(characteristic.uuidString, forKey: Self.charKey)
    defaults.set(holdCapable, forKey: Self.holdCapableKey)
    defaults.set(holdCapable ? "hold" : "toggle", forKey: Self.modeKey)
    defaults.set(noCccd, forKey: Self.noCccdKey)

    // 確定しなかった方の購読(FFE1とFFF1の両方を持つ機器の場合)は解除する。
    for s in p.services ?? [] {
      for c in s.characteristics ?? [] where c.isNotifying && !(s.uuid == service && c.uuid == characteristic) {
        p.setNotifyValue(false, for: c)
      }
    }

    let promise = setupPromise
    setupPromise = nil
    cancelSetupTimers()
    resetSetupProbe()
    setupQueue = []
    setupCandidates = [:]

    // 新しい登録として押下状態をまっさらにする。
    let now = Self.now()
    isDown = false
    pressSinceRelease = false
    mutedUntil = 0
    unmuteWork?.cancel()
    unmuteWork = nil
    recentNotifyTimes = []
    // 確定に使った押下の続き(3回目の押下や離す)が、直後に送信を始めないようにする。
    lastToggleAt = now
    pressQuietUntil = now + Self.postSetupQuiet
    reconnectBackoffWork?.cancel()
    reconnectBackoffWork = nil
    nextReconnectDelay = 0
    // 押下通知が実際に届いた=この特性の購読は有効。
    connected = true
    ready = true

    let result: [String: Any] = ["name": name, "holdCapable": holdCapable, "noCccd": noCccd]
    promise?.resolve(result)
    emitState("connected", "登録しました: \(name)(\(holdCapable ? "押している間だけ送信" : "押すたびに送信ON/OFF"))")
  }

  private func failSetup(_ code: String, _ message: String) {
    cancelSetupTimers()
    resetSetupProbe()
    setupQueue = []
    setupCandidates = [:]
    if let manager, manager.isScanning { manager.stopScan() }
    // 設定用に接続した候補は必ず切り離す(登録済みの機器だった場合も、
    // 下の startIfRegistered で改めて「登録した組だけ」を購読し直す)。
    if let p = peripheral {
      manager?.cancelPeripheralConnection(p)
    }
    peripheral = nil
    connected = false
    ready = false
    let promise = setupPromise
    setupPromise = nil
    promise?.reject(code, message)
    emitState(registeredUUID() != nil ? "disconnected" : "idle", message)
    // 既存の登録があれば接続維持を復旧する(失敗したまま放置しない)。
    startIfRegistered()
  }

  private func emitState(_ state: String, _ detail: String) {
    var payload: [String: Any] = ["state": state, "detail": detail]
    if let name = UserDefaults.standard.string(forKey: Self.nameKey) {
      payload["name"] = name
    }
    module?.emit("onStateChanged", payload)
  }

  // 紛失防止タグの警報を止める(Alert Level に 0x00 = 鳴らさない)。
  // 応答あり書き込みが使えればそれを使い、結果は didWriteValueFor で記録する。
  private func silenceAlert(_ p: CBPeripheral, _ c: CBCharacteristic, service: CBUUID) {
    let off = Data([UInt8(0x00)])
    let label = "\(service.uuidString)/\(c.uuid.uuidString)"
    if c.properties.contains(.write) {
      p.writeValue(off, for: c, type: .withResponse)
    } else if c.properties.contains(.writeWithoutResponse) {
      p.writeValue(off, for: c, type: .withoutResponse)
      emitState("debug", "警報停止を送信(応答なし) \(label)")
    } else {
      emitState("debug", "警報停止できません(書き込み不可) \(label)")
    }
  }

  // MARK: - CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      // 状態復元で引き継いだ「登録外」の接続は切る(前プロセスの設定候補が繋がったまま残らないように)。
      for stray in restoredStrays {
        central.cancelPeripheralConnection(stray)
      }
      restoredStrays = []
      if setupPromise != nil {
        beginScan()
        emitState("scanning", "近くのボタンを検索中...(ボタンを1回押すと見つかりやすくなります)")
      } else {
        // 状態復元直後の再購読(復元時はまだコマンドを受け付けないため、ここで行う)。
        if needsRediscovery, let p = peripheral, p.state == .connected,
           let reg = loadRegistration(), p.identifier == reg.identifier {
          p.delegate = self
          connected = true
          if Self.hasInheritedPressSubscription(p, reg: reg) {
            // 前のプロセスで有効にした押下特性の購読が、そのまま引き継がれている
            // (登録した機器・登録した特性に限る)。探し直しを待たずに使える状態にする
            // (アプリを起こした押下を「準備中」として捨てないため。購読し直していないので
            // 現在値は来ず、猶予も付けない)。
            markReady(p, grace: false)
            // 警報(紛失防止の鳴動)を止める書き込みのため、サービスの発見は行う
            // (ready は維持され、押下特性は isNotifying を確認するだけになる)。
            p.discoverServices([reg.service, Self.linkLossService, Self.immediateAlertService])
          } else {
            beginReadySequence(p, reg: reg)
          }
        }
        needsRediscovery = false
        connectIfPossible()
      }
    case .poweredOff:
      // 電源オフでは didDisconnect が呼ばれないため、ここで必ず「離す」を送り状態を戻す。
      resetLinkState()
      if setupPromise != nil {
        failSetup("E_POWERED_OFF", "Bluetoothがオフです。コントロールセンターでオンにしてください")
      } else if registeredUUID() != nil {
        emitState("error", "Bluetoothがオフになっています")
      }
    case .unauthorized:
      resetLinkState()
      if setupPromise != nil {
        failSetup("E_UNAUTHORIZED", "Bluetoothの使用が許可されていません。設定アプリで許可してください")
      } else {
        emitState("error", "Bluetooth権限がありません(設定→アプリで許可)")
      }
    case .resetting:
      // Bluetoothスタックの再起動中。接続は失われるので押下状態を閉じる(poweredOnで再接続)。
      resetLinkState()
    case .unsupported:
      if setupPromise != nil {
        failSetup("E_UNSUPPORTED", "この端末はBluetooth LEに対応していません(シミュレーターでは使えません)")
      }
    default:
      break
    }
  }

  // アプリがバックグラウンドで再起動された場合の接続復元。
  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    // 前プロセスの設定スキャンが残っていても、その文脈(Promise等)は失われている
    // ので必ず止める(止めないと無期限スキャンで電池を消耗する)。
    if central.isScanning { central.stopScan() }
    guard let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] else { return }
    let reg = loadRegistration()
    for p in restored {
      if let reg, p.identifier == reg.identifier {
        peripheral = p
        p.delegate = self
        if p.state == .connected {
          connected = true
          // この時点ではまだコマンドを受け付けない(poweredOn前)ため、
          // 再購読は didUpdateState の .poweredOn で行う。
          needsRediscovery = true
        }
      } else {
        restoredStrays.append(p)
      }
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard setupPromise != nil, setupQueue.isEmpty, !setupAwaitingPress else { return }
    var advertised: [CBUUID] = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data] {
      advertised.append(contentsOf: serviceData.keys)
    }
    // キーボード型(HID)・センサー類は候補にしない。
    if advertised.contains(where: { Self.excludedServices.contains($0) }) { return }
    let rawName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
    let trimmedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
    let lower = trimmedName.lowercased()
    // 候補は「FFE0/FFF0を広告している」か「名前が iTAG / PTT で始まる」機器だけ
    // (無関係な機器に接続して誤登録する余地を減らす)。
    let advertisesPressService = advertised.contains(where: { Self.pressServiceUUIDs.contains($0) })
    let looksLikeButton = lower.hasPrefix("itag") || lower.hasPrefix("ptt")
    guard advertisesPressService || looksLikeButton else { return }
    let score = advertisesPressService ? 2 : 1
    let rssi = RSSI.intValue
    // 同一機器は最良RSSIで更新(重複を許可した検索なので、広告は何度も届く)。
    // 127 は「電波強度不明」。最大値の比較で既知の値を上書きしないよう別扱いにする
    // (上書きすると候補から外れ、近くにあるのに「遠すぎる」で失敗するため)。
    if let existing = setupCandidates[peripheral.identifier] {
      let bestRSSI: Int
      if rssi == 127 {
        bestRSSI = existing.rssi
      } else if existing.rssi == 127 {
        bestRSSI = rssi
      } else {
        bestRSSI = max(rssi, existing.rssi)
      }
      if bestRSSI != existing.rssi || score > existing.score {
        setupCandidates[peripheral.identifier] = (
          peripheral: peripheral,
          rssi: bestRSSI,
          score: max(score, existing.score),
          name: trimmedName.isEmpty ? existing.name : trimmedName
        )
      }
    } else {
      setupCandidates[peripheral.identifier] = (peripheral: peripheral, rssi: rssi, score: score, name: trimmedName)
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    if setupPromise != nil {
      // 設定中: 自分が選んだ候補だけを相手にする(同時期に他の接続が完了しても無視)。
      guard peripheral === self.peripheral else {
        central.cancelPeripheralConnection(peripheral)
        return
      }
      connectTimeoutWork?.cancel()
      connectTimeoutWork = nil
      // まだ登録は確定しない: サービス発見→押下特性の購読→実押下2回の確認へ。
      // 購読まで進めない機器はこの期限で次の候補へ。
      scheduleConfirmTimeout(10)
      emitState("connecting", "接続しました。ボタンを確認中...")
      // 設定中はHID/センサー判定と調査ログのため、全サービスを列挙する。
      peripheral.discoverServices(nil)
      return
    }
    // 通常運用: 登録済みペリフェラル以外は繋がっても採用しない
    // (解除済みの旧タグが送信を握るのを防ぐ)。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier else {
      central.cancelPeripheralConnection(peripheral)
      return
    }
    reconnectBackoffWork?.cancel()
    reconnectBackoffWork = nil
    self.peripheral = peripheral
    peripheral.delegate = self
    connected = true
    // "connected" は購読が有効になってから(markReady)送る。それまではまだ押せない。
    emitState("connecting", "接続しました。ボタンを準備中...")
    beginReadySequence(peripheral, reg: reg)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    if setupPromise != nil {
      guard peripheral === self.peripheral else { return }
      // この候補は接続できなかった。次の候補へ(全滅したらtryNextが失敗させる)。
      tryNextSetupCandidate()
      return
    }
    // 登録済みペリフェラル以外の失敗は放置(再接続しない)。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier else { return }
    resetLinkState()
    emitState("disconnected", "接続失敗。再接続を待機します")
    // 少し間を置いてから期限なしの再接続要求を出し直す
    // (即時に再要求し続けると失敗ループでメインキューと電池を消耗するため)。
    self.peripheral = peripheral
    peripheral.delegate = self
    scheduleReconnect(peripheral, after: 2)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    if setupPromise != nil {
      // 設定中の候補が切れた(眠った・電源が切れた等)。押下は来ないので次の候補へ。
      if peripheral === self.peripheral {
        emitState("debug", "設定中の候補が切断されました[\(candidateName(peripheral))] err=\(error?.localizedDescription ?? "なし")")
        tryNextSetupCandidate()
      }
      return
    }
    // 登録済みペリフェラルのみ扱う(解除済み・設定候補の切断は無視)。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier else { return }
    // 押している最中に切れたら、必ず「離す」を合成して送信を止める(ホットマイク防止)。
    resetLinkState()
    self.peripheral = peripheral
    peripheral.delegate = self
    let delay = nextReconnectDelay
    nextReconnectDelay = 0
    if delay > 0 {
      emitState("disconnected", "準備に失敗したため、\(Int(delay))秒後に再接続します")
      scheduleReconnect(peripheral, after: delay)
    } else {
      emitState("disconnected", "切断されました。再接続を待機します")
      // 即再接続要求(期限なしで維持されるので、ボタンが眠っていても次の押下で自動復帰)。
      central.connect(peripheral, options: nil)
    }
  }

  // MARK: - CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    let services: [CBService] = peripheral.services ?? []
    if setupPromise != nil {
      guard peripheral === self.peripheral else { return }
      if let error {
        emitState("debug", "サービス取得失敗[\(candidateName(peripheral))]: \(error.localizedDescription)")
        tryNextSetupCandidate()
        return
      }
      // 調査用: この機器が持つサービスを画面ログに出す。
      let list = services.map { $0.uuid.uuidString }.joined(separator: ", ")
      emitState("debug", "サービス[\(candidateName(peripheral))]: \(list.isEmpty ? "なし" : list)")
      if services.contains(where: { Self.excludedServices.contains($0.uuid) }) {
        emitState("debug", "HID/センサー機器のため対象外にしました")
        tryNextSetupCandidate()
        return
      }
      var pressServices = 0
      for service in services {
        if let charUUID = Self.pressCharacteristic(forService: service.uuid) {
          pressServices += 1
          peripheral.discoverCharacteristics([charUUID], for: service)
        } else if service.uuid == Self.linkLossService || service.uuid == Self.immediateAlertService {
          peripheral.discoverCharacteristics([Self.alertLevelChar], for: service)
        }
      }
      setupPendingPressServices = pressServices
      if pressServices == 0 {
        // この候補にはボタン用のサービス(FFE0/FFF0)が無い=対応ボタンではない。次の候補へ。
        emitState("debug", "ボタン用サービス(FFE0/FFF0)が無いため対象外にしました")
        tryNextSetupCandidate()
      }
      return
    }

    // 通常運用: 登録した組だけを扱う。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier, peripheral === self.peripheral else { return }
    if let error {
      dropLinkForRetry(peripheral, "ボタンの情報を読み取れませんでした(\(error.localizedDescription))。接続し直します", delay: 5)
      return
    }
    var foundPressService = false
    for service in services {
      if service.uuid == reg.service {
        foundPressService = true
        peripheral.discoverCharacteristics([reg.characteristic], for: service)
      } else if service.uuid == Self.linkLossService || service.uuid == Self.immediateAlertService {
        peripheral.discoverCharacteristics([Self.alertLevelChar], for: service)
      }
    }
    if !foundPressService {
      dropLinkForRetry(peripheral, "登録したボタンの通知サービスが見つかりません。接続し直します(直らない場合は再登録してください)", delay: 10)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard peripheral === self.peripheral else { return }
    let characteristics: [CBCharacteristic] = service.characteristics ?? []

    // 警報(紛失防止の鳴動)の停止は、設定中・通常運用のどちらでも接続のたびに行う。
    if service.uuid == Self.linkLossService || service.uuid == Self.immediateAlertService {
      for c in characteristics where c.uuid == Self.alertLevelChar {
        silenceAlert(peripheral, c, service: service.uuid)
      }
      return
    }

    if setupPromise != nil {
      guard let expected = Self.pressCharacteristic(forService: service.uuid) else { return }
      if error == nil {
        for c in characteristics where c.uuid == expected && Self.canNotify(c) {
          setupSubscribing.insert(c.uuid)
          peripheral.setNotifyValue(true, for: c)
        }
      }
      setupPendingPressServices -= 1
      if setupPendingPressServices <= 0 && setupSubscribing.isEmpty && setupSubscribed.isEmpty {
        // 押下特性(FFE1/FFF1)が無い、または通知できない=対応ボタンではない。次の候補へ。
        emitState("debug", "ボタン用の通知(FFE1/FFF1)が無いため対象外にしました")
        tryNextSetupCandidate()
      }
      return
    }

    // 通常運用: 登録した押下特性だけを購読する(推測で他の特性は購読しない)。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier else { return }
    guard service.uuid == reg.service else { return }
    guard error == nil,
          let c = characteristics.first(where: { $0.uuid == reg.characteristic && Self.canNotify($0) }) else {
      dropLinkForRetry(peripheral, "登録したボタンの通知が見つかりません。接続し直します(直らない場合は再登録してください)", delay: 10)
      return
    }
    if c.isNotifying {
      // 状態復元などで、購読が有効なまま引き継がれている。
      markReady(peripheral)
    } else {
      // 購読設定(CCCD)が無いボタンでも、登録時と同じく購読を要求する(iOSは購読を要求した
      // 特性の通知だけをアプリへ渡す可能性があるため)。属性なしで失敗した時点で ready にする。
      // 有効になったかは didUpdateNotificationStateFor で確認してから ready にする。
      peripheral.setNotifyValue(true, for: c)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
    guard peripheral === self.peripheral else { return }
    if setupPromise != nil {
      guard setupSubscribing.contains(characteristic.uuid), Self.isPressPair(characteristic) else { return }
      setupSubscribing.remove(characteristic.uuid)
      if error == nil && characteristic.isNotifying {
        setupSubscribed.insert(characteristic.uuid)
        // 購読直後に送られる「現在値」は押下として数えない。
        subscribeGraceUntil = Self.now() + Self.setupSubscribeGrace
        if !setupAwaitingPress {
          beginConfirmPhase(peripheral)
        }
      } else if Self.isMissingCccd(error) && characteristic.properties.contains(.notify) {
        // 購読設定(CCCD)が無い安価なiTag: 購読しなくても押下を通知してくる機種がある。
        // 購読なしで押下を待つ(実際の2回押しが届いた時だけ登録するので、届かない機種は
        // これまでどおり登録されない)。
        emitState("debug", "購読設定が無い機種です。購読なしで押下を待ちます(\(characteristic.uuid.uuidString) props=\(characteristic.properties.rawValue))")
        setupSubscribed.insert(characteristic.uuid)
        setupNoCccd.insert(characteristic.uuid)
        subscribeGraceUntil = Self.now() + Self.setupSubscribeGrace
        // 調査用: 実際にどんな記述子を持っているかを診断ログに出す(CCCD=2902 が無いことの確認)。
        peripheral.discoverDescriptors(for: characteristic)
        if !setupAwaitingPress {
          beginConfirmPhase(peripheral, timeout: Self.noCccdConfirmTimeout)
        }
      } else {
        emitState("debug", "通知の購読に失敗 \(characteristic.uuid.uuidString): \(error?.localizedDescription ?? "不明")")
        if setupSubscribing.isEmpty && setupSubscribed.isEmpty && setupPendingPressServices <= 0 {
          tryNextSetupCandidate()
        }
      }
      return
    }

    // 通常運用: 登録した組の購読結果だけを見る(登録確定時に解除した別の特性などは無視)。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier else { return }
    guard Self.matches(characteristic, service: reg.service, characteristic: reg.characteristic) else { return }
    if reg.noCccd && Self.isMissingCccd(error) && characteristic.properties.contains(.notify) {
      // 購読設定(CCCD)が無いボタン: 登録時と同じ「購読を要求して属性なしで失敗」の状態になった。
      // 登録時はこの状態で実際の押下が届くことを確認済みなので、準備完了とする(猶予付き)。
      // 購読設定ありで登録したボタンがこの失敗をした場合は、下の再接続処理に任せる
      // (押下が届く確認が無いまま「使える」と表示しないため)。
      emitState("debug", "購読設定が無い機種として準備しました")
      markReady(peripheral)
      return
    }
    if let error {
      // 購読できない=押しても届かない。切断して既存の再接続処理でやり直す。
      dropLinkForRetry(peripheral, "ボタンの通知を有効にできませんでした(\(error.localizedDescription))。接続し直します", delay: 5)
      return
    }
    if characteristic.isNotifying {
      markReady(peripheral)
    } else {
      dropLinkForRetry(peripheral, "ボタンの通知が無効になりました。接続し直します", delay: 5)
    }
  }

  // 調査用: 購読設定が無い候補の記述子一覧(登録作業中のみ診断ログへ出す)。
  func peripheral(_ peripheral: CBPeripheral, didDiscoverDescriptorsFor characteristic: CBCharacteristic, error: Error?) {
    guard peripheral === self.peripheral, setupPromise != nil else { return }
    let list = (characteristic.descriptors ?? []).map { $0.uuid.uuidString }.joined(separator: ", ")
    var text = "記述子 \(characteristic.uuid.uuidString): " + (list.isEmpty ? "なし" : list)
    if let error {
      text += " (" + error.localizedDescription + ")"
    }
    emitState("debug", text)
  }

  func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
    // 書き込みは警報停止(Alert Level=0x00)だけなので、その結果を調査ログに出す。
    let label = "\(Self.serviceUUID(of: characteristic)?.uuidString ?? "?")/\(characteristic.uuid.uuidString)"
    if let error {
      emitState("debug", "警報停止の書き込み失敗 \(label): \(error.localizedDescription)")
    } else {
      emitState("debug", "警報停止の書き込み成功 \(label)")
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil else { return }
    guard peripheral === self.peripheral else { return }
    let now = Self.now()
    let data: Data = characteristic.value ?? Data()

    if setupPromise != nil {
      handleSetupNotification(peripheral, characteristic, data: data, now: now)
      return
    }

    // 通常運用: 登録済みペリフェラルの、登録した組からの通知で、購読が有効(ready)なものだけ。
    guard let reg = loadRegistration(), peripheral.identifier == reg.identifier else { return }
    guard ready, Self.matches(characteristic, service: reg.service, characteristic: reg.characteristic) else { return }
    // 空の通知は押下として扱わない(押した/離したを判別できないため)。
    guard let first = data.first else { return }
    handlePress(byte: first, reg: reg, now: now)
  }
}
