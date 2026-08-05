/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { History, Menu, Loader2, Clock, X } from 'lucide-react';
import { query, collection, orderBy, onSnapshot, where, limit } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { ActivityLog, ActivityFilter, UserProfile } from '../types';
import { formatProjectCode, formatProjectName } from '../lib/formatters';

interface TimelineScreenProps {
 filter: ActivityFilter;
 allUsers: UserProfile[];
 onOpenFilter: () => void;
}

export function TimelineScreen({ filter, allUsers, onOpenFilter }: TimelineScreenProps) {
 const [logs, setLogs] = useState<ActivityLog[]>([]);
 const [loading, setLoading] = useState(true);

 const usersMap = React.useMemo(() => {
 const map: Record<string, UserProfile> = {};
 allUsers.forEach(u => {
 if (u.email) map[u.email.toLowerCase()] = u;
 if (u.uid) map[u.uid] = u;
 });
 return map;
 }, [allUsers]);

 useEffect(() => {
 const constraints: any[] = [orderBy('timestamp', 'desc')];
 
 if (filter.projectCode) {
 constraints.push(where('projectCode', '==', filter.projectCode));
 }
 if (filter.userEmail) {
 constraints.push(where('userEmail', '==', filter.userEmail));
 }
 
 // Giới hạn 150 hoạt động gần đây nhất để tối ưu đọc từ Firebase và quota
 constraints.push(limit(150));
 
 const q = query(collection(db, 'activities'), ...constraints);

 const unsubLogs = onSnapshot(q, (snapshot) => {
 let filteredLogs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ActivityLog));
 
 if (filter.startDate) {
 const start = new Date(filter.startDate);
 start.setHours(0, 0, 0, 0);
 filteredLogs = filteredLogs.filter(l => {
 const d = l.timestamp?.toDate ? l.timestamp.toDate() : new Date(l.timestamp);
 return d >= start;
 });
 }
 if (filter.endDate) {
 const end = new Date(filter.endDate);
 end.setHours(23, 59, 59, 999);
 filteredLogs = filteredLogs.filter(l => {
 const d = l.timestamp?.toDate ? l.timestamp.toDate() : new Date(l.timestamp);
 return d <= end;
 });
 }

 setLogs(filteredLogs.slice(0, 50));
 setLoading(false);
 }, (err) => {
 handleFirestoreError(err, OperationType.GET, 'activities');
 setLoading(false);
 });

 return () => {
 unsubLogs();
 };
 }, [filter]);

 const formatFullDate = (ts: any) => {
 if (!ts) return { time: '', date: '', month: '' };
 const date = ts.toDate ? ts.toDate() : new Date(ts);
 return {
 time: date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
 date: date.getDate().toString().padStart(2, '0'),
 month: `THG ${date.getMonth() + 1}`,
 year: date.getFullYear()
 };
 };

 const hasActiveFilter = filter.projectCode || filter.userEmail || filter.startDate || filter.endDate;

 return (
 <div 
 className="pb-24"
 >
 {/* Header with Title and Filter Button */}
 <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
 <div>
 <h2 className="text-xl font-bold text-gray-800 flex items-center">
 <History size={24} className="mr-2 text-[#007bff]" />
 Lịch sử hoạt động
 </h2>
 <p className="text-[10px] text-gray-500 uppercase font-black tracking-tight mt-1">
 Theo dõi {logs.length} hoạt động gần nhất
 </p>
 </div>
 <button 
 onClick={onOpenFilter}
 className={`flex items-center space-x-2 px-4 py-2 rounded text-xs font-bold uppercase transition-all shadow-sm ${
 hasActiveFilter 
 ? 'bg-[#007bff] text-white' 
 : 'bg-white text-gray-700 border hover:bg-gray-100'
 }`}
 >
 <Menu size={16} />
 <span>Lọc dữ liệu</span>
 {hasActiveFilter && <span className="ml-1 w-2 h-2 bg-white rounded-full"></span>}
 </button>
 </div>

 <div className="relative">
 <div className="absolute left-[19px] md:left-[39px] top-0 bottom-0 w-[2px] bg-gray-200"></div>

 <div className="space-y-8">
 {loading ? (
 <div className="flex justify-center p-12">
 <Loader2 size={32} className="animate-spin text-[#007bff]" />
 </div>
 ) : logs.length > 0 ? (
 logs.map((log, idx) => {
 const emailKey = (log.userEmail || '').toLowerCase();
 const userId = (log as any).userId;
 const userProfile = usersMap[emailKey] || (userId ? usersMap[userId] : null);
 const userRoles = Array.isArray(userProfile?.roles) ? userProfile.roles : userProfile?.role ? [userProfile.role] : [];
 const displayTitle = userProfile?.chuc_danh || (userRoles.includes('admin') ? 'Quản trị' : userRoles.includes('mod') ? 'Điều phối' : 'Thành viên');
 const displayName = userProfile?.ten_that || log.userName || log.userEmail;
 const dateInfo = formatFullDate(log.timestamp);
 
 const isDelete = log.action.includes('Xóa');
 const isUpdate = log.action.includes('Cập nhật') || log.action.includes('Sửa');
 const isExcel = log.action.includes('Excel');

 let iconBg = 'bg-[#007bff]';
 if (isDelete) iconBg = 'bg-[#dc3545]';
 else if (isExcel) iconBg = 'bg-[#28a745]';
 else if (isUpdate) iconBg = 'bg-[#17a2b8]';

 return (
 <div key={log.id} className="relative pl-12 md:pl-16">
 {/* Timeline point */}
 <div className={`absolute left-1 md:left-6 top-1 w-8 h-8 rounded-full border-4 border-white ${iconBg} shadow-sm z-10 flex items-center justify-center text-white`}>
 <Clock size={14} />
 </div>

 {/* Card content */}
 <div className="bg-white rounded shadow-sm border border-gray-200 overflow-hidden">
 <div className="px-4 py-2 bg-gray-100/50 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
 <span className="text-[10px] font-black text-gray-400 uppercase">
 {dateInfo.time} - {dateInfo.date}/{dateInfo.month.split(' ')[1]}/{dateInfo.year}
 </span>
 <div className="flex items-center space-x-2">
 <span className="text-[10px] font-bold text-gray-700">{displayName}</span>
 <span className="text-[9px] bg-white border border-gray-200 text-gray-500 px-2 py-0.5 rounded font-bold uppercase">
 {displayTitle}
 </span>
 </div>
 </div>
 <div className="p-4">
 <div className="flex items-start">
 <div className="flex-1">
 <h4 className={`text-xs font-black uppercase mb-1 ${
 isDelete ? 'text-[#dc3545]' : 
 isExcel ? 'text-[#28a745]' : 
 isUpdate ? 'text-[#17a2b8]' : 'text-[#007bff]'
 }`}>
 {log.action}
 </h4>
 <p className="text-sm text-gray-700 font-medium leading-relaxed">{log.details}</p>
 
 {(log.projectCode || log.moduleCode) && (
 <div className="mt-3 flex items-center gap-2 flex-wrap">
 {log.projectCode && (
 <span className="text-[9px] bg-blue-100 text-[#007bff] px-2 py-1 rounded font-bold uppercase border border-blue-100">
 Dự án: {formatProjectCode(log.projectCode)}
 </span>
 )}
 {log.moduleCode && (
 <span className="text-[9px] bg-purple-100 text-purple-700 px-2 py-1 rounded font-bold uppercase border border-purple-100">
 Module: {log.moduleCode}
 </span>
 )}
 </div>
 )}
 </div>
 </div>
 </div>
 </div>
 </div>
 );
 })
 ) : (
 <div className="bg-white rounded shadow-sm border border-gray-200 p-12 text-center text-gray-400">
 <Clock size={48} className="mx-auto mb-4 opacity-10" />
 <p className="text-sm font-bold uppercase tracking-widest">Không có dữ liệu</p>
 <p className="text-xs mt-1">Thay đổi bộ lọc để xem kết quả khác</p>
 </div>
 )}
 </div>
 </div>
 </div>
 );
}

