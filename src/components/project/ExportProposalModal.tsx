/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, ClipboardCheck, AlertCircle, ShoppingBag, Terminal, Check } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { ProjectEntry } from '../../types';

interface ExportProposalItem {
 name: string;
 quantity: number;
}

interface ExportProposalModalProps {
 isOpen: boolean;
 onClose: () => void;
 projectCode: string;
 projectName: string;
 projectEntries: ProjectEntry[];
 role: string | null;
 roles: string[];
 userProfile: any;
 onSuccess: (msg: string) => void;
}

export function ExportProposalModal({
 isOpen,
 onClose,
 projectCode,
 projectName,
 projectEntries,
 role,
 roles,
 userProfile,
 onSuccess
}: ExportProposalModalProps) {
 const [quantities, setQuantities] = useState<Record<string, number>>({});
 const [isSubmitting, setIsSubmitting] = useState(false);
 const [errorText, setErrorText] = useState<string | null>(null);

 // 1. Tự động xác định Nhãn Xuất Phụ Trách mặc định dựa vào role và chuc_danh
 const defaultExportLabel = useMemo(() => {
 const chucDanh = userProfile?.chuc_danh?.toUpperCase() || '';
 if (chucDanh.includes('QUẢN LÝ X1') || chucDanh.includes('QUAN LY X1') || roles.includes('mod_x1')) {
 return 'Xưởng 1 xuất';
 }
 if (chucDanh.includes('LR1') || chucDanh.includes('LR 1')) {
 return 'LR Xưởng 1 xuất';
 }
 if (chucDanh.includes('LR2') || chucDanh.includes('LR 2')) {
 return 'LR Xưởng 2 xuất';
 }
 if (chucDanh.includes('ĐG') || chucDanh.includes('DG') || chucDanh.includes('ĐÓNG GÓI') || chucDanh.includes('DONG GOI')) {
 return 'ĐG Xưởng 2 xuất';
 }
 if (chucDanh.includes('SƠN') || chucDanh.includes('SON')) {
 return 'Sơn xưởng 2 xuất';
 }
 return '';
 }, [role, userProfile]);

 const [exportLabel, setExportLabel] = useState(defaultExportLabel);
 const [notes, setNotes] = useState('');

 // Sync states when modal opens or defaults change
 React.useEffect(() => {
 if (isOpen) {
 setExportLabel(defaultExportLabel);
 setNotes('');
 setQuantities({});
 setErrorText(null);
 }
 }, [isOpen, defaultExportLabel]);

 // 2. Tính toán tổng hợp danh sách phụ kiện của dự án hiện tại
 const accessoryStats = useMemo(() => {
 const stats: Record<string, { total: number; issued: number; remaining: number }> = {};
 
 // Chỉ lấy các module thuộc dự án được chọn
 const filtered = projectEntries.filter(p => p.projectCode === projectCode);
 
 filtered.forEach(entry => {
 entry.accessories?.forEach(acc => {
 const nameClean = acc.name.trim();
 if (!stats[nameClean]) {
 stats[nameClean] = { total: 0, issued: 0, remaining: 0 };
 }
 const qty = acc.quantity || 0;
 const issued = acc.issuedQuantity || 0;
 stats[nameClean].total += qty;
 stats[nameClean].issued += issued;
 });
 });

 // Tính toán lượng còn lại có thể xuất
 Object.keys(stats).forEach(name => {
 const item = stats[name];
 item.remaining = Math.max(0, item.total - item.issued);
 });

 return stats;
 }, [projectEntries, projectCode]);

 // Các phụ kiện có đăng ký
 const accessoryNames = useMemo(() => {
 return Object.keys(accessoryStats).sort();
 }, [accessoryStats]);

 const handleSetMax = (name: string, remaining: number) => {
 setQuantities(prev => ({
 ...prev,
 [name]: remaining
 }));
 };

 const handleQtyChange = (name: string, value: string, max: number) => {
 const parsed = parseInt(value, 10);
 if (isNaN(parsed) || parsed <= 0) {
 setQuantities(prev => {
 const updated = { ...prev };
 delete updated[name];
 return updated;
 });
 } else {
 const finalVal = Math.min(parsed, max);
 setQuantities(prev => ({
 ...prev,
 [name]: finalVal
 }));
 }
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 setErrorText(null);

 // Thu thập các phụ kiện thực tế được đăng ký xuất (> 0)
 const itemsToSubmit: ExportProposalItem[] = [];
 accessoryNames.forEach(name => {
 const qty = quantities[name] || 0;
 if (qty > 0) {
 itemsToSubmit.push({
 name,
 quantity: qty
 });
 }
 });

 if (itemsToSubmit.length === 0) {
 setErrorText('Vui lòng chọn ít nhất 1 loại phụ kiện và số lượng cần đề xuất xuất hàng');
 return;
 }

 if (!exportLabel.trim()) {
 setErrorText('Vui lòng xác định Nhãn Xuất Phụ Trách');
 return;
 }

 try {
 setIsSubmitting(true);

 // Tạo tài liệu mới trong collection `export_proposals`
 await addDoc(collection(db, 'export_proposals'), {
 projectCode,
 projectName: projectName || projectCode,
 items: itemsToSubmit,
 status: 'pending', // mặc định là chờ duyệt
 exportLabel: exportLabel.trim(),
 notes: notes.trim(),
 createdByUid: userProfile?.uid || '',
 createdByName: userProfile?.ten_that || userProfile?.displayName || 'Thành viên',
 createdByEmail: userProfile?.email || '',
 createdByTitle: userProfile?.chuc_danh || (roles.includes('admin') ? 'Quản trị' : 'Thẩm định viên'),
 createdAt: serverTimestamp()
 });

 onSuccess(`Đã gửi đề xuất xuất hàng phụ kiện cho dự án ${projectCode} thành công! Thao tác chờ Thủ kho hoặc Admin phê duyệt.`);
 onClose();
 } catch (err: any) {
 console.error('Lỗi khi gửi đề nghị xuất hàng:', err);
 setErrorText('Không thể lưu đề xuất xuất hàng. Vui lòng liên hệ quản trị hoặc thử lại.');
 } finally {
 setIsSubmitting(false);
 }
 };

 if (!isOpen) return null;

 return (
 <AnimatePresence>
 <div className="fixed inset-0 z-100 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs">
 <motion.div
 initial={{ opacity: 0, scale: 0.95, y: 10 }}
 animate={{ opacity: 1, scale: 1, y: 0 }}
 exit={{ opacity: 0, scale: 0.95, y: 10 }}
 className="w-full max-w-xl bg-white rounded-lg border border-slate-100 shadow-xl overflow-hidden flex flex-col max-h-[85vh]"
 >
 {/* Header */}
 <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-100/55">
 <div className="flex items-center gap-2.5">
 <ClipboardCheck size={20} className="text-indigo-600" />
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-wider">
 Đề nghị xuất hàng phụ kiện
 </h3>
 <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
 Dự án: {projectName} ({projectCode})
 </p>
 </div>
 </div>
 <button
 onClick={onClose}
 className="p-1.5 text-slate-500 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-full transition-all"
 >
 <X size={16} />
 </button>
 </div>

 <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
 {errorText && (
 <div className="p-3 bg-rose-100 border border-rose-200 text-rose-700 rounded-sm flex items-start gap-2.5 text-xs">
 <AlertCircle size={15} className="mt-0.5 shrink-0" />
 <span>{errorText}</span>
 </div>
 )}

 {/* Note alert */}
 <div className="p-3.5 bg-indigo-100/70 border border-indigo-100 rounded-sm text-[10.5px] leading-relaxed text-slate-600 space-y-1">
 <p className="font-extrabold uppercase text-indigo-700 shrink-0 flex items-center gap-1.5 tracking-wider">
 <ShoppingBag size={13} /> QUY CHẾ ĐỀ XUẤT PHỤ KIỆN
 </p>
 <p>
 Phòng kỹ thuật hoặc Công trường lựa chọn danh mục còn dư nợ định mức dưới đây. Nhập số cần nhận hoặc chọn <b>"Tối đa"</b> để nhận toàn bộ lượng còn dư. Sau khi lập, đề nghị sẽ được chuyển thẳng tới trang <b>"Kho Hàng"</b> ở tình thái Chờ Duyệt.
 </p>
 </div>

 {/* Danh sách phụ kiện */}
 <div className="space-y-2">
 <label className="text-[9.5px] font-black text-slate-400 uppercase tracking-widest block leading-none mb-1">
 Danh sách phụ kiện trong dự án & Lượng đề xuất
 </label>

 {accessoryNames.length === 0 ? (
 <div className="p-8 text-center rounded-sm border border-dashed border-slate-200 text-slate-500 italic text-xs uppercase tracking-widest font-bold">
 Không tìm thấy phụ kiện đăng ký trong dự án này
 </div>
 ) : (
 <div className="border border-slate-100 rounded-sm overflow-hidden divide-y divide-slate-100">
 {accessoryNames.map(name => {
 const stats = accessoryStats[name];
 const chosenQty = quantities[name] || '';
 const isFullyIssued = stats.remaining <= 0;

 return (
 <div
 key={name}
 className={`p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-colors ${
 isFullyIssued ? 'bg-slate-100/30 opacity-70' : 'hover:bg-slate-100/45'
 }`}
 >
 <div className="min-w-0 flex-1">
 <p className="text-[12px] font-black text-slate-800 uppercase tracking-normal leading-tight">
 {name}
 </p>
 <div className="flex items-center gap-2 mt-1 flex-wrap text-[10px] font-bold text-slate-500">
 <span>Yêu cầu: <strong className="text-slate-700">{stats.total}</strong></span>
 <span className="text-slate-400">•</span>
 <span>Đã xuất: <strong className="text-blue-600">{stats.issued}</strong></span>
 <span className="text-slate-400">•</span>
 <span>Còn lại: <strong className="text-amber-600">{stats.remaining}</strong></span>
 </div>
 </div>

 {/* Input & Max Button */}
 <div className="flex items-center gap-2 shrink-0">
 {isFullyIssued ? (
 <span className="text-[9px] font-black uppercase text-emerald-600 bg-emerald-100 px-2 py-1 rounded-sm border border-emerald-100 flex items-center gap-1">
 <Check size={11} /> Đã xuất đủ
 </span>
 ) : (
 <>
 <button
 type="button"
 onClick={() => handleSetMax(name, stats.remaining)}
 className="px-2 py-1 h-8 text-[9px] font-black text-indigo-700 hover:text-white bg-indigo-100 hover:bg-indigo-700 rounded-sm border border-indigo-200 transition-all uppercase tracking-wider cursor-pointer"
 >
 Tối đa
 </button>
 <input
 type="number"
 min="1"
 max={stats.remaining}
 value={chosenQty}
 onChange={e => handleQtyChange(name, e.target.value, stats.remaining)}
 placeholder="0"
 className="w-16 h-8 text-center text-[12px] font-black text-slate-900 bg-white border border-slate-300 rounded-sm focus:ring-1 focus:ring-indigo-500 outline-none"
 />
 </>
 )}
 </div>
 </div>
 );
 })}
 </div>
 )}
 </div>

 {/* Nhãn Xuất Phụ Trách */}
 <div className="space-y-1.5 pt-2">
 <label className="text-[9.5px] font-black text-slate-400 uppercase tracking-widest block leading-none">
 Nhãn Xuất Phụ Trách
 </label>
 <div className="relative">
 <select
 value={exportLabel}
 disabled
 className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-800 outline-none cursor-not-allowed opacity-80"
 >
 <option value="">-- Chưa xác định nhãn xuất hàng --</option>
 <option value="LR Xưởng 1 xuất">LR Xưởng 1 xuất</option>
 <option value="LR Xưởng 2 xuất">LR Xưởng 2 xuất</option>
 <option value="Xưởng 1 xuất">Xưởng 1 xuất</option>
 <option value="Đóng gói xuất">Đóng gói xuất</option>
 <option value="ĐG Xưởng 2 xuất">ĐG Xưởng 2 xuất</option>
 <option value="Sơn xưởng 2 xuất">Sơn xưởng 2 xuất</option>
 </select>
 </div>
 <p className="text-[9px] text-slate-500 font-bold leading-normal italic">
 * Hệ thống tự động thiết lập và khóa cố định dựa theo chức danh tài khoản của bạn để đảm bảo chính xác quy trình bàn giao phụ trách.
 </p>
 </div>

 {/* Ghi chú */}
 <div className="space-y-1.5 pt-1">
 <label className="text-[9.5px] font-black text-slate-400 uppercase tracking-widest block leading-none">
 Ghi chú đề xuất (Tùy chọn)
 </label>
 <textarea
 value={notes}
 onChange={e => setNotes(e.target.value)}
 placeholder="Nhập ghi chú chi tiết hoặc lý do xuất đặc trưng (nếu có)..."
 rows={2}
 className="w-full bg-white border border-slate-300 rounded-sm px-3 py-2 text-xs font-bold text-slate-800 outline-none focus:ring-1 focus:ring-indigo-500"
 />
 </div>
 </form>

 {/* Footer */}
 <div className="px-6 py-4 border-t border-slate-100 bg-slate-55/65 flex justify-end gap-3 shrink-0">
 <button
 onClick={onClose}
 type="button"
 disabled={isSubmitting}
 className="px-4 py-2 text-xs font-black text-slate-500 hover:text-slate-800 transition-all uppercase tracking-widest disabled:opacity-100 cursor-pointer"
 >
 Hủy bỏ
 </button>
 <button
 onClick={handleSubmit}
 type="submit"
 disabled={isSubmitting}
 className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-sm text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 shadow-sm transition-all cursor-pointer disabled:opacity-100"
 >
 {isSubmitting ? (
 <>
 <div className="h-3 w-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
 Đang xử lý...
 </>
 ) : (
 <>
 <ClipboardCheck size={14} />
 Gửi đề xuất xuất
 </>
 )}
 </button>
 </div>
 </motion.div>
 </div>
 </AnimatePresence>
 );
}
