import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';
import { PsirBook } from '../models/PsirBook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// RFC 4180 compliant CSV Parser
function parseCSV(text) {
  const lines = [];
  let i = 0;
  const len = text.length;
  
  while (i < len) {
    const row = [];
    while (i < len) {
      let field = "";
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        while (i < len) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
      } else {
        // Unquoted field
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
      }
      row.push(field);
      
      if (i < len && text[i] === ',') {
        i++; // skip comma
      } else {
        // End of row
        if (i < len && text[i] === '\r') {
          i++;
          if (i < len && text[i] === '\n') {
            i++;
          }
        } else if (i < len && text[i] === '\n') {
          i++;
        }
        break;
      }
    }
    lines.push(row);
  }
  return lines;
}

function sanitizeForPdf(str) {
  if (!str) return "";
  return str
      .replace(/[\u201c\u201d]/g, '"') // smart double quotes
      .replace(/[\u2018\u2019]/g, "'") // smart single quotes
      .replace(/[\u2014\u2013]/g, '-') // dashes
      .replace(/\u00a0/g, ' ')         // non-breaking space
      .replace(/\u2026/g, '...')       // ellipsis
      .replace(/[^\x00-\xff]/g, '');   // strip anything else outside ISO-8859-1
}

async function fetchUrlsInParallel(urls, concurrencyLimit = 5) {
  const results = {};
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  
  for (let i = 0; i < uniqueUrls.length; i += concurrencyLimit) {
    const chunk = uniqueUrls.slice(i, i + concurrencyLimit);
    const promises = chunk.map(async (url) => {
      const cleanUrl = url.replace('https//', 'https://').replace('http//', 'http://');
      try {
        const res = await fetch(cleanUrl);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const buffer = await res.arrayBuffer();
        results[url] = buffer;
      } catch (err) {
        console.error(`Failed to pre-fetch URL: ${cleanUrl}`, err);
        results[url] = null;
      }
    });
    await Promise.all(promises);
  }
  return results;
}

export const previewPsirData = async (req, res) => {
  console.log('[PsirController] [previewPsirData] Preview request received.');
  try {
    const csvPath = path.join(process.cwd(), 'psir_questions_updated (2).csv');
    console.log(`[PsirController] [previewPsirData] Looking for CSV file at: ${csvPath}`);
    if (!fs.existsSync(csvPath)) {
      console.warn(`[PsirController] [previewPsirData] CSV file not found at: ${csvPath}`);
      return res.status(404).json({ error: 'PSIR questions CSV file not found.' });
    }
    
    console.log('[PsirController] [previewPsirData] Reading CSV file...');
    const csvData = fs.readFileSync(csvPath, 'utf8');
    console.log('[PsirController] [previewPsirData] Parsing CSV rows...');
    const parsed = parseCSV(csvData);
    const rows = parsed.slice(1); // skip headers
    console.log(`[PsirController] [previewPsirData] Parsed ${rows.length} rows from CSV file.`);
    
    const hierarchy = {};
    
    rows.forEach(r => {
      if (r.length < 10) return;
      const section = r[0].trim();
      const topic = r[1].trim();
      const questionText = r[2].trim();
      const topperName = r[3].trim();
      const topperYear = r[4].trim();
      const topperRank = r[5].trim();
      const topperMarks = r[6].trim();
      const url = r[7].trim();
      const paper = r[9].trim();
      
      if (!questionText || !paper) return;
      
      if (!hierarchy[paper]) {
        hierarchy[paper] = {
          paper: paper,
          section: section,
          topics: {}
        };
      }
      
      const paperObj = hierarchy[paper];
      if (!paperObj.topics[topic]) {
        paperObj.topics[topic] = {
          title: topic,
          questions: {}
        };
      }
      
      const topicObj = paperObj.topics[topic];
      const qKey = `${paper}||${section}||${topic}||${questionText}`;
      if (!topicObj.questions[qKey]) {
        topicObj.questions[qKey] = {
          _id: Buffer.from(qKey).toString('base64'),
          question_text: questionText,
          file_urls: []
        };
      }
      
      if (url) {
        topicObj.questions[qKey].file_urls.push({
          url: url,
          topper_name: topperName || 'Unknown Topper',
          topper_year: topperYear || '',
          topper_rank: topperRank || '',
          topper_marks: topperMarks || ''
        });
      }
    });
    
    console.log('[PsirController] [previewPsirData] Grouping sections and topics...');
    const result = Object.values(hierarchy).map(paperObj => {
      const topicsArray = Object.values(paperObj.topics).map(topObj => {
        const questionsArray = Object.values(topObj.questions);
        return {
          title: topObj.title,
          questions: questionsArray
        };
      });
      
      topicsArray.sort((a, b) => a.title.localeCompare(b.title));
      
      return {
        paper: paperObj.paper,
        section: paperObj.section,
        topics: topicsArray
      };
    });
    
    const paperOrder = { 'Paper 1A': 1, 'Paper 1B': 2, 'Paper 2A': 3, 'Paper 2B': 4 };
    result.sort((a, b) => {
      const orderA = paperOrder[a.paper] || 99;
      const orderB = paperOrder[b.paper] || 99;
      return orderA - orderB;
    });
    
    console.log('[PsirController] [previewPsirData] Preview hierarchy generated successfully.');
    res.json(result);
  } catch (err) {
    console.error('[PsirController] [previewPsirData] Error parsing preview data:', err);
    res.status(500).json({ error: 'Failed to parse and group PSIR questions.', details: err.message });
  }
};

