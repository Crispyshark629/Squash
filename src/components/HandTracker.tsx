import React, { useRef, useEffect, useState } from 'react';
import { Play, Pause, Camera, WifiOff, AlertCircle, Sparkles, Sliders } from 'lucide-react';
import { HandData } from '../types';

const SKELETON_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8], // Index
  [0, 9], [9, 10], [10, 11], [11, 12], // Middle
  [0, 13], [13, 14], [14, 15], [15, 16], // Ring
  [0, 17], [17, 18], [18, 19], [19, 20], // Pinky
  [5, 9], [9, 13], [13, 17] // Palm bridge
];

function drawSkeleton(ctx: CanvasRenderingContext2D, pts: { x: number, y: number }[], pinch: number) {
  ctx.strokeStyle = '#000000'; // minimalist thin black line
  ctx.lineWidth = 0.85;       // fine thin line
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Draw connections
  SKELETON_CONNECTIONS.forEach(([p1, p2]) => {
    if (pts[p1] && pts[p2]) {
      ctx.beginPath();
      ctx.moveTo(pts[p1].x, pts[p1].y);
      ctx.lineTo(pts[p2].x, pts[p2].y);
      ctx.stroke();
    }
  });

  // Draw joint details
  pts.forEach((pt, idx) => {
    const isTip = idx === 4 || idx === 8 || idx === 12 || idx === 16 || idx === 20;
    
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    // Finger tips are slightly larger
    ctx.arc(pt.x, pt.y, isTip ? 2.5 : 1.2, 0, 2 * Math.PI);
    ctx.fill();
  });
}

function generateSimulatedPoints(cx: number, cy: number, pinch: number, isLeft: boolean) {
  const pts: { x: number, y: number }[] = [];
  const side = isLeft ? -1 : 1;

  // Wrist
  pts[0] = { x: cx, y: cy + 45 };

  // Knuckles base (5, 9, 13, 17)
  const k5 = { x: cx - 11 * side, y: cy + 12 };
  const k9 = { x: cx - 2 * side, y: cy + 9 };
  const k13 = { x: cx + 7 * side, y: cy + 11 };
  const k17 = { x: cx + 15 * side, y: cy + 15 };

  pts[5] = k5;
  pts[9] = k9;
  pts[13] = k13;
  pts[17] = k17;

  // Thumb structure (1, 2, 3, 4)
  pts[1] = { x: cx - 15 * side, y: cy + 28 };
  pts[2] = { x: cx - 27 * side, y: cy + 18 };
  pts[3] = { x: cx - 29 * side + pinch * 13 * side, y: cy + 6 - pinch * 4 };
  pts[4] = { x: cx - 25 * side + pinch * 17 * side, y: cy - 4 + pinch * 8 }; // Tip (reaches toward index finger tip when pinching)

  // Index (5 -> 6 -> 7 -> 8)
  pts[6] = { x: k5.x - 1 * side, y: k5.y - 12 };
  pts[7] = { x: k5.x - 2 * side, y: k5.y - 24 };
  pts[8] = { x: k5.x - 1 * side, y: k5.y - 36 + pinch * 10 }; // Tip retracts during pinch

  // Middle (9 -> 10 -> 11 -> 12)
  pts[10] = { x: k9.x, y: k9.y - 14 };
  pts[11] = { x: k9.x, y: k9.y - 28 };
  pts[12] = { x: k9.x, y: k9.y - 42 };

  // Ring (13 -> 14 -> 15 -> 16)
  pts[14] = { x: k13.x, y: k13.y - 13 };
  pts[15] = { x: k13.x, y: k13.y - 26 };
  pts[16] = { x: k13.x, y: k13.y - 39 };

  // Pinky (17 -> 18 -> 19 -> 20)
  pts[18] = { x: k17.x + 1 * side, y: k17.y - 11 };
  pts[19] = { x: k17.x + 1 * side, y: k17.y - 21 };
  pts[20] = { x: k17.x + 1 * side, y: k17.y - 31 };

  return pts;
}

interface HandTrackerProps {
  onHandData: (data: HandData) => void;
  handData: HandData;
}

