import * as FileSystem from 'expo-file-system/legacy';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import StaticServer from 'react-native-static-server';
import WebView from 'react-native-webview';

const REMOTE_ENTRY = 'https://stage-api.ezoperations.com/login';

export default function HomeScreen() {
  const webRef = useRef<WebView>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  useEffect(() => {
    let server: StaticServer | null = null;
    (async () => {
      try {
        // Directory we already mirror to
        const rootUri = `${FileSystem.documentDirectory}ezops/offline/mirror/`; // file://...
        // Make sure it exists (no-op if already there)
        await FileSystem.makeDirectoryAsync(rootUri, { intermediates: true }).catch(() => {});
        // StaticServer needs an absolute fs path (no file://)
        const servePath = rootUri.replace(/^file:\/\//, '').replace(/\/+$/, '');
        server = new StaticServer(0, servePath, { localOnly: true, keepAlive: true }); // 0 = random port
        const url = await server.start(); // e.g. http://127.0.0.1:49271
        console.log('[static-server] started', url, 'servePath', servePath);
        setLocalUrl(url);
      } catch (e) {
        console.warn('[static-server] failed to start', e);
      }
    })();
    return () => { server?.stop(); };
  }, []);

  const source = useMemo(() => {
    if (localUrl) return { uri: `${localUrl}/ezops/ezops-offline/index.html` };
    return { uri: REMOTE_ENTRY };
  }, [localUrl]);

  const handleLoadEnd = () => { console.log('WebView load ended'); SplashScreen.hideAsync().catch(() => {}); };
  const handleLoadStart = () => console.log('WebView load started');
  const handleError = (e: any) => console.log('WebView error', e);
  const handleHttpError = (e: any) => console.log('WebView HTTP error', e);
  const handleMessage = (event: any) => console.log('WebView message:', event.nativeEvent.data);

  const openInSafari = async () => {
    try {
      const res = await WebBrowser.openBrowserAsync(REMOTE_ENTRY, {
        // presentationStyle: 'fullScreen',
        dismissButtonStyle: 'close',
        controlsColor: '#000000',
        // prefersEphemeralSession: false,
      });
      console.log('[SafariVC] result', res);
    } catch (e) {
      console.error('[SafariVC] open error', e);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <View style={styles.container}>
        <View style={styles.webViewContainer}>
          <WebView
            ref={webRef}
            source={source}
            style={styles.webView}
            onLoadStart={handleLoadStart}
            onLoadEnd={handleLoadEnd}
            onError={handleError}
            onHttpError={handleHttpError}
            onMessage={handleMessage}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            mixedContentMode="always"
            thirdPartyCookiesEnabled
            sharedCookiesEnabled
            allowsInlineMediaPlayback
            originWhitelist={['http://*', 'https://*']}
            setSupportMultipleWindows={false}
          />
        </View>
        <TouchableOpacity onPress={openInSafari} style={[styles.debugToggle, { right: 140 }]}>
          <Text style={styles.debugToggleText}>Open in SafariVC</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#000000' },
  container: { flex: 1, backgroundColor: '#ffffff' },
  webViewContainer: { flex: 1 },
  webView: { flex: 1 },
  debugToggle: { position: 'absolute', bottom: 50, left: 20, padding: 10, backgroundColor: '#007AFF', borderRadius: 5 },
  debugToggleText: { color: '#ffffff', fontWeight: 'bold' },
});
