import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function list(client, bucket) {
  const keys = [];
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) keys.push(object.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token)
      throw new Error("Missing storage list continuation token.");
  } while (token);
  return keys.sort();
}

async function read(client, bucket, key) {
  const { Body, ContentType } = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!Body) throw new Error("A listed object has no body.");
  return { bytes: await Body.transformToByteArray(), contentType: ContentType };
}

async function snapshot(client, bucket, directory) {
  await mkdir(directory, { mode: 0o700 });
  const objects = [];
  for (const key of await list(client, bucket)) {
    const { bytes, contentType } = await read(client, bucket, key);
    const hash = digest(bytes);
    const blob = join(directory, String(objects.length));
    await writeFile(blob, bytes, { mode: 0o600, flag: "wx" });
    objects.push({ key, size: bytes.length, sha256: hash, contentType });
  }
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ version: 1, objects }),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
  return objects.length;
}

async function restore(client, bucket, directory) {
  const { version, objects } = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  );
  if (
    version !== 1 ||
    !Array.isArray(objects) ||
    !objects.every(
      (item) =>
        typeof item.key === "string" &&
        item.key.length > 0 &&
        Number.isSafeInteger(item.size) &&
        item.size >= 0 &&
        /^[a-f0-9]{64}$/.test(item.sha256) &&
        (item.contentType === undefined ||
          typeof item.contentType === "string"),
    ) ||
    new Set(objects.map(({ key }) => key)).size !== objects.length
  )
    throw new Error("Invalid storage manifest.");
  if ((await list(client, bucket)).length)
    throw new Error("Restore requires an empty destination bucket.");

  for (const [index, { key, size, sha256, contentType }] of objects.entries()) {
    const bytes = await readFile(join(directory, String(index)));
    if (bytes.length !== size || digest(bytes) !== sha256)
      throw new Error("Backup object checksum mismatch.");
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        IfNoneMatch: "*",
      }),
    );
    const restored = await read(client, bucket, key);
    if (
      restored.bytes.length !== size ||
      digest(restored.bytes) !== sha256 ||
      restored.contentType !== contentType
    )
      throw new Error("Restored object verification failed.");
  }
  if ((await list(client, bucket)).length !== objects.length)
    throw new Error("Restored object count mismatch.");
  return objects.length;
}

const [mode, directory] = process.argv.slice(2);
if (!["snapshot", "restore"].includes(mode) || !directory)
  throw new Error(
    "Usage: node infra/recovery/storage.mjs snapshot|restore DIRECTORY",
  );
const {
  STORAGE_ENDPOINT: endpoint,
  STORAGE_REGION: region,
  STORAGE_BUCKET: bucket,
  STORAGE_ACCESS_KEY_ID: accessKeyId,
  STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
} = process.env;
if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey)
  throw new Error("Set the storage endpoint, bucket, region and credentials.");
const client = new S3Client({
  endpoint,
  region,
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
try {
  const objects = await (mode === "snapshot" ? snapshot : restore)(
    client,
    bucket,
    directory,
  );
  console.log(JSON.stringify({ storageOperation: mode, objects }));
} finally {
  client.destroy();
}
