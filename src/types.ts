/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type Tab = 'stats' | 'management' | 'excel' | 'delivery' | 'timeline' | 'packing' | 'loading' | 'inventory' | 'users' | 'scanner' | 'test-code' | 'qc' | 'filter' | 'tools' | 'extensions' | 'planning' | 'customers';

export interface BusinessNotification {
 id?: string;
 title: string;
 content: string;
 type: string; // 'delivery' | 'qc' | 'mention' | etc.
 createdAt: any;
 targetUsers?: string[];
 targetRoles?: string[];
 readBy?: string[];
 linkTo?: string;
}

export interface PackingItem {
 id?: string;
 name: string;
 projectName?: string;
 quantity: number;
 packed: boolean;
 packedQty?: number;
 packedAt?: any;
  loaded?: boolean;
  loadedBy?: string;
  loadedPklCode?: string;
  loadedPklId?: string;
 imageUrl?: string; // Fallback or general image
 productImageUrl?: string;
 packingImageUrl?: string;
 photos?: string[];
 isExtra?: boolean;
 subType?: 'kienModule' | 'kienCTHT' | 'kienPhuKien';
 cluster?: string;
 hasMobileShelf?: boolean;
 shelfQuantity?: number;
 shelfChecked?: boolean;
 accessoryChecked?: boolean;
 packedBy?: string;
 accessories?: { name: string, quantity: number, checked?: boolean, entryId?: string }[];
 weight?: number;
 w?: string;
 d?: string;
 h?: string;
 instanceIndex?: number;
 totalInstances?: number;
 packStatus?: string;
 unit?: string;
 cabinetType?: string;
 savedLabelData?: {
   projectName?: string;
   unit?: string;
   area?: string;
   cabinetType?: string;
   w?: string;
   d?: string;
   h?: string;
   weight?: string;
 };
  rawQR?: string;
  createdAt?: number;
}

export interface PackingList {
 id: string;
 title: string;
 projectCode?: string;
 items: PackingItem[];
 isCompleted: boolean;
 ownerId: string;
 createdAt: any;
 formTemplate?: 'mau1' | 'mau2';
 hiddenItemIds?: string[];
}

export interface StockItem {
 id?: string;
 name: string;
 sku: string;
 category: string;
 price: number;
 quantity: number;
 imageUrl?: string;
 ownerId: string;
 createdAt: any;
 updatedAt: any;
}

export interface Accessory {
 name: string;
 quantity: number;
 issuedQuantity?: number;
 status?: string;
}

export interface ShippingOrderItem {
 id?: string;
 moduleCode?: string;
 name: string;
 quantity: number;
 totalQty?: number;
 previouslyDeliveredQty?: number;
 length?: number;
 width?: number;
 height?: number;
 depth?: number;
 pWidth?: number;
 pDepth?: number;
 pHeight?: number;
 subType?: 'kienModule' | 'kienCTHT' | 'kienPhuKien';
 cluster?: string;
 unit?: string;
 notes?: string;
 projectCode?: string;
 projectName?: string;
 checkedQty?: number; // Số lượng thực tế quét nhận
 parentId?: string;
 parentModuleCode?: string;
 isNewChildOfParent?: boolean;
 isOverReceived?: boolean;
  isUnassigned?: boolean;
  _justCreated?: boolean; // Đánh dấu module vừa tạo trong cùng batch, bỏ qua sync
  scannedInstanceIds?: string[]; // Danh sách các index/id instances được quét hoặc chọn cụ thể
  syncStatus?: 'synced' | 'unmatched' | 'unknown'; // synced=có trong phiếu giao, unmatched=không trong phiếu giao, unknown=không trong hệ thống
}

export interface ShippingOrder {
 id: string;
 type: 'receive' | 'ship';
 title?: string;
 projectCode: string;
 projectName?: string;
 sequenceNumber?: number;
 items: ShippingOrderItem[];
 createdAt: any;
 createdBy: string;
 userName: string;
 userEmail?: string;
 isChecked?: boolean; // Theo dõi nếu phiếu giao đã được kiểm hàng nhận
 linkedReceiptId?: string; // Link tới phiếu nhận hàng được tạo ra
 status?: 'pending' | 'completed'; // Trạng thái kiểm hàng (cam = pending, xanh lá = completed)
}

