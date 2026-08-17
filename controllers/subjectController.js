import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GridFSBucket } from 'mongodb';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { UPSCQA } from '../models/UPSCQA.js';
import { Subject } from '../models/Subject.js';
import { SubjectBook } from '../models/SubjectBook.js';
import { BookLayout } from '../models/BookLayout.js';
import { classifyQuestionsForSubject, classifyQuestionsForSubjectStructured, generateSyllabusFromText } from '../services/geminiService.js';
import { parseCSV, escapeCSV, cleanYear } from '../utils/csv.js';
import { applyBookLayout, deriveIncludedAndSelections, mergeSyllabusIntoHierarchy } from '../utils/bookLayout.js';

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

export const generateSyllabusText = async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided.' });
  try {
    const papers = await generateSyllabusFromText(text.trim());
    res.json({ papers });
  } catch (err) {
    console.error('[SubjectController] [generateSyllabusText] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to generate syllabus.' });
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

// Re-classifies all UPSCQA questions for a subject using its saved syllabusJson/syllabusText.
// Picks up any questions uploaded since the last classify run without requiring the user to
// re-enter the syllabus.
export const reclassifySubject = async (req, res) => {
  const { slug } = req.params;
  console.log(`[SubjectController] [reclassifySubject] Request received for slug: '${slug}'.`);
  try {
    const subjectDoc = await Subject.findOne({ slug });
    if (!subjectDoc) {
      return res.status(404).json({ error: 'Subject not found.' });
    }

    const hasSyllabusJson = subjectDoc.syllabusJson && Array.isArray(subjectDoc.syllabusJson) && subjectDoc.syllabusJson.length > 0;
    const hasSyllabusText = subjectDoc.syllabusText && subjectDoc.syllabusText.trim();
    if (!hasSyllabusJson && !hasSyllabusText) {
      return res.status(400).json({ error: 'No saved syllabus found for this subject. Please go through Setup again.' });
    }

    const subjectRegex = new RegExp(`^${escapeRegExp(subjectDoc.name)}$`, 'i');
    const questions = await UPSCQA.find({ subject: subjectRegex }).lean();
    console.log(`[SubjectController] [reclassifySubject] Found ${questions.length} question(s) for '${subjectDoc.name}'.`);

    if (questions.length === 0) {
      return res.status(404).json({ error: 'No uploaded questions found for this subject.' });
    }

    const distinctTexts = [...new Set(questions.map(q => q.question_text))];

    // Build a map of already-classified questions from the saved CSV so we don't
    // re-send them to Gemini — only truly new question texts go through the API.
    const existingClassifications = new Map();
    if (subjectDoc.csvData) {
      const existingRows = parseCSV(subjectDoc.csvData).slice(1);
      existingRows.forEach(r => {
        if (r.length >= 10 && r[2] && r[2].trim()) {
          existingClassifications.set(r[2].trim(), {
            section: r[0].trim(), topic: r[1].trim(), paper: r[9].trim()
          });
        }
      });
    }

    const newTexts = distinctTexts.filter(t => !existingClassifications.has(t));
    console.log(`[SubjectController] [reclassifySubject] ${existingClassifications.size} already classified, ${newTexts.length} new — sending only new to Gemini...`);

    let newClassificationMap = new Map();
    if (newTexts.length > 0) {
      newClassificationMap = hasSyllabusJson
        ? await classifyQuestionsForSubjectStructured(newTexts, subjectDoc.syllabusJson)
        : await classifyQuestionsForSubject(newTexts, subjectDoc.syllabusText);
    }

    const classificationMap = new Map([...existingClassifications, ...newClassificationMap]);

    const rows = [];
    const trimmedName = subjectDoc.name;
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
        rows.push([classification.section, classification.topic, q.question_text, '', '', '', '', '', allTags, classification.paper]);
      }
    });

    rows.sort((a, b) => {
      if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
      if (a[1] !== b[1]) return a[1].localeCompare(b[1]);
      return a[2].localeCompare(b[2]);
    });

    let csvContent = CSV_HEADERS.map(escapeCSV).join(',') + '\n';
    rows.forEach(r => { csvContent += r.map(escapeCSV).join(',') + '\n'; });

    subjectDoc.csvData = csvContent;
    subjectDoc.questionCount = distinctTexts.length;
    await subjectDoc.save();
    console.log(`[SubjectController] [reclassifySubject] Done. ${distinctTexts.length} total questions (${newTexts.length} newly classified).`);

    res.json({ questionCount: distinctTexts.length, newCount: newTexts.length, message: 'Re-classification complete. Refresh the book builder to see new questions.' });
  } catch (err) {
    console.error('[SubjectController] [reclassifySubject] Error:', err);
    res.status(500).json({ error: 'Re-classification failed.', details: err.message });
  }
};

