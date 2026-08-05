import React, { useEffect, Suspense, useState, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Loader } from '@react-three/drei';
import { GLTFLoader } from 'three-stdlib';
import { AlertCircle, RefreshCw, Focus, Camera, Box } from 'lucide-react';

// ---------------------------------------------------------------------------
// FocusAnimator – runs inside Canvas, animates camera via useFrame
// ---------------------------------------------------------------------------

interface FocusTarget {
 position: THREE.Vector3;
 lookAt: THREE.Vector3;
 zoom: number;
 box?: THREE.Box3;
}

function FocusAnimator({
 target,
 onDone,
 controlsRef,
}: {
 target: FocusTarget | null;
 onDone: () => void;
 controlsRef: React.RefObject<any>;
}) {
 const progress = useRef(0);
 const startPos = useRef(new THREE.Vector3());
 const startTarget = useRef(new THREE.Vector3());
 const startZoom = useRef(55);
 const active = useRef(false);

 useEffect(() => {
  if (!target || !controlsRef.current) return;
  startPos.current.copy(controlsRef.current.object.position);
  startTarget.current.copy(controlsRef.current.target);
  startZoom.current = controlsRef.current.object.zoom;
  progress.current = 0;
  active.current = true;
 }, [target]);

 useFrame((_, delta) => {
  if (!active.current || !target || !controlsRef.current) return;

  progress.current = Math.min(1, progress.current + delta * 3);
  const t = 1 - Math.pow(1 - progress.current, 3); // ease-out cubic

  const cam = controlsRef.current.object;
  cam.position.lerpVectors(startPos.current, target.position, t);
  controlsRef.current.target.lerpVectors(startTarget.current, target.lookAt, t);
  cam.zoom = startZoom.current + (target.zoom - startZoom.current) * t;
  cam.updateProjectionMatrix();
  controlsRef.current.update();

  if (progress.current >= 1) {
   active.current = false;
   onDone();
  }
 });

 return null;
}

// ---------------------------------------------------------------------------
// FocusBoundingBox – renders Box3Helper wireframe inside Canvas
// ---------------------------------------------------------------------------

function FocusBoundingBox({ box, clusterKey }: { box: THREE.Box3 | null; clusterKey: string }) {
 if (!box) return null;

 const group = new THREE.Group();
 const color = new THREE.Color(0x6366f1);
 const offsets = [0, 0.03, -0.03];

 offsets.forEach((off) => {
  const expanded = box.clone().expandByScalar(off);
  const helper = new THREE.Box3Helper(expanded, color);
  helper.material.transparent = true;
  helper.material.opacity = off === 0 ? 0.9 : 0.35;
  group.add(helper);
 });

 return <primitive key={clusterKey} object={group} />;
}

// ---------------------------------------------------------------------------
// Model – loads GLB via GLTFLoader (no useGLTF cache)
// ---------------------------------------------------------------------------

interface ModelProps {
 url: string;
 onLoad: (scene: THREE.Group) => void;
}