export interface ModuleInstance {
 id: string; // hỗ trợ backward compatibility
 instanceId: string; // "Cánh tủ|1"
 instanceIndex: number;
 tempLabelIndex: number;
 stt?: number; // Số thứ tự Tem Tạm được lưu trữ vĩnh viễn và đồng bộ
 cncid?: string; // Mã định danh CNC của cấu kiện thô
 
 // Trạng thái QC và Giao nhận
 qcDone?: boolean;
 packStatus?: string;
 delivered?: boolean;

 // Thông tin lên hàng
 loadInfo?: {
   pklId: string;
   pklCode: string;
   loadedAt: any;
   loadedBy: string;
   vehicleInfo?: string;
 };

 qcLogs?: Array<{
 stage: string; // 'white' | 'paint' | 'finish' | 'pack'
 status: 'pass' | 'fail' | 'pending';
 date: any;
 by: string;
 notes?: string;
 photos?: string[];
 }>;
 deliveryLogs?: Array<{
 type: 'receive' | 'ship';
 date: any;
 by: string;
 notes?: string;
 }>;

 // Hỗ trợ backward compatibility cho đa công đoạn nếu cần
 qcWhite?: { status: 'pending' | 'pass' | 'fail'; date: any; by: string; notes?: string; photos?: string[]; checkedCriteria?: Record<string, boolean>; criterionPhotos?: Record<string, string[]>; passedItems?: string[]; passedQty?: number };
 qcPaint?: { status: 'pending' | 'pass' | 'fail'; date: any; by: string; notes?: string; photos?: string[]; checkedCriteria?: Record<string, boolean>; criterionPhotos?: Record<string, string[]>; passedItems?: string[]; passedQty?: number };
 qcFinish?: { status: 'pending' | 'pass' | 'fail'; date: any; by: string; notes?: string; photos?: string[]; checkedCriteria?: Record<string, boolean>; criterionPhotos?: Record<string, string[]>; passedItems?: string[]; passedQty?: number };
 qcPack?: { status: 'pending' | 'pass' | 'fail'; date: any; by: string; notes?: string; photos?: string[]; checkedCriteria?: Record<string, boolean>; criterionPhotos?: Record<string, string[]>; passedItems?: string[]; passedQty?: number };
}

export function getModuleInstances(entry: ProjectEntry): ModuleInstance[] {
 if (entry.moduleType === 'bo') {
 return [];
 }
 const qty = entry.quantity || 1;
 const rawInstances = entry.instances || [];

 if (rawInstances.length === 0) {
 const list: ModuleInstance[] = [];
 const recQty = entry.receivedQuantity || 0;
 for (let i = 1; i <= qty; i++) {
 const isRec = recQty >= i;
  list.push({
  id: `${entry.moduleCode}|${i}`,
  instanceId: `${entry.moduleCode}|${i}`,
  instanceIndex: i,
  tempLabelIndex: i,
  delivered: isRec || false,
  deliveryLogs: isRec ? [{
  type: 'receive',
  date: null,
  by: 'System Migrate',
  notes: 'Migrated'
  }] : []
  });
 }
 return list;
 }

 let mapped = rawInstances.map(inst => {
 const mappedInst = {
 ...inst,
 id: inst.id || inst.instanceId,
 instanceId: inst.instanceId || inst.id
 } as ModuleInstance;

 // Đồng bộ delivered từ receivedQuantity
 const recQty = entry.receivedQuantity || 0;
 if (typeof mappedInst.instanceIndex === 'number' && recQty > 0) {
 mappedInst.delivered = recQty >= mappedInst.instanceIndex;
 }
 return mappedInst;
 });

 if (mapped.length === qty) {
 return mapped;
 }

 if (mapped.length < qty) {
 const diff = qty - mapped.length;
 const maxInstIdx = mapped.reduce((max, inst) => Math.max(max, inst.instanceIndex || 0), 0);
 const recQty = entry.receivedQuantity || 0;
 const maxLabelIdx = Math.max(qty, mapped.reduce((max, inst) => Math.max(max, inst.tempLabelIndex || 0), 0));

 for (let i = 1; i <= diff; i++) {
 const newInstIdx = maxInstIdx + i;
 const isRec = recQty >= newInstIdx;
  mapped.push({
  id: `${entry.moduleCode}|${newInstIdx}`,
  instanceId: `${entry.moduleCode}|${newInstIdx}`,
  instanceIndex: newInstIdx,
  tempLabelIndex: maxLabelIdx + i,
  delivered: isRec || false,
  qcLogs: [],
  deliveryLogs: []
  });
 }
 } else if (mapped.length > qty) {
 mapped = mapped.slice(0, qty);
 }

 return mapped;
}

