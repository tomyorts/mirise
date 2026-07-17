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
public class BleButtonModule: Module {
  fileprivate var central: BleButtonCentral?

  public func definition() -> ModuleDefinition {
    Name("BleButton")

    Events("onPress", "onStateChanged")

    Constants([
      "buildTag": "ble-1"
    ])

    OnCreate {
      let helper = BleButtonCentral(module: self)
      self.central = helper
      // 登録済みボタンがある場合のみ、起動直後から接続維持を始める
      // (未登録ならBluetooth権限ダイアログを出さないため、Managerは作らない)。
      helper.startIfRegistered()
    }

    // 登録済みボタンへの接続維持を(再)開始する。
    Function("start") {
      self.central?.startIfRegistered()
    }

    // 現在の状態: { registered, connected, name? }
    Function("getStatus") { () -> [String: Any] in
      return self.central?.status() ?? ["registered": false, "connected": false]
    }

    // 近くのiTag型ボタンを探して登録する(前面での初期設定用)。
    // 成功すると { name } を返し、以後は自動で接続維持される。
    AsyncFunction("startSetup") { (promise: Promise) in
      self.central?.startSetup(promise: promise)
    }

    // 登録を解除して切断する。
    Function("unregister") {
      self.central?.unregister()
    }
  }

  fileprivate func emit(_ name: String, _ payload: [String: Any] = [:]) {
    sendEvent(name, payload)
  }
}

