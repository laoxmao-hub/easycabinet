import React, { createContext, useContext, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';

type AlertType = 'success' | 'error' | 'warning' | 'info';

interface AlertState {
 isOpen: boolean;
 message: string;
 type: AlertType | 'confirm';
 title?: string;
 onClose?: () => void;
 onConfirm?: () => void;
}

interface AlertContextType {
 showAlert: (message: string, type?: AlertType, title?: string) => void;
 showSuccess: (message: string, title?: string) => void;
 showError: (message: string, title?: string) => void;
 showWarning: (message: string, title?: string) => void;
 showInfo: (message: string, title?: string) => void;
 showConfirm: (options: { title: string; message: string; onConfirm: () => void }) => void;
}

const AlertContext = createContext<AlertContextType | undefined>(undefined);

export function useAlert() {
 const context = useContext(AlertContext);
 if (!context) {
 throw new Error('useAlert must be used within an AlertProvider');
 }
 return context;
}

interface ToastState {
 isOpen: boolean;
 message: string;
 type: AlertType;
 title?: string;
}

export function AlertProvider({ children }: { children: React.ReactNode }) {
 const [state, setState] = useState<AlertState>({
 isOpen: false,
 message: '',
 type: 'info',
 });

 const [toast, setToast] = useState<ToastState>({
 isOpen: false,
 message: '',
 type: 'info',
 });

 const showToast = (message: string, type: AlertType = 'success', title?: string) => {
  setToast({ isOpen: true, message, type, title: title || getDefaultTitle(type) });
  setTimeout(() => setToast(prev => ({ ...prev, isOpen: false })), 3000);
 };

 const showAlert = (message: string, type: AlertType = 'info', title?: string) => {
 setState({
 isOpen: true,
 message,
 type,
 title: title || getDefaultTitle(type),
 });
 };

 const showSuccess = (message: string, title?: string) => showToast(message, 'success', title);
 const showError = (message: string, title?: string) => showAlert(message, 'error', title);
 const showWarning = (message: string, title?: string) => showAlert(message, 'warning', title);
 const showInfo = (message: string, title?: string) => showAlert(message, 'info', title);
 
 const showConfirm = (options: { title: string; message: string; onConfirm: () => void }) => {
 setState({
 isOpen: true,
 message: options.message,
 type: 'confirm',
 title: options.title,
 onConfirm: options.onConfirm
 });
 };

 const closeAlert = () => {
 setState((prev) => ({ ...prev, isOpen: false }));
 if (state.onClose) {
 state.onClose();
 }
 };

 // Override window.alert globally!
 useEffect(() => {
 const originalAlert = window.alert;
 
 window.alert = (message: string) => {
 // Determine potential type based on message text
 let type: AlertType = 'info';
 let title = 'Thông báo';
 
 const lowerMsg = message.toLowerCase();
 if (lowerMsg.includes('lỗi') || lowerMsg.includes('thất bại') || lowerMsg.includes('không thể') || lowerMsg.includes('sai')) {
 type = 'error';
 title = 'Có lỗi xảy ra';
 } else if (lowerMsg.includes('thành công') || lowerMsg.includes('hoàn tất') || lowerMsg.includes('đã lưu') || lowerMsg.includes('ok')) {
 type = 'success';
 title = 'Thành công';
 } else if (lowerMsg.includes('cảnh báo') || lowerMsg.includes('vui lòng') || lowerMsg.includes('yêu cầu') || lowerMsg.includes('chú ý')) {
 type = 'warning';
 title = 'Chú ý';
 }
 
 setState({
 isOpen: true,
 message,
 type,
 title,
 });
 };

 return () => {
 window.alert = originalAlert;
 };
 }, []);

 const getDefaultTitle = (type: AlertType): string => {
 switch (type) {
 case 'success':
 return 'Thành công';
 case 'error':
 return 'Lỗi hệ thống';
 case 'warning':
 return 'Cảnh báo';
 case 'info':
 default:
 return 'Thông báo';
 }
 };

 const getAlertStyles = (type: AlertType | 'confirm') => {
 switch (type) {
 case 'confirm':
 return {
 icon: <AlertTriangle className="w-10 h-10 text-indigo-500" />,
 borderColor: 'border-indigo-200',
 badgeBg: 'bg-indigo-100 text-indigo-600',
 buttonBg: 'bg-indigo-600 hover:bg-indigo-700 text-white',
 };
 case 'success':
 return {
 icon: <CheckCircle2 className="w-10 h-10 text-emerald-500" />,
 borderColor: 'border-emerald-100',
 badgeBg: 'bg-emerald-100 text-emerald-600',
 buttonBg: 'bg-emerald-600 hover:bg-emerald-700 text-white',
 };
 case 'error':
 return {
 icon: <XCircle className="w-10 h-10 text-rose-500" />,
 borderColor: 'border-rose-100',
 badgeBg: 'bg-rose-100 text-rose-600',
 buttonBg: 'bg-rose-500 hover:bg-rose-600 text-white',
 };
 case 'warning':
 return {
 icon: <AlertTriangle className="w-10 h-10 text-amber-500" />,
 borderColor: 'border-amber-100',
 badgeBg: 'bg-amber-100#78350f]/10 text-amber-600',
 buttonBg: 'bg-amber-500 hover:bg-amber-600 text-white',
 };
 case 'info':
 default:
 return {
 icon: <Info className="w-10 h-10 text-indigo-500" />,
 borderColor: 'border-indigo-100',
 badgeBg: 'bg-indigo-100 text-indigo-600',
 buttonBg: 'bg-indigo-600 hover:bg-indigo-700 text-white',
 };
 }
 };

 const styles = getAlertStyles(state.type);

 return (
 <AlertContext.Provider value={{ showAlert, showSuccess, showError, showWarning, showInfo, showConfirm }}>
 {children}
 
 <AnimatePresence>
 {state.isOpen && (
 <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
 {/* Backdrop */}
 <motion.div
 initial={{ opacity: 0 }}
 animate={{ opacity: 1 }}
 exit={{ opacity: 0 }}
 onClick={closeAlert}
 className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs"
 />
 
 {/* Modal Content */}
 <motion.div
 initial={{ opacity: 0, scale: 0.95, y: 15 }}
 animate={{ opacity: 1, scale: 1, y: 0 }}
 exit={{ opacity: 0, scale: 0.95, y: 15 }}
 className={`relative bg-white w-full max-w-sm rounded-lg shadow-2xl border ${styles.borderColor} overflow-hidden p-6 z-10`}
 >
 {/* Close Button */}
 <button
 onClick={closeAlert}
 className="absolute top-4 right-4 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
 >
 <X size={16} />
 </button>

 <div className="flex flex-col items-center text-center mt-2 font-sans">
 {/* Icon wrapper */}
 <div className={`p-3 rounded-lg ${styles.badgeBg} mb-4 flex items-center justify-center`}>
 {styles.icon}
 </div>

 {/* Title */}
 <h3 className="text-base font-bold text-slate-800 uppercase tracking-wider mb-2 font-sans">
 {state.title}
 </h3>

 {/* Message */}
 <p className="text-sm font-medium text-slate-600 font-sans leading-relaxed break-words whitespace-pre-wrap max-h-[50vh] overflow-y-auto px-2 w-full">
 {state.message}
 </p>

 {/* Action Buttons */}
 {state.type === 'confirm' ? (
 <div className="flex items-center gap-3 w-full mt-6">
 <button
 type="button"
 onClick={closeAlert}
 className="flex-1 py-2.5 px-4 border border-slate-200 rounded-lg text-slate-600 font-bold text-sm uppercase tracking-wider hover:bg-slate-100 transition-all cursor-pointer"
 >
 Hủy
 </button>
 <button
 type="button"
 onClick={() => {
 if (state.onConfirm) {
 state.onConfirm();
 }
 closeAlert();
 }}
 className="flex-1 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-bold text-sm uppercase tracking-wider transition-all active:scale-97 shadow-md cursor-pointer"
 >
 Xác nhận
 </button>
 </div>
 ) : (
 <button
 type="button"
 onClick={closeAlert}
 className={`w-full mt-6 py-2.5 px-4 rounded-lg font-bold text-sm uppercase tracking-wider transition-all active:scale-97 shadow-md cursor-pointer ${styles.buttonBg}`}
 >
 Xác nhận
 </button>
 )}
 </div>
 </motion.div>
 </div>
 )}
 </AnimatePresence>

 {/* Toast Notification */}
 <AnimatePresence>
  {toast.isOpen && (
  <motion.div
   initial={{ opacity: 0, scale: 0.9 }}
   animate={{ opacity: 1, scale: 1 }}
   exit={{ opacity: 0, scale: 0.9 }}
   className="fixed inset-0 z-[10001] flex items-center justify-center pointer-events-none"
  >
   <div
    onClick={() => setToast(prev => ({ ...prev, isOpen: false }))}
    className={`flex items-center gap-3 px-6 py-4 rounded-xl shadow-2xl border cursor-pointer pointer-events-auto transition-all hover:scale-105 ${
    toast.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' :
    toast.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700' :
    toast.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-700' :
    'bg-indigo-50 border-indigo-200 text-indigo-700'
   }`}>
    {toast.type === 'success' && <CheckCircle2 size={22} />}
    {toast.type === 'error' && <XCircle size={22} />}
    {toast.type === 'warning' && <AlertTriangle size={22} />}
    {toast.type === 'info' && <Info size={22} />}
    <span className="text-sm font-black whitespace-nowrap uppercase tracking-wide">{toast.message}</span>
   </div>
  </motion.div>
  )}
 </AnimatePresence>
 </AlertContext.Provider>
 );
}
