package io.github.imilan

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * 网页里 <a download> 保存 blob 在 WebView 里不会触发下载，
 * 所以截图/录像通过这个桥分块写入系统相册。
 */
class DownloadBridge(private val ctx: Context) {
    private class Session(
        val file: File,
        val out: OutputStream,
        val mime: String,
        val name: String,
    )

    private val sessions = ConcurrentHashMap<String, Session>()
    private val seq = AtomicLong()

    /** 安卓 WebView 解 H.265 主码流不稳定，网页据此默认走子码流。 */
    @JavascriptInterface
    fun preferSD(): Boolean = true

    @JavascriptInterface
    fun beginDownload(name: String, mime: String): String {
        val id = "d" + seq.incrementAndGet()
        val file = File(ctx.cacheDir, "imi-dl-$id.bin")
        val session = Session(
            file = file,
            out = BufferedOutputStream(FileOutputStream(file)),
            mime = mime.ifBlank { "application/octet-stream" },
            name = safeName(name),
        )
        sessions[id] = session
        return id
    }

    @JavascriptInterface
    fun appendDownload(id: String, base64: String) {
        val session = sessions[id] ?: return
        try {
            session.out.write(Base64.decode(base64, Base64.DEFAULT))
        } catch (t: Throwable) {
            Log.w(TAG, "append failed", t)
            abort(id)
        }
    }

    @JavascriptInterface
    fun finishDownload(id: String) {
        val session = sessions.remove(id) ?: return
        try {
            session.out.flush()
            session.out.close()
        } catch (_: Throwable) {
        }
        val where = try {
            save(session)
        } catch (t: Throwable) {
            Log.w(TAG, "save failed", t)
            null
        }
        session.file.delete()
        toast(if (where != null) "已保存到 $where" else "保存失败")
    }

    @JavascriptInterface
    fun abortDownload(id: String) = abort(id)

    private fun abort(id: String) {
        val session = sessions.remove(id) ?: return
        try {
            session.out.close()
        } catch (_: Throwable) {
        }
        session.file.delete()
    }

    private fun save(session: Session): String? {
        val isImage = session.mime.startsWith("image/")
        val relative = (if (isImage) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_MOVIES) + "/IMI-LAN"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val collection = if (isImage) {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, session.name)
                put(MediaStore.MediaColumns.MIME_TYPE, session.mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = ctx.contentResolver.insert(collection, values) ?: return null
            try {
                ctx.contentResolver.openOutputStream(uri)?.use { out ->
                    session.file.inputStream().use { it.copyTo(out) }
                } ?: return null
                values.clear()
                values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                ctx.contentResolver.update(uri, values, null, null)
                return if (isImage) "相册 / Pictures / IMI-LAN" else "相册 / Movies / IMI-LAN"
            } catch (t: Throwable) {
                ctx.contentResolver.delete(uri, null, null)
                throw t
            }
        }

        // Android 9 及以下：应用专属外部目录，不需要存储权限
        val base = ctx.getExternalFilesDir(
            if (isImage) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_MOVIES,
        ) ?: ctx.filesDir
        val dir = File(base, "IMI-LAN").apply { mkdirs() }
        val target = File(dir, session.name)
        session.file.inputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
        return target.absolutePath
    }

    private fun safeName(name: String): String {
        val cleaned = name.replace(Regex("[/\\\\:*?\"<>|\\s]+"), "_").trim('_')
        val fallback = "imi-lan-" + System.currentTimeMillis()
        return (cleaned.ifEmpty { fallback }).take(96)
    }

    private fun toast(text: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(ctx, text, Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        private const val TAG = "IMI-Download"
    }
}
