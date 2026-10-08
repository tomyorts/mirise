package jp.co.medident.mirailink.ble

import android.bluetooth.BluetoothAdapter
import android.content.Context
import android.content.SharedPreferences
import java.util.UUID

// 登録済みボタンの情報(登録時に「実際の押下」で確定したもの)。
// service/characteristic は押下として扱ってよい唯一の通知元。これ以外の通知は
// 押下として扱わない(電池残量などで勝手に送信が始まる事故の防止)。
internal data class BleButtonRegistration(
  val address: String,
  val name: String,
  val service: UUID,
  val characteristic: UUID,
  val holdCapable: Boolean,
  val mode: String
)

// 登録情報の保存先(SharedPreferences "mirai_ble_button")。
// SharedPreferences はスレッド安全で、書き込みは即座にメモリへ反映されるため、
// JSスレッドからの getStatus でも最新の登録状態を読める。
internal object BleButtonStore {
  const val MODE_TOGGLE = "toggle"
  const val MODE_HOLD = "hold"

  private const val PREFS_NAME = "mirai_ble_button"
  private const val KEY_ADDRESS = "address"
  private const val KEY_NAME = "name"
  private const val KEY_SERVICE = "service"
  private const val KEY_CHARACTERISTIC = "characteristic"
  private const val KEY_HOLD_CAPABLE = "holdCapable"
  private const val KEY_MODE = "mode"

  private fun prefs(context: Context): SharedPreferences =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  // 一部でも欠けた・壊れた登録情報は「未登録」とみなす
  // (どの通知を押下とみなすか確定できない状態で動かさない)。
  fun load(context: Context): BleButtonRegistration? {
    val p = prefs(context)
    val address: String = p.getString(KEY_ADDRESS, null) ?: return null
    if (!BluetoothAdapter.checkBluetoothAddress(address)) return null
    val service: UUID = parseUuid(p.getString(KEY_SERVICE, null)) ?: return null
    val characteristic: UUID = parseUuid(p.getString(KEY_CHARACTERISTIC, null)) ?: return null
    val holdCapable: Boolean = p.getBoolean(KEY_HOLD_CAPABLE, false)
    // 押すだけのボタン(iTag)は常にトグル。離した信号を送るボタンは既定で長押し。
    val storedMode: String? = p.getString(KEY_MODE, null)
    val mode: String = if (holdCapable && storedMode != MODE_TOGGLE) MODE_HOLD else MODE_TOGGLE
    val name: String = p.getString(KEY_NAME, null) ?: "BLEボタン"
    return BleButtonRegistration(address, name, service, characteristic, holdCapable, mode)
  }

  // 登録の確定。アプリが直後に終了しても失われないよう commit で同期保存する。
  fun save(context: Context, registration: BleButtonRegistration) {
    prefs(context).edit()
      .putString(KEY_ADDRESS, registration.address)
      .putString(KEY_NAME, registration.name)
      .putString(KEY_SERVICE, registration.service.toString())
      .putString(KEY_CHARACTERISTIC, registration.characteristic.toString())
      .putBoolean(KEY_HOLD_CAPABLE, registration.holdCapable)
      .putString(KEY_MODE, registration.mode)
      .commit()
  }

  fun saveMode(context: Context, mode: String) {
    prefs(context).edit().putString(KEY_MODE, mode).commit()
  }

  fun clear(context: Context) {
    prefs(context).edit().clear().commit()
  }

  private fun parseUuid(value: String?): UUID? {
    if (value == null) return null
    return try {
      UUID.fromString(value)
    } catch (_: IllegalArgumentException) {
      null
    }
  }
}