// CoreBluetooth側の実装。CBCentralManagerDelegate等はNSObjectが必要なので
// モジュール本体とは別クラスにする(PttDelegateと同じ構成)。
final class BleButtonCentral: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  private weak var module: BleButtonModule?

  private static let uuidKey = "BleButtonPeripheralUUID"
  private static let nameKey = "BleButtonPeripheralName"
  // iTag系が使う事実上の標準サービス/キャラクタリスティック。
  private static let tagService = CBUUID(string: "FFE0")
  private static let tagCharacteristic = CBUUID(string: "FFE1")
  // HID(キーボード型)サービス。これを広告する機器はロック中に使えないので登録対象から除外。
  private static let hidService = CBUUID(string: "1812")

  private var manager: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var connected = false

  // 初期設定(スキャン)中の状態。
  private var setupPromise: Promise?
  private var setupCandidates: [UUID: (peripheral: CBPeripheral, rssi: Int, isTagService: Bool)] = [:]
  private var scanDeadlineWork: DispatchWorkItem?
  private var connectTimeoutWork: DispatchWorkItem?

  // 連打・多重通知の抑制(一部のタグは押下で複数フレームを送る)。
  private var lastPressAt: TimeInterval = 0

  init(module: BleButtonModule) {
    self.module = module
    super.init()
  }

  // MARK: - 公開操作

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
    // 再登録に備えて既存の接続は解除しておく。
    disconnectCurrent()
    setupPromise = promise
    setupCandidates = [:]
    ensureManager()
    guard let manager else {
      failSetup("E_INTERNAL", "Bluetoothを初期化できませんでした")
      return
    }
    if manager.state == .poweredOn {
      beginScan()
    }
    // まだ .unknown (権限ダイアログ表示中など)の場合は didUpdateState で開始する。
    emitState("scanning", "近くのボタンを検索中...")
  }

  func unregister() {
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
    guard let uuid = registeredUUID() else { return }
    if let p = peripheral, p.state == .connected || p.state == .connecting { return }
    let found = manager.retrievePeripherals(withIdentifiers: [uuid])
    guard let target = found.first else {
      emitState("disconnected", "登録済みボタンが見つかりません(電池切れ・距離を確認)")
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
    scanDeadlineWork?.cancel()
    scanDeadlineWork = nil
    connectTimeoutWork?.cancel()
    connectTimeoutWork = nil
    if let manager {
      if manager.isScanning { manager.stopScan() }
      if let p = peripheral { manager.cancelPeripheralConnection(p) }
    }
    peripheral = nil
    connected = false
  }

  private func beginScan() {
    guard let manager, manager.state == .poweredOn, setupPromise != nil else { return }
    setupCandidates = [:]
    // サービス指定なしの全体スキャン(前面のみ)。iTagの多くはFFE0を広告するが、
    // 広告に載せない個体もあるため名前でも拾う。
    manager.scanForPeripherals(withServices: nil, options: nil)
    let work = DispatchWorkItem { [weak self] in self?.finishScanWindow() }
    scanDeadlineWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
  }

  // スキャン時間終了: 候補から最良(タグサービス優先→電波強度)を選んで接続する。
  private func finishScanWindow() {
    guard setupPromise != nil else { return }
    manager?.stopScan()
    let best = setupCandidates.values.sorted { a, b in
      if a.isTagService != b.isTagService { return a.isTagService }
      return a.rssi > b.rssi
    }.first
    guard let candidate = best else {
      failSetup("E_NOT_FOUND", "ボタンが見つかりませんでした。ボタンを1回押して(電源を入れて)近くに置き、もう一度お試しください")
      return
    }
    connectForSetup(candidate.peripheral)
  }

  private func connectForSetup(_ target: CBPeripheral) {
    guard let manager else { return }
    scanDeadlineWork?.cancel()
    scanDeadlineWork = nil
    if manager.isScanning { manager.stopScan() }
    peripheral = target
    target.delegate = self
    emitState("connecting", "接続中: \(target.name ?? "(名称不明)")")
    manager.connect(target, options: nil)
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.setupPromise != nil else { return }
      self.disconnectCurrent()
      self.failSetup("E_TIMEOUT", "接続がタイムアウトしました。もう一度お試しください")
    }
    connectTimeoutWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
  }

  private func failSetup(_ code: String, _ message: String) {
    setupPromise?.reject(code, message)
    setupPromise = nil
    emitState(registeredUUID() != nil ? "disconnected" : "idle", message)
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
      } else {
        connectIfPossible()
      }
    case .unauthorized:
      failSetup("E_UNAUTHORIZED", "Bluetoothの使用が許可されていません。設定アプリで許可してください")
      emitState("error", "Bluetooth権限がありません(設定→アプリで許可)")
    case .poweredOff:
      connected = false
      emitState("error", "Bluetoothがオフになっています")
    default:
      break
    }
  }

  // アプリがバックグラウンドで再起動された場合の接続復元。
  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    if let restored = dict[CBCentralManagerOptionRestoredStatePeripheralsKey] as? [CBPeripheral],
       let p = restored.first {
      peripheral = p
      p.delegate = self
      if p.state == .connected {
        connected = true
        // 購読状態も引き継がれるが、念のため再購読しておく。
        p.discoverServices(nil)
      }
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard setupPromise != nil else { return }
    let advertised = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
    // キーボード型(HID)はロック中に使えないため候補にしない。
    if advertised.contains(Self.hidService) { return }
    let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
    let isTagService = advertised.contains(Self.tagService)
    let nameLooksLikeTag = name.lowercased().contains("tag")
    guard isTagService || nameLooksLikeTag else { return }
    setupCandidates[peripheral.identifier] = (peripheral, RSSI.intValue, isTagService)
    // 事実上の標準(FFE0)を広告する機器が見つかったら即決で接続する。
    if isTagService {
      connectForSetup(peripheral)
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    connectTimeoutWork?.cancel()
    connectTimeoutWork = nil
    connected = true
    if setupPromise != nil {
      // 登録を確定して永続化。
      UserDefaults.standard.set(peripheral.identifier.uuidString, forKey: Self.uuidKey)
      UserDefaults.standard.set(peripheral.name ?? "BLEボタン", forKey: Self.nameKey)
      setupPromise?.resolve(["name": peripheral.name ?? "BLEボタン"])
      setupPromise = nil
    }
    emitState("connected", "接続しました: \(peripheral.name ?? "BLEボタン")")
    peripheral.discoverServices(nil)
  }

  func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
    connected = false
    if setupPromise != nil {
      connectTimeoutWork?.cancel()
      connectTimeoutWork = nil
      failSetup("E_CONNECT", "接続に失敗しました: \(error?.localizedDescription ?? "不明なエラー")")
      return
    }
    emitState("disconnected", "接続失敗。再接続を待機します")
    // 期限なしの再接続要求を出し直す(ボタンが次に電波を出した時に自動接続)。
    central.connect(peripheral, options: nil)
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
    connected = false
    guard registeredUUID() != nil else { return }
    emitState("disconnected", "切断されました。再接続を待機します")
    // すぐに再接続要求(ボタンが眠っていても、次の押下→広告で自動復帰する)。
    central.connect(peripheral, options: nil)
  }

  // MARK: - CBPeripheralDelegate

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    for service in peripheral.services ?? [] {
      peripheral.discoverCharacteristics(nil, for: service)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    let chars = service.characteristics ?? []
    // 事実上の標準(FFE0/FFE1)があればそれだけを購読。無ければ、その他の
    // 通知可能キャラクタリスティックを購読する(安価タグの亜種対応)。
    if service.uuid == Self.tagService,
       let target = chars.first(where: { $0.uuid == Self.tagCharacteristic }) {
      peripheral.setNotifyValue(true, for: target)
      return
    }
    for c in chars where c.properties.contains(.notify) {
      peripheral.setNotifyValue(true, for: c)
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard error == nil else { return }
    // 押下イベント。連続フレーム(押下+解放や重複)は0.4秒のデバウンスで1回に丸める。
    let now = Date().timeIntervalSince1970
    guard now - lastPressAt > 0.4 else { return }
    lastPressAt = now
    module?.emit("onPress", [:])
  }
}
