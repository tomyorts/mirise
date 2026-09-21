import ExpoModulesCore
import GameController
import MediaPlayer

// 物理ボタンで送信ON/OFF(トグル)するモジュール。押下で JS へ onToggle を送る。
// 2系統に対応:
//   1. キーボードとしてキーを送るBLEリモコン(ページめくり器/シャッター等)
//      → GameController。画面ONのときのみ有効(ロック中はiOSがFace IDを要求する)。
//   2. Bluetoothイヤホンの再生/一時停止ボタン → MPRemoteCommandCenter。
//
// 2について: AppleのPushToTalkには setAccessoryButtonEventsEnabled という
// アクセサリボタン対応APIがあるが、実機検証の結果AirPodsでは機能せず、軸押しは
// 音楽アプリの再生/停止として消費されてしまうことが分かった(Apple純正の独自
// プロトコルのため、PTTが対象とする「classic Bluetoothの標準メディア操作」に
// 当てはまらないと思われる)。
// そこで、メディア操作としてシステムに届いている押下をこちらで受け取り、
// PTT送信のトグルに変換する。
//
// 副作用の注意: MPNowPlayingInfoCenter に情報を登録すると、iOSはこのアプリを
// 「音楽再生中」として扱うため、ロック画面がメディアウィジェットに占領され、
// PushToTalkのシステムUI(ロック解除なしのトークボタン)が表示されなくなる。
// イヤホンのボタンが使えるならトークボタンは不要なので割り切るが、切り替えて
// 比較できるよう setMediaButtonEnabled で有効/無効を制御できるようにしている。
public class RemotePttModule: Module {
  private var started = false
  private var mediaEnabled = false
  private var keyboardConnectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("RemotePtt")
    Events("onToggle")

    // どのネイティブビルドが実機に入っているかを判別するためのタグ。
    Constants([
      "buildTag": "earbud-3"
    ])

    // 購読を開始する。
    Function("start") { [weak self] in
      guard let self = self, !self.started else { return }
      self.started = true
      self.startKeyboard()
    }

    // 購読を停止する。
    Function("stop") { [weak self] in
      guard let self = self, self.started else { return }
      self.started = false
      self.stopKeyboard()
      self.stopMediaCommands()
    }

    // イヤホンの再生/一時停止ボタンを送信トグルとして使うかどうか。
    // 有効にするとロック画面のPTTトークボタンは出なくなる(上のコメント参照)。
    Function("setMediaButtonEnabled") { [weak self] (enabled: Bool) in
      guard let self = self else { return }
      if enabled {
        self.startMediaCommands()
      } else {
        self.stopMediaCommands()
      }
    }

    // 現在イヤホンボタンが有効か。
    Function("isMediaButtonEnabled") { [weak self] () -> Bool in
      return self?.mediaEnabled ?? false
    }
  }

  // MARK: - イヤホンの再生/一時停止ボタン (MPRemoteCommandCenter)

  private func startMediaCommands() {
    guard !mediaEnabled else { return }
    mediaEnabled = true

    // Now Playing 情報が無いとメディアボタンのイベントが届かないため、最小限を登録する。
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: "MIRISE インカム",
      MPNowPlayingInfoPropertyPlaybackRate: 1.0,
    ]

    let center = MPRemoteCommandCenter.shared()
    let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
      self?.sendEvent("onToggle", ["source": "イヤホンのボタン"])
      return .success
    }
    // 機種によって送られてくるコマンドが異なるため、代表的なものをまとめて購読する。
    for command in [
      center.togglePlayPauseCommand,
      center.playCommand,
      center.pauseCommand,
    ] {
      command.isEnabled = true
      command.addTarget(handler: handler)
    }
  }

  private func stopMediaCommands() {
    guard mediaEnabled else { return }
    mediaEnabled = false
    let center = MPRemoteCommandCenter.shared()
    for command in [
      center.togglePlayPauseCommand,
      center.playCommand,
      center.pauseCommand,
    ] {
      command.removeTarget(nil)
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  // MARK: - キーを送るBLEリモコン (GameController キーボード入力)

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
