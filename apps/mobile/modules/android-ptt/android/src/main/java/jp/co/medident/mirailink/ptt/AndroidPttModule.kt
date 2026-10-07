package jp.co.medident.mirailink.ptt

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Android版の「勤務中サービス」を JS から操作するモジュール。
// start: 出勤時(画面が前面にある時)に呼ぶ。stop: 退勤時に呼ぶ。
// onMediaButton: イヤホンのボタンが押されたら { key } を JS へ送る。
class AndroidPttModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AndroidPtt")
    Events("onMediaButton")

    // どのネイティブビルドが入っているかを判別するためのタグ。
    Constants("buildTag" to "android-1")

    OnCreate {
      PttService.listener = { key ->
        sendEvent("onMediaButton", mapOf("key" to key))
      }
    }

    OnDestroy {
      PttService.listener = null
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
  }
}
