# clouds3 engine (milestone 1)

A small web-only 3D game runtime built around the WebGPU cloud renderer.
See [docs/ENGINE_PLAN.md](../docs/ENGINE_PLAN.md) for the full plan.

## Run the walk demo

```bash
npm install
npm run build
npm run serve        # or: python -m http.server 8080
```

Open `http://localhost:8082/?demo=game` (or port 8080 with the Python server).
The demo is also listed as **Walk demo (engine)** in the cloud demo switcher.

- Click the view to capture the mouse, then move the mouse to look around.
- WASD or arrow keys move, Shift sprints, Space jumps, the wheel zooms.
- Walk into the crates to push them. Trees and rocks are solid.

URL options:

| Option | Effect |
|---|---|
| `&clouds=0` | Fast renderer without clouds (simple sky and fog). |
| `&lowclouds` | Smaller cloud noise textures for slow GPUs. |
| `&frames=N` | Stop after N frames (tests). |
| `&offscreen` | Render into a readable texture; `engine.capture()` returns a PNG data URL (tests). |

## Tests

```bash
npm run test:engine
```

Covers the ECS, scene JSON round trip, parent/child transforms, the heightfield
layout handed to Rapier, terrain collision against the visible basin mesh, the
character controller and dynamic bodies. No GPU needed.

`npm run engine:assets` regenerates `assets/engine/*.glb` and
`engine/demo/walk-scene.json`.

## Layout

```text
engine/
  engine.js              Engine: device, loop (fixed 60 Hz physics), scene loading, rendering
  ecs/world.js           Entities, schema-described components, cached queries, hierarchy, events
  core/components.js     Core components (Transform, MeshRenderer, Camera, CloudLayer, RigidBody, ...)
  core/transformSystem.js World matrices, parents first
  core/scripts.js        Script components (start / fixedUpdate / update / onCollision)
  core/input.js          Keyboard, mouse look with pointer lock
  core/math.js           Vectors, quaternions, column-major matrices
  physics/physics.js     Rapier bridge: terrain collider, bodies, character controller, raycasts
  physics/heightfield.js Uniform height grids and Rapier's heightfield layout (for planet tiles)
  gltf/loadGltf.js       glTF / GLB import (static meshes, base color, textures, vertex colors)
  render/meshRenderer.js Mesh pass + standalone renderer
  render/cloudBridge.js  Noise bake + CloudComputeBuilder driving; engine meshes drawn in its terrain pass
  scene/serialize.js     Scene JSON save/load
  demo/                  Walk demo: scene JSON, player and follow-camera scripts
  tests/                 Node tests
```

## How clouds and meshes combine

The cloud renderer already rasterizes the basin terrain into an `rgba16float`
target (`rgb` = lit color, `a` = ray distance) with a reverse-Z `depth32float`
buffer, and its raymarch and compositor read that target. `clouds.js` now calls
`sceneDrawHook(pass)` inside that pass, and the engine draws its meshes there
with a pipeline that uses the same targets and projection. Clouds therefore stop
at, and composite over, game objects with no cloud shader changes.

## Coordinates and units

+Y up, the camera looks along +Z, +X is right (same as the cloud demos). glTF
files are mirrored on X when imported, so models keep facing +Z. The basin floor
is at y = -6, the cloud deck starts about 12 units above it, and the player is
1.6 units tall.

## Known limits (milestone 1)

- Terrain is the flat demo basin only. Planet tiles come in milestone 4.
- No shadows on engine meshes yet, no normal maps, no skinning or animation.
- Scripts are registered in code (`registerScript`). The in-editor code editor
  and project files come with the editor in milestone 2.
