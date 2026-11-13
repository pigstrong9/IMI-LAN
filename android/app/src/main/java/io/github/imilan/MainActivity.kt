package io.github.imilan

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var overlay: View
    private lateinit var progress: ProgressBar
    private lateinit var status: TextView
    private lateinit var retry: Button
    private lateinit var chrome: ImiChromeClient

    private val handler = Handler(Looper.getMainLooper())
    private var loaded = false
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    private val pollState = object : Runnable {
        override fun run() {
            when (Engine.state) {
                Engine.State.READY -> showWeb()
                Engine.State.FAILED -> showError(Engine.message)
                else -> handler.postDelayed(this, 250)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.root)
        web = findViewById(R.id.web)
        overlay = findViewById(R.id.overlay)
        progress = findViewById(R.id.progress)
        status = findViewById(R.id.status)
        retry = findViewById(R.id.retry)

        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applySystemBarInsets()
        askNotificationPermission()

        setupWebView()
        retry.setOnClickListener {
            progress.visibility = View.VISIBLE
            retry.visibility = View.GONE
            status.text = getString(R.string.starting)
            EngineService.restart(this)
            handler.removeCallbacks(pollState)
            handler.post(pollState)
        }

        EngineService.start(this)
        handler.post(pollState)
    }

    /**
     * targetSdk 35 默认强制 edge-to-edge，网页会画到状态栏/导航栏下面。
     * 给根布局补上系统栏高度的内边距；进入全屏时 inset 变 0，自动还原。
     */
    private fun applySystemBarInsets() {
        val view = findViewById<View>(R.id.root)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            view.setOnApplyWindowInsetsListener { v, insets ->
                val bars = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()
                )
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                insets
            }
        } else {
            @Suppress("DEPRECATION")
            view.setOnApplyWindowInsetsListener { v, insets ->
                v.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom,
                )
                insets
            }
        }
    }

    private fun setupWebView() {        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.setBackgroundColor(Color.parseColor("#0E1726"))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = true
            userAgentString = userAgentString + " IMI-LAN-Android/" + BuildConfig.VERSION_NAME
        }

        web.addJavascriptInterface(DownloadBridge(this), "IMIAndroid")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val host = request.url.host ?: return false
                if (host == "127.0.0.1" || host == "localhost") return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: Throwable) {
                }
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                overlay.visibility = View.GONE
                web.visibility = View.VISIBLE
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                if (Engine.state == Engine.State.READY || Engine.state == Engine.State.STARTING) return
                showError(error.description?.toString() ?: "页面加载失败")
            }
        }

        chrome = ImiChromeClient()
        web.webChromeClient = chrome
    }

    private fun showWeb() {
        if (loaded) return
        loaded = true
        val cookie = CookieManager.getInstance()
        cookie.setAcceptCookie(true)
        cookie.setCookie(
            "http://127.0.0.1:${Engine.webPort}/",
            "imi_app=${Engine.token}; Path=/; HttpOnly; SameSite=Lax",
        )
        cookie.flush()
        web.loadUrl(Engine.webUrl())
        progress.visibility = View.GONE
        retry.visibility = View.GONE
        status.text = ""
    }

    private fun showError(text: String) {
        handler.removeCallbacks(pollState)
        overlay.visibility = View.VISIBLE
        web.visibility = View.GONE
        progress.visibility = View.GONE
        retry.visibility = View.VISIBLE
        status.text = text.ifBlank { getString(R.string.engine_failed) }
        Log.w("IMI-Main", "engine error: $text")
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
    }

    override fun onResume() {
        super.onResume()
        if (loaded && Engine.state == Engine.State.READY) {
            // 从后台回来时让网页自己恢复（网页内有“后台 2 分钟休眠”逻辑）
            web.onResume()
            web.resumeTimers()
            if (!web.url.isNullOrEmpty()) web.evaluateJavascript("window.dispatchEvent(new Event('imi-resume'))", null)
        }
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacks(pollState)
        web.destroy()
        super.onDestroy()
    }

    override fun onBackPressed() {
        if (customView != null) {
            web.evaluateJavascript("document.fullscreenElement && document.exitFullscreen()", null)
            chrome.onHideCustomView()
            return
        }
        if (web.canGoBack()) {
            web.goBack()
            return
        }
        moveTaskToBack(true)
    }

    private fun hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                )
        }
    }

    private fun showSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(true)
            window.insetsController?.show(WindowInsets.Type.systemBars())
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    inner class ImiChromeClient : WebChromeClient() {
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customCallback = callback
            (window.decorView as FrameLayout).addView(
                view,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                ),
            )
            web.visibility = View.GONE
            hideSystemBars()
        }

        override fun onHideCustomView() {
            val view = customView ?: return
            (window.decorView as FrameLayout).removeView(view)
            customView = null
            customCallback?.onCustomViewHidden()
            customCallback = null
            web.visibility = View.VISIBLE
            showSystemBars()
        }
    }
}
