// Mock of Google Fonts that only serves WOFF2 (like the real one does today) + a Fontsource CDN serving WOFF.
const http = require('http'), fs = require('fs'), url = require('url');
const log = [];
http.createServer((req, res) => {
  const u = url.parse(req.url, true); log.push(req.url);
  if (u.pathname === '/css2' || u.pathname === '/css') {
    const fam = String(u.query.family || '').split(':')[0];
    if (fam !== 'Carlito') { res.writeHead(400); return res.end('bad'); }
    res.writeHead(200); return res.end(`/* latin */\n@font-face { font-family: '${fam}'; src: url(http://127.0.0.1:8767/x.woff2) format('woff2'); }`);
  }
  const m = /^\/npm\/@fontsource\/carlito@5\/files\/(carlito-latin-(\d+)-normal\.woff)$/.exec(u.pathname);
  if (m && fs.existsSync('/tmp/claude-0/t/webfonts/' + m[1])) { res.writeHead(200); return res.end(fs.readFileSync('/tmp/claude-0/t/webfonts/' + m[1])); }
  if (u.pathname === '/log') return res.end(JSON.stringify(log));
  res.writeHead(404); res.end();
}).listen(8767, () => console.log('mock2 up'));