export const generatePsirPdf = async (req, res) => {
  console.log('[PsirController] [generatePsirPdf] Generate request received.');
  try {
    const { paper, selections, includedQuestionIds } = req.body;
    console.log(`[PsirController] [generatePsirPdf] Params: Paper='${paper}', SelectionsCount=${selections ? Object.keys(selections).length : 0}, IncludedQuestionsCount=${includedQuestionIds ? includedQuestionIds.length : 0}`);

    if (!paper) {
      console.warn('[PsirController] [generatePsirPdf] Validation failed: Missing paper.');
      return res.status(400).json({ error: 'Paper name is required to generate PDF.' });
    }

    if (!includedQuestionIds || !Array.isArray(includedQuestionIds) || includedQuestionIds.length === 0) {
      console.warn('[PsirController] [generatePsirPdf] Validation failed: Included questions array empty or missing.');
      return res.status(400).json({ error: 'Please select at least one question to include in the book.' });
    }

    // 1. Create a new PsirBook job record in database with large inputs included
    console.log('[PsirController] [generatePsirPdf] Step 1: Creating database compilation job tracking record...');
    const job = await PsirBook.create({
      paper,
      status: 'pending',
      selections,
      includedQuestionIds
    });
    console.log(`[PsirController] [generatePsirPdf] Database record created successfully. Job ID: ${job._id}`);

    // 2. Dispatch GitHub Action Workflow Run
    console.log('[PsirController] [generatePsirPdf] Step 2: Retrieving GitHub credentials from environment variables...');
    const { GITHUB_PAT, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_WORKFLOW_NAME, GITHUB_REF } = process.env;

    if (!GITHUB_PAT || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GITHUB_WORKFLOW_NAME) {
      const errorMsg = 'GitHub Actions environment variables are missing from server configuration (.env).';
      console.error(`[PsirController] [generatePsirPdf] Configuration Error: ${errorMsg}`);
      job.status = 'failed';
      job.error = errorMsg;
      await job.save();
      return res.status(500).json({ error: errorMsg });
    }

    const githubUrl = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/${GITHUB_WORKFLOW_NAME}/dispatches`;
    console.log(`[PsirController] [generatePsirPdf] Triggering GitHub workflow API dispatch. URL: ${githubUrl}`);

    // Pass only basic identifier inputs to fit within GitHub's 1024-byte input size limit
    const payload = {
      ref: GITHUB_REF || 'main',
      inputs: {
        paper: paper,
        jobId: job._id.toString()
      }
    };
    console.log(`[PsirController] [generatePsirPdf] Payload inputs prepared. Ref: '${payload.ref}', Job ID: '${payload.inputs.jobId}'`);

    const response = await fetch(githubUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_PAT}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DH-Separator-Backend'
      },
      body: JSON.stringify(payload)
    });

    console.log(`[PsirController] [generatePsirPdf] GitHub API Response status: ${response.status} (${response.statusText})`);

    if (response.status !== 204) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch (e) {
        responseBody = 'Failed to read response body.';
      }
      const errorDetails = `GitHub API returned status code ${response.status}: ${responseBody}`;
      console.error(`[PsirController] [generatePsirPdf] Action trigger failed. Error details: ${errorDetails}`);
      
      job.status = 'failed';
      job.error = errorDetails;
      await job.save();
      console.log('[PsirController] [generatePsirPdf] Database job status marked as failed.');
      
      return res.status(500).json({ error: 'Failed to trigger compilation runner.', details: errorDetails });
    }

    console.log(`[PsirController] [generatePsirPdf] GitHub Action workflow dispatched successfully. Job ID: ${job._id}`);
    res.status(202).json({
      message: 'PDF generation has been successfully offloaded and queued in GitHub Actions.',
      jobId: job._id
    });

  } catch (error) {
    console.error(`[PsirController] [generatePsirPdf] Unexpected execution error occurred:`, error);
    res.status(500).json({ error: 'Failed to initiate PDF book generation.', details: error.message });
  }
};

export const getPsirBookStatus = async (req, res) => {
  const { id } = req.params;
  console.log(`[PsirController] [getPsirBookStatus] Request status polling for Job ID: ${id}`);
  try {
    // Project out the pdfData buffer field to avoid fetching/sending large payloads during polling checks
    const job = await PsirBook.findById(id).select('-pdfData');
    if (!job) {
      console.warn(`[PsirController] [getPsirBookStatus] Job ID not found in database: ${id}`);
      return res.status(404).json({ error: 'Compilation job not found.' });
    }
    console.log(`[PsirController] [getPsirBookStatus] Job record retrieved. Status: '${job.status}'`);
    res.json(job);
  } catch (err) {
    console.error(`[PsirController] [getPsirBookStatus] Error fetching status for Job ID ${id}:`, err);
    res.status(500).json({ error: 'Failed to retrieve compilation job status.', details: err.message });
  }
};

export const downloadPsirBook = async (req, res) => {
  const { id } = req.params;
  // Preview (iframe) requests omit ?download=true and get an inline disposition that
  // does not consume the GridFS file. Only an explicit download deletes it after streaming.
  const isDownload = req.query.download === 'true';
  const disposition = isDownload ? 'attachment' : 'inline';
  console.log(`[PsirController] [downloadPsirBook] Serving ${isDownload ? 'download' : 'preview'} for Job ID: ${id}`);
  try {
    const job = await PsirBook.findById(id);
    if (!job || (!job.pdfFileId && !job.pdfUrl && !job.pdfData)) {
      console.warn(`[PsirController] [downloadPsirBook] PDF not found or not yet generated for Job ID: ${id}`);
      return res.status(404).json({ error: 'PDF book not found or compilation not finished yet.' });
    }

    const fileName = `Formal_PSIR_${job.paper.replace(/[^a-z0-9]/gi, '_')}.pdf`;

    if (job.pdfFileId) {
      const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: 'psir_books' });
      const fileId = new mongoose.Types.ObjectId(job.pdfFileId);

      const files = await bucket.find({ _id: fileId }).toArray();
      if (files.length === 0) {
        console.warn(`[PsirController] [downloadPsirBook] GridFS file not found for ID: ${job.pdfFileId}`);
        return res.status(404).json({ error: 'PDF file not found in storage.' });
      }

      console.log(`[PsirController] [downloadPsirBook] Streaming ${files[0].length} bytes from GridFS as: ${fileName}`);
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', files[0].length);

      const downloadStream = bucket.openDownloadStream(fileId);

      downloadStream.on('error', (err) => {
        console.error('[PsirController] [downloadPsirBook] GridFS stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream PDF.' });
      });

      downloadStream.pipe(res);

      if (isDownload) {
        res.on('finish', async () => {
          try {
            await bucket.delete(fileId);
            await PsirBook.findByIdAndUpdate(id, { $unset: { pdfFileId: '' } });
            console.log(`[PsirController] [downloadPsirBook] GridFS file ${fileId} deleted after successful download.`);
          } catch (delErr) {
            console.error('[PsirController] [downloadPsirBook] Failed to delete GridFS file:', delErr);
          }
        });
      }

      return;
    }

    if (job.pdfUrl) {
      console.log(`[PsirController] [downloadPsirBook] Fetching PDF from Cloudinary URL and streaming as: ${fileName}`);
      const cloudRes = await fetch(job.pdfUrl);
      if (!cloudRes.ok) throw new Error(`Failed to fetch PDF from storage: ${cloudRes.status}`);
      const cloudBuffer = Buffer.from(await cloudRes.arrayBuffer());
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(cloudBuffer);
      return;
    }

    console.log(`[PsirController] [downloadPsirBook] Streaming ${job.pdfData.length} bytes from legacy buffer as: ${fileName}`);
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(job.pdfData);
  } catch (err) {
    console.error(`[PsirController] [downloadPsirBook] Download error:`, err);
    res.status(500).json({ error: 'Failed to download PDF book.', details: err.message });
  }
};

// Wipes only the PSIR compiled-book file storage (GridFS bucket 'psir_books' files + chunks,
// including any orphaned chunks left behind by failed uploads) and clears file references on
// job records. Does not touch job metadata (selections, status, etc.) or any other collection.
export const cleanupPsirStorage = async (req, res) => {
  console.log('[PsirController] [cleanupPsirStorage] Cleanup request received.');
  try {
    const db = mongoose.connection.db;
    const filesResult = await db.collection('psir_books.files').deleteMany({});
    const chunksResult = await db.collection('psir_books.chunks').deleteMany({});
    const jobsUpdateResult = await PsirBook.updateMany(
      {},
      { $unset: { pdfFileId: '', pdfUrl: '', pdfData: '' } }
    );
    console.log(`[PsirController] [cleanupPsirStorage] Deleted ${filesResult.deletedCount} GridFS files, ${chunksResult.deletedCount} chunks. Cleared references on ${jobsUpdateResult.modifiedCount} job(s).`);
    res.json({
      message: 'PSIR file storage cleaned successfully.',
      deletedFiles: filesResult.deletedCount,
      deletedChunks: chunksResult.deletedCount,
      jobsUpdated: jobsUpdateResult.modifiedCount
    });
  } catch (err) {
    console.error('[PsirController] [cleanupPsirStorage] Cleanup error:', err);
    res.status(500).json({ error: 'Failed to clean up PSIR file storage.', details: err.message });
  }
};

// Proxies a Cloudinary-hosted topper sheet so it can be previewed inline in an <iframe>.
// Cloudinary serves 'raw' resource_type files with Content-Disposition: attachment by
// default, which forces a download instead of an inline preview; re-serving it ourselves
// lets us override that to inline with the correct PDF content type.
export const previewTopperFile = async (req, res) => {
  const { url } = req.query;
  try {
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Missing url parameter.' });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid url parameter.' });
    }
    if (!parsed.hostname.endsWith('cloudinary.com')) {
      return res.status(400).json({ error: 'Only Cloudinary URLs are supported for preview.' });
    }

    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Failed to fetch source file: ${upstream.status}` });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(buffer);
  } catch (err) {
    console.error('[PsirController] [previewTopperFile] Proxy error:', err);
    res.status(500).json({ error: 'Failed to proxy preview file.', details: err.message });
  }
};
