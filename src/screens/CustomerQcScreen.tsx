import React, { useState, useEffect } from 'react';
import { matchSearchQuery } from '../types';
import { 
 Plus, Check, X, QrCode, ClipboardCheck, ArrowLeft, Loader2, Search, Edit3, Save, AlertCircle, Share2, Info, Building, Calendar, UserCheck
} from 'lucide-react';
import { doc, onSnapshot, getDoc, updateDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { updateProjectModule } from '../lib/dualWrite';
import { ScannerModal, ScannedResult } from '../components/ScannerModal';
import { useAuth } from '../lib/AuthContext';
import { motion, AnimatePresence } from 'motion/react';

interface CustomerQcScreenProps {
 ticketId: string;
 onBack: () => void;
}

export function CustomerQcScreen({ ticketId, onBack }: CustomerQcScreenProps) {
 const { user } = useAuth();
 const [ticket, setTicket] = useState<any | null>(null);
 const [loading, setLoading] = useState(true);
 const [showScanner, setShowScanner] = useState(false);
 const [searchQuery, setSearchQuery] = useState('');
 const [activeModule, setActiveModule] = useState<any | null>(null);
 const [editingNotes, setEditingNotes] = useState('');
 const [isSubmitting, setIsSubmitting] = useState(false);
 const [scanMessage, setScanMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
 const [projectEntries, setProjectEntries] = useState<any[]>([]);
 const [shareCopied, setShareCopied] = useState(false);

 // Sync ticket in real-time
 useEffect(() => {
 if (!ticketId) return;
 const docRef = doc(db, 'customer_qc_tickets', ticketId);
 const unsub = onSnapshot(docRef, (docSnap) => {
 if (docSnap.exists()) {
 setTicket({ id: docSnap.id, ...docSnap.data() });
 } else {
 setTicket(null);
 }
 setLoading(false);
 }, (error) => {
 console.warn("Lỗi tải phiếu QC khách:", error);
 setLoading(false);
 });

 return unsub;
 }, [ticketId]);

 // Load projectEntries of this project to feed Scanner and perform updates
 useEffect(() => {
 if (!ticket?.projectCode) return;
 const q = collection(db, 'projectConfigs', ticket.projectCode, 'modules');
 getDocs(q).then((snapshot) => {
 setProjectEntries(snapshot.docs.map(d => ({ id: d.id, ...d.data() })));
 }).catch(err => {
 console.error("Lỗi đồng bộ chi tiết cấu kiện dự án:", err);
 });
 }, [ticket?.projectCode]);

 // If a module is selected, initialize notes
 useEffect(() => {
 if (activeModule) {
 setEditingNotes(activeModule.notes || '');
 } else {
 setEditingNotes('');
 }
 }, [activeModule]);

 if (loading) {
 return (
 <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center space-y-4" id="qc-customer-loading">
 <Loader2 className="animate-spin text-indigo-600" size={32} />
 <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Đang tải phiếu QC...</p>
 </div>
 );
 }

 if (!ticket) {
 return (
 <div className="min-h-screen bg-slate-100 flex flex-col items-center justify-center p-6 text-center space-y-6" id="qc-customer-not-found">
 <AlertCircle size={48} className="text-rose-500" />
 <div className="space-y-2">
 <h2 className="text-xl font-black text-slate-800 uppercase tracking-tight">Không Tìm Thấy Phiếu</h2>
 <p className="text-xs text-slate-500 max-w-sm mx-auto leading-relaxed uppercase font-fold">
 Phiếu QC khách hàng có thể đã bị xóa hoặc đường dẫn không hợp lệ. Vui lòng kiểm tra lại.
 </p>
 </div>
 <button
 onClick={onBack}
 className="border border-slate-200 bg-white hover:bg-slate-100 text-slate-705 text-slate-800 text-slate-700 font-black py-2 px-4 rounded-sm text-xs uppercase tracking-wider transition-colors active:scale-95 cursor-pointer"
 >
 Quay Lại Trang Chủ
 </button>
 </div>
 );
 }

 // Handle updates when client marks PASS or FAIL
 const handleSubmitQC = async (status: 'pass' | 'fail') => {
 if (!activeModule) return;

 try {
 setIsSubmitting(true);
 const email = user?.email || 'N/A';
 const displayName = user?.displayName || 'Khách hàng';
 const checkDate = new Date().toISOString();

 // 1. Cập nhật trong phiếu customer_qc_tickets
 const updatedModules = ticket.modules.map((m: any) => {
 if (m.id === activeModule.id) {
 return {
 ...m,
 status: status,
 notes: editingNotes.trim(),
 checkedBy: displayName,
 checkedByEmail: email,
 checkedAt: checkDate
 };
 }
 return m;
 });

 await updateDoc(doc(db, 'customer_qc_tickets', ticketId), {
 modules: updatedModules
 });

 // 2. Tìm ID tài liệu project tương ứng và cập nhật qcCustomer map
 const projectDocMatch = projectEntries.find(p => p.id === activeModule.id || p.moduleCode === activeModule.moduleCode);
 if (projectDocMatch) {
 await updateProjectModule(projectDocMatch.id, {
 qcCustomer: {
 status: status,
 date: checkDate,
 by: displayName,
 email: email,
 notes: editingNotes.trim()
 }
 }, projectDocMatch.projectCode);
 }

 // Success alerts & cleanup
 setScanMessage({
 type: 'success',
 text: `Đã lưu trạng thái: ${status === 'pass' ? 'ĐẠT (PASS)' : 'LỖI (FAIL)'} cho cấu kiện "${activeModule.moduleCode}"`
 });
 setTimeout(() => setScanMessage(null), 3000);
 setActiveModule(null);
 } catch (err) {
 console.error(err);
 alert('Không thể lưu kết quả kiểm định. Lỗi phân quyền hoặc kết nối.');
 } finally {
 setIsSubmitting(false);
 }
 };

 const handleScanSuccess = (scanned: ScannedResult) => {
 const matchedModule = ticket.modules.find((m: any) => 
 (m.moduleCode || '').toLowerCase() === (scanned.moduleCode || '').toLowerCase() ||
 m.id === scanned.matchedId
 );

 if (matchedModule) {
 setActiveModule(matchedModule);
 setScanMessage({
 type: 'success',
 text: `Quét mã QR khớp cấu kiện: ${matchedModule.moduleCode}!`
 });
 setTimeout(() => setScanMessage(null), 3000);
 } else {
 setScanMessage({
 type: 'error',
 text: `QR "${scanned.moduleCode}" không nằm trong danh sách kiểm của phiếu khách hàng này.`
 });
 setTimeout(() => setScanMessage(null), 5000);
 }
 };

 const copyShareLink = () => {
 const link = `${window.location.origin}/QC_check=${ticketId}`;
 navigator.clipboard.writeText(link).then(() => {
 setShareCopied(true);
 setTimeout(() => setShareCopied(false), 2000);
 }).catch(err => {
 console.error(err);
 });
 };

 const handleCardClick = (m: any) => {
 setActiveModule(m);
 };

 // Stats calculation
 const totalMod = ticket.modules?.length || 0;
 const passMod = ticket.modules?.filter((m: any) => m.status === 'pass').length || 0;
 const failMod = ticket.modules?.filter((m: any) => m.status === 'fail').length || 0;
 const pendingMod = ticket.modules?.filter((m: any) => m.status === 'pending' || !m.status).length || 0;

 return (
 <div className="min-h-screen bg-slate-100 flex flex-col w-full font-sans" id="qc-customer-screen">
 {/* Top Banner & Info */}
 <header className="bg-slate-900 text-white shrink-0 sticky top-0 z-[50]">
 <div className="max-w-4xl mx-auto px-4 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
 <div className="flex items-center gap-3">
 <button 
 onClick={onBack}
 className="p-2 hover:bg-white/10 rounded-lg border border-white/10 transition-colors"
 title="Quay lại"
 >
 <ArrowLeft size={18} />
 </button>
 <div>
 <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 rounded-sm font-black text-[9px] uppercase tracking-wider">
 Phiếu QC Khách Hàng
 </span>
 <h1 className="text-lg font-black uppercase tracking-tight mt-0.5">
 {ticket.name}
 </h1>
 </div>
 </div>

 <div className="flex items-center justify-start md:justify-end gap-3">
 <button
 onClick={copyShareLink}
 className={`bg-white/15 hover:bg-white/20 text-white font-black py-2 px-3 rounded-sm text-[10px] uppercase tracking-wider flex items-center gap-1.5 transition-all cursor-pointer ${
 shareCopied ? 'bg-emerald-600 border border-emerald-500 shadow-none' : 'border border-white/5'
 }`}
 >
 <Share2 size={12} />
 {shareCopied ? 'Đã copy!' : 'Sao chép link share'}
 </button>
 </div>
 </div>

 {/* Dashboard Analytics Bar */}
 <div className="bg-slate-900/80 border-t border-white/5 text-slate-400">
 <div className="max-w-4xl mx-auto px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center text-[10px] uppercase font-black tracking-wider">
 <div className="flex flex-col items-center justify-center p-1">
 <span className="text-xs text-slate-400">Dự án:</span>
 <span className="text-slate-203 text-sm text-white font-bold">{ticket.projectName} ({ticket.projectCode})</span>
 </div>
 <div className="flex flex-col items-center justify-center p-1 border-l border-white/5">
 <span className="text-xs text-indigo-400">Tổng SL:</span>
 <span className="text-indigo-400 text-sm font-bold">{totalMod}</span>
 </div>
 <div className="flex flex-col items-center justify-center p-1 border-l border-white/5">
 <span className="text-xs text-emerald-400">Đã Đạt:</span>
 <span className="text-emerald-400 text-sm font-bold">{passMod}</span>
 </div>
 <div className="flex flex-col items-center justify-center p-1 border-l border-white/5">
 <span className="text-xs text-amber-500">Chờ duyệt:</span>
 <span className="text-amber-500 text-sm font-bold">{pendingMod}</span>
 </div>
 </div>
 </div>
 </header>

 {/* Main Workspace Area */}
 <main className="flex-grow max-w-4xl w-full mx-auto p-4 space-y-6">
 
 {/* Alerts & Instructions */}
 {scanMessage && (
 <div className={`p-4 rounded-lg flex items-center gap-3 border ${
 scanMessage.type === 'success' 
 ? 'bg-emerald-100 text-emerald-800 border-emerald-200' 
 : 'bg-rose-100 text-rose-800 border-rose-300 border-rose-200'
 }`}>
 <Info size={18} className="shrink-0" />
 <span className="text-xs font-black uppercase tracking-wider">{scanMessage.text}</span>
 </div>
 )}

 {/* Big QR Scanner Button */}
 <button
 onClick={() => setShowScanner(true)}
 className="w-full bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white py-4 px-6 rounded-lg text-sm font-black uppercase tracking-widest flex items-center justify-center gap-2.5 transition-all shadow-xl shadow-indigo-900/20 cursor-pointer"
 >
 <QrCode size={20} />
 Mở Máy Quét QR Kiểm Định Cấu Kiện
 </button>

 {/* Modules List Panel */}
 <div className="bg-white rounded-lg border border-slate-200 p-6 space-y-4">
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
 <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest">
 Danh Sách Module Cần QC Hàng Hoá ({totalMod})
 </h3>
 <div className="relative w-full max-w-xs">
 <Search className="absolute left-3 top-2.5 text-slate-400" size={14} />
 <input
 type="text"
 placeholder="Tìm mã cấu kiện..."
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 className="w-full pl-8 pr-4 py-2 border border-slate-200 rounded text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-bold"
 />
 </div>
 </div>

 <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
 {ticket.modules
 .filter((m: any) => matchSearchQuery(m.moduleCode, searchQuery) || matchSearchQuery(m.cluster || '', searchQuery))
 .map((m: any) => {
 let badgeStyle = 'bg-slate-100 text-slate-500 border-slate-200';
 let statusLabel = 'Chờ kiểm';

 if (m.status === 'pass') {
 badgeStyle = 'bg-emerald-100 text-emerald-800 border-emerald-200';
 statusLabel = 'Đạt (PASS)';
 } else if (m.status === 'fail') {
 badgeStyle = 'bg-rose-100 text-rose-800 border-rose-300 border-rose-200';
 statusLabel = 'Lỗi (FAIL)';
 }

 return (
 <button
 key={m.id}
 onClick={() => handleCardClick(m)}
 className="w-full border border-slate-200 rounded-lg p-4 bg-slate-100/50 hover:bg-white text-left transition-all hover:shadow-sm active:scale-[0.99] flex flex-col justify-between"
 >
 <div>
 <div className="flex items-center justify-between gap-3 mb-2">
 <span className="font-mono font-bold text-slate-800 uppercase tracking-wide truncate max-w-[200px]">
 {m.moduleCode}
 </span>
 <div className={`border px-2 py-0.5 rounded-sm font-black text-[8px] uppercase tracking-wider shrink-0 leading-none ${badgeStyle}`}>
 {statusLabel}
 </div>
 </div>

 <div className="text-[10px] text-slate-400 font-bold uppercase tracking-wider space-y-0.5">
 <p>Cụm: {m.cluster || 'N/A'}</p>
 <p>Số lượng: {m.quantity || 1}</p>
 </div>
 </div>

 {(m.notes || m.checkedBy) && (
 <div className="mt-3 pt-2.5 border-t border-dashed border-slate-200 text-[10px] space-y-1 text-slate-500">
 {m.checkedBy && (
 <p className="font-medium">
 🧑‍💻 Người duyệt: <span className="font-bold text-slate-600">{m.checkedBy}</span>
 </p>
 )}
 {m.notes && (
 <p className="italic text-slate-500 line-clamp-1 bg-white p-1 border border-slate-100 rounded-sm">
 📝 {m.notes}
 </p>
 )}
 </div>
 )}
 </button>
 );
 })}
 </div>
 </div>
 </main>

 {/* QC Action Dialog / Bottom Sheet Sheet */}
 {activeModule && (
 <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[200] flex items-center justify-center p-4">
 <motion.div
 initial={{ scale: 0.95, opacity: 0 }}
 animate={{ scale: 1, opacity: 1 }}
 className="bg-white w-full max-w-md rounded-lg border border-slate-200 shadow-2xl overflow-hidden flex flex-col"
 >
 {/* Header */}
 <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-slate-900 text-white">
 <div>
 <span className="text-[8px] font-black uppercase text-indigo-400 tracking-widest block leading-none">Kiểm định chất lượng</span>
 <h4 className="font-black text-sm uppercase tracking-tight mt-0.5 truncate max-w-[280px]">
 {activeModule.moduleCode}
 </h4>
 </div>
 <button 
 onClick={() => setActiveModule(null)}
 className="text-slate-400 hover:text-white p-2"
 >
 <X size={20} />
 </button>
 </div>

 {/* Info and Form fields */}
 <div className="p-6 space-y-5">
 <div className="bg-slate-100 border border-slate-200 p-4 rounded-lg flex items-center justify-between text-xs">
 <div>
 <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Cụm cấu kiện</p>
 <p className="font-black text-slate-800 uppercase mt-0.5">{activeModule.cluster || 'No Cluster'}</p>
 </div>
 <div>
 <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider">Số lượng</p>
 <p className="font-black text-slate-900 font-mono text-slate-800 text-right mt-0.5">{activeModule.quantity || 1} cái</p>
 </div>
 </div>

 {/* Notes Input */}
 <div className="space-y-1.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Ghi chú của Khách hàng</label>
 <textarea
 value={editingNotes}
 onChange={(e) => setEditingNotes(e.target.value)}
 placeholder="Nhập ghi chú chi tiết nếu có lỗi hỏng hoặc phản hồi..."
 rows={3}
 className="w-full text-xs p-3 border border-slate-200 rounded font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-500 outline-none"
 />
 </div>

 <div className="h-px bg-slate-100"></div>

 {/* Status Decision Buttons */}
 <div className="space-y-3">
 <div className="flex gap-3">
 <button
 onClick={() => handleSubmitQC('fail')}
 disabled={isSubmitting}
 className="flex-1 bg-rose-600 hover:bg-rose-700 text-white font-black py-4 px-4 rounded-sm transition-all focus:ring-2 focus:ring-rose-500 uppercase text-[10px] tracking-widest cursor-pointer active:scale-95 flex items-center justify-center gap-1.5"
 >
 <X size={14} className="stroke-[3px]" />
 KHÔNG ĐẠT (FAIL)
 </button>

 <button
 onClick={() => handleSubmitQC('pass')}
 disabled={isSubmitting}
 className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-black py-4 px-4 rounded-sm transition-all focus:ring-2 focus:ring-emerald-500 uppercase text-[10px] tracking-widest cursor-pointer active:scale-95 flex items-center justify-center gap-1.5"
 >
 <Check size={14} className="stroke-[3px]" />
 ĐẠT (PASS)
 </button>
 </div>

 <button
 type="button"
 onClick={() => setActiveModule(null)}
 className="w-full border border-slate-200 bg-white hover:bg-slate-100 text-slate-500 font-black py-2.5 px-3 rounded-sm text-[10px] uppercase tracking-widest transition-all cursor-pointer text-center"
 >
 Bỏ qua
 </button>
 </div>
 </div>
 </motion.div>
 </div>
 )}

 {/* Camera Live QR Scanner Modal popup */}
 {showScanner && (
 <ScannerModal
 projectEntries={projectEntries}
 onClose={() => setShowScanner(false)}
 onScan={handleScanSuccess}
 />
 )}
 </div>
 );
}
