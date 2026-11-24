# clouds3 engine plan

A plan for turning clouds3 into a small, web-only 3D game engine and editor,
built around the existing WebGPU cloud and terrain renderer.

**Scope rule:** only the basics needed to make a 3D game, plus first-class
volumetric clouds. Export target is the web only. No fancy features (no GI,
no lightmaps, no visual scripting, no particles editor, no mobile/desktop
export, no C#/GDScript).

---

## 0. What the repo gives us today

Findings from reading the `clouds3` branch (read-only):

| Area | What exists | File(s) |
|---|---|---|
| Cloud renderer | `CloudComputeBuilder`: compute raymarch, temporal resolve, compositor. Already takes an external opaque-scene texture (`terrainDepthView`). | `tools/clouds/clouds.js`, `tools/clouds/shaders/*` |
| Planet clouds | Raymarch layer and MC33 mesh layer, both accept a `getTerrainDepth()` callback. | `tools/clouds/planetClouds.js`, `planetCloudSurface.js` |
| Flat terrain | Analytic CPU height function `terrainHeight(x, z)` plus a 289² mesh built from it. | `tools/clouds/cloudTerrainMesh.js` |
| Planet region tiles | A picked planet region is baked (GPU noise, read back once) into a CPU `Float32Array elevations` grid, 1025² over 256 world units, stored in IndexedDB. | `tools/planet/planetRegion.js`, `cloudTerrainMesh.js#createPlanetRegionMesh` |
| Planet mesh | GPU height/normal bake with one `mapAsync` readback, Babylon mesh builder. | `tools/planet/planetGpuMesh.ts` |
| Noise / planet studio | GPU noise compute, erosion, climate, oceans, etc. | `tools/noise/*` |
| Demo "game" | Flight mode: chase camera, aircraft pose, WASD steering, ray-intersected hull inside the cloud march. | `tools/clouds/cloudNavigation.js` |
| Build | tinybuild/esbuild, WGSL imported as text, Node tests with `node --test`. | `tools/build.js`, `tools/clouds/tests` |

Two facts shape the whole plan:

1. **Every terrain the demo renders already has its heights on the CPU.**
   The flat terrain is an analytic function, and planet tiles are a baked
   `Float32Array`. So collision needs no per-frame GPU readback.
2. **The cloud renderer already composites over an external opaque scene.**
   The contract (from `shaders/cloudTerrain.wgsl` and `clouds.js`) is an
   `rgba16float` texture where `rgb` is the lit opaque color and `a` is the
   camera ray distance to the surface (`0` means sky). If our renderer writes
   that texture, clouds correctly hide behind and in front of game objects.

Everything else (scene, entities, meshes, physics, editor) is new code.

---

## 1. Terrain as collision

**Answer: yes. Use CPU heightfield colliders built from the same height data
that builds the render mesh. Do not read the GPU back per frame.**

### Options compared

| Option | Verdict |
|---|---|
| CPU heightfield collider from baked heights | **Use this.** Heights already exist on the CPU. Exact match with the visible mesh if both come from one function. Physics engines handle heightfields cheaply. |
| GPU readback each frame (ray/height queries on GPU, `mapAsync`) | Reject. 1 to 3 frames of latency, stalls, and physics engines can't use it anyway. |
| GPU readback once after an edit | Use only when terrain is changed on the GPU (studio erosion etc.). One `mapAsync` of a 1025² `r32float` is about 4 MB. Then rebuild the CPU collider. The planet bake already does exactly this. |
| Triangle-mesh collider from the render mesh | Fallback for meshes that are not grids (caves, overhangs, imported glTF level geometry). |

### How, per terrain type

- **Flat demo terrain.** Sample `terrainHeight(x, z)` on a uniform grid (for
  example 513² over the 384-unit extent) and build a heightfield collider. The
  render mesh uses a non-uniform axis, so sample fresh rather than reusing its
  vertices. Analytic sampling also gives exact `heightAt(x, z)` for cheap
  gameplay queries (spawn on ground, AI foot placement) without physics.
- **Planet region tile.** The render mesh maps each sample to
  `y = (elevation - min) * (LOCAL_REGION_UNITS / span)` over a 256-unit square
  (`writeRegionGrid` in `cloudTerrainMesh.js`). Pull that mapping into one
  shared function, `regionLocalHeights(region)`, and use it for both the mesh
  and the collider so they can never drift. Water cells are already clamped to
  ocean level in the bake, which makes the sea surface a floor. Add a separate
  water volume (trigger) for swimming later.
- **The surrounding context ring and curvature roll-off.** Not collidable in
  v1. Players stay inside the 256-unit core tile. Bounds are a gameplay wall.
- **Whole planet (orbit to surface).** Out of scope for v1. Later: stream
  region tiles under the player as heightfield colliders in a local tangent
  frame, and use a sphere of `radius + min height` as a safety floor.

Note for the physics engine (Rapier, section 4): its heightfield takes a
column-major height array and a total-size scale vector. We store row-major
grids, so transpose once when building the collider. Check the exact
`ColliderDesc.heightfield` signature for the pinned Rapier version.

---

## 2. Entity component system

### Design

A small in-house ECS, not a library. The editor needs reflection (field names,
types, ranges) for the inspector and for JSON save/load, and libraries like
bitECS store components as raw typed arrays without that. Our scenes are
small (hundreds to low thousands of entities), so simplicity beats raw speed.

```text
World
  entities: id -> { alive, generation }
  components: name -> Map<entityId, data>       (sparse set is fine later)
  systems: ordered list, each with a query and update(world, dt)
  resources: singletons (time, input, physics world, renderer, environment)
```

- **Entity**: an integer id plus a generation counter. Every entity also has a
  stable `uuid` string for scene files and references.
- **Component**: a registered type with a schema. The schema drives the
  inspector, serialization, defaults and validation.

  ```js
  defineComponent('Transform', {
    position: { type: 'vec3', default: [0, 0, 0] },
    rotation: { type: 'quat', default: [0, 0, 0, 1] },
    scale:    { type: 'vec3', default: [1, 1, 1] },
  });
  ```

  Field types: `number`, `int`, `bool`, `string`, `enum`, `vec2`, `vec3`,
  `quat`, `color`, `asset` (by asset path), `entity` (by uuid).
- **Query**: `world.query('Transform', 'MeshRenderer')` returns a cached list,
  invalidated on add/remove.
- **System**: a plain object `{ name, query, update(world, dt) }` with a fixed
  order. Physics runs in a fixed-step loop (60 Hz with accumulator), rendering
  runs once per animation frame.
- **Hierarchy**: a `Parent` component (parent uuid) plus a derived child list.
  A `TransformSystem` computes `WorldMatrix` top-down. This is what lets the
  editor show a Godot-style scene tree on top of an ECS.

### Core components for v1

| Component | Purpose | Godot equivalent |
|---|---|---|
| `Name` | Label in the scene tree | node name |
| `Transform`, `Parent` | Local TRS, hierarchy | `Node3D` |
| `MeshRenderer` | glTF mesh + material refs | `MeshInstance3D` |
| `Camera` | fov, near, far, `active` | `Camera3D` |
| `DirectionalLight` | Sun direction/color. Also drives the cloud sun. | `DirectionalLight3D` |
| `PointLight` | Small local lights (cap 16 in v1) | `OmniLight3D` |
| `Terrain` | Source (`flat` / `planet-region` id), drives mesh, collider and cloud terrain mode | (Terrain3D plugin) |
| `CloudLayer` | Cloud preset + overrides (see section 6) | `WorldEnvironment` |
| `RigidBody` | `dynamic` / `kinematic` / `static`, mass, damping | `RigidBody3D`, `StaticBody3D`, `AnimatableBody3D` |
| `Collider` | `box`, `sphere`, `capsule`, `mesh`, `heightfield`, `isTrigger` | `CollisionShape3D`, `Area3D` |
| `CharacterController` | Capsule, slope limit, step height, snap to ground | `CharacterBody3D` |
| `Script` | Path to a JS module and its exported params | attached script |
| `AudioSource` | Clip, volume, loop, 3D or 2D | `AudioStreamPlayer3D` |

### Scripting

Gameplay code is plain ES modules attached through `Script`. A script module
exports a schema for inspector-editable params and lifecycle hooks:

```js
export const params = { speed: { type: 'number', default: 6 } };
export function start(ctx) {}
export function update(ctx, dt) {
  const move = ctx.input.axis2('move');           // WASD / stick
  ctx.character.move([move.x * ctx.params.speed, 0, move.y * ctx.params.speed], dt);
}
export function onCollision(ctx, other) {}
```

`ctx` gives the entity, its components, `world`, `input`, `physics.raycast`,
`terrain.heightAt`, `spawn(prefab)`, `destroy()` and an event bus (our
version of Godot signals).

---

## 3. Asset import (glTF)

**Format: glTF 2.0 (`.glb` and `.gltf`) only for 3D.** It is the web
standard and what Godot recommends. Images: PNG, JPEG, WebP, KTX2 later.
Audio: OGG/MP3/WAV through Web Audio.

### Loader

- Parse with `@gltf-transform/core` (`WebIO`), which handles glb/gltf, buffers
  and extensions. Writing our own parser is possible but not worth it.
- Upload to WebGPU ourselves: one vertex/index buffer per primitive, textures
  through `createImageBitmap` + `copyExternalImageToTexture`, mipmaps by a small
  compute or blit pass.
- **v1 support:** static meshes, node hierarchy (becomes entities with
  `Transform` + `Parent`), metallic-roughness PBR (base color, normal,
  metallic-roughness, emissive, alpha mask/blend), `KHR_texture_transform`,
  `KHR_materials_emissive_strength`.
- **v1.1:** skinning and animation clips (`AnimationPlayer` component, linear
  and step interpolation, one clip at a time with crossfade).
- **Later, optional:** Draco/meshopt compression decoders, KTX2/Basis.

### Import flow (modeled on Godot's import dock)

1. Drag files into the editor's Files panel (or pick a project folder).
2. The importer writes an `.import.json` sidecar with settings (scale,
   generate collider: none / convex / trimesh, import as prefab or mesh).
3. Imported assets are cached in IndexedDB keyed by content hash, so
   reloading the editor does not reparse.
4. Dropping a `.glb` into the viewport or scene tree instantiates it as a
   prefab (an entity subtree).

---

## 4. Physics and collision in the browser

**Recommendation: Rapier (`@dimforge/rapier3d-compat`).**

| Engine | Why / why not |
|---|---|
| **Rapier** (Rust to WASM) | Heightfield, trimesh, convex hull, capsule colliders. Built-in kinematic character controller (slopes, steps, ground snap). Raycasts and shape casts. Deterministic option. The `-compat` build embeds the WASM, so it bundles with esbuild without extra loader setup. About 1.5 MB to 2 MB. Actively maintained. |
| Jolt (`jolt-physics` WASM) | Very good and what Godot 4.4+ ships as an option, but the JS bindings are lower level and need manual memory management. Second choice. |
| cannon-es / ammo.js | Older, weaker heightfield and character support. Skip. |
| Custom | Only for the heightfield `heightAt` helper. Not for general physics. |

Integration:

- `PhysicsSystem` owns the Rapier world as a resource. On component add it
  creates bodies/colliders, on remove it frees them.
- Fixed step at 60 Hz. Kinematic and character bodies are written from
  `Transform` before the step. Dynamic bodies write back to `Transform` after.
- Collision and trigger events from Rapier's event queue become `onCollision`
  / `onTriggerEnter` / `onTriggerExit` script calls.
- `physics.raycast(origin, dir, maxDist, mask)` is exposed to scripts and the
  editor (click picking against colliders, then fall back to mesh bounds).
- Collision layers and masks: 16 named layers in project settings, like Godot.

---

## 5. Minimal editor

### What "basic Godot" means

From Godot's source tree (`editor/docks/`, `editor/scene/3d/`, `scene/3d/`,
`scene/3d/physics/`), the essentials are:

