/** sessionStorage key: when the visitor clicked the language switch, read once by the page that follows. */
const KEY = "farsight-lang-switch";

/** Marks the links of the language switch: a click on one of them is a language change. */
export const LANG_SWITCH_ATTR = "data-lang-switch";

/** A page reached through the language switch, until its letters have settled (see language-arrival). */
export type LanguageArrival = { transition: ViewTransition | null };

declare global {
  interface Window {
    __langArrival?: LanguageArrival | null;
  }
}

/**
 * Runs in `<head>`, before the first paint. A language change is a full page load between two documents, so
 * the page that leaves notes the click and the one that arrives reads it. Where the browser animates between
 * documents (the `@view-transition` rule of globals.css), the old page stays on screen until the new one is
 * ready to shuffle its letters; any other navigation is shown at once. In `<head>` because `pagereveal` fires
 * with the first paint: a script in the body can be too late to hear it.
 */
export const ARRIVAL_SCRIPT = `(function(){
var k=${JSON.stringify(KEY)},t=0;
try{t=+sessionStorage.getItem(k)||0;sessionStorage.removeItem(k)}catch(e){}
window.__langArrival=Date.now()-t<10000?{transition:null}:null;
document.addEventListener("click",function(e){
var a=e.target instanceof Element&&e.target.closest("a[${LANG_SWITCH_ATTR}]");
if(!a||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;
try{sessionStorage.setItem(k,String(Date.now()))}catch(e){}
},true);
addEventListener("pagereveal",function(e){
var vt=e.viewTransition,a=window.__langArrival;
if(!vt)return;
if(!a){vt.skipTransition();return}
a.transition=vt;
document.documentElement.setAttribute("data-lang-arriving","");
var done=function(){document.documentElement.removeAttribute("data-lang-arriving")};
vt.finished.then(done,done);
});
})();`;
