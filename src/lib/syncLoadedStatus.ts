import { collection, query, where, getDocs, doc, updateDoc, getDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase';
import { PackingItem, ProjectEntry, getModuleInstances, ModuleInstance } from '../types';
import { findProjectConfigId } from './dualWrite';

export async function syncItemLoadedStatus(
  itemName: string,
  loaded: boolean,
  loadedBy: string,
  projectCode: string,
  pklCode?: string,
  pklId?: string
) {
  try {
    const q = query(collection(db, 'packing'), where('projectCode', '==', projectCode));
    const snap = await getDocs(q);

    for (const packingDoc of snap.docs) {
      const data = packingDoc.data();
      const items: PackingItem[] = data.items || [];
      const idx = items.findIndex(i => (i.name || '').toLowerCase().trim() === itemName.toLowerCase().trim());
      if (idx === -1) continue;

      const updated = [...items];
      updated[idx] = {
        ...updated[idx],
        loaded,
        loadedBy: loaded ? loadedBy : undefined,
        loadedPklCode: loaded && pklCode ? pklCode : undefined,
        loadedPklId: loaded && pklId ? pklId : undefined,
      };

      await updateDoc(doc(db, 'packing', packingDoc.id), { items: updated });
    }
  } catch (err) {
    console.error('syncItemLoadedStatus error:', err);
  }
}

// Batch version: sync nhiều items cùng lúc, cache packing docs để tránh đọc trùng
export async function syncItemLoadedStatusBatch(
  itemNames: string[],
  loaded: boolean,
  loadedBy: string,
  projectCode: string,
  pklCode?: string,
  pklId?: string
) {
  try {
    const q = query(collection(db, 'packing'), where('projectCode', '==', projectCode));
    const snap = await getDocs(q);

    for (const packingDoc of snap.docs) {
      const data = packingDoc.data();
      const items: PackingItem[] = data.items || [];
      let changed = false;
      const updated = [...items];

      for (const itemName of itemNames) {
        const idx = updated.findIndex(i => (i.name || '').toLowerCase().trim() === itemName.toLowerCase().trim());
        if (idx === -1) continue;
        updated[idx] = {
          ...updated[idx],
          loaded,
          loadedBy: loaded ? loadedBy : undefined,
          loadedPklCode: loaded && pklCode ? pklCode : undefined,
          loadedPklId: loaded && pklId ? pklId : undefined,
        };
        changed = true;
      }

      if (changed) {
        await updateDoc(doc(db, 'packing', packingDoc.id), { items: updated });
      }
    }
  } catch (err) {
    console.error('syncItemLoadedStatusBatch error:', err);
  }
}

// Tìm module trong projectEntries — exact match theo tên
function findEntryInProjectEntries(
  baseName: string,
  entries: ProjectEntry[]
): ProjectEntry | undefined {
  if (entries.length === 0) return undefined;

  const normalized = baseName.toLowerCase().trim();
  return entries.find(e => (e.moduleCode || '').toLowerCase().trim() === normalized);
}

export async function syncInstanceLoadInfo(
  packingItemName: string,
  instanceIndex: number | undefined,
  projectCode: string,
  loadInfo: { pklId: string; pklCode: string; loadedAt: any; loadedBy: string; vehicleInfo?: string } | null,
  projectEntries: ProjectEntry[]
) {
  try {

    // Strip hậu tố #X/Y để lấy tên gốc
    const baseName = packingItemName.replace(/\s*#\d+\/\d+\s*$/, '').trim();

    // Lấy instance index từ tên nếu chưa có
    let resolvedIndex = instanceIndex;
    if (resolvedIndex == null) {
      const match = packingItemName.match(/#(\d+)\/\d+/);
      if (match) resolvedIndex = parseInt(match[1], 10);
    }

    // ─── Bước 1: Tìm module trong projectEntries (chỉ khi có entry cho project này) ───
    const projectEntriesFiltered = projectEntries.filter(
      e => e.projectCode?.toLowerCase() === projectCode.toLowerCase()
    );

    let entry: ProjectEntry | undefined;
    let configId: string | null = null;
    let moduleDocRef: any = null;
    let moduleData: any = null;

    if (projectEntriesFiltered.length > 0) {
      // Có entries cho project này → tìm trong projectEntries
      entry = findEntryInProjectEntries(baseName, projectEntriesFiltered);
      if (entry) {
        configId = entry.configId || await findProjectConfigId(entry.projectCode || projectCode);
        if (configId) {
          moduleDocRef = doc(db, 'projectConfigs', configId, 'modules', entry.id);
          const snap = await getDoc(moduleDocRef);
          if (snap.exists()) {
            moduleData = snap.data();
          }
        }
      }
    }

    // ─── Bước 2: Query Firestore trực tiếp theo projectCode ───
    if (!moduleData) {
      const configIdDirect = await findProjectConfigId(projectCode);
      if (!configIdDirect) {
        return;
      }
      configId = configIdDirect;

      const modulesSnap = await getDocs(collection(db, 'projectConfigs', configId, 'modules'));

      for (const modDoc of modulesSnap.docs) {
        const modData = modDoc.data();
        if ((modData.moduleCode || '').toLowerCase().trim() === baseName.toLowerCase().trim()) {
          moduleDocRef = doc(db, 'projectConfigs', configId, 'modules', modDoc.id);
          moduleData = modData;
          entry = { id: modDoc.id, moduleCode: modData.moduleCode, projectCode, configId, ...modData } as ProjectEntry;
          break;
        }
      }
    }

    if (!moduleData || !moduleDocRef || !entry) {
      return;
    }


    // ─── Bước 3: Đọc instances từ Firestore ───
    let instances: ModuleInstance[] = moduleData.instances || [];

    // Nếu chưa có instances, tạo từ quantity
    if (instances.length === 0) {
      const qty = entry.quantity || moduleData.quantity || 1;
      instances = Array.from({ length: qty }, (_, i) => ({
        id: `${entry.moduleCode}|${i + 1}`,
        instanceId: `${entry.moduleCode}|${i + 1}`,
        instanceIndex: i + 1,
        tempLabelIndex: i + 1,
      }));
    }

    if (instances.length > 0) {
    }

    // ─── Bước 4: Tìm instance target ───
    // Nếu resolvedIndex không có hoặc không tìm thấy → mặc định instance 1
    let targetIdx = resolvedIndex != null
      ? instances.findIndex(i => i.instanceIndex === resolvedIndex)
      : 0;

    if (targetIdx === -1) {
      targetIdx = instances.findIndex(i => i.instanceIndex === 1);
      if (targetIdx === -1) targetIdx = 0;
    }


    // ─── Bước 5: Update loadInfo ───
    const updatedInstances = [...instances];
    updatedInstances[targetIdx] = {
      ...updatedInstances[targetIdx],
      loadInfo: loadInfo === null ? undefined : loadInfo,
    };

    await updateDoc(moduleDocRef, { instances: updatedInstances as any });
  } catch (err) {
    console.error('[syncInstanceLoadInfo] Error:', err);
  }
}
