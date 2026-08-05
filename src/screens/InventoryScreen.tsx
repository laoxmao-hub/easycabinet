/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
 Boxes, Plus, Search, Filter, Trash2, Package, Loader2, Save, X, 
 BarChart3, ArrowDownLeft, ArrowUpRight, History, Download, Printer, 
 User, CheckCircle2, AlertTriangle, Building, FileText, Info, Coins, Tag, RefreshCw,
 FileSpreadsheet, Upload, CheckSquare, Eye, Edit3, Power
} from 'lucide-react';
import { 
 collection, addDoc, serverTimestamp, deleteDoc, doc, updateDoc, 
 onSnapshot, query, orderBy, limit, getDocs, writeBatch, where 
} from 'firebase/firestore';
import { useAuth } from '../lib/AuthContext';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { ProjectEntry, Accessory } from '../types';
import { batchUpdateProjectModules } from '../lib/dualWrite';
import { formatProjectCode } from '../lib/formatters';
import * as XLSX from 'xlsx';

// Định nghĩa types cho Module Quản Lý Kho
export interface Material {
 id?: string;
 code: string;
 name: string;
 unit: string;
 category: string;
 currentStock: number;
 minStock: number;
 note?: string;
 status: 'active' | 'inactive';
 createdAt: any;
}

export interface StockTransaction {
 id?: string;
 materialId: string;
 materialName: string;
 materialCode: string;
 unit: string;
 type: 'IMPORT' | 'EXPORT' | 'IMPORT_INITIAL' | 'STOCK_TAKE' | 'EXPORT_REQUEST';
 quantity: number; // Có thể âm/dương tùy giao dịch
 stockBefore: number;
 stockAfter: number;
 projectId?: string;
 note?: string;
 createdBy: string;
 createdByEmail: string;
 createdAt: any;
}

export interface StockReceipt {
 id?: string;
 receiptCode: string;
 supplier: string;
 items: {
 materialId: string;
 materialName: string;
 materialCode: string;
 quantity: number;
 unit: string;
 }[];
 createdBy: string;
 createdAt: any;
}

export interface StockIssue {
 id?: string;
 issueCode: string;
 projectId: string;
 items: {
 materialId: string;
 materialName: string;
 materialCode: string;
 quantity: number;
 unit: string;
 }[];
 createdBy: string;
 createdAt: any;
}

interface InventoryScreenProps {
 items: any[]; // Giữ nguyên prop của App.tsx để tránh lỗi biên dịch
 projectEntries: ProjectEntry[];
 loading: boolean;
}

const MATERIAL_CATEGORIES = [
 'Ván',
 'Laminate',
 'Chỉ PVC',
 'Phụ kiện',
 'Keo',
 'Thiết bị điện',
 'Khác'
];