export function getInstanceStageQc(inst: any, stage: 'white' | 'paint' | 'finish' | 'pack', parentEntry?: any): { status: 'pending' | 'pass' | 'fail' | 'none'; date: any; by: string; notes?: string; photos?: string[]; passedItems?: string[]; passedQty?: number } {
 const fieldMap = {
 white: 'qcWhite',
 paint: 'qcPaint',
 finish: 'qcFinish',
 pack: 'qcPack'
 };
 const directField = fieldMap[stage];
 if (inst && inst[directField] && inst[directField].status && inst[directField].status !== 'none') {
 return inst[directField];
 }
 
 if (inst && inst.qcLogs && Array.isArray(inst.qcLogs)) {
 const log = inst.qcLogs.find((l: any) => l.stage === stage);
 if (log && log.status && log.status !== 'none') {
 return {
 status: log.status || 'none',
 date: log.date || null,
 by: log.by || '',
 notes: log.notes || '',
 photos: log.photos || [],
 passedItems: log.passedItems || [],
 passedQty: log.passedQty || 0
 };
 }
  }

  // Fallback: qcDone legacy field (chỉ dùng cho finish stage)
  if (inst && stage === 'finish' && inst.qcDone) {
 // Chỉ fallback về qcDone nếu KHÔNG CÓ trường đa công đoạn nào khác (white, paint, pack) đã được ghi nhận.
 const hasAnyOtherStage = (inst.qcWhite && inst.qcWhite.status && inst.qcWhite.status !== 'none') ||
 (inst.qcPaint && inst.qcPaint.status && inst.qcPaint.status !== 'none') ||
 (inst.qcPack && inst.qcPack.status && inst.qcPack.status !== 'none');
 
 // Nếu có qcLogs cho khâu khác
 const hasOtherLogs = inst.qcLogs && Array.isArray(inst.qcLogs) && inst.qcLogs.some((l: any) => l.stage !== 'finish');

 if (!hasAnyOtherStage && !hasOtherLogs) {
 return {
 status: 'pass',
 date: inst.qcDate || null,
 by: inst.qcBy || '',
 notes: inst.qcNotes || '',
 photos: inst.qcPhotos || [],
 passedItems: inst.passedItems || [],
 passedQty: inst.passedQty || 0
 };
 }
 }

 return { status: 'none', date: null, by: '' };
}

