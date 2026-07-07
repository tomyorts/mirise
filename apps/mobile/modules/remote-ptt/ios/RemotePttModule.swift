import ExpoModulesCore
import MediaPlayer

// Bluetoothイヤホン等の「再生/停止」ボタンを iOS のリモートコマンドとして受け取り、
// JS 側へ onToggle イベントを送るだけの最小モジュール。
// これにより「イヤホンのボタンで送信ON/OFF（トグル）」が実現できる。
public class RemotePttModule: Module {
  private var started = false

  public func definition() -> ModuleDefinition {
    Name("RemotePtt")
    Events("onToggle")

    // リモートコマンドの購読を開始する。
    Function("start") { [weak self] in
      guard let self = self, !self.started else { return }
      self.started = true

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

    // 購読を停止する。
    Function("stop") { [weak self] in
      guard let self = self, self.started else { return }
      self.started = false

      let center = MPRemoteCommandCenter.shared()
      center.togglePlayPauseCommand.removeTarget(nil)
      center.playCommand.removeTarget(nil)
      center.pauseCommand.removeTarget(nil)
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
  }
}
