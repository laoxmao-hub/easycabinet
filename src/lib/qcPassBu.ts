import { doc, getDoc, getDocs, updateDoc, collection, query, where } from 'firebase/firestore';
import { db, cleanUndefinedFields, handleFirestoreError, OperationType } from './firebase';
import { ProjectEntry, ModuleInstance } from '../types';
import { findModuleConfigId, findProjectConfigId } from './dualWrite';

interface UserInfo {
 uid?: string;
 email?: string;
 displayName?: string;
 ten_that?: string;
 chuc_danh?: string;
}

/**
 * Tự động pass bù các công đoạn QC cho Thùng và tất cả các module con của nó.
 * Đồng thời cập nhật trạng thái "nhận đủ" / "nhận bù" dựa trên số lượng đóng gói thực tế.
 * @param packageId ID của Thùng (ProjectEntry) cần xử lý
 * @param user thông tin user hiện tại thực hiện thao tác
 * @param loadedDbSnapshot (Tùy chọn) Danh sách toàn bộ projects lấy từ cache/state để tránh fetch DB nếu có sẵn
 */
export async function autoPassBuForPackage(
 packageId: string,
 user: UserInfo | null,
 loadedDbSnapshot?: ProjectEntry[]
): Promise<{ success: boolean; updatedCount: number; message: string }> {
 try {
 const displayLabel = user?.ten_that || user?.displayName || user?.email || 'Hệ Thống';
 const roleLabel = user?.chuc_danh || 'Admin';

 // 1. Lấy thông tin Thùng cha
 let packageEntry: ProjectEntry | undefined;
 if (loadedDbSnapshot) {
 packageEntry = loadedDbSnapshot.find(p => p.id === packageId);
 }

  if (!packageEntry) {
  const configId = await findModuleConfigId(packageId);
  if (!configId) {
  return { success: false, updatedCount: 0, message: `Không tìm thấy cấu kiện với ID ${packageId}` };
  }
  const docSnap = await getDoc(doc(db, 'projectConfigs', configId, 'modules', packageId));
  if (!docSnap.exists()) {
  return { success: false, updatedCount: 0, message: `Không tìm thấy cấu kiện với ID ${packageId}` };
  }
  packageEntry = { id: docSnap.id, ...docSnap.data() } as ProjectEntry;
  }

 // Kiểm tra xem có đúng là Thùng không
 const isThung = packageEntry.classification === 'Thùng' || 
 packageEntry.moduleCode.toLowerCase().includes('thung') ||
 (packageEntry as any).moduleType === 'thung';
 
 if (!isThung) {
 return { success: false, updatedCount: 0, message: `Cấu kiện ${packageEntry.moduleCode} không phải là loại Thùng/Kiện.` };
 }

 // 2. Tìm số lượng đã đóng gói thực tế từ collection `packing` để cập nhật "nhận đủ" / "nhận bao nhiêu nhận bấy nhiêu"
 let determinedPackedQty = packageEntry.quantity || 1;
 let foundPacking = false;
 let totalPackedCount = 0;

 try {
 const packingRef = collection(db, 'packing');
 const qPacking = query(packingRef, where('projectCode', '==', packageEntry.projectCode));
 const packingSnapshot = await getDocs(qPacking);
 
 packingSnapshot.forEach(docSnap => {
 const pl = docSnap.data();
 if (pl.items && Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 const matchId = item.id === packageId;
 const matchName = item.name && packageEntry && item.name.toLowerCase().trim() === packageEntry.moduleCode.toLowerCase().trim();
 if (matchId || matchName) {
 foundPacking = true;
 const pQty = typeof item.packedQty === 'number' ? item.packedQty : (item.packed ? item.quantity : 0);
 totalPackedCount += pQty;
 }
 });
 }
 });
 } catch (e) {
 console.error('Lỗi khi truy vấn thông tin đóng gói từ collection packing:', e);
 }

 if (foundPacking) {
 determinedPackedQty = totalPackedCount;
 }

 let updatedCount = 0;

 // 3. Cập nhật cho chính Thùng cha sang Pass tất cả các công đoạn trước (Mộc, Sơn, Ráp) và Đóng Gói
 const packageUpdateData: any = {};
 const stages: Array<'qcWhite' | 'qcPaint' | 'qcFinish' | 'qcPack'> = ['qcWhite', 'qcPaint', 'qcFinish', 'qcPack'];
 
 const nowLocalDate = new Date();
 
 // Cập nhật cho từng công đoạn chưa pass của Thùng cha
 stages.forEach(stageField => {
 const currentStage = packageEntry?.[stageField];
 if (!currentStage || currentStage.status !== 'pass') {
 packageUpdateData[stageField] = {
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 role: roleLabel,
 notes: stageField === 'qcPack' ? 'Duyệt Đóng Gói hoàn tất' : 'Tự động pass bù do hoàn tất đóng gói',
 passedQty: packageEntry?.quantity || 1
 };
 }
 });

 // Cập nhật instances của Thùng cha nếu có
 if (packageEntry.instances && Array.isArray(packageEntry.instances)) {
 const updatedInstances = packageEntry.instances.map((inst: ModuleInstance) => {
 const instCopy = { ...inst };
 stages.forEach(stageField => {
 const instStage = instCopy[stageField];
 if (!instStage || instStage.status !== 'pass') {
 instCopy[stageField] = {
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 notes: 'Tự động pass bù do hoàn tất đóng gói'
 } as any;
 }
 });
 
 // Cập nhật log
 let logs = instCopy.qcLogs || [];
 stages.forEach(stage => {
 if (!logs.some(l => l.stage === stage.replace('qc', '').toLowerCase() && l.status === 'pass')) {
 logs = logs.filter(l => l.stage !== stage.replace('qc', '').toLowerCase());
 logs.push({
 stage: stage.replace('qc', '').toLowerCase(),
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 notes: 'Tự động pass bù do hoàn tất đóng gói'
 });
 }
 });
 instCopy.qcLogs = logs;
 instCopy.qcDone = true;
 return instCopy;
 });
  packageUpdateData.instances = updatedInstances;
  }

  packageUpdateData.status = 'Đóng Gói';
 
 // Cập nhật receivedQuantity: đóng bao nhiêu nhận bấy nhiêu (nhận đủ nếu đóng đủ)
 const packageQty = packageEntry.quantity || 1;
 const finalRecQty = Math.min(packageQty, determinedPackedQty);
 packageUpdateData.receivedQuantity = finalRecQty;

 const history = [...(packageEntry.statusHistory || [])];
 const statusText = `Đóng Gói: PASS (Tự động Pass bù - ${displayLabel})`;
 if (!history.length || !history[history.length - 1].includes('PASS (Tự động Pass bù')) {
 history.push(`${statusText}|${Date.now()}`);
 }

 const prevRecQty = packageEntry.receivedQuantity || 0;
 if (finalRecQty > prevRecQty) {
 history.push(`Giao Nhận - Đã nhận ${finalRecQty}/${packageQty} (Tự động theo QC Pass bù - ${displayLabel})|${Date.now()}`);
 }
 packageUpdateData.statusHistory = history;

  const configId = await findProjectConfigId(packageEntry!.projectCode || '');
  if (configId) {
  await updateDoc(doc(db, 'projectConfigs', configId, 'modules', packageId), cleanUndefinedFields(packageUpdateData));
  }
 updatedCount++;

 // 4. Tìm tất cả các Module con sau ghép nối (parentId === Thùng cha)
 let childEntries: ProjectEntry[] = [];
 const hasAnyChildrenInSnapshot = loadedDbSnapshot && loadedDbSnapshot.some(p => p.parentId === packageId);
 const isFullSnapshot = loadedDbSnapshot && loadedDbSnapshot.length > 0 && (
 hasAnyChildrenInSnapshot || 
 loadedDbSnapshot.some(p => p.classification && p.classification !== 'Thùng')
 );

 if (isFullSnapshot) {
 childEntries = loadedDbSnapshot!.filter(p => p.parentId === packageId && p.projectCode === packageEntry?.projectCode);
 } else {
  const configId = await findProjectConfigId(packageEntry?.projectCode || '');
  if (configId) {
  const q = query(
  collection(db, 'projectConfigs', configId, 'modules'),
  where('parentId', '==', packageId),
  where('projectCode', '==', packageEntry.projectCode)
  );
  const querySnap = await getDocs(q);
  querySnap.forEach(d => {
  childEntries.push({ id: d.id, ...d.data() } as ProjectEntry);
  });
  }
 }

 // 5. Cập nhật pass bù và xác nhận nhận đủ cho tất cả các Module con đó
 for (const child of childEntries) {
 const childUpdateData: any = {};
 
 stages.forEach(stageField => {
 const currentStage = child[stageField];
 if (!currentStage || currentStage.status !== 'pass') {
 childUpdateData[stageField] = {
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 role: roleLabel,
 notes: `Tự động pass bù theo Thùng cha ${packageEntry?.moduleCode}`,
 passedQty: child.quantity || 1
 };
 }
 });

 // Cập nhật instances của con
 if (child.instances && Array.isArray(child.instances)) {
 const updatedInstances = child.instances.map((inst: ModuleInstance) => {
 const instCopy = { ...inst };
 stages.forEach(stageField => {
 const instStage = instCopy[stageField];
 if (!instStage || instStage.status !== 'pass') {
 instCopy[stageField] = {
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 notes: `Tự động pass bù theo Thùng cha ${packageEntry?.moduleCode}`
 } as any;
 }
 });
 
 let logs = instCopy.qcLogs || [];
 stages.forEach(stage => {
 if (!logs.some(l => l.stage === stage.replace('qc', '').toLowerCase() && l.status === 'pass')) {
 logs = logs.filter(l => l.stage !== stage.replace('qc', '').toLowerCase());
 logs.push({
 stage: stage.replace('qc', '').toLowerCase(),
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 notes: `Tự động pass bù theo Thùng cha ${packageEntry?.moduleCode}`
 });
 }
 });
 instCopy.qcLogs = logs;
 instCopy.qcDone = true;
 return instCopy;
 });
  childUpdateData.instances = updatedInstances;
  }

  childUpdateData.status = 'Đóng Gói';
 
 // Nhận đủ bù cho cấu kiện con
 const childQty = child.quantity || 1;
 childUpdateData.receivedQuantity = childQty;

 const childHistory = [...(child.statusHistory || [])];
 const childStatusText = `Đóng Gói: PASS (Tự động Pass bù theo Thùng cha ${packageEntry?.moduleCode})`;
 if (!childHistory.length || !childHistory[childHistory.length - 1].includes('theo Thùng cha')) {
 childHistory.push(`${childStatusText}|${Date.now()}`);
 }
 
 const currentChildRecQty = child.receivedQuantity || 0;
 if (currentChildRecQty < childQty) {
 childHistory.push(`Giao Nhận - Đã nhận ${childQty}/${childQty} (Tự động theo QC Pass bù theo Thùng cha - ${displayLabel})|${Date.now()}`);
 }
 childUpdateData.statusHistory = childHistory;

  const childConfigId = await findProjectConfigId(child.projectCode || '');
  if (childConfigId) {
  await updateDoc(doc(db, 'projectConfigs', childConfigId, 'modules', child.id), cleanUndefinedFields(childUpdateData));
  }
 updatedCount++;
 }

 return {
 success: true,
 updatedCount,
 message: `Đã tự động pass bù thành công cho Thùng ${packageEntry?.moduleCode}, cập nhật nhận đủ ${finalRecQty}/${packageQty} kiện, và hoàn thiện ${childEntries.length} cấu kiện con.`
 };
 } catch (error) {
 console.error('Error autoPassBuForPackage:', error);
 try {
 handleFirestoreError(error, OperationType.UPDATE, `projects/${packageId}`);
 } catch (e: any) {
 return { success: false, updatedCount: 0, message: e.message || String(error) };
 }
 return { success: false, updatedCount: 0, message: String(error) };
 }
}

