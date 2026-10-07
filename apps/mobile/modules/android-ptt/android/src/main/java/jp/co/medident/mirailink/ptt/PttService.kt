package jp.co.medident.mirailink.ptt

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

// 勤務中(出勤〜退勤)だけ動く常駐サービス(Android版)。
//
// Android には iPhone の PushToTalk のような「ロック中にイヤホンのボタンを
// アプリへ渡す公式の仕組み」が無いため、次の組み合わせで同じことを実現する。
//  1. フォアグラウンドサービス: 通知を出して常駐し、画面ロック中もアプリと
//     マイク・音声接続が止められないようにする(種別 microphone)。
//  2. MediaSession: イヤホンの再生/停止ボタン(メディアボタン)を受け取る。
//     Android は「最後に音を鳴らしたメディアセッション」にボタンを渡すため、
//     開始時に0.5秒の無音を鳴らして受け取り先になる(音楽アプリに取られた時は
//     reclaim でやり直す)。
//  3. 押下は JS へ通知し、送信の開始/停止(トグル)は JS 側で行う。
class PttService : Service() {
  companion object {
    // JS への通知先(AndroidPttModule が設定する)。押されたキーの名前を渡す。
    @Volatile var listener: ((String) -> Unit)? = null
    @Volatile var running = false
    @Volatile private var instance: PttService? = null

    const val EXTRA_TITLE = "title"
    private const val CHANNEL_ID = "mirai_link_shift"
    private const val NOTIFICATION_ID = 4711
    // 1回の押下で複数のキーが届く機種(2回押しが再生+停止の2イベントになる等)
    // があるため、この間隔内の押下は1回として扱う。
    private const val DEBOUNCE_MS = 400L

    /** 音楽アプリに取られたボタンの受け取り先を取り戻す。 */
    fun reclaim() {
      instance?.claimMediaButtons()
    }
  }

  private var session: MediaSessionCompat? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var lastPressAt = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "MIRAI LINK"
    startInForeground(title)
    if (session == null) {
      setupSession()
    }
    acquireWakeLock()
    instance = this
    running = true
    claimMediaButtons()
    // 強制終了された後に自動で再起動しない(JS 側が動いていないと意味が無いため)。
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    instance = null
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  // ---- 通知とフォアグラウンド化 ----

  private fun startInForeground(title: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, "勤務中", NotificationManager.IMPORTANCE_LOW)
      channel.description = "勤務中(インカム接続中)であることを表示します"
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel)
    }

    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this, 0, it,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
    }

    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("$title 勤務中")
      .setContentText("イヤホンのボタンで話せます。帰るときはアプリで「退勤する」を押してください")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(contentIntent)
      .build()

    val types = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    } else {
      0
    }
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types)
  }

  // 画面ロック中も CPU を止めない(止まると音声接続が途切れ、受信できなくなる)。
  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mirailink:shift").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  // ---- イヤホンのボタン(メディアボタン) ----

  private fun setupSession() {
    val s = MediaSessionCompat(this, "MIRAI LINK")
    s.setCallback(object : MediaSessionCompat.Callback() {
      override fun onMediaButtonEvent(mediaButtonEvent: Intent): Boolean {
        val event: KeyEvent? = if (Build.VERSION.SDK_INT >= 33) {
          mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
        } else {
          @Suppress("DEPRECATION")
          mediaButtonEvent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
        }
        if (event == null) return false
        val name = keyName(event.keyCode) ?: return false
        // 押した瞬間だけ扱う(離した時・押しっぱなしの繰り返しは無視)。
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount > 0) return true
        val now = SystemClock.elapsedRealtime()
        if (now - lastPressAt < DEBOUNCE_MS) return true
        lastPressAt = now
        listener?.invoke(name)
        return true
      }
    })
    s.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(
          PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_PLAY_PAUSE or
            PlaybackStateCompat.ACTION_STOP or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        )
        .setState(PlaybackStateCompat.STATE_PLAYING, 0L, 1f)
        .build()
    )
    s.isActive = true
    session = s
  }

  private fun keyName(keyCode: Int): String? = when (keyCode) {
    KeyEvent.KEYCODE_HEADSETHOOK -> "headsethook"
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "play_pause"
    KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
    KeyEvent.KEYCODE_MEDIA_PAUSE -> "pause"
    KeyEvent.KEYCODE_MEDIA_STOP -> "stop"
    KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
    KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "previous"
    else -> null
  }

  // ボタンの受け取り先になる: セッションを有効にし直し、0.5秒の無音を鳴らす。
  fun claimMediaButtons() {
    session?.isActive = true
    try {
      val rate = 8000
      val samples = rate / 2
      val track = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(rate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        )
        .setBufferSizeInBytes(samples * 2)
        .setTransferMode(AudioTrack.MODE_STATIC)
        .build()
      track.write(ShortArray(samples), 0, samples)
      track.play()
      Handler(Looper.getMainLooper()).postDelayed({
        try {
          track.stop()
        } catch (_: Exception) {
        }
        track.release()
      }, 800L)
    } catch (_: Exception) {
      // 無音を鳴らせなくても、セッション自体は有効なので続行する。
    }
  }
}
