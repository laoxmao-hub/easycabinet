import React, { useState, useRef } from 'react';
import { FileSearch, X, Upload, Loader2, Save } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';
import { batchUpdateProjectModules } from '../../lib/dualWrite';

interface DrawingEditorModalProps {
 projectCode: string | null;
 projectEntries: ProjectEntry[];
 onClose: () => void;
}

export function DrawingEditorModal({ projectCode, projectEntries, onClose }: DrawingEditorModalProps) {
 const { user } = useAuth();
 const [url, setUrl] = useState(projectEntries[0]?.drawingUrl || '');
 const [assemblyUrl, setAssemblyUrl] = useState(projectEntries[0]?.assemblyDrawingUrl || '');
 const [loading, setLoading] = useState(false);
 const [uploading, setUploading] = useState(false);
 const [activeUploadField, setActiveUploadField] = useState<'module' | 'assembly' | null>(null);
 const fileInputRef = useRef<HTMLInputElement>(null);

 const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file || !activeUploadField) return;

 const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
 const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

 if (!cloudName || !uploadPreset) {
 alert('Chưa cấu hình Cloudinary trong .env');
 return;
 }

 setUploading(true);
 try {
 const formData = new FormData();
 formData.append('file', file);
 formData.append('upload_preset', uploadPreset);
 
 const resourceType = 'auto';
 formData.append('resource_type', resourceType);

 const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/upload`, {
 method: 'POST',
 body: formData,
 });

 if (!response.ok) {
 const errData = await response.json();
 throw new Error(errData.error?.message || 'Upload failed');
 }

 const data = await response.json();
 if (activeUploadField === 'module') setUrl(data.secure_url);
 else setAssemblyUrl(data.secure_url);
 } catch (error: any) {
 console.error('Upload error:', error);
 alert('Lỗi upload: ' + error.message);
 } finally {
 setUploading(false);
 setActiveUploadField(null);
 if (fileInputRef.current) fileInputRef.current.value = '';
 }
 };

 const handleSave = async () => {
 if (!user || !projectCode) return;
 setLoading(true);
 try {
 const processUrl = (rawUrl: string) => {
 let finalUrl = rawUrl.trim();
 if (finalUrl.includes('drive.google.com/file/d/')) {
 finalUrl = finalUrl.replace(/\/view(\?.*)?$/, '/preview');
 if (!finalUrl.endsWith('/preview') && finalUrl.includes('/d/')) {
 const parts = finalUrl.split('/');
 const dIndex = parts.indexOf('d');
 if (dIndex !== -1 && parts[dIndex + 1]) {
 const fileId = parts[dIndex + 1].split('?')[0];
 finalUrl = `https://drive.google.com/file/d/${fileId}/preview`;
 }
 }
 }
 return finalUrl;
 };

 const moduleUrl = processUrl(url);
 const assemblyUrlFinal = processUrl(assemblyUrl);
 
 await batchUpdateProjectModules(projectEntries.map(entry => ({
 moduleId: entry.id,
 data: { drawingUrl: moduleUrl, assemblyDrawingUrl: assemblyUrlFinal },
 projectCode: entry.projectCode
 })));
 
 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: user.displayName || 'Anonymous',
 userEmail: user.email,
 action: 'Cập nhật bản vẽ',
 details: `Cập nhật bản vẽ cho dự án ${projectCode}`,
 projectCode,
 timestamp: serverTimestamp()
 });
 
 onClose();
 } catch (e: any) {
 handleFirestoreError(e, OperationType.UPDATE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[210] p-4 backdrop-blur-sm">
 <div className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden flex flex-col border border-slate-200">
 <div className="p-5 border-b border-slate-100 bg-white flex items-center justify-between">
 <div className="flex items-center space-x-3">
 <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center border border-indigo-100">
 <FileSearch size={22} />
 </div>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Cài đặt bản vẽ</h3>
 </div>
 <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={20} /></button>
 </div>

 <div className="p-8 space-y-7">
 {/* Module Drawing */}
 <div className="space-y-2.5">
 <div className="flex items-center justify-between px-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Bản vẽ Module</label>
 <button 
 onClick={() => { setActiveUploadField('module'); setTimeout(() => fileInputRef.current?.click(), 0); }}
 disabled={uploading}
 className="text-[9px] font-black text-indigo-600 hover:underline uppercase tracking-widest flex items-center gap-1.5 transition-all disabled:opacity-100"
 >
 {uploading && activeUploadField === 'module' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
 TẢI LÊN
 </button>
 </div>
 <input 
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all font-mono shadow-none"
 placeholder="VD: https://... (Bản vẽ Module)"
 value={url}
 onChange={e => setUrl(e.target.value)}
 />
 </div>

 {/* Assembly Drawing */}
 <div className="space-y-2.5">
 <div className="flex items-center justify-between px-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Bản vẽ Lắp Ráp</label>
 <button 
 onClick={() => { setActiveUploadField('assembly'); setTimeout(() => fileInputRef.current?.click(), 0); }}
 disabled={uploading}
 className="text-[9px] font-black text-indigo-600 hover:underline uppercase tracking-widest flex items-center gap-1.5 transition-all disabled:opacity-100"
 >
 {uploading && activeUploadField === 'assembly' ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
 TẢI LÊN
 </button>
 </div>
 <input 
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-indigo-600 outline-none transition-all font-mono shadow-none"
 placeholder="VD: https://... (Bản vẽ Lắp Ráp)"
 value={assemblyUrl}
 onChange={e => setAssemblyUrl(e.target.value)}
 />
 </div>

 <input 
 type="file" 
 ref={fileInputRef} 
 className="hidden" 
 accept=".pdf,image/*" 
 onChange={handleFileUpload}
 />

 <div className="p-4 bg-indigo-100 rounded-lg border border-indigo-100 space-y-1.5">
 <p className="text-[10px] text-indigo-700 font-black uppercase tracking-widest">HƯỚNG DẪN:</p>
 <p className="text-[10px] text-indigo-800 font-medium italic leading-relaxed">• Link trực tiếp đến file PDF/Ảnh sẽ hiển thị tốt nhất.</p>
 <p className="text-[10px] text-indigo-800 font-medium italic leading-relaxed">• Nhấn <span className="font-black text-indigo-600 uppercase text-[9px]">Tải lên</span> để chọn file mới từ máy tính.</p>
 </div>
 </div>

 <div className="flex bg-slate-100 border-t border-slate-100 p-4 space-x-3">
 <button onClick={onClose} className="px-6 py-2.5 bg-white text-slate-600 rounded-lg text-[10px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all">Huỷ</button>
 <button 
 disabled={loading}
 onClick={handleSave}
 className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase tracking-widest text-[11px] shadow-xl shadow-indigo-100 transition-all disabled:opacity-100 flex items-center justify-center space-x-2"
 >
 {loading ? <Loader2 size={16} className="animate-spin" /> : (
 <>
 <Save size={16} />
 <span>Lưu thay đổi</span>
 </>
 )}
 </button>
 </div>
 </div>
 </div>
 );
}
