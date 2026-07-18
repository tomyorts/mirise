import ExpoModulesCore
import GameController

// 物理ボタン(BLEリモコン=ページめくり器/シャッター/指輪型など、キーボードとして
// キーを送るタイプ)で送信ON/OFF(トグル)するモジュール。押下で JS へ onToggle を送る。
//
// 注意: 以前はイヤホンの再生/停止ボタン(MPRemoteCommandCenter + NowPlaying)にも
// 対応していたが削除した。NowPlaying情報を登録するとiOSがこのアプリを「音楽再生中」
// として扱い、ロック画面がメディアウィジェットに占領されて Apple PushToTalk の
// システムUI(ロック解除なしのトークボタン)が出なくなるため。イヤホンのメディア
// ボタンは通話中(HFP)はどのみち届かないことも実機で確認済み。
public class RemotePttModule: Module {
  private var started = false
  private var keyboardConnectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("RemotePtt")
    Events("onToggle")

    // どのネイティブビルドが実機に入っているかを判別するためのタグ。
    Constants([
      "buildTag": "ble-3"
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
    }
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
