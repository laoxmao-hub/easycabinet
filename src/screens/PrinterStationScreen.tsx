import React, { useState, useEffect, useRef } from 'react';
import { Printer, CheckCircle2, Loader2, Wifi, WifiOff } from 'lucide-react';
import { collection, query, onSnapshot, doc, updateDoc, serverTimestamp, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { generateLabelHtml } from '../components/LabelTemplate';

interface PrintJob {
  id: string;
  packageId: string;
  packageName: string;
  payload: {
    name: string;
    projectName: string;
    unit: string;
    area: string;
    cabinetType: string;
    w: string;
    d: string;
    h: string;
    weight: string;
    qrText: string;
    qrUrl: string;
    instanceIndex?: number;
    totalInstances?: number;
    supplierDept?: string;
    deliveryAddress?: string;
    receiverName?: string;
    receiverPhone?: string;
    printDate?: string;
  };
 pklCode: string;
 pklId: string;
 copies?: number;
 sw?: string;
 formTemplate?: 'mau1' | 'mau2' | 'mauBcons';
 printedAt?: any;
 status?: string;
}

export function PrinterStationScreen() {
 const [stationOn, setStationOn] = useState(false);
 const [connected, setConnected] = useState(false);
 const [printing, setPrinting] = useState(false);
 const [lastPrinted, setLastPrinted] = useState<string>('');
 const [printCount, setPrintCount] = useState(0);
 const [pendingJob, setPendingJob] = useState<PrintJob | null>(null);
 const printFrameRef = useRef<HTMLIFrameElement>(null);

 useEffect(() => {
   if (!stationOn) {
     setConnected(false);
     return;
   }

   const q = query(collection(db, 'print_jobs'));
   const unsub = onSnapshot(q, (snapshot) => {
     setConnected(true);
     snapshot.docChanges().forEach((change) => {
       if (change.type === 'added') {
         const data = { id: change.doc.id, ...change.doc.data() } as PrintJob;
         if (!data.printedAt) {
           setPendingJob(data);
         }
       }
     });
   }, (error) => {
     console.error('Printer station error:', error);
     setConnected(false);
   });

   return unsub;
 }, [stationOn]);

  // Auto-print khi có pendingJob
  const pendingJobRef = useRef<PrintJob | null>(null);
  pendingJobRef.current = pendingJob;

  useEffect(() => {
    if (!pendingJob) return;
    const job = pendingJob;
    const copies = job.copies || 4;
    console.log('[PrinterStation] Print job:', job.packageName, 'copies:', copies, 'raw copies:', job.copies);

    setPrinting(true);

    const frame = printFrameRef.current;
    if (!frame) {
      console.error('[PrinterStation] No print frame found');
      setPrinting(false);
      setPendingJob(null);
      return;
    }

    const frameDoc = frame.contentDocument || frame.contentWindow?.document;
    if (!frameDoc) {
      console.error('[PrinterStation] No frame document');
      setPrinting(false);
      setPendingJob(null);
      return;
    }

    const html = generateLabelHtml(job.payload, copies, job.sw || 'UNIT', job.formTemplate || 'mau1');
    frameDoc.open();
    frameDoc.write(html);
    frameDoc.close();

    // Đánh dấu đã in TRƯỚC khi in để tránh onSnapshot pick lại
    updateDoc(doc(db, 'print_jobs', job.id), {
      printedAt: serverTimestamp(),
      status: 'printed'
    }).then(() => {
      setTimeout(() => {
        frame.contentWindow?.print();
        setLastPrinted(job.packageName);
        setPrintCount(prev => prev + 1);
        setPrinting(false);
        setPendingJob(null);
      }, 500);
    }).catch((err) => {
      console.error('[PrinterStation] Failed to mark printed:', err);
      // Vẫn in就算 không mark được
      setTimeout(() => {
        frame.contentWindow?.print();
        setLastPrinted(job.packageName);
        setPrintCount(prev => prev + 1);
        setPrinting(false);
        setPendingJob(null);
      }, 500);
    });
  }, [pendingJob]);

 return (
   <div className="min-h-screen bg-slate-100 font-sans">
     {/* Header */}
     <div className="bg-white border-b border-slate-200 sticky top-0 z-40 px-4 py-3">
       <div className="max-w-4xl mx-auto flex items-center justify-between">
         <div className="flex items-center gap-3">
           <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${stationOn && connected ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
             <Printer size={22} />
           </div>
           <div>
             <h1 className="text-sm font-black text-slate-800 uppercase tracking-tight">Trạm Máy In Liên Kết</h1>
             <p className="text-[10px] font-bold uppercase">
               {stationOn ? (connected ? <span className="text-emerald-600">Đang lắng nghe print_jobs</span> : <span className="text-amber-500">Đang kết nối...</span>) : <span className="text-slate-400">Đã tắt - Bật để bắt đầu</span>}
             </p>
           </div>
         </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (!confirm('Xóa toàn bộ dữ liệu print_jobs?')) return;
                const snap = await getDocs(query(collection(db, 'print_jobs')));
                for (const d of snap.docs) {
                  await deleteDoc(doc(db, 'print_jobs', d.id));
                }
              }}
              className="px-3 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider border bg-rose-50 text-rose-600 border-rose-200 hover:bg-rose-100 transition-all cursor-pointer"
            >
              Xoá Data
            </button>
            <button
              onClick={() => setStationOn(prev => !prev)}
              className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider border transition-all cursor-pointer ${stationOn ? 'bg-emerald-500 text-white border-emerald-500 hover:bg-emerald-600' : 'bg-slate-100 text-slate-500 border-slate-300 hover:bg-slate-200'}`}
            >
              {stationOn ? 'Tắt' : 'Bật trạm in'}
            </button>
          </div>
       </div>
     </div>

     {/* Status */}
     <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
       {/* Trạng thái hiện tại */}
       <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
         <div className="flex items-center justify-between">
           <span className="text-xs font-black text-slate-400 uppercase">Trạng thái</span>
           {!stationOn ? (
             <span className="text-xs font-black text-slate-400">Tắt</span>
           ) : printing ? (
             <span className="flex items-center gap-1.5 text-xs font-black text-amber-600">
               <Loader2 size={14} className="animate-spin" /> Đang in...
             </span>
           ) : (
             <span className="flex items-center gap-1.5 text-xs font-black text-emerald-600">
               <CheckCircle2 size={14} /> Sẵn sàng
             </span>
           )}
         </div>
         <div className="flex items-center justify-between">
           <span className="text-xs font-black text-slate-400 uppercase">Lần in cuối</span>
           <span className="text-xs font-bold text-slate-700">{lastPrinted || 'Chưa có'}</span>
         </div>
         <div className="flex items-center justify-between">
           <span className="text-xs font-black text-slate-400 uppercase">Tổng số tem đã in</span>
           <span className="text-sm font-black text-indigo-600">{printCount}</span>
         </div>
       </div>

       {/* Hướng dẫn */}
       <div className="bg-indigo-50 border border-indigo-100 rounded-lg p-4 text-xs text-indigo-800 font-semibold leading-relaxed">
         <p className="font-extrabold uppercase text-[10px] mb-1">Cách sử dụng:</p>
         <p>Giữ tab này mở trên máy tính nối máy in. Khi có lệnh in từ phần mềm Đóng gói, tem sẽ tự động gửi đến máy in.</p>
       </div>
     </div>

     {/* Iframe ẩn để in */}
     <iframe ref={printFrameRef} className="hidden" title="print-frame" />
   </div>
 );
}
