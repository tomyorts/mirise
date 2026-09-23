import ExpoModulesCore
import PushToTalk
import AVFoundation
import UIKit
import WebRTC

// Apple の PushToTalk(PTChannelManager)を JS へ橋渡しするモジュール。
// 重要: モジュールクラス自体には @available を付けない。付けると Expo の自動生成する
// モジュール一覧から除外され、requireNativeModule で見つからなくなる(=登録されない)。
// iOS16専用APIは実行時に #available で保護し、値は Any でボックス化して保持する。
public class PttChannelModule: Module {
  fileprivate var managerBox: Any?      // PTChannelManager (iOS16+)
  fileprivate var managerTaskBox: Any?  // Task<PTChannelManager, Error> (iOS16+, 作成中の共有)
  fileprivate var delegateBox: Any?     // PttDelegate (iOS16+)
  fileprivate var channelUUID: UUID?
  fileprivate var channelName: String = "MIRISE Intercom"
  // 送信中か・音声セッションが有効か。JSがイベントを購読する前に起きたことを、
  // 購読後に getState で引き継げるように保持する(下の getState のコメント参照)。
  fileprivate var isTransmitting = false
  fileprivate var transmitSource: String?
  fileprivate var isAudioActive = false

  public func definition() -> ModuleDefinition {
    Name("PttChannel")
    Events(
      "onJoin",
      "onLeave",
      "onBeginTransmitting",
      "onEndTransmitting",
      "onActivateAudio",
      "onDeactivateAudio",
      "onPushToken",
      "onAccessoryButton",
      "onError"
    )

    // Appleの要件: PTChannelManager はアプリ起動時のできるだけ早い段階で作成する。
    // これにより、アプリがシステムに起こされた時(チャンネル復帰・送信イベント)を取りこぼさない。
    OnCreate {
      if #available(iOS 16.0, *) {
        Task { [weak self] in
          _ = try? await self?.manager()
        }
      }
    }

    // ネイティブ側の「本当の状態」を返す。JS側のstateはアプリ再起動
    // (メモリ回収→バックグラウンド復元)でfalseに戻るが、ネイティブの
    // PTChannelManagerは復元されて参加済みのことがある。BLEボタン押下時は
    // こちらを真実として参照する。
    // transmitting/audioActive: iOSが終了させていたアプリをイヤホンのボタンで
    // 起こした場合、送信開始の通知はJSが購読する前に届いて捨てられる
    // (システム上は送信中なのに無音になる)。JSは購読直後にこれを見て引き継ぐ。
    Function("getState") { () -> [String: Any] in
      var result: [String: Any] = [
        "joined": self.channelUUID != nil,
        "transmitting": self.isTransmitting,
        "audioActive": self.isAudioActive,
      ]
      if let uuid = self.channelUUID {
        result["channelUUID"] = uuid.uuidString
      }
      if self.isTransmitting, let source = self.transmitSource {
        result["source"] = source
      }
      return result
    }

