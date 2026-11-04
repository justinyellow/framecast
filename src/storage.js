const fs = require('fs');
const { pipeline } = require('stream/promises');
const {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand,
  PutBucketCorsCommand, PutObjectCommand, DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cfSigner = require('@aws-sdk/cloudfront-signer');
const config = require('./config');

// WHEN_REQUIRED: otherwise the SDK bakes a checksum of the (empty) body into presigned part URLs,
// and non-AWS S3 implementations may reject default CRC checksums.
const base = {
  region: config.s3.region,
  forcePathStyle: config.s3.forcePathStyle,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
};
const s3 = new S3Client({ ...base, endpoint: config.s3.endpoint });
// Separate client for presigning so URLs use a browser-reachable host.
const signer = new S3Client({ ...base, endpoint: config.s3.publicEndpoint });
const Bucket = config.s3.bucket;

// Local dev only: create the bucket (with CORS for direct uploads). On AWS, infra owns the bucket.
async function ensureBucket() {
  if (!config.s3.createBucket) return;
  for (let i = 0; ; i++) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket }));
      break;
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound') {
        await s3.send(new CreateBucketCommand({ Bucket }));
        break;
      }
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  await s3.send(new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: [config.publicUrl], AllowedMethods: ['PUT', 'GET'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600,
      }],
    },
  })).catch((e) => console.warn('Could not set bucket CORS:', e.message));
}

async function createMultipart(Key, ContentType) {
  const r = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));
  return r.UploadId;
}

async function uploadPart(Key, UploadId, PartNumber, Body) {
  const r = await s3.send(new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, Body }));
  return r.ETag;
}

const presignPart = (Key, UploadId, PartNumber) => getSignedUrl(
  signer, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 },
);

async function completeMultipart(Key, UploadId, parts) {
  await s3.send(new CompleteMultipartUploadCommand({
    Bucket, Key, UploadId,
    MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.part_number, ETag: p.etag })) },
  }));
}

async function abortMultipart(Key, UploadId) {
  await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {});
}

async function download(Key, path) {
  const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
  await pipeline(r.Body, fs.createWriteStream(path));
}

async function uploadFile(Key, path, ContentType) {
  const { size } = await fs.promises.stat(path);
  await s3.send(new PutObjectCommand({
    Bucket, Key, ContentType, ContentLength: size, Body: fs.createReadStream(path),
  }));
  return size;
}

async function putBuffer(Key, Body, ContentType) {
  await s3.send(new PutObjectCommand({ Bucket, Key, ContentType, Body }));
  return Body.length;
}

async function remove(keys) {
  const Objects = keys.filter(Boolean).map((Key) => ({ Key }));
  if (Objects.length) await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects } }));
}

// Playback/download URL: CloudFront signed URL when configured, otherwise presigned S3.
function signedUrl(Key, { expiresIn = 3600, downloadName } = {}) {
  const disposition = downloadName ? `attachment; filename="${downloadName.replace(/"/g, '')}"` : undefined;
  if (config.cloudfront) {
    const qs = disposition ? `?response-content-disposition=${encodeURIComponent(disposition)}` : '';
    return Promise.resolve(cfSigner.getSignedUrl({
      url: `${config.cloudfront.domain}/${Key}${qs}`,
      keyPairId: config.cloudfront.keyPairId,
      privateKey: config.cloudfront.privateKey,
      dateLessThan: new Date(Date.now() + expiresIn * 1000).toISOString(),
    }));
  }
  return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: disposition }), { expiresIn });
}

module.exports = {
  ensureBucket, createMultipart, uploadPart, presignPart, completeMultipart, abortMultipart,
  download, uploadFile, putBuffer, remove, signedUrl,
};