| Godot feature | Source | clouds3 v1 |
|---|---|---|
| Scene tree dock (add, delete, rename, reparent, duplicate) | `editor/docks/scene_tree_dock.cpp` | **Yes** |
| Inspector dock (edit node properties) | `editor/docks/inspector_dock.cpp`, `editor/inspector/` | **Yes**, schema-driven |
| FileSystem dock (project files, drag into scene) | `editor/docks/filesystem_dock.cpp` | **Yes**, simple list/tree |
| Import dock (per-asset import settings) | `editor/docks/import_dock.cpp`, `editor/import/3d/` | **Yes**, minimal |
| 3D viewport with move/rotate/scale gizmos, grid, fly camera | `editor/scene/3d/node_3d_editor_plugin.cpp`, `node_3d_editor_viewport.cpp`, `gizmos/` | **Yes** |
| Undo/redo | `editor/editor_undo_redo_manager.cpp` | **Yes**, command stack |
| Play / stop the running scene | `editor/run/` | **Yes**, in-page |
| Output / log panel | `editor/editor_log.cpp` | **Yes** |
| Scenes saved as files, instanced inside other scenes | `.tscn`, `PackedScene` | **Yes**, JSON scenes + prefabs |
| Project settings (input map, physics layers, main scene) | `editor/settings/` | **Yes**, minimal |
| Export (web template) | `editor/export/`, `platform/web/` | **Yes**, web only |
| Script editor | `editor/script/` | **No**. Edit JS in your own editor, hot reload. |
| Signals dock, groups dock, history dock | `editor/docks/signals_dock.cpp` etc. | Later. Groups map to a `Tags` component. |
| Animation editor, shader editor, debugger, asset library, version control, GI/lightmaps, navigation, particles, skeleton IK | various | **No** |

