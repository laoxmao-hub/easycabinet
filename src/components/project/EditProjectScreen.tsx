import React, { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';
import { useAuth } from '../../lib/AuthContext';
import { ProjectEntry } from '../../types';
import { batchUpdateProjectModules } from '../../lib/dualWrite';

interface EditProjectScreenProps {
 onComplete: () => void;
 initialProjectCode: string | null;
 projectEntries: ProjectEntry[];
}

export function EditProjectScreen({ onComplete, initialProjectCode, projectEntries }: EditProjectScreenProps) {
 const { user } = useAuth();
 const [loading, setLoading] = useState(false);
 const [selectedCode, setSelectedCode] = useState(initialProjectCode || '');
 const [projectName, setProjectName] = useState('');
 
 const projects = Array.from(new Set(projectEntries.map(p => p.projectCode))).map(code => {
 const entry = projectEntries.find(p => p.projectCode === code);
 return { code, name: entry?.projectName || 'Không tên' };
 }).reverse();

 const [entries, setEntries] = useState<ProjectEntry[]>([]);

 useEffect(() => {
 if (selectedCode) {
 const p = projects.find(p => p.code === selectedCode);
 if (p) setProjectName(p.name);
 const pEntries = projectEntries.filter(p => p.projectCode === selectedCode);
 setEntries(JSON.parse(JSON.stringify(pEntries)));
 } else {
 setProjectName('');
 setEntries([]);
 }
 }, [selectedCode]);

 const handleEntryChange = (id: string, field: keyof ProjectEntry, value: any) => {
 setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: value } : e));
 };

 const handleSubmit = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!user || !selectedCode) return;
 setLoading(true);
 try {
 await batchUpdateProjectModules(entries.map(entry => ({
 moduleId: entry.id,
 data: {
 projectName,
 cluster: entry.cluster,
 moduleCode: entry.moduleCode,
 quantity: Number(entry.quantity) || 0
 },
 projectCode: entry.projectCode
 })));
 await addDoc(collection(db, 'activities'), {
 userId: user.uid, userName: user.displayName || 'Anonymous', userEmail: user.email,
 action: 'Chỉnh sửa dự án', details: `Cập nhật dự án: ${projectName} (${selectedCode})`,
 projectCode: selectedCode, timestamp: serverTimestamp()
 });
 onComplete();
 } catch (error: any) {
 handleFirestoreError(error, OperationType.WRITE, 'projects');
 } finally {
 setLoading(false);
 }
 };

 return (
 <div className="space-y-4 pb-24">
 <div className="flex items-center justify-between mb-4 border-b border-gray-200 pb-2">
 <h2 className="text-xl font-medium text-gray-800">Cập Nhật Dự Án</h2>
 </div>
 <div className="bg-white rounded shadow-sm border-t-4 border-primary p-6 space-y-6">
 <div className="space-y-4">
 <div className="space-y-1">
 <label className="text-xs font-bold text-gray-700 uppercase">Chọn Dự Án Đang Có</label>
 <select 
 className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-primary outline-none" 
 value={selectedCode} 
 onChange={e => setSelectedCode(e.target.value)} 
 disabled={!!initialProjectCode}
 >
 <option value="">-- Chọn một dự án --</option>
 {projects.map(p => <option key={p.code} value={p.code}>{p.name} ({p.code})</option>)}
 </select>
 {initialProjectCode && <p className="text-[10px] text-primary font-bold mt-1 uppercase">Đang chỉnh sửa dự án đã chọn</p>}
 </div>
 {selectedCode && (
 <form onSubmit={handleSubmit} className="space-y-6 anim-fade-in">
 <div className="space-y-1">
 <label className="text-xs font-bold text-gray-700 uppercase">Tên Dự Án</label>
 <input required className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary" placeholder="Tên dự án" value={projectName} onChange={e => setProjectName(e.target.value)} />
 </div>
 <div className="space-y-3">
 <h3 className="text-xs font-bold text-gray-500 uppercase tracking-widest border-b border-gray-100 pb-2">Danh sách Module</h3>
 <div className="space-y-3">
 {entries.map((entry, idx) => (
 <div key={entry.id} className="p-3 bg-gray-100 rounded border border-gray-200 space-y-3">
 <div className="flex items-center justify-between"><span className="text-[10px] font-bold text-gray-400 uppercase">Module #{idx + 1}</span></div>
 <div className="grid grid-cols-2 gap-3">
 <div className="space-y-1"><label className="text-[10px] font-bold text-gray-500 uppercase">Cụm</label><input className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:border-primary outline-none" value={entry.cluster} onChange={e => handleEntryChange(entry.id, 'cluster', e.target.value)} /></div>
 <div className="space-y-1"><label className="text-[10px] font-bold text-gray-500 uppercase">Mã hàng</label><input className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:border-primary outline-none" value={entry.moduleCode} onChange={e => handleEntryChange(entry.id, 'moduleCode', e.target.value)} /></div>
 </div>
 <div className="space-y-1"><label className="text-[10px] font-bold text-gray-500 uppercase">Số lượng</label><input type="number" className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs focus:border-primary outline-none" value={entry.quantity} onChange={e => handleEntryChange(entry.id, 'quantity', e.target.value)} /></div>
 </div>
 ))}
 </div>
 </div>
 <button disabled={loading} type="submit" className="w-full btn-primary font-bold py-3 rounded shadow-sm flex items-center justify-center space-x-2 disabled:opacity-100">
 {loading ? <Loader2 size={18} className="animate-spin" /> : <span>LƯU TẤT CẢ THAY ĐỔI</span>}
 </button>
 </form>
 )}
 </div>
 </div>
 </div>
 );
}
