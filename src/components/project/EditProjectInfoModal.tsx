import React, { useState, useRef, useEffect } from 'react';
import { X, Save, Loader2, Upload, FileEdit, Link2, Layout, Boxes } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';
import { batchUpdateProjectModulesByConfig } from '../../lib/dualWrite';

interface EditProjectInfoModalProps {
 projectCode: string;
 projectEntries: ProjectEntry[];
 onClose: () => void;
 onSaved: () => void;
}

export function EditProjectInfoModal({ projectCode, projectEntries, onClose, onSaved }: EditProjectInfoModalProps) {
 const { user } = useAuth();
 const [loading, setLoading] = useState(false);
 const [uploading, setUploading] = useState(false);
 const fileInputRef = useRef<HTMLInputElement>(null);

 // Lấy giá trị hiện trạng của đại diện dự án
 const representativeEntry = (projectEntries[0] || {}) as any;

 const [projectName, setProjectName] = useState(representativeEntry.projectName || '');
 const [glbUrl, setGlbUrl] = useState(representativeEntry.glbUrl || '');
 const [assemblyDrawingUrl, setAssemblyDrawingUrl] = useState(representativeEntry.assemblyDrawingUrl || '');
 const [drawingUrl, setDrawingUrl] = useState(representativeEntry.drawingUrl || '');

 const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;

 const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
 const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

 if (!cloudName || !uploadPreset) {
 alert('Hệ thống chưa cấu hình Cloudinary (Cloud Name/Preset) trong file .env');
 return;
 }

 setUploading(true);
 try {
 const formData = new FormData();
 formData.append('file', file);
 formData.append('upload_preset', uploadPreset);
 formData.append('resource_type', 'auto');

 const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, {
 method: 'POST',
 body: formData,
 });

 if (!response.ok) {
 const errData = await response.json();
 throw new Error(errData.error?.message || 'Tải file thất bại');
 }

 const data = await response.json();
 setGlbUrl(data.secure_url);
 } catch (error: any) {
 console.error('Lỗi upload file 3D:', error);
 alert('Lỗi tải file lên: ' + error.message);
 } finally {
 setUploading(false);
 if (fileInputRef.current) fileInputRef.current.value = '';
 }
 };

 const handleSave = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!user || !projectCode) return;
 
 setLoading(true);
 try {
 const updateData = {
 projectName: projectName.trim(),
 glbUrl: glbUrl.trim(),
 assemblyDrawingUrl: assemblyDrawingUrl.trim(),
 drawingUrl: drawingUrl.trim()
 };

 await batchUpdateProjectModulesByConfig(projectCode, updateData);

 // Ghi nhận hoạt động hệ thống
 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: user.displayName || 'Anonymous',
 userEmail: user.email,
 action: 'Chỉnh sửa thông tin dự án',
 details: `Cập nhật thông tin dự án ${projectName} (${projectCode}) - Edit Info`,
 projectCode,
 timestamp: serverTimestamp()
 });

 onSaved();
 onClose();
 } catch (error: any) {
 console.error('Lỗi lưu thông tin dự án:', error);
 handleFirestoreError(error, OperationType.UPDATE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[220] p-4 backdrop-blur-sm animate-in fade-in duration-200">
 <div className="absolute inset-0" onClick={onClose} />
 
 <div className="bg-white w-full max-w-lg rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200 relative z-10">
 {/* Header */}
 <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
 <div className="flex items-center space-x-3">
 <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-105">
 <FileEdit size={20} />
 </div>
 <div>
 <h3 className="text-sm font-black text-slate-800 uppercase tracking-tight leading-none mb-1">Chỉnh sửa thông tin</h3>
 <p className="text-[9px] font-black uppercase text-slate-400 tracking-widest leading-none">Mã dự án: {projectCode}</p>
 </div>
 </div>
 <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 transition-colors cursor-pointer">
 <X size={20} />
 </button>
 </div>

 {/* Content form */}
 <form onSubmit={handleSave} className="p-6 md:p-8 space-y-5 overflow-y-auto max-h-[75vh] custom-scrollbar text-left">
 {/* Tên dự án */}
 <div className="space-y-1.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Tên Dự Án *</label>
 <input
 required
 type="text"
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-3.5 py-2.5 text-sm font-semibold text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Nhập tên dự án"
 value={projectName}
 onChange={e => setProjectName(e.target.value)}
 />
 </div>

 {/* Link mô hình 3D GLB */}
 <div className="space-y-1.5">
 <div className="flex items-center justify-between px-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center gap-1">
 <Boxes size={11} className="text-slate-400" />
 Đường Dẫn Mô Hình 3D (.glb)
 </label>
 <button
 type="button"
 onClick={() => fileInputRef.current?.click()}
 disabled={uploading}
 className="text-[9px] font-black text-emerald-600 hover:underline uppercase tracking-widest flex items-center gap-1.5 transition-all disabled:opacity-100 cursor-pointer"
 >
 {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
 TẢI FILE MỚI Up
 </button>
 <input
 type="file"
 ref={fileInputRef}
 className="hidden"
 accept=".glb"
 onChange={handleFileUpload}
 />
 </div>
 <input
 type="text"
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Dán link mô hình .glb hoặc bấm Tải file..."
 value={glbUrl}
 onChange={e => setGlbUrl(e.target.value)}
 />
 </div>

 {/* Bản vẽ chi tiết */}
 <div className="space-y-1.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center gap-1">
 <Link2 size={11} className="text-slate-400" />
 Link Bản vẽ chi tiết (PDF/Image)
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Dán link bản vẽ chi tiết..."
 value={drawingUrl}
 onChange={e => setDrawingUrl(e.target.value)}
 />
 </div>

 {/* Bản vẽ lắp ráp */}
 <div className="space-y-1.5">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none flex items-center gap-1">
 <Link2 size={11} className="text-slate-400" />
 Link Bản vẽ lắp ráp (Assembly PDF/Image)
 </label>
 <input
 type="text"
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-3.5 py-2.5 text-xs font-mono text-slate-900 focus:border-indigo-600 outline-none transition-all shadow-none"
 placeholder="Dán link bản vẽ lắp ráp..."
 value={assemblyDrawingUrl}
 onChange={e => setAssemblyDrawingUrl(e.target.value)}
 />
 </div>

 {/* Action Footer Button */}
 <div className="flex space-x-3 pt-5 border-t border-slate-100 mt-4">
 <button
 type="button"
 onClick={onClose}
 className="px-6 py-3 bg-slate-100 text-slate-600 rounded-lg text-[10.5px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all cursor-pointer"
 >
 Huỷ bỏ
 </button>
 <button
 disabled={loading}
 type="submit"
 className="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase tracking-widest text-[11px] shadow-lg shadow-indigo-100 transition-all disabled:opacity-100 flex items-center justify-center space-x-2 cursor-pointer"
 >
 {loading ? <Loader2 size={16} className="animate-spin" /> : (
 <>
 <Save size={16} />
 <span>Lưu thông tin dự án</span>
 </>
 )}
 </button>
 </div>
 </form>
 </div>
 </div>
 );
}
