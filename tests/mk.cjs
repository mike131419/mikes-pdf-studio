const {PDFDocument, StandardFonts, rgb, degrees} = require('/home/claude/.npm-global/lib/node_modules/pdf-lib');
const fs=require('fs');
(async()=>{
 const a=await PDFDocument.create(); const f=await a.embedFont(StandardFonts.Helvetica);
 for(let i=1;i<=3;i++){ const p=a.addPage([595,842]); p.drawText('Document A - page '+i,{x:50,y:780,size:28,font:f});
   p.drawRectangle({x:50,y:50,width:100,height:60,color:rgb(0.2,0.4,0.9)}); p.drawText('bottom-left marker',{x:50,y:30,size:12,font:f});
   if(i===2) p.setRotation(degrees(90)); }
 fs.writeFileSync('A.pdf', await a.save());
 const b=await PDFDocument.create(); const g=await b.embedFont(StandardFonts.TimesRoman);
 for(let i=1;i<=2;i++){ const p=b.addPage([842,595]); p.drawText('Landscape B - page '+i,{x:60,y:520,size:30,font:g}); }
 fs.writeFileSync('B.pdf', await b.save());
})();
