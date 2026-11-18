package io.github.imilan

import android.content.Context
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.util.Log
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.security.SecureRandom
import kotlin.concurrent.thread

/**
 * 本机引擎：把随 APK 打包的 go2rtc 与网关二进制拉起来，并看护它们。
 *
 * 二进制放在 nativeLibraryDir（安装时从 APK 解压出来的 lib*.so），
 * 这是 Android 10+ 下唯一允许直接 exec 的应用目录。
 */
object Engine {
    enum class State { STOPPED, STARTING, READY, FAILED }

    private const val TAG = "IMI-Engine"
    private const val WEB_PORT = 19841
    private const val PREFS = "engine"
    private const val API_MIN = 20000
    private const val API_MAX = 29999
    private const val API_USER = "imi"
    @Volatile
    var state = State.STOPPED
        private set

    @Volatile
    var message = ""
        private set

    @Volatile
    var apiPort = 0
        private set

    @Volatile
    var token = ""
        private set

    private var engine: Process? = null
    private var gateway: Process? = null

    val webPort: Int get() = WEB_PORT

    fun webUrl(): String = "http://127.0.0.1:$WEB_PORT/?app&v=${BuildConfig.VERSION_CODE}"

    fun isReady(): Boolean = state == State.READY && engine?.isAlive == true && gateway?.isAlive == true

    @Synchronized
    fun start(ctx: Context): Boolean {
        if (isReady()) return true
        state = State.STARTING
        message = "正在启动本机引擎…"
        stopLocked()

        return try {
            val dir = prepare(ctx)
            val cfg = File(dir, "go2rtc.yaml")
            val apiPass = ensureApiPass(ctx)
            ensureApiAuth(cfg, apiPass)
            if (readApiPort(cfg) <= 0) throw IOException("go2rtc.yaml 里没有 api.listen")
            token = ensureToken(ctx)

            val env = buildEnv(ctx, dir)
            val libDir = ctx.applicationInfo.nativeLibraryDir
            val engineBin = File(libDir, "libgo2rtc.so")
            val gatewayBin = File(libDir, "libimi-gateway.so")
            if (!engineBin.isFile) throw IOException("缺少引擎二进制：${engineBin.name}")
            if (!gatewayBin.isFile) throw IOException("缺少网关二进制：${gatewayBin.name}")

            rotateLog(File(dir, "engine.log"))
            rotateLog(File(dir, "gateway.log"))

            killOrphans(ctx)
            var port = launch(ctx, engineBin, cfg, dir, env, 20000)
            if (port <= 0) {
                // 端口被残留进程或同机其他应用占用时，换一组端口再试一次
                rewritePorts(cfg)
                port = launch(ctx, engineBin, cfg, dir, env, 15000)
            }
            if (port <= 0) {
                throw IOException("go2rtc 未能在 20 秒内监听 127.0.0.1（端口可能被占用）")
            }
            apiPort = port

            val instance = randomHex(8)
            gateway = spawn(
                gatewayBin, listOf(
                    "-listen", "127.0.0.1:$WEB_PORT",
                    "-static", File(dir, "web").absolutePath,
                    "-go2rtc", "http://127.0.0.1:$port",
                    "-go2rtc-user", API_USER,
                    "-go2rtc-pass", apiPass,
                    "-no-auth",
                    "-app-token", token,
                    "-instance-id", instance,
                    "-qr",
                    "-config", cfg.absolutePath,
                    "-log-dir", dir.absolutePath,
                ),
                File(dir, "gateway.log"), dir, env,
            )
            savePids(ctx)
            // 只检查端口不够：19841 可能被同机其他应用占用，web 页会连到别人的服务。
            // 用本次启动的随机 instance-id 确认应答的是自己的网关。
            if (!waitGateway(instance, 15000)) {
                throw IOException(
                    "网页网关未能启动：19841 端口可能被其他应用占用，详见 gateway.log"
                )
            }

            state = State.READY
            message = "引擎 ${BuildConfig.VERSION_NAME} 运行中"
            Log.i(TAG, message)
            true
        } catch (t: Throwable) {
            stopLocked()
            state = State.FAILED
            message = t.message ?: t.javaClass.simpleName
            Log.e(TAG, "engine start failed", t)
            false
        }
    }

    @Synchronized
    fun stop() {
        stopLocked()
        state = State.STOPPED
        message = "已停止"
    }

    private fun stopLocked() {
        gateway?.let { kill(it) }
        engine?.let { kill(it) }
        gateway = null
        engine = null
    }

    private fun kill(p: Process) {
        try {
            p.destroy()
            if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
        } catch (_: Throwable) {
        }
    }

