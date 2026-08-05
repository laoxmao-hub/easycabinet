import React, { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
 readonly platforms: string[];
 readonly userChoice: Promise<{
 outcome: 'accepted' | 'dismissed';
 platform: string;
 }>;
 prompt(): Promise<void>;
}

export function PwaInstallPrompt() {
 const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
 const [showPrompt, setShowPrompt] = useState(false);

 useEffect(() => {
 const isMobileDevice = () => {
 return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
 };

 const isStandalone = () => {
 return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
 };

 const handleBeforeInstallPrompt = (e: Event) => {
 // Ngăn chặn prompt mặc định của browser
 e.preventDefault();
 
 const promptEvent = e as BeforeInstallPromptEvent;
 
 // Chỉ kích hoạt nếu là Mobile, chưa cài đặt và chưa từ chối trong vòng 3 ngày gần đây
 if (isMobileDevice() && !isStandalone()) {
 const dismissTime = localStorage.getItem('pwa_dismiss_install_prompt');
 const isDismissedRecently = dismissTime && (Date.now() - parseInt(dismissTime, 10) < 3 * 24 * 60 * 60 * 1000);
 
 if (!isDismissedRecently) {
 setDeferredPrompt(promptEvent);
 setShowPrompt(true);
 }
 }
 };

 window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

 // Kiểm tra PWA đã được cài đặt thành công chưa
 const handleAppInstalled = () => {
 setShowPrompt(false);
 setDeferredPrompt(null);
 };
 window.addEventListener('appinstalled', handleAppInstalled);

 return () => {
 window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
 window.removeEventListener('appinstalled', handleAppInstalled);
 };
 }, []);

 const handleInstall = async () => {
 if (!deferredPrompt) return;
 
 // Hiển thị prompt cài đặt hệ thống
 await deferredPrompt.prompt();
 
 const choiceResult = await deferredPrompt.userChoice;
 if (choiceResult.outcome === 'accepted') {
 console.log('User accepted the install prompt');
 } else {
 console.log('User dismissed the install prompt');
 // Nếu huỷ thì lưu dismissal để tránh hiện lại liên tục
 localStorage.setItem('pwa_dismiss_install_prompt', Date.now().toString());
 }
 
 setDeferredPrompt(null);
 setShowPrompt(false);
 };

 const handleDismiss = () => {
 localStorage.setItem('pwa_dismiss_install_prompt', Date.now().toString());
 setShowPrompt(false);
 };

 if (!showPrompt) return null;

 return (
 <div id="pwa-install-prompt" className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 bg-slate-900 text-white p-4 rounded-lg shadow-2xl z-100 border border-slate-800 font-sans">
 <div className="flex items-start justify-between">
 <div className="flex items-center space-x-3">
 <div className="p-2 bg-indigo-600 rounded-sm">
 <Download className="w-5 h-5 text-white" />
 </div>
 <div>
 <h4 className="text-sm font-bold tracking-tight">Cài đặt Ứng dụng di động</h4>
 <p className="text-xs text-slate-400 leading-normal mt-0.5">Trải nghiệm mượt mà, truy cập nhanh hơn từ màn hình chính.</p>
 </div>
 </div>
 <button id="pwa-dismiss-btn-top" onClick={handleDismiss} className="text-slate-400 hover:text-white transition-colors cursor-pointer p-0.5">
 <X className="w-4 h-4" />
 </button>
 </div>
 <div className="flex items-center justify-end space-x-3 mt-4">
 <button
 id="pwa-later-btn"
 onClick={handleDismiss}
 className="px-3 py-1.5 text-xs font-semibold text-slate-300 hover:text-white transition-all cursor-pointer rounded-sm hover:bg-slate-800"
 >
 Để sau
 </button>
 <button
 id="pwa-install-btn"
 onClick={handleInstall}
 className="px-4 py-1.5 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 transition-all text-white shadow-md rounded-sm cursor-pointer"
 >
 Cài đặt ngay
 </button>
 </div>
 </div>
 );
}
