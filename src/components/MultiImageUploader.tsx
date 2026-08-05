import React, { useState, useRef } from 'react';
import { Camera, Image as ImageIcon, Trash2, X, Plus, Loader2 } from 'lucide-react';
import { uploadToCloudinary } from '../lib/cloudinary';
import { useAlert } from '../lib/AlertContext';

interface MultiImageUploaderProps {
 images: string[];
 onChange: (urls: string[]) => void;
 label?: string;
 maxImages?: number;
 disabled?: boolean;
}

export function MultiImageUploader({
 images = [],
 onChange,
 label = "Ảnh đính kèm",
 maxImages = 100,
 disabled = false,
}: MultiImageUploaderProps) {
 const { showError, showWarning } = useAlert();
 const [uploading, setUploading] = useState(false);
 const [progress, setProgress] = useState('');
 const [selectedPreview, setSelectedPreview] = useState<string | null>(null);
 const fileInputRef = useRef<HTMLInputElement>(null);

 const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
 const files = e.target.files;
 if (!files || files.length === 0) return;

 const fileArray = Array.from(files);
 
 // Check limit
 if (images.length + fileArray.length > maxImages) {
 showWarning(`Bạn chỉ được phép tải lên tối đa ${maxImages} hình ảnh.`);
 return;
 }

 setUploading(true);
 const newUploadedUrls: string[] = [];
 
 try {
 for (let i = 0; i < fileArray.length; i++) {
 setProgress(`Đang tải ảnh ${i + 1}/${fileArray.length}...`);
 const url = await uploadToCloudinary(fileArray[i]);
 if (url) {
 newUploadedUrls.push(url);
 }
 }

 if (newUploadedUrls.length > 0) {
 onChange([...images, ...newUploadedUrls]);
 } else {
 showError("Có lỗi xảy ra khi tải ảnh lên. Vui lòng chọn lại!");
 }
 } catch (err: any) {
 console.error(err);
 showError("Không thể tải ảnh lên. Vui lòng kiểm tra lại kết nối mạng!");
 } finally {
 setUploading(false);
 setProgress('');
 if (fileInputRef.current) {
 fileInputRef.current.value = '';
 }
 }
 };

 const handleRemoveImage = (indexToRemove: number, e: React.MouseEvent) => {
 e.stopPropagation();
 if (disabled) return;
 const nextImages = images.filter((_, idx) => idx !== indexToRemove);
 onChange(nextImages);
 };

 const triggerUpload = () => {
 if (disabled || uploading) return;
 fileInputRef.current?.click();
 };

 return (
 <div className="space-y-3 font-sans">
 <div className="flex items-center justify-between">
 <label className="text-xs font-black uppercase text-slate-500 tracking-wider">
 {label} ({images.length})
 </label>
 
 {!disabled && (
 <button
 type="button"
 onClick={triggerUpload}
 disabled={uploading}
 className="px-3 py-1.5 bg-indigo-100 text-indigo-600 text-xs font-bold border border-indigo-100 rounded-lg hover:bg-indigo-600 hover:text-white transition-all active:scale-95 flex items-center cursor-pointer gap-1.5"
 >
 {uploading ? (
 <Loader2 className="w-3.5 h-3.5 animate-spin" />
 ) : (
 <Camera className="w-3.5 h-3.5" />
 )}
 Chụp / Thêm ảnh
 </button>
 )}
 </div>

 <input
 type="file"
 ref={fileInputRef}
 onChange={handleFileChange}
 accept="image/*"
 multiple
 className="hidden"
 disabled={disabled}
 />

 {/* Uploading Status */}
 {uploading && (
 <div className="flex items-center gap-2 p-3 bg-indigo-100 text-indigo-700 border border-indigo-100 rounded-lg text-xs font-bold animate-pulse">
 <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
 <span>{progress || 'Đang xử lý tải hình ảnh lên...'}</span>
 </div>
 )}

 {/* Grid view of images */}
 {images.length === 0 ? (
 <div 
 onClick={!disabled ? triggerUpload : undefined}
 className={`flex flex-col items-center justify-center p-6 border-2 border-dashed border-slate-200 rounded-lg bg-slate-100/50 text-slate-400 ${!disabled ? 'cursor-pointer hover:bg-slate-100 hover:border-indigo-300' : ''} transition-colors`}
 >
 <ImageIcon className="w-8 h-8 mb-2 text-slate-300" />
 <span className="text-xs font-bold">{disabled ? 'Không có hình ảnh' : 'Chưa có ảnh. Click để chụp hoặc chọn tệp'}</span>
 </div>
 ) : (
 <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
 {images.map((url, idx) => (
 <div
 key={idx}
 onClick={() => setSelectedPreview(url)}
 className="group relative aspect-square rounded-lg border border-slate-100 overflow-hidden bg-slate-100 cursor-pointer shadow-xs hover:border-indigo-500 transition-colors"
 >
 <img
 src={url}
 alt={`Uploaded asset ${idx + 1}`}
 className="w-full h-full object-cover"
 referrerPolicy="no-referrer"
 />
 
 {!disabled && (
 <button
 type="button"
 onClick={(e) => handleRemoveImage(idx, e)}
 className="absolute top-1 right-1 p-1 bg-rose-500/90 text-white rounded-lg hover:bg-rose-600 transition-all active:scale-90"
 >
 <Trash2 className="w-3.5 h-3.5" />
 </button>
 )}
 </div>
 ))}
 
 {!disabled && images.length < maxImages && (
 <div
 onClick={triggerUpload}
 className="flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-lg aspect-square hover:bg-slate-100 hover:border-indigo-300 transition-colors cursor-pointer text-slate-400 hover:text-indigo-600"
 >
 <Plus className="w-6 h-6 mb-1" />
 <span className="text-[10px] font-bold">Thêm ảnh</span>
 </div>
 )}
 </div>
 )}

 {/* Lightbox Preview */}
 {selectedPreview && (
 <div className="fixed inset-0 z-[20000] flex items-center justify-center p-4 bg-slate-900/90 backdrop-blur-xs">
 <button
 onClick={() => setSelectedPreview(null)}
 className="absolute top-4 right-4 p-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg transition-colors cursor-pointer"
 >
 <X className="w-5 h-5" />
 </button>
 <div className="max-w-4xl max-h-[85vh] overflow-hidden rounded-lg">
 <img
 src={selectedPreview}
 alt="Preview full"
 className="w-full h-full object-contain max-h-[85vh]"
 referrerPolicy="no-referrer"
 />
 </div>
 </div>
 )}
 </div>
 );
}