    /**
     * 拉一次 go2rtc 并等它监听；失败返回 -1。调用方负责重试/报错。
     */
    private fun launch(
        ctx: Context,
        bin: File,
        cfg: File,
        dir: File,
        env: Map<String, String>,
        timeoutMs: Long,
    ): Int {
        val port = readApiPort(cfg)
        if (port <= 0) return -1
        engine = spawn(bin, listOf("-config", cfg.absolutePath), File(dir, "engine.log"), dir, env)
        savePids(ctx)
        if (waitPort(port, timeoutMs) && engine?.isAlive == true) return port
        engine?.let { kill(it) }
        engine = null
        savePids(ctx)
        return -1
    }

    private fun spawn(
        bin: File,
        args: List<String>,
        log: File,
        workDir: File,
        env: Map<String, String>,
    ): Process {
        val pb = ProcessBuilder(listOf(bin.absolutePath) + args)
        pb.directory(workDir)
        pb.redirectErrorStream(true)
        pb.redirectOutput(ProcessBuilder.Redirect.appendTo(log))
        pb.environment().putAll(env)
        return pb.start()
    }

    /**
     * App 进程被系统回收时子进程会变成孤儿继续占着端口，导致下次启动永久失败。
     * 启动前按上次记录的 PID 回收（校验 cmdline，避免误杀被复用的 PID）。
     */
    private fun killOrphans(ctx: Context) {
        val self = android.os.Process.myPid()
        val candidates = LinkedHashSet<Int>()
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString("pids", null)?.split(',')?.forEach { part ->
            part.trim().toIntOrNull()?.let { candidates.add(it) }
        }
        // 旧版本没有记录 PID：扫一遍 /proc 找残留的 libgo2rtc.so / libimi-gateway.so。
        // Android 的 hidepid 只限制看别的 uid，自己拉起的子进程可见。
        File("/proc").list()?.forEach { name ->
            name.toIntOrNull()?.let { candidates.add(it) }
        }
        for (pid in candidates) {
            if (pid <= 0 || pid == self || !isEngineProc(pid)) continue
            try {
                android.os.Process.killProcess(pid)
                Log.i(TAG, "killed orphan $pid")
            } catch (_: Throwable) {
            }
        }
    }

    private fun isEngineProc(pid: Int): Boolean {
        return try {
            val cmd = File("/proc/$pid/cmdline").readText().trimEnd('\u0000')
            cmd.contains("libgo2rtc.so") || cmd.contains("libimi-gateway.so")
        } catch (_: Throwable) {
            false
        }
    }

    private fun savePids(ctx: Context) {
        val pids = listOfNotNull(pidOf(engine), pidOf(gateway))
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString("pids", pids.joinToString(",")).apply()
    }

