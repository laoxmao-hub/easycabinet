import { collection, doc, updateDoc, addDoc, deleteDoc, writeBatch, serverTimestamp, query, where, getDocs, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { ProjectEntry } from '../types';

// Fields project-level — lưu trên config doc, spread xuống modules khi đọc
const PROJECT_LEVEL_FIELDS = ['glbUrl', 'drawingUrl', 'assemblyDrawingUrl', 'projectName', 'projectOrder'];

function extractProjectLevelFields(data: Record<string, any>): Record<string, any> {
 const result: Record<string, any> = {};
 for (const key of PROJECT_LEVEL_FIELDS) {
  if (key in data) result[key] = data[key];
 }
 return result;
}

/**
 * Write helper: ghi vào projectConfigs/modules + projectConfigs/{configId}.
 * App đọc từ projectConfigs/modules — ghi vào đó là bắt buộc.
 */

let cachedEntries: ProjectEntry[] | null = null;

export function setProjectEntriesCache(entries: ProjectEntry[]) {
 cachedEntries = entries;
}

function findConfigId(moduleId: string, projectCode?: string): string | undefined {
 if (cachedEntries) {
  const match = cachedEntries.find(e => e.id === moduleId || e.moduleCode === moduleId);
  if (match?.configId) return match.configId;
 }
 if (cachedEntries && projectCode) {
  const match = cachedEntries.find(e => e.projectCode === projectCode && e.configId);
  if (match?.configId) return match.configId;
 }
 return undefined;
}

export async function updateProjectModule(
 moduleId: string,
 data: Record<string, any>,
 projectCode?: string
) {
 let configId = findConfigId(moduleId, projectCode);
 if (!configId && projectCode) {
  configId = await findProjectConfigId(projectCode);
 }
 if (!configId) {
  console.warn('[dualWrite] configId not found for moduleId:', moduleId);
  return;
 }

 const projectFields = extractProjectLevelFields(data);
 const moduleFields = { ...data };
 for (const key of Object.keys(projectFields)) {
  delete moduleFields[key];
 }

 const configPayload: Record<string, any> = { ...projectFields, _lastModuleUpdate: serverTimestamp() };
 const tasks: Promise<void>[] = [
  updateDoc(doc(db, 'projectConfigs', configId), configPayload).catch(e => {
   console.warn('[dualWrite] projectConfigs config update failed:', e.message);
  })
 ];

 if (Object.keys(moduleFields).length > 0) {
  tasks.push(updateDoc(doc(db, 'projectConfigs', configId, 'modules', moduleId), moduleFields).catch(e => {
   console.warn('[dualWrite] projectConfigs module update failed:', e.message);
  }));
 }

 await Promise.allSettled(tasks);
}

export async function addProjectModule(
 configId: string,
 data: Record<string, any>
) {
 return addDoc(collection(db, 'projectConfigs', configId, 'modules'), data);
}

export async function addProjectAccessory(
 configId: string,
 data: Record<string, any>
) {
 const result = await addDoc(collection(db, 'projectConfigs', configId, 'modules'), data);
 await updateDoc(doc(db, 'projectConfigs', configId), { _lastModuleUpdate: serverTimestamp() }).catch(() => {});
 return result;
}

export async function deleteProjectModule(
 moduleId: string,
 projectCode?: string
) {
 let configId = findConfigId(moduleId, projectCode);
 if (!configId && projectCode) {
  configId = await findProjectConfigId(projectCode);
 }
 if (!configId) {
  console.warn('[dualWrite] configId not found for delete, moduleId:', moduleId);
  return;
 }

 await Promise.allSettled([
  deleteDoc(doc(db, 'projectConfigs', configId, 'modules', moduleId)).catch(() => {}),
  updateDoc(doc(db, 'projectConfigs', configId), { _lastModuleUpdate: serverTimestamp() }).catch(() => {})
 ]);
}

export async function deleteProjectConfigAndModules(projectCode: string) {
 const configId = await findProjectConfigId(projectCode);
 if (!configId) return;

 const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
 const batch = writeBatch(db);
 modulesSnap.docs.forEach(modDoc => {
  batch.delete(modDoc.ref);
 });
 batch.delete(doc(db, 'projectConfigs', configId));
 await batch.commit();
}

export async function findProjectConfigId(projectCode: string): Promise<string | null> {
 // Ưu tiên: query theo field projectCode bên trong document
 const q = query(collection(db, 'projectConfigs'), where('projectCode', '==', projectCode));
 const snap = await getDocs(q);
 if (!snap.empty) return snap.docs[0].id;

 // Fallback: document ID trùng projectCode (legacy)
 const directDoc = await getDoc(doc(db, 'projectConfigs', projectCode)).catch(() => null);
 if (directDoc?.exists()) return projectCode;

 return null;
}

export async function findModuleConfigId(moduleId: string): Promise<string | null> {
 if (cachedEntries) {
  const match = cachedEntries.find(e => e.id === moduleId);
  if (match?.configId) return match.configId;
 }
 const configsSnap = await getDocs(collection(db, 'projectConfigs'));
 for (const configDoc of configsSnap.docs) {
  const modSnap = await getDoc(doc(db, 'projectConfigs', configDoc.id, 'modules', moduleId));
  if (modSnap.exists()) return configDoc.id;
 }
 return null;
}

 export async function batchUpdateProjectModules(
  updates: { moduleId: string; data: Record<string, any>; projectCode?: string }[]
 ) {
  const configUpdates = new Map<string, { moduleId: string; moduleData: Record<string, any> }[]>();
  const configLevelUpdates = new Map<string, Record<string, any>>();
  const unmatchedByProject = new Map<string, { moduleId: string; data: Record<string, any> }[]>();

  updates.forEach(({ moduleId, data, projectCode }) => {
   let configId = findConfigId(moduleId, projectCode);
   if (!configId && projectCode) {
   if (!unmatchedByProject.has(projectCode)) unmatchedByProject.set(projectCode, []);
   unmatchedByProject.get(projectCode)!.push({ moduleId, data });
   return;
  }
  if (!configId) return;

  const projectFields = extractProjectLevelFields(data);
  const moduleFields = { ...data };
  for (const key of Object.keys(projectFields)) {
   delete moduleFields[key];
  }

  if (Object.keys(projectFields).length > 0) {
   const existing = configLevelUpdates.get(configId) || {};
   configLevelUpdates.set(configId, { ...existing, ...projectFields });
  }

  if (Object.keys(moduleFields).length > 0) {
   if (!configUpdates.has(configId)) configUpdates.set(configId, []);
   configUpdates.get(configId)!.push({ moduleId, moduleData: moduleFields });
  }
 });

 // Fallback: resolve unmatched — try findModuleConfigId first, then findProjectConfigId
 for (const [projectCode, items] of unmatchedByProject) {
  for (const { moduleId, data } of items) {
   // Try to find the correct config by moduleId directly
   let resolvedConfigId = await findModuleConfigId(moduleId);
   if (!resolvedConfigId) {
    resolvedConfigId = await findProjectConfigId(projectCode);
   }
  if (!resolvedConfigId) continue;
   const projectFields = extractProjectLevelFields(data);
   const moduleFields = { ...data };
   for (const key of Object.keys(projectFields)) {
    delete moduleFields[key];
   }
   if (Object.keys(projectFields).length > 0) {
    const existing = configLevelUpdates.get(resolvedConfigId) || {};
    configLevelUpdates.set(resolvedConfigId, { ...existing, ...projectFields });
   }
   if (Object.keys(moduleFields).length > 0) {
    if (!configUpdates.has(resolvedConfigId)) configUpdates.set(resolvedConfigId, []);
    configUpdates.get(resolvedConfigId)!.push({ moduleId, moduleData: moduleFields });
   }
  }
 }

 // Ghi project-level fields lên config docs
 const writeErrors: Error[] = [];
 for (const [configId, fields] of configLevelUpdates) {
  try {
   await updateDoc(doc(db, 'projectConfigs', configId), { ...fields, _lastModuleUpdate: serverTimestamp() });
  } catch (e: any) {
   console.error('[dualWrite] batchUpdate projectConfigs config failed:', e.message);
   writeErrors.push(e);
  }
 }

 // Ghi module-level fields + _lastModuleUpdate vào CÙNG BATCH
 const allAffectedConfigIds = new Set<string>([...configLevelUpdates.keys(), ...configUpdates.keys()]);
 for (const configId of allAffectedConfigIds) {
  const batch = writeBatch(db);

  // Ghi module-level fields
  const items = configUpdates.get(configId) || [];
  items.forEach(({ moduleId, moduleData }) => {
   batch.set(doc(db, 'projectConfigs', configId, 'modules', moduleId), moduleData, { merge: true });
  });

  // Ghi _lastModuleUpdate cùng batch — đảm bảo onSnapshot App.tsx luôn fire
  batch.update(doc(db, 'projectConfigs', configId), { _lastModuleUpdate: serverTimestamp() });

  try {
   await batch.commit();
  } catch (e: any) {
   console.error('[dualWrite] batchUpdate failed for config:', configId, e.message);
   writeErrors.push(e);
  }
 }

 if (writeErrors.length > 0) {
  throw new AggregateError(writeErrors, `batchUpdateProjectModules: ${writeErrors.length} write(s) failed`);
 }
}

export async function batchDeleteProjectModules(
 moduleIds: string[],
 projectCode?: string
) {
 const configModules = new Map<string, string[]>();
 let unmatchedIds: string[] = [];

 moduleIds.forEach(moduleId => {
  const configId = findConfigId(moduleId, projectCode);
  if (configId) {
   if (!configModules.has(configId)) configModules.set(configId, []);
   configModules.get(configId)!.push(moduleId);
  } else {
   unmatchedIds.push(moduleId);
  }
 });

 // Fallback: query trực tiếp theo projectCode
 if (unmatchedIds.length > 0 && projectCode) {
  const fallbackConfigId = await findProjectConfigId(projectCode);
  if (fallbackConfigId) {
   if (!configModules.has(fallbackConfigId)) configModules.set(fallbackConfigId, []);
   configModules.get(fallbackConfigId)!.push(...unmatchedIds);
   unmatchedIds = [];
  }
 }

 for (const [configId, ids] of configModules) {
  const batch = writeBatch(db);
  ids.forEach(moduleId => {
   batch.delete(doc(db, 'projectConfigs', configId, 'modules', moduleId));
  });
  batch.update(doc(db, 'projectConfigs', configId), { _lastModuleUpdate: serverTimestamp() });
  try {
   await batch.commit();
  } catch (e: any) {
   console.error('[dualWrite] batchDelete projectConfigs/modules failed:', e.message);
  }
 }
}

export async function batchUpdateProjectModulesByConfig(
 projectCode: string,
 data: Record<string, any>
) {
 const configId = await findProjectConfigId(projectCode);
 if (!configId) return;

 const tasks: Promise<void>[] = [];

 // Cập nhật project-level fields trên config doc + trigger onSnapshot
 const configFields = extractProjectLevelFields(data);
 const configPayload: Record<string, any> = { ...configFields, _lastModuleUpdate: serverTimestamp() };
 tasks.push(updateDoc(doc(db, 'projectConfigs', configId), configPayload).catch(() => {}));

 // Cập nhật tất cả modules (chỉ module-level fields)
 const moduleFields = { ...data };
 for (const key of Object.keys(configFields)) {
  delete moduleFields[key];
 }
 if (Object.keys(moduleFields).length > 0) {
  const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));
  const batch = writeBatch(db);
  modulesSnap.docs.forEach(modDoc => {
   batch.update(modDoc.ref, moduleFields);
  });
  tasks.push(batch.commit());
 }

 await Promise.allSettled(tasks);
}

export async function markProjectCompleted(projectCode: string, completed: boolean): Promise<void> {
 const configId = await findProjectConfigId(projectCode);
 if (!configId) throw new Error(`Không tìm thấy projectConfig cho ${projectCode}`);

 const payload: Record<string, any> = {
   isCompleted: completed,
   completedAt: completed ? new Date() : null,
   updatedAt: new Date(),
 };

 await updateDoc(doc(db, 'projectConfigs', configId), payload);
}
