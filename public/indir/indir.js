// İndirme sayfası: son sürümün dosya bağlantılarını GitHub'dan alır.
// Bağlantılar alınamazsa sayfadaki hazır bağlantılar kullanılır; onlar da her zaman en yeni sürümü indirir.
(function () {
  'use strict';
  var REPO = 'https://github.com/suslu22/offisea/';
  var ua = navigator.userAgent;
  var mine = /Android/i.test(ua) ? 'apk' : /Windows/i.test(ua) ? 'exe' : null;
  if (mine) {
    var b = document.getElementById(mine);
    b.classList.add('mine');
    b.parentNode.insertBefore(b, b.parentNode.firstChild);
  }

  function setLink(id, url) {
    if (url && url.indexOf(REPO + 'releases/download/') === 0) document.getElementById(id).href = url;
  }

  fetch('https://api.github.com/repos/suslu22/offisea/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (rel) {
      var assets = rel.assets || [];
      function find(re) { for (var i = 0; i < assets.length; i++) if (re.test(assets[i].name)) return assets[i].browser_download_url; return null; }
      setLink('apk', find(/\.apk$/i));
      setLink('exe', find(/-Kurulum\.exe$/i));
      setLink('portable', find(/-Tasinabilir\.exe$/i));
      if (typeof rel.tag_name === 'string') document.getElementById('ver').textContent = 'Son sürüm: ' + rel.tag_name.slice(0, 20);
    })
    .catch(function () { /* hazır bağlantılar kalır */ });
})();
