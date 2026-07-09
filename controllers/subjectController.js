import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';
import { UPSCQA } from '../models/UPSCQA.js';
import { Subject } from '../models/Subject.js';
import { SubjectBook } from '../models/SubjectBook.js';
import { BookLayout } from '../models/BookLayout.js';
import { classifyQuestionsForSubject, classifyQuestionsForSubjectStructured } from '../services/geminiService.js';
import { parseCSV, escapeCSV, cleanYear } from '../utils/csv.js';
import { applyBookLayout, deriveIncludedAndSelections } from '../utils/bookLayout.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_HEADERS = [
  'Section', 'Topic', 'Question', 'Topper Name', 'Topper Year',
  'Topper Rank', 'Topper Marks', 'Topper Answer Sheet URL', 'All Tags', 'Paper'
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function generateUniqueSlug(name, existingSubjectId) {
  const base = slugify(name) || 'subject';
  let slug = base;
  let counter = 2;
  while (true) {
    const existing = await Subject.findOne({ slug });
    if (!existing || (existingSubjectId && existing._id.equals(existingSubjectId))) {
      console.log(`[SubjectController] [generateUniqueSlug] Resolved slug '${slug}' for name '${name}'.`);
      return slug;
    }
    slug = `${base}-${counter}`;
    counter++;
  }
}

// Groups parsed CSV rows (header already stripped) into the Paper > Topic > Question
// hierarchy shape consumed by the frontend book builder. Mirrors psirController.js's
// previewPsirData grouping algorithm exactly, except paper names/order are discovered
// dynamically from the data instead of a hardcoded paperOrder map.
function buildHierarchyFromRows(rows) {
  console.log(`[SubjectController] [buildHierarchyFromRows] Grouping ${rows.length} CSV row(s) into Paper > Topic > Question hierarchy...`);
  const hierarchy = {};

  rows.forEach(r => {
    if (r.length < 10) return;
    const section = r[0].trim();
    const topic = r[1].trim();
    const questionText = r[2].trim();
    const topperName = r[3].trim();
    const topperYear = cleanYear(r[4].trim());
    const topperRank = r[5].trim();
    const topperMarks = r[6].trim();
    const url = r[7].trim();
    const paper = r[9].trim();

    if (!questionText || !paper) return;

    if (!hierarchy[paper]) {
      hierarchy[paper] = { paper, section, topics: {} };
    }

    const paperObj = hierarchy[paper];
    if (!paperObj.topics[topic]) {
      paperObj.topics[topic] = { title: topic, questions: {} };
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
        url,
        topper_name: topperName || 'Unknown Topper',
        topper_year: topperYear || '',
        topper_rank: topperRank || '',
        topper_marks: topperMarks || ''
      });
    }
  });

  const result = Object.values(hierarchy).map(paperObj => {
    const topicsArray = Object.values(paperObj.topics).map(topObj => ({
      title: topObj.title,
      _key: topObj.title,
      questions: Object.values(topObj.questions)
    }));
    topicsArray.sort((a, b) => a.title.localeCompare(b.title));
    return { paper: paperObj.paper, section: paperObj.section, topics: topicsArray };
  });

  result.sort((a, b) => a.paper.localeCompare(b.paper, undefined, { numeric: true, sensitivity: 'base' }));
  console.log(`[SubjectController] [buildHierarchyFromRows] Built hierarchy with ${result.length} paper(s): ${result.map(p => `${p.paper} (${p.topics.reduce((acc, t) => acc + t.questions.length, 0)} Qs)`).join(', ')}.`);
  return result;
}

// --- Subject Setup ---

