package ke.savenet.flex;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Flex for Android phones and Android TV: the Flex web app, full screen, with the
 * remote's Back key, full-screen video and the screen kept on while something plays.
 */
public class MainActivity extends Activity {
    private static final String HOME = BuildConfig.FLEX_URL;
    private static final String OFFLINE_HTML =
        "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'><style>"
        + "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F8F4EE;color:#221D18;font:16px/1.5 sans-serif;padding:24px;box-sizing:border-box}"
        + ".c{max-width:420px;padding:32px;border-radius:24px;background:#fff;box-shadow:0 12px 34px rgba(92,62,32,.12);text-align:center}"
        + ".m{width:56px;height:56px;border-radius:16px;background:#E8A33D;margin:0 auto 18px;display:flex;align-items:center;justify-content:center}"
        + ".m:before{content:'';border-left:17px solid #1B1205;border-top:11px solid transparent;border-bottom:11px solid transparent;margin-left:5px}"
        + "h1{font-size:22px;margin:0 0 8px}p{margin:0 0 20px;color:#5A4F45}"
        + "button{font:600 16px sans-serif;border:0;border-radius:999px;padding:12px 26px;background:#E8A33D;color:#1B1205}"
        + "button:focus{outline:3px solid #9A5F12;outline-offset:3px}</style></head>"
        + "<body><div class=c><div class=m></div><h1>Can't reach Flex</h1>"
        + "<p>Check that this device is connected to your home internet, then try again.</p>"
        + "<button autofocus onclick='FlexApp.retry()'>Try again</button></div></body></html>";

    private WebView web;
    private FrameLayout root;
    private View fullView;
    private WebChromeClient.CustomViewCallback fullCallback;
    private boolean isTv;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        UiModeManager ui = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        isTv = ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#F8F4EE"));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        if (isTv) immersive(true);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " FlexApp/" + BuildConfig.VERSION_NAME + (isTv ? " TV" : ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        web.addJavascriptInterface(new Bridge(), "FlexApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u.getHost() != null && u.getHost().equals(Uri.parse(HOME).getHost())) return false;
                // other sites (customer portal, payments) open in the browser
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) v.loadDataWithBaseURL(null, OFFLINE_HTML, "text/html", "utf-8", null);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                if (fullView != null) { cb.onCustomViewHidden(); return; }
                fullView = view; fullCallback = cb;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                immersive(true);
            }

            @Override
            public void onHideCustomView() { leaveFullScreen(); }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    private void leaveFullScreen() {
        if (fullView == null) return;
        root.removeView(fullView);
        fullView = null;
        if (fullCallback != null) fullCallback.onCustomViewHidden();
        fullCallback = null;
        if (!isTv) immersive(false);
    }

    @SuppressWarnings("deprecation")
    private void immersive(boolean on) {
        View d = getWindow().getDecorView();
        d.setSystemUiVisibility(on
            ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            : (Build.VERSION.SDK_INT >= 23 ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR : 0));
    }

    /** Back (phone button or TV remote): close full screen, then let the page close the player or details, then go back or exit. */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (fullView != null) { leaveFullScreen(); return; }
        web.evaluateJavascript("(window.flexBack && window.flexBack()) ? 1 : 0", (r) -> {
            if ("1".equals(r)) return;
            if (web.canGoBack()) web.goBack();
            else finish();
        });
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        // some TV remotes send a separate Play/Pause key: hand it to the page as one
        if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY || code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            web.evaluateJavascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'MediaPlayPause',bubbles:true}))", null);
            return true;
        }
        return super.onKeyDown(code, e);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        if (isTv) immersive(true);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** Called from the page as window.FlexApp. */
    private class Bridge {
        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void retry() { runOnUiThread(() -> web.loadUrl(HOME)); }

        @JavascriptInterface
        public boolean isTv() { return isTv; }
    }
}