### Layout

```text
+-----------------------------------------------------------+
| Menu: Scene | Edit | Project        [Play] [Stop]  Export |
+-----------+-----------------------------------+-----------+
| Scene     |                                   | Inspector |
| tree      |        3D viewport                |           |
|           |  (engine renderer + clouds,       | Transform |
|-----------|   gizmos, grid, selection)        | Mesh...   |
| Files     |                                   | [+ Add    |
|           |                                   | component]|
+-----------+-----------------------------------+-----------+
| Output / log                                              |
+-----------------------------------------------------------+
```

Plain DOM UI, reusing the existing `cloudLabUi.js` theme. No UI framework is
needed for this size. The cloud preset panels from the current demo
(`planetStudioPanel.js`, `cloudLabUi.js`) become the inspector for the
`CloudLayer` component instead of a separate sidebar.

### Scene file format

```json
{
  "format": "clouds3-scene",
  "version": 1,
  "entities": [
    { "uuid": "a1", "components": {
      "Name": { "value": "Player" },
      "Transform": { "position": [0, 12, 0], "rotation": [0,0,0,1], "scale": [1,1,1] },
      "CharacterController": { "radius": 0.4, "height": 1.8 },
      "Script": { "path": "scripts/player.js", "params": { "speed": 6 } }
    }},
    { "uuid": "b2", "prefab": "assets/tree.glb", "overrides": { "Transform": { "position": [4, 0, 9] } } }
  ]
}
```