// Lists every distinct topper whose answer sheets have been uploaded for this subject, so the
// user can recall who they've already covered. Reads UPSCQA (the upload source of truth) rather
// than the classified CSV, so it stays accurate even for questions uploaded since the last
// classify run. Grouped by topper name, with each distinct year/rank/marks combination nested
// underneath — differing metadata for the same name usually means a typo at upload time.
export const listSubjectToppers = async (req, res) => {
  const { slug } = req.params;
  console.log(`[SubjectController] [listSubjectToppers] Request received for slug: '${slug}'.`);
  try {
    const subjectDoc = await Subject.findOne({ slug });
    if (!subjectDoc) {
      console.warn(`[SubjectController] [listSubjectToppers] Subject not found: '${slug}'.`);
      return res.status(404).json({ error: 'Subject not found.' });
    }

    const subjectRegex = new RegExp(`^${escapeRegExp(subjectDoc.name)}$`, 'i');
    const questions = await UPSCQA.find({ subject: subjectRegex })
      .select('question_text file_urls')
      .lean();
    console.log(`[SubjectController] [listSubjectToppers] Scanning ${questions.length} question(s) for '${subjectDoc.name}'.`);

    const byTopper = new Map();
    let totalSheets = 0;
    let questionsWithoutSheets = 0;

    questions.forEach(q => {
      if (!q.file_urls || q.file_urls.length === 0) {
        questionsWithoutSheets++;
        return;
      }
      q.file_urls.forEach(f => {
        totalSheets++;
        const displayName = (f.topper_name || '').trim() || 'Unknown Topper';
        const key = displayName.toLowerCase();
        if (!byTopper.has(key)) {
          byTopper.set(key, { name: displayName, sheetCount: 0, questions: new Set(), entries: new Map() });
        }
        const topper = byTopper.get(key);
        topper.sheetCount++;
        if (q.question_text) topper.questions.add(q.question_text);

        const year = cleanYear((f.topper_year || '').trim()) || '';
        const rank = (f.topper_rank || '').trim();
        const marks = (f.topper_marks || '').trim();
        const entryKey = `${year}||${rank}||${marks}`;
        if (!topper.entries.has(entryKey)) {
          topper.entries.set(entryKey, { year, rank, marks, sheetCount: 0 });
        }
        topper.entries.get(entryKey).sheetCount++;
      });
    });

    const toppers = [...byTopper.values()]
      .map(t => ({
        name: t.name,
        sheetCount: t.sheetCount,
        questionCount: t.questions.size,
        entries: [...t.entries.values()].sort((a, b) => b.sheetCount - a.sheetCount)
      }))
      .sort((a, b) => b.sheetCount - a.sheetCount || a.name.localeCompare(b.name));

    console.log(`[SubjectController] [listSubjectToppers] Found ${toppers.length} distinct topper(s) across ${totalSheets} answer sheet(s).`);
    res.json({
      subject: { name: subjectDoc.name, slug: subjectDoc.slug },
      totalQuestions: questions.length,
      totalSheets,
      questionsWithoutSheets,
      toppers
    });
  } catch (err) {
    console.error('[SubjectController] [listSubjectToppers] Error:', err);
    res.status(500).json({ error: 'Failed to list toppers for this subject.', details: err.message });
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

    console.log(`[SubjectController] [previewSubjectBookData] Merging full syllabus tree so empty topics/sections are visible for '${slug}'...`);
    const hierarchyWithSyllabus = mergeSyllabusIntoHierarchy(hierarchy, subjectDoc.syllabusJson);

    console.log(`[SubjectController] [previewSubjectBookData] Applying any saved book layout customizations for '${slug}'...`);
    const layoutDocs = await BookLayout.find({ subject: slug }).lean();
    const layoutsByPaper = Object.fromEntries(layoutDocs.map(l => [l.paper, l]));
    const mergedHierarchy = applyBookLayout(hierarchyWithSyllabus, layoutsByPaper);
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
      if (isDownload) {
        // Cloudinary raw assets already default to Content-Disposition: attachment, so a
        // plain redirect forces a download with no proxying — the frontend's own
        // link.download attribute (see downloadFinalPdf in SubjectwiseBookPage.jsx)
        // supplies the friendly filename once the browser saves it, so no URL flag is
        // needed here. (Adding an fl_attachment:<name> flag was tried and rejected: giving
        // the resource a recognized extension trips this Cloudinary account's strict-
        // transformations setting and the delivery starts 401ing outright.)
        console.log(`[SubjectController] [downloadSubjectBook] Redirecting download straight to Cloudinary: ${job.pdfUrl}`);
        return res.redirect(302, job.pdfUrl);
      }
      // Cloudinary's raw resource type always forces Content-Disposition: attachment —
      // there's no flag to make it inline — so previews still have to be proxied here.
      console.log(`[SubjectController] [downloadSubjectBook] Fetching PDF from Cloudinary and proxying inline preview as: ${fileName}`);
      const cloudRes = await fetch(job.pdfUrl);
      if (!cloudRes.ok) throw new Error(`Failed to fetch PDF from storage: ${cloudRes.status}`);
      const cloudBuffer = Buffer.from(await cloudRes.arrayBuffer());
      res.setHeader('Content-Disposition', 'inline');
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

    // Also destroy any Cloudinary-hosted compiled books for this subject, so switching
    // storage backends doesn't quietly leak files (and quota) into Cloudinary.
    const cloudinaryJobs = await SubjectBook.find({ subject: slug, pdfPublicId: { $exists: true, $ne: null } }).select('pdfPublicId').lean();
    const destroyResults = await Promise.allSettled(
      cloudinaryJobs.map(j => cloudinary.uploader.destroy(j.pdfPublicId, { resource_type: 'raw' }))
    );
    const deletedFromCloudinary = destroyResults.filter(r => r.status === 'fulfilled').length;
    const failedCloudinaryDeletes = destroyResults.length - deletedFromCloudinary;
    if (failedCloudinaryDeletes > 0) {
      console.warn(`[SubjectController] [cleanupSubjectBookStorage] ${failedCloudinaryDeletes} Cloudinary delete(s) failed for '${slug}'.`);
    }

    const jobsUpdateResult = await SubjectBook.updateMany(
      { subject: slug },
      { $unset: { pdfFileId: '', pdfUrl: '', pdfPublicId: '', pdfData: '' } }
    );
    console.log(`[SubjectController] [cleanupSubjectBookStorage] Deleted ${filesResult.deletedCount} GridFS file(s), ${chunksResult.deletedCount} chunk(s), ${deletedFromCloudinary}/${cloudinaryJobs.length} Cloudinary file(s). Cleared references on ${jobsUpdateResult.modifiedCount} job(s) for '${slug}'.`);
    res.json({
      message: 'Subject book storage cleaned successfully.',
      deletedFiles: filesResult.deletedCount,
      deletedChunks: chunksResult.deletedCount,
      deletedFromCloudinary,
      jobsUpdated: jobsUpdateResult.modifiedCount
    });
  } catch (err) {
    console.error('[SubjectController] [cleanupSubjectBookStorage] Cleanup error:', err);
    res.status(500).json({ error: 'Failed to clean up subject book storage.', details: err.message });
  }
};

