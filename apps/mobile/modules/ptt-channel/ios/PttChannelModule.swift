import ExpoModulesCore
import PushToTalk
import AVFoundation

// Apple の PushToTalk(PTChannelManager)を JS へ橋渡しするモジュール。
// 重要: モジュールクラス自体には @available を付けない。付けると Expo の自動生成する
// モジュール一覧から除外され、requireNativeModule で見つからなくなる(=登録されない)。
// iOS16専用APIは実行時に #available で保護し、値は Any でボックス化して保持する。
public class PttChannelModule: Module {
  fileprivate var managerBox: Any?   // PTChannelManager (iOS16+)
  fileprivate var delegateBox: Any?  // PttDelegate (iOS16+)
  fileprivate var channelUUID: UUID?
  fileprivate var channelName: String = "MIRISE Intercom"

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
      "onError"
    )

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
  }

  fileprivate func emit(_ name: String, _ payload: [String: Any] = [:]) {
    sendEvent(name, payload)
  }

  // MARK: - iOS16専用の実装(実行時ガード後にのみ呼ばれる)

  @available(iOS 16.0, *)
  private func manager() async throws -> PTChannelManager {
    if let existing = managerBox as? PTChannelManager { return existing }
    let delegate = PttDelegate(module: self)
    delegateBox = delegate
    let created = try await PTChannelManager.channelManager(
      delegate: delegate,
      restorationDelegate: delegate
    )
    managerBox = created
    return created
  }

  @available(iOS 16.0, *)
  private func joinImpl(_ name: String) async throws -> String {
    channelName = name
    let m = try await manager()
    let uuid = channelUUID ?? UUID()
    channelUUID = uuid
    let descriptor = PTChannelDescriptor(name: name, image: nil)
    try await m.requestJoinChannel(channelUUID: uuid, descriptor: descriptor)
    return uuid.uuidString
  }

  @available(iOS 16.0, *)
  private func leaveImpl() async throws {
    if let uuid = channelUUID, let m = managerBox as? PTChannelManager {
      try await m.leaveChannel(channelUUID: uuid)
    }
    channelUUID = nil
  }

  @available(iOS 16.0, *)
  private func beginImpl() async throws {
    guard let uuid = channelUUID, let m = managerBox as? PTChannelManager else { return }
    try await m.requestBeginTransmitting(channelUUID: uuid)
  }

  @available(iOS 16.0, *)
  private func endImpl() async {
    guard let uuid = channelUUID, let m = managerBox as? PTChannelManager else { return }
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
    module?.emit("onJoin", ["channelUUID": channelUUID.uuidString])
  }

  func channelManager(_ channelManager: PTChannelManager, didLeaveChannel channelUUID: UUID, reason: PTChannelLeaveReason) {
    module?.emit("onLeave")
  }

  func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didBeginTransmittingFrom source: PTChannelTransmitRequestSource) {
    module?.emit("onBeginTransmitting")
  }

  func channelManager(_ channelManager: PTChannelManager, channelUUID: UUID, didEndTransmittingFrom source: PTChannelTransmitRequestSource) {
    module?.emit("onEndTransmitting")
  }

  func channelManager(_ channelManager: PTChannelManager, didActivate audioSession: AVAudioSession) {
    module?.emit("onActivateAudio")
  }

  func channelManager(_ channelManager: PTChannelManager, didDeactivate audioSession: AVAudioSession) {
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
    return PTChannelDescriptor(name: module?.channelName ?? "MIRISE Intercom", image: nil)
  }
}