    AsyncFunction("join") { (name: String) async throws -> String in
      if #available(iOS 16.0, *) {
        return try await self.joinImpl(name)
      }
      throw NSError(
        domain: "PttChannel", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "iOS16以上が必要です"]
      )
    }

    AsyncFunction("leave") { () async throws in
      if #available(iOS 16.0, *) { try await self.leaveImpl() }
    }

    AsyncFunction("beginTransmitting") { () async throws in
      if #available(iOS 16.0, *) { try await self.beginImpl() }
    }

    AsyncFunction("endTransmitting") { () async throws in
      if #available(iOS 16.0, *) { await self.endImpl() }
    }

    // アクセサリ(イヤホン)のボタンをPTTの送信操作に割り当てるかを実行中に切り替える。
    // アプリ側でメディアボタンを横取りする方式と併用すると、1回の押下で
    // 二重に反応してしまうため、どちらか一方だけを有効にするために使う。
    AsyncFunction("setAccessoryButtonEnabled") { (enabled: Bool) async throws in
      if #available(iOS 17.0, *) {
        try await self.setAccessoryEnabledImpl(enabled)
      }
    }
  }

  fileprivate func emit(_ name: String, _ payload: [String: Any] = [:]) {
    sendEvent(name, payload)
  }

  // MARK: - iOS16専用の実装(実行時ガード後にのみ呼ばれる)

  // OnCreateでの先行作成と、join()呼び出しでの作成が同時に走ると
  // PTChannelManager.channelManager(...)が二重に呼ばれてハングする恐れがあるため、
  // 進行中のTaskを共有して二重作成を防ぐ(JS側のconnectPromiseRefと同じ考え方)。
  @available(iOS 16.0, *)
  private func manager() async throws -> PTChannelManager {
    if let existing = managerBox as? PTChannelManager { return existing }
    if let existingTask = managerTaskBox as? Task<PTChannelManager, Error> {
      return try await existingTask.value
    }

    let task = Task<PTChannelManager, Error> { [weak self] in
      guard let self else {
        throw NSError(
          domain: "PttChannel", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "モジュールが解放されました"]
        )
      }
      let delegate = PttDelegate(module: self)
      self.delegateBox = delegate
      let created = try await PTChannelManager.channelManager(
        delegate: delegate,
        restorationDelegate: delegate
      )
      self.managerBox = created
      return created
    }
    managerTaskBox = task
    defer { managerTaskBox = nil }
    return try await task.value
  }

  @available(iOS 16.0, *)
  private func joinImpl(_ name: String) async throws -> String {
    channelName = name
    let m = try await manager()
    let uuid = channelUUID ?? UUID()
    channelUUID = uuid
    let descriptor = PTChannelDescriptor(name: name, image: PttChannelModule.makeChannelImage())
    try await m.requestJoinChannel(channelUUID: uuid, descriptor: descriptor)

    // 核心: Bluetoothイヤホン等のアクセサリのボタンを、送信の開始/終了に
    // マッピングするようシステムへ要求する(iOS17+)。
    // これを呼ばないとアクセサリのボタンは送信に結び付かない。
    // 有効にすると、ポケットにスマホを入れたままイヤホンのボタンを押すだけで
    // 送信できる(押下は didBeginTransmittingFrom に source=.handsfreeButton
    // として届く)。既存の業務用インカムと同じ操作感を、追加のBLEボタン無しで
    // 実現するための要のAPI。
    if #available(iOS 17.0, *) {
      do {
        try await m.setAccessoryButtonEventsEnabled(true, channelUUID: uuid)
        self.emit("onAccessoryButton", ["enabled": true])
      } catch {
        // 失敗してもチャンネル参加自体は成立しているので、参加は成功扱いにし、
        // 画面の診断ログで分かるようにする(アクセサリ非対応端末など)。
        self.emit("onAccessoryButton", [
          "enabled": false,
          "error": error.localizedDescription,
        ])
      }
    } else {
      self.emit("onAccessoryButton", ["enabled": false, "error": "iOS17以降が必要です"])
    }

    return uuid.uuidString
  }

  // PTChannelDescriptor に渡すアイコン。nilのままだとシステムのPTT表示
  // (Dynamic Island/ロック画面のトークUI)が正しく描画されない場合があるため、
  // 確実に非nilになるSF Symbolを使う(専用アセットが無くても機能する)。
  // 注意: PTChannelDescriptor の image は UIImage を直接受け取る(PTImageという
  // 型は存在しない)。誤った型を書くと未解決の型としてコンパイラの型検査全体が
  // 壊れ、無関係な下の行にまで偽のエラーが連鎖するので注意。
  fileprivate static func makeChannelImage() -> UIImage? {
    return UIImage(systemName: "mic.circle.fill")
  }

  @available(iOS 17.0, *)
  private func setAccessoryEnabledImpl(_ enabled: Bool) async throws {
    guard let uuid = channelUUID else { return }
    let m = try await manager()
    try await m.setAccessoryButtonEventsEnabled(enabled, channelUUID: uuid)
    emit("onAccessoryButton", ["enabled": enabled])
  }

  @available(iOS 16.0, *)
  private func leaveImpl() async throws {
    if let uuid = channelUUID, let m = managerBox as? PTChannelManager {
      try await m.leaveChannel(channelUUID: uuid)
    }
    channelUUID = nil
  }

  // 無言で成功に見せない: チャンネル未参加なら明確にエラーを返し、
  // Manager作成が進行中なら(managerBoxの完成を待たず諦めるのではなく)待つ。
  @available(iOS 16.0, *)
  private func beginImpl() async throws {
    guard let uuid = channelUUID else {
      throw NSError(
        domain: "PttChannel", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "PTTチャンネル未参加のため送信できません"]
      )
    }
    let m = try await manager()
    try await m.requestBeginTransmitting(channelUUID: uuid)
  }

  @available(iOS 16.0, *)
  private func endImpl() async {
    guard let uuid = channelUUID, let m = try? await manager() else { return }
    await m.stopTransmitting(channelUUID: uuid)
  }
}

// PTChannelManager のデリゲート(iOS16専用)。iOS16以降でのみ生成される。
@available(iOS 16.0, *)
final class PttDelegate: NSObject, PTChannelManagerDelegate, PTChannelRestorationDelegate {
  weak var module: PttChannelModule?

  init(module: PttChannelModule) {
    self.module = module
  }