// --- All Uploads Management (subject reassignment + topper name correction) ---

// A subject "has a book made" once it's been through Classify at least once (i.e. has a
// non-empty CSV the book builder reads). Case-insensitive because UPSCQA.subject casing can
// drift from Subject.name casing (see classifySubject's regex query against UPSCQA).
async function findSubjectWithBook(name) {
  if (!name) return null;
  const doc = await Subject.findOne({ name: new RegExp(`^${escapeRegExp(name)}$`, 'i') });
  if (!doc || !doc.csvData || !doc.csvData.trim()) return null;
  return doc;
}

function distinctQuestionCount(rows) {
  return new Set(rows.map(r => r[2]).filter(Boolean)).size;
}

// Removes every row for a question from a subject's book CSV (used when the question itself
// is leaving the subject entirely — reassigned elsewhere, or deleted outright).
async function removeQuestionFromBook(subjectDoc, questionText) {
  const rows = parseCSV(subjectDoc.csvData).slice(1).filter(r => r.length >= 10 && r[2] !== questionText);
  let csvContent = CSV_HEADERS.map(escapeCSV).join(',') + '\n';
  rows.forEach(r => { csvContent += r.map(escapeCSV).join(',') + '\n'; });
  subjectDoc.csvData = csvContent;
  subjectDoc.questionCount = distinctQuestionCount(rows);
  await subjectDoc.save();
}

