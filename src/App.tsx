import React, { useState } from 'react';
import { HandData, VisualConfig } from './types';
import HandTracker from './components/HandTracker';
import ThreeStage from './components/ThreeStage';
import { 
  Sliders, 
  Sparkles, 
  RefreshCw, 
  Info, 
  Settings2,
  Tornado,
  Waves,
  Heart,
  Undo2,
  Layers,
  Droplet,
  Volume2,
  VolumeX,
  Upload,
  Trash2
} from 'lucide-react';
import { SlimeAudio } from './components/SlimeAudio';

export default function App() {
  // 1. Master Hand Coordinates and Pinch Capture State
  const [handData, setHandData] = useState<HandData>({
    x: 0,
    y: 0,
    distance: 0.6,
    roll: 0.0,
    pinch: 0.0,
    spread: 0.5,
    active: false,
    hands: []
  });

  // 2. 3D WebGL Inflated mesh settings
  const [visualConfig, setVisualConfig] = useState<VisualConfig>({
    puffiness: 0.1,
    twist: 0.0,
    meshDensity: 24,
    noiseStrength: 0.0,
    noiseFreq: 3.0,
    colorShift: 0.8,
    autorotate: false,
    materialType: 'glow',
    speed: 1.0,
    glowIntensity: 0.5,
    stiffness: 240.0, // Restoring spring stiffness rate
    damping: 9.0,     // Damped return rate
    cohesion: 160.0,  // Grid mesh nodes cohesion strength
    interactionMode: 'sticker', // Default: Sticker (elastic)
    maxStrainDistMultiplier: 2.5,
    bulgeStrength: 0.35,
    plasticity: 0.0,
    soundEnabled: true,
    imageScale: 1.0
  });

  // 3. User Uploaded Image Buffers state
  const [heightmapUrl, setHeightmapUrl] = useState<string | null>(null);
  const [diffuseUrl, setDiffuseUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string | null>(null);
  const [controlsOpen, setControlsOpen] = useState(true);

  // Custom audio configuration tracking states
  const [customSoundNames, setCustomSoundNames] = useState({
    touch: '',
    drag: '',
    release: ''
  });
  const [soundLoading, setSoundLoading] = useState({
    touch: false,
    drag: false,
    release: false
  });

  const handleSoundUpload = async (type: 'touch' | 'drag' | 'release', file: File | null) => {
    if (!file) {
      if (type === 'touch') SlimeAudio.setCustomTouchBuffer(null);
      if (type === 'drag') SlimeAudio.setCustomDragBuffer(null);
      if (type === 'release') SlimeAudio.setCustomReleaseBuffer(null);
      setCustomSoundNames(prev => ({ ...prev, [type]: '' }));
      return;
    }

    setSoundLoading(prev => ({ ...prev, [type]: true }));
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const arrayBuffer = e.target?.result as ArrayBuffer;
          if (!arrayBuffer) throw new Error('读取数据失败');
          const decoded = await SlimeAudio.decodeAudioFile(arrayBuffer);
          
          if (type === 'touch') SlimeAudio.setCustomTouchBuffer(decoded);
          if (type === 'drag') SlimeAudio.setCustomDragBuffer(decoded);
          if (type === 'release') SlimeAudio.setCustomReleaseBuffer(decoded);
          
          setCustomSoundNames(prev => ({ ...prev, [type]: file.name }));
        } catch (err) {
          alert('音频解码失败：请上传合法的音频文件 (推荐 MP3, WAV, AAC 或 OGG 格式)');
        } finally {
          setSoundLoading(prev => ({ ...prev, [type]: false }));
        }
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      console.error(err);
      setSoundLoading(prev => ({ ...prev, [type]: false }));
    }
  };

  // Quick Preset Materials Loader
  const loadPresetMaterial = (type: 'holo' | 'chrome' | 'gold' | 'ceramic' | 'glow') => {
    setVisualConfig(prev => ({
      ...prev,
      materialType: type
    }));
  };

  const resetPhysicsToDefault = () => {
    setVisualConfig(prev => ({
      ...prev,
      puffiness: 0.1,
      stiffness: 240.0,
      damping: 9.0,
      cohesion: 160.0,
      autorotate: false
    }));
  };

  // Handles raw vector uploads and custom processing from ThreeStage callback
  const handleImageProcessed = (heightmap: string, diffuse: string, name: string) => {
    setHeightmapUrl(heightmap);
    setDiffuseUrl(diffuse);
    setImageName(name);
  };

  const handleClearImage = () => {
    setHeightmapUrl(null);
    setDiffuseUrl(null);
    setImageName(null);
  };

  return (
    <div id="canvas-main-viewport" className="w-screen h-screen overflow-hidden bg-white text-neutral-900 font-sans relative select-none">
      
      {/* Background static dot pitch mesh of Zine Style design */}
      <div className="absolute inset-0 zine-dot-grid opacity-30 pointer-events-none z-0" />

      {/* 1. COLLAPSIBLE FLOATING CONTROL PANEL */}
      <div className="absolute top-4 left-4 z-20 flex flex-col gap-2 max-w-[340px] w-full">
        
        {/* Toggle Trigger */}
        <div className="bg-white/95 backdrop-blur-md border border-neutral-200/80 p-3 shadow-md flex items-center justify-between transition-all rounded">
          <button 
            onClick={() => setControlsOpen(prev => !prev)}
            className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-neutral-900 hover:text-neutral-500 transition cursor-pointer"
          >
            <Settings2 className="w-4 h-4 text-neutral-900" />
            <span>Interactive Controls</span>
          </button>
          <button
            onClick={() => setControlsOpen(prev => !prev)}
            className="font-mono text-[9px] text-neutral-400 hover:text-neutral-900 transition px-1.5 py-0.5 border border-dashed border-neutral-200 hover:border-neutral-900 rounded uppercase font-bold"
          >
            {controlsOpen ? '[ COLLAPSE ]' : '[ OPEN ]'}
          </button>
        </div>

        {/* Panel Main content */}
        {controlsOpen && (
          <div className="bg-white/95 backdrop-blur-md border border-neutral-200/80 p-4 shadow-md flex flex-col gap-4 max-h-[82vh] overflow-y-auto scrollbar-thin rounded">
            
            {/* Header section with Reset */}
            <div className="flex justify-between items-center border-b border-neutral-100 pb-2">
              <span className="text-[9px] font-mono font-semibold text-neutral-400 uppercase tracking-wider">
                Physical Modifiers
              </span>
              <button 
                onClick={resetPhysicsToDefault}
                className="text-[8px] font-mono text-neutral-400 hover:text-neutral-950 flex items-center gap-1 bg-neutral-50 border border-neutral-200 px-1.5 py-0.5 transition cursor-pointer font-bold uppercase"
              >
                <RefreshCw className="w-2.5 h-2.5" />
                Reset
              </button>
            </div>



            {/* Sliders Area */}
            <div className="space-y-4 font-mono text-[9px]">

              {/* Interactive Mode Toggle Selection */}
              <div className="space-y-2 pb-3 border-b border-neutral-100">
                <span className="text-[9px] uppercase font-bold text-neutral-400 tracking-wider">Simulation Mode</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setVisualConfig(prev => {
                      const stiffnessRatio = prev.stiffness / 40.0;
                      const dampingRatio = prev.damping / 18.0;
                      const newStiffness = Math.max(80.0, Math.min(450.0, 240.0 * stiffnessRatio));
                      const newDamping = Math.max(2.0, Math.min(26.0, 9.0 * dampingRatio));
                      return { 
                        ...prev, 
                        interactionMode: 'sticker',
                        stiffness: newStiffness,
                        damping: newDamping,
                        cohesion: prev.cohesion
                      };
                    })}
                    className={`flex flex-col items-center justify-center py-2.5 px-2 border rounded transition-all cursor-pointer text-center ${
                      visualConfig.interactionMode === 'sticker'
                        ? 'border-neutral-950 bg-neutral-950 text-white shadow-sm font-semibold'
                        : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400'
                    }`}
                  >
                    <Sparkles className={`w-3.5 h-3.5 mb-1.5 ${visualConfig.interactionMode === 'sticker' ? 'text-amber-300' : 'text-neutral-400'}`} />
                    <span className="uppercase tracking-wider text-[8px] block">Sticker Mode</span>
                    <span className="text-[7.5px] opacity-75 font-sans leading-normal mt-0.5">Elastic Shape</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisualConfig(prev => {
                      const stiffnessRatio = prev.stiffness / 240.0;
                      const dampingRatio = prev.damping / 9.0;
                      const newStiffness = Math.max(5.0, Math.min(120.0, 40.0 * stiffnessRatio));
                      const newDamping = Math.max(2.0, Math.min(35.0, 18.0 * dampingRatio));
                      return { 
                        ...prev, 
                        interactionMode: 'slime',
                        stiffness: newStiffness,
                        damping: newDamping,
                        cohesion: prev.cohesion,
                        maxStrainDistMultiplier: prev.maxStrainDistMultiplier ?? 2.5,
                        bulgeStrength: prev.bulgeStrength ?? 0.35,
                        plasticity: prev.plasticity ?? 0.2
                      };
                    })}
                    className={`flex flex-col items-center justify-center py-2.5 px-2 border rounded transition-all cursor-pointer text-center ${
                      visualConfig.interactionMode === 'slime'
                        ? 'border-neutral-950 bg-neutral-950 text-white shadow-sm font-semibold'
                        : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-400'
                    }`}
                  >
                    <Droplet className={`w-3.5 h-3.5 mb-1.5 ${visualConfig.interactionMode === 'slime' ? 'text-emerald-400' : 'text-neutral-400'}`} />
                    <span className="uppercase tracking-wider text-[8px] block animate-pulse">Slime Mode</span>
                    <span className="text-[7.5px] opacity-75 font-sans leading-normal mt-0.5">Viscous Paint</span>
                  </button>
                </div>
              </div>
              
              {visualConfig.interactionMode === 'slime' ? (
                <>
                  {/* SLIME SLIDERS SECTION */}
                  {/* Slime Slider 1: Slime Stiffness */}
                  <div className="space-y-1 bg-emerald-50/40 p-1.5 rounded border border-emerald-100/30">
                    <div className="flex justify-between text-emerald-800">
                      <span className="uppercase font-bold">Stiffness (Jelly vs Mud)</span>
                      <span className="text-emerald-950 font-bold font-mono">{visualConfig.stiffness.toFixed(0)} N/m</span>
                    </div>
                    <p className="text-[7.5px] leading-snug text-emerald-700/80 font-sans mb-1">
                      Low (5-15): muddy melt. High (60-120): ultra bouncy cold jelly.
                    </p>
                    <input 
                      type="range"
                      min="5"
                      max="120"
                      step="1"
                      value={visualConfig.stiffness}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, stiffness: parseFloat(e.target.value) }))}
                      className="w-full accent-emerald-600 h-1 bg-emerald-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slime Slider 2: Slime Damping */}
                  <div className="space-y-1 bg-emerald-50/40 p-1.5 rounded border border-emerald-100/30">
                    <div className="flex justify-between text-emerald-800">
                      <span className="uppercase font-bold">Damping (Viscosity Damping)</span>
                      <span className="text-emerald-950 font-bold font-mono">{visualConfig.damping.toFixed(1)}</span>
                    </div>
                    <p className="text-[7.5px] leading-snug text-emerald-700/80 font-sans mb-1">
                      Low: water waves & metallic flutter. High: thick non-newtonian friction.
                    </p>
                    <input 
                      type="range"
                      min="2.0"
                      max="35.0"
                      step="0.5"
                      value={visualConfig.damping}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, damping: parseFloat(e.target.value) }))}
                      className="w-full accent-emerald-600 h-1 bg-emerald-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slime Slider 3: Slime Cohesion */}
                  <div className="space-y-1 bg-emerald-50/40 p-1.5 rounded border border-emerald-100/30">
                    <div className="flex justify-between text-emerald-800">
                      <span className="uppercase font-bold">Cohesion (Slime Cohesion)</span>
                      <span className="text-emerald-950 font-bold font-mono">{visualConfig.cohesion.toFixed(0)}</span>
                    </div>
                    <input 
                      type="range"
                      min="10"
                      max="450"
                      step="10"
                      value={visualConfig.cohesion}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, cohesion: parseFloat(e.target.value) }))}
                      className="w-full accent-emerald-600 h-1 bg-emerald-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slime Slider 4: Slime Max Strain Limit */}
                  <div className="space-y-1 bg-emerald-50/40 p-1.5 rounded border border-emerald-100/30">
                    <div className="flex justify-between text-emerald-800">
                      <span className="uppercase font-bold">Strain Limit (Strain/Extension)</span>
                      <span className="text-emerald-950 font-bold font-mono">{(visualConfig.maxStrainDistMultiplier ?? 2.5).toFixed(1)}x</span>
                    </div>
                    <p className="text-[7.5px] leading-snug text-emerald-700/80 font-sans mb-1">
                      Low (1.1): cohesive candy. High (3.5): stretch and plow wide gaps.
                    </p>
                    <input 
                      type="range"
                      min="1.1"
                      max="3.5"
                      step="0.1"
                      value={visualConfig.maxStrainDistMultiplier ?? 2.5}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, maxStrainDistMultiplier: parseFloat(e.target.value) }))}
                      className="w-full accent-emerald-600 h-1 bg-emerald-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slime Slider 5: Bulge strength Z */}
                  <div className="space-y-1 bg-emerald-50/40 p-1.5 rounded border border-emerald-100/30">
                    <div className="flex justify-between text-emerald-800">
                      <span className="uppercase font-bold">Bulge Height (Juicy Explosion)</span>
                      <span className="text-emerald-950 font-bold font-mono">{(visualConfig.bulgeStrength ?? 0.35).toFixed(2)}</span>
                    </div>
                    <p className="text-[7.5px] leading-snug text-emerald-700/80 font-sans mb-1">
                      Low (0-0.05): flat coating. High (0.35-1.5): thick explosive juice peaks.
                    </p>
                    <input 
                      type="range"
                      min="0.0"
                      max="1.5"
                      step="0.05"
                      value={visualConfig.bulgeStrength ?? 0.35}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, bulgeStrength: parseFloat(e.target.value) }))}
                      className="w-full accent-emerald-600 h-1 bg-emerald-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slime Slider 6: Plasticity Memory */}
                  <div className="space-y-1 bg-emerald-50/40 p-1.5 rounded border border-emerald-100/30">
                    <div className="flex justify-between text-emerald-800">
                      <span className="uppercase font-bold">Plasticity (Clay Memory)</span>
                      <span className="text-emerald-950 font-bold font-mono">{(visualConfig.plasticity ?? 0.0).toFixed(2)}</span>
                    </div>
                    <p className="text-[7.5px] leading-snug text-emerald-700/80 font-sans mb-1">
                      0.0: absolute elastic snap. High (0.4-0.8): carve deep permanent trenches.
                    </p>
                    <input 
                      type="range"
                      min="0.0"
                      max="0.8"
                      step="0.05"
                      value={visualConfig.plasticity ?? 0.0}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, plasticity: parseFloat(e.target.value) }))}
                      className="w-full accent-emerald-600 h-1 bg-emerald-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slime Sound Feedback Controls */}
                  <div className="space-y-2 bg-emerald-50/40 p-2 rounded border border-emerald-100/50 mt-1 dark:border-neutral-800">
                    <div className="flex items-center justify-between text-emerald-800">
                      <span className="uppercase font-bold flex items-center gap-1.5 text-[8.5px]">
                        <Volume2 className="w-3.5 h-3.5 animate-pulse" />
                        Viscous Slime Audio (揉捏流体音效)
                      </span>
                      <input 
                        type="checkbox"
                        checked={visualConfig.soundEnabled ?? true}
                        onChange={(e) => setVisualConfig(prev => ({ ...prev, soundEnabled: e.target.checked }))}
                        className="accent-emerald-600 h-3.5 w-3.5 cursor-pointer rounded"
                      />
                    </div>
                    {(visualConfig.soundEnabled !== false) && (
                      <div className="space-y-2 pt-1.5 border-t border-emerald-200/40">
                        <p className="text-[7.5px] leading-relaxed text-emerald-800 bg-white/50 p-1.5 rounded border border-emerald-100/10">
                          🔊 <span className="font-semibold text-emerald-950">自定义交互音效:</span> 您可以上传专属音频，完全覆盖并自定义史莱姆在不同物理阶段的听觉质感：
                        </p>

                        <div className="space-y-1.5 mt-1.5">
                          {/* 1. Touch sound slot */}
                          <div className="flex flex-col gap-0.5 p-1.5 rounded bg-white/50 border border-emerald-100/35">
                            <div className="flex items-center justify-between">
                              <span className="text-[7.5px] font-bold text-emerald-900">① 点击/初次触碰 (Touch/Click)</span>
                              <span className={`text-[6.5px] px-1 rounded-sm font-semibold uppercase ${customSoundNames.touch ? 'bg-emerald-600 text-white animate-pulse' : 'bg-neutral-100 text-neutral-500'}`}>
                                {customSoundNames.touch ? '已自定义' : '合成默认'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              <label className="flex-1 flex items-center justify-center gap-1 py-1 px-1.5 border border-dashed border-emerald-300 rounded bg-emerald-50/10 hover:bg-emerald-100/30 active:bg-emerald-200/30 cursor-pointer text-[7.5px] text-emerald-800 font-medium transition-all">
                                <Upload className="w-2.5 h-2.5" />
                                {soundLoading.touch ? '正在解析...' : (customSoundNames.touch ? '重新上传' : '上传音频文件')}
                                <input 
                                  type="file" 
                                  accept="audio/*" 
                                  className="hidden" 
                                  onChange={(e) => {
                                    const file = e.target.files?.[0] || null;
                                    handleSoundUpload('touch', file);
                                  }}
                                />
                              </label>
                              {customSoundNames.touch && (
                                <button 
                                  type="button"
                                  onClick={() => handleSoundUpload('touch', null)}
                                  title="恢复合成预设"
                                  className="p-1 text-red-500 hover:text-red-700 bg-red-50 rounded border border-red-150 hover:bg-red-100 transition-all cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                            {customSoundNames.touch && (
                              <p className="text-[6.5px] truncate text-emerald-700 font-mono italic bg-emerald-50/40 px-1 py-0.5 rounded mt-0.5">
                                🎵 {customSoundNames.touch}
                              </p>
                            )}
                          </div>

                          {/* 2. Drag/Move friction sound slot */}
                          <div className="flex flex-col gap-0.5 p-1.5 rounded bg-white/50 border border-emerald-100/35">
                            <div className="flex items-center justify-between">
                              <span className="text-[7.5px] font-bold text-emerald-900">② 移动/刚性挤压 (Drag/Friction)</span>
                              <span className={`text-[6.5px] px-1 rounded-sm font-semibold uppercase ${customSoundNames.drag ? 'bg-emerald-600 text-white animate-pulse' : 'bg-neutral-100 text-neutral-500'}`}>
                                {customSoundNames.drag ? '已定义(循环)' : '合成默认'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              <label className="flex-1 flex items-center justify-center gap-1 py-1 px-1.5 border border-dashed border-emerald-300 rounded bg-emerald-50/10 hover:bg-emerald-100/30 active:bg-emerald-200/30 cursor-pointer text-[7.5px] text-emerald-800 font-medium transition-all">
                                <Upload className="w-2.5 h-2.5" />
                                {soundLoading.drag ? '正在解析...' : (customSoundNames.drag ? '重新上传' : '上传音频文件')}
                                <input 
                                  type="file" 
                                  accept="audio/*" 
                                  className="hidden" 
                                  onChange={(e) => {
                                    const file = e.target.files?.[0] || null;
                                    handleSoundUpload('drag', file);
                                  }}
                                />
                              </label>
                              {customSoundNames.drag && (
                                <button 
                                  type="button"
                                  onClick={() => handleSoundUpload('drag', null)}
                                  title="恢复合成预设"
                                  className="p-1 text-red-500 hover:text-red-700 bg-red-50 rounded border border-red-150 hover:bg-red-100 transition-all cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                            {customSoundNames.drag && (
                              <p className="text-[6.5px] truncate text-emerald-700 font-mono italic bg-emerald-50/40 px-1 py-0.5 rounded mt-0.5">
                                🎵 {customSoundNames.drag} (将随移动速度动态缩放音高与音量)
                              </p>
                            )}
                          </div>

                          {/* 3. Release sound slot */}
                          <div className="flex flex-col gap-0.5 p-1.5 rounded bg-white/50 border border-emerald-100/35">
                            <div className="flex items-center justify-between">
                              <span className="text-[7.5px] font-bold text-emerald-900">③ 松开/反弹回弹 (Release/Snap)</span>
                              <span className={`text-[6.5px] px-1 rounded-sm font-semibold uppercase ${customSoundNames.release ? 'bg-emerald-600 text-white animate-pulse' : 'bg-neutral-100 text-neutral-500'}`}>
                                {customSoundNames.release ? '已自定义' : '合成默认'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              <label className="flex-1 flex items-center justify-center gap-1 py-1 px-1.5 border border-dashed border-emerald-300 rounded bg-emerald-50/10 hover:bg-emerald-100/30 active:bg-emerald-200/30 cursor-pointer text-[7.5px] text-emerald-800 font-medium transition-all">
                                <Upload className="w-2.5 h-2.5" />
                                {soundLoading.release ? '正在解析...' : (customSoundNames.release ? '重新上传' : '上传音频文件')}
                                <input 
                                  type="file" 
                                  accept="audio/*" 
                                  className="hidden" 
                                  onChange={(e) => {
                                    const file = e.target.files?.[0] || null;
                                    handleSoundUpload('release', file);
                                  }}
                                />
                              </label>
                              {customSoundNames.release && (
                                <button 
                                  type="button"
                                  onClick={() => handleSoundUpload('release', null)}
                                  title="恢复合成预设"
                                  className="p-1 text-red-500 hover:text-red-700 bg-red-50 rounded border border-red-150 hover:bg-red-100 transition-all cursor-pointer"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                            {customSoundNames.release && (
                              <p className="text-[6.5px] truncate text-emerald-700 font-mono italic bg-emerald-50/40 px-1 py-0.5 rounded mt-0.5">
                                🎵 {customSoundNames.release}
                              </p>
                            )}
                          </div>
                        </div>

                        <p className="text-[7px] leading-snug text-emerald-900/60 font-sans mt-0.5 bg-white/30 p-1 rounded-sm">
                          ℹ️ 音频加载后将配合史莱姆的刚度和指尖揉捏速度动态变形。刚度(Stiffness)越大，阻抗越大，滤波截止更低沉，回弹音高重。
                        </p>
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {/* STICKER SLIDERS SECTION */}
                  {/* Slider 1: Inflation balloon height */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-neutral-500">
                      <span className="uppercase font-bold">3D Inflation</span>
                      <span className="text-neutral-900 font-bold">{visualConfig.puffiness.toFixed(2)}</span>
                    </div>
                    <input 
                      type="range"
                      min="0.1"
                      max="1.5"
                      step="0.05"
                      value={visualConfig.puffiness}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, puffiness: parseFloat(e.target.value) }))}
                      className="w-full accent-neutral-900 h-1 bg-neutral-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slider 2: Spring Stiffness coefficient */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-neutral-500">
                      <span className="uppercase font-bold">Stiffness</span>
                      <span className="text-neutral-900 font-bold">{visualConfig.stiffness.toFixed(0)} N/m</span>
                    </div>
                    <input 
                      type="range"
                      min="80"
                      max="450"
                      step="10"
                      value={visualConfig.stiffness}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, stiffness: parseFloat(e.target.value) }))}
                      className="w-full accent-neutral-900 h-1 bg-neutral-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slider 3: Spring Damping coefficient */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-neutral-500">
                      <span className="uppercase font-bold">Damping</span>
                      <span className="text-neutral-900 font-bold">{visualConfig.damping.toFixed(1)}</span>
                    </div>
                    <input 
                      type="range"
                      min="2.0"
                      max="26.0"
                      step="0.5"
                      value={visualConfig.damping}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, damping: parseFloat(e.target.value) }))}
                      className="w-full accent-neutral-900 h-1 bg-neutral-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* Slider 4: Grid Cohesion */}
                  <div className="space-y-1">
                    <div className="flex justify-between text-neutral-500">
                      <span className="uppercase font-bold">Grid Cohesion</span>
                      <span className="text-neutral-900 font-bold">{visualConfig.cohesion.toFixed(0)}</span>
                    </div>
                    <input 
                      type="range"
                      min="40"
                      max="350"
                      step="10"
                      value={visualConfig.cohesion}
                      onChange={(e) => setVisualConfig(prev => ({ ...prev, cohesion: parseFloat(e.target.value) }))}
                      className="w-full accent-neutral-900 h-1 bg-neutral-100 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>
                </>
              )}

              {/* Checkbox: Automatic spin orbit */}
              <div className="flex items-center justify-between border-t border-neutral-100 pt-2.5 cursor-pointer">
                <div className="flex items-center gap-2 select-none">
                  <input 
                    type="checkbox"
                    id="auto_spin_orbit"
                    checked={visualConfig.autorotate}
                    onChange={(e) => setVisualConfig(prev => ({ ...prev, autorotate: e.target.checked }))}
                    className="accent-neutral-950 cursor-pointer h-3 w-3 border-neutral-200 rounded"
                  />
                  <label htmlFor="auto_spin_orbit" className="font-bold text-neutral-500 uppercase tracking-wider cursor-pointer">
                    Automatic Rotation Orbit
                  </label>
                </div>
              </div>

            </div>

            {/* Secondary inline separator */}
            <div className="border-t border-neutral-150 my-1" />

            {/* Integrated MediaPipe / Simulator Panel inside sidebar */}
            <div className="flex flex-col gap-2">
              <HandTracker onHandData={setHandData} handData={handData} />
            </div>

          </div>
        )}
      </div>

      {/* 2. CHROME-LESS INTERACTIVE 3D WEBGL CENTERPIECE VIEWPORT (fills entire screen) */}
      <main className="absolute inset-0 w-full h-full z-10">
        <ThreeStage 
          handData={handData}
          visualConfig={visualConfig}
          onSvgUploaded={() => {}}
          heightmapUrl={heightmapUrl}
          diffuseUrl={diffuseUrl}
          imageName={imageName}
          onImageProcessed={handleImageProcessed}
          onClearImage={handleClearImage}
          onVisualConfigChange={setVisualConfig}
        />
      </main>

    </div>
  );
}
