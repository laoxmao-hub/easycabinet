import React, { useRef, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Camera, X, Loader2, RefreshCw, Check, AlertTriangle, QrCode } from 'lucide-react';
import { ProjectEntry, getModuleInstances } from '../types';
import { parseQRCode } from '../lib/qrParser';
import jsQR from 'jsqr';

interface ScannerModalProps {
 onClose: () => void;
 onScan: (scannedData: ScannedResult) => void;
 projectEntries: ProjectEntry[];
}

export interface ScannedResult {
 moduleCode: string;
 rawCode?: string;
 width?: number;
 depth?: number;
 height?: number;
 isMatched: boolean;
 matchedId?: string;
 projectCode?: string;
 projectName?: string;
 cluster?: string;
 notes?: string;
 isNewChildOfParent?: boolean;
 parentModuleCode?: string;
 instanceId?: string;
 parsedModuleId?: string;
 hasIdComponent?: boolean;
 cthtId?: string;
 extractedId?: string;
 idModuleCode?: string;
 cncid?: string;
 cthtPackageId?: string; // ID duy nhất của kiện CTHT từ QR code
}

export function ScannerModal({ onClose, onScan, projectEntries }: ScannerModalProps) {
 const videoRef = useRef<HTMLVideoElement>(null);
 const canvasRef = useRef<HTMLCanvasElement>(null);
 const fileInputRef = useRef<HTMLInputElement>(null);
 const [stream, setStream] = useState<MediaStream | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [cameraReady, setCameraReady] = useState(false);
 const scanningRef = useRef<number | null>(null);
 const activeStreamRef = useRef<MediaStream | null>(null);

 useEffect(() => {
 let active = true;

 const runStart = async () => {
 setError(null);
 if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
 setError('Trình duyệt chặn truy cập Camera. Vui lòng nhấn "Mở tab mới" ở góc trên bên phải hoặc sử dụng tính năng "Chụp / Tải ảnh QR" bên dưới.');
 return;
 }

 // Cấu hình linh hoạt từ tối ưu nhất cho quét QR đến cơ bản để tăng tối đa độ tương thích
 const constraintsList = [
 {
 video: { 
 facingMode: { ideal: 'environment' },
 width: { ideal: 1280 },
 height: { ideal: 720 }
 }
 },
 {
 video: { 
 facingMode: 'environment'
 }
 },
 {
 video: true
 }
 ];

 let lastError: any = null;
 let s: MediaStream | null = null;

 for (const constraints of constraintsList) {
 try {
 if (!active) return;
 console.log("Đang tải luồng camera với cấu hình:", constraints);
 s = await navigator.mediaDevices.getUserMedia(constraints);
 if (s) {
 console.log("Khởi tạo camera thành công!");
 break;
 }
 } catch (err: any) {
 lastError = err;
 console.warn("Thử cấu hình camera thất bại, chuyển qua phương án dự phòng...", err.name || err);
 }
 }

 if (!active) {
 if (s) {
 s.getTracks().forEach(track => track.stop());
 }
 return;
 }

 if (!s) {
 console.warn("Không thể mở bất kỳ luồng camera nào:", lastError);
 if (lastError?.name === 'NotAllowedError' || lastError?.name === 'PermissionDeniedError') {
 setError('Bạn đã từ chối quyền truy cập Camera. Vui lòng cấp lại quyền camera trong Cài đặt hoặc dùng nút "Chụp / Tải ảnh" bên dưới.');
 } else {
 setError(`Camera live không khả dụng (Lỗi: ${lastError?.name || 'Chặn quyền'}). Bạn hãy dùng nút "Chụp / Tải ảnh QR" hoặc mở trong tab mới.`);
 }
 return;
 }

 try {
 activeStreamRef.current = s;
 setStream(s);
 
 if (videoRef.current) {
 videoRef.current.srcObject = s;
 videoRef.current.onloadedmetadata = () => {
 if (videoRef.current && active) {
 videoRef.current.play().catch(playErr => {
 if (playErr.name !== 'AbortError') {
 console.warn("Lưu ý bật phát video camera:", playErr);
 }
 });
 }
 };
 }
 setCameraReady(true);
 } catch (err: any) {
 console.error("Lỗi gán luồng video:", err);
 setError(`Lỗi hiển thị camera: ${err.message || err}`);
 }
 };

 runStart();

 return () => {
 active = false;
 if (activeStreamRef.current) {
 activeStreamRef.current.getTracks().forEach(track => {
 track.stop();
 console.log("Đã dừng luồng camera:", track.label);
 });
 activeStreamRef.current = null;
 }
 if (scanningRef.current) {
 cancelAnimationFrame(scanningRef.current);
 }
 };
 }, []);

 useEffect(() => {
 if (cameraReady) {
 scanningRef.current = requestAnimationFrame(scanLoop);
 }
 return () => {
 if (scanningRef.current) cancelAnimationFrame(scanningRef.current);
 };
 }, [cameraReady]);

 // Âm thanh beep khi quét QR thành công
 const playSuccessBeep = () => {
 try {
 const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
 const now = audioCtx.currentTime;

 // Note 1: 880Hz (A5)
 const osc1 = audioCtx.createOscillator();
 const gain1 = audioCtx.createGain();
 osc1.type = 'sine';
 osc1.frequency.setValueAtTime(880, now);
 gain1.gain.setValueAtTime(0.3, now);
 gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
 osc1.connect(gain1);
 gain1.connect(audioCtx.destination);
 osc1.start(now);
 osc1.stop(now + 0.15);

 // Note 2: 1175Hz (D6) - cao hơn tạo cảm giác thành công
 const osc2 = audioCtx.createOscillator();
 const gain2 = audioCtx.createGain();
 osc2.type = 'sine';
 osc2.frequency.setValueAtTime(1175, now + 0.1);
 gain2.gain.setValueAtTime(0, now);
 gain2.gain.setValueAtTime(0.3, now + 0.1);
 gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
 osc2.connect(gain2);
 gain2.connect(audioCtx.destination);
 osc2.start(now + 0.1);
 osc2.stop(now + 0.3);
 } catch (e) {
 // Bỏ qua nếu AudioContext không khả dụng
 }
 };

  const processModuleCode = (code: string) => {
 let processed = code || '';

 // Bỏ phần số tùy chọn phía trước dấu . ở đầu chuỗi (ví dụ: "74.BLDG_..." thành "BLDG_...")
 processed = processed.replace(/^\d+\./, '').trim();

 // Tách theo dấu _
 const parts = processed.split('_');

 // Giữ phần đầu và phần cuối
 if (parts.length >= 2) {
 processed = `${parts[0]}_${parts[parts.length - 1]}`;
 }

 return processed;
 };

 const handleScanSuccess = (rawCode: string): boolean => {
 let rawCleaned = rawCode.trim();
 if (rawCleaned.includes("----")) {
 rawCleaned = rawCleaned.split("----")[0].trim();
 }
 
 const parsed = parseQRCode(rawCleaned);
 
 let hasId = false;
 let extractedId = "";
 let extractedModuleCode = rawCleaned;
 let idModuleCode = "";
 let scannedCncId = parsed.cncid;

 if (scannedCncId) {
 hasId = true;
 extractedId = scannedCncId;
 extractedModuleCode = parsed.moduleCode || parsed.moduleId || rawCleaned;
 idModuleCode = rawCleaned;
 } else {
 // Fallback cho regex cũ
 const matchWithId = rawCleaned.match(/^(\d+)\.(.+)$/);
 if (matchWithId) {
 const idPart = matchWithId[1];
 const restPart = matchWithId[2].trim();
 if (restPart.includes('_')) {
 hasId = true;
 extractedId = idPart;
 extractedModuleCode = restPart;
 idModuleCode = rawCleaned;
 scannedCncId = idPart;
 }
 }
 }
 
 let match: ProjectEntry | undefined = undefined;
 let isBoModule = false;
 let targetCode = extractedModuleCode;
 let width = 0, depth = 0, height = 0;
 let cthtPackageId: string | undefined = undefined;

 // CTHT/Phụ kiện QR format: "${id}|${name}" (id bắt đầu bằng ctht- hoặc acc-)
 const cthtNewMatch = rawCleaned.match(/^((?:ctht|acc)-\S+)\|(.+)$/);
 if (cthtNewMatch) {
   cthtPackageId = cthtNewMatch[1].trim();
   targetCode = cthtNewMatch[2].trim();
   extractedModuleCode = cthtNewMatch[2].trim();
   // CTHT/Phụ kiện items không có trong projectEntries, sẽ match trong handleQRScan
 }

 // Kiểm tra CTHT QR format cũ: "FINISHED PANEL|{ID}" (ID không phải số)
 if (!cthtNewMatch) {
   const cthtIdMatch = rawCleaned.match(/^([^|]+)\|([^|]+)$/);
   if (cthtIdMatch) {
     const baseCode = cthtIdMatch[1].trim();
     const possibleId = cthtIdMatch[2].trim();
     // Nếu phần sau | không phải số → đây là CTHT package ID
     if (possibleId && isNaN(Number(possibleId))) {
       cthtPackageId = possibleId;
       targetCode = baseCode;
       extractedModuleCode = baseCode;
       // Thử tìm project entry với base code
       match = projectEntries.find(p => p.moduleCode?.toLowerCase() === baseCode.toLowerCase());
       if (!match) {
         match = projectEntries.find(p => (p.moduleCode || '').toLowerCase().includes(baseCode.toLowerCase()));
       }
     }
   }
 }

 // Tìm kiếm ProjectEntry tương ứng
 if (parsed.moduleId) {
 match = projectEntries.find(p => p.id === parsed.moduleId || p.moduleCode?.toLowerCase() === parsed.moduleId.toLowerCase());
 if (!match) {
 const cleanModCode = parsed.moduleId.replace(/^\d+\./, '').trim();
 match = projectEntries.find(p => p.moduleCode?.toLowerCase() === cleanModCode.toLowerCase());
 }
 // Fallback: bỏ hậu tố #X/Y (ví dụ "MOR026_... #2/2" → "MOR026_...")
 if (!match && parsed.moduleId.includes('#')) {
 const strippedCode = parsed.moduleId.replace(/\s*#\d+\/\d+/, '').trim();
 match = projectEntries.find(p => p.moduleCode?.toLowerCase() === strippedCode.toLowerCase());
 }
 }

 if (!match) {
 const cleanTarget = targetCode.replace(/^\d+\./, '').trim();
 match = projectEntries.find(p => p.moduleCode?.toLowerCase() === cleanTarget.toLowerCase());
 }

 if (!match && rawCleaned.startsWith('{')) {
 try {
 const parsedJson = JSON.parse(rawCleaned);
 if (parsedJson.moduleType === 'bo' && parsedJson.moduleId) {
 isBoModule = true;
 match = projectEntries.find(p => p.id === parsedJson.moduleId);
 } else {
 targetCode = parsedJson.moduleCode || parsedJson.code || rawCleaned;
 width = parsedJson.pWidth || parsedJson.width || parsedJson.W || parsedJson.w || parsedJson.R || parsedJson.r || 0;
 depth = parsedJson.pDepth || parsedJson.depth || parsedJson.D || parsedJson.d || parsedJson.S || parsedJson.s || 0;
 height = parsedJson.pHeight || parsedJson.height || parsedJson.H || parsedJson.h || parsedJson.C || parsedJson.c || 0;
 }
 } catch (e) {
 targetCode = extractedModuleCode;
 }
 }

 if (match) {
 isBoModule = match.moduleType === 'bo';
 targetCode = match.moduleCode || targetCode;
 width = match.pWidth || match.width || width;
 depth = match.pDepth || match.depth || depth;
 height = match.pHeight || match.height || height;
 }

 let finalCode = match ? match.moduleCode : targetCode.replace(/^\d+\./, '').trim();
 let computedInstanceId: string | undefined = undefined;

 if (match && !isBoModule) {
  const insts = getModuleInstances(match);
 
 if (scannedCncId) {
 // DẠNG 1: 26.MOR026_ENT.T1
 // 1. Tìm xem có instance nào đã được gán cncid này chưa
 let foundInst = insts.find(inst => inst.cncid === scannedCncId);
 // 2. Nếu chưa, tìm instance đầu tiên chưa có cncid
 if (!foundInst) {
 foundInst = insts.find(inst => !inst.cncid);
 }
 // 3. Nếu vẫn không thấy, lấy instance đầu tiên
 if (!foundInst && insts.length > 0) {
 foundInst = insts[0];
 }
 if (foundInst) {
 computedInstanceId = foundInst.id || foundInst.instanceId;
 }
 } else if (parsed.instanceId) {
 // DẠNG 2: MOR026_ENT.T1|1
 // Tìm instance trùng khớp hoàn toàn
 let foundInst = insts.find(inst => inst.id === parsed.instanceId || inst.instanceId === parsed.instanceId);
 // Fallback: bỏ hậu tố #X/Y rồi match lại (QR text "MOR026_... #2/2|2" → "MOR026_...|2")
 if (!foundInst && parsed.instanceId.includes('#')) {
  const stripped = parsed.instanceId.replace(/\s*#\d+\/\d+/, '').trim();
  foundInst = insts.find(inst => inst.id === stripped || inst.instanceId === stripped);
 }
 if (foundInst) {
 computedInstanceId = foundInst.id || foundInst.instanceId;
 }
 } else if (hasId && extractedId) {
 // Fallback khớp số thứ tự hoặc index
 const targetIdStr = extractedId.trim();
 let foundInst = insts.find(inst => 
 inst.stt?.toString() === targetIdStr ||
 inst.tempLabelIndex?.toString() === targetIdStr ||
 inst.instanceIndex?.toString() === targetIdStr
 );
 if (foundInst) {
 computedInstanceId = foundInst.instanceId;
 } else if (insts.length > 0) {
 computedInstanceId = insts[0].instanceId;
 }
 }
 }

 playSuccessBeep();
 onScan({
 moduleCode: finalCode,
 rawCode: rawCleaned,
 width: width,
 depth: depth,
 height: height,
 isMatched: !!match,
 matchedId: match?.id,
 projectCode: match?.projectCode,
 projectName: match?.projectName,
 cluster: match?.cluster,
 isNewChildOfParent: false,
 parentModuleCode: undefined,
 instanceId: computedInstanceId || parsed.instanceId,
 parsedModuleId: parsed.moduleId,
 hasIdComponent: hasId,
 extractedId: extractedId ? extractedId : undefined,
 idModuleCode: idModuleCode ? idModuleCode : undefined,
 cncid: scannedCncId,
 cthtPackageId: cthtPackageId
 });
 onClose();
 return true;
 };

 const scanLoop = () => {
 if (!videoRef.current || !canvasRef.current) return;

 try {
 const video = videoRef.current;
 const canvas = canvasRef.current;
 
 if (video.readyState === video.HAVE_ENOUGH_DATA) {
 canvas.width = video.videoWidth;
 canvas.height = video.videoHeight;
 const ctx = canvas.getContext('2d', { willReadFrequently: true });
 
 if (ctx) {
 ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
 const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
 const qrCode = jsQR(imageData.data, imageData.width, imageData.height, {
 inversionAttempts: "dontInvert",
 });

 if (qrCode) {
 const success = handleScanSuccess(qrCode.data.trim());
 if (success) return; // Stop the loop
 }
 }
 }
 scanningRef.current = requestAnimationFrame(scanLoop);
 } catch (err) {
 console.error("Scan error", err);
 scanningRef.current = requestAnimationFrame(scanLoop);
 }
 };

 // Hàm xử lý khi người dùng chụp ảnh hoặc tải lên hình ảnh mã QR
 const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (!file) return;

 setError(null);
 const reader = new FileReader();
 reader.onload = (event) => {
 const img = new Image();
 img.onload = () => {
 if (!canvasRef.current) return;
 const canvas = canvasRef.current;
 canvas.width = img.width;
 canvas.height = img.height;
 const ctx = canvas.getContext('2d');
 if (ctx) {
 ctx.drawImage(img, 0, 0);
 const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
 const qrCode = jsQR(imageData.data, imageData.width, imageData.height, {
 inversionAttempts: "dontInvert",
 });

 if (qrCode) {
 handleScanSuccess(qrCode.data.trim());
 } else {
 setError('Không phát hiện thấy mã QR hợp lệ trong hình ảnh đã tải lên. Vui lòng chụp rõ nét hơn hoặc thử lại.');
 }
 }
 };
 img.src = event.target?.result as string;
 };
 reader.readAsDataURL(file);
 };

 return (
 <div className="fixed inset-0 z-[100] bg-slate-900 flex flex-col">
 <div className="p-5 flex items-center justify-between text-white bg-slate-900/80 backdrop-blur-md absolute top-0 w-full z-10 border-b border-white/5">
 <div className="flex items-center gap-3">
 <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center">
 <QrCode size={20} className="text-white" />
 </div>
 <div>
 <h3 className="font-black text-sm uppercase tracking-tight">Máy Quét QR</h3>
 <p className="text-[9px] font-black uppercase text-indigo-400 tracking-widest leading-none">Scanning Engine v3.0</p>
 </div>
 </div>
 <button onClick={onClose} className="p-3 bg-white/5 hover:bg-white/10 rounded-lg transition-all border border-white/10">
 <X size={24} />
 </button>
 </div>

 <div className="flex-1 relative flex items-center justify-center bg-black overflow-hidden">
 <video 
 ref={videoRef} 
 autoPlay 
 playsInline 
 muted
 controls={false}
 className="w-full h-full object-cover"
 />
 
 {/* Scanner Overlay UI */}
 <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
 <div className="w-72 h-72 border border-white/10 rounded-lg relative">
 <div className="absolute top-0 left-0 w-12 h-12 border-t-4 border-l-4 border-indigo-500 rounded-tl-lg"></div>
 <div className="absolute top-0 right-0 w-12 h-12 border-t-4 border-r-4 border-indigo-500 rounded-tr-lg"></div>
 <div className="absolute bottom-0 left-0 w-12 h-12 border-b-4 border-l-4 border-indigo-500 rounded-bl-lg"></div>
 <div className="absolute bottom-0 right-0 w-12 h-12 border-b-4 border-r-4 border-indigo-500 rounded-br-lg"></div>
 
 <motion.div 
 animate={{ top: ['10%', '90%'] }}
 transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
 className="absolute left-4 right-4 h-0.5 bg-indigo-500 shadow-[0_0_20px_#4f46e5]"
 />
 </div>
 </div>

 {error && (
 <div className="absolute bottom-32 left-8 right-8 bg-rose-600 text-white p-4 rounded-lg text-xs font-black uppercase tracking-widest flex items-center gap-3 z-30 shadow-2xl border border-rose-500">
 <AlertTriangle size={20} className="shrink-0" />
 <span className="leading-snug">{error}</span>
 </div>
 )}
 </div>

 <div className="p-6 bg-slate-900 border-t border-white/5 flex flex-col items-center gap-4 text-center">
 <div className="flex flex-col sm:flex-row gap-3 w-full max-w-md">
 <button
 onClick={() => fileInputRef.current?.click()}
 className="w-full bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white py-3.5 px-6 rounded-xl text-xs font-black uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-xl shadow-indigo-900/50"
 >
 <Camera size={16} />
 Chụp / Tải ảnh QR
 </button>
 
 <input
 ref={fileInputRef}
 type="file"
 accept="image/*"
 capture="environment"
 className="hidden"
 onChange={handleFileUpload}
 />
 </div>

 <div className="flex flex-col items-center gap-1">
 <p className="text-white text-xs font-black uppercase tracking-[0.3em] flex items-center gap-2">
 <Loader2 size={16} className="animate-spin text-indigo-400" />
 Đang tìm camera hoặc mã vạch...
 </p>
 <p className="text-slate-500 text-[10px] uppercase font-black tracking-widest max-w-sm leading-relaxed">
 Nhấn "Chụp / Tải ảnh QR" để chụp quét bằng ứng dụng camera mặc định nếu live-camera bị chặn quyền
 </p>
 </div>
 </div>

 <canvas ref={canvasRef} className="hidden" />
 </div>
 );
}
