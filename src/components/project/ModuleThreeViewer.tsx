import React, { useEffect, Suspense, useState, useRef } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { GLTFLoader } from 'three-stdlib';
import { Focus, AlertCircle } from 'lucide-react';export interface MatchLogEntry {
 name: string;
 state: 'clear' | 'faded' | 'hidden';
 matchedKey?: string;
 fadedKey?: string;
 clearKey?: string;
}

interface ModelProps {
 url: string;
 moduleName: string | string[];
 onLoad: (scene: THREE.Group) => void;
 onMatchLog?: (logs: MatchLogEntry[]) => void;
 customFadedKeys?: string[];
 customClearKeys?: string[];
}

interface ModuleThreeViewerProps {
 url: string;
 moduleName: string | string[];
 cameraAngle?: number;
 onMatchLog?: (logs: MatchLogEntry[]) => void;
 customFadedKeys?: string[];
 customClearKeys?: string[];
}

// ----------------------------------------------------------------------
// HELPER FUNCTIONS FOR CLEANING AND COMPARING
// ----------------------------------------------------------------------

export function cleanBlenderAndThreeSuffix(name: string): string {
 if (!name) return '';
 let clean = name.trim();
 clean = clean.replace(/^([A-Z])[-_]/, '');
 // Bỏ suffix hướng: -Phải, -Trái, -Trên, -Dưới, -Giữa, -Đầu, ...
 clean = clean.replace(/-\p{L}+$/u, '');
 clean = clean.replace(/\.\d+$/, '');
 clean = clean.replace(/_primitive\d+$/i, '');
 clean = clean.replace(/_\d+$/, '');
 // Bỏ 3 ký tự cuối nếu là số (đuôi instance/padding): BUITT3001→BUITT3, KITT1000→KITT1
 clean = clean.replace(/\d{3}$/, '');
 return clean;
}

export function cleanAndNormalize(str: string): string {
 if (!str) return '';
 return str
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd')
  .replace(/[^a-z0-9]/g, '');
}

export function extractGroupSuffixCleaned(name: string): string {
 const cleanedName = cleanBlenderAndThreeSuffix(name);
 if (!cleanedName) return '';
 const norm = cleanedName.toLowerCase();
 const entIdx = norm.indexOf('ent');
 if (entIdx !== -1) {
  const rawSuffix = norm.substring(entIdx);
  return rawSuffix.replace(/[^a-z0-9]/g, '');
 }
 const lastUnderscore = norm.lastIndexOf('_');
 if (lastUnderscore !== -1 && lastUnderscore < norm.length - 1) {
  const rawSuffix = norm.substring(lastUnderscore);
  return rawSuffix.replace(/[^a-z0-9]/g, '');
 }
 return '';
}

export function cleanCoreName(fullName: string): string {
 const cleanedName = cleanBlenderAndThreeSuffix(fullName);
 if (!cleanedName) return '';
 const norm = cleanedName.toLowerCase();
 let core = norm;
 const entIdx = norm.indexOf('ent');
 if (entIdx !== -1) {
  core = norm.substring(0, entIdx);
 } else {
  const lastUnderscore = norm.lastIndexOf('_');
  if (lastUnderscore !== -1) {
   core = norm.substring(0, lastUnderscore);
  }
 }
 if (core.endsWith('_')) {
  core = core.substring(0, core.length - 1);
 }
 return core
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd')
  .replace(/[^a-z0-9]/g, '');
}

export function isMainComponent(meshName: string, targetModuleName: string | string[]): boolean {
 if (Array.isArray(targetModuleName)) {
  return targetModuleName.some(name => isMainComponent(meshName, name));
 }

 const cleanMesh = cleanBlenderAndThreeSuffix(meshName);
 const cleanTarget = cleanBlenderAndThreeSuffix(targetModuleName);

 const normMesh = cleanAndNormalize(cleanMesh);
 const normTarget = cleanAndNormalize(cleanTarget);

 if (!normMesh || !normTarget) return false;

 if (normMesh === normTarget) return true;

 const suffixMesh = extractGroupSuffixCleaned(cleanMesh);
 const suffixTarget = extractGroupSuffixCleaned(cleanTarget);

 if (suffixMesh && suffixTarget && suffixMesh !== suffixTarget) {
  return false;
 }

 const coreMesh = cleanCoreName(cleanMesh);
 const coreTarget = cleanCoreName(cleanTarget);

 if (!coreMesh || !coreTarget) return false;

 if (coreTarget.length <= 8) {
  if (coreMesh === coreTarget) return true;
  if (!coreMesh.startsWith(coreTarget)) return false;
  // Sau key còn chữ số là module khác (T1 ≠ T11/T10); đuôi số đã được bỏ 3 ký tự ở trên
  return !/^\d/.test(coreMesh.substring(coreTarget.length));
 }

 return coreMesh.includes(coreTarget) || coreTarget.includes(coreMesh);
}

