import { OFFLINE_FILES, OFFLINE_VERSION, ORIGIN } from '@/app/offlineManifest';
import NetInfo from '@react-native-community/netinfo';
import * as FS from 'expo-file-system/legacy';
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dimensions, Platform, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import WebView from 'react-native-webview';

// ---- constants/paths ----
const OFFLINE_ENTRY_PATH = '/ezops/ezops-offline/index.html';
const REMOTE_ENTRY = `${ORIGIN}${OFFLINE_ENTRY_PATH}`;
const ROOT_DIR = FS.documentDirectory + 'ezops/offline/';
const MIRROR_DIR = ROOT_DIR + 'mirror/';
const PAGES_DIR = ROOT_DIR + 'pages/';

// A/B toggles
const RAW_MIRROR_TEST = false; // TEMP: true -> load raw mirror index.html (no rewrite), false -> use rewritten pages/index.html
const READ_SCOPE = RAW_MIRROR_TEST ? MIRROR_DIR : ROOT_DIR; // match read scope to what we load

function ensureDirAsync(dir: string) {
  return FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
}
async function ensureParentDir(fileUri: string) {
  const idx = fileUri.lastIndexOf('/');
  if (idx > 7) await ensureDirAsync(fileUri.slice(0, idx + 1));
}
function mirrorUriFor(pathname: string) {
  const p = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  return MIRROR_DIR + p;
}

