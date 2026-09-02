export interface SVGAsset {
  id: string;
  name: string;
  svg: string;
  description: string;
}

export const DEFAULT_SVG_ASSETS: SVGAsset[] = [
  {
    id: "star_emblem",
    name: "Retro-Chrome Star",
    description: "Futuristic four-point vector star. Translate to balloon-bloated chrome emblem.",
    svg: `<svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <path d="M 256 30 C 256 160 160 256 30 256 C 160 256 256 352 256 482 C 256 352 352 256 482 256 C 352 256 256 160 256 30 Z" fill="#FFFFFF" />
    </svg>`
  },
  {
    id: "mobius_loop",
    name: "Hyper Loop",
    description: "Sleek nested orbits. Beautiful twisting topology displaying dynamic ribbon depth.",
    svg: `<svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <path d="M 120 256 C 120 170 170 120 256 120 C 342 120 392 170 392 256 C 392 342 342 392 256 392 C 170 392 120 342 120 256 Z M 60 256 C 60 130 130 60 256 60 C 382 60 452 130 452 256 C 452 382 382 452 256 452 C 130 452 60 382 60 256 Z" fill-rule="evenodd" fill="#FFFFFF" />
    </svg>`
  },
  {
    id: "acid_flower",
    name: "Murakami Bloom",
    description: "An organic 8-petaled graphic bloom. Turns into a puffy cloud marshmallow structure.",
    svg: `<svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <path d="M 256 150 C 220 100 290 100 256 150 Z" id="petal" fill="#FFFFFF"/>
      <!-- Combining complex smooth petaled shapes for a flower -->
      <path d="M 256,256 
               C 210,130 302,130 256,256 
               C 382,210 382,302 256,256 
               C 302,382 210,382 256,256 
               C 130,302 130,210 256,256 Z" fill="#FFFFFF"/>
      <path d="M 256,256 
               C 160,160 160,352 256,256 
               C 352,160 352,352 256,256 Z" fill="#FFFFFF"/>
      <circle cx="256" cy="256" r="60" fill="#FFFFFF" />
    </svg>`
  },
  {
    id: "cyber_glyph",
    name: "Alchemist Sign",
    description: "Sharp cybernetic chevron design. Perfect for inspecting high-contrast metallic corners.",
    svg: `<svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <path d="M 256 40 L 440 224 L 380 284 L 256 160 L 132 284 L 72 224 Z M 256 220 L 380 344 L 320 404 L 256 340 L 192 404 L 132 344 Z" fill-rule="evenodd" fill="#FFFFFF"/>
    </svg>`
  },
  {
    id: "smile_bubble",
    name: "Bio Slime Drop",
    description: "A liquid bubble shape. Maps beautifully to high-viscosity hand squishing gestures.",
    svg: `<svg viewBox="0 0 512 512" width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      <path d="M 256 80 C 370 80 432 170 432 270 C 432 370 340 432 256 432 C 172 432 80 370 80 270 C 80 170 142 80 256 80 Z" fill="#FFFFFF" />
    </svg>`
  }
];