export function syncModuleInstances(currentInstances: ModuleInstance[] | undefined, targetQty: number, moduleCode: string, fallbackEntry?: any): { instances: ModuleInstance[]; maxLabelIndex: number } {
 let instances: ModuleInstance[] = [];
 let maxLabelIndex = fallbackEntry?.maxLabelIndex || 0;

 if (currentInstances && currentInstances.length > 0) {
 instances = currentInstances.map(inst => ({
 ...inst,
 id: inst.id || inst.instanceId,
 instanceId: inst.instanceId || inst.id
 }));
 } else {
 const currentQty = fallbackEntry?.quantity || targetQty || 1;
 for (let i = 1; i <= currentQty; i++) {
 const isRec = (fallbackEntry?.receivedQuantity || 0) >= i;
  instances.push({
  id: `${moduleCode}|${i}`,
  instanceId: `${moduleCode}|${i}`,
  instanceIndex: i,
  tempLabelIndex: i,
  delivered: isRec || false,
  deliveryLogs: isRec ? [{
  type: 'receive',
  date: null,
  by: 'System Migrate',
  notes: 'Migrated'
  }] : []
  });
 }
 if (maxLabelIndex < currentQty) {
 maxLabelIndex = currentQty;
 }
 }

 // Tìm max thực tế trong instances hiện tại
 const actualMaxLabelIdx = instances.reduce((max, inst) => Math.max(max, inst.tempLabelIndex), 0);
 if (maxLabelIndex < actualMaxLabelIdx) {
 maxLabelIndex = actualMaxLabelIdx;
 }

 if (targetQty === instances.length) {
 return { instances, maxLabelIndex };
 }

 if (targetQty > instances.length) {
 const diff = targetQty - instances.length;
 const maxInstIdx = instances.reduce((max, inst) => Math.max(max, inst.instanceIndex), 0);
 
 for (let i = 1; i <= diff; i++) {
 const newInstIdx = maxInstIdx + i;
 maxLabelIndex = maxLabelIndex + 1;
 instances.push({
 id: `${moduleCode}|${newInstIdx}`,
 instanceId: `${moduleCode}|${newInstIdx}`,
 instanceIndex: newInstIdx,
 tempLabelIndex: maxLabelIndex,
 qcDone: false,
 delivered: false,
 qcLogs: [],
 deliveryLogs: []
 });
 }
 } else if (targetQty < instances.length) {
 instances = instances.slice(0, targetQty);
 }

 return { instances, maxLabelIndex };
}

export function convertProjectEntryType(entry: ProjectEntry, targetType: 'normal' | 'bo'): ProjectEntry {
 if (targetType === 'bo') {
  return {
  ...entry,
  moduleType: 'bo',
  instances: null as any,
  maxLabelIndex: null as any,
  receivedQuantity: 0,
  shippedQuantity: 0,
  };
 } else {
 const qty = entry.quantity || 1;
 const newInstances: ModuleInstance[] = [];
 for (let i = 1; i <= qty; i++) {
 newInstances.push({
 id: `${entry.moduleCode}|${i}`,
 instanceId: `${entry.moduleCode}|${i}`,
 instanceIndex: i,
 tempLabelIndex: i,
 qcDone: false,
 delivered: false,
 qcLogs: [],
 deliveryLogs: []
 });
 }
  return {
  ...entry,
  moduleType: 'normal',
  instances: newInstances,
  maxLabelIndex: qty,
  receivedQuantity: 0,
  shippedQuantity: 0,
  };
 }
}

export interface ProjectConfig {
 id: string;
 projectName: string;
 projectCode: string;
 rawPartsData?: { name: string; width: number; depth: number; height: number; quantity: number; material: string }[];
 createdAt: any;
 updatedAt?: any;
 createdBy?: string;
 isCompleted?: boolean;
 completedAt?: any;
}

export interface ProjectEntry {

 id: string;
 configId?: string;
 stt?: number; // Số thứ tự vĩnh viễn (dạng bộ hoặc cấu kiện mẹ)
 projectName: string;
 projectCode: string;
 drawingUrl?: string;
 assemblyDrawingUrl?: string;
 glbUrl?: string;
 cluster: string;
 material?: string;
 moduleCode: string;
 quantity: number;
 length?: number;
 width?: number;
 height?: number;
 depth?: number;
 pWidth?: number;
 pDepth?: number;
 parentId?: string;
 parentModuleCode?: string;
 isChild?: boolean;
 assemblyQuantity?: number;
 pHeight?: number;
 receivedQuantity?: number;
 shippedQuantity?: number;
 accessories?: Accessory[];
 status?: string;
 area?: string;
 unit?: string;
 classification?: 'Thùng' | 'Cánh' | 'Đợt' | 'Mặt HK' | 'CTHT' | 'Gia công ngoài' | 'Gia Công Ngoài' | 'Len, Filler' | 'Đợt di động';
 statusHistory?: string[];
 ownerId: string;
  createdAt: any;
  sortIndex?: number;
  projectOrder?: number;

