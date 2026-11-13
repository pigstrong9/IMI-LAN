package io.github.imilan

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import kotlin.concurrent.thread

/**
 * 前台服务：保证 go2rtc / 网关在切后台、锁屏后仍能工作，
 * 并在引擎异常退出时自动拉起（与桌面版托盘的看护逻辑一致）。
 */
class EngineService : Service() {
    companion object {
        private const val TAG = "IMI-Service"
        private const val CHANNEL_ID = "engine"
        private const val NOTIFICATION_ID = 1
        const val ACTION_START = "io.github.imilan.action.START"
        const val ACTION_RESTART = "io.github.imilan.action.RESTART"
        const val ACTION_STOP = "io.github.imilan.action.STOP"

        fun start(ctx: Context) {
            val intent = Intent(ctx, EngineService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }

        fun restart(ctx: Context) {
            val intent = Intent(ctx, EngineService::class.java).setAction(ACTION_RESTART)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
            else ctx.startService(intent)
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var worker: Thread? = null
    @Volatile private var lastAttempt = 0L

    private val watchdog = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            val shouldRetry = Engine.state == Engine.State.READY && !Engine.isReady() ||
                Engine.state == Engine.State.FAILED && now - lastAttempt > 30_000
            if (shouldRetry) {
                Log.w(TAG, "watchdog restart: state=${Engine.state}")
                runEngine()
            }
            handler.postDelayed(this, 15_000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createChannel()
        startForeground(NOTIFICATION_ID, buildNotification(getString(R.string.starting)))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                handler.removeCallbacks(watchdog)
                Engine.stop()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RESTART -> {
                Engine.stop()
                runEngine()
            }
            else -> {
                if (!Engine.isReady() && Engine.state != Engine.State.STARTING) runEngine()
            }
        }
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, 15_000)
        updateNotification()
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(watchdog)
        Engine.stop()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun runEngine() {
        lastAttempt = System.currentTimeMillis()
        worker?.interrupt()
        worker = thread(name = "engine-start") {
            Engine.start(applicationContext)
            handler.post {
                updateNotification()
                handler.removeCallbacks(watchdog)
                handler.postDelayed(watchdog, 15_000)
            }
        }
    }

    private fun updateNotification() {
        val text = when (Engine.state) {
            Engine.State.READY -> getString(R.string.notif_running)
            Engine.State.FAILED -> getString(R.string.engine_failed) + "：" + Engine.message
            else -> getString(R.string.starting)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val restart = PendingIntent.getService(
            this, 1,
            Intent(this, EngineService::class.java).setAction(ACTION_RESTART),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 2,
            Intent(this, EngineService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(Notification.Action.Builder(null, getString(R.string.notif_restart), restart).build())
            .addAction(Notification.Action.Builder(null, getString(R.string.notif_stop), stop).build())
            .build()
    }

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notif_channel),
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = getString(R.string.notif_channel_desc)
        channel.setShowBadge(false)
        nm.createNotificationChannel(channel)
    }
}