function Model({ url, onLoad, onError }: ModelProps & { onError?: (msg: string) => void }) {
 const groupRef = useRef<THREE.Group>(new THREE.Group());
 const [loaded, setLoaded] = useState(false);

 useEffect(() => {
  if (!url) return;
  let cancelled = false;

  // CORS pre-flight: try fetch first to detect network / CORS errors early
  fetch(url, { method: 'HEAD', mode: 'cors' })
   .then(() => {
    if (cancelled) return;
    const loader = new GLTFLoader();
    loader.load(
     url,
     (gltf) => {
      if (cancelled) return;
      const scene = gltf.scene;
      onLoad(scene);

      scene.traverse((child: any) => {
       if (child.isMesh) {
        child.visible = true;
        if (child.material) {
         if (!child.userData.originalMaterial) {
          child.userData.originalMaterial = child.material.clone();
         }
         const freshMat = child.userData.originalMaterial.clone();
         freshMat.uuid = THREE.MathUtils.generateUUID();
         child.material = freshMat;
         child.material.transparent = false;
         child.material.opacity = 1.0;
        }
        const hasWireframe = child.children.some((c: any) => c.userData.isWireframe);
        if (!hasWireframe) {
         const edges = new THREE.EdgesGeometry(child.geometry);
         const lineMaterial = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.75 });
         const lineSegments = new THREE.LineSegments(edges, lineMaterial);
         lineSegments.userData.isWireframe = true;
         lineSegments.position.copy(child.position);
         lineSegments.rotation.copy(child.rotation);
         lineSegments.scale.copy(child.scale);
         child.add(lineSegments);
        }
       }
      });

      groupRef.current = scene;
      setLoaded(true);
     },
     undefined,
     (err) => {
      console.error('[GLTFLoader] Load error:', url, err);
      if (!cancelled) onError?.(`Lỗi tải file GLB: ${String(err)}`);
     },
    );
   })
   .catch((fetchErr) => {
    console.error('[GLTFLoader] CORS / Network error:', url, fetchErr);
    if (!cancelled) onError?.(`Không thể truy cập file. Lỗi CORS hoặc mạng: ${fetchErr?.message || fetchErr}`);
   });

  return () => { cancelled = true; };
 }, [url, onLoad, onError]);

 if (!loaded) return null;
 return <primitive object={groupRef.current} />;
}

// ---------------------------------------------------------------------------
// ErrorBoundary
// ---------------------------------------------------------------------------

class ErrorBoundary extends React.Component<
 { children: React.ReactNode; onError: (error: string) => void },
 { hasError: boolean }
> {
 constructor(props: any) {
  super(props);
  this.state = { hasError: false };
 }
 static getDerivedStateFromError() { return { hasError: true }; }
 componentDidCatch(error: Error) { this.props.onError(error.message); }
 render() {
  if (this.state.hasError) return null;
  return this.props.children;
 }
}

// ---------------------------------------------------------------------------
// ThreeModelViewer – main export
// ---------------------------------------------------------------------------

interface ThreeModelViewerProps {
 url: string;
 focusModuleNames?: string[];
 focusKey?: string;
}

