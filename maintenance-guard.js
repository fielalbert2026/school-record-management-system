/* maintenance-guard.js — load as the FIRST script in <head> of every page.
 * Reads maintenance.json (never cached). If "enabled": true, sends visitors to maintenance.html.
 *  - Fails open: if the file can't be read, the site stays up.
 *  - Owner bypass: open any page once with  ?bypass=<bypassKey from maintenance.json>
 *    (kept for the browser tab session, so you can still sign in and test while it's down).
 * This is a front-end gate, not security: data still lives in the GitHub repo.
 */
(function(){
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if(page === 'maintenance.html') return;

  var KEY = 'srms_maint_bypass', given = null;
  try{
    given = new URLSearchParams(location.search).get('bypass');
    if(given) sessionStorage.setItem(KEY, given);
    given = sessionStorage.getItem(KEY);
  }catch(e){}

  // Hide the page until the check returns, so a closed system never flashes its UI.
  var hide = document.createElement('style');
  hide.id = 'maint-hide'; hide.textContent = 'html{visibility:hidden}';
  document.head.appendChild(hide);
  var shown = false;
  function reveal(){ if(shown) return; shown = true; var h = document.getElementById('maint-hide'); if(h) h.remove(); }
  var failsafe = setTimeout(reveal, 2500);

  fetch('maintenance.json?_=' + Date.now(), { cache:'no-store' })
    .then(function(r){ return r.ok ? r.json() : null; })
    .then(function(c){
      clearTimeout(failsafe);
      var down = c && c.enabled === true;
      var bypass = down && c.bypassKey && given && given === c.bypassKey;
      if(down && !bypass){ location.replace('maintenance.html'); return; }
      reveal();
    })
    .catch(function(){ clearTimeout(failsafe); reveal(); });
})();
