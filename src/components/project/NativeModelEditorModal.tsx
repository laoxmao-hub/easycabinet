import React, { useState, useRef } from 'react';
import { Boxes, X, Upload, Loader2, Save } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';
import { batchUpdateProjectModules } from '../../lib/dualWrite';

interface NativeModelEditorModalProps {
 projectCode: string | null;
 projectEntries: ProjectEntry[];
 onClose: () => void;
}

export function NativeModelEditorModal({ projectCode, projectEntries, onClose }: NativeModelEditorModalProps) {
 const { user } = useAuth();
 const [url, setUrl] = useState(projectEntries[0]?.glbUrl || '');
 const [loading, setLoading] = useState(false);
 const [uploading, setUploading] = useState(false);
 const fileInputRef = useRef<HTMLInputElement>(null);

 const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;

 const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
 const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

 if (!cloudName || !uploadPreset) {
 alert('Chưa cấu hình Cloudinary (Cloud Name/Preset) trong .env');
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
 throw new Error(errData.error?.message || 'Upload failed');
 }

 const data = await response.json();
 setUrl(data.secure_url);
 } catch (error: any) {
 console.error('Upload error:', error);
 alert('Lỗi upload: ' + error.message);
 } finally {
 setUploading(false);
 if (fileInputRef.current) fileInputRef.current.value = '';
 }
 };

 const handleSave = async () => {
 if (!user || !projectCode) return;
 setLoading(true);
 try {
 let finalUrl = url.trim();
 
 await batchUpdateProjectModules(projectEntries.map(entry => ({
 moduleId: entry.id,
 data: { glbUrl: finalUrl },
 projectCode: entry.projectCode
 })));
 
 await addDoc(collection(db, 'activities'), {
 userId: user.uid,
 userName: user.displayName || 'Anonymous',
 userEmail: user.email,
 action: 'Cập nhật GLB URL',
 details: `Cập nhật link GLB trực tiếp cho dự án ${projectCode}`,
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
 <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-lg flex items-center justify-center border border-emerald-100">
 <Boxes size={22} />
 </div>
 <h3 className="text-base font-black text-slate-800 uppercase tracking-tight">Cài đặt 3D GLB</h3>
 </div>
 <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 transition-colors"><X size={20} /></button>
 </div>

 <div className="p-8 space-y-7">
 <div className="space-y-2.5">
 <div className="flex items-center justify-between px-1">
 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">File 3D (.glb)</label>
 <button 
 onClick={() => fileInputRef.current?.click()}
 disabled={uploading}
 className="text-[9px] font-black text-emerald-600 hover:underline uppercase tracking-widest flex items-center gap-1.5 transition-all disabled:opacity-100"
 >
 {uploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
 TẢI LÊN FILE MỚI
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
 className="w-full border border-slate-200 bg-slate-100 rounded-lg px-4 py-3 text-sm font-black text-slate-900 focus:border-emerald-600 outline-none transition-all font-mono shadow-none"
 placeholder="Dán link hoặc tải file lên..."
 value={url}
 onChange={e => setUrl(e.target.value)}
 />
 </div>
 <div className="p-4 bg-emerald-100 rounded-lg border border-emerald-100 space-y-1.5">
 <p className="text-[10px] text-emerald-700 font-black uppercase tracking-widest">HƯỚNG DẪN:</p>
 <p className="text-[10px] text-emerald-800 font-medium italic leading-relaxed">• Bạn có thể dán link trực tiếp từ Cloudinary/Firebase.</p>
 <p className="text-[10px] text-emerald-800 font-medium italic leading-relaxed">• Nhấn <span className="font-black text-emerald-600 uppercase text-[9px]">Tải lên file mới</span> để chọn tệp .glb.</p>
 </div>
 </div>

 <div className="flex bg-slate-100 border-t border-slate-100 p-4 space-x-3">
 <button onClick={onClose} className="px-6 py-2.5 bg-white text-slate-600 rounded-lg text-[10px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all">Huỷ</button>
 <button 
 disabled={loading}
 onClick={handleSave}
 className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-black uppercase tracking-widest text-[11px] shadow-xl shadow-emerald-100 transition-all disabled:opacity-100 flex items-center justify-center space-x-2"
 >
 {loading ? <Loader2 size={16} className="animate-spin" /> : (
 <>
 <Save size={16} />
 <span>Lưu GLB</span>
 </>
 )}
 </button>
 </div>
 </div>
 </div>
 );
}