  // Instance tracking info
  moduleType?: 'normal' | 'bo';
  instances?: ModuleInstance[];
  maxLabelIndex?: number;
  isCompleted?: boolean;
  completedAt?: any;

  // QC properties accessed directly on ProjectEntry in legacy screens
  qcWhite?: any;
  qcPaint?: any;
  qcFinish?: any;
  qcPack?: any;
  qcPhotos?: string[];
  qcBy?: string;
  qcPass?: boolean;
  qcStatus?: string;
  qcNotes?: string;

  // Tên hiển thị & tên object 3D chỉnh thủ công (lưu trong data project)
  displayName?: string; // Tên hiển thị — thay cho tên module trong danh sách module
  objectName?: string; // Tên object trong mô hình 3D — thay cho moduleCode khi khớp 3D
  objectClusterName?: string; // Tên cụm object trong mô hình 3D — thay cho cluster khi khớp 3D theo cụm
  cameraAngle?: number; // Góc camera (độ 0-360) — xoay camera quanh object khi xem 3D module đơn lẻ (0° = góc mặc định, + = theo chiều kim đồng hồ nhìn từ trên)
}

export interface ActivityLog {
 id: string;
 userName: string;
 userEmail: string;
 action: string;
 details: string;
 timestamp: any;
 projectCode?: string;
 moduleCode?: string;
}

export interface UserProfile {
 uid: string;
 displayName: string;
 name?: string;
 email: string;
 phone?: string;
 photoURL?: string;
 chuc_danh?: string;
 ten_that?: string;
 role?: string;
 roles?: string[];
 lastActive?: any;
}

export interface ChatMessage {
 id?: string;
 content: string;
 senderId: string;
 senderName: string;
 senderTitle?: string;
 senderPhoto?: string | null;
 createdAt: any;
 taggedUsers?: string[] | null;
}

export interface PrivateMessage {
 id?: string;
 content: string;
 senderId: string;
 senderName: string;
 senderTitle?: string;
 senderPhoto?: string;
 receiverId: string;
 createdAt: any;
}

export interface ActivityFilter {
 projectCode: string;
 userEmail: string;
 startDate: string;
 endDate: string;
}

export interface ManagementScreenProps {
 items: StockItem[];
 projectEntries: ProjectEntry[];
 setProjectEntries?: (entries: ProjectEntry[] | ((prev: ProjectEntry[]) => ProjectEntry[])) => void;
 selectedProject: string | null;
 setSelectedProject: (code: string | null) => void;
 loading: boolean;
 isSelectMode: boolean;
 setIsSelectMode: (m: boolean) => void;
 selectedModuleIds: string[];
 setSelectedModuleIds: (ids: string[] | ((prev: string[]) => string[])) => void;
 showBulkModal: boolean;
 setShowBulkModal: (b: boolean) => void;
 setHeaderContent?: (content: { backButton?: React.ReactNode; title?: React.ReactNode; actions?: React.ReactNode } | null) => void;
 qcTickets?: any[];
}

/**
 * Trình khớp từ khóa chính xác / phân biệt phân cấp các đoạn số (ví dụ: khớp "t1" nhưng không khớp "t10", "t11", "t12").
 * Nếu từ khóa kết thúc bằng chữ số, ta đảm bảo trùng khớp với số đó ở chuỗi gốc không bị đuôi chữ số khác lấn áp.
 */
export function matchSearchQuery(text: string, query: string): boolean {
 if (!text || !query) return false;
 const t = text.trim().toLowerCase();
 const q = query.trim().toLowerCase();
 if (!t.includes(q)) return false;

 const lastChar = q[q.length - 1];
 if (lastChar >= '0' && lastChar <= '9') {
 let idx = t.indexOf(q);
 while (idx !== -1) {
 const nextChar = t[idx + q.length];
 const isDigit = nextChar >= '0' && nextChar <= '9';
 if (!isDigit) {
 return true;
 }
 idx = t.indexOf(q, idx + 1);
 }
 return false;
 }

 return true;
}