export const listUsedSubjects = async (req, res) => {
  console.log('[SubjectController] [listUsedSubjects] Request received.');
  try {
    const subjects = await UPSCQA.distinct('subject');
    const result = subjects.filter(Boolean).sort((a, b) => a.localeCompare(b));
    console.log(`[SubjectController] [listUsedSubjects] Found ${result.length} distinct used subject(s): ${result.join(', ') || '(none)'}.`);
    res.json(result);
  } catch (err) {
    console.error('[SubjectController] [listUsedSubjects] Error:', err);
    res.status(500).json({ error: 'Failed to list used subjects.', details: err.message });
  }
};

export const listRegistrySubjects = async (req, res) => {
  console.log(`[SubjectController] [listRegistrySubjects] Request received. Status filter: '${req.query.status || '(any)'}'.`);
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const subjects = await Subject.find(filter)
      .select('name slug status questionCount createdAt')
      .sort({ name: 1 })
      .lean();
    console.log(`[SubjectController] [listRegistrySubjects] Found ${subjects.length} subject(s) in registry.`);
    res.json(subjects);
  } catch (err) {
    console.error('[SubjectController] [listRegistrySubjects] Error:', err);
    res.status(500).json({ error: 'Failed to list subjects.', details: err.message });
  }
};

export const classifySubject = async (req, res) => {
  console.log('[SubjectController] [classifySubject] Request received.');
  try {
    const { name, syllabusJson, syllabusText } = req.body;
    const useStructured = syllabusJson && Array.isArray(syllabusJson) && syllabusJson.length > 0;
    console.log(`[SubjectController] [classifySubject] Params: name='${name}', mode=${useStructured ? 'structured-JSON' : 'free-text'}.`);

    if (!name || !String(name).trim()) {
      console.warn('[SubjectController] [classifySubject] Validation failed: missing subject name.');
      return res.status(400).json({ error: 'Subject name is required.' });
    }
    if (!useStructured && (!syllabusText || !String(syllabusText).trim())) {
      console.warn('[SubjectController] [classifySubject] Validation failed: missing syllabus.');
      return res.status(400).json({ error: 'Syllabus is required (either syllabusJson or syllabusText).' });
    }
    const trimmedName = String(name).trim();

    console.log(`[SubjectController] [classifySubject] Step 1: Resolving Subject registry record for '${trimmedName}'...`);
    let subjectDoc = await Subject.findOne({ name: trimmedName });
    if (!subjectDoc) {
      const slug = await generateUniqueSlug(trimmedName);
      subjectDoc = new Subject({ name: trimmedName, slug, syllabusText: syllabusText || '', csvData: '' });
      console.log(`[SubjectController] [classifySubject] Created new draft Subject record. Slug: '${slug}'.`);
    } else {
      if (syllabusText) subjectDoc.syllabusText = syllabusText;
      console.log(`[SubjectController] [classifySubject] Found existing Subject record. Slug: '${subjectDoc.slug}', Status: '${subjectDoc.status}'. Re-classifying.`);
    }
    if (useStructured) subjectDoc.syllabusJson = syllabusJson;

    console.log(`[SubjectController] [classifySubject] Step 2: Querying UPSCQA for questions tagged subject='${trimmedName}' (case-insensitive)...`);
    const subjectRegex = new RegExp(`^${escapeRegExp(trimmedName)}$`, 'i');
    const questions = await UPSCQA.find({ subject: subjectRegex }).lean();
    console.log(`[SubjectController] [classifySubject] Found ${questions.length} uploaded question record(s) for this subject.`);

    if (questions.length === 0) {
      console.warn(`[SubjectController] [classifySubject] No questions found for subject '${trimmedName}'. Aborting.`);
      return res.status(404).json({
        error: `No uploaded questions found for subject "${trimmedName}". Check that the subject name matches exactly what was used during upload.`
      });
    }

    const distinctTexts = [...new Set(questions.map(q => q.question_text))];
    console.log(`[SubjectController] [classifySubject] Step 3: Classifying ${distinctTexts.length} distinct question(s) via Gemini (${useStructured ? 'structured JSON syllabus' : 'free-text syllabus'})...`);
    const classificationMap = useStructured
      ? await classifyQuestionsForSubjectStructured(distinctTexts, syllabusJson)
      : await classifyQuestionsForSubject(distinctTexts, syllabusText);
    console.log(`[SubjectController] [classifySubject] Classification complete. Received ${classificationMap.size} classified entr(ies).`);

    console.log('[SubjectController] [classifySubject] Step 4: Building CSV rows (one row per topper file, flattened)...');
    const rows = [];
    questions.forEach(q => {
      const classification = classificationMap.get(q.question_text) || { section: 'Unassigned', topic: 'Unassigned', paper: 'Paper 1' };
      const allTags = `${trimmedName}, ${classification.paper}, ${classification.section}, ${classification.topic}`;

      if (q.file_urls && q.file_urls.length > 0) {
        q.file_urls.forEach(f => {
          rows.push([
            classification.section, classification.topic, q.question_text,
            f.topper_name || 'Unknown Topper', cleanYear(f.topper_year) || '', f.topper_rank || '',
            f.topper_marks || '', f.url || '', allTags, classification.paper
          ]);
        });
      } else {
        rows.push([
          classification.section, classification.topic, q.question_text,
          '', '', '', '', '', allTags, classification.paper
        ]);
      }
    });
    console.log(`[SubjectController] [classifySubject] Built ${rows.length} CSV row(s).`);

    rows.sort((a, b) => {
      if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
      if (a[1] !== b[1]) return a[1].localeCompare(b[1]);
      return a[2].localeCompare(b[2]);
    });

    let csvContent = CSV_HEADERS.map(escapeCSV).join(',') + '\n';
    rows.forEach(r => {
      csvContent += r.map(escapeCSV).join(',') + '\n';
    });

    console.log(`[SubjectController] [classifySubject] Step 5: Saving CSV (${csvContent.length} bytes) to Subject.csvData in MongoDB (source of truth)...`);
    subjectDoc.csvData = csvContent;
    subjectDoc.questionCount = distinctTexts.length;
    await subjectDoc.save();
    console.log('[SubjectController] [classifySubject] Subject document saved successfully.');

    const dataDir = path.join(__dirname, '..', 'data', 'subjects');
    fs.mkdirSync(dataDir, { recursive: true });
    const debugCsvPath = path.join(dataDir, `${subjectDoc.slug}_questions.csv`);
    fs.writeFileSync(debugCsvPath, csvContent, 'utf8');
    console.log(`[SubjectController] [classifySubject] Step 6: Wrote convenience copy of CSV to: ${debugCsvPath} (not read by anything; Mongo remains canonical).`);

    const hierarchy = buildHierarchyFromRows(rows);

    console.log(`[SubjectController] [classifySubject] Done. Returning preview hierarchy for '${trimmedName}' (slug: '${subjectDoc.slug}').`);
    res.json({
      subject: { name: subjectDoc.name, slug: subjectDoc.slug, status: subjectDoc.status },
      hierarchy,
      questionCount: distinctTexts.length
    });
  } catch (err) {
    console.error('[SubjectController] [classifySubject] Error:', err);
    res.status(500).json({ error: 'Failed to classify subject questions.', details: err.message });
  }
};

