package app.offisea.office;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * İndirilen web paketlerinin (uygulama arayüzü) saklanması, doğrulanması ve seçilmesi.
 *
 * Güvenlik modeli:
 *  - Her paket, uygulamaya gömülü açık anahtarla (APK içindeki public/version.json) doğrulanan
 *    ECDSA P-256 imzalı bir listeyle gelir; listedeki her dosyanın SHA-256 özeti tutulur.
 *  - İndirilen her dosyanın özeti kontrol edilir; tek bir uyumsuzlukta güncelleme iptal edilir.
 *  - Uygulama her açılışta etkin paketin imzasını ve kod dosyalarının (html/js/css/json…) özetlerini
 *    yeniden doğrular; bozulmuş veya değiştirilmiş paket asla yüklenmez, yerleşik sürüme dönülür.
 *  - Yeni paket ilk açılışlarda "deneme" modundadır; arayüz başarıyla açıldığını bildirmezse
 *    (çökme, boş ekran) birkaç denemeden sonra otomatik olarak önceki sürüme dönülür.
 *  - Yalnızca daha yeni derleme numaraları kabul edilir (eski sürüme düşürme saldırısı engellenir).
 */
final class UpdateStore {
    /** Yerel kabuk seviyesi. Web paketi daha yüksek bir seviye isterse yeni APK gerekir. */
    static final int SHELL = 1;

    static final String PREFS = "OffiseaUpdate";
    static final String CAP_PREFS = "CapWebViewSettings"; // Capacitor'ın kendi ayar dosyası
    static final String CAP_PATH = "serverBasePath";
    static final String MANIFEST = "offisea-update.json";
    static final int MAX_TRIALS = 2;
    static final int MAX_FILES = 5000;
    static final long MAX_FILE_BYTES = 40L * 1024 * 1024;
    static final long MAX_TOTAL_BYTES = 200L * 1024 * 1024;

    // Yalnızca sade göreli yollar: "." veya ".." bölümü, mutlak yol, ters bölü yok.
    private static final Pattern SAFE_PATH = Pattern.compile("^[A-Za-z0-9_~+@-][A-Za-z0-9_.~+@-]*(/[A-Za-z0-9_~+@-][A-Za-z0-9_.~+@-]*)*$");
    private static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");

    private UpdateStore() {}

    /** Bir web paketinin bilgileri (version.json). */
    static final class Info {
        String version = "";
        long build;
        int minShell;
        String updateUrl = "";
        String download = "";
        String publicKey = "";
        final Map<String, String> files = new LinkedHashMap<>();
        byte[] raw;
        String sig = "";
    }

    // ---- Okuma / doğrulama ---------------------------------------------------------------------

    static Info parse(byte[] raw) throws Exception {
        JSONObject o = new JSONObject(new String(raw, StandardCharsets.UTF_8));
        if (!"offisea".equals(o.optString("app"))) throw new IOException("Geçersiz paket");
        Info i = new Info();
        i.raw = raw;
        i.version = o.optString("version", "").replaceAll("[^0-9A-Za-z.+-]", "");
        if (i.version.length() > 32) i.version = i.version.substring(0, 32);
        i.build = o.getLong("build");
        if (i.build <= 0) throw new IOException("Geçersiz derleme numarası");
        i.minShell = o.optInt("minShell", 1);
        i.updateUrl = o.optString("updateUrl", "");
        i.download = o.optString("download", "");
        i.publicKey = o.optString("publicKey", "");
        JSONObject files = o.getJSONObject("files");
        if (files.length() == 0 || files.length() > MAX_FILES) throw new IOException("Geçersiz dosya listesi");
        Iterator<String> it = files.keys();
        while (it.hasNext()) {
            String p = it.next();
            String h = files.getString(p);
            if (!isSafePath(p) || !HEX64.matcher(h).matches()) throw new IOException("Geçersiz dosya: " + p);
            i.files.put(p, h);
        }
        if (!i.files.containsKey("index.html")) throw new IOException("index.html yok");
        return i;
    }

    static boolean isSafePath(String p) {
        return p != null && p.length() <= 300 && SAFE_PATH.matcher(p).matches();
    }

    /** APK içindeki yerleşik paket bilgisi (güvenilir; açık anahtar buradan alınır). */
    static Info builtin(Context c) throws Exception {
        try (InputStream in = c.getAssets().open("public/version.json")) {
            return parse(readAll(in, 4L * 1024 * 1024));
        }
    }

