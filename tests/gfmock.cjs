const http = require('http'), fs = require('fs'), url = require('url');
const FILES = { 'Carlito|0|400': '/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf', 'Carlito|0|700': '/usr/share/fonts/truetype/crosextra/Carlito-Bold.ttf' };
const log = [];
http.createServer((req, res) => {
  const u = url.parse(req.url, true); log.push(req.url + ' UA=' + req.headers['user-agent']);
  if (u.pathname === '/css2') {
    const m = /^([^:]+):ital,wght@(\d),(\d+)$/.exec(u.query.family || '');
    const key = m && `${m[1]}|${m[2]}|${m[3]}`;
    if (!m || !FILES[key]) { res.writeHead(400); return res.end('bad family'); }
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(`/* latin-ext */\n@font-face { font-family: '${m[1]}'; src: url(http://127.0.0.1:8765/f/${encodeURIComponent(key)}.ttf) format('truetype'); }\n/* latin */\n@font-face { font-family: '${m[1]}'; font-weight: ${m[3]}; src: url(http://127.0.0.1:8765/f/${encodeURIComponent(key)}.ttf) format('truetype'); }\n`);
  }
  if (u.pathname.startsWith('/f/')) { const key = decodeURIComponent(u.pathname.slice(3, -4)); res.writeHead(200); return res.end(fs.readFileSync(FILES[key])); }
  if (u.pathname === '/log') { res.end(JSON.stringify(log)); return; }
  res.writeHead(404); res.end();
}).listen(8765, () => console.log('mock up'));
