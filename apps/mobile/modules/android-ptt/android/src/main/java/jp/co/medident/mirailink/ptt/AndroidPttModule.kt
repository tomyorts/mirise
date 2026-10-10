package jp.co.medident.mirailink.ptt

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android版の「勤務中サービス」を JS から操作するモジュール。
// start: 出勤時(画面が前面にある時)に呼ぶ。stop: 退勤時に呼ぶ。
// onMediaButton: イヤホンのボタンが押されたら { key } を JS へ送る。
// armAutoOff / cancelAutoOff / onAutoOff: 送信の自動停止(切り忘れ防止)用のタイマー。
class AndroidPttModule : Module() {
  // 自動停止のタイマー。なぜネイティブに置くか: React Native(Android)は画面ロックで
  // アクティビティが一時停止すると JS の setTimeout を発火させない。ロック中・ポケットの
  // 中で始まった送信(物理ボタン・イヤホンのボタン)の自動停止が効かず、マイクが開いた
  // ままになる(ホットマイク)。メインスレッドの Handler は勤務中サービスの WakeLock の
  // 下で動き続け、イベントは画面ロック中も JS に届く(イヤホンのボタンと同じ経路)。
  // autoOffRunnable はメインスレッドでのみ触る。
  private val timerHandler: Handler = Handler(Looper.getMainLooper())
  private var autoOffRunnable: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("AndroidPtt")
    Events("onMediaButton", "onAutoOff")

    // どのネイティブビルドが入っているかを判別するためのタグ。
    Constants("buildTag" to "android-2")

    OnCreate {
      PttService.listener = { key ->
        sendEvent("onMediaButton", mapOf("key" to key))
      }
    }

    OnDestroy {
      PttService.listener = null
      // 作り直された JS に古い予約の停止通知を送らない。
      timerHandler.removeCallbacksAndMessages(null)
    }

    Function("start") { title: String ->
      val context = appContext.reactContext ?: return@Function false
      val intent = Intent(context, PttService::class.java).putExtra(PttService.EXTRA_TITLE, title)
      ContextCompat.startForegroundService(context, intent)
      true
    }

    Function("stop") {
      val context = appContext.reactContext ?: return@Function false
      context.stopService(Intent(context, PttService::class.java))
      true
    }

    Function("isRunning") {
      PttService.running
    }

    // 音楽アプリなどに取られたイヤホンのボタンの受け取り先を取り戻す。
    Function("reclaim") {
      PttService.reclaim()
    }

    // ms ミリ秒後に onAutoOff { id } を JS へ送る(前の予約は取り消す)。
    // id は JS 側の予約番号。取り消しと発火が行き違った古い通知を JS が見分けるために返す。
    Function("armAutoOff") { ms: Double, id: Double ->
      val delayMs: Long = if (ms > 0.0) ms.toLong() else 0L
      timerHandler.post { armAutoOffMain(delayMs, id) }
      true
    }

    Function("cancelAutoOff") {
      timerHandler.post { cancelAutoOffMain() }
      true
    }
  }

  private fun armAutoOffMain(delayMs: Long, id: Double) {
    cancelAutoOffMain()
    val r = Runnable {
      autoOffRunnable = null
      sendEvent("onAutoOff", mapOf("id" to id))
    }
    autoOffRunnable = r
    timerHandler.postDelayed(r, delayMs)
  }

  private fun cancelAutoOffMain() {
    val r: Runnable = autoOffRunnable ?: return
    autoOffRunnable = null
    timerHandler.removeCallbacks(r)
  }
}
