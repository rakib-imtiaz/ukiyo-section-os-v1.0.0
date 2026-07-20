// One-click "grab keys" bookmarklet. The user creates the app by hand (they're signed in, so no
// captcha), lands on its Settings / API-credentials page, and clicks this bookmarklet — it scrapes
// the Client ID + Secret from the page and copies them to the clipboard. Back in ThemeBot, the
// paste box parses them. Copying to the clipboard is CSP-safe (no network request leaves the
// admin.shopify.com page, so its strict connect-src never blocks us) and captcha-proof (the user,
// not an automated browser, did the navigation).

/** Readable source of the bookmarklet (kept in sync with BOOKMARKLET_HREF below). */
const SOURCE = `(function(){
  function grab(){
    var t=(document.body&&document.body.innerText)||'';
    return {id:(t.match(/\\b[0-9a-f]{32}\\b/i)||[])[0],sec:(t.match(/\\bshpss_[A-Za-z0-9_-]+\\b/)||[])[0]};
  }
  function finish(g){
    if(!g.id){alert("ThemeBot: no Client ID found. Open the app's Settings / API credentials page, then click again.");return;}
    var p="themebot|"+g.id+"|"+(g.sec||"");
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(p).then(function(){alert("ThemeBot: keys copied"+(g.sec?"":" (Client ID only — click Reveal on the Secret, then run this again)")+". Go back to ThemeBot and paste.");},function(){window.prompt("ThemeBot: copy this, then paste into ThemeBot:",p);});
    }else{window.prompt("ThemeBot: copy this, then paste into ThemeBot:",p);}
  }
  var g=grab();
  if(!g.sec){
    var b=[].slice.call(document.querySelectorAll("button,a")).filter(function(x){return /reveal|show/i.test(x.textContent||"");})[0];
    if(b){b.click();setTimeout(function(){finish(grab());},600);return;}
  }
  finish(g);
})();`;

/** The draggable `javascript:` href. Whitespace is collapsed so it fits on one bookmarklet line. */
export const BOOKMARKLET_HREF = 'javascript:' + SOURCE.replace(/\n\s*/g, '');

/** Tolerantly pull a Client ID (32-hex) and Secret (shpss_…) out of pasted text — works for the
 *  `themebot|id|secret` payload the bookmarklet writes, and for anything else pasted in. */
export function parsePastedKeys(text: string): { clientId: string | null; clientSecret: string | null } {
  const clientId = text.match(/\b[0-9a-f]{32}\b/i)?.[0] ?? null;
  const clientSecret = text.match(/\bshpss_[A-Za-z0-9_-]+\b/)?.[0] ?? null;
  return { clientId, clientSecret };
}