export const activateSubject = async (req, res) => {
  const { slug } = req.params;
  console.log(`[SubjectController] [activateSubject] Request received for slug: '${slug}'.`);
  try {
    const subjectDoc = await Subject.findOne({ slug });
    if (!subjectDoc) {
      console.warn(`[SubjectController] [activateSubject] Subject not found: '${slug}'.`);
      return res.status(404).json({ error: 'Subject not found.' });
    }
    if (!subjectDoc.csvData) {
      console.warn(`[SubjectController] [activateSubject] Subject '${slug}' has no classified CSV yet. Refusing to activate.`);
      return res.status(400).json({ error: 'Run Classify before activating this subject.' });
    }
    subjectDoc.status = 'active';
    await subjectDoc.save();
    console.log(`[SubjectController] [activateSubject] Subject '${slug}' is now active. This subject's book builder is now available.`);
    res.json({ name: subjectDoc.name, slug: subjectDoc.slug, status: subjectDoc.status });
  } catch (err) {
    console.error('[SubjectController] [activateSubject] Error:', err);
    res.status(500).json({ error: 'Failed to activate subject.', details: err.message });
  }
};

// --- Generic book-compilation pipeline (parameterized clone of psirController.js) ---

export const previewSubjectBookData = async (req, res) => {
  const { slug } = req.params;
  console.log(`[SubjectController] [previewSubjectBookData] Preview request received for slug: '${slug}'.`);
  try {
    const subjectDoc = await Subject.findOne({ slug });
    if (!subjectDoc || !subjectDoc.csvData) {
      console.warn(`[SubjectController] [previewSubjectBookData] No CSV data found for slug '${slug}'.`);
      return res.status(404).json({ error: 'Subject questions CSV not found. Run Classify first.' });
    }

    console.log(`[SubjectController] [previewSubjectBookData] Reading CSV (${subjectDoc.csvData.length} bytes) from Subject.csvData (Mongo)...`);
    const parsed = parseCSV(subjectDoc.csvData);
    const rows = parsed.slice(1);
    console.log(`[SubjectController] [previewSubjectBookData] Parsed ${rows.length} CSV row(s).`);
    const hierarchy = buildHierarchyFromRows(rows);

    console.log(`[SubjectController] [previewSubjectBookData] Applying any saved book layout customizations for '${slug}'...`);
    const layoutDocs = await BookLayout.find({ subject: slug }).lean();
    const layoutsByPaper = Object.fromEntries(layoutDocs.map(l => [l.paper, l]));
    const mergedHierarchy = applyBookLayout(hierarchy, layoutsByPaper);
    const { excludedQuestionIds, selections, expandedTopicTitles } = deriveIncludedAndSelections(mergedHierarchy, layoutsByPaper);

    console.log(`[SubjectController] [previewSubjectBookData] Preview hierarchy generated successfully for '${slug}'. ${layoutDocs.length} saved layout(s) applied.`);
    res.json({ hierarchy: mergedHierarchy, excludedQuestionIds, selections, expandedTopicTitles });
  } catch (err) {
    console.error('[SubjectController] [previewSubjectBookData] Error:', err);
    res.status(500).json({ error: 'Failed to parse and group subject questions.', details: err.message });
  }
};

