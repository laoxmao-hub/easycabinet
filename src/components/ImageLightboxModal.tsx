import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronLeft, ChevronRight, X, ZoomIn } from 'lucide-react';

interface ImageLightboxModalProps {
 images: string[];
 startIndex: number;
 isOpen: boolean;
 onClose: () => void;
}

export const ImageLightboxModal: React.FC<ImageLightboxModalProps> = ({
 images,
 startIndex = 0,
 isOpen,
 onClose
}) => {
 const [currentIndex, setCurrentIndex] = useState(startIndex);

 useEffect(() => {
 setCurrentIndex(startIndex);
 }, [startIndex]);

 useEffect(() => {
 const handleKeyDown = (e: KeyboardEvent) => {
 if (!isOpen) return;
 if (e.key === 'ArrowLeft') {
 handlePrev();
 } else if (e.key === 'ArrowRight') {
 handleNext();
 } else if (e.key === 'Escape') {
 onClose();
 }
 };
 window.addEventListener('keydown', handleKeyDown);
 return () => window.removeEventListener('keydown', handleKeyDown);
 }, [isOpen, currentIndex, images]);

 const handlePrev = (e?: React.MouseEvent) => {
 e?.stopPropagation();
 if (images.length <= 1) return;
 setCurrentIndex((prev) => (prev - 1 + images.length) % images.length);
 };

 const handleNext = (e?: React.MouseEvent) => {
 e?.stopPropagation();
 if (images.length <= 1) return;
 setCurrentIndex((prev) => (prev + 1) % images.length);
 };

 if (!isOpen || images.length === 0) return null;

 return (
 <AnimatePresence>
 <div 
 className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/90 backdrop-blur-md select-none"
 onClick={onClose}
 >
 {/* Top bar */}
 <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between text-white bg-gradient-to-b from-black/60 to-transparent z-10">
 <div className="flex items-center gap-2">
 <ZoomIn size={18} className="text-indigo-400" />
 <span className="text-xs font-black uppercase tracking-wider font-mono">
 Ảnh {currentIndex + 1} / {images.length}
 </span>
 </div>
 <button
 onClick={onClose}
 className="p-2 hover:bg-white/10 rounded-full transition-all text-gray-300 hover:text-white cursor-pointer active:scale-95"
 >
 <X size={24} />
 </button>
 </div>

 {/* Content Image Container */}
 <div className="relative w-full max-w-4xl h-full flex items-center justify-center p-4">
 {images.length > 1 && (
 <button
 onClick={handlePrev}
 className="absolute left-4 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 shrink-0 z-20 cursor-pointer active:scale-95"
 title="Ảnh trước"
 >
 <ChevronLeft size={28} />
 </button>
 )}

 <motion.img
 key={currentIndex}
 initial={{ opacity: 0, scale: 0.95 }}
 animate={{ opacity: 1, scale: 1 }}
 exit={{ opacity: 0, scale: 0.95 }}
 transition={{ duration: 0.15 }}
 src={images[currentIndex]}
 alt={`Ảnh lỗi QC ${currentIndex + 1}`}
 className="max-w-full max-h-[82vh] object-contain rounded-lg shadow-2xl border border-white/5"
 onClick={(e) => e.stopPropagation()}
 referrerPolicy="no-referrer"
 />

 {images.length > 1 && (
 <button
 onClick={handleNext}
 className="absolute right-4 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full transition-all border border-white/10 shrink-0 z-20 cursor-pointer active:scale-95"
 title="Ảnh tiếp"
 >
 <ChevronRight size={28} />
 </button>
 )}
 </div>

 {/* Thumbnails list below */}
 {images.length > 1 && (
 <div 
 className="absolute bottom-6 flex gap-2 max-w-[85vw] overflow-x-auto py-2 px-4 bg-black/40 backdrop-blur-sm rounded-full border border-white/5 custom-scrollbar"
 onClick={(e) => e.stopPropagation()}
 >
 {images.map((img, i) => (
 <img
 key={i}
 src={img}
 alt=""
 className={`w-9 h-9 object-cover rounded-md cursor-pointer border transition-all ${
 i === currentIndex ? 'border-indigo-500 scale-105 ring-2 ring-indigo-500/30' : 'border-white/10 opacity-60 hover:opacity-100'
 }`}
 onClick={() => setCurrentIndex(i)}
 referrerPolicy="no-referrer"
 />
 ))}
 </div>
 )}
 </div>
 </AnimatePresence>
 );
};
