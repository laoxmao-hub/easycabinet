import React, { useState, useEffect, useRef } from 'react';
import { 
 Upload, Download, FileText, Search, Trash2, Edit2, Play, Check, AlertTriangle, 
 RefreshCw, Settings, FileSpreadsheet, Layers, Info, CheckCircle2, ChevronRight, CornerDownRight, Plus
} from 'lucide-react';
import * as XLSX from 'xlsx';

// PDF.js Types
interface TextItem {
 str: string;
 dir: string;
 width: number;
 height: number;
 transform: number[]; // [scaleX, skewX, skewY, scaleY, tx, ty]
}

interface ParsedRow {
 key: string;
 page: number;
 lineNum: number;
 rawText: string;
 cols: string[];
 
 // New specific fields based on user request (flat image setup)
 qr: string;
 material: string;
 width: number;
 height: number;
 thickness: number;
 quantity: number;

 // Compatibility fields
 moduleCode: string;
 name: string;
 dimensions: string;
 notes: string;
 cluster: string;
 moduleName: string;
 length: number;
}

export function ToolsScreen() {
 const [loadingPdfLib, setLoadingPdfLib] = useState(true);
 const [pdfLibError, setPdfLibError] = useState<string | null>(null);
 const [pdfFile, setPdfFile] = useState<File | null>(null);
 const [parsing, setParsing] = useState(false);
 const [pdfPagesText, setPdfPagesText] = useState<{ page: number; lines: { y: number; text: string }[] }[]>([]);
 
 // Settings for parsing
 const [splitMethod, setSplitMethod] = useState<'double_space' | 'tab' | 'comma' | 'semicolon' | 'pipe' | 'regex'>('double_space');
 const [customSplitRegex, setCustomSplitRegex] = useState<string>('\\s{2,}');
 
 // Column mapping (0-indexed index of cols array after split, -1 means ignore/auto-extract)
 const [colMap, setColMap] = useState({
 moduleCode: 0,
 name: 1,
 dimensions: 2,
 quantity: 3,
 cluster: -1,
 notes: -1
 });
 
 // Auto extraction parameters
 const [autoDetect, setAutoDetect] = useState(true);
 
 const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
 const [searchQuery, setSearchQuery] = useState('');
 const [isDragOver, setIsDragOver] = useState(false);
 const [activeSubTab, setActiveSubTab] = useState<'table' | 'raw'>('table');
 
 // Inline editing state
 const [editingRowKey, setEditingRowKey] = useState<string | null>(null);
 const [editingData, setEditingData] = useState<Partial<ParsedRow>>({});

 const fileInputRef = useRef<HTMLInputElement>(null);

 // Load PDFJS from CDN asynchronously
 useEffect(() => {
 const scriptId = 'pdfjs-cdn-script';
 const existingScript = document.getElementById(scriptId);

 const initPdfWorker = () => {
 try {
 const pdfjsLib = (window as any).pdfjsLib;
 if (pdfjsLib) {
 pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
 setLoadingPdfLib(false);
 } else {
 setPdfLibError('Không tìm thấy pdfjsLib trên window object.');
 }
 } catch (err: any) {
 setPdfLibError(`Lỗi cài đặt worker: ${err.message}`);
 }
 };

 if (existingScript) {
 if ((window as any).pdfjsLib) {
 initPdfWorker();
 } else {
 existingScript.addEventListener('load', initPdfWorker);
 }
 return;
 }

 const script = document.createElement('script');
 script.id = scriptId;
 script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js';
 script.async = true;
 script.onload = () => {
 initPdfWorker();
 };
 script.onerror = () => {
 setPdfLibError('Không thể tải thư viện xử lý PDF từ máy chủ CDN. Vui lòng kết nối Internet.');
 };
 document.body.appendChild(script);
 }, []);

 const handleDragOver = (e: React.DragEvent) => {
 e.preventDefault();
 setIsDragOver(true);
 };

 const handleDragLeave = () => {
 setIsDragOver(false);
 };

 const handleDrop = (e: React.DragEvent) => {
 e.preventDefault();
 setIsDragOver(false);
 const files = e.dataTransfer.files;
 if (files && files.length > 0) {
 const file = files[0];
 if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
 setPdfFile(file);
 parsePdf(file);
 } else {
 alert('Chỉ hỗ trợ tài liệu định dạng PDF');
 }
 }
 };

 const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
 const files = e.target.files;
 if (files && files.length > 0) {
 setPdfFile(files[0]);
 parsePdf(files[0]);
 }
 };

 // Main pdf parsing function
 const parsePdf = async (file: File) => {
 const pdfjsLib = (window as any).pdfjsLib;
 if (!pdfjsLib) {
 alert('Thư viện xử lý PDF chưa được tải xong.');
 return;
 }

 setParsing(true);
 setPdfPagesText([]);
 setParsedRows([]);
 setEditingRowKey(null);

 try {
 const reader = new FileReader();
 reader.onload = async function() {
 try {
 const typedarray = new Uint8Array(this.result as ArrayBuffer);
 const pdf = await pdfjsLib.getDocument({ data: typedarray }).promise;
 const numPages = pdf.numPages;
 const extractedPages: { page: number; lines: { y: number; text: string }[] }[] = [];

 for (let pNum = 1; pNum <= numPages; pNum++) {
 const page = await pdf.getPage(pNum);
 const textContent = await page.getTextContent();
 
 // Group items into lines based on their vertical coordinate (transform[5])
 const items = textContent.items as TextItem[];
 const linesMap: { [y: number]: TextItem[] } = {};
 
 items.forEach(item => {
 const y = Math.round(item.transform[5] * 5) / 5; // Round to 0.2 to merge slightly off heights
 if (!linesMap[y]) {
 linesMap[y] = [];
 }
 linesMap[y].push(item);
 });

 // Sort lines from top to bottom (Y descending)
 const sortedY = Object.keys(linesMap).map(Number).sort((a, b) => b - a);
 const pageLines = sortedY.map((y) => {
 // Sort items on the same line from left to right (X ascending, transform[4])
 const lineItems = linesMap[y].sort((a, b) => a.transform[4] - b.transform[4]);
 return {
 y,
 text: lineItems.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim()
 };
 }).filter(l => l.text.length > 0);

 extractedPages.push({
 page: pNum,
 lines: pageLines
 });
 }

 setPdfPagesText(extractedPages);
 processLinesToRows(extractedPages);
 } catch (err: any) {
 console.error(err);
 alert(`Lỗi phân tích cú pháp PDF: ${err.message}`);
 } finally {
 setParsing(false);
 }
 };

 reader.readAsArrayBuffer(file);
 } catch (err: any) {
 console.error(err);
 alert(`Lỗi đọc tập tin: ${err.message}`);
 setParsing(false);
 }
 };

 // Apply split and mappings to lines to extract tabular rows
 const processLinesToRows = (pagesData: typeof pdfPagesText) => {
 const rows: ParsedRow[] = [];
 let rowIdxCounter = 1;

 pagesData.forEach(pageObj => {
 pageObj.lines.forEach((lineObj, lineIdx) => {
 const rawText = lineObj.text.trim();
 if (!rawText) return;

 // Chỉ lấy những hàng chứa thông tin kích thước nằm trong dấu ngoặc vuông []
 // Định dạng điển hình: 89.ELMB3_Vách 2_LVR.T1 [1945.0x1048.0x18] MDF Veneer Walnut PU 2M
 const matchBrackets = rawText.match(/(.*)\[([^\]]+)\](.*)/);
 if (!matchBrackets) return; // Bỏ qua nếu dòng không chứa ngoặc vuông []

 // 1. Phân tích phần kích thước trong dấu ngoặc vuông
 const dimStr = matchBrackets[2].trim();
 const dims = dimStr.split(/[xX*]/).map(d => parseFloat(d.trim())).filter(n => !isNaN(n));
 
 const width = dims[0] || 0;
 const height = dims[1] || 0;
 const thickness = dims[2] !== undefined ? dims[2] : 18; // Mặc định dày 18 nếu không có

 // 2. Phân tích mã QR (phía bên trái dấu ngoặc vuông), lọc sạch các số thứ tự ở đầu
 const leftText = matchBrackets[1].trim();
 const filterPrefixNumbers = (str: string) => {
 let res = str.trim();
 // Lọc bỏ các số thứ tự liên tiếp dạng "89. " hoặc "2 " hoặc "89." ở đầu dòng
 while (/^\d+[\s.]/.test(res)) {
 res = res.replace(/^\d+[\s.]+/, '').trim();
 }
 return res;
 };
 const qr = filterPrefixNumbers(leftText) || 'N/A';

 // 3. Phân tích vật liệu và số lượng (phía bên phải dấu ngoặc vuông)
 let rightText = matchBrackets[3].trim();
 let quantity = 1;

 // Thử tìm số lượng ở cuối chuỗi bên phải (Ví dụ: "MDF Veneer Walnut PU 2M 2" -> SL là 2)
 const qtyMatch = rightText.match(/\s+(\d+)\s*$/);
 if (qtyMatch) {
 quantity = parseInt(qtyMatch[1], 10);
 rightText = rightText.substring(0, rightText.length - qtyMatch[0].length).trim();
 }
 
 let material = rightText || 'N/A';

 // Thêm hàng mới
 rows.push({
 key: `p${pageObj.page}-l${lineIdx}-${rowIdxCounter++}`,
 page: pageObj.page,
 lineNum: lineIdx + 1,
 rawText,
 cols: [qr, dimStr, material],
 
 qr,
 material,
 width,
 height,
 thickness,
 quantity,

 // Tương thích ngược
 moduleCode: qr,
 name: qr,
 dimensions: `${width}x${height}x${thickness}`,
 notes: '',
 cluster: '',
 moduleName: qr,
 length: width
 });
 });
 });

 setParsedRows(rows);
 };

 // Re-trigger analysis when parser options change
 useEffect(() => {
 if (pdfPagesText.length > 0) {
 processLinesToRows(pdfPagesText);
 }
 }, [splitMethod, customSplitRegex, colMap, autoDetect]);

 // Handle inline editing
 const handleStartEdit = (row: ParsedRow) => {
 setEditingRowKey(row.key);
 setEditingData({ ...row });
 };

 const handleSaveEdit = (key: string) => {
 setParsedRows(prev => prev.map(r => {
 if (r.key === key) {
 return {
 ...r,
 ...editingData
 } as ParsedRow;
 }
 return r;
 }));
 setEditingRowKey(null);
 };

 const handleDeleteRow = (key: string) => {
 setParsedRows(prev => prev.filter(r => r.key !== key));
 };

 const handleAddNewRow = () => {
 const newKey = `new-${Date.now()}`;
 const newRow: ParsedRow = {
 key: newKey,
 page: 1,
 lineNum: parsedRows.length + 1,
 rawText: 'Dòng nhập tay',
 cols: [],
 
 qr: 'NEW_QR_CODE',
 material: 'MDF Veneer Walnut PU 2M',
 width: 1000,
 height: 600,
 thickness: 18,
 quantity: 1,

 // Compatibility fields
 moduleCode: 'NEW_QR_CODE',
 name: 'NEW_QR_CODE',
 dimensions: '1000x600x18',
 notes: '',
 cluster: '',
 moduleName: 'NEW_QR_CODE',
 length: 1000
 };
 setParsedRows(prev => [newRow, ...prev]);
 setEditingRowKey(newKey);
 setEditingData(newRow);
 };

 // Trigger spreadsheet download
 const handleDownloadXlsx = () => {
 if (parsedRows.length === 0) {
 alert('Không có dữ liệu để tải về.');
 return;
 }

 try {
 // Create custom neat headers matching Vietnamese localization requested
 const sheetData = parsedRows.map((r, i) => ({
 'STT': i + 1,
 'Trang': r.page,
 'Mã QR (qr)': r.qr || 'N/A',
 'Vật liệu (material)': r.material || 'N/A',
 'Chiều Rộng (width)': r.width || 0,
 'Chiều Cao (height)': r.height || 0,
 'Chiều Dày (thickness)': r.thickness || 18,
 'Số lượng': r.quantity,
 'Mẫu text gốc từ PDF': r.rawText
 }));

 const wb = XLSX.utils.book_new();
 const ws = XLSX.utils.json_to_sheet(sheetData);

 // Set nice column widths for the sheet
 const wscols = [
 { wch: 6 }, // STT
 { wch: 8 }, // Trang
 { wch: 35 }, // Mã QR
 { wch: 30 }, // Vật liệu
 { wch: 16 }, // Chiều Rộng
 { wch: 16 }, // Chiều Cao
 { wch: 14 }, // Chiều Dày
 { wch: 10 }, // Số lượng
 { wch: 55 }, // Mẫu text gốc
 ];
 ws['!cols'] = wscols;

 XLSX.utils.book_append_sheet(wb, ws, 'Dữ liệu PDF Trích xuất');
 const fileName = pdfFile 
 ? `Trích_xuất_${pdfFile.name.replace(/\.[^/.]+$/, "")}.xlsx` 
 : 'Trich_xuat_du_lieu_PDF.xlsx';
 
 XLSX.writeFile(wb, fileName);
 } catch (err: any) {
 alert(`Không thể tạo file Excel: ${err.message}`);
 }
 };

 // Filter parsed rows by lookup query
 const filteredRows = parsedRows.filter(r => {
 const q = searchQuery.toLowerCase();
 const mQr = (r.qr || '').toLowerCase();
 const mMat = (r.material || '').toLowerCase();
 return (
 mQr.includes(q) ||
 mMat.includes(q) ||
 r.rawText.toLowerCase().includes(q) ||
 String(r.width).includes(q) ||
 String(r.height).includes(q) ||
 String(r.thickness).includes(q) ||
 String(r.page).includes(q)
 );
 });

 return (
 <div className="min-h-screen bg-slate-100 text-slate-800 p-4 lg:p-8 flex flex-col font-sans" id="tools-screen">
 {/* Dynamic Header */}
 <div className="max-w-7xl mx-auto w-full mb-6">
 <div className="flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-200 pb-4">
 <div className="flex items-center space-x-3">
 <div className="bg-indigo-600 p-2.5 rounded-xl text-white shadow-md">
 <FileSpreadsheet size={24} />
 </div>
 <div>
 <h1 className="text-xl font-black text-slate-900 uppercase tracking-tight">Công Cụ Trích Xuất File PDF</h1>
 <p className="text-xs text-slate-500 font-bold uppercase tracking-wider">Hỗ trợ đọc dữ liệu bản vẽ kỹ thuật, danh sách chi tiết nhanh chóng</p>
 </div>
 </div>
 
 <div className="mt-4 md:mt-0 text-[11px] font-bold text-slate-400 bg-white border border-slate-200 px-3 py-1 rounded-full uppercase tracking-widest flex items-center gap-1.5 shadow-sm">
 <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
 <span>Chế độ: Độc lập liên kết URL</span>
 </div>
 </div>
 </div>

 <div className="max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1">
 
 {/* Left Control Panel / File Loader */}
 <div className="lg:col-span-1 space-y-4">
 <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
 <h2 className="text-xs font-black text-slate-900 uppercase tracking-wider border-b border-slate-100 pb-2 flex items-center gap-2">
 <Upload size={14} className="text-indigo-600" />
 <span>Nạp Tập Tin</span>
 </h2>

 {loadingPdfLib ? (
 <div className="py-6 text-center space-y-3">
 <RefreshCw size={24} className="animate-spin text-indigo-600 mx-auto" />
 <p className="text-[10px] text-slate-400 font-black uppercase tracking-wider">Đang khởi tạo thư viện đọc PDF...</p>
 </div>
 ) : pdfLibError ? (
 <div className="p-3 bg-rose-100 rounded-lg border border-rose-100 text-rose-600 space-y-2">
 <AlertTriangle size={18} className="mx-auto" />
 <p className="text-xs font-bold text-center leading-relaxed">{pdfLibError}</p>
 <button 
 onClick={() => window.location.reload()}
 className="w-full py-1.5 bg-rose-600 text-white font-black uppercase text-[10px] rounded hover:bg-rose-700 transition"
 >
 Tải Lại Trang
 </button>
 </div>
 ) : (
 <div 
 onDragOver={handleDragOver}
 onDragLeave={handleDragLeave}
 onDrop={handleDrop}
 onClick={() => fileInputRef.current?.click()}
 className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all ${
 isDragOver 
 ? 'border-indigo-600 bg-indigo-100/50 scale-95 shadow-inner' 
 : 'border-slate-200 hover:border-indigo-400 bg-slate-100'
 }`}
 >
 <input 
 type="file" 
 ref={fileInputRef}
 onChange={handleFileChange}
 accept=".pdf"
 className="hidden" 
 />
 <FileText size={40} className="mx-auto mb-3 text-slate-400" />
 <p className="text-xs text-slate-700 font-black uppercase tracking-tight mb-1">
 {pdfFile ? pdfFile.name : 'Kéo & Thả file PDF'}
 </p>
 <p className="text-[9px] text-slate-400 font-bold uppercase tracking-widest leading-relaxed">
 {pdfFile ? `${(pdfFile.size/1024/1024).toFixed(2)} MB` : 'Nhấp chuột để chọn tập tin'}
 </p>
 </div>
 )}

 {pdfFile && (
 <div className="p-3 bg-slate-100 rounded-lg border border-slate-100 space-y-2">
 <div className="flex justify-between text-[10px] font-black uppercase tracking-wider text-slate-500">
 <span>Trạng thái:</span>
 <span className="text-emerald-600 flex items-center gap-1">
 <CheckCircle2 size={10} /> Đang nạp
 </span>
 </div>
 <button
 onClick={() => {
 setPdfFile(null);
 setPdfPagesText([]);
 setParsedRows([]);
 }}
 className="w-full py-2 bg-slate-200 hover:bg-slate-300 transition text-[9px] font-black uppercase tracking-widest text-slate-700 rounded-sm"
 >
 Xóa Tài Liệu
 </button>
 </div>
 )}
 </div>

 {/* Config Parameters Panel */}
 <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
 <h2 className="text-xs font-black text-slate-900 uppercase tracking-wider border-b border-slate-100 pb-2 flex items-center gap-2">
 <Settings size={14} className="text-indigo-600" />
 <span>Cấu Hình Tách Cột</span>
 </h2>

 <div className="space-y-3">
 {/* Auto / Manual toggle */}
 <div className="flex items-center justify-between p-2.5 bg-slate-100 rounded border border-slate-100">
 <div className="flex flex-col">
 <span className="text-[10px] font-black uppercase text-slate-700">Tự Động Nhận Diện</span>
 <span className="text-[8px] text-slate-400 leading-none">Phân tích theo mẫu Draco</span>
 </div>
 <label className="relative inline-flex items-center cursor-pointer">
 <input 
 type="checkbox" 
 checked={autoDetect}
 onChange={(e) => setAutoDetect(e.target.checked)}
 className="sr-only peer" 
 />
 <div className="w-9 h-5 bg-slate-200 rounded-full peer peer-focus:ring-2 peer-focus:ring-indigo-300 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-indigo-600"></div>
 </label>
 </div>

 {!autoDetect && (
 <div className="space-y-3 pt-2">
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider block">Phương Pháp Tách:</label>
 <select 
 value={splitMethod}
 onChange={(e: any) => setSplitMethod(e.target.value)}
 className="w-full text-xs p-1.5 rounded border border-slate-200 bg-white focus:ring-1 focus:ring-indigo-500 outline-none"
 >
 <option value="double_space">Nhiều khoảng trắng liên tiếp</option>
 <option value="tab">Ký tự Tab (\t)</option>
 <option value="comma">Dấu phẩy (,)</option>
 <option value="semicolon">Dấu chấm phẩy (;)</option>
 <option value="pipe">Ký tự đứng (|)</option>
 <option value="regex">Regex Tùy chọn</option>
 </select>
 </div>

 {splitMethod === 'regex' && (
 <div className="space-y-1">
 <label className="text-[10px] font-black text-slate-500 uppercase tracking-wider block">Regular Expression (Regex split):</label>
 <input 
 type="text" 
 value={customSplitRegex}
 onChange={(e) => setCustomSplitRegex(e.target.value)}
 placeholder="\s{2,}"
 className="w-full text-xs font-mono p-1.5 rounded border border-slate-200 focus:ring-1 focus:ring-indigo-500 outline-none"
 />
 </div>
 )}

 {/* Mapping indices */}
 <div className="space-y-2 pt-2 border-t border-slate-100">
 <span className="text-[9px] font-black text-indigo-600 uppercase tracking-widest block">Chỉ số cột (Bắt đầu từ 0):</span>
 
 <div className="grid grid-cols-2 gap-2">
 <div className="space-y-0.5">
 <label className="text-[8px] font-bold uppercase text-slate-400">Cột Mã Module:</label>
 <input 
 type="number" 
 min={-1} 
 value={colMap.moduleCode} 
 onChange={(e) => setColMap(prev => ({ ...prev, moduleCode: parseInt(e.target.value) }))}
 className="w-full text-xs p-1 rounded border border-slate-200 text-center"
 />
 </div>
 <div className="space-y-0.5">
 <label className="text-[8px] font-bold uppercase text-slate-400">Cột Tên / Mô Tả:</label>
 <input 
 type="number" 
 min={-1} 
 value={colMap.name} 
 onChange={(e) => setColMap(prev => ({ ...prev, name: parseInt(e.target.value) }))}
 className="w-full text-xs p-1 rounded border border-slate-200 text-center"
 />
 </div>
 <div className="space-y-0.5">
 <label className="text-[8px] font-bold uppercase text-slate-400">Cột Kích Thước:</label>
 <input 
 type="number" 
 min={-1} 
 value={colMap.dimensions} 
 onChange={(e) => setColMap(prev => ({ ...prev, dimensions: parseInt(e.target.value) }))}
 className="w-full text-xs p-1 rounded border border-slate-200 text-center"
 />
 </div>
 <div className="space-y-0.5">
 <label className="text-[8px] font-bold uppercase text-slate-400">Cột Số Lượng:</label>
 <input 
 type="number" 
 min={-1} 
 value={colMap.quantity} 
 onChange={(e) => setColMap(prev => ({ ...prev, quantity: parseInt(e.target.value) }))}
 className="w-full text-xs p-1 rounded border border-slate-200 text-center"
 />
 </div>
 </div>
 </div>
 </div>
 )}
 <div className="p-3 bg-blue-100/50 rounded-lg text-slate-600 border border-blue-100 flex gap-2">
 <Info size={15} className="text-blue-500 shrink-0 mt-0.5" />
 <p className="text-[9px] leading-relaxed">
 <strong>Mẹo:</strong> Chế độ <strong>Tự Động</strong> sử dụng các thuật toán nhận diện thông minh để tự khớp kích thước, mã hàng và số lượng mà không cần căn cột thủ công.
 </p>
 </div>
 </div>
 </div>
 </div>

 {/* Right Main Table/Output panel */}
 <div className="lg:col-span-3 flex flex-col space-y-4">
 <div className="bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col flex-1 overflow-hidden min-h-[450px]">
 {/* Table Header Controls */}
 <div className="p-4 border-b border-slate-100 bg-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-3">
 <div className="flex items-center space-x-2">
 <button
 type="button"
 onClick={() => setActiveSubTab('table')}
 className={`px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer ${
 activeSubTab === 'table' 
 ? 'bg-indigo-600 text-white' 
 : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
 }`}
 >
 Bảng thông tin trích xuất ({filteredRows.length})
 </button>
 <button
 type="button"
 onClick={() => setActiveSubTab('raw')}
 className={`px-3 py-1.5 rounded text-[10px] font-black uppercase tracking-wider transition-all cursor-pointer ${
 activeSubTab === 'raw' 
 ? 'bg-indigo-600 text-white' 
 : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-100'
 }`}
 >
 Văn bản gốc PDF ({pdfPagesText.reduce((s, p) => s + p.lines.length, 0)} dòng)
 </button>
 </div>

 {parsedRows.length > 0 && activeSubTab === 'table' && (
 <div className="flex items-center gap-2">
 <div className="relative">
 <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
 <input 
 type="text" 
 placeholder="Tìm kiếm nhanh..." 
 value={searchQuery}
 onChange={(e) => setSearchQuery(e.target.value)}
 className="pl-8 pr-3 py-1.5 text-xs rounded border border-slate-200 w-44 md:w-56 outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 </div>
 
 <button 
 onClick={handleAddNewRow}
 className="p-1.5 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[10px] font-black uppercase rounded flex items-center gap-1 transition"
 >
 <Plus size={12} />
 <span>Thêm</span>
 </button>

 <button 
 onClick={handleDownloadXlsx}
 className="p-1.5 px-3 bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-black uppercase rounded flex items-center gap-1.5 transition shadow-sm cursor-pointer"
 >
 <Download size={13} />
 <span>Tải Excel</span>
 </button>
 </div>
 )}
 </div>

 {/* Display Body */}
 <div className="flex-1 overflow-auto max-h-[600px]">
 {parsing ? (
 <div className="py-20 text-center space-y-4">
 <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto"></div>
 <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">Đang quét, phân tách cấu trúc dữ liệu PDF...</p>
 </div>
 ) : parsedRows.length === 0 ? (
 <div className="py-24 text-center text-slate-400 space-y-3">
 <FileText size={48} className="mx-auto text-slate-300 stroke-[1.5]" />
 <div className="space-y-1">
 <p className="text-xs font-black uppercase tracking-wider text-slate-800">Chưa nạp hoặc xử lý được tài liệu PDF</p>
 <p className="text-[10px] font-medium leading-relaxed max-w-sm mx-auto">
 Vui lòng kéo & thả một file PDF hoặc chọn nút tải lên ở cột bên trái để bắt đầu đọc và trích xuất thông tin.
 </p>
 </div>
 </div>
 ) : activeSubTab === 'table' ? (
 /* Tabular info screen */
 <table className="w-full text-left border-collapse text-xs min-w-[750px]">
 <thead>
 <tr className="bg-slate-100/50 border-b border-slate-100 text-slate-400 text-[9px] font-black uppercase tracking-wider sticky top-0 bg-white">
 <th className="p-3 text-center w-12">STT</th>
 <th className="p-3 w-16 text-center">Trang</th>
 <th className="p-3">Mã QR (qr)</th>
 <th className="p-3">Vật liệu (material)</th>
 <th className="p-3 w-28 text-center">Chiều Rộng (width)</th>
 <th className="p-3 w-28 text-center">Chiều Cao (height)</th>
 <th className="p-3 w-24 text-center">Chiều Dày (thickness)</th>
 <th className="p-3 w-20 text-center">SL</th>
 <th className="p-3 w-24 text-center">Hành Động</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100">
 {filteredRows.length === 0 ? (
 <tr>
 <td colSpan={9} className="py-10 text-center text-slate-400 font-bold italic">
 Không tìm thấy kết quả nào khớp với tìm kiếm "{searchQuery}"
 </td>
 </tr>
 ) : (
 filteredRows.map((row, index) => {
 const isEditing = editingRowKey === row.key;
 return (
 <tr key={row.key} className="hover:bg-slate-100/50 transition">
 <td className="p-3 text-center text-[10px] font-black text-slate-400">{index + 1}</td>
 <td className="p-3 text-center font-bold text-indigo-600 bg-indigo-100/20 font-mono text-[10px] rounded-sm">{row.page}</td>
 
 {/* Mã QR */}
 <td className="p-3">
 {isEditing ? (
 <input 
 type="text" 
 value={editingData.qr || ''} 
 onChange={(e) => setEditingData(prev => ({ ...prev, qr: e.target.value, moduleCode: e.target.value, name: e.target.value, moduleName: e.target.value }))}
 className="w-full p-1 border border-slate-300 rounded text-xs font-bold font-mono outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 ) : (
 <span className="font-bold text-rose-600 font-mono text-xs block max-w-[280px] truncate" title={row.qr}>
 {row.qr}
 </span>
 )}
 </td>

 {/* Vật liệu */}
 <td className="p-3">
 {isEditing ? (
 <input 
 type="text" 
 value={editingData.material || ''} 
 onChange={(e) => setEditingData(prev => ({ ...prev, material: e.target.value }))}
 className="w-full p-1 border border-slate-300 rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 ) : (
 <span className="text-slate-700 font-medium text-xs block max-w-[200px] truncate" title={row.material}>
 {row.material}
 </span>
 )}
 </td>

 {/* Chiều Rộng */}
 <td className="p-3 text-center font-mono text-emerald-700 bg-slate-100/30">
 {isEditing ? (
 <input 
 type="number" 
 value={editingData.width || 0} 
 onChange={(e) => setEditingData(prev => ({ ...prev, width: parseFloat(e.target.value) || 0, length: parseFloat(e.target.value) || 0 }))}
 className="w-20 p-1 border border-slate-300 rounded font-mono text-xs text-center outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 ) : (
 <span className="font-semibold text-emerald-600">{row.width.toFixed(1)}</span>
 )}
 </td>

 {/* Chiều Cao */}
 <td className="p-3 text-center font-mono text-amber-700">
 {isEditing ? (
 <input 
 type="number" 
 value={editingData.height || 0} 
 onChange={(e) => setEditingData(prev => ({ ...prev, height: parseFloat(e.target.value) || 0 }))}
 className="w-20 p-1 border border-slate-300 rounded font-mono text-xs text-center outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 ) : (
 <span className="font-semibold text-amber-600">{row.height.toFixed(1)}</span>
 )}
 </td>

 {/* Chiều Dày */}
 <td className="p-3 text-center font-mono text-slate-700 bg-slate-100/30">
 {isEditing ? (
 <input 
 type="number" 
 value={editingData.thickness || 18} 
 onChange={(e) => setEditingData(prev => ({ ...prev, thickness: parseFloat(e.target.value) || 18 }))}
 className="w-16 p-1 border border-slate-300 rounded font-mono text-xs text-center outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 ) : (
 <span className="font-semibold text-slate-700">{row.thickness}</span>
 )}
 </td>

 {/* Số lượng */}
 <td className="p-3 text-center">
 {isEditing ? (
 <input 
 type="number" 
 min={1} 
 value={editingData.quantity || 1} 
 onChange={(e) => setEditingData(prev => ({ ...prev, quantity: parseInt(e.target.value) || 1 }))}
 className="w-14 p-1 border border-slate-300 rounded text-center text-xs outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
 />
 ) : (
 <span className="font-black bg-slate-900 text-white rounded-sm px-1.5 py-0.5 text-[10px] leading-none">
 {row.quantity}
 </span>
 )}
 </td>

 {/* Actions */}
 <td className="p-3 text-center">
 <div className="flex items-center justify-center space-x-1.5">
 {isEditing ? (
 <>
 <button 
 onClick={() => handleSaveEdit(row.key)}
 className="p-1 text-emerald-600 hover:bg-emerald-100 rounded transition"
 title="Lưu lại"
 >
 <Check size={14} />
 </button>
 <button 
 onClick={() => setEditingRowKey(null)}
 className="p-1 text-slate-400 hover:bg-slate-100 rounded transition"
 title="Hủy bỏ"
 >
 <AlertTriangle size={14} />
 </button>
 </>
 ) : (
 <>
 <button 
 onClick={() => handleStartEdit(row)}
 className="p-1 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 rounded transition"
 title="Chỉnh sửa dòng"
 >
 <Edit2 size={13} />
 </button>
 <button 
 onClick={() => handleDeleteRow(row.key)}
 className="p-1 text-slate-400 hover:text-rose-600 hover:bg-slate-100 rounded transition"
 title="Xóa dòng"
 >
 <Trash2 size={13} />
 </button>
 </>
 )}
 </div>
 </td>
 </tr>
 );
 })
 )}
 </tbody>
 </table>
 ) : (
 /* Raw Reconstruction lines view */
 <div className="p-4 space-y-4 max-h-[600px]">
 <div className="p-3.5 bg-indigo-100/50 rounded-lg text-slate-700 border border-indigo-100/50 flex gap-2">
 <Info size={16} className="text-indigo-600 shrink-0 mt-0.5" />
 <div>
 <h4 className="text-xs font-black uppercase text-indigo-900 mb-0.5">Dữ Liệu Văn Bản Tái Cấu Trúc Toàn Bộ PDF</h4>
 <p className="text-[10px] leading-relaxed text-slate-600">
 Hiển thị toàn bộ các đoạn text được khôi phục, tự sắp xếp các từ cùng một tọa độ hàng ngang từ trái qua phải, từ trên xuống dưới.
 </p>
 </div>
 </div>

 <div className="divide-y divide-slate-100 bg-white border border-slate-200 rounded overflow-hidden">
 {pdfPagesText.map((pageObj) => (
 <div key={pageObj.page} className="p-4 space-y-2">
 <div className="text-[10px] font-black uppercase tracking-widest text-indigo-600 flex items-center gap-1.5 border-b border-dashed border-slate-100 pb-1.5">
 <CheckCircle2 size={12} />
 <span>Trang {pageObj.page}</span>
 </div>
 <div className="space-y-1 font-mono text-[10px] text-slate-600 leading-normal">
 {pageObj.lines.map((lineObj, key) => (
 <div key={key} className="py-0.5 px-1.5 rounded hover:bg-slate-100 flex items-start gap-4">
 <span className="text-slate-400 select-none w-8 text-right font-black">L.{key + 1}</span>
 <span className="text-slate-800 break-all">{lineObj.text}</span>
 </div>
 ))}
 </div>
 </div>
 ))}
 </div>
 </div>
 )}
 </div>

 {/* Pagination / Total info */}
 {parsedRows.length > 0 && activeSubTab === 'table' && (
 <div className="p-3 bg-slate-100 border-t border-slate-100 text-[10px] text-slate-400 font-bold uppercase tracking-wider flex justify-between">
 <span>Tổng chi tiết phát hiện: {parsedRows.length} chi tiết</span>
 <span>Số lượng sản phẩm: {parsedRows.reduce((sum, r) => sum + r.quantity, 0)} cái</span>
 </div>
 )}
 </div>
 </div>

 </div>
 </div>
 );
}
