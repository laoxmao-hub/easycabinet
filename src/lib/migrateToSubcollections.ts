import { collection, getDocs, addDoc, setDoc, writeBatch, doc, updateDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

/**
 * Xóa TOÀN BỘ projectConfigs + subcollection modules
 */
export async function deleteAllProjectConfigs(
 onProgress?: (msg: string) => void
) {
 const log = onProgress || console.log;

 const configsSnap = await getDocs(collection(db, 'projectConfigs'));
 log(`Tìm thấy ${configsSnap.docs.length} projectConfigs cần xóa`);

 for (const configDoc of configsSnap.docs) {
 // Xóa toàn bộ modules subcollection
 const modulesSnap = await getDocs(collection(db, 'projectConfigs', configDoc.id, 'modules'));
 const batch = writeBatch(db);
 modulesSnap.docs.forEach(modDoc => batch.delete(modDoc.ref));
 await batch.commit();

 // Xóa config doc
 await deleteDoc(doc(db, 'projectConfigs', configDoc.id));
 log(`Đã xóa ${configDoc.id} (${modulesSnap.docs.length} modules)`);
 }

 log(`Hoàn tất! Đã xóa toàn bộ projectConfigs`);
}

/**
 * Xóa projectConfigs rồi mirror lại từ projects (full re-mirror)
 */
export async function fullReMirrorProjects(
 onProgress?: (msg: string) => void
) {
 const log = onProgress || console.log;

 // Phase 1: Xóa sạch
 log('=== PHASE 1: Xóa projectConfigs ===');
 await deleteAllProjectConfigs(log);

 // Phase 2: Mirror lại
 log('=== PHASE 2: Mirror từ projects ===');
 const count = await migrateAllProjectsToConfigs(log);

 log(`=== HOÀN TẤT! Đã mirror lại ${count} dự án ===`);
 return count;
}

export async function migrateAllProjectsToConfigs(
 onProgress?: (msg: string) => void
) {
 const log = onProgress || console.log;

 // 1. Đọc toàn bộ projects
 const projectsSnap = await getDocs(collection(db, 'projects'));
 const allEntries = projectsSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
 log(`Đọc xong ${allEntries.length} module entries từ projects`);

 // 2. Group theo projectCode
 const grouped = new Map<string, any[]>();
 allEntries.forEach(entry => {
 const key = entry.projectCode || 'unknown';
 if (!grouped.has(key)) grouped.set(key, []);
 grouped.get(key)!.push(entry);
 });
 log(`Phát hiện ${grouped.size} dự án`);

 // 3. Mirror từng dự án
 let migratedCount = 0;
 for (const [projectCode, modules] of grouped) {
 const firstModule = modules[0];
 const projectName = firstModule?.projectName || projectCode;

 // Tạo projectConfigs — dùng projectCode làm document ID
 await setDoc(doc(db, 'projectConfigs', projectCode), {
 projectName,
 projectCode,
 glbUrl: firstModule?.glbUrl || '',
 drawingUrl: firstModule?.drawingUrl || '',
 assemblyDrawingUrl: firstModule?.assemblyDrawingUrl || '',
 rawPartsData: [],
 createdAt: serverTimestamp(),
 createdBy: 'migration'
 }, { merge: true });

 // Mirror modules vào subcollection
 const batch = writeBatch(db);
 modules.forEach(mod => {
 const moduleRef = doc(collection(db, 'projectConfigs', projectCode, 'modules'));
 batch.set(moduleRef, {
 moduleCode: mod.moduleCode || '',
 cluster: mod.cluster || '',
 quantity: mod.quantity || 1,
 classification: mod.classification || '',
 width: mod.width || 0,
 depth: mod.depth || 0,
 height: mod.height || 0,
 pWidth: mod.pWidth || 0,
 pDepth: mod.pDepth || 0,
 pHeight: mod.pHeight || 0,
 accessories: mod.accessories || [],
 material: mod.material || '',
 notes: mod.notes || '',
 status: mod.status || '',
 statusHistory: mod.statusHistory || [],
 receivedQuantity: mod.receivedQuantity || 0,
 shippedQuantity: mod.shippedQuantity || 0,
 qcStatus: mod.qcStatus || '',
 qcNotes: mod.qcNotes || '',
 qcPhotos: mod.qcPhotos || [],
 qcBy: mod.qcBy || '',
 qcDate: mod.qcDate || null,
 qcRole: mod.qcRole || '',
 qcPass: mod.qcPass ?? null,
 qcWhite: mod.qcWhite || null,
 qcPaint: mod.qcPaint || null,
 qcFinish: mod.qcFinish || null,
 qcPack: mod.qcPack || null,
 parentId: mod.parentId || '',
 parentModuleCode: mod.parentModuleCode || '',
 sortIndex: mod.sortIndex || 0,
 instances: mod.instances || [],
 maxLabelIndex: mod.maxLabelIndex || mod.quantity || 1,
 moduleType: mod.moduleType || 'normal',
 stt: mod.stt || null,
 });
 });
 await batch.commit();

 migratedCount++;
 log(`[${migratedCount}/${grouped.size}] ${projectCode}: ${modules.length} modules → projectConfigs/${projectCode}`);
 }

 log(`Hoàn tất! Đã mirror ${migratedCount} dự án sang projectConfigs`);
 return migratedCount;
}

/**
 * Full re-sync: cập nhật TOÀN BỘ fields bị thiếu
 * - Project-level fields → config doc (glbUrl, drawingUrl, assemblyDrawingUrl)
 * - Module-level fields → modules subcollection (receivedQuantity, status, classification...)
 */
export async function syncMissingFieldsToProjectConfigs(
 onProgress?: (msg: string) => void
) {
 const log = onProgress || console.log;

 // 1. Đọc toàn bộ projects (nguồn ground truth)
 const projectsSnap = await getDocs(collection(db, 'projects'));
 const allProjects = projectsSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
 log(`Đọc xong ${allProjects.length} entries từ projects`);

 // Tạo map lookup theo moduleCode + projectCode
 const legacyMap = new Map<string, any>();
 allProjects.forEach((p: any) => {
 const key = `${p.projectCode}|${(p.moduleCode || '').toLowerCase()}`;
 legacyMap.set(key, p);
 });

 // 2. Duyệt qua tất cả projectConfigs
 const configsSnap = await getDocs(collection(db, 'projectConfigs'));
 let configUpdated = 0;
 let moduleUpdated = 0;

 for (const configDoc of configsSnap.docs) {
 const config = configDoc.data();
 const projectCode = config.projectCode;

 // === Sync project-level fields lên config doc ===
 const legacySample = allProjects.find((p: any) => p.projectCode === projectCode);
 if (legacySample) {
 const projectFields: Record<string, any> = {};
 for (const field of ['glbUrl', 'drawingUrl', 'assemblyDrawingUrl']) {
 if (legacySample[field] && (!config[field] || config[field] === '')) {
 projectFields[field] = legacySample[field];
 }
 }
 if (Object.keys(projectFields).length > 0) {
 await updateDoc(doc(db, 'projectConfigs', configDoc.id), projectFields);
 configUpdated++;
 }
 }

 // === Sync module-level fields vào modules subcollection ===
 const modulesSnap = await getDocs(collection(db, 'projectConfigs', configDoc.id, 'modules'));
 const syncBatch = writeBatch(db);
 let batchOps = 0;

 for (const modDoc of modulesSnap.docs) {
 const mod = modDoc.data();
 const key = `${projectCode}|${(mod.moduleCode || '').toLowerCase()}`;
 const legacy = legacyMap.get(key);
 if (!legacy) continue;

 const fieldsToSync: Record<string, any> = {};
 const moduleLevelFields = [
 'receivedQuantity', 'shippedQuantity', 'status', 'statusHistory',
 'classification', 'sortIndex', 'moduleType', 'stt',
 'parentId', 'parentModuleCode', 'instances', 'maxLabelIndex',
 'qcStatus', 'qcNotes', 'qcPhotos', 'qcBy', 'qcDate', 'qcRole', 'qcPass',
 'qcWhite', 'qcPaint', 'qcFinish', 'qcPack',
 'accessories', 'material', 'notes',
 ];

 for (const field of moduleLevelFields) {
 const legacyVal = legacy[field];
 const configVal = mod[field];
 const isMissing = configVal === undefined || configVal === null ||
 configVal === '' || configVal === 0 ||
 (typeof configVal === 'object' && !Array.isArray(configVal) && JSON.stringify(configVal) === '{}') ||
 (Array.isArray(configVal) && configVal.length === 0);

 if (legacyVal !== undefined && legacyVal !== null && isMissing) {
 fieldsToSync[field] = legacyVal;
 }
 }

 if (Object.keys(fieldsToSync).length > 0) {
 syncBatch.update(modDoc.ref, fieldsToSync);
 batchOps++;
 }
 }

 if (batchOps > 0) {
 await syncBatch.commit();
 moduleUpdated += batchOps;
 log(`[${projectCode}] Sync ${batchOps} modules`);
 }
 }

 log(`Hoàn tất! Config sync: ${configUpdated}, Module sync: ${moduleUpdated}`);
 return { configUpdated, moduleUpdated };
}
