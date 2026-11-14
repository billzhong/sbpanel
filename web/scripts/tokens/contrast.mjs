const hex=h=>{h=h.replace('#','');return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255)};
const lin=c=>c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
const L=h=>{const [r,g,b]=hex(h).map(lin);return 0.2126*r+0.7152*g+0.0722*b};
export const cr=(a,b)=>{const x=L(a),y=L(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
export function table(name,t,fgs,bgs){const rows=[];for(const f of fgs)for(const b of bgs)rows.push([name,f,b,cr(t[f],t[b]).toFixed(2)]);return rows}
if (process.argv[2]) { const t=JSON.parse(process.argv[2]); const fg=process.argv[3].split(','), bg=process.argv[4].split(',');
 for (const r of table('',t,fg,bg)) console.log(r.slice(1).join('\t')); }