    static PublicKey publicKey(Context c) throws Exception {
        String k = builtin(c).publicKey;
        if (k == null || k.isEmpty()) throw new IOException("Güncelleme anahtarı tanımlı değil");
        byte[] der = Base64.decode(k, Base64.DEFAULT);
        return KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(der));
    }

    /** İmzalı güncelleme bildirimini ({payload, sig}) doğrular ve içeriğini döndürür. */
    static Info verifySigned(Context c, String json) throws Exception {
        JSONObject o = new JSONObject(json);
        byte[] payload = Base64.decode(o.getString("payload"), Base64.DEFAULT);
        String sigB64 = o.getString("sig");
        byte[] sig = Base64.decode(sigB64, Base64.DEFAULT);
        Signature v = Signature.getInstance("SHA256withECDSA");
        v.initVerify(publicKey(c));
        v.update(payload);
        if (!v.verify(sig)) throw new SecurityException("Güncelleme imzası geçersiz");
        Info i = parse(payload);
        i.sig = sigB64;
        return i;
    }

    static Info readBundleManifest(Context c, File dir) throws Exception {
        File f = new File(dir, MANIFEST);
        try (InputStream in = new FileInputStream(f)) {
            return verifySigned(c, new String(readAll(in, 8L * 1024 * 1024), StandardCharsets.UTF_8));
        }
    }

    static boolean isCode(String p) {
        String l = p.toLowerCase(java.util.Locale.ROOT);
        return l.endsWith(".html") || l.endsWith(".htm") || l.endsWith(".js") || l.endsWith(".mjs")
            || l.endsWith(".css") || l.endsWith(".json") || l.endsWith(".webmanifest")
            || l.endsWith(".wasm") || l.endsWith(".svg");
    }

    /** Paket klasörünün bütünlüğünü doğrular: imza, derleme numarası, dosyalar ve kod özetleri. */
    static boolean verifyBundle(Context c, File dir, long build) {
        try {
            if (!dir.isDirectory()) return false;
            Info info = readBundleManifest(c, dir);
            if (info.build != build) return false;
            for (Map.Entry<String, String> f : info.files.entrySet()) {
                File file = new File(dir, f.getKey());
                if (!file.isFile()) return false;
                if (isCode(f.getKey()) && !f.getValue().equals(sha256(file))) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ---- Açılışta paket seçimi ------------------------------------------------------------------

    /**
     * MainActivity'de, Capacitor başlamadan önce çağrılır. Etkin paketi doğrular, deneme sayacını
     * işletir ve Capacitor'a hangi klasörden yükleme yapacağını söyler. Her hata yerleşik sürüme döner.
     */
    static void prepareOnLaunch(Context c) {
        try {
            SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            SharedPreferences.Editor e = p.edit();
            String binary = binaryVersion(c);
            if (!binary.equals(p.getString("binary", ""))) {
                // Yeni APK kuruldu: yerleşik sürüm esas alınır, indirilmiş paketler silinir.
                e.putString("binary", binary).putLong("active", 0).putLong("pending", 0).putLong("prev", 0).putInt("trials", 0).commit();
                setCapPath(c, "");
                deleteTree(bundlesDir(c));
                return;
            }
            long active = p.getLong("active", 0);
            long pending = p.getLong("pending", 0);
            if (active != 0 && pending == active) {
                int t = p.getInt("trials", 0) + 1;
                if (t > MAX_TRIALS) {
                    // Yeni sürüm açılamadı: kötü olarak işaretle ve önceki sürüme dön.
                    addBad(p, e, active);
                    active = p.getLong("prev", 0);
                    e.putLong("active", active).putLong("prev", 0).putLong("pending", 0).putInt("trials", 0);
                } else {
                    e.putInt("trials", t);
                }
            }
            String path = "";
            if (active != 0) {
                File dir = new File(bundlesDir(c), Long.toString(active));
                if (active > builtin(c).build && verifyBundle(c, dir, active)) {
                    path = dir.getAbsolutePath();
                } else {
                    e.putLong("active", 0).putLong("pending", 0).putInt("trials", 0);
                }
            }
            e.commit();
            setCapPath(c, path);
        } catch (Throwable t) {
            setCapPath(c, "");
        }
    }

    // ---- Yardımcılar ------------------------------------------------------------------------------

    static File bundlesDir(Context c) {
        return new File(c.getFilesDir(), "offisea-bundles");
    }

    static void setCapPath(Context c, String path) {
        c.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE).edit().putString(CAP_PATH, path).commit();
    }

    static Set<String> badBuilds(SharedPreferences p) {
        return new HashSet<>(p.getStringSet("bad", new HashSet<>()));
    }

    static void addBad(SharedPreferences p, SharedPreferences.Editor e, long build) {
        Set<String> bad = badBuilds(p);
        bad.add(Long.toString(build));
        e.putStringSet("bad", bad);
    }

    @SuppressWarnings("deprecation")
    static String binaryVersion(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            return code + ":" + pi.versionName + ":" + pi.lastUpdateTime;
        } catch (Exception e) {
            return "";
        }
    }

    static String sha256(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            return sha256(in);
        }
    }

    static String sha256(InputStream in) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        return hex(md.digest());
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(java.util.Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    static byte[] readAll(InputStream in, long max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > max) throw new IOException("Dosya çok büyük");
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    /** Klasörü ve içeriğini salt okunur yapar (dosyaların sonradan değiştirilmesine karşı). */
    static void makeReadOnly(File f) {
        if (f.isDirectory()) {
            File[] list = f.listFiles();
            if (list != null) for (File x : list) makeReadOnly(x);
        }
        //noinspection ResultOfMethodCallIgnored
        f.setWritable(false, false);
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        //noinspection ResultOfMethodCallIgnored
        f.setWritable(true, true);
        if (f.isDirectory()) {
            File[] list = f.listFiles();
            if (list != null) for (File x : list) deleteTree(x);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Etkin ve önceki paket dışındaki tüm paketleri ve yarım kalmış indirmeleri siler. */
    static void cleanup(Context c, long keepA, long keepB) {
        File[] list = bundlesDir(c).listFiles();
        if (list == null) return;
        for (File d : list) {
            String n = d.getName();
            if (n.equals(Long.toString(keepA)) || n.equals(Long.toString(keepB))) continue;
            deleteTree(d);
        }
    }
}
