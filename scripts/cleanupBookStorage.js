// General-purpose MongoDB space housekeeping for every compiled-book GridFS bucket in the
// cluster — not just PSIR or one subject. The PSIR incident (2026-09-04) that first triggered
// this was 3 fully-generated-but-never-downloaded books sitting in `psir_books` GridFS for two
// months, eating ~318MB of the Atlas free tier's 512MB cap and causing "space" errors app-wide.
// The app already auto-deletes a GridFS book the moment someone clicks the real Download button
// (see downloadSubjectBook/downloadPsirBook), but a book that's only ever previewed — or whose
// download never completes — never gets that cleanup. This script extends the same principle on
// a timer: any *_books GridFS bucket, for any subject, gets swept for orphaned chunks (always
// safe) and for completed-but-stale compiled books (safe because the underlying BookLayout
// selections are untouched — the compiled PDF can always be regenerated on demand).
//
// Usage:
//   node scripts/cleanupBookStorage.js                     # dry run, reports only, deletes nothing
//   node scripts/cleanupBookStorage.js --execute            # actually deletes
//   node scripts/cleanupBookStorage.js --execute --stale-days=7   # more aggressive staleness window (default 14)
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { GridFSBucket } from 'mongodb';

dotenv.config();

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const staleDaysArg = args.find(a => a.startsWith('--stale-days='));
const STALE_DAYS = staleDaysArg ? parseInt(staleDaysArg.split('=')[1], 10) : 14;
const ATLAS_M0_CAP_BYTES = 512 * 1024 * 1024;

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function reportClusterSize(label) {
  const stats = await mongoose.connection.db.stats();
  const pct = ((stats.dataSize / ATLAS_M0_CAP_BYTES) * 100).toFixed(1);
  console.log(`\n[${label}] Cluster dataSize: ${fmtMB(stats.dataSize)} / 512 MB (${pct}%)`);
  if (stats.dataSize > ATLAS_M0_CAP_BYTES * 0.8) {
    console.log(`  WARNING: over 80% of the free-tier cap — writes may start failing soon.`);
  }
  return stats.dataSize;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI missing from environment.');
  console.log(`[cleanupBookStorage] Mode: ${EXECUTE ? 'EXECUTE (will delete)' : 'DRY RUN (report only — pass --execute to actually delete)'}`);
  console.log(`[cleanupBookStorage] Staleness window for completed-book cleanup: ${STALE_DAYS} day(s).`);

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  await reportClusterSize('before');

  const { SubjectBook } = await import('../models/SubjectBook.js');
  const { PsirBook } = await import('../models/PsirBook.js');

  // Auto-discover every `${bucketBase}_books` GridFS bucket present — no hardcoded subject list,
  // so a brand-new subject that starts using GridFS shows up here automatically next run.
  const collections = await db.listCollections().toArray();
  const bucketBases = new Set();
  collections.forEach(c => {
    const m = c.name.match(/^(.+)_books\.(files|chunks)$/);
    if (m) bucketBases.add(m[1]);
  });

  if (bucketBases.size === 0) {
    console.log('\nNo *_books GridFS buckets found. Nothing to do.');
    await mongoose.disconnect();
    return;
  }
  console.log(`\nDiscovered ${bucketBases.size} book-storage bucket(s): ${[...bucketBases].join(', ')}`);

  const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  let totalOrphanChunksDeleted = 0;
  let totalStaleFilesDeleted = 0;
  let totalBytesReclaimed = 0;

  for (const bucketBase of bucketBases) {
    const bucketName = `${bucketBase}_books`;
    const filesCollName = `${bucketName}.files`;
    const chunksCollName = `${bucketName}.chunks`;

    const files = await db.collection(filesCollName).find({}).toArray();
    const validIds = new Set(files.map(f => f._id.toString()));
    const distinctChunkIds = await db.collection(chunksCollName).distinct('files_id');
    const orphanIds = distinctChunkIds.filter(id => !validIds.has(id.toString()));

    const totalFileBytes = files.reduce((a, f) => a + (f.length || 0), 0);
    console.log(`\n[${bucketName}] ${files.length} file(s) totaling ${fmtMB(totalFileBytes)}; ${orphanIds.length} orphaned chunk-group(s) out of ${distinctChunkIds.length}.`);

    // 1. Orphaned chunks: no matching .files doc, so always garbage. Zero data loss.
    if (orphanIds.length > 0) {
      const orphanChunkCount = await db.collection(chunksCollName).countDocuments({ files_id: { $in: orphanIds } });
      if (EXECUTE) {
        const r = await db.collection(chunksCollName).deleteMany({ files_id: { $in: orphanIds } });
        console.log(`  Deleted ${r.deletedCount} orphaned chunk(s).`);
        totalOrphanChunksDeleted += r.deletedCount;
      } else {
        console.log(`  [dry-run] would delete ${orphanChunkCount} orphaned chunk(s).`);
      }
    }

    if (files.length === 0) continue;

    // 2. Real files backed by a completed job older than the staleness window. The job model
    // backing this bucket is PsirBook for the special 'psir' bucket, SubjectBook (filtered by
    // subject slug) for everything else.
    const isPsir = bucketBase === 'psir';
    const Model = isPsir ? PsirBook : SubjectBook;
    const jobQuery = isPsir ? {} : { subject: bucketBase };

    for (const file of files) {
      const job = await Model.findOne({ ...jobQuery, pdfFileId: file._id.toString() }).lean();
      if (!job) {
        console.log(`  File ${file._id} (${fmtMB(file.length || 0)}) has no matching job record — leaving in place (can't confirm it's safe to remove without one).`);
        continue;
      }
      const isStale = job.status === 'completed' && job.updatedAt && new Date(job.updatedAt) < staleCutoff;
      if (!isStale) {
        console.log(`  File ${file._id} (${fmtMB(file.length || 0)}) — job status '${job.status}', ${job.updatedAt ? `last updated ${job.updatedAt.toISOString().slice(0, 10)}` : 'no updatedAt'} — not stale yet, keeping.`);
        continue;
      }
      console.log(`  File ${file._id} (${fmtMB(file.length || 0)}) — completed and stale (older than ${STALE_DAYS}d) — ${EXECUTE ? 'deleting.' : '[dry-run] would delete.'}`);
      if (EXECUTE) {
        const bucket = new GridFSBucket(db, { bucketName });
        await bucket.delete(file._id);
        await Model.findByIdAndUpdate(job._id, { $unset: { pdfFileId: '' } });
        totalStaleFilesDeleted += 1;
        totalBytesReclaimed += file.length || 0;
      }
    }
  }

  console.log(`\n[cleanupBookStorage] Summary: ${totalOrphanChunksDeleted} orphaned chunk(s) deleted, ${totalStaleFilesDeleted} stale completed book(s) deleted (${fmtMB(totalBytesReclaimed)} reclaimed).`);
  if (!EXECUTE && (totalOrphanChunksDeleted === 0)) {
    // (orphan count is always accurate even in dry-run since it's just counted, not summed pre-loop)
  }

  await reportClusterSize('after');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[cleanupBookStorage] Fatal error:', err);
  process.exit(1);
});
