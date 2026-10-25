package app.offisea.office;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Dosyasız güncelleme: Capacitor başlamadan önce etkin web paketini doğrula ve seç
        // (bozuk/değiştirilmiş paket yüklenmez; açılamayan yeni sürüm otomatik geri alınır).
        UpdateStore.prepareOnLaunch(this);
        registerPlugin(PrintPlugin.class);
        registerPlugin(UpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        // WebView sertleştirme: uygulama içeriği Capacitor'ın yerel sunucusundan gelir;
        // doğrudan dosya/içerik erişimi, konum ve otomatik pencere açma gerekmez.
        WebView webView = getBridge().getWebView();
        WebSettings s = webView.getSettings();
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSaveFormData(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (android.os.Build.VERSION.SDK_INT >= 26) s.setSafeBrowsingEnabled(true);
    }
}