// Removes just the one row for a (question, specific topper answer sheet) pair — used when a
// question has multiple toppers and only one of them is being removed, so the rest of the
// question's book rows must survive untouched.
async function removeTopperRowFromBook(subjectDoc, questionText, url) {
  const rows = parseCSV(subjectDoc.csvData).slice(1).filter(r => !(r.length >= 10 && r[2] === questionText && r[7] === url));
  let csvContent = CSV_HEADERS.map(escapeCSV).join(',') + '\n';
  rows.forEach(r => { csvContent += r.map(escapeCSV).join(',') + '\n'; });
  subjectDoc.csvData = csvContent;
  subjectDoc.questionCount = distinctQuestionCount(rows);
  await subjectDoc.save();
}

// Appends a question (all its current topper rows) into a subject's book CSV under Paper 1 /
// Unassigned / Unassigned — the same fallback bucket classifySubject uses for unclassifiable
// questions — so a reassigned question is never silently missing, just needs re-sorting in the
// book builder. No-ops (returns false) if the question is already present.
async function addQuestionToBook(subjectDoc, question) {
  const rows = parseCSV(subjectDoc.csvData).slice(1).filter(r => r.length >= 10);
  if (rows.some(r => r[2] === question.question_text)) return false;
  const allTags = `${subjectDoc.name}, Paper 1, Unassigned, Unassigned`;
  if (question.file_urls && question.file_urls.length > 0) {
    question.file_urls.forEach(f => {
      rows.push(['Unassigned', 'Unassigned', question.question_text, f.topper_name || 'Unknown Topper', cleanYear(f.topper_year) || '', f.topper_rank || '', f.topper_marks || '', f.url || '', allTags, 'Paper 1']);
    });
  } else {
    rows.push(['Unassigned', 'Unassigned', question.question_text, '', '', '', '', '', allTags, 'Paper 1']);
  }
  let csvContent = CSV_HEADERS.map(escapeCSV).join(',') + '\n';
  rows.forEach(r => { csvContent += r.map(escapeCSV).join(',') + '\n'; });
  subjectDoc.csvData = csvContent;
  subjectDoc.questionCount = distinctQuestionCount(rows);
  await subjectDoc.save();
  return true;
}

// Syncs renamed topper name(s) into a subject's book CSV for the given answer-sheet URLs of one
// question. Returns whether anything actually changed.
async function syncTopperNamesInBook(subjectDoc, question, urls) {
  const parsed = parseCSV(subjectDoc.csvData);
  const header = parsed[0];
  const rows = parsed.slice(1);
  let changed = false;
  urls.forEach((url) => {
    const entry = (question.file_urls || []).find(f => f.url === url);
    if (!entry) return;
    rows.forEach(r => {
      if (r.length >= 10 && r[2] === question.question_text && r[7] === url) {
        r[3] = entry.topper_name || 'Unknown Topper';
        changed = true;
      }
    });
  });
  if (!changed) return false;
  let csvContent = header.map(escapeCSV).join(',') + '\n';
  rows.forEach(r => { csvContent += r.map(escapeCSV).join(',') + '\n'; });
  subjectDoc.csvData = csvContent;
  await subjectDoc.save();
  return true;
}

// Extracts a Cloudinary public_id (including its folder prefix) from a delivery URL, e.g.
// ".../raw/upload/v1786475336/upsc_answers/Q20_123" -> "upsc_answers/Q20_123".
function extractCloudinaryPublicId(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)$/);
  return match ? match[1] : null;
}

// Resolves an "All Uploads" batch key back to every (question, answer-sheet url) pair it
// covers. A real batch key is the shared uploadBatchId stamped on every question a single PDF
// upload produced; a "legacy:<url>" key is a synthetic one-member batch for answer sheets
// uploaded before that field existed (see UPSCQA.js).
async function resolveBatchMembers(batchKey) {
  const isLegacy = batchKey.startsWith('legacy:');
  const legacyUrl = isLegacy ? batchKey.slice('legacy:'.length) : null;
  const questions = isLegacy
    ? await UPSCQA.find({ 'file_urls.url': legacyUrl })
    : await UPSCQA.find({ 'file_urls.uploadBatchId': batchKey });

  const members = [];
  questions.forEach((question) => {
    (question.file_urls || []).forEach((f) => {
      const matches = isLegacy ? f.url === legacyUrl : f.uploadBatchId === batchKey;
      if (matches) members.push({ question, url: f.url });
    });
  });
  return members;
}

