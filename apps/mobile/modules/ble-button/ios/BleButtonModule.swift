import ExpoModulesCore
import CoreBluetooth

// iTag型(紛失防止タグ)のBLEボタンをアプリで直接受けるモジュール。
//
// なぜ必要か: シャッターリモコン等は「Bluetoothキーボード(HID)」として繋がる
// ため、ロック中にキーを押すとiOSがFace ID/パスコード画面を出してしまい、
// アプリには届かない(OSの仕様で回避不可)。一方、iTag型はGATT通知という
// 生の信号を送る機器なので、bluetooth-central バックグラウンドモードが
// あればロック中・バックグラウンドでもアプリが直接受信できる。
// (Apple公式もPushToTalkの設計で「Bluetoothアクセサリのボタンによる
// バックグラウンドからの送信開始」を想定している)
//
// 設計上の要点(レビューで確認された事故を防ぐための不変条件):
// - 「押下」として扱う通知は、登録時に確定した『押下キャラクタリスティック』
//   からのもの、かつ登録済みペリフェラルからのものに限る(電池残量などの
//   無関係な通知で勝手に送信が始まる=ホットマイク事故の防止)。
// - 登録は『実際にボタンが押されたこと』を確認してから確定する
//   (近くの無関係なFFE0機器を誤登録しない)。
// - 再接続は登録済みペリフェラルに対してのみ行う(解除済み・旧タグが
//   送信を握り続ける事故の防止)。
// - 状態はすべてメインキューに閉じ込める(JSスレッドとの競合防止)。
public class BleButtonModule: Module {
  fileprivate var central: BleButtonCentral?

