/* maintenance-guard.js — load as the FIRST script in <head> of every page.
 * Reads the live maintenance endpoint (with a static-file fallback).
 * If "enabled": true, sends visitors to maintenance.html.
 *  - Fails open: if the file can't be read, the site stays up.
 *  - The owner can sign in and turn maintenance off from maintenance.html.
 * This is a front-end gate, not security: data still lives in the GitHub repo.
 */
(function(){
  var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if(page === 'maintenance.html') return;

  // Hide the page until the check returns, so a closed system never flashes its UI.
  var hide = document.createElement('style');
  hide.id = 'maint-hide'; hide.textContent = 'html{visibility:hidden}';
  document.head.appendChild(hide);
  var shown = false;
  function reveal(){ if(shown) return; shown = true; var h = document.getElementById('maint-hide'); if(h) h.remove(); }
  var failsafe = setTimeout(reveal, 2500);

  function readStatus(){
    return fetch('/api/maintenance', { cache:'no-store' })
      .then(function(r){ if(!r.ok) throw new Error('Maintenance API unavailable'); return r.json(); })
      .catch(function(){
        return fetch('maintenance.json?_=' + Date.now(), { cache:'no-store' })
          .then(function(r){ return r.ok ? r.json() : null; });
      });
  }

  readStatus()
    .then(function(c){
      clearTimeout(failsafe);
      var down = c && c.enabled === true;
      if(down){ location.replace('maintenance.html'); return; }
      reveal();
    })
    .catch(function(){ clearTimeout(failsafe); reveal(); });
})();
