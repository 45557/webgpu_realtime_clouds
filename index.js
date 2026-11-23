import { selectedCloudDemo, mountCloudDemoNavigation, watchCloudDemoHistory } from './tools/clouds/cloudDemoNavigation.js';

const demo = selectedCloudDemo();
watchCloudDemoHistory();
if (demo === 'planet') {
  import('./tools/clouds/planetApproachClouds.js').catch(console.error);
} else if (demo === 'fluid') {
  import('./tools/clouds/fluidClouds.js').catch(console.error);
} else {
  mountCloudDemoNavigation();
  import('./tools/clouds/cloudTestThreaded.js').catch(console.error);
}
