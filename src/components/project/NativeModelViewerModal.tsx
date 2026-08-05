import React, { useState, useMemo, useEffect } from 'react';
import { Boxes, X, Layers, Eye, FileText, Pencil, Save, Loader2 } from 'lucide-react';
import { ThreeModelViewer } from '../ThreeModelViewer';
import { ProjectEntry } from '../../types';
import { useAuth } from '../../lib/AuthContext';
import { updateProjectModule } from '../../lib/dualWrite';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../lib/firebase';

function toEmbeddableUrl(url: string): string {
 if (!url) return '';
 const match = url.match(/\/file\/d\/([^/]+)/);
 if (match) return `https://drive.google.com/file/d/${match[1]}/preview`;
 return url;
}

interface NativeModelViewerModalProps {
 url: string;
 drawingUrl?: string;
 onClose: () => void;
 clusters: string[];
 projectEntries: ProjectEntry[];
 initialViewMode?: '3d' | 'pdf';
}

export function NativeModelViewerModal({
 url, drawingUrl, onClose, clusters, projectEntries, initialViewMode = '3d',
}: NativeModelViewerModalProps) {
 const { user, hasRole } = useAuth();
 const isAdmin = hasRole('admin');
 const [activeCluster, setActiveCluster] = useState<string | null>(null);
 const [viewMode, setViewMode] = useState<'3d' | 'pdf'>(initialViewMode);
 const [editingCluster, setEditingCluster] = useState<string | null>(null);
 const [editClusterKey, setEditClusterKey] = useState('');
 const [savingClusterKey, setSavingClusterKey] = useState(false);

 const embedPdfUrl = useMemo(() => toEmbeddableUrl(drawingUrl || ''), [drawingUrl]);
 const hasPdf = !!drawingUrl?.trim();

 const handleSaveClusterKey = async () => {
  if (!editingCluster || !user) return;
  setSavingClusterKey(true);
  try {
   const modulesToUpdate = projectEntries.filter(e => e.cluster === editingCluster);
   await Promise.all(
    modulesToUpdate.map(entry =>
     updateProjectModule(entry.id, { objectClusterName: editClusterKey.trim() || null }, entry.projectCode)
    )
   );
   await addDoc(collection(db, 'activities'), {
    userId: user.uid,
    userName: user.displayName || 'Anonymous',
    userEmail: user.email,
    action: 'Chỉnh sửa key cụm 3D',
    details: `Cập nhật faded key cho cụm "${editingCluster}": "${editClusterKey}" (${modulesToUpdate.length} modules)`,
    projectCode: modulesToUpdate[0]?.projectCode || '',
    timestamp: serverTimestamp(),
   });
   setEditingCluster(null);
   setEditClusterKey('');
  } catch (error) {
   console.error('Lỗi lưu key cụm:', error);
   handleFirestoreError(error, OperationType.UPDATE, 'projects');
  } finally {
   setSavingClusterKey(false);
  }
 };





 const clusterModuleMap = useMemo(() => {
  const map = new Map<string, string[]>();
  clusters.forEach(c => {
   const seen = new Set<string>();
   const names: string[] = [];
   const addName = (n: string) => {
    const v = n.trim();
    if (v && !seen.has(v.toLowerCase())) {
     seen.add(v.toLowerCase());
     names.push(v);
    }
   };
   projectEntries.forEach(e => {
    if (e.cluster !== c) return;
    // Tên object chỉnh thủ công thay cho moduleCode; không có thì dùng logic gốc
    addName(e.objectName || e.moduleCode || '');
    // Tên cụm object dùng làm alias khớp object 3D của cụm (chỉ khớp mesh, không đổi tên sidebar)
    addName(e.objectClusterName || '');
   });
   map.set(c, names);
  });
  return map;
 }, [clusters, projectEntries]);

 const allModuleCodes = useMemo(() => {
  return projectEntries.map(e => e.objectName || e.moduleCode).filter(Boolean);
 }, [projectEntries]);

   const focusModuleNames = useMemo(() => {
    if (!activeCluster || activeCluster === '_all') return [];
    return (clusterModuleMap.get(activeCluster) || []).filter(c => !c.toLowerCase().includes('fill'));
   }, [activeCluster, clusterModuleMap]);

   useEffect(() => {
    if (focusModuleNames.length > 0) {
     // console.log(`[ClusterFocus] Cluster "${activeCluster}" → module codes:`, focusModuleNames);
    }
   }, [focusModuleNames, activeCluster]);

 const getClusterEntryCount = (cluster: string) => {
  return projectEntries.filter(e => e.cluster === cluster).length;
 };

 const hasClusters = clusters.length > 1;

 return (
  <div className="fixed inset-0 sm:bottom-0 bottom-[40px] bg-black/80 flex items-center justify-center z-[90] p-0 sm:p-4 backdrop-blur-md">
   {/* Mobile: chừa 60px bottom menu, PC: 90vw */}
   <div className="bg-white w-full h-full sm:max-w-[90vw] sm:max-h-[92vh] sm:rounded-lg shadow-2xl overflow-hidden flex flex-col border-0 sm:border border-slate-200">

    {/* Header */}
    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-white text-slate-800 shrink-0">
     <div className="w-10 shrink-0" />

     {/* Switch 3D / PDF — giữa header */}
     {hasPdf && (
      <div className="flex items-center bg-slate-100 rounded-lg border border-slate-200 p-0.5">
       <button
        onClick={() => setViewMode('3d')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer ${
         viewMode === '3d'
          ? 'bg-indigo-600 text-white shadow-sm'
          : 'text-slate-500 hover:text-slate-700'
        }`}
       >
        <Boxes size={12} />
        <span>Mô hình 3D</span>
       </button>
       <button
        onClick={() => setViewMode('pdf')}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer ${
         viewMode === 'pdf'
          ? 'bg-rose-600 text-white shadow-sm'
          : 'text-slate-500 hover:text-slate-700'
        }`}
       >
        <FileText size={12} />
        <span>Bản vẽ PDF</span>
       </button>
      </div>
     )}

     <button onClick={onClose} className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-100 rounded-lg transition-all shrink-0">
      <X size={20} />
     </button>
    </div>

    {/* Body */}
    <div className="flex-1 flex flex-col sm:flex-row min-h-0 relative">

     {/* Container cho 3D + PDF, luôn mounted */}
     <div className="flex-1 relative min-h-0 bg-slate-100">
      {/* 3D Viewer */}
      <div className={`absolute inset-0 ${viewMode === 'pdf' ? 'invisible pointer-events-none' : ''}`}>
        <ThreeModelViewer
         url={url}
         focusModuleNames={focusModuleNames}
         focusKey={activeCluster || '_all'}
        />
      </div>
      {/* PDF */}
      <div className={`absolute inset-0 ${viewMode === '3d' ? 'invisible pointer-events-none' : ''}`}>
       {embedPdfUrl ? (
        <iframe
         src={embedPdfUrl}
         className="w-full h-full border-0"
         title="Bản vẽ PDF"
        />
       ) : (
        <div className="w-full h-full flex items-center justify-center">
         <p className="text-sm text-slate-400">Không có bản vẽ</p>
        </div>
       )}
      </div>
     </div>

     {/* MOBILE: cluster filter bar — trên bottom menu */}
     {hasClusters && viewMode === '3d' && (
      <div className="sm:hidden shrink-0 border-t border-slate-200 bg-white pb-4">
       <div className="flex flex-wrap gap-1.5 px-3 py-2">
        <Layers size={11} className="text-slate-400 shrink-0 mt-1" />
        <button
         onClick={() => setActiveCluster('_all')}
         className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer border ${
          activeCluster === '_all'
           ? 'bg-indigo-600 text-white border-indigo-600'
           : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
         }`}
        >
         Tất cả
        </button>
        {clusters.map((c) => (
         <button
          key={c}
          onClick={() => setActiveCluster(c)}
          className={`px-2.5 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all cursor-pointer border ${
           activeCluster === c
            ? 'bg-indigo-600 text-white border-indigo-600'
            : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
          }`}
         >
          {c}
         </button>
        ))}
       </div>
      </div>
     )}

     {/* PC: sidebar bên phải */}
     {hasClusters && viewMode === '3d' && (
      <div className="hidden sm:flex w-56 shrink-0 bg-slate-50 border-l border-slate-200 flex-col overflow-hidden">
       <div className="px-3 py-2.5 border-b border-slate-200 flex items-center gap-1.5">
        <Layers size={12} className="text-indigo-500" />
        <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Cụm ({clusters.length})</span>
       </div>
       <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        <button
         onClick={() => setActiveCluster('_all')}
         className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer ${
          activeCluster === '_all'
           ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
           : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
         }`}
        >
         <Eye size={12} className="shrink-0" />
         <div className="min-w-0 flex-1">
          <span className="text-[10px] font-black uppercase tracking-widest block truncate">Tất cả</span>
          <span className={`text-[8px] font-bold ${activeCluster === '_all' ? 'text-indigo-200' : 'text-slate-400'}`}>
           {allModuleCodes.length} module
          </span>
         </div>
        </button>

        {clusters.map((c) => {
         const count = getClusterEntryCount(c);
         const firstEntry = projectEntries.find(e => e.cluster === c);
         const currentFadedKey = firstEntry?.objectClusterName || '';
         return (
          <div
           key={c}
           onClick={() => setActiveCluster(c)}
           className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer ${
            activeCluster === c
             ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/20'
             : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
           }`}
          >
           <div className={`w-2 h-2 rounded-full shrink-0 ${
            activeCluster === c ? 'bg-white' : 'bg-indigo-400'
           }`} />
           <div className="min-w-0 flex-1">
            <span className="text-[10px] font-black uppercase tracking-widest block truncate">{c}</span>
            <span className={`text-[8px] font-bold ${activeCluster === c ? 'text-indigo-200' : 'text-slate-400'}`}>
             {count} module{currentFadedKey ? ` · ${currentFadedKey}` : ''}
            </span>
           </div>
           {isAdmin && (
            <button
             type="button"
             onClick={(e) => {
              e.stopPropagation();
              setEditingCluster(c);
              setEditClusterKey(currentFadedKey);
             }}
             className="shrink-0 p-1 rounded-md hover:bg-indigo-100 text-slate-400 hover:text-indigo-600 transition-all cursor-pointer"
             title="Chỉnh sửa key cụm (Faded Key)"
            >
             <Pencil size={10} />
            </button>
           )}
          </div>
         );
        })}
       </div>
      </div>
     )}
    </div>
   </div>

   {/* Modal chỉnh sửa key cụm */}
   {editingCluster && (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4 backdrop-blur-sm">
     <div className="absolute inset-0" onClick={() => setEditingCluster(null)} />
     <div className="bg-white w-full max-w-sm rounded-lg shadow-2xl border border-slate-200 relative z-10 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
       <div>
        <h3 className="text-xs font-black text-slate-800 uppercase tracking-tight">Chỉnh sửa Key Cụm</h3>
        <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Cụm: {editingCluster}</p>
       </div>
       <button
        type="button"
        onClick={() => setEditingCluster(null)}
        className="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-100 rounded-lg transition-all cursor-pointer"
       >
        <X size={14} />
       </button>
      </div>
      <div className="p-4 space-y-3">
       <div>
        <label className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1.5">
         <Layers size={11} className="text-amber-500" />
         Faded Key (Key cụm)
        </label>
        <input
         value={editClusterKey}
         onChange={(e) => setEditClusterKey(e.target.value)}
         placeholder={editingCluster}
         className="w-full px-3 py-2 text-[12px] font-bold text-slate-800 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all placeholder:text-slate-300"
         autoFocus
         onKeyDown={(e) => { if (e.key === 'Enter') handleSaveClusterKey(); }}
        />
        <p className="text-[9px] text-slate-400 mt-1">
         Nhiều key phân tách bằng dấu phẩy. Dùng để khớp faded key trong mô hình 3D cho tất cả module trong cụm này.
        </p>
       </div>
       <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
        <button
         type="button"
         onClick={() => setEditingCluster(null)}
         className="px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all cursor-pointer"
        >
         Hủy
        </button>
        <button
         type="button"
         onClick={handleSaveClusterKey}
         disabled={savingClusterKey}
         className="flex items-center gap-1.5 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg transition-all active:scale-95 cursor-pointer disabled:opacity-60"
        >
         {savingClusterKey ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
         Lưu
        </button>
       </div>
      </div>
     </div>
    </div>
   )}
  </div>
 );
}
