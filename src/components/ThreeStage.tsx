import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { VisualConfig, HandData } from '../types';
import { Upload, HelpCircle, FileImage, Layers3, Activity, RefreshCw } from 'lucide-react';
import { SlimeAudio } from './SlimeAudio';

interface ThreeStageProps {
  handData: HandData;
  visualConfig: VisualConfig;
  onSvgUploaded: (svg: string, filename: string) => void;
  // Let's pass image-specific states from the master
  heightmapUrl: string | null;
  diffuseUrl: string | null;
  imageName: string | null;
  onImageProcessed: (heightmap: string, diffuse: string, name: string) => void;
  onClearImage: () => void;
  onVisualConfigChange?: React.Dispatch<React.SetStateAction<VisualConfig>>;
}

// 2nd Order ODE physical nodes grid dimensions
const GRID_SIZE = 128;

/**
 * Creative CPU Fluid Advection & Color Smudge blending algorithm for Slime Mode.
 * Drags and vortex-twists pixels in a bounding box centered on user actions.
 * Integrates high-fidelity fluid advection, bilateral interpolation, clamp-to-edge alpha protection,
 * and high-performance localized Gaussian dispersion/diffusion.
 */
function mixColors(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  lastCx: number,
  lastCy: number,
  radius: number,
  heightmapCanvas: HTMLCanvasElement | null,
  originalPurePixels: Uint8ClampedArray | null = null,
  actConfig?: VisualConfig
) {
  const width = 512;
  const height = 512;

  const vx = cx - lastCx;
  const vy = cy - lastCy;
  const dragSpeed = Math.sqrt(vx * vx + vy * vy);
  if (dragSpeed < 0.2) return;

  const processRadius = radius * 1.35;
  const minX = Math.max(0, Math.floor(Math.min(cx, lastCx) - processRadius));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(cx, lastCx) + processRadius));
  const minY = Math.max(0, Math.floor(Math.min(cy, lastCy) - processRadius));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(cy, lastCy) + processRadius));

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  if (boxW <= 0 || boxH <= 0) return;

  const imgData = ctx.getImageData(minX, minY, boxW, boxH);
  const srcPixels = new Uint8ClampedArray(imgData.data);
  const destPixels = imgData.data;

  let hCtx: CanvasRenderingContext2D | null = null;
  let hData: ImageData | null = null;
  if (heightmapCanvas) {
    hCtx = heightmapCanvas.getContext('2d');
    if (hCtx) { hData = hCtx.getImageData(minX, minY, boxW, boxH); }
  }

  // 获取体内干净的备用固有色（取自 originalPurePixels 快照核心，完全无污染）
  const getPureCoreBackup = (targetIdx: number) => {
    // 逆着滑动方向往史莱姆深处搜寻一个相对稳定的核心点
    const stepX = cx - lastCx;
    const stepY = cy - lastCy;
    const stepLen = Math.sqrt(stepX * stepX + stepY * stepY);
    if (stepLen > 0.1) {
      const dx = -stepX / stepLen;
      const dy = -stepY / stepLen;
      for (let step = 5; step <= 35; step++) {
        const sx = Math.round(cx + dx * step);
        const sy = Math.round(cy + dy * step);
        if (sx >= 0 && sx < 512 && sy >= 0 && sy < 512) {
          const snapIdx = (sy * 512 + sx) * 4;
          if (originalPurePixels && originalPurePixels[snapIdx + 3] >= 240) {
            return { r: originalPurePixels[snapIdx], g: originalPurePixels[snapIdx + 1], b: originalPurePixels[snapIdx + 2] };
          }
        }
      }
    }
    return { r: srcPixels[targetIdx], g: srcPixels[targetIdx + 1], b: srcPixels[targetIdx + 2] };
  };

  // 🛠️ 核心修复 1：修正采样函数。如果是外部空气，可以借用体内的 RGB 颜色，但 Alpha 必须保留为原本的透明/半透明值！
  const getClampedColor = (absoluteX: number, absoluteY: number) => {
    const localX = Math.max(0, Math.min(boxW - 1, Math.round(absoluteX - minX)));
    const localY = Math.max(0, Math.min(boxH - 1, Math.round(absoluteY - minY)));
    const srcIdx = (localY * boxW + localX) * 4;

    const originalAlpha = srcPixels[srcIdx + 3];

    // 如果本身就是比较坚实的像素，正常返回
    if (originalAlpha >= 200) {
      return { r: srcPixels[srcIdx], g: srcPixels[srcIdx + 1], b: srcPixels[srcIdx + 2], a: originalAlpha };
    }

    // 否则说明踩到了边缘或空气区（originalAlpha 较低）。我们需要寻找干净的 RGB 填充，但维持它原本的低 Alpha
    const stepX = cx - absoluteX;
    const stepY = cy - absoluteY;
    const stepLen = Math.sqrt(stepX * stepX + stepY * stepY);
    if (stepLen > 0.1) {
      const dx = stepX / stepLen;
      const dy = stepY / stepLen;
      for (let step = 1; step <= 30; step++) {
        const searchX = Math.round(absoluteX + dx * step);
        const searchY = Math.round(absoluteY + dy * step);
        if (searchX >= minX && searchX <= maxX && searchY >= minY && searchY <= maxY) {
          const sLocalX = searchX - minX;
          const sLocalY = searchY - minY;
          const sIdx = (sLocalY * boxW + sLocalX) * 4;
          if (srcPixels[sIdx + 3] >= 200) {
            // 💡 关键：RGB 使用体内干净的颜色，但是 Alpha 必须保持原采样点的低透明度，暴露其空气本质！
            return { r: srcPixels[sIdx], g: srcPixels[sIdx + 1], b: srcPixels[sIdx + 2], a: originalAlpha };
          }
        }
      }
    }
    return { r: srcPixels[srcIdx], g: srcPixels[srcIdx + 1], b: srcPixels[srcIdx + 2], a: originalAlpha };
  };

  // 🛠️ 核心修复 2：更加严格的色彩去污染拦截器
  const cleanColorFactor = (
    c: { r: number; g: number; b: number; a: number },
    gX: number,
    gY: number,
    targetIdx: number
  ) => {
    // 只要有变透趋势，或者查出它是外围环境
    if (c.a < 250) {
      const snapIdx = (gY * 512 + gX) * 4;
      
      if (originalPurePixels && snapIdx >= 0 && snapIdx < originalPurePixels.length - 3) {
        const snapA = originalPurePixels[snapIdx + 3];
        if (snapA >= 100) {
          // 属于公仔原始肉体范围，用快照里的初始无瑕疵原色
          c.r = originalPurePixels[snapIdx];
          c.g = originalPurePixels[snapIdx + 1];
          c.b = originalPurePixels[snapIdx + 2];
        } else {
          // 彻底属于外部背景区。强制注入最新的纯净核心绿色，绝对斩断外部 255 颜色的混入
          const coreColor = getPureCoreBackup(targetIdx);
          c.r = coreColor.r;
          c.g = coreColor.g;
          c.b = coreColor.b;
        }
      } else {
        const coreColor = getPureCoreBackup(targetIdx);
        c.r = coreColor.r; c.g = coreColor.g; c.b = coreColor.b;
      }
    }
    return c;
  };

  // Keep a clean pristine copy of the heightmap data to calculate correct displacement bulging
  let origHeightmap: Uint8ClampedArray | null = null;
  if (hData) {
    origHeightmap = new Uint8ClampedArray(hData.data);
  }

  for (let y = minY; y <= maxY; y++) {
    const localY = y - minY;
    for (let x = minX; x <= maxX; x++) {
      const localX = x - minX;

      if (hData) {
        const hIdx = (localY * boxW + localX) * 4;
        if (hData.data[hIdx] < 6) continue;
      }

      // Compute projection and distance to segment [(lastCx, lastCy) -> (cx, cy)]
      const abX = cx - lastCx;
      const abY = cy - lastCy;
      const abLenSq = abX * abX + abY * abY;
      
      let closestX = cx;
      let closestY = cy;
      
      if (abLenSq > 0.001) {
        const apX = x - lastCx;
        const apY = y - lastCy;
        const t = Math.max(0.0, Math.min(1.0, (apX * abX + apY * abY) / abLenSq));
        closestX = lastCx + t * abX;
        closestY = lastCy + t * abY;
      }

      const dx = x - closestX;
      const dy = y - closestY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < radius) {
        // --- 1. Rigidity Repulsion & Advection Cut Off (Touch Vacuum) ---
        // Clear back-advection pull to zero to prevent sucking colors backwards from external white surroundings
        const pullX = 0;
        const pullY = 0;

        const W = Math.pow(1.0 - dist / radius, 1.8);
        const twistVal = (actConfig && actConfig.twist !== undefined) ? actConfig.twist : 1.0;
        const swirlStrength = 0.58 * twistVal * Math.min(2.2, dragSpeed * 0.14);
        const angle = W * swirlStrength * Math.sign(vx);
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        const rx = dx * cosA - dy * sinA;
        const ry = dx * sinA + dy * cosA;

        const absSrcX = x + (rx - dx) - pullX;
        const absSrcY = y + (ry - dy) - pullY;

        const x0 = Math.max(minX, Math.min(maxX, Math.floor(absSrcX)));
        const x1 = Math.max(minX, Math.min(maxX, x0 + 1));
        const y0 = Math.max(minY, Math.min(maxY, Math.floor(absSrcY)));
        const y1 = Math.max(minY, Math.min(maxY, y0 + 1));

        const tx = absSrcX - Math.floor(absSrcX);
        const ty = absSrcY - Math.floor(absSrcY);

        const targetIdx = (localY * boxW + localX) * 4;

        const c00 = getClampedColor(x0, y0);
        const c10 = getClampedColor(x1, y0);
        const c01 = getClampedColor(x0, y1);
        const c11 = getClampedColor(x1, y1);

        const pureC00 = cleanColorFactor({ ...c00 }, x0, y0, targetIdx);
        const pureC10 = cleanColorFactor({ ...c10 }, x1, y0, targetIdx);
        const pureC01 = cleanColorFactor({ ...c01 }, x0, y1, targetIdx);
        const pureC11 = cleanColorFactor({ ...c11 }, x1, y1, targetIdx);

        const rInterp = (1 - tx) * (1 - ty) * pureC00.r + tx * (1 - ty) * pureC10.r + (1 - tx) * ty * pureC01.r + tx * ty * pureC11.r;
        const gInterp = (1 - tx) * (1 - ty) * pureC00.g + tx * (1 - ty) * pureC10.g + (1 - tx) * ty * pureC01.g + tx * ty * pureC11.g;
        const bInterp = (1 - tx) * (1 - ty) * pureC00.b + tx * (1 - ty) * pureC10.b + (1 - tx) * ty * pureC01.b + tx * ty * pureC11.b;

        // 🔍 【1. 精确计算挤压出的“物质溢出量”（Volume Offset）】
        // Calculate the squeezed mass/volume which is squeezed away by the finger tip
        const isSlime = actConfig?.interactionMode === 'slime';
        const strainMult = (actConfig && actConfig.maxStrainDistMultiplier !== undefined) ? actConfig.maxStrainDistMultiplier : 2.5;
        
        // In Slime Mode, we decouple the imprint force from the 3D inflation parameter to keep it stable,
        // and we use a much sharper falloff exponent so the indentation stays concentrated near the fingertip center,
        // preventing multiple fingertips from merging into a large blurry translucent region.
        const dragPressureCoef = isSlime 
          ? 0.42 
          : 0.45 + ((strainMult - 1.1) / 2.4) * 0.50;

        const originalAlpha = srcPixels[targetIdx + 3];
        const falloff = isSlime 
          ? Math.pow(1.0 - dist / radius, 8.5) 
          : Math.pow(1.0 - dist / radius, 3.5);

        const squeezedAlpha = Math.round(originalAlpha * falloff * dragPressureCoef);
        const minAlphaLimit = isSlime ? 15 : 45;
        const finalA = Math.max(minAlphaLimit, originalAlpha - squeezedAlpha); // Make it thinned (translucent) but NOT completely cut out!

        const finalR = rInterp;
        const finalG = gInterp;
        const finalB = bInterp;

        destPixels[targetIdx]     = Math.round(finalR * 0.84 + srcPixels[targetIdx] * 0.16);
        destPixels[targetIdx + 1] = Math.round(finalG * 0.84 + srcPixels[targetIdx + 1] * 0.16);
        destPixels[targetIdx + 2] = Math.round(finalB * 0.84 + srcPixels[targetIdx + 2] * 0.16);
        destPixels[targetIdx + 3] = finalA; // Set the thinned alpha

        let originalH = 0;
        if (hData && origHeightmap) {
          const srcHIdx = (localY * boxW + localX) * 4;
          originalH = origHeightmap[srcHIdx];
          const squeezedHeight = Math.round(originalH * falloff * dragPressureCoef);
          const minHeightLimit = isSlime ? 8 : 45;
          const finalHeight = Math.max(minHeightLimit, originalH - squeezedHeight); // Thinned height but not zero!
          hData.data[srcHIdx] = finalHeight;
          hData.data[srcHIdx + 1] = finalHeight;
          hData.data[srcHIdx + 2] = finalHeight;
        }

        // 🚀 【2. 刚性推向侧边并堆积（Mass Accumulation）】与 🎨 【3. 边缘动态隆起视觉表现】
        // Calculate rejection vector and target pile coordinates
        const pushRange = radius - dist + 2.0;
        const pushX = dist > 0.01 ? dx / dist : 0;
        const pushY = dist > 0.01 ? dy / dist : 0;

        const targetX = Math.round(x + pushX * pushRange);
        const targetY = Math.round(y + pushY * pushRange);

        if (targetX >= minX && targetX <= maxX && targetY >= minY && targetY <= maxY) {
          const clampTX = Math.max(0, Math.min(511, targetX));
          const clampTY = Math.max(0, Math.min(511, targetY));
          const snapTIdx = (clampTY * 512 + clampTX) * 4;

          // Ensure the piling target is within the slime’s original body shape to prevent bleed
          const isTargetInsideSlime = originalPurePixels && snapTIdx >= 0 && snapTIdx < originalPurePixels.length - 3
            ? originalPurePixels[snapTIdx + 3] > 10
            : true;

          if (isTargetInsideSlime) {
            const tLocalX = targetX - minX;
            const tLocalY = targetY - minY;
            const tIdx = (tLocalY * boxW + tLocalX) * 4;

            // Pile alpha up
            destPixels[tIdx + 3] = Math.min(255, destPixels[tIdx + 3] + Math.round(squeezedAlpha * 0.85));
            // Mix color beautifully
            destPixels[tIdx]     = Math.round(destPixels[tIdx] * 0.7 + finalR * 0.3);
            destPixels[tIdx + 1] = Math.round(destPixels[tIdx + 1] * 0.7 + finalG * 0.3);
            destPixels[tIdx + 2] = Math.round(destPixels[tIdx + 2] * 0.7 + finalB * 0.3);

            if (hData && origHeightmap) {
              const squeezedHeight = Math.round(originalH * falloff * dragPressureCoef);
              const bStrength = (actConfig && actConfig.bulgeStrength !== undefined) ? actConfig.bulgeStrength : 0.35;
              // Map bulgeStrength (range 0.0 to 0.6) representing juicy bulge height multiplier (from 0.0 to 2.4x)
              const bulgeHeightMultiplier = bStrength * 4.0;
              hData.data[tIdx] = Math.min(255, hData.data[tIdx] + Math.round(squeezedHeight * bulgeHeightMultiplier));
              const tRed = hData.data[tIdx];
              hData.data[tIdx + 1] = tRed;
              hData.data[tIdx + 2] = tRed;
            }
          }
        }
      }
    }
  }

  // Step 2: Localized Gaussian diffusion (3x3 Blur Pass) for both colors and heightmaps!
  const advectedData = new Uint8ClampedArray(destPixels);
  let advHeightmap: Uint8ClampedArray | null = null;
  if (hData) {
    advHeightmap = new Uint8ClampedArray(hData.data);
  }

  const blurRadius = radius * 1.4; // expanded slightly to soften the transition into the main slime body smoothly
  for (let y = 1; y < boxH - 1; y++) {
    const globalY = minY + y;
    for (let x = 1; x < boxW - 1; x++) {
      const globalX = minX + x;

      // Compute projection and distance to segment [(lastCx, lastCy) -> (cx, cy)]
      const abX = cx - lastCx;
      const abY = cy - lastCy;
      const abLenSq = abX * abX + abY * abY;
      
      let closestX = cx;
      let closestY = cy;
      
      if (abLenSq > 0.001) {
        const apX = globalX - lastCx;
        const apY = globalY - lastCy;
        const t = Math.max(0.0, Math.min(1.0, (apX * abX + apY * abY) / abLenSq));
        closestX = lastCx + t * abX;
        closestY = lastCy + t * abY;
      }

      const dx = globalX - closestX;
      const dy = globalY - closestY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < blurRadius) {
        const targetIdx = (y * boxW + x) * 4;

        if (advectedData[targetIdx + 3] < 15) continue;

        let sumR = 0, sumG = 0, sumB = 0, sumW = 0;
        let sumH = 0, sumHW = 0;
        const kernel = [
          { kx: -1, ky: -1, w: 1 }, { kx: 0, ky: -1, w: 2 }, { kx: 1, ky: -1, w: 1 },
          { kx: -1, ky:  0, w: 2 }, { kx: 0, ky:  0, w: 4 }, { kx: 1, ky:  0, w: 2 },
          { kx: -1, ky:  1, w: 1 }, { kx: 0, ky:  1, w: 2 }, { kx: 1, ky:  1, w: 1 }
        ];

        for (const k of kernel) {
          const nx = x + k.kx;
          const ny = y + k.ky;
          const nIdx = (ny * boxW + nx) * 4;

          if (advectedData[nIdx + 3] >= 15) {
            sumR += advectedData[nIdx] * k.w;
            sumG += advectedData[nIdx + 1] * k.w;
            sumB += advectedData[nIdx + 2] * k.w;
            sumW += k.w;
          }
          if (advHeightmap && advHeightmap[nIdx] > 10) {
            sumH += advHeightmap[nIdx] * k.w;
            sumHW += k.w;
          }
        }

        if (sumW > 0) {
          destPixels[targetIdx] = Math.round(destPixels[targetIdx] * 0.65 + (sumR / sumW) * 0.35);
          destPixels[targetIdx + 1] = Math.round(destPixels[targetIdx + 1] * 0.65 + (sumG / sumW) * 0.35);
          destPixels[targetIdx + 2] = Math.round(destPixels[targetIdx + 2] * 0.65 + (sumB / sumW) * 0.35);
        }

        if (hData && advHeightmap && sumHW > 0) {
          const nextH = Math.round(hData.data[targetIdx] * 0.60 + (sumH / sumHW) * 0.40);
          hData.data[targetIdx] = nextH;
          hData.data[targetIdx + 1] = nextH;
          hData.data[targetIdx + 2] = nextH;
        }
      }
    }
  }

  if (heightmapCanvas && hCtx && hData) {
    hCtx.putImageData(hData, minX, minY);
  }
  ctx.putImageData(imgData, minX, minY);
}