// Pretty-bytes for logs
function fmtBytes(n?: number) {
  if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
  const u = ['B','KB','MB','GB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---- precache manifest into mirror/ and build url map ----
async function precacheManifest(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const t0 = Date.now();
  let hits = 0, downloaded = 0, bytes = 0;
  console.log('[Offline] Precache START. Files:', OFFLINE_FILES.length, 'into', MIRROR_DIR);

  for (const raw of OFFLINE_FILES) {
    const path = raw.startsWith('/') ? raw : `/${raw}`;
    const abs = `${ORIGIN}${path}`;
    const dest = mirrorUriFor(path);
    const info = await FS.getInfoAsync(dest);
    if (!info.exists) {
      console.log('[Offline] Download START:', abs, '->', dest);
      await ensureParentDir(dest);
      try {
        const r = await FS.downloadAsync(abs, dest);
        const post = await FS.getInfoAsync(dest).catch(() => ({ size: 0 } as any));
        downloaded += 1;
        bytes += (post as any).size || 0;
        console.log('[Offline] Download DONE:', abs, 'status:', r?.status, 'size:', fmtBytes((post as any).size));
      } catch (e) {
        console.warn('[Offline] Precache FAIL:', abs, e);
      }
    } else {
      hits += 1;
      bytes += (info as any).size || 0;
      console.log('[Offline] Cache HIT:', path, '->', dest, 'size:', fmtBytes((info as any).size));
    }
    map[abs] = dest;
    map[path] = dest; // root-relative lookup
  }

  console.log('[Offline] Precache DONE in', `${Date.now() - t0}ms`, '| downloaded:', downloaded, '| hits:', hits, '| total:', OFFLINE_FILES.length, '| mirror size (seen):', fmtBytes(bytes));
  return map;
}

// ---- rewrite HTML to file:// mirror ----
function rewriteHtml(html: string, pageUrl: string, urlMap: Record<string, string>) {
  // 1) Base should point to the app folder, not site root
  const baseTag = `<base href="${ORIGIN}/ezops/ezops-offline/">`;
  if (/<base\b[^>]*href=/i.test(html)) {
    html = html.replace(/<base\b[^>]*href=["'][^"']*["'][^>]*>/i, baseTag);
  } else {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }

  // Defer bootstrap + offlinePatch (SCE + sanitizers), then resume
  const offlinePatch = `
<script>(function(){ if(location.protocol==='file:'){ window.name='NG_DEFER_BOOTSTRAP!'+(window.name||''); }})();</script>
<script>(function(){
  if(location.protocol!=='file:') return;
  function start(){
    if(!(window.angular && angular.module)) return setTimeout(start,10);
    try{
      var m = angular.module('offlinePatch', []);
      m.config(['$provide','$sceDelegateProvider','$compileProvider','$httpProvider', function($provide,$sceDelegateProvider,$compileProvider,$httpProvider){
        try{ $sceDelegateProvider.resourceUrlWhitelist(['self','file://**','${ORIGIN}/**']); }catch(_){}
        try{ $compileProvider.aHrefSanitizationWhitelist(/^(file|mailto|tel|https?):/); $compileProvider.imgSrcSanitizationWhitelist(/^(file|https?):/); }catch(_){}

        // Log all $http
        try{
          $httpProvider.interceptors.push(['$q', function($q){
            return {
              request: function(c){ try{ console.log('[offline:$http req]', c.method, c.url); }catch(_){}
                return c;
              },
              responseError: function(r){ try{ console.log('[offline:$http err]', r.status, r.config && r.config.url); }catch(_){}
                return $q.reject(r);
              }
            };
          }]);
        }catch(_){}

        // Mock critical APIs so user/db/init can proceed when offline
        try{
          $provide.decorator('$httpBackend', ['$delegate', function($delegate){
            function backend(method, url, post, cb, headers, timeout, withCreds, respType){
              try{
                if (/\\/getCurrentUserObject(?:\\?|$)/.test(url)) { setTimeout(function(){ cb(200, { id:'offline', name:'Offline User' }, '', 'OK', 'complete'); }, 0); return; }
                if (/\\/saveGPSLocation(?:\\?|$)/.test(url))  { setTimeout(function(){ cb(200, { ok:true }, '', 'OK', 'complete'); }, 0); return; }
                // Optional: stub common lookups so UI has something to render
                if (/fields?/i.test(url) && method==='GET') { setTimeout(function(){ cb(200, [{ name:'Field A'},{ name:'Field B'}], '', 'OK', 'complete'); }, 0); return; }
                if (/navigation/i.test(url) && method==='GET') { setTimeout(function(){ cb(200, { items: [] }, '', 'OK', 'complete'); }, 0); return; }
              }catch(_){}
              return $delegate(method, url, post, cb, headers, timeout, withCreds, respType);
            }
            for (var k in $delegate) backend[k] = $delegate[k];
            return backend;
          }]);
        }catch(_){}
      }]);

      // Seed minimal state so ng-if="$root.db && $root.user" passes and loader hides
      m.run(['$rootScope', function($root){
        if (!$root.user) $root.user = { id:'offline', name:'Offline User' };
        if (!$root.db)   $root.db   = { transaction: function(fn){ try{ fn({}); }catch(_){ } } };
        if (!$root.navSetUpComplete) $root.navSetUpComplete = true;
        if (!$root.setUpComplete)    $root.setUpComplete    = true;
        if (typeof $root.checkOrgSetting !== 'function') $root.checkOrgSetting = function(){ return true; };
      }]);

      // Ensure module is included for manual bootstrap
      var ob = angular.bootstrap;
      angular.bootstrap = function(el, mods){
        try{ if (Array.isArray(mods) && mods.indexOf('offlinePatch') === -1) mods = mods.concat(['offlinePatch']); }catch(_){}
        return ob.call(this, el, mods);
      };

      // Resume deferred auto-bootstrap (ng-app case)
      (function resume(){ if (angular.resumeBootstrap) angular.resumeBootstrap(['offlinePatch']); else setTimeout(resume,10); })();
      console.log('[offline] AngularJS patch active');
    }catch(e){ console.log('[offline] patch error', e && e.message); }
  }
  start();
})();</script>`;
  html = html.replace(/(<base\b[^>]*>)/i, `$1${offlinePatch}`);

  // Remove CSP/SRI that block local loads
  html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi,'');
  html = html.replace(/\s(integrity|crossorigin)=["'][^"']*["']/gi, '');

  // 4) Attribute rewrites (keep your existing logic)
  const ATTRS = ['href','src','data-main','data-template','data-url','templateUrl','ng-include'];
  const ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrsPattern = ATTRS.map(ESC).join('|');
  const attrRe = new RegExp(`(\\s(?:${attrsPattern})=)(['"])([^'"]+)\\2`, 'gi');

  html = html.replace(attrRe, (_m, attr, q, val) => {
    let abs = val;
    try { abs = new URL(val, pageUrl).toString(); } catch {}
    let path = abs;
    try { path = new URL(abs).pathname; } catch {}

    const mapped = urlMap[abs] || urlMap[path];
    if (mapped) return `${attr}${q}${mapped}${q}`;

    const isRoot = val.startsWith('/');
    const isTplRel = /^modals\//i.test(val) || /^partial\//i.test(val);
    const isSameOrigin = abs.startsWith(ORIGIN);
    if (isTplRel) return `${attr}${q}${mirrorUriFor(`/ezops/ezops-offline/${val}`)}${q}`;
    if (isSameOrigin || isRoot) return `${attr}${q}${mirrorUriFor(path)}${q}`;
    return `${attr}${q}${val}${q}`;
  });

  return html;
}

async function buildOfflineIndexFromMirror(urlMap: Record<string, string>) {
  const t0 = Date.now();
  const src = mirrorUriFor(OFFLINE_ENTRY_PATH);
  const srcInfo = await FS.getInfoAsync(src);
  if (!srcInfo.exists) throw new Error('Mirror source missing for index: ' + src);
  console.log('[Offline] Build index START from mirror:', src, 'size:', fmtBytes((srcInfo as any).size));

  const html = await FS.readAsStringAsync(src);
  const rewritten = rewriteHtml(html, `${ORIGIN}${OFFLINE_ENTRY_PATH}`, urlMap);

  await ensureDirAsync(PAGES_DIR);
  const dest = PAGES_DIR + 'index.html';
  await FS.writeAsStringAsync(dest, rewritten);

  const outInfo = await FS.getInfoAsync(dest).catch(() => ({ size: 0 } as any));
  if (rewritten.includes('..file:')) {
    console.warn('[Offline] Detected bad ../file: after rewrite.');
  }
  console.log('[Offline] Build index DONE ->', dest, 'size:', fmtBytes((outInfo as any).size), 'in', `${Date.now() - t0}ms`);
  return dest;
}

// ---- injected script: only rewrite XHR/fetch when offline (or file://) ----
const injectedBefore = `
(function(){
  try{
    function abs(u){
      try { return new URL(u, location.href).toString(); }
      catch(e){ return u; }
    }
    function toMirror(pathname){
      var base = ${JSON.stringify(MIRROR_DIR)};
      if (!pathname) return null;
      if (pathname[0] !== '/') pathname = '/' + pathname;
      return base + pathname.slice(1);
    }
    function re(u){
      var OFF = (location.protocol === 'file:') || !navigator.onLine;
      if (!OFF) return u; // do not touch when online on https
      var A = abs(u);
      try {
        var url = new URL(A);
        // same-origin absolute OR root-relative OR relative 'modals|partial'
        var P = url.pathname;
        var isTplRel = /^modals\\//i.test(u) || /^partial\\//i.test(u);
        if (isTplRel) return toMirror('/ezops/ezops-offline/' + u);
        if (url.origin === ${JSON.stringify(ORIGIN)} || u[0] === '/') return toMirror(P);
      } catch(_) {}
      return u;
    }
    // Report resource errors (helps debug)
    window.addEventListener('error', function(e){
      var t = e.target || {};
      var src = t.src || t.href || '';
      if (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG') {
        try { window.ReactNativeWebView.postMessage(JSON.stringify({ type:'__res_error', tag:t.tagName, src: src })); } catch(_){}
      }
    }, true);

    var of = window.fetch;
    window.fetch = function(){
      var a = Array.prototype.slice.call(arguments);
      if (typeof a[0] === 'string') a[0] = re(a[0]);
      else if (a[0] && a[0].url) a[0] = new Request(re(a[0].url), a[0]);
      return of.apply(this, a);
    };
    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url){
      return _open.call(this, method, re(url));
    };
  }catch(e){}
})();
true;
`;

// strengthen injected re() + add XHR diagnostics
const APP_PREFIX = '/ezops/ezops-offline/'; // where Angular offline templates actually live
const injectedJavaScriptBeforeContentLoaded = useMemo(() => `
(function(){
  try{
    function post(p){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(p)); }catch(_){ } }
    function abs(u){ try { return new URL(u, location.href).toString(); } catch(e){ return u; } }
    function toMirror(pathname){
      var base = ${JSON.stringify(MIRROR_DIR)};
      if (!pathname) return null;
      if (pathname[0] !== '/') pathname = '/' + pathname;
      return base + pathname.slice(1);
    }
    function isOff(){ return (location.protocol === 'file:') || !!(window.__OFFLINE__); }
    function needsAppPrefix(u){
      return /^((modals|partial|partials|views|templates|components)\\b|\\.|[^:/?#]+\\.html$)/i.test(u) &&
             !/^\\//.test(u) && !/^https?:/i.test(u);
    }
    function re(u){
      if (!isOff()) return u;
      if (!u || /^(data:|blob:|mailto:|tel:)/i.test(u)) return u;

      // Relative Angular templates like 'navigation.html', 'views/*.html'
      if (needsAppPrefix(u)) return toMirror(${JSON.stringify(APP_PREFIX)} + u.replace(/^\\.\\//,''));

      // Root-relative -> mirror as-is
      if (u[0] === '/') return toMirror(u);

      // Absolute same-origin -> mirror pathname
      var A = abs(u);
      try {
        var url = new URL(A);
        if (url.origin === ${JSON.stringify(ORIGIN)}) return toMirror(url.pathname);
      } catch(_) {}

      return u;
    }

    // Report tag resource errors
    window.addEventListener('error', function(e){
      var t = e.target || {}, src = t.src || t.href || '';
      if (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG') {
        post({ type:'__res_error', tag:t.tagName, src: src });
      }
    }, true);

    // Fetch/XHR rewrite + diagnostics
    var of = window.fetch;
    window.fetch = function(){
      var a = Array.prototype.slice.call(arguments);
      if (typeof a[0] === 'string') a[0] = re(a[0]);
      else if (a[0] && a[0].url) a[0] = new Request(re(a[0].url), a[0]);
      return of.apply(this, a);
    };
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url){
      this.__rewritten_url__ = re(url);
      try{ post({ type:'__xhr_open', url: this.__rewritten_url__ }); }catch(_){}
      return _open.call(this, method, this.__rewritten_url__);
    };
    XMLHttpRequest.prototype.send = function(){
      var self = this;
      function report(){
        try{
          if (self.readyState === 4 && (self.status === 0 || self.status >= 400)) {
            post({ type:'__xhr_error', status:self.status, url:self.__rewritten_url__ || '', resp:(self.responseText||'').slice(0,200) });
          }
        }catch(_){}
      }
      this.addEventListener('readystatechange', report);
      this.addEventListener('error', function(){ post({ type:'__xhr_error', status:-1, url:self.__rewritten_url__||'' }); });
      return _send.apply(this, arguments);
    };

    console.log('[Offline injector] active =', isOff(), 'at', location.href, 'prefix=', ${JSON.stringify(APP_PREFIX)});
  }catch(e){ try{ window.ReactNativeWebView.postMessage(JSON.stringify({ type:'__inject_error', message:String(e) })); }catch(_){ } }
})();
true;
`, []);

// ---- component
export default function HomeScreen() {
  const webRef = useRef<WebView>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [builtIndex, setBuiltIndex] = useState<string | null>(null);
  
  // Debug console state
  const [showDebugConsole, setShowDebugConsole] = useState(false);
  const [debugLogs, setDebugLogs] = useState<{timestamp: string, level: string, message: string}[]>([]);
  
  // Missing resources state
  const [missingResources, setMissingResources] = useState<string[]>([]);
  
  // Custom console logger
  const addDebugLog = (level: string, message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLogs(prev => {
      const newLogs = [...prev.slice(-49), { timestamp, level, message }];
      // Auto-scroll to bottom after state update
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
      return newLogs;
    });
  };

  // Override console methods to capture logs
  useEffect(() => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    
    console.log = (...args) => {
      addDebugLog('log', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
      originalLog(...args);
    };
    
    console.warn = (...args) => {
      addDebugLog('warn', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
      originalWarn(...args);
    };
    
    console.error = (...args) => {
      addDebugLog('error', args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
      originalError(...args);
    };
    
    // Initial log to test the system
    addDebugLog('log', '[DEBUG] Debug console initialized');
    
    // Restore on cleanup
    return () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    };
  }, []);

  // 1) Log NetInfo changes and ensure we flip to file:// when offline
  useEffect(() => {
    const sub = NetInfo.addEventListener(s => {
      const online = !!s.isConnected && (s.isInternetReachable ?? true);
      console.log('[Offline] NetInfo ->', online, s.type);
      setIsOnline(online);
    });
    return () => sub();
  }, []);

  // One-time: ensure dirs and version gate
  useEffect(() => {
    (async () => {
      console.log('[Offline] Init ROOT:', ROOT_DIR);
      await ensureDirAsync(ROOT_DIR);
      await ensureDirAsync(MIRROR_DIR);
      await ensureDirAsync(PAGES_DIR);
      const vf = ROOT_DIR + 'version.txt';
      const prev = await FS.readAsStringAsync(vf).catch(() => '');
      if (prev !== OFFLINE_VERSION) {
        console.log('[Offline] Version change', prev || '(none)', '->', OFFLINE_VERSION, '| resetting dir:', ROOT_DIR);
        await FS.deleteAsync(ROOT_DIR, { idempotent: true }).catch(()=>{});
        await ensureDirAsync(ROOT_DIR);
        await ensureDirAsync(MIRROR_DIR);
        await ensureDirAsync(PAGES_DIR);
        await FS.writeAsStringAsync(vf, OFFLINE_VERSION);
      } else {
        console.log('[Offline] Version OK:', OFFLINE_VERSION);
      }
      const idx = PAGES_DIR + 'index.html';
      const info = await FS.getInfoAsync(idx);
      console.log('[Offline] Existing built index?', info.exists, info.exists ? `size: ${fmtBytes((info as any).size)}` : '');
      if (info.exists) setBuiltIndex(idx);
    })();
  }, []);

  // Online: precache manifest and build offline index from mirrored file
  useEffect(() => {
    if (isOnline !== true) return;
    (async () => {
      console.log('[Offline] Online build pipeline START');
      try {
        const map = await precacheManifest();
        const built = await buildOfflineIndexFromMirror(map);
        setBuiltIndex(built);
      } catch (e) {
        console.warn('[Offline] Build failed:', e);
      } finally {
        console.log('[Offline] Online build pipeline DONE');
      }
    })();
  }, [isOnline]);

  // 2) Source selection logs (replace your current useMemo)
  const source = useMemo(() => {
    if (isOnline === false) {
      if (RAW_MIRROR_TEST) {
        const raw = mirrorUriFor(OFFLINE_ENTRY_PATH);
        console.log('[A/B] RAW MIRROR TEST ->', raw);
        return { uri: raw };
      }
      if (builtIndex) {
        console.log('[A/B] REWRITTEN PAGE ->', builtIndex);
        return { uri: builtIndex };
      }
    }
    console.log('[A/B] ONLINE ->', REMOTE_ENTRY);
    return { uri: REMOTE_ENTRY };
  }, [isOnline, builtIndex]);

  const consoleBridge = `
  (function(){
    if (window.__RN_BRIDGE__) return;
    function post(p){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(p)); }catch(_){}} 
    ['log','info','warn','error'].forEach(l=>{
      const o = console[l];
      console[l] = function(){ try{ post({ type:'__console', level:l, args:[].slice.call(arguments).map(String) }); }catch(_){};
        try{ o && o.apply(console, arguments); }catch(_){};
      };
    });
    window.addEventListener('error', function(e){
      post({ type:'__onerror', message:e.message, filename:e.filename, lineno:e.lineno, colno:e.colno, stack:e.error && e.error.stack });
    });
    window.addEventListener('unhandledrejection', function(e){
      post({ type:'__unhandledrejection', reason: (e.reason && e.reason.stack) || String(e.reason) });
    });
    window.__RN_BRIDGE__ = true;
  })(); true;
  `;

  const handleMessage = (event: any) => {
    const raw = event.nativeEvent.data;
    try {
      const data = JSON.parse(raw);
      switch (data.type) {
        case '__res_error':
          console.warn('[WV resource-error]', data.tag, data.src);
          
          // Extract the missing file path and add to missing resources
          if (data.src && data.src.includes('file://') && data.src.includes('/mirror/')) {
            const match = data.src.match(/\/mirror\/(.+)$/);
            if (match) {
              const missingPath = '/' + match[1];
              console.error('❌ MISSING FROM MANIFEST:', missingPath);
              
              // Add to missing resources list (avoid duplicates)
              setMissingResources(prev => {
                if (!prev.includes(missingPath)) {
                  return [...prev, missingPath];
                }
                return prev;
              });
            }
          }
          return;
        case '__console':
          console.log('[WV console]', ...(data.args || []));
          return;
        case '__onerror':
          console.error('[WV onerror]', data);
          return;
        case '__unhandledrejection':
          console.error('[WV unhandledrejection]', data.reason);
          return;
        case '__snapshot':
          console.log('[SNAPSHOT]', data);
          return;
        case '__snapshot_error':
          console.error('[SNAPSHOT ERROR]', data.message);
          return;
        case '__xhr_error':
          console.error('[WV XHR error]', data.status, data.url);
          return;
        case '__blocked_nav':
          console.warn('[WV blocked navigation]', data.url);
          return;
        case '__xhr_open':
          console.log('[WV XHR open]', data.url);
          return;
        case '__ng_diag':
          console.log('[NG DIAG]', data.data);
          return;
        case '__ng_boot':
          console.log('[NG BOOT]', data);
          return;
        case '__ng_boot_forced':
          console.log('[NG BOOT FORCED]', data);
          return;
        case '__ng_flags_forced':
          console.log('[NG FLAGS] setUpComplete/navSetUpComplete forced');
          return;
        case '__ng_http':
          console.log('[NG HTTP pending]', data.pending);
          return;
        case '__ng_boot_err':
        case '__ng_diag_err':
          console.error('[NG DIAG ERROR]', data.msg);
          return;
      }
    } catch {}
    console.log('WebView message:', raw);
  };

  // Add this effect to log missing resources for easy copying
  useEffect(() => {
    if (missingResources.length > 0) {
      console.log('\n📝 === MISSING FILES TO ADD TO OFFLINE_FILES ===');
      missingResources.forEach(path => {
        console.log(`  '${path}',`);
      });
      console.log('============================================\n');
    }
  }, [missingResources]);

  // enhance handleLoadEnd to dump Angular diagnostics after load
  const handleLoadEnd = () => {
    console.log('WebView load ended');
    webRef.current?.injectJavaScript(`
      (function(){
        function post(p){ try{ window.ReactNativeWebView.postMessage(JSON.stringify(p)); }catch(_){ } }
        function diag(at){
          try{
            var el = document.querySelector('[ng-app]') || document.body;
            var hasNg = !!window.angular;
            var inj = (hasNg && el && angular.element(el).injector) ? angular.element(el).injector() : null;
            post({ type:'__ng_boot', at: at, hasNg: hasNg, hasInjector: !!inj, ngVer: hasNg && angular.version && angular.version.full });
            return inj;
          }catch(e){ post({ type:'__ng_boot_err', msg: String(e) }); return null; }
        }
        // Try a few times; if still no injector, force bootstrap
        var tries = 0;
        (function tick(){
          var inj = diag('tick:'+tries);
          if (!inj && tries < 4) { tries++; return setTimeout(tick, 400); }
          if (!inj && window.angular) {
            try {
              angular.bootstrap(document, ['app','offlinePatch']);
              post({ type:'__ng_boot_forced', ok: true });
            } catch(e) {
              post({ type:'__ng_boot_forced', ok: false, err: String(e) });
            }
          }
          setTimeout(function(){
            var inj2 = diag('post-force');
            try{
              if (inj2) {
                var $root = inj2.get('$rootScope');
                if (!$root.navSetUpComplete || !$root.setUpComplete) {
                  $root.$applyAsync(function(){
                    if (!$root.navSetUpComplete) $root.navSetUpComplete = true;
                    if (!$root.setUpComplete) $root.setUpComplete = true;
                  });
                  post({ type:'__ng_flags_forced' });
                }
                var $http = inj2.get && inj2.get('$http');
                post({ type:'__ng_http', pending: ($http && $http.pendingRequests && $http.pendingRequests.length) || 0 });
              }
            }catch(e){ post({ type:'__ng_diag_err', msg: String(e) }); }
          }, 800);
        })();
      })();
      true;
    `);
    SplashScreen.hideAsync().catch(() => {});
  };

  const handleLoadStart = () => console.log('WebView load started');
  const handleError = (e: any) => console.log('WebView error', e?.nativeEvent || e);
  const handleHttpError = (e: any) => console.log('WebView HTTP error', e?.nativeEvent || e);

  // 1) Keep a page-side flag and sync it from RN
  useEffect(() => {
    if (!webRef.current) return;
    const js = `
      try {
        window.__OFFLINE__ = ${isOnline === false ? 'true' : 'false'};
        console.log('[Offline inject] __OFFLINE__ =', window.__OFFLINE__, 'protocol=', location.protocol);
      } catch(_) {}
      true;
    `;
    webRef.current.injectJavaScript(js);
  }, [isOnline]);

  // 2) Use __OFFLINE__ in the injector (remove navigator.onLine)
  const injectedJavaScriptBeforeContentLoaded = useMemo(() => `
  (function(){
    try{
      function abs(u){
        try { return new URL(u, location.href).toString(); }
        catch(e){ return u; }
      }
      function toMirror(pathname){
        var base = ${JSON.stringify(MIRROR_DIR)};
        if (!pathname) return null;
        if (pathname[0] !== '/') pathname = '/' + pathname;
        return base + pathname.slice(1);
      }
      function isOff(){
        return (location.protocol === 'file:') || !!(window.__OFFLINE__);
      }
      function re(u){
        if (!isOff()) return u; // do not touch when online on https
        var A = abs(u);
        try {
          var url = new URL(A);
          var P = url.pathname;
          var isTplRel = /^modals\\//i.test(u) || /^partial\\//i.test(u);
          if (isTplRel) return toMirror('/ezops/ezops-offline/' + u);
          if (url.origin === ${JSON.stringify(ORIGIN)} || u[0] === '/') return toMirror(P);
        } catch(_) {}
        return u;
      }
      // Debug
      console.log('[Offline injector] active =', isOff(), 'at', location.href);

      // Resource errors
      window.addEventListener('error', function(e){
        var t = e.target || {};
        var src = t.src || t.href || '';
        if (t.tagName === 'SCRIPT' || t.tagName === 'LINK' || t.tagName === 'IMG') {
          try { window.ReactNativeWebView.postMessage(JSON.stringify({ type:'__res_error', tag:t.tagName, src: src })); } catch(_){}
        }
      }, true);

      var of = window.fetch;
      window.fetch = function(){
        var a = Array.prototype.slice.call(arguments);
        if (typeof a[0] === 'string') a[0] = re(a[0]);
        else if (a[0] && a[0].url) a[0] = new Request(re(a[0].url), a[0]);
        return of.apply(this, a);
      };
      var _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url){
        return _open.call(this, method, re(url));
      };
    }catch(e){}
  })();
  true;
  `, []);

  // Add a key that changes when switching online/offline
  const webViewKey = useMemo(() => {
    const mode = isOnline === false && builtIndex ? 'offline' : 'online';
    const key = `webview-${mode}`;
    console.log('[DEBUG] WebView key changed to:', key, 'source:', source.uri);
    return key;
  }, [isOnline, builtIndex]);

  // Only render WebView when we have a definitive online/offline state
  const shouldRender = isOnline !== null;
  const isOfflineMode = isOnline === false && builtIndex;

  // Log offline index content for debugging
  useEffect(() => {
    if (isOnline === false && builtIndex) {
      FS.readAsStringAsync(builtIndex).then(html => {
        console.log('[OFFLINE] index size:', html.length);
        console.log('[OFFLINE] index preview:', html.slice(0, 1000));
        console.log('[OFFLINE] script tags:', (html.match(/<script/gi) || []).length);
        console.log('[OFFLINE] link tags:', (html.match(/<link/gi) || []).length);
      }).catch(err => console.error('[OFFLINE] read failed', err));
    }
  }, [isOnline, builtIndex]);

  // Loosen navigation guard to allow all file:// under ROOT_DIR (pages/ and mirror/)
  const onShouldStartLoadWithRequest = (req: any) => {
    if (isOnline === false) {
      if (/^https?:/i.test(req.url)) {
        console.warn('[Offline] Blocked navigation to', req.url);
        return false;
      }
      if (/^file:/i.test(req.url)) {
        const url = decodeURI(req.url);
        const roots = [ROOT_DIR, MIRROR_DIR, PAGES_DIR].map(decodeURI);
        const ok = roots.some(r => url.startsWith(r));
        if (!ok) console.warn('[Offline] Blocked file navigation', url);
        return ok;
      }
    }
    return true;
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <View style={styles.container}>
        {/* Debug Console Toggle Button */}
        <TouchableOpacity 
          style={styles.debugToggle} 
          onPress={() => setShowDebugConsole(!showDebugConsole)}
          onLongPress={() => setDebugLogs([])} // Long press to clear logs
        >
          <Text style={styles.debugToggleText}>
            {showDebugConsole ? '✖️' : '🐛'} Debug ({debugLogs.length})
          </Text>
        </TouchableOpacity>

        <View style={styles.webViewContainer}>
          <WebView
            key={webViewKey} // This will force remount
            ref={webRef}
            source={source}
            style={styles.webView}
            onLoadStart={handleLoadStart}
            onLoadEnd={handleLoadEnd}
            onError={handleError}
            onHttpError={handleHttpError}
            onMessage={handleMessage}
            injectedJavaScriptBeforeContentLoaded={injectedJavaScriptBeforeContentLoaded}
            injectedJavaScript={consoleBridge}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            mixedContentMode="compatibility"
            thirdPartyCookiesEnabled
            sharedCookiesEnabled
            allowsInlineMediaPlayback
            originWhitelist={['*']}
            // iOS: allow file:// page to read both pages/ and mirror/
            allowingReadAccessToURL={READ_SCOPE} // TEMP: MIRROR_DIR when RAW_MIRROR_TEST=true, else ROOT_DIR
            // Android: enable file:// XHR when offline
            allowFileAccess
            allowFileAccessFromFileURLs
            allowUniversalAccessFromFileURLs
            cacheEnabled={true}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          />
        </View>

        {/* Debug Console Overlay */}
        {showDebugConsole && (
          <View style={styles.debugConsole}>
            <View style={styles.debugHeader}>
              <Text style={styles.debugTitle}>
                Debug Console ({debugLogs.length}/50) - 
                {isOnline === null ? ' Unknown' : isOnline ? ' Online' : ' Offline'}
                {builtIndex && !isOnline ? ' (Built)' : ''}
              </Text>
              <View style={styles.debugControls}>
                <TouchableOpacity onPress={() => setDebugLogs([])}>
                  <Text style={styles.debugButton}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowDebugConsole(false)}>
                  <Text style={styles.debugButton}>Close</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView 
              ref={scrollViewRef}
              style={styles.debugLogContainer}
              showsVerticalScrollIndicator={true}
            >
              {debugLogs.length === 0 && (
                <Text style={styles.debugEmptyText}>No logs yet...</Text>
              )}
              {debugLogs.map((log, index) => (
                <View key={index} style={[styles.debugLogItem, styles[`debug${log.level}`] || {}]}>
                  <Text style={styles.debugTimestamp}>{log.timestamp}</Text>
                  <Text style={styles.debugMessage} selectable>{log.message}</Text>
                </View>
              ))}

              {/* Show missing resources in debug console */}
              {missingResources.length > 0 && (
                <View style={[styles.debugLogItem, styles.debugerror]}>
                  <Text style={styles.debugTimestamp}>MISSING</Text>
                  <Text style={styles.debugMessage} selectable>
                    📝 Files missing from OFFLINE_FILES:{'\n'}
                    {missingResources.map(path => `'${path}',`).join('\n')}
                    {'\n\n'}Copy these lines to your offlineManifest.ts
                  </Text>
                </View>
              )}

              {/* Show HTML file debug info */}
              {/* {builtIndex && isOnline === false && (
                <View style={[styles.debugLogItem, styles.debuglog]}>
                  <Text style={styles.debugTimestamp}>HTML</Text>
                  <Text style={styles.debugMessage} selectable>
                    Built index: {builtIndex}{'\n'}
                    Tap to refresh and see preview above
                  </Text>
                </View>
              )} */}
            </ScrollView>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#000000' },
  container: { flex: 1, backgroundColor: '#ffffff' },
  webViewContainer: { flex: 1 },
  webView: { flex: 1 },
  
  // Debug Console Styles
  debugToggle: {
    position: 'absolute',
    top: 50,
    right: 20,
    backgroundColor: 'rgba(0,0,0,0.8)',
    padding: 8,
    borderRadius: 20,
    zIndex: 1000,
    minWidth: 100,
  },
  debugToggleText: {
    color: 'white',
    fontSize: 12,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  debugConsole: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: Dimensions.get('window').height * 0.5,
    backgroundColor: 'rgba(0,0,0,0.95)',
    borderTopWidth: 1,
    borderTopColor: '#333',
    zIndex: 999,
  },
  debugHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
    backgroundColor: 'rgba(20,20,20,0.9)',
  },
  debugTitle: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 12,
    flex: 1,
  },
  debugControls: {
    flexDirection: 'row',
    gap: 15,
  },
  debugButton: {
    color: '#007AFF',
    fontSize: 14,
  },
  debugLogContainer: {
    flex: 1,
    padding: 5,
  },
  debugEmptyText: {
    color: '#888',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 20,
  },
  debugLogItem: {
    flexDirection: 'row',
    padding: 6,
    borderBottomWidth: 0.5,
    borderBottomColor: '#333',
  },
  debugTimestamp: {
    color: '#888',
    fontSize: 10,
    width: 70,
    marginRight: 8,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  debugMessage: {
    color: 'white',
    fontSize: 11,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  debuglog: {
    backgroundColor: 'transparent',
  },
  debugwarn: {
    backgroundColor: 'rgba(255,193,7,0.1)',
  },
  debugerror: {
    backgroundColor: 'rgba(220,53,69,0.2)',
  },
});