  func channelManager(_ channelManager: PTChannelManager, didJoinChannel channelUUID: UUID, reason: PTChannelJoinReason) {
    // 復帰(システムによる再参加)でもUUIDを保持し、以後の送信要求が機能するようにする。
    module?.channelUUID = channelUUID
    module?.emit("onJoin", ["channelUUID": channelUUID.uuidString])
  }

  func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
    // システム側(ロック画面の「退出」など)で抜けた場合も参加状態を正しく戻す。
    // これが無いと getState が参加中のままになり、イヤホンのボタンが効かないのに
    // 画面は「待機中」と表示し続ける。
    if module?.channelUUID == channelUUID {
      module?.channelUUID = nil
    }
    module?.isTransmitting = false
    module?.transmitSource = nil
    module?.emit("onLeave")
  }

  // 参加・送信の要求が拒否された時の通知(他のアプリで通話中・前面にいない等)。
  // 以前は未実装で、失敗しても何も起きず「待機中」「準備中」のまま固まっていた。
  func channelManager(_ channelManager: PTChannelManager, failedToJoinChannel channelUUID: UUID, error: Error) {
    if module?.channelUUID == channelUUID {
      module?.channelUUID = nil
    }
    module?.emit("onError", ["kind": "join", "message": error.localizedDescription])
  }

  func channelManager(_ channelManager: PTChannelManager, failedToLeaveChannel channelUUID: UUID, error: Error) {
    module?.emit("onError", ["kind": "leave", "message": error.localizedDescription])
  }

  func channelManager(_ channelManager: PTChannelManager, failedToBeginTransmittingInChannel channelUUID: UUID, error: Error) {
    module?.emit("onError", ["kind": "begin", "message": error.localizedDescription])
  }

  func channelManager(_ channelManager: PTChannelManager, failedToStopTransmittingInChannel channelUUID: UUID, error: Error) {
    module?.emit("onError", ["kind": "stop", "message": error.localizedDescription])
  }

  // 送信の起点を文字列化する。どの操作で送信が始まったかを画面の診断ログで
  // 確認できるようにする(特にイヤホンのボタン=handsfreeButtonの動作確認用)。
  private func sourceName(_ source: PTChannelTransmitRequestSource) -> String {
    switch source {
    case .handsfreeButton: return "イヤホンのボタン"
    case .userRequest: return "システムUIのトークボタン"
    case .developerRequest: return "アプリ内のボタン"
    case .unknown: return "不明"
    @unknown default: return "その他"
    }
  }

  func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
    let name = sourceName(source)
    module?.isTransmitting = true
    module?.transmitSource = name
    module?.emit("onBeginTransmitting", ["source": name])
  }

  func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
    module?.isTransmitting = false
    module?.transmitSource = nil
    module?.emit("onEndTransmitting", ["source": sourceName(source)])
  }

  func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
    // 核心の修正: AVAudioSessionを実際に有効化しているのはPushToTalk
    // フレームワーク自身であり、WebRTCではない。WebRTCのRTCAudioSessionに
    // audioSessionDidActivateを伝えるだけでは、録音エンジン(オーディオユニット)
    // 自体は起動しないことが実機検証で判明した(CallKit連携と同様、
    // isAudioEnabledを明示的にtrueにする必要がある)。
    // useManualAudioはこの一時的な区間だけON(PT送信中は手動制御)にし、
    // 終わったらOFFに戻すことで、「押して話す」ボタン側の自動制御
    // (setWillEnableEngineHandler等)には影響させない。
    let rtcSession = RTCAudioSession.sharedInstance()
    rtcSession.useManualAudio = true
    rtcSession.audioSessionDidActivate(audioSession)
    rtcSession.isAudioEnabled = true
    module?.isAudioActive = true
    module?.emit("onActivateAudio")
  }

  func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
    let rtcSession = RTCAudioSession.sharedInstance()
    rtcSession.isAudioEnabled = false
    rtcSession.audioSessionDidDeactivate(audioSession)
    rtcSession.useManualAudio = false
    module?.isAudioActive = false
    module?.emit("onDeactivateAudio")
  }

  func channelManager(_ channelManager: PTChannelManager, receivedEphemeralPushToken pushToken: Data) {
    let token = pushToken.map { String(format: "%02x", $0) }.joined()
    module?.emit("onPushToken", ["token": token])
  }

  func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
    return .leaveChannel
  }

  func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
    // 復帰時にUUIDも保持して、以後の送信要求(begin/end)が機能するようにする。
    module?.channelUUID = channelUUID
    return PTChannelDescriptor(
      name: module?.channelName ?? "MIRISE Intercom",
      image: PttChannelModule.makeChannelImage()
    )
  }
}
