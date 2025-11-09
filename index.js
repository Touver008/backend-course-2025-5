const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const { Command } = require('commander');
const superagent = require('superagent');
const url = require('url');
const { existsSync } = require('fs');

const program = new Command();

program.helpOption(false);

program
  .requiredOption('-h, --host <host>', 'address of the server')
  .requiredOption('-p, --port <port>', 'port of the server', parseInt)
  .requiredOption('-c, --cache <path>', 'path to cache directory');

program.parse(process.argv);
const options = program.opts();

const HOST = options.host;
const PORT = options.port;
const CACHE_DIR = path.resolve(options.cache);

async function ensureCacheDir() {
  try {
    if (!existsSync(CACHE_DIR)) {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      console.log('Created cache dir:', CACHE_DIR);
    }
  } catch (err) {
    console.error('Error creating cache dir:', err);
    process.exit(1);
  }
}

function cacheFilePath(code) {
  return path.join(CACHE_DIR, `${code}.jpg`);
}

function sendError(res, code, message) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message || http.STATUS_CODES[code] || String(code));
}

async function handleRequest(req, res) {
  const parsed = url.parse(req.url || '', true);
  const pathname = decodeURI(parsed.pathname || '/').replace(/^\/+|\/+$/g, '');
  if (!pathname) {
    sendError(res, 400, 'Bad Request: missing code in path, expected /<code>');
    return;
  }
  const code = pathname;

  const filePath = cacheFilePath(code);

  if (req.method === 'GET') {
    try {
      const data = await fs.readFile(filePath);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/jpeg');
      res.end(data);
      console.log(`GET ${code} — from cache`);
    } catch (err) {
      console.log(`GET ${code} — not in cache, fetching from http.cat`);
      try {
        const remoteUrl = `https://http.cat/${encodeURIComponent(code)}`;
        const rsp = await superagent.get(remoteUrl).responseType('blob'); 
        const buffer = rsp.body || rsp;
       
        try {
          await fs.writeFile(filePath, buffer);
          console.log(`Saved ${filePath}`);
        } catch (werr) {
          console.warn('Cannot write to cache:', werr);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(buffer);
      } catch (err2) {
        console.log('Fetch from http.cat failed:', err2.message || err2);
        sendError(res, 404, 'Not Found');
      }
    }
    return;
  }

  if (req.method === 'PUT') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      await fs.writeFile(filePath, body);
      res.statusCode = 201; // Created
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Created');
      console.log(`PUT ${code} — saved to cache`);
    } catch (err) {
      console.error('PUT error writing file:', err);
      sendError(res, 500, 'Internal Server Error');
    }
    return;
  }

  if (req.method === 'DELETE') {
    try {
      await fs.unlink(filePath);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Deleted');
      console.log(`DELETE ${code} — removed from cache`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        sendError(res, 404, 'Not Found');
      } else {
        console.error('DELETE error:', err);
        sendError(res, 500, 'Internal Server Error');
      }
    }
    return;
  }

  sendError(res, 405, 'Method not allowed');
}

async function start() {
  await ensureCacheDir();
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      console.error('Unhandled error handling request:', err);
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`Server listening at http://${HOST}:${PORT}/`);
    console.log('Cache dir:', CACHE_DIR);
  });
}

start().catch(err => {
  console.error('Server start error:', err);
  process.exit(1);
});
