package app.offisea.office;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android WebView window.print() desteklemez. Bu küçük eklenti, sayfanın yazdırma görünümünü
 * Android'in yerleşik yazdırma servisine verir; kullanıcı buradan yazıcı veya "PDF olarak kaydet" seçer.
 * Dışarıya veri göndermez, ek izin gerektirmez.
 */
@CapacitorPlugin(name = "OffiseaPrint")
public class PrintPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String raw = call.getString("name", "Offisea");
        final String name = raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
        final String jobName = name.length() > 80 ? name.substring(0, 80) : name;
        getActivity().runOnUiThread(() -> {
            try {
                PrintManager pm = (PrintManager) getContext().getSystemService(Context.PRINT_SERVICE);
                final PrintDocumentAdapter inner = getBridge().getWebView().createPrintDocumentAdapter(jobName);
                PrintDocumentAdapter wrapper = new PrintDocumentAdapter() {
                    @Override public void onStart() { inner.onStart(); }
                    @Override public void onLayout(PrintAttributes o, PrintAttributes n, CancellationSignal s, LayoutResultCallback cb, Bundle extras) {
                        inner.onLayout(o, n, s, cb, extras);
                    }
                    @Override public void onWrite(PageRange[] pages, ParcelFileDescriptor dest, CancellationSignal s, WriteResultCallback cb) {
                        inner.onWrite(pages, dest, s, cb);
                    }
                    @Override public void onFinish() {
                        inner.onFinish();
                        call.resolve();
                    }
                };
                pm.print(jobName, wrapper, new PrintAttributes.Builder().build());
            } catch (Exception e) {
                call.reject("Yazdırma başlatılamadı.");
            }
        });
    }
}
