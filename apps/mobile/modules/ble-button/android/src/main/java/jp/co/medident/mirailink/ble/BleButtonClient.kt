package jp.co.medident.mirailink.ble

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import java.util.Locale
import java.util.UUID

// BLEボタン(iTag型の紛失防止タグ / PTTボタン)をアプリで直接受ける処理(Android版)。
//
// なぜ必要か: スタッフはスマホをロックしたままポケットに入れて使う。イヤホンの
// ボタンは髪で覆われて押しにくいため、別体のBLEボタンを主な送信手段にする。
// これらのボタンはキーボード(HID)ではなく「GATT通知」という生の信号を送るので、
// 画面ロック中でもアプリ(勤務中サービスで常駐)が直接受け取れる。
//
// 設計上の要点(iPhone版と同じ不変条件。ホットマイク=誰も押していないのに
// マイクが開いたままになる事故を最優先で防ぐ):
// - 「押下」として扱う通知は、登録時に確定した『押下キャラクタリスティック』
//   からのもの、かつ登録済み機器(アドレス一致)からのもの、かつ購読の完了が
//   確認できた後のものに限る。
// - 登録は「実際にボタンが2回押されたこと」を確認してから確定する
//   (近くの無関係なFFE0機器を誤登録しない)。
// - 再接続は登録済み機器に対してのみ行う(解除済み・旧タグが送信を握る事故の防止)。
// - 長押し中(down)に接続が切れたら、必ず up を合成して送信を止める。
// - 連打・故障(押しっぱなしで信号が出続ける等)は流量制限で30秒止める。
// - 状態はすべてメインスレッドに閉じ込める。GATT/検索のコールバックは
//   バインダースレッドで届くため、必ずメインの Handler に載せ替えてから扱う。
//   (例外: getStatus 用の @Volatile の値と、スレッド安全な SharedPreferences)
// - GATT の読み書きは同時に1つだけ(Android は同時に複数出すと黙って失敗する)。
@SuppressLint("MissingPermission")
internal object BleButtonClient {
  // ---- UUID ----
  // iTag系の事実上の標準(FFE0/FFE1)と、一部の互換品(FFF0/FFF1)。
  private val SERVICE_FFE0: UUID = uuid16("ffe0")
  private val CHAR_FFE1: UUID = uuid16("ffe1")
  private val SERVICE_FFF0: UUID = uuid16("fff0")
  private val CHAR_FFF1: UUID = uuid16("fff1")
  // キーボード型(HID)。ロック中は使えないので候補にしない。
  private val SERVICE_HID: UUID = uuid16("1812")
  // 通知の購読設定(CCCD)。
  private val DESCRIPTOR_CCCD: UUID = uuid16("2902")
  // 切断時に鳴る警報(Link Loss)と、鳴っている警報を止める即時警報(Immediate Alert)。
  private val SERVICE_LINK_LOSS: UUID = uuid16("1803")
  private val SERVICE_IMMEDIATE_ALERT: UUID = uuid16("1802")
  private val CHAR_ALERT_LEVEL: UUID = uuid16("2a06")

  // ---- 時間・回数 ----
  // 登録時の検索時間。
  private const val SCAN_WINDOW_MS = 10_000L
  // 十分近い候補が見つかったら、少しだけ待って検索を切り上げる(待ち時間の短縮)。
  private const val SCAN_EARLY_FINISH_MS = 2_000L
  private const val STRONG_RSSI = -65
  // これより弱い電波の機器は「手元のボタン」ではないとみなす
  // (Android は機種により電波強度の値が低めに出るため、iPhone版より少し緩くする)。
  private const val SETUP_MIN_RSSI = -85
  // 1回の登録で接続を試す候補の数(近い順)。
  private const val MAX_SETUP_CANDIDATES = 3
  // 候補ごとの「接続〜購読完了」の期限。
  private const val SETUP_CONNECT_TIMEOUT_MS = 12_000L
  // 候補ごとの「2回押し」の待ち時間。
  private const val SETUP_CONFIRM_TIMEOUT_MS = 25_000L
  // どの経路でも必ず結末がつくようにする登録全体の期限。
  private const val SETUP_MASTER_TIMEOUT_MS = 90_000L
  // 登録確定に必要な「2回の通知」の最小間隔(1回の押下で連続して届く通知を除くため)。
  private const val CONFIRM_MIN_GAP_MS = 300L
  // 条件成立後、少し見届けてから確定する(直後の 0x00 で長押し対応を判定し、
  // 通知を流し続ける機器=センサー等を弾くため)。
  private const val CONFIRM_SETTLE_MS = 700L
  // 登録確認中にこれを超える通知が来た機器はボタンではないとみなす。
  private const val SETUP_FLOOD_LIMIT = 8
  // 購読直後に一部機種が勝手に送る「現在値」を押下と誤認しないための猶予。
  // 通常運用では誤送信(ホットマイク)に直結するので長めにとる。
  private const val SUBSCRIBE_GRACE_MS = 1_000L
  // 登録確認中の猶予。「2回押して」の案内直後の素早い1回目を捨てないよう短くする
  // (ここで初期値を1回数えても、確定にはもう1回の実押下が必要なので安全側)。
  private const val SETUP_SUBSCRIBE_GRACE_MS = 300L
  // 登録確定の直後に押下を無視する時間(確認用の2回押しの残りで送信が始まらないように)。
  private const val POST_CONFIRM_QUIET_MS = 1_000L
  // トグル操作(押すたびにON/OFF)の連打・多重通知の抑制。
  private const val TOGGLE_DEBOUNCE_MS = 800L
  // 流量制限: 2秒間に4回を超える通知が来たら、30秒間ボタンを止める。
  private const val RATE_WINDOW_MS = 2_000L
  private const val RATE_MAX_NOTIFICATIONS = 4
  private const val MUTE_MS = 30_000L
  // 同じ通知の二重受信とみなす間隔。
  private const val DUPLICATE_WINDOW_MS = 50L
  // GATT 操作1つあたりの期限(応答が来ない機種でも次の操作へ進めるため)。
  private const val OP_TIMEOUT_MS = 3_000L
  // JS の購読前に届いたトグル押下を後追いで渡す期限。長いと「押したのに反応せず、
  // 忘れた頃に送信が始まる」事故になるため短くする(離す=up は期限なしで届ける)。
  private const val PENDING_REPLAY_MAX_MS = 3_000L
  // 再接続の待ち時間(失敗が続くほど延ばす)。
  private const val RECONNECT_DELAY_MS = 1_000L
  private const val RECONNECT_MAX_DELAY_MS = 60_000L
  // 多くの端末で「接続失敗(原因不明)」を表すステータス。
  private const val GATT_ERROR_133 = 133

