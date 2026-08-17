import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const REGION = 'auto';
const SERVICE = 's3';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function signPut({ accessKeyId, secretAccessKey, endpoint, bucket, key, contentType, payloadHash, now = new Date() }) {
  const host = new URL(endpoint).host;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const datestamp = amzDate.slice(0, 8);
  const uri = '/' + [bucket, ...key.split('/')].map(enc).join('/');
  const canonicalHeaders =
    'content-type:' + contentType + '\n' +
    'host:' + host + '\n' +
    'x-amz-content-sha256:' + payloadHash + '\n' +
    'x-amz-date:' + amzDate + '\n';
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', uri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${datestamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, datestamp), REGION), SERVICE), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  return { amzDate, payloadHash, signature, signedHeaders, scope, uri, host };
}

export async function uploadAudio(filePath, { publicId, folder } = {}) {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE;
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket || !publicBase) {
    throw new Error('R2 env missing');
  }
  if (!publicId) throw new Error('publicId required');
  const key = (folder ? folder + '/' : '') + publicId + '.mp3';
  const buf = await readFile(filePath);
  const payloadHash = sha256(buf);
  const { amzDate, signature, signedHeaders, scope, uri } =
    signPut({ accessKeyId, secretAccessKey, endpoint, bucket, key, contentType: 'audio/mpeg', payloadHash });
  const res = await fetch(endpoint + uri, {
    method: 'PUT',
    headers: {
      'content-type': 'audio/mpeg',
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    },
    body: buf
  });
  if (!res.ok) throw new Error('r2 upload failed: ' + res.status + ' ' + (await res.text()));
  return publicBase.replace(/\/+$/, '') + '/' + key;
}

export async function uploadMedia(filePath, { key, contentType }) {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT;
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE;
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket || !publicBase) {
    throw new Error('R2 env missing');
  }
  if (!key) throw new Error('key required');
  const buf = await readFile(filePath);
  const payloadHash = sha256(buf);
  const { amzDate, signature, signedHeaders, scope, uri } =
    signPut({ accessKeyId, secretAccessKey, endpoint, bucket, key, contentType, payloadHash });
  const res = await fetch(endpoint + uri, {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'authorization': `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    },
    body: buf
  });
  if (!res.ok) throw new Error('r2 upload failed: ' + res.status + ' ' + (await res.text()));
  return publicBase.replace(/\/+$/, '') + '/' + key;
}