// ----------------------------------------------------------------------
// PRE-CHECK: verify module exists in GLB (headless, no React)
// ----------------------------------------------------------------------

export function preCheckModuleInGlb(url: string, moduleName: string): Promise<boolean> {
 return new Promise((resolve) => {
  if (!url || !moduleName) { resolve(false); return; }

  const loader = new GLTFLoader();
  loader.load(
   url,
   (gltf) => {
    let found = false;
    gltf.scene.traverse((child: any) => {
     if (found || !child.isMesh) return;
     if (isMainComponent(child.name || '', moduleName)) {
      found = true;
     }
    });
    resolve(found);
   },
   undefined,
   () => resolve(false),
  );
 });
}

// ----------------------------------------------------------------------
// THREE.JS MODEL COMPONENT
// ----------------------------------------------------------------------

function Model({ url, moduleName, onLoad, onMatchLog, customFadedKeys = [], customClearKeys = [] }: ModelProps) {
  const { scene } = useGLTF(url);

  useEffect(() => {
   if (!scene) return;

   onLoad(scene);

   const moduleNames = Array.isArray(moduleName) ? moduleName : [moduleName];

   const primaryName = moduleNames[0] || '';

    // Logic mới: tách "BLDG1_KIT.T14" → parts = ["BLDG1", "KIT", "T14"]
    // split underscore cuối → "BLDG1" + "KIT.T14" → split dot → "KIT" + "T14"
    // Có dot: faded = prefix (NGỦ2), clear = prefix+suffix (NGỦ2T10)
    // Không dot: faded = last segment (KTV), clear = 2 segments cuối (3_KTV)
    const parseModuleName = (name: string): { unit: string; kitPrefix: string; suffix: string; fadedKey: string; clearKey: string; hasDot: boolean } => {
     const firstUnderscore = name.indexOf('_');
     const unit = firstUnderscore !== -1 ? name.substring(0, firstUnderscore) : '';
     const rightPart = firstUnderscore !== -1 ? name.substring(firstUnderscore + 1) : name;
     const dotIdx = rightPart.indexOf('.');
     const kitPrefix = dotIdx !== -1 ? rightPart.substring(0, dotIdx) : '';
     const suffix = dotIdx !== -1 ? rightPart.substring(dotIdx + 1) : rightPart;

     let fadedKey = '';
     let clearKey = '';

     // Tách rightPart bằng _ rồi check dấu . ở segment cuối cùng
     // BCOA1_BẾP.T15 → rightPart="BẾP.T15" (1 seg) → faded=BẾP, clear=BẾPT15
     // BCOA1_Hông phải_BẾP.T13 → rightPart="Hông phải_BẾP.T13" (nhiều seg) → faded=BẾPT13, clear=Hông_phải_BẾPT13
     // BCOA1_Kính 1_KTV → rightPart="Kính 1_KTV" (nhiều seg, không dot) → faded=KTV, clear=Kính_1_KTV
     const rightSegments = rightPart.split('_');
     const lastSeg = rightSegments[rightSegments.length - 1] || '';
     const lastDotIdx = lastSeg.indexOf('.');

     if (lastDotIdx !== -1) {
       const segPrefix = lastSeg.substring(0, lastDotIdx);
       const segSuffix = lastSeg.substring(lastDotIdx + 1);
       if (rightSegments.length === 1) {
         // Chỉ 1 segment: BẾP.T15 → faded=BẾP, clear=BẾPT15
         fadedKey = segPrefix;
       } else {
         // Nhiều segment: BẾP.T13 → faded=BẾPT13
         fadedKey = segPrefix + segSuffix;
       }
     } else {
       fadedKey = lastSeg;
     }      // clearKey = toàn bộ rightPart, đổi space thành _, bỏ dấu chấm và dấu /
      clearKey = rightPart.replace(/\s+/g, '_').replace(/\./g, '').replace(/\//g, '');

     return { unit, kitPrefix, suffix, fadedKey, clearKey, hasDot: dotIdx !== -1 };
    };

    const parsedModules = moduleNames.map(name => parseModuleName(name));
    const hasCustomFaded = customFadedKeys.length > 0;
    const hasCustomClear = customClearKeys.length > 0;
    // Lấy fadedKey và clearKey từ custom keys hoặc parsed keys để hiển thị
    const moduleFadedKey = hasCustomFaded ? customFadedKeys.join(', ') : (parsedModules[0]?.fadedKey || '');
    const moduleClearKey = hasCustomClear ? customClearKeys.join(', ') : (parsedModules[0]?.clearKey || '');
    // Matching values: hoạt động độc lập
    // - Cả hai custom → clear key = faded key + clear key (nối lại)
    // - Chỉ có faded custom (clear trống) → faded dùng custom, clear dùng parsed
    // - Chỉ có clear custom → chỉ dùng clear matching
    // - Không có custom nào → dùng parsed keys cho cả hai
    let fadedKeysToMatch: string[] = [];
    let clearKeysToMatch: string[] = [];
    if (hasCustomFaded && hasCustomClear) {
      fadedKeysToMatch = customFadedKeys.map(k => k.toLowerCase()).filter(Boolean);
      // Clear key = faded + clear (nối lại): MOD + G1 → modg1
      clearKeysToMatch = [];
      customFadedKeys.forEach(fk => {
        customClearKeys.forEach(ck => {
          clearKeysToMatch.push((fk + ck).toLowerCase());
        });
      });
    } else if (hasCustomFaded) {
      // Clear trống → faded dùng custom, clear dùng parsed key
      fadedKeysToMatch = customFadedKeys.map(k => k.toLowerCase()).filter(Boolean);
      clearKeysToMatch = [parsedModules[0]?.clearKey?.toLowerCase() || ''].filter(Boolean);
    } else if (hasCustomClear) {
      clearKeysToMatch = customClearKeys.map(k => k.toLowerCase()).filter(Boolean);
    } else {
      fadedKeysToMatch = [parsedModules[0]?.fadedKey?.toLowerCase() || ''].filter(Boolean);
      clearKeysToMatch = [parsedModules[0]?.clearKey?.toLowerCase() || ''].filter(Boolean);
    }

   const getFadeSearchTerm = (name: string): string => {
    if (name.includes('Tấm hoàn thiện') || name.includes('tam hoan thien')) {
     const kitMatch = name.match(/KIT\d+\.T\d+/i);
     if (kitMatch) return kitMatch[0];
    }
    const suffix = extractGroupSuffixCleaned(name);
    if (!suffix) return '';
    return suffix.replace(/t\d+$/, '') || suffix;
   };

   const fadeSearchTerm = getFadeSearchTerm(primaryName);

   const targetInfos = moduleNames.map((name, i) => ({
    cleaned: cleanBlenderAndThreeSuffix(name || ''),
    suffix: extractGroupSuffixCleaned(name || ''),
    core: cleanCoreName(name || ''),
    hasDot: parsedModules[i]?.hasDot ?? true,
   }));

   const matchLogs: MatchLogEntry[] = [];

   scene.traverse((child: any) => {
    if (child.isMesh) {
     if (child.userData.isWireframe) return;

     const meshName = child.name || '';

     if (child.material) {
      if (!child.userData.originalMaterial) {
       child.userData.originalMaterial = child.material.clone();
      }
      const freshMat = child.userData.originalMaterial.clone();
      freshMat.uuid = THREE.MathUtils.generateUUID();
      child.material = freshMat;
     }

      const meshSuffix = extractGroupSuffixCleaned(meshName);
      const meshCore = cleanCoreName(meshName);
      const meshLower = meshName.toLowerCase();

      let normalState: 'clear' | 'faded' | 'hidden' = 'hidden';

      // Helper: match faded key — bỏ 3 ký tự cuối nếu là số (instance/padding) trước khi check key
      // Chặn letter đệm (KTV ≠ KTVT, NGỦ2 ≠ NGỦ2A) và chữ số đệm (T1 ≠ T11/T10)
      const matchFadedKey = (text: string, key: string): boolean => {
       if (!key) return false;
       const stripped = text.replace(/\d{3}$/, '');
       const idx = stripped.indexOf(key);
       if (idx === -1) return false;
       const rest = stripped.substring(idx + key.length);
       if (/^[a-z]/i.test(rest)) return false;
       if (/^\d/.test(rest)) return false;
       return true;
      };

      // Helper: match key bằng cách check token phân tách bởi _ hoặc .
      const matchTokenKey = (text: string, key: string): boolean => {
        if (!key) return false;
        const tokens = text.split(/[_\.\s]+/);
        return tokens.some(t => t === key);
      };

       // Logic: check faded VÀ clear độc lập
       // Clear ưu tiên hơn faded: clear match → clear, chỉ faded match → faded, không match → hidden
       // Dùng giá trị hiển thị 'Key của module' để match
       let matchedKey = '';
       let isFaded = fadedKeysToMatch.some(key => {
        const matched = meshLower.includes(key);
        if (matched) matchedKey = key;
        return matched;
       });
       let isClear = clearKeysToMatch.some(key => {
        const matched = meshLower.includes(key);
        if (matched) matchedKey = key;
        return matched;
       });
       if (isClear) {
        normalState = 'clear';
       } else if (isFaded) {
        normalState = 'faded';
       }

      matchLogs.push({ name: meshName, state: normalState, matchedKey: matchedKey || undefined, fadedKey: moduleFadedKey, clearKey: moduleClearKey });

     if (normalState === 'clear') {
      child.visible = true;
      if (child.material) {
       child.material.transparent = false;
       child.material.opacity = 1.0;
      }
     } else if (normalState === 'faded') {
      child.visible = true;
      if (child.material) {
       child.material.transparent = true;
       child.material.opacity = 0.15;
      }
     } else {
      child.visible = false;
     }

     // Wireframe edges
     if (child.visible) {
      const shouldShowOutline = normalState === 'clear';
      const edgeOpacity = normalState === 'clear' ? 0.75 : 0;
      const hasWireframe = child.children.some((c: any) => c.userData.isWireframe);

      if (shouldShowOutline) {
       if (!hasWireframe) {
        const edges = new THREE.EdgesGeometry(child.geometry);
        const lineMaterial = new THREE.LineBasicMaterial({
         color: 0x000000,
         transparent: true,
         opacity: edgeOpacity,
        });
        const lineSegments = new THREE.LineSegments(edges, lineMaterial);
        lineSegments.userData.isWireframe = true;
        lineSegments.position.copy(child.position);
        lineSegments.rotation.copy(child.rotation);
        lineSegments.scale.copy(child.scale);
        child.add(lineSegments);
       } else {
        child.children.forEach((c: any) => {
         if (c.userData.isWireframe) {
          c.visible = true;
          if (c.material) {
           c.material.transparent = true;
           c.material.opacity = edgeOpacity;
          }
         }
        });
       }
      } else {
       if (hasWireframe) {
        child.children.forEach((c: any) => {
         if (c.userData.isWireframe) {
          c.visible = false;
         }
        });
       }
      }
     }
    }
   });

   if (onMatchLog) onMatchLog(matchLogs);
  }, [scene, url, moduleName]);

 return (
  <group>
   <primitive object={scene} />
  </group>
 );
}

// Simple Error Boundary
class ErrorBoundary extends React.Component<{ children: React.ReactNode, onError: (error: string) => void }, { hasError: boolean }> {
 constructor(props: any) {
  super(props);
  this.state = { hasError: false };
 }

 static getDerivedStateFromError() {
  return { hasError: true };
 }

 componentDidCatch(error: Error) {
  this.props.onError(error.message);
 }

 render() {
  if (this.state.hasError) return null;
  return this.props.children;
 }
}

// ----------------------------------------------------------------------
// MAIN EXPORTED THREE VIEWER
// ----------------------------------------------------------------------

export function ModuleThreeViewer({ url, moduleName, cameraAngle, onMatchLog, customFadedKeys = [], customClearKeys = [] }: ModuleThreeViewerProps) {
 const [error, setError] = useState<string | null>(null);
 const [scene, setScene] = useState<THREE.Group | null>(null);
 const controlsRef = useRef<any>(null);

 const resetView = () => {
  if (!controlsRef.current || !scene) return;

  const box = new THREE.Box3();
  let hasTarget = false;

  scene.traverse((child: any) => {
   if (child.isMesh && child.visible && !child.userData.isWireframe) {
    if (child.material && Math.abs(child.material.opacity - 1.0) < 0.01) {
     box.expandByObject(child);
     hasTarget = true;
    }
   }
  });

  if (!hasTarget) {
   scene.traverse((child: any) => {
    if (child.isMesh && child.visible && !child.userData.isWireframe) {
     box.expandByObject(child);
     hasTarget = true;
    }
   });
  }

  if (hasTarget) {
   const center = box.getCenter(new THREE.Vector3());
   const size = box.getSize(new THREE.Vector3());
   const maxDim = Math.max(size.x, size.y, size.z);
   const targetZoom = Math.min(300, Math.max(20, 180 / maxDim));

   // Camera offset mặc định: (150, 150, 150) — góc isometric
   // Xoay quanh trục Y (qua center) theo góc camera nếu được đặt.
   // three.js right-handed Y-up: quay dương quanh +Y (right-hand rule) = theo chiều
   // kim đồng hồ khi nhìn từ trên (ngón cái +Y, ngón cong +X→+Z: 3h→6h).
   // ⇒ +cameraAngle = +90° = xoay camera theo chiều kim đồng hồ nhìn từ trên. ✓
   const offset = new THREE.Vector3(150, 150, 150);
   if (cameraAngle) {
    offset.applyAxisAngle(
     new THREE.Vector3(0, 1, 0),
     THREE.MathUtils.degToRad(cameraAngle),
    );
   }

   controlsRef.current.object.zoom = targetZoom;
   controlsRef.current.object.position.set(center.x + offset.x, center.y + offset.y, center.z + offset.z);
   controlsRef.current.target.copy(center);
   controlsRef.current.object.updateProjectionMatrix();
   controlsRef.current.update();
  }
 };

 useEffect(() => {
  if (scene) {
   const timer = setTimeout(() => { resetView(); }, 120);
   return () => clearTimeout(timer);
  }
 }, [scene, moduleName, cameraAngle]);

 if (error) {
  return (
   <div className="w-full h-44 bg-slate-100 rounded-lg flex flex-col items-center justify-center text-center p-4 border border-slate-200">
    <AlertCircle size={22} className="text-rose-500 mb-1" />
    <span className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Không thể tải mô hình 3D</span>
    <span className="text-[8px] text-slate-400 mt-0.5 max-w-xs truncate">{error}</span>
   </div>
  );
 }

 return (
  <div
   className="w-full h-100 bg-slate-100 rounded-lg overflow-hidden border border-slate-200 relative group"
  >
   <Canvas
    orthographic
    camera={{ zoom: 55, position: [100, 100, 100] }}
    shadows={{ type: THREE.PCFShadowMap }}
    gl={{ antialias: true }}
   >
    <ambientLight intensity={0.65} />
    <directionalLight position={[20, 40, 20]} intensity={1.2} />
    <Suspense fallback={null}>
     <ErrorBoundary onError={setError}>
       <Model url={url} moduleName={moduleName} onLoad={setScene} onMatchLog={onMatchLog} customFadedKeys={customFadedKeys} customClearKeys={customClearKeys} />
     </ErrorBoundary>
    </Suspense>
    <OrbitControls ref={controlsRef} enableRotate enableZoom enablePan={false} makeDefault />
   </Canvas>

   <div className="absolute bottom-3 right-3 flex items-center space-x-2">
    <button type="button" onClick={resetView} title="Tự động căn góc Isometric"
     className="p-2 bg-white/95 backdrop-blur-sm text-slate-700 rounded-lg shadow-lg hover:text-indigo-600 transition-all border border-slate-200 cursor-pointer">
     <Focus size={14} />
    </button>

   </div>

   <div className="absolute top-3 left-3 pointer-events-none">
    <div className="bg-slate-900/80 backdrop-blur-sm px-2 py-1 rounded-lg text-[8px] font-black text-white uppercase tracking-widest border border-slate-800">
     Isometric & Orthographic
    </div>
   </div>
  </div>
 );
}