  private const val KIND_TOGGLE = "toggle"
  private const val KIND_DOWN = "down"
  private const val KIND_UP = "up"

  private const val PERMISSION_MESSAGE =
    "Bluetoothの許可がありません。設定から『付近のデバイス』を許可してください"
  private const val LOCATION_PERMISSION_MESSAGE =
    "ボタンの検索には位置情報の許可が必要です(Android 11以前の仕様)。設定からアプリの位置情報を許可してください"

  private val handler = Handler(Looper.getMainLooper())

  // ---- JS との接続 ----
  @Volatile private var context: Context? = null
  @Volatile private var emitter: ((String, Map<String, Any?>) -> Unit)? = null
  private var receiverRegistered = false
  // JS が onPress を購読中か(メインスレッドのみ)。
  private var observing = false
  // 購読前に届いたトグル押下の時刻(0=なし)。
  private var pendingToggleAt = 0L
  // 購読していない間に送った up(送信停止)。購読再開時に念のため送り直す。
  private var pendingUp = false

  // ---- GATT 接続(メインスレッドのみ) ----
  private var gatt: BluetoothGatt? = null
  // true: 登録作業中の候補への接続 / false: 登録済みボタンへの通常の接続。
  private var gattForSetup = false
  // 購読が完了した押下キャラクタリスティック(購読完了前は null)。
  private var pressChar: BluetoothGattCharacteristic? = null
  private var subscribedAt = 0L
  // この時刻までは押下(非0)を無視する(購読直後の初期値・登録直後の残りの押下)。
  private var pressQuietUntil = 0L
  // この接続で一度でも使える状態(購読完了)になったか。
  private var sessionReady = false
  // 使える状態になれないまま切れた回数(再接続の待ち時間を延ばすため)。
  private var reconnectFailures = 0
  private val reconnectRunnable = Runnable { startIfRegistered() }

  // getStatus(JSスレッド)から読む値。
  @Volatile private var statusConnected = false
  @Volatile private var statusReady = false

  // ---- GATT 操作の順番待ち ----
  private class GattOp(
    val isDescriptor: Boolean,
    val start: (BluetoothGatt) -> Boolean,
    val done: ((Boolean) -> Unit)?
  )

  private val ops: MutableList<GattOp> = mutableListOf()
  private var opInFlight: GattOp? = null
  private val opTimeoutRunnable = Runnable { finishOp(null, false) }

  // ---- 押下の状態 ----
  // 長押しモードで down を送った(=送信中のはず)か。
  private var isDown = false
  // ボタンが物理的に押されているか(離した信号を送るボタンのみ。押した瞬間の判定用)。
  private var rawDown = false
  private var lastToggleAt = 0L
  private val recentNotifications: MutableList<Long> = mutableListOf()
  // 直前の通知(同じ通知が二重に届く機種への備え。1回の押下を2回と数えない)。
  private var lastNotifyAt = 0L
  private var lastNotifyValue: ByteArray = ByteArray(0)
  private var mutedUntil = 0L
  private val unmuteRunnable = Runnable { onMuteEnded() }

  // ---- 登録作業(スキャン→接続→2回押しで確定) ----
  private class Candidate(
    val device: BluetoothDevice,
    var rssi: Int,
    var name: String
  )

  private var setupPromise: Promise? = null
  private var scanner: BluetoothLeScanner? = null
  private var scanning = false
  private var earlyFinishArmed = false
  private val candidates: MutableMap<String, Candidate> = mutableMapOf()
  private val setupQueue: MutableList<Candidate> = mutableListOf()
  private var currentCandidate: Candidate? = null
  private var awaitingConfirm = false
  private var confirmCount = 0
  private var confirmFirstAt = 0L
  private var confirmSawPressed = false
  private var confirmHoldCapable = false
  private var confirmLastPressed = false
  // 確定条件が成立し、見届け中(CONFIRM_SETTLE_MS)か。
  private var confirmSettling = false
  private val confirmSettleRunnable = Runnable { finalizeConfirm() }
  private val scanWindowRunnable = Runnable { finishScanWindow() }
  private val connectTimeoutRunnable = Runnable { onSetupCandidateFailed("接続できませんでした") }
  private val confirmTimeoutRunnable = Runnable { onSetupCandidateFailed("押下を確認できませんでした") }
  private val masterTimeoutRunnable = Runnable {
    failSetup("E_TIMEOUT", "時間切れです。もう一度お試しください")
  }

  // =====================================================================
  // 公開操作(どのスレッドから呼ばれてもよい。状態の変更はメインへ載せ替える)
  // =====================================================================

  @Synchronized
  fun init(ctx: Context) {
    val app: Context = ctx.applicationContext ?: ctx
    if (context == null) {
      context = app
    }
    if (!receiverRegistered) {
      receiverRegistered = true
      registerBluetoothStateReceiver(app)
    }
  }

  fun attach(ctx: Context, e: (String, Map<String, Any?>) -> Unit) {
    init(ctx)
    emitter = e
    handler.post { startIfRegistered() }
  }

  // 自分が登録した送信先の場合だけ外す(再読み込みで新しい送信先を消さないため)。
  fun detach(e: ((String, Map<String, Any?>) -> Unit)?) {
    if (e == null || emitter !== e) return
    emitter = null
    handler.post { observing = false }
  }

  fun setObserving(value: Boolean) {
    handler.post { setObservingMain(value) }
  }

  fun requestStart() {
    handler.post { startIfRegistered() }
  }

  fun requestSetup(promise: Promise) {
    handler.post { startSetup(promise) }
  }

  fun requestUnregister() {
    // getStatus が直後に呼ばれても「未登録」を返せるよう、保存情報はこの場で消す。
    // (メインで処理中の通知も、登録情報が無ければ押下にならない=安全側に倒れる)
    context?.let { BleButtonStore.clear(it) }
    handler.post { unregisterMain() }
  }

  fun requestMode(mode: String) {
    if (mode != BleButtonStore.MODE_TOGGLE && mode != BleButtonStore.MODE_HOLD) return
    val ctx = context ?: return
    val reg = BleButtonStore.load(ctx) ?: return
    // 押すだけのボタンは離した信号が無いので、長押しモードにはできない(常にトグル)。
    if (!reg.holdCapable) return
    // getStatus が直後に呼ばれても新しいモードを返せるよう、この場で保存する。
    BleButtonStore.saveMode(ctx, mode)
    handler.post {
      // 長押しで送信中にトグルへ切り替えたら、送信を止めてから切り替える
      // (以後 up を扱わなくなり、送信が止められなくなるのを防ぐ)。
      if (mode != BleButtonStore.MODE_HOLD) releaseIfDown()
    }
  }