export interface PKLOrder {
 id?: string;
 pklCode: string;
 projectId: string;
 projectCodes?: string[];
 projectName: string;
 vehicleInfo: string;
 driverName: string;
 note: string;
 status: 'open' | 'closed';
 createdBy: string;
 createdByEmail: string;
 createdAt: any;
 packageIds?: string[];
 overallImages?: string[];
}

export interface LoadingHistory {
 id?: string;
 packageId: string;
 packageName: string;
 pklId: string;
 pklCode: string;
 loadedBy: string;
 loadedAt: any;
 verificationImages: string[];
}

export interface Material {
 id?: string;
 code: string;
 name: string;
 unit: string;
 category: string;
 currentStock: number;
 minStock?: number;
 createdAt: any;
 note?: string;
 status?: 'active' | 'inactive';
}

export interface StockTransaction {
 id?: string;
 materialId: string;
 materialName?: string;
 materialCode?: string;
 unit?: string;
 type: 'IMPORT_INITIAL' | 'IN' | 'OUT_PROJECT' | 'OUT_OTHER' | 'STOCK_ADJUSTMENT';
 quantity: number;
 stockBefore: number;
 stockAfter: number;
 projectId?: string;
 projectCode?: string;
 referenceId?: string;
 note?: string;
 createdBy: string;
 createdByEmail?: string;
 createdAt: any;
}

export interface StockReceiptItem {
 materialId: string;
 materialCode: string;
 materialName: string;
 unit: string;
 quantity: number;
 price?: number;
 amount?: number;
}

export interface StockReceipt {
 id?: string;
 receiptCode: string;
 supplier: string;
 deliveryPerson?: string;
 receiverPerson?: string;
 note?: string;
 attachmentUrl?: string;
 items: StockReceiptItem[];
 createdBy: string;
 createdByEmail?: string;
 createdAt: any;
}

export interface StockIssueItem {
 materialId: string;
 materialCode: string;
 materialName: string;
 unit: string;
 currentStock: number;
 requestedQty: number;
 actualQty: number;
}

export interface StockIssue {
 id?: string;
 issueCode: string;
 projectId: string;
 projectCode: string;
 projectName?: string;
 subCategory?: string;
 requester?: string;
 issuer?: string;
 note?: string;
 items: StockIssueItem[];
 createdBy: string;
 createdByEmail?: string;
 createdAt: any;
}

export interface StockRequestItem {
 materialId: string;
 materialCode: string;
 materialName: string;
 unit: string;
 requestedQty: number;
 approvedQty?: number;
}

export interface StockRequest {
 id?: string;
 requestCode?: string;
 projectId: string;
 projectCode: string;
 projectName?: string;
 stage?: string;
 note?: string;
 status: 'PENDING' | 'APPROVED' | 'PARTIAL' | 'REJECTED';
 items: StockRequestItem[];
 requestedBy: string;
 requestedByEmail?: string;
 approvedBy?: string;
 approvedByEmail?: string;
 approvedAt?: any;
 createdAt: any;
 linkedIssueId?: string;
}

// === QC Instance Helpers ===

const QC_STAGE_FIELDS = { white: 'qcWhite', paint: 'qcPaint', finish: 'qcFinish', pack: 'qcPack' } as const;

type QcStageId = keyof typeof QC_STAGE_FIELDS;

export function getQcStageField(stageId: QcStageId): string {
 return QC_STAGE_FIELDS[stageId] || '';
}

export type QcFieldKey = 'qcWhite' | 'qcPaint' | 'qcFinish' | 'qcPack';

export function getQcFieldForStage(stageId: QcStageId): QcFieldKey {
 return QC_STAGE_FIELDS[stageId];
}

/**
 * Lấy trạng thái QC tổng hợp từ instances của module.
 * Trả về status ưu tiên: có fail → fail, tất cả pass → pass, còn lại → pending/none
 */
