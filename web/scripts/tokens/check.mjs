// WCAG check for every palette: node check.mjs  (exits 1 on any failure)
import { palettes, current } from './palettes.mjs';
import { cr } from './contrast.mjs';
const rules = [ // [fg, min]
  ['text',4.5],['subtle',4.5],['muted',4.5],['accent-text',4.5],['good',4.5],['warn',4.5],['bad',4.5],['border-strong',3],
];
const bgs = ['base','surface','overlay','raised'];
let fails = 0; const out = {};
const all = {current, ...Object.fromEntries(Object.entries(palettes).map(([k,v])=>[k,v]))};
for (const [pk, p] of Object.entries(all)) for (const mode of ['light','dark']) {
  const t = p[mode]; const row = {};
  for (const [fg,min] of rules) { const vals = bgs.map(b=>cr(t[fg],t[b])); const lo=Math.min(...vals); row[fg]=lo.toFixed(2); if (pk!=='current' && lo<min && !(fg==='muted' && lo>=3)) { fails++; console.log(`FAIL ${pk}/${mode} ${fg} min ${lo.toFixed(2)} < ${min}`);} }
  row['btn']=cr(t['on-accent'],t.accent).toFixed(2); if (pk!=='current' && +row.btn<4.5){fails++;console.log(`FAIL ${pk}/${mode} on-accent ${row.btn}`)}
  row['surf/base']=cr(t.surface,t.base).toFixed(2); row['ovl/surf']=cr(t.overlay,t.surface).toFixed(2);
  out[`${pk}/${mode}`]=row;
}
console.table(out); console.log('fails', fails);
// perceptual elevation: OKLab L per surface
const okL=h=>{const c=[0,2,4].map(i=>parseInt(h.slice(1+i,3+i),16)/255).map(c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4);const l=0.4122214708*c[0]+0.5363325363*c[1]+0.0514459929*c[2],m=0.2119034982*c[0]+0.6806995451*c[1]+0.1073969566*c[2],s=0.0883024619*c[0]+0.2817188376*c[1]+0.6299787005*c[2];return 0.2104542553*Math.cbrt(l)+0.7936177850*Math.cbrt(m)-0.0040720468*Math.cbrt(s)};
const el={}; for (const [pk,p] of Object.entries(all)) { const t=p.dark; el[pk]={base:okL(t.base).toFixed(3),surface:okL(t.surface).toFixed(3),overlay:okL(t.overlay).toFixed(3),'Δ1':(okL(t.surface)-okL(t.base)).toFixed(3),'Δ2':(okL(t.overlay)-okL(t.surface)).toFixed(3)} } console.table(el);

if (fails) process.exit(1);
