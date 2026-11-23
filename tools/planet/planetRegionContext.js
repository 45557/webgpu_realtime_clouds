import { bakePlanetRegionContext, REGION_CONTEXT_RESOLUTION, updatePlanetRegionContext } from './planetRegion.js';

export async function upgradePlanetRegionContext(device, region, id) {
  const terrain = region.cloudState?.terrain;
  // Old tiles without a saved terrain recipe keep their recorded heights.
  if (!terrain || region.context?.resolution >= REGION_CONTEXT_RESOLUTION) return region;
  const {seed, radius, preset} = region;
  if (terrain.seed !== seed || terrain.radius !== radius || terrain.preset !== preset) return region;

  try {
    const [{bakePlanetRegionFromSeed}, {samplePlanetRegionSurface, warmPlanetRegionSurface}] = await Promise.all([
      import('./planet-approach.esm.js'), import('./planetRegionMaterial.js'),
    ]);
    const context = await bakePlanetRegionFromSeed(device, terrain,
      world => bakePlanetRegionContext(world, region.direction, region.span, samplePlanetRegionSurface),
      warmPlanetRegionSurface);
    if (id) {
      void updatePlanetRegionContext(id, context).catch(error =>
        console.warn('Could not cache the refined planet surroundings', error));
    }
    return {...region, context};
  } catch (error) {
    console.warn('Could not refine the saved planet surroundings', error);
    return region;
  }
}
