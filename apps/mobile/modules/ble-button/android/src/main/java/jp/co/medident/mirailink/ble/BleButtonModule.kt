package jp.co.medident.mirailink.ble

import android.content.Context
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// BLEボタン(iTag型・PTTボタン)を JS から操作するモジュール(Android版)。
// iPhone版(ios/BleButtonModule.swift)と同じ名前・関数・イベントを持つので、
// App.tsx は機種を問わず同じ書き方で使える。
//
// 実際の Bluetooth 処理はプロセスに1つだけの BleButtonClient が持つ
// (JS の再読み込みでモジュールが作り直されても、接続と状態を二重に持たないため)。
// このクラスは JS との橋渡しだけを行う。
class BleButtonModule : Module() {
  // このモジュールが登録した送信先。再読み込みで新旧のモジュールが入れ替わる時、
  // 古い方の OnDestroy が新しい送信先を消してしまわないよう、自分の分だけを覚えておく。
  private var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  override fun definition() = ModuleDefinition {
    Name("BleButton")

    Events("onPress", "onStateChanged")

    // どのネイティブビルドが入っているかを判別するためのタグ。
    Constants("buildTag" to "android-button-1")

    OnCreate {
      val e: (String, Map<String, Any?>) -> Unit = { name, body ->
        sendEvent(name, body)
      }
      emitter = e
      val context = applicationContext()
      if (context != null) {
        // 登録済みボタンがあれば、起動直後から接続維持を始める。
        BleButtonClient.attach(context, e)
      }
    }

    OnDestroy {
      BleButtonClient.detach(emitter)
      emitter = null
    }

    // JS が押下イベントの購読を始めた/やめた。購読前に届いた押下を
    // 後追いで渡すため(起動直後の一押し目を無駄にしない)に使う。
    OnStartObserving("onPress") {
      BleButtonClient.setObserving(true)
    }
    OnStopObserving("onPress") {
      BleButtonClient.setObserving(false)
    }

    // 登録済みボタンへの接続維持を(再)開始する。
    Function("start") {
      ensureClient()
      BleButtonClient.requestStart()
    }

    // 現在の状態: { registered, connected, ready, name?, holdCapable?, mode? }
    Function("getStatus") {
      ensureClient()
      BleButtonClient.status()
    }

    // 近くのボタンを探して登録する(前面での初期設定用)。
    // 実際に2回押されたことを確認してから確定し、{ name, holdCapable } を返す。
    AsyncFunction("startSetup") { promise: Promise ->
      ensureClient()
      BleButtonClient.requestSetup(promise)
    }

    // 登録を解除して切断する。
    Function("unregister") {
      ensureClient()
      BleButtonClient.requestUnregister()
    }

    // 長押しで話す("hold") / 押すたびに切り替える("toggle")。
    // 押すだけのボタン(iTag)は常に "toggle" なので無視される。
    Function("setMode") { mode: String ->
      ensureClient()
      BleButtonClient.requestMode(mode)
    }
  }

  private fun applicationContext(): Context? {
    val context: Context = appContext.reactContext ?: return null
    return context.applicationContext ?: context
  }

  // OnCreate の時点で Context が取れなかった場合に備えて、呼ばれるたびに確認する。
  private fun ensureClient() {
    val context = applicationContext() ?: return
    BleButtonClient.init(context)
  }
}
