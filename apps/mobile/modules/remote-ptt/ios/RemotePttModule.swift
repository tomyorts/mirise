import ExpoModulesCore
import MediaPlayer
import GameController

// 物理ボタンで送信ON/OFF(トグル)を実現するモジュール。2系統のボタンに対応:
//   1. Bluetoothイヤホンの再生/停止ボタン (MPRemoteCommandCenter)
//   2. キーを送るBLEリモコン=ページめくり器/指輪型など (GameController のキーボード入力)
// どちらのボタンが押されても JS 側へ onToggle イベントを送る。
// 2は通話中の音声モードに影響されにくく、より確実に拾える。
public class RemotePttModule: Module {
  private var started = false
  private var keyboardConnectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("RemotePtt")
    Events("onToggle")

    // どのネイティブビルドが実機に入っているかを判別するためのタグ。
    Constants([
      "buildTag": "ptt-fix-8"
    ])

    // 購読を開始する。
    Function("start") { [weak self] in
      guard let self = self, !self.started else { return }
      self.started = true
      self.startRemoteCommands()
      self.startKeyboard()
    }

    // 購読を停止する。
    Function("stop") { [weak self] in
      guard let self = self, self.started else { return }
      self.started = false
      self.stopRemoteCommands()
      self.stopKeyboard()
    }
  }

  // MARK: - 1. イヤホンの再生/停止ボタン (MPRemoteCommandCenter)

  private func startRemoteCommands() {
    // Now Playing 情報が無いとボタンイベントが届かないため、最小の情報をセット。
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "MIRISE Intercom",
      MPNowPlayingInfoPropertyPlaybackRate: 1.0,
    ]

    let center = MPRemoteCommandCenter.shared()
    let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
      self?.sendEvent("onToggle", [:])
      return .success
    }

    // 機種によって送られてくるコマンドが異なるため、代表的なものをまとめて購読。
    center.togglePlayPauseCommand.isEnabled = true
    center.togglePlayPauseCommand.addTarget(handler: handler)
    center.playCommand.isEnabled = true
    center.playCommand.addTarget(handler: handler)
    center.pauseCommand.isEnabled = true
    center.pauseCommand.addTarget(handler: handler)
  }

  private func stopRemoteCommands() {
    let center = MPRemoteCommandCenter.shared()
    center.togglePlayPauseCommand.removeTarget(nil)
    center.playCommand.removeTarget(nil)
    center.pauseCommand.removeTarget(nil)
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  // MARK: - 2. キーを送るBLEリモコン (GameController キーボード入力)

  private func startKeyboard() {
    // すでに接続済みのキーボード(=BLEリモコン)にハンドラを付ける。
    if let input = GCKeyboard.coalesced?.keyboardInput {
      attachKeyHandler(input)
    }
    // 後からリモコンが接続された場合にも対応。
    keyboardConnectObserver = NotificationCenter.default.addObserver(
      forName: .GCKeyboardDidConnect, object: nil, queue: .main
    ) { [weak self] note in
      if let input = (note.object as? GCKeyboard)?.keyboardInput {
        self?.attachKeyHandler(input)
      }
    }
  }

  private func attachKeyHandler(_ input: GCKeyboardInput) {
    // 送信トグルに割り当てるキー。ページめくり器/指輪型リモコンが送る代表的なキーを網羅。
    let toggleKeys: Set<GCKeyCode> = [
      .returnOrEnter, .keypadEnter, .spacebar,
      .pageUp, .pageDown,
      .upArrow, .downArrow, .leftArrow, .rightArrow,
    ]
    input.keyChangedHandler = { [weak self] (_, _, keyCode, pressed) in
      // キーを「押した瞬間」だけ反応(離した時は無視)。
      guard pressed, toggleKeys.contains(keyCode) else { return }
      self?.sendEvent("onToggle", [:])
    }
  }

  private func stopKeyboard() {
    GCKeyboard.coalesced?.keyboardInput?.keyChangedHandler = nil
    if let observer = keyboardConnectObserver {
      NotificationCenter.default.removeObserver(observer)
      keyboardConnectObserver = nil
    }
  }
}