    /**
     * Process.pid() 是 Java 9 / Android 8 (API 26) 的 API，
     * 这里用反射取，避免不同编译工具链对 java.lang.Process 的解析差异。
     */
    private fun pidOf(p: Process?): Int? {
        if (p == null) return null
        return try {
            when (val pid = Process::class.java.getMethod("pid").invoke(p)) {
                is Long -> pid.toInt()
                is Int -> pid
                else -> null
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun buildEnv(ctx: Context, dir: File): Map<String, String> {
        val env = HashMap<String, String>()
        env["HOME"] = dir.absolutePath
        env["TMPDIR"] = ctx.cacheDir.absolutePath
        // Android 没有 /etc/ssl/certs，Go 的 x509 在 GOOS=linux 下找不到系统根证书
        env["SSL_CERT_FILE"] = File(dir, "ca.pem").absolutePath
        dnsServer(ctx)?.let { env["IMI_DNS"] = it }
        return env
    }

    /** Android 没有 /etc/resolv.conf，把系统 DNS 传给引擎，否则云端域名解析失败。 */
    private fun dnsServer(ctx: Context): String? {
        return try {
            val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val net = cm.activeNetwork ?: return null
            val dns = cm.getLinkProperties(net)?.dnsServers ?: return null
            val picked = dns.firstOrNull { it is Inet4Address } ?: dns.firstOrNull()
            picked?.hostAddress
        } catch (_: Throwable) {
            null
        }
    }

    private fun waitPort(port: Int, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            try {
                Socket().use { it.connect(InetSocketAddress("127.0.0.1", port), 300) }
                return true
            } catch (_: IOException) {
                Thread.sleep(200)
            }
        }
        return false
    }

    /** 等自己的网关应答 /__imi/health，而不是等 19841 上任何服务应答。 */
    private fun waitGateway(instance: String, timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        val want = "\"instance\":\"$instance\""
        while (System.currentTimeMillis() < deadline) {
            if (gateway?.isAlive != true) return false
            val body = try {
                health()
            } catch (_: Throwable) {
                null
            }
            if (body != null && body.contains(want)) return true
            Thread.sleep(200)
        }
        return false
    }

    private fun health(): String? {
        // 部分平板（如 TB710FU / Android 16）上 HttpURLConnection 访问 127.0.0.1
        // 会一直 SocketTimeoutException，而网关其实秒回（adb shell 里 nc 可验证）。
        // 这里改用原始 Socket（和 waitPort 一样可靠），绕开 Java HTTP 栈的代理/调度问题。
        return try {
            Socket().use { s ->
                s.connect(InetSocketAddress("127.0.0.1", WEB_PORT), 1000)
                s.soTimeout = 1000
                val req = "GET /__imi/health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
                s.getOutputStream().write(req.toByteArray(Charsets.US_ASCII))
                s.getOutputStream().flush()
                s.getInputStream().bufferedReader(Charsets.US_ASCII).use { it.readText() }
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun randomHex(bytes: Int): String {
        val buf = ByteArray(bytes)
        SecureRandom().nextBytes(buf)
        return buf.joinToString("") { "%02x".format(it) }
    }

    /** 首次生成配置时给 API / RTSP / WebRTC 各挑一个不重复的回环端口。 */
    private fun randomPorts(count: Int): List<Int> {
        val picked = LinkedHashSet<Int>()
        val rnd = SecureRandom()
        while (picked.size < count) {
            picked.add(API_MIN + rnd.nextInt(API_MAX - API_MIN))
        }
        return picked.toList()
    }

    private fun prepare(ctx: Context): File {
        val dir = File(ctx.filesDir, "engine")
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("无法创建 ${dir.absolutePath}")

        val webDir = File(dir, "web")
        val stamp = File(dir, ".web-version")
        // 每次安装/更新都重新拷一次网页资源（几 MB，很快），
        // 否则 debug 包版本号不变时，平板会一直用旧的 index.html / app.js。
        @Suppress("DEPRECATION")
        val want = ctx.packageManager.getPackageInfo(ctx.packageName, 0).lastUpdateTime.toString()
        if (!webDir.isDirectory || !File(webDir, "index.html").isFile ||
            !stamp.isFile || stamp.readText().trim() != want
        ) {
            webDir.deleteRecursively()
            copyAssetDir(ctx, "web", webDir)
            stamp.writeText(want)
        }

        val ca = File(dir, "ca.pem")
        if (!ca.isFile || ca.length() < 4096) {
            ctx.assets.open("ca.pem").use { input -> ca.outputStream().use { input.copyTo(it) } }
        }

        val cfg = File(dir, "go2rtc.yaml")
        if (!cfg.isFile || cfg.length() < 16) {
            val text = ctx.assets.open("go2rtc.yaml").bufferedReader().use { it.readText() }
            val (api, rtsp, webrtc) = randomPorts(3)
            cfg.writeText(
                text
                    .replace("__API_PORT__", api.toString())
                    .replace("__RTSP_PORT__", rtsp.toString())
                    .replace("__WEBRTC_PORT__", webrtc.toString())
            )
            cfg.setReadable(true, true)
            cfg.setWritable(true, true)
        }
        migratePorts(cfg)
        return dir
    }

    /**
     * 旧版本生成的配置写死了 8554/8555，会和手机上其他 RTSP/WebRTC 应用抢端口。
     * 只迁移带安卓模板头的配置，用户自己粘进来的配置不动。
     */
    private fun migratePorts(cfg: File) {
        try {
            val text = cfg.readText()
            if (!text.startsWith("# IMI-LAN 安卓版配置模板")) return
            val (_, rtsp, webrtc) = randomPorts(3)
            val out = text
                .replace("127.0.0.1:8554", "127.0.0.1:$rtsp")
                .replace("127.0.0.1:8555", "127.0.0.1:$webrtc")
            if (out != text) {
                cfg.writeText(out)
                cfg.setReadable(true, true)
                cfg.setWritable(true, true)
            }
        } catch (_: Throwable) {
        }
    }

    private fun copyAssetDir(ctx: Context, assetPath: String, target: File) {
        val children = ctx.assets.list(assetPath) ?: return
        if (children.isEmpty()) {
            // assets.list 对文件返回空数组；不能先对文件路径 mkdirs()，否则会拷成 dir/name/name。
            target.parentFile?.mkdirs()
            ctx.assets.open(assetPath).use { input -> target.outputStream().use { input.copyTo(it) } }
            return
        }
        target.mkdirs()
        for (name in children) copyAssetDir(ctx, "$assetPath/$name", File(target, name))
    }

    private fun rotateLog(file: File) {
        try {
            if (file.isFile && file.length() > 4 * 1024 * 1024) {
                val bak = File(file.parentFile, file.name + ".1")
                bak.delete()
                file.renameTo(bak)
            }
        } catch (_: Throwable) {
        }
    }

    /** 与本机网页共用的会话令牌，避免同机其他应用访问 19841 端口。 */
    private fun ensureToken(ctx: Context): String {
        val prefs: SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString("token", null)
        if (!existing.isNullOrEmpty()) return existing
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        val value = bytes.joinToString("") { "%02x".format(it) }
        prefs.edit().putString("token", value).apply()
        return value
    }

    /** go2rtc API 对回环地址也要求 Basic Auth，密码与会话令牌一样随机生成并持久化。 */
    private fun ensureApiPass(ctx: Context): String {
        val prefs: SharedPreferences = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val existing = prefs.getString("apiPass", null)
        if (!existing.isNullOrEmpty()) return existing
        val value = randomHex(12)
        prefs.edit().putString("apiPass", value).apply()
        return value
    }

    /**
     * 把 api 段的 local_auth / username / password 落进配置：
     * 回环端口是所有应用共享的，没有认证时任意 App 都能读走 xiaomi-credentials。
     */
    private fun ensureApiAuth(cfg: File, pass: String) {
        try {
            val text = cfg.readText()
            val eol = if (text.contains("\r\n")) "\r\n" else "\n"
            val lines = text.split("\n").map { it.removeSuffix("\r") }.toMutableList()
            val start = lines.indexOfFirst { Regex("^api:\\s*$").matches(it) }
            if (start < 0) return
            var end = lines.size
            for (i in start + 1 until lines.size) {
                val line = lines[i]
                if (line.isNotEmpty() && !line[0].isWhitespace()) {
                    end = i
                    break
                }
            }

            fun put(key: String, value: String) {
                val re = Regex("^(\\s+)$key\\s*:.*$")
                for (i in start + 1 until end) {
                    val m = re.find(lines[i]) ?: continue
                    lines[i] = "${m.groupValues[1]}$key: $value"
                    return
                }
                lines.add(end, "  $key: $value")
                end++
            }
            put("local_auth", "true")
            put("username", "\"$API_USER\"")
            put("password", "\"$pass\"")

            val out = lines.joinToString(eol)
            if (out != text) writeConfigAtomic(cfg, out)
        } catch (t: Throwable) {
            Log.w(TAG, "ensureApiAuth failed", t)
        }
    }

    /** 配置决定下次能否启动：先写临时文件再改名，避免写一半被系统杀掉。 */
    private fun writeConfigAtomic(cfg: File, text: String) {
        val tmp = File(cfg.parentFile, "${cfg.name}.${android.os.Process.myPid()}.tmp")
        tmp.writeText(text)
        tmp.setReadable(true, true)
        tmp.setWritable(true, true)
        if (tmp.renameTo(cfg)) return
        cfg.writeText(text)
        tmp.delete()
        cfg.setReadable(true, true)
        cfg.setWritable(true, true)
    }

    /** 端口被占用时换一组回环端口；只改监听地址，其他配置不动。 */
    private fun rewritePorts(cfg: File) {
        try {
            val text = cfg.readText()
            var out = text
            val ports = randomPorts(3).iterator()
            for (section in listOf("api", "rtsp", "webrtc")) {
                val old = readListenPort(text, section) ?: continue
                if (!ports.hasNext()) break
                out = out.replace("127.0.0.1:$old", "127.0.0.1:${ports.next()}")
            }
            if (out != text) writeConfigAtomic(cfg, out)
        } catch (t: Throwable) {
            Log.w(TAG, "rewritePorts failed", t)
        }
    }

    private fun readListenPort(text: String, section: String): Int? {
        var inSection = false
        for (line in text.lineSequence()) {
            if (Regex("^${Regex.escape(section)}:\\s*$").matches(line)) {
                inSection = true
                continue
            }
            if (inSection && line.isNotEmpty() && !line[0].isWhitespace()) return null
            if (inSection) {
                Regex("^\\s+listen:\\s*\"[^\"]*:(\\d+)\"").find(line)?.let {
                    return it.groupValues[1].toIntOrNull()
                }
            }
        }
        return null
    }

    private fun readApiPort(cfg: File): Int {
        var inApi = false
        var port = 0
        try {
            cfg.forEachLine { line ->
                if (Regex("^api:\\s*$").matches(line)) {
                    inApi = true
                } else if (inApi && line.isNotEmpty() && !line[0].isWhitespace()) {
                    inApi = false
                } else if (inApi) {
                    Regex("^\\s+listen:\\s*\"[^\"]*:(\\d+)\"").find(line)?.let {
                        port = it.groupValues[1].toInt()
                    }
                }
            }
        } catch (_: Throwable) {
        }
        return port
    }
}
