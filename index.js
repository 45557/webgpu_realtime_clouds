import { selectedCloudDemo, mountCloudDemoNavigation, watchCloudDemoHistory } from './tools/clouds/cloudDemoNavigation.js';

const demo = selectedCloudDemo();
watchCloudDemoHistory();
if (new URLSearchParams(location.search).get('demo') === 'game') {
  import('./engine/demo/game.js').catch(console.error);
} else if (demo === 'planet') {
  import('./tools/clouds/planetApproachClouds.js').catch(console.error);
} else if (demo === 'fluid') {
  import('./tools/clouds/fluidClouds.js').catch(console.error);
} else {
  mountCloudDemoNavigation();
  import('./tools/clouds/cloudTestThreaded.js').catch(console.error);
}