Stable uuids, only non-default fields written, prefab instances store
overrides only (same idea as Godot's instanced scenes).

### Project storage

Use the File System Access API ("Open project folder") so the project is real
files on disk that can be committed to git. Fall back to the browser's Origin
Private File System when the API is unavailable. WebGPU already limits us to
Chromium-class browsers, which support both.

### Play mode

Play serializes the current scene to JSON, starts the scripts and physics on
it, and Stop restores the saved JSON. That is simpler than Godot's separate
process and avoids "my edits during play were lost" surprises, because
editing is locked while playing.

---

## 6. Clouds as a first-class renderer feature

### Frame order

```text
1. Opaque pass (engine)     -> rgba16float "scene" texture: rgb color, a = ray distance
                               + depth32float (reverse Z, compare 'greater', like clouds.js)
2. Cloud compute            -> CloudComputeBuilder with terrainDepthView = scene texture
3. Cloud composite          -> clouds over scene, sky where a = 0
4. Transparent pass         -> alpha-blended glTF materials, tested against depth
5. UI / editor overlay      -> gizmos, grid, selection outline (editor only)
```

Step 1 is the key integration. The engine renderer must write linear ray
distance into the alpha channel of the opaque color target, exactly like the
existing terrain pass in `clouds.js` (`mountain-color-distance` texture). Then
the existing cloud march already truncates at objects and the compositor
already blends correctly. No cloud shader changes are needed for v1.

### Ownership

- One `GPUDevice` shared by the engine renderer and `CloudComputeBuilder`.
- `CloudRenderSystem` reads the active `Camera` and calls
  `setViewFromCamera`, reads `DirectionalLight` and calls `setLight`, and reads
  the `CloudLayer` component and calls `setParams` / `setTuning` / `setBox` /
  weather preset helpers only when values change.
- `CloudLayer` fields: `mode` (`flat` / `planet`), `preset` (names from
  `cloudLookPresets.js` and `planetCloudStyles.js`), `weatherCycle` on/off,
  `timeOfDay`, `coverage`, `density`, `wind`, `box` (center/half),
  `quality` (maps to `cloudFieldQuality.js` presets and render-scale divider).
- The terrain renderer in `clouds.js` (`_encodeTerrainPass`) stays the visual
  source for the `Terrain` component in v1. The engine passes its own scene
  texture only when there are game objects. Longer term, move terrain drawing
  into the engine's opaque pass so terrain and game objects share one depth
  buffer. Until then, the engine draws objects into the same target after the
  terrain pass (needs a small hook in `clouds.js` to expose the terrain color
  and depth attachments instead of discarding depth).
- Cloud shadows on objects: sample the existing cloud shadow/transmittance
  field in the object material (phase 3, optional).

### Main thread versus worker

The current flat demo renders in a worker (`cloudTest.worker.js`). The engine
v1 renders on the main thread: WebGPU work is asynchronous, and keeping the
ECS, physics, editor and renderer in one thread removes a whole RPC layer.
Moving the runtime into a worker with `OffscreenCanvas` stays possible later
because the scene is plain JSON.

### Renderer scope (engine side)

Forward renderer, small on purpose: one directional light with a single
cascaded or fitted shadow map (reuse the fitting idea from
`regionShadowProjection`), up to 16 point lights, PBR metallic-roughness,
sky color from the existing `sceneSkyLighting.wgsl` / atmosphere colors,
frustum culling by bounding sphere, and a simple tonemap matching the cloud
compositor's HDR output. Math with `wgpu-matrix` (WebGPU clip space).

---

## 7. Export to web

Because the runtime is already a web bundle, export is a copy:

```text
export/
  index.html          minimal page, canvas, loading bar
  runtime.js          prebuilt engine runtime (no editor code)
  project.json        main scene, input map, physics layers
  scenes/*.json
  assets/...          glb, textures, audio as imported
  scripts/...         user script modules, bundled with esbuild-wasm or copied as ES modules
```

The editor produces a `.zip` download (with `fflate`) or writes into a chosen
folder. The result runs on any static host (Netlify, like the current demo).
The runtime checks for WebGPU and shows a clear message when it is missing.

---

## 8. Phased roadmap

### Milestone 1: "Walk under the clouds" (smallest useful thing)

A runtime-only page, `index.html?demo=game`, with no editor yet:

- ECS core (world, components with schemas, queries, systems, hierarchy).
- Flat terrain entity with Rapier heightfield collider from `terrainHeight`.
- Capsule player with Rapier character controller, third-person camera,
  WASD + mouse, jump.
- One glTF model loaded and placed (static mesh, base color + normal).
- Opaque pass writes the color + distance texture, clouds composite over it,
  the player can stand behind and inside clouds correctly.
- Scene loaded from a hand-written JSON file.
- Node tests for ECS, serialization round trip and the heightfield mapping
  (no GPU needed).

Done means: you can walk across the mountains, the clouds render over and
behind you, and the scene comes from JSON.

### Milestone 2: Editor v1

Scene tree, inspector (schema-driven), viewport with fly camera, selection and
translate/rotate/scale gizmos, undo/redo, Files panel with glTF drag and drop,
save/load scene JSON to a project folder, play/stop, output log.

### Milestone 3: Gameplay basics

Rigid bodies and colliders in the inspector, triggers, raycasts, collision
events to scripts, JS scripts with hot reload, input map in project settings,
Web Audio sources, HTML overlay UI for HUD, prefabs (scene instancing).

### Milestone 4: Planet tiles and export

`Terrain` component pointing at a saved planet region (from the existing
region picker), shared mesh/collider height mapping, `CloudLayer` in `planet`
mode, web export to zip.

### Milestone 5: Polish (only if needed)

Skinned meshes and animation clips, directional shadow map, cloud shadows on
objects, terrain moved into the engine opaque pass, KTX2 textures.

### Proposed code layout

```text
engine/
  ecs/          world.js, component.js, query.js, schema.js
  core/         loop.js, input.js, time.js, events.js, assets.js
  render/       renderer.js, mesh.js, material.js, shaders/*.wgsl, cloudBridge.js
  physics/      rapierWorld.js, heightfield.js, character.js
  gltf/         loadGltf.js, upload.js
  scene/        serialize.js, prefab.js
  runtime.js    entry used by exported games
editor/
  editor.js, sceneTree.js, inspector.js, files.js, viewport.js, gizmos.js,
  undo.js, playMode.js, export.js
```

`tools/clouds`, `tools/noise`, `tools/planet` stay where they are and are
imported by `engine/render/cloudBridge.js` and the `Terrain` system.

### New dependencies

| Package | Purpose |
|---|---|
| `@dimforge/rapier3d-compat` | Physics |
| `@gltf-transform/core` | glTF parsing |
| `wgpu-matrix` | Math |
| `fflate` | Export zip |

---

## 9. Open questions

1. **Which world is the game in first:** the flat mountain basin, a saved
   planet region tile, or the full orbit-to-surface planet? The plan assumes
   flat basin first, then planet tiles. Full planet collision is the biggest
   jump in scope.
2. **JavaScript or TypeScript** for the engine? The repo is mostly JS with a
   few TS files. The plan assumes JS with JSDoc types.
3. **Game scripts as plain JS modules** (edited in your own code editor) is
   the plan. Is an in-editor code editor wanted?
4. **Rapier** adds about 1.5 MB to 2 MB of WASM to every exported game. OK?
5. **Where the editor lives:** same repo and page (`?editor`) as the cloud
   demos, or a separate entry? The plan assumes a separate `editor.html` in
   this repo.
