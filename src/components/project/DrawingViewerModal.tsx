import React, { useState, useEffect, useRef } from 'react';
import { Eye, Pencil, Maximize, Minimize, X, FileSearch } from 'lucide-react';

interface DrawingViewerModalProps {
 url: string;
 onClose: () => void;
 onEdit: () => void;
 isAdmin: boolean;
}

export function DrawingViewerModal({ url, onClose, onEdit, isAdmin }: DrawingViewerModalProps) {
 const [isFullscreen, setIsFullscreen] = useState(false);
 const containerRef = useRef<HTMLDivElement>(null);
 
 // Clean URL for display
 const displayUrl = url.includes('drive.google.com/file/d/') 
 ? url.replace(/\/view(\?.*)?$/, '/preview') 
 : url;
 
 const isHttp = displayUrl.startsWith('http');
 
 const toggleFullscreen = () => {
 if (!containerRef.current) return;
 
 if (!document.fullscreenElement) {
 containerRef.current.requestFullscreen().catch(err => {
 console.error(`Error: ${err.message}`);
 });
 setIsFullscreen(true);
 } else {
 document.exitFullscreen();
 setIsFullscreen(false);
 }
 };

 useEffect(() => {
 const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
 document.addEventListener('fullscreenchange', handleFsChange);
 return () => document.removeEventListener('fullscreenchange', handleFsChange);
 }, []);

 return (
 <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[200] p-4 backdrop-blur-md">
 <div 
 ref={containerRef}
 className={`bg-white w-full max-w-5xl h-full max-h-[90vh] rounded-lg shadow-2xl overflow-hidden flex flex-col transition-all duration-300 border border-slate-200 ${isFullscreen ? 'max-w-none max-h-none rounded-none border-none' : ''}`}
 >
 <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-white text-slate-800 shrink-0">
 <div className="flex items-center space-x-4">
 <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100">
 <FileSearch size={22} />
 </div>
 <div>
 <h3 className="font-black text-sm uppercase tracking-tight leading-none text-slate-800">Bản vẽ lắp ráp</h3>
 <p className="text-[10px] text-slate-400 font-black uppercase mt-1.5 tracking-widest">{isAdmin ? 'CHẾ ĐỘ QUẢN TRỊ' : 'CHẾ ĐỘ XEM'}</p>
 </div>
 </div>
 <div className="flex items-center space-x-1 sm:space-x-2">
 <a 
 href={displayUrl} 
 target="_blank" 
 rel="noopener noreferrer"
 className="p-2.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-all"
 title="Mở trong tab mới"
 >
 <Eye size={20} />
 </a>

 {isAdmin && (
 <button 
 onClick={onEdit}
 className="hidden sm:flex items-center space-x-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-indigo-600 hover:bg-slate-100 rounded-lg transition-all"
 title="Sửa bản vẽ"
 >
 <Pencil size={16} />
 <span>Sửa đổi</span>
 </button>
 )}
 
 <button 
 onClick={toggleFullscreen}
 className="p-2.5 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all"
 title={isFullscreen ? "Thu nhỏ" : "Toàn màn hình"}
 >
 {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
 </button>

 <div className="w-px h-6 bg-slate-100 mx-2 hidden sm:block"></div>

 <button 
 onClick={onClose} 
 className="p-2.5 text-slate-400 hover:text-rose-500 hover:bg-rose-100 rounded-lg transition-all"
 title="Đóng"
 >
 <X size={24} />
 </button>
 </div>
 </div>
 <div className="flex-1 bg-slate-100 relative overflow-hidden">
 {isHttp ? (
 displayUrl.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp)$/) ? (
 <div className="w-full h-full flex items-center justify-center p-4">
 <img src={displayUrl} alt="Bản vẽ" className="max-w-full max-h-full object-contain shadow-lg" />
 </div>
 ) : (
 <div className="w-full h-full bg-white">
 <iframe 
 src={displayUrl} 
 className="w-full h-full border-none" 
 title="PDF Drawing Viewer"
 />
 </div>
 )
 ) : (
 <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 space-y-4 p-12 text-center">
 <div className="p-6 bg-gray-100 rounded-full">
 <FileSearch size={64} className="opacity-10" />
 </div>
 <div className="space-y-2">
 <p className="text-sm font-black uppercase text-gray-400">Không thể hiển thị</p>
 <p className="text-xs italic text-gray-500 max-w-sm mx-auto">Vui lòng cung cấp URL hợp lệ dành cho file PDF hoặc Hình ảnh để xem trực tiếp.</p>
 </div>
 <div className="px-6 py-3 bg-white rounded-xl border border-gray-200 text-[10px] font-mono break-all max-w-md shadow-sm">
 Giá trị: {displayUrl}
 </div>
 </div>
 )}
 </div>
 </div>
 </div>
 );
}
