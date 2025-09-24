import * as SplashScreen from 'expo-splash-screen';
import React from 'react';
import { SafeAreaView, StatusBar, StyleSheet, View } from 'react-native';
import WebView from 'react-native-webview';

export default function HomeScreen() {
  const handleLoadEnd = () => {
    console.log('WebView load ended');
    SplashScreen.hideAsync().catch(() => {});
  };

  const handleLoadStart = () => console.log('WebView load started');
  const handleError = (e: any) => console.log('WebView error', e);
  const handleHttpError = (e: any) => console.log('WebView HTTP error', e);
  const handleMessage = (event: any) => {
    console.log('WebView message:', event.nativeEvent.data);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <View style={styles.container}>
        <View style={styles.webViewContainer}>
          <WebView
            source={{ uri: 'https://stage-api.ezoperations.com/login' }}
            style={styles.webView}
            onLoadStart={handleLoadStart}
            onLoadEnd={handleLoadEnd}
            onError={handleError}
            onHttpError={handleHttpError}
            onMessage={handleMessage}
            javaScriptEnabled
            domStorageEnabled
            startInLoadingState
            mixedContentMode="compatibility"
            thirdPartyCookiesEnabled
            sharedCookiesEnabled
            allowsInlineMediaPlayback
            originWhitelist={['https://*']}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#000000' }, // makes top area black
  container: { flex: 1, backgroundColor: '#ffffff' }, // app body white
  webViewContainer: { flex: 1 },
  webView: { flex: 1 },
});
