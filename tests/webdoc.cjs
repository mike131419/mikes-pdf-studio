const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fam = process.argv[2], out = process.argv[3];
(async () => {
  const b = await chromium.launch(); const p = await b.newPage();
  const rows = [['Product Type','Widget Order'],['Order No','ORD-77812'],['Status','Confirmed'],['Customer','Sample Trading Sdn Bhd'],['Delivery Mode','Courier'],['Warehouse','Penang Hub']];
  require('fs').writeFileSync('/tmp/claude-0/t/webdoc.html', `<html><head><style>
    @font-face{font-family:W;src:url(file:///tmp/claude-0/t/webfonts/${fam}-Regular.ttf);font-weight:400}
    @font-face{font-family:W;src:url(file:///tmp/claude-0/t/webfonts/${fam}-Bold.ttf);font-weight:700}
    body{font-family:W;padding:30px;color:#3a3a4a} td{padding:9px 0;font-size:17px} td.k{font-weight:700;width:300px;color:#1d1d2b} h2{font-size:22px;margin:4px 0}
  </style></head><body><div style="float:right;color:#777">Printed: 1 Oct 2026 10:00</div><p style="font-size:18px">Order No. : ORD-77812<br><br>Tracking No. : 55821</p><br>
  <h2>Order Approval</h2><h2>Order Details</h2><table>${rows.map(([k,v])=>`<tr><td class=k>${k}</td><td>${v}</td></tr>`).join('')}</table></body></html>`);
  await p.goto('file:///tmp/claude-0/t/webdoc.html'); await p.waitForTimeout(800);
  await p.pdf({ path: out, format: 'A4', printBackground: true }); await b.close();
})();