export function getModuleQcAggregate(entry: ProjectEntry, stageId: QcStageId): { status: string; by?: string; date?: any; notes?: string; photos?: string[]; passedItems?: string[]; passedQty?: number } | null {
 const rootField = QC_STAGE_FIELDS[stageId] as QcFieldKey;
 const rootData = entry[rootField];

 const instances = getModuleInstances(entry);
 if (instances.length === 0) {
  return rootData ? {
   status: rootData.status,
   by: rootData.by,
   date: rootData.date,
   notes: rootData.notes,
   photos: rootData.photos,
   passedItems: rootData.passedItems,
   passedQty: rootData.passedQty
  } : null;
 }

 const statuses = instances.map(inst => (inst as any)[rootField]?.status || 'none');

 if (statuses.length === 0) return null;

 const hasFail = statuses.some(s => s === 'fail');
 const allPass = statuses.every(s => s === 'pass');

 if (hasFail) {
  const firstFail = instances.find(inst => (inst as any)[rootField]?.status === 'fail');
  const qcData = firstFail ? (firstFail as any)[rootField] : null;
  return {
   status: 'fail',
   by: qcData?.by,
   date: qcData?.date,
   notes: qcData?.notes,
   photos: qcData?.photos,
   passedItems: qcData?.passedItems,
   passedQty: qcData?.passedQty
  };
 }

 if (allPass) {
  const first = instances.find(inst => (inst as any)[rootField]?.status === 'pass');
  const qcData = first ? (first as any)[rootField] : null;
  return {
   status: 'pass',
   by: qcData?.by,
   date: qcData?.date,
   notes: qcData?.notes,
   photos: qcData?.photos,
   passedItems: qcData?.passedItems,
   passedQty: qcData?.passedQty
  };
 }

 const hasAnyQc = statuses.some(s => s === 'pass' || s === 'pending');
 if (hasAnyQc) {
  const firstActive = instances.find(inst => {
   const s = (inst as any)[rootField]?.status;
   return s === 'pass' || s === 'pending';
  });
  const qcData = firstActive ? (firstActive as any)[rootField] : null;
  return {
   status: 'pending',
   by: qcData?.by,
   date: qcData?.date,
   notes: qcData?.notes,
   photos: qcData?.photos,
   passedItems: qcData?.passedItems,
   passedQty: qcData?.passedQty
  };
 }

 return { status: 'none' };
}

/**
 * Cập nhật QC trên instance cụ thể trong mảng instances.
 * Trả về mảng instances mới đã cập nhật.
 */
export function updateInstanceQc(
 instances: ModuleInstance[],
 instanceId: string,
 stageId: QcStageId,
 qcData: any
): ModuleInstance[] {
 const field = QC_STAGE_FIELDS[stageId];
 return instances.map(inst => {
 if (inst.id === instanceId || inst.instanceId === instanceId) {
 return { ...inst, [field]: qcData };
 }
 return inst;
 });
}

/**
 * Cập nhật QC trên tất cả instances (dùng khi pass/fail đồng loạt).
 */
export function updateAllInstancesQc(
 instances: ModuleInstance[],
 stageId: QcStageId,
 qcData: any,
 filter?: (inst: ModuleInstance) => boolean
): ModuleInstance[] {
 const field = QC_STAGE_FIELDS[stageId];
 return instances.map(inst => {
 if (filter && !filter(inst)) return inst;
 return { ...inst, [field]: qcData };
 });
}

export interface Task {
  id?: string;
  title: string;
  department: 'Sơn' | 'Lắp Ráp' | 'Đóng Gói';
  notes: string[];
  isCompleted: boolean;
  completedAt?: any;
  dueDate?: string; // Format: YYYY-MM-DD
  priority: 'low' | 'medium' | 'high';
  createdBy: string;
  createdByEmail: string;
  createdAt: any;
}

export interface CalendarNote {
  id?: string;
  date: string; // Format: YYYY-MM-DD
  note: string;
  createdBy: string;
  createdByEmail: string;
  createdAt: any;
}

export interface CustomerProject {
  code: string;
  subCodes: string[];
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  loginId?: string;
  loginPass?: string;
  projects: CustomerProject[];
  type?: 'customer' | 'worksite';
  note?: string;
  createdBy: string;
  createdAt: any;
  updatedAt?: any;
}

