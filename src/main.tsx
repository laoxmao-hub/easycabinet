import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

// Safe check/polyfill for localStorage to prevent crashes in private tabs/sandboxed iframes on mobile devices
try {
 // Test if localStorage is accessible
 const testKey = '__test_local_storage__';
 window.localStorage.setItem(testKey, testKey);
 window.localStorage.removeItem(testKey);
} catch (e) {
 console.warn("localStorage is not accessible in this context. Creating an in-memory fallback helper.", e);
 const memStorage: Record<string, string> = {};
 const mockStorage: Storage = {
 length: 0,
 clear() {
 for (const k in memStorage) {
 delete memStorage[k];
 }
 this.length = 0;
 },
 getItem(key: string) {
 return Object.prototype.hasOwnProperty.call(memStorage, key) ? memStorage[key] : null;
 },
 key(index: number) {
 const keys = Object.keys(memStorage);
 return keys[index] || null;
 },
 removeItem(key: string) {
 delete memStorage[key];
 this.length = Object.keys(memStorage).length;
 },
 setItem(key: string, value: string) {
 memStorage[key] = String(value);
 this.length = Object.keys(memStorage).length;
 }
 };
 
 try {
 Object.defineProperty(window, 'localStorage', {
 value: mockStorage,
 writable: true,
 configurable: true
 });
 } catch (err) {
 console.error("Critical: Could not define localStorage polyfill.", err);
 }
}

import App from './App.tsx';
import './index.css';
import { AlertProvider } from './lib/AlertContext.tsx';
import { LanguageProvider } from './lib/LanguageContext.tsx';

// Bỏ qua các cảnh báo deprecated của Three.js từ thư viện bên thứ ba phát sinh trong console
const originalWarn = console.warn;
console.warn = (...args) => {
 const msg = args[0];
 if (typeof msg === 'string' && (
 msg.includes('PCFSoftShadowMap has been deprecated') ||
 msg.includes('THREE.Clock: This module has been deprecated') ||
 msg.includes('THREE.Clock has been deprecated')
 )) {
 return;
 }
 originalWarn(...args);
};

// Register Service Worker for PWA notifications
if ('serviceWorker' in navigator) {
 window.addEventListener('load', () => {
 navigator.serviceWorker.register('/sw.js')
 .then((reg) => {
 console.log('Service Worker registered successfully:', reg.scope);
 })
 .catch((err) => {
 console.warn('Service Worker registration failed:', err);
 });
 });
}

createRoot(document.getElementById('root')!).render(
 <StrictMode>
 <LanguageProvider>
 <AlertProvider>
 <App />
 </AlertProvider>
 </LanguageProvider>
 </StrictMode>,
);
