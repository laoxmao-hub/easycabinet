import React, { useState, useMemo } from 'react';
import { X, Search, Info, Download, CheckCircle2, AlertCircle } from 'lucide-react';
import { ProjectEntry, matchSearchQuery } from '../../types';

interface ReceivedStatusModalProps {
 projectCode: string | null;
 projectName: string;
 projectEntries: ProjectEntry[];
 type: 'received' | 'unreceived';
 onClose: () => void;
}

const CLASSIFICATIONS = ['Thùng', 'Cánh', 'Đợt', 'Mặt HK', 'CTHT', 'Gia công ngoài'] as const;

export function ReceivedStatusModal({ projectCode, projectName, projectEntries, type, onClose }: ReceivedStatusModalProps) {
 const [searchTerm, setSearchTerm] = useState('');
 const [classFilter, setClassFilter] = useState('');
 const [clusterFilter, setClusterFilter] = useState('');

 // Lọc danh sách theo trạng thái "Đã nhận" hay "Chưa nhận"
 const statusFilteredEntries = useMemo(() => {
 return projectEntries.filter(entry => {
 const quantity = entry.quantity || 0;
 const receivedQuantity = entry.receivedQuantity || 0;
 if (type === 'received') {
 return receivedQuantity > 0;
 } else {
 const codeLower = (entry.moduleCode || "").toLowerCase();
 if (codeLower.includes("len") || codeLower.includes("fil")) {
 return false;
 }
 return receivedQuantity < quantity;
 }
 });
 }, [projectEntries, type]);

 // Lấy các cụm duy nhất có trong danh sách đã lọc
 const availableClusters = useMemo(() => {
 const set = new Set<string>();
 statusFilteredEntries.forEach(entry => {
 if (entry.cluster && entry.cluster.trim()) {
 set.add(entry.cluster.trim());
 }
 });
 return Array.from(set).sort();
 }, [statusFilteredEntries]);

 // Áp dụng tìm kiếm và bộ lọc phân loại, cụm
 const filteredRows = useMemo(() => {
 const term = searchTerm.toLowerCase().trim();
 return statusFilteredEntries.filter(item => {
 if (term) {
 const matchesTerm = (
 matchSearchQuery(item.moduleCode || '', searchTerm) ||
 matchSearchQuery(item.cluster || '', searchTerm) ||
 matchSearchQuery(item.material || '', searchTerm)
 );
 if (!matchesTerm) return false;
 }

 if (classFilter) {
 if (item.classification !== classFilter) return false;
 }

 if (clusterFilter) {
 if ((item.cluster || '').trim() !== clusterFilter.trim()) return false;
 }

 return true;
 });
 }, [statusFilteredEntries, searchTerm, classFilter, clusterFilter]);

 // Tính tổng số lượng tổng hợp để hiển thị stats
 const stats = useMemo(() => {
 const totalModules = statusFilteredEntries.length;
 const totalQty = statusFilteredEntries.reduce((sum, item) => sum + (item.quantity || 0), 0);
 const totalReceived = statusFilteredEntries.reduce((sum, item) => sum + (item.receivedQuantity || 0), 0);
 const totalUnreceived = statusFilteredEntries.reduce((sum, item) => sum + Math.max(0, (item.quantity || 0) - (item.receivedQuantity || 0)), 0);

 return {
 totalModules,
 totalQty,
 totalReceived,
 totalUnreceived
 };
 }, [statusFilteredEntries]);

 // Hàm xuất file CSV tiếng Việt chuẩn Excel
 const handleExportCSV = () => {
 const headers = [
 'STT',
 'Mã Cấu Kiện',
 'Phân Loại',
 'Cụm',
 'Số Lượng Tổng',
 'Đã Nhận',
 'Chưa Nhận',
 'Dài (mm)',
 'Rộng (mm)',
 'Cao (mm)',
 'Vật Liệu',
 'Bản Vẽ',
 'Trạng Thái'
 ];

 const csvRows = filteredRows.map((entry, idx) => {
 const unreceived = Math.max(0, (entry.quantity || 0) - (entry.receivedQuantity || 0));
 return [
 idx + 1,
 entry.moduleCode || '',
 entry.classification || '',
 entry.cluster || '',
 entry.quantity || 0,
 entry.receivedQuantity || 0,
 unreceived,
 entry.width || 0,
 entry.depth || 0,
 entry.height || 0,
 entry.material || '',
 entry.drawingUrl ? 'Có' : 'Không',
 entry.status || ''
 ];
 });

 const csvContent = [
 headers.join(','),
 ...csvRows.map(row => row.map(val => {
 const str = String(val).replace(/"/g, '""');
 return `"${str}"`;
 }).join(','))
 ].join('\n');

 const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvContent], { type: 'text/csv;charset=utf-8;' });
 const url = URL.createObjectURL(blob);
 const link = document.createElement('a');
 link.setAttribute('href', url);
 link.setAttribute('download', `${type === 'received' ? 'Danh_sach_DA_NHAN' : 'Danh_sach_CHUA_NHAN'}_${projectCode}.csv`);
 document.body.appendChild(link);
 link.click();
 document.body.removeChild(link);
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
 <div className="bg-white w-[96vw] h-[92vh] rounded-lg border border-slate-200 flex flex-col overflow-hidden shadow-2xl">
 
 {/* Header toolbar */}
 <div className="px-6 py-4 border-b border-slate-100 bg-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
 <div className="flex flex-col text-left">
 <span className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 ${
 type === 'received' ? 'text-emerald-600' : 'text-rose-600'
 }`}>
 {type === 'received' ? (
 <>
 <CheckCircle2 size={12} />
 <span>Danh sách cấu kiện đã nhận</span>
 </>
 ) : (
 <>
 <AlertCircle size={12} />
 <span>Danh sách cấu kiện chưa nhận</span>
 </>
 )}
 </span>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight flex items-center gap-2 mt-0.5">
 <span>BẢNG THỐNG KÊ CHI TIẾT:</span>
 <span className="text-indigo-600 font-mono">{projectCode}</span>
 <span className="text-slate-400 font-normal text-sm">— {projectName}</span>
 </h3>
 </div>

 <div className="flex flex-wrap items-center gap-3">
 {/* Export CSV Button */}
 <button
 onClick={handleExportCSV}
 className="px-4 py-2 bg-slate-100 hover:bg-slate-100 text-slate-700 rounded-sm text-[11px] font-black uppercase tracking-widest border border-slate-200 transition-all cursor-pointer flex items-center gap-1.5"
 >
 <Download size={13} />
 <span>Xuất Excel (.csv)</span>
 </button>

 {/* Close Button */}
 <button
 onClick={onClose}
 className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-sm text-[11px] font-black uppercase tracking-widest transition-all cursor-pointer"
 >
 Đóng
 </button>
 </div>
 </div>

 {/* Stats & Info bar */}
 <div className="px-6 py-3 bg-slate-100 border-b border-slate-100 flex flex-col md:flex-row md:items-center justify-between text-[11px] text-slate-500 font-medium font-sans gap-3">
 <div className="flex items-center gap-1.5 overflow-hidden text-left">
 <Info size={14} className="text-indigo-500 shrink-0" />
 <span className="truncate">Giao diện dạng bảng Excel dễ theo dõi, tìm kiếm và truy xuất. Sử dụng các cột lọc ở dưới dòng tiêu đề để thu hẹp kết quả.</span>
 </div>
 <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 font-bold">
 <span className="text-slate-700">Tổng số dòng: <strong className="text-indigo-600">{filteredRows.length}/{stats.totalModules}</strong> mã</span>
 {type === 'received' ? (
 <span className="text-emerald-600">Đã nhận tổng cộng: {stats.totalReceived} cái</span>
 ) : (
 <span className="text-rose-600">Chưa nhận tổng cộng: {stats.totalUnreceived} cái</span>
 )}
 <span className="text-slate-400">Total Qty: {stats.totalQty} cái</span>
 </div>
 </div>

 {/* Spreadsheets Body */}
 <div className="flex-1 min-h-0 bg-slate-100 p-4 flex flex-col">
 <div className="flex-1 min-h-0 w-full bg-white border border-slate-200 rounded-lg shadow-sm flex flex-col overflow-hidden">
 <div className="flex-1 overflow-auto">
 <table className="w-full border-collapse table-fixed min-w-[1500px]">
 <thead>
 {/* Hàng bộ lọc trực quan */}
 <tr className="bg-slate-100 border-b border-slate-200">
 <td className="sticky top-0 left-0 z-40 w-12 text-center border-r border-slate-200 py-1.5 bg-slate-100">
 <span className="text-[9px] font-black tracking-widest text-slate-400 uppercase">LỌC</span>
 </td>
 <td className="sticky top-0 left-12 z-40 w-[240px] p-1 border-r border-slate-200 bg-slate-100 shadow-[2px_0_5px_rgba(0,0,0,0.05)]">
 <div className="relative w-full">
 <span className="absolute inset-y-0 left-0 flex items-center pl-2.5 text-slate-400 pointer-events-none">
 <Search size={11} />
 </span>
 <input
 type="text"
 className="w-full pl-6 pr-2 py-0.5 text-[11px] bg-white border border-slate-200 rounded-sm outline-none focus:border-indigo-500 font-medium h-7 text-left"
 placeholder="Tìm mã / vật liệu..."
 value={searchTerm}
 onChange={e => setSearchTerm(e.target.value)}
 />
 </div>
 </td>
 <td className="sticky top-0 z-30 w-32 p-1 border-r border-slate-200 bg-slate-100">
 <select
 value={classFilter}
 onChange={e => setClassFilter(e.target.value)}
 className="w-full px-1.5 py-0.5 text-[11px] bg-white border border-slate-200 rounded-sm outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7 text-left"
 >
 <option value="">TẤT CẢ PHÂN LOẠI</option>
 {CLASSIFICATIONS.map(opt => (
 <option key={opt} value={opt}>{opt.toUpperCase()}</option>
 ))}
 </select>
 </td>
 <td className="sticky top-0 z-30 w-44 p-1 border-r border-slate-200 bg-slate-100">
 <select
 value={clusterFilter}
 onChange={e => setClusterFilter(e.target.value)}
 className="w-full px-1.5 py-0.5 text-[11px] bg-white border border-slate-200 rounded-sm outline-none focus:border-indigo-500 font-black uppercase tracking-tight cursor-pointer h-7 text-left"
 >
 <option value="">TẤT CẢ CỤM</option>
 {availableClusters.map(opt => (
 <option key={opt} value={opt}>{opt.toUpperCase()}</option>
 ))}
 </select>
 </td>
 <td colSpan={9} className="sticky top-0 z-30 bg-slate-100 border-b border-slate-200"></td>
 </tr>

 <tr className="bg-slate-100 text-slate-500 text-[10px] font-black uppercase tracking-wider border-b border-slate-200 font-sans">
 <th className="sticky top-[38px] left-0 z-40 w-12 text-center border-r border-slate-300 py-2 select-none bg-slate-100">STT</th>
 <th className="sticky top-[38px] left-12 z-40 w-[240px] text-left pl-3 border-r border-slate-300 bg-slate-100 shadow-[2px_0_5px_rgba(0,0,0,0.05)]">Mã Module</th>
 <th className="sticky top-[38px] z-30 w-32 text-left pl-3 border-r border-slate-300 bg-slate-100">Phân Loại</th>
 <th className="sticky top-[38px] z-30 w-44 text-left pl-3 border-r border-slate-300 bg-slate-100">Cụm</th>
 <th className="sticky top-[38px] z-30 w-20 text-center border-r border-slate-300 bg-slate-100">Tổng SL</th>
 <th className="sticky top-[38px] z-30 w-24 text-center border-r border-slate-300 bg-slate-100">Đã Nhận</th>
 <th className="sticky top-[38px] z-30 w-24 text-center border-r border-slate-300 bg-slate-100">Chưa Nhận</th>
 <th className="sticky top-[38px] z-30 w-16 text-right pr-2 border-r border-slate-300 bg-slate-100">Dài</th>
 <th className="sticky top-[38px] z-30 w-16 text-right pr-2 border-r border-slate-300 bg-slate-100">Rộng</th>
 <th className="sticky top-[38px] z-30 w-16 text-right pr-2 border-r border-slate-300 bg-slate-100">Cao</th>
 <th className="sticky top-[38px] z-30 w-48 text-left pl-3 border-r border-slate-300 bg-slate-100">Vật Liệu</th>
 <th className="sticky top-[38px] z-30 w-24 text-center border-r border-slate-300 bg-slate-100">Tiến Độ</th>
 <th className="sticky top-[38px] z-30 bg-slate-100 text-left pl-3">Trạng Thái Gần Nhất</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-200 text-xs font-medium">
 {filteredRows.map((entry, idx) => {
 const total = entry.quantity || 0;
 const rec = entry.receivedQuantity || 0;
 const unrec = Math.max(0, total - rec);
 const progress = total > 0 ? (rec / total) * 100 : 0;

 return (
 <tr 
 key={entry.id} 
 className="group/tr hover:bg-slate-100/85 transition-colors bg-white"
 >
 {/* STT */}
 <td className="sticky left-0 z-20 w-12 text-center py-2 border-r border-slate-200 font-mono text-[10px] select-none text-slate-400 bg-white group-hover/tr:bg-slate-100/85">
 {idx + 1}
 </td>

 {/* Mã Module */}
 <td className="sticky left-12 z-20 w-[240px] border-r border-slate-200 px-3 py-2 shadow-[2px_0_5px_rgba(0,0,0,0.05)] bg-white group-hover/tr:bg-slate-100/85 text-left truncate font-black font-mono text-slate-800 uppercase tracking-tight">
 {entry.moduleCode}
 </td>

 {/* Phân loại */}
 <td className="border-r border-slate-200 px-3 py-2 text-left truncate uppercase font-bold text-slate-500">
 {entry.classification || 'THÙNG'}
 </td>

 {/* Cụm */}
 <td className="border-r border-slate-200 px-3 py-2 text-left truncate text-slate-700 font-semibold">
 {entry.cluster || <span className="text-slate-400 italic">Chưa có</span>}
 </td>

 {/* Số lượng */}
 <td className="border-r border-slate-200 px-3 py-2 text-center font-bold text-slate-800">
 {total}
 </td>

 {/* Đã nhận */}
 <td className={`border-r border-slate-200 px-3 py-2 text-center font-black ${
 rec > 0 ? 'text-emerald-600 bg-emerald-100/20' : 'text-slate-400'
 }`}>
 {rec}
 </td>

 {/* Chưa nhận */}
 <td className={`border-r border-slate-200 px-3 py-2 text-center font-black ${
 unrec > 0 ? 'text-rose-600 bg-rose-100/20' : 'text-slate-400'
 }`}>
 {unrec}
 </td>

 {/* Dài */}
 <td className="border-r border-slate-200 px-2 py-2 text-right font-mono text-slate-500">
 {entry.width || 0}
 </td>

 {/* Rộng */}
 <td className="border-r border-slate-200 px-2 py-2 text-right font-mono text-slate-500">
 {entry.depth || 0}
 </td>

 {/* Cao */}
 <td className="border-r border-slate-200 px-2 py-2 text-right font-mono text-slate-500">
 {entry.height || 0}
 </td>

 {/* Vật liệu */}
 <td className="border-r border-slate-200 px-3 py-2 text-left truncate text-slate-600 max-w-[190px]">
 {entry.material || <span className="text-slate-300 italic">—</span>}
 </td>

 {/* Tiến độ */}
 <td className="border-r border-slate-200 px-2.5 py-2 text-center">
 <div className="flex items-center gap-1.5">
 <span className="font-mono text-[10px] font-extrabold w-8 text-right shrink-0">
 {Math.round(progress)}%
 </span>
 <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
 <div 
 className={`h-full rounded-full transition-all duration-300 ${
 progress >= 100 
 ? 'bg-emerald-500' 
 : progress > 0 
 ? 'bg-indigo-500' 
 : 'bg-slate-300'
 }`}
 style={{ width: `${progress}%` }}
 />
 </div>
 </div>
 </td>

 {/* Trạng thái */}
 <td className="px-3 py-2 text-left truncate text-[11px] text-slate-500 italic max-w-[200px]">
 {entry.status || <span className="text-slate-300">—</span>}
 </td>
 </tr>
 );
 })}

 {filteredRows.length === 0 && (
 <tr>
 <td colSpan={13} className="py-12 bg-white border-none">
 <div className="text-center text-slate-400 space-y-1">
 <p className="text-sm font-black uppercase tracking-wider">Không tìm thấy kết quả phù hợp</p>
 <p className="text-xs text-slate-400 font-medium">Thay đổi từ khóa tìm kiếm hoặc các tiêu chí lọc để hiển thị nhiều cấu kiện hơn.</p>
 </div>
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </div>

 </div>
 </div>
 );
}
