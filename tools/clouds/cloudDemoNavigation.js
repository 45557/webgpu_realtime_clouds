import {installCloudLabTheme} from './cloudLabUi.js';

const CLOUD_DEMOS = new Map([
 ['flat','Flat clouds'],
 ['planet','Planet clouds'],
 ['fluid','Fluid clouds'],
 ['game','Walk demo (engine)'],
]);
const normalizeDemo = demo => CLOUD_DEMOS.has(demo) ? demo : 'flat';

export function selectedCloudDemo(url=window.location.href) {
 const demo=new URL(url).searchParams.get('demo');
 return normalizeDemo(demo);
}
export function cloudDemoUrl(demo,url=window.location.href) {
 const target=new URL(url);target.searchParams.set('demo',normalizeDemo(demo));return target.href;
}
// Full links still release the current scene. The region handoff can change
// the mounted route in place, so history must compare against that route.
let mountedRoute;
const cloudRoute = href => {
 const {pathname,search}=new URL(href);
 return pathname+search;
};
export function watchCloudDemoHistory() {
 mountedRoute=cloudRoute(window.location.href);
 window.addEventListener('popstate',()=>{
  if(cloudRoute(window.location.href)!==mountedRoute) window.location.reload();
 });
}
export function pushCloudDemoRoute(url) {
 window.history.pushState(null,'',url);
 mountedRoute=cloudRoute(window.location.href);
}

// A segmented set of real links (switching demos is a full navigation that
// releases the other scene's GPU resources). The same links can also be
// mounted into an existing demo's control panel.
export function populateCloudDemoNavigation(nav,doc=document,url=window.location.href) {
 nav.setAttribute('aria-label','Cloud demos');
 const current=selectedCloudDemo(url);
 for(const [demo,label] of CLOUD_DEMOS){
  const link=doc.createElement('a');link.textContent=label;link.href=cloudDemoUrl(demo,url);
  if(demo===current){link.setAttribute('aria-current','page');link.addEventListener('click',event=>event.preventDefault());}
  nav.appendChild(link);
 }
 return nav;
}

export function mountCloudDemoNavigation(doc=document,url=window.location.href) {
 installCloudLabTheme(doc);
 const existing=doc.getElementById('cloud-demo-navigation');
 if(existing)return existing;
 const nav=doc.createElement('nav');nav.id='cloud-demo-navigation';
 nav.className='cl-switch cl-switch--floating';
 populateCloudDemoNavigation(nav,doc,url);
 doc.body.appendChild(nav);
 return nav;
}
