const KEY = "farsight-lang-switch";

export const LANG_SWITCH_ATTR = "data-lang-switch";

export type LanguageArrival = { transition: ViewTransition | null };

declare global {
  interface Window {
    __langArrival?: LanguageArrival | null;
  }
}

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
