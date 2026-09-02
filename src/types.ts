/**
 * Hand tracking parameters mapped from MediaPipe to VFX.
 */
export interface HandData {
  x: number;          // Normalized -1 (left) to 1 (right)
  y: number;          // Normalized -1 (bottom) to 1 (top)
  distance: number;   // Palm distance (0 to 1), representing hand scale/nearness
  roll: number;       // Roll/tilt angle of hand in radians
  pinch: number;      // Pinch strength (0 to 1) between index and thumb
  spread: number;     // Finger spread factor (0 to 1)
  active: boolean;    // Is hand tracking in frame
  isWebcam?: boolean; // Whether the user is actively using the real webcam
  hands?: HandData[]; // Individual hands data for multi-hand gesturing
  skeletonPoints?: { x: number; y: number }[]; // Normalized coordinate points ([0..1])
}

/**
 * 3D visual configuration parameters.
 */
export interface VisualConfig {
  puffiness: number;      // Z displacement depth
  twist: number;          // Twist distortion factor
  meshDensity: number;    // Subdivisions of plain grid
  noiseStrength: number;  // Dynamic fractal noise deformation
  noiseFreq: number;      // Frequency of noise waves
  colorShift: number;     // Iridescent/Holographic hues
  autorotate: boolean;    // Automatic spin without hand controls
  materialType: 'holo' | 'chrome' | 'gold' | 'ceramic' | 'glow';
  speed: number;          // Time-based wave speeds
  glowIntensity: number; // Bloom effect mapping
  stiffness: number;     // Physics spring stiffness coefficient
  damping: number;       // Physics spring damping coefficient
  cohesion: number;      // Physics neighbor link cohesion coefficient
  interactionMode?: 'sticker' | 'slime'; // Sticker (elastic) vs Slime (plastic, smearable)
  maxStrainDistMultiplier?: number; // Physics slime strain boundary limit coefficient
  bulgeStrength?: number;           // Physics slime compression upward bulge Z height
  plasticity?: number;              // Physics slime permanent memory retention factor
  soundEnabled?: boolean;           // Toggle interactive squish sounds
  imageScale?: number;              // Dynamic wheel zoom magnification factor
}

/**
 * Log message format representing active OSC/TouchDesigner logs.
 */
export interface DeveloperLog {
  id: string;
  timestamp: string;
  address: string;
  type: string;
  value: string;
}
