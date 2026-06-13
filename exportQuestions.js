import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { UPSCQA } from './models/UPSCQA.js';

// Load environment variables
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const OUTPUT_FILE = path.join(process.cwd(), 'psir_questions_export.csv');

// Helper to escape values for CSV
function escapeCSV(val) {
  if (val === undefined || val === null) return '';
  let str = String(val).trim();
  // Double the double quotes to escape them
  str = str.replace(/"/g, '""');
  // Enclose in double quotes if it contains comma, double quotes, or newlines
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    str = `"${str}"`;
  }
  return str;
}

async function exportPSIRQuestions() {
  try {
    console.log('Connecting to database...');
    await mongoose.connect(MONGO_URI);
    console.log('Successfully connected to MongoDB.');

    // 1. Load syllabus hierarchy
    console.log('Loading syllabus hierarchy...');
    const hierarchyPath = path.join(process.cwd(), 'syllabus_hierarchy.json');
    if (!fs.existsSync(hierarchyPath)) {
      throw new Error(`Syllabus hierarchy file not found at: ${hierarchyPath}`);
    }
    const hierarchy = JSON.parse(fs.readFileSync(hierarchyPath, 'utf8'));
    
    // PSIR subject key in optionalSubjects
    const psirKey = 'OptionalSubjectPoliticalScienceAndInternationalRelations';
    const psirSections = hierarchy.optionalSubjects[psirKey] || [];
    
    const topicMap = new Map();   // lowercase topic -> { topic, section }
    const sectionMap = new Map(); // lowercase section -> section

    psirSections.forEach(secItem => {
      if (secItem.section) {
        const secName = secItem.section;
        sectionMap.set(secName.toLowerCase().trim(), secName);

        if (secItem.topics && Array.isArray(secItem.topics)) {
          secItem.topics.forEach(topicItem => {
            if (topicItem.title) {
              const topicName = topicItem.title;
              topicMap.set(topicName.toLowerCase().trim(), {
                topic: topicName,
                section: secName
              });
            }
          });
        }
      }
    });

    console.log(`Loaded PSIR hierarchy: ${sectionMap.size} sections, ${topicMap.size} topics.`);

    // 2. Fetch questions from DB
    console.log('Fetching questions from database...');
    const allQuestions = await UPSCQA.find({});
    console.log(`Fetched ${allQuestions.length} total questions.`);

    // Filter questions that belong to PSIR
    const psirQuestions = allQuestions.filter(q => {
      return q.tags.some(tag => {
        const normalized = tag.toLowerCase().trim();
        return normalized === psirKey.toLowerCase() || 
               normalized === 'psir' ||
               topicMap.has(normalized) ||
               sectionMap.has(normalized);
      });
    });

    console.log(`Found ${psirQuestions.length} questions belonging to PSIR.`);

    // 3. Classify and flatten questions into rows
    const rows = [];

    for (const q of psirQuestions) {
      let matchedSection = 'Unassigned';
      let matchedTopic = 'Unassigned';

      // Identify Section and Topic based on tags
      // Priority 1: Match against known Topics
      for (const tag of q.tags) {
        const key = tag.toLowerCase().trim();
        if (topicMap.has(key)) {
          const mapped = topicMap.get(key);
          matchedTopic = mapped.topic;
          matchedSection = mapped.section;
          break;
        }
      }

      // Priority 2: Match against known Sections if no topic matched
      if (matchedSection === 'Unassigned' && matchedTopic === 'Unassigned') {
        for (const tag of q.tags) {
          const key = tag.toLowerCase().trim();
          if (sectionMap.has(key)) {
            matchedSection = sectionMap.get(key);
            matchedTopic = 'N/A';
            break;
          }
        }
      }

      const allTagsStr = q.tags.join(', ');

      // Flatten topper details
      if (q.file_urls && q.file_urls.length > 0) {
        q.file_urls.forEach(f => {
          rows.push({
            section: matchedSection,
            topic: matchedTopic,
            question: q.question_text,
            topperName: f.topper_name || 'Unknown',
            topperYear: f.topper_year || '',
            topperRank: f.topper_rank || '',
            topperMarks: f.topper_marks || '',
            topperUrl: f.url || '',
            tags: allTagsStr
          });
        });
      } else {
        // No topper answer sheets uploaded yet
        rows.push({
          section: matchedSection,
          topic: matchedTopic,
          question: q.question_text,
          topperName: '',
          topperYear: '',
          topperRank: '',
          topperMarks: '',
          topperUrl: '',
          tags: allTagsStr
        });
      }
    }

    // 4. Sort rows by Section, then Topic, then Question Text
    rows.sort((a, b) => {
      // Sort Section
      if (a.section !== b.section) {
        if (a.section === 'N/A' || a.section === 'Unassigned') return 1;
        if (b.section === 'N/A' || b.section === 'Unassigned') return -1;
        return a.section.localeCompare(b.section);
      }
      // Sort Topic
      if (a.topic !== b.topic) {
        if (a.topic === 'N/A' || a.topic === 'Unassigned') return 1;
        if (b.topic === 'N/A' || b.topic === 'Unassigned') return -1;
        return a.topic.localeCompare(b.topic);
      }
      // Sort Question
      return a.question.localeCompare(b.question);
    });

    // 5. Build CSV Content
    const headers = [
      'Section',
      'Topic',
      'Question',
      'Topper Name',
      'Topper Year',
      'Topper Rank',
      'Topper Marks',
      'Topper Answer Sheet URL',
      'All Tags'
    ];

    let csvContent = headers.map(escapeCSV).join(',') + '\n';

    rows.forEach(r => {
      const line = [
        r.section,
        r.topic,
        r.question,
        r.topperName,
        r.topperYear,
        r.topperRank,
        r.topperMarks,
        r.topperUrl,
        r.tags
      ];
      csvContent += line.map(escapeCSV).join(',') + '\n';
    });

    // Write to file
    fs.writeFileSync(OUTPUT_FILE, csvContent, 'utf8');
    console.log(`\nSuccess! Exported ${rows.length} rows (including individual topper sheets) to:`);
    console.log(OUTPUT_FILE);

  } catch (error) {
    console.error('Error exporting PSIR questions:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Database connection closed.');
  }
}

exportPSIRQuestions();
