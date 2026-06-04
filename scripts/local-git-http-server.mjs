import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const args = {
    port: 8123,
    mount: '/chat-archive-pack.git',
    repoDir: null,
  };

  for (let index = 2; index < argv.length; index++) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === '--port' && next) {
      args.port = Number(next);
      index++;
      continue;
    }
    if (current === '--mount' && next) {
      args.mount = next.startsWith('/') ? next : `/${next}`;
      index++;
      continue;
    }
    if (current === '--repo' && next) {
      args.repoDir = path.resolve(next);
      index++;
      continue;
    }
  }

  return args;
}

function normalizeMount(mount) {
  return String(mount || '/').replace(/\/+$/, '') || '/';
}

function collectRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseBackendResponse(raw) {
  const text = raw.toString('utf8');
  const headerMatch = text.match(/^(.*?)\r?\n\r?\n/s);
  if (!headerMatch) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: raw,
    };
  }

  const headerText = headerMatch[1];
  const body = raw.subarray(Buffer.byteLength(headerText) + (text.includes('\r\n\r\n') ? 4 : 2));
  const headers = {};
  let statusCode = 200;

  for (const line of headerText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key === 'status') {
      statusCode = Number(value.split(' ')[0]) || 200;
      continue;
    }

    headers[key] = value;
  }

  return { statusCode, headers, body };
}

async function runGitHttpBackend({ repoDir, request, mount }) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const body = request.method === 'GET' || request.method === 'HEAD' ? Buffer.alloc(0) : await collectRequestBody(request);
  const pathInfo = url.pathname.slice(mount.length) || '/';

  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: path.dirname(repoDir),
        GIT_HTTP_EXPORT_ALL: '1',
        GIT_DIR: repoDir,
        REQUEST_METHOD: request.method,
        PATH_INFO: pathInfo.startsWith('/') ? pathInfo : `/${pathInfo}`,
        QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : '',
        CONTENT_TYPE: request.headers['content-type'] || '',
        CONTENT_LENGTH: String(body.length),
        REMOTE_ADDR: request.socket.remoteAddress || '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderrChunks.length) {
        console.warn(Buffer.concat(stderrChunks).toString('utf8'));
      }
      const raw = Buffer.concat(stdoutChunks);
      resolve(parseBackendResponse(raw));
    });
    child.stdin.end(body);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const repoDir = args.repoDir || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const mount = normalizeMount(args.mount);
  const gitDir = path.join(repoDir, '.git');
  await fs.access(gitDir);

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!url.pathname.startsWith(mount)) {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`chat-archive-pack local Git server\nmount: ${mount}\nrepo: ${repoDir}\n`);
        return;
      }

      const backendResult = await runGitHttpBackend({ repoDir: gitDir, request, mount });
      response.writeHead(backendResult.statusCode, backendResult.headers);
      response.end(backendResult.body);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(String(error?.stack || error));
    }
  });

  server.listen(args.port, '127.0.0.1', () => {
    console.log(`Local Git HTTP server ready at http://127.0.0.1:${args.port}${mount}`);
    console.log(`Serving repo: ${repoDir}`);
  });
}

await main();
