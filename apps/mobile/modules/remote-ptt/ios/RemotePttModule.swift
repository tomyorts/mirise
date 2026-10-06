import ExpoModulesCore
import GameController

// キーボードとしてキーを送るBLEリモコン(ページめくり器/シャッター等)の押下で、
// 送信ON/OFF(トグル)するモジュール。押下で JS へ onToggle を送る。
// GameController を使うため、画面ONのときのみ有効(ロック中はiOSがFace IDを要求する)。
//
// Bluetoothイヤホンのボタンはここでは扱わない。Apple PushToTalk の
// setAccessoryButtonEventsEnabled(PttChannelModule)で直接受け取る。
// (以前ここにあった MPRemoteCommandCenter でメディアボタンを横取りする方式は、
// iOSが「音楽を再生しているアプリ」にしか主導権を渡さないため実機で機能せず、
// 削除した。)
public class RemotePttModule: Module {
  private var started = false
  private var keyboardConnectObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("RemotePtt")
    Events("onToggle")

    // どのネイティブビルドが実機に入っているかを判別するためのタグ。
    Constants([
      "buildTag": "polish-1"
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