  fun status(): Map<String, Any?> {
    val ctx = context
    val reg = if (ctx != null) BleButtonStore.load(ctx) else null
    if (reg == null) {
      return mapOf<String, Any?>("registered" to false, "connected" to false, "ready" to false)
    }
    return mapOf<String, Any?>(
      "registered" to true,
      "connected" to statusConnected,
      "ready" to statusReady,
      "name" to reg.name,
      "holdCapable" to reg.holdCapable,
      "mode" to reg.mode
    )
  }

  // =====================================================================
  // JS への通知(メインスレッドから呼ぶ)
  // =====================================================================

  private fun emit(name: String, body: Map<String, Any?>) {
    val e = emitter ?: return
    try {
      e(name, body)
    } catch (_: Exception) {
      // JS の再読み込み中などで送れなくても、Bluetooth 側の処理は止めない。
    }
  }

  private fun emitState(state: String, detail: String) {
    val payload: MutableMap<String, Any?> = mutableMapOf("state" to state, "detail" to detail)
    val ctx = context
    val reg = if (ctx != null) BleButtonStore.load(ctx) else null
    if (reg != null) {
      payload["name"] = reg.name
    }
    emit("onStateChanged", payload)
  }

  private fun setObservingMain(value: Boolean) {
    observing = value
    if (!value || emitter == null) return
    // 購読していない間に送った up は、念のため送り直す(送信停止は何度送っても安全)。
    if (pendingUp) {
      pendingUp = false
      emit("onPress", mapOf<String, Any?>("kind" to KIND_UP, "replayed" to true))
    }
    // 購読前に届いたトグル押下(起動直後の一押し目)を後追いで渡す。古すぎるものは捨てる。
    if (pendingToggleAt > 0L) {
      val age = SystemClock.elapsedRealtime() - pendingToggleAt
      pendingToggleAt = 0L
      if (age in 0L..PENDING_REPLAY_MAX_MS) {
        emit(
          "onPress",
          mapOf<String, Any?>("kind" to KIND_TOGGLE, "replayed" to true, "ageMs" to age.toDouble())
        )
      }
    }
  }

  private fun emitToggle(at: Long) {
    if (observing && emitter != null) {
      emit("onPress", mapOf<String, Any?>("kind" to KIND_TOGGLE))
    } else {
      pendingToggleAt = at
    }
  }

  private fun emitDown() {
    // JS が聞いていない時の down は捨てる(後から送ると、誰も押していないのに
    // 送信が始まる恐れがあるため。トグルと違い後追いはしない)。
    if (!observing || emitter == null) return
    isDown = true
    emit("onPress", mapOf<String, Any?>("kind" to KIND_DOWN))
  }

  // 長押しで送信中なら up を送って止める。接続断・解除・流量制限・モード変更など
  // 「この後の離した信号を受け取れない/扱わない」時に必ず呼ぶ(ホットマイク防止)。
  private fun releaseIfDown() {
    if (!isDown) return
    isDown = false
    emitUp()
  }

  private fun emitUp() {
    if (!observing || emitter == null) {
      pendingUp = true
    }
    emit("onPress", mapOf<String, Any?>("kind" to KIND_UP))
  }

  // =====================================================================
  // 通常運用: 登録済みボタンへの接続維持
  // =====================================================================

  private fun startIfRegistered() {
    if (setupPromise != null) return
    val ctx = context ?: return
    val reg = BleButtonStore.load(ctx) ?: return
    val current = gatt
    if (current != null) {
      // 登録済みボタンへ接続中/接続待ちならそのまま(二重に接続しない)。
      if (!gattForSetup && current.device.address.equals(reg.address, ignoreCase = true)) return
      closeGatt()
    }
    handler.removeCallbacks(reconnectRunnable)
    val adapter = bluetoothAdapter(ctx)
    if (adapter == null) {
      emitState("error", "この端末はBluetoothに対応していません")
      return
    }
    if (!hasConnectPermission(ctx)) {
      emitState("error", PERMISSION_MESSAGE)
      return
    }
    try {
      if (!adapter.isEnabled) {
        // オンになったら受信機(ACTION_STATE_CHANGED)が再開する。
        emitState("error", "Bluetoothがオフになっています")
        return
      }
      val device: BluetoothDevice = adapter.getRemoteDevice(reg.address)
      // autoConnect=true: ボタンが眠っていても、次に電波を出した時に OS が自動で繋ぐ
      // (期限なしで待ち続けるので、ポケットの中で一日中使える)。
      val g: BluetoothGatt? = device.connectGatt(ctx, true, gattCallback, BluetoothDevice.TRANSPORT_LE)
      if (g == null) {
        onRuntimeLinkLost(false)
        return
      }
      gatt = g
      gattForSetup = false
      sessionReady = false
      pressChar = null
      emitState("connecting", "登録済みボタンへ接続中...")
    } catch (_: SecurityException) {
      emitState("error", PERMISSION_MESSAGE)
    } catch (_: IllegalArgumentException) {
      emitState("error", "登録情報を読み取れませんでした。一度「登録を解除」して再登録してください")
    }
  }

  // 通常運用の接続が切れた/使えなかった: 閉じてから、間を置いて接続待ちを出し直す。
  // announce=false: 直前に出したエラーの案内文を「切断されました」で上書きしない。
  private fun onRuntimeLinkLost(wasReady: Boolean, announce: Boolean = true) {
    closeGatt()
    val ctx = context ?: return
    if (BleButtonStore.load(ctx) == null) return
    if (wasReady) {
      reconnectFailures = 0
    } else {
      reconnectFailures += 1
    }
    val adapter = bluetoothAdapter(ctx)
    val enabled = try {
      adapter?.isEnabled == true
    } catch (_: SecurityException) {
      false
    }
    if (!enabled) {
      // Bluetooth がオフ。オンになったら受信機が再開する(ここで再試行を繰り返さない)。
      emitState("error", "Bluetoothがオフになっています")
      return
    }
    if (announce) {
      emitState("disconnected", "切断されました。再接続を待機します")
    }
    // 即座に出し直し続けると失敗ループで電池を消耗するため、失敗が続くほど間を空ける。
    val delay: Long = if (reconnectFailures <= 0) {
      RECONNECT_DELAY_MS
    } else {
      val shift: Int = minOf(reconnectFailures - 1, 5)
      minOf(2_000L shl shift, RECONNECT_MAX_DELAY_MS)
    }
    handler.removeCallbacks(reconnectRunnable)
    handler.postDelayed(reconnectRunnable, delay)
  }

