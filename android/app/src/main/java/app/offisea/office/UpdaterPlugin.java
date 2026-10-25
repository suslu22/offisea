package app.offisea.office;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;

/**
 * Dosyasız güncelleme: yeni APK indirmeden, uygulamanın arayüzünü (web paketi) web sunucusundan
 * günceller. Yalnızca özeti değişen dosyalar indirilir; değişmeyenler mevcut sürümden kopyalanır.
 * Ayrıntılı güvenlik modeli için UpdateStore'a bakın.
 */
@CapacitorPlugin(name = "OffiseaUpdater")
public class UpdaterPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean(false);

    /** Uygulamanın şu an çalıştırdığı (veya bir sonraki açılışta çalıştıracağı) paket. */
    private UpdateStore.Info current(Context c, long[] activeOut) throws Exception {
        SharedPreferences p = c.getSharedPreferences(UpdateStore.PREFS, Context.MODE_PRIVATE);
        long active = p.getLong("active", 0);
        if (active != 0) {
            File dir = new File(UpdateStore.bundlesDir(c), Long.toString(active));
            try {
                UpdateStore.Info i = UpdateStore.readBundleManifest(c, dir);
                if (i.build == active) { activeOut[0] = active; return i; }
            } catch (Exception ignored) { /* yerleşik sürüme düş */ }
        }
        activeOut[0] = 0;
        return UpdateStore.builtin(c);
    }

    @PluginMethod
    public void info(PluginCall call) {
        try {
            Context c = getContext();
            SharedPreferences p = c.getSharedPreferences(UpdateStore.PREFS, Context.MODE_PRIVATE);
            UpdateStore.Info b = UpdateStore.builtin(c);
            long[] a = new long[1];
            UpdateStore.Info cur = current(c, a);
            JSObject r = new JSObject();
            r.put("shell", UpdateStore.SHELL);
            r.put("builtinVersion", b.version);
            r.put("builtinBuild", b.build);
            r.put("activeVersion", cur.version);
            r.put("activeBuild", a[0]);
            r.put("pending", p.getLong("pending", 0));
            r.put("enabled", cur.updateUrl.startsWith("https://") && !b.publicKey.isEmpty());
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Sürüm bilgisi okunamadı.");
        }
    }

    /** Yeni sürümü denetler; varsa indirip bir sonraki açılış için hazırlar. */
    @PluginMethod
    public void check(PluginCall call) {
        final boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
        if (!busy.compareAndSet(false, true)) {
            JSObject r = new JSObject();
            r.put("status", "busy");
            call.resolve(r);
            return;
        }
        worker.execute(() -> {
            try {
                call.resolve(doCheck(force));
            } catch (SecurityException e) {
                call.reject("Güncelleme doğrulanamadı; yüklenmedi.");
            } catch (Exception e) {
                call.reject("Güncelleme denetlenemedi. İnternet bağlantınızı kontrol edin.");
            } finally {
                busy.set(false);
            }
        });
    }

    private JSObject doCheck(boolean force) throws Exception {
        Context c = getContext();
        SharedPreferences p = c.getSharedPreferences(UpdateStore.PREFS, Context.MODE_PRIVATE);
        JSObject r = new JSObject();
        long[] a = new long[1];
        UpdateStore.Info cur = current(c, a);
        String base = cur.updateUrl;
        if (!base.startsWith("https://") || UpdateStore.builtin(c).publicKey.isEmpty()) { r.put("status", "disabled"); return r; }
        if (!base.endsWith("/")) base += "/";
        if (!force) {
            ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && cm.isActiveNetworkMetered()) { r.put("status", "metered"); return r; }
        }

        byte[] body = download(base + "update.json?t=" + System.currentTimeMillis(), 4L * 1024 * 1024, null);
        UpdateStore.Info nw = UpdateStore.verifySigned(c, new String(body, StandardCharsets.UTF_8));
        r.put("version", nw.version);
        r.put("build", nw.build);
        // Daha önce indirildi, yeniden başlatılmayı bekliyor.
        if (a[0] != 0 && nw.build == a[0]) {
            String running = getBridge().getServerBasePath();
            String staged = new File(UpdateStore.bundlesDir(c), Long.toString(a[0])).getAbsolutePath();
            if (!staged.equals(running)) { r.put("status", "ready"); return r; }
        }
        long builtinBuild = UpdateStore.builtin(c).build;
        if (nw.build <= cur.build || nw.build <= builtinBuild || UpdateStore.badBuilds(p).contains(Long.toString(nw.build))) {
            r.put("status", "none");
            return r;
        }
        if (nw.minShell > UpdateStore.SHELL) {
            r.put("status", "shell");
            r.put("download", nw.download);
            return r;
        }

        // Yeni paketi geçici klasörde oluştur.
        File root = UpdateStore.bundlesDir(c);
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Klasör oluşturulamadı");
        File tmp = new File(root, ".tmp-" + nw.build);
        UpdateStore.deleteTree(tmp);
        File curDir = a[0] != 0 ? new File(root, Long.toString(a[0])) : null;
        long total = 0;
        int downloaded = 0;
        try {
            for (Map.Entry<String, String> f : nw.files.entrySet()) {
                String path = f.getKey();
                String hash = f.getValue();
                File out = new File(tmp, path);
                File parent = out.getParentFile();
                if (parent == null || (!parent.isDirectory() && !parent.mkdirs())) throw new IOException("Klasör oluşturulamadı");
                if (!out.getCanonicalPath().startsWith(tmp.getCanonicalPath() + File.separator)) throw new SecurityException("Geçersiz yol");
                boolean copied = false;
                if (hash.equals(cur.files.get(path))) copied = copyLocal(c, curDir, path, hash, out);
                if (!copied) {
                    byte[] data = download(base + encodePath(path) + "?h=" + hash.substring(0, 16), UpdateStore.MAX_FILE_BYTES, hash);
                    try (OutputStream os = new FileOutputStream(out)) { os.write(data); }
                    downloaded++;
                }
                total += out.length();
                if (total > UpdateStore.MAX_TOTAL_BYTES) throw new IOException("Paket çok büyük");
            }
            // İmzalı listeyi pakete ekle (her açılışta yeniden doğrulanır).
            JSObject m = new JSObject();
            m.put("payload", android.util.Base64.encodeToString(nw.raw, android.util.Base64.NO_WRAP));
            m.put("sig", nw.sig);
            try (OutputStream os = new FileOutputStream(new File(tmp, UpdateStore.MANIFEST))) {
                os.write(m.toString().getBytes(StandardCharsets.UTF_8));
            }
            UpdateStore.makeReadOnly(tmp);
            File dest = new File(root, Long.toString(nw.build));
            UpdateStore.deleteTree(dest);
            if (!tmp.renameTo(dest)) throw new IOException("Paket taşınamadı");
            if (!UpdateStore.verifyBundle(c, dest, nw.build)) throw new SecurityException("Paket doğrulanamadı");

            long prev = p.getLong("active", 0);
            p.edit().putLong("prev", prev).putLong("active", nw.build).putLong("pending", nw.build).putInt("trials", 0).commit();
            UpdateStore.setCapPath(c, dest.getAbsolutePath());
            UpdateStore.cleanup(c, nw.build, prev);
        } catch (Exception e) {
            UpdateStore.deleteTree(tmp);
            throw e;
        }
        r.put("status", "ready");
        r.put("downloaded", downloaded);
        return r;
    }

    /** Değişmeyen dosyayı mevcut sürümden (APK içi veya etkin paket) kopyalar; özeti doğrular. */
    private boolean copyLocal(Context c, File curDir, String path, String hash, File out) {
        try (InputStream in = curDir != null ? new FileInputStream(new File(curDir, path)) : c.getAssets().open("public/" + path);
             OutputStream os = new FileOutputStream(out)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) { md.update(buf, 0, n); os.write(buf, 0, n); }
            if (UpdateStore.hex(md.digest()).equals(hash)) return true;
        } catch (Exception ignored) { /* indirilecek */ }
        //noinspection ResultOfMethodCallIgnored
        out.delete();
        return false;
    }

    private static String encodePath(String path) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (String seg : path.split("/")) {
            if (sb.length() > 0) sb.append('/');
            sb.append(URLEncoder.encode(seg, "UTF-8").replace("+", "%20"));
        }
        return sb.toString();
    }

    /** Yalnızca HTTPS; boyut sınırı ve (verilmişse) SHA-256 doğrulaması ile indirir. */
    private static byte[] download(String url, long max, String expectHash) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        if (!(conn instanceof HttpsURLConnection)) throw new SecurityException("Yalnızca HTTPS");
        try {
            conn.setInstanceFollowRedirects(true); // HttpsURLConnection HTTPS'ten HTTP'ye yönlenmez
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            conn.setUseCaches(false);
            conn.setRequestProperty("Cache-Control", "no-cache");
            int code = conn.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            if (!"https".equalsIgnoreCase(conn.getURL().getProtocol())) throw new SecurityException("Yalnızca HTTPS");
            long len = conn.getContentLengthLong();
            if (len > max) throw new IOException("Dosya çok büyük");
            byte[] data;
            try (InputStream in = conn.getInputStream()) { data = UpdateStore.readAll(in, max); }
            if (expectHash != null) {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                if (!UpdateStore.hex(md.digest(data)).equals(expectHash)) throw new SecurityException("Dosya özeti uyuşmuyor");
            }
            return data;
        } finally {
            conn.disconnect();
        }
    }

    /** Yeni sürüm açılışta sorunsuz yüklendi: deneme modundan çık. */
    @PluginMethod
    public void confirm(PluginCall call) {
        Context c = getContext();
        SharedPreferences p = c.getSharedPreferences(UpdateStore.PREFS, Context.MODE_PRIVATE);
        long build = call.getLong("build", 0L);
        long active = p.getLong("active", 0);
        String running = getBridge().getServerBasePath();
        boolean runningActive = active != 0 && running != null
            && running.equals(new File(UpdateStore.bundlesDir(c), Long.toString(active)).getAbsolutePath());
        if (runningActive && build == active && p.getLong("pending", 0) == active) {
            p.edit().putLong("pending", 0).putInt("trials", 0).putLong("prev", 0).commit();
            worker.execute(() -> UpdateStore.cleanup(c, active, 0));
        }
        call.resolve();
    }

    /** Hazırlanan yeni sürümü hemen yükler (sayfa yeniden açılır). */
    @PluginMethod
    public void applyNow(PluginCall call) {
        Context c = getContext();
        SharedPreferences p = c.getSharedPreferences(UpdateStore.PREFS, Context.MODE_PRIVATE);
        long active = p.getLong("active", 0);
        File dir = new File(UpdateStore.bundlesDir(c), Long.toString(active));
        worker.execute(() -> {
            if (active == 0 || !UpdateStore.verifyBundle(c, dir, active)) { call.reject("Hazır güncelleme yok."); return; }
            call.resolve();
            getActivity().runOnUiThread(() -> getBridge().setServerBasePath(dir.getAbsolutePath()));
        });
    }

    /** Sorun yaşanırsa: uygulamayla gelen (yerleşik) sürüme döner. */
    @PluginMethod
    public void reset(PluginCall call) {
        Context c = getContext();
        SharedPreferences p = c.getSharedPreferences(UpdateStore.PREFS, Context.MODE_PRIVATE);
        long active = p.getLong("active", 0);
        SharedPreferences.Editor e = p.edit();
        if (active != 0) UpdateStore.addBad(p, e, active);
        e.putLong("active", 0).putLong("pending", 0).putLong("prev", 0).putInt("trials", 0).commit();
        UpdateStore.setCapPath(c, "");
        call.resolve();
        getActivity().runOnUiThread(() -> getBridge().setServerAssetPath("public"));
        worker.execute(() -> UpdateStore.cleanup(c, 0, 0));
    }
}