export function ThreeModelViewer({ url, focusModuleNames, focusKey }: ThreeModelViewerProps) {
 const [error, setError] = useState<string | null>(null);
 const controlsRef = useRef<any>(null);
 const [scene, setScene] = useState<THREE.Group | null>(null);
 const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
 const [boundingBox, setBoundingBox] = useState<THREE.Box3 | null>(null);
 const [showBoundingBox, setShowBoundingBox] = useState(true);
 const [isOrtho, setIsOrtho] = useState(true);
 const sceneBounds = useRef<{ center: THREE.Vector3; maxDim: number } | null>(null);

 // Extract key from module code: "OAHB1_BAT2.T1" → "bat2"
 // Takes last segment after "_", normalizes
  const normalize = useCallback((s: string): string => {
   return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '');
  }, []);

  const extractKey = useCallback((name: string): string => {
   if (!name) return '';
   let clean = name.trim();
   const parts = clean.split('_');
   clean = parts[parts.length - 1] || clean;
   clean = clean.replace(/\.\w+$/, '');
   return normalize(clean);
  }, [normalize]);

 // Compute bounding box of meshes whose names match any of the given module codes
 // Uses strict exact match on extracted component keys
 const computeFocusTarget = useCallback((scene: THREE.Group, moduleNames: string[]): FocusTarget | null => {
  if (!moduleNames.length) return null;

  // Extract & deduplicate component keys from module codes
  const seen = new Set<string>();
  const codeKeys = moduleNames
   .map(c => ({ original: c, key: extractKey(c) }))
   .filter(({ key, original }) => key.length >= 2 && !seen.has(key) && (seen.add(key), true));
  if (!codeKeys.length) return null;

  const box = new THREE.Box3();
  const matched: { name: string; key: string }[] = [];

  scene.traverse((child: any) => {
   if (!child.isMesh) return;
   const meshName = normalize(child.name || '');
   if (!meshName) return;
   if (meshName.startsWith('c-') || meshName.includes('hk') || meshName.includes('tay') || meshName.includes('tang') || meshName.includes('len') || meshName.includes('fill') || meshName.includes('chan') || meshName.includes('filt')) return;

   const matchedKey = codeKeys.find(({ key }) => meshName.includes(key));
   if (matchedKey) {
     box.expandByObject(child);
     matched.push({ name: child.name, key: matchedKey.original });
    }
  });

   if (matched.length > 0) {
    // console.log(`[FocusTarget] Matched ${matched.length} meshes for [${codeKeys.map(c => c.original).join(', ')}]:`, matched.map(m => m.name));
   } else {
    // console.log(`[FocusTarget] No mesh matched for [${codeKeys.map(c => c.original).join(', ')}]`);
   }

   if (matched.length === 0) return null;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  // Zoom: object fills ~80% of viewport (~800px reference width)
  const isMobile = window.innerWidth < 640;
  const fillRatio = isMobile ? 0.8 * 0.5 : 0.8;
  const viewportRef = 800;
  const zoom = Math.min(500, Math.max(5, (viewportRef * fillRatio) / maxDim));

  // Camera offset: comfortable isometric distance
  const distance = maxDim * 1.5;

  return {
   position: new THREE.Vector3(center.x + distance * 0.7, center.y + distance * 0.7, center.z + distance * 0.7),
   lookAt: center,
   zoom,
   box,
  };
 }, [extractKey]);

 // Reset view (show all)
 const resetView = useCallback(() => {
  if (!controlsRef.current || !scene) return;
  setBoundingBox(null);

  const box = new THREE.Box3();
  let hasTarget = false;
  scene.traverse((child: any) => {
    if (child.isMesh && !child.userData.isWireframe) {
     const meshName = (child.name || '').toLowerCase();
     if (meshName.includes('fill')) return;
     box.expandByObject(child);
     hasTarget = true;
    }
   });
  if (hasTarget) {
   const center = box.getCenter(new THREE.Vector3());
   const size = box.getSize(new THREE.Vector3());
   const maxDim = Math.max(size.x, size.y, size.z);
   const isMobile = window.innerWidth < 640;
   const fillRatio = isMobile ? 2 * 0.7 : 2;
   const targetZoom = Math.min(500, Math.max(5, (800 * fillRatio) / maxDim));
   const distance = maxDim * 1.5;
   sceneBounds.current = { center: center.clone(), maxDim };
   setFocusTarget({
    position: new THREE.Vector3(center.x + distance * 0.7, center.y + distance * 0.7, center.z + distance * 0.7),
    lookAt: center,
    zoom: targetZoom,
   });
  }
 }, [scene]);

 // Auto-reset on first load
 useEffect(() => {
  if (scene) {
   const timer = setTimeout(() => resetView(), 120);
   return () => clearTimeout(timer);
  }
 }, [scene, resetView]);

  // Focus when focusModuleNames changes
  useEffect(() => {
   if (!scene) return;
   if (focusModuleNames && focusModuleNames.length > 0) {
    const target = computeFocusTarget(scene, focusModuleNames);
    if (target) {
     setFocusTarget(target);
     setBoundingBox(target.box);
    } else {
     setBoundingBox(null);
    }
   } else {
    resetView();
   }
  }, [focusModuleNames, scene, computeFocusTarget, resetView]);

 if (error) {
  return (
   <div className="w-full h-full bg-gray-100 flex flex-col items-center justify-center p-8 text-center space-y-4">
    <div className="p-4 bg-red-100 text-red-500 rounded-full">
     <AlertCircle size={32} />
    </div>
    <div className="space-y-1">
     <p className="font-black text-sm uppercase tracking-widest text-gray-800">Không thể tải mô hình</p>
     <p className="text-[10px] text-gray-500 max-w-xs break-all">Mô hình có thể đã bị xóa hoặc link không tồn tại (404)</p>
    </div>
    <button
     onClick={() => window.location.reload()}
     className="flex items-center space-x-2 px-6 py-2 bg-gray-800 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-black transition-all shadow-lg active:scale-95"
    >
     <RefreshCw size={14} />
     <span>Thử tải lại</span>
    </button>
   </div>
  );
 }

 return (
  <div className="w-full h-full bg-[#f8f9fa] relative group">
   <Canvas
    key={isOrtho ? 'ortho' : 'persp'}
    orthographic={isOrtho}
    camera={isOrtho ? { zoom: 55, position: [100, 100, 100] } : { fov: 50, position: [100, 100, 100] }}
    shadows={{ type: THREE.PCFShadowMap }}
    gl={{ antialias: true }}
   >
    <ambientLight intensity={0.65} />
    <directionalLight position={[20, 40, 20]} intensity={1.2} />
    <Suspense fallback={<Loader />}>
     <ErrorBoundary onError={setError}>
      <Model url={url} onLoad={setScene} onError={setError} />
     </ErrorBoundary>
    </Suspense>
    <FocusAnimator target={focusTarget} onDone={() => setFocusTarget(null)} controlsRef={controlsRef} />
    {showBoundingBox && <FocusBoundingBox box={boundingBox} clusterKey={focusKey || ''} />}
    <OrbitControls ref={controlsRef} enableRotate enableZoom enablePan={false} makeDefault />
   </Canvas>

    <div className="absolute bottom-3 right-3 flex items-center space-x-2">
     <button type="button" onClick={() => { setBoundingBox(null); resetView(); }} title="Tự động căn góc Isometric"
      className="p-2 bg-white/95 backdrop-blur-sm text-slate-700 rounded-lg shadow-lg hover:text-indigo-600 transition-all border border-slate-200 cursor-pointer">
      <Focus size={14} />
     </button>
     <button type="button" onClick={() => setShowBoundingBox(v => !v)}
      title={showBoundingBox ? 'Ẩn khung bounding' : 'Hiện khung bounding'}
      className={`p-2 bg-white/95 backdrop-blur-sm rounded-lg shadow-lg transition-all border cursor-pointer ${
       showBoundingBox ? 'text-indigo-600 bg-indigo-50 border-indigo-200' : 'text-slate-700 hover:text-indigo-600 border-slate-200'
      }`}>
      <Box size={14} />
     </button>
     <button type="button" onClick={() => {
     const bounds = sceneBounds.current;
     if (bounds) {
      const { center, maxDim } = bounds;
      const distance = maxDim * 1.5;
      const pos = new THREE.Vector3(center.x + distance * 0.7, center.y + distance * 0.7, center.z + distance * 0.7);
      setFocusTarget({ position: pos, lookAt: center.clone(), zoom: 55 });
     }
     setIsOrtho(!isOrtho);
    }}
     title={isOrtho ? 'Chuyển sang Perspective' : 'Chuyển sang Orthographic'}
     className={`p-2 bg-white/95 backdrop-blur-sm rounded-lg shadow-lg transition-all border cursor-pointer ${
      isOrtho ? 'text-slate-700 hover:text-indigo-600 border-slate-200' : 'text-indigo-600 bg-indigo-50 border-indigo-200'
     }`}>
     <Camera size={14} />
    </button>
   </div>

   <div className="absolute top-3 left-3 pointer-events-none">
    <div className="bg-slate-900/80 backdrop-blur-sm px-2 py-1 rounded-lg text-[8px] font-black text-white uppercase tracking-widest border border-slate-800">
     Mô Hình 3D Toàn Bộ
    </div>
   </div>
  </div>
 );
}