  private fun unregisterMain() {
    if (setupPromise != null) {
      failSetup("E_CANCELLED", "登録を中断しました")
    }
    handler.removeCallbacks(reconnectRunnable)
    closeGatt()
    // 解除と同時に登録作業が確定していた場合にも、確実に未登録にする。
    context?.let { BleButtonStore.clear(it) }
    handler.removeCallbacks(unmuteRunnable)
    mutedUntil = 0L
    recentNotifications.clear()
    pendingToggleAt = 0L
    reconnectFailures = 0
    emitState("idle", "登録を解除しました")
  }

  // 現在の接続を完全に閉じる(閉じた後はこの接続のコールバックは来ない)。
  private fun closeGatt() {
    releaseIfDown()
    resetOps()
    val g = gatt
    gatt = null
    gattForSetup = false
    pressChar = null
    sessionReady = false
    rawDown = false
    statusConnected = false
    statusReady = false
    if (g != null) {
      try {
        g.disconnect()
      } catch (_: Exception) {
      }
      try {
        g.close()
      } catch (_: Exception) {
      }
    }
  }

  // =====================================================================
  // 登録作業(前面のみ)
  // =====================================================================

  private fun startSetup(promise: Promise) {
    val ctx = context
    if (ctx == null) {
      promise.reject("E_INTERNAL", "Bluetoothを初期化できませんでした", null)
      return
    }
    if (setupPromise != null) {
      promise.reject("E_BUSY", "すでに検索中です", null)
      return
    }
    if (!ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      promise.reject("E_UNSUPPORTED", "この端末はBluetooth LEに対応していません", null)
      return
    }
    val adapter = bluetoothAdapter(ctx)
    if (adapter == null) {
      promise.reject("E_UNSUPPORTED", "この端末はBluetoothに対応していません", null)
      return
    }
    val missing = missingSetupPermission(ctx)
    if (missing != null) {
      promise.reject("E_UNAUTHORIZED", missing, null)
      return
    }
    val sc: BluetoothLeScanner? = try {
      if (adapter.isEnabled) adapter.bluetoothLeScanner else null
    } catch (_: SecurityException) {
      promise.reject("E_UNAUTHORIZED", PERMISSION_MESSAGE, null)
      return
    }
    if (sc == null) {
      promise.reject("E_POWERED_OFF", "Bluetoothがオフです。設定でオンにしてください", null)
      return
    }

    // 再登録に備えて既存の接続は解除しておく(失敗時は failSetup で復旧する)。
    handler.removeCallbacks(reconnectRunnable)
    closeGatt()
    setupPromise = promise
    resetSetupState()
    handler.postDelayed(masterTimeoutRunnable, SETUP_MASTER_TIMEOUT_MS)

    val settings: ScanSettings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .build()
    try {
      // フィルターなしで検索し、候補の条件(FFE0/FFF0の広告 or 名前)は結果側で判定する
      // (広告にサービスUUIDを載せず、名前だけのボタンがあるため)。
      sc.startScan(ArrayList<ScanFilter>(), settings, scanCallback)
    } catch (_: SecurityException) {
      failSetup("E_UNAUTHORIZED", PERMISSION_MESSAGE)
      return
    } catch (_: Exception) {
      failSetup("E_SCAN_FAILED", "検索を開始できませんでした。Bluetoothを入れ直してお試しください")
      return
    }
    scanner = sc
    scanning = true
    handler.postDelayed(scanWindowRunnable, SCAN_WINDOW_MS)
    emitState("scanning", "近くのボタンを検索中...ボタンを1回押してください")
  }

  private fun resetSetupState() {
    candidates.clear()
    setupQueue.clear()
    currentCandidate = null
    earlyFinishArmed = false
    resetConfirmState()
  }

  private fun resetConfirmState() {
    awaitingConfirm = false
    confirmCount = 0
    confirmFirstAt = 0L
    confirmSawPressed = false
    confirmHoldCapable = false
    confirmLastPressed = false
    confirmSettling = false
    handler.removeCallbacks(confirmSettleRunnable)
  }

  private fun cancelSetupTimers() {
    handler.removeCallbacks(scanWindowRunnable)
    handler.removeCallbacks(connectTimeoutRunnable)
    handler.removeCallbacks(confirmTimeoutRunnable)
    handler.removeCallbacks(confirmSettleRunnable)
    handler.removeCallbacks(masterTimeoutRunnable)
  }

  private fun stopScan() {
    val sc = scanner
    scanner = null
    if (!scanning) return
    scanning = false
    try {
      sc?.stopScan(scanCallback)
    } catch (_: Exception) {
      // Bluetooth がオフになった後などは止められないが、OS 側で止まっている。
    }
  }

  private val scanCallback: ScanCallback = object : ScanCallback() {
    override fun onScanResult(callbackType: Int, result: ScanResult) {
      handler.post { onScanResultMain(result) }
    }

    override fun onScanFailed(errorCode: Int) {
      handler.post {
        if (setupPromise != null && scanning) {
          scanning = false
          scanner = null
          failSetup("E_SCAN_FAILED", "検索を開始できませんでした(コード$errorCode)。Bluetoothを入れ直してお試しください")
        }
      }
    }
  }

  private fun onScanResultMain(result: ScanResult) {
    if (setupPromise == null || !scanning) return
    val device: BluetoothDevice = result.device ?: return
    val record = result.scanRecord
    val uuids: List<ParcelUuid> = record?.serviceUuids ?: emptyList()
    // キーボード型(HID)はロック中に使えないため候補にしない。
    if (uuids.any { it.uuid == SERVICE_HID }) return
    val name: String = (record?.deviceName ?: safeDeviceName(device) ?: "").trim()
    val lower = name.lowercase(Locale.ROOT)
    val advertisesButton = uuids.any { it.uuid == SERVICE_FFE0 || it.uuid == SERVICE_FFF0 }
    val nameMatches = lower.startsWith("itag") || lower.startsWith("ptt")
    if (!advertisesButton && !nameMatches) return
    val rssi = result.rssi
    if (rssi < SETUP_MIN_RSSI) return
    val address: String = device.address ?: return
    val existing = candidates[address]
    if (existing == null) {
      candidates[address] = Candidate(device, rssi, name)
      emitState("debug", "候補: ${name.ifEmpty { "(名称不明)" }} RSSI=$rssi")
    } else {
      // 同じ機器の広告は何度も届く。最も強い電波で更新する。
      if (rssi > existing.rssi) existing.rssi = rssi
      if (existing.name.isEmpty() && name.isNotEmpty()) existing.name = name
    }
    // 十分近い候補が見つかったら、他の候補を少しだけ待ってから検索を切り上げる。
    if (rssi >= STRONG_RSSI && !earlyFinishArmed) {
      earlyFinishArmed = true
      handler.removeCallbacks(scanWindowRunnable)
      handler.postDelayed(scanWindowRunnable, SCAN_EARLY_FINISH_MS)
    }
  }