// Upserts the saved customization layout (topic order/renames, question order, included/
// excluded questions, topper selections, topper detail overrides) for a single paper of a
// single subject. Mirrors psirController.js's saveBookLayout, keyed by the subject's slug.
export const saveSubjectBookLayout = async (req, res) => {
  const { slug } = req.params;
  const { paper, topicOrder, topicRenames, questionOrder, excludedQuestionIds, selections, topperOverrides, expandedTopics, questionTextOverrides, titlePages } = req.body;
  console.log(`[SubjectController] [saveSubjectBookLayout] Saving layout for subject '${slug}', paper '${paper}'...`);
  try {
    if (!paper) {
      return res.status(400).json({ error: 'Paper name is required to save a layout.' });
    }
    const doc = await BookLayout.findOneAndUpdate(
      { subject: slug, paper },
      { $set: { topicOrder, topicRenames, questionOrder, excludedQuestionIds, selections, topperOverrides, expandedTopics, questionTextOverrides, titlePages } },
      { upsert: true, new: true }
    );
    console.log(`[SubjectController] [saveSubjectBookLayout] Layout saved for subject '${slug}', paper '${paper}'.`);
    res.json({ message: 'Layout saved.', paper: doc.paper });
  } catch (err) {
    console.error('[SubjectController] [saveSubjectBookLayout] Error:', err);
    res.status(500).json({ error: 'Failed to save book layout.', details: err.message });
  }
};

