import React, { useState } from 'react';
import { motion } from 'motion/react';

interface DeleteConfirmationModalProps {
 projectCode: string;
 onConfirm: () => void;
 onClose: () => void;
}

export function DeleteConfirmationModal({ projectCode, onConfirm, onClose }: DeleteConfirmationModalProps) {
 const [confirmCode, setConfirmCode] = useState('');
 return (
 <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[110] p-4 backdrop-blur-sm">
 <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="bg-white w-full max-w-sm rounded-lg shadow-2xl overflow-hidden border border-slate-200">
 <div className="p-4 border-b border-slate-100">
 <h3 className="text-base font-black text-rose-600 uppercase tracking-tight">Cảnh báo quan trọng</h3>
 </div>
 <div className="p-6">
 <div className="bg-rose-100 p-4 rounded-lg border border-rose-100 mb-6">
 <p className="text-[13px] font-black text-rose-700 leading-relaxed uppercase tracking-tight">Hành động này sẽ xóa vĩnh viễn dự án <span className="underline decoration-2 underline-offset-4">{projectCode}</span>.</p>
 </div>
 <div className="space-y-3">
 <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest leading-none">Xác nhận mã dự án để xóa:</p>
 <input className="w-full border border-slate-200 rounded-lg px-4 py-3 text-sm font-black focus:border-rose-600 outline-none font-mono bg-slate-100 text-slate-900 transition-all uppercase placeholder:italic" placeholder={`Nhập "${projectCode}"...`} value={confirmCode} onChange={e => setConfirmCode(e.target.value)} />
 </div>
 </div>
 <div className="flex bg-slate-100 border-t border-slate-100 p-4 space-x-3">
 <button onClick={onClose} className="px-6 py-2.5 bg-white text-slate-600 rounded-lg text-[11px] font-black uppercase tracking-widest border border-slate-200 hover:bg-slate-100 transition-all shadow-none">Huỷ</button>
 <button disabled={confirmCode !== projectCode} onClick={onConfirm} className="flex-1 py-2.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-[11px] font-black uppercase tracking-widest transition-all disabled:opacity-30 flex items-center justify-center shadow-xl shadow-rose-100">
 XÓA VĨNH VIỄN
 </button>
 </div>
 </motion.div>
 </div>
 );
}