export default function HandTracker({ onHandData, handData }: HandTrackerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Simulation mode states - ensures perfect sandboxed usage when webcam is blocked
  const [isSimulating, setIsSimulating] = useState<boolean>(true); // start in simulation mode to guarantee instant interaction in sandboxed container!
  const [simDistance, setSimDistance] = useState<number>(0.65);
  const [simPinch, setSimPinch] = useState<number>(0.0);
  const [simPos, setSimPos] = useState({ x: 0.0, y: 0.0 });
  const [isMouseOver, setIsMouseOver] = useState<boolean>(false);
  const [dualHand, setDualHand] = useState<boolean>(true);
  const [autopilot, setAutopilot] = useState<boolean>(false); // Autopilot defaults to false for purely user-driven touch!

  // Use refs to avoid re-binding callbacks inside tight MediaPipe animation loops
  const onHandDataRef = useRef(onHandData);
  useEffect(() => {
    onHandDataRef.current = onHandData;
  }, [onHandData]);

  // --- 1. MEDIA PIPE LIVE CAMERA LIFECYCLE ---
  useEffect(() => {
    let handsInstance: any = null;
    let isDestroyed = false;
    let localStream: MediaStream | null = null;
    let reqFrameId: number | null = null;

    if (isSimulating || !isPlaying) return;

    const initializeMediaPipe = async () => {
      const MP_Hands = (window as any).Hands;

      if (!MP_Hands) {
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if ((window as any).Hands) break;
        }
      }

      const HandsConstructor = (window as any).Hands;

      if (!HandsConstructor) {
        setErrorMsg("MediaPipe CDN blocked or loading. Emulation Sandbox active.");
        setIsSimulating(true);
        return;
      }

      if (!videoRef.current || !canvasRef.current || isDestroyed) return;

      try {
        handsInstance = new HandsConstructor({
          locateFile: (file: string) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/${file}`;
          }
        });

        handsInstance.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.5,
          minTrackingConfidence: 0.5
        });

        handsInstance.onResults((results: any) => {
          if (isDestroyed || !isPlaying || isSimulating) return;

          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          ctx.clearRect(0, 0, canvas.width, canvas.height);

          const detectedHands: HandData[] = [];

          if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const limit = dualHand ? Math.min(2, results.multiHandLandmarks.length) : 1;
            
            for (let i = 0; i < limit; i++) {
              const landmarks = results.multiHandLandmarks[i];
              const wrist = landmarks[0];
              const thumbTip = landmarks[4];
              const indexTip = landmarks[8];
              const middleMcp = landmarks[9];
              const pinkyMcp = landmarks[17];

              const palmCenterX = (wrist.x + indexTip.x + pinkyMcp.x) / 3;
              const palmCenterY = (wrist.y + indexTip.y + pinkyMcp.y) / 3;
              
              // Map coordinates nicely to screen aspect
              const clientX = (0.5 - palmCenterX) * 2.5;
              const clientY = (0.5 - palmCenterY) * 2.5;

              // Pinch is computed as distance between thumb tip and index finger tip
              const pinchDx = thumbTip.x - indexTip.x;
              const pinchDy = thumbTip.y - indexTip.y;
              const pinchDistance = Math.sqrt(pinchDx * pinchDx + pinchDy * pinchDy);
              const pinchFactor = Math.max(0, Math.min(1, 1 - (pinchDistance - 0.03) / 0.12));

              // Depth index
              const depthDx = wrist.x - middleMcp.x;
              const depthDy = wrist.y - middleMcp.y;
              const depthDistance = Math.sqrt(depthDx * depthDx + depthDy * depthDy);
              const depthFactor = Math.max(0, Math.min(1, (depthDistance - 0.12) / 0.22));

              const skPts = landmarks.map((lm: any) => ({
                x: 1.0 - lm.x,
                y: lm.y
              }));

              detectedHands.push({
                x: Number(clientX.toFixed(3)),
                y: Number(clientY.toFixed(3)),
                distance: Number(depthFactor.toFixed(3)),
                roll: 0,
                pinch: Number(pinchFactor.toFixed(3)),
                spread: 0.5,
                active: true,
                isWebcam: true,
                skeletonPoints: skPts
              });
            }
          }

          if (detectedHands.length > 0) {
            onHandDataRef.current({
              ...detectedHands[0],
              hands: detectedHands,
              active: true,
              isWebcam: true
            });
          } else {
            onHandDataRef.current({ ...handData, active: false, isWebcam: true, hands: [] });
          }
        });

        // Request camera with standard HTML5 MediaDevices API (most stable inside sandbox context)
        localStream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 320 },
            height: { ideal: 240 },
            facingMode: 'user'
          },
          audio: false
        });

        if (videoRef.current) {
          videoRef.current.srcObject = localStream;
          videoRef.current.onloadedmetadata = () => {
            videoRef.current?.play().catch(e => console.warn("Video auto-play blocked:", e));
          };
        }

        let isProcessing = false;
        const processFrame = async () => {
          if (isDestroyed || !isPlaying || isSimulating) return;

          if (videoRef.current && videoRef.current.readyState >= 2 && handsInstance && !isProcessing) {
            isProcessing = true;
            try {
              await handsInstance.send({ image: videoRef.current });
            } catch (err) {
              console.warn("Hands model frame processing warning:", err);
            }
            isProcessing = false;
          }

          if (!isDestroyed && isPlaying && !isSimulating) {
            reqFrameId = requestAnimationFrame(processFrame);
          }
        };

        // Fire the processing frame loops
        reqFrameId = requestAnimationFrame(processFrame);
        setIsLoaded(true);
        setErrorMsg(null);
      } catch (err: any) {
        console.warn("Camera failed/blocked inside iframe. Falling back seamlessly to Simulator sandbox.", err);
        setIsLoaded(false);
        setIsSimulating(true);
      }
    };

    initializeMediaPipe();

    return () => {
      isDestroyed = true;
      if (reqFrameId) {
        cancelAnimationFrame(reqFrameId);
      }
      if (localStream) {
        try {
          localStream.getTracks().forEach(track => track.stop());
        } catch (e) {}
      }
      if (handsInstance) {
        try {
          handsInstance.close();
        } catch (e) {}
      }
    };
  }, [isPlaying, isSimulating]);

  // --- 2. OFFLINE MANUAL SIMULATOR TICK ---
  useEffect(() => {
    if (!isSimulating) return;

    let animId: number;
    let time = 0;

    const renderSim = () => {
      time += 0.02;
      const canvas = canvasRef.current;
      if (!canvas) {
        animId = requestAnimationFrame(renderSim);
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        animId = requestAnimationFrame(renderSim);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let targetX = simPos.x;
      let targetY = simPos.y;
      let isActive = isMouseOver;

      if (!isMouseOver) {
        if (autopilot) {
          // Floating motion if mouse idle and autopilot is enabled
          targetX = Math.sin(time * 0.8) * 0.4;
          targetY = Math.cos(time * 0.6) * 0.25;
          isActive = true;
        } else {
          isActive = false;
        }
      }

      if (dualHand) {
        // Multi-hand simulation
        const lHand: HandData = {
          x: Number((-Math.abs(targetX) - 0.45).toFixed(3)),
          y: Number(targetY.toFixed(3)),
          distance: Number(simDistance.toFixed(3)),
          roll: 0,
          pinch: Number(simPinch.toFixed(3)),
          spread: 0.5,
          active: isActive
        };

        const rHand: HandData = {
          x: Number((Math.abs(targetX) + 0.45).toFixed(3)),
          y: Number(targetY.toFixed(3)),
          distance: Number(simDistance.toFixed(3)),
          roll: 0,
          pinch: Number(simPinch.toFixed(3)),
          spread: 0.5,
          active: isActive
        };

        // Multi-hand simulation
        const cxL = ((lHand.x) / 2.5 + 0.5) * canvas.width;
        const cyL = (0.5 - (lHand.y) / 2.5) * canvas.height;
        const ptsL = generateSimulatedPoints(cxL, cyL, simPinch, true);
        const ptsLNormalized = ptsL.map(p => ({ x: p.x / canvas.width, y: p.y / canvas.height }));

        const cxR = ((rHand.x) / 2.5 + 0.5) * canvas.width;
        const cyR = (0.5 - (rHand.y) / 2.5) * canvas.height;
        const ptsR = generateSimulatedPoints(cxR, cyR, simPinch, false);
        const ptsRNormalized = ptsR.map(p => ({ x: p.x / canvas.width, y: p.y / canvas.height }));

        const lHandWithSk: HandData = {
          ...lHand,
          skeletonPoints: ptsLNormalized
        };

        const rHandWithSk: HandData = {
          ...rHand,
          skeletonPoints: ptsRNormalized
        };

        const handsList = [lHandWithSk, rHandWithSk];

        onHandDataRef.current({
          ...rHandWithSk,
          hands: handsList,
          skeletonPoints: ptsRNormalized,
          active: isActive
        });

        // Draw simple minimalist tracking dots on the controller pad instead of a full skeleton if active
        if (isActive) {
          ctx.fillStyle = '#000000';
          ctx.beginPath();
          ctx.arc(cxL, cyL, 3.5, 0, 2 * Math.PI);
          ctx.fill();

          ctx.beginPath();
          ctx.arc(cxR, cyR, 3.5, 0, 2 * Math.PI);
          ctx.fill();
        }
      } else {
        // Single hand simulation
        const cx = (targetX / 2.5 + 0.5) * canvas.width;
        const cy = (0.5 - targetY / 2.5) * canvas.height;
        const pts = generateSimulatedPoints(cx, cy, simPinch, false);
        const ptsNormalized = pts.map(p => ({ x: p.x / canvas.width, y: p.y / canvas.height }));

        onHandDataRef.current({
          x: Number(targetX.toFixed(3)),
          y: Number(targetY.toFixed(3)),
          distance: Number(simDistance.toFixed(3)),
          roll: 0,
          pinch: Number(simPinch.toFixed(3)),
          spread: 0.5,
          active: isActive,
          hands: [],
          skeletonPoints: ptsNormalized
        });

        // Draw simple minimalist tracking dot for single hand simulation if active
        if (isActive) {
          ctx.fillStyle = '#000000';
          ctx.beginPath();
          ctx.arc(cx, cy, 4, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      animId = requestAnimationFrame(renderSim);
    };

    animId = requestAnimationFrame(renderSim);
    return () => cancelAnimationFrame(animId);
  }, [isSimulating, simDistance, simPinch, simPos, isMouseOver, dualHand, autopilot]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const rawX = (e.clientX - rect.left) / rect.width;
    const rawY = (e.clientY - rect.top) / rect.height;
    
    const clientX = (rawX - 0.5) * 2.5; 
    const clientY = (rawY - 0.5) * -2.5; // invert Y for mathematical coherence with WebGL space

    setSimPos({
      x: Number(clientX.toFixed(3)),
      y: Number(clientY.toFixed(3))
    });
  };

  const toggleCapture = () => {
    if (isSimulating) {
      setIsPlaying(true);
      setIsSimulating(false);
      setErrorMsg(null);
    } else {
      setIsPlaying(false);
      setIsSimulating(true);
      setErrorMsg(null);
    }
  };

  return (
    <div id="gesture-controller-card" className="border border-neutral-200 bg-white p-4 flex flex-col gap-3 font-sans">
      <div className="flex items-center justify-between border-b border-neutral-100 pb-2">
        <div className="flex items-center gap-2">
          <Camera className="w-4 h-4 text-neutral-900" />
          <span className="text-xs font-mono font-bold tracking-wider text-neutral-900 uppercase">
            {isSimulating ? 'Air Motion Hand Simulator' : 'MediaPipe Edge Sensing'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wide text-neutral-400">
          <span className={`w-1.5 h-1.5 rounded-full ${isSimulating ? 'bg-neutral-900 animate-pulse' : (handData.active ? 'bg-green-500' : 'bg-neutral-300')}`} />
          <span>{isSimulating ? 'Emulation Live' : (handData.active ? 'Sensory Input Recv' : 'Offline')}</span>
        </div>
      </div>
      
      {/* Two Hands Mode Toggle */}
      <div className="flex flex-col gap-1.5 bg-neutral-50 p-2 border border-neutral-200 rounded">
        <div className="flex items-center justify-between font-mono text-[9px]">
          <span className="text-neutral-500 font-bold uppercase tracking-wider">Multi-Hand Mode (Stretching)</span>
          <input 
            type="checkbox"
            checked={dualHand}
            onChange={(e) => setDualHand(e.target.checked)}
            className="accent-neutral-900 h-3.5 w-3.5 cursor-pointer rounded"
          />
        </div>
        {isSimulating && (
          <div className="flex items-center justify-between font-mono text-[9px] border-t border-neutral-200/60 pt-1.5 mt-0.5">
            <span className="text-neutral-500 font-bold uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-neutral-400" />
              Autopilot Touch (自动演示触控)
            </span>
            <input 
              type="checkbox"
              checked={autopilot}
              onChange={(e) => setAutopilot(e.target.checked)}
              className="accent-neutral-900 h-3.5 w-3.5 cursor-pointer rounded"
            />
          </div>
        )}
      </div>

      {/* Interactive viewport mapping */}
      <div 
        ref={containerRef}
        onMouseMove={handleMouseMove}
        onMouseEnter={() => setIsMouseOver(true)}
        onMouseLeave={() => {
          setIsMouseOver(false);
          if (isSimulating) setSimPinch(0);
        }}
        onMouseDown={() => setSimPinch(1.0)}
        onMouseUp={() => setSimPinch(0.0)}
        className="relative w-full aspect-[4/3] bg-neutral-50 border border-neutral-100 hover:border-neutral-200 transition cursor-crosshair overflow-hidden flex items-center justify-center p-4"
      >
        {isSimulating && (
          <div className="absolute inset-0 bg-white zine-dot-grid opacity-60 pointer-events-none" />
        )}

        {/* Live camera stream */}
        <video
          ref={videoRef}
          className={`absolute inset-0 w-full h-full object-cover opacity-10 transform scale-x-[-1] pointer-events-none ${isSimulating ? 'hidden' : 'block'}`}
          playsInline
          muted
          autoPlay
        />

        {/* Ripple drawing board */}
        <canvas
          ref={canvasRef}
          width={320}
          height={240}
          className="absolute inset-0 w-full h-full pointer-events-none z-10"
        />

        {/* Instructions */}
        <div className="absolute top-2 left-2 right-2 flex justify-between items-center text-[8px] font-mono text-neutral-400 pointer-events-none select-none">
          <span>COORDINATE FIELD</span>
          {isSimulating && <span>DRAG & CLICK MOUSE IN FIELD TO SIMULATE PINCH</span>}
        </div>

        {/* Mini telemetry output */}
        {handData.active && (
          <div className={`absolute bottom-2 ${handData.x > 0 ? 'right-2' : 'left-2'} bg-white/95 backdrop-blur-sm border border-neutral-200 px-2 py-1 flex flex-col font-mono text-[8px] text-neutral-500 gap-0.5 z-20 pointer-events-none shadow-sm min-w-[110px]`}>
            <div className="text-neutral-900 font-bold border-b border-neutral-100 pb-0.5 mb-0.5 uppercase">Sensory HUD</div>
            <div className="flex justify-between">X / Y: <span className="text-neutral-900 font-semibold">{handData.x.toFixed(2)}, {handData.y.toFixed(2)}</span></div>
            <div className="flex justify-between">PINCH: <span className="text-neutral-900 font-semibold">{Math.round(handData.pinch * 100)}%</span></div>
            <div className="flex justify-between">DEPTH: <span className="text-neutral-900 font-semibold">{Math.round(handData.distance * 100)}%</span></div>
          </div>
        )}
      </div>

      {isSimulating && (
        <div className="flex flex-col gap-2 bg-neutral-50 p-3 border border-neutral-100 font-mono text-[10px]">
          <div className="flex justify-between text-neutral-500">
            <span>Air Pinch Strength</span>
            <span className="text-neutral-900 font-semibold">{Math.round(simPinch * 100)}%</span>
          </div>
          <input 
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={simPinch}
            onChange={(e) => setSimPinch(parseFloat(e.target.value))}
            className="w-full accent-neutral-900 h-1 bg-neutral-200 rounded-lg appearance-none cursor-pointer"
          />

          <div className="flex justify-between text-neutral-500 mt-1">
            <span>Z-Depth / Base Distance</span>
            <span className="text-neutral-900 font-semibold">{Math.round(simDistance * 100)}%</span>
          </div>
          <input 
            type="range"
            min="0.2"
            max="1.5"
            step="0.01"
            value={simDistance}
            onChange={(e) => setSimDistance(parseFloat(e.target.value))}
            className="w-full accent-neutral-900 h-1 bg-neutral-200 rounded-lg appearance-none cursor-pointer"
          />
        </div>
      )}

      {/* Button controls */}
      <div className="flex gap-2">
        <button
          onClick={toggleCapture}
          className={`flex-1 py-1.5 border font-mono text-[9px] uppercase tracking-wider text-center transition cursor-pointer font-semibold ${
            !isSimulating && isPlaying 
              ? 'bg-neutral-900 border-neutral-900 text-white hover:bg-neutral-850' 
              : 'bg-white border-neutral-200 text-neutral-600 hover:border-neutral-900 hover:text-neutral-900'
          }`}
        >
          {!isSimulating && isPlaying ? "DEACTIVATE CAMERA" : "CONNECT WEBCAM"}
        </button>
      </div>
    </div>
  );
}