export default function ThreeStage({
  handData,
  visualConfig,
  heightmapUrl,
  diffuseUrl,
  imageName,
  onImageProcessed,
  onClearImage,
  onVisualConfigChange
}: ThreeStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragAreaRef = useRef<HTMLDivElement>(null);
  
  const [dragActive, setDragActive] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const stretchStateRef = useRef({
    isStretching: false,
    startDx: 1.0,
    startDy: 1.0,
    startScaleX: 1.0,
    startScaleY: 1.0,
    scaleX: 1.0,
    scaleY: 1.0,
    scaleVelX: 0.0,
    scaleVelY: 0.0,
  });

  // Physics presets loaded from master config (Stiffness & Damping)
  // Let's configure custom spring mechanics based on physical variables in config
  // Let's add parameters in refs to keep the simulation loops light and dynamic
  const handDataRef = useRef(handData);
  const configRef = useRef(visualConfig);
  const heightmapUrlRef = useRef(heightmapUrl);
  const diffuseUrlRef = useRef(diffuseUrl);
  const handPinchStartRef = useRef<{ x: number; y: number; active: boolean }>({ x: 0, y: 0, active: false });
  const prevHandPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const prevFingerPositionsRef = useRef<Record<string, { x: number; y: number }>>({});
  const wasDraggingRef = useRef(false);

  useEffect(() => {
    handDataRef.current = handData;
    configRef.current = visualConfig;
    heightmapUrlRef.current = heightmapUrl;
    diffuseUrlRef.current = diffuseUrl;
  }, [handData, visualConfig, heightmapUrl, diffuseUrl]);

  // Three.js instances mapped to refs
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const geometryRef = useRef<THREE.PlaneGeometry | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  
  // Real-time canvas textures
  const heightmapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const diffuseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const heightmapTexRef = useRef<THREE.CanvasTexture | null>(null);
  const diffuseTexRef = useRef<THREE.CanvasTexture | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  
  // Cache references for original un-smeared imagery to enable Slime Restoration/Unmixing
  const imgDRef = useRef<HTMLImageElement | null>(null);
  const originalPurePixelsRef = useRef<Uint8ClampedArray | null>(null);
  const originalHeightmapPixelsRef = useRef<Uint8ClampedArray | null>(null);

  // CPU physical nodes arrays for high frequency jiggling integration!
  const physicsNodesRef = useRef<Array<{
    x: number;   // current
    y: number;
    z: number;
    vx: number;  // velocity
    vy: number;
    vz: number;
    ox: number;  // dynamic/plastic home position
    oy: number;
    oz: number;  // rest puffed thickness target
    ox_orig: number; // immutable original flat position
    oy_orig: number; // immutable original flat position
    oz_orig: number; // immutable original rest puffed thick
    hVal: number; // raw sampled height
    ou: number;   // original UV coordinate u
    ov: number;   // original UV coordinate v
    grabInfluence?: number; // locked relative drag influence weight
    originalAlpha?: number; // original alpha transparency from heightmap/sticker
  }>>([]);

  // Interactivity pointer anchor constraints
  const grabStateRef = useRef<{
    active: boolean;
    clickX: number;
    clickY: number;
    currentX: number;
    currentY: number;
    lastX?: number;
    lastY?: number;
    u: number;
    v: number;
    pressEnergy: number;
  }>({
    active: false,
    clickX: 0,
    clickY: 0,
    currentX: 0,
    currentY: 0,
    u: 0.5,
    v: 0.5,
    pressEnergy: 0.0
  });

  // Track previous frame hand coords to enable seamless webcam pinch advection
  const lastHandPosRef = useRef({ x: 0, y: 0, active: false });

  // --- IMAGE PRE-PROCESSING ENGINE ---
  // Centrally cropping, auto-extracting boundary coordinates, and rendering progressives
  const processImageToPuffyCanvas = (img: HTMLImageElement, name: string) => {
    const size = 512;
    
    // Create temporary offscreen workspace canvases
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = size;
    srcCanvas.height = size;
    const sCtx = srcCanvas.getContext('2d');
    if (!sCtx) return;

    // Scale and center source image nicely
    const aspect = img.width / img.height;
    let dw = size;
    let dh = size;
    if (aspect > 1) {
      dh = size / aspect;
    } else {
      dw = size * aspect;
    }
    const dx = (size - dw) / 2;
    const dy = (size - dh) / 2;
    sCtx.drawImage(img, dx, dy, dw, dh);

    // Scan pixels for white backdrops or transparency limits
    const imgData = sCtx.getImageData(0, 0, size, size);
    const pix = imgData.data;

    let isWhiteBg = false;
    const cornerstoneIndices = [0, (size - 1) * 4, (size * (size - 1)) * 4, (size * size - 1) * 4];
    let whiteCornerCount = 0;
    cornerstoneIndices.forEach(idx => {
      const r = pix[idx]; const g = pix[idx+1]; const b = pix[idx+2]; const a = pix[idx+3];
      if (a > 180 && r > 238 && g > 238 && b > 238) {
        whiteCornerCount++;
      }
    });
    if (whiteCornerCount >= 2) {
      isWhiteBg = true;
    }

    // Capture bounding frame boundaries
    let minX = size; let maxX = 0;
    let minY = size; let maxY = 0;
    let hasForeground = false;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const r = pix[idx]; const g = pix[idx+1]; const b = pix[idx+2]; const a = pix[idx+3];
        
        let isForeground = false;
        if (isWhiteBg) {
          isForeground = (a > 30) && !(r > 230 && g > 230 && b > 230);
        } else {
          isForeground = (a > 20);
        }

        if (isForeground) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          hasForeground = true;
        }
      }
    }

    if (!hasForeground) {
      minX = 40; maxX = size - 40;
      minY = 40; maxY = size - 40;
    }

    // Center and crop with padded margins
    const margin = 32;
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = size;
    cropCanvas.height = size;
    const cCtx = cropCanvas.getContext('2d');
    if (!cCtx) return;

    let scale = (size - margin * 2) / Math.max(cropW, cropH);
    if (scale > 4) scale = 4; // cap upscale limit

    const targetW = cropW * scale;
    const targetH = cropH * scale;
    const tx = (size - targetW) / 2;
    const ty = (size - targetH) / 2;

    cCtx.clearRect(0, 0, size, size);
    cCtx.drawImage(srcCanvas, minX, minY, cropW, cropH, tx, ty, targetW, targetH);

    // Retain clean outlines
    const cropImgData = cCtx.getImageData(0, 0, size, size);
    const cropPix = cropImgData.data;
    if (isWhiteBg) {
      for (let i = 0; i < cropPix.length; i += 4) {
        const r = cropPix[i]; const g = cropPix[i+1]; const b = cropPix[i+2];
        if (r > 225 && g > 225 && b > 225) {
          cropPix[i+3] = 0; // turn transparent
        }
      }
      cCtx.putImageData(cropImgData, 0, 0);
    }

    // Generate clean centered diffuse sticker
    const diffuseCanvas = document.createElement('canvas');
    diffuseCanvas.width = size;
    diffuseCanvas.height = size;
    const dCtx = diffuseCanvas.getContext('2d');
    if (dCtx) {
      dCtx.drawImage(cropCanvas, 0, 0);
    }
    const diffuseUrl = diffuseCanvas.toDataURL();

    // Generate high frequency rounded elevation heightmap (Center bulges, boundary slopes collapse)
    const heightmapCanvas = document.createElement('canvas');
    heightmapCanvas.width = size;
    heightmapCanvas.height = size;
    const hCtx = heightmapCanvas.getContext('2d');
    if (hCtx) {
      hCtx.fillStyle = '#000000';
      hCtx.fillRect(0, 0, size, size);

      const cropCtx = cropCanvas.getContext('2d');
      if (cropCtx) {
        const cropImgData = cropCtx.getImageData(0, 0, size, size);
        const cropPix = cropImgData.data;

        // 1. Get pixel-level transparency metadata and build foreground mask
        const isForeground = new Uint8Array(size * size);
        for (let i = 0; i < cropPix.length; i += 4) {
          const a = cropPix[i + 3];
          isForeground[i / 4] = (a > 12) ? 1 : 0;
        }

        // 2. Compute outer silhouette distance field (dist1) using 2-pass Chamfer distance transform
        const dist1 = new Float32Array(size * size);
        for (let i = 0; i < size * size; i++) {
          dist1[i] = isForeground[i] ? 999999 : 0;
        }

        // Pass 1: Forward
        for (let y = 0; y < size; y++) {
          const yMul = y * size;
          for (let x = 0; x < size; x++) {
            const idx = yMul + x;
            if (dist1[idx] > 0) {
              let minD = dist1[idx];
              if (x > 0) minD = Math.min(minD, dist1[idx - 1] + 1);
              if (y > 0) minD = Math.min(minD, dist1[idx - size] + 1);
              if (x > 0 && y > 0) minD = Math.min(minD, dist1[idx - size - 1] + 1.414);
              if (x < size - 1 && y > 0) minD = Math.min(minD, dist1[idx - size + 1] + 1.414);
              dist1[idx] = minD;
            }
          }
        }
        // Pass 2: Backward
        for (let y = size - 1; y >= 0; y--) {
          const yMul = y * size;
          for (let x = size - 1; x >= 0; x--) {
            const idx = yMul + x;
            if (dist1[idx] > 0) {
              let minD = dist1[idx];
              if (x < size - 1) minD = Math.min(minD, dist1[idx + 1] + 1);
              if (y < size - 1) minD = Math.min(minD, dist1[idx + size] + 1);
              if (x > 0 && y < size - 1) minD = Math.min(minD, dist1[idx + size - 1] + 1.414);
              if (x < size - 1 && y < size - 1) minD = Math.min(minD, dist1[idx + size + 1] + 1.414);
              dist1[idx] = minD;
            }
          }
        }

        // Find max element in dist1 to normalize
        let maxDist1 = 0.0001;
        for (let i = 0; i < size * size; i++) {
          if (dist1[i] > maxDist1) {
            maxDist1 = dist1[i];
          }
        }

        // 3. Compute Grayscale & Blur to smooth out noise for high-quality Sobel gradient
        const gray = new Float32Array(size * size);
        for (let i = 0; i < cropPix.length; i += 4) {
          const r = cropPix[i];
          const g = cropPix[i + 1];
          const b = cropPix[i + 2];
          gray[i / 4] = 0.299 * r + 0.587 * g + 0.114 * b;
        }

        const blurredGray = new Float32Array(size * size);
        for (let y = 0; y < size; y++) {
          const yMul = y * size;
          for (let x = 0; x < size; x++) {
            const idx = yMul + x;
            if (x === 0 || x === size - 1 || y === 0 || y === size - 1) {
              blurredGray[idx] = gray[idx];
              continue;
            }
            let sum = 0;
            for (let ky = -1; ky <= 1; ky++) {
              const kyMul = (y + ky) * size;
              for (let kx = -1; kx <= 1; kx++) {
                sum += gray[kyMul + (x + kx)];
              }
            }
            blurredGray[idx] = sum / 9.0;
          }
        }

        // 4. Run Sobel Edge Detection strictly on INTERNAL pixels (pixels where themselves and all neighbors are foreground)
        const edgeGrad = new Float32Array(size * size);
        let maxGrad = 0.0001;

        for (let y = 1; y < size - 1; y++) {
          const yMul = y * size;
          for (let x = 1; x < size - 1; x++) {
            const idx = yMul + x;
            if (!isForeground[idx]) continue;

            // Only consider neighbors that are fully inside foreground to avoid background interface edge spikes
            let neighborsAreForeground = true;
            for (let ky = -1; ky <= 1; ky++) {
              const kyMul = (y + ky) * size;
              for (let kx = -1; kx <= 1; kx++) {
                if (!isForeground[kyMul + (x + kx)]) {
                  neighborsAreForeground = false;
                  break;
                }
              }
              if (!neighborsAreForeground) break;
            }

            if (neighborsAreForeground) {
              const gx = 
                -1 * blurredGray[(y - 1) * size + (x - 1)] + 1 * blurredGray[(y - 1) * size + (x + 1)] +
                -2 * blurredGray[ y      * size + (x - 1)] + 2 * blurredGray[ y      * size + (x + 1)] +
                -1 * blurredGray[(y + 1) * size + (x - 1)] + 1 * blurredGray[(y + 1) * size + (x + 1)];

              const gy = 
                -1 * blurredGray[(y - 1) * size + (x - 1)] - 2 * blurredGray[(y - 1) * size + x] - 1 * blurredGray[(y - 1) * size + (x + 1)] +
                 1 * blurredGray[(y + 1) * size + (x - 1)] + 2 * blurredGray[(y + 1) * size + x] + 1 * blurredGray[(y + 1) * size + (x + 1)];

              const mag = Math.sqrt(gx * gx + gy * gy);
              edgeGrad[idx] = mag;
              if (mag > maxGrad) {
                maxGrad = mag;
              }
            }
          }
        }

        // 5. Generate internal-edge-based Distance Field (distInternal)
        const distInternal = new Float32Array(size * size);
        const edgeThreshold = maxGrad * 0.18;
        let hasInternalEdges = false;

        for (let i = 0; i < size * size; i++) {
          if (isForeground[i] && edgeGrad[i] > edgeThreshold) {
            distInternal[i] = 0;
            hasInternalEdges = true;
          } else {
            distInternal[i] = 999999;
          }
        }

        if (hasInternalEdges) {
          // Pass 1: Forward
          for (let y = 0; y < size; y++) {
            const yMul = y * size;
            for (let x = 0; x < size; x++) {
              const idx = yMul + x;
              if (distInternal[idx] > 0) {
                let minD = distInternal[idx];
                if (x > 0) minD = Math.min(minD, distInternal[idx - 1] + 1);
                if (y > 0) minD = Math.min(minD, distInternal[idx - size] + 1);
                if (x > 0 && y > 0) minD = Math.min(minD, distInternal[idx - size - 1] + 1.414);
                if (x < size - 1 && y > 0) minD = Math.min(minD, distInternal[idx - size + 1] + 1.414);
                distInternal[idx] = minD;
              }
            }
          }
          // Pass 2: Backward
          for (let y = size - 1; y >= 0; y--) {
            const yMul = y * size;
            for (let x = size - 1; x >= 0; x--) {
              const idx = yMul + x;
              if (distInternal[idx] > 0) {
                let minD = distInternal[idx];
                if (x < size - 1) minD = Math.min(minD, distInternal[idx + 1] + 1);
                if (y < size - 1) minD = Math.min(minD, distInternal[idx + size] + 1);
                if (x > 0 && y < size - 1) minD = Math.min(minD, distInternal[idx + size - 1] + 1.414);
                if (x < size - 1 && y < size - 1) minD = Math.min(minD, distInternal[idx + size + 1] + 1.414);
                distInternal[idx] = minD;
              }
            }
          }
        }

        // 6. Draw processed heights to ImageData
        const hData = hCtx.createImageData(size, size);
        const hPix = hData.data;

        const cap = 18.0; // The distance threshold in pixels for secondary localized sub-inflation

        for (let i = 0; i < size * size; i++) {
          if (!isForeground[i]) {
            hPix[i * 4] = 0;
            hPix[i * 4 + 1] = 0;
            hPix[i * 4 + 2] = 0;
            hPix[i * 4 + 3] = 255;
            continue;
          }

          // A: Spherical ballooning base height (rounded cushion)
          const norm1 = dist1[i] / maxDist1;
          const base_h = Math.pow(Math.sin(norm1 * Math.PI / 2), 0.85);

          // B: Internal local detail dome (0 at internal boundary, 1 in center/plateau)
          let detail_h = 1.0;
          if (hasInternalEdges) {
            const ratio = Math.min(cap, distInternal[i]) / cap;
            detail_h = Math.pow(Math.sin(ratio * Math.PI / 2), 0.9);
          }

          // C: Blend base dome with physical crease valleys
          // If detail_h is 0 (at internal border), local height dips to 64% of base balloon height.
          // Inside closed detail, it rounds back up smoothly to 100% of base sphere level.
          const finalFactor = base_h * (0.64 + 0.36 * detail_h);
          const pixelVal = Math.max(0, Math.min(255, Math.floor(finalFactor * 255)));

          hPix[i * 4] = pixelVal;
          hPix[i * 4 + 1] = pixelVal;
          hPix[i * 4 + 2] = pixelVal;
          hPix[i * 4 + 3] = 255;
        }

        hCtx.putImageData(hData, 0, 0);
      }
    }
    const heightmapUrl = heightmapCanvas.toDataURL();

    // Dispatch processed buffers back to parent state
    onImageProcessed(heightmapUrl, diffuseUrl, name);
  };

  // Setup file loaders
  const loadBlobFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      alert("Please upload an image file (PNG, JPG, SVG, etc.)");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string;
      const img = new Image();
      img.onload = () => {
        processImageToPuffyCanvas(img, file.name);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  };

  // Clipboard Paste support
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const items = e.clipboardData.items;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            loadBlobFile(file);
            break;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  // --- THREE.JS STAGE LIFECYCLE ---
  useEffect(() => {
    const currentContainer = containerRef.current;
    if (!currentContainer || !heightmapUrl || !diffuseUrl) return;
 
    // Create Canvas wrappers for real-time texture updating
    const hCanvas = document.createElement('canvas');
    hCanvas.width = 512;
    hCanvas.height = 512;
    heightmapCanvasRef.current = hCanvas;
 
    const dCanvas = document.createElement('canvas');
    dCanvas.width = 512;
    dCanvas.height = 512;
    diffuseCanvasRef.current = dCanvas;
 
    const width = currentContainer.clientWidth || 600;
    const height = currentContainer.clientHeight || 500;
 
    // 1. Scene setup
    const scene = new THREE.Scene();
    sceneRef.current = scene;
 
    // 2. Camera setup - orthographic projection matches flat magazine print aesthetic beautifully
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
    camera.position.set(0, 0, 6.2);
    const initialZoom = configRef.current?.imageScale !== undefined ? configRef.current.imageScale : 1.0;
    camera.zoom = initialZoom;
    camera.updateProjectionMatrix();
    cameraRef.current = camera;
 
    // 3. WebGL Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    rendererRef.current = renderer;
    currentContainer.appendChild(renderer.domElement);

    // 4. Create Material textures from our offscreen canvases
    const hTexture = new THREE.CanvasTexture(hCanvas);
    hTexture.minFilter = THREE.LinearFilter;
    hTexture.wrapS = THREE.ClampToEdgeWrapping;
    hTexture.wrapT = THREE.ClampToEdgeWrapping;
    heightmapTexRef.current = hTexture;

    const dTexture = new THREE.CanvasTexture(dCanvas);
    dTexture.minFilter = THREE.LinearFilter;
    dTexture.wrapS = THREE.ClampToEdgeWrapping;
    dTexture.wrapT = THREE.ClampToEdgeWrapping;
    diffuseTexRef.current = dTexture;

    // 5. Plane geometry - 24x24 subdivisions defines the high frequency physical grid nodes
    const geometry = new THREE.PlaneGeometry(3.0, 3.0, GRID_SIZE, GRID_SIZE);
    geometryRef.current = geometry;

    // Initialize clean velocities and homes for standard physical vertex nodes list
    const totalVertices = (GRID_SIZE + 1) * (GRID_SIZE + 1);
    const nodes: typeof physicsNodesRef.current = [];
    const posAttr = geometry.attributes.position;
    const uvAttr = geometry.attributes.uv;

    for (let i = 0; i < totalVertices; i++) {
      const vx = posAttr.getX(i);
      const vy = posAttr.getY(i);
      const vz = posAttr.getZ(i);
      const uVal = uvAttr.getX(i);
      const vVal = uvAttr.getY(i);

      nodes.push({
        x: vx, y: vy, z: vz,
        vx: 0, vy: 0, vz: 0,
        ox: vx, oy: vy, oz: vz,
        ox_orig: vx, oy_orig: vy, oz_orig: vz,
        hVal: 0,
        ou: uVal,
        ov: vVal,
        originalAlpha: 0.0
      });
    }
    physicsNodesRef.current = nodes;

    // Load textures immediately
    const imgH = new Image();
    imgH.onload = () => {
      const hCtx = hCanvas.getContext('2d');
      if (hCtx) {
        hCtx.clearRect(0, 0, 512, 512);
        hCtx.drawImage(imgH, 0, 0);
        hTexture.needsUpdate = true;
        originalHeightmapPixelsRef.current = new Uint8ClampedArray(hCtx.getImageData(0, 0, 512, 512).data);

        // Sample height values onto our physical nodes rest array
        for (let i = 0; i < totalVertices; i++) {
          const node = nodes[i];
          // convert model space [-1.5 to 1.5] back to UV space [0 to 1]
          const u = (node.ox + 1.5) / 3.0;
          const v = (node.oy + 1.5) / 3.0;

          const tx = Math.max(0, Math.min(511, Math.floor(u * 512)));
          const ty = Math.max(0, Math.min(511, Math.floor((1 - v) * 512)));
          const pixelVal = hCtx.getImageData(tx, ty, 1, 1).data[0]; // read red
          node.hVal = pixelVal / 255.0;
          node.originalAlpha = node.hVal;
          
          // Apply rest Z bulged cushion target inflation
          node.oz = node.hVal * configRef.current.puffiness * 0.95;
          node.oz_orig = node.oz;
          node.z = node.oz; // start fully inflated
        }
      }
    };
    imgH.src = heightmapUrl;

    const imgD = new Image();
    imgD.onload = () => {
      imgDRef.current = imgD; // cache for Slime re-paint
      const dCtx = dCanvas.getContext('2d');
      if (dCtx) {
        dCtx.clearRect(0, 0, 512, 512);
        dCtx.drawImage(imgD, 0, 0);
        dTexture.needsUpdate = true;
        // Capture pristine出厂原始像素快照缓存
        originalPurePixelsRef.current = new Uint8ClampedArray(dCtx.getImageData(0, 0, 512, 512).data);
      }
    };
    imgD.src = diffuseUrl;

    // 6. Shader setup - customized normal, light and matcap calculations
    const uniforms = {
      uTexture: { value: dTexture },
      uHeightmap: { value: hTexture },
      uTime: { value: 0.0 },
      uMaterialType: { value: 0 }, // 0: Matte, 1: Chrome, 2: Golden, 3: Holographic, 4: Soft Vinyl
      uColorShift: { value: configRef.current.colorShift },
      uIsSlime: { value: configRef.current.interactionMode === 'slime' ? 1.0 : 0.0 },
      uPuffiness: { value: configRef.current.puffiness }
    };

    const vertexShader = `
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vPosition;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = mvPosition.xyz;
        vPosition = position;
        vNormal = normalMatrix * normal;
        gl_Position = projectionMatrix * mvPosition;
      }
    `;

    const fragmentShader = `
      uniform sampler2D uTexture;
      uniform sampler2D uHeightmap;
      uniform float uTime;
      uniform int uMaterialType;
      uniform float uColorShift;
      uniform float uIsSlime;
      uniform float uPuffiness;

      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vPosition;

      void main() {
        // Query the heightmap dynamically using the attached, deforming vertex UVs.
        // This decouples the sticker silhouette from a static clipping grid, ensuring the entire
        // boundary contracts and deforms symmetrically with the underlying mesh.
        vec4 hTex = texture2D(uHeightmap, vUv);
        if (hTex.r < 0.005) {
          discard;
        }

        vec4 texCol = texture2D(uTexture, vUv);
        if (texCol.a < 0.02) {
          discard;
        }
        
        // Use beautifully interpolated vertex-normals for silky-smooth surface gradients with zero visible facet grids
        vec3 normal = normalize(vNormal);

        // Render lighting vectors
        vec3 viewDir = vec3(0.0, 0.0, 1.0);
        vec3 lightDir = normalize(vec3(0.3, 0.45, 0.85));

        // Diffuse map lighting
        float diffuse = max(0.0, dot(normal, lightDir));
        
        // Specular Phong with higher shininess exponent for rubber/vinyl physical reflection
        vec3 reflectDir = reflect(-lightDir, normal);
        float spec = pow(max(0.0, dot(viewDir, reflectDir)), 28.0);

        // Calculate dynamic relative compression ratio (stabilized thickness value)
        // High-fidelity normalization prevents edge-thinned base vertices from dissolving prematurely at rest,
        // ensuring the sticker remains sharp and vibrant except when actively pressed or gouged.
        float thickness = 1.0;
        if (uIsSlime > 0.5) {
          float restHeight = max(0.015, hTex.r * uPuffiness * 0.95);
          thickness = clamp(vPosition.z / restHeight, 0.0, 1.0);
        }

        // Mitigate specular glare and raw white burnout in slime trenches using fluid thickness
        float finalSpec = spec;
        float finalFresnel = pow(1.0 - max(0.0, dot(viewDir, normal)), 3.2);

        if (uIsSlime > 0.5) {
          finalSpec *= thickness;
          finalFresnel *= thickness;
        }

        // Ensure specular, ambient and fresnel highlights are strictly multiplied by texCol.a to reject raw white glow on transparent areas
        float highSpecValue = finalSpec * 0.45 * texCol.a;
        float highFresnelValue = finalFresnel * 0.25 * texCol.a;

        vec3 baseColor = texCol.rgb;
        // Soft wrap-lighting factor (0.78 minimum brightness to preserve vibrant original image details even under extreme 3D inflation)
        float lightFactor = 0.78 + 0.22 * diffuse;
        // --- PREMIUM PUFFY VINYL INFLATABLE LAYER ---
        // Beautifully preserves original colors & textures with high definition specular highlights and deep dimensional shadows
        vec3 litColor = baseColor * lightFactor + vec3(1.0) * highSpecValue + vec3(1.0) * highFresnelValue;

        // Soften feathering edges based on dynamic heightmap lookup for perfect, self-adjusting border masks
        float alpha = smoothstep(0.01, 0.08, hTex.r);

        if (uIsSlime > 0.5) {
          // Dissolve slime body smoothly based on thickness by modulating only the transparency (alpha).
          // This keeps the remaining active body areas perfectly saturated and colorful, without any gray fog shroud!
          gl_FragColor = vec4(litColor, alpha * texCol.a * thickness);
        } else {
          gl_FragColor = vec4(litColor, alpha * texCol.a);
        }
      }
    `;

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true
    });
    materialRef.current = material;

    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    meshRef.current = mesh;

    // Simple warm lighting setup helping Three.js computations
    const lightLoc = new THREE.DirectionalLight(0xffffff, 1.5);
    lightLoc.position.set(2, 3, 4);
    scene.add(lightLoc);

    const ambientLoc = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLoc);

    // 7. Dynamic spring physics loop
    let animId: number;
    let clock = new THREE.Clock();

    const solvePhysicsAndRender = () => {
      animId = requestAnimationFrame(solvePhysicsAndRender);

      const activeHand = handDataRef.current;
      const actConfig = configRef.current;
      const grab = grabStateRef.current;

      const dt = 0.016; 
      const isSlime = actConfig.interactionMode === 'slime';

      // Relax mud/squeezed deformations on canvas and heightmap back towards original shape for beautiful elastic bounce recovery!
      if (isSlime && originalPurePixelsRef.current && originalHeightmapPixelsRef.current) {
        const dCanvas = diffuseCanvasRef.current;
        const hCanvas = heightmapCanvasRef.current;
        if (dCanvas && hCanvas) {
          const dCtx = dCanvas.getContext('2d');
          const hCtx = hCanvas.getContext('2d');
          if (dCtx && hCtx) {
            const dImgData = dCtx.getImageData(0, 0, 512, 512);
            const hImgData = hCtx.getImageData(0, 0, 512, 512);
            const dPixels = dImgData.data;
            const hPixels = hImgData.data;
            const origDPixels = originalPurePixelsRef.current;
            const origHPixels = originalHeightmapPixelsRef.current;
            
            const plasticityVal = actConfig.plasticity !== undefined ? actConfig.plasticity : 0.2;
            // High plasticity means clay memory (slow/low relax rate). Low plasticity means snappy elastic rebound (fast/high relax rate).
            // range: plasticityVal is 0.0 (fast return) to 0.8 (extremely slow/none)
            const relaxRate = Math.max(0.0005, (1.0 - plasticityVal) * 0.035);
            let anyDiff = false;
            
            for (let i = 0; i < dPixels.length; i += 4) {
              const d1 = dPixels[i];
              const o1 = origDPixels[i];
              const d2 = dPixels[i + 1];
              const o2 = origDPixels[i + 1];
              const d3 = dPixels[i + 2];
              const o3 = origDPixels[i + 2];
              const d4 = dPixels[i + 3];
              const o4 = origDPixels[i + 3];
              
              const h1 = hPixels[i];
              const oh1 = origHPixels[i];

              if (d1 !== o1 || d2 !== o2 || d3 !== o3 || d4 !== o4 || h1 !== oh1) {
                anyDiff = true;

                // Color alpha channel relaxation
                const diffA = o4 - d4;
                if (Math.abs(diffA) > 0.5) {
                  dPixels[i + 3] = Math.round(d4 + diffA * relaxRate);
                } else {
                  dPixels[i + 3] = o4;
                }

                // Color channels relaxation
                const diffR = o1 - d1;
                const diffG = o2 - d2;
                const diffB = o3 - d3;
                if (Math.abs(diffR) > 0.5) dPixels[i] = Math.round(d1 + diffR * relaxRate); else dPixels[i] = o1;
                if (Math.abs(diffG) > 0.5) dPixels[i + 1] = Math.round(d2 + diffG * relaxRate); else dPixels[i + 1] = o2;
                if (Math.abs(diffB) > 0.5) dPixels[i + 2] = Math.round(d3 + diffB * relaxRate); else dPixels[i + 2] = o3;

                // Heightmap channel relaxation (using symmetric R, G, B)
                const diffH = oh1 - h1;
                if (Math.abs(diffH) > 0.5) {
                  const nextH = Math.round(h1 + diffH * relaxRate);
                  hPixels[i] = nextH;
                  hPixels[i + 1] = nextH;
                  hPixels[i + 2] = nextH;
                } else {
                  hPixels[i] = oh1;
                  hPixels[i + 1] = oh1;
                  hPixels[i + 2] = oh1;
                }
              }
            }
            if (anyDiff) {
              dCtx.putImageData(dImgData, 0, 0);
              hCtx.putImageData(hImgData, 0, 0);
              
              if (diffuseTexRef.current) {
                diffuseTexRef.current.needsUpdate = true;
              }
              if (heightmapTexRef.current) {
                heightmapTexRef.current.needsUpdate = true;
              }
            }
          }
        }
      }

      interface FingerPointer {
        id: string;
        x: number;
        y: number;
        prevX: number;
        prevY: number;
        velX: number;
        velY: number;
        active: boolean;
      }
      const activeFingers: FingerPointer[] = [];

      if (activeHand.active) {
        const hands = activeHand.hands && activeHand.hands.length > 0 ? activeHand.hands : [activeHand];
        hands.forEach((hand, handIdx) => {
          if (hand.skeletonPoints && hand.skeletonPoints.length > 0) {
            const tipIndices = [4, 8, 12, 16, 20];
            tipIndices.forEach(idx => {
              const pt = hand.skeletonPoints[idx];
              if (pt) {
                const fId = `${handIdx}_${idx}`;
                const fx = (pt.x - 0.5) * 3.75;
                const fy = (0.5 - pt.y) * 3.75;

                const prev = prevFingerPositionsRef.current[fId] || { x: fx, y: fy };
                const fVelX = (fx - prev.x) / dt;
                const fVelY = (fy - prev.y) / dt;

                activeFingers.push({
                  id: fId,
                  x: fx,
                  y: fy,
                  prevX: prev.x,
                  prevY: prev.y,
                  velX: fVelX,
                  velY: fVelY,
                  active: true
                });

                prevFingerPositionsRef.current[fId] = { x: fx, y: fy };
              }
            });
          } else {
            const fId = `${handIdx}_palm`;
            const fx = hand.x * 1.5;
            const fy = hand.y * 1.5;

            const prev = prevFingerPositionsRef.current[fId] || { x: fx, y: fy };
            const fVelX = (fx - prev.x) / dt;
            const fVelY = (fy - prev.y) / dt;

            activeFingers.push({
              id: fId,
              x: fx,
              y: fy,
              prevX: prev.x,
              prevY: prev.y,
              velX: fVelX,
              velY: fVelY,
              active: true
            });

            prevFingerPositionsRef.current[fId] = { x: fx, y: fy };
          }
        });
      } else if (grab.active && isSlime) {
        // Generate beautiful simulated finger tip positions clustered around the mouse cursor (grab.currentX, grab.currentY)
        // These offsets mimic an organic right hand gesture pressing onto the 3D surface
        const mx = grab.currentX;
        const my = grab.currentY;
        const scaleFactor = configRef.current?.imageScale !== undefined ? configRef.current.imageScale : 1.0;

        const mouseOffsets = [
          { id: 'mouse_4',  dx: -0.21 / scaleFactor, dy: -0.14 / scaleFactor }, // Thumb
          { id: 'mouse_8',  dx: 0.0,                 dy: 0.0                 }, // Index Finger (locked to cursor)
          { id: 'mouse_12', dx: 0.09 / scaleFactor,  dy: 0.03 / scaleFactor  }, // Middle Finger (slightly longer and higher)
          { id: 'mouse_16', dx: 0.20 / scaleFactor,  dy: -0.04 / scaleFactor }, // Ring Finger
          { id: 'mouse_20', dx: 0.29 / scaleFactor,  dy: -0.15 / scaleFactor }  // Pinky Finger
        ];

        mouseOffsets.forEach(offset => {
          const fx = mx + offset.dx;
          const fy = my + offset.dy;
          const prev = prevFingerPositionsRef.current[offset.id] || { x: fx, y: fy };
          const fVelX = (fx - prev.x) / dt;
          const fVelY = (fy - prev.y) / dt;

          activeFingers.push({
            id: offset.id,
            x: fx,
            y: fy,
            prevX: prev.x,
            prevY: prev.y,
            velX: fVelX,
            velY: fVelY,
            active: true
          });

          prevFingerPositionsRef.current[offset.id] = { x: fx, y: fy };
        });
      }

      const isDragging = grab.active || (activeHand.active && (isSlime ? activeFingers.length > 0 : activeHand.pinch > 0.6));
      if (isDragging) {
        grab.pressEnergy = Math.min(grab.pressEnergy + dt * 2.5, 1.0);
      } else {
        grab.pressEnergy = Math.max(grab.pressEnergy - dt * 4.0, 0.0);
      }

      // Update shader uniform time variables
      material.uniforms.uTime.value = clock.getElapsedTime();

      // Dynamically adjust camera zoom according to imageScale
      if (cameraRef.current) {
        const targetZoom = actConfig.imageScale !== undefined ? actConfig.imageScale : 1.0;
        if (cameraRef.current.zoom !== targetZoom) {
          cameraRef.current.zoom = targetZoom;
          cameraRef.current.updateProjectionMatrix();
        }
      }
      
      // Map material preset selection
      let mTypeId = 4; // default vinyl
      if (actConfig.materialType === 'ceramic') mTypeId = 0;
      else if (actConfig.materialType === 'chrome') mTypeId = 1;
      else if (actConfig.materialType === 'gold') mTypeId = 2;
      else if (actConfig.materialType === 'holo') mTypeId = 3;
      material.uniforms.uMaterialType.value = mTypeId;
      material.uniforms.uIsSlime.value = actConfig.interactionMode === 'slime' ? 1.0 : 0.0;
      material.uniforms.uPuffiness.value = actConfig.puffiness;

      // Rigid physical ODE variables
      const stiffness = actConfig.stiffness !== undefined ? actConfig.stiffness : (isSlime ? 40.0 : 260.0);
      const damping = actConfig.damping !== undefined ? actConfig.damping : (isSlime ? 18.0 : 10.0);
      const cohesion = actConfig.cohesion !== undefined ? actConfig.cohesion : (isSlime ? 160.0 : 180.0);

      // Procedural audio triggering transitions: Touch (Start Drag) & Suction Release (End Drag)
      if (isSlime && (actConfig.soundEnabled !== false)) {
        if (isDragging && !wasDraggingRef.current) {
          SlimeAudio.triggerTouch(stiffness);
        } else if (!isDragging && wasDraggingRef.current) {
          SlimeAudio.triggerRelease(stiffness);
        }
      }
      wasDraggingRef.current = isDragging;

      // Gather current sensor grab coordinates
      interface DragAnchor {
        x: number;
        y: number;
        z: number;
      }
      const activeAnchors: DragAnchor[] = [];

      // Check mouse dragging first
      if (grab.active) {
        activeAnchors.push({
          x: grab.currentX,
          y: grab.currentY,
          z: 0.85
        });
      }

      // Check tracked hands
      if (activeHand.active) {
        if (activeHand.pinch > 0.6) {
          if (!handPinchStartRef.current.active) {
            handPinchStartRef.current = {
              x: activeHand.x * 1.5,
              y: activeHand.y * 1.5,
              active: true
            };
          }
        } else {
          handPinchStartRef.current.active = false;
        }

        const hands = activeHand.hands || [];
        if (hands.length > 0) {
          hands.forEach(h => {
            if (h.pinch > 0.6) {
              activeAnchors.push({
                x: h.x * 1.5,
                y: h.y * 1.5,
                z: 0.95
              });
            }
          });
        } else if (activeHand.pinch > 0.6) {
          activeAnchors.push({
            x: activeHand.x * 1.5,
            y: activeHand.y * 1.5,
            z: 0.95
          });
        }
      } else {
        handPinchStartRef.current.active = false;
      }

      // Handle 2-Hand Axis-Specific Scale Stretching / Compressing
      const stretch = stretchStateRef.current;
      if (!isSlime && activeAnchors.length >= 2) {
        const h1 = activeAnchors[0];
        const h2 = activeAnchors[1];

        const currentDx = Math.abs(h1.x - h2.x);
        const currentDy = Math.abs(h1.y - h2.y);

        if (!stretch.isStretching) {
          stretch.isStretching = true;
          stretch.startDx = Math.max(0.1, currentDx);
          stretch.startDy = Math.max(0.1, currentDy);
          stretch.startScaleX = mesh.scale.x;
          stretch.startScaleY = mesh.scale.y;
        }

        const ratioX = currentDx / stretch.startDx;
        const ratioY = currentDy / stretch.startDy;

        // Apply a high-fidelity elastic sat resistance curve (Math.tanh):
        // f(r) = 1.0 + tanh(r - 1.0) * 0.32
        // When r is very large, ratio is capped smoothly around 1.32, keeping it perfectly within screen bounds.
        const clampRatio = (r: number) => {
          return 1.0 + Math.tanh(r - 1.0) * 0.32;
        };

        const targetScaleX = stretch.startScaleX * clampRatio(ratioX);
        const targetScaleY = stretch.startScaleY * clampRatio(ratioY);

        // Keep stretching extremely premium, stable and strictly visible
        stretch.scaleX = Math.max(0.68, Math.min(1.35, targetScaleX));
        stretch.scaleY = Math.max(0.68, Math.min(1.35, targetScaleY));
        stretch.scaleVelX = 0;
        stretch.scaleVelY = 0;

        mesh.scale.set(stretch.scaleX, stretch.scaleY, 1.0);
      } else {
        if (stretch.isStretching) {
          stretch.isStretching = false;
        }

        // Return to 1.0 rest scale over time using custom material elastic spring values
        const scaleStiffness = (actConfig.stiffness || 240.0) * 0.05;
        const scaleDamping = (actConfig.damping || 9.0) * 0.15;

        const forceX = -scaleStiffness * (mesh.scale.x - 1.0) - scaleDamping * stretch.scaleVelX;
        const forceY = -scaleStiffness * (mesh.scale.y - 1.0) - scaleDamping * stretch.scaleVelY;

        stretch.scaleVelX += forceX * dt;
        stretch.scaleVelY += forceY * dt;

        mesh.scale.x += stretch.scaleVelX * dt;
        mesh.scale.y += stretch.scaleVelY * dt;

        if (Math.abs(mesh.scale.x - 1.0) < 0.001 && Math.abs(stretch.scaleVelX) < 0.01) {
          mesh.scale.x = 1.0;
          stretch.scaleVelX = 0;
        }
        if (Math.abs(mesh.scale.y - 1.0) < 0.001 && Math.abs(stretch.scaleVelY) < 0.01) {
          mesh.scale.y = 1.0;
          stretch.scaleVelY = 0;
        }
      }

      // Update nodes' hVal from heightmapCanvas dynamically to synchronize 3D tactile indentations and peripheral bulge ridges!
      const hCanvas = heightmapCanvasRef.current;
      if (hCanvas) {
        const hCtx = hCanvas.getContext('2d');
        if (hCtx) {
          const hDataArray = hCtx.getImageData(0, 0, 512, 512).data;
          for (let i = 0; i < totalVertices; i++) {
            const node = nodes[i];
            const tx = Math.max(0, Math.min(511, Math.floor(node.ou * 512)));
            const ty = Math.max(0, Math.min(511, Math.floor((1.0 - node.ov) * 512)));
            node.hVal = hDataArray[(ty * 512 + tx) * 4] / 255.0;
          }
        }
      }

      // Live adjust of inflation rest positions dynamically
      for (let i = 0; i < totalVertices; i++) {
        const node = nodes[i];
        node.oz = node.hVal * actConfig.puffiness * 0.95;
      }

      const cols = GRID_SIZE + 1;
      const rows = GRID_SIZE + 1;

      // In Slime Mode, rest home anchors drift plastically towards current coordinates
      if (isSlime) {
        const plasticityVal = actConfig.plasticity !== undefined ? actConfig.plasticity : 0.2;
        const driftSpeed = (grab.active || activeHand.active) ? (plasticityVal * 1.5) : (plasticityVal * 0.4);
        for (let i = 0; i < totalVertices; i++) {
          const node = nodes[i];
          const col = i % cols;
          const row = Math.floor(i / cols);
          const distToEdge = Math.min(row, GRID_SIZE - row, col, GRID_SIZE - col);
          const edgeWeight = distToEdge <= 0 ? 0.0 : (distToEdge >= 4 ? 1.0 : distToEdge / 4.0);

          // Plastic deformation drift
          const driftAmount = driftSpeed * edgeWeight;
          node.ox += (node.x - node.ox) * driftAmount;
          node.oy += (node.y - node.oy) * driftAmount;

          // Viscoelastic soft return force brings shape back smoothly to its unmutilated size, preventing permanent shrinkage!
          const returnSpringRateBase = (grab.active || activeHand.active) ? 0.0035 : 0.016;
          const returnSpringRate = (1.0 - plasticityVal) * returnSpringRateBase;
          node.ox += (node.ox_orig - node.ox) * returnSpringRate * edgeWeight;
          node.oy += (node.oy_orig - node.oy) * returnSpringRate * edgeWeight;
        }

        // Mass / Volume Conservation (Radial Bulge):
        // When active forces squeeze the core interior, push the outer ring outward radially to maintain slime volume.
        // (Sticker mode only to preserve its target logic)
        if (!isSlime && activeAnchors.length > 0) {
          activeAnchors.forEach(anchor => {
            const R_influence = 0.70;
            let totalInwardShift = 0;
            let outerCount = 0;

            // 1. Calculate inward compression amount in core zone
            for (let i = 0; i < totalVertices; i++) {
              const node = nodes[i];
              const dx = node.x - anchor.x;
              const dy = node.y - anchor.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < 0.45 * R_influence) {
                const homeDx = node.ox_orig - anchor.x;
                const homeDy = node.oy_orig - anchor.y;
                const homeDist = Math.sqrt(homeDx * homeDx + homeDy * homeDy);
                const inwardDelta = homeDist - dist;
                if (inwardDelta > 0) {
                  totalInwardShift += inwardDelta;
                }
              } else if (dist >= 0.45 * R_influence && dist < 1.25 * R_influence) {
                outerCount++;
              }
            }

            // 2. Distribute volume outwards radially along the edge of the influence radius
            if (totalInwardShift > 0 && outerCount > 0) {
              const pushStrength = (totalInwardShift / outerCount) * 1.55;
              for (let i = 0; i < totalVertices; i++) {
                const node = nodes[i];
                const dx = node.x - anchor.x;
                const dy = node.y - anchor.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist >= 0.45 * R_influence && dist < 1.25 * R_influence && dist > 0.001) {
                  const rx = dx / dist;
                  const ry = dy / dist;

                  const col = i % cols;
                  const row = Math.floor(i / cols);
                  const distToEdge = Math.min(row, GRID_SIZE - row, col, GRID_SIZE - col);
                  const edgeWeight = distToEdge <= 0 ? 0.0 : (distToEdge >= 4 ? 1.0 : distToEdge / 4.0);

                  const bulgeShape = Math.sin(((dist - 0.45 * R_influence) / (0.8 * R_influence)) * Math.PI);
                  const pushDist = pushStrength * bulgeShape * edgeWeight;

                  // Apply outward shift to both the rest anchor and simulated coordinate
                  node.ox += rx * pushDist;
                  node.oy += ry * pushDist;
                  node.x += rx * pushDist;
                  node.y += ry * pushDist;
                }
              }
            }
          });
        }

        // Seamless CPU paint smudging and mixing
        if (isSlime) {
          if (activeFingers.length > 0) {
            const dCtx = diffuseCanvasRef.current?.getContext('2d');
            if (dCtx) {
              let updated = false;
              const scaleFactor = actConfig.imageScale !== undefined ? actConfig.imageScale : 1.0;
              const paintRadius = Math.max(4, 21 / scaleFactor);

              activeFingers.forEach(finger => {
                const cx = ((finger.x + 1.5) / 3.0) * 512;
                const cy = (1.0 - (finger.y + 1.5) / 3.0) * 512;

                let lastCx = cx;
                let lastCy = cy;
                const prev = prevFingerPositionsRef.current[finger.id];
                if (prev) {
                  lastCx = ((prev.x + 1.5) / 3.0) * 512;
                   lastCy = (1.0 - (prev.y + 1.5) / 3.0) * 512;
                }

                if (Math.abs(cx - lastCx) > 0.1 || Math.abs(cy - lastCy) > 0.1) {
                  // Run nice organic smear with a slightly smaller contact radius (30) for distinct finger ridges
                  mixColors(dCtx, cx, cy, lastCx, lastCy, paintRadius, heightmapCanvasRef.current, originalPurePixelsRef.current, actConfig);
                  updated = true;
                }
              });

              if (updated) {
                if (diffuseTexRef.current) {
                  diffuseTexRef.current.needsUpdate = true;
                }
                if (heightmapTexRef.current) {
                  heightmapTexRef.current.needsUpdate = true;
                }
              }
            }
          }
        } else {
          // Seamless CPU paint smudging (Mouse)
          if (grab.active) {
            const dCtx = diffuseCanvasRef.current?.getContext('2d');
            if (dCtx) {
              const cx = ((grab.currentX + 1.5) / 3.0) * 512;
              const cy = (1.0 - (grab.currentY + 1.5) / 3.0) * 512;
              
              let lastCx = cx;
              let lastCy = cy;
              if (grab.lastX !== undefined && grab.lastY !== undefined) {
                lastCx = ((grab.lastX + 1.5) / 3.0) * 512;
                lastCy = (1.0 - (grab.lastY + 1.5) / 3.0) * 512;
              }

              if (Math.abs(cx - lastCx) > 0.1 || Math.abs(cy - lastCy) > 0.1) {
                mixColors(dCtx, cx, cy, lastCx, lastCy, 45, heightmapCanvasRef.current, originalPurePixelsRef.current, actConfig);
                if (diffuseTexRef.current) {
                  diffuseTexRef.current.needsUpdate = true;
                }
                if (heightmapTexRef.current) {
                  heightmapTexRef.current.needsUpdate = true;
                }
              }
            }
          }

          // Seamless CPU paint smudging (Hand Pinch)
          if (activeHand.active) {
            const hands = activeHand.hands || [];
            let pinchH = activeHand.pinch > 0.6 ? activeHand : null;
            if (hands.length > 0) {
              const firstPinch = hands.find(h => h.pinch > 0.6);
              if (firstPinch) pinchH = { ...activeHand, x: firstPinch.x * 1.5, y: firstPinch.y * 1.5 };
            }

            if (pinchH) {
              const dCtx = diffuseCanvasRef.current?.getContext('2d');
              if (dCtx) {
                const hx = pinchH.x;
                const hy = pinchH.y;
                const cx = ((hx + 1.5) / 3.0) * 512;
                const cy = (1.0 - (hy + 1.5) / 3.0) * 512;

                let lastCx = cx;
                let lastCy = cy;
                if (lastHandPosRef.current.active) {
                  lastCx = ((lastHandPosRef.current.x + 1.5) / 3.0) * 512;
                  lastCy = (1.0 - (lastHandPosRef.current.y + 1.5) / 3.0) * 512;
                }

                if (Math.abs(cx - lastCx) > 0.15 || Math.abs(cy - lastCy) > 0.15) {
                  mixColors(dCtx, cx, cy, lastCx, lastCy, 45, heightmapCanvasRef.current, originalPurePixelsRef.current, actConfig);
                  if (diffuseTexRef.current) {
                    diffuseTexRef.current.needsUpdate = true;
                  }
                  if (heightmapTexRef.current) {
                    heightmapTexRef.current.needsUpdate = true;
                  }
                }

                lastHandPosRef.current = { x: hx, y: hy, active: true };
              }
            } else {
              lastHandPosRef.current.active = false;
            }
          } else {
            lastHandPosRef.current.active = false;
          }
        }
      } else {
        lastHandPosRef.current.active = false;
      }

      // Perform spring relaxations and integrations

      // =========================================================================
      // DEDICATED SLIME MODE & STICKER PHYSICS EXECUTION PIPELINE
      // =========================================================================
      if (isSlime) {
        // --- SLIME MODE: HIGH-DENSITY RADIAL SOFT-BODY ODE ENGINE ---
        const scaleFactor = actConfig.imageScale !== undefined ? actConfig.imageScale : 1.0;
        const touchRadius = 0.05 / scaleFactor;      // Soft contact patch radius
        const influenceRadius = 0.35 / scaleFactor;  // Core deformation radius
        const MAX_VELOCITY = 2.5;     // Fluid-dynamic velocity speed limit

        // 【第一步：力学积分更新】：遍历 16,641 质点，计算基础胡克弹簧力、阻尼力
        for (let i = 0; i < totalVertices; i++) {
          const node = nodes[i];
          const col = i % cols;
          const row = Math.floor(i / cols);

          // 1. Hooke's tracking spring force (elastic/plastic home attraction)
          const fHomeX = -stiffness * (node.x - node.ox);
          const fHomeY = -stiffness * (node.y - node.oy);
          const fHomeZ = -stiffness * (node.z - node.oz);

          // 2. Cohesion links with 4 neighbors (Laplacian core structural tension)
          let sumNeighborsX = 0; let sumNeighborsY = 0; let sumNeighborsZ = 0;
          let neighborCount = 0;

          if (col > 0) {
            const n = nodes[i - 1];
            sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
            neighborCount++;
          }
          if (col < GRID_SIZE) {
            const n = nodes[i + 1];
            sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
            neighborCount++;
          }
          if (row > 0) {
            const n = nodes[i - cols];
            sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
            neighborCount++;
          }
          if (row < GRID_SIZE) {
            const n = nodes[i + cols];
            sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
            neighborCount++;
          }

          let fCohesionX = 0; let fCohesionY = 0; let fCohesionZ = 0;
          if (neighborCount > 0) {
            fCohesionX = cohesion * ((sumNeighborsX / neighborCount) - node.x);
            fCohesionY = cohesion * ((sumNeighborsY / neighborCount) - node.y);
            fCohesionZ = cohesion * ((sumNeighborsZ / neighborCount) - node.z);
          }

          // 3. Basal damping friction (dynamically scaled within transitional squeeze zones)
          let localDamping = damping;

          if (isSlime && activeFingers.length > 0) {
            for (let f = 0; f < activeFingers.length; f++) {
              const finger = activeFingers[f];
              const dx = node.ox_orig - finger.x;
              const dy = node.oy_orig - finger.y;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > touchRadius && d < influenceRadius) {
                localDamping *= 2.0;
                break;
              }
            }
          } else {
            if (grab.active) {
              const dx = node.ox_orig - grab.currentX;
              const dy = node.oy_orig - grab.currentY;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > touchRadius && d < influenceRadius) {
                localDamping *= 2.0; // Double localized viscous friction in swell squeeze area
              }
            }
            if (activeHand.active && handPinchStartRef.current.active) {
              const handX = activeHand.x * 1.5;
              const handY = activeHand.y * 1.5;
              const dx = node.ox_orig - handX;
              const dy = node.oy_orig - handY;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d > touchRadius && d < influenceRadius) {
                localDamping *= 2.0;
              }
            }
          }

          const fDampingX = -localDamping * node.vx;
          const fDampingY = -localDamping * node.vy;
          const fDampingZ = -localDamping * node.vz;

          // Integrate Hookean ODE accelerations
          const ax = fHomeX + fCohesionX + fDampingX;
          const ay = fHomeY + fCohesionY + fDampingY;
          const az = fHomeZ + fCohesionZ + fDampingZ;

          node.vx += ax * dt;
          node.vy += ay * dt;
          node.vz += az * dt;
        }

        // 【第二步：软性接触面与速度钳制】：应用软接触面 Smoothstep 拖拽衰减并限制最高速度
        for (let i = 0; i < totalVertices; i++) {
          const node = nodes[i];
          const col = i % cols;
          const row = Math.floor(i / cols);
          const distToEdge = Math.min(row, GRID_SIZE - row, col, GRID_SIZE - col);
          const edgeWeight = distToEdge <= 0 ? 0.0 : (distToEdge >= 4 ? 1.0 : distToEdge / 4.0);

          let fDragX = 0; let fDragY = 0; let fDragZ = 0;

          // 1. Pointer (mouse/touch) interaction force calculations (Sticker Mode only, Slime Mode uses 5 simulated fingers)
          if (grab.active && !isSlime) {
            const dx = node.ox_orig - grab.currentX; // Absolute lock to original plane coordinate (prevents center spike!)
            const dy = node.oy_orig - grab.currentY;
            const d = Math.sqrt(dx * dx + dy * dy);

            // Real-time pointer velocity
            const lastX = grab.lastX !== undefined ? grab.lastX : grab.currentX;
            const lastY = grab.lastY !== undefined ? grab.lastY : grab.currentY;
            const dragVelX = (grab.currentX - lastX) / dt;
            const dragVelY = (grab.currentY - lastY) / dt;

            // 🚫 核心修复：基于顶点的只读原始未形变坐标 (node.ox_orig) 换算初始不变形的纹理索引，保证阻断绝不失效！
            // 空间跨度从 [-1.5, 1.5] 映射到 [0, 1] UV 空间
            const origUVX = (node.ox_orig + 1.5) / 3.0;
            const origUVY = (node.oy_orig + 1.5) / 3.0; // 基于 PlaneGeometry 居中对齐

            const tx = Math.max(0, Math.min(511, Math.floor(origUVX * 512)));
            const ty = Math.max(0, Math.min(511, Math.floor((1.0 - origUVY) * 512))); // 严格反转 Canvas Y 轴
            const snapshotIdx = (ty * 512 + tx) * 4;

            const isInterior = originalPurePixelsRef.current
              ? originalPurePixelsRef.current[snapshotIdx + 3] > 25
              : (node.originalAlpha !== undefined ? (node.originalAlpha * 255 > 25) : true);

            let force = 0.0;
            if (isInterior) {
              if (d <= touchRadius) {
                force = 1.0;
              } else if (d < influenceRadius) {
                const t = (d - touchRadius) / (influenceRadius - touchRadius);
                force = 1.0 - t * t * (3.0 - 2.0 * t); // Smoothstep S-curve transition
              }
            }

            if (force > 0.0) {
              const hasInteriorAlpha = (node.originalAlpha !== undefined ? node.originalAlpha : 1.0) > 0.1;
              if (hasInteriorAlpha) {
                if (isSlime) {
                  // Slime Mode Z compression: Flat table desk constraint inside core, soft bulging around
                  let targetZ = 0.0;
                  let stiffnessMultiplier = 240.0;
                  if (d <= touchRadius) {
                    targetZ = 0.0;
                    // Pulling stiffness is fully coupled to grab.pressEnergy
                    stiffnessMultiplier = 600.0 * grab.pressEnergy;
                  } else {
                    const bStrength = actConfig.bulgeStrength !== undefined ? actConfig.bulgeStrength : 0.35;
                    // Bulge height grows with press duration time
                    targetZ = bStrength * force * grab.pressEnergy;
                    stiffnessMultiplier = 240.0 * force;
                  }
                  fDragZ += stiffnessMultiplier * (targetZ - node.z);
                } else {
                  const bStrength = actConfig.bulgeStrength !== undefined ? actConfig.bulgeStrength : 0.35;
                  const targetZ = d <= touchRadius ? 0.0 : (bStrength * force);
                  fDragZ += 240.0 * force * (targetZ - node.z);
                }

                // Advection matching mouse dragging speeds
                const advection = 35.0 * force;
                fDragX += advection * dragVelX;
                fDragY += advection * dragVelY;

                const deltaX = grab.currentX - grab.clickX;
                const deltaY = grab.currentY - grab.clickY;

                // Tangential relaxation mapping (prevents folding / high-frequency wrinkles)
                const rx = d > 0.001 ? (dx / d) : 0.0;
                const ry = d > 0.001 ? (dy / d) : 0.0;
                const bulgeFactor = Math.sin(force * Math.PI); // Half-period sine wave for gentle slopes
                
                const bulgePushAmount = isSlime ? (0.12 * grab.pressEnergy) : 0.04;
                const bulgePush = bulgePushAmount * bulgeFactor;

                let wishX = node.ox_orig + deltaX * force + rx * bulgePush;
                let wishY = node.oy_orig + deltaY * force + ry * bulgePush;

                // 约束计算：手指圆弧硬投影 (Circular Cap Constraint) vs 边缘横向张力 (Edge Tension Relaxation)
                if (d <= touchRadius) {
                  const rx2 = d > 0.001 ? (dx / d) : 0.0;
                  const ry2 = d > 0.001 ? (dy / d) : 0.0;
                  wishX = grab.currentX + rx2 * touchRadius;
                  wishY = grab.currentY + ry2 * touchRadius;
                } else {
                  // check if close to edge
                  const isCloseToEdge = (() => {
                    if (node.originalAlpha !== undefined && node.originalAlpha < 0.75) return true;
                    if (col > 0 && nodes[i - 1].originalAlpha < 0.15) return true;
                    if (col < GRID_SIZE && nodes[i + 1].originalAlpha < 0.15) return true;
                    if (row > 0 && nodes[i - cols].originalAlpha < 0.15) return true;
                    if (row < GRID_SIZE && nodes[i + cols].originalAlpha < 0.15) return true;
                    return false;
                  })();

                  if (isCloseToEdge) {
                    let nCount = 0;
                    let nSumX = 0;
                    let nSumY = 0;
                    if (col > 0) {
                      nSumX += nodes[i - 1].x;
                      nSumY += nodes[i - 1].y;
                      nCount++;
                    }
                    if (col < GRID_SIZE) {
                      nSumX += nodes[i + 1].x;
                      nSumY += nodes[i + 1].y;
                      nCount++;
                    }
                    if (nCount > 0) {
                      const avgNeighborX = nSumX / nCount;
                      const avgNeighborY = nSumY / nCount;
                      wishX = wishX * 0.65 + avgNeighborX * 0.35;
                      wishY = wishY * 0.65 + avgNeighborY * 0.35;
                    }
                  }
                }

                // Localized Strain Limiter constraint (restricts maximum stretch away from rest positions)
                const strainMult = actConfig.maxStrainDistMultiplier !== undefined ? actConfig.maxStrainDistMultiplier : 2.5;
                const maxDist = touchRadius * strainMult;
                const offsetX = wishX - node.ox_orig;
                const offsetY = wishY - node.oy_orig;
                const offsetLen = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
                if (offsetLen > maxDist) {
                  wishX = node.ox_orig + (offsetX / offsetLen) * maxDist;
                  wishY = node.oy_orig + (offsetY / offsetLen) * maxDist;
                }

                fDragX += 180.0 * force * (wishX - node.x);
                fDragY += 180.0 * force * (wishY - node.y);
              }
            }
          }

          // 2. Hand tracking finger tips & pinch interaction
          if (activeHand.active || (grab.active && isSlime)) {
            if (isSlime) {
              // Iterate through ALL active fingers doing multi-finger kneading
              activeFingers.forEach(finger => {
                const dx = node.ox_orig - finger.x;
                const dy = node.oy_orig - finger.y;
                const d = Math.sqrt(dx * dx + dy * dy);

                // 🚫 核心修复：基于顶点的只读原始未形变坐标 (node.ox_orig) 换算初始不变形的纹理索引，保证阻断绝不失效！
                // 空间跨度从 [-1.5, 1.5] 映射到 [0, 1] UV 空间
                const origUVX = (node.ox_orig + 1.5) / 3.0;
                const origUVY = (node.oy_orig + 1.5) / 3.0; // 基于 PlaneGeometry 居中对齐

                const tx = Math.max(0, Math.min(511, Math.floor(origUVX * 512)));
                const ty = Math.max(0, Math.min(511, Math.floor((1.0 - origUVY) * 512))); // 严格反转 Canvas Y 轴
                const snapshotIdx = (ty * 512 + tx) * 4;

                const isInterior = originalPurePixelsRef.current
                  ? originalPurePixelsRef.current[snapshotIdx + 3] > 25
                  : (node.originalAlpha !== undefined ? (node.originalAlpha * 255 > 25) : true);

                let force = 0.0;
                if (isInterior) {
                  if (d <= touchRadius) {
                    force = 1.0;
                  } else if (d < influenceRadius) {
                    const t = (d - touchRadius) / (influenceRadius - touchRadius);
                    force = 1.0 - t * t * (3.0 - 2.0 * t);
                  }
                }

                if (force > 0.0) {
                  const hasInteriorAlpha = (node.originalAlpha !== undefined ? node.originalAlpha : 1.0) > 0.1;
                  if (hasInteriorAlpha) {
                    // Slime Mode Z compression: Finger tips compress and bulge
                    let targetZ = 0.0;
                    let stiffnessMultiplier = 240.0;
                    if (d <= touchRadius) {
                      targetZ = 0.0;
                      stiffnessMultiplier = 600.0;
                    } else {
                      const bStrength = actConfig.bulgeStrength !== undefined ? actConfig.bulgeStrength : 0.35;
                      targetZ = bStrength * force;
                      stiffnessMultiplier = 240.0 * force;
                    }
                    fDragZ += stiffnessMultiplier * (targetZ - node.z);

                    // Advection matching finger dragging speeds
                    const advection = 35.0 * force;
                    fDragX += advection * finger.velX;
                    fDragY += advection * finger.velY;

                    // Tangential relaxation mapping (prevents folding / high-frequency wrinkles)
                    const rx = d > 0.001 ? (dx / d) : 0.0;
                    const ry = d > 0.001 ? (dy / d) : 0.0;
                    const bulgeFactor = Math.sin(force * Math.PI); // Half-period sine wave for gentle slopes
                    
                    const bulgePush = 0.12 * bulgeFactor;

                    // Fingers drag the nodes around them
                    const deltaX = finger.x - finger.prevX;
                    const deltaY = finger.y - finger.prevY;
                    let wishX = node.x + deltaX * force + rx * bulgePush * 0.1;
                    let wishY = node.y + deltaY * force + ry * bulgePush * 0.1;

                    // 约束计算：手指圆弧硬投影 (Circular Cap Constraint) vs 边缘横向张力 (Edge Tension Relaxation)
                    if (d <= touchRadius) {
                      const rx2 = d > 0.001 ? (dx / d) : 0.0;
                      const ry2 = d > 0.001 ? (dy / d) : 0.0;
                      wishX = finger.x + rx2 * touchRadius;
                      wishY = finger.y + ry2 * touchRadius;
                    } else {
                      // check if close to edge
                      const isCloseToEdge = (() => {
                        if (node.originalAlpha !== undefined && node.originalAlpha < 0.75) return true;
                        if (col > 0 && nodes[i - 1].originalAlpha < 0.15) return true;
                        if (col < GRID_SIZE && nodes[i + 1].originalAlpha < 0.15) return true;
                        if (row > 0 && nodes[i - cols].originalAlpha < 0.15) return true;
                        if (row < GRID_SIZE && nodes[i + cols].originalAlpha < 0.15) return true;
                        return false;
                      })();

                      if (isCloseToEdge) {
                        let nCount = 0;
                        let nSumX = 0;
                        let nSumY = 0;
                        if (col > 0) {
                          nSumX += nodes[i - 1].x;
                          nSumY += nodes[i - 1].y;
                          nCount++;
                        }
                        if (col < GRID_SIZE) {
                          nSumX += nodes[i + 1].x;
                          nSumY += nodes[i + 1].y;
                          nCount++;
                        }
                        if (nCount > 0) {
                          const avgNeighborX = nSumX / nCount;
                          const avgNeighborY = nSumY / nCount;
                          wishX = wishX * 0.65 + avgNeighborX * 0.35;
                          wishY = wishY * 0.65 + avgNeighborY * 0.35;
                        }
                      }
                    }

                    // Localized Strain Limiter constraint (restricts maximum stretch away from rest positions)
                    const strainMult = actConfig.maxStrainDistMultiplier !== undefined ? actConfig.maxStrainDistMultiplier : 2.5;
                    const maxDist = touchRadius * strainMult;
                    const offsetX = wishX - node.ox_orig;
                    const offsetY = wishY - node.oy_orig;
                    const offsetLen = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
                    if (offsetLen > maxDist) {
                      wishX = node.ox_orig + (offsetX / offsetLen) * maxDist;
                      wishY = node.oy_orig + (offsetY / offsetLen) * maxDist;
                    }

                    fDragX += 180.0 * force * (wishX - node.x);
                    fDragY += 180.0 * force * (wishY - node.y);
                  }
                }
              });
            } else {
              // STICKER MODE: Use original single pinch tracking logic
              if (handPinchStartRef.current.active) {
                const handX = activeHand.x * 1.5;
                const handY = activeHand.y * 1.5;
                const lastHandX = prevHandPosRef.current.x;
                const lastHandY = prevHandPosRef.current.y;

                const handVelX = (handX - lastHandX) / dt;
                const handVelY = (handY - lastHandY) / dt;

                const dx = node.ox_orig - handX;
                const dy = node.oy_orig - handY;
                const d = Math.sqrt(dx * dx + dy * dy);

                let force = 0.0;
                if (d <= touchRadius) {
                  force = 1.0;
                } else if (d < influenceRadius) {
                  const t = (d - touchRadius) / (influenceRadius - touchRadius);
                  force = 1.0 - t * t * (3.0 - 2.0 * t);
                }

                if (force > 0.0) {
                  const hasInteriorAlpha = (node.originalAlpha !== undefined ? node.originalAlpha : 1.0) > 0.1;
                  if (hasInteriorAlpha) {
                    const bStrength = actConfig.bulgeStrength !== undefined ? actConfig.bulgeStrength : 0.35;
                    const targetZ = d <= touchRadius ? 0.0 : (bStrength * force);
                    fDragZ += 240.0 * force * (targetZ - node.z);

                    const advection = 35.0 * force;
                    fDragX += advection * handVelX;
                    fDragY += advection * handVelY;

                    const handDeltaX = handX - handPinchStartRef.current.x;
                    const handDeltaY = handY - handPinchStartRef.current.y;

                    const rx = d > 0.001 ? (dx / d) : 0.0;
                    const ry = d > 0.001 ? (dy / d) : 0.0;
                    const bulgeFactor = Math.sin(force * Math.PI);

                    const bulgePushAmount = 0.04;
                    const bulgePush = bulgePushAmount * bulgeFactor;

                    let wishX = node.ox_orig + handDeltaX * force + rx * bulgePush;
                    let wishY = node.oy_orig + handDeltaY * force + ry * bulgePush;

                    // Strain Limiter constraint
                    const strainMult = actConfig.maxStrainDistMultiplier !== undefined ? actConfig.maxStrainDistMultiplier : 2.5;
                    const maxDist = touchRadius * strainMult;
                    const offsetX = wishX - node.ox_orig;
                    const offsetY = wishY - node.oy_orig;
                    const offsetLen = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
                    if (offsetLen > maxDist) {
                      wishX = node.ox_orig + (offsetX / offsetLen) * maxDist;
                      wishY = node.oy_orig + (offsetY / offsetLen) * maxDist;
                    }

                    fDragX += 180.0 * force * (wishX - node.x);
                    fDragY += 180.0 * force * (wishY - node.y);
                  }
                }
              }
            }
          }

          // Apply soft dragging forces to velocities
          node.vx += fDragX * dt;
          node.vy += fDragY * dt;
          node.vz += fDragZ * dt;

          // STRICT SPEED LIMITER (Prevents velocity overshoots and sharp redially spikes)
          const velLength = Math.sqrt(node.vx * node.vx + node.vy * node.vy + node.vz * node.vz);
          if (velLength > MAX_VELOCITY) {
            const scale = MAX_VELOCITY / velLength;
            node.vx *= scale;
            node.vy *= scale;
            node.vz *= scale;
          }

          // Anchor spatial constraints close to active borders
          node.vx *= edgeWeight;
          node.vy *= edgeWeight;
          node.vz *= edgeWeight;

          node.x += node.vx * dt;
          node.y += node.vy * dt;
          node.z += node.vz * dt;

          if (edgeWeight < 1.0) {
            node.x = node.ox + (node.x - node.ox) * edgeWeight;
            node.y = node.oy + (node.y - node.oy) * edgeWeight;
            node.z = node.oz * edgeWeight + (node.z - node.oz * edgeWeight) * edgeWeight;
          }
        }

        // 【第三步：最终拉普拉斯平滑（防线）】：力学与速度积分完成后，执行两遍高阶平滑抹平突变
        const laplacianAlpha = 0.28; // slightly increased to provide ultimate roundness
        const passes = 2;            // two-pass high-frequency noise removal

        for (let pass = 0; pass < passes; pass++) {
          const tempX = new Float32Array(totalVertices);
          const tempY = new Float32Array(totalVertices);
          const tempZ = new Float32Array(totalVertices);

          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const idx = r * cols + c;
              const node = nodes[idx];

              let sumX = 0, sumY = 0, sumZ = 0;
              let count = 0;

              if (c > 0) {
                const left = nodes[idx - 1];
                sumX += left.x; sumY += left.y; sumZ += left.z; count++;
              }
              if (c < GRID_SIZE) {
                const right = nodes[idx + 1];
                sumX += right.x; sumY += right.y; sumZ += right.z; count++;
              }
              if (r > 0) {
                const up = nodes[idx - cols];
                sumX += up.x; sumY += up.y; sumZ += up.z; count++;
              }
              if (r < GRID_SIZE) {
                const down = nodes[idx + cols];
                sumX += down.x; sumY += down.y; sumZ += down.z; count++;
              }

              if (count > 0) {
                tempX[idx] = node.x + laplacianAlpha * (sumX / count - node.x);
                tempY[idx] = node.y + laplacianAlpha * (sumY / count - node.y);
                tempZ[idx] = node.z + laplacianAlpha * (sumZ / count - node.z);
              } else {
                tempX[idx] = node.x;
                tempY[idx] = node.y;
                tempZ[idx] = node.z;
              }
            }
          }

          // Apply smoothed layout to coordinates
          for (let i = 0; i < totalVertices; i++) {
            const node = nodes[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            const distToEdge = Math.min(row, GRID_SIZE - row, col, GRID_SIZE - col);
            const edgeWeight = distToEdge <= 0 ? 0.0 : (distToEdge >= 4 ? 1.0 : distToEdge / 4.0);

            node.x = node.x * (1.0 - edgeWeight) + tempX[i] * edgeWeight;
            node.y = node.y * (1.0 - edgeWeight) + tempY[i] * edgeWeight;
            node.z = node.z * (1.0 - edgeWeight) + tempZ[i] * edgeWeight;
          }
        }
      } else {
        // --- STICKER MODE: ORIGINAL PHYSICAL SPRING INTEGRATION LOGIC (EXACT PRESERVATION) ---
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            const node = nodes[idx];

            let fHomeX = -stiffness * (node.x - node.ox);
            let fHomeY = -stiffness * (node.y - node.oy);
            let fHomeZ = -stiffness * (node.z - node.oz);

            let sumNeighborsX = 0; let sumNeighborsY = 0; let sumNeighborsZ = 0;
            let neighborCount = 0;

            if (c > 0) {
              const n = nodes[idx - 1];
              sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
              neighborCount++;
            }
            if (c < GRID_SIZE) {
              const n = nodes[idx + 1];
              sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
              neighborCount++;
            }
            if (r > 0) {
              const n = nodes[idx - cols];
              sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
              neighborCount++;
            }
            if (r < GRID_SIZE) {
              const n = nodes[idx + cols];
              sumNeighborsX += n.x; sumNeighborsY += n.y; sumNeighborsZ += n.z;
              neighborCount++;
            }

            let fCohesionX = 0; let fCohesionY = 0; let fCohesionZ = 0;
            if (neighborCount > 0) {
              fCohesionX = cohesion * ((sumNeighborsX / neighborCount) - node.x);
              fCohesionY = cohesion * ((sumNeighborsY / neighborCount) - node.y);
              fCohesionZ = cohesion * ((sumNeighborsZ / neighborCount) - node.z);
            }

            const distToEdge = Math.min(r, GRID_SIZE - r, c, GRID_SIZE - c);
            const edgeWeight = distToEdge <= 0 ? 0.0 : (distToEdge >= 4 ? 1.0 : distToEdge / 4.0);

            let fDragX = 0; let fDragY = 0; let fDragZ = 0;

            if (activeAnchors.length > 0) {
              activeAnchors.forEach(anchor => {
                const dx = node.ox - anchor.x;
                const dy = node.oy - anchor.y;
                const distSq = dx * dx + dy * dy;

                const influenceRadius = 0.75;
                const influence = Math.exp(-distSq / (2.0 * influenceRadius * influenceRadius));

                const dragModifier = 145.0 * influence * edgeWeight;
                fDragX += dragModifier * (anchor.x - node.x);
                fDragY += dragModifier * (anchor.y - node.y);
                fDragZ += dragModifier * (anchor.z - node.z);
              });
            }

            const fDampingX = -damping * node.vx;
            const fDampingY = -damping * node.vy;
            const fDampingZ = -damping * node.vz;

            const ax = fHomeX + fCohesionX + fDragX + fDampingX;
            const ay = fHomeY + fCohesionY + fDragY + fDampingY;
            const az = fHomeZ + fCohesionZ + fDragZ + fDampingZ;

            node.vx += ax * dt;
            node.vy += ay * dt;
            node.vz += az * dt;

            node.vx *= edgeWeight;
            node.vy *= edgeWeight;
            node.vz *= edgeWeight;

            node.x += node.vx * dt;
            node.y += node.vy * dt;
            node.z += node.vz * dt;

            if (edgeWeight < 1.0) {
              node.x = node.ox + (node.x - node.ox) * edgeWeight;
              node.y = node.oy + (node.y - node.oy) * edgeWeight;
              node.z = node.oz * edgeWeight + (node.z - node.oz * edgeWeight) * edgeWeight;
            }
          }
        }
      }

      // Copy positions to the GPU geometry buffer. 
      // By keeping the vertex UV attributes constant at their static rest coordinates,
      // the texture pattern remains naturally attached to the mesh, compressing and scaling
      // proportionally during deformation for a flawless, unified "squishy toy" effect!
      const positionAttr = geometry.attributes.position;
      for (let i = 0; i < totalVertices; i++) {
        const node = nodes[i];
        positionAttr.setXYZ(i, node.x, node.y, node.z);
      }
      positionAttr.needsUpdate = true;
      geometry.computeVertexNormals();

      // Subtle breath rotation
      if (actConfig.autorotate) {
        mesh.rotation.y = Math.sin(clock.getElapsedTime() * 0.45) * 0.15;
        mesh.rotation.x = Math.cos(clock.getElapsedTime() * 0.3) * 0.1;
      } else {
        mesh.rotation.y = THREE.MathUtils.lerp(mesh.rotation.y, (mousePosRef.current.x * 0.25), 0.05);
        mesh.rotation.x = THREE.MathUtils.lerp(mesh.rotation.x, -(mousePosRef.current.y * 0.25), 0.05);
      }

      // Live procedural Slime audio feedback synthesis mapped to mouse/finger speed and stiffness
      let maxDragSpeed = 0.0;
      if (isSlime) {
        if (activeFingers && activeFingers.length > 0) {
          activeFingers.forEach(finger => {
            const vx = finger.velX || 0;
            const vy = finger.velY || 0;
            const speed = Math.sqrt(vx * vx + vy * vy);
            if (speed > maxDragSpeed) {
              maxDragSpeed = speed;
            }
          });
        } else if (grab.active && grab.lastX !== undefined && grab.lastY !== undefined) {
          const dx = grab.currentX - grab.lastX;
          const dy = grab.currentY - grab.lastY;
          maxDragSpeed = Math.sqrt(dx * dx + dy * dy) / 0.016;
        }
      }

      const soundEnabled = isSlime && (actConfig.soundEnabled !== false);
      SlimeAudio.update(maxDragSpeed, stiffness, undefined, soundEnabled);

      renderer.render(scene, camera);

      // Render floating hand bones/skeletons directly on top of the main home screen/viewport
      const overlayCanvas = overlayCanvasRef.current;
      if (overlayCanvas) {
        const width = renderer.domElement.clientWidth;
        const height = renderer.domElement.clientHeight;
        if (overlayCanvas.width !== width || overlayCanvas.height !== height) {
          overlayCanvas.width = width;
          overlayCanvas.height = height;
        }

        const oCtx = overlayCanvas.getContext('2d');
        if (oCtx) {
          oCtx.clearRect(0, 0, width, height);

          // Get active hand details
          const hData = handDataRef.current;
          if (hData && hData.active && hData.isWebcam === true) {
            const drawSingleHandSkeleton = (hand: any) => {
              if (!hand.skeletonPoints || hand.skeletonPoints.length === 0) return;
              
              const pts = hand.skeletonPoints.map((p: any) => ({
                x: p.x * width,
                y: p.y * height
              }));

              if (isSlime) {
                // SLIME MODE: Draw only a thin black line circle and tiny dot on each of the 5 finger tips (index 4, 8, 12, 16, 20)
                const tips = [4, 8, 12, 16, 20];
                tips.forEach(idx => {
                  const pt = pts[idx];
                  if (pt) {
                    oCtx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
                    oCtx.lineWidth = 1.0;
                    oCtx.beginPath();
                    oCtx.arc(pt.x, pt.y, 11, 0, 2 * Math.PI);
                    oCtx.stroke();

                    oCtx.fillStyle = 'rgba(0, 0, 0, 0.85)';
                    oCtx.beginPath();
                    oCtx.arc(pt.x, pt.y, 2, 0, 2 * Math.PI);
                    oCtx.fill();
                  }
                });
              } else {
                // STICKER MODE: Always draw all 5 fingers connections and joints so they are fully displayed,
                // and if pinching, overlay a sleek pinch circle at the contact point.
                const FULL_CONNECTIONS = [
                  [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
                  [0, 5], [5, 6], [6, 7], [7, 8], // Index
                  [0, 9], [9, 10], [10, 11], [11, 12], // Middle
                  [0, 13], [13, 14], [14, 15], [15, 16], // Ring
                  [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
                  [5, 9], [9, 13], [13, 17] // palm bridge
                ];

                oCtx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
                oCtx.lineWidth = 1.25;
                oCtx.lineCap = 'round';
                oCtx.lineJoin = 'round';

                FULL_CONNECTIONS.forEach(([p1, p2]) => {
                  if (pts[p1] && pts[p2]) {
                    oCtx.beginPath();
                    oCtx.moveTo(pts[p1].x, pts[p1].y);
                    oCtx.lineTo(pts[p2].x, pts[p2].y);
                    oCtx.stroke();
                  }
                });

                // Draw joint dots for all 21 points
                for (let idx = 0; idx < pts.length; idx++) {
                  const pt = pts[idx];
                  if (!pt) continue;
                  const isTip = idx === 4 || idx === 8 || idx === 12 || idx === 16 || idx === 20;

                  oCtx.fillStyle = isTip ? 'rgba(0, 0, 0, 0.75)' : 'rgba(0, 0, 0, 0.35)';
                  oCtx.beginPath();
                  oCtx.arc(pt.x, pt.y, isTip ? 3.5 : 2.0, 0, 2 * Math.PI);
                  oCtx.fill();
                }

                const isPinching = hand.pinch > 0.55;
                if (isPinching) {
                  // When pinching: display a fine, sleek circle and dot between the thumb and index finger tip on top of the skeleton.
                  const tTip = pts[4];
                  const iTip = pts[8];
                  if (tTip && iTip) {
                    const cx = (tTip.x + iTip.x) / 2;
                    const cy = (tTip.y + iTip.y) / 2;

                    oCtx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
                    oCtx.lineWidth = 1.0;
                    oCtx.beginPath();
                    oCtx.arc(cx, cy, 14, 0, 2 * Math.PI);
                    oCtx.stroke();

                    oCtx.fillStyle = '#000000';
                    oCtx.beginPath();
                    oCtx.arc(cx, cy, 3, 0, 2 * Math.PI);
                    oCtx.fill();
                  }
                }
              }
            };

            const handsList = hData.hands || [];
            if (handsList.length > 0) {
              handsList.forEach(h => drawSingleHandSkeleton(h));
            } else {
              drawSingleHandSkeleton(hData);
            }
          }
        }
      }

      if (activeHand && activeHand.active) {
        prevHandPosRef.current = { x: activeHand.x * 1.5, y: activeHand.y * 1.5 };
      }
    };

    solvePhysicsAndRender();

    // ResizeObserver handler
    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0 || !currentContainer) return;
      const { width: newWidth, height: newHeight } = entries[0].contentRect;
      requestAnimationFrame(() => {
        if (!currentContainer) return;
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(newWidth, newHeight);
      });
    });
    resizeObserver.observe(currentContainer);

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver.disconnect();
      SlimeAudio.update(0, 0, 'jelly', false);
      if (currentContainer && renderer.domElement) {
        try {
          currentContainer.removeChild(renderer.domElement);
        } catch (e) {}
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, [heightmapUrl, diffuseUrl]);

  // Restores the slime visual paint layers & underlying physical mesh to absolute 100% flat rest state
  const resetSlimeToRest = () => {
    // 1. Re-paint the pure, un-smeared original diffuse canvas texture layers
    if (imgDRef.current && diffuseCanvasRef.current) {
      const dCtx = diffuseCanvasRef.current.getContext('2d');
      if (dCtx) {
        dCtx.clearRect(0, 0, 512, 512);
        dCtx.drawImage(imgDRef.current, 0, 0);
        if (diffuseTexRef.current) {
          diffuseTexRef.current.needsUpdate = true;
        }
      }
    }

    // 2. Clear out plastic deformation drifts from the physical ODE grid
    const nodes = physicsNodesRef.current;
    if (nodes && nodes.length > 0) {
      nodes.forEach(node => {
        node.ox = node.ox_orig;
        node.oy = node.oy_orig;
        node.oz = node.oz_orig;

        node.x = node.ox_orig;
        node.y = node.oy_orig;
        node.z = node.oz_orig;

        node.vx = 0;
        node.vy = 0;
        node.vz = 0;
      });

      // Instantly refresh the GPU vertex positions buffer
      if (geometryRef.current) {
        const positionAttr = geometryRef.current.attributes.position;
        for (let i = 0; i < nodes.length; i++) {
          positionAttr.setXYZ(i, nodes[i].ox_orig, nodes[i].oy_orig, nodes[i].oz_orig);
        }
        positionAttr.needsUpdate = true;
        geometryRef.current.computeVertexNormals();
      }
    }
  };

  // Pointer event handlers guiding backup mouse interaction
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    SlimeAudio.resume();
    if (!containerRef.current || !cameraRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xIdx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const yIdx = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    // Set dragging tracker on reference plane
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(xIdx, yIdx), cameraRef.current);
    
    const dragTarget = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, dragTarget);

    grabStateRef.current = {
      active: true,
      clickX: dragTarget.x,
      clickY: dragTarget.y,
      currentX: dragTarget.x,
      currentY: dragTarget.y,
      lastX: dragTarget.x,
      lastY: dragTarget.y,
      u: 0.5,
      v: 0.5,
      pressEnergy: 0.0
    };

    // Drag Anchor Locking: Freeze vertex-relative spatial weights instantaneously at click center (Slime Mode only)
    if (configRef.current.interactionMode === 'slime') {
      const nodes = physicsNodesRef.current;
      if (nodes && nodes.length > 0) {
        const influenceRadius = 0.75;
        nodes.forEach(node => {
          const dx = node.ox_orig - dragTarget.x;
          const dy = node.oy_orig - dragTarget.y;
          const distSq = dx * dx + dy * dy;
          node.grabInfluence = Math.exp(-distSq / (2.0 * influenceRadius * influenceRadius));
        });
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current || !cameraRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const xIdx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const yIdx = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    mousePosRef.current = { x: xIdx, y: yIdx };

    if (grabStateRef.current.active) {
      const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(new THREE.Vector2(xIdx, yIdx), cameraRef.current);
      
      const dragTarget = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, dragTarget);

      grabStateRef.current.lastX = grabStateRef.current.currentX;
      grabStateRef.current.lastY = grabStateRef.current.currentY;
      grabStateRef.current.currentX = dragTarget.x;
      grabStateRef.current.currentY = dragTarget.y;
    }
  };

  const handleMouseUp = () => {
    grabStateRef.current.active = false;
  };

  const handleMouseLeave = () => {
    grabStateRef.current.active = false;
    mousePosRef.current = { x: 0, y: 0 };
    setIsHovering(false);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!onVisualConfigChange) return;
    const delta = e.deltaY;
    const zoomStep = 0.05;
    onVisualConfigChange((prev) => {
      const currentScale = prev.imageScale !== undefined ? prev.imageScale : 1.0;
      const scaleDirection = delta > 0 ? -1 : 1;
      const targetScale = currentScale + scaleDirection * zoomStep;
      const clampedScale = Math.max(0.2, Math.min(4.0, targetScale));
      return {
        ...prev,
        imageScale: clampedScale
      };
    });
  };

  // Drag-and-drop actions
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadBlobFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      loadBlobFile(e.target.files[0]);
    }
  };

  // Preset quick triggers for modern shapes
  const triggerPresetVectorShape = (shapeType: 'ring' | 'star' | 'heart' | 'jelly') => {
    const size = 256;
    const pCanvas = document.createElement('canvas');
    pCanvas.width = size;
    pCanvas.height = size;
    const ctx = pCanvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();

    if (shapeType === 'ring') {
      // Modern Ring Donut
      ctx.arc(size/2, size/2, 95, 0, 2*Math.PI);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(size/2, size/2, 45, 0, 2*Math.PI);
      ctx.fill();
    } 
    else if (shapeType === 'star') {
      // Four-pointed Minimalist Emblem Star
      const cx = size/2; const cy = size/2;
      ctx.moveTo(cx, cy - 100);
      ctx.quadraticCurveTo(cx, cy, cx + 100, cy);
      ctx.quadraticCurveTo(cx, cy, cx, cy + 100);
      ctx.quadraticCurveTo(cx, cy, cx - 100, cy);
      ctx.quadraticCurveTo(cx, cy, cx, cy - 100);
      ctx.fill();
    }
    else if (shapeType === 'heart') {
      // Lovable Bubble puffy heart
      const cx = size/2; const cy = size/2 + 10;
      ctx.moveTo(cx, cy + 50);
      ctx.bezierCurveTo(cx - 80, cy - 20, cx - 70, cy - 90, cx, cy - 50);
      ctx.bezierCurveTo(cx + 70, cy - 90, cx + 80, cy - 20, cx, cy + 50);
      ctx.fill();
    }
    else {
      // Modern Eight-petaled Flower silhouette
      const cx = size/2; const cy = size/2;
      ctx.save();
      ctx.translate(cx, cy);
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.ellipse(0, -60, 28, 48, 0, 0, 2*Math.PI);
        ctx.fill();
        ctx.rotate(Math.PI / 4);
      }
      ctx.beginPath();
      ctx.arc(0, 0, 40, 0, 2*Math.PI);
      ctx.fill();
      ctx.restore();
    }

    const img = new Image();
    img.onload = () => {
      processImageToPuffyCanvas(img, `${shapeType.toUpperCase()} preset`);
    };
    img.src = pCanvas.toDataURL();
  };

  const hasImage = !!(heightmapUrl && diffuseUrl);

  return (
    <div 
      ref={dragAreaRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative w-full h-full flex-1 flex flex-col items-center justify-center border-2 transition-all p-6 min-h-[460px] ${
        dragActive ? 'border-neutral-900 bg-neutral-100' : 'border-neutral-200 bg-white'
      }`}
    >
      <input 
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept="image/*"
        className="hidden"
      />

      {/* 1. INITIAL PLACEHOLDER STATE (无图占位状态) */}
      {!hasImage ? (
        <div className="flex flex-col items-center justify-center text-center select-none max-w-sm w-full">
          {/* Draggable/Clickable upload box */}
          <div 
            onClick={() => fileInputRef.current?.click()}
            className="w-full flex flex-col items-center justify-center border border-dashed border-neutral-200 rounded-lg p-8 bg-neutral-50/40 hover:bg-neutral-50 hover:border-neutral-400 transition-all cursor-pointer group mb-6"
          >
            <div className="w-14 h-14 rounded-full border border-neutral-200 flex items-center justify-center bg-white mb-4 group-hover:scale-105 transition-all shadow-sm">
              <Upload className="w-5 h-5 text-neutral-400 group-hover:text-neutral-900 transition-colors" />
            </div>
            <h3 className="font-serif italic text-xl text-neutral-900 font-medium tracking-tight mb-2">
              Click, Drop or Paste to Inflate
            </h3>
            <p className="text-xs text-neutral-400 font-sans tracking-wide leading-relaxed">
              Drag JPG, PNG, or SVG shapes here, or paste an image directly to transform it into an elastic 3D puffy balloon sticker.
            </p>
          </div>

          {/* Quick preset trigger bar - completely separate and safe! */}
          <div className="border-t border-neutral-100 pt-5 w-full">
            <span className="text-[10px] font-mono tracking-widest text-neutral-400 uppercase block mb-3">
              Or Try A Minimal Preset Shape
            </span>
            <div className="flex justify-center gap-2">
              {(['ring', 'star', 'heart', 'jelly'] as const).map(shape => (
                <button
                  key={shape}
                  onClick={() => triggerPresetVectorShape(shape)}
                  className="px-2.5 py-1 border border-neutral-200 font-mono text-[9px] uppercase tracking-wide bg-white hover:border-neutral-950 transition hover:text-neutral-950 text-neutral-500 cursor-pointer shadow-sm rounded-sm"
                >
                  {shape}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        // 2. ACTIVE WEBGL VIEWPORT CANVAS
        <div 
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onMouseEnter={() => setIsHovering(true)}
          onWheel={handleWheel}
          className="absolute inset-0 w-full h-full flex flex-col items-stretch overflow-hidden group/canvas"
        >
          {/* Main 3D output frame */}
          <div 
            ref={containerRef} 
            className="w-full flex-1 relative custom-dot-cursor"
          />

          {/* Absolute floating overlay canvas for skeleton drawing */}
          <canvas
            ref={overlayCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none z-20"
          />

          {/* Top Right Controls - Safe from top-left widgets! */}
          <div className="absolute top-4 right-4 pointer-events-auto z-10 flex gap-1.5">
            {/* If in slime mode, show Slime specific reset option */}
            {visualConfig.interactionMode === 'slime' && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  resetSlimeToRest();
                }}
                className="px-2.5 py-1.5 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 hover:border-emerald-500 transition font-mono text-[9px] text-emerald-800 font-semibold tracking-wide cursor-pointer uppercase shadow-sm rounded-sm flex items-center gap-1"
                title="Restore default un-smeared colors and mesh rest shapes"
              >
                <RefreshCw className="w-3 h-3 text-emerald-600" />
                Reset Slime Paint
              </button>
            )}

            {/* Clear shape option */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClearImage();
              }}
              className="px-2.5 py-1.5 border border-neutral-200 bg-white hover:border-black transition font-mono text-[9px] text-neutral-600 hover:text-black tracking-wide cursor-pointer uppercase shadow-sm rounded-sm"
            >
              Clear Canvas
            </button>
          </div>

          <div className="absolute bottom-4 left-4 right-4 pointer-events-auto flex justify-between items-center z-10 gap-4">
            <div className="flex items-center gap-2">
              {/* File Info */}
              <div className="bg-white/95 backdrop-blur-md border border-neutral-200 px-3 py-1.5 shadow-sm text-[8px] font-mono text-neutral-500 uppercase flex items-center gap-1.5">
                <Layers3 className="w-3 h-3 text-neutral-400" />
                <span className="font-bold text-neutral-900">{imageName || "PuffyMesh Sheet"}</span>
                <span className="text-neutral-300">|</span>
                <span>GRID NODES: {(GRID_SIZE+1)*(GRID_SIZE+1)}</span>
              </div>

              {/* Spring activity tracer */}
              <div className="bg-white/95 backdrop-blur-md border border-neutral-200 px-3 py-1.5 shadow-sm text-[8px] font-mono text-neutral-500 flex items-center gap-1.5 uppercase">
                <Activity className="w-3 h-3 text-neutral-900 animate-pulse" />
                <span>Physics: {grabStateRef.current.active || handData.active ? 'Warp Tension' : 'Elastic Rest'}</span>
              </div>
            </div>

            <div 
              onClick={() => fileInputRef.current?.click()}
              className="bg-white hover:bg-neutral-50 border border-neutral-200 px-3 py-2 shadow-sm flex items-center gap-1.5 cursor-pointer text-[9px] font-mono font-bold text-neutral-800 uppercase tracking-widest hover:border-black transition"
            >
              <FileImage className="w-3.5 h-3.5" />
              <span>Replace Image</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
