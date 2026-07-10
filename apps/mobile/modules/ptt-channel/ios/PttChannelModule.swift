import ExpoModulesCore
import PushToTalk
import AVFoundation
import UIKit

// Apple の PushToTalk フレームワーク(PTChannelManager)を JS へ橋渡しするモジュール。
// 目的: 画面OFF・ポケットの中でも「話す(送信)」を成立させる(Phase B / Stage 1)。
// 送信開始/停止イベントを JS に送り、JS 側で LiveKit のマイクをON/OFFする。
@available(iOS 16.0, *)
public class PttChannelModule: Module {
  fileprivate var channelManager: PTChannelManager?
  fileprivate var channelUUID: UUID?
  fileprivate var channelName: String = "MIRISE Intercom"
  private lazy var proxy = PttDelegate(module: self)

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

    // PTTチャンネルに参加する。参加すると iOS がバックグラウンド送信を許可する。
    AsyncFunction("join") { (name: String) async throws -> String in
      self.channelName = name
      if self.channelManager == nil {
        self.channelManager = try await PTChannelManager.channelManager(
          delegate: self.proxy,
          restorationDelegate: self.proxy
        )
      }
      let uuid = self.channelUUID ?? UUID()
      self.channelUUID = uuid
      let descriptor = PTChannelDescriptor(name: name, image: nil)
      try await self.channelManager?.requestJoinChannel(channelUUID: uuid, descriptor: descriptor)
      return uuid.uuidString
    }

    // チャンネルから退出。
    AsyncFunction("leave") { () async throws in
      if let uuid = self.channelUUID {
        try await self.channelManager?.leaveChannel(channelUUID: uuid)
      }
      self.channelUUID = nil
    }

    // 送信開始を要求(画面の「話す」ボタン用)。成功すると onBeginTransmitting が返る。
    AsyncFunction("beginTransmitting") { () async throws in
      guard let uuid = self.channelUUID else { return }
      try await self.channelManager?.requestBeginTransmitting(channelUUID: uuid)
    }

    // 送信停止。
    AsyncFunction("endTransmitting") { () async throws in
      guard let uuid = self.channelUUID else { return }
      await self.channelManager?.stopTransmitting(channelUUID: uuid)
    }
  }

  fileprivate func emit(_ name: String, _ payload: [String: Any] = [:]) {
    sendEvent(name, payload)
  }
}

// PTChannelManager のデリゲート。イベントを JS へ転送する。
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

  // 受信プッシュ(Stage 2で実装)。今は最小の実装。
  func incomingPushResult(channelManager: PTChannelManager, channelUUID: UUID, pushPayload: [String: Any]) -> PTPushResult {
    return .leaveChannel
  }

  // 復帰時にチャンネル情報を返す。
  func channelDescriptor(restoredChannelUUID channelUUID: UUID) -> PTChannelDescriptor {
    return PTChannelDescriptor(name: module?.channelName ?? "MIRISE Intercom", image: nil)
  }
}