  public func definition() -> ModuleDefinition {
    Name("BleButton")

    Events("onPress", "onStateChanged")

    Constants([
      "buildTag": "ble-2"
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

    // JS側のイベント購読が始まった/終わった(バックグラウンド起動直後の
    // 「押下の取りこぼし」を後追いで再送するために使う)。
    OnStartObserving {
      DispatchQueue.main.async {
        self.central?.setObserving(true)
      }
    }
    OnStopObserving {
      DispatchQueue.main.async {
        self.central?.setObserving(false)
      }
    }

    // 登録済みボタンへの接続維持を(再)開始する。
    Function("start") {
      DispatchQueue.main.async {
        self.central?.startIfRegistered()
      }
    }

    // 現在の状態: { registered, connected, name? }
    // 状態はメインキューに閉じているため、メインキュー上で読み取る。
    Function("getStatus") { () -> [String: Any] in
      if Thread.isMainThread {
        return self.central?.status() ?? ["registered": false, "connected": false]
      }
      return DispatchQueue.main.sync {
        self.central?.status() ?? ["registered": false, "connected": false]
      }
    }

    // 近くのiTag型ボタンを探して登録する(前面での初期設定用)。
    // 接続後に「実際のボタン押下」を確認してから登録を確定する。
    // 成功すると { name } を返し、以後は自動で接続維持される。
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

  private static let uuidKey = "BleButtonPeripheralUUID"
  private static let nameKey = "BleButtonPeripheralName"
  // iTag系が使う事実上の標準サービス/キャラクタリスティック。
  private static let tagService = CBUUID(string: "FFE0")
  private static let tagCharacteristic = CBUUID(string: "FFE1")
  // HID(キーボード型)サービス。これを広告する機器はロック中に使えないので登録対象から除外。
  private static let hidService = CBUUID(string: "1812")
  // 「押下」以外の通知源になりうる既知のサービス(電池残量など)。
  // FFE1が無い亜種向けのフォールバック購読からも除外する。
  private static let excludedServices: Set<CBUUID> = [
    CBUUID(string: "1800"), // Generic Access
    CBUUID(string: "1801"), // Generic Attribute
    CBUUID(string: "180A"), // Device Information
    CBUUID(string: "180F"), // Battery
    CBUUID(string: "1805"), // Current Time
    CBUUID(string: "1812"), // HID
    CBUUID(string: "1804"), // Tx Power
  ]
  // 登録時に要求する最低電波強度。「手に持ってスマホのすぐ近く」ならこれを上回る。
  // 遠くにある無関係な機器・他人のタグの誤登録を防ぐ。
  private static let setupMinRSSI = -70

  private var manager: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var connected = false
  // 押下として扱うキャラクタリスティック(接続時に確定)。
  private var pressCharUUIDs: Set<CBUUID> = []
  // サービス発見の集計用(全サービスの発見完了後に購読先を一括決定する)。
  private var pendingServiceDiscoveries = 0
  private var discoveredNotifyChars: [(service: CBUUID, char: CBCharacteristic)] = []
  // 購読直後の「初期通知」(一部機種がCCCD書き込み直後に送る)を押下と誤認しないための猶予。
  private var subscribeGraceUntil: TimeInterval = 0
  // 状態復元(バックグラウンド再起動)後に、poweredOnを待ってから再購読するためのフラグ。
  private var needsRediscovery = false

  // 初期設定(スキャン→接続→押下確認)中の状態。
  private var setupPromise: Promise?
  private var setupCandidates: [UUID: (peripheral: CBPeripheral, rssi: Int, isTagService: Bool)] = [:]
  private var setupAwaitingPress = false
  private var scanDeadlineWork: DispatchWorkItem?
  private var connectTimeoutWork: DispatchWorkItem?
  private var confirmTimeoutWork: DispatchWorkItem?
  private var masterTimeoutWork: DispatchWorkItem?
  private var reconnectBackoffWork: DispatchWorkItem?

  // 連打・多重通知の抑制。トグル操作なので長め(0.8秒)にとる。
  private var lastPressAt: TimeInterval = 0
  // JS側がイベント購読中か。未購読中(バックグラウンド起動直後など)の押下は
  // 保持しておき、購読開始時に再送する(起こした一押し目を無駄にしない)。
  private var observing = false
  private var pendingPressAt: TimeInterval = 0

  init(module: BleButtonModule) {
    self.module = module
    super.init()
  }

  // MARK: - 公開操作(すべてメインキューから呼ばれる)

  func setObserving(_ value: Bool) {
    observing = value
    // 購読開始時: 直近15秒以内の未配信押下があれば再送する
    // (アプリがボタン押下で起こされた直後、JSの購読が間に合わなかったケース)。
    if value, pendingPressAt > 0, Date().timeIntervalSince1970 - pendingPressAt < 15 {
      pendingPressAt = 0
      module?.emit("onPress", ["replayed": true])
    }
  }

  func startIfRegistered() {
    guard registeredUUID() != nil else { return }
    ensureManager()
    connectIfPossible()
  }

  func status() -> [String: Any] {
    var result: [String: Any] = [
      "registered": registeredUUID() != nil,
      "connected": connected,
    ]
    if let name = UserDefaults.standard.string(forKey: Self.nameKey) {
      result["name"] = name
    }
    return result
  }

  func startSetup(promise: Promise) {
    if setupPromise != nil {
      promise.reject("E_BUSY", "すでに検索中です")
      return
    }
    // 再登録に備えて既存の接続は解除しておく(失敗時はfailSetupで復旧する)。
    disconnectCurrent()
    setupPromise = promise
    setupCandidates = [:]
    setupAwaitingPress = false
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
    DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: master)

    // 重要: didUpdateStateは「状態が変わった時」しか呼ばれない。
    // すでに確定している状態(オフ/権限なし/非対応)はここで即座に失敗させる。
    switch manager.state {
    case .poweredOn:
      beginScan()
      emitState("scanning", "近くのボタンを検索中...")
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
    disconnectCurrent()
    UserDefaults.standard.removeObject(forKey: Self.uuidKey)
    UserDefaults.standard.removeObject(forKey: Self.nameKey)
    emitState("idle", "登録を解除しました")
  }

  // MARK: - 内部処理

  private func registeredUUID() -> UUID? {
    guard let s = UserDefaults.standard.string(forKey: Self.uuidKey) else { return nil }
    return UUID(uuidString: s)
  }

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
    guard let uuid = registeredUUID() else { return }
    if let p = peripheral, p.identifier == uuid, p.state == .connected || p.state == .connecting { return }
    let found = manager.retrievePeripherals(withIdentifiers: [uuid])
    guard let target = found.first else {
      // 端末側のBluetoothデータベースに登録情報が無い(機種変更・ネットワーク設定
      // リセット後など)。電池や距離の問題ではないので、再登録を明確に案内する。
      emitState("error", "登録情報を復元できませんでした。一度「登録を解除」して再登録してください")
      return
    }
    peripheral = target
    target.delegate = self
    emitState("connecting", "登録済みボタンへ接続中...")
    // iOSの接続要求は期限なしで維持される: ボタンが眠っていても、
    // 次に電波を出した瞬間に自動接続される。
    manager.connect(target, options: nil)
  }

  private func disconnectCurrent() {
    cancelSetupTimers()
    reconnectBackoffWork?.cancel()
    reconnectBackoffWork = nil
    if let manager {
      if manager.isScanning { manager.stopScan() }
      if let p = peripheral { manager.cancelPeripheralConnection(p) }
    }
    peripheral = nil
    connected = false
    pressCharUUIDs = []
    discoveredNotifyChars = []
    pendingServiceDiscoveries = 0
  }

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

  private func beginScan() {
    guard let manager, manager.state == .poweredOn, setupPromise != nil else { return }
    guard scanDeadlineWork == nil, !manager.isScanning else { return }
    setupCandidates = [:]
    // サービス指定なしの全体スキャン(前面のみ)。iTagの多くはFFE0を広告するが、
    // 広告に載せない個体もあるため名前でも拾う。
    manager.scanForPeripherals(withServices: nil, options: nil)
    let work = DispatchWorkItem { [weak self] in self?.finishScanWindow() }
    scanDeadlineWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
  }

  // スキャン時間終了: 候補から最良(タグサービス優先→電波強度)を選んで接続する。
  // 遠い機器(他人のタグ・無関係な機器)の誤登録を防ぐため、近距離のものだけを対象にする。
  private func finishScanWindow() {
    guard setupPromise != nil else { return }
    scanDeadlineWork = nil
    manager?.stopScan()
    let near = setupCandidates.values.filter { $0.rssi >= Self.setupMinRSSI }
    let best = near.sorted { a, b in
      if a.isTagService != b.isTagService { return a.isTagService }
      return a.rssi > b.rssi
    }.first
    if let candidate = best {
      connectForSetup(candidate.peripheral)
      return
    }
    if setupCandidates.isEmpty {
      failSetup("E_NOT_FOUND", "ボタンが見つかりませんでした。ボタンを1回押して(起こして)から、もう一度お試しください")
    } else {
      failSetup("E_TOO_FAR", "ボタンの電波が弱すぎます。ボタンをスマホのすぐ近くに持って、もう一度お試しください")
    }
  }

  private func connectForSetup(_ target: CBPeripheral) {
    guard let manager else { return }
    if manager.isScanning { manager.stopScan() }
    peripheral = target
    target.delegate = self
    emitState("connecting", "接続中: \(target.name ?? "(名称不明)")")
    manager.connect(target, options: nil)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.setupPromise != nil else { return }
      self.failSetup("E_CONNECT_TIMEOUT", "接続がタイムアウトしました。もう一度お試しください")
    }
    connectTimeoutWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
  }

  // 登録の確定は「実際にボタンが押された」ことを確認してから行う。
  // これにより、たまたま近くにあった無関係なFFE0機器を誤登録しない。
  private func beginConfirmPhase(_ peripheral: CBPeripheral) {
    setupAwaitingPress = true
    emitState("confirming", "接続しました。ボタンを1回押して確定してください")
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.setupPromise != nil else { return }
      self.failSetup("E_CONFIRM_TIMEOUT", "ボタンの押下を確認できませんでした。もう一度お試しください")
    }
    confirmTimeoutWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: work)
  }

  private func confirmRegistration(_ peripheral: CBPeripheral) {
    setupAwaitingPress = false
    cancelSetupTimers()
    UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: Self.uuidKey)
    UserDefaults.standard.set(peripheral.name ?? "BLEボタン", forKey: Self.nameKey)
    connected = true
    setupPromise?.resolve(["name": peripheral.name ?? "BLEボタン"])
    setupPromise = nil
    emitState("connected", "登録しました: \(peripheral.name ?? "BLEボタン")")
  }

  private func failSetup(_ code: String, _ message: String) {
    cancelSetupTimers()
    setupAwaitingPress = false
    manager?.stopScan()
    // 設定用に接続した(未登録の)候補は必ず切り離す。
    if let p = peripheral, p.identifier != registeredUUID() {
      manager?.cancelPeripheralConnection(p)
      peripheral = nil
      connected = false
    }
    setupPromise?.reject(code, message)
    setupPromise = nil
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

  // MARK: - CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn:
      if setupPromise != nil {
        beginScan()
        emitState("scanning", "近くのボタンを検索中...")
      } else {
        // 状態復元直後の再購読(復元時はまだコマンドを受け付けないため、ここで行う)。
        if needsRediscovery, let p = peripheral, p.state == .connected {
          needsRediscovery = false
          p.discoverServices(nil)
        }
        connectIfPossible()
      }
    case .poweredOff:
      connected = false
      if setupPromise != nil {
        failSetup("E_POWERED_OFF", "Bluetoothがオフです。コントロールセンターでオンにしてください")
      } else {
        emitState("error", "Bluetoothがオフになっています")
      }
    case .unauthorized:
      if setupPromise != nil {
        failSetup("E_UNAUTHORIZED", "Bluetoothの使用が許可されていません。設定アプリで許可してください")
      } else {
        emitState("error", "Bluetooth権限がありません(設定→アプリで許可)")
      }
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
    if let restored = dict[CBCentralManagerOptionRestoredStatePeripheralsKey] as? [CBPeripheral],
       let p = restored.first {
      peripheral = p
      p.delegate = self
      if p.state == .connected {
        connected = true
        // この時点ではまだコマンドを受け付けない(poweredOn前)ため、
        // 再購読は didUpdateState の .poweredOn で行う。
        needsRediscovery = true
      }
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard setupPromise != nil, !setupAwaitingPress else { return }
    let advertised = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    // キーボード型(HID)はロック中に使えないため候補にしない。
    if advertised.contains(Self.hidService) { return }
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
    let isTagService = advertised.contains(Self.tagService)
    let nameLooksLikeTag = name.lowercased().contains("tag")
    guard isTagService || nameLooksLikeTag else { return }
    // 即決はしない: スキャン時間いっぱい候補を集め、最も近い(RSSI最大の)ものを
    // 選ぶ。「最初に見つかったFFE0機器」が手元のタグとは限らないため。
    setupCandidates[peripheral.identifier] = (peripheral, RSSI.intValue, isTagService)
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectTimeoutWork?.cancel()
    connectTimeoutWork = nil
    if setupPromise != nil {
      // 設定中: 自分が選んだ候補だけを相手にする(同時期に他の接続が完了しても無視)。
      guard peripheral === self.peripheral else {
        central.cancelPeripheralConnection(peripheral)
        return
      }
      // まだ登録は確定しない: サービス発見→購読→実押下の確認を経て確定する。
      peripheral.discoverServices(nil)
      beginConfirmPhase(peripheral)
      return
    }
    // 通常運用: 登録済みペリフェラル以外は繋がっても採用しない
    // (解除済みの旧タグが送信を握るのを防ぐ)。
    guard peripheral.identifier == registeredUUID() else {
      central.cancelPeripheralConnection(peripheral)
      return
    }
    connected = true
    emitState("connected", "接続しました: \(peripheral.name ?? "BLEボタン")")
    peripheral.discoverServices(nil)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    if setupPromise != nil {
      guard peripheral === self.peripheral else { return }
      failSetup("E_CONNECT", "接続に失敗しました: \(error?.localizedDescription ?? "不明なエラー")")
      return
    }
    // 登録済みペリフェラル以外の失敗は放置(再接続しない)。
    guard peripheral.identifier == registeredUUID() else { return }
    connected = false
    emitState("disconnected", "接続失敗。再接続を待機します")
    // 少し間を置いてから期限なしの再接続要求を出し直す
    // (即時に再要求し続けると失敗ループでメインキューと電池を消耗するため)。
    self.peripheral = peripheral
    let work = DispatchWorkItem { [weak self] in
      guard let self, let manager = self.manager else { return }
      guard self.setupPromise == nil, peripheral.identifier == self.registeredUUID() else { return }
      manager.connect(peripheral, options: nil)
    }
    reconnectBackoffWork?.cancel()
    reconnectBackoffWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    if peripheral.identifier == self.peripheral?.identifier {
      connected = false
    }
    // 登録済みペリフェラルのみ再接続する(設定中は行わない)。
    guard setupPromise == nil, peripheral.identifier == registeredUUID() else { return }
    emitState("disconnected", "切断されました。再接続を待機します")
    // 強参照を保持した上で即再接続要求(ボタンが眠っていても次の押下で自動復帰)。
    self.peripheral = peripheral
    central.connect(peripheral, options: nil)
  }

  // MARK: - CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    let services = peripheral.services ?? []
    discoveredNotifyChars = []
    pendingServiceDiscoveries = services.count
    if services.isEmpty {
      handleDiscoveryComplete(peripheral)
      return
    }
    for service in services {
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    for c in service.characteristics ?? [] where c.properties.contains(.notify) {
      discoveredNotifyChars.append((service.uuid, c))
    }
    pendingServiceDiscoveries -= 1
    if pendingServiceDiscoveries <= 0 {
      handleDiscoveryComplete(peripheral)
    }
  }

  // 全サービスの発見が終わってから、押下として扱う購読先を一括で決定する。
  // (この判断をサービス単位でやると、電池残量など無関係な通知まで購読して
  //  しまい、ポケットの中で勝手に送信が始まる事故につながる)
  private func handleDiscoveryComplete(_ peripheral: CBPeripheral) {
    let ffe1 = discoveredNotifyChars.filter { $0.char.uuid == Self.tagCharacteristic }
    let targets: [CBCharacteristic]
    if !ffe1.isEmpty {
      // 事実上の標準(FFE1)があればそれだけを購読する。
      targets = ffe1.map { $0.char }
    } else {
      // 亜種: 既知の「押下ではない」サービスを除いた通知だけを購読する。
      targets = discoveredNotifyChars
        .filter { !Self.excludedServices.contains($0.service) }
        .map { $0.char }
    }
    guard !targets.isEmpty else {
      if setupPromise != nil {
        failSetup("E_NO_BUTTON", "この機器にはボタン通知が見つかりませんでした(未対応の機種の可能性)")
      } else {
        emitState("error", "ボタン通知が見つかりません(未対応の機種の可能性)")
      }
      return
    }
    pressCharUUIDs = Set(targets.map { $0.uuid })
    // 一部機種は購読直後に「現在値」を勝手に送ってくる。これを押下と誤認しない。
    subscribeGraceUntil = Date().timeIntervalSince1970 + 1.0
    for t in targets {
      peripheral.setNotifyValue(true, for: t)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil else { return }
    // 押下として確定したキャラクタリスティック以外の通知は無視する。
    guard pressCharUUIDs.contains(characteristic.uuid) else { return }
    let now = Date().timeIntervalSince1970
    // 購読直後の初期通知は押下ではない。
    guard now > subscribeGraceUntil else { return }

    // 設定中の「押下確認」: 選んだ候補からの実押下で登録を確定する。
    if setupAwaitingPress, peripheral === self.peripheral, setupPromise != nil {
      confirmRegistration(peripheral)
      return
    }

    // 通常運用: 登録済みペリフェラルからの押下のみ有効。
    guard peripheral.identifier == registeredUUID() else { return }
    // 連続フレーム(押下+解放や重複)はデバウンスで1回に丸める。
    // トグル操作(押すたびにON/OFF)なので長め(0.8秒)にとる。
    guard now - lastPressAt > 0.8 else { return }
    lastPressAt = now
    if observing {
      module?.emit("onPress", [:])
    } else {
      // JSがまだ購読していない(バックグラウンド起動直後など)。
      // 破棄せず保持し、購読開始時に再送する。
      pendingPressAt = now
    }
  }
}
