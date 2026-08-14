// One-time (re-runnable) data-cleanup script: strips Hindi text from questions that were
// already uploaded before the extraction pipeline was fixed to ignore it going forward.
//
// Touches three things, and ONLY the question-text-related fields on each:
//   1. UPSCQA.question_text            — the canonical uploaded text.
//   2. Subject.csvData                 — the classified snapshot that subjectwise book
//                                         builders read from ("already made subjectwise books").
//   3. BookLayout (subject: <slug>)    — per-paper customizations (question order, exclusions,
//                                         topper selections, text overrides) are keyed by an id
//                                         derived from the question's text. Cleaning the text
//                                         changes that derived id, so this remaps every
//                                         reference from the old id to the new one in the same
//                                         pass, so no existing customization gets silently
//                                         reset.
//
// Never deletes a question, never touches `subject`, `file_urls`, `tags`, or any other field.
// A row/question whose cleaned result doesn't look like a real English question (see
// looksLikeEnglishQuestion) is left completely untouched and reported for manual review
// instead of risking data loss.
//
// Usage:
//   node scripts/cleanHindiFromExistingData.js                 (dry run — no writes)
//   node scripts/cleanHindiFromExistingData.js --apply          (writes + backup file)
//   node scripts/cleanHindiFromExistingData.js --apply --backup=/path/to/backup.json

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { UPSCQA } from '../models/UPSCQA.js';
import { Subject } from '../models/Subject.js';
import { BookLayout } from '../models/BookLayout.js';
import { parseCSV, escapeCSV } from '../utils/csv.js';
import { stripHindiText, looksLikeEnglishQuestion, containsHindi } from '../utils/hindiText.js';

dotenv.config();

const CSV_HEADERS = [
  'Section', 'Topic', 'Question', 'Topper Name', 'Topper Year',
  'Topper Rank', 'Topper Marks', 'Topper Answer Sheet URL', 'All Tags', 'Paper'
];

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const backupArg = args.find(a => a.startsWith('--backup='));
const backupPath = backupArg
  ? backupArg.split('=')[1]
  : path.join(process.cwd(), `hindi_cleanup_backup_${Date.now()}.json`);

