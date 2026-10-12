import * as turf from '@turf/turf';
import polyline from 'polyline';
import { getRouteGeometry } from '../../../utils/maps.util.js';
const cache=new Map();
export async function leg(a,b) {
  const k=`${a.lat},${a.lon}>${b.lat},${b.lon}`;
  const saved=cache.get(k);if(saved&&Date.now()-saved.at<3600000)return saved.value;
  const r=await getRouteGeometry(a,b);
  const metres=Number(r.distanzaMetri),seconds=Number(r.durata);
  if(!r.polyline||!Number.isFinite(metres)||metres<=0||!Number.isFinite(seconds)||seconds<=0)throw new Error('Routing stradale incompleto');
  const value={metres,seconds,polyline:r.polyline};
  if(cache.size>1000)cache.clear();cache.set(k,{at:Date.now(),value});return value;
}
export async function pianifica(c, nodes) {
  const map=new Map(nodes.map(n=>[Number(n.id),n]));
  const base=[];
  for(let i=0;i<c.nodes.length-1;i++) {
    const a=map.get(c.nodes[i]),b=map.get(c.nodes[i+1]);if(!a||!b)throw new Error('Nodo assente');
    base.push(await leg(a,b));
  }
  const coords=[];
  for(const l of base) {const points=polyline.decode(l.polyline);coords.push(...(coords.length?points.slice(1):points));}
  const line=turf.lineString(coords.map(p=>[p[1],p[0]]));
  const mandatory=new Set(c.nodes);
  const snapped=[];
  for(const n of nodes) {
    const p=turf.nearestPointOnLine(line,turf.point([Number(n.lon),Number(n.lat)]),{units:'kilometers'});
    if(Number(p.properties.dist)<=0.03||mandatory.has(Number(n.id))) snapped.push({id:Number(n.id),offset:Number(p.properties.location)});
  }
  snapped.sort((a,b)=>a.offset-b.offset||a.id-b.id);
  const ordered=snapped.map(n=>n.id);
  if(ordered[0]!==c.nodes[0]||ordered.at(-1)!==c.nodes.at(-1))throw new Error('Estremi routing incoerenti');
  let last=-1;for(const id of c.nodes){const i=ordered.indexOf(id);if(i<=last)throw new Error('Ordine nodi incompatibile');last=i;}
  const legs=[];
  for(let i=0;i<ordered.length-1;i++)legs.push(await leg(map.get(ordered[i]),map.get(ordered[i+1])));
  // Limita deviazioni introdotte dalle fermate rispetto al percorso stradale candidato.
  const original=base.reduce((s,l)=>s+l.metres,0),actual=legs.reduce((s,l)=>s+l.metres,0);
  if(actual>original*1.15+500)throw new Error('Fermate intermedie introducono deviazione eccessiva');
  return {nodes:ordered,legs,classe:c.classe};
}