export const generateSubjectBookPdf = async (req, res) => {
  const { slug } = req.params;
  console.log(`[SubjectController] [generateSubjectBookPdf] Generate request received for slug: '${slug}'.`);
  try {
    const { paper, selections, includedQuestionIds } = req.body;
    console.log(`[SubjectController] [generateSubjectBookPdf] Params: Paper='${paper}', SelectionsCount=${selections ? Object.keys(selections).length : 0}, IncludedQuestionsCount=${includedQuestionIds ? includedQuestionIds.length : 0}`);

    const subjectDoc = await Subject.findOne({ slug });
    if (!subjectDoc) {
      console.warn(`[SubjectController] [generateSubjectBookPdf] Subject not found: '${slug}'.`);
      return res.status(404).json({ error: 'Subject not found.' });
    }
    if (!paper) {
      console.warn('[SubjectController] [generateSubjectBookPdf] Validation failed: missing paper.');
      return res.status(400).json({ error: 'Paper name is required to generate PDF.' });
    }
    if (!includedQuestionIds || !Array.isArray(includedQuestionIds) || includedQuestionIds.length === 0) {
      console.warn('[SubjectController] [generateSubjectBookPdf] Validation failed: included questions array empty or missing.');
      return res.status(400).json({ error: 'Please select at least one question to include in the book.' });
    }

    console.log('[SubjectController] [generateSubjectBookPdf] Step 1: Creating SubjectBook job tracking record...');
    const layout = await BookLayout.findOne({ subject: slug, paper }).lean();
    const job = await SubjectBook.create({
      subject: slug,
      paper,
      status: 'pending',
      selections,
      includedQuestionIds,
      topicRenames: layout?.topicRenames || {},
      topperOverrides: layout?.topperOverrides || {},
      questionTextOverrides: layout?.questionTextOverrides || {},
      titlePages: layout?.titlePages || {}
    });
    console.log(`[SubjectController] [generateSubjectBookPdf] Job record created. Job ID: ${job._id}`);

    console.log('[SubjectController] [generateSubjectBookPdf] Step 2: Reading GitHub Actions credentials from environment...');
    const { GITHUB_PAT, GITHUB_REPO_OWNER, GITHUB_REPO_NAME, GITHUB_BOOK_WORKFLOW_NAME, GITHUB_REF } = process.env;

    if (!GITHUB_PAT || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GITHUB_BOOK_WORKFLOW_NAME) {
      const errorMsg = 'GitHub Actions environment variables are missing from server configuration (.env).';
      console.error(`[SubjectController] [generateSubjectBookPdf] Configuration error: ${errorMsg}`);
      job.status = 'failed';
      job.error = errorMsg;
      await job.save();
      return res.status(500).json({ error: errorMsg });
    }

    const githubUrl = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/actions/workflows/${GITHUB_BOOK_WORKFLOW_NAME}/dispatches`;
    console.log(`[SubjectController] [generateSubjectBookPdf] Step 3: Dispatching GitHub workflow. URL: ${githubUrl}`);

    const payload = {
      ref: GITHUB_REF || 'main',
      inputs: {
        subject: slug,
        paper: paper,
        jobId: job._id.toString()
      }
    };
    console.log(`[SubjectController] [generateSubjectBookPdf] Dispatch inputs: ${JSON.stringify(payload.inputs)}`);

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
    console.log(`[SubjectController] [generateSubjectBookPdf] GitHub API response status: ${response.status} (${response.statusText})`);

    if (response.status !== 204) {
      let responseBody = '';
      try { responseBody = await response.text(); } catch (e) { responseBody = 'Failed to read response body.'; }
      const errorDetails = `GitHub API returned status code ${response.status}: ${responseBody}`;
      console.error(`[SubjectController] [generateSubjectBookPdf] Dispatch failed: ${errorDetails}`);

      job.status = 'failed';
      job.error = errorDetails;
      await job.save();

      return res.status(500).json({ error: 'Failed to trigger compilation runner.', details: errorDetails });
    }

    console.log(`[SubjectController] [generateSubjectBookPdf] Workflow dispatched successfully. Job ID: ${job._id}`);
    res.status(202).json({
      message: 'PDF generation has been successfully offloaded and queued in GitHub Actions.',
      jobId: job._id
    });
  } catch (error) {
    console.error('[SubjectController] [generateSubjectBookPdf] Error:', error);
    res.status(500).json({ error: 'Failed to initiate PDF book generation.', details: error.message });
  }
};

export const getSubjectBookStatus = async (req, res) => {
  const { id } = req.params;
  console.log(`[SubjectController] [getSubjectBookStatus] Status poll for Job ID: ${id}`);
  try {
    const job = await SubjectBook.findById(id).select('-pdfData');
    if (!job) {
      console.warn(`[SubjectController] [getSubjectBookStatus] Job not found: ${id}`);
      return res.status(404).json({ error: 'Compilation job not found.' });
    }
    console.log(`[SubjectController] [getSubjectBookStatus] Job '${id}' status: '${job.status}'.`);
    res.json(job);
  } catch (err) {
    console.error('[SubjectController] [getSubjectBookStatus] Error:', err);
    res.status(500).json({ error: 'Failed to retrieve compilation job status.', details: err.message });
  }
};

export const downloadSubjectBook = async (req, res) => {
  const { id } = req.params;
  const isDownload = req.query.download === 'true';
  const disposition = isDownload ? 'attachment' : 'inline';
  console.log(`[SubjectController] [downloadSubjectBook] Serving ${isDownload ? 'download' : 'preview'} for Job ID: ${id}`);
  try {
    const job = await SubjectBook.findById(id);
    if (!job || (!job.pdfFileId && !job.pdfUrl && !job.pdfData)) {
      console.warn(`[SubjectController] [downloadSubjectBook] PDF not found or not yet generated for Job ID: ${id}`);
      return res.status(404).json({ error: 'PDF book not found or compilation not finished yet.' });
    }

    const fileName = `Formal_${job.subject}_${job.paper.replace(/[^a-z0-9]/gi, '_')}.pdf`;

    if (job.pdfFileId) {
      console.log(`[SubjectController] [downloadSubjectBook] Streaming from GridFS bucket '${job.subject}_books', file ID: ${job.pdfFileId}`);
      const bucket = new GridFSBucket(mongoose.connection.db, { bucketName: `${job.subject}_books` });
      const fileId = new mongoose.Types.ObjectId(job.pdfFileId);

      const files = await bucket.find({ _id: fileId }).toArray();
      if (files.length === 0) {
        console.warn(`[SubjectController] [downloadSubjectBook] GridFS file not found for ID: ${job.pdfFileId}`);
        return res.status(404).json({ error: 'PDF file not found in storage.' });
      }

      console.log(`[SubjectController] [downloadSubjectBook] Streaming ${files[0].length} bytes as: ${fileName}`);
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', files[0].length);

      const downloadStream = bucket.openDownloadStream(fileId);

      downloadStream.on('error', (err) => {
        console.error('[SubjectController] [downloadSubjectBook] GridFS stream error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to stream PDF.' });
      });

      downloadStream.pipe(res);

      if (isDownload) {
        res.on('finish', async () => {
          try {
            await bucket.delete(fileId);
            await SubjectBook.findByIdAndUpdate(id, { $unset: { pdfFileId: '' } });
            console.log(`[SubjectController] [downloadSubjectBook] GridFS file ${fileId} deleted after successful download.`);
          } catch (delErr) {
            console.error('[SubjectController] [downloadSubjectBook] Failed to delete GridFS file:', delErr);
          }
        });
      }

      return;
    }

    if (job.pdfUrl) {
      console.log(`[SubjectController] [downloadSubjectBook] Fetching PDF from external URL and streaming as: ${fileName}`);
      const cloudRes = await fetch(job.pdfUrl);
      if (!cloudRes.ok) throw new Error(`Failed to fetch PDF from storage: ${cloudRes.status}`);
      const cloudBuffer = Buffer.from(await cloudRes.arrayBuffer());
      res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
      res.setHeader('Content-Type', 'application/pdf');
      res.send(cloudBuffer);
      return;
    }

    console.log(`[SubjectController] [downloadSubjectBook] Streaming ${job.pdfData.length} bytes from legacy buffer as: ${fileName}`);
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/pdf');
    res.send(job.pdfData);
  } catch (err) {
    console.error('[SubjectController] [downloadSubjectBook] Download error:', err);
    res.status(500).json({ error: 'Failed to download PDF book.', details: err.message });
  }
};

// Wipes only this subject's compiled-book file storage (GridFS bucket `${slug}_books`
// files + chunks) and clears file references on this subject's job records only — never
// touches another subject's bucket or job docs.
export const cleanupSubjectBookStorage = async (req, res) => {
  const { slug } = req.params;
  console.log(`[SubjectController] [cleanupSubjectBookStorage] Cleanup request received for slug: '${slug}'.`);
  try {
    const db = mongoose.connection.db;
    const filesResult = await db.collection(`${slug}_books.files`).deleteMany({});
    const chunksResult = await db.collection(`${slug}_books.chunks`).deleteMany({});
    const jobsUpdateResult = await SubjectBook.updateMany(
      { subject: slug },
      { $unset: { pdfFileId: '', pdfUrl: '', pdfData: '' } }
    );
    console.log(`[SubjectController] [cleanupSubjectBookStorage] Deleted ${filesResult.deletedCount} GridFS file(s), ${chunksResult.deletedCount} chunk(s). Cleared references on ${jobsUpdateResult.modifiedCount} job(s) for '${slug}'.`);
    res.json({
      message: 'Subject book storage cleaned successfully.',
      deletedFiles: filesResult.deletedCount,
      deletedChunks: chunksResult.deletedCount,
      jobsUpdated: jobsUpdateResult.modifiedCount
    });
  } catch (err) {
    console.error('[SubjectController] [cleanupSubjectBookStorage] Cleanup error:', err);
    res.status(500).json({ error: 'Failed to clean up subject book storage.', details: err.message });
  }
};

// Proxies a Cloudinary-hosted topper sheet so it can be previewed inline in an <iframe>
// (Cloudinary serves 'raw' files with Content-Disposition: attachment by default).
export const previewSubjectTopperFile = async (req, res) => {
  const { url } = req.query;
  console.log(`[SubjectController] [previewSubjectTopperFile] Proxy request for URL: ${url}`);
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
      console.warn(`[SubjectController] [previewSubjectTopperFile] Rejected non-Cloudinary host: ${parsed.hostname}`);
      return res.status(400).json({ error: 'Only Cloudinary URLs are supported for preview.' });
    }

    const upstream = await fetch(url);
    if (!upstream.ok) {
      console.warn(`[SubjectController] [previewSubjectTopperFile] Upstream fetch failed: ${upstream.status}`);
      return res.status(upstream.status).json({ error: `Failed to fetch source file: ${upstream.status}` });
    }
    const buffer = Buffer.from(await upstream.arrayBuffer());
    console.log(`[SubjectController] [previewSubjectTopperFile] Proxied ${buffer.length} byte(s) successfully.`);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.send(buffer);
  } catch (err) {
    console.error('[SubjectController] [previewSubjectTopperFile] Proxy error:', err);
    res.status(500).json({ error: 'Failed to proxy preview file.', details: err.message });
  }
};