// Lists every upload for the "Display All Uploads" admin view, grouped one row per upload
// action (see resolveBatchMembers for how a "batch" is identified) instead of one row per
// question, so a single PDF upload that produced a dozen questions shows as a single row.
export const listUploadBatches = async (req, res) => {
  console.log('[SubjectController] [listUploadBatches] Request received.');
  try {
    const questions = await UPSCQA.find({}).select('question_text subject file_urls createdAt').lean();

    const batches = new Map();
    questions.forEach((q) => {
      (q.file_urls || []).forEach((f) => {
        const batchKey = f.uploadBatchId || `legacy:${f.url}`;
        const candidateDate = f.uploadedAt || q.createdAt || null;
        if (!batches.has(batchKey)) {
          batches.set(batchKey, { batchKey, uploadedAt: candidateDate, toppers: new Set(), subjects: new Set(), questionIds: new Set(), answerSheetCount: 0 });
        }
        const batch = batches.get(batchKey);
        batch.toppers.add(f.topper_name || 'Unknown Topper');
        batch.subjects.add(q.subject);
        batch.questionIds.add(q._id.toString());
        batch.answerSheetCount++;
        if (candidateDate && (!batch.uploadedAt || new Date(candidateDate) < new Date(batch.uploadedAt))) {
          batch.uploadedAt = candidateDate;
        }
      });
    });

    const result = [...batches.values()]
      .map((b) => ({
        batchKey: b.batchKey,
        uploadedAt: b.uploadedAt,
        toppers: [...b.toppers].sort(),
        subjects: [...b.subjects].sort(),
        subject: b.subjects.size === 1 ? [...b.subjects][0] : null,
        questionCount: b.questionIds.size,
        answerSheetCount: b.answerSheetCount,
      }))
      .sort((a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0));

    console.log(`[SubjectController] [listUploadBatches] Grouped ${questions.length} question(s) into ${result.length} upload batch(es).`);
    res.json(result);
  } catch (err) {
    console.error('[SubjectController] [listUploadBatches] Error:', err);
    res.status(500).json({ error: 'Failed to list uploads.', details: err.message });
  }
};

// Renames topper(s) and/or reassigns the subject for every question one upload batch touched.
// Subject reassignment keeps each affected subject's compiled book (if made) in sync exactly
// like the old single-question edit did — removed from the old subject's book, added to the
// new one's if it has a book too.
export const updateUploadBatch = async (req, res) => {
  const { batchKey } = req.params;
  const { subject: newSubjectRaw, topperRenames } = req.body;
  console.log(`[SubjectController] [updateUploadBatch] Request for batch '${batchKey}'.`);
  try {
    const members = await resolveBatchMembers(batchKey);
    if (members.length === 0) {
      console.warn(`[SubjectController] [updateUploadBatch] Batch not found: '${batchKey}'.`);
      return res.status(404).json({ error: 'Upload batch not found.' });
    }

    if (Array.isArray(topperRenames)) {
      topperRenames.forEach(({ from, to }) => {
        if (typeof from !== 'string' || typeof to !== 'string') return;
        const trimmedTo = to.trim() || 'Unknown Topper';
        members.forEach(({ question, url }) => {
          const entry = (question.file_urls || []).find(f => f.url === url);
          if (entry && entry.topper_name === from) entry.topper_name = trimmedTo;
        });
      });
    }

    let newSubjectMatch = null;
    if (newSubjectRaw !== undefined) {
      const newSubject = String(newSubjectRaw).trim();
      if (!newSubject) return res.status(400).json({ error: 'Subject cannot be empty.' });
      const usedSubjects = await UPSCQA.distinct('subject');
      newSubjectMatch = usedSubjects.find(s => s.toLowerCase() === newSubject.toLowerCase());
      if (!newSubjectMatch) {
        console.warn(`[SubjectController] [updateUploadBatch] Rejected subject '${newSubject}': not an existing subject.`);
        return res.status(400).json({ error: `'${newSubject}' is not an existing subject. Pick one from the dropdown.` });
      }
    }

    const bookChanges = { removedFrom: new Set(), addedTo: new Set(), toppersSynced: false };
    const uniqueQuestions = [...new Map(members.map(m => [m.question._id.toString(), m.question])).values()];

    for (const question of uniqueQuestions) {
      const oldSubject = question.subject;
      const subjectChanged = !!(newSubjectMatch && newSubjectMatch.toLowerCase() !== (oldSubject || '').toLowerCase());
      if (subjectChanged) question.subject = newSubjectMatch;
      await question.save();

      if (subjectChanged) {
        const oldSubjectDoc = await findSubjectWithBook(oldSubject);
        if (oldSubjectDoc) {
          await removeQuestionFromBook(oldSubjectDoc, question.question_text);
          bookChanges.removedFrom.add(oldSubjectDoc.name);
        }
        const newSubjectDoc = await findSubjectWithBook(question.subject);
        if (newSubjectDoc && await addQuestionToBook(newSubjectDoc, question)) {
          bookChanges.addedTo.add(newSubjectDoc.name);
        }
      } else if (Array.isArray(topperRenames) && topperRenames.length > 0) {
        const currentSubjectDoc = await findSubjectWithBook(question.subject);
        if (currentSubjectDoc) {
          const memberUrls = members.filter(m => m.question._id.equals(question._id)).map(m => m.url);
          if (await syncTopperNamesInBook(currentSubjectDoc, question, memberUrls)) {
            bookChanges.toppersSynced = true;
          }
        }
      }
    }

    console.log(`[SubjectController] [updateUploadBatch] Batch '${batchKey}': updated ${uniqueQuestions.length} question(s).`);
    res.json({
      batchKey,
      updatedQuestionCount: uniqueQuestions.length,
      bookChanges: {
        removedFrom: [...bookChanges.removedFrom],
        addedTo: [...bookChanges.addedTo],
        toppersSynced: bookChanges.toppersSynced,
      },
    });
  } catch (err) {
    console.error('[SubjectController] [updateUploadBatch] Error:', err);
    res.status(500).json({ error: 'Failed to update upload batch.', details: err.message });
  }
};