export function InventoryScreen({ projectEntries, loading: parentLoading }: InventoryScreenProps) {
 const { user, role, roles, userProfile, hasRole } = useAuth();
 
 // Kiểm tra quyền hạn
 const isKeeper = hasRole('admin') || 
 (hasRole('mod_x2') && userProfile?.chuc_danh?.toLowerCase()?.includes('thủ kho')) ||
 userProfile?.chuc_danh?.toLowerCase()?.includes('thủ kho');

 const isProduction = hasRole('mod_x1') || 
 userProfile?.chuc_danh?.toLowerCase()?.includes('sản xuất');

 const isAccountant = hasRole('manager') || 
 userProfile?.chuc_danh?.toLowerCase()?.includes('kế toán');

 // Quản lý tab
 const [activeTab, setActiveTab] = useState<'dashboard' | 'materials' | 'import' | 'export' | 'requests' | 'stocktake' | 'history' | 'bom'>('dashboard');

 // States cho tab Vật tư BOM
 const [bomSearchTerm, setBomSearchTerm] = useState('');
 const [bomStatusFilter, setBomStatusFilter] = useState<'all' | 'insufficient' | 'sufficient'>('all');

 // Real-time Collections States
 const [materials, setMaterials] = useState<Material[]>([]);
 const [loadingMaterials, setLoadingMaterials] = useState(true);
 const [transactions, setTransactions] = useState<StockTransaction[]>([]);
 const [loadingTransactions, setLoadingTransactions] = useState(true);
 const [stockRequests, setStockRequests] = useState<any[]>([]);
 const [loadingRequests, setLoadingRequests] = useState(true);

 // States tìm kiếm/lọc
 const [searchTerm, setSearchTerm] = useState('');
 const [categoryFilter, setCategoryFilter] = useState<string>('all');
 const [historySearch, setHistorySearch] = useState('');
 const [historyTypeFilter, setHistoryTypeFilter] = useState<string>('all');

 // States Form Thêm/Sửa vật tư
 const [showMaterialModal, setShowMaterialModal] = useState(false);
 const [editingMaterial, setEditingMaterial] = useState<Material | null>(null);
 const [matName, setMatName] = useState('');
 const [matUnit, setMatUnit] = useState('Khung');
 const [matCategory, setMatCategory] = useState('Ván');
 const [matMinStock, setMatMinStock] = useState<number>(5);
 const [matNote, setMatNote] = useState('');
 const [matInitialStock, setMatInitialStock] = useState<number>(0);

 // States Lập phiếu Nhập kho (Multi-item)
 const [receiptSupplier, setReceiptSupplier] = useState('');
 const [receiptItems, setReceiptItems] = useState<{ materialId: string; quantity: number }[]>([
 { materialId: '', quantity: 1 }
 ]);

 // States Lập phiếu Xuất kho (Multi-item)
 const [issueProjectId, setIssueProjectId] = useState('');
 const [issueItems, setIssueItems] = useState<{ materialId: string; quantity: number }[]>([
 { materialId: '', quantity: 1 }
 ]);

 // States Kiểm Kê Kho (Stock-take)
 const [selectedStockTakeMatId, setSelectedStockTakeMatId] = useState('');
 const [actualStockInput, setActualStockInput] = useState<number>(0);
 const [stockTakeNote, setStockTakeNote] = useState('');

 // States Import Excel trực tiếp
 const [excelImportFile, setExcelImportFile] = useState<File | null>(null);
 const excelFileInputRef = useRef<HTMLInputElement>(null);
 const [excelImportResult, setExcelImportResult] = useState<{
 total: number;
 success: number;
 fail: number;
 errors: string[];
 } | null>(null);

 // Phản hồi người dùng
 const [feedback, setFeedback] = useState<{ success: boolean; msg: string } | null>(null);
 const [isSubmitting, setIsSubmitting] = useState(false);

 const triggerFeedback = (success: boolean, msg: string) => {
 setFeedback({ success, msg });
 setTimeout(() => setFeedback(null), 5000);
 };

 // 1. Tải danh mục vật tư real-time
 useEffect(() => {
 setLoadingMaterials(true);
 const q = query(collection(db, 'materials'), orderBy('createdAt', 'desc'));
 const unsubscribe = onSnapshot(q, (snapshot) => {
 const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Material));
 setMaterials(list);
 setLoadingMaterials(false);
 }, (err) => {
 console.error("Lỗi khi tải danh mục vật tư:", err);
 setLoadingMaterials(false);
 });
 return () => unsubscribe();
 }, []);

 // 2. Tải lịch sử giao dịch real-time
 useEffect(() => {
 setLoadingTransactions(true);
 const q = query(collection(db, 'stockTransactions'), orderBy('createdAt', 'desc'), limit(150));
 const unsubscribe = onSnapshot(q, (snapshot) => {
 const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as StockTransaction));
 setTransactions(list);
 setLoadingTransactions(false);
 }, (err) => {
 console.error("Lỗi khi tải lịch sử giao dịch:", err);
 setLoadingTransactions(false);
 });
 return () => unsubscribe();
 }, []);

 // 3. Tải danh sách yêu cầu xuất phụ kiện dự án (export_proposals)
 useEffect(() => {
 setLoadingRequests(true);
 const q = query(collection(db, 'export_proposals'), orderBy('createdAt', 'desc'));
 const unsubscribe = onSnapshot(q, (snapshot) => {
 const list = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
 setStockRequests(list);
 setLoadingRequests(false);
 }, (err) => {
 console.error("Lỗi khi tải yêu cầu xuất phụ kiện từ export_proposals:", err);
 setLoadingRequests(false);
 });
 return () => unsubscribe();
 }, []);

 // Sync tab restriction based on role
 useEffect(() => {
 if (isProduction && activeTab !== 'dashboard' && activeTab !== 'materials' && activeTab !== 'requests' && activeTab !== 'bom') {
 setActiveTab('materials');
 }
 if (isAccountant && activeTab !== 'dashboard' && activeTab !== 'materials' && activeTab !== 'history' && activeTab !== 'bom') {
 setActiveTab('dashboard');
 }
 }, [role, isProduction, isAccountant, activeTab]);

 // Tạo mã phiếu ngẫu nhiên/theo cấu trúc thời gian
 const generateTicketCode = (prefix: 'PN' | 'PX') => {
 const d = new Date();
 const yyyymmdd = d.getFullYear().toString() + 
 (d.getMonth() + 1).toString().padStart(2, '0') + 
 d.getDate().toString().padStart(2, '0');
 const timeRef = d.getHours().toString().padStart(2, '0') + d.getSeconds().toString().padStart(2, '0');
 return `${prefix}-${yyyymmdd}-${timeRef}`;
 };

 // --- THÊM HOẶC CẬP NHẬT VẬT TƯ ---
 const handleSaveMaterial = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!isKeeper) {
 alert("Bạn không có quyền quản lý vật tư!");
 return;
 }

 if (!matName.trim()) {
 alert("Tên vật tư không được để trống!");
 return;
 }

 // Kiểm tra trùng tên vật tư
 const existingSameName = materials.find(m => 
 m.name.trim().toLowerCase() === matName.trim().toLowerCase() && 
 (!editingMaterial || m.id !== editingMaterial.id)
 );
 if (existingSameName) {
 alert("Tên vật tư này đã tồn tại trong danh mục trung tâm!");
 return;
 }

 setIsSubmitting(true);
 try {
 if (editingMaterial) {
 // CẬP NHẬT
 await updateDoc(doc(db, 'materials', editingMaterial.id!), {
 name: matName.trim(),
 unit: matUnit,
 category: matCategory,
 minStock: Number(matMinStock) || 0,
 note: matNote.trim()
 });

 triggerFeedback(true, "Cập nhật thông tin vật tư thành công!");
 } else {
 // THÊM MỚI
 // Tính mã vật tư tự tăng
 let maxNum = 0;
 materials.forEach(m => {
 const numPart = m.code?.replace('MAT-', '');
 const val = parseInt(numPart, 10);
 if (!isNaN(val) && val > maxNum) {
 maxNum = val;
 }
 });
 const nextCode = `MAT-${String(maxNum + 1).padStart(5, '0')}`;

 const newMatRef = doc(collection(db, 'materials'));
 const initialQty = Number(matInitialStock) || 0;

 await updateDoc(newMatRef, {
 code: nextCode,
 name: matName.trim(),
 unit: matUnit,
 category: matCategory,
 currentStock: initialQty,
 minStock: Number(matMinStock) || 0,
 note: matNote.trim(),
 status: 'active',
 createdAt: new Date().toISOString()
 });

 // Nếu có tồn khai sinh ban đầu, sinh ngay một giao dịch IMPORT_INITIAL
 if (initialQty > 0) {
 await addDoc(collection(db, 'stockTransactions'), {
 materialId: newMatRef.id,
 materialName: matName.trim(),
 materialCode: nextCode,
 unit: matUnit,
 type: 'IMPORT_INITIAL',
 quantity: initialQty,
 stockBefore: 0,
 stockAfter: initialQty,
 note: 'Khởi sinh số lượng tồn kho ban đầu khi tạo mã vật tư',
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'vattu@system.com',
 createdAt: new Date().toISOString()
 });
 }

 triggerFeedback(true, "Khai báo mã vật tư trung tâm thành công!");
 }

 // Đóng modal & dọn dẹp
 setShowMaterialModal(false);
 setEditingMaterial(null);
 setMatName('');
 setMatUnit('Khung');
 setMatCategory('Ván');
 setMatMinStock(5);
 setMatNote('');
 setMatInitialStock(0);
 } catch (err: any) {
 console.error(err);
 triggerFeedback(false, "Thao tác thất bại: " + err.message);
 } finally {
 setIsSubmitting(false);
 }
 };

 const handleEditMaterialClick = (mat: Material) => {
 setEditingMaterial(mat);
 setMatName(mat.name);
 setMatUnit(mat.unit);
 setMatCategory(mat.category);
 setMatMinStock(mat.minStock);
 setMatNote(mat.note || '');
 setMatInitialStock(mat.currentStock);
 setShowMaterialModal(true);
 };

 const toggleMaterialStatus = async (mat: Material) => {
 if (!isKeeper) {
 alert("Bạn không có quyền ngừng sử dụng vật tư!");
 return;
 }
 const nextStatus = mat.status === 'active' ? 'inactive' : 'active';
 const statusLabel = nextStatus === 'active' ? 'kích hoạt lại' : 'ngừng sử dụng';
 if (!confirm(`Xác nhận ${statusLabel} vật tư "${mat.name}"?`)) return;

 try {
 await updateDoc(doc(db, 'materials', mat.id!), {
 status: nextStatus
 });
 triggerFeedback(true, `Đã thay đổi trạng thái vật tư thành "${nextStatus}" thành công!`);
 } catch (e: any) {
 alert("Lỗi: " + e.message);
 }
 };

 // --- THỰC HIỆN NHẬP KHO (PHIẾU NHẬP) ---
 const handleReceiptItemChange = (idx: number, field: 'materialId' | 'quantity', value: any) => {
 const list = [...receiptItems];
 if (field === 'quantity') {
 list[idx].quantity = Math.max(1, Number(value) || 1);
 } else {
 list[idx].materialId = value;
 }
 setReceiptItems(list);
 };

 const handleCreateReceipt = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!isKeeper) return;

 if (!receiptSupplier.trim()) {
 alert("Vui lòng cung cấp tên Nhà cung cấp!");
 return;
 }

 if (receiptItems.some(i => !i.materialId)) {
 alert("Chưa chọn vật tư cần nhập ở một số dòng!");
 return;
 }

 setIsSubmitting(true);
 try {
 const ticketCode = generateTicketCode('PN');
 const batch = writeBatch(db);
 const invoiceItems: any[] = [];
 const transList: any[] = [];

 for (const rItem of receiptItems) {
 const mat = materials.find(m => m.id === rItem.materialId);
 if (!mat) continue;

 const stockBefore = mat.currentStock || 0;
 const stockAfter = stockBefore + rItem.quantity;

 // 1. Cập nhật số tồn
 batch.update(doc(db, 'materials', mat.id!), {
 currentStock: stockAfter
 });

 invoiceItems.push({
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 quantity: rItem.quantity,
 unit: mat.unit
 });

 // 2. Gom giao dịch
 transList.push({
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 unit: mat.unit,
 type: 'IMPORT',
 quantity: rItem.quantity,
 stockBefore,
 stockAfter,
 note: `Nhập kho theo phiếu ${ticketCode} từ NCC: ${receiptSupplier}`,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'admin@vattu.com',
 createdAt: new Date().toISOString()
 });
 }

 // 3. Tạo phiếu nhập trong stockReceipts
 const receiptRef = doc(collection(db, 'stockReceipts'));
 batch.set(receiptRef, {
 receiptCode: ticketCode,
 supplier: receiptSupplier.trim(),
 items: invoiceItems,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdAt: new Date().toISOString()
 });

 // 4. Tạo giao dịch biến động
 transList.forEach(tx => {
 const txRef = doc(collection(db, 'stockTransactions'));
 batch.set(txRef, tx);
 });

 // Commit toàn bộ
 await batch.commit();

 // Log hoạt động chung
 await addDoc(collection(db, 'activities'), {
 userId: userProfile?.uid || 'system',
 userName: userProfile?.displayName || 'Thủ kho',
 userEmail: userProfile?.email || 'admin@vattu.com',
 action: 'Lập phiếu nhập kho',
 details: `Đã lập thành công phiếu nhập kho ${ticketCode} từ NCC: ${receiptSupplier}. Tổng loại vật tư: ${invoiceItems.length}`,
 projectCode: 'KHO_VATTU',
 timestamp: serverTimestamp()
 });

 triggerFeedback(true, `Lập phiếu nhập kho ${ticketCode} thành công! Tồn kho đã tăng tương ứng.`);
 
 // Reset form
 setReceiptSupplier('');
 setReceiptItems([{ materialId: '', quantity: 1 }]);
 } catch (err: any) {
 console.error(err);
 triggerFeedback(false, "Lỗi nhập kho: " + err.message);
 } finally {
 setIsSubmitting(false);
 }
 };

 // --- THỰC HIỆN XUẤT KHO (PHIẾU XUẤT) ---
 const handleIssueItemChange = (idx: number, field: 'materialId' | 'quantity', value: any) => {
 const list = [...issueItems];
 if (field === 'quantity') {
 list[idx].quantity = Math.max(1, Number(value) || 1);
 } else {
 list[idx].materialId = value;
 }
 setIssueItems(list);
 };

 const handleCreateIssue = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!isKeeper) return;

 if (!issueProjectId) {
 alert("Vui lòng chọn Dự án thụ hưởng vật tư!");
 return;
 }

 if (issueItems.some(i => !i.materialId)) {
 alert("Chưa lựa chọn vật tư ở một chỉnh dòng!");
 return;
 }

 // Kiểm tra tính đầy đủ của số tồn kho
 for (const iItem of issueItems) {
 const mat = materials.find(m => m.id === iItem.materialId);
 if (!mat) continue;
 if (mat.currentStock < iItem.quantity) {
 alert(`Kho không đủ vật tư "${mat.name}". Hiện tại chỉ còn ${mat.currentStock} ${mat.unit}, yêu cầu xuất là ${iItem.quantity}. Vui lòng kiểm tra lại.`);
 return;
 }
 }

 setIsSubmitting(true);
 try {
 const ticketCode = generateTicketCode('PX');
 const batch = writeBatch(db);
 const detailsList: any[] = [];
 const transList: any[] = [];

 for (const iItem of issueItems) {
 const mat = materials.find(m => m.id === iItem.materialId);
 if (!mat) continue;

 const stockBefore = mat.currentStock;
 const stockAfter = Math.max(0, stockBefore - iItem.quantity);

 // 1. Trừ số tồn
 batch.update(doc(db, 'materials', mat.id!), {
 currentStock: stockAfter
 });

 detailsList.push({
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 quantity: iItem.quantity,
 unit: mat.unit
 });

 // 2. Gom giao dịch
 transList.push({
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 unit: mat.unit,
 type: 'EXPORT',
 quantity: iItem.quantity,
 stockBefore,
 stockAfter,
 note: `Xuất dự án ${issueProjectId} theo phiếu ${ticketCode}`,
 projectId: issueProjectId,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'admin@vattu.com',
 createdAt: new Date().toISOString()
 });
 }

 // 3. Tạo phiếu xuất
 const issueRef = doc(collection(db, 'stockIssues'));
 batch.set(issueRef, {
 issueCode: ticketCode,
 projectId: issueProjectId,
 items: detailsList,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdAt: new Date().toISOString()
 });

 // 4. Lưu giao dịch
 transList.forEach(tx => {
 const txRef = doc(collection(db, 'stockTransactions'));
 batch.set(txRef, tx);
 });

 await batch.commit();

 // Log hoạt động chung
 await addDoc(collection(db, 'activities'), {
 userId: userProfile?.uid || 'system',
 userName: userProfile?.displayName || 'Thủ kho',
 userEmail: userProfile?.email || 'admin@vattu.com',
 action: 'Lập phiếu xuất kho',
 details: `Đã hoàn tất xuất kho phiếu ${ticketCode} cho dự án ${issueProjectId}. Số lượng các loại vật tư: ${detailsList.length}`,
 projectCode: issueProjectId,
 timestamp: serverTimestamp()
 });

 triggerFeedback(true, `Phát hành phiếu xuất kho ${ticketCode} hoàn tất. Tồn kho đã trừ tương ứng.`);
 
 // Reset form
 setIssueProjectId('');
 setIssueItems([{ materialId: '', quantity: 1 }]);
 } catch (err: any) {
 console.error(err);
 triggerFeedback(false, "Lỗi khi xuất kho: " + err.message);
 } finally {
 setIsSubmitting(false);
 }
 };

 // --- DUYỆT YÊU CẦU XUẤT KHO PHỤ KIỆN (FROM PRODUCTION SQUAD) ---
 const handleApproveStockRequest = async (req: any) => {
 if (!isKeeper) {
 alert("Chỉ thủ kho được duyệt yêu cầu xuất!");
 return;
 }

 // Kiểm tra tồn kho trước khi duyệt
 const insufficientList: string[] = [];
 for (const reqItem of req.items) {
 const itemName = reqItem.name || reqItem.materialName;
 const mat = materials.find(m => m.name.trim().toLowerCase() === itemName.trim().toLowerCase());
 if (!mat || mat.currentStock < reqItem.quantity) {
 insufficientList.push(itemName);
 }
 }

 if (insufficientList.length > 0) {
 alert(`Không thể duyệt xuất! Kho tổng thiếu các vật tư: ${insufficientList.join(', ')}. Xin kiểm kho hoặc bổ sung hàng trước.`);
 return;
 }

 if (!confirm("Xác nhận DUYỆT xuất kho cho yêu cầu này? Số lượng tồn kho trung tâm sẽ được tự trừ.")) return;

 setIsSubmitting(true);
 try {
 const batch = writeBatch(db);
 const accProjectUpdates: { moduleId: string; data: Record<string, any>; projectCode?: string }[] = [];
 const ticketCode = generateTicketCode('PX');
 const invoiceItems: any[] = [];
 const transList: any[] = [];

 // 1. Duyệt trừ tồn kho materials và tạo transactions
 for (const reqItem of req.items) {
 const itemName = reqItem.name || reqItem.materialName;
 const mat = materials.find(m => m.name.trim().toLowerCase() === itemName.trim().toLowerCase())!;
 const stockBefore = mat.currentStock;
 const stockAfter = Math.max(0, stockBefore - reqItem.quantity);

 batch.update(doc(db, 'materials', mat.id!), {
 currentStock: stockAfter
 });

 invoiceItems.push({
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 quantity: reqItem.quantity,
 unit: mat.unit
 });

 transList.push({
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 unit: mat.unit,
 type: 'EXPORT_REQUEST',
 quantity: reqItem.quantity,
 stockBefore,
 stockAfter,
 note: `Duyệt xuất tự động theo yêu cầu lắp ráp dự án ${req.projectCode || req.projectId}`,
 projectId: req.projectCode || req.projectId,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'admin@vattu.com',
 createdAt: new Date().toISOString()
 });
 }

 // 2. Tạo phiếu xuất chứng từ
 const issueRef = doc(collection(db, 'stockIssues'));
 batch.set(issueRef, {
 issueCode: ticketCode,
 projectId: req.projectCode || req.projectId,
 items: invoiceItems,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdAt: new Date().toISOString()
 });

 // 3. Thêm transactions
 transList.forEach(tx => {
 const txRef = doc(collection(db, 'stockTransactions'));
 batch.set(txRef, tx);
 });

 // 4. Đồng bộ cập nhật trạng thái export_proposals
 batch.update(doc(db, 'export_proposals', req.id), {
 status: 'approved',
 approvedBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 approvedAt: new Date().toISOString()
 });

 // 5. Tìm các module dự án trong projects để phân phối số lượng đã xuất lắp đặt
 // Tìm các module gắn với DA của request phụ kiện này
 try {
 const projQuery = collection(db, 'projectConfigs', req.projectCode || req.projectId, 'modules');
 const projSnap = await getDocs(projQuery);
 for (const projDoc of projSnap.docs) {
 const entry = projDoc.data() as ProjectEntry;
 const currentAccessories = entry.accessories || [];
 let hasChange = false;

 const updatedAccessories = currentAccessories.map(acc => {
 const matchReqItem = req.items.find((ri: any) => (ri.name || ri.materialName).trim().toLowerCase() === acc.name.trim().toLowerCase());
 if (matchReqItem) {
 const prevIssued = acc.issuedQuantity || 0;
 const newIssued = prevIssued + matchReqItem.quantity;
 hasChange = true;
 return {
 ...acc,
 issuedQuantity: newIssued,
 status: newIssued >= (acc.quantity || 0) ? 'Xuất kho lắp ráp' : 'Đang xử lý xuất hàng'
 };
 }
 return acc;
 });

 if (hasChange) {
 accProjectUpdates.push({ moduleId: projDoc.id, data: { accessories: updatedAccessories, updatedAt: serverTimestamp() }, projectCode: req.projectCode || req.projectId });
 }
 }
 } catch (e) {
 console.error("Lỗi đồng bộ phân phối accessories dự án:", e);
 }

 await batch.commit();
 if (accProjectUpdates.length > 0) {
 await batchUpdateProjectModules(accProjectUpdates);
 }

 // Log hoạt động chung
 await addDoc(collection(db, 'activities'), {
 userId: userProfile?.uid || 'system',
 userName: userProfile?.displayName || 'Thủ kho',
 userEmail: userProfile?.email || 'admin@vattu.com',
 action: 'Duyệt yêu cầu phụ kiện',
 details: `Đã phê duyệt và xuất kho ${ticketCode} cho yêu cầu phụ kiện của ${req.createdByName || req.requestedBy} lắp ráp tại dự án ${req.projectCode || req.projectId}`,
 projectCode: req.projectCode || req.projectId,
 timestamp: serverTimestamp()
 });

 triggerFeedback(true, `Đã phê duyệt yêu cầu xuất kho phụ kiện thành công! Sinh chứng từ xuất ${ticketCode}`);
 } catch (err: any) {
 console.error(err);
 triggerFeedback(false, "Lỗi phê duyệt: " + err.message);
 } finally {
 setIsSubmitting(false);
 }
 };

 const handleRejectStockRequest = async (req: any) => {
 if (!isKeeper) return;
 const notes = prompt("Lý do từ chối phiếu yêu cầu này:");
 if (notes === null) return;

 try {
 await updateDoc(doc(db, 'export_proposals', req.id), {
 status: 'rejected',
 rejectReason: notes.trim() || 'Thủ kho từ chối cung cấp',
 approvedBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 approvedAt: new Date().toISOString()
 });

 triggerFeedback(true, "Đã từ chối phiếu yêu cầu.");
 } catch (err: any) {
 alert("Lỗi: " + err.message);
 }
 };

 // --- THAO TÁC KIỂM KÊ KHO HÀNG ---
 const handleConfirmStockTake = async (e: React.FormEvent) => {
 e.preventDefault();
 if (!isKeeper) return;

 if (!selectedStockTakeMatId) {
 alert("Vui lòng lựa chọn vật tư đối chiếu!");
 return;
 }

 const mat = materials.find(m => m.id === selectedStockTakeMatId);
 if (!mat) return;

 const stockBefore = mat.currentStock || 0;
 const stockAfter = Number(actualStockInput) || 0;
 const diff = stockAfter - stockBefore;

 if (diff === 0) {
 alert("Số lượng kiểm thực tế bằng số tồn hiện hành trên máy! Không thấy có sự chênh lệch cần điều chỉnh.");
 return;
 }

 if (!confirm(`Xác nhận ĐIỀU CHỈNH KHO vật tư "${mat.name}"?\n- Tồn máy tính: ${stockBefore} ${mat.unit}\n- Tồn thực tế: ${stockAfter} ${mat.unit}\n- Lượng điều chỉnh: ${diff > 0 ? '+' : ''}${diff} ${mat.unit}`)) {
 return;
 }

 setIsSubmitting(true);
 try {
 const batch = writeBatch(db);

 // 1. Cập nhật số tồn về tồn thực tế
 batch.update(doc(db, 'materials', mat.id!), {
 currentStock: stockAfter
 });

 // 2. Ghi biến động loại STOCK_TAKE
 const txRef = doc(collection(db, 'stockTransactions'));
 batch.set(txRef, {
 materialId: mat.id,
 materialName: mat.name,
 materialCode: mat.code,
 unit: mat.unit,
 type: 'STOCK_TAKE',
 quantity: diff,
 stockBefore,
 stockAfter,
 note: `Điều chỉnh chênh lệch sau khi kiểm kho sản xuất. Ghi chú kiểm kê: ${stockTakeNote || 'Không có'}`,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'admin@vattu.com',
 createdAt: new Date().toISOString()
 });

 await batch.commit();

 // Log hoạt động chung
 await addDoc(collection(db, 'activities'), {
 userId: userProfile?.uid || 'system',
 userName: userProfile?.displayName || 'Thủ kho',
 userEmail: userProfile?.email || 'admin@vattu.com',
 action: 'Kiểm kê và cân đối kho',
 details: `Cân đối kho hàng cho mã ${mat.code} - ${mat.name}. Cập nhật từ ${stockBefore} sang tồn thực tế ${stockAfter} ${mat.unit}.`,
 projectCode: 'KHO_VATTU',
 timestamp: serverTimestamp()
 });

 triggerFeedback(true, `Điều chỉnh cân đối vật tư "${mat.name}" về đúng ${stockAfter} ${mat.unit} thành công!`);
 
 // Reset
 setSelectedStockTakeMatId('');
 setActualStockInput(0);
 setStockTakeNote('');
 } catch (err: any) {
 console.error(err);
 triggerFeedback(false, "Có lỗi xảy ra: " + err.message);
 } finally {
 setIsSubmitting(false);
 }
 };

 // --- IMPORT DANH MỤC VẬT TƯ EXCEL TRỰC TIẾP ---
 const handleExcelImportSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
 const file = e.target.files?.[0];
 if (file) {
 setExcelImportFile(file);
 setExcelImportResult(null);
 }
 };

 const runExcelWarehouseImport = async () => {
 if (!excelImportFile) return;
 setIsSubmitting(true);
 setExcelImportResult(null);

 const reader = new FileReader();
 reader.onload = async (evt) => {
 try {
 const bstr = evt.target?.result;
 const workbook = XLSX.read(bstr, { type: 'binary' });
 const sheetName = workbook.SheetNames[0];
 const worksheet = workbook.Sheets[sheetName];
 const rawData = XLSX.utils.sheet_to_json(worksheet) as any[];

 if (!rawData || rawData.length === 0) {
 throw new Error("Tệp Excel trống không có dòng dữ liệu!");
 }

 let success = 0;
 let fail = 0;
 const errors: string[] = [];
 const processedNames = new Set<string>();

 const nameToMaterials = new Map<string, any>();
 materials.forEach(m => {
 nameToMaterials.set(m.name.trim().toLowerCase(), m);
 });

 // Tìm mã lớn nhất
 let maxNum = 0;
 materials.forEach(m => {
 const numPart = m.code?.replace('MAT-', '');
 const val = parseInt(numPart, 10);
 if (!isNaN(val) && val > maxNum) {
 maxNum = val;
 }
 });

 let batch = writeBatch(db);
 let opCount = 0;
 const nextTransactions: any[] = [];

 for (let i = 0; i < rawData.length; i++) {
 const row = rawData[i];
 const rowNum = i + 2;

 const nameRaw = row['Tên vật tư'] || row['Tên Vật Tư'] || row['materialName'] || row['Ten vat tu'] || row['Tên Vật tư'];
 const unitRaw = row['DVT'] || row['unit'] || row['Đơn vị tính'] || row['Đơn Vị Tính'] || 'Cái';
 const stockRaw = row['Tồn Cuối Kỳ'] || row['Tồn cuối kỳ'] || row['currentStock'] || row['Tồn Cuối'] || row['Tồn Cuối kỳ'] || 0;

 const name = typeof nameRaw === 'string' ? nameRaw.trim() : String(nameRaw || '').trim();
 const unit = typeof unitRaw === 'string' ? unitRaw.trim() : String(unitRaw || '').trim();
 const currentStock = Number(stockRaw) || 0;

 if (!name) {
 fail++;
 errors.push(`Dòng ${rowNum}: Bỏ qua do thiếu Tên vật tư.`);
 continue;
 }

 const nameLC = name.toLowerCase();
 if (processedNames.has(nameLC)) {
 fail++;
 errors.push(`Dòng ${rowNum}: Bỏ qua do trùng tên vật tư "${name}" lặp liên tục trong file.`);
 continue;
 }
 processedNames.add(nameLC);

 const existingMat = nameToMaterials.get(nameLC);
 if (existingMat) {
 const stockBefore = existingMat.currentStock || 0;
 const stockAfter = currentStock;
 const diff = stockAfter - stockBefore;

 batch.update(doc(db, 'materials', existingMat.id), {
 currentStock: stockAfter,
 unit: unit
 });
 success++;
 opCount++;

 nextTransactions.push({
 materialId: existingMat.id,
 materialName: name,
 materialCode: existingMat.code,
 unit,
 type: 'IMPORT_INITIAL',
 quantity: diff,
 stockBefore,
 stockAfter,
 note: `Đồng bộ tăng điều tiết danh mục Excel (File: ${excelImportFile.name})`,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'admin@vattu.com',
 createdAt: new Date().toISOString()
 });
 } else {
 maxNum++;
 const newCode = `MAT-${String(maxNum).padStart(5, '0')}`;
 const newMatRef = doc(collection(db, 'materials'));

 batch.set(newMatRef, {
 code: newCode,
 name,
 unit,
 category: 'Khác',
 currentStock,
 minStock: 5,
 status: 'active',
 createdAt: new Date().toISOString()
 });
 success++;
 opCount++;

 nextTransactions.push({
 materialId: newMatRef.id,
 materialName: name,
 materialCode: newCode,
 unit,
 type: 'IMPORT_INITIAL',
 quantity: currentStock,
 stockBefore: 0,
 stockAfter: currentStock,
 note: `Nhập ban sơ mã vật tư mới bằng bảng Excel (File: ${excelImportFile.name})`,
 createdBy: userProfile?.displayName || userProfile?.ten_that || 'Thủ kho',
 createdByEmail: userProfile?.email || 'admin@vattu.com',
 createdAt: new Date().toISOString()
 });
 }

 if (opCount >= 400) {
 await batch.commit();
 batch = writeBatch(db);
 opCount = 0;
 }
 }

 if (opCount > 0) {
 await batch.commit();
 }

 // Cam kết biến thiên
 let txBatch = writeBatch(db);
 let txOpCount = 0;
 for (const tx of nextTransactions) {
 const txRef = doc(collection(db, 'stockTransactions'));
 txBatch.set(txRef, tx);
 txOpCount++;
 if (txOpCount >= 400) {
 await txBatch.commit();
 txBatch = writeBatch(db);
 txOpCount = 0;
 }
 }
 if (txOpCount > 0) {
 await txBatch.commit();
 }

 await addDoc(collection(db, 'activities'), {
 userId: userProfile?.uid || 'system',
 userName: userProfile?.displayName || 'Thủ kho',
 userEmail: userProfile?.email || 'admin@vattu.com',
 action: 'Đồng bộ danh mục vật tư Excel',
 details: `Thủ kho đã thực hiện tải lên đồng bộ danh mục "${excelImportFile.name}". Cập nhật/Thêm: ${success} dòng, Thất bại: ${fail} dòng.`,
 projectCode: 'KHO_VATTU',
 timestamp: serverTimestamp()
 });

 setExcelImportResult({
 total: rawData.length,
 success,
 fail,
 errors
 });

 triggerFeedback(true, `Quá trình đồng bộ tệp Excel vật tư hoàn tất thành công!`);
 setExcelImportFile(null);
 if (excelFileInputRef.current) excelFileInputRef.current.value = '';
 } catch (e: any) {
 alert("Lỗi đọc Excel: " + e.message);
 } finally {
 setIsSubmitting(false);
 }
 };
 reader.readAsBinaryString(excelImportFile);
 };

 // --- DỮ LIỆU ĐO ĐẠC VÀ LỌC ---
 // --- TÍNH TOÁN BẢNG BOM VÀ LỌC LƯỢNG THIẾU ĐỦ ---
 const bomItems = React.useMemo(() => {
 interface BomItemMap {
 [materialKey: string]: {
 materialName: string;
 materialCode: string;
 unit: string;
 currentStock: number;
 projects: {
 [projectCode: string]: {
 projectName: string;
 neededQty: number; // Tổng lượng cần
 issuedQty: number; // Tổng lượng đã xuất
 }
 };
 totalNeeded: number;
 totalIssued: number;
 }
 }

 const map: BomItemMap = {};
 
 projectEntries.forEach(entry => {
 if (!entry.accessories || !Array.isArray(entry.accessories)) return;
 
 const pCode = entry.projectCode;
 const pName = entry.projectName || pCode;
 
 entry.accessories.forEach((acc: Accessory) => {
 if (!acc.name) return;
 const accNameTrimmed = acc.name.trim();
 const key = accNameTrimmed.toLowerCase();
 
 // Khớp tuyệt đối hoặc tương đối bằng so sánh tên với danh sách vật tư trung tâm
 const matchedMat = materials.find(m => m.name.trim().toLowerCase() === key);
 const matCode = matchedMat ? matchedMat.code : 'N/A';
 const matUnit = matchedMat ? matchedMat.unit : (acc.name.toLowerCase().includes('ray') || acc.name.toLowerCase().includes('bản lề') ? 'Bộ' : 'Cái');
 const currentStock = matchedMat ? matchedMat.currentStock : 0;
 
 if (!map[key]) {
 map[key] = {
 materialName: accNameTrimmed,
 materialCode: matCode,
 unit: matUnit,
 currentStock: currentStock,
 projects: {},
 totalNeeded: 0,
 totalIssued: 0,
 };
 }
 
 if (!map[key].projects[pCode]) {
 map[key].projects[pCode] = {
 projectName: pName,
 neededQty: 0,
 issuedQty: 0,
 };
 }
 
 // Cộng dồn nhu cầu và cấp phát trực tiếp
 const needed = acc.quantity || 0;
 const issued = acc.issuedQuantity || 0;
 
 map[key].projects[pCode].neededQty += needed;
 map[key].projects[pCode].issuedQty += issued;
 map[key].totalNeeded += needed;
 map[key].totalIssued += issued;
 });
 });
 
 return Object.values(map);
 }, [projectEntries, materials]);

 const filteredBomItems = React.useMemo(() => {
 return bomItems.filter(item => {
 const matchSearch = item.materialName.toLowerCase().includes(bomSearchTerm.toLowerCase()) || 
 item.materialCode.toLowerCase().includes(bomSearchTerm.toLowerCase());
 
 const missingTotalInProjects = Object.values(item.projects).reduce((sum, p) => sum + Math.max(0, p.neededQty - p.issuedQty), 0);
 const isSufficient = item.currentStock >= missingTotalInProjects;
 
 if (bomStatusFilter === 'insufficient') return matchSearch && !isSufficient;
 if (bomStatusFilter === 'sufficient') return matchSearch && isSufficient;
 return matchSearch;
 });
 }, [bomItems, bomSearchTerm, bomStatusFilter]);

 const deficientBomItems = React.useMemo(() => {
 return bomItems.filter(item => {
 const missingTotalInProjects = Object.values(item.projects).reduce((sum, p) => sum + Math.max(0, p.neededQty - p.issuedQty), 0);
 return item.currentStock < missingTotalInProjects;
 });
 }, [bomItems]);

 const handleExportBomExcel = () => {
 try {
 const dataToExport = bomItems.map(item => {
 const missingTotalInProjects = Object.values(item.projects).reduce((sum, p) => sum + Math.max(0, p.neededQty - p.issuedQty), 0);
 const diff = item.currentStock - missingTotalInProjects;
 const status = diff >= 0 ? 'Đủ dùng trong kho' : `Thiếu hụt (${Math.abs(diff)})`;
 
 const projectDesc = Object.entries(item.projects)
 .map(([code, p]) => `${code} (${p.projectName}): cần ${p.neededQty}, đã xuất ${p.issuedQty} (cần cấp tiếp: ${Math.max(0, p.neededQty - p.issuedQty)})`)
 .join(' | ');

 return {
 'Mã Vật Tư': item.materialCode,
 'Tên Vật Tư': item.materialName,
 'Đơn Vị Tính': item.unit,
 'Tồn Kho Thực Tế': item.currentStock,
 'Tổng Nhu Cầu Thiết Kế BOM': item.totalNeeded,
 'Tổng Số Lượng Đã Duyệt Xuất': item.totalIssued,
 'Lượng Thực Tế Còn Thiếu Cần Cấp': missingTotalInProjects,
 'Thiếu Hụt / Thừa Dư': diff,
 'Đánh Giá Khả Năng Đáp Ứng': status,
 'Dự Án Chi Tiết Đang Cần': projectDesc
 };
 });

 const worksheet = XLSX.utils.json_to_sheet(dataToExport);
 const workbook = XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(workbook, worksheet, 'BOM VẬT TƯ');
 
 worksheet['!cols'] = [
 { wch: 15 }, 
 { wch: 30 }, 
 { wch: 10 }, 
 { wch: 15 }, 
 { wch: 20 }, 
 { wch: 20 }, 
 { wch: 22 }, 
 { wch: 18 }, 
 { wch: 20 }, 
 { wch: 60 }, 
 ];

 XLSX.writeFile(workbook, `Bang_Ke_BOM_Yeu_Cau_Mua_Hang_${new Date().toISOString().split('T')[0]}.xlsx`);
 triggerFeedback(true, "Mã hóa và trích xuất thành công bảng vẽ BOM Vật tư chi tiết!");
 } catch (e: any) {
 console.error("Lỗi xuất Excel BOM:", e);
 triggerFeedback(false, `Lỗi khởi tạo file xuất Excel: ${e.message || String(e)}`);
 }
 };

 const filteredMaterials = React.useMemo(() => {
 return materials.filter(m => {
 const matchSearch = m.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
 m.code.toLowerCase().includes(searchTerm.toLowerCase());
 const matchCat = categoryFilter === 'all' || m.category === categoryFilter;
 return matchSearch && matchCat;
 });
 }, [materials, searchTerm, categoryFilter]);

 const filteredTransactions = React.useMemo(() => {
 return transactions.filter(tx => {
 const term = historySearch.toLowerCase();
 const matchSearch = tx.materialName.toLowerCase().includes(term) || 
 tx.materialCode.toLowerCase().includes(term) ||
 (tx.projectId && tx.projectId.toLowerCase().includes(term)) ||
 (tx.note && tx.note.toLowerCase().includes(term));
 const matchType = historyTypeFilter === 'all' || tx.type === historyTypeFilter;
 return matchSearch && matchType;
 });
 }, [transactions, historySearch, historyTypeFilter]);

 // Thống kê hỗ trợ vẽ biểu đồ SVG
 const categoryStats = React.useMemo(() => {
 const stats: Record<string, { count: number; stock: number }> = {};
 MATERIAL_CATEGORIES.forEach(cat => {
 stats[cat] = { count: 0, stock: 0 };
 });
 stats['Khác'] = { count: 0, stock: 0 };

 materials.forEach(m => {
 const cat = MATERIAL_CATEGORIES.includes(m.category) ? m.category : 'Khác';
 if (!stats[cat]) stats[cat] = { count: 0, stock: 0 };
 stats[cat].count++;
 stats[cat].stock += m.currentStock || 0;
 });

 return Object.entries(stats).map(([category, val]) => ({
 category,
 ...val
 })).filter(v => v.count > 0);
 }, [materials]);

 const lowStockAlerts = React.useMemo(() => {
 return materials.filter(m => m.status === 'active' && m.currentStock <= m.minStock);
 }, [materials]);

 return (
 <div className="space-y-6 pb-24 lg:pb-8">
 {/* Khung tiêu đề đầu trang */}
 <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-gray-100 shadow-sm">
 <div>
 <h1 className="text-xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
 <Boxes className="text-indigo-600 animate-pulse font-bold" size={24} />
 Hệ Thống Quản Lý Kho Draco-X2
 </h1>
 <p className="text-xs text-slate-500 mt-0.5">
 Quản lý tập trung tệp vật tư, xuất nhập chứng từ, phê duyệt yêu cầu phụ kiện xưởng và kiểm kê chênh lệch
 </p>
 </div>

 {/* Navigation Tabs - Phân quyền */}
 <div className="flex bg-slate-100 p-1 rounded-xl border border-slate-200 self-start lg:self-center flex-wrap gap-1">
 <button 
 onClick={() => setActiveTab('dashboard')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'dashboard' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <BarChart3 size={14} />
 Tổng quan
 </button>

 <button 
 onClick={() => setActiveTab('materials')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'materials' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <Tag size={14} />
 vật tư trung tâm
 </button>

 <button 
 onClick={() => setActiveTab('bom')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'bom' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <Boxes size={14} />
 Vật tư BOM
 </button>

 <button 
 onClick={() => setActiveTab('requests')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 relative ${activeTab === 'requests' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <FileText size={14} />
 Yêu cầu xuất
 {stockRequests.some(r => r.status === 'pending') && (
 <span className="absolute top-1 right-1 w-2 h-2 bg-rose-500 rounded-full animate-ping" />
 )}
 </button>

 {isKeeper && (
 <>
 <button 
 onClick={() => setActiveTab('import')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'import' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <ArrowDownLeft size={14} />
 Nhập kho
 </button>

 <button 
 onClick={() => setActiveTab('export')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'export' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <ArrowUpRight size={14} />
 Xuất kho
 </button>

 <button 
 onClick={() => setActiveTab('stocktake')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'stocktake' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-200'}`}
 >
 <CheckSquare size={14} />
 kiểm kê
 </button>
 </>
 )}

 {(isKeeper || isAccountant) && (
 <button 
 onClick={() => setActiveTab('history')}
 className={`px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-all flex items-center gap-2 ${activeTab === 'history' ? 'bg-indigo-600 text-white shadow' : 'text-slate-500 hover:text-slate-800 hover:bg-indigo-200'}`}
 >
 <History size={14} />
 sổ cái giao dịch
 </button>
 )}
 </div>
 </div>

 {feedback && (
 <div className={`p-4 rounded-lg flex items-center gap-3 animate-in fade-in zoom-in-95 text-xs font-bold uppercase tracking-tight shadow-sm border ${
 feedback.success ? 'bg-emerald-100 border-emerald-200 text-emerald-800' : 'bg-rose-100 border-rose-200 text-rose-800'
 }`}>
 {feedback.success ? <CheckCircle2 size={16} className="text-emerald-600" /> : <AlertTriangle size={16} className="text-rose-600" />}
 <span>{feedback.msg}</span>
 </div>
 )}

 {/* HIỂN THỊ NỘI DUNG TỪNG TAB */}
 <AnimatePresence mode="wait">
 <motion.div
 key={activeTab}
 initial={{ opacity: 0, y: 10 }}
 animate={{ opacity: 1, y: 0 }}
 exit={{ opacity: 0, y: -10 }}
 transition={{ duration: 0.15 }}
 className="text-slate-800"
 >
 {/******************************** TAB 1: DASHBOARD OVERVIEW ********************************/}
 {activeTab === 'dashboard' && (
 <div className="space-y-6">
 {/* Thẻ đếm vắn tắt */}
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
 <div className="bg-white p-5 rounded-lg border border-gray-100 flex items-center gap-4 shadow-sm">
 <div className="p-3 bg-indigo-100 text-indigo-700 rounded-lg">
 <Boxes size={22} />
 </div>
 <div>
 <span className="text-[10px] text-gray-400 font-extrabold uppercase block leading-none mb-1">Mã Vật Tư</span>
 <span className="text-xl font-black text-slate-800 leading-none">{materials.length} loại</span>
 </div>
 </div>

 <div className="bg-white p-5 rounded-lg border border-gray-100 flex items-center gap-4 shadow-sm">
 <div className="p-3 bg-emerald-100 text-emerald-700 rounded-lg">
 <Package size={22} />
 </div>
 <div>
 <span className="text-[10px] text-gray-400 font-extrabold uppercase block leading-none mb-1">Tổng Số Lượng Tồn</span>
 <span className="text-xl font-black text-emerald-600 leading-none">
 {materials.reduce((sum, item) => sum + (item.currentStock || 0), 0).toLocaleString()} DVT
 </span>
 </div>
 </div>

 <div className="bg-white p-5 rounded-lg border border-gray-100 flex items-center gap-4 shadow-sm">
 <div className="p-3 bg-amber-100 text-amber-700 rounded-lg">
 <AlertTriangle size={22} className="text-amber-600" />
 </div>
 <div>
 <span className="text-[10px] text-gray-400 font-extrabold uppercase block leading-none mb-1">Tồn Dưới Mức An Toàn</span>
 <span className="text-xl font-black text-amber-600 leading-none">{lowStockAlerts.length} dòng</span>
 </div>
 </div>

 <div className="bg-white p-5 rounded-lg border border-gray-100 flex items-center gap-4 shadow-sm">
 <div className="p-3 bg-slate-100 text-slate-700 rounded-lg">
 <History size={22} />
 </div>
 <div>
 <span className="text-[10px] text-gray-400 font-extrabold uppercase block leading-none mb-1">Giao Dịch (150 Phiếu Gần Nhất)</span>
 <span className="text-xl font-black text-slate-800 leading-none">{transactions.length} lệnh</span>
 </div>
 </div>
 </div>

 {/* Layout lưới chính */}
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
 
 {/* Biểu đồ phân lượng vật tư SVG */}
 <div className="lg:col-span-4 bg-white p-6 rounded-lg border border-gray-100 shadow-sm select-none">
 <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider mb-4">Cơ cấu tồn kho theo loại vật tư</h3>
 
 {categoryStats.length > 0 ? (
 <div className="flex flex-col items-center">
 {/* Biểu đồ tròn SVG thủ công */}
 <svg width="180" height="180" viewBox="0 0 100 100" className="transform -rotate-90">
 {(() => {
 let accumulatedPercent = 0;
 const totalStock = categoryStats.reduce((s, c) => s + c.stock, 0) || 1;
 const colors = ['#4f46e5', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#64748b'];

 return categoryStats.map((stat, idx) => {
 const percent = (stat.stock / totalStock) * 100;
 const startAngle = (accumulatedPercent * 360) / 100;
 const endAngle = ((accumulatedPercent + percent) * 360) / 100;
 accumulatedPercent += percent;

 // Chuyển sang radian
 const radX1 = Math.cos((startAngle * Math.PI) / 180) * 40 + 50;
 const radY1 = Math.sin((startAngle * Math.PI) / 180) * 40 + 50;
 const radX2 = Math.cos((endAngle * Math.PI) / 180) * 40 + 50;
 const radY2 = Math.sin((endAngle * Math.PI) / 180) * 40 + 50;

 const largeArcFlag = percent > 50 ? 1 : 0;

 if (percent >= 100) {
 return <circle key={idx} cx="50" cy="50" r="40" fill="none" stroke={colors[idx % colors.length]} strokeWidth="16" />;
 }

 return (
 <path
 key={idx}
 d={`M 50 50 L ${radX1} ${radY1} A 40 40 0 ${largeArcFlag} 1 ${radX2} ${radY2} Z`}
 fill={colors[idx % colors.length]}
 className="transition-all hover:scale-105 origin-center cursor-pointer"
 />
 );
 });
 })()}
 {/* Ring rỗng ở ruột tạo biểu đồ doughnut */}
 <circle cx="50" cy="50" r="24" fill="#ffffff" />
 </svg>

 {/* Chú giải thông số */}
 <div className="w-full mt-6 space-y-2 text-xs font-semibold uppercase text-slate-600">
 {categoryStats.map((stat, idx) => {
 const totalStock = categoryStats.reduce((s, c) => s + c.stock, 0) || 1;
 const colors = ['#4f46e5', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#64748b'];
 return (
 <div key={idx} className="flex items-center justify-between">
 <div className="flex items-center gap-1.5">
 <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: colors[idx % colors.length] }} />
 <span>{stat.category}</span>
 </div>
 <span className="font-mono text-slate-800 font-extrabold">
 {stat.stock.toLocaleString()} ({((stat.stock / totalStock) * 100).toFixed(1)}%)
 </span>
 </div>
 );
 })}
 </div>
 </div>
 ) : (
 <div className="py-20 text-center text-slate-300 font-bold uppercase tracking-wider text-[11px]">Chưa phát sinh tồn kho để đo đạc</div>
 )}
 </div>

 {/* Bổ sung bù BOM (Hiện danh sách vật tư thiếu hụt từ Bom dự án) */}
 <div className="lg:col-span-8 bg-white p-6 rounded-lg border border-gray-100 shadow-sm flex flex-col h-[400px]">
 <div className="flex items-center justify-between border-b border-gray-100 pb-3 mb-4 shrink-0">
 <h3 className="text-xs font-black uppercase text-indigo-900 tracking-wider flex items-center gap-2">
 <AlertTriangle className="text-rose-500 animate-bounce" size={15} />
 Bổ sung bù BOM (Vật tư thiếu hụt từ BOM dự án)
 </h3>
 <span className="px-2.5 py-0.5 bg-rose-100 text-rose-600 rounded-lg text-[10px] font-black uppercase leading-none">
 {deficientBomItems.length} Mã Cần Nhập Thêm
 </span>
 </div>

 <div className="flex-1 overflow-y-auto divide-y divide-slate-100 pr-2">
 {deficientBomItems.length > 0 ? (
 deficientBomItems.map((item, idx) => {
 const missingTotalInProjects = Object.values(item.projects).reduce((sum, p) => sum + Math.max(0, p.neededQty - p.issuedQty), 0);
 const deficit = missingTotalInProjects - item.currentStock;
 
 // Lấy danh sách các dự án đang thiếu
 const deficitProjects = Object.entries(item.projects)
 .filter(([_, p]) => p.neededQty > p.issuedQty)
 .map(([code]) => code)
 .join(', ');

 return (
 <div key={idx} className="py-3 flex items-center justify-between text-xs font-semibold uppercase">
 <div>
 <p className="font-extrabold text-slate-800 tracking-tight leading-none mb-1">{item.materialName}</p>
 <p className="text-[9px] font-mono font-normal text-slate-400">
 Mã: {item.materialCode} | Dự án: <span className="font-black text-indigo-600">{deficitProjects || 'N/A'}</span>
 </p>
 </div>
 
 <div className="text-right flex items-center gap-4">
 <div>
 <p className="text-[9px] text-gray-400 font-normal">Nhu cầu BOM chưa cấp: <span className="font-black text-slate-600">{missingTotalInProjects} {item.unit}</span></p>
 <p className="text-[10px] font-black text-rose-600">Hiện có: {item.currentStock} {item.unit}</p>
 </div>
 <span className="px-2.5 py-1 text-[10px] font-black bg-rose-100 text-rose-600 rounded-lg tracking-wider">
 THIẾU {deficit} {item.unit}
 </span>
 </div>
 </div>
 );
 })
 ) : (
 <div className="h-full flex flex-col items-center justify-center text-slate-400 p-8 space-y-2">
 <CheckCircle2 size={36} className="text-emerald-500" />
 <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Tất cả vật tư thiết kế BOM đều đáp ứng đủ nhu cầu!</span>
 </div>
 )}
 </div>
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 2: DANH MỤC VẬT TƯ TRUNG TÂM ********************************/}
 {activeTab === 'materials' && (
 <div className="space-y-6">
 <div className="bg-white p-4 rounded-lg border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
 
 {/* Lọc & Tìm kiếm */}
 <div className="flex items-center gap-3 flex-1 flex-wrap">
 <div className="relative w-full max-w-sm">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
 <input 
 type="text"
 placeholder="Tìm mã hoặc tên vật tư..."
 className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-xs font-bold outline-none focus:border-indigo-500 bg-slate-100/50"
 value={searchTerm}
 onChange={e => setSearchTerm(e.target.value)}
 />
 </div>

 <select
 value={categoryFilter}
 onChange={e => setCategoryFilter(e.target.value)}
 className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-700 outline-none cursor-pointer"
 >
 <option value="all">Tất cả Nhóm vật tư</option>
 {MATERIAL_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
 </select>
 </div>

 {/* Hành vi thêm mới & Import Excel */}
 {isKeeper && (
 <div className="flex items-center gap-2 self-start md:self-auto flex-wrap">
 <button
 onClick={() => {
 setEditingMaterial(null);
 setMatName('');
 setMatUnit('Khung');
 setMatCategory('Ván');
 setMatMinStock(5);
 setMatNote('');
 setMatInitialStock(0);
 setShowMaterialModal(true);
 }}
 className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider flex items-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer"
 >
 <Plus size={15} />
 Thêm mã vật tư
 </button>

 {/* Import Excel */}
 <div className="relative flex items-center gap-1.5">
 <label className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-lg text-xs font-black uppercase tracking-wider flex items-center gap-1.5 cursor-pointer active:scale-95 transition-all">
 <FileSpreadsheet size={15} className="text-emerald-600" />
 <span>Đồng bộ Excel danh mục</span>
 <input 
 type="file"
 accept=".xlsx, .xls"
 ref={excelFileInputRef}
 onChange={handleExcelImportSelection}
 className="hidden"
 />
 </label>
 </div>
 </div>
 )}
 </div>

 {/* Excel Import Modal Preview */}
 {excelImportFile && (
 <div className="bg-amber-100 border border-amber-200 p-4 rounded-lg flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-bold shadow-sm">
 <div className="flex items-center gap-2">
 <CheckSquare size={16} className="text-amber-600 animate-bounce" />
 <span>File được chọn: <code className="bg-white px-2 py-1 rounded text-indigo-700 font-mono font-black">{excelImportFile.name}</code></span>
 </div>
 <div className="flex items-center gap-2 shrink-0">
 <button
 onClick={() => {
 setExcelImportFile(null);
 if (excelFileInputRef.current) excelFileInputRef.current.value = '';
 }}
 className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded-lg hover:bg-slate-300 pointer-events-auto"
 >
 Huỷ bỏ
 </button>
 <button
 onClick={runExcelWarehouseImport}
 disabled={isSubmitting}
 className="px-4 py-1.5 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-black flex items-center gap-1 shadow cursor-pointer"
 >
 {isSubmitting ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
 BẮT ĐẦU ĐỒNG BỘ KHO
 </button>
 </div>
 </div>
 )}

 {excelImportResult && (
 <div className="p-4 bg-slate-100 border border-gray-100 rounded-lg text-xs space-y-3">
 <h4 className="font-black uppercase tracking-wide text-indigo-900 flex items-center gap-1.5">
 <CheckCircle2 size={15} className="text-emerald-500" />
 Kết quả đồng bộ tệp Excel gần nhất
 </h4>
 <div className="grid grid-cols-3 gap-4 bg-white p-3 border border-gray-100 rounded-lg text-center font-bold">
 <div>
 <p className="text-[10px] text-gray-400 uppercase">Tổng số dòng</p>
 <p className="text-base font-black text-indigo-900">{excelImportResult.total}</p>
 </div>
 <div>
 <p className="text-[10px] text-emerald-500 uppercase">Đồng bộ thành công</p>
 <p className="text-base font-black text-emerald-600">{excelImportResult.success}</p>
 </div>
 <div>
 <p className="text-[10px] text-rose-500 uppercase">Dòng Lỗi / Bỏ qua</p>
 <p className="text-base font-black text-rose-600">{excelImportResult.fail}</p>
 </div>
 </div>

 {excelImportResult.errors.length > 0 && (
 <div className="space-y-1">
 <p className="font-extrabold text-rose-600 uppercase text-[9px]">Chi tiết lỗi tệp:</p>
 <div className="max-h-24 overflow-y-auto bg-rose-100 p-2 text-[10px] font-mono text-rose-800 rounded-lg leading-relaxed">
 {excelImportResult.errors.map((e, i) => <p key={i}>• {e}</p>)}
 </div>
 </div>
 )}
 </div>
 )}

 {/* Bảng Danh mục chính */}
 <div className="bg-white rounded-lg border border-gray-100 overflow-hidden shadow-sm">
 <div className="overflow-x-auto">
 <table className="w-full text-left border-collapse">
 <thead>
 <tr className="bg-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-gray-100 select-none">
 <th className="px-6 py-4">Mã Vật Tư</th>
 <th className="px-6 py-4">Tên Vật Tư</th>
 <th className="px-6 py-4">DVT</th>
 <th className="px-6 py-4">Nhóm Vật Tư</th>
 <th className="px-6 py-4 text-center">Tồn Hiện Tại</th>
 <th className="px-6 py-4 text-center">Ngưỡng Tối Thiểu</th>
 <th className="px-6 py-4 text-center">Trạng Thái</th>
 {isKeeper && <th className="px-6 py-4 text-center">Thao Tác</th>}
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 text-xs font-semibold uppercase">
 {loadingMaterials ? (
 <tr>
 <td colSpan={8} className="py-20 text-center"><Loader2 size={30} className="animate-spin text-indigo-600 mx-auto" /></td>
 </tr>
 ) : filteredMaterials.length > 0 ? (
 filteredMaterials.map((mat, index) => {
 const isLow = mat.status === 'active' && mat.currentStock <= mat.minStock;
 return (
 <tr key={mat.id || index} className={`hover:bg-slate-100/50 ${mat.status === 'inactive' ? 'opacity-100 line-through bg-slate-100/20' : ''}`}>
 <td className="px-6 py-4 font-mono font-black text-indigo-700">{mat.code}</td>
 <td className="px-6 py-4 font-extrabold text-slate-900 tracking-tight leading-normal max-w-xs">{mat.name}</td>
 <td className="px-6 py-4 text-slate-500 font-bold">{mat.unit}</td>
 <td className="px-6 py-4">
 <span className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] rounded-lg">
 {mat.category}
 </span>
 </td>
 <td className="px-6 py-4 text-center">
 <span className={`px-2.5 py-1 rounded-lg font-mono font-black text-[11px] ${isLow ? 'bg-rose-100 text-rose-600 animate-pulse' : 'bg-emerald-100 text-emerald-700'}`}>
 {mat.currentStock?.toLocaleString() || 0}
 </span>
 </td>
 <td className="px-6 py-4 text-center font-mono text-slate-500">{mat.minStock}</td>
 <td className="px-6 py-4 text-center">
 <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black uppercase ${mat.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}>
 {mat.status === 'active' ? 'Sử dụng' : 'Tạm Ngưng'}
 </span>
 </td>
 {isKeeper && (
 <td className="px-6 py-4">
 <div className="flex items-center justify-center gap-2.5 pointer-events-auto">
 <button
 onClick={() => handleEditMaterialClick(mat)}
 className="p-1.5 bg-slate-100 text-slate-600 rounded-lg hover:bg-indigo-100 hover:text-indigo-600 transition-all cursor-pointer"
 title="Sửa thông tin"
 >
 <Edit3 size={13} />
 </button>
 <button
 onClick={() => toggleMaterialStatus(mat)}
 className={`p-1.5 rounded-lg transition-all cursor-pointer ${
 mat.status === 'active' 
 ? 'bg-rose-100 text-rose-600 hover:bg-rose-100' 
 : 'bg-emerald-100 text-emerald-600 hover:bg-emerald-100'
 }`}
 title={mat.status === 'active' ? 'Ngừng sử dụng' : 'Kích hoạt lại'}
 >
 <Power size={13} />
 </button>
 </div>
 </td>
 )}
 </tr>
 );
 })
 ) : (
 <tr>
 <td colSpan={8} className="py-20 text-center text-slate-400 font-bold uppercase tracking-widest">Không có vật tư nào khớp với từ khoá tìm kiếm</td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 3: PHIẾU NHẬP KHO CHỨNG TỪ ********************************/}
 {activeTab === 'import' && isKeeper && (
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
 
 {/* Form Lập phiếu */}
 <div className="lg:col-span-8 bg-white p-6 rounded-lg border border-gray-100 shadow-sm">
 <div className="border-b border-gray-100 pb-3 mb-5 flex items-center justify-between">
 <div>
 <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
 <ArrowDownLeft size={16} className="text-indigo-600" />
 Lập Phiếu Nhập Vật Tư Ngoài / Thêm Kho
 </h3>
 <p className="text-[10px] text-gray-400 mt-1 uppercase font-semibold">Tự động tăng tồn kho trung tâm sau khi phát hành</p>
 </div>
 <span className="text-xs font-mono font-black border border-slate-200 bg-slate-100 text-slate-600 px-3 py-1 rounded-lg">
 {generateTicketCode('PN')} (Demo)
 </span>
 </div>

 <form onSubmit={handleCreateReceipt} className="space-y-6">
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Tên Nhà Cung Cấp (NCC) / Xuất sứ:</label>
 <input 
 type="text" 
 placeholder="Ví dụ: Công ty Gỗ An Cường, NPP Phụ kiện Hafele..."
 className="w-full px-3.5 py-2.5 bg-slate-100/50 border border-slate-200 rounded-lg text-xs font-bold outline-none focus:border-indigo-500"
 value={receiptSupplier}
 onChange={e => setReceiptSupplier(e.target.value)}
 />
 </div>

 <div className="space-y-4">
 <div className="flex items-center justify-between">
 <label className="text-xs font-black uppercase text-slate-700">Danh Mục Thiết Bị Vật Tư Nhận: </label>
 <button
 type="button"
 onClick={() => setReceiptItems([...receiptItems, { materialId: '', quantity: 1 }])}
 className="px-3 py-1 bg-indigo-100 text-indigo-700 hover:bg-indigo-100 text-[10px] font-black uppercase tracking-wider rounded-lg flex items-center gap-1 cursor-pointer transition-all active:scale-95"
 >
 <Plus size={12} />
 Thêm dòng
 </button>
 </div>

 <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
 {receiptItems.map((item, idx) => (
 <div key={idx} className="flex gap-3 items-center bg-slate-100 p-3 rounded-lg border border-slate-300/10">
 
 {/* Dropdown vật tư */}
 <div className="flex-1">
 <select
 value={item.materialId}
 onChange={e => handleReceiptItemChange(idx, 'materialId', e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-bold uppercase text-slate-800 outline-none"
 >
 <option value="">-- Chọn vật tư cần nhập --</option>
 {materials.filter(m => m.status === 'active').map(m => (
 <option key={m.id} value={m.id}>{m.code} - {m.name} (Tồn hiện tại: {m.currentStock} {m.unit})</option>
 ))}
 </select>
 </div>

 {/* Số lượng */}
 <div className="w-24 shrink-0">
 <input 
 type="number"
 min="1"
 placeholder="SL"
 value={item.quantity}
 onChange={e => handleReceiptItemChange(idx, 'quantity', e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-mono font-black text-center outline-none"
 />
 </div>

 {/* Xóa dòng */}
 {receiptItems.length > 1 && (
 <button
 type="button"
 onClick={() => {
 const list = receiptItems.filter((_, i) => i !== idx);
 setReceiptItems(list);
 }}
 className="p-2 text-rose-500 hover:bg-rose-100 rounded-lg transition-all"
 >
 <Trash2 size={15} />
 </button>
 )}
 </div>
 ))}
 </div>
 </div>

 <div className="pt-4 flex gap-3">
 <button
 type="button"
 onClick={() => {
 setReceiptSupplier('');
 setReceiptItems([{ materialId: '', quantity: 1 }]);
 }}
 className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-wider"
 >
 Xóa trắng Form
 </button>
 <button
 type="submit"
 disabled={isSubmitting}
 className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-black uppercase tracking-wider shadow-md flex items-center justify-center gap-1.5 disabled:bg-gray-200"
 >
 {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
 PHÁT HÀNH PHIẾU NHẬP KHO
 </button>
 </div>
 </form>
 </div>

 {/* Hướng dẫn sidebar */}
 <div className="lg:col-span-4 bg-slate-100 p-6 rounded-lg border border-slate-200/40 space-y-4">
 <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1">
 <Info size={14} className="text-indigo-600" />
 Chỉ Dẫn Nghiệp Vụ Nhập
 </h4>
 <div className="text-[11px] font-semibold text-slate-600 space-y-2 uppercase leading-relaxed">
 <p className="text-justify font-normal normal-case">Hệ thống phân phối hàng nhập kho từ nhà sản xuất gỗ, các tổng đại lý và đối tác gia công bên ngoài. Khi lưu:</p>
 <p>• Trực tiếp cộng dồn số tồn kho ở bảng chính.</p>
 <p>• Sinh chứng từ lưu trữ bất biến.</p>
 <p>• Lập tức sinh lịch sử biến động có định danh người khởi tạo.</p>
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 4: PHIẾU XUẤT KHO DỰ ÁN ********************************/}
 {activeTab === 'export' && isKeeper && (
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
 
 {/* Form lập phiếu xuất */}
 <div className="lg:col-span-8 bg-white p-6 rounded-lg border border-gray-100 shadow-sm">
 <div className="border-b border-gray-100 pb-3 mb-5 flex items-center justify-between">
 <div>
 <h3 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-2">
 <ArrowUpRight size={16} className="text-rose-600" />
 Lập Phiếu Xuất Giao Dự Án Thi Công
 </h3>
 <p className="text-[10px] text-gray-400 mt-1 uppercase font-semibold">Tự động trừ tồn vật tư chính và phân phối định mức phụ kiện</p>
 </div>
 <span className="text-xs font-mono font-black border border-slate-200 bg-slate-100 text-slate-600 px-3 py-1 rounded-lg">
 {generateTicketCode('PX')} (Demo)
 </span>
 </div>

 <form onSubmit={handleCreateIssue} className="space-y-6">
 
 {/* Dự án chọn */}
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Dự ÁN / Công trình Thụ hưởng:</label>
 <select
 value={issueProjectId}
 onChange={e => setIssueProjectId(e.target.value)}
 className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3.5 py-2.5 text-xs font-bold uppercase text-slate-800 outline-none focus:border-indigo-500"
 >
 <option value="">-- Chọn dự án thụ hưởng --</option>
 {/* Tạo ds duy nhất các dự án từ projectEntries */}
 {Array.from(new Set(projectEntries.map(p => p.projectCode))).filter(code => !!code).map(code => {
 const matchedName = projectEntries.find(p => p.projectCode === code)?.projectName || code;
 return <option key={code} value={code}>{code} - {matchedName}</option>;
 })}
 <option value="GENERAL_XUONG">XUẤT PHỤC VỤ SẢN XUẤT NỘI BỘ XƯỞNG</option>
 </select>
 </div>

 {/* Multi-item xuất */}
 <div className="space-y-4">
 <div className="flex items-center justify-between">
 <label className="text-xs font-black uppercase text-slate-700">Vật tư xuất đi: </label>
 <button
 type="button"
 onClick={() => setIssueItems([...issueItems, { materialId: '', quantity: 1 }])}
 className="px-3 py-1 bg-indigo-100 text-indigo-700 hover:bg-indigo-100 text-[10px] font-black uppercase tracking-wider rounded-lg flex items-center gap-1 cursor-pointer transition-all active:scale-95"
 >
 <Plus size={12} />
 Thêm dòng
 </button>
 </div>

 <div className="space-y-2.5 max-h-[300px] overflow-y-auto pr-1">
 {issueItems.map((item, idx) => (
 <div key={idx} className="flex gap-3 items-center bg-slate-100 p-3 rounded-lg border border-slate-300/10 text-xs">
 {/* Dropdown vật tư */}
 <div className="flex-1">
 <select
 value={item.materialId}
 onChange={e => handleIssueItemChange(idx, 'materialId', e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-bold uppercase text-slate-800 outline-none"
 >
 <option value="">-- Chọn vật tư cần xuất --</option>
 {materials.filter(m => m.status === 'active' && m.currentStock > 0).map(m => (
 <option key={m.id} value={m.id}>{m.code} - {m.name} (Hiện có: {m.currentStock} {m.unit})</option>
 ))}
 </select>
 </div>

 {/* Số lượng */}
 <div className="w-24 shrink-0">
 <input 
 type="number"
 min="1"
 placeholder="SL"
 value={item.quantity}
 onChange={e => handleIssueItemChange(idx, 'quantity', e.target.value)}
 className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs font-mono font-black text-center outline-none"
 />
 </div>

 {/* Xóa dòng */}
 {issueItems.length > 1 && (
 <button
 type="button"
 onClick={() => {
 const list = issueItems.filter((_, i) => i !== idx);
 setIssueItems(list);
 }}
 className="p-2 text-rose-500 hover:bg-rose-100 rounded-lg transition-all"
 >
 <Trash2 size={15} />
 </button>
 )}
 </div>
 ))}
 </div>
 </div>

 <div className="pt-4 flex gap-3">
 <button
 type="button"
 onClick={() => {
 setIssueProjectId('');
 setIssueItems([{ materialId: '', quantity: 1 }]);
 }}
 className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg text-xs font-black uppercase tracking-wider"
 >
 Xóa trắng Form
 </button>
 <button
 type="submit"
 disabled={isSubmitting}
 className="px-6 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-black uppercase tracking-wider shadow-md flex items-center justify-center gap-1.5 disabled:bg-gray-200"
 >
 {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
 XUẤT KHO NGAY
 </button>
 </div>
 </form>
 </div>

 {/* Chỉ dẫn an toàn */}
 <div className="lg:col-span-4 bg-slate-100 p-6 rounded-lg border border-slate-200/50 space-y-4">
 <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1">
 <Info size={14} className="text-rose-600" />
 Rõ Ràng Nghiệp Vụ Xuất
 </h4>
 <div className="text-[11px] font-semibold text-slate-600 space-y-2 uppercase leading-relaxed text-justify">
 <p className="normal-case font-normal text-slate-500">Mọi phiếu xuất đều bắt buộc tuân chuẩn:</p>
 <p>• Tuyệt đối không cho phép xuất vượt quá số lượng tồn hiện hành trên hệ thống.</p>
 <p>• Trừ kho tổng tức thì.</p>
 <p>• Bảo mật bất biến lịch sử giao dịch (sổ cái không sửa xóa).</p>
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 5: DANH SÁCH ĐỀ NGHỊ XUẤT PHỤ KIỆN DỰ ÁN ********************************/}
 {activeTab === 'requests' && (
 <div className="space-y-6">
 <div className="bg-white p-6 rounded-lg border border-gray-100 shadow-sm">
 <div className="border-b border-gray-100 pb-3 mb-5 flex items-center justify-between">
 <div>
 <h3 className="text-xs font-black uppercase tracking-wider text-slate-800">
 Danh sách yêu cầu xuất kho phụ kiện lắp ráp dự án
 </h3>
 <p className="text-[10px] text-gray-400 mt-1 uppercase font-semibold">Tự động đồng bộ từ đề nghị xuất phụ kiện được kỹ thuật/công trường ghi nhận</p>
 </div>
 <span className="px-3 py-1 bg-indigo-100 border border-indigo-200 text-indigo-700 rounded-lg text-xs font-black uppercase leading-none">
 {stockRequests.length} Yêu cầu
 </span>
 </div>

 <div className="space-y-4">
 {loadingRequests ? (
 <div className="py-20 text-center"><Loader2 size={30} className="animate-spin text-indigo-600 mx-auto" /></div>
 ) : stockRequests.length > 0 ? (
 stockRequests.map((req, idx) => {
 const isPending = req.status === 'pending';
 return (
 <div key={req.id || idx} className="border border-slate-100 rounded-lg bg-slate-100/30 overflow-hidden font-semibold text-xs text-slate-700">
 {/* Header yêu cầu */}
 <div className="p-4 bg-slate-100 flex flex-wrap items-center justify-between gap-3 border-b border-slate-100">
 <div>
 <p className="font-extrabold text-slate-900 tracking-tight leading-none mb-1">Dự án: {req.projectCode || req.projectName || req.projectId}</p>
 <p className="text-[9px] font-mono text-slate-400 uppercase font-normal">
 Người yêu cầu: {req.createdByName || req.createdByEmail || 'Thành viên'} | Ngày: {req.createdAt ? (typeof req.createdAt.toDate === 'function' ? req.createdAt.toDate().toLocaleString() : new Date(req.createdAt).toLocaleString()) : 'Vừa xong'}
 </p>
 {req.exportLabel && (
 <p className="text-[9.5px] font-bold text-indigo-600 uppercase mt-1">Nhãn xuất: {req.exportLabel}</p>
 )}
 {req.notes && (
 <p className="text-[9.5px] text-slate-500 normal-case font-medium mt-1">Ghi chú: {req.notes}</p>
 )}
 </div>

 <div className="flex items-center gap-3">
 <span className={`px-2.5 py-0.5 rounded-lg text-[9px] font-black uppercase ${
 req.status === 'approved' 
 ? 'bg-emerald-100 text-emerald-700 border border-emerald-100' 
 : req.status === 'rejected'
 ? 'bg-rose-100 text-rose-600 border border-rose-100'
 : 'bg-amber-100 text-amber-700 border border-amber-100 animate-pulse'
 }`}>
 {req.status === 'approved' && 'Đã cấp phát'}
 {req.status === 'rejected' && 'Từ chối'}
 {req.status === 'pending' && 'Đang chờ duyệt'}
 </span>

 {isKeeper && isPending && (
 <div className="flex items-center gap-2 pointer-events-auto">
 <button
 onClick={() => handleRejectStockRequest(req)}
 type="button"
 className="px-2.5 py-1 text-[10px] font-black uppercase border border-rose-200 bg-rose-100 text-rose-600 rounded-lg hover:bg-rose-100 active:scale-95 transition-all text-center cursor-pointer"
 >
 Từ chối
 </button>
 <button
 onClick={() => handleApproveStockRequest(req)}
 type="button"
 className="px-3 py-1 text-[10px] font-black uppercase border border-emerald-200 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-100 active:scale-95 transition-all flex items-center gap-1 cursor-pointer"
 >
 <CheckCircle2 size={11} />
 Duyệt xuất
 </button>
 </div>
 )}
 </div>
 </div>

 {/* Chi tiết vật tư yêu cầu */}
 <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
 {req.items?.map((it: any, i: number) => {
 const itemName = it.name || it.materialName;
 // Dự đoán tồn kho
 const mItem = materials.find(m => m.name.trim().toLowerCase() === itemName.trim().toLowerCase());
 const currentStock = mItem?.currentStock || 0;
 const isSufficient = currentStock >= it.quantity;

 return (
 <div key={i} className="bg-white p-3 border border-slate-100 rounded-lg flex items-center justify-between font-semibold">
 <div>
 <p className="font-extrabold text-slate-800 uppercase tracking-tight leading-tight">{itemName}</p>
 <p className="text-[9px] font-mono font-normal text-slate-400 uppercase mt-1">SL yêu cầu: {it.quantity} {it.unit || 'Cái'}</p>
 </div>

 <div className="text-right shrink-0">
 <p className="text-[9px] text-gray-400 font-normal">Tồn Tổng:</p>
 <span className={`text-[10px] font-black font-mono px-1.5 py-0.5 rounded ${isSufficient ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'}`}>
 {currentStock} {mItem?.unit || 'CÁI'}
 </span>
 </div>
 </div>
 );
 })}
 </div>

 {req.rejectReason && (
 <div className="px-4 pb-4 font-mono text-[10px] text-rose-700">
 * Lý do từ chối: {req.rejectReason}
 </div>
 )}
 </div>
 );
 })
 ) : (
 <div className="py-20 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">
 Không có yêu cầu xuất phụ kiện nào đang ghi nhận tại xưởng.
 </div>
 )}
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 6: KIỂM KÊ KHO SẢN XUẤT ********************************/}
 {activeTab === 'stocktake' && isKeeper && (
 <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
 
 {/* Form nạp tồn thực tế */}
 <div className="lg:col-span-8 bg-white p-6 rounded-lg border border-gray-100 shadow-sm">
 <div className="border-b border-gray-100 pb-3 mb-5">
 <h3 className="text-xs font-black uppercase tracking-wider text-slate-900">
 Cân đối và kiểm kê chênh lệch số lượng
 </h3>
 <p className="text-[10px] text-gray-400 mt-1 uppercase font-semibold">Thủ kho tiến hành đối chiếu tồn máy tính và nhập tồn thực tế rà soát chênh lệch</p>
 </div>

 <form onSubmit={handleConfirmStockTake} className="space-y-6">
 
 {/* Chọn vật tư */}
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Vật tư kiểm kê:</label>
 <select
 value={selectedStockTakeMatId}
 onChange={e => {
 setSelectedStockTakeMatId(e.target.value);
 const mat = materials.find(m => m.id === e.target.value);
 setActualStockInput(mat ? mat.currentStock : 0);
 }}
 className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3.5 py-2.5 text-xs font-bold uppercase text-slate-800 outline-none focus:border-indigo-500"
 >
 <option value="">-- Chọn vật tư cần đối soát --</option>
 {materials.filter(m => m.status === 'active').map(m => (
 <option key={m.id} value={m.id}>{m.code} - {m.name} (Tồn máy tính: {m.currentStock} {m.unit})</option>
 ))}
 </select>
 </div>

 {selectedStockTakeMatId && (() => {
 const mat = materials.find(m => m.id === selectedStockTakeMatId)!;
 const bVal = mat.currentStock || 0;
 const aVal = Number(actualStockInput) || 0;
 const diff = aVal - bVal;

 return (
 <div className="p-4 bg-slate-100 rounded-lg border border-slate-200 text-xs font-bold space-y-4">
 <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-center">
 <div className="bg-white p-3 rounded-lg border border-slate-100">
 <p className="text-[10px] text-gray-400 uppercase">Tồn máy tính</p>
 <p className="text-base font-black text-slate-700 font-mono mt-1">{bVal} {mat.unit}</p>
 </div>
 
 <div className="bg-white p-3 rounded-lg border border-indigo-200">
 <p className="text-[10px] text-indigo-600 uppercase">Nhập Tồn thực tế</p>
 <input 
 type="number"
 min="0"
 value={actualStockInput}
 onChange={e => setActualStockInput(Math.max(0, Number(e.target.value) || 0))}
 className="w-full bg-slate-100 text-center font-black font-mono text-base border-0 focus:ring-0 p-1 mt-1 font-bold rounded"
 />
 </div>

 <div className={`col-span-2 md:col-span-1 p-3 rounded-lg border flex flex-col justify-center items-center ${
 diff === 0 
 ? 'bg-slate-100 border-slate-200 text-slate-600'
 : diff > 0 
 ? 'bg-emerald-100 border-emerald-200 text-emerald-700'
 : 'bg-rose-100 border-rose-200 text-rose-700'
 }`}>
 <p className="text-[10px] uppercase">Chênh lệch</p>
 <p className="text-base font-black mt-1 font-mono">
 {diff === 0 ? 'Khớp tồn (0)' : `${diff > 0 ? 'Thừa +' : 'Thiếu '}${diff}`}
 </p>
 </div>
 </div>

 {/* Ghi chú */}
 <div className="space-y-1 font-bold text-xs uppercase text-slate-700">
 <p>Giải trình gãy lỗi / Lý do chênh lệch:</p>
 <textarea 
 rows={3}
 placeholder="Ví dụ: Thao tác nhầm lẫn phiếu xuất, hỏng hóc hao hụt ván, v.v..."
 className="bg-white w-full border border-slate-200 rounded-lg font-normal p-3 outline-none focus:border-indigo-500 text-xs/relaxed"
 value={stockTakeNote}
 onChange={e => setStockTakeNote(e.target.value)}
 />
 </div>

 <div className="pt-2">
 <button
 type="button"
 onClick={handleConfirmStockTake}
 disabled={isSubmitting || diff === 0}
 className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg uppercase tracking-wider font-black flex items-center justify-center gap-1.5 shadow disabled:bg-gray-200"
 >
 {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
 Xác nhận điều chỉnh cân đối cơ sở dữ liệu
 </button>
 </div>
 </div>
 );
 })()}
 </form>
 </div>

 {/* Tôn trọng sổ sách */}
 <div className="lg:col-span-4 bg-slate-100 p-6 rounded-lg border border-slate-200/50 space-y-4">
 <h4 className="text-xs font-black uppercase tracking-wider text-slate-800 flex items-center gap-1">
 <Info size={14} className="text-indigo-600" />
 Luật Kiểm Kê Kho Hàng
 </h4>
 <div className="text-[11px] font-semibold text-slate-600 space-y-2 uppercase leading-relaxed text-justify">
 <p className="normal-case font-normal text-slate-500">Mục tiêu là phản ánh đúng thực tế lắp ráp tại xưởng:</p>
 <p>• Số lượng thừa hay thiếu hụt đều bắt buộc giải trình cụ thể.</p>
 <p>• Việc khớp tồn sẽ đồng bộ số lượng hiện thời tức thời về đúng Tồn thực tế vừa kiểm tra.</p>
 <p>• Phải ghi đầy đủ Sổ cái giao dịch để phòng hờ thanh tra tài chính.</p>
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 7: LỊCH SỬ GIAO DỊCH (SỔ CÁI HOẠT ĐỘNG) ********************************/}
 {activeTab === 'history' && (isKeeper || isAccountant) && (
 <div className="space-y-6">
 <div className="bg-white p-4 rounded-lg border border-gray-100 flex flex-col lg:flex-row lg:items-center justify-between gap-4 shadow-sm text-xs font-bold text-slate-700">
 <div className="flex items-center gap-3 flex-wrap flex-1">
 <div className="relative w-full max-w-sm">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
 <input 
 type="text"
 placeholder="Tìm mã, loại hoạt động, mô tả, dự án..."
 className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-xs font-bold outline-none focus:border-indigo-500 bg-slate-100/50"
 value={historySearch}
 onChange={e => setHistorySearch(e.target.value)}
 />
 </div>

 <select
 value={historyTypeFilter}
 onChange={e => setHistoryTypeFilter(e.target.value)}
 className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs outline-none cursor-pointer text-slate-800"
 >
 <option value="all">Mọi Hoạt động</option>
 <option value="IMPORT">NHẬP KHO (IMPORT)</option>
 <option value="EXPORT">XUẤT KHO (EXPORT)</option>
 <option value="IMPORT_INITIAL">NHẬP MỚI EXCEL (IMPORT_INITIAL)</option>
 <option value="STOCK_TAKE">KIỂM KÊ (STOCK_TAKE)</option>
 <option value="EXPORT_REQUEST">DUYỆT YÊU CẦU DUYÊN (EXPORT_REQUEST)</option>
 </select>
 </div>
 </div>

 {/* Bảng sổ cái bất biến */}
 <div className="bg-white border border-gray-100 rounded-lg overflow-hidden shadow-sm">
 <div className="overflow-x-auto">
 <table className="w-full text-left border-collapse">
 <thead>
 <tr className="bg-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-gray-100 select-none">
 <th className="px-6 py-4">Thời gian</th>
 <th className="px-6 py-4">Mã Vật Tư</th>
 <th className="px-6 py-4">Vật Tư</th>
 <th className="px-6 py-4 text-center">Nghiệp Vụ</th>
 <th className="px-6 py-4 text-center">Số Lượng Biến Động</th>
 <th className="px-6 py-4 text-center">Tồn Trước/Sau</th>
 <th className="px-6 py-4">Thành viên phụ trách</th>
 <th className="px-6 py-4">Giải trình/Chứng từ</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 text-xs font-semibold uppercase">
 {loadingTransactions ? (
 <tr>
 <td colSpan={8} className="py-20 text-center"><Loader2 size={30} className="animate-spin text-indigo-600 mx-auto" /></td>
 </tr>
 ) : filteredTransactions.length > 0 ? (
 filteredTransactions.map((tx, index) => {
 const dateObj = tx.createdAt ? new Date(tx.createdAt) : new Date();
 return (
 <tr key={tx.id || index} className="hover:bg-slate-100/30">
 <td className="px-6 py-4 font-mono text-slate-400 font-normal leading-tight">
 {dateObj.toLocaleDateString()}<br/>{dateObj.toLocaleTimeString()}
 </td>
 <td className="px-6 py-4 font-mono font-black text-indigo-700">{tx.materialCode}</td>
 <td className="px-6 py-4 font-extrabold text-slate-800 tracking-tight leading-normal max-w-xs">{tx.materialName}</td>
 <td className="px-6 py-4 text-center">
 <span className={`px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-tight ${
 tx.type === 'IMPORT' || tx.type === 'IMPORT_INITIAL'
 ? 'bg-emerald-100 text-emerald-700'
 : tx.type === 'STOCK_TAKE'
 ? 'bg-amber-100 text-amber-700'
 : 'bg-rose-100 text-rose-600'
 }`}>
 {tx.type}
 </span>
 </td>
 <td className="px-6 py-4 text-center font-mono font-black">
 <span className={tx.quantity >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
 {tx.quantity >= 0 ? '+' : ''}{tx.quantity} {tx.unit}
 </span>
 </td>
 <td className="px-6 py-4 text-center font-mono font-normal text-slate-400 text-[10px]">
 {tx.stockBefore} ➔ {tx.stockAfter}
 </td>
 <td className="px-6 py-4 leading-tight">
 <span className="font-extrabold text-slate-700 tracking-tight block">{tx.createdBy}</span>
 <span className="text-[9px] font-mono font-normal text-slate-400">{tx.createdByEmail}</span>
 </td>
 <td className="px-6 py-4 leading-normal text-slate-500 normal-case font-medium max-w-xs break-words">
 {tx.note || <span className="italic text-slate-400">Không ghi chi chú</span>}
 </td>
 </tr>
 );
 })
 ) : (
 <tr>
 <td colSpan={8} className="py-20 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">Sổ cái trống không ghi nhận lịch sử bất kì</td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 )}

 {/******************************** TAB 8: VẬT TƯ BOM ********************************/}
 {activeTab === 'bom' && (
 <div className="space-y-6">
 {/* Thanh bộ lọc và hành động */}
 <div className="bg-white p-4 rounded-xl border border-gray-100 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
 <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1">
 <div className="relative w-full max-w-sm">
 <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
 <input 
 type="text"
 placeholder="Tìm vật tư BOM, phụ kiện..."
 className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-xs font-bold outline-none focus:border-indigo-500 bg-slate-100/50"
 value={bomSearchTerm}
 onChange={e => setBomSearchTerm(e.target.value)}
 />
 </div>

 <select
 value={bomStatusFilter}
 onChange={e => setBomStatusFilter(e.target.value as any)}
 className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold outline-none cursor-pointer text-slate-700 min-w-[150px]"
 >
 <option value="all">Tất cả Trạng thái</option>
 <option value="insufficient">Thiếu hụt trong kho</option>
 <option value="sufficient">Đủ dùng lắp ráp</option>
 </select>
 </div>

 <button
 type="button"
 onClick={handleExportBomExcel}
 className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-colors self-start md:self-center"
 >
 <FileSpreadsheet size={14} />
 Xuất Excel BOM
 </button>
 </div>

 {/* Banner cảnh báo nhập hàng */}
 {bomItems.some(item => {
 const missingTotalInProjects = Object.values(item.projects).reduce((sum, p) => sum + Math.max(0, p.neededQty - p.issuedQty), 0);
 return item.currentStock < missingTotalInProjects;
 }) && (
 <div className="p-4 bg-amber-100 border border-amber-200 rounded-xl flex items-start gap-3">
 <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
 <div className="space-y-1">
 <h4 className="text-xs font-black uppercase text-amber-800 tracking-wide">
 Cảnh báo thiếu hụt vật tư lắp ráp
 </h4>
 <p className="text-slate-600 font-semibold text-[11px] leading-relaxed normal-case">
 Hệ thống phát hiện một số phụ kiện, vật tư thiết kế (BOM) có số lượng tồn kho tổng hiện tại ít hơn tổng lượng nhu cầu còn lại chưa được cấp phát của các dự án đang triển khai. Vui lòng lập phiếu nhập kho thêm các mặt hàng màu đỏ dưới đây để đảm bảo đúng tiến độ xưởng sản xuất bàn giao.
 </p>
 </div>
 </div>
 )}

 {/* Bảng danh sách vật tư BOM chi tiết */}
 <div className="bg-white border border-slate-100 rounded-xl overflow-hidden shadow-sm">
 <div className="overflow-x-auto">
 <table className="w-full text-left border-collapse">
 <thead>
 <tr className="bg-slate-100 text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-gray-100 select-none">
 <th className="px-6 py-4">Thông tin Vật tư / Phụ kiện</th>
 <th className="px-6 py-4">Mã Vật tư</th>
 <th className="px-6 py-4">Dự án yêu cầu BOM</th>
 <th className="px-6 py-4 text-center">Tồn kho hiện tại</th>
 <th className="px-6 py-4 text-center">Tình trạng Thiếu/Đủ</th>
 <th className="px-6 py-4 text-center">Cấp thiết Nhập hàng</th>
 </tr>
 </thead>
 <tbody className="divide-y divide-slate-100 text-xs font-semibold uppercase">
 {filteredBomItems.length > 0 ? (
 filteredBomItems.map((item, index) => {
 // Tổng lượng cần thiết thực tế còn thiếu chưa cấp phát của tất cả dự án
 const missingTotalInProjects = Object.values(item.projects).reduce((sum, p) => sum + Math.max(0, p.neededQty - p.issuedQty), 0);
 const remainingStockAfterBOM = item.currentStock - missingTotalInProjects;
 const hasDeficit = remainingStockAfterBOM < 0;

 return (
 <tr key={index} className="hover:bg-slate-100/20">
 {/* Thông tin vật tư */}
 <td className="px-6 py-4">
 <div className="space-y-1 normal-case font-extrabold text-slate-800 tracking-tight leading-normal">
 <span>{item.materialName}</span>
 {item.materialCode !== 'N/A' ? (
 <span className="text-[9px] font-mono text-indigo-600 bg-indigo-100 px-1.5 py-0.5 rounded-md uppercase font-black tracking-tight block w-max animate-fade-in">
 Khớp danh mục kho trung tâm
 </span>
 ) : (
 <span className="text-[9px] font-mono text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-md uppercase font-black tracking-tight block w-max font-normal">
 Vật tư bổ sung ngoài danh mục
 </span>
 )}
 </div>
 </td>

 {/* Mã vật tư */}
 <td className="px-6 py-4 font-mono font-black text-indigo-700">
 {item.materialCode}
 </td>

 {/* Danh sách dự án yêu cầu */}
 <td className="px-6 py-4 min-w-[280px]">
 <div className="space-y-2">
 {Object.entries(item.projects).map(([projCode, p]) => {
 const projRemaining = Math.max(0, p.neededQty - p.issuedQty);
 return (
 <div key={projCode} className="text-[11px] border border-slate-100 p-2 rounded-lg bg-slate-100/50 normal-case">
 <div className="flex justify-between font-bold text-slate-700 uppercase text-[10px] tracking-wide">
 <span>📁 Dự án {projCode} - {p.projectName}</span>
 </div>
 <div className="font-semibold text-slate-500 mt-1 flex justify-between">
 <span>• Nhu cầu thiết kế BOM: <strong>{p.neededQty}</strong> {item.unit}</span>
 <span>• Đồng bộ đã cấp: <strong className="text-emerald-600">{p.issuedQty}</strong> {item.unit}</span>
 </div>
 {projRemaining > 0 ? (
 <div className="text-[10px] text-rose-600 font-bold mt-0.5">
 ✓ Cần cấp tiếp: {projRemaining} {item.unit}
 </div>
 ) : (
 <div className="text-[10px] text-emerald-600 font-bold mt-0.5">
 ✓ Đã xuất đủ đầy 100%
 </div>
 )}
 </div>
 );
 })}
 </div>
 </td>

 {/* Tồn kho thực tế trong kho tổng */}
 <td className="px-6 py-4 text-center font-mono font-black text-slate-700">
 {item.currentStock} {item.unit}
 </td>

 {/* Hoạt cảnh đủ thiếu hàng */}
 <td className="px-6 py-4 text-center">
 {hasDeficit ? (
 <span className="px-2.5 py-1 bg-rose-100 text-rose-600 border border-rose-100 rounded-lg text-[10px] font-black tracking-tight uppercase inline-flex items-center gap-1">
 <AlertTriangle size={12} />
 Thiếu hụt
 </span>
 ) : (
 <span className="px-2.5 py-1 bg-emerald-100 text-emerald-600 border border-emerald-100 rounded-lg text-[10px] font-black tracking-tight uppercase inline-flex items-center gap-1">
 <CheckCircle2 size={12} />
 Sẵn sàng
 </span>
 )}
 </td>

 {/* Gợi ý Nhập hàng cảnh báo mua thêm */}
 <td className="px-6 py-4">
 {hasDeficit ? (
 <div className="text-center space-y-1">
 <p className="font-mono text-rose-600 font-black text-xs">
 -{Math.abs(remainingStockAfterBOM)} {item.unit}
 </p>
 <p className="text-[9px] text-slate-400 capitalize font-medium italic">
 khuyến nghị mua thêm tối thiểu {Math.abs(remainingStockAfterBOM)} {item.unit} để đủ sản xuất
 </p>
 </div>
 ) : (
 <p className="text-center font-bold text-slate-400 text-[10px] uppercase">
 Dư tồn +{remainingStockAfterBOM} {item.unit}
 </p>
 )}
 </td>
 </tr>
 );
 })
 ) : (
 <tr>
 <td colSpan={6} className="py-20 text-center text-slate-400 font-bold uppercase tracking-widest text-xs">
 Không tìm thấy dữ liệu BOM ăn khớp hoặc lọc tương tự
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </div>
 )}
 </motion.div>
 </AnimatePresence>

 {/* --- MODAL THÊM/SỬA MÃ VẬT TƯ TRUNG TÂM --- */}
 {showMaterialModal && (
 <div className="fixed inset-0 z-100 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs select-none">
 <motion.div 
 initial={{ opacity: 0, scale: 0.95 }}
 animate={{ opacity: 1, scale: 1 }}
 exit={{ opacity: 0, scale: 0.95 }}
 className="bg-white w-full max-w-md rounded-lg overflow-hidden border border-gray-100 shadow-xl font-semibold text-xs text-slate-700 text-left"
 >
 <div className="p-5 border-b border-gray-100 bg-slate-100 flex items-center justify-between">
 <h3 className="font-black text-slate-800 uppercase tracking-wide text-sm">
 {editingMaterial ? 'Cập nhật Vật Tư Trung Tâm' : 'Khai Báo Mã Vật Tư Mới'}
 </h3>
 <button 
 onClick={() => setShowMaterialModal(false)}
 className="p-1 text-slate-400 hover:text-slate-600 rounded-lg pointer-events-auto"
 >
 <X size={18} />
 </button>
 </div>

 <form onSubmit={handleSaveMaterial} className="p-5 space-y-4">
 
 {/* Tên vật tư */}
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Tên vật tư trung tâm <span className="text-rose-500">*</span>:</label>
 <input 
 type="text"
 placeholder="Ví dụ: Ván MDF 18mm chống ẩm chống trầy..."
 className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-bold outline-none focus:border-indigo-500"
 value={matName}
 onChange={e => setMatName(e.target.value)}
 required
 />
 </div>

 {/* DVT & Nhóm */}
 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Đơn Vị Tính (DVT):</label>
 <input 
 type="text"
 placeholder="Ví dụ: Tấm, Mét, Cái, Cuộn..."
 className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-bold outline-none focus:border-indigo-500 uppercase"
 value={matUnit}
 onChange={e => setMatUnit(e.target.value)}
 required
 />
 </div>

 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Nhóm Vật Tư:</label>
 <select
 value={matCategory}
 onChange={e => setMatCategory(e.target.value)}
 className="w-full bg-slate-100 border border-slate-200 rounded-lg px-3 py-2 font-bold text-slate-800 outline-none cursor-pointer"
 >
 {MATERIAL_CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
 </select>
 </div>
 </div>

 {/* Tồn ban sơ & Ngưỡng tối thiểu */}
 <div className="grid grid-cols-2 gap-4">
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Nhập Tồn Ban Sơ:</label>
 <input 
 type="number"
 min="0"
 placeholder="Chọn tồn khởi tạo"
 className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-mono font-black outline-none disabled:bg-gray-100 disabled:text-gray-400"
 value={matInitialStock}
 onChange={e => setMatInitialStock(Math.max(0, Number(e.target.value) || 0))}
 disabled={!!editingMaterial} // Không cho phép chỉnh tồn trực tiếp ở sửa, sửa tồn phải qua Import/Xuất/Kiểm kê
 />
 {editingMaterial && <p className="text-[9px] text-gray-400 uppercase italic font-normal">* Thay đổi tồn vui lòng lập phiếu</p>}
 </div>

 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Mức Tối Thiểu (Cảnh báo):</label>
 <input 
 type="number"
 min="0"
 className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-mono font-black outline-none"
 value={matMinStock}
 onChange={e => setMatMinStock(Math.max(0, Number(e.target.value) || 0))}
 required
 />
 </div>
 </div>

 {/* Mô tả giải trình */}
 <div className="space-y-1">
 <label className="text-xs font-black uppercase text-slate-700 block">Mô tả thêm / Định biên kĩ thuật:</label>
 <textarea 
 rows={2}
 placeholder="Ghi nhận thông số định biên hoặc chi số NCC mẫu..."
 className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg font-normal p-3 outline-none focus:border-indigo-500 normal-case"
 value={matNote}
 onChange={e => setMatNote(e.target.value)}
 />
 </div>

 {/* Nút bấm */}
 <div className="pt-3 flex gap-3">
 <button
 type="button"
 onClick={() => setShowMaterialModal(false)}
 className="flex-1 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg font-black uppercase tracking-wider text-center"
 >
 Bỏ qua
 </button>
 <button
 type="submit"
 disabled={isSubmitting}
 className="flex-1 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-black uppercase tracking-wider shadow"
 >
 {isSubmitting ? 'Đóng băng ghi...' : 'Cam kết lưu trữ'}
 </button>
 </div>
 </form>
 </motion.div>
 </div>
 )}
 </div>
 );
}
