import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedCloudDemo,cloudDemoUrl,mountCloudDemoNavigation,pushCloudDemoRoute,watchCloudDemoHistory} from '../cloudDemoNavigation.js';
test('cloud demo navigation defaults to flat and preserves unrelated URL settings',()=>{
 assert.equal(selectedCloudDemo('http://localhost/demo'),'flat');
 assert.equal(selectedCloudDemo('http://localhost/demo?demo=planet'),'planet');
 assert.equal(selectedCloudDemo('http://localhost/demo?demo=fluid'),'fluid');
 assert.equal(cloudDemoUrl('fluid','http://localhost/demo?demo=planet&seed=123'),'http://localhost/demo?demo=fluid&seed=123');
 assert.equal(selectedCloudDemo('http://localhost/demo?demo=invalid'),'flat');
 assert.equal(cloudDemoUrl('planet','http://localhost/demo?seed=123#controls'),'http://localhost/demo?seed=123&demo=planet#controls');
});
test('demo switch uses accessible document links, highlights the active scene and mounts once',()=>{
 const nodes=[];const doc={getElementById:id=>nodes.find(n=>n.id===id),body:{appendChild:n=>nodes.push(n)},createElement:tag=>({tag,style:{},children:[],attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v},appendChild(n){this.children.push(n)},addEventListener(k,v){this.events[k]=v}})};
 mountCloudDemoNavigation(doc,'http://localhost/?demo=planet');mountCloudDemoNavigation(doc,'http://localhost/?demo=planet');
 assert.equal(nodes.length,1);assert.equal(nodes[0].attrs['aria-label'],'Cloud demos');
 assert.equal(nodes[0].children[1].attrs['aria-current'],'page');
 assert.deepEqual(nodes[0].children.map(n=>n.textContent),['Flat clouds','Planet clouds','Fluid clouds']);
 assert.ok(nodes[0].children.every(n=>n.tag==='a'));
 let prevented=false;nodes[0].children[1].events.click({preventDefault(){prevented=true}});assert.equal(prevented,true);
});

test('history remounts the correct demo on Back and Forward after an in-page handoff', () => {
 const planet='http://localhost/?demo=planet';
 const fluid='http://localhost/?demo=fluid&region=tile&view=flight';
 const listeners={};
 let reloads=0;
 const location={href:planet,reload:()=>{reloads++;}};
 const browser={
  location,
  history:{pushState(_state,_title,href){location.href=href;}},
  addEventListener(type,listener){listeners[type]=listener;},
 };
 const previous=globalThis.window;
 globalThis.window=browser;
 try {
  watchCloudDemoHistory();
  pushCloudDemoRoute(fluid);
  assert.equal(location.href,fluid);
  listeners.popstate();
  assert.equal(reloads,0);
  location.href=planet;
  listeners.popstate();
  assert.equal(reloads,1);
  watchCloudDemoHistory(); // Back loaded a new Planet document.
  location.href=fluid;
  listeners.popstate();
  assert.equal(reloads,2);
 } finally {
  if(previous===undefined) delete globalThis.window;
  else globalThis.window=previous;
 }
});
