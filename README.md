# PuffyMesh Interactive Canvas

An interactive 3D WebGL experience featuring real-time mesh inflation, tactile deformation physics, and dual-mode interaction (Sticker Mode & Slime Mode) driven by MediaPipe AI hand tracking and direct mouse/touch controls.

---

<table>
  <tr>
    <td align="center"><img height="300" alt="image" src="https://github.com/user-attachments/assets/b9904522-0502-4e52-888b-bf701dad7081?raw=true" /></td>
    <td align="center"><img height="300" alt="image" src="https://github.com/user-attachments/assets/e7146900-b064-4bf2-8c2d-bfb3ec233452?raw=true" /></td>
  </tr>
</table>

---

## ✨ Features

- **3D Mesh Inflation & Surface Displacement**: Real-time heightmap generation and 3D normal extrusion rendered with Three.js.
- **Dual Interaction Modes**:
  - **Sticker Mode**: Elastic spring-back deformation, pinch-to-stretch physics, and tactile drag response.
  - **Slime / Squishy Mode**: Organic color smearing, concentrated fingertip imprint/indentation, and dynamic material displacement with adjustable bulge height.
- **MediaPipe Hand Gesture Tracking**: Multi-finger contact detection and pinch interaction powered by webcam vision.
- **Tactile ASMR Audio**: Procedurally synthesized interactive sound effects reflecting strain, squish, and release.
- **Customizable Assets & Shaders**: Support for custom image uploads, preset sticker textures, dynamic lighting, and material tuning.

## 🚀 Quick Start

### Prerequisites

- Node.js (v18+ recommended)
- npm, yarn, or pnpm

### Installation

```bash
# Clone the repository
git clone https://github.com/<your-username>/<your-repo-name>.git
cd <your-repo-name>

# Install dependencies
npm install
```

### Running Locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) (or the port shown in your terminal) in your browser.

### Building for Production

```bash
npm run build
```

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS
- **3D & Graphics**: Three.js, WebGL, Canvas API
- **Computer Vision**: MediaPipe Hands (`@mediapipe/camera_utils`, `@mediapipe/hands`)
- **Icons & Animation**: Lucide React, Motion

## 📄 License

MIT