export function TimelineFilterModal({ 
 filter, 
 setFilter, 
 onClose,
 projects,
 emails
}: { 
 filter: ActivityFilter, 
 setFilter: (f: ActivityFilter) => void, 
 onClose: () => void,
 projects: { code: string }[],
 emails: string[]
}) {
 const [localFilter, setLocalFilter] = useState(filter);

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4 backdrop-blur-sm">
 <motion.div 
 initial={{ opacity: 0, scale: 0.95 }} 
 animate={{ opacity: 1, scale: 1 }} 
 className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200"
 >
 <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
 <div className="flex items-center space-x-3">
 <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100">
 <History size={22} />
 </div>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Phân loại hoạt động</h3>
 </div>
 <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 transition-colors">
 <X size={20} />
 </button>
 </div>
 
 <div className="p-8 space-y-6">
 <div className="space-y-2.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none px-1">Mã Dự Án</label>
 <select 
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={localFilter.projectCode}
 onChange={e => setLocalFilter({...localFilter, projectCode: e.target.value})}
 >
 <option key="all-projects" value="">Tất cả dự án</option>
 {projects.map(p => (
 <option key={p.code} value={p.code}>{formatProjectCode(p.code)}</option>
 ))}
 </select>
 </div>
 
 <div className="space-y-2.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none px-1">Người thực hiện</label>
 <select 
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={localFilter.userEmail}
 onChange={e => setLocalFilter({...localFilter, userEmail: e.target.value})}
 >
 <option key="all-users" value="">Tất cả nhân viên</option>
 {emails.map(email => (
 <option key={email} value={email}>{email}</option>
 ))}
 </select>
 </div>

 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-2.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none px-1">Từ ngày</label>
 <input 
 type="date"
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-xs font-black text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={localFilter.startDate}
 onChange={e => setLocalFilter({...localFilter, startDate: e.target.value})}
 />
 </div>
 <div className="space-y-2.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none px-1">Đến ngày</label>
 <input 
 type="date"
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-xs font-black text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 value={localFilter.endDate}
 onChange={e => setLocalFilter({...localFilter, endDate: e.target.value})}
 />
 </div>
 </div>
 </div>

 <div className="flex bg-slate-100 border-t border-slate-100 p-5 space-x-3">
 <button 
 onClick={() => {
 setFilter({ projectCode: '', userEmail: '', startDate: '', endDate: '' });
 onClose();
 }}
 className="flex-1 py-3 px-4 text-slate-600 font-black text-[10px] uppercase border border-slate-200 bg-white hover:bg-slate-100 rounded-lg transition-all tracking-widest"
 >
 Xóa lọc
 </button>
 <button 
 onClick={() => {
 setFilter(localFilter);
 onClose();
 }}
 className="flex-[1.5] py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-black uppercase tracking-widest text-[11px] shadow-xl shadow-indigo-100 transition-all rounded-lg"
 >
 Áp dụng
 </button>
 </div>
 </motion.div>
 </div>
 );
}