  // 検索終了: 電波の強い順に接続試行キューを組み、先頭から1台ずつ
  // 「接続→購読→実際の2回押しで確定」を試す。
  private fun finishScanWindow() {
    if (setupPromise == null) return
    handler.removeCallbacks(scanWindowRunnable)
    stopScan()
    val ranked = candidates.values.sortedByDescending { it.rssi }.take(MAX_SETUP_CANDIDATES)
    setupQueue.clear()
    setupQueue.addAll(ranked)
    if (ranked.isEmpty()) {
      val hint = if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        "(Android 11以前は位置情報(GPS)をオンにしてください)"
      } else {
        ""
      }
      failSetup(
        "E_NOT_FOUND",
        "ボタンが見つかりませんでした。ボタンを1回押してから、スマホに近づけてもう一度お試しください$hint"
      )
      return
    }
    tryNextCandidate()
  }

  private fun onSetupCandidateFailed(reason: String) {
    if (setupPromise == null) return
    val name = currentCandidate?.name?.ifEmpty { null } ?: "(名称不明)"
    emitState("debug", "候補を見送り[$name]: $reason")
    tryNextCandidate()
  }

  // キューの先頭候補に接続を試す。接続失敗・押下確認失敗のたびに次の候補へ進む。
  private fun tryNextCandidate() {
    if (setupPromise == null) return
    handler.removeCallbacks(connectTimeoutRunnable)
    handler.removeCallbacks(confirmTimeoutRunnable)
    resetConfirmState()
    // 直前の候補(未登録)は必ず切り離す。
    closeGatt()
    currentCandidate = null
    if (setupQueue.isEmpty()) {
      failSetup(
        "E_CONFIRM_TIMEOUT",
        "ボタンを確定できませんでした。スマホの近くでボタンを短く2回押してください。もう一度お試しください"
      )
      return
    }
    val next = setupQueue.removeAt(0)
    currentCandidate = next
    val ctx = context
    if (ctx == null) {
      failSetup("E_INTERNAL", "Bluetoothを初期化できませんでした")
      return
    }
    val label = next.name.ifEmpty { "(名称不明)" }
    emitState("connecting", "接続中: $label(つながらない時はボタンを1回押してください)")
    val g: BluetoothGatt? = try {
      // 登録時は直接接続(autoConnect=false)。眠っているボタンも、押せば広告を出して繋がる。
      next.device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    } catch (_: SecurityException) {
      failSetup("E_UNAUTHORIZED", PERMISSION_MESSAGE)
      return
    }
    if (g == null) {
      // 次の候補へ(再帰を避けるため一度メインに戻す)。
      handler.post { onSetupCandidateFailed("接続を開始できませんでした") }
      return
    }
    gatt = g
    gattForSetup = true
    handler.postDelayed(connectTimeoutRunnable, SETUP_CONNECT_TIMEOUT_MS)
  }

  private fun beginConfirm() {
    handler.removeCallbacks(connectTimeoutRunnable)
    resetConfirmState()
    awaitingConfirm = true
    val label = currentCandidate?.name?.ifEmpty { null } ?: "BLEボタン"
    emitState("confirming", "「$label」に接続しました。ボタンを短く2回押してください")
    handler.removeCallbacks(confirmTimeoutRunnable)
    handler.postDelayed(confirmTimeoutRunnable, SETUP_CONFIRM_TIMEOUT_MS)
  }

  // 登録作業中の通知(押下候補キャラクタリスティックからのもののみ届く)。
  private fun onSetupNotification(value: ByteArray, at: Long) {
    if (setupPromise == null || !awaitingConfirm) return
    // 調査用: 何が届いたかを画面ログに出す(機種ごとの差を実機で確かめるため)。
    val hex = value.joinToString("") { b -> (b.toInt() and 0xff).toString(16).padStart(2, '0') }
    val inGrace = at - subscribedAt < SETUP_SUBSCRIBE_GRACE_MS
    emitState("debug", "通知受信 ${if (hex.isEmpty()) "空" else hex}${if (inGrace) "(初期値)" else ""}")
    if (inGrace || value.isEmpty()) return
    val pressed = value.any { it != 0.toByte() }
    if (pressed) {
      confirmSawPressed = true
    } else {
      // 押す前の「離した」信号(購読前から押されていた分)は数えない
      // (確定には必ず「押した」通知から数えて2回が必要)。
      if (!confirmSawPressed) return
      // 押した後に 0x00 が来た = 離した信号を別に送るボタン(長押しで話せる)。
      confirmHoldCapable = true
    }
    // 見届け中も数え続ける(直後の離した信号・通知の出し過ぎを判定するため)。
    confirmLastPressed = pressed
    confirmCount += 1
    if (confirmSettling) return
    if (confirmCount == 1) {
      confirmFirstAt = at
      // 進み具合を見せる(1回目が届いたと分かれば、もう1回押してもらえる)。
      emitState("confirming", "1回目を確認しました。もう1回押してください")
      return
    }
    // 2つの通知が0.3秒以上離れていれば「人が押した」とみなし、少し見届けてから確定する。
    if (at - confirmFirstAt >= CONFIRM_MIN_GAP_MS) {
      confirmSettling = true
      handler.removeCallbacks(confirmTimeoutRunnable)
      handler.removeCallbacks(confirmSettleRunnable)
      handler.postDelayed(confirmSettleRunnable, CONFIRM_SETTLE_MS)
      emitState("confirming", "ボタンの押下を確認しました。登録しています...")
    }
  }

  private fun finalizeConfirm() {
    confirmSettling = false
    if (setupPromise == null || !awaitingConfirm || !gattForSetup) return
    if (confirmCount > SETUP_FLOOD_LIMIT) {
      // 人の押下では出ない頻度で通知が来た = ボタンではない機器(センサー等)の可能性。
      onSetupCandidateFailed("通知が多すぎるため対象外にしました(${confirmCount}回)")
      return
    }
    confirmRegistration(SystemClock.elapsedRealtime())
  }

  private fun confirmRegistration(at: Long) {
    val ctx = context
    val g = gatt
    val c = pressChar
    val serviceUuid: UUID? = c?.service?.uuid
    if (ctx == null || g == null || c == null || serviceUuid == null) {
      onSetupCandidateFailed("登録情報を確定できませんでした")
      return
    }
    val address: String = g.device.address
    val name: String = currentCandidate?.name?.ifEmpty { null }
      ?: safeDeviceName(g.device)?.trim()?.ifEmpty { null }
      ?: "BLEボタン"
    val holdCapable: Boolean = confirmHoldCapable
    val lastPressed: Boolean = confirmLastPressed
    val mode = if (holdCapable) BleButtonStore.MODE_HOLD else BleButtonStore.MODE_TOGGLE
    BleButtonStore.save(
      ctx,
      BleButtonRegistration(address, name, serviceUuid, c.uuid, holdCapable, mode)
    )

    cancelSetupTimers()
    stopScan()
    setupQueue.clear()
    candidates.clear()
    currentCandidate = null
    resetConfirmState()

    // この接続をそのまま通常運用に引き継ぐ(切れたら autoConnect で繋ぎ直す)。
    gattForSetup = false
    sessionReady = true
    reconnectFailures = 0
    statusConnected = true
    statusReady = true
    isDown = false
    // 確定に使った押下が押されたままなら、次の 0x00 を正しく「離した」と扱えるよう覚えておく。
    rawDown = holdCapable && lastPressed
    // 確定に使った押下の続き(3回目の押下など)で、登録直後に送信が始まらないよう
    // 少しの間は押下を無視する(離した信号=送信停止は常に通す)。
    pressQuietUntil = at + POST_CONFIRM_QUIET_MS
    lastToggleAt = at
    recentNotifications.clear()
    mutedUntil = 0L
    handler.removeCallbacks(unmuteRunnable)

    val p = setupPromise
    setupPromise = null
    p?.resolve(mapOf<String, Any?>("name" to name, "holdCapable" to holdCapable))
    emitState("connected", "登録しました: $name")
  }

  private fun failSetup(code: String, message: String) {
    val p = setupPromise ?: return
    setupPromise = null
    cancelSetupTimers()
    stopScan()
    val wasSetupGatt = gattForSetup
    resetSetupState()
    // 登録作業用に接続した(未登録の)候補は必ず切り離す。
    if (wasSetupGatt) closeGatt()
    p.reject(code, message, null)
    val ctx = context
    val registered = ctx != null && BleButtonStore.load(ctx) != null
    emitState(if (registered) "disconnected" else "idle", message)
    // 既存の登録があれば接続維持を復旧する(失敗したまま放置しない)。
    startIfRegistered()
  }

  // =====================================================================
  // GATT コールバック(バインダースレッド → メインへ載せ替え)
  // =====================================================================

  // 引数は非null型で受ける(OS は該当する特性が見つからない時は呼ばずに捨てるため、
  // null は来ない。SDK 側で @NonNull が付いても付かなくてもコンパイルできる書き方)。
  private val gattCallback: BluetoothGattCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
      handler.post { onConnectionStateChangeMain(g, status, newState) }
    }

    override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
      handler.post { onServicesDiscoveredMain(g, status) }
    }

    override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      handler.post { onOpCallback(g, true, status == BluetoothGatt.GATT_SUCCESS) }
    }

    override fun onCharacteristicWrite(
      g: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      status: Int
    ) {
      handler.post { onOpCallback(g, false, status == BluetoothGatt.GATT_SUCCESS) }
    }

    // Android 12以前の通知。値は次の通知で上書きされうるので、この場で複製する。
    @Deprecated("Android 12以前用(13以降は下の値つき版が呼ばれる)")
    override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      deliverNotification(g, characteristic, legacyValue(characteristic))
    }

    // Android 13以降の通知(値が引数で渡される)。
    override fun onCharacteristicChanged(
      g: BluetoothGatt,
      characteristic: BluetoothGattCharacteristic,
      value: ByteArray
    ) {
      deliverNotification(g, characteristic, value.copyOf())
    }
  }

  @Suppress("DEPRECATION")
  private fun legacyValue(characteristic: BluetoothGattCharacteristic): ByteArray {
    val raw: ByteArray? = characteristic.value
    return raw?.copyOf() ?: ByteArray(0)
  }

  // 通知の識別情報と受信時刻はバインダースレッドで確定させてからメインへ渡す。
  private fun deliverNotification(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
    val charUuid: UUID? = characteristic.uuid
    val serviceUuid: UUID? = characteristic.service?.uuid
    val instanceId: Int = characteristic.instanceId
    val at = SystemClock.elapsedRealtime()
    handler.post { onNotificationMain(g, charUuid, serviceUuid, instanceId, value, at) }
  }

  private fun onConnectionStateChangeMain(g: BluetoothGatt, status: Int, newState: Int) {
    if (g !== gatt) {
      // 既に手放した古い接続。念のため閉じる(close は二重に呼んでも安全)。
      if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        try {
          g.close()
        } catch (_: Exception) {
        }
      }
      return
    }
    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
      if (!gattForSetup) {
        statusConnected = true
        emitState("connecting", "接続しました。準備中...")
      }
      val started = try {
        g.discoverServices()
      } catch (_: SecurityException) {
        false
      }
      if (!started) handleLinkLost(status)
      return
    }
    if (newState == BluetoothProfile.STATE_CONNECTED) {
      // 「接続」だがエラー付き。信用せずに切断扱いにする。
      handleLinkLost(status)
      return
    }
    if (newState == BluetoothProfile.STATE_DISCONNECTED) {
      handleLinkLost(status)
    }
  }

  private fun handleLinkLost(status: Int) {
    if (gattForSetup) {
      if (awaitingConfirm) {
        emitState("debug", "確認中に切断されました(status=$status)")
      }
      onSetupCandidateFailed(
        if (status == GATT_ERROR_133) "接続に失敗しました(133)" else "切断されました(status=$status)"
      )
      return
    }
    onRuntimeLinkLost(sessionReady)
  }

  private fun onServicesDiscoveredMain(g: BluetoothGatt, status: Int) {
    if (g !== gatt) return
    if (status != BluetoothGatt.GATT_SUCCESS) {
      handleLinkLost(status)
      return
    }
    if (gattForSetup) {
      // 登録作業中: FFE0/FFE1(無ければ FFF0/FFF1)だけを押下候補にする。
      // それ以外(電池残量など)は購読しない。
      val target = findSetupCharacteristic(g)
      if (target == null) {
        onSetupCandidateFailed("ボタン用の通知(FFE1/FFF1)がありません")
        return
      }
      // 接続のたびに、切断時の警報(ピー音)を先に止めておく。購読(CCCD)の書き込みが
      // 失敗・期限切れで切断する場合にも、タグがポケットの中で鳴らないようにするため
      // (GATT操作は順番待ちなので、警報停止の書き込みが購読より先に送られる)。
      silenceAlerts(g)
      subscribe(g, target)
      return
    }
    // 通常運用: 登録時に確定したキャラクタリスティックだけを購読する。
    val ctx = context
    val reg = if (ctx != null) BleButtonStore.load(ctx) else null
    if (reg == null || !g.device.address.equals(reg.address, ignoreCase = true)) {
      // 解除済み・別の機器: 採用しない。
      closeGatt()
      return
    }
    val target: BluetoothGattCharacteristic? = g.getService(reg.service)?.getCharacteristic(reg.characteristic)
    if (target == null || !canNotify(target)) {
      emitState("error", "ボタンの通知が見つかりません。一度「登録を解除」して再登録してください")
      onRuntimeLinkLost(false, announce = false)
      return
    }
    // 購読より先に警報を止める(購読の失敗で切断しても鳴らないように。上と同じ理由)。
    silenceAlerts(g)
    subscribe(g, target)
  }

  private fun findSetupCharacteristic(g: BluetoothGatt): BluetoothGattCharacteristic? {
    val pairs: List<Pair<UUID, UUID>> = listOf(SERVICE_FFE0 to CHAR_FFE1, SERVICE_FFF0 to CHAR_FFF1)
    for (pair in pairs) {
      val c: BluetoothGattCharacteristic = g.getService(pair.first)?.getCharacteristic(pair.second) ?: continue
      if (canNotify(c)) return c
    }
    return null
  }

  private fun canNotify(c: BluetoothGattCharacteristic): Boolean {
    val props = c.properties
    return (props and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0 ||
      (props and BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0
  }

  // 押下キャラクタリスティックの通知を有効にする。CCCD の書き込み完了を確認してから
  // 「使える状態(ready)」にする(確認前の通知は押下として扱わない)。
  private fun subscribe(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
    val enabled = try {
      g.setCharacteristicNotification(c, true)
    } catch (_: SecurityException) {
      false
    }
    if (!enabled) {
      onSubscribeResult(g, c, false)
      return
    }
    val cccd: BluetoothGattDescriptor? = c.getDescriptor(DESCRIPTOR_CCCD)
    if (cccd == null) {
      // CCCD を持たない安価な互換品は、端末側の受信設定だけで通知が届く。
      // (登録時の「実際の2回押し」で通知が届くことは確認済み)
      onSubscribeResult(g, c, true)
      return
    }
    val value: ByteArray = if ((c.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0) {
      BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
    } else {
      BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
    }
    enqueueOp(
      GattOp(
        isDescriptor = true,
        start = { target -> writeDescriptorCompat(target, cccd, value) },
        done = { success -> onSubscribeResult(g, c, success) }
      )
    )
  }

  private fun onSubscribeResult(g: BluetoothGatt, c: BluetoothGattCharacteristic, success: Boolean) {
    if (g !== gatt) return
    if (!success) {
      if (gattForSetup) {
        onSetupCandidateFailed("通知を有効にできませんでした")
      } else {
        emitState("error", "ボタンの通知を有効にできませんでした。再接続します")
        onRuntimeLinkLost(false, announce = false)
      }
      return
    }
    pressChar = c
    subscribedAt = SystemClock.elapsedRealtime()
    pressQuietUntil = subscribedAt + SUBSCRIBE_GRACE_MS
    // 押している最中(down 送信済み)に購読し直すことになった場合(同じ接続で接続通知が
    // 二重に届いた等)は、黙って忘れずに必ず up を送る(送信が開いたまま残る事故の防止)。
    releaseIfDown()
    rawDown = false
    if (gattForSetup) {
      beginConfirm()
      return
    }
    sessionReady = true
    reconnectFailures = 0
    statusConnected = true
    statusReady = true
    val ctx = context
    val name = (if (ctx != null) BleButtonStore.load(ctx)?.name else null) ?: "BLEボタン"
    emitState("connected", "接続しました: $name")
  }

  // Link Loss(1803/2A06)と Immediate Alert(1802/2A06)に 0x00 を書く。
  // iTag は書かないと、切断のたびに(電波が一瞬途切れただけでも)鳴り続ける。
  private fun silenceAlerts(g: BluetoothGatt) {
    for (serviceUuid in listOf(SERVICE_LINK_LOSS, SERVICE_IMMEDIATE_ALERT)) {
      val c: BluetoothGattCharacteristic = g.getService(serviceUuid)?.getCharacteristic(CHAR_ALERT_LEVEL) ?: continue
      val props = c.properties
      val writeType: Int = if ((props and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0) {
        BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      } else if ((props and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE) != 0) {
        BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
      } else {
        continue
      }
      enqueueOp(
        GattOp(
          isDescriptor = false,
          start = { target -> writeCharacteristicCompat(target, c, byteArrayOf(0x00), writeType) },
          done = null
        )
      )
    }
  }

  // =====================================================================
  // GATT 操作の順番待ち(同時に1つだけ)
  // =====================================================================

  private fun enqueueOp(op: GattOp) {
    ops.add(op)
    pumpOps()
  }

  private fun pumpOps() {
    while (opInFlight == null && ops.isNotEmpty()) {
      val g = gatt
      if (g == null) {
        ops.clear()
        return
      }
      val op = ops.removeAt(0)
      val started = try {
        op.start(g)
      } catch (_: Exception) {
        false
      }
      if (started) {
        opInFlight = op
        handler.postDelayed(opTimeoutRunnable, OP_TIMEOUT_MS)
      } else {
        op.done?.invoke(false)
      }
    }
  }

  private fun onOpCallback(g: BluetoothGatt, isDescriptor: Boolean, success: Boolean) {
    if (g !== gatt) return
    finishOp(isDescriptor, success)
  }

  // isDescriptor=null は期限切れ(どの種類の操作でも終わらせる)。
  private fun finishOp(isDescriptor: Boolean?, success: Boolean) {
    val op = opInFlight ?: return
    // 種類の違う遅れて届いた応答で、別の操作を終わらせない。
    if (isDescriptor != null && op.isDescriptor != isDescriptor) return
    opInFlight = null
    handler.removeCallbacks(opTimeoutRunnable)
    op.done?.invoke(success)
    pumpOps()
  }

  private fun resetOps() {
    ops.clear()
    opInFlight = null
    handler.removeCallbacks(opTimeoutRunnable)
  }

  @Suppress("DEPRECATION")
  private fun writeDescriptorCompat(g: BluetoothGatt, d: BluetoothGattDescriptor, value: ByteArray): Boolean {
    return if (Build.VERSION.SDK_INT >= 33) {
      g.writeDescriptor(d, value) == BluetoothStatusCodes.SUCCESS
    } else {
      d.setValue(value)
      g.writeDescriptor(d)
    }
  }

  @Suppress("DEPRECATION")
  private fun writeCharacteristicCompat(
    g: BluetoothGatt,
    c: BluetoothGattCharacteristic,
    value: ByteArray,
    writeType: Int
  ): Boolean {
    return if (Build.VERSION.SDK_INT >= 33) {
      g.writeCharacteristic(c, value, writeType) == BluetoothStatusCodes.SUCCESS
    } else {
      c.writeType = writeType
      c.setValue(value)
      g.writeCharacteristic(c)
    }
  }

  // =====================================================================
  // 押下の判定
  // =====================================================================

  private fun onNotificationMain(
    g: BluetoothGatt,
    charUuid: UUID?,
    serviceUuid: UUID?,
    instanceId: Int,
    value: ByteArray,
    at: Long
  ) {
    if (g !== gatt) return
    // 購読完了を確認した押下キャラクタリスティック以外の通知は無視する。
    val pc = pressChar ?: return
    if (charUuid == null || charUuid != pc.uuid || instanceId != pc.instanceId) return
    if (serviceUuid == null || serviceUuid != pc.service?.uuid) return

    // 同じ値が50ミリ秒以内に重ねて届いたものは同じ押下とみなす(人の指では不可能な間隔)。
    if (at - lastNotifyAt in 0..DUPLICATE_WINDOW_MS && value.contentEquals(lastNotifyValue)) return
    lastNotifyAt = at
    lastNotifyValue = value

    if (gattForSetup) {
      onSetupNotification(value, at)
      return
    }

    // 通常運用: 登録済み機器・登録済みキャラクタリスティックからの通知のみ有効。
    val ctx = context ?: return
    val reg = BleButtonStore.load(ctx) ?: return
    if (!g.device.address.equals(reg.address, ignoreCase = true)) return
    if (charUuid != reg.characteristic || serviceUuid != reg.service) return
    if (!statusReady) return

    // 流量制限で停止中。
    if (at < mutedUntil) return
    recentNotifications.removeAll { at - it > RATE_WINDOW_MS }
    recentNotifications.add(at)
    if (recentNotifications.size > RATE_MAX_NOTIFICATIONS) {
      startMute(at)
      return
    }

    if (value.isEmpty()) return
    val pressed = value.any { it != 0.toByte() }
    val inGrace = at < pressQuietUntil

    if (!reg.holdCapable) {
      // 押すだけのボタン(iTag): 押すたびにトグル(0x00 は来ない想定。来ても無視)。
      if (!pressed || inGrace) return
      toggle(at)
      return
    }

    if (pressed) {
      val edge = !rawDown
      rawDown = true
      if (inGrace) return
      if (reg.mode == BleButtonStore.MODE_HOLD) {
        // 長押しモード: 押した=down(押している間の重複は無視)。
        if (!isDown) emitDown()
      } else if (edge) {
        // トグルモード: 押した瞬間だけ切り替える(離した信号は無視)。
        toggle(at)
      }
    } else {
      rawDown = false
      // 離した=up。送信停止は猶予中でもモードに関係なく常に通す(安全側)。
      releaseIfDown()
    }
  }

  private fun toggle(at: Long) {
    if (at - lastToggleAt < TOGGLE_DEBOUNCE_MS) return
    lastToggleAt = at
    emitToggle(at)
  }

  private fun startMute(at: Long) {
    mutedUntil = at + MUTE_MS
    recentNotifications.clear()
    // 送信中なら必ず止める(押しっぱなし・故障でマイクが開きっぱなしになるのを防ぐ)。
    releaseIfDown()
    rawDown = false
    handler.removeCallbacks(unmuteRunnable)
    handler.postDelayed(unmuteRunnable, MUTE_MS)
    emitState("error", "ボタンの信号が多すぎるため、30秒間ボタンを止めました(押しっぱなし・故障の可能性)")
  }

  private fun onMuteEnded() {
    mutedUntil = 0L
    recentNotifications.clear()
    if (statusReady) {
      emitState("connected", "ボタンを再開しました")
    }
  }

  // =====================================================================
  // Bluetooth のオン/オフ
  // =====================================================================

  private val bluetoothStateReceiver: BroadcastReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
      val state: Int = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
      handler.post { onBluetoothStateMain(state) }
    }
  }

  private fun registerBluetoothStateReceiver(app: Context) {
    val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
    try {
      if (Build.VERSION.SDK_INT >= 33) {
        // OS からの保護されたブロードキャストのみ(他アプリは送れない)。
        app.registerReceiver(bluetoothStateReceiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        app.registerReceiver(bluetoothStateReceiver, filter)
      }
    } catch (_: Exception) {
      // 受け取れなくても、start() の呼び直しで復旧できる。
    }
  }

  private fun onBluetoothStateMain(state: Int) {
    when (state) {
      BluetoothAdapter.STATE_ON -> {
        reconnectFailures = 0
        startIfRegistered()
      }
      BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> {
        handler.removeCallbacks(reconnectRunnable)
        if (setupPromise != null) {
          failSetup("E_POWERED_OFF", "Bluetoothがオフになりました。オンにしてからもう一度お試しください")
        }
        val hadGatt = gatt != null
        closeGatt()
        val ctx = context
        if (hadGatt && ctx != null && BleButtonStore.load(ctx) != null) {
          emitState("error", "Bluetoothがオフになっています")
        }
      }
      else -> {
      }
    }
  }

  // =====================================================================
  // 小道具
  // =====================================================================

  // 16ビットの短縮UUID(例: "ffe0")を Bluetooth 基本UUIDに展開する。
  private fun uuid16(hex: String): UUID =
    UUID.fromString("0000" + hex + "-0000-1000-8000-00805f9b34fb")

  private fun bluetoothAdapter(ctx: Context): BluetoothAdapter? {
    val manager = ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return manager?.adapter
  }

  private fun isGranted(ctx: Context, permission: String): Boolean =
    ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

  private fun hasConnectPermission(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return isGranted(ctx, Manifest.permission.BLUETOOTH_CONNECT)
  }

  // 登録作業に足りない権限があれば、その案内文を返す。
  private fun missingSetupPermission(ctx: Context): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      if (!isGranted(ctx, Manifest.permission.BLUETOOTH_SCAN) ||
        !isGranted(ctx, Manifest.permission.BLUETOOTH_CONNECT)
      ) {
        return PERMISSION_MESSAGE
      }
      return null
    }
    // Android 11以前は、BLE検索の結果を受け取るのに位置情報の許可が必要。
    if (!isGranted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)) {
      return LOCATION_PERMISSION_MESSAGE
    }
    return null
  }

  private fun safeDeviceName(device: BluetoothDevice): String? {
    return try {
      device.name
    } catch (_: SecurityException) {
      null
    }
  }
}