// Deletes an upload batch: removes each affected question's answer-sheet entries for this
// batch (and the underlying Cloudinary file), and keeps any subject book in sync. A question
// that ends up with no answer sheets left at all is deleted outright (and its rows removed from
// its subject's book, if any); a question another topper/upload still answers is kept, with
// just this batch's row(s) dropped from the book.
export const deleteUploadBatch = async (req, res) => {
  const { batchKey } = req.params;
  console.log(`[SubjectController] [deleteUploadBatch] Request for batch '${batchKey}'.`);
  try {
    const members = await resolveBatchMembers(batchKey);
    if (members.length === 0) {
      console.warn(`[SubjectController] [deleteUploadBatch] Batch not found: '${batchKey}'.`);
      return res.status(404).json({ error: 'Upload batch not found.' });
    }

    const uniqueQuestions = [...new Map(members.map(m => [m.question._id.toString(), m.question])).values()];
    const cloudinaryPublicIds = [];
    let deletedQuestions = 0;
    let trimmedQuestions = 0;

    for (const question of uniqueQuestions) {
      const urlsToRemove = new Set(members.filter(m => m.question._id.equals(question._id)).map(m => m.url));
      urlsToRemove.forEach((url) => {
        const publicId = extractCloudinaryPublicId(url);
        if (publicId) cloudinaryPublicIds.push(publicId);
      });

      const remaining = (question.file_urls || []).filter(f => !urlsToRemove.has(f.url));

      if (remaining.length === 0) {
        const subjectDoc = await findSubjectWithBook(question.subject);
        if (subjectDoc) await removeQuestionFromBook(subjectDoc, question.question_text);
        await UPSCQA.deleteOne({ _id: question._id });
        deletedQuestions++;
      } else {
        question.file_urls = remaining;
        await question.save();
        const subjectDoc = await findSubjectWithBook(question.subject);
        if (subjectDoc) {
          for (const url of urlsToRemove) {
            await removeTopperRowFromBook(subjectDoc, question.question_text, url);
          }
        }
        trimmedQuestions++;
      }
    }

    const destroyResults = await Promise.allSettled(
      cloudinaryPublicIds.map(publicId => cloudinary.uploader.destroy(publicId, { resource_type: 'raw' }))
    );
    const deletedFiles = destroyResults.filter(r => r.status === 'fulfilled').length;

    console.log(`[SubjectController] [deleteUploadBatch] Batch '${batchKey}': ${deletedQuestions} question(s) deleted outright, ${trimmedQuestions} trimmed (other toppers remain), ${deletedFiles}/${cloudinaryPublicIds.length} Cloudinary file(s) removed.`);
    res.json({ deletedQuestions, trimmedQuestions, deletedFiles });
  } catch (err) {
    console.error('[SubjectController] [deleteUploadBatch] Error:', err);
    res.status(500).json({ error: 'Failed to delete upload batch.', details: err.message });
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