/**
 * Tự động pass bù và xác nhận nhận đủ cho các Cấu Kiện Hoàn Thiện (CTHT) nằm trong Kiện CTHT ảo 
 * từ các packing lists của dự án.
 * @param projectCode Mã dự án cần quét (hoặc 'all' cho tất cả)
 * @param user thông tin người dùng hiện tại
 */
export async function autoPassBuForVirtualCTHT(
 projectCode: string,
 user: UserInfo | null
): Promise<{ success: boolean; updatedCount: number; message: string }> {
 try {
 const displayLabel = user?.ten_that || user?.displayName || user?.email || 'Hệ Thống';
 const roleLabel = user?.chuc_danh || 'Admin';
 const nowLocalDate = new Date();

 // 1. Tải toàn bộ danh sách `packing` để tìm các "Kiện CTHT" ảo đã đóng gói
 const packingRef = collection(db, 'packing');
 let qPacking = query(packingRef);
 if (projectCode !== 'all') {
 qPacking = query(packingRef, where('projectCode', '==', projectCode));
 }
 const packingSnapshot = await getDocs(qPacking);

 // Map lưu trữ tổng số lượng đóng gói của mỗi CTHT: keyed by `${projectCode}:::${moduleCode.toLowerCase()}`
 const cthtPackedQtyMap = new Map<string, number>();

 packingSnapshot.forEach(docSnap => {
 const pl = docSnap.data();
 const plProjCode = pl.projectCode;
 if (!plProjCode) return;

 if (pl.items && Array.isArray(pl.items)) {
 pl.items.forEach((item: any) => {
 // Kiểm tra xem có phải Kiện CTHT ảo và đã đóng gói hay chưa
 const isCthtKien = item.name && (
 item.name.startsWith('Kiện CTHT') || 
 item.name.startsWith('CTHT đóng chung') || 
 item.name.includes('CTHT đóng chung')
 );
 
 const isPacked = item.packed === true || (typeof item.packedQty === 'number' && item.packedQty > 0);

 if (isCthtKien && isPacked) {
 // Lấy các chi tiết bên trong phụ kiện kèm theo / hoặc các cấu kiện CTHT thực sự đã đóng
 const accessories = item.accessories || [];
 accessories.forEach((acc: any) => {
 if (acc.name && typeof acc.quantity === 'number') {
 const key = `${plProjCode}:::${acc.name.toLowerCase().trim()}`;
 const currentVal = cthtPackedQtyMap.get(key) || 0;
 cthtPackedQtyMap.set(key, currentVal + acc.quantity);
 }
 });
 }
 });
 }
 });

 if (cthtPackedQtyMap.size === 0) {
 return { success: true, updatedCount: 0, message: 'Không phát hiện cấu kiện CTHT nào trong các Kiện CTHT ảo đóng gói hoàn tất.' };
 }

  // 2. Tìm các project entries tương ứng là loại CTHT và tiến hành pass bù
  let allProjects: ProjectEntry[] = [];
  if (projectCode !== 'all') {
  const configId = await findProjectConfigId(projectCode);
  if (configId) {
  const snap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
  snap.forEach(d => allProjects.push({ id: d.id, ...d.data() } as ProjectEntry));
  }
  } else {
  const configsSnap = await getDocs(collection(db, 'projectConfigs'));
  for (const configDoc of configsSnap.docs) {
  const snap = await getDocs(collection(db, 'projectConfigs', configDoc.id, 'modules'));
  snap.forEach(d => allProjects.push({ id: d.id, ...d.data() } as ProjectEntry));
  }
  }

 let updatedCount = 0;
 const stages: Array<'qcWhite' | 'qcPaint' | 'qcFinish' | 'qcPack'> = ['qcWhite', 'qcPaint', 'qcFinish', 'qcPack'];

 for (const e of allProjects) {
  const isCtht = e.classification === 'CTHT' || (e.classification as string) === 'ctht';
 if (!isCtht) continue;

 const key = `${e.projectCode}:::${e.moduleCode.toLowerCase().trim()}`;
 const sumPackedQty = cthtPackedQtyMap.get(key) || 0;

 if (sumPackedQty > 0) {
 // Thực hiện pass bù các công đoạn chưa đạt cho cấu kiện hoàn thiện này
 const cthtQty = e.quantity || 1;
 const finalRecQty = Math.min(cthtQty, sumPackedQty);

 const updateData: any = {};
 stages.forEach(stageField => {
 const currentStage = e[stageField];
 if (!currentStage || currentStage.status !== 'pass') {
 updateData[stageField] = {
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 role: roleLabel,
 notes: `Tự động pass bù do nằm trong Kiện CTHT đóng gói`,
 passedQty: cthtQty
 };
 }
 });

 // Cập nhật instances
 if (e.instances && Array.isArray(e.instances)) {
 const updatedInstances = e.instances.map((inst: ModuleInstance) => {
 const instCopy = { ...inst };
 stages.forEach(stageField => {
 const instStage = instCopy[stageField];
 if (!instStage || instStage.status !== 'pass') {
 instCopy[stageField] = {
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 notes: 'Tự động pass bù theo Kiện CTHT'
 } as any;
 }
 });

 let logs = instCopy.qcLogs || [];
 stages.forEach(stage => {
 if (!logs.some(l => l.stage === stage.replace('qc', '').toLowerCase() && l.status === 'pass')) {
 logs = logs.filter(l => l.stage !== stage.replace('qc', '').toLowerCase());
 logs.push({
 stage: stage.replace('qc', '').toLowerCase(),
 status: 'pass',
 date: nowLocalDate,
 by: displayLabel,
 notes: 'Tự động pass bù theo Kiện CTHT'
 });
 }
 });
 instCopy.qcLogs = logs;
 instCopy.qcDone = true;
 return instCopy;
 });
  updateData.instances = updatedInstances;
  }

  updateData.status = 'Đóng Gói';
 
 // Cập nhật số lượng nhận đủ thực tế
 updateData.receivedQuantity = finalRecQty;

 const cthtHistory = [...(e.statusHistory || [])];
 const statusText = `Đóng Gói: PASS (Tự động Pass bù theo Kiện CTHT đóng gói - ${displayLabel})`;
 if (!cthtHistory.length || !cthtHistory[cthtHistory.length - 1].includes('Tự động Pass bù theo Kiện CTHT')) {
 cthtHistory.push(`${statusText}|${Date.now()}`);
 }

 const prevRecQty = e.receivedQuantity || 0;
 if (finalRecQty > prevRecQty) {
 cthtHistory.push(`Giao Nhận - Đã nhận ${finalRecQty}/${cthtQty} (Tự động theo QC Pass bù Kiện CTHT - ${displayLabel})|${Date.now()}`);
 }
 updateData.statusHistory = cthtHistory;

  const eConfigId = await findProjectConfigId(e.projectCode || '');
  if (eConfigId) {
  await updateDoc(doc(db, 'projectConfigs', eConfigId, 'modules', e.id), cleanUndefinedFields(updateData));
  }
 updatedCount++;
 }
 }

 return {
 success: true,
 updatedCount,
 message: `Đã tự động pass bù thành công cho ${updatedCount} cấu kiện CTHT từ các Kiện CTHT.`
 };
 } catch (error) {
 console.error('Lỗi khi chạy autoPassBuForVirtualCTHT:', error);
 return { success: false, updatedCount: 0, message: String(error) };
 }
}