function computeId(paper, section, topic, questionText) {
  return Buffer.from(`${paper}||${section}||${topic}||${questionText}`).toString('base64');
}

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI missing from environment.');
    process.exit(1);
  }
  console.log(`[Cleanup] Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(process.env.MONGO_URI);
  console.log('[Cleanup] Connected to MongoDB.');

  const backup = { upscqa: [], subjects: [], bookLayouts: [] };
  const reviewNeeded = [];

  // ---------- Phase 1: UPSCQA.question_text ----------
  console.log('\n=== Phase 1: UPSCQA.question_text ===');
  const allQuestions = await UPSCQA.find({}).select('_id question_text subject').lean();
  const hindiQuestions = allQuestions.filter(q => containsHindi(q.question_text));
  console.log(`[Cleanup] ${allQuestions.length} total questions, ${hindiQuestions.length} contain Hindi.`);

  const upscqaOps = [];
  let upscqaSkipped = 0;
  for (const q of hindiQuestions) {
    const cleaned = stripHindiText(q.question_text);
    // stripHindiText returns the input completely unchanged when it can't confidently tell
    // which side of the text is Hindi (ambiguous layout) — every item in this loop is known
    // to contain Hindi, so an unchanged result here always means "needs manual review", not
    // "nothing to do".
    if (cleaned === q.question_text || !looksLikeEnglishQuestion(cleaned)) {
      upscqaSkipped++;
      reviewNeeded.push({ collection: 'UPSCQA', id: q._id.toString(), subject: q.subject, original: q.question_text, attemptedClean: cleaned === q.question_text ? '(unchanged — ambiguous layout)' : cleaned });
      continue;
    }
    backup.upscqa.push({ _id: q._id.toString(), question_text: q.question_text });
    upscqaOps.push({
      updateOne: { filter: { _id: q._id }, update: { $set: { question_text: cleaned } } }
    });
  }
  console.log(`[Cleanup] UPSCQA: ${upscqaOps.length} to update, ${upscqaSkipped} skipped (need manual review).`);
  console.log('[Cleanup] Sample changes:');
  upscqaOps.slice(0, 5).forEach(op => {
    const before = backup.upscqa.find(b => b._id === op.updateOne.filter._id.toString());
    console.log(`  BEFORE: ${JSON.stringify(before.question_text)}`);
    console.log(`  AFTER:  ${JSON.stringify(op.updateOne.update.$set.question_text)}\n`);
  });

  if (APPLY && upscqaOps.length > 0) {
    const result = await UPSCQA.bulkWrite(upscqaOps);
    console.log(`[Cleanup] UPSCQA bulkWrite done. Modified: ${result.modifiedCount}`);
  }

  // ---------- Phase 2 & 3: Subject.csvData + BookLayout remap ----------
  console.log('\n=== Phase 2: Subject.csvData ===');
  const subjects = await Subject.find({ csvData: { $ne: '' } });
  console.log(`[Cleanup] ${subjects.length} subject(s) have classified CSV data.`);

  let subjectsChanged = 0;
  let totalRowsChanged = 0;
  let totalIdsRemapped = 0;
  let bookLayoutsChanged = 0;

  for (const subjectDoc of subjects) {
    const parsed = parseCSV(subjectDoc.csvData);
    const header = parsed[0];
    const rows = parsed.slice(1).filter(r => r.length >= 10);

    // paper -> Map<oldId, newId>
    const idMapByPaper = new Map();
    let rowsChangedForThisSubject = 0;
    let rowSkipped = 0;

    rows.forEach(r => {
      const [section, topic, questionText, , , , , , , paper] = r;
      if (!containsHindi(questionText)) return;
      const cleaned = stripHindiText(questionText);
      if (cleaned === questionText || !looksLikeEnglishQuestion(cleaned)) {
        rowSkipped++;
        reviewNeeded.push({ collection: 'Subject.csvData', subjectSlug: subjectDoc.slug, paper, section, topic, original: questionText, attemptedClean: cleaned === questionText ? '(unchanged — ambiguous layout)' : cleaned });
        return;
      }
      const oldId = computeId(paper, section, topic, questionText);
      const newId = computeId(paper, section, topic, cleaned);
      r[2] = cleaned;
      rowsChangedForThisSubject++;
      if (oldId !== newId) {
        if (!idMapByPaper.has(paper)) idMapByPaper.set(paper, new Map());
        idMapByPaper.get(paper).set(oldId, newId);
      }
    });

    if (rowsChangedForThisSubject === 0) continue;

    subjectsChanged++;
    totalRowsChanged += rowsChangedForThisSubject;
    const distinctQuestionCount = new Set(rows.map(r => r[2]).filter(Boolean)).size;

    console.log(`\n[Cleanup] Subject '${subjectDoc.slug}': ${rowsChangedForThisSubject} row(s) changed across ${idMapByPaper.size} paper(s), ${rowSkipped} skipped for review. New questionCount: ${distinctQuestionCount} (was ${subjectDoc.questionCount}).`);

    backup.subjects.push({ _id: subjectDoc._id.toString(), slug: subjectDoc.slug, csvData: subjectDoc.csvData, questionCount: subjectDoc.questionCount });

    let newCsvContent = header.map(escapeCSV).join(',') + '\n';
    rows.forEach(r => { newCsvContent += r.map(escapeCSV).join(',') + '\n'; });

    if (APPLY) {
      subjectDoc.csvData = newCsvContent;
      subjectDoc.questionCount = distinctQuestionCount;
      await subjectDoc.save();
    }

    // Phase 3: remap BookLayout docs for this subject's affected papers.
    for (const [paper, idMap] of idMapByPaper.entries()) {
      totalIdsRemapped += idMap.size;
      const layout = await BookLayout.findOne({ subject: subjectDoc.slug, paper });
      if (!layout) continue;

      // Snapshot the original values up front (deep-cloned) — every remap below reads only
      // from this snapshot and writes only into fresh local variables, so nothing here is
      // mutated in place, and the backup always reflects true pre-migration state.
      const original = {
        questionOrder: JSON.parse(JSON.stringify(layout.questionOrder || {})),
        excludedQuestionIds: [...(layout.excludedQuestionIds || [])],
        selections: JSON.parse(JSON.stringify(layout.selections || {})),
        questionTextOverrides: JSON.parse(JSON.stringify(layout.questionTextOverrides || {})),
      };

      let layoutChanged = false;
      const remapId = (id) => (idMap.has(id) ? idMap.get(id) : id);

      // questionOrder: { topicKey: [ids] }
      const newQuestionOrder = {};
      for (const [topicKey, arr] of Object.entries(original.questionOrder)) {
        if (!Array.isArray(arr)) { newQuestionOrder[topicKey] = arr; continue; }
        const remapped = arr.map(remapId);
        newQuestionOrder[topicKey] = remapped;
        if (remapped.some((id, i) => id !== arr[i])) layoutChanged = true;
      }

      // excludedQuestionIds: [ids]
      const newExcluded = original.excludedQuestionIds.map(remapId);
      if (newExcluded.some((id, i) => id !== original.excludedQuestionIds[i])) layoutChanged = true;

      // selections: { id: [urls] }
      const newSelections = {};
      for (const [id, val] of Object.entries(original.selections)) {
        const newId = remapId(id);
        if (newId !== id) layoutChanged = true;
        newSelections[newId] = val;
      }

      // questionTextOverrides: { id: text } — remap key AND clean the override text itself.
      const newOverrides = {};
      for (const [id, val] of Object.entries(original.questionTextOverrides)) {
        const newId = remapId(id);
        let newVal = val;
        if (containsHindi(val)) {
          const cleanedVal = stripHindiText(val);
          if (looksLikeEnglishQuestion(cleanedVal)) newVal = cleanedVal;
        }
        if (newId !== id || newVal !== val) layoutChanged = true;
        newOverrides[newId] = newVal;
      }

      if (layoutChanged) {
        bookLayoutsChanged++;
        backup.bookLayouts.push({ _id: layout._id.toString(), subject: layout.subject, paper: layout.paper, ...original });
        console.log(`  -> BookLayout '${subjectDoc.slug}'/'${paper}' remapped (${idMap.size} id(s)).`);
        if (APPLY) {
          layout.questionOrder = newQuestionOrder;
          layout.excludedQuestionIds = newExcluded;
          layout.selections = newSelections;
          layout.questionTextOverrides = newOverrides;
          layout.markModified('questionOrder');
          layout.markModified('selections');
          layout.markModified('questionTextOverrides');
          await layout.save();
        }
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`UPSCQA questions updated: ${upscqaOps.length} (skipped for review: ${upscqaSkipped})`);
  console.log(`Subjects with csvData updated: ${subjectsChanged} (total rows changed: ${totalRowsChanged})`);
  console.log(`Question ids remapped: ${totalIdsRemapped}`);
  console.log(`BookLayout docs remapped: ${bookLayoutsChanged}`);
  console.log(`Records needing manual review (left untouched): ${reviewNeeded.length}`);

  if (reviewNeeded.length > 0) {
    console.log('\n--- NEEDS MANUAL REVIEW (left unchanged) ---');
    reviewNeeded.forEach(r => console.log(JSON.stringify(r)));
  }

  if (APPLY) {
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`\n[Cleanup] Backup of original values written to: ${backupPath}`);
  } else {
    console.log('\n[Cleanup] Dry run only — no writes performed. Re-run with --apply to commit these changes.');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[Cleanup] Fatal error:', err);
  process.exit(1);
});
